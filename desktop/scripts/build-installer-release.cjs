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
const PRODUCT_NAME = productBrand.displayName;
const portableDir = path.join(releaseDir, PRODUCT_NAME);
const portableManifestFile = path.join(portableDir, "版本清单.json");
const installerName = `${PRODUCT_NAME}-安装程序.exe`;
const installerManifestName = `${PRODUCT_NAME}-安装程序-版本清单.json`;

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

function assertInstallerSource(environment = process.env) {
  const commit = gitText(["rev-parse", "HEAD"]);
  if (gitText(["status", "--porcelain"])) {
    throw new Error("Refusing to build an installer from a dirty worktree");
  }
  if (!fs.existsSync(path.join(portableDir, `${PRODUCT_NAME}.exe`))) {
    throw new Error("Verified portable application is missing; build it first");
  }
  if (!fs.existsSync(portableManifestFile)) {
    throw new Error("Portable version manifest is missing");
  }
  const portableManifest = JSON.parse(fs.readFileSync(portableManifestFile, "utf8"));
  if (
    portableManifest.edition !== "delivery"
    || portableManifest.artifactType !== "delivery"
    || portableManifest.dirty !== false
  ) {
    throw new Error("Installer source must be a clean delivery portable build");
  }
  if (portableManifest.remotionRuntime?.commercialLicenseConfirmed !== true) {
    throw new Error("Installer source lacks a confirmed Remotion commercial license basis");
  }
  if (portableManifest.remotionRuntime?.compositionSmokeStatus !== "passed") {
    throw new Error("Installer source lacks the explicit-browser Remotion composition smoke proof");
  }
  verifyPackagedRemotionRuntime(portableDir, portableManifest.remotionRuntime);
  if (portableManifest.commit !== commit) {
    throw new Error("Portable build commit does not match the current clean commit");
  }
  const releaseTrust = verifyReleaseTrustRecord({
    environment,
    portableManifest,
    portableManifestSha256: sha256(portableManifestFile),
    portableTreeSha256: treeSha256(portableDir),
    product: PRODUCT_NAME,
    releaseDir
  });
  return { commit, portableManifest, releaseTrust };
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

function buildInstaller() {
  const { commit, portableManifest, releaseTrust } = assertInstallerSource();
  const portableTreeHash = releaseTrust.portableTreeSha256;
  const transactionId = `${process.pid}-${Date.now()}`;
  const stagingDir = path.join(releaseDir, `.installer-staging-${transactionId}`);
  const installerInputDir = path.join(stagingDir, "portable-input");
  const stagedInstaller = path.join(stagingDir, installerName);
  const stagedManifest = path.join(stagingDir, installerManifestName);
  const canonicalInstaller = path.join(releaseDir, installerName);
  const canonicalManifest = path.join(releaseDir, installerManifestName);
  fs.mkdirSync(stagingDir, { recursive: false });

  try {
    fs.cpSync(portableDir, installerInputDir, { recursive: true, errorOnExist: true });
    const builder = require.resolve("electron-builder/out/cli/cli.js");
    const result = spawnSync(process.execPath, [
      builder,
      "--win",
      "nsis",
      "--x64",
      "--prepackaged",
      installerInputDir,
      "--config",
      path.join(desktopDir, "electron-builder-installer.yml"),
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
      artifact: installerName,
      artifactType: "delivery",
      version: portableManifest.version,
      buildId: portableManifest.buildId,
      commit,
      architecture: "x64",
      installationScope: "current-user",
      appId: productBrand.stableAppId,
      installDirectory: `%LOCALAPPDATA%\\Programs\\${productBrand.stableInstallDirectoryName}`,
      userDataDirectory: `%APPDATA%\\${productBrand.stableDeliveryDataDirectoryName}\\data`,
      upgradeMode: "offline-full-overwrite",
      uninstallPreservesUserData: true,
      signed: false,
      sourceTrust: releaseTrust,
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
    console.log(`delivery installer built: ${canonicalInstaller}`);
    console.log(`sha256: ${installerManifest.sha256}`);
    return { installer: canonicalInstaller, manifest: canonicalManifest, installerManifest, retainedBackups };
  } finally {
    if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

if (require.main === module) buildInstaller();

module.exports = {
  assertInstallerSource,
  buildInstaller,
  installerManifestName,
  installerName,
  replaceCanonicalFile
};
