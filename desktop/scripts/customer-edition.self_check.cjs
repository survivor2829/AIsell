const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
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

function assertContactSyncUiRecoversFromBusyErrors() {
  const source = read(path.join(desktopDir, "src", "renderer", "App.tsx"));
  assert.match(source, /const runContactSync = \(\) => \{\s*if \(contactSyncInFlight\.current\) return;/, "contact sync UI must reject overlapping requests before showing capturing");
  assert.match(source, /status: "blocked",\s*last_error: result\.error/, "contact sync errors without state must clear capturing");
}

assertNoBlockedContent(path.join(desktopDir, "src", "main", "preload.cjs"));
assertNoBlockedContent(path.join(desktopDir, "src", "main", "active-touch-ipc.cjs"));
assertNoRealSendDriver(path.join(desktopDir, "rpa", "active_touch", "wechat_window_driver.cjs"));
assertPreloadCompatibility(path.join(desktopDir, "src", "main", "main.cjs"));
assertPreloadCompatibility(path.join(desktopDir, "src", "main", "touch-task-ipc.cjs"));
assertContactSyncUiRecoversFromBusyErrors();
assert.equal(read(path.join(desktopDir, "src", "main", "main.cjs")).includes("active-touch-dev-ipc.cjs"), true);
assert.equal(read(path.join(desktopDir, "rpa", "active_touch", "state_machine.dev.cjs")).includes("wechat_window_driver.dev.cjs"), true);
assert.match(read(path.join(desktopDir, "scripts", "build-portable-release.cjs")), /name\.endsWith\("\.dev\.cjs"\)/);
assert.equal(read(path.join(desktopDir, "package.json")).includes("build:test"), true);
assert.equal(read(path.join(desktopDir, "package.json")).includes("build:delivery"), true);
assert.equal(read(path.join(desktopDir, "package.json")).includes("build:customer"), false);

console.log("edition boundary self-check passed");
