const { momentsPostIdentityPrefix } = require("./moments_dry_run.dev.cjs");
const { runPowerShell } = require("./wechat_window_driver.cjs");

function exactCommentText(value) {
  return String(value ?? "");
}

const MOMENTS_ACTION_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32WechatMomentsAction {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
}
"@

function Write-Result($value) {
  $value | ConvertTo-Json -Compress -Depth 8
  exit
}

function Decode-Base64([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  try { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) } catch { return "" }
}

function Normalize-Text([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  return ([Text.RegularExpressions.Regex]::Replace($value.Normalize([Text.NormalizationForm]::FormKC), "\\s+", " ")).Trim()
}

function Test-FinitePositiveRect($rect) {
  if ($rect -eq $null -or $rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { return $false }
  foreach ($value in @([double]$rect.Left, [double]$rect.Top, [double]$rect.Width, [double]$rect.Height)) {
    if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) { return $false }
  }
  return $true
}

function Test-ActionDeadline {
  $deadlineMs = [int64]0
  $deadlineValid = [int64]::TryParse([string]$env:XIAOXI_MOMENTS_DEADLINE_MS, [ref]$deadlineMs)
  if (-not $deadlineValid -or $deadlineMs -le 0) { return $false }
  $epoch = [DateTime]::SpecifyKind([DateTime]"1970-01-01T00:00:00", [DateTimeKind]::Utc)
  $nowMs = [int64](([DateTime]::UtcNow - $epoch).TotalMilliseconds)
  return $nowMs -le $deadlineMs
}

function Get-RuntimeId([System.Windows.Automation.AutomationElement]$element) {
  try {
    $runtimeId = $element.GetRuntimeId()
    if ($runtimeId -and $runtimeId.Count -gt 0) { return [string]($runtimeId -join ".") }
  } catch {}
  return ""
}

function Get-ElementRawText([System.Windows.Automation.AutomationElement]$element) {
  try {
    $name = [string]$element.Current.Name
    if (-not [string]::IsNullOrWhiteSpace($name)) { return $name }
  } catch {}
  foreach ($patternId in @(
    [System.Windows.Automation.ValuePattern]::Pattern,
    [System.Windows.Automation.TextPattern]::Pattern,
    [System.Windows.Automation.LegacyIAccessiblePattern]::Pattern
  )) {
    try {
      $pattern = $element.GetCurrentPattern($patternId)
      if ($patternId -eq [System.Windows.Automation.ValuePattern]::Pattern) { $value = [string]$pattern.Current.Value }
      elseif ($patternId -eq [System.Windows.Automation.TextPattern]::Pattern) { $value = [string]$pattern.DocumentRange.GetText(-1) }
      else { $value = [string]$pattern.Current.Value }
      if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
    } catch {}
  }
  return ""
}

function Get-ElementText([System.Windows.Automation.AutomationElement]$element) {
  return Normalize-Text (Get-ElementRawText $element)
}

function Get-TopLevelFeedItemDepth(
  [System.Windows.Automation.AutomationElement]$feed,
  [System.Windows.Automation.AutomationElement]$item
) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  try { $ancestor = $walker.GetParent($item) } catch { return -1 }
  $depth = 1
  while ($ancestor -ne $null -and $depth -le 16) {
    if ([System.Windows.Automation.Automation]::Compare($ancestor, $feed)) { return $depth }
    try {
      if ($ancestor.Current.ControlType -eq [System.Windows.Automation.ControlType]::ListItem) { return -1 }
      $ancestor = $walker.GetParent($ancestor)
    } catch { return -1 }
    $depth += 1
  }
  return -1
}

function Get-TargetContext {
  $expectedPid = [int]$env:XIAOXI_MOMENTS_EXPECTED_PID
  $expectedHandleText = [string]$env:XIAOXI_MOMENTS_EXPECTED_HWND
  $expectedTitle = Decode-Base64 $env:XIAOXI_MOMENTS_EXPECTED_TITLE_BASE64
  $expectedClassName = Decode-Base64 $env:XIAOXI_MOMENTS_EXPECTED_CLASS_BASE64
  [int]$expectedLeft = 0
  [int]$expectedTop = 0
  [int]$expectedWidth = 0
  [int]$expectedHeight = 0
  $expectedRuntimeId = [string]$env:XIAOXI_MOMENTS_RUNTIME_ID
  $expectedRootAutomationId = [string]$env:XIAOXI_MOMENTS_ROOT_AUTOMATION_ID
  $expectedIdentityMode = [string]$env:XIAOXI_MOMENTS_IDENTITY_MODE
  $expectedRootName = Decode-Base64 $env:XIAOXI_MOMENTS_ROOT_NAME_BASE64
  $expectedRootControlType = [string]$env:XIAOXI_MOMENTS_ROOT_CONTROL_TYPE
  $expectedFeedAutomationId = [string]$env:XIAOXI_MOMENTS_FEED_AUTOMATION_ID
  $expectedFeedRuntimeId = [string]$env:XIAOXI_MOMENTS_FEED_RUNTIME_ID
  $expectedFeedCount = [int]$env:XIAOXI_MOMENTS_FEED_COUNT
  $expectedPrefix = Normalize-Text (Decode-Base64 $env:XIAOXI_MOMENTS_LABEL_PREFIX_BASE64)
  $expectedIdentityValid = ($expectedIdentityMode -ceq "automation_id" -and $expectedRootAutomationId -ceq "SNSWindow") -or
    ($expectedIdentityMode -ceq "structural_sns_feed" -and $expectedRootAutomationId -ceq "")
  if ($expectedPid -le 0 -or $expectedHandleText -notmatch '^[1-9][0-9]*$' -or
    [string]::IsNullOrWhiteSpace($expectedTitle) -or [string]::IsNullOrWhiteSpace($expectedClassName) -or
    -not [int]::TryParse([string]$env:XIAOXI_MOMENTS_EXPECTED_LEFT, [ref]$expectedLeft) -or
    -not [int]::TryParse([string]$env:XIAOXI_MOMENTS_EXPECTED_TOP, [ref]$expectedTop) -or
    -not [int]::TryParse([string]$env:XIAOXI_MOMENTS_EXPECTED_WIDTH, [ref]$expectedWidth) -or $expectedWidth -lt 300 -or
    -not [int]::TryParse([string]$env:XIAOXI_MOMENTS_EXPECTED_HEIGHT, [ref]$expectedHeight) -or $expectedHeight -lt 300 -or
    [string]::IsNullOrWhiteSpace($expectedRuntimeId) -or
    -not $expectedIdentityValid -or $expectedRootName -cne "朋友圈" -or $expectedRootControlType -cne "ControlType.Window" -or
    $expectedFeedAutomationId -cne "sns_list" -or [string]::IsNullOrWhiteSpace($expectedFeedRuntimeId) -or $expectedFeedCount -ne 1) {
    return @{ ok = $false; reason = "moments_target_lock_invalid" }
  }
  $hWnd = [IntPtr][int64]$expectedHandleText
  if (-not [Win32WechatMomentsAction]::IsWindowVisible($hWnd)) { return @{ ok = $false; reason = "moments_window_not_found" } }
  [uint32]$windowProcessId = 0
  [void][Win32WechatMomentsAction]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
  $process = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
  if ($process -eq $null -or $windowProcessId -ne $expectedPid -or @("Weixin", "WeChat") -notcontains $process.ProcessName) {
    return @{ ok = $false; reason = "moments_window_identity_mismatch" }
  }
  $titleText = New-Object System.Text.StringBuilder 128
  [void][Win32WechatMomentsAction]::GetWindowText($hWnd, $titleText, $titleText.Capacity)
  $classText = New-Object System.Text.StringBuilder 256
  [void][Win32WechatMomentsAction]::GetClassName($hWnd, $classText, $classText.Capacity)
  if ($titleText.ToString().Trim() -cne $expectedTitle -or $classText.ToString().Trim() -cne $expectedClassName) {
    return @{ ok = $false; reason = "moments_window_identity_mismatch" }
  }
  $windowWin32Rect = New-Object Win32WechatMomentsAction+RECT
  if (-not [Win32WechatMomentsAction]::GetWindowRect($hWnd, [ref]$windowWin32Rect)) { return @{ ok = $false; reason = "moments_window_identity_mismatch" } }
  $windowWin32Width = [double]($windowWin32Rect.Right - $windowWin32Rect.Left)
  $windowWin32Height = [double]($windowWin32Rect.Bottom - $windowWin32Rect.Top)
  if ($windowWin32Width -lt 300 -or $windowWin32Height -lt 300) {
    return @{ ok = $false; reason = "moments_window_identity_mismatch" }
  }
  if ([Math]::Abs($windowWin32Rect.Left - $expectedLeft) -gt 3 -or
    [Math]::Abs($windowWin32Rect.Top - $expectedTop) -gt 3 -or
    [Math]::Abs($windowWin32Width - $expectedWidth) -gt 3 -or
    [Math]::Abs($windowWin32Height - $expectedHeight) -gt 3) {
    return @{ ok = $false; reason = "moments_window_geometry_changed" }
  }
  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd) } catch { $root = $null }
  if ($root -eq $null) {
    return @{ ok = $false; reason = "moments_window_identity_mismatch" }
  }
  try {
    $rootAutomationId = [string]$root.Current.AutomationId
    $rootName = [string]$root.Current.Name
    $rootControlType = [string]$root.Current.ControlType.ProgrammaticName
    $rootProcessId = [int]$root.Current.ProcessId
    $rootIsEnabled = $root.Current.IsEnabled
    $rootIsOffscreen = $root.Current.IsOffscreen
    $windowRect = $root.Current.BoundingRectangle
  } catch { return @{ ok = $false; reason = "moments_window_identity_mismatch" } }
  if ($rootProcessId -ne $expectedPid -or $rootAutomationId -cne $expectedRootAutomationId -or $rootName -cne $expectedRootName -or
    $rootControlType -cne $expectedRootControlType -or -not $rootIsEnabled -or $rootIsOffscreen -or
    -not (Test-FinitePositiveRect $windowRect) -or $windowRect.Width -lt 300 -or $windowRect.Height -lt 300) {
    return @{ ok = $false; reason = "moments_window_identity_mismatch" }
  }
  $windowScaleX = [double]$windowRect.Width / $windowWin32Width
  $windowScaleY = [double]$windowRect.Height / $windowWin32Height
  if ($windowScaleX -lt 0.9 -or $windowScaleX -gt 3.0 -or $windowScaleY -lt 0.9 -or $windowScaleY -gt 3.0 -or
    [Math]::Abs($windowScaleX - $windowScaleY) -gt 0.05) {
    return @{ ok = $false; reason = "moments_window_identity_mismatch" }
  }
  $feedCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $expectedFeedAutomationId)
  $feeds = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $feedCondition)
  if ($feeds.Count -eq 0) { return @{ ok = $false; reason = "moments_feed_not_found" } }
  if ($feeds.Count -ne 1) { return @{ ok = $false; reason = "moments_feed_ambiguous" } }
  $feed = $feeds.Item(0)
  if ((Get-RuntimeId $feed) -cne $expectedFeedRuntimeId) { return @{ ok = $false; reason = "moments_post_changed" } }
  try { $feedRect = $feed.Current.BoundingRectangle } catch { return @{ ok = $false; reason = "moments_feed_not_found" } }
  $listItemCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
  $items = $feed.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listItemCondition)
  $matches = New-Object System.Collections.Generic.List[object]
  for ($index = 0; $index -lt $items.Count; $index++) {
    $item = $items.Item($index)
    if ((Get-TopLevelFeedItemDepth $feed $item) -lt 1) { continue }
    if ((Get-RuntimeId $item) -cne $expectedRuntimeId) { continue }
    try {
      if ($item.Current.IsOffscreen) { continue }
      $itemRect = $item.Current.BoundingRectangle
    } catch { continue }
    $text = Get-ElementText $item
    if ($expectedPrefix -and -not $text.StartsWith($expectedPrefix, [StringComparison]::Ordinal)) { continue }
    $fullyVisible = $itemRect.Left -ge ($feedRect.Left - 2) -and $itemRect.Top -ge ($feedRect.Top - 2) -and $itemRect.Right -le ($feedRect.Right + 2) -and $itemRect.Bottom -le ($feedRect.Bottom + 2)
    if (-not $fullyVisible -or $itemRect.Width -le 0 -or $itemRect.Height -lt 120) { continue }
    [void]$matches.Add(@{ element = $item; rect = $itemRect; text = $text })
  }
  if ($matches.Count -ne 1) { return @{ ok = $false; reason = "moments_post_changed" } }
  if ([Win32WechatMomentsAction]::GetForegroundWindow() -ne $hWnd) { return @{ ok = $false; reason = "moments_window_not_foreground" } }
  return @{
    ok = $true
    pid = $expectedPid
    hWnd = $hWnd
    root = $root
    feed = $feed
    feedRect = $feedRect
    item = $matches[0].element
    itemRect = $matches[0].rect
    itemText = $matches[0].text
    windowRect = $windowRect
    windowWin32Rect = $windowWin32Rect
  }
}

