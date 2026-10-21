const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), vm = require("node:vm");
const contract = require("../shared/launcher-contract.cjs");
const pathsApi = require("./component-paths.cjs");
assert.equal(typeof pathsApi.recordVerification, "function", "prepare must publish a first-boot receipt");
const source = fs.readFileSync(path.join(__dirname, "bootstrap.cjs"), "utf8");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "stable-bootstrap-check-"));
const keys = crypto.generateKeyPairSync("ed25519");
const config = { appId: "fixture.launcher", channel: "test", signingPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }) };
const locations = {
  application: "resources/app/src/main/main.cjs", updater: "resources/app/src/main/updater-bootstrap.cjs",
  assets: "resources/app/dist/assets/example.png", "content-engine": "resources/content-engine/worker.exe",
  "product-detail": "resources/product-detail/worker.exe", video: "resources/content-engine/remotion-render-worker.mjs"
};
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
function json(file, value) { write(file, JSON.stringify(value)); }
function setup(name) {
  const root = path.join(fixture, name), installed = path.join(root, "installed");
  const profile = path.join(root, "xiaoxi-active-touch-test"), paths = pathsApi.updatePaths(profile);
  const baseFile = { path: "fixed-runtime.bin", size: 4, sha256: contract.digest("base"), component: "base" };
  const base = { version: "1.1.105", fingerprint: contract.treeHash([baseFile]) };
  const baseline = { schema: 2, updateProtocol: 5, dataSchema: 2, base, files: [baseFile] };
  write(path.join(installed, baseFile.path), "base");
  write(path.join(installed, locations.updater), "module.exports={start(){}}");
  baseline.files.push({ path: locations.updater, component: "updater", size: 26, sha256: contract.digest("installed") });
  json(path.join(installed, "component-base.json"), baseline);
  json(path.join(installed, "resources/app/dist/build-edition.json"), { edition: "development" });
  json(path.join(installed, "resources/app/src/shared/launcher-trust.json"), config);
  return { root, installed, profile, paths, base, baseFile, baseline };
}
function candidate(test, version, { receipt = true } = {}) {
  const files = [test.baseFile], components = {};
  for (const name of contract.COMPONENTS) {
    const text = name + ":" + version, file = { path: locations[name], size: Buffer.byteLength(text), sha256: contract.digest(text), component: name };
    files.push(file);
    const hash = contract.digest(name);
    components[name] = { name, sha256: hash, size: 1, treeSha256: contract.treeHash([file]),
      file: "/components/" + hash + ".zip", expandedSize: file.size, fileCount: 1 };
  }
  const manifest = { schema: 2, updateProtocol: 5, appId: config.appId, channel: config.channel, platform: "win32", arch: "x64",
    version, base: test.base, minBaseVersion: test.base.version, dataSchema: 2, sequence: Number(version.split(".")[2]), notes: "", components };
  const payload = JSON.stringify(manifest), id = contract.digest(payload);
  const envelope = { payload, signature: crypto.sign(null, Buffer.from(payload), keys.privateKey).toString("base64") };
  const root = path.join(test.paths.generations, id);
  for (const file of files) write(path.join(root, file.path), file.component === "base" ? "base" : file.component + ":" + version);
  json(path.join(root, "component-base.json"), { schema: 2, updateProtocol: 5, dataSchema: 2, base: test.base, files });
  json(path.join(root, "component-complete.json"), envelope);
  if (receipt) pathsApi.recordVerification(test.paths, pathsApi.bootVerificationReceipt(test.paths, root), "prepared");
  return { root, id, manifest, envelope };
}
async function launch(test, { version = "1.1.105", args = [], fail = false, helper = false, packaged = true } = {}) {
  const events = [], notices = [], reads = [], imports = [];
  let finish, locked = 0, relaunched;
  const done = new Promise(resolve => { finish = resolve; });
  const context = {};
  const app = { isPackaged: packaged, getPath: () => test.root, setPath(key, value) { assert.equal(value, test.profile); },
    getVersion: () => version, requestSingleInstanceLock() { locked++; return true; },
    quit() { finish({ quit: true }); }, exit(code) { finish({ exit: code }); },
    relaunch(options) { relaunched = options; } };
  const physicalFs = new Proxy(fs, { get(target, key) {
    if (key === "readFileSync") return (file, ...rest) => {
      reads.push(file); assert.ok(String(file).endsWith(".json"), "bootstrap may only read JSON, never file payloads");
      if (helper && String(file).endsWith("selection.json")) throw Error("helper must not select active generation");
      return target.readFileSync(file, ...rest);
    };
    if (key === "createReadStream") return () => { throw Error("startup must not hash payloads"); };
    return target[key];
  } });
  vm.runInNewContext(source, {
    __dirname: path.join(test.installed, "resources/app/src/main"), global: context,
    process: { argv: [path.join(test.installed, "app.exe"), ...args], env: {}, execPath: path.join(test.installed, "app.exe"),
      kill() { throw Object.assign(Error("gone"), { code: "ESRCH" }); } },
    console, require(id) {
      imports.push(id);
      if (id === "electron") return { app, dialog: { showErrorBox(title, message) { notices.push({ title, message }); } },
        protocol: { registerSchemesAsPrivileged() { events.push("scheme"); } } };
      if (id === "node:path") return path;
      if (id === "node:fs") return physicalFs;
      if (id === "./atomic-file.cjs") return require(id);
      if (id === "../shared/launcher-contract.cjs") return contract;
      if (id === "./content-media-scheme.cjs") return { registerContentMediaScheme: protocol => protocol.registerSchemesAsPrivileged([]) };
      if (id === "./startup-timing.cjs") return { createStartupTiming: () => ({ mark(stage) { events.push(stage); } }) };
      if (id.endsWith("updater-bootstrap.cjs")) return { async start(bootContext) {
        events.push("updater"); assert.ok(events.includes("scheme"));
        if (fail) throw Error("fixture updater loading failure");
        finish({ loaded: bootContext });
      } };
      throw Error("stable launcher loaded mutable dependency " + id);
    }
  });
  const result = await done;
  return { ...result, events, notices, reads, imports, locked, relaunched, context };
}
async function main() {
  const healthy = setup("prepared");
  const target = candidate(healthy, "1.1.107");
  json(healthy.paths.selection, { active: target.id, previous: null, pending: { attempted: false, jobId: "fixture" } });
  const first = await launch(healthy);
  assert.equal(first.loaded.root, target.root);
  assert.equal(first.loaded.receipt.hit, true, "prepared receipt is enough on first boot");
  assert.ok(first.events.includes("component_verification_cache_hit"));
  assert.equal(first.imports.includes("./component-paths.cjs"), false, "trust checks cannot import mutable paths");
  assert.equal(JSON.parse(fs.readFileSync(healthy.paths.selection)).pending.attempted, true);

  // Preparation may reuse another generation; its complete baseline and failure
  // text must not change the target receipt's stable identity.
  const before = pathsApi.bootVerificationReceipt(healthy.paths, target.root);
  const foreign = setup("foreign-base");
  assert.equal(pathsApi.bootVerificationReceipt(healthy.paths, target.root, foreign.installed, "changed reason").identity, before.identity);
  global.__xiaoxiComponents = { paths: healthy.paths, root: target.root, id: target.id, version: "1.1.107", receipt: before, healthy: false };
  pathsApi.markHealthy();
  assert.equal(pathsApi.bootVerificationReceipt(healthy.paths, target.root).phase, "healthy");
  assert.equal(fs.existsSync(path.join(healthy.paths.directory, "boot-attempt.json")), false);
  const ordinary = await launch(healthy);
  assert.equal(ordinary.loaded.root, target.root);
  global.__xiaoxiComponents = { ...ordinary.loaded, healthy: false };
  pathsApi.markHealthy();

  for (const failure of ["signature", "receipt", "missing-entry", "unfinished"]) {
    const test = setup(failure), previous = candidate(test, "1.1.106"), current = candidate(test, "1.1.107", { receipt: failure !== "receipt" });
    json(test.paths.selection, { active: current.id, previous: previous.id, pending: { attempted: failure === "unfinished" } });
    if (failure === "signature") json(path.join(current.root, "component-complete.json"), { ...current.envelope, signature: "invalid" });
    if (failure === "missing-entry") fs.rmSync(path.join(current.root, locations.updater));
    const observed = await launch(test);
    assert.equal(observed.loaded.root, previous.root, failure + " must recover the previous generation");
    assert.equal(observed.events.filter(event => event === "updater").length, 1);
    assert.ok(observed.notices.some(item => item.title === "已恢复上一版本"));
  }

  const throwing = setup("throwing"), previous = candidate(throwing, "1.1.106"), current = candidate(throwing, "1.1.107");
  json(throwing.paths.selection, { active: current.id, previous: previous.id, pending: { attempted: false } });
  const failed = await launch(throwing, { fail: true, args: ["--xiaoxi-updated-launch", "job-fixture"] });
  assert.equal(failed.exit, 1);
  assert.ok(failed.relaunched.args.includes("--xiaoxi-launcher-fallback=1"));
  assert.ok(failed.relaunched.args.includes("--xiaoxi-updated-launch"));
  assert.ok(failed.relaunched.args.includes("job-fixture"));
  assert.equal(failed.events.filter(event => event === "updater").length, 1, "no fallback updater in the contaminated process");
  assert.equal(JSON.parse(fs.readFileSync(throwing.paths.selection)).active, previous.id);
  assert.equal(fs.existsSync(path.join(throwing.paths.directory, "boot-attempt.json")), false, "clean relaunch must not skip the restored previous generation");
  const restored = await launch(throwing, { args: failed.relaunched.args });
  assert.equal(restored.loaded.root, previous.root);

  const installed = setup("installer"), old = candidate(installed, "1.1.107");
  json(installed.paths.selection, { active: old.id, pending: { attempted: false } });
  const same = await launch(installed, { version: "1.1.107" });
  assert.equal(same.loaded.root, installed.installed, "same-version complete installer supersedes component selection");
  assert.equal(JSON.parse(fs.readFileSync(installed.paths.selection)).active, null);

  const helper = setup("helper");
  json(helper.paths.selection, { active: "invalid-local-selection" });
  const job = await launch(helper, { helper: true, args: ["--xiaoxi-update-job", "job-fixture"] });
  assert.equal(job.loaded.mode, "helper"); assert.equal(job.loaded.jobFile, "job-fixture"); assert.equal(job.locked, 0);
  assert.equal(fs.existsSync(path.join(helper.paths.directory, "boot-attempt.json")), false);
  const helperFailure = await launch(helper, { helper: true, fail: true, args: ["--xiaoxi-update-job", "job-fixture"] });
  assert.equal(helperFailure.exit, 1); assert.equal(helperFailure.relaunched, undefined, "helper errors cannot relaunch or alter normal selection");
  assert.equal(JSON.parse(fs.readFileSync(helper.paths.selection)).active, "invalid-local-selection");

  const invalidCache = setup("invalid-cache");
  json(path.join(invalidCache.paths.directory, "verification-cache.json"), { schema: 2, records: {} });
  assert.equal((await launch(invalidCache)).loaded.root, invalidCache.installed, "malformed optional receipt cache cannot break the installed fallback");

  const missing = setup("missing-baseline");
  fs.rmSync(path.join(missing.installed, "component-base.json"));
  const rejected = await launch(missing);
  assert.equal(rejected.exit, 1);
  assert.ok(rejected.notices.some(item => item.message.includes("component_base_verification_required")));

  const stop = setup("bounded"), broken = candidate(stop, "1.1.107");
  json(stop.paths.selection, { active: broken.id, pending: null });
  const exhausted = await launch(stop, { fail: true, args: ["--xiaoxi-launcher-fallback=2"] });
  assert.equal(exhausted.exit, 1); assert.equal(exhausted.relaunched, undefined);

  const runtime = setup("runtime-failure"), runtimePrevious = candidate(runtime, "1.1.106"), runtimeCurrent = candidate(runtime, "1.1.107");
  json(runtime.paths.selection, { active: runtimeCurrent.id, previous: runtimePrevious.id, pending: null });
  global.__xiaoxiComponents = { paths: runtime.paths, root: runtimeCurrent.root, id: runtimeCurrent.id, healthy: true };
  pathsApi.runtimeLaunchFailed(path.join(runtimeCurrent.root, "resources/content-engine/worker.exe"), { code: "ENOENT" });
  assert.equal(global.__xiaoxiComponents.verificationFailed, true);
  assert.equal((await launch(runtime)).loaded.root, runtimePrevious.root, "runtime launch failure requests rollback instead of content rehashing");

  const entryContext = {}, entryModule = { exports: {} }, entryCalls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "updater-bootstrap.cjs"), "utf8"), {
    global: entryContext, module: entryModule, require(id) {
      if (id === "node:path") return path;
      if (id === "./component-paths.cjs") return { createRuntimeVerification: pathsApi.createRuntimeVerification };
      if (id === "./main.cjs") { entryCalls.push("main"); return; }
      if (id === "./update-helper.cjs") return { async runHelper(job) { entryCalls.push(job); } };
      throw Error("unexpected updater import " + id);
    }
  });
  assert.equal(entryCalls.length, 0, "updater import has no startup side effects");
  await entryModule.exports.start(first.loaded);
  assert.equal(entryContext.__xiaoxiComponents.root, target.root);
  assert.equal(entryContext.__xiaoxiComponents.healthy, false);
  await entryModule.exports.start({ mode: "helper", jobFile: "job-fixture", userData: helper.profile });
  assert.equal(entryCalls[0], "main"); assert.equal(entryCalls[1].jobFile, "job-fixture");

  const metadata = await pathsApi.verifySelected(target.root, healthy.installed, config, { structure: false });
  assert.equal(metadata.version, target.manifest.version);
  const originals = fs.readFileSync(path.join(target.root, "component-base.json"));
  fs.appendFileSync(path.join(target.root, "component-base.json"), " ");
  assert.equal(pathsApi.bootVerificationReceipt(healthy.paths, target.root).hit, false, "manifest mutation invalidates receipt");
  fs.writeFileSync(path.join(target.root, "component-base.json"), originals);
  console.log("bootstrap self-check passed: signed prepare receipt, JSON-only startup, helper isolation, installer precedence and clean-process failure fallback");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  delete global.__xiaoxiComponents;
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
});
