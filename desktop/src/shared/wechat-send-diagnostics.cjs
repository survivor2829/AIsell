// Technical observations only. Never copy a conversation, message, snapshot or
// raw driver object into the diagnostic stream.
const { sanitizeVisualSendReceipt } = require("./visual-send-receipt.cjs");

function summarizeSendResult(result = {}) {
  const state = result?.state || {};
  const proof = result?.proofDiagnostics || result?.send_diagnostics || state.send_diagnostics || {};
  const detail = {};
  const blocked = result?.blocked_reason || state.blocked_reason;
  const reason = result?.primary_reason || result?.reason
    || (blocked === "outcome_unknown" ? state.real_send_reason || blocked : blocked || state.real_send_reason);
  for (const [key, value] of Object.entries({
    action: result?.action,
    reason,
    send_status: result?.send_result || state.real_send_status,
    verification_mode: result?.verificationMode || result?.verification_mode || state.post_send_verification_mode,
    input_read_reason: proof.input_read_reason
  })) {
    if (typeof value === "string" && /^[a-z][a-z0-9_.:-]{0,119}$/iu.test(value)) detail[key] = value;
  }
  for (const [key, value] of Object.entries({
    ok: result?.ok,
    send_attempted: result?.send_attempted ?? result?.sendAttempted,
    send_clicked: state.real_send_clicked,
    exact_match: result?.exactMatch ?? proof.exact_match,
    outgoing: result?.outgoing ?? proof.outgoing,
    is_latest: result?.isLatest ?? proof.is_latest,
    is_new: result?.isNew ?? proof.is_new,
    same_window: result?.sameWindow ?? proof.same_window,
    input_cleared: result?.draftConsumed ?? proof.input_cleared,
    before_exact: result?.snapshot?.draftExact ?? proof.before_exact,
    input_read_ok: proof.input_read_ok,
    input_empty: proof.input_empty,
    session_verified: result?.conversationVerified,
    composer_verified: result?.composerVerified,
    input_verified: result?.draftVerified
  })) {
    if (typeof value === "boolean") detail[key] = value;
  }
  // Explicit unknown wins over any historical nested state.
  if (result?.send_attempted === null || result?.sendAttempted === null) detail.send_attempted = null;
  for (const [key, value] of Object.entries({
    dpi: result?.dpi,
    window_width: result?.width,
    window_height: result?.height,
    candidate_count: proof.candidate_count,
    outgoing_exact_count: proof.outgoing_exact_count,
    previous_exact_count: proof.previous_exact_count,
    new_outgoing_exact_count: proof.new_outgoing_exact_count
  })) {
    if (Number.isFinite(value) && value >= 0) detail[key] = value;
  }
  const receipt = sanitizeVisualSendReceipt(result?.send_diagnostics?.receipt || result?.diagnostics?.receipt);
  if (receipt) for (const [key, value] of Object.entries(receipt)) detail[`receipt_${key}`] = value;
  return detail;
}

async function observeSendStage(options, stage, action) {
  const start = Date.now();
  const emit = (details) => {
    try { options?.onDiagnostic?.({ stage, ...details }); } catch { /* Logging cannot change a send decision. */ }
  };
  emit({ phase: "start" });
  try {
    const result = await action();
    try { emit({ phase: "finish", elapsed_ms: Date.now() - start, ...summarizeSendResult(result) }); } catch {}
    return result;
  } catch (error) {
    emit({ phase: "exception", ok: false, reason: "send_stage_exception", elapsed_ms: Date.now() - start,
      ...(typeof error?.code === "string" && /^[a-z0-9_.:-]{1,120}$/iu.test(error.code) ? { exception_code: error.code } : {}) });
    throw error;
  }
}

module.exports = { summarizeSendResult, observeSendStage };
