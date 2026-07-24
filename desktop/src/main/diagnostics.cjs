const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { replaceWithRetry, writeJsonAtomic } = require("./atomic-file.cjs");

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ARCHIVES = 5;
const MAX_DEPTH = 6;
const MAX_ARRAY = 40;
const MAX_STRING = 800;
const SECRET_PATTERN = /\b(?:sk|ak)-[a-z0-9_-]{8,}\b/giu;
const SENSITIVE_KEYS = /(?:api.?key|secret|token|password|clipboard|prompt|expert|message|content|script|draft|contact.?(?:name|id)|nickname|remark|wechat.?id|wxid|conversation(?:.?title|.?name)?|ocr.?text|raw.?text|recognized.?text)/iu;
const PATH_KEYS = /(?:path|dir|file|cwd|executable)/iu;

let activeLogger = null;

function code(value, fallback = "") {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").slice(0, 120);
  return normalized || fallback;
}

function scrubSecrets(value) {
  return String(value ?? "").replace(SECRET_PATTERN, "[REDACTED_KEY]");
}

function digest(value, salt = "") {
  return crypto.createHash("sha256").update(`${salt}\n${String(value ?? "")}`).digest("hex").slice(0, 16);
}

function safePath(value) {
  const text = scrubSecrets(value);
  if (!text) return "";
  const home = os.homedir();
  return home && text.toLowerCase().startsWith(home.toLowerCase())
    ? `%USERPROFILE%${text.slice(home.length)}`
    : text;
}

function summarizeSensitive(value, salt) {
  const text = scrubSecrets(value);
  return {
    present: Boolean(text),
    length: text.length,
    sha256_16: text ? digest(text, salt) : ""
  };
}

function sanitizeValue(value, context = {}) {
  const { depth = 0, key = "", salt = "" } = context;
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return String(value);
  if (value instanceof Error) return sanitizeError(value, salt);
  if (typeof value === "string") {
    if (SENSITIVE_KEYS.test(key)) return summarizeSensitive(value, salt);
    const safe = PATH_KEYS.test(key) ? safePath(value) : scrubSecrets(value);
    return safe.length > MAX_STRING ? `${safe.slice(0, MAX_STRING)}…[${safe.length}]` : safe;
  }
  if (depth >= MAX_DEPTH) return "[MAX_DEPTH]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => sanitizeValue(item, { depth: depth + 1, key, salt }));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
      if (childValue === undefined || typeof childValue === "function") continue;
      result[childKey] = sanitizeValue(childValue, { depth: depth + 1, key: childKey, salt });
    }
    return result;
  }
  return String(value);
}

function sanitizeError(error, salt = "") {
  const supplied = error instanceof Error ? error : new Error(String(error ?? "unknown_error"));
  const stack = scrubSecrets(supplied.stack || "")
    .split(/\r?\n/)
    .slice(0, 12)
    .map((line) => safePath(line.trim()))
    .filter(Boolean);
  return {
    name: code(supplied.name, "error"),
    code: code(supplied.code, ""),
    message: scrubSecrets(supplied.message || "unknown_error").slice(0, MAX_STRING),
    message_ref: digest(scrubSecrets(supplied.message || "unknown_error"), salt),
    stack
  };
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

  function event(moduleName, eventName, details = {}, options = {}) {
    const entry = {
      v: 1,
      ts: clock().toISOString(),
      run_id: runId,
      seq: ++sequence,
      level: code(options.level, "info"),
      module: code(moduleName, "app"),
      event: code(eventName, "event"),
      trace_id: code(options.traceId, ""),
      phase: code(options.phase || details?.phase, ""),
      code: code(options.code || details?.blocked_reason || details?.code || details?.reason, ""),
      duration_ms: Number.isFinite(Number(options.durationMs)) ? Math.max(0, Math.round(Number(options.durationMs))) : undefined,
      details: sanitizeValue(details, { salt })
    };
    for (const key of Object.keys(entry)) {
      if (entry[key] === "" || entry[key] === undefined) delete entry[key];
    }
    try {
      rotate(logFile);
      fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      writesFailed += 1;
    }
    return entry;
  }

  function begin(moduleName, eventName, details = {}) {
    const traceId = crypto.randomUUID();
    const startedAt = Date.now();
    event(moduleName, `${eventName}.started`, details, { traceId, phase: "start" });
    return {
      traceId,
      end(result = {}, options = {}) {
        const ok = options.ok ?? result?.ok;
        return event(moduleName, `${eventName}.${ok === false ? "failed" : "finished"}`, result, {
          traceId,
          phase: options.phase || "finish",
          level: options.level || (ok === false ? "error" : "info"),
          code: options.code,
          durationMs: Date.now() - startedAt
        });
      },
      fail(error, details = {}) {
        return event(moduleName, `${eventName}.exception`, { ...details, error }, {
          traceId,
          phase: "exception",
          level: "error",
          code: error?.code || "exception",
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
        latest: rows.slice(0, 20),
        latestErrors: errors.slice(0, 20)
      }
    };
  }

  function environment(extra = {}) {
    event("app", "environment.snapshot", {
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
    });
  }

  return { begin, environment, event, logFile, logsDir, readRecent: (limit) => readRecent(logFile, limit), runId, status, writeJsonAtomic };
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
