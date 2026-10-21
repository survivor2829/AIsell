const fs = process.versions.electron ? require("original-fs") : require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { updatePaths } = require("./component-paths.cjs");
const { safePath } = require("../shared/artifact-retention.cjs");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { Worker, isMainThread, workerData, parentPort } = require("node:worker_threads");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));

function retirementStatus(profile) {
  const root = updatePaths(profile).directory, reasons = [];
  for (const directory of [root, path.dirname(root)]) {
    const ledger = path.join(directory, ".artifact-retention.json");
    if (fs.existsSync(ledger)) {
      const data = read(ledger), protectedFiles = new Set(Object.values(data).flatMap(state => state.generations.flat()));
      for (const state of Object.values(data)) if (state.owned.some(file => !protectedFiles.has(file))) reasons.push(state.cleanupFailure?.reason || state.cleanupDeferred?.reason || "unreferenced_artifacts");
    }
    const inbox = path.join(directory, ".artifact-retention-requests");
    if (fs.existsSync(inbox) && fs.readdirSync(inbox).some(name => name.endsWith(".json"))) reasons.push("retention_requests_pending");
  }
  const registry = path.join(root, "backup-registry.json");
  if (fs.existsSync(registry) && read(registry).sets.some(set => set.state === "retiring")) reasons.push("backup_retirement_pending");
  return { pending: reasons.length > 0, reasons: [...new Set(reasons)] };
}
function writeDeferred(profile, error, details = {}) {
  writeJsonAtomic(path.join(updatePaths(profile).directory, "exit-maintenance-last.json"), {
    at: new Date().toISOString(), state: "deferred", reason: error.code || error.message || String(error), ...details });
}
function validateSource(root, runtimeRoot, installedRoot) {
  // Re-evaluated after waiting for the original parent and acquiring the same
  // guard as the update helper. A fast reopen never grants deletion authority.
  const selection = read(path.join(root, "selection.json"));
  const source = fs.realpathSync(runtimeRoot);
  const selectedSource = [selection.active, selection.previous].filter(Boolean).some(id =>
    fs.realpathSync(path.join(root, "generations", id)) === source);
  // A full upgrade boots directly from its installed base, with null pointers.
  // Only this actual entry's installation directory may use that fallback.
  const installedSource = installedRoot && source === fs.realpathSync(installedRoot)
    && fs.realpathSync(path.join(source, "resources/app/src/main/update-exit-maintenance.cjs")) === fs.realpathSync(__filename);
  if (!selectedSource && !installedSource) throw Error("exit_cleanup_source_not_retained");
}
async function collectAfterExit({ profile, parentPid, parentCreated, runtimeRoot, installedRoot }, {
  timeoutMs = 120000, snapshot = () => require("./update-helper.cjs").processSnapshot(), ready = () => {
    if (process.connected) process.send({ ready: true }, error => { if (error) console.warn("exit_parent_disconnected"); });
  }
} = {}) {
  if (!Number.isInteger(parentPid) || parentPid <= 0 || parentPid === process.pid || !parentCreated) throw Error("exit_cleanup_pid_invalid");
  const root = fs.realpathSync(updatePaths(profile).directory), deadline = performance.now() + timeoutMs;
  validateSource(root, runtimeRoot, installedRoot);
  let rows = await snapshot();
  ready();
  while (rows.some(row => row.pid === parentPid && row.created === parentCreated)) {
    if (performance.now() >= deadline) { writeDeferred(profile, Error("parent_still_running"), { parentPid, parentCreated }); return; }
    await sleep(250);
    rows = await snapshot();
  }
  const release = await require("./update-process-lock.cjs").acquireProcessLock(path.join(root, "maintenance.lock"), { timeoutMs: 0 });
  try {
    validateSource(root, runtimeRoot, installedRoot);
    const active = path.join(root, "active-job.json");
    if (fs.existsSync(active)) {
      const job = read(active), status = read(path.join(root, "jobs", job.id + ".status.json"));
      if (!["complete", "error"].includes(status.phase)) throw Error("active_update");
    }
    await require("./update-helper.cjs").retainHelperRuntimes(updatePaths(profile), null, await snapshot());
    const failures = [];
    try { await require("./update-backups.cjs").retryRetiringBackups(profile); }
    catch (error) { failures.push(error.code || error.message); }
    const retained = await require("./update-retention.cjs").retainComponentArtifacts(root);
    if (!retained.ok) failures.push(retained.reason);
    if (!require("../shared/artifact-retention.cjs").retryArtifacts(path.dirname(root))) failures.push("download_retention_deferred");
    const status = retirementStatus(profile);
    if (failures.length) { status.pending = true; status.reasons = [...new Set([...status.reasons, ...failures])]; }
    writeJsonAtomic(path.join(root, "exit-maintenance-last.json"), { at: new Date().toISOString(),
      state: status.pending ? "deferred" : "complete", ...status, parentPid, parentCreated });
  } finally { await release(); }
}

