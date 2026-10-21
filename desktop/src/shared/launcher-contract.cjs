// Fixed launcher trust primitives. Only Node builtins may be loaded here.
const crypto = require("node:crypto");
const path = require("node:path");
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const LEGACY_COMPONENTS = Object.freeze(["application", "content-engine", "product-detail", "video"]);
const COMPONENTS = Object.freeze([...LEGACY_COMPONENTS, "updater", "assets"]);
function fail(code) { throw Object.assign(new Error(code), { code }); }
function compareVersions(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b)) fail("cloud_version_invalid");
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
}
function protocolFor(value) {
  const protocol = value?.updateProtocol ?? 4;
  if (![4, 5].includes(protocol)) fail("component_protocol_invalid");
  return protocol;
}
function componentsFor(value) { return protocolFor(value) === 5 ? COMPONENTS : LEGACY_COMPONENTS; }
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
      || !m.components || Object.keys(m.components).sort().join() !== [...componentsFor(m)].sort().join()) fail("component_manifest_invalid");
  if (m.publishedAt !== undefined && (typeof m.publishedAt !== "string" || !Number.isFinite(Date.parse(m.publishedAt)))) fail("component_manifest_invalid");
  
  for (const name of componentsFor(m)) {
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
  if (!baseline || baseline.schema !== 2 || protocolFor(baseline) !== protocolFor(m) || baseline.dataSchema !== m.dataSchema || baseline.base?.fingerprint !== m.base.fingerprint
      || baseline.base?.version !== m.base.version || compareVersions(baseline.base.version, m.minBaseVersion) < 0) fail("full_upgrade_required");
  if (treeHash(baseline.files.filter(f => f.component === "base")) !== m.base.fingerprint) fail("component_base_invalid");
}
function verifyGenerationMetadata({ root, installedBaseline, envelope, composed, config }) {
  const manifest = verifyComponentManifest(envelope, config);
  assertCompatible(manifest, installedBaseline);
  if (path.basename(root) !== digest(envelope.payload)) fail("component_selection_invalid");
  assertCompatible(manifest, composed);
  const names = componentsFor(manifest);
  if (composed.files.some(file => !["base", ...names].includes(file.component))) fail("component_selection_invalid");
  for (const name of names) {
    if (treeHash(composed.files.filter(file => file.component === name)) !== manifest.components[name].treeSha256) fail("component_selection_invalid");
  }
  return manifest;
}
function verificationIdentity({ root, directoryId, envelope, composedBytes, baseline }) {
  return digest(JSON.stringify({ schema: 2, root: path.resolve(root), directoryId,
    manifest: envelope ? digest(envelope.payload) : null, composed: digest(composedBytes),
    base: { ...baseline.base, dataSchema: baseline.dataSchema, updateProtocol: protocolFor(baseline) } }));
}
module.exports = { VERSION, fail, compareVersions, COMPONENTS, LEGACY_COMPONENTS, protocolFor, componentsFor,
  HEX, MAX_ARCHIVE, MAX_FILES, MAX_EXPANDED, safePath, digest, validateFiles, treeHash,
  validateManifest, verifyComponentManifest, assertCompatible, verifyGenerationMetadata, verificationIdentity };
