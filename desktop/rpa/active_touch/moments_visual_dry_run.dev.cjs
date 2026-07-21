const { runPowerShell } = require("./wechat_window_driver.cjs");
const { MOMENTS_VISUAL_READONLY_POWERSHELL } = require("./moments_visual_probe.dev.cjs");

const MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32WechatMomentsVisualProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@

${MOMENTS_VISUAL_READONLY_POWERSHELL}

function Write-Result($value) {
  $value | ConvertTo-Json -Compress -Depth 10
  exit
}

function Close-And-Write($value, $firstFrame = $null, $secondFrame = $null) {
  Close-MomentsVisualFrame $firstFrame
  Close-MomentsVisualFrame $secondFrame
  Write-Result $value
}

function ConvertTo-AbsoluteVisualBounds($bounds, [double]$left, [double]$top) {
  return @{
    left = [double]$bounds.left + $left
    top = [double]$bounds.top + $top
    width = [double]$bounds.width
    height = [double]$bounds.height
  }
}

function Test-VisualBoundsInside($inner, $outer) {
  return $inner.width -gt 0 -and $inner.height -gt 0 -and
    $inner.left -ge $outer.left -and $inner.top -ge $outer.top -and
    ($inner.left + $inner.width) -le ($outer.left + $outer.width) -and
    ($inner.top + $inner.height) -le ($outer.top + $outer.height)
}

function Test-VisualMenuSequence($first, $second) {
  $left = @($first)
  $right = @($second)
  if ($left.Count -ne $right.Count) { return $false }
  for ($index = 0; $index -lt $left.Count; $index++) {
    if ([Math]::Abs([double]$left[$index].centerX - [double]$right[$index].centerX) -gt 1.5 -or
      [Math]::Abs([double]$left[$index].centerY - [double]$right[$index].centerY) -gt 1.5) { return $false }
  }
  return $true
}

function Test-VisualPostSequence($first, $second) {
  $left = @($first)
  $right = @($second)
  if ($left.Count -ne $right.Count) { return $false }
  for ($index = 0; $index -lt $left.Count; $index++) {
    if (-not (Test-MomentsStableContentSimilarity ([string]$left[$index].identityText) ([string]$right[$index].identityText)) -or
      [string]$left[$index].avatarHash -cne [string]$right[$index].avatarHash) { return $false }
    foreach ($boundsField in @("bounds", "menuBounds", "avatarBounds")) {
      foreach ($coordinate in @("left", "top", "width", "height")) {
        if ([Math]::Abs([double]$left[$index].$boundsField.$coordinate - [double]$right[$index].$boundsField.$coordinate) -gt 1.5) { return $false }
      }
    }
  }
  return $true
}

$processNames = @("Weixin", "WeChat")
$script:matches = @()
$callback = [Win32WechatMomentsVisualProbe+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if (-not [Win32WechatMomentsVisualProbe]::IsWindowVisible($hWnd)) { return $true }
  $titleText = New-Object System.Text.StringBuilder 512
  $classText = New-Object System.Text.StringBuilder 256
  [void][Win32WechatMomentsVisualProbe]::GetWindowText($hWnd, $titleText, $titleText.Capacity)
  [void][Win32WechatMomentsVisualProbe]::GetClassName($hWnd, $classText, $classText.Capacity)
  $title = $titleText.ToString().Trim()
  if ($title -cne "朋友圈") { return $true }
  [uint32]$windowProcessId = 0
  [void][Win32WechatMomentsVisualProbe]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
  $process = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
  if ($process -eq $null -or $processNames -notcontains $process.ProcessName) { return $true }
  $rect = New-Object Win32WechatMomentsVisualProbe+RECT
  if (-not [Win32WechatMomentsVisualProbe]::GetWindowRect($hWnd, [ref]$rect)) { return $true }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 300 -or $height -lt 300) { return $true }
  $script:matches += @{
    title = $title
    className = $classText.ToString().Trim()
    processName = $process.ProcessName
    pid = [int]$windowProcessId
    hWnd = [string]$hWnd.ToInt64()
    rect = $rect
    left = [double]$rect.Left
    top = [double]$rect.Top
    width = [double]$width
    height = [double]$height
  }
  return $true
}
[void][Win32WechatMomentsVisualProbe]::EnumWindows($callback, [IntPtr]::Zero)
if ($matches.Count -eq 0) { Write-Result @{ ok = $false; reason = "moments_window_not_found" } }
if ($matches.Count -ne 1) { Write-Result @{ ok = $false; reason = "moments_window_ambiguous"; count = $matches.Count } }

