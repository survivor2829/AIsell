const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { registerContentMediaScheme } = require("./content-media-protocol.cjs");

async function check() {
  let ready = false, registrations = 0;
  let finish;
  const result = new Promise(resolve => { finish = resolve; });
  const protocol = { registerSchemesAsPrivileged(schemes) {
    if (ready) throw Error("protocol registration after app ready");
    assert.equal(schemes[0].scheme, "xiaoxi-content");
    registrations++;
  } };
  const app = { isPackaged: true, getPath: () => __dirname, setPath() {},
    requestSingleInstanceLock: () => true, getVersion: () => "1.1.2",
    quit: () => finish({ error: "unexpected quit" }), exit() {} };
  const roots = { directory: __dirname, selection: "selection" };
  const paths = {
    readJson: (file, fallback) => file === "selection" ? { active: "candidate" } : fallback,
    updatePaths: () => roots, generationPath: () => __dirname,
    verifySelected: async () => {
      await new Promise(resolve => setImmediate(resolve));
      ready = true;
      return { version: "1.1.3" };
    }, saveSelection() {}, rollbackSelection() { throw Error("unexpected rollback"); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "bootstrap.cjs"), "utf8"), {
    __dirname, global: {}, process: { argv: [], env: {}, execPath: process.execPath },
    require(id) {
      if (id === "electron") return { app, protocol, dialog: { showErrorBox: (_, message) => finish({ error: message }) } };
      if (id === "node:path") return path;
      if (id === "node:fs") return { existsSync: () => true };
      if (id === "./component-paths.cjs") return paths;
      if (id === "./cloud-config.cjs") return { cloudConfig: () => ({}) };
      if (id === "./content-media-scheme.cjs") return require(id);
      if (id.endsWith(path.join("src", "main", "main.cjs"))) {
        registerContentMediaScheme(protocol);
        finish({ version: "1.1.3", ready });
        return;
      }
      throw Error("Unexpected import " + id);
    }
  });
  assert.deepEqual(await result, { version: "1.1.3", ready: true },
    "An async component verification must not defer privileged protocol registration until app ready");
  assert.equal(registrations, 1, "The loaded application must reuse the bootstrap registration");
  console.log("bootstrap self-check passed: async component verification preserves early media protocol registration");
}
check().catch(error => { console.error(error); process.exitCode = 1; });
