const crypto = require("node:crypto");
const { diagnostics, normalizeReceiptDiagnostics } = require("./diagnostics.cjs");
const fs = require("node:fs");
const path = require("node:path");
const { readContacts } = require("../../rpa/active_touch/state_machine.cjs");
const { identityKey } = require("../../rpa/active_touch/touch_task_state.cjs");
const { writeFileAtomic, writeJsonAtomic } = require("./atomic-file.cjs");
const { FLOATING_PROGRESS_WINDOW, floatingProgressPosition } = require("./floating-progress-window.cjs");
const {
  AUTO_REPLY_ACTIONS,
  AUTO_REPLY_REASON_CODES
} = require("./auto-reply-decision.cjs");

const POLL_INTERVAL_MS = 5_000;
const FAST_RECHECK_MS = 750;
const AUTO_REPLY_STATE_VERSION = 4;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const GLOBAL_RATE_LIMIT = 30;
const MAX_STATE_ENTRIES = 1_000;
const SCAN_DEGRADED_AFTER = 3;
const DIAGNOSTIC_LOG_MAX_BYTES = 512 * 1024;
const DIAGNOSTIC_LOG_MAX_LINES = 500;
const USER_IDLE_WAIT_REASON = "wechat_user_active";
const RECOVERY_ACTIONS = new Set([
  "wait_for_idle",
  "wait_for_idle_and_retry",
  "retry_waiting",
  "retry_pending",
  "manual_review_required",
  "manual_check_required",
  "fix_ai_and_restart",
  "continue_other_contacts"
]);
const MANUAL_REVIEW_SEND_REASONS = new Set([
  "visual_send_external_input_detected"
]);
const SCAN_HEALTH_VALUES = new Set(["unknown", "checking", "healthy", "warning", "degraded", "waiting"]);
const AUTO_REPLY_ACTIVITY_PHASES = new Set([
  "idle",
  "starting",
  "prime",
  "listening",
  "scanning",
  "candidate",
  "generating",
  "decision_ready",
  "preparing_send",
  "sending",
  "prepared",
  "clicked",
  "verifying",
  "retrying",
  "manual_review",
  "sent_verified",
  "silent",
  "waiting",
  "paused",
  "error"
]);
const AUTO_REPLY_DELIVERY_STATES = new Set(["not_attempted", "prepared", "clicked", "sent_verified", "outcome_unknown"]);
const CONTACT_GENERATION_FAILURES = new Set([
  "AI_RESPONSE_EMPTY",
  "AI_RESPONSE_INVALID",
  "AI_RESPONSE_TRUNCATED",
  "AI_RESPONSE_INCOMPLETE",
  "AI_RESPONSE_LENGTH_INVALID"
]);
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
const RETRYABLE_CURRENT_SESSION_REASONS = new Set([
  "current_session_recheck_pending"
]);
const SCAN_OBSERVATION_REASONS = new Set([
  "no_unread_message",
  "no_current_conversation",
  "current_conversation_ambiguous",
  "current_sidebar_row_unresolved",
  "current_transition_unresolved",
  "conversation_title_unresolved",
  ...RETRYABLE_CURRENT_SESSION_REASONS
]);
const SCAN_OBSERVATION_SOURCES = new Set([
  "current_message_change",
  "pending_recovery",
  "scan_driver",
  "session_prime",
  "unread_badge",
  "visual_driver"
]);
const SCAN_OBSERVATION_TRIGGERS = new Set([
  "current_session_recheck",
  "poll",
  "startup_boundary"
]);
const SCAN_OBSERVATION_ROLES = new Set(["assistant", "unknown", "user"]);
const SCAN_CAPTURE_MODES = new Set(["foreground_screen", "hwnd_printwindow", "unknown"]);
const MESSAGE_READ_SOURCES = new Set(["full_window+chat_contrast", "full_window"]);
const MESSAGE_READ_BOUNDARY_SOURCES = new Set(["composer_divider", "normalized_window_ratio"]);
const SCAN_OBSERVATION_INTERVAL_MS = 30_000;
const PENDING_OBSERVATION_REASONS = new Set([
  "unread_preview_pending",
  "reply_in_flight"
]);
// Opening a red-dot conversation consumes the unread mark. A transient OCR
// miss must therefore remain recoverable across as many polls as necessary;
// only an explicit terminal observation may discard it. Keep the opaque
// evidence long enough to survive a real UI recovery, while stale process/
// window evidence is still rejected during restore.
const PENDING_OBSERVATION_MAX_AGE_MS = 30 * 60 * 1000;
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
const STRICT_SCOPE_WINDOW_RESET_REASONS = new Set([
  "wechat_process_changed",
  "wechat_window_changed",
  "wechat_window_identity_mismatch",
  "wechat_window_missing"
]);
const KNOWN_SCAN_REASONS = new Set([
  "wechat_chat_entry_not_found",
  "wechat_chat_entry_ambiguous",
  "wechat_chat_entry_not_owned",
  "wechat_chat_surface_unverified",
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
  "current_session_recheck_pending",
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
  "wechat_user_active",
  "wechat_window_ambiguous",
  "wechat_window_changed",
  "wechat_window_identity_mismatch",
  "wechat_window_missing",
  "wechat_window_not_foreground",
  "wechat_window_not_ready",
  "wechat_window_obscured",
  "whitelist_empty",
  "whitelist_invalid",
  "whitelist_name_ambiguous",
  "conversation_title_unresolved"
]);
const KNOWN_SEND_DIAGNOSTIC_REASONS = new Set([
  "atomic_draft_changed",
  "atomic_send_not_verified",
  "batch_authorization_missing",
  "batch_cancelled",
  "contact_or_message_missing",
  "contact_snapshot_changed",
  "conversation_mismatch",
  "conversation_not_verified",
  "conversation_token_missing",
  "draft_not_sent",
  "incoming_message_changed",
  "message_bubble_not_new_latest_exact",
  "message_bubble_verifier_failed",
  "message_snapshot_unavailable",
  "outcome_unknown",
  "personal_wechat_main_window_not_found",
  "powershell_aborted",
  "powershell_failed",
  "powershell_output_invalid",
  "powershell_runtime_quarantined",
  "powershell_timeout",
  "real_send_already_attempted",
  "real_send_explicit_allow_missing",
  "real_send_final_confirmation_missing",
  "real_send_gate_failed",
  "real_send_not_armed",
  "real_send_not_clicked",
  "real_send_session_changed",
  "real_send_session_not_verified",
  "send_driver_exception",
  "send_gate_not_passed",
  "send_not_attempted",
  "send_outcome_unknown",
  "visual_send_before_send_failed",
  "visual_send_button_not_owned",
  "visual_send_button_not_unique",
  "visual_send_cancelled",
  "visual_send_context_invalid",
  "visual_send_conversation_ambiguous",
  "visual_send_conversation_different",
  "visual_send_conversation_not_bound",
  "visual_send_conversation_unresolved",
  "visual_send_cursor_not_verified",
  "visual_send_draft_input_failed",
  "visual_send_draft_not_verified",
  "visual_send_driver_exception",
  "visual_send_external_input_detected",
  "visual_send_header_ocr_unresolved",
  "visual_send_incoming_changed",
  "visual_send_incoming_ocr_unresolved",
  "visual_send_message_driven_disallowed",
  "visual_send_not_verified",
  "visual_send_outcome_unknown",
  "visual_send_phase_invalid",
  "visual_send_sidebar_contact_ambiguous",
  "visual_send_sidebar_contact_not_selected",
  "visual_send_sidebar_contact_unresolved",
  "visual_send_sidebar_ocr_unresolved",
  "visual_send_window_geometry_invalid",
  "visual_send_window_identity_mismatch",
  "visual_send_window_not_foreground",
  "visual_send_window_not_visible",
  "wechat_account_changed",
  "wechat_account_identity_missing",
  "wechat_account_not_verified",
  "wechat_external_input_detected",
  "wechat_input_lease_unavailable",
  "wechat_user_active",
  "wechat_window_identity_mismatch",
  "wechat_window_inspection_failed",
  "wechat_window_not_foreground",
  "wechat_window_not_ready",
  "wechat_window_preflight_failed"
]);
const STRUCTURED_SCAN_DETAIL_CODES = new Set([
  ...KNOWN_SCAN_REASONS,
  "boundary",
  "candidate",
  "current_identity_invalid",
  "current_message_identity_invalid",
  "first_frame_identity_invalid",
  "first_frame_invalid",
  "latest_role_unresolved",
  "message_evidence_invalid",
  "none",
  "prime",
  "scan",
  "second_frame_invalid",
  "second_frame_unstable",
  "settle",
  "uia",
  "unresolved",
  "visual"
]);
const STRUCTURED_SCAN_COUNT_FIELDS = new Set([
  "bubble_count",
  "component_count",
  "conversation_candidate_count",
  "header_candidate_count",
  "match_count",
  "ocr_rows",
  "sidebar_row_count",
  "unread_count",
  "visible_row_count"
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

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function expertDocuments(store) {
  const expert = store?.read?.();
  const expertRules = String(expert?.expertRules?.text || "").trim();
  const businessKnowledge = String(expert?.businessKnowledge?.text || "").trim();
  if (expert?.ready !== true || !expertRules || !businessKnowledge) {
    throw codedError("AI_EXPERT_NOT_READY", "请先在 AI专家 中补齐专家规则和业务知识");
  }
  return { expertRules, businessKnowledge };
}

function replyLooksLikeAnotherQuestion(reply) {
  return /[?？]/u.test(reply)
    || /(?:请问|请提供|请说明|能否|是否|哪(?:个|些|种)?|什么|多少|如何|有没有|需要.{0,10}吗|方便.{0,10}吗)/u.test(reply);
}

function normalizeAutoReplyDecision(value, { clarificationAllowed = true } = {}) {
  const action = normalizeText(value?.action).toLowerCase();
  const reasonCode = normalizeText(value?.reasonCode).toLowerCase();
  const reply = normalizeText(value?.reply);
  if (!AUTO_REPLY_ACTIONS.has(action) || !AUTO_REPLY_REASON_CODES.has(reasonCode)) {
    throw codedError("AI_DECISION_INVALID", "DeepSeek 返回的自动回复动作无效");
  }
  if (action === "silent") {
    if (reply) throw codedError("AI_DECISION_INVALID", "DeepSeek 静默动作不应包含回复内容");
    return { action, reply: "", reasonCode };
  }
  if (!isSafeReplyText(reply)) throw codedError("AI_REPLY_UNSAFE", "DeepSeek 返回的回复未通过安全检查");
  if (action === "clarify" && !clarificationAllowed) {
    if (replyLooksLikeAnotherQuestion(reply)) {
      throw codedError("AI_CLARIFY_LIMIT_EXCEEDED", "DeepSeek 在已澄清一次后仍要求继续追问");
    }
    return { action: "answer", reply, reasonCode: "general_guidance" };
  }
  return { action, reply, reasonCode };
}

function systemErrorCategory(code) {
  if (["API_KEY_MISSING", "API_KEY_UNREADABLE", "API_KEY_INVALID", "SECURE_STORAGE_UNAVAILABLE", "AI_EXPERT_NOT_READY"].includes(code)) return "configuration";
  if (code === "AI_NETWORK_ERROR") return "network";
  if (code === "AI_REQUEST_TIMEOUT") return "timeout";
  if (code === "AI_RATE_LIMITED") return "rate_limit";
  if (code === "AI_BALANCE_INSUFFICIENT") return "billing";
  if (code === "AI_CONTENT_FILTERED") return "filtered_content";
  if (code.startsWith("AI_RESPONSE_") || code === "AI_DECISION_INVALID" || code === "AI_REPLY_UNSAFE" || code === "AI_CLARIFY_LIMIT_EXCEEDED") return "invalid_response";
  return "model";
}

function sanitizeSystemError(error) {
  const code = normalizeAiWarningCode(error?.code) || "AI_REQUEST_FAILED";
  const detailCode = diagnosticCode(error?.diagnosticCode, "");
  const messages = {
    API_KEY_MISSING: "DeepSeek API Key 未配置，请保存后重新启动自动回复。",
    API_KEY_UNREADABLE: "DeepSeek API Key 无法读取，请重新保存后启动。",
    API_KEY_INVALID: "DeepSeek API Key 无效或已失效，请检查后重新启动。",
    SECURE_STORAGE_UNAVAILABLE: "当前 Windows 加密存储不可用，请修复后重新启动。",
    AI_NETWORK_ERROR: "无法连接 DeepSeek，请检查网络后重新启动自动回复。",
    AI_REQUEST_TIMEOUT: "DeepSeek 请求超时，请检查网络后重新启动自动回复。",
    AI_RATE_LIMITED: "DeepSeek 请求过于频繁，请稍后重新启动自动回复。",
    AI_BALANCE_INSUFFICIENT: "DeepSeek 账户余额不足，请处理后重新启动自动回复。",
    AI_CONTENT_FILTERED: "DeepSeek 本次输出被内容策略拦截，请调整资料或问题后重新启动。",
    AI_RESPONSE_EMPTY: "DeepSeek 返回空内容，自动回复已暂停。",
    AI_RESPONSE_INVALID: "DeepSeek 返回格式无效，自动回复已暂停。",
    AI_RESPONSE_LENGTH_INVALID: "DeepSeek 返回内容长度不符合要求，自动回复已暂停。",
    AI_RESPONSE_TRUNCATED: "DeepSeek 返回内容被截断，自动回复已暂停。",
    AI_RESPONSE_INCOMPLETE: "DeepSeek 本次生成未完整结束，自动回复已暂停。",
    AI_DECISION_INVALID: "DeepSeek 返回的业务动作无效，自动回复已暂停。",
    AI_REPLY_UNSAFE: "DeepSeek 返回的回复未通过安全检查，客户消息未发送。",
    AI_CLARIFY_LIMIT_EXCEEDED: "AI 已追问过一次但仍试图继续追问，自动回复已暂停。"
  };
  const detailMessages = {
    content_json_invalid: "DeepSeek 返回内容不是有效 JSON",
    decision_fields_invalid: "DeepSeek 返回的 JSON 缺少 action、reply 或 reasonCode",
    action_reason_invalid: "DeepSeek 返回的动作与原因不匹配",
    clarify_not_allowed: "AI 已经澄清过一次但仍要求继续追问",
    silent_reply_nonempty: "DeepSeek 的静默动作包含了回复内容",
    reply_empty: "DeepSeek 未生成可发送的回复",
    reply_length_invalid: "DeepSeek 回复长度不符合发送要求",
    reply_sanitized_empty: "DeepSeek 回复经过安全清理后为空",
    response_envelope_invalid: "DeepSeek 返回的数据缺少有效生成结果",
    response_message_invalid: "DeepSeek 返回的数据结构不完整",
    response_content_type_invalid: "DeepSeek 返回内容类型无效",
    response_truncated: "DeepSeek 返回内容被截断",
    response_incomplete: "DeepSeek 本次生成未完整结束",
    content_empty: "DeepSeek 返回空内容"
  };
  const message = detailMessages[detailCode] && code.startsWith("AI_RESPONSE_")
    ? `${detailMessages[detailCode]}，自动回复已暂停。`
    : messages[code] || "DeepSeek 请求失败，客户消息未发送；请检查配置后重新启动自动回复。";
  return {
    code,
    category: systemErrorCategory(code),
    message
  };
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

function diagnosticCode(value, fallback = "unknown") {
  const code = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.:-]{0,80}$/.test(code) ? code : fallback;
}

function sendDiagnosticReason(value) {
  const raw = normalizeText(value).toLowerCase();
  if (KNOWN_SEND_DIAGNOSTIC_REASONS.has(raw)) return { code: raw, ref: "" };
  return {
    code: "unknown_send_reason",
    ref: crypto.createHash("sha256").update(raw || "missing_send_reason").digest("hex").slice(0, 12)
  };
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

function sanitizeMessageRead(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  if (MESSAGE_READ_SOURCES.has(value.source)) result.message_read_source = value.source;
  if (MESSAGE_READ_BOUNDARY_SOURCES.has(value.boundarySource)) result.boundary_source = value.boundarySource;
  for (const [source, target] of Object.entries({
    chatBottom: "chat_bottom",
    fullLineCount: "full_line_count",
    recoveredLineCount: "recovered_line_count",
    messageBlockCount: "message_block_count",
    incomingBatchCount: "incoming_batch_count",
    latestMessageTop: "latest_message_top"
  })) {
    const number = value[source];
    if (typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 10_000_000) result[target] = number;
  }
  if (typeof value.regionOcrOk === "boolean") result.region_ocr_ok = value.regionOcrOk;
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
    for (const [field, rawCount] of Object.entries(rawCounts)) {
      if (!STRUCTURED_SCAN_COUNT_FIELDS.has(field)) continue;
      const count = Number(rawCount);
      if (Number.isSafeInteger(count) && count >= 0 && count <= 10_000_000) counts[field] = count;
    }
    return Object.keys(counts).length ? counts : null;
  };
  const sanitizeDetail = (rawDetail, depth = 0) => {
    if (typeof rawDetail === "string") {
      const code = diagnosticCode(rawDetail, "");
      return STRUCTURED_SCAN_DETAIL_CODES.has(code) ? code : null;
    }
    if (!rawDetail || typeof rawDetail !== "object" || Array.isArray(rawDetail) || depth > 2) return null;
    const detail = {};
    for (const field of ["reason", "detail", "action", "phase"]) {
      const code = diagnosticCode(rawDetail[field], "");
      if (STRUCTURED_SCAN_DETAIL_CODES.has(code)) detail[field] = code;
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
  const scanMs = Math.floor(Number(source.timings?.scan_ms));
  if (Number.isSafeInteger(scanMs) && scanMs >= 0 && scanMs <= 300_000) result.scan_ms = scanMs;
  const captureMode = diagnosticCode(source.captureMode, "");
  if (SCAN_CAPTURE_MODES.has(captureMode)) result.capture_mode = captureMode;
  // Worker diagnostics are deliberately structural only. The visual sender
  // hashes stderr before it gets here; never put raw PowerShell text (which
  // can contain UI content) into the durable diagnostic trail.
  const rawWorker = source.worker && typeof source.worker === "object" && !Array.isArray(source.worker)
    ? source.worker
    : null;
  if (rawWorker) {
    const worker = {};
    const exitCode = Math.floor(Number(rawWorker.exit_code));
    if (Number.isSafeInteger(exitCode) && exitCode >= -2_147_483_648 && exitCode <= 2_147_483_647) worker.exit_code = exitCode;
    for (const field of ["timeout_ms", "elapsed_ms", "stdout_bytes", "stderr_bytes"]) {
      const value = Math.floor(Number(rawWorker[field]));
      if (Number.isSafeInteger(value) && value >= 0 && value <= 300_000_000) worker[field] = value;
    }
    for (const field of ["error_code", "termination_reason"]) {
      const value = diagnosticCode(rawWorker[field], "");
      if (value) worker[field] = value;
    }
    for (const field of ["kill_accepted", "grace_exceeded"]) {
      if (typeof rawWorker[field] === "boolean") worker[field] = rawWorker[field];
    }
    const stderrHash = String(rawWorker.stderr_sha256 || "").trim().toLowerCase();
    if (/^[a-f0-9]{64}$/u.test(stderrHash)) worker.stderr_sha256 = stderrHash;
    if (Object.keys(worker).length) result.worker = worker;
  }
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
    writeFileAtomic(file, validLines.length ? `${validLines.join("\n")}\n` : "", { encoding: "utf8" });
    return true;
  } catch {
    return false;
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

function testContactLabel(contact) {
  return normalizeText(contact?.remark)
    || normalizeText(contact?.nickname)
    || normalizeText(contact?.name)
    || "已同步联系人";
}

function testContactUniverse(activeTouchDir) {
  // Disabled contacts still participate in the global alias index. Otherwise a
  // selected contact could be promoted to a falsely unique name after its
  // colliding record is disabled in the contact table.
  return readContacts(activeTouchDir)
    .filter((contact) => !isSystemContact(contact));
}

function testContactIdCounts(contacts) {
  const counts = new Map();
  for (const contact of contacts) {
    const id = normalizeText(contact?.id);
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function uniqueAliasesForTestContact(contact, aliasIndex) {
  return [...aliasIndex.values()]
    .filter((entry) => entry.contacts.length === 1 && entry.contacts[0] === contact)
    .map((entry) => entry.alias)
    .filter(Boolean);
}

function testContactScopeLabel(contact, aliases) {
  const contactLabel = testContactLabel(contact);
  const uniqueAlias = aliases[0] || contactLabel;
  return contactLabel === uniqueAlias ? contactLabel : `${contactLabel}（会话：${uniqueAlias}）`;
}

function testContactScopeOptions(activeTouchDir) {
  const contactUniverse = testContactUniverse(activeTouchDir);
  const aliasIndex = contactAliasIndex(contactUniverse);
  const contactIdCounts = testContactIdCounts(contactUniverse);
  return contactUniverse.reduce((options, contact) => {
    const id = normalizeText(contact?.id);
    if (!id || contactIdCounts.get(id) !== 1 || !normalizeText(contact?.wechatAccountId) || contact.allowed === false) return options;
    const aliases = uniqueAliasesForTestContact(contact, aliasIndex);
    if (!aliases.length) return options;
    options.push({ id, label: testContactScopeLabel(contact, aliases) });
    return options;
  }, []);
}

function resolveTestContactScope(activeTouchDir, contactId) {
  const selectedContactId = normalizeText(contactId);
  if (!selectedContactId) {
    return { ok: false, code: "test_contact_required", error: "测试版请先选择一位已同步联系人" };
  }
  const contactUniverse = testContactUniverse(activeTouchDir);
  const matchingContacts = contactUniverse.filter((contact) => normalizeText(contact?.id) === selectedContactId);
  if (matchingContacts.length !== 1) {
    return { ok: false, code: "test_contact_id_ambiguous", error: "所选测试联系人身份不唯一，请重新同步后选择" };
  }
  const selected = matchingContacts[0];
  if (!normalizeText(selected?.wechatAccountId) || selected.allowed === false) {
    return { ok: false, code: "test_contact_invalid", error: "所选测试联系人已失效，请重新同步后选择" };
  }
  const aliases = uniqueAliasesForTestContact(selected, contactAliasIndex(contactUniverse));
  if (!aliases.length) {
    return { ok: false, code: "test_contact_alias_ambiguous", error: "所选测试联系人没有可唯一识别的会话名称" };
  }
  const binding = crypto.createHash("sha256")
    .update(JSON.stringify({
      id: selected.id,
      account: normalizeText(selected.wechatAccountId),
      wxid: normalizeText(selected.wxid),
      wechatId: normalizeText(selected.wechatId),
      name: normalizeText(selected.name),
      remark: normalizeText(selected.remark),
      nickname: normalizeText(selected.nickname),
      aliases: [...aliases].sort()
    }))
    .digest("hex");
  return {
    ok: true,
    scope: {
      binding,
      contact: selected,
      contactId: selected.id,
      contactLabel: testContactScopeLabel(selected, aliases),
      aliases,
      aliasKeys: new Set(aliases.map((alias) => compactConversationAlias(alias)).filter(Boolean))
    }
  };
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
  const accountIds = [...new Set((Array.isArray(contacts) ? contacts : [])
    .map((contact) => normalizeText(contact?.wechatAccountId))
    .filter(Boolean))];
  if (accountIds.length !== 1) return null;
  const visualIdentity = JSON.stringify([accountIds[0], compactConversationAlias(conversation)]);
  const identity = crypto.createHash("sha256").update(visualIdentity).digest("hex").slice(0, 24);
  return {
    id: `visual-inbound-${identity}`,
    wechatAccountId: accountIds[0],
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

function resolveWorkflowContactScope(activeTouchDir, recipients) {
  const universe = testContactUniverse(activeTouchDir);
  const aliasIndex = contactAliasIndex(universe);
  const idCounts = testContactIdCounts(universe);
  const contacts = [];
  const aliases = [];
  const aliasContacts = new Map();
  const ids = new Set();
  for (const frozen of recipients) {
    const id = normalizeText(frozen?.id);
    const contact = universe.find((item) => normalizeText(item?.id) === id);
    if (!id || ids.has(id) || idCounts.get(id) !== 1 || !contact
      || contact.allowed === false || contact.disabled === true || contact.active === false
      || !normalizeText(contact.wechatAccountId) || identityKey(contact) !== identityKey(frozen)) {
      return { ok: false, code: "workflow_recipient_changed", error: "接待名单中的联系人已变化，请重新选择" };
    }
    const uniqueAliases = uniqueAliasesForTestContact(contact, aliasIndex);
    if (!uniqueAliases.length) return { ok: false, code: "workflow_recipient_ambiguous", error: "接待联系人没有唯一可识别的会话名称，请检查备注" };
    ids.add(id);
    contacts.push(contact);
    for (const alias of uniqueAliases) {
      aliases.push(alias);
      aliasContacts.set(compactConversationAlias(alias), contact);
    }
  }
  const accounts = new Set(contacts.map((contact) => normalizeText(contact.wechatAccountId)));
  if (accounts.size !== 1) return { ok: false, code: "workflow_account_changed", error: "接待名单不属于同一微信账号" };
  return {
    ok: true,
    strict: true,
    scopeBinding: crypto.createHash("sha256").update(JSON.stringify(contacts.map(identityKey).sort())).digest("hex"),
    contacts,
    aliases,
    driverOptions: { exactConversationMatch: true, restoreChatSurface: true },
    resolveContact: (candidate) => {
      // An anonymous red-dot identity cannot authorize a scoped workflow reply.
      if (candidate?.messageDriven === true) return null;
      const conversation = normalizeText(candidate?.conversation || candidate?.currentConversation);
      const evidence = compactConversationAlias(candidate?.conversationEvidence);
      if (normalizeText(candidate?.visualMode) === "visual_render_v1"
        && (!evidence || evidence !== compactConversationAlias(conversation))) return null;
      return aliasContacts.get(compactConversationAlias(conversation)) || null;
    }
  };
}

function handoffReasonLabel(reasonCode) {
  return {
    explicit_human_request: "客户明确要求人工",
    transaction_commitment: "需要处理下单、合同或履约",
    after_sales_action: "需要处理退款、投诉或售后执行"
  }[reasonCode] || "需要人工跟进";
}

function handoffMetadata({ contactId, context, conversation, at }) {
  const key = crypto.createHash("sha256")
    .update(`${contactId}\n${context.map((item) => `${item.role}:${item.key || item.content}`).join("\n")}`)
    .digest("hex");
  return { key, contact_id: contactId, conversation, at: at.toISOString() };
}

function createAutoReplyController(options = {}) {
  const dataDir = String(options.dataDir || "");
  const activeTouchDir = String(options.activeTouchDir || "");
  const stateFile = path.join(dataDir, "auto-reply-state.json");
  const diagnosticLogFile = path.join(dataDir, "auto-reply-diagnostics.jsonl");
  const diagnosticRunId = crypto.randomBytes(8).toString("hex");
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
  let workflowHandled = false;
  let workflowProgress = null;
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
      prime: "正在建立消息读取基线", scanning: "正在检查客户消息",
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
      messageRead: result?.messageRead
    });
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
      retry_polls_remaining: 100
    })) {
      const numeric = Math.floor(Number(details[field]));
      if (Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= maximum) entry[field] = numeric;
    }
    const deliveryAttempt = Math.floor(Number(details.delivery_attempt));
    if (Number.isSafeInteger(deliveryAttempt) && deliveryAttempt >= 1 && deliveryAttempt <= 100) entry.delivery_attempt = deliveryAttempt;
    if (typeof details.send_attempted === "boolean") entry.send_attempted = details.send_attempted;
    if (typeof details.draft_phase_started === "boolean") entry.draft_phase_started = details.draft_phase_started;
    if (typeof details.composer_touched === "boolean") entry.composer_touched = details.composer_touched;
    Object.assign(entry, normalizeReceiptDiagnostics(details));
    const draftStage = diagnosticCode(details.draft_stage, "");
    if (draftStage) entry.draft_stage = draftStage;
    const incomingChangeKind = diagnosticCode(details.incoming_change_kind, "");
    if (new Set(["ocr_unresolved", "proven_different"]).has(incomingChangeKind)) entry.incoming_change_kind = incomingChangeKind;
    const sendResult = diagnosticCode(details.send_result, "");
    if (new Set(["not_attempted", "sent_verified", "outcome_unknown"]).has(sendResult)) entry.send_result = sendResult;
    const recoveryAction = diagnosticCode(details.recovery_action, "");
    if (RECOVERY_ACTIONS.has(recoveryAction)) entry.recovery_action = recoveryAction;
    const sendPhase = diagnosticCode(details.send_phase, "");
    if (sendPhase) entry.send_phase = sendPhase;
    const verificationMode = diagnosticCode(details.verification_mode, "");
    if (verificationMode) entry.verification_mode = verificationMode;
    if (code === "session_probe_unsupported") Object.assign(entry, sanitizeSessionProbe(details.sessionProbe));
    Object.assign(entry, sanitizeStructuredScanDiagnostics(details));
    appendDiagnosticLine(diagnosticLogFile, entry);
    const waitingDiagnostic = entry.code === USER_IDLE_WAIT_REASON
      || new Set(["scan_waiting", "reply_retry_enqueued", "reply_retry_waiting", "reply_manual_review_required"]).has(entry.event);
    const failedSendDiagnostic = entry.event === "reply_send_finished" && entry.code !== "sent_verified";
    diagnostics().event("auto_reply", entry.event, {
      ...entry,
      legacy_diagnostic_run_id: entry.run_id
    }, {
      level: waitingDiagnostic ? "warn" : /failed|exception|blocked/u.test(entry.event) || failedSendDiagnostic ? "error" : "info",
      code: entry.code || "",
      phase: entry.phase || "",
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
      return { ...scope, driverOptions: { ...scope.driverOptions, onProgress: workflowProgress } };
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
      return { ok: false, code: "test_contact_required", error: "测试版请先选择一位已同步联系人" };
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
    if (!contacts.length) return rejectedStart("没有可安全识别的已同步一对一联系人");
    const conversationAliases = contactScope.aliases;
    if (!conversationAliases.length) return rejectedStart("已同步联系人没有唯一可识别的会话名称");
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
      setActivity("listening", { detailCode: state.last_scan_reason || "started" });
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
      pauseWithError(refreshedScope.code || "test_contact_scope_invalid", refreshedScope.error || "测试联系人范围无法确认");
      appendDiagnostic("test_scope_invalid", { phase: "scope", code: refreshedScope.code || "test_contact_scope_invalid" });
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
      if (!isCurrentRun()) return publicState();
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
          pauseWithError(event, workflowMode ? "微信窗口已变化，请检查后重新启动任务" : "检测到微信窗口变化，已暂停测试自动回复，请重新选择测试联系人");
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
          pauseForSystemError(error, {
            traceId,
            durationMs: generationStartedAt === null ? undefined : Date.now() - generationStartedAt
          });
          saveBestEffort();
        }
        return publicState();
      }
      if (!isCurrentRun()) {
        retryGenerations.delete(fingerprint);
        state.processed[fingerprint].status = "cancelled";
        clearPendingObservation(candidate);
        save();
        return publicState();
      }
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
        messageDriven: candidate.messageDriven === true,
        onTransition: (transition) => {
          const delivery = diagnosticCode(transition, "");
          if (delivery === "prepared" && isVisualCandidate && state.processed[fingerprint]) {
            // `prepared` is emitted only after the visual sender has verified
            // the exact draft in WeChat. From this point a crash can leave an
            // externally visible draft, so retain the conservative restart
            // semantics for this one occurrence.
            state.processed[fingerprint].status = "sending";
            save();
          }
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
      const explicitOutcomeUnknown = normalizeText(result?.send_result) === "outcome_unknown"
        || result?.outcomeUnknown === true;
      const sendVerified = result?.ok === true && !explicitOutcomeUnknown;
      const sendTimings = result?.send_diagnostics?.timings || {};
      const sendWorker = result?.send_diagnostics?.worker;
      const sendReceipt = normalizeReceiptDiagnostics({ receipt: result?.send_diagnostics?.receipt });
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
        ...sendReceipt,
        pid: result?.pid || candidate.pid,
        hWnd: result?.hWnd || candidate.hWnd
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
          pauseWithError("send_outcome_unknown_paused", result?.blocked_reason || result?.error || "自动回复发送结果无法确认");
        } else {
          state.processed[fingerprint].status = "cancelled";
          clearPendingObservation(candidate);
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
              state.last_error = "";
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
    workflowStartPending = true;
    pause(reason);
    await waitForScanIdle();
    while (starting) await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true, state: publicState() };
  }

  async function runWorkflowStep(input = {}) {
    const enabled = typeof input.isEnabled === "function" ? input.isEnabled : () => false;
    if (workflowStepActive) return { handled: false, status: "busy" };
    if (!enabled()) return { handled: false, status: "paused" };
    workflowStepActive = true;
    workflowProgress = typeof input.onProgress === "function" ? input.onProgress : null;
    try {
      if (!workflowMode) {
        // Stop the legacy polling loop before the workflow becomes its sole
        // caller. Wait for any in-flight send to finish verification.
        pause("workflow_takeover");
        workflowMode = true;
        await waitForScanIdle();
        while (starting) await new Promise((resolve) => setTimeout(resolve, 10));
        discardTestScopeRuntimeState();
        scanIncoming.restoreTurnBoundaries?.(Object.values(state.reply_guards || {}).map((guard) => ({
          conversation: normalizeText(guard?.conversation),
          turnEpoch: Math.max(0, Math.floor(Number(guard?.turn_epoch) || 0)),
          runtimeId: normalizeText(guard?.incoming_runtime_id)
        })));
        primeRetryNeeded = true;
        workflowStartPending = true;
      }
      if (timer) cancelSchedule(timer);
      timer = null;
      workflowIsEnabled = () => enabled() === true;
      workflowRecipients = Array.isArray(input.recipients)
        ? input.recipients.map((contact) => ({ ...contact }))
        : [];
      if (!workflowRecipients.length) return { handled: false, status: "waiting" };
      const scope = resolveContactScope();
      if (!scope.ok) return { handled: false, status: "needs_attention", error: scope.error };
      const accountName = normalizeText(input.accountName);
      if (accountName && scope.contacts.some((contact) => normalizeText(contact.wechatAccountId) !== accountName)) {
        return { handled: false, status: "needs_attention", error: "接待名单与当前微信账号不一致，请重新同步" };
      }
      if (!enabled()) return { handled: false, status: "paused" };
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
        setActivity("listening", { contactLabel: `${scope.contacts.length} 位接待联系人`, detailCode: "workflow_started" });
        save();
      }
      if (state.status !== "running") {
        return { handled: false, status: "needs_attention", error: state.last_error || "自动回复已暂停，请检查后重新启动" };
      }
      workflowHandled = false;
      await runOnce();
      if (state.consecutive_scan_failures >= 3 && state.last_scan_reason.startsWith("wechat_chat_")) {
        pauseWithError("workflow_chat_navigation_failed", "无法返回聊天页面，尚未读取客户消息；请切回微信聊天页后重新启动");
      }
      return {
        handled: workflowHandled,
        ...(state.consecutive_scan_failures > 0 ? {
          progressText: state.last_scan_reason.startsWith("wechat_chat_")
            ? `返回聊天失败，尚未读取消息（${state.consecutive_scan_failures}/3）`
            : "本次读取消息失败，尚未回复"
        } : {}),
        status: !enabled() ? "paused" : state.status === "paused" ? "needs_attention" : "running",
        ...(enabled() && state.status === "paused" ? { error: state.last_error || "自动回复需要处理" } : {})
      };
    } catch (error) {
      return { handled: false, status: "needs_attention", error: String(error?.message || "自动回复启动失败") };
    } finally {
      workflowStepActive = false;
      workflowProgress = null;
    }
  }

  return { acknowledgeManualFollowup, pause, pauseWorkflow, resumeContact, runOnce, runWorkflowStep, start, status };
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
