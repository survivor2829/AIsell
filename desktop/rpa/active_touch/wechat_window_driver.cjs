const { WECHAT_CLIPBOARD_POWERSHELL } = require("./wechat_clipboard.cjs");
const { WECHAT_RENDER_SURFACE_POWERSHELL } = require("./wechat_render_surface.cjs");
const { spawn, spawnSync } = require("node:child_process");
const { findWechatExecutable } = require("../contact_sync/contact_sync_cli.cjs");
const { readWechatWindowDiagnostics, readMomentsDiagnostics } = require("../../src/shared/wechat-window-diagnostics.cjs");
const { WECHAT_MAIN_WINDOW_VISUAL_SCRIPT } = require("./wechat_window_visual.cjs");
const { resolveWechatSearchResultObservation } = require("./wechat_search_result_resolver.cjs");

let cachedWechatExecutable = "";
let cachedWechatExecutableAt = 0;
let unconfirmedPowerShellWorkerCount = 0;

function wechatExecutableForLaunch() {
  const now = Date.now();
  if (now - cachedWechatExecutableAt < 30_000) return cachedWechatExecutable;
  cachedWechatExecutableAt = now;
  try {
    cachedWechatExecutable = String(findWechatExecutable() || "");
  } catch {
    cachedWechatExecutable = "";
  }
  return cachedWechatExecutable;
}

const POWERSHELL_STDIN_BOOTSTRAP = Buffer.from(
  '$ProgressPreference="SilentlyContinue";$raw=[Console]::In.ReadToEnd();$text=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($raw));. ([ScriptBlock]::Create($text))',
  "utf16le"
).toString("base64");

