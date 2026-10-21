const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTransport } = require("../src/main/cloud-transport.cjs");
const { verifyManifest, compareVersions } = require("../src/shared/cloud-contract.cjs");
const { hashFile, supportsComponentBridge } = require("../src/shared/component-contract.cjs");
const support = require("../release-upgrade-support.json");
function assertUpgradePaths(target, full, sources = support.sources) {
  if (!full || full.appId !== target.appId || full.channel !== target.channel
      || (full.version !== target.version && !supportsComponentBridge(full, target))) {
    throw Error("release_full_fallback_missing: a verified compatible installer bridge or same-version installer is required");
  }
  const supported = sources.filter(source => source.supported && source.channel === target.channel);
  if (!supported.length) throw Error("release_supported_sources_missing");
  for (const source of supported) {
    if (source.appId !== target.appId || !source.protocols.includes(1) || compareVersions(full.version, source.version) <= 0) {
      throw Error(`release_upgrade_path_missing:${source.version}`);
    }
  }
  return supported.map(source => ({ from: source.version, to: full.version, protocol: 1, artifact: full.sha256,
    ...(full.version !== target.version ? { then: target.version, componentProtocol: 2 } : {}) }));
}
async function verifyUpgradePaths({ config, target, request, expectedPayload, expectedComponentBasePayload, verifyArtifact = true,
  cacheDir = path.resolve(__dirname, "../.build/release-upgrade-validation") }) {
  const transport = request ? null : createTransport(config);
  const send = request || transport.request;
  let temporary;
  try {
    const envelope = await send(`/v1/releases/${config.channel}/latest`, {
      headers: { "X-Xiaoxi-Update-Protocol": "5", "X-Xiaoxi-Version": target.version }
    });
    const full = verifyManifest(envelope, config);
    const paths = assertUpgradePaths(target, full);
    if (expectedPayload && envelope.payload !== expectedPayload) throw Error("release_full_fallback_changed");
    if (expectedComponentBasePayload !== undefined && (envelope.componentBaseEnvelope?.payload || null) !== expectedComponentBasePayload) throw Error("release_full_fallback_changed");
    let downloadedBytes = 0;
    if (verifyArtifact) {
      const receiptFile = path.join(cacheDir, full.sha256 + ".json");
      let receipt;
      try { receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8")); } catch { /* First validation downloads once. */ }
      const componentBasePayload = envelope.componentBaseEnvelope?.payload || null;
      const componentBase = full.componentBase || null;
      const cached = receipt?.payload === envelope.payload && receipt?.componentBasePayload === componentBasePayload
        && JSON.stringify(receipt.componentBase) === JSON.stringify(componentBase) && receipt?.origin === config.origin && receipt?.verified === true;
      if (cached) {
        const remote = await send(full.file, { method: "HEAD" });
        if (remote.size !== full.size) throw Error("release_full_fallback_invalid");
      } else {
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), "release-upgrade-path-"));
      const destination = path.join(temporary, "verified-installer.exe");
      await send(full.file, { destination, expected: full, maxBytes: full.size });
      if (fs.statSync(destination).size !== full.size || await hashFile(destination) !== full.sha256) throw Error("release_full_fallback_invalid");
      downloadedBytes = full.size;
      fs.mkdirSync(cacheDir, { recursive: true });
      require("../src/main/atomic-file.cjs").writeJsonAtomic(receiptFile,
        { payload: envelope.payload, componentBasePayload, componentBase, origin: config.origin, verified: true, verifiedAt: new Date().toISOString() });
      }
    }
    return { payload: envelope.payload, componentBasePayload: envelope.componentBaseEnvelope?.payload || null, paths, downloadedBytes };
  } finally {
    transport?.close();
    if (temporary) { fs.rmSync(path.join(temporary, "verified-installer.exe"), { force: true }); fs.rmdirSync(temporary); }
  }
}
module.exports = { assertUpgradePaths, verifyUpgradePaths };
