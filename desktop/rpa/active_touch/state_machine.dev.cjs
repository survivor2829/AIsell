const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  clickWechatSendButtonAsync,
  verifyWechatCurrentConversation,
  verifyWechatCurrentConversationAsync,
  verifyWechatMessageBubble,
  verifyWechatMessageBubbleAsync
} = require("./wechat_window_driver.dev.cjs");
const {
  inputWechatMessageDraftAsync,
  openWechatSearchResultAsync,
  verifyWechatCurrentConversationAsync: verifyWechatConversationTitleAsync
} = require("./wechat_window_driver.cjs");
const { appendLog, block, blockMessageBubble, blockSendGate, loadState, output, readContacts, saveState } = require("./state_machine.cjs");
const { contactIdentityError, identityKey } = require("./touch_task_state.cjs");

function attemptKey(state, message, attemptId = "") {
  const taskId = String(attemptId || state.task_context?.task_id || "single-contact");
  const contactId = String(state.selected_customer?.id ?? "");
  return crypto.createHash("sha256").update(`${taskId}\n${contactId}\n${message}`).digest("hex");
}

function singleContactIdentityError(state, baseDir) {
  const customer = state.selected_customer;
  const contacts = readContacts(baseDir);
  return contactIdentityError(contacts, customer);
}

function syncedWechatRoot(baseDir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.resolve(baseDir, "..", "contact_sync", "state.json"), "utf8"));
    return String(state.wechat_root ?? "").trim();
  } catch {
    return "";
  }
}

function sessionCheck(state, driver = verifyWechatCurrentConversation, baseDir = __dirname) {
  const customer = state.selected_customer;
  if (!customer?.name) return { ok: false, reason: "conversation_not_verified" };
  const expectedAccountId = String(customer.wechatAccountId ?? state.wechat_account_id ?? "").trim();
  const expectedWechatId = String(customer.wechatId ?? "").trim();
  const allowExactSearchFallback = state.conversation_verification_mode === "exact_wechat_id_search"
    && Boolean(expectedWechatId)
    && state.search_query === expectedWechatId
    && Boolean(state.window_pid)
    && Boolean(state.window_handle);
  const result = driver(customer.name, {
    wechatRoot: syncedWechatRoot(baseDir),
    expectedAccountId,
    expectedPid: state.window_pid,
    expectedHWnd: state.window_handle,
    allowExactSearchFallback
  });
  if (!result.ok) return result;
  if (!result.pid || !result.hWnd || !["Weixin", "WeChat"].includes(result.processName)) return { ok: false, reason: "personal_wechat_main_window_not_found" };
  if (!expectedAccountId) return { ok: false, reason: "wechat_account_identity_missing" };
  if (result.accountVerified !== true || !String(result.accountId ?? "").trim()) return { ok: false, reason: result.accountReason || "wechat_account_not_verified" };
  if (String(result.accountId).trim() !== expectedAccountId) return { ok: false, reason: "wechat_account_changed" };
  return result;
}

async function sessionCheckAsync(state, driver = verifyWechatCurrentConversationAsync, baseDir = __dirname) {
  const customer = state.selected_customer;
  if (!customer?.name) return { ok: false, reason: "conversation_not_verified" };
  const expectedAccountId = String(customer.wechatAccountId ?? state.wechat_account_id ?? "").trim();
  const expectedWechatId = String(customer.wechatId ?? "").trim();
  const allowExactSearchFallback = state.conversation_verification_mode === "exact_wechat_id_search"
    && Boolean(expectedWechatId)
    && state.search_query === expectedWechatId
    && Boolean(state.window_pid)
    && Boolean(state.window_handle);
  const result = await Promise.resolve(driver(customer.name, {
    wechatRoot: syncedWechatRoot(baseDir),
    expectedAccountId,
    expectedPid: state.window_pid,
    expectedHWnd: state.window_handle,
    allowExactSearchFallback
  }));
  if (!result.ok) return result;
  if (!result.pid || !result.hWnd || !["Weixin", "WeChat"].includes(result.processName)) return { ok: false, reason: "personal_wechat_main_window_not_found" };
  if (!expectedAccountId) return { ok: false, reason: "wechat_account_identity_missing" };
  if (result.accountVerified !== true || !String(result.accountId ?? "").trim()) return { ok: false, reason: result.accountReason || "wechat_account_not_verified" };
  if (String(result.accountId).trim() !== expectedAccountId) return { ok: false, reason: "wechat_account_changed" };
  return result;
}

