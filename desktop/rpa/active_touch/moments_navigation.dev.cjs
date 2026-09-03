const {
  WECHAT_MOMENTS_STANDALONE_WINDOW_LAYOUT_MODE,
  WECHAT_RPA_WINDOW_LAYOUT_MODE,
  focusExactWechatRpaSurfaceAsync,
  inspectForegroundWechatRpaSurface,
  prepareWechatRpaWindowAsync,
  runPowerShellAsync
} = require("./wechat_window_driver.cjs");
const { MOMENTS_VISUAL_READONLY_POWERSHELL } = require("./moments_visual_probe.dev.cjs");
const {
  MOMENTS_INTEGRATED_SURFACE_EVIDENCE_POWERSHELL
} = require("./moments_surface_evidence.dev.cjs");

const MOMENTS_NAVIGATION_OPEN_TIMEOUT_MS = 45_000;
const MOMENTS_INTEGRATED_TRANSITION_VISUAL_CHECKS = 6;

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
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
  public static uint GetLastInputTick() {
    LASTINPUTINFO info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    return GetLastInputInfo(ref info) ? info.dwTime : UInt32.MaxValue;
  }
  public static uint GetLastInputIdleMilliseconds() {
    uint lastInputTick = GetLastInputTick();
    return lastInputTick == UInt32.MaxValue
      ? UInt32.MaxValue
      : unchecked((uint)Environment.TickCount - lastInputTick);
  }
  public static bool GuardedClick(int x, int y, uint expectedInputTick) {
    if (GetLastInputTick() != expectedInputTick || !SetCursorPos(x, y) || GetLastInputTick() != expectedInputTick) return false;
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    return true;
  }
  public static bool GuardedWheel(int x, int y, int delta, uint expectedInputTick) {
    if (GetLastInputTick() != expectedInputTick || !SetCursorPos(x, y) || GetLastInputTick() != expectedInputTick) return false;
    mouse_event(0x0800, 0, 0, delta, UIntPtr.Zero);
    return true;
  }
}
"@

${MOMENTS_VISUAL_READONLY_POWERSHELL}
${MOMENTS_INTEGRATED_SURFACE_EVIDENCE_POWERSHELL}

function Write-Result($value) {
  $value | ConvertTo-Json -Compress -Depth 8
  exit
}

function Get-MomentsMinimumIdleMs {
  [int]$minimumIdleMs = 0
  if (-not [int]::TryParse([string]$env:XIAOXI_MOMENTS_MIN_IDLE_MS, [ref]$minimumIdleMs) -or $minimumIdleMs -lt 0) {
    return 0
  }
  return [Math]::Min($minimumIdleMs, 60000)
}

function Test-MomentsUserIdle([int]$minimumIdleMs) {
  if ($minimumIdleMs -le 0) { return $true }
  $idleMs = [Win32WechatMomentsNavigation]::GetLastInputIdleMilliseconds()
  return $idleMs -ne [uint32]::MaxValue -and [uint64]$idleMs -ge [uint64]$minimumIdleMs
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
    $classText = New-Object System.Text.StringBuilder 256
    [void][Win32WechatMomentsNavigation]::GetClassName($hWnd, $classText, $classText.Capacity)
    [void]$windows.Add(@{
      hWnd = $hWnd
      pid = [int]$windowProcessId
      processName = $process.ProcessName
      title = $titleText.ToString().Trim()
      className = $classText.ToString().Trim()
      dpi = [int][Win32WechatMomentsNavigation]::GetDpiForWindow($hWnd)
      minimized = [Win32WechatMomentsNavigation]::IsIconic($hWnd)
      rect = $rect
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

function Get-MomentsWindow {
  return @(Get-WechatWindows | Where-Object { $_.title -ceq "朋友圈" } | Sort-Object area -Descending)
}

function Get-ExpectedMomentsHost {
  try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$env:XIAOXI_MOMENTS_EXPECTED_HOST_BASE64))
    return $json | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Resolve-ExpectedMomentsHost {
  $expected = Get-ExpectedMomentsHost
  [int]$expectedPid = 0
  [int64]$expectedHWnd = 0
  $surfaceMode = [string]$expected.surfaceMode
  $integratedReady = $surfaceMode -ceq "integrated" -and [bool]$expected.normalized -and
    [string]$expected.layoutMode -ceq "${WECHAT_RPA_WINDOW_LAYOUT_MODE}"
  $standaloneReady = $surfaceMode -ceq "standalone" -and [bool]$expected.normalized -and
    [string]$expected.layoutMode -ceq "${WECHAT_MOMENTS_STANDALONE_WINDOW_LAYOUT_MODE}"
  if ($expected -eq $null -or (-not $integratedReady -and -not $standaloneReady) -or
    -not [int]::TryParse([string]$expected.pid, [ref]$expectedPid) -or $expectedPid -le 0 -or
    -not [int64]::TryParse([string]$expected.hWnd, [ref]$expectedHWnd) -or $expectedHWnd -le 0 -or
    [string]::IsNullOrWhiteSpace([string]$expected.title) -or
    [string]::IsNullOrWhiteSpace([string]$expected.windowClass)) {
    return @{ ok = $false; reason = "wechat_window_not_ready" }
  }
  $matches = @(Get-WechatWindows | Where-Object {
    [int]$_.pid -eq $expectedPid -and
    [int64]$_.hWnd -eq $expectedHWnd -and
    [string]$_.title -ceq [string]$expected.title -and
    [string]$_.className -ceq [string]$expected.windowClass
  })
  if ($matches.Count -ne 1) {
    return @{ ok = $false; reason = "moments_window_identity_mismatch"; count = $matches.Count }
  }
  $window = $matches[0]
  if ([int]$window.left -ne [int]$expected.x -or [int]$window.top -ne [int]$expected.y -or
    [int]$window.width -ne [int]$expected.width -or [int]$window.height -ne [int]$expected.height -or
    [int]$window.dpi -ne [int]$expected.dpi) {
    return @{ ok = $false; reason = "wechat_window_not_ready" }
  }
  if ([Win32WechatMomentsNavigation]::GetForegroundWindow() -ne [IntPtr]$window.hWnd) {
    return @{ ok = $false; reason = "wechat_window_not_foreground" }
  }
  return @{ ok = $true; window = $window }
}

function Write-MomentsOpenSuccess($window, [string]$surfaceMode, [bool]$alreadyOpen, [string]$entryMode) {
  Write-Result @{
    ok = $true
    action = "moments-open"
    alreadyOpen = $alreadyOpen
    entryMode = $entryMode
    surfaceMode = $surfaceMode
    pid = [int]$window.pid
    hWnd = [string]$window.hWnd
    title = [string]$window.title
    className = [string]$window.className
    x = [int]$window.left
    y = [int]$window.top
    width = [int]$window.width
    height = [int]$window.height
    dpi = [int]$window.dpi
    focused = [Win32WechatMomentsNavigation]::GetForegroundWindow() -eq [IntPtr]$window.hWnd
  }
}

function Get-MomentsRuntimeId([System.Windows.Automation.AutomationElement]$element) {
  try {
    $runtimeId = $element.GetRuntimeId()
    if ($runtimeId -and $runtimeId.Count -gt 0) { return [string]($runtimeId -join ".") }
  } catch {}
  return ""
}

function Get-MomentsRenderPaneEvidence([System.Windows.Automation.AutomationElement]$root, [int]$expectedPid) {
  $paneType = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Pane
  )
  $panes = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $paneType)
  $matches = New-Object System.Collections.Generic.List[object]
  for ($index = 0; $index -lt $panes.Count; $index++) {
    $pane = $panes.Item($index)
    try {
      if ([string]$pane.Current.Name -cne "MMUIRenderSubWindowHW" -or [int]$pane.Current.ProcessId -ne $expectedPid) { continue }
      $rect = $pane.Current.BoundingRectangle
      $runtimeId = Get-MomentsRuntimeId $pane
      if (-not $runtimeId -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
      [void]$matches.Add(@{
        name = [string]$pane.Current.Name
        automationId = [string]$pane.Current.AutomationId
        controlType = [string]$pane.Current.ControlType.ProgrammaticName
        processId = [int]$pane.Current.ProcessId
        runtimeId = $runtimeId
        bounds = @{
          left = [double]$rect.Left
          top = [double]$rect.Top
          width = [double]$rect.Width
          height = [double]$rect.Height
        }
      })
    } catch {}
  }
  if ($matches.Count -eq 0) { return @{ ok = $false; reason = "moments_render_pane_not_found" } }
  if ($matches.Count -ne 1) { return @{ ok = $false; reason = "moments_render_pane_ambiguous"; count = $matches.Count } }
  return @{ ok = $true; pane = $matches[0] }
}

function Test-MomentsBoundsInside($inner, $outer) {
  if ($inner -eq $null -or $outer -eq $null) { return $false }
  return [double]$inner.left -ge [double]$outer.left -and
    [double]$inner.top -ge [double]$outer.top -and
    ([double]$inner.left + [double]$inner.width) -le ([double]$outer.left + [double]$outer.width) -and
    ([double]$inner.top + [double]$inner.height) -le ([double]$outer.top + [double]$outer.height)
}

function Get-IntegratedMomentsEntryState($window, [bool]$requireDiscoverEvidence = $true) {
  [Console]::Error.WriteLine("moments_navigation_stage:window_identity")
  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$window.hWnd) } catch { $root = $null }
  if ($root -eq $null) { return @{ ok = $false; reason = "moments_window_identity_mismatch" } }
  try {
    if ([string]$root.Current.Name -cne "微信" -or
      [string]$root.Current.ControlType.ProgrammaticName -cne "ControlType.Window" -or
      [int]$root.Current.ProcessId -ne [int]$window.pid) {
      return @{ ok = $false; reason = "moments_window_identity_mismatch" }
    }
  } catch { return @{ ok = $false; reason = "moments_window_identity_mismatch" } }
  $paneEvidence = Get-MomentsRenderPaneEvidence $root $window.pid
  if (-not $paneEvidence.ok) { return $paneEvidence }
  $windowBounds = @{ left = $window.left; top = $window.top; width = $window.width; height = $window.height }
  if (-not (Test-MomentsBoundsInside $paneEvidence.pane.bounds $windowBounds)) {
    return @{ ok = $false; reason = "moments_render_pane_bounds_invalid" }
  }
  [uint32]$dpi = 96
  try {
    $observedDpi = [Win32WechatMomentsNavigation]::GetDpiForWindow([IntPtr]$window.hWnd)
    if ($observedDpi -ge 72 -and $observedDpi -le 480) { $dpi = $observedDpi }
  } catch {}
  $relativePaneBounds = @{
    left = [double]$paneEvidence.pane.bounds.left - [double]$window.left
    top = [double]$paneEvidence.pane.bounds.top - [double]$window.top
    width = [double]$paneEvidence.pane.bounds.width
    height = [double]$paneEvidence.pane.bounds.height
  }
  $frame = Get-MomentsVisualFrame ([IntPtr]$window.hWnd) $window.rect $window.pid $false
  if (-not $frame.ok) { Close-MomentsVisualFrame $frame; return $frame }
  try {
    $surfaceScanBounds = @{ left = 0.0; top = 0.0; width = [double]$window.width; height = [double]$window.height }
    [Console]::Error.WriteLine("moments_navigation_stage:moments_entry")
    $entryEvidence = Get-IntegratedMomentsEntryEvidence $frame $surfaceScanBounds ([double]$dpi / 96.0)
    if (-not $entryEvidence.ok) { return $entryEvidence }
    # Opening an already-selected Moments page needs no primary-rail search.
    # Other callers (notably return-to-chat) still require that rail evidence.
    $discoverEvidence = @{ ok = $true; entries = @(); exactMatchCount = 0; candidateCount = 0; candidateDiagnostics = @(); activePixelCount = 0 }
    if ($requireDiscoverEvidence -or -not (Test-IntegratedMomentsAlreadyOpen $entryEvidence)) {
      [Console]::Error.WriteLine("moments_navigation_stage:discover_entry")
      $discoverEvidence = Get-IntegratedDiscoverEntryEvidence $frame $surfaceScanBounds ([double]$dpi / 96.0)
      if (-not $discoverEvidence.ok) { return $discoverEvidence }
    }
    $selectedDiscoverMatches = @($discoverEvidence.entries | Where-Object { [bool]$_.selected })
    # Pixel recognition runs against the frozen bitmap above. Mouse activity while
    # processing that bitmap does not alter its evidence, so lease only the latest
    # input boundary for the caller's immediate guarded navigation decision.
    [uint32]$evidenceInputTick = Get-MomentsLastInputTick
    if ($evidenceInputTick -eq [uint32]::MaxValue) {
      return @{ ok = $false; reason = "moments_user_input_detected"; diagnostics = @{ stage = "integrated_visual_observation_lease_unavailable" } }
    }
    return @{
      ok = $true
      paneBounds = $paneEvidence.pane.bounds
      relativePaneBounds = $relativePaneBounds
      discoverRegionBounds = $discoverEvidence.region
      discoverExactMatchCount = [int]$discoverEvidence.exactMatchCount
      discoverSelectedMatchCount = $selectedDiscoverMatches.Count
      discoverEntries = @($discoverEvidence.entries)
      discoverCandidateCount = [int]$discoverEvidence.candidateCount
      discoverCandidateDiagnostics = @($discoverEvidence.candidateDiagnostics)
      discoverActivePixelCount = [int]$discoverEvidence.activePixelCount
      entryRegionBounds = $entryEvidence.region
      exactMatchCount = [int]$entryEvidence.exactMatchCount
      entries = @($entryEvidence.entries)
      entryObservedLabels = @($entryEvidence.observedLabels)
      dpi = [int]$dpi
      scale = [double]$dpi / 96.0
      inputTick = [uint32]$evidenceInputTick
    }
  } finally {
    Close-MomentsVisualFrame $frame
  }
}

