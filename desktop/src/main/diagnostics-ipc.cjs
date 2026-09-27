const { app, dialog, ipcMain, screen, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");
const productBrand = require("../../product-brand.json");
const { replaceWithRetry, uniqueTemporaryPath } = require("./atomic-file.cjs");
const { diagnostics, normalizeReceiptDiagnostics } = require("./diagnostics.cjs");

const AUTO_REPLY_DIAGNOSTIC_FILE = /^auto-reply-diagnostics\.jsonl(?:\.[1-9]\d*)?$/u;
const AUTO_REPLY_STATUS_LIMIT = 50;
const AUTO_REPLY_STATUS_TAIL_BYTES = 256 * 1024;
const AUTO_REPLY_VISIBLE_TOKEN_FIELDS = [
  "status",
  "phase",
  "code",
  "action",
  "reason_code",
  "error_code",
  "send_result",
  "input_read_reason",
  "outcome",
  "side_effect",
  "retryability",
  "failure_stage",
  "send_phase",
  "recovery_action",
  "verification_mode"
];
const AUTO_REPLY_VISIBLE_INTEGER_FIELDS = [
  "duration_ms",
  "delivery_attempt",
  "retry_attempt",
  "retry_polls_remaining",
  "context_turn_count",
  "user_turn_count",
  "assistant_turn_count",
  "required_idle_ms",
  "observed_idle_ms",
  "preflight_ms"
];
const AUTO_REPLY_VISIBLE_BOOLEAN_FIELDS = ["send_attempted", "draft_phase_started"];

function buildInfo(appRuntime = app, edition = "") {
  const appRoot = require("./component-paths.cjs").applicationPath(appRuntime);
  const candidates = [
    path.join(appRoot, "dist", "build-edition.json"),
    path.join(appRoot, "dist-pilot", "build-edition.json"),
    path.join(appRoot, "dist-development", "build-edition.json")
  ];
  if (edition === "development") candidates.unshift(candidates.pop());
  else if (edition === "pilot") candidates.unshift(candidates.splice(1, 1)[0]);
  for (const file of candidates) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
  }
  return {};
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exportableStatus(status = {}) {
  const {
    logDirectory: _logDirectory,
    logFile: _logFile,
    ...safeStatus
  } = status && typeof status === "object" ? status : {};
  return safeStatus;
}

const APP_VERSION = /^\d+\.\d+\.\d+$/u;
const WECHAT_VERSION = /^\d+(\.\d+){1,3}$/u;
const SAFE_ID = /^[0-9A-Za-z._-]{1,64}$/u;
const SAFE_TOKEN = /^[a-z][a-z0-9_.:-]{0,79}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const valid = (value, pattern) => typeof value === "string" && pattern.test(value) ? value : null;
const choice = (value, choices) => choices.includes(value) ? value : null;
const timestamp = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
  && !Number.isNaN(Date.parse(value)) ? value : null;

function appSummary(info, appRuntime, component = global.__xiaoxiComponents) {
  return {
    version: valid(info.version, APP_VERSION),
    base_version: valid(appRuntime.getVersion?.(), APP_VERSION),
    edition: choice(info.edition, ["development", "pilot", "unknown"]),
    data_profile: choice(info.data_profile, ["test", "delivery", "unknown"]),
    build_id: valid(info.build_id, SAFE_ID),
    build_commit: valid(info.build_commit, /^[0-9a-f]{7,40}$/u),
    source_dirty: typeof info.source_dirty === "boolean" ? info.source_dirty : null,
    packaged: typeof info.packaged === "boolean" ? info.packaged : null,
    component: component ? {
      version: valid(component.version, APP_VERSION),
      id: valid(component.id, /^[0-9a-f]{64}$/u),
      healthy: typeof component.healthy === "boolean" ? component.healthy : null
    } : null
  };
}

function diagnosticSummaries(files) {
  const versions = new Map();
  const runs = new Map();
  let latest = null;
  for (const file of files) {
    for (const line of file.content.toString("utf8").split(/\r?\n/u)) {
      const ts = timestamp(/"ts":"([^"]+)"/u.exec(line)?.[1]);
      const runId = valid(/"run_id":"([^"]+)"/u.exec(line)?.[1], UUID);
      const seq = Number(/"seq":(\d+)/u.exec(line)?.[1]);
      if (ts && runId && Number.isSafeInteger(seq) && seq > 0) {
        const run = runs.get(runId) || { run_id: runId, first_seq: seq, last_seq: seq, first_ts: ts, last_ts: ts };
        if (seq < run.first_seq) { run.first_seq = seq; run.first_ts = ts; }
        if (seq > run.last_seq) { run.last_seq = seq; run.last_ts = ts; }
        runs.set(runId, run);
      }
      if (!ts || !line.includes("wechat_version")) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const details = row?.details && typeof row.details === "object" ? row.details : {};
      for (const [key, source] of [["window_wechat_version", "window_driver"], ["wechat_version", "contact_sync"]]) {
        const version = valid(details[key], WECHAT_VERSION);
        if (!version) continue;
        const seen = versions.get(version) || { version, first_ts: ts, last_ts: ts, count: 0 };
        seen.first_ts = seen.first_ts < ts ? seen.first_ts : ts;
        seen.last_ts = seen.last_ts > ts ? seen.last_ts : ts;
        seen.count += 1;
        versions.set(version, seen);
        if (!latest || ts >= latest.ts) latest = { version, ts, source };
      }
    }
  }
  return {
    wechat: latest ? { ...latest, versions_seen: [...versions.values()].sort((a, b) => a.first_ts.localeCompare(b.first_ts)) }
      : { version: null, ts: null, source: null, versions_seen: [] },
    log_coverage: { file_count: files.length, total_bytes: files.reduce((sum, file) => sum + file.size_bytes, 0),
      runs: [...runs.values()].map((run) => ({ ...run, rotated_prefix: run.first_seq > 1 })) }
  };
}

