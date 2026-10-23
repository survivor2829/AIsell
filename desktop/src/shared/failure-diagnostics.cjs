const TOKEN_FIELDS = ['rule_id', 'evidence_id', 'capture_status', 'redaction_mode', 'capture_failure_code', 'decision_scope',
  'context_exception_type', 'context_exception_code', 'capture_exception_type',
  'input_read_exception_type', 'input_read_exception_id', 'input_read_exception_hresult', 'input_read_exception_category',
  'driver_stage', 'driver_error_id', 'driver_exception_type', 'driver_exception_hresult', 'clipboard_operation'];
const IMAGE_STAGES = new Set(['sentinel_write', 'image_load', 'clipboard_bitmap', 'paste', 'read_back', 'preview_verification', 'click_send', 'post_confirm']);
function sanitizeImageObservation(value = {}) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  if (['bitmap', 'file_drop', 'text', 'other', 'empty'].includes(value.clipboard_format_kind)) result.clipboard_format_kind = value.clipboard_format_kind;
  if (typeof value.clipboard_sequence_changed === 'boolean') result.clipboard_sequence_changed = value.clipboard_sequence_changed;
  if (['verified', 'fallback'].includes(value.input_point_source)) result.input_point_source = value.input_point_source;
  for (const key of ['input_x_ratio', 'input_y_ratio']) {
    if (Number.isFinite(value[key]) && value[key] > 0 && value[key] < 1) result[key] = value[key];
  }
  return result;
}
function sanitizeImageProgress(entry) {
  if (!entry || !IMAGE_STAGES.has(entry.stage) || !['start', 'finish'].includes(entry.status)) return null;
  const result = { stage: entry.stage, status: entry.status, ...sanitizeImageObservation(entry) };
  for (const key of ['elapsed_ms', 'observed_elapsed_ms', 'clipboard_write_attempts', 'clipboard_read_attempts', 'retry_index']) {
    if (Number.isSafeInteger(entry[key]) && entry[key] >= 0 && entry[key] <= 86400000) result[key] = entry[key];
  }
  return result;
}
function sanitizeFailureDiagnostics(value = {}) {
  const result = sanitizeImageObservation(value);
  for (const key of TOKEN_FIELDS) {
    if (typeof value?.[key] === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,119}$/i.test(value[key])
      && !/(?<![a-z0-9])(?:(?:sk|ak)[-_][a-z0-9_-]{6,}|ltai[a-z0-9]{8,})/i.test(value[key])) result[key] = value[key];
  }
  for (const key of ['window_width', 'window_height', 'candidate_count', 'visual_candidate_count', 'clipboard_write_attempts', 'error_line', 'script_line', 'source_line']) {
    if (Number.isSafeInteger(value?.[key]) && value[key] >= 0 && value[key] <= 86400000) result[key] = value[key];
  }
  if (typeof value?.ocr_ok === 'boolean') result.ocr_ok = value.ocr_ok;
  if (Array.isArray(value?.image_progress)) {
    result.image_progress = value.image_progress.slice(-40).map(sanitizeImageProgress).filter(Boolean);
  }
  for (const key of ['retry_count']) if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) result[key] = value[key];
  if (typeof value?.image_progress_lost === 'boolean') result.image_progress_lost = value.image_progress_lost;
  if (typeof value?.image_send_attempted === 'boolean') result.image_send_attempted = value.image_send_attempted;
  if (typeof value?.source_file === 'string' && /^[A-Za-z0-9_./-]{1,160}$/.test(value.source_file)) result.source_file = value.source_file;
  if (Array.isArray(value?.image_preload)) result.image_preload = value.image_preload.slice(-20).filter(entry => /^[a-z_]{1,80}$/.test(entry?.marker || '')).map(entry => ({ marker: entry.marker, ...(Number.isInteger(entry.elapsed_ms) ? { elapsed_ms: entry.elapsed_ms } : {}) }));
  return result;
}
module.exports = { sanitizeFailureDiagnostics, sanitizeImageProgress, sanitizeImageObservation };
