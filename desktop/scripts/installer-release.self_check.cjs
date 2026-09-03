const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  assertInstallerInputMatchesPortable,
  assertPortableAppTreeMatchesManifest,
  installerManifestName,
  installerName,
  replaceCanonicalFile,
  resolveInstallerTarget,
  verifyInstallerPayload,
  verifyPortableProductDetailRuntime
} = require("./build-installer-release.cjs");
const {
  canonicalJson,
  sha256Text,
  verifyReleaseTrustRecord
} = require("./release-trust-record.cjs");
const { sha256: fileSha256, treeSha256 } = require("./release-tree-hash.cjs");

const desktopDir = path.resolve(__dirname, "..");
const productBrand = require("../product-brand.json");
const installerTargets = require("../installer-targets.json");
const packageMetadata = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8"));
const config = fs.readFileSync(path.join(desktopDir, "electron-builder-installer.yml"), "utf8");
const nsis = fs.readFileSync(path.join(desktopDir, "build", "installer.nsh"), "utf8");
const testConfig = fs.readFileSync(path.join(desktopDir, "electron-builder-test-installer.yml"), "utf8");
const testNsis = fs.readFileSync(path.join(desktopDir, "build", "installer-test.nsh"), "utf8");
const builder = fs.readFileSync(path.join(desktopDir, "scripts", "build-installer-release.cjs"), "utf8");
const trustVerifier = fs.readFileSync(path.join(desktopDir, "scripts", "release-trust-record.cjs"), "utf8");

