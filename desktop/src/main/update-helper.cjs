// Backups and runtime copies need physical ASAR files, not Electron's virtual directories.
const fs = process.versions.electron ? require("original-fs") : require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { readJson, updatePaths, verifySelected, saveSelection, rollbackSelection } = require("./component-paths.cjs");
const { verifyManifest, VERSION } = require("../shared/cloud-contract.cjs");
const { digest, HEX } = require("../shared/component-contract.cjs");
const { safePath, retainArtifacts, artifactOwnershipRegistered } = require("../shared/artifact-retention.cjs");
const { backupFilter, copyBytes, checkCopySpace, createOwnedDirectory, removeOwnedDirectory, updateFailure, formatUpdateFailure, metadataInventory, copySnapshot } = require("./update-storage.cjs");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const productBrand = require("../../product-brand.json");
const PROCESS_QUERY_TIMEOUT_MS = 60000;
async function processSnapshot() {
  let result;
  try { result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,Name | ConvertTo-Json -Compress"],
    { windowsHide: true, maxBuffer: 8 * 1024 ** 2, timeout: PROCESS_QUERY_TIMEOUT_MS }); }
  catch (error) {
    if (error.killed) throw Object.assign(Error("update_process_snapshot_timeout"), { cause: error });
    throw error;
  }
  const rows = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
  return (Array.isArray(rows) ? rows : [rows]).map(row => ({ pid: row.ProcessId, parent: row.ParentProcessId, created: row.CreationDate, executable: row.ExecutablePath, name: row.Name }));
}
// CreationDate is "/Date(ms)/" from Windows PowerShell or ISO text; null when unknown.
function createdAt(row) {
  const value = String(row?.created ?? ""), match = /^\/Date\((-?\d+)\)\/$/.exec(value);
  const time = match ? Number(match[1]) : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}