$script:lastVerifiedClickFailureReason = ""
$script:lastMenuCloseFailure = ""

function Test-CursorAt([int]$x, [int]$y) {
  $cursor = New-Object Win32WechatMomentsAction+POINT
  if (-not [Win32WechatMomentsAction]::GetCursorPos([ref]$cursor)) { return $false }
  return $cursor.X -eq $x -and $cursor.Y -eq $y
}

function Test-LockedMomentsRootIdentity($target) {
  if ($target -eq $null -or -not $target.ContainsKey("hWnd") -or -not $target.ContainsKey("pid") -or
    -not $target.ContainsKey("root") -or [int]$target.pid -le 0 -or $target.root -eq $null) { return $false }
  $hWnd = [IntPtr]$target.hWnd
  if ($hWnd -eq [IntPtr]::Zero -or -not [Win32WechatMomentsAction]::IsWindowVisible($hWnd) -or
    [Win32WechatMomentsAction]::GetAncestor($hWnd, 2) -ne $hWnd) { return $false }
  [uint32]$currentPid = 0
  $threadId = [Win32WechatMomentsAction]::GetWindowThreadProcessId($hWnd, [ref]$currentPid)
  if ($threadId -eq 0 -or $currentPid -ne [int]$target.pid) { return $false }
  $titleText = New-Object System.Text.StringBuilder 128
  $titleLength = [Win32WechatMomentsAction]::GetWindowText($hWnd, $titleText, $titleText.Capacity)
  if ($titleLength -le 0 -or $titleText.ToString().Trim() -cne "朋友圈") { return $false }
  $win32Rect = New-Object Win32WechatMomentsAction+RECT
  if (-not [Win32WechatMomentsAction]::GetWindowRect($hWnd, [ref]$win32Rect) -or
    ($win32Rect.Right - $win32Rect.Left) -lt 300 -or ($win32Rect.Bottom - $win32Rect.Top) -lt 300) { return $false }
  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd) } catch { return $false }
  if ($root -eq $null) { return $false }
  try {
    $sameRoot = [System.Windows.Automation.Automation]::Compare($root, $target.root)
    $rootAutomationId = [string]$root.Current.AutomationId
    $rootName = [string]$root.Current.Name
    $rootControlType = [string]$root.Current.ControlType.ProgrammaticName
    $rootProcessId = [int]$root.Current.ProcessId
    $rootIsEnabled = $root.Current.IsEnabled
    $rootIsOffscreen = $root.Current.IsOffscreen
    $rootRect = $root.Current.BoundingRectangle
  } catch { return $false }
  $identityMode = [string]$env:XIAOXI_MOMENTS_IDENTITY_MODE
  $automationIdMatches = ($identityMode -ceq "automation_id" -and $rootAutomationId -ceq "SNSWindow") -or
    ($identityMode -ceq "structural_sns_feed" -and $rootAutomationId -ceq "")
  return $sameRoot -and $rootProcessId -eq [int]$target.pid -and
    $automationIdMatches -and $rootName -ceq "朋友圈" -and
    $rootControlType -ceq "ControlType.Window" -and $rootIsEnabled -and -not $rootIsOffscreen -and
    (Test-FinitePositiveRect $rootRect) -and $rootRect.Width -ge 300 -and $rootRect.Height -ge 300
}

function Invoke-MomentsMenuEscapeDismiss($target, [IntPtr]$knownPopup) {
  if ($target -eq $null -or $knownPopup -eq [IntPtr]::Zero -or $knownPopup -eq $target.hWnd -or
    -not [Win32WechatMomentsAction]::IsWindowVisible($knownPopup) -or
    -not (Test-WindowOwnedByLockedMoments $knownPopup $target) -or
    -not (Test-LockedMomentsRootIdentity $target)) { return $false }
  $foreground = [Win32WechatMomentsAction]::GetForegroundWindow()
  if ($foreground -ne $target.hWnd -and $foreground -ne $knownPopup) { return $false }
  $confirmedForeground = [Win32WechatMomentsAction]::GetForegroundWindow()
  if (($confirmedForeground -ne $target.hWnd -and $confirmedForeground -ne $knownPopup) -or
    -not [Win32WechatMomentsAction]::IsWindowVisible($knownPopup) -or
    -not (Test-WindowOwnedByLockedMoments $knownPopup $target) -or
    -not (Test-LockedMomentsRootIdentity $target)) { return $false }
  [Win32WechatMomentsAction]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
  [Win32WechatMomentsAction]::keybd_event(0x1B, 0, 0x0002, [UIntPtr]::Zero)
  return $true
}

function Get-TopLevelWindowHandle([IntPtr]$hWnd) {
  if ($hWnd -eq [IntPtr]::Zero) { return [IntPtr]::Zero }
  $root = [Win32WechatMomentsAction]::GetAncestor($hWnd, 2)
  if ($root -eq [IntPtr]::Zero) { return $hWnd }
  return $root
}

function Test-WindowOwnedByLockedMoments([IntPtr]$candidateHWnd, $target) {
  if ($target -eq $null -or $candidateHWnd -eq [IntPtr]::Zero) { return $false }
  $cursor = Get-TopLevelWindowHandle $candidateHWnd
  for ($depth = 0; $depth -lt 8 -and $cursor -ne [IntPtr]::Zero; $depth++) {
    [uint32]$cursorPid = 0
    [void][Win32WechatMomentsAction]::GetWindowThreadProcessId($cursor, [ref]$cursorPid)
    if ($cursorPid -ne [int]$target.pid) { return $false }
    if ($cursor -eq $target.hWnd) { return $true }
    $owner = [Win32WechatMomentsAction]::GetWindow($cursor, 4)
    if ($owner -eq [IntPtr]::Zero) { return $false }
    $ownerRoot = Get-TopLevelWindowHandle $owner
    if ($ownerRoot -eq [IntPtr]::Zero -or $ownerRoot -eq $cursor) { return $false }
    $cursor = $ownerRoot
  }
  return $false
}

function Get-OwnedMomentsPopupHandlesNearMenu($target, [int]$menuX, [int]$menuY) {
  $handles = @{}
  foreach ($xOffset in @(24, 48, 72, 96, 120, 144, 168, 192, 216, 240)) {
    foreach ($yOffset in @(-12, 0, 12)) {
      $x = $menuX - $xOffset
      $y = $menuY + $yOffset
      if ($x -le $target.windowRect.Left -or $x -ge $target.windowRect.Right -or
        $y -le $target.windowRect.Top -or $y -ge $target.windowRect.Bottom) { continue }
      $point = New-Object Win32WechatMomentsAction+POINT
      $point.X = $x
      $point.Y = $y
      $root = Get-TopLevelWindowHandle ([Win32WechatMomentsAction]::WindowFromPoint($point))
      if ($root -eq [IntPtr]::Zero -or $root -eq $target.hWnd -or
        -not (Test-WindowOwnedByLockedMoments $root $target)) { continue }
      $handles[[string][int64]$root] = $root
    }
  }
  return @($handles.Values)
}

function Get-MenuButtonsByPoint($target, [IntPtr]$popupHWnd) {
  $popupWin32Rect = New-Object Win32WechatMomentsAction+RECT
  if (-not [Win32WechatMomentsAction]::GetWindowRect($popupHWnd, [ref]$popupWin32Rect)) { return @() }
  $popupWin32Width = [double]($popupWin32Rect.Right - $popupWin32Rect.Left)
  $popupWin32Height = [double]($popupWin32Rect.Bottom - $popupWin32Rect.Top)
  if ($popupWin32Width -lt 120 -or $popupWin32Width -gt 320 -or $popupWin32Height -lt 24 -or $popupWin32Height -gt 90) { return @() }
  try {
    $popupElement = [System.Windows.Automation.AutomationElement]::FromHandle($popupHWnd)
    $popupProcessId = [int]$popupElement.Current.ProcessId
    $popupIsEnabled = $popupElement.Current.IsEnabled
    $popupIsOffscreen = $popupElement.Current.IsOffscreen
    $popupRect = $popupElement.Current.BoundingRectangle
  } catch { return @() }
  if ($popupElement -eq $null -or $popupProcessId -ne [int]$target.pid -or
    -not $popupIsEnabled -or $popupIsOffscreen -or -not (Test-FinitePositiveRect $popupRect)) { return @() }
  $popupWidth = [double]$popupRect.Width
  $popupHeight = [double]$popupRect.Height
  $scaleX = $popupWidth / $popupWin32Width
  $scaleY = $popupHeight / $popupWin32Height
  if ($scaleX -lt 0.9 -or $scaleX -gt 3.0 -or $scaleY -lt 0.9 -or $scaleY -gt 3.0 -or
    [Math]::Abs($scaleX - $scaleY) -gt 0.05) { return @() }
  $target["menuPopupRect"] = $popupRect
  $buttons = @{}
  foreach ($yFraction in @(0.5, 0.35, 0.65)) {
    foreach ($xFraction in @(0.25, 0.75, 0.12, 0.38, 0.62, 0.88)) {
      $x = [int][Math]::Round([double]$popupRect.Left + ($popupWidth * $xFraction))
      $y = [int][Math]::Round([double]$popupRect.Top + ($popupHeight * $yFraction))
      $point = New-Object Win32WechatMomentsAction+POINT
      $point.X = $x
      $point.Y = $y
      $pointRoot = Get-TopLevelWindowHandle ([Win32WechatMomentsAction]::WindowFromPoint($point))
      if ($pointRoot -ne $popupHWnd) { continue }
      try { $element = [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($x, $y))) } catch { $element = $null }
      if ($element -eq $null) { continue }
      foreach ($walker in @(
        [System.Windows.Automation.TreeWalker]::RawViewWalker,
        [System.Windows.Automation.TreeWalker]::ControlViewWalker
      )) {
        $cursor = $element
        for ($depth = 0; $depth -lt 8 -and $cursor -ne $null; $depth++) {
          try {
            $name = Normalize-Text ([string]$cursor.Current.Name)
            $controlType = $cursor.Current.ControlType
            $processId = [int]$cursor.Current.ProcessId
            $isEnabled = $cursor.Current.IsEnabled
            $isOffscreen = $cursor.Current.IsOffscreen
            $rect = $cursor.Current.BoundingRectangle
          } catch { $controlType = $null }
          if ($controlType -eq [System.Windows.Automation.ControlType]::Button -and
            @("赞", "取消", "取消赞", "评论") -contains $name -and
            $processId -eq [int]$target.pid -and $isEnabled -and -not $isOffscreen -and
            $rect.Width -gt 0 -and $rect.Height -gt 0 -and
            $rect.Left -ge ($popupRect.Left - 2) -and $rect.Top -ge ($popupRect.Top - 2) -and
            $rect.Right -le ($popupRect.Right + 2) -and $rect.Bottom -le ($popupRect.Bottom + 2)) {
            $runtimeId = Get-RuntimeId $cursor
            if ($runtimeId) { $buttons[$runtimeId] = @{ element = $cursor; name = $name; rect = $rect; rootHWnd = $popupHWnd; runtimeId = $runtimeId } }
          }
          try { $cursor = $walker.GetParent($cursor) } catch { $cursor = $null }
        }
      }
      $sampledButtons = @($buttons.Values)
      $sampledLikeCount = @($sampledButtons | Where-Object { @("赞", "取消", "取消赞") -contains $_.name }).Count
      $sampledCommentCount = @($sampledButtons | Where-Object { $_.name -eq "评论" }).Count
      if ($sampledLikeCount -eq 1 -and $sampledCommentCount -eq 1) { return $sampledButtons }
    }
  }
  return @($buttons.Values)
}

