const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { findBrowser, launchBrowser } = require("./social-browser.cjs");
const { attachPage, sleep } = require("./social-page.cjs");
const drivers = require("./social-publish-drivers.cjs");

const fail = (code, message) => Object.assign(new Error(message), { code });
const stamp = () => new Date().toISOString();

// Each account is its own Chrome profile under social_accounts/profiles/<id>.
// This module never reads cookie values, only whether an unexpired login cookie
// of the platform exists. The cookie names were taken from the platforms'
// creator sites; guest visits to all four were checked not to set them.
const PLATFORMS = {
  douyin: { name: "抖音", home: "https://creator.douyin.com/", hosts: ["douyin.com"], loginCookies: ["sessionid", "sessionid_ss"] },
  kuaishou: { name: "快手", home: "https://cp.kuaishou.com/", hosts: ["kuaishou.com"], loginCookies: ["kuaishou.web.cp.api_st", "kuaishou.server.web_st", "userId"] },
  channels: { name: "视频号", home: "https://channels.weixin.qq.com/platform", hosts: ["channels.weixin.qq.com"], loginCookies: ["sessionid"] },
  xiaohongshu: { name: "小红书", home: "https://creator.xiaohongshu.com/", hosts: ["xiaohongshu.com"], loginCookies: ["access-token-creator.xiaohongshu.com", "galaxy_creator_session_id"] }
};
const ACCOUNT_ID = /^[0-9a-f-]{36}$/;

function platformOf(value) {
  const platform = PLATFORMS[value];
  if (!platform) throw fail("SOCIAL_PLATFORM_INVALID", "请选择抖音、快手、视频号或小红书。");
  return platform;
}
// True when an unexpired login cookie of this platform exists. Values are never kept.
function loggedIn(platformKey, cookies, now = Date.now()) {
  const { hosts, loginCookies } = platformOf(platformKey);
  return cookies.some((cookie) => loginCookies.includes(cookie.name) && String(cookie.value || "").length > 0
    && hosts.some((host) => { const domain = String(cookie.domain || "").replace(/^\./, ""); return domain === host || domain.endsWith(`.${host}`); })
    && (!(cookie.expires > 0) || cookie.expires * 1000 > now));
}
// The platform's own answer for a profile whose cookie looks signed in: its publish page
// sends a signed-out account to the login page (or, on 快手, shows 立即登录). Checked in
// the same hidden window that read the cookies; an unclear page leaves the cookie verdict.
async function platformSignedOut(browser, platformKey) {
  const driver = drivers.driverFor(platformKey);
  const page = await attachPage(browser, driver.host, { timeoutMs: 20_000, open: driver.uploadUrl });
  await sleep(3000);
  return drivers.signedOut(page, driver);
}
function cleanLabel(value, platformKey, count) {
  const label = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
  return label || `${platformOf(platformKey).name}账号${count + 1}`;
}

