const { spawn, spawnSync } = require("node:child_process");
const { findWechatExecutable } = require("../contact_sync/contact_sync_cli.cjs");

let cachedWechatExecutable = "";
let cachedWechatExecutableAt = 0;

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
public static class Win32XiaoxiDpiContext {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
}
"@
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
    env: { ...process.env, XIAOXI_WECHAT_EXE: wechatExecutableForLaunch() },
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
  const ensureResult = options.ensure === false ? {} : ensureWechatWindowVisible();
  const scriptInput = Buffer.from(`${DPI_AWARE_POWERSHELL}\n${script}`, "utf16le").toString("base64");
  const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : 15000;
  const shellArgs = ["-NoProfile"];
  if (options.sta === true) shellArgs.push("-STA");
  shellArgs.push("-ExecutionPolicy", "Bypass", "-EncodedCommand", POWERSHELL_STDIN_BOOTSTRAP);
  const spawnOptions = {
    encoding: "utf8",
    env: { ...process.env, XIAOXI_WECHAT_EXE: process.env.XIAOXI_WECHAT_EXE || cachedWechatExecutable, ...env },
    input: scriptInput,
    windowsHide: true
  };
  spawnOptions.timeout = timeout;
  const result = spawnSync("powershell.exe", shellArgs, spawnOptions);

  if (result.error) {
    return { ok: false, reason: result.error.code === "ETIMEDOUT" ? "powershell_timeout" : "powershell_failed" };
  }
  if (result.status !== 0) {
    const diagnostics = options.diagnostics === true
      ? { stderr: String(result.stderr ?? "").trim().slice(-1200) }
      : undefined;
    return { ok: false, reason: "powershell_failed", ...(diagnostics ? { diagnostics } : {}) };
  }

  try {
    const stdout = result.stdout.trim();
    if (!stdout) return { ok: false, reason: ensureResult?.reason || "powershell_output_invalid" };
    const parsed = JSON.parse(stdout);
    if (!parsed.ok && !parsed.reason) return { ...parsed, reason: ensureResult?.reason || "powershell_output_invalid" };
    return parsed;
  } catch {
    return { ok: false, reason: ensureResult?.reason || "powershell_output_invalid" };
  }
}

// Keep one logical WeChat work area across display scaling settings. The
// PowerShell normalizer converts these device-independent pixels to the
// target window's physical pixels (880x560 becomes 1100x700 at 125% DPI).
const WECHAT_STABLE_WINDOW_LAYOUT = Object.freeze({ width: 880, height: 560 });

