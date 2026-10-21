const fs = process.versions.electron ? require("original-fs") : require("node:fs");
const crypto = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-file.cjs");

async function downloadProof(file, expected) {
  const stat = await fs.promises.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.size) !== expected.size) throw Error("cloud_download_invalid");
  return { schema: 1, sha256: expected.sha256, size: Number(stat.size),
    mtimeMs: Number(stat.mtimeNs) / 1e6, identity: [stat.dev, stat.ino, stat.mtimeNs].map(String).join(":"), verifiedAt: new Date().toISOString() };
}

// A transport proof is produced only after its streaming SHA-256 succeeds.
// A missing or changed local receipt costs one fresh read, never trust by name.
async function verifyDownload(file, expected, { proof } = {}) {
  const current = await downloadProof(file, expected);
  const matches = record => record?.schema === 1 && record.sha256 === current.sha256
    && record.size === current.size && record.mtimeMs === current.mtimeMs && record.identity === current.identity
    && Number.isFinite(Date.parse(record.verifiedAt || ""));
  let saved;
  try { saved = JSON.parse(await fs.promises.readFile(file + ".verified.json", "utf8")); } catch { /* First verification. */ }
  const verified = matches(proof) ? proof : matches(saved) ? saved : null;
  if (!verified) {
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    if (hash.digest("hex") !== expected.sha256 || !matches(await downloadProof(file, expected))) throw Error("cloud_download_invalid");
  }
  const receipt = { ...current, verifiedAt: verified?.verifiedAt || new Date().toISOString() };
  if (!matches(saved)) writeJsonAtomic(file + ".verified.json", receipt);
  return receipt;
}

module.exports = { downloadProof, verifyDownload };