function createSocialAccounts({ dataDir, launch = launchBrowser, executable = findBrowser(), onChange = () => {}, pollMs = 2000, probe = platformSignedOut }) {
  const stateFile = path.join(dataDir, "state.json");
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (state?.version !== 1 || !Array.isArray(state.accounts)) throw new Error("invalid state");
  } catch (error) {
    if (error.code !== "ENOENT") throw fail("SOCIAL_STATE_INVALID", "平台账号记录无法读取，原文件已保留，请通过吐槽中心联系处理。");
    state = { version: 1, accounts: [] };
    fs.mkdirSync(dataDir, { recursive: true });
    writeJsonAtomic(stateFile, state);
  }
  const open = new Map(), reading = new Map(), leased = new Set(), removing = new Set();
  let disposed = false;
  const save = () => writeJsonAtomic(stateFile, state);
  const profileOf = (account) => path.join(dataDir, "profiles", account.id);
  const snapshot = () => ({ platforms: Object.entries(PLATFORMS).map(([key, item]) => ({ key, name: item.name })),
    browserReady: Boolean(executable), accounts: state.accounts.map((account) => ({ ...account, loggingIn: open.has(account.id), publishing: leased.has(account.id) })) });
  const emit = () => { if (!disposed) onChange(snapshot()); };
  const find = (id) => {
    const account = ACCOUNT_ID.test(String(id || "")) && state.accounts.find((item) => item.id === id);
    if (!account) throw fail("SOCIAL_ACCOUNT_NOT_FOUND", "没有找到这个账号，请刷新后重试。");
    return account;
  };
  // Cookies come from the open login window, or from a short headless start of
  // the same profile. With `verify`, a cookie that looks signed in is checked on the
  // platform's own page in that headless window.
  async function cookiesOf(account, { verify = false } = {}) {
    const running = open.get(account.id);
    if (running) return { cookies: (await running.send("Storage.getCookies")).cookies || [], signedOut: false };
    if (reading.has(account.id)) return reading.get(account.id);
    const task = (async () => {
      const browser = launch({ executable, profileDir: profileOf(account), headless: true });
      try {
        const cookies = (await browser.send("Storage.getCookies")).cookies || [];
        let signedOut = false;
        if (verify && loggedIn(account.platform, cookies)) { try { signedOut = await probe(browser, account.platform); } catch { /* Unclear: the cookie verdict stands. */ } }
        return { cookies, signedOut };
      } finally { await browser.close(); }
    })();
    reading.set(account.id, task);
    try { return await task; } finally { reading.delete(account.id); }
  }
  function apply(account, cookies) {
    // A cookie can outlive the session: once the platform itself asked for a
    // new login, only a login made after that counts (2026-10-29: three 视频号
    // accounts showed "logged in" while every publish window showed the QR code).
    const signedOutByPlatform = account.platformSignedOutAt && !(account.lastLoginAt > account.platformSignedOutAt);
    const active = loggedIn(account.platform, cookies) && !signedOutByPlatform;
    account.status = active ? "active" : account.lastLoginAt ? "expired" : "login_required";
    if (active && !account.lastLoginAt) account.lastLoginAt = stamp();
    account.checkedAt = stamp();
    return active;
  }

  function add({ platform, label } = {}) {
    platformOf(platform);
    const count = state.accounts.filter((item) => item.platform === platform).length;
    if (count >= 20) throw fail("SOCIAL_ACCOUNT_LIMIT", "每个平台最多添加 20 个账号。");
    const account = { id: crypto.randomUUID(), platform, label: cleanLabel(label, platform, count), status: "login_required", createdAt: stamp(), lastLoginAt: "", checkedAt: "" };
    state.accounts.push(account); save(); emit();
    return login(account.id);
  }
  function rename(id, label) {
    const account = find(id);
    account.label = cleanLabel(label, account.platform, state.accounts.filter((item) => item.platform === account.platform).indexOf(account));
    save(); emit(); return snapshot();
  }
  // Opens the platform's own creator site in a visible window of this account's
  // profile. The window closes itself shortly after the login cookie appears.
  async function login(id) {
    const account = find(id);
    if (open.has(id)) return snapshot();
    if (leased.has(id) || removing.has(id)) throw fail("SOCIAL_ACCOUNT_BUSY", "这个账号正在发布或删除，请稍后再打开登录窗口。");
    if (reading.has(id)) await reading.get(id).catch(() => {});
    // Re-check after waiting: a publish may have taken the profile meanwhile.
    if (open.has(id)) return snapshot();
    if (leased.has(id) || removing.has(id)) throw fail("SOCIAL_ACCOUNT_BUSY", "这个账号正在发布或删除，请稍后再打开登录窗口。");
    const browser = launch({ executable, profileDir: profileOf(account), url: PLATFORMS[account.platform].home });
    open.set(id, browser);
    let closing = false;
    // Login cookies already in the profile may belong to a session the platform
    // ended. Only a cookie that changes while this window is open is a new login;
    // the comparison stays in memory and no value is kept.
    const fingerprint = (cookies) => new Set(cookies.filter((cookie) => PLATFORMS[account.platform].loginCookies.includes(cookie.name))
      .map((cookie) => crypto.createHash("sha256").update(`${cookie.name}=${cookie.value}`).digest("hex")));
    // Taken as the window opens, before the user can scan anything.
    const before = fingerprint((await browser.send("Storage.getCookies").catch(() => ({})))?.cookies || []);
    const timer = setInterval(() => {
      if (closing || browser.isClosed()) return;
      void browser.send("Storage.getCookies").then(({ cookies = [] }) => {
        const renewed = [...fingerprint(cookies)].some((value) => !before.has(value));
        if (closing || !loggedIn(account.platform, cookies) || !renewed) return;
        closing = true; account.lastLoginAt = stamp(); apply(account, cookies); save(); emit();
        setTimeout(() => void browser.close(), 1500);
      }).catch(() => {});
    }, pollMs);
    timer.unref?.();
    void browser.closed.then(async () => {
      clearInterval(timer);
      if (open.get(id) === browser) open.delete(id);
      if (disposed || !state.accounts.includes(account)) return;
      if (!closing) { try { apply(account, (await cookiesOf(account)).cookies); } catch { /* Keep the last known status. */ } }
      save(); emit();
    });
    emit();
    return snapshot();
  }
  async function refresh() {
    for (const account of state.accounts) {
      if (leased.has(account.id)) continue;
      try {
        const { cookies, signedOut } = await cookiesOf(account, { verify: true });
        if (signedOut) account.platformSignedOutAt = stamp();
        apply(account, cookies);
      } catch { /* Keep the last known status. */ }
    }
    save(); emit(); return snapshot();
  }
  // Deleting removes the account's whole browser profile, which signs it out here.
  async function remove(id) {
    const account = find(id);
    if (leased.has(id) || removing.has(id)) throw fail("SOCIAL_ACCOUNT_BUSY", "这个账号正在发布，发布结束后再删除。");
    // Mark synchronously so no publish or login can take the profile while it is being deleted.
    removing.add(id);
    try {
      const running = open.get(id);
      if (running) { await running.close(); open.delete(id); }
      if (reading.has(id)) await reading.get(id).catch(() => {});
      for (let attempt = 0; ; attempt++) {
        try { fs.rmSync(profileOf(account), { recursive: true, force: true }); break; }
        catch { if (attempt >= 5) throw fail("SOCIAL_PROFILE_BUSY", "浏览器还没完全关闭，请稍后再删除。"); await new Promise((resolve) => setTimeout(resolve, 500)); }
      }
      state.accounts = state.accounts.filter((item) => item.id !== id);
      save(); emit(); return snapshot();
    } finally { removing.delete(id); }
  }
  function profileDir(id) { return profileOf(find(id)); }
  // The platform redirected a publish to its login page: the account needs a new login.
  function markSignedOut(id) {
    const account = find(id);
    account.platformSignedOutAt = stamp();
    account.status = account.lastLoginAt ? "expired" : "login_required";
    save(); emit(); return snapshot();
  }
  // An upload on this account stopped moving. Only a warning: the account stays selectable,
  // and its next published post clears the mark (user decision 2026-10-29).
  function markUploadTrouble(id) { const account = find(id); account.uploadTroubleAt = stamp(); save(); emit(); return snapshot(); }
  function clearUploadTrouble(id) { const account = find(id); if (!account.uploadTroubleAt) return snapshot(); delete account.uploadTroubleAt; save(); emit(); return snapshot(); }
  // One browser per profile: publishing takes the account exclusively until released.
  function lease(id) {
    find(id);
    if (open.has(id) || reading.has(id) || leased.has(id) || removing.has(id)) throw fail("SOCIAL_ACCOUNT_BUSY", "这个账号的浏览器正在使用（登录或发布中），请稍后再试。");
    leased.add(id); emit();
    let released = false;
    return () => { if (!released) { released = true; leased.delete(id); emit(); } };
  }
  async function dispose() { disposed = true; await Promise.all([...open.values()].map((browser) => browser.close())); open.clear(); }
  return { snapshot, add, rename, login, refresh, remove, profileDir, lease, markSignedOut, markUploadTrouble, clearUploadTrouble, dispose };
}

module.exports = { createSocialAccounts, PLATFORMS, loggedIn };