const DPI_AWARE_POWERSHELL = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class Win32XiaoxiDpiContext {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
}
public static class Win32XiaoxiParentGuard {
  private const uint SYNCHRONIZE = 0x00100000u;
  private const uint WAIT_OBJECT_0 = 0x00000000u;
  private const uint INFINITE = 0xffffffffu;
  private static IntPtr parentHandle = IntPtr.Zero;
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
  [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  public static bool Start(int parentProcessId) {
    if (parentProcessId <= 0 || parentHandle != IntPtr.Zero) return false;
    parentHandle = OpenProcess(SYNCHRONIZE, false, parentProcessId);
    if (parentHandle == IntPtr.Zero) return false;
    Thread watcher = new Thread(() => {
      uint result = WaitForSingleObject(parentHandle, INFINITE);
      if (result == WAIT_OBJECT_0) Environment.Exit(197);
      Environment.Exit(198);
    });
    watcher.IsBackground = true;
    watcher.Name = "xiaoxi-parent-guard";
    watcher.Start();
    return true;
  }
}
"@
[int]$xiaoxiParentPid = 0
if (-not [int]::TryParse([string]$env:XIAOXI_PARENT_PID, [ref]$xiaoxiParentPid) -or
  -not [Win32XiaoxiParentGuard]::Start($xiaoxiParentPid)) { exit 197 }
try { [void][Win32XiaoxiDpiContext]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch {}
`;

const ENSURE_WECHAT_WINDOW_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32WechatEnsureWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
function Get-PersonalWechatWindows {
  $items = New-Object System.Collections.Generic.List[object]
  $processNames = @("Weixin", "WeChat")
  $callback = [Win32WechatEnsureWindow+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    [uint32]$windowProcessId = 0
    [void][Win32WechatEnsureWindow]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
    $proc = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
    if ($proc -and $processNames -contains $proc.ProcessName -and [Win32WechatEnsureWindow]::IsWindowVisible($hWnd)) {
      $rect = New-Object Win32WechatEnsureWindow+RECT
      [void][Win32WechatEnsureWindow]::GetWindowRect($hWnd, [ref]$rect)
      $w = $rect.Right - $rect.Left
      $h = $rect.Bottom - $rect.Top
      $isIconic = [Win32WechatEnsureWindow]::IsIconic($hWnd)
      $isLoginSize = (-not $isIconic -and $w -ge 240 -and $w -le 600 -and $h -ge 280 -and $h -le 760)
      $isNormalMainWindow = ($w -ge 600 -and $h -ge 500)
      if ($isNormalMainWindow -or $isLoginSize) {
        [void]$items.Add(@{ hWnd = $hWnd; pid = [int]$windowProcessId; processName = $proc.ProcessName; visible = $true; minimized = $isIconic; isMain = $isNormalMainWindow; isLogin = ($isLoginSize -and -not $isNormalMainWindow); x = $rect.Left; y = $rect.Top; w = $w; h = $h; area = [int64]$w * [int64]$h })
      }
    }
    return $true
  }
  [void][Win32WechatEnsureWindow]::EnumWindows($callback, [IntPtr]::Zero)
  return $items
}
function Test-VisiblePersonalWechat {
  foreach ($item in (Get-PersonalWechatWindows | Sort-Object area -Descending)) {
    if ($item.isMain -and $item.visible -and -not $item.minimized) { return $true }
  }
  return $false
}
function Test-PersonalWechatLoginWindow {
  foreach ($item in Get-PersonalWechatWindows) {
    if ($item.isLogin) { return $true }
  }
  return $false
}
function Focus-PersonalWechatMainWindow {
  $item = Get-PersonalWechatWindows | Where-Object { $_.isMain } | Sort-Object area -Descending | Select-Object -First 1
  if (-not $item) { return $false }
  $hWnd = [IntPtr]$item.hWnd
  if ($item.minimized) {
    [void][Win32WechatEnsureWindow]::ShowWindowAsync($hWnd, 9)
    Start-Sleep -Milliseconds 250
  }
  if ([Win32WechatEnsureWindow]::GetForegroundWindow() -eq $hWnd) { return $true }
  $focused = [Win32WechatEnsureWindow]::SetForegroundWindow($hWnd)
  if (-not $focused) { try { $focused = (New-Object -ComObject WScript.Shell).AppActivate([int]$item.pid) } catch {} }
  Start-Sleep -Milliseconds 120
  return $focused -or [Win32WechatEnsureWindow]::GetForegroundWindow() -eq $hWnd
}
function Start-PersonalWechat {
  $paths = New-Object System.Collections.Generic.List[string]
  foreach ($name in @("Weixin", "WeChat")) {
    foreach ($proc in Get-Process -Name $name -ErrorAction SilentlyContinue) {
      if ($proc.Path -and -not $paths.Contains($proc.Path)) { [void]$paths.Add($proc.Path) }
    }
  }
  $pf86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  foreach ($path in @(
    "$env:XIAOXI_WECHAT_EXE",
    "$env:LOCALAPPDATA\\Tencent\\WeChat\\WeChat.exe",
    "$env:ProgramFiles\\Tencent\\WeChat\\WeChat.exe",
    "$pf86\\Tencent\\WeChat\\WeChat.exe"
  )) {
    if ($path -and (Test-Path $path) -and -not $paths.Contains($path)) { [void]$paths.Add($path) }
  }
  $cmd = Get-Command Weixin.exe -ErrorAction SilentlyContinue
  if ($cmd -and -not $paths.Contains($cmd.Source)) { [void]$paths.Add($cmd.Source) }
  $cmd = Get-Command WeChat.exe -ErrorAction SilentlyContinue
  if ($cmd -and -not $paths.Contains($cmd.Source)) { [void]$paths.Add($cmd.Source) }
  foreach ($path in $paths) {
    try {
      Start-Process -FilePath $path | Out-Null
      return $true
    } catch {}
  }
  return $false
}
if (Get-PersonalWechatWindows | Where-Object { $_.isMain } | Select-Object -First 1) {
  [void](Focus-PersonalWechatMainWindow)
} elseif (-not (Test-PersonalWechatLoginWindow)) {
  [void](Start-PersonalWechat)
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-PersonalWechatWindows | Where-Object { $_.isMain } | Select-Object -First 1) {
      [void](Focus-PersonalWechatMainWindow)
      break
    }
  }
}
$visible = Test-VisiblePersonalWechat
$reason = ""
if (-not $visible -and (Test-PersonalWechatLoginWindow)) { $reason = "wechat_login_required" }
elseif (-not $visible) { $reason = "wechat_window_not_found" }
@{ ok = $visible; reason = $reason } | ConvertTo-Json -Compress
`;

const SIMPLE_ENSURE_WECHAT_WINDOW_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32WechatSimpleWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {
    public int length; public int flags; public int showCmd;
    public POINT ptMinPosition; public POINT ptMaxPosition; public RECT rcNormalPosition;
  }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder text, int maxCount);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
function Get-PersonalWechatWindowEvidence([IntPtr]$hWnd) {
  $rect = New-Object Win32WechatSimpleWindow+RECT
  if (-not [Win32WechatSimpleWindow]::GetWindowRect($hWnd, [ref]$rect)) { return $null }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $minimized = [Win32WechatSimpleWindow]::IsIconic($hWnd)
  $normalWidth = 0
  $normalHeight = 0
  if ($minimized) {
    $placement = New-Object Win32WechatSimpleWindow+WINDOWPLACEMENT
    $placement.length = [Runtime.InteropServices.Marshal]::SizeOf([type][Win32WechatSimpleWindow+WINDOWPLACEMENT])
    if ([Win32WechatSimpleWindow]::GetWindowPlacement($hWnd, [ref]$placement)) {
      $normalWidth = $placement.rcNormalPosition.Right - $placement.rcNormalPosition.Left
      $normalHeight = $placement.rcNormalPosition.Bottom - $placement.rcNormalPosition.Top
    }
  }
  $classText = New-Object System.Text.StringBuilder 256
  [void][Win32WechatSimpleWindow]::GetClassName($hWnd, $classText, $classText.Capacity)
  $className = $classText.ToString().Trim()
  $style = [uint32]([int64][Win32WechatSimpleWindow]::GetWindowLong($hWnd, -16) -band 4294967295L)
  $exStyle = [uint32]([int64][Win32WechatSimpleWindow]::GetWindowLong($hWnd, -20) -band 4294967295L)
  $hasMainClass = $className -ieq "mmui::MainWindow" -or $className -match "(?i)MainWindow"
  $hasMainStyle = (($style -band [uint32]0x00040000) -ne 0) -and (($exStyle -band [uint32]0x00000080) -eq 0)
  $effectiveWidth = if ($minimized -and $normalWidth -gt 0) { $normalWidth } else { $width }
  $effectiveHeight = if ($minimized -and $normalHeight -gt 0) { $normalHeight } else { $height }
  return @{
    width = $width; height = $height; minimized = [bool]$minimized
    normalWidth = $normalWidth; normalHeight = $normalHeight
    effectiveWidth = $effectiveWidth; effectiveHeight = $effectiveHeight
    windowClass = $className; hasMainClass = [bool]$hasMainClass; hasMainStyle = [bool]$hasMainStyle
  }
}
function Get-PersonalWechatTopLevelWindows {
  $items = New-Object System.Collections.Generic.List[object]
  $processNames = @("Weixin", "WeChat")
  $callback = [Win32WechatSimpleWindow+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if (-not [Win32WechatSimpleWindow]::IsWindowVisible($hWnd)) { return $true }
    [uint32]$windowProcessId = 0
    [void][Win32WechatSimpleWindow]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
    $proc = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
    if (-not $proc -or $processNames -notcontains $proc.ProcessName) { return $true }
    if (-not [Win32WechatSimpleWindow]::IsWindow($hWnd)) { return $true }
    $evidence = Get-PersonalWechatWindowEvidence $hWnd
    if (-not $evidence) { return $true }
    $width = $evidence.width
    $height = $evidence.height
    $minimized = $evidence.minimized
    $hasMainLayout = $evidence.effectiveWidth -ge 600 -and $evidence.effectiveHeight -ge 500
    # Patch releases and GPU/window-manager combinations can expose different
    # classes and style bits for the same personal WeChat main window. Process
    # ownership + visibility + usable chat geometry discover the window;
    # class/style remain diagnostic evidence only.
    $isMain = $hasMainLayout
    $isLogin = -not $minimized -and -not $isMain -and $width -ge 240 -and $width -le 600 -and $height -ge 280 -and $height -le 760
    if ($isMain -or $isLogin) {
      [void]$items.Add(@{
        hWnd = $hWnd
        pid = [int]$windowProcessId
        processName = $proc.ProcessName
        minimized = [bool]$minimized
        isMain = [bool]$isMain
        isLogin = [bool]$isLogin
        width = $width
        height = $height
        normalWidth = $evidence.normalWidth
        normalHeight = $evidence.normalHeight
        windowClass = $evidence.windowClass
        area = [int64]$evidence.effectiveWidth * [int64]$evidence.effectiveHeight
      })
    }
    return $true
  }
  [void][Win32WechatSimpleWindow]::EnumWindows($callback, [IntPtr]::Zero)
  return $items
}
function Find-PersonalWechatMainWindow {
  return Get-PersonalWechatTopLevelWindows |
    Where-Object { $_.isMain } |
    Sort-Object area -Descending |
    Select-Object -First 1
}
function Test-PersonalWechatLoginWindow {
  return [bool](Get-PersonalWechatTopLevelWindows | Where-Object { $_.isLogin } | Select-Object -First 1)
}
$main = Find-PersonalWechatMainWindow
if (-not $main -and (Test-PersonalWechatLoginWindow)) {
  @{ ok = $false; reason = "wechat_login_required" } | ConvertTo-Json -Compress
  exit
}
if (-not $main) {
  $paths = New-Object System.Collections.Generic.List[string]
  foreach ($name in @("Weixin", "WeChat")) {
    foreach ($proc in Get-Process -Name $name -ErrorAction SilentlyContinue) {
      if ($proc.Path -and -not $paths.Contains($proc.Path)) { [void]$paths.Add($proc.Path) }
    }
  }
  $pf86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  foreach ($path in @(
    "$env:XIAOXI_WECHAT_EXE",
    "$env:LOCALAPPDATA\\Tencent\\WeChat\\WeChat.exe",
    "$env:ProgramFiles\\Tencent\\WeChat\\WeChat.exe",
    "$pf86\\Tencent\\WeChat\\WeChat.exe"
  )) {
    if ($path -and (Test-Path $path) -and -not $paths.Contains($path)) { [void]$paths.Add($path) }
  }
  foreach ($path in $paths) {
    try { Start-Process -FilePath $path | Out-Null; break } catch {}
  }
  for ($i = 0; $i -lt 12 -and -not $main; $i++) { Start-Sleep -Milliseconds 500; $main = Find-PersonalWechatMainWindow }
}
if (-not $main) {
  $running = Get-Process -Name Weixin,WeChat -ErrorAction SilentlyContinue
  @{ ok = $false; reason = $(if (Test-PersonalWechatLoginWindow) { "wechat_login_required" } else { "wechat_window_not_found" }) } | ConvertTo-Json -Compress
  exit
}
$hWnd = [IntPtr]$main.hWnd
if ($main.minimized) {
  [void][Win32WechatSimpleWindow]::ShowWindowAsync($hWnd, 9)
  Start-Sleep -Milliseconds 250
}
if ([Win32WechatSimpleWindow]::GetForegroundWindow() -ne $hWnd) {
  $focused = [Win32WechatSimpleWindow]::SetForegroundWindow($hWnd)
  if (-not $focused) { try { $focused = (New-Object -ComObject WScript.Shell).AppActivate([int]$main.pid) } catch {} }
  Start-Sleep -Milliseconds 120
}
$rect = New-Object Win32WechatSimpleWindow+RECT
$rectAvailable = [Win32WechatSimpleWindow]::GetWindowRect($hWnd, [ref]$rect)
$visible = $rectAvailable -and [Win32WechatSimpleWindow]::IsWindowVisible($hWnd) -and -not [Win32WechatSimpleWindow]::IsIconic($hWnd) -and ($rect.Right - $rect.Left) -ge 600 -and ($rect.Bottom - $rect.Top) -ge 500
$focused = [Win32WechatSimpleWindow]::GetForegroundWindow() -eq $hWnd
$ok = $visible -and $focused
@{ ok = $ok; reason = $(if (-not $visible) { "wechat_window_not_ready" } elseif (-not $focused) { "wechat_focus_failed" } else { "" }); pid = $main.pid; hWnd = $hWnd.ToInt64(); processName = $main.processName; width = $(if ($rectAvailable) { $rect.Right - $rect.Left } else { 0 }); height = $(if ($rectAvailable) { $rect.Bottom - $rect.Top } else { 0 }) } | ConvertTo-Json -Compress
`;

function ensureWechatWindowVisible() {
  const encoded = Buffer.from(`${DPI_AWARE_POWERSHELL}\n${SIMPLE_ENSURE_WECHAT_WINDOW_SCRIPT}`, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    encoding: "utf8",
    env: { ...process.env, XIAOXI_PARENT_PID: String(process.pid), XIAOXI_WECHAT_EXE: wechatExecutableForLaunch() },
    timeout: 10000,
    windowsHide: true
  });
  try {
    return JSON.parse(result.stdout.trim() || "{\"ok\":false}");
  } catch {
    return { ok: false };
  }
}

function runPowerShell(script, env = {}, options = {}) {
  const startedAt = Date.now();
  const ensureResult = options.ensure === false ? {} : ensureWechatWindowVisible();
  const scriptInput = Buffer.from(`${DPI_AWARE_POWERSHELL}\n${script}`, "utf16le").toString("base64");
  const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : 15000;
  const shellArgs = ["-NoProfile"];
  if (options.sta === true) shellArgs.push("-STA");
  shellArgs.push("-ExecutionPolicy", "Bypass", "-EncodedCommand", POWERSHELL_STDIN_BOOTSTRAP);
  const spawnOptions = {
    encoding: "utf8",
    env: {
      ...process.env,
      XIAOXI_WECHAT_EXE: process.env.XIAOXI_WECHAT_EXE || cachedWechatExecutable,
      ...env,
      XIAOXI_PARENT_PID: String(process.pid),
      ...(options.windowDiagnostics === true ? { XIAOXI_WINDOW_STARTED_AT: String(startedAt) } : {})
    },
    input: scriptInput,
    windowsHide: true
  };
  spawnOptions.timeout = timeout;
  const result = spawnSync("powershell.exe", shellArgs, spawnOptions);
  const withWindowDiagnostics = (value) => {
    const diagnostics = options.windowDiagnostics === true
      ? readWechatWindowDiagnostics(result.stderr, Date.now() - startedAt, timeout)
      : options.diagnostics === true ? readMomentsDiagnostics(result.stderr, Date.now() - startedAt, timeout) : {};
    return Object.keys(diagnostics).length ? { ...value, diagnostics: { ...value.diagnostics, ...diagnostics } } : value;
  };

  if (result.error) {
    return withWindowDiagnostics({ ok: false, reason: result.error.code === "ETIMEDOUT" ? "powershell_timeout" : "powershell_failed" });
  }
  if (result.status !== 0) {
    const diagnostics = options.diagnostics === true && options.windowDiagnostics !== true
      ? { stderr: String(result.stderr ?? "").trim().slice(-1200) }
      : undefined;
    return withWindowDiagnostics({ ok: false, reason: "powershell_failed", ...(diagnostics ? { diagnostics } : {}) });
  }

  try {
    const stdout = result.stdout.trim();
    if (!stdout) return withWindowDiagnostics({ ok: false, reason: ensureResult?.reason || "powershell_output_invalid" });
    const parsed = JSON.parse(stdout);
    if (!parsed.ok && !parsed.reason) return withWindowDiagnostics({ ...parsed, reason: ensureResult?.reason || "powershell_output_invalid" });
    return withWindowDiagnostics(parsed);
  } catch {
    return withWindowDiagnostics({ ok: false, reason: ensureResult?.reason || "powershell_output_invalid" });
  }
}

const WECHAT_RPA_WINDOW_LAYOUTS = Object.freeze({
  main: Object.freeze({ width: 1120, height: 760, layoutMode: "stable_target" }),
  momentsStandalone: Object.freeze({ layoutMode: "preserve_native_moments_popup" })
});
const WECHAT_STABLE_WINDOW_LAYOUT = WECHAT_RPA_WINDOW_LAYOUTS.main;
const WECHAT_MOMENTS_STANDALONE_WINDOW_LAYOUT = WECHAT_RPA_WINDOW_LAYOUTS.momentsStandalone;
const WECHAT_RPA_WINDOW_LAYOUT_MODE = WECHAT_STABLE_WINDOW_LAYOUT.layoutMode;
const WECHAT_MOMENTS_STANDALONE_WINDOW_LAYOUT_MODE = WECHAT_MOMENTS_STANDALONE_WINDOW_LAYOUT.layoutMode;
const WECHAT_RPA_BACKGROUND_MIN_IDLE_MS = 15_000;
const WECHAT_WINDOW_PREPARE_TIMEOUT_MS = 20_000;

function resolveWechatRpaWindowTarget({ surfaceMode, dpi, workArea } = {}) {
  const layout = surfaceMode === "integrated"
    ? WECHAT_STABLE_WINDOW_LAYOUT
    : null;
  const normalizedDpi = Number(dpi);
  const left = Number(workArea?.left);
  const top = Number(workArea?.top);
  const workWidth = Number(workArea?.width);
  const workHeight = Number(workArea?.height);
  if (!layout || !Number.isInteger(normalizedDpi) || normalizedDpi < 72 || normalizedDpi > 480
    || ![left, top, workWidth, workHeight].every(Number.isInteger)
    || workWidth < 300 || workHeight < 300) {
    return null;
  }
  const scale = normalizedDpi / 96;
  return {
    x: left,
    y: top,
    width: Math.min(workWidth, Math.round(layout.width * scale)),
    height: Math.min(workHeight, Math.round(layout.height * scale)),
    dpi: normalizedDpi,
    layoutMode: layout.layoutMode
  };
}

// Main-window evidence is independent of a particular Qt render-child version.
// An exact HWND supplied by an earlier verified step is handled separately.
const WECHAT_MAIN_WINDOW_RULES_SCRIPT = `
function Test-WechatMainCandidate([object]$candidate) {
  if ([int64]$candidate.owner -ne 0 -or $candidate.toolWindow -or [int]$candidate.layoutRank -le 0) { return $false }
  return [bool]$candidate.hasMainRenderChild -or
    [string]$candidate.windowClass -ieq "mmui::MainWindow" -or
    [bool]$candidate.shellNavigation -or [bool]$candidate.visualNavigation
}
`;

const NORMALIZE_WECHAT_WINDOW_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
$windowClock = [Diagnostics.Stopwatch]::StartNew()
$windowStageAt = 0L
$windowDiagnostic = @{ window_stage = "bootstrap"; window_native_count = 0; window_hidden_count = 0; window_minimized_count = 0; window_rejected_layout_count = 0; window_recovery_candidate_count = 0; window_recovery_main_count = 0; window_recovery_attempted = $false; window_recovery_succeeded = $false; window_discovery_attempts = 0; window_discovery_retries = 0; window_discovery_wait_ms = 0; window_discovery_launch_attempted = $false; window_discovery_launch_succeeded = $false }
$hostStartedAt = 0L
if ([int64]::TryParse($env:XIAOXI_WINDOW_STARTED_AT, [ref]$hostStartedAt) -and $hostStartedAt -gt 0) {
  $windowDiagnostic.window_bootstrap_ms = [Math]::Max(0, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $hostStartedAt)
}
function Set-WechatWindowStage([string]$stage) {
  $elapsed = $windowClock.ElapsedMilliseconds
  $durationKey = "window_" + $windowDiagnostic.window_stage + "_ms"
  $windowDiagnostic[$durationKey] = [int64]$windowDiagnostic[$durationKey] + $elapsed - $script:windowStageAt
  $script:windowStageAt = $elapsed
  $windowDiagnostic.window_stage = $stage
  $windowDiagnostic.window_elapsed_ms = $elapsed
  [Console]::Error.WriteLine("wechat_window_diagnostic:" + ($windowDiagnostic | ConvertTo-Json -Compress))
}
Set-WechatWindowStage "compile"
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32WechatWindow {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {
    public int length; public int flags; public int showCmd;
    public POINT ptMinPosition; public POINT ptMaxPosition; public RECT rcNormalPosition;
  }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint sourceThreadId, uint targetThreadId, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public static uint GetLastInputTick() {
    LASTINPUTINFO info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    return GetLastInputInfo(ref info) ? info.dwTime : UInt32.MaxValue;
  }
  public static uint GetLastInputIdleMilliseconds() {
    uint tick = GetLastInputTick();
    return tick == UInt32.MaxValue ? UInt32.MaxValue : unchecked((uint)Environment.TickCount - tick);
  }
  public static bool HasDescendantClass(IntPtr parent, string expectedClass) {
    bool found = false;
    EnumWindowsProc callback = delegate(IntPtr child, IntPtr extraData) {
      StringBuilder classText = new StringBuilder(256);
      GetClassName(child, classText, classText.Capacity);
      string actualClass = classText.ToString().Trim();
      if (String.Equals(actualClass, expectedClass, StringComparison.Ordinal)) {
        found = true;
        return false;
      }
      // Some patches change the MMUIRender suffix. Accept that family only
      // when the child covers the host's render surface, not a small popup.
      RECT hostRect, childRect;
      if (actualClass.StartsWith("MMUIRender", StringComparison.Ordinal) &&
          GetWindowRect(parent, out hostRect) && GetWindowRect(child, out childRect) &&
          childRect.Left >= hostRect.Left - 8 && childRect.Top >= hostRect.Top - 8 &&
          childRect.Right <= hostRect.Right + 8 && childRect.Bottom <= hostRect.Bottom + 8 &&
          childRect.Right - childRect.Left >= (hostRect.Right - hostRect.Left) * 0.8 &&
          childRect.Bottom - childRect.Top >= (hostRect.Bottom - hostRect.Top) * 0.6) {
        found = true;
        return false;
      }
      return true;
    };
    EnumChildWindows(parent, callback, IntPtr.Zero);
    return found;
  }
  public static IntPtr[] WindowsForProcesses(int[] processIds) {
    var ids = new System.Collections.Generic.HashSet<int>(processIds);
    var windows = new System.Collections.Generic.List<IntPtr>();
    EnumWindowsProc callback = delegate(IntPtr window, IntPtr extraData) {
      uint processId;
      GetWindowThreadProcessId(window, out processId);
      if (ids.Contains((int)processId)) windows.Add(window);
      return true;
    };
    EnumWindows(callback, IntPtr.Zero);
    return windows.ToArray();
  }
}
"@
${WECHAT_MAIN_WINDOW_RULES_SCRIPT}
try { [void][Win32WechatWindow]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch {}
$expectedPid = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID")
$expectedHWnd = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_HWND")
$minimumIdleMsText = [Environment]::GetEnvironmentVariable("XIAOXI_WECHAT_MIN_IDLE_MS")
$inspectOnly = [Environment]::GetEnvironmentVariable("XIAOXI_WECHAT_INSPECT_ONLY") -ceq "1"
$allowDiscoveryLaunch = -not $inspectOnly -and [string]::IsNullOrWhiteSpace($expectedPid) -and [string]::IsNullOrWhiteSpace($expectedHWnd)
$minimumIdleMs = 0
if (-not [int]::TryParse($minimumIdleMsText, [ref]$minimumIdleMs) -or $minimumIdleMs -lt 0) { $minimumIdleMs = 0 }
function Test-XiaoxiUserIdle {
  if ($minimumIdleMs -le 0) { return $true }
  $idleMs = Get-XiaoxiUserIdleMilliseconds
  return $null -ne $idleMs -and [uint64]$idleMs -ge [uint64]$minimumIdleMs
}
function Get-XiaoxiUserIdleMilliseconds {
  $idleMs = [Win32WechatWindow]::GetLastInputIdleMilliseconds()
  if ($idleMs -eq [uint32]::MaxValue) { return $null }
  return [int64]$idleMs
}
function Stop-ForActiveUser([int]$processId, [IntPtr]$hWnd) {
  $result = @{ ok = $false; reason = "wechat_user_active"; pid = $processId; hWnd = $hWnd.ToInt64(); requiredIdleMs = $minimumIdleMs }
  $idleMs = Get-XiaoxiUserIdleMilliseconds
  if ($null -ne $idleMs) { $result.observedIdleMs = $idleMs }
  $result | ConvertTo-Json -Compress
}
function Test-StableWechatTarget([object]$rect, [object]$workArea, [int]$width, [int]$height) {
  if ($rect -eq $null -or $workArea -eq $null) { return $false }
  return [Math]::Abs([int]$rect.Left - [int]$workArea.Left) -le 3 -and
    [Math]::Abs([int]$rect.Top - [int]$workArea.Top) -le 3 -and
    [Math]::Abs([int]($rect.Right - $rect.Left) - $width) -le 3 -and
    [Math]::Abs([int]($rect.Bottom - $rect.Top) - $height) -le 3
}
function Request-PersonalWechatActivation([object]$window) {
  $path = [string]$window.processPath
  if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
  try {
    # This is the activation contract used by WeChat's installed Start-menu
    # shortcut. It lets the running Qt process restore its own tray state.
    Start-Process -FilePath $path -ArgumentList "--scene=startmenu" -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}
function Request-ExactWechatForeground([IntPtr]$hWnd, [object]$window, [bool]$nativeActivationAlreadyRequested) {
  if ([Win32WechatWindow]::GetForegroundWindow() -eq $hWnd) { return $true }
  if (-not $nativeActivationAlreadyRequested -and (Request-PersonalWechatActivation $window)) {
    for ($activationAttempt = 0; $activationAttempt -lt 5; $activationAttempt++) {
      Start-Sleep -Milliseconds 100
      if ([Win32WechatWindow]::GetForegroundWindow() -eq $hWnd) { return $true }
    }
  }
  $foreground = [Win32WechatWindow]::GetForegroundWindow()
  [uint32]$targetPid = 0
  [uint32]$foregroundPid = 0
  $targetThread = [Win32WechatWindow]::GetWindowThreadProcessId($hWnd, [ref]$targetPid)
  $foregroundThread = if ($foreground -eq [IntPtr]::Zero) { [uint32]0 } else { [Win32WechatWindow]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid) }
  $currentThread = [Win32WechatWindow]::GetCurrentThreadId()
  $attachedForeground = $false
  $attachedTarget = $false
  try {
    if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
      $attachedForeground = [Win32WechatWindow]::AttachThreadInput($currentThread, $foregroundThread, $true)
    }
    if ($targetThread -ne 0 -and $targetThread -ne $currentThread) {
      $attachedTarget = [Win32WechatWindow]::AttachThreadInput($currentThread, $targetThread, $true)
    }
    [void][Win32WechatWindow]::BringWindowToTop($hWnd)
    [void][Win32WechatWindow]::SetForegroundWindow($hWnd)
  } finally {
    if ($attachedTarget) { [void][Win32WechatWindow]::AttachThreadInput($currentThread, $targetThread, $false) }
    if ($attachedForeground) { [void][Win32WechatWindow]::AttachThreadInput($currentThread, $foregroundThread, $false) }
  }
  Start-Sleep -Milliseconds 120
  return [Win32WechatWindow]::GetForegroundWindow() -eq $hWnd
}
Set-WechatWindowStage "process"
$processNames = @("Weixin", "WeChat")
function Update-WechatProcessSnapshot {
  $script:wechatProcesses = @{}
  foreach ($wechatProcess in @(Get-Process -Name $processNames -ErrorAction SilentlyContinue)) {
    $script:wechatProcesses[[int]$wechatProcess.Id] = $wechatProcess
  }
  $windowDiagnostic.window_process_count = $script:wechatProcesses.Count
}
function Start-WechatForDiscovery {
  if (-not $allowDiscoveryLaunch) { return $false }
  $launchPath = [Environment]::GetEnvironmentVariable("XIAOXI_WECHAT_EXE")
  if ([string]::IsNullOrWhiteSpace($launchPath) -or -not (Test-Path -LiteralPath $launchPath -PathType Leaf)) { return $false }
  $windowDiagnostic.window_discovery_launch_attempted = $true
  try {
    Start-Process -FilePath $launchPath -ErrorAction Stop | Out-Null
    $windowDiagnostic.window_discovery_launch_succeeded = $true
    return $true
  } catch {
    return $false
  }
}
Update-WechatProcessSnapshot
$windowDiagnostic.window_discovery_attempts = 1
Set-WechatWindowStage "enumerate"
$matches = New-Object System.Collections.Generic.List[object]
function Test-WechatMainRenderChild([IntPtr]$hWnd) {
  return [Win32WechatWindow]::HasDescendantClass($hWnd, "MMUIRenderSubWindowHW")
}
function Test-WechatShellNavigation([object]$window) {
  # A Qt root without MMUI children needs positive application-shell evidence.
  # Never treat an arbitrary large Qt popup as the main chat window.
  if (-not $window.visible -or $window.minimized -or $window.toolWindow -or $window.owner -ne 0 -or
      $window.windowClass -notmatch "(?i)^Qt.*QWindowIcon$" -or $window.layoutRank -le 0) { return $false }
  try {
    if (-not $script:windowUiaLoaded) { Add-Type -AssemblyName UIAutomationClient; $script:windowUiaLoaded = $true }
    $windowRoot = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$window.hWnd)
    $rootRect = $windowRoot.Current.BoundingRectangle
    $navNames = @("聊天", "通讯录", "Chats", "Contacts")
    $conditions = @($navNames | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $_) })
    $condition = New-Object System.Windows.Automation.OrCondition([System.Windows.Automation.Condition[]]$conditions)
    $elements = $windowRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $chats = $false; $contacts = $false
    for ($navIndex = 0; $navIndex -lt $elements.Count; $navIndex++) {
      $nav = $elements.Item($navIndex)
      $navRect = $nav.Current.BoundingRectangle
      $navigationControl = @("ControlType.Button", "ControlType.TabItem", "ControlType.RadioButton") -contains [string]$nav.Current.ControlType.ProgrammaticName
      if (-not $navigationControl -or $nav.Current.IsOffscreen -or [int]$nav.Current.ProcessId -ne [int]$window.pid -or
          $navRect.Width -le 0 -or $navRect.Height -le 0 -or
          $navRect.Left -lt $rootRect.Left -or $navRect.Right -gt ($rootRect.Left + $rootRect.Width * 0.2) -or
          $navRect.Top -lt $rootRect.Top -or $navRect.Bottom -gt ($rootRect.Top + $rootRect.Height * 0.8)) { continue }
      if (@("聊天", "Chats") -ccontains [string]$nav.Current.Name) { $chats = $true }
      if (@("通讯录", "Contacts") -ccontains [string]$nav.Current.Name) { $contacts = $true }
    }
    return $chats -and $contacts
  } catch { return $false }
}
${WECHAT_MAIN_WINDOW_VISUAL_SCRIPT}
function Get-WechatWindowCandidate([IntPtr]$hWnd, [bool]$exactExpectedHandle) {
  if (-not [Win32WechatWindow]::IsWindow($hWnd)) { return $null }
  [uint32]$windowProcessId = 0
  [void][Win32WechatWindow]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
  $proc = $wechatProcesses[[int]$windowProcessId]
  if (-not $proc -or $processNames -notcontains $proc.ProcessName) { return $null }
  if (-not [string]::IsNullOrWhiteSpace($expectedPid) -and [string]$windowProcessId -ne $expectedPid) { return $null }
  $visible = [Win32WechatWindow]::IsWindowVisible($hWnd)

  $rect = New-Object Win32WechatWindow+RECT
  if (-not [Win32WechatWindow]::GetWindowRect($hWnd, [ref]$rect)) { return $null }
  $currentWidth = $rect.Right - $rect.Left
  $currentHeight = $rect.Bottom - $rect.Top
  $minimized = [Win32WechatWindow]::IsIconic($hWnd)
  $normalWidth = 0
  $normalHeight = 0
  if ($minimized) {
    $placement = New-Object Win32WechatWindow+WINDOWPLACEMENT
    $placement.length = [Runtime.InteropServices.Marshal]::SizeOf([type][Win32WechatWindow+WINDOWPLACEMENT])
    if ([Win32WechatWindow]::GetWindowPlacement($hWnd, [ref]$placement)) {
      $normalWidth = $placement.rcNormalPosition.Right - $placement.rcNormalPosition.Left
      $normalHeight = $placement.rcNormalPosition.Bottom - $placement.rcNormalPosition.Top
    }
  }
  $w = if ($minimized -and $normalWidth -gt 0) { $normalWidth } else { $currentWidth }
  $h = if ($minimized -and $normalHeight -gt 0) { $normalHeight } else { $currentHeight }

  $text = New-Object System.Text.StringBuilder 512
  [void][Win32WechatWindow]::GetWindowText($hWnd, $text, $text.Capacity)
  $title = $text.ToString().Trim()
  $classText = New-Object System.Text.StringBuilder 256
  [void][Win32WechatWindow]::GetClassName($hWnd, $classText, $classText.Capacity)
  $className = $classText.ToString().Trim()
  if (-not $exactExpectedHandle) {
    if (-not $windowDiagnostic.window_class_code) { $windowDiagnostic.window_class_code = $className }
    if (-not $visible) { $windowDiagnostic.window_hidden_count++ }
    if ($minimized) { $windowDiagnostic.window_minimized_count++ }
  }
  $hasMainRenderChild = Test-WechatMainRenderChild $hWnd
  $style = [uint32]([int64][Win32WechatWindow]::GetWindowLong($hWnd, -16) -band 4294967295L)
  $exStyle = [uint32]([int64][Win32WechatWindow]::GetWindowLong($hWnd, -20) -band 4294967295L)
  $owner = [Win32WechatWindow]::GetWindow($hWnd, 4)
  $classRank = if ($className -ieq "mmui::MainWindow") { 3 } elseif ($className -match "(?i)MainWindow") { 2 } else { 0 }
  $aspectRatio = [double]$w / [Math]::Max(1, $h)
  $layoutRank = if ($w -ge 720 -and $h -ge 500 -and $aspectRatio -ge 1.15) { 2 } elseif ($w -ge 600 -and $h -ge 500) { 1 } else { 0 }
  if (-not $exactExpectedHandle -and $layoutRank -eq 0) { $windowDiagnostic.window_rejected_layout_count++ }
  $styleRank = 0
  if (($style -band [uint32]0x00040000) -ne 0) { $styleRank += 2 }
  if (($style -band [uint32]0x00080000) -ne 0) { $styleRank += 1 }
  if (($exStyle -band [uint32]0x00000080) -eq 0) { $styleRank += 1 }
  $hiddenMainRecoveryEligible = -not $visible -and $layoutRank -gt 0 -and
    ($hasMainRenderChild -or $className -ieq "mmui::MainWindow") -and
    -not [string]::IsNullOrWhiteSpace($title) -and
    ($className -match "(?i)QWindowIcon$" -or $className -ieq "mmui::MainWindow") -and
    $owner -eq [IntPtr]::Zero -and
    ($style -band [uint32]0x00040000) -ne 0 -and
    ($exStyle -band [uint32]0x00000080) -eq 0
  # WeChat 4.x window classes and Win32 styles vary across machines and patch
  # releases. Visible windows use ownership plus main geometry. A tray-hidden
  # window is recoverable only with the stronger Qt class, owner and style
  # evidence observed on the real personal WeChat main HWND.
  if (-not $exactExpectedHandle -and -not $visible -and -not $hiddenMainRecoveryEligible) { return $null }
  if (-not $exactExpectedHandle -and $layoutRank -eq 0) { return $null }

  $processPath = ""
  try { $processPath = [string]$proc.Path } catch {}
  return @{
    hWnd = $hWnd
    title = $title
    windowClass = $className
    hasMainRenderChild = [bool]$hasMainRenderChild
    shellNavigation = $false
    visualNavigation = $false
    toolWindow = ($exStyle -band [uint32]0x00000080) -ne 0
    owner = $owner.ToInt64()
    processName = $proc.ProcessName
    processPath = $processPath
    pid = $windowProcessId
    width = $w
    height = $h
    currentWidth = $currentWidth
    currentHeight = $currentHeight
    normalWidth = $normalWidth
    normalHeight = $normalHeight
    minimized = [bool]$minimized
    visible = [bool]$visible
    hiddenMainRecoveryEligible = [bool]$hiddenMainRecoveryEligible
    exactExpectedHandle = [bool]$exactExpectedHandle
    classRank = $classRank
    layoutRank = $layoutRank
    styleRank = $styleRank
    area = [int64]$w * [int64]$h
  }
}

function Get-WechatWindowCandidates {
  $windowDiagnostic.window_native_count = 0
  $windowDiagnostic.window_hidden_count = 0
  $windowDiagnostic.window_minimized_count = 0
  $windowDiagnostic.window_rejected_layout_count = 0
  $windowDiagnostic.Remove("window_class_code")
  $candidates = New-Object System.Collections.Generic.List[object]
  if ($wechatProcesses.Count -le 0) { return @() }
  $processWindows = [Win32WechatWindow]::WindowsForProcesses([int[]]@($wechatProcesses.Keys))
  $windowDiagnostic.window_native_count = @($processWindows).Count
  foreach ($candidateHWnd in $processWindows) {
    $candidate = Get-WechatWindowCandidate $candidateHWnd $false
    if ($candidate) { [void]$candidates.Add($candidate) }
  }
  return @($candidates.ToArray())
}

function Update-WechatWindowCandidateDiagnostics([object[]]$candidates) {
  $windowDiagnostic.window_candidate_count = @($candidates).Count
  $windowDiagnostic.window_render_count = @($candidates | Where-Object { $_.hasMainRenderChild }).Count
  if (@($candidates).Count -gt 0) { $windowDiagnostic.window_class_code = [string]$candidates[0].windowClass }
}

function Select-WechatMainCandidates([object[]]$candidates) {
  foreach ($candidate in @($candidates)) {
    if (Test-WechatMainCandidate $candidate) { continue }
    Set-WechatWindowStage "shell"
    $candidate.shellNavigation = Test-WechatShellNavigation $candidate
    if (-not (Test-WechatMainCandidate $candidate)) {
      Set-WechatWindowStage "visual"
      $candidate.visualNavigation = Test-WechatVisualNavigation $candidate
    }
  }
  Set-WechatWindowStage "select"
  return @($candidates | Where-Object { Test-WechatMainCandidate $_ })
}

function Get-WechatWindowRecoveryCandidate([object[]]$candidates) {
  # A minimized or standalone surface is not a proven main-window target. It may only
  # supply a single verified executable path for WeChat's own restore action.
  $recoverable = @($candidates | Where-Object {
    $_.visible -and -not $_.toolWindow -and [int64]$_.owner -eq 0 -and
      [int]$_.layoutRank -gt 0 -and -not $_.hasMainRenderChild -and -not $_.shellNavigation -and
      [string]$_.windowClass -match "(?i)^Qt(?:\\d+)?QWindowIcon$" -and
      -not [string]::IsNullOrWhiteSpace([string]$_.processPath)
  })
  $windowDiagnostic.window_recovery_candidate_count = $recoverable.Count
  if (@($candidates).Count -ne 1 -or $recoverable.Count -ne 1) { return $null }
  return $recoverable[0]
}

function Test-MatchedWechatWindowIdentity([IntPtr]$hWnd, [object]$expected) {
  $current = Get-WechatWindowCandidate $hWnd $true
  if (-not $current) { return $false }
  return [int]$current.pid -eq [int]$expected.pid -and
    [string]$current.processName -ieq [string]$expected.processName -and
    [string]$current.title -ceq [string]$expected.title -and
    [string]$current.windowClass -ceq [string]$expected.windowClass -and
    [int64]$current.owner -eq [int64]$expected.owner -and
    [bool]$current.hasMainRenderChild -eq [bool]$expected.hasMainRenderChild -and
    [int]$current.layoutRank -gt 0
}

$expectedHandleWasProvided = -not [string]::IsNullOrWhiteSpace($expectedHWnd)
$expectedHandleValue = [int64]0
$expectedHandleIsValid = $expectedHandleWasProvided -and [int64]::TryParse($expectedHWnd, [ref]$expectedHandleValue) -and $expectedHandleValue -ne 0 -and [Win32WechatWindow]::IsWindow([IntPtr]$expectedHandleValue)
if ($expectedHandleWasProvided -and -not $expectedHandleIsValid) {
  @{ ok = $false; reason = "wechat_window_identity_mismatch" } | ConvertTo-Json -Compress
  exit
}
if ($expectedHandleIsValid) {
  $expectedCandidate = Get-WechatWindowCandidate ([IntPtr]$expectedHandleValue) $true
  if (-not $expectedCandidate) {
    @{ ok = $false; reason = "wechat_window_identity_mismatch" } | ConvertTo-Json -Compress
    exit
  }
  [void]$matches.Add($expectedCandidate)
}
$nativeActivationRequested = $false
if (-not $expectedHandleIsValid) {
  $matches = New-Object System.Collections.Generic.List[object]
  foreach ($candidate in @(Get-WechatWindowCandidates)) { [void]$matches.Add($candidate) }
}
$candidateMatches = @($matches.ToArray())
Update-WechatWindowCandidateDiagnostics $candidateMatches
Set-WechatWindowStage "select"
if (-not $expectedHandleIsValid) {
  $matches = @(Select-WechatMainCandidates $candidateMatches)
  if ($matches.Count -eq 0 -and $windowDiagnostic.window_process_count -eq 0 -and -not $inspectOnly) {
    [void](Start-WechatForDiscovery)
    for ($discoveryRetry = 1; $discoveryRetry -le 20 -and $matches.Count -eq 0; $discoveryRetry++) {
      Start-Sleep -Milliseconds 500
      $windowDiagnostic.window_discovery_attempts = 1 + $discoveryRetry
      $windowDiagnostic.window_discovery_retries = $discoveryRetry
      $windowDiagnostic.window_discovery_wait_ms = 500 * $discoveryRetry
      Update-WechatProcessSnapshot
      if ($windowDiagnostic.window_process_count -eq 0) { continue }
      $candidateMatches = @(Get-WechatWindowCandidates)
      Update-WechatWindowCandidateDiagnostics $candidateMatches
      $matches = @(Select-WechatMainCandidates $candidateMatches)
    }
  }
  if (-not $inspectOnly -and $matches.Count -eq 0) {
    $recoveryCandidate = Get-WechatWindowRecoveryCandidate $candidateMatches
    if ($null -ne $recoveryCandidate) {
      Set-WechatWindowStage "recover"
      if (-not (Test-XiaoxiUserIdle)) { Stop-ForActiveUser $recoveryCandidate.pid ([IntPtr]$recoveryCandidate.hWnd); exit }
      $windowDiagnostic.window_recovery_attempted = $true
      if (Request-PersonalWechatActivation $recoveryCandidate) {
        $nativeActivationRequested = $true
        for ($recoveryAttempt = 0; $recoveryAttempt -lt 15; $recoveryAttempt++) {
          Start-Sleep -Milliseconds 200
          $recoveredCandidates = @(Get-WechatWindowCandidates)
          Update-WechatWindowCandidateDiagnostics $recoveredCandidates
          $recoveredSamePidCandidates = @($recoveredCandidates | Where-Object { [int]$_.pid -eq [int]$recoveryCandidate.pid })
          $recoveredMatches = @(Select-WechatMainCandidates $recoveredSamePidCandidates)
          $windowDiagnostic.window_recovery_main_count = $recoveredMatches.Count
          if ($recoveredMatches.Count -eq 1) {
            $matches = $recoveredMatches
            $windowDiagnostic.window_recovery_succeeded = $true
            break
          }
        }
      }
      Set-WechatWindowStage "select"
    }
  }
}
$windowDiagnostic.window_main_count = $matches.Count
Set-WechatWindowStage "selected"
if ($matches.Count -eq 0) {
  @{ ok = $false; reason = "personal_wechat_main_window_not_found" } | ConvertTo-Json -Compress
  exit
}
if ($matches.Count -gt 1) {
  @{ ok = $false; reason = "wechat_window_ambiguous" } | ConvertTo-Json -Compress
  exit
}
$matched = $matches[0]
$windowDiagnostic.window_class_code = $matched.windowClass
$windowDiagnostic.window_detection_mode = $(if ($expectedHandleIsValid) { "exact_hwnd" } elseif ($matched.hasMainRenderChild) { "render_child" } elseif ($matched.shellNavigation) { "shell_navigation" } elseif ($matched.visualNavigation) { "visual_navigation" } else { "native_main" })
Set-WechatWindowStage "restore"
$hWnd = [IntPtr]$matched.hWnd
if ($inspectOnly) {
  if (-not (Test-XiaoxiUserIdle)) { Stop-ForActiveUser $matched.pid $hWnd; exit }
  $inspectionRect = New-Object Win32WechatWindow+RECT
  $inspectionRectAvailable = [Win32WechatWindow]::GetWindowRect($hWnd, [ref]$inspectionRect)
  $inspectionFocused = [Win32WechatWindow]::GetForegroundWindow() -eq $hWnd
  $inspectionUsable = $inspectionRectAvailable -and [Win32WechatWindow]::IsWindowVisible($hWnd) -and
    -not [Win32WechatWindow]::IsIconic($hWnd) -and
    ($inspectionRect.Right - $inspectionRect.Left) -ge 600 -and ($inspectionRect.Bottom - $inspectionRect.Top) -ge 500
  if (-not $inspectionUsable) {
    @{ ok = $false; reason = "wechat_window_not_ready"; pid = $matched.pid; hWnd = $hWnd.ToInt64() } | ConvertTo-Json -Compress
    exit
  }
  if (-not $inspectionFocused) {
    @{ ok = $false; reason = "wechat_window_not_foreground"; pid = $matched.pid; hWnd = $hWnd.ToInt64() } | ConvertTo-Json -Compress
    exit
  }
  $inspectionWorkArea = [System.Windows.Forms.Screen]::FromHandle($hWnd).WorkingArea
  [uint32]$inspectionDpi = 96
  try {
    $observedInspectionDpi = [Win32WechatWindow]::GetDpiForWindow($hWnd)
    if ($observedInspectionDpi -ge 72 -and $observedInspectionDpi -le 480) { $inspectionDpi = $observedInspectionDpi }
  } catch {}
  $inspectionDpiScale = [double]$inspectionDpi / 96.0
  $inspectionTargetWidth = [Math]::Min([int]$inspectionWorkArea.Width, [int][Math]::Round(${WECHAT_STABLE_WINDOW_LAYOUT.width} * $inspectionDpiScale))
  $inspectionTargetHeight = [Math]::Min([int]$inspectionWorkArea.Height, [int][Math]::Round(${WECHAT_STABLE_WINDOW_LAYOUT.height} * $inspectionDpiScale))
  $inspectionTargetLayout = Test-StableWechatTarget $inspectionRect $inspectionWorkArea $inspectionTargetWidth $inspectionTargetHeight
  @{
    ok = $true
    inspectionOnly = $true
    normalized = [bool]$inspectionTargetLayout
    layoutMode = $(if ($inspectionTargetLayout) { "stable_target" } else { "current_usable" })
    focused = $true
    title = $matched.title
    processName = $matched.processName
    windowClass = $matched.windowClass
    pid = $matched.pid
    hWnd = $hWnd.ToInt64()
    x = $inspectionRect.Left
    y = $inspectionRect.Top
    width = $inspectionRect.Right - $inspectionRect.Left
    height = $inspectionRect.Bottom - $inspectionRect.Top
    dpi = $inspectionDpi
    inputTick = [Win32WechatWindow]::GetLastInputTick()
  } | ConvertTo-Json -Compress
  exit
}
if (-not (Test-XiaoxiUserIdle)) { Stop-ForActiveUser $matched.pid $hWnd; exit }
if (-not (Test-MatchedWechatWindowIdentity $hWnd $matched)) {
  @{ ok = $false; reason = "wechat_window_identity_mismatch"; pid = $matched.pid; hWnd = $hWnd.ToInt64() } | ConvertTo-Json -Compress
  exit
}
$wasIconic = [Win32WechatWindow]::IsIconic($hWnd)
$wasVisible = [Win32WechatWindow]::IsWindowVisible($hWnd)
if ($wasIconic -or -not $wasVisible) {
  if (-not (Test-XiaoxiUserIdle)) { Stop-ForActiveUser $matched.pid $hWnd; exit }
  if ($wasIconic) {
    [void][Win32WechatWindow]::ShowWindowAsync($hWnd, 9)
  } elseif (-not $nativeActivationRequested) {
    if (-not (Request-PersonalWechatActivation $matched)) {
      @{ ok = $false; reason = "wechat_window_not_ready"; pid = $matched.pid; hWnd = $hWnd.ToInt64() } | ConvertTo-Json -Compress
      exit
    }
    $nativeActivationRequested = $true
  }
  for ($restoreAttempt = 0; $restoreAttempt -lt 20; $restoreAttempt++) {
    Start-Sleep -Milliseconds 100
    $restoreProbeRect = New-Object Win32WechatWindow+RECT
    $restoreProbeReady = [Win32WechatWindow]::GetWindowRect($hWnd, [ref]$restoreProbeRect) -and
      [Win32WechatWindow]::IsWindowVisible($hWnd) -and -not [Win32WechatWindow]::IsIconic($hWnd) -and
      ($restoreProbeRect.Right - $restoreProbeRect.Left) -ge 600 -and
      ($restoreProbeRect.Bottom - $restoreProbeRect.Top) -ge 500
    if ($restoreProbeReady) { break }
  }
}
$restoredRect = New-Object Win32WechatWindow+RECT
$restoredRectAvailable = [Win32WechatWindow]::GetWindowRect($hWnd, [ref]$restoredRect)
$restoredWindowPid = [uint32]0
$restoredWindowThread = [Win32WechatWindow]::GetWindowThreadProcessId($hWnd, [ref]$restoredWindowPid)
$restoredProcess = Get-Process -Id $restoredWindowPid -ErrorAction SilentlyContinue
$restoredOwnership = $restoredWindowThread -ne 0 -and $restoredWindowPid -eq [uint32]$matched.pid -and
  $restoredProcess -and $processNames -contains $restoredProcess.ProcessName
$restoredIdentity = Test-MatchedWechatWindowIdentity $hWnd $matched
$restoredMainLayout = $restoredOwnership -and $restoredIdentity -and $restoredRectAvailable -and [Win32WechatWindow]::IsWindowVisible($hWnd) -and -not [Win32WechatWindow]::IsIconic($hWnd) -and
  ($restoredRect.Right - $restoredRect.Left) -ge 600 -and ($restoredRect.Bottom - $restoredRect.Top) -ge 500
if (-not $restoredMainLayout) {
  @{ ok = $false; reason = "wechat_window_not_ready"; pid = $matched.pid; hWnd = $hWnd.ToInt64() } | ConvertTo-Json -Compress
  exit
}
$workArea = [System.Windows.Forms.Screen]::FromHandle($hWnd).WorkingArea
$dpi = [uint32]96
try {
  $windowDpi = [Win32WechatWindow]::GetDpiForWindow($hWnd)
  if ($windowDpi -ge 72 -and $windowDpi -le 480) { $dpi = $windowDpi }
} catch {}
$dpiScale = [double]$dpi / 96.0
$targetWidth = ${WECHAT_STABLE_WINDOW_LAYOUT.width}
$targetHeight = ${WECHAT_STABLE_WINDOW_LAYOUT.height}
$width = [Math]::Min([int]$workArea.Width, [int][Math]::Round($targetWidth * $dpiScale))
$height = [Math]::Min([int]$workArea.Height, [int][Math]::Round($targetHeight * $dpiScale))
if (-not (Test-XiaoxiUserIdle)) { Stop-ForActiveUser $matched.pid $hWnd; exit }
if ([Win32WechatWindow]::IsZoomed($hWnd)) {
  [void][Win32WechatWindow]::ShowWindowAsync($hWnd, 9)
  Start-Sleep -Milliseconds 120
}
[void][Win32WechatWindow]::SetWindowPos($hWnd, [IntPtr]::Zero, $workArea.Left, $workArea.Top, $width, $height, 0x0014)
Start-Sleep -Milliseconds 160
Set-WechatWindowStage "focus"
$focused = [Win32WechatWindow]::GetForegroundWindow() -eq $hWnd
if (-not $focused) {
  if (-not (Test-XiaoxiUserIdle)) { Stop-ForActiveUser $matched.pid $hWnd; exit }
  $focused = Request-ExactWechatForeground $hWnd $matched $nativeActivationRequested
}
$rect = New-Object Win32WechatWindow+RECT
$rectAvailable = [Win32WechatWindow]::GetWindowRect($hWnd, [ref]$rect)
$targetLayoutVerified = $rectAvailable -and (Test-StableWechatTarget $rect $workArea $width $height)
Set-WechatWindowStage "verify"
$finalIdentity = Test-MatchedWechatWindowIdentity $hWnd $matched
$usableCurrentLayout = $finalIdentity -and $rectAvailable -and [Win32WechatWindow]::IsWindowVisible($hWnd) -and
  -not [Win32WechatWindow]::IsIconic($hWnd) -and
  ($rect.Right - $rect.Left) -ge 600 -and ($rect.Bottom - $rect.Top) -ge 500
if (-not $usableCurrentLayout) {
  @{ ok = $false; reason = "wechat_window_not_ready"; pid = $matched.pid; hWnd = $hWnd.ToInt64() } | ConvertTo-Json -Compress
  exit
}
Set-WechatWindowStage "complete"
@{
  ok = $true
  normalized = [bool]$targetLayoutVerified
  layoutMode = $(if ($targetLayoutVerified) { "stable_target" } else { "current_usable" })
  title = $matched.title
  focused = [bool]$focused
  processName = $matched.processName
  windowClass = $matched.windowClass
  identityEvidence = @{ classRank = $matched.classRank; layoutRank = $matched.layoutRank; styleRank = $matched.styleRank }
  pid = $matched.pid
  hWnd = $hWnd.ToInt64()
  x = $rect.Left
  y = $rect.Top
  width = $rect.Right - $rect.Left
  height = $rect.Bottom - $rect.Top
  dpi = $dpi
} | ConvertTo-Json -Compress
`;

const INSPECT_WECHAT_RPA_SURFACE_SCRIPT = `
${WECHAT_RENDER_SURFACE_POWERSHELL}
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32WechatRpaSurfaceInspector {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint sourceThreadId, uint targetThreadId, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr extraData);
  public static uint GetLastInputTick() {
    LASTINPUTINFO info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    return GetLastInputInfo(ref info) ? info.dwTime : UInt32.MaxValue;
  }
  public static uint GetLastInputIdleMilliseconds() {
    uint tick = GetLastInputTick();
    return tick == UInt32.MaxValue ? UInt32.MaxValue : unchecked((uint)Environment.TickCount - tick);
  }
  public static bool HasDescendantClass(IntPtr parent, string expectedClass) {
    bool found = false;
    EnumWindowsProc callback = delegate(IntPtr child, IntPtr extraData) {
      StringBuilder classText = new StringBuilder(256);
      GetClassName(child, classText, classText.Capacity);
      if (String.Equals(classText.ToString().Trim(), expectedClass, StringComparison.Ordinal)) {
        found = true;
        return false;
      }
      return true;
    };
    EnumChildWindows(parent, callback, IntPtr.Zero);
    return found;
  }
}
"@
try { [void][Win32WechatRpaSurfaceInspector]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch {}
[int]$expectedPid = 0
[int64]$expectedHWnd = 0
$surfaceMode = [string]$env:XIAOXI_WECHAT_SURFACE_MODE
$expectedTitle = [string]$env:XIAOXI_WECHAT_EXPECTED_TITLE
$expectedClass = [string]$env:XIAOXI_WECHAT_EXPECTED_CLASS
$focusExact = [string]$env:XIAOXI_WECHAT_FOCUS_EXACT -ceq "1"
[int]$minimumIdleMs = 0
if (-not [int]::TryParse([string]$env:XIAOXI_WECHAT_MIN_IDLE_MS, [ref]$minimumIdleMs) -or $minimumIdleMs -lt 0) { $minimumIdleMs = 0 }
$minimumIdleMs = [Math]::Min($minimumIdleMs, 60000)
if (@("integrated", "standalone") -notcontains $surfaceMode -or
  -not [int]::TryParse([string]$env:XIAOXI_EXPECTED_PID, [ref]$expectedPid) -or $expectedPid -le 0 -or
  -not [int64]::TryParse([string]$env:XIAOXI_EXPECTED_HWND, [ref]$expectedHWnd) -or $expectedHWnd -le 0 -or
  [string]::IsNullOrWhiteSpace($expectedTitle) -or [string]::IsNullOrWhiteSpace($expectedClass)) {
  @{ ok = $false; reason = "wechat_window_identity_mismatch" } | ConvertTo-Json -Compress
  exit
}
$hWnd = [IntPtr]$expectedHWnd
if (-not [Win32WechatRpaSurfaceInspector]::IsWindow($hWnd)) {
  @{ ok = $false; reason = "wechat_window_identity_mismatch" } | ConvertTo-Json -Compress
  exit
}
[uint32]$actualPid = 0
[void][Win32WechatRpaSurfaceInspector]::GetWindowThreadProcessId($hWnd, [ref]$actualPid)
$process = Get-Process -Id $actualPid -ErrorAction SilentlyContinue
$titleText = New-Object System.Text.StringBuilder 512
[void][Win32WechatRpaSurfaceInspector]::GetWindowText($hWnd, $titleText, $titleText.Capacity)
$classText = New-Object System.Text.StringBuilder 256
[void][Win32WechatRpaSurfaceInspector]::GetClassName($hWnd, $classText, $classText.Capacity)
$title = $titleText.ToString().Trim()
$windowClass = $classText.ToString().Trim()
if ([int]$actualPid -ne $expectedPid -or -not $process -or @("Weixin", "WeChat") -notcontains $process.ProcessName -or
  $title -cne $expectedTitle -or $windowClass -cne $expectedClass) {
  @{ ok = $false; reason = "wechat_window_identity_mismatch"; pid = [int]$actualPid; hWnd = $expectedHWnd } | ConvertTo-Json -Compress
  exit
}
$rect = New-Object Win32WechatRpaSurfaceInspector+RECT
$rectAvailable = [Win32WechatRpaSurfaceInspector]::GetWindowRect($hWnd, [ref]$rect)
$width = if ($rectAvailable) { $rect.Right - $rect.Left } else { 0 }
$height = if ($rectAvailable) { $rect.Bottom - $rect.Top } else { 0 }
if (-not $rectAvailable -or -not [Win32WechatRpaSurfaceInspector]::IsWindowVisible($hWnd) -or
  [Win32WechatRpaSurfaceInspector]::IsIconic($hWnd) -or $width -lt 300 -or $height -lt 300) {
  @{ ok = $false; reason = "wechat_window_not_ready"; pid = $expectedPid; hWnd = $expectedHWnd } | ConvertTo-Json -Compress
  exit
}
$initialRect = @{
  left = [int]$rect.Left
  top = [int]$rect.Top
  width = [int]$width
  height = [int]$height
}
[uint32]$initialDpi = 96
try {
  $observedInitialDpi = [Win32WechatRpaSurfaceInspector]::GetDpiForWindow($hWnd)
  if ($observedInitialDpi -ge 72 -and $observedInitialDpi -le 480) { $initialDpi = $observedInitialDpi }
} catch {}
if ($focusExact) {
  [int]$expectedX = 0
  [int]$expectedY = 0
  [int]$expectedWidth = 0
  [int]$expectedHeight = 0
  [int]$expectedDpi = 0
  $expectedDpiText = [string]$env:XIAOXI_WECHAT_EXPECTED_DPI
  $hasExpectedDpi = -not [string]::IsNullOrWhiteSpace($expectedDpiText)
  if (@("integrated", "standalone") -notcontains $surfaceMode -or
    -not [int]::TryParse([string]$env:XIAOXI_WECHAT_EXPECTED_X, [ref]$expectedX) -or
    -not [int]::TryParse([string]$env:XIAOXI_WECHAT_EXPECTED_Y, [ref]$expectedY) -or
    -not [int]::TryParse([string]$env:XIAOXI_WECHAT_EXPECTED_WIDTH, [ref]$expectedWidth) -or $expectedWidth -lt 300 -or
    -not [int]::TryParse([string]$env:XIAOXI_WECHAT_EXPECTED_HEIGHT, [ref]$expectedHeight) -or $expectedHeight -lt 300 -or
    ($hasExpectedDpi -and (-not [int]::TryParse($expectedDpiText, [ref]$expectedDpi) -or $expectedDpi -lt 72 -or $expectedDpi -gt 480)) -or
    $initialRect.left -ne $expectedX -or $initialRect.top -ne $expectedY -or
    $initialRect.width -ne $expectedWidth -or $initialRect.height -ne $expectedHeight -or
    ($hasExpectedDpi -and [int]$initialDpi -ne $expectedDpi)) {
    @{ ok = $false; reason = "moments_window_identity_mismatch"; pid = $expectedPid; hWnd = $expectedHWnd } | ConvertTo-Json -Compress
    exit
  }
  if ($minimumIdleMs -gt 0) {
    $idleMs = [Win32WechatRpaSurfaceInspector]::GetLastInputIdleMilliseconds()
    if ($idleMs -eq [uint32]::MaxValue) {
      @{ ok = $false; reason = "wechat_input_lease_unavailable"; pid = $expectedPid; hWnd = $expectedHWnd; safety_diagnostics = @{ phase = "prepare_wechat_window"; input_lease = "unavailable"; expected_hWnd = [int64]$expectedHWnd; foreground_hWnd = [int64]([Win32WechatRpaSurfaceInspector]::GetForegroundWindow().ToInt64()) } } | ConvertTo-Json -Compress
      exit
    }
    if ([uint64]$idleMs -lt [uint64]$minimumIdleMs) {
      @{ ok = $false; reason = "wechat_user_active"; pid = $expectedPid; hWnd = $expectedHWnd; safety_diagnostics = @{ phase = "prepare_wechat_window"; required_idle_ms = [int64]$minimumIdleMs; observed_idle_ms = [int64]$idleMs; expected_hWnd = [int64]$expectedHWnd; foreground_hWnd = [int64]([Win32WechatRpaSurfaceInspector]::GetForegroundWindow().ToInt64()) } } | ConvertTo-Json -Compress
      exit
    }
  }
  [uint32]$inputTick = [Win32WechatRpaSurfaceInspector]::GetLastInputTick()
  if ($inputTick -eq [uint32]::MaxValue) {
    @{ ok = $false; reason = "wechat_input_lease_unavailable"; pid = $expectedPid; hWnd = $expectedHWnd; safety_diagnostics = @{ phase = "prepare_wechat_window"; input_lease = "unavailable"; expected_hWnd = [int64]$expectedHWnd; foreground_hWnd = [int64]([Win32WechatRpaSurfaceInspector]::GetForegroundWindow().ToInt64()) } } | ConvertTo-Json -Compress
    exit
  }
  if ([Win32WechatRpaSurfaceInspector]::GetForegroundWindow() -ne $hWnd) {
    $foreground = [Win32WechatRpaSurfaceInspector]::GetForegroundWindow()
    [uint32]$foregroundPid = 0
    [uint32]$targetPid = 0
    $foregroundThread = if ($foreground -eq [IntPtr]::Zero) { [uint32]0 } else { [Win32WechatRpaSurfaceInspector]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid) }
    $targetThread = [Win32WechatRpaSurfaceInspector]::GetWindowThreadProcessId($hWnd, [ref]$targetPid)
    $currentThread = [Win32WechatRpaSurfaceInspector]::GetCurrentThreadId()
    $attachedForeground = $false
    $attachedTarget = $false
    try {
      if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
        $attachedForeground = [Win32WechatRpaSurfaceInspector]::AttachThreadInput($currentThread, $foregroundThread, $true)
      }
      if ($targetThread -ne 0 -and $targetThread -ne $currentThread) {
        $attachedTarget = [Win32WechatRpaSurfaceInspector]::AttachThreadInput($currentThread, $targetThread, $true)
      }
      [void][Win32WechatRpaSurfaceInspector]::BringWindowToTop($hWnd)
      [void][Win32WechatRpaSurfaceInspector]::SetForegroundWindow($hWnd)
    } finally {
      if ($attachedTarget) { [void][Win32WechatRpaSurfaceInspector]::AttachThreadInput($currentThread, $targetThread, $false) }
      if ($attachedForeground) { [void][Win32WechatRpaSurfaceInspector]::AttachThreadInput($currentThread, $foregroundThread, $false) }
    }
    Start-Sleep -Milliseconds 120
  }
  [uint32]$currentInputTick = [Win32WechatRpaSurfaceInspector]::GetLastInputTick()
  if ($currentInputTick -eq [uint32]::MaxValue) {
    @{ ok = $false; reason = "wechat_input_lease_unavailable"; pid = $expectedPid; hWnd = $expectedHWnd; safety_diagnostics = @{ phase = "prepare_wechat_window"; input_lease = "unavailable"; expected_hWnd = [int64]$expectedHWnd; foreground_hWnd = [int64]([Win32WechatRpaSurfaceInspector]::GetForegroundWindow().ToInt64()) } } | ConvertTo-Json -Compress
    exit
  }
  if ($currentInputTick -ne $inputTick) {
    @{ ok = $false; reason = "wechat_external_input_detected"; pid = $expectedPid; hWnd = $expectedHWnd; safety_diagnostics = @{ phase = "prepare_wechat_window"; expected_input_tick = [uint64]$inputTick; current_input_tick = [uint64]$currentInputTick; expected_hWnd = [int64]$expectedHWnd; foreground_hWnd = [int64]([Win32WechatRpaSurfaceInspector]::GetForegroundWindow().ToInt64()) } } | ConvertTo-Json -Compress
    exit
  }
}
if ([Win32WechatRpaSurfaceInspector]::GetForegroundWindow() -ne $hWnd) {
  @{ ok = $false; reason = "wechat_window_not_foreground"; pid = $expectedPid; hWnd = $expectedHWnd } | ConvertTo-Json -Compress
  exit
}
[uint32]$dpi = 96
try {
  $observedDpi = [Win32WechatRpaSurfaceInspector]::GetDpiForWindow($hWnd)
  if ($observedDpi -ge 72 -and $observedDpi -le 480) { $dpi = $observedDpi }
} catch {}
$targetWorkArea = [System.Windows.Forms.Screen]::FromHandle($hWnd).WorkingArea
$targetDpiScale = [double]$dpi / 96.0
$targetLayoutMode = if ($surfaceMode -ceq "standalone") { "${WECHAT_MOMENTS_STANDALONE_WINDOW_LAYOUT_MODE}" } else { "${WECHAT_RPA_WINDOW_LAYOUT_MODE}" }
$targetLeft = if ($surfaceMode -ceq "standalone") { [int]$initialRect.left } else { [int]$targetWorkArea.Left }
$targetTop = if ($surfaceMode -ceq "standalone") { [int]$initialRect.top } else { [int]$targetWorkArea.Top }
$targetWidth = if ($surfaceMode -ceq "standalone") {
  [int]$initialRect.width
} else {
  [Math]::Min([int]$targetWorkArea.Width, [int][Math]::Round(${WECHAT_STABLE_WINDOW_LAYOUT.width} * $targetDpiScale))
}
$targetHeight = if ($surfaceMode -ceq "standalone") {
  [int]$initialRect.height
} else {
  [Math]::Min([int]$targetWorkArea.Height, [int][Math]::Round(${WECHAT_STABLE_WINDOW_LAYOUT.height} * $targetDpiScale))
}
if ($focusExact) {
  $finalRect = New-Object Win32WechatRpaSurfaceInspector+RECT
  [uint32]$finalPid = 0
  $finalTitleText = New-Object System.Text.StringBuilder 512
  $finalClassText = New-Object System.Text.StringBuilder 256
  $finalReady = [Win32WechatRpaSurfaceInspector]::IsWindow($hWnd) -and
    [Win32WechatRpaSurfaceInspector]::GetWindowRect($hWnd, [ref]$finalRect) -and
    [Win32WechatRpaSurfaceInspector]::GetWindowThreadProcessId($hWnd, [ref]$finalPid) -ne 0
  [void][Win32WechatRpaSurfaceInspector]::GetWindowText($hWnd, $finalTitleText, $finalTitleText.Capacity)
  [void][Win32WechatRpaSurfaceInspector]::GetClassName($hWnd, $finalClassText, $finalClassText.Capacity)
  $expectedFinalLeft = $initialRect.left
  $expectedFinalTop = $initialRect.top
  $expectedFinalWidth = $initialRect.width
  $expectedFinalHeight = $initialRect.height
  if (-not $finalReady -or [int]$finalPid -ne $expectedPid -or
    $finalTitleText.ToString().Trim() -cne $expectedTitle -or $finalClassText.ToString().Trim() -cne $expectedClass -or
    $finalRect.Left -ne $expectedFinalLeft -or $finalRect.Top -ne $expectedFinalTop -or
    ($finalRect.Right - $finalRect.Left) -ne $expectedFinalWidth -or
    ($finalRect.Bottom - $finalRect.Top) -ne $expectedFinalHeight -or [int]$dpi -ne [int]$initialDpi) {
    @{ ok = $false; reason = "moments_window_changed"; pid = $expectedPid; hWnd = $expectedHWnd } | ConvertTo-Json -Compress
    exit
  }
  $rect = $finalRect
  $width = $finalRect.Right - $finalRect.Left
  $height = $finalRect.Bottom - $finalRect.Top
}
$layoutMode = $targetLayoutMode
$normalized = [Math]::Abs($rect.Left - $targetLeft) -le 3 -and [Math]::Abs($rect.Top - $targetTop) -le 3 -and
  [Math]::Abs($width - $targetWidth) -le 3 -and [Math]::Abs($height - $targetHeight) -le 3
if ($surfaceMode -ceq "integrated") {
  try { $surfaceRoot = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd) } catch { $surfaceRoot = $null }
  $surfaceEvidence = Get-MomentsRenderPaneEvidence $surfaceRoot $expectedPid
  $normalized = $normalized -and [bool]$surfaceEvidence.ok
}
if (-not $normalized) {
  @{ ok = $false; reason = "wechat_window_not_ready"; pid = $expectedPid; hWnd = $expectedHWnd } | ConvertTo-Json -Compress
  exit
}
if ($focusExact) {
  [uint32]$finalObservedInputTick = [Win32WechatRpaSurfaceInspector]::GetLastInputTick()
  if ($finalObservedInputTick -eq [uint32]::MaxValue) {
    @{ ok = $false; reason = "wechat_input_lease_unavailable"; pid = $expectedPid; hWnd = $expectedHWnd; safety_diagnostics = @{ phase = "prepare_wechat_window"; input_lease = "unavailable"; expected_hWnd = [int64]$expectedHWnd; foreground_hWnd = [int64]([Win32WechatRpaSurfaceInspector]::GetForegroundWindow().ToInt64()) } } | ConvertTo-Json -Compress
    exit
  }
  if ($finalObservedInputTick -ne $inputTick) {
    @{ ok = $false; reason = "wechat_external_input_detected"; pid = $expectedPid; hWnd = $expectedHWnd; safety_diagnostics = @{ phase = "prepare_wechat_window"; expected_input_tick = [uint64]$inputTick; current_input_tick = [uint64]$finalObservedInputTick; expected_hWnd = [int64]$expectedHWnd; foreground_hWnd = [int64]([Win32WechatRpaSurfaceInspector]::GetForegroundWindow().ToInt64()) } } | ConvertTo-Json -Compress
    exit
  }
}
if ($focusExact -and [Win32WechatRpaSurfaceInspector]::GetForegroundWindow() -ne $hWnd) {
  @{ ok = $false; reason = "wechat_window_not_foreground"; pid = $expectedPid; hWnd = $expectedHWnd } | ConvertTo-Json -Compress
  exit
}
if ($focusExact -and (-not [Win32WechatRpaSurfaceInspector]::IsWindowVisible($hWnd) -or
  [Win32WechatRpaSurfaceInspector]::IsIconic($hWnd))) {
  @{ ok = $false; reason = "wechat_window_not_ready"; pid = $expectedPid; hWnd = $expectedHWnd } | ConvertTo-Json -Compress
  exit
}
$finalInputTick = if ($focusExact) { [uint32]$inputTick } else { [Win32WechatRpaSurfaceInspector]::GetLastInputTick() }
@{
  ok = $true
  inspectionOnly = -not $focusExact
  focusOnly = [bool]$focusExact
  surfaceMode = $surfaceMode
  normalized = [bool]$normalized
  layoutMode = $layoutMode
  focused = $true
  title = $title
  processName = $process.ProcessName
  windowClass = $windowClass
  pid = $expectedPid
  hWnd = $expectedHWnd
  x = $rect.Left
  y = $rect.Top
  width = $width
  height = $height
  dpi = $dpi
  inputTick = [uint32]$finalInputTick
} | ConvertTo-Json -Compress
`;

function normalizeWechatMainWindow(context = {}, runner = runPowerShell) {
  const requestedIdleMs = Number(context.minIdleMs);
  const minIdleMs = Number.isFinite(requestedIdleMs)
    ? Math.max(0, Math.min(60_000, Math.floor(requestedIdleMs)))
    : 0;
  const wechatExe = process.env.XIAOXI_WECHAT_EXE || wechatExecutableForLaunch();
  // Resolve the exact WeChat host HWND once, restore it to the stable_target
  // layout, and keep the same window identity through the operation.
  return runner(NORMALIZE_WECHAT_WINDOW_SCRIPT, {
    XIAOXI_EXPECTED_PID: String(context.expectedPid ?? context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.expectedHWnd ?? context.hWnd ?? ""),
    XIAOXI_WECHAT_MIN_IDLE_MS: String(minIdleMs),
    XIAOXI_WECHAT_EXE: wechatExe
  }, { ensure: false, timeout: WECHAT_WINDOW_PREPARE_TIMEOUT_MS, windowDiagnostics: true, signal: context.signal });
}

function normalizeWechatMainWindowAsync(context = {}, runner = runPowerShellAsync) {
  return Promise.resolve(normalizeWechatMainWindow(context, runner));
}

function inspectForegroundWechatMainWindow(context = {}, runner = runPowerShell) {
  return runner(NORMALIZE_WECHAT_WINDOW_SCRIPT, {
    XIAOXI_EXPECTED_PID: String(context.expectedPid ?? context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.expectedHWnd ?? context.hWnd ?? ""),
    XIAOXI_WECHAT_MIN_IDLE_MS: String(context.minIdleMs ?? 0),
    XIAOXI_WECHAT_INSPECT_ONLY: "1"
  }, { ensure: false, timeout: WECHAT_WINDOW_PREPARE_TIMEOUT_MS, windowDiagnostics: true, signal: context.signal });
}

function inspectForegroundWechatRpaSurface(context = {}, runner = runPowerShell) {
  const expectedPid = Number(context.expectedPid ?? context.pid);
  const expectedHWnd = String(context.expectedHWnd ?? context.hWnd ?? "").trim();
  const expectedTitle = String(context.expectedTitle ?? context.title ?? "").trim();
  const expectedWindowClass = String(context.expectedWindowClass ?? context.windowClass ?? context.className ?? "").trim();
  const surfaceMode = context.surfaceMode === "standalone" ? "standalone" : context.surfaceMode === "integrated" ? "integrated" : "";
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0 || !/^[1-9]\d*$/u.test(expectedHWnd)
    || !expectedTitle || !expectedWindowClass || !surfaceMode) {
    return { ok: false, reason: "wechat_window_identity_mismatch" };
  }
  return runner(INSPECT_WECHAT_RPA_SURFACE_SCRIPT, {
    XIAOXI_EXPECTED_PID: String(expectedPid),
    XIAOXI_EXPECTED_HWND: expectedHWnd,
    XIAOXI_WECHAT_EXPECTED_TITLE: expectedTitle,
    XIAOXI_WECHAT_EXPECTED_CLASS: expectedWindowClass,
    XIAOXI_WECHAT_SURFACE_MODE: surfaceMode,
    XIAOXI_WECHAT_FOCUS_EXACT: context.focusExact === true ? "1" : "0",
    XIAOXI_WECHAT_MIN_IDLE_MS: String(context.minIdleMs ?? 0),
    XIAOXI_WECHAT_EXPECTED_X: String(context.expectedX ?? context.x ?? context.left ?? ""),
    XIAOXI_WECHAT_EXPECTED_Y: String(context.expectedY ?? context.y ?? context.top ?? ""),
    XIAOXI_WECHAT_EXPECTED_WIDTH: String(context.expectedWidth ?? context.width ?? ""),
    XIAOXI_WECHAT_EXPECTED_HEIGHT: String(context.expectedHeight ?? context.height ?? ""),
    XIAOXI_WECHAT_EXPECTED_DPI: String(context.expectedDpi ?? context.dpi ?? "")
  }, { ensure: false, signal: context.signal });
}

