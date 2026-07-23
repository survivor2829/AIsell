const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readContacts } = require("../../rpa/active_touch/state_machine.cjs");

const POLL_INTERVAL_MS = 5_000;
const AUTO_REPLY_STATE_VERSION = 3;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const GLOBAL_RATE_LIMIT = 30;
const MAX_STATE_ENTRIES = 1_000;
const SCAN_DEGRADED_AFTER = 3;
const DIAGNOSTIC_LOG_MAX_BYTES = 512 * 1024;
const DIAGNOSTIC_LOG_MAX_LINES = 500;
const SCAN_HEALTH_VALUES = new Set(["unknown", "checking", "healthy", "warning", "degraded", "waiting"]);
const HEALTHY_SCAN_REASONS = new Set([
  "no_unread_message",
  "current_session_baselined",
  "current_outgoing_settling",
  "current_visual_drift_consumed",
  "latest_message_not_incoming",
  "unread_contact_unresolved"
]);
const TRANSIENT_SCAN_FENCE_REASONS = new Set([
  "chat_boundary_unresolved",
  "latest_message_role_unresolved",
  "wechat_focus_failed"
]);
const PENDING_OBSERVATION_REASONS = new Set([
  "unread_preview_pending",
  "reply_in_flight"
]);
const PENDING_OBSERVATION_MAX_ATTEMPTS = 3;
const PENDING_OBSERVATION_MAX_AGE_MS = 2 * 60 * 1000;
const IN_FLIGHT_OBSERVATION_MAX_AGE_MS = 30 * 60 * 1000;
const FATAL_STARTUP_PRIME_REASONS = new Set([
  "incoming_identity_missing",
  "powershell_output_invalid",
  "scan_result_invalid",
  "session_probe_unsupported",
  "whitelist_empty",
  "whitelist_name_ambiguous"
]);
const TERMINAL_PENDING_OBSERVATION_REASONS = new Set([
  "conversation_title_changed",
  "conversation_title_mismatch",
  "incoming_message_changed",
  "latest_message_not_incoming",
  "wechat_process_changed",
  "wechat_window_changed"
]);
const KNOWN_SCAN_REASONS = new Set([
  ...HEALTHY_SCAN_REASONS,
  "automation_root_missing",
  "baseline_ready",
  "baseline_epoch_changed",
  "candidate_detected",
  "chat_boundary_unresolved",
  "conversation_open_failed",
  "conversation_title_changed",
  "conversation_title_mismatch",
  "current_conversation_ambiguous",
  "current_conversation_changed",
  "current_outgoing_settling",
  "current_sidebar_row_unresolved",
  "current_transition_unresolved",
  "current_visual_drift_consumed",
  "history_avatar_ambiguous",
  "history_changed_during_scan",
  "history_empty",
  "history_item_invalid",
  "history_not_at_bottom",
  "history_overlap_ambiguous",
  "history_overlap_mismatch",
  "history_overlap_missing",
  "history_restore_failed",
  "history_screenshot_failed",
  "history_scroll_failed",
  "history_viewport_invalid",
  "history_viewport_missing",
  "history_window_not_foreground",
  "history_window_obscured",
  "incoming_identity_missing",
  "incoming_message_changed",
  "incoming_message_missing",
  "latest_message_role_unresolved",
  "latest_text_message_missing",
  "moments_render_pane_ambiguous",
  "moments_render_pane_not_found",
  "moments_visual_ocr_failed",
  "moments_visual_ocr_region_invalid",
  "moments_visual_ocr_unavailable",
  "no_current_conversation",
  "unread_contact_unresolved",
  "personal_wechat_main_window_not_found",
  "powershell_failed",
  "powershell_output_invalid",
  "powershell_timeout",
  "scan_exception",
  "scan_result_invalid",
  "session_probe_unsupported",
  "unknown_scan_reason",
  "unread_preview_mismatch",
  "unread_preview_pending",
  "unread_preview_unresolved",
  "unread_preview_missing",
  "visual_candidate_ambiguous",
  "visual_capture_failed",
  "visual_driver_missing",
  "visual_ocr_failed",
  "visual_ocr_structure_missing",
  "visual_render_pane_mismatch",
  "visual_sidebar_match_ambiguous",
  "visual_sidebar_match_missing",
  "wechat_operation_busy",
  "wechat_focus_failed",
  "wechat_process_changed",
  "wechat_window_ambiguous",
  "wechat_window_changed",
  "wechat_window_missing",
  "wechat_window_not_foreground",
  "wechat_window_not_ready",
  "wechat_window_obscured",
  "whitelist_empty",
  "whitelist_invalid",
  "whitelist_name_ambiguous",
  "conversation_title_unresolved"
]);
const consumedClickTokens = new Set();
const SYSTEM_IDS = new Set([
  "filehelper",
  "fmessage",
  "floatbottle",
  "medianote",
  "newsapp",
  "notifymessage",
  "weixin"
]);
const SYSTEM_NAMES = new Set([
  "文件传输助手",
  "微信团队",
  "服务通知",
  "订阅号消息"
]);

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function containsSensitiveSecret(text) {
  return /验证码(?:是|为|[:：]|\s)*[0-9０-９]{4,8}/u.test(text)
    || /密码(?:是|为|[:：]|\s)+[^\s，。！？,!?]{4,32}/u.test(text)
    || /密码(?=[^\s，。！？,!?]{4,32}(?=$|[\s，。！？,!?]))(?=[^\s，。！？,!?]*[A-Za-z0-9])[^\s，。！？,!?]{4,32}/u.test(text)
    || /(?:银行卡|卡号)(?:号)?(?:是|为|[:：]|\s)*[0-9０-９][0-9０-９\s-]{11,24}/u.test(text)
    || /身份证(?:号)?(?:是|为|[:：]|\s)*[0-9０-９][0-9０-９XxＸｘ\s-]{13,20}/u.test(text);
}

