const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { registerContentMediaScheme } = require("./content-media-protocol.cjs");

async function check(smoke = false, installedVersion = "1.1.2", selectedVersion = "1.1.3", useInstalled = false, failedBoot = false, missingBaseline = false, cached = false, developmentProfile = false) {
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
  const expectedProfile = smoke || developmentProfile ? smokeProfile : path.join(__dirname, "xiaoxi-active-touch-delivery");
  const context = {}, savedSelections = [];
  const installedRoot = path.dirname(process.execPath);
  const candidateRoot = path.join(__dirname, "candidate");
  const paths = {
    readJson: (file, fallback) => developmentProfile && file.endsWith("build-edition.json") ? { edition: "development" }
      : file === "selection" ? { active: "candidate" }
      : file === path.join(installedRoot, "component-base.json") && !missingBaseline
        ? { schema: 2, verification: {}, files: [{}] } : fallback,
    updatePaths: userData => {
      assert.equal(userData, expectedProfile, "Release verification must select components from its isolated profile");
      return roots;
    }, generationPath: (_paths, id, base) => id ? candidateRoot : base,
    beginBoot: () => failedBoot,
    bootVerificationReceipt: () => ({ hit: cached }),
    createRuntimeVerification: () => ({}),
    verifySelected: async (_root, _installed, _config, options) => {
      assert.equal(options.cached, cached && !failedBoot, "An unfinished boot must not reuse its cached verification");
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
    } : developmentProfile ? { XIAOXI_DEV_PROFILE_DIR: smokeProfile } : {}, execPath: process.execPath },
    require(id) {
      if (id === "electron") return { app, protocol, dialog: { showErrorBox: (_, message) => finish({ error: message }) } };
      if (id === "node:path") return path;
      if (id === "node:fs") return { existsSync: () => true };
      if (id === "./component-paths.cjs") return paths;
      if (id === "./startup-timing.cjs") return require(id);
      if (id === "../shared/cloud-contract.cjs") return require(id);
      if (id === "../shared/component-contract.cjs") return { verifyComponentManifest: () => ({ version: selectedVersion }), validateFiles() {} };
      if (id === "../shared/update-capabilities.json") return { protocol: 4, verification: 1 };
      if (id === "../shared/component-verification.cjs") return { validatePolicy() {}, groupForPath: () => "startup" };
      if (id === "./component-store.cjs") return { verifyFiles: async () => {} };
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
  const observed = await result;
  if (missingBaseline) {
    assert.match(observed.error, /component_base_verification_required/);
    assert.equal(context.__xiaoxiComponents, undefined, "missing baseline must not load the application or acknowledge update success");
    return;
  }
  assert.deepEqual(observed, { version: useInstalled ? installedVersion : selectedVersion,
    root: useInstalled ? installedRoot : candidateRoot, ready: !useInstalled },
    "A full installer must supersede an older selected component while retaining newer component updates");
  assert.equal(savedSelections.length, useInstalled ? 1 : 0);
  if (useInstalled) {
    assert.equal(savedSelections[0].active, null);
    assert.equal(savedSelections[0].pending, null);
  }
  assert.equal(registrations, 1, "The loaded application must reuse the bootstrap registration");
  const stages = [];
  context.__xiaoxiStartupTiming.attach({ event: (_module, stage) => stages.push(stage) });
  assert.deepEqual(stages, ['bootstrap_loaded', 'component_verification_started',
    cached && !failedBoot ? 'component_verification_cache_hit' : 'component_full_verification_completed', 'component_verification_finished']);
}
check().then(() => check(true)).then(() => check(false, "1.1.6", "1.1.5", true))
  .then(() => check(false, "1.1.2", "1.1.3", false, true))
  .then(() => check(false, "1.1.6", "1.1.6", true))
  .then(() => check(false, "1.1.6", "1.1.5", true, false, true))
  .then(() => check(false, "1.1.2", "1.1.3", false, false, false, true))
  .then(() => check(false, "1.1.2", "1.1.3", false, true, false, true))
  .then(() => check(false, "1.1.2", "1.1.3", false, false, false, false, true))
  .then(() => console.log("bootstrap self-check passed: early media registration, isolated profile and full installer precedence"))
  .catch(error => { console.error(error); process.exitCode = 1; });
