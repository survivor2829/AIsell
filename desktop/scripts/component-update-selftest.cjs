const test = require("node:test");
test.after(() => console.log("Component update checks passed."));
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const { buildComponentRelease } = require("./build-component-release.cjs");
const { createComponentStore, verifyFiles } = require("../src/main/component-store.cjs");
const { createTransport } = require("../src/main/cloud-transport.cjs");
const { createCloudMaintenance } = require("../src/main/cloud-maintenance.cjs");
const { createDiagnosticLogger } = require("../src/main/diagnostics.cjs");
const { verifyComponentManifest, treeHash, hashFile, digest } = require("../src/shared/component-contract.cjs");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const config = { appId: "com.aihuoke.desktop.test", channel: "test", signingPublicKey: publicKey };
function sign(manifest) { const payload = JSON.stringify(manifest); return { payload, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString("base64") }; }
async function fixture(t) {
  const parent = path.resolve(__dirname, "../.build/component-tests");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "run-"));
  t.after(async () => {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(parent + path.sep)) throw Error("unsafe_fixture_cleanup");
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const source = path.join(root, "base");
  const initial = {
    "electron.exe": "stable electron",
    "debug.log": "runtime-created Chromium log",
    "resources/app/node_modules/native/index.node": "stable native",
    "resources/app/src/main/main.cjs": "application v1",
    "resources/app/src/main/updater-bootstrap.cjs": "exports.start = () => {};",
    "resources/app/dist/video-examples/sample.mp4": "offline sample",
    "resources/content-engine/content-engine-worker.exe": "python owncode v1",
    "resources/product-detail/product-detail-server.exe": "product owncode v1",
    "resources/content-engine/remotion-bundle/index.js": "remotion owncode v1",
    "版本清单.json": JSON.stringify({ version: "1.1.0", remotionRuntime: {} })
  };
  for (const [relative, content] of Object.entries(initial)) {
    const file = path.join(source, relative);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
  }
  const base = await buildComponentRelease({ sourceRoot: source, outputDir: path.join(root, "base-artifacts"), version: "1.1.0", ...config });
  assert.equal(base.baseline.files.some(file => file.path === "debug.log"), false, "runtime debug logs must not change the accepted application base");
  await fs.writeFile(path.join(source, "component-base.json"), JSON.stringify(base.baseline));
  return { root, source, base };
}

