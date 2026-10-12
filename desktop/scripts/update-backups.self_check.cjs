const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { backupProgram } = require("../src/main/update-program-backup.cjs");
const { captureData, registerSet, confirmSet, readRegistry, checkPreservedData, reusableProgram } = require("../src/main/update-backups.cjs");
const { createOwnedDirectory, removeOwnedDirectory } = require("../src/main/update-storage.cjs");
const { fork } = require("node:child_process");

if (process.argv[2] === "--hold-registry") {
  const read = fs.readdir, profile = process.argv[3];
  fs.readdir = async (...args) => {
    if (args[0] === profile) { process.send("locked"); return new Promise(() => {}); }
    return read(...args);
  };
  captureData(profile, randomUUID()).catch(error => { process.send({ error: error.message }); process.exitCode = 1; });
} else

(async () => {
  const parent = path.resolve(__dirname, "../.build/backup-governance-tests");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "run-"));
  try {
    const profile = path.join(root, "profile"), program = path.join(root, "installed"), outside = path.join(root, "original-materials");
    for (const dir of [profile, program, outside]) await fs.mkdir(dir);
    await fs.writeFile(path.join(program, "app.asar"), "physical application archive");
    await fs.writeFile(path.join(outside, "source.mp4"), "unique source material");
    await fs.symlink(outside, path.join(profile, "material-link"), "junction");
    for (const [relative, content] of Object.entries({ "Cache/browser.bin": "regenerable", "Code Cache/js.bin": "regenerable",
      "content-engine/generated/result.mp4": "finished production", "content-engine/batch-exports/output.mp4": "export",
      "data/Cache/receipt.json": "customer-named folder", "license.enc": "encrypted authorization", "content-engine/content.db": "business database" })) {
      const file = path.join(profile, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
    }
    const make = async (kind = "automatic") => {
      const id = randomUUID();
      const programBackup = await reusableProgram(profile, program, {}) || await backupProgram(program, path.join(root, "programs"), id, {});
      const data = await captureData(profile, id);
      const set = await registerSet(profile, { id, version: "1.1.78", kind, programBackup, data });
      return set;
    };
    const first = await make("manual");
    const legacyMutable = ["DevToolsActivePort", path.join("Network", "Network Persistent State")];
    for (const relative of legacyMutable) {
      assert.equal(await checkPreservedData(profile, { ...first.data, files: [{ path: relative, size: 1, sha256: "old" }] }), true,
        "older snapshots may include disposable Chromium state");
    }
    for (const relative of ["data/active_touch/touch_task.json.bak", "product-detail/database/desktop-ai-refine-ledger.json"]) {
      const old = path.join(first.data.directory, relative), live = path.join(profile, relative);
      await fs.mkdir(path.dirname(old), { recursive: true }); await fs.mkdir(path.dirname(live), { recursive: true });
      await fs.writeFile(old, JSON.stringify({ updated_at: 1, finished_at: 1, outcome: "outcome_unknown" }));
      const next = { updated_at: 2, finished_at: relative.includes("ledger") ? 2 : 1, outcome: "outcome_unknown" };
      await fs.writeFile(live, JSON.stringify(next));
      const data = { ...first.data, files: [{ path: relative, size: 1, sha256: "old" }] };
      assert.equal(await checkPreservedData(profile, data), true);
      await fs.writeFile(live, JSON.stringify({ ...next, outcome: "sent" }));
      assert.equal(await checkPreservedData(profile, data), false, "receipt changes cannot masquerade as refreshed timestamps");
      await fs.unlink(old); await fs.unlink(live);
    }
    assert.equal(first.data.files.some(file => file.path.startsWith("Cache")), false);
    assert.ok(first.data.files.some(file => file.path === path.join("data", "Cache", "receipt.json")));
    assert.ok(first.data.files.some(file => file.path === path.join("content-engine", "generated", "result.mp4")));
    const holder = fork(__filename, ["--hold-registry", profile], { silent: true });
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error("registry holder timed out")), 10000);
        holder.once("message", message => { clearTimeout(timeout); message === "locked" ? resolve() : reject(Error(JSON.stringify(message))); });
        holder.once("error", reject);
      });
      await Promise.all([1, 2].map(() => assert.rejects(captureData(profile, randomUUID()), /registry_busy/, "concurrent contenders cannot displace a live owner")));
    } finally {
      const exited = new Promise(resolve => holder.once("exit", resolve)); holder.kill(); await exited;
    }
    const second = await make();
    assert.equal(second.data.directory, first.data.directory, "manual-to-auto exact content reuse avoids a second business copy");
    assert.equal(second.programBackup.program, first.programBackup.program, "verified identical program can be reused");
    await assert.rejects(confirmSet(profile, second.id, { targetVersion: "1.1.79", ack: { ok: true, version: "1.1.78" }, dataCheck: true }), /confirmation_required/);
    await assert.rejects(confirmSet(profile, second.id, { targetVersion: "1.1.79", ack: { ok: true, version: "1.1.79" }, dataCheck: false }), /confirmation_required/);
    const confirm = async set => confirmSet(profile, set.id, { targetVersion: "1.1.79", ack: { ok: true, version: "1.1.79" }, dataCheck: await checkPreservedData(profile, set.data) });
    await confirm(second);
    assert.equal(readRegistry(profile).sets.length, 1);
    await fs.access(first.data.directory); // Shared ownership must survive retiring the manual record.
    await fs.writeFile(path.join(profile, "content-engine/content.db"), "new business database");
    await fs.writeFile(path.join(program, "app.asar"), "new application archive");
    const third = await make();
    assert.notEqual(third.data.directory, second.data.directory, "changed business bytes forbid reuse");
    await fs.writeFile(path.join(third.data.directory, "license.enc"), "tampered backup");
    await assert.rejects(confirm(third), /verification_failed/);
    await fs.access(second.data.directory);
    await fs.writeFile(path.join(third.data.directory, "license.enc"), "encrypted authorization");
    await fs.unlink(path.join(profile, "license.enc"));
    assert.equal(await checkPreservedData(profile, third.data), false, "missing business data prevents retirement");
    await fs.writeFile(path.join(profile, "license.enc"), "encrypted authorization");
    await fs.writeFile(path.join(profile, "content-engine/generated/result.mp4"), "damaged media");
    assert.equal(await checkPreservedData(profile, third.data), false, "existing but damaged production files prevent cleanup");
    await fs.writeFile(path.join(profile, "content-engine/generated/result.mp4"), "finished production");
    const unfinished = await make();
    await confirm(third);
    await assert.rejects(fs.stat(second.data.directory), { code: "ENOENT" });
    await assert.rejects(fs.stat(path.dirname(second.programBackup.program)), { code: "ENOENT" });
    assert.ok(readRegistry(profile).sets.some(set => set.id === unfinished.id && set.state === "prepared"), "unconfirmed failure evidence stays protected");
    assert.equal(await fs.readFile(path.join(outside, "source.mp4"), "utf8"), "unique source material", "owned backup cleanup unlinks junctions without traversing original materials");
    const owned = await createOwnedDirectory(path.join(root, "retry-removal"), "owned"), remove = fs.rm;
    await fs.symlink(outside, path.join(owned.directory, "materials"), "junction");
    fs.rm = async (...args) => {
      if (path.basename(args[0]).startsWith(".discard-")) throw Object.assign(Error("fixture busy"), { code: "EBUSY" });
      return remove(...args);
    };
    try { await assert.rejects(removeOwnedDirectory(owned), { code: "EBUSY" }); }
    finally { fs.rm = remove; }
    await fs.mkdir(owned.directory);
    await fs.writeFile(path.join(owned.directory, "unrelated.txt"), "replacement must survive");
    await removeOwnedDirectory(owned);
    assert.deepEqual(await fs.readdir(owned.parent), ["owned"], "retry finds and removes the same quarantined inode");
    assert.equal(await fs.readFile(path.join(owned.directory, "unrelated.txt"), "utf8"), "replacement must survive");
    assert.equal(await fs.readFile(path.join(outside, "source.mp4"), "utf8"), "unique source material");
    console.log("Update backup governance self-check passed.");
  } finally {
    assert.equal(path.dirname(root), parent);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
