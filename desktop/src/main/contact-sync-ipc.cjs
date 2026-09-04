const { app, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { diagnostics } = require("./diagnostics.cjs");

let runtimeDataDir = "";
let activeTouchRuntimeDir = "";
let runtimeCoordinator = null;
let runWithProgress = null;

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

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function currentWechatIdentity(state, settings, contacts = []) {
  const stableId = String(state?.account_name || "").trim();
  if (!stableId) return null;
  const ownWxid = stableId.match(/^(wxid_[^_]+)/u)?.[1] || stableId;
  const ownContact = Array.isArray(contacts)
    ? contacts.find((contact) => String(contact?.wxid || contact?.id || "").trim() === ownWxid)
    : null;
  const root = String(settings?.wechatRoot || state?.wechat_root || "").trim();
  const accountDir = root ? path.join(root, stableId) : "";
  const candidateDirectories = accountDir ? [accountDir, path.join(accountDir, "config"), path.join(accountDir, "account") ] : [];
  const allowedNames = /^(?:avatar|head_?image|headimg)\.(?:png|jpe?g|webp)$/iu;
  let avatarDataUrl = "";
  for (const directory of candidateDirectories) {
    try {
      const fileName = fs.readdirSync(directory).find((name) => allowedNames.test(name));
      if (!fileName) continue;
      const file = path.join(directory, fileName);
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size < 512 || stat.size > 5 * 1024 * 1024) continue;
      const extension = path.extname(fileName).toLowerCase();
      const mime = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
      avatarDataUrl = `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
      break;
    } catch {}
  }
  const remoteAvatar = /^https:\/\//iu.test(String(ownContact?.avatarUrl || "")) ? String(ownContact.avatarUrl) : "";
  return {
    account_id: stableId,
    nickname: String(state?.wechat_nickname || ownContact?.nickname || ownContact?.name || "微信用户"),
    avatar_url: avatarDataUrl || remoteAvatar,
    synced_at: String(state?.last_synced_at || "")
  };
}

function withWechatIdentity(result, settings = readPathSettings()) {
  if (!result || typeof result !== "object") return result;
  const state = result.state && typeof result.state === "object" ? result.state : {};
  return { ...result, state: { ...state, wechat_identity: currentWechatIdentity(state, settings, result.contacts) } };
}

function readCachedContactStatus() {
  const settings = readPathSettings();
  const storedState = readJsonFile(path.join(runtimeDataDir, "state.json"), {});
  const rawContacts = readJsonFile(path.join(activeTouchRuntimeDir, "contacts.json"), []);
  const rows = Array.isArray(rawContacts) ? rawContacts : Array.isArray(rawContacts?.contacts) ? rawContacts.contacts : [];
  const accountName = String(storedState.account_name || "").trim();
  const contacts = accountName
    ? rows.map((contact) => String(contact?.wechatAccountId || "").trim() ? contact : { ...contact, wechatAccountId: accountName })
    : rows;
  return withWechatIdentity({
    ok: true,
    action: "status",
    state: {
      status: "idle",
      contact_count: contacts.length,
      last_synced_at: "",
      last_error: "",
      last_stage: "idle",
      account_name: "",
      helper_configured: false,
      wechat_exe_path: settings.wechatExePath || "",
      wechat_root: settings.wechatRoot || "",
      ...storedState,
      contact_count: contacts.length,
      wechat_exe_path: settings.wechatExePath || storedState.wechat_exe_path || "",
      wechat_root: settings.wechatRoot || storedState.wechat_root || ""
    },
    contacts
  }, settings);
}

function writePathSettings(settings) {
  fs.mkdirSync(runtimeDataDir, { recursive: true });
  fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function executeContactSync(args) {
  return new Promise((resolve) => {
    const operation = diagnostics().begin("contact_sync", "executor", {
      command: args[0] ?? "status",
      argument_count: args.length
    });
    const settings = readPathSettings();
    const previousAccount = String(readJsonFile(path.join(runtimeDataDir, "state.json"), {}).account_name || "").trim();
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

    let settled = false;
    const finish = (result, exitCode = null) => {
      if (settled) return;
      settled = true;
      operation.end({
        ok: result?.ok === true,
        action: result?.action || args[0] || "status",
        blocked_reason: result?.blocked_reason || "",
        error: result?.error || "",
        stage: result?.state?.last_stage || "",
        wx_hook_stage: result?.state?.wx_hook_stage || "",
        wx_hook_error_code: /^[a-z][a-z0-9_.:-]{0,119}$/iu.test(String(result?.state?.wx_hook_error || "").trim())
          ? String(result.state.wx_hook_error).trim().toLowerCase()
          : result?.state?.wx_hook_error ? "wx_hook_error_present" : "",
        helper_configured: result?.state?.helper_configured === true,
        wechat_exe_configured: Boolean(settings.wechatExePath || result?.state?.wechat_exe_path),
        wechat_root_configured: Boolean(settings.wechatRoot || result?.state?.wechat_root),
        contact_count: Array.isArray(result?.contacts) ? result.contacts.length : Number(result?.state?.contact_count) || 0,
        process_pid: child.pid || 0,
        exit_code: exitCode,
        stdout_bytes: Buffer.byteLength(stdout),
        stderr_bytes: Buffer.byteLength(stderr)
      }, { ok: result?.ok === true, code: result?.blocked_reason || result?.state?.last_stage || "" });
      const nextAccount = String(result?.state?.account_name || "").trim();
      const accountChanged = Boolean(previousAccount && nextAccount && previousAccount !== nextAccount);
      resolve(withWechatIdentity(accountChanged
        ? { ...result, state: { ...result.state, account_changed: true } }
        : result, settings));
    };

    child.on("error", (error) => {
      finish({ ok: false, action: args[0] ?? "status", error: error.message, contacts: [] });
    });

    child.on("close", (exitCode) => {
      try {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "{}";
        finish(JSON.parse(line), exitCode);
      } catch {
        finish({ ok: false, action: args[0] ?? "status", error: stderr || stdout || "contact-sync executor failed", contacts: [] }, exitCode);
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
  const nestedRoot = !selectingExe && path.basename(selected).toLowerCase() !== "xwechat_files" ? path.join(selected, "xwechat_files") : "";
  const selectedValue = !selectingExe && nestedRoot && fs.existsSync(nestedRoot) ? nestedRoot : selected;
  writePathSettings({ ...settings, [kind]: selectedValue });
  const status = await executeContactSync(["status"]);
  if (!selectingExe && !status.ok) {
    writePathSettings(settings);
    return status;
  }
  if (!selectingExe) {
    const canonicalRoot = status.state?.wechat_root || "";
    if (!canonicalRoot) {
      writePathSettings(settings);
      return { ok: false, action: "paths", error: "请选择 xwechat_files，或选择包含该目录的上级目录", contacts: status.contacts ?? [] };
    }
    writePathSettings({
      ...settings,
      wechatExePath: String(status.state?.wechat_exe_path || settings.wechatExePath || ""),
      wechatRoot: canonicalRoot
    });
    return { ...status, state: { ...status.state, wechat_root: canonicalRoot } };
  }
  return status;
}

async function runContactSync(args) {
  const command = args[0] ?? "status";
  if (command === "status") return readCachedContactStatus();
  const lock = runtimeCoordinator?.acquire({ state: "syncing_contacts", taskId: "", account: "unknown", phase: command });
  if (lock && !lock.ok) return { ok: false, action: command, blocked_reason: lock.error, error: "当前正在进行主动触达或其他微信操作，联系人同步已禁用", contacts: [] };
  try {
    const execute = () => executeContactSync(args);
    return await (runWithProgress
      ? runWithProgress(execute, () => readJsonFile(path.join(runtimeDataDir, "state.json"), {}))
      : execute());
  } finally {
    if (lock?.lock?.owner) runtimeCoordinator?.release(lock.lock.owner);
  }
}

function registerContactSyncIpc({ dataDir, activeTouchDir, coordinator, withProgress } = {}) {
  runtimeDataDir = String(dataDir || "");
  activeTouchRuntimeDir = String(activeTouchDir || "");
  runtimeCoordinator = coordinator;
  runWithProgress = withProgress;
  ipcMain.handle("contact-sync:status", () => runContactSync(["status"]));
  ipcMain.handle("contact-sync:sync", () => runContactSync(["sync"]));
  ipcMain.handle("contact-sync:capture", () => runContactSync(["capture", "--restart-wechat", "--timeout", "120"]));
  ipcMain.handle("contact-sync:choose-wechat-exe", () => chooseWechatPath("wechatExePath"));
  ipcMain.handle("contact-sync:choose-wechat-root", () => chooseWechatPath("wechatRoot"));
  ipcMain.handle("contact-sync:auto-detect-paths", async () => {
    const settings = readPathSettings();
    writePathSettings({ wechatExePath: "", wechatRoot: "" });
    const result = await executeContactSync(["status"]);
    if (!result.ok || !result.state?.wechat_root) {
      writePathSettings(settings);
      if (!result.ok) return result;
      return { ok: false, action: "paths", error: "未自动识别到微信数据目录，请先登录微信后重试，或手动选择 xwechat_files", contacts: result.contacts ?? [] };
    }
    writePathSettings({
      wechatExePath: String(result.state?.wechat_exe_path || settings.wechatExePath || ""),
      wechatRoot: String(result.state?.wechat_root || "")
    });
    return result;
  });
}

module.exports = { registerContactSyncIpc };
