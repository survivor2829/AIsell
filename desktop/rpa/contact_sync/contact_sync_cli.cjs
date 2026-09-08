#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const DEFAULT_STATE = {
  version: 1,
  status: "idle",
  contact_count: 0,
  last_synced_at: "",
  last_error: "",
  last_stage: "idle",
  account_name: "",
  helper_configured: false,
  wechat_exe_path: "",
  wechat_root: "",
  wx_hook_stage: "",
  wx_hook_error: ""
};

function statePath(baseDir) {
  return path.join(baseDir, "state.json");
}

function activeTouchDir(baseDir) {
  return path.resolve(baseDir, "..", "active_touch");
}

function contactsPath(baseDir, options = {}) {
  return path.join(options.activeTouchDir ?? activeTouchDir(baseDir), "contacts.json");
}

function bundledHelperPath(baseDir = __dirname) {
  return path.join(baseDir, "wechat_contact_helper.py");
}

function bundledHelperExePath(baseDir = __dirname) {
  return path.join(baseDir, "xiaoxi-contact-helper.exe");
}

function bundledKeyInfoProbePath(baseDir = __dirname) {
  return path.join(baseDir, "key_info_probe.py");
}

function bundledMemoryKeyProbePath(baseDir = __dirname) {
  return path.join(baseDir, "memory_key_probe.py");
}

function bundledWxKeyProbePath(baseDir = __dirname) {
  return path.join(baseDir, "wx_key_probe.py");
}

function bundledWxKeyDllPath(baseDir = __dirname) {
  return path.join(baseDir, "libs", "wx_key.dll");
}

function bundledDumpToolPath(baseDir = __dirname) {
  return path.join(baseDir, "libs", "xiaoxi-db-decrypt.exe");
}