function Get-MomentsOpenMenuProof($target, [IntPtr]$popupHWnd) {
  if ($target -eq $null -or $popupHWnd -eq [IntPtr]::Zero -or $popupHWnd -eq $target.hWnd -or
    -not [Win32WechatMomentsAction]::IsWindowVisible($popupHWnd) -or
    -not (Test-WindowOwnedByLockedMoments $popupHWnd $target)) {
    return @{ ok = $false; reason = "moments_menu_ambiguous"; likeCount = 0; commentCount = 0 }
  }
  $entries = @(Get-MenuButtonsByPoint $target $popupHWnd)
  $likeEntries = @($entries | Where-Object { @("赞", "取消", "取消赞") -contains $_.name })
  $commentEntries = @($entries | Where-Object { $_.name -eq "评论" })
  if ($likeEntries.Count -ne 1 -or $commentEntries.Count -ne 1 -or $likeEntries[0].rootHWnd -ne $commentEntries[0].rootHWnd) {
    return @{ ok = $false; reason = "moments_menu_ambiguous"; likeCount = $likeEntries.Count; commentCount = $commentEntries.Count }
  }
  $popupRect = $target.menuPopupRect
  $popupWidth = [double]($popupRect.Right - $popupRect.Left)
  $popupHeight = [double]($popupRect.Bottom - $popupRect.Top)
  $likeRect = $likeEntries[0].rect
  $commentRect = $commentEntries[0].rect
  $coverage = [double]$likeRect.Width + [double]$commentRect.Width
  $geometryVerified = $likeRect.Left -le ($popupRect.Left + 4) -and
    $commentRect.Right -ge ($popupRect.Right - 4) -and
    $likeRect.Right -le ($commentRect.Left + 4) -and
    $coverage -ge ($popupWidth * 0.85) -and
    $likeRect.Height -ge ($popupHeight * 0.8) -and $commentRect.Height -ge ($popupHeight * 0.8)
  if (-not $geometryVerified) {
    return @{ ok = $false; reason = "moments_menu_ambiguous"; likeCount = 1; commentCount = 1 }
  }
  return @{ ok = $true; rootHWnd = $popupHWnd; like = $likeEntries[0]; comment = $commentEntries[0]; likeCount = 1; commentCount = 1 }
}

function Invoke-VerifiedClick([int]$x, [int]$y, [int]$expectedPid, [IntPtr]$expectedHWnd, [bool]$enforceDeadline = $false) {
  $script:lastVerifiedClickFailureReason = ""
  $point = New-Object Win32WechatMomentsAction+POINT
  $point.X = $x
  $point.Y = $y
  $hit = [Win32WechatMomentsAction]::WindowFromPoint($point)
  if ($hit -eq [IntPtr]::Zero) { return $false }
  $hitRoot = [Win32WechatMomentsAction]::GetAncestor($hit, 2)
  if ($hitRoot -eq [IntPtr]::Zero -or $hitRoot -ne $expectedHWnd) { return $false }
  [uint32]$hitPid = 0
  [void][Win32WechatMomentsAction]::GetWindowThreadProcessId($hitRoot, [ref]$hitPid)
  if ($hitPid -ne $expectedPid) { return $false }
  if (-not [Win32WechatMomentsAction]::SetCursorPos($x, $y)) { return $false }
  Start-Sleep -Milliseconds 20
  $confirmedHit = [Win32WechatMomentsAction]::WindowFromPoint($point)
  if ($confirmedHit -eq [IntPtr]::Zero) { return $false }
  $confirmedRoot = [Win32WechatMomentsAction]::GetAncestor($confirmedHit, 2)
  if ($confirmedRoot -ne $expectedHWnd -or [Win32WechatMomentsAction]::GetForegroundWindow() -ne $expectedHWnd) { return $false }
  [uint32]$confirmedPid = 0
  [void][Win32WechatMomentsAction]::GetWindowThreadProcessId($confirmedRoot, [ref]$confirmedPid)
  if ($confirmedPid -ne $expectedPid) { return $false }
  if ($enforceDeadline -and -not (Test-ActionDeadline)) {
    $script:lastVerifiedClickFailureReason = "moments_dry_run_expired"
    return $false
  }
  if (-not [Win32WechatMomentsAction]::SetCursorPos($x, $y)) { return $false }
  $finalRoot = [Win32WechatMomentsAction]::GetAncestor([Win32WechatMomentsAction]::WindowFromPoint($point), 2)
  if ($finalRoot -ne $expectedHWnd -or [Win32WechatMomentsAction]::GetForegroundWindow() -ne $expectedHWnd -or
    -not (Test-CursorAt $x $y)) { return $false }
  [Win32WechatMomentsAction]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [Win32WechatMomentsAction]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  return $true
}

function Set-MomentsMenuAnchor($target) {
  if ($target -eq $null) { return $false }
  $xOffset = [Math]::Max(24, [Math]::Min(80, [Math]::Round($target.itemRect.Width * 0.09)))
  $yOffset = [Math]::Max(14, [Math]::Min(22, [Math]::Round($target.itemRect.Height * 0.04)))
  $menuX = [int][Math]::Round($target.itemRect.Right - $xOffset)
  $menuY = [int][Math]::Round($target.itemRect.Bottom - $yOffset)
  if ($menuX -le $target.feedRect.Left -or $menuX -ge $target.feedRect.Right -or
    $menuY -le $target.feedRect.Top -or $menuY -ge $target.feedRect.Bottom) { return $false }
  $target["menuX"] = $menuX
  $target["menuY"] = $menuY
  $target["menuAnchorRuntimeId"] = Get-RuntimeId $target.item
  return -not [string]::IsNullOrWhiteSpace([string]$target.menuAnchorRuntimeId) -and (Test-MomentsMenuAnchorPoint $target)
}

function Test-MomentsMenuAnchorPoint($target) {
  if ($target -eq $null -or -not $target.ContainsKey("menuX") -or -not $target.ContainsKey("menuY") -or
    -not $target.ContainsKey("menuAnchorRuntimeId")) { return $false }
  $xOffset = [Math]::Max(24, [Math]::Min(80, [Math]::Round($target.itemRect.Width * 0.09)))
  $yOffset = [Math]::Max(14, [Math]::Min(22, [Math]::Round($target.itemRect.Height * 0.04)))
  $x = [int]$target.menuX
  $y = [int]$target.menuY
  $expectedX = [int][Math]::Round($target.itemRect.Right - $xOffset)
  $expectedY = [int][Math]::Round($target.itemRect.Bottom - $yOffset)
  if ($x -ne $expectedX -or $y -ne $expectedY) { return $false }
  $point = New-Object Win32WechatMomentsAction+POINT
  $point.X = $x
  $point.Y = $y
  $hitRoot = Get-TopLevelWindowHandle ([Win32WechatMomentsAction]::WindowFromPoint($point))
  if ($hitRoot -ne $target.hWnd) { return $false }
  [uint32]$hitPid = 0
  [void][Win32WechatMomentsAction]::GetWindowThreadProcessId($hitRoot, [ref]$hitPid)
  if ($hitPid -ne [int]$target.pid) { return $false }
  try { $element = [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($x, $y))) } catch { return $false }
  if ($element -eq $null) { return $false }
  try {
    $isTargetItem = [System.Windows.Automation.Automation]::Compare($element, $target.item)
    $processId = [int]$element.Current.ProcessId
    $controlType = $element.Current.ControlType
    $isEnabled = $element.Current.IsEnabled
    $isOffscreen = $element.Current.IsOffscreen
    $rect = $element.Current.BoundingRectangle
  } catch { return $false }
  return $isTargetItem -and $processId -eq [int]$target.pid -and
    $controlType -eq [System.Windows.Automation.ControlType]::ListItem -and
    $isEnabled -and -not $isOffscreen -and (Test-FinitePositiveRect $rect) -and
    (Get-RuntimeId $element) -ceq [string]$target.menuAnchorRuntimeId -and
    [Math]::Abs($rect.Left - $target.itemRect.Left) -le 2 -and
    [Math]::Abs($rect.Top - $target.itemRect.Top) -le 2 -and
    [Math]::Abs($rect.Right - $target.itemRect.Right) -le 2 -and
    [Math]::Abs($rect.Bottom - $target.itemRect.Bottom) -le 2 -and
    $x -ge $rect.Left -and $x -le $rect.Right -and $y -ge $rect.Top -and $y -le $rect.Bottom
}

function Invoke-MomentsMenuToggleClick($target) {
  $foreground = [Win32WechatMomentsAction]::GetForegroundWindow()
  $knownPopup = [IntPtr]::Zero
  if ($target.ContainsKey("menuRootHWnd")) { $knownPopup = [IntPtr]$target.menuRootHWnd }
  if ($foreground -ne $target.hWnd -and ($knownPopup -eq [IntPtr]::Zero -or $foreground -ne $knownPopup)) { return $false }
  if (-not (Test-MomentsMenuAnchorPoint $target)) { return $false }
  $x = [int]$target.menuX
  $y = [int]$target.menuY
  if (-not [Win32WechatMomentsAction]::SetCursorPos($x, $y)) { return $false }
  Start-Sleep -Milliseconds 20
  $confirmedForeground = [Win32WechatMomentsAction]::GetForegroundWindow()
  if (($confirmedForeground -ne $target.hWnd -and ($knownPopup -eq [IntPtr]::Zero -or $confirmedForeground -ne $knownPopup)) -or
    -not (Test-MomentsMenuAnchorPoint $target)) { return $false }
  if (-not [Win32WechatMomentsAction]::SetCursorPos($x, $y)) { return $false }
  $finalPoint = New-Object Win32WechatMomentsAction+POINT
  $finalPoint.X = $x
  $finalPoint.Y = $y
  $finalRoot = Get-TopLevelWindowHandle ([Win32WechatMomentsAction]::WindowFromPoint($finalPoint))
  $finalForeground = [Win32WechatMomentsAction]::GetForegroundWindow()
  if ($finalRoot -ne $target.hWnd -or
    ($finalForeground -ne $target.hWnd -and ($knownPopup -eq [IntPtr]::Zero -or $finalForeground -ne $knownPopup)) -or
    -not (Test-CursorAt $x $y)) { return $false }
  [Win32WechatMomentsAction]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [Win32WechatMomentsAction]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  return $true
}