async function focusExactWechatRpaSurfaceAsync(context = {}, runner = runPowerShellAsync) {
  if (!["integrated", "standalone"].includes(context.surfaceMode)) {
    return { ok: false, reason: "moments_window_identity_mismatch" };
  }
  const expectedGeometry = [context.x ?? context.left, context.y ?? context.top, context.width, context.height].map(Number);
  const expectedDpi = context.dpi == null || context.dpi === "" ? null : Number(context.dpi);
  if (!expectedGeometry.every(Number.isInteger) || expectedGeometry[2] < 300 || expectedGeometry[3] < 300
    || (expectedDpi !== null && (!Number.isInteger(expectedDpi) || expectedDpi < 72 || expectedDpi > 480))) {
    return { ok: false, reason: "moments_window_identity_mismatch" };
  }
  const result = await inspectForegroundWechatRpaSurface({ ...context, focusExact: true }, runner);
  if (!result?.ok) return result || { ok: false, reason: "wechat_window_not_ready" };
  const integrated = context.surfaceMode === "integrated";
  const expectedLayoutMode = integrated
    ? WECHAT_RPA_WINDOW_LAYOUT_MODE
    : WECHAT_MOMENTS_STANDALONE_WINDOW_LAYOUT_MODE;
  if (result.focusOnly !== true || result.inspectionOnly !== false || result.focused !== true
    || result.normalized !== true || result.layoutMode !== expectedLayoutMode
    || result.surfaceMode !== context.surfaceMode
    || !sameWindowIdentifier(context.pid, result.pid) || !sameWindowIdentifier(context.hWnd, result.hWnd)
    || (context.processName != null && String(context.processName) !== String(result.processName ?? ""))
    || String(context.title ?? "") !== String(result.title ?? "")
    || String(context.windowClass ?? context.className ?? "") !== String(result.windowClass ?? "")
    || expectedGeometry[0] !== Number(result.x) || expectedGeometry[1] !== Number(result.y)
    || expectedGeometry[2] !== Number(result.width) || expectedGeometry[3] !== Number(result.height)
    || ![result.x, result.y, result.width, result.height].map(Number).every(Number.isInteger)
    || Number(result.width) < 300 || Number(result.height) < 300
    || (expectedDpi !== null && expectedDpi !== Number(result.dpi))) {
    return { ...result, ok: false, reason: "moments_window_identity_mismatch" };
  }
  return result;
}

function sameWindowIdentifier(expected, actual) {
  const expectedText = String(expected ?? "").trim();
  if (!expectedText) return true;
  const actualText = String(actual ?? "").trim();
  if (!actualText) return false;
  try {
    return BigInt(expectedText) === BigInt(actualText);
  } catch {
    return expectedText === actualText;
  }
}

function validatePreparedWechatRpaWindow(result, context = {}) {
  if (result?.ok !== true) {
    return result?.reason ? result : { ok: false, reason: "wechat_window_not_ready" };
  }
  const expectedPid = context.expectedPid ?? context.pid ?? "";
  const expectedHWnd = context.expectedHWnd ?? context.hWnd ?? "";
  if (!sameWindowIdentifier(expectedPid, result.pid) || !sameWindowIdentifier(expectedHWnd, result.hWnd)) {
    return { ...result, ok: false, reason: "wechat_window_identity_mismatch" };
  }
  const pid = Number(result.pid);
  const hWnd = String(result.hWnd ?? "").trim();
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[1-9][0-9]{0,19}$/u.test(hWnd)
    || !isPreparedWechatRpaLayout(result)) {
    return { ...result, ok: false, reason: "wechat_window_not_ready" };
  }
  if (context.requireFocused === true && result.focused !== true) {
    return { ...result, ok: false, reason: "wechat_window_not_foreground" };
  }
  return result;
}

function isPreparedWechatRpaLayout(result) {
  return result?.normalized === true && result.layoutMode === WECHAT_RPA_WINDOW_LAYOUT_MODE;
}

function prepareWechatRpaWindow(context = {}, runner = runPowerShell) {
  return validatePreparedWechatRpaWindow(normalizeWechatMainWindow(context, runner), context);
}

async function prepareWechatRpaWindowAsync(context = {}, runner = runPowerShellAsync) {
  const result = await normalizeWechatMainWindowAsync(context, runner);
  return validatePreparedWechatRpaWindow(result, context);
}

function focusWechatWindow(context = {}, runner = runPowerShell) {
  return normalizeWechatMainWindow(context, runner);
}

function focusWechatWindowAsync(context = {}, runner = runPowerShellAsync) {
  return normalizeWechatMainWindowAsync(context, runner);
}

const SEARCH_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32WechatWindowSearch {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr extraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort virtualKey; public ushort scanCode; public uint flags; public uint time; public UIntPtr extraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUT {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public MOUSEINPUT mouseInput;
    [FieldOffset(8)] public KEYBDINPUT keyboardInput;
  }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  private const uint KeyEventfKeyUp = 0x0002u;
  private const uint KeyEventfUnicode = 0x0004u;
  public static bool AtomicUnicodeText(string text) {
    if (IntPtr.Size != 8 || String.IsNullOrEmpty(text) || text.Length > 500) return false;
    INPUT[] inputs = new INPUT[text.Length * 2];
    for (int index = 0; index < text.Length; index++) {
      ushort codeUnit = text[index];
      inputs[index * 2].type = 1;
      inputs[index * 2].keyboardInput = new KEYBDINPUT { virtualKey = 0, scanCode = codeUnit, flags = KeyEventfUnicode, time = 0, extraInfo = UIntPtr.Zero };
      inputs[index * 2 + 1].type = 1;
      inputs[index * 2 + 1].keyboardInput = new KEYBDINPUT { virtualKey = 0, scanCode = codeUnit, flags = KeyEventfUnicode | KeyEventfKeyUp, time = 0, extraInfo = UIntPtr.Zero };
    }
    return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == inputs.Length;
  }
  public static uint GetLastInputTick() {
    LASTINPUTINFO info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    return GetLastInputInfo(ref info) ? info.dwTime : UInt32.MaxValue;
  }
  public static uint GetLastInputIdleMilliseconds() {
    uint tick = GetLastInputTick();
    return tick == UInt32.MaxValue ? UInt32.MaxValue : unchecked((uint)Environment.TickCount - tick);
  }
}
"@
$query = [Environment]::GetEnvironmentVariable("XIAOXI_SEARCH_QUERY")
$compactQuery = [Text.RegularExpressions.Regex]::Replace(([string]$query).Normalize([Text.NormalizationForm]::FormKC), "\s+", "").ToLowerInvariant()
$networkSearchPattern = "^(?:搜一搜|网络搜索|搜索网络|搜索网络结果)(?:" + [Text.RegularExpressions.Regex]::Escape($compactQuery) + ")?$"
$pressEnter = [Environment]::GetEnvironmentVariable("XIAOXI_PRESS_ENTER") -eq "1"
$resultAutomationId = [Environment]::GetEnvironmentVariable("XIAOXI_SEARCH_RESULT_AUTOMATION_ID")
$observeLocalResults = [Environment]::GetEnvironmentVariable("XIAOXI_OBSERVE_LOCAL_RESULTS") -eq "1"
$script:searchAsTaskMethod = $null
function Wait-SearchWinRt($operation, [Type]$resultType, [int]$timeoutMs = 1800) {
  if ($script:searchAsTaskMethod -eq $null) { throw "windows_runtime_as_task_missing" }
  $task = $script:searchAsTaskMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (-not $task.Wait($timeoutMs)) { throw "windows_runtime_task_timeout" }
  return $task.Result
}
$expectedPid = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID")
$expectedHwnd = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_HWND")
$exactWindowBinding = -not [string]::IsNullOrWhiteSpace($expectedPid) -and -not [string]::IsNullOrWhiteSpace($expectedHwnd)
if (-not $exactWindowBinding) {
  @{ ok = $false; reason = "wechat_window_identity_missing" } | ConvertTo-Json -Compress
  exit
}
[int]$minimumIdleMs = 0
if (-not [int]::TryParse([string][Environment]::GetEnvironmentVariable("XIAOXI_WECHAT_MIN_IDLE_MS"), [ref]$minimumIdleMs) -or $minimumIdleMs -lt 0) { $minimumIdleMs = 0 }
$minimumIdleMs = [Math]::Min($minimumIdleMs, 60000)
$processNames = @("Weixin", "WeChat")
$script:inputLeaseActive = $false
$script:inputLeaseTick = [uint32]::MaxValue
function Stop-SearchForActiveUser {
  @{ ok = $false; reason = "wechat_user_active"; pid = $matched.pid; hWnd = $matched.hWnd; safety_diagnostics = @{ phase = "click_search_result"; required_idle_ms = [int64]$minimumIdleMs; observed_idle_ms = [int64]$idleMs; expected_hWnd = [int64]$matched.hWnd; foreground_hWnd = [int64]([Win32WechatWindowSearch]::GetForegroundWindow().ToInt64()) } } | ConvertTo-Json -Compress
  exit
}
function Stop-SearchForExternalInput([uint32]$expectedInputTick, [uint32]$currentInputTick) {
  @{ ok = $false; reason = "wechat_external_input_detected"; pid = $matched.pid; hWnd = $matched.hWnd; safety_diagnostics = @{ phase = "click_search_result"; expected_input_tick = [uint64]$expectedInputTick; current_input_tick = [uint64]$currentInputTick; expected_hWnd = [int64]$matched.hWnd; foreground_hWnd = [int64]([Win32WechatWindowSearch]::GetForegroundWindow().ToInt64()) } } | ConvertTo-Json -Compress
  exit
}
function Stop-SearchForInputLeaseUnavailable {
  @{ ok = $false; reason = "wechat_input_lease_unavailable"; pid = $matched.pid; hWnd = $matched.hWnd; safety_diagnostics = @{ phase = "click_search_result"; expected_hWnd = [int64]$matched.hWnd; foreground_hWnd = [int64]([Win32WechatWindowSearch]::GetForegroundWindow().ToInt64()) } } | ConvertTo-Json -Compress
  exit
}
function Stop-SearchForWindowNotForeground {
  @{ ok = $false; reason = "wechat_window_not_foreground"; pid = $matched.pid; hWnd = $matched.hWnd; safety_diagnostics = @{ phase = "click_search_result"; expected_hWnd = [int64]$matched.hWnd; foreground_hWnd = [int64]([Win32WechatWindowSearch]::GetForegroundWindow().ToInt64()) } } | ConvertTo-Json -Compress
  exit
}
function Stop-SearchForTargetChanged {
  @{ ok = $false; reason = "wechat_target_changed"; pid = $matched.pid; hWnd = $matched.hWnd; safety_diagnostics = @{ phase = "click_search_result"; expected_hWnd = [int64]$matched.hWnd; foreground_hWnd = [int64]([Win32WechatWindowSearch]::GetForegroundWindow().ToInt64()) } } | ConvertTo-Json -Compress
  exit
}
function Assert-ExactSearchForeground {
  if (-not $exactWindowBinding) { return }
  if ([Win32WechatWindowSearch]::GetForegroundWindow() -ne [IntPtr]$matched.hWnd) {
    Stop-SearchForWindowNotForeground
  }
  if ($script:inputLeaseActive) {
    [uint32]$currentInputTick = [Win32WechatWindowSearch]::GetLastInputTick()
    if ($currentInputTick -eq [uint32]::MaxValue) { Stop-SearchForInputLeaseUnavailable }
    if ($currentInputTick -ne $script:inputLeaseTick) {
      Stop-SearchForExternalInput $script:inputLeaseTick $currentInputTick
    }
  }
}
function Rebase-ExactSearchInputLease {
  if ($exactWindowBinding) {
    $script:inputLeaseTick = [Win32WechatWindowSearch]::GetLastInputTick()
    if ($script:inputLeaseTick -eq [uint32]::MaxValue) { Stop-SearchForInputLeaseUnavailable }
    $script:inputLeaseActive = $true
  }
}
$matched = $null
$callback = [Win32WechatWindowSearch+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if ($matched -ne $null) { return $true }
  if ([Win32WechatWindowSearch]::IsWindowVisible($hWnd)) {
    $text = New-Object System.Text.StringBuilder 512
    [void][Win32WechatWindowSearch]::GetWindowText($hWnd, $text, $text.Capacity)
    $title = $text.ToString().Trim()
    $rect = New-Object Win32WechatWindowSearch+RECT
    [void][Win32WechatWindowSearch]::GetWindowRect($hWnd, [ref]$rect)
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    [uint32]$windowProcessId = 0
    [void][Win32WechatWindowSearch]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
    $proc = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
    $matchesExpected = ([string]::IsNullOrWhiteSpace($expectedPid) -or [string]$windowProcessId -eq $expectedPid) -and ([string]::IsNullOrWhiteSpace($expectedHwnd) -or [string]$hWnd.ToInt64() -eq $expectedHwnd)
    if ($proc -and $matchesExpected -and $processNames -contains $proc.ProcessName -and $w -ge 600 -and $h -ge 500) {
      $focused = [Win32WechatWindowSearch]::GetForegroundWindow() -eq $hWnd
      $script:matched = @{ title = $title; focused = $focused; processName = $proc.ProcessName; pid = [int]$windowProcessId; hWnd = $hWnd.ToInt64(); x = $rect.Left; y = $rect.Top; width = $w; height = $h }
    }
  }
  return $true
}
[void][Win32WechatWindowSearch]::EnumWindows($callback, [IntPtr]::Zero)
if ($matched -eq $null) {
  @{ ok = $false; reason = "wechat_window_not_found" } | ConvertTo-Json -Compress
  exit
}
if (-not $matched.focused) {
  @{ ok = $false; reason = "wechat_window_not_foreground"; title = $matched.title; processName = $matched.processName; pid = $matched.pid; hWnd = $matched.hWnd } | ConvertTo-Json -Compress
  exit
}
$idleMs = [Win32WechatWindowSearch]::GetLastInputIdleMilliseconds()
if ($minimumIdleMs -gt 0) {
  if ($idleMs -eq [uint32]::MaxValue) { Stop-SearchForInputLeaseUnavailable }
  if ([uint64]$idleMs -lt [uint64]$minimumIdleMs) { Stop-SearchForActiveUser }
}
$expectedInputTick = [Win32WechatWindowSearch]::GetLastInputTick()
if ($expectedInputTick -eq [uint32]::MaxValue) { Stop-SearchForInputLeaseUnavailable }
Start-Sleep -Milliseconds 300
$currentInputTick = [Win32WechatWindowSearch]::GetLastInputTick()
if ($currentInputTick -eq [uint32]::MaxValue) { Stop-SearchForInputLeaseUnavailable }
if ($currentInputTick -ne $expectedInputTick) { Stop-SearchForExternalInput $expectedInputTick $currentInputTick }
if ([Win32WechatWindowSearch]::GetForegroundWindow() -ne [IntPtr]$matched.hWnd) { Stop-SearchForWindowNotForeground }
$script:inputLeaseTick = $currentInputTick
$script:inputLeaseActive = $exactWindowBinding
Assert-ExactSearchForeground
[System.Windows.Forms.SendKeys]::SendWait("^f")
Rebase-ExactSearchInputLease
Start-Sleep -Milliseconds 150
Assert-ExactSearchForeground
[System.Windows.Forms.SendKeys]::SendWait("^a")
Rebase-ExactSearchInputLease
Start-Sleep -Milliseconds 50
Assert-ExactSearchForeground
if (-not [Win32WechatWindowSearch]::AtomicUnicodeText($query)) {
  @{ ok = $false; reason = "wechat_search_input_failed"; pid = $matched.pid; hWnd = $matched.hWnd } | ConvertTo-Json -Compress
  exit
}
Rebase-ExactSearchInputLease
Start-Sleep -Milliseconds 300
Assert-ExactSearchForeground
$resultOpened = $false
$uiaCandidates = New-Object System.Collections.Generic.List[object]
$visualCandidates = New-Object System.Collections.Generic.List[object]
$webSearchCandidates = New-Object System.Collections.Generic.List[object]
$ocrOk = $false
$webSearchVisible = $false
$webSearchTop = $null
$cropBounds = $null
if ($observeLocalResults) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$matched.hWnd)
  for ($attempt = 0; $attempt -lt 5 -and $uiaCandidates.Count -eq 0; $attempt++) {
    Assert-ExactSearchForeground
    if ($root -ne $null) {
      $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      for ($i = 0; $i -lt $all.Count; $i++) {
        $item = $all.Item($i)
        $automationId = [string]$item.Current.AutomationId
        if (-not $automationId.StartsWith("search_item_function_", [StringComparison]::Ordinal) -or $item.Current.IsOffscreen) { continue }
        $itemRect = $item.Current.BoundingRectangle
        if ($itemRect.Width -le 10 -or $itemRect.Height -le 10) { continue }
        [void]$uiaCandidates.Add(@{ automationId = $automationId; name = [string]$item.Current.Name; x = [int]($itemRect.Left + ($itemRect.Width / 2)); y = [int]($itemRect.Top + ($itemRect.Height / 2)) })
      }
    }
    if ($uiaCandidates.Count -eq 0 -and $attempt -lt 4) { Start-Sleep -Milliseconds 250 }
  }
  if ($uiaCandidates.Count -eq 0) {
    $bitmap = $null; $graphics = $null; $memory = $null; $random = $null; $software = $null
    try {
      Add-Type -AssemblyName System.Drawing
      Add-Type -AssemblyName System.Runtime.WindowsRuntime
      $script:searchAsTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
        Select-Object -First 1
      $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
      $null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]
      $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
      $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType=WindowsRuntime]
      $null = [Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType=WindowsRuntime]
      $cropLeft = [int]$matched.x + [Math]::Min(58, [Math]::Floor($matched.width * 0.08))
      $cropTop = [int]$matched.y + [Math]::Max(72, [Math]::Floor($matched.height * 0.09))
      $cropWidth = [Math]::Max(120, [Math]::Min(430, [Math]::Floor($matched.width * 0.38)))
      $cropHeight = [Math]::Max(160, [Math]::Min(420, [Math]::Floor($matched.height * 0.55)))
      $cropBounds = @{ left = $cropLeft; top = $cropTop; right = $cropLeft + $cropWidth; bottom = $cropTop + $cropHeight }
      $bitmap = [System.Drawing.Bitmap]::new($cropWidth, $cropHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($cropLeft, $cropTop, 0, 0, [System.Drawing.Size]::new($cropWidth, $cropHeight), [System.Drawing.CopyPixelOperation]::SourceCopy)
      $memory = [IO.MemoryStream]::new()
      $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
      $random = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
      $writer = [Windows.Storage.Streams.DataWriter]::new($random)
      $writer.WriteBytes($memory.ToArray())
      [void](Wait-SearchWinRt ($writer.StoreAsync()) ([uint32]))
      [void](Wait-SearchWinRt ($writer.FlushAsync()) ([bool]))
      [void]$writer.DetachStream(); $writer.Dispose(); $random.Seek(0)
      $decoder = Wait-SearchWinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($random)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $software = Wait-SearchWinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new("zh-Hans-CN")); if ($engine -eq $null) { throw "ocr_unavailable" }
      $ocrResult = Wait-SearchWinRt ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult]) 2200
      foreach ($line in $ocrResult.Lines) {
        $text = ([string]$line.Text).Normalize([Text.NormalizationForm]::FormKC).Trim()
        if (-not $text) { continue }
        $compactText = [Text.RegularExpressions.Regex]::Replace($text, "\s+", "").ToLowerInvariant()
        $words = @($line.Words); if ($words.Count -eq 0) { continue }
        $left = ($words | ForEach-Object { [double]$_.BoundingRect.X } | Measure-Object -Minimum).Minimum
        $top = ($words | ForEach-Object { [double]$_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
        $right = ($words | ForEach-Object { [double]($_.BoundingRect.X + $_.BoundingRect.Width) } | Measure-Object -Maximum).Maximum
        $bottom = ($words | ForEach-Object { [double]($_.BoundingRect.Y + $_.BoundingRect.Height) } | Measure-Object -Maximum).Maximum
        $candidate = @{
          text = $text
          left = [int]($cropLeft + $left)
          top = [int]($cropTop + $top)
          right = [int]($cropLeft + $right)
          bottom = [int]($cropTop + $bottom)
          x = [int]($cropLeft + (($left + $right) / 2))
          y = [int]($cropTop + (($top + $bottom) / 2))
        }
        if ([Text.RegularExpressions.Regex]::IsMatch($compactText, $networkSearchPattern)) {
          $webSearchVisible = $true
          [void]$webSearchCandidates.Add($candidate)
          if ($webSearchTop -eq $null -or [int]$candidate.top -lt [int]$webSearchTop) { $webSearchTop = [int]$candidate.top }
          continue
        }
        [void]$visualCandidates.Add($candidate)
      }
      $ocrOk = $true
    } catch {
      $ocrOk = $false
    } finally {
      if ($graphics) { $graphics.Dispose() }; if ($bitmap) { $bitmap.Dispose() }; if ($software) { $software.Dispose() }; if ($random) { $random.Dispose() }; if ($memory) { $memory.Dispose() }
    }
  }
  @{ ok = $true; title = $matched.title; focused = $matched.focused; processName = $matched.processName; pid = $matched.pid; hWnd = $matched.hWnd; searchQuery = $query; inputLeaseTick = [uint64]$script:inputLeaseTick; searchResultObservation = @{ uiaCandidates = $uiaCandidates.ToArray(); visualCandidates = $visualCandidates.ToArray(); webSearchCandidates = $webSearchCandidates.ToArray(); webSearchTop = $webSearchTop; cropBounds = $cropBounds; ocrOk = $ocrOk; webSearchVisible = $webSearchVisible } } | ConvertTo-Json -Compress -Depth 6
  exit
} elseif (-not [string]::IsNullOrWhiteSpace($resultAutomationId)) {
  # Kept for the explicitly named File Transfer Assistant flow.
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$matched.hWnd)
  if ($root -ne $null) {
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $resultAutomationId)
    $item = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($item -ne $null -and -not $item.Current.IsOffscreen) {
      $itemRect = $item.Current.BoundingRectangle
      $clickX = [int]($itemRect.Left + ($itemRect.Width / 2)); $clickY = [int]($itemRect.Top + ($itemRect.Height / 2))
      [void][Win32WechatWindowSearch]::SetCursorPos($clickX, $clickY); [Win32WechatWindowSearch]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero); [Win32WechatWindowSearch]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
      $resultOpened = $true; Start-Sleep -Milliseconds 500
    }
  }
} elseif ($pressEnter) {
  Assert-ExactSearchForeground
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  Rebase-ExactSearchInputLease
  Start-Sleep -Milliseconds 500
  Assert-ExactSearchForeground
  $resultOpened = $true
}
@{ ok = ([string]::IsNullOrWhiteSpace($resultAutomationId) -or $resultOpened); reason = $(if (-not [string]::IsNullOrWhiteSpace($resultAutomationId) -and -not $resultOpened) { "exact_search_result_not_found" } else { "" }); title = $matched.title; focused = $matched.focused; processName = $matched.processName; pid = $matched.pid; hWnd = $matched.hWnd; exactSearchOpened = [bool]$resultOpened; searchQuery = $query; resultAutomationId = $resultAutomationId } | ConvertTo-Json -Compress
`;

const CLICK_SEARCH_RESULT_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32WechatSearchResultClick {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  public static uint GetLastInputTick() { LASTINPUTINFO info = new LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(info); return GetLastInputInfo(ref info) ? info.dwTime : UInt32.MaxValue; }
}
"@
$expectedHWnd = [int64][Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_HWND")
$expectedPid = [int][Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID")
$expectedInputTick = [uint64][Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_INPUT_TICK")
$clickX = [int][Environment]::GetEnvironmentVariable("XIAOXI_SEARCH_RESULT_X")
$clickY = [int][Environment]::GetEnvironmentVariable("XIAOXI_SEARCH_RESULT_Y")
$foreground = [Win32WechatSearchResultClick]::GetForegroundWindow()
if ($foreground.ToInt64() -ne $expectedHWnd) { @{ ok=$false; reason="wechat_window_not_foreground" } | ConvertTo-Json -Compress; exit }
$currentTick = [uint64][Win32WechatSearchResultClick]::GetLastInputTick()
if ($currentTick -ne $expectedInputTick) { @{ ok=$false; reason="wechat_external_input_detected"; safety_diagnostics=@{ phase="click_search_result"; expected_input_tick=$expectedInputTick; current_input_tick=$currentTick; expected_hWnd=$expectedHWnd; foreground_hWnd=$foreground.ToInt64() } } | ConvertTo-Json -Compress -Depth 4; exit }
$point = New-Object Win32WechatSearchResultClick+POINT; $point.X=$clickX; $point.Y=$clickY
$hit = [Win32WechatSearchResultClick]::WindowFromPoint($point); $root = [Win32WechatSearchResultClick]::GetAncestor($hit, 2)
[uint32]$hitPid=0; [void][Win32WechatSearchResultClick]::GetWindowThreadProcessId($hit, [ref]$hitPid)
if ($root.ToInt64() -ne $expectedHWnd -or [int]$hitPid -ne $expectedPid) { @{ ok=$false; reason="wechat_target_changed" } | ConvertTo-Json -Compress; exit }
[void][Win32WechatSearchResultClick]::SetCursorPos($clickX,$clickY)
[Win32WechatSearchResultClick]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero); [Win32WechatSearchResultClick]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 500
if ([Win32WechatSearchResultClick]::GetForegroundWindow().ToInt64() -ne $expectedHWnd) { @{ ok=$false; reason="wechat_window_not_foreground"; actionAttempted=$true } | ConvertTo-Json -Compress; exit }
@{ ok=$true; pid=$expectedPid; hWnd=$expectedHWnd; exactSearchOpened=$true } | ConvertTo-Json -Compress
`;

