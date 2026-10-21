const crypto = require("node:crypto");
const fs = process.versions.electron ? require("original-fs") : require("node:fs");
const launcher = require("./launcher-contract.cjs");
const { compareVersions } = launcher;
async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function validateManifest(manifest, config) {
  launcher.validateManifest(manifest, config);
  if (manifest.verification !== undefined) require("./component-verification.cjs").validatePolicy(manifest.verification);
  return manifest;
}
function verifyComponentManifest(envelope, config) {
  return validateManifest(launcher.verifyComponentManifest(envelope, config), config);
}
function supportsComponentBridge(full, target) {
  const base = full?.componentBase;
  return Boolean(base && base.updateProtocol === launcher.protocolFor(target) && base.version === target.base?.version
    && base.fingerprint === target.base?.fingerprint && base.dataSchema === target.dataSchema
    && full.appId === target.appId && full.channel === target.channel
    && compareVersions(full.version, target.version) <= 0);
}
module.exports = { ...launcher, hashFile, validateManifest, verifyComponentManifest, supportsComponentBridge };