function Get-IntegratedDiscoverDiagnostics($entryState) {
  if ($entryState -eq $null) { return @{} }
  return @{
    dpi = [int]$entryState.dpi
    scale = [double]$entryState.scale
    region = $entryState.discoverRegionBounds
    activePixelCount = [int]$entryState.discoverActivePixelCount
    candidateCount = [int]$entryState.discoverCandidateCount
    exactMatchCount = [int]$entryState.discoverExactMatchCount
    selectedMatchCount = [int]$entryState.discoverSelectedMatchCount
    candidates = @($entryState.discoverCandidateDiagnostics)
  }
}

function Get-IntegratedMomentsEntryDiagnostics($entryState) {
  if ($entryState -eq $null) { return @{} }
  return @{
    region = $entryState.entryRegionBounds
    exactMatchCount = [int]$entryState.exactMatchCount
    observedLabels = @($entryState.entryObservedLabels)
  }
}

function Test-IntegratedMomentsAlreadyOpen($entryState) {
  if ($entryState -eq $null -or -not [bool]$entryState.ok -or [int]$entryState.exactMatchCount -ne 1) {
    return $false
  }
  $selectedEntries = @($entryState.entries | Where-Object { [bool]$_.selected })
  return $selectedEntries.Count -eq 1 -and [bool]$selectedEntries[0].contentBoundaryProven
}

function Test-IntegratedMomentsEntryReadyToClick($entryState) {
  # The caller must first prove the Discover panel context, either from its
  # selected entry or from this attempt's owned Discover click.
  if ($entryState -eq $null -or -not [bool]$entryState.ok -or [int]$entryState.exactMatchCount -ne 1 -or
    @($entryState.entries).Count -ne 1) {
    return $false
  }
  $selectedEntries = @($entryState.entries | Where-Object { [bool]$_.selected })
  return $selectedEntries.Count -eq 0
}

function Invoke-IntegratedMomentsEntry($window, $entryState, [uint32]$expectedInputTick) {
  if (-not $entryState.ok -or [int]$entryState.exactMatchCount -ne 1 -or @($entryState.entries).Count -ne 1) {
    return @{ ok = $false; reason = "moments_entry_ambiguous" }
  }
  $bounds = $entryState.entries[0].textBounds
  $x = [int][Math]::Round([double]$window.left + [double]$bounds.left + ([double]$bounds.width / 2.0))
  $y = [int][Math]::Round([double]$window.top + [double]$bounds.top + ([double]$bounds.height / 2.0))
  $region = $entryState.entryRegionBounds
  $regionLeft = [double]$window.left + [double]$region.left
  $regionTop = [double]$window.top + [double]$region.top
  if ($x -lt $regionLeft -or $x -gt ($regionLeft + [double]$region.width) -or
    $y -lt $regionTop -or $y -gt ($regionTop + [double]$region.height)) {
    return @{ ok = $false; reason = "moments_entry_not_owned" }
  }
  $click = Invoke-MomentsGuardedClick $x $y $window "moments_entry_not_owned" $expectedInputTick
  return @{
    ok = [bool]$click.ok
    reason = [string]$click.reason
    inputTick = [uint32]$click.inputTick
    x = $x
    y = $y
  }
}

function Invoke-IntegratedDiscoverEntry($window, $entryState, [uint32]$expectedInputTick) {
  if (-not $entryState.ok -or [int]$entryState.discoverExactMatchCount -ne 1 -or
    @($entryState.discoverEntries).Count -ne 1) {
    return @{ ok = $false; reason = "moments_discover_entry_ambiguous" }
  }
  $bounds = $entryState.discoverEntries[0].bounds
  $x = [int][Math]::Round([double]$window.left + [double]$bounds.left + ([double]$bounds.width / 2.0))
  $y = [int][Math]::Round([double]$window.top + [double]$bounds.top + ([double]$bounds.height / 2.0))
  $region = $entryState.discoverRegionBounds
  $regionLeft = [double]$window.left + [double]$region.left
  $regionTop = [double]$window.top + [double]$region.top
  if ($x -lt $regionLeft -or $x -gt ($regionLeft + [double]$region.width) -or
    $y -lt $regionTop -or $y -gt ($regionTop + [double]$region.height)) {
    return @{ ok = $false; reason = "moments_discover_entry_not_owned" }
  }
  $click = Invoke-MomentsGuardedClick $x $y $window "moments_discover_entry_not_owned" $expectedInputTick
  return @{
    ok = [bool]$click.ok
    reason = [string]$click.reason
    inputTick = [uint32]$click.inputTick
    x = $x
    y = $y
  }
}

function Test-MomentsBoundsNear($left, $right, [double]$tolerance = 1.5) {
  if ($left -eq $null -or $right -eq $null) { return $false }
  foreach ($field in @("left", "top", "width", "height")) {
    if ([Math]::Abs([double]$left.$field - [double]$right.$field) -gt $tolerance) { return $false }
  }
  return $true
}

