const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const desktopDir = path.resolve(__dirname, "..");
const productBrand = require("../product-brand.json");
const {
  runTransactionalRelease,
  scanRelease,
  sourceAllowed,
  treeSha256
} = require("./build-portable-release.cjs");
const {
  normalizeArchiveEntry,
  parsePortableArguments,
  resolvePortablePaths,
  verifyPortableArchive
} = require("./portable-release.self_check.cjs");
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
  assert.match(source, /productBrand\.displayName/, "the app brand must use the shared V1.0 product name");
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
  const campaignMain = ["main.cjs", "moments-campaign-ipc.cjs", "moments-publish-ipc.cjs", "preload-api.cjs", "preload.cjs"]
    .map((name) => read(path.join(desktopDir, "src", "main", name)))
    .join("\n");
  assert.match(campaignMain, /moments-campaign:start/, "delivery must expose the scoped Moments campaign bridge");
  assert.match(campaignMain, /moments-publish:confirm/, "delivery must expose the double-confirmed Moments publish bridge");
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
  assert.match(app, /const MomentsCampaignPanel = REAL_SEND_EDITION \? lazy/, "Moments campaign UI must be available in pilot and development editions");
  assert.match(app, /const MomentsPublishPanel = REAL_SEND_EDITION \? lazy/, "Moments publish UI must be available in pilot and development editions");
  assert.match(app, /const MomentsDryRunPanel = DEVELOPMENT_EDITION \? lazy/, "single-post Moments controls must remain behind the test-edition build gate");
  assert.match(read(path.join(desktopDir, "src", "main", "main.cjs")), /developmentEdition \|\| pilotEdition\s+\? require\("\.\/moments-campaign-ipc\.cjs"\)/, "pilot main process must register Moments campaign IPC");
  assert.match(read(path.join(desktopDir, "src", "main", "main.cjs")), /developmentEdition \|\| pilotEdition\s+\? require\("\.\/moments-publish-ipc\.cjs"\)/, "pilot main process must register Moments publish IPC");
  const panel = read(path.join(desktopDir, "src", "renderer", "MomentsDryRunPanel.tsx"));
  for (const marker of momentsActionUiMarkers) assert.equal(panel.includes(marker), true, `test-only Moments panel must contain ${marker}`);
}