function displaySummary(screenRuntime) {
  try {
    const primaryId = screenRuntime.getPrimaryDisplay()?.id;
    const bounded = (value) => Number.isSafeInteger(value) && Math.abs(value) <= 100_000 ? value : null;
    const rect = (value) => Object.fromEntries(["x", "y", "width", "height"].map((key) => [key, bounded(value?.[key])]));
    const displays = screenRuntime.getAllDisplays().map((item) => ({
      primary: item.id === primaryId,
      bounds: rect(item.bounds), work_area: rect(item.workArea),
      scale_factor: Number.isFinite(item.scaleFactor) && item.scaleFactor > 0 && item.scaleFactor <= 10 ? item.scaleFactor : null,
      rotation: bounded(item.rotation), internal: typeof item.internal === "boolean" ? item.internal : null
    }));
    return { count: displays.length, primary: displays.findIndex((item) => item.primary), displays };
  } catch { return null; }
}

function feedbackSummary(getLatest) {
  try {
    const item = getLatest?.();
    if (!item) return null;
    return { id: valid(item.id, UUID), created_at: timestamp(item.createdAt || item.created_at),
      delivery: choice(item.delivery, ["queued", "sending", "sent", "failed"]),
      status: valid(item.status, SAFE_TOKEN) };
  } catch { return null; }
}