test("delivery baseline-only writer supplies the packaged launcher without creating component archives", async t => {
  const { root, source } = await fixture(t);
  await fs.writeFile(path.join(source, "版本清单.json"), JSON.stringify({ version: "1.1.0", edition: "delivery" }));
  const inventoryFile = path.join(root, "delivery-inventory.json"), output = path.join(root, "delivery-archives");
  await fs.writeFile(inventoryFile, JSON.stringify(require("./release-tree-hash.cjs").hashInventory(source)));
  const result = require("node:child_process").spawnSync(process.execPath,
    [path.join(__dirname, "write-component-baseline.cjs"), source, output, inventoryFile, "--baseline-only"],
    { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(require("node:fs").existsSync(output), false, "delivery baseline-only must not create component archives");
  const baseline = JSON.parse(await fs.readFile(path.join(source, "component-base.json"), "utf8"));
  assert.equal(baseline.updateProtocol, 5);
  assert.equal(baseline.base.fingerprint, treeHash(baseline.files.filter(file => file.component === "base")));
  assert.equal(baseline.components.updater.files.some(file => file.path.endsWith("updater-bootstrap.cjs")), true);
  assert.equal(baseline.components.assets.files.some(file => file.path.endsWith("sample.mp4")), true);
  assert.equal(require("../src/main/cloud-release-config.json").production.enabled, false);
});

test("streamed STORE archives remain readable by the existing updater and unchanged archives are not rehashed", async t => {
  const { root, source } = await fixture(t);
  const next = path.join(root, "streamed-source"), outputDir = path.join(root, "streamed-artifacts");
  await fs.cp(source, next, { recursive: true });
  await fs.writeFile(path.join(next, "版本清单.json"), JSON.stringify({ version: "1.1.1" }));
  await fs.writeFile(path.join(next, "resources/app/dist/video-examples/sample.mp4"), "new compressed media");
  const args = { sourceRoot: next, outputDir, version: "1.1.1", ...config };
  const JSZip = require("jszip");
  const originalGenerate = JSZip.prototype.generateAsync;
  JSZip.prototype.generateAsync = () => assert.fail("component ZIP must stream to disk, never materialize the archive buffer");
  let built;
  try { built = await buildComponentRelease(args); }
  finally { JSZip.prototype.generateAsync = originalGenerate; }
  const assets = built.artifacts.find(item => item.name === "assets");
  const zip = await JSZip.loadAsync(await fs.readFile(assets.path));
  assert.equal(zip.file("files/resources/app/dist/video-examples/sample.mp4")._data.compression.magic, "\0\0",
    "already compressed media must use STORE");
  const rawFs = require("node:fs"), originalRead = rawFs.createReadStream;
  let archiveReads = 0;
  rawFs.createReadStream = function(file, ...rest) {
    if (String(file).startsWith(outputDir + path.sep) && String(file).endsWith(".zip")) archiveReads++;
    return originalRead.call(this, file, ...rest);
  };
  try { await buildComponentRelease(args); }
  finally { rawFs.createReadStream = originalRead; }
  assert.equal(archiveReads, 0, "unchanged archive size/mtime receipts must avoid rereading ZIP bytes");
  const store = createComponentStore({ rootDir: path.join(root, "old-reader-store"), baseRoot: source, config,
    transport: { async request(route, options) {
      const artifact = built.artifacts.find(item => route === `/components/${item.sha256}.zip`);
      assert.ok(artifact); await fs.copyFile(artifact.path, options.destination);
    } } });
  const prepared = await store.prepare(sign(built.manifest));
  assert.equal(await fs.readFile(path.join(prepared.generationRoot, "resources/app/dist/video-examples/sample.mp4"), "utf8"), "new compressed media");
});

test("streaming rejects a source changed after inventory and removes only its temporary archive", async t => {
  const { root, source } = await fixture(t);
  const outputDir = path.join(root, "mutated-artifacts"), rawFs = require("node:fs"), originalRead = rawFs.createReadStream;
  const target = path.join(source, "resources/app/src/main/main.cjs");
  rawFs.createReadStream = function(file, ...rest) {
    if (String(file) === target) {
      const old = rawFs.readFileSync(file); rawFs.writeFileSync(file, Buffer.alloc(old.length, 33));
    }
    return originalRead.call(this, file, ...rest);
  };
  try { await assert.rejects(buildComponentRelease({ sourceRoot: source, outputDir, version: "1.1.0", ...config }), /component_source_changed/); }
  finally { rawFs.createReadStream = originalRead; }
  assert.equal((await fs.readdir(outputDir)).some(name => name.endsWith(".tmp")), false);
});

test("prepared generations reuse immutable bytes and first-start metadata checks never read file contents", async t => {
  const { root, source, base } = await fixture(t);
  const components = require("../src/main/component-paths.cjs"), rawFs = require("node:fs");
  const paths = components.updatePaths(path.join(root, "profile"));
  const originalRead = rawFs.createReadStream;
  let contentReads = 0;
  rawFs.createReadStream = function(file, ...args) {
    if (String(file).startsWith(root + path.sep)) contentReads++;
    return originalRead.call(this, file, ...args);
  };
  let prepared;
  try {
    prepared = await createComponentStore({ rootDir: paths.directory, baseRoot: source, config,
      transport: { request() { assert.fail("unchanged components must not download"); } } }).prepare(sign({ ...base.manifest, version: "1.1.1" }));
    assert.equal(contentReads, 0, "linking a prepared immutable base must not hash its bytes again");
    assert.equal(components.bootVerificationReceipt(paths, prepared.generationRoot).hit, true, "prepare must persist a receipt before announcing ready");
    await components.verifySelected(prepared.generationRoot, source, config);
    const verification = components.createRuntimeVerification(prepared.generationRoot, base.manifest);
    await verification.ensure("content");
    await verification.media(path.join(prepared.generationRoot, "resources/app/dist/video-examples/sample.mp4"));
    assert.equal(contentReads, 0, "first startup and lazy callers must perform zero content hashes");
  } finally { rawFs.createReadStream = originalRead; }
  const second = await createComponentStore({ rootDir: paths.directory, baseRoot: prepared.generationRoot, config,
    transport: { request() { assert.fail("unchanged components must not download"); } } }).prepare(sign({ ...base.manifest, version: "1.1.2" }));
  assert.equal(components.bootVerificationReceipt(paths, second.generationRoot, source).hit, true,
    "a generation reused as the source must not change the receipt identity seen from the installed base");
  const extra = path.join(second.generationRoot, "unexpected.js");
  await fs.writeFile(extra, "unlisted");
  await assert.rejects(components.verifySelected(second.generationRoot, source, config), /generation_invalid/);
  await fs.unlink(extra);
  await fs.appendFile(path.join(second.generationRoot, "component-base.json"), " ");
  assert.equal(components.bootVerificationReceipt(paths, second.generationRoot).hit, false, "changed metadata invalidates preparation");
  await assert.rejects(components.verifySelected(second.generationRoot, source, config), /receipt|verification/);

  const failedPaths = components.updatePaths(path.join(root, "receipt-failure"));
  const failedEnvelope = sign({ ...base.manifest, version: "1.1.3" });
  const retryStore = createComponentStore({ rootDir: failedPaths.directory, baseRoot: source, config,
    transport: { request() { assert.fail("unchanged components must not download"); } } });
  const originalRecord = components.recordVerification;
  components.recordVerification = () => { throw Error("fixture_receipt_locked"); };
  try { await assert.rejects(retryStore.prepare(failedEnvelope), /fixture_receipt_locked/); }
  finally { components.recordVerification = originalRecord; }
  const ledger = JSON.parse(await fs.readFile(path.join(failedPaths.directory, ".artifact-retention.json"), "utf8"));
  assert.ok(Object.values(ledger).some(state => state.owned.includes(path.join("generations", digest(failedEnvelope.payload)))),
    "a failed preparation receipt must leave the renamed generation registered for retry or retirement");
  const recovered = await retryStore.prepare(failedEnvelope);
  assert.equal(components.bootVerificationReceipt(failedPaths, recovered.generationRoot).hit, true);
  const retention = require("../src/shared/artifact-retention.cjs"), originalOwnership = retention.artifactOwnershipRegistered;
  const unregistered = components.updatePaths(path.join(root, "ownership-failure"));
  retention.artifactOwnershipRegistered = () => false;
  try {
    await assert.rejects(createComponentStore({ rootDir: unregistered.directory, baseRoot: source, config,
      transport: { request() { assert.fail("no download"); } } }).prepare(failedEnvelope), /component_ownership_record_required/);
  } finally { retention.artifactOwnershipRegistered = originalOwnership; }
  assert.deepEqual(await fs.readdir(unregistered.generations), [], "failed ownership persistence must not leave a renamed program tree");
});

test("explicit file verification checks shared parents once and rejects changed bytes or symlinks", async t => {
  const { root, source, base } = await fixture(t);
  const originalLstat = fs.lstat, seen = new Map();
  fs.lstat = async function(file, ...args) {
    seen.set(String(file), (seen.get(String(file)) || 0) + 1);
    return originalLstat.call(this, file, ...args);
  };
  try { await verifyFiles(source, base.baseline.files); }
  finally { fs.lstat = originalLstat; }
  assert.equal(Math.max(...seen.values()), 1, "one launch must not repeat parent-directory IO for every file");
  const file = base.baseline.files.find(f => f.path.endsWith('main.cjs'));
  const full = path.join(source, file.path), original = await fs.readFile(full);
  await fs.writeFile(full, Buffer.alloc(original.length, 33));
  await assert.rejects(verifyFiles(source, base.baseline.files), /component_file_corrupt/,
    "same-size changes must be hashed again, never accepted from a previous successful check");
  await fs.writeFile(full, original);
  const link = path.join(root, 'linked-root');
  await fs.symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyFiles(link, base.baseline.files), /component_symlink_forbidden/);
  await fs.unlink(link);
  await fs.rename(path.join(source, 'resources/app/src'), path.join(source, 'resources/app/original-src'));
  await fs.symlink(path.join(source, 'resources/app/original-src'), path.join(source, 'resources/app/src'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyFiles(source, base.baseline.files), /component_symlink_forbidden/);
  await fs.unlink(path.join(source, 'resources/app/src'));
  await fs.rename(path.join(source, 'resources/app/original-src'), path.join(source, 'resources/app/src'));
  await fs.unlink(full);
  await assert.rejects(verifyFiles(source, base.baseline.files), { code: 'ENOENT' });
});

test("verification drains in-flight file checks before reporting a corrupt generation", async t => {
  const { source, base } = await fixture(t);
  const files = base.baseline.files.map(f => ({ ...f, sha256: '0'.repeat(64) }));
  const originalLstat = fs.lstat;
  let pending = 0;
  fs.lstat = async function(...args) {
    pending++;
    try { await new Promise(resolve => setImmediate(resolve)); return await originalLstat.apply(this, args); }
    finally { pending--; }
  };
  try {
    await assert.rejects(verifyFiles(source, files), /component_file_corrupt/);
    assert.equal(pending, 0, "failed verification must settle readers before the updater removes staging files");
  } finally { fs.lstat = originalLstat; }
});

test("superseded prepared updates do not accumulate complete programs and archives", async t => {
  const { root, source, base } = await fixture(t);
  const rootDir = path.join(root, "bounded-store");
  const store = createComponentStore({ rootDir, baseRoot: source, config,
    transport: { request() { assert.fail("unchanged components must not download"); } } });
  const ids = [];
  for (let index = 1; index <= 4; index++) {
    const result = await store.prepare(sign({ ...base.manifest, version: `1.1.${index}`, sequence: index }));
    ids.push(path.basename(result.generationRoot));
    if (index === 1) await fs.writeFile(path.join(rootDir, "selection.json"), JSON.stringify({ active: ids[0], previous: null }));
  }
  const names = await fs.readdir(path.join(rootDir, "generations"));
  assert.deepEqual(names.sort(), [ids[0], ids[3]].sort(), "keep active and latest candidate; superseded uninstalled programs must be retired");
  await fs.writeFile(path.join(rootDir, "selection.json"), JSON.stringify({ active: ids[3], previous: ids[0], pending: null }));
  await require("../src/main/update-retention.cjs").retainComponentArtifacts(rootDir);
  assert.equal((await fs.readdir(path.join(rootDir, "generations"))).length, 2, "activation retains both working generations");
  const interrupted = path.join(rootDir, "generations", ".prepare-owned-interruption");
  await fs.mkdir(interrupted);
  await require("../src/main/update-retention.cjs").retainComponentArtifacts(rootDir,
    sign({ ...base.manifest, version: "1.1.4", sequence: 4 }), { staging: interrupted, created: [interrupted] });
  // A racing helper completion must not clear a newer prepared candidate.
  const next = await store.prepare(sign({ ...base.manifest, version: "1.1.5", sequence: 5 }));
  await assert.rejects(fs.stat(interrupted), { code: "ENOENT" });
  await require("../src/main/update-retention.cjs").retainComponentArtifacts(rootDir);
  assert.equal((await fs.readdir(path.join(rootDir, "generations"))).length, 3);
  await fs.access(next.generationRoot);
  assert.equal(await hashFile(path.join(source, "electron.exe")), base.baseline.files.find(f => f.path === "electron.exe").sha256);
  const inflight = store.prepare(sign({ ...base.manifest, version: "1.1.6", sequence: 6 }));
  const duplicate = createComponentStore({ rootDir, baseRoot: source, config, transport: {} });
  await assert.rejects(duplicate.prepare(sign(base.manifest)), /component_prepare_busy/);
  await inflight;
  const deferred = path.join(rootDir, "deferred-owned"), historical = path.join(rootDir, "unknown-history");
  await fs.mkdir(deferred); await fs.mkdir(historical);
  const physical = require("node:fs"), remove = physical.rmSync;
  physical.rmSync = (file, ...args) => {
    if (file === deferred) throw Object.assign(Error("fixture occupied"), { code: "EBUSY" });
    return remove(file, ...args);
  };
  try { require("../src/shared/artifact-retention.cjs").retainArtifacts(rootDir, "deferred-fixture", [], 1, [deferred]); }
  finally { physical.rmSync = remove; }
  await fs.access(deferred);
  const profile = path.join(root, "idle-profile"); await fs.mkdir(profile);
  const activeJob = path.join(rootDir, "active-job.json"), handoffId = "11111111-2222-4333-8444-555555555555";
  await fs.mkdir(path.join(rootDir, "jobs"), { recursive: true });
  await fs.writeFile(activeJob, JSON.stringify({ id: handoffId }));
  await fs.writeFile(path.join(rootDir, "jobs", handoffId + ".status.json"), JSON.stringify({ phase: "waiting" }));
  await require("../src/main/update-startup-maintenance.cjs").maintainAfterStartup(rootDir, { profile, version: "1.1.4" });
  await fs.access(deferred); // An older helper without the lease still owns its active handoff.
  await fs.unlink(activeJob);
  await require("../src/main/update-startup-maintenance.cjs").maintainAfterStartup(rootDir, { profile, version: "1.1.4" });
  await assert.rejects(fs.stat(deferred), { code: "ENOENT" }, "healthy-start worker retries component cleanup even without a retired full backup");
  await fs.access(historical);
});

test("exit cleanup waits for the executable hardlink lock and retains active and unique files", { skip: process.platform !== "win32" }, async t => {
  const { root, source, base } = await fixture(t);
  const profile = path.join(root, "exit-profile"), rootDir = path.join(profile, "data/cloud-maintenance/components");
  const prepared = await createComponentStore({ rootDir, baseRoot: source, config, transport: {} }).prepare(sign(base.manifest));
  await fs.writeFile(path.join(rootDir, "selection.json"), JSON.stringify({ active: path.basename(prepared.generationRoot), previous: null }));
  const executable = path.join(root, "running-node.exe"), obsolete = path.join(rootDir, "obsolete-owned");
  await fs.copyFile(process.execPath, executable);
  await fs.mkdir(obsolete);
  await fs.link(executable, path.join(obsolete, "node.exe"));
  const cloudRoot = path.dirname(rootDir), download = path.join(cloudRoot, "obsolete-installer.exe");
  await fs.link(executable, download);
  require("../src/shared/artifact-retention.cjs").retainArtifacts(cloudRoot, "exit-download-fixture", [], 1, [download], { deferCleanup: true });
  const unique = path.join(profile, "unique.txt"); await fs.writeFile(unique, "keep");
  let childMessages = "", childErrors = "";
  const child = require("node:child_process").spawn(executable,
    ["-e", `process.stdin.resume();process.stdin.on("end",async()=>{try{const ok=await require(${JSON.stringify(path.resolve(__dirname, "../src/main/update-exit-maintenance.cjs"))}).launchExitMaintenance(${JSON.stringify({ profile, runtimeRoot: prepared.generationRoot, executable })});console.log(ok?"cleanup-ready":"cleanup-not-needed");}catch(e){console.error(e);process.exitCode=1}});console.log("ready")`],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", bytes => { childMessages += bytes; });
  child.stderr.on("data", bytes => { childErrors += bytes; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("locked process did not start")), 10000);
      child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
    });
    // The shipped Electron/Node version has different Windows unlink behavior
    // from the developer's newer Node; reproduce with the shipped runtime.
    const legacy = require("node:child_process").spawnSync(require("electron"), ["-e",
      `require(${JSON.stringify(path.resolve(__dirname, "../src/shared/artifact-retention.cjs"))}).retainArtifacts(${JSON.stringify(rootDir)},"exit-fixture",[],1,[${JSON.stringify(obsolete)}])`],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, encoding: "utf8", timeout: 10000 });
    assert.equal(legacy.status, 0);
    assert.match(legacy.stderr, /EPERM/);
    await fs.access(path.join(obsolete, "node.exe")); // Reproduces Windows EPERM while the shared image runs.
    const { collectAfterExit } = require("../src/main/update-exit-maintenance.cjs");
    const parentCreated = (await require("../src/main/update-helper.cjs").processSnapshot()).find(row => row.pid === child.pid).created;
    const exitOptions = { profile, parentPid: child.pid, parentCreated, runtimeRoot: prepared.generationRoot };
    await collectAfterExit(exitOptions, { timeoutMs: 0, snapshot: async () => [{ pid: child.pid, created: null }] });
    assert.equal(JSON.parse(await fs.readFile(path.join(rootDir, "exit-maintenance-last.json"), "utf8")).reason,
      "parent_identity_unknown", "a visible PID without creation time cannot prove the original parent exited");
    await collectAfterExit(exitOptions, { timeoutMs: 0 });
    await fs.access(obsolete);
    assert.equal(JSON.parse(await fs.readFile(path.join(rootDir, "exit-maintenance-last.json"), "utf8")).state, "deferred");
    const reused = require("node:child_process").spawnSync(require("electron"), ["-e",
      `require(${JSON.stringify(path.resolve(__dirname, "../src/main/update-exit-maintenance.cjs"))}).collectAfterExit(${JSON.stringify({ ...exitOptions, parentCreated: "original-parent-before-pid-reuse" })},{timeoutMs:0,ready:()=>console.log("exit-ready")}).catch(e=>{console.error(e);process.exitCode=1})`],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, encoding: "utf8", timeout: 20000 });
    assert.equal(reused.status, 0, reused.stderr);
    assert.match(reused.stdout, /exit-ready/, "the child acknowledges readiness before collecting");
    const occupied = JSON.parse(await fs.readFile(path.join(rootDir, "exit-maintenance-last.json"), "utf8"));
    assert.equal(occupied.state, "deferred");
    assert.equal(occupied.reason, undefined, "a reused PID does not keep waiting for the unrelated newer owner");
    assert(occupied.reasons.some(reason => /EPERM|EBUSY|EACCES/.test(reason)), "occupied files must remain explicitly deferred");
    child.stdin.end();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("exit handshake timed out: " + childErrors)), 20000);
      child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(childErrors)); });
    });
    assert.match(childMessages, /cleanup-ready/, "the real parent waits for the detached helper IPC acknowledgement before exiting");
    const deadline = Date.now() + 15000;
    while (JSON.parse(await fs.readFile(path.join(rootDir, "exit-maintenance-last.json"), "utf8")).state !== "complete") {
      if (Date.now() >= deadline) throw Error("detached exit retirement timed out");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await assert.rejects(fs.stat(obsolete), { code: "ENOENT" });
    await assert.rejects(fs.stat(download), { code: "ENOENT" }, "exit collection also retires owned full downloads in the parent cloud directory");
    await fs.access(prepared.generationRoot);
    assert.equal(JSON.parse(await fs.readFile(path.join(rootDir, "exit-maintenance-last.json"), "utf8")).state, "complete");
    assert.equal(await fs.readFile(unique, "utf8"), "keep");
  } finally {
    if (child.exitCode === null) await new Promise(resolve => { child.once("exit", resolve); child.stdin.end(); });
  }
});

