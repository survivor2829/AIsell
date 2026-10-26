// One registry for manual acceptance and automatic full-upgrade rollback sets.
// Inventory physical ASARs and link identities; never traverse profile junctions.
const fs = process.versions.electron ? require("original-fs") : require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { backupFilter, isRegenerableProfileFile, checkCopySpace, createOwnedDirectory, removeOwnedDirectory, metadataInventory, copySnapshot, verifySnapshot } = require("./update-storage.cjs");
const { inventory, verifyProgram, programIdentity } = require("./update-program-backup.cjs");
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
  // Preserve the deployed backup pipe identity while sharing the crash-safe lease.
  const release = await require("./update-process-lock.cjs").acquireProcessLock(canonical, { namespace: "backup", timeoutMs: 0 });
  try { return await action(readRegistry(profile), value => writeJsonAtomic(file, value)); }
  finally { await release(); }
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
  const filter = file => includesReceipt || file !== receipt;
  if (await verifySnapshot(data.directory, data.files, data.verification, { ignored: includesReceipt ? [] : ["update-backup.json"] })) return;
  if (!same(data.files, await dataInventory(data.directory, filter))) throw Error("update_backup_verification_failed");
  data.verification = { schema: 1, files: data.files, metadata: await metadataInventory(data.directory, filter) };
}
async function verifySet(set) {
  await verifyData(set.data);
  await verifyProgram(set.programBackup);
}
async function captureData(profile, id, destination) {
  profile = await fs.promises.realpath(profile);
  return withRegistry(profile, async registry => {
    const filter = backupFilter(profile), sourceMetadata = await metadataInventory(profile, filter);
    for (const set of [...registry.sets].reverse()) {
      if (set.state === "retiring" || !same(sourceMetadata, set.data.sourceMetadata)) continue;
      try {
        await verifyData(set.data);
        if (!same(sourceMetadata, await metadataInventory(profile, filter))) throw Error("update_backup_source_changed");
        return { ...set.data, sourceMetadata, reused: true, owners: set.owners.filter(owner => contains(owner.directory, set.data.directory)) };
      } catch (error) { if (error.message === "update_backup_source_changed") throw error; }
    }
    const parent = destination || path.join(path.dirname(profile), path.basename(profile) + "-update-backups");
    await checkCopySpace([{ path: parent, bytes: sourceMetadata.reduce((sum, file) => sum + (file.size || 0), 0) }]);
    const owned = await createOwnedDirectory(parent, id);
    try {
      const copied = await copySnapshot(profile, owned.directory, sourceMetadata, filter);
      const data = { directory: owned.directory, ...copied };
      // If metadata changed but all copied bytes stayed identical, reuse the
      // original set after the same single source read. Never prehash the whole
      // live profile merely to decide whether another copy is necessary.
      for (const set of [...registry.sets].reverse()) {
        if (set.state === "retiring" || !same(data.files, set.data.files)) continue;
        try { await verifyData(set.data); }
        catch { continue; }
        await removeOwnedDirectory(owned);
        return { ...set.data, sourceMetadata, reused: true, owners: set.owners.filter(owner => contains(owner.directory, set.data.directory)) };
      }
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
  const identity = await programIdentity(installedRoot, selection);
  const files = identity ? null : await inventory(installedRoot);
  for (const set of [...readRegistry(profile).sets].reverse()) {
    if (set.state === "retiring" || !same(selection, set.programBackup.selection)
        || (identity ? identity !== set.programBackup.programIdentity : !same(files, set.programBackup.files))) continue;
    try {
      await verifyProgram(set.programBackup);
      return { ...set.programBackup, installedRoot, owners: set.owners.filter(owner => contains(owner.directory, set.programBackup.program)) };
    } catch { /* Corrupt or unavailable backup cannot be reused. */ }
  }
  return null;
}
async function registerSet(profile, { id, version, programBackup, data, owners = [], kind = "automatic" }) {
  if (!["automatic", "acceptance", "manual"].includes(kind)) throw Error("update_backup_kind_invalid");
  return withRegistry(profile, async (registry, save) => {
    const set = { id, version, kind, rotationPolicy: kind === "manual" ? "pinned" : "latest-confirmed",
      createdAt: new Date().toISOString(), state: "prepared", programBackup,
      data: { directory: data.directory, files: data.files, verification: data.verification, sourceMetadata: data.sourceMetadata },
      owners: [...new Map([...owners, ...(data.owners || []), ...(programBackup.owners || []), ...(programBackup.owned ? [programBackup.owned] : [])].map(owner => [owner.directory, owner])).values()] };
    await verifySet(set);
    if (registry.sets.some(entry => entry.id === id)) throw Error("update_backup_id_exists");
    registry.sets.push(set); save(registry); return set;
  });
}
async function markReused(profile, id) {
  return withRegistry(profile, async (registry, save) => {
    const set = registry.sets.find(entry => entry.id === id);
    if (!set) throw Error("update_backup_missing");
    set.reusedAt = new Date().toISOString(); save(registry); return set;
  });
}
async function confirmSet(profile, id, { targetVersion, ack, dataCheck }) {
  const checked = dataCheck === true || dataCheck?.ok === true;
  if (ack?.ok !== true || ack.version !== targetVersion || !checked) {
    await withRegistry(profile, async (registry, save) => {
      const current = registry.sets.find(set => set.id === id);
      if (current) {
        current.confirmationFailure = dataCheck?.issues || [{ reason: "startup_or_data_confirmation_missing" }];
        if (ack?.ok === true && ack.version === targetVersion) current.confirmationTarget = targetVersion;
        save(registry);
      }
    });
    throw Error("update_backup_confirmation_required");
  }
  return withRegistry(profile, async (registry, save) => {
    const current = registry.sets.find(set => set.id === id);
    if (!current) throw Error("update_backup_missing");
    await verifySet(current);
    current.state = "confirmed"; current.confirmedAt = new Date().toISOString(); current.targetVersion = targetVersion;
    delete current.confirmationFailure;
    delete current.confirmationTarget;
    // Prepared/failed sets may be the sole evidence for an interrupted update.
    // Only completed sets are retired automatically, never an unregistered path.
    // Old unclassified backups are historical candidates, never silently adopted.
    // An internal acceptance run that was never confirmed is superseded once a
    // later acceptance run is confirmed; otherwise it pins old component
    // generations forever. Automatic (customer) sets keep the stricter rule.
    // A reused set counts from its last reuse, so a run that picked up an old set is not mistaken for a stale one.
    const lastUsed = set => Math.max(Date.parse(set.createdAt), Date.parse(set.reusedAt || set.createdAt));
    const superseded = set => current.kind === "acceptance" && lastUsed(set) < lastUsed(current);
    const expired = registry.sets.filter(set => current.rotationPolicy === "latest-confirmed" && set.id !== id && set.rotationPolicy === "latest-confirmed"
      && (["confirmed", "retiring"].includes(set.state)
        || (set.kind === "acceptance" && set.state === "prepared" && !set.confirmationFailure
          && (set.data.directory === current.data.directory && set.programBackup.program === current.programBackup.program || superseded(set)))));
    for (const set of expired) set.state = "retiring";
    save(registry);
    await retireSets(profile, registry, save);
    return current;
  });
}
async function retireSets(profile, registry, save) {
    const before = registry.sets.length;
    const expired = registry.sets.filter(set => set.state === "retiring" && set.rotationPolicy === "latest-confirmed");
    const retained = registry.sets.filter(set => !expired.includes(set));
    const ready = [];
    for (const old of expired) {
      try {
        old.preservation = await require("./update-backup-preservation.cjs").preserveBackup(profile, old, retained, verifySet);
        ready.push(old);
      } catch (error) {
        old.cleanupFailure = { stage: "preservation", code: error.code || error.message, at: new Date().toISOString() };
      }
    }
    // Several sets may share one captured data/program directory. Preserve all
    // of them before deleting any owner, and protect a set whose copy failed.
    save(registry);
    const protectedPaths = registry.sets.filter(set => !ready.includes(set)).flatMap(set => [set.data.directory, set.programBackup.program]);
    for (const old of ready) {
      let complete = true;
      for (const owner of old.owners) {
        if (protectedPaths.some(file => contains(owner.directory, file))) continue;
        try { await removeOwnedDirectory(owner); }
        catch (error) {
          if (error.code !== "ENOENT") {
            complete = false;
            old.cleanupFailure = { code: error.code || error.message, at: new Date().toISOString() };
            console.warn(`Backup cleanup deferred: ${error.code || error.message}`);
          }
        }
      }
      if (complete) registry.sets = registry.sets.filter(set => set.id !== old.id);
    }
    save(registry);
    return before - registry.sets.length;
}
async function retryRetiringBackups(profile) {
  if (!readRegistry(profile).sets.some(set => set.state === "retiring" && set.rotationPolicy === "latest-confirmed")) return 0;
  return withRegistry(profile, (registry, save) => retireSets(profile, registry, save));
}
async function retryBackupMaintenance(profile, { version, runtimeRoot } = {}) {
  // Only an acknowledged successful launch of this exact version may retry.
  // Unknown/failed updates and older unclassified snapshots stay protected.
  const acknowledged = set => {
    if (!version) return false;
    if (set.confirmationTarget === version) return true;
    // A helper may have completed but lost the registry lock before confirmSet.
    // Recover its durable job + ACK instead of stranding an unmarked snapshot.
    try {
      if (!/^[a-f0-9-]{36}$/.test(set.id)) return false;
      const jobs = path.join(profile, "data/cloud-maintenance/components/jobs");
      const read = suffix => JSON.parse(fs.readFileSync(path.join(jobs, set.id + suffix + ".json"), "utf8"));
      const job = read(""), ack = read(".ack"), status = read(".status");
      return job.id === set.id && job.targetVersion === version && ack.ok === true && ack.version === version
        && status.phase === "complete" && job.programBackup?.program === set.programBackup.program;
    } catch { return false; }
  };
  const pending = readRegistry(profile).sets.filter(set => set.state === "prepared"
    && set.rotationPolicy === "latest-confirmed" && acknowledged(set));
  for (const set of pending) {
    try {
      await confirmSet(profile, set.id, { targetVersion: version, ack: { ok: true, version },
        dataCheck: await inspectPreservedData(profile, set.data, { runtimeRoot }) });
    } catch (error) { console.warn(`Backup confirmation deferred: ${error.code || error.message}`); }
  }
  return retryRetiringBackups(profile);
}
// Startup is allowed to update databases and receipts. Require every previously
// backed-up business file to remain present, instead of comparing mutable bytes.
async function inspectPreservedData(profile, data, options = {}) {
  const failure = (file, reason, extra = {}) => ({ ok: false, issues: [{ path: file, reason, ...extra }] });
  const databaseFiles = new Set(data.files.filter(file => !file.link && file.size > 0 && /\.(?:db|sqlite|sqlite3)$/i.test(file.path)).map(file => file.path));
  const checkedDatabases = new Set();
  for (const relative of databaseFiles) {
    try {
      const previous = path.join(data.directory, relative), current = path.join(profile, relative);
      const entry = data.files.find(file => file.path === relative), wal = data.files.find(file => file.path === relative + "-wal");
      const walHash = async file => { try { return (await fs.promises.stat(file)).size ? await hashFile(file) : null; } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
      if (await hashFile(current) !== entry.sha256 || await walHash(current + "-wal") !== (wal?.size ? wal.sha256 : null)) {
        const result = await (options.databaseVerifier || require("./update-database-check.cjs").checkDatabase)(previous, current, options);
        if (!result.ok) return failure(relative, result.reason || "database_verification_failed", { table: result.table });
      }
      checkedDatabases.add(relative);
    } catch (error) { return failure(relative, error.code === "ENOENT" ? "database_missing" : error.message || "database_verification_failed"); }
  }
  for (const file of data.files) {
    if (isRegenerableProfileFile(file.path) || /(^|[\\/])(logs?|diagnostics)([\\/]|$)/i.test(file.path)) continue;
    // A clean close may remove SQLite's rebuilt shared-memory index or an
    // already empty WAL. Keep both in the snapshot; never exempt a nonempty
    // WAL, and still require the corresponding backed-up database.
    const transientSqliteFile = /\.(?:db|sqlite|sqlite3)-(?:shm|wal)$/i.test(file.path);
    if (transientSqliteFile && databaseFiles.has(file.path.slice(0, -4))) {
      try {
        const database = await fs.promises.lstat(path.join(profile, file.path.slice(0, -4)));
        if (!database.isFile() || database.size === 0 || !checkedDatabases.has(file.path.slice(0, -4))) return failure(file.path, "database_not_verified");
      } catch (error) { return failure(file.path, error.code || "database_not_verified"); }
      continue;
    }
    try {
      const live = path.join(profile, file.path), stat = await fs.promises.lstat(live);
      if (file.link) {
        if (!stat.isSymbolicLink() || path.resolve(path.dirname(live), await fs.promises.readlink(live)).replace(/[\\/]+$/, "") !== file.link) return failure(file.path, "material_link_changed");
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) return failure(file.path, "business_file_type_changed");
      // Media, customer originals, licensing and other immutable files must keep
      // their exact bytes. Only known mutable storage formats bypass byte equality.
      if (/\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$/i.test(file.path)) {
        if (stat.size === 0 && file.size > 0) return failure(file.path, "database_empty");
        continue;
      }
      // Chromium updates its root-level protobuf store during media playback
      // (e.g. decode performance). Keep it in the rollback snapshot and require
      // the live file/type above, but do not treat changing LevelDB bytes as lost
      // customer data. Nested customer folders with the same name stay strict.
      if (/^(?:Local Storage|Session Storage|Partitions|shared_proto_db)[\\/]/i.test(file.path)
          || /(?:^|[\\/])(?:Preferences|Local State|run-bill\.txt|.*\.jsonl)$/.test(file.path)) continue;
      if (await hashFile(live) === file.sha256) continue;
      if (/\.json(?:\.bak)?$/i.test(file.path)) {
        const stable = value => {
          if (Array.isArray(value)) return value.map(stable);
          if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !["updated_at", "updatedAt", "generated_at", "generatedAt"].includes(key)).map(([key, item]) => [key, stable(item)]));
          return value;
        };
        const current = JSON.parse(await fs.promises.readFile(live, "utf8"));
        const previous = JSON.parse(await fs.promises.readFile(path.join(data.directory, file.path), "utf8"));
        // This is the server-synchronized official directory, not the customer's
        // material index. Keep the snapshot and check every cached file below;
        // a valid newer directory must not strand all previous rollback sets.
        if (file.path.replaceAll("\\", "/") === "data/official-materials/catalog.json") {
          const catalog = value => value?.schema === 1 && Number.isSafeInteger(value.revision) && value.revision > 0
            && Array.isArray(value.items) && Array.isArray(value.categories);
          if (!catalog(current) || !catalog(previous) || current.revision < previous.revision) return failure(file.path, "catalog_invalid");
          continue;
        }
        if (file.path.replaceAll("\\", "/") === "data/auto_reply/auto-reply-state.json"
            && current.daily_date !== previous.daily_date) {
          // normalizeState resets only the daily counter when starting on a new
          // local day. Preserve every other field, especially unknown sends.
          const validDay = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
            && Number.isFinite(Date.parse(value + "T00:00:00.000Z"))
            && new Date(value + "T00:00:00.000Z").toISOString().slice(0, 10) === value;
          const now = new Date(), today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
          if (!validDay(previous.daily_date) || !validDay(current.daily_date)
              || current.daily_date <= previous.daily_date || current.daily_date !== today
              || !Number.isSafeInteger(previous.reply_count) || previous.reply_count < 0 || current.reply_count !== 0) return failure(file.path, "daily_state_changed");
          previous.daily_date = current.daily_date;
          previous.reply_count = 0;
        }
        // Startup pauses the workflow after app shutdown. This changes only the
        // paused-state explanation, never a send receipt or unresolved outcome.
        if (file.path.replaceAll("\\", "/") === "data/auto_reply/auto-reply-state.json"
            && current.status === "paused" && previous.status === "paused"
            && [current.last_event, previous.last_event].every(event => ["app_closed", "workflow_paused"].includes(event))) {
          delete current.last_event; delete previous.last_event;
        }
        // The detail service refreshes this ledger's finish timestamp at startup.
        // All receipt fields and task outcomes must still compare exactly.
        if (file.path.replaceAll("\\", "/") === "product-detail/database/desktop-ai-refine-ledger.json") {
          delete current.finished_at; delete previous.finished_at;
        }
        if (same(stable(current), stable(previous))) continue;
      }
      return failure(file.path, "business_content_changed");
    }
    catch (error) { return failure(file.path, error.code === "ENOENT" ? "business_file_missing" : error.code || "business_file_unreadable"); }
  }
  return { ok: true, issues: [] };
}
async function checkPreservedData(profile, data, options) { return (await inspectPreservedData(profile, data, options)).ok; }
module.exports = { readRegistry, withRegistry, dataInventory, verifyData, verifySet, captureData, reusableProgram, registerSet, markReused, confirmSet, checkPreservedData, inspectPreservedData, retryRetiringBackups, retryBackupMaintenance };
