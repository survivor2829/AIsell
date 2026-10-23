// Local internal evidence keeps business context, but never credentials. This
// serializer is deliberately separate from the public/telemetry allowlist.
const SECRET_KEY = /(?:api.?key|secret|token|password|passwd|authorization|authentication|credential|cookie|(?:private|session|client|access|provider|deepseek|volcengine|ark|license|encryption).?key|signature|^auth$|^key$)/iu;
const SECRET_ASSIGNMENT = /((?:["']?(?:[a-z0-9_.-]{0,128}(?:key|token|password|passwd|secret|authorization|authentication|credential|cookie|signature)|auth)["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}&\r\n]+)/giu;

function scrubSecretText(value) {
  return String(value ?? "")
    .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|CREDENTIAL)[^-]*-----[\s\S]*?(?:-----END [^-]+-----|$)/gu, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:Bearer|Basic)\s+[a-z0-9+/_=.-]+/giu, "[REDACTED_AUTH]")
    .replace(/\b(?:set-cookie|cookie)\s*:\s*[^\r\n]*/giu, "Cookie: [REDACTED]")
    .replace(/(?<![a-z0-9])(?:(?:sk|ak)[-_][a-z0-9_-]{6,}|ltai[a-z0-9]{8,})/giu, "[REDACTED_KEY]")
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/giu, "[REDACTED_TOKEN]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[REDACTED_AUTH]@")
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]");
}

function internalDiagnosticsEnabled(appInfo = {}) {
  return appInfo?.data_profile === "test" || appInfo?.edition === "development";
}

function scrubInternalDetails(input, options = {}) {
  const limits = { maxBytes: 256 * 1024, maxString: 64 * 1024, maxDepth: 12,
    maxArray: 512, maxKeys: 256, maxNodes: 6000, ...options };
  const seen = new WeakSet();
  const truncation = [];
  let omittedMarkers = 0;
  let redactedFields = 0;
  let remainingBytes = limits.maxBytes;
  let remainingNodes = limits.maxNodes;
  const note = (location, reason, omitted) => {
    if (truncation.length < 100) truncation.push({ path: location.slice(0, 512), reason, ...(omitted === undefined ? {} : { omitted }) });
    else omittedMarkers += 1;
  };
  const text = (value, location) => {
    let source = String(value);
    // Bound work on pathological payloads before regex matching. Open PEM and
    // credential assignments are also redacted when their suffix was cut off.
    if (source.length > 1024 * 1024) {
      note(location, "input_string_limit", source.length - 1024 * 1024);
      source = source.slice(0, 1024 * 1024);
    }
    let result = scrubSecretText(source);
    if (result.length > limits.maxString) {
      note(location, "string_limit", result.length - limits.maxString);
      result = result.slice(0, limits.maxString);
    }
    let bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    if (bytes > remainingBytes) {
      note(location, "byte_limit");
      // Six bytes per UTF-16 unit covers JSON escaping as well as UTF-8.
      result = result.slice(0, Math.max(0, Math.floor((remainingBytes - 2) / 6)));
      bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    }
    remainingBytes -= bytes;
    return result;
  };
  const visit = (value, location, depth) => {
    if (remainingNodes-- <= 0 || remainingBytes < 32) {
      note(location, remainingNodes < 0 ? "node_limit" : "byte_limit");
      return "[TRUNCATED]";
    }
    remainingBytes -= 16;
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === "string") return text(value, location);
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value === "bigint") return text(value.toString(), location);
    if (typeof value !== "object") return `[${typeof value}]`;
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return { binary_bytes: value.byteLength, omitted: "binary_payload" };
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "invalid_date" : value.toISOString();
    if (depth >= limits.maxDepth) { note(location, "depth_limit"); return "[TRUNCATED]"; }
    if (seen.has(value)) { note(location, "circular_reference"); return "[CIRCULAR]"; }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const result = [];
        for (let index = 0; index < value.length && index < limits.maxArray && remainingNodes > 0 && remainingBytes >= 32; index += 1) {
          result.push(visit(value[index], `${location}[${index}]`, depth + 1));
        }
        if (result.length < value.length) note(location, "array_limit", value.length - result.length);
        return result;
      }
      const result = {};
      // Error properties are non-enumerable: preserve the actual exception and
      // nested cause, including native errno/syscall and aggregate failures.
      const keys = value instanceof Error
        ? [...new Set(["name", "message", "stack", "cause", "code", "errno", "syscall", "errors", ...Object.keys(value)])]
        : Object.keys(value);
      const priority = ["operation_context", "error", "raw_exception", "code", "reason", "blocked_reason", "stage", "phase", "trace_id", "task_id"];
      keys.sort((left, right) => (priority.includes(left) ? priority.indexOf(left) : priority.length)
        - (priority.includes(right) ? priority.indexOf(right) : priority.length));
      let visited = 0;
      for (const key of keys) {
        if (visited >= limits.maxKeys || remainingNodes <= 0 || remainingBytes < 32) break;
        visited += 1;
        const safeKey = text(key, `${location}.[key]`);
        if (SECRET_KEY.test(key)) { Object.defineProperty(result, safeKey, { value: "[REDACTED]", enumerable: true, configurable: true }); redactedFields += 1; continue; }
        let child;
        try { child = value[key]; } catch { child = "[UNREADABLE]"; note(`${location}.${safeKey}`, "getter_failed"); }
        if (child === undefined || typeof child === "function") continue;
        Object.defineProperty(result, safeKey, { value: visit(child, `${location}.${safeKey}`, depth + 1), enumerable: true, configurable: true });
      }
      if (visited < keys.length) note(location, "object_limit", keys.length - visited);
      return result;
    } finally { seen.delete(value); }
  };
  let value;
  try { value = visit(input, "$", 0); }
  catch (error) { value = "[UNREADABLE]"; note("$", "serialization_failed"); }
  return { value, ...(truncation.length ? { truncation, omitted_truncation_markers: omittedMarkers } : {}), redacted_fields: redactedFields };
}

module.exports = { internalDiagnosticsEnabled, scrubInternalDetails, scrubSecretText };
