const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { COMPONENTS } = require("../src/shared/component-contract.cjs");
const { verifyPublishedRelease } = require("./release-readback.cjs");

async function main() {
  const keys = crypto.generateKeyPairSync("ed25519");
  const config = { appId: "com.test.release", channel: "test", signingPublicKey: keys.publicKey };
  const sign = (manifest, privateKey = keys.privateKey) => {
    const payload = JSON.stringify(manifest);
    return { payload, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString("base64") };
  };
  for (const schema of [1, 2]) {
    const manifest = {
      schema, appId: config.appId, channel: config.channel, platform: "win32", arch: "x64",
      version: "1.1.58", sequence: 123456789, notes: "验收后的同一产物", publishedAt: "2026-10-08T00:00:00.000Z",
      ...(schema === 1 ? { sha256: "a".repeat(64), size: 100, file: `/artifacts/${"a".repeat(64)}.exe` } : {
        base: { version: "1.1.58", fingerprint: "f".repeat(64) }, minBaseVersion: "1.1.58", dataSchema: 1,
        components: Object.fromEntries(COMPONENTS.map((name, index) => {
          const sha256 = (index + 1).toString(16).repeat(64);
          return [name, { name, sha256, treeSha256: sha256, file: `/components/${sha256}.zip`, size: 100, expandedSize: 100, fileCount: 1 }];
        }))
      })
    };
    const envelope = sign(manifest);
    let calls = 0;
    const request = async (route, options) => {
      calls++;
      assert.equal(route, `/v${schema}/releases/test/latest`);
      assert.equal(options.body, undefined, "readback must remain a GET without publication side effects");
      assert.equal(options.maxBytes, 256 * 1024);
      return envelope;
    };
    const verified = await verifyPublishedRelease({ config, envelope, schema, request });
    assert.equal(calls, 1);
    assert.equal(verified.verified, true);
    assert.equal(verified.version, manifest.version);
    assert.equal(verified.sequence, manifest.sequence);
    assert.equal(verified.manifestSha256, crypto.createHash("sha256").update(envelope.payload).digest("hex"));
    assert.deepEqual(verified.artifactSha256, schema === 1 ? manifest.sha256 : Object.fromEntries(COMPONENTS.map(name => [name, manifest.components[name].sha256])));

    const changedDigest = structuredClone(manifest);
    if (schema === 1) {
      changedDigest.sha256 = "b".repeat(64);
      changedDigest.file = `/artifacts/${changedDigest.sha256}.exe`;
    } else {
      changedDigest.components.application.sha256 = "b".repeat(64);
      changedDigest.components.application.file = `/components/${changedDigest.components.application.sha256}.zip`;
    }
    const cases = [
      ["old signed release", sign({ ...manifest, version: "1.1.57", sequence: manifest.sequence - 1 })],
      ["same version and different sequence", sign({ ...manifest, sequence: manifest.sequence + 1 })],
      ["valid signature but wrong artifact", sign(changedDigest)],
      ["wrong signing key", sign(manifest, crypto.generateKeyPairSync("ed25519").privateKey)],
      ["modified unsigned payload", { ...envelope, payload: JSON.stringify({ ...manifest, notes: "changed" }) }],
      ["endpoint unavailable", new Error("cloud_timeout")]
    ];
    for (const [label, response] of cases) {
      let attempts = 0;
      await assert.rejects(verifyPublishedRelease({ config, envelope, schema, request: async () => {
        attempts++;
        if (response instanceof Error) throw response;
        return response;
      } }), error => {
        assert.equal(error.code, "release_readback_unverified", label);
        assert.match(error.message, /发布可能已完成/);
        assert.match(error.message, /不要直接重新发布/);
        assert.equal(error.sequence, manifest.sequence);
        return true;
      });
      assert.equal(attempts, 1, `${label}: must not retry a publication or readback automatically`);
    }
  }
  console.log("release readback self-check passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
