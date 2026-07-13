const { app, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

let runtimeDataDir = "";
let activeTouchRuntimeDir = "";
let runtimeCoordinator = null;

function cliPath() {
  return path.join(app.getAppPath(), "rpa", "contact_sync", "contact_sync_cli.cjs");
}

function settingsPath() {
  return path.join(runtimeDataDir, "wechat-paths.json");
}

function readPathSettings() {
  try {
    const value = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    return {
      wechatExePath: String(value.wechatExePath || ""),
      wechatRoot: String(value.wechatRoot || "")
    };
  } catch {
    return { wechatExePath: "", wechatRoot: "" };
  }
}

function writePathSettings(settings) {
  fs.mkdirSync(runtimeDataDir, { recursive: true });
  fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function executeContactSync(args) {
  return new Promise((resolve) => {
    const settings = readPathSettings();
    const runtimeArgs = [
      ...args,
      ...(runtimeDataDir ? ["--data-dir", runtimeDataDir] : []),
      ...(activeTouchRuntimeDir ? ["--active-touch-dir", activeTouchRuntimeDir] : []),
      ...(settings.wechatExePath ? ["--wechat-exe", settings.wechatExePath] : []),
      ...(settings.wechatRoot ? ["--wechat-root", settings.wechatRoot] : [])
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

async function chooseWechatPath(kind) {
  const settings = readPathSettings();
  const selectingExe = kind === "wechatExePath";
  const result = await dialog.showOpenDialog({
    title: selectingExe ? "选择微信程序 Weixin.exe" : "选择微信数据目录 xwechat_files",
    defaultPath: settings[kind] || undefined,
    properties: [selectingExe ? "openFile" : "openDirectory"],
    ...(selectingExe ? { filters: [{ name: "微信程序", extensions: ["exe"] }] } : {})
  });
  if (result.canceled || !result.filePaths[0]) return runContactSync(["status"]);
  const selected = result.filePaths[0];
  const stat = fs.statSync(selected);
  if ((selectingExe && (!stat.isFile() || path.extname(selected).toLowerCase() !== ".exe")) || (!selectingExe && !stat.isDirectory())) {
    return { ok: false, action: "paths", error: selectingExe ? "请选择 Weixin.exe" : "请选择 xwechat_files 数据目录" };
  }
  writePathSettings({ ...settings, [kind]: selected });
  return runContactSync(["status"]);
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
  ipcMain.handle("contact-sync:choose-wechat-exe", () => chooseWechatPath("wechatExePath"));
  ipcMain.handle("contact-sync:choose-wechat-root", () => chooseWechatPath("wechatRoot"));
  ipcMain.handle("contact-sync:auto-detect-paths", () => {
    writePathSettings({ wechatExePath: "", wechatRoot: "" });
    return runContactSync(["status"]);
  });
}

module.exports = { registerContactSyncIpc };
