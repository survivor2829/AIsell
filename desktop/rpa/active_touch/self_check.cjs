const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  calibrate,
  clickSearchResultDryRun,
  clearCustomer,
  focusWechatWindowDryRun,
  inputMessageDryRun,
  loadState,
  locateConversation,
  openConversationDryRun,
  queueDryRun,
  searchConversationDryRun,
  selectCustomer,
  saveState,
  send,
  status,
  verifyConversation,
  verifySendResultDryRun,
  verifyWindowTitle
} = require("./state_machine.cjs");
const { executeVerifiedContactSend, refreshRealSendSession, sendReal, setRealSendArm, verifyMessageBubble, verifyRealSendSession } = require("./state_machine.dev.cjs");
const { runPowerShellAsync } = require("./wechat_window_driver.cjs");
const {
  authorizeNextBatch,
  classifyContacts,
  createTask,
  cleanupTaskCache,
  fillTouchTemplate,
  hasUnfinishedPausedTask,
  isBatchAuthorized,
  loadTaskState,
  publicTaskState,
  recoverInterruptedTask,
  saveTaskState,
  sendDelayMs,
  taskBackupPath
} = require("./touch_task_state.cjs");
const { main: runActiveTouchCli } = require("./active_touch_cli.cjs");
const { runPowerShell } = require("./wechat_window_driver.cjs");

