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

test("successful-version verification is cached across launches and invalidated by manifest or runtime failure", async t => {
  const { root, source } = await fixture(t);
  const components = require("../src/main/component-paths.cjs");
  const paths = components.updatePaths(path.join(root, "profile"));
  const receipt = components.bootVerificationReceipt(paths, source);
  assert.equal(receipt.hit, false);
  components.beginBoot(paths);
  for (const invalid of [null, { schema: 1, records: {} }, { schema: 1, records: [null] }]) {
    await fs.writeFile(path.join(paths.directory, "verification-cache.json"), JSON.stringify(invalid));
    assert.equal(components.bootVerificationReceipt(paths, source).hit, false, "malformed cache must degrade to full verification");
  }
  try {
    global.__xiaoxiComponents = { paths, root: source, installedRoot: source, receipt, healthy: false };
    components.markHealthy();
    assert.equal(components.bootVerificationReceipt(paths, source).hit, true);
    components.runtimeLaunchFailed(path.join(source, "ffmpeg.exe"), { code: 1 });
    assert.equal(components.bootVerificationReceipt(paths, source).hit, true, "ordinary media errors must not invalidate the runtime");
    components.runtimeLaunchFailed(path.join(root, "external.exe"), { code: "ENOENT" });
    assert.equal(components.bootVerificationReceipt(paths, source).hit, true, "external executables are not part of the installation");
    components.runtimeLaunchFailed(path.join(source, "ffmpeg.exe"), { code: "ENOENT" });
    assert.equal(components.bootVerificationReceipt(paths, source).hit, false);
    assert.equal(components.beginBoot(paths), true, "runtime failure forces full verification on the next launch");
    global.__xiaoxiComponents = { paths, root: source, installedRoot: source, receipt, healthy: false };
    components.markHealthy();
    const failure = "previous candidate failed";
    assert.equal(components.bootVerificationReceipt(paths, source, source, failure).hit, false);
    components.saveSelection(paths, { failure });
    global.__xiaoxiComponents = { paths, root: source, installedRoot: source,
      receipt: components.bootVerificationReceipt(paths, source, source, failure), healthy: false };
    components.markHealthy();
    assert.equal(components.readJson(paths.selection).failure, failure, "rollback reason must remain available to the user");
    assert.equal(components.bootVerificationReceipt(paths, source, source, failure).hit, true);
    await fs.appendFile(path.join(source, "component-base.json"), " ");
    assert.equal(components.bootVerificationReceipt(paths, source).hit, false, "even metadata changes invalidate a receipt");
  } finally { delete global.__xiaoxiComponents; }
});

test("signed verification groups defer only unused runtimes and media, never startup code", async t => {
  const { root, source, base } = await fixture(t);
  const envelope = sign({ ...base.manifest, version: "1.1.1" });
  const store = createComponentStore({ rootDir: path.join(root, "groups"), baseRoot: source, config, transport: { request() { assert.fail("no downloads"); } } });
  const prepared = await store.prepare(envelope);
  const { verifySelected, createRuntimeVerification } = require("../src/main/component-paths.cjs");
  const runtime = path.join(prepared.generationRoot, "resources/content-engine/content-engine-worker.exe");
  await fs.writeFile(runtime, "corrupt runtime");
  const manifest = await verifySelected(prepared.generationRoot, source, config, { startupOnly: true });
  const verification = createRuntimeVerification(prepared.generationRoot, manifest);
  await assert.rejects(verification.ensure("content"), /corrupt/);
  await assert.rejects(verifySelected(prepared.generationRoot, source, config), /corrupt/);
  const media = path.join(prepared.generationRoot, "resources/app/dist/video-examples/sample.mp4");
  await fs.writeFile(media, "corrupt sample");
  await assert.rejects(verification.media(media), /corrupt/);
  const extra = path.join(prepared.generationRoot, "resources/app/src/main/unlisted.cjs");
  await fs.writeFile(extra, "unlisted code");
  await assert.rejects(verifySelected(prepared.generationRoot, source, config, { startupOnly: true }), /generation_invalid/);
  await fs.unlink(extra);
  await fs.writeFile(path.join(prepared.generationRoot, "resources/app/src/main/main.cjs"), "application v2");
  await assert.rejects(verifySelected(prepared.generationRoot, source, config, { startupOnly: true }), /corrupt/);
});

test("startup verification checks shared parents once but rehashes files on each launch", async t => {
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
  await require("../src/main/update-startup-maintenance.cjs").maintainAfterStartup(rootDir, { profile, version: "1.1.4" });
  await assert.rejects(fs.stat(deferred), { code: "ENOENT" }, "healthy-start worker retries component cleanup even without a retired full backup");
  await fs.access(historical);
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
  const result = await store.prepare(sign(target.manifest));
  assert.equal(requests, 3);
  for (const file of target.baseline.files) assert.equal(await hashFile(path.join(result.generationRoot, file.path)), file.sha256);
  assert.equal(await fs.readFile(path.join(source, "resources/app/src/main/main.cjs"), "utf8"), "application v1");
  const cached = await store.prepare(sign(target.manifest)); assert.equal(cached.downloadedBytes, 0); assert.equal(requests, 3);
  await fs.writeFile(path.join(result.generationRoot, "unexpected.js"), "unknown");
  await assert.rejects(store.prepare(sign(target.manifest)), /generation_invalid/);
  const corrupt = createComponentStore({ rootDir: path.join(root, "corrupt"), baseRoot: source, config,
    transport: { async request(_route, options) { await fs.writeFile(options.destination, "corrupt archive"); } } });
  await assert.rejects(corrupt.prepare(sign(target.manifest)), /archive_corrupt/);
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
  const controller = createCloudMaintenance({ rootDir: path.join(root, "client"), userData: path.join(root, "user-data"),
    componentBaseRoot: source, config, version: "1.1.0", buildId: "metadata-race", canInstall: () => true,
    transport: { async request(route) {
      if (route.startsWith("/v1/")) return { empty: true };
      if (route.startsWith("/v2/")) return latest;
      assert.fail("Unchanged verified components must not download");
    }, close() {} } });
  t.after(() => controller.stop());
  await controller.check();
  assert.equal(controller.status().stage, "ready");
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