function assertPackagedEditionUsesCopiedRenderer() {
  const editionSource = read(path.join(desktopDir, "src", "main", "edition.cjs"));
  const mainSource = read(path.join(desktopDir, "src", "main", "main.cjs"));
  assert.match(editionSource, /const rendererDir = environmentEdition === "development"/, "local edition builds must load their edition-specific renderer");
  assert.match(editionSource, /: environmentEdition === "pilot" \? "dist-pilot" : "dist";/, "portable builds must load the selected renderer copied to app\/dist");
  assert.match(editionSource, /electron\?\.app\?\.isPackaged === true/, "packaged apps must ignore development-edition environment overrides");
  assert.match(mainSource, /if \(!app\.isPackaged && process\.env\.VITE_DEV_SERVER_URL\)/, "packaged apps must ignore a development renderer URL");
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
  "moments_navigation.dev.cjs",
  "moments_surface_profile.dev.cjs",
  "moments_surface_evidence.dev.cjs",
  "moments_publish_driver.dev.cjs",
  "moments_dry_run_cli.dev.cjs",
  "moments_action.dev.cjs",
  "moments_action_cli.dev.cjs",
  "moments_action_driver.dev.cjs",
  "moments_comment_readback_proof.dev.cjs",
  "moments_visual_dry_run.dev.cjs",
  "moments_visual_action_driver.dev.cjs"
]) {
  const source = path.join(desktopDir, "rpa", "active_touch", name);
  assert.equal(sourceAllowed(source, "test"), true, `${name} must be included in the test edition`);
  assert.equal(sourceAllowed(source, "delivery"), true, `${name} must be included in the delivery edition`);
}
for (const name of [
  "moments_visual_probe.dev.cjs",
  "wechat_auto_reply_visual_driver.dev.cjs",
  "wechat_auto_reply_visual_send.dev.cjs"
]) {
  const source = path.join(desktopDir, "rpa", "active_touch", name);
  assert.equal(sourceAllowed(source, "test"), true, `${name} must be included in the test edition`);
  assert.equal(sourceAllowed(source, "delivery"), true, `${name} must be included in the delivery edition`);
}
const momentsActionSelfCheck = path.join(desktopDir, "rpa", "active_touch", "moments_action.self_check.cjs");
assert.equal(sourceAllowed(momentsActionSelfCheck, "test"), false, "Moments action self-check must not be packaged in the test edition");
assert.equal(sourceAllowed(momentsActionSelfCheck, "delivery"), false, "Moments action self-check must not be packaged in the delivery edition");
for (const name of [
  "wechat_auto_reply_visual_driver.self_check.cjs",
  "wechat_auto_reply_visual_send.self_check.cjs"
]) {
  const source = path.join(desktopDir, "rpa", "active_touch", name);
  assert.equal(sourceAllowed(source, "test"), false, `${name} must not be packaged in the test edition`);
  assert.equal(sourceAllowed(source, "delivery"), false, `${name} must not be packaged in the delivery edition`);
}
assert.equal(read(path.join(desktopDir, "package.json")).includes("build:test"), true);
assert.equal(read(path.join(desktopDir, "package.json")).includes("build:delivery"), true);
assert.equal(read(path.join(desktopDir, "package.json")).includes("build:customer"), false);
const packageMetadata = JSON.parse(read(path.join(desktopDir, "package.json")));
assert.equal(packageMetadata.productName, productBrand.displayName);
assert.equal(packageMetadata.version, "1.0.0");
const portableBuilderSource = read(path.join(desktopDir, "scripts", "build-portable-release.cjs"));
assert.match(
  portableBuilderSource,
  /copyFileSync\(path\.join\(desktopDir, "product-brand\.json"\), path\.join\(appDir, "product-brand\.json"\)\)/,
  "portable releases must include the shared product brand configuration"
);
assert.equal(portableBuilderSource.includes("localeCompare"), false, "release ordering must not depend on the host locale");
assert.equal(portableBuilderSource.includes("removeLegacyProducts"), false, "ordinary releases must not delete other editions or retired brands");
assert.match(read(path.join(desktopDir, "scripts", "portable-release.self_check.cjs")), /parsePortableArguments/);
assert.match(read(path.join(desktopDir, "scripts", "portable-release.self_check.cjs")), /resolvePortablePaths/);
for (const name of [".env", ".env.ai.local", ".env.production"]) {
  const source = path.join(desktopDir, "src", "main", name);
  assert.equal(sourceAllowed(source, "test"), false, `${name} must be excluded from the test edition`);
  assert.equal(sourceAllowed(source, "delivery"), false, `${name} must be excluded from the delivery edition`);
}
for (const [scriptName, buildStep] of [["release:test", "build:test"], ["release:delivery", "build:delivery"]]) {
  const script = packageMetadata.scripts[scriptName];
  assert.equal(script.indexOf("check:clean-runtime") < script.indexOf(buildStep), true, `${scriptName} must check runtime residue before building`);
  assert.equal((script.match(/portable-release\.self_check/g) || []).length, 0, `${scriptName} must rely on the staging self-check before promotion, not revalidate after publication`);
}
assert.match(read(path.join(desktopDir, "scripts", "check-clean-runtime.cjs")), /\^\\\.env\(\?:\\\.|\$\)\/i/, "clean-runtime must detect environment files case-insensitively on Windows");
const hashFixture = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-release-hash-"));
try {
  fs.mkdirSync(path.join(hashFixture, "nested"));
  fs.writeFileSync(path.join(hashFixture, "a.txt"), "one", "utf8");
  fs.writeFileSync(path.join(hashFixture, "nested", "b.txt"), "two", "utf8");
  const firstHash = treeSha256(hashFixture);
  assert.match(firstHash, /^[0-9a-f]{64}$/);
  assert.equal(treeSha256(hashFixture), firstHash, "source tree hash must be deterministic");
  fs.writeFileSync(path.join(hashFixture, "nested", "b.txt"), "changed", "utf8");
  assert.notEqual(treeSha256(hashFixture), firstHash, "source tree hash must change with packaged content");
} finally {
  fs.rmSync(hashFixture, { recursive: true, force: true });
}

