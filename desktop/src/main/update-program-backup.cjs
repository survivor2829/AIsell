const fs = process.versions.electron ? require("original-fs") : require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { checkCopySpace, copyBytes, createOwnedDirectory, removeOwnedDirectory } = require("./update-storage.cjs");
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
  const root = await fs.promises.realpath(installedRoot);
  if (path.resolve(root) === path.parse(root).root || path.resolve(parent).toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw Error("update_backup_path_invalid");
  const before = await inventory(root);
  await checkCopySpace([{ path: parent, bytes: await copyBytes(root) }]);
  const owned = await createOwnedDirectory(parent, id);
  try {
    const program = path.join(owned.directory, "program");
    await fs.promises.cp(root, program, { recursive: true, force: false, errorOnExist: true });
    if (JSON.stringify(before) !== JSON.stringify(await inventory(program))) throw Error("update_backup_verification_failed");
    const record = { installedRoot: root, program, selection, files: before };
    writeJsonAtomic(path.join(owned.directory, "program-backup.json"), record);
    return record;
  } catch (error) { await removeOwnedDirectory(owned).catch(() => {}); throw error; }
}
async function restoreProgram(record) {
  const root = path.resolve(record.installedRoot);
  if (root === path.parse(root).root || root === path.resolve(record.program)) throw Error("update_backup_path_invalid");
  if (JSON.stringify(record.files) !== JSON.stringify(await inventory(record.program))) throw Error("update_backup_verification_failed");
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
module.exports = { inventory, backupProgram, restoreProgram };