test("local acceptance backs up the active application and business data without historical runtime copies", async t => {
  const { root, source, base } = await fixture(t);
  const profile = path.join(root, "中文日常数据"), outputRoot = path.join(root, "本机备份");
  const envelope = sign(base.manifest), id = digest(envelope.payload);
  const components = path.join(profile, "data/cloud-maintenance/components");
  await fs.mkdir(components, { recursive: true });
  await fs.cp(source, path.join(components, "generations", id), { recursive: true });
  await fs.writeFile(path.join(components, "generations", id, "component-complete.json"), JSON.stringify(envelope));
  await fs.writeFile(path.join(components, "selection.json"), JSON.stringify({ active: id, previous: null }));
  await fs.writeFile(path.join(profile, "费用回执.json"), "retained receipt bytes");
  await fs.mkdir(path.join(outputRoot, "unmanaged-history"), { recursive: true });
  const { backupLocalInstall } = require("./backup-local-install.cjs");
  for (let round = 0; round < 2; round++) {
    const acceptance = await backupLocalInstall({ program: source, profile, outputRoot, purpose: "acceptance", updateKind: "components" });
    assert.equal(acceptance.copiedBytes, 0, "Component acceptance uses selection rollback, not a full data copy");
  }
  assert.deepEqual(await fs.readdir(outputRoot), ["unmanaged-history"]);
  const snapshots = [];
  for (let index = 0; index < 3; index++) {
    snapshots.push(await backupLocalInstall({ program: source, profile, outputRoot }));
    if (index === 0) await fs.unlink(path.join(profile, "费用回执.json"));
  }
  await fs.access(path.join(snapshots[0].directory, "program"));
  assert.equal(await fs.readFile(path.join(snapshots[0].directory, "userData/费用回执.json"), "utf8"), "retained receipt bytes", "Unconfirmed installation cannot retire any complete rollback set");
  assert.equal(snapshots[2].directory, snapshots[1].directory, "identical verified manual backup is reused");
  for (const snapshot of snapshots.slice(1)) {
    await fs.access(path.join(snapshot.directory, "program"));
    await assert.rejects(fs.stat(path.join(snapshot.directory, "userData/data/cloud-maintenance")), { code: "ENOENT" });
    assert.equal(JSON.parse(await fs.readFile(path.join(snapshot.directory, "backup.json"), "utf8")).programSource, await fs.realpath(path.join(components, "generations", id)));
  }
  await fs.access(path.join(outputRoot, "unmanaged-history"));
  await fs.access(path.join(components, "generations", id));
});
test("signed composition rejects tampering, omitted components, incompatible base and schema", async t => {
  const { root, source, base } = await fixture(t);
  const envelope = sign(base.manifest);
  assert.equal(verifyComponentManifest(envelope, config).version, "1.1.0");
  assert.throws(() => verifyComponentManifest({ ...envelope, payload: envelope.payload.replace("1.1.0", "1.1.9") }, config), /signature/);
  const missing = structuredClone(base.manifest); delete missing.components.video;
  assert.throws(() => verifyComponentManifest(sign(missing), config), /manifest/);
  const store = createComponentStore({ rootDir: path.join(root, "store"), baseRoot: source, config, transport: { request() { throw Error("unexpected download"); } } });
  await assert.rejects(store.prepare(sign({ ...base.manifest, base: { ...base.manifest.base, fingerprint: "a".repeat(64) } })), /full_upgrade_required/);
  await assert.rejects(store.prepare(sign({ ...base.manifest, dataSchema: 3 })), /full_upgrade_required/);
  await fs.mkdir(path.join(root, "store"), { recursive: true });
  const invalidRetention = await require("../src/main/update-retention.cjs").retainComponentArtifacts(path.join(root, "store"), { payload: "{}" });
  assert.equal(invalidRetention.ok, false, "a worker that defers invalid references cannot report collection completed");
  assert.match(invalidRetention.reason, /retention|invalid/);
  assert.throws(() => treeHash([{ path: "../escape", size: 1, sha256: "a".repeat(64) }]), /path_invalid/);
  assert.throws(() => treeHash([{ path: "A", size: 1, sha256: "a".repeat(64) }, { path: "a", size: 1, sha256: "a".repeat(64) }]), /files_invalid/);
});
test("full generation matches signed target, reuses base and unchanged components, detects corruption", async t => {
  const { root, source, base } = await fixture(t);
  let requests = 0;
  const zeroStore = createComponentStore({ rootDir: path.join(root, "zero"), baseRoot: source, config, transport: { request() { requests++; throw Error("unexpected download"); } } });
  const zero = await zeroStore.prepare(sign(base.manifest));
  assert.equal(zero.downloadedBytes, 0); assert.equal(requests, 0);
  const nextSource = path.join(root, "next"); await fs.cp(source, nextSource, { recursive: true });
  await fs.writeFile(path.join(nextSource, "版本清单.json"), JSON.stringify({ version: "1.1.1", remotionRuntime: {} }));
  await fs.writeFile(path.join(nextSource, "resources/app/src/main/main.cjs"), "application v2");
  await fs.writeFile(path.join(nextSource, "resources/content-engine/remotion-bundle/index.js"), "remotion owncode v2");
  const target = await buildComponentRelease({ sourceRoot: nextSource, outputDir: path.join(root, "target-artifacts"), version: "1.1.1", ...config });
  assert.equal(target.manifest.base.fingerprint, base.manifest.base.fingerprint);
  const targetAgain = await buildComponentRelease({ sourceRoot: nextSource, outputDir: path.join(root, "target-artifacts"), version: "1.1.1", ...config });
  assert.deepEqual(targetAgain.artifacts.map(a => a.sha256), target.artifacts.map(a => a.sha256));
  let interrupted = false;
  const transport = { async request(route, options) {
    requests++;
    const archive = target.artifacts.find(a => route === `/components/${a.sha256}.zip`);
    assert.ok(archive); assert.equal(options.resume, true);
    if (!interrupted) {
      interrupted = true;
      const bytes = await fs.readFile(archive.path);
      await fs.writeFile(options.destination, bytes.subarray(0, Math.floor(bytes.length / 2)));
      throw Object.assign(new Error("simulated connection reset"), { code: "ECONNRESET" });
    }
    await fs.copyFile(archive.path, options.destination); options.onProgress(archive.size);
  } };
  const store = createComponentStore({ rootDir: path.join(root, "updated"), baseRoot: source, config, transport });
  const rawFs = require("node:fs"), originalReadStream = rawFs.createReadStream;
  let archiveReads = 0;
  rawFs.createReadStream = function(file, ...args) {
    if (String(file).startsWith(path.join(root, "updated/archives") + path.sep)) archiveReads++;
    return originalReadStream.call(this, file, ...args);
  };
  let result;
  try { result = await store.prepare(sign(target.manifest)); }
  finally { rawFs.createReadStream = originalReadStream; }
  assert.equal(archiveReads, 2, "each of the two changed archives must be hashed once, including fallback transports without a streaming proof");
  assert.equal(requests, 3);
  for (const file of target.baseline.files) assert.equal(await hashFile(path.join(result.generationRoot, file.path)), file.sha256);
  assert.equal(await fs.readFile(path.join(source, "resources/app/src/main/main.cjs"), "utf8"), "application v1");
  const cached = await store.prepare(sign(target.manifest)); assert.equal(cached.downloadedBytes, 0); assert.equal(requests, 3);
  await fs.writeFile(path.join(result.generationRoot, "unexpected.js"), "unknown");
  await assert.rejects(store.prepare(sign(target.manifest)), /generation_invalid/);
  const corrupt = createComponentStore({ rootDir: path.join(root, "corrupt"), baseRoot: source, config,
    transport: { async request(_route, options) { await fs.writeFile(options.destination, "corrupt archive"); } } });
  await assert.rejects(corrupt.prepare(sign(target.manifest)), /download_invalid/);
  assert.deepEqual(await fs.readdir(path.join(root, "corrupt/generations")), [], "a failed download must remove its own extracted staging directory");
  const failedParts = await fs.readdir(path.join(root, "corrupt/archives"));
  assert.equal(failedParts.length, 1);
  await corrupt.prepare(sign(base.manifest));
  assert.deepEqual(await fs.readdir(path.join(root, "corrupt/archives")), [], "superseded failed partial downloads must be retired");
  const zip = new (require("jszip"))();
  zip.file("component.json", "{}"); zip.file("../escaped.js", "unsafe", { createFolders: false });
  const unsafe = await zip.generateAsync({ type: "nodebuffer" });
  const poisoned = structuredClone(target.manifest);
  poisoned.components.application = { ...poisoned.components.application, sha256: digest(unsafe), size: unsafe.length,
    fileCount: 1, treeSha256: "b".repeat(64), file: `/components/${digest(unsafe)}.zip` };
  const escaped = createComponentStore({ rootDir: path.join(root, "escaped"), baseRoot: source, config,
    transport: { async request(_route, options) { await fs.writeFile(options.destination, unsafe); } } });
  await assert.rejects(escaped.prepare(sign(poisoned)), /component_path_invalid/);
  await escaped.prepare(sign(base.manifest));
  assert.deepEqual(await fs.readdir(path.join(root, "escaped/archives")), [], "a downloaded ZIP is retired even when extraction failed");

  // Keep an installable candidate if its replacement fails, then retire it only
  // after the replacement is complete. Cached historical files remain unowned.
  const recoveryRoot = path.join(root, "replacement"), legacyRoot = path.join(root, "legacy");
  let failDownload = true;
  const recovery = createComponentStore({ rootDir: recoveryRoot, baseRoot: source, config,
    transport: { async request(route, options) {
      if (failDownload) { await fs.writeFile(options.destination, "partial"); throw Error("interrupted_fixture"); }
      await fs.copyFile(target.artifacts.find(a => route === `/components/${a.sha256}.zip`).path, options.destination);
    } } });
  const previous = await recovery.prepare(sign(base.manifest));
  await assert.rejects(recovery.prepare(sign(target.manifest)), /interrupted_fixture/);
  await fs.access(previous.generationRoot);
  failDownload = false;
  const replacement = await recovery.prepare(sign(target.manifest));
  await assert.rejects(fs.stat(previous.generationRoot), { code: "ENOENT" });
  await fs.cp(recoveryRoot, legacyRoot, { recursive: true });
  await fs.rm(path.join(legacyRoot, ".artifact-retention.json"));
  const legacy = createComponentStore({ rootDir: legacyRoot, baseRoot: source, config, transport: {} });
  await legacy.prepare(sign(target.manifest));
  await legacy.prepare(sign(base.manifest));
  await fs.access(path.join(legacyRoot, "generations", path.basename(replacement.generationRoot)));
  for (const archive of await fs.readdir(path.join(recoveryRoot, "archives"))) await fs.access(path.join(legacyRoot, "archives", archive));
});
test("new component metadata invalidates ready and in-flight older updates", async t => {
  const { root, source, base } = await fixture(t);
  let latest = sign({ ...base.manifest, version: "1.1.1", sequence: 100 });
  const logger = createDiagnosticLogger({ rootDir: path.join(root, "client") });
  const controller = createCloudMaintenance({ logger, rootDir: path.join(root, "client"), userData: path.join(root, "user-data"),
    componentBaseRoot: source, config, version: "1.1.0", buildId: "metadata-race", canInstall: () => true,
    transport: { async request(route) {
      if (route.startsWith("/v1/")) return { empty: true };
      if (route.startsWith("/v2/")) return latest;
      assert.fail("Unchanged verified components must not download");
    }, close() {} } });
  t.after(() => controller.stop());
  await controller.check();
  assert.equal(controller.status().stage, "ready");
  const phases = logger.readRecent(50).filter(entry => entry.module === "maintenance" && entry.event === "update.phase");
  assert.ok(phases.some(entry => entry.phase === "prepare"), "Real diagnostic filtering must retain component phase measurements");
  assert.ok(phases.every(entry => Number.isFinite(entry.duration_ms) && entry.duration_ms >= 0), "Phase records retain measured durations");
  assert.equal((await controller.prepareInstall()).version, "1.1.1");
  latest = sign({ ...base.manifest, version: "1.1.2", sequence: 101 });
  await controller.refreshAnnouncements();
  assert.equal(controller.status().stage, "idle", "New metadata must leave a working check-again action");
  assert.equal(await controller.prepareInstall(), null);
  await controller.check();
  assert.equal(controller.status().stage, "ready");
  assert.equal((await controller.prepareInstall()).version, "1.1.2");
  let refreshing;
  const unsubscribe = controller.onUpdate(state => {
    if (state.stage !== "preparing" || refreshing) return;
    latest = sign({ ...base.manifest, version: "1.1.3", sequence: 102 });
    refreshing = controller.refreshAnnouncements();
  });
  await controller.check();
  await refreshing;
  unsubscribe();
  assert.equal(controller.status().stage, "error", "An older in-flight preparation cannot reappear as ready");
  assert.equal(await controller.prepareInstall(), null);
});
test("HTTPS partial download resumes with strict Range and falls back to a full response", async t => {
  const { root } = await fixture(t);
  // Public localhost-only test credentials, unrelated to release signing or the
  // production CA. Keep this check runnable after npm ci without a local Python env.
  const tls = { key: `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIGKBS75Giou2rvHwoCN5PWfrVdegseg0JsQ3YXuAuzOxoAoGCCqGSM49
AwEHoUQDQgAE/8PwLSQxHyZSZKtP1Pga7mjx/cFihToIaMzyckoJCqRbWfHqHyM6
zT74a8oRTaGqmYcuqFNPopAjXTl8OgQpMw==
-----END EC PRIVATE KEY-----
`, cert: `-----BEGIN CERTIFICATE-----
MIIBXDCCAQKgAwIBAgIBATAKBggqhkjOPQQDAjAhMR8wHQYDVQQDDBZsb2NhbGhv
c3QgdGVzdCBmaXh0dXJlMCAXDTIwMDEwMTAwMDAwMFoYDzIxMDAwMTAxMDAwMDAw
WjAhMR8wHQYDVQQDDBZsb2NhbGhvc3QgdGVzdCBmaXh0dXJlMFkwEwYHKoZIzj0C
AQYIKoZIzj0DAQcDQgAE/8PwLSQxHyZSZKtP1Pga7mjx/cFihToIaMzyckoJCqRb
WfHqHyM6zT74a8oRTaGqmYcuqFNPopAjXTl8OgQpM6MpMCcwDwYDVR0TAQH/BAUw
AwEB/zAUBgNVHREEDTALgglsb2NhbGhvc3QwCgYIKoZIzj0EAwIDSAAwRQIhAPaq
3gymfeDzvnyPN8wPVLQ0lDgFr7LE2F82flXVVslxAiBJWZ/L6JkwxZMFJrUEMIpf
Eo3uwSF/qcX9KawlC0ZAFA==
-----END CERTIFICATE-----
` };
  const data = crypto.randomBytes(96 * 1024), expected = { size: data.length, sha256: digest(data) };
  let mode = "interrupt", requested;
  const server = https.createServer(tls, (req, res) => {
    requested = req.headers.range;
    if (mode === "interrupt") {
      res.writeHead(200, { "Content-Length": data.length }); res.write(data.subarray(0, 32768));
      setTimeout(() => res.destroy(), 30); return;
    }
    if (mode === "fallback") { res.writeHead(200, { "Content-Length": data.length }); res.end(data); return; }
    const start = Number((req.headers.range || "bytes=0-").match(/\d+/)[0]);
    res.writeHead(206, { "Content-Length": data.length - start,
      "Content-Range": `bytes ${mode === "invalid" ? start + 1 : start}-${data.length - 1}/${data.length}` });
    res.end(data.subarray(start));
  });
  await new Promise(resolve => server.listen(0, "localhost", resolve));
  const transport = createTransport({ origin: `https://localhost:${server.address().port}`, caPem: tls.cert });
  t.after(async () => { transport.close(); await new Promise(resolve => server.close(resolve)); });
  const destination = path.join(root, "download.part");
  const options = { destination, expected, maxBytes: data.length, resume: true };
  await assert.rejects(transport.request("/components/test.zip", options));
  const partial = (await fs.stat(destination)).size; assert.equal(partial, 32768);
  mode = "resume";
  await transport.request("/components/test.zip", options);
  assert.equal(requested, `bytes=${partial}-`); assert.equal(await hashFile(destination), expected.sha256);
  await fs.writeFile(destination, data.subarray(0, 100)); mode = "invalid";
  await assert.rejects(transport.request("/components/test.zip", options), /range_invalid/);
  assert.equal((await fs.stat(destination)).size, 100);
  mode = "fallback";
  await transport.request("/components/test.zip", options);
  assert.equal(await hashFile(destination), expected.sha256);
});