const blockedFixture = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-release-blocked-"));
try {
  fs.writeFileSync(path.join(blockedFixture, ".env.ai.local"), "DEEPSEEK_API_KEY=fixture-only", "utf8");
  assert.throws(() => scanRelease(blockedFixture), /blocked files or secrets/, "release scan must reject environment files");
} finally {
  fs.rmSync(blockedFixture, { recursive: true, force: true });
}

assert.deepEqual(parsePortableArguments([]), { edition: "delivery", targetOption: null, zipOption: null });
assert.deepEqual(parsePortableArguments(["test", "--target", "target", "--zip", "target.zip"]), {
  edition: "test",
  targetOption: "target",
  zipOption: "target.zip"
});
assert.throws(() => parsePortableArguments(["delivery", "--unknown", "value"]), /Unknown portable self-check option/);
assert.throws(() => parsePortableArguments(["delivery", "--target", "one", "--target", "two", "--zip", "three"]), /Duplicate portable self-check option/);
assert.throws(() => parsePortableArguments(["delivery", "--target", "one"]), /must be provided together/);
for (const unsafe of ["/AI获客/file", "C:/AI获客/file", "AI获客/../file", "AI获客/file:stream", "AI获客/file."]) {
  assert.throws(() => normalizeArchiveEntry(unsafe, "AI获客"), /absolute|unsafe/);
}
assert.throws(() => verifyPortableArchive({
  zip: "fixture.zip",
  target: "fixture-target",
  productName: "AI获客",
  expectedSourceTreeSha256: "a".repeat(64),
  tar: (args) => args[0] === "-tf"
    ? { status: 0, stdout: "AI获客/\nAI获客/link\n", stderr: "" }
    : { status: 0, stdout: "drwxrwxrwx AI获客/\nlrwxrwxrwx AI获客/link\n", stderr: "" }
}), /only regular files and directories/, "portable ZIP must reject symbolic or special entries before extraction");

