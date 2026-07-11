const { app, BrowserWindow, ipcMain, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { generatePersonalizedDraft } = require("./ai-draft.cjs");
const { runActiveTouch } = require("./active-touch-ipc.cjs");
const { preloadFile, rendererDir = "dist" } = require("./edition.cjs");
const {
  authorizeNextBatch,
  classifyContacts,
  cleanupTaskCache,
  createTask,
  hasUnfinishedPausedTask,
  isBatchAuthorized,
  loadTaskState,
  publicTaskState,
  recoverInterruptedTask,
  saveTaskState,
  sendDelayMs
} = require("../../rpa/active_touch/touch_task_state.cjs");

let floatingWindow = null;
let runnerActive = false;
let pauseRequested = false;
let stopRequested = false;
let getMainWindowRef = null;
let runtimeDataDir = "";
let runtimeCoordinator = null;
let runnerOwner = "";
let deepSeekClient = null;
let executionMode = "draft_only";
let realSendExecutor = null;
let waitForDelay = null;
let randomSource = Math.random;
const consumedBatchTokens = new Set();

function consumeBatchAuthorization(payload = {}) {
  if (executionMode !== "real_send") return true;
  const token = String(payload.clickToken || "");
  if (!token || consumedBatchTokens.has(token)) return false;
  consumedBatchTokens.add(token);
  if (consumedBatchTokens.size > 200) consumedBatchTokens.delete(consumedBatchTokens.values().next().value);
  return true;
}

function activeTouchDir() {
  return runtimeDataDir || path.join(app.getPath("userData"), "data", "active_touch");
}

function contactsPath() {
  return path.join(activeTouchDir(), "contacts.json");
}

function readContacts() {
  try {
    const file = contactsPath();
    if (!fs.existsSync(file)) return [];
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function resultCode(result) {
  return String(result?.blocked_reason || result?.state?.blocked_reason || "");
}

function resultReason(result, fallback) {
  const code = resultCode(result);
  const labels = {
    wechat_window_not_found: "未找到微信聊天主窗口，已尝试自动拉起；若停在登录确认，请先完成微信登录",
    wechat_login_required: "微信已自动拉起，请在手机上确认登录后继续",
    wechat_focus_failed: "微信窗口没有切到前台，请点一下微信窗口后再继续",
    contact_unavailable: "该联系人已停用，已自动跳过",
    search_result_not_opened: "未打开匹配联系人会话",
    customer_conversation_not_found: "未定位到客户会话",
    message_input_failed: "草稿输入失败，未能定位微信输入框",
    conversation_not_verified: "会话未验证",
    empty_message: "触达内容为空",
    message_not_input: "消息尚未写入草稿",
    message_draft_changed: "输入框内容与已校验草稿不一致"
  };
  return String(result?.error || labels[code] || code || fallback || "执行失败");
}

function getDevFloatingUrl() {
  const baseUrl = process.env.VITE_DEV_SERVER_URL;
  if (!baseUrl) return "";
  const joiner = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${joiner}floating=1`;
}

function showMainWindow() {
  const mainWindow = getMainWindowRef?.();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
}

function createFloatingWindow() {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.show();
    floatingWindow.focus();
    return floatingWindow;
  }

  floatingWindow = new BrowserWindow({
    width: 292,
    height: 286,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    title: "触达进度",
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, preloadFile),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  floatingWindow.setMenu(null);
  const { workArea } = screen.getPrimaryDisplay();
  floatingWindow.setPosition(workArea.x + workArea.width - 314, workArea.y + Math.round((workArea.height - 286) / 2));
  floatingWindow.on("close", () => {
    showMainWindow();
  });
  floatingWindow.on("closed", () => {
    floatingWindow = null;
  });

  const devUrl = getDevFloatingUrl();
  if (devUrl) {
    floatingWindow.loadURL(devUrl);
  } else {
    floatingWindow.loadFile(path.join(__dirname, `../../${rendererDir}/index.html`), { query: { floating: "1" } });
  }

  return floatingWindow;
}

function contactPreview(task = loadTaskState(activeTouchDir())) {
  if (task.id && task.results.length && !["idle", "completed", "stopped"].includes(task.status)) {
    return {
      frozen: true,
      eligible: task.results.map((result) => result.contact),
      excluded: task.excluded_contacts || [],
      total: Number(task.eligible_total || task.results.length) + Number(task.excluded_total || 0)
    };
  }
  const rows = readContacts();
  if (executionMode === "real_send") {
    const classified = classifyContacts(rows);
    return {
      frozen: false,
      eligible: classified.eligible.map((contact) => ({ ...contact })),
      excluded: classified.excluded,
      total: rows.length
    };
  }
  const eligible = rows.filter((contact) => contact?.allowed !== false);
  return { frozen: false, eligible, excluded: [], total: rows.length };
}

function taskPayload(task = loadTaskState(activeTouchDir())) {
  return { ...publicTaskState(task), preview: contactPreview(task), execution_mode: executionMode };
}

function emitTaskUpdate() {
  const payload = taskPayload();
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) window.webContents.send("touch-task:update", payload);
  });
  return payload;
}

function pauseTask(task, reason, resultIndex = task.current_index) {
  const nextTask = { ...task, status: "paused", pause_reason: reason };
  const result = nextTask.results[resultIndex];
  if (result && !["prepared", "clicked", "sent_verified", "outcome_unknown", "ai_failed_skipped", "identity_skipped"].includes(result.status)) {
    result.status = "blocked";
    result.reason = reason;
    result.updated_at = new Date().toISOString();
  }
  const saved = saveTaskState(activeTouchDir(), nextTask);
  emitTaskUpdate();
  return saved;
}

function updateCurrentTask(mutator) {
  const task = loadTaskState(activeTouchDir());
  mutator(task);
  const saved = saveTaskState(activeTouchDir(), task);
  emitTaskUpdate();
  return saved;
}

function taskCommandArgs(task, result) {
  return ["--task-id", task.id, "--contact-id", result.id, "--current-index", String(task.current_index)];
}

async function runStep(task, result, command, args, blockReason) {
  runtimeCoordinator?.update(runnerOwner, command);
  const commandArgs = [...args, ...taskCommandArgs(task, result)];
  const response = await runActiveTouch([command, ...commandArgs], { owner: runnerOwner, workflow: "touching", phase: command });
  if (!response.ok) return { ok: false, reason: resultReason(response, blockReason), result: response };
  return { ok: true, result: response };
}

async function draftMessageForContact(task, result) {
  const existingMessage = String(result?.message || "").trim();
  if (existingMessage) return { message: existingMessage, usedAi: result.ai_status === "generated", reason: result.ai_reason || "" };
  if (!deepSeekClient) throw new Error("DeepSeek 服务未初始化，任务已暂停。");
  return generatePersonalizedDraft({ client: deepSeekClient, task, result });
}

function shouldSkipBlockedContact(result) {
  return resultCode(result) === "contact_unavailable";
}

function shouldContinueRunning() {
  if (pauseRequested || stopRequested) return false;
  return loadTaskState(activeTouchDir()).status === "running";
}

async function focusWechatBeforeTask(task) {
  const current = task.results[task.current_index];
  if (!current) return false;
  const step = await runStep(task, current, "focus-wechat-window", [], "微信窗口没有切到前台");
  if (step.ok) return true;
  pauseTask(loadTaskState(activeTouchDir()), step.reason);
  return false;
}

function isIdentitySkip(result) {
  return new Set([
    "contact_unavailable",
    "customer_not_allowed",
    "contact_snapshot_changed",
    "contact_disabled",
    "contact_identity_missing",
    "wechat_id_missing",
    "wechat_account_identity_missing",
    "contact_name_not_unique",
    "contact_identity_not_unique"
  ]).has(resultCode(result));
}

function advanceTask(task, index) {
  task.current_index = index + 1;
  task.pause_reason = "";
  if (task.current_index >= task.total) {
    task.status = "completed";
    task.phase = "completed";
    task.completed_at = new Date().toISOString();
  } else if (task.execution_mode === "real_send" && task.current_index >= task.batch_end_index) {
    task.status = "paused";
    task.phase = "awaiting_batch_continue";
    task.pause_reason = `第 ${task.current_batch} 批已完成，点击继续下一批`;
  }
  return saveTaskState(activeTouchDir(), task);
}

async function prepareCurrentBatch() {
  let task = loadTaskState(activeTouchDir());
  if (task.execution_mode !== "real_send") return task;
  task.phase = "preparing_batch";
  saveTaskState(activeTouchDir(), task);
  emitTaskUpdate();

  for (let index = task.current_index; index < task.batch_end_index; index += 1) {
    if (!shouldContinueRunning()) break;
    task = loadTaskState(activeTouchDir());
    const result = task.results[index];
    if (!result || ["generated", "ai_failed_skipped", "identity_skipped", "sent_verified"].includes(result.status)) continue;
    try {
      const draft = await draftMessageForContact(task, result);
      result.status = "generated";
      result.reason = "文案已准备";
      result.message = draft.message;
      result.ai_status = draft.usedAi ? "generated" : "fallback";
      result.ai_reason = draft.reason;
    } catch (error) {
      result.status = "ai_failed_skipped";
      result.reason = String(error?.message || "DeepSeek 文案生成失败，已跳过该联系人");
      result.ai_status = "failed";
      result.ai_reason = result.reason;
    }
    result.updated_at = new Date().toISOString();
    saveTaskState(activeTouchDir(), task);
    emitTaskUpdate();
  }

  task = loadTaskState(activeTouchDir());
  if (task.status === "running") {
    task.phase = "sending_batch";
    saveTaskState(activeTouchDir(), task);
    emitTaskUpdate();
  }
  return task;
}

async function waitUntilSendAllowed() {
  const task = loadTaskState(activeTouchDir());
  if (!task.next_send_not_before) return true;
  if (typeof waitForDelay === "function") {
    await waitForDelay(task.next_send_not_before);
    return shouldContinueRunning();
  }
  while (shouldContinueRunning()) {
    const remaining = Date.parse(loadTaskState(activeTouchDir()).next_send_not_before || "") - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
  }
  return false;
}

function persistRealSendTransition(index, status, executionState = {}) {
  const task = loadTaskState(activeTouchDir());
  const result = task.results[index];
  if (!result || task.current_index !== index) throw new Error("task_contact_changed_before_send_transition");
  result.status = status;
  result.attempt_key = String(executionState.real_send_attempt_key || result.attempt_key || "");
  result.retry_blocked = ["prepared", "clicked", "sent_verified", "outcome_unknown"].includes(status);
  result.reason = status === "sent_verified" ? "发送成功并已验证最新消息气泡" : status === "outcome_unknown" ? "发送结果无法确认，已暂停且绝不自动重试" : "";
  result.updated_at = new Date().toISOString();
  if (status === "outcome_unknown") {
    task.status = "paused";
    task.phase = "paused";
    task.pause_reason = result.reason;
  }
  saveTaskState(activeTouchDir(), task);
  emitTaskUpdate();
}

async function runRealContact(task, current, index) {
  if (typeof realSendExecutor !== "function") {
    pauseTask(task, "受控试用版真实发送执行器未包含", index);
    return false;
  }
  if (!isBatchAuthorized(task)) {
    pauseTask(task, "本批用户授权无效，已阻断真实发送", index);
    return false;
  }
  if (!(await waitUntilSendAllowed())) return false;

  task = loadTaskState(activeTouchDir());
  const sending = task.results[index];
  sending.status = "sending";
  sending.reason = "正在重新验证微信窗口和当前会话";
  sending.updated_at = new Date().toISOString();
  saveTaskState(activeTouchDir(), task);
  emitTaskUpdate();

  const response = await realSendExecutor({
    baseDir: activeTouchDir(),
    contactId: current.id,
    message: current.message,
    frozenContact: current.contact,
    authorized: true,
    runStep: async (command, args = []) => {
      const latest = loadTaskState(activeTouchDir());
      const latestResult = latest.results[index];
      const step = await runStep(latest, latestResult, command, args, "微信操作未通过安全校验");
      return step.ok ? step.result : { ...step.result, ok: false, error: step.reason };
    },
    onTransition: (status, executionState) => persistRealSendTransition(index, status, executionState)
  });

  task = loadTaskState(activeTouchDir());
  const result = task.results[index];
  if (response?.ok && response?.state?.real_send_status === "sent_verified") {
    result.status = "sent_verified";
    result.reason = "发送成功并已验证最新消息气泡";
    result.retry_blocked = true;
    result.attempt_key = String(response.state.real_send_attempt_key || result.attempt_key || "");
    result.updated_at = new Date().toISOString();
    task.next_send_not_before = new Date(Date.now() + sendDelayMs(randomSource)).toISOString();
    advanceTask(task, index);
    emitTaskUpdate();
    return true;
  }
  if (isIdentitySkip(response)) {
    result.status = "identity_skipped";
    result.reason = resultReason(response, "联系人身份无法唯一确认，已跳过");
    result.updated_at = new Date().toISOString();
    advanceTask(task, index);
    emitTaskUpdate();
    return true;
  }
  const dangerous = ["prepared", "clicked", "outcome_unknown"].includes(result.status) || result.retry_blocked;
  pauseTask(task, dangerous ? (result.reason || "发送结果无法安全确认，已暂停且不会自动重试") : resultReason(response, "真实发送未通过安全校验"), index);
  return false;
}

async function runTaskLoop() {
  if (runnerActive) return;
  runnerActive = true;

  try {
    let initialTask = await prepareCurrentBatch();
    if (!initialTask.results[initialTask.current_index]) return;
    if (initialTask.execution_mode !== "real_send") {
      const initialResult = initialTask.results[initialTask.current_index];
      const calibrated = await runStep(initialTask, initialResult, "calibrate", [], "窗口校准失败");
      if (!calibrated.ok) {
        pauseTask(loadTaskState(activeTouchDir()), calibrated.reason);
        return;
      }
    }

    while (shouldContinueRunning()) {
      let task = loadTaskState(activeTouchDir());
      if (task.current_index >= task.total) {
        task.status = "completed";
        task.completed_at = new Date().toISOString();
        task.pause_reason = "";
        saveTaskState(activeTouchDir(), task);
        emitTaskUpdate();
        break;
      }

      const index = task.current_index;
      const current = task.results[index];
      if (!current) {
        task.status = "completed";
        task.completed_at = new Date().toISOString();
        task.pause_reason = "";
        saveTaskState(activeTouchDir(), task);
        emitTaskUpdate();
        break;
      }

      if (task.execution_mode === "real_send" && current.status === "ai_failed_skipped") {
        advanceTask(task, index);
        emitTaskUpdate();
        continue;
      }

      if (task.execution_mode === "real_send") {
        if (current.status !== "generated") {
          pauseTask(task, "当前联系人文案尚未准备，任务已暂停", index);
          break;
        }
        if (!(await runRealContact(task, current, index))) break;
        continue;
      }

      const draft = await draftMessageForContact(task, current);
      const message = draft.message;
      current.status = "processing";
      current.reason = "";
      current.message = message;
      current.ai_status = draft.usedAi ? "generated" : "fallback";
      current.ai_reason = draft.reason;
      current.updated_at = new Date().toISOString();
      task.pause_reason = "";
      saveTaskState(activeTouchDir(), task);
      emitTaskUpdate();

      let step = await runStep(task, current, "select-customer", ["--id", current.id], "未找到联系人");
      if (!step.ok) {
        pauseTask(loadTaskState(activeTouchDir()), step.reason, index);
        break;
      }

      if (!shouldContinueRunning()) break;
      step = await runStep(task, current, "click-search-result-dry-run", [], "未找到微信窗口或未打开联系人会话");
      if (!step.ok) {
        if (shouldSkipBlockedContact(step.result)) {
          task = loadTaskState(activeTouchDir());
          const skipped = task.results[index];
          if (skipped) {
            skipped.status = "skipped";
            skipped.reason = `${step.reason}，已跳过`;
            skipped.message = message;
            skipped.updated_at = new Date().toISOString();
          }
          task.current_index = index + 1;
          task.pause_reason = "";
          saveTaskState(activeTouchDir(), task);
          emitTaskUpdate();
          continue;
        }
        pauseTask(loadTaskState(activeTouchDir()), step.reason, index);
        break;
      }

      if (!shouldContinueRunning()) break;
      step = await runStep(task, current, "input-message-dry-run", ["--message", message], "草稿输入失败");
      if (!step.ok) {
        pauseTask(loadTaskState(activeTouchDir()), step.reason, index);
        break;
      }

      if (!shouldContinueRunning()) break;
      step = await runStep(task, current, "send", ["--dry-run", "--message", message], "发前安全检查未通过");
      if (!step.ok) {
        pauseTask(loadTaskState(activeTouchDir()), step.reason, index);
        break;
      }

      if (!shouldContinueRunning()) break;
      task = loadTaskState(activeTouchDir());
      const done = task.results[index];
      if (done) {
        done.status = "draft_ready";
        done.reason = "草稿已填，预检通过";
        done.message = message;
        done.updated_at = new Date().toISOString();
      }
      advanceTask(task, index);
      emitTaskUpdate();
    }

    if (stopRequested) {
      updateCurrentTask((task) => {
        task.status = "stopped";
        task.pause_reason = "用户已停止";
        const current = task.results[task.current_index];
        if (current && (current.status === "processing" || current.status === "sending")) {
          current.status = task.execution_mode === "real_send" && current.message ? "generated" : "pending";
          current.reason = "";
        }
      });
    } else if (pauseRequested) {
      updateCurrentTask((task) => {
        task.status = "paused";
        task.pause_reason = task.pause_reason || "用户已暂停";
        const current = task.results[task.current_index];
        if (current && (current.status === "processing" || current.status === "sending")) {
          current.status = task.execution_mode === "real_send" && current.message ? "generated" : "pending";
          current.reason = "用户已暂停";
        }
      });
    }
  } catch (error) {
    const detail = String(error?.message || "unknown_error");
    if (runnerOwner) runtimeCoordinator?.transition(runnerOwner, "paused", "internal_error");
    pauseTask(loadTaskState(activeTouchDir()), `执行异常已暂停：${detail}`);
  } finally {
    runnerActive = false;
    pauseRequested = false;
    stopRequested = false;
    if (runnerOwner) runtimeCoordinator?.release(runnerOwner);
    runnerOwner = "";
    emitTaskUpdate();
  }
}

function buildRunnableTask(script) {
  const contacts = readContacts();
  const available = executionMode === "real_send" ? classifyContacts(contacts).eligible : contacts.filter((contact) => contact?.allowed !== false);
  if (!available.length) {
    return { ok: false, error: "请先同步当前微信联系人" };
  }

  const existing = loadTaskState(activeTouchDir());
  if (existing.integrity_error) return { ok: false, error: existing.pause_reason };
  if (existing.status === "running" && existing.current_index < existing.total && existing.execution_mode === executionMode) {
    return { ok: true, task: existing };
  }

  if (executionMode === "real_send" && existing.version < 3 && existing.current_index < existing.total && ["running", "paused"].includes(existing.status)) {
    return { ok: false, blocked_reason: "legacy_draft_task", error: "检测到旧版草稿任务，已阻断自动升级为真实发送；请先停止旧任务" };
  }

  if (hasUnfinishedPausedTask(existing, script)) {
    if (existing.execution_mode !== executionMode) return { ok: false, blocked_reason: "task_execution_mode_changed", error: "未完成任务的执行模式不同，请先停止旧任务" };
    const current = existing.results[existing.current_index];
    if (current?.retry_blocked || ["prepared", "clicked", "outcome_unknown"].includes(current?.status)) {
      return { ok: false, blocked_reason: "outcome_unknown", error: "当前联系人可能已经执行发送，任务不会自动重试" };
    }
    if (existing.phase === "awaiting_batch_continue") return { ok: true, task: authorizeNextBatch(existing) };
    existing.status = "running";
    existing.pause_reason = "";
    if (current && (current.status === "blocked" || current.status === "processing")) {
      current.status = existing.execution_mode === "real_send" && current.message ? "generated" : "pending";
      current.reason = "";
    }
    return { ok: true, task: existing };
  }

  return { ok: true, task: createTask(script, contacts, new Date().toISOString(), { executionMode }) };
}

function registerTouchTaskIpc({ getMainWindow, dataDir, coordinator, deepSeekClient: client, onPause, executionMode: mode, realSendExecutor: executor, waitForDelay: wait, random } = {}) {
  getMainWindowRef = getMainWindow;
  runtimeDataDir = String(dataDir || "");
  runtimeCoordinator = coordinator;
  deepSeekClient = client || null;
  executionMode = mode === "real_send" ? "real_send" : "draft_only";
  realSendExecutor = typeof executor === "function" ? executor : null;
  waitForDelay = typeof wait === "function" ? wait : null;
  randomSource = typeof random === "function" ? random : Math.random;
  cleanupTaskCache(activeTouchDir());
  recoverInterruptedTask(activeTouchDir());

  function requestPause(reason = "用户已暂停") {
    onPause?.();
    pauseRequested = true;
    if (runnerOwner) runtimeCoordinator?.transition(runnerOwner, "paused", "pause_requested");
    updateCurrentTask((task) => {
      if (task.status === "running") {
        task.status = "paused";
        task.phase = task.phase === "awaiting_batch_continue" ? task.phase : "paused";
        task.pause_reason = reason;
      }
    });
    return taskPayload();
  }

  ipcMain.handle("touch-task:start", async (_event, payload = {}) => {
    const script = String(payload.script ?? "").trim();
    if (!script) return { ok: false, error: "请先填写触达话术" };
    if (!consumeBatchAuthorization(payload)) return { ok: false, blocked_reason: "trusted_batch_click_required", error: "请本人点击启动程序授权本批触达" };

    pauseRequested = false;
    stopRequested = false;
    const runnable = buildRunnableTask(script);
    if (!runnable.ok) return runnable;
    try { deepSeekClient?.assertAvailable(); } catch (error) { return { ok: false, error: String(error?.message || "请先保存 DeepSeek API Key。") }; }
    const lock = runtimeCoordinator?.acquire({ state: "touching", taskId: runnable.task.id, account: "unknown", phase: "starting" });
    if (lock && !lock.ok) return { ok: false, error: "当前正在进行联系人同步或其他微信操作，请完成后再启动触达任务。", blocked_reason: lock.error };
    runnerOwner = lock?.lock.owner || "";
    saveTaskState(activeTouchDir(), runnable.task);

    createFloatingWindow();
    const mainWindow = getMainWindow?.();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();

    void runTaskLoop();
    return emitTaskUpdate();
  });

  ipcMain.handle("touch-task:status", () => taskPayload());

  ipcMain.handle("touch-task:pause", () => requestPause());

  ipcMain.handle("touch-task:resume", async (_event, payload = {}) => {
    const task = loadTaskState(activeTouchDir());
    if (task.status !== "paused") return publicTaskState(task);
    if (task.integrity_error) return publicTaskState(task);
    const currentBeforeResume = task.results[task.current_index];
    if (currentBeforeResume?.retry_blocked || ["prepared", "clicked", "outcome_unknown"].includes(currentBeforeResume?.status)) return taskPayload(task);
    if (!consumeBatchAuthorization(payload)) return { ok: false, blocked_reason: "trusted_batch_click_required", error: "请本人点击继续下一批" };
    const lock = runtimeCoordinator?.acquire({ state: "touching", taskId: task.id, account: "unknown", phase: "resuming" });
    if (lock && !lock.ok) return { ok: false, error: "当前正在进行联系人同步或其他微信操作，请完成后再继续触达任务。", blocked_reason: lock.error };
    runnerOwner = lock?.lock.owner || "";
    pauseRequested = false;
    stopRequested = false;
    const resumed = task.phase === "awaiting_batch_continue" ? authorizeNextBatch(task) : task;
    resumed.status = "running";
    resumed.pause_reason = "";
    const current = resumed.results[resumed.current_index];
    if (current && (current.status === "blocked" || current.status === "processing")) {
      current.status = resumed.execution_mode === "real_send" && current.message ? "generated" : "pending";
      current.reason = "";
    }
    saveTaskState(activeTouchDir(), resumed);
    try {
      deepSeekClient?.assertAvailable();
    } catch (error) {
      pauseTask(loadTaskState(activeTouchDir()), String(error?.message || "请先保存 DeepSeek API Key。"));
      if (runnerOwner) runtimeCoordinator?.release(runnerOwner);
      runnerOwner = "";
      return publicTaskState(loadTaskState(activeTouchDir()));
    }
    createFloatingWindow();
    void runTaskLoop();
    return emitTaskUpdate();
  });

  ipcMain.handle("touch-task:stop", () => {
    onPause?.();
    stopRequested = true;
    if (runnerOwner) runtimeCoordinator?.transition(runnerOwner, "stopping", "stop_requested");
    updateCurrentTask((task) => {
      if (task.status === "running" || task.status === "paused") {
        task.status = "stopped";
        task.pause_reason = "用户已停止";
      }
    });
    return taskPayload();
  });

  ipcMain.handle("touch-task:show-main", () => {
    showMainWindow();
    return taskPayload();
  });

  ipcMain.handle("touch-task:close-floating", () => {
    requestPause("进度窗口已关闭，任务已暂停");
    showMainWindow();
    if (floatingWindow && !floatingWindow.isDestroyed()) floatingWindow.close();
    return taskPayload();
  });

  return { pause: requestPause };
}

module.exports = { registerTouchTaskIpc };
