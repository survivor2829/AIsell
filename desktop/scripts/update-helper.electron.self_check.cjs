const assert = require("node:assert/strict");
const path = require("node:path");

if (!process.versions.electron) {
  const fs = require("node:fs");
  const { spawnSync } = require("node:child_process");
  const parent = path.resolve(__dirname, "../.build/update-helper-tests");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "run-"));
  try {
    const env = { ...process.env, XIAOXI_UPDATE_BACKUP_TEST_ROOT: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require("electron"), [__filename, "--no-sandbox", "--disable-gpu"], {
      cwd: path.resolve(__dirname, ".."), env, encoding: "utf8", timeout: 30_000, windowsHide: true
    });
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    if (result.error) throw result.error;
    assert.equal(result.status, 0, "Electron must back up physical ASAR bytes without copying update caches");
  } finally {
    assert.ok(path.resolve(root).startsWith(parent + path.sep), "cleanup must stay inside the generated test fixture");
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
} else {
  const { app } = require("electron");
  const fs = require("original-fs");
  const { backupUserData } = require("../src/main/update-helper.cjs");
  const suppliedRoot = process.env.XIAOXI_UPDATE_BACKUP_TEST_ROOT;
  assert.ok(suppliedRoot, "a parent-created isolated test root is required");
  const root = path.resolve(suppliedRoot);
  app.setPath("userData", path.join(root, "electron-profile"));

  async function checkBackupCapacityAndFailure(userData) {
    const copy = fs.promises.cp, statfs = fs.promises.statfs;
    const failures = [];
    try {
      fs.promises.cp = async (source, destination, options) => {
        if (source !== userData) return copy(source, destination, options);
        fs.writeFileSync(path.join(destination, "partial.bin"), "owned incomplete copy");
        throw Object.assign(Error("fixture write failure"), { code: "ENOSPC", path: path.join(destination, "partial.bin"), syscall: "copyfile" });
      };
      await assert.rejects(backupUserData(userData, "failed-copy"), { code: "ENOSPC" });
      try { assert.equal(fs.existsSync(path.join(root, "user-data-update-backups/failed-copy")), false,
        "a failed backup must remove only its own partial copy instead of accumulating on retry"); } catch (error) { failures.push(error); }
      fs.promises.cp = copy;
      fs.promises.statfs = async file => ({ ...await statfs(file), bavail: 0 });
      try { await assert.rejects(backupUserData(userData, "insufficient-space"), { code: "update_disk_space_insufficient" },
        "backup capacity must be checked before copying any business data"); } catch (error) { failures.push(error); }
    } finally { fs.promises.cp = copy; fs.promises.statfs = statfs; }
    if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join("\n"));
  }

  async function checkCopyAccounting() {
    const { checkCopySpace, copyBytes, createOwnedDirectory, removeOwnedDirectory } = require("../src/main/update-storage.cjs");
    const one = path.join(root, "volume-one"), two = path.join(root, "volume-two"), mib = 1024 ** 2;
    fs.mkdirSync(one); fs.mkdirSync(two);
    fs.writeFileSync(path.join(one, "original"), "hardlink bytes");
    fs.linkSync(path.join(one, "original"), path.join(one, "linked"));
    assert.equal(await copyBytes(one), Buffer.byteLength("hardlink bytes") * 2, "hardlinks consume separate copied bytes and must not be deduplicated in the budget");
    const stat = fs.promises.stat, statfs = fs.promises.statfs;
    let separateVolumes = false;
    try {
      fs.promises.stat = async file => ({ ...await stat(file), dev: separateVolumes && file === two ? 2 : 1 });
      fs.promises.statfs = async () => ({ bavail: 160 * mib, bsize: 1 });
      const parts = [{ path: one, bytes: 64 * mib }, { path: two, bytes: 64 * mib }];
      await assert.rejects(checkCopySpace(parts), { code: "update_disk_space_insufficient" }, "copies sharing a volume must be budgeted together");
      separateVolumes = true;
      assert.equal((await checkCopySpace(parts)).length, 2, "different destination volumes must be checked independently");
    } finally { fs.promises.stat = stat; fs.promises.statfs = statfs; }
    const owned = await createOwnedDirectory(path.join(root, "ownership"), "attempt");
    fs.renameSync(owned.directory, owned.directory + "-moved");
    fs.mkdirSync(owned.directory);
    const replacement = path.join(owned.directory, "unrelated.txt");
    fs.writeFileSync(replacement, "must survive");
    await assert.rejects(removeOwnedDirectory(owned), /update_copy_path_invalid/, "a replaced directory is no longer owned by the failed attempt");
    assert.equal(fs.readFileSync(replacement, "utf8"), "must survive");
  }

  async function checkHelperCopyLifecycle(userData) {
    const { createRequire } = require("node:module"), { promisify } = require("node:util");
    const helperFile = path.resolve(__dirname, "../src/main/update-helper.cjs"), load = createRequire(helperFile);
    const installedRoot = path.join(root, "installed"), applicationRoot = path.join(root, "verified-active-app");
    fs.mkdirSync(path.join(installedRoot, "resources/app"), { recursive: true });
    fs.mkdirSync(applicationRoot);
    fs.writeFileSync(path.join(installedRoot, "resources/app/version.txt"), "old base");
    fs.writeFileSync(path.join(applicationRoot, "version.txt"), "verified active code");
    const executable = path.join(installedRoot, "app.exe");
    fs.writeFileSync(executable, "inert executable fixture");
    const execFile = () => assert.fail("snapshot must use the promise interface");
    execFile[promisify.custom] = async () => ({ stdout: JSON.stringify([{ ProcessId: process.pid, ParentProcessId: 0, CreationDate: "fixture" }]) });
    let failCopy = false;
    const native = { ...fs, promises: { ...fs.promises, cp: async (...args) => {
      await fs.promises.cp(...args);
      if (failCopy) throw Object.assign(Error("fixture helper copy failed"), { code: "ENOSPC", path: args[1] });
    } } };
    const mocks = { "original-fs": native, "node:child_process": { execFile } }, helperModule = { exports: {} };
    const previous = global.__xiaoxiComponents;
    try {
      global.__xiaoxiComponents = { installedRoot, applicationRoot };
      new Function("require", "module", "process", fs.readFileSync(helperFile, "utf8"))(
        name => mocks[name] || load(name), helperModule, { ...process, execPath: executable });
      const options = { userData, prepared: { kind: "components", version: "1.1.28" }, currentVersion: "1.1.27" };
      const first = await helperModule.exports.createUpdateJob(options);
      assert.equal(fs.readFileSync(path.join(path.dirname(first.job.helperExecutable), "resources/app/version.txt"), "utf8"), "verified active code",
        "updates must use the already verified active application, not resurrect the old base updater");
      const helpers = path.dirname(path.dirname(first.job.helperExecutable));
      failCopy = true;
      await assert.rejects(helperModule.exports.createUpdateJob(options), { code: "ENOSPC" });
      assert.equal(fs.readdirSync(helpers).length, 1, "a failed preparation must remove only the helper copy owned by that attempt");
      failCopy = false;
      const { writeJsonAtomic } = load("./atomic-file.cjs");
      writeJsonAtomic(first.file.replace(/\.json$/, ".status.json"), { phase: "error" });
      writeJsonAtomic(first.file.replace(/\.json$/, ".ready.json"), { pid: process.pid });
      const second = await helperModule.exports.createUpdateJob(options);
      assert.ok(fs.existsSync(first.job.helperExecutable), "a terminal status cannot authorize deleting a still-running helper");
      writeJsonAtomic(first.file.replace(/\.json$/, ".ready.json"), { pid: 2147483647 });
      await helperModule.exports.createUpdateJob(options);
      assert.equal(fs.existsSync(first.job.helperExecutable), false, "the next attempt reclaims an owned terminal helper only after its process has exited");
      assert.ok(fs.existsSync(second.job.helperExecutable), "missing terminal evidence must preserve the helper");
    } finally { global.__xiaoxiComponents = previous; }
  }

  async function checkFailedBackupStopsInstaller(userData, failureMode = "existing-backup") {
    const crypto = require("node:crypto");
    const { createRequire } = require("node:module");
    const { promisify } = require("node:util");
    const { updatePaths, readJson } = require("../src/main/component-paths.cjs");
    const helperFile = path.resolve(__dirname, "../src/main/update-helper.cjs");
    const load = createRequire(helperFile);
    const id = crypto.randomUUID(), paths = updatePaths(userData);
    fs.mkdirSync(paths.jobs, { recursive: true });
    const bytes = Buffer.from("inert installer fixture - never execute");
    const file = path.join(paths.directory, "fixture.exe");
    fs.writeFileSync(file, bytes);
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const config = { appId: "backup-test", channel: "test", signingPublicKey: publicKey };
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const payload = JSON.stringify({ schema: 1, appId: config.appId, channel: config.channel, platform: "win32", arch: "x64",
      version: "1.1.27", sha256, size: bytes.length, file: `/artifacts/${sha256}.exe`, sequence: 1, notes: "backup failure fixture" });
    const prepared = { file, envelope: { payload, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString("base64") } };
    const jobFile = path.join(paths.jobs, id + ".json");
    fs.writeFileSync(jobFile, JSON.stringify({ id, processes: [], parentPid: process.pid, currentVersion: "1.1.26", targetVersion: "1.1.27",
      executable: process.execPath, helperExecutable: process.execPath, installedRoot: path.dirname(process.execPath), prepared }));
    const destination = path.join(path.dirname(userData), path.basename(userData) + "-update-backups", id);
    if (failureMode === "existing-backup") {
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, "settings.json"), "existing backup must not be overwritten");
    }
    let spawned = 0, closeHandler;
    const scripts = [];
    const execFile = () => assert.fail("processSnapshot must use its promise interface");
    execFile[promisify.custom] = async () => ({ stdout: "[]" });
    const helperModule = { exports: {} };
    // Only UI and OS process boundaries are replaced; signature, file copy and status writes are real.
    const mocks = {
      "node:child_process": { execFile, spawn() { spawned++; throw Error("unexpected_process_start"); } },
      "./cloud-config.cjs": { cloudConfig: () => config },
      electron: { app: { setPath() {}, whenReady: async () => {}, on() {} }, BrowserWindow: class {
        constructor() { this.webContents = { executeJavaScript: async script => { scripts.push(script); } }; }
        async loadURL() {} on(name, handler) { if (name === "close") closeHandler = handler; } isDestroyed() { return false; }
      } }
    };
    if (failureMode !== "existing-backup") {
      mocks["original-fs"] = { ...fs, promises: { ...fs.promises, cp: async () => {
        throw Object.assign(Error("fixture disk write failed"), { code: "ENOSPC", path: path.join(destination, "settings.json"), syscall: "copyfile" });
      } } };
      mocks["./atomic-file.cjs"] = { writeJsonAtomic(file, value) {
        if (failureMode === "status-write" && value.phase === "error") throw Object.assign(Error("status also failed"), { code: "EACCES" });
        if (failureMode === "ready-write" && file.endsWith(".ready.json") || failureMode === "active-write" && file.endsWith("active-job.json")) {
          throw Object.assign(Error("startup receipt failed"), { code: "ENOSPC", path: file });
        }
        return load("./atomic-file.cjs").writeJsonAtomic(file, value);
      } };
    }
    new Function("require", "module", fs.readFileSync(helperFile, "utf8"))(
      request => Object.hasOwn(mocks, request) ? mocks[request] : load(request), helperModule);
    await helperModule.exports.runHelper({ jobFile, userData });
    const status = readJson(path.join(paths.jobs, id + ".status.json"));
    if (failureMode !== "existing-backup") {
      assert.ok(scripts.some(script => script.includes("ENOSPC")), "a failed status write must not hide the original backup error from the window");
      closeHandler({ preventDefault() { assert.fail("an error window must remain closable even when its status cannot be saved"); } });
      assert.equal(fs.existsSync(destination), false);
      if (failureMode !== "status-write") assert.equal(status.failure.phase, "ready", "startup receipt failure must retain its true phase");
    } else {
      assert.equal(status.phase, "error");
      assert.match(status.detail, /ERR_FS_CP_EEXIST/, "retain the concrete backup failure");
      assert.equal(fs.readFileSync(path.join(destination, "settings.json"), "utf8"), "existing backup must not be overwritten");
    }
    assert.equal(spawned, 0, "a failed backup must never start the installer or replacement app");
    assert.equal(fs.existsSync(paths.selection), false, "a failed backup must not change the selected version");
    assert.equal(fs.existsSync(path.join(destination, "update-backup.json")), false);
  }

  async function run() {
    const userData = path.join(root, "user-data");
    const asar = fs.readFileSync(path.join(process.resourcesPath, "default_app.asar"));
    const kept = {
      "settings.json": Buffer.from('{"language":"zh-CN"}'),
      "data/contacts.db": Buffer.from([0, 255, 12, 0, 4, 63]),
      "data/materials/template.asar": asar,
      "data/cloud-maintenance-notes/report.txt": Buffer.from("business record, not a cache"),
      "update-helper-profile-notes.txt": Buffer.from("business notes"),
      "data/nested/cloud-maintenance/history.txt": Buffer.from("nested business record")
    };
    const excluded = {
      "data/cloud-maintenance/components/generations/test/resources/default_app.asar": asar,
      "update-helper-profile/Cache/cache.dat": Buffer.from("helper cache")
    };
    for (const [relative, content] of Object.entries({ ...kept, ...excluded })) {
      const file = path.join(userData, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    for (const [label, source] of [["ordinary", userData], ["namespaced", path.toNamespacedPath(userData)]]) {
      const backup = await backupUserData(source, label);
      for (const [relative, content] of Object.entries(kept)) {
        assert.deepEqual(fs.readFileSync(path.join(backup, relative)), content, `${label}: preserve physical bytes for ${relative}`);
      }
      assert.equal(fs.existsSync(path.join(backup, "data/cloud-maintenance")), false, `${label}: omit the update cache directory`);
      assert.equal(fs.existsSync(path.join(backup, "update-helper-profile")), false, `${label}: omit the helper profile directory`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(backup, "update-backup.json"), "utf8")).kind, "before-full-upgrade");
    }
    const missing = path.join(root, "missing-user-data");
    await assert.rejects(backupUserData(missing, "failure"), { code: "ENOENT" });
    assert.equal(fs.existsSync(path.join(root, "missing-user-data-update-backups/failure/update-backup.json")), false,
      "a failed backup must reject without a completed backup receipt");
    for (const [relative, content] of Object.entries({ ...kept, ...excluded })) {
      assert.deepEqual(fs.readFileSync(path.join(userData, relative)), content, `source remains unchanged: ${relative}`);
    }
    await checkBackupCapacityAndFailure(userData);
    await checkCopyAccounting();
    await checkFailedBackupStopsInstaller(userData);
    for (const mode of ["status-write", "ready-write", "active-write"]) await checkFailedBackupStopsInstaller(userData, mode);
    await checkHelperCopyLifecycle(userData);
    console.log(`update-helper Electron ${process.versions.electron} backup self-check passed`);
  }
  run().then(() => app.exit(0)).catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    app.exit(1);
  });
}
