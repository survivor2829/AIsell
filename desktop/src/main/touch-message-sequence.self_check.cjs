const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createTouchWorkflow } = require("./touch-workflow.cjs");
const { normalizeTouchLink } = require("./touch-media.cjs");
const { sendWechatImage } = require("../../rpa/active_touch/wechat_image_send.dev.cjs");
const { main: runCli } = require("../../rpa/active_touch/active_touch_cli.cjs");

async function checkTouchMessageSequence() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-touch-sequence-"));
  const contact = { id: "selected", name: "测试客户", nickname: "测试客户", wechatId: "test_customer", wechatAccountId: "test_account", allowed: true };
  const imageId = "a".repeat(64);
  const calls = [];
  let failImage = true, unknown = false, enabled = true, pauseAfterText = false;
  const config = {
    dataDir: root, readContacts: () => [contact],
    coordinator: { acquire: () => ({ ok: true, lock: { owner: "test" } }), release() {} }, drivers: {},
    mediaStore: { validateIds: ids => ids, resolve: id => ({ sha256: id, path: "isolated-image.png" }) },
    runStep: (args, options) => runCli(["node", "active_touch_cli.cjs", ...args, "--data-dir", options.dataDir]),
    execute: async (options) => {
      const selected = await options.runStep("select-customer", ["--id", contact.id]);
      assert.equal(selected.ok, true, JSON.stringify(selected));
      assert.equal(selected.state.selected_customer.id, contact.id);
      const kind = options.image ? "image" : options.message === "https://example.com/product" ? "link" : "text";
      calls.push({ kind, baseDir: options.baseDir, attemptId: options.attemptId });
      if (kind === "image" && failImage) {
        if (unknown) options.onTransition("prepared");
        return { ok: false, send_attempted: unknown ? true : false, blocked_reason: "simulated_image_failure" };
      }
      options.onTransition("sent_verified");
      if (kind === "text" && pauseAfterText) enabled = false;
      return { ok: true, state: { real_send_status: "sent_verified" } };
    }
  };
  let workflow = createTouchWorkflow(config);
  const payload = workflow.prepareWorkflowTask({ script: "{称呼}，这是产品介绍。", contactIds: [contact.id], imageIds: [imageId], link: "https://example.com/product" });
  const record = { id: crypto.randomUUID(), payload, progress: { done: 0 }, status: "running" };
  const context = { isEnabled: () => enabled };
  let result = await workflow.runWorkflowStep(record, context);
  assert.equal(result.status, "needs_attention");
  assert.equal(result.progress.done, 0, "A sent text must not complete a contact with an unsent image");
  assert.equal(workflow.canRetryWorkflowTask(record), true);
  assert.deepEqual(calls.map(call => call.kind), ["text", "image"]);
  failImage = false;
  workflow = createTouchWorkflow(config);
  result = await workflow.runWorkflowStep(record, context);
  assert.equal(result.status, "completed");
  assert.deepEqual(calls.map(call => call.kind), ["text", "image", "image", "link"], "Restart resumes at the unsent image without repeating text");
  assert.equal(calls[1].baseDir, calls[2].baseDir, "Retries retain the same part transaction");
  assert.equal(calls[1].attemptId, calls[2].attemptId);
  assert.notEqual(calls[0].baseDir, calls[3].baseDir, "Text and link receipts must be isolated");
  await workflow.runWorkflowStep(record, context);
  assert.equal(calls.length, 4, "Completed contacts are not sent again");
  assert.equal((await workflow.runWorkflowStep({ ...record, payload: { ...payload, link: "https://example.com/changed" } }, context)).status, "needs_attention");

  failImage = true; unknown = true;
  const uncertain = { ...record, id: crypto.randomUUID() };
  result = await workflow.runWorkflowStep(uncertain, context);
  assert.equal(result.status, "needs_attention");
  assert.equal(workflow.canRetryWorkflowTask(uncertain), false);
  const count = calls.length;
  await createTouchWorkflow(config).runWorkflowStep(uncertain, context);
  assert.equal(calls.length, count, "Unknown image sends never retry after restart");

  failImage = false; unknown = false; pauseAfterText = true;
  const paused = { ...record, id: crypto.randomUUID() };
  result = await workflow.runWorkflowStep(paused, context);
  assert.equal(result.status, "pending");
  enabled = true; pauseAfterText = false;
  const pausedCount = calls.length;
  result = await createTouchWorkflow(config).runWorkflowStep(paused, context);
  assert.equal(result.status, "completed");
  assert.deepEqual(calls.slice(pausedCount).map(call => call.kind), ["image", "link"]);
  assert.throws(() => normalizeTouchLink("javascript:alert(1)"));
  assert.equal(normalizeTouchLink("https://example.com/product"), "https://example.com/product");

  const imageBytes = Buffer.from("isolated image transport fixture");
  const imagePath = path.join(root, "image-fixture.png");
  fs.writeFileSync(imagePath, imageBytes);
  let clicks = 0;
  const imageOptions = { baseDir: path.join(root, "receipt"), attemptId: "one-image", context: {},
    image: { path: imagePath, sha256: crypto.createHash("sha256").update(imageBytes).digest("hex") },
    runner: async () => { clicks++; return { ok: true, sendAttempted: true, draftVerified: true, conversationVerified: true }; } };
  assert.equal((await sendWechatImage(imageOptions)).ok, true);
  assert.equal((await sendWechatImage(imageOptions)).ok, true);
  assert.equal(clicks, 1, "An image receipt prevents a second native send");
  const uncertainImage = { ...imageOptions, baseDir: path.join(root, "uncertain-receipt"), runner: async () => { clicks++; return { ok: false, reason: "powershell_timeout" }; } };
  assert.equal((await sendWechatImage(uncertainImage)).send_attempted, null);
  const afterTimeout = clicks;
  await sendWechatImage(uncertainImage);
  assert.equal(clicks, afterTimeout, "A terminated native sender remains quarantined by its durable receipt");
}

module.exports = { checkTouchMessageSequence };
if (require.main === module) checkTouchMessageSequence().then(() => process.stdout.write("Touch sequence checks passed: order, restart, partial failure, pause, unknown outcome and image receipts.\n")).catch(error => { console.error(error); process.exitCode = 1; });
