const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { treeSha256 } = require("./release-tree-hash.cjs");

const desktopDir = path.resolve(__dirname, "..");
const projectDir = path.resolve(desktopDir, "..");
const releaseDir = path.join(projectDir, "release");
const portableDir = path.join(releaseDir, "AI获客");
const portableManifestFile = path.join(portableDir, "版本清单.json");
const installerName = "AI获客-安装程序.exe";
const installerManifestName = "AI获客-安装程序-版本清单.json";

function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
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

function assertInstallerSource() {
  const commit = gitText(["rev-parse", "HEAD"]);
  if (gitText(["status", "--porcelain"])) {
    throw new Error("Refusing to build an installer from a dirty worktree");
  }
  if (!fs.existsSync(path.join(portableDir, "AI获客.exe"))) {
    throw new Error("Verified portable application is missing; build it first");
  }
  if (!fs.existsSync(portableManifestFile)) {
    throw new Error("Portable version manifest is missing");
  }
  const portableManifest = JSON.parse(fs.readFileSync(portableManifestFile, "utf8"));
  if (portableManifest.edition !== "delivery" || portableManifest.dirty !== false) {
    throw new Error("Installer source must be a clean delivery portable build");
  }
  if (portableManifest.commit !== commit) {
    throw new Error("Portable build commit does not match the current clean commit");
  }
  return { commit, portableManifest };
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
  if (backedUp && fs.existsSync(backup)) fs.rmSync(backup, { force: true });
}

function buildInstaller() {
  const { commit, portableManifest } = assertInstallerSource();
  const portableTreeHash = treeSha256(portableDir);
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
      product: "AI获客",
      artifact: installerName,
      version: portableManifest.version,
      buildId: portableManifest.buildId,
      commit,
      architecture: "x64",
      installationScope: "current-user",
      appId: "com.aihuoke.desktop",
      installDirectory: "%LOCALAPPDATA%\\Programs\\AI获客",
      userDataDirectory: "%APPDATA%\\xiaoxi-active-touch-delivery\\data",
      upgradeMode: "offline-full-overwrite",
      uninstallPreservesUserData: true,
      signed: false,
      sha256: sha256(stagedInstaller),
      size,
      builtAt: new Date().toISOString()
    };
    fs.writeFileSync(stagedManifest, `${JSON.stringify(installerManifest, null, 2)}\n`, "utf8");

    replaceCanonicalFile(stagedInstaller, canonicalInstaller);
    replaceCanonicalFile(stagedManifest, canonicalManifest);
    console.log(`delivery installer built: ${canonicalInstaller}`);
    console.log(`sha256: ${installerManifest.sha256}`);
    return { installer: canonicalInstaller, manifest: canonicalManifest, installerManifest };
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
