const fs = process.versions.electron ? require("original-fs") : require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { updatePaths } = require("./component-paths.cjs");
const { safePath } = require("../shared/artifact-retention.cjs");
const { hashFile } = require("../shared/component-contract.cjs");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));

async function findExitHelper(profile, executable, runtimeRoot = path.dirname(executable)) {
  const root = fs.realpathSync(updatePaths(profile).directory);
  const running = fs.statSync(executable, { bigint: true });
  let expectedHash;
  let runtimeIdentity;
  try { runtimeIdentity = require("./update-helper.cjs").helperRuntimeIdentity(path.dirname(executable), path.join(runtimeRoot, "resources/app")); }
  catch { /* Legacy installations can still use a fully verified v1 helper. */ }
  const jobs = fs.readdirSync(path.join(root, "jobs")).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
  const records = jobs.flatMap(name => { try { return [{ name, job: read(path.join(root, "jobs", name)) }]; } catch { return []; } })
    .sort((left, right) => (right.job.helperCopyVersion || 0) - (left.job.helperCopyVersion || 0));
  for (const { name, job } of records) {
    try {
      if (job.id + ".json" !== name || ![1, 2].includes(job.helperCopyVersion)
          || read(path.join(root, "jobs", job.id + ".status.json")).phase !== "complete") continue;
      if (job.helperCopyVersion === 2 && (!runtimeIdentity || job.helperRuntimeIdentity !== runtimeIdentity)) continue;
      const directory = safePath(root, path.join("helper-runtime", job.helperCopyVersion === 2 ? runtimeIdentity : job.id));
      const helper = safePath(root, path.join(directory, "ai-update-helper.exe"));
      if (path.resolve(job.helperExecutable) !== helper) continue;
      const owner = fs.lstatSync(directory, { bigint: true }), binary = fs.lstatSync(helper, { bigint: true });
      if (!owner.isDirectory() || String(owner.dev) !== job.helperIdentity?.dev || String(owner.ino) !== job.helperIdentity?.ino
          || !binary.isFile() || binary.size !== running.size || (binary.dev === running.dev && binary.ino === running.ino)) continue;
      if (job.helperCopyVersion === 1) {
        expectedHash ||= await hashFile(executable);
        if (await hashFile(helper) !== expectedHash) continue;
      } else {
        const receipt = read(path.join(directory, ".helper-runtime.json"));
        if (receipt.schema !== 2 || receipt.identity !== runtimeIdentity
            || receipt.owned?.identity?.dev !== String(owner.dev) || receipt.owned?.identity?.ino !== String(owner.ino)) continue;
      }
      return helper;
    } catch { /* Missing, replaced, unfinished or unsafe helpers are not adopted. */ }
  }
  return null;
}

async function collectAfterExit({ profile, parentPid, runtimeRoot, installedRoot }, { timeoutMs = 120000 } = {}) {
  if (!Number.isInteger(parentPid) || parentPid <= 0 || parentPid === process.pid) throw Error("exit_cleanup_pid_invalid");
  const root = fs.realpathSync(updatePaths(profile).directory), deadline = Date.now() + timeoutMs;
  const receipt = path.join(root, "exit-maintenance-last.json");
  while (true) {
    try { process.kill(parentPid, 0); }
    catch (error) { if (error.code === "ESRCH") break; throw error; }
    if (Date.now() >= deadline) {
      writeJsonAtomic(receipt, { at: new Date().toISOString(), state: "deferred", reason: "parent_still_running", parentPid });
      return;
    }
    await sleep(250);
  }
  // A rapid restart/update can retain the executable lock. Never kill it or
  // bypass live selection references; leave any occupied entries for next exit.
  const selection = read(path.join(root, "selection.json"));
  const source = fs.realpathSync(runtimeRoot);
  const selectedSource = [selection.active, selection.previous].filter(Boolean).some(id =>
    fs.realpathSync(path.join(root, "generations", id)) === source);
  // A full upgrade boots directly from its installed base, with null pointers.
  // Only this actual entry's installation directory may use that fallback.
  const installedSource = installedRoot && source === fs.realpathSync(installedRoot)
    && fs.realpathSync(path.join(source, "resources/app/src/main/update-exit-maintenance.cjs")) === fs.realpathSync(__filename);
  if (!selectedSource && !installedSource) throw Error("exit_cleanup_source_not_retained");
  await require("./update-retention.cjs").retainComponentArtifacts(root);
  writeJsonAtomic(receipt, { at: new Date().toISOString(), state: "attempted", parentPid });
}

async function launchExitMaintenance({ profile, runtimeRoot, executable = process.execPath }) {
  const helper = await findExitHelper(profile, executable, runtimeRoot);
  if (!helper) return false; // No copy is created solely for cleanup.
  const root = fs.realpathSync(updatePaths(profile).directory);
  const log = fs.openSync(safePath(root, "exit-maintenance.log"), "w");
  try {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    delete env.NODE_OPTIONS; delete env.NODE_PATH;
    const child = spawn(helper, [__filename, "--after-exit", JSON.stringify({
      profile, runtimeRoot, installedRoot: path.dirname(executable), parentPid: process.pid
    })],
      { env, cwd: path.dirname(helper), detached: true, windowsHide: true, stdio: ["ignore", log, log] });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    return true;
  } finally { fs.closeSync(log); }
}

if (require.main === module && process.argv[2] === "--after-exit") {
  collectAfterExit(JSON.parse(process.argv[3])).catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
}
module.exports = { findExitHelper, collectAfterExit, launchExitMaintenance };
