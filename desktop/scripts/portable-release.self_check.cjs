const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { treeSha256 } = require("./release-tree-hash.cjs");
const {
  PRODUCT_DETAIL_EXECUTABLE,
  PRODUCT_DETAIL_RELEASE_PATH,
  isProductDetailArchivePythonSource,
  isProductDetailPythonSource,
  runPackagedProductDetailSelfCheck
} = require("./product-detail-release-runtime.cjs");
const {
  CONTENT_ENGINE_EXECUTABLE,
  CONTENT_ENGINE_RELEASE_PATH,
  isContentEngineArchivePythonSource,
  isContentEnginePythonSource,
  runPackagedContentEngineSelfCheck
} = require("./content-engine-release-runtime.cjs");

const desktopDir = path.resolve(__dirname, "..");
const projectDir = path.resolve(desktopDir, "..");

function parsePortableArguments(argv) {
  const args = [...argv];
  let edition = "delivery";
  if (args[0] && !args[0].startsWith("--")) edition = args.shift();
  if (!["test", "delivery"].includes(edition)) throw new Error(`Unsupported portable edition: ${edition}`);

  const values = new Map();
  const allowed = new Set(["--target", "--zip"]);
  while (args.length) {
    const option = args.shift();
    if (!allowed.has(option)) throw new Error(`Unknown portable self-check option: ${option}`);
    if (values.has(option)) throw new Error(`Duplicate portable self-check option: ${option}`);
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
    values.set(option, value);
  }
  if (values.has("--target") !== values.has("--zip")) {
    throw new Error("--target and --zip must be provided together");
  }
  return {
    edition,
    targetOption: values.get("--target") || null,
    zipOption: values.get("--zip") || null
  };
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function assertRealPathInside(root, target, label) {
  const relative = path.relative(root, target);
  if (relative === "" || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} must be below the project release directory: ${target}`);
  }
}

function resolvePortablePaths({ edition, targetOption, zipOption, releaseRoot = path.join(projectDir, "release") }) {
  const productName = edition === "test" ? "AI获客-测试版" : "AI获客";
  const target = path.resolve(targetOption || path.join(releaseRoot, productName));
  const zip = path.resolve(zipOption || path.join(releaseRoot, `${productName}.zip`));
  if (path.basename(target) !== productName) throw new Error(`Portable target basename must be ${productName}`);
  if (path.basename(zip) !== `${productName}.zip`) throw new Error(`Portable ZIP basename must be ${productName}.zip`);
  if (!samePath(path.dirname(target), path.dirname(zip))) throw new Error("Portable target and ZIP must have the same parent directory");
  if (!fs.existsSync(releaseRoot)) throw new Error(`Project release directory does not exist: ${releaseRoot}`);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`Portable target directory does not exist: ${target}`);
  if (!fs.existsSync(zip) || !fs.statSync(zip).isFile()) throw new Error(`Portable ZIP does not exist: ${zip}`);

  const realReleaseRoot = fs.realpathSync(releaseRoot);
  const realTarget = fs.realpathSync(target);
  const realZip = fs.realpathSync(zip);
  assertRealPathInside(realReleaseRoot, realTarget, "Portable target");
  assertRealPathInside(realReleaseRoot, realZip, "Portable ZIP");
  if (path.basename(realTarget) !== productName || path.basename(realZip) !== `${productName}.zip`) {
    throw new Error("Portable target or ZIP resolves through an unexpected alias");
  }
  const realParent = path.dirname(realTarget);
  if (!samePath(realParent, path.dirname(realZip))) throw new Error("Portable target and ZIP must resolve to the same parent directory");
  const relativeParent = path.relative(realReleaseRoot, realParent);
  if (relativeParent !== "") {
    const parts = relativeParent.split(path.sep).filter(Boolean);
    if (parts.length !== 1 || !parts[0].startsWith(`.staging-${edition}-`)) {
      throw new Error("Portable target and ZIP must be canonical outputs or direct release staging outputs");
    }
  }
  return { edition, productName, target: realTarget, zip: realZip, releaseRoot: realReleaseRoot };
}

function normalizeArchiveEntry(entry, expectedRoot = null) {
  const source = String(entry).replace(/\r$/, "");
  if (!source || /[\0-\x1f\x7f]/.test(source)) throw new Error(`Portable ZIP contains an invalid entry name: ${JSON.stringify(source)}`);
  let normalized = source.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.startsWith("//") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Portable ZIP contains an absolute entry: ${source}`);
  }
  normalized = normalized.replace(/\/+$/, "");
  const segments = normalized.split("/");
  if (!normalized || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":") || /[. ]$/.test(segment))) {
    throw new Error(`Portable ZIP contains an unsafe entry: ${source}`);
  }
  if (expectedRoot && segments[0] !== expectedRoot) throw new Error(`Portable ZIP entry is outside its single root: ${source}`);
  return normalized;
}

