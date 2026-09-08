const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createFeedbackController } = require("./feedback-controller.cjs");
const { registerFeedbackIpc } = require("./feedback-ipc.cjs");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-feedback-check-"));
  const encryptionKey = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, nonce);
      const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), data]);
    },
    decryptString(value) {
      const cipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString("utf8");
    }
  };
  let requests = [], online = false, now = Date.now(), receiptStatus = "pending";
  const transport = { close() {}, async request(route, { body }) {
    requests.push({ route, body: structuredClone(body) });
    if (!online) throw new Error("ECONNRESET");
    const receipt = (id) => ({ id, status: receiptStatus, receivedAt: 1700000000, updatedAt: 1700000000 + (receiptStatus === "resolved" ? 1 : 0) });
    return route.endsWith("/status") ? { items: body.items.map((item) => receipt(item.id)) } : receipt(body.id);
  } };
  const options = { rootDir: root, config: { enabled: true, appId: "com.aihuoke.desktop.test", channel: "test" },
    version: "1.0.0", buildId: "test", safeStorage, transport, clock: () => now,
    logger: { readRecent: () => [{ ts: new Date(now).toISOString(), run_id: crypto.randomUUID(), seq: 1, level: "error", module: "content_engine", event: "failed", code: "quota", message: "must-not-upload", details: { password: "do-not-upload", error_code: "quota" } }] } };
  let controller = createFeedbackController(options);
  try {
    const draft = { ...controller.status().draft, text: "制作失败，想知道原因", context: { module: "content_engine", taskId: "task_1" } };
    controller.saveDraft(draft);
    await controller.submit(draft); await controller.flush();
    assert.equal(controller.status().items[0].delivery, "queued");
    assert.equal(controller.status().items[0].status, null, "No receipt must not display server processing status");
    await controller.submit(draft); await controller.flush();
    assert.equal(controller.status().items.length, 1, "Double submission keeps one immutable ID");
    assert.equal(requests.length, 1, "Double submission must respect the existing retry backoff");
    const sent = requests[0].body;
    assert.equal(sent.diagnostics.length, 1);
    assert(!JSON.stringify(sent).includes("must-not-upload"));
    assert(!JSON.stringify(sent).includes("do-not-upload"));
    assert(!JSON.stringify(controller.status()).includes(sent.receiptToken), "Receipt token never enters renderer state");
    assert(!fs.readFileSync(path.join(root, "feedback", "state.json"), "utf8").includes(sent.receiptToken), "Receipt token is encrypted on disk");
    await assert.rejects(controller.submit({ ...draft, text: "changed" }), /已经提交/);
    controller.stop(); now += 60_000; online = true;
    controller = createFeedbackController(options);
    await controller.flush();
    assert.equal(controller.status().items[0].delivery, "sent");
    assert.deepEqual(requests[1].body, sent, "After restart the original snapshot and secret must be retried unchanged");
    receiptStatus = "resolved"; await controller.refresh();
    assert.equal(controller.status().items[0].status, "resolved");
    const request = transport.request;
    transport.request = async () => ({ items: [{ id: draft.id, status: "pending", receivedAt: 1700000000, updatedAt: 1700000001 }] });
    await controller.refresh();
    assert.equal(controller.status().items[0].status, "resolved", "Conflicting receipts with the same timestamp cannot regress status");
    assert(controller.status().refreshError);
    transport.request = request;
    controller.status().items[0].context.module = "mutated";
    let listenerModule;
    controller.onUpdate((view) => { view.items.at(-1).context.module = "mutated"; throw new Error("listener_failure"); });
    controller.onUpdate((view) => { listenerModule = view.items.at(-1).context.module; });
    await controller.refresh();
    assert.equal(listenerModule, "content_engine", "Listeners and callers cannot modify immutable payloads or another listener's view");
    const textOnly = { ...controller.status().draft, text: "希望操作更简单", includeDiagnostics: false };
    await controller.submit(textOnly); await controller.flush();
    assert.equal(requests.at(-1).body.diagnostics.length, 0, "Opting out sends no diagnostic entries");
    const failedDraft = { ...controller.status().draft, text: "下次再试" };
    transport.request = async () => { throw new Error("cloud_http_404"); };
    await controller.submit(failedDraft); await controller.flush();
    assert.equal(controller.status().items[0].delivery, "failed", "Undeployed service must stop automatic retries");
    assert.equal(controller.status().items.length, 3, "Previous feedback and processing states remain retained");
    const stale = controller.status().draft;
    controller.saveDraft({ ...stale, text: "草稿" });
    controller.saveDraft(draft);
    assert.equal(controller.status().draft.text, "草稿", "Delayed old draft save must not resurrect submitted text");
    const faultRoot = path.join(root, "storage-faults");
    let faultRequests = [], failAck = false, failRenameAt = 0;
    const rename = fs.renameSync;
    const storageError = () => Object.assign(new Error("EIO: C:\\private\\feedback\\state.json"), { code: "EIO" });
    fs.renameSync = (...args) => { if (failRenameAt > 0 && --failRenameAt === 0) throw storageError(); return rename(...args); };
    const faults = createFeedbackController({ ...options, rootDir: faultRoot, transport: { close() {}, async request(route, { body }) {
      faultRequests.push(structuredClone(body));
      if (failAck) { failAck = false; failRenameAt = 1; }
      return { id: body.id, status: "pending", receivedAt: 1700000000, updatedAt: 1700000000 };
    } } });
    try {
      const pending = { ...faults.status().draft, text: "必须先持久保存" };
      failRenameAt = 1;
      assert.throws(() => faults.saveDraft(pending), /EIO/);
      assert.equal(faults.status().draft.text, "", "Failed draft save does not claim an in-memory success");
      failRenameAt = 2;
      await assert.rejects(faults.submit(pending), /EIO/);
      assert.equal(faults.status().draft.text, pending.text);
      assert.equal(faults.status().items.length, 0, "Failed queue admission preserves the draft and cannot leak into later sends");
      assert.equal(faultRequests.length, 0);
      failAck = true;
      await faults.submit(pending); await faults.flush().catch(() => {});
      assert.equal(faults.status().items[0].delivery, "sending");
      now += 60_000; await faults.flush();
      assert.equal(faults.status().items[0].delivery, "sent", "Acknowledgement write failure recovers without restarting");
      assert.deepEqual(faultRequests[1], faultRequests[0], "A lost durable acknowledgement retries the exact ID, payload and token");
      const handlers = new Map(), webContents = { mainFrame: {} };
      registerFeedbackIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        controller: { ...faults, saveDraft() { throw storageError(); } }, getMainWindow: () => ({ webContents }) });
      const result = await handlers.get("feedback:saveDraft")({ sender: webContents, senderFrame: webContents.mainFrame }, {});
      assert.equal(result.ok, false);
      assert(!result.error.includes("private"), "Filesystem errors must not expose local paths to the renderer");
    } finally { faults.stop(); fs.renameSync = rename; }
    console.log("feedback self-check passed: immutable retries, private receipts, opt-out, restart, status ordering and atomic persistence failures");
  } finally { controller.stop(); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