function Test-MomentsPopupEntryPoint($entry, $target) {
  if ($entry -eq $null -or [string]::IsNullOrWhiteSpace([string]$entry.runtimeId) -or
    @("赞", "取消", "取消赞", "评论") -notcontains [string]$entry.name) { return $false }
  $expectedRootHWnd = [IntPtr]$entry.rootHWnd
  if ($expectedRootHWnd -eq [IntPtr]::Zero -or -not [Win32WechatMomentsAction]::IsWindowVisible($expectedRootHWnd) -or
    -not (Test-WindowOwnedByLockedMoments $expectedRootHWnd $target)) { return $false }
  $x = [int][Math]::Round(($entry.rect.Left + $entry.rect.Right) / 2)
  $y = [int][Math]::Round(($entry.rect.Top + $entry.rect.Bottom) / 2)
  $point = New-Object Win32WechatMomentsAction+POINT
  $point.X = $x
  $point.Y = $y
  $hitRoot = Get-TopLevelWindowHandle ([Win32WechatMomentsAction]::WindowFromPoint($point))
  if ($hitRoot -ne $expectedRootHWnd) { return $false }
  try { $element = [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($x, $y))) } catch { return $false }
  if ($element -eq $null) { return $false }
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $cursor = $element
  for ($depth = 0; $depth -lt 8 -and $cursor -ne $null; $depth++) {
    try {
      $processId = [int]$cursor.Current.ProcessId
      $controlType = $cursor.Current.ControlType
    } catch { return $false }
    if ($processId -ne [int]$target.pid) { return $false }
    if ($controlType -eq [System.Windows.Automation.ControlType]::Button) {
      try {
        $name = Normalize-Text ([string]$cursor.Current.Name)
        $isEnabled = $cursor.Current.IsEnabled
        $isOffscreen = $cursor.Current.IsOffscreen
        $rect = $cursor.Current.BoundingRectangle
      } catch { return $false }
      if ($name -ceq [string]$entry.name -and (Get-RuntimeId $cursor) -ceq [string]$entry.runtimeId -and
        $isEnabled -and -not $isOffscreen -and (Test-FinitePositiveRect $rect) -and
        [Math]::Abs($rect.Left - $entry.rect.Left) -le 2 -and [Math]::Abs($rect.Top - $entry.rect.Top) -le 2 -and
        [Math]::Abs($rect.Right - $entry.rect.Right) -le 2 -and [Math]::Abs($rect.Bottom - $entry.rect.Bottom) -le 2 -and
        $x -ge $rect.Left -and $x -le $rect.Right -and $y -ge $rect.Top -and $y -le $rect.Bottom) { return $true }
    }
    try { $cursor = $walker.GetParent($cursor) } catch { return $false }
  }
  return $false
}

function Invoke-VerifiedOwnedPopupClick($entry, $target, [bool]$enforceDeadline = $false) {
  $script:lastVerifiedClickFailureReason = ""
  $expectedRootHWnd = [IntPtr]$entry.rootHWnd
  if ($expectedRootHWnd -eq [IntPtr]::Zero -or -not (Test-WindowOwnedByLockedMoments $expectedRootHWnd $target)) { return $false }
  $foreground = [Win32WechatMomentsAction]::GetForegroundWindow()
  if ($foreground -ne $target.hWnd -and $foreground -ne $expectedRootHWnd) { return $false }
  if (-not (Test-MomentsPopupEntryPoint $entry $target)) { return $false }
  $x = [int][Math]::Round(($entry.rect.Left + $entry.rect.Right) / 2)
  $y = [int][Math]::Round(($entry.rect.Top + $entry.rect.Bottom) / 2)
  $point = New-Object Win32WechatMomentsAction+POINT
  $point.X = $x
  $point.Y = $y
  $hit = [Win32WechatMomentsAction]::WindowFromPoint($point)
  $hitRoot = Get-TopLevelWindowHandle $hit
  if ($hitRoot -ne $expectedRootHWnd -or -not (Test-WindowOwnedByLockedMoments $hitRoot $target)) { return $false }
  [uint32]$hitPid = 0
  [void][Win32WechatMomentsAction]::GetWindowThreadProcessId($hitRoot, [ref]$hitPid)
  if ($hitPid -ne [int]$target.pid) { return $false }
  if (-not [Win32WechatMomentsAction]::SetCursorPos($x, $y)) { return $false }
  Start-Sleep -Milliseconds 20
  $confirmedHit = [Win32WechatMomentsAction]::WindowFromPoint($point)
  $confirmedRoot = Get-TopLevelWindowHandle $confirmedHit
  $confirmedForeground = [Win32WechatMomentsAction]::GetForegroundWindow()
  if ($confirmedRoot -ne $expectedRootHWnd -or
    -not (Test-WindowOwnedByLockedMoments $confirmedRoot $target) -or
    ($confirmedForeground -ne $target.hWnd -and $confirmedForeground -ne $expectedRootHWnd) -or
    -not (Test-MomentsPopupEntryPoint $entry $target)) { return $false }
  if ($enforceDeadline -and -not (Test-ActionDeadline)) {
    $script:lastVerifiedClickFailureReason = "moments_dry_run_expired"
    return $false
  }
  if (-not [Win32WechatMomentsAction]::SetCursorPos($x, $y)) { return $false }
  $finalRoot = Get-TopLevelWindowHandle ([Win32WechatMomentsAction]::WindowFromPoint($point))
  $finalForeground = [Win32WechatMomentsAction]::GetForegroundWindow()
  if ($finalRoot -ne $expectedRootHWnd -or
    ($finalForeground -ne $target.hWnd -and $finalForeground -ne $expectedRootHWnd) -or
    -not (Test-CursorAt $x $y)) { return $false }
  [Win32WechatMomentsAction]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [Win32WechatMomentsAction]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  return $true
}

function Get-VisibleMomentsInteractionButtonCounts($target) {
  $buttonCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  )
  $roots = New-Object System.Collections.Generic.List[object]
  $rootHandles = @{}
  if ($target.ContainsKey("menuRootHWnd")) {
    $knownPopup = [IntPtr]$target.menuRootHWnd
    if ($knownPopup -ne [IntPtr]::Zero -and $knownPopup -ne $target.hWnd -and
      [Win32WechatMomentsAction]::IsWindowVisible($knownPopup) -and
      (Test-WindowOwnedByLockedMoments $knownPopup $target)) {
      $rootHandles[[string][int64]$knownPopup] = $knownPopup
    }
  }
  $foreground = [Win32WechatMomentsAction]::GetForegroundWindow()
  if ((Test-WindowOwnedByLockedMoments $foreground $target)) {
    $foregroundRoot = Get-TopLevelWindowHandle $foreground
    if ($foregroundRoot -ne [IntPtr]::Zero -and $foregroundRoot -ne $target.hWnd) {
      $rootHandles[[string][int64]$foregroundRoot] = $foregroundRoot
    }
  }
  foreach ($rootHandle in $rootHandles.Values) {
    try {
      $popupRoot = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$rootHandle)
      if ($popupRoot -ne $null) { [void]$roots.Add($popupRoot) }
    } catch {}
  }
  $like = @{}
  $comment = @{}
  foreach ($scanRoot in $roots) {
    try { $buttons = $scanRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition) } catch { continue }
    for ($index = 0; $index -lt $buttons.Count; $index++) {
      $button = $buttons.Item($index)
      try {
        $name = Normalize-Text ([string]$button.Current.Name)
        if (@("赞", "取消", "取消赞", "评论") -notcontains $name -or
          [int]$button.Current.ProcessId -ne [int]$target.pid -or
          $button.Current.IsOffscreen -or -not $button.Current.IsEnabled) { continue }
        $rect = $button.Current.BoundingRectangle
      } catch { continue }
      if (-not (Test-RectInsideLockedWindow $rect $target.windowRect)) { continue }
      $runtimeId = Get-RuntimeId $button
      $key = if ($runtimeId) { $runtimeId } else { "$name|$([Math]::Round($rect.Left))|$([Math]::Round($rect.Top))|$([Math]::Round($rect.Width))|$([Math]::Round($rect.Height))" }
      if ($name -eq "评论") { $comment[$key] = $true } else { $like[$key] = $true }
    }
  }
  return @{ likeCount = $like.Count; commentCount = $comment.Count }
}

function Close-MomentsMenu($target) {
  $script:lastMenuCloseFailure = ""
  if ($target -eq $null) { $script:lastMenuCloseFailure = "target_missing"; return $false }
  $foregroundBefore = [Win32WechatMomentsAction]::GetForegroundWindow()
  if (-not (Test-WindowOwnedByLockedMoments $foregroundBefore $target)) { $script:lastMenuCloseFailure = "foreground_untrusted"; return $false }
  $knownPopup = [IntPtr]::Zero
  if ($target.ContainsKey("menuRootHWnd")) { $knownPopup = [IntPtr]$target.menuRootHWnd }
  if ($knownPopup -eq [IntPtr]::Zero -or $knownPopup -eq $target.hWnd -or
    -not [Win32WechatMomentsAction]::IsWindowVisible($knownPopup) -or
    -not (Test-WindowOwnedByLockedMoments $knownPopup $target)) { $script:lastMenuCloseFailure = "popup_untrusted"; return $false }
  if (-not $target.ContainsKey("menuX") -or -not $target.ContainsKey("menuY")) { $script:lastMenuCloseFailure = "anchor_missing"; return $false }
  $menuProof = Get-MomentsOpenMenuProof $target $knownPopup
  if (-not $menuProof.ok) { $script:lastMenuCloseFailure = "proof_invalid"; return $false }
  if (-not (Invoke-MomentsMenuEscapeDismiss $target $knownPopup)) { $script:lastMenuCloseFailure = "escape_blocked"; return $false }
  $popupHidden = $false
  for ($attempt = 0; $attempt -lt 8; $attempt++) {
    Start-Sleep -Milliseconds 80
    if (-not [Win32WechatMomentsAction]::IsWindowVisible($knownPopup)) { $popupHidden = $true; break }
  }
  if (-not $popupHidden) { $script:lastMenuCloseFailure = "popup_still_visible"; return $false }
  if (-not (Test-LockedMomentsRootIdentity $target)) { $script:lastMenuCloseFailure = "root_identity_changed"; return $false }
  if ([Win32WechatMomentsAction]::GetForegroundWindow() -ne $target.hWnd) { $script:lastMenuCloseFailure = "foreground_not_restored"; return $false }
  $remainingPopups = @(Get-OwnedMomentsPopupHandlesNearMenu $target ([int]$target.menuX) ([int]$target.menuY))
  if ($remainingPopups.Count -ne 0) { $script:lastMenuCloseFailure = "popup_remaining"; return $false }
  $counts = Get-VisibleMomentsInteractionButtonCounts $target
  if ($counts.likeCount -ne 0 -or $counts.commentCount -ne 0) { $script:lastMenuCloseFailure = "buttons_remaining"; return $false }
  return $true
}