function collectDiagnosticFiles(logsDir) {
  return fs.readdirSync(logsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^diagnostics\.jsonl(?:\.\d+)?$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((name) => {
      const content = fs.readFileSync(path.join(logsDir, name));
      return {
        name,
        content,
        size_bytes: content.length,
        sha256: sha256(content)
      };
    });
}

function autoReplyDiagnosticSources(autoReplyDir) {
  if (typeof autoReplyDir !== "string" || !autoReplyDir.trim()) return [];
  const lockedDirectory = path.resolve(autoReplyDir);
  let directoryEntries;
  try {
    directoryEntries = fs.readdirSync(lockedDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }

  const sources = [];
  for (const entry of directoryEntries) {
    if (!entry.isFile() || !AUTO_REPLY_DIAGNOSTIC_FILE.test(entry.name)) continue;
    const source = path.resolve(lockedDirectory, entry.name);
    if (path.dirname(source) !== lockedDirectory) continue;
    sources.push({ name: entry.name, source });
  }
  return sources;
}

function collectAutoReplyDiagnosticFiles(autoReplyDir) {
  const files = [];
  for (const { name, source } of autoReplyDiagnosticSources(autoReplyDir)) {
    let content;
    try {
      content = fs.readFileSync(source);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    files.push({
      name: path.posix.join("auto_reply", name),
      content,
      size_bytes: content.length,
      sha256: sha256(content)
    });
  }
  return files.sort((left, right) => left.name.localeCompare(right.name, "en"));
}

function autoReplyDiagnosticOrder(name) {
  if (name === "auto-reply-diagnostics.jsonl") return 0;
  const suffix = Number(name.slice("auto-reply-diagnostics.jsonl.".length));
  return Number.isSafeInteger(suffix) && suffix > 0 ? suffix : Number.MAX_SAFE_INTEGER;
}

function readUtf8Tail(source, maximumBytes = AUTO_REPLY_STATUS_TAIL_BYTES) {
  let handle;
  try {
    const size = fs.statSync(source).size;
    const start = Math.max(0, size - maximumBytes);
    const buffer = Buffer.allocUnsafe(size - start);
    handle = fs.openSync(source, "r");
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstLineEnd = text.indexOf("\n");
      text = firstLineEnd >= 0 ? text.slice(firstLineEnd + 1) : "";
    }
    return text;
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function safeDiagnosticToken(value) {
  const token = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9][a-z0-9_.:-]{0,119}$/iu.test(token) ? token : "";
}

function safeDiagnosticTimestamp(value) {
  if (typeof value !== "string" || value.length > 40) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function safeDiagnosticInteger(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 1_000_000_000 ? numeric : undefined;
}

function visibleAutoReplyEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ts = safeDiagnosticTimestamp(value.ts);
  const event = safeDiagnosticToken(value.event);
  if (!ts || !event) return null;
  const visible = { ts, event };
  for (const field of AUTO_REPLY_VISIBLE_TOKEN_FIELDS) {
    const token = safeDiagnosticToken(value[field]);
    if (token) visible[field] = token;
  }
  const traceId = typeof value.trace_id === "string" ? value.trace_id.trim().toLowerCase() : "";
  if (/^[a-f0-9]{24}$/u.test(traceId)) visible.trace_id = traceId;
  const reasonRef = typeof value.reason_ref === "string" ? value.reason_ref.trim().toLowerCase() : "";
  if (/^[a-f0-9]{12}$/u.test(reasonRef)) visible.reason_ref = reasonRef;
  for (const field of AUTO_REPLY_VISIBLE_INTEGER_FIELDS) {
    const numeric = safeDiagnosticInteger(value[field]);
    if (numeric !== undefined) visible[field] = numeric;
  }
  for (const field of AUTO_REPLY_VISIBLE_BOOLEAN_FIELDS) {
    if (typeof value[field] === "boolean") visible[field] = value[field];
  }
  Object.assign(visible, normalizeReceiptDiagnostics(value));
  return visible;
}

function readRecentAutoReplyDiagnostics(autoReplyDir, limit = AUTO_REPLY_STATUS_LIMIT) {
  const maximum = Math.max(1, Math.min(AUTO_REPLY_STATUS_LIMIT, Number(limit) || AUTO_REPLY_STATUS_LIMIT));
  const files = autoReplyDiagnosticSources(autoReplyDir)
    .sort((left, right) => autoReplyDiagnosticOrder(left.name) - autoReplyDiagnosticOrder(right.name));
  const entries = [];
  for (const file of files) {
    for (const line of readUtf8Tail(file.source).split(/\r?\n/u).filter(Boolean).slice(-maximum)) {
      try {
        const visible = visibleAutoReplyEntry(JSON.parse(line));
        if (visible) entries.push(visible);
      } catch {}
    }
    if (entries.length >= maximum) break;
  }
  return entries
    .sort((left, right) => right.ts.localeCompare(left.ts))
    .slice(0, maximum);
}

function diagnosticStatus(autoReplyDir) {
  const status = diagnostics().status();
  if (!status?.ok || !status.data || typeof status.data !== "object") return status;
  let autoReplyLatest = [];
  try {
    autoReplyLatest = readRecentAutoReplyDiagnostics(autoReplyDir);
  } catch {
    // A log can rotate between enumeration and reading. Keep the rest of the
    // diagnostics page available; the next refresh will read the new file.
  }
  return {
    ...status,
    data: {
      ...status.data,
      autoReplyLatest
    }
  };
}

async function createZipArchive(entries) {
  const archive = new JSZip();
  for (const entry of entries) archive.file(entry.name, entry.content);
  return archive.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "DOS"
  });
}

async function verifyZipArchive(value, expectedNames) {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const archive = await JSZip.loadAsync(content, { checkCRC32: true });
  const actualNames = Object.keys(archive.files)
    .filter((name) => !archive.files[name].dir)
    .sort((left, right) => left.localeCompare(right, "en"));
  const expected = [...expectedNames].sort((left, right) => left.localeCompare(right, "en"));
  if (actualNames.length !== expected.length || actualNames.some((name, index) => name !== expected[index])) {
    throw new Error("diagnostic_archive_manifest_mismatch");
  }
  return content;
}

async function writeVerifiedArchive(destination, value, expectedNames) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = uniqueTemporaryPath(destination);
  let handle;
  try {
    const content = Buffer.isBuffer(value) ? value : Buffer.from(value);
    handle = fs.openSync(temporary, "wx");
    fs.writeFileSync(handle, content);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    await verifyZipArchive(fs.readFileSync(temporary), expectedNames);
    replaceWithRetry(temporary, destination);
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {}
    }
    fs.rmSync(temporary, { force: true });
  }
}

