// Shared data-only contract: importing diagnostics from a preload must never
// load a WeChat driver, CLI entry point or execute any desktop operation.
const RECEIPT_TOKEN_VALUES = {
  stage: ["click", "window_lock", "draft_read", "bubble_read", "worker"],
  code: ["click_incomplete", "window_unavailable", "draft_consumed", "bubble_verified", "receipt_unconfirmed", "receipt_exception", "worker_failed", "worker_result_invalid", "frame_unavailable", "conversation_unresolved", "conversation_changed", "bubble_unresolved"],
  draft_read_stage: ["not_started", "input_lease_changed", "point_not_owned", "focus_failed", "select_failed", "copy_failed", "clipboard_failed", "empty", "nonempty"]
};

function sanitizeVisualSendReceipt(value) {
  if (!value || typeof value !== "object") return undefined;
  const receipt = {};
  for (const [field, allowed] of Object.entries(RECEIPT_TOKEN_VALUES)) {
    if (allowed.includes(value[field])) receipt[field] = value[field];
  }
  for (const field of ["conversation_verified", "draft_read_ok", "draft_consumed", "input_lease_valid", "bubble_verified"]) {
    if (typeof value[field] === "boolean") receipt[field] = value[field];
  }
  if (Number.isInteger(value.verification_attempts) && value.verification_attempts >= 0 && value.verification_attempts <= 4) {
    receipt.verification_attempts = value.verification_attempts;
  }
  return Object.keys(receipt).length ? receipt : undefined;
}

module.exports = { sanitizeVisualSendReceipt };
