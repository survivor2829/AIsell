const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const handlers = new Map();
const windows = [];
let aiFailuresRemaining = new Map([["wxid_batch_2", 1]]);
const taskUpdates = [];
let aiFailureCodes = new Map();
let sessionVerificationResult = { ok: true };
let bubbleVerificationResult = { ok: false, state: { real_send_status: "outcome_unknown" } };
let observedBubbleHandle = "";
class FakeWindow {
  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.listeners = new Map();
    this.webContents = { send(channel, payload) { if (channel === "touch-task:update") taskUpdates.push(payload); } };
    windows.push(this);
  }
  isDestroyed() { return this.destroyed; }
  show() {}
  hide() {}
  focus() {}
  setMenu() {}
  setPosition(x, y) { this.position = { x, y }; }
  on(event, listener) {
    const listeners = this.listeners.get(event) || [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }
  once(event, listener) {
    const wrapped = (...args) => {
      this.listeners.set(event, (this.listeners.get(event) || []).filter((item) => item !== wrapped));
      listener(...args);
    };
    this.on(event, wrapped);
  }
  emit(event, ...args) {
    for (const listener of [...(this.listeners.get(event) || [])]) listener(...args);
  }
  loadFile() {}
  loadURL() {}
  close() {
    if (this.destroyed) return;
    this.emit("close");
    this.destroyed = true;
    this.emit("closed");
  }
}
FakeWindow.getAllWindows = () => windows;

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => os.tmpdir() },
      BrowserWindow: FakeWindow,
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 900 } }) }
    };
  }
  if (request === "./ai-draft.cjs") {
    return {
      generateFixedScriptFallback: ({ task, error }) => {
        const message = String(task?.script || "").trim();
        if (!message) return null;
        const fallbackCode = String(error?.code || "AI_GENERATION_FAILED");
        return {
          message,
          usedAi: false,
          fallbackCode,
          reason: `DeepSeek 文案生成失败（${fallbackCode}），已使用用户确认的固定话术`
        };
      },
      generatePersonalizedDraft: async ({ result }) => {
        const code = aiFailureCodes.get(result.id);
        if (code) {
          const error = new Error(`coded-ai-failure:${code}`);
          error.code = code;
          throw error;
        }
        const failures = aiFailuresRemaining.get(result.id) || 0;
        if (failures > 0) {
          aiFailuresRemaining.set(result.id, failures - 1);
          throw new Error("single-ai-failure");
        }
        return { message: `您好 ${result.name}`, usedAi: true, reason: "" };
      }
    };
  }
  if (request === "./active-touch-ipc.cjs") {
    return {
      runActiveTouch: async (args) => ({
        ok: true,
        action: args[0],
        state: args[0] === "select-customer" ? { selected_customer: currentFrozenContact } : {}
      })
    };
  }
  if (request === "./edition.cjs") return { preloadFile: "preload.cjs", rendererDir: "dist" };
  return originalLoad.call(this, request, parent, isMain);
};

let currentFrozenContact = null;
const modulePath = path.join(__dirname, "touch-task-ipc.cjs");
delete require.cache[require.resolve(modulePath)];
const {
  classifyTaskTransitionDiagnostic,
  registerTouchTaskIpc,
  resultReason
} = require(modulePath);
Module._load = originalLoad;
const { authorizeNextBatch, classifyContacts, createTask, isBatchAuthorized, markPreviousBuildTask, recoverInterruptedTask, saveTaskState } = require("../../rpa/active_touch/touch_task_state.cjs");

assert.deepEqual(
  classifyTaskTransitionDiagnostic(
    { status: "running", pause_reason: "" },
    { status: "generated", ai_status: "fallback", ai_error_code: "API_KEY_MISSING" }
  ),
  { level: "info", code: "" },
  "a successful fixed-script fallback must remain an informational transition"
);
assert.deepEqual(
  classifyTaskTransitionDiagnostic(
    { status: "paused", pause_reason: "用户已暂停" },
    { status: "generated", ai_error_code: "API_KEY_MISSING" }
  ),
  { level: "info", code: "" },
  "a user pause must not be reported as an operational failure"
);
assert.deepEqual(
  classifyTaskTransitionDiagnostic(
    { status: "paused", pause_reason: "窗口未找到" },
    { status: "blocked", reason: "wechat_window_not_found", ai_error_code: "API_KEY_MISSING" }
  ),
  { level: "error", code: "wechat_window_not_found" },
  "the actual workflow blocker must take precedence over an AI fallback code"
);
assert.deepEqual(
  classifyTaskTransitionDiagnostic(
    { status: "paused", pause_reason: "发送结果无法确认" },
    { status: "outcome_unknown", reason: "发送结果无法确认", ai_error_code: "API_KEY_MISSING" }
  ),
  { level: "error", code: "outcome_unknown" },
  "an unknown send outcome must remain visible as a real error"
);
  assert.equal(
    resultReason({
      blocked_reason: "wechat_user_active",
      error: "微信窗口未能固定到左上角并获得前台控制，本次未执行"
    }),
    "电脑尚未达到连续空闲的安全条件，文案未写入微信，正在等待后恢复",
    "an idle preflight must not blame the user for every window-side observation"
  );

assert.match(resultReason({ blocked_reason: "wechat_clipboard_restore_unsupported" }), /特殊格式/);
assert.match(resultReason({ blocked_reason: "wechat_clipboard_read_failed" }), /无法读取剪贴板/);

