const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { HEX, verificationIdentity, verifyGenerationMetadata } = require("../shared/launcher-contract.cjs");

function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function updatePaths(userData) {
  const directory = path.join(userData, "data", "cloud-maintenance", "components");
  return { directory, selection: path.join(directory, "selection.json"), jobs: path.join(directory, "jobs"), generations: path.join(directory, "generations") };
}
function generationPath(paths, id, installedRoot) {
  if (!id) return installedRoot;
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error("component_selection_invalid");
  return path.join(paths.generations, id);
}
function beginBoot(paths) {
  const file = path.join(paths.directory, "boot-attempt.json");
  const unfinished = fs.existsSync(file);
  fs.mkdirSync(paths.directory, { recursive: true });
  writeJsonAtomic(file, { startedAt: new Date().toISOString() });
  return unfinished;
}
function verificationRecords(paths) {
  const saved = readJson(path.join(paths.directory, "verification-cache.json"));
  return saved?.schema === 2 && Array.isArray(saved.records) ? saved.records.filter(item =>
    item && typeof item.root === "string" && HEX.test(item.identity) && item.completed === true
      && ["prepared", "healthy"].includes(item.phase)).slice(0, 3) : [];
}
function bootVerificationReceipt(paths, root) {
  const stat = fs.lstatSync(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("component_symlink_forbidden");
  const composedBytes = fs.readFileSync(path.join(root, "component-base.json"));
  const baseline = JSON.parse(composedBytes);
  const envelope = readJson(path.join(root, "component-complete.json"));
  const identity = verificationIdentity({ root, directoryId: `${stat.dev}:${stat.ino}`, envelope, composedBytes, baseline });
  const record = verificationRecords(paths).find(item => item.root === path.resolve(root) && item.identity === identity);
  return { root: path.resolve(root), identity, hit: Boolean(record), phase: record?.phase };
}
function recordVerification(paths, receipt, phase) {
  if (!["prepared", "healthy"].includes(phase) || !path.isAbsolute(receipt?.root || "") || !HEX.test(receipt.identity)) throw Error("component_receipt_invalid");
  const current = bootVerificationReceipt(paths, receipt.root);
  if (current.identity !== receipt.identity) throw Error("component_manifest_changed_during_startup");
  writeJsonAtomic(path.join(paths.directory, "verification-cache.json"), { schema: 2, records: [
    { root: receipt.root, identity: receipt.identity, completed: true, phase, verifiedAt: new Date().toISOString() },
    ...verificationRecords(paths).filter(item => item.root !== receipt.root)
  ].slice(0, 3) });
}
function invalidateVerification() {
  const context = global.__xiaoxiComponents;
  if (!context?.paths) return;
  context.verificationFailed = true;
  beginBoot(context.paths);
  const file = path.join(context.paths.directory, "verification-cache.json");
  writeJsonAtomic(file, { schema: 2,
    records: verificationRecords(context.paths).filter(item => item.root !== path.resolve(context.root)) });
}
async function verifySelected(root, installedRoot, config, { structure = true, requireReceipt = true } = {}) {
  const baseline = readJson(path.join(installedRoot, "component-base.json"));
  const envelope = readJson(path.join(root, "component-complete.json"));
  const composed = readJson(path.join(root, "component-base.json"));
  const manifest = verifyGenerationMetadata({ root, installedBaseline: baseline, envelope, composed, config });
  if (manifest.verification) require("../shared/component-verification.cjs").validatePolicy(manifest.verification, composed.files);
  if (requireReceipt && !bootVerificationReceipt(updatePathsFromRoot(root), root).hit) throw Error("component_preparation_receipt_required");
  if (structure) await require("./component-store.cjs").verifyStructure(root, composed.files);
  return manifest;
}
function updatePathsFromRoot(root) { return { directory: path.dirname(path.dirname(root)) }; }
function createRuntimeVerification() {
  // Calls remain compatible with business launch sites. Download/prepare and
  // switching own validation; runtime errors request rollback, never lazy hashing.
  const { GROUPS } = require("../shared/component-verification.cjs");
  return {
    async ensure(group) {
      if (!GROUPS.includes(group) || group === "media") throw Error("component_verification_group_invalid");
    }, async media() {}
  };
}
async function ensureRuntimeGroup(group) { await global.__xiaoxiComponents?.verification?.ensure(group); }
function runtimeLaunchFailed(binary, error) {
  const root = global.__xiaoxiComponents?.root;
  if (!root || !path.isAbsolute(binary) || !["ENOENT", "EACCES", "EPERM", "ENOEXEC", "UNKNOWN"].includes(error?.code)) return;
  const relative = path.relative(root, binary);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
  try { invalidateVerification(); } catch { /* Keep the original actionable process error. */ }
}
function saveSelection(paths, selection) {
  fs.mkdirSync(paths.directory, { recursive: true });
  writeJsonAtomic(paths.selection, selection);
  return selection;
}
function rollbackSelection(paths, reason) {
  const current = readJson(paths.selection, {});
  const previous = current.previous || null;
  return saveSelection(paths, { active: previous, previous: null, pending: null, failure: reason, lastUpdate: null });
}
function applicationPath(appRuntime) { return global.__xiaoxiComponents?.applicationRoot || appRuntime.getAppPath(); }
function resourcesPath(fallback = process.resourcesPath) { return global.__xiaoxiComponents?.resourcesRoot || fallback; }
function businessVersion(appRuntime) { return global.__xiaoxiComponents?.version || appRuntime.getVersion(); }
function currentRoot(fallback = path.dirname(process.execPath)) { return global.__xiaoxiComponents?.root || fallback; }
function markHealthy() {
  const context = global.__xiaoxiComponents;
  if (!context || context.healthy || context.verificationFailed) return;
  try { if (context.receipt) recordVerification(context.paths, context.receipt, "healthy"); }
  catch (error) {
    if (error.message === "component_manifest_changed_during_startup") { context.verificationFailed = true; return; }
    console.warn(`Verification receipt unavailable: ${error.message}`);
  }
  fs.rmSync(path.join(context.paths.directory, "boot-attempt.json"), { force: true });
  context.healthy = true;
  const selection = readJson(context.paths.selection, {});
  if (!selection.pending || selection.active !== context.id) return;
  const complete = { version: context.version, notes: context.notes || "", completedAt: new Date().toISOString(), unread: true };
  saveSelection(context.paths, { ...selection, pending: null, failure: "", lastUpdate: complete });
  if (selection.pending.jobId && /^[a-f0-9-]{36}$/.test(selection.pending.jobId)) {
    writeJsonAtomic(path.join(context.paths.jobs, selection.pending.jobId + ".ack.json"), { ok: true, version: context.version });
  }
}
module.exports = { readJson, updatePaths, generationPath, verifySelected, saveSelection, rollbackSelection,
  applicationPath, resourcesPath, businessVersion, currentRoot, markHealthy, createRuntimeVerification, ensureRuntimeGroup, beginBoot,
  bootVerificationReceipt, recordVerification, invalidateVerification, runtimeLaunchFailed };