$matched = $matches[0]
$hWnd = [IntPtr][int64]$matched.hWnd
try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd) } catch { $root = $null }
if ($root -eq $null) { Write-Result @{ ok = $false; reason = "moments_window_identity_mismatch" } }
try {
  $rootAutomationId = [string]$root.Current.AutomationId
  $rootName = [string]$root.Current.Name
  $rootControlType = [string]$root.Current.ControlType.ProgrammaticName
  $rootProcessId = [int]$root.Current.ProcessId
} catch { Write-Result @{ ok = $false; reason = "moments_window_identity_mismatch" } }
if ($rootAutomationId -cne "" -or $rootName -cne "朋友圈" -or $rootControlType -cne "ControlType.Window" -or $rootProcessId -ne $matched.pid) {
  Write-Result @{ ok = $false; reason = "moments_window_identity_mismatch" }
}
$feedCondition = [System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
  "sns_list"
)
$feeds = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $feedCondition)
if ($feeds.Count -ne 0) { Write-Result @{ ok = $false; reason = "moments_visual_profile_conflict"; feedCount = $feeds.Count } }
$renderEvidence = Get-MomentsRenderPaneEvidence $root $matched.pid
if (-not $renderEvidence.ok) { Write-Result $renderEvidence }
$windowBounds = @{ left = $matched.left; top = $matched.top; width = $matched.width; height = $matched.height }
if (-not (Test-VisualBoundsInside $renderEvidence.pane.bounds $windowBounds)) {
  Write-Result @{ ok = $false; reason = "moments_render_pane_bounds_invalid" }
}

$firstFrame = Get-MomentsVisualFrame $hWnd $matched.rect $matched.pid $true
if (-not $firstFrame.ok) { Close-And-Write $firstFrame }
$firstRead = Get-MomentsVisualPostCandidates $firstFrame
Start-Sleep -Milliseconds 180
$secondFrame = Get-MomentsVisualFrame $hWnd $matched.rect $matched.pid $false
if (-not $secondFrame.ok) { Close-And-Write $secondFrame $firstFrame }
$secondRead = Get-MomentsVisualPostCandidates $secondFrame
if (-not (Test-VisualMenuSequence $firstRead.menus $secondRead.menus) -or -not (Test-VisualPostSequence $firstRead.posts $secondRead.posts)) {
  Close-And-Write @{ ok = $false; reason = "moments_post_changed" } $firstFrame $secondFrame
}
$posts = @($secondRead.posts)
if ($posts.Count -eq 0) {
  Close-And-Write @{
    ok = $false
    reason = "moments_post_not_found"
    diagnostics = @{
      menuCenters = @($secondRead.menus | ForEach-Object { @([Math]::Round($_.centerX, 1), [Math]::Round($_.centerY, 1)) })
      postAnchors = @()
    }
  } $firstFrame $secondFrame
}
$absolutePosts = New-Object System.Collections.Generic.List[object]
foreach ($post in $posts) {
  $absoluteBounds = ConvertTo-AbsoluteVisualBounds $post.bounds $matched.left $matched.top
  $absoluteMenuBounds = ConvertTo-AbsoluteVisualBounds $post.menuBounds $matched.left $matched.top
  $absoluteAvatarBounds = ConvertTo-AbsoluteVisualBounds $post.avatarBounds $matched.left $matched.top
  if (-not (Test-VisualBoundsInside $absoluteBounds $windowBounds) -or
    -not (Test-VisualBoundsInside $absoluteMenuBounds $windowBounds) -or
    -not (Test-VisualBoundsInside $absoluteAvatarBounds $windowBounds)) {
    Close-And-Write @{ ok = $false; reason = "moments_post_identity_missing" } $firstFrame $secondFrame
  }
  [void]$absolutePosts.Add(@{
    text = [string]$post.text
    identityText = [string]$post.identityText
    structureVerified = $true
    regionHash = [string]$post.regionHash
    avatarHash = [string]$post.avatarHash
    layoutHash = [string]$post.layoutHash
    bounds = $absoluteBounds
    menuBounds = $absoluteMenuBounds
    avatarBounds = $absoluteAvatarBounds
  })
}
$result = @{
  ok = $true
  title = $matched.title
  className = $matched.className
  processName = $matched.processName
  pid = $matched.pid
  hWnd = $matched.hWnd
  left = $matched.left
  top = $matched.top
  width = $matched.width
  height = $matched.height
  automationId = ""
  identityMode = "visual_mmui_render"
  rootName = $rootName
  rootControlType = $rootControlType
  rootProcessId = $rootProcessId
  feedAutomationId = ""
  feedRuntimeId = ""
  feedCount = 0
  renderPaneName = $renderEvidence.pane.name
  renderPaneAutomationId = $renderEvidence.pane.automationId
  renderPaneControlType = $renderEvidence.pane.controlType
  renderPaneProcessId = $renderEvidence.pane.processId
  renderPaneRuntimeId = $renderEvidence.pane.runtimeId
  renderPaneBounds = $renderEvidence.pane.bounds
  posts = @($absolutePosts.ToArray())
}
Close-And-Write $result $firstFrame $secondFrame
`;

function probeVisualWechatMomentsWindow() {
  return runPowerShell(MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT, {}, { ensure: false, sta: true, timeout: 30000, diagnostics: true });
}

module.exports = {
  MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT,
  probeVisualWechatMomentsWindow
};