function Get-ExpectedMomentsWindow {
  try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$env:XIAOXI_MOMENTS_EXPECTED_WINDOW_BASE64))
    return $json | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Test-MomentsWindowStable($window, [bool]$requireForeground = $true) {
  $hWnd = [IntPtr]$window.hWnd
  if (-not [Win32WechatMomentsNavigation]::IsWindowVisible($hWnd) -or
    [Win32WechatMomentsNavigation]::IsIconic($hWnd) -or
    ($requireForeground -and [Win32WechatMomentsNavigation]::GetForegroundWindow() -ne $hWnd)) { return $false }
  [uint32]$actualPid = 0
  [void][Win32WechatMomentsNavigation]::GetWindowThreadProcessId($hWnd, [ref]$actualPid)
  if ([int]$actualPid -ne [int]$window.pid) { return $false }
  $titleText = New-Object System.Text.StringBuilder 256
  [void][Win32WechatMomentsNavigation]::GetWindowText($hWnd, $titleText, $titleText.Capacity)
  $classText = New-Object System.Text.StringBuilder 256
  [void][Win32WechatMomentsNavigation]::GetClassName($hWnd, $classText, $classText.Capacity)
  if ($titleText.ToString().Trim() -cne [string]$window.title -or
    $classText.ToString().Trim() -cne [string]$window.className) { return $false }
  $rect = New-Object Win32WechatMomentsNavigation+RECT
  if (-not [Win32WechatMomentsNavigation]::GetWindowRect($hWnd, [ref]$rect)) { return $false }
  [int]$dpi = 96
  try { $dpi = [int][Win32WechatMomentsNavigation]::GetDpiForWindow($hWnd) } catch {}
  return $rect.Left -eq [int]$window.left -and $rect.Top -eq [int]$window.top -and
    ($rect.Right - $rect.Left) -eq [int]$window.width -and
    ($rect.Bottom - $rect.Top) -eq [int]$window.height -and $dpi -eq [int]$window.dpi
}

function Get-MomentsWindowFingerprint($window) {
  return @(
    [string]$window.pid,
    [string]$window.hWnd,
    [string]$window.title,
    [string]$window.className,
    [string]$window.left,
    [string]$window.top,
    [string]$window.width,
    [string]$window.height,
    [string]$window.dpi
  ) -join "|"
}

function Get-MomentsLastInputTick {
  return [uint32][Win32WechatMomentsNavigation]::GetLastInputTick()
}

function Get-MomentsSettledInputTick(
  [int]$settleIntervalMs = 60,
  [int]$maximumSamples = 4
) {
  $intervalMs = $(if ($settleIntervalMs -ge 1 -and $settleIntervalMs -le 250) { $settleIntervalMs } else { 60 })
  $sampleLimit = $(if ($maximumSamples -ge 2 -and $maximumSamples -le 8) { $maximumSamples } else { 4 })
  [uint32]$previousTick = [uint32]::MaxValue
  for ($sample = 0; $sample -lt $sampleLimit; $sample++) {
    Start-Sleep -Milliseconds $intervalMs
    [uint32]$currentTick = Get-MomentsLastInputTick
    if ($currentTick -eq [uint32]::MaxValue) { return [uint32]::MaxValue }
    if ($sample -gt 0 -and $currentTick -eq $previousTick) { return $currentTick }
    $previousTick = $currentTick
  }
  return [uint32]::MaxValue
}

function Invoke-MomentsGuardedClick(
  [int]$x,
  [int]$y,
  $window,
  [string]$ownershipReason,
  [uint32]$expectedInputTick = [uint32]::MaxValue
) {
  $point = New-Object Win32WechatMomentsNavigation+POINT
  $point.X = $x
  $point.Y = $y
  $hit = [Win32WechatMomentsNavigation]::WindowFromPoint($point)
  $hitRoot = [Win32WechatMomentsNavigation]::GetAncestor($hit, 2)
  [uint32]$hitPid = 0
  [void][Win32WechatMomentsNavigation]::GetWindowThreadProcessId($hit, [ref]$hitPid)
  if ($hitRoot -ne [IntPtr]$window.hWnd -or [int]$hitPid -ne [int]$window.pid) {
    return @{ ok = $false; reason = $ownershipReason }
  }
  if ($expectedInputTick -eq [uint32]::MaxValue) {
    $expectedInputTick = [Win32WechatMomentsNavigation]::GetLastInputTick()
  }
  if ($expectedInputTick -eq [uint32]::MaxValue -or
    [Win32WechatMomentsNavigation]::GetLastInputTick() -ne $expectedInputTick) {
    return @{ ok = $false; reason = "moments_user_input_detected" }
  }
  if (-not (Test-MomentsWindowStable $window)) {
    return @{ ok = $false; reason = "moments_window_changed" }
  }
  if (-not [Win32WechatMomentsNavigation]::GuardedClick($x, $y, $expectedInputTick)) {
    return @{ ok = $false; reason = "moments_user_input_detected" }
  }
  # mouse_event can update GetLastInputInfo asynchronously. Lease the program's
  # click only after that session-wide tick settles, so our own input is not
  # reported as competing user input by the transition observer.
  [uint32]$nextInputTick = Get-MomentsSettledInputTick
  if ($nextInputTick -eq [uint32]::MaxValue) {
    return @{ ok = $false; reason = "moments_user_input_detected" }
  }
  return @{ ok = $true; inputTick = [uint32]$nextInputTick }
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
  $click = Invoke-MomentsGuardedClick $x $y $main "moments_entry_fallback_not_owned"
  if (-not $click.ok) {
    return @{ ok = $false; reason = [string]$click.reason; dpi = $dpi; x = $x; y = $y }
  }
  return @{ ok = $true; mode = "dpi_sidebar_fallback"; dpi = $dpi; x = $x; y = $y }
}

function Open-Moments {
  [Console]::Error.WriteLine("moments_navigation_stage:resolve_host")
  [int]$integratedTransitionVisualChecks = ${MOMENTS_INTEGRATED_TRANSITION_VISUAL_CHECKS}
  $allowIntegrated = [string]$env:XIAOXI_MOMENTS_ALLOW_INTEGRATED -ceq "1"
  $hostResolution = Resolve-ExpectedMomentsHost
  if (-not $hostResolution.ok) { Write-Result $hostResolution }
  $main = $hostResolution.window
  [uint32]$integratedInputTick = [Win32WechatMomentsNavigation]::GetLastInputTick()
  if ($integratedInputTick -eq [uint32]::MaxValue) {
    Write-Result @{ ok = $false; reason = "moments_user_input_detected" }
  }
  if (-not (Test-MomentsUserIdle (Get-MomentsMinimumIdleMs))) {
    Write-Result @{ ok = $false; reason = "wechat_user_active" }
  }
  if ([string]$main.title -ceq "朋友圈") {
    Write-MomentsOpenSuccess $main "standalone" $true "already_open_exact"
  }
  if ([string]$main.title -cne "微信") {
    Write-Result @{ ok = $false; reason = "moments_window_identity_mismatch" }
  }

  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$main.hWnd) } catch { $root = $null }
  if ($root -eq $null) { Write-Result @{ ok = $false; reason = "moments_entry_not_found" } }

  # WeChat 4.1 embeds Moments in the main window. The primary-rail Discover
  # compass must be uniquely proven before its secondary-menu OCR can click.
  if ($allowIntegrated) {
    $initialPopups = @(Get-MomentsWindow | Where-Object {
      [int]$_.pid -eq [int]$main.pid -and [int64]$_.hWnd -ne [int64]$main.hWnd
    })
    if ($initialPopups.Count -gt 1) {
      Write-Result @{ ok = $false; reason = "moments_window_ambiguous"; count = $initialPopups.Count }
    }
    if ($initialPopups.Count -eq 1) {
      [int64]$initialPopupHWnd = [int64]$initialPopups[0].hWnd
      [int]$initialPopupStableCount = 0
      [string]$initialPopupFingerprint = ""
      for ($initialPopupAttempt = 0; $initialPopupAttempt -lt $integratedTransitionVisualChecks; $initialPopupAttempt++) {
        Start-Sleep -Milliseconds 250
        $currentHosts = @(Get-WechatWindows | Where-Object {
          [int]$_.pid -eq [int]$main.pid -and
          [int64]$_.hWnd -eq [int64]$main.hWnd -and
          [string]$_.title -ceq [string]$main.title -and
          [string]$_.className -ceq [string]$main.className -and
          [int]$_.left -eq [int]$main.left -and [int]$_.top -eq [int]$main.top -and
          [int]$_.width -eq [int]$main.width -and [int]$_.height -eq [int]$main.height -and
          [int]$_.dpi -eq [int]$main.dpi
        })
        if ($currentHosts.Count -ne 1) { Write-Result @{ ok = $false; reason = "moments_window_changed" } }
        $currentPopups = @(Get-MomentsWindow | Where-Object {
          [int]$_.pid -eq [int]$main.pid -and [int64]$_.hWnd -ne [int64]$main.hWnd
        })
        if ($currentPopups.Count -gt 1) {
          Write-Result @{ ok = $false; reason = "moments_window_ambiguous"; count = $currentPopups.Count }
        }
        if ($currentPopups.Count -eq 0) { break }
        $currentPopup = $currentPopups[0]
        if ([int64]$currentPopup.hWnd -ne $initialPopupHWnd) {
          Write-Result @{ ok = $false; reason = "moments_window_ambiguous"; count = 2 }
        }
        if (-not (Test-MomentsWindowStable $currentPopup $false)) {
          Write-Result @{ ok = $false; reason = "moments_window_changed" }
        }
        $currentPopupFingerprint = Get-MomentsWindowFingerprint $currentPopup
        if ($currentPopupFingerprint -ceq $initialPopupFingerprint) {
          $initialPopupStableCount += 1
        } else {
          $initialPopupFingerprint = $currentPopupFingerprint
          $initialPopupStableCount = 1
        }
        if ($initialPopupStableCount -ge 2) {
          Write-MomentsOpenSuccess $currentPopup "standalone" $true "already_open_exact"
        }
      }
    }
    $integratedEntry = Get-IntegratedMomentsEntryState $main $false
    if (-not $integratedEntry.ok) {
      if ([string]$integratedEntry.reason -ceq "moments_window_not_foreground") {
        $latePopups = @(Get-MomentsWindow | Where-Object {
          [int]$_.pid -eq [int]$main.pid -and [int64]$_.hWnd -ne [int64]$main.hWnd
        })
        if ($latePopups.Count -gt 1) {
          Write-Result @{ ok = $false; reason = "moments_window_ambiguous"; count = $latePopups.Count }
        }
        if ($latePopups.Count -eq 1) {
          Write-MomentsOpenSuccess $latePopups[0] "standalone" $true "already_open_exact"
        }
      }
      Write-Result $integratedEntry
    }
    if ([uint32]$integratedEntry.inputTick -eq [uint32]::MaxValue -or
      [Win32WechatMomentsNavigation]::GetLastInputTick() -ne [uint32]$integratedEntry.inputTick) {
      Write-Result @{ ok = $false; reason = "moments_user_input_detected"; diagnostics = @{ stage = "integrated_initial_observation_lease" } }
    }
    # This is still a read-only phase. The fresh frame owns a newer input lease
    # when it proved that the exact window stayed stable throughout observation.
    [uint32]$integratedInputTick = [uint32]$integratedEntry.inputTick
    if (Test-IntegratedMomentsAlreadyOpen $integratedEntry) {
      $alreadyOpenPopups = @(Get-MomentsWindow | Where-Object {
        [int]$_.pid -eq [int]$main.pid -and [int64]$_.hWnd -ne [int64]$main.hWnd
      })
      if ($alreadyOpenPopups.Count -gt 0) {
        Write-Result @{ ok = $false; reason = "moments_window_ambiguous"; count = $alreadyOpenPopups.Count }
      }
      Write-MomentsOpenSuccess $main "integrated" $true "already_open_selected_moments"
    }
    $selectedDiscoverEntries = @($integratedEntry.discoverEntries | Where-Object { [bool]$_.selected })
    if ([int]$integratedEntry.discoverExactMatchCount -gt 1 -or $selectedDiscoverEntries.Count -gt 1) {
      Write-Result @{
        ok = $false
        reason = "moments_discover_entry_ambiguous"
        count = [int]$integratedEntry.discoverExactMatchCount
        diagnostics = @{ discover = Get-IntegratedDiscoverDiagnostics $integratedEntry }
      }
    }
    if ([int]$integratedEntry.discoverExactMatchCount -ne 1) {
      # The MMUI render surface can be between frames when the app first gets
      # foreground. Re-observe only; do not click until either the already-open
      # page or one unique Discover entry is proven from a fresh frame.
      for ($preflightAttempt = 0; $preflightAttempt -lt $integratedTransitionVisualChecks; $preflightAttempt++) {
        Start-Sleep -Milliseconds 250
        $currentHosts = @(Get-WechatWindows | Where-Object {
          [int]$_.pid -eq [int]$main.pid -and
          [int64]$_.hWnd -eq [int64]$main.hWnd -and
          [string]$_.title -ceq [string]$main.title -and
          [string]$_.className -ceq [string]$main.className -and
          [int]$_.left -eq [int]$main.left -and [int]$_.top -eq [int]$main.top -and
          [int]$_.width -eq [int]$main.width -and [int]$_.height -eq [int]$main.height -and
          [int]$_.dpi -eq [int]$main.dpi
        })
        if ($currentHosts.Count -ne 1) {
          Write-Result @{ ok = $false; reason = "moments_window_identity_mismatch" }
        }
        $current = $currentHosts[0]
        if (-not (Test-MomentsWindowStable $current)) {
          Write-Result @{ ok = $false; reason = "moments_window_changed" }
        }
        $currentEntry = Get-IntegratedMomentsEntryState $current $false
        if (-not $currentEntry.ok) {
          if ([string]$currentEntry.reason -ceq "moments_window_not_foreground") {
            $latePopups = @(Get-MomentsWindow | Where-Object {
              [int]$_.pid -eq [int]$main.pid -and [int64]$_.hWnd -ne [int64]$main.hWnd
            })
            if ($latePopups.Count -gt 1) {
              Write-Result @{ ok = $false; reason = "moments_window_ambiguous"; count = $latePopups.Count }
            }
            if ($latePopups.Count -eq 1) { continue }
          }
          Write-Result $currentEntry
        }
        if ([uint32]$currentEntry.inputTick -eq [uint32]::MaxValue -or
          [Win32WechatMomentsNavigation]::GetLastInputTick() -ne [uint32]$currentEntry.inputTick) {
          Write-Result @{ ok = $false; reason = "moments_user_input_detected"; diagnostics = @{ stage = "integrated_preflight_observation_lease" } }
        }
        [uint32]$integratedInputTick = [uint32]$currentEntry.inputTick
        if (Test-IntegratedMomentsAlreadyOpen $currentEntry) {
          Write-MomentsOpenSuccess $current "integrated" $true "already_open_selected_moments"
        }
        $currentSelectedDiscover = @($currentEntry.discoverEntries | Where-Object { [bool]$_.selected })
        if ([int]$currentEntry.discoverExactMatchCount -gt 1 -or $currentSelectedDiscover.Count -gt 1) {
          Write-Result @{
            ok = $false
            reason = "moments_discover_entry_ambiguous"
            count = [int]$currentEntry.discoverExactMatchCount
            diagnostics = @{ discover = Get-IntegratedDiscoverDiagnostics $currentEntry }
          }
        }
        $main = $current
        $integratedEntry = $currentEntry
        $selectedDiscoverEntries = $currentSelectedDiscover
        if ([int]$integratedEntry.discoverExactMatchCount -eq 1) { break }
      }
    }
    if ([int]$integratedEntry.discoverExactMatchCount -ne 1) {
      Write-Result @{
        ok = $false
        reason = "moments_discover_entry_not_found"
        diagnostics = @{ discover = Get-IntegratedDiscoverDiagnostics $integratedEntry }
      }
    }
    $integratedEntryMode = "integrated_sidebar_ocr"
    $integratedNavigationStarted = $false
    if ($selectedDiscoverEntries.Count -ne 1) {
      $discoverClick = Invoke-IntegratedDiscoverEntry $main $integratedEntry $integratedInputTick
      if (-not $discoverClick.ok) { Write-Result $discoverClick }
      [uint32]$integratedInputTick = [uint32]$discoverClick.inputTick
      $integratedEntryMode = "integrated_discover_then_moments"
      $integratedNavigationStarted = $true
      $revealedEntry = $false
      [int64]$discoverPopupHWnd = 0
      [int]$discoverPopupStableCount = 0
      [string]$discoverPopupFingerprint = ""
      for ($attempt = 0; $attempt -lt $integratedTransitionVisualChecks; $attempt++) {
        Start-Sleep -Milliseconds 250
        $currentHosts = @(Get-WechatWindows | Where-Object {
          [int]$_.pid -eq [int]$main.pid -and
          [int64]$_.hWnd -eq [int64]$main.hWnd -and
          [string]$_.title -ceq [string]$main.title -and
          [string]$_.className -ceq [string]$main.className -and
          [int]$_.left -eq [int]$main.left -and [int]$_.top -eq [int]$main.top -and
          [int]$_.width -eq [int]$main.width -and [int]$_.height -eq [int]$main.height -and
          [int]$_.dpi -eq [int]$main.dpi
        })
        if ($currentHosts.Count -ne 1) { Write-Result @{ ok = $false; reason = "moments_window_changed" } }
        $current = $currentHosts[0]
        $currentPopups = @(Get-MomentsWindow | Where-Object {
          [int]$_.pid -eq [int]$main.pid -and [int64]$_.hWnd -ne [int64]$main.hWnd
        })
        if ($currentPopups.Count -gt 1) {
          Write-Result @{ ok = $false; reason = "moments_window_ambiguous"; count = $currentPopups.Count }
        }
        if ($currentPopups.Count -eq 1) {
          $currentPopup = $currentPopups[0]
          if (-not (Test-MomentsWindowStable $currentPopup)) {
            Write-Result @{ ok = $false; reason = "moments_window_changed" }
          }
          $currentPopupFingerprint = Get-MomentsWindowFingerprint $currentPopup
          if ($discoverPopupHWnd -eq [int64]$currentPopup.hWnd -and
            $currentPopupFingerprint -ceq $discoverPopupFingerprint) {
            $discoverPopupStableCount += 1
          } else {
            $discoverPopupHWnd = [int64]$currentPopup.hWnd
            $discoverPopupFingerprint = $currentPopupFingerprint
            $discoverPopupStableCount = 1
          }
          if ($discoverPopupStableCount -ge 2) {
            Write-MomentsOpenSuccess $currentPopup "standalone" $false "integrated_discover_popup"
          }
          continue
        }
        $currentEntry = Get-IntegratedMomentsEntryState $current $false
        if (-not $currentEntry.ok) {
          if ([string]$currentEntry.reason -ceq "moments_window_not_foreground") {
            $latePopups = @(Get-MomentsWindow | Where-Object {
              [int]$_.pid -eq [int]$main.pid -and [int64]$_.hWnd -ne [int64]$main.hWnd
            })
            if ($latePopups.Count -gt 1) {
              Write-Result @{ ok = $false; reason = "moments_window_ambiguous"; count = $latePopups.Count }
            }
            if ($latePopups.Count -eq 1) { continue }
          }
          Write-Result $currentEntry
        }
        # Navigation owns the mouse while the task is running. A fresh exact
        # Discover/Moments observation safely replaces the older transition
        # lease; the next guarded click still rechecks ownership atomically.
        [uint32]$integratedInputTick = [uint32]$currentEntry.inputTick
        if (-not (Test-MomentsWindowStable $current)) {
          Write-Result @{ ok = $false; reason = "moments_window_changed" }
        }
        if (Test-IntegratedMomentsAlreadyOpen $currentEntry) {
          Write-MomentsOpenSuccess $current "integrated" $false "integrated_discover_restored_moments"
        }
        $currentSelected = @($currentEntry.entries | Where-Object { [bool]$_.selected })
        if ([int]$currentEntry.exactMatchCount -gt 1 -or $currentSelected.Count -gt 1) {
          Write-Result @{ ok = $false; reason = "moments_entry_ambiguous"; count = [int]$currentEntry.exactMatchCount }
        }
        if (Test-IntegratedMomentsEntryReadyToClick $currentEntry) {
          $main = $current
          $integratedEntry = $currentEntry
          $revealedEntry = $true
          break
        }
      }
      if (-not $revealedEntry) {
        Write-Result @{
          ok = $false
          reason = "moments_discover_open_timeout"
          diagnostics = @{
            discover = Get-IntegratedDiscoverDiagnostics $currentEntry
            momentsEntry = Get-IntegratedMomentsEntryDiagnostics $currentEntry
          }
        }
      }
    }
    $selectedEntries = @($integratedEntry.entries | Where-Object { [bool]$_.selected })
    if ([int]$integratedEntry.exactMatchCount -gt 1 -or $selectedEntries.Count -gt 1) {
      Write-Result @{ ok = $false; reason = "moments_entry_ambiguous"; count = [int]$integratedEntry.exactMatchCount }
    }
    if (Test-IntegratedMomentsAlreadyOpen $integratedEntry) {
      Write-MomentsOpenSuccess $main "integrated" (-not $integratedNavigationStarted) $integratedEntryMode
    }
    if (Test-IntegratedMomentsEntryReadyToClick $integratedEntry) {
      $entryClick = Invoke-IntegratedMomentsEntry $main $integratedEntry $integratedInputTick
      if (-not $entryClick.ok) { Write-Result $entryClick }
      [uint32]$integratedInputTick = [uint32]$entryClick.inputTick
      [int64]$finalPopupHWnd = 0
      [int]$finalPopupStableCount = 0
      [string]$finalPopupFingerprint = ""
      [int]$integratedStableCount = 0
      $lastIntegratedWindow = $null
      for ($attempt = 0; $attempt -lt $integratedTransitionVisualChecks; $attempt++) {
        Start-Sleep -Milliseconds 250
        $currentHosts = @(Get-WechatWindows | Where-Object {
          [int]$_.pid -eq [int]$main.pid -and
          [int64]$_.hWnd -eq [int64]$main.hWnd -and
          [string]$_.title -ceq [string]$main.title -and
          [string]$_.className -ceq [string]$main.className -and
          [int]$_.left -eq [int]$main.left -and [int]$_.top -eq [int]$main.top -and
          [int]$_.width -eq [int]$main.width -and [int]$_.height -eq [int]$main.height -and
          [int]$_.dpi -eq [int]$main.dpi
        })
        if ($currentHosts.Count -ne 1) { Write-Result @{ ok = $false; reason = "moments_window_changed" } }
        $current = $currentHosts[0]
        $currentPopups = @(Get-MomentsWindow | Where-Object {
          [int]$_.pid -eq [int]$main.pid -and [int64]$_.hWnd -ne [int64]$main.hWnd
        })
        if ($currentPopups.Count -gt 1) {
          Write-Result @{ ok = $false; reason = "moments_window_ambiguous"; count = $currentPopups.Count }
        }
        if ($currentPopups.Count -eq 1) {
          $currentPopup = $currentPopups[0]
          if (-not (Test-MomentsWindowStable $currentPopup)) {
            Write-Result @{ ok = $false; reason = "moments_window_changed" }
          }
          $currentPopupFingerprint = Get-MomentsWindowFingerprint $currentPopup
          if ($finalPopupHWnd -eq [int64]$currentPopup.hWnd -and
            $currentPopupFingerprint -ceq $finalPopupFingerprint) {
            $finalPopupStableCount += 1
          } else {
            $finalPopupHWnd = [int64]$currentPopup.hWnd
            $finalPopupFingerprint = $currentPopupFingerprint
            $finalPopupStableCount = 1
          }
          $integratedStableCount = 0
          if ($finalPopupStableCount -ge 2) {
            Write-MomentsOpenSuccess $currentPopup "standalone" $false $integratedEntryMode
          }
          continue
        }
        $currentEntry = Get-IntegratedMomentsEntryState $current $false
        if (-not $currentEntry.ok) {
          if ([string]$currentEntry.reason -ceq "moments_window_not_foreground") {
            $latePopups = @(Get-MomentsWindow | Where-Object {
              [int]$_.pid -eq [int]$main.pid -and [int64]$_.hWnd -ne [int64]$main.hWnd
            })
            if ($latePopups.Count -gt 1) {
              Write-Result @{ ok = $false; reason = "moments_window_ambiguous"; count = $latePopups.Count }
            }
            if ($latePopups.Count -eq 1) { continue }
          }
          Write-Result $currentEntry
        }
        [uint32]$integratedInputTick = [uint32]$currentEntry.inputTick
        $currentSelected = @($currentEntry.entries | Where-Object { [bool]$_.selected })
        if ([int]$currentEntry.exactMatchCount -gt 1 -or $currentSelected.Count -gt 1) {
          Write-Result @{ ok = $false; reason = "moments_entry_ambiguous"; count = [int]$currentEntry.exactMatchCount }
        }
        if (-not (Test-MomentsWindowStable $current)) { Write-Result @{ ok = $false; reason = "moments_window_changed" } }
        if (Test-IntegratedMomentsAlreadyOpen $currentEntry) {
          $integratedStableCount += 1
          $lastIntegratedWindow = $current
        } else {
          $integratedStableCount = 0
          $lastIntegratedWindow = $null
        }
      }
      if ($integratedStableCount -ge 2 -and $lastIntegratedWindow -ne $null) {
        Write-MomentsOpenSuccess $lastIntegratedWindow "integrated" $false $integratedEntryMode
      }
      Write-Result @{ ok = $false; reason = "moments_window_open_timeout"; entryMode = $integratedEntryMode }
    }
    Write-Result @{ ok = $false; reason = "moments_entry_not_found" }
  }

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
      $centerX = [double]$bounds.Left + ([double]$bounds.Width / 2.0)
      $centerY = [double]$bounds.Top + ([double]$bounds.Height / 2.0)
      if ($centerX -lt [double]$main.left -or
        $centerX -gt ([double]$main.left + ([double]$main.width * 0.45)) -or
        $centerY -lt [double]$main.top -or
        $centerY -gt ([double]$main.top + ([double]$main.height * 0.55))) { continue }
      [void]$entries.Add(@{ element = $element; bounds = $bounds })
    } catch {}
  }
  if ($entries.Count -gt 1) { Write-Result @{ ok = $false; reason = "moments_entry_ambiguous"; count = $entries.Count } }

  $entryMode = "uia_name"
  $invoked = $false
  $invokeGuardFailed = $false
  if ($entries.Count -eq 1) {
    $entry = $entries[0]
    try {
      [uint32]$expectedInputTick = if ($allowIntegrated) {
        $integratedInputTick
      } else {
        [Win32WechatMomentsNavigation]::GetLastInputTick()
      }
      if ($expectedInputTick -ne [uint32]::MaxValue -and (Test-MomentsWindowStable $main) -and
        [Win32WechatMomentsNavigation]::GetLastInputTick() -eq $expectedInputTick) {
        $pattern = $entry.element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pattern.Invoke()
        $invoked = $true
      } else { $invokeGuardFailed = $true }
    } catch {}
    if ($invokeGuardFailed) { Write-Result @{ ok = $false; reason = "moments_user_input_detected" } }
    if (-not $invoked) {
      $x = [int][Math]::Round($entry.bounds.Left + ($entry.bounds.Width / 2))
      $y = [int][Math]::Round($entry.bounds.Top + ($entry.bounds.Height / 2))
      $click = Invoke-MomentsGuardedClick $x $y $main "moments_entry_not_owned" $expectedInputTick
      if (-not $click.ok) { Write-Result $click }
    }
  } elseif (-not $allowIntegrated) {
    $fallback = Invoke-MomentsSidebarFallback $main
    if (-not $fallback.ok) { Write-Result $fallback }
    $entryMode = "dpi_sidebar_fallback"
  } else {
    Write-Result @{ ok = $false; reason = "moments_entry_not_found" }
  }

  for ($attempt = 0; $attempt -lt 16; $attempt++) {
    Start-Sleep -Milliseconds 250
    $opened = @(Get-MomentsWindow | Where-Object { [int]$_.pid -eq [int]$main.pid })
    if ($opened.Count -gt 1) {
      Write-Result @{ ok = $false; reason = "moments_window_ambiguous"; count = $opened.Count }
    }
    if ($opened.Count -eq 1) {
      if ([Win32WechatMomentsNavigation]::GetForegroundWindow() -ne [IntPtr]$opened[0].hWnd) {
        Write-Result @{ ok = $false; reason = "moments_window_not_foreground" }
      }
      Write-MomentsOpenSuccess $opened[0] "standalone" $false $entryMode
    }
  }
  Write-Result @{ ok = $false; reason = "moments_window_open_timeout"; entryMode = $entryMode }
}

