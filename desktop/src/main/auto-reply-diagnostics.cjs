// Split out of auto-reply-ipc.cjs (2026-11-13), unchanged. See auto-reply-ipc.cjs for the controller.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-file.cjs");
const { DIAGNOSTIC_LOG_MAX_BYTES, DIAGNOSTIC_LOG_MAX_LINES, SCAN_CAPTURE_MODES, MESSAGE_READ_SOURCES, MESSAGE_READ_BOUNDARY_SOURCES, KNOWN_SCAN_REASONS, KNOWN_SEND_DIAGNOSTIC_REASONS, STRUCTURED_SCAN_DETAIL_CODES, STRUCTURED_SCAN_COUNT_FIELDS, SESSION_PROBE_FAILURES, SESSION_PROBE_NUMBER_FIELDS } = require("./auto-reply-constants.cjs");
const { normalizeText } = require("./auto-reply-text.cjs");

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
    API_KEY_MISSING: "云端智能服务暂不可用，请稍后重新启动自动回复。",
    API_KEY_UNREADABLE: "云端智能服务暂不可用，请稍后重新启动自动回复。",
    API_KEY_INVALID: "云端智能服务暂不可用，请稍后重新启动自动回复。",
    PROVIDER_GATEWAY_UNAVAILABLE: "云端智能服务暂不可用，自动回复未启动，请稍后重试。",
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
  const header = source.headerRead;
  if (header && typeof header === "object") {
    if (["matched", "unresolved", "different", "selected_sidebar_row"].includes(header.state)) result.header_state = header.state;
    if (Number.isSafeInteger(header.candidateCount) && header.candidateCount >= 0 && header.candidateCount <= 1000) result.header_candidate_count = header.candidateCount;
    if (typeof header.recoveryAttempted === "boolean") result.header_recovery_attempted = header.recoveryAttempted;
    if (typeof header.recoveryOk === "boolean") result.header_recovery_ok = header.recoveryOk;
  }
  // Which header check stopped a scan, and whether WeChat's records named a sender for it.
  if (typeof source.headerSite === "string" && /^[a-z_0-9]{1,32}$/u.test(source.headerSite)) result.header_site = source.headerSite;
  if (typeof source.unreadSenderHinted === "boolean") result.unread_sender_hinted = source.unreadSenderHinted;
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
  const captureAttempts = Number(source.timings?.capture_attempts);
  if (Number.isSafeInteger(captureAttempts) && captureAttempts >= 0 && captureAttempts <= 20) result.capture_attempts = captureAttempts;
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

module.exports = {
  systemErrorCategory,
  sanitizeSystemError,
  diagnosticCode,
  sendDiagnosticReason,
  normalizeAiWarningCode,
  sanitizeSessionProbe,
  sanitizeMessageRead,
  sanitizeStructuredScanDiagnostics,
  scanReason,
  rotateDiagnosticLog,
  appendDiagnosticLine
};
