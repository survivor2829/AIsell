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
async function processSnapshot() {
  const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress"],
    { windowsHide: true, maxBuffer: 8 * 1024 ** 2, timeout: 15000 });
  const rows = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
  return (Array.isArray(rows) ? rows : [rows]).map(row => ({ pid: row.ProcessId, parent: row.ParentProcessId, created: row.CreationDate }));
}
function descendants(rows, rootPid, seed = []) {
  const selected = new Map(seed.map(row => [row.pid, row]));
  const root = rows.find(row => row.pid === rootPid); if (root) selected.set(root.pid, root);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (selected.has(row.parent) && !selected.has(row.pid)) { selected.set(row.pid, row); changed = true; }
  }
  return [...selected.values()];
}
async function waitForExit(job, onStage, timeoutMs = 120000) {
  let tracked = job.processes, until = Date.now() + timeoutMs;
  while (true) {
    const rows = await processSnapshot();
    const own = new Set(descendants(rows, process.pid).map(row => row.pid));
    tracked = descendants(rows, job.parentPid, tracked).filter(row => !own.has(row.pid));
    const alive = tracked.filter(row => rows.some(candidate => candidate.pid === row.pid && candidate.created === row.created));
    if (!alive.length) return;
    if (Date.now() > until) throw Error("update_workers_still_running");
    onStage("waiting", "等待软件和工作进程退出", `仍有 ${alive.length} 个相关进程正在退出，请保留此窗口。`);
    await sleep(1000);
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
async function createUpdateJob({ userData, prepared, currentVersion }) {
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
    const job = { id, parentPid: process.pid, processes, currentVersion, targetVersion: prepared.version, prepared,
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
  const window = new BrowserWindow({ width: 560, height: 320, resizable: false, autoHideMenuBar: true, title: "AI获客 · 软件更新",
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: "xiaoxi-update-helper" } });
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0;padding:32px;font:15px 'Microsoft YaHei',sans-serif;color:#273442;background:#fff5f7}h1{font-size:23px;margin:14px 0}p{line-height:1.7;color:#596371}small{color:#8b3454}progress{width:100%;accent-color:#e83458}</style><small>AI获客　${job.currentVersion} → ${job.targetVersion}</small><h1 id="title">正在准备更新</h1><p id="detail">更新窗口会在软件退出后继续显示进度。</p><progress id="busy"></progress></html>`));
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
  try {
    // Publish ready last: the parent stays open if either startup receipt cannot be written.
    writeJsonAtomic(activeJobFile, { id: job.id, pid: process.pid });
    writeJsonAtomic(path.join(paths.jobs, job.id + ".ready.json"), { pid: process.pid });
    const config = require("./cloud-config.cjs").cloudConfig({ developmentEdition: true });
    currentPhase = "waiting";
    await waitForExit(job, stage);
    const prepared = job.prepared;
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
      await backupUserData(userData, job.id);
      stage("installing", "正在安装完整更新", "安装程序正在替换运行底座，请勿关闭电脑。");
      await new Promise((resolve, reject) => {
        const child = spawn(prepared.file, ["/S"], { stdio: "ignore", windowsHide: true });
        child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(Error("full_installer_failed")));
      });
      saveSelection(paths, { active: null, previous: null, pending: { jobId: job.id, attempted: false, notes: manifest.notes }, lastUpdate: null });
    }
    stage("starting", "正在启动新版本", "等待软件完成启动检查。");
    const child = spawn(job.executable, ["--xiaoxi-updated-launch", job.id], { detached: true, stdio: "ignore", windowsHide: false });
    let exited = false; child.once("error", () => { exited = true; }); child.once("exit", () => { exited = true; }); child.unref();
    const ack = path.join(paths.jobs, job.id + ".ack.json"), until = Date.now() + 90000;
    while (!fs.existsSync(ack) && !exited && Date.now() < until) await sleep(500);
    if (!readJson(ack)?.ok) {
      // Stop only the process created by this update before restoring the pointer.
      if (child.pid && !exited) {
        const owned = descendants(await processSnapshot(), child.pid);
        await promisify(execFile)("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        await waitForExit({ parentPid: child.pid, processes: owned }, stage, 15000);
      }
      if (prepared.kind === "components") {
        // Bootstrap may already have recovered a damaged/interrupted candidate.
        // Do not roll back again and discard that last working generation.
        if (readJson(paths.selection)?.pending?.jobId === job.id) rollbackSelection(paths, "新版未能启动，已恢复上一版本。");
        const restored = spawn(job.executable, ["--xiaoxi-updated-launch", job.id], { detached: true, stdio: "ignore", windowsHide: false }); restored.on("error", () => {}); restored.unref();
      }
      throw Error(prepared.kind === "components" ? "update_start_rolled_back" : "update_start_failed_repair_required");
    }
    stage("complete", `已更新至 ${job.targetVersion}`, "新版本已成功启动，你的配置和业务数据已保留。");
    finished = true; setTimeout(() => app.quit(), 1800);
  } catch (error) {
    const messages = { update_workers_still_running: "仍有工作进程占用，更新尚未安装。退出相关任务后重新检查更新。", update_start_rolled_back: "新版本启动失败，已恢复上一版本，可重新检查更新。", update_start_failed_repair_required: "完整更新已安装，但启动未完成。请重新打开软件；仍失败时使用完整安装包修复。" };
    const failure = updateFailure(error, currentPhase);
    finished = true;
    stage("error", "更新未完成", messages[failure.code] || formatUpdateFailure(failure), failure);
  } finally {
    // Failure to remove a receipt must never hide the original failure or lock its window.
    try { if (readJson(activeJobFile)?.id === job.id) fs.rmSync(activeJobFile, { force: true }); } catch {}
  }
  app.on("window-all-closed", () => app.quit());
}
module.exports = { processSnapshot, descendants, waitForExit, backupUserData, createUpdateJob, runHelper };
