// Original source protocol + original base58 files. No installer is executed and
// no installed/customer profile is opened. This is not original-installer acceptance.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const JSZip = require("jszip");
const { buildLegacyBridgePatch, SOURCE_COMMIT, SOURCE_HASHES, SOURCE_PROFILES } = require("./legacy-update-bridge.cjs");
const { treeHash, digest, hashFile } = require("../src/shared/component-contract.cjs");
const desktop = path.resolve(__dirname, "..");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function checkContinuation(bridgeApp, root) {
  const { EventEmitter } = require("node:events");
  const { claimContinuation, createLegacyContinuation, legacySafety } = require(path.join(bridgeApp, "src/main/legacy-update-continuation.cjs"));
  const profile = path.join(root, "continuation-profile"), paths = require(path.join(bridgeApp, "src/main/component-paths.cjs")).updatePaths(profile);
  fs.mkdirSync(paths.jobs, { recursive: true });
  const id = crypto.randomUUID(), context = { id: "a".repeat(64), root: path.join(paths.generations, "a".repeat(64)), version: "1.1.80" };
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  write(paths.selection, { active: context.id, pending: { jobId: id } });
  write(path.join(paths.jobs, id + ".json"), { id, targetVersion: context.version, prepared: { kind: "components", generationRoot: context.root } });
  write(path.join(paths.jobs, id + ".ready.json"), { pid: 4321 });
  write(path.join(paths.directory, "active-job.json"), { id, pid: 4321 });
  const proof = { userData: profile, context, argv: ["app", "--xiaoxi-updated-launch", id], isAlive: () => true };
  assert.equal(claimContinuation({ ...proof, argv: ["app"] }), null, "ordinary launch never inherits an update request");
  assert.equal(claimContinuation({ ...proof, isAlive: () => false }), null, "an old command line cannot replay a completed updater");
  let busy = true, firstAlive = true, held = false, installed = 0, quit = 0, released = 0, cancel;
  const app = new EventEmitter(); app.quit = () => { quit++; app.emit("before-quit"); };
  const controller = { status: () => ({ stage: "ready" }), check: async () => {}, prepareInstall: async () => ({ kind: "full" }),
    beginInstall: async () => { installed++; return true; }, setInstallBlocked: () => {} };
  const options = { ...proof, app, controller, isAlive: () => firstAlive, intervalMs: 5,
    setHold: value => { held = value; }, prepare: async () => busy ? "saving" : "", release: async () => { released++; },
    showProgress: fn => { cancel = fn; return { update() {}, close() {} }; } };
  const updater = createLegacyContinuation(options);
  assert.equal(updater.inherited, true); updater.start(); await sleep(20);
  assert.equal(held, true); assert.equal(installed, 0, "second helper waits for first helper and startup ACK");
  write(path.join(paths.jobs, id + ".status.json"), { phase: "complete" });
  write(path.join(paths.jobs, id + ".ack.json"), { ok: true, version: context.version });
  firstAlive = false; await sleep(20);
  assert.equal(installed, 0, "busy business tasks remain protected after first stage completes");
  cancel(); await sleep(20); busy = false; await sleep(20);
  assert.equal(held, false); assert.equal(installed, 0, "cancelled intent does not resume when tasks finish");
  assert.equal(claimContinuation({ ...proof, isAlive: () => true }), null, "consumed first-stage request cannot replay");
  await updater.request(); await sleep(30);
  assert.equal(installed, 1); assert.equal(quit, 1); assert.ok(released > 0);
  const stopping = new EventEmitter(); stopping.quit = () => assert.fail("ordinary quit must not schedule installation");
  let completeDownload;
  const pending = createLegacyContinuation({ ...options, argv: ["app"], app: stopping,
    controller: { ...controller, status: () => ({ stage: "downloading" }), check: () => new Promise(resolve => { completeDownload = resolve; }) } });
  await pending.request(); stopping.emit("before-quit"); completeDownload(); await sleep(20);
  assert.equal(installed, 1, "closing during download invalidates intent without installing");
  const nextId = crypto.randomUUID(), nextApp = new EventEmitter(); nextApp.quit = () => nextApp.emit("before-quit");
  write(paths.selection, { active: context.id, pending: { jobId: nextId } });
  write(path.join(paths.jobs, nextId + ".json"), { id: nextId, targetVersion: context.version, prepared: { kind: "components", generationRoot: context.root } });
  write(path.join(paths.jobs, nextId + ".ready.json"), { pid: 4321 });
  write(path.join(paths.directory, "active-job.json"), { id: nextId, pid: 4321 });
  firstAlive = true;
  const continuing = createLegacyContinuation({ ...options, app: nextApp, argv: ["app", "--xiaoxi-updated-launch", nextId] });
  continuing.start();
  write(path.join(paths.jobs, nextId + ".status.json"), { phase: "complete" });
  write(path.join(paths.jobs, nextId + ".ack.json"), { ok: true, version: context.version });
  firstAlive = false; await sleep(30);
  assert.equal(installed, 2, "a healthy first stage continues without asking for a second update click");
  // Use the real safety adapter: unknown WeChat results are never retried or resent.
  let phase = "listening", pauses = 0, mediaBusy = true;
  const safety = legacySafety({ workflow: { status: () => ({ enabled: phase === "listening", phase }),
    pause: async () => { pauses++; phase = "paused"; } }, coordinator: { status: () => ({ lock: false }) },
    productVideo: { prepareForUpdate: async () => ({ busy: mediaBusy }), resumeAfterUpdate() {} } });
  assert.match(await safety.prepare(), /微信/); assert.match(await safety.prepare(), /视频/);
  mediaBusy = false; assert.equal(await safety.prepare(), ""); assert.equal(pauses, 1); await safety.release();
}
async function main() {
  const baseRoot = path.resolve(process.argv[2] || "");
  if (!process.argv[2]) throw Error("Usage: node scripts/legacy-update-bridge.self_check.cjs <verified-base58-root>");
  const baseline = JSON.parse(fs.readFileSync(path.join(baseRoot, "component-base.json")));
  assert.equal(baseline.base.version, "1.1.58");
  assert.equal(baseline.base.fingerprint, "5c7371705272e36b69831fef4346e5c56294380604f322cacf979ef97fe4e1c2");
  const parent = path.join(desktop, ".build/legacy-bridge-protocol");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "run-"));
  const sourceZip = path.join(root, "source64.zip");
  execFileSync("git", ["archive", "--format=zip", "-o", sourceZip, SOURCE_COMMIT,
    "desktop/src/main", "desktop/src/shared", "desktop/package.json", "desktop/package-lock.json", "desktop/product-brand.json"], { cwd: path.dirname(desktop) });
  const archive = await JSZip.loadAsync(fs.readFileSync(sourceZip));
  const sourceApp = path.join(root, "source64");
  const originalFiles = new Map();
  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue;
    const relative = entry.name.slice("desktop/".length), file = path.join(sourceApp, relative);
    const bytes = await entry.async("nodebuffer");
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    originalFiles.set(relative, bytes);
  }
  const sourceLock = JSON.parse(originalFiles.get("package-lock.json"));
  const basePackage = JSON.parse(fs.readFileSync(path.join(baseRoot, "resources/app/package.json")));
  assert.deepEqual(sourceLock.packages[""].dependencies, basePackage.dependencies, "Reconstruction retains the original base58 dependency set");
  fs.symlinkSync(path.join(baseRoot, "resources/app/node_modules"), path.join(sourceApp, "node_modules"), "junction");
  const keys = crypto.generateKeyPairSync("ed25519");
  const config = { enabled: true, appId: "com.aihuoke.desktop.test", channel: "test", signingPublicKey: keys.publicKey };
  const sign = manifest => { const payload = JSON.stringify(manifest); return { payload, signature: crypto.sign(null, Buffer.from(payload), keys.privateKey).toString("base64") }; };
  const installerBytes = Buffer.from("INERT FIXTURE - NEVER EXECUTE"), fullSha = digest(installerBytes);
  const fullManifest = { schema: 1, ...config, signingPublicKey: undefined, enabled: undefined, version: "1.1.81",
    platform: "win32", arch: "x64", sequence: 300, sha256: fullSha, size: installerBytes.length,
    file: `/artifacts/${fullSha}.exe`, notes: "隔离协议夹具，未发布" };
  const targetEnvelope = sign(fullManifest);
  const patch = buildLegacyBridgePatch({ sourceApplicationRoot: sourceApp, targetEnvelope, bridgeVersion: "1.1.80", config });
  assert.equal(patch.sourceCommit, SOURCE_COMMIT);
  assert.deepEqual(patch.sourceHashes, SOURCE_HASHES);
  for (const [relative, source] of Object.entries(patch.files)) if (relative.endsWith(".cjs")) new (require("node:vm").Script)(source, { filename: relative });
  // The customer's installed 1.1.64 has a later, independently fingerprinted
  // main module. Reconstruct its four inputs without touching collected files.
  const customerProfile = SOURCE_PROFILES.find(profile => profile.commit === "c3b7a4c4e2984e29ace4eb6711f455587457b599");
  assert.ok(customerProfile);
  const customerApp = path.join(root, "customer-source64");
  for (const relative of Object.keys(customerProfile.hashes)) {
    const file = path.join(customerApp, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, execFileSync("git", ["show", customerProfile.commit + ":desktop/" + relative], { cwd: desktop }));
  }
  const customerOptions = { sourceApplicationRoot: customerApp, targetEnvelope, bridgeVersion: "1.1.80", config };
  const customerPatch = buildLegacyBridgePatch(customerOptions);
  assert.equal(customerPatch.sourceCommit, customerProfile.commit);
  assert.deepEqual(customerPatch.sourceHashes, customerProfile.hashes);
  const customerMainFile = path.join(customerApp, "src/main/main.cjs");
  const customerMain = fs.readFileSync(customerMainFile, "utf8").replaceAll("\r\n", "\n");
  const patchedMain = customerPatch.files["src/main/main.cjs"];
  new (require("node:vm").Script)(patchedMain);
  assert.match(customerMain, /prepareNarration: prepareWorkbenchNarration/);
  const registration = customerMain.indexOf('      registerCloudMaintenanceIpc({ ipcMain, controller: cloudMaintenance, getMainWindow: () => mainWindow,');
  assert.ok(registration > 0);
  assert.equal(patchedMain.slice(0, registration), customerMain.slice(0, registration), "shared narration and all business registration before the update patch must be preserved");
  const start = customerMain.indexOf('      cloudMaintenance.start();', registration);
  assert.ok(start > registration);
  assert.ok(patchedMain.endsWith(customerMain.slice(start)), "business source after the update registration must also be preserved");
  fs.appendFileSync(customerMainFile, "\n// Unrecognized source must not be patched by context alone.\n");
  assert.throws(() => buildLegacyBridgePatch(customerOptions), /legacy_bridge_source_mismatch:src\/main\/main\.cjs/);
  assert.throws(() => buildLegacyBridgePatch({ sourceApplicationRoot: sourceApp,
    targetEnvelope: { ...targetEnvelope, signature: "invalid" }, bridgeVersion: "1.1.80", config }), /signature/);
  assert.throws(() => buildLegacyBridgePatch({ sourceApplicationRoot: sourceApp, targetEnvelope, bridgeVersion: "1.1.81", config }), /version_order/);
  const layout = JSON.parse(execFileSync("git", ["show", SOURCE_COMMIT + ":desktop/component-layout.json"], { cwd: desktop }));
  const { classify } = require("./build-component-release.cjs");
  const application = new Map();
  for (const item of baseline.files.filter(item => item.component === "application")) {
    application.set(item.path, fs.readFileSync(path.join(baseRoot, item.path)));
  }
  // All business source comes from original64. The old renderer/sidecar binaries
  // remain base58 only for this protocol fixture and are never booted.
  for (const [relative, bytes] of originalFiles) {
    const target = "resources/app/" + relative;
    if (classify(target, layout) === "application") application.set(target, bytes);
  }
  for (const [relative, source] of Object.entries(patch.files)) {
    const target = "resources/app/" + relative;
    assert.equal(classify(target, layout), "application", "Bridge does not mutate immutable base files");
    application.set(target, Buffer.from(source));
  }
  const files = [...application].map(([relative, bytes]) => ({ path: relative, size: bytes.length, sha256: digest(bytes) }));
  const descriptor = { schema: 2, name: "application", treeSha256: treeHash(files), files };
  const zip = new JSZip(), zipOptions = { date: new Date("2000-01-01"), createFolders: false, unixPermissions: 0o100644 };
  zip.file("component.json", JSON.stringify(descriptor), zipOptions);
  for (const [relative, bytes] of application) zip.file("files/" + relative, bytes, zipOptions);
  const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX", compression: "DEFLATE" });
  const componentSha = digest(bytes), componentFile = path.join(root, componentSha + ".zip");
  fs.writeFileSync(componentFile, bytes);
  const components = {};
  for (const name of ["application", "content-engine", "product-detail", "video"]) {
    const own = name === "application" ? files : baseline.files.filter(item => item.component === name);
    components[name] = { name, sha256: name === "application" ? componentSha : treeHash(own),
      treeSha256: treeHash(own), size: name === "application" ? bytes.length : 1,
      expandedSize: own.reduce((n, file) => n + file.size, 0), fileCount: own.length,
      file: `/components/${name === "application" ? componentSha : treeHash(own)}.zip` };
  }
  const bridge = sign({ schema: 2, appId: config.appId, channel: config.channel, platform: "win32", arch: "x64",
    version: "1.1.80", sequence: 200, base: baseline.base, minBaseVersion: "1.1.58", dataSchema: baseline.dataSchema,
    notes: "隔离桥接协议验证，不是发布制品", components });
  const profile = path.join(root, "isolated-profile");
  const oldController = require(path.join(sourceApp, "src/main/cloud-maintenance.cjs")).createCloudMaintenance({
    rootDir: path.join(profile, "data"), userData: profile, config, version: "1.1.64", componentBaseRoot: baseRoot, canInstall: () => true,
    transport: { async request(route, options = {}) {
      if (route.startsWith("/v1/")) return sign({ ...fullManifest, version: "1.1.79", sequence: 100 });
      if (route.startsWith("/v2/")) return bridge;
      assert.equal(route, `/components/${componentSha}.zip`);
      fs.copyFileSync(componentFile, options.destination); options.onProgress(bytes.length);
      return { size: bytes.length };
    }, close() {} }
  });
  await oldController.check();
  assert.equal(oldController.status().stage, "ready", oldController.status().error);
  const prepared = await oldController.prepareInstall();
  assert.equal(prepared.kind, "components"); assert.equal(prepared.version, "1.1.80");
  assert.equal(await oldController.installOnExit(), false); oldController.stop();
  const originalPaths = require(path.join(sourceApp, "src/main/component-paths.cjs"));
  assert.equal((await originalPaths.verifySelected(prepared.generationRoot, baseRoot, config)).version, "1.1.80");
  const bridgeApp = path.join(prepared.generationRoot, "resources/app");
  await checkContinuation(bridgeApp, root);
  const helper = require(path.join(bridgeApp, "src/main/legacy-update-helper.cjs"));
  const runtimeLinks = path.join(profile, "product-detail/.runtime-links");
  fs.mkdirSync(runtimeLinks, { recursive: true });
  fs.symlinkSync(path.join(baseRoot, "resources"), path.join(runtimeLinks, "resource-link"), "junction");
  const customer = path.join(profile, "data/customer.json"), customerBytes = Buffer.from('{"customer":"fixture","history":[1,2]}');
  fs.writeFileSync(customer, customerBytes);
  const backup = await helper.backupUserData(profile, crypto.randomUUID());
  assert.equal(fs.existsSync(path.join(backup, "product-detail/.runtime-links")), false);
  assert.deepEqual(fs.readFileSync(path.join(backup, "data/customer.json")), customerBytes);
  assert.equal(fs.lstatSync(path.join(runtimeLinks, "resource-link")).isSymbolicLink(), true);
  const authFile = path.join(root, crypto.randomUUID() + ".json"), job = { id: crypto.randomUUID(), targetVersion: "1.1.81", parentPid: process.pid };
  await assert.rejects(helper.waitForAuthorization(authFile, job, 1), /not_committed/);
  fs.writeFileSync(authFile.replace(/\.json$/, ".ready.json"), JSON.stringify({ pid: process.pid }));
  helper.authorizeUpdateJob(authFile, job); await helper.waitForAuthorization(authFile, job, 1);
  helper.revokeUpdateJob(authFile); await assert.rejects(helper.waitForAuthorization(authFile, job, 1), /cancelled/);
  let downloads = 0;
  const next = require(path.join(bridgeApp, "src/main/cloud-maintenance.cjs")).createCloudMaintenance({
    rootDir: path.join(profile, "data"), userData: profile, config, version: "1.1.80", componentBaseRoot: prepared.generationRoot, canInstall: () => true,
    transport: { async request(route, options) {
      assert.equal(route, fullManifest.file, "The second leg cannot drift to a newly published latest target");
      downloads++; fs.writeFileSync(options.destination, installerBytes); options.onProgress(installerBytes.length);
      return { size: installerBytes.length };
    }, close() {} }
  });
  await next.check(); assert.equal(next.status().stage, "ready", next.status().error);
  const full = await next.prepareInstall(); assert.equal(full.kind, "full"); assert.equal(full.version, "1.1.81");
  assert.equal(await hashFile(full.file), fullSha); assert.equal(downloads, 1);
  assert.equal(await next.installOnExit(), false); next.stop();
  assert.deepEqual(fs.readFileSync(customer), customerBytes);
  const evidence = { sourceCommit: SOURCE_COMMIT, base: baseline.base, bridgeVersion: "1.1.80", targetVersion: "1.1.81",
    customerSourceCommit: customerPatch.sourceCommit, customerSourceHashes: customerPatch.sourceHashes,
    customerSourcePatchPreservesBusinessCode: true, unknownMainSourceRejected: true,
    signedComponentPreparedByOriginal64Protocol: true, originalVerifierAcceptedGeneration: true,
    patchedHelperBackupExcludedRuntimeJunction: true, businessBytesPreserved: true, secondLegSignedTargetFixed: true,
    helperCommitAndCancellationPassed: true, ordinaryExitDoesNotInstall: true,
    sourceReconstructionOnly: true, original64InstallerAvailable: false, actualInstallerExecuted: false, autoContinuationImplemented: true,
    oneTimeIntentAndSafeWaitAndCancelPassed: true, currentRecoveryStackBundled: true,
    deliveryReady: false, remainingGates: patch.remainingGates, patchSourceHashes: patch.sourceHashes, recoverySourceHashes: patch.recoverySourceHashes };
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(evidence, null, 2));
  console.log("legacy bridge source-protocol checks passed: " + path.join(root, "result.json"));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
