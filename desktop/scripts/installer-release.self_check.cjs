const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { treeSha256 } = require("./release-tree-hash.cjs");
const {
  assertInstallerInputMatchesPortable,
  assertPortableAppTreeMatchesManifest,
  installerManifestName,
  installerName,
  replaceCanonicalFile,
  verifyInstallerPayload,
  verifyPortableProductDetailRuntime
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
assert.match(builder, /treeSha256\(installerInputDir\) !== portableTreeHash/);
assert.match(builder, /Installer input does not match the verified portable application/);
assert.match(builder, /verifyProductDetailRuntime\(\{ portableManifest \}\)/);
assert.match(builder, /runPackagedProductDetailReleaseGate/);
assert.match(builder, /"--prepackaged",\s+installerInputDir/);
assert.match(builder, /treeSha256\(portableDir\) !== portableTreeHash/);
assert.match(builder, /Portable application changed while building the installer/);
assert.match(builder, /assertPortableAppTreeMatchesManifest\(\{ portableManifest \}\)/);
assert.match(builder, /verifyInstallerPayload\(\{/);
assert.match(builder, /app-64\.7z/);
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

  const portableFixture = path.join(fixture, productBrand.displayName);
  const resourcesFixture = path.join(portableFixture, "resources");
  fs.mkdirSync(resourcesFixture, { recursive: true });
  const descriptor = { version: "2.0.0-fixture" };
  const calls = [];
  verifyPortableProductDetailRuntime({
    portableManifest: { productDetailSidecar: descriptor },
    releaseTarget: portableFixture,
    runReleaseGate: (options) => calls.push(options)
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].releaseTarget, portableFixture);
  assert.equal(calls[0].resourcesDir, resourcesFixture);
  assert.equal(calls[0].descriptor, descriptor);
  assert.equal(calls[0].electronExecutable, path.join(portableFixture, `${productBrand.displayName}.exe`));
  assert.match(calls[0].dataDir, /product-detail-gate$/);

  let releaseGateCalled = false;
  assert.throws(
    () => verifyPortableProductDetailRuntime({
      portableManifest: { productDetailSidecar: descriptor },
      releaseTarget: portableFixture,
      runReleaseGate: () => {
        releaseGateCalled = true;
        throw new Error("sidecar is missing");
      }
    }),
    /sidecar is missing/
  );
  assert.equal(releaseGateCalled, true, "installer verification must stop before packaging when sidecar verification fails");
  assert.throws(
    () => verifyPortableProductDetailRuntime({ portableManifest: {}, releaseTarget: portableFixture }),
    /product-detail descriptor is missing/
  );

  const appFixture = path.join(resourcesFixture, "app");
  fs.mkdirSync(appFixture, { recursive: true });
  fs.writeFileSync(path.join(appFixture, "main.cjs"), "fixture-app", "utf8");
  const appManifest = { sourceTreeSha256: treeSha256(appFixture) };
  assert.equal(assertPortableAppTreeMatchesManifest({
    portableManifest: appManifest,
    releaseTarget: portableFixture
  }), appFixture);
  fs.writeFileSync(path.join(appFixture, "main.cjs"), "tampered-app", "utf8");
  assert.throws(
    () => assertPortableAppTreeMatchesManifest({ portableManifest: appManifest, releaseTarget: portableFixture }),
    /does not match its manifest/
  );
  fs.writeFileSync(path.join(appFixture, "main.cjs"), "fixture-app", "utf8");
  fs.writeFileSync(path.join(portableFixture, `${productBrand.displayName}.exe`), "fixture-electron", "utf8");
  const portableManifest = {
    sourceTreeSha256: treeSha256(appFixture),
    productDetailSidecar: descriptor
  };
  fs.writeFileSync(
    path.join(portableFixture, "版本清单.json"),
    JSON.stringify(portableManifest),
    "utf8"
  );

  const installerFixture = path.join(fixture, "fixture-installer.exe");
  fs.writeFileSync(installerFixture, "fixture-installer", "utf8");
  const installerInputFixture = path.join(fixture, "installer-input");
  fs.mkdirSync(installerInputFixture, { recursive: true });
  const copyPortableFixture = (destination) => {
    for (const name of fs.readdirSync(portableFixture)) {
      fs.cpSync(path.join(portableFixture, name), path.join(destination, name), { recursive: true });
    }
  };
  copyPortableFixture(installerInputFixture);
  fs.writeFileSync(
    path.join(installerInputFixture, "resources", "elevate.exe"),
    "electron-builder-helper",
    "utf8"
  );
  assert.doesNotThrow(() => assertInstallerInputMatchesPortable({
    portableTarget: portableFixture,
    installerInput: installerInputFixture
  }));
  fs.writeFileSync(path.join(installerInputFixture, "unexpected.exe"), "unexpected", "utf8");
  assert.throws(
    () => assertInstallerInputMatchesPortable({
      portableTarget: portableFixture,
      installerInput: installerInputFixture
    }),
    /differs from the verified portable application/
  );
  fs.rmSync(path.join(installerInputFixture, "unexpected.exe"));
  fs.writeFileSync(path.join(installerInputFixture, "resources", "app", "main.cjs"), "changed-builder-input", "utf8");
  assert.throws(
    () => assertInstallerInputMatchesPortable({
      portableTarget: portableFixture,
      installerInput: installerInputFixture
    }),
    /differs from the verified portable application/
  );
  fs.writeFileSync(path.join(installerInputFixture, "resources", "app", "main.cjs"), "fixture-app", "utf8");
  fs.rmSync(path.join(installerInputFixture, `${productBrand.displayName}.exe`));
  assert.throws(
    () => assertInstallerInputMatchesPortable({
      portableTarget: portableFixture,
      installerInput: installerInputFixture
    }),
    /differs from the verified portable application/
  );
  fs.writeFileSync(path.join(installerInputFixture, `${productBrand.displayName}.exe`), "fixture-electron", "utf8");
  const expectedPayloadTreeHash = treeSha256(installerInputFixture);
  const extractionCalls = [];
  const releaseGateCalls = [];
  verifyInstallerPayload({
    installerFile: installerFixture,
    portableManifest,
    expectedPayloadTreeHash,
    archiveTool: "fixture-7z.exe",
    spawn: (_command, args) => {
      extractionCalls.push(args);
      const destination = args.find((value) => value.startsWith("-o")).slice(2);
      if (extractionCalls.length === 1) {
        const archive = path.join(destination, "$PLUGINSDIR", "app-64.7z");
        fs.mkdirSync(path.dirname(archive), { recursive: true });
        fs.writeFileSync(archive, "fixture-archive", "utf8");
      } else {
        fs.cpSync(installerInputFixture, destination, { recursive: true });
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    releaseGate: (options) => releaseGateCalls.push(options)
  });
  assert.equal(extractionCalls.length, 2);
  assert.equal(releaseGateCalls.length, 1);
  assert.deepEqual(releaseGateCalls[0].descriptor, descriptor);

  assert.throws(
    () => verifyInstallerPayload({
      installerFile: installerFixture,
      portableManifest,
      expectedPayloadTreeHash,
      archiveTool: "fixture-7z.exe",
      spawn: (_command, args) => {
        const destination = args.find((value) => value.startsWith("-o")).slice(2);
        if (args[args.length - 1] === installerFixture) {
          const archive = path.join(destination, "$PLUGINSDIR", "app-64.7z");
          fs.mkdirSync(path.dirname(archive), { recursive: true });
          fs.writeFileSync(archive, "fixture-archive", "utf8");
        } else {
          fs.cpSync(installerInputFixture, destination, { recursive: true });
          fs.writeFileSync(path.join(destination, "resources", "app", "main.cjs"), "tampered-installer-app", "utf8");
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      releaseGate: () => { throw new Error("release gate must not run after installer payload tampering"); }
    }),
    /differs from the packed installer input/
  );
  assert.throws(
    () => verifyInstallerPayload({
      installerFile: installerFixture,
      portableManifest,
      expectedPayloadTreeHash,
      archiveTool: "fixture-7z.exe",
      spawn: (_command, args) => {
        const destination = args.find((value) => value.startsWith("-o")).slice(2);
        if (args[args.length - 1] === installerFixture) {
          const archive = path.join(destination, "$PLUGINSDIR", "app-64.7z");
          fs.mkdirSync(path.dirname(archive), { recursive: true });
          fs.writeFileSync(archive, "fixture-archive", "utf8");
        } else {
          fs.cpSync(installerInputFixture, destination, { recursive: true });
          fs.writeFileSync(path.join(destination, "unexpected.exe"), "unexpected", "utf8");
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      releaseGate: () => { throw new Error("release gate must not run after installer payload expansion"); }
    }),
    /differs from the packed installer input/
  );
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log("installer release self-check passed");
