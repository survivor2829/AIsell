// Split out of auto-reply-ipc.cjs (2026-11-13), unchanged. See auto-reply-ipc.cjs for the controller.
const crypto = require("node:crypto");
const { normalizeReceiptDiagnostics } = require("./diagnostics.cjs");
const fs = require("node:fs");
const { AUTO_REPLY_STATE_VERSION, MAX_STATE_ENTRIES, RECOVERY_ACTIONS, SCAN_HEALTH_VALUES, PENDING_OBSERVATION_REASONS, PENDING_OBSERVATION_MAX_AGE_MS, IN_FLIGHT_OBSERVATION_MAX_AGE_MS } = require("./auto-reply-constants.cjs");
const { normalizeText } = require("./auto-reply-text.cjs");
const { diagnosticCode, scanReason } = require("./auto-reply-diagnostics.cjs");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function dayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function handoffInterruptedMessage(pending) {
  const conversation = normalizeText(pending?.conversation);
  return `上次人工提醒发送结果未确认${conversation ? `（客户：${conversation}）` : ""}，请在文件传输助手人工检查，确认后点击确认按钮继续`;
}

function handoffDeliveryState(value) {
  return ["queued", "not_attempted", "sending", "outcome_unknown", "manual_required"].includes(value)
    ? value
    : "outcome_unknown";
}

function handoffNeedsConfirmation(pending) {
  return Boolean(pending) && ["sending", "outcome_unknown"].includes(handoffDeliveryState(pending.delivery_state));
}

function manualFollowupMessage(items) {
  const pending = Array.isArray(items) ? items : [];
  if (!pending.length) return "";
  const conversation = normalizeText(pending[0]?.conversation);
  return `有 ${pending.length} 条人工提醒尚未补发${conversation ? `，当前客户：${conversation}` : ""}。请人工处理后确认当前这一条`;
}

function pendingHandoffKey(pending) {
  const key = normalizeText(pending?.key);
  if (key) return key;
  return crypto.createHash("sha256")
    .update([pending?.contact_id, pending?.conversation, pending?.at].map((value) => normalizeText(value)).join("\n"))
    .digest("hex");
}

function normalizePendingObservation(value, current = new Date()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reason = normalizeText(value.reason);
  if (!PENDING_OBSERVATION_REASONS.has(reason)) return null;
  const conversation = normalizeText(value.conversation).slice(0, 200);
  const pid = Math.max(0, Math.floor(Number(value.pid) || 0));
  const rawHWnd = normalizeText(value.hWnd);
  const hWnd = /^[1-9][0-9]{0,19}$/u.test(rawHWnd) ? rawHWnd : "";
  const signature = (field) => {
    const normalized = normalizeText(value[field]).toLowerCase();
    return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : "";
  };
  const runtimeId = normalizeText(value.runtime_id);
  const visualEvidenceRuntimeId = normalizeText(value.visual_evidence_runtime_id);
  const attempts = Math.max(1, Math.floor(Number(value.attempts) || 1));
  const rebindAttempts = Math.max(0, Math.floor(Number(value.rebind_attempts) || 0));
  const firstSeenAt = normalizeText(value.first_seen_at).slice(0, 100);
  const firstSeenMs = new Date(firstSeenAt).getTime();
  const currentMs = current instanceof Date ? current.getTime() : new Date(current).getTime();
  if (!conversation || !pid || !hWnd || !signature("message_signature")) return null;
  if (rebindAttempts > 1) return null;
  const maxAgeMs = reason === "reply_in_flight"
    ? IN_FLIGHT_OBSERVATION_MAX_AGE_MS
    : PENDING_OBSERVATION_MAX_AGE_MS;
  if (!Number.isFinite(firstSeenMs) || !Number.isFinite(currentMs)
    || currentMs - firstSeenMs > maxAgeMs) return null;
  return {
    key: crypto.createHash("sha256").update([
      conversation,
      pid,
      hWnd,
      visualEvidenceRuntimeId,
      signature("preview_signature"),
      signature("message_signature")
    ].join("\n")).digest("hex"),
    reason,
    conversation,
    pid,
    hWnd,
    runtime_id: /^visual:v[12]:[a-f0-9]{64}$/u.test(runtimeId) ? runtimeId : "",
    visual_evidence_runtime_id: /^visual:v1:[a-f0-9]{64}$/u.test(visualEvidenceRuntimeId) ? visualEvidenceRuntimeId : "",
    preview_signature: signature("preview_signature"),
    message_signature: signature("message_signature"),
    predecessor_preview_signature: signature("predecessor_preview_signature"),
    predecessor_message_signature: signature("predecessor_message_signature"),
    attempts,
    rebind_attempts: rebindAttempts,
    first_seen_at: firstSeenAt,
    last_seen_at: normalizeText(value.last_seen_at).slice(0, 100)
  };
}

function normalizeFailureContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const phase = diagnosticCode(value.phase, "");
  const code = diagnosticCode(value.code, "");
  if (!phase || !code) return null;
  const result = { phase, code };
  const sendPhase = diagnosticCode(value.send_phase, "");
  if (sendPhase) result.send_phase = sendPhase;
  if (typeof value.send_attempted === "boolean") result.send_attempted = value.send_attempted;
  if (typeof value.draft_phase_started === "boolean") result.draft_phase_started = value.draft_phase_started;
  if (typeof value.composer_touched === "boolean") result.composer_touched = value.composer_touched;
  const draftStage = diagnosticCode(value.draft_stage, "");
  if (draftStage) result.draft_stage = draftStage;
  const incomingChangeKind = diagnosticCode(value.incoming_change_kind, "");
  if (new Set(["ocr_unresolved", "proven_different"]).has(incomingChangeKind)) result.incoming_change_kind = incomingChangeKind;
  const sendResult = diagnosticCode(value.send_result, "");
  if (new Set(["not_attempted", "sent_verified", "outcome_unknown"]).has(sendResult)) result.send_result = sendResult;
  const recoveryAction = diagnosticCode(value.recovery_action, "");
  if (RECOVERY_ACTIONS.has(recoveryAction)) result.recovery_action = recoveryAction;
  for (const [field, maximum] of Object.entries({
    retry_attempt: 100,
    retry_polls_remaining: 100,
    required_idle_ms: 60_000,
    observed_idle_ms: 86_400_000,
    preflight_ms: 300_000
  })) {
    const numeric = Math.floor(Number(value[field]));
    if (Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= maximum) result[field] = numeric;
  }
  Object.assign(result, normalizeReceiptDiagnostics(value));
  return result;
}

function createDefaultState() {
  return {
    version: AUTO_REPLY_STATE_VERSION,
    status: "stopped",
    reply_count: 0,
    daily_date: "",
    processed: {},
    reply_guards: {},
    contact_states: {},
    handoff_notified: {},
    manual_followups: [],
    pending_handoff: null,
    pending_handoffs: [],
    pending_observation: null,
    last_event: "",
    last_error: "",
    system_error: null,
    last_failure_context: null,
    scan_health: "unknown",
    last_scan_at: "",
    last_scan_success_at: "",
    last_scan_reason: "",
    consecutive_scan_failures: 0,
    updated_at: ""
  };
}

function recoverInterruptedProcessedSends(processed) {
  const entries = processed && typeof processed === "object" && !Array.isArray(processed) ? processed : {};
  let recovered = false;
  const recoveredDecisions = [];
  const result = Object.fromEntries(Object.entries(entries).map(([key, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || normalizeText(value.status) !== "sending") {
      return [key, value];
    }
    recovered = true;
    const contactId = normalizeText(value.contact_id);
    const action = normalizeText(value.action);
    if (contactId) {
      recoveredDecisions.push({
        fingerprint: key,
        contactId,
        // Older v4 state did not persist the decision. Keep that contact under
        // manual control until the operator checks the unknown send outcome.
        action: ["clarify", "handoff"].includes(action) ? action : "unknown",
        conversation: normalizeText(value.conversation).slice(0, 200),
        at: normalizeText(value.at)
      });
    }
    return [key, { ...value, status: "outcome_unknown" }];
  }));
  return { processed: result, recovered, recoveredDecisions };
}

function normalizeReplyGuard(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const contactId = normalizeText(value.contact_id);
  if (!contactId) return null;
  const deliveryStatus = ["sent_verified", "outcome_unknown"].includes(normalizeText(value.delivery_status || value.status))
    ? normalizeText(value.delivery_status || value.status)
    : "sent_verified";
  const turnState = normalizeText(value.turn_state);
  return {
    contact_id: contactId,
    conversation: normalizeText(value.conversation).slice(0, 200),
    incoming_evidence: normalizeText(value.incoming_evidence).slice(0, 200),
    evidence_kind: ["visual", "uia"].includes(normalizeText(value.evidence_kind)) ? normalizeText(value.evidence_kind) : "unknown",
    incoming_runtime_id: normalizeText(value.incoming_runtime_id).slice(0, 200),
    visual_evidence_runtime_id: normalizeText(value.visual_evidence_runtime_id).slice(0, 200),
    message_signature: normalizeText(value.message_signature).slice(0, 200),
    fingerprint: normalizeText(value.fingerprint).slice(0, 200),
    delivery_status: deliveryStatus,
    // A verified delivery is itself a trusted outgoing turn boundary. Older
    // builds persisted `awaiting_outgoing_observation` before this rule existed;
    // normalize those guards so a non-current contact is not blocked forever.
    turn_state: deliveryStatus === "sent_verified" ? "outgoing_observed" : "awaiting_outgoing_observation",
    outgoing_observation: normalizeText(value.outgoing_observation).slice(0, 200),
    outgoing_observed_at: normalizeText(value.outgoing_observed_at).slice(0, 100),
    turn_epoch: Math.max(0, Math.floor(Number(value.turn_epoch) || 0)),
    at: normalizeText(value.at).slice(0, 100)
  };
}

