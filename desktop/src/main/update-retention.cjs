const fs = process.versions.electron ? require("original-fs") : require("node:fs");
const path = require("node:path");
const { Worker, isMainThread, workerData, parentPort } = require("node:worker_threads");
const { digest, componentsFor, HEX } = require("../shared/component-contract.cjs");
const { retainArtifacts } = require("../shared/artifact-retention.cjs");

function generationRefs(root, id, envelope) {
  if (!HEX.test(id)) throw Error("component_retention_identity_invalid");
  const generation = path.join(root, "generations", id);
  envelope ||= JSON.parse(fs.readFileSync(path.join(generation, "component-complete.json"), "utf8"));
  if (digest(envelope.payload) !== id) throw Error("component_retention_identity_invalid");
  const manifest = JSON.parse(envelope.payload);
  const archives = componentsFor(manifest).map(name => {
    const hash = manifest.components?.[name]?.sha256;
    if (!HEX.test(hash)) throw Error("component_retention_identity_invalid");
    const archive = path.join(root, "archives", hash + ".zip");
    const marker = archive + ".verified.json";
    return [archive, archive + ".part", ...(fs.existsSync(marker) ? [marker] : [])];
  });
  return [generation, ...archives.flat()];
}

// Register only artifacts created by this version. Historical directories
// without ownership records are never swept; business data is outside this root.
function collect(root, preparedEnvelope, { created = [], ready = false, staging } = {}) {
  try {
    root = fs.realpathSync(root);
    let selection = {};
    try { selection = JSON.parse(fs.readFileSync(path.join(root, "selection.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const selectedIds = new Set([selection.active, selection.previous].filter(Boolean));
    // A full-upgrade rollback restores its saved selection, so those immutable
    // generations remain referenced even after the live selection is cleared.
    const registryFile = path.join(root, "backup-registry.json");
    if (fs.existsSync(registryFile)) {
      const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
      if (registry.schema !== 1 || !Array.isArray(registry.sets)) throw Error("update_backup_registry_invalid");
      for (const set of registry.sets) {
        for (const id of new Set([set.programBackup?.selection?.active, set.programBackup?.selection?.previous].filter(Boolean))) selectedIds.add(id);
      }
    }
    if (!retainArtifacts(root, "selected-components", [...selectedIds].flatMap(id => generationRefs(root, id)), 1, [])) throw Error("component_retention_deferred");
    if (preparedEnvelope) {
      const refs = generationRefs(root, digest(preparedEnvelope.payload), preparedEnvelope);
      if (staging) refs.push(staging);
      // A failed replacement must leave the last complete candidate installable.
      if (!retainArtifacts(root, ready ? "prepared-components" : "downloading-components", refs, 1, created)) throw Error("component_retention_deferred");
    }
    return { ok: true };
  } catch (error) { console.warn(`Update retention deferred: ${error.message}`); return { ok: false, reason: error.code || error.message }; }
}

async function retainComponentArtifacts(root, envelope, options) {
  // Removing complete runtime trees must not block Electron's main thread.
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: { componentRetention: true, root, envelope, options } });
      let result;
      worker.once("message", value => { result = value; });
      worker.once("error", reject);
      worker.once("exit", code => code === 0 ? resolve(result || { ok: false, reason: "retention_result_missing" }) : reject(Error(`retention_worker_exit_${code}`)));
    });
  } catch (error) { console.warn(`Update retention deferred: ${error.message}`); return { ok: false, reason: error.code || error.message }; }
}

if (!isMainThread && workerData?.componentRetention) parentPort.postMessage(collect(workerData.root, workerData.envelope, workerData.options));

module.exports = { retainComponentArtifacts, generationRefs };