function Get-MomentsMenuCloseReason {
  if ([string]::IsNullOrWhiteSpace([string]$script:lastMenuCloseFailure)) { return "moments_menu_close_unverified" }
  return "moments_menu_close_$($script:lastMenuCloseFailure)"
}

function Open-MomentsMenu($target) {
  if (-not (Set-MomentsMenuAnchor $target)) { return @{ ok = $false; reason = "moments_menu_anchor_invalid" } }
  $menuX = [int]$target.menuX
  $menuY = [int]$target.menuY
  if (-not (Invoke-MomentsMenuToggleClick $target)) { return @{ ok = $false; reason = "moments_menu_click_blocked" } }
  Start-Sleep -Milliseconds 220
  $menuForeground = [Win32WechatMomentsAction]::GetForegroundWindow()
  if (-not (Test-WindowOwnedByLockedMoments $menuForeground $target)) {
    return @{ ok = $false; reason = "moments_menu_window_untrusted" }
  }
  $popupHandles = @(Get-OwnedMomentsPopupHandlesNearMenu $target $menuX $menuY)
  if ($popupHandles.Count -ne 1) {
    $closed = Close-MomentsMenu $target
    return @{ ok = $false; reason = $(if ($closed) { "moments_menu_ambiguous" } else { Get-MomentsMenuCloseReason }); popupCount = $popupHandles.Count }
  }
  $popupHWnd = [IntPtr]$popupHandles[0]
  $target["menuRootHWnd"] = $popupHWnd
  $proof = Get-MomentsOpenMenuProof $target $popupHWnd
  if (-not $proof.ok) {
    $closed = Close-MomentsMenu $target
    return @{ ok = $false; reason = $(if ($closed) { $proof.reason } else { Get-MomentsMenuCloseReason }); likeCount = $proof.likeCount; commentCount = $proof.commentCount }
  }
  $target["menuRootHWnd"] = [IntPtr]$proof.rootHWnd
  return @{
    ok = $true
    menuX = $menuX
    menuY = $menuY
    rootHWnd = [IntPtr]$proof.rootHWnd
    like = $proof.like
    comment = $proof.comment
  }
}

function Invoke-MenuEntry($entry, $target, [bool]$enforceDeadline = $false) {
  return Invoke-VerifiedOwnedPopupClick $entry $target $enforceDeadline
}

function Test-RectInsideLockedWindow($rect, $windowRect) {
  return $rect.Width -gt 0 -and $rect.Height -gt 0 -and
    $rect.Left -ge $windowRect.Left -and $rect.Top -ge $windowRect.Top -and
    $rect.Right -le $windowRect.Right -and $rect.Bottom -le $windowRect.Bottom
}

function Test-ElementInLockedRoot(
  [System.Windows.Automation.AutomationElement]$root,
  [System.Windows.Automation.AutomationElement]$element
) {
  if ($root -eq $null -or $element -eq $null) { return $false }
  try {
    if ([System.Windows.Automation.Automation]::Compare($root, $element)) { return $true }
  } catch { return $false }
  foreach ($walker in @(
    [System.Windows.Automation.TreeWalker]::RawViewWalker,
    [System.Windows.Automation.TreeWalker]::ControlViewWalker
  )) {
    $cursor = $element
    for ($depth = 0; $depth -lt 64; $depth++) {
      try { $cursor = $walker.GetParent($cursor) } catch { $cursor = $null }
      if ($cursor -eq $null) { break }
      try {
        if ([System.Windows.Automation.Automation]::Compare($root, $cursor)) { return $true }
      } catch { break }
    }
  }
  return $false
}

function Get-VerifiedCommentEditorFocus($target) {
  if ([Win32WechatMomentsAction]::GetForegroundWindow() -ne $target.hWnd) {
    return @{ ok = $false; reason = "moments_window_not_foreground" }
  }
  try { $focused = [System.Windows.Automation.AutomationElement]::FocusedElement } catch { $focused = $null }
  if ($focused -eq $null -or -not (Test-ElementInLockedRoot $target.root $focused)) {
    return @{ ok = $false; reason = "moments_comment_focus_outside_locked_window" }
  }
  foreach ($walker in @(
    [System.Windows.Automation.TreeWalker]::RawViewWalker,
    [System.Windows.Automation.TreeWalker]::ControlViewWalker
  )) {
    $cursor = $focused
    for ($depth = 0; $depth -lt 32 -and $cursor -ne $null; $depth++) {
      try {
        $controlType = $cursor.Current.ControlType
        $isEditor = $controlType -eq [System.Windows.Automation.ControlType]::Edit -or
          $controlType -eq [System.Windows.Automation.ControlType]::Document
        $isOffscreen = $cursor.Current.IsOffscreen
        $isEnabled = $cursor.Current.IsEnabled
        $rect = $cursor.Current.BoundingRectangle
      } catch { $isEditor = $false }
      if ($isEditor -and $isEnabled -and -not $isOffscreen -and
        (Test-ElementInLockedRoot $target.root $cursor) -and
        (Test-RectInsideLockedWindow $rect $target.windowRect)) {
        return @{ ok = $true; element = $cursor; rect = $rect; runtimeId = (Get-RuntimeId $cursor) }
      }
      try {
        if ([System.Windows.Automation.Automation]::Compare($target.root, $cursor)) { break }
        $cursor = $walker.GetParent($cursor)
      } catch { $cursor = $null }
    }
  }
  return @{ ok = $false; reason = "moments_comment_editor_focus_invalid" }
}

function Test-CommentEditorBoundsNear($actual, $expected) {
  if ($actual -eq $null -or $expected -eq $null) { return $false }
  return [Math]::Abs([double]$actual.left - [double]$expected.left) -le 1.5 -and
    [Math]::Abs([double]$actual.top - [double]$expected.top) -le 1.5 -and
    [Math]::Abs([double]$actual.width - [double]$expected.width) -le 1.5 -and
    [Math]::Abs([double]$actual.height - [double]$expected.height) -le 1.5
}

function Get-CommentEditorCandidates($target) {
  $deduped = @{}
  try {
    $elements = $target.root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
  } catch {
    return @{ ok = $false; reason = "moments_comment_editor_targeting_unsupported"; candidates = @() }
  }
  for ($index = 0; $index -lt $elements.Count; $index++) {
    $element = $elements.Item($index)
    try {
      $current = $element.Current
      $controlType = [string]$current.ControlType.ProgrammaticName
      if (@("ControlType.Edit", "ControlType.Document") -notcontains $controlType -or
        [int]$current.ProcessId -ne [int]$target.pid -or -not $current.IsEnabled -or $current.IsOffscreen) { continue }
      $rect = $current.BoundingRectangle
      if (-not (Test-RectInsideLockedWindow $rect $target.windowRect) -or
        -not (Test-ElementInLockedRoot $target.root $element)) { continue }
      $runtimeId = Get-RuntimeId $element
      if ([string]::IsNullOrWhiteSpace($runtimeId)) { continue }
      $valuePattern = [System.Windows.Automation.ValuePattern]$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      if ($valuePattern.Current.IsReadOnly) { continue }
      $value = $valuePattern.Current.Value
      if ($null -eq $value) { continue }
      $bounds = @{
        left = [double]$rect.Left
        top = [double]$rect.Top
        width = [double]$rect.Width
        height = [double]$rect.Height
      }
    } catch { continue }
    if (-not $deduped.ContainsKey($runtimeId)) {
      $deduped[$runtimeId] = @{
        element = $element
        pattern = $valuePattern
        runtimeId = $runtimeId
        bounds = $bounds
        controlType = $controlType
        value = [string]$value
      }
    }
  }
  return @{ ok = $true; candidates = @($deduped.Values) }
}

function Get-CommentEditorProof($target, [string]$expectedRuntimeId = "", $expectedBounds = $null) {
  if ([Win32WechatMomentsAction]::GetForegroundWindow() -ne $target.hWnd) {
    return @{ ok = $false; reason = "moments_window_not_foreground" }
  }
  $scan = Get-CommentEditorCandidates $target
  if (-not $scan.ok) { return $scan }
  $candidates = @($scan.candidates)
  if ($candidates.Count -eq 0) { return @{ ok = $false; reason = "moments_comment_editor_targeting_unsupported" } }
  if ($candidates.Count -ne 1) { return @{ ok = $false; reason = "moments_comment_editor_ambiguous"; count = $candidates.Count } }
  $candidate = $candidates[0]
  $focused = Get-VerifiedCommentEditorFocus $target
  if (-not $focused.ok) { return $focused }
  $sameFocusedEditor = $false
  try { $sameFocusedEditor = [System.Windows.Automation.Automation]::Compare($candidate.element, $focused.element) } catch {}
  if (-not $sameFocusedEditor) { return @{ ok = $false; reason = "moments_comment_editor_focus_invalid" } }
  if (-not [string]::IsNullOrWhiteSpace($expectedRuntimeId) -and $candidate.runtimeId -cne $expectedRuntimeId) {
    return @{ ok = $false; reason = "moments_comment_editor_changed" }
  }
  if ($expectedBounds -ne $null -and -not (Test-CommentEditorBoundsNear $candidate.bounds $expectedBounds)) {
    return @{ ok = $false; reason = "moments_comment_editor_changed" }
  }
  return @{
    ok = $true
    element = $candidate.element
    pattern = $candidate.pattern
    runtimeId = $candidate.runtimeId
    bounds = $candidate.bounds
    controlType = $candidate.controlType
    value = $candidate.value
  }
}

function Set-CommentEditorValueExact($target, $proof, [string]$expectedCurrent, [string]$newValue) {
  $fresh = Get-CommentEditorProof $target $proof.runtimeId $proof.bounds
  if (-not $fresh.ok -or -not [String]::Equals([string]$fresh.value, $expectedCurrent, [StringComparison]::Ordinal)) {
    return @{ ok = $false; reason = "moments_comment_editor_changed"; valueSetAttempted = $false }
  }
  try {
    $fresh.pattern.SetValue($newValue)
  } catch {
    return @{ ok = $false; reason = "moments_comment_editor_targeting_unsupported"; valueSetAttempted = $true }
  }
  Start-Sleep -Milliseconds 120
  $confirmed = Get-CommentEditorProof $target $proof.runtimeId $proof.bounds
  if (-not $confirmed.ok -or -not [String]::Equals([string]$confirmed.value, $newValue, [StringComparison]::Ordinal)) {
    return @{ ok = $false; reason = "moments_comment_roundtrip_mismatch"; valueSetAttempted = $true }
  }
  return @{ ok = $true; proof = $confirmed; valueSetAttempted = $true }
}