function Scroll-Moments {
  $scrollMode = [string]$env:XIAOXI_MOMENTS_SCROLL_MODE
  if ([string]::IsNullOrWhiteSpace($scrollMode)) { $scrollMode = "advance_feed" }
  if (@("advance_feed", "read_post_up", "seek_post_menu_down") -notcontains $scrollMode) {
    Write-Result @{ ok = $false; reason = "moments_scroll_mode_invalid" }
  }
  [int]$wheelDelta = 0
  if (-not [int]::TryParse([string]$env:XIAOXI_MOMENTS_SCROLL_DELTA, [ref]$wheelDelta) -or
    $wheelDelta -eq 0 -or [Math]::Abs($wheelDelta) -lt 240 -or [Math]::Abs($wheelDelta) -gt 600 -or
    [Math]::Abs($wheelDelta) % 60 -ne 0 -or
    ($scrollMode -ceq "read_post_up" -and $wheelDelta -lt 0) -or
    ($scrollMode -ne "read_post_up" -and $wheelDelta -gt 0)) {
    Write-Result @{ ok = $false; reason = "moments_scroll_delta_invalid" }
  }
  $expected = Get-ExpectedMomentsWindow
  $surfaceMode = [string]$expected.surfaceMode
  $identityMode = [string]$expected.identityMode
  [int]$expectedPid = 0
  [int64]$expectedHWnd = 0
  [int]$expectedLeft = 0
  [int]$expectedTop = 0
  [int]$expectedWidth = 0
  [int]$expectedHeight = 0
  if ($expected -eq $null -or @("standalone", "integrated") -notcontains $surfaceMode -or
    @("automation_id", "structural_sns_feed", "visual_mmui_render") -notcontains $identityMode -or
    -not [int]::TryParse([string]$expected.pid, [ref]$expectedPid) -or $expectedPid -le 0 -or
    -not [int64]::TryParse([string]$expected.hWnd, [ref]$expectedHWnd) -or $expectedHWnd -le 0 -or
    -not [int]::TryParse([string]$expected.left, [ref]$expectedLeft) -or
    -not [int]::TryParse([string]$expected.top, [ref]$expectedTop) -or
    -not [int]::TryParse([string]$expected.width, [ref]$expectedWidth) -or $expectedWidth -lt 300 -or
    -not [int]::TryParse([string]$expected.height, [ref]$expectedHeight) -or $expectedHeight -lt 300 -or
    [string]::IsNullOrWhiteSpace([string]$expected.className) -or
    ($surfaceMode -ceq "standalone" -and [string]$expected.title -cne "朋友圈") -or
    ($surfaceMode -ceq "integrated" -and [string]$expected.title -cne "微信")) {
    Write-Result @{ ok = $false; reason = "moments_scroll_target_invalid" }
  }
  $windows = @(Get-WechatWindows | Where-Object {
    [int]$_.pid -eq $expectedPid -and [int64]$_.hWnd -eq $expectedHWnd -and
    [string]$_.title -ceq [string]$expected.title -and [string]$_.className -ceq [string]$expected.className
  })
  if ($windows.Count -eq 0) { Write-Result @{ ok = $false; reason = "moments_window_not_found" } }
  if ($windows.Count -ne 1) { Write-Result @{ ok = $false; reason = "moments_window_ambiguous"; count = $windows.Count } }
  $window = $windows[0]
  if ([int]$window.left -ne $expectedLeft -or [int]$window.top -ne $expectedTop -or
    [int]$window.width -ne $expectedWidth -or [int]$window.height -ne $expectedHeight) {
    Write-Result @{ ok = $false; reason = "moments_window_changed" }
  }
  if (-not (Test-MomentsUserIdle (Get-MomentsMinimumIdleMs))) {
    Write-Result @{ ok = $false; reason = "wechat_user_active" }
  }
  if ([Win32WechatMomentsNavigation]::GetForegroundWindow() -ne [IntPtr]$window.hWnd) {
    Write-Result @{ ok = $false; reason = "moments_window_not_foreground" }
  }

  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$window.hWnd) } catch { $root = $null }
  if ($root -eq $null) { Write-Result @{ ok = $false; reason = "moments_window_identity_mismatch" } }
  try {
    $rootName = [string]$root.Current.Name
    $rootControlType = [string]$root.Current.ControlType.ProgrammaticName
    $rootProcessId = [int]$root.Current.ProcessId
  } catch { Write-Result @{ ok = $false; reason = "moments_window_identity_mismatch" } }
  if ($rootName -cne [string]$expected.rootName -or $rootControlType -cne "ControlType.Window" -or $rootProcessId -ne $expectedPid) {
    Write-Result @{ ok = $false; reason = "moments_window_identity_mismatch" }
  }

  $scrollBounds = @{
    left = [double]$window.left
    top = [double]$window.top
    width = [double]$window.width
    height = [double]$window.height
  }
  if ($identityMode -ceq "visual_mmui_render") {
    $paneEvidence = Get-MomentsRenderPaneEvidence $root $expectedPid
    if (-not $paneEvidence.ok) { Write-Result $paneEvidence }
    if ([string]$paneEvidence.pane.name -cne [string]$expected.renderPaneName -or
      [string]$paneEvidence.pane.automationId -cne [string]$expected.renderPaneAutomationId -or
      [string]$paneEvidence.pane.controlType -cne [string]$expected.renderPaneControlType -or
      [int]$paneEvidence.pane.processId -ne [int]$expected.renderPaneProcessId -or
      [string]$paneEvidence.pane.runtimeId -cne [string]$expected.renderPaneRuntimeId -or
      -not (Test-MomentsBoundsNear $paneEvidence.pane.bounds $expected.renderPaneBounds)) {
      Write-Result @{ ok = $false; reason = "moments_render_pane_changed" }
    }
    $scrollBounds = $paneEvidence.pane.bounds
    if ($surfaceMode -ceq "integrated") {
      [uint32]$dpi = 96
      try {
        $observedDpi = [Win32WechatMomentsNavigation]::GetDpiForWindow([IntPtr]$window.hWnd)
        if ($observedDpi -ge 72 -and $observedDpi -le 480) { $dpi = $observedDpi }
      } catch {}
      $frame = Get-MomentsVisualFrame ([IntPtr]$window.hWnd) $window.rect $expectedPid $false
      if (-not $frame.ok) { Write-Result $frame }
      try {
        $surfaceScanBounds = @{ left = 0.0; top = 0.0; width = [double]$window.width; height = [double]$window.height }
        $surfaceProof = Test-IntegratedMomentsSurface $frame $surfaceScanBounds ([double]$dpi / 96.0)
        if (-not $surfaceProof.ok) { Write-Result $surfaceProof }
      } finally {
        Close-MomentsVisualFrame $frame
      }
    }
  }

  $x = [int][Math]::Round([double]$scrollBounds.left + ([double]$scrollBounds.width * 0.50))
  $y = [int][Math]::Round([double]$scrollBounds.top + ([double]$scrollBounds.height * 0.72))
  $point = New-Object Win32WechatMomentsNavigation+POINT
  $point.X = $x
  $point.Y = $y
  $hit = [Win32WechatMomentsNavigation]::WindowFromPoint($point)
  $hitRoot = [Win32WechatMomentsNavigation]::GetAncestor($hit, 2)
  [uint32]$hitPid = 0
  [void][Win32WechatMomentsNavigation]::GetWindowThreadProcessId($hit, [ref]$hitPid)
  if ($hitRoot -ne [IntPtr]$window.hWnd -or [int]$hitPid -ne $expectedPid) {
    Write-Result @{ ok = $false; reason = "moments_scroll_target_not_owned" }
  }
  if (-not (Test-MomentsUserIdle (Get-MomentsMinimumIdleMs))) {
    Write-Result @{ ok = $false; reason = "wechat_user_active" }
  }
  if ([Win32WechatMomentsNavigation]::GetForegroundWindow() -ne [IntPtr]$window.hWnd -or
      -not (Test-MomentsWindowStable $window)) {
    Write-Result @{ ok = $false; reason = "moments_window_changed" }
  }
  $finalHit = [Win32WechatMomentsNavigation]::WindowFromPoint($point)
  $finalHitRoot = [Win32WechatMomentsNavigation]::GetAncestor($finalHit, 2)
  [uint32]$finalHitPid = 0
  [void][Win32WechatMomentsNavigation]::GetWindowThreadProcessId($finalHit, [ref]$finalHitPid)
  if ($finalHitRoot -ne [IntPtr]$window.hWnd -or [int]$finalHitPid -ne $expectedPid) {
    Write-Result @{ ok = $false; reason = "moments_scroll_target_not_owned" }
  }
  [uint32]$expectedInputTick = [Win32WechatMomentsNavigation]::GetLastInputTick()
  if ($expectedInputTick -eq [uint32]::MaxValue -or -not (Test-MomentsWindowStable $window)) {
    Write-Result @{ ok = $false; reason = "moments_window_changed" }
  }
  if (-not [Win32WechatMomentsNavigation]::GuardedWheel($x, $y, $wheelDelta, $expectedInputTick)) {
    Write-Result @{ ok = $false; reason = "moments_user_input_detected" }
  }
  Start-Sleep -Milliseconds 550
  if ([Win32WechatMomentsNavigation]::GetForegroundWindow() -ne [IntPtr]$window.hWnd) {
    Write-Result @{ ok = $false; reason = "moments_window_not_foreground" }
  }
  Write-Result @{ ok = $true; action = "moments-scroll"; pid = $window.pid; hWnd = [string]$window.hWnd; delta = $wheelDelta; scrollMode = $scrollMode }
}

