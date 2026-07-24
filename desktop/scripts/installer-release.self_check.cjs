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
const packageMetadata = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8"));
const config = fs.readFileSync(path.join(desktopDir, "electron-builder-installer.yml"), "utf8");
const builder = fs.readFileSync(path.join(desktopDir, "scripts", "build-installer-release.cjs"), "utf8");

assert.equal(packageMetadata.productName, "AI获客");
assert.match(packageMetadata.scripts["release:installer"], /build-portable-release\.cjs delivery/);
assert.match(packageMetadata.scripts["release:installer"], /build-installer-release\.cjs/);
assert.match(config, /^appId: com\.aihuoke\.desktop$/m);
assert.match(config, /^productName: AI获客$/m);
assert.match(config, /^\s+perMachine: false$/m);
assert.match(config, /^\s+deleteAppDataOnUninstall: false$/m);
assert.match(config, /^\s+createDesktopShortcut: always$/m);
assert.match(config, /^\s+createStartMenuShortcut: true$/m);
assert.match(config, /^  artifactName: AI获客-安装程序\.\$\{ext\}$/m);
assert.match(builder, /Refusing to build an installer from a dirty worktree/);
assert.match(builder, /Portable build commit does not match the current clean commit/);
assert.match(builder, /%APPDATA%\\\\xiaoxi-active-touch-delivery\\\\data/);
assert.equal(installerName, "AI获客-安装程序.exe");
assert.equal(installerManifestName, "AI获客-安装程序-版本清单.json");

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