function hasMessageSnapshot(result) {
  return result?.ok === true && result.snapshot !== undefined && result.snapshot !== null;
}

function normalizeMessageProofText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").replace(/\uFFFC+$/u, "");
}

function isVerifiedNewMessage(result, message, beforeSnapshot) {
  const bubbleVerified = result?.ok === true
    && result.exactMatch === true
    && result.outgoing === true
    && result.isLatest === true
    && result.isNew === true
    && normalizeMessageProofText(result.messageText) === normalizeMessageProofText(message);
  if (bubbleVerified) return true;
  return result?.ok === true
    && result.verificationMode === "draft_consumed"
    && result.draftConsumed === true
    && result.sameWindow === true
    && beforeSnapshot?.draftExact === true;
}

function rejectRepeatedAttempt(baseDir, state, action = "send") {
  const nextState = { ...state, real_send_armed: false, real_send_enabled: false };
  saveState(baseDir, nextState);
  appendLog(baseDir, "真实发送", "已阻断：同一联系人、任务和文案已有发送尝试");
  return output(false, action, nextState, { baseDir, blocked_reason: "real_send_already_attempted" });
}

function notifyTransition(callback, status, state) {
  if (typeof callback === "function") callback(status, state);
}

async function executionMayContinue(options) {
  for (const callback of [options.isExecutionAllowed, options.shouldContinue]) {
    if (typeof callback !== "function") continue;
    try {
      if ((await callback()) !== true) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function cancelVerifiedContactSend(baseDir) {
  const disarmed = setRealSendArm(baseDir, false);
  return {
    ok: false,
    action: "task_paused",
    blocked_reason: "batch_cancelled",
    error: "任务已暂停，本次发送已取消",
    state: disarmed.state
  };
}

function withSendAttempted(result, sendAttempted = false) {
  return { ...result, send_attempted: sendAttempted };
}

function sendAttemptedFromState(state, attemptKey = "") {
  const attemptStatus = attemptKey ? state?.real_send_attempts?.[attemptKey] : state?.real_send_status;
  if (["clicked", "sent_verified"].includes(attemptStatus)) return true;
  if (["prepared", "outcome_unknown"].includes(attemptStatus)) return null;
  if (["clicked", "sent_verified"].includes(state?.real_send_status)) return true;
  if (["prepared", "outcome_unknown"].includes(state?.real_send_status)) return null;
  return false;
}

function persistNotAttempted(baseDir, state, reason, onTransition) {
  const attempts = { ...(state.real_send_attempts ?? {}) };
  delete attempts[String(state.real_send_attempt_key ?? "")];
  const nextState = {
    ...state,
    real_send_armed: false,
    real_send_enabled: false,
    real_send_clicked: false,
    real_send_status: "not_sent",
    real_send_reason: reason,
    real_send_attempt_key: "",
    real_send_attempts: attempts,
    post_send_verified: false,
    post_send_status: "not_sent",
    post_send_reason: reason,
    message_bubble_verified: false,
    message_bubble_status: "not_sent",
    message_bubble_reason: reason,
    last_result: "send_not_attempted",
    blocked_reason: reason
  };
  saveState(baseDir, nextState);
  try { notifyTransition(onTransition, "sending", nextState); } catch {}
  return output(false, "send", nextState, { baseDir, blocked_reason: reason, send_attempted: false });
}

function persistOutcomeUnknown(baseDir, state, reason, sendAttempted = null, onTransition) {
  const attemptKey = String(state.real_send_attempt_key ?? "");
  const nextState = {
    ...state,
    real_send_armed: false,
    real_send_enabled: false,
    real_send_clicked: state.real_send_clicked === true || sendAttempted === true,
    real_send_status: "outcome_unknown",
    real_send_reason: reason,
    post_send_verified: false,
    post_send_status: "outcome_unknown",
    post_send_reason: reason,
    message_bubble_verified: false,
    message_bubble_status: "outcome_unknown",
    message_bubble_reason: reason,
    real_send_attempts: attemptKey ? { ...(state.real_send_attempts ?? {}), [attemptKey]: "outcome_unknown" } : state.real_send_attempts,
    last_result: "outcome_unknown",
    blocked_reason: "outcome_unknown"
  };
  saveState(baseDir, nextState);
  try { notifyTransition(onTransition, "outcome_unknown", nextState); } catch {}
  appendLog(baseDir, "真实发送", `发送结果无法确认：${reason}；已暂停且绝不自动重试`);
  return output(false, "send", nextState, { baseDir, blocked_reason: "outcome_unknown", send_attempted: sendAttempted });
}

function verifyRealSendSession(baseDir = __dirname, driver = verifyWechatCurrentConversation) {
  const state = loadState(baseDir);
  const result = sessionCheck(state, driver, baseDir);
  if (!result.ok) return blockSendGate(baseDir, state, result.reason || "session_not_verified", "已阻断：微信账号、主窗口或当前会话未重新验证");
  const nextState = refreshedSessionState(state, result);
  saveState(baseDir, nextState);
  appendLog(baseDir, "真实发送会话验证", "已验证个人微信进程、PID、窗口句柄和当前会话");
  return output(true, "verify-real-send-session", nextState, { baseDir });
}

async function verifyRealSendSessionAsync(baseDir = __dirname, driver = verifyWechatCurrentConversationAsync) {
  const state = loadState(baseDir);
  const result = await sessionCheckAsync(state, driver, baseDir);
  if (!result.ok) return blockSendGate(baseDir, state, result.reason || "session_not_verified", "已阻断：微信账号、主窗口或当前会话未重新验证");
  const nextState = refreshedSessionState(state, result);
  saveState(baseDir, nextState);
  appendLog(baseDir, "真实发送会话验证", "已验证个人微信进程、PID、窗口句柄和当前会话");
  return output(true, "verify-real-send-session", nextState, { baseDir });
}

function refreshedSessionState(state, result) {
  return {
    ...state,
    wechat_account_id: String(result.accountId),
    window_pid: Number(result.pid),
    window_handle: String(result.hWnd),
    window_process_name: result.processName,
    conversation_title: result.title ?? state.conversation_title,
    located_window_title: result.windowTitle ?? state.located_window_title,
    last_result: "real_send_session_verified",
    blocked_reason: ""
  };
}

function refreshRealSendSession(baseDir = __dirname, driver = verifyWechatCurrentConversation) {
  const state = loadState(baseDir);
  const result = sessionCheck(state, driver, baseDir);
  if (!result.ok) return result;
  const nextState = refreshedSessionState(state, result);
  saveState(baseDir, nextState);
  return { ...result, state: nextState };
}

function setRealSendArm(baseDir = __dirname, enabled = false) {
  const state = loadState(baseDir);
  if (!enabled) {
    if (!state.real_send_armed && !state.real_send_enabled) {
      return output(true, "set-real-send-arm", state, { baseDir });
    }
    const terminal = ["prepared", "clicked", "sent_verified", "outcome_unknown"].includes(state.real_send_status);
    const nextState = {
      ...state,
      real_send_armed: false,
      real_send_enabled: false,
      real_send_status: terminal ? state.real_send_status : "not_sent",
      real_send_reason: terminal ? state.real_send_reason : "",
      last_result: terminal ? state.last_result : "real_send_disarmed",
      blocked_reason: terminal ? state.blocked_reason : ""
    };
    saveState(baseDir, nextState);
    return output(true, "set-real-send-arm", nextState, { baseDir });
  }
  if (["prepared", "clicked", "sent_verified", "outcome_unknown"].includes(state.real_send_status)) {
    return rejectRepeatedAttempt(baseDir, state, "set-real-send-arm");
  }
  if (state.send_gate_status !== "dry_run_passed") {
    return block(baseDir, "真发开关 dry-run", { ...state, real_send_armed: false, real_send_enabled: false, real_send_status: "blocked", real_send_reason: "send_gate_not_passed" }, "send_gate_not_passed", "已阻断：发送门禁 dry-run 未通过");
  }
  const identityError = singleContactIdentityError(state, baseDir);
  if (identityError) return blockSendGate(baseDir, state, identityError, "已阻断：联系人姓名或微信号无法唯一确认");
  if (!state.window_pid || !state.window_handle) {
    return blockSendGate(baseDir, state, "real_send_session_not_verified", "已阻断：请重新验证微信窗口和当前会话");
  }
  const nextState = { ...state, real_send_armed: true, real_send_enabled: false, real_send_clicked: false, real_send_status: "armed", real_send_reason: "", last_result: "real_send_armed_dry_run", blocked_reason: "" };
  saveState(baseDir, nextState);
  return output(true, "set-real-send-arm", nextState, { baseDir });
}

async function sendReal(baseDir = __dirname, options = {}, sendDriver = clickWechatSendButtonAsync, sessionDriver = verifyWechatCurrentConversationAsync, bubbleVerifier = verifyWechatMessageBubbleAsync) {
  const state = loadState(baseDir);
  const message = String(options.message ?? state.message_draft ?? "").trim();
  if (!state.real_send_armed) return withSendAttempted(blockSendGate(baseDir, state, "real_send_not_armed", "已阻断：单人真发开关未武装"), sendAttemptedFromState(state));
  if (options.allowRealSend !== true) return withSendAttempted(blockSendGate(baseDir, state, "real_send_explicit_allow_missing", "已阻断：缺少显式真发允许参数"));
  if (options.userConfirmed !== true) return withSendAttempted(blockSendGate(baseDir, state, "real_send_final_confirmation_missing", "已阻断：最终发送必须由用户亲自确认"));
  if (!state.calibrated || !state.target_selected || !state.conversation_verified || !state.message_input_done || !message || String(state.message_draft ?? "").trim() !== message) {
    return withSendAttempted(blockSendGate(baseDir, state, "real_send_gate_failed", "已阻断：真实发送前置检查未通过"));
  }
  const key = attemptKey(state, message, options.attemptId);
  if (state.real_send_attempts?.[key] || ["prepared", "clicked", "sent_verified", "outcome_unknown"].includes(state.real_send_status)) {
    return withSendAttempted(rejectRepeatedAttempt(baseDir, state), sendAttemptedFromState(state, key));
  }
  const session = await sessionCheckAsync(state, sessionDriver, baseDir);
  if (!session.ok || Number(session.pid) !== Number(state.window_pid) || String(session.hWnd) !== String(state.window_handle)) {
    return withSendAttempted(blockSendGate(baseDir, state, "real_send_session_changed", "已阻断：微信账号、PID、窗口句柄或当前会话发生变化"));
  }
  const windowContext = {
    pid: state.window_pid,
    hWnd: state.window_handle,
    inputPoint: state.message_input_point,
    expectedConversation: state.selected_customer?.name,
    expectedMessage: message,
    expectedIncomingMessage: String(options.expectedIncomingMessage || "").trim(),
    expectedIncomingRuntimeId: String(options.expectedIncomingRuntimeId || "").trim()
  };
  const before = await Promise.resolve(bubbleVerifier(message, { ...windowContext, phase: "before" }));
  if (!hasMessageSnapshot(before)) {
    return withSendAttempted(blockSendGate(baseDir, state, "message_snapshot_unavailable", "已阻断：无法读取发送前消息列表快照"));
  }
  const prepared = {
    ...state,
    dry_run: false,
    real_send_armed: false,
    real_send_enabled: false,
    real_send_status: "prepared",
    real_send_reason: "",
    real_send_attempt_key: key,
    real_send_attempts: { ...(state.real_send_attempts ?? {}), [key]: "prepared" },
    message_bubble_snapshot_before: before.snapshot,
    last_result: "real_send_prepared",
    blocked_reason: ""
  };
  saveState(baseDir, prepared);
  try {
    notifyTransition(options.onTransition, "prepared", prepared);
  } catch {
    return persistNotAttempted(baseDir, prepared, "prepared_task_persist_failed", options.onTransition);
  }
  appendLog(baseDir, "真实发送", "已持久化 prepared 状态，等待用户最终点击结果");
  let sendResult;
  try {
    sendResult = await Promise.resolve(sendDriver(options.sendKey ?? "{ENTER}", windowContext));
  } catch {
    return persistOutcomeUnknown(baseDir, prepared, "send_driver_exception", null, options.onTransition);
  }
  if (!sendResult?.ok || sendResult.conversationVerified !== true || sendResult.draftVerified !== true) {
    if (sendResult?.sendAttempted === false) {
      return persistNotAttempted(baseDir, prepared, sendResult?.reason || "atomic_send_not_verified", options.onTransition);
    }
    return persistOutcomeUnknown(baseDir, prepared, sendResult?.reason || "atomic_send_not_verified", sendResult?.sendAttempted === true ? true : null, options.onTransition);
  }
  const clicked = { ...prepared, real_send_clicked: true, real_send_status: "clicked", real_send_attempts: { ...prepared.real_send_attempts, [key]: "clicked" }, located_window_title: sendResult.title ?? prepared.located_window_title, last_result: "real_send_clicked" };
  saveState(baseDir, clicked);
  try { notifyTransition(options.onTransition, "clicked", clicked); } catch {}
  let verified;
  try {
    verified = await Promise.resolve(bubbleVerifier(message, { ...windowContext, phase: "after", beforeSnapshot: before.snapshot }));
  } catch {
    return persistOutcomeUnknown(baseDir, clicked, "message_bubble_verifier_failed", true, options.onTransition);
  }
  if (!isVerifiedNewMessage(verified, message, before.snapshot)) return persistOutcomeUnknown(baseDir, clicked, "message_bubble_not_new_latest_exact", true, options.onTransition);
  const draftConsumed = verified.verificationMode === "draft_consumed";
  const nextState = { ...clicked, real_send_status: "sent_verified", real_send_attempts: { ...clicked.real_send_attempts, [key]: "sent_verified" }, message_bubble_verified: !draftConsumed, message_bubble_status: draftConsumed ? "not_exposed" : "verified", message_bubble_reason: draftConsumed ? "uia_message_bubble_unavailable" : "", post_send_verified: true, post_send_status: draftConsumed ? "draft_consumed_verified" : "bubble_verified", post_send_reason: "", post_send_verification_mode: draftConsumed ? "draft_consumed" : "message_bubble", located_window_title: verified.title ?? clicked.located_window_title, last_result: "sent_verified", blocked_reason: "" };
  saveState(baseDir, nextState);
  try { notifyTransition(options.onTransition, "sent_verified", nextState); } catch {}
  appendLog(baseDir, "真实发送", draftConsumed ? "已验证发送前精确文案与发送后输入框清空" : "消息气泡与完整文案已自动验证");
  return output(true, "send", nextState, { baseDir, send_attempted: true });
}

async function executeVerifiedContactSend(options = {}) {
  const baseDir = options.baseDir || __dirname;
  const contactId = String(options.contactId || "").trim();
  const message = String(options.message || "").trim();
  if (options.authorized !== true) return withSendAttempted({ ok: false, action: "send", blocked_reason: "batch_authorization_missing", error: "已阻断：缺少本批用户授权" });
  if (!contactId || !message) return withSendAttempted({ ok: false, action: "send", blocked_reason: "contact_or_message_missing", error: "已阻断：联系人或文案缺失" });

  if (String(options.visualMode || "") === "visual_render_v1") {
    const pid = Number(options.expectedPid);
    const hWnd = Number(options.expectedHWnd);
    const conversation = String(options.expectedConversation || "").trim();
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(hWnd) || hWnd <= 0 || !conversation) {
      return withSendAttempted({ ok: false, action: "send", blocked_reason: "visual_send_context_invalid", error: "视觉发送缺少微信窗口或会话信息" });
    }
    if (!(await executionMayContinue(options))) return withSendAttempted(cancelVerifiedContactSend(baseDir));
    if (typeof options.beforeDraft === "function") {
      let allowed = false;
      try {
        allowed = (await options.beforeDraft({ session: { ok: true, pid, hWnd, title: conversation, visualMode: "visual_render_v1" } })) === true;
      } catch {}
      if (!allowed) {
        return withSendAttempted({ ok: false, action: "send", blocked_reason: "incoming_message_changed", error: "对方最新消息或当前会话已变化，本次回复已取消" });
      }
    }
    if (!(await executionMayContinue(options))) return withSendAttempted(cancelVerifiedContactSend(baseDir));
    const visualSender = options.visualSendDriver || require("./wechat_auto_reply_visual_send.dev.cjs").sendVisualAutoReply;
    let result;
    try {
      result = await Promise.resolve(visualSender({
        pid,
        hWnd,
        conversation,
        incomingMessage: String(options.expectedIncomingMessage || ""),
        incomingMessageSignature: String(options.expectedIncomingMessageSignature || ""),
        incomingVerified: true,
        reply: message,
        beforeSend: () => executionMayContinue(options)
      }));
    } catch {
      // The visual sender owns the final click. If it throws, this caller cannot
      // prove whether the exception happened before or after that click, so the
      // outcome must stay unknown and must never enter the automatic retry path.
      return withSendAttempted({ ok: false, action: "send", blocked_reason: "visual_send_driver_exception", error: "视觉发送执行器异常，消息是否发出无法确认" }, null);
    }
    if (result?.ok !== true) {
      const reason = String(result?.reason || "visual_send_not_verified");
      const sendAttempted = result?.outcomeUnknown === true
        ? result?.send_attempted === true ? true : null
        : result?.send_attempted === false ? false : result?.send_attempted === true ? true : null;
      return withSendAttempted({
        ok: false,
        action: "send",
        blocked_reason: reason,
        error: result?.outcomeUnknown === true ? "已点击发送，但无法确认最终结果" : "视觉发送未完成",
        verification_mode: String(result?.verificationMode || "")
      }, sendAttempted);
    }
    return withSendAttempted({
      ok: true,
      action: "send",
      state: { real_send_status: "sent_verified" },
      verification_mode: String(result.verificationMode || ""),
      pid: Number(result.pid || pid),
      hWnd: String(result.hWnd || hWnd)
    }, true);
  }

  if (typeof options.runStep !== "function") return withSendAttempted({ ok: false, action: "send", blocked_reason: "contact_or_message_missing", error: "已阻断：执行器缺失" });

  const steps = [
    ["select-customer", ["--id", contactId]],
    ["calibrate", []],
    ["focus-wechat-window", []],
    ["click-search-result-dry-run", []]
  ];
  for (const [command, args] of steps) {
    if (!(await executionMayContinue(options))) return withSendAttempted(cancelVerifiedContactSend(baseDir));
    const result = await options.runStep(command, args);
    if (!(await executionMayContinue(options))) return withSendAttempted(cancelVerifiedContactSend(baseDir));
    if (!result?.ok) return withSendAttempted(result);
    if (command === "select-customer" && options.frozenContact) {
      const selected = result.state?.selected_customer;
      if (!selected || identityKey(selected) !== identityKey(options.frozenContact)) {
        setRealSendArm(baseDir, false);
        return withSendAttempted({ ok: false, action: command, blocked_reason: "contact_snapshot_changed", error: "已阻断：联系人身份与任务冻结快照不一致" });
      }
    }
  }

  if (!(await executionMayContinue(options))) return withSendAttempted(cancelVerifiedContactSend(baseDir));
  const session = await verifyRealSendSessionAsync(baseDir, options.sessionDriver || verifyWechatCurrentConversationAsync);
  if (!(await executionMayContinue(options))) return withSendAttempted(cancelVerifiedContactSend(baseDir));
  if (!session.ok) return withSendAttempted(session);
  if (typeof options.beforeDraft === "function") {
    let allowed = false;
    try {
      allowed = (await options.beforeDraft({ session })) === true;
    } catch {}
    if (!allowed) {
      setRealSendArm(baseDir, false);
      return withSendAttempted({ ok: false, action: "send", blocked_reason: "incoming_message_changed", error: "已取消：对方最新消息或当前会话已变化" });
    }
  }
  for (const [command, args] of [
    ["input-message-dry-run", ["--message", message]],
    ["send", ["--dry-run", "--message", message]]
  ]) {
    if (!(await executionMayContinue(options))) return withSendAttempted(cancelVerifiedContactSend(baseDir));
    const result = await options.runStep(command, args);
    if (!(await executionMayContinue(options))) return withSendAttempted(cancelVerifiedContactSend(baseDir));
    if (!result?.ok) return withSendAttempted(result);
  }
  if (!(await executionMayContinue(options))) return withSendAttempted(cancelVerifiedContactSend(baseDir));
  const armed = setRealSendArm(baseDir, true);
  if (!(await executionMayContinue(options))) return withSendAttempted(cancelVerifiedContactSend(baseDir));
  if (!armed.ok) return withSendAttempted(armed, sendAttemptedFromState(armed.state));
  return sendReal(baseDir, {
    allowRealSend: true,
    userConfirmed: true,
    message,
    attemptId: options.attemptId,
    expectedIncomingMessage: options.expectedIncomingMessage,
    expectedIncomingRuntimeId: options.expectedIncomingRuntimeId,
    onTransition: options.onTransition
  }, options.sendDriver || clickWechatSendButtonAsync, options.sessionDriver || verifyWechatCurrentConversationAsync, options.bubbleVerifier || verifyWechatMessageBubbleAsync);
}

function personalWechatBindingValidity(result, expectedPid, expectedHWnd) {
  const pid = Number(result?.pid);
  const hWnd = String(result?.hWnd || "").trim();
  if (!Number.isFinite(pid) || pid <= 0 || !hWnd) return undefined;
  if (result?.processName && !["Weixin", "WeChat"].includes(result.processName)) return false;
  return pid === Number(expectedPid) && hWnd === String(expectedHWnd);
}

function samePersonalWechatWindow(result, expectedPid, expectedHWnd) {
  return result?.ok === true && personalWechatBindingValidity(result, expectedPid, expectedHWnd) === true;
}

async function executeVerifiedFileHelperSend(options = {}) {
  const message = String(options.message || "").trim();
  const expectedPid = Number(options.expectedPid);
  const expectedHWnd = String(options.sourceWindowHandle || "").trim();
  if (options.authorized !== true) {
    return withSendAttempted({ ok: false, action: "handoff", blocked_reason: "handoff_authorization_missing", error: "缺少本次人工提醒发送授权" });
  }
  if (!message) return withSendAttempted({ ok: false, action: "handoff", blocked_reason: "handoff_message_missing", error: "人工提醒内容为空" });
  if (!expectedPid || !expectedHWnd) {
    return withSendAttempted({ ok: false, action: "handoff", blocked_reason: "handoff_source_window_missing", error: "无法绑定原客户会话所在的微信窗口", binding_valid: false });
  }

  const openConversation = options.openConversation || openWechatSearchResultAsync;
  const verifyConversation = options.verifyConversation || verifyWechatConversationTitleAsync;
  const inputDraft = options.inputDraft || inputWechatMessageDraftAsync;
  const sendDriver = options.sendDriver || clickWechatSendButtonAsync;
  const bubbleVerifier = options.bubbleVerifier || verifyWechatMessageBubbleAsync;
  const target = "文件传输助手";
  const query = target;

  const windowContext = { pid: expectedPid, hWnd: expectedHWnd };
  const opened = await Promise.resolve(openConversation(query, {
    ...windowContext,
    resultAutomationId: `search_item_function_${target}`
  }));
  if (!samePersonalWechatWindow(opened, expectedPid, expectedHWnd)) {
    const bindingValid = personalWechatBindingValidity(opened, expectedPid, expectedHWnd);
    return withSendAttempted({
      ok: false,
      action: "handoff",
      blocked_reason: bindingValid === false ? "handoff_source_window_changed" : "handoff_conversation_open_failed",
      error: "文件传输助手未在原客户会话对应的微信窗口中打开",
      binding_valid: bindingValid
    });
  }
  const session = await Promise.resolve(verifyConversation(target, windowContext));
  if (!samePersonalWechatWindow(session, expectedPid, expectedHWnd) || String(session.title || "").trim() !== target) {
    return withSendAttempted({ ok: false, action: "handoff", blocked_reason: "handoff_conversation_not_verified", error: "文件传输助手会话未通过独立校验", binding_valid: personalWechatBindingValidity(session, expectedPid, expectedHWnd) });
  }
  const draft = await Promise.resolve(inputDraft(message, windowContext));
  if (!draft?.ok || draft.draftVerified !== true || !draft.draftPoint) {
    return withSendAttempted({ ok: false, action: "handoff", blocked_reason: "handoff_draft_not_verified", error: "人工提醒未能精确写入输入框" });
  }
  const sessionBeforeSend = await Promise.resolve(verifyConversation(target, windowContext));
  if (!samePersonalWechatWindow(sessionBeforeSend, expectedPid, expectedHWnd) || String(sessionBeforeSend.title || "").trim() !== target) {
    return withSendAttempted({ ok: false, action: "handoff", blocked_reason: "handoff_conversation_changed", error: "发送前文件传输助手会话发生变化", binding_valid: personalWechatBindingValidity(sessionBeforeSend, expectedPid, expectedHWnd) });
  }
  const context = {
    pid: expectedPid,
    hWnd: expectedHWnd,
    inputPoint: draft.draftPoint,
    expectedConversation: target,
    expectedMessage: message
  };
  const before = await Promise.resolve(bubbleVerifier(message, { ...context, phase: "before" }));
  if (!hasMessageSnapshot(before)) {
    return withSendAttempted({ ok: false, action: "handoff", blocked_reason: "handoff_snapshot_unavailable", error: "无法读取人工提醒发送前快照" });
  }

  let clicked;
  try {
    clicked = await Promise.resolve(sendDriver("{ENTER}", context));
  } catch {
    return withSendAttempted({ ok: false, action: "handoff", blocked_reason: "handoff_outcome_unknown", error: "人工提醒发送结果无法确认" }, null);
  }
  if (!clicked?.ok || clicked.conversationVerified !== true || clicked.draftVerified !== true) {
    if (clicked?.sendAttempted === false) {
      return withSendAttempted({ ok: false, action: "handoff", blocked_reason: clicked.reason || "handoff_send_not_attempted", error: "人工提醒尚未执行发送，可安全重试" });
    }
    return withSendAttempted({ ok: false, action: "handoff", blocked_reason: "handoff_outcome_unknown", error: "人工提醒发送结果无法确认" }, clicked?.sendAttempted === true ? true : null);
  }
  const verified = await Promise.resolve(bubbleVerifier(message, { ...context, phase: "after", beforeSnapshot: before.snapshot }));
  if (!isVerifiedNewMessage(verified, message, before.snapshot)) {
    return withSendAttempted({ ok: false, action: "handoff", blocked_reason: "handoff_outcome_unknown", error: "人工提醒发送后未通过新消息校验" }, true);
  }
  return withSendAttempted({ ok: true, action: "handoff", state: { real_send_status: "sent_verified" } }, true);
}

function failConversation(baseDir = __dirname) {
  const state = { ...loadState(baseDir), conversation_verified: false, send_gate_status: "blocked", send_gate_reason: "conversation_mismatch", real_send_armed: false, real_send_enabled: false, real_send_clicked: false, real_send_status: "blocked", real_send_reason: "conversation_mismatch", post_send_verified: false, post_send_status: "blocked", post_send_reason: "conversation_mismatch", message_bubble_verified: false, message_bubble_status: "blocked", message_bubble_reason: "conversation_mismatch", last_result: "blocked", blocked_reason: "conversation_mismatch" };
  saveState(baseDir, state);
  return output(false, "fail-conversation", state, { baseDir, blocked_reason: "conversation_mismatch" });
}

function verifyMessageBubble(baseDir = __dirname, verifier = verifyWechatMessageBubble) {
  const state = loadState(baseDir);
  const message = String(state.message_draft ?? "").trim();
  if (!state.real_send_clicked) return blockMessageBubble(baseDir, state, "real_send_not_clicked", "已阻断：尚未执行真实发送点击");
  if (!message) return blockMessageBubble(baseDir, state, "empty_message", "已阻断：待验证消息为空");
  if (state.message_bubble_snapshot_before === undefined || state.message_bubble_snapshot_before === null) {
    return persistOutcomeUnknown(baseDir, state, "message_snapshot_unavailable", true);
  }
  const verifyResult = verifier(message, { pid: state.window_pid, hWnd: state.window_handle, inputPoint: state.message_input_point, phase: "after", beforeSnapshot: state.message_bubble_snapshot_before });
  if (!isVerifiedNewMessage(verifyResult, message, state.message_bubble_snapshot_before)) return persistOutcomeUnknown(baseDir, state, "message_bubble_not_new_latest_exact", true);
  const draftConsumed = verifyResult.verificationMode === "draft_consumed";
  const nextState = { ...state, real_send_status: "sent_verified", real_send_attempts: state.real_send_attempt_key ? { ...(state.real_send_attempts ?? {}), [state.real_send_attempt_key]: "sent_verified" } : state.real_send_attempts, message_bubble_verified: !draftConsumed, message_bubble_status: draftConsumed ? "not_exposed" : "verified", message_bubble_reason: draftConsumed ? "uia_message_bubble_unavailable" : "", post_send_verified: true, post_send_status: draftConsumed ? "draft_consumed_verified" : "bubble_verified", post_send_reason: "", post_send_verification_mode: draftConsumed ? "draft_consumed" : "message_bubble", located_window_title: verifyResult.title ?? state.located_window_title, last_result: draftConsumed ? "sent_verified" : "message_bubble_verified", blocked_reason: "" };
  saveState(baseDir, nextState);
  return output(true, "verify-message-bubble", nextState, { baseDir });
}

module.exports = { executeVerifiedContactSend, executeVerifiedFileHelperSend, failConversation, refreshRealSendSession, sendReal, setRealSendArm, verifyMessageBubble, verifyRealSendSession };