function inputWechatSearchQuery(query, context = {}) {
  if (!String(query ?? "").trim()) return { ok: false };
  return runPowerShell(SEARCH_SCRIPT, {
    XIAOXI_SEARCH_QUERY: String(query),
    XIAOXI_EXPECTED_PID: String(context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.hWnd ?? ""),
    XIAOXI_WECHAT_MIN_IDLE_MS: String(context.minIdleMs ?? 0)
  });
}

function runPowerShellAsync(script, env = {}, options = {}) {
  if (unconfirmedPowerShellWorkerCount > 0) {
    return Promise.resolve({
      ok: false,
      reason: "powershell_runtime_quarantined",
      actionAttempted: true
    });
  }
  const ensureResult = options.ensure === false ? {} : ensureWechatWindowVisible();
  const scriptInput = Buffer.from(`${DPI_AWARE_POWERSHELL}\n${script}`, "utf16le").toString("base64");
  const timeout = options.timeout === false ? null : (Number(options.timeout) > 0 ? Number(options.timeout) : 15000);
  const terminationGraceMs = Number(options.terminationGraceMs) > 0
    ? Number(options.terminationGraceMs)
    : 2_000;
  const startedAt = Date.now();
  const signal = options.signal;
  const spawnProcess = typeof options.spawnProcess === "function" ? options.spawnProcess : spawn;
  const shellArgs = ["-NoProfile"];
  if (options.sta === true) shellArgs.push("-STA");
  shellArgs.push("-ExecutionPolicy", "Bypass", "-EncodedCommand", POWERSHELL_STDIN_BOOTSTRAP);

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, reason: "powershell_aborted" });
      return;
    }
    let child;
    try {
      child = spawnProcess("powershell.exe", shellArgs, {
        env: {
          ...process.env,
          XIAOXI_WECHAT_EXE: process.env.XIAOXI_WECHAT_EXE || cachedWechatExecutable,
          ...env,
          XIAOXI_PARENT_PID: String(process.pid),
          ...(options.windowDiagnostics === true ? { XIAOXI_WINDOW_STARTED_AT: String(startedAt) } : {})
        },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      const diagnostics = options.diagnostics === true
        ? { error_code: String(error?.code || "") }
        : undefined;
      resolve({ ok: false, reason: "powershell_failed", ...(diagnostics ? { diagnostics } : {}) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    let terminationTimer = null;
    let terminationReason = "";
    let terminationKillAccepted = false;
    let terminationGraceExceeded = false;
    let quarantineRegistered = false;
    const discoverScans = () => Array.from(stderr.matchAll(/moments_discover_scan:elapsed_ms=(\d+),candidates=(\d+),matches=(\d+)/g))
      .slice(-12).map((match) => ({ elapsed_ms: Number(match[1]), candidates: Number(match[2]), matches: Number(match[3]) }));
    const terminationDiagnostics = (reason) => options.diagnostics === true ? {
      ...readMomentsDiagnostics(stderr, Date.now() - startedAt, timeout),
      timeout_ms: timeout,
      elapsed_ms: Math.max(0, Date.now() - startedAt),
      termination_reason: reason,
      kill_accepted: terminationKillAccepted,
      grace_exceeded: terminationGraceExceeded,
      stdout_bytes: Buffer.byteLength(stdout),
      stderr_bytes: Buffer.byteLength(stderr),
      // Only expose our fixed stage tokens, never arbitrary stderr content.
      navigation_stage: Array.from(stderr.matchAll(/moments_navigation_stage:([a-z_]+)/g)).at(-1)?.[1] || "",
      discover_scans: discoverScans()
    } : undefined;
    const unconfirmedTermination = () => ({
      ok: false,
      reason: "powershell_termination_unconfirmed",
      actionAttempted: true,
      ...(options.diagnostics === true ? { diagnostics: terminationDiagnostics(terminationReason || "powershell_termination_unconfirmed") } : {})
    });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(options.windowDiagnostics === true
        ? { ...value, diagnostics: { ...value.diagnostics, ...readWechatWindowDiagnostics(stderr, Date.now() - startedAt, timeout) } }
        : value);
    };
    const requestTermination = (reason) => {
      if (settled || terminationReason) return;
      terminationReason = reason;
      clearTimeout(timer);
      timer = null;
      try {
        terminationKillAccepted = child.kill() === true;
      } catch {}
      terminationTimer = setTimeout(() => {
        terminationGraceExceeded = true;
        quarantineRegistered = true;
        unconfirmedPowerShellWorkerCount += 1;
        finish(unconfirmedTermination());
      }, terminationGraceMs);
    };
    const onAbort = () => requestTermination("powershell_aborted");
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (terminationReason) return;
      const diagnostics = options.diagnostics === true && options.windowDiagnostics !== true
        ? { error_code: String(error?.code || ""), stderr: stderr.trim().slice(-1200) }
        : undefined;
      finish({ ok: false, reason: "powershell_failed", ...(diagnostics ? { diagnostics } : {}) });
    });
    child.on("close", (status) => {
      if (quarantineRegistered) {
        quarantineRegistered = false;
        unconfirmedPowerShellWorkerCount = Math.max(0, unconfirmedPowerShellWorkerCount - 1);
      }
      if (settled) return;
      if (terminationReason) {
        return finish(terminationKillAccepted && !terminationGraceExceeded
          ? {
              ok: false,
              reason: terminationReason,
              ...(options.diagnostics === true ? { diagnostics: terminationDiagnostics(terminationReason) } : {})
            }
          : unconfirmedTermination());
      }
      if (status !== 0) {
        const diagnostics = options.diagnostics === true && options.windowDiagnostics !== true
          ? { exit_code: status, stderr: stderr.trim().slice(-1200) }
          : undefined;
        return finish({ ok: false, reason: "powershell_failed", ...(diagnostics ? { diagnostics } : {}) });
      }
      try {
        const output = stdout.trim();
        if (!output) return finish({ ok: false, reason: ensureResult?.reason || "powershell_output_invalid" });
        const parsed = JSON.parse(output);
        if (options.diagnostics === true && discoverScans().length > 0) {
          parsed.diagnostics = { ...parsed.diagnostics, discover_scans: discoverScans() };
        }
        if (!parsed.ok && !parsed.reason) return finish({ ...parsed, reason: ensureResult?.reason || "powershell_output_invalid" });
        return finish(parsed);
      } catch {
        return finish(ensureResult?.reason ? { ok: false, reason: ensureResult.reason } : { ok: false, reason: "powershell_output_invalid" });
      }
    });
    child.stdin.on("error", () => undefined);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    timer = timeout === null ? null : setTimeout(() => requestTermination("powershell_timeout"), timeout);
    if (signal?.aborted) onAbort();
    if (!terminationReason) child.stdin.end(scriptInput);
  });
}