function requestsSensitiveSecret(text, strict = false) {
  return text.split(/[，,。；;！？!?]/u).some((clause) => {
    if (/(?:不要|无需|不必|切勿|请勿)(?:您|向任何人)?(?:发|发送|提供|告诉|填写|输入|提交|上传).{0,12}(?:验证码|密码|银行卡|身份证)/u.test(clause)
      || /(?:不要|无需|不必|切勿|请勿)(?:把|将)?(?:验证码|密码|银行卡|身份证).{0,8}(?:发|发送|提供|告诉|填写|输入|提交|上传)/u.test(clause)) return false;
    if (strict) {
      return /(?:发|发送|提供|告诉|填写|输入|提交|上传).{0,12}(?:验证码|密码|银行卡|身份证)|(?:验证码|密码|银行卡|身份证).{0,12}(?:发|发送|提供|告诉|填写|输入|提交|上传)/u.test(clause);
    }
    return /(?:请|麻烦|需要).{0,16}(?:验证码|密码|银行卡|身份证).{0,12}(?:发|提供|告诉|填写|输入)/u.test(clause)
      || /(?:请|麻烦|需要).{0,12}(?:发|提供|告诉|填写|输入).{0,12}(?:验证码|密码|银行卡|身份证)/u.test(clause);
  });
}

function isReplyableText(value) {
  const text = normalizeText(value);
  if (!text || text.length > 500) return false;
  if (/^\[(图片|语音|文件|视频|表情|位置|小程序|链接|红包|转账)\]$/u.test(text)) return false;
  if (/(撤回了一条消息|以上是打招呼的内容|你已添加了|系统消息)/u.test(text)) return false;
  if (containsSensitiveSecret(text) || requestsSensitiveSecret(text)) return false;
  return true;
}

function requestsPayment(text) {
  return text.split(/[，,。；;！？!?]/u).some((clause) =>
    /(?:请|请您|需要您|您可以|可以|先|直接|立即|马上|务必|建议您).{0,12}(?:支付|转账|汇款|打款|付(?:款|定金|订金))|(?:支付|转账|汇款|打款).{0,8}(?:到|至|给|进|以下|账户|收款码|链接)|(?:扫码|点击).{0,8}(?:支付|付款|转账|收款码|付款链接|支付链接)/u.test(clause)
  );
}

function isSafeReplyText(value) {
  const text = normalizeText(value);
  if (!isReplyableText(text) || requestsSensitiveSecret(text, true)) return false;
  return !requestsPayment(text);
}

function safeContextSuffix(context) {
  let start = 0;
  for (let index = 0; index < context.length; index += 1) {
    if (!isReplyableText(context[index].content)) start = index + 1;
  }
  return context.slice(start);
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, file);
}

function diagnosticCode(value, fallback = "unknown") {
  const code = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.:-]{0,80}$/.test(code) ? code : fallback;
}

function normalizeAiWarningCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : "";
}

const SESSION_PROBE_FAILURES = new Set(["schema_not_observed", "matched_rows_zero", "signature_count_zero"]);
const SESSION_PROBE_NUMBER_FIELDS = Object.freeze({
  elementCount: "probe_element_count",
  automationIdSessionItems: "probe_automation_id_session_items",
  automationIdAllowedMatches: "probe_automation_id_allowed_matches",
  allowedTextMatches: "probe_allowed_text_matches",
  parentCandidates: "probe_parent_candidates",
  listContainerCount: "probe_list_container_count",
  listRowCount: "probe_list_row_count",
  rejectedRowLeftBoundary: "probe_rejected_row_left_boundary",
  rejectedRowTooNarrow: "probe_rejected_row_too_narrow",
  rejectedRowVertical: "probe_rejected_row_vertical",
  rejectedRowHeight: "probe_rejected_row_height",
  eligibleRowCount: "probe_eligible_row_count",
  signatureCount: "probe_signature_count",
  emptySignatureCount: "probe_empty_signature_count",
  windowWidth: "probe_window_width",
  windowHeight: "probe_window_height",
  leftLimitOffset: "probe_left_limit_offset",
  minimumRowWidth: "probe_minimum_row_width",
  minimumRowHeight: "probe_minimum_row_height",
  maximumRowHeight: "probe_maximum_row_height"
});

function sanitizeSessionProbe(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  const failure = String(value.failure || "").trim().toLowerCase();
  if (SESSION_PROBE_FAILURES.has(failure)) result.probe_failure = failure;
  if (typeof value.schemaObserved === "boolean") result.probe_schema_observed = value.schemaObserved;
  for (const [source, target] of Object.entries(SESSION_PROBE_NUMBER_FIELDS)) {
    if (typeof value[source] !== "number") continue;
    const number = value[source];
    if (Number.isSafeInteger(number) && number >= 0 && number <= 10_000_000) result[target] = number;
  }
  return result;
}

function sanitizeStructuredScanDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const nested = value.diagnostics && typeof value.diagnostics === "object" && !Array.isArray(value.diagnostics)
    ? value.diagnostics
    : {};
  const source = { ...nested };
  for (const [field, raw] of Object.entries(value)) {
    if (field !== "diagnostics" && raw !== undefined) source[field] = raw;
  }
  const result = {};
  const sanitizeWindow = (rawWindow) => {
    if (!rawWindow || typeof rawWindow !== "object" || Array.isArray(rawWindow)) return null;
    const window = {};
    for (const field of ["x", "y", "left", "top", "right", "bottom", "width", "height"]) {
      const number = Number(rawWindow[field]);
      if (Number.isFinite(number) && Math.abs(number) <= 10_000_000) window[field] = number;
    }
    return Object.keys(window).length ? window : null;
  };
  const sanitizeCounts = (rawCounts) => {
    if (!rawCounts || typeof rawCounts !== "object" || Array.isArray(rawCounts)) return null;
    const counts = {};
    for (const [field, rawCount] of Object.entries(rawCounts).slice(0, 50)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/iu.test(field) || /(?:message|text|content|key|title)/iu.test(field)) continue;
      const count = Number(rawCount);
      if (Number.isSafeInteger(count) && count >= 0 && count <= 10_000_000) counts[field] = count;
    }
    return Object.keys(counts).length ? counts : null;
  };
  const sanitizeDetail = (rawDetail, depth = 0) => {
    if (typeof rawDetail === "string") return diagnosticCode(rawDetail, "") || null;
    if (!rawDetail || typeof rawDetail !== "object" || Array.isArray(rawDetail) || depth > 2) return null;
    const detail = {};
    for (const field of ["reason", "detail", "action", "phase"]) {
      const code = diagnosticCode(rawDetail[field], "");
      if (code) detail[field] = code;
    }
    const childReason = sanitizeDetail(rawDetail.nestedReason, depth + 1);
    if (childReason) detail.nestedReason = childReason;
    const childTransition = sanitizeDetail(rawDetail.transitionDetail, depth + 1);
    if (childTransition) detail.transitionDetail = childTransition;
    const window = sanitizeWindow(rawDetail.window);
    if (window) detail.window = window;
    const dpi = Number(rawDetail.DPI ?? rawDetail.dpi ?? rawDetail.windowDpi ?? rawDetail.window?.DPI ?? rawDetail.window?.dpi);
    if (Number.isFinite(dpi) && dpi >= 48 && dpi <= 960) detail.DPI = dpi;
    const counts = sanitizeCounts(rawDetail.counts);
    if (counts) detail.counts = counts;
    return Object.keys(detail).length ? detail : null;
  };

  const transitionDetail = sanitizeDetail(source.transitionDetail);
  if (transitionDetail) result.transitionDetail = transitionDetail;
  const nestedReason = sanitizeDetail(source.nestedReason);
  if (nestedReason) result.nestedReason = nestedReason;

  const rawWindow = source.window && typeof source.window === "object" && !Array.isArray(source.window)
    ? source.window
    : null;
  const window = sanitizeWindow(rawWindow);
  if (window) result.window = window;

  const dpi = Number(source.DPI ?? source.dpi ?? source.windowDpi ?? rawWindow?.DPI ?? rawWindow?.dpi);
  if (Number.isFinite(dpi) && dpi >= 48 && dpi <= 960) result.DPI = dpi;

  const counts = sanitizeCounts(source.counts);
  if (counts) result.counts = counts;
  const captureMode = diagnosticCode(source.captureMode, "");
  if (new Set(["hwnd_printwindow", "foreground_screen"]).has(captureMode)) result.capture_mode = captureMode;
  return result;
}

function scanReason(value) {
  const raw = String(value || "").trim().toLowerCase();
  const code = diagnosticCode(raw, "scan_result_invalid");
  if (KNOWN_SCAN_REASONS.has(code)) return { code, ref: "" };
  return {
    code: "unknown_scan_reason",
    ref: crypto.createHash("sha256").update(raw || "invalid").digest("hex").slice(0, 12)
  };
}

function rotateDiagnosticLog(file) {
  let temporary = "";
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size <= DIAGNOSTIC_LOG_MAX_BYTES) return true;
    const validLines = fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      })
      .slice(-DIAGNOSTIC_LOG_MAX_LINES);
    temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    let handle;
    try {
      handle = fs.openSync(temporary, "w");
      fs.writeFileSync(handle, validLines.length ? `${validLines.join("\n")}\n` : "", "utf8");
      fs.fsyncSync(handle);
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
    }
    fs.renameSync(temporary, file);
    temporary = "";
    return true;
  } catch {
    return false;
  } finally {
    if (temporary && fs.existsSync(temporary)) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // A locked temporary file is harmless and will never be treated as a log.
      }
    }
  }
}

function appendDiagnosticLine(file, entry) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!rotateDiagnosticLog(file)) return;
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Diagnostics are best effort and contain no customer or message content.
  }
}

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
  if (attempts > PENDING_OBSERVATION_MAX_ATTEMPTS) return null;
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

