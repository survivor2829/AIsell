const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const { spawnSync } = require("node:child_process");
const { buildComponentRelease } = require("./build-component-release.cjs");
const { createComponentStore } = require("../src/main/component-store.cjs");
const { createTransport } = require("../src/main/cloud-transport.cjs");
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
test("HTTPS partial download resumes with strict Range and falls back to a full response", async t => {
  const { root } = await fixture(t);
  const python = path.resolve(__dirname, "../.build/product-detail-venv/Scripts/python.exe");
  const generated = spawnSync(python, ["-c", `
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
import datetime,json
key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'localhost')])
now=datetime.datetime.now(datetime.timezone.utc)
cert=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(minutes=1)).not_valid_after(now+datetime.timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]),critical=False).sign(key,hashes.SHA256())
print(json.dumps({'key':key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode(),'cert':cert.public_bytes(serialization.Encoding.PEM).decode()}))
`], { encoding: "utf8", windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr);
  const tls = JSON.parse(generated.stdout), data = crypto.randomBytes(96 * 1024), expected = { size: data.length, sha256: digest(data) };
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