function runTar(args, timeout = 30000) {
  return spawnSync("tar.exe", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 16 * 1024 * 1024
  });
}

function assertTarSucceeded(result, message) {
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || message);
}

function verifyPortableArchive({
  zip,
  target,
  productName,
  expectedSourceTreeSha256,
  tar = runTar,
  removeTemporary = (temporaryRoot) => fs.rmSync(temporaryRoot, { recursive: true, force: true }),
  warn = console.warn
}) {
  const list = tar(["-tf", zip]);
  assertTarSucceeded(list, "portable ZIP must be readable");
  const rawEntries = String(list.stdout || "").split(/\r?\n/).filter((entry) => entry !== "");
  assert.ok(rawEntries.length > 0, "portable ZIP must not be empty");
  const firstEntry = normalizeArchiveEntry(rawEntries[0]);
  const encodedArchiveRoot = firstEntry.split("/")[0];
  const archiveEntries = rawEntries.map((entry) => normalizeArchiveEntry(entry, encodedArchiveRoot));

  const verbose = tar(["-tvf", zip]);
  assertTarSucceeded(verbose, "portable ZIP entry types must be readable");
  const verboseEntries = String(verbose.stdout || "").split(/\r?\n/).filter(Boolean);
  assert.equal(verboseEntries.length, rawEntries.length, "portable ZIP entry listings must agree");
  assert.equal(verboseEntries.every((entry) => /^[d-]/.test(entry)), true, "portable ZIP must contain only regular files and directories");

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-portable-archive-"));
  const cleanupWarnings = [];
  try {
    const extract = tar(["-xf", zip, "-C", temporaryRoot], 120000);
    assertTarSucceeded(extract, "portable ZIP extraction failed");
    const rootEntries = fs.readdirSync(temporaryRoot);
    assert.deepEqual(rootEntries, [productName], `portable ZIP must extract exactly one ${productName} root`);
    const extractedTarget = fs.realpathSync(path.join(temporaryRoot, productName));
    assertRealPathInside(fs.realpathSync(temporaryRoot), extractedTarget, "Extracted portable target");
    const extractedAppDir = path.join(extractedTarget, "resources", "app");
    assert.equal(treeSha256(extractedAppDir), expectedSourceTreeSha256, "ZIP app tree must match the manifest source tree hash");
    assert.equal(treeSha256(extractedTarget), treeSha256(target), "ZIP content must exactly match the staged portable target");
  } finally {
    try {
      removeTemporary(temporaryRoot);
    } catch (error) {
      const warning = `portable ZIP temporary cleanup failed for ${temporaryRoot}: ${error.message}`;
      cleanupWarnings.push(warning);
      warn(warning);
    }
  }
  return { archiveEntries, archiveRoot: encodedArchiveRoot, cleanupWarnings };
}

