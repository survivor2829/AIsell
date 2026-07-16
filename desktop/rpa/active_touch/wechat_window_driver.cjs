const { spawn, spawnSync } = require("node:child_process");

const POWERSHELL_STDIN_BOOTSTRAP = Buffer.from(
  '$ProgressPreference="SilentlyContinue";$raw=[Console]::In.ReadToEnd();$text=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($raw));. ([ScriptBlock]::Create($text))',
  "utf16le"
).toString("base64");

const ENSURE_WECHAT_WINDOW_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32WechatEnsureWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
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
    if ($proc -and $processNames -contains $proc.ProcessName) {
      $text = New-Object System.Text.StringBuilder 512
      [void][Win32WechatEnsureWindow]::GetWindowText($hWnd, $text, $text.Capacity)
      $rect = New-Object Win32WechatEnsureWindow+RECT
      [void][Win32WechatEnsureWindow]::GetWindowRect($hWnd, [ref]$rect)
      $w = $rect.Right - $rect.Left
      $h = $rect.Bottom - $rect.Top
      $isIconic = [Win32WechatEnsureWindow]::IsIconic($hWnd)
      $isLoginSize = ($w -ge 260 -and $w -le 380 -and $h -ge 320 -and $h -le 460)
      $isNormalMainWindow = ($w -ge 400 -and $h -ge 300 -and $rect.Left -gt -1000 -and $rect.Top -gt -1000)
      $isExpectedTitle = $text.ToString().Trim() -eq "微信"
      if ($isExpectedTitle -and -not $isLoginSize -and ($isNormalMainWindow -or $isIconic)) {
        [void]$items.Add(@{ hWnd = $hWnd; visible = [Win32WechatEnsureWindow]::IsWindowVisible($hWnd); minimized = $isIconic; x = $rect.Left; y = $rect.Top; w = $w; h = $h })
      }
    }
    return $true
  }
  [void][Win32WechatEnsureWindow]::EnumWindows($callback, [IntPtr]::Zero)
  return $items
}
function Test-VisiblePersonalWechat {
  foreach ($item in Get-PersonalWechatWindows) {
    if ($item.visible -and -not $item.minimized -and $item.w -ge 400 -and $item.h -ge 300 -and $item.x -gt -1000 -and $item.y -gt -1000) { return $true }
  }
  return $false
}
function Test-PersonalWechatLoginWindow {
  $found = $false
  $processNames = @("Weixin", "WeChat")
  $callback = [Win32WechatEnsureWindow+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if ($found) { return $true }
    [uint32]$windowProcessId = 0
    [void][Win32WechatEnsureWindow]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
    $proc = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
    if ($proc -and $processNames -contains $proc.ProcessName -and [Win32WechatEnsureWindow]::IsWindowVisible($hWnd)) {
      $text = New-Object System.Text.StringBuilder 512
      [void][Win32WechatEnsureWindow]::GetWindowText($hWnd, $text, $text.Capacity)
      $rect = New-Object Win32WechatEnsureWindow+RECT
      [void][Win32WechatEnsureWindow]::GetWindowRect($hWnd, [ref]$rect)
      $w = $rect.Right - $rect.Left
      $h = $rect.Bottom - $rect.Top
      if ($text.ToString().Trim() -eq "微信" -and $w -ge 260 -and $w -le 380 -and $h -ge 320 -and $h -le 460) {
        $script:found = $true
      }
    }
    return $true
  }
  [void][Win32WechatEnsureWindow]::EnumWindows($callback, [IntPtr]::Zero)
  return $found
}
function Focus-PersonalWechatMainWindowByAutomation {
  try {
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, "mmui::MainWindow")
    $items = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    for ($i = 0; $i -lt $items.Count; $i++) {
      $item = $items.Item($i)
      $rect = $item.Current.BoundingRectangle
      $hWnd = [IntPtr]$item.Current.NativeWindowHandle
      [uint32]$windowProcessId = 0
      [void][Win32WechatEnsureWindow]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
      $proc = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
      if ($hWnd -ne [IntPtr]::Zero -and $proc -and @("Weixin", "WeChat") -contains $proc.ProcessName -and $rect.Width -ge 400 -and $rect.Height -ge 300) {
        [void][Win32WechatEnsureWindow]::ShowWindowAsync($hWnd, 9)
        Start-Sleep -Milliseconds 300
        [void][Win32WechatEnsureWindow]::SetForegroundWindow($hWnd)
        return $true
      }
    }
  } catch {}
  return $false
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
    "D:\\微信\\Weixin\\Weixin.exe",
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
if (-not (Test-VisiblePersonalWechat)) {
  $candidate = Get-PersonalWechatWindows | Select-Object -First 1
  if ($candidate) {
    [void][Win32WechatEnsureWindow]::ShowWindowAsync($candidate.hWnd, 9)
    Start-Sleep -Milliseconds 1200
    [void][Win32WechatEnsureWindow]::SetForegroundWindow($candidate.hWnd)
  }
}
if (Test-VisiblePersonalWechat) { [void](Focus-PersonalWechatMainWindowByAutomation) }
if (-not (Test-VisiblePersonalWechat)) {
  [void](Focus-PersonalWechatMainWindowByAutomation)
}
if (-not (Test-VisiblePersonalWechat)) {
  [void](Start-PersonalWechat)
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 500
    [void](Focus-PersonalWechatMainWindowByAutomation)
    if (Test-VisiblePersonalWechat) { break }
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
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@
function Find-PersonalWechatMainWindow {
  return Get-Process -Name Weixin,WeChat -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq "微信" } |
    Select-Object -First 1
}
$main = Find-PersonalWechatMainWindow
if (-not $main) {
  foreach ($path in @(
    "D:\\微信\\Weixin\\Weixin.exe",
    "$env:LOCALAPPDATA\\Tencent\\WeChat\\WeChat.exe",
    "$env:ProgramFiles\\Tencent\\WeChat\\WeChat.exe"
  )) {
    if ($path -and (Test-Path $path)) { Start-Process -FilePath $path | Out-Null; break }
  }
  for ($i = 0; $i -lt 12 -and -not $main; $i++) { Start-Sleep -Milliseconds 500; $main = Find-PersonalWechatMainWindow }
}
if (-not $main) {
  $running = Get-Process -Name Weixin,WeChat -ErrorAction SilentlyContinue
  @{ ok = $false; reason = $(if ($running) { "wechat_login_required" } else { "wechat_window_not_found" }) } | ConvertTo-Json -Compress
  exit
}
$hWnd = [IntPtr]$main.MainWindowHandle
[void][Win32WechatSimpleWindow]::ShowWindow($hWnd, 9)
try { [void](New-Object -ComObject WScript.Shell).AppActivate([int]$main.Id) } catch {}
[void][Win32WechatSimpleWindow]::SetForegroundWindow($hWnd)
Start-Sleep -Milliseconds 300
$rect = New-Object Win32WechatSimpleWindow+RECT
[void][Win32WechatSimpleWindow]::GetWindowRect($hWnd, [ref]$rect)
if ([Win32WechatSimpleWindow]::GetForegroundWindow() -ne $hWnd) {
  [void][Win32WechatSimpleWindow]::SetWindowPos($hWnd, [IntPtr](-1), 0, 0, 0, 0, 0x0003)
  [void][Win32WechatSimpleWindow]::SetWindowPos($hWnd, [IntPtr](-2), 0, 0, 0, 0, 0x0003)
  $oldPoint = New-Object Win32WechatSimpleWindow+POINT
  [void][Win32WechatSimpleWindow]::GetCursorPos([ref]$oldPoint)
  [void][Win32WechatSimpleWindow]::SetCursorPos([int](($rect.Left + $rect.Right) / 2), [int]($rect.Top + 16))
  [Win32WechatSimpleWindow]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [Win32WechatSimpleWindow]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 200
  [void][Win32WechatSimpleWindow]::SetCursorPos($oldPoint.X, $oldPoint.Y)
}
$ok = [Win32WechatSimpleWindow]::IsWindowVisible($hWnd) -and -not [Win32WechatSimpleWindow]::IsIconic($hWnd) -and [Win32WechatSimpleWindow]::GetForegroundWindow() -eq $hWnd -and ($rect.Right - $rect.Left) -ge 400 -and ($rect.Bottom - $rect.Top) -ge 300
@{ ok = $ok; reason = $(if ($ok) { "" } else { "wechat_focus_failed" }); pid = $main.Id; hWnd = $hWnd.ToInt64(); title = $main.MainWindowTitle; processName = $main.ProcessName } | ConvertTo-Json -Compress
`;

function ensureWechatWindowVisible() {
  const encoded = Buffer.from(SIMPLE_ENSURE_WECHAT_WINDOW_SCRIPT, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    encoding: "utf8",
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
  const scriptInput = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", POWERSHELL_STDIN_BOOTSTRAP], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    input: scriptInput,
    timeout: 15000,
    windowsHide: true
  });

  if (result.error) {
    return { ok: false, reason: result.error.code === "ETIMEDOUT" ? "powershell_timeout" : "powershell_failed" };
  }
  if (result.status !== 0) return { ok: false, reason: "powershell_failed" };

  try {
    const parsed = JSON.parse(result.stdout.trim() || "{\"ok\":false}");
    if (!parsed.ok && ensureResult?.reason && !parsed.reason) return { ...parsed, reason: ensureResult.reason };
    return parsed;
  } catch {
    return { ok: false, reason: ensureResult?.reason || "powershell_output_invalid" };
  }
}

const FOCUS_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32WechatWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
  $processNames = @("Weixin", "WeChat")
$matched = $null
$callback = [Win32WechatWindow+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if ($matched -ne $null) { return $true }
  if ([Win32WechatWindow]::IsWindowVisible($hWnd)) {
    $text = New-Object System.Text.StringBuilder 512
    [void][Win32WechatWindow]::GetWindowText($hWnd, $text, $text.Capacity)
    $title = $text.ToString().Trim()
    $rect = New-Object Win32WechatWindow+RECT
    [void][Win32WechatWindow]::GetWindowRect($hWnd, [ref]$rect)
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    [uint32]$windowProcessId = 0
    [void][Win32WechatWindow]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
    $proc = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
    if ($proc -and $processNames -contains $proc.ProcessName -and $proc.MainWindowHandle -eq $hWnd -and $title -eq "微信" -and $w -ge 400 -and $h -ge 300 -and $rect.Left -gt -1000 -and $rect.Top -gt -1000) {
      [void][Win32WechatWindow]::ShowWindowAsync($hWnd, 9)
      $focused = [Win32WechatWindow]::SetForegroundWindow($hWnd)
      if (-not $focused) { try { $focused = (New-Object -ComObject WScript.Shell).AppActivate([int]$windowProcessId) } catch {} }
      Start-Sleep -Milliseconds 200
      $focused = $focused -or ([Win32WechatWindow]::GetForegroundWindow() -eq $hWnd)
      $script:matched = @{ title = $title; focused = $focused; processName = $proc.ProcessName; pid = $windowProcessId; hWnd = $hWnd.ToInt64() }
    }
  }
  return $true
}
[void][Win32WechatWindow]::EnumWindows($callback, [IntPtr]::Zero)
if ($matched -eq $null) { @{ ok = $false; reason = "personal_wechat_main_window_not_found" } | ConvertTo-Json -Compress } else { @{ ok = $true; title = $matched.title; focused = $matched.focused; processName = $matched.processName; pid = $matched.pid; hWnd = $matched.hWnd } | ConvertTo-Json -Compress }
`;

