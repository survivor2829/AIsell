const crypto = require("node:crypto");
const { diagnostics, normalizeReceiptDiagnostics } = require("./diagnostics.cjs");
const path = require("node:path");
const { readContacts } = require("../../rpa/active_touch/state_machine.cjs");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { FLOATING_PROGRESS_WINDOW, floatingProgressPosition } = require("./floating-progress-window.cjs");
const { summarizeSendResult } = require("../shared/wechat-send-diagnostics.cjs");
const { AUTO_REPLY_ACTIONS, AUTO_REPLY_REASON_CODES } = require("./auto-reply-decision.cjs");
const {
  POLL_INTERVAL_MS,
  UNRESOLVED_TITLE_RECENT_SECONDS,
  UNREAD_SENDER_RECENT_SECONDS,
  FAST_RECHECK_MS,
  AUTO_REPLY_STATE_VERSION,
  MAX_STATE_ENTRIES,
  SCAN_DEGRADED_AFTER,
  USER_IDLE_WAIT_REASON,
  RECOVERY_ACTIONS,
  MANUAL_REVIEW_SEND_REASONS,
  SCAN_HEALTH_VALUES,
  AUTO_REPLY_ACTIVITY_PHASES,
  AUTO_REPLY_DELIVERY_STATES,
  CONTACT_GENERATION_FAILURES,
  HEALTHY_SCAN_REASONS,
  TRANSIENT_SCAN_FENCE_REASONS,
  RETRYABLE_CURRENT_SESSION_REASONS,
  SCAN_OBSERVATION_REASONS,
  SCAN_OBSERVATION_SOURCES,
  SCAN_OBSERVATION_TRIGGERS,
  SCAN_OBSERVATION_ROLES,
  SCAN_CAPTURE_MODES,
  SCAN_OBSERVATION_INTERVAL_MS,
  PENDING_OBSERVATION_REASONS,
  FATAL_STARTUP_PRIME_REASONS,
  TERMINAL_PENDING_OBSERVATION_REASONS,
  STRICT_SCOPE_WINDOW_RESET_REASONS
} = require("./auto-reply-constants.cjs");
const {
  normalizeText,
  expertDocuments,
  normalizeAutoReplyDecision,
  isReplyableText,
  isSafeReplyText,
  safeContextSuffix
} = require("./auto-reply-text.cjs");
const {
  sanitizeSystemError,
  diagnosticCode,
  sendDiagnosticReason,
  normalizeAiWarningCode,
  sanitizeSessionProbe,
  sanitizeMessageRead,
  sanitizeStructuredScanDiagnostics,
  scanReason,
  appendDiagnosticLine
} = require("./auto-reply-diagnostics.cjs");
const {
  readJson,
  dayKey,
  handoffInterruptedMessage,
  handoffDeliveryState,
  handoffNeedsConfirmation,
  manualFollowupMessage,
  pendingHandoffKey,
  normalizePendingObservation,
  normalizeFailureContext,
  migrateState
} = require("./auto-reply-state.cjs");
const {
  compactConversationAlias,
  contactConversationAliases,
  autoReplyConversationAliases,
  eligibleContacts,
  testContactLabel,
  testContactUniverse,
  testContactScopeOptions,
  resolveTestContactScope,
  normalizedContext,
  fingerprintFor,
  contactForAutoReplyConversation,
  incomingEvidenceFor,
  isTerminalProcessed,
  retryPolls,
  exceedsRateLimit,
  buildHandoffMessage,
  resolveWorkflowContactScope,
  handoffReasonLabel,
  handoffMetadata
} = require("./auto-reply-contacts.cjs");

const consumedClickTokens = new Set();

