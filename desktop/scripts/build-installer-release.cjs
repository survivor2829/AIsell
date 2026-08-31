const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { sha256, treeSha256 } = require("./release-tree-hash.cjs");
const { verifyPackagedRemotionRuntime } = require("./build-remotion-runtime.cjs");
const { verifyReleaseTrustRecord } = require("./release-trust-record.cjs");
const {
  runPackagedProductDetailReleaseGate
} = require("./product-detail-release-runtime.cjs");

const desktopDir = path.resolve(__dirname, "..");
const projectDir = path.resolve(desktopDir, "..");
const releaseDir = path.join(projectDir, "release");
const productBrand = require("../product-brand.json");
const installerTargets = require("../installer-targets.json");
const PRODUCT_NAME = productBrand.displayName;
const installerName = `${PRODUCT_NAME}-安装程序.exe`;
const installerManifestName = `${PRODUCT_NAME}-安装程序-版本清单.json`;
const TEST_PORTABLE_REUSE_PATHS = new Set([
  "desktop/build/installer-test.nsh",
  "desktop/electron-builder-test-installer.yml",
  "desktop/installer-targets.json",
  "desktop/scripts/build-installer-release.cjs",
  "desktop/scripts/installer-release.self_check.cjs"
]);
const ELECTRON_BUILDER_ELEVATE_HELPER = "resources/elevate.exe";

function resolveInstallerTarget(edition = "delivery") {
  if (edition === "delivery") {
    return {
      edition,
      artifactType: "delivery",
      productName: PRODUCT_NAME,
      installerName,
      installerManifestName,
      configFile: "electron-builder-installer.yml",
      appId: productBrand.stableAppId,
      installDirectoryName: productBrand.stableInstallDirectoryName,
      dataDirectoryName: productBrand.stableDeliveryDataDirectoryName,
      requiresCommercialTrust: true
    };
  }
  if (edition === "test") {
    const testTarget = installerTargets.test;
    if (!testTarget?.appId || !testTarget?.installDirectoryName || !testTarget?.dataDirectoryName) {
      throw new Error("Test installer target configuration is incomplete");
    }
    const productName = `${PRODUCT_NAME}-测试版`;
    return {
      edition,
      artifactType: "internal-evaluation",
      productName,
      installerName: `${productName}-安装程序.exe`,
      installerManifestName: `${productName}-安装程序-版本清单.json`,
      configFile: "electron-builder-test-installer.yml",
      appId: testTarget.appId,
      installDirectoryName: testTarget.installDirectoryName,
      dataDirectoryName: testTarget.dataDirectoryName,
      requiresCommercialTrust: false
    };
  }
  throw new Error(`Unsupported installer edition: ${edition}`);
}

function gitText(args) {
  const result = spawnSync("git", args, {
    cwd: projectDir,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function assertTestPortableReuse(portableCommit, currentCommit) {
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", portableCommit, currentCommit], {
    cwd: projectDir,
    encoding: "utf8",
    windowsHide: true
  });
  if (ancestry.status !== 0) {
    throw new Error("Test portable commit is not an ancestor of the installer build commit");
  }
  const changedPaths = gitText(["diff", "--name-only", `${portableCommit}..${currentCommit}`])
    .split(/\r?\n/u)
    .filter(Boolean);
  const unexpectedPaths = changedPaths.filter((file) => !TEST_PORTABLE_REUSE_PATHS.has(file));
  if (unexpectedPaths.length) {
    throw new Error(`Test portable must be rebuilt after application changes:\n${unexpectedPaths.join("\n")}`);
  }
  return changedPaths;
}

function assertPortableAppTreeMatchesManifest({ portableManifest, releaseTarget } = {}) {
  const expectedHash = String(portableManifest?.sourceTreeSha256 || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw new Error("Verified portable app tree hash is missing");
  }
  const appDir = path.join(releaseTarget, "resources", "app");
  if (!fs.existsSync(appDir) || !fs.statSync(appDir).isDirectory()) {
    throw new Error("Verified portable application tree is missing");
  }
  if (treeSha256(appDir) !== expectedHash) {
    throw new Error("Verified portable application tree does not match its manifest");
  }
  return appDir;
}

function installerArchiveTool() {
  try {
    return require.resolve("electron-winstaller/vendor/7z.exe");
  } catch {
    throw new Error("Installer archive verifier is unavailable");
  }
}

function extractInstallerArchive({ archiveTool, archive, destination, spawn = spawnSync }) {
  const result = spawn(archiveTool, ["x", "-y", `-o${destination}`, archive], {
    cwd: path.dirname(archive),
    encoding: "utf8",
    windowsHide: true,
    timeout: 240_000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || result.stdout || `Failed to extract ${path.basename(archive)}`);
  }
}

function releaseTreeEntries(root) {
  const absoluteRoot = path.resolve(root);
  const entries = new Map();
  const visit = (current) => {
    const children = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const child of children) {
      const absolute = path.join(current, child.name);
      const relative = path.relative(absoluteRoot, absolute).replaceAll("\\", "/");
      if (child.isDirectory()) {
        entries.set(relative, { kind: "directory" });
        visit(absolute);
      } else if (child.isFile()) {
        entries.set(relative, {
          kind: "file",
          size: fs.statSync(absolute).size,
          sha256: sha256(absolute)
        });
      } else {
        throw new Error(`Unsupported installer payload entry: ${relative}`);
      }
    }
  };
  visit(absoluteRoot);
  return entries;
}

