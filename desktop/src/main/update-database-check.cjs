const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { hashFile } = require("../shared/component-contract.cjs");
const { createOwnedDirectory, removeOwnedDirectory } = require("./update-storage.cjs");

async function checkDatabase(previous, current, { runtimeRoot, command } = {}) {
  const owned = await createOwnedDirectory(os.tmpdir(), "xiaoxi-db-check-" + require("node:crypto").randomUUID());
  try {
    // SQLite may create an SHM file even for a read-only WAL connection. Work on
    // private copies, never checkpoint or open the customer's database for writes.
    const copies = [];
    for (const [index, source] of [previous, current].entries()) {
      const target = path.join(owned.directory, String(index) + ".db");
      for (const suffix of ["", "-wal"]) {
        const file = source + suffix;
        try {
          const stat = await fs.promises.lstat(file);
          if (stat.isSymbolicLink() || !stat.isFile()) throw Error("database_snapshot_unsafe");
          const before = await hashFile(file);
          await fs.promises.copyFile(file, target + suffix, fs.constants.COPYFILE_EXCL);
          if (before !== await hashFile(file) || before !== await hashFile(target + suffix)) throw Error("database_snapshot_changed");
          copies.push([file, before]);
        } catch (error) { if (suffix && error.code === "ENOENT") { copies.push([file, null]); continue; } throw error; }
      }
    }
    // Check both DB and WAL again after the pair has been copied.
    for (const [file, hash] of copies) {
      let actual = null;
      try { actual = await hashFile(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (actual !== hash) throw Error("database_snapshot_changed");
    }
    const executable = command?.[0] || path.join(runtimeRoot, "resources/content-engine/content-engine-worker.exe");
    const args = [...(command?.slice(1) || []), "--check-update-database",
      path.join(owned.directory, "0.db"), path.join(owned.directory, "1.db"), path.basename(previous)];
    return await new Promise((resolve, reject) => execFile(executable, args,
      { windowsHide: true, timeout: 60000, maxBuffer: 65536, encoding: "utf8" }, (error, stdout) => {
        if (error) return reject(Error("database_verifier_unavailable"));
        try { const result = JSON.parse(stdout); resolve({ ok: result.ok === true, reason: result.reason, table: result.table }); }
        catch { reject(Error("database_verifier_invalid")); }
      }));
  } finally { await removeOwnedDirectory(owned); }
}
module.exports = { checkDatabase };
