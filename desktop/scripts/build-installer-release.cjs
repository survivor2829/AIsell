const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { sha256, treeSha256 } = require("./release-tree-hash.cjs");
const { verifyPackagedRemotionRuntime } = require("./build-remotion-runtime.cjs");
const { verifyReleaseTrustRecord } = require("./release-trust-record.cjs");

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

function assertInstallerSource(edition = "delivery", environment = process.env) {
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
  const portableAppDir = path.join(portableDir, "resources", "app");
  if (!portableManifest.sourceTreeSha256 || treeSha256(portableAppDir) !== portableManifest.sourceTreeSha256) {
    throw new Error("Portable application source tree does not match its version manifest");
  }
  verifyPackagedRemotionRuntime(portableDir, portableManifest.remotionRuntime);
  const portableCommit = String(portableManifest.commit || "").trim();
  let reusedInstallerOnlyPaths = [];
  if (portableCommit !== commit) {
    if (target.edition !== "test") {
      throw new Error("Portable build commit does not match the current clean commit");
    }
    reusedInstallerOnlyPaths = assertTestPortableReuse(portableCommit, commit);
  }
  if (!target.requiresCommercialTrust) {
    return { commit, portableCommit, portableDir, portableManifest, target, reusedInstallerOnlyPaths, releaseTrust: null };
  }
  if (portableManifest.remotionRuntime?.commercialLicenseConfirmed !== true) {
    throw new Error("Installer source lacks a confirmed Remotion commercial license basis");
  }
  const releaseTrust = verifyReleaseTrustRecord({
    environment,
    portableManifest,
    portableManifestSha256: sha256(portableManifestFile),
    portableTreeSha256: treeSha256(portableDir),
    product: PRODUCT_NAME,
    releaseDir
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

function buildInstaller(edition = "delivery") {
  const { commit, portableCommit, portableDir, portableManifest, target, reusedInstallerOnlyPaths, releaseTrust } = assertInstallerSource(edition);
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
  buildInstaller,
  installerManifestName,
  installerName,
  replaceCanonicalFile,
  resolveInstallerTarget
};
