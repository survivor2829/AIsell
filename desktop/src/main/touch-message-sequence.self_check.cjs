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
const { retrySkippedResults, skippedTaskSummary } = require("../../rpa/active_touch/touch_task_state.cjs");
const { classifyWechatFailureReason } = require("../shared/wechat-failure-policy.cjs");
const { createTaskPassportStore } = require("./task-passport.cjs");

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
  assert.match(fs.readFileSync(path.join(__dirname, "../renderer/WechatWorkflow.tsx"), "utf8"),
    /touch_pre_send_failure_streak:\s*"连续 3 位联系人因同一原因在发送前失败/u,
    "the circuit needs an actionable user-facing label");
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../shared/wechat-rule-catalog.json"), "utf8"));
  const literalReasons = [...IMAGE_SEND_SCRIPT.matchAll(/throw "(image_[a-z0-9_]+)"/g)].map((match) => match[1]);
  const classifiedReasons = new Set(catalog.filter((entry) => entry?.file === "desktop/rpa/active_touch/wechat_image_send.dev.cjs" && typeof entry.reason === "string").map((entry) => entry.reason));
  for (const reason of literalReasons) assert.equal(classifiedReasons.has(reason), true, `${reason} must be classified in wechat-rule-catalog`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-touch-sequence-"));
  require("./diagnostics.cjs").configureDiagnostics({ rootDir: root });
  const contact = { id: "selected", name: "测试客户", nickname: "测试客户", wechatId: "test_customer", wechatAccountId: "test_account", allowed: true };
  const secondContact = { id: "selected-two", name: "第二位测试客户", nickname: "第二位测试客户", wechatId: "test_customer_two", wechatAccountId: "test_account", allowed: true };
  const thirdContact = { id: "selected-three", name: "第三位测试客户", nickname: "第三位测试客户", wechatId: "test_customer_three", wechatAccountId: "test_account", allowed: true };
  const fourthContact = { id: "selected-four", name: "第四位测试客户", nickname: "第四位测试客户", wechatId: "test_customer_four", wechatAccountId: "test_account", allowed: true };
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
  assert.equal(result.status, "pending");
  assert.equal(result.waitingReason, "wechat_pre_send_recovery");
  assert.equal(result.progress.done, 0, "A sent text must not complete a contact with an unsent image");
  assert.equal(workflow.canRetryWorkflowTask(record, payload), false, "automatic recovery is already scheduled");
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
  const pausedDir = path.join(root, "workflow-tasks", crypto.createHash("sha256").update(paused.id).digest("hex"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(pausedDir, "touch_task.json"), "utf8")).results[0].environment_recovery_started_at,
    undefined, "workflow_paused must not start an environment failure clock");
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
  assert.deepEqual(Object.keys(skippedTask.results[0].skip_record), ["contactId", "displayName", "index", "reasonCode", "ruleId", "blockedReason", "at", "traceId"]);
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
  assert.equal(result.retryAfterMs, 2_000, "身份恢复第一次等待应为 2 秒");
  result = await unverifiedWorkflow.runWorkflowStep(unverifiedRecord, context);
  assert.equal(result.progress.done, 0, "第二次 OCR 身份波动仍应保留当前联系人做最后一次恢复");
  assert.equal(result.retryAfterMs, 8_000, "身份恢复第二次等待应为 8 秒");
  result = await unverifiedWorkflow.runWorkflowStep(unverifiedRecord, context);
  assert.equal(result.progress.done, 0, "第三次 OCR 身份波动仍应保留当前联系人做最后一次恢复");
  assert.equal(result.retryAfterMs, 20_000, "身份恢复第三次等待应为 20 秒");
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
  const mixedRetryTask = JSON.parse(fs.readFileSync(path.join(poisonedTaskDir, "touch_task.json"), "utf8"));
  mixedRetryTask.results[1].status = "identity_skipped";
  mixedRetryTask.results[1].skip_record = { contactId: mixedRetryTask.results[1].id, displayName: "安全跳过", index: 1, reasonCode: "search_result_identity_unverified" };
  mixedRetryTask.status = "completed";
  const mixedSummary = skippedTaskSummary(mixedRetryTask);
  assert.equal(mixedSummary.records[0].retryable, false);
  assert.equal(mixedSummary.records[0].retry_blocked_reason, "retry_skipped_poisoned_forbidden");
  assert.equal(mixedSummary.records[1].retryable, true);
  const mixedRetry = retrySkippedResults(mixedRetryTask);
  assert.equal(mixedRetry.ok, true, "bulk retry must keep safe contacts moving when a poisoned row is present");
  assert.equal(mixedRetry.retriedCount, 1);
  assert.equal(mixedRetry.excludedCount, 1);
  assert.deepEqual(mixedRetry.excludedReasons, { retry_skipped_poisoned_forbidden: 1 });
  assert.equal(mixedRetry.task.results[0].status, "identity_skipped");
  assert.equal(mixedRetry.task.results[1].status, "generated");

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

  const interruptedWorkflow = createTouchWorkflow(config);
  const interruptedPayload = interruptedWorkflow.prepareWorkflowTask({ script: "发送前中断恢复测试", contactIds: [contact.id] });
  const interruptedRecord = { id: crypto.randomUUID(), payload: interruptedPayload, progress: { done: 0 }, status: "running" };
  const interruptedDir = path.join(root, "workflow-tasks", crypto.createHash("sha256").update(interruptedRecord.id).digest("hex"));
  fs.mkdirSync(path.join(interruptedDir, "contacts.json"), { recursive: true });
  const beforeInterruptedCalls = calls.length;
  result = await interruptedWorkflow.runWorkflowStep(interruptedRecord, context);
  assert.equal(result.status, "needs_attention", "a pre-sending write failure is surfaced to the scheduler");
  assert.equal(calls.length, beforeInterruptedCalls, "the sender was never called");
  fs.rmdirSync(path.join(interruptedDir, "contacts.json"));
  const restartedWorkflow = createTouchWorkflow(config);
  assert.equal(restartedWorkflow.canRetryWorkflowTask(interruptedRecord, interruptedPayload), true,
    "restart must reconcile a running task whose current row never reached sending");
  const interruptedState = JSON.parse(fs.readFileSync(path.join(interruptedDir, "touch_task.json"), "utf8"));
  assert.match(interruptedState.pause_reason, /上次任务未完成/u);
  result = await restartedWorkflow.runWorkflowStep(interruptedRecord, context);
  assert.equal(result.status, "completed");
  assert.equal(calls.length, beforeInterruptedCalls + 1, "pre-sending recovery sends once after restart");

  const interruptedMultipart = createTouchWorkflow(config);
  const interruptedMultipartPayload = interruptedMultipart.prepareWorkflowTask({
    script: "多段发送前中断恢复测试", contactIds: [contact.id], imageIds: [imageId]
  });
  const interruptedMultipartRecord = { id: crypto.randomUUID(), payload: interruptedMultipartPayload, progress: { done: 0 }, status: "running" };
  const interruptedMultipartDir = path.join(root, "workflow-tasks", crypto.createHash("sha256").update(interruptedMultipartRecord.id).digest("hex"));
  fs.mkdirSync(path.join(interruptedMultipartDir, "contacts.json"), { recursive: true });
  const beforeMultipartCalls = calls.length;
  result = await interruptedMultipart.runWorkflowStep(interruptedMultipartRecord, context);
  assert.equal(result.status, "needs_attention");
  assert.equal(calls.length, beforeMultipartCalls, "the pre-sending fault must happen before any multipart send");
  fs.rmdirSync(path.join(interruptedMultipartDir, "contacts.json"));
  const restartedMultipart = createTouchWorkflow(config);
  assert.equal(restartedMultipart.canRetryWorkflowTask(interruptedMultipartRecord, interruptedMultipartPayload), true,
    "a fresh multipart row must expose retry after restart");
  result = await restartedMultipart.runWorkflowStep(interruptedMultipartRecord, context);
  assert.equal(result.status, "completed");
  assert.deepEqual(calls.slice(beforeMultipartCalls).map((call) => call.kind), ["text", "image"],
    "multipart pre-sending recovery sends each part exactly once");

  // The fresh-row exception must never widen to a row that may already have gone out.
  const { loadTaskState, saveTaskState } = require("../../rpa/active_touch/touch_task_state.cjs");
  const possiblySentRows = [
    ["prepared", { status: "prepared" }],
    ["send_attempted null", { send_attempted: null }],
    ["retry_blocked missing", { retry_blocked: undefined }],
    ["text sent, image unknown", { message_parts: [{ kind: "text", status: "sent_verified" }, { kind: "image", status: "outcome_unknown" }] }]
  ];
  for (const [label, patch] of possiblySentRows) {
    const negativeWorkflow = createTouchWorkflow(config);
    const negativePayload = negativeWorkflow.prepareWorkflowTask({ script: `多段负例 ${label}`, contactIds: [contact.id], imageIds: [imageId] });
    const negativeRecord = { id: crypto.randomUUID(), payload: negativePayload, progress: { done: 0 }, status: "running" };
    const negativeDir = path.join(root, "workflow-tasks", crypto.createHash("sha256").update(negativeRecord.id).digest("hex"));
    fs.mkdirSync(path.join(negativeDir, "contacts.json"), { recursive: true });
    await negativeWorkflow.runWorkflowStep(negativeRecord, context);
    fs.rmdirSync(path.join(negativeDir, "contacts.json"));
    const negativeTask = loadTaskState(negativeDir);
    negativeTask.status = "paused";
    negativeTask.phase = "preparing_batch";
    const negativeRow = negativeTask.results[0];
    Object.assign(negativeRow, { status: "generated", retry_blocked: false, send_attempted: false });
    delete negativeRow.message_parts;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete negativeRow[key];
      else negativeRow[key] = value;
    }
    saveTaskState(negativeDir, negativeTask);
    const beforeNegativeCalls = calls.length;
    const restartedNegative = createTouchWorkflow(config);
    assert.equal(restartedNegative.canRetryWorkflowTask(negativeRecord, negativePayload), false,
      `a possibly-sent multipart row (${label}) must not expose retry`);
    await restartedNegative.runWorkflowStep(negativeRecord, context);
    assert.equal(calls.length, beforeNegativeCalls, `a possibly-sent multipart row (${label}) must not be resent`);
  }

  const corruptFile = path.join(interruptedDir, "touch_task.json");
  fs.writeFileSync(corruptFile, "{bad json", "utf8");
  assert.equal(createTouchWorkflow(config).describeSkippedWorkflowTask(interruptedRecord), null,
    "display-only task inspection must fail closed without restoring a backup");
  assert.equal(fs.readFileSync(corruptFile, "utf8"), "{bad json", "display-only inspection must not write task state");

  const genericFailureWorkflow = createTouchWorkflow({ ...config, execute: async () => ({
    ok: false, send_attempted: false, blocked_reason: "message_snapshot_unavailable", error: "发送前快照暂不可用"
  }) });
  const genericPayload = genericFailureWorkflow.prepareWorkflowTask({ script: "明确未发送恢复测试", contactIds: [contact.id, secondContact.id] });
  const genericRecord = { id: crypto.randomUUID(), payload: genericPayload, progress: { done: 0 }, status: "running" };
  const genericDiagnostics = [];
  const stopGenericDiagnostics = require("./diagnostics.cjs").diagnostics().subscribe((entry) => {
    if (entry.event === "workflow_contact_send.failed") genericDiagnostics.push(entry);
  });
  result = await genericFailureWorkflow.runWorkflowStep(genericRecord, context);
  assert.equal(result.status, "pending");
  assert.equal(result.waitingReason, "wechat_pre_send_recovery");
  assert.equal(result.retryAfterMs, 5000);
  result = await genericFailureWorkflow.runWorkflowStep(genericRecord, context);
  assert.equal(result.retryAfterMs, 15000);
  result = await genericFailureWorkflow.runWorkflowStep(genericRecord, context);
  stopGenericDiagnostics();
  assert.equal(result.status, "pending");
  assert.equal(result.progress.done, 1);
  assert.deepEqual(genericDiagnostics.map((entry) => entry.level), ["warn", "warn", "warn"],
    "the bounded pre-send path logs warnings; its final failure is recorded once by the passport");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "workflow-tasks", crypto.createHash("sha256").update(genericRecord.id).digest("hex"), "touch_task.json"), "utf8")).results[0].status, "pre_send_skipped");

  let genericScreenshots = 0;
  const diagnosticLogger = require("./diagnostics.cjs").configureDiagnostics({ rootDir: path.join(root, "pre-send-diagnostics") });
  const realPassport = createTaskPassportStore({ rootDir: path.join(root, "pre-send-passport"),
    captureScreenshot: () => { genericScreenshots += 1; return Buffer.from("89504e470d0a1a0a", "hex"); } });
  const stopPassportObserver = diagnosticLogger.subscribe((entry) => realPassport.observeDiagnostic(entry));
  const realWorkflow = createTouchWorkflow({ ...config, passport: realPassport, execute: async () => ({
    ok: false, send_attempted: false, blocked_reason: "message_snapshot_unavailable"
  }) });
  const realPayload = realWorkflow.prepareWorkflowTask({ script: "护照接线测试", contactIds: [contact.id] });
  const realRecord = { id: crypto.randomUUID(), payload: realPayload, progress: { done: 0 }, status: "running" };
  await realWorkflow.runWorkflowStep(realRecord, context);
  await realWorkflow.runWorkflowStep(realRecord, context);
  assert.equal(genericScreenshots, 0, "bounded retries must not create passport attachments");
  await realWorkflow.runWorkflowStep(realRecord, context);
  assert.equal(genericScreenshots, 1, "the final pre-send skip creates exactly one passport failure attachment");
  stopPassportObserver();
  require("./diagnostics.cjs").configureDiagnostics({ rootDir: root });

  async function checkPassportWiring(name, reasonCode, contactIds, image = false) {
    let screenshots = 0;
    const logger = require("./diagnostics.cjs").configureDiagnostics({ rootDir: path.join(root, `diagnostics-${name}`) });
    const passport = createTaskPassportStore({ rootDir: path.join(root, `passport-${name}`),
      captureScreenshot: () => { screenshots += 1; return Buffer.from("89504e470d0a1a0a", "hex"); } });
    const unsubscribe = logger.subscribe((entry) => passport.observeDiagnostic(entry));
    const workflow = createTouchWorkflow({ ...config, readContacts: () => [contact, secondContact, thirdContact], passport,
      execute: async (part) => {
        if (image && !part.image) {
          part.onTransition("sent_verified");
          return { ok: true, state: { real_send_status: "sent_verified" } };
        }
        return { ok: false, send_attempted: false, blocked_reason: reasonCode,
          ...(reasonCode === "image_send_pre_click_timeout" ? { pre_send_retry_exhausted: true } : {}) };
      } });
    const payload = workflow.prepareWorkflowTask({ script: name, contactIds, ...(image ? { imageIds: [imageId] } : {}) });
    const record = { id: crypto.randomUUID(), payload, progress: { done: 0 }, status: "running" };
    try {
      let final;
      for (const id of contactIds) {
        final = await workflow.runWorkflowStep(record, context);
        if (reasonCode === "wechat_login_required") {
          assert.equal(final.waitingReason, "wechat_environment_recovery");
          clock.setTime(clock.getTime() + 10 * 60_000);
          final = await workflow.runWorkflowStep(record, context);
        } else if (reasonCode === "message_snapshot_unavailable") {
          assert.equal(final.waitingReason, "wechat_pre_send_recovery");
          final = await workflow.runWorkflowStep(record, context);
          final = await workflow.runWorkflowStep(record, context);
        }
        if (id !== contactIds.at(-1)) assert.equal(final.status, "pending");
      }
      assert.equal(screenshots, contactIds.length,
        `${name}: each final skip or circuit produces one passport attachment`);
      return final;
    } finally {
      unsubscribe();
      require("./diagnostics.cjs").configureDiagnostics({ rootDir: root });
    }
  }
  assert.equal((await checkPassportWiring("图片点击前超时", "image_send_pre_click_timeout", [contact.id], true)).status, "completed");
  assert.equal((await checkPassportWiring("环境耗尽", "wechat_login_required", [contact.id])).status, "completed");
  assert.equal((await checkPassportWiring("连续同因熔断", "message_snapshot_unavailable",
    [contact.id, secondContact.id, thirdContact.id])).reasonCode, "touch_pre_send_failure_streak");

  const taskState = (record) => JSON.parse(fs.readFileSync(path.join(root, "workflow-tasks",
    crypto.createHash("sha256").update(record.id).digest("hex"), "touch_task.json"), "utf8"));
  const testFailure = async (reasonCode, options = {}) => {
    const attempts = [];
    const failures = [];
    const bills = [];
    let active = true;
    let liveContacts = [contact, secondContact, thirdContact, fourthContact];
    const localContext = { isEnabled: () => active };
    const localConfig = { ...config, readContacts: () => liveContacts,
      passport: { bindTrace() {}, recordEvent() {}, writeRunBill: (_module, _id, rows) => bills.push(rows),
        recordFailure: (_module, _id, failure) => failures.push(failure) },
      execute: async (part) => {
        const kind = part.image ? "image" : "text";
        attempts.push({ contactId: part.contactId, kind });
        const injected = options.resultForContact?.(part.contactId, part, kind);
        if (injected) return { ok: false, ...injected };
        if (options.successForContact?.(part.contactId)) {
          part.onTransition("sent_verified");
          return { ok: true, state: { real_send_status: "sent_verified" } };
        }
        if (options.multipart && kind === "text") {
          part.onTransition("sent_verified");
          return { ok: true, state: { real_send_status: "sent_verified" } };
        }
        if (options.transitions) for (const transition of options.transitions) part.onTransition(transition);
        if (options.pause) active = false;
        return { ok: false, send_attempted: Object.hasOwn(options, "sendAttempted") ? options.sendAttempted : false,
          blocked_reason: options.reasonForContact?.(part.contactId) || reasonCode,
          ...(options.sendResult ? { send_result: options.sendResult } : {}),
          ...(options.preClick ? { pre_send_retry_exhausted: true } : {}) };
      } };
    const workflow = createTouchWorkflow(localConfig);
    const ids = options.contactIds || [contact.id];
    const payload = workflow.prepareWorkflowTask({ script: "故障注入", contactIds: ids, ...(options.multipart ? { imageIds: [imageId] } : {}) });
    const record = { id: crypto.randomUUID(), payload, progress: { done: 0 }, status: "running" };
    return { workflow, record, payload, attempts, failures, bills, context: localContext, setActive: (value) => { active = value; },
      setContacts: (contacts) => { liveContacts = contacts; },
      step: () => workflow.runWorkflowStep(record, localContext), state: () => taskState(record) };
  };
  const recoverableCodes = ["message_snapshot_unavailable", "atomic_send_not_verified", "atomic_draft_changed",
    "message_input_failed", "message_input_failed_clipboard_write_or_paste_failed_attempts_2",
    "message_input_failed_wechat_clipboard_read_failed", "wechat_focus_failed", "wechat_clipboard_read_failed",
    "wechat_window_identity_mismatch", "new_pre_send_test_reason", "image_driver_failed", "image_existing_draft_clear_failed"];
  for (const reasonCode of recoverableCodes) {
    const test = await testFailure(reasonCode, { multipart: reasonCode.startsWith("image_"),
      transitions: ["atomic_send_not_verified", "atomic_draft_changed"].includes(reasonCode) ? ["prepared", "sending"] : [] });
    const first = await test.step();
    assert.equal(first.status, "pending", reasonCode);
    assert.equal(first.waitingReason, "wechat_pre_send_recovery", reasonCode);
    assert.equal(first.retryAfterMs, 5000, reasonCode);
    const second = await test.step();
    assert.equal(second.retryAfterMs, 15000, reasonCode);
    const third = await test.step();
    assert.equal(third.status, "completed", reasonCode);
    assert.equal(third.progress.done, 1, reasonCode);
    assert.equal(test.state().results[0].status, "pre_send_skipped", reasonCode);
    assert.equal(test.failures.length, 1, `${reasonCode}: only the final skip gets a passport failure`);
    assert.equal(test.bills.at(-1)?.[0]?.ruleId, "", `${reasonCode}: pre-send skips have no search rule id in the run bill`);
  }
  const foreground = await testFailure("message_input_failed_wechat_window_not_foreground_attempts_3");
  result = await foreground.step();
  assert.equal(result.waitingReason, "wechat_environment_recovery");
  assert.equal(result.retryAfterMs, 30000);

  const cancelled = await testFailure("batch_cancelled", { pause: true });
  result = await cancelled.step();
  assert.equal(result.status, "pending");
  assert.equal(cancelled.state().results[0].pre_send_recovery_attempts || 0, 0);
  assert.equal(cancelled.state().results[0].environment_recovery_started_at, undefined);
  assert.equal(cancelled.state().pre_send_skip_streak, undefined);
  for (const sendAttempted of [null, true]) {
    const uncertain = await testFailure("atomic_send_not_verified", { sendAttempted,
      ...(sendAttempted === null ? { sendResult: "not_attempted" } : {}) });
    result = await uncertain.step();
    assert.equal(result.status, "needs_attention");
    assert.equal(result.reasonCode, "outcome_unknown");
    const before = uncertain.attempts.length;
    await createTouchWorkflow({ ...config, readContacts: () => [contact, secondContact, thirdContact, fourthContact],
      execute: () => { throw new Error("unknown outcome must not retry"); } }).runWorkflowStep(uncertain.record, uncertain.context);
    assert.equal(uncertain.attempts.length, before);
  }
  const preparedOnly = await testFailure("atomic_send_not_verified", { transitions: ["prepared"] });
  result = await preparedOnly.step();
  assert.equal(result.reasonCode, "outcome_unknown");
  assert.equal(preparedOnly.state().results[0].status, "outcome_unknown");
  const preparedCallCount = preparedOnly.attempts.length;
  let restartedPreparedCalls = 0;
  await createTouchWorkflow({ ...config, readContacts: () => [contact, secondContact, thirdContact, fourthContact],
    execute: () => { restartedPreparedCalls += 1; throw new Error("prepared-only unknown must not execute after restart"); }
  }).runWorkflowStep(preparedOnly.record, preparedOnly.context);
  assert.equal(preparedOnly.attempts.length, preparedCallCount, "7b: a new workflow instance cannot retry prepared-only unknown");
  assert.equal(restartedPreparedCalls, 0);
  for (const [reasonCode, transitions] of [["atomic_send_not_verified", ["prepared"]],
    ["wechat_search_network_lookup_misclick", []]]) {
    const diagnosticLevels = [];
    const test = await testFailure(reasonCode, { transitions });
    const stop = require("./diagnostics.cjs").diagnostics().subscribe((entry) => {
      if (entry.event === "workflow_contact_send.failed") diagnosticLevels.push(entry.level);
    });
    await test.step();
    stop();
    assert.deepEqual(diagnosticLevels, ["error"], `${reasonCode} takes an attention/unknown branch, not bounded recovery`);
  }
  const pausedReason = await testFailure("workflow_paused");
  result = await pausedReason.step();
  assert.equal(result.status, "pending");
  assert.equal(pausedReason.state().results[0].environment_recovery_started_at, undefined);
  const disabledDuringSend = await testFailure("message_snapshot_unavailable", { pause: true });
  result = await disabledDuringSend.step();
  assert.equal(result.status, "pending");
  assert.equal(disabledDuringSend.state().results[0].pre_send_recovery_attempts || 0, 0);

  const excludedCodes = ["batch_authorization_missing", "task_context_missing", "task_context_mismatch", "executor_contact_mismatch",
    "contact_snapshot_changed", "touch_sequence_changed", "contact_or_message_missing", "wechat_account_identity_missing",
    "wechat_account_not_verified", "wechat_account_changed", "wechat_account_directory_missing", "wechat_account_ambiguous",
    "real_send_already_attempted", "real_send_not_armed", "real_send_explicit_allow_missing",
    "real_send_final_confirmation_missing", "real_send_gate_failed", "real_send_session_not_verified",
    "send_gate_not_passed", "prepared_task_persist_failed", "wechat_search_result_landing_unverified",
    "wechat_id_name_conflict", "contact_identity_ambiguous", "touch_image_changed", "image_attempt_context_missing",
    "task_attention_reason_missing", "invalid_unclassified_reason"];
  for (const reasonCode of excludedCodes) {
    const test = await testFailure(reasonCode);
    result = await test.step();
    assert.equal(result.status, "needs_attention", reasonCode);
    assert.equal(test.state().results[0].pre_send_recovery_attempts || 0, 0, reasonCode);
    assert.notEqual(test.state().results[0].status, "pre_send_skipped", reasonCode);
  }
  for (const multipart of [false, true]) {
    const test = await testFailure("image_driver_failed", { multipart, contactIds: [contact.id, secondContact.id, thirdContact.id] });
    for (let person = 0; person < 2; person += 1) {
      for (let attempt = 0; attempt < 2; attempt += 1) assert.equal((await test.step()).waitingReason, "wechat_pre_send_recovery");
      result = await test.step();
      assert.equal(result.progress.done, person + 1);
      assert.equal(test.state().results[person].status, "pre_send_skipped");
    }
    for (let attempt = 0; attempt < 2; attempt += 1) assert.equal((await test.step()).waitingReason, "wechat_pre_send_recovery");
    result = await test.step();
    assert.equal(result.status, "needs_attention");
    assert.equal(result.reasonCode, "touch_pre_send_failure_streak");
    assert.equal(result.result.deliveryStatus, multipart ? "partial_sent" : "not_attempted",
      "circuit delivery status must include already verified message parts");
    assert.equal(classifyWechatFailureReason(result.reasonCode).attentionScope, "global");
    assert.equal(test.state().results[2].status, "generated");
    assert.equal(test.state().results[2].pre_send_recovery_attempts, 0);
    assert.equal(test.state().results[2].retry_blocked, false);
    assert.equal(test.state().results[2].send_attempted, false);
    assert.equal(test.state().results[2].environment_recovery_started_at, undefined);
    if (multipart) assert.deepEqual(test.state().results[2].message_parts.map((part) => part.status),
      ["sent_verified", "not_attempted"], "the circuit retains the verified text and the unsent image");
    assert.equal(test.state().pre_send_skip_streak, undefined);
    assert.equal(test.workflow.canRetryWorkflowTask(test.record, test.payload), true);
    assert.equal(test.failures.length, 3, "two final skips and one circuit pause consume one passport failure each");
    const textBeforeResume = test.attempts.filter((call) => call.contactId === thirdContact.id && call.kind === "text").length;
    const recovered = createTouchWorkflow({ ...config, readContacts: () => [contact, secondContact, thirdContact],
      execute: async (part) => { test.attempts.push({ contactId: part.contactId, kind: part.image ? "image" : "text" }); part.onTransition("sent_verified"); return { ok: true, state: { real_send_status: "sent_verified" } }; } });
    result = await recovered.runWorkflowStep(test.record, test.context);
    assert.equal(result.status, "completed");
    assert.equal(test.attempts.filter((call) => call.contactId === thirdContact.id && call.kind === "text").length,
      textBeforeResume + (multipart ? 0 : 1), "resume must retain already verified multipart text");
  }
  const different = await testFailure("message_snapshot_unavailable", {
    contactIds: [contact.id, secondContact.id, thirdContact.id],
    reasonForContact: (id) => id === secondContact.id ? "image_driver_failed" : "message_snapshot_unavailable"
  });
  for (let person = 0; person < 3; person += 1) {
    await different.step(); await different.step(); result = await different.step();
    assert.notEqual(result.status, "needs_attention", "X, Y, X must not trip a same-reason circuit");
  }
  const snapshotReset = await testFailure("message_snapshot_unavailable", {
    contactIds: [contact.id, secondContact.id, thirdContact.id, fourthContact.id]
  });
  for (let person = 0; person < 2; person += 1) {
    await snapshotReset.step(); await snapshotReset.step(); await snapshotReset.step();
  }
  snapshotReset.setContacts([contact, secondContact, fourthContact]);
  assert.equal((await snapshotReset.step()).progress.done, 3);
  assert.equal(snapshotReset.state().pre_send_skip_streak, undefined, "snapshot change clears the prior pre-send streak");
  await snapshotReset.step(); await snapshotReset.step();
  assert.notEqual((await snapshotReset.step()).status, "needs_attention");

  const manualReset = await testFailure("message_snapshot_unavailable", {
    contactIds: [contact.id, secondContact.id, thirdContact.id, fourthContact.id],
    resultForContact: (id) => id === thirdContact.id
      ? { send_attempted: null, blocked_reason: "atomic_send_not_verified" } : null
  });
  for (let person = 0; person < 2; person += 1) {
    await manualReset.step(); await manualReset.step(); await manualReset.step();
  }
  assert.equal((await manualReset.step()).reasonCode, "outcome_unknown");
  manualReset.workflow.resolveUnknownWorkflowTask(manualReset.record, "skip");
  assert.equal(manualReset.state().pre_send_skip_streak, undefined, "manual disposition clears the prior pre-send streak");
  await manualReset.step(); await manualReset.step();
  assert.notEqual((await manualReset.step()).status, "needs_attention");

  const identityReset = await testFailure("message_snapshot_unavailable", {
    contactIds: [contact.id, secondContact.id, thirdContact.id, fourthContact.id],
    reasonForContact: (id) => id === thirdContact.id ? "exact_search_result_not_found" : "message_snapshot_unavailable"
  });
  for (let person = 0; person < 2; person += 1) {
    await identityReset.step(); await identityReset.step(); await identityReset.step();
  }
  assert.equal((await identityReset.step()).progress.done, 3);
  assert.equal(identityReset.state().pre_send_skip_streak, undefined, "identity skip clears pre-send count");
  await identityReset.step(); await identityReset.step();
  assert.notEqual((await identityReset.step()).status, "needs_attention");

  const preSendResetsIdentity = await testFailure("message_snapshot_unavailable", {
    contactIds: [contact.id, secondContact.id, thirdContact.id, fourthContact.id],
    resultForContact: (id) => id === thirdContact.id ? null : {
      send_attempted: false, blocked_reason: "search_result_identity_unverified",
      diagnostics: { rule_id: "search-r008", candidate_set_hash: "unchanged" }
    }
  });
  for (let person = 0; person < 2; person += 1) {
    assert.equal((await preSendResetsIdentity.step()).waitingReason, "wechat_identity_recovery");
    assert.equal((await preSendResetsIdentity.step()).progress.done, person + 1);
  }
  assert.equal(preSendResetsIdentity.state().identity_skip_streak.count, 2);
  await preSendResetsIdentity.step(); await preSendResetsIdentity.step(); await preSendResetsIdentity.step();
  assert.equal(preSendResetsIdentity.state().identity_skip_streak, undefined, "pre-send skip clears identity count");
  assert.equal((await preSendResetsIdentity.step()).waitingReason, "wechat_identity_recovery");
  assert.notEqual((await preSendResetsIdentity.step()).status, "needs_attention");
  const succeededBetween = await testFailure("message_snapshot_unavailable", {
    contactIds: [contact.id, secondContact.id, thirdContact.id, fourthContact.id],
    successForContact: (id) => id === secondContact.id
  });
  await succeededBetween.step(); await succeededBetween.step(); await succeededBetween.step();
  result = await succeededBetween.step();
  assert.equal(result.result.deliveryStatus, "sent_verified");
  clock.setTime(clock.getTime() + result.retryAfterMs);
  for (let person = 0; person < 2; person += 1) {
    await succeededBetween.step(); await succeededBetween.step(); result = await succeededBetween.step();
    assert.notEqual(result.status, "needs_attention", "a verified contact resets the prior failure streak");
  }
  const rejoined = await testFailure("message_snapshot_unavailable", { contactIds: [contact.id, secondContact.id] });
  for (let person = 0; person < 2; person += 1) { await rejoined.step(); await rejoined.step(); await rejoined.step(); }
  assert.equal(rejoined.state().pre_send_skip_streak.count, 2);
  assert.equal(rejoined.workflow.retrySkippedWorkflowTask(rejoined.record, [contact.id, secondContact.id]).ok, true);
  assert.equal(rejoined.state().pre_send_skip_streak, undefined);
  for (let person = 0; person < 2; person += 1) {
    await rejoined.step(); await rejoined.step(); result = await rejoined.step();
    assert.notEqual(result.status, "needs_attention", "rejoining the skipped set starts a new streak");
  }
  for (const reasonCode of ["wechat_login_required", "image_send_pre_click_timeout"]) {
    const test = await testFailure(reasonCode, { contactIds: [contact.id, secondContact.id, thirdContact.id],
      preClick: reasonCode === "image_send_pre_click_timeout" });
    for (let person = 0; person < 3; person += 1) {
      result = await test.step();
      if (reasonCode === "wechat_login_required") {
        assert.equal(result.waitingReason, "wechat_environment_recovery");
        clock.setTime(clock.getTime() + 10 * 60_000);
        result = await test.step();
      }
      assert.equal(result.status, person === 2 ? "needs_attention" : "pending");
    }
    assert.equal(result.reasonCode, "touch_pre_send_failure_streak");
    assert.equal(test.state().results[2].status, "generated");
  }

  atomicMismatch = true;
  const atomicWorkflow = createTouchWorkflow(config);
  const atomicPayload = atomicWorkflow.prepareWorkflowTask({ script: "会话变化暂停测试", contactIds: [contact.id] });
  const atomicRecord = { id: crypto.randomUUID(), payload: atomicPayload, progress: { done: 0 }, status: "running" };
  result = await atomicWorkflow.runWorkflowStep(atomicRecord, context);
  assert.equal(result.status, "pending", "会话身份变化不能被误判为联系人不存在");
  assert.equal(result.waitingReason, "wechat_pre_send_recovery");
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

  const worker = require("node:child_process").spawnSync(process.execPath, ["-e", `
    const cp = require("node:child_process");
    let powerShellLaunches = 0;
    for (const method of ["spawn", "spawnSync"]) {
      const original = cp[method];
      cp[method] = (...args) => {
        if (/^(?:powershell|pwsh)(?:\\.exe)?$/iu.test(require("node:path").basename(String(args[0])))) {
          powerShellLaunches += 1;
          throw new Error("T8 must not launch PowerShell");
        }
        return original(...args);
      };
    }
    require(${JSON.stringify(__filename)}).checkMultipartReuse().then(() => {
      if (powerShellLaunches !== 0) throw new Error("PowerShell was launched");
      process.stdout.write("T8 multipart session reuse checks passed; PowerShell launches: 0\\n");
    }).catch((error) => { process.stderr.write(error.stack + "\\n"); process.exitCode = 1; });
  `], { encoding: "utf8", timeout: 120_000 });
  assert.equal(worker.status, 0, worker.stderr || worker.error?.message || "T8 isolated worker failed");
  process.stdout.write(worker.stdout);
}