function recoverReplyGuards(rawGuards, processed) {
  const guards = {};
  const source = rawGuards && typeof rawGuards === "object" && !Array.isArray(rawGuards) ? rawGuards : {};
  for (const value of Object.values(source).slice(-MAX_STATE_ENTRIES)) {
    const guard = normalizeReplyGuard(value);
    if (guard) guards[guard.contact_id] = guard;
  }
  for (const [fingerprint, value] of Object.entries(processed || {})) {
    const deliveryStatus = normalizeText(value?.status);
    if (!["sent_verified", "outcome_unknown"].includes(deliveryStatus)) continue;
    const hasOccurrenceEvidence = Boolean(
      normalizeText(value?.incoming_evidence)
      || normalizeText(value?.incoming_runtime_id)
      || normalizeText(value?.visual_evidence_runtime_id)
      || normalizeText(value?.message_signature)
    );
    if (deliveryStatus === "sent_verified" && !hasOccurrenceEvidence) continue;
    const recovered = normalizeReplyGuard({ ...value, fingerprint });
    if (!recovered) continue;
    const existingAt = new Date(guards[recovered.contact_id]?.at || 0).getTime();
    const recoveredAt = new Date(recovered.at || 0).getTime();
    if (!guards[recovered.contact_id] || !Number.isFinite(existingAt) || Number.isFinite(recoveredAt) && recoveredAt > existingAt) {
      guards[recovered.contact_id] = recovered;
    }
  }
  return guards;
}

