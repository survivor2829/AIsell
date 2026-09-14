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
    const result = spawnSync(require("electron"), [__filename], {
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

  async function checkFailedBackupStopsInstaller(userData) {
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
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, "settings.json"), "existing backup must not be overwritten");
    let spawned = 0;
    const execFile = () => assert.fail("processSnapshot must use its promise interface");
    execFile[promisify.custom] = async () => ({ stdout: "[]" });
    const helperModule = { exports: {} };
    // Only UI and OS process boundaries are replaced; signature, file copy and status writes are real.
    const mocks = {
      "node:child_process": { execFile, spawn() { spawned++; throw Error("unexpected_process_start"); } },
      "./cloud-config.cjs": { cloudConfig: () => config },
      electron: { app: { setPath() {}, whenReady: async () => {}, on() {} }, BrowserWindow: class {
        constructor() { this.webContents = { executeJavaScript: async () => {} }; }
        async loadURL() {} on() {} isDestroyed() { return false; }
      } }
    };
    new Function("require", "module", fs.readFileSync(helperFile, "utf8"))(
      request => Object.hasOwn(mocks, request) ? mocks[request] : load(request), helperModule);
    await helperModule.exports.runHelper({ jobFile, userData });
    const status = readJson(path.join(paths.jobs, id + ".status.json"));
    assert.equal(status.phase, "error");
    assert.match(status.detail, /ERR_FS_CP_EEXIST/, "retain the concrete backup failure");
    assert.equal(spawned, 0, "a failed backup must never start the installer or replacement app");
    assert.equal(fs.existsSync(paths.selection), false, "a failed backup must not change the selected version");
    assert.equal(fs.existsSync(path.join(destination, "update-backup.json")), false);
    assert.equal(fs.readFileSync(path.join(destination, "settings.json"), "utf8"), "existing backup must not be overwritten");
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
    await checkFailedBackupStopsInstaller(userData);
    console.log(`update-helper Electron ${process.versions.electron} backup self-check passed`);
  }
  run().then(() => app.exit(0)).catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    app.exit(1);
  });
}
