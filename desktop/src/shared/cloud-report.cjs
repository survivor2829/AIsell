// Application-owned additions keep diagnostic evolution compatible with the
// installed update base. The base validator still owns report identity/privacy.
const { reportEntry: baseReportEntry, token } = require("./cloud-contract.cjs");
const { sanitizeWechatWindowDiagnostics } = require("./wechat-window-diagnostics.cjs");

function reportEntry(entry, context) {
  const result = baseReportEntry(entry, context);
  if (!result) return null;
  for (const key of ["action", "task_kind", "reason", "send_status", "verification_mode", "input_read_reason", "exception_code", "wechat_version", "parent_trace_code"]) {
    const value = token(entry.details?.[key]);
    if (value) result.details[key] = value;
  }
  for (const key of ["ok", "send_attempted", "send_clicked", "exact_match", "outgoing", "is_latest", "is_new", "same_window", "input_cleared", "before_exact", "input_read_ok", "input_empty", "session_verified", "composer_verified", "input_verified", "restart_requested", "had_running_process", "stop_verified", "launch_deferred", "handled", "busy", "reply_enabled"]) {
    if (typeof entry.details?.[key] === "boolean") result.details[key] = entry.details[key];
  }
  if (entry.details?.send_attempted === null) result.details.send_attempted = null;
  for (const key of ["elapsed_ms", "duration_ms", "current_index", "done", "total", "pending_count", "process_count", "dpi", "window_width", "window_height", "candidate_count", "outgoing_exact_count", "previous_exact_count", "new_outgoing_exact_count", "receipt_verification_attempts"]) {
    const value = entry.details?.[key];
    if (Number.isFinite(value) && value >= 0 && value <= 86400000) result.details[key] = Math.round(value);
  }
  Object.assign(result.details, sanitizeWechatWindowDiagnostics(entry.details));
  return result;
}

module.exports = { reportEntry };
