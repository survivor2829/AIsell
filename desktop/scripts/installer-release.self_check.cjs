const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  installerManifestName,
  installerName,
  replaceCanonicalFile
} = require("./build-installer-release.cjs");

const desktopDir = path.resolve(__dirname, "..");
const productBrand = require("../product-brand.json");
const packageMetadata = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8"));
const config = fs.readFileSync(path.join(desktopDir, "electron-builder-installer.yml"), "utf8");
const nsis = fs.readFileSync(path.join(desktopDir, "build", "installer.nsh"), "utf8");
const builder = fs.readFileSync(path.join(desktopDir, "scripts", "build-installer-release.cjs"), "utf8");

assert.equal(packageMetadata.productName, productBrand.displayName);
assert.equal(packageMetadata.version, "1.0.0");
assert.match(packageMetadata.scripts["release:installer"], /build-portable-release\.cjs delivery/);
assert.match(packageMetadata.scripts["release:installer"], /build-installer-release\.cjs/);
assert.match(config, /^appId: com\.aihuoke\.desktop$/m);
assert.match(config, new RegExp(`^productName: ${productBrand.displayName.replace(".", "\\.")}$`, "m"));
assert.match(config, /^\s+perMachine: false$/m);
assert.match(config, /^\s+include: build\/installer\.nsh$/m);
assert.match(config, /^\s+deleteAppDataOnUninstall: false$/m);
assert.match(config, /^\s+createDesktopShortcut: always$/m);
assert.match(config, /^\s+createStartMenuShortcut: true$/m);
assert.match(config, new RegExp(`^  artifactName: ${productBrand.displayName.replace(".", "\\.")}-安装程序\\.\\$\\{ext\\}$`, "m"));
assert.match(builder, /Refusing to build an installer from a dirty worktree/);
assert.match(builder, /Portable build commit does not match the current clean commit/);
assert.match(builder, /require\.resolve\("electron-builder\/out\/cli\/cli\.js"\)/);
assert.match(builder, /spawnSync\(process\.execPath/);
assert.match(builder, /fs\.cpSync\(portableDir, installerInputDir/);
assert.match(builder, /"--prepackaged",\s+installerInputDir/);
assert.match(builder, /treeSha256\(portableDir\) !== portableTreeHash/);
assert.match(builder, /Portable application changed while building the installer/);
assert.doesNotMatch(builder, /"--prepackaged",\s+portableDir/);
assert.match(builder, /productBrand\.stableDeliveryDataDirectoryName/);
assert.equal(productBrand.stableDeliveryDataDirectoryName, "xiaoxi-active-touch-delivery");
assert.equal(productBrand.stableInstallDirectoryName, "AI获客");
assert.match(nsis, /StrCpy \$INSTDIR "\$LocalAppData\\Programs\\AI获客"/);
assert.equal(installerName, `${productBrand.displayName}-安装程序.exe`);
assert.equal(installerManifestName, `${productBrand.displayName}-安装程序-版本清单.json`);

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "aihuoke-installer-publish-"));
try {
  const staged = path.join(fixture, "staged.exe");
  const canonical = path.join(fixture, "canonical.exe");
  fs.writeFileSync(staged, "new");
  fs.writeFileSync(canonical, "old");
  replaceCanonicalFile(staged, canonical);
  assert.equal(fs.readFileSync(canonical, "utf8"), "new");
  assert.equal(fs.existsSync(staged), false);
  assert.equal(fs.readdirSync(fixture).some((name) => name.includes(".backup-")), false);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log("installer release self-check passed");