const portablePathFixture = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-portable-paths-"));
try {
  const testProductName = `${productBrand.displayName}-测试版`;
  const stagingRoot = path.join(portablePathFixture, ".staging-test-fixture");
  const target = path.join(stagingRoot, testProductName);
  const zip = path.join(stagingRoot, `${testProductName}.zip`);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(zip, "fixture", "utf8");
  const resolved = resolvePortablePaths({
    edition: "test",
    targetOption: target,
    zipOption: zip,
    releaseRoot: portablePathFixture
  });
  assert.equal(resolved.productName, testProductName);
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-portable-outside-"));
  try {
    const outsideTarget = path.join(outsideRoot, testProductName);
    const outsideZip = path.join(outsideRoot, `${testProductName}.zip`);
    fs.mkdirSync(outsideTarget);
    fs.writeFileSync(outsideZip, "fixture", "utf8");
    assert.throws(() => resolvePortablePaths({
      edition: "test",
      targetOption: outsideTarget,
      zipOption: outsideZip,
      releaseRoot: portablePathFixture
    }), /below the project release directory/);
  } finally {
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
  assert.throws(() => resolvePortablePaths({
    edition: "test",
    targetOption: target,
    zipOption: path.join(portablePathFixture, `${testProductName}.zip`),
    releaseRoot: portablePathFixture
  }), /same parent directory|does not exist/);
} finally {
  fs.rmSync(portablePathFixture, { recursive: true, force: true });
}

const portableArchiveFixture = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-portable-archive-fixture-"));
try {
  const productName = "AI获客";
  const target = path.join(portableArchiveFixture, productName);
  const appDir = path.join(target, "resources", "app");
  const zip = path.join(portableArchiveFixture, `${productName}.zip`);
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "app.txt"), "packaged-app", "utf8");
  fs.writeFileSync(path.join(target, "marker.txt"), "same-tree", "utf8");
  const archive = spawnSync("tar.exe", ["-a", "-c", "-f", zip, "-C", portableArchiveFixture, productName], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  assert.equal(archive.status, 0, archive.stderr || archive.stdout || "portable archive fixture creation failed");
  verifyPortableArchive({
    zip,
    target,
    productName,
    expectedSourceTreeSha256: treeSha256(appDir)
  });
  fs.writeFileSync(path.join(target, "marker.txt"), "target-changed-after-archive", "utf8");
  assert.throws(() => verifyPortableArchive({
    zip,
    target,
    productName,
    expectedSourceTreeSha256: treeSha256(appDir)
  }), /must exactly match/);
  fs.writeFileSync(path.join(target, "marker.txt"), "same-tree", "utf8");
  let retainedTemporaryRoot = "";
  const cleanupResult = verifyPortableArchive({
    zip,
    target: path.join(portableArchiveFixture, productName),
    productName,
    expectedSourceTreeSha256: treeSha256(appDir),
    removeTemporary: (temporaryRoot) => {
      retainedTemporaryRoot = temporaryRoot;
      throw new Error("fixture cleanup denied");
    },
    warn: () => {}
  });
  assert.equal(cleanupResult.cleanupWarnings.length, 1, "archive cleanup failure must be reported as a warning");
  fs.rmSync(retainedTemporaryRoot, { recursive: true, force: true });
} finally {
  fs.rmSync(portableArchiveFixture, { recursive: true, force: true });
}

function transactionFixture() {
  const releaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-release-transaction-"));
  const canonicalTarget = path.join(releaseRoot, "AI获客");
  const canonicalZip = path.join(releaseRoot, "AI获客.zip");
  const stagingRoot = path.join(releaseRoot, ".staging-fixture");
  const stagingTarget = path.join(stagingRoot, "AI获客");
  const stagingZip = path.join(stagingRoot, "AI获客.zip");
  fs.mkdirSync(canonicalTarget);
  fs.writeFileSync(path.join(canonicalTarget, "marker.txt"), "old-good", "utf8");
  fs.writeFileSync(canonicalZip, "old-good-zip", "utf8");
  return { releaseRoot, canonicalTarget, canonicalZip, stagingRoot, stagingTarget, stagingZip };
}

function assertOldPackageUnchanged(paths) {
  assert.equal(fs.readFileSync(path.join(paths.canonicalTarget, "marker.txt"), "utf8"), "old-good");
  assert.equal(fs.readFileSync(paths.canonicalZip, "utf8"), "old-good-zip");
  assert.equal(fs.existsSync(paths.stagingRoot), false, "failed transaction must clean its staging directory");
}

for (const failurePhase of ["preflight", "prepare", "validate"]) {
  const paths = transactionFixture();
  try {
    assert.throws(() => runTransactionalRelease({
      ...paths,
      transactionId: `fixture-${failurePhase}`,
      preflight: () => {
        if (failurePhase === "preflight") throw new Error("dirty fixture");
        return { commit: "a".repeat(40), dirty: false };
      },
      prepare: () => {
        fs.mkdirSync(paths.stagingTarget);
        fs.writeFileSync(path.join(paths.stagingTarget, "marker.txt"), "new", "utf8");
        fs.writeFileSync(paths.stagingZip, "new-zip", "utf8");
        if (failurePhase === "prepare") throw new Error("build fixture failed");
        return { target: paths.stagingTarget, zip: paths.stagingZip };
      },
      validate: () => {
        if (failurePhase === "validate") throw new Error("validation fixture failed");
      }
    }), failurePhase === "preflight" ? /dirty fixture/ : /fixture failed/);
    assertOldPackageUnchanged(paths);
  } finally {
    fs.rmSync(paths.releaseRoot, { recursive: true, force: true });
  }
}

