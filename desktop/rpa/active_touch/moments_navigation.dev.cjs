const { runPowerShellAsync } = require("./wechat_window_driver.cjs");

const MOMENTS_NAVIGATION_POWERSHELL = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32WechatMomentsNavigation {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
}
"@

function Write-Result($value) {
  $value | ConvertTo-Json -Compress -Depth 8
  exit
}

function Get-WechatWindows {
  $windows = New-Object System.Collections.Generic.List[object]
  $callback = [Win32WechatMomentsNavigation+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if (-not [Win32WechatMomentsNavigation]::IsWindowVisible($hWnd)) { return $true }
    [uint32]$windowProcessId = 0
    [void][Win32WechatMomentsNavigation]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
    $process = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
    if ($process -eq $null -or @("Weixin", "WeChat") -notcontains $process.ProcessName) { return $true }
    $rect = New-Object Win32WechatMomentsNavigation+RECT
    if (-not [Win32WechatMomentsNavigation]::GetWindowRect($hWnd, [ref]$rect)) { return $true }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -lt 300 -or $height -lt 300) { return $true }
    $titleText = New-Object System.Text.StringBuilder 256
    [void][Win32WechatMomentsNavigation]::GetWindowText($hWnd, $titleText, $titleText.Capacity)
    [void]$windows.Add(@{
      hWnd = $hWnd
      pid = [int]$windowProcessId
      processName = $process.ProcessName
      title = $titleText.ToString().Trim()
      minimized = [Win32WechatMomentsNavigation]::IsIconic($hWnd)
      left = $rect.Left
      top = $rect.Top
      width = $width
      height = $height
      area = [int64]$width * [int64]$height
    })
    return $true
  }
  [void][Win32WechatMomentsNavigation]::EnumWindows($callback, [IntPtr]::Zero)
  return $windows
}

function Focus-Window($window) {
  $hWnd = [IntPtr]$window.hWnd
  if ($window.minimized) {
    [void][Win32WechatMomentsNavigation]::ShowWindowAsync($hWnd, 9)
    Start-Sleep -Milliseconds 250
  }
  [void][Win32WechatMomentsNavigation]::SetForegroundWindow($hWnd)
  Start-Sleep -Milliseconds 180
  return [Win32WechatMomentsNavigation]::GetForegroundWindow() -eq $hWnd
}

function Get-MomentsWindow {
  return @(Get-WechatWindows | Where-Object { $_.title -ceq "朋友圈" } | Sort-Object area -Descending)
}

function Invoke-MomentsSidebarFallback($main) {
  $mainHwnd = [IntPtr]$main.hWnd
  $dpi = 96
  try {
    $observedDpi = [Win32WechatMomentsNavigation]::GetDpiForWindow($mainHwnd)
    if ($observedDpi -ge 96 -and $observedDpi -le 480) { $dpi = [int]$observedDpi }
  } catch {}
  $scale = [double]$dpi / 96.0
  $x = [int][Math]::Round($main.left + (26 * $scale))
  $y = [int][Math]::Round($main.top + (248 * $scale))
  $point = New-Object Win32WechatMomentsNavigation+POINT
  $point.X = $x
  $point.Y = $y
  $hitRoot = [Win32WechatMomentsNavigation]::GetAncestor(
    [Win32WechatMomentsNavigation]::WindowFromPoint($point),
    2
  )
  if ($hitRoot -ne $mainHwnd) {
    return @{ ok = $false; reason = "moments_entry_fallback_not_owned"; dpi = $dpi; x = $x; y = $y }
  }
  [void][Win32WechatMomentsNavigation]::SetCursorPos($x, $y)
  [Win32WechatMomentsNavigation]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 45
  [Win32WechatMomentsNavigation]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  return @{ ok = $true; mode = "dpi_sidebar_fallback"; dpi = $dpi; x = $x; y = $y }
}

