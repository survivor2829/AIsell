const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSocialAccounts, loggedIn } = require("./social-accounts.cjs");
const { findBrowser } = require("./social-browser.cjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 登录识别只看「有没有该平台、未过期、有值的登录 Cookie」；别的平台、过期、相似域名都不算。
const now = Date.parse("2026-10-26T00:00:00Z");
const future = now / 1000 + 86400, past = now / 1000 - 1;
assert.equal(loggedIn("douyin", [{ name: "sessionid", value: "x", domain: ".douyin.com", expires: future }], now), true);
assert.equal(loggedIn("douyin", [{ name: "sessionid", value: "x", domain: ".douyin.com", expires: -1 }], now), true, "会话 Cookie 也算");
assert.equal(loggedIn("douyin", [{ name: "sessionid", value: "x", domain: ".douyin.com", expires: past }], now), false, "过期的登录不算");
assert.equal(loggedIn("douyin", [{ name: "sessionid", value: "", domain: ".douyin.com" }], now), false, "空值不算");
assert.equal(loggedIn("douyin", [{ name: "sessionid", value: "x", domain: ".evil-douyin.com" }], now), false, "相似域名不算");
assert.equal(loggedIn("channels", [{ name: "sessionid", value: "x", domain: ".douyin.com" }], now), false, "别的平台的 Cookie 不算");
assert.equal(loggedIn("xiaohongshu", [{ name: "web_session", value: "x", domain: ".xiaohongshu.com" }], now), false, "小红书游客会话不算登录");
assert.equal(loggedIn("kuaishou", [{ name: "userId", value: "1", domain: ".kuaishou.com" }], now), true);

// 先找 Chrome，没有再用 Edge；都没有时为空。
const env = { ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PF86", LOCALAPPDATA: "C:\\LA" };
assert.equal(findBrowser(env, (file) => file.endsWith("msedge.exe") || file === path.join("C:\\LA", "Google", "Chrome", "Application", "chrome.exe")), path.join("C:\\LA", "Google", "Chrome", "Application", "chrome.exe"));
assert.equal(findBrowser(env, (file) => file.endsWith("msedge.exe")), path.join("C:\\PF", "Microsoft", "Edge", "Application", "msedge.exe"));
assert.equal(findBrowser(env, () => false), "");

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "social-accounts-"));
  const cookies = new Map(), launches = [];
  // 假浏览器：按资料目录保存 Cookie，记录每次启动的参数。
  const launch = ({ profileDir, url, headless }) => {
    let closedResolve; const closed = new Promise((resolve) => { closedResolve = resolve; });
    const browser = { profileDir, url, headless, isClosedFlag: false,
      send: async (method) => { assert.equal(method, "Storage.getCookies", "只读浏览器级 Cookie，不接管页面"); return { cookies: cookies.get(profileDir) || [] }; },
      close: async () => { if (!browser.isClosedFlag) { browser.isClosedFlag = true; closedResolve(); } },
      isClosed: () => browser.isClosedFlag, closed };
    launches.push(browser); return browser;
  };
  // The platform's own page, as the hidden refresh window sees it: signed out, signed in, or unclear (throws).
  const platformPage = { verdict: false, probes: [] };
  const probe = async (browser, platform) => { platformPage.probes.push({ headless: browser.headless, platform }); if (platformPage.verdict instanceof Error) throw platformPage.verdict; return platformPage.verdict; };
  const accounts = createSocialAccounts({ dataDir, launch, executable: "chrome.exe", pollMs: 5, probe });

  const first = (await accounts.add({ platform: "douyin", label: "" })).accounts[0];
  assert.equal(first.label, "抖音账号1", "没填备注名时按平台编号");
  assert.equal(first.loggingIn, true);
  assert.equal(launches[0].url, "https://creator.douyin.com/", "打开平台官方创作者后台登录");
  assert.ok(!launches[0].headless, "登录用可见的 Chrome 窗口");
  assert.equal(launches[0].profileDir, path.join(dataDir, "profiles", first.id), "每个账号单独的浏览器资料目录");

  // 扫码完成：出现登录 Cookie 后识别为已登录，窗口自动关闭。
  cookies.set(launches[0].profileDir, [{ name: "sessionid", value: "secret-token", domain: ".douyin.com", expires: Date.now() / 1000 + 3600 }]);
  for (let i = 0; i < 400 && !launches[0].isClosed(); i++) await sleep(10);
  assert.equal(launches[0].isClosed(), true, "登录后窗口自动关闭");
  await sleep(20);
  let state = accounts.snapshot();
  assert.equal(state.accounts[0].status, "active");
  assert.equal(state.accounts[0].loggingIn, false);
  assert.ok(state.accounts[0].lastLoginAt);
  assert.equal(fs.readFileSync(path.join(dataDir, "state.json"), "utf8").includes("secret-token"), false, "落盘记录里没有登录凭据");

  // 同平台多账号；用户没扫码就关了窗口，保持待登录。
  await accounts.add({ platform: "douyin", label: "  门店号  " });
  assert.equal(accounts.snapshot().accounts[1].label, "门店号");
  await launches[launches.length - 1].close();
  await sleep(20);
  assert.equal(accounts.snapshot().accounts[1].status, "login_required");

  // 登录失效：刷新时用无界面浏览器读同一资料目录，Cookie 没了显示失效。
  cookies.delete(launches[0].profileDir);
  const before = launches.length;
  state = await accounts.refresh();
  assert.deepEqual(state.accounts.map((item) => item.status), ["expired", "login_required"]);
  assert.ok(launches.slice(before).every((browser) => browser.headless && browser.isClosed()), "刷新用无界面浏览器，读完即关");

  // 2026-10-29 客户现场：本机还留着登录 Cookie，平台却要求重新扫码。平台的说法优先。
  const staleCookie = [{ name: "sessionid", value: "old-session", domain: ".douyin.com", expires: Date.now() / 1000 + 86400 * 30 }];
  cookies.set(launches[0].profileDir, staleCookie);
  assert.equal((await accounts.refresh()).accounts[0].status, "active", "只有 Cookie 时仍按 Cookie 显示");
  accounts.markSignedOut(first.id);
  assert.equal(accounts.snapshot().accounts[0].status, "expired", "发布时平台跳到登录页，账号立刻显示需要重新登录");
  assert.equal((await accounts.refresh()).accounts[0].status, "expired", "刷新时旧 Cookie 还在，也不能再显示已登录");
  await accounts.login(first.id);
  const relogin = launches[launches.length - 1];
  await sleep(80);
  assert.equal(relogin.isClosed(), false, "打开登录窗口时的旧 Cookie 不算登录，窗口不会自己关掉");
  cookies.set(relogin.profileDir, [{ ...staleCookie[0], value: "new-session" }]);
  for (let i = 0; i < 400 && !relogin.isClosed(); i++) await sleep(10);
  assert.equal(relogin.isClosed(), true, "扫码换了新的登录 Cookie 才算重新登录");
  await sleep(20);
  assert.equal(accounts.snapshot().accounts[0].status, "active");
  assert.equal(fs.readFileSync(path.join(dataDir, "state.json"), "utf8").includes("session"), false, "比较只在内存里做，不落盘凭据");
  cookies.delete(launches[0].profileDir);
  await accounts.refresh();
  assert.equal(platformPage.probes.length, 2, "只有 Cookie 看起来已登录时才开平台页面核对（上面两次），Cookie 没了不再核对");

  // 刷新状态时核对平台本身：Cookie 还在、平台发布页却跳到登录页，就显示需要重新登录。
  cookies.set(launches[0].profileDir, [{ ...staleCookie[0], value: "kept-session" }]);
  platformPage.probes.length = 0;
  platformPage.verdict = new Error("page did not load");
  assert.equal((await accounts.refresh()).accounts[0].status, "active", "平台页面没打开时不下结论，按 Cookie 显示");
  platformPage.verdict = true;
  assert.equal((await accounts.refresh()).accounts[0].status, "expired");
  assert.deepEqual(platformPage.probes[0], { headless: true, platform: "douyin" }, "在读 Cookie 的那个无界面窗口里核对");
  cookies.delete(launches[0].profileDir);
  platformPage.verdict = false;
  await accounts.refresh();

  // 重启后记录还在；删除账号会删掉它的浏览器资料目录。
  await accounts.dispose();
  const reopened = createSocialAccounts({ dataDir, launch, executable: "chrome.exe", pollMs: 5, probe });
  assert.equal(reopened.snapshot().accounts.length, 2);
  const profile = path.join(dataDir, "profiles", first.id);
  fs.mkdirSync(profile, { recursive: true }); fs.writeFileSync(path.join(profile, "Cookies"), "x");
  await reopened.remove(first.id);
  assert.equal(fs.existsSync(profile), false, "删除账号同时删除这台电脑上的登录资料");
  assert.equal(reopened.snapshot().accounts.length, 1);
  await assert.rejects(reopened.login("not-an-id"), { code: "SOCIAL_ACCOUNT_NOT_FOUND" });
  assert.throws(() => reopened.add({ platform: "weibo" }), { code: "SOCIAL_PLATFORM_INVALID" });
  await reopened.dispose();

  // 没装浏览器时界面能提示。
  assert.equal(createSocialAccounts({ dataDir, launch, executable: "" }).snapshot().browserReady, false);

  // 记录文件损坏时保留原文件并报错，不覆盖。
  fs.writeFileSync(path.join(dataDir, "state.json"), "{broken");
  assert.throws(() => createSocialAccounts({ dataDir, launch }), { code: "SOCIAL_STATE_INVALID" });
  assert.equal(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"), "{broken");
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log("social accounts self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });
