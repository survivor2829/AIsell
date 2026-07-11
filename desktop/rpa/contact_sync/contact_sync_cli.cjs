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
  helper_configured: false
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
  const dumpToolPath = options.dumpToolPath ?? process.env.XIAOXI_WECHAT_DUMP_TOOL ?? "";
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

function runningWeixinDataRoots() {
  if (process.platform !== "win32") return [];
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Get-Process Weixin -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique"
    ],
    { encoding: "utf8", windowsHide: true, timeout: 3000 }
  );
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((exePath) => path.resolve(path.dirname(exePath), "..", "xwechat_files"));
}

function runningWeixinProcesses(options = {}) {
  if (options.processProvider) return options.processProvider();
  if (process.platform !== "win32") return [];
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='Weixin.exe'\" -ErrorAction SilentlyContinue | Select-Object @{Name='Id';Expression={$_.ProcessId}},@{Name='Path';Expression={$_.ExecutablePath}},CommandLine | ConvertTo-Json -Compress"
    ],
    { encoding: "utf8", windowsHide: true, timeout: 3000 }
  );
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    const processes = (Array.isArray(parsed) ? parsed : [parsed])
      .map((row) => ({ id: Number(row.Id), path: String(row.Path ?? ""), commandLine: String(row.CommandLine ?? "") }))
      .filter((row) => row.id);
    const mainProcesses = processes.filter((row) => !/--type=/i.test(row.commandLine));
    return mainProcesses.length ? mainProcesses : processes;
  } catch {
    return [];
  }
}

const PREPARE_WECHAT_LOGIN_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$running = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" -ErrorAction SilentlyContinue)
$main = $running | Where-Object { $_.CommandLine -notmatch "--type=" } | Select-Object -First 1
$paths = New-Object System.Collections.Generic.List[string]
if ($main -and $main.ExecutablePath) { [void]$paths.Add($main.ExecutablePath) }
foreach ($path in @(
  "D:\\微信\\Weixin\\Weixin.exe",
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
$restarted = $running.Count -gt 0
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
try {
  Start-Process -FilePath $exe | Out-Null
  @{ ok = $true; restarted = $restarted } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; reason = "wechat_start_failed" } | ConvertTo-Json -Compress
}
`;

function prepareWechatLogin(options = {}) {
  if (options.loginFlowDriver) return options.loginFlowDriver();
  if (process.platform !== "win32") return { ok: false, reason: "unsupported_platform" };
  const encoded = Buffer.from(PREPARE_WECHAT_LOGIN_SCRIPT, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000
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
            `${drive}:\\微信\\xwechat_files`,
            `${drive}:\\WeChat\\xwechat_files`,
            `${drive}:\\Weixin\\xwechat_files`
          ])
      : [];
  return [
    explicit,
    defaultWechatRoot(),
    path.join(os.homedir(), "Documents", "WeChat Files"),
    ...runningWeixinDataRoots(),
    ...driveRoots
  ].filter(Boolean);
}

function findWechatRoot(options = {}) {
  if (options.wechatRoot) return options.wechatRoot;
  if (process.env.XIAOXI_WECHAT_ROOT) return process.env.XIAOXI_WECHAT_ROOT;
  const existingRoots = candidateWechatRoots(options).filter((root) => fs.existsSync(root));
  return existingRoots.find((root) => {
    const account = findAccount(root);
    return account.hasContact || account.hasKey;
  }) ?? existingRoots[0] ?? "";
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
  if (!fs.existsSync(loginRoot)) return [];
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

function normalizeContact(row, index, syncedAt, source = "wechat-silent-sync", wechatAccountId = "") {
  const remark = String(row.remark ?? "").trim();
  const nickname = String(row.nickname ?? row.nick_name ?? "").trim();
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

function runTool(toolPath, args) {
  const ext = path.extname(toolPath).toLowerCase();
  const command = ext === ".js" || ext === ".cjs" ? process.execPath : toolPath;
  const finalArgs = command === process.execPath ? [toolPath, ...args] : args;
  return spawnSync(command, finalArgs, { encoding: "utf8", windowsHide: true, timeout: 20000 });
}

function captureKey(keyToolPath, pid) {
  const result = runTool(keyToolPath, ["key", "-p", String(pid)]);
  if (result.status !== 0) return "";
  const match = `${result.stdout}\n${result.stderr}`.match(/\b[a-fA-F0-9]{64}\b/);
  return match ? match[0] : "";
}

function captureKeyFromKeyInfo(keyInfoDb, tools, options = {}) {
  if (options.keyInfoReader) {
    const result = options.keyInfoReader(keyInfoDb);
    if (typeof result === "string") return { keyHex: result, observed: Boolean(result) };
    return { keyHex: result?.keyHex ?? "", observed: Boolean(result?.observed) };
  }
  if (!keyInfoDb || !fs.existsSync(keyInfoDb) || (!tools.selfContainedHelperPath && (!tools.keyInfoProbePath || !tools.pythonPath))) {
    return { keyHex: "", observed: false };
  }

  const result = tools.selfContainedHelperPath
    ? runTool(tools.selfContainedHelperPath, ["key-info", "--key-info", keyInfoDb])
    : spawnSync(tools.pythonPath, [tools.keyInfoProbePath, "--key-info", keyInfoDb], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  if (result.status !== 0) return { keyHex: "", observed: false };

  const parsed = readJsonFromString(result.stdout, {});
  const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  return {
    keyHex: candidates.find((candidate) => /^[a-fA-F0-9]{64}$/.test(candidate)) ?? "",
    observed: Number(parsed.rows_seen ?? 0) > 0
  };
}

function captureKeyFromMemory(contactDb, tools, options = {}, processes = []) {
  if (options.memoryKeyReader) {
    const result = options.memoryKeyReader(contactDb);
    return typeof result === "string" ? result : result?.keyHex ?? "";
  }
  if (!contactDb || !fs.existsSync(contactDb) || (!tools.selfContainedHelperPath && (!tools.memoryKeyProbePath || !tools.pythonPath))) return "";
  const pidArgs = processes.flatMap((processInfo) => ["--pid", String(processInfo.id)]);
  const result = tools.selfContainedHelperPath
    ? spawnSync(tools.selfContainedHelperPath, ["memory-key", "--contact-db", contactDb, ...pidArgs], { encoding: "utf8", windowsHide: true, timeout: 60000 })
    : spawnSync(tools.pythonPath, [tools.memoryKeyProbePath, "--contact-db", contactDb, ...pidArgs], { encoding: "utf8", windowsHide: true, timeout: 60000 });
  if (result.status !== 0) return "";
  const parsed = readJsonFromString(result.stdout, {});
  const keyHex = String(parsed.key ?? "");
  return /^[a-fA-F0-9]{64}$/.test(keyHex) ? keyHex : "";
}

function captureKeyFromWxKeyDll(tools, options = {}, processes = [], timeoutMs = 90000) {
  if (options.wxKeyReader) {
    const result = options.wxKeyReader();
    return typeof result === "string" ? result : result?.keyHex ?? "";
  }
  if (!tools.wxKeyProbePath || !tools.wxKeyDllPath || !tools.pythonPath) return "";
  const pidArgs = processes.flatMap((processInfo) => ["--pid", String(processInfo.id)]);
  const result = spawnSync(
    tools.pythonPath,
    [
      tools.wxKeyProbePath,
      "--dll",
      tools.wxKeyDllPath,
      "--timeout",
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      ...pidArgs
    ],
    { encoding: "utf8", windowsHide: true, timeout: timeoutMs + 5000 }
  );
  if (result.status !== 0) return "";
  const parsed = readJsonFromString(result.stdout, {});
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

function decryptContactDb(dumpToolPath, keyHex, contactDbPath, outputDbPath) {
  if (decryptSqlcipher4Raw(contactDbPath, outputDbPath, keyHex)) return true;
  if (!dumpToolPath || !fs.existsSync(dumpToolPath)) return false;
  for (const version of ["4", "3"]) {
    const result = runTool(dumpToolPath, ["-k", keyHex, "-f", contactDbPath, "-o", outputDbPath, "--vv", version]);
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
  const hasWxKeyReader = Boolean(options.wxKeyReader || (tools.wxKeyProbePath && tools.wxKeyDllPath && tools.pythonPath));
  let keyInfoObserved = false;
  let memoryScanAttempted = false;
  let wxHookAttempted = false;

  saveState(baseDir, {
    ...loadState(baseDir),
    status: "capturing",
    last_error: "",
    last_stage: "waiting_login_window",
    helper_configured: helper.helperConfigured
  });

  if (!tools.keyToolPath && !hasKeyInfoReader && !hasMemoryKeyReader && !hasWxKeyReader) {
    return block(baseDir, "key_tool_missing", "未找到微信 key 捕获工具", { helperConfigured: helper.helperConfigured, activeTouchDir: options.activeTouchDir });
  }
  if (options.restartWechat) {
    saveState(baseDir, { ...loadState(baseDir), status: "capturing", last_stage: "restarting_wechat", last_error: "" });
    const loginFlow = prepareWechatLogin(options);
    if (!loginFlow.ok) {
      const reason = loginFlow.reason || "wechat_start_failed";
      const message = reason === "wechat_executable_not_found" ? "未找到微信程序，请先安装微信" : "微信未能自动重新启动";
      return block(baseDir, reason, message, { helperConfigured: helper.helperConfigured, activeTouchDir: options.activeTouchDir });
    }
    saveState(baseDir, { ...loadState(baseDir), status: "capturing", last_stage: "waiting_login_window", last_error: "" });
  }

  const tryKey = (account, keyHex) => {
    if (!keyHex) return null;

    const decryptedDb = path.join(os.tmpdir(), `xiaoxi-contact-db-${process.pid}-${Date.now()}.db`);
    const decrypted = decryptContactDb(tools.dumpToolPath, keyHex, account.contactDb, decryptedDb);
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

  while (Date.now() < deadline) {
    const wechatRoot = findWechatRoot(options);
    const account = wechatRoot && fs.existsSync(wechatRoot) ? findAccount(wechatRoot) : {};
    const processes = runningWeixinProcesses(options);

    saveState(baseDir, {
      ...loadState(baseDir),
      status: "capturing",
      last_stage: account.keyInfoDb ? "capturing_key_info" : processes.length ? "capturing_key" : "waiting_weixin_process",
      account_name: account.accountName ?? "",
      helper_configured: helper.helperConfigured
    });

    if (account.contactDb && account.keyInfoDb) {
      const keyInfoResult = captureKeyFromKeyInfo(account.keyInfoDb, tools, options);
      keyInfoObserved = keyInfoObserved || Boolean(keyInfoResult.observed);
      const result = tryKey(account, keyInfoResult.keyHex);
      if (result) return result;
    }

    if (account.contactDb && processes.length && hasMemoryKeyReader) {
      memoryScanAttempted = true;
      saveState(baseDir, {
        ...loadState(baseDir),
        status: "capturing",
        last_stage: "capturing_memory_key",
        account_name: account.accountName ?? "",
        helper_configured: helper.helperConfigured
      });
      const result = tryKey(account, captureKeyFromMemory(account.contactDb, tools, options, processes));
      if (result) return result;
    }

    if (account.contactDb && processes.length && hasWxKeyReader) {
      wxHookAttempted = true;
      saveState(baseDir, {
        ...loadState(baseDir),
        status: "capturing",
        last_stage: "capturing_wx_key_hook",
        account_name: account.accountName ?? "",
        helper_configured: helper.helperConfigured
      });
      const remainingMs = Math.max(1000, deadline - Date.now());
      const result = tryKey(account, captureKeyFromWxKeyDll(tools, options, processes, remainingMs));
      if (result) return result;
    }

    if (account.contactDb && processes.length && tools.keyToolPath) {
      for (const processInfo of processes) {
        const keyHex = captureKey(tools.keyToolPath, processInfo.id);
        const result = tryKey(account, keyHex);
        if (result) return result;
      }
    }

    sleep(pollIntervalMs);
  }

  const timeoutStage = memoryScanAttempted
    ? "capture_timeout_memory_scanned"
    : wxHookAttempted
      ? "capture_timeout_wx_hook"
    : keyInfoObserved
      ? "capture_timeout_key_info_observed"
      : "capture_timeout";
  const timeoutMessage = memoryScanAttempted
    ? "已观察 key_info.db 并扫描微信进程内存，但未匹配到可用密钥"
    : wxHookAttempted
      ? "已安装微信登录期 hook，但登录窗口期内未捕获到可用密钥"
    : keyInfoObserved
      ? "已观察 key_info.db，但登录窗口期内未出现可用明文密钥"
      : "登录窗口期内未捕获到可用密钥";

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
  const state = {
    ...storedState,
    contact_count: contacts.length,
    helper_configured: helper.helperConfigured
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
  normalizeContacts,
  findAccount,
  findWechatRoot,
  capture,
  captureKeyFromWxKeyDll,
  decryptSqlcipher4Raw,
  prepareWechatLogin,
  resolveHelper,
  status,
  sync
};
