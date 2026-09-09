const STAGES = new Set(["bootstrap", "compile", "process", "enumerate", "select", "shell", "selected", "restore", "focus", "verify", "complete"]);
const MODES = new Set(["exact_hwnd", "render_child", "native_main", "shell_navigation"]);
const COUNTERS = ["elapsed_ms", "total_ms", "timeout_ms", "process_count", "native_count", "candidate_count", "main_count", "render_count", "hidden_count", "minimized_count", "rejected_layout_count",
  ...[...STAGES].map((stage) => `${stage}_ms`)];

// A fixed technical schema: no window captions, contacts, paths or raw stderr.
function sanitizeWechatWindowDiagnostics(source = {}) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const detail = {};
  if (STAGES.has(source.window_stage)) detail.window_stage = source.window_stage;
  if (MODES.has(source.window_detection_mode)) detail.window_detection_mode = source.window_detection_mode;
  if (typeof source.window_class_code === "string" && /^[a-z][a-z0-9_.:]{0,119}$/i.test(source.window_class_code)) detail.window_class_code = source.window_class_code;
  for (const suffix of COUNTERS) {
    const key = `window_${suffix}`, value = source[key];
    if (Number.isFinite(value) && value >= 0 && value <= 86_400_000) detail[key] = Math.round(value);
  }
  return detail;
}

function readWechatWindowDiagnostics(stderr, elapsedMs, timeoutMs) {
  let detail = { window_stage: "bootstrap" };
  for (const line of String(stderr || "").split(/\r?\n/)) {
    if (!line.startsWith("wechat_window_diagnostic:") || line.length > 4096) continue;
    try { detail = { ...detail, ...sanitizeWechatWindowDiagnostics(JSON.parse(line.slice("wechat_window_diagnostic:".length))) }; } catch {}
  }
  return sanitizeWechatWindowDiagnostics({ ...detail, window_total_ms: elapsedMs, window_timeout_ms: timeoutMs });
}

module.exports = { sanitizeWechatWindowDiagnostics, readWechatWindowDiagnostics };