function main(argv = process.argv.slice(2)) {
const parsedArguments = parsePortableArguments(argv);
const { edition, productName, target, zip } = resolvePortablePaths(parsedArguments);
const resourcesDir = path.join(target, "resources");
const appDir = path.join(resourcesDir, "app");
const executable = path.join(target, `${productName}.exe`);
const helper = path.join(appDir, "rpa", "contact_sync", "xiaoxi-contact-helper.exe");
const CONTACT_HELPER_SHA256 = "f9c90aec8589ac11a93db7acfbc9b3b92c0c9c2a3b9175642829fba2e0f12eeb";
const nativeLibDir = path.join(appDir, "rpa", "contact_sync", "libs");
const nativeLibraryNames = ["wx_key.dll", "msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
const wxKeyDll = path.join(nativeLibDir, "wx_key.dll");
const databaseDecryptor = path.join(nativeLibDir, "xiaoxi-db-decrypt.exe");
const internalAutoReplyCli = path.join(appDir, "rpa", "active_touch", "active_touch_cli.dev.cjs");
const momentsDryRunModule = path.join(appDir, "rpa", "active_touch", "moments_dry_run.dev.cjs");
const momentsNavigation = path.join(appDir, "rpa", "active_touch", "moments_navigation.dev.cjs");
const momentsDryRunCli = path.join(appDir, "rpa", "active_touch", "moments_dry_run_cli.dev.cjs");
const momentsActionModule = path.join(appDir, "rpa", "active_touch", "moments_action.dev.cjs");
const momentsActionCli = path.join(appDir, "rpa", "active_touch", "moments_action_cli.dev.cjs");
const momentsActionDriver = path.join(appDir, "rpa", "active_touch", "moments_action_driver.dev.cjs");
const momentsCommentReadbackProof = path.join(appDir, "rpa", "active_touch", "moments_comment_readback_proof.dev.cjs");
const momentsVisualProbe = path.join(appDir, "rpa", "active_touch", "moments_visual_probe.dev.cjs");
const momentsVisualDryRun = path.join(appDir, "rpa", "active_touch", "moments_visual_dry_run.dev.cjs");
const momentsVisualActionDriver = path.join(appDir, "rpa", "active_touch", "moments_visual_action_driver.dev.cjs");
const visualAutoReplyDriver = path.join(appDir, "rpa", "active_touch", "wechat_auto_reply_visual_driver.dev.cjs");
const visualAutoReplySend = path.join(appDir, "rpa", "active_touch", "wechat_auto_reply_visual_send.dev.cjs");
const momentsActionSelfCheck = path.join(appDir, "rpa", "active_touch", "moments_action.self_check.cjs");
const momentsRuntimeNames = [
  "moments_dry_run.dev.cjs",
  "moments_navigation.dev.cjs",
  "moments_dry_run_cli.dev.cjs",
  "moments_action.dev.cjs",
  "moments_action_cli.dev.cjs",
  "moments_action_driver.dev.cjs",
  "moments_comment_readback_proof.dev.cjs",
  "moments_visual_dry_run.dev.cjs",
  "moments_visual_action_driver.dev.cjs"
];
const visualAutoReplyRuntimeNames = [
  "moments_visual_probe.dev.cjs",
  "wechat_auto_reply_visual_driver.dev.cjs",
  "wechat_auto_reply_visual_send.dev.cjs"
];
const momentsActionSourceMarkers = [
  "moments_test_action",
  "executeMomentsLike",
  "executeMomentsComment",
  "moments_action_driver.dev.cjs"
];
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
const momentsTestVisualSourceMarkers = [
  "MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT",
  "MOMENTS_VISUAL_ACTION_POWERSHELL"
];
const visualAutoReplyReadOnlySourceMarkers = ["Windows.Media.Ocr.OcrEngine"];
const momentsCampaignSourceMarkers = [
  "moments-campaign:start",
  "xiaoxiMomentsCampaign"
];
const momentsCampaignUiMarkers = ["data-xiaoxi-moments-campaign-start"];
const databaseFilePattern = /\.(?:db(?:-wal|-shm)?|sqlite3?)$/i;
const blockedNames = new Set(["python.exe", "dump_data.exe", "wechat-dump-rs.exe", "ai-expert.json", "auto-reply-state.json", "auto-reply-diagnostics.jsonl", "contacts.json", "touch_task.json", "touch_task.json.bak", "run_logs.jsonl", "state.json", "deepseek-api-key.bin"]);

function isBlockedName(name) {
  return blockedNames.has(name) || name === ".env" || name.startsWith(".env.") || name.startsWith("auto-reply-diagnostics.jsonl.") || databaseFilePattern.test(name);
}

function assertNoBlockedFiles(names, label, { targetRoot = null, archiveRoot = null } = {}) {
  assert.equal(Boolean(targetRoot) && Boolean(archiveRoot), false, "blocked-file scan accepts only one trusted root");
  for (const value of names) {
    let normalizedPath;
    if (targetRoot) {
      const relative = path.relative(path.resolve(targetRoot), path.resolve(String(value || "")));
      assert.equal(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), false, `${label} entry is outside its trusted root`);
      normalizedPath = relative.replaceAll("\\", "/").toLowerCase();
    } else {
      normalizedPath = String(value || "").replaceAll("\\", "/").toLowerCase();
    }
    if (!normalizedPath) continue;
    const name = path.posix.basename(normalizedPath);
    assert.equal(isBlockedName(name), false, `${label} must not contain ${name}`);
    assert.equal(name.includes("dt-ai-helper"), false, `${label} must not contain dt-ai-helper`);
    if (name.endsWith(".py")) {
      const allowed = archiveRoot
        ? (
          isProductDetailArchivePythonSource(normalizedPath, archiveRoot)
          || isContentEngineArchivePythonSource(normalizedPath, archiveRoot)
        )
        : (
          isProductDetailPythonSource(normalizedPath)
          || isContentEnginePythonSource(normalizedPath)
        );
      assert.equal(
        allowed,
        true,
        `${label} may contain Python dependency sources only inside pinned sidecar runtimes`
      );
    }
  }
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

assert.equal(fs.existsSync(executable), true, "portable executable must exist");
assert.equal(fs.existsSync(zip), true, "portable ZIP must exist");
assert.equal(fs.existsSync(helper), true, "contact helper must be packaged");
assert.equal(fs.existsSync(wxKeyDll), true, "authorized wx_key.dll must be packaged");
assert.equal(fs.existsSync(databaseDecryptor), true, "database decryptor must be packaged");
const manifest = JSON.parse(fs.readFileSync(path.join(target, "版本清单.json"), "utf8"));
const declaredCapabilities = JSON.parse(fs.readFileSync(path.join(desktopDir, "release-capabilities.json"), "utf8"));
assert.equal(manifest.edition, edition);
assert.equal(manifest.product, "AI获客");
assert.match(manifest.buildId, /^\d{8}T\d{4}Z$/, "portable release must expose an unambiguous build id");
assert.equal(manifest.architecture, "x64");
assert.equal(manifest.releaseStage, "wechat-4.1.11.54-stabilization");
assert.deepEqual(manifest.targetWeixin, ["4.1.11.54"]);
assert.deepEqual(manifest.capabilityMatrix, declaredCapabilities.capabilities, "portable manifest must match the single source capability matrix");
assert.equal(manifest.capabilityMatrix?.contactSync?.implementation, "implemented");
assert.equal(manifest.capabilityMatrix?.autoReply?.localLiveVerification, "verified");
assert.equal(manifest.capabilityMatrix?.activeTouch?.localLiveVerification, "verified");
assert.equal(manifest.capabilityMatrix?.moments?.implementation, "implemented");
assert.equal(manifest.capabilityMatrix?.moments?.localLiveVerification, "partial");
assert.equal(manifest.capabilityMatrix?.moments?.workflows?.perPostInteraction?.localLiveVerification, "verified");
assert.equal(manifest.capabilityMatrix?.moments?.workflows?.dailyAutomation?.localLiveVerification, "pending");
assert.deepEqual(manifest.capabilityMatrix?.moments?.packagedEditions, ["test", "delivery"]);
assert.equal(manifest.verifiedWeixin, undefined, "a global verified version list must not overclaim every capability");
assert.equal(manifest.commercialReady, false);
assert.equal(manifest.dirty, false, "portable release must come from a clean worktree");
assert.match(manifest.commit, /^[0-9a-f]{40}$/, "portable release must record a full git commit");
assert.match(manifest.sourceTreeSha256, /^[0-9a-f]{64}$/, "portable release must record the packaged source tree hash");
assert.equal(treeSha256(appDir), manifest.sourceTreeSha256, "packaged app tree must match the manifest source tree hash");
assert.equal(manifest.productDetailSidecar?.buildCommit, manifest.commit, "product-detail runtime must be pinned to the portable release commit");
assert.equal(manifest.productDetailSidecar?.desktopSourceCommit, manifest.commit, "product-detail desktop source must match the portable release commit");
assert.equal(manifest.productDetailSidecar?.desktopSourceDirty, false, "product-detail runtime must come from clean desktop source");
assert.equal(manifest.contentEngineSidecar?.buildCommit, manifest.commit, "content-engine runtime must be pinned to the portable release commit");
assert.equal(manifest.contentEngineSidecar?.sourceCommit, manifest.commit, "content-engine source must match the portable release commit");
assert.equal(manifest.contentEngineSidecar?.sourceDirty, false, "content-engine runtime must come from a clean source tree");
const releaseLabel = fs.readFileSync(path.join(target, "版本标识.txt"), "utf8");
assert.equal(releaseLabel.includes("朋友圈逐帖互动已"), true);
assert.equal(releaseLabel.includes("每日自动计划"), true);
assert.equal(edition !== "delivery" || releaseLabel.includes("capabilityMatrix"), true);
assert.equal(edition !== "delivery" || releaseLabel.includes("本包不代表完整商品"), true);
const firstUseGuide = fs.readFileSync(path.join(target, "首次使用说明.txt"), "utf8");
assert.equal(firstUseGuide.includes(manifest.buildId), true);
assert.equal(firstUseGuide.includes("不要只复制 EXE"), true);
assert.equal(firstUseGuide.includes("重新配置 API 密钥、导入 AI 专家话术并同步联系人"), true);
assert.equal(manifest.contactHelperSha256, CONTACT_HELPER_SHA256, "manifest must pin the approved contact helper");
assert.equal(sha256(helper), CONTACT_HELPER_SHA256, "packaged helper must match the approved hash");
assert.equal(sha256(helper), manifest.contactHelperSha256, "packaged helper hash must match the manifest");
assert.equal(sha256(wxKeyDll), manifest.wxKeySha256, "packaged wx_key.dll hash must match the manifest");
assert.equal(sha256(databaseDecryptor), manifest.databaseDecryptorSha256, "packaged database decryptor hash must match the manifest");
assert.deepEqual(Object.keys(manifest.nativeLibrarySha256 || {}).sort(), [...nativeLibraryNames].sort(), "manifest must list every wx_key.dll native dependency");
for (const name of nativeLibraryNames) {
  const file = path.join(nativeLibDir, name);
  assert.equal(fs.existsSync(file), true, `${name} must be packaged beside wx_key.dll`);
  assert.equal(sha256(file), manifest.nativeLibrarySha256[name], `${name} hash must match the manifest`);
}

const files = [];
function walk(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) walk(file);
    else files.push(file);
  }
}
walk(target);
assertNoBlockedFiles(files, "release", { targetRoot: target });

