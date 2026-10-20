// Unique historical data is an archive, not another rotating program backup.
const fs = process.versions.electron ? require("original-fs") : require("node:fs");
const path = require("node:path");
const { hashFile } = require("../shared/component-contract.cjs");
const { safePath } = require("../shared/artifact-retention.cjs");
const { checkCopySpace } = require("./update-storage.cjs");
const { writeJsonAtomic } = require("./atomic-file.cjs");

async function preserveBackup(profile, old, retained, verifySet) {
  profile = fs.realpathSync(profile);
  const root = path.join(profile, "data/cloud-maintenance/preserved-backup-data");
  safePath(profile, root);
  fs.mkdirSync(root, { recursive: true });
  safePath(profile, root);
  const receipt = safePath(root, `${old.id}.json`);
  const objects = safePath(root, "objects");
  fs.mkdirSync(objects, { recursive: true });
  const objectPath = hash => {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("backup_preservation_hash_invalid");
    return safePath(root, path.join(objects, hash));
  };
  const verifyObjects = async entries => {
    for (const entry of entries) {
      if (entry.link) continue; // Record link identity; never traverse outside media.
      if (await hashFile(objectPath(entry.sha256)) !== entry.sha256) throw Error("backup_preservation_corrupt");
    }
  };
  if (fs.existsSync(receipt)) {
    const saved = JSON.parse(fs.readFileSync(receipt, "utf8"));
    if (saved.schema !== 1 || saved.id !== old.id
        || JSON.stringify(saved.inventory) !== JSON.stringify(old.data.files)) throw Error("backup_preservation_receipt_invalid");
    await verifyObjects(saved.preserved);
    return { receipt, bytes: saved.bytes, files: saved.preserved.length };
  }
  // A corrupt/changed snapshot remains protected, rather than silently discarded.
  await verifySet(old);
  const hashes = new Set();
  for (const next of retained.filter(set => set.state === "confirmed" && set.rotationPolicy === "latest-confirmed")) {
    await verifySet(next);
    for (const file of next.data.files) if (file.sha256) hashes.add(file.sha256);
  }
  const preserved = old.data.files.filter(file => file.link || !hashes.has(file.sha256));
  const unique = [...new Map(preserved.filter(file => !file.link).map(file => [file.sha256, file])).values()];
  await checkCopySpace([{ path: root, bytes: unique.filter(file => !fs.existsSync(objectPath(file.sha256))).reduce((n, file) => n + file.size, 0) }]);
  for (const file of unique) {
    const target = objectPath(file.sha256);
    if (fs.existsSync(target)) {
      if (await hashFile(target) !== file.sha256) throw Error("backup_preservation_corrupt");
      continue;
    }
    const source = safePath(old.data.directory, file.path), temporary = safePath(root, path.join(objects, file.sha256 + ".partial"));
    // Only our own fixed temporary file; a failed copy is safely overwritten.
    await fs.promises.copyFile(source, temporary);
    if (await hashFile(temporary) !== file.sha256) throw Error("backup_preservation_copy_failed");
    await fs.promises.rename(temporary, target);
  }
  await verifyObjects(preserved);
  const bytes = unique.reduce((n, file) => n + file.size, 0);
  writeJsonAtomic(receipt, { schema: 1, id: old.id, version: old.version, createdAt: new Date().toISOString(),
    inventory: old.data.files, preserved, bytes });
  fs.writeFileSync(safePath(root, "README.txt"), "旧备份独有资料保全：每个 JSON 记录原版本、原路径和 preserved 文件列表，objects/<sha256> 保存原始字节。恢复时复制到独立目录并还原文件名，不要直接覆盖当前数据。链接只记录位置，不复制外部素材。本目录可能包含授权、数据库和回执，请勿公开分享；不参与自动轮换。\n");
  return { receipt, bytes, files: preserved.length };
}
module.exports = { preserveBackup };