const preparations = new Map();
function prepareExitMaintenance({ profile, runtimeRoot, executable = process.execPath }) {
  const key = JSON.stringify([profile, runtimeRoot, executable]);
  if (!preparations.has(key)) {
    const promise = new Promise((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: { prepareExit: { profile, runtimeRoot, executable } } });
      let result;
      worker.once("message", value => { result = value; });
      worker.once("error", reject);
      worker.once("exit", code => code === 0 ? resolve(result || null) : reject(Error(result?.error || "exit_helper_prepare_failed")));
    }).then(result => { if (!result) preparations.delete(key); return result; })
      .catch(error => { preparations.delete(key); writeDeferred(profile, error); throw error; });
    preparations.set(key, promise);
  }
  return preparations.get(key);
}
async function launchExitMaintenance(options, { timeoutMs = 15000 } = {}) {
  const { profile, runtimeRoot, executable = process.execPath } = options;
  const deadline = performance.now() + timeoutMs;
  let timer, prepared;
  try {
    // Keep the shared task alive; a deadline never starts a second copy or kills
    // an owned worker midway through writing its recoverable preparation marker.
    prepared = await Promise.race([prepareExitMaintenance(options), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("exit_helper_prepare_timeout")), timeoutMs);
    })]);
  } catch (error) { writeDeferred(profile, error); throw error; }
  finally { clearTimeout(timer); }
  if (!prepared) return false;
  const helper = prepared.helperExecutable;
  const root = fs.realpathSync(updatePaths(profile).directory);
  const parent = { pid: prepared.parentPid, created: prepared.parentCreated };
  if (parent.pid !== process.pid || !parent.created) { const error = Error("exit_cleanup_parent_identity_missing"); writeDeferred(profile, error); throw error; }
  const log = fs.openSync(safePath(root, "exit-maintenance.log"), "w");
  try {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    delete env.NODE_OPTIONS; delete env.NODE_PATH;
    const child = spawn(helper, [__filename, "--after-exit", JSON.stringify({
      profile, runtimeRoot, installedRoot: path.dirname(executable), parentPid: process.pid, parentCreated: parent.created
    })],
      { env, cwd: path.dirname(helper), detached: true, windowsHide: true, stdio: ["ignore", log, log, "ipc"] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(Error("exit_helper_ready_timeout")), Math.max(1, deadline - performance.now()));
      const finish = error => { clearTimeout(timer); child.removeListener("error", onError); child.removeListener("exit", onExit); child.removeListener("message", onMessage); if (child.connected) child.disconnect(); error ? reject(error) : resolve(); };
      const onError = error => finish(error), onExit = () => finish(Error("exit_helper_exited_before_ready"));
      const onMessage = message => { if (message?.ready === true) finish(); };
      child.once("error", onError); child.once("exit", onExit); child.on("message", onMessage);
    });
    child.unref();
    return true;
  } catch (error) { writeDeferred(profile, error); throw error; }
  finally { fs.closeSync(log); }
}

if (!isMainThread && workerData?.prepareExit) {
  const options = workerData.prepareExit;
  (async () => {
    if (!retirementStatus(options.profile).pending) { parentPort.postMessage(null); return; }
    const helper = await require("./update-helper.cjs").prepareHelperRuntime({ paths: updatePaths(options.profile),
      installedRoot: path.dirname(options.executable), applicationRoot: path.join(options.runtimeRoot, "resources/app"), executable: options.executable });
    const parent = (await require("./update-helper.cjs").processSnapshot()).find(row => row.pid === process.pid && row.created);
    if (!parent) throw Error("exit_cleanup_parent_identity_missing");
    parentPort.postMessage({ helperExecutable: helper.helperExecutable, identity: helper.identity, parentPid: parent.pid, parentCreated: parent.created });
  })().catch(error => { writeDeferred(options.profile, error); parentPort.postMessage({ error: error.code || error.message }); process.exitCode = 1; });
}
if (require.main === module && process.argv[2] === "--after-exit") {
  const options = JSON.parse(process.argv[3]);
  collectAfterExit(options).catch(error => { writeDeferred(options.profile, error); console.error(error.code || error.message); process.exitCode = 1; });
}
module.exports = { collectAfterExit, launchExitMaintenance, prepareExitMaintenance, retirementStatus };