function Resolve-MomentsChatRailTarget($entryState) {
  # In the supported integrated layout, Chat / Contacts / Favorites precede
  # Discover. Use observed glyphs, not an absolute screen coordinate. This is
  # navigation only; the chat scanner still verifies the selected conversation.
  $scale = [double]$entryState.scale
  $discover = @($entryState.discoverCandidateDiagnostics | Where-Object { $_.matched -and $_.selected })
  if ($discover.Count -ne 1) { return $null }
  $rows = @($entryState.discoverCandidateDiagnostics | Where-Object {
    $_.centerY -lt $discover[0].centerY -and
    [Math]::Abs($_.centerX - $discover[0].centerX) -le (8.0 * $scale) -and
    $_.bounds.width -ge (12.0 * $scale) -and $_.bounds.width -le (32.0 * $scale) -and
    $_.bounds.height -ge (12.0 * $scale) -and $_.bounds.height -le (32.0 * $scale)
  } | Sort-Object { [double]$_.centerY })
  if ($rows.Count -ne 3) { return $null }
  $gap = [double]$rows[1].centerY - [double]$rows[0].centerY
  if ($gap -lt (32.0 * $scale) -or $gap -gt (64.0 * $scale) -or
    [Math]::Abs(($rows[2].centerY - $rows[1].centerY) - $gap) -gt (8.0 * $scale) -or
    [Math]::Abs(($discover[0].centerY - $rows[2].centerY) - $gap) -gt (8.0 * $scale)) { return $null }
  return $rows[0]
}

