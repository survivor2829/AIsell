const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const releaseAppDir = path.resolve(desktopDir, "..", "release", "小玺AI员工-客户版", "resources", "app");
const blockedChannels = [
  "active-touch:send-real",
  "active-touch:set-real-send-arm",
  "active-touch:send-selected-contact",
  "active-touch:fail-conversation"
];
const blockedDriverTokens = ["clickWechatSendButton", "SEND_MESSAGE_SCRIPT", "XIAOXI_SEND_KEY", "Win32WechatSendMessage", "verifyWechatMessageBubble"];

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function assertNoBlockedContent(file) {
  const content = read(file);
  for (const value of blockedChannels) assert.equal(content.includes(value), false, `${file} must not contain ${value}`);
  assert.equal(content.includes("sendReal"), false, `${file} must not expose sendReal`);
}

function assertNoRealSendDriver(file) {
  const content = read(file);
  for (const value of blockedDriverTokens) assert.equal(content.includes(value), false, `${file} must not contain ${value}`);
}

function assertPreloadCompatibility(windowFile) {
  const source = read(windowFile);
  const preload = read(path.join(desktopDir, "src", "main", "preload.cjs"));
  const loadsLocalModule = /require\(["']\.\//.test(preload);
  assert.equal(!loadsLocalModule || /sandbox:\s*false/.test(source), true, `${windowFile} must not sandbox a preload that loads local modules`);
}

assertNoBlockedContent(path.join(desktopDir, "src", "main", "preload.cjs"));
assertNoBlockedContent(path.join(desktopDir, "src", "main", "active-touch-ipc.cjs"));
assertNoRealSendDriver(path.join(desktopDir, "rpa", "active_touch", "wechat_window_driver.cjs"));
assertPreloadCompatibility(path.join(desktopDir, "src", "main", "main.cjs"));
assertPreloadCompatibility(path.join(desktopDir, "src", "main", "touch-task-ipc.cjs"));
assert.equal(read(path.join(desktopDir, "src", "main", "main.cjs")).includes("active-touch-dev-ipc.cjs"), true);
assert.equal(read(path.join(desktopDir, "rpa", "active_touch", "state_machine.dev.cjs")).includes("wechat_window_driver.dev.cjs"), true);
assert.match(read(path.join(desktopDir, "scripts", "sync-customer-release.cjs")), /endsWith\("\.dev\.cjs"\)/);
assert.equal(read(path.join(desktopDir, "package.json")).includes("build:customer"), true);
assert.equal(read(path.join(desktopDir, "package.json")).includes("build:development"), true);

if (process.argv.includes("--release")) {
  assert.equal(fs.existsSync(releaseAppDir), true, "customer release app must exist");
  assert.equal(fs.existsSync(path.join(releaseAppDir, "src", "main", "active-touch-dev-ipc.cjs")), false, "customer release must exclude the real-send IPC module");
  assert.equal(fs.existsSync(path.join(releaseAppDir, "src", "main", "preload.dev.cjs")), false, "customer release must exclude the development preload");
  assert.equal(fs.existsSync(path.join(releaseAppDir, "rpa", "active_touch", "state_machine.dev.cjs")), false, "customer release must exclude the real-send state module");
  assert.equal(fs.existsSync(path.join(releaseAppDir, "rpa", "active_touch", "active_touch_cli.dev.cjs")), false, "customer release must exclude the development executor");
  assert.equal(fs.existsSync(path.join(releaseAppDir, "rpa", "active_touch", "wechat_window_driver.dev.cjs")), false, "customer release must exclude the real-send driver");
  assertNoRealSendDriver(path.join(releaseAppDir, "rpa", "active_touch", "wechat_window_driver.cjs"));
  assert.equal(read(path.join(releaseAppDir, "src", "main", "edition.cjs")).includes("preload.dev.cjs"), true, "customer must fall back to the safe preload when the dev preload is absent");
  assertNoBlockedContent(path.join(releaseAppDir, "src", "main", "preload.cjs"));
  assertNoBlockedContent(path.join(releaseAppDir, "src", "main", "active-touch-ipc.cjs"));
  const assetsDir = path.join(releaseAppDir, "dist", "assets");
  const renderer = fs.readdirSync(assetsDir).filter((file) => file.endsWith(".js")).map((file) => read(path.join(assetsDir, file))).join("\n");
  for (const value of [...blockedChannels, "开发验收", "武装真发开关", "模拟会话不匹配"]) assert.equal(renderer.includes(value), false, `customer renderer must not contain ${value}`);
  assert.equal(read(path.join(releaseAppDir, "dist", "build-edition.json")).includes("customer"), true);
}

console.log("customer edition self-check passed");
