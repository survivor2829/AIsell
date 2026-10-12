const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createUpdateCoordinator } = require("./update-coordinator.cjs");
const { backupProgram, restoreProgram } = require("./update-program-backup.cjs");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  let busy = true, installs = 0, quits = 0, held = false, state = {};
  const coordinator = createUpdateCoordinator({
    controller: { status: () => state, prepareInstall: async () => true,
      setUpdateRequest: (requested, reason) => { state = { requested, reason }; },
      beginInstall: async () => { installs++; return true; }, setInstallBlocked() {} },
    setHold: value => { held = value; }, prepare: async () => busy ? "saving" : "",
    release: async () => {}, quit: () => { quits++; }, intervalMs: 5
  });
  await coordinator.request(); await sleep(15);
  assert.equal(installs, 0); assert.equal(held, true);
  await coordinator.cancel(); busy = false; await sleep(15);
  assert.equal(installs, 0); assert.equal(held, false);
  await coordinator.request(); await sleep(15);
  assert.equal(installs, 1); assert.equal(quits, 1);
  const { trackLaunch } = require("./update-helper.cjs");
  const started = Date.parse("2026-10-11T12:00:00Z");
  const processes = trackLaunch([
    { pid: 21, parent: 20, created: new Date(started + 10).toISOString() },
    { pid: 22, parent: 21, created: new Date(started + 20).toISOString() },
    { pid: 23, parent: 20, created: new Date(started - 120000).toISOString() }
  ], 20, started);
  assert.deepEqual(processes.map(row => row.pid), [20, 21, 22], "Workers remain owned after the launched parent exits; older PID-reuse descendants are excluded");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "update-recovery-check-"));
  try {
    const helper = require("./update-helper.cjs"), jobFile = path.join(root, "handoff.json");
    const job = { id: "handoff", targetVersion: "1.1.79", parentPid: process.pid };
    await fs.writeFile(jobFile.replace(/\.json$/, ".ready.json"), JSON.stringify({ pid: process.pid }));
    await assert.rejects(helper.waitForAuthorization(jobFile, job, 0), /not_committed/, "A late ready helper cannot install when the parent timed out");
    helper.authorizeUpdateJob(jobFile, job);
    await helper.waitForAuthorization(jobFile, job, 0);
    helper.revokeUpdateJob(jobFile);
    await assert.rejects(helper.waitForAuthorization(jobFile, job, 0), /cancelled/, "Revocation wins over an existing commit");
    assert.throws(() => helper.authorizeUpdateJob(jobFile, job), /not_ready/);
    const installed = path.join(root, "app"), data = path.join(root, "customer-data");
    await fs.mkdir(installed); await fs.mkdir(data);
    await fs.writeFile(path.join(installed, "app.exe"), "old");
    await fs.writeFile(path.join(data, "task.json"), "new business record");
    const backup = await backupProgram(installed, path.join(root, "backups"), "fixture", { active: "previous" });
    await fs.writeFile(path.join(installed, "app.exe"), "broken");
    const failed = await restoreProgram(backup);
    assert.equal(await fs.readFile(path.join(installed, "app.exe"), "utf8"), "old");
    assert.equal(await fs.readFile(path.join(failed, "app.exe"), "utf8"), "broken");
    assert.equal(await fs.readFile(path.join(data, "task.json"), "utf8"), "new business record");
    await fs.writeFile(path.join(backup.program, "app.exe"), "tampered");
    await assert.rejects(restoreProgram(backup), /verification_failed/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
  console.log("update-coordinator and program recovery self-check passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
