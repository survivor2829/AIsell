// Backups and runtime copies need physical ASAR files, not Electron's virtual directories.
const fs = process.versions.electron ? require("original-fs") : require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { readJson, updatePaths, verifySelected, saveSelection, rollbackSelection } = require("./component-paths.cjs");
const { verifyManifest, VERSION } = require("../shared/cloud-contract.cjs");
const { hashFile } = require("../shared/component-contract.cjs");
const { backupFilter, copyBytes, checkCopySpace, createOwnedDirectory, removeOwnedDirectory, updateFailure, formatUpdateFailure } = require("./update-storage.cjs");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const productBrand = require("../../product-brand.json");
async function processSnapshot() {
  const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress"],
    { windowsHide: true, maxBuffer: 8 * 1024 ** 2, timeout: 15000 });
  const rows = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
  return (Array.isArray(rows) ? rows : [rows]).map(row => ({ pid: row.ProcessId, parent: row.ParentProcessId, created: row.CreationDate }));
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
  const parent = path.join(path.dirname(userData), path.basename(userData) + "-update-backups");
  const source = await fs.promises.realpath(userData), filter = backupFilter(source);
  await checkCopySpace([{ path: parent, bytes: await copyBytes(source, filter) }]);
  const owned = await createOwnedDirectory(parent, id);
  try {
    await fs.promises.cp(source, owned.directory, { recursive: true, errorOnExist: true, force: false, filter });
    writeJsonAtomic(path.join(owned.directory, "update-backup.json"), { createdAt: new Date().toISOString(), kind: "before-full-upgrade" });
    return owned.directory;
  } catch (error) {
    try { await removeOwnedDirectory(owned); } catch (cleanupError) { error.cleanupCode = cleanupError.code || cleanupError.message; }
    throw error;
  }
}
async function reclaimFinishedHelpers(paths, processes) {
  const parent = path.join(paths.directory, "helper-runtime");
  if (!fs.existsSync(parent)) return;
  const realParent = await fs.promises.realpath(parent);
  for (const name of await fs.promises.readdir(paths.jobs)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const id = name.slice(0, -5), job = readJson(path.join(paths.jobs, name));
    const status = readJson(path.join(paths.jobs, id + ".status.json")), ready = readJson(path.join(paths.jobs, id + ".ready.json"));
    const directory = path.join(realParent, id);
    if (job?.helperCopyVersion !== 1 || job.id !== id || job.helperExecutable !== path.join(directory, "ai-update-helper.exe")
        || !["error", "complete"].includes(status?.phase) || !Number.isInteger(ready?.pid) || ready.pid <= 0
        || processes.some(row => row.pid === ready.pid)) continue;
    // Old backups, unmarked helpers and jobs without conclusive exit evidence are never swept.
    try { await removeOwnedDirectory({ parent: realParent, directory, identity: job.helperIdentity }); } catch { /* In use or uncertain: preserve it. */ }
  }
}
async function createUpdateJob({ userData, prepared, currentVersion, channel = "test" }) {
  const paths = updatePaths(userData); fs.mkdirSync(paths.jobs, { recursive: true });
  const id = crypto.randomUUID(), snapshot = await processSnapshot(), processes = descendants(snapshot, process.pid);
  if (!processes.some(row => row.pid === process.pid)) throw Error("update_process_snapshot_failed");
  await reclaimFinishedHelpers(paths, snapshot);
  const installedRoot = global.__xiaoxiComponents?.installedRoot || path.dirname(process.execPath);
  const applicationRoot = global.__xiaoxiComponents?.applicationRoot || path.join(installedRoot, "resources", "app");
  const copies = [];
  // A full installer must be free to replace the installed Electron runtime.
  // The helper uses its own executable name and files outside that directory.
  for (const entry of fs.readdirSync(installedRoot, { withFileTypes: true })) {
    if ((entry.isFile() && (!entry.name.endsWith(".exe") || entry.name === "crashpad_handler.exe"))
        || (entry.isDirectory() && entry.name === "locales")) copies.push({ source: path.join(installedRoot, entry.name), target: entry.name });
  }
  copies.push({ source: process.execPath, target: "ai-update-helper.exe" }, { source: applicationRoot, target: "resources/app" });
  let helperBytes = 0;
  for (const copy of copies) helperBytes += await copyBytes(copy.source);
  const parent = path.join(paths.directory, "helper-runtime"), parts = [{ path: parent, bytes: helperBytes }];
  if (prepared.kind !== "components") {
    const source = await fs.promises.realpath(userData);
    parts.push({ path: path.join(path.dirname(userData), path.basename(userData) + "-update-backups"), bytes: await copyBytes(source, backupFilter(source)) });
  }
  // Budget our own copies before the parent exits; the signed v1 manifest has no NSIS expanded size.
  const copyBudget = await checkCopySpace(parts), owned = await createOwnedDirectory(parent, id);
  try {
    for (const copy of copies) await fs.promises.cp(copy.source, path.join(owned.directory, copy.target), { recursive: true, errorOnExist: true, force: false });
    const helperExecutable = path.join(owned.directory, "ai-update-helper.exe");
    const programBackup = prepared.kind === "components" ? null : await require("./update-program-backup.cjs").backupProgram(installedRoot, path.join(paths.directory, "program-backups"), id, readJson(paths.selection, {}));
    const job = { channel, programBackup, id, parentPid: process.pid, processes, currentVersion, targetVersion: prepared.version, prepared,
      installedRoot, executable: process.execPath, helperExecutable, helperCopyVersion: 1, helperIdentity: owned.identity, copyBudget };
    const file = path.join(paths.jobs, id + ".json"); writeJsonAtomic(file, job);
    return { file, job };
  } catch (error) {
    try { await removeOwnedDirectory(owned); } catch (cleanupError) { error.cleanupCode = cleanupError.code || cleanupError.message; }
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
  const window = new BrowserWindow({ width: 560, height: 320, resizable: false, autoHideMenuBar: true, title: `${productBrand.displayName} · 软件更新`,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: "xiaoxi-update-helper" } });
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0;padding:32px;font:15px 'Microsoft YaHei',sans-serif;color:#273442;background:#fff5f7}h1{font-size:23px;margin:14px 0}p{line-height:1.7;color:#596371}small{color:#8b3454}progress{width:100%;accent-color:#e83458}</style><small>${productBrand.displayName}　${job.currentVersion} → ${job.targetVersion}</small><h1 id="title">正在准备更新</h1><p id="detail">更新窗口会在软件退出后继续显示进度。</p><progress id="busy"></progress></html>`));
  let finished = false, currentPhase = "ready";
  window.on("close", event => { if (!finished) event.preventDefault(); });
  const stage = (phase, title, detail = "", failure) => {
    if (phase !== "error") currentPhase = phase;
    let persistenceError;
    try { writeJsonAtomic(path.join(paths.jobs, job.id + ".status.json"), { phase, title, detail, failure, updatedAt: new Date().toISOString() }); }
    catch (error) {
      persistenceError = error;
      detail += `\n更新记录未能保存（${updateFailure(error, currentPhase).code}），请保留此窗口的错误信息。`;
    }
    if (!window.isDestroyed()) void window.webContents.executeJavaScript(`document.getElementById('title').textContent=${JSON.stringify(title)};document.getElementById('detail').textContent=${JSON.stringify(detail)};document.getElementById('busy').hidden=${JSON.stringify(["error", "complete"].includes(phase))}`).catch(() => {});
    if (persistenceError && phase !== "error") throw persistenceError;
  };
  const activeJobFile = path.join(paths.directory, "active-job.json");
  let installationStarted = false, candidate = null;
  try {
    // Publish ready last: the parent stays open if either startup receipt cannot be written.
    writeJsonAtomic(activeJobFile, { id: job.id, pid: process.pid });
    writeJsonAtomic(path.join(paths.jobs, job.id + ".ready.json"), { pid: process.pid });
    const config = require("./cloud-config.cjs").cloudConfig({ channel: job.channel || "test" });
    currentPhase = "waiting";
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
      if (manifest.version !== job.targetVersion || await hashFile(prepared.file) !== manifest.sha256 || fs.statSync(prepared.file).size !== manifest.size) throw Error("cloud_download_invalid");
      stage("backup", "正在备份本机数据", "保留配置、授权和业务记录，备份完成后开始完整升级。");
      dataBackup = await backupUserData(userData, job.id);
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
    stage("complete", `已更新至 ${job.targetVersion}`, "新版本已成功启动，你的配置和业务数据已保留。");
    // Housekeeping cannot turn a successful update into a failed update.
    try {
      await require("./update-retention.cjs").retainComponentArtifacts(paths.directory);
      // Retire old ledger ownership, not the business-data snapshots themselves.
      if (dataBackup) require("../shared/artifact-retention.cjs").retainArtifacts(path.dirname(dataBackup), "successful-full-upgrades", [], 1, []);
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
  }
  app.on("window-all-closed", () => app.quit());
}
module.exports = { processSnapshot, descendants, trackLaunch, waitForExit, backupUserData, createUpdateJob, runHelper };