(async () => {
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-active-touch-"));

try {
  const longPowerShellProbe = `$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8\n$padding = "${"x".repeat(16000)}"\n@{ ok = $true; length = $padding.Length; value = "微信发送" } | ConvertTo-Json -Compress`;
  assert.deepEqual(
    runPowerShell(longPowerShellProbe, {}, { ensure: false }),
    { ok: true, length: 16000, value: "微信发送" }
  );
  const scriptScopeProbe = `$matched = $null\n$callback = { $script:matched = "bound" }\n& $callback\n@{ ok = $true; matched = $matched } | ConvertTo-Json -Compress`;
  assert.deepEqual(runPowerShell(scriptScopeProbe, {}, { ensure: false }), { ok: true, matched: "bound" });
  assert.deepEqual(
    runPowerShell('@{ ok = $false; reason = "probe_reason" } | ConvertTo-Json -Compress\nexit', {}, { ensure: false }),
    { ok: false, reason: "probe_reason" }
  );
  assert.deepEqual(runPowerShell("exit 7", {}, { ensure: false }), { ok: false, reason: "powershell_failed" });

  const task = createTask(
    "{称呼}，您好",
    [
      { id: "task-1", name: "默认名", remark: "备注名", nickname: "昵称", allowed: true },
      { id: "task-2", name: "昵称客户", nickname: "昵称客户", allowed: true },
      { id: "task-3", name: "禁用客户", allowed: false }
    ],
    "2026-07-09T00:00:00.000Z"
  );
  assert.equal(task.total, 2);
  assert.equal(task.results[0].contact.source, "微信通讯录");
  assert.equal(fillTouchTemplate(task.script, task.results[0].contact), "备注名，您好");
  assert.equal(fillTouchTemplate(task.script, task.results[1].contact), "昵称客户，您好");
  task.status = "paused";
  task.results[0].status = "blocked";
  assert.equal(hasUnfinishedPausedTask(task, "{称呼}，您好"), true);
  assert.equal(hasUnfinishedPausedTask(task, "其他话术"), true);
  task.status = "running";
  task.current_index = 1;
  task.results[0].status = "processing";
  assert.equal(publicTaskState(task).task.current_contact.name, "备注名");
  assert.equal(publicTaskState(task).task.next_contact.name, "昵称客户");
  task.results[0].status = "blocked";
  task.status = "paused";
  saveTaskState(dir, task);
  assert.equal(loadTaskState(dir).total, 2);
  assert.equal(fs.existsSync(taskBackupPath(dir)), true);
  const intact = loadTaskState(dir);
  const interrupted = spawnSync(process.execPath, [
    "-e",
    "const fs=require('node:fs'); const file=process.argv[1]; const handle=fs.openSync(file,'w'); fs.writeFileSync(handle,'{\\\"status\\\":'); fs.fsyncSync(handle); fs.closeSync(handle); process.exit(99);",
    `${path.join(dir, "touch_task.json")}.tmp`
  ]);
  assert.equal(interrupted.status, 99);
  assert.equal(loadTaskState(dir).id, intact.id);
  fs.writeFileSync(path.join(dir, "touch_task.json"), "{broken", "utf8");
  const restoredFromBackup = loadTaskState(dir);
  assert.equal(restoredFromBackup.status, "paused");
  assert.equal(restoredFromBackup.recovery_notice, "restored_from_backup");
  fs.writeFileSync(path.join(dir, "touch_task.json"), "{broken", "utf8");
  fs.writeFileSync(taskBackupPath(dir), "{broken", "utf8");
  assert.equal(loadTaskState(dir).integrity_error, "task_state_corrupt");
  saveTaskState(dir, task);
  fs.writeFileSync(path.join(dir, "touch_task.json"), `\uFEFF${JSON.stringify(task)}`, "utf8");
  assert.equal(loadTaskState(dir).total, 2);
  task.status = "running";
  task.current_index = 1;
  task.results[1].status = "processing";
  saveTaskState(dir, task);
  const recoveredTask = recoverInterruptedTask(dir);
  assert.equal(recoveredTask.status, "paused");
  assert.equal(recoveredTask.results[1].status, "pending");

  const validContacts = Array.from({ length: 51 }, (_, index) => ({
    id: `wxid_batch_${index + 1}`,
    name: `批次客户${index + 1}`,
    remark: `批次客户${index + 1}`,
    nickname: `昵称${index + 1}`,
    wxid: `wxid_batch_${index + 1}`,
    wechatId: `batch-${index + 1}`,
    wechatAccountId: "account-a",
    syncedAt: "2026-07-11T00:00:00.000Z",
    allowed: true
  }));
  const classified = classifyContacts([
    ...validContacts,
    { ...validContacts[0], id: "duplicate-name", wxid: "duplicate-name", wechatId: "duplicate-name" },
    { ...validContacts[1], id: "missing-wechat", wxid: "missing-wechat", name: "空微信号", remark: "空微信号", wechatId: "" },
    { ...validContacts[2], id: "disabled", wxid: "disabled", name: "已停用", remark: "已停用", wechatId: "disabled", allowed: false }
  ]);
  assert.equal(classified.eligible.length, 50);
  assert.equal(classified.excluded.filter((row) => row.reason_code === "contact_name_not_unique").length, 2);
  assert.equal(classified.excluded.some((row) => row.reason_code === "wechat_id_missing"), true);
  assert.equal(classified.excluded.some((row) => row.reason_code === "contact_disabled"), true);

  const batchTask = createTask("批量测试", validContacts, "2026-07-11T00:00:00.000Z", { executionMode: "real_send" });
  assert.equal(batchTask.version, 4);
  assert.equal(batchTask.execution_mode, "real_send");
  assert.equal(batchTask.total, 51);
  assert.equal(batchTask.batch_size, 50);
  assert.equal(batchTask.batch_end_index, 50);
  assert.equal(batchTask.results[0].contact.wxid, "wxid_batch_1");
  assert.ok(batchTask.snapshot_hash);
  assert.equal(isBatchAuthorized(batchTask), true);
  assert.equal(isBatchAuthorized({ ...batchTask, snapshot_hash: "changed" }), false);
  assert.equal(isBatchAuthorized({ ...batchTask, current_index: batchTask.batch_end_index }), true);
  const pausedGenerated = createTask("pause", [validContacts[0]], "2026-07-11T00:00:00.000Z", { executionMode: "real_send" });
  pausedGenerated.status = "paused";
  pausedGenerated.phase = "paused";
  pausedGenerated.results[0].status = "generated";
  assert.equal(hasUnfinishedPausedTask(pausedGenerated), true);
  pausedGenerated.results[0].status = "prepared";
  pausedGenerated.results[0].retry_blocked = true;
  assert.equal(hasUnfinishedPausedTask(pausedGenerated), false);
  batchTask.status = "paused";
  batchTask.phase = "awaiting_batch_continue";
  batchTask.current_index = 50;
  const secondBatch = authorizeNextBatch(batchTask, "2026-07-11T00:01:00.000Z");
  assert.equal(secondBatch.status, "running");
  assert.equal(secondBatch.current_batch, 2);
  assert.equal(secondBatch.batch_start_index, 50);
  assert.equal(secondBatch.batch_end_index, 51);
  assert.ok(secondBatch.batch_authorization?.id);
  assert.equal(sendDelayMs(() => 0), 8000);
  assert.equal(sendDelayMs(() => 1), 15000);

  const legacyTask = { ...batchTask, version: 2 };
  delete legacyTask.execution_mode;
  saveTaskState(dir, legacyTask);
  assert.equal(loadTaskState(dir).version, 2);
  assert.notEqual(loadTaskState(dir).execution_mode, "real_send");

  const compatibleV3 = createTask("兼容旧任务", validContacts.slice(0, 2), "2026-07-11T00:00:00.000Z", { executionMode: "real_send" });
  compatibleV3.version = 3;
  compatibleV3.snapshot_hash_version = 1;
  compatibleV3.status = "paused";
  compatibleV3.phase = "awaiting_batch_continue";
  compatibleV3.current_index = 1;
  compatibleV3.results[0].status = "sent_verified";
  compatibleV3.snapshot_hash = crypto.createHash("sha256").update(JSON.stringify({
    script: compatibleV3.script,
    accountId: compatibleV3.wechat_account_id,
    contacts: compatibleV3.results.map((result) => ({ identity_hash: result.identity_hash, contact: result.contact }))
  })).digest("hex");
  fs.writeFileSync(path.join(dir, "touch_task.json"), JSON.stringify(compatibleV3), "utf8");
  const loadedV3 = loadTaskState(dir);
  assert.equal(loadedV3.version, 4);
  assert.equal(loadedV3.current_index, 1);
  assert.equal(loadedV3.results[0].status, "sent_verified");
  assert.equal(loadedV3.phase, "paused");

  const futureTask = { ...createTask("future", [validContacts[0]], "2026-07-11T00:00:00.000Z", { executionMode: "real_send" }), version: 5 };
  saveTaskState(dir, futureTask);
  const blockedFutureTask = loadTaskState(dir);
  assert.equal(blockedFutureTask.version, 5);
  assert.equal(blockedFutureTask.status, "blocked");
  assert.equal(blockedFutureTask.integrity_error, "unsupported_task_version");
  assert.equal(recoverInterruptedTask(dir).integrity_error, "unsupported_task_version");

  const preparedCrash = createTask("prepared", [validContacts[0]], "2026-07-11T00:00:00.000Z", { executionMode: "real_send" });
  preparedCrash.results[0].status = "sending";
  saveTaskState(dir, preparedCrash);
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
    task_context: { task_id: preparedCrash.id, contact_id: preparedCrash.results[0].id, current_index: 0 },
    real_send_status: "prepared",
    real_send_attempt_key: "prepared-key",
    real_send_attempts: { "prepared-key": "prepared" }
  }), "utf8");
  const preparedRecovered = recoverInterruptedTask(dir);
  assert.equal(preparedRecovered.status, "paused");
  assert.equal(preparedRecovered.results[0].status, "prepared");
  assert.equal(preparedRecovered.results[0].retry_blocked, true);

  const verifiedCrash = createTask("verified", [validContacts[0]], "2026-07-11T00:00:00.000Z", { executionMode: "real_send" });
  verifiedCrash.results[0].status = "sending";
  saveTaskState(dir, verifiedCrash);
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
    task_context: { task_id: verifiedCrash.id, contact_id: verifiedCrash.results[0].id, current_index: 0 },
    real_send_status: "sent_verified",
    real_send_attempt_key: "verified-key",
    real_send_attempts: { "verified-key": "sent_verified" }
  }), "utf8");
  const verifiedRecovered = recoverInterruptedTask(dir);
  assert.equal(verifiedRecovered.results[0].status, "sent_verified");
  assert.equal(verifiedRecovered.current_index, 1);
  assert.equal(verifiedRecovered.status, "completed");

  const unknownAfterRetry = createTask("unknown-restart", [validContacts[0]], "2026-07-11T00:00:00.000Z", { executionMode: "real_send" });
  unknownAfterRetry.status = "paused";
  unknownAfterRetry.phase = "awaiting_unknown_resolution";
  unknownAfterRetry.results[0].status = "outcome_unknown";
  unknownAfterRetry.results[0].outcome_unknown_retry_count = 1;
  unknownAfterRetry.results[0].outcome_unknown_attempt_keys = ["unknown-retry-key"];
  unknownAfterRetry.results[0].attempt_key = "unknown-retry-key";
  unknownAfterRetry.results[0].awaiting_resolution = true;
  saveTaskState(dir, unknownAfterRetry);
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
    task_context: { task_id: unknownAfterRetry.id, contact_id: unknownAfterRetry.results[0].id, current_index: 0 },
    real_send_status: "outcome_unknown",
    real_send_attempt_key: "unknown-retry-key",
    real_send_attempts: { "unknown-retry-key": "outcome_unknown" }
  }), "utf8");
  const unknownRecovered = recoverInterruptedTask(dir);
  assert.equal(unknownRecovered.status, "paused");
  assert.equal(unknownRecovered.phase, "awaiting_unknown_resolution");
  assert.equal(unknownRecovered.results[0].outcome_unknown_retry_count, 1);
  assert.equal(recoverInterruptedTask(dir).results[0].outcome_unknown_retry_count, 1);
  unknownRecovered.status = "stopped";
  saveTaskState(dir, unknownRecovered);
  const stoppedRecovered = recoverInterruptedTask(dir);
  assert.equal(stoppedRecovered.status, "stopped");
  assert.equal(stoppedRecovered.phase, "awaiting_unknown_resolution");

  const boundaryContacts = Array.from({ length: 101 }, (_, index) => ({
    id: `wxid_boundary_${index + 1}`,
    name: `边界客户${index + 1}`,
    remark: `边界客户${index + 1}`,
    nickname: `边界昵称${index + 1}`,
    wxid: `wxid_boundary_${index + 1}`,
    wechatId: `boundary-${index + 1}`,
    wechatAccountId: "account-boundary",
    allowed: true
  }));
  const firstBatchCrash = createTask("first-boundary", boundaryContacts, "2026-07-11T00:00:00.000Z", { executionMode: "real_send" });
  firstBatchCrash.current_index = 49;
  firstBatchCrash.phase = "sending_batch";
  firstBatchCrash.results[49].status = "sending";
  saveTaskState(dir, firstBatchCrash);
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
    task_context: { task_id: firstBatchCrash.id, contact_id: firstBatchCrash.results[49].id, current_index: 49 },
    real_send_status: "sent_verified",
    real_send_attempt_key: "first-boundary-key",
    real_send_attempts: { "first-boundary-key": "sent_verified" }
  }), "utf8");
  const firstBoundaryRecoveryStarted = Date.now();
  const firstBatchRecovered = recoverInterruptedTask(dir);
  const firstBoundaryDelay = Date.parse(firstBatchRecovered.next_send_not_before) - firstBoundaryRecoveryStarted;
  assert.equal(firstBatchRecovered.current_index, 50);
  assert.equal(firstBatchRecovered.status, "paused");
  assert.equal(firstBatchRecovered.phase, "preparing_batch");
  assert.ok(firstBoundaryDelay >= 8000 && firstBoundaryDelay <= 15100);

  let secondBatchCrash = createTask("second-boundary", boundaryContacts, "2026-07-11T00:00:00.000Z", { executionMode: "real_send" });
  secondBatchCrash.current_index = 50;
  secondBatchCrash.status = "paused";
  secondBatchCrash.phase = "awaiting_batch_continue";
  secondBatchCrash = authorizeNextBatch(secondBatchCrash, "2026-07-11T00:01:00.000Z");
  secondBatchCrash.current_index = 99;
  secondBatchCrash.phase = "sending_batch";
  secondBatchCrash.results[99].status = "sending";
  saveTaskState(dir, secondBatchCrash);
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
    task_context: { task_id: secondBatchCrash.id, contact_id: secondBatchCrash.results[99].id, current_index: 99 },
    real_send_status: "sent_verified",
    real_send_attempt_key: "second-boundary-key",
    real_send_attempts: { "second-boundary-key": "sent_verified" }
  }), "utf8");
  const secondBatchRecovered = recoverInterruptedTask(dir);
  assert.equal(secondBatchRecovered.current_index, 100);
  assert.equal(secondBatchRecovered.status, "paused");
  assert.equal(secondBatchRecovered.phase, "preparing_batch");

  const taskOnlyPrepared = createTask("task-only-prepared", [validContacts[0]], "2026-07-11T00:00:00.000Z", { executionMode: "real_send" });
  taskOnlyPrepared.results[0].status = "prepared";
  saveTaskState(dir, taskOnlyPrepared);
  fs.rmSync(path.join(dir, "state.json"), { force: true });
  const taskOnlyRecovered = recoverInterruptedTask(dir);
  assert.equal(taskOnlyRecovered.status, "paused");
  assert.equal(taskOnlyRecovered.results[0].status, "prepared");
  assert.equal(taskOnlyRecovered.results[0].retry_blocked, true);

  const tamperedSnapshot = createTask("snapshot", [validContacts[0]], "2026-07-11T00:00:00.000Z", { executionMode: "real_send" });
  tamperedSnapshot.results[0].contact.name = "被替换的联系人";
  saveTaskState(dir, tamperedSnapshot);
  assert.equal(loadTaskState(dir).integrity_error, "task_snapshot_changed");

  const sharedRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-shared-send-"));
  const sharedDir = path.join(sharedRuntimeDir, "active_touch");
  const sharedContactSyncDir = path.join(sharedRuntimeDir, "contact_sync");
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.mkdirSync(sharedContactSyncDir, { recursive: true });
  fs.writeFileSync(path.join(sharedContactSyncDir, "state.json"), JSON.stringify({ status: "synced", account_name: "account-a", wechat_root: "D:\\wechat-data\\xwechat_files" }), "utf8");
  const sharedContact = validContacts[0];
  fs.writeFileSync(path.join(sharedDir, "contacts.json"), JSON.stringify([sharedContact]), "utf8");
  saveState(sharedDir, {
    calibrated: true,
    target_selected: true,
    conversation_verified: true,
    conversation_verification_mode: "exact_wechat_id_search",
    search_query: sharedContact.wechatId,
    window_pid: 81,
    window_handle: "91",
    window_process_name: "Weixin",
    message_input_done: true,
    message_draft: "共享事务消息",
    selected_customer: sharedContact,
    send_gate_status: "dry_run_passed",
    real_send_status: "not_sent",
    real_send_attempts: {},
    task_context: { task_id: "shared-task", contact_id: sharedContact.id, current_index: 0 }
  });
  const sharedSteps = [];
  const sharedTransitions = [];
  const sharedSessionContexts = [];
  let sharedClicks = 0;
  const sharedResult = await executeVerifiedContactSend({
    baseDir: sharedDir,
    contactId: sharedContact.id,
    message: "共享事务消息",
    attemptId: "incoming-turn-1",
    expectedIncomingMessage: "客户最新问题",
    expectedIncomingRuntimeId: "incoming-runtime-1",
    frozenContact: sharedContact,
    authorized: true,
    runStep: async (command) => {
      sharedSteps.push(command);
      return { ok: true, state: { selected_customer: sharedContact } };
    },
    sessionDriver: (_title, context) => {
      sharedSessionContexts.push(context);
      return { ok: true, pid: 81, hWnd: "91", processName: "Weixin", title: sharedContact.name, accountId: "account-a", accountVerified: true };
    },
    sendDriver: (_key, context) => {
      sharedClicks += 1;
      assert.equal(context.expectedConversation, sharedContact.name);
      assert.equal(context.expectedMessage, "共享事务消息");
      assert.equal(context.expectedIncomingMessage, "客户最新问题");
      assert.equal(context.expectedIncomingRuntimeId, "incoming-runtime-1");
      return { ok: true, conversationVerified: true, draftVerified: true };
    },
    bubbleVerifier: (_message, context) => context.phase === "before"
      ? { ok: true, snapshot: "before" }
      : { ok: true, exactMatch: true, outgoing: true, isLatest: true, isNew: true, messageText: "共享事务消息" },
    onTransition: (status) => sharedTransitions.push(status)
  });
  assert.equal(sharedResult.ok, true);
  assert.deepEqual(sharedSteps, ["select-customer", "calibrate", "focus-wechat-window", "click-search-result-dry-run", "input-message-dry-run", "send"]);
  assert.deepEqual(sharedTransitions, ["prepared", "clicked", "sent_verified"]);
  assert.deepEqual(sharedSessionContexts.map((context) => context?.wechatRoot), ["D:\\wechat-data\\xwechat_files", "D:\\wechat-data\\xwechat_files"], "real-send account verification must reuse the successful contact-sync root before input and before send");
  assert.deepEqual(sharedSessionContexts.map((context) => context?.expectedAccountId), ["account-a", "account-a"]);
  assert.deepEqual(sharedSessionContexts.map((context) => context?.expectedPid), [81, 81]);
  assert.deepEqual(sharedSessionContexts.map((context) => context?.expectedHWnd), ["91", "91"]);
  assert.deepEqual(sharedSessionContexts.map((context) => context?.allowExactSearchFallback), [true, true]);
  assert.equal(sharedClicks, 1);
  const firstIncomingAttemptKey = crypto.createHash("sha256")
    .update(`incoming-turn-1\n${sharedContact.id}\n共享事务消息`)
    .digest("hex");
  assert.equal(loadState(sharedDir).real_send_attempt_key, firstIncomingAttemptKey, "verified contact sends must scope idempotency to the incoming turn");

  saveState(sharedDir, {
    ...loadState(sharedDir),
    real_send_status: "not_sent",
    real_send_attempt_key: "",
    real_send_armed: true
  });
  const repeatedIncomingTurn = await sendReal(
    sharedDir,
    { message: "共享事务消息", attemptId: "incoming-turn-1", allowRealSend: true, userConfirmed: true },
    () => { throw new Error("same incoming turn must not click send twice"); },
    () => ({ ok: true, pid: 81, hWnd: "91", processName: "Weixin", title: sharedContact.name, accountId: "account-a", accountVerified: true }),
    () => ({ ok: true, snapshot: "before-repeat" })
  );
  assert.equal(repeatedIncomingTurn.blocked_reason, "real_send_already_attempted");

  saveState(sharedDir, { ...loadState(sharedDir), real_send_status: "not_sent", real_send_armed: true });
  const nextIncomingTurn = await sendReal(
    sharedDir,
    { message: "共享事务消息", attemptId: "incoming-turn-2", allowRealSend: true, userConfirmed: true },
    () => ({ ok: true, conversationVerified: true, draftVerified: true }),
    () => ({ ok: true, pid: 81, hWnd: "91", processName: "Weixin", title: sharedContact.name, accountId: "account-a", accountVerified: true }),
    (_message, context) => context.phase === "before"
      ? { ok: true, snapshot: "before-next-turn" }
      : { ok: true, exactMatch: true, outgoing: true, isLatest: true, isNew: true, messageText: "共享事务消息" }
  );
  assert.equal(nextIncomingTurn.ok, true, "same reply text from a different incoming turn must be sendable");

  saveState(sharedDir, { ...loadState(sharedDir), real_send_status: "not_sent", real_send_armed: true });
  const taskScopedFallback = await sendReal(
    sharedDir,
    { message: "共享事务消息", allowRealSend: true, userConfirmed: true },
    () => ({ ok: true, conversationVerified: true, draftVerified: true }),
    () => ({ ok: true, pid: 81, hWnd: "91", processName: "Weixin", title: sharedContact.name, accountId: "account-a", accountVerified: true }),
    (_message, context) => context.phase === "before"
      ? { ok: true, snapshot: "before-task-fallback" }
      : { ok: true, exactMatch: true, outgoing: true, isLatest: true, isNew: true, messageText: "共享事务消息" }
  );
  const taskScopedAttemptKey = crypto.createHash("sha256")
    .update(`shared-task\n${sharedContact.id}\n共享事务消息`)
    .digest("hex");
  assert.equal(taskScopedFallback.state.real_send_attempt_key, taskScopedAttemptKey, "existing active-touch sends must retain task-scoped idempotency");

  saveState(sharedDir, {
    ...loadState(sharedDir),
    real_send_status: "not_sent",
    real_send_attempts: {},
    real_send_attempt_key: "",
    real_send_armed: false
  });
  const guardedSteps = [];
  const guardedSend = await executeVerifiedContactSend({
    baseDir: sharedDir,
    contactId: sharedContact.id,
    message: "共享事务消息",
    frozenContact: sharedContact,
    authorized: true,
    runStep: async (command) => {
      guardedSteps.push(command);
      return { ok: true, state: { selected_customer: sharedContact } };
    },
    sessionDriver: () => ({ ok: true, pid: 81, hWnd: "91", processName: "Weixin", title: sharedContact.name, accountId: "account-a", accountVerified: true }),
    beforeDraft: () => false,
    sendDriver: () => ({ ok: true }),
    bubbleVerifier: () => ({ ok: true, snapshot: "before" })
  });
  assert.equal(guardedSend.blocked_reason, "incoming_message_changed");
  assert.deepEqual(guardedSteps, ["select-customer", "calibrate", "focus-wechat-window", "click-search-result-dry-run"]);

  saveState(sharedDir, {
    ...loadState(sharedDir),
    real_send_status: "not_sent",
    real_send_attempts: {},
    real_send_attempt_key: "",
    real_send_armed: false
  });
  const cancelledSteps = [];
  let cancellationChecks = 0;
  let cancelledClicks = 0;
  const cancelledResult = await executeVerifiedContactSend({
    baseDir: sharedDir,
    contactId: sharedContact.id,
    message: "共享事务消息",
    frozenContact: sharedContact,
    authorized: true,
    shouldContinue: () => ++cancellationChecks < 3,
    runStep: async (command) => {
      cancelledSteps.push(command);
      return { ok: true, state: { selected_customer: sharedContact } };
    },
    sessionDriver: () => ({ ok: true, pid: 81, hWnd: "91", processName: "Weixin", title: sharedContact.name, accountId: "account-a", accountVerified: true }),
    sendDriver: () => { cancelledClicks += 1; return { ok: true }; },
    bubbleVerifier: () => ({ ok: true, snapshot: "before" })
  });
  assert.equal(cancelledResult.action, "task_paused");
  assert.equal(cancelledResult.blocked_reason, "batch_cancelled");
  assert.deepEqual(cancelledSteps, ["select-customer"]);
  assert.equal(cancelledClicks, 0);
  assert.equal(loadState(sharedDir).real_send_armed, false);

  saveState(sharedDir, {
    ...loadState(sharedDir),
    real_send_status: "not_sent",
    real_send_attempts: {},
    real_send_attempt_key: "",
    real_send_armed: false
  });
  const persistFailure = await executeVerifiedContactSend({
    baseDir: sharedDir,
    contactId: sharedContact.id,
    message: "共享事务消息",
    frozenContact: sharedContact,
    authorized: true,
    runStep: async () => ({ ok: true, state: { selected_customer: sharedContact } }),
    sessionDriver: () => ({ ok: true, pid: 81, hWnd: "91", processName: "Weixin", title: sharedContact.name, accountId: "account-a", accountVerified: true }),
    sendDriver: () => { sharedClicks += 1; return { ok: true }; },
    bubbleVerifier: () => ({ ok: true, snapshot: "before" }),
    onTransition: (status) => { if (status === "prepared") throw new Error("task-save-failed"); }
  });
  assert.equal(persistFailure.blocked_reason, "prepared_task_persist_failed");
  assert.equal(sharedClicks, 1);
  fs.rmSync(sharedDir, { recursive: true, force: true });

  const contextTask = createTask("测试", [{ id: "context-a", name: "A" }, { id: "context-b", name: "B" }]);
  saveTaskState(dir, contextTask);
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify([{ id: "context-a", name: "A", allowed: true }]), "utf8");
  const missingContext = runActiveTouchCli(["node", "active_touch_cli.cjs", "input-message-dry-run", "--data-dir", dir, "--message", "hello"]);
  assert.equal(missingContext.blocked_reason, "task_context_missing");
  const mismatchedContext = runActiveTouchCli([
    "node", "active_touch_cli.cjs", "input-message-dry-run", "--data-dir", dir, "--message", "hello",
    "--task-id", contextTask.id, "--contact-id", "context-b", "--current-index", "0"
  ]);
  assert.equal(mismatchedContext.blocked_reason, "task_context_mismatch");
  const selected = runActiveTouchCli([
    "node", "active_touch_cli.cjs", "select-customer", "--data-dir", dir, "--id", "context-a",
    "--task-id", contextTask.id, "--contact-id", "context-a", "--current-index", "0"
  ]);
  assert.equal(selected.ok, true);
  saveState(dir, {
    ...selected.state,
    selected_customer: { id: "context-b", name: "B" }
  });
  const executorMismatch = runActiveTouchCli([
    "node", "active_touch_cli.cjs", "input-message-dry-run", "--data-dir", dir, "--message", "hello",
    "--task-id", contextTask.id, "--contact-id", "context-a", "--current-index", "0"
  ]);
  assert.equal(executorMismatch.blocked_reason, "executor_contact_mismatch");
  clearCustomer(dir);
  fs.writeFileSync(path.join(dir, "run_logs.jsonl"), `${Array.from({ length: 2000 }, (_, index) => JSON.stringify({ index, text: "x".repeat(300) })).join("\n")}\n`, "utf8");
  assert.equal(cleanupTaskCache(dir).logTrimmed, true);
  assert.ok(fs.readFileSync(path.join(dir, "run_logs.jsonl"), "utf8").split(/\r?\n/).length <= 502);

  assert.equal(send(dir, { dryRun: true, message: "hello" }).blocked_reason, "not_calibrated");
  calibrate(dir);
  assert.equal(focusWechatWindowDryRun(dir, () => ({ ok: false, reason: "wechat_focus_failed" })).blocked_reason, "wechat_focus_failed");
  assert.equal(focusWechatWindowDryRun(dir, () => ({ ok: true, title: "企业微信", processName: "WXWork" })).state.last_result, "wechat_window_focused");
  assert.equal(send(dir, { dryRun: true, message: "hello" }).blocked_reason, "no_whitelist_customer");

  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify([{ id: "wxid_internal", name: "测试客户", wxid: "wxid_internal", wechatId: "internal-test-001", wechatAccountId: "internal-account", allowed: true }]), "utf8");
  assert.equal(status(dir).contacts.length, 1);
  assert.equal(verifyConversation(dir, "测试客户").blocked_reason, "no_whitelist_customer");
  assert.equal(selectCustomer(dir, "wxid_internal").state.selected_customer.name, "测试客户");
  assert.equal(send(dir, { dryRun: true, message: "hello" }).blocked_reason, "conversation_not_verified");
  assert.equal(inputMessageDryRun(dir, "hello", () => ({ ok: true })).blocked_reason, "conversation_not_verified");
  assert.equal(locateConversation(dir, () => ["其他窗口"]).blocked_reason, "conversation_window_not_found");
  assert.equal(locateConversation(dir, () => ["测试客户 - 企业微信"]).state.conversation_located, true);
  assert.equal(verifyWindowTitle(dir, () => ["测试客户 - 企业微信"]).state.conversation_verified, true);
  const openNoWindow = openConversationDryRun(dir, () => ({ ok: false }), () => []);
  assert.equal(openNoWindow.blocked_reason, "wechat_window_not_found");
  assert.equal(openNoWindow.state.conversation_located, false);
  assert.equal(openConversationDryRun(dir, () => ({ ok: false, reason: "wechat_focus_failed" }), () => []).blocked_reason, "wechat_focus_failed");
  assert.equal(
    openConversationDryRun(dir, () => ({ ok: true, title: "企业微信" }), () => ["企业微信"]).blocked_reason,
    "customer_conversation_not_found"
  );
  assert.equal(openConversationDryRun(dir, () => ({ ok: true, title: "企业微信" }), () => ["测试客户 - 企业微信"]).ok, true);
  assert.equal(searchConversationDryRun(dir, () => ({ ok: false }), () => []).blocked_reason, "wechat_window_not_found");
  let searchQuery = "";
  searchConversationDryRun(dir, (query) => {
    searchQuery = query;
    return { ok: true, title: "企业微信" };
  }, () => ["企业微信"]);
  assert.equal(searchQuery, "internal-test-001");
  const searchOnly = searchConversationDryRun(dir, () => ({ ok: true, title: "企业微信" }), () => ["企业微信"]);
  assert.equal(searchOnly.state.search_input_done, true);
  assert.equal(searchOnly.state.conversation_verified, false);
  assert.equal(
    searchConversationDryRun(dir, () => ({ ok: true, title: "企业微信" }), () => ["测试客户 - 企业微信"]).state.conversation_verified,
    true
  );
  const clickNoWindow = clickSearchResultDryRun(dir, () => ({ ok: false }), () => []);
  assert.equal(clickNoWindow.blocked_reason, "wechat_window_not_found");
  assert.equal(clickNoWindow.state.conversation_located, false);
  const clickMismatch = clickSearchResultDryRun(dir, () => ({ ok: true, title: "企业微信" }), () => ["企业微信"], () => ({ ok: false }));
  assert.equal(clickMismatch.blocked_reason, "search_result_not_opened");
  assert.equal(clickMismatch.state.conversation_located, false);
  const clickExactWechatIdFallback = clickSearchResultDryRun(
    dir,
    () => ({
      ok: true,
      title: "微信",
      processName: "Weixin",
      pid: 11,
      hWnd: "22",
      exactSearchOpened: true,
      searchQuery: "internal-test-001"
    }),
    () => ["微信"],
    () => ({ ok: false })
  );
  assert.equal(clickExactWechatIdFallback.ok, true);
  assert.equal(clickExactWechatIdFallback.state.conversation_verification_mode, "exact_wechat_id_search");
  assert.equal(clickExactWechatIdFallback.state.window_pid, 11);
  assert.equal(clickExactWechatIdFallback.state.window_handle, "22");
  const unavailableContact = clickSearchResultDryRun(
    dir,
    () => ({ ok: true, title: "微信" }),
    () => ["微信"],
    () => ({ ok: false, reason: "contact_unavailable", title: "已停用的微信用户" })
  );
  assert.equal(unavailableContact.blocked_reason, "contact_unavailable");
  assert.equal(
    clickSearchResultDryRun(dir, () => ({ ok: true, title: "企业微信" }), () => ["企业微信"], () => ({ ok: true, title: "测试客户" })).state.search_result_clicked,
    true
  );
  assert.equal(
    clickSearchResultDryRun(dir, () => ({ ok: true, title: "企业微信" }), () => ["测试客户 - 企业微信"], () => ({ ok: false })).state.search_result_clicked,
    true
  );
  assert.equal(verifyConversation(dir, "其他客户").blocked_reason, "conversation_mismatch");
  assert.equal(verifyConversation(dir, "测试客户").state.conversation_verified, true);
  assert.equal(send(dir, { dryRun: true, message: "hello" }).blocked_reason, "message_not_input");
  assert.equal(inputMessageDryRun(dir, "", () => ({ ok: true })).blocked_reason, "empty_message");
  assert.equal(inputMessageDryRun(dir, "hello", () => ({ ok: false })).blocked_reason, "message_input_failed");
  assert.equal(inputMessageDryRun(dir, "hello", () => ({ ok: true, draftVerified: false })).blocked_reason, "message_input_failed");
  assert.equal(inputMessageDryRun(dir, "hello", () => ({ ok: true })).blocked_reason, "message_input_failed");
  assert.equal(
    inputMessageDryRun(dir, "hello", () => ({ ok: true, draftVerified: false, draftCheck: "wechat_focus_lost_after_paste", draftAttempts: 2 })).blocked_reason,
    "message_input_failed_wechat_focus_lost_after_paste_attempts_2"
  );
  const inputWithAdaptivePoint = inputMessageDryRun(dir, "hello", () => ({ ok: true, title: "测试客户 - 企业微信", draftVerified: true, draftPoint: { xRatio: 0.65, yRatio: 0.84 } }));
  assert.equal(inputWithAdaptivePoint.state.message_input_done, true);
  assert.deepEqual(inputWithAdaptivePoint.state.message_input_point, { xRatio: 0.65, yRatio: 0.84 });
  assert.equal(send(dir, { dryRun: true, message: "changed" }).blocked_reason, "message_draft_changed");
  assert.equal(verifySendResultDryRun(dir, () => ["测试客户 - 企业微信"]).blocked_reason, "send_gate_not_passed");
  assert.equal(setRealSendArm(dir, true).blocked_reason, "send_gate_not_passed");
  assert.equal(send(dir, { dryRun: true, message: "hello" }).state.send_gate_status, "dry_run_passed");
  assert.equal(verifySendResultDryRun(dir, () => ["其他窗口"]).blocked_reason, "post_send_conversation_mismatch");
  assert.equal(verifySendResultDryRun(dir, () => ["测试客户 - 企业微信"]).state.post_send_verified, true);
  assert.equal((await sendReal(dir, { message: "hello" })).blocked_reason, "real_send_not_armed");
  assert.equal(send(dir, { dryRun: true, message: "hello" }).state.send_gate_status, "dry_run_passed");
  assert.equal(setRealSendArm(dir, true).blocked_reason, "real_send_session_not_verified");
  saveState(dir, { ...loadState(dir), wechat_account_id: "" });
  assert.equal(verifyRealSendSession(dir, () => ({ ok: true, pid: 11, hWnd: "22", processName: "Weixin", title: "测试客户", accountId: "", accountVerified: false })).blocked_reason, "wechat_account_not_verified");
  assert.equal(verifyRealSendSession(dir, () => ({ ok: true, pid: 11, hWnd: "22", processName: "Weixin", title: "测试客户", accountId: "other-account", accountVerified: true })).blocked_reason, "wechat_account_changed");
  assert.equal(verifyRealSendSession(dir, () => ({ ok: true, pid: 11, hWnd: "22", processName: "Weixin", title: "测试客户", accountId: "internal-account", accountVerified: true })).ok, true);
  saveState(dir, {
    ...loadState(dir),
    real_send_clicked: true,
    real_send_status: "outcome_unknown",
    real_send_attempt_key: "refresh-session-key",
    real_send_attempts: { "refresh-session-key": "outcome_unknown" },
    window_pid: 11,
    window_handle: "22"
  });
  const refreshedUnknownSession = refreshRealSendSession(dir, () => ({ ok: true, pid: 21, hWnd: "32", processName: "Weixin", title: "测试客户", accountId: "internal-account", accountVerified: true }));
  assert.equal(refreshedUnknownSession.ok, true);
  assert.equal(loadState(dir).window_pid, 21);
  assert.equal(loadState(dir).window_handle, "32");
  assert.equal(loadState(dir).real_send_status, "outcome_unknown");
  assert.equal(loadState(dir).real_send_clicked, true);
  assert.equal(loadState(dir).real_send_attempts["refresh-session-key"], "outcome_unknown");
  assert.equal(send(dir, { dryRun: true, message: "hello" }).state.send_gate_status, "dry_run_passed");
  assert.equal(setRealSendArm(dir, true).state.real_send_armed, true);
  assert.equal((await sendReal(dir, { message: "hello" })).blocked_reason, "real_send_explicit_allow_missing");
  assert.equal(verifyMessageBubble(dir, () => ({ ok: true })).blocked_reason, "real_send_not_clicked");
  assert.equal(send(dir, { dryRun: true, message: "hello" }).state.send_gate_status, "dry_run_passed");
  assert.equal(verifyRealSendSession(dir, () => ({ ok: true, pid: 11, hWnd: "22", processName: "Weixin", title: "测试客户", accountId: "internal-account", accountVerified: true })).ok, true);
  assert.equal(send(dir, { dryRun: true, message: "hello" }).state.send_gate_status, "dry_run_passed");
  assert.equal(setRealSendArm(dir, true).state.real_send_armed, true);
  assert.equal((await sendReal(dir, { message: "hello", allowRealSend: true })).blocked_reason, "real_send_final_confirmation_missing");
  send(dir, { dryRun: true, message: "hello" });
  verifyRealSendSession(dir, () => ({ ok: true, pid: 11, hWnd: "22", processName: "Weixin", title: "测试客户", accountId: "internal-account", accountVerified: true }));
  setRealSendArm(dir, true);
  let legacySendCalls = 0;
  const legacyBubbleResult = await sendReal(
    dir,
    { message: "hello", allowRealSend: true, userConfirmed: true },
    () => { legacySendCalls += 1; return { ok: true }; },
    () => ({ ok: true, pid: 11, hWnd: "22", processName: "Weixin", title: "测试客户", accountId: "internal-account", accountVerified: true }),
    () => ({ ok: true })
  );
  assert.equal(legacyBubbleResult.blocked_reason, "message_snapshot_unavailable");
  assert.equal(legacySendCalls, 0);
  send(dir, { dryRun: true, message: "hello" });
  verifyRealSendSession(dir, () => ({ ok: true, pid: 11, hWnd: "22", processName: "Weixin", title: "测试客户", accountId: "internal-account", accountVerified: true }));
  setRealSendArm(dir, true);
  const bubblePhases = [];
  const sent = await sendReal(
    dir,
    { message: "hello", allowRealSend: true, userConfirmed: true },
    () => {
      assert.equal(loadState(dir).real_send_status, "prepared");
      assert.deepEqual(loadState(dir).message_bubble_snapshot_before, { lastMessageId: "before-1" });
      return { ok: true, title: "测试客户 - 微信", conversationVerified: true, draftVerified: true };
    },
    () => ({ ok: true, pid: 11, hWnd: "22", processName: "Weixin", title: "测试客户", accountId: "internal-account", accountVerified: true }),
    (message, context) => {
      bubblePhases.push(context.phase);
      if (context.phase === "before") return { ok: true, snapshot: { lastMessageId: "before-1" } };
      assert.equal(message, "hello");
      assert.deepEqual(context.beforeSnapshot, { lastMessageId: "before-1" });
      return { ok: true, title: "测试客户 - 微信", messageText: "hello", exactMatch: true, outgoing: true, isLatest: true, isNew: true };
    }
  );
  assert.deepEqual(bubblePhases, ["before", "after"]);
  assert.equal(sent.state.real_send_status, "sent_verified");
  assert.equal(setRealSendArm(dir, true).blocked_reason, "real_send_already_attempted");
  assert.equal(setRealSendArm(dir, false).state.real_send_status, "sent_verified");
  clearCustomer(dir);
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify([{ id: "wxid_draft_consumed", name: "Draft fallback", wxid: "wxid_draft_consumed", wechatId: "internal-test-007", wechatAccountId: "internal-account", allowed: true }]), "utf8");
  selectCustomer(dir, "wxid_draft_consumed");
  verifyConversation(dir, "Draft fallback");
  inputMessageDryRun(dir, "third", () => ({ ok: true, draftVerified: true }));
  send(dir, { dryRun: true, message: "third" });
  verifyRealSendSession(dir, () => ({ ok: true, pid: 17, hWnd: "28", processName: "Weixin", title: "Draft fallback", accountId: "internal-account", accountVerified: true }));
  setRealSendArm(dir, true);
  const draftConsumed = await sendReal(
    dir,
    { message: "third", allowRealSend: true, userConfirmed: true },
    () => ({ ok: true, title: "微信", conversationVerified: true, draftVerified: true }),
    () => ({ ok: true, pid: 17, hWnd: "28", processName: "Weixin", title: "Draft fallback", accountId: "internal-account", accountVerified: true }),
    (_message, context) => context.phase === "before"
      ? { ok: true, snapshot: { runtimeIds: [], exactCount: 0, draftExact: true } }
      : { ok: true, title: "微信", verificationMode: "draft_consumed", draftConsumed: true, sameWindow: true }
  );
  assert.equal(draftConsumed.state.real_send_status, "sent_verified");
  assert.equal(draftConsumed.state.post_send_status, "draft_consumed_verified");
  assert.equal(draftConsumed.state.message_bubble_verified, false);
  clearCustomer(dir);
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify([{ id: "wxid_unknown", name: "未知结果客户", wxid: "wxid_unknown", wechatId: "internal-test-002", wechatAccountId: "internal-account", allowed: true }]), "utf8");
  selectCustomer(dir, "wxid_unknown");
  verifyConversation(dir, "未知结果客户");
  inputMessageDryRun(dir, "second", () => ({ ok: true, draftVerified: true }));
  send(dir, { dryRun: true, message: "second" });
  verifyRealSendSession(dir, () => ({ ok: true, pid: 12, hWnd: "23", processName: "Weixin", title: "未知结果客户", accountId: "internal-account", accountVerified: true }));
  setRealSendArm(dir, true);
  assert.equal((await sendReal(
    dir,
    { message: "second", allowRealSend: true, userConfirmed: true },
    () => ({ ok: true, conversationVerified: true, draftVerified: true }),
    () => ({ ok: true, pid: 12, hWnd: "23", processName: "Weixin", title: "未知结果客户", accountId: "internal-account", accountVerified: true }),
    (_message, context) => context.phase === "before"
      ? { ok: true, snapshot: { lastMessageId: "history-1" } }
      : { ok: true, messageText: "second", exactMatch: true, outgoing: true, isLatest: true, isNew: false }
  )).state.real_send_status, "outcome_unknown");
  assert.equal(setRealSendArm(dir, false).state.real_send_status, "outcome_unknown");
  assert.equal(verifyMessageBubble(dir, () => ({ ok: true, messageText: "second!", exactMatch: true, outgoing: true, isLatest: true, isNew: true })).state.real_send_status, "outcome_unknown");
  assert.equal(setRealSendArm(dir, true).blocked_reason, "real_send_already_attempted");
  const unknownAttemptKey = loadState(dir).real_send_attempt_key;
  const clearedUnknown = clearCustomer(dir);
  assert.equal(clearedUnknown.state.real_send_attempts[unknownAttemptKey], "outcome_unknown");
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify([{ id: "wxid_window", name: "窗口变化客户", wxid: "wxid_window", wechatId: "internal-test-005", wechatAccountId: "internal-account", allowed: true }]), "utf8");
  selectCustomer(dir, "wxid_window");
  verifyConversation(dir, "窗口变化客户");
  inputMessageDryRun(dir, "window", () => ({ ok: true, draftVerified: true }));
  send(dir, { dryRun: true, message: "window" });
  verifyRealSendSession(dir, () => ({ ok: true, pid: 13, hWnd: "24", processName: "Weixin", title: "窗口变化客户", accountId: "internal-account", accountVerified: true }));
  setRealSendArm(dir, true);
  assert.equal((await sendReal(dir, { message: "window", allowRealSend: true, userConfirmed: true }, () => ({ ok: true }), () => ({ ok: true, pid: 14, hWnd: "25", processName: "Weixin", title: "窗口变化客户", accountId: "internal-account", accountVerified: true }))).blocked_reason, "real_send_session_changed");
  clearCustomer(dir);
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify([{ id: "wxid_exception", name: "验证异常客户", wechatId: "internal-test-006", wechatAccountId: "internal-account", allowed: true }]), "utf8");
  selectCustomer(dir, "wxid_exception");
  verifyConversation(dir, "验证异常客户");
  inputMessageDryRun(dir, "exception", () => ({ ok: true, draftVerified: true }));
  send(dir, { dryRun: true, message: "exception" });
  verifyRealSendSession(dir, () => ({ ok: true, pid: 15, hWnd: "26", processName: "Weixin", title: "验证异常客户", accountId: "internal-account", accountVerified: true }));
  setRealSendArm(dir, true);
  assert.equal((await sendReal(
    dir,
    { message: "exception", allowRealSend: true, userConfirmed: true },
    () => ({ ok: true, conversationVerified: true, draftVerified: true }),
    () => ({ ok: true, pid: 15, hWnd: "26", processName: "Weixin", title: "验证异常客户", accountId: "internal-account", accountVerified: true }),
    (_message, context) => {
      if (context.phase === "before") return { ok: true, snapshot: { lastMessageId: "before-exception" } };
      throw new Error("bubble verifier failed");
    }
  )).state.real_send_status, "outcome_unknown");
  clearCustomer(dir);
  fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify([
    { id: "dup-a", name: "同名客户", wechatId: "internal-test-003", wechatAccountId: "internal-account", allowed: true },
    { id: "dup-b", name: "同名客户", wechatId: "internal-test-004", wechatAccountId: "internal-account", allowed: true }
  ]), "utf8");
  selectCustomer(dir, "dup-a");
  verifyConversation(dir, "同名客户");
  inputMessageDryRun(dir, "duplicate", () => ({ ok: true, draftVerified: true }));
  send(dir, { dryRun: true, message: "duplicate" });
  verifyRealSendSession(dir, () => ({ ok: true, pid: 13, hWnd: "24", processName: "Weixin", title: "同名客户", accountId: "internal-account", accountVerified: true }));
  assert.equal(setRealSendArm(dir, true).blocked_reason, "contact_name_not_unique");
  saveState(dir, { ...loadState(dir), real_send_armed: false, real_send_status: "prepared", real_send_attempts: { crash_attempt: "prepared" } });
  assert.equal(setRealSendArm(dir, true).blocked_reason, "real_send_already_attempted");
  assert.equal(setRealSendArm(dir, false).state.real_send_armed, false);
  const cleared = clearCustomer(dir);
  assert.equal(cleared.state.calibrated, true);
  assert.equal(cleared.state.real_send_attempts.crash_attempt, "prepared");
  assert.equal(cleared.state.target_selected, false);
  assert.equal(cleared.state.selected_customer, null);
  assert.equal(cleared.state.conversation_located, false);
  assert.equal(send(dir, { dryRun: true, message: "hello" }).blocked_reason, "no_whitelist_customer");

  fs.writeFileSync(
    path.join(dir, "contacts.json"),
    JSON.stringify([
      { id: "q1", name: "Queue A", allowed: true },
      { id: "q2", name: "Queue B", allowed: true },
      { id: "q3", name: "Queue C", allowed: true },
      { id: "q4", name: "Queue D", allowed: true }
    ]),
    "utf8"
  );
  assert.equal(queueDryRun(dir, [], "hello").blocked_reason, "queue_empty");
  assert.equal(queueDryRun(dir, ["q1", "q2", "q3", "q4"], "hello").blocked_reason, "queue_limit_exceeded");
  assert.equal(queueDryRun(dir, ["q1"], "").blocked_reason, "empty_message");
  assert.equal(queueDryRun(dir, ["q1", "missing"], "hello").blocked_reason, "queue_customer_not_found");
  assert.equal(
    queueDryRun(
      dir,
      ["q1"],
      "hello",
      () => ({ ok: true, title: "微信" }),
      () => ({ ok: true, title: "微信", draftVerified: false }),
      () => ["Queue A - 微信"],
      () => ({ ok: true })
    ).blocked_reason,
    "queue_message_input_failed"
  );
  const queueResult = queueDryRun(
    dir,
    ["q1", "q2"],
    "hello",
    () => ({ ok: true, title: "微信" }),
    () => ({ ok: true, title: "微信", draftVerified: true }),
    () => ["Queue A - 微信", "Queue B - 微信"],
    () => ({ ok: true })
  );
  assert.equal(queueResult.state.queue_dry_run_passed, true);
  assert.equal(queueResult.state.queue_dry_run_count, 2);
  assert.equal(queueResult.state.queue_dry_run_results.length, 2);
  assert.equal(queueResult.state.selected_customer.name, "Queue B");
  assert.equal(queueResult.state.real_send_clicked, false);

  const driverSource = fs.readFileSync(path.join(__dirname, "wechat_window_driver.cjs"), "utf8");
  const messageDraftSource = driverSource.split("const MESSAGE_DRAFT_SCRIPT = `")[1].split("`;")[0];
  const developmentDriverSource = fs.readFileSync(path.join(__dirname, "wechat_window_driver.dev.cjs"), "utf8");
  const sendMessageSource = developmentDriverSource.split("const SEND_MESSAGE_SCRIPT = `")[1].split("`;")[0];
  const clickSendSource = developmentDriverSource.split("function clickWechatSendButton")[1].split("const DETECT_ACTIVE_ACCOUNT_SCRIPT")[0];
  const bubbleVerifierSource = developmentDriverSource.split("function verifyWechatMessageBubble")[1].split("module.exports")[0];
  assert.equal(driverSource.includes("clickWechatSendButton"), false);
  assert.equal(driverSource.includes("SEND_MESSAGE_SCRIPT"), false);
  assert.equal(driverSource.includes("XIAOXI_SEND_KEY"), false);
  assert.equal(driverSource.includes("verifyWechatMessageBubble"), false);
  assert.match(messageDraftSource, /SendWait\("\^a"\)[\s\S]*Set-Clipboard -Value \$message[\s\S]*SendWait\("\^v"\)/);
  assert.match(messageDraftSource, /SendWait\("\^c"\)/);
  assert.match(messageDraftSource, /draftCheck = "clipboard_roundtrip"/);
  assert.match(messageDraftSource, /function Normalize-WechatDraftText/);
  assert.match(messageDraftSource, /Replace\(\[Environment\]::NewLine, \[string\]\[char\]10\)/);
  assert.match(messageDraftSource, /Replace\(\[string\]\[char\]13, \[string\]\[char\]10\)/);
  assert.match(messageDraftSource, /TrimEnd\(\[char\[\]\]@\(\[char\]0xFFFC\)\)/);
  assert.match(messageDraftSource, /\$normalizedCopiedDraft -ceq \$normalizedMessage/);
  assert.match(messageDraftSource, /\$inputPoints = @\([\s\S]*yRatio = 0\.84[\s\S]*yRatio = 0\.88[\s\S]*yRatio = 0\.92/);
  assert.match(messageDraftSource, /for \(\$attempt = 1; \$attempt -le \$inputPoints\.Count; \$attempt\+\+\)[\s\S]*SendWait\("\^a"\)[\s\S]*SendWait\("\^v"\)[\s\S]*if \(\$draftVerified\) \{[\s\S]*break/);
  assert.match(messageDraftSource, /draftPoint = \$usedPoint/);
  assert.match(messageDraftSource, /wechat_focus_lost_after_paste/);
  assert.match(messageDraftSource, /message_input_empty_or_copy_blocked/);
  assert.match(messageDraftSource, /message_input_content_mismatch/);
  assert.match(developmentDriverSource, /function clickWechatSendButton/);
  assert.match(developmentDriverSource, /atomic_conversation_changed/);
  assert.match(developmentDriverSource, /atomic_draft_changed/);
  assert.match(developmentDriverSource, /function Normalize-WechatDraftText/);
  assert.match(sendMessageSource, /conversationVerified = \$true[\s\S]*draftVerified = \(Normalize-WechatDraftText \$copiedDraft\) -ceq \$normalizedExpectedMessage/);
  assert.match(sendMessageSource, /atomic_expected_window_not_found/);
  assert.doesNotMatch(sendMessageSource, /\(Get-ElementText \$element\) -cne "发送"/);
  assert.doesNotMatch(sendMessageSource, /InvokePattern/);
  assert.doesNotMatch(sendMessageSource, /\$sendCandidates/);
  assert.match(sendMessageSource, /GetDpiForWindow/);
  assert.match(sendMessageSource, /\$sendRightOffsetDip = 64/);
  assert.match(sendMessageSource, /\$sendBottomOffsetDip = 42/);
  assert.match(sendMessageSource, /\$clickRect = \$root\.Current\.BoundingRectangle/);
  assert.doesNotMatch(sendMessageSource, /GetWindowRect\([^\r\n]*clickRect/);
  assert.match(sendMessageSource, /wechat_send_point_invalid/);
  assert.match(sendMessageSource, /WindowFromPoint\(\$sendPoint\)[\s\S]*GetAncestor\(\$pointWindow, 2\)[\s\S]*wechat_send_point_obscured[\s\S]*\$sendAttempted = \$true/);
  assert.match(sendMessageSource, /XIAOXI_EXPECTED_INCOMING_MESSAGE/);
  assert.match(sendMessageSource, /XIAOXI_EXPECTED_INCOMING_RUNTIME_ID/);
  assert.match(sendMessageSource, /function Get-ElementKey/);
  assert.match(sendMessageSource, /chat_message_list[\s\S]*incoming_message_changed[\s\S]*\$sendAttempted = \$true/, "the atomic click script must revalidate the latest incoming bubble before the send attempt");
  assert.match(sendMessageSource, /\$conversationElement[\s\S]*atomic_conversation_changed/);
  assert.match(sendMessageSource, /GetCursorPos\(\[ref\]\$sendPoint\)[\s\S]*wechat_send_cursor_mismatch/);
  assert.match(sendMessageSource, /SetCursorPos\(\$sendX, \$sendY\)[\s\S]*mouse_event\(0x0002[\s\S]*mouse_event\(0x0004/);
  assert.equal(sendMessageSource.includes("SendWait($sendKey)"), false);
  assert.equal(sendMessageSource.includes("XIAOXI_SEND_KEY"), false);
  assert.match(clickSendSource, /runPowerShell\(SEND_MESSAGE_SCRIPT,[\s\S]*\{ ensure: false \}\);/);
  assert.match(bubbleVerifierSource, /\}, \{ ensure: false \}\);/);
  assert.match(driverSource, /"powershell_timeout"/);
  assert.match(driverSource, /"powershell_failed"/);
  assert.match(driverSource, /"powershell_output_invalid"/);
  assert.match(developmentDriverSource, /context\.phase === "after" \? "after" : "before"/);
  assert.match(developmentDriverSource, /beforeSnapshot/);
  assert.match(developmentDriverSource, /exactMatch/);
  assert.match(developmentDriverSource, /outgoing/);
  assert.match(developmentDriverSource, /isLatest/);
  assert.match(developmentDriverSource, /isNew/);
  assert.match(developmentDriverSource, /function detectActiveWechatAccount/);
  assert.match(developmentDriverSource, /XIAOXI_WECHAT_ROOT/);
  assert.match(developmentDriverSource, /XIAOXI_EXPECTED_ACCOUNT_ID/);
  assert.match(developmentDriverSource, /allowExactSearchFallback/);
  assert.match(developmentDriverSource, /\*\.db-wal/);
  assert.match(developmentDriverSource, /wechat_account_ambiguous/);
  assert.match(developmentDriverSource, /\$outgoingExact\.Count -gt \$beforeExactCount/);
  assert.match(developmentDriverSource, /draftExact/);
  assert.match(developmentDriverSource, /draftConsumed/);
  assert.match(developmentDriverSource, /elseif \(\$draftConsumed\) \{ "draft_consumed" \}/);
  assert.match(developmentDriverSource, /XIAOXI_INPUT_X_RATIO/);
  assert.match(developmentDriverSource, /XIAOXI_INPUT_Y_RATIO/);
  assert.ok(driverSource.includes('$processNames = @("Weixin", "WeChat")'));
  assert.equal(driverSource.includes("$name.Contains($expected)"), false);
  assert.match(driverSource, /\$name\.Trim\(\) -ne \$expected\.Trim\(\)/);
  assert.equal(driverSource.includes("WXWork"), false);
  assert.equal(driverSource.includes("WeChatAppEx"), false);
  assert.doesNotMatch(driverSource, /\$pf86\\\\Tencent\\\\WeChat\\\\WeChat\.exe",\s*\n\s*\)\)/);
  assert.match(driverSource, /const SIMPLE_ENSURE_WECHAT_WINDOW_SCRIPT/);
  assert.match(driverSource, /Buffer\.from\(SIMPLE_ENSURE_WECHAT_WINDOW_SCRIPT/);
  assert.equal(driverSource.includes("if (!ensureResult.ok) return ensureResult;"), false);
  assert.match(driverSource, /if \(Test-VisiblePersonalWechat\) \{ \[void\]\(Focus-PersonalWechatMainWindowByAutomation\) \}/);
  assert.equal(driverSource.includes("XIAOXI_EXPECTED_ACCOUNT"), false);
  const taskIpcSource = fs.readFileSync(path.join(__dirname, "../../src/main/touch-task-ipc.cjs"), "utf8");
  assert.match(taskIpcSource, /function shouldSkipBlockedContact\([^)]*\)[\s\S]*contact_unavailable/);
  const developmentPreloadSource = fs.readFileSync(path.join(__dirname, "../../src/main/preload.dev.cjs"), "utf8");
  assert.match(developmentPreloadSource, /active-touch:dev-select-customer/);
  assert.match(developmentPreloadSource, /active-touch:dev-calibrate/);
  assert.match(developmentPreloadSource, /active-touch:dev-click-search-result/);
  assert.match(developmentPreloadSource, /active-touch:dev-input-message/);
  assert.match(developmentPreloadSource, /active-touch:dev-send-dry-run/);
  assert.match(developmentPreloadSource, /active-touch:send-selected-contact/);
  assert.equal(developmentPreloadSource.includes("active-touch:send-real"), false);
  assert.equal(developmentPreloadSource.includes("sendReal:"), false);
  assert.equal(developmentPreloadSource.includes("real-send-hold"), false);
  const developmentCliSource = fs.readFileSync(path.join(__dirname, "active_touch_cli.dev.cjs"), "utf8");
  assert.equal(developmentCliSource.includes('args.includes("--real")'), false);
  assert.equal(developmentCliSource.includes("--user-confirmed"), false);
  const developmentIpcSource = fs.readFileSync(path.join(__dirname, "../../src/main/active-touch-dev-ipc.cjs"), "utf8");
  assert.match(developmentIpcSource, /clickToken/);
  assert.match(developmentIpcSource, /executeVerifiedContactSend/);
  assert.equal(developmentIpcSource.includes("setRealSendArm(runtimeDataDir, true)"), false);
  const sharedTransactionSource = fs.readFileSync(path.join(__dirname, "state_machine.dev.cjs"), "utf8");
  assert.match(sharedTransactionSource, /async function executeVerifiedContactSend/);
  assert.match(sharedTransactionSource, /async function sendReal[\s\S]*clickWechatSendButtonAsync[\s\S]*verifyWechatCurrentConversationAsync[\s\S]*verifyWechatMessageBubbleAsync/);
  assert.match(sharedTransactionSource, /async function executeVerifiedFileHelperSend[\s\S]*openWechatSearchResultAsync[\s\S]*inputWechatMessageDraftAsync/);
  assert.match(driverSource, /function openWechatSearchResultAsync[\s\S]*runPowerShellAsync/);
  assert.match(developmentDriverSource, /function clickWechatSendButtonAsync[\s\S]*runPowerShellAsync/);
  assert.match(sharedTransactionSource, /beforeDraft/);
  assert.match(sharedTransactionSource, /inputPoint: state\.message_input_point/);
  assert.match(sharedTransactionSource, /select-customer[\s\S]*calibrate[\s\S]*focus-wechat-window[\s\S]*click-search-result-dry-run[\s\S]*verifyRealSendSession[\s\S]*input-message-dry-run[\s\S]*send[\s\S]*dry-run[\s\S]*sendReal/);
  assert.equal(developmentIpcSource.includes("real-send-hold"), false);
  const developmentUiSource = fs.readFileSync(path.join(__dirname, "../../src/renderer/DevelopmentAcceptance.tsx"), "utf8");
  assert.match(developmentUiSource, /sendSelectedContact/);
  assert.match(developmentUiSource, /data-xiaoxi-real-send/);
  assert.match(developmentUiSource, /replaceAll\("\{称呼\}"/);
  assert.match(developmentUiSource, /setStatus\("开发执行器未连接"\)/);
  assert.match(developmentUiSource, /const exactReason = result\.state\?\.real_send_reason;[\s\S]*`发送结果无法确认：\$\{exactReason\}`[\s\S]*result\.blocked_reason/);
  assert.match(developmentUiSource, /<Send size=\{17\} \/>直接发送<\/button>/);
  assert.equal(developmentUiSource.includes("按住3秒"), false);
  assert.equal(developmentUiSource.includes("beginRealSendHold"), false);
  assert.equal(fs.existsSync(path.join(__dirname, "../../src/main/real-send-hold.dev.cjs")), false);
  assert.equal(fs.existsSync(path.join(__dirname, "../../src/main/real-send-hold.self_check.cjs")), false);
  assert.match(driverSource, /\$proc\.MainWindowHandle -eq \$hWnd/);
  assert.match(driverSource, /\$title -eq "微信"/);

  let asyncPowerShellYielded = false;
  const asyncPowerShell = runPowerShellAsync(`$padding = "${"x".repeat(40_000)}"\nStart-Sleep -Milliseconds 50\n@{ ok = $true; length = $padding.Length } | ConvertTo-Json -Compress`, {}, { ensure: false, timeout: 5_000 });
  await new Promise((resolve) => setTimeout(() => { asyncPowerShellYielded = true; resolve(); }, 0));
  const asyncPowerShellResult = await asyncPowerShell;
  assert.equal(asyncPowerShellYielded, true, "async PowerShell must yield the Electron event loop");
  assert.deepEqual(asyncPowerShellResult, { ok: true, length: 40_000 }, "async PowerShell must stream large scripts over stdin instead of the Windows command line");

  saveState(dir, { ...loadState(dir), self_check_marker: true });
  assert.equal(fs.readdirSync(dir).some((name) => name.includes("state.json.tmp")), false);
  fs.writeFileSync(path.join(dir, "state.json"), "{", "utf8");
  assert.throws(() => loadState(dir));

  const handoffCheck = spawnSync(process.execPath, [path.join(__dirname, "file_helper_send.self_check.cjs")], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(handoffCheck.status, 0, handoffCheck.stderr || handoffCheck.stdout || "file-helper send self-check failed");

  console.log("active-touch self-check passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
