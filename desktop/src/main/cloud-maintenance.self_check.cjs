const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { createDiagnosticLogger } = require("./diagnostics.cjs");
const { createCloudMaintenance } = require("./cloud-maintenance.cjs");
const { verifyManifest, compareVersions } = require("../shared/cloud-contract.cjs");
const { registerCloudMaintenanceIpc } = require("./cloud-maintenance-ipc.cjs");
const { createPreloadApis } = require("./preload-api.cjs");
const { COMPONENTS } = require("../shared/component-contract.cjs");

async function checkReleaseSelection(rootDir, config, manifest, sign, bytes) {
  const baseRoot = path.join(rootDir, "component-base");
  fs.mkdirSync(baseRoot);
  fs.writeFileSync(path.join(baseRoot, "component-base.json"), JSON.stringify({ schema: 2, dataSchema: 1, base: { version: "1.1.0", fingerprint: "0".repeat(64) } }));
  // The full and component pointers advance independently, including across base upgrades.
  for (const componentVersion of ["1.0.9", "1.1.0", "1.1.1", "1.3.0"]) {
    const component = { schema: 2, appId: config.appId, channel: config.channel, platform: "win32", arch: "x64",
      version: componentVersion, sequence: 20, notes: "Component selection fixture", dataSchema: 1,
      base: { version: "1.2.0", fingerprint: "1".repeat(64) }, minBaseVersion: "1.2.0",
      components: Object.fromEntries(COMPONENTS.map(name => [name, { name, sha256: manifest.sha256, treeSha256: manifest.sha256,
        file: `/components/${manifest.sha256}.zip`, size: bytes.length, expandedSize: bytes.length, fileCount: 1 }])) };
    const requests = [];
    const controller = createCloudMaintenance({ rootDir: path.join(rootDir, `selection-${componentVersion}`),
      componentBaseRoot: baseRoot, config, version: "1.1.0", buildId: "selection-check", canInstall: () => true,
      transport: { async request(route, options = {}) {
        requests.push(route);
        if (route.startsWith("/v2/")) return sign(component);
        if (route.startsWith("/v1/")) return sign({ ...manifest, version: "1.2.0", sequence: 20 });
        assert.equal(route, manifest.file);
        fs.writeFileSync(options.destination, bytes); options.onProgress(bytes.length);
        return { size: bytes.length };
      }, close() {} } });
    try {
      await controller.check();
      assert.equal(controller.status().stage, "ready", `Component ${componentVersion} must allow the newer full base`);
      assert.equal((await controller.prepareInstall()).version, "1.2.0");
      assert.ok(requests.includes("/v1/releases/test/latest"));
      assert.ok(requests.includes("/v2/releases/test/latest"));
      assert.equal(controller.status().announcements.length, 2, "Independent protocols may share a sequence without conflict");
      controller.markAnnouncementRead(20);
      assert.equal(controller.status().announcements.find(item => item.id === "1:20").read, true);
      assert.equal(controller.status().announcements.find(item => item.id === "2:20").read, false);
      controller.markAnnouncementRead("2:20");
      assert.equal(controller.status().unreadAnnouncements, 0);
    } finally { controller.stop(); }
  }
}

