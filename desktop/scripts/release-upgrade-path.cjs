const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTransport } = require("../src/main/cloud-transport.cjs");
const { verifyManifest, compareVersions } = require("../src/shared/cloud-contract.cjs");
const { hashFile } = require("../src/shared/component-contract.cjs");
const support = require("../release-upgrade-support.json");
function assertUpgradePaths(target, full, sources = support.sources) {
  if (!full || full.version !== target.version || full.appId !== target.appId || full.channel !== target.channel) {
    throw Error("release_full_fallback_missing: publish and verify the same-version full installer before the incremental release");
  }
  const supported = sources.filter(source => source.supported && source.channel === target.channel);
  if (!supported.length) throw Error("release_supported_sources_missing");
  for (const source of supported) {
    if (source.appId !== target.appId || !source.protocols.includes(1) || compareVersions(target.version, source.version) <= 0) {
      throw Error(`release_upgrade_path_missing:${source.version}`);
    }
  }
  return supported.map(source => ({ from: source.version, to: full.version, protocol: 1, artifact: full.sha256 }));
}
async function verifyUpgradePaths({ config, target, request, expectedPayload, verifyArtifact = true }) {
  const transport = request ? null : createTransport(config);
  const send = request || transport.request;
  let temporary;
  try {
    const envelope = await send(`/v1/releases/${config.channel}/latest`, {
      headers: { "X-Xiaoxi-Update-Protocol": "3", "X-Xiaoxi-Version": target.version }
    });
    const full = verifyManifest(envelope, config);
    const paths = assertUpgradePaths(target, full);
    if (expectedPayload && envelope.payload !== expectedPayload) throw Error("release_full_fallback_changed");
    if (verifyArtifact) {
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), "release-upgrade-path-"));
      const destination = path.join(temporary, "verified-installer.exe");
      await send(full.file, { destination, expected: full, maxBytes: full.size });
      if (fs.statSync(destination).size !== full.size || await hashFile(destination) !== full.sha256) throw Error("release_full_fallback_invalid");
    }
    return { payload: envelope.payload, paths };
  } finally {
    transport?.close();
    if (temporary) { fs.rmSync(path.join(temporary, "verified-installer.exe"), { force: true }); fs.rmdirSync(temporary); }
  }
}
module.exports = { assertUpgradePaths, verifyUpgradePaths };
