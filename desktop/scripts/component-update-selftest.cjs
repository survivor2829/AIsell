const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const { buildComponentRelease } = require("./build-component-release.cjs");
const { createComponentStore } = require("../src/main/component-store.cjs");
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
    "resources/app/node_modules/native/index.node": "stable native",
    "resources/app/src/main/main.cjs": "application v1",
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
  await fs.writeFile(path.join(source, "component-base.json"), JSON.stringify(base.baseline));
  return { root, source, base };
}
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
  const transport = { async request(route, options) {
    requests++;
    const archive = target.artifacts.find(a => route === `/components/${a.sha256}.zip`);
    assert.ok(archive); assert.equal(options.resume, true);
    await fs.copyFile(archive.path, options.destination); options.onProgress(archive.size);
  } };
  const store = createComponentStore({ rootDir: path.join(root, "updated"), baseRoot: source, config, transport });
  const result = await store.prepare(sign(target.manifest));
  assert.equal(requests, 2);
  for (const file of target.baseline.files) assert.equal(await hashFile(path.join(result.generationRoot, file.path)), file.sha256);
  assert.equal(await fs.readFile(path.join(source, "resources/app/src/main/main.cjs"), "utf8"), "application v1");
  const cached = await store.prepare(sign(target.manifest)); assert.equal(cached.downloadedBytes, 0); assert.equal(requests, 2);
  await fs.writeFile(path.join(result.generationRoot, "unexpected.js"), "unknown");
  await assert.rejects(store.prepare(sign(target.manifest)), /generation_invalid/);
  const corrupt = createComponentStore({ rootDir: path.join(root, "corrupt"), baseRoot: source, config,
    transport: { async request(_route, options) { await fs.writeFile(options.destination, "corrupt archive"); } } });
  await assert.rejects(corrupt.prepare(sign(target.manifest)), /archive_corrupt/);
  const zip = new (require("jszip"))();
  zip.file("component.json", "{}"); zip.file("../escaped.js", "unsafe", { createFolders: false });
  const unsafe = await zip.generateAsync({ type: "nodebuffer" });
  const poisoned = structuredClone(target.manifest);
  poisoned.components.application = { ...poisoned.components.application, sha256: digest(unsafe), size: unsafe.length,
    fileCount: 1, treeSha256: "b".repeat(64), file: `/components/${digest(unsafe)}.zip` };
  const escaped = createComponentStore({ rootDir: path.join(root, "escaped"), baseRoot: source, config,
    transport: { async request(_route, options) { await fs.writeFile(options.destination, unsafe); } } });
  await assert.rejects(escaped.prepare(sign(poisoned)), /component_path_invalid/);
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