const { archiveEntries, archiveRoot } = verifyPortableArchive({
  zip,
  target,
  productName,
  expectedSourceTreeSha256: manifest.sourceTreeSha256
});
assertNoBlockedFiles(archiveEntries, "portable ZIP", { archiveRoot });
assert.equal(
  archiveEntries.some((entry) => entry.replaceAll("\\", "/").endsWith(`/${PRODUCT_DETAIL_RELEASE_PATH}/${PRODUCT_DETAIL_EXECUTABLE}`)),
  true,
  "portable ZIP must contain the product-detail executable at the runtime root"
);
assert.equal(
  archiveEntries.some((entry) => entry.replaceAll("\\", "/").endsWith(`/${CONTENT_ENGINE_RELEASE_PATH}/${CONTENT_ENGINE_EXECUTABLE}`)),
  true,
  "portable ZIP must contain the content-engine executable at the runtime root"
);
for (const name of momentsRuntimeNames) {
  assert.equal(archiveEntries.some((entry) => entry.replaceAll("\\", "/").endsWith(`/rpa/active_touch/${name}`)), true, `${name} must be present in every portable ZIP`);
}
for (const name of visualAutoReplyRuntimeNames) {
  assert.equal(archiveEntries.some((entry) => entry.replaceAll("\\", "/").endsWith(`/rpa/active_touch/${name}`)), true, `${name} must be present in every portable ZIP`);
}
assert.equal(archiveEntries.some((entry) => entry.replaceAll("\\", "/").endsWith("/rpa/active_touch/moments_action.self_check.cjs")), false, "Moments action self-check must not be packaged");
for (const name of [
  "wechat_auto_reply_visual_driver.self_check.cjs",
  "wechat_auto_reply_visual_send.self_check.cjs"
]) {
  assert.equal(archiveEntries.some((entry) => entry.replaceAll("\\", "/").endsWith(`/rpa/active_touch/${name}`)), false, `${name} must not be packaged`);
}

