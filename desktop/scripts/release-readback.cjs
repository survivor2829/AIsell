const crypto = require("node:crypto");
const { createTransport } = require("../src/main/cloud-transport.cjs");
const { verifyManifest } = require("../src/shared/cloud-contract.cjs");
const { COMPONENTS, verifyComponentManifest } = require("../src/shared/component-contract.cjs");

// Verification only: never submit another publication when the readback is uncertain.
async function verifyPublishedRelease({ config, envelope, schema, request }) {
  const verify = schema === 1 ? verifyManifest : schema === 2 ? verifyComponentManifest : null;
  if (!verify) throw Error("Unsupported release manifest schema.");
  const expected = verify(envelope, config);
  const route = `/v${schema}/releases/${encodeURIComponent(expected.channel)}/latest`;
  const manifestSha256 = crypto.createHash("sha256").update(envelope.payload).digest("hex");
  let transport;
  try {
    if (!request) transport = createTransport(config);
    const returned = await (request || transport.request)(route, { maxBytes: 256 * 1024 });
    const actual = verify(returned, config);
    if (returned.payload !== envelope.payload) {
      throw Object.assign(new Error("Published manifest differs from the submitted manifest."), { code: "release_readback_mismatch" });
    }
    return {
      verified: true, version: actual.version, channel: actual.channel, sequence: actual.sequence,
      manifestSha256,
      artifactSha256: schema === 1 ? actual.sha256 : Object.fromEntries(COMPONENTS.map(name => [name, actual.components[name].sha256]))
    };
  } catch (cause) {
    const reason = /^[a-z][a-z0-9_]{0,79}$/.test(cause.code || "") ? cause.code : "release_readback_unavailable";
    throw Object.assign(new Error(
      `发布切换已执行，但公开更新端点读回未核实（${reason}）。发布可能已完成；请核对 ${route} 的版本 ${expected.version}、序号 ${expected.sequence}、清单 SHA-256 ${manifestSha256}，不要直接重新发布。`,
      { cause }
    ), { code: "release_readback_unverified", version: expected.version, sequence: expected.sequence, manifestSha256, route });
  } finally {
    transport?.close();
  }
}

module.exports = { verifyPublishedRelease };
