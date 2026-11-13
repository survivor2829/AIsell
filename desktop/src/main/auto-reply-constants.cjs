// Split out of auto-reply-ipc.cjs (2026-11-13), unchanged. See auto-reply-ipc.cjs for the controller.

const POLL_INTERVAL_MS = 5_000;

// A message whose chat title could not be read is answered only when WeChat recorded it this recently.
const UNRESOLVED_TITLE_RECENT_SECONDS = 30 * 60;

const UNREAD_SENDER_RECENT_SECONDS = 10 * 60;

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
  "visual_send_external_input_detected",
  "visual_send_before_send_failed"
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

module.exports = {
  POLL_INTERVAL_MS,
  UNRESOLVED_TITLE_RECENT_SECONDS,
  UNREAD_SENDER_RECENT_SECONDS,
  FAST_RECHECK_MS,
  AUTO_REPLY_STATE_VERSION,
  RATE_WINDOW_MS,
  GLOBAL_RATE_LIMIT,
  MAX_STATE_ENTRIES,
  SCAN_DEGRADED_AFTER,
  DIAGNOSTIC_LOG_MAX_BYTES,
  DIAGNOSTIC_LOG_MAX_LINES,
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
  MESSAGE_READ_SOURCES,
  MESSAGE_READ_BOUNDARY_SOURCES,
  SCAN_OBSERVATION_INTERVAL_MS,
  PENDING_OBSERVATION_REASONS,
  PENDING_OBSERVATION_MAX_AGE_MS,
  IN_FLIGHT_OBSERVATION_MAX_AGE_MS,
  FATAL_STARTUP_PRIME_REASONS,
  TERMINAL_PENDING_OBSERVATION_REASONS,
  STRICT_SCOPE_WINDOW_RESET_REASONS,
  KNOWN_SCAN_REASONS,
  KNOWN_SEND_DIAGNOSTIC_REASONS,
  STRUCTURED_SCAN_DETAIL_CODES,
  STRUCTURED_SCAN_COUNT_FIELDS,
  SYSTEM_IDS,
  SYSTEM_NAMES,
  SESSION_PROBE_FAILURES,
  SESSION_PROBE_NUMBER_FIELDS
};