async function checkAnnouncements(rootDir, config, manifest, sign, bytes) {
  const dir = path.join(rootDir, "announcements");
  let latest = sign({ ...manifest, publishedAt: "2026-09-08T08:30:00.000Z" }), offline = false, downloads = 0;
  const transport = { async request(route, options = {}) {
    if (offline) throw new Error("offline fixture");
    if (route.endsWith("latest")) return latest;
    downloads++; assert.fail("Metadata refresh must not download an installer");
  }, close() {} };
  const create = (extra = {}) => createCloudMaintenance({ rootDir: dir, config, version: manifest.version, buildId: "announcement-check", transport, ...extra });
  let controller = create();
  try {
    await controller.refreshAnnouncements();
    assert.equal(controller.status().announcements[0].notes, manifest.notes, "Already installed versions still have release notes");
    assert.equal(controller.status().announcements[0].publishedAt, "2026-09-08T08:30:00.000Z");
    assert.equal(controller.status().unreadAnnouncements, 1);
    await controller.check();
    assert.equal(controller.status().stage, "current");
    assert.equal(controller.status().announcements[0].notes, manifest.notes);
    controller.markAnnouncementRead(manifest.sequence);
    controller.stop(); controller = create();
    assert.equal(controller.status().announcements[0].read, true, "Read state survives restart");
    offline = true; await controller.refreshAnnouncements();
    assert.equal(controller.status().announcements[0].read, true);
    assert.match(controller.status().announcementError, /本机记录/);
    offline = false;
    latest = sign({ ...manifest, sequence: 11, version: "1.0.2", notes: "第二次更新" });
    await controller.refreshAnnouncements();
    assert.equal(controller.status().announcements[0].publishedAt, "", "Legacy releases do not invent a publication date");
    latest = sign({ ...manifest, sequence: 11, version: "1.0.2", notes: "冲突公告" });
    await controller.refreshAnnouncements();
    assert.equal(controller.status().announcements[0].notes, "第二次更新");
    assert.ok(controller.status().announcementError, "Same-sequence different payload is rejected");
    latest = sign({ ...manifest, sequence: 9, version: "1.0.3" });
    await controller.refreshAnnouncements();
    assert.equal(controller.status().announcements[0].sequence, 11, "Signed rollback is rejected");
    latest = { ...sign({ ...manifest, sequence: 12 }), signature: "invalid" };
    await controller.refreshAnnouncements();
    assert.equal(controller.status().announcements.length, 2, "Invalid signatures cannot enter the cache");
    const rename = fs.renameSync;
    try {
      fs.renameSync = (source, destination) => {
        if (destination === path.join(dir, "cloud-maintenance/state.json")) throw Object.assign(new Error("fixture persistence failure"), { code: "EIO" });
        return rename(source, destination);
      };
      controller.markAnnouncementRead(11);
      assert.equal(controller.status().announcements[0].read, false, "Failed persistence must not mark an announcement read");
      latest = sign({ ...manifest, sequence: 12 });
      await controller.refreshAnnouncements();
      assert.equal(controller.status().announcements[0].sequence, 11, "Failed persistence must not publish the new cache in memory");
    } finally { fs.renameSync = rename; }
    assert.equal(downloads, 0);
  } finally { controller.stop(); }

  const legacyDir = path.join(rootDir, "legacy-pending/cloud-maintenance");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "state.json"), JSON.stringify({ pending: sign(manifest), sequence: manifest.sequence }));
  fs.writeFileSync(path.join(legacyDir, `${manifest.sha256}.exe`), bytes);
  latest = sign(manifest);
  const legacy = createCloudMaintenance({ rootDir: path.dirname(legacyDir), config, version: "1.0.0", buildId: "legacy-check", transport, canInstall: () => true });
  try {
    assert.equal(legacy.status().announcements[0].notes, manifest.notes, "Signed legacy pending notes are available offline after upgrade");
    await legacy.refreshAnnouncements();
    assert.equal((await legacy.prepareInstall()).version, manifest.version, "Announcement refresh preserves the existing pending installer");
    await legacy.check();
    assert.equal(legacy.status().stage, "ready");
    latest = sign({ ...manifest, sequence: 12, version: "1.0.2" });
    await legacy.refreshAnnouncements();
    assert.equal(legacy.status().stage, "idle", "A newer metadata-only release clears the stale ready indicator");
    assert.equal(await legacy.prepareInstall(), null, "A cached older installer cannot bypass the release rollback fence");
    assert.equal(JSON.parse(fs.readFileSync(path.join(legacyDir, "state.json"), "utf8")).pending.payload, sign(manifest).payload, "Old pending evidence remains until a new package is checked");
    assert.equal(downloads, 0);
  } finally { legacy.stop(); }

  let finishDownload, signalDownload;
  const downloading = new Promise((resolve) => { signalDownload = resolve; });
  latest = sign({ ...manifest, sequence: 20 });
  const race = createCloudMaintenance({ rootDir: path.join(rootDir, "download-race"), config, version: "1.0.0", buildId: "race-check", canInstall: () => true,
    transport: { request(route, options = {}) {
      if (route.endsWith("latest")) return Promise.resolve(latest);
      return new Promise((resolve) => {
        finishDownload = () => { fs.writeFileSync(options.destination, bytes); options.onProgress(bytes.length); resolve({ size: bytes.length }); };
        signalDownload();
      });
    }, close() {} }
  });
  try {
    const check = race.check(); await downloading;
    latest = sign({ ...manifest, sequence: 21, version: "1.0.2" });
    await race.refreshAnnouncements(); finishDownload(); await check;
    assert.equal(race.status().announcements[0].sequence, 21);
    assert.equal(race.status().stage, "error", "An older in-flight download cannot be announced as ready after a newer signed release");
    assert.equal(await race.prepareInstall(), null);
    assert.equal(fs.readdirSync(path.join(rootDir, "download-race/cloud-maintenance")).some((file) => file.endsWith(".part")), true, "Verified partial evidence remains resumable without becoming installable");
  } finally { race.stop(); }

  const handlers = new Map(), mainFrame = {}, webContents = { mainFrame, send() {} };
  let refreshes = 0, readSequence;
  const dispose = registerCloudMaintenanceIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, getMainWindow: () => ({ webContents, isDestroyed: () => false }), restart() {},
    controller: { onUpdate: () => () => {}, refreshAnnouncements: () => { refreshes++; return {}; }, markAnnouncementRead: (sequence) => { readSequence = sequence; return {}; } } });
  await assert.rejects(handlers.get("cloud:announcements")({ sender: {}, senderFrame: mainFrame }), /sender_invalid/);
  await assert.rejects(handlers.get("cloud:announcements")({ sender: webContents, senderFrame: {} }), /sender_invalid/);
  await handlers.get("cloud:announcements")({ sender: webContents, senderFrame: mainFrame });
  await handlers.get("cloud:readAnnouncement")({ sender: webContents, senderFrame: mainFrame }, 21);
  assert.equal(refreshes, 1); assert.equal(readSequence, 21); dispose();
  const calls = [];
  const api = createPreloadApis({ invoke: (...args) => { calls.push(args); }, on() {}, removeListener() {} }).cloudMaintenance;
  api.announcements(); api.readAnnouncement(21);
  assert.deepEqual(calls, [["cloud:announcements"], ["cloud:readAnnouncement", 21]]);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-maintenance-check-"));
  assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
  const keys = crypto.generateKeyPairSync("ed25519");
  const config = { enabled: true, appId: "com.aihuoke.desktop.test", channel: "test", signingPublicKey: keys.publicKey };
  const bytes = Buffer.from("test installer bytes; never executed");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const manifest = { schema: 1, appId: config.appId, channel: "test", version: "1.0.1", platform: "win32", arch: "x64", sequence: 10, sha256, size: bytes.length, file: `/artifacts/${sha256}.exe`, notes: "修复测试" };
  const sign = (value) => { const payload = JSON.stringify(value); return { payload, signature: crypto.sign(null, Buffer.from(payload), keys.privateKey).toString("base64") }; };
  let latest = sign(manifest), posts = [], offline = false, launched = 0;
  const transport = { async request(route, options = {}) {
    if (offline) throw new Error("offline");
    if (route.endsWith("latest")) return latest;
    if (route === "/v1/reports") { posts.push(options.body); return { accepted: options.body.entries.map((entry) => entry.id) }; }
    fs.writeFileSync(options.destination, bytes); options.onProgress(bytes.length); return { size: bytes.length };
  }, close() {} };
  const logger = createDiagnosticLogger({ rootDir: dir });
  const controller = createCloudMaintenance({ rootDir: dir, config, version: "1.0.0", buildId: "test-build", logger, transport, canInstall: () => true,
    launch(file, args) { assert.equal(fs.readFileSync(file).equals(bytes), true); assert.deepEqual(args, ["/S", "--force-run"]); launched++; const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit("spawn")); return child; }
  });
  try {
    assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
    assert.throws(() => verifyManifest({ ...latest, payload: latest.payload.replace("1.0.1", "9.0.0") }, config), /signature/);
    assert.throws(() => verifyManifest(sign({ ...manifest, channel: "delivery" }), config), /invalid/);
    assert.throws(() => verifyManifest(sign({ ...manifest, file: "/artifacts/../../bad.exe" }), config), /invalid/);
    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(controller.status().stage, "ready");
    assert.equal(posts.length, 0, "No upload before consent");
    controller.setConsent(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    logger.event("auto_reply", "send.failed", { code: "visual_send_outcome_unknown", message: "private customer", apiKey: ["sk", "PRIVATEKEY123"].join("-"), filePath: "C:/Users/private", receipt_code: "outcome_unknown" }, { level: "error", code: "visual_send_outcome_unknown" });
    await controller.flush();
    const serialized = JSON.stringify(posts);
    assert.ok(serialized.includes("visual_send_outcome_unknown"));
    for (const forbidden of ["private customer", "PRIVATEKEY", "C:/Users", "message_ref", "filePath"]) assert.ok(!serialized.includes(forbidden), forbidden);
    offline = true;
    logger.event("app", "network.failed", {}, { level: "error", code: "network_failed" });
    await controller.flush();
    assert.equal(controller.status().queued, 1, "Failed upload stays queued");
    assert.match(controller.status().uploadError, /重试/);
    assert.equal(await controller.installOnExit(), false, "Ordinary exit never silently starts an installer");
    assert.equal(launched, 0);
    const prepared = await controller.prepareInstall();
    fs.writeFileSync(prepared.file, "tampered");
    await assert.rejects(controller.prepareInstall(), /cloud_download_invalid/);
    assert.equal(await controller.installOnExit(), false);
    assert.equal(launched, 0, "Tampered cached installer cannot execute");
    controller.setConsent(false);
    assert.equal(controller.status().queued, 0);
    offline = false; latest = sign({ ...manifest, sequence: 9, version: "1.0.2" });
    await controller.check();
    assert.equal(controller.status().stage, "error", "Signed but stale release rejected");
    await checkAnnouncements(dir, config, manifest, sign, bytes);
    await checkReleaseSelection(dir, config, manifest, sign, bytes);
    console.log("cloud maintenance: announcement cache/read persistence, metadata-only refresh, signatures, rollback/conflict, download race, legacy pending, IPC, consent and install boundary passed");
  } finally { controller.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
