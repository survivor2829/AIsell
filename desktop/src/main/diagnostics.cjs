const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { replaceWithRetry, writeJsonAtomic } = require("./atomic-file.cjs");

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ARCHIVES = 5;
const MAX_DEPTH = 4;
const MAX_ARRAY = 20;
const MAX_OBJECT_KEYS = 40;
const MAX_STRING = 800;
const MAX_DETAILS_BYTES = 4 * 1024;
const MAX_SANITIZE_NODES = 160;
const MAX_SUMMARY_INPUT = MAX_STRING;
const MAX_DEDUPE_MODULES = 64;
const ACTIONABLE_LEVELS = new Set(["warn", "error", "fatal"]);
const SECRET_PATTERN = /(?<![a-z0-9])(?:(?:sk|ak)[-_][a-z0-9_-]{6,}|ltai[a-z0-9]{8,})/giu;
const SECRET_LIKE_PATTERN = /(?<![a-z0-9])(?:(?:sk|ak)[-_][a-z0-9_-]{6,}|ltai[a-z0-9]{8,})/iu;
const LOCATION_PATTERN = /(?:https?:\/\/|file:\/\/|\\\\|[a-z]:[\\/]|\/(?:users|home|var|tmp|etc|opt)\/)/iu;
const SAFE_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,119}$/iu;
const SAFE_DETAIL_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/iu;
const SAFE_DETAIL_STRING_KEYS = /^(?:(?:.*_)?(?:action|arch|code|engine|extension|kind|mode|phase|platform|provider|reason|release|stage|state|status|type|version|zone))$/iu;
const SENSITIVE_KEYS = /(?:api.?key|secret|token|password|clipboard|prompt|expert|message|content|script|draft|contact.?(?:name|id)|(?:user|account|customer).?id|phone|mobile|nickname|remark|wechat.?id|wxid|conversation(?:.?title|.?name)?|ocr.?text|raw.?text|recognized.?text|^(?:error|description|stack|url|uri|host)$)/iu;
const PATH_KEYS = /(?:path|dir|file|cwd|executable)/iu;

let activeLogger = null;

function code(value, fallback = "") {
  const candidate = String(value ?? "").trim();
  if (
    !candidate
    || SECRET_LIKE_PATTERN.test(candidate)
    || LOCATION_PATTERN.test(candidate)
    || !SAFE_IDENTIFIER_PATTERN.test(candidate)
  ) return fallback;
  return candidate.toLowerCase();
}

function scrubSecrets(value) {
  return String(value ?? "").replace(SECRET_PATTERN, "[REDACTED_KEY]");
}

function digest(value, salt = "") {
  return crypto.createHash("sha256").update(`${salt}\n${String(value ?? "")}`).digest("hex").slice(0, 16);
}

function summarizeSensitive(value, salt) {
  const raw = typeof value === "string" ? value : String(value ?? "");
  const sample = scrubSecrets(raw.slice(0, MAX_SUMMARY_INPUT));
  return {
    present: Boolean(raw),
    length: raw.length,
    sha256_16: raw ? digest(`${raw.length}:${sample}`, salt) : "",
    truncated: raw.length > MAX_SUMMARY_INPUT || undefined
  };
}

function sanitizeValue(value, context = {}) {
  const { depth = 0, key = "", salt = "" } = context;
  const budget = context.budget || { remainingNodes: MAX_SANITIZE_NODES };
  if (budget.remainingNodes <= 0) return "[BUDGET_EXCEEDED]";
  budget.remainingNodes -= 1;
  const protectedKey = SENSITIVE_KEYS.test(key) || PATH_KEYS.test(key);
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (protectedKey) return summarizeSensitive(value, salt);
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") {
    if (protectedKey) return summarizeSensitive(value, salt);
    return String(value);
  }
  if (value instanceof Error) return sanitizeError(value, salt);
  if (typeof value === "string") {
    if (value.length > MAX_STRING) return summarizeSensitive(value, salt);
    const text = scrubSecrets(value);
    if (
      protectedKey
      || SECRET_LIKE_PATTERN.test(value)
      || LOCATION_PATTERN.test(value)
      || !SAFE_DETAIL_STRING_KEYS.test(key)
      || !SAFE_IDENTIFIER_PATTERN.test(text)
    ) return summarizeSensitive(value, salt);
    return text.slice(0, MAX_STRING);
  }
  if (depth >= MAX_DEPTH) return "[MAX_DEPTH]";
  if (Array.isArray(value)) {
    const result = [];
    for (let index = 0; index < value.length && index < MAX_ARRAY && budget.remainingNodes > 0; index += 1) {
      result.push(sanitizeValue(value[index], { depth: depth + 1, key, salt, budget }));
    }
    return result;
  }
  if (typeof value === "object") {
    const result = {};
    let acceptedKeys = 0;
    for (const childKey in value) {
      if (!Object.prototype.hasOwnProperty.call(value, childKey)) continue;
      if (acceptedKeys >= MAX_OBJECT_KEYS || budget.remainingNodes <= 0) break;
      if (
        !SAFE_DETAIL_KEY_PATTERN.test(childKey)
        || (SENSITIVE_KEYS.test(childKey) && childKey.toLowerCase() !== "error")
        || SECRET_LIKE_PATTERN.test(childKey)
        || LOCATION_PATTERN.test(childKey)
      ) continue;
      let childValue;
      try {
        childValue = value[childKey];
      } catch {
        result[childKey] = "[UNREADABLE]";
        acceptedKeys += 1;
        continue;
      }
      if (childValue === undefined || typeof childValue === "function") continue;
      result[childKey] = sanitizeValue(childValue, { depth: depth + 1, key: childKey, salt, budget });
      acceptedKeys += 1;
    }
    return result;
  }
  return String(value);
}