function openWechatSearchResult(query, context = {}) {
  if (!String(query ?? "").trim()) return { ok: false };
  const runner = typeof context.runner === "function" ? context.runner : runPowerShell;
  const clickRunner = typeof context.clickRunner === "function" ? context.clickRunner : runner;
  if (context.searchIdentity) {
    const observed = runner(SEARCH_SCRIPT, {
      XIAOXI_SEARCH_QUERY: String(query),
      XIAOXI_OBSERVE_LOCAL_RESULTS: "1",
      XIAOXI_EXPECTED_PID: String(context.pid ?? ""),
      XIAOXI_EXPECTED_HWND: String(context.hWnd ?? ""),
      XIAOXI_WECHAT_MIN_IDLE_MS: String(context.minIdleMs ?? 0)
    }, { ensure: false });
    if (!observed?.ok) return observed || { ok: false, reason: "wechat_operation_failed" };
    const resolution = resolveWechatSearchResultObservation(observed.searchResultObservation, {
      query,
      expectedName: context.searchIdentity.expectedName
    });
    if (resolution.status !== "selected") return { ...observed, ok: false, reason: resolution.reason };
    const clicked = clickRunner(CLICK_SEARCH_RESULT_SCRIPT, {
      XIAOXI_EXPECTED_PID: String(observed.pid ?? context.pid ?? ""),
      XIAOXI_EXPECTED_HWND: String(observed.hWnd ?? context.hWnd ?? ""),
      XIAOXI_EXPECTED_INPUT_TICK: String(observed.inputLeaseTick ?? ""),
      XIAOXI_SEARCH_RESULT_X: String(resolution.candidate.x),
      XIAOXI_SEARCH_RESULT_Y: String(resolution.candidate.y)
    }, { ensure: false });
    return clicked?.ok
      ? { ...observed, ...clicked, searchQuery: String(query), searchResultMode: resolution.mode }
      : clicked;
  }
  return runner(SEARCH_SCRIPT, {
    XIAOXI_SEARCH_QUERY: String(query),
    XIAOXI_PRESS_ENTER: "1",
    XIAOXI_SEARCH_RESULT_AUTOMATION_ID: String(context.resultAutomationId ?? ""),
    XIAOXI_EXPECTED_PID: String(context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.hWnd ?? ""),
    XIAOXI_WECHAT_MIN_IDLE_MS: String(context.minIdleMs ?? 0)
  }, { ensure: false });
}

function openWechatSearchResultAsync(query, context = {}) {
  if (!String(query ?? "").trim()) return Promise.resolve({ ok: false });
  const runner = typeof context.runner === "function" ? context.runner : runPowerShellAsync;
  const clickRunner = typeof context.clickRunner === "function" ? context.clickRunner : runner;
  if (context.searchIdentity) {
    return (async () => {
      const observed = await runner(SEARCH_SCRIPT, {
        XIAOXI_SEARCH_QUERY: String(query),
        XIAOXI_OBSERVE_LOCAL_RESULTS: "1",
        XIAOXI_EXPECTED_PID: String(context.pid ?? ""),
        XIAOXI_EXPECTED_HWND: String(context.hWnd ?? ""),
        XIAOXI_WECHAT_MIN_IDLE_MS: String(context.minIdleMs ?? 0)
      }, { ensure: false });
      if (!observed?.ok) return observed || { ok: false, reason: "wechat_operation_failed" };
      const resolution = resolveWechatSearchResultObservation(observed.searchResultObservation, {
        query,
        expectedName: context.searchIdentity.expectedName
      });
      if (resolution.status !== "selected") return { ...observed, ok: false, reason: resolution.reason };
      const clicked = await clickRunner(CLICK_SEARCH_RESULT_SCRIPT, {
        XIAOXI_EXPECTED_PID: String(observed.pid ?? context.pid ?? ""),
        XIAOXI_EXPECTED_HWND: String(observed.hWnd ?? context.hWnd ?? ""),
        XIAOXI_EXPECTED_INPUT_TICK: String(observed.inputLeaseTick ?? ""),
        XIAOXI_SEARCH_RESULT_X: String(resolution.candidate.x),
        XIAOXI_SEARCH_RESULT_Y: String(resolution.candidate.y)
      }, { ensure: false });
      return clicked?.ok
        ? { ...observed, ...clicked, searchQuery: String(query), searchResultMode: resolution.mode }
        : clicked;
    })();
  }
  return runner(SEARCH_SCRIPT, {
    XIAOXI_SEARCH_QUERY: String(query),
    XIAOXI_PRESS_ENTER: "1",
    XIAOXI_SEARCH_RESULT_AUTOMATION_ID: String(context.resultAutomationId ?? ""),
    XIAOXI_EXPECTED_PID: String(context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.hWnd ?? ""),
    XIAOXI_WECHAT_MIN_IDLE_MS: String(context.minIdleMs ?? 0)
  }, { ensure: false });
}

