const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { createDiagnosticLogger } = require("./diagnostics.cjs");
const { createCloudMaintenance } = require("./cloud-maintenance.cjs");
const { verifyManifest, compareVersions } = require("../shared/cloud-contract.cjs");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-maintenance-check-"));
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
    logger.event("auto_reply", "send.failed", { code: "visual_send_outcome_unknown", message: "private customer", apiKey: "sk-PRIVATEKEY123", filePath: "C:/Users/private", receipt_code: "outcome_unknown" }, { level: "error", code: "visual_send_outcome_unknown" });
    await controller.flush();
    const serialized = JSON.stringify(posts);
    assert.ok(serialized.includes("visual_send_outcome_unknown"));
    for (const forbidden of ["private customer", "PRIVATEKEY", "C:/Users", "message_ref", "filePath"]) assert.ok(!serialized.includes(forbidden), forbidden);
    offline = true;
    logger.event("app", "network.failed", {}, { level: "error", code: "network_failed" });
    await controller.flush();
    assert.equal(controller.status().queued, 1, "Failed upload stays queued");
    assert.match(controller.status().uploadError, /重试/);
    assert.equal(await controller.installOnExit(), true);
    assert.equal(launched, 1);
    const prepared = await controller.prepareInstall();
    fs.writeFileSync(prepared.file, "tampered");
    await assert.rejects(controller.prepareInstall(), /cloud_download_invalid/);
    assert.equal(await controller.installOnExit(), false);
    assert.equal(launched, 1, "Tampered cached installer cannot execute");
    controller.setConsent(false);
    assert.equal(controller.status().queued, 0);
    offline = false; latest = sign({ ...manifest, sequence: 9, version: "1.0.2" });
    await controller.check();
    assert.equal(controller.status().stage, "error", "Signed but stale release rejected");
    console.log("cloud maintenance: signatures, cache integrity, consent, redaction, offline queue and install boundary passed");
  } finally { controller.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
