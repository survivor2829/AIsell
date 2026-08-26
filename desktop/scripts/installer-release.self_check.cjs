const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  installerManifestName,
  installerName,
  replaceCanonicalFile
} = require("./build-installer-release.cjs");
const {
  canonicalJson,
  sha256Text,
  verifyReleaseTrustRecord
} = require("./release-trust-record.cjs");
const { sha256: fileSha256, treeSha256 } = require("./release-tree-hash.cjs");

const desktopDir = path.resolve(__dirname, "..");
const productBrand = require("../product-brand.json");
const packageMetadata = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8"));
const config = fs.readFileSync(path.join(desktopDir, "electron-builder-installer.yml"), "utf8");
const nsis = fs.readFileSync(path.join(desktopDir, "build", "installer.nsh"), "utf8");
const builder = fs.readFileSync(path.join(desktopDir, "scripts", "build-installer-release.cjs"), "utf8");
const trustVerifier = fs.readFileSync(path.join(desktopDir, "scripts", "release-trust-record.cjs"), "utf8");

assert.equal(packageMetadata.productName, productBrand.displayName);
assert.equal(packageMetadata.version, "1.0.0");
assert.match(packageMetadata.scripts["release:delivery"], /build-portable-release\.cjs delivery/);
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
assert.match(builder, /portableManifest\.artifactType !== "delivery"/);
assert.match(builder, /commercialLicenseConfirmed !== true/);
assert.match(builder, /verifyPackagedRemotionRuntime\(portableDir, portableManifest\.remotionRuntime\)/);
assert.match(builder, /verifyReleaseTrustRecord/);
assert.match(builder, /sourceTrust: releaseTrust/);
assert.match(builder, /artifactType: "delivery"/);
assert.match(builder, /signed: false/);
assert.doesNotMatch(builder, /signed: true/);
assert.match(trustVerifier, /crypto\.verify\("RSA-SHA256"/);
assert.doesNotMatch(trustVerifier, /crypto\.sign/u, "the build must verify an external signature, never create one");
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
