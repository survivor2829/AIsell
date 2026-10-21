const fs = process.versions.electron ? require("original-fs") : require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { checkCopySpace, createOwnedDirectory, removeOwnedDirectory, metadataInventory, copySnapshot, verifySnapshot } = require("./update-storage.cjs");
const { writeJsonAtomic } = require("./atomic-file.cjs");
async function inventory(root, relative = "") {
  const result = [];
  for (const name of (await fs.promises.readdir(path.join(root, relative))).sort()) {
    const rel = path.join(relative, name), file = path.join(root, rel), stat = await fs.promises.lstat(file);
    // Installed program trees must be self-contained. Never follow a junction into customer data.
    if (stat.isSymbolicLink()) throw Error("update_program_link_unsupported");
    if (stat.isDirectory()) result.push(...await inventory(root, rel));
    else {
      const hash = crypto.createHash("sha256");
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
      result.push({ path: rel, size: stat.size, sha256: hash.digest("hex") });
    }
  }
  return result;
}
async function backupProgram(installedRoot, parent, id, selection) {
  const started = performance.now();
  const root = await fs.promises.realpath(installedRoot);
  if (path.resolve(root) === path.parse(root).root || path.resolve(parent).toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw Error("update_backup_path_invalid");
  const before = await metadataInventory(root);
  if (before.some(file => file.link)) throw Error("update_program_link_unsupported");
  await checkCopySpace([{ path: parent, bytes: before.reduce((sum, file) => sum + (file.size || 0), 0) }]);
  const owned = await createOwnedDirectory(parent, id);
  try {
    const program = path.join(owned.directory, "program");
    const copied = await copySnapshot(root, program, before, undefined, { allowLinks: false });
    const record = { installedRoot: root, program, selection, files: copied.files, verification: copied.verification,
      programIdentity: await programIdentity(root, selection), owned,
      timing: { durationMs: Math.round(performance.now() - started), bytes: copied.files.reduce((sum, file) => sum + file.size, 0), entries: copied.files.length } };
    writeJsonAtomic(path.join(owned.directory, "program-backup.json"), record);
    return record;
  } catch (error) { await removeOwnedDirectory(owned).catch(() => {}); throw error; }
}
async function programIdentity(root, selection) {
  try {
    const bytes = await fs.promises.readFile(path.join(root, "component-base.json"));
    const baseline = JSON.parse(bytes);
    if (!baseline.base?.fingerprint || !Array.isArray(baseline.files)) return null;
    return crypto.createHash("sha256").update(JSON.stringify({
      baseline: crypto.createHash("sha256").update(bytes).digest("hex"),
      active: selection?.active || null, previous: selection?.previous || null
    })).digest("hex");
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function verifyProgram(record, { fresh = false } = {}) {
  if (!fresh && await verifySnapshot(record.program, record.files, record.verification)) return;
  if (JSON.stringify(record.files) !== JSON.stringify(await inventory(record.program))) throw Error("update_backup_verification_failed");
  record.verification = { schema: 1, files: record.files, metadata: await metadataInventory(record.program) };
}
async function restoreProgram(record) {
  const root = path.resolve(record.installedRoot);
  if (root === path.parse(root).root || root === path.resolve(record.program)) throw Error("update_backup_path_invalid");
  await verifyProgram(record, { fresh: true });
  await checkCopySpace([{ path: path.dirname(root), bytes: record.files.reduce((sum, file) => sum + file.size, 0) }]);
  // Preserve the failed install for diagnosis; never recursively delete it or any business data.
  const failed = root + ".failed-update-" + crypto.randomUUID();
  if (fs.existsSync(root)) {
    if ((await fs.promises.lstat(root)).isSymbolicLink() || path.resolve(await fs.promises.realpath(root)).toLowerCase() !== root.toLowerCase()) throw Error("update_backup_path_invalid");
    await fs.promises.rename(root, failed);
  }
  await fs.promises.cp(record.program, root, { recursive: true, force: false, errorOnExist: true });
  if (JSON.stringify(record.files) !== JSON.stringify(await inventory(root))) throw Error("update_restore_verification_failed");
  return failed;
}
module.exports = { inventory, backupProgram, restoreProgram, verifyProgram, programIdentity };
