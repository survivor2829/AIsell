const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const { sourceAllowed } = require("./build-portable-release.cjs");
const blockedChannels = [
  "active-touch:send-real",
  "active-touch:set-real-send-arm",
  "active-touch:send-selected-contact",
  "active-touch:fail-conversation"
];
const blockedDriverTokens = ["clickWechatSendButton", "SEND_MESSAGE_SCRIPT", "XIAOXI_SEND_KEY", "Win32WechatSendMessage", "verifyWechatMessageBubble"];
const momentsActionIpcMarkers = [
  "active-touch:dev-moments-inspect-menu",
  "active-touch:dev-moments-like",
  "active-touch:dev-moments-comment"
];
const momentsActionUiMarkers = [
  "data-xiaoxi-moments-inspect",
  "data-xiaoxi-moments-like",
  "data-xiaoxi-moments-comment"
];

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

function assertStageWorkflowContract() {
  const source = read(path.join(desktopDir, "src", "renderer", "App.tsx"));
  const preload = read(path.join(desktopDir, "src", "main", "preload-api.cjs"));
  assert.match(source, /DEFAULT_ACTIVE_MODULE: ModuleKey = PILOT_EDITION \? "touch" : "reply"/, "delivery must open on active touch");
  const momentsNavEntries = source.match(/\{ key: "moments", label: "[^"]+", icon: [A-Za-z]+ \}/g) ?? [];
  assert.equal(momentsNavEntries.length, 1, "moments publishing and engagement must share exactly one sidebar entry");
  assert.equal(momentsNavEntries[0], "{ key: \"moments\", label: \"朋友圈运营\", icon: ThumbsUp }", "the unified moments entry must use the product name");
  assert.match(source, /\{ key: "agent", label: "微信拓客", icon: UsersRound, children: agentChildren \}/, "the personal WeChat group must use the 微信拓客 product name");
  assert.equal(source.includes("个微Agent"), false, "the retired 个微Agent name must not remain in the UI");
  assert.equal(source.includes("小玺AI员工"), false, "the retired app name must not remain in the UI");
  assert.match(source, /<span>AI获客/, "the app brand must use AI获客");
  assert.match(source, /<MomentsOperations \/>/, "the unified moments entry must render its own page");
  const moduleAvailability = source.match(/function moduleIsAvailable\(key: ModuleKey\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(moduleAvailability, /"moments"/, "moments operations must not render together with the placeholder page");
  assert.match(source, /title: "朋友圈发布"/, "moments operations must expose publishing");
  assert.match(source, /title: "点赞评论"/, "moments operations must retain engagement");
  assert.match(source, /xiaoxiTouchTask\.start\(\{ script: messageDraft, excludedContactIds \}\)/, "start must freeze the user exclusion list");
  assert.match(source, /下一阶段开放/, "future modules must stay visible as next-stage placeholders");
  assert.match(source, /结束本次任务/, "unfinished tasks must expose permanent end with confirmation");
  assert.match(preload, /resolveUnknown: \(payload\) => ipcRenderer\.invoke\("touch-task:resolve-unknown", payload\)/, "unknown send outcomes must expose only the scoped resolution API");
}

function assertMomentsActionEditionBoundary() {
  const developmentMain = ["active-touch-dev-ipc.cjs", "preload.dev.cjs"]
    .map((name) => read(path.join(desktopDir, "src", "main", name)))
    .join("\n");
  const deliveryMain = ["active-touch-ipc.cjs", "preload.cjs", "preload-api.cjs"]
    .map((name) => read(path.join(desktopDir, "src", "main", name)))
    .join("\n");
  for (const marker of momentsActionIpcMarkers) {
    assert.equal(developmentMain.includes(marker), true, `test-only main process must contain ${marker}`);
    assert.equal(deliveryMain.includes(marker), false, `delivery main process must not contain ${marker}`);
  }
  for (const name of ["active-touch-dev-ipc.cjs", "preload.dev.cjs"]) {
    const source = path.join(desktopDir, "src", "main", name);
    assert.equal(sourceAllowed(source, "test"), true, `${name} must be included in the test edition`);
    assert.equal(sourceAllowed(source, "delivery"), false, `${name} must be excluded from the delivery edition`);
  }
  const app = read(path.join(desktopDir, "src", "renderer", "App.tsx"));
  assert.match(app, /const MomentsDryRunPanel = DEVELOPMENT_EDITION \? lazy\(\(\) => import\("\.\/MomentsDryRunPanel"\)\) : null;/, "Moments action UI must remain behind the test-edition build gate");
  const panel = read(path.join(desktopDir, "src", "renderer", "MomentsDryRunPanel.tsx"));
  for (const marker of momentsActionUiMarkers) assert.equal(panel.includes(marker), true, `test-only Moments panel must contain ${marker}`);
}

function assertPackagedEditionUsesCopiedRenderer() {
  const editionSource = read(path.join(desktopDir, "src", "main", "edition.cjs"));
  assert.match(editionSource, /const rendererDir = environmentEdition === "development"/, "local edition builds must load their edition-specific renderer");
  assert.match(editionSource, /: environmentEdition === "pilot" \? "dist-pilot" : "dist";/, "portable builds must load the selected renderer copied to app\/dist");
}

assertNoBlockedContent(path.join(desktopDir, "src", "main", "preload.cjs"));
assertNoBlockedContent(path.join(desktopDir, "src", "main", "active-touch-ipc.cjs"));
assert.equal(read(path.join(desktopDir, "src", "main", "preload.cjs")).includes("xiaoxiActiveTouch"), false, "delivery preload must not expose the development active-touch bridge");
assert.equal(read(path.join(desktopDir, "src", "main", "preload-api.cjs")).includes("active-touch:"), false, "shared preload API must not contain development active-touch channels");
assert.equal(read(path.join(desktopDir, "src", "main", "active-touch-ipc.cjs")).includes("ipcMain.handle"), false, "delivery runtime helper must not register development IPC");
assertNoRealSendDriver(path.join(desktopDir, "rpa", "active_touch", "wechat_window_driver.cjs"));
assertPreloadCompatibility(path.join(desktopDir, "src", "main", "main.cjs"));
assertPreloadCompatibility(path.join(desktopDir, "src", "main", "touch-task-ipc.cjs"));
assertContactSyncUiRecoversFromBusyErrors();
assertStageWorkflowContract();
assertMomentsActionEditionBoundary();
assertPackagedEditionUsesCopiedRenderer();
assert.equal(read(path.join(desktopDir, "src", "main", "main.cjs")).includes("active-touch-dev-ipc.cjs"), true);
assert.equal(read(path.join(desktopDir, "rpa", "active_touch", "state_machine.dev.cjs")).includes("wechat_window_driver.dev.cjs"), true);
assert.match(read(path.join(desktopDir, "scripts", "build-portable-release.cjs")), /name\.endsWith\("\.dev\.cjs"\)/);
for (const name of [
  "moments_dry_run.dev.cjs",
  "moments_dry_run_cli.dev.cjs",
  "moments_action.dev.cjs",
  "moments_action_cli.dev.cjs",
  "moments_action_driver.dev.cjs",
  "moments_comment_readback_proof.dev.cjs",
  "moments_visual_probe.dev.cjs",
  "moments_visual_dry_run.dev.cjs",
  "moments_visual_action_driver.dev.cjs"
]) {
  const source = path.join(desktopDir, "rpa", "active_touch", name);
  assert.equal(sourceAllowed(source, "test"), true, `${name} must be included in the test edition`);
  assert.equal(sourceAllowed(source, "delivery"), false, `${name} must be excluded from the delivery edition`);
}
const momentsActionSelfCheck = path.join(desktopDir, "rpa", "active_touch", "moments_action.self_check.cjs");
assert.equal(sourceAllowed(momentsActionSelfCheck, "test"), false, "Moments action self-check must not be packaged in the test edition");
assert.equal(sourceAllowed(momentsActionSelfCheck, "delivery"), false, "Moments action self-check must not be packaged in the delivery edition");
assert.equal(read(path.join(desktopDir, "package.json")).includes("build:test"), true);
assert.equal(read(path.join(desktopDir, "package.json")).includes("build:delivery"), true);
assert.equal(read(path.join(desktopDir, "package.json")).includes("build:customer"), false);
const packageMetadata = JSON.parse(read(path.join(desktopDir, "package.json")));
assert.equal(packageMetadata.productName, "AI获客");
assert.equal(packageMetadata.version, "0.2.0");

console.log("edition boundary self-check passed");
