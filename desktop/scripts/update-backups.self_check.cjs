const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { backupProgram } = require("../src/main/update-program-backup.cjs");
const { captureData, registerSet, confirmSet, readRegistry, checkPreservedData, reusableProgram, dataInventory, retryBackupMaintenance, withRegistry } = require("../src/main/update-backups.cjs");
const { backupFilter, copyBytes, updateFailure, createOwnedDirectory, removeOwnedDirectory } = require("../src/main/update-storage.cjs");
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
    const lockScope = path.join(root, "interrupted-maintenance.lock");
    await fs.writeFile(lockScope, "");
    const { acquireProcessLock } = require("../src/main/update-process-lock.cjs");
    const releaseLease = await acquireProcessLock(lockScope, { timeoutMs: 0 });
    try { await assert.rejects(acquireProcessLock(lockScope, { timeoutMs: 0 }), /update_maintenance_busy/); }
    finally { await releaseLease(); }
    await (await acquireProcessLock(lockScope, { timeoutMs: 0 }))();
    assert.equal(await fs.readFile(lockScope, "utf8"), "", "kernel leases neither trust nor remove a crashed publication file");
    const storage = require("../src/main/update-storage.cjs");
    const copySource = path.join(root, "copy-once-source"), copyTarget = path.join(root, "copy-once-target");
    await fs.mkdir(copySource); await fs.writeFile(path.join(copySource, "bytes.bin"), "verified-copy");
    const sourceSnapshot = await storage.metadataInventory(copySource);
    const copied = await storage.copySnapshot(copySource, copyTarget, sourceSnapshot);
    assert.equal(copied.files[0].sha256, require("node:crypto").createHash("sha256").update("verified-copy").digest("hex"));
    assert.equal(await storage.verifySnapshot(copyTarget, copied.files, copied.verification), true);
    await fs.writeFile(path.join(copyTarget, "bytes.bin"), "altered-copy");
    assert.equal(await storage.verifySnapshot(copyTarget, copied.files, copied.verification), false,
      "Changed backup bytes invalidate their copied-file receipt");
    await fs.writeFile(path.join(copySource, "extra.bin"), "source changed");
    await assert.rejects(storage.copySnapshot(copySource, path.join(root, "stale-target"), sourceSnapshot), /source_changed/);
    const installedHelper = path.join(root, "helper-installed"), helperApp = path.join(installedHelper, "resources/app");
    await fs.mkdir(helperApp, { recursive: true });
    await fs.writeFile(path.join(installedHelper, "app.exe"), "physical executable");
    await fs.writeFile(path.join(installedHelper, "runtime.dll"), "physical library");
    await fs.writeFile(path.join(helperApp, "bootstrap.cjs"), "immutable helper code");
    await fs.mkdir(path.join(installedHelper, "locales"));
    for (const name of ["icudtl.dat", "snapshot_blob.bin", "resources.pak", "locales/zh-CN.pak"]) await fs.writeFile(path.join(installedHelper, name), "mapped runtime bytes");
    await fs.writeFile(path.join(installedHelper, "component-base.json"), JSON.stringify({ base: { fingerprint: "a".repeat(64) },
      components: { updater: { treeSha256: "b".repeat(64) } } }));
    const helper = require("../src/main/update-helper.cjs");
    const helperProfile = path.join(root, "helper-profile"), helperPaths = { directory: path.join(root, "helper-profile/data/cloud-maintenance/components") };
    const options = { paths: helperPaths, installedRoot: installedHelper, applicationRoot: helperApp, executable: path.join(installedHelper, "app.exe") };
    const [helperOne, helperTwo] = await Promise.all([helper.prepareHelperRuntime(options), helper.prepareHelperRuntime(options)]);
    assert.equal(helperOne.helperExecutable, helperTwo.helperExecutable, "one base/updater identity reuses its helper runtime");
    assert.equal((await helper.prepareHelperRuntime(options)).created, false);
    assert.notEqual((await fs.stat(helperOne.helperExecutable)).ino, (await fs.stat(options.executable)).ino, "helper EXE must not share installer-locked bytes");
    assert.notEqual((await fs.stat(path.join(helperOne.owned.directory, "runtime.dll"))).ino, (await fs.stat(path.join(installedHelper, "runtime.dll"))).ino);
    for (const name of ["icudtl.dat", "snapshot_blob.bin", "resources.pak", "locales/zh-CN.pak"]) {
      assert.notEqual((await fs.stat(path.join(helperOne.owned.directory, name))).ino, (await fs.stat(path.join(installedHelper, name))).ino, `${name} must not share memory-mapped bytes with retired generations`);
    }
    assert.equal((await fs.stat(path.join(helperOne.owned.directory, "resources/app/bootstrap.cjs"))).ino, (await fs.stat(path.join(helperApp, "bootstrap.cjs"))).ino);
    assert.equal((await helper.prepareHelperRuntime(options)).helperExecutable, helperOne.helperExecutable,
      "The shared helper cache is independent of update job history");
    const failedProfile = path.join(root, "failed-helper-profile"), failedRoot = path.join(failedProfile, "data/cloud-maintenance/components");
    const failedHelperCopy = fs.copyFile, failedHelperRemove = fs.rm;
    fs.copyFile = async (source, ...args) => {
      if (source === path.join(installedHelper, "icudtl.dat")) throw Object.assign(Error("copy interrupted"), { code: "EIO" });
      return failedHelperCopy(source, ...args);
    };
    fs.rm = async (target, ...args) => {
      if (target.startsWith(failedRoot + path.sep) && path.basename(target).startsWith(".discard-")) throw Object.assign(Error("external file lock"), { code: "EBUSY" });
      return failedHelperRemove(target, ...args);
    };
    try { await assert.rejects(helper.prepareHelperRuntime({ ...options, paths: { directory: failedRoot } }), { code: "EIO" }); }
    finally { fs.copyFile = failedHelperCopy; fs.rm = failedHelperRemove; }
    const quarantines = (await fs.readdir(path.join(failedRoot, "helper-runtime"))).filter(name => name.startsWith(".discard-"));
    assert.equal(quarantines.length, 1);
    const retirement = require("../src/main/update-exit-maintenance.cjs").retirementStatus(failedProfile);
    assert.equal(retirement.pending, true, "failed helper quarantine must remain registered for automatic exit retry");
    const unknownQuarantine = path.join(failedRoot, "helper-runtime/.discard-historical");
    await fs.mkdir(unknownQuarantine); await fs.writeFile(path.join(unknownQuarantine, "unique.txt"), "preserve");
    require("../src/shared/artifact-retention.cjs").retryArtifacts(failedRoot);
    await assert.rejects(fs.stat(path.join(failedRoot, "helper-runtime", quarantines[0])), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(unknownQuarantine, "unique.txt"), "utf8"), "preserve");
    const obsoleteHelperFile = path.join(helperPaths.directory, "obsolete-exit-file");
    await fs.writeFile(obsoleteHelperFile, "owned temporary file");
    require("../src/shared/artifact-retention.cjs").retainArtifacts(helperPaths.directory, "exit-prepare-fixture", [], 1, [obsoleteHelperFile], { deferCleanup: true });
    await fs.writeFile(path.join(installedHelper, "component-base.json"), JSON.stringify({ base: { fingerprint: "a".repeat(64) }, components: { updater: { treeSha256: "c".repeat(64) } } }));
    const exitMaintenance = require("../src/main/update-exit-maintenance.cjs"), exitOptions = { profile: helperProfile, runtimeRoot: installedHelper, executable: options.executable };
    const preparation = exitMaintenance.prepareExitMaintenance(exitOptions);
    assert.equal(exitMaintenance.prepareExitMaintenance(exitOptions), preparation, "startup and exit share one background preparation");
    const newIdentity = await preparation;
    assert.notEqual(newIdentity.identity, helperOne.identity, "an updater change prepares its own helper without a prior update job");
    assert.equal((await helper.prepareHelperRuntime(options)).helperExecutable, newIdentity.helperExecutable);
    await fs.writeFile(path.join(installedHelper, "component-base.json"), JSON.stringify({ base: { fingerprint: "a".repeat(64) }, components: { updater: { treeSha256: "d".repeat(64) } } }));
    const outsideHelper = await createOwnedDirectory(root, "outside-helper-cache");
    const uniqueOutside = path.join(outsideHelper.directory, "unique.txt"); await fs.writeFile(uniqueOutside, "must remain");
    const interruptedId = helper.helperRuntimeIdentity(installedHelper, helperApp), interruptedDirectory = path.join(helperPaths.directory, "helper-runtime", interruptedId);
    await fs.mkdir(interruptedDirectory);
    await fs.writeFile(path.join(interruptedDirectory, ".helper-preparing.json"), JSON.stringify({ identity: interruptedId, owned: outsideHelper }));
    await assert.rejects(helper.prepareHelperRuntime(options));
    assert.equal(await fs.readFile(uniqueOutside, "utf8"), "must remain", "a preparing receipt cannot authorize deletion outside its independently derived helper directory");
    if (process.platform === "win32") {
      const helperParent = path.dirname(interruptedDirectory), savedHelperParent = helperParent + "-saved";
      const linkedOwned = await createOwnedDirectory(outsideHelper.directory, interruptedId);
      const linkedUnique = path.join(linkedOwned.directory, "unique.txt"); await fs.writeFile(linkedUnique, "outside junction");
      await fs.writeFile(path.join(linkedOwned.directory, ".helper-preparing.json"), JSON.stringify({ identity: interruptedId, owned: linkedOwned }));
      await fs.rename(helperParent, savedHelperParent);
      await fs.symlink(outsideHelper.directory, helperParent, "junction");
      try {
        await assert.rejects(helper.prepareHelperRuntime(options), undefined, "a helper parent junction must not become deletion authority");
        assert.equal(await fs.readFile(linkedUnique, "utf8"), "outside junction");
      } finally { await fs.unlink(helperParent); await fs.rename(savedHelperParent, helperParent); }
    }
    await fs.writeFile(path.join(installedHelper, "component-base.json"), JSON.stringify({ base: { fingerprint: "a".repeat(64) }, components: { updater: { treeSha256: "b".repeat(64) } } }));
    const helperJobId = randomUUID(), helperJobs = path.join(helperPaths.directory, "jobs");
    await fs.mkdir(helperJobs);
    await fs.writeFile(path.join(helperJobs, helperJobId + ".json"), JSON.stringify({ id: helperJobId,
      helperCopyVersion: 2, helperRuntimeIdentity: helperOne.identity, helperExecutable: helperOne.helperExecutable, helperIdentity: helperOne.owned.identity }));
    await fs.writeFile(path.join(helperJobs, helperJobId + ".status.json"), JSON.stringify({ phase: "complete" }));
    const cancelledHelperId = randomUUID();
    await fs.writeFile(path.join(helperJobs, cancelledHelperId + ".json"), JSON.stringify({ id: cancelledHelperId, helperCopyVersion: 2,
      helperRuntimeIdentity: helperOne.identity, helperExecutable: helperOne.helperExecutable, helperIdentity: helperOne.owned.identity }));
    await fs.writeFile(path.join(helperJobs, cancelledHelperId + ".cancel.json"), JSON.stringify({ cancelled: true }));
    await helper.retainHelperRuntimes(helperPaths, null, []);
    const activeHelperRefs = async () => JSON.parse(await fs.readFile(path.join(helperPaths.directory, ".artifact-retention.json"), "utf8"))["active-helpers"].generations.flat();
    assert.equal((await activeHelperRefs()).includes(path.relative(helperPaths.directory, helperOne.owned.directory)), false, "a cancelled launch without a live helper does not pin its cache forever");
    await helper.retainHelperRuntimes(helperPaths, null, [{ pid: 100, executable: helperOne.helperExecutable }]);
    assert.equal((await activeHelperRefs()).includes(path.relative(helperPaths.directory, helperOne.owned.directory)), true, "cancellation never releases an actually running helper");
    const retryProfile = path.join(root, "exit-retry-profile");
    const retryDirectory = require("../src/main/component-paths.cjs").updatePaths(retryProfile).directory;
    await fs.mkdir(retryDirectory, { recursive: true });
    const retryOwned = path.join(retryDirectory, "retry-owned"); await fs.writeFile(retryOwned, "temporary");
    require("../src/shared/artifact-retention.cjs").retainArtifacts(retryDirectory, "retry-fixture", [], 1, [retryOwned], { deferCleanup: true });
    const retryOptions = { ...exitOptions, profile: retryProfile };
    await assert.rejects(exitMaintenance.launchExitMaintenance(retryOptions, { timeoutMs: 0 }), /exit_helper_prepare_timeout/);
    const retryTask = exitMaintenance.prepareExitMaintenance(retryOptions);
    assert.equal(exitMaintenance.prepareExitMaintenance(retryOptions), retryTask, "a quit deadline must not start another preparation");
    await retryTask;
    await assert.rejects(exitMaintenance.launchExitMaintenance(retryOptions), undefined, "a helper that cannot start must not be mistaken for ready");
    assert.equal(JSON.parse(await fs.readFile(path.join(retryDirectory, "exit-maintenance-last.json"), "utf8")).state, "deferred");
    assert.equal((await helper.prepareHelperRuntime(options)).helperExecutable, helperOne.helperExecutable,
      "A completed job does not require a different helper preparation path");
    const { generationRefs } = require("../src/main/update-retention.cjs");
    const oldPayload = JSON.stringify({ components: Object.fromEntries(["application", "content-engine", "product-detail", "video"].map((name, index) => [name, { sha256: String(index + 1).repeat(64) }])) });
    assert.equal(generationRefs(root, require("node:crypto").createHash("sha256").update(oldPayload).digest("hex"), { payload: oldPayload }).length, 9,
      "Historical four-component generations remain protected after adding updater/assets");
    const { backupLocalInstall } = require("./backup-local-install.cjs");
    const nativeFs = require("node:fs"), localProgram = path.join(root, "local-program"), localProfile = path.join(root, "local-profile");
    const localMain = path.join(localProgram, "resources/app/src/main/main.cjs"), localMaterial = path.join(localProfile, "material.bin");
    await fs.mkdir(path.dirname(localMain), { recursive: true }); await fs.mkdir(localProfile);
    await fs.writeFile(localMain, "local program fixture");
    await fs.writeFile(path.join(localProgram, "版本清单.json"), JSON.stringify({ version: "1.1.105" }));
    await fs.writeFile(localMaterial, "original customer material");
    const stream = nativeFs.createReadStream, reads = new Map();
    let localBackup;
    try {
      nativeFs.createReadStream = (file, ...args) => { const key = path.resolve(file); reads.set(key, (reads.get(key) || 0) + 1); return stream(file, ...args); };
      localBackup = await backupLocalInstall({ program: localProgram, profile: localProfile, outputRoot: path.join(root, "local-backups"), purpose: "manual" });
    } finally { nativeFs.createReadStream = stream; }
    assert.equal(reads.get(localMaterial), 1, "Local full backup reads customer bytes once while copying, not before and after copy");
    assert.equal(reads.get(localMain), 1, "Local full backup reuses the same program copy/hash receipt");
    assert.equal([...reads.keys()].some(file => file.startsWith(localBackup.directory + path.sep)), false, "Registering a fresh copied receipt does not reread backup bytes");
    reads.clear();
    let reusedLocal;
    try {
      nativeFs.createReadStream = (file, ...args) => { const key = path.resolve(file); reads.set(key, (reads.get(key) || 0) + 1); return stream(file, ...args); };
      reusedLocal = await backupLocalInstall({ program: localProgram, profile: localProfile, outputRoot: path.join(root, "local-backups"), purpose: "manual" });
      const selectionOnly = await backupLocalInstall({ program: localProgram, profile: localProfile, outputRoot: path.join(root, "local-backups"), purpose: "acceptance", updateKind: "components" });
      assert.equal(selectionOnly.kind, "component-selection");
      assert.equal(selectionOnly.copiedBytes, 0);
    } finally { nativeFs.createReadStream = stream; }
    assert.equal(reusedLocal.id, localBackup.id, "The local manual entrypoint still reuses equivalent existing snapshots");
    assert.equal(reads.size, 0, "Unchanged receipts and component-selection do not read file contents");
    await withRegistry(localProfile, async (registry, save) => {
      for (const set of registry.sets) {
        delete set.programBackup.verification; delete set.programBackup.sourceMetadata; delete set.programBackup.programIdentity;
        delete set.data.verification; delete set.data.sourceMetadata;
      }
      save(registry);
    });
    reads.clear();
    try {
      nativeFs.createReadStream = (file, ...args) => { const key = path.resolve(file); reads.set(key, (reads.get(key) || 0) + 1); return stream(file, ...args); };
      const historical = await backupLocalInstall({ program: localProgram, profile: localProfile, outputRoot: path.join(root, "local-backups"), purpose: "manual" });
      assert.equal(historical.id, localBackup.id, "A historical backup without copy receipts is verified before content-based reuse");
    } finally { nativeFs.createReadStream = stream; }
    assert.equal(reads.get(localMaterial), 1);
    assert.equal(reads.get(path.join(localBackup.directory, "userData/material.bin")), 1, "Historical data without a receipt requires fresh verification");
    assert.deepEqual(await fs.readdir(path.join(root, "local-backups")), [localBackup.id], "Only the newly owned redundant copy is reclaimed");
    const beforeMutation = readRegistry(localProfile).sets.length;
    try {
      nativeFs.createReadStream = (file, ...args) => {
        const source = stream(file, ...args);
        if (path.resolve(file) === localMain) source.once("data", () => nativeFs.appendFileSync(localMaterial, "changed during program capture"));
        return source;
      };
      await fs.writeFile(localMain, "changed program to require another backup");
      await assert.rejects(backupLocalInstall({ program: localProgram, profile: localProfile, outputRoot: path.join(root, "local-backups"), purpose: "acceptance" }), /source_changed/);
    } finally { nativeFs.createReadStream = stream; }
    assert.equal(readRegistry(localProfile).sets.length, beforeMutation, "A changed source cannot register a partial local backup");
    const profile = path.join(root, "profile"), program = path.join(root, "installed"), outside = path.join(root, "original-materials");
    for (const dir of [profile, program, outside]) await fs.mkdir(dir);
    await fs.writeFile(path.join(program, "app.asar"), "physical application archive");
    await fs.writeFile(path.join(outside, "source.mp4"), "unique source material");
    await fs.symlink(outside, path.join(profile, "material-link"), "junction");
    const runtimeLink = path.join(profile, "product-detail/.runtime-links/installed"), businessLink = path.join(profile, "material-link");
    await fs.mkdir(path.dirname(runtimeLink), { recursive: true });
    await fs.symlink(program, runtimeLink, "junction");
    for (const [relative, content] of Object.entries({ "Cache/browser.bin": "regenerable", "Code Cache/js.bin": "regenerable",
      "Network/TransportSecurity": "dynamic browser transport policy", "Network/Cookies": "session state must remain backed up",
      "content-engine/generated/result.mp4": "finished production", "content-engine/batch-exports/output.mp4": "export",
      "product-detail/.runtime-links-notes/receipt.json": "business notes", "data/.runtime-links/customer.txt": "customer folder",
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
    // This developer PC permits symlinks. Model the ordinary-user failure at
    // Node cp's onLink boundary, while actually creating Windows junctions.
    const copy = fs.cp, symlink = fs.symlink;
    const permissionError = () => Object.assign(Error("ordinary user cannot create a directory symlink"), { code: "EPERM", syscall: "symlink", path: program });
    let junctions = 0, first;
    fs.cp = async (source, target, options) => {
      if (source === profile) return copy(source, target, { ...options, filter: async (file, destination) => {
        const allowed = !options.filter || await options.filter(file, destination);
        if (allowed && [runtimeLink, businessLink].some(link => path.resolve(link).toLowerCase() === path.resolve(file).toLowerCase())) throw permissionError();
        return allowed;
      } });
      return copy(source, target, options);
    };
    fs.symlink = async (source, target, type) => {
      if (process.platform === "win32" && type !== "junction") throw permissionError();
      junctions++; return symlink(source, target, type);
    };
    try {
      await assert.rejects(fs.cp(profile, path.join(root, "old-copy"), { recursive: true }), error => {
        const failure = updateFailure(error, "backup");
        return failure.code === "EPERM" && failure.syscall === "symlink" && failure.phase === "backup";
      });
      first = await make("acceptance");
    } finally { fs.cp = copy; fs.symlink = symlink; }
    assert.equal(junctions, 1, "only the business directory link is recreated");
    assert.equal((await fs.lstat(path.join(first.data.directory, "material-link"))).isSymbolicLink(), true, "external materials remain a link, never a copied tree");
    assert.equal(first.data.files.some(file => file.path.startsWith(path.join("product-detail", ".runtime-links") + path.sep)), false);
    await assert.rejects(fs.lstat(path.join(first.data.directory, "product-detail/.runtime-links")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(first.data.directory, "product-detail/.runtime-links-notes/receipt.json"), "utf8"), "business notes");
    assert.equal(await fs.readFile(path.join(first.data.directory, "data/.runtime-links/customer.txt"), "utf8"), "customer folder");
    assert.equal(await copyBytes(profile, backupFilter(profile)), first.data.files.reduce((sum, file) => sum + (file.size || 0), 0), "external tree bytes never enter the backup budget");
    assert.equal(first.data.files.filter(file => file.link).length, 1);
    await fs.unlink(businessLink);
    await fs.symlink(program, businessLink, "junction");
    assert.equal(await checkPreservedData(profile, first.data), false, "a changed material link cannot retire the previous backup");
    await fs.unlink(businessLink);
    await fs.symlink(outside, businessLink, "junction");
    const legacyMutable = ["DevToolsActivePort", path.join("Network", "Network Persistent State"), path.join("content-engine", "content-engine.lock")];
    const database = path.join("content-engine", "content.db"), sharedIndex = database + "-shm";
    const sqliteSnapshot = { ...first.data, files: [...first.data.files.filter(file => file.path === database), { path: sharedIndex, size: 32768, sha256: "old" }] };
    assert.equal(await checkPreservedData(profile, sqliteSnapshot), true, "clean close may remove SQLite shared-memory index");
    await fs.writeFile(path.join(profile, sharedIndex), "");
    assert.equal(await checkPreservedData(profile, sqliteSnapshot), true, "startup may rebuild an empty shared-memory index");
    await fs.unlink(path.join(profile, sharedIndex));
    await fs.rename(path.join(profile, database), path.join(profile, database + ".held"));
    assert.equal(await checkPreservedData(profile, sqliteSnapshot), false, "shared-memory exemption cannot hide a missing database");
    await fs.rename(path.join(profile, database + ".held"), path.join(profile, database));
    const emptyWalSnapshot = { ...first.data, files: [...sqliteSnapshot.files.slice(0, 1), { path: database + "-wal", size: 0, sha256: "empty" }] };
    assert.equal(await checkPreservedData(profile, emptyWalSnapshot), true, "clean close may remove an already empty WAL");
    emptyWalSnapshot.files[1].size = 1;
    assert.equal(await checkPreservedData(profile, emptyWalSnapshot), false, "a missing nonempty WAL must keep recovery evidence");
    for (const relative of legacyMutable) {
      assert.equal(await checkPreservedData(profile, { ...first.data, files: [{ path: relative, size: 1, sha256: "old" }] }), true,
        "older snapshots may include regenerable browser state or the worker's OS lock");
    }
    const catalogPath = path.join("data", "official-materials", "catalog.json");
    for (const relative of ["shared_proto_db/000003.log", "data/shared_proto_db/000003.log"]) {
      const live = path.join(profile, relative);
      await fs.mkdir(path.dirname(live), { recursive: true });
      await fs.writeFile(live, "updated playback state");
      const snapshot = { ...first.data, files: [{ path: relative, size: 1, sha256: "old" }] };
      assert.equal(await checkPreservedData(profile, snapshot), relative.startsWith("shared_proto_db/"),
        "only Chromium's root store is mutable; customer folders remain strict");
      await fs.unlink(live);
      assert.equal(await checkPreservedData(profile, snapshot), false, "mutable storage must still exist");
    }
    const cachedCatalog = { schema: 1, revision: 1, categories: [], items: [] };
    for (const directory of [profile, first.data.directory]) {
      await fs.mkdir(path.join(directory, path.dirname(catalogPath)), { recursive: true });
      await fs.writeFile(path.join(directory, catalogPath), JSON.stringify(cachedCatalog));
    }
    const directorySnapshot = { ...first.data, files: [{ path: catalogPath, size: 1, sha256: "old" }] };
    await fs.writeFile(path.join(profile, catalogPath), JSON.stringify({ ...cachedCatalog, revision: 2, withdrawnIds: ["retired-official-item"] }));
    assert.equal(await checkPreservedData(profile, directorySnapshot), true, "official catalog refresh is not customer-data loss");
    await fs.writeFile(path.join(profile, catalogPath), JSON.stringify({ schema: 1, revision: 2 }));
    assert.equal(await checkPreservedData(profile, directorySnapshot), false, "broken directory must retain recovery evidence");
    await fs.unlink(path.join(profile, catalogPath)); await fs.unlink(path.join(first.data.directory, catalogPath));
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
    assert.equal(first.data.files.some(file => file.path === path.join("Network", "TransportSecurity")), false);
    assert.ok(first.data.files.some(file => file.path === path.join("Network", "Cookies")), "excluding the exact transport cache must not drop browser authorization state");
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
    await confirm(first);
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
    const preservedRoot = path.join(profile, "data/cloud-maintenance/preserved-backup-data");
    const preserved = JSON.parse(await fs.readFile(path.join(preservedRoot, second.id + ".json"), "utf8"));
    const oldDatabase = preserved.preserved.find(file => file.path === database);
    assert.ok(oldDatabase, "retiring an old snapshot must first preserve its distinct database bytes");
    assert.equal(await fs.readFile(path.join(preservedRoot, "objects", oldDatabase.sha256), "utf8"), "business database");
    assert.ok(preserved.preserved.some(file => file.link === outside), "preserve external link identity without copying its target");
    const profileAlias = path.join(root, "relocated-profile");
    await fs.symlink(profile, profileAlias, "junction");
    await require("../src/main/update-backup-preservation.cjs").preserveBackup(profileAlias, second, [], () => assert.fail("saved preservation must resume without the deleted source"));
    await fs.unlink(profileAlias);
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
    const dailyBackup = path.join(root, "daily-backup"), dailyLive = path.join(root, "daily-live"), relative = "data/auto_reply/auto-reply-state.json";
    for (const directory of [dailyBackup, dailyLive]) await fs.mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    const localDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const now = new Date(), priorDay = new Date(now); priorDay.setDate(priorDay.getDate() - 1);
    const prior = { daily_date: localDay(priorDay), reply_count: 7, processed: { fixture: { status: "outcome_unknown" } } };
    const normalized = { ...prior, daily_date: localDay(now), reply_count: 0 };
    const cases = [
      ["normal local-day rollover", prior, normalized, true],
      ["restart keeps paused replies", { ...normalized, status: "paused", last_event: "app_closed" }, { ...normalized, status: "paused", last_event: "workflow_paused" }, true],
      ["pause explanation cannot hide lost receipts", { ...normalized, status: "paused", last_event: "app_closed" }, { ...normalized, status: "paused", last_event: "workflow_paused", processed: {} }, false],
      ["running replies cannot retire backup", { ...normalized, status: "paused", last_event: "app_closed" }, { ...normalized, status: "running", last_event: "workflow_paused" }, false],
      ["already-zero daily count", { ...prior, reply_count: 0 }, normalized, true],
      ["same-day count must not reset", { ...prior, daily_date: localDay(now) }, normalized, false],
      ["backward day", normalized, { ...normalized, daily_date: localDay(priorDay) }, false],
      ["invalid calendar day", { ...prior, daily_date: "2026-02-30" }, normalized, false],
      ["nonzero reset", prior, { ...normalized, reply_count: 1 }, false],
      ["unknown-send record must survive", prior, { ...normalized, processed: {} }, false],
    ];
    for (const [label, before, after, expected] of cases) {
      await fs.writeFile(path.join(dailyBackup, relative), JSON.stringify(before));
      await fs.writeFile(path.join(dailyLive, relative), JSON.stringify(after));
      assert.equal(await checkPreservedData(dailyLive, { directory: dailyBackup, files: await dataInventory(dailyBackup) }), expected, label);
    }
    const pinned = await make("manual");
    await confirm(pinned);
    const nextAutomatic = await make();
    await confirm(nextAutomatic);
    assert.ok(readRegistry(profile).sets.some(set => set.id === pinned.id && set.rotationPolicy === "pinned"),
      "Explicit independent backups survive automatic rotation");
    // Confirmation failure is durable and retried only for its acknowledged version.
    const pending = await make();
    await assert.rejects(confirmSet(profile, pending.id, { targetVersion: "1.1.80", ack: { ok: true, version: "1.1.80" },
      dataCheck: { ok: false, issues: [{ reason: "database_locked" }] } }), /confirmation_required/);
    await retryBackupMaintenance(profile, { version: "1.1.79" });
    assert.equal(readRegistry(profile).sets.find(set => set.id === pending.id).state, "prepared");
    await retryBackupMaintenance(profile, { version: "1.1.80" });
    assert.equal(readRegistry(profile).sets.find(set => set.id === pending.id).state, "confirmed");
    assert.equal(readRegistry(profile).sets.filter(set => set.rotationPolicy === "latest-confirmed" && set.state === "confirmed").length, 1);
    assert.equal(await fs.readFile(path.join(preservedRoot, "objects", oldDatabase.sha256), "utf8"), "business database", "later updates cannot rotate unique historical data");
    // An unconfirmed internal acceptance run older than a newly confirmed one is superseded and rotates out;
    // an unconfirmed customer (automatic) set made later stays as failure evidence.
    // Like the real case: the stale run was backed up to a different folder, so the same-folder rule does not apply.
    const staleId = randomUUID();
    const staleAcceptance = await registerSet(profile, { id: staleId, version: "1.1.78", kind: "acceptance",
      programBackup: await backupProgram(program, path.join(root, "programs-elsewhere"), staleId, {}), data: await captureData(profile, staleId) });
    await new Promise(resolve => setTimeout(resolve, 5));
    const newerId = randomUUID();
    const newerAcceptance = await registerSet(profile, { id: newerId, version: "1.1.78", kind: "acceptance",
      programBackup: await backupProgram(program, path.join(root, "programs-acceptance"), newerId, {}), data: await captureData(profile, newerId) });
    const laterAutomatic = await make();
    assert.notEqual(staleAcceptance.programBackup.program, newerAcceptance.programBackup.program);
    await confirm(newerAcceptance);
    assert.equal(readRegistry(profile).sets.some(set => set.id === staleAcceptance.id), false, "a superseded acceptance run no longer pins old components");
    assert.equal(readRegistry(profile).sets.find(set => set.id === laterAutomatic.id)?.state, "prepared", "unconfirmed customer evidence stays protected");
    const lostConfirmation = await make();
    const jobs = path.join(profile, "data/cloud-maintenance/components/jobs");
    await fs.mkdir(jobs, { recursive: true });
    for (const [suffix, value] of Object.entries({
      "": { id: lostConfirmation.id, targetVersion: "1.1.81", programBackup: lostConfirmation.programBackup },
      ".ack": { ok: true, version: "1.1.81" }, ".status": { phase: "complete" }
    })) await fs.writeFile(path.join(jobs, lostConfirmation.id + suffix + ".json"), JSON.stringify(value));
    await retryBackupMaintenance(profile, { version: "1.1.81" });
    assert.equal(readRegistry(profile).sets.find(set => set.id === lostConfirmation.id).state, "confirmed",
      "helper lock conflict before confirmSet must recover from its completed job and startup ACK");
    // Model two snapshots sharing storage after an earlier deletion was blocked.
    await fs.writeFile(path.join(profile, "license.enc"), "shared older authorization");
    await fs.writeFile(path.join(program, "app.asar"), "shared older program");
    const sharedA = await make(), sharedB = await make();
    assert.equal(sharedA.data.directory, sharedB.data.directory);
    await withRegistry(profile, async (registry, save) => {
      for (const set of registry.sets.filter(set => [sharedA.id, sharedB.id].includes(set.id))) set.state = "confirmed";
      save(registry);
    });
    await fs.writeFile(path.join(profile, "license.enc"), "new authorization");
    await fs.writeFile(path.join(program, "app.asar"), "new program");
    const newest = await make(), originalRemove = fs.rm;
    fs.rm = async (...args) => {
      if (path.basename(args[0]).startsWith(".discard-")) throw Object.assign(Error("fixture busy"), { code: "EBUSY" });
      return originalRemove(...args);
    };
    try { await confirm(newest); } finally { fs.rm = originalRemove; }
    assert.ok(readRegistry(profile).sets.some(set => set.id === sharedB.id && set.state === "retiring"));
    await retryBackupMaintenance(profile, { version: "1.1.79" });
    assert.equal(readRegistry(profile).sets.some(set => [sharedA.id, sharedB.id].includes(set.id)), false,
      "all shared snapshots must be preserved before removing their common owner, including quarantine retries");
    for (const set of [sharedA, sharedB]) {
      const saved = JSON.parse(await fs.readFile(path.join(preservedRoot, set.id + ".json"), "utf8"));
      const authorization = saved.preserved.find(file => file.path === "license.enc");
      assert.equal(await fs.readFile(path.join(preservedRoot, "objects", authorization.sha256), "utf8"), "shared older authorization");
    }
    assert.equal(readRegistry(profile).sets.filter(set => set.rotationPolicy === "latest-confirmed" && set.state === "confirmed").length, 1);
    console.log("Update backup governance self-check passed.");
  } finally {
    assert.equal(path.dirname(root), parent);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
