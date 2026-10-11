const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { assertUpgradePaths, verifyUpgradePaths } = require("./release-upgrade-path.cjs");
(async () => {
  const keys = crypto.generateKeyPairSync("ed25519");
  const config = { appId: "com.aihuoke.desktop.test", channel: "test", signingPublicKey: keys.publicKey };
  const bytes = Buffer.from("full installer fixture");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const manifest = { schema: 1, ...config, platform: "win32", arch: "x64", version: "1.1.78", sequence: 1,
    sha256, size: bytes.length, file: `/artifacts/${sha256}.exe`, notes: "fixture" };
  delete manifest.signingPublicKey;
  const payload = JSON.stringify(manifest);
  const envelope = { payload, signature: crypto.sign(null, Buffer.from(payload), keys.privateKey).toString("base64") };
  assert.equal(assertUpgradePaths(manifest, manifest).length, 3);
  assert.throws(() => assertUpgradePaths(manifest, { ...manifest, version: "1.1.77" }), /fallback_missing/);
  assert.throws(() => assertUpgradePaths(manifest, manifest, [{ supported: true, channel: "test", appId: config.appId, version: "1.1.57", protocols: [2] }]), /path_missing/);
  let corrupt = false;
  const request = async (route, options) => {
    if (route.endsWith("latest")) return envelope;
    fs.writeFileSync(options.destination, corrupt ? Buffer.alloc(bytes.length) : bytes);
  };
  assert.equal((await verifyUpgradePaths({ config, target: manifest, request })).paths.length, 3);
  corrupt = true;
  await assert.rejects(verifyUpgradePaths({ config, target: manifest, request }), /fallback_invalid/);
  await assert.rejects(verifyUpgradePaths({ config, target: manifest, request, expectedPayload: "changed", verifyArtifact: false }), /fallback_changed/);
  console.log("release upgrade paths: supported legacy protocols, target matching, artifact integrity and publication race checks passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