async function exportBundle(options = {}) {
  const appRuntime = options.app || app;
  const dialogRuntime = options.dialog || dialog;
  const logger = options.logger || diagnostics();
  const autoReplyDir = options.autoReplyDir;
  const createArchive = options.createArchive || createZipArchive;
  const info = appSummary(options.appInfo || {}, appRuntime, options.component);
  const selected = await dialogRuntime.showSaveDialog({
    title: `导出 ${productBrand.displayName} 诊断包`,
    defaultPath: path.join(appRuntime.getPath("downloads"), `${productBrand.displayName}-${info.version || "unknown"}-${info.data_profile || "unknown"}-诊断日志-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`),
    filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }]
  });
  if (selected.canceled || !selected.filePath) return { ok: true, canceled: true };

  const destination = selected.filePath.toLowerCase().endsWith(".zip") ? selected.filePath : `${selected.filePath}.zip`;
  const operation = logger.begin("diagnostics", "bundle_export", { destination });
  try {
    const diagnosticFiles = collectDiagnosticFiles(logger.logsDir);
    const autoReplyDiagnosticFiles = collectAutoReplyDiagnosticFiles(autoReplyDir);
    const failureFiles = require('./failure-evidence.cjs').collectFailureEvidenceFiles(path.dirname(logger.logsDir));
    const passportFiles = require('./task-passport.cjs').collectTaskPassportFiles(path.dirname(logger.logsDir));
    const collectedFiles = [...diagnosticFiles, ...autoReplyDiagnosticFiles, ...failureFiles, ...passportFiles];
    const includedFiles = collectedFiles.map(({ name, size_bytes, sha256: digest }) => ({
      name,
      size_bytes,
      sha256: digest
    }));
    const { wechat, log_coverage } = diagnosticSummaries(diagnosticFiles);
    const summary = Buffer.from(`${JSON.stringify({
      exported_at: new Date().toISOString(),
      build: buildInfo(appRuntime, info.edition),
      diagnostics: exportableStatus(logger.status()?.data),
      app: info,
      wechat,
      display: displaySummary(options.screen || screen),
      feedback_latest: feedbackSummary(options.getFeedbackLatest),
      log_coverage,
      included_files: includedFiles,
      privacy: "普通结构化日志不包含 DeepSeek Key、客户消息原文、联系人明文或 AI 专家资料原文；任务护照失败附件包含本机微信原始截图和程序原始读数，可能出现屏幕可见信息，仅在用户主动导出诊断包时纳入。"
    }, null, 2)}\n`, "utf8");
    const entries = [
      ...collectedFiles.map(({ name, content }) => ({ name, content })),
      { name: "summary.json", content: summary }
    ];
    const archive = await createArchive(entries);
    await writeVerifiedArchive(destination, archive, entries.map((entry) => entry.name));
    operation.end({ ok: true, destination });
    return { ok: true, filePath: destination };
  } catch (error) {
    operation.fail(error);
    return { ok: false, error: `导出诊断包失败：${String(error?.message || error)}` };
  }
}

function registerDiagnosticsIpc(options = {}) {
  ipcMain.handle("diagnostics:status", () => diagnosticStatus(options.autoReplyDir));
  ipcMain.handle("diagnostics:open-folder", async () => {
    const result = await shell.openPath(diagnostics().logsDir);
    if (result) return { ok: false, error: result };
    diagnostics().event("diagnostics", "folder_opened");
    return { ok: true };
  });
  ipcMain.handle("diagnostics:export", () => exportBundle({ autoReplyDir: options.autoReplyDir,
    appInfo: options.appInfo, screen: options.screen, getFeedbackLatest: options.getFeedbackLatest }));
}

module.exports = { exportBundle, registerDiagnosticsIpc };
