// Failure capsules: one self-contained record per failure, uploaded on its own,
// so nobody has to collect diagnostics from a customer's computer by hand.
// A capsule holds what the customer saw (code, message), the engine's own
// measurements and traceback, the steps that led there, the machine, and the
// failure screenshots of the same operation. The customer can turn upload off.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { scrubInternalDetails } = require("../shared/internal-diagnostics.cjs");
const { classifyWechatFailureReason } = require("../shared/wechat-failure-policy.cjs");
const { collectFlight, collectPassports, hasRecentFailureScreen, captureFailureScreen } = require("./flight-recorder.cjs");

const FAILURE_LEVELS = new Set(["error", "fatal"]);
// Not failures: the customer closed a dialog, or upload itself is offline.
const IGNORED_CODES = new Set(["CONTENT_DIALOG_CANCELLED", "cancelled", "cloud_stopped"]);
const IGNORED_MODULES = new Set(["maintenance", "feedback"]);
const MERGE_WINDOW_MS = 10 * 60_000;
const DAILY_LIMIT = 40;
const KEEP_FILES = 100;
const KEEP_DAYS = 30;
const MAX_CAPSULE_BYTES = 240 * 1024;
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
const SETTLE_MS = 3_000;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const WECHAT_MODULES = /wechat|active_touch|auto_reply|moments|contact_sync/;
// An environment cause (WeChat logged out, window closed by the customer) is
// handled by the app itself. It becomes a capsule only when it keeps
// happening on one computer, which suggests it is a bug after all.
const ENVIRONMENT_REPEAT_LIMIT = 5;
const ATTACHMENT_NAME = /^[a-z0-9][a-z0-9_.-]{0,140}\.(png|jpg|json)$/;

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function text(value, limit) { return typeof value === "string" ? value.slice(0, limit) : ""; }

// Usernames appear in every Windows path. Replace the profile directory in
// both raw and JSON-escaped form before anything leaves the computer.
function withoutProfilePath(json, home = os.homedir()) {
  if (!home) return json;
  let result = json;
  for (const variant of new Set([home, home.replace(/\\/g, "/")])) {
    const escaped = JSON.stringify(variant).slice(1, -1);
    result = result.split(escaped).join("~");
    result = result.split(escaped.toLowerCase()).join("~");
  }
  return result;
}

function readJsonLines(file, start, limitBytes = 512 * 1024) {
  const stat = fs.statSync(file);
  const from = stat.size < start ? 0 : start;
  const length = Math.min(stat.size - from, limitBytes);
  if (length <= 0) return { lines: [], end: stat.size };
  const handle = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, from);
    const raw = buffer.toString("utf8");
    const complete = raw.slice(0, raw.lastIndexOf("\n") + 1);
    const lines = complete.split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    return { lines, end: from + Buffer.byteLength(complete) };
  } finally { fs.closeSync(handle); }
}

function tailText(file, chars) {
  try {
    const stat = fs.statSync(file);
    const length = Math.min(stat.size, chars * 4);
    const handle = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, stat.size - length);
      return { text: buffer.toString("utf8").slice(-chars), modified: stat.mtimeMs };
    } finally { fs.closeSync(handle); }
  } catch { return null; }
}

