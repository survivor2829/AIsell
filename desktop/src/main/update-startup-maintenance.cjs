const { Worker, isMainThread, workerData } = require("node:worker_threads");

// Maintenance runs outside Electron's main thread and shares the update guard.
async function maintainAfterStartup(root, options) {
  await new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { startupMaintenance: true, root, options } });
    worker.once("error", reject);
    worker.once("exit", code => code === 0 ? resolve() : reject(Error(`startup_maintenance_exit_${code}`)));
  });
}

if (!isMainThread && workerData?.startupMaintenance) {
  (async () => {
    let release;
    try {
      release = await require("./update-process-lock.cjs").acquireProcessLock(require("node:path").join(workerData.root, "maintenance.lock"), { timeoutMs: 0 });
      await require("./update-helper.cjs").retainHelperRuntimes(require("./component-paths.cjs").updatePaths(workerData.options.profile));
      try {
        await require("./update-backups.cjs").retryBackupMaintenance(workerData.options.profile, workerData.options);
      } catch (error) { console.warn(`Backup cleanup deferred: ${error.code || error.message}`); }
      // Full-backup confirmation must not gate retrying independently occupied
      // component artifacts. The base worker still owns the deletion policy.
      await require("./update-retention.cjs").retainComponentArtifacts(workerData.root);
    } finally { if (release) await release(); }
  })().catch(error => { console.warn(error.message); process.exitCode = 1; });
}

module.exports = { maintainAfterStartup };