function contacts(count) {
  return Array.from({ length: count }, (_, index) => ({
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
}

// Fifty simulated contacts persist several atomic snapshots each; hosted Windows
// disk latency must not turn a state-correctness check into a speed benchmark.
async function waitFor(read, predicate, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for task state: ${JSON.stringify(await read())}`);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-touch-task-ipc-"));
  try {
    fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify(contacts(51)), "utf8");
    let sends = 0;
    let clicks = 0;
    let pauseCallbacks = 0;
    const waitedDeadlines = [];
    let executorBehavior = async (options) => {
      assert.equal(options.windowMinIdleMs, 0, "active-touch must not wait on a session-wide idle timer before an authorized send");
      sends += 1;
      currentFrozenContact = options.frozenContact;
      options.onTransition("prepared", { real_send_attempt_key: `attempt-${options.contactId}` });
      clicks += 1;
      options.onTransition("clicked", { real_send_attempt_key: `attempt-${options.contactId}` });
      options.onTransition("sent_verified", { real_send_attempt_key: `attempt-${options.contactId}` });
      return { ok: true, state: { real_send_status: "sent_verified", real_send_attempt_key: `attempt-${options.contactId}` } };
    };
    registerTouchTaskIpc({
      getMainWindow: () => ({ isDestroyed: () => false, hide() {}, show() {}, focus() {} }),
      dataDir: dir,
      coordinator: {
        acquire: () => ({ ok: true, lock: { owner: "runner" } }),
        update: () => ({ ok: true }),
        transition: () => ({ ok: true }),
        release: () => ({ ok: true })
      },
      deepSeekClient: { assertAvailable() {} },
      executionMode: "real_send",
      waitForDelay: async (deadline) => { waitedDeadlines.push(deadline); },
      random: () => 0,
      onPause: () => { pauseCallbacks += 1; },
      realSendExecutor: (options) => executorBehavior(options),
      appVersion: "9.8.7",
      buildId: "build-current",
      buildCommit: "abcdef1234567890",
      verifyRealSendSession: () => {
        const result = sessionVerificationResult;
        if (result.ok && result.pid && result.hWnd) {
          const file = path.join(dir, "state.json");
          const state = JSON.parse(fs.readFileSync(file, "utf8"));
          fs.writeFileSync(file, JSON.stringify({
            ...state,
            window_pid: result.pid,
            window_handle: String(result.hWnd),
            window_process_name: result.processName,
            wechat_account_id: result.accountId
          }), "utf8");
        }
        return result;
      },
      verifyMessageBubble: () => {
        const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
        observedBubbleHandle = String(state.window_handle || "");
        return bubbleVerificationResult;
      }
    });

    const start = handlers.get("touch-task:start");
    const status = handlers.get("touch-task:status");
    const resume = handlers.get("touch-task:resume");
    const stop = handlers.get("touch-task:stop");
    const resolveUnknown = handlers.get("touch-task:resolve-unknown");
    const retrySkipped = handlers.get("touch-task:retry-skipped");
    await start({}, { script: "默认触达话术", clickToken: "trusted-start" });
    assert.deepEqual(
      { width: windows[0].options.width, height: windows[0].options.height, position: windows[0].position },
      { width: 292, height: 286, position: { x: 1286, y: 307 } },
      "active touch must use the shared progress-window footprint and placement"
    );
    const initial = await status();
    assert.equal(initial.task.results.length, 51, "status responses must retain the complete recoverable task snapshot");
    const compactUpdate = taskUpdates.find((payload) => Array.isArray(payload.task?.result_updates));
    assert.ok(compactUpdate, "task events must include compact result updates");
    assert.equal(Object.hasOwn(compactUpdate.task, "results"), false, "task events must not resend every contact result");
    assert.equal(compactUpdate.task.result_updates.length <= 50, true, "task events must stay bounded to the active batch");
    assert.equal((await start({}, { script: "默认触达话术", clickToken: "trusted-start" })).blocked_reason, "trusted_batch_click_required");
    const completed = await waitFor(status, (value) => value.task?.status === "completed");
    assert.equal(completed.task.version, 4);
    assert.equal(completed.task.execution_mode, "real_send");
    assert.equal(completed.task.current_index, 51);
    assert.equal(completed.task.results[1].ai_attempts, 2);
    assert.equal(sends, 51, "one frozen full-task authorization must continue across the 50-contact preparation boundary");
    assert.equal(completed.task.results.filter((result) => result.status === "sent_verified").length, 51);
    assert.ok(waitedDeadlines.length > 0);
    assert.ok(Number.isFinite(Date.parse(completed.task.next_send_not_before)));

    fs.rmSync(path.join(dir, "touch_task.json"), { force: true });
    fs.rmSync(path.join(dir, "touch_task.json.bak"), { force: true });
    let previousBuildTask = createTask("跨版本续跑", contacts(3), "2026-07-11T00:00:00.000Z", {
      executionMode: "real_send",
      sourceBuildId: "build-previous"
    });
    previousBuildTask.results[0].status = "sent_verified";
    previousBuildTask.results[0].retry_blocked = true;
    previousBuildTask.current_index = 1;
    previousBuildTask.status = "paused";
    previousBuildTask.phase = "paused";
    previousBuildTask = markPreviousBuildTask(previousBuildTask, "build-current").task;
    saveTaskState(dir, previousBuildTask);
    const sendsBeforePreviousBuildResume = sends;
    const previousBuildResume = await resume({}, { clickToken: "trusted-previous-build-resume" });
    assert.notEqual(previousBuildResume.blocked_reason, "previous_build_task", "a compatible frozen task must remain resumable after an app update");
    const previousBuildCompleted = await waitFor(status, (value) => value.task?.status === "completed");
    assert.equal(previousBuildCompleted.task.id, previousBuildTask.id, "an app update must continue the same frozen task instead of rebuilding it");
    assert.equal(previousBuildCompleted.task.current_index, 3);
    assert.equal(previousBuildCompleted.task.previous_build_task, false);
    assert.equal(previousBuildCompleted.task.source_build_id, "build-current");
    assert.equal(sends, sendsBeforePreviousBuildResume + 2, "contacts completed before the update must not be sent again");

    fs.rmSync(path.join(dir, "touch_task.json"), { force: true });
    fs.rmSync(path.join(dir, "touch_task.json.bak"), { force: true });
    fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify(contacts(3)), "utf8");
    let contactScopedAttempts = 0;
    executorBehavior = async (options) => {
      contactScopedAttempts += 1;
      if (options.contactId === "wxid_batch_1") {
        return { ok: false, blocked_reason: "exact_search_result_not_found", state: { real_send_status: "not_sent" } };
      }
      if (options.contactId === "wxid_batch_2") {
        return { ok: false, send_attempted: false, blocked_reason: "search_result_identity_unverified", state: { real_send_status: "not_sent" } };
      }
      options.onTransition("sent_verified", { real_send_attempt_key: `isolated-${options.contactId}` });
      return { ok: true, state: { real_send_status: "sent_verified", real_send_attempt_key: `isolated-${options.contactId}` } };
    };
    await start({}, { script: "联系人失败隔离", clickToken: "trusted-contact-isolation" });
    const isolatedFailure = await waitFor(status, (value) => value.task?.status === "completed");
    assert.equal(isolatedFailure.task.results[0].status, "identity_skipped");
    assert.equal(isolatedFailure.task.results[1].status, "identity_skipped");
    assert.equal(isolatedFailure.task.results[2].status, "sent_verified");
    assert.equal(isolatedFailure.task.sent_verified_count, 1);
    assert.deepEqual(isolatedFailure.task.skipped_breakdown, { identity: 2, ai_failed: 0, pre_send: 0, outcome_unknown: 0 });
    assert.equal(isolatedFailure.task.skipped_records.length, 2);
    assert.equal(isolatedFailure.task.results[0].skip_record.reasonCode, "exact_search_result_not_found");
    assert.equal(contactScopedAttempts, 3, "contact-scoped search failures must not pause the remaining task");
    await new Promise((resolve) => setImmediate(resolve));

    fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify(contacts(2)), "utf8");
    let poisonedAttempts = 0;
    executorBehavior = async (options) => {
      poisonedAttempts += 1;
      if (options.contactId === "wxid_batch_1") {
        return {
          ok: false,
          send_attempted: false,
          blocked_reason: "wechat_search_network_lookup_misclick",
          landing_recovered: true,
          poisoned_candidate: { fingerprint: "legacy-ipc-fixture", mode: "unique_local_surface_visual" },
          state: { real_send_status: "not_sent" }
        };
      }
      options.onTransition("sent_verified", { real_send_attempt_key: `poison-next-${options.contactId}` });
      return { ok: true, state: { real_send_status: "sent_verified", real_send_attempt_key: `poison-next-${options.contactId}` } };
    };
    await start({}, { script: "网络查找误点止损", clickToken: "trusted-poison-stop-loss" });
    const poisonedTask = await waitFor(status, (value) => value.task?.status === "completed");
    assert.equal(poisonedAttempts, 2, "a confirmed network lookup misclick must stop after the first attempt and continue later contacts");
    assert.equal(poisonedTask.task.results[0].status, "identity_skipped");
    assert.equal(poisonedTask.task.results[1].status, "sent_verified");
    assert.deepEqual(poisonedTask.task.results[0].poisoned, {
      reason_code: "wechat_search_network_lookup_misclick",
      candidate_fingerprint: "legacy-ipc-fixture",
      candidate_mode: "unique_local_surface_visual",
      recovered: true,
      at: poisonedTask.task.results[0].poisoned.at
    });
    const poisonedBeforeRetry = fs.readFileSync(path.join(dir, "touch_task.json"), "utf8");
    const poisonedRetry = await retrySkipped({}, { contactIds: [poisonedTask.task.results[0].id] });
    assert.equal(poisonedRetry.blocked_reason, "retry_skipped_poisoned_forbidden");
    assert.equal(fs.readFileSync(path.join(dir, "touch_task.json"), "utf8"), poisonedBeforeRetry, "a poisoned retry rejection must not change persisted task state");

    let unrecoveredPoisonAttempts = 0;
    executorBehavior = async () => {
      unrecoveredPoisonAttempts += 1;
      return {
        ok: false,
        send_attempted: false,
        blocked_reason: "wechat_search_network_lookup_misclick",
        landing_recovered: false,
        poisoned_candidate: { fingerprint: "legacy-unrecovered-fixture", mode: "unique_local_uia" },
        state: { real_send_status: "not_sent" }
      };
    };
    await start({}, { script: "网络查找关闭未确认", clickToken: "trusted-unrecovered-poison" });
    const unrecoveredPoison = await waitFor(status, (value) => value.task?.status === "paused");
    assert.equal(unrecoveredPoisonAttempts, 1, "an unrecovered network lookup landing must pause without bounded retry");
    assert.equal(unrecoveredPoison.task.current_index, 0, "an unrecovered landing must not advance to the next contact");
    assert.equal(unrecoveredPoison.task.results[0].poisoned.candidate_fingerprint, "legacy-unrecovered-fixture");
    assert.equal(unrecoveredPoison.task.results[0].poisoned.recovered, false);

    const retryableTask = createTask("跳过项补发", contacts(3), "2026-07-11T00:00:00.000Z", { executionMode: "real_send" });
    retryableTask.results[0] = {
      ...retryableTask.results[0], status: "identity_skipped", reason: "身份不唯一，已跳过", blocked_reason: "search_result_identity_unverified",
      retry_blocked: true, send_attempted: false, message_parts: [{ kind: "text", status: "pending", message: "冻结文案" }]
    };
    retryableTask.results[1] = {
      ...retryableTask.results[1], status: "outcome_unknown", reason: "发送结果未知", retry_blocked: true, send_attempted: null
    };
    retryableTask.results[2] = {
      ...retryableTask.results[2], status: "sent_verified", reason: "发送成功并已核验", retry_blocked: true, send_attempted: true
    };
    retryableTask.current_index = retryableTask.total;
    retryableTask.status = "completed";
    retryableTask.phase = "completed";
    saveTaskState(dir, retryableTask);

    const protectedBefore = fs.readFileSync(path.join(dir, "touch_task.json"), "utf8");
    const unknownRetry = await retrySkipped({}, { contactIds: [retryableTask.results[1].id] });
    assert.equal(unknownRetry.blocked_reason, "retry_skipped_outcome_unknown_forbidden");
    assert.equal(fs.readFileSync(path.join(dir, "touch_task.json"), "utf8"), protectedBefore, "an unknown outcome retry must not change any persisted task state");
    const protectedRetry = await retrySkipped({}, { contactIds: [retryableTask.results[2].id] });
    assert.equal(protectedRetry.blocked_reason, "retry_skipped_sent_verified_forbidden");
    assert.equal(fs.readFileSync(path.join(dir, "touch_task.json"), "utf8"), protectedBefore, "a rejected retry must not change any persisted task state");

    retryableTask.status = "running";
    saveTaskState(dir, retryableTask);
    const runningBefore = fs.readFileSync(path.join(dir, "touch_task.json"), "utf8");
    const runningRetry = await retrySkipped({}, { contactIds: [retryableTask.results[0].id] });
    assert.equal(runningRetry.blocked_reason, "retry_skipped_task_running");
    assert.equal(fs.readFileSync(path.join(dir, "touch_task.json"), "utf8"), runningBefore, "a running task retry must not change persisted state");
    retryableTask.status = "completed";
    saveTaskState(dir, retryableTask);

    let retriedContactId = "";
    executorBehavior = async (options) => {
      retriedContactId = options.contactId;
      options.onTransition("sent_verified", { real_send_attempt_key: `retry-${options.contactId}` });
      return { ok: true, state: { real_send_status: "sent_verified", real_send_attempt_key: `retry-${options.contactId}` } };
    };
    const retried = await retrySkipped({}, { contactIds: [retryableTask.results[0].id] });
    assert.equal(retried.ok, true);
    assert.equal(retried.task.current_index, 0);
    assert.equal(retried.task.results[0].status, "generated");
    assert.equal(retried.task.results[0].retry_blocked, false);
    assert.equal(retried.task.results[0].send_attempted, false);
    assert.deepEqual(retried.task.results[0].message_parts, [{ kind: "text", status: "pending", message: "冻结文案" }], "retry must preserve the frozen message parts");
    const resumedRetry = await resume({}, { clickToken: "trusted-retry-skipped" });
    assert.equal(resumedRetry.task?.status, "running", `retry resume failed: ${JSON.stringify(resumedRetry)}`);
    await waitFor(status, (value) => value.task?.current_index === 1);
    assert.equal(retriedContactId, retryableTask.results[0].id, "a reset identity skip must be selected by the task loop again");

    fs.rmSync(path.join(dir, "touch_task.json"), { force: true });
    fs.rmSync(path.join(dir, "touch_task.json.bak"), { force: true });
    fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify(contacts(1)), "utf8");
    let preDraftRecoveryAttempts = 0;
    const updatesBeforePreDraftRecovery = taskUpdates.length;
    executorBehavior = async (options) => {
      preDraftRecoveryAttempts += 1;
      if (preDraftRecoveryAttempts === 1) {
        return {
          ok: false,
          action: "click-search-result-dry-run",
          blocked_reason: "wechat_external_input_detected",
          send_attempted: false,
          send_result: "not_attempted",
          safety_diagnostics: {
            phase: "click_search_result",
            expected_input_tick: 101,
            current_input_tick: 102,
            expected_hWnd: 81,
            foreground_hWnd: 81
          }
        };
      }
      sends += 1;
      options.onTransition("sent_verified", { real_send_attempt_key: "recovered-before-draft" });
      return { ok: true, state: { real_send_status: "sent_verified", real_send_attempt_key: "recovered-before-draft" } };
    };
    await start({}, { script: "输入变化恢复测试", clickToken: "trusted-pre-draft-recovery" });
    const recoveredBeforeDraft = await waitFor(status, (value) => value.task?.status === "completed");
    assert.equal(preDraftRecoveryAttempts, 2, "a confirmed pre-draft input interruption must retry once without rebuilding or resending the task");
    assert.equal(recoveredBeforeDraft.task.results[0].status, "sent_verified");
    assert.equal(recoveredBeforeDraft.task.results[0].last_failure_context?.recovery_action, "wait_for_idle_then_retry");
    assert.equal(recoveredBeforeDraft.task.results[0].last_failure_context?.current_input_tick, 102);
    assert.equal(taskUpdates.slice(updatesBeforePreDraftRecovery).some((payload) => payload.task?.phase === "waiting_for_idle"), true);

    fs.rmSync(path.join(dir, "touch_task.json"), { force: true });
    fs.rmSync(path.join(dir, "touch_task.json.bak"), { force: true });
    let inputLeaseRecoveryAttempts = 0;
    executorBehavior = async (options) => {
      inputLeaseRecoveryAttempts += 1;
      if (inputLeaseRecoveryAttempts === 1) {
        return {
          ok: false,
          action: "input-message-dry-run",
          blocked_reason: "message_input_failed_wechat_user_active",
          send_attempted: false,
          send_result: "not_attempted",
          safety_diagnostics: {
            phase: "pre_input",
            expected_input_tick: 201,
            current_input_tick: 202,
            expected_hWnd: 81,
            foreground_hWnd: 81
          }
        };
      }
      options.onTransition("sent_verified", { real_send_attempt_key: "recovered-input-lease" });
      return { ok: true, state: { real_send_status: "sent_verified", real_send_attempt_key: "recovered-input-lease" } };
    };
    await start({}, { script: "草稿输入占用恢复测试", clickToken: "trusted-input-lease-recovery" });
    const recoveredInputLease = await waitFor(status, (value) => value.task?.status === "completed");
    assert.equal(inputLeaseRecoveryAttempts, 2, "a pre-input lease block may retry after the bounded idle wait");
    assert.equal(recoveredInputLease.task.results[0].status, "sent_verified");
    assert.equal(recoveredInputLease.task.results[0].last_failure_context?.phase, "pre_input");

    fs.rmSync(path.join(dir, "touch_task.json"), { force: true });
    fs.rmSync(path.join(dir, "touch_task.json.bak"), { force: true });
    let touchedDraftRecoveryAttempts = 0;
    executorBehavior = async (options) => {
      touchedDraftRecoveryAttempts += 1;
      if (touchedDraftRecoveryAttempts === 1) {
        return {
          ok: false,
          action: "input-message-dry-run",
          blocked_reason: "message_input_failed_wechat_user_active",
          send_attempted: false,
          send_result: "not_attempted",
          safety_diagnostics: { phase: "copy_probe", expected_input_tick: 301, current_input_tick: 302 }
        };
      }
      options.onTransition("sent_verified", { real_send_attempt_key: "recovered-touched-draft" });
      return { ok: true, state: { real_send_status: "sent_verified", real_send_attempt_key: "recovered-touched-draft" } };
    };
    await start({}, { script: "草稿写入后输入变化恢复", clickToken: "trusted-input-lease-retry" });
    const recoveredTouchedDraft = await waitFor(status, (value) => value.task?.status === "completed");
    assert.equal(touchedDraftRecoveryAttempts, 2, "an input interruption before send must retry even when a replaceable draft already exists");
    assert.equal(recoveredTouchedDraft.task.results[0].status, "sent_verified");
    assert.equal(recoveredTouchedDraft.task.results[0].last_failure_context?.phase, "copy_probe");

    fs.rmSync(path.join(dir, "touch_task.json"), { force: true });
    fs.rmSync(path.join(dir, "touch_task.json.bak"), { force: true });
    const legacyDraft = createTask("旧版草稿任务", contacts(1), "2026-07-11T00:00:00.000Z", { executionMode: "draft_only" });
    legacyDraft.version = 2;
    legacyDraft.execution_mode = "draft_only";
    legacyDraft.status = "paused";
    legacyDraft.phase = "legacy_draft";
    const legacyContent = JSON.stringify(legacyDraft);
    fs.writeFileSync(path.join(dir, "touch_task.json"), legacyContent, "utf8");
    fs.writeFileSync(path.join(dir, "touch_task.json.bak"), legacyContent, "utf8");
    const sendsBeforeLegacyResume = sends;
    const legacyBlocked = await resume({}, { clickToken: "trusted-legacy-resume" });
    assert.equal(legacyBlocked.blocked_reason, "legacy_draft_task");
    assert.equal(sends, sendsBeforeLegacyResume);
    const legacyStopped = stop();
    assert.equal(legacyStopped.task.status, "stopped");
    assert.equal(legacyStopped.task.phase, "stopped");

    executorBehavior = async () => ({ ok: false, send_attempted: false, blocked_reason: "legacy_new_unknown_reason", error: "未知失败测试" });
    const qualityBaseline = (await status()).classificationQuality.unknownPauseCount;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      fs.rmSync(path.join(dir, "touch_task.json"), { force: true });
      fs.rmSync(path.join(dir, "touch_task.json.bak"), { force: true });
      await start({}, { script: "未知码质量统计", clickToken: `trusted-quality-${attempt}` });
      const pausedUnknownCode = await waitFor(status, (value) => value.task?.status === "paused");
      assert.equal(pausedUnknownCode.classificationQuality.unknownPauseCount, qualityBaseline + attempt + 1);
    }
    const persistedQuality = JSON.parse(fs.readFileSync(path.join(path.dirname(dir), "wechat_failure_classification_quality.json"), "utf8"));
    const legacyBuildQuality = persistedQuality.builds["9.8.7|build-current|abcdef1234567890"];
    assert.equal(legacyBuildQuality.status, "needs_review");
    assert(legacyBuildQuality.unknownReasonCodes.includes("legacy_new_unknown_reason"));

    fs.rmSync(path.join(dir, "touch_task.json"), { force: true });
    fs.rmSync(path.join(dir, "touch_task.json.bak"), { force: true });
    fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify(contacts(2)), "utf8");
    let unknownAttempt = 0;
    executorBehavior = async (options) => {
      sends += 1;
      unknownAttempt += 1;
      const attemptKey = `unknown-attempt-${unknownAttempt}`;
      const executionState = {
        task_context: { task_id: JSON.parse(fs.readFileSync(path.join(dir, "touch_task.json"), "utf8")).id, contact_id: options.contactId, current_index: 0 },
        real_send_status: "outcome_unknown",
        real_send_attempt_key: attemptKey,
        real_send_attempts: { [attemptKey]: "outcome_unknown" }
      };
      options.onTransition("prepared", { real_send_attempt_key: attemptKey });
      clicks += 1;
      options.onTransition("clicked", { real_send_attempt_key: attemptKey });
      options.onTransition("outcome_unknown", executionState);
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(executionState), "utf8");
      return { ok: false, blocked_reason: "outcome_unknown", state: executionState };
    };
    const deadlinesBeforeUnknown = waitedDeadlines.length;
    await start({}, { script: "未知结果测试", clickToken: "trusted-unknown" });
    const unknown = await waitFor(status, (value) => value.task?.results?.[0]?.status === "outcome_unknown");
    assert.equal(unknown.task.status, "paused");
    assert.equal(unknown.task.phase, "awaiting_unknown_resolution");
    assert.equal(unknown.task.results[0].outcome_unknown_retry_count, 0);
    assert.equal(unknownAttempt, 1, "an unknown send outcome must never trigger an automatic resend");
    assert.equal(waitedDeadlines.length, deadlinesBeforeUnknown, "unknown outcomes must pause without scheduling an automatic resend");
    const sendsAfterUnknown = sends;
    await resume({}, { clickToken: "trusted-no-retry" });
    const blockedRestart = await start({}, { script: "未知结果测试", clickToken: "trusted-no-restart" });
    assert.equal(blockedRestart.blocked_reason, "outcome_unknown");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sends, sendsAfterUnknown);
    executorBehavior = async (options) => {
      sends += 1;
      const attemptKey = `after-skip-${options.contactId}`;
      options.onTransition("sent_verified", { real_send_attempt_key: attemptKey });
      return { ok: true, state: { real_send_status: "sent_verified", real_send_attempt_key: attemptKey } };
    };
    const deadlinesBeforeSkip = waitedDeadlines.length;
    const savedSkip = await resolveUnknown({}, { taskId: unknown.task.id, contactId: unknown.task.results[0].id, resolution: "skip" });
    assert.equal(savedSkip.task.status, "paused", "manual resolution must persist without auto-continuing");
    assert.equal(savedSkip.task.results[0].manual_resolution_history.at(-1).resolution, "skip");
    assert.equal(sends, sendsAfterUnknown, "manual resolution must not call the executor");
    await start({}, { script: "未知结果测试", clickToken: "trusted-after-resolution" });
    const skippedThenCompleted = await waitFor(status, (value) => value.task?.status === "completed");
    assert.equal(skippedThenCompleted.task.results[0].status, "outcome_unknown_skipped");
    assert.equal(skippedThenCompleted.task.results[1].status, "sent_verified");
    assert.equal(sends, sendsAfterUnknown + 1);
    assert.equal(waitedDeadlines.length, deadlinesBeforeSkip, "manual skip must not add a send delay");

    fs.rmSync(path.join(dir, "touch_task.json"), { force: true });
    fs.rmSync(path.join(dir, "touch_task.json.bak"), { force: true });
    const restartUnknown = createTask("首次未知后重启", contacts(1), "2026-07-11T00:00:00.000Z", { executionMode: "real_send" });
    restartUnknown.status = "running";
    restartUnknown.phase = "sending_batch";
    restartUnknown.results[0].status = "outcome_unknown";
    restartUnknown.results[0].message = "您好 批次客户1";
    restartUnknown.results[0].attempt_key = "restart-unknown-1";
    restartUnknown.results[0].outcome_unknown_attempt_keys = ["restart-unknown-1"];
    saveTaskState(dir, restartUnknown);
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
      task_context: { task_id: restartUnknown.id, contact_id: restartUnknown.results[0].id, current_index: 0 },
      real_send_status: "outcome_unknown",
      real_send_clicked: true,
      real_send_attempt_key: "restart-unknown-1",
      real_send_attempts: { "restart-unknown-1": "outcome_unknown" },
      window_pid: 11,
      window_handle: "old-handle"
    }), "utf8");
    const recoveredUnknown = recoverInterruptedTask(dir);
    assert.equal(recoveredUnknown.status, "paused");
    assert.equal(recoveredUnknown.results[0].outcome_unknown_retry_count, 0);
    executorBehavior = async (options) => {
      sends += 1;
      currentFrozenContact = options.frozenContact;
      const attemptKey = "restart-unknown-retry";
      options.onTransition("sent_verified", { real_send_attempt_key: attemptKey });
      return { ok: true, state: { real_send_status: "sent_verified", real_send_attempt_key: attemptKey } };
    };
    const sendsBeforeRestartRecovery = sends;
    sessionVerificationResult = { ok: false, reason: "wechat_account_changed" };
    await resume({}, { clickToken: "trusted-restart-unknown" });
    const accountBlocked = await status();
    assert.equal(accountBlocked.task.status, "paused");
    assert.equal(accountBlocked.task.phase, "paused");
    assert.equal(accountBlocked.task.results[0].outcome_unknown_retry_count, 0);
    assert.equal(sends, sendsBeforeRestartRecovery);
    sessionVerificationResult = { ok: true, pid: 21, hWnd: "new-handle", processName: "Weixin", accountId: "account-a", accountVerified: true };
    bubbleVerificationResult = { ok: true, state: { real_send_status: "sent_verified", real_send_attempt_key: "restart-unknown-1" } };
    await resume({}, { clickToken: "trusted-restart-unknown-after-account-switch" });
    const recoveredCompleted = await waitFor(status, (value) => value.task?.status === "completed");
    assert.equal(recoveredCompleted.task.results[0].outcome_unknown_retry_count, 0);
    assert.equal(sends, sendsBeforeRestartRecovery);
    assert.equal(observedBubbleHandle, "new-handle");

    fs.rmSync(path.join(dir, "touch_task.json"), { force: true });
    fs.rmSync(path.join(dir, "touch_task.json.bak"), { force: true });
    const restartUnknownRetry = createTask("首次未知后重启复核", contacts(1), "2026-07-11T00:00:00.000Z", { executionMode: "real_send" });
    restartUnknownRetry.status = "running";
    restartUnknownRetry.phase = "sending_batch";
    restartUnknownRetry.results[0].status = "outcome_unknown";
    restartUnknownRetry.results[0].message = "您好 批次客户1";
    restartUnknownRetry.results[0].attempt_key = "restart-unknown-2";
    restartUnknownRetry.results[0].outcome_unknown_attempt_keys = ["restart-unknown-2"];
    saveTaskState(dir, restartUnknownRetry);
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
      task_context: { task_id: restartUnknownRetry.id, contact_id: restartUnknownRetry.results[0].id, current_index: 0 },
      real_send_status: "outcome_unknown",
      real_send_clicked: true,
      real_send_attempt_key: "restart-unknown-2",
      real_send_attempts: { "restart-unknown-2": "outcome_unknown" },
      window_pid: 31,
      window_handle: "retry-old-handle"
    }), "utf8");
    recoverInterruptedTask(dir);
    sessionVerificationResult = { ok: true, pid: 41, hWnd: "retry-new-handle", processName: "Weixin", accountId: "account-a", accountVerified: true };
    bubbleVerificationResult = { ok: false, state: { real_send_status: "outcome_unknown" } };
    const sendsBeforeRestartRetry = sends;
    await resume({}, { clickToken: "trusted-restart-unknown-retry" });
    const retryBlocked = await waitFor(status, (value) => value.task?.phase === "awaiting_unknown_resolution");
    assert.equal(retryBlocked.task.status, "paused");
    assert.equal(retryBlocked.task.results[0].status, "outcome_unknown");
    assert.equal(retryBlocked.task.results[0].outcome_unknown_retry_count, 0);
    assert.equal(retryBlocked.task.results[0].awaiting_resolution, true);
    assert.equal(sends, sendsBeforeRestartRetry, "failed re-verification must never call the real-send executor again");
    assert.equal(observedBubbleHandle, "retry-new-handle");
    await resume({}, { clickToken: "trusted-restart-unknown-still-no-retry" });
    assert.equal(sends, sendsBeforeRestartRetry, "continuing an unresolved unknown outcome must remain non-sending");

    fs.rmSync(path.join(dir, "touch_task.json"), { force: true });
    fs.rmSync(path.join(dir, "touch_task.json.bak"), { force: true });
    const stoppedUnknown = createTask("永久结束未知任务", contacts(1), "2026-07-11T00:00:00.000Z", { executionMode: "real_send" });
    stoppedUnknown.status = "stopped";
    stoppedUnknown.phase = "awaiting_unknown_resolution";
    stoppedUnknown.results[0].status = "outcome_unknown";
    stoppedUnknown.results[0].outcome_unknown_retry_count = 1;
    stoppedUnknown.results[0].awaiting_resolution = true;
    saveTaskState(dir, stoppedUnknown);
    executorBehavior = async (options) => {
      sends += 1;
      const attemptKey = "new-task-after-stop";
      options.onTransition("sent_verified", { real_send_attempt_key: attemptKey });
      return { ok: true, state: { real_send_status: "sent_verified", real_send_attempt_key: attemptKey } };
    };
    await start({}, { script: "永久结束后新任务", clickToken: "trusted-new-after-stop" });
    await waitFor(status, (value) => value.task?.status === "completed");

    stop();
    fs.rmSync(path.join(dir, "touch_task.json"), { force: true });
    fs.rmSync(path.join(dir, "touch_task.json.bak"), { force: true });
    let releaseSend;
    executorBehavior = (options) => {
      sends += 1;
      return new Promise((resolve) => {
        releaseSend = () => {
          if (options.isExecutionAllowed()) clicks += 1;
          resolve({ ok: false, blocked_reason: "execution_not_allowed" });
        };
      });
    };
    const clicksBeforeRace = clicks;
    const sendsBeforeRace = sends;
    await start({}, { script: "连续点击测试", clickToken: "trusted-double-1" });
    await waitFor(() => Promise.resolve(sends), (value) => value === sendsBeforeRace + 1);
    await start({}, { script: "连续点击测试", clickToken: "trusted-double-2" });
    assert.equal(sends, sendsBeforeRace + 1);
    handlers.get("touch-task:close-floating")();
    await waitFor(status, (value) => value.task?.status === "paused");
    releaseSend();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(clicks, clicksBeforeRace);
    assert.ok(pauseCallbacks > 0);

    const permanentlyStopped = stop();
    assert.equal(permanentlyStopped.task.status, "stopped");
    assert.equal((await resume({}, { clickToken: "trusted-after-stop" })).task.status, "stopped");
    fs.rmSync(path.join(dir, "touch_task.json"), { force: true });
    fs.rmSync(path.join(dir, "touch_task.json.bak"), { force: true });
    fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify(contacts(3)), "utf8");
    aiFailuresRemaining = new Map();
    executorBehavior = async (options) => {
      sends += 1;
      currentFrozenContact = options.frozenContact;
      const attemptKey = `accepted-${options.contactId}`;
      options.onTransition("sent_verified", { real_send_attempt_key: attemptKey });
      return { ok: true, state: { real_send_status: "sent_verified", real_send_attempt_key: attemptKey } };
    };
    const frozenContacts = contacts(3);
    const frozenClassification = classifyContacts(frozenContacts, { excludedContactIds: ["wxid_batch_2", "wxid_batch_3"] });
    let frozenPausedTask = createTask("冻结名单恢复测试", frozenContacts, "2026-07-11T00:00:00.000Z", { executionMode: "real_send", classification: frozenClassification });
    frozenPausedTask.status = "paused";
    frozenPausedTask.phase = "paused";
    frozenPausedTask.results[0].status = "blocked";
    frozenPausedTask.results[0].message = "冻结名单恢复测试";
    frozenPausedTask = saveTaskState(dir, frozenPausedTask);
    const sendsBeforeFrozenResume = sends;
    await start({}, { script: "冻结名单恢复测试", excludedContactIds: [], clickToken: "trusted-frozen-resume" });
    const frozenCompleted = await waitFor(status, (value) => value.task?.status === "completed");
    assert.equal(frozenCompleted.task.id, frozenPausedTask.id, "resuming must reuse the frozen task instead of creating a broader task");
    assert.equal(frozenCompleted.task.total, 1, "empty renderer exclusions after restart must not widen a frozen one-contact task");
    assert.deepEqual(frozenCompleted.task.user_excluded_ids, ["wxid_batch_2", "wxid_batch_3"]);
    assert.equal(sends, sendsBeforeFrozenResume + 1);

    fs.rmSync(path.join(dir, "touch_task.json"), { force: true });
    fs.rmSync(path.join(dir, "touch_task.json.bak"), { force: true });
    await start({}, { script: "排除测试", excludedContactIds: ["wxid_batch_2"], clickToken: "trusted-exclusion" });
    const excluded = await waitFor(status, (value) => value.task?.status === "completed");
    assert.equal(excluded.task.total, 2);
    assert.deepEqual(excluded.task.user_excluded_ids, ["wxid_batch_2"]);
    assert.equal(excluded.task.excluded_contacts.find((entry) => entry.contact.id === "wxid_batch_2").reason_code, "user_excluded");
    const sendsBeforeAllExcluded = sends;
    const allExcluded = await start({}, {
      script: "全部排除测试",
      excludedContactIds: ["wxid_batch_1", "wxid_batch_2", "wxid_batch_3"],
      clickToken: "trusted-all-excluded"
    });
    assert.equal(allExcluded.blocked_reason, "no_eligible_contacts");
    assert.equal(sends, sendsBeforeAllExcluded);

    fs.rmSync(path.join(dir, "touch_task.json"), { force: true });
    fs.rmSync(path.join(dir, "touch_task.json.bak"), { force: true });
    fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify(contacts(2)), "utf8");
    aiFailuresRemaining = new Map([["wxid_batch_1", 2]]);
    const sendsBeforeAiFallback = sends;
    await start({}, { script: "用户确认的固定话术", clickToken: "trusted-ai-fallback" });
    const aiFallback = await waitFor(status, (value) => value.task?.status === "completed");
    assert.equal(aiFallback.task.results[0].ai_attempts, 2);
    assert.equal(aiFallback.task.results[0].ai_status, "fallback");
    assert.equal(aiFallback.task.results[0].ai_error_code, "AI_GENERATION_FAILED");
    assert.equal(aiFallback.task.results[0].message, "用户确认的固定话术");
    assert.equal(aiFallback.task.results[1].ai_status, "generated");
    assert.equal(sends, sendsBeforeAiFallback + 2, "one contact's AI failure must not pause the remaining batch");

    fs.rmSync(path.join(dir, "touch_task.json"), { force: true });
    fs.rmSync(path.join(dir, "touch_task.json.bak"), { force: true });
    fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify(contacts(1)), "utf8");
    aiFailureCodes = new Map([["wxid_batch_1", "API_KEY_INVALID"]]);
    const sendsBeforeKeyFallback = sends;
    await start({}, { script: "Key 错误固定话术", clickToken: "trusted-key-fallback" });
    const keyFallback = await waitFor(status, (value) => value.task?.status === "completed");
    assert.equal(keyFallback.task.results[0].ai_attempts, 1);
    assert.equal(keyFallback.task.results[0].ai_status, "fallback");
    assert.equal(keyFallback.task.results[0].ai_error_code, "API_KEY_INVALID");
    assert.equal(sends, sendsBeforeKeyFallback + 1);
    aiFailureCodes = new Map();

    const expectedBatchEnds = new Map([
      [1, [1]],
      [49, [49]],
      [50, [50]],
      [51, [50, 51]],
      [100, [50, 100]],
      [101, [50, 100, 101]]
    ]);
    aiFailuresRemaining = new Map();
    for (const [count, expected] of expectedBatchEnds) {
      let task = createTask("边界测试", contacts(count), "2026-07-11T00:00:00.000Z", { executionMode: "real_send" });
      const taskAuthorizationId = task.batch_authorization.id;
      assert.equal(isBatchAuthorized(task), true);
      const ends = [task.batch_end_index];
      while (task.batch_end_index < count) {
        task.current_index = task.batch_end_index;
        task.status = "paused";
        task.phase = "awaiting_batch_continue";
        const authorized = authorizeNextBatch(task);
        const duplicate = authorizeNextBatch(authorized);
        assert.equal(duplicate.batch_end_index, authorized.batch_end_index);
        assert.equal(duplicate.batch_authorization.id, authorized.batch_authorization.id);
        assert.equal(authorized.batch_authorization.id, taskAuthorizationId);
        assert.equal(isBatchAuthorized(authorized), true);
        task = authorized;
        ends.push(task.batch_end_index);
      }
      assert.deepEqual(ends, expected);
    }
    console.log("touch-task-ipc self-check passed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
