const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { digest, COMPONENTS, treeHash, verifyComponentManifest, assertCompatible } = require("../shared/component-contract.cjs");

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
// This is a successful-version receipt, not a claim that mutable files cannot
// change between launches. Updates still verify every file; ordinary launches
// bind the cached result to the manifests and the physical installation root.
function verificationRecords(paths) {
  const saved = readJson(path.join(paths.directory, "verification-cache.json"));
  return saved?.schema === 1 && Array.isArray(saved.records) ? saved.records.filter(item =>
    item && typeof item.root === "string" && /^[a-f0-9]{64}$/.test(item.identity) && item.completed === true).slice(0, 3) : [];
}
function bootVerificationReceipt(paths, root, installedRoot = root, failure = "") {
  const stat = fs.lstatSync(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("component_symlink_forbidden");
  const identity = digest(JSON.stringify({
    schema: 1, root: path.resolve(root), directoryId: `${stat.dev}:${stat.ino}`, failure,
    baseline: digest(fs.readFileSync(path.join(root, "component-base.json"))),
    installedBaseline: digest(fs.readFileSync(path.join(installedRoot, "component-base.json"))),
    selected: root === installedRoot ? null : digest(fs.readFileSync(path.join(root, "component-complete.json")))
  }));
  const record = { root: path.resolve(root), installedRoot: path.resolve(installedRoot), failure, identity };
  return { ...record, hit: verificationRecords(paths).some(item =>
    item.root === record.root && item.identity === identity) };
}
function cacheHealthyVerification(context) {
  if (!context.receipt) return;
  const current = bootVerificationReceipt(context.paths, context.root, context.installedRoot, context.receipt.failure);
  if (current.identity !== context.receipt.identity) throw Error("component_manifest_changed_during_startup");
  const file = path.join(context.paths.directory, "verification-cache.json");
  const records = verificationRecords(context.paths);
  writeJsonAtomic(file, { schema: 1, records: [
    { ...context.receipt, completed: true, verifiedAt: new Date().toISOString() },
    ...records.filter(item => item.root !== context.receipt.root)
  ].slice(0, 3) });
}
function invalidateVerification() {
  const context = global.__xiaoxiComponents;
  if (!context?.paths) return;
  context.verificationFailed = true;
  beginBoot(context.paths);
  const file = path.join(context.paths.directory, "verification-cache.json");
  writeJsonAtomic(file, { schema: 1,
    records: verificationRecords(context.paths).filter(item => item.root !== path.resolve(context.root)) });
}
async function verifySelected(root, installedRoot, config, { startupOnly = false, cached = false } = {}) {
  const baseline = readJson(path.join(installedRoot, "component-base.json"));
  const envelope = readJson(path.join(root, "component-complete.json"));
  const manifest = verifyComponentManifest(envelope, config);
  assertCompatible(manifest, baseline);
  if (path.basename(root) !== digest(envelope.payload)) throw Error("component_selection_invalid");
  const composed = readJson(path.join(root, "component-base.json"));
  assertCompatible(manifest, composed);
  if (composed.files.some(file => !["base", ...COMPONENTS].includes(file.component))) throw Error("component_selection_invalid");
  for (const name of COMPONENTS) {
    if (treeHash(composed.files.filter(file => file.component === name)) !== manifest.components[name].treeSha256) throw Error("component_selection_invalid");
  }
  if (manifest.verification) require("../shared/component-verification.cjs").validatePolicy(manifest.verification, composed.files);
  if (!cached) await require("./component-store.cjs").verifyGeneration(root, composed.files,
    startupOnly && manifest.verification ? "startup" : undefined);
  return manifest;
}
function createRuntimeVerification(root, manifest, fullyVerified = false, installed = false) {
  const composed = readJson(path.join(root, "component-base.json"));
  const policy = manifest?.verification;
  const { GROUPS, groupForPath, validatePolicy } = require("../shared/component-verification.cjs");
  if (policy) validatePolicy(policy, composed.files);
  const completed = new Set(fullyVerified || !policy ? GROUPS : ["startup"]), pending = new Map();
  async function once(key, check) {
    if (completed.has(key)) return;
    if (!pending.has(key)) pending.set(key, Promise.resolve().then(check).then(() => completed.add(key)).catch(error => {
      const context = global.__xiaoxiComponents;
      if (context?.root === root && context.paths) {
        invalidateVerification();
      }
      if (/^component_/.test(error.code || error.message || "")) throw error;
      throw Object.assign(Error("component_runtime_verification_failed"), { code: "component_runtime_verification_failed", cause: error });
    }).finally(() => pending.delete(key)));
    await pending.get(key);
  }
  return {
    ensure(group) {
      if (!GROUPS.includes(group) || group === "media") throw Error("component_verification_group_invalid");
      return once(group, () => installed
        ? require("./component-store.cjs").verifyFiles(root, composed.files.filter(file => groupForPath(file.path) === group))
        : require("./component-store.cjs").verifyGeneration(root, composed.files, group));
    },
    async media(file) {
      if (!policy) return;
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (groupForPath(relative) !== "media") return;
      if (completed.has("media")) return;
      const entry = composed.files.find(item => item.path === relative);
      await once("media:" + relative, () => {
        if (!entry) throw Error("component_media_unknown");
        return require("./component-store.cjs").verifyFiles(root, [entry]);
      });
    }
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
  // A failed cache write must not make the usable app fail; the next launch
  // simply repeats verification instead of claiming an unrecorded cache hit.
  try { cacheHealthyVerification(context); } catch (error) { console.warn(`Verification receipt unavailable: ${error.message}`); }
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
  bootVerificationReceipt, invalidateVerification, runtimeLaunchFailed };