function assertInstallerInputMatchesPortable({ portableTarget, installerInput } = {}) {
  const expectedEntries = releaseTreeEntries(portableTarget);
  const actualEntries = releaseTreeEntries(installerInput);
  const extraElevateHelper = actualEntries.get(ELECTRON_BUILDER_ELEVATE_HELPER);
  if (!expectedEntries.has(ELECTRON_BUILDER_ELEVATE_HELPER) && extraElevateHelper) {
    if (extraElevateHelper.kind !== "file") {
      throw new Error("Installer payload has an invalid Electron Builder elevate helper");
    }
    actualEntries.delete(ELECTRON_BUILDER_ELEVATE_HELPER);
  }
  const paths = new Set([...expectedEntries.keys(), ...actualEntries.keys()]);
  for (const relative of paths) {
    const expected = expectedEntries.get(relative);
    const actual = actualEntries.get(relative);
    if (!expected || !actual || expected.kind !== actual.kind) {
      throw new Error(`Installer payload differs from the verified portable application at ${relative}`);
    }
    if (
      expected.kind === "file"
      && (expected.size !== actual.size || expected.sha256 !== actual.sha256)
    ) {
      throw new Error(`Installer payload differs from the verified portable application at ${relative}`);
    }
  }
}

function verifyInstallerPayload({
  installerFile,
  portableManifest,
  expectedPayloadTreeHash,
  productName = PRODUCT_NAME,
  releaseGate = runPackagedProductDetailReleaseGate,
  archiveTool = installerArchiveTool(),
  spawn = spawnSync
} = {}) {
  const expectedHash = String(expectedPayloadTreeHash || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw new Error("Installer verification requires the packed payload tree hash");
  }
  if (!fs.existsSync(installerFile) || !fs.statSync(installerFile).isFile()) {
    throw new Error("Installer payload is missing");
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-installer-verify-"));
  const installerContentsDir = path.join(tempDir, "installer-contents");
  const extractedTarget = path.join(tempDir, "installed-app");
  try {
    fs.mkdirSync(installerContentsDir, { recursive: false });
    fs.mkdirSync(extractedTarget, { recursive: false });
    extractInstallerArchive({
      archiveTool,
      archive: installerFile,
      destination: installerContentsDir,
      spawn
    });
    const appArchive = path.join(installerContentsDir, "$PLUGINSDIR", "app-64.7z");
    if (!fs.existsSync(appArchive) || !fs.statSync(appArchive).isFile()) {
      throw new Error("Installer payload is missing the packaged application archive");
    }
    extractInstallerArchive({
      archiveTool,
      archive: appArchive,
      destination: extractedTarget,
      spawn
    });
    if (treeSha256(extractedTarget) !== expectedHash) {
      throw new Error("Installer payload differs from the packed installer input");
    }
    const extractedManifestFile = path.join(extractedTarget, "版本清单.json");
    const extractedManifest = JSON.parse(fs.readFileSync(extractedManifestFile, "utf8"));
    assert.deepEqual(
      extractedManifest,
      portableManifest,
      "Installer payload version manifest does not match the verified portable manifest"
    );
    assertPortableAppTreeMatchesManifest({
      portableManifest,
      releaseTarget: extractedTarget
    });
    releaseGate({
      releaseTarget: extractedTarget,
      resourcesDir: path.join(extractedTarget, "resources"),
      descriptor: portableManifest.productDetailSidecar,
      electronExecutable: path.join(extractedTarget, `${productName}.exe`),
      dataDir: path.join(tempDir, "product-detail-gate")
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function verifyPortableProductDetailRuntime({
  portableManifest,
  releaseTarget,
  productName = PRODUCT_NAME,
  runReleaseGate = runPackagedProductDetailReleaseGate
} = {}) {
  const descriptor = portableManifest?.productDetailSidecar;
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error("Verified portable product-detail descriptor is missing");
  }
  const resourcesDir = path.join(releaseTarget, "resources");
  const electronExecutable = path.join(releaseTarget, `${productName}.exe`);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-installer-product-detail-"));
  try {
    runReleaseGate({
      releaseTarget,
      resourcesDir,
      descriptor,
      electronExecutable,
      dataDir: path.join(tempDir, "product-detail-gate")
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertInstallerSource(edition = "delivery", environment = process.env, {
  verifyProductDetailRuntime = verifyPortableProductDetailRuntime
} = {}) {
  const target = resolveInstallerTarget(edition);
  const portableDir = path.join(releaseDir, target.productName);
  const portableManifestFile = path.join(portableDir, "版本清单.json");
  const commit = gitText(["rev-parse", "HEAD"]);
  if (gitText(["status", "--porcelain"])) {
    throw new Error("Refusing to build an installer from a dirty worktree");
  }
  if (!fs.existsSync(path.join(portableDir, `${target.productName}.exe`))) {
    throw new Error("Verified portable application is missing; build it first");
  }
  if (!fs.existsSync(portableManifestFile)) {
    throw new Error("Portable version manifest is missing");
  }
  const portableManifest = JSON.parse(fs.readFileSync(portableManifestFile, "utf8"));
  if (portableManifest.edition !== target.edition || portableManifest.artifactType !== target.artifactType || portableManifest.dirty !== false) {
    throw new Error(`Installer source must be a clean ${target.edition} portable build`);
  }
  if (portableManifest.remotionRuntime?.compositionSmokeStatus !== "passed") {
    throw new Error("Installer source lacks the explicit-browser Remotion composition smoke proof");
  }
  assertPortableAppTreeMatchesManifest({ portableManifest, releaseTarget: portableDir });
  const portableCommit = String(portableManifest.commit || "").trim();
  let reusedInstallerOnlyPaths = [];
  if (portableCommit !== commit) {
    if (target.edition !== "test") {
      throw new Error("Portable build commit does not match the current clean commit");
    }
    reusedInstallerOnlyPaths = assertTestPortableReuse(portableCommit, commit);
  }
  let releaseTrust = null;
  if (target.requiresCommercialTrust) {
    if (portableManifest.remotionRuntime?.commercialLicenseConfirmed !== true) {
      throw new Error("Installer source lacks a confirmed Remotion commercial license basis");
    }
    releaseTrust = verifyReleaseTrustRecord({
      environment,
      portableManifest,
      portableManifestSha256: sha256(portableManifestFile),
      portableTreeSha256: treeSha256(portableDir),
      product: PRODUCT_NAME,
      releaseDir
    });
  }
  verifyPackagedRemotionRuntime(portableDir, portableManifest.remotionRuntime);
  verifyProductDetailRuntime({
    portableManifest,
    releaseTarget: portableDir,
    productName: target.productName
  });
  return { commit, portableCommit, portableDir, portableManifest, target, reusedInstallerOnlyPaths, releaseTrust };
}

function replaceCanonicalFile(staged, canonical) {
  const backup = `${canonical}.backup-${process.pid}-${Date.now()}`;
  let backedUp = false;
  try {
    if (fs.existsSync(canonical)) {
      fs.renameSync(canonical, backup);
      backedUp = true;
    }
    fs.renameSync(staged, canonical);
  } catch (error) {
    if (backedUp && fs.existsSync(backup) && !fs.existsSync(canonical)) {
      fs.renameSync(backup, canonical);
    }
    throw error;
  }
  return backedUp ? backup : null;
}

function buildInstaller(edition = "delivery", options = {}) {
  const { commit, portableCommit, portableDir, portableManifest, target, reusedInstallerOnlyPaths, releaseTrust } = assertInstallerSource(
    edition,
    process.env,
    options
  );
  const portableTreeHash = releaseTrust?.portableTreeSha256 || treeSha256(portableDir);
  const transactionId = `${process.pid}-${Date.now()}`;
  const stagingDir = path.join(releaseDir, `.installer-staging-${transactionId}`);
  const installerInputDir = path.join(stagingDir, "portable-input");
  const stagedInstaller = path.join(stagingDir, target.installerName);
  const stagedManifest = path.join(stagingDir, target.installerManifestName);
  const canonicalInstaller = path.join(releaseDir, target.installerName);
  const canonicalManifest = path.join(releaseDir, target.installerManifestName);
  fs.mkdirSync(stagingDir, { recursive: false });

  try {
    fs.cpSync(portableDir, installerInputDir, { recursive: true, errorOnExist: true });
    const stagedAppDir = path.join(installerInputDir, "resources", "app");
    if (treeSha256(installerInputDir) !== portableTreeHash) {
      throw new Error("Installer input does not match the verified portable application");
    }
    if (treeSha256(stagedAppDir) !== portableManifest.sourceTreeSha256) {
      throw new Error("Installer input source tree does not match the portable version manifest");
    }
    verifyPackagedRemotionRuntime(installerInputDir, portableManifest.remotionRuntime);
    const builder = require.resolve("electron-builder/out/cli/cli.js");
    const result = spawnSync(process.execPath, [
      builder,
      "--win",
      "nsis",
      "--x64",
      "--prepackaged",
      installerInputDir,
      "--config",
      path.join(desktopDir, target.configFile),
      `--config.directories.output=${stagingDir}`
    ], {
      cwd: desktopDir,
      encoding: "utf8",
      windowsHide: true,
      timeout: 600000,
      env: {
        ...process.env,
        CSC_IDENTITY_AUTO_DISCOVERY: "false"
      }
    });
    if (treeSha256(portableDir) !== portableTreeHash) {
      throw new Error("Portable application changed while building the installer");
    }
    if (result.status !== 0 || !fs.existsSync(stagedInstaller)) {
      throw new Error(result.error?.message || result.stderr || result.stdout || "Installer build failed");
    }
    const size = fs.statSync(stagedInstaller).size;
    if (size < 20 * 1024 * 1024) throw new Error("Installer is unexpectedly small");
    assertInstallerInputMatchesPortable({
      portableTarget: portableDir,
      installerInput: installerInputDir
    });
    verifyInstallerPayload({
      installerFile: stagedInstaller,
      portableManifest,
      expectedPayloadTreeHash: treeSha256(installerInputDir),
      productName: target.productName
    });

    const installerManifest = {
      product: PRODUCT_NAME,
      edition: target.edition,
      artifact: target.installerName,
      artifactType: target.artifactType,
      version: portableManifest.version,
      buildId: portableManifest.buildId,
      commit: portableCommit,
      installerBuildCommit: commit,
      architecture: "x64",
      installationScope: "current-user",
      appId: target.appId,
      installDirectory: `%LOCALAPPDATA%\\Programs\\${target.installDirectoryName}`,
      userDataDirectory: `%APPDATA%\\${target.dataDirectoryName}\\data`,
      upgradeMode: "offline-full-overwrite",
      uninstallPreservesUserData: true,
      signed: false,
      commercialReady: target.requiresCommercialTrust,
      ...(reusedInstallerOnlyPaths.length ? { reusedInstallerOnlyPaths } : {}),
      ...(releaseTrust ? { sourceTrust: releaseTrust } : {}),
      remotionRuntimeManifestSha256: portableManifest.remotionRuntime.manifestSha256,
      sha256: sha256(stagedInstaller),
      size,
      builtAt: new Date().toISOString()
    };
    fs.writeFileSync(stagedManifest, `${JSON.stringify(installerManifest, null, 2)}\n`, "utf8");

    const retainedBackups = [
      replaceCanonicalFile(stagedInstaller, canonicalInstaller),
      replaceCanonicalFile(stagedManifest, canonicalManifest)
    ].filter(Boolean);
    for (const backup of retainedBackups) console.warn(`installer rollback artifact retained: ${backup}`);
    console.log(`${target.edition} installer built: ${canonicalInstaller}`);
    console.log(`sha256: ${installerManifest.sha256}`);
    return { installer: canonicalInstaller, manifest: canonicalManifest, installerManifest, retainedBackups };
  } finally {
    if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

if (require.main === module) buildInstaller(process.argv[2] || "delivery");

module.exports = {
  assertInstallerSource,
  assertPortableAppTreeMatchesManifest,
  assertInstallerInputMatchesPortable,
  buildInstaller,
  extractInstallerArchive,
  installerManifestName,
  installerName,
  replaceCanonicalFile,
  resolveInstallerTarget,
  verifyInstallerPayload,
  verifyPortableProductDetailRuntime
};
