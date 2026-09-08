const { app, dialog, protocol } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { readJson, updatePaths, generationPath, verifySelected, saveSelection, rollbackSelection } = require("./component-paths.cjs");
const { registerContentMediaScheme } = require("./content-media-scheme.cjs");

// Selected component verification yields to Electron's ready event. Privileged
// schemes must be registered synchronously before that verification starts.
registerContentMediaScheme(protocol);

async function boot() {
  if (!app.isPackaged) { require("./main.cjs"); return; }
  const marker = readJson(path.join(__dirname, "../../dist/build-edition.json"), {});
  const development = marker.edition === "development";
  const userData = path.join(app.getPath("appData"), development ? "xiaoxi-active-touch-test" : "xiaoxi-active-touch-delivery");
  app.setPath("userData", userData);
  const jobFlag = process.argv.indexOf("--xiaoxi-update-job");
  if (jobFlag >= 0) {
    await require("./update-helper.cjs").runHelper({ jobFile: process.argv[jobFlag + 1], userData });
    return;
  }
  const paths = updatePaths(userData);
  const activeJob = readJson(path.join(paths.directory, "active-job.json"));
  if (activeJob && process.argv[process.argv.indexOf("--xiaoxi-updated-launch") + 1] !== activeJob.id) {
    try { process.kill(activeJob.pid, 0); app.quit(); return; } catch { /* The former helper exited; normal recovery may continue. */ }
  }
  // Acquire the lock before touching a pending boot attempt. A second launch must
  // never roll back the candidate that the first process is still starting.
  if (!process.env.XIAOXI_PRODUCT_DETAIL_RELEASE_SMOKE && !app.requestSingleInstanceLock()) { app.quit(); return; }
  global.__xiaoxiStableLock = true;
  const installedRoot = path.dirname(process.execPath);
  const config = require("./cloud-config.cjs").cloudConfig({ developmentEdition: development });
  let selection = readJson(paths.selection, {});
  if (selection.pending?.attempted) selection = rollbackSelection(paths, "新版上次未能完成启动，已恢复上一版本。");
  let root = generationPath(paths, selection.active, installedRoot), manifest;
  while (selection.active) {
    try { manifest = await verifySelected(root, installedRoot, config); break; }
    catch {
      selection = rollbackSelection(paths, "更新文件校验失败，已恢复上一版本。");
      root = generationPath(paths, selection.active, installedRoot);
    }
  }
  if (selection.pending) saveSelection(paths, { ...selection, pending: { ...selection.pending, attempted: true } });
  const applicationRoot = path.join(root, "resources", "app");
  const version = manifest?.version || app.getVersion();
  global.__xiaoxiComponents = { root, installedRoot, resourcesRoot: path.join(root, "resources"), applicationRoot,
    version, notes: manifest?.notes || selection.pending?.notes || "", id: selection.active || null, paths, healthy: false };
  if (!fs.existsSync(path.join(applicationRoot, "src/main/main.cjs"))) throw Error("component_application_missing");
  require(path.join(applicationRoot, "src/main/main.cjs"));
}
boot().catch(error => { dialog.showErrorBox("软件未能启动", "更新启动未完成，重新打开后将恢复上一版本。\n" + String(error.message || error)); app.exit(1); });