assert.equal(packageMetadata.productName, productBrand.displayName);
assert.equal(packageMetadata.version, "1.0.0");
assert.match(packageMetadata.scripts["release:delivery"], /run-release\.cjs delivery/);
assert.doesNotMatch(packageMetadata.scripts["release:installer"], /build-portable-release/u, "installer creation must follow the independent trust-record step instead of rebuilding its signed portable input");
assert.match(packageMetadata.scripts["release:installer"], /build-installer-release\.cjs/);
const installerScript = packageMetadata.scripts["release:installer"];
assert.equal(
  installerScript.indexOf("check:product-detail-e2e") < installerScript.indexOf("build-installer-release.cjs"),
  true,
  "the existing product-detail E2E gate must run before the trusted portable is consumed"
);
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
assert.match(builder, /TEST_PORTABLE_REUSE_PATHS/);
assert.match(builder, /assertTestPortableReuse/);
assert.match(builder, /target\.edition !== "test"/);
assert.match(builder, /portableManifest\.artifactType !== target\.artifactType/);
assert.match(builder, /requiresCommercialTrust/);
assert.match(builder, /assertPortableAppTreeMatchesManifest/);
assert.match(builder, /Installer input does not match the verified portable application/);
assert.match(builder, /Installer input source tree does not match the portable version manifest/);
assert.match(builder, /verifyPackagedRemotionRuntime\(installerInputDir, portableManifest\.remotionRuntime\)/);
assert.doesNotMatch(builder.match(/const TEST_PORTABLE_REUSE_PATHS = new Set\(\[[\s\S]*?\]\);/u)?.[0] || "", /desktop\/(package\.json|product-brand\.json)/u);
assert.match(builder, /commercialLicenseConfirmed !== true/);
assert.match(builder, /verifyPackagedRemotionRuntime\(portableDir, portableManifest\.remotionRuntime\)/);
assert.match(builder, /verifyReleaseTrustRecord/);
assert.match(builder, /sourceTrust: releaseTrust/);
const releaseTrustCall = builder.indexOf("releaseTrust = verifyReleaseTrustRecord({");
const testReuseCall = builder.indexOf("reusedInstallerOnlyPaths = assertTestPortableReuse(");
const remotionRuntimeGateCall = builder.indexOf("verifyPackagedRemotionRuntime(portableDir");
const productDetailRuntimeGateCall = builder.indexOf("verifyProductDetailRuntime({");
assert.equal(releaseTrustCall >= 0, true, "delivery installer must verify its independent trust record");
assert.equal(testReuseCall >= 0, true, "test installer must verify portable ancestry and changed paths");
assert.equal(remotionRuntimeGateCall >= 0, true, "installer must verify the packaged Remotion runtime");
assert.equal(productDetailRuntimeGateCall >= 0, true, "installer must verify the packaged product-detail runtime");
assert.equal(
  releaseTrustCall < remotionRuntimeGateCall && releaseTrustCall < productDetailRuntimeGateCall,
  true,
  "delivery trust verification must finish before any packaged runtime is executed"
);
assert.equal(
  testReuseCall < remotionRuntimeGateCall && testReuseCall < productDetailRuntimeGateCall,
  true,
  "test portable ancestry and path checks must finish before any packaged runtime is executed"
);
assert.match(builder, /artifactType: target\.artifactType/);
assert.match(builder, /installerBuildCommit/);
assert.match(builder, /signed: false/);
assert.doesNotMatch(builder, /signed: true/);
assert.match(trustVerifier, /crypto\.verify\("RSA-SHA256"/);
assert.doesNotMatch(trustVerifier, /crypto\.sign/u, "the build must verify an external signature, never create one");
assert.match(builder, /require\.resolve\("electron-builder\/out\/cli\/cli\.js"\)/);
assert.match(builder, /spawnSync\(process\.execPath/);
assert.match(builder, /fs\.cpSync\(portableDir, installerInputDir/);
assert.match(builder, /treeSha256\(installerInputDir\) !== portableTreeHash/);
assert.match(builder, /Installer input does not match the verified portable application/);
assert.match(builder, /verifyProductDetailRuntime\(\{/);
assert.match(builder, /runPackagedProductDetailReleaseGate/);
assert.match(builder, /"--prepackaged",\s+installerInputDir/);
assert.match(builder, /treeSha256\(portableDir\) !== portableTreeHash/);
assert.match(builder, /Portable application changed while building the installer/);
assert.match(builder, /assertPortableAppTreeMatchesManifest\(\{/);
assert.match(builder, /verifyInstallerPayload\(\{/);
assert.match(builder, /app-64\.7z/);
assert.doesNotMatch(builder, /"--prepackaged",\s+portableDir/);
assert.match(builder, /productBrand\.stableDeliveryDataDirectoryName/);
assert.equal(productBrand.stableDeliveryDataDirectoryName, "xiaoxi-active-touch-delivery");
assert.equal(productBrand.stableInstallDirectoryName, "AI获客");
assert.deepEqual(installerTargets.test, {
  appId: "com.aihuoke.desktop.test",
  installDirectoryName: "AI获客-测试版",
  dataDirectoryName: "xiaoxi-active-touch-test"
});
assert.match(nsis, /StrCpy \$INSTDIR "\$LocalAppData\\Programs\\AI获客"/);
assert.equal(installerName, `${productBrand.displayName}-安装程序.exe`);
assert.equal(installerManifestName, `${productBrand.displayName}-安装程序-版本清单.json`);
assert.deepEqual(resolveInstallerTarget("upgrade"), {
  ...resolveInstallerTarget("delivery"),
  artifactType: "internal-evaluation",
  requiresCommercialTrust: false
}, "internal upgrades must retain the installed app identity and user-data directory");
assert.equal(resolveInstallerTarget("delivery").requiresCommercialTrust, true);
assert.throws(
  () => require("./run-release.cjs").runRelease("delivery", { XIAOXI_INTERNAL_UPGRADE: "1" }),
  /explicit upgrade entry point/u,
  "ordinary delivery must not inherit the internal upgrade mode"
);
assert.match(testConfig, /^appId: com\.aihuoke\.desktop\.test$/m);
assert.match(testConfig, /^productName: AI获客 V1\.0版本-测试版$/m);
assert.match(testConfig, /^  artifactName: AI获客 V1\.0版本-测试版-安装程序\.\$\{ext\}$/m);
assert.match(testNsis, /StrCpy \$INSTDIR "\$LocalAppData\\Programs\\AI获客-测试版"/);
assert.deepEqual(resolveInstallerTarget("test"), {
  edition: "test",
  artifactType: "internal-evaluation",
  productName: `${productBrand.displayName}-测试版`,
  installerName: `${productBrand.displayName}-测试版-安装程序.exe`,
  installerManifestName: `${productBrand.displayName}-测试版-安装程序-版本清单.json`,
  configFile: "electron-builder-test-installer.yml",
  appId: installerTargets.test.appId,
  installDirectoryName: installerTargets.test.installDirectoryName,
  dataDirectoryName: installerTargets.test.dataDirectoryName,
  requiresCommercialTrust: false
});

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "aihuoke-installer-publish-"));
try {
  const staged = path.join(fixture, "staged.exe");
  const canonical = path.join(fixture, "canonical.exe");
  fs.writeFileSync(staged, "new");
  fs.writeFileSync(canonical, "old");
  const backup = replaceCanonicalFile(staged, canonical);
  assert.equal(fs.readFileSync(canonical, "utf8"), "new");
  assert.equal(fs.existsSync(staged), false);
  assert.match(backup, /\.backup-/);
  assert.equal(fs.readFileSync(backup, "utf8"), "old");

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

const trustFixture = fs.mkdtempSync(path.join(os.tmpdir(), "aihuoke-installer-trust-"));
try {
  const releaseDir = path.join(trustFixture, "release");
  const trustDir = path.join(trustFixture, "independent-trust");
  fs.mkdirSync(releaseDir);
  fs.mkdirSync(trustDir);
  const portableDir = path.join(releaseDir, "portable");
  fs.mkdirSync(path.join(portableDir, "resources", "content-engine"), { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyBytes = publicKey.export({ format: "pem", type: "spki" });
  const publicKeyFile = path.join(trustDir, "release-trust-public.pem");
  const recordFile = path.join(trustDir, "release-trust-record.json");
  fs.writeFileSync(publicKeyFile, publicKeyBytes);
  const runtime = {
    artifactType: "delivery",
    browserSha256: "1".repeat(64),
    bundleSha256: "2".repeat(64),
    commercialLicenseConfirmed: true,
    compositionSmokeStatus: "passed",
    licenseRecordSha256: "3".repeat(64),
    manifestPath: "resources/content-engine/remotion-runtime-manifest.json",
    manifestSha256: "4".repeat(64),
    runtimeHash: "5".repeat(64),
    sbomSha256: "6".repeat(64),
    workerSha256: "7".repeat(64)
  };
  const portableManifest = { artifactType: "delivery", remotionRuntime: runtime };
  const portableManifestFile = path.join(portableDir, "版本清单.json");
  const runtimeManifestFile = path.join(portableDir, "resources", "content-engine", "remotion-runtime-manifest.json");
  fs.writeFileSync(portableManifestFile, canonicalJson(portableManifest));
  fs.writeFileSync(runtimeManifestFile, "verified runtime manifest\n");
  const portableManifestSha256 = fileSha256(portableManifestFile);
  const portableTreeSha256 = treeSha256(portableDir);
  const payload = {
    artifactType: "delivery",
    portableManifestSha256,
    portableTreeSha256,
    product: productBrand.displayName,
    remotionRuntimeDescriptorSha256: sha256Text(canonicalJson(runtime)),
    remotionRuntimeManifestSha256: runtime.manifestSha256,
    schemaVersion: 1
  };
  const signature = crypto.sign("RSA-SHA256", Buffer.from(canonicalJson(payload)), privateKey).toString("base64");
  fs.writeFileSync(recordFile, canonicalJson({
    payload,
    signature: { algorithm: "RSA-SHA256", valueBase64: signature }
  }));
  const environment = {
    XIAOXI_RELEASE_TRUST_PUBLIC_KEY: publicKeyFile,
    XIAOXI_RELEASE_TRUST_PUBLIC_KEY_SHA256: crypto.createHash("sha256").update(publicKeyBytes).digest("hex"),
    XIAOXI_RELEASE_TRUST_RECORD: recordFile
  };
  assert.equal(verifyReleaseTrustRecord({
    environment,
    portableManifest,
    portableManifestSha256,
    portableTreeSha256,
    product: productBrand.displayName,
    releaseDir
  }).verified, true);

  const coordinatedRuntimeTamper = {
    ...runtime,
    browserSha256: "8".repeat(64),
    manifestSha256: "9".repeat(64)
  };
  const coordinatedPortableManifest = { artifactType: "delivery", remotionRuntime: coordinatedRuntimeTamper };
  fs.writeFileSync(runtimeManifestFile, "coordinated tampered runtime manifest\n");
  fs.writeFileSync(portableManifestFile, canonicalJson(coordinatedPortableManifest));
  const tamperedPortableManifestSha256 = fileSha256(portableManifestFile);
  const tamperedPortableTreeSha256 = treeSha256(portableDir);
  assert.throws(() => verifyReleaseTrustRecord({
    environment,
    portableManifest: coordinatedPortableManifest,
    portableManifestSha256: tamperedPortableManifestSha256,
    portableTreeSha256: tamperedPortableTreeSha256,
    product: productBrand.displayName,
    releaseDir
  }), /does not bind/u, "a coordinated runtime-manifest and descriptor tamper must fail the independent trust binding");

  const forgedPayload = {
    ...payload,
    portableManifestSha256: tamperedPortableManifestSha256,
    portableTreeSha256: tamperedPortableTreeSha256,
    remotionRuntimeDescriptorSha256: sha256Text(canonicalJson(coordinatedRuntimeTamper)),
    remotionRuntimeManifestSha256: coordinatedRuntimeTamper.manifestSha256
  };
  fs.writeFileSync(recordFile, canonicalJson({
    payload: forgedPayload,
    signature: { algorithm: "RSA-SHA256", valueBase64: signature }
  }));
  assert.throws(() => verifyReleaseTrustRecord({
    environment,
    portableManifest: coordinatedPortableManifest,
    portableManifestSha256: tamperedPortableManifestSha256,
    portableTreeSha256: tamperedPortableTreeSha256,
    product: productBrand.displayName,
    releaseDir
  }), /signature verification failed/u, "coordinated metadata cannot replace the independent signature");

  const inTreeRecord = path.join(releaseDir, "untrusted-record.json");
  fs.copyFileSync(recordFile, inTreeRecord);
  assert.throws(() => verifyReleaseTrustRecord({
    environment: { ...environment, XIAOXI_RELEASE_TRUST_RECORD: inTreeRecord },
    portableManifest,
    portableManifestSha256,
    portableTreeSha256,
    product: productBrand.displayName,
    releaseDir
  }), /independently from the release tree/u);
} finally {
  fs.rmSync(trustFixture, { recursive: true, force: true });
}

console.log("installer release self-check passed");
