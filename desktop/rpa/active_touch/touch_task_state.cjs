const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const TASK_FILE = "touch_task.json";
const TASK_BACKUP_FILE = "touch_task.json.bak";
const RUN_LOG_FILE = "run_logs.jsonl";
const MAX_RUN_LOG_BYTES = 512 * 1024;
const MAX_RUN_LOG_LINES = 500;
const STALE_TASK_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 50;
const CURRENT_TASK_VERSION = 4;

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
    wxid: String(contact?.wxid ?? ""),
    wechatAccountId: String(contact?.wechatAccountId ?? ""),
    syncedAt: String(contact?.syncedAt ?? ""),
    search_query: touchSearchName(contact),
    source: "微信通讯录",
    allowed: contact?.allowed !== false
  };
}

function identityKey(contact) {
  const value = publicContact(contact);
  return crypto.createHash("sha256").update(JSON.stringify({
    id: value.id,
    wxid: value.wxid,
    wechatId: value.wechatId,
    wechatAccountId: value.wechatAccountId,
    name: value.name,
    remark: value.remark,
    nickname: value.nickname
  })).digest("hex");
}

function taskSnapshotHash(task) {
  const snapshot = {
    script: String(task?.script ?? "").trim(),
    accountId: String(task?.wechat_account_id ?? "").trim(),
    contacts: (task?.results || []).map((result) => ({
      identity_hash: String(result?.identity_hash || identityKey(result?.contact)),
      contact: result?.contact
    }))
  };
  if (Number(task?.snapshot_hash_version || 1) >= 2) {
    snapshot.excluded = (task?.excluded_contacts || []).map((entry) => ({
      id: String(entry?.contact?.id || ""),
      reason_code: String(entry?.reason_code || "")
    }));
  }
  return crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function contactIdentityIndex(contacts) {
  const activeRows = contacts.filter((row) => row?.allowed !== false && row?.disabled !== true && row?.active !== false);
  const counts = (valueOf) => activeRows.reduce((result, row) => {
    const value = valueOf(row);
    result.set(value, (result.get(value) || 0) + 1);
    return result;
  }, new Map());
  return {
    names: counts(contactName),
    wechatIds: counts((row) => String(row?.wechatId ?? "").trim()),
    ids: counts((row) => String(row?.id ?? "").trim()),
    accounts: new Set(activeRows.map((row) => String(row?.wechatAccountId ?? "").trim()).filter(Boolean))
  };
}

function contactIdentityError(contacts, contact, index = contactIdentityIndex(contacts)) {
  const name = contactName(contact);
  const wechatId = String(contact?.wechatId ?? "").trim();
  const accountId = String(contact?.wechatAccountId ?? "").trim();
  if (contact?.allowed === false || contact?.disabled === true || contact?.active === false) return "contact_disabled";
  if (!String(contact?.id ?? "").trim() || !touchSearchName(contact)) return "contact_identity_missing";
  if (!wechatId) return "wechat_id_missing";
  if (!accountId) return "wechat_account_identity_missing";
  if (index.names.get(name) !== 1) return "contact_name_not_unique";
  if (index.wechatIds.get(wechatId) !== 1) return "contact_identity_not_unique";
  if (index.ids.get(String(contact?.id ?? "").trim()) !== 1) return "contact_identity_not_unique";
  if (index.accounts.size !== 1 || !index.accounts.has(accountId)) return "wechat_account_ambiguous";
  return "";
}

function classifyContacts(contacts = [], options = {}) {
  const rows = Array.isArray(contacts) ? contacts : [];
  const userExcludedIds = new Set((Array.isArray(options.excludedContactIds) ? options.excludedContactIds : []).map((id) => String(id).trim()).filter(Boolean));
  const eligible = [];
  const excluded = [];
  const labels = {
    contact_disabled: "联系人已停用或禁止触达",
    contact_identity_missing: "联系人身份或搜索名称缺失",
    wechat_id_missing: "微信号为空",
    wechat_account_identity_missing: "联系人未绑定同步微信账号",
    contact_name_not_unique: "联系人姓名重复",
    contact_identity_not_unique: "联系人微信号或身份不唯一",
    wechat_account_ambiguous: "联系人来自多个或无法确认的微信账号",
    user_excluded: "已移出本次触达"
  };
  const identityIndex = contactIdentityIndex(rows);
  for (const contact of rows) {
    const reasonCode = contactIdentityError(rows, contact, identityIndex);
    if (reasonCode) excluded.push({ contact: publicContact(contact), reason_code: reasonCode, reason: labels[reasonCode] || reasonCode });
    else if (userExcludedIds.has(String(contact?.id ?? "").trim())) excluded.push({ contact: publicContact(contact), reason_code: "user_excluded", reason: labels.user_excluded });
    else eligible.push(contact);
  }
  return {
    eligible,
    excluded,
    accountId: eligible.length ? String(eligible[0]?.wechatAccountId ?? "").trim() : ""
  };
}

function batchAuthorization(task, at = nowIso()) {
  const id = crypto.createHash("sha256").update([
    task.id,
    task.snapshot_hash,
    "full-task"
  ].join("\n")).digest("hex");
  return { id, scope: "task", authorized_at: at };
}

function isBatchAuthorized(task) {
  if (task?.execution_mode !== "real_send" || !task?.batch_authorization) return false;
  return task.batch_authorization.scope === "task"
    && task.batch_authorization.id === batchAuthorization(task, task.batch_authorization.authorized_at).id
    && Number.isInteger(task.current_index)
    && task.current_index >= 0
    && task.current_index < task.total;
}

function alignBatchWindow(task) {
  const size = Number(task?.batch_size) > 0 ? Number(task.batch_size) : BATCH_SIZE;
  const start = Math.floor(Math.max(0, Number(task?.current_index || 0)) / size) * size;
  task.current_batch = Math.floor(start / size) + 1;
  task.batch_start_index = start;
  task.batch_end_index = Math.min(start + size, Number(task?.total || 0));
  return task;
}

function authorizeTask(task, authorizedAt = nowIso()) {
  const normalized = alignBatchWindow(normalizeTask(task));
  if (normalized.execution_mode === "real_send" && normalized.current_index < normalized.total) {
    normalized.batch_authorization = batchAuthorization(normalized, authorizedAt);
  }
  return normalized;
}

function createTask(script, contacts, startedAt = nowIso(), options = {}) {
  const executionMode = options.executionMode === "real_send" ? "real_send" : "draft_only";
  const classification = executionMode === "real_send"
    ? options.classification || classifyContacts(contacts)
    : { eligible: contacts.filter((contact) => contact?.allowed !== false && touchSearchName(contact)), excluded: [], accountId: "" };
  const allowedContacts = classification.eligible;
  const results = allowedContacts.map((contact, contactIndex) => ({
    id: String(contact.id),
    request_id: crypto.randomUUID(),
    contact_index: contactIndex,
    identity_hash: identityKey(contact),
    name: contactName(contact) || String(contact.name ?? contact.id),
    contact: publicContact(contact),
    status: "pending",
    reason: "",
    message: "",
    ai_attempts: 0,
    outcome_unknown_retry_count: 0,
    outcome_unknown_attempt_keys: [],
    awaiting_resolution: false,
    updated_at: startedAt
  }));

  const task = {
    version: CURRENT_TASK_VERSION,
    snapshot_hash_version: 2,
    id: `touch-${crypto.randomUUID()}`,
    status: "running",
    execution_mode: executionMode,
    phase: executionMode === "real_send" ? "preparing_batch" : "running_draft",
    script: String(script ?? "").trim(),
    started_at: startedAt,
    updated_at: startedAt,
    completed_at: "",
    current_index: 0,
    total: results.length,
    eligible_total: results.length,
    excluded_total: classification.excluded.length,
    excluded_contacts: classification.excluded,
    user_excluded_ids: classification.excluded.filter((entry) => entry.reason_code === "user_excluded").map((entry) => String(entry.contact?.id || "")),
    wechat_account_id: classification.accountId,
    snapshot_hash: "",
    batch_size: BATCH_SIZE,
    current_batch: 1,
    batch_start_index: 0,
    batch_end_index: Math.min(BATCH_SIZE, results.length),
    batch_authorization: null,
    next_send_not_before: "",
    pause_reason: "",
    results
  };
  task.snapshot_hash = taskSnapshotHash(task);
  if (executionMode === "real_send") task.batch_authorization = batchAuthorization(task, startedAt);
  return task;
}

function emptyTask() {
  return {
    version: CURRENT_TASK_VERSION,
    snapshot_hash_version: 2,
    id: "",
    status: "idle",
    execution_mode: "draft_only",
    phase: "idle",
    script: "",
    started_at: "",
    updated_at: "",
    completed_at: "",
    current_index: 0,
    total: 0,
    eligible_total: 0,
    excluded_total: 0,
    excluded_contacts: [],
    user_excluded_ids: [],
    wechat_account_id: "",
    snapshot_hash: "",
    batch_size: BATCH_SIZE,
    current_batch: 1,
    batch_start_index: 0,
    batch_end_index: 0,
    batch_authorization: null,
    next_send_not_before: "",
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
    contact_index: Number.isInteger(result?.contact_index) ? result.contact_index : index,
    ai_attempts: Math.max(0, Number(result?.ai_attempts || 0)),
    outcome_unknown_retry_count: Math.max(0, Number(result?.outcome_unknown_retry_count || 0)),
    outcome_unknown_attempt_keys: Array.isArray(result?.outcome_unknown_attempt_keys) ? result.outcome_unknown_attempt_keys.map(String) : [],
    awaiting_resolution: result?.awaiting_resolution === true
  }));
  const rawVersion = Number(raw.version || 1);
  const version = rawVersion >= 3 && rawVersion <= CURRENT_TASK_VERSION ? CURRENT_TASK_VERSION : rawVersion >= 3 ? rawVersion : 2;
  const normalized = {
    ...emptyTask(),
    ...withoutGatewayFields,
    total,
    current_index: currentIndex,
    version,
    snapshot_hash_version: Number(raw.snapshot_hash_version || (rawVersion >= CURRENT_TASK_VERSION ? 2 : 1)),
    execution_mode: version >= 3 && raw.execution_mode === "real_send" ? "real_send" : "draft_only",
    phase: String(raw.phase || (version >= 3 ? "running_draft" : "legacy_draft")),
    batch_size: Number(raw.batch_size) > 0 ? Number(raw.batch_size) : BATCH_SIZE,
    current_batch: Number(raw.current_batch) > 0 ? Number(raw.current_batch) : 1,
    batch_start_index: Math.max(0, Number(raw.batch_start_index || 0)),
    batch_end_index: Math.max(0, Number(raw.batch_end_index || Math.min(BATCH_SIZE, total))),
    excluded_contacts: Array.isArray(raw.excluded_contacts) ? raw.excluded_contacts : [],
    user_excluded_ids: Array.isArray(raw.user_excluded_ids)
      ? raw.user_excluded_ids.map(String)
      : (Array.isArray(raw.excluded_contacts) ? raw.excluded_contacts : []).filter((entry) => entry?.reason_code === "user_excluded").map((entry) => String(entry?.contact?.id || "")),
    results: normalizedResults
  };
  if (normalized.phase === "awaiting_batch_continue") {
    normalized.phase = "paused";
    alignBatchWindow(normalized);
  } else if (normalized.current_index < normalized.total && normalized.current_index >= normalized.batch_end_index) {
    alignBatchWindow(normalized);
  }
  if (rawVersion > CURRENT_TASK_VERSION) {
    normalized.status = "blocked";
    normalized.phase = "paused";
    normalized.batch_authorization = null;
    normalized.pause_reason = "任务版本高于当前程序支持范围，已阻断执行";
    normalized.integrity_error = "unsupported_task_version";
  }
  return normalized;
}

