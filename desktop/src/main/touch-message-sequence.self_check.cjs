const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createTouchWorkflow } = require("./touch-workflow.cjs");
const { canContinueTouchResult } = require("./touch-message-sequence.cjs");
const { normalizeTouchLink } = require("./touch-media.cjs");
const { IMAGE_SEND_SCRIPT, sendWechatImage } = require("../../rpa/active_touch/wechat_image_send.dev.cjs");
const { main: runCli } = require("../../rpa/active_touch/active_touch_cli.cjs");

async function checkTouchMessageSequence() {
  assert.match(IMAGE_SEND_SCRIPT, /if \(-not \$existingDraft\.empty\)[\s\S]*Image-Keys "\^a" \$mainWindow[\s\S]*Image-Keys "\{BACKSPACE\}" \$mainWindow[\s\S]*Read-ImageDraft \$mainWindow\)\.empty[\s\S]*image_existing_draft_clear_failed/u,
    "a verified image composer must replace and then prove removal of any stale draft");
  assert.match(IMAGE_SEND_SCRIPT, /function Invoke-ImageClipboardWrite[\s\S]*hresult_800401D0[\s\S]*InnerException[\s\S]*attempt -eq 5[\s\S]*80 \* \$attempt/u,
    "transient clipboard contention must inspect wrapped exceptions and retry with bounded backoff");
  assert.match(IMAGE_SEND_SCRIPT, /Invoke-ImageClipboardWrite "draft_sentinel_write"[\s\S]*Invoke-ImageClipboardWrite "image_write"/u,
    "both draft probing and image installation must use the bounded clipboard retry");
  assert.match(IMAGE_SEND_SCRIPT, /function Read-ImageDraft[\s\S]*for \(\$copyAttempt = 1; \$copyAttempt -le 5; \$copyAttempt\+\+\)[\s\S]*\$beforeCopySequence = \[Win32WechatImage\]::GetClipboardSequenceNumber\(\)[\s\S]*80 \* \$copyAttempt/u,
    "image draft verification must wait and retry when WeChat publishes clipboard formats asynchronously");
  assert.match(IMAGE_SEND_SCRIPT, /function Invoke-ImageClipboardRead[\s\S]*hresult_800401D0[\s\S]*40 \* \$readAttempt/u,
    "clipboard reads must recover when another Windows component briefly owns the clipboard");
  assert.match(IMAGE_SEND_SCRIPT, /imageStageBudgets[\s\S]*sentinel_write = 15000[\s\S]*image_load = 60000[\s\S]*clipboard_bitmap = 45000[\s\S]*paste = 30000[\s\S]*read_back = 20000[\s\S]*click_send = 30000[\s\S]*post_confirm = 30000/u,
    "image sending must expose bounded per-stage budgets");
  assert.match(IMAGE_SEND_SCRIPT, /WriteLine\("image_progress:" \+ \$payload\)/u,
    "image sending must persist fixed-token stage progress diagnostics");
  assert.match(IMAGE_SEND_SCRIPT, /imageLeaseSettleIntervalMs = 30[\s\S]*imageLeaseSettleSamples = 2[\s\S]*imageLeaseSettleTimeoutMs = 250/u,
    "image lease settling must use fixed documented bounds");
  assert.match(IMAGE_SEND_SCRIPT, /image_send_stage:script_started[\s\S]*image_preload:observation_start[\s\S]*image_preload:image_add_type_start/u,
    "image script must emit startup and preload markers");
  assert.match(IMAGE_SEND_SCRIPT, /imageClipboardWriteJoinTimeoutMs = 5000[\s\S]*image_clipboard_write_timeout/u,
    "clipboard writes must have fixed timeout budget");
  assert.match(IMAGE_SEND_SCRIPT, /Assert-ImageWindowIdentity \$window[\s\S]*\$copySequence/u,
    "read-back polling must avoid lease assertions");
  assert.match(IMAGE_SEND_SCRIPT, /script_line = \$scriptLine[\s\S]*source_file[\s\S]*source_line = \$sourceLine/u,
    "image failures must include script/source line mapping");
  assert.doesNotMatch(IMAGE_SEND_SCRIPT, /TickCount64/u,
    "PowerShell image scripts must not use .NET Core-only TickCount64");
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../shared/wechat-rule-catalog.json"), "utf8"));
  const literalReasons = [...IMAGE_SEND_SCRIPT.matchAll(/throw "(image_[a-z0-9_]+)"/g)].map((match) => match[1]);
  const classifiedReasons = new Set(catalog.filter((entry) => entry?.file === "desktop/rpa/active_touch/wechat_image_send.dev.cjs" && typeof entry.reason === "string").map((entry) => entry.reason));
  for (const reason of literalReasons) assert.equal(classifiedReasons.has(reason), true, `${reason} must be classified in wechat-rule-catalog`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-touch-sequence-"));
  require("./diagnostics.cjs").configureDiagnostics({ rootDir: root });
  const contact = { id: "selected", name: "测试客户", nickname: "测试客户", wechatId: "test_customer", wechatAccountId: "test_account", allowed: true };
  const secondContact = { id: "selected-two", name: "第二位测试客户", nickname: "第二位测试客户", wechatId: "test_customer_two", wechatAccountId: "test_account", allowed: true };
  const imageId = "a".repeat(64);
  const calls = [];
  let failImage = true, unknown = false, loginRequired = false, searchUnavailable = false, searchIdentityUnverified = false, networkLookupMisclick = false, externalInputBlocks = 0, recoverableFailures = 0, atomicMismatch = false, enabled = true, pauseAfterText = false;
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
      if (kind === "text" && options.contactId === contact.id && networkLookupMisclick) {
        return {
          ok: false,
          send_attempted: false,
          blocked_reason: "wechat_search_network_lookup_misclick",
          error: "误点网络查找入口，已关闭资料弹窗",
          landing_recovered: true,
          poisoned_candidate: { fingerprint: "huatengcangku-fixture", mode: "exact_wechat_id_local_visual" }
        };
      }
      if (kind === "text" && externalInputBlocks > 0) {
        externalInputBlocks -= 1;
        return { ok: false, send_attempted: false, blocked_reason: "wechat_external_input_detected", action: "click-search-result-dry-run", error: "检测到人工输入" };
      }
      if (kind === "text" && recoverableFailures > 0) {
        recoverableFailures -= 1;
        return { ok: false, send_attempted: false, blocked_reason: "input_draft_read_failed", error: "草稿读取失败" };
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
  const skippedUnknownDir = path.join(root, "workflow-tasks", crypto.createHash("sha256").update(skippedUnknown.id).digest("hex"));
  const skippedUnknownTask = JSON.parse(fs.readFileSync(path.join(skippedUnknownDir, "touch_task.json"), "utf8"));
  assert.equal(skippedUnknownTask.results[0].skip_record.reasonCode, "outcome_unknown");
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
  assert.equal(result.status, "pending");
  assert.equal(result.waitingReason, "wechat_environment_recovery");
  assert.equal(result.retryAfterMs, 30000);
  assert.equal(result.result.deliveryStatus, "not_attempted");
  assert.equal(calls.length, beforeLoginInterruption + 1);
  assert.equal(textWorkflow.canRetryWorkflowTask(textRecord, textPayload), false, "an environment wait stays scheduled and needs no manual retry action");
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

  loginRequired = true;
  const cappedWorkflow = createTouchWorkflow(config);
  const cappedPayload = cappedWorkflow.prepareWorkflowTask({ script: "环境恢复上限测试", contactIds: [contact.id] });
  const cappedRecord = { id: crypto.randomUUID(), payload: cappedPayload, progress: { done: 0 }, status: "running" };
  result = await cappedWorkflow.runWorkflowStep(cappedRecord, context);
  assert.equal(result.waitingReason, "wechat_environment_recovery");
  clock.setTime(clock.getTime() + 10 * 60_000);
  result = await cappedWorkflow.runWorkflowStep(cappedRecord, context);
  assert.equal(result.status, "completed", "environment recovery must stop after ten minutes");
  assert.equal(result.result.skipped, true);
  const cappedTaskDir = path.join(root, "workflow-tasks", crypto.createHash("sha256").update(cappedRecord.id).digest("hex"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(cappedTaskDir, "touch_task.json"), "utf8")).results[0].status, "pre_send_skipped");
  loginRequired = false;

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
  assert.deepEqual(Object.keys(skippedTask.results[0].skip_record), ["contactId", "displayName", "index", "reasonCode", "blockedReason", "at", "traceId"]);
  assert.equal(skippedTask.results[0].skip_record.reasonCode, "exact_search_result_not_found");
  searchUnavailable = false;
  result = await createTouchWorkflow(config).runWorkflowStep(skipRecord, context);
  assert.equal(result.status, "completed", "跳过无结果联系人后仍应完成后续联系人");

  searchIdentityUnverified = true;
  const unverifiedWorkflow = createTouchWorkflow(config);
  const unverifiedPayload = unverifiedWorkflow.prepareWorkflowTask({ script: "搜索身份不明隔离测试", contactIds: [contact.id, secondContact.id] });
  const unverifiedRecord = { id: crypto.randomUUID(), payload: unverifiedPayload, progress: { done: 0 }, status: "running" };
  result = await unverifiedWorkflow.runWorkflowStep(unverifiedRecord, context);
  assert.equal(result.status, "pending", "搜索结果身份未确认且明确未发送时应先恢复重试");
  assert.equal(result.progress.done, 0, "第一次 OCR 身份波动不能立即跳过联系人");
  assert.equal(result.waitingReason, "wechat_identity_recovery");
  result = await unverifiedWorkflow.runWorkflowStep(unverifiedRecord, context);
  assert.equal(result.progress.done, 0, "第二次 OCR 身份波动仍应保留当前联系人做最后一次恢复");
  result = await unverifiedWorkflow.runWorkflowStep(unverifiedRecord, context);
  assert.equal(result.status, "pending", "有界恢复仍失败后才隔离当前联系人并继续任务");
  assert.equal(result.progress.done, 1);
  assert.equal(result.result.skipped, true);
  const unverifiedTaskDir = path.join(root, "workflow-tasks", crypto.createHash("sha256").update(unverifiedRecord.id).digest("hex"));
  const unverifiedTask = JSON.parse(fs.readFileSync(path.join(unverifiedTaskDir, "touch_task.json"), "utf8"));
  assert.equal(unverifiedTask.results[0].status, "identity_skipped");
  assert.equal(unverifiedTask.results[0].skip_record.reasonCode, "search_result_identity_unverified");
  assert.ok(unverifiedTask.results[0].skip_record.traceId, "workflow skips must reuse the existing contact-send diagnostic trace");
  assert.equal(unverifiedTask.results[1].status, "pending", "后续联系人不能被连带跳过");
  searchIdentityUnverified = false;
  result = await createTouchWorkflow(config).runWorkflowStep(unverifiedRecord, context);
  assert.equal(result.status, "completed", "隔离未确认搜索结果后仍应完成后续联系人");

  networkLookupMisclick = true;
  const poisonedWorkflow = createTouchWorkflow(config);
  const poisonedPayload = poisonedWorkflow.prepareWorkflowTask({ script: "网络查找误点止损测试", contactIds: [contact.id, secondContact.id] });
  const poisonedRecord = { id: crypto.randomUUID(), payload: poisonedPayload, progress: { done: 0 }, status: "running" };
  const poisonCallsBefore = calls.length;
  result = await poisonedWorkflow.runWorkflowStep(poisonedRecord, context);
  assert.equal(result.status, "pending", "confirmed network lookup misclick must skip only the current contact");
  assert.equal(result.progress.done, 1);
  assert.equal(calls.length, poisonCallsBefore + 1, "a confirmed misclick stops after its first attempt");
  const poisonedTaskDir = path.join(root, "workflow-tasks", crypto.createHash("sha256").update(poisonedRecord.id).digest("hex"));
  const poisonedTask = JSON.parse(fs.readFileSync(path.join(poisonedTaskDir, "touch_task.json"), "utf8"));
  assert.equal(poisonedTask.results[0].status, "identity_skipped");
  assert.deepEqual(poisonedTask.results[0].poisoned, {
    reason_code: "wechat_search_network_lookup_misclick",
    candidate_fingerprint: "huatengcangku-fixture",
    candidate_mode: "exact_wechat_id_local_visual",
    recovered: true,
    at: clock.toISOString()
  });
  assert.equal(poisonedTask.results[0].skip_record.reasonCode, "wechat_search_network_lookup_misclick");
  networkLookupMisclick = false;
  result = await createTouchWorkflow(config).runWorkflowStep(poisonedRecord, context);
  assert.equal(result.status, "completed", "poisoning one candidate must not block later contacts");
  const poisonedRetry = poisonedWorkflow.retrySkippedWorkflowTask(poisonedRecord, [contact.id]);
  assert.equal(poisonedRetry.ok, false, "a poisoned candidate must never be retried within the same task");
  assert.equal(poisonedRetry.blocked_reason, "retry_skipped_poisoned_forbidden");

  const completedUnverified = JSON.parse(fs.readFileSync(path.join(unverifiedTaskDir, "touch_task.json"), "utf8"));
  const completedUnverifiedBytes = fs.readFileSync(path.join(unverifiedTaskDir, "touch_task.json"), "utf8");
  const protectedWorkflowRetry = unverifiedWorkflow.retrySkippedWorkflowTask(unverifiedRecord, [completedUnverified.results[1].id]);
  assert.equal(protectedWorkflowRetry.ok, false, "a verified workflow row must never enter retry-skipped");
  assert.equal(fs.readFileSync(path.join(unverifiedTaskDir, "touch_task.json"), "utf8"), completedUnverifiedBytes);
  const workflowBinding = fs.readFileSync(path.join(unverifiedTaskDir, "workflow-binding.json"), "utf8");
  const retriedWorkflow = unverifiedWorkflow.retrySkippedWorkflowTask(unverifiedRecord, [completedUnverified.results[0].id]);
  assert.equal(retriedWorkflow.ok, true);
  assert.equal(retriedWorkflow.task.current_index, 0);
  assert.equal(retriedWorkflow.task.results[0].status, "generated");
  assert.equal(fs.readFileSync(path.join(unverifiedTaskDir, "workflow-binding.json"), "utf8"), workflowBinding, "retrying a skipped row must preserve the frozen workflow binding");
  const callsBeforeWorkflowRetry = calls.length;
  result = await createTouchWorkflow(config).runWorkflowStep(unverifiedRecord, context);
  assert.equal(result.status, "pending");
  clock.setTime(clock.getTime() + 8000);
  result = await createTouchWorkflow(config).runWorkflowStep(unverifiedRecord, context);
  assert.equal(result.status, "completed");
  assert.equal(calls.length, callsBeforeWorkflowRetry + 1, "only the explicitly reset skipped workflow row may send again");

  externalInputBlocks = 1;
  const inputRecoveryWorkflow = createTouchWorkflow(config);
  const inputRecoveryPayload = inputRecoveryWorkflow.prepareWorkflowTask({ script: "发送前输入占用恢复测试", contactIds: [contact.id] });
  const inputRecoveryRecord = { id: crypto.randomUUID(), payload: inputRecoveryPayload, progress: { done: 0 }, status: "running" };
  result = await inputRecoveryWorkflow.runWorkflowStep(inputRecoveryRecord, context);
  assert.equal(result.status, "pending", "发送前的临时输入占用必须保持任务运行而不是全局停机");
  assert.equal(result.retryAfterMs, 30000);
  assert.equal(result.waitingReason, "wechat_environment_recovery");
  assert.equal(result.progress.done, 0, "临时占用不能跳过当前联系人");
  result = await inputRecoveryWorkflow.runWorkflowStep(inputRecoveryRecord, context);
  assert.equal(result.status, "completed", "输入恢复后应自动继续当前联系人并完成触达");

  recoverableFailures = 3;
  const boundedRecoveryWorkflow = createTouchWorkflow(config);
  const boundedRecoveryPayload = boundedRecoveryWorkflow.prepareWorkflowTask({ script: "明确未发送有界恢复测试", contactIds: [contact.id, secondContact.id] });
  const boundedRecoveryRecord = { id: crypto.randomUUID(), payload: boundedRecoveryPayload, progress: { done: 0 }, status: "running" };
  result = await boundedRecoveryWorkflow.runWorkflowStep(boundedRecoveryRecord, context);
  assert.equal(result.waitingReason, "wechat_pre_send_recovery");
  assert.equal(result.retryAfterMs, 5000);
  result = await boundedRecoveryWorkflow.runWorkflowStep(boundedRecoveryRecord, context);
  assert.equal(result.retryAfterMs, 15000);
  result = await boundedRecoveryWorkflow.runWorkflowStep(boundedRecoveryRecord, context);
  assert.equal(result.status, "pending", "two failed recoveries must skip only the current contact");
  assert.equal(result.progress.done, 1);
  const boundedRecoveryDir = path.join(root, "workflow-tasks", crypto.createHash("sha256").update(boundedRecoveryRecord.id).digest("hex"));
  const boundedRecoveryState = JSON.parse(fs.readFileSync(path.join(boundedRecoveryDir, "touch_task.json"), "utf8"));
  assert.equal(boundedRecoveryState.results[0].status, "pre_send_skipped");
  assert.equal(boundedRecoveryWorkflow.describeSkippedWorkflowTask(boundedRecoveryRecord).skipped_breakdown.pre_send, 1);
  result = await boundedRecoveryWorkflow.runWorkflowStep(boundedRecoveryRecord, context);
  assert.equal(result.status, "completed", "the skipped contact must not block later contacts");
  const boundedRetry = boundedRecoveryWorkflow.retrySkippedWorkflowTask(boundedRecoveryRecord, [contact.id]);
  assert.equal(boundedRetry.ok, true, "a proven-not-sent skipped contact must remain available for a later run");

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
  const uncertainImage = { ...imageOptions, baseDir: path.join(root, "uncertain-receipt"), runner: async (_script, _env, options) => {
    clicks++;
    assert.equal(options.diagnostics, true, "image send must request fixed-token timeout diagnostics");
    return { ok: false, reason: "powershell_timeout", diagnostics: { image_stage: "post_send_confirmation", image_clipboard_operation: "image_write" } };
  } };
  const uncertainResult = await sendWechatImage(uncertainImage);
  assert.equal(uncertainResult.send_attempted, null);
  assert.equal(uncertainResult.driver_stage, "post_send_confirmation", "a killed image sender must expose its last entered stage");
  assert.equal(uncertainResult.clipboard_operation, "image_write");
  const afterTimeout = clicks;
  await sendWechatImage(uncertainImage);
  assert.equal(clicks, afterTimeout, "A terminated native sender remains quarantined by its durable receipt");
  let preClickTimeoutAttempts = 0;
  const preClickTimeout = { ...imageOptions, baseDir: path.join(root, "pre-click-timeout"), runner: async (_script, env) => {
    preClickTimeoutAttempts += 1;
    const stage = preClickTimeoutAttempts === 1 ? "sentinel_write" : "read_back";
    return { ok: false, reason: "powershell_timeout", diagnostics: { image_progress: [{ stage, status: "start", retry_index: Number(env.XIAOXI_IMAGE_RETRY_INDEX) }] } };
  } };
  const preClickResult = await sendWechatImage(preClickTimeout);
  assert.equal(preClickTimeoutAttempts, 2, "a trusted pre-click timeout must run one complete retry");
  assert.equal(preClickResult.send_attempted, false);
  assert.equal(preClickResult.blocked_reason, "image_send_pre_click_timeout");
  assert.equal(preClickResult.pre_send_retry_exhausted, true);
  const postClickTimeout = { ...imageOptions, baseDir: path.join(root, "post-click-timeout"), runner: async () => ({
    ok: false, reason: "powershell_timeout", diagnostics: { image_progress: [{ stage: "click_send", status: "start", retry_index: 0 }] }
  }) };
  const postClickResult = await sendWechatImage(postClickTimeout);
  assert.equal(postClickResult.send_attempted, null, "a click-stage timeout must remain outcome_unknown");
  const diagnosedImage = { ...imageOptions, baseDir: path.join(root, "diagnosed-image"), runner: async () => ({
    ok: false, reason: "image_driver_failed", sendAttempted: false, ruleId: "image-r007",
    driverStage: "clipboard_image_write", errorLine: 167, errorId: "SetImage", errorType: "System.Runtime.InteropServices.ExternalException",
    errorHResult: "hresult_800401D0"
  }) };
  const diagnosedResult = await sendWechatImage(diagnosedImage);
  assert.deepEqual({
    rule_id: diagnosedResult.rule_id, driver_stage: diagnosedResult.driver_stage, error_line: diagnosedResult.error_line,
    driver_error_id: diagnosedResult.driver_error_id, driver_exception_type: diagnosedResult.driver_exception_type,
    driver_exception_hresult: diagnosedResult.driver_exception_hresult, send_attempted: diagnosedResult.send_attempted
  }, {
    rule_id: "image-r007", driver_stage: "clipboard_image_write", error_line: 167, driver_error_id: "SetImage",
    driver_exception_type: "System.Runtime.InteropServices.ExternalException", driver_exception_hresult: "hresult_800401D0",
    send_attempted: false
  });
}

module.exports = { checkTouchMessageSequence };
if (require.main === module) checkTouchMessageSequence().then(() => process.stdout.write("Touch sequence checks passed: order, restart, partial failure, pause, unknown outcome and image receipts.\n")).catch(error => { console.error(error); process.exitCode = 1; });