function createAutoReplyController(options = {}) {
  // The message being answered is still the conversation's newest one: WeChat's records show the
  // contact's message last, and nothing newer arrived after this occurrence was picked up. Lets the
  // send go ahead when the screen cannot read the latest bubble back.
  function incomingStillLatestInRecords(contact, seenAt) {
    if (/^visual-inbound-/u.test(String(contact?.id))) return false;
    try {
      const rows = receipts()?.messagesWith(contact.id, Math.floor(seenAt / 1000) - UNRESOLVED_TITLE_RECENT_SECONDS);
      const latest = Array.isArray(rows) ? rows.at(-1) : null;
      return Boolean(latest && latest.sender === contact.id && latest.createTime * 1000 <= seenAt + 2000);
    } catch { return false; }
  }
  // Our own texts WeChat recorded before the customer's latest message. On WeChat
  // 4.2 a screen read can miss a short customer bubble ("您好") and see one of
  // these older green bubbles as the latest message (2026-11-04); with the
  // records confirming the customer spoke last, that is unread text, not a reply.
  function outgoingBeforeLatestIncoming(contact, seenAt) {
    if (/^visual-inbound-/u.test(String(contact?.id))) return [];
    try {
      const rows = receipts()?.messagesWith(contact.id, Math.floor(seenAt / 1000) - 24 * 60 * 60);
      const latest = Array.isArray(rows) ? rows.at(-1) : null;
      if (!latest || latest.sender !== contact.id || latest.createTime * 1000 > seenAt + 2000) return [];
      return rows.filter((row) => row.sender && row.sender !== contact.id && Number(row.localType) === 1
        && row.createTime <= latest.createTime && String(row.content || "").trim())
        .slice(-3).map((row) => String(row.content).slice(0, 500));
    } catch { return []; }
  }
  // WeChat's own message records (injected in self-checks); null when they cannot be read.
  const receipts = () => {
    if (options.receipts !== undefined) return options.receipts;
    try { return require("../../rpa/wechat_db/wechat-db.cjs").receiptsForDataRoot(path.join(String(options.dataDir || ""), "..")); } catch { return null; }
  };
  const dataDir = String(options.dataDir || "");
  const activeTouchDir = String(options.activeTouchDir || "");
  const stateFile = path.join(dataDir, "auto-reply-state.json");
  const diagnosticLogFile = path.join(dataDir, "auto-reply-diagnostics.jsonl");
  const diagnosticRunId = crypto.randomBytes(8).toString("hex");
  let scanTraceId = crypto.randomUUID();
  const diagnosticTraceSecret = crypto.randomBytes(32);
  const coordinator = options.coordinator;
  const deepSeekClient = options.deepSeekClient;
  const expertStore = options.expertStore;
  const send = options.send;
  const sendHandoff = options.sendHandoff;
  const runStep = options.runStep;
  const scanIncoming = options.scanIncoming || require("../../rpa/active_touch/wechat_auto_reply_driver.cjs").scanWechatIncoming;
  const primeIncoming = options.primeIncoming || scanIncoming.primeBaselines;
  const verifyIncoming = options.verifyIncoming || require("../../rpa/active_touch/wechat_auto_reply_driver.cjs").verifyWechatIncoming;
  const schedule = options.schedule || setTimeout;
  const cancelSchedule = options.cancelSchedule || clearTimeout;
  const now = options.now || (() => new Date());
  const onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : null;
  const passport = options.passport || null;
  const passportFailureSignatures = new Set();
  const passportResults = new Map();
  const singleContactScopeRequired = options.singleContactScopeRequired === true;
  const rawState = readJson(stateFile, null);
  let state = migrateState(rawState, now());
  let diagnosticSequence = 0;
  let lastScanObservation = { key: "", at: 0 };
  if (rawState && (
    rawState.version !== AUTO_REPLY_STATE_VERSION
    || rawState.status === "running"
    || rawState.status === "starting"
    || Object.hasOwn(rawState, "last_ai_warning_code")
    || Object.hasOwn(rawState, "last_ai_warning")
    || JSON.stringify(rawState.system_error || null) !== JSON.stringify(state.system_error || null)
    || Object.values(rawState.processed || {}).some((entry) => normalizeText(entry?.status) === "sending")
    || JSON.stringify(rawState.reply_guards || {}) !== JSON.stringify(state.reply_guards || {})
    || JSON.stringify(rawState.contact_states || {}) !== JSON.stringify(state.contact_states || {})
    || JSON.stringify(rawState.last_failure_context || null) !== JSON.stringify(state.last_failure_context || null)
    || rawState.daily_date !== state.daily_date
    || Number(rawState.reply_count) !== state.reply_count
    || Boolean(rawState.pending_handoff) && (
      rawState.status !== state.status
      || rawState.last_event !== state.last_event
      || rawState.last_error !== state.last_error
      || rawState.pending_handoff?.key !== state.pending_handoff?.key
    )
  )) {
    state.updated_at = now().toISOString();
    writeJsonAtomic(stateFile, state);
  }
  let timer = null;
  let scanActive = false;
  let runEpoch = 0;
  let starting = false;
  let primeRetryNeeded = false;
  let activeTestContactScope = null;
  let workflowMode = false;
  let workflowRecipients = [];
  let workflowIsEnabled = () => false;
  let workflowStepActive = false;
  let workflowStartPending = true;
  let workflowPauseGeneration = 0;
  let restoreWorkflowChatSurface = true;
  let scanHour = "";
  let scanHourStats = null;
  function recordWorkflowScanStats(result, { prime = false, navigation = false } = {}) {
    if (!workflowMode) return;
    const hour = now().toISOString().slice(0, 13);
    if (scanHour && scanHour !== hour && scanHourStats) {
      appendDiagnostic("workflow_scan_hourly", { phase: "workflow", code: "workflow_scan_hourly", ...scanHourStats });
    }
    if (scanHour !== hour) {
      scanHour = hour;
      scanHourStats = { foreground_count: 0, observe_idle_count: 0, navigation_count: 0, passive_miss: 0,
        foreground_prime: 0, foreground_unread_candidate: 0, foreground_periodic_recheck: 0,
        foreground_pending_state: 0, foreground_chat_surface_restore: 0, foreground_passive_unusable: 0,
        foreground_other: 0 };
    }
    if (navigation) scanHourStats.navigation_count += 1;
    if (result?.passive === true && result.reason === "no_unread_message") scanHourStats.observe_idle_count += 1;
    if (result?.foregroundScan === true || prime) {
      scanHourStats.foreground_count += 1;
      const key = `foreground_${prime ? "prime" : result.foregroundReason}`;
      scanHourStats[Object.hasOwn(scanHourStats, key) ? key : "foreground_other"] += 1;
    }
    if (result?.passiveMiss === true) scanHourStats.passive_miss += 1;
  }
  let workflowHandled = false;
  let workflowProgress = null;
  let workflowBackoff = { attempt: 0, until: 0, reasonCode: "" };
  const workflowDiagnosticCache = new Map();
  const retryDelays = [30_000, 120_000, 300_000];
  function resetWorkflowBackoff() { workflowBackoff = { attempt: 0, until: 0, reasonCode: "" }; }
  function enterWorkflowBackoff(reasonCode) {
    const attempt = workflowBackoff.attempt + 1;
    const retryAfterMs = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)];
    workflowBackoff = { attempt, until: now().getTime() + retryAfterMs, reasonCode };
    workflowStartPending = true;
    state.last_event = "workflow_backoff";
    state.last_error = "";
    appendDiagnostic("workflow_backoff", { phase: "workflow", code: reasonCode, retry_attempt: attempt, retry_after_ms: retryAfterMs });
  }
  function backoffResult() {
    const retryAfterMs = Math.max(0, workflowBackoff.until - now().getTime());
    return { handled: false, status: "backoff", reasonCode: workflowBackoff.reasonCode,
      attempt: workflowBackoff.attempt, retryAfterMs,
      progressText: `${workflowBackoff.reasonCode === "workflow_chat_navigation_failed" ? "返回聊天失败" : "云端智能暂时不可用"}，约 ${Math.ceil(retryAfterMs / 1000)} 秒后自动重试` };
  }
  const initialActivityAt = now().toISOString();
  let availableTestContactOptions = singleContactScopeRequired ? testContactScopeOptions(activeTouchDir) : [];
  let activity = {
    phase: state.status === "running"
      ? "listening"
      : state.status === "starting"
        ? "starting"
        : state.status === "paused"
          ? "paused"
          : "idle",
    phase_started_at: initialActivityAt,
    contact_label: "",
    action: "",
    reason_code: "",
    trace_id: "",
    delivery_status: "not_attempted",
    detail_code: diagnosticCode(state.last_event, state.status === "paused" ? "paused" : "")
  };
  const pendingHandoffQueue = [];
  const retryGenerations = new Map();
  // Customer text stays in memory only. Durable state keeps opaque occurrence
  // evidence, while this cache carries preceding turns when the visual
  // adapter supplies only the current incoming batch.
  const conversationHistories = new Map();
  // A customer may add a second bubble while the first answer is still being
  // generated. Keep the superseded user turns in memory only so the next
  // decision answers the combined question without persisting customer text.
  const pendingUnsentContexts = new Map();
  let handoffConfirmationRequired = handoffNeedsConfirmation(state.pending_handoff);

  function contactState(contactId) {
    return state.contact_states?.[normalizeText(contactId)] || { clarify_pending: false, human_owned: false };
  }

  function updateContactState(contactId, patch) {
    const key = normalizeText(contactId);
    if (!key) return;
    state.contact_states ||= {};
    const next = { ...contactState(key), ...patch };
    if (!next.clarify_pending && !next.human_owned) delete state.contact_states[key];
    else state.contact_states[key] = {
      clarify_pending: next.clarify_pending === true,
      human_owned: next.human_owned === true
    };
    trimMap(state.contact_states);
  }

  function applyTerminalDecisionState(contactId, action) {
    if (action === "clarify") updateContactState(contactId, { clarify_pending: true });
    else if (action === "handoff") updateContactState(contactId, { clarify_pending: false, human_owned: true });
    else if (action === "answer") updateContactState(contactId, { clarify_pending: false });
  }

  function heldContacts() {
    const heldContactIds = Object.entries(state.contact_states || {})
      .filter(([, value]) => value?.human_owned === true)
      .map(([contactId]) => contactId);
    if (!heldContactIds.length) return [];
    const contactsById = new Map(readContacts(activeTouchDir).map((contact) => [normalizeText(contact?.id), contact]));
    return heldContactIds.map((contactId) => ({
      id: contactId,
      label: contactsById.has(contactId) ? testContactLabel(contactsById.get(contactId)) : `客户 ${crypto.createHash("sha256").update(contactId).digest("hex").slice(0, 6)}`
    }));
  }

  function mergedConversationContext(contactId, observedContext, candidate) {
    const remembered = conversationHistories.get(contactId) || [];
    const pending = pendingUnsentContexts.get(contactId);
    const currentRuntimeId = normalizeText(candidate?.runtimeId);
    const includePending = pending
      && normalizeText(pending.runtimeId)
      && normalizeText(pending.runtimeId) !== currentRuntimeId;
    const incomingBatch = candidate?.contextKind === "incoming_batch";
    // Several incoming bubbles are still only the latest customer turn, not
    // complete conversation history. Preserve earlier answered turns, then
    // merge any overlapping unsent batch without relying on mutable OCR keys.
    const previous = includePending ? pending.context : remembered;
    let combined = observedContext;
    if (incomingBatch) {
      let overlap = Math.min(previous.length, observedContext.length);
      while (overlap > 0 && !observedContext.slice(0, overlap).every((item, index) => {
        const preceding = previous[previous.length - overlap + index];
        return preceding.role === item.role && normalizeText(preceding.content) === normalizeText(item.content);
      })) overlap -= 1;
      combined = [...previous, ...observedContext.slice(overlap)];
    } else if (observedContext.length === 1) {
      // A legacy single-bubble observation is a new occurrence; equal wording
      // alone must not erase a genuinely repeated customer message.
      combined = [...previous, ...observedContext];
    }
    return safeContextSuffix(combined.slice(-12));
  }

  function rememberConversation(contactId, context, reply) {
    const assistant = normalizeText(reply);
    if (!assistant) return;
    conversationHistories.set(contactId, [
      ...context,
      { role: "assistant", content: assistant, key: "" }
    ].slice(-12));
    pendingUnsentContexts.delete(contactId);
  }

  function retainSupersededContext(contactId, context, candidate) {
    const runtimeId = normalizeText(candidate?.runtimeId);
    if (!contactId || !runtimeId || !Array.isArray(context) || !context.length) return;
    pendingUnsentContexts.set(contactId, {
      runtimeId,
      context: context
        .filter((item) => item?.role && normalizeText(item?.content))
        .map((item) => ({ role: item.role, content: normalizeText(item.content), key: normalizeText(item.key) }))
        .slice(-12)
    });
  }

  function notifyStateChange() {
    if (onStateChange) {
      try {
        onStateChange(publicState());
      } catch {
        // Renderer updates are best effort; durable state remains authoritative.
      }
    }
  }

  function setActivity(phase, details = {}) {
    const progressText = {
      prime: "正在初始化消息读取，完成后开始监听", scanning: "正在检查客户消息",
      candidate: "已发现客户消息", generating: "正在生成客户回复",
      preparing_send: "正在定位客户输入框", sending: "正在发送客户回复",
      sent_verified: "客户回复已发送", listening: "本次未发现待回复消息"
    }[phase];
    if (workflowMode && progressText) workflowProgress?.(progressText);
    // `waiting` has one precise meaning in the UI: the computer is actively
    // being used. Never use it as a generic fallback for scanner or sender
    // failures, otherwise a real execution fault looks like an idle gate.
    const nextPhase = AUTO_REPLY_ACTIVITY_PHASES.has(phase) ? phase : "scanning";
    const observedAt = now().toISOString();
    const phaseChanged = activity.phase !== nextPhase;
    const traceId = String(details.traceId || "").trim().toLowerCase();
    const action = normalizeText(details.action).toLowerCase();
    const deliveryStatus = diagnosticCode(details.deliveryStatus, "");
    const nextActivity = {
      ...activity,
      phase: nextPhase,
      phase_started_at: phaseChanged ? observedAt : activity.phase_started_at,
      ...(Object.hasOwn(details, "contactLabel")
        ? { contact_label: normalizeText(details.contactLabel) }
        : {}),
      ...(Object.hasOwn(details, "action") ? { action: AUTO_REPLY_ACTIONS.has(action) ? action : "" } : {}),
      ...(Object.hasOwn(details, "reasonCode")
        ? { reason_code: diagnosticCode(details.reasonCode, "") }
        : {}),
      ...(Object.hasOwn(details, "traceId")
        ? { trace_id: /^[a-f0-9]{24}$/u.test(traceId) ? traceId : "" }
        : {}),
      ...(Object.hasOwn(details, "deliveryStatus")
        ? { delivery_status: AUTO_REPLY_DELIVERY_STATES.has(deliveryStatus) ? deliveryStatus : "not_attempted" }
        : {}),
      ...(Object.hasOwn(details, "detailCode")
        ? { detail_code: diagnosticCode(details.detailCode, "") }
        : {})
    };
    if (JSON.stringify(nextActivity) === JSON.stringify(activity)) return;
    activity = nextActivity;
    notifyStateChange();
  }

  function save() {
    state.updated_at = now().toISOString();
    writeJsonAtomic(stateFile, state);
    notifyStateChange();
  }

  function setFailureContext(details) {
    state.last_failure_context = normalizeFailureContext(details);
  }

  function clearRecoveredScanFailureContext() {
    const context = normalizeFailureContext(state.last_failure_context);
    if (context && new Set(["scan", "prime"]).has(context.phase) && context.recovery_action === "wait_for_idle") {
      state.last_failure_context = null;
    }
  }

  function occurrenceTraceId(fingerprint) {
    const occurrence = normalizeText(fingerprint);
    if (!occurrence) return "";
    return crypto.createHmac("sha256", diagnosticTraceSecret).update(occurrence).digest("hex").slice(0, 24);
  }

  function candidateTraceId(candidate, fingerprint = "") {
    const evidence = incomingEvidenceFor(candidate);
    const strongEvidence = [
      evidence.runtimeId ? `runtime:${evidence.runtimeId}` : "",
      evidence.visualEvidenceRuntimeId ? `visual:${evidence.visualEvidenceRuntimeId}` : "",
      evidence.messageSignature ? `message:${evidence.messageSignature}` : ""
    ]
      .filter(Boolean);
    if (!strongEvidence.length) return occurrenceTraceId(fingerprint);
    return occurrenceTraceId([
      ...strongEvidence,
      Math.max(0, Math.floor(Number(candidate?.pid) || 0)),
      normalizeText(candidate?.hWnd)
    ].join("\n"));
  }

  function scanObservationReference(result) {
    const values = [
      result?.activeSessionBindingHash,
      result?.activeSessionMessageSignature,
      result?.messageSignature,
      result?.previewSignature,
      result?.runtimeId,
      result?.visualEvidenceRuntimeId
    ]
      .map((value) => normalizeText(value).toLowerCase())
      .filter((value) => /^[a-f0-9]{64}$/u.test(value) || /^visual:v[12]:[a-f0-9]{64}$/u.test(value));
    if (!values.length) return "";
    return crypto.createHmac("sha256", diagnosticTraceSecret).update(values.join("\n")).digest("hex").slice(0, 24);
  }

  function appendScanObservation(result, phase, reason) {
    const messageRead = sanitizeMessageRead(result?.messageRead);
    if (phase !== "scan" || !SCAN_OBSERVATION_REASONS.has(reason) && !Object.keys(messageRead).length) return;
    const rawSource = diagnosticCode(result?.source, "");
    const rawTrigger = diagnosticCode(result?.scanTrigger || result?.trigger, "");
    const source = SCAN_OBSERVATION_SOURCES.has(rawSource) ? rawSource : "scan_driver";
    const trigger = SCAN_OBSERVATION_TRIGGERS.has(rawTrigger) ? rawTrigger : "poll";
    const latestRole = diagnosticCode(result?.latestRole, "");
    const role = SCAN_OBSERVATION_ROLES.has(latestRole) ? latestRole : "unknown";
    const sessionBound = [result?.activeSessionBound, result?.currentSessionBound, result?.current_session_bound]
      .find((value) => typeof value === "boolean");
    const observationRef = scanObservationReference(result);
    const pid = Math.max(0, Math.floor(Number(result?.pid) || 0));
    const hWnd = normalizeText(result?.hWnd);
    const key = [reason, source, trigger, sessionBound, role, observationRef, pid, hWnd, result?.captureMode, JSON.stringify(messageRead)].join("\n");
    const observedAt = now().getTime();
    if (key === lastScanObservation.key
      && Number.isFinite(observedAt)
      && observedAt - lastScanObservation.at < SCAN_OBSERVATION_INTERVAL_MS) return;
    lastScanObservation = { key, at: Number.isFinite(observedAt) ? observedAt : 0 };
    appendDiagnostic("scan_observation", {
      phase,
      code: reason,
      scanSource: source,
      scanTrigger: trigger,
      currentSessionBound: sessionBound,
      latestRole: role,
      observationRef,
      pid: result?.pid,
      hWnd: result?.hWnd,
      captureMode: result?.captureMode,
      messageRead: result?.messageRead,
      headerRead: result?.headerRead,
      diagnostics: result?.diagnostics
    });
  }

  function appendDiagnostic(event, details = {}) {
    if (event === "workflow_scope_excluded" || event === "workflow_step_return") {
      const duringBackoff = event === "workflow_step_return" && workflowBackoff.until > now().getTime()
        && details.code === workflowBackoff.reasonCode;
      const signature = duringBackoff ? JSON.stringify([details.code, workflowBackoff.until])
        : JSON.stringify([details.code, details.eligible_count, details.alias_count,
          details.alias_json_length, details.excluded_count, details.excludedReasons]);
      if (workflowDiagnosticCache.get(event) === signature) return;
      workflowDiagnosticCache.set(event, signature);
    }
    const phase = diagnosticCode(details.phase, "runtime");
    const code = diagnosticCode(details.code || state.last_scan_reason, "");
    const entry = {
      v: 1,
      ts: now().toISOString(),
      run_id: diagnosticRunId,
      seq: ++diagnosticSequence,
      event: diagnosticCode(event, "diagnostic_event"),
      phase,
      status: diagnosticCode(state.status, "unknown"),
      scan_health: SCAN_HEALTH_VALUES.has(state.scan_health) ? state.scan_health : "unknown",
      consecutive_scan_failures: Math.max(0, Math.floor(Number(state.consecutive_scan_failures) || 0))
    };
    if (code) entry.code = code;
    const traceId = String(details.trace_id || details.traceId || "").trim().toLowerCase();
    if (/^[a-f0-9]{24}$/u.test(traceId)) entry.trace_id = traceId;
    const action = normalizeText(details.action).toLowerCase();
    if (AUTO_REPLY_ACTIONS.has(action)) entry.action = action;
    const reasonCode = normalizeText(details.reason_code || details.reasonCode).toLowerCase();
    if (AUTO_REPLY_REASON_CODES.has(reasonCode)) entry.reason_code = reasonCode;
    const errorCode = normalizeAiWarningCode(details.error_code || details.errorCode);
    if (errorCode) entry.error_code = errorCode;
    const pid = Math.floor(Number(details.pid));
    if (Number.isSafeInteger(pid) && pid > 0) entry.wechat_pid = pid;
    const windowHandle = String(details.hWnd || "").trim();
    if (/^[0-9]{1,20}$/.test(windowHandle)) entry.wechat_window_handle = windowHandle;
    const reasonRef = String(details.reasonRef || "").trim().toLowerCase();
    if (/^[a-f0-9]{12}$/.test(reasonRef)) entry.reason_ref = reasonRef;
    const captureMode = diagnosticCode(details.capture_mode || details.captureMode, "");
    if (SCAN_CAPTURE_MODES.has(captureMode)) entry.capture_mode = captureMode;
    const scanSource = diagnosticCode(details.scan_source || details.scanSource, "");
    if (SCAN_OBSERVATION_SOURCES.has(scanSource)) entry.scan_source = scanSource;
    const scanTrigger = diagnosticCode(details.scan_trigger || details.scanTrigger, "");
    if (SCAN_OBSERVATION_TRIGGERS.has(scanTrigger)) entry.scan_trigger = scanTrigger;
    if (typeof details.current_session_bound === "boolean") entry.current_session_bound = details.current_session_bound;
    else if (typeof details.currentSessionBound === "boolean") entry.current_session_bound = details.currentSessionBound;
    const latestRole = diagnosticCode(details.latest_role || details.latestRole, "");
    if (SCAN_OBSERVATION_ROLES.has(latestRole)) entry.latest_role = latestRole;
    if (entry.event === "scan_observation") Object.assign(entry, sanitizeMessageRead(details.messageRead));
    const observationRef = String(details.observation_ref || details.observationRef || "").trim().toLowerCase();
    if (/^[a-f0-9]{24}$/.test(observationRef)) entry.observation_ref = observationRef;
    for (const field of ["context_turn_count", "user_turn_count", "assistant_turn_count"]) {
      const count = Math.floor(Number(details[field]));
      if (Number.isSafeInteger(count) && count >= 0) entry[field] = count;
    }
    for (const field of ["duration_ms", "preflight_ms", "draft_ms", "before_send_ms", "send_ms", "total_ms"]) {
      const duration = Math.floor(Number(details[field]));
      if (Number.isSafeInteger(duration) && duration >= 0) entry[field] = duration;
    }
    for (const [field, maximum] of Object.entries({
      required_idle_ms: 60_000,
      observed_idle_ms: 86_400_000,
      retry_attempt: 100,
      retry_polls_remaining: 100,
      retry_after_ms: 300_000,
      eligible_count: 10_000,
      alias_count: 30_000,
      alias_json_length: 1_000_000,
      excluded_count: 10_000,
      scope_ms: 60_000
    })) {
      const numeric = Math.floor(Number(details[field]));
      if (Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= maximum) entry[field] = numeric;
    }
    const deliveryAttempt = Math.floor(Number(details.delivery_attempt));
    if (entry.event === "workflow_scan_hourly") {
      for (const field of ["foreground_count", "observe_idle_count", "navigation_count", "passive_miss",
        "foreground_prime", "foreground_unread_candidate", "foreground_periodic_recheck",
        "foreground_pending_state", "foreground_chat_surface_restore", "foreground_passive_unusable", "foreground_other"]) {
        const count = Math.floor(Number(details[field]));
        if (Number.isSafeInteger(count) && count >= 0) entry[field] = count;
      }
    }
    if (Number.isSafeInteger(deliveryAttempt) && deliveryAttempt >= 1 && deliveryAttempt <= 100) entry.delivery_attempt = deliveryAttempt;
    if (typeof details.send_attempted === "boolean") entry.send_attempted = details.send_attempted;
    if (typeof details.draft_phase_started === "boolean") entry.draft_phase_started = details.draft_phase_started;
    if (typeof details.composer_touched === "boolean") entry.composer_touched = details.composer_touched;
    Object.assign(entry, normalizeReceiptDiagnostics(details));
    const draftStage = diagnosticCode(details.draft_stage, "");
    if (draftStage) entry.draft_stage = draftStage;
    const inputReadReason = diagnosticCode(details.input_read_reason, "");
    if (inputReadReason) entry.input_read_reason = inputReadReason;
    const incomingChangeKind = diagnosticCode(details.incoming_change_kind, "");
    if (new Set(["ocr_unresolved", "proven_different"]).has(incomingChangeKind)) entry.incoming_change_kind = incomingChangeKind;
    const sendResult = diagnosticCode(details.send_result, "");
    if (new Set(["not_attempted", "sent_verified", "outcome_unknown"]).has(sendResult)) entry.send_result = sendResult;
    for (const field of ["outcome", "side_effect", "retryability", "failure_stage"]) {
      const value = diagnosticCode(details[field], "");
      if (value) entry[field] = value;
    }
    const recoveryAction = diagnosticCode(details.recovery_action, "");
    if (RECOVERY_ACTIONS.has(recoveryAction)) entry.recovery_action = recoveryAction;
    const sendPhase = diagnosticCode(details.send_phase, "");
    if (sendPhase) entry.send_phase = sendPhase;
    const verificationMode = diagnosticCode(details.verification_mode, "");
    if (verificationMode) entry.verification_mode = verificationMode;
    if (code === "session_probe_unsupported") Object.assign(entry, sanitizeSessionProbe(details.sessionProbe));
    Object.assign(entry, sanitizeStructuredScanDiagnostics(details));
    Object.assign(entry, require("../shared/wechat-window-diagnostics.cjs").sanitizeWechatWindowDiagnostics(details.diagnostics));
    appendDiagnosticLine(diagnosticLogFile, entry);
    const passportTaskId = entry.trace_id || `${diagnosticRunId}-${entry.seq}`;
    const passportReason = entry.reason_code || entry.code || "";
    passport?.recordEvent("auto_reply", passportTaskId, {
      stage: entry.event,
      direction: /started$/u.test(entry.event) ? "in" : "out",
      durationMs: entry.total_ms ?? entry.duration_ms,
      status: entry.send_result || entry.status || "observed",
      reasonCode: passportReason,
      traceId: entry.trace_id || ""
    });
    const passportFailure = entry.event === "reply_send_finished" && entry.code !== "sent_verified"
      || /(?:failed|exception|blocked|skipped)$/u.test(entry.event);
    if (passportFailure) {
      const signature = `${passportTaskId}\0${entry.event}\0${passportReason}`;
      if (!passportFailureSignatures.has(signature)) {
        passportFailureSignatures.add(signature);
        const evidence = passport?.recordFailure("auto_reply", passportTaskId, {
          stage: entry.event,
          reasonCode: passportReason || "auto_reply_failure_reason_missing",
          traceId: entry.trace_id || "",
          rawReading: details,
          expected: { send_result: "sent_verified", current_session_bound: true }
        });
        if (evidence?.attachments?.length) entry.passport_attachments = evidence.attachments;
      }
    }
    if (entry.event === "reply_send_finished" || entry.event === "reply_send_skipped") {
      const status = entry.send_result || (entry.event === "reply_send_skipped" ? entry.action === "handoff" ? "handoff" : "silent" : "failed");
      passportResults.set(passportTaskId, {
        taskId: passportTaskId,
        status,
        reasonCode: status === "sent_verified" ? "" : passportReason || "auto_reply_failure_reason_missing",
        attachments: entry.passport_attachments || []
      });
      passport?.writeRunBill("auto_reply", diagnosticRunId, [...passportResults.values()]);
    }
    const waitingDiagnostic = entry.code === USER_IDLE_WAIT_REASON
      || new Set(["scan_waiting", "reply_retry_enqueued", "reply_retry_waiting", "reply_manual_review_required"]).has(entry.event);
    const failedSendDiagnostic = entry.event === "reply_send_finished" && entry.code !== "sent_verified";
    diagnostics().event("auto_reply", entry.event, {
      ...entry,
      ...(details.local_raw ? { local_raw: details.local_raw } : {}),
      scan_mode: entry.scan_source,
      trigger_code: entry.scan_trigger,
      legacy_diagnostic_run_id: entry.run_id
    }, {
      level: waitingDiagnostic ? "warn" : /failed|exception|blocked/u.test(entry.event) || failedSendDiagnostic ? "error" : "info",
      code: entry.code || "",
      phase: entry.phase || "",
      traceId: scanTraceId,
      trace: ["scan_observation", "start_requested", "started", "prime_deferred"].includes(entry.event),
      recover: entry.event === "scan_healthy" || entry.code === "sent_verified"
    });
  }

  function markWechatBusy() {
    const changed = state.scan_health !== "waiting" || state.last_scan_reason !== "wechat_operation_busy";
    state.scan_health = "waiting";
    state.last_scan_reason = "wechat_operation_busy";
    if (changed) appendDiagnostic("scan_waiting", { phase: "coordinator", code: "wechat_operation_busy" });
  }

  function recordScanResult(result, phase = "scan") {
    const previousHealth = state.scan_health;
    const previousReason = state.last_scan_reason;
    const previousFailures = Math.max(0, Math.floor(Number(state.consecutive_scan_failures) || 0));
    const normalizedReason = result?.ok === true
      ? result?.reason ? scanReason(result.reason) : { code: phase === "prime" ? "baseline_ready" : "candidate_detected", ref: "" }
      : scanReason(result?.reason);
    const reason = normalizedReason.code;
    const observedAt = now().toISOString();
    state.last_scan_at = observedAt;
    state.last_scan_reason = reason;

    const neutral = reason === "baseline_epoch_changed"
      || reason === "unread_preview_pending"
      || RETRYABLE_CURRENT_SESSION_REASONS.has(reason)
      || phase === "prime" && reason === "no_current_conversation";
    const successful = result?.ok === true || HEALTHY_SCAN_REASONS.has(reason);
    const waitingForUserIdle = reason === USER_IDLE_WAIT_REASON;
    if (waitingForUserIdle) {
      state.scan_health = "waiting";
      state.consecutive_scan_failures = 0;
      if (normalizeFailureContext(state.last_failure_context)?.phase !== "send") {
        setFailureContext({
          phase: phase === "prime" ? "prime" : "scan",
          code: reason,
          recovery_action: "wait_for_idle",
          required_idle_ms: result?.requiredIdleMs ?? result?.required_idle_ms,
          observed_idle_ms: result?.observedIdleMs ?? result?.observed_idle_ms
        });
      }
    } else if (neutral) {
      if (!SCAN_HEALTH_VALUES.has(state.scan_health) || state.scan_health === "unknown") state.scan_health = "checking";
    } else if (successful) {
      state.scan_health = "healthy";
      state.last_scan_success_at = observedAt;
      state.consecutive_scan_failures = 0;
      clearRecoveredScanFailureContext();
    } else {
      state.consecutive_scan_failures = Math.max(0, Math.floor(Number(state.consecutive_scan_failures) || 0)) + 1;
      state.scan_health = state.consecutive_scan_failures >= SCAN_DEGRADED_AFTER ? "degraded" : "warning";
    }

    const changed = previousHealth !== state.scan_health || previousReason !== reason;
    const recovered = successful && (previousFailures > 0 || previousHealth === "warning" || previousHealth === "degraded");
    const becameHealthy = successful && previousHealth !== "healthy";
    const faultChanged = !successful && !neutral && !waitingForUserIdle && changed;
    appendScanObservation(result, phase, reason);
    if (waitingForUserIdle && changed || neutral && changed || recovered || becameHealthy || faultChanged) {
      appendDiagnostic(waitingForUserIdle ? "scan_waiting" : neutral ? phase === "prime" ? "prime_skipped" : "scan_cancelled" : recovered ? "scan_recovered" : successful ? "scan_healthy" : "scan_failed", {
        phase,
        code: reason,
        reasonRef: normalizedReason.ref,
        pid: result?.pid,
        hWnd: result?.hWnd,
        sessionProbe: result?.sessionProbe,
        transitionDetail: result?.transitionDetail,
        nestedReason: result?.nestedReason,
        window: result?.window,
        dpi: result?.dpi ?? result?.DPI ?? result?.windowDpi,
        counts: result?.counts,
        headerRead: result?.headerRead,
        headerSite: result?.headerSite,
        unreadSenderHinted: result?.unreadSenderHinted,
        diagnostics: result?.diagnostics,
        required_idle_ms: result?.requiredIdleMs ?? result?.required_idle_ms,
        observed_idle_ms: result?.observedIdleMs ?? result?.observed_idle_ms
      });
    }
    return successful || neutral || waitingForUserIdle;
  }

  function publicState() {
    const manualWarning = manualFollowupMessage(state.manual_followups);
    const showManualWarning = Boolean(manualWarning) && !normalizeText(state.last_error);
    return {
      status: state.status,
      reply_count: state.reply_count,
      last_event: showManualWarning ? "handoff_manual_followup_required" : state.last_event,
      last_error: showManualWarning ? manualWarning : state.last_error,
      system_error: state.system_error && typeof state.system_error === "object" ? { ...state.system_error } : null,
      held_contacts: heldContacts(),
      last_failure_context: normalizeFailureContext(state.last_failure_context),
      scan_health: state.scan_health,
      last_scan_at: state.last_scan_at,
      last_scan_success_at: state.last_scan_success_at,
      last_scan_reason: state.last_scan_reason,
      consecutive_scan_failures: state.consecutive_scan_failures,
      pending_retry_count: Math.max(0, Number(state.pending_observation?.attempts) || 0),
      activity: { ...activity },
      ...(singleContactScopeRequired && !workflowMode ? {
        test_scope: {
          required: true,
          enforced: Boolean(activeTestContactScope),
          contact_label: activeTestContactScope?.contactLabel || "",
          available_contacts: availableTestContactOptions.map((contact) => ({ ...contact })),
          reset_on_restart: true
        }
      } : {}),
      updated_at: state.updated_at
    };
  }

  function discardTestScopeRuntimeState() {
    state.pending_observation = null;
    primeRetryNeeded = false;
    retryGenerations.clear();
    conversationHistories.clear();
    pendingUnsentContexts.clear();
    try {
      scanIncoming.resetBaselines?.();
    } catch {}
  }

  function clearTestContactScope() {
    if (!singleContactScopeRequired || workflowMode) return;
    activeTestContactScope = null;
    discardTestScopeRuntimeState();
  }

  function resolveContactScope() {
    if (workflowMode) {
      const scope = resolveWorkflowContactScope(activeTouchDir, workflowRecipients);
      const driverOptions = { ...scope.driverOptions, onProgress: workflowProgress,
        restoreChatSurface: restoreWorkflowChatSurface,
        // WeChat's records say who wrote last. When exactly one recipient's chat changed in the
        // last minutes and its newest message is theirs, the driver may use that name for a chat
        // whose title and list row OCR could not read. (The unread counter alone lags: WeChat
        // writes it after the scan has already opened the chat.)
        unreadSenderHint: () => {
          let hint = "";
          try {
            const db = receipts();
            const since = Math.floor(now().getTime() / 1000) - UNREAD_SENDER_RECENT_SECONDS;
            const sessions = db?.recentSessions(since);
            if (Array.isArray(sessions)) {
              const waiting = (scope.contacts || []).filter((contact) => sessions.some((session) => session.username === contact.id
                && (session.unread > 0 || db.messagesWith(contact.id, since)?.at(-1)?.sender === contact.id)));
              if (waiting.length === 1) hint = normalizeText(waiting[0].remark || waiting[0].name);
            }
          } catch { hint = ""; }
          appendDiagnostic("unread_sender_hint", { phase: "scan", code: hint ? "named" : "none" });
          return hint;
        } };
      driverOptions.onChatSurfaceRestored = () => {
        restoreWorkflowChatSurface = false;
        driverOptions.restoreChatSurface = false;
        recordWorkflowScanStats(null, { navigation: true });
      };
      return { ...scope, driverOptions };
    }
    if (!singleContactScopeRequired) {
      const contacts = eligibleContacts(activeTouchDir);
      return {
        ok: true,
        strict: false,
        contacts,
        aliases: autoReplyConversationAliases(contacts),
        resolveContact: (candidate) => contactForAutoReplyConversation(contacts, candidate)
      };
    }
    if (!activeTestContactScope) {
      return { ok: false, code: "test_contact_required", error: "请先选择一位已同步联系人" };
    }
    const refreshed = resolveTestContactScope(activeTouchDir, activeTestContactScope.contactId);
    if (!refreshed.ok) return refreshed;
    if (refreshed.scope.binding !== activeTestContactScope.binding) {
      return { ok: false, code: "test_contact_scope_changed", error: "所选测试联系人资料已变化，请重新选择" };
    }
    const scope = refreshed.scope;
    return {
      ok: true,
      strict: true,
      scopeBinding: scope.binding,
      contacts: [scope.contact],
      aliases: scope.aliases,
      driverOptions: { exactConversationMatch: true },
      resolveContact: (candidate) => {
        if (candidate?.messageDriven === true) return null;
        const conversation = normalizeText(candidate?.conversation || candidate?.currentConversation);
        const conversationEvidence = compactConversationAlias(candidate?.conversationEvidence);
        if (normalizeText(candidate?.visualMode) === "visual_render_v1"
          && (!conversationEvidence || conversationEvidence !== compactConversationAlias(conversation))) return null;
        return conversation && scope.aliasKeys.has(compactConversationAlias(conversation)) ? scope.contact : null;
      }
    };
  }

  function resetDailyCounter(current) {
    const today = dayKey(current);
    if (state.daily_date === today) return;
    state.daily_date = today;
    state.reply_count = 0;
  }

  function status() {
    if (singleContactScopeRequired) availableTestContactOptions = testContactScopeOptions(activeTouchDir);
    const previousDate = state.daily_date;
    resetDailyCounter(now());
    if (state.daily_date !== previousDate) save();
    return publicState();
  }

  function queueNext(delay = POLL_INTERVAL_MS) {
    if (workflowMode || timer || state.status !== "running") return;
    timer = schedule(async () => {
      timer = null;
      try {
        await runOnce();
      } catch (error) {
        pauseForFailure("auto_reply_scheduler_error_paused", error?.message || error || "自动回复轮询失败");
        saveBestEffort();
      } finally {
        if (state.status === "running") {
          try {
            queueNext();
          } catch (error) {
            pauseForFailure("auto_reply_scheduler_error_paused", error?.message || error || "自动回复轮询调度失败");
            saveBestEffort();
          }
        }
      }
    }, delay);
  }

  function trimMap(map) {
    const keys = Object.keys(map || {});
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_STATE_ENTRIES))) delete map[key];
  }

  function remember(hash, value) {
    state.processed ||= {};
    state.processed[hash] = value;
    trimMap(state.processed);
  }

  function syncPendingHandoffHead() {
    state.pending_handoff = pendingHandoffQueue[0]?.metadata || state.pending_handoffs?.[0] || null;
  }

  function removePendingHandoff(key) {
    const payloadIndex = pendingHandoffQueue.findIndex((item) => item.metadata.key === key);
    if (payloadIndex >= 0) pendingHandoffQueue.splice(payloadIndex, 1);
    state.pending_handoffs = (state.pending_handoffs || []).filter((item) => pendingHandoffKey(item) !== key);
    syncPendingHandoffHead();
  }

  function addManualFollowup(metadata) {
    const key = pendingHandoffKey(metadata);
    state.manual_followups ||= [];
    if (state.manual_followups.some((item) => pendingHandoffKey(item) === key)) return false;
    state.manual_followups.push({ ...metadata, key, delivery_state: "manual_required" });
    if (state.manual_followups.length > MAX_STATE_ENTRIES) state.manual_followups.shift();
    return true;
  }

  function movePendingHandoffToManual(key) {
    const pending = (state.pending_handoffs || []).find((item) => pendingHandoffKey(item) === key)
      || pendingHandoffQueue.find((item) => item.metadata.key === key)?.metadata;
    if (!pending) return;
    addManualFollowup({ ...pending, key });
    removePendingHandoff(key);
  }

  function updateHandoffDeliveryState(key, deliveryState) {
    const normalized = handoffDeliveryState(deliveryState);
    const persisted = (state.pending_handoffs || []).find((item) => pendingHandoffKey(item) === key);
    const payload = pendingHandoffQueue.find((item) => item.metadata.key === key);
    if (persisted) persisted.delivery_state = normalized;
    if (payload) payload.metadata.delivery_state = normalized;
    syncPendingHandoffHead();
  }

  function acknowledgePendingHandoff() {
    if (!state.pending_handoff || state.last_event !== "handoff_confirmation_required") return;
    const pending = state.pending_handoff;
    const key = pendingHandoffKey(pending);
    state.handoff_notified ||= {};
    state.handoff_notified[key] = {
      contact_id: pending.contact_id,
      at: now().toISOString(),
      status: "manual_acknowledged"
    };
    removePendingHandoff(key);
    handoffConfirmationRequired = false;
    trimMap(state.handoff_notified);
  }

  function recoverKnownUnsentHandoffs() {
    if (pendingHandoffQueue.length) return "";
    while (state.pending_handoff && !handoffNeedsConfirmation(state.pending_handoff)) {
      const pending = state.pending_handoff;
      const key = pendingHandoffKey(pending);
      movePendingHandoffToManual(key);
    }
    return manualFollowupMessage(state.manual_followups);
  }

  function acknowledgeManualFollowup() {
    const followups = Array.isArray(state.manual_followups) ? state.manual_followups : [];
    if (!followups.length) return { ok: true, state: publicState() };
    state.handoff_notified ||= {};
    const pending = followups.shift();
    const key = pendingHandoffKey(pending);
    state.handoff_notified[key] = {
      contact_id: pending.contact_id,
      at: now().toISOString(),
      status: "manual_followup_acknowledged"
    };
    state.manual_followups = followups;
    if (state.manual_followups.length) {
      state.last_event = "handoff_manual_followup_required";
      state.last_error = manualFollowupMessage(state.manual_followups);
    } else if (state.last_event === "handoff_manual_followup_required") {
      state.last_event = state.status === "running" ? "manual_followup_acknowledged" : "paused_by_user";
      state.last_error = "";
    }
    trimMap(state.handoff_notified);
    save();
    return { ok: true, state: publicState() };
  }

  function pause(reason = "paused_by_user") {
    runEpoch += 1;
    if (reason === "paused_by_user" || reason === "workflow_paused") workflowPauseGeneration += 1;
    workflowStartPending = false;
    resetWorkflowBackoff();
    if (timer) cancelSchedule(timer);
    timer = null;
    pendingUnsentContexts.clear();
    clearTestContactScope();
    if (state.pending_handoff && handoffConfirmationRequired) pauseForFailure("handoff_confirmation_required", "");
    else {
      state.status = "paused";
      state.last_event = reason;
    }
    setActivity("paused", { detailCode: state.last_event || reason });
    appendDiagnostic("paused", { phase: "control", code: state.last_event || reason });
    save();
    return { ok: true, state: publicState() };
  }

  function processedEvidenceMetadata(contact, candidate, evidence) {
    return {
      contact_id: contact.id,
      incoming_evidence: evidence.id,
      evidence_kind: evidence.kind,
      incoming_runtime_id: evidence.runtimeId,
      visual_evidence_runtime_id: evidence.visualEvidenceRuntimeId,
      message_signature: evidence.messageSignature
    };
  }

  function recordReplyGuard(contact, candidate, fingerprint, evidence, sentAt, deliveryStatus = "sent_verified", turnEpoch = 0) {
    state.reply_guards ||= {};
    state.reply_guards[contact.id] = {
      ...processedEvidenceMetadata(contact, candidate, evidence),
      conversation: normalizeText(candidate?.conversation),
      fingerprint,
      delivery_status: deliveryStatus,
      turn_state: deliveryStatus === "sent_verified" ? "outgoing_observed" : "awaiting_outgoing_observation",
      outgoing_observation: "",
      outgoing_observed_at: "",
      turn_epoch: Math.max(0, Math.floor(Number(turnEpoch) || 0)),
      at: sentAt.toISOString()
    };
    trimMap(state.reply_guards);
  }

  function noteVisualSendAttempt(candidate, result, outcomeUnknown = false) {
    const verificationMode = normalizeText(result?.verification_mode);
    if (!outcomeUnknown && !new Set(["visual_message_bubble", "draft_consumed_same_header"]).has(verificationMode)) return 0;
    try {
      if (typeof scanIncoming.noteSendAttempted === "function") {
        const attempt = scanIncoming.noteSendAttempted(candidate, { verificationMode, outcomeUnknown });
        const turnEpoch = Math.floor(Number(attempt?.turnEpoch));
        return Number.isSafeInteger(turnEpoch) && turnEpoch >= 0 ? turnEpoch : 0;
      }
      return !outcomeUnknown && scanIncoming.noteVerifiedSend?.(candidate, { verificationMode }) === true ? 0 : 0;
    } catch {
      return 0;
    }
  }

  function recordOutgoingObservation(candidate, observedAt, resolveContact) {
    const isScanObservation = normalizeText(candidate?.reason) === "latest_message_not_incoming";
    const isPrimeObservation = candidate?.ok === true
      && (normalizeText(candidate?.source) === "session_prime" || candidate?.primed === true);
    if ((!isScanObservation && !isPrimeObservation) || normalizeText(candidate?.latestRole) !== "assistant") return false;
    const baseline = candidate?.messageBaselineAdvance;
    const conversation = normalizeText(baseline?.conversation || candidate?.conversation || candidate?.currentConversation);
    const signature = normalizeText(baseline?.signature || candidate?.messageSignature || candidate?.currentMessageSignature).toLowerCase();
    if (!conversation || !/^[a-f0-9]{64}$/u.test(signature)) return false;
    const contact = typeof resolveContact === "function" ? resolveContact(candidate) : null;
    if (contact) pendingUnsentContexts.delete(contact.id);
    const guard = contact ? state.reply_guards?.[contact.id] : null;
    if (!guard || normalizeText(guard.turn_state) !== "awaiting_outgoing_observation") return false;
    guard.turn_state = "outgoing_observed";
    guard.outgoing_observation = signature;
    guard.outgoing_observed_at = observedAt.toISOString();
    return true;
  }

  async function waitForScanIdle() {
    while (scanActive) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  function pendingObservationMatches(candidate) {
    const pending = state.pending_observation;
    if (!pending) return false;
    const conversation = normalizeText(candidate?.conversation || candidate?.currentConversation);
    if (pending.conversation && conversation && pending.conversation !== conversation) return false;
    const pid = Math.max(0, Math.floor(Number(candidate?.pid) || 0));
    const hWnd = normalizeText(candidate?.hWnd);
    if (pending.pid && pid && pending.pid !== pid) return false;
    if (pending.hWnd && hWnd && pending.hWnd !== hWnd) return false;
    const messageSignature = normalizeText(candidate?.pendingMessageSignature || candidate?.messageSignature).toLowerCase();
    if (/^[a-f0-9]{64}$/u.test(messageSignature) && pending.message_signature !== messageSignature) return false;
    return true;
  }

  function rebindPendingObservation(candidate, observedAt) {
    const pending = state.pending_observation;
    if (!pending || Number(pending.rebind_attempts || 0) >= 1) return false;
    const conversation = normalizeText(candidate?.conversation || candidate?.currentConversation);
    if (conversation && pending.conversation !== conversation) return false;
    const pid = Math.max(0, Math.floor(Number(candidate?.pid) || 0));
    const hWnd = normalizeText(candidate?.hWnd);
    if (!pid || !/^[1-9][0-9]{0,19}$/u.test(hWnd)) return false;
    if (pending.pid === pid && pending.hWnd === hWnd) return false;
    const rebound = normalizePendingObservation({
      ...pending,
      pid,
      hWnd,
      // The persisted conversation + message signature remain authoritative.
      // The next driver recovery pass must observe that exact bubble in the
      // newly discovered window before it can become a reply candidate.
      rebind_attempts: Number(pending.rebind_attempts || 0) + 1,
      attempts: Number(pending.attempts || 1) + 1,
      last_seen_at: observedAt.toISOString()
    }, observedAt);
    if (!rebound) return false;
    let handedOff = false;
    if (typeof scanIncoming.restorePendingObservation === "function") {
      try {
        handedOff = scanIncoming.restorePendingObservation(rebound) === true;
      } catch {
        handedOff = false;
      }
    }
    if (!handedOff) return false;
    state.pending_observation = rebound;
    return true;
  }

  function advancePendingObservationAttempt(candidate, observedAt) {
    const pending = state.pending_observation;
    if (!pending) return false;
    const next = normalizePendingObservation({
      ...pending,
      attempts: Number(pending.attempts || 1) + 1,
      last_seen_at: observedAt.toISOString(),
      pid: candidate?.pid || pending.pid,
      hWnd: candidate?.hWnd || pending.hWnd
    }, observedAt);
    state.pending_observation = next;
    return Boolean(next);
  }

  function retainPendingObservation(candidate, observedAt, reasonOverride = "") {
    const previous = state.pending_observation;
    const reason = normalizeText(reasonOverride || candidate?.reason);
    const sameObservation = pendingObservationMatches(candidate);
    const keepInFlightAttempt = reason === "reply_in_flight"
      && sameObservation
      && normalizeText(previous?.reason) === "reply_in_flight";
    const value = normalizePendingObservation({
      ...(previous || {}),
      reason,
      conversation: normalizeText(candidate?.conversation || candidate?.currentConversation || previous?.conversation),
      pid: candidate?.pid || previous?.pid,
      hWnd: candidate?.hWnd || previous?.hWnd,
      runtime_id: candidate?.runtimeId || previous?.runtime_id,
      visual_evidence_runtime_id: candidate?.visualEvidenceRuntimeId
        || (/^visual:v1:/u.test(normalizeText(candidate?.runtimeId)) ? candidate.runtimeId : "")
        || previous?.visual_evidence_runtime_id,
      preview_signature: candidate?.pendingPreviewSignature || candidate?.previewSignature || previous?.preview_signature,
      message_signature: candidate?.pendingMessageSignature || candidate?.messageSignature || previous?.message_signature,
      predecessor_preview_signature: candidate?.predecessorPreviewSignature || previous?.predecessor_preview_signature,
      predecessor_message_signature: candidate?.predecessorMessageSignature || previous?.predecessor_message_signature,
      attempts: sameObservation ? keepInFlightAttempt ? Number(previous?.attempts || 1) : Number(previous?.attempts || 0) + 1 : 1,
      first_seen_at: sameObservation ? previous?.first_seen_at : observedAt.toISOString(),
      last_seen_at: observedAt.toISOString()
    }, observedAt);
    state.pending_observation = value;
    return value;
  }

  function clearPendingObservation(candidate) {
    if (pendingObservationMatches(candidate)) state.pending_observation = null;
  }

  function rejectedStart(error, code) {
    appendDiagnostic("start_blocked", { phase: "start", code: code || "start_rejected" });
    clearTestContactScope();
    return {
      ok: false,
      error,
      ...(code ? { code } : {}),
      state: publicState()
    };
  }

  async function start(payload = {}) {
    if (workflowMode) {
      if (workflowStepActive || workflowIsEnabled()) return rejectedStart("微信拓客计划运行中，请先暂停总任务");
      workflowMode = false;
      workflowRecipients = [];
      workflowStartPending = true;
      state.status = "paused";
    }
    if (state.status === "running") return { ok: true, state: publicState() };
    if (starting) return { ok: false, error: "自动回复正在启动，请稍候" };
    if (singleContactScopeRequired) {
      availableTestContactOptions = testContactScopeOptions(activeTouchDir);
      const selectedScope = resolveTestContactScope(activeTouchDir, payload?.contactId);
      if (!selectedScope.ok) return rejectedStart(selectedScope.error, selectedScope.code);
      activeTestContactScope = selectedScope.scope;
      // A prior test run may have kept an unsent observation in memory or on
      // disk. Never restore it into a newly selected contact scope.
      discardTestScopeRuntimeState();
    }
    const contactScope = resolveContactScope();
    if (!contactScope.ok) return rejectedStart(contactScope.error, contactScope.code);
    const contacts = contactScope.contacts;
    if (!contacts.length) return rejectedStart("没有可安全识别的已同步一对一联系人，请先同步联系人；如已同步，请检查重名联系人的备注", "contact_scope_empty");
    const conversationAliases = contactScope.aliases;
    if (!conversationAliases.length) return rejectedStart("已同步联系人没有唯一可识别的会话名称，请为重名联系人设置不同备注后重新同步", "contact_alias_ambiguous");
    try {
      deepSeekClient?.assertAvailable();
      expertDocuments(expertStore);
    } catch (error) {
      return rejectedStart(String(error?.message || error), error?.code);
    }
    if (typeof send !== "function" || typeof sendHandoff !== "function" || typeof runStep !== "function") {
      return rejectedStart("当前版本未启用经校验的自动回复执行器");
    }
    if (!contactScope.strict) acknowledgePendingHandoff();
    let recoveredHandoffWarning = "";
    if (!contactScope.strict && state.pending_handoff && !pendingHandoffQueue.length && handoffNeedsConfirmation(state.pending_handoff)) {
      handoffConfirmationRequired = handoffNeedsConfirmation(state.pending_handoff);
      pauseForFailure("handoff_confirmation_required", "还有未确认的人工提醒");
      save();
      return { ok: false, error: state.last_error, state: publicState() };
    }
    starting = true;
    runEpoch += 1;
    const startEpoch = runEpoch;
    state.status = "starting";
    state.last_event = "starting";
    state.last_error = "";
    state.system_error = null;
    state.scan_health = "checking";
    state.consecutive_scan_failures = 0;
    resetDailyCounter(now());
    setActivity("starting", {
      contactLabel: activeTestContactScope?.contactLabel || (contactScope.strict ? "测试联系人" : "全部已同步联系人"),
      action: "",
      reasonCode: "",
      traceId: "",
      deliveryStatus: "not_attempted",
      detailCode: "starting"
    });
    scanTraceId = crypto.randomUUID();
    appendDiagnostic("start_requested", { phase: "prime", code: "starting" });
    save();
    try {
      await waitForScanIdle();
      if (runEpoch !== startEpoch || state.status !== "starting") return { ok: false, error: "自动回复启动已取消", state: publicState() };
      const pendingObservation = contactScope.strict ? null : state.pending_observation;
      if (contactScope.strict) state.pending_observation = null;
      let pendingRestored = false;
      let pendingRestoreDeferred = false;
      if (pendingObservation && typeof scanIncoming.restorePendingObservation === "function") {
        try {
          pendingRestored = scanIncoming.restorePendingObservation(pendingObservation) === true;
        } catch {
          pendingRestored = false;
        }
      }
      // A successful handoff is not consumption: the process can still crash
      // before the driver returns the recovered candidate. Keep the durable
      // observation until that candidate or an explicit terminal result is
      // observed. An in-flight reply gets bounded restore retries because a
      // driver may still be initializing; an ordinary preview handoff rejection
      // remains an explicit incompatible-state terminal.
      if (pendingObservation && !pendingRestored) {
        const retryInFlightRestore = normalizeText(pendingObservation.reason) === "reply_in_flight"
          && advancePendingObservationAttempt({}, now());
        if (retryInFlightRestore) {
          pendingRestored = true;
          pendingRestoreDeferred = true;
        }
        else state.pending_observation = null;
      }
      if (!pendingRestored) {
        scanIncoming.resetBaselines?.();
        scanIncoming.restoreTurnBoundaries?.(Object.values(state.reply_guards || {}).map((guard) => ({
          conversation: normalizeText(guard?.conversation),
          turnEpoch: Math.max(0, Math.floor(Number(guard?.turn_epoch) || 0)),
          runtimeId: normalizeText(guard?.incoming_runtime_id)
        })));
        primeRetryNeeded = false;
        if (typeof primeIncoming === "function") {
          let primed;
          try {
            primed = await Promise.resolve(primeIncoming(conversationAliases, contactScope.driverOptions));
          } catch {
            primed = { ok: false, reason: "scan_exception" };
          }
          if (runEpoch !== startEpoch || state.status !== "starting") return { ok: false, error: "自动回复启动已取消", state: publicState() };
          recordScanResult(primed, "prime");
          recordOutgoingObservation(primed, now(), contactScope.resolveContact);
          if (primed?.ok !== true && FATAL_STARTUP_PRIME_REASONS.has(normalizeText(primed?.reason))) {
            throw new Error(state.last_scan_reason || "微信当前会话基线初始化失败");
          }
          if (primed?.ok !== true) {
            // OCR, foreground, viewport and window discovery can flicker at
            // startup. The next regular scan re-primes when no baseline exists.
            if (state.last_scan_reason !== USER_IDLE_WAIT_REASON) {
              state.scan_health = "checking";
              state.consecutive_scan_failures = 0;
            }
            primeRetryNeeded = true;
            appendDiagnostic("prime_deferred", {
              phase: "prime",
              code: state.last_scan_reason || "scan_exception",
              pid: primed?.pid,
              hWnd: primed?.hWnd,
              transitionDetail: primed?.transitionDetail,
              nestedReason: primed?.nestedReason,
              window: primed?.window,
              dpi: primed?.dpi ?? primed?.DPI ?? primed?.windowDpi,
              counts: primed?.counts,
              diagnostics: primed?.diagnostics
            });
          }
        }
      } else {
        primeRetryNeeded = false;
        state.last_event = pendingRestoreDeferred ? "pending_observation_restore_retry" : "pending_observation_restored";
        state.last_error = "";
      }
      if (runEpoch !== startEpoch || state.status !== "starting") return { ok: false, error: "自动回复启动已取消", state: publicState() };
      if (contactScope.strict) {
        const refreshedScope = resolveContactScope();
        if (!refreshedScope.ok || refreshedScope.scopeBinding !== contactScope.scopeBinding) {
          throw new Error(refreshedScope.error || "所选测试联系人资料已变化，请重新选择");
        }
      }
      deepSeekClient?.assertAvailable();
      expertDocuments(expertStore);
      if (!contactScope.strict) recoveredHandoffWarning = recoverKnownUnsentHandoffs();
      if (!contactScope.strict && handoffNeedsConfirmation(state.pending_handoff)) {
        handoffConfirmationRequired = true;
        pauseForFailure("handoff_confirmation_required", "还有发送结果未确认的人工提醒");
        save();
        return { ok: false, error: state.last_error, state: publicState() };
      }
      state.status = "running";
      state.last_event = recoveredHandoffWarning ? "handoff_manual_followup_required" : "started";
      state.last_error = recoveredHandoffWarning;
      setActivity(primeRetryNeeded ? "prime" : "listening", { detailCode: state.last_scan_reason || "started" });
      appendDiagnostic("started", { phase: "prime", code: state.last_scan_reason || "started" });
      save();
      // Let the successful start IPC reach the renderer before the first OCR
      // pass. The Windows visual probe can briefly occupy the main process, so
      // an immediate scan made the page look stuck on “启动中/检查中”.
      queueNext();
      return { ok: true, state: publicState() };
    } catch (error) {
      if (runEpoch === startEpoch && state.status === "starting") {
        clearTestContactScope();
        state.status = "paused";
        state.last_event = "start_failed";
        state.last_error = String(error?.message || error || "自动回复启动失败");
        setActivity("error", { detailCode: state.last_scan_reason || "start_failed" });
        appendDiagnostic("start_failed", { phase: "prime", code: state.last_scan_reason || "start_failed" });
        save();
      }
      return { ok: false, error: String(error?.message || error || "自动回复启动失败"), state: publicState() };
    } finally {
      starting = false;
    }
  }

  function pauseWithError(event, error) {
    clearTestContactScope();
    state.status = "paused";
    state.last_event = event;
    state.last_error = String(error || "自动回复已暂停");
    setActivity("error", { detailCode: event });
  }

  function pauseForFailure(event, error) {
    if (!state.pending_handoff || !handoffConfirmationRequired) return pauseWithError(event, error);
    clearTestContactScope();
    state.status = "paused";
    state.last_event = "handoff_confirmation_required";
    const detail = normalizeText(error);
    const confirmation = handoffInterruptedMessage(state.pending_handoff);
    state.last_error = detail ? `${confirmation}（${detail}）` : confirmation;
    setActivity("error", { detailCode: state.last_event });
  }

  function pauseForSystemError(error, { traceId = "", durationMs } = {}) {
    const failure = sanitizeSystemError(error);
    state.status = "paused";
    state.last_event = "system_error_paused";
    state.last_error = failure.message;
    state.system_error = failure;
    setFailureContext({
      phase: "generate",
      code: failure.code,
      send_attempted: false,
      send_result: "not_attempted",
      recovery_action: "fix_ai_and_restart"
    });
    setActivity("error", {
      traceId,
      deliveryStatus: "not_attempted",
      detailCode: failure.code
    });
    appendDiagnostic("system_error", {
      phase: "generate",
      code: failure.code,
      traceId,
      errorCode: failure.code,
      duration_ms: durationMs,
      send_attempted: false,
      send_result: "not_attempted",
      recovery_action: "fix_ai_and_restart"
    });
  }

  function resumeContact(contactId) {
    const key = normalizeText(contactId);
    if (!key || contactState(key).human_owned !== true) {
      return { ok: false, error: "该客户当前不在人工接管列表", state: publicState() };
    }
    updateContactState(key, { clarify_pending: false, human_owned: false });
    conversationHistories.delete(key);
    pendingUnsentContexts.delete(key);
    if (state.reply_guards) delete state.reply_guards[key];
    for (const [fingerprint, entry] of Object.entries(state.processed || {})) {
      if (normalizeText(entry?.contact_id) !== key || isTerminalProcessed(entry)) continue;
      retryGenerations.delete(fingerprint);
      entry.status = "cancelled_after_handoff";
    }
    for (const item of [...pendingHandoffQueue]) {
      if (normalizeText(item?.metadata?.contact_id) === key) removePendingHandoff(item.metadata.key);
    }
    state.pending_handoffs = (state.pending_handoffs || []).filter((item) => normalizeText(item?.contact_id) !== key);
    state.manual_followups = (state.manual_followups || []).filter((item) => normalizeText(item?.contact_id) !== key);
    syncPendingHandoffHead();
    handoffConfirmationRequired = handoffNeedsConfirmation(state.pending_handoff);
    const contacts = readContacts(activeTouchDir).filter((contact) => normalizeText(contact?.id) === key);
    const aliases = contacts.flatMap((contact) => contactConversationAliases(contact, { includeOpaqueWechatId: true }));
    if (state.pending_observation && aliases.some((alias) => compactConversationAlias(alias) === compactConversationAlias(state.pending_observation?.conversation))) {
      state.pending_observation = null;
    }
    const preserveSystemError = state.status === "paused" && Boolean(state.system_error);
    state.last_event = preserveSystemError ? "system_error_paused" : "contact_ai_resumed";
    if (!preserveSystemError) state.last_error = "";
    save();
    return { ok: true, state: publicState() };
  }

  function saveBestEffort() {
    try {
      save();
    } catch {}
  }

  function requeueCandidate(candidate) {
    try {
      return scanIncoming.requeue?.(candidate) !== false;
    } catch {
      return false;
    }
  }

  // A pause, update or quit before the reply was sent is not an answer. Keep
  // the occurrence non-terminal and its durable in-flight observation, so a
  // resume re-offers it from the driver queue and a restart restores it.
  function deferInterruptedReply(fingerprint, candidate) {
    retryGenerations.delete(fingerprint);
    if (state.processed[fingerprint]) state.processed[fingerprint].status = "retryable";
    requeueCandidate(candidate);
    save();
    return publicState();
  }

  function enqueueHandoff(metadata, payload) {
    if (pendingHandoffQueue.some((item) => item.metadata.key === metadata.key)) return false;
    if (pendingHandoffQueue.length >= MAX_STATE_ENTRIES) throw new Error("人工提醒待发送队列异常，请人工检查");
    const queuedMetadata = { ...metadata, delivery_state: "queued" };
    pendingHandoffQueue.push({ metadata: queuedMetadata, ...payload });
    state.pending_handoffs ||= [];
    if (!state.pending_handoffs.some((item) => pendingHandoffKey(item) === metadata.key)) state.pending_handoffs.push(queuedMetadata);
    syncPendingHandoffHead();
    return true;
  }

  async function deliverPendingHandoff(lock, isCurrentRun) {
    const payload = pendingHandoffQueue[0];
    if (!state.pending_handoff || !payload) return "none";
    const handoffKey = payload.metadata.key;
    if (payload.pollsRemaining > 0) {
      payload.pollsRemaining -= 1;
      state.last_event = "handoff_retry_waiting";
      state.last_error = "人工提醒尚未发出，正在退避后重试";
      save();
      return "deferred";
    }
    coordinator.update(lock.lock.owner, "send-handoff");
    handoffConfirmationRequired = true;
    updateHandoffDeliveryState(payload.metadata.key, "sending");
    save();
    const result = await sendHandoff({
      authorized: true,
      message: payload.message,
      expectedPid: payload.expectedPid,
      sourceWindowHandle: payload.sourceWindowHandle
    });
    if (pendingHandoffQueue[0] !== payload || pendingHandoffKey(state.pending_handoff) !== handoffKey) {
      handoffConfirmationRequired = handoffNeedsConfirmation(state.pending_handoff);
      save();
      return "handled";
    }
    const currentRun = isCurrentRun();
    if (!result?.ok) {
      if (result?.send_attempted === false) {
        if (result?.binding_valid === false) {
          movePendingHandoffToManual(payload.metadata.key);
          handoffConfirmationRequired = false;
          state.last_event = "handoff_manual_followup_required";
          state.last_error = result?.error || manualFollowupMessage(state.manual_followups);
          save();
          return currentRun ? "manual" : "handled";
        }
        updateHandoffDeliveryState(payload.metadata.key, "not_attempted");
        handoffConfirmationRequired = false;
        payload.attempts = Number(payload.attempts || 0) + 1;
        payload.pollsRemaining = retryPolls(payload.attempts);
        if (currentRun) {
          state.last_event = "handoff_retry_pending";
          state.last_error = `人工提醒尚未发出，将自动重试：${normalizeText(result?.error || result?.blocked_reason) || "发送前校验未通过"}`;
        } else if (state.last_event === "handoff_confirmation_required") {
          state.last_event = "paused_by_user";
          state.last_error = "";
        }
        save();
        return currentRun ? "retryable" : "handled";
      } else {
        updateHandoffDeliveryState(handoffKey, "outcome_unknown");
        const unknown = payload.metadata;
        state.handoff_notified ||= {};
        state.handoff_notified[unknown.key] = {
          contact_id: unknown.contact_id,
          at: now().toISOString(),
          status: "outcome_unknown"
        };
        addManualFollowup(unknown);
        removePendingHandoff(unknown.key);
        handoffConfirmationRequired = false;
        state.last_event = "handoff_manual_followup_required";
        state.last_error = manualFollowupMessage(state.manual_followups);
        trimMap(state.handoff_notified);
      }
      save();
      return currentRun && state.status === "running" ? "manual" : "handled";
    }
    const pending = payload.metadata;
    state.handoff_notified ||= {};
    state.handoff_notified[pending.key] = {
      contact_id: pending.contact_id,
      at: pending.at
    };
    removePendingHandoff(pending.key);
    handoffConfirmationRequired = false;
    trimMap(state.handoff_notified);
    if (!currentRun && state.last_event === "handoff_confirmation_required") {
      state.last_event = "paused_by_user";
      state.last_error = "";
    }
    else if (state.pending_handoff) {
      state.last_event = "handoff_pending";
      state.last_error = "";
    }
    else {
      state.last_event = "human_handoff_sent";
      state.last_error = "";
    }
    save();
    return currentRun && state.status === "running" ? "sent" : "handled";
  }

  async function runOnce() {
    if (scanActive || state.status !== "running") return publicState();
    const contactScope = resolveContactScope();
    if (!contactScope.ok) {
      if (singleContactScopeRequired) {
        pauseWithError(contactScope.code || "test_contact_scope_invalid", contactScope.error || "测试联系人范围无法确认");
        appendDiagnostic("test_scope_invalid", { phase: "scope", code: contactScope.code || "test_contact_scope_invalid" });
        saveBestEffort();
      }
      return publicState();
    }
    scanActive = true;
    const activeEpoch = runEpoch;
    const isCurrentRun = () => {
      if (state.status !== "running" || runEpoch !== activeEpoch) return false;
      if (workflowMode && !workflowIsEnabled()) return false;
      if (!contactScope.strict) return true;
      const refreshedScope = resolveContactScope();
      if (refreshedScope.ok && refreshedScope.scopeBinding === contactScope.scopeBinding) return true;
      const scopeCode = refreshedScope.ok ? "workflow_scope_changed" : refreshedScope.code || "test_contact_scope_invalid";
      pauseWithError(scopeCode, refreshedScope.error || "测试联系人范围无法确认");
      appendDiagnostic("test_scope_invalid", { phase: "scope", code: scopeCode });
      saveBestEffort();
      return false;
    };
    let lock;
    try {
      const current = now();
      resetDailyCounter(current);
      lock = coordinator?.acquire({
        state: "replying",
        taskId: `auto-reply-${current.getTime()}`,
        account: "unknown",
        phase: "scan-unread"
      });
      if (!lock?.ok) {
        state.last_event = "wechat_operation_busy";
        state.last_error = "";
        markWechatBusy();
        save();
        return publicState();
      }

      if (!isCurrentRun()) return publicState();
      const handoffDelivery = contactScope.strict ? "none" : await deliverPendingHandoff(lock, isCurrentRun);
      const handoffRetryError = ["retryable", "deferred"].includes(handoffDelivery) ? state.last_error : "";
      if (handoffDelivery === "handled") return publicState();

      const contacts = contactScope.contacts;
      const conversationAliases = contactScope.aliases;
      if (primeRetryNeeded && typeof primeIncoming === "function") {
        setActivity("prime", { detailCode: "baseline_retry" });
        let primed;
        try {
          primed = await Promise.resolve(primeIncoming(conversationAliases, contactScope.driverOptions));
        } catch {
          primed = { ok: false, reason: "scan_exception" };
        }
        if (!isCurrentRun()) return publicState();
        recordScanResult(primed, "prime");
        recordWorkflowScanStats(primed, { prime: true });
        recordOutgoingObservation(primed, current, contactScope.resolveContact);
        if (primed?.ok !== true) {
          if (!workflowMode && state.last_scan_reason !== USER_IDLE_WAIT_REASON) {
            state.scan_health = "checking";
            state.consecutive_scan_failures = 0;
          }
          state.last_event = state.last_scan_reason || "prime_deferred";
          state.last_error = "";
          save();
          return publicState();
        }
        primeRetryNeeded = false;
      }
      let candidate;
      setActivity("scanning", { detailCode: "scan_started" });
      try {
        candidate = await Promise.resolve(scanIncoming(conversationAliases, contactScope.driverOptions));
      } catch (error) {
        if (isCurrentRun()) recordScanResult({ ok: false, reason: "scan_exception" }, "scan");
        throw error;
      }
      if (!isCurrentRun()) {
        // The driver has already moved past this message; hand it back so a
        // resume still answers it.
        if (candidate?.ok === true) requeueCandidate(candidate);
        return publicState();
      }
      recordWorkflowScanStats(candidate);
      if (["visual_ocr_structure_missing", "visual_sidebar_match_missing"].includes(candidate?.reason)
        || String(candidate?.reason || "").startsWith("wechat_chat_")) restoreWorkflowChatSurface = true;
      if (candidate?.scanProbe?.ok !== null) {
        const observation = candidate?.scanProbe
          ? { ...candidate.scanProbe, pid: candidate.pid, hWnd: candidate.hWnd }
          : candidate;
        recordScanResult(observation, "scan");
      }
      if (!candidate?.ok) {
        const candidateReason = normalizeText(candidate?.reason);
        setActivity(candidateReason === "no_unread_message"
          ? "listening"
          : candidateReason === USER_IDLE_WAIT_REASON
            ? "waiting"
            : "scanning", {
          detailCode: candidateReason || state.last_scan_reason || "scan_result_invalid"
        });
        if (contactScope.strict && STRICT_SCOPE_WINDOW_RESET_REASONS.has(candidateReason)) {
          const event = workflowMode ? "workflow_window_changed" : "test_scope_window_changed";
          // Unattended runs only skip this scan; the workflow retries the reply step on its own.
          if (workflowMode) {
            state.last_event = event;
            state.last_error = "微信窗口已变化，稍后自动重试";
            setActivity("error", { detailCode: event });
          } else pauseWithError(event, "检测到微信窗口变化，已暂停测试自动回复，请重新选择测试联系人");
          appendDiagnostic(event, { phase: "scope", code: candidateReason });
          save();
          return publicState();
        }
        if (candidateReason === USER_IDLE_WAIT_REASON) {
          if (normalizeFailureContext(state.last_failure_context)?.phase !== "send") {
            setFailureContext({
              phase: "scan",
              code: candidateReason,
              recovery_action: "wait_for_idle",
              required_idle_ms: candidate?.requiredIdleMs ?? candidate?.required_idle_ms,
              observed_idle_ms: candidate?.observedIdleMs ?? candidate?.observed_idle_ms
            });
          }
          state.last_event = "waiting_for_user_idle";
          state.last_error = "";
          save();
          return publicState();
        }
        if (PENDING_OBSERVATION_REASONS.has(candidateReason)) {
          const retained = retainPendingObservation(candidate, current);
          state.last_event = retained ? "unread_preview_pending" : "unread_preview_unresolved";
          state.last_error = "";
          save();
          return publicState();
        }
        if (candidateReason === "unread_preview_unresolved") {
          state.pending_observation = null;
          state.last_event = candidateReason;
          state.last_error = "";
          save();
          return publicState();
        }
        if (candidateReason === "current_transition_unresolved") {
          // A generic transition failure is only a live send fence. Without a
          // complete preview+bubble identity it cannot be restored strictly
          // after restart, so do not turn it into durable pending state.
          if (state.pending_observation && !advancePendingObservationAttempt(candidate, current)) {
            state.last_event = "unread_preview_unresolved";
          } else {
            state.last_event = state.last_scan_reason || candidateReason;
          }
          state.last_error = "";
          save();
          queueNext(FAST_RECHECK_MS);
          return publicState();
        }
        if (RETRYABLE_CURRENT_SESSION_REASONS.has(candidateReason)) {
          // The visual driver already rechecked both PrintWindow and the live
          // screen for a bound chat. This is incomplete evidence, never proof
          // that the message disappeared, so retain state and recheck quickly.
          state.last_event = state.last_scan_reason || candidateReason;
          state.last_error = "";
          save();
          queueNext(FAST_RECHECK_MS);
          return publicState();
        }
        if (TRANSIENT_SCAN_FENCE_REASONS.has(candidateReason)) {
          // These are incomplete live observations, not proof that the current
          // turn is empty or outgoing. Keep all reply/baseline/retry state
          // untouched and let the next poll re-observe the same WeChat state.
          state.last_event = state.last_scan_reason || candidateReason;
          state.last_error = "";
          save();
          return publicState();
        }
        const terminalPendingReason = TERMINAL_PENDING_OBSERVATION_REASONS.has(candidateReason);
        if (state.pending_observation
          && !contactScope.strict
          && new Set(["wechat_process_changed", "wechat_window_changed"]).has(candidateReason)
          && rebindPendingObservation(candidate, current)) {
          state.last_event = "pending_observation_rebound";
          state.last_error = "";
          save();
          return publicState();
        }
        if (terminalPendingReason && (pendingObservationMatches(candidate)
          || candidateReason === "wechat_process_changed"
          || candidateReason === "wechat_window_changed")) state.pending_observation = null;
        const outgoingObserved = recordOutgoingObservation(candidate, current, contactScope.resolveContact);
        if (handoffDelivery !== "none") {
          save();
          return publicState();
        }
        state.last_event = outgoingObserved ? "reply_guard_outgoing_observed" : state.last_scan_reason || "scan_result_invalid";
        state.last_error = "";
        if (workflowMode && candidateReason === "no_unread_message") resetWorkflowBackoff();
        save();
        return publicState();
      }

      if (contactScope.strict && candidate && typeof candidate === "object") candidate.exactConversationMatch = true;
      const observedTraceId = candidateTraceId(candidate);
      setActivity("candidate", {
        traceId: observedTraceId,
        action: "",
        reasonCode: "",
        deliveryStatus: "not_attempted",
        detailCode: "candidate_detected"
      });
      const conversation = normalizeText(candidate.conversation);
      const contact = contactScope.resolveContact(candidate);
      if (!contact) {
        clearPendingObservation(candidate);
        state.last_event = "conversation_not_eligible";
        state.last_error = "";
        appendDiagnostic("reply_candidate_rejected", {
          phase: "scope",
          code: "conversation_not_eligible",
          traceId: observedTraceId,
          pid: candidate?.pid,
          hWnd: candidate?.hWnd
        });
        setActivity("waiting", {
          traceId: observedTraceId,
          deliveryStatus: "not_attempted",
          detailCode: "conversation_not_eligible"
        });
        save();
        return publicState();
      }
      if (normalizeText(candidate.headerState) === "unresolved") {
        // The chat title could not be read. The conversation came from the list row this scan
        // opened; WeChat's own records must also show this contact's newest message as theirs
        // and recent. Otherwise (or without readable records) the message is left alone.
        let senderConfirmed = false;
        try {
          const rows = /^visual-inbound-/u.test(String(contact.id)) ? null
            : receipts()?.messagesWith(contact.id, Math.floor(now().getTime() / 1000) - UNRESOLVED_TITLE_RECENT_SECONDS);
          const latest = Array.isArray(rows) ? rows.at(-1) : null;
          senderConfirmed = Boolean(latest && latest.sender === contact.id);
        } catch { senderConfirmed = false; }
        appendDiagnostic("reply_title_unresolved", { phase: "scope", code: senderConfirmed ? "sender_confirmed_by_records" : "sender_unconfirmed", traceId: observedTraceId });
        if (!senderConfirmed) {
          clearPendingObservation(candidate);
          state.last_event = "conversation_title_unresolved";
          state.last_error = "";
          setActivity("waiting", { traceId: observedTraceId, deliveryStatus: "not_attempted", detailCode: "conversation_title_unresolved" });
          save();
          return publicState();
        }
      }
      const rawContext = normalizedContext(candidate);
      const incoming = normalizeText(candidate.message);
      const fingerprint = fingerprintFor(contact, candidate);
      const incomingEvidence = incomingEvidenceFor(candidate);
      const processedMetadata = processedEvidenceMetadata(contact, candidate, incomingEvidence);
      if (!rawContext.length || !fingerprint) {
        clearPendingObservation(candidate);
        state.last_event = "ambiguous_message_context";
        state.last_error = "";
        save();
        return publicState();
      }
      const processedEntry = state.processed?.[fingerprint];
      if (isTerminalProcessed(processedEntry)) {
        clearPendingObservation(candidate);
        state.last_event = normalizeText(processedEntry?.status) === "outcome_unknown"
          ? "outcome_unknown_occurrence_skipped"
          : "duplicate_skipped";
        state.last_error = "";
        save();
        return publicState();
      }
      if (contactState(contact.id).human_owned === true) {
        pendingUnsentContexts.delete(contact.id);
        remember(fingerprint, { status: "human_owned_skipped", ...processedMetadata, conversation, at: current.toISOString() });
        clearPendingObservation(candidate);
        state.last_event = "human_owned_contact_skipped";
        state.last_error = "";
        save();
        return publicState();
      }
      // Once a complete v2 occurrence has been accepted, keep only its opaque
      // identity durable until the reply reaches a terminal delivery state.
      // This lets a new process restore the same occurrence if AI generation
      // or the pre-send phase is interrupted, without persisting message text.
      retainPendingObservation(candidate, current, "reply_in_flight");
      if (!isReplyableText(incoming)) {
        remember(fingerprint, { status: "skipped", ...processedMetadata, conversation, at: current.toISOString() });
        clearPendingObservation(candidate);
        state.last_event = "unsupported_or_risky_message";
        state.last_error = "";
        save();
        return publicState();
      }
      const context = mergedConversationContext(contact.id, rawContext, candidate);

      const replyGuard = state.reply_guards?.[contact.id];
      if (replyGuard) {
        if (normalizeText(replyGuard.delivery_status) === "outcome_unknown") {
          const guardRuntimeId = normalizeText(replyGuard.incoming_runtime_id);
          const currentRuntimeId = normalizeText(incomingEvidence.runtimeId);
          const bothTurnBoundVisualOccurrences = incomingEvidence.kind === "visual"
            && /^visual:v2:[a-f0-9]{64}$/u.test(guardRuntimeId)
            && /^visual:v2:[a-f0-9]{64}$/u.test(currentRuntimeId);
          const sameUnknownOccurrence = (
            Boolean(normalizeText(replyGuard.incoming_evidence))
            && normalizeText(replyGuard.incoming_evidence) === incomingEvidence.id
          ) || (
            bothTurnBoundVisualOccurrences
            && guardRuntimeId === currentRuntimeId
          ) || (
            bothTurnBoundVisualOccurrences
            && Boolean(normalizeText(replyGuard.fingerprint))
            && normalizeText(replyGuard.fingerprint) === fingerprint
          );
          if (sameUnknownOccurrence) {
            remember(fingerprint, { status: "skipped", ...processedMetadata, conversation, at: current.toISOString() });
            clearPendingObservation(candidate);
            state.last_event = "outcome_unknown_occurrence_skipped";
            state.last_error = "上一条消息的发送结果无法确认，已禁止对同一条消息自动补发。";
            save();
            return publicState();
          }
        }
        const sameEvidence = normalizeText(replyGuard.incoming_evidence)
          && normalizeText(replyGuard.incoming_evidence) === incomingEvidence.id;
        if (sameEvidence) {
          remember(fingerprint, { status: "skipped", ...processedMetadata, conversation, at: current.toISOString() });
          clearPendingObservation(candidate);
          state.last_event = "duplicate_skipped";
          state.last_error = "";
          save();
          return publicState();
        }
      }

      const traceId = candidateTraceId(candidate, fingerprint);
      const candidateSeenAt = now().getTime();
      if (workflowMode) workflowHandled = true;
      appendDiagnostic("reply_candidate_detected", {
        phase: "candidate",
        code: "candidate_accepted",
        traceId,
        context_turn_count: context.length,
        user_turn_count: context.filter((item) => item.role === "user").length,
        assistant_turn_count: context.filter((item) => item.role === "assistant").length
      });
      const retryEntry = retryGenerations.get(fingerprint);
      if (retryEntry?.pollsRemaining > 0) {
        retryEntry.pollsRemaining -= 1;
        retryGenerations.set(fingerprint, retryEntry);
        remember(fingerprint, { status: "retryable", ...processedMetadata, conversation, at: current.toISOString() });
        if (requeueCandidate(candidate)) {
          state.last_event = "send_retry_waiting";
          const previousFailure = normalizeFailureContext(state.last_failure_context);
          if (previousFailure) {
            setFailureContext({
              ...previousFailure,
              recovery_action: "retry_waiting",
              retry_attempt: retryEntry.attempts,
              retry_polls_remaining: retryEntry.pollsRemaining
            });
          }
          state.last_error = previousFailure?.code === USER_IDLE_WAIT_REASON ? "" : "回复尚未发出，正在退避后重试";
          setActivity(previousFailure?.code === USER_IDLE_WAIT_REASON ? "waiting" : "retrying", {
            traceId,
            action: retryEntry.generated?.action,
            reasonCode: retryEntry.generated?.reasonCode,
            deliveryStatus: "not_attempted",
            detailCode: previousFailure?.code || "send_retry_waiting"
          });
          const previousDiagnosticReason = previousFailure
            ? sendDiagnosticReason(previousFailure.code)
            : { code: "send_retry_waiting", ref: "" };
          appendDiagnostic("reply_retry_waiting", {
            phase: "send",
            code: previousDiagnosticReason.code,
            reasonRef: previousDiagnosticReason.ref,
            traceId,
            action: retryEntry.generated?.action,
            reasonCode: retryEntry.generated?.reasonCode,
            delivery_attempt: Number(retryEntry.attempts || 0) + 1,
            send_attempted: previousFailure?.send_attempted,
            send_result: previousFailure?.send_result,
            draft_phase_started: previousFailure?.draft_phase_started,
            recovery_action: "retry_waiting",
            retry_attempt: retryEntry.attempts,
            retry_polls_remaining: retryEntry.pollsRemaining
          });
        } else {
          const previousFailure = normalizeFailureContext(state.last_failure_context);
          if (previousFailure) setFailureContext({ ...previousFailure, recovery_action: "manual_check_required" });
          pauseWithError("send_retry_queue_paused", "回复尚未发出，但安全重试队列不可用，请人工检查后再启动");
        }
        save();
        return publicState();
      }
      remember(fingerprint, { status: "generating", ...processedMetadata, conversation, at: current.toISOString() });
      state.last_event = "generating_reply";
      state.last_error = "";
      setActivity("generating", {
        traceId,
        deliveryStatus: "not_attempted",
        detailCode: "context_ready"
      });
      save();
      let generated = retryEntry?.generated;
      const clarificationAllowed = contactState(contact.id).clarify_pending !== true;
      let generationStartedAt = null;
      try {
        if (!generated) {
          generationStartedAt = Date.now();
          const expert = expertDocuments(expertStore);
          coordinator.update(lock.lock.owner, "generate-reply");
          appendDiagnostic("reply_generation_started", {
            phase: "generate",
            code: "context_ready",
            traceId,
            context_turn_count: context.length,
            user_turn_count: context.filter((item) => item.role === "user").length,
            assistant_turn_count: context.filter((item) => item.role === "assistant").length
          });
          generated = await deepSeekClient.reply({ context, expert, clarificationAllowed });
        }
        generated = normalizeAutoReplyDecision(generated, { clarificationAllowed });
        if (workflowMode) resetWorkflowBackoff();
        setActivity("decision_ready", {
          traceId,
          action: generated.action,
          reasonCode: generated.reasonCode,
          deliveryStatus: "not_attempted",
          detailCode: "reply_ready"
        });
        if (generationStartedAt !== null) {
          appendDiagnostic("reply_decision", {
            phase: "generate",
            code: "reply_ready",
            traceId,
            action: generated.action,
            reasonCode: generated.reasonCode,
            duration_ms: Date.now() - generationStartedAt
          });
        }
      } catch (error) {
        if (isCurrentRun()) {
          const errorCode = normalizeText(error?.code);
          if (CONTACT_GENERATION_FAILURES.has(errorCode)) {
            state.processed[fingerprint].status = "ai_failed";
            retryGenerations.delete(fingerprint);
            clearPendingObservation(candidate);
            pendingUnsentContexts.delete(contact.id);
            state.system_error = null;
            state.last_event = "reply_generation_skipped";
            state.last_error = "本条消息未生成可用回复，已跳过；自动回复继续处理其他消息。";
            setFailureContext({
              phase: "generate",
              code: errorCode,
              send_attempted: false,
              send_result: "not_attempted",
              recovery_action: "continue_other_contacts"
            });
            setActivity("error", {
              traceId,
              deliveryStatus: "not_attempted",
              detailCode: errorCode
            });
            appendDiagnostic("reply_generation_skipped", {
              phase: "generate",
              code: errorCode,
              traceId,
              duration_ms: generationStartedAt === null ? undefined : Date.now() - generationStartedAt,
              send_attempted: false,
              send_result: "not_attempted",
              recovery_action: "continue_other_contacts"
            });
            saveBestEffort();
            queueNext(FAST_RECHECK_MS);
            return publicState();
          }
          state.processed[fingerprint].status = "generating";
          const failure = sanitizeSystemError(error);
          if (workflowMode && ["network", "timeout", "rate_limit"].includes(failure.category)) {
            if (typeof scanIncoming.requeue === "function" && requeueCandidate(candidate)) {
              state.processed[fingerprint].status = "retryable";
              state.system_error = failure;
              enterWorkflowBackoff(failure.code);
              saveBestEffort();
              return publicState();
            }
            pauseWithError("send_retry_queue_paused", "回复尚未发出，但安全重试队列不可用，请人工检查后再启动");
            saveBestEffort();
            return publicState();
          }
          pauseForSystemError(error, {
            traceId,
            durationMs: generationStartedAt === null ? undefined : Date.now() - generationStartedAt
          });
          saveBestEffort();
        }
        return publicState();
      }
      if (!isCurrentRun()) return deferInterruptedReply(fingerprint, candidate);
      Object.assign(state.processed[fingerprint], {
        action: generated.action,
        reason_code: generated.reasonCode
      });
      const reply = normalizeText(generated?.reply);
      if (generated.action === "silent") {
        setActivity("silent", {
          traceId,
          action: generated.action,
          reasonCode: generated.reasonCode,
          deliveryStatus: "not_attempted",
          detailCode: "no_reply_needed"
        });
        appendDiagnostic("reply_send_skipped", {
          phase: "send",
          code: "no_reply_needed",
          traceId,
          action: generated.action,
          reasonCode: generated.reasonCode,
          send_attempted: false,
          send_result: "not_attempted"
        });
        retryGenerations.delete(fingerprint);
        pendingUnsentContexts.delete(contact.id);
        state.processed[fingerprint].status = "silent";
        if (generated.reasonCode === "no_reply_needed") updateContactState(contact.id, { clarify_pending: false });
        clearPendingObservation(candidate);
        state.last_event = "silent_processed";
        state.last_error = "";
        state.last_failure_context = null;
        state.system_error = null;
        save();
        return publicState();
      }
      // Generation is complete but no operation capable of sending has begun.
      // Persist that distinction so a crash here can regenerate/retry the same
      // occurrence. For visual sends, stay known-unsent until the sender
      // confirms the draft was actually written; merely launching its worker
      // must not turn a pre-click failure into an unknown delivery.
      state.processed[fingerprint].status = "ready_to_send";
      save();

      let incomingStillCurrent = true;
      let draftPhaseStarted = false;
      const isVisualCandidate = normalizeText(candidate.visualMode) === "visual_render_v1";
      const verifyCurrent = async () => {
        if (!isCurrentRun()) {
          incomingStillCurrent = false;
          return false;
        }
        const verification = await Promise.resolve(verifyIncoming(candidate, contactScope.driverOptions));
        incomingStillCurrent = verification?.ok === true;
        return incomingStillCurrent;
      };
      const beforeDraft = async () => {
        if (!isVisualCandidate) state.processed[fingerprint].status = "sending";
        setActivity("preparing_send", {
          traceId,
          action: generated.action,
          reasonCode: generated.reasonCode,
          deliveryStatus: "not_attempted",
          detailCode: isVisualCandidate ? "visual_preflight" : "verify_incoming"
        });
        save();
        draftPhaseStarted = true;
        // Visual OCR geometry can drift while AI is generating. The visual
        // sender rechecks the target conversation, exact draft, foreground
        // window and owned send button immediately before the click.
        return isVisualCandidate ? isCurrentRun() : verifyCurrent();
      };
      const shouldContinue = () => {
        if (!isCurrentRun()) {
          incomingStillCurrent = false;
          return false;
        }
        // The visual sender already re-checks the bound conversation, exact draft,
        // send button, foreground ownership and cursor immediately before clicking.
        // Re-running the pixel/line-bound incoming verifier after the draft is typed
        // is invalid because the expanded input area can legitimately reflow the chat.
        return draftPhaseStarted && !isVisualCandidate ? verifyCurrent() : true;
      };
      coordinator.update(lock.lock.owner, "send-reply");
      const deliveryAttempt = Math.min(100, Math.max(1, Number(retryEntry?.attempts || 0) + 1));
      const sendStartedAt = Date.now();
      setActivity("sending", {
        traceId,
        action: generated.action,
        reasonCode: generated.reasonCode,
        deliveryStatus: "not_attempted",
        detailCode: isVisualCandidate ? "visual_send_started" : "send_started"
      });
      appendDiagnostic("reply_send_started", {
        phase: "send",
        code: isVisualCandidate ? "visual_send_started" : "send_started",
        traceId,
        action: generated.action,
        reasonCode: generated.reasonCode,
        delivery_attempt: deliveryAttempt,
        outcome: "not_attempted",
        side_effect: "none",
        retryability: "safe_retry",
        failure_stage: "send",
        pid: candidate.pid,
        hWnd: candidate.hWnd
      });
      const result = await send({
        baseDir: dataDir,
        contactsDir: activeTouchDir,
        authorized: true,
        windowMinIdleMs: 0,
        contactId: contact.id,
        frozenContact: contact,
        message: reply,
        attemptId: fingerprint,
        expectedIncomingMessage: candidate.message,
        expectedIncomingRuntimeId: candidate.runtimeId,
        expectedIncomingMessageSignature: candidate.messageSignature,
        visualMode: String(candidate.visualMode || ""),
        expectedPid: candidate.pid,
        expectedHWnd: candidate.hWnd,
        expectedConversation: candidate.conversation,
        expectedConversationEvidence: candidate.conversationEvidence || candidate.conversation,
        expectedConversationAliases: conversationAliases,
        exactConversationMatch: contactScope.strict,
        senderConfirmedByRecords: ["unresolved", "database_unread_sender"].includes(normalizeText(candidate.headerState)),
        incomingConfirmedByRecords: incomingStillLatestInRecords(contact, candidateSeenAt),
        recordedEarlierOutgoing: outgoingBeforeLatestIncoming(contact, candidateSeenAt),
        messageDriven: candidate.messageDriven === true,
        beforeSend: () => {
          if (!isCurrentRun()) return false;
          if (isVisualCandidate) {
            // This durable guard must succeed before the final click worker starts.
            state.processed[fingerprint].status = "sending";
            save();
          }
          return true;
        },
        onTransition: (transition) => {
          const delivery = diagnosticCode(transition, "");
          const phase = ({
            prepared: "prepared",
            clicked: "clicked",
            sent_verified: "sent_verified",
            outcome_unknown: "error"
          })[delivery] || "sending";
          setActivity(phase, {
            traceId,
            action: generated.action,
            reasonCode: generated.reasonCode,
            deliveryStatus: AUTO_REPLY_DELIVERY_STATES.has(delivery) ? delivery : "not_attempted",
            detailCode: delivery || "sending"
          });
        },
        beforeDraft,
        shouldContinue,
        runStep: (command, args) => runStep(command, args, lock.lock.owner)
      });
      const screenOutcomeUnknown = normalizeText(result?.send_result) === "outcome_unknown"
        || result?.outcomeUnknown === true;
      const screenVerified = result?.ok === true && !screenOutcomeUnknown;
      // A reply the screen could not confirm is settled by WeChat's message records: on record
      // for this contact since the send began means it was sent.
      let databaseReceipt = null;
      if (!screenVerified && (screenOutcomeUnknown || result?.send_attempted !== false) && !/^visual-inbound-/u.test(String(contact.id))) {
        try {
          const confirmed = receipts()?.confirmSent(contact.id, Math.floor(sendStartedAt / 1000) - 5, { kind: "text", text: reply });
          databaseReceipt = typeof confirmed === "boolean" ? confirmed : null;
        } catch { databaseReceipt = null; }
      }
      const explicitOutcomeUnknown = screenOutcomeUnknown && databaseReceipt !== true;
      const sendVerified = screenVerified || databaseReceipt === true;
      const sendTimings = result?.send_diagnostics?.timings || {};
      const sendWorker = result?.send_diagnostics?.worker;
      const sendReceipt = normalizeReceiptDiagnostics({ receipt: result?.send_diagnostics?.receipt });
      const sendEnvelope = summarizeSendResult(result, { stage: "send" });
      const sendDiagnostic = explicitOutcomeUnknown
        ? { code: "outcome_unknown", ref: "" }
        : sendVerified
          ? { code: "sent_verified", ref: "" }
          : sendDiagnosticReason(result?.blocked_reason);
      setActivity(sendVerified ? "sent_verified" : explicitOutcomeUnknown ? "error" : "sending", {
        traceId,
        action: generated.action,
        reasonCode: generated.reasonCode,
        deliveryStatus: sendVerified ? "sent_verified" : explicitOutcomeUnknown ? "outcome_unknown" : result?.send_result || "not_attempted",
        detailCode: sendDiagnostic.code
      });
      appendDiagnostic("reply_send_finished", {
        phase: "send",
        code: sendDiagnostic.code,
        reasonRef: sendDiagnostic.ref,
        traceId,
        action: generated.action,
        reasonCode: generated.reasonCode,
        delivery_attempt: deliveryAttempt,
        duration_ms: Date.now() - sendStartedAt,
        send_phase: result?.send_diagnostics?.phase || "",
        verification_mode: result?.verification_mode || "",
        send_attempted: result?.send_attempted,
        send_result: result?.send_result,
        database_receipt: String(databaseReceipt),
        ...(!sendVerified ? { local_raw: result } : {}),
        input_read_reason: sendEnvelope.input_read_reason,
        outcome: sendEnvelope.outcome,
        side_effect: sendEnvelope.side_effect,
        retryability: sendEnvelope.retryability,
        failure_stage: sendEnvelope.failure_stage,
        draft_phase_started: draftPhaseStarted,
        composer_touched: result?.composer_touched,
        draft_stage: result?.draft_stage,
        incoming_change_kind: result?.incoming_change_kind,
        preflight_ms: sendTimings.preflight_ms,
        draft_ms: sendTimings.draft_ms,
        before_send_ms: sendTimings.before_send_ms,
        send_ms: sendTimings.send_ms,
        total_ms: sendTimings.total_ms,
        required_idle_ms: result?.send_diagnostics?.required_idle_ms,
        observed_idle_ms: result?.send_diagnostics?.observed_idle_ms,
        worker: sendWorker,
        receipt_ocr_text: result?.send_diagnostics?.receipt_evidence?.observed_text || "",
        receipt_match_mode: result?.send_diagnostics?.receipt_evidence?.match_mode || "",
        receipt_edit_distance: result?.send_diagnostics?.receipt_evidence?.edit_distance,
        receipt_maximum_length: result?.send_diagnostics?.receipt_evidence?.maximum_length,
        ...sendReceipt,
        pid: result?.pid || candidate.pid,
        hWnd: result?.hWnd || candidate.hWnd
      });

      if (!isCurrentRun() && result?.blocked_reason === "batch_cancelled" && result?.send_attempted === false) {
        return deferInterruptedReply(fingerprint, candidate);
      }
      if (!isCurrentRun() && result?.blocked_reason === "batch_cancelled") {
        retryGenerations.delete(fingerprint);
        state.processed[fingerprint].status = "cancelled";
        clearPendingObservation(candidate);
        save();
        return publicState();
      }
      if (!isCurrentRun()) {
        retryGenerations.delete(fingerprint);
        if (sendVerified) {
          const staleSentAt = now();
          resetDailyCounter(staleSentAt);
          state.processed[fingerprint].status = "sent_verified";
          state.reply_count += 1;
          rememberConversation(contact.id, context, reply);
          applyTerminalDecisionState(contact.id, generated.action);
          const turnEpoch = noteVisualSendAttempt(candidate, result);
          recordReplyGuard(contact, candidate, fingerprint, incomingEvidence, staleSentAt, "sent_verified", turnEpoch);
          clearPendingObservation(candidate);
          if (workflowMode) {
            state.status = "paused";
            state.last_event = "workflow_paused";
            state.last_error = "";
            setActivity("paused", { deliveryStatus: "sent_verified", detailCode: "workflow_paused" });
          } else {
            pauseWithError("stale_run_send_paused", "旧运行轮次在暂停后仍完成了发送，请人工检查");
          }
        } else if (result?.send_attempted !== false || explicitOutcomeUnknown) {
          state.processed[fingerprint].status = "outcome_unknown";
          pendingUnsentContexts.delete(contact.id);
          applyTerminalDecisionState(contact.id, generated.action);
          const turnEpoch = noteVisualSendAttempt(candidate, result, true);
          recordReplyGuard(contact, candidate, fingerprint, incomingEvidence, now(), "outcome_unknown", turnEpoch);
          clearPendingObservation(candidate);
          setFailureContext({
            phase: "send",
            code: normalizeText(result?.blocked_reason || result?.error) || "send_outcome_unknown",
            send_phase: result?.send_diagnostics?.phase,
            send_attempted: result?.send_attempted,
            send_result: result?.send_result,
            draft_phase_started: draftPhaseStarted,
            recovery_action: "manual_check_required",
            ...sendReceipt
          });
          if (workflowMode) {
            state.status = "paused";
            state.last_event = "workflow_paused";
            state.last_error = "";
            setActivity("paused", { deliveryStatus: "outcome_unknown", detailCode: "workflow_paused" });
          } else pauseWithError("send_outcome_unknown_paused", result?.blocked_reason || result?.error || "自动回复发送结果无法确认");
        } else if (MANUAL_REVIEW_SEND_REASONS.has(normalizeText(result?.blocked_reason || result?.error))) {
          // Someone may be typing a manual reply; as on the current-run path,
          // never answer that conversation automatically.
          state.processed[fingerprint].status = "cancelled";
          clearPendingObservation(candidate);
        } else {
          return deferInterruptedReply(fingerprint, candidate);
        }
        save();
        return publicState();
      }
      if (!explicitOutcomeUnknown && (!incomingStillCurrent || new Set(["incoming_message_changed", "visual_send_incoming_changed"]).has(normalizeText(result?.blocked_reason)))) {
        retryGenerations.delete(fingerprint);
        if (result?.send_attempted === false
          && result?.composer_touched === false
          && normalizeText(result?.incoming_change_kind) === "proven_different") {
          retainSupersededContext(contact.id, context, candidate);
        }
        state.processed[fingerprint].status = "cancelled";
        clearPendingObservation(candidate);
        state.last_failure_context = null;
        state.last_event = "manual_reply_or_message_changed";
        state.last_error = "";
        save();
        return publicState();
      }
      if (!sendVerified) {
        if (result?.send_attempted === false && !explicitOutcomeUnknown) {
          const sendCode = normalizeText(result?.blocked_reason || result?.error) || "send_failed";
          const sendDiagnostics = result?.send_diagnostics || {};
          // `beforeDraft` only means the controller handed control to the
          // sender; it does not prove a paste or click happened. A no-click
          // failure remains retryable unless the sender explicitly observed
          // somebody typing in the WeChat composer. Treating an absent
          // composer_touched flag as manual input was the source of lost
          // replies when the PowerShell worker failed before doing anything.
          const requiresManualReview = MANUAL_REVIEW_SEND_REASONS.has(sendCode);
          if (requiresManualReview) {
            retryGenerations.delete(fingerprint);
            pendingUnsentContexts.delete(contact.id);
            state.processed[fingerprint].status = "cancelled";
            clearPendingObservation(candidate);
            if (generated.action === "handoff") {
              applyTerminalDecisionState(contact.id, generated.action);
              const metadata = handoffMetadata({ contactId: contact.id, context: rawContext, conversation, at: now() });
              if (!state.handoff_notified?.[metadata.key]) addManualFollowup(metadata);
              state.last_event = "handoff_manual_followup_required";
              state.last_error = manualFollowupMessage(state.manual_followups);
            } else {
              state.last_event = "manual_intervention_required";
              state.last_error = sendCode === "visual_send_before_send_failed"
                ? "回复尚未发送；发送前状态保存失败，请人工核对微信输入框中的草稿"
                : "";
            }
            setFailureContext({
              phase: "send",
              code: sendCode,
              send_phase: sendDiagnostics.phase,
              send_attempted: false,
              send_result: result?.send_result,
              draft_phase_started: draftPhaseStarted,
              composer_touched: result?.composer_touched,
              draft_stage: result?.draft_stage,
              incoming_change_kind: result?.incoming_change_kind,
              recovery_action: "manual_review_required",
              required_idle_ms: sendDiagnostics.required_idle_ms,
              observed_idle_ms: sendDiagnostics.observed_idle_ms,
              preflight_ms: sendDiagnostics.timings?.preflight_ms
            });
            appendDiagnostic("reply_manual_review_required", {
              phase: "send",
              code: sendDiagnostic.code,
              reasonRef: sendDiagnostic.ref,
              traceId,
              action: generated.action,
              reasonCode: generated.reasonCode,
              delivery_attempt: deliveryAttempt,
              send_phase: sendDiagnostics.phase,
              send_attempted: false,
              send_result: result?.send_result,
              draft_phase_started: draftPhaseStarted,
              composer_touched: result?.composer_touched,
              draft_stage: result?.draft_stage,
              incoming_change_kind: result?.incoming_change_kind,
              recovery_action: "manual_review_required",
              required_idle_ms: sendDiagnostics.required_idle_ms,
              observed_idle_ms: sendDiagnostics.observed_idle_ms,
              worker: sendWorker
            });
            setActivity("manual_review", {
              traceId,
              action: generated.action,
              reasonCode: generated.reasonCode,
              deliveryStatus: "not_attempted",
              detailCode: sendDiagnostic.code
            });
          } else {
            const attempts = Number(retryEntry?.attempts || 0) + 1;
            retryGenerations.set(fingerprint, { generated, attempts, pollsRemaining: retryPolls(attempts) });
            if (retryGenerations.size > MAX_STATE_ENTRIES) retryGenerations.delete(retryGenerations.keys().next().value);
            state.processed[fingerprint].status = "retryable";
            const retryQueued = requeueCandidate(candidate);
            if (retryQueued) {
              state.last_event = "send_retry_pending";
              const waitingForUserIdle = sendCode === USER_IDLE_WAIT_REASON;
              if (waitingForUserIdle) {
                state.scan_health = "waiting";
                state.last_scan_reason = USER_IDLE_WAIT_REASON;
                state.consecutive_scan_failures = 0;
              }
              setFailureContext({
                phase: "send",
                code: sendCode,
                send_phase: sendDiagnostics.phase,
                send_attempted: false,
                send_result: result?.send_result,
                draft_phase_started: draftPhaseStarted,
                composer_touched: result?.composer_touched,
                draft_stage: result?.draft_stage,
                incoming_change_kind: result?.incoming_change_kind,
                recovery_action: waitingForUserIdle ? "wait_for_idle_and_retry" : "retry_pending",
                retry_attempt: attempts,
                retry_polls_remaining: retryPolls(attempts),
                required_idle_ms: sendDiagnostics.required_idle_ms,
                observed_idle_ms: sendDiagnostics.observed_idle_ms,
                preflight_ms: sendDiagnostics.timings?.preflight_ms
              });
              state.last_error = waitingForUserIdle ? "" : "本次回复尚未发出，正在重新校验微信输入框后重试";
              setActivity(waitingForUserIdle ? "waiting" : "retrying", {
                traceId,
                action: generated.action,
                reasonCode: generated.reasonCode,
                deliveryStatus: "not_attempted",
                detailCode: sendDiagnostic.code
              });
              appendDiagnostic("reply_retry_enqueued", {
                phase: "send",
                code: sendDiagnostic.code,
                reasonRef: sendDiagnostic.ref,
                traceId,
                action: generated.action,
                reasonCode: generated.reasonCode,
                delivery_attempt: deliveryAttempt,
                send_phase: sendDiagnostics.phase,
                send_attempted: false,
                send_result: result?.send_result,
                draft_phase_started: draftPhaseStarted,
                composer_touched: result?.composer_touched,
                draft_stage: result?.draft_stage,
                incoming_change_kind: result?.incoming_change_kind,
                recovery_action: waitingForUserIdle ? "wait_for_idle_and_retry" : "retry_pending",
                retry_attempt: attempts,
                retry_polls_remaining: retryPolls(attempts),
                required_idle_ms: sendDiagnostics.required_idle_ms,
                observed_idle_ms: sendDiagnostics.observed_idle_ms,
                preflight_ms: sendDiagnostics.timings?.preflight_ms,
                worker: sendWorker,
                pid: result?.pid || candidate.pid,
                hWnd: result?.hWnd || candidate.hWnd
              });
            } else {
              setFailureContext({
                phase: "send",
                code: sendCode,
                send_phase: sendDiagnostics.phase,
                send_attempted: false,
                send_result: result?.send_result,
                draft_phase_started: draftPhaseStarted,
                draft_stage: result?.draft_stage,
                recovery_action: "manual_check_required",
                required_idle_ms: sendDiagnostics.required_idle_ms,
                observed_idle_ms: sendDiagnostics.observed_idle_ms,
                preflight_ms: sendDiagnostics.timings?.preflight_ms
              });
              setActivity("error", {
                traceId,
                action: generated.action,
                reasonCode: generated.reasonCode,
                deliveryStatus: "not_attempted",
                detailCode: sendDiagnostic.code
              });
              pauseWithError("send_retry_queue_paused", "回复尚未发出，但安全重试队列不可用，请人工检查后再启动");
            }
          }
        } else {
          retryGenerations.delete(fingerprint);
          state.processed[fingerprint].status = "outcome_unknown";
          pendingUnsentContexts.delete(contact.id);
          applyTerminalDecisionState(contact.id, generated.action);
          const turnEpoch = noteVisualSendAttempt(candidate, result, true);
          recordReplyGuard(contact, candidate, fingerprint, incomingEvidence, now(), "outcome_unknown", turnEpoch);
          clearPendingObservation(candidate);
          setFailureContext({
            phase: "send",
            code: normalizeText(result?.blocked_reason || result?.error) || "send_outcome_unknown",
            send_phase: result?.send_diagnostics?.phase,
            send_attempted: result?.send_attempted,
            send_result: result?.send_result,
            draft_phase_started: draftPhaseStarted,
            recovery_action: "manual_check_required",
            required_idle_ms: result?.send_diagnostics?.required_idle_ms,
            observed_idle_ms: result?.send_diagnostics?.observed_idle_ms,
            preflight_ms: result?.send_diagnostics?.timings?.preflight_ms,
            ...sendReceipt
          });
          if (workflowMode) {
            state.last_event = "send_outcome_unknown_assumed_sent";
            state.last_error = "";
            appendDiagnostic("reply_outcome_assumed_sent", { phase: "send", code: normalizeText(result?.blocked_reason || result?.error) || "send_outcome_unknown",
              traceId, database_receipt: String(databaseReceipt), needs_internal_review: true });
          } else pauseWithError("send_outcome_unknown_paused", result?.blocked_reason || result?.error || "自动回复发送结果无法确认");
        }
        save();
        return publicState();
      }

      const sentAt = now();
      retryGenerations.delete(fingerprint);
      resetDailyCounter(sentAt);
      state.processed[fingerprint].status = "sent_verified";
      state.reply_count += 1;
      rememberConversation(contact.id, context, reply);
      applyTerminalDecisionState(contact.id, generated.action);
      const turnEpoch = noteVisualSendAttempt(candidate, result);
      recordReplyGuard(contact, candidate, fingerprint, incomingEvidence, sentAt, "sent_verified", turnEpoch);
      clearPendingObservation(candidate);
      state.last_event = "reply_sent_verified";
      state.last_error = "";
      state.last_failure_context = null;
      state.system_error = null;
      setActivity("sent_verified", {
        traceId,
        action: generated.action,
        reasonCode: generated.reasonCode,
        deliveryStatus: "sent_verified",
        detailCode: generated.action === "handoff" ? "handoff_reply_sent" : "sent_verified"
      });
      let handoffCreated = false;
      if (generated.action === "handoff") {
        const reason = handoffReasonLabel(generated.reasonCode);
        const metadata = handoffMetadata({ contactId: contact.id, context: rawContext, conversation, at: sentAt });
        const handoffKey = metadata.key;
        if (!state.handoff_notified?.[handoffKey] && !state.manual_followups?.some((item) => pendingHandoffKey(item) === handoffKey)) {
          if (contactScope.strict) {
            addManualFollowup(metadata);
            state.last_event = "handoff_manual_followup_required";
            state.last_error = manualFollowupMessage(state.manual_followups);
          } else {
            handoffCreated = enqueueHandoff(metadata, {
              message: buildHandoffMessage({ conversation, reason, latest: incoming, at: sentAt }),
              expectedPid: candidate.pid,
              sourceWindowHandle: candidate.hWnd,
              attempts: 0,
              pollsRemaining: 0
            });
            if (handoffCreated) state.last_event = "handoff_pending";
          }
        }
      }
      save();
      if (!handoffCreated) {
        if (["retryable", "deferred"].includes(handoffDelivery) && state.pending_handoff) {
          state.last_event = handoffDelivery === "retryable" ? "handoff_retry_pending" : "handoff_retry_waiting";
          state.last_error = handoffRetryError;
          save();
          return publicState();
        }
        return publicState();
      }
      if (!isCurrentRun()) return publicState();
      if (handoffDelivery !== "none") return publicState();
      await deliverPendingHandoff(lock, isCurrentRun);
      return publicState();
    } catch (error) {
      if (isCurrentRun()) {
        pauseForFailure("auto_reply_error_paused", error?.message || error || "自动回复失败");
        saveBestEffort();
      }
      return publicState();
    } finally {
      try {
        if (lock?.ok) coordinator.release(lock.lock.owner);
      } catch (error) {
        pauseForFailure("runtime_lock_release_failed_paused", error?.message || error || "微信运行锁释放失败");
        saveBestEffort();
      } finally {
        scanActive = false;
      }
    }
  }

  async function pauseWorkflow(reason = "workflow_paused") {
    workflowIsEnabled = () => false;
    pause(reason);
    workflowStartPending = true;
    await waitForScanIdle();
    while (starting) await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true, state: publicState() };
  }

  function resumeWorkflow() {
    // Finite work owns WeChat immediately; do not leave the standalone reply
    // timer running until the first reply step after the queue drains.
    if (!workflowMode) pause("workflow_takeover");
    workflowStartPending = true;
    resetWorkflowBackoff();
    appendDiagnostic("workflow_resume_requested", { phase: "control", code: "workflow_resume_requested" });
    workflowDiagnosticCache.clear();
    return { ok: true };
  }

  async function runWorkflowStep(input = {}) {
    const enabled = typeof input.isEnabled === "function" ? input.isEnabled : () => false;
    let scopeMetrics = {};
    const stepReturn = (result, reasonCode, diagnosticCode = reasonCode) => {
      appendDiagnostic("workflow_step_return", { phase: "workflow", code: diagnosticCode, ...scopeMetrics });
      return { ...result, reasonCode, ...scopeMetrics };
    };
    if (workflowStepActive) return stepReturn({ handled: false, status: "busy" }, "workflow_step_busy");
    if (!enabled()) return stepReturn({ handled: false, status: "paused" }, "workflow_paused");
    workflowStepActive = true;
    workflowProgress = typeof input.onProgress === "function" ? input.onProgress : null;
    try {
      if (!workflowMode) {
        // Stop the legacy polling loop before the workflow becomes its sole
        // caller. Wait for any in-flight send to finish verification.
        pause("workflow_takeover");
        workflowMode = true;
        const pauseGeneration = workflowPauseGeneration;
        await waitForScanIdle();
        while (starting) await new Promise((resolve) => setTimeout(resolve, 10));
        const pausedDuringTakeover = workflowPauseGeneration !== pauseGeneration || !enabled();
        const interruptedReply = normalizeText(state.pending_observation?.reason) === "reply_in_flight" ? state.pending_observation : null;
        discardTestScopeRuntimeState();
        scanIncoming.restoreTurnBoundaries?.(Object.values(state.reply_guards || {}).map((guard) => ({
          conversation: normalizeText(guard?.conversation),
          turnEpoch: Math.max(0, Math.floor(Number(guard?.turn_epoch) || 0)),
          runtimeId: normalizeText(guard?.incoming_runtime_id)
        })));
        primeRetryNeeded = true;
        // A reply interrupted before it was sent (pause, update, quit) is
        // restored like the standalone start does; priming would discard it.
        if (interruptedReply && typeof scanIncoming.restorePendingObservation === "function") {
          let restored = false;
          try { restored = scanIncoming.restorePendingObservation(interruptedReply) === true; } catch {}
          if (restored) {
            state.pending_observation = interruptedReply;
            primeRetryNeeded = false;
          }
        }
        restoreWorkflowChatSurface = true;
        if (pausedDuringTakeover) {
          return stepReturn({ handled: false, status: "paused", progressText: "自动回复已暂停，请检查后重新启动" }, "paused_by_user");
        }
        workflowStartPending = true;
      }
      if (input.afterMoments === true) restoreWorkflowChatSurface = true;
      if (timer) cancelSchedule(timer);
      timer = null;
      if (workflowMode && state.status === "paused" && state.last_event === "paused_by_user" && !workflowStartPending) {
        return stepReturn({ handled: false, status: "paused", progressText: "自动回复已暂停，请检查后重新启动" }, "paused_by_user");
      }
      workflowIsEnabled = () => enabled() === true;
      workflowRecipients = Array.isArray(input.recipients)
        ? input.recipients.map((contact) => ({ ...contact }))
        : [];
      if (!workflowRecipients.length) return stepReturn({ handled: false, status: "waiting" }, "workflow_recipients_empty");
      if (workflowBackoff.until > now().getTime()) return stepReturn(backoffResult(), workflowBackoff.reasonCode);
      if (workflowBackoff.until) workflowBackoff.until = 0;
      const scopeStarted = Date.now();
      const scope = resolveContactScope();
      scopeMetrics = { eligible_count: scope.contacts?.length || 0, alias_count: scope.aliases?.length || 0,
        alias_json_length: JSON.stringify(scope.aliases || []).length, excluded_count: scope.excluded?.length || 0,
        scope_ms: Date.now() - scopeStarted, excludedReasons: scope.excludedReasons || {} };
      if (scope.excluded?.length) appendDiagnostic("workflow_scope_excluded", { phase: "scope", code: "workflow_scope_excluded", ...scopeMetrics });
      if (!scope.ok) {
        return stepReturn({ handled: false, status: "needs_attention", error: scope.error }, scope.code, `scope_invalid:${scope.code}`);
      }
      const accountName = normalizeText(input.accountName);
      if (accountName && scope.contacts.some((contact) => normalizeText(contact.wechatAccountId) !== accountName)) {
        return stepReturn({ handled: false, status: "needs_attention", error: "接待名单与当前微信账号不一致，请重新同步" }, "workflow_account_changed");
      }
      if (!enabled()) return stepReturn({ handled: false, status: "paused" }, "workflow_paused");
      if (state.status === "paused" && state.last_event !== "paused_by_user" && !workflowStartPending) {
        // Unattended: a failure pause is not a stop. The workflow already spaced this call out
        // (30 s, 2 min, 5 min), so start again instead of reporting the same pause forever.
        appendDiagnostic("workflow_auto_restart", { phase: "workflow", code: diagnosticCode(state.system_error?.code || state.last_event, "paused") });
        workflowStartPending = true;
      }
      if (state.last_event === "workflow_chat_navigation_failed") {
        workflowStartPending = true;
        primeRetryNeeded = true;
        state.consecutive_scan_failures = 0;
      }
      if (workflowStartPending) {
        deepSeekClient?.assertAvailable();
        expertDocuments(expertStore);
        if (typeof send !== "function" || typeof runStep !== "function") throw new Error("当前版本未连接自动回复执行器");
        runEpoch += 1;
        state.status = "running";
        state.last_event = "workflow_started";
        state.last_error = "";
        state.system_error = null;
        workflowStartPending = false;
        scanTraceId = crypto.randomUUID();
        appendDiagnostic("start_requested", { phase: "prime", code: "workflow_started" });
        setActivity(primeRetryNeeded ? "prime" : "scanning", { contactLabel: `${scope.contacts.length} 位接待联系人`, detailCode: "workflow_started" });
        save();
      }
      if (state.status !== "running") {
        if (!workflowStartPending) appendDiagnostic("workflow_step_return", { phase: "workflow", code: "start_pending_missing", ...scopeMetrics });
        return stepReturn({ handled: false, status: "needs_attention", error: state.last_error || "自动回复已暂停，请检查后重新启动" }, state.system_error?.code || state.last_event || "auto_reply_error_paused");
      }
      workflowHandled = false;
      await runOnce();
      if (state.consecutive_scan_failures >= 3 && state.last_scan_reason.startsWith("wechat_chat_")) {
        state.consecutive_scan_failures = 0;
        primeRetryNeeded = true;
        enterWorkflowBackoff("workflow_chat_navigation_failed");
      }
      if (workflowBackoff.until > now().getTime()) return stepReturn(backoffResult(), workflowBackoff.reasonCode);
      if (state.status === "paused") return stepReturn({ handled: workflowHandled, status: "needs_attention", error: state.last_error || "自动回复需要处理" }, state.system_error?.code || state.last_event || "auto_reply_error_paused");
      return {
        handled: workflowHandled,
        ...scopeMetrics,
        ...(primeRetryNeeded ? {
          progressText: "消息读取尚未初始化完成，正在等待重试"
        } : state.consecutive_scan_failures > 0 ? {
          progressText: state.last_scan_reason.startsWith("wechat_chat_")
            ? `返回聊天失败，尚未读取消息（${state.consecutive_scan_failures}/3）`
            : "本次读取消息失败，尚未回复"
        } : {}),
        status: !enabled() ? "paused" : "running",
        ...(!enabled() ? { reasonCode: "workflow_paused" } : {})
      };
    } catch (error) {
      return stepReturn({ handled: false, status: "needs_attention", error: String(error?.message || "自动回复启动失败") }, normalizeAiWarningCode(error?.code) || "auto_reply_start_failed");
    } finally {
      workflowStepActive = false;
      workflowProgress = null;
    }
  }

  function prepareWorkflowRecipients(contactIds) {
    if (!Array.isArray(contactIds) || !contactIds.length || contactIds.length > 1000) throw new Error("请选择要接待的联系人。");
    const universe = testContactUniverse(activeTouchDir);
    const ids = [...new Set(contactIds.map((id) => String(id).trim()))];
    const selected = ids.map((id) => universe.find((contact) => normalizeText(contact.id) === id));
    if (selected.some((contact) => !contact)) throw new Error("所选联系人已变化，请重新同步后选择。");
    const scope = resolveWorkflowContactScope(activeTouchDir, selected);
    if (scope.excluded?.length) {
      const blocked = scope.excluded[0];
      const label = testContactLabel(selected.find((contact) => normalizeText(contact.id) === blocked.id));
      throw new Error(blocked.code === "workflow_recipient_ambiguous"
        ? `接待联系人“${label}”的会话名称与其他联系人重复，请在微信中设置不同备注、重新同步后再选择`
        : `接待联系人“${label}”的资料已变化，请重新同步后再选择`);
    }
    if (!scope.ok) throw new Error(scope.error);
    return scope.contacts.map((contact) => ({ ...contact }));
  }
  function screenWorkflowRecipients(contacts) {
    try {
      const scope = resolveWorkflowContactScope(activeTouchDir, Array.isArray(contacts) ? contacts : []);
      return { accepted: scope.ok ? scope.contacts : [], excluded: scope.code === "workflow_account_changed"
        ? [...(scope.excluded || []), ...scope.contacts.map((contact) => ({ id: normalizeText(contact.id), code: "workflow_account_changed" }))]
        : scope.excluded || [] };
    } catch {
      return { accepted: [], excluded: (Array.isArray(contacts) ? contacts : []).map((contact) => ({ id: normalizeText(contact?.id), code: "workflow_recipient_changed" })) };
    }
  }
  return { acknowledgeManualFollowup, pause, pauseWorkflow, prepareWorkflowRecipients, screenWorkflowRecipients, resumeContact, resumeWorkflow, runOnce, runWorkflowStep, start, status };
}