function readExecutionState(baseDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(baseDir, "state.json"), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
}

function reconcileRealSendAttempt(task, executionState) {
  if (task.version < 3 || task.execution_mode !== "real_send") return task;
  const current = task.results[task.current_index];
  const context = executionState?.task_context;
  if (!current || !context || context.task_id !== task.id || String(context.contact_id) !== String(current.id) || Number(context.current_index) !== task.current_index) return task;
  const key = String(executionState.real_send_attempt_key || current.attempt_key || "");
  const attemptStatus = String((key && executionState.real_send_attempts?.[key]) || executionState.real_send_status || "");
  if (attemptStatus === "sent_verified") {
    current.status = "sent_verified";
    current.reason = "崩溃恢复时已与发送账本核对成功";
    current.attempt_key = key;
    current.retry_blocked = true;
    current.updated_at = nowIso();
    task.current_index += 1;
    task.next_send_not_before ||= new Date(Date.now() + sendDelayMs()).toISOString();
    if (task.current_index >= task.total) {
      task.status = "completed";
      task.phase = "completed";
      task.completed_at = task.completed_at || nowIso();
      task.pause_reason = "";
    } else if (task.current_index >= task.batch_end_index) {
      alignBatchWindow(task);
      task.phase = "preparing_batch";
    }
    return task;
  }
  if (["prepared", "clicked", "outcome_unknown"].includes(attemptStatus)) {
    current.status = attemptStatus;
    current.reason = attemptStatus === "outcome_unknown" ? "发送结果无法确认，等待恢复后再次核验" : "检测到可能已经执行发送点击，已永久阻断自动重试";
    current.attempt_key = key;
    if (attemptStatus === "outcome_unknown" && key && !current.outcome_unknown_attempt_keys.includes(key)) current.outcome_unknown_attempt_keys.push(key);
    current.awaiting_resolution = attemptStatus === "outcome_unknown" && current.outcome_unknown_retry_count >= 1;
    current.retry_blocked = attemptStatus !== "outcome_unknown" || current.awaiting_resolution;
    current.updated_at = nowIso();
    task.status = "paused";
    task.phase = current.awaiting_resolution ? "awaiting_unknown_resolution" : "paused";
    task.pause_reason = current.awaiting_resolution ? "补发后仍无法确认，请人工选择处理结果" : current.reason;
  }
  return task;
}

