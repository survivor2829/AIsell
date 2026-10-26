const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-file.cjs");

const fail = (code, message) => Object.assign(new Error(message), { code });
const stamp = () => new Date().toISOString();

// Platform login pages. Each account lives in its own persistent Electron
// partition; this module never reads cookie values, only whether a login cookie
// with an unexpired date exists. The cookie names were taken from the
// platforms' creator sites and are re-confirmed during real-account acceptance.
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
function allowedUrl(platformKey, value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && platformOf(platformKey).hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}
// True when an unexpired login cookie of this platform exists. Values are never read.
function loggedIn(platformKey, cookies, now = Date.now()) {
  const { hosts, loginCookies } = platformOf(platformKey);
  return cookies.some((cookie) => loginCookies.includes(cookie.name) && String(cookie.value || "").length > 0
    && hosts.some((host) => { const domain = String(cookie.domain || "").replace(/^\./, ""); return domain === host || domain.endsWith(`.${host}`); })
    && (!cookie.expirationDate || cookie.expirationDate * 1000 > now));
}
// Electron's default agent names the app and Electron, which Douyin's login
// rejects ("二维码失效/系统繁忙"). Keep only the standard Chrome tokens.
function browserUserAgent(value) {
  return String(value || "").replace(/ (?!(?:Chrome|Safari|AppleWebKit)\/)[^\s/()]+\/\S+/g, "");
}
function cleanLabel(value, platformKey, count) {
  const label = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
  return label || `${platformOf(platformKey).name}账号${count + 1}`;
}

function createSocialAccounts({ dataDir, BrowserWindow, session, onChange = () => {}, pollMs = 2000 }) {
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
  const logins = new Map();
  let disposed = false;
  const save = () => writeJsonAtomic(stateFile, state);
  const snapshot = () => ({ platforms: Object.entries(PLATFORMS).map(([key, item]) => ({ key, name: item.name })),
    accounts: state.accounts.map((account) => ({ ...account, partition: undefined, loggingIn: logins.has(account.id) })) });
  const emit = () => { if (!disposed) onChange(snapshot()); };
  const find = (id) => {
    const account = ACCOUNT_ID.test(String(id || "")) && state.accounts.find((item) => item.id === id);
    if (!account) throw fail("SOCIAL_ACCOUNT_NOT_FOUND", "没有找到这个账号，请刷新后重试。");
    return account;
  };
  const sessionOf = (account) => {
    if (!session) throw fail("SOCIAL_BROWSER_UNAVAILABLE", "当前环境没有可用的平台窗口，请重新打开软件。");
    const ses = session.fromPartition(account.partition);
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    if (ses.getUserAgent) ses.setUserAgent(browserUserAgent(ses.getUserAgent()));
    return ses;
  };
  async function check(account) {
    const active = loggedIn(account.platform, await sessionOf(account).cookies.get({}));
    const status = active ? "active" : account.lastLoginAt ? "expired" : "login_required";
    if (status !== account.status) { account.status = status; if (active) account.lastLoginAt = account.lastLoginAt || stamp(); }
    account.checkedAt = stamp();
    return account;
  }

  function add({ platform, label } = {}) {
    platformOf(platform);
    const count = state.accounts.filter((item) => item.platform === platform).length;
    if (count >= 20) throw fail("SOCIAL_ACCOUNT_LIMIT", "每个平台最多添加 20 个账号。");
    const id = crypto.randomUUID();
    const account = { id, platform, label: cleanLabel(label, platform, count), partition: `persist:social-${platform}-${id}`, status: "login_required", createdAt: stamp(), lastLoginAt: "", checkedAt: "" };
    state.accounts.push(account); save(); emit();
    return login(id);
  }
  function rename(id, label) {
    const account = find(id);
    account.label = cleanLabel(label, account.platform, state.accounts.filter((item) => item.platform === account.platform).indexOf(account));
    save(); emit(); return snapshot();
  }
  // Opens the platform's own login page in this account's partition. The page
  // gets no preload, Node or IPC. Detection only polls cookie presence; the
  // window closes itself shortly after the login is seen.
  async function login(id) {
    const account = find(id);
    const existing = logins.get(id);
    if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return snapshot(); }
    if (!BrowserWindow) throw fail("SOCIAL_BROWSER_UNAVAILABLE", "当前环境没有可用的平台窗口，请重新打开软件。");
    const ses = sessionOf(account);
    if (!ses.__xiaoxiNoDownload) { ses.__xiaoxiNoDownload = true; ses.on("will-download", (event) => event.preventDefault()); }
    const platform = PLATFORMS[account.platform];
    const win = new BrowserWindow({ width: 1180, height: 820, minWidth: 900, minHeight: 650, title: `${platform.name} · ${account.label} · 扫码登录`, autoHideMenuBar: true,
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    win.setMenu?.(null);
    const wc = win.webContents;
    for (const eventName of ["will-navigate", "will-redirect"]) wc.on(eventName, (event, url) => { if (!allowedUrl(account.platform, url)) event.preventDefault(); });
    wc.on("will-attach-webview", (event) => event.preventDefault());
    wc.setWindowOpenHandler(({ url }) => { if (allowedUrl(account.platform, url)) void win.loadURL(url).catch(() => {}); return { action: "deny" }; });
    logins.set(id, win);
    let timer, closing;
    const finish = () => { clearInterval(timer); clearTimeout(closing); if (logins.get(id) === win) logins.delete(id); };
    win.on("closed", () => { finish(); void check(account).then(() => { save(); emit(); }).catch(() => emit()); });
    timer = setInterval(() => {
      if (win.isDestroyed() || closing) return;
      void check(account).then((current) => {
        if (current.status !== "active" || win.isDestroyed()) return;
        current.lastLoginAt = stamp(); save(); emit();
        closing = setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 1500);
      }).catch(() => {});
    }, pollMs);
    timer.unref?.();
    emit();
    void win.loadURL(platform.home).catch(() => {});
    return snapshot();
  }
  async function refresh() {
    for (const account of state.accounts) await check(account).catch(() => {});
    save(); emit(); return snapshot();
  }
  // Deleting also signs this partition out on this computer.
  async function remove(id) {
    const account = find(id);
    const win = logins.get(id);
    if (win && !win.isDestroyed()) win.destroy();
    logins.delete(id);
    const ses = sessionOf(account);
    await ses.clearStorageData();
    await ses.clearCache();
    state.accounts = state.accounts.filter((item) => item.id !== id);
    save(); emit(); return snapshot();
  }
  function partitionOf(id) { return find(id).partition; }
  function dispose() { disposed = true; for (const win of logins.values()) if (!win.isDestroyed()) win.destroy(); logins.clear(); }
  return { snapshot, add, rename, login, refresh, remove, partitionOf, dispose };
}

module.exports = { createSocialAccounts, PLATFORMS, allowedUrl, loggedIn, browserUserAgent };