function createDefaultState() {
  return {
    version: AUTO_REPLY_STATE_VERSION,
    status: "stopped",
    reply_count: 0,
    daily_date: "",
    processed: {},
    reply_guards: {},
    handoff_notified: {},
    manual_followups: [],
    pending_handoff: null,
    pending_handoffs: [],
    pending_observation: null,
    last_event: "",
    last_error: "",
    last_ai_warning_code: "",
    last_ai_warning: "",
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
  const result = Object.fromEntries(Object.entries(entries).map(([key, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || normalizeText(value.status) !== "sending") {
      return [key, value];
    }
    recovered = true;
    return [key, { ...value, status: "outcome_unknown" }];
  }));
  return { processed: result, recovered };
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
  if (raw.version === 2 || raw.version === AUTO_REPLY_STATE_VERSION) {
    const upgrading = raw.version !== AUTO_REPLY_STATE_VERSION;
    const next = { ...createDefaultState(), ...raw };
    next.version = AUTO_REPLY_STATE_VERSION;
    delete next.rate_events;
    const processedRecovery = recoverInterruptedProcessedSends(raw.processed);
    next.processed = processedRecovery.processed;
    next.reply_guards = recoverReplyGuards(raw.reply_guards, next.processed);
    next.handoff_notified = raw.handoff_notified && typeof raw.handoff_notified === "object" ? raw.handoff_notified : {};
    next.manual_followups = Array.isArray(raw.manual_followups)
      ? raw.manual_followups
        .filter((item) => item && typeof item === "object")
        .slice(0, MAX_STATE_ENTRIES)
        .map((item) => ({ ...item, key: pendingHandoffKey(item), delivery_state: "manual_required" }))
      : [];
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
    next.last_ai_warning_code = normalizeAiWarningCode(raw.last_ai_warning_code);
    next.last_ai_warning = normalizeText(raw.last_ai_warning).slice(0, 300);
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

function isSystemContact(contact) {
  const identifiers = [contact?.wechatId, contact?.wxid, contact?.id]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  const name = normalizeText(contact?.name);
  return !identifiers.length
    || identifiers.some((id) => SYSTEM_IDS.has(id) || id.endsWith("@chatroom") || id.startsWith("gh_"))
    || SYSTEM_NAMES.has(name)
    || /群聊$/u.test(name);
}

function compactConversationAlias(value) {
  return normalizeText(value).normalize("NFKC").replace(/\s+/gu, "");
}

function contactConversationAliases(contact, { includeOpaqueWechatId = false } = {}) {
  const aliases = [contact?.name, contact?.remark, contact?.nickname]
    .map((value) => normalizeText(value).normalize("NFKC"))
    .filter(Boolean);
  const wechatId = normalizeText(contact?.wechatId).normalize("NFKC");
  // A rendered chat title can occasionally equal a human-readable WeChat ID,
  // but opaque ASCII identifiers (especially wxid_*) must never be fed to OCR
  // as plausible titles.
  if (wechatId && (includeOpaqueWechatId || !/^(?:wxid_|gh_)/iu.test(wechatId)
    && !/@(?:chatroom)?$/iu.test(wechatId) && !/^[a-z][a-z0-9_.-]*$/iu.test(wechatId))) aliases.push(wechatId);
  return [...new Set(aliases)];
}

function contactAliasIndex(contacts, options = {}) {
  const ownership = new Map();
  for (const contact of contacts) {
    for (const alias of contactConversationAliases(contact, options)) {
      const key = compactConversationAlias(alias);
      if (!key) continue;
      const entry = ownership.get(key) || { alias, contacts: [] };
      if (!entry.contacts.includes(contact)) entry.contacts.push(contact);
      ownership.set(key, entry);
    }
  }
  return ownership;
}

function autoReplyConversationAliases(contacts) {
  return [...contactAliasIndex(contacts).values()]
    .filter((entry) => entry.contacts.length === 1)
    .map((entry) => entry.alias);
}

function eligibleContacts(activeTouchDir) {
  const contacts = readContacts(activeTouchDir)
    .filter((contact) => contact.wechatAccountId && !isSystemContact(contact));
  const allowedContacts = new Set([...contactAliasIndex(contacts).values()]
    .filter((entry) => entry.contacts.length === 1)
    .map((entry) => entry.contacts[0]));
  return contacts.filter((contact) => allowedContacts.has(contact));
}

function normalizedContext(candidate) {
  if (!Array.isArray(candidate?.context)) return [];
  const context = candidate.context
    .slice(-12)
    .map((item) => ({
      role: item?.role === "assistant" ? "assistant" : item?.role === "user" ? "user" : "",
      content: normalizeText(item?.content),
      key: normalizeText(item?.key)
    }))
    .filter((item) => item.role && item.content);
  const latest = context.at(-1);
  if (!latest || latest.role !== "user" || latest.content !== normalizeText(candidate.message)) return [];
  return context;
}

function fingerprintFor(contact, candidate) {
  const runtimeId = normalizeText(candidate?.runtimeId);
  const incoming = normalizeText(candidate?.message);
  if (!runtimeId || !incoming) return "";
  return crypto.createHash("sha256")
    .update(JSON.stringify([
      contact.wechatAccountId || "unknown",
      contact.id,
      runtimeId,
      incoming
    ]))
    .digest("hex");
}

function contactForAutoReplyConversation(contacts, candidate) {
  const conversation = normalizeText(candidate?.conversation || candidate?.currentConversation);
  if (!conversation) return null;
  const entry = contactAliasIndex(contacts, { includeOpaqueWechatId: true }).get(compactConversationAlias(conversation));
  if (entry?.contacts?.length === 1) return entry.contacts[0];
  if (candidate?.messageDriven !== true) return null;
  const visualIdentity = [
    normalizeText(candidate?.conversationEvidence) || conversation,
    String(candidate?.pid || ""),
    String(candidate?.hWnd || "")
  ].join("\n");
  const identity = crypto.createHash("sha256").update(visualIdentity).digest("hex").slice(0, 24);
  return {
    id: `visual-inbound-${identity}`,
    wechatAccountId: `visual-window-${String(candidate?.pid || "unknown")}`,
    name: "",
    remark: "",
    nickname: "",
    wechatId: ""
  };
}

function incomingEvidenceFor(candidate) {
  const runtimeId = normalizeText(candidate?.runtimeId);
  const visualEvidenceRuntimeId = normalizeText(candidate?.visualEvidenceRuntimeId);
  const messageSignature = normalizeText(candidate?.messageSignature).toLowerCase();
  const incoming = normalizeText(candidate?.message);
  const isVisual = normalizeText(candidate?.visualMode) === "visual_render_v1"
    || /^visual:v[12]:[a-f0-9]{64}$/u.test(runtimeId)
    || /^visual:v1:[a-f0-9]{64}$/u.test(visualEvidenceRuntimeId);
  let identity = "";
  if (isVisual) {
    // visual:v1 is a semantic OCR signature (role + text), so a customer may
    // legitimately produce it again in a later turn. Only the v2 occurrence
    // token contains the driver's durable turn boundary and may deduplicate a
    // send outcome across polls or restarts.
    if (/^visual:v2:[a-f0-9]{64}$/u.test(runtimeId)) identity = runtimeId;
  } else if (runtimeId && incoming) {
    const latestContextKey = Array.isArray(candidate?.context) ? normalizeText(candidate.context.at(-1)?.key) : "";
    identity = JSON.stringify([runtimeId, latestContextKey || runtimeId, incoming]);
  }
  return {
    id: identity ? crypto.createHash("sha256").update(`${isVisual ? "visual" : "uia"}\n${identity}`).digest("hex") : "",
    kind: isVisual ? "visual" : "uia",
    runtimeId,
    visualEvidenceRuntimeId,
    messageSignature
  };
}

function isTerminalProcessed(entry) {
  return Boolean(entry) && !["generating", "ready_to_send", "retryable"].includes(normalizeText(entry.status));
}

function retryPolls(attempts) {
  return Math.min(2 ** Math.max(0, Math.min(Number(attempts) - 1, 6)), 60);
}

// Kept as a diagnostic calculation for existing logs and self-checks. It no
// longer blocks or pauses the live listener.
function exceedsRateLimit(events, nowMs = Date.now()) {
  return (Array.isArray(events) ? events : []).filter((event) => {
    const at = new Date(event?.at || 0).getTime();
    return Number.isFinite(at) && at <= nowMs && nowMs - at < RATE_WINDOW_MS;
  }).length >= GLOBAL_RATE_LIMIT;
}

function buildHandoffMessage({ conversation, reason, latest, at = new Date() }) {
  return [
    "【需人工跟进】",
    `客户：${normalizeText(conversation) || "未知客户"}`,
    `原因：${normalizeText(reason) || "需要人工确认"}`,
    `最新需求：${normalizeText(latest) || "未识别"}`,
    `时间：${at.toLocaleString("zh-CN", { hour12: false })}`,
    "请人工跟进"
  ].join("\n");
}

function createAutoReplyController(options = {}) {
  const dataDir = String(options.dataDir || "");
  const activeTouchDir = String(options.activeTouchDir || "");
  const stateFile = path.join(dataDir, "auto-reply-state.json");
  const diagnosticLogFile = path.join(dataDir, "auto-reply-diagnostics.jsonl");
  const diagnosticRunId = crypto.randomBytes(8).toString("hex");
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
  const rawState = readJson(stateFile, null);
  let state = migrateState(rawState, now());
  let diagnosticSequence = 0;
  if (rawState && (
    rawState.version !== AUTO_REPLY_STATE_VERSION
    || rawState.status === "running"
    || rawState.status === "starting"
    || Object.values(rawState.processed || {}).some((entry) => normalizeText(entry?.status) === "sending")
    || JSON.stringify(rawState.reply_guards || {}) !== JSON.stringify(state.reply_guards || {})
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
    writeAtomic(stateFile, state);
  }
  let timer = null;
  let scanActive = false;
  let runEpoch = 0;
  let starting = false;
  let primeRetryNeeded = false;
  const pendingHandoffQueue = [];
  const retryGenerations = new Map();
  let handoffConfirmationRequired = handoffNeedsConfirmation(state.pending_handoff);

  function save() {
    state.updated_at = now().toISOString();
    writeAtomic(stateFile, state);
    if (onStateChange) {
      try {
        onStateChange(publicState());
      } catch {
        // Renderer updates are best effort; durable state remains authoritative.
      }
    }
  }

  function appendDiagnostic(event, details = {}) {
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
    const pid = Math.floor(Number(details.pid));
    if (Number.isSafeInteger(pid) && pid > 0) entry.wechat_pid = pid;
    const windowHandle = String(details.hWnd || "").trim();
    if (/^[0-9]{1,20}$/.test(windowHandle)) entry.wechat_window_handle = windowHandle;
    const reasonRef = String(details.reasonRef || "").trim().toLowerCase();
    if (/^[a-f0-9]{12}$/.test(reasonRef)) entry.reason_ref = reasonRef;
    if (code === "session_probe_unsupported") Object.assign(entry, sanitizeSessionProbe(details.sessionProbe));
    Object.assign(entry, sanitizeStructuredScanDiagnostics(details));
    appendDiagnosticLine(diagnosticLogFile, entry);
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

    const neutral = reason === "baseline_epoch_changed" || reason === "unread_preview_pending" || phase === "prime" && reason === "no_current_conversation";
    const successful = result?.ok === true || HEALTHY_SCAN_REASONS.has(reason);
    if (neutral) {
      if (!SCAN_HEALTH_VALUES.has(state.scan_health) || state.scan_health === "unknown") state.scan_health = "checking";
    } else if (successful) {
      state.scan_health = "healthy";
      state.last_scan_success_at = observedAt;
      state.consecutive_scan_failures = 0;
    } else {
      state.consecutive_scan_failures = Math.max(0, Math.floor(Number(state.consecutive_scan_failures) || 0)) + 1;
      state.scan_health = state.consecutive_scan_failures >= SCAN_DEGRADED_AFTER ? "degraded" : "warning";
    }

    const changed = previousHealth !== state.scan_health || previousReason !== reason;
    const recovered = successful && (previousFailures > 0 || previousHealth === "warning" || previousHealth === "degraded");
    const becameHealthy = successful && previousHealth !== "healthy";
    const faultChanged = !successful && !neutral && changed;
    if (neutral && changed || recovered || becameHealthy || faultChanged) {
      appendDiagnostic(neutral ? phase === "prime" ? "prime_skipped" : "scan_cancelled" : recovered ? "scan_recovered" : successful ? "scan_healthy" : "scan_failed", {
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
        diagnostics: result?.diagnostics
      });
    }
    return successful || neutral;
  }

  function publicState() {
    const manualWarning = manualFollowupMessage(state.manual_followups);
    const showManualWarning = Boolean(manualWarning) && !normalizeText(state.last_error);
    return {
      status: state.status,
      reply_count: state.reply_count,
      last_event: showManualWarning ? "handoff_manual_followup_required" : state.last_event,
      last_error: showManualWarning ? manualWarning : state.last_error,
      last_ai_warning_code: state.last_ai_warning_code,
      last_ai_warning: state.last_ai_warning,
      scan_health: state.scan_health,
      last_scan_at: state.last_scan_at,
      last_scan_success_at: state.last_scan_success_at,
      last_scan_reason: state.last_scan_reason,
      consecutive_scan_failures: state.consecutive_scan_failures,
      pending_retry_count: Math.max(0, Number(state.pending_observation?.attempts) || 0),
      updated_at: state.updated_at
    };
  }

  function resetDailyCounter(current) {
    const today = dayKey(current);
    if (state.daily_date === today) return;
    state.daily_date = today;
    state.reply_count = 0;
  }

  function status() {
    const previousDate = state.daily_date;
    resetDailyCounter(now());
    if (state.daily_date !== previousDate) save();
    return publicState();
  }

  function queueNext(delay = POLL_INTERVAL_MS) {
    if (timer || state.status !== "running") return;
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

  function movePendingHandoffToManual(key) {
    const pending = (state.pending_handoffs || []).find((item) => pendingHandoffKey(item) === key)
      || pendingHandoffQueue.find((item) => item.metadata.key === key)?.metadata;
    if (!pending) return;
    state.manual_followups ||= [];
    if (!state.manual_followups.some((item) => pendingHandoffKey(item) === key)) {
      state.manual_followups.push({ ...pending, key, delivery_state: "manual_required" });
      if (state.manual_followups.length > MAX_STATE_ENTRIES) state.manual_followups.shift();
    }
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
    if (timer) cancelSchedule(timer);
    timer = null;
    if (state.pending_handoff && handoffConfirmationRequired) pauseForFailure("handoff_confirmation_required", "");
    else {
      state.status = "paused";
      state.last_event = reason;
    }
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

  function recordOutgoingObservation(candidate, contacts, observedAt) {
    const isScanObservation = normalizeText(candidate?.reason) === "latest_message_not_incoming";
    const isPrimeObservation = candidate?.ok === true
      && (normalizeText(candidate?.source) === "session_prime" || candidate?.primed === true);
    if ((!isScanObservation && !isPrimeObservation) || normalizeText(candidate?.latestRole) !== "assistant") return false;
    const baseline = candidate?.messageBaselineAdvance;
    const conversation = normalizeText(baseline?.conversation || candidate?.conversation || candidate?.currentConversation);
    const signature = normalizeText(baseline?.signature || candidate?.messageSignature || candidate?.currentMessageSignature).toLowerCase();
    if (!conversation || !/^[a-f0-9]{64}$/u.test(signature)) return false;
    const contact = contactForAutoReplyConversation(contacts, candidate);
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
      attempts: Math.min(PENDING_OBSERVATION_MAX_ATTEMPTS, Number(pending.attempts || 1) + 1),
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

  async function start() {
    if (state.status === "running") return { ok: true, state: publicState() };
    if (starting) return { ok: false, error: "自动回复正在启动，请稍候" };
    const contacts = eligibleContacts(activeTouchDir);
    if (!contacts.length) return { ok: false, error: "没有可安全识别的已同步一对一联系人" };
    const conversationAliases = autoReplyConversationAliases(contacts);
    if (!conversationAliases.length) return { ok: false, error: "已同步联系人没有唯一可识别的会话名称" };
    try {
      deepSeekClient?.assertAvailable();
      const expert = expertStore?.read();
      if (!normalizeText(expert?.text)) return { ok: false, error: "请先在 AI专家 导入自动回复话术文件" };
    } catch (error) {
      return { ok: false, error: String(error?.message || error), code: error?.code };
    }
    if (typeof send !== "function" || typeof sendHandoff !== "function" || typeof runStep !== "function") {
      return { ok: false, error: "当前版本未启用经校验的自动回复执行器" };
    }
    acknowledgePendingHandoff();
    let recoveredHandoffWarning = "";
    if (state.pending_handoff && !pendingHandoffQueue.length && handoffNeedsConfirmation(state.pending_handoff)) {
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
    state.scan_health = "checking";
    state.consecutive_scan_failures = 0;
    resetDailyCounter(now());
    appendDiagnostic("start_requested", { phase: "prime", code: "starting" });
    save();
    try {
      await waitForScanIdle();
      if (runEpoch !== startEpoch || state.status !== "starting") return { ok: false, error: "自动回复启动已取消", state: publicState() };
      const pendingObservation = state.pending_observation;
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
            primed = await Promise.resolve(primeIncoming(conversationAliases));
          } catch {
            primed = { ok: false, reason: "scan_exception" };
          }
          if (runEpoch !== startEpoch || state.status !== "starting") return { ok: false, error: "自动回复启动已取消", state: publicState() };
          recordScanResult(primed, "prime");
          recordOutgoingObservation(primed, contacts, now());
          if (primed?.ok !== true && FATAL_STARTUP_PRIME_REASONS.has(normalizeText(primed?.reason))) {
            throw new Error(state.last_scan_reason || "微信当前会话基线初始化失败");
          }
          if (primed?.ok !== true) {
            // OCR, foreground, viewport and window discovery can flicker at
            // startup. The next regular scan re-primes when no baseline exists.
            state.scan_health = "checking";
            state.consecutive_scan_failures = 0;
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
      deepSeekClient?.assertAvailable();
      const latestExpert = expertStore?.read();
      if (!normalizeText(latestExpert?.text)) throw new Error("请先在 AI专家 导入自动回复话术文件");
      recoveredHandoffWarning = recoverKnownUnsentHandoffs();
      if (handoffNeedsConfirmation(state.pending_handoff)) {
        handoffConfirmationRequired = true;
        pauseForFailure("handoff_confirmation_required", "还有发送结果未确认的人工提醒");
        save();
        return { ok: false, error: state.last_error, state: publicState() };
      }
      state.status = "running";
      state.last_event = recoveredHandoffWarning ? "handoff_manual_followup_required" : "started";
      state.last_error = recoveredHandoffWarning;
      appendDiagnostic("started", { phase: "prime", code: state.last_scan_reason || "started" });
      save();
      // Let the successful start IPC reach the renderer before the first OCR
      // pass. The Windows visual probe can briefly occupy the main process, so
      // an immediate scan made the page look stuck on “启动中/检查中”.
      queueNext();
      return { ok: true, state: publicState() };
    } catch (error) {
      if (runEpoch === startEpoch && state.status === "starting") {
        state.status = "paused";
        state.last_event = "start_failed";
        state.last_error = String(error?.message || error || "自动回复启动失败");
        appendDiagnostic("start_failed", { phase: "prime", code: state.last_scan_reason || "start_failed" });
        save();
      }
      return { ok: false, error: String(error?.message || error || "自动回复启动失败"), state: publicState() };
    } finally {
      starting = false;
    }
  }

  function pauseWithError(event, error) {
    state.status = "paused";
    state.last_event = event;
    state.last_error = String(error || "自动回复已暂停");
  }

  function pauseForFailure(event, error) {
    if (!state.pending_handoff || !handoffConfirmationRequired) return pauseWithError(event, error);
    state.status = "paused";
    state.last_event = "handoff_confirmation_required";
    const detail = normalizeText(error);
    const confirmation = handoffInterruptedMessage(state.pending_handoff);
    state.last_error = detail ? `${confirmation}（${detail}）` : confirmation;
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
        updateHandoffDeliveryState(payload.metadata.key, "outcome_unknown");
        handoffConfirmationRequired = true;
        pauseForFailure("handoff_confirmation_required", result?.error || result?.blocked_reason || "人工提醒发送失败");
      }
      save();
      return "handled";
    }
    const pending = state.pending_handoff;
    state.handoff_notified ||= {};
    state.handoff_notified[pending.key] = {
      contact_id: pending.contact_id,
      at: pending.at
    };
    removePendingHandoff(pending.key);
    handoffConfirmationRequired = false;
    trimMap(state.handoff_notified);
    if (payload.pauseReason) pauseWithError("ai_configuration_paused", payload.pauseReason);
    else if (!currentRun && state.last_event === "handoff_confirmation_required") {
      state.last_event = "paused_by_user";
      state.last_error = "";
    }
    else if (state.pending_handoff) {
      state.last_event = "handoff_pending";
      state.last_error = "";
    }
    else {
      state.last_event = payload.successEvent;
      state.last_error = "";
    }
    save();
    return currentRun && state.status === "running" ? "sent" : "handled";
  }

  async function runOnce() {
    if (scanActive || state.status !== "running") return publicState();
    scanActive = true;
    const activeEpoch = runEpoch;
    const isCurrentRun = () => state.status === "running" && runEpoch === activeEpoch;
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

      const handoffDelivery = await deliverPendingHandoff(lock, isCurrentRun);
      const handoffRetryError = ["retryable", "deferred"].includes(handoffDelivery) ? state.last_error : "";
      if (handoffDelivery === "handled") return publicState();

      const contacts = eligibleContacts(activeTouchDir);
      const conversationAliases = autoReplyConversationAliases(contacts);
      if (primeRetryNeeded && typeof primeIncoming === "function") {
        let primed;
        try {
          primed = await Promise.resolve(primeIncoming(conversationAliases));
        } catch {
          primed = { ok: false, reason: "scan_exception" };
        }
        if (!isCurrentRun()) return publicState();
        recordScanResult(primed, "prime");
        recordOutgoingObservation(primed, contacts, current);
        if (primed?.ok !== true) {
          state.scan_health = "checking";
          state.consecutive_scan_failures = 0;
          state.last_event = state.last_scan_reason || "prime_deferred";
          state.last_error = "";
          save();
          return publicState();
        }
        primeRetryNeeded = false;
      }
      let candidate;
      try {
        candidate = await Promise.resolve(scanIncoming(conversationAliases));
      } catch (error) {
        if (isCurrentRun()) recordScanResult({ ok: false, reason: "scan_exception" }, "scan");
        throw error;
      }
      if (!isCurrentRun()) return publicState();
      if (candidate?.scanProbe?.ok !== null) {
        const observation = candidate?.scanProbe
          ? { ...candidate.scanProbe, pid: candidate.pid, hWnd: candidate.hWnd }
          : candidate;
        recordScanResult(observation, "scan");
      }
      if (!candidate?.ok) {
        const candidateReason = normalizeText(candidate?.reason);
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
        const outgoingObserved = recordOutgoingObservation(candidate, contacts, current);
        if (handoffDelivery !== "none") {
          save();
          return publicState();
        }
        state.last_event = outgoingObserved ? "reply_guard_outgoing_observed" : state.last_scan_reason || "scan_result_invalid";
        state.last_error = "";
        save();
        return publicState();
      }

      const conversation = normalizeText(candidate.conversation);
      const contact = contactForAutoReplyConversation(contacts, candidate);
      if (!contact) {
        clearPendingObservation(candidate);
        state.last_event = "conversation_not_eligible";
        state.last_error = "";
        save();
        return publicState();
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
      const context = safeContextSuffix(rawContext);

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

      const retryEntry = retryGenerations.get(fingerprint);
      if (retryEntry?.pollsRemaining > 0) {
        retryEntry.pollsRemaining -= 1;
        retryGenerations.set(fingerprint, retryEntry);
        remember(fingerprint, { status: "retryable", ...processedMetadata, conversation, at: current.toISOString() });
        if (requeueCandidate(candidate)) {
          state.last_event = "send_retry_waiting";
          state.last_error = "回复尚未发出，正在退避后重试";
        } else {
          pauseWithError("send_retry_queue_paused", "回复尚未发出，但安全重试队列不可用，请人工检查后再启动");
        }
        save();
        return publicState();
      }
      remember(fingerprint, { status: "generating", ...processedMetadata, conversation, at: current.toISOString() });
      state.last_event = "generating_reply";
      state.last_error = "";
      save();
      let generated = retryEntry?.generated;
      if (!generated) {
        const expert = expertStore?.read();
        if (!normalizeText(expert?.text)) throw new Error("AI专家话术文件不可用");
        coordinator.update(lock.lock.owner, "generate-reply");
        generated = await deepSeekClient.reply({ context, expert: expert.text });
      }
      if (!isCurrentRun()) {
        retryGenerations.delete(fingerprint);
        state.processed[fingerprint].status = "cancelled";
        clearPendingObservation(candidate);
        save();
        return publicState();
      }
      const reply = normalizeText(generated?.reply);
      if (!isSafeReplyText(reply)) throw new Error("DeepSeek 返回的回复未通过安全检查");

      // Generation is complete but no operation capable of sending has begun.
      // Persist that distinction so a crash here can regenerate/retry the same
      // occurrence. The state becomes `sending` only when the sender enters its
      // draft phase; a crash after that remains outcome-unknown on restart.
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
        const verification = await Promise.resolve(verifyIncoming(candidate));
        incomingStillCurrent = verification?.ok === true;
        return incomingStillCurrent;
      };
      const beforeDraft = async () => {
        state.processed[fingerprint].status = "sending";
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
      const result = await send({
        baseDir: dataDir,
        contactsDir: activeTouchDir,
        authorized: true,
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
        messageDriven: candidate.messageDriven === true,
        beforeDraft,
        shouldContinue,
        runStep: (command, args) => runStep(command, args, lock.lock.owner)
      });

      if (!isCurrentRun() && result?.blocked_reason === "batch_cancelled") {
        retryGenerations.delete(fingerprint);
        state.processed[fingerprint].status = "cancelled";
        clearPendingObservation(candidate);
        save();
        return publicState();
      }
      if (!isCurrentRun()) {
        retryGenerations.delete(fingerprint);
        if (result?.ok) {
          const staleSentAt = now();
          resetDailyCounter(staleSentAt);
          state.processed[fingerprint].status = "sent_verified";
          state.reply_count += 1;
          const turnEpoch = noteVisualSendAttempt(candidate, result);
          recordReplyGuard(contact, candidate, fingerprint, incomingEvidence, staleSentAt, "sent_verified", turnEpoch);
          clearPendingObservation(candidate);
          pauseWithError("stale_run_send_paused", "旧运行轮次在暂停后仍完成了发送，请人工检查");
        } else if (result?.send_attempted !== false) {
          state.processed[fingerprint].status = "outcome_unknown";
          const turnEpoch = noteVisualSendAttempt(candidate, result, true);
          recordReplyGuard(contact, candidate, fingerprint, incomingEvidence, now(), "outcome_unknown", turnEpoch);
          clearPendingObservation(candidate);
          pauseWithError("send_outcome_unknown_paused", result?.blocked_reason || result?.error || "自动回复发送结果无法确认");
        } else {
          state.processed[fingerprint].status = "cancelled";
          clearPendingObservation(candidate);
        }
        save();
        return publicState();
      }
      if (!incomingStillCurrent || new Set(["incoming_message_changed", "visual_send_incoming_changed"]).has(normalizeText(result?.blocked_reason))) {
        retryGenerations.delete(fingerprint);
        state.processed[fingerprint].status = "cancelled";
        clearPendingObservation(candidate);
        state.last_event = "manual_reply_or_message_changed";
        state.last_error = "";
        save();
        return publicState();
      }
      if (!result?.ok) {
        if (result?.send_attempted === false) {
          const attempts = Number(retryEntry?.attempts || 0) + 1;
          retryGenerations.set(fingerprint, { generated, attempts, pollsRemaining: retryPolls(attempts) });
          if (retryGenerations.size > MAX_STATE_ENTRIES) retryGenerations.delete(retryGenerations.keys().next().value);
          state.processed[fingerprint].status = "retryable";
          const retryQueued = requeueCandidate(candidate);
          if (retryQueued) {
            state.last_event = "send_retry_pending";
            state.last_error = `本次回复尚未发出，将自动重试：${normalizeText(result?.blocked_reason || result?.error) || "发送前校验未通过"}`;
          } else {
            pauseWithError("send_retry_queue_paused", "回复尚未发出，但安全重试队列不可用，请人工检查后再启动");
          }
        } else {
          retryGenerations.delete(fingerprint);
          state.processed[fingerprint].status = "outcome_unknown";
          const turnEpoch = noteVisualSendAttempt(candidate, result, true);
          recordReplyGuard(contact, candidate, fingerprint, incomingEvidence, now(), "outcome_unknown", turnEpoch);
          clearPendingObservation(candidate);
          pauseWithError("send_outcome_unknown_paused", result?.blocked_reason || result?.error || "自动回复发送结果无法确认");
        }
        save();
        return publicState();
      }

      const sentAt = now();
      retryGenerations.delete(fingerprint);
      resetDailyCounter(sentAt);
      state.processed[fingerprint].status = "sent_verified";
      state.reply_count += 1;
      const turnEpoch = noteVisualSendAttempt(candidate, result);
      recordReplyGuard(contact, candidate, fingerprint, incomingEvidence, sentAt, "sent_verified", turnEpoch);
      clearPendingObservation(candidate);
      state.last_event = "reply_sent_verified";
      state.last_error = "";
      state.last_ai_warning_code = normalizeAiWarningCode(generated?.aiWarningCode);
      state.last_ai_warning = normalizeText(generated?.aiWarning).slice(0, 300);
      const pauseReason = generated?.pauseAfterHandoff === true
        ? normalizeText(generated?.pauseReason) || "DeepSeek 配置需要人工处理"
        : "";

      let handoffCreated = false;
      if (generated?.needsHuman === true) {
        const reason = normalizeText(generated?.handoffReason || generated?.intentReason) || "需要人工跟进";
        const handoffKey = crypto.createHash("sha256")
          .update(`${contact.id}\n${context.map((item) => `${item.role}:${item.key || item.content}`).join("\n")}`)
          .digest("hex");
        if (!state.handoff_notified?.[handoffKey] && !state.manual_followups?.some((item) => pendingHandoffKey(item) === handoffKey)) {
          const metadata = { key: handoffKey, contact_id: contact.id, conversation, at: sentAt.toISOString() };
          handoffCreated = enqueueHandoff(metadata, {
            message: buildHandoffMessage({ conversation, reason, latest: incoming, at: sentAt }),
            expectedPid: candidate.pid,
            sourceWindowHandle: candidate.hWnd,
            successEvent: generated.intent === true ? "intent_handoff_sent" : "human_handoff_sent",
            pauseReason,
            attempts: 0,
            pollsRemaining: 0
          });
          if (handoffCreated) state.last_event = "handoff_pending";
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
        if (pauseReason && isCurrentRun()) {
          pauseWithError("ai_configuration_paused", pauseReason);
          save();
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

  return { acknowledgeManualFollowup, pause, runOnce, start, status };
}

function registerAutoReplyIpc(options = {}) {
  const ipcMain = options.ipcMain || require("electron").ipcMain;
  const getMainWindow = options.getMainWindow;
  const controller = createAutoReplyController({
    ...options,
    onStateChange: (state) => {
      try {
        options.onStateChange?.(state);
      } catch {}
      const mainWindow = getMainWindow?.();
      if (!mainWindow || mainWindow.isDestroyed?.()) return;
      try {
        mainWindow.webContents?.send?.("auto-reply:update", { ok: true, state });
      } catch {
        // The renderer may be reloading; polling remains the fallback.
      }
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
  ipcMain.handle("auto-reply:start", (event, payload = {}) => {
    if (!consumeTrustedClick(event, payload)) {
      return { ok: false, error: "请在主窗口中手动点击启动自动回复" };
    }
    return controller.start();
  });
  ipcMain.handle("auto-reply:acknowledge-manual-followup", (event, payload = {}) => {
    if (!consumeTrustedClick(event, payload)) return { ok: false, error: "请在主窗口中手动确认人工提醒已处理" };
    return controller.acknowledgeManualFollowup();
  });
  ipcMain.handle("auto-reply:pause", () => controller.pause());
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