function migrateState(raw, current) {
  if (!raw || Object.keys(raw).length === 0) return createDefaultState();
  if (raw.version === 2 || raw.version === 3 || raw.version === AUTO_REPLY_STATE_VERSION) {
    const upgrading = raw.version !== AUTO_REPLY_STATE_VERSION;
    const next = { ...createDefaultState(), ...raw };
    next.version = AUTO_REPLY_STATE_VERSION;
    delete next.rate_events;
    delete next.last_ai_warning_code;
    delete next.last_ai_warning;
    const processedRecovery = recoverInterruptedProcessedSends(raw.processed);
    next.processed = processedRecovery.processed;
    next.reply_guards = recoverReplyGuards(raw.reply_guards, next.processed);
    const rawContactStates = raw.contact_states && typeof raw.contact_states === "object" && !Array.isArray(raw.contact_states)
      ? raw.contact_states
      : {};
    next.contact_states = Object.fromEntries(Object.entries(rawContactStates)
      .slice(-MAX_STATE_ENTRIES)
      .map(([contactId, value]) => [normalizeText(contactId), {
        clarify_pending: value?.clarify_pending === true,
        human_owned: value?.human_owned === true
      }])
      .filter(([contactId, value]) => contactId && (value.clarify_pending || value.human_owned)));
    for (const { contactId, action } of processedRecovery.recoveredDecisions) {
      const previous = next.contact_states[contactId] || { clarify_pending: false, human_owned: false };
      next.contact_states[contactId] = ["handoff", "unknown"].includes(action)
        ? { clarify_pending: false, human_owned: true }
        : { ...previous, clarify_pending: true };
    }
    next.contact_states = Object.fromEntries(Object.entries(next.contact_states).slice(-MAX_STATE_ENTRIES));
    next.handoff_notified = raw.handoff_notified && typeof raw.handoff_notified === "object" ? raw.handoff_notified : {};
    next.manual_followups = Array.isArray(raw.manual_followups)
      ? raw.manual_followups
        .filter((item) => item && typeof item === "object")
        .slice(0, MAX_STATE_ENTRIES)
        .map((item) => ({ ...item, key: pendingHandoffKey(item), delivery_state: "manual_required" }))
      : [];
    for (const recovered of processedRecovery.recoveredDecisions.filter((item) => ["handoff", "unknown"].includes(item.action))) {
      const metadata = {
        key: crypto.createHash("sha256").update(`recovered-${recovered.action}\n${recovered.fingerprint}`).digest("hex"),
        contact_id: recovered.contactId,
        conversation: recovered.conversation,
        at: recovered.at || current.toISOString(),
        delivery_state: "manual_required"
      };
      if (!next.handoff_notified[metadata.key]
        && !next.manual_followups.some((item) => pendingHandoffKey(item) === metadata.key)) {
        next.manual_followups.push(metadata);
      }
    }
    next.manual_followups = next.manual_followups.slice(-MAX_STATE_ENTRIES);
    const pendingHandoffs = Array.isArray(raw.pending_handoffs) && raw.pending_handoffs.length
      ? raw.pending_handoffs
      : raw.pending_handoff && typeof raw.pending_handoff === "object" ? [raw.pending_handoff] : [];
    next.pending_handoffs = pendingHandoffs
      .filter((pending) => pending && typeof pending === "object")
      .slice(0, MAX_STATE_ENTRIES)
      .map((pending) => ({
        ...pending,
        key: pendingHandoffKey(pending),
        delivery_state: handoffDeliveryState(pending.delivery_state)
      }));
    next.pending_handoff = next.pending_handoffs[0] || null;
    for (const handoff of [...next.manual_followups, ...next.pending_handoffs]) {
      const contactId = normalizeText(handoff?.contact_id);
      if (contactId) next.contact_states[contactId] = { clarify_pending: false, human_owned: true };
    }
    if (upgrading) {
      // OCR observations and rate fuses are build-specific runtime data. They
      // must not make a newly unpacked portable build inherit an old blockage.
      // Keep the exactly-once ledger and unknown send outcomes only.
      next.reply_guards = Object.fromEntries(Object.entries(next.reply_guards)
        .filter(([, guard]) => normalizeText(guard?.delivery_status) === "outcome_unknown"));
      next.pending_observation = null;
      next.last_scan_at = "";
      next.last_scan_success_at = "";
      next.last_scan_reason = "";
      next.consecutive_scan_failures = 0;
    } else {
      next.pending_observation = normalizePendingObservation(raw.pending_observation, current);
      // `sending` is conservatively recovered as outcome_unknown above. That is
      // already a terminal delivery classification, so its recovery identity
      // must not linger or be handed back to the observer as known-unsent work.
      if (processedRecovery.recovered) next.pending_observation = null;
    }
    next.scan_health = upgrading ? "unknown" : SCAN_HEALTH_VALUES.has(raw.scan_health) ? raw.scan_health : "unknown";
    next.last_scan_at = upgrading ? "" : normalizeText(raw.last_scan_at);
    next.last_scan_success_at = upgrading ? "" : normalizeText(raw.last_scan_success_at);
    next.last_scan_reason = upgrading ? "" : normalizeText(raw.last_scan_reason) ? scanReason(raw.last_scan_reason).code : "";
    const persistedSystemError = Boolean(raw.system_error && typeof raw.system_error === "object" && !Array.isArray(raw.system_error));
    // AI generation/configuration failures are current-process UI state. The
    // durable diagnostic log keeps the history; send outcomes are recovered
    // separately below and must remain fenced across restarts.
    next.system_error = null;
    next.last_failure_context = upgrading ? null : normalizeFailureContext(raw.last_failure_context);
    if (persistedSystemError && next.last_failure_context?.phase !== "send") next.last_failure_context = null;
    if (persistedSystemError) {
      next.last_error = "";
      if (next.last_event === "system_error_paused") next.last_event = "recovered_after_restart";
    }
    next.consecutive_scan_failures = upgrading ? 0 : Math.max(0, Math.floor(Number(raw.consecutive_scan_failures) || 0));
    if (handoffNeedsConfirmation(next.pending_handoff)) {
      next.status = "paused";
      next.last_event = "handoff_confirmation_required";
      next.last_error = handoffInterruptedMessage(next.pending_handoff);
    } else if (processedRecovery.recovered) {
      next.status = "paused";
      next.last_event = "send_outcome_unknown_paused";
      next.last_error = "上次自动回复在发送过程中中断，发送结果无法确认；请先在微信中检查是否已经发出，再重新启动自动回复。";
    } else if (next.status === "running" || next.status === "starting") {
      next.status = "paused";
      next.last_event = "recovered_after_restart";
    }
    if (next.daily_date !== dayKey(current)) {
      next.daily_date = dayKey(current);
      next.reply_count = 0;
    }
    return next;
  }
  return {
    ...createDefaultState(),
    status: "paused",
    reply_count: raw.daily_date === dayKey(current) ? Math.max(0, Number(raw.reply_count) || 0) : 0,
    daily_date: raw.daily_date === dayKey(current) ? raw.daily_date : dayKey(current),
    last_event: "state_upgraded_paused"
  };
}

module.exports = {
  readJson,
  dayKey,
  handoffInterruptedMessage,
  handoffDeliveryState,
  handoffNeedsConfirmation,
  manualFollowupMessage,
  pendingHandoffKey,
  normalizePendingObservation,
  normalizeFailureContext,
  createDefaultState,
  recoverInterruptedProcessedSends,
  normalizeReplyGuard,
  recoverReplyGuards,
  migrateState
};