function registerAutoReplyIpc(options = {}) {
  const ipcMain = options.ipcMain || require("electron").ipcMain;
  const getMainWindow = options.getMainWindow;
  const BrowserWindow = options.BrowserWindow;
  const displayScreen = options.screen;
  const preloadPath = String(options.preloadPath || "");
  const rendererPath = String(options.rendererPath || "");
  let floatingWindow = null;
  let closingFloatingWindow = false;

  function sendState(target, state) {
    if (!target || target.isDestroyed?.()) return;
    try {
      target.webContents?.send?.("auto-reply:update", { ok: true, state });
    } catch {
      // A renderer can reload between state transitions; polling remains the fallback.
    }
  }

  function showMainWindow() {
    const mainWindow = getMainWindow?.();
    if (!mainWindow || mainWindow.isDestroyed?.()) return;
    try {
      mainWindow.show?.();
      mainWindow.focus?.();
    } catch {}
  }

  function createFloatingWindow() {
    if (floatingWindow && !floatingWindow.isDestroyed?.()) {
      if (typeof floatingWindow.showInactive === "function") floatingWindow.showInactive();
      else floatingWindow.show?.();
      return floatingWindow;
    }
    if (typeof BrowserWindow !== "function" || !preloadPath || !rendererPath) return null;
    floatingWindow = new BrowserWindow({
      width: FLOATING_PROGRESS_WINDOW.width,
      height: FLOATING_PROGRESS_WINDOW.height,
      show: false,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      title: "自动回复进度",
      backgroundColor: "#ffffff",
      webPreferences: {
        preload: preloadPath,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    floatingWindow.setMenu?.(null);
    const workArea = displayScreen?.getPrimaryDisplay?.()?.workArea;
    if (workArea) {
      const position = floatingProgressPosition(workArea);
      floatingWindow.setPosition?.(position.x, position.y);
    }
    floatingWindow.on?.("close", (event) => {
      if (closingFloatingWindow) return;
      // The progress surface is only a view of a running task. Closing it must
      // not turn an ordinary return to the main page into a listener pause.
      event?.preventDefault?.();
      hideFloatingWindow();
      showMainWindow();
    });
    floatingWindow.on?.("closed", () => {
      floatingWindow = null;
      closingFloatingWindow = false;
    });
    const target = floatingWindow;
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    try {
      const loadResult = devUrl && typeof target.loadURL === "function"
        ? target.loadURL(`${devUrl}${devUrl.includes("?") ? "&" : "?"}floating=auto-reply`)
        : target.loadFile?.(rendererPath, { query: { floating: "auto-reply" } });
      Promise.resolve(loadResult).catch((error) => recoverFromFloatingLoadFailure(target, {
        errorCode: error?.errno || error?.code || "load_promise_rejected",
        errorDescription: error?.message || "悬浮窗页面加载 Promise 被拒绝",
        validatedURL: devUrl || rendererPath
      }));
    } catch {
      recoverFromFloatingLoadFailure(target, {
        errorCode: "load_call_threw",
        errorDescription: "悬浮窗页面加载调用失败",
        validatedURL: devUrl || rendererPath
      });
      return null;
    }
    return target;
  }

  function closeFloatingWindow() {
    if (!floatingWindow || floatingWindow.isDestroyed?.()) return;
    closingFloatingWindow = true;
    try {
      floatingWindow.close?.();
    } catch {
      closingFloatingWindow = false;
    }
  }

  function hideFloatingWindow() {
    if (!floatingWindow || floatingWindow.isDestroyed?.()) return;
    try {
      floatingWindow.hide?.();
    } catch {}
  }

  function recoverFromFloatingLoadFailure(target, details = {}) {
    if (floatingWindow !== target || target?.isDestroyed?.()) return;
    diagnostics().event("auto_reply", "progress_window_load_failed", {
      error_code: diagnosticCode(details.errorCode, "load_failed"),
      error_description: normalizeText(details.errorDescription).slice(0, 200),
      validated_url: normalizeText(details.validatedURL).slice(0, 200)
    }, {
      level: "error",
      code: "progress_window_load_failed",
      phase: "control"
    });
    closeFloatingWindow();
    showMainWindow();
  }

  const controller = createAutoReplyController({
    ...options,
    onStateChange: (state) => {
      try {
        options.onStateChange?.(state);
      } catch {}
      const mainWindow = getMainWindow?.();
      sendState(mainWindow, state);
      sendState(floatingWindow, state);
    }
  });

  function consumeTrustedClick(event, payload) {
    const token = String(payload?.clickToken || "");
    const mainWindow = getMainWindow?.();
    if (!token || consumedClickTokens.has(token) || !mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || !mainWindow.isFocused()) return false;
    consumedClickTokens.add(token);
    if (consumedClickTokens.size > 200) consumedClickTokens.delete(consumedClickTokens.values().next().value);
    return true;
  }

  ipcMain.handle("auto-reply:status", () => ({ ok: true, state: controller.status() }));
  ipcMain.handle("auto-reply:start", async (event, payload = {}) => {
    if (!consumeTrustedClick(event, payload)) {
      return { ok: false, error: "请在主窗口中手动点击启动自动回复" };
    }
    const started = controller.start({ contactId: String(payload?.contactId || "") });
    if (controller.status().status === "starting") {
      const progressWindow = createFloatingWindow();
      if (progressWindow && !progressWindow.isDestroyed?.()) {
        sendState(progressWindow, controller.status());
        const mainWindow = getMainWindow?.();
        if (mainWindow && !mainWindow.isDestroyed?.()) mainWindow.hide?.();
        if (typeof progressWindow.showInactive === "function") progressWindow.showInactive();
        else progressWindow.show?.();
      }
    }
    return started;
  });
  ipcMain.handle("auto-reply:acknowledge-manual-followup", (event, payload = {}) => {
    if (!consumeTrustedClick(event, payload)) return { ok: false, error: "请在主窗口中手动确认人工提醒已处理" };
    return controller.acknowledgeManualFollowup();
  });
  ipcMain.handle("auto-reply:resume-contact", (event, payload = {}) => {
    if (!consumeTrustedClick(event, payload)) return { ok: false, error: "请在主窗口中手动恢复该客户的 AI 回复" };
    return controller.resumeContact(String(payload?.contactId || ""));
  });
  ipcMain.handle("auto-reply:pause", () => controller.pause());
  ipcMain.handle("auto-reply:show-main", () => {
    hideFloatingWindow();
    showMainWindow();
    return { ok: true, state: controller.status() };
  });
  return controller;
}

module.exports = {
  buildHandoffMessage,
  createAutoReplyController,
  exceedsRateLimit,
  isReplyableText,
  isSafeReplyText,
  registerAutoReplyIpc
};