const helperCheck = spawnSync(helper, ["self-check"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
assert.equal(helperCheck.status, 0, helperCheck.stderr || helperCheck.stdout || "packaged helper self-check failed");
const helperPayload = JSON.parse(helperCheck.stdout.trim());
assert.equal(helperPayload.ok, true, "packaged helper self-check must return ok");
assert.equal(helperPayload.wx_key_lifecycle, "hook-resume-poll-cleanup", "packaged helper must install the hook before WeChat login can continue");

const wxKeyHelp = spawnSync(helper, ["wx-key", "--help"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
assert.equal(wxKeyHelp.status, 0, wxKeyHelp.stderr || wxKeyHelp.stdout || "packaged helper wx-key command failed");
assert.equal(wxKeyHelp.stdout.includes("--exe"), true, "packaged helper must own WeChat launch before hook capture");

const wxKeyLoad = spawnSync(helper, ["wx-key", "--dll", wxKeyDll, "--load-only"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
assert.equal(wxKeyLoad.status, 0, wxKeyLoad.stderr || wxKeyLoad.stdout || "packaged wx_key.dll failed to load");
assert.equal(JSON.parse(wxKeyLoad.stdout.trim()).stage, "dll_loaded", "packaged wx_key.dll load check must succeed");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-portable-self-check-"));
try {
  const productDetailPayload = runPackagedProductDetailSelfCheck({
    releaseTarget: target,
    resourcesDir,
    descriptor: manifest.productDetailSidecar,
    dataDir: path.join(tempDir, "product-detail")
  });
  assert.equal(productDetailPayload.version, manifest.productDetailSidecar.version);

  const contentEngineSession = runPackagedContentEngineSelfCheck({
    releaseTarget: target,
    resourcesDir,
    descriptor: manifest.contentEngineSidecar,
    dataDir: path.join(tempDir, "content-engine")
  });
  assert.equal(contentEngineSession.ready.version, manifest.contentEngineSidecar.version);

  const contactSyncDir = path.join(tempDir, "contact_sync");
  const activeTouchDir = path.join(tempDir, "active_touch");
  fs.mkdirSync(contactSyncDir, { recursive: true });
  fs.mkdirSync(activeTouchDir, { recursive: true });
  const contactCli = path.join(appDir, "rpa", "contact_sync", "contact_sync_cli.cjs");
  const status = spawnSync(executable, [contactCli, "status", "--data-dir", contactSyncDir, "--active-touch-dir", activeTouchDir], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });
  assert.equal(status.status, 0, status.stderr || status.stdout || "packaged contact-sync status failed");
  const payload = JSON.parse(status.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.state?.helper_configured, true, "packaged runtime must discover the bundled helper");

  const activeTouchStatus = spawnSync(executable, [internalAutoReplyCli, "status", "--data-dir", activeTouchDir], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
  });
  assert.equal(activeTouchStatus.status, 0, activeTouchStatus.stderr || activeTouchStatus.stdout || "packaged auto-reply executor status failed");
  const activeTouchPayload = JSON.parse(activeTouchStatus.stdout.trim());
  assert.equal(activeTouchPayload.ok, true, "packaged auto-reply executor must start successfully");
  assert.equal(activeTouchPayload.action, "status", "packaged auto-reply executor must run the requested command");

  {
    const momentsDataDir = path.join(tempDir, "moments");
    const moments = spawnSync(executable, [momentsDryRunCli, "moments-dry-run", "--mode", "targeted", "--like", "--data-dir", momentsDataDir], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    assert.equal([0, 1].includes(moments.status), true, moments.stderr || moments.stdout || "packaged Moments dry-run failed to return");
    const momentsPayload = JSON.parse(moments.stdout.trim());
    assert.equal(momentsPayload.action, "moments-dry-run");
    assert.equal(momentsPayload.dry_run, true);
    assert.equal(momentsPayload.real_action_attempted, false);
    if (!momentsPayload.ok) {
      const safeBlockedReasons = [
        "moments_window_not_found",
        "moments_window_ambiguous",
        "moments_window_identity_mismatch",
        "moments_feed_not_found",
        "moments_post_not_found",
        "moments_post_ambiguous",
        "moments_post_changed",
        "moments_post_identity_missing",
        "moments_visual_profile_conflict",
        "moments_post_position_unsafe",
        "moments_render_pane_not_found",
        "moments_render_pane_ambiguous",
        "moments_render_pane_bounds_invalid",
        "moments_window_not_foreground",
        "moments_window_obscured",
        "moments_visual_capture_failed",
        "moments_visual_ocr_unavailable",
        "moments_visual_ocr_failed"
      ];
      assert.equal(safeBlockedReasons.includes(momentsPayload.blocked_reason), true, "packaged Moments probe must not hide execution failures");
    }
    assert.equal(fs.existsSync(path.join(momentsDataDir, "state.json")), true, "packaged Moments dry-run must persist its result");

    const momentsAction = spawnSync(executable, [momentsActionCli, "moments-inspect-menu", "--observation-id", "invalid", "--data-dir", momentsDataDir], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    assert.equal([0, 1].includes(momentsAction.status), true, momentsAction.stderr || momentsAction.stdout || "packaged Moments action CLI failed to return");
    const momentsActionPayload = JSON.parse(momentsAction.stdout.trim());
    assert.equal(momentsActionPayload.action, "moments-menu-inspect");
    assert.equal(momentsActionPayload.real_action_attempted, false, "invalid packaged action probe must not touch WeChat");
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const mainDir = path.join(appDir, "src", "main");
const packagedMammoth = path.join(appDir, "node_modules", "mammoth");
assert.equal(fs.existsSync(path.join(packagedMammoth, "package.json")), true, "Mammoth must be packaged for .docx AI expert imports");
assert.equal(typeof require(packagedMammoth).extractRawText, "function", "packaged Mammoth dependency tree must be loadable");
assert.equal(fs.existsSync(path.join(mainDir, "active-touch-dev-ipc.cjs")), edition === "test");
assert.equal(fs.existsSync(path.join(mainDir, "preload.dev.cjs")), edition === "test");
assert.equal(fs.readFileSync(path.join(mainDir, "preload.cjs"), "utf8").includes("sendReal"), false);
assert.equal(fs.readFileSync(path.join(mainDir, "preload.cjs"), "utf8").includes("xiaoxiActiveTouch"), false, "delivery preload must not expose development active-touch APIs");
assert.equal(fs.readFileSync(path.join(mainDir, "preload-api.cjs"), "utf8").includes("active-touch:"), false, "shared preload API must not contain development active-touch channels");
assert.equal(fs.readFileSync(path.join(mainDir, "active-touch-ipc.cjs"), "utf8").includes("ipcMain.handle"), false, "delivery runtime must not register development active-touch IPC");
const activeDir = path.join(appDir, "rpa", "active_touch");
assert.equal(fs.existsSync(path.join(activeDir, "state_machine.dev.cjs")), true);
assert.equal(fs.existsSync(path.join(activeDir, "wechat_window_driver.dev.cjs")), true);
assert.equal(fs.existsSync(momentsNavigation), true);
assert.equal(fs.existsSync(momentsDryRunModule), true);
assert.equal(fs.existsSync(momentsDryRunCli), true);
assert.equal(fs.existsSync(momentsActionModule), true);
assert.equal(fs.existsSync(momentsActionCli), true);
assert.equal(fs.existsSync(momentsActionDriver), true);
assert.equal(fs.existsSync(momentsCommentReadbackProof), true);
assert.equal(fs.existsSync(momentsVisualProbe), true);
assert.equal(fs.existsSync(momentsVisualDryRun), true);
assert.equal(fs.existsSync(momentsVisualActionDriver), true);
assert.equal(fs.existsSync(visualAutoReplyDriver), true);
assert.equal(fs.existsSync(visualAutoReplySend), true);
assert.equal(fs.existsSync(momentsActionSelfCheck), false, "Moments action self-check must not be packaged");
const activeTouchSources = fs.readdirSync(activeDir)
  .filter((name) => name.endsWith(".cjs"))
  .map((name) => fs.readFileSync(path.join(activeDir, name), "utf8"))
  .join("\n");
const mainSources = fs.readdirSync(mainDir)
  .filter((name) => name.endsWith(".cjs"))
  .map((name) => fs.readFileSync(path.join(mainDir, name), "utf8"))
  .join("\n");
const packagedSources = `${mainSources}\n${activeTouchSources}`;
assert.equal(activeTouchSources.includes("moments-dry-run"), true, "every package must contain the Moments dry-run command used by the campaign");
assert.equal(activeTouchSources.includes("sns_list"), true, "every package must contain the Moments post probe used by the campaign");
for (const marker of momentsActionSourceMarkers) {
  assert.equal(packagedSources.includes(marker), true, `every edition must contain ${marker}`);
}
for (const marker of momentsTestVisualSourceMarkers) {
  assert.equal(packagedSources.includes(marker), true, `every edition must contain ${marker}`);
}
for (const marker of visualAutoReplyReadOnlySourceMarkers) {
  assert.equal(packagedSources.includes(marker), true, `every edition must contain the read-only visual auto-reply dependency ${marker}`);
}
const renderer = fs.readdirSync(path.join(appDir, "dist", "assets"))
  .filter((name) => /\.(?:css|js)$/.test(name))
  .map((name) => fs.readFileSync(path.join(appDir, "dist", "assets", name), "utf8"))
  .join("\n");
assert.equal(renderer.includes("内部测试"), edition === "test");
assert.equal(renderer.includes(edition === "test" ? "测试版" : "交付版"), edition === "test");
for (const marker of momentsCampaignSourceMarkers) {
  assert.equal(packagedSources.includes(marker), true, `every edition must contain campaign source marker ${marker}`);
}
for (const marker of momentsCampaignUiMarkers) {
  assert.equal(renderer.includes(marker), true, `every edition must contain campaign UI marker ${marker}`);
}
for (const marker of momentsActionIpcMarkers) {
  assert.equal(packagedSources.includes(marker), edition === "test", `only test-edition source may contain ${marker}`);
}
for (const marker of momentsActionUiMarkers) {
  assert.equal(renderer.includes(marker), edition === "test", `only the test renderer may contain ${marker}`);
}
if (edition === "delivery") {
  for (const marker of momentsActionIpcMarkers) assert.equal(packagedSources.includes(marker), false, `delivery source must not contain ${marker}`);
  for (const marker of momentsActionUiMarkers) assert.equal(renderer.includes(marker), false, `delivery renderer must not contain ${marker}`);
}
console.log(`${edition} portable release self-check passed`);
}

if (require.main === module) main();

module.exports = {
  main,
  normalizeArchiveEntry,
  parsePortableArguments,
  resolvePortablePaths,
  verifyPortableArchive
};