function focusWechatWindow() {
  return runPowerShell(FOCUS_SCRIPT);
}

function focusWechatWindowAsync() {
  return runPowerShellAsync(FOCUS_SCRIPT, {}, { ensure: false });
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
    if ($proc -and $matchesExpected -and $processNames -contains $proc.ProcessName -and $proc.MainWindowHandle -eq $hWnd -and $title -eq "微信" -and $w -ge 400 -and $h -ge 300 -and $rect.Left -gt -1000 -and $rect.Top -gt -1000) {
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
  const scriptInput = Buffer.from(script, "utf16le").toString("base64");
  const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : 15000;

  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", POWERSHELL_STDIN_BOOTSTRAP], {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, reason: "powershell_timeout" });
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => finish({ ok: false, reason: "powershell_failed" }));
    child.on("close", (status) => {
      if (settled) return;
      if (status !== 0) return finish({ ok: false, reason: "powershell_failed" });
      try {
        const parsed = JSON.parse(stdout.trim() || "{\"ok\":false}");
        if (!parsed.ok && ensureResult?.reason && !parsed.reason) return finish({ ...parsed, reason: ensureResult.reason });
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
  });
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
    if ($proc -and $matchesExpected -and $processNames -contains $proc.ProcessName -and $proc.MainWindowHandle -eq $hWnd -and $title -eq "微信" -and $w -ge 400 -and $h -ge 300 -and $rect.Left -gt -1000 -and $rect.Top -gt -1000) {
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
    if ($proc -and $matchesExpected -and $processNames -contains $proc.ProcessName -and $proc.MainWindowHandle -eq $hWnd -and $title -eq "微信" -and $w -ge 400 -and $h -ge 300 -and $rect.Left -gt -1000 -and $rect.Top -gt -1000) {
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
  });
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
  focusWechatWindow,
  focusWechatWindowAsync,
  inputWechatMessageDraft,
  inputWechatMessageDraftAsync,
  inputWechatSearchQuery,
  openWechatSearchResult,
  openWechatSearchResultAsync,
  runPowerShell,
  runPowerShellAsync,
  verifyWechatCurrentConversation,
  verifyWechatCurrentConversationAsync
};