function Open-Moments {
  $existing = @(Get-MomentsWindow)
  if ($existing.Count -eq 1) {
    if (-not (Focus-Window $existing[0])) { Write-Result @{ ok = $false; reason = "moments_window_not_foreground" } }
    Write-Result @{ ok = $true; action = "moments-open"; alreadyOpen = $true; pid = $existing[0].pid; hWnd = [string]$existing[0].hWnd }
  }
  if ($existing.Count -gt 1) { Write-Result @{ ok = $false; reason = "moments_window_ambiguous"; count = $existing.Count } }

  $main = Get-WechatWindows |
    Where-Object { $_.title -cne "朋友圈" -and $_.width -ge 600 -and $_.height -ge 500 } |
    Sort-Object area -Descending |
    Select-Object -First 1
  if (-not $main) { Write-Result @{ ok = $false; reason = "wechat_window_not_found" } }
  if (-not (Focus-Window $main)) { Write-Result @{ ok = $false; reason = "wechat_window_not_foreground" } }

  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$main.hWnd) } catch { $root = $null }
  if ($root -eq $null) { Write-Result @{ ok = $false; reason = "moments_entry_not_found" } }
  $nameCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    "朋友圈"
  )
  $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $nameCondition)
  $entries = New-Object System.Collections.Generic.List[object]
  for ($index = 0; $index -lt $elements.Count; $index++) {
    $element = $elements.Item($index)
    try {
      if ([int]$element.Current.ProcessId -ne [int]$main.pid -or $element.Current.IsOffscreen) { continue }
      $bounds = $element.Current.BoundingRectangle
      if ($bounds.Width -le 0 -or $bounds.Height -le 0) { continue }
      [void]$entries.Add(@{ element = $element; bounds = $bounds })
    } catch {}
  }
  if ($entries.Count -gt 1) { Write-Result @{ ok = $false; reason = "moments_entry_ambiguous"; count = $entries.Count } }

  $entryMode = "uia_name"
  $invoked = $false
  if ($entries.Count -eq 1) {
    $entry = $entries[0]
    try {
      $pattern = $entry.element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $pattern.Invoke()
      $invoked = $true
    } catch {}
    if (-not $invoked) {
      $x = [int][Math]::Round($entry.bounds.Left + ($entry.bounds.Width / 2))
      $y = [int][Math]::Round($entry.bounds.Top + ($entry.bounds.Height / 2))
      $point = New-Object Win32WechatMomentsNavigation+POINT
      $point.X = $x
      $point.Y = $y
      $hitRoot = [Win32WechatMomentsNavigation]::GetAncestor([Win32WechatMomentsNavigation]::WindowFromPoint($point), 2)
      if ($hitRoot -ne [IntPtr]$main.hWnd) { Write-Result @{ ok = $false; reason = "moments_entry_not_owned" } }
      [void][Win32WechatMomentsNavigation]::SetCursorPos($x, $y)
      [Win32WechatMomentsNavigation]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 45
      [Win32WechatMomentsNavigation]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    }
  } else {
    $fallback = Invoke-MomentsSidebarFallback $main
    if (-not $fallback.ok) { Write-Result $fallback }
    $entryMode = "dpi_sidebar_fallback"
  }

  for ($attempt = 0; $attempt -lt 16; $attempt++) {
    Start-Sleep -Milliseconds 250
    $opened = @(Get-MomentsWindow)
    if ($opened.Count -eq 1) {
      [void](Focus-Window $opened[0])
      Write-Result @{ ok = $true; action = "moments-open"; alreadyOpen = $false; entryMode = $entryMode; pid = $opened[0].pid; hWnd = [string]$opened[0].hWnd }
    }
  }
  Write-Result @{ ok = $false; reason = "moments_window_open_timeout"; entryMode = $entryMode }
}

function Scroll-Moments {
  $windows = @(Get-MomentsWindow)
  if ($windows.Count -eq 0) { Write-Result @{ ok = $false; reason = "moments_window_not_found" } }
  if ($windows.Count -gt 1) { Write-Result @{ ok = $false; reason = "moments_window_ambiguous"; count = $windows.Count } }
  $window = $windows[0]
  if (-not (Focus-Window $window)) { Write-Result @{ ok = $false; reason = "moments_window_not_foreground" } }

  $x = [int][Math]::Round($window.left + ($window.width * 0.68))
  $y = [int][Math]::Round($window.top + ($window.height * 0.72))
  $point = New-Object Win32WechatMomentsNavigation+POINT
  $point.X = $x
  $point.Y = $y
  $hitRoot = [Win32WechatMomentsNavigation]::GetAncestor([Win32WechatMomentsNavigation]::WindowFromPoint($point), 2)
  if ($hitRoot -ne [IntPtr]$window.hWnd) { Write-Result @{ ok = $false; reason = "moments_scroll_target_not_owned" } }
  [void][Win32WechatMomentsNavigation]::SetCursorPos($x, $y)
  [Win32WechatMomentsNavigation]::mouse_event(0x0800, 0, 0, -540, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 550
  if ([Win32WechatMomentsNavigation]::GetForegroundWindow() -ne [IntPtr]$window.hWnd) {
    Write-Result @{ ok = $false; reason = "moments_window_not_foreground" }
  }
  Write-Result @{ ok = $true; action = "moments-scroll"; pid = $window.pid; hWnd = [string]$window.hWnd; delta = -540 }
}

$action = [string]$env:XIAOXI_MOMENTS_NAV_ACTION
if ($action -ceq "open") { Open-Moments }
if ($action -ceq "scroll") { Scroll-Moments }
Write-Result @{ ok = $false; reason = "moments_navigation_action_invalid" }
`;

function openWechatMoments() {
  return runPowerShellAsync(
    MOMENTS_NAVIGATION_POWERSHELL,
    { XIAOXI_MOMENTS_NAV_ACTION: "open" },
    { ensure: true, sta: true, timeout: 15_000, diagnostics: true }
  );
}

function scrollWechatMomentsFeed() {
  return runPowerShellAsync(
    MOMENTS_NAVIGATION_POWERSHELL,
    { XIAOXI_MOMENTS_NAV_ACTION: "scroll" },
    { ensure: false, sta: true, timeout: 10_000, diagnostics: true }
  );
}

module.exports = {
  MOMENTS_NAVIGATION_POWERSHELL,
  openWechatMoments,
  scrollWechatMomentsFeed
};
