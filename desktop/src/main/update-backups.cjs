// One registry for manual acceptance and automatic full-upgrade rollback sets.
// Inventory physical ASARs and link identities; never traverse profile junctions.
const fs = process.versions.electron ? require("original-fs") : require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { backupFilter, copyBytes, checkCopySpace, createOwnedDirectory, removeOwnedDirectory } = require("./update-storage.cjs");
const { inventory } = require("./update-program-backup.cjs");
const { hashFile } = require("../shared/component-contract.cjs");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const registryPath = profile => path.join(profile, "data/cloud-maintenance/components/backup-registry.json");
function readRegistry(profile) {
  try {
    const value = JSON.parse(fs.readFileSync(registryPath(profile), "utf8"));
    if (value.schema !== 1 || !Array.isArray(value.sets)) throw Error("update_backup_registry_invalid");
    return value;
  } catch (error) { if (error.code === "ENOENT") return { schema: 1, sets: [] }; throw error; }
}
async function withRegistry(profile, action) {
  const file = registryPath(profile); await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const canonical = await fs.promises.realpath(profile);
  const key = crypto.createHash("sha256").update(process.platform === "win32" ? canonical.toLowerCase() : canonical).digest("hex");
  // The kernel owns this lock and releases it on process death. No stale file
  // reclamation can race with another writer or strand an ownerless claim.
  const server = require("node:net").createServer(socket => socket.destroy());
  const endpoint = process.platform === "win32"
    ? { path: "\\\\.\\pipe\\xiaoxi-backup-" + key, exclusive: true }
    : { host: "127.0.0.1", port: 49152 + parseInt(key.slice(0, 4), 16) % 16384, exclusive: true };
  await new Promise((resolve, reject) => {
    server.once("error", error => reject(error.code === "EADDRINUSE" ? Error("update_backup_registry_busy") : error));
    server.listen(endpoint, resolve);
  });
  try { return await action(readRegistry(profile), value => writeJsonAtomic(file, value)); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
async function dataInventory(root, filter = () => true, relative = "") {
  const result = [];
  for (const name of (await fs.promises.readdir(path.join(root, relative))).sort()) {
    const rel = path.join(relative, name), file = path.join(root, rel);
    if (!filter(file)) continue;
    const stat = await fs.promises.lstat(file);
    if (stat.isSymbolicLink()) {
      // Windows cp/readlink may add a trailing separator; compare resolved targets.
      result.push({ path: rel, link: path.resolve(path.dirname(file), await fs.promises.readlink(file)).replace(/[\\/]+$/, "") });
    } else if (stat.isDirectory()) result.push(...await dataInventory(root, filter, rel));
    else {
      result.push({ path: rel, size: stat.size, sha256: await hashFile(file) });
    }
  }
  return result;
}
async function verifyData(data) {
  const receipt = path.join(data.directory, "update-backup.json");
  const includesReceipt = data.files.some(file => file.path === "update-backup.json");
  if (!same(data.files, await dataInventory(data.directory, file => includesReceipt || file !== receipt))) throw Error("update_backup_verification_failed");
}
async function verifySet(set) {
  await verifyData(set.data);
  if (!same(set.programBackup.files, await inventory(set.programBackup.program))) throw Error("update_backup_verification_failed");
}
async function captureData(profile, id, destination) {
  profile = await fs.promises.realpath(profile);
  return withRegistry(profile, async registry => {
    const filter = backupFilter(profile), files = await dataInventory(profile, filter);
    for (const set of [...registry.sets].reverse()) {
      if (set.state === "retiring" || !same(files, set.data.files)) continue;
      try {
        await verifyData(set.data);
        if (!same(files, await dataInventory(profile, filter))) throw Error("update_backup_source_changed");
        return { ...set.data, reused: true, owners: set.owners.filter(owner => contains(owner.directory, set.data.directory)) };
      } catch (error) { if (error.message === "update_backup_source_changed") throw error; }
    }
    const parent = destination || path.join(path.dirname(profile), path.basename(profile) + "-update-backups");
    await checkCopySpace([{ path: parent, bytes: await copyBytes(profile, filter) }]);
    const owned = await createOwnedDirectory(parent, id);
    try {
      // The root was exclusively created above; Node 24 rejects errorOnExist
      // for that empty root while Electron's Node accepts it.
      await fs.promises.cp(profile, owned.directory, { recursive: true, force: false, filter });
      const data = { directory: owned.directory, files };
      await verifyData(data);
      if (!same(files, await dataInventory(profile, filter))) throw Error("update_backup_source_changed");
      writeJsonAtomic(path.join(owned.directory, "update-backup.json"), { createdAt: new Date().toISOString(), kind: "before-full-upgrade" });
      return { ...data, owners: [owned] };
    } catch (error) { await removeOwnedDirectory(owned).catch(cleanup => { error.cleanupCode = cleanup.code || cleanup.message; }); throw error; }
  });
}
function contains(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
async function reusableProgram(profile, installedRoot, selection) {
  const files = await inventory(installedRoot);
  for (const set of [...readRegistry(profile).sets].reverse()) {
    if (set.state === "retiring" || !same(selection, set.programBackup.selection) || !same(files, set.programBackup.files)) continue;
    try {
      if (!same(files, await inventory(set.programBackup.program))) continue;
      return { ...set.programBackup, installedRoot, owners: set.owners.filter(owner => contains(owner.directory, set.programBackup.program)) };
    } catch { /* Corrupt or unavailable backup cannot be reused. */ }
  }
  return null;
}
async function registerSet(profile, { id, version, programBackup, data, owners = [], kind = "automatic" }) {
  return withRegistry(profile, async (registry, save) => {
    const set = { id, version, kind, createdAt: new Date().toISOString(), state: "prepared", programBackup,
      data: { directory: data.directory, files: data.files },
      owners: [...new Map([...owners, ...(data.owners || []), ...(programBackup.owners || []), ...(programBackup.owned ? [programBackup.owned] : [])].map(owner => [owner.directory, owner])).values()] };
    await verifySet(set);
    if (registry.sets.some(entry => entry.id === id)) throw Error("update_backup_id_exists");
    registry.sets.push(set); save(registry); return set;
  });
}
async function confirmSet(profile, id, { targetVersion, ack, dataCheck }) {
  if (ack?.ok !== true || ack.version !== targetVersion || dataCheck !== true) throw Error("update_backup_confirmation_required");
  return withRegistry(profile, async (registry, save) => {
    const current = registry.sets.find(set => set.id === id);
    if (!current) throw Error("update_backup_missing");
    await verifySet(current);
    current.state = "confirmed"; current.confirmedAt = new Date().toISOString(); current.targetVersion = targetVersion;
    // Prepared/failed sets may be the sole evidence for an interrupted update.
    // Only completed sets are retired automatically, never an unregistered path.
    const expired = registry.sets.filter(set => set.id !== id && (["confirmed", "retiring"].includes(set.state) || set.kind === "manual"));
    for (const set of expired) set.state = "retiring";
    save(registry);
    const retained = registry.sets.filter(set => set.state !== "retiring");
    const protectedPaths = retained.flatMap(set => [set.data.directory, set.programBackup.program]);
    for (const old of expired) {
      let complete = true;
      for (const owner of old.owners) {
        if (protectedPaths.some(file => contains(owner.directory, file))) continue;
        try { await removeOwnedDirectory(owner); }
        catch (error) { if (error.code !== "ENOENT") { complete = false; console.warn(`Backup cleanup deferred: ${error.code || error.message}`); } }
      }
      if (complete) registry.sets = registry.sets.filter(set => set.id !== old.id);
    }
    save(registry); return current;
  });
}
// Startup is allowed to update databases and receipts. Require every previously
// backed-up business file to remain present, instead of comparing mutable bytes.
async function checkPreservedData(profile, data) {
  for (const file of data.files) {
    if (file.link || /(^|[\\/])(logs?|diagnostics)([\\/]|$)/i.test(file.path)) continue;
    try {
      const live = path.join(profile, file.path), stat = await fs.promises.lstat(live);
      if (!stat.isFile()) return false;
      // Media, customer originals, licensing and other immutable files must keep
      // their exact bytes. Only known mutable storage formats bypass byte equality.
      if (/\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$/i.test(file.path)) {
        if (stat.size === 0 && file.size > 0) return false;
        continue;
      }
      if (/^(?:Local Storage|Session Storage|Partitions)[\\/]/i.test(file.path)
          || /(?:^|[\\/])(?:Preferences|Local State|run-bill\.txt|.*\.jsonl)$/.test(file.path)) continue;
      if (await hashFile(live) === file.sha256) continue;
      if (/\.json$/i.test(file.path)) {
        const stable = value => {
          if (Array.isArray(value)) return value.map(stable);
          if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !["updated_at", "updatedAt", "generated_at", "generatedAt"].includes(key)).map(([key, item]) => [key, stable(item)]));
          return value;
        };
        if (same(stable(JSON.parse(await fs.promises.readFile(live, "utf8"))), stable(JSON.parse(await fs.promises.readFile(path.join(data.directory, file.path), "utf8"))))) continue;
      }
      return false;
    }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }
  return true;
}
module.exports = { readRegistry, dataInventory, verifyData, verifySet, captureData, reusableProgram, registerSet, confirmSet, checkPreservedData };