function Clear-CommentEditorValueExact($target, $proof, [string]$expectedText) {
  $fresh = Get-CommentEditorProof $target $proof.runtimeId $proof.bounds
  if (-not $fresh.ok -or -not [String]::Equals([string]$fresh.value, $expectedText, [StringComparison]::Ordinal)) { return $false }
  try { $fresh.pattern.SetValue("") } catch { return $false }
  Start-Sleep -Milliseconds 100
  $confirmed = Get-CommentEditorProof $target $proof.runtimeId $proof.bounds
  return $confirmed.ok -and [String]::Equals([string]$confirmed.value, "", [StringComparison]::Ordinal)
}

function Close-CommentComposerNeutral($target, [string]$expectedRuntimeId = "") {
  $observedPopupHandles = @{}
  $anchorPoints = New-Object System.Collections.ArrayList
  if ($target.ContainsKey("menuX") -and $target.ContainsKey("menuY")) {
    [void]$anchorPoints.Add(@{ x = [int]$target.menuX; y = [int]$target.menuY })
  }
  if ($target.ContainsKey("menuRootHWnd")) {
    $initialPopup = [IntPtr]$target.menuRootHWnd
    if ($initialPopup -ne [IntPtr]::Zero) { $observedPopupHandles[[string][int64]$initialPopup] = $initialPopup }
  }
  $beforeScan = Get-CommentEditorCandidates $target
  if (-not $beforeScan.ok) { return $false }
  $beforeCandidates = @($beforeScan.candidates)
  if ($beforeCandidates.Count -gt 1) { return $false }
  if (-not [string]::IsNullOrWhiteSpace($expectedRuntimeId) -and $beforeCandidates.Count -eq 1 -and
    $beforeCandidates[0].runtimeId -cne $expectedRuntimeId) { return $false }
  if ($beforeCandidates.Count -eq 0) {
    $knownPopup = [IntPtr]::Zero
    if ($target.ContainsKey("menuRootHWnd")) { $knownPopup = [IntPtr]$target.menuRootHWnd }
    if ($knownPopup -ne [IntPtr]::Zero -and [Win32WechatMomentsAction]::IsWindowVisible($knownPopup) -and
      -not (Close-MomentsMenu $target)) { return $false }
  } else {
    $lockedRuntimeId = [string]$beforeCandidates[0].runtimeId
    $freshTarget = Get-TargetContext
    if (-not $freshTarget.ok -or -not (Set-MomentsMenuAnchor $freshTarget)) { return $false }
    [void]$anchorPoints.Add(@{ x = [int]$freshTarget.menuX; y = [int]$freshTarget.menuY })
    $freshScan = Get-CommentEditorCandidates $freshTarget
    if (-not $freshScan.ok) { return $false }
    $freshCandidates = @($freshScan.candidates)
    if ($freshCandidates.Count -ne 1 -or $freshCandidates[0].runtimeId -cne $lockedRuntimeId) { return $false }
    if (-not (Invoke-MomentsMenuToggleClick $freshTarget)) { return $false }
    Start-Sleep -Milliseconds 220
    $menuTarget = Get-TargetContext
    if (-not $menuTarget.ok -or -not (Set-MomentsMenuAnchor $menuTarget)) { return $false }
    [void]$anchorPoints.Add(@{ x = [int]$menuTarget.menuX; y = [int]$menuTarget.menuY })
    $afterToggleScan = Get-CommentEditorCandidates $menuTarget
    if (-not $afterToggleScan.ok -or @($afterToggleScan.candidates).Count -ne 0) { return $false }
    $popupSet = @{}
    foreach ($anchorPoint in @($anchorPoints)) {
      foreach ($popupHandle in @(Get-OwnedMomentsPopupHandlesNearMenu $menuTarget ([int]$anchorPoint.x) ([int]$anchorPoint.y))) {
        $popupSet[[string][int64]$popupHandle] = [IntPtr]$popupHandle
        $observedPopupHandles[[string][int64]$popupHandle] = [IntPtr]$popupHandle
      }
    }
    foreach ($observedPopup in @($observedPopupHandles.Values)) {
      $observedHandle = [IntPtr]$observedPopup
      if ([Win32WechatMomentsAction]::IsWindowVisible($observedHandle)) {
        if (-not (Test-WindowOwnedByLockedMoments $observedHandle $menuTarget)) { return $false }
        $popupSet[[string][int64]$observedHandle] = $observedHandle
      }
    }
    $popupHandles = @($popupSet.Values)
    if ($popupHandles.Count -gt 1) { return $false }
    if ($popupHandles.Count -eq 1) {
      $menuTarget["menuRootHWnd"] = [IntPtr]$popupHandles[0]
      $menuProof = Get-MomentsOpenMenuProof $menuTarget ([IntPtr]$popupHandles[0])
      if (-not $menuProof.ok -or -not (Close-MomentsMenu $menuTarget)) { return $false }
    }
  }
  $afterTarget = Get-TargetContext
  if (-not $afterTarget.ok -or -not (Set-MomentsMenuAnchor $afterTarget)) { return $false }
  [void]$anchorPoints.Add(@{ x = [int]$afterTarget.menuX; y = [int]$afterTarget.menuY })
  $afterScan = Get-CommentEditorCandidates $afterTarget
  if (-not $afterScan.ok -or @($afterScan.candidates).Count -ne 0) { return $false }
  $remainingPopupSet = @{}
  foreach ($anchorPoint in @($anchorPoints)) {
    foreach ($popupHandle in @(Get-OwnedMomentsPopupHandlesNearMenu $afterTarget ([int]$anchorPoint.x) ([int]$anchorPoint.y))) {
      $remainingPopupSet[[string][int64]$popupHandle] = [IntPtr]$popupHandle
    }
  }
  if ($remainingPopupSet.Count -ne 0) { return $false }
  foreach ($observedPopup in @($observedPopupHandles.Values)) {
    if ([Win32WechatMomentsAction]::IsWindowVisible([IntPtr]$observedPopup)) { return $false }
  }
  return $true
}

function Clear-And-CloseCommentCheckDraft($target, $proof, [string]$expectedText) {
  if (-not (Clear-CommentEditorValueExact $target $proof $expectedText)) { return $false }
  return Close-CommentComposerNeutral $target $proof.runtimeId
}

function Clear-And-CloseCommentDraft($target, $editorElement) {
  $windowIsForeground = [Win32WechatMomentsAction]::GetForegroundWindow() -eq $target.hWnd
  $safeEditor = $null
  $keyboardEditorVerified = $false
  if ($editorElement -ne $null -and (Test-ElementInLockedRoot $target.root $editorElement)) {
    $safeEditor = $editorElement
    if ($windowIsForeground) {
      try { $editorElement.SetFocus() } catch {}
      Start-Sleep -Milliseconds 60
      $focusProof = Get-VerifiedCommentEditorFocus $target
      try {
        if ($focusProof.ok -and [System.Windows.Automation.Automation]::Compare($editorElement, $focusProof.element)) {
          $safeEditor = $focusProof.element
          $keyboardEditorVerified = $true
        }
      } catch {}
    }
  }
  if ($safeEditor -ne $null) {
    $cleared = $false
    try {
      $valuePattern = [System.Windows.Automation.ValuePattern]$safeEditor.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      if (-not $valuePattern.Current.IsReadOnly) {
        $valuePattern.SetValue("")
        $cleared = $true
      }
    } catch {}
    if (-not $cleared -and $windowIsForeground -and $keyboardEditorVerified) {
      try {
        [System.Windows.Forms.SendKeys]::SendWait("^a")
        [System.Windows.Forms.SendKeys]::SendWait("{DELETE}")
      } catch {}
    }
  }
  if ($windowIsForeground) {
    try { [System.Windows.Forms.SendKeys]::SendWait("{ESC}") } catch {}
    Start-Sleep -Milliseconds 100
  }
}

function Get-LockedPostCommentRegion($target) {
  $targetRuntimeId = Get-RuntimeId $target.item
  if (-not $targetRuntimeId) { return @{ ok = $false; reason = "moments_comment_region_target_invalid" } }
  $listItemCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::ListItem
  )
  $items = $target.feed.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listItemCondition)
  $ordered = New-Object System.Collections.Generic.List[object]
  for ($index = 0; $index -lt $items.Count; $index++) {
    $item = $items.Item($index)
    if ((Get-TopLevelFeedItemDepth $target.feed $item) -lt 1) { continue }
    try {
      $rect = $item.Current.BoundingRectangle
      $name = [string]$item.Current.Name
      $isOffscreen = $item.Current.IsOffscreen
    } catch { continue }
    if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }
    [void]$ordered.Add(@{
      element = $item
      rect = $rect
      name = $name
      isOffscreen = $isOffscreen
      runtimeId = (Get-RuntimeId $item)
    })
  }
  $targetIndexes = New-Object System.Collections.Generic.List[int]
  for ($index = 0; $index -lt $ordered.Count; $index++) {
    if ($ordered[$index].runtimeId -ceq $targetRuntimeId) { [void]$targetIndexes.Add($index) }
  }
  if ($targetIndexes.Count -ne 1) {
    return @{ ok = $false; reason = "moments_comment_region_target_ambiguous"; count = $targetIndexes.Count }
  }
  $targetIndex = $targetIndexes[0]
  $nextPostTop = [double]$target.feedRect.Bottom
  $deduped = @{}
  for ($index = $targetIndex + 1; $index -lt $ordered.Count; $index++) {
    $entry = $ordered[$index]
    if ($entry.name -cne "评论区" -and $entry.rect.Height -ge 120) {
      $nextPostTop = [double]$entry.rect.Top
      break
    }
    if ($entry.name -cne "评论区" -or $entry.isOffscreen) { continue }
    $region = $entry.element
    $rect = $entry.rect
    if (-not (Test-ElementInLockedRoot $target.root $region) -or
      -not (Test-RectInsideLockedWindow $rect $target.windowRect) -or
      $rect.Left -lt ($target.feedRect.Left - 2) -or $rect.Top -lt ($target.itemRect.Bottom - 6) -or
      $rect.Right -gt ($target.feedRect.Right + 2) -or $rect.Bottom -gt ($target.feedRect.Bottom + 2)) { continue }
    $runtimeId = Get-RuntimeId $region
    $key = if ($runtimeId) { $runtimeId } else { "$([Math]::Round($rect.Left))|$([Math]::Round($rect.Top))|$([Math]::Round($rect.Width))|$([Math]::Round($rect.Height))" }
    if (-not $deduped.ContainsKey($key)) { $deduped[$key] = @{ element = $region; rect = $rect } }
  }
  $matches = @($deduped.Values | Where-Object { $_.rect.Top -lt $nextPostTop -and $_.rect.Bottom -le ($nextPostTop + 2) })
  if ($matches.Count -ne 1) {
    return @{ ok = $false; reason = "moments_comment_region_ambiguous"; count = $matches.Count }
  }
  return @{ ok = $true; element = $matches[0].element; rect = $matches[0].rect; nextPostTop = $nextPostTop }
}