// Start times are wall-clock and Windows steps the clock back by a second or so; only gaps beyond
// this slack prove a link stale (the 2026-10-01 stranger was 1 h 48 min older than its "parent").
const CLOCK_SLACK_MS = 60000;
// Windows keeps a child's ParentProcessId after the parent exits and later reuses that PID, so the
// link only counts if the child started after the parent and before any newer owner of the PID.
// Unknown times keep the link: waiting on a stranger is safer than installing under a worker.
function startedUnder(row, parent, owner) {
  const started = createdAt(row), since = createdAt(parent), reused = owner ? createdAt(owner) : null;
  if (started === null || since === null) return true;
  if (started < since - CLOCK_SLACK_MS) return false;
  return reused === null || reused <= since || started <= reused + CLOCK_SLACK_MS;
}
// A process is its PID plus start time: once a PID is reused, the old and new owners are different.
const identity = row => `${row.pid}@${row.created}`;
function descendants(rows, rootPid, seed = []) {
  const selected = new Map(seed.map(row => [identity(row), row])), current = new Map(rows.map(row => [row.pid, row]));
  // A reused root PID must not stand in for the tracked root.
  const root = current.get(rootPid); if (root && !seed.some(row => row.pid === rootPid)) selected.set(identity(root), root);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(identity(row))) continue;
      const parents = [...selected.values()].filter(parent => parent.pid === row.parent);
      if (parents.some(parent => startedUnder(row, parent, current.get(parent.pid)))) { selected.set(identity(row), row); changed = true; }
    }
  }
  return [...selected.values()];
}
async function waitForExit(job, onStage, timeoutMs = 120000) {
  let tracked = job.processes, until = Date.now() + timeoutMs;
  const recorded = new Set(job.processes.map(identity));
  while (true) {
    if (job.authorizationFile && readJson(job.authorizationFile.replace(/\.json$/, ".cancel.json"))) throw Error("update_request_cancelled");
    const rows = await processSnapshot();
    // The app recorded its processes before starting the helper: if the helper now holds the PID of
    // an exited parent, those processes and their children still belong to the app, not the helper.
    const since = createdAt(rows.find(row => row.pid === process.pid));
    const recordedBefore = row => since !== null && recorded.has(identity(row)) && createdAt(row) !== null && createdAt(row) < since;
    const own = new Set(descendants(rows.filter(row => !recordedBefore(row)), process.pid).map(row => row.pid));
    tracked = descendants(rows, job.parentPid, tracked).filter(row => !own.has(row.pid));
    const alive = tracked.filter(row => rows.some(candidate => candidate.pid === row.pid && candidate.created === row.created));
    if (!alive.length) return;
    if (Date.now() > until) throw Error("update_workers_still_running");
    onStage("waiting", "等待软件和工作进程退出", `仍有 ${alive.length} 个相关进程正在退出，请保留此窗口。`);
    await sleep(1000);
  }
}
function authorizeUpdateJob(file, job) {
  const ready = readJson(file.replace(/\.json$/, ".ready.json"));
  if (!Number.isInteger(ready?.pid) || ready.pid <= 0 || readJson(file.replace(/\.json$/, ".cancel.json"))) throw Error("update_helper_not_ready");
  writeJsonAtomic(file.replace(/\.json$/, ".commit.json"), { id: job.id, targetVersion: job.targetVersion, parentPid: job.parentPid, helperPid: ready.pid });
}
function revokeUpdateJob(file) {
  writeJsonAtomic(file.replace(/\.json$/, ".cancel.json"), { cancelled: true });
}
// The coordinator verifies the spawned identity and rechecks it at commit.
// Both bounded process queries must fit inside this handoff deadline.
async function waitForAuthorization(file, job, timeoutMs = 2 * PROCESS_QUERY_TIMEOUT_MS + 35000) {
  const until = performance.now() + timeoutMs;
  do {
    if (readJson(file.replace(/\.json$/, ".cancel.json"))) throw Error("update_request_cancelled");
    const commit = readJson(file.replace(/\.json$/, ".commit.json"));
    if (commit?.id === job.id && commit.targetVersion === job.targetVersion && commit.parentPid === job.parentPid && commit.helperPid === process.pid) return;
    if (performance.now() >= until) throw Error("update_request_not_committed");
    await sleep(100);
  } while (true);
}
function trackLaunch(rows, pid, started, tracked = []) {
  if (!tracked.length) {
    const root = rows.find(row => row.pid === pid && createdAt(row) !== null && createdAt(row) >= started - CLOCK_SLACK_MS);
    tracked = [root || { pid, parent: 0, created: new Date(started).toISOString(), launchAnchor: true }];
  }
  return descendants(rows, pid, tracked);
}
async function stopLaunch(pid, tracked, onStage) {
  // A launcher may exit while workers survive. Match the recorded creation time,
  // never assume that its now-reused PID still names a process we own.
  const until = Date.now() + 15000;
  while (true) {
    const rows = await processSnapshot();
    if (tracked.some(row => row.launchAnchor && rows.some(current => current.pid === row.pid))) throw Error("update_launch_identity_unknown");
    tracked = descendants(rows, pid, tracked);
    const alive = tracked.filter(row => rows.some(current => identity(current) === identity(row)));
    if (!alive.length) return;
    if (Date.now() > until) throw Error("update_workers_still_running");
    for (const row of alive) {
      const current = (await processSnapshot()).find(value => identity(value) === identity(row));
      if (!current) continue;
      try { await promisify(execFile)("taskkill.exe", ["/PID", String(row.pid), "/F"], { windowsHide: true }); }
      catch { /* Recheck: a process may have exited between the snapshot and taskkill. */ }
    }
    onStage("waiting", "正在结束新版进程", "正在等待本次启动的工作进程退出，然后恢复上一版本。");
    await sleep(250);
  }
}
async function backupUserData(userData, id) {
  return (await require("./update-backups.cjs").captureData(userData, id)).directory;
}
async function reclaimFinishedHelpers(paths, processes) {
  const parent = safePath(paths.directory, "helper-runtime");
  if (!fs.existsSync(parent)) return;
  const realParent = await fs.promises.realpath(parent);
  for (const name of await fs.promises.readdir(paths.jobs)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const id = name.slice(0, -5), job = readJson(path.join(paths.jobs, name));
    const status = readJson(path.join(paths.jobs, id + ".status.json")), ready = readJson(path.join(paths.jobs, id + ".ready.json"));
    const directory = path.join(realParent, id);
    if (job?.helperCopyVersion === 2) {
      // Shared identities use the two-generation ownership policy below.
      continue;
    }
    if (job?.helperCopyVersion !== 1 || job.id !== id || job.helperExecutable !== path.join(directory, "ai-update-helper.exe")
        || !["error", "complete"].includes(status?.phase) || !Number.isInteger(ready?.pid) || ready.pid <= 0
        || processes.some(row => row.pid === ready.pid)) continue;
    // Old backups, unmarked helpers and jobs without conclusive exit evidence are never swept.
    try { await removeOwnedDirectory({ parent: realParent, directory, identity: job.helperIdentity }); } catch { /* In use or uncertain: preserve it. */ }
  }
}
function hasLiveUpdateHelper(root, probe = pid => process.kill(pid, 0)) {
  const file = path.join(root, "active-job.json");
  if (!fs.existsSync(file)) return false;
  const active = readJson(file);
  // Only ESRCH proves the stale helper ended. Missing identity and access errors
  // retain protection, including when an unrelated process reused the PID.
  if (Number.isInteger(active?.pid) && active.pid > 0) {
    try { probe(active.pid); } catch (error) { if (error.code === "ESRCH") return false; }
  }
  return true;
}
function helperRuntimeIdentity(installedRoot, applicationRoot) {
  const baseline = readJson(path.resolve(applicationRoot, "../../component-base.json")) || readJson(path.join(installedRoot, "component-base.json"));
  const updater = baseline?.components?.updater?.treeSha256 || baseline?.components?.application?.treeSha256;
  if (!HEX.test(baseline?.base?.fingerprint || "") || !HEX.test(updater || "")) throw Error("update_helper_identity_invalid");
  return digest(JSON.stringify({ base: baseline.base.fingerprint, updater, copyRecipe: 2 }));
}
async function prepareHelperRuntimeCopy({ paths, installedRoot, applicationRoot, executable }) {
  const identity = helperRuntimeIdentity(installedRoot, applicationRoot), parent = safePath(paths.directory, "helper-runtime");
  const directory = path.join(parent, identity), receipt = path.join(directory, ".helper-runtime.json");
  const helperExecutable = path.join(directory, "ai-update-helper.exe");
  const preparing = path.join(directory, ".helper-preparing.json");
  if (fs.existsSync(preparing)) {
    const interrupted = readJson(preparing);
    const realParent = await fs.promises.realpath(parent), stat = await fs.promises.lstat(directory, { bigint: true });
    if (interrupted?.identity !== identity || interrupted.owned?.parent !== realParent
        || interrupted.owned?.directory !== path.join(realParent, identity) || stat.isSymbolicLink()
        || String(stat.dev) !== interrupted.owned?.identity?.dev || String(stat.ino) !== interrupted.owned?.identity?.ino) throw Error("update_helper_runtime_invalid");
    if (!fs.existsSync(receipt)) await removeOwnedDirectory(interrupted.owned);
    else {
      const completed = readJson(receipt);
      if (completed?.identity !== identity || JSON.stringify(completed.owned) !== JSON.stringify(interrupted.owned)) throw Error("update_helper_runtime_invalid");
      await fs.promises.unlink(preparing);
    }
  }
  if (fs.existsSync(directory)) {
    const record = readJson(receipt), stat = await fs.promises.lstat(directory, { bigint: true });
    if (record?.schema !== 2 || record.identity !== identity || stat.isSymbolicLink()
        || String(stat.dev) !== record.owned?.identity?.dev || String(stat.ino) !== record.owned?.identity?.ino) throw Error("update_helper_runtime_invalid");
    const metadata = await metadataInventory(directory, file => file !== receipt);
    const shape = entries => entries.map(({ path, size, link }) => ({ path, size, ...(link ? { link } : {}) }));
    const [sourceExe, helperExe] = await Promise.all([fs.promises.stat(executable, { bigint: true }), fs.promises.stat(helperExecutable, { bigint: true })]);
    if (metadata.some(file => file.link) || JSON.stringify(shape(metadata)) !== JSON.stringify(record.files)
        || (sourceExe.dev === helperExe.dev && sourceExe.ino === helperExe.ino)) throw Error("update_helper_runtime_invalid");
    return { identity, owned: record.owned, helperExecutable, created: false, bytes: record.bytes, entries: metadata.length };
  }
  const copies = [];
  for (const entry of fs.readdirSync(installedRoot, { withFileTypes: true })) {
    if ((entry.isFile() && (!entry.name.endsWith(".exe") || entry.name === "crashpad_handler.exe"))
        || (entry.isDirectory() && entry.name === "locales")) copies.push({ source: path.join(installedRoot, entry.name), target: entry.name });
  }
  copies.push({ source: executable, target: "ai-update-helper.exe" }, { source: applicationRoot, target: "resources/app" });
  let bytes = 0;
  for (const copy of copies) bytes += await copyBytes(copy.source);
  const copyBudget = await checkCopySpace([{ path: parent, bytes }]), owned = await createOwnedDirectory(parent, identity);
  try {
    writeJsonAtomic(preparing, { identity, owned });
    for (const copy of copies) {
      const target = path.join(owned.directory, copy.target), stat = await fs.promises.lstat(copy.source);
      if (stat.isSymbolicLink()) throw Error("update_program_link_unsupported");
      if (stat.isDirectory()) await copySnapshot(copy.source, target, undefined, undefined, { allowLinks: false, linkImmutable: copy.target === "resources/app" });
      // Electron also maps ICU, snapshots, resource packs and locale packs.
      // Sharing those inodes would let the exit helper lock its own GC targets.
      else if (stat.isFile()) await fs.promises.copyFile(copy.source, target, fs.constants.COPYFILE_EXCL);
      else throw Error("update_copy_file_type_invalid");
    }
    const metadata = await metadataInventory(owned.directory, file => file !== preparing);
    const files = metadata.map(({ path, size }) => ({ path, size }));
    writeJsonAtomic(receipt, { schema: 2, identity, owned, files, bytes });
    await fs.promises.unlink(preparing);
    return { identity, owned, helperExecutable, created: true, bytes, entries: files.length, copyBudget };
  } catch (error) {
    await removeOwnedDirectory(owned).catch(cleanup => {
      error.cleanupCode = cleanup.code || cleanup.message;
      // Only a directory whose inode and boundary were checked by the remover
      // may enter the existing retry ledger. Historical quarantines are not scanned.
      if (cleanup.ownedRetirement) retainArtifacts(paths.directory, "failed-helper-preparations", [], 1,
        [cleanup.ownedRetirement.directory], { deferCleanup: true });
    });
    throw error;
  }
}
const helperPreparations = new Map();
async function retainHelperRuntimes(paths, current, processes = null) {
  if (!fs.existsSync(paths.directory)) return;
  const parent = safePath(paths.directory, "helper-runtime"), pins = new Set(), historical = new Map();
  if (!fs.existsSync(parent)) return;
  processes ||= await processSnapshot();
  for (const row of processes) {
    const relative = path.relative(parent, String(row.executable || ""));
    const identity = relative.split(path.sep)[0];
    if (HEX.test(identity)) pins.add(path.join(parent, identity));
  }
  if (fs.existsSync(paths.jobs)) for (const name of fs.readdirSync(paths.jobs).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
    const job = readJson(path.join(paths.jobs, name));
    if (!job || job.id + ".json" !== name) continue;
    if (HEX.test(job.helperRuntimeIdentity || "")) {
      const directory = path.join(parent, job.helperRuntimeIdentity);
      const terminal = ["complete", "error"].includes(readJson(path.join(paths.jobs, job.id + ".status.json"))?.phase);
      const cancelled = readJson(path.join(paths.jobs, job.id + ".cancel.json"))?.cancelled === true;
      const ready = readJson(path.join(paths.jobs, job.id + ".ready.json"));
      const uncertainLive = processes.some(row => !row.executable && (row.pid === ready?.pid || String(row.name).toLowerCase() === "ai-update-helper.exe"));
      if (!terminal && (!cancelled || uncertainLive || pins.has(directory))) pins.add(directory);
    }
    if (job?.helperCopyVersion === 2 && HEX.test(job.helperRuntimeIdentity || "")) {
      const directory = path.join(parent, job.helperRuntimeIdentity);
      try {
        const record = readJson(path.join(directory, ".helper-runtime.json")), stat = fs.lstatSync(directory, { bigint: true });
        if (record?.schema === 2 && record.identity === job.helperRuntimeIdentity && !stat.isSymbolicLink()
            && record.owned?.directory === directory && record.owned?.parent === parent
            && String(stat.dev) === record.owned?.identity?.dev && String(stat.ino) === record.owned?.identity?.ino
            && !artifactOwnershipRegistered(paths.directory, directory)) historical.set(directory, Number(stat.mtimeMs));
      } catch { /* Never adopt a missing, replaced or unowned historical directory. */ }
    }
  }
  retainArtifacts(paths.directory, "active-helpers", [...pins], 1, [], { deferCleanup: true });
  for (const [directory] of [...historical].sort((left, right) => left[1] - right[1])) {
    retainArtifacts(paths.directory, "helper-runtime", [directory], 2, [directory], { deferCleanup: true });
  }
  if (current) retainArtifacts(paths.directory, "helper-runtime", [path.join(parent, current)], 2, [path.join(parent, current)], { deferCleanup: true });
}
async function prepareHelperRuntime(options) {
  await fs.promises.mkdir(options.paths.directory, { recursive: true });
  const parent = safePath(options.paths.directory, "helper-runtime");
  const identity = helperRuntimeIdentity(options.installedRoot, options.applicationRoot);
  const key = path.join(options.paths.directory, identity);
  if (!helperPreparations.has(key)) helperPreparations.set(key, (async () => {
    const release = await require("./update-process-lock.cjs").acquireProcessLock(safePath(options.paths.directory, path.join(parent, identity + ".lock")), { timeoutMs: 120000 });
    try {
      const prepared = await prepareHelperRuntimeCopy(options);
      await retainHelperRuntimes(options.paths, prepared.identity);
      return prepared;
    }
    finally { await release(); }
  })().finally(() => helperPreparations.delete(key)));
  return helperPreparations.get(key);
}
async function createUpdateJob({ userData, prepared, currentVersion, channel = "test" }) {
  await require("./update-backups.cjs").retryRetiringBackups(userData).catch(error => console.warn(`Backup cleanup deferred: ${error.message}`));
  const paths = updatePaths(userData); fs.mkdirSync(paths.jobs, { recursive: true });
  const id = crypto.randomUUID(), snapshot = await processSnapshot(), processes = descendants(snapshot, process.pid);
  if (!processes.some(row => row.pid === process.pid)) throw Error("update_process_snapshot_failed");
  const installedRoot = global.__xiaoxiComponents?.installedRoot || path.dirname(process.execPath);
  const applicationRoot = global.__xiaoxiComponents?.applicationRoot || path.join(installedRoot, "resources", "app");
  await reclaimFinishedHelpers(paths, snapshot);
  const parts = [];
  if (prepared.kind !== "components") {
    const source = await fs.promises.realpath(userData);
    parts.push({ path: path.join(path.dirname(userData), path.basename(userData) + "-update-backups"), bytes: await copyBytes(source, backupFilter(source)) });
  }
  // Budget our own copies before the parent exits; the signed v1 manifest has no NSIS expanded size.
  const copyBudget = parts.length ? await checkCopySpace(parts) : [];
  const started = performance.now();
  const runtime = await prepareHelperRuntime({ paths, installedRoot, applicationRoot, executable: process.execPath });
  const runtimeDurationMs = Math.round(performance.now() - started);
  const owned = runtime.owned;
  let createdProgramBackup;
  try {
    if (parts.length) await checkCopySpace(parts);
    const helperExecutable = runtime.helperExecutable;
    const selection = readJson(paths.selection, {});
    let programBackup = prepared.kind === "components" ? null : await require("./update-backups.cjs").reusableProgram(userData, installedRoot, selection);
    if (prepared.kind !== "components" && !programBackup) programBackup = createdProgramBackup = await require("./update-program-backup.cjs").backupProgram(installedRoot, path.join(paths.directory, "program-backups"), id, selection);
    const job = { channel, programBackup, id, parentPid: process.pid, processes, currentVersion, targetVersion: prepared.version, prepared,
      installedRoot, executable: process.execPath, helperExecutable, helperCopyVersion: 2, helperRuntimeIdentity: runtime.identity,
      helperIdentity: owned.identity, copyBudget, helperTiming: { durationMs: runtimeDurationMs, bytes: runtime.created ? runtime.bytes : 0,
        entries: runtime.entries, reused: !runtime.created } };
    const file = path.join(paths.jobs, id + ".json"); writeJsonAtomic(file, job);
    return { file, job };
  } catch (error) {
    if (createdProgramBackup?.owned) await removeOwnedDirectory(createdProgramBackup.owned).catch(cleanup => { error.cleanupCode = cleanup.code || cleanup.message; });
    if (runtime.created) try { await removeOwnedDirectory(owned); } catch (cleanupError) { error.cleanupCode = cleanupError.code || cleanupError.message; }
    throw error;
  }
}
async function runHelper({ jobFile, userData }) {
  const { app, BrowserWindow } = require("electron");
  const paths = updatePaths(userData), full = path.resolve(String(jobFile || ""));
  if (path.dirname(full).toLowerCase() !== path.resolve(paths.jobs).toLowerCase() || !/^[a-f0-9-]{36}\.json$/.test(path.basename(full))) throw Error("update_job_invalid");
  const job = readJson(full);
  if (!job || path.basename(full) !== job.id + ".json" || job.helperExecutable !== process.execPath || job.installedRoot !== path.dirname(job.executable)
      || !Array.isArray(job.processes) || !Number.isInteger(job.parentPid)
      || !VERSION.test(job.currentVersion) || !VERSION.test(job.targetVersion)) throw Error("update_job_invalid");
  app.setPath("userData", path.join(userData, "update-helper-profile"));
  await app.whenReady();
  const window = new BrowserWindow({ width: 640, height: 340, resizable: false, autoHideMenuBar: true, title: `${productBrand.displayName} · 软件更新`,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: "xiaoxi-update-helper" } });
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0;padding:32px;font:15px 'Microsoft YaHei',sans-serif;color:#273442;background:#fff5f7}h1{font-size:23px;margin:14px 0}p{line-height:1.7;color:#596371}small{color:#8b3454}progress{display:block;width:100%;height:18px;margin-top:20px;accent-color:#e83458}</style><small>${productBrand.displayName}　${job.currentVersion} → ${job.targetVersion}</small><h1 id="title">正在准备更新</h1><p id="detail">更新窗口会在软件退出后继续显示进度。</p><progress id="busy" max="100"></progress></html>`));
  let finished = false, currentPhase = "ready";
  const timings = [];
  let measuredPhase = "ready", phaseStarted = performance.now();
  window.on("close", event => { if (!finished) event.preventDefault(); });
  const stage = (phase, title, detail = "", failure) => {
    if (phase !== measuredPhase) {
      timings.push({ phase: measuredPhase, durationMs: Math.round(performance.now() - phaseStarted) });
      measuredPhase = phase; phaseStarted = performance.now();
    }
    if (phase !== "error") currentPhase = phase;
    let persistenceError;
    try { writeJsonAtomic(path.join(paths.jobs, job.id + ".status.json"), { phase, title, detail, failure, timings, updatedAt: new Date().toISOString() }); }
    catch (error) {
      persistenceError = error;
      detail += `\n更新记录未能保存（${updateFailure(error, currentPhase).code}），请保留此窗口的错误信息。`;
    }
    if (!window.isDestroyed()) void window.webContents.executeJavaScript(`document.getElementById('title').textContent=${JSON.stringify(title)};document.getElementById('detail').textContent=${JSON.stringify(detail)};document.getElementById('busy').hidden=${JSON.stringify(phase === "error")};${phase === "complete" ? "document.getElementById('busy').value=100;document.getElementById('detail').textContent+=' 更新完成 100%。';" : "document.getElementById('busy').removeAttribute('value');"}`).catch(() => {});
    if (persistenceError && phase !== "error") throw persistenceError;
  };
  const activeJobFile = path.join(paths.directory, "active-job.json");
  let installationStarted = false, candidate = null;
  let releaseMaintenance;
  try {
    releaseMaintenance = await require("./update-process-lock.cjs").acquireProcessLock(path.join(paths.directory, "maintenance.lock"), { timeoutMs: 120000 });
    // Publish ready last: the parent stays open if either startup receipt cannot be written.
    writeJsonAtomic(activeJobFile, { id: job.id, pid: process.pid });
    writeJsonAtomic(path.join(paths.jobs, job.id + ".ready.json"), { pid: process.pid });
    await waitForAuthorization(full, job);
    job.authorizationFile = full;
    const config = require("./cloud-config.cjs").cloudConfig({ channel: job.channel || "test" });
    stage("waiting", "等待软件和工作进程退出", "退出完成后将继续安装更新。");
    await waitForExit(job, stage);
    const prepared = job.prepared;
    let dataBackup;
    stage("verifying", "正在校验更新", "正在核对签名和完整版本文件。");
    if (prepared.kind === "components") {
      const expected = path.join(paths.generations, path.basename(prepared.generationRoot));
      if (path.resolve(prepared.generationRoot) !== expected) throw Error("component_selection_invalid");
      const manifest = await verifySelected(expected, job.installedRoot, config);
      if (manifest.version !== job.targetVersion) throw Error("update_version_mismatch");
      const prior = readJson(paths.selection, {});
      stage("installing", "正在切换到新版本", "所有工作进程已退出，正在切换完整版本。");
      saveSelection(paths, { active: path.basename(expected), previous: prior.active || null,
        pending: { jobId: job.id, attempted: false }, failure: "", lastUpdate: null });
    } else {
      const manifest = verifyManifest(prepared.envelope, config);
      if (manifest.version !== job.targetVersion) throw Error("cloud_download_invalid");
      await require("./download-verification.cjs").verifyDownload(prepared.file, manifest);
      stage("backup", "正在备份本机数据", "保留配置、授权和业务记录，备份完成后开始完整升级。");
      const backups = require("./update-backups.cjs");
      dataBackup = await backups.captureData(userData, job.id);
      await backups.registerSet(userData, { id: job.id, version: job.currentVersion, programBackup: job.programBackup, data: dataBackup });
      stage("installing", "正在安装完整更新", "正在安装，请勿关闭电脑。");
      if (!job.programBackup) throw Error("update_backup_missing");
      installationStarted = true;
      await new Promise((resolve, reject) => {
        const child = spawn(prepared.file, ["/S"], { stdio: "ignore", windowsHide: true, cwd: path.dirname(job.helperExecutable) });
        child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(Error("full_installer_failed")));
      });
      saveSelection(paths, { active: null, previous: null, pending: { jobId: job.id, attempted: false, notes: manifest.notes }, lastUpdate: null });
    }
    stage("starting", "正在启动新版本", "等待软件完成启动检查。");
    const launchStarted = Date.now();
    const child = spawn(job.executable, ["--xiaoxi-updated-launch", job.id], { detached: true, stdio: "ignore", windowsHide: false, cwd: path.dirname(job.helperExecutable) });
    let exited = false; child.once("error", () => { exited = true; }); child.once("exit", () => { exited = true; }); child.unref();
    const ack = path.join(paths.jobs, job.id + ".ack.json"), until = Date.now() + 90000;
    candidate = { pid: child.pid, processes: child.pid ? trackLaunch([], child.pid, launchStarted) : [] };
    let launchedProcesses = child.pid ? trackLaunch(await processSnapshot(), child.pid, launchStarted) : [];
    candidate.processes = launchedProcesses;
    while (!fs.existsSync(ack) && !exited && Date.now() < until) {
      if (child.pid) launchedProcesses = trackLaunch(await processSnapshot(), child.pid, launchStarted, launchedProcesses);
      candidate.processes = launchedProcesses;
      await sleep(500);
    }
    if (!readJson(ack)?.ok || readJson(ack)?.version !== job.targetVersion) {
      // Stop only the process created by this update before restoring the pointer.
      if (child.pid) await stopLaunch(child.pid, launchedProcesses, stage);
      if (prepared.kind === "components") {
        // Bootstrap may already have recovered a damaged/interrupted candidate.
        // Do not roll back again and discard that last working generation.
        if (readJson(paths.selection)?.pending?.jobId === job.id) rollbackSelection(paths, "新版未能启动，已恢复上一版本。");
        const restored = spawn(job.executable, ["--xiaoxi-updated-launch", job.id], { detached: true, stdio: "ignore", windowsHide: false, cwd: path.dirname(job.helperExecutable) }); restored.on("error", () => {}); restored.unref();
      }
      throw Error(prepared.kind === "components" ? "update_start_rolled_back" : "update_start_failed");
    }
    installationStarted = false;
    stage("complete", prepared.finalTargetVersion
      ? `基础版本已就绪，目标版本 ${prepared.finalTargetVersion} 尚待更新`
      : `已更新至 ${job.targetVersion}`, prepared.finalTargetVersion
      ? "软件将继续检查组件更新，请在软件中完成剩余更新。你的配置和业务数据已保留。"
      : "新版本已成功启动，你的配置和业务数据已保留。");
    // Housekeeping cannot turn a successful update into a failed update.
    try {
      await require("./update-backups.cjs").retryRetiringBackups(userData);
      if (dataBackup) {
        const backups = require("./update-backups.cjs");
        await backups.confirmSet(userData, job.id, { targetVersion: job.targetVersion, ack: readJson(ack),
          dataCheck: await backups.inspectPreservedData(userData, dataBackup, { runtimeRoot: job.installedRoot }) });
      }
      // Recalculate references after backup retirement, not before it.
      await require("./update-retention.cjs").retainComponentArtifacts(paths.directory);
    } catch (error) { console.warn(`Post-update cleanup deferred: ${error.code || error.message}`); }
    finished = true; setTimeout(() => app.quit(), 1800);
  } catch (error) {
    if (installationStarted && job.programBackup) {
      try {
        try { stage("backup", "正在恢复上一版本", "新版未能完成更新，正在恢复原程序。你的业务数据保持原样。"); } catch { /* Receipt failure cannot prevent recovery. */ }
        if (candidate?.pid) await stopLaunch(candidate.pid, candidate.processes, () => {});
        if (path.resolve(job.programBackup.installedRoot).toLowerCase() !== path.resolve(job.installedRoot).toLowerCase()) throw Error("update_backup_path_invalid");
        await require("./update-program-backup.cjs").restoreProgram(job.programBackup);
        saveSelection(paths, { ...job.programBackup.selection, pending: null, failure: "更新未完成，已恢复上一版本。", lastUpdate: null });
        const restored = spawn(job.executable, ["--xiaoxi-updated-launch", job.id], { detached: true, stdio: "ignore", windowsHide: false, cwd: path.dirname(job.helperExecutable) });
        restored.on("error", () => {}); restored.unref();
        error = Error("update_start_rolled_back");
      } catch (restoreError) { error = Object.assign(Error("update_restore_failed"), { cause: restoreError }); }
    }
    const messages = { update_workers_still_running: "仍有工作进程占用，更新尚未安装。退出相关任务后重新检查更新。", update_start_rolled_back: "新版本启动失败，已恢复上一版本，可重新检查更新。", update_start_failed: "更新启动未完成，请重试。" };
    const failure = updateFailure(error, currentPhase);
    finished = true;
    stage("error", "更新未完成", messages[failure.code] || formatUpdateFailure(failure), failure);
  } finally {
    // Failure to remove a receipt must never hide the original failure or lock its window.
    try { if (readJson(activeJobFile)?.id === job.id) fs.rmSync(activeJobFile, { force: true }); } catch {}
    if (releaseMaintenance) await releaseMaintenance();
  }
  app.on("window-all-closed", () => app.quit());
}
module.exports = { hasLiveUpdateHelper, processSnapshot, descendants, trackLaunch, waitForExit, backupUserData, createUpdateJob, authorizeUpdateJob, revokeUpdateJob, waitForAuthorization, runHelper, prepareHelperRuntime, helperRuntimeIdentity, retainHelperRuntimes };