function bundledPythonPath(baseDir = __dirname) {
  const candidates = [
    path.join(baseDir, "python", "python.exe"),
    path.join(path.dirname(process.execPath), "python", "python.exe"),
    path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? "";
}

function resolveHelper(baseDir = __dirname, options = {}) {
  const codeDir = __dirname;
  const helperPath =
    options.helperPath ??
    process.env.XIAOXI_WECHAT_DECRYPT_HELPER ??
    process.env.WECHAT_DECRYPT_HELPER ??
    (fs.existsSync(bundledHelperExePath(codeDir))
      ? bundledHelperExePath(codeDir)
      : fs.existsSync(bundledHelperPath(codeDir)) ? bundledHelperPath(codeDir) : "");
  const pythonPath = options.pythonPath ?? process.env.XIAOXI_CONTACT_SYNC_PYTHON ?? bundledPythonPath(codeDir);
  return {
    helperPath,
    pythonPath,
    helperConfigured: Boolean(helperPath && fs.existsSync(helperPath) && (path.extname(helperPath).toLowerCase() !== ".py" || pythonPath))
  };
}

function resolveCaptureTools(options = {}) {
  const keyToolPath = options.keyToolPath ?? process.env.XIAOXI_WECHAT_KEY_TOOL ?? "";
  const dumpToolPath = options.dumpToolPath ?? process.env.XIAOXI_WECHAT_DUMP_TOOL ?? bundledDumpToolPath(__dirname);
  const selfContainedHelperPath = options.contactHelperPath ?? process.env.XIAOXI_CONTACT_HELPER ?? bundledHelperExePath(__dirname);
  const keyInfoProbePath =
    options.keyInfoProbePath ?? process.env.XIAOXI_KEY_INFO_PROBE ?? bundledKeyInfoProbePath(__dirname);
  const memoryKeyProbePath =
    options.memoryKeyProbePath ?? process.env.XIAOXI_MEMORY_KEY_PROBE ?? bundledMemoryKeyProbePath(__dirname);
  const wxKeyProbePath =
    options.wxKeyProbePath ?? process.env.XIAOXI_WX_KEY_PROBE ?? bundledWxKeyProbePath(__dirname);
  const wxKeyDllCandidates = [
    options.wxKeyDllPath,
    process.env.XIAOXI_WX_KEY_DLL,
    bundledWxKeyDllPath(__dirname)
  ].filter(Boolean);
  const wxKeyDllPath = wxKeyDllCandidates.find((candidate) => fs.existsSync(candidate)) ?? "";
  const pythonPath = options.pythonPath ?? process.env.XIAOXI_CONTACT_SYNC_PYTHON ?? bundledPythonPath(__dirname);
  return {
    keyToolPath: fs.existsSync(keyToolPath) ? keyToolPath : "",
    dumpToolPath: fs.existsSync(dumpToolPath) ? dumpToolPath : "",
    selfContainedHelperPath: fs.existsSync(selfContainedHelperPath) ? selfContainedHelperPath : "",
    keyInfoProbePath: fs.existsSync(keyInfoProbePath) ? keyInfoProbePath : "",
    memoryKeyProbePath: fs.existsSync(memoryKeyProbePath) ? memoryKeyProbePath : "",
    wxKeyProbePath: fs.existsSync(wxKeyProbePath) ? wxKeyProbePath : "",
    wxKeyDllPath,
    pythonPath
  };
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function loadState(baseDir = __dirname) {
  return { ...DEFAULT_STATE, ...readJson(statePath(baseDir)) };
}

function saveState(baseDir, state) {
  writeJson(statePath(baseDir), state);
}

function readContacts(baseDir = __dirname, options = {}) {
  const raw = readJson(contactsPath(baseDir, options), []);
  return Array.isArray(raw) ? raw : Array.isArray(raw.contacts) ? raw.contacts : [];
}

function defaultWechatRoot() {
  return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Tencent", "WeChat");
}

function normalizeWechatRootCandidate(candidate) {
  const value = String(candidate || "").trim().replace(/^\uFEFF/, "").replace(/^(["'])(.*)\1$/, "$2");
  if (!value || !path.isAbsolute(value)) return "";
  const normalized = path.normalize(value);
  if (path.basename(normalized).toLowerCase() === "xwechat_files") return normalized;
  const nested = path.join(normalized, "xwechat_files");
  return fs.existsSync(nested) ? nested : normalized;
}

function configuredWechatRoots(options = {}) {
  const appDataDir = options.appDataDir ?? process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  const configDir = path.join(appDataDir, "Tencent", "xwechat", "config");
  if (!fs.existsSync(configDir)) return [];
  try {
    return fs.readdirSync(configDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".ini")
      .flatMap((entry) => {
        const buffer = fs.readFileSync(path.join(configDir, entry.name));
        const content = buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.toString("utf16le") : buffer.toString("utf8");
        return content.split(/\r?\n/)
          .map((line) => line.includes("=") ? line.slice(line.indexOf("=") + 1) : line)
          .map(normalizeWechatRootCandidate)
          .filter(Boolean);
      });
  } catch {
    return [];
  }
}

function runningWeixinDataRoots(options = {}) {
  const processes = Array.isArray(options.weixinProcesses) ? options.weixinProcesses : runningWeixinProcesses(options);
  return processes
    .map((processInfo) => processInfo.path)
    .filter(Boolean)
    .map((exePath) => path.resolve(path.dirname(exePath), "..", "xwechat_files"));
}

const WEIXIN_PROCESS_QUERY_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ProgressPreference = "SilentlyContinue"
$cimAvailable = $true
try { $sourceProcesses = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" -ErrorAction Stop) } catch {
  $cimAvailable = $false
  $sourceProcesses = @()
}
$rows = if ($cimAvailable) {
  @($sourceProcesses | ForEach-Object {
    $windowHandle = 0
    $moduleReady = $null
    try {
      $process = Get-Process -Id $_.ProcessId -ErrorAction Stop
      $windowHandle = [int64]$process.MainWindowHandle
      try { $moduleReady = @($process.Modules | Where-Object { $_.ModuleName -ieq "Weixin.dll" }).Count -gt 0 } catch {}
    } catch {}
    [pscustomobject]@{
      Id = [int]$_.ProcessId
      Path = [string]$_.ExecutablePath
      CommandLine = [string]$_.CommandLine
      MainWindowHandle = $windowHandle
      ModuleReady = $moduleReady
    }
  })
} else {
  @(Get-Process Weixin -ErrorAction SilentlyContinue | ForEach-Object {
    $moduleReady = $null
    try { $moduleReady = @($_.Modules | Where-Object { $_.ModuleName -ieq "Weixin.dll" }).Count -gt 0 } catch {}
    $processPath = ""
    try { $processPath = [string]$_.Path } catch {}
    [pscustomobject]@{
      Id = [int]$_.Id
      Path = $processPath
      CommandLine = ""
      MainWindowHandle = [int64]$_.MainWindowHandle
      ModuleReady = $moduleReady
    }
  })
}
if ($rows.Count) { $rows | ConvertTo-Json -Compress } else { "[]" }
`;

function runningWeixinProcesses(options = {}) {
  const selectMainProcesses = (rows) => {
    const processes = (Array.isArray(rows) ? rows : [rows])
      .map((row) => ({
        id: Number(row.id ?? row.Id),
        path: String(row.path ?? row.Path ?? ""),
        commandLine: String(row.commandLine ?? row.CommandLine ?? ""),
        mainWindowHandle: Number(row.mainWindowHandle ?? row.MainWindowHandle ?? 0),
        moduleReady: (row.moduleReady ?? row.ModuleReady) == null ? null : Boolean(row.moduleReady ?? row.ModuleReady)
      }))
      .filter((row) => row.id);
    const knownMainProcesses = processes.filter((row) => row.commandLine && !/--type=/i.test(row.commandLine));
    if (knownMainProcesses.length) {
      return knownMainProcesses.sort((a, b) => Number(b.moduleReady === true) - Number(a.moduleReady === true) || Number(Boolean(b.mainWindowHandle)) - Number(Boolean(a.mainWindowHandle)));
    }
    const visibleProcesses = processes.filter((row) => row.mainWindowHandle);
    return visibleProcesses.length ? visibleProcesses : processes;
  };

  if (options.processProvider) return selectMainProcesses(options.processProvider());
  if (process.platform !== "win32") return [];
  const encoded = Buffer.from(WEIXIN_PROCESS_QUERY_SCRIPT, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000
  });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    return selectMainProcesses(JSON.parse(result.stdout));
  } catch {
    return [];
  }
}

const WEIXIN_INSTALL_QUERY_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ProgressPreference = "SilentlyContinue"
$registryRoots = @(
  "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
  "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
  "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*"
)
$paths = New-Object System.Collections.Generic.List[string]
foreach ($item in @(Get-ItemProperty $registryRoots -ErrorAction SilentlyContinue)) {
  $installLocation = ([string]$item.InstallLocation).Trim().Trim('"')
  if ($installLocation) {
    $candidate = Join-Path $installLocation "Weixin.exe"
    if ((Test-Path -LiteralPath $candidate) -and -not $paths.Contains($candidate)) { [void]$paths.Add($candidate) }
  }
  $displayIcon = ([string]$item.DisplayIcon).Trim()
  if ($displayIcon) {
    if ($displayIcon.StartsWith('"')) {
      $closingQuote = $displayIcon.IndexOf('"', 1)
      $candidate = if ($closingQuote -gt 1) { $displayIcon.Substring(1, $closingQuote - 1) } else { "" }
    } else {
      $candidate = ($displayIcon -split ',')[0].Trim()
    }
    if (([System.IO.Path]::GetFileName($candidate) -ieq "Weixin.exe") -and (Test-Path -LiteralPath $candidate) -and -not $paths.Contains($candidate)) {
      [void]$paths.Add($candidate)
    }
  }
}
if ($paths.Count) { $paths | ConvertTo-Json -Compress } else { "[]" }
`;

function installedWeixinExecutables(options = {}) {
  if (options.installedExecutableProvider) {
    const provided = options.installedExecutableProvider();
    return (Array.isArray(provided) ? provided : [provided]).map((candidate) => String(candidate || "")).filter(Boolean);
  }
  if (process.platform !== "win32") return [];
  const encoded = Buffer.from(WEIXIN_INSTALL_QUERY_SCRIPT, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000
  });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((candidate) => String(candidate || "")).filter(Boolean);
  } catch {
    return [];
  }
}

function findWechatExecutable(options = {}) {
  const explicit = options.wechatExePath ?? process.env.XIAOXI_WECHAT_EXE ?? "";
  const processes = Array.isArray(options.weixinProcesses) ? options.weixinProcesses : runningWeixinProcesses(options);
  const running = processes.map((processInfo) => processInfo.path).filter(Boolean);
  const commonCandidates = options.commonWechatExeCandidates ?? [
    process.env.ProgramW6432 ? path.join(process.env.ProgramW6432, "Tencent", "Weixin", "Weixin.exe") : "",
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Tencent", "Weixin", "Weixin.exe"),
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Tencent", "Weixin", "Weixin.exe") : "",
    path.join(process.env.LOCALAPPDATA ?? "", "Tencent", "Weixin", "Weixin.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Tencent", "Weixin", "Weixin.exe")
  ];
  const candidates = [explicit, ...running, ...commonCandidates].filter(Boolean);
  const direct = candidates.find((candidate) => fs.existsSync(candidate));
  if (direct) return direct;
  return installedWeixinExecutables(options).find((candidate) => fs.existsSync(candidate)) ?? "";
}

const PREPARE_WECHAT_LOGIN_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$running = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" -ErrorAction SilentlyContinue)
$main = $running | Where-Object { $_.CommandLine -notmatch "--type=" } | Select-Object -First 1
$paths = New-Object System.Collections.Generic.List[string]
if ($main -and $main.ExecutablePath) { [void]$paths.Add($main.ExecutablePath) }
foreach ($path in @(
  "$env:XIAOXI_WECHAT_EXE",
  "$env:LOCALAPPDATA\\Tencent\\Weixin\\Weixin.exe",
  "$env:ProgramFiles\\Tencent\\Weixin\\Weixin.exe"
)) {
  if ($path -and (Test-Path $path) -and -not $paths.Contains($path)) { [void]$paths.Add($path) }
}
$command = Get-Command Weixin.exe -ErrorAction SilentlyContinue
if ($command -and -not $paths.Contains($command.Source)) { [void]$paths.Add($command.Source) }
$exe = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) {
  @{ ok = $false; reason = "wechat_executable_not_found" } | ConvertTo-Json -Compress
  exit
}
$restarted = @(Get-Process Weixin -ErrorAction SilentlyContinue).Count -gt 0
if ($restarted) {
  Get-Process Weixin -ErrorAction SilentlyContinue | ForEach-Object { try { [void]$_.CloseMainWindow() } catch {} }
  Start-Sleep -Milliseconds 1200
  Get-Process Weixin -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='WeChatAppEx.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -like "*\\Tencent\\xwechat\\*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  for ($i = 0; $i -lt 30; $i++) {
    if (-not (Get-Process Weixin -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 100
  }
}
if (Get-Process Weixin -ErrorAction SilentlyContinue) {
  @{ ok = $false; reason = "wechat_stop_failed" } | ConvertTo-Json -Compress
  exit
}
try {
  if ($env:XIAOXI_STOP_ONLY -eq "1") {
    @{ ok = $true; restarted = $restarted; wechatExePath = $exe } | ConvertTo-Json -Compress
    exit
  }
  Start-Process -FilePath $exe | Out-Null
  @{ ok = $true; restarted = $restarted; wechatExePath = $exe } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; reason = "wechat_start_failed" } | ConvertTo-Json -Compress
}
`;

function prepareWechatLogin(options = {}) {
  if (options.loginFlowDriver) return options.loginFlowDriver(options);
  if (process.platform !== "win32") return { ok: false, reason: "unsupported_platform" };
  const encoded = Buffer.from(PREPARE_WECHAT_LOGIN_SCRIPT, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    env: {
      ...process.env,
      XIAOXI_WECHAT_EXE: options.wechatExePath ?? process.env.XIAOXI_WECHAT_EXE ?? "",
      XIAOXI_STOP_ONLY: options.stopOnly ? "1" : ""
    }
  });
  if (result.error || result.status !== 0) return { ok: false, reason: "wechat_start_failed" };
  return readJsonFromString(result.stdout, { ok: false, reason: "wechat_start_failed" });
}

function candidateWechatRoots(options = {}) {
  const explicit = options.wechatRoot ?? process.env.XIAOXI_WECHAT_ROOT ?? "";
  const driveRoots =
    process.platform === "win32"
      ? "CDEFGHIJKLMNOPQRSTUVWXYZ"
          .split("")
          .flatMap((drive) => [
            `${drive}:\\xwechat_files`,
            `${drive}:\\微信\\xwechat_files`,
            `${drive}:\\WeChat\\xwechat_files`,
            `${drive}:\\Weixin\\xwechat_files`
          ])
      : [];
  const candidates = [
    explicit,
    ...configuredWechatRoots(options),
    path.join(os.homedir(), "xwechat_files"),
    path.join(os.homedir(), "Documents", "xwechat_files"),
    process.env.OneDrive ? path.join(process.env.OneDrive, "Documents", "xwechat_files") : "",
    defaultWechatRoot(),
    path.join(os.homedir(), "Documents", "WeChat Files"),
    ...runningWeixinDataRoots(options),
    ...driveRoots
  ].map(normalizeWechatRootCandidate).filter(Boolean);
  return candidates.filter((candidate, index) =>
    candidates.findIndex((other) => other.toLowerCase() === candidate.toLowerCase()) === index
  );
}

function findWechatRoot(options = {}) {
  const explicit = options.wechatRoot ?? process.env.XIAOXI_WECHAT_ROOT ?? "";
  const normalizedExplicit = normalizeWechatRootCandidate(explicit);
  const candidates = normalizedExplicit && fs.existsSync(normalizedExplicit)
    ? [normalizedExplicit]
    : candidateWechatRoots({ ...options, wechatRoot: "" });
  return candidates.filter((root) => root && fs.existsSync(root)).find((root) => {
    const account = findAccount(root);
    return account.hasContact || account.hasKey;
  }) ?? "";
}

function listAccountDirs(wechatRoot) {
  if (!fs.existsSync(wechatRoot)) return [];
  const candidates = [wechatRoot];
  for (const entry of fs.readdirSync(wechatRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(path.join(wechatRoot, entry.name));
  }
  return candidates;
}

function wxidFromAccountDir(accountDir) {
  const match = path.basename(accountDir).match(/^(wxid_[^_]+)/);
  return match ? match[1] : "";
}

function fileMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function xwechatAccounts(wechatRoot) {
  const loginRoot = path.join(wechatRoot, "all_users", "login");
  return fs
    .readdirSync(wechatRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(wechatRoot, entry.name))
    .map((accountDir) => {
      const wxid = wxidFromAccountDir(accountDir);
      return {
        accountDir,
        accountName: path.basename(accountDir),
        contactDb: path.join(accountDir, "db_storage", "contact", "contact.db"),
        keyInfoDb: wxid ? path.join(loginRoot, wxid, "key_info.db") : ""
      };
    })
    .filter((account) => fs.existsSync(account.contactDb) || fs.existsSync(account.keyInfoDb));
}

function sameDirAccounts(wechatRoot) {
  return listAccountDirs(wechatRoot)
    .map((accountDir) => ({
      accountDir,
      accountName: path.basename(accountDir),
      contactDb: path.join(accountDir, "contact.db"),
      keyInfoDb: path.join(accountDir, "key_info.db")
    }))
    .filter((account) => fs.existsSync(account.contactDb) || fs.existsSync(account.keyInfoDb));
}

function findAccount(wechatRoot) {
  const accounts = [...xwechatAccounts(wechatRoot), ...sameDirAccounts(wechatRoot)];
  const withContact = accounts.filter((account) => fs.existsSync(account.contactDb));
  const withBoth = withContact
    .filter((account) => account.keyInfoDb && fs.existsSync(account.keyInfoDb))
    .sort((a, b) => fileMtime(b.contactDb) - fileMtime(a.contactDb));
  const withKey = accounts.find((account) => account.keyInfoDb && fs.existsSync(account.keyInfoDb));
  const selected = withBoth[0] ?? withContact.sort((a, b) => fileMtime(b.contactDb) - fileMtime(a.contactDb))[0] ?? withKey;
  return {
    ...(selected ?? {}),
    hasContact: withContact.length > 0,
    hasKey: Boolean(withBoth[0] || withKey)
  };
}

function contactAccounts(wechatRoot) {
  const accounts = [...xwechatAccounts(wechatRoot), ...sameDirAccounts(wechatRoot)]
    .filter((account) => account.contactDb && fs.existsSync(account.contactDb))
    .sort((a, b) => fileMtime(b.contactDb) - fileMtime(a.contactDb));
  return accounts.filter((account, index) =>
    accounts.findIndex((other) => other.contactDb.toLowerCase() === account.contactDb.toLowerCase()) === index
  );
}

function normalizeContact(row, index, syncedAt, source = "wechat-silent-sync", wechatAccountId = "") {
  const remark = String(row.remark ?? "").trim();
  const nickname = String(row.nickname ?? row.nick_name ?? "").trim();
  const avatarUrl = String(row.avatarUrl ?? row.avatar_url ?? row.small_head_url ?? row.big_head_url ?? "").trim();
  const username = String(row.username ?? row.user_name ?? row.wxid ?? "").trim();
  const alias = String(row.alias ?? row.wechat_id ?? row.wechatId ?? "").trim();
  const uniqueId = String(username || row.id || alias || "").trim();
  const wechatId = alias;
  const name = String(row.name || remark || nickname || alias).trim();
  const localTypeRaw = row.local_type ?? row.localType ?? row.type;
  const localType = localTypeRaw === null || localTypeRaw === undefined || localTypeRaw === "" ? null : Number(localTypeRaw);
  const verifyFlag = Number(row.verify_flag ?? row.verifyFlag ?? 0);
  const chatRoomType = Number(row.chat_room_type ?? row.chatRoomType ?? 0);
  const deleted = row.deleted_at || row.delete_flag === 1 || row.delete_flag === "1" || row.deleteFlag === 1 || row.deleteFlag === "1";
  const lowerWechatId = uniqueId.toLowerCase();
  const systemIds = new Set(["weixin", "filehelper", "notifymessage", "fmessage", "medianote", "floatbottle"]);
  const blockedId =
    !uniqueId ||
    lowerWechatId.endsWith("@chatroom") ||
    lowerWechatId.startsWith("gh_") ||
    lowerWechatId.startsWith("openim_") ||
    lowerWechatId.includes("@openim") ||
    systemIds.has(lowerWechatId);
  const friendMarked = Number.isFinite(localType) && localType === 1;
  if (!name || blockedId || deleted || chatRoomType > 0 || verifyFlag !== 0 || !friendMarked) return null;

  return {
    id: String(uniqueId || name || index + 1),
    name,
    remark,
    nickname,
    avatarUrl: /^https:\/\//iu.test(avatarUrl) ? avatarUrl : "",
    wxid: username,
    wechatId,
    wechatAccountId,
    tag: String(row.tag ?? row.label ?? "微信同步"),
    lastTouch: String(row.lastTouch ?? row.last_touch ?? ""),
    allowed: row.allowed !== false,
    source,
    syncedAt
  };
}

function normalizeContacts(rawContacts, syncedAt = new Date().toISOString(), source = "wechat-silent-sync", wechatAccountId = "") {
  const rows = Array.isArray(rawContacts) ? rawContacts : Array.isArray(rawContacts.contacts) ? rawContacts.contacts : [];
  const seen = new Set();
  return rows
    .map((row, index) => normalizeContact(row, index, syncedAt, source, wechatAccountId))
    .filter(Boolean)
    .filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
}

function block(baseDir, reason, message, extra = {}) {
  const state = {
    ...loadState(baseDir),
    status: "blocked",
    last_error: message,
    last_stage: reason,
    helper_configured: Boolean(extra.helperConfigured),
    ...extra.state
  };
  saveState(baseDir, state);
  return { ok: false, action: "sync", state, blocked_reason: reason, error: message, contacts: readContacts(baseDir, extra) };
}

function runHelper(helper, account, tempOut, extraArgs = []) {
  const args = [
    "--contact-db",
    account.contactDb
  ];
  if (account.keyInfoDb) args.push("--key-info", account.keyInfoDb);
  args.push("--out", tempOut);
  args.push(...extraArgs);
  const ext = path.extname(helper.helperPath).toLowerCase();
  if (ext === ".py" && !helper.pythonPath) return { ok: false, blockedReason: "python_runtime_missing" };

  const command = ext === ".js" || ext === ".cjs" ? process.execPath : ext === ".py" ? helper.pythonPath : helper.helperPath;
  const finalArgs = command === process.execPath || ext === ".py" ? [helper.helperPath, ...args] : args;
  const result = spawnSync(command, finalArgs, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return { ok: false };
  return { ok: true };
}

function runTool(toolPath, args, timeout = 20000) {
  const ext = path.extname(toolPath).toLowerCase();
  const command = ext === ".js" || ext === ".cjs" ? process.execPath : toolPath;
  const finalArgs = command === process.execPath ? [toolPath, ...args] : args;
  return spawnSync(command, finalArgs, { encoding: "utf8", windowsHide: true, timeout });
}

function captureKey(keyToolPath, pid) {
  const result = runTool(keyToolPath, ["key", "-p", String(pid)]);
  if (result.status !== 0) return "";
  const match = `${result.stdout}\n${result.stderr}`.match(/\b[a-fA-F0-9]{64}\b/);
  return match ? match[0] : "";
}

function captureKeyFromKeyInfo(keyInfoDb, tools, options = {}, timeoutMs = 5000) {
  if (options.keyInfoReader) {
    const result = options.keyInfoReader(keyInfoDb);
    if (typeof result === "string") return { keyHex: result, observed: Boolean(result) };
    return { keyHex: result?.keyHex ?? "", observed: Boolean(result?.observed) };
  }
  if (!keyInfoDb || !fs.existsSync(keyInfoDb) || (!tools.selfContainedHelperPath && (!tools.keyInfoProbePath || !tools.pythonPath))) {
    return { keyHex: "", observed: false };
  }

  const processTimeoutMs = Math.max(100, Math.min(5000, Number(timeoutMs) || 5000));
  const result = tools.selfContainedHelperPath
    ? runTool(tools.selfContainedHelperPath, ["key-info", "--key-info", keyInfoDb], processTimeoutMs)
    : spawnSync(tools.pythonPath, [tools.keyInfoProbePath, "--key-info", keyInfoDb], { encoding: "utf8", windowsHide: true, timeout: processTimeoutMs });
  if (result.status !== 0) return { keyHex: "", observed: false };

  const parsed = readJsonFromString(result.stdout, {});
  const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  return {
    keyHex: candidates.find((candidate) => /^[a-fA-F0-9]{64}$/.test(candidate)) ?? "",
    observed: Number(parsed.rows_seen ?? 0) > 0
  };
}

function captureKeyFromMemory(contactDb, tools, options = {}, processes = [], timeoutMs = 60000) {
  if (options.memoryKeyReader) {
    const result = options.memoryKeyReader(contactDb);
    return typeof result === "string" ? result : result?.keyHex ?? "";
  }
  if (!contactDb || !fs.existsSync(contactDb) || (!tools.selfContainedHelperPath && (!tools.memoryKeyProbePath || !tools.pythonPath))) return "";
  const pidArgs = processes.flatMap((processInfo) => ["--pid", String(processInfo.id)]);
  const processTimeoutMs = Math.max(100, timeoutMs);
  const result = tools.selfContainedHelperPath
    ? spawnSync(tools.selfContainedHelperPath, ["memory-key", "--contact-db", contactDb, ...pidArgs], { encoding: "utf8", windowsHide: true, timeout: processTimeoutMs })
    : spawnSync(tools.pythonPath, [tools.memoryKeyProbePath, "--contact-db", contactDb, ...pidArgs], { encoding: "utf8", windowsHide: true, timeout: processTimeoutMs });
  if (result.status !== 0) return "";
  const parsed = readJsonFromString(result.stdout, {});
  const keyHex = String(parsed.key ?? "");
  return /^[a-fA-F0-9]{64}$/.test(keyHex) ? keyHex : "";
}

function captureKeyFromWxKeyDll(tools, options = {}, processes = [], timeoutMs = 90000) {
  if (options.wxKeyReader) {
    const result = options.wxKeyReader(options);
    const keyHex = typeof result === "string" ? result : String(result?.keyHex ?? "");
    options.onWxKeyResult?.({
      status: typeof result === "string" ? (keyHex ? 0 : 1) : Number(result?.status ?? (keyHex ? 0 : 1)),
      stage: typeof result === "string" ? (keyHex ? "captured" : "") : String(result?.stage ?? ""),
      error: typeof result === "string" ? "" : String(result?.error ?? "")
    });
    return /^[a-fA-F0-9]{64}$/.test(keyHex) ? keyHex : "";
  }
  if (!tools.wxKeyDllPath || (!tools.selfContainedHelperPath && (!tools.wxKeyProbePath || !tools.pythonPath))) return "";
  const targetArgs = options.launchWechatExe
    ? ["--exe", options.launchWechatExe]
    : processes.flatMap((processInfo) => ["--pid", String(processInfo.id)]);
  const args = [
    "--dll",
    tools.wxKeyDllPath,
    "--timeout",
    String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    ...targetArgs
  ];
  const result = tools.selfContainedHelperPath
    ? runTool(tools.selfContainedHelperPath, ["wx-key", ...args], timeoutMs + 5000)
    : spawnSync(tools.pythonPath, [tools.wxKeyProbePath, ...args], { encoding: "utf8", windowsHide: true, timeout: timeoutMs + 5000 });
  const parsed = readJsonFromString(result.stdout, {});
  options.onWxKeyResult?.({
    status: result.status,
    stage: String(parsed.stage || (result.error?.code === "ETIMEDOUT" ? "helper_timeout" : result.error ? "helper_start_failed" : result.status !== 0 ? "helper_failed" : "helper_result_invalid")),
    error: String(parsed.error ?? result.error?.message ?? result.stderr ?? "").trim()
  });
  if (result.status !== 0) return "";
  const keyHex = String(parsed.key ?? "");
  return /^[a-fA-F0-9]{64}$/.test(keyHex) ? keyHex : "";
}

function readJsonFromString(value, fallback = {}) {
  try {
    return JSON.parse(String(value || "").trim() || "{}");
  } catch {
    return fallback;
  }
}

function decryptContactDb(dumpToolPath, keyHex, contactDbPath, outputDbPath, timeoutMs = 20000) {
  if (decryptSqlcipher4Raw(contactDbPath, outputDbPath, keyHex)) return true;
  if (!dumpToolPath || !fs.existsSync(dumpToolPath)) return false;
  const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 20000);
  for (const version of ["4", "3"]) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const result = runTool(dumpToolPath, ["-k", keyHex, "-f", contactDbPath, "-o", outputDbPath, "--vv", version], remainingMs);
    if (result.status === 0 && fs.existsSync(outputDbPath)) return true;
  }
  return false;
}

function decryptSqlcipher4Raw(inputPath, outputPath, keyHex) {
  if (!/^[a-fA-F0-9]{64}$/.test(String(keyHex))) return false;
  const pageSize = 4096;
  const saltSize = 16;
  const reserveSize = 80;
  const sqliteHeader = Buffer.from("SQLite format 3\0", "binary");
  const key = Buffer.from(keyHex, "hex");
  const input = fs.readFileSync(inputPath);
  if (input.length < pageSize) return false;

  const page1 = input.subarray(0, pageSize);
  const salt = page1.subarray(0, saltSize);
  const macSalt = Buffer.from([...salt].map((byte) => byte ^ 0x3a));
  const macKey = crypto.pbkdf2Sync(key, macSalt, 2, 32, "sha512");
  const hmacData = page1.subarray(saltSize, pageSize - reserveSize + 16);
  const expected = page1.subarray(pageSize - 64, pageSize);
  const pageNo = Buffer.alloc(4);
  pageNo.writeUInt32LE(1, 0);
  const actual = crypto.createHmac("sha512", macKey).update(hmacData).update(pageNo).digest();
  if (!crypto.timingSafeEqual(actual, expected)) return false;

  const pages = Math.ceil(input.length / pageSize);
  const output = [];
  for (let index = 0; index < pages; index += 1) {
    let page = input.subarray(index * pageSize, Math.min((index + 1) * pageSize, input.length));
    if (page.length < pageSize) page = Buffer.concat([page, Buffer.alloc(pageSize - page.length)]);
    const iv = page.subarray(pageSize - reserveSize, pageSize - reserveSize + 16);
    const encrypted = index === 0 ? page.subarray(saltSize, pageSize - reserveSize) : page.subarray(0, pageSize - reserveSize);
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    output.push(index === 0 ? Buffer.concat([sqliteHeader, decrypted, Buffer.alloc(reserveSize)]) : Buffer.concat([decrypted, Buffer.alloc(reserveSize)]));
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.concat(output));
  return true;
}

function readDecryptedContacts(baseDir, dbPath, options = {}) {
  const helper = resolveHelper(baseDir, options);
  if (!helper.helperConfigured) return null;

  const tempOut = path.join(os.tmpdir(), `xiaoxi-contact-capture-${process.pid}-${Date.now()}.json`);
  const result = runHelper(helper, { contactDb: dbPath, keyInfoDb: "" }, tempOut);
  if (!result.ok) {
    try {
      fs.rmSync(tempOut, { force: true });
    } catch {
      // ponytail: temp cleanup can fail without changing the capture result.
    }
    return null;
  }

  const contacts = readJson(tempOut, []);
  try {
    fs.rmSync(tempOut, { force: true });
  } catch {
    // ponytail: temp cleanup can fail without changing the capture result.
  }
  return contacts;
}

function inspectDecryptedContacts(baseDir, dbPath, options = {}) {
  const helper = resolveHelper(baseDir, options);
  if (!helper.helperConfigured) return null;

  const tempOut = path.join(os.tmpdir(), `xiaoxi-contact-inspect-${process.pid}-${Date.now()}.json`);
  const result = runHelper(helper, { contactDb: dbPath, keyInfoDb: "" }, tempOut, ["--inspect"]);
  if (!result.ok) {
    try {
      fs.rmSync(tempOut, { force: true });
    } catch {
      // ponytail: temp cleanup can fail without changing the inspect result.
    }
    return null;
  }

  const inspection = readJson(tempOut, {});
  try {
    fs.rmSync(tempOut, { force: true });
  } catch {
    // ponytail: temp cleanup can fail without changing the inspect result.
  }
  return inspection;
}

function capture(baseDir = __dirname, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 90000);
  const pollIntervalMs = Number(options.pollIntervalMs ?? 1000);
  const deadline = Date.now() + timeoutMs;
  const helper = resolveHelper(baseDir, options);
  const tools = resolveCaptureTools(options);
  const hasKeyInfoReader = Boolean(options.keyInfoReader || tools.selfContainedHelperPath || (tools.keyInfoProbePath && tools.pythonPath));
  const hasMemoryKeyReader = Boolean(options.memoryKeyReader || tools.selfContainedHelperPath || (tools.memoryKeyProbePath && tools.pythonPath));
  const hasWxKeyReader = Boolean(options.wxKeyReader || (tools.wxKeyDllPath && (tools.selfContainedHelperPath || (tools.wxKeyProbePath && tools.pythonPath))));
  let keyInfoObserved = false;
  let memoryScanAttempted = false;
  let wxHookAttempts = 0;
  let lastWxHookStage = "";
  let wxHookKeyCaptured = false;
  let pendingWxKeyHex = "";
  let restartWechatExe = "";
  const pendingKeyAttempts = new Map();

  saveState(baseDir, {
    ...loadState(baseDir),
    status: "capturing",
    last_error: "",
    last_stage: "waiting_login_window",
    helper_configured: helper.helperConfigured,
    wx_hook_stage: "",
    wx_hook_error: ""
  });

  if (!tools.keyToolPath && !hasKeyInfoReader && !hasMemoryKeyReader && !hasWxKeyReader) {
    return block(baseDir, "key_tool_missing", "未找到微信 key 捕获工具", { helperConfigured: helper.helperConfigured, activeTouchDir: options.activeTouchDir });
  }
  if (options.restartWechat) {
    saveState(baseDir, { ...loadState(baseDir), status: "capturing", last_stage: "restarting_wechat", last_error: "" });
    const loginFlow = prepareWechatLogin({
      ...options,
      wechatExePath: findWechatExecutable({ ...options, weixinProcesses: [] }),
      stopOnly: hasWxKeyReader
    });
    if (!loginFlow.ok) {
      const reason = loginFlow.reason || "wechat_start_failed";
      const message = reason === "wechat_executable_not_found"
        ? "未找到个人微信 4.x 的 Weixin.exe，请安装受支持版本，或在同步联系人页手动选择微信程序"
        : reason === "wechat_stop_failed"
        ? "微信未能退出，尚未开始重新登录。请手动退出微信后重新同步，并确认微信与本应用使用相同的运行权限"
        : "微信未能自动重新启动";
      return block(baseDir, reason, message, { helperConfigured: helper.helperConfigured, activeTouchDir: options.activeTouchDir });
    }
    restartWechatExe = hasWxKeyReader ? String(loginFlow.wechatExePath || findWechatExecutable(options)) : "";
    saveState(baseDir, { ...loadState(baseDir), status: "capturing", last_stage: "waiting_login_window", last_error: "" });
  }

  const tryKeyForAccount = (account, keyHex, attemptDeadline = deadline) => {
    if (!keyHex || Date.now() >= attemptDeadline) return null;

    const decryptedDb = path.join(os.tmpdir(), `xiaoxi-contact-db-${process.pid}-${Date.now()}.db`);
    const decrypted = decryptContactDb(tools.dumpToolPath, keyHex, account.contactDb, decryptedDb, attemptDeadline - Date.now());
    if (!decrypted) {
      try {
        fs.rmSync(decryptedDb, { force: true });
      } catch {
        // ponytail: temp cleanup can fail without changing the capture result.
      }
      return null;
    }

    if (options.inspectOnly) {
      const inspection = inspectDecryptedContacts(baseDir, decryptedDb, options);
      try {
        fs.rmSync(decryptedDb, { force: true });
      } catch {
        // ponytail: temp cleanup can fail without changing the inspect result.
      }
      if (!inspection) return null;
      const state = {
        ...loadState(baseDir),
        status: "blocked",
        contact_count: readContacts(baseDir, options).length,
        last_error: "仅完成联系人表结构统计，未写入联系人",
        last_stage: "captured_and_inspected",
        account_name: account.accountName ?? "",
        helper_configured: helper.helperConfigured
      };
      saveState(baseDir, state);
      return { ok: true, action: "capture-inspect", state, inspection };
    }

    const rawContacts = options.decryptedContactReader ? options.decryptedContactReader(decryptedDb) : readDecryptedContacts(baseDir, decryptedDb, options);
    try {
      fs.rmSync(decryptedDb, { force: true });
    } catch {
      // ponytail: temp cleanup can fail without changing the capture result.
    }
    if (!rawContacts) return null;

    const syncedAt = new Date().toISOString();
    const accountName = account.accountName ?? "";
    const contacts = normalizeContacts(rawContacts, syncedAt, "wechat-silent-sync", accountName);
    writeJson(contactsPath(baseDir, options), contacts);
    const state = {
      ...loadState(baseDir),
      status: "synced",
      contact_count: contacts.length,
      last_synced_at: syncedAt,
      last_error: "",
      last_stage: "captured_and_synced",
      account_name: accountName,
      helper_configured: helper.helperConfigured
    };
    saveState(baseDir, state);
    return { ok: true, action: "capture", state, contacts };
  };

  const tryKey = (account, keyHex, candidates = [], attemptDeadline = deadline) => {
    if (!keyHex) return null;
    const accounts = [account, ...candidates]
      .filter((candidate) => candidate?.contactDb && fs.existsSync(candidate.contactDb))
      .filter((candidate, index, rows) => rows.findIndex((other) => other.contactDb.toLowerCase() === candidate.contactDb.toLowerCase()) === index);
    for (let index = 0; index < accounts.length; index += 1) {
      const candidate = accounts[index];
      const slots = accounts.length - index;
      const candidateDeadline = Math.min(attemptDeadline, Date.now() + Math.max(100, Math.floor((attemptDeadline - Date.now()) / slots)));
      const result = tryKeyForAccount(candidate, keyHex, candidateDeadline);
      if (result) return result;
    }
    return null;
  };

  const verifyCapturedKey = (keyHex, discoveryOptions) => {
    if (!keyHex) return null;
    const refreshedRoot = findWechatRoot(discoveryOptions);
    const candidates = refreshedRoot ? contactAccounts(refreshedRoot) : [];
    const changedCandidates = candidates.filter((candidate) => {
      const stat = fs.statSync(candidate.contactDb);
      const signature = `${stat.size}:${stat.mtimeMs}`;
      if (pendingKeyAttempts.get(candidate.contactDb) === signature) return false;
      pendingKeyAttempts.set(candidate.contactDb, signature);
      return true;
    });
    return tryKey(changedCandidates[0], keyHex, changedCandidates, deadline);
  };

  const fallbackReserveMs = hasMemoryKeyReader
    ? Math.min(30000, Math.max(pollIntervalMs, Math.floor(timeoutMs / 4)))
    : 0;
  const hookWaitDeadline = deadline - fallbackReserveMs;
  const waitForNextPoll = (startedAt) => {
    const remaining = pollIntervalMs - (Date.now() - startedAt);
    if (remaining > 0) sleep(remaining);
  };

  while (Date.now() < deadline) {
    const pollStartedAt = Date.now();
    const processes = runningWeixinProcesses(options);
    const hookProcesses = processes.filter((processInfo) => processInfo.moduleReady !== false);
    const discoveryOptions = { ...options, weixinProcesses: processes };

    const wechatRoot = findWechatRoot(discoveryOptions);
    const account = wechatRoot && fs.existsSync(wechatRoot) ? findAccount(wechatRoot) : {};
    const accounts = wechatRoot ? contactAccounts(wechatRoot) : [];
    const wechatExePath = processes[0]?.path || findWechatExecutable(discoveryOptions);
    const waitingForModule = options.restartWechat && hasWxKeyReader && !restartWechatExe && processes.length && !hookProcesses.length && Date.now() < hookWaitDeadline;

    saveState(baseDir, {
      ...loadState(baseDir),
      status: "capturing",
      last_stage: waitingForModule ? "waiting_weixin_module" : account.keyInfoDb && fs.existsSync(account.keyInfoDb) ? "capturing_key_info" : processes.length ? "capturing_key" : "waiting_weixin_process",
      account_name: account.accountName ?? "",
      helper_configured: helper.helperConfigured,
      wechat_exe_path: wechatExePath || restartWechatExe,
      wechat_root: wechatRoot ?? ""
    });

    if (pendingWxKeyHex) {
      const result = verifyCapturedKey(pendingWxKeyHex, discoveryOptions);
      if (result) return result;
    }

    const captureFromKeyInfo = (maxTimeoutMs = 5000) => {
      if (!account.contactDb || !account.keyInfoDb || Date.now() >= deadline) return null;
      const keyInfoResult = captureKeyFromKeyInfo(account.keyInfoDb, tools, options, Math.min(maxTimeoutMs, deadline - Date.now()));
      keyInfoObserved = keyInfoObserved || Boolean(keyInfoResult.observed);
      return tryKey(account, keyInfoResult.keyHex, accounts);
    };

    if (waitingForModule) {
      const result = captureFromKeyInfo(1000);
      if (result) return result;
      waitForNextPoll(pollStartedAt);
      continue;
    }

    const captureFromMemory = () => {
      const memoryAccounts = accounts.length ? accounts : account.contactDb ? [account] : [];
      if (!memoryAccounts.length || !processes.length || !hasMemoryKeyReader || Date.now() >= deadline) return null;
      memoryScanAttempted = true;
      saveState(baseDir, {
        ...loadState(baseDir),
        status: "capturing",
        last_stage: "capturing_memory_key",
        account_name: account.accountName ?? "",
        helper_configured: helper.helperConfigured
      });
      for (let index = 0; index < memoryAccounts.length; index += 1) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return null;
        const hookReserveMs = !options.restartWechat && hasWxKeyReader ? Math.min(30000, Math.max(100, Math.floor(remainingMs / 4))) : 0;
        const slots = memoryAccounts.length - index;
        const accountBudgetMs = Math.max(100, Math.floor((remainingMs - hookReserveMs) / slots));
        const candidate = memoryAccounts[index];
        const keyHex = captureKeyFromMemory(candidate.contactDb, tools, options, processes, accountBudgetMs);
        const result = tryKey(candidate, keyHex, accounts);
        if (result) return result;
      }
      return null;
    };

    const captureFromWxHook = () => {
      if (
        (!hookProcesses.length && !restartWechatExe) ||
        !hasWxKeyReader ||
        pendingWxKeyHex ||
        (options.restartWechat && wxHookAttempts >= 3) ||
        Date.now() >= deadline
      ) return null;
      wxHookAttempts += 1;
      const launchWechatExe = restartWechatExe;
      restartWechatExe = "";
      saveState(baseDir, {
        ...loadState(baseDir),
        status: "capturing",
        last_stage: "capturing_wx_key_hook",
        helper_configured: helper.helperConfigured,
        wechat_exe_path: processes[0]?.path || launchWechatExe
      });
      const remainingMs = Math.max(1000, deadline - Date.now());
      const memoryReserveMs = options.restartWechat && hasMemoryKeyReader ? Math.min(30000, Math.max(1000, Math.floor(remainingMs / 4))) : 0;
      const wxKeyHex = captureKeyFromWxKeyDll(tools, {
        ...options,
        launchWechatExe,
        onWxKeyResult: (result) => {
          options.onWxKeyResult?.(result);
          lastWxHookStage = result.stage;
          saveState(baseDir, {
            ...loadState(baseDir),
            wx_hook_stage: result.stage,
            wx_hook_error: result.error
          });
        }
      }, hookProcesses, Math.max(1000, remainingMs - memoryReserveMs));
      if (launchWechatExe && !wxKeyHex) {
        const startupErrors = {
          dll_missing: "微信同步组件缺失，尚未启动微信。请通过应用更新修复安装后重新同步",
          dll_load_failed: "微信同步组件加载失败，尚未启动微信。请检查安全软件拦截记录，并通过应用更新修复安装",
          wechat_exe_missing: "所选微信程序已不存在，尚未启动微信。请重新选择 Weixin.exe",
          wechat_launch_failed: "未能启动微信，请检查所选微信程序和运行权限后重新同步",
          helper_start_failed: "微信同步辅助程序未能启动，请检查安全软件拦截记录并修复安装",
          helper_failed: "微信同步辅助程序异常退出，无法确认微信启动状态。请检查诊断记录后重试",
          helper_timeout: "微信同步辅助程序未在规定时间内返回，无法确认微信启动状态。请检查微信窗口及安全软件拦截记录",
          helper_result_invalid: "微信同步辅助程序返回无效结果，请通过应用更新修复安装后重新同步",
          suspend_failed: "无法为微信准备登录捕获，请确认微信与本应用使用相同的运行权限",
          resume_failed: "微信登录进程未能恢复，请手动重新打开微信后重试同步",
          weixin_dll_timeout: "微信已启动，但核心模块未及时就绪。请确认微信能正常打开，并检查其完整版本号"
        };
        if (startupErrors[lastWxHookStage]) {
          return block(baseDir, lastWxHookStage, startupErrors[lastWxHookStage], {
            helperConfigured: helper.helperConfigured,
            activeTouchDir: options.activeTouchDir
          });
        }
      }
      if (wxKeyHex) {
        wxHookKeyCaptured = true;
        pendingWxKeyHex = wxKeyHex;
      }
      return verifyCapturedKey(pendingWxKeyHex, discoveryOptions);
    };

    const captureAttempts = options.restartWechat ? [captureFromWxHook] : [captureFromKeyInfo, captureFromMemory, captureFromWxHook];
    for (const attempt of captureAttempts) {
      const result = attempt();
      if (result) return result;
    }
    if (options.restartWechat && lastWxHookStage === "init_failed" && wxHookAttempts < 3 && Date.now() < hookWaitDeadline) {
      waitForNextPoll(pollStartedAt);
      continue;
    }
    if (options.restartWechat) {
      for (const attempt of [captureFromKeyInfo, captureFromMemory]) {
        const result = attempt();
        if (result) return result;
      }
    }

    if (account.contactDb && processes.length && tools.keyToolPath) {
      for (const processInfo of processes) {
        const keyHex = captureKey(tools.keyToolPath, processInfo.id);
        const result = tryKey(account, keyHex, accounts);
        if (result) return result;
      }
    }

    waitForNextPoll(pollStartedAt);
  }

  const finalProcesses = runningWeixinProcesses(options);
  const finalWechatRoot = findWechatRoot({ ...options, weixinProcesses: finalProcesses });
  if (!finalWechatRoot) {
    return block(baseDir, "wechat_root_not_found", "未找到微信数据目录，请确认微信已登录或手动选择 xwechat_files", {
      helperConfigured: helper.helperConfigured,
      activeTouchDir: options.activeTouchDir
    });
  }
  const finalAccount = findAccount(finalWechatRoot);
  if (!finalAccount.contactDb || !fs.existsSync(finalAccount.contactDb)) {
    return block(baseDir, "contact_db_not_found", "微信数据目录中未找到 contact.db", {
      helperConfigured: helper.helperConfigured,
      activeTouchDir: options.activeTouchDir
    });
  }
  if (!finalProcesses.length) {
    return block(baseDir, "weixin_process_not_found", "未找到正在运行的微信主进程", {
      helperConfigured: helper.helperConfigured,
      activeTouchDir: options.activeTouchDir
    });
  }

  let timeoutStage = "capture_timeout";
  let timeoutMessage = "登录窗口期内未捕获到可用密钥";
  if (keyInfoObserved) {
    timeoutStage = "capture_timeout_key_info_observed";
    timeoutMessage = "已观察 key_info.db，但登录窗口期内未出现可用明文密钥";
  }
  if (wxHookAttempts > 0) {
    timeoutStage = "capture_timeout_wx_hook";
    timeoutMessage = wxHookKeyCaptured
      ? "微信 hook 已捕获密钥，但未匹配到可用联系人数据库"
      : "已安装微信登录期 hook，但登录窗口期内未捕获到可用密钥";
  }
  if (memoryScanAttempted && wxHookAttempts > 0) {
    timeoutStage = "capture_timeout_wx_hook_then_memory";
    timeoutMessage = wxHookKeyCaptured
      ? "微信 hook 已捕获密钥，但未匹配到可用联系人数据库；内存回退也未匹配成功"
      : `微信 hook 未捕获到密钥（${lastWxHookStage || "unknown"}），内存回退也未匹配到可用密钥`;
  } else if (memoryScanAttempted) {
    timeoutStage = "capture_timeout_memory_scanned";
    timeoutMessage = keyInfoObserved
      ? "已观察 key_info.db 并扫描微信进程内存，但未匹配到可用密钥"
      : "已扫描微信进程内存，但未匹配到可用密钥";
  }

  return block(baseDir, "capture_timeout", timeoutMessage, {
    helperConfigured: helper.helperConfigured,
    activeTouchDir: options.activeTouchDir,
    state: { last_stage: timeoutStage }
  });
}

function sync(baseDir = __dirname, options = {}) {
  const wechatRoot = findWechatRoot(options);
  const helper = resolveHelper(baseDir, options);

  if (!fs.existsSync(wechatRoot)) {
    return block(baseDir, "wechat_root_not_found", "未找到微信数据目录", { helperConfigured: helper.helperConfigured, activeTouchDir: options.activeTouchDir });
  }

  const account = findAccount(wechatRoot);
  if (!account.accountDir || !account.hasContact) {
    return block(baseDir, "contact_db_not_found", "未找到 contact.db", { helperConfigured: helper.helperConfigured, activeTouchDir: options.activeTouchDir });
  }

  if (!account.hasKey || !account.keyInfoDb || !fs.existsSync(account.keyInfoDb)) {
    return block(baseDir, "key_info_not_found", "未找到 key_info.db，请重启微信并进入登录窗口期后再同步", {
      helperConfigured: helper.helperConfigured,
      activeTouchDir: options.activeTouchDir,
      state: { account_name: account.accountName ?? path.basename(account.accountDir) }
    });
  }

  if (!helper.helperPath || !fs.existsSync(helper.helperPath)) {
    return block(baseDir, "decrypt_helper_missing", "未配置微信通讯录解密 helper", {
      helperConfigured: false,
      activeTouchDir: options.activeTouchDir,
      state: { account_name: account.accountName ?? path.basename(account.accountDir) }
    });
  }
  if (path.extname(helper.helperPath).toLowerCase() === ".py" && !helper.pythonPath) {
    return block(baseDir, "python_runtime_missing", "内置联系人 helper 缺少 Python 运行时", {
      helperConfigured: false,
      activeTouchDir: options.activeTouchDir,
      state: { account_name: account.accountName ?? path.basename(account.accountDir) }
    });
  }

  const tempOut = path.join(os.tmpdir(), `xiaoxi-contact-sync-${process.pid}-${Date.now()}.json`);
  const helperResult = options.decryptDriver ? options.decryptDriver(account.accountDir, tempOut) : runHelper(helper, account, tempOut);
  if (!helperResult.ok) {
    try {
      fs.rmSync(tempOut, { force: true });
    } catch {
      // ponytail: temp cleanup can fail without changing the sync result.
    }
    return block(baseDir, "decrypt_failed", "通讯录解密失败", {
      helperConfigured: true,
      activeTouchDir: options.activeTouchDir,
      state: { account_name: account.accountName ?? path.basename(account.accountDir) }
    });
  }

  const syncedAt = new Date().toISOString();
  const accountName = account.accountName ?? path.basename(account.accountDir);
  const contacts = normalizeContacts(readJson(tempOut, []), syncedAt, "wechat-silent-sync", accountName);
  try {
    fs.rmSync(tempOut, { force: true });
  } catch {
    // ponytail: temp cleanup can fail without changing the sync result.
  }

  writeJson(contactsPath(baseDir, options), contacts);
  const state = {
    ...loadState(baseDir),
    status: "synced",
    contact_count: contacts.length,
    last_synced_at: syncedAt,
    last_error: "",
    last_stage: "synced",
    account_name: accountName,
    helper_configured: true
  };
  saveState(baseDir, state);
  return { ok: true, action: "sync", state, contacts };
}

function status(baseDir = __dirname, options = {}) {
  const storedState = loadState(baseDir);
  const accountName = String(storedState.account_name ?? "").trim();
  let contacts = readContacts(baseDir, options);
  if (accountName && contacts.some((contact) => !String(contact.wechatAccountId ?? "").trim())) {
    contacts = contacts.map((contact) => ({ ...contact, wechatAccountId: String(contact.wechatAccountId ?? "").trim() || accountName }));
    writeJson(contactsPath(baseDir, options), contacts);
  }
  const helper = resolveHelper(baseDir, options);
  const processes = runningWeixinProcesses(options);
  const discoveryOptions = { ...options, weixinProcesses: processes };
  const state = {
    ...storedState,
    contact_count: contacts.length,
    helper_configured: helper.helperConfigured,
    wechat_exe_path: findWechatExecutable(discoveryOptions),
    wechat_root: findWechatRoot(discoveryOptions)
  };
  return { ok: true, action: "status", state, contacts };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) return "";
  return args[index + 1];
}

function main(argv) {
  const [command = "status", ...args] = argv.slice(2);
  const options = {
    dataDir: valueAfter(args, "--data-dir") || undefined,
    wechatRoot: valueAfter(args, "--wechat-root") || undefined,
    wechatExePath: valueAfter(args, "--wechat-exe") || undefined,
    helperPath: valueAfter(args, "--helper") || undefined,
    pythonPath: valueAfter(args, "--python") || undefined,
    activeTouchDir: valueAfter(args, "--active-touch-dir") || undefined,
    keyToolPath: valueAfter(args, "--key-tool") || undefined,
    dumpToolPath: valueAfter(args, "--dump-tool") || undefined,
    timeoutMs: Number(valueAfter(args, "--timeout") || 90) * 1000,
    restartWechat: args.includes("--restart-wechat")
  };
  if (command === "sync") return sync(options.dataDir, options);
  if (command === "capture-inspect") return capture(options.dataDir, { ...options, inspectOnly: true });
  if (command === "capture") return capture(options.dataDir, options);
  if (command === "status") return status(options.dataDir, options);
  return { ok: false, action: command, error: `Unknown command: ${command}` };
}

if (require.main === module) {
  const result = main(process.argv);
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  candidateWechatRoots,
  runningWeixinProcesses,
  installedWeixinExecutables,
  normalizeContacts,
  findAccount,
  findWechatExecutable,
  findWechatRoot,
  capture,
  captureKeyFromWxKeyDll,
  decryptSqlcipher4Raw,
  prepareWechatLogin,
  resolveHelper,
  status,
  sync
};
