const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { findBrowser, launchBrowser } = require("./social-browser.cjs");

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
function cleanLabel(value, platformKey, count) {
  const label = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
  return label || `${platformOf(platformKey).name}账号${count + 1}`;
}

function createSocialAccounts({ dataDir, launch = launchBrowser, executable = findBrowser(), onChange = () => {}, pollMs = 2000 }) {
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
  const open = new Map(), reading = new Map();
  let disposed = false;
  const save = () => writeJsonAtomic(stateFile, state);
  const profileOf = (account) => path.join(dataDir, "profiles", account.id);
  const snapshot = () => ({ platforms: Object.entries(PLATFORMS).map(([key, item]) => ({ key, name: item.name })),
    browserReady: Boolean(executable), accounts: state.accounts.map((account) => ({ ...account, loggingIn: open.has(account.id) })) });
  const emit = () => { if (!disposed) onChange(snapshot()); };
  const find = (id) => {
    const account = ACCOUNT_ID.test(String(id || "")) && state.accounts.find((item) => item.id === id);
    if (!account) throw fail("SOCIAL_ACCOUNT_NOT_FOUND", "没有找到这个账号，请刷新后重试。");
    return account;
  };
  // Cookies come from the open login window, or from a short headless start of
  // the same profile. Only the browser target is used; no page is attached.
  async function cookiesOf(account) {
    const running = open.get(account.id);
    if (running) return (await running.send("Storage.getCookies")).cookies || [];
    if (reading.has(account.id)) return reading.get(account.id);
    const task = (async () => {
      const browser = launch({ executable, profileDir: profileOf(account), headless: true });
      try { return (await browser.send("Storage.getCookies")).cookies || []; } finally { await browser.close(); }
    })();
    reading.set(account.id, task);
    try { return await task; } finally { reading.delete(account.id); }
  }
  function apply(account, cookies) {
    const active = loggedIn(account.platform, cookies);
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
    if (reading.has(id)) await reading.get(id).catch(() => {});
    const browser = launch({ executable, profileDir: profileOf(account), url: PLATFORMS[account.platform].home });
    open.set(id, browser);
    let closing = false;
    const timer = setInterval(() => {
      if (closing || browser.isClosed()) return;
      void browser.send("Storage.getCookies").then(({ cookies = [] }) => {
        if (closing || !loggedIn(account.platform, cookies)) return;
        closing = true; account.lastLoginAt = stamp(); apply(account, cookies); save(); emit();
        setTimeout(() => void browser.close(), 1500);
      }).catch(() => {});
    }, pollMs);
    timer.unref?.();
    void browser.closed.then(async () => {
      clearInterval(timer);
      if (open.get(id) === browser) open.delete(id);
      if (disposed || !state.accounts.includes(account)) return;
      if (!closing) { try { apply(account, await cookiesOf(account)); } catch { /* Keep the last known status. */ } }
      save(); emit();
    });
    emit();
    return snapshot();
  }
  async function refresh() {
    for (const account of state.accounts) { try { apply(account, await cookiesOf(account)); } catch { /* Keep the last known status. */ } }
    save(); emit(); return snapshot();
  }
  // Deleting removes the account's whole browser profile, which signs it out here.
  async function remove(id) {
    const account = find(id);
    const running = open.get(id);
    if (running) { await running.close(); open.delete(id); }
    if (reading.has(id)) await reading.get(id).catch(() => {});
    for (let attempt = 0; ; attempt++) {
      try { fs.rmSync(profileOf(account), { recursive: true, force: true }); break; }
      catch (error) { if (attempt >= 5) throw fail("SOCIAL_PROFILE_BUSY", "浏览器还没完全关闭，请稍后再删除。"); await new Promise((resolve) => setTimeout(resolve, 500)); }
    }
    state.accounts = state.accounts.filter((item) => item.id !== id);
    save(); emit(); return snapshot();
  }
  function profileDir(id) { return profileOf(find(id)); }
  async function dispose() { disposed = true; await Promise.all([...open.values()].map((browser) => browser.close())); open.clear(); }
  return { snapshot, add, rename, login, refresh, remove, profileDir, dispose };
}

module.exports = { createSocialAccounts, PLATFORMS, loggedIn };