function Get-ExactCommentElementCount($target, [string]$commentText) {
  $region = Get-LockedPostCommentRegion $target
  if (-not $region.ok) { return $region }
  $elements = $region.element.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $deduped = @{}
  for ($index = 0; $index -lt $elements.Count; $index++) {
    $element = $elements.Item($index)
    if ((Get-ElementRawText $element) -cne $commentText) { continue }
    try {
      if ($element.Current.IsOffscreen) { continue }
      $rect = $element.Current.BoundingRectangle
      $controlType = [string]$element.Current.ControlType.ProgrammaticName
    } catch { continue }
    if (-not (Test-ElementInLockedRoot $target.root $element) -or
      -not (Test-RectInsideLockedWindow $rect $target.windowRect) -or
      $rect.Left -lt ($region.rect.Left - 2) -or $rect.Top -lt ($region.rect.Top - 2) -or
      $rect.Right -gt ($region.rect.Right + 2) -or $rect.Bottom -gt ($region.rect.Bottom + 2)) { continue }
    $runtimeId = Get-RuntimeId $element
    $key = if ($runtimeId) { $runtimeId } else { "$controlType|$([Math]::Round($rect.Left))|$([Math]::Round($rect.Top))|$([Math]::Round($rect.Width))|$([Math]::Round($rect.Height))" }
    if (-not $deduped.ContainsKey($key)) { $deduped[$key] = $true }
  }
  return @{ ok = $true; count = $deduped.Count }
}

function Get-UniqueSendButton($target, $editorProof) {
  if (-not $editorProof.ok -or -not (Test-ElementInLockedRoot $target.root $editorProof.element)) {
    return @{ ok = $false; reason = "moments_comment_editor_focus_invalid"; count = 0 }
  }
  $nameCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    "发送"
  )
  $typeCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  )
  $exactButtonCondition = [System.Windows.Automation.AndCondition]::new($nameCondition, $typeCondition)
  $deduped = @{}
  foreach ($viewCondition in @(
    [System.Windows.Automation.Automation]::RawViewCondition,
    [System.Windows.Automation.Automation]::ControlViewCondition
  )) {
    $condition = [System.Windows.Automation.AndCondition]::new($viewCondition, $exactButtonCondition)
    $buttons = $target.root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    for ($index = 0; $index -lt $buttons.Count; $index++) {
      $button = $buttons.Item($index)
      try {
        if ([string]$button.Current.Name -cne "发送" -or
          $button.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button -or
          $button.Current.IsOffscreen -or -not $button.Current.IsEnabled) { continue }
        $rect = $button.Current.BoundingRectangle
      } catch { continue }
      if (-not (Test-ElementInLockedRoot $target.root $button) -or
        -not (Test-RectInsideLockedWindow $rect $target.windowRect)) { continue }
      $runtimeId = Get-RuntimeId $button
      $key = if ($runtimeId) { $runtimeId } else { "$([Math]::Round($rect.Left))|$([Math]::Round($rect.Top))|$([Math]::Round($rect.Width))|$([Math]::Round($rect.Height))" }
      if (-not $deduped.ContainsKey($key)) { $deduped[$key] = @{ element = $button; rect = $rect } }
    }
  }
  $matches = @($deduped.Values)
  if ($matches.Count -ne 1) {
    return @{ ok = $false; reason = "moments_comment_send_button_ambiguous"; count = $matches.Count }
  }
  return @{ ok = $true; element = $matches[0].element; rect = $matches[0].rect }
}

function Test-CommentEditorClearedOrClosed($target, $editorElement) {
  if ($editorElement -eq $null) { return @{ ok = $false; reason = "moments_comment_editor_completion_unknown" } }
  try {
    $isOffscreen = $editorElement.Current.IsOffscreen
    $rect = $editorElement.Current.BoundingRectangle
  } catch {
    return @{ ok = $true; mode = "closed" }
  }
  if ($isOffscreen -or -not (Test-ElementInLockedRoot $target.root $editorElement)) {
    return @{ ok = $true; mode = "closed" }
  }
  if (-not (Test-RectInsideLockedWindow $rect $target.windowRect)) {
    return @{ ok = $false; reason = "moments_comment_editor_completion_unknown" }
  }
  $valueKnown = $false
  $value = ""
  try {
    $valuePattern = [System.Windows.Automation.ValuePattern]$editorElement.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $value = [string]$valuePattern.Current.Value
    $valueKnown = $true
  } catch {}
  if (-not $valueKnown) {
    try {
      $textPattern = [System.Windows.Automation.TextPattern]$editorElement.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
      $value = [string]$textPattern.DocumentRange.GetText(-1)
      $valueKnown = $true
    } catch {}
  }
  if (-not $valueKnown) { return @{ ok = $false; reason = "moments_comment_editor_completion_unknown" } }
  $value = $value.TrimEnd([char[]]@([char]13, [char]10, [char]0xFFFC))
  if ($value.Length -ne 0) { return @{ ok = $false; reason = "moments_comment_editor_not_cleared" } }
  return @{ ok = $true; mode = "cleared" }
}

$action = [string]$env:XIAOXI_MOMENTS_ACTION
$commentText = Decode-Base64 $env:XIAOXI_MOMENTS_COMMENT_BASE64
if (-not (Test-ActionDeadline)) { Write-Result @{ ok = $false; status = "blocked"; reason = "moments_dry_run_expired"; actionAttempted = $false } }
$target = Get-TargetContext
if (-not $target.ok) { Write-Result @{ ok = $false; status = "blocked"; reason = $target.reason; actionAttempted = $false } }
$menu = Open-MomentsMenu $target
if (-not $menu.ok) { Write-Result @{ ok = $false; status = "blocked"; reason = $menu.reason; actionAttempted = $false } }
$menuSnapshot = @{ likeLabel = $menu.like.name; commentLabel = $menu.comment.name }

if ($action -eq "inspect") {
  if (-not (Close-MomentsMenu $target)) {
    Write-Result @{ ok = $false; status = "blocked"; reason = (Get-MomentsMenuCloseReason); actionAttempted = $false }
  }
  Write-Result @{ ok = $true; status = "menu_verified"; actionAttempted = $false; menu = $menuSnapshot }
}

if ($action -eq "comment_check") {
  if (-not $commentText -or $commentText.Length -gt 500) {
    [void](Close-MomentsMenu $target)
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_missing"; actionAttempted = $false }
  }
  if (-not (Test-ActionDeadline)) {
    [void](Close-MomentsMenu $target)
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_dry_run_expired"; actionAttempted = $false }
  }
  if (-not (Invoke-MenuEntry $menu.comment $target $true)) {
    [void](Close-MomentsMenu $target)
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_open_blocked"; actionAttempted = $false }
  }
  Start-Sleep -Milliseconds 280
  $firstEditor = Get-CommentEditorProof $target
  if (-not $firstEditor.ok) {
    if (-not (Close-CommentComposerNeutral $target)) {
      Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_draft_close_unverified"; actionAttempted = $false }
    }
    Write-Result @{ ok = $false; status = "blocked"; reason = $firstEditor.reason; actionAttempted = $false }
  }
  if (-not [String]::Equals([string]$firstEditor.value, "", [StringComparison]::Ordinal)) {
    if (-not (Close-CommentComposerNeutral $target $firstEditor.runtimeId)) {
      Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_draft_close_unverified"; actionAttempted = $false }
    }
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_preexisting_draft"; actionAttempted = $false }
  }
  $sendBefore = Get-UniqueSendButton $target $firstEditor
  if ($sendBefore.ok -or $sendBefore.count -ne 0) {
    if (-not (Close-CommentComposerNeutral $target $firstEditor.runtimeId)) {
      Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_draft_close_unverified"; actionAttempted = $false }
    }
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_draft_state_unknown"; actionAttempted = $false }
  }
  Start-Sleep -Milliseconds 120
  $secondEditor = Get-CommentEditorProof $target $firstEditor.runtimeId $firstEditor.bounds
  $sameEditor = $false
  if ($secondEditor.ok) {
    try { $sameEditor = [System.Windows.Automation.Automation]::Compare($firstEditor.element, $secondEditor.element) } catch {}
  }
  if (-not $sameEditor -or -not [String]::Equals([string]$secondEditor.value, "", [StringComparison]::Ordinal)) {
    if (-not (Close-CommentComposerNeutral $target $firstEditor.runtimeId)) {
      Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_draft_close_unverified"; actionAttempted = $false }
    }
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_editor_changed"; actionAttempted = $false }
  }
  if (-not (Test-ActionDeadline)) {
    if (-not (Close-CommentComposerNeutral $target $firstEditor.runtimeId)) {
      Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_draft_close_unverified"; actionAttempted = $false }
    }
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_dry_run_expired"; actionAttempted = $false }
  }
  $roundTrip = Set-CommentEditorValueExact $target $secondEditor "" $commentText
  if (-not $roundTrip.ok) {
    $cleanupOk = if ($roundTrip.valueSetAttempted) {
      Clear-And-CloseCommentCheckDraft $target $secondEditor $commentText
    } else {
      Close-CommentComposerNeutral $target $secondEditor.runtimeId
    }
    if (-not $cleanupOk) {
      Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_draft_close_unverified"; actionAttempted = $false }
    }
    Write-Result @{ ok = $false; status = "blocked"; reason = $roundTrip.reason; actionAttempted = $false }
  }
  $sendReady = Get-UniqueSendButton $target $roundTrip.proof
  if (-not $sendReady.ok) {
    if (-not (Clear-And-CloseCommentCheckDraft $target $roundTrip.proof $commentText)) {
      Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_draft_close_unverified"; actionAttempted = $false }
    }
    Write-Result @{ ok = $false; status = "blocked"; reason = $sendReady.reason; actionAttempted = $false; sendButtonCount = $sendReady.count }
  }
  if (-not (Clear-CommentEditorValueExact $target $roundTrip.proof $commentText)) {
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_draft_close_unverified"; actionAttempted = $false }
  }
  $clearedEditor = Get-CommentEditorProof $target $roundTrip.proof.runtimeId $roundTrip.proof.bounds
  $sendAfter = Get-UniqueSendButton $target $clearedEditor
  if (-not $clearedEditor.ok -or -not [String]::Equals([string]$clearedEditor.value, "", [StringComparison]::Ordinal) -or
    $sendAfter.ok -or $sendAfter.count -ne 0) {
    if (-not (Close-CommentComposerNeutral $target $roundTrip.proof.runtimeId)) {
      Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_draft_close_unverified"; actionAttempted = $false }
    }
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_draft_proof_invalid"; actionAttempted = $false }
  }
  if (-not (Close-CommentComposerNeutral $target $roundTrip.proof.runtimeId)) {
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_draft_close_unverified"; actionAttempted = $false }
  }
  Write-Result @{
    ok = $true
    status = "comment_draft_verified"
    actionAttempted = $false
    commentStatus = "draft_verified"
    verificationMode = "targeted_uia_value_roundtrip_and_unique_enabled_button_transition"
  }
}

