// Copied into an isolated Electron fixture by update-helper.e2e.cjs. Never a production entry point.
const { app } = require("electron");
const fs = require("original-fs"), path = require("node:path");
const { spawn } = require("node:child_process");
const root = path.resolve(process.env.XIAOXI_UPDATE_E2E_ROOT || "");
if (!root.includes(`${path.sep}.build${path.sep}update-process-tests${path.sep}run-`)
    || fs.readFileSync(path.join(root, "fixture-marker"), "utf8") !== "isolated-update-e2e") throw Error("fixture_root_invalid");
const spec = JSON.parse(fs.readFileSync(path.join(root, "spec.json"), "utf8"));
const save = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
app.setPath("userData", spec.userData);
async function main() {
  const flag = process.argv.indexOf("--xiaoxi-update-job");
  if (flag >= 0) return require("./src/main/update-helper.cjs").runHelper({ jobFile: process.argv[flag + 1], userData: spec.userData });
  await app.whenReady();
  if (process.argv.includes("--xiaoxi-updated-launch")) {
    if (app.getVersion() !== spec.targetVersion) throw Error("fixture_version_not_installed");
    const components = require("./src/main/component-paths.cjs");
    global.__xiaoxiComponents = { paths: components.updatePaths(spec.userData), id: null, version: app.getVersion(), healthy: false };
    components.markHealthy();
    save("boot.json", { version: app.getVersion(), pid: process.pid });
    app.quit(); return;
  }
  const { file, job } = await require("./src/main/update-helper.cjs").createUpdateJob({ userData: spec.userData,
    prepared: spec.prepared, currentVersion: app.getVersion() });
  const helper = spawn(job.helperExecutable, ["--xiaoxi-update-job", file], { detached: true, stdio: "ignore", windowsHide: true });
  await new Promise((resolve, reject) => { helper.once("spawn", resolve); helper.once("error", reject); }); helper.unref();
  save("parent.json", { file, id: job.id, parentPid: process.pid, helperPid: helper.pid });
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(file.replace(/\.json$/, ".ready.json")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (!fs.existsSync(file.replace(/\.json$/, ".ready.json"))) throw Error("fixture_helper_not_ready");
  app.quit();
}
main().catch(error => { save("entry-error.json", { message: error.message, code: error.code }); app.exit(1); });