function sanitizeError(error, salt = "") {
  try {
    const supplied = error instanceof Error ? error : new Error(String(error ?? "unknown_error"));
    const message = String(supplied.message || "unknown_error");
    const summary = summarizeSensitive(message, salt);
    return {
      name: code(supplied.name, "error"),
      code: code(supplied.code, "unknown_error"),
      message_length: summary.length,
      message_ref: summary.sha256_16
    };
  } catch {
    return {
      name: "error",
      code: "unknown_error",
      message_length: 0,
      message_ref: digest("unreadable_error", salt)
    };
  }
}

function boundedDetails(details, salt) {
  try {
    const sanitized = sanitizeValue(details, { salt });
    const serialized = JSON.stringify(sanitized);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes <= MAX_DETAILS_BYTES) return sanitized;
    return {
      truncated: true,
      original_bytes: bytes,
      details_ref: digest(serialized, salt)
    };
  } catch {
    return { unavailable: true };
  }
}

function rotate(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size < MAX_BYTES) return;
  for (let index = MAX_ARCHIVES; index >= 1; index -= 1) {
    const source = index === 1 ? file : `${file}.${index - 1}`;
    const destination = `${file}.${index}`;
    if (!fs.existsSync(source)) continue;
    if (index === MAX_ARCHIVES) fs.rmSync(destination, { force: true });
    replaceWithRetry(source, destination);
  }
}

function readRecent(file, limit = 100) {
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(500, Number(limit) || 100)))
      .map((line) => JSON.parse(line))
      .reverse();
  } catch {
    return [];
  }
}

