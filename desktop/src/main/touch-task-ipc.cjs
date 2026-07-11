const { app, BrowserWindow, ipcMain, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { generatePersonalizedDraft } = require("./ai-draft.cjs");
const { runActiveTouch } = require("./active-touch-ipc.cjs");
const { preloadFile } = require("./edition.cjs");
const {
  cleanupTaskCache,
  createTask,
  hasUnfinishedPausedTask,
  loadTaskState,
  publicTaskState,
  recoverInterruptedTask,
  saveTaskState
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
    floatingWindow.loadFile(path.join(__dirname, "../../dist/index.html"), { query: { floating: "1" } });
  }

  return floatingWindow;
}

function emitTaskUpdate() {
  const payload = publicTaskState(loadTaskState(activeTouchDir()));
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) window.webContents.send("touch-task:update", payload);
  });
  return payload;
}

function pauseTask(task, reason, resultIndex = task.current_index) {
  const nextTask = { ...task, status: "paused", pause_reason: reason };
  const result = nextTask.results[resultIndex];
  if (result) {
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

async function runTaskLoop() {
  if (runnerActive) return;
  runnerActive = true;

  try {
    let initialTask = loadTaskState(activeTouchDir());
    const initialResult = initialTask.results[initialTask.current_index];
    if (!initialResult) return;
    const calibrated = await runStep(initialTask, initialResult, "calibrate", [], "窗口校准失败");
    if (!calibrated.ok) {
      pauseTask(loadTaskState(activeTouchDir()), calibrated.reason);
      return;
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
      task.current_index = index + 1;
      if (task.current_index >= task.total) {
        task.status = "completed";
        task.completed_at = new Date().toISOString();
      }
      task.pause_reason = "";
      saveTaskState(activeTouchDir(), task);
      emitTaskUpdate();
    }

    if (stopRequested) {
      updateCurrentTask((task) => {
        task.status = "stopped";
        task.pause_reason = "用户已停止";
        const current = task.results[task.current_index];
        if (current && current.status === "processing") {
          current.status = "pending";
          current.reason = "";
        }
      });
    } else if (pauseRequested) {
      updateCurrentTask((task) => {
        task.status = "paused";
        task.pause_reason = task.pause_reason || "用户已暂停";
        const current = task.results[task.current_index];
        if (current && current.status === "processing") {
          current.status = "pending";
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
  const contacts = readContacts().filter((contact) => contact?.allowed !== false);
  if (!contacts.length) {
    return { ok: false, error: "请先同步当前微信联系人" };
  }

  const existing = loadTaskState(activeTouchDir());
  if (existing.integrity_error) return { ok: false, error: existing.pause_reason };
  if (existing.status === "running" && existing.current_index < existing.total) {
    return { ok: true, task: existing };
  }

  if (hasUnfinishedPausedTask(existing, script)) {
    existing.status = "running";
    existing.pause_reason = "";
    const current = existing.results[existing.current_index];
    if (current && (current.status === "blocked" || current.status === "processing")) {
      current.status = "pending";
      current.reason = "";
    }
    return { ok: true, task: existing };
  }

  return { ok: true, task: createTask(script, contacts) };
}

function registerTouchTaskIpc({ getMainWindow, dataDir, coordinator, deepSeekClient: client, onPause } = {}) {
  getMainWindowRef = getMainWindow;
  runtimeDataDir = String(dataDir || "");
  runtimeCoordinator = coordinator;
  deepSeekClient = client || null;
  cleanupTaskCache(activeTouchDir());
  recoverInterruptedTask(activeTouchDir());

  ipcMain.handle("touch-task:start", async (_event, payload = {}) => {
    const script = String(payload.script ?? "").trim();
    if (!script) return { ok: false, error: "请先填写触达话术" };

    pauseRequested = false;
    stopRequested = false;
    const runnable = buildRunnableTask(script);
    if (!runnable.ok) return runnable;
    try { deepSeekClient?.assertAvailable(); } catch (error) { return { ok: false, error: String(error?.message || "请先保存 DeepSeek API Key。") }; }
    const lock = runtimeCoordinator?.acquire({ state: "touching", taskId: runnable.task.id, account: "unknown", phase: "starting" });
    if (lock && !lock.ok) return { ok: false, error: "当前正在进行联系人同步或其他微信操作，请完成后再启动触达任务。", blocked_reason: lock.error };
    runnerOwner = lock?.lock.owner || "";
    saveTaskState(activeTouchDir(), runnable.task);

    if (!(await focusWechatBeforeTask(runnable.task))) {
      if (runnerOwner) runtimeCoordinator?.release(runnerOwner);
      runnerOwner = "";
      return publicTaskState(loadTaskState(activeTouchDir()));
    }

    createFloatingWindow();
    const mainWindow = getMainWindow?.();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();

    void runTaskLoop();
    return emitTaskUpdate();
  });

  ipcMain.handle("touch-task:status", () => publicTaskState(loadTaskState(activeTouchDir())));

  ipcMain.handle("touch-task:pause", () => {
    onPause?.();
    pauseRequested = true;
    if (runnerOwner) runtimeCoordinator?.transition(runnerOwner, "paused", "pause_requested");
    updateCurrentTask((task) => {
      if (task.status === "running") {
        task.status = "paused";
        task.pause_reason = "用户已暂停";
      }
    });
    return publicTaskState(loadTaskState(activeTouchDir()));
  });

  ipcMain.handle("touch-task:resume", async () => {
    const task = loadTaskState(activeTouchDir());
    if (task.status !== "paused") return publicTaskState(task);
    if (task.integrity_error) return publicTaskState(task);
    const lock = runtimeCoordinator?.acquire({ state: "touching", taskId: task.id, account: "unknown", phase: "resuming" });
    if (lock && !lock.ok) return { ok: false, error: "当前正在进行联系人同步或其他微信操作，请完成后再继续触达任务。", blocked_reason: lock.error };
    runnerOwner = lock?.lock.owner || "";
    pauseRequested = false;
    stopRequested = false;
    task.status = "running";
    task.pause_reason = "";
    const current = task.results[task.current_index];
    if (current && (current.status === "blocked" || current.status === "processing")) {
      current.status = "pending";
      current.reason = "";
    }
    saveTaskState(activeTouchDir(), task);
    try {
      deepSeekClient?.assertAvailable();
    } catch (error) {
      pauseTask(loadTaskState(activeTouchDir()), String(error?.message || "请先保存 DeepSeek API Key。"));
      if (runnerOwner) runtimeCoordinator?.release(runnerOwner);
      runnerOwner = "";
      return publicTaskState(loadTaskState(activeTouchDir()));
    }
    if (!(await focusWechatBeforeTask(task))) {
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
    return publicTaskState(loadTaskState(activeTouchDir()));
  });

  ipcMain.handle("touch-task:show-main", () => {
    showMainWindow();
    return publicTaskState(loadTaskState(activeTouchDir()));
  });

  ipcMain.handle("touch-task:close-floating", () => {
    onPause?.();
    showMainWindow();
    if (floatingWindow && !floatingWindow.isDestroyed()) floatingWindow.close();
    return publicTaskState(loadTaskState(activeTouchDir()));
  });
}

module.exports = { registerTouchTaskIpc };
