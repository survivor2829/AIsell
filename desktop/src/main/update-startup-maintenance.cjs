const { Worker, isMainThread, workerData } = require("node:worker_threads");

// Application-owned orchestration can ship incrementally. Keep the accepted
// base's updater and component-retention worker unchanged.
async function maintainAfterStartup(root, options) {
  await new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { startupMaintenance: true, root, options } });
    worker.once("error", reject);
    worker.once("exit", code => code === 0 ? resolve() : reject(Error(`startup_maintenance_exit_${code}`)));
  });
}

if (!isMainThread && workerData?.startupMaintenance) {
  (async () => {
    try {
      await require("./update-backups.cjs").retryBackupMaintenance(workerData.options.profile, workerData.options);
    } catch (error) { console.warn(`Backup cleanup deferred: ${error.code || error.message}`); }
    // Full-backup confirmation must not gate retrying independently occupied
    // component artifacts. The base worker still owns the deletion policy.
    await require("./update-retention.cjs").retainComponentArtifacts(workerData.root);
  })().catch(error => { console.warn(error.message); process.exitCode = 1; });
}

module.exports = { maintainAfterStartup };
