const TOKEN_FIELDS = ['rule_id', 'evidence_id', 'capture_status', 'redaction_mode', 'capture_failure_code', 'decision_scope',
  'context_exception_type', 'context_exception_code', 'capture_exception_type',
  'input_read_exception_type', 'input_read_exception_id', 'input_read_exception_hresult', 'input_read_exception_category',
  'driver_stage', 'driver_error_id', 'driver_exception_type', 'driver_exception_hresult', 'clipboard_operation'];
function sanitizeFailureDiagnostics(value = {}) {
  const result = {};
  for (const key of TOKEN_FIELDS) {
    if (typeof value?.[key] === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,119}$/i.test(value[key])
      && !/(?<![a-z0-9])(?:(?:sk|ak)[-_][a-z0-9_-]{6,}|ltai[a-z0-9]{8,})/i.test(value[key])) result[key] = value[key];
  }
  for (const key of ['window_width', 'window_height', 'candidate_count', 'visual_candidate_count', 'clipboard_write_attempts', 'error_line']) {
    if (Number.isSafeInteger(value?.[key]) && value[key] >= 0 && value[key] <= 86400000) result[key] = value[key];
  }
  if (typeof value?.ocr_ok === 'boolean') result.ocr_ok = value.ocr_ok;
  if (Array.isArray(value?.image_progress)) {
    const stages = new Set(['sentinel_write', 'image_load', 'clipboard_bitmap', 'paste', 'read_back', 'click_send', 'post_confirm']);
    result.image_progress = value.image_progress.slice(-40).filter(entry => stages.has(entry?.stage) && ['start', 'finish'].includes(entry?.status)).map(entry => ({
      stage: entry.stage, status: entry.status,
      ...(Number.isSafeInteger(entry.elapsed_ms) && entry.elapsed_ms >= 0 ? { elapsed_ms: entry.elapsed_ms } : {}),
      ...(Number.isSafeInteger(entry.observed_elapsed_ms) && entry.observed_elapsed_ms >= 0 ? { observed_elapsed_ms: entry.observed_elapsed_ms } : {}),
      ...(Number.isSafeInteger(entry.clipboard_write_attempts) && entry.clipboard_write_attempts >= 0 ? { clipboard_write_attempts: entry.clipboard_write_attempts } : {}),
      ...(Number.isSafeInteger(entry.clipboard_read_attempts) && entry.clipboard_read_attempts >= 0 ? { clipboard_read_attempts: entry.clipboard_read_attempts } : {}),
      ...(Number.isSafeInteger(entry.retry_index) && entry.retry_index >= 0 ? { retry_index: entry.retry_index } : {})
    }));
  }
  for (const key of ['retry_count']) if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) result[key] = value[key];
  if (typeof value?.image_progress_lost === 'boolean') result.image_progress_lost = value.image_progress_lost;
  return result;
}
module.exports = { sanitizeFailureDiagnostics };
