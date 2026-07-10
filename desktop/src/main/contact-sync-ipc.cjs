const { app, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");

let runtimeDataDir = "";
let activeTouchRuntimeDir = "";
let runtimeCoordinator = null;

function cliPath() {
  return path.join(app.getAppPath(), "rpa", "contact_sync", "contact_sync_cli.cjs");
}

function executeContactSync(args) {
  return new Promise((resolve) => {
    const runtimeArgs = [
      ...args,
      ...(runtimeDataDir ? ["--data-dir", runtimeDataDir] : []),
      ...(activeTouchRuntimeDir ? ["--active-touch-dir", activeTouchRuntimeDir] : [])
    ];
    const child = spawn(process.execPath, [cliPath(), ...runtimeArgs], {
      cwd: path.dirname(cliPath()),
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
      resolve({ ok: false, action: args[0] ?? "status", error: error.message, contacts: [] });
    });

    child.on("close", () => {
      try {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "{}";
        resolve(JSON.parse(line));
      } catch {
        resolve({ ok: false, action: args[0] ?? "status", error: stderr || stdout || "contact-sync executor failed", contacts: [] });
      }
    });
  });
}

async function runContactSync(args) {
  const command = args[0] ?? "status";
  if (command === "status") return executeContactSync(args);
  const lock = runtimeCoordinator?.acquire({ state: "syncing_contacts", taskId: "", account: "unknown", phase: command });
  if (lock && !lock.ok) return { ok: false, action: command, blocked_reason: lock.error, error: "当前正在进行主动触达或其他微信操作，联系人同步已禁用", contacts: [] };
  try {
    return await executeContactSync(args);
  } finally {
    if (lock?.lock?.owner) runtimeCoordinator?.release(lock.lock.owner);
  }
}

function registerContactSyncIpc({ dataDir, activeTouchDir, coordinator } = {}) {
  runtimeDataDir = String(dataDir || "");
  activeTouchRuntimeDir = String(activeTouchDir || "");
  runtimeCoordinator = coordinator;
  ipcMain.handle("contact-sync:status", () => runContactSync(["status"]));
  ipcMain.handle("contact-sync:sync", () => runContactSync(["sync"]));
  ipcMain.handle("contact-sync:capture", () => runContactSync(["capture", "--restart-wechat", "--timeout", "120"]));
}

module.exports = { registerContactSyncIpc };