function Return-MomentsToChat {
  $resolved = Resolve-ExpectedMomentsHost
  if (-not $resolved.ok) { Write-Result $resolved }
  $window = $resolved.window
  $entryState = Get-IntegratedMomentsEntryState $window
  if (-not (Test-IntegratedMomentsAlreadyOpen $entryState)) {
    # The existing chat scanner owns page/recipient verification. This helper
    # never navigates an unrecognized surface or opens a contact to clear a dot.
    Write-Result @{ ok = $true; changed = $false; pid = $window.pid; hWnd = [string]$window.hWnd }
  }
  $scale = [double]$entryState.scale
  $rail = $entryState.discoverRegionBounds
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$window.hWnd)
  $matches = New-Object System.Collections.Generic.List[object]
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($element in $all) {
    try {
      if ([string]$element.Current.Name -cne "聊天" -or $element.Current.IsOffscreen -or
        [int]$element.Current.ProcessId -ne [int]$window.pid -or
        @("ControlType.Button", "ControlType.TabItem", "ControlType.ListItem") -notcontains [string]$element.Current.ControlType.ProgrammaticName) { continue }
      $bounds = $element.Current.BoundingRectangle
      $centerX = [double]$bounds.Left + ([double]$bounds.Width / 2.0) - [double]$window.left
      $centerY = [double]$bounds.Top + ([double]$bounds.Height / 2.0) - [double]$window.top
      if ($bounds.Width -gt 0 -and $bounds.Height -gt 0 -and
        $centerX -ge [double]$rail.left -and $centerX -le ([double]$rail.left + [double]$rail.width) -and
        $centerY -ge [double]$rail.top -and $centerY -le ([double]$rail.top + [double]$rail.height)) {
        [void]$matches.Add(@{ centerX = $centerX; centerY = $centerY })
      }
    } catch {}
  }
  if ($matches.Count -gt 1) { Write-Result @{ ok = $false; reason = "wechat_chat_entry_ambiguous" } }
  $target = $(if ($matches.Count -eq 1) { $matches[0] } else { $null })
  if ($target -eq $null) { $target = Resolve-MomentsChatRailTarget $entryState }
  if ($target -eq $null) {
    # MMUI exposes no named buttons. Reuse the observed rail glyph bounds and
    # require a newly appeared exact Chat tooltip before clicking any glyph.
    $candidates = @($entryState.discoverCandidateDiagnostics | Where-Object {
      [double]$_.bounds.width -ge (8.0 * $scale) -and [double]$_.bounds.width -le (48.0 * $scale) -and
      [double]$_.bounds.height -ge (8.0 * $scale) -and [double]$_.bounds.height -le (48.0 * $scale)
    } | Sort-Object { [double]$_.centerY }, { [double]$_.centerX })
    if ($candidates.Count -gt 20) { Write-Result @{ ok = $false; reason = "wechat_chat_entry_ambiguous" } }
    foreach ($candidate in $candidates) {
      if (-not (Test-MomentsWindowStable $window)) { Write-Result @{ ok = $false; reason = "wechat_window_changed" } }
      $region = @{
        left = [double]$rail.left
        top = [Math]::Max(0.0, [double]$candidate.centerY - (30.0 * $scale))
        width = [Math]::Min(200.0 * $scale, [double]$window.width - [double]$rail.left)
        height = [Math]::Min(60.0 * $scale, [double]$window.height - [Math]::Max(0.0, [double]$candidate.centerY - (30.0 * $scale)))
      }
      $before = Get-MomentsVisualFrame ([IntPtr]$window.hWnd) $window.rect $window.pid $false
      if (-not $before.ok) { Close-MomentsVisualFrame $before; Write-Result $before }
      try { $beforeText = Get-MomentsOcrObservation $before $region } finally { Close-MomentsVisualFrame $before }
      if (-not $beforeText.ok -or @($beforeText.lines | Where-Object { [string]$_.compact -ceq "聊天" }).Count -gt 0) { continue }
      $x = [int][Math]::Round([double]$window.left + [double]$candidate.centerX)
      $y = [int][Math]::Round([double]$window.top + [double]$candidate.centerY)
      $point = New-Object Win32WechatMomentsNavigation+POINT
      $point.X = $x; $point.Y = $y
      $hit = [Win32WechatMomentsNavigation]::WindowFromPoint($point)
      [uint32]$hitPid = 0
      [void][Win32WechatMomentsNavigation]::GetWindowThreadProcessId($hit, [ref]$hitPid)
      if ([Win32WechatMomentsNavigation]::GetAncestor($hit, 2) -ne [IntPtr]$window.hWnd -or [int]$hitPid -ne [int]$window.pid) {
        Write-Result @{ ok = $false; reason = "wechat_chat_entry_not_owned" }
      }
      [uint32]$hoverTick = Get-MomentsLastInputTick
      if ($hoverTick -eq [uint32]::MaxValue -or -not (Test-MomentsWindowStable $window) -or
        [Win32WechatMomentsNavigation]::GetLastInputTick() -ne $hoverTick -or
        -not [Win32WechatMomentsNavigation]::SetCursorPos($x, $y)) {
        Write-Result @{ ok = $false; reason = "moments_user_input_detected" }
      }
      [uint32]$settledTick = Get-MomentsSettledInputTick
      Start-Sleep -Milliseconds 700
      if ($settledTick -eq [uint32]::MaxValue -or (Get-MomentsLastInputTick) -ne $settledTick -or
        -not (Test-MomentsWindowStable $window)) { Write-Result @{ ok = $false; reason = "moments_user_input_detected" } }
      $after = Get-MomentsVisualFrame ([IntPtr]$window.hWnd) $window.rect $window.pid $false
      if (-not $after.ok) { Close-MomentsVisualFrame $after; Write-Result $after }
      try { $afterText = Get-MomentsOcrObservation $after $region } finally { Close-MomentsVisualFrame $after }
      if ($afterText.ok -and @($afterText.lines | Where-Object { [string]$_.compact -ceq "聊天" }).Count -eq 1) {
        $target = $candidate
        break
      }
    }
  }
  if ($target -eq $null) { Write-Result @{ ok = $false; reason = "wechat_chat_entry_not_found" } }
  $fresh = Get-IntegratedMomentsEntryState $window
  if (-not (Test-IntegratedMomentsAlreadyOpen $fresh)) { Write-Result @{ ok = $false; reason = "wechat_chat_surface_unverified" } }
  $targetX = [int][Math]::Round([double]$window.left + [double]$target.centerX)
  $targetY = [int][Math]::Round([double]$window.top + [double]$target.centerY)
  $clicked = Invoke-MomentsGuardedClick $targetX $targetY $window "wechat_chat_entry_not_owned" ([uint32]$fresh.inputTick)
  if (-not $clicked.ok) { Write-Result $clicked }
  for ($attempt = 0; $attempt -lt 4; $attempt++) {
    Start-Sleep -Milliseconds 250
    if (-not (Test-MomentsWindowStable $window) -or (Get-MomentsLastInputTick) -ne [uint32]$clicked.inputTick) {
      Write-Result @{ ok = $false; reason = "wechat_window_changed" }
    }
    $afterState = Get-IntegratedMomentsEntryState $window
    $selectedTarget = @($afterState.discoverCandidateDiagnostics | Where-Object {
      [bool]$_.selected -and [Math]::Abs([double]$_.centerX - [double]$target.centerX) -le (4.0 * $scale) -and
      [Math]::Abs([double]$_.centerY - [double]$target.centerY) -le (4.0 * $scale)
    })
    if ($afterState.ok -and -not (Test-IntegratedMomentsAlreadyOpen $afterState) -and
      [int]$afterState.discoverSelectedMatchCount -eq 0 -and $selectedTarget.Count -eq 1) {
      Write-Result @{ ok = $true; changed = $true; chatSelected = $true; pid = $window.pid; hWnd = [string]$window.hWnd }
    }
  }
  Write-Result @{ ok = $false; reason = "wechat_chat_surface_unverified" }
}

