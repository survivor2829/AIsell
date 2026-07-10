const { app, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");

let runtimeDataDir = "";
let runtimeCoordinator = null;

function cliPath(development = false) {
  return path.join(app.getAppPath(), "rpa", "active_touch", development ? "active_touch_cli.dev.cjs" : "active_touch_cli.cjs");
}

function executeActiveTouch(args, development = false) {
  return new Promise((resolve) => {
    const childArgs = runtimeDataDir ? [...args, "--data-dir", runtimeDataDir] : args;
    const executable = cliPath(development);
    const child = spawn(process.execPath, [executable, ...childArgs], {
      cwd: path.dirname(executable),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolve({ ok: false, action: args[0] ?? "status", error: error.message, logs: [] });
    });

    child.on("close", () => {
      try {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "{}";
        resolve(JSON.parse(line));
      } catch {
        resolve({ ok: false, action: args[0] ?? "status", error: stderr || stdout || "active-touch executor failed", logs: [] });
      }
    });
  });
}

async function runActiveTouch(args, options = {}) {
  const development = options.development === true;
  const command = args[0] ?? "status";
  if (command === "status") return executeActiveTouch(args, development);

  if (options.owner) {
    const updated = runtimeCoordinator?.update(options.owner, options.phase || command);
    if (updated && !updated.ok) return { ok: false, action: command, blocked_reason: updated.error, error: "微信操作锁已失效", logs: [] };
    return executeActiveTouch(args, development);
  }

  const lock = runtimeCoordinator?.acquire({ state: "preparing_campaign", taskId: "", account: "unknown", phase: `developer:${command}` });
  if (lock && !lock.ok) return { ok: false, action: command, blocked_reason: lock.error, error: "当前正在进行联系人同步或主动触达，开发命令已禁用", logs: [] };
  try {
    return await executeActiveTouch(args, development);
  } finally {
    if (lock?.lock?.owner) runtimeCoordinator?.release(lock.lock.owner);
  }
}

function runActiveTouchDev(args) {
  return runActiveTouch(args, { development: true });
}

function registerActiveTouchIpc({ dataDir, coordinator } = {}) {
  runtimeDataDir = String(dataDir || "");
  runtimeCoordinator = coordinator;
  ipcMain.handle("active-touch:status", () => runActiveTouch(["status"]));
  ipcMain.handle("active-touch:calibrate", () => runActiveTouch(["calibrate"]));
  ipcMain.handle("active-touch:clear-customer", () => runActiveTouch(["clear-customer"]));
  ipcMain.handle("active-touch:send-dry-run", (_event, payload = {}) =>
    runActiveTouch(["send", "--dry-run", "--message", String(payload.message ?? "")])
  );
  ipcMain.handle("active-touch:select-customer", (_event, payload = {}) => runActiveTouch(["select-customer", "--id", String(payload.id ?? "")]));
  ipcMain.handle("active-touch:verify-conversation", (_event, payload = {}) =>
    runActiveTouch(["verify-conversation", "--title", String(payload.title ?? "")])
  );
  ipcMain.handle("active-touch:locate-conversation", () => runActiveTouch(["locate-conversation"]));
  ipcMain.handle("active-touch:open-conversation-dry-run", () => runActiveTouch(["open-conversation-dry-run"]));
  ipcMain.handle("active-touch:search-conversation-dry-run", () => runActiveTouch(["search-conversation-dry-run"]));
  ipcMain.handle("active-touch:click-search-result-dry-run", () => runActiveTouch(["click-search-result-dry-run"]));
  ipcMain.handle("active-touch:input-message-dry-run", (_event, payload = {}) =>
    runActiveTouch(["input-message-dry-run", "--message", String(payload.message ?? "")])
  );
  ipcMain.handle("active-touch:queue-dry-run", (_event, payload = {}) =>
    runActiveTouch(["queue-dry-run", "--ids", Array.isArray(payload.ids) ? payload.ids.join(",") : "", "--message", String(payload.message ?? "")])
  );
  ipcMain.handle("active-touch:verify-send-result-dry-run", () => runActiveTouch(["verify-send-result-dry-run"]));
  ipcMain.handle("active-touch:verify-message-bubble", () => runActiveTouch(["verify-message-bubble"]));
  ipcMain.handle("active-touch:verify-window-title", () => runActiveTouch(["verify-window-title"]));
}

module.exports = { registerActiveTouchIpc, runActiveTouch, runActiveTouchDev };