function createFailureCapsules({ rootDir, logger, engineLogsDir = "", network = null, identity = () => null,
  isEnabled = () => false, environment = () => ({}), clock = Date.now, settleMs = SETTLE_MS, home = os.homedir(),
  captureScreen = captureFailureScreen }) {
  const dir = path.join(rootDir, "failure-capsules");
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, "state.json");
  const saved = readJson(stateFile, {});
  const state = {
    offsets: saved.offsets && typeof saved.offsets === "object" ? saved.offsets : {},
    outbox: Array.isArray(saved.outbox) ? saved.outbox.filter(value => typeof value === "string") : [],
    recent: Array.isArray(saved.recent) ? saved.recent.filter(item => item && typeof item.key === "string") : [],
    daily: saved.daily && typeof saved.daily === "object" ? saved.daily : { day: "", count: 0 },
    environment: saved.environment && typeof saved.environment === "object" ? saved.environment : { day: "", counts: {} }
  };
  const journal = engineLogsDir ? path.join(engineLogsDir, "failures.jsonl") : "";
  let timers = new Set(), stopped = false, uploading = null, uploadAgain = false, retryAt = 0, attempts = 0, unsubscribe, pollTimer, uploadTimer;
  const save = () => { try { writeJsonAtomic(stateFile, state); } catch { /* Next save retries. */ } };
  const capsuleFile = capsuleId => path.join(dir, `${capsuleId}.json`);

  function breadcrumbs(at, traceId) {
    const rows = logger?.readRecent?.(400) || [];
    const from = at - 15 * 60_000;
    return rows.filter(row => {
      const ts = Date.parse(row.ts);
      if (!Number.isFinite(ts) || ts > at + 60_000) return false;
      return (traceId && (row.trace_id === traceId || row.parent_trace_id === traceId)) || ts >= from;
    }).slice(-60);
  }
  function internalTrail(traceId) {
    if (!traceId || !logger?.logsDir) return [];
    const file = path.join(logger.logsDir, "internal-diagnostics.jsonl");
    try {
      const { lines } = readJsonLines(file, Math.max(0, fs.statSync(file).size - 1024 * 1024), 1024 * 1024);
      return lines.filter(row => row.trace_id === traceId || row.parent_trace_id === traceId).slice(-30);
    } catch { return []; }
  }
  function evidence(at, traceId) {
    const folder = path.join(rootDir, "failure-evidence");
    try {
      return fs.readdirSync(folder).filter(name => /^[a-f0-9]{32}\.json$/.test(name)).map(name => {
        const entry = readJson(path.join(folder, name), null);
        const ts = Date.parse(entry?.ts);
        const related = traceId ? entry?.trace_id === traceId : Math.abs(ts - at) < 2 * 60_000;
        if (!entry || !related || entry.details?.evidence_id !== name.slice(0, 32)) return null;
        // Outside the internal profile the worker paints the whole image grey:
        // uploading it would only look like evidence.
        const redacted = entry.details?.redaction_mode === "full_content";
        return { id: name.slice(0, 32), ts: entry.ts, code: entry.code, captureStatus: entry.details?.capture_status || "", redacted,
          hasImage: !redacted && fs.existsSync(path.join(folder, `${name.slice(0, 32)}.png`)) };
      }).filter(Boolean).slice(0, 6);
    } catch { return []; }
  }
  function engineStderr(at) {
    if (!engineLogsDir) return "";
    const tail = tailText(path.join(engineLogsDir, "stderr.log"), 4000);
    return tail && Math.abs(tail.modified - at) < 30 * 60_000 ? tail.text : "";
  }

  function allowedToday() {
    const day = new Date(clock()).toISOString().slice(0, 10);
    if (state.daily.day !== day) state.daily = { day, count: 0 };
    return state.daily.count < DAILY_LIMIT;
  }

  function write(capsule) {
    let json = withoutProfilePath(JSON.stringify(scrubInternalDetails(capsule, { maxBytes: MAX_CAPSULE_BYTES }).value), home);
    // Steps that led here are the first thing to shorten; the failure itself never is.
    for (const key of ["internal", "breadcrumbs"]) {
      if (Buffer.byteLength(json) <= MAX_CAPSULE_BYTES) break;
      const value = JSON.parse(json);
      value[key] = (value[key] || []).slice(-10);
      value.truncated = true;
      json = JSON.stringify(value);
    }
    writeJsonAtomic(capsuleFile(capsule.id), JSON.parse(json));
  }

  function environmentCause(failure, at) {
    if (!WECHAT_MODULES.test(failure.module || "") || classifyWechatFailureReason(failure.code).classification !== "environment") return null;
    const day = new Date(at).toISOString().slice(0, 10);
    if (state.environment.day !== day) state.environment = { day, counts: {} };
    const count = (state.environment.counts[failure.code] || 0) + 1;
    state.environment.counts[failure.code] = count;
    save();
    return count === ENVIRONMENT_REPEAT_LIMIT ? "repeated" : "counted";
  }

  // The flight record and passports are copied now: the worker files expire
  // after two hours, and an offline computer may upload days later.
  function attach(capsule, at) {
    const folder = path.join(dir, capsule.id);
    const flight = collectFlight(rootDir, { at });
    const files = [...flight.files, ...collectPassports(rootDir, { at })];
    capsule.flight = flight.steps.map(step => ({ ts: step.ts, step: step.step, image: step.image || "", lossless: step.lossless === true,
      ...(step.imageOmitted ? { imageOmitted: step.imageOmitted } : {}) }));
    capsule.attachments = [];
    if (!flight.steps.length && !files.length) return;
    fs.mkdirSync(folder, { recursive: true });
    if (flight.steps.length) {
      fs.writeFileSync(path.join(folder, "flight.json"), withoutProfilePath(JSON.stringify(scrubInternalDetails(flight.steps, { maxBytes: MAX_ATTACHMENT_BYTES }).value), home));
      capsule.attachments.push("flight.json");
    }
    for (const item of files) {
      const name = item.name.toLowerCase();
      try {
        if (!ATTACHMENT_NAME.test(name) || fs.statSync(item.file).size > MAX_ATTACHMENT_BYTES) continue;
        if (name.endsWith(".json")) fs.writeFileSync(path.join(folder, name), withoutProfilePath(fs.readFileSync(item.file, "utf8"), home));
        else fs.copyFileSync(item.file, path.join(folder, name));
        capsule.attachments.push(name);
      } catch { /* A file the worker pruned meanwhile is simply absent. */ }
    }
  }

  // One capsule per module and code within ten minutes; repeats only count.
  function record(failure) {
    if (stopped || !failure?.code || IGNORED_CODES.has(failure.code) || IGNORED_MODULES.has(failure.module)) return null;
    const at = Number.isFinite(failure.at) ? failure.at : clock();
    const environmental = environmentCause(failure, at);
    if (environmental === "counted") return null;
    const key = `${failure.module}:${failure.code}`;
    state.recent = state.recent.filter(item => at - item.at < MERGE_WINDOW_MS);
    const prior = state.recent.find(item => item.key === key);
    if (prior) {
      const capsule = readJson(capsuleFile(prior.id), null);
      if (capsule) {
        capsule.occurrences = (capsule.occurrences || 1) + 1;
        capsule.lastSeenAt = new Date(at).toISOString();
        // A task_terminal log line and the engine's journal record describe the
        // same failure; whichever arrives second fills in what the first lacked.
        for (const field of ["message", "traceback", "where", "taskId", "traceId", "phase"]) if (!capsule[field] && failure[field]) capsule[field] = failure[field];
        if (failure.details && Object.keys(failure.details).length && !Object.keys(capsule.details || {}).length) capsule.details = failure.details;
        if (failure.context && !Object.keys(capsule.context || {}).length) capsule.context = failure.context;
        try { write(capsule); } catch {}
        // Re-send so the server sees the new count; it skips screenshots it already has.
        if (!state.outbox.includes(prior.id)) state.outbox.push(prior.id);
      }
      save();
      void flush();
      return prior.id;
    }
    if (!allowedToday()) return null;
    const capsule = {
      schema: 1, id: crypto.randomUUID(), createdAt: new Date(at).toISOString(), lastSeenAt: new Date(at).toISOString(), occurrences: 1,
      source: failure.source, module: failure.module, event: failure.event || "", code: failure.code, level: failure.level || "error",
      phase: failure.phase || "", taskId: failure.taskId || "", traceId: failure.traceId || "",
      message: text(failure.message, 2000), where: text(failure.where, 120), traceback: text(failure.traceback, 12000),
      details: failure.details || {}, context: failure.context || {},
      breadcrumbs: breadcrumbs(at, failure.traceId), internal: internalTrail(failure.traceId),
      engineStderr: failure.module === "content_engine" ? engineStderr(at) : "",
      evidence: evidence(at, failure.traceId), environment: (() => { try { return environment() || {}; } catch { return {}; } })(),
      ...(environmental === "repeated" ? { suspected: "environment_repeated" } : {})
    };
    try { attach(capsule, at); } catch { capsule.attachments = capsule.attachments || []; }
    try { write(capsule); } catch { return null; }
    state.daily.count += 1;
    state.recent.push({ key, id: capsule.id, at, module: capsule.module, taskId: capsule.taskId });
    state.outbox.push(capsule.id);
    prune(); save();
    void flush();
    return capsule.id;
  }

  function fromLog(entry) {
    if (!FAILURE_LEVELS.has(entry?.level)) return;
    // main.cjs records crashes directly, with the stack the log cannot keep.
    if (entry.module === "app" && ["uncaught_exception", "unhandled_rejection"].includes(entry.event)) return;
    const timer = setTimeout(async () => {
      timers.delete(timer);
      // The engine writes its journal before replying, so read it first and let
      // the richer journal record open the capsule.
      if (entry.module === "content_engine") pollJournal();
      if (WECHAT_MODULES.test(entry.module || "") && !hasRecentFailureScreen(rootDir, clock())
        && classifyWechatFailureReason(entry.code).classification !== "environment") {
        try { await captureScreen(entry.code); } catch { /* The capsule goes out with what exists. */ }
      }
      if (stopped) return;
      record({ source: "log", module: entry.module, event: entry.event, code: entry.code, level: entry.level, phase: entry.phase,
        traceId: entry.trace_id || "", taskId: entry.details?.task_id || "", details: entry.details || {}, at: Date.parse(entry.ts) });
    }, settleMs);
    timer.unref?.();
    timers.add(timer);
  }

  function pollJournal() {
    if (!journal || stopped) return;
    try {
      const size = fs.statSync(journal).size;
      const known = state.offsets[journal];
      // First sight of a journal: only the last day matters, not its whole history.
      const start = Number.isSafeInteger(known) ? known : Math.max(0, size - 64 * 1024);
      const { lines, end } = readJsonLines(journal, start);
      state.offsets[journal] = end;
      save();
      for (const row of lines) {
        const at = Date.parse(row.ts);
        if (!Number.isFinite(at) || clock() - at > 86400000) continue;
        record({ source: "engine", module: "content_engine", event: row.where || "", code: String(row.code || "internal_error"),
          message: row.message, where: row.where, traceback: row.traceback, details: row.details, context: row.context,
          taskId: row.task_id || "", at });
      }
    } catch (error) { if (error?.code !== "ENOENT") { /* Journal unreadable this time; the offset stays. */ } }
  }

  function prune() {
    const cutoff = clock() - KEEP_DAYS * 86400000;
    let files = [];
    try { files = fs.readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)); } catch { return; }
    const dated = files.map(name => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs })).sort((a, b) => b.at - a.at);
    for (const [index, item] of dated.entries()) {
      if (index >= KEEP_FILES || item.at < cutoff) {
        fs.rmSync(path.join(dir, item.name), { force: true });
        fs.rmSync(path.join(dir, item.name.replace(/\.json$/, "")), { recursive: true, force: true });
        state.outbox = state.outbox.filter(value => `${value}.json` !== item.name);
      }
    }
  }

  async function uploadOne(capsuleId, client) {
    const capsule = readJson(capsuleFile(capsuleId), null);
    if (!capsule) return;
    const result = await network.request("/v1/capsules", { body: { client, capsule } });
    if (result?.id !== capsuleId) throw Object.assign(new Error("capsule_ack_invalid"), { code: "capsule_ack_invalid" });
    for (const item of capsule.evidence || []) {
      if (!item.hasImage || (result.evidence || []).includes(item.id)) continue;
      const file = path.join(rootDir, "failure-evidence", `${item.id}.png`);
      let image;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) continue;
        image = fs.readFileSync(file);
        if (!image.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) continue;
      } catch { continue; }
      await network.request("/v1/capsules/evidence", { body: { client, capsuleId, evidenceId: item.id, png: image.toString("base64") } });
    }
    for (const name of capsule.attachments || []) {
      if ((result.attachments || []).includes(name)) continue;
      let data;
      try { data = fs.readFileSync(path.join(dir, capsuleId, name)); } catch { continue; }
      await network.request("/v1/capsules/attachments", { body: { client, capsuleId, name, data: data.toString("base64") } });
    }
  }

  // Callers share one upload pass. A call during a pass asks for one more
  // pass, so a capsule recorded or enabled meanwhile is not left for the timer.
  function flush() {
    if (uploading) { uploadAgain = true; return uploading; }
    uploading = (async () => {
      do { uploadAgain = false; await upload(); } while (uploadAgain && !stopped);
    })().finally(() => { uploading = null; });
    return uploading;
  }
  async function upload() {
    if (!network || stopped || clock() < retryAt || !state.outbox.length || !isEnabled()) return;
    const client = identity();
    if (!client) return;
    try {
      while (state.outbox.length && !stopped && isEnabled()) {
        const next = state.outbox[0];
        await uploadOne(next, client);
        state.outbox = state.outbox.filter(value => value !== next);
        save();
      }
      attempts = 0; retryAt = 0;
    } catch {
      retryAt = clock() + Math.min(30 * 60_000, 15_000 * 2 ** Math.min(attempts++, 7));
    }
  }

  // Feedback carries the capsules of the task, or the module, it is about.
  function related({ module = "", taskId = "", withinMs = 86400000 } = {}) {
    const since = clock() - withinMs;
    const known = fs.readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => readJson(path.join(dir, name), null))
      .filter(capsule => capsule && Date.parse(capsule.lastSeenAt) >= since).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
    const byTask = taskId ? known.filter(capsule => capsule.taskId === taskId || Object.values(capsule.context || {}).includes(taskId)) : [];
    const byModule = known.filter(capsule => !module || capsule.module === module);
    return [...new Set([...byTask, ...byModule].map(capsule => capsule.id))].slice(0, 5);
  }

  function start() {
    if (stopped || unsubscribe) return;
    unsubscribe = logger?.subscribe?.(entry => { try { fromLog(entry); } catch {} });
    pollJournal(); void flush();
    pollTimer = setInterval(pollJournal, 60_000); pollTimer.unref?.();
    uploadTimer = setInterval(() => void flush(), 60_000); uploadTimer.unref?.();
  }
  function stop() {
    stopped = true; unsubscribe?.(); clearInterval(pollTimer); clearInterval(uploadTimer);
    for (const timer of timers) clearTimeout(timer);
    timers = new Set();
  }
  function status() { return { queued: state.outbox.length, today: state.daily.count }; }
  return { start, stop, record, pollJournal, flush, related, status, directory: dir };
}

module.exports = { createFailureCapsules, withoutProfilePath };
