const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const TASK_FILE = "touch_task.json";
const TASK_BACKUP_FILE = "touch_task.json.bak";
const RUN_LOG_FILE = "run_logs.jsonl";
const MAX_RUN_LOG_BYTES = 512 * 1024;
const MAX_RUN_LOG_LINES = 500;
const STALE_TASK_MS = 7 * 24 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function taskPath(baseDir = __dirname) {
  return path.join(baseDir, TASK_FILE);
}

function taskBackupPath(baseDir = __dirname) {
  return path.join(baseDir, TASK_BACKUP_FILE);
}

function runLogPath(baseDir = __dirname) {
  return path.join(baseDir, RUN_LOG_FILE);
}

function contactName(contact) {
  return String(contact?.remark || contact?.nickname || contact?.name || contact?.wechatId || "").trim();
}

function touchSearchName(contact) {
  return String(contact?.remark || contact?.nickname || contact?.wechatId || contact?.name || "").trim();
}

function fillTouchTemplate(template, contact) {
  const name = contactName(contact) || "客户";
  return String(template ?? "").replace(/\{称呼\}/g, name);
}

function publicContact(contact) {
  return {
    id: String(contact?.id ?? ""),
    name: contactName(contact) || String(contact?.name ?? ""),
    remark: String(contact?.remark ?? ""),
    nickname: String(contact?.nickname ?? ""),
    wechatId: String(contact?.wechatId ?? ""),
    source: "微信通讯录",
    allowed: contact?.allowed !== false
  };
}

function createTask(script, contacts, startedAt = nowIso()) {
  const allowedContacts = contacts.filter((contact) => contact?.allowed !== false && touchSearchName(contact));
  const results = allowedContacts.map((contact, contactIndex) => ({
    id: String(contact.id),
    request_id: crypto.randomUUID(),
    contact_index: contactIndex,
    name: contactName(contact) || String(contact.name ?? contact.id),
    contact: publicContact(contact),
    status: "pending",
    reason: "",
    message: "",
    updated_at: startedAt
  }));

  return {
    version: 2,
    id: "touch-" + Date.now(),
    status: "running",
    script: String(script ?? "").trim(),
    started_at: startedAt,
    updated_at: startedAt,
    completed_at: "",
    current_index: 0,
    total: results.length,
    pause_reason: "",
    results
  };
}

function emptyTask() {
  return {
    version: 2,
    id: "",
    status: "idle",
    script: "",
    started_at: "",
    updated_at: "",
    completed_at: "",
    current_index: 0,
    total: 0,
    pause_reason: "",
    results: []
  };
}

function corruptTask() {
  return {
    ...emptyTask(),
    status: "blocked",
    pause_reason: "任务文件损坏，且最近有效备份不可恢复；不会自动创建新任务。",
    integrity_error: "task_state_corrupt"
  };
}

function normalizeTask(raw) {
  if (!raw || typeof raw !== "object") return emptyTask();
  const { client_task_id, gateway_task_id, ...withoutGatewayFields } = raw;
  const results = Array.isArray(raw.results) ? raw.results : [];
  const total = Number.isFinite(raw.total) ? raw.total : results.length;
  const currentIndex = Math.max(0, Math.min(Number(raw.current_index ?? 0), total));
  const normalizedResults = results.map((result, index) => ({
    ...result,
    request_id: result?.request_id || crypto.randomUUID(),
    contact_index: Number.isInteger(result?.contact_index) ? result.contact_index : index
  }));
  return {
    ...emptyTask(),
    ...withoutGatewayFields,
    total,
    current_index: currentIndex,
    version: Math.max(2, Number(raw.version || 1)),
    results: normalizedResults
  };
}