const NORMALIZE_WECHAT_WINDOW_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32WechatWindow {
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
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT placement);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
try { [void][Win32WechatWindow]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch {}
$expectedPid = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID")
$expectedHWnd = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_HWND")
$targetWidthText = [Environment]::GetEnvironmentVariable("XIAOXI_WECHAT_WINDOW_WIDTH")
$targetHeightText = [Environment]::GetEnvironmentVariable("XIAOXI_WECHAT_WINDOW_HEIGHT")
$targetWidth = 0
$targetHeight = 0
if (-not [int]::TryParse($targetWidthText, [ref]$targetWidth) -or $targetWidth -lt 600) {
  @{ ok = $false; reason = "wechat_window_not_ready" } | ConvertTo-Json -Compress
  exit
}
if (-not [int]::TryParse($targetHeightText, [ref]$targetHeight) -or $targetHeight -lt 500) {
  @{ ok = $false; reason = "wechat_window_not_ready" } | ConvertTo-Json -Compress
  exit
}
$processNames = @("Weixin", "WeChat")
$matches = New-Object System.Collections.Generic.List[object]
function Get-WechatWindowCandidate([IntPtr]$hWnd, [bool]$exactExpectedHandle) {
  if (-not [Win32WechatWindow]::IsWindow($hWnd)) { return $null }
  [uint32]$windowProcessId = 0
  [void][Win32WechatWindow]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
  $proc = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
  if (-not $proc -or $processNames -notcontains $proc.ProcessName) { return $null }
  if (-not [string]::IsNullOrWhiteSpace($expectedPid) -and [string]$windowProcessId -ne $expectedPid) { return $null }
  if (-not $exactExpectedHandle -and -not [Win32WechatWindow]::IsWindowVisible($hWnd)) { return $null }

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
  $style = [uint32]([int64][Win32WechatWindow]::GetWindowLong($hWnd, -16) -band 4294967295L)
  $exStyle = [uint32]([int64][Win32WechatWindow]::GetWindowLong($hWnd, -20) -band 4294967295L)
  $classRank = if ($className -ieq "mmui::MainWindow") { 3 } elseif ($className -match "(?i)MainWindow") { 2 } else { 0 }
  $aspectRatio = [double]$w / [Math]::Max(1, $h)
  $layoutRank = if ($w -ge 720 -and $h -ge 500 -and $aspectRatio -ge 1.15) { 2 } elseif ($w -ge 600 -and $h -ge 500) { 1 } else { 0 }
  $styleRank = 0
  if (($style -band [uint32]0x00040000) -ne 0) { $styleRank += 2 }
  if (($style -band [uint32]0x00080000) -ne 0) { $styleRank += 1 }
  if (($exStyle -band [uint32]0x00000080) -eq 0) { $styleRank += 1 }
  # WeChat 4.x window classes and Win32 styles vary across machines and patch
  # releases. Process ownership, top-level visibility and main-window geometry
  # are sufficient for discovery; class/style evidence only ranks candidates.
  if (-not $exactExpectedHandle -and $layoutRank -eq 0) { return $null }

  return @{
    hWnd = $hWnd
    title = $title
    windowClass = $className
    processName = $proc.ProcessName
    pid = $windowProcessId
    width = $w
    height = $h
    currentWidth = $currentWidth
    currentHeight = $currentHeight
    normalWidth = $normalWidth
    normalHeight = $normalHeight
    minimized = [bool]$minimized
    exactExpectedHandle = [bool]$exactExpectedHandle
    classRank = $classRank
    layoutRank = $layoutRank
    styleRank = $styleRank
    area = [int64]$w * [int64]$h
  }
}

$expectedHandleWasProvided = -not [string]::IsNullOrWhiteSpace($expectedHWnd)
$expectedHandleValue = [int64]0
$expectedHandleIsValid = $expectedHandleWasProvided -and [int64]::TryParse($expectedHWnd, [ref]$expectedHandleValue) -and $expectedHandleValue -ne 0 -and [Win32WechatWindow]::IsWindow([IntPtr]$expectedHandleValue)
if ($expectedHandleIsValid) {
  $expectedCandidate = Get-WechatWindowCandidate ([IntPtr]$expectedHandleValue) $true
  if (-not $expectedCandidate) {
    @{ ok = $false; reason = "wechat_window_identity_mismatch" } | ConvertTo-Json -Compress
    exit
  }
  [void]$matches.Add($expectedCandidate)
}
$callback = [Win32WechatWindow+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if ($expectedHandleIsValid) { return $true }
  $candidate = Get-WechatWindowCandidate $hWnd $false
  if ($candidate) { [void]$matches.Add($candidate) }
  return $true
}
if (-not $expectedHandleIsValid) { [void][Win32WechatWindow]::EnumWindows($callback, [IntPtr]::Zero) }
if ($matches.Count -eq 0) {
  @{ ok = $false; reason = "personal_wechat_main_window_not_found" } | ConvertTo-Json -Compress
  exit
}
if ($matches.Count -gt 1) {
  $sortRules = @(
    @{ Expression = "classRank"; Descending = $true }
    @{ Expression = "layoutRank"; Descending = $true }
    @{ Expression = "styleRank"; Descending = $true }
    @{ Expression = "area"; Descending = $true }
  )
  $ordered = @($matches.ToArray() | Sort-Object -Property $sortRules)
  $best = $ordered[0]
  $equivalent = @($ordered | Where-Object {
    $_.classRank -eq $best.classRank -and
    $_.layoutRank -eq $best.layoutRank -and
    $_.styleRank -eq $best.styleRank -and
    [int64]$_.area -eq [int64]$best.area
  })
  if ($equivalent.Count -eq 1) {
    $matches = New-Object System.Collections.Generic.List[object]
    [void]$matches.Add($best)
  }
}
if ($matches.Count -gt 1) {
  @{ ok = $false; reason = "wechat_window_ambiguous" } | ConvertTo-Json -Compress
  exit
}
$matched = $matches[0]
$hWnd = [IntPtr]$matched.hWnd
if ([Win32WechatWindow]::IsIconic($hWnd) -or -not [Win32WechatWindow]::IsWindowVisible($hWnd)) {
  [void][Win32WechatWindow]::ShowWindowAsync($hWnd, 9)
  Start-Sleep -Milliseconds 120
}
$restoredRect = New-Object Win32WechatWindow+RECT
$restoredRectAvailable = [Win32WechatWindow]::GetWindowRect($hWnd, [ref]$restoredRect)
$restoredMainLayout = $restoredRectAvailable -and [Win32WechatWindow]::IsWindowVisible($hWnd) -and -not [Win32WechatWindow]::IsIconic($hWnd) -and
  ($restoredRect.Right - $restoredRect.Left) -ge 600 -and ($restoredRect.Bottom - $restoredRect.Top) -ge 500
if (-not $restoredMainLayout) {
  @{ ok = $false; reason = "wechat_window_not_ready"; pid = $matched.pid; hWnd = $hWnd.ToInt64() } | ConvertTo-Json -Compress
  exit
}
$workArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$movedToTargetDisplay = [Win32WechatWindow]::SetWindowPos($hWnd, [IntPtr]::Zero, $workArea.Left, $workArea.Top, 0, 0, 0x0005)
Start-Sleep -Milliseconds 120
$dpi = [uint32]96
try {
  $windowDpi = [Win32WechatWindow]::GetDpiForWindow($hWnd)
  if ($windowDpi -ge 72 -and $windowDpi -le 480) { $dpi = $windowDpi }
} catch {}
$dpiScale = [double]$dpi / 96.0
$width = [Math]::Min([int][Math]::Round($targetWidth * $dpiScale), $workArea.Width)
$height = [Math]::Min([int][Math]::Round($targetHeight * $dpiScale), $workArea.Height)
$positioned = $movedToTargetDisplay -and [Win32WechatWindow]::SetWindowPos($hWnd, [IntPtr]::Zero, $workArea.Left, $workArea.Top, $width, $height, 0x0004)
$focused = [Win32WechatWindow]::GetForegroundWindow() -eq $hWnd
if (-not $focused) {
  $focusRequested = [Win32WechatWindow]::SetForegroundWindow($hWnd)
  if (-not $focusRequested) { try { $focusRequested = (New-Object -ComObject WScript.Shell).AppActivate([int]$matched.pid) } catch {} }
  Start-Sleep -Milliseconds 120
  $focused = [Win32WechatWindow]::GetForegroundWindow() -eq $hWnd
}
$rect = New-Object Win32WechatWindow+RECT
$rectAvailable = [Win32WechatWindow]::GetWindowRect($hWnd, [ref]$rect)
$targetLayoutVerified = $positioned -and $rectAvailable -and
  [Math]::Abs($rect.Left - $workArea.Left) -le 3 -and [Math]::Abs($rect.Top - $workArea.Top) -le 3 -and
  [Math]::Abs(($rect.Right - $rect.Left) - $width) -le 3 -and [Math]::Abs(($rect.Bottom - $rect.Top) - $height) -le 3
$usableCurrentLayout = $rectAvailable -and [Win32WechatWindow]::IsWindowVisible($hWnd) -and
  -not [Win32WechatWindow]::IsIconic($hWnd) -and
  ($rect.Right - $rect.Left) -ge 600 -and ($rect.Bottom - $rect.Top) -ge 500
if (-not $usableCurrentLayout) {
  @{ ok = $false; reason = "wechat_window_not_ready"; pid = $matched.pid; hWnd = $hWnd.ToInt64() } | ConvertTo-Json -Compress
  exit
}
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

function normalizeWechatMainWindow(context = {}, runner = runPowerShell) {
  return runner(NORMALIZE_WECHAT_WINDOW_SCRIPT, {
    XIAOXI_WECHAT_EXE: wechatExecutableForLaunch(),
    XIAOXI_EXPECTED_PID: String(context.expectedPid ?? context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.expectedHWnd ?? context.hWnd ?? ""),
    XIAOXI_WECHAT_WINDOW_WIDTH: String(WECHAT_STABLE_WINDOW_LAYOUT.width),
    XIAOXI_WECHAT_WINDOW_HEIGHT: String(WECHAT_STABLE_WINDOW_LAYOUT.height)
  // This script already discovers, restores and positions the real top-level
  // HWND; focus is best-effort because observation does not require foreground.
  // top-level HWND. Do not run the legacy MainWindowHandle detector first: on
  // WeChat 4.x it can report 0 and it also causes an avoidable pre-scan reflow.
  }, { ensure: false, timeout: 10_000 });
}

function normalizeWechatMainWindowAsync(context = {}, runner = runPowerShellAsync) {
  return Promise.resolve(normalizeWechatMainWindow(context, runner));
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
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$query = [Environment]::GetEnvironmentVariable("XIAOXI_SEARCH_QUERY")
$pressEnter = [Environment]::GetEnvironmentVariable("XIAOXI_PRESS_ENTER") -eq "1"
$resultAutomationId = [Environment]::GetEnvironmentVariable("XIAOXI_SEARCH_RESULT_AUTOMATION_ID")
$expectedPid = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID")
$expectedHwnd = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_HWND")
  $processNames = @("Weixin", "WeChat")
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
      [void][Win32WechatWindowSearch]::ShowWindowAsync($hWnd, 9)
      $focused = [Win32WechatWindowSearch]::SetForegroundWindow($hWnd)
      if (-not $focused) { try { $focused = (New-Object -ComObject WScript.Shell).AppActivate([int]$windowProcessId) } catch {} }
      Start-Sleep -Milliseconds 200
      $focused = $focused -or ([Win32WechatWindowSearch]::GetForegroundWindow() -eq $hWnd)
      $script:matched = @{ title = $title; focused = $focused; processName = $proc.ProcessName; pid = [int]$windowProcessId; hWnd = $hWnd.ToInt64() }
    }
  }
  return $true
}
[void][Win32WechatWindowSearch]::EnumWindows($callback, [IntPtr]::Zero)
if ($matched -eq $null) {
  @{ ok = $false } | ConvertTo-Json -Compress
  exit
}
if (-not $matched.focused) {
  @{ ok = $false; reason = "wechat_focus_failed"; title = $matched.title; processName = $matched.processName } | ConvertTo-Json -Compress
  exit
}
Start-Sleep -Milliseconds 300
$oldClipboard = ""
try { $oldClipboard = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
Set-Clipboard -Value $query
[System.Windows.Forms.SendKeys]::SendWait("^f")
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 50
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 300
$resultOpened = $false
if (-not [string]::IsNullOrWhiteSpace($resultAutomationId)) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$matched.hWnd)
  for ($attempt = 0; $attempt -lt 5 -and -not $resultOpened; $attempt++) {
    if ($root -ne $null) {
      $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      for ($i = 0; $i -lt $all.Count; $i++) {
        $item = $all.Item($i)
        if ($item.Current.AutomationId -ne $resultAutomationId -or $item.Current.IsOffscreen) { continue }
        $itemRect = $item.Current.BoundingRectangle
        if ($itemRect.Width -le 10 -or $itemRect.Height -le 10) { continue }
        [void][Win32WechatWindowSearch]::SetCursorPos(
          [int]($itemRect.Left + ($itemRect.Width / 2)),
          [int]($itemRect.Top + ($itemRect.Height / 2))
        )
        [Win32WechatWindowSearch]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [Win32WechatWindowSearch]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        $resultOpened = $true
        Start-Sleep -Milliseconds 500
        break
      }
    }
    if (-not $resultOpened) { Start-Sleep -Milliseconds 250 }
  }
} elseif ($pressEnter) {
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  Start-Sleep -Milliseconds 500
  $resultOpened = $true
}
try { Set-Clipboard -Value $oldClipboard } catch {}
@{ ok = ([string]::IsNullOrWhiteSpace($resultAutomationId) -or $resultOpened); reason = $(if (-not [string]::IsNullOrWhiteSpace($resultAutomationId) -and -not $resultOpened) { "exact_search_result_not_found" } else { "" }); title = $matched.title; focused = $matched.focused; processName = $matched.processName; pid = $matched.pid; hWnd = $matched.hWnd; exactSearchOpened = [bool]$resultOpened; searchQuery = $query; resultAutomationId = $resultAutomationId } | ConvertTo-Json -Compress
`;

function inputWechatSearchQuery(query, context = {}) {
  if (!String(query ?? "").trim()) return { ok: false };
  return runPowerShell(SEARCH_SCRIPT, {
    XIAOXI_SEARCH_QUERY: String(query),
    XIAOXI_EXPECTED_PID: String(context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.hWnd ?? "")
  });
}

function runPowerShellAsync(script, env = {}, options = {}) {
  const ensureResult = options.ensure === false ? {} : ensureWechatWindowVisible();
  const scriptInput = Buffer.from(`${DPI_AWARE_POWERSHELL}\n${script}`, "utf16le").toString("base64");
  const timeout = options.timeout === false ? null : (Number(options.timeout) > 0 ? Number(options.timeout) : 15000);
  const shellArgs = ["-NoProfile"];
  if (options.sta === true) shellArgs.push("-STA");
  shellArgs.push("-ExecutionPolicy", "Bypass", "-EncodedCommand", POWERSHELL_STDIN_BOOTSTRAP);

  return new Promise((resolve) => {
    const child = spawn("powershell.exe", shellArgs, {
      env: { ...process.env, XIAOXI_WECHAT_EXE: process.env.XIAOXI_WECHAT_EXE || cachedWechatExecutable, ...env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = timeout === null ? null : setTimeout(() => {
      child.kill();
      finish({ ok: false, reason: "powershell_timeout" });
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      const diagnostics = options.diagnostics === true
        ? { error_code: String(error?.code || ""), stderr: stderr.trim().slice(-1200) }
        : undefined;
      finish({ ok: false, reason: "powershell_failed", ...(diagnostics ? { diagnostics } : {}) });
    });
    child.on("close", (status) => {
      if (settled) return;
      if (status !== 0) {
        const diagnostics = options.diagnostics === true
          ? { exit_code: status, stderr: stderr.trim().slice(-1200) }
          : undefined;
        return finish({ ok: false, reason: "powershell_failed", ...(diagnostics ? { diagnostics } : {}) });
      }
      try {
        const output = stdout.trim();
        if (!output) return finish({ ok: false, reason: ensureResult?.reason || "powershell_output_invalid" });
        const parsed = JSON.parse(output);
        if (!parsed.ok && !parsed.reason) return finish({ ...parsed, reason: ensureResult?.reason || "powershell_output_invalid" });
        return finish(parsed);
      } catch {
        return finish(ensureResult?.reason ? { ok: false, reason: ensureResult.reason } : { ok: false, reason: "powershell_output_invalid" });
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(scriptInput);
  });
}

function openWechatSearchResult(query, context = {}) {
  if (!String(query ?? "").trim()) return { ok: false };
  return runPowerShell(SEARCH_SCRIPT, {
    XIAOXI_SEARCH_QUERY: String(query),
    XIAOXI_PRESS_ENTER: "1",
    XIAOXI_SEARCH_RESULT_AUTOMATION_ID: String(context.resultAutomationId ?? ""),
    XIAOXI_EXPECTED_PID: String(context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.hWnd ?? "")
  }, { ensure: false });
}

function openWechatSearchResultAsync(query, context = {}) {
  if (!String(query ?? "").trim()) return Promise.resolve({ ok: false });
  return runPowerShellAsync(SEARCH_SCRIPT, {
    XIAOXI_SEARCH_QUERY: String(query),
    XIAOXI_PRESS_ENTER: "1",
    XIAOXI_SEARCH_RESULT_AUTOMATION_ID: String(context.resultAutomationId ?? ""),
    XIAOXI_EXPECTED_PID: String(context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.hWnd ?? "")
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
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$expected = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_CONVERSATION")
$expectedPid = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID")
$expectedHwnd = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_HWND")
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
      [void][Win32WechatConversationTitle]::ShowWindowAsync($hWnd, 9)
      [void][Win32WechatConversationTitle]::SetForegroundWindow($hWnd)
      $script:matched = @{ hWnd = $hWnd; title = $title; rect = $rect; processName = $proc.ProcessName; pid = $windowProcessId }
    }
  }
  return $true
}
[void][Win32WechatConversationTitle]::EnumWindows($callback, [IntPtr]::Zero)
if ($matched -eq $null -or [string]::IsNullOrWhiteSpace($expected)) {
  @{ ok = $false; reason = "window_or_expected_missing" } | ConvertTo-Json -Compress
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
    XIAOXI_EXPECTED_PID: String(context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.hWnd ?? "")
  });
}

function verifyWechatCurrentConversationAsync(expectedTitle, context = {}) {
  if (!String(expectedTitle ?? "").trim()) return Promise.resolve({ ok: false });
  return runPowerShellAsync(CONVERSATION_TITLE_SCRIPT, {
    XIAOXI_EXPECTED_CONVERSATION: String(expectedTitle),
    XIAOXI_EXPECTED_PID: String(context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.hWnd ?? "")
  }, { ensure: false });
}

const MESSAGE_DRAFT_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32WechatMessageDraft {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004
$message = [Environment]::GetEnvironmentVariable("XIAOXI_MESSAGE_DRAFT")
$expectedPid = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID")
$expectedHwnd = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_HWND")

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
      [void][Win32WechatMessageDraft]::ShowWindowAsync($hWnd, 9)
      $focused = [Win32WechatMessageDraft]::SetForegroundWindow($hWnd)
      if (-not $focused) { try { $focused = (New-Object -ComObject WScript.Shell).AppActivate([int]$windowProcessId) } catch {} }
      Start-Sleep -Milliseconds 200
      $focused = $focused -or ([Win32WechatMessageDraft]::GetForegroundWindow() -eq $hWnd)
      $script:matched = @{ hWnd = $hWnd; title = $title; focused = $focused; processName = $proc.ProcessName }
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
  @{ ok = $false; reason = "wechat_focus_failed"; title = $matched.title; processName = $matched.processName } | ConvertTo-Json -Compress
  exit
}
Start-Sleep -Milliseconds 300
$oldClipboard = ""
try { $oldClipboard = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
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
  $point = $inputPoints[$attempt - 1]
  [void][Win32WechatMessageDraft]::SetForegroundWindow($matched.hWnd)
  Start-Sleep -Milliseconds (200 + (150 * $attempt))
  if ([Win32WechatMessageDraft]::GetForegroundWindow() -ne $matched.hWnd) {
    $draftCheck = "wechat_focus_lost_before_input"
    continue
  }
  $rect = New-Object Win32WechatMessageDraft+RECT
  if (-not [Win32WechatMessageDraft]::GetWindowRect($matched.hWnd, [ref]$rect)) {
    $draftCheck = "message_input_rect_missing"
    continue
  }
  $x = [int]($rect.Left + (($rect.Right - $rect.Left) * $point.xRatio))
  $y = [int]($rect.Top + (($rect.Bottom - $rect.Top) * $point.yRatio))
  [void][Win32WechatMessageDraft]::SetCursorPos($x, $y)
  [Win32WechatMessageDraft]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 50
  [Win32WechatMessageDraft]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds (200 + (150 * $attempt))
  try {
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 100
    Set-Clipboard -Value $message
    Start-Sleep -Milliseconds 100
    [System.Windows.Forms.SendKeys]::SendWait("^v")
  } catch {
    $draftCheck = "clipboard_write_or_paste_failed"
    continue
  }
  Start-Sleep -Milliseconds (350 + (250 * $attempt))
  if ([Win32WechatMessageDraft]::GetForegroundWindow() -ne $matched.hWnd) {
    $draftCheck = "wechat_focus_lost_after_paste"
    continue
  }
  try {
    $probe = "__XIAOXI_DRAFT_PROBE_" + [Guid]::NewGuid().ToString("N")
    Set-Clipboard -Value $probe
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 100
    [System.Windows.Forms.SendKeys]::SendWait("^c")
    Start-Sleep -Milliseconds (250 + (150 * $attempt))
    $copiedDraft = [string](Get-Clipboard -Raw -ErrorAction Stop)
    $normalizedCopiedDraft = Normalize-WechatDraftText $copiedDraft
    if ($normalizedCopiedDraft -ceq $normalizedMessage) {
      $draftVerified = $true
      $draftCheck = "clipboard_roundtrip"
    } elseif ($normalizedCopiedDraft -ceq (Normalize-WechatDraftText $probe)) {
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
try { Set-Clipboard -Value $oldClipboard } catch {}
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
  WECHAT_STABLE_WINDOW_LAYOUT,
  focusWechatWindow,
  focusWechatWindowAsync,
  inputWechatMessageDraft,
  inputWechatMessageDraftAsync,
  inputWechatSearchQuery,
  normalizeWechatMainWindow,
  normalizeWechatMainWindowAsync,
  openWechatSearchResult,
  openWechatSearchResultAsync,
  runPowerShell,
  runPowerShellAsync,
  verifyWechatCurrentConversation,
  verifyWechatCurrentConversationAsync
};