async function checkMultipartReuse() {
  const { executeVerifiedContactSend } = require("../../rpa/active_touch/state_machine.dev.cjs");
  const { loadState, saveState } = require("../../rpa/active_touch/state_machine.cjs");
  const { loadTaskState } = require("../../rpa/active_touch/touch_task_state.cjs");
  const TOKEN = "conversation:v2:81:91:visual:fixture-token";
  const preparedWindow = (hWnd = 91) => ({ ok: true, inspectionOnly: true, normalized: true,
    layoutMode: "stable_target", focused: true, pid: 81, hWnd, processName: "Weixin" });

  async function scenario(settings = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-t8-reuse-"));
    const contact = { id: "t8-contact", name: "测试客户", wechatId: "wxid_t8", wechatAccountId: "test_account", allowed: true };
    const contacts = settings.duplicateName ? [contact, { ...contact, id: "other", wechatId: "wxid_other" }] : [contact];
    fs.writeFileSync(path.join(root, "contacts.json"), JSON.stringify(contacts));
    if (settings.flag !== undefined) fs.writeFileSync(path.join(root, "feature-flags.json"), settings.flag);
    const logger = require("./diagnostics.cjs").configureDiagnostics({ rootDir: path.join(root, "diagnostics") });
    const events = [], passports = [];
    const unsubscribe = logger.subscribe((entry) => events.push(entry));
    const counts = { select: 0, preflight: 0, click: 0, inspector: 0, text: 0, image: 0 };
    const inspections = [];
    let clock = Date.parse("2026-09-27T08:00:00.000Z");
    let enabled = true;
    let firstText = false;
    const imageId = "b".repeat(64);
    const workflow = createTouchWorkflow({
      dataDir: root, now: () => new Date(clock), random: () => 0, readContacts: () => contacts,
      coordinator: { acquire: () => ({ ok: true, lock: { owner: "t8" } }), release() {} },
      mediaStore: { validateIds: (ids) => ids, resolve: () => ({ path: "fixture-image.png" }) },
      passport: { bindTrace() {}, recordEvent: (...args) => passports.push(args), recordFailure: (...args) => passports.push(args),
        writeRunBill: (...args) => passports.push(args) },
      runStep: (args, context) => {
        const [command] = args;
        if (["select-customer", "calibrate", "send"].includes(command)) {
          if (command === "select-customer") counts.select += 1;
          return runCli(["node", "active_touch_cli.cjs", ...args, "--data-dir", context.dataDir]);
        }
        const state = loadState(context.dataDir);
        if (command === "click-search-result-dry-run") {
          counts.click += 1;
          if (settings.failFallback && path.basename(context.dataDir) === "1") {
            return { ok: false, blocked_reason: "search_result_identity_unverified", action: command };
          }
          const next = { ...state, conversation_located: true, conversation_verified: true,
            conversation_title: contact.name, located_window_title: contact.name,
            conversation_verification_mode: settings.titleMode ? "conversation_title" : "exact_wechat_id_search",
            conversation_token: TOKEN, conversation_title_mode: settings.titleMode ? "title" : "visual",
            search_input_done: true, search_result_clicked: true, search_query: contact.wechatId, search_query_type: "wechat_id",
            window_pid: 81, window_handle: "91", window_process_name: "Weixin",
            send_gate_status: "pending", real_send_status: "not_sent", blocked_reason: "" };
          saveState(context.dataDir, next);
          return { ok: true, state: next };
        }
        if (command === "input-message-dry-run") {
          const message = args[args.indexOf("--message") + 1];
          const next = { ...state, message_input_done: true, message_draft: message,
            send_gate_status: "pending", real_send_status: "not_sent", blocked_reason: "" };
          saveState(context.dataDir, next);
          return { ok: true, state: next };
        }
        throw new Error(`Unexpected CLI command: ${command}`);
      },
      execute: async (part) => {
        const index = Number(path.basename(part.baseDir));
        const alteredAnchor = index === 1 && part.reuseSession?.anchor
          ? { ...part.reuseSession.anchor,
            ...(settings.anchorContactChanged ? { contact_identity: "changed-contact" } : {}),
            ...(settings.anchorAccountChanged ? { wechat_account_id: "changed-account" } : {}) }
          : part.reuseSession?.anchor;
        const sent = await executeVerifiedContactSend({ ...part,
          ...(part.reuseSession ? { reuseSession: { ...part.reuseSession, anchor: alteredAnchor } } : {}),
          windowPreflight: async () => { counts.preflight += 1; return preparedWindow(); },
          sessionDriver: async () => {
            if (settings.sessionThrows && index === 1 && loadState(part.baseDir).session_source === "reused_verified_conversation") {
              throw new Error("session fixture fault");
            }
            if (settings.pauseInGate && index === 1 && loadState(part.baseDir).session_source === "reused_verified_conversation") enabled = false;
            return { ok: true,
              pid: settings.driverPidChanged && index === 1 && loadState(part.baseDir).session_source === "reused_verified_conversation" ? 82 : 81,
              hWnd: settings.driverWindowChanged && index === 1 && loadState(part.baseDir).session_source === "reused_verified_conversation" ? "92" : "91",
              processName: "Weixin", title: contact.name,
            accountId: "test_account", accountVerified: true,
            verificationMode: settings.modeChanged && index === 1 && loadState(part.baseDir).session_source === "reused_verified_conversation"
              ? "conversation_title" : settings.titleMode ? "conversation_title" : "exact_wechat_id_search",
            conversationToken: settings.tokenMissing && index === 1 && loadState(part.baseDir).session_source === "reused_verified_conversation"
              ? undefined : settings.tokenChanged && index === 1 && loadState(part.baseDir).session_source === "reused_verified_conversation"
                ? `${TOKEN}-changed` : TOKEN };
          },
          windowInspector: async (context) => {
            counts.inspector += 1; inspections.push(context);
            if (settings.inspectorThrows) throw new Error("inspection fixture fault");
            if (settings.inspectorActive) return { ok: false, reason: "wechat_user_active" };
            if (settings.inspectorRestarted) return { ok: false, reason: "wechat_window_identity_mismatch" };
            if (settings.inspectorUnfocused) return { ...preparedWindow(), focused: false };
            if (settings.inspectorLayoutChanged) return { ...preparedWindow(), layoutMode: "unknown" };
            return preparedWindow(settings.inspectorWindowChanged ? 92 : 91);
          },
          sendDriver: async () => { counts.text += 1; return { ok: true, sendAttempted: true,
            conversationVerified: true, composerVerified: true, draftVerified: true }; },
          bubbleVerifier: async (message, context) => context.phase === "before"
            ? { ok: true, snapshot: `before-${index}` }
            : { ok: true, exactMatch: true, outgoing: true, isLatest: true, isNew: true, messageText: message },
          imageSender: async ({ onTransition }) => {
            counts.image += 1; onTransition?.("sent_verified");
            return { ok: true, send_attempted: true, state: { real_send_status: "sent_verified" } };
          }
        });
        if (index === 0 && sent.ok && !firstText) {
          firstText = true;
          if (settings.expireAfterText) clock += 16_000;
          if (settings.rewindAfterText) clock -= 1_000;
          if (settings.pauseAfterText) enabled = false;
        }
        return settings.lateFailure && index === 0 && sent.ok ? { ...sent, ok: false } : sent;
      }
    });
    const payload = workflow.prepareWorkflowTask({ script: "您好，产品资料如下。", contactIds: [contact.id],
      ...(!settings.singleText ? { imageIds: settings.fourParts ? [imageId, imageId] : [imageId] } : {}),
      ...(settings.fourParts ? { link: "https://example.com/product" } : {}) });
    const record = { id: crypto.randomUUID(), payload, progress: { done: 0 }, status: "running" };
    let result = await workflow.runWorkflowStep(record, { isEnabled: () => enabled });
    if (settings.pauseAfterText) {
      assert.equal(result.status, "pending");
      enabled = true;
      result = await workflow.runWorkflowStep(record, { isEnabled: () => enabled });
    }
    const reuse = events.filter((entry) => entry.event === "send_stage" && entry.details?.stage === "session_reuse" && entry.details?.phase === "finish")
      .map((entry) => entry.details);
    const stages = (name) => events.filter((entry) => entry.event === "send_stage" && entry.details?.stage === name && entry.details?.phase === "finish");
    try {
      const taskDir = path.join(root, "workflow-tasks", crypto.createHash("sha256").update(record.id).digest("hex"));
      const task = loadTaskState(taskDir);
      assert.doesNotMatch(JSON.stringify({ result, task, passports, events }), /session_anchor/u,
        "session anchors must not escape the in-memory part boundary");
      if (fs.existsSync(logger.logFile)) assert.doesNotMatch(fs.readFileSync(logger.logFile, "utf8"), /session_anchor/u);
      for (const file of fs.readdirSync(taskDir, { recursive: true })) {
        const full = path.join(taskDir, file);
        if (fs.statSync(full).isFile() && /\.json(?:l)?$/u.test(file)) assert.doesNotMatch(fs.readFileSync(full, "utf8"), /session_anchor/u);
      }
      assert.equal(global.__t8PowerShellLaunches || 0, 0);
      return { result, counts, inspections, reuse, stages, task, events };
    } finally { unsubscribe(); fs.rmSync(root, { recursive: true, force: true }); }
  }

  const normal = await scenario({ fourParts: true });
  assert.equal(normal.result.status, "completed");
  assert.equal(normal.counts.select, 4);
  assert.equal(normal.counts.preflight, 1);
  assert.equal(normal.counts.click, 1);
  assert.equal(normal.stages("verify_session").length, 1);
  assert.equal(normal.stages("session_reuse_verify").length, 3);
  assert.equal(normal.counts.inspector, 3);
  assert.equal(normal.task.results[0].message_parts.every((part) => part.status === "sent_verified"), true);
  assert.deepEqual(normal.reuse.map((entry) => entry.reuse_outcome), ["reused", "reused", "reused"]);
  assert.deepEqual(normal.reuse.map((entry) => entry.reused_from_part), [0, 1, 2]);
  assert.equal(normal.inspections.every((entry) => entry.expectedPid === 81 && entry.expectedHWnd === "91" && entry.minIdleMs >= 1), true);
  const single = await scenario({ singleText: true });
  assert.equal(single.result.status, "completed");
  assert.equal(single.reuse.length, 0, "a single text send does not request a session anchor");

  const disabled = await scenario({ flag: '{"multipartSessionReuse":false}' });
  assert.equal(disabled.result.status, "completed");
  assert.equal(disabled.counts.preflight, 2);
  assert.equal(disabled.counts.click, 2);
  assert.deepEqual(disabled.reuse.map((entry) => entry.reuse_outcome), ["disabled"]);
  const malformed = await scenario({ flag: "{broken" });
  assert.equal(malformed.reuse[0].reuse_outcome, "reused");
  assert.equal(malformed.events.some((entry) => entry.event === "session_reuse.flags_invalid" && entry.level === "warn"), true);

  for (const [settings, expected] of [
    [{ tokenChanged: true }, "conversation_token_changed"],
    [{ tokenMissing: true }, "conversation_token_changed"],
    [{ modeChanged: true }, "session_verify_failed"],
    [{ tokenChanged: true, titleMode: true }, "session_verify_failed"],
    [{ inspectorActive: true }, "user_input_detected"],
    [{ inspectorWindowChanged: true }, "window_changed"],
    [{ inspectorUnfocused: true }, "window_not_ready"],
    [{ inspectorLayoutChanged: true }, "window_not_ready"],
    [{ inspectorRestarted: true }, "window_changed"],
    [{ inspectorThrows: true }, "window_not_ready"],
    [{ sessionThrows: true }, "window_not_ready"],
    [{ driverPidChanged: true }, "session_verify_failed"],
    [{ driverWindowChanged: true }, "session_verify_failed"],
    [{ anchorContactChanged: true }, "contact_changed"],
    [{ anchorAccountChanged: true }, "contact_changed"],
    [{ expireAfterText: true }, "anchor_expired"],
    [{ rewindAfterText: true }, "anchor_expired"],
    [{ duplicateName: true }, "name_not_unique"],
    [{ pauseAfterText: true }, "anchor_missing"]
  ]) {
    const failedReuse = await scenario(settings);
    assert.equal(failedReuse.result.status, "completed", `${expected}: full search still succeeds`);
    assert.equal(failedReuse.reuse.at(-1).reuse_outcome, expected);
    assert.equal(failedReuse.counts.preflight, 2);
    assert.equal(failedReuse.counts.click, 2);
    if (expected === "name_not_unique") assert.equal(failedReuse.counts.inspector, 0);
  }
  const failedSearch = await scenario({ tokenChanged: true, failFallback: true });
  assert.equal(failedSearch.reuse[0].reuse_outcome, "conversation_token_changed");
  assert.equal(failedSearch.result.reasonCode, "search_result_identity_unverified");
  assert.equal(failedSearch.counts.preflight, 2);
  assert.equal(failedSearch.counts.image, 0);
  const lateFailure = await scenario({ lateFailure: true });
  assert.equal(lateFailure.result.status, "completed");
  assert.equal(lateFailure.reuse[0].reuse_outcome, "anchor_missing", "a late failed return must clear the in-memory anchor");
  assert.equal(lateFailure.counts.text, 1);
  assert.equal(lateFailure.counts.image, 1);
  assert.equal(lateFailure.counts.click, 2);
  const pausedGate = await scenario({ pauseInGate: true });
  assert.equal(pausedGate.result.status, "pending");
  assert.equal(pausedGate.counts.text, 1);
  assert.equal(pausedGate.counts.image, 0, "a pause inside the reuse gate must not send the image");
}

module.exports = { checkTouchMessageSequence, checkMultipartReuse };
if (require.main === module) checkTouchMessageSequence().then(() => process.stdout.write("Touch sequence checks passed: order, restart, partial failure, pause, unknown outcome and image receipts.\n")).catch(error => { console.error(error); process.exitCode = 1; });