const CONVERSATION_TITLE_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32WechatConversationTitle {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$expected = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_CONVERSATION")
$expectedPid = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID")
$expectedHwnd = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_HWND")
$exactWindowBinding = -not [string]::IsNullOrWhiteSpace($expectedPid) -and -not [string]::IsNullOrWhiteSpace($expectedHwnd)
if (-not $exactWindowBinding) {
  @{ ok = $false; reason = "wechat_window_identity_missing" } | ConvertTo-Json -Compress
  exit
}
$processNames = @("Weixin", "WeChat")
$matched = $null
$callback = [Win32WechatConversationTitle+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if ($matched -ne $null) { return $true }
  if ([Win32WechatConversationTitle]::IsWindowVisible($hWnd)) {
    $text = New-Object System.Text.StringBuilder 512
    [void][Win32WechatConversationTitle]::GetWindowText($hWnd, $text, $text.Capacity)
    $title = $text.ToString().Trim()
    $rect = New-Object Win32WechatConversationTitle+RECT
    [void][Win32WechatConversationTitle]::GetWindowRect($hWnd, [ref]$rect)
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    [uint32]$windowProcessId = 0
    [void][Win32WechatConversationTitle]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
    $proc = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
    $matchesExpected = ([string]::IsNullOrWhiteSpace($expectedPid) -or [string]$windowProcessId -eq $expectedPid) -and ([string]::IsNullOrWhiteSpace($expectedHwnd) -or [string]$hWnd.ToInt64() -eq $expectedHwnd)
    if ($proc -and $matchesExpected -and $processNames -contains $proc.ProcessName -and $w -ge 600 -and $h -ge 500) {
      $script:matched = @{ hWnd = $hWnd; title = $title; rect = $rect; processName = $proc.ProcessName; pid = $windowProcessId; focused = ([Win32WechatConversationTitle]::GetForegroundWindow() -eq $hWnd) }
    }
  }
  return $true
}
[void][Win32WechatConversationTitle]::EnumWindows($callback, [IntPtr]::Zero)
if ($matched -eq $null -or [string]::IsNullOrWhiteSpace($expected)) {
  @{ ok = $false; reason = "window_or_expected_missing" } | ConvertTo-Json -Compress
  exit
}
if (-not $matched.focused) {
  @{ ok = $false; reason = "wechat_window_not_foreground"; processName = $matched.processName; pid = $matched.pid; hWnd = $matched.hWnd.ToInt64() } | ConvertTo-Json -Compress
  exit
}
Start-Sleep -Milliseconds 300
$root = [System.Windows.Automation.AutomationElement]::FromHandle($matched.hWnd)
if ($root -eq $null) {
  @{ ok = $false; title = $matched.title; reason = "automation_root_missing" } | ConvertTo-Json -Compress
  exit
}
$windowRect = $matched.rect
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$found = $null
$unavailable = $null
for ($i = 0; $i -lt $all.Count; $i++) {
  $item = $all.Item($i)
  $name = $item.Current.Name
  if ([string]::IsNullOrWhiteSpace($name)) { continue }
  $rect = $item.Current.BoundingRectangle
  $inRightHeader = $rect.Left -ge ($windowRect.Left + 260) -and $rect.Top -ge ($windowRect.Top + 30) -and $rect.Top -le ($windowRect.Top + 120)
  if ($inRightHeader -and @("已停用的微信用户", "已停用微信用户", "该微信用户已停用") -contains $name.Trim()) {
    $unavailable = $name.Trim()
    break
  }
  if ($name.Trim() -ne $expected.Trim()) { continue }
  if ($inRightHeader) {
    $found = $name
    break
  }
}
if ($unavailable -ne $null) {
  @{ ok = $false; reason = "contact_unavailable"; title = $unavailable; windowTitle = $matched.title; processName = $matched.processName; pid = $matched.pid; hWnd = $matched.hWnd.ToInt64() } | ConvertTo-Json -Compress
} else {
  @{ ok = ($found -ne $null); title = $found; windowTitle = $matched.title; processName = $matched.processName; pid = $matched.pid; hWnd = $matched.hWnd.ToInt64() } | ConvertTo-Json -Compress
}
`;

function verifyWechatCurrentConversation(expectedTitle, context = {}) {
  if (!String(expectedTitle ?? "").trim()) return { ok: false };
  return runPowerShell(CONVERSATION_TITLE_SCRIPT, {
    XIAOXI_EXPECTED_CONVERSATION: String(expectedTitle),
    XIAOXI_EXPECTED_PID: String(context.expectedPid ?? context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.expectedHWnd ?? context.hWnd ?? "")
  }, { ensure: false });
}

function verifyWechatCurrentConversationAsync(expectedTitle, context = {}) {
  if (!String(expectedTitle ?? "").trim()) return Promise.resolve({ ok: false });
  return runPowerShellAsync(CONVERSATION_TITLE_SCRIPT, {
    XIAOXI_EXPECTED_CONVERSATION: String(expectedTitle),
    XIAOXI_EXPECTED_PID: String(context.expectedPid ?? context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.expectedHWnd ?? context.hWnd ?? "")
  }, { ensure: false });
}

const MESSAGE_DRAFT_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
${WECHAT_CLIPBOARD_POWERSHELL}
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32WechatMessageDraft {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  public static uint GetLastInputTick() {
    LASTINPUTINFO info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    return GetLastInputInfo(ref info) ? info.dwTime : UInt32.MaxValue;
  }
}
"@
$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004
$message = [Environment]::GetEnvironmentVariable("XIAOXI_MESSAGE_DRAFT")
$expectedPid = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID")
$expectedHwnd = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_HWND")
$exactWindowBinding = -not [string]::IsNullOrWhiteSpace($expectedPid) -and -not [string]::IsNullOrWhiteSpace($expectedHwnd)
if (-not $exactWindowBinding) {
  @{ ok = $false; reason = "wechat_window_identity_missing" } | ConvertTo-Json -Compress
  exit
}
$script:draftInputLeaseActive = $false
$script:draftInputLeaseTick = [uint32]::MaxValue
$script:draftClipboardCaptured = $false
$script:draftOldClipboard = ""
$script:draftOwnedClipboardValue = $null
$script:draftInputPhase = "pre_input"

function Set-DraftInputPhase([string]$phase) {
  $script:draftInputPhase = if ([string]::IsNullOrWhiteSpace($phase)) { "input_message" } else { $phase }
}

function Restore-DraftClipboardIfOwned {
  if (-not $script:draftClipboardCaptured -or -not $exactWindowBinding -or
      $null -eq $script:draftOwnedClipboardValue -or $matched -eq $null -or
      [Win32WechatMessageDraft]::GetForegroundWindow() -ne $matched.hWnd) { return }
  if ($script:draftInputLeaseActive -and [Win32WechatMessageDraft]::GetLastInputTick() -ne $script:draftInputLeaseTick) { return }
  try {
    if ([System.Windows.Forms.Clipboard]::ContainsImage() -or
        [System.Windows.Forms.Clipboard]::ContainsFileDropList() -or
        [System.Windows.Forms.Clipboard]::ContainsAudio() -or
        -not [System.Windows.Forms.Clipboard]::ContainsText([System.Windows.Forms.TextDataFormat]::UnicodeText)) { return }
    $currentClipboard = [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText)
    if ($currentClipboard -ceq [string]$script:draftOwnedClipboardValue) {
      Restore-WechatClipboardSnapshot $script:draftOldClipboard
      $script:draftOwnedClipboardValue = $null
    }
  } catch {}
}

function Stop-DraftForActiveUser {
  Restore-DraftClipboardIfOwned
  $currentInputTick = [Win32WechatMessageDraft]::GetLastInputTick()
  $foregroundHWnd = [Win32WechatMessageDraft]::GetForegroundWindow()
  $safety = @{
    phase = [string]$script:draftInputPhase
    expected_input_tick = [uint64]$script:draftInputLeaseTick
    current_input_tick = [uint64]$currentInputTick
    expected_hWnd = [int64]$matched.hWnd.ToInt64()
    foreground_hWnd = [int64]$foregroundHWnd.ToInt64()
  }
  @{ ok = $false; reason = "wechat_user_active"; pid = $matched.pid; hWnd = $matched.hWnd.ToInt64(); safety_diagnostics = $safety } | ConvertTo-Json -Compress
  exit
}

function Assert-ExactDraftLease {
  if ($exactWindowBinding -and (
      [Win32WechatMessageDraft]::GetForegroundWindow() -ne $matched.hWnd -or
      ($script:draftInputLeaseActive -and [Win32WechatMessageDraft]::GetLastInputTick() -ne $script:draftInputLeaseTick))) {
    Stop-DraftForActiveUser
  }
}

function Rebase-ExactDraftInputLease {
  if ($exactWindowBinding) {
    $script:draftInputLeaseTick = [Win32WechatMessageDraft]::GetLastInputTick()
    if ($script:draftInputLeaseTick -eq [uint32]::MaxValue) { Stop-DraftForActiveUser }
    $script:draftInputLeaseActive = $true
  }
}

function Normalize-WechatDraftText([string]$value) {
  $normalized = ([string]$value).Replace([Environment]::NewLine, [string][char]10)
  $normalized = $normalized.Replace([string][char]13, [string][char]10)
  return $normalized.TrimEnd([char[]]@([char]0xFFFC))
}

$normalizedMessage = Normalize-WechatDraftText $message
  $processNames = @("Weixin", "WeChat")
$matched = $null
$callback = [Win32WechatMessageDraft+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if ($matched -ne $null) { return $true }
  if ([Win32WechatMessageDraft]::IsWindowVisible($hWnd)) {
    $text = New-Object System.Text.StringBuilder 512
    [void][Win32WechatMessageDraft]::GetWindowText($hWnd, $text, $text.Capacity)
    $title = $text.ToString().Trim()
    $rect = New-Object Win32WechatMessageDraft+RECT
    [void][Win32WechatMessageDraft]::GetWindowRect($hWnd, [ref]$rect)
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    [uint32]$windowProcessId = 0
    [void][Win32WechatMessageDraft]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
    $proc = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
    $matchesExpected = ([string]::IsNullOrWhiteSpace($expectedPid) -or [string]$windowProcessId -eq $expectedPid) -and ([string]::IsNullOrWhiteSpace($expectedHwnd) -or [string]$hWnd.ToInt64() -eq $expectedHwnd)
    if ($proc -and $matchesExpected -and $processNames -contains $proc.ProcessName -and $w -ge 600 -and $h -ge 500) {
      $focused = [Win32WechatMessageDraft]::GetForegroundWindow() -eq $hWnd
      $script:matched = @{ hWnd = $hWnd; title = $title; focused = $focused; processName = $proc.ProcessName; pid = [int]$windowProcessId }
    }
  }
  return $true
}
[void][Win32WechatMessageDraft]::EnumWindows($callback, [IntPtr]::Zero)
if ($matched -eq $null) {
  @{ ok = $false } | ConvertTo-Json -Compress
  exit
}
if (-not $matched.focused) {
  @{ ok = $false; reason = "wechat_window_not_foreground"; title = $matched.title; processName = $matched.processName; pid = $matched.pid; hWnd = $matched.hWnd.ToInt64() } | ConvertTo-Json -Compress
  exit
}
$script:draftInputLeaseTick = [Win32WechatMessageDraft]::GetLastInputTick()
$script:draftInputLeaseActive = $exactWindowBinding
if ($exactWindowBinding -and $script:draftInputLeaseTick -eq [uint32]::MaxValue) { Stop-DraftForActiveUser }
Start-Sleep -Milliseconds 300
Assert-ExactDraftLease
try {
  $oldClipboard = Get-WechatClipboardSnapshot
} catch {
  @{ ok = $false; reason = $(if ($_.Exception.Message -eq "wechat_clipboard_restore_unsupported") { "wechat_clipboard_restore_unsupported" } else { "wechat_clipboard_read_failed" }); pid = $matched.pid; hWnd = $matched.hWnd.ToInt64() } | ConvertTo-Json -Compress
  exit
}
$ownedClipboardValue = $null
$script:draftOldClipboard = $oldClipboard
$script:draftClipboardCaptured = $true
$draftVerified = $false
$draftCheck = "clipboard_roundtrip"
$attemptUsed = 0
$usedPoint = $null
$inputPoints = @(
  @{ xRatio = 0.65; yRatio = 0.84 },
  @{ xRatio = 0.65; yRatio = 0.88 },
  @{ xRatio = 0.65; yRatio = 0.92 }
)
for ($attempt = 1; $attempt -le $inputPoints.Count; $attempt++) {
  $attemptUsed = $attempt
  Set-DraftInputPhase "pre_input"
  $point = $inputPoints[$attempt - 1]
  Start-Sleep -Milliseconds (200 + (150 * $attempt))
  Assert-ExactDraftLease
  if ([Win32WechatMessageDraft]::GetForegroundWindow() -ne $matched.hWnd) {
    $draftCheck = "wechat_window_not_foreground"
    if ($exactWindowBinding) { break }
    continue
  }
  $rect = New-Object Win32WechatMessageDraft+RECT
  if (-not [Win32WechatMessageDraft]::GetWindowRect($matched.hWnd, [ref]$rect)) {
    $draftCheck = "message_input_rect_missing"
    continue
  }
  $x = [int]($rect.Left + (($rect.Right - $rect.Left) * $point.xRatio))
  $y = [int]($rect.Top + (($rect.Bottom - $rect.Top) * $point.yRatio))
  $targetPoint = New-Object Win32WechatMessageDraft+POINT
  $targetPoint.X = $x
  $targetPoint.Y = $y
  $hit = [Win32WechatMessageDraft]::WindowFromPoint($targetPoint)
  $hitRoot = [Win32WechatMessageDraft]::GetAncestor($hit, 2)
  [uint32]$hitPid = 0
  [void][Win32WechatMessageDraft]::GetWindowThreadProcessId($hit, [ref]$hitPid)
  if ($hitRoot -ne $matched.hWnd -or [int]$hitPid -ne [int]$matched.pid -or
    [Win32WechatMessageDraft]::GetForegroundWindow() -ne $matched.hWnd) {
    $draftCheck = "message_input_target_not_owned"
    if ($exactWindowBinding) { break }
    continue
  }
  [void][Win32WechatMessageDraft]::SetCursorPos($x, $y)
  $cursorPoint = New-Object Win32WechatMessageDraft+POINT
  [void][Win32WechatMessageDraft]::GetCursorPos([ref]$cursorPoint)
  $cursorHit = [Win32WechatMessageDraft]::WindowFromPoint($cursorPoint)
  $cursorRoot = [Win32WechatMessageDraft]::GetAncestor($cursorHit, 2)
  [uint32]$cursorPid = 0
  [void][Win32WechatMessageDraft]::GetWindowThreadProcessId($cursorHit, [ref]$cursorPid)
  if ($cursorRoot -ne $matched.hWnd -or [int]$cursorPid -ne [int]$matched.pid -or
      [Win32WechatMessageDraft]::GetForegroundWindow() -ne $matched.hWnd) {
    $draftCheck = "message_input_target_not_owned"
    if ($exactWindowBinding) { break }
    continue
  }
  [Win32WechatMessageDraft]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 50
  [Win32WechatMessageDraft]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  Rebase-ExactDraftInputLease
  Set-DraftInputPhase "after_input_click"
  Start-Sleep -Milliseconds (200 + (150 * $attempt))
  Assert-ExactDraftLease
  if ([Win32WechatMessageDraft]::GetForegroundWindow() -ne $matched.hWnd) {
    $draftCheck = "wechat_window_not_foreground"
    if ($exactWindowBinding) { break }
    continue
  }
  try {
    Set-DraftInputPhase "typing"
    Assert-ExactDraftLease
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Rebase-ExactDraftInputLease
    Start-Sleep -Milliseconds 100
    Assert-ExactDraftLease
    Set-Clipboard -Value $message
    $ownedClipboardValue = [string]$message
    $script:draftOwnedClipboardValue = $ownedClipboardValue
    Start-Sleep -Milliseconds 100
    Assert-ExactDraftLease
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Rebase-ExactDraftInputLease
    Set-DraftInputPhase "after_paste"
  } catch {
    $draftCheck = "clipboard_write_or_paste_failed"
    continue
  }
  Start-Sleep -Milliseconds (350 + (250 * $attempt))
  Assert-ExactDraftLease
  if ([Win32WechatMessageDraft]::GetForegroundWindow() -ne $matched.hWnd) {
    $draftCheck = "wechat_focus_lost_after_paste"
    continue
  }
  try {
    Set-DraftInputPhase "copy_probe"
    $probe = "__XIAOXI_DRAFT_PROBE_" + [Guid]::NewGuid().ToString("N")
    Set-Clipboard -Value $probe
    $ownedClipboardValue = [string]$probe
    $script:draftOwnedClipboardValue = $ownedClipboardValue
    Assert-ExactDraftLease
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Rebase-ExactDraftInputLease
    Start-Sleep -Milliseconds 100
    Assert-ExactDraftLease
    [System.Windows.Forms.SendKeys]::SendWait("^c")
    Rebase-ExactDraftInputLease
    Start-Sleep -Milliseconds (250 + (150 * $attempt))
    Assert-ExactDraftLease
    $copiedDraft = [string](Get-Clipboard -Raw -ErrorAction Stop)
    $normalizedCopiedDraft = Normalize-WechatDraftText $copiedDraft
    if ($normalizedCopiedDraft -ceq $normalizedMessage) {
      $ownedClipboardValue = $copiedDraft
      $script:draftOwnedClipboardValue = $copiedDraft
      $draftVerified = $true
      $draftCheck = "clipboard_roundtrip"
    } elseif ($normalizedCopiedDraft -ceq (Normalize-WechatDraftText $probe)) {
      $ownedClipboardValue = $copiedDraft
      $script:draftOwnedClipboardValue = $copiedDraft
      $draftCheck = "message_input_empty_or_copy_blocked"
    } else {
      $draftCheck = "message_input_content_mismatch"
    }
  } catch { $draftCheck = "clipboard_roundtrip_failed" }
  if ($draftVerified) {
    $usedPoint = $point
    break
  }
}
Restore-DraftClipboardIfOwned
@{ ok = $true; title = $matched.title; focused = $matched.focused; processName = $matched.processName; draftVerified = $draftVerified; draftCheck = $draftCheck; draftAttempts = $attemptUsed; draftPoint = $usedPoint } | ConvertTo-Json -Compress
`;

function inputWechatMessageDraft(message, context = {}) {
  if (!String(message ?? "").trim()) return { ok: false };
  return runPowerShell(MESSAGE_DRAFT_SCRIPT, {
    XIAOXI_MESSAGE_DRAFT: String(message),
    XIAOXI_EXPECTED_PID: String(context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.hWnd ?? "")
  }, { ensure: false });
}

function inputWechatMessageDraftAsync(message, context = {}) {
  if (!String(message ?? "").trim()) return Promise.resolve({ ok: false });
  return runPowerShellAsync(MESSAGE_DRAFT_SCRIPT, {
    XIAOXI_MESSAGE_DRAFT: String(message),
    XIAOXI_EXPECTED_PID: String(context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.hWnd ?? "")
  }, { ensure: false });
}

module.exports = {
  NORMALIZE_WECHAT_WINDOW_SCRIPT,
  WECHAT_MAIN_WINDOW_RULES_SCRIPT,
  WECHAT_MOMENTS_STANDALONE_WINDOW_LAYOUT_MODE,
  WECHAT_RPA_BACKGROUND_MIN_IDLE_MS,
  WECHAT_RPA_WINDOW_LAYOUTS,
  WECHAT_RPA_WINDOW_LAYOUT_MODE,
  focusWechatWindow,
  focusWechatWindowAsync,
  focusExactWechatRpaSurfaceAsync,
  inspectForegroundWechatMainWindow,
  inspectForegroundWechatRpaSurface,
  inputWechatMessageDraft,
  inputWechatMessageDraftAsync,
  inputWechatSearchQuery,
  isPreparedWechatRpaLayout,
  normalizeWechatMainWindow,
  normalizeWechatMainWindowAsync,
  prepareWechatRpaWindow,
  prepareWechatRpaWindowAsync,
  resolveWechatRpaWindowTarget,
  openWechatSearchResult,
  openWechatSearchResultAsync,
  runPowerShell,
  runPowerShellAsync,
  verifyWechatCurrentConversation,
  verifyWechatCurrentConversationAsync
};