const publishFailureFixture = transactionFixture();
try {
  assert.throws(() => runTransactionalRelease({
    ...publishFailureFixture,
    transactionId: "fixture-publish-failure",
    preflight: () => ({ commit: "a".repeat(40), dirty: false }),
    prepare: () => {
      fs.mkdirSync(publishFailureFixture.stagingTarget);
      fs.writeFileSync(path.join(publishFailureFixture.stagingTarget, "marker.txt"), "new", "utf8");
      return { target: publishFailureFixture.stagingTarget, zip: publishFailureFixture.stagingZip };
    },
    validate: () => {}
  }), /ENOENT/, "publish failure must be reported");
  assertOldPackageUnchanged(publishFailureFixture);
} finally {
  fs.rmSync(publishFailureFixture.releaseRoot, { recursive: true, force: true });
}

const publishFixture = transactionFixture();
try {
  const otherEdition = path.join(publishFixture.releaseRoot, "AI获客-测试版");
  const otherEditionZip = `${otherEdition}.zip`;
  fs.mkdirSync(otherEdition);
  fs.writeFileSync(path.join(otherEdition, "marker.txt"), "other-good", "utf8");
  fs.writeFileSync(otherEditionZip, "other-good-zip", "utf8");
  runTransactionalRelease({
    ...publishFixture,
    transactionId: "fixture-success",
    preflight: () => ({ commit: "a".repeat(40), dirty: false }),
    prepare: () => {
      fs.mkdirSync(publishFixture.stagingTarget);
      fs.writeFileSync(path.join(publishFixture.stagingTarget, "marker.txt"), "new-good", "utf8");
      fs.writeFileSync(publishFixture.stagingZip, "new-good-zip", "utf8");
      return { target: publishFixture.stagingTarget, zip: publishFixture.stagingZip };
    },
    validate: () => {}
  });
  assert.equal(fs.readFileSync(path.join(publishFixture.canonicalTarget, "marker.txt"), "utf8"), "new-good");
  assert.equal(fs.readFileSync(publishFixture.canonicalZip, "utf8"), "new-good-zip");
  assert.equal(fs.readFileSync(path.join(otherEdition, "marker.txt"), "utf8"), "other-good");
  assert.equal(fs.readFileSync(otherEditionZip, "utf8"), "other-good-zip");
} finally {
  fs.rmSync(publishFixture.releaseRoot, { recursive: true, force: true });
}

const cleanupWarningFixture = transactionFixture();
try {
  const result = runTransactionalRelease({
    ...cleanupWarningFixture,
    transactionId: "fixture-cleanup-warning",
    preflight: () => ({ commit: "a".repeat(40), dirty: false }),
    prepare: () => {
      fs.mkdirSync(cleanupWarningFixture.stagingTarget);
      fs.writeFileSync(path.join(cleanupWarningFixture.stagingTarget, "marker.txt"), "published-despite-cleanup-warning", "utf8");
      fs.writeFileSync(cleanupWarningFixture.stagingZip, "published-zip", "utf8");
      return { target: cleanupWarningFixture.stagingTarget, zip: cleanupWarningFixture.stagingZip };
    },
    validate: () => {},
    cleanup: (_targets, label) => {
      throw new Error(`${label} fixture cleanup denied`);
    }
  });
  assert.equal(result.published, true, "cleanup failure after promotion must not turn publication into a failure");
  assert.equal(result.cleanupWarnings.length, 2, "backup and staging cleanup failures must remain visible");
  assert.equal(fs.readFileSync(path.join(cleanupWarningFixture.canonicalTarget, "marker.txt"), "utf8"), "published-despite-cleanup-warning");
  assert.equal(fs.readFileSync(cleanupWarningFixture.canonicalZip, "utf8"), "published-zip");
} finally {
  fs.rmSync(cleanupWarningFixture.releaseRoot, { recursive: true, force: true });
}

console.log("edition boundary self-check passed");