function createDiagnosticLogger({ rootDir, appInfo = {}, clock = () => new Date() } = {}) {
  const logsDir = path.join(String(rootDir || ""), "logs");
  const logFile = path.join(logsDir, "diagnostics.jsonl");
  const installFile = path.join(logsDir, "install-id");
  fs.mkdirSync(logsDir, { recursive: true });
  let installId = "";
  try {
    installId = fs.readFileSync(installFile, "utf8").trim();
  } catch {}
  if (!/^[a-f0-9-]{16,64}$/i.test(installId)) {
    installId = crypto.randomUUID();
    fs.writeFileSync(installFile, installId, "utf8");
  }
  const runId = crypto.randomUUID();
  const salt = digest(installId);
  let sequence = 0;
  let writesFailed = 0;
  let environmentSnapshot = {};
  const lastFaultByModule = new Map();

  function recover(moduleName) {
    try {
      lastFaultByModule.delete(code(moduleName, "app"));
    } catch {}
  }

  function rememberFault(moduleName, signature) {
    lastFaultByModule.delete(moduleName);
    lastFaultByModule.set(moduleName, signature);
    if (lastFaultByModule.size > MAX_DEDUPE_MODULES) {
      lastFaultByModule.delete(lastFaultByModule.keys().next().value);
    }
  }

  function event(moduleName, eventName, details = {}, options = {}) {
    try {
      const requestedLevel = code(options?.level, "info");
      const level = requestedLevel === "warning" ? "warn" : requestedLevel;
      const module = code(moduleName, "app");
      const eventCode = code(eventName, "event");
      if (options?.cancelled === true) {
        recover(module);
        return null;
      }
      if (!ACTIONABLE_LEVELS.has(level)) {
        const recoveryRequested = (
          options?.recover === true
          || eventCode === "responsive"
          || eventCode.endsWith(".finished")
          || eventCode.endsWith(".recovered")
        );
        const previousFault = recoveryRequested ? lastFaultByModule.get(module) : "";
        if (recoveryRequested) recover(module);
        if (previousFault) {
          const [recoveredEvent = "", recoveredCode = ""] = previousFault.split("\u0000");
          const entry = {
            v: 1,
            ts: clock().toISOString(),
            run_id: runId,
            seq: sequence + 1,
            level: "info",
            module,
            event: eventCode,
            code: "recovered",
            phase: code(options?.phase || details?.phase, "recover"),
            details: boundedDetails({
              ...details,
              recovered_event: recoveredEvent,
              recovered_code: recoveredCode
            }, salt)
          };
          rotate(logFile);
          fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, "utf8");
          sequence += 1;
          return entry;
        }
        return null;
      }
      const errorCode = code(
        options?.code || details?.blocked_reason || details?.code || details?.reason,
        "unknown_error"
      );
      const dedupeKey = code(options?.dedupeKey, "");
      const faultSignature = `${eventCode}\u0000${errorCode}\u0000${level}\u0000${dedupeKey}`;
      if (lastFaultByModule.get(module) === faultSignature) return null;
      const duration = Number(options?.durationMs);
      const entry = {
        v: 1,
        ts: clock().toISOString(),
        run_id: runId,
        seq: sequence + 1,
        level,
        module,
        event: eventCode,
        trace_id: code(options?.traceId, ""),
        phase: code(options?.phase || details?.phase, ""),
        code: errorCode,
        duration_ms: Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : undefined,
        details: boundedDetails(details, salt)
      };
      for (const key of Object.keys(entry)) {
        if (entry[key] === "" || entry[key] === undefined) delete entry[key];
      }
      rotate(logFile);
      fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, "utf8");
      sequence += 1;
      rememberFault(module, faultSignature);
      return entry;
    } catch {
      writesFailed += 1;
      return null;
    }
  }

  function begin(moduleName, eventName, details = {}) {
    const traceId = crypto.randomUUID();
    const startedAt = Date.now();
    event(moduleName, `${eventName}.started`, details, { traceId, phase: "start" });
    return {
      traceId,
      end(result = {}, options = {}) {
        try {
          const cancelled = options?.cancelled === true || result?.cancelled === true;
          const ok = options?.ok ?? result?.ok;
          return event(moduleName, `${eventName}.${cancelled ? "cancelled" : ok === false ? "failed" : "finished"}`, result, {
            traceId,
            phase: options?.phase || (cancelled ? "cancel" : "finish"),
            level: options?.level || (cancelled ? "info" : ok === false ? "error" : "info"),
            code: options?.code,
            cancelled,
            durationMs: Date.now() - startedAt
          });
        } catch {
          writesFailed += 1;
          return null;
        }
      },
      fail(error, details = {}) {
        try {
          return event(moduleName, `${eventName}.exception`, { ...details, error }, {
            traceId,
            phase: "exception",
            level: "error",
            code: error?.code || "exception",
            durationMs: Date.now() - startedAt
          });
        } catch {
          writesFailed += 1;
          return null;
        }
      },
      cancel(details = {}) {
        return event(moduleName, `${eventName}.cancelled`, details, {
          traceId,
          phase: "cancel",
          level: "info",
          cancelled: true,
          durationMs: Date.now() - startedAt
        });
      }
    };
  }

  function status() {
    const rows = readRecent(logFile, 200);
    const errors = rows.filter((row) => row.level === "error" || row.level === "fatal");
    return {
      ok: true,
      data: {
        runId,
        logDirectory: logsDir,
        logFile,
        currentBytes: fs.existsSync(logFile) ? fs.statSync(logFile).size : 0,
        recentCount: rows.length,
        recentErrorCount: errors.length,
        writesFailed,
        environment: environmentSnapshot,
        latest: rows.slice(0, 20),
        latestErrors: errors.slice(0, 20)
      }
    };
  }

  function environment(extra = {}) {
    environmentSnapshot = boundedDetails({
      app: appInfo,
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      os_version: os.version(),
      total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
      free_memory_mb: Math.round(os.freemem() / 1024 / 1024),
      cpu_count: os.cpus().length,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      process_pid: process.pid,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      ...extra
    }, salt);
  }

  return { begin, environment, event, logFile, logsDir, readRecent: (limit) => readRecent(logFile, limit), recover, runId, status, writeJsonAtomic };
}

function configureDiagnostics(options) {
  activeLogger = createDiagnosticLogger(options);
  return activeLogger;
}

function diagnostics() {
  return activeLogger || {
    begin: () => ({ traceId: "", end: () => undefined, fail: () => undefined }),
    environment: () => undefined,
    event: () => undefined,
    recover: () => undefined,
    status: () => ({ ok: false, error: "diagnostics_not_configured" })
  };
}

module.exports = {
  configureDiagnostics,
  createDiagnosticLogger,
  diagnostics,
  readRecent,
  sanitizeError,
  sanitizeValue
};