if ($action -eq "like") {
  if (@("取消", "取消赞") -contains $menu.like.name) {
    [void](Close-MomentsMenu $target)
    Write-Result @{ ok = $true; status = "already_liked_verified"; actionAttempted = $false; likeStatus = "already_liked"; menuBefore = $menuSnapshot }
  }
  if ($menu.like.name -ne "赞") {
    [void](Close-MomentsMenu $target)
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_like_state_unknown"; actionAttempted = $false }
  }
  if (-not (Test-ActionDeadline)) {
    [void](Close-MomentsMenu $target)
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_dry_run_expired"; actionAttempted = $false }
  }
  if (-not (Invoke-MenuEntry $menu.like $target $true)) {
    $reason = if ($script:lastVerifiedClickFailureReason) { $script:lastVerifiedClickFailureReason } else { "moments_like_click_blocked" }
    [void](Close-MomentsMenu $target)
    Write-Result @{ ok = $false; status = "blocked"; reason = $reason; actionAttempted = $false }
  }
  $actionAttempted = $true
  Start-Sleep -Milliseconds 350
  $afterTarget = Get-TargetContext
  if (-not $afterTarget.ok) { Write-Result @{ ok = $false; status = "outcome_unknown"; reason = $afterTarget.reason; actionAttempted = $actionAttempted } }
  $afterMenu = Open-MomentsMenu $afterTarget
  if (-not $afterMenu.ok) { Write-Result @{ ok = $false; status = "outcome_unknown"; reason = "moments_like_verification_failed"; actionAttempted = $actionAttempted } }
  $afterLabel = $afterMenu.like.name
  [void](Close-MomentsMenu $afterTarget)
  if (@("取消", "取消赞") -notcontains $afterLabel) {
    Write-Result @{ ok = $false; status = "outcome_unknown"; reason = "moments_like_verification_failed"; actionAttempted = $actionAttempted; menuAfter = @{ likeLabel = $afterLabel; commentLabel = $afterMenu.comment.name } }
  }
  Write-Result @{ ok = $true; status = "verified"; actionAttempted = $actionAttempted; likeStatus = "verified"; verificationMode = "menu_state_transition"; menuBefore = $menuSnapshot; menuAfter = @{ likeLabel = $afterLabel; commentLabel = $afterMenu.comment.name } }
}

if ($action -eq "comment") {
  if (-not $commentText) {
    [void](Close-MomentsMenu $target)
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_missing"; actionAttempted = $false }
  }
  $initialCount = Get-ExactCommentElementCount $target $commentText
  if (-not $initialCount.ok) {
    [void](Close-MomentsMenu $target)
    Write-Result @{ ok = $false; status = "blocked"; reason = $initialCount.reason; actionAttempted = $false }
  }
  if ($initialCount.count -gt 0) {
    [void](Close-MomentsMenu $target)
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_duplicate"; actionAttempted = $false; exactCountBefore = $initialCount.count }
  }
  if (-not (Test-ActionDeadline)) {
    [void](Close-MomentsMenu $target)
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_dry_run_expired"; actionAttempted = $false }
  }
  if (-not (Invoke-MenuEntry $menu.comment $target)) {
    [void](Close-MomentsMenu $target)
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_open_blocked"; actionAttempted = $false }
  }
  Start-Sleep -Milliseconds 250
  if ([Win32WechatMomentsAction]::GetForegroundWindow() -ne $target.hWnd) {
    Clear-And-CloseCommentDraft $target $null
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_window_not_foreground"; actionAttempted = $false }
  }
  $editorProof = Get-VerifiedCommentEditorFocus $target
  if (-not $editorProof.ok) {
    Clear-And-CloseCommentDraft $target $null
    Write-Result @{ ok = $false; status = "blocked"; reason = $editorProof.reason; actionAttempted = $false }
  }
  $originalClipboard = $null
  try { $originalClipboard = [System.Windows.Forms.Clipboard]::GetDataObject() } catch {}
  try {
    [System.Windows.Forms.Clipboard]::SetText($commentText)
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 150
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    [System.Windows.Forms.SendKeys]::SendWait("^c")
    Start-Sleep -Milliseconds 150
    $roundTrip = [System.Windows.Forms.Clipboard]::GetText()
  } catch {
    $roundTrip = ""
  } finally {
    try {
      if ($originalClipboard -ne $null) { [System.Windows.Forms.Clipboard]::SetDataObject($originalClipboard, $true) }
      else { [System.Windows.Forms.Clipboard]::Clear() }
    } catch {}
  }
  if ($roundTrip -cne $commentText) {
    Clear-And-CloseCommentDraft $target $editorProof.element
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_roundtrip_mismatch"; actionAttempted = $false }
  }
  $beforeSendFocus = Get-VerifiedCommentEditorFocus $target
  $sameEditor = $false
  if ($beforeSendFocus.ok) {
    try { $sameEditor = [System.Windows.Automation.Automation]::Compare($editorProof.element, $beforeSendFocus.element) } catch {}
  }
  if (-not $sameEditor) {
    Clear-And-CloseCommentDraft $target $editorProof.element
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_editor_focus_changed"; actionAttempted = $false }
  }
  $submitCount = Get-ExactCommentElementCount $target $commentText
  if (-not $submitCount.ok) {
    Clear-And-CloseCommentDraft $target $editorProof.element
    Write-Result @{ ok = $false; status = "blocked"; reason = $submitCount.reason; actionAttempted = $false }
  }
  if ($submitCount.count -gt 0) {
    Clear-And-CloseCommentDraft $target $editorProof.element
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_comment_duplicate"; actionAttempted = $false; exactCountBefore = $submitCount.count }
  }
  $sendButton = Get-UniqueSendButton $target $beforeSendFocus
  if (-not $sendButton.ok) {
    Clear-And-CloseCommentDraft $target $editorProof.element
    Write-Result @{ ok = $false; status = "blocked"; reason = $sendButton.reason; actionAttempted = $false; sendButtonCount = $sendButton.count }
  }
  $sendX = [int][Math]::Round(($sendButton.rect.Left + $sendButton.rect.Right) / 2)
  $sendY = [int][Math]::Round(($sendButton.rect.Top + $sendButton.rect.Bottom) / 2)
  if (-not (Test-ActionDeadline)) {
    Clear-And-CloseCommentDraft $target $editorProof.element
    Write-Result @{ ok = $false; status = "blocked"; reason = "moments_dry_run_expired"; actionAttempted = $false }
  }
  if (-not (Invoke-VerifiedClick $sendX $sendY $target.pid $target.hWnd $true)) {
    $reason = if ($script:lastVerifiedClickFailureReason) { $script:lastVerifiedClickFailureReason } else { "moments_comment_send_blocked" }
    Clear-And-CloseCommentDraft $target $editorProof.element
    Write-Result @{ ok = $false; status = "blocked"; reason = $reason; actionAttempted = $false }
  }
  $actionAttempted = $true
  Start-Sleep -Milliseconds 550
  $verified = $false
  $verifiedCount = $null
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    $afterTarget = Get-TargetContext
    if (-not $afterTarget.ok) { break }
    $afterCount = Get-ExactCommentElementCount $afterTarget $commentText
    $editorCompletion = Test-CommentEditorClearedOrClosed $afterTarget $editorProof.element
    if ($afterCount.ok -and $afterCount.count -eq ($submitCount.count + 1) -and $editorCompletion.ok) {
      $verified = $true
      $verifiedCount = $afterCount.count
    }
    if ($verified) { break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $verified) {
    Clear-And-CloseCommentDraft $target $editorProof.element
    Write-Result @{ ok = $false; status = "outcome_unknown"; reason = "moments_comment_verification_failed"; actionAttempted = $actionAttempted; verificationMode = "exact_comment_count_increment_and_editor_completion"; exactCountBefore = $submitCount.count }
  }
  Write-Result @{ ok = $true; status = "verified"; actionAttempted = $actionAttempted; commentStatus = "verified"; verificationMode = "exact_comment_count_increment_and_editor_completion"; exactCountBefore = $submitCount.count; exactCountAfter = $verifiedCount }
}

[void](Close-MomentsMenu $target)
Write-Result @{ ok = $false; status = "blocked"; reason = "moments_action_invalid"; actionAttempted = $false }
`;

function actionEnvironment(action, context = {}) {
  const window = context.expectedWindow ?? context.window ?? context.momentsWindow ?? {};
  const snapshot = context.postSnapshot ?? context.post_snapshot ?? context.snapshot ?? {};
  const labelPrefix = momentsPostIdentityPrefix(snapshot.label).slice(0, 64);
  return {
    XIAOXI_MOMENTS_ACTION: action,
    XIAOXI_MOMENTS_EXPECTED_PID: String(window.pid ?? ""),
    XIAOXI_MOMENTS_EXPECTED_HWND: String(window.hWnd ?? ""),
    XIAOXI_MOMENTS_EXPECTED_TITLE_BASE64: Buffer.from(String(window.title ?? ""), "utf8").toString("base64"),
    XIAOXI_MOMENTS_EXPECTED_CLASS_BASE64: Buffer.from(String(window.className ?? ""), "utf8").toString("base64"),
    XIAOXI_MOMENTS_EXPECTED_LEFT: String(window.left ?? ""),
    XIAOXI_MOMENTS_EXPECTED_TOP: String(window.top ?? ""),
    XIAOXI_MOMENTS_EXPECTED_WIDTH: String(window.width ?? ""),
    XIAOXI_MOMENTS_EXPECTED_HEIGHT: String(window.height ?? ""),
    XIAOXI_MOMENTS_RUNTIME_ID: String(snapshot.runtime_id ?? snapshot.runtimeId ?? ""),
    XIAOXI_MOMENTS_ROOT_AUTOMATION_ID: String(window.automationId ?? ""),
    XIAOXI_MOMENTS_IDENTITY_MODE: String(window.identityMode ?? ""),
    XIAOXI_MOMENTS_ROOT_NAME_BASE64: Buffer.from(String(window.rootName ?? ""), "utf8").toString("base64"),
    XIAOXI_MOMENTS_ROOT_CONTROL_TYPE: String(window.rootControlType ?? ""),
    XIAOXI_MOMENTS_FEED_AUTOMATION_ID: String(window.feedAutomationId ?? ""),
    XIAOXI_MOMENTS_FEED_RUNTIME_ID: String(window.feedRuntimeId ?? ""),
    XIAOXI_MOMENTS_FEED_COUNT: String(window.feedCount ?? ""),
    XIAOXI_MOMENTS_DEADLINE_MS: String(context.deadlineMs ?? ""),
    XIAOXI_MOMENTS_LABEL_PREFIX_BASE64: Buffer.from(labelPrefix, "utf8").toString("base64"),
    XIAOXI_MOMENTS_COMMENT_BASE64: Buffer.from(exactCommentText(context.commentText), "utf8").toString("base64")
  };
}

function runMomentsAction(action, context = {}) {
  return runPowerShell(MOMENTS_ACTION_SCRIPT, actionEnvironment(action, context), { ensure: false, sta: true });
}

function inspectMenu(context = {}) {
  const result = runMomentsAction("inspect", context);
  if (!result?.ok) return result;
  return {
    ...result,
    observationId: String(context.observationId ?? ""),
    menuState: String(result.menu?.likeLabel ?? "")
  };
}

function inspectCommentDraft(context = {}) {
  const commentText = exactCommentText(context.commentText);
  if (!commentText || commentText.length > 500) {
    return { ok: false, status: "blocked", reason: "moments_comment_missing", actionAttempted: false };
  }
  const result = runMomentsAction("comment_check", context);
  return {
    ...result,
    observationId: String(context.observationId ?? ""),
    commentText
  };
}

function like(context = {}) {
  const result = runMomentsAction("like", context);
  if (!result?.ok) return result;
  return {
    ...result,
    observationId: String(context.observationId ?? ""),
    menuState: String(result.menuAfter?.likeLabel ?? result.menuBefore?.likeLabel ?? "")
  };
}

function comment(context = {}) {
  const result = runMomentsAction("comment", context);
  if (!result?.ok) return result;
  return {
    ...result,
    observationId: String(context.observationId ?? ""),
    commentVerified: result.commentStatus === "verified",
    commentText: exactCommentText(context.commentText)
  };
}

module.exports = { comment, inspectCommentDraft, inspectMenu, like };