function readTaskFile(file) {
  return normalizeTask(JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")));
}

function writeFileAtomically(file, content) {
  const temporary = `${file}.tmp`;
  const handle = fs.openSync(temporary, "w");
  try {
    fs.writeFileSync(handle, content, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, file);
}

function loadTaskState(baseDir = __dirname) {
  const file = taskPath(baseDir);
  if (!fs.existsSync(file)) return emptyTask();
  try {
    return readTaskFile(file);
  } catch {
    try {
      const restored = {
        ...readTaskFile(taskBackupPath(baseDir)),
        status: "paused",
        pause_reason: "任务文件已损坏，已从最近有效备份恢复；请确认后继续。",
        recovery_notice: "restored_from_backup"
      };
      return saveTaskState(baseDir, restored);
    } catch {
      return corruptTask();
    }
  }
}

function saveTaskState(baseDir = __dirname, task) {
  const nextTask = normalizeTask({ ...task, updated_at: nowIso() });
  fs.mkdirSync(baseDir, { recursive: true });
  const content = JSON.stringify(nextTask, null, 2);
  const file = taskPath(baseDir);
  writeFileAtomically(file, content);
  writeFileAtomically(taskBackupPath(baseDir), content);
  return nextTask;
}

function recoverInterruptedTask(baseDir = __dirname) {
  const task = loadTaskState(baseDir);
  if (task.status !== "running") return task;
  if (task.current_index >= task.total) {
    task.status = "completed";
    task.completed_at = task.completed_at || nowIso();
    task.pause_reason = "";
    return saveTaskState(baseDir, task);
  }

  task.status = "paused";
  task.pause_reason = "上次任务未完成，点击启动程序继续";
  const current = task.results[task.current_index];
  if (current?.status === "processing") {
    current.status = "pending";
    current.reason = "";
  }
  return saveTaskState(baseDir, task);
}

function currentResult(task) {
  return task.results[task.current_index] ?? null;
}

function activeResultIndex(task) {
  const processingIndex = task.results.findIndex((result) => result?.status === "processing");
  return processingIndex >= 0 ? processingIndex : task.current_index;
}

function resultAt(task, index) {
  return task.results[index] ?? null;
}

function publicTaskState(task) {
  const normalized = normalizeTask(task);
  const displayIndex = activeResultIndex(normalized);
  const current = resultAt(normalized, displayIndex);
  const next = resultAt(normalized, displayIndex + 1);
  return {
    ok: true,
    task: {
      id: normalized.id,
      status: normalized.status,
      script: normalized.script,
      started_at: normalized.started_at,
      updated_at: normalized.updated_at,
      completed_at: normalized.completed_at,
      current_index: normalized.current_index,
      total: normalized.total,
      pause_reason: normalized.pause_reason,
      integrity_error: normalized.integrity_error || "",
      recovery_notice: normalized.recovery_notice || "",
      current_contact: current?.contact ?? null,
      next_contact: next?.contact ?? null,
      current_result: current ?? null,
      results: normalized.results
    }
  };
}

function hasUnfinishedPausedTask(task) {
  const normalized = normalizeTask(task);
  return (
    !normalized.integrity_error &&
    normalized.status === "paused" &&
    normalized.current_index < normalized.total &&
    normalized.results.some((result) => result.status === "pending" || result.status === "processing" || result.status === "blocked")
  );
}

function cleanupTaskCache(baseDir = __dirname, nowMs = Date.now()) {
  let logTrimmed = false;
  let taskDeleted = false;
  const logFile = runLogPath(baseDir);
  try {
    const stat = fs.statSync(logFile);
    if (stat.size > MAX_RUN_LOG_BYTES) {
      const lines = fs.readFileSync(logFile, "utf8").trimEnd().split(/\r?\n/).slice(-MAX_RUN_LOG_LINES);
      fs.writeFileSync(logFile, `${lines.join("\n")}\n`, "utf8");
      logTrimmed = true;
    }
  } catch {}

  try {
    const task = loadTaskState(baseDir);
    const updatedAt = Date.parse(task.updated_at || task.completed_at || "");
    const stale = Number.isFinite(updatedAt) && nowMs - updatedAt > STALE_TASK_MS;
    if (stale && (task.status === "completed" || task.status === "stopped")) {
      fs.rmSync(taskPath(baseDir), { force: true });
      taskDeleted = true;
    }
  } catch {}

  return { logTrimmed, taskDeleted };
}

module.exports = {
  TASK_FILE,
  TASK_BACKUP_FILE,
  contactName,
  cleanupTaskCache,
  createTask,
  emptyTask,
  fillTouchTemplate,
  hasUnfinishedPausedTask,
  loadTaskState,
  publicTaskState,
  recoverInterruptedTask,
  saveTaskState,
  taskBackupPath,
  taskPath,
  touchSearchName
};
