const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createTouchWorkflow } = require("./touch-workflow.cjs");
const { canContinueTouchResult } = require("./touch-message-sequence.cjs");
const { normalizeTouchLink } = require("./touch-media.cjs");
const { sendWechatImage } = require("../../rpa/active_touch/wechat_image_send.dev.cjs");
const { main: runCli } = require("../../rpa/active_touch/active_touch_cli.cjs");

async function checkTouchMessageSequence() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-touch-sequence-"));
  const contact = { id: "selected", name: "测试客户", nickname: "测试客户", wechatId: "test_customer", wechatAccountId: "test_account", allowed: true };
  const secondContact = { id: "selected-two", name: "第二位测试客户", nickname: "第二位测试客户", wechatId: "test_customer_two", wechatAccountId: "test_account", allowed: true };
  const imageId = "a".repeat(64);
  const calls = [];
  let failImage = true, unknown = false, loginRequired = false, searchUnavailable = false, searchIdentityUnverified = false, atomicMismatch = false, enabled = true, pauseAfterText = false;
  const clock = new Date(2026, 8, 3, 12, 0, 0);
  const config = {
    dataDir: root, now: () => clock, random: () => 0, readContacts: () => [contact, secondContact],
    coordinator: { acquire: () => ({ ok: true, lock: { owner: "test" } }), release() {} }, drivers: {},
    mediaStore: { validateIds: ids => ids, resolve: id => ({ sha256: id, path: "isolated-image.png" }) },
    runStep: (args, options) => runCli(["node", "active_touch_cli.cjs", ...args, "--data-dir", options.dataDir]),
    execute: async (options) => {
      const selected = await options.runStep("select-customer", ["--id", options.contactId]);
      assert.equal(selected.ok, true, JSON.stringify(selected));
      assert.equal(selected.state.selected_customer.id, options.contactId);
      const kind = options.image ? "image" : options.message === "https://example.com/product" ? "link" : "text";
      calls.push({ kind, baseDir: options.baseDir, attemptId: options.attemptId });
      if (kind === "text" && loginRequired) {
        return { ok: false, send_attempted: false, blocked_reason: "wechat_login_required", error: "微信需要重新登录" };
      }
      if (kind === "text" && options.contactId === contact.id && searchUnavailable) {
        return { ok: false, send_attempted: false, blocked_reason: "exact_search_result_not_found", error: "未找到该联系人的精确公开微信号搜索结果" };
      }
      if (kind === "text" && options.contactId === contact.id && searchIdentityUnverified) {
        return { ok: false, send_attempted: false, blocked_reason: "search_result_identity_unverified", error: "搜索结果身份无法唯一确认" };
      }
      if (kind === "text" && options.contactId === contact.id && atomicMismatch) {
        return { ok: false, send_attempted: false, blocked_reason: "atomic_conversation_changed", error: "当前会话身份发生变化" };
      }
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
  assert.equal(workflow.canRetryWorkflowTask(record, payload), true);
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
  assert.equal(workflow.canRetryWorkflowTask(uncertain, payload), false);
  const count = calls.length;
  await createTouchWorkflow(config).runWorkflowStep(uncertain, context);
  assert.equal(calls.length, count, "Unknown image sends never retry after restart");
  assert.equal(workflow.describeUnknownWorkflowTask(uncertain)?.partKind, "image");
  const sentResolution = workflow.resolveUnknownWorkflowTask(uncertain, "sent");
  assert.equal(sentResolution.completed, false, "confirming one multipart segment must retain later unsent segments");
  assert.equal(calls.length, count, "manual confirmation must not invoke the sender");
  assert.throws(() => workflow.resolveUnknownWorkflowTask(uncertain, "sent"), /没有待确认/, "a resolved segment cannot be handled twice");
  failImage = false; unknown = false;
  result = await createTouchWorkflow(config).runWorkflowStep(uncertain, context);
  assert.equal(result.status, "completed");
  assert.deepEqual(calls.slice(count).map(call => call.kind), ["link"], "only the segment after the confirmed image may run");

  failImage = true; unknown = true;
  const notSent = { ...record, id: crypto.randomUUID() };
  result = await createTouchWorkflow(config).runWorkflowStep(notSent, context);
  assert.equal(result.status, "needs_attention");
  const notSentDir = path.join(root, "workflow-tasks", crypto.createHash("sha256").update(notSent.id).digest("hex"));
  const beforeNotSent = JSON.parse(fs.readFileSync(path.join(notSentDir, "touch_task.json"), "utf8"));
  const beforeNotSentCalls = calls.length;
  const retryResolution = workflow.resolveUnknownWorkflowTask(notSent, "not_sent");
  const afterNotSent = JSON.parse(fs.readFileSync(path.join(notSentDir, "touch_task.json"), "utf8"));
  assert.equal(retryResolution.completed, false);
  assert.notEqual(afterNotSent.results[0].request_id, beforeNotSent.results[0].request_id, "confirmed-not-sent must rotate the durable send identity");
  assert.equal(afterNotSent.results[0].message_parts[0].status, "sent_verified", "confirmed-not-sent must retain already verified segments");
  assert.equal(afterNotSent.results[0].message_parts[1].status, "not_attempted");
  assert.equal(afterNotSent.results[0].message_parts[2].status, "pending");
  assert.equal(afterNotSent.results[0].manual_resolution_history.at(-1).resolution, "not_sent");
  assert.notEqual(afterNotSent.results[0].manual_resolution_history.at(-1).next_attempt_id, afterNotSent.results[0].manual_resolution_history.at(-1).previous_attempt_id);
  assert.equal(calls.length, beforeNotSentCalls, "restoring retry eligibility must not execute it");
  failImage = false; unknown = false;
  result = await createTouchWorkflow(config).runWorkflowStep(notSent, context);
  assert.equal(result.status, "completed");
  assert.deepEqual(calls.slice(beforeNotSentCalls).map(call => call.kind), ["image", "link"], "a later explicit run retries only the confirmed-unsent segment and its successors");

  failImage = true; unknown = true;
  const skippedUnknownPayload = workflow.prepareWorkflowTask({ script: "未知结果跳过联系人", contactIds: [contact.id, secondContact.id], imageIds: [imageId] });
  const skippedUnknown = { ...record, id: crypto.randomUUID(), payload: skippedUnknownPayload };
  result = await createTouchWorkflow(config).runWorkflowStep(skippedUnknown, context);
  assert.equal(result.status, "needs_attention");
  const beforeSkipCalls = calls.length;
  const skipResolution = workflow.resolveUnknownWorkflowTask(skippedUnknown, "skip");
  assert.deepEqual(skipResolution.progress, { done: 1, total: 2 });
  assert.equal(calls.length, beforeSkipCalls, "skipping an uncertain contact must not execute the next contact");
  failImage = false; unknown = false;
  result = await createTouchWorkflow(config).runWorkflowStep(skippedUnknown, context);
  assert.equal(result.status, "completed");
  assert.deepEqual(calls.slice(beforeSkipCalls).map(call => call.kind), ["text", "image"], "the next explicit run starts at the next contact");

  const legacyCalls = [];
  const legacyConfig = { ...config, execute: async (options) => {
    legacyCalls.push(options.attemptId);
    options.onTransition("clicked");
    return { ok: false, send_attempted: true, blocked_reason: "input_draft_read_failed" };
  } };
  for (const resolution of ["sent", "not_sent", "skip"]) {
    const legacyWorkflow = createTouchWorkflow(legacyConfig);
    const legacyPayload = legacyWorkflow.prepareWorkflowTask({ script: "1.1.20 单文字未知结果", contactIds: [contact.id] });
    const legacyRecord = { ...record, id: crypto.randomUUID(), payload: legacyPayload };
    const legacyResult = await legacyWorkflow.runWorkflowStep(legacyRecord, context);
    assert.equal(legacyResult.status, "needs_attention");
    const legacyDir = path.join(root, "workflow-tasks", crypto.createHash("sha256").update(legacyRecord.id).digest("hex"));
    const legacyStateFile = path.join(legacyDir, "touch_task.json");
    const legacyState = JSON.parse(fs.readFileSync(legacyStateFile, "utf8"));
    legacyState.source_build_id = "20260912T0824Z";
    delete legacyState.results[0].message_parts;
    delete legacyState.results[0].awaiting_resolution;
    fs.writeFileSync(legacyStateFile, JSON.stringify(legacyState, null, 2));
    const upgradedWorkflow = createTouchWorkflow(legacyConfig);
    assert.equal(upgradedWorkflow.describeUnknownWorkflowTask(legacyRecord)?.partKind, "text", `1.1.20 ${resolution} fixture must remain actionable`);
    const beforeLegacyResolution = legacyCalls.length;
    const resolutionId = crypto.randomUUID();
    const legacyOutcome = upgradedWorkflow.resolveUnknownWorkflowTask(legacyRecord, resolution, resolutionId);
    const resolvedLegacyState = JSON.parse(fs.readFileSync(legacyStateFile, "utf8"));
    assert.equal(legacyCalls.length, beforeLegacyResolution, "legacy manual resolution must not invoke the sender");
    assert.equal(resolvedLegacyState.results[0].awaiting_resolution, false, "manual resolution must clear legacy awaiting-resolution state");
    assert.equal(resolvedLegacyState.results[0].manual_resolution_history.at(-1).resolution_id, resolutionId);
    assert.equal(legacyOutcome.resolutionId, resolutionId);
    if (resolution === "not_sent") {
      assert.equal(legacyOutcome.completed, false);
      assert.notEqual(resolvedLegacyState.results[0].request_id, legacyState.results[0].request_id);
    } else assert.equal(legacyOutcome.completed, true);
    assert.throws(() => upgradedWorkflow.resolveUnknownWorkflowTask(legacyRecord, resolution), /没有待确认/, "a legacy decision cannot be applied twice by the user");
  }

  failImage = false; unknown = false; pauseAfterText = true;
  const paused = { ...record, id: crypto.randomUUID() };
  result = await workflow.runWorkflowStep(paused, context);
  assert.equal(result.status, "pending");
  enabled = true; pauseAfterText = false;
  const pausedCount = calls.length;
  result = await createTouchWorkflow(config).runWorkflowStep(paused, context);
  assert.equal(result.status, "completed");
  assert.deepEqual(calls.slice(pausedCount).map(call => call.kind), ["image", "link"]);

  const intervalPayload = createTouchWorkflow(config).prepareWorkflowTask({ script: "这是一条间隔测试话术", contactIds: [contact.id, secondContact.id] });
  const intervalRecord = { id: crypto.randomUUID(), payload: intervalPayload, progress: { done: 0 }, status: "running" };
  result = await createTouchWorkflow(config).runWorkflowStep(intervalRecord, context);
  assert.equal(result.status, "pending");
  assert.equal(result.retryAfterMs, 8000, "a verified contact must expose its exact safety interval to the unified scheduler");
  assert.equal(result.waitingReason, "touch_safety_interval");
  assert.equal(result.result.nextEligibleAt, new Date(clock.getTime() + 8000).toISOString());

  loginRequired = true;
  const textWorkflow = createTouchWorkflow(config);
  const textPayload = textWorkflow.prepareWorkflowTask({ script: "纯文字登录恢复测试", contactIds: [contact.id] });
  const textRecord = { id: crypto.randomUUID(), payload: textPayload, progress: { done: 0 }, status: "running" };
  const beforeLoginInterruption = calls.length;
  result = await textWorkflow.runWorkflowStep(textRecord, context);
  assert.equal(result.status, "needs_attention");
  assert.equal(result.result.deliveryStatus, "not_attempted");
  assert.equal(calls.length, beforeLoginInterruption + 1);
  assert.equal(textWorkflow.canRetryWorkflowTask(textRecord, textPayload), true, "a text-only pre-send login interruption must remain resumable");
  const textTaskDir = path.join(root, "workflow-tasks", crypto.createHash("sha256").update(textRecord.id).digest("hex"));
  const persistedTextTask = JSON.parse(fs.readFileSync(path.join(textTaskDir, "touch_task.json"), "utf8"));
  assert.equal(persistedTextTask.results[0].send_attempted, false, "a safe login block must persist an explicit not-attempted receipt");
  const safeTextRow = { status: "generated", retry_blocked: false, send_attempted: false };
  assert.equal(canContinueTouchResult(safeTextRow, false), true);
  assert.equal(canContinueTouchResult({ ...safeTextRow, retry_blocked: "false" }, false), false, "non-boolean retry gates fail closed");
  assert.equal(canContinueTouchResult({ ...safeTextRow, message_parts: null }, false), false, "malformed text sequence state fails closed");
  assert.equal(canContinueTouchResult(safeTextRow, true), false, "missing multipart ledger fails closed");
  loginRequired = false;
  const beforeTextResume = calls.length;
  result = await createTouchWorkflow(config).runWorkflowStep(textRecord, context);
  assert.equal(result.status, "completed");
  assert.equal(calls.length, beforeTextResume + 1, "resuming a text-only pre-send interruption sends exactly once");

  searchUnavailable = true;
  const skipWorkflow = createTouchWorkflow(config);
  const skipPayload = skipWorkflow.prepareWorkflowTask({ script: "搜索结果跳过测试", contactIds: [contact.id, secondContact.id] });
  const skipRecord = { id: crypto.randomUUID(), payload: skipPayload, progress: { done: 0 }, status: "running" };
  result = await skipWorkflow.runWorkflowStep(skipRecord, context);
  assert.equal(result.status, "pending", "明确的搜索无结果应跳过当前联系人并继续任务");
  assert.equal(result.progress.done, 1);
  assert.equal(result.result.skipped, true);
  const skipTaskDir = path.join(root, "workflow-tasks", crypto.createHash("sha256").update(skipRecord.id).digest("hex"));
  const skippedTask = JSON.parse(fs.readFileSync(path.join(skipTaskDir, "touch_task.json"), "utf8"));
  assert.equal(skippedTask.results[0].status, "identity_skipped");
  searchUnavailable = false;
  result = await createTouchWorkflow(config).runWorkflowStep(skipRecord, context);
  assert.equal(result.status, "completed", "跳过无结果联系人后仍应完成后续联系人");

  searchIdentityUnverified = true;
  const unverifiedWorkflow = createTouchWorkflow(config);
  const unverifiedPayload = unverifiedWorkflow.prepareWorkflowTask({ script: "搜索身份不明暂停测试", contactIds: [contact.id, secondContact.id] });
  const unverifiedRecord = { id: crypto.randomUUID(), payload: unverifiedPayload, progress: { done: 0 }, status: "running" };
  result = await unverifiedWorkflow.runWorkflowStep(unverifiedRecord, context);
  assert.equal(result.status, "needs_attention", "空 UIA 且 OCR 不可用时必须暂停，不能连续跳过联系人");
  assert.equal(result.progress.done, 0);
  const unverifiedTaskDir = path.join(root, "workflow-tasks", crypto.createHash("sha256").update(unverifiedRecord.id).digest("hex"));
  const unverifiedTask = JSON.parse(fs.readFileSync(path.join(unverifiedTaskDir, "touch_task.json"), "utf8"));
  assert.equal(unverifiedTask.results[0].status, "generated");
  assert.equal(unverifiedTask.results[1].status, "pending", "后续联系人不能被连带跳过");
  searchIdentityUnverified = false;

  atomicMismatch = true;
  const atomicWorkflow = createTouchWorkflow(config);
  const atomicPayload = atomicWorkflow.prepareWorkflowTask({ script: "会话变化暂停测试", contactIds: [contact.id] });
  const atomicRecord = { id: crypto.randomUUID(), payload: atomicPayload, progress: { done: 0 }, status: "running" };
  result = await atomicWorkflow.runWorkflowStep(atomicRecord, context);
  assert.equal(result.status, "needs_attention", "会话身份变化不能被误判为联系人不存在");
  assert.equal(result.result.deliveryStatus, "not_attempted");
  atomicMismatch = false;

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
