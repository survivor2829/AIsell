const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { registerContentMediaScheme } = require("./content-media-protocol.cjs");

async function check(smoke = false, installedVersion = "1.1.2", selectedVersion = "1.1.3", useInstalled = false) {
  let ready = false, registrations = 0;
  let finish;
  const result = new Promise(resolve => { finish = resolve; });
  const protocol = { registerSchemesAsPrivileged(schemes) {
    if (ready) throw Error("protocol registration after app ready");
    assert.equal(schemes[0].scheme, "xiaoxi-content");
    registrations++;
  } };
  const app = { isPackaged: true, getPath: () => __dirname, setPath() {},
    requestSingleInstanceLock: () => true, getVersion: () => installedVersion,
    quit: () => finish({ error: "unexpected quit" }), exit() {} };
  const roots = { directory: __dirname, selection: "selection" };
  const smokeProfile = path.join(__dirname, "isolated-release-profile");
  const expectedProfile = smoke ? smokeProfile : path.join(__dirname, "xiaoxi-active-touch-delivery");
  const context = {}, savedSelections = [];
  const installedRoot = path.dirname(process.execPath);
  const candidateRoot = path.join(__dirname, "candidate");
  const paths = {
    readJson: (file, fallback) => file === "selection" ? { active: "candidate" } : fallback,
    updatePaths: userData => {
      assert.equal(userData, expectedProfile, "Release verification must select components from its isolated profile");
      return roots;
    }, generationPath: (_paths, id, base) => id ? candidateRoot : base,
    verifySelected: async () => {
      assert.equal(useInstalled, false, "Superseded components must not fail the new install's base compatibility check");
      await new Promise(resolve => setImmediate(resolve));
      ready = true;
      return { version: selectedVersion };
    }, saveSelection: (_paths, selection) => { savedSelections.push(selection); return selection; },
    rollbackSelection() { throw Error("unexpected rollback"); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "bootstrap.cjs"), "utf8"), {
    __dirname, global: context, process: { argv: [], env: smoke ? {
      XIAOXI_PRODUCT_DETAIL_RELEASE_SMOKE: "1", XIAOXI_PRODUCT_DETAIL_RELEASE_SMOKE_DATA_DIR: smokeProfile
    } : {}, execPath: process.execPath },
    require(id) {
      if (id === "electron") return { app, protocol, dialog: { showErrorBox: (_, message) => finish({ error: message }) } };
      if (id === "node:path") return path;
      if (id === "node:fs") return { existsSync: () => true };
      if (id === "./component-paths.cjs") return paths;
      if (id === "../shared/cloud-contract.cjs") return require(id);
      if (id === "../shared/component-contract.cjs") return { verifyComponentManifest: () => ({ version: selectedVersion }) };
      if (id === "./cloud-config.cjs") return { cloudConfig: () => ({}) };
      if (id === "./content-media-scheme.cjs") return require(id);
      if (id.endsWith(path.join("src", "main", "main.cjs"))) {
        registerContentMediaScheme(protocol);
        finish({ version: context.__xiaoxiComponents.version, root: context.__xiaoxiComponents.root, ready });
        return;
      }
      throw Error("Unexpected import " + id);
    }
  });
  assert.deepEqual(await result, { version: useInstalled ? installedVersion : selectedVersion,
    root: useInstalled ? installedRoot : candidateRoot, ready: !useInstalled },
    "A full installer must supersede an older selected component while retaining newer component updates");
  assert.equal(savedSelections.length, useInstalled ? 1 : 0);
  if (useInstalled) {
    assert.equal(savedSelections[0].active, null);
    assert.equal(savedSelections[0].pending, null);
  }
  assert.equal(registrations, 1, "The loaded application must reuse the bootstrap registration");
}
check().then(() => check(true)).then(() => check(false, "1.1.6", "1.1.5", true))
  .then(() => check(false, "1.1.6", "1.1.6", true))
  .then(() => console.log("bootstrap self-check passed: early media registration, isolated profile and full installer precedence"))
  .catch(error => { console.error(error); process.exitCode = 1; });