$action = [string]$env:XIAOXI_MOMENTS_NAV_ACTION
if ($action -ceq "open") { Open-Moments }
if ($action -ceq "scroll") { Scroll-Moments }
if ($action -ceq "return-chat") { Return-MomentsToChat }
Write-Result @{ ok = $false; reason = "moments_navigation_action_invalid" }
`;

async function returnWechatFromMomentsToChat(preparedMain, runner = runPowerShellAsync) {
  if (preparedMain?.ok !== true || preparedMain.normalized !== true
    || preparedMain.layoutMode !== WECHAT_RPA_WINDOW_LAYOUT_MODE || preparedMain.focused !== true) {
    return { ok: false, reason: "wechat_window_not_ready" };
  }
  return runner(MOMENTS_NAVIGATION_POWERSHELL, {
    XIAOXI_MOMENTS_NAV_ACTION: "return-chat",
    XIAOXI_MOMENTS_EXPECTED_HOST_BASE64: Buffer.from(JSON.stringify({ ...preparedMain, surfaceMode: "integrated" }), "utf8").toString("base64"),
    XIAOXI_MOMENTS_MIN_IDLE_MS: "0"
  }, { ensure: false, sta: true, timeout: MOMENTS_NAVIGATION_OPEN_TIMEOUT_MS });
}

async function openWechatMoments(options = {}) {
  const minIdleMs = Number.isFinite(Number(options.minIdleMs))
    ? Math.max(0, Math.min(60_000, Math.trunc(Number(options.minIdleMs))))
    : 0;
  const expectedWindowSupplied = Object.prototype.hasOwnProperty.call(options, "expectedWindow");
  const expectedWindow = expectedWindowSupplied
    && options.expectedWindow !== null
    && typeof options.expectedWindow === "object"
    && !Array.isArray(options.expectedWindow)
    ? options.expectedWindow
    : null;
  if (expectedWindowSupplied && !expectedWindow) {
    return { ok: false, reason: "moments_window_identity_mismatch" };
  }
  const expectedPid = Number(expectedWindow?.pid);
  const expectedHWnd = String(expectedWindow?.hWnd ?? "").trim();
  if (expectedWindow && (!Number.isSafeInteger(expectedPid) || expectedPid <= 0 || !/^[1-9]\d*$/u.test(expectedHWnd)
    || !["integrated", "standalone"].includes(expectedWindow.surfaceMode))) {
    return { ok: false, reason: "moments_window_identity_mismatch" };
  }
  if (options.signal?.aborted) return { ok: false, reason: "powershell_aborted" };
  let host;
  try {
    if (expectedWindow) {
      host = await focusExactWechatRpaSurfaceAsync({
        ...expectedWindow,
        pid: expectedPid,
        hWnd: expectedHWnd,
        minIdleMs,
        signal: options.signal
      }, runPowerShellAsync);
    } else {
      const preparedMain = await prepareWechatRpaWindowAsync({
        minIdleMs,
        requireFocused: true,
        signal: options.signal
      });
      host = preparedMain?.ok ? { ...preparedMain, surfaceMode: "integrated" } : preparedMain;
    }
  } catch {
    return { ok: false, reason: "wechat_window_not_ready" };
  }
  if (!host?.ok) return host || { ok: false, reason: "wechat_window_not_ready" };
  if (expectedWindow && (Number(host.pid) !== expectedPid || String(host.hWnd) !== expectedHWnd)) {
    return { ok: false, reason: "moments_window_identity_mismatch" };
  }
  if (expectedWindow) {
    return {
      ok: true,
      action: "moments-open",
      alreadyOpen: true,
      entryMode: "already_open_exact",
      surfaceMode: expectedWindow.surfaceMode,
      normalized: host.normalized,
      layoutMode: host.layoutMode,
      focused: true,
      title: host.title,
      className: host.windowClass,
      processName: host.processName,
      pid: host.pid,
      hWnd: String(host.hWnd),
      x: host.x,
      y: host.y,
      width: host.width,
      height: host.height,
      dpi: host.dpi
    };
  }

  const opened = await runPowerShellAsync(
    MOMENTS_NAVIGATION_POWERSHELL,
    {
      XIAOXI_MOMENTS_NAV_ACTION: "open",
      XIAOXI_MOMENTS_ALLOW_INTEGRATED: options.allowIntegrated === true ? "1" : "0",
      XIAOXI_MOMENTS_MIN_IDLE_MS: String(minIdleMs),
      XIAOXI_MOMENTS_EXPECTED_HOST_BASE64: Buffer.from(JSON.stringify(host), "utf8").toString("base64")
    },
    {
      ensure: false,
      sta: true,
      timeout: MOMENTS_NAVIGATION_OPEN_TIMEOUT_MS,
      diagnostics: true,
      signal: options.signal
    }
  );
  if (!opened?.ok) return opened;

  let anchored;
  try {
    anchored = opened.surfaceMode === "standalone"
      ? await focusExactWechatRpaSurfaceAsync({
          ...opened,
          windowClass: opened.className,
          signal: options.signal
        }, runPowerShellAsync)
      : await inspectForegroundWechatRpaSurface({
          expectedPid: opened.pid,
          expectedHWnd: opened.hWnd,
          expectedTitle: opened.title,
          expectedWindowClass: opened.className,
          surfaceMode: opened.surfaceMode,
          signal: options.signal
        }, runPowerShellAsync);
  } catch {
    return { ok: false, reason: "wechat_window_not_ready" };
  }
  const integratedLayoutReady = opened.surfaceMode === "integrated"
    && anchored?.normalized === true
    && anchored?.layoutMode === WECHAT_RPA_WINDOW_LAYOUT_MODE;
  const standaloneLayoutReady = opened.surfaceMode === "standalone"
    && anchored?.normalized === true
    && anchored?.layoutMode === WECHAT_MOMENTS_STANDALONE_WINDOW_LAYOUT_MODE
    && Number(anchored?.width) >= 300
    && Number(anchored?.height) >= 300;
  const anchoringModeReady = opened.surfaceMode === "standalone"
    ? anchored?.focusOnly === true && anchored?.inspectionOnly === false
    : anchored?.inspectionOnly === true;
  if (!anchored?.ok || !anchoringModeReady || anchored.focused !== true
    || (!integratedLayoutReady && !standaloneLayoutReady)) {
    return anchored?.ok ? { ok: false, reason: "wechat_window_not_ready" } : anchored || { ok: false, reason: "wechat_window_not_ready" };
  }
  if (
    Number(opened.pid) !== Number(anchored.pid)
    || String(opened.hWnd) !== String(anchored.hWnd)
    || String(opened.title) !== String(anchored.title)
    || String(opened.className) !== String(anchored.windowClass)
    || String(opened.surfaceMode) !== String(anchored.surfaceMode)
  ) {
    return { ok: false, reason: "moments_window_identity_mismatch" };
  }
  return {
    ...opened,
    pid: anchored.pid,
    hWnd: String(anchored.hWnd),
    title: anchored.title,
    className: anchored.windowClass,
    x: anchored.x,
    y: anchored.y,
    width: anchored.width,
    height: anchored.height,
    dpi: anchored.dpi,
    focused: anchored.focused,
    normalized: anchored.normalized,
    layoutMode: anchored.layoutMode
  };
}

function resolveMomentsScrollPlan(expectedWindow, requestedMode = "advance_feed") {
  const normalizedMode = requestedMode === "align_partial_post"
    ? "seek_post_menu_down"
    : requestedMode;
  if (!["advance_feed", "read_post_up", "seek_post_menu_down"].includes(normalizedMode)) {
    return null;
  }
  const mode = normalizedMode;
  const observedHeight = Number(expectedWindow?.renderPaneBounds?.height ?? expectedWindow?.height);
  if (!Number.isFinite(observedHeight) || observedHeight < 300) return null;
  const viewportHeight = Math.round(observedHeight);
  const targetDistance = mode === "advance_feed"
    ? Math.max(420, Math.min(600, viewportHeight * 0.55))
    : Math.max(240, Math.min(360, viewportHeight * 0.30));
  const roundedDistance = Math.max(60, Math.round(targetDistance / 60) * 60);
  return {
    mode,
    viewportHeight,
    delta: mode === "read_post_up" ? roundedDistance : -roundedDistance
  };
}

async function scrollWechatMomentsFeed(options = {}) {
  const expectedWindow = options.expectedWindow && typeof options.expectedWindow === "object"
    ? options.expectedWindow
    : null;
  if (!expectedWindow) return { ok: false, reason: "moments_scroll_target_invalid" };
  const minIdleMs = Number.isFinite(Number(options.minIdleMs))
    ? Math.max(0, Math.min(60_000, Math.trunc(Number(options.minIdleMs))))
    : 0;
  const scrollPlan = resolveMomentsScrollPlan(expectedWindow, options.scrollMode);
  if (!scrollPlan) return { ok: false, reason: "moments_scroll_target_invalid" };
  const shouldContinue = typeof options.shouldContinue === "function"
    ? options.shouldContinue
    : () => true;
  const mayContinue = async () => {
    try {
      return (await shouldContinue()) !== false;
    } catch {
      return false;
    }
  };
  if (!(await mayContinue())) return { ok: false, reason: "moments_scroll_cancelled" };
  return runPowerShellAsync(
    MOMENTS_NAVIGATION_POWERSHELL,
    {
      XIAOXI_MOMENTS_NAV_ACTION: "scroll",
      XIAOXI_MOMENTS_MIN_IDLE_MS: String(minIdleMs),
      XIAOXI_MOMENTS_SCROLL_MODE: scrollPlan.mode,
      XIAOXI_MOMENTS_SCROLL_DELTA: String(scrollPlan.delta),
      XIAOXI_MOMENTS_EXPECTED_WINDOW_BASE64: Buffer.from(
        JSON.stringify(expectedWindow),
        "utf8"
      ).toString("base64")
    },
    { ensure: false, sta: true, timeout: 10_000, diagnostics: true }
  );
}

module.exports = {
  MOMENTS_INTEGRATED_TRANSITION_VISUAL_CHECKS,
  MOMENTS_NAVIGATION_OPEN_TIMEOUT_MS,
  MOMENTS_NAVIGATION_POWERSHELL,
  openWechatMoments,
  returnWechatFromMomentsToChat,
  resolveMomentsScrollPlan,
  scrollWechatMomentsFeed
};
