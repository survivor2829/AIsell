const { app, dialog, protocol } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const trust = require("../shared/launcher-contract.cjs");
const { registerContentMediaScheme } = require("./content-media-scheme.cjs");
const timing = global.__xiaoxiStartupTiming ||= require("./startup-timing.cjs").createStartupTiming();
timing.mark("bootstrap_loaded");
registerContentMediaScheme(protocol);

function readJson(file, fallback = null) {
  try {
    if (fs.statSync(file).size > 20 * 1024 ** 2) throw Error("component_metadata_too_large");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) { if (fallback !== undefined) return fallback; throw error; }
}
function pathsFor(profile) {
  const directory = path.join(profile, "data", "cloud-maintenance", "components");
  return { directory, selection: path.join(directory, "selection.json"), jobs: path.join(directory, "jobs"), generations: path.join(directory, "generations") };
}
function regularPath(root, relative) {
  const pieces = trust.safePath(relative).split("/");
  let current = root;
  for (let index = 0; index <= pieces.length; index++) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < pieces.length ? !stat.isDirectory() : !stat.isFile())) throw Error("component_file_type_invalid");
    if (index < pieces.length) current = path.join(current, pieces[index]);
  }
  return current;
}
function receiptFor(paths, root, baseline, envelope) {
  const stat = fs.lstatSync(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("component_symlink_forbidden");
  const identity = trust.verificationIdentity({ root, directoryId: `${stat.dev}:${stat.ino}`, envelope,
    composedBytes: fs.readFileSync(path.join(root, "component-base.json")), baseline });
  const saved = readJson(path.join(paths.directory, "verification-cache.json"));
  const hit = saved?.schema === 2 && Array.isArray(saved.records) && saved.records.slice(0, 3).some(record => record
    && record.root === path.resolve(root) && record.identity === identity && record.completed === true
    && ["prepared", "healthy"].includes(record.phase));
  return { root: path.resolve(root), identity, hit: Boolean(hit) };
}
function saveSelection(paths, selection) { writeJsonAtomic(paths.selection, selection); return selection; }
function rollback(paths, reason) {
  const selection = readJson(paths.selection, {});
  return saveSelection(paths, { active: selection.previous || null, previous: null, pending: null, failure: reason, lastUpdate: null });
}
function generationPath(paths, id, installedRoot) {
  if (!id) return installedRoot;
  if (!trust.HEX.test(id)) throw Error("component_selection_invalid");
  return path.join(paths.generations, id);
}

async function boot() {
  if (!app.isPackaged) { await require("./updater-bootstrap.cjs").start({ mode: "development" }); return; }
  const marker = readJson(path.join(__dirname, "../../dist/build-edition.json"), {});
  const development = marker.edition === "development";
  const smoke = process.env.XIAOXI_PRODUCT_DETAIL_RELEASE_SMOKE === "1";
  const override = smoke ? process.env.XIAOXI_PRODUCT_DETAIL_RELEASE_SMOKE_DATA_DIR
    : development ? process.env.XIAOXI_DEV_PROFILE_DIR : "";
  if (smoke && !override || override && (!path.isAbsolute(override) || path.resolve(override) === path.parse(override).root)) {
    throw Error(smoke ? "release_smoke_profile_invalid" : "development_profile_invalid");
  }
  const userData = override ? path.resolve(override) : path.join(app.getPath("appData"),
    development ? "xiaoxi-active-touch-test" : "xiaoxi-active-touch-delivery");
  app.setPath("userData", userData);
  const installedRoot = path.dirname(process.execPath), paths = pathsFor(userData);
  const jobFlag = process.argv.indexOf("--xiaoxi-update-job");
  // A helper owns a copied updater, outside the installer's replacement target.
  if (jobFlag >= 0) {
    await require("./updater-bootstrap.cjs").start({ mode: "helper", userData, installedRoot, paths, jobFile: process.argv[jobFlag + 1] });
    return;
  }
  const activeJob = readJson(path.join(paths.directory, "active-job.json"));
  const updatedFlag = process.argv.indexOf("--xiaoxi-updated-launch");
  if (activeJob && (updatedFlag < 0 || process.argv[updatedFlag + 1] !== activeJob.id)) {
    try { process.kill(activeJob.pid, 0); app.quit(); return; } catch { /* Former helper exited. */ }
  }
  if (!smoke && !app.requestSingleInstanceLock()) { app.quit(); return; }
  global.__xiaoxiStableLock = true;
  fs.mkdirSync(paths.directory, { recursive: true });
  const bootFile = path.join(paths.directory, "boot-attempt.json");
  const unfinished = fs.existsSync(bootFile);
  writeJsonAtomic(bootFile, { startedAt: new Date().toISOString() });
  let selection = readJson(paths.selection, {});
  if (selection.pending?.attempted || unfinished && selection.active) selection = rollback(paths, "新版上次未能完成启动，已恢复上一版本。");
  timing.mark("component_verification_started");
  const config = readJson(path.join(__dirname, "../shared/launcher-trust.json"));
  if (!config || typeof config.appId !== "string" || !["test", "production"].includes(config.channel)
      || typeof config.signingPublicKey !== "string") throw Error("launcher_trust_required");
  const installedBaseline = readJson(path.join(installedRoot, "component-base.json"));
  if (!installedBaseline || installedBaseline.schema !== 2 || trust.protocolFor(installedBaseline) !== 5
      || !installedBaseline.files?.length) throw Error("component_base_verification_required");
  trust.validateFiles(installedBaseline.files);
  if (trust.treeHash(installedBaseline.files.filter(file => file.component === "base")) !== installedBaseline.base?.fingerprint) throw Error("component_base_invalid");
  let root = installedRoot, manifest, baseline = installedBaseline, receipt;
  while (selection.active) {
    try {
      root = generationPath(paths, selection.active, installedRoot);
      const envelope = readJson(path.join(root, "component-complete.json"));
      const selected = trust.verifyComponentManifest(envelope, config);
      // A complete installer supersedes the old selection before base checks.
      if (trust.compareVersions(selected.version, app.getVersion()) <= 0) {
        selection = saveSelection(paths, { active: null, previous: null, pending: null, failure: "", lastUpdate: null });
        break;
      }
      baseline = readJson(path.join(root, "component-base.json"));
      manifest = trust.verifyGenerationMetadata({ root, installedBaseline, envelope, composed: baseline, config });
      if (!baseline.files.some(file => file.path === "resources/app/src/main/updater-bootstrap.cjs" && file.component === "updater")) throw Error("component_updater_missing");
      receipt = receiptFor(paths, root, baseline, envelope);
      if (!receipt.hit) throw Error("component_preparation_receipt_required");
      regularPath(root, "resources/app/src/main/updater-bootstrap.cjs");
      break;
    } catch {
      selection = rollback(paths, "更新文件或准备记录不可用，已恢复上一版本。");
      manifest = null; receipt = null;
    }
  }
  if (!manifest) {
    root = installedRoot; baseline = installedBaseline;
    receipt = receiptFor(paths, root, baseline, null);
    regularPath(root, "resources/app/src/main/updater-bootstrap.cjs");
  }
  timing.mark(receipt.hit ? "component_verification_cache_hit" : "component_metadata_verification_completed");
  timing.mark("component_verification_finished");
  if (selection.pending) saveSelection(paths, { ...selection, pending: { ...selection.pending, attempted: true } });
  const context = { mode: "application", userData, paths, root, installedRoot, manifest, receipt, config,
    version: manifest?.version || app.getVersion(), notes: manifest?.notes || selection.pending?.notes || "", id: selection.active || null };
  try {
    if (selection.failure) dialog.showErrorBox("已恢复上一版本", selection.failure);
    await require(path.join(root, "resources/app/src/main/updater-bootstrap.cjs")).start(context);
  } catch (error) {
    // Never reuse handlers or module state left by a partially started updater.
    const flag = process.argv.find(value => /^--xiaoxi-launcher-fallback=[12]$/.test(value));
    const attempt = flag ? Number(flag.split("=")[1]) : 0;
    if (!selection.active || attempt >= 2) throw error;
    rollback(paths, "新版引导未能启动，已恢复上一版本。");
    fs.rmSync(bootFile, { force: true });
    app.relaunch({ args: [...process.argv.slice(1).filter(value => !value.startsWith("--xiaoxi-launcher-fallback=")), `--xiaoxi-launcher-fallback=${attempt + 1}`] });
    app.exit(1);
  }
}
boot().catch(error => {
  if (process.env.XIAOXI_PRODUCT_DETAIL_RELEASE_SMOKE === "1") console.error(error.stack || error.message || error);
  else dialog.showErrorBox("软件未能启动", "更新启动未完成，请保留错误信息并重新打开软件。\n" + String(error.message || error));
  app.exit(1);
});