function readTaskFile(file) {
  const task = normalizeTask(JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")));
  if (!task.integrity_error && task.version >= 3 && task.execution_mode === "real_send" && task.snapshot_hash && taskSnapshotHash(task) !== task.snapshot_hash) {
    task.status = "blocked";
    task.phase = "paused";
    task.pause_reason = "任务联系人冻结快照校验失败，已阻断执行";
    task.integrity_error = "task_snapshot_changed";
  }
  return task;
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
  if (task.integrity_error === "unsupported_task_version") return task;
  if (task.status === "completed" || task.status === "stopped") return task;
  if (task.version >= 3 && task.execution_mode === "real_send") {
    const beforeIndex = task.current_index;
    reconcileRealSendAttempt(task, readExecutionState(baseDir));
    const unresolved = task.results[task.current_index];
    if (unresolved && ["prepared", "clicked", "outcome_unknown"].includes(unresolved.status)) {
      const canRetryUnknown = unresolved.status === "outcome_unknown" && unresolved.outcome_unknown_retry_count < 1;
      unresolved.awaiting_resolution = unresolved.status === "outcome_unknown" && !canRetryUnknown;
      unresolved.retry_blocked = !canRetryUnknown;
      unresolved.reason = unresolved.reason || (canRetryUnknown ? "发送结果无法确认，继续任务时会再次核验" : "检测到可能已经执行发送点击，已永久阻断自动重试");
      task.status = "paused";
      task.phase = unresolved.awaiting_resolution ? "awaiting_unknown_resolution" : "paused";
      task.pause_reason = unresolved.awaiting_resolution ? "补发后仍无法确认，请人工选择处理结果" : unresolved.reason;
      return saveTaskState(baseDir, task);
    }
    if (task.status === "completed" || task.results[task.current_index]?.retry_blocked) return saveTaskState(baseDir, task);
    if (task.status !== "running") {
      if (task.current_index !== beforeIndex) return saveTaskState(baseDir, task);
      return task;
    }
  } else if (task.status !== "running") {
    return task;
  }
  if (task.current_index >= task.total) {
    task.status = "completed";
    task.completed_at = task.completed_at || nowIso();
    task.pause_reason = "";
    return saveTaskState(baseDir, task);
  }

  task.status = "paused";
  task.pause_reason = "上次任务未完成，点击启动程序继续";
  const current = task.results[task.current_index];
  if (current?.status === "processing" || current?.status === "sending") {
    current.status = task.execution_mode === "real_send" && current.message ? "generated" : "pending";
    current.reason = "";
  }
  return saveTaskState(baseDir, task);
}

function authorizeNextBatch(task, authorizedAt = nowIso()) {
  const normalized = authorizeTask(task, authorizedAt);
  if (normalized.execution_mode !== "real_send" || normalized.current_index >= normalized.total) return normalized;
  normalized.status = "running";
  normalized.phase = "preparing_batch";
  normalized.pause_reason = "";
  return normalized;
}

function sendDelayMs(random = Math.random) {
  const value = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.round(8000 + value * 7000);
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
      version: normalized.version,
      execution_mode: normalized.execution_mode,
      phase: normalized.phase,
      current_index: normalized.current_index,
      total: normalized.total,
      eligible_total: normalized.eligible_total,
      excluded_total: normalized.excluded_total,
      excluded_contacts: normalized.excluded_contacts,
      user_excluded_ids: normalized.user_excluded_ids,
      wechat_account_id: normalized.wechat_account_id,
      snapshot_hash: normalized.snapshot_hash,
      batch_size: normalized.batch_size,
      current_batch: normalized.current_batch,
      batch_start_index: normalized.batch_start_index,
      batch_end_index: normalized.batch_end_index,
      next_send_not_before: normalized.next_send_not_before,
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
  const current = normalized.results[normalized.current_index];
  const unknownNeedsResolution = current?.status === "outcome_unknown" && (current?.awaiting_resolution || current?.outcome_unknown_retry_count >= 1);
  if (current?.status === "prepared" || current?.status === "clicked" || unknownNeedsResolution || (current?.retry_blocked && current?.status !== "outcome_unknown")) return false;
  return (
    !normalized.integrity_error &&
    normalized.status === "paused" &&
    normalized.current_index < normalized.total &&
    normalized.results.some((result) => ["pending", "processing", "blocked", "generated", "sending", "ai_failed", "ai_failed_skipped", "outcome_unknown"].includes(result.status))
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
  BATCH_SIZE,
  CURRENT_TASK_VERSION,
  TASK_FILE,
  TASK_BACKUP_FILE,
  authorizeNextBatch,
  authorizeTask,
  classifyContacts,
  contactIdentityError,
  contactName,
  cleanupTaskCache,
  createTask,
  emptyTask,
  fillTouchTemplate,
  hasUnfinishedPausedTask,
  isBatchAuthorized,
  loadTaskState,
  identityKey,
  publicTaskState,
  recoverInterruptedTask,
  reconcileRealSendAttempt,
  saveTaskState,
  sendDelayMs,
  taskBackupPath,
  taskPath,
  touchSearchName
};
