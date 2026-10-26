const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createSocialAccounts, allowedUrl, loggedIn } = require("./social-accounts.cjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 登录识别只看「有没有该平台、未过期、有值的登录 Cookie」，不读值；别的平台或过期的不算。
const now = Date.parse("2026-10-26T00:00:00Z");
const future = now / 1000 + 86400, past = now / 1000 - 1;
assert.equal(loggedIn("douyin", [{ name: "sessionid", value: "x", domain: ".douyin.com", expirationDate: future }], now), true);
assert.equal(loggedIn("douyin", [{ name: "sessionid", value: "x", domain: ".douyin.com", expirationDate: past }], now), false, "过期的登录不算");
assert.equal(loggedIn("douyin", [{ name: "sessionid", value: "", domain: ".douyin.com" }], now), false, "空值不算");
assert.equal(loggedIn("douyin", [{ name: "sessionid", value: "x", domain: ".evil-douyin.com" }], now), false, "相似域名不算");
assert.equal(loggedIn("channels", [{ name: "sessionid", value: "x", domain: ".douyin.com" }], now), false, "别的平台的 Cookie 不算");
assert.equal(loggedIn("xiaohongshu", [{ name: "web_session", value: "x", domain: ".xiaohongshu.com" }], now), false, "小红书游客会话不算登录");
assert.equal(loggedIn("kuaishou", [{ name: "userId", value: "1", domain: ".kuaishou.com" }], now), true);
assert.equal(allowedUrl("douyin", "https://creator.douyin.com/creator-micro/home"), true);
assert.equal(allowedUrl("douyin", "http://creator.douyin.com/"), false, "只允许 https");
assert.equal(allowedUrl("douyin", "https://douyin.com.evil.example/"), false);
assert.equal(allowedUrl("weibo", "https://weibo.com/"), false, "未知平台一律不放行");

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "social-accounts-"));
  const cookies = new Map(), cleared = [], windows = [];
  const session = { fromPartition: (partition) => ({
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {},
    cookies: { get: async () => cookies.get(partition) || [] },
    clearStorageData: async () => { cleared.push(partition); cookies.delete(partition); }, clearCache: async () => {}
  }) };
  class FakeWindow extends EventEmitter {
    constructor(options) { super(); this.options = options; this.destroyed = false; this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} }); windows.push(this); }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; } show() {} focus() {} setMenu() {}
    close() { this.destroy(); } destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("closed"); } }
  }
  const updates = [];
  const accounts = createSocialAccounts({ dataDir, BrowserWindow: FakeWindow, session, onChange: (state) => updates.push(state), pollMs: 5 });

  const added = accounts.add({ platform: "douyin", label: "" });
  const first = (await added).accounts[0];
  assert.equal(first.label, "抖音账号1", "没填备注名时按平台编号");
  assert.equal(first.partition, undefined, "分区名不发给界面");
  assert.equal(first.loggingIn, true);
  assert.equal(windows[0].url, "https://creator.douyin.com/", "打开平台官方创作者后台登录");
  assert.equal(windows[0].options.webPreferences.sandbox, true);
  assert.equal(windows[0].options.webPreferences.preload, undefined, "平台页面拿不到任何 preload");
  const nav = { prevented: false, preventDefault() { this.prevented = true; } };
  windows[0].webContents.emit("will-navigate", nav, "https://evil.example/");
  assert.equal(nav.prevented, true, "不允许跳出平台域名");

  // 扫码完成：出现登录 Cookie 后识别为已登录，窗口自动关闭。
  const partition = `persist:social-douyin-${first.id}`;
  cookies.set(partition, [{ name: "sessionid", value: "s", domain: ".douyin.com", expirationDate: Date.now() / 1000 + 3600 }]);
  for (let i = 0; i < 200 && !windows[0].destroyed; i++) await sleep(10);
  assert.equal(windows[0].destroyed, true, "登录后窗口自动关闭");
  let state = accounts.snapshot();
  assert.equal(state.accounts[0].status, "active");
  assert.ok(state.accounts[0].lastLoginAt);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"))).includes("\"s\""), false, "落盘记录里没有登录凭据");

  // 同平台多账号，各自独立分区。
  await accounts.add({ platform: "douyin", label: "  门店号  " });
  state = accounts.snapshot();
  assert.equal(state.accounts[1].label, "门店号");
  windows[1].destroy();

  // 登录失效：Cookie 没了，刷新后显示失效；从没登录过的显示待登录。
  cookies.delete(partition);
  state = (await accounts.refresh());
  assert.deepEqual(state.accounts.map((item) => item.status), ["expired", "login_required"]);

  // 重启后记录还在；删除会清空该账号分区。
  accounts.dispose();
  const reopened = createSocialAccounts({ dataDir, BrowserWindow: FakeWindow, session, pollMs: 5 });
  assert.equal(reopened.snapshot().accounts.length, 2);
  await reopened.remove(first.id);
  assert.deepEqual(cleared, [partition], "删除账号同时退出这台电脑上的登录");
  assert.equal(reopened.snapshot().accounts.length, 1);
  await assert.rejects(reopened.login("not-an-id"), { code: "SOCIAL_ACCOUNT_NOT_FOUND" });
  assert.throws(() => reopened.add({ platform: "weibo" }), { code: "SOCIAL_PLATFORM_INVALID" });
  reopened.dispose();

  // 记录文件损坏时保留原文件并报错，不覆盖。
  fs.writeFileSync(path.join(dataDir, "state.json"), "{broken");
  assert.throws(() => createSocialAccounts({ dataDir, BrowserWindow: FakeWindow, session }), { code: "SOCIAL_STATE_INVALID" });
  assert.equal(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"), "{broken");
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log("social accounts self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });
