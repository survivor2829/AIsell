const crypto = require("node:crypto");
const fs = require("node:fs");
const { VERSION, compareVersions, fail } = require("./cloud-contract.cjs");
const COMPONENTS = Object.freeze(["application", "content-engine", "product-detail", "video"]);
const HEX = /^[a-f0-9]{64}$/;
const MAX_ARCHIVE = 512 * 1024 ** 2;
const MAX_FILES = 50000;
const MAX_EXPANDED = 8 * 1024 ** 3;
function safePath(value) {
  if (typeof value !== "string" || !value || value.length > 500 || value.includes("\\")
      || /[\x00-\x1f<>:"|?*]/.test(value) || value.startsWith("/")
      || value.split("/").some(p => !p || p === "." || p === ".." || /[. ]$/.test(p)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail("component_path_invalid");
  return value;
}
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function validateFiles(files) {
  if (!Array.isArray(files) || files.length > MAX_FILES) fail("component_files_invalid");
  const seen = new Set(); let total = 0;
  for (const file of files) {
    safePath(file.path);
    const key = file.path.toLowerCase();
    if (seen.has(key) || !HEX.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) fail("component_files_invalid");
    seen.add(key); total += file.size;
    if (total > MAX_EXPANDED) fail("component_files_too_large");
  }
  // Files must not shadow a directory required by another file.
  for (const file of files) {
    const parts = file.path.toLowerCase().split("/");
    while (parts.pop(), parts.length) if (seen.has(parts.join("/"))) fail("component_path_collision");
  }
  return total;
}
function treeHash(files) {
  validateFiles(files);
  return digest(JSON.stringify(files.map(({ path, size, sha256 }) => ({ path, size, sha256 })).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}
function validateManifest(m, config) {
  if (!m || m.schema !== 2 || m.appId !== config.appId || m.channel !== config.channel
      || m.platform !== "win32" || m.arch !== "x64" || !VERSION.test(m.version)
      || !VERSION.test(m.base?.version) || !HEX.test(m.base?.fingerprint)
      || !VERSION.test(m.minBaseVersion) || !Number.isSafeInteger(m.dataSchema) || m.dataSchema < 1
      || !Number.isSafeInteger(m.sequence) || m.sequence < 1
      || typeof m.notes !== "string" || m.notes.length > 2000
      || !m.components || Object.keys(m.components).sort().join() !== [...COMPONENTS].sort().join()) fail("component_manifest_invalid");
  if (m.publishedAt !== undefined && (typeof m.publishedAt !== "string" || !Number.isFinite(Date.parse(m.publishedAt)))) fail("component_manifest_invalid");
  for (const name of COMPONENTS) {
    const c = m.components[name];
    if (!c || c.name !== name || !HEX.test(c.sha256) || !HEX.test(c.treeSha256)
        || c.file !== `/components/${c.sha256}.zip` || !Number.isSafeInteger(c.size) || c.size < 1 || c.size > MAX_ARCHIVE
        || !Number.isSafeInteger(c.expandedSize) || c.expandedSize < 0 || c.expandedSize > MAX_EXPANDED
        || !Number.isSafeInteger(c.fileCount) || c.fileCount < 1 || c.fileCount > MAX_FILES) fail("component_manifest_invalid");
  }
  return m;
}
function verifyComponentManifest(envelope, config) {
  if (typeof envelope?.payload !== "string" || Buffer.byteLength(envelope.payload) > 32768
      || typeof envelope.signature !== "string" || envelope.signature.length > 128) fail("component_manifest_invalid");
  if (!crypto.verify(null, Buffer.from(envelope.payload), config.signingPublicKey, Buffer.from(envelope.signature, "base64"))) fail("cloud_signature_invalid");
  return validateManifest(JSON.parse(envelope.payload), config);
}
function assertCompatible(m, baseline) {
  if (baseline.schema !== 2 || baseline.dataSchema !== m.dataSchema || baseline.base?.fingerprint !== m.base.fingerprint
      || baseline.base?.version !== m.base.version || compareVersions(baseline.base.version, m.minBaseVersion) < 0) fail("full_upgrade_required");
  if (treeHash(baseline.files.filter(f => f.component === "base")) !== m.base.fingerprint) fail("component_base_invalid");
}
module.exports = { COMPONENTS, HEX, MAX_ARCHIVE, MAX_FILES, MAX_EXPANDED, safePath, digest, hashFile, treeHash, validateFiles, validateManifest, verifyComponentManifest, assertCompatible };
