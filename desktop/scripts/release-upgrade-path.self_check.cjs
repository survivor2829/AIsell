const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assertUpgradePaths, verifyUpgradePaths } = require("./release-upgrade-path.cjs");
(async () => {
  const parent = path.resolve(__dirname, "../.build/upgrade-path-tests");
  fs.mkdirSync(parent, { recursive: true });
  const cacheDir = fs.mkdtempSync(path.join(parent, "run-"));
  try {
  const keys = crypto.generateKeyPairSync("ed25519");
  const config = { appId: "com.aihuoke.desktop.test", channel: "test", signingPublicKey: keys.publicKey };
  const bytes = Buffer.from("full installer fixture");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const manifest = { schema: 1, ...config, platform: "win32", arch: "x64", version: "1.1.78", sequence: 1,
    sha256, size: bytes.length, file: `/artifacts/${sha256}.exe`, notes: "fixture" };
  delete manifest.signingPublicKey;
  const payload = JSON.stringify(manifest);
  const envelope = { payload, signature: crypto.sign(null, Buffer.from(payload), keys.privateKey).toString("base64") };
  const legacyPayload = JSON.stringify({ ...manifest, version: "1.1.77" });
  const legacyEnvelope = { payload: legacyPayload, signature: crypto.sign(null, Buffer.from(legacyPayload), keys.privateKey).toString("base64") };
  assert.equal(assertUpgradePaths(manifest, manifest).length, 3);
  assert.throws(() => assertUpgradePaths(manifest, { ...manifest, version: "1.1.77" }), /fallback_missing/);
  assert.throws(() => assertUpgradePaths(manifest, manifest, [{ supported: true, channel: "test", appId: config.appId, version: "1.1.57", protocols: [2] }]), /path_missing/);
  const target = { ...manifest, version: "1.1.79", dataSchema: 2, base: { version: "1.1.78", fingerprint: "a".repeat(64) } };
  const bridge = { ...manifest, componentBase: { ...target.base, dataSchema: 2, updateProtocol: 4 } };
  assert.equal(assertUpgradePaths(target, bridge)[0].then, target.version);
  assert.throws(() => assertUpgradePaths(target, { ...bridge, componentBase: { ...bridge.componentBase, dataSchema: 3 } }), /fallback_missing/);
  let corrupt = false, downloads = 0, heads = 0;
  const request = async (route, options = {}) => {
    if (route.endsWith("latest")) {
      if (options.headers?.["X-Xiaoxi-Update-Protocol"] !== "3") return legacyEnvelope;
      assert.deepEqual(options.headers, { "X-Xiaoxi-Update-Protocol": "3", "X-Xiaoxi-Version": manifest.version });
      return envelope;
    }
    assert.equal(options.headers, undefined, "artifact download must not advertise release capabilities");
    if (options.method === "HEAD") { heads++; return { size: corrupt ? 1 : bytes.length }; }
    downloads++;
    fs.writeFileSync(options.destination, corrupt ? Buffer.alloc(bytes.length) : bytes);
  };
  assert.equal(await request(`/v1/releases/test/latest`), legacyEnvelope);
  await assert.rejects(verifyUpgradePaths({ config, target: manifest, request: (route, options) => request(route, { ...options, headers: undefined }) }), /fallback_missing/);
  assert.equal((await verifyUpgradePaths({ config, target: manifest, request, cacheDir })).paths.length, 3);
  assert.equal((await verifyUpgradePaths({ config, target: manifest, request, cacheDir })).downloadedBytes, 0);
  assert.equal(downloads, 1); assert.equal(heads, 1);
  corrupt = true;
  await assert.rejects(verifyUpgradePaths({ config, target: manifest, request, cacheDir }), /fallback_invalid/);
  fs.unlinkSync(path.join(cacheDir, sha256 + ".json"));
  await assert.rejects(verifyUpgradePaths({ config, target: manifest, request, cacheDir }), /fallback_invalid/);
  await assert.rejects(verifyUpgradePaths({ config, target: manifest, request, expectedPayload: "changed", verifyArtifact: false }), /fallback_changed/);
  console.log("release upgrade paths: modern/legacy routing, supported legacy protocols, target matching, artifact integrity and publication race checks passed");
  } finally { fs.rmSync(cacheDir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
