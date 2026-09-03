const { runPowerShell } = require("./wechat_window_driver.cjs");
const { MOMENTS_VISUAL_READONLY_POWERSHELL } = require("./moments_visual_probe.dev.cjs");
const {
  normalizeExpectedMomentsSurface
} = require("./moments_surface_profile.dev.cjs");
const {
  MOMENTS_INTEGRATED_SURFACE_EVIDENCE_POWERSHELL
} = require("./moments_surface_evidence.dev.cjs");

const MOMENTS_VISUAL_STABILITY_TOLERANCE_PX = 12;

const MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
$script:momentsVisualStabilityTolerancePx = ${MOMENTS_VISUAL_STABILITY_TOLERANCE_PX.toFixed(1)}
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
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
}
"@

${MOMENTS_VISUAL_READONLY_POWERSHELL}
${MOMENTS_INTEGRATED_SURFACE_EVIDENCE_POWERSHELL}

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

function ConvertTo-RelativeVisualBounds($bounds, [double]$left, [double]$top) {
  return @{
    left = [double]$bounds.left - $left
    top = [double]$bounds.top - $top
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

function Test-VisualStableBoundsFields($left, $right, $boundsFields) {
  foreach ($boundsField in @($boundsFields)) {
    foreach ($coordinate in @("left", "top", "width", "height")) {
      if ([Math]::Abs([double]$left.$boundsField.$coordinate - [double]$right.$boundsField.$coordinate) -gt $script:momentsVisualStabilityTolerancePx) {
        return $false
      }
    }
  }
  return $true
}

function Test-VisualStableCandidate($left, $right, [string]$kind) {
  if ($kind -ceq "menu") {
    return [Math]::Abs([double]$left.centerX - [double]$right.centerX) -le $script:momentsVisualStabilityTolerancePx -and
      [Math]::Abs([double]$left.centerY - [double]$right.centerY) -le $script:momentsVisualStabilityTolerancePx -and
      (Test-VisualStableBoundsFields $left $right @("bounds"))
  }
  if (@("post", "reading") -notcontains $kind) { return $false }
  if (-not (Test-MomentsStablePostIdentityText ([string]$left.identityText) ([string]$right.identityText) ([string]$left.stableAnchorText) ([string]$right.stableAnchorText)) -or
    [string]$left.avatarHash -cne [string]$right.avatarHash) { return $false }
  if ($kind -ceq "post" -and [bool]$left.partialVisible -ne [bool]$right.partialVisible) { return $false }
  $boundsFields = $(if ($kind -ceq "post") { @("bounds", "menuBounds", "avatarBounds") } else { @("bounds", "avatarBounds") })
  return Test-VisualStableBoundsFields $left $right $boundsFields
}

function Get-UniqueStableVisualCandidates($first, $second, [string]$kind) {
  $left = @($first)
  $right = @($second)
  $stable = New-Object System.Collections.Generic.List[object]
  foreach ($candidate in $right) {
    $leftMatches = @($left | Where-Object { Test-VisualStableCandidate $_ $candidate $kind })
    if ($leftMatches.Count -ne 1) { continue }
    $source = $leftMatches[0]
    $rightMatches = @($right | Where-Object { Test-VisualStableCandidate $source $_ $kind })
    if ($rightMatches.Count -ne 1) { continue }
    [void]$stable.Add($candidate)
  }
  return @($stable.ToArray() | Sort-Object { [double]$_.bounds.top })
}

function Get-LocalStableInteractionRead($frame, $viewportBounds, $firstRead) {
  $menus = New-Object System.Collections.Generic.List[object]
  $posts = New-Object System.Collections.Generic.List[object]
  $rawCandidateCount = 0
  $componentCount = 0
  $rejectedWhitespaceCount = 0
  $rejectedAvatarLaneCount = 0
  foreach ($post in @($firstRead.interactionPosts)) {
    $anchor = Resolve-MomentsInteractionAnchor $frame $viewportBounds $post.menuBounds $post.avatarBounds ([string]$post.avatarHash) $script:momentsVisualStabilityTolerancePx
    $rawCandidateCount += [int]$anchor.diagnostics.rawCandidateCount
    $componentCount += [int]$anchor.diagnostics.componentCount
    $rejectedWhitespaceCount += [int]$anchor.diagnostics.rejectedWhitespaceCount
    $rejectedAvatarLaneCount += [int]$anchor.diagnostics.rejectedAvatarLaneCount
    if (-not $anchor.ok) { continue }
    $menuHash = Get-MomentsPixelHash $frame $anchor.menu.bounds
    if (-not $menuHash) { continue }
    [void]$menus.Add($anchor.menu)
    [void]$posts.Add(@{
      text = ""
      identityText = ("interaction-anchor:{0}:{1}" -f [string]$anchor.avatarHash, [string]$menuHash)
      stableAnchorText = ""
      structureVerified = $true
      interactionOnly = $true
      regionHash = [string]$menuHash
      menuHash = [string]$menuHash
      avatarHash = [string]$anchor.avatarHash
      layoutHash = [string]$menuHash
      bounds = $post.bounds
      menuBounds = $anchor.menu.bounds
      avatarBounds = $post.avatarBounds
      partialVisible = [bool]$post.partialVisible
    })
  }
  return @{
    menus = @($menus.ToArray())
    posts = @()
    interactionPosts = @($posts.ToArray())
    postBoundaries = @()
    visibleAvatars = @()
    menuDiagnostics = @{
      componentCount = [int]$componentCount
      rawCandidateCount = [int]$rawCandidateCount
      acceptedCandidateCount = [int]$posts.Count
      rejectedWhitespaceCount = [int]$rejectedWhitespaceCount
      rejectedAvatarLaneCount = [int]$rejectedAvatarLaneCount
    }
  }
}

function Get-ExpectedMomentsSurface {
  try {
    if ([string]::IsNullOrWhiteSpace([string]$env:XIAOXI_MOMENTS_EXPECTED_SURFACE_BASE64)) { return $null }
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$env:XIAOXI_MOMENTS_EXPECTED_SURFACE_BASE64))
    return $json | ConvertFrom-Json
  } catch {
    return $null
  }
}

$processNames = @("Weixin", "WeChat")
$probeStopwatch = [Diagnostics.Stopwatch]::StartNew()
$phaseTimings = @{}
$expectedSurface = Get-ExpectedMomentsSurface
$allowBodyOnly = [string]$env:XIAOXI_MOMENTS_ALLOW_BODY_ONLY -ceq "1"
$interactionOnly = [string]$env:XIAOXI_MOMENTS_INTERACTION_ONLY -ceq "1"
$script:matches = @()
$callback = [Win32WechatMomentsVisualProbe+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if (-not [Win32WechatMomentsVisualProbe]::IsWindowVisible($hWnd)) { return $true }
  $titleText = New-Object System.Text.StringBuilder 512
  $classText = New-Object System.Text.StringBuilder 256
  [void][Win32WechatMomentsVisualProbe]::GetWindowText($hWnd, $titleText, $titleText.Capacity)
  [void][Win32WechatMomentsVisualProbe]::GetClassName($hWnd, $classText, $classText.Capacity)
  $title = $titleText.ToString().Trim()
  $className = $classText.ToString().Trim()
  if ($expectedSurface -ne $null) {
    if ([string]$expectedSurface.hWnd -cne [string]$hWnd.ToInt64() -or
      [string]$expectedSurface.title -cne $title -or [string]$expectedSurface.className -cne $className) { return $true }
  } elseif (@("朋友圈", "微信") -notcontains $title) { return $true }
  [uint32]$windowProcessId = 0
  [void][Win32WechatMomentsVisualProbe]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
  $process = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
  if ($process -eq $null -or $processNames -notcontains $process.ProcessName) { return $true }
  if ($expectedSurface -ne $null -and [int]$expectedSurface.pid -ne [int]$windowProcessId) { return $true }
  $rect = New-Object Win32WechatMomentsVisualProbe+RECT
  if (-not [Win32WechatMomentsVisualProbe]::GetWindowRect($hWnd, [ref]$rect)) { return $true }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 300 -or $height -lt 300) { return $true }
  $script:matches += @{
    title = $title
    className = $className
    surfaceMode = $(if ($title -ceq "朋友圈") { "standalone" } else { "integrated" })
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

$surfaceMatches = New-Object System.Collections.Generic.List[object]
$surfaceFailureReason = "moments_window_identity_mismatch"
$surfaceFailureDiagnostics = $null
foreach ($candidate in @($matches)) {
  $candidateHWnd = [IntPtr][int64]$candidate.hWnd
  try { $candidateRoot = [System.Windows.Automation.AutomationElement]::FromHandle($candidateHWnd) } catch { $candidateRoot = $null }
  if ($candidateRoot -eq $null) { continue }
  try {
    $candidateRootAutomationId = [string]$candidateRoot.Current.AutomationId
    $candidateRootName = [string]$candidateRoot.Current.Name
    $candidateRootControlType = [string]$candidateRoot.Current.ControlType.ProgrammaticName
    $candidateRootProcessId = [int]$candidateRoot.Current.ProcessId
  } catch { continue }
  $expectedRootName = $(if ([string]$candidate.surfaceMode -ceq "integrated") { "微信" } else { "朋友圈" })
  if ($candidateRootAutomationId -cne "" -or $candidateRootName -cne $expectedRootName -or
    $candidateRootControlType -cne "ControlType.Window" -or $candidateRootProcessId -ne [int]$candidate.pid) { continue }
  # UIA may expose sns_list alongside the rendered feed. Its presence does not
  # invalidate visual evidence; verify the actual window and render pane below.
  $candidatePane = Get-MomentsRenderPaneEvidence $candidateRoot $candidate.pid
  if (-not $candidatePane.ok) { $surfaceFailureReason = [string]$candidatePane.reason; continue }
  $candidateWindowBounds = @{ left = $candidate.left; top = $candidate.top; width = $candidate.width; height = $candidate.height }
  if (-not (Test-VisualBoundsInside $candidatePane.pane.bounds $candidateWindowBounds)) {
    $surfaceFailureReason = "moments_render_pane_bounds_invalid"
    continue
  }
  if ([string]$candidate.surfaceMode -ceq "integrated" -and $expectedSurface -eq $null) {
    [uint32]$dpi = 96
    try {
      $observedDpi = [Win32WechatMomentsVisualProbe]::GetDpiForWindow($candidateHWnd)
      if ($observedDpi -ge 72 -and $observedDpi -le 480) { $dpi = $observedDpi }
    } catch {}
    $candidateFrame = Get-MomentsVisualFrame $candidateHWnd $candidate.rect $candidate.pid $false
    if (-not $candidateFrame.ok) { $surfaceFailureReason = [string]$candidateFrame.reason; Close-MomentsVisualFrame $candidateFrame; continue }
    try {
      $candidateRelativePane = ConvertTo-RelativeVisualBounds $candidatePane.pane.bounds $candidate.left $candidate.top
      $candidateSurfaceBounds = @{ left = 0.0; top = 0.0; width = [double]$candidate.width; height = [double]$candidate.height }
      $headerProof = Test-IntegratedMomentsSurface $candidateFrame $candidateSurfaceBounds ([double]$dpi / 96.0)
      if (-not $headerProof.ok) {
        $surfaceFailureReason = [string]$headerProof.reason
        $surfaceFailureDiagnostics = $headerProof
        continue
      }
    } finally {
      Close-MomentsVisualFrame $candidateFrame
    }
  }
  [void]$surfaceMatches.Add($candidate)
}
$matches = @($surfaceMatches.ToArray())
if ($matches.Count -eq 0) { Write-Result @{ ok = $false; reason = $surfaceFailureReason; diagnostics = $surfaceFailureDiagnostics } }
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
$expectedRootName = $(if ([string]$matched.surfaceMode -ceq "integrated") { "微信" } else { "朋友圈" })
if ($rootAutomationId -cne "" -or $rootName -cne $expectedRootName -or $rootControlType -cne "ControlType.Window" -or $rootProcessId -ne $matched.pid) {
  Write-Result @{ ok = $false; reason = "moments_window_identity_mismatch" }
}
$renderEvidence = Get-MomentsRenderPaneEvidence $root $matched.pid
if (-not $renderEvidence.ok) { Write-Result $renderEvidence }
$windowBounds = @{ left = $matched.left; top = $matched.top; width = $matched.width; height = $matched.height }
if (-not (Test-VisualBoundsInside $renderEvidence.pane.bounds $windowBounds)) {
  Write-Result @{ ok = $false; reason = "moments_render_pane_bounds_invalid" }
}
$relativeRenderPaneBounds = ConvertTo-RelativeVisualBounds $renderEvidence.pane.bounds $matched.left $matched.top
[uint32]$dpi = 96
try {
  $observedDpi = [Win32WechatMomentsVisualProbe]::GetDpiForWindow($hWnd)
  if ($observedDpi -ge 72 -and $observedDpi -le 480) { $dpi = $observedDpi }
} catch {}
$scale = [double]$dpi / 96.0
$surfaceScanBounds = @{ left = 0.0; top = 0.0; width = [double]$matched.width; height = [double]$matched.height }
$surfaceResult = @{
  ok = $true
  surfaceMode = $matched.surfaceMode
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
}
$phaseTimings["window_lock_ms"] = [int]$probeStopwatch.ElapsedMilliseconds

$phaseStartedAt = $probeStopwatch.ElapsedMilliseconds
$firstFrame = Get-MomentsVisualFrame $hWnd $matched.rect $matched.pid $false
if (-not $firstFrame.ok) { Close-And-Write $firstFrame }
$phaseTimings["first_capture_ms"] = [int]($probeStopwatch.ElapsedMilliseconds - $phaseStartedAt)
$phaseStartedAt = $probeStopwatch.ElapsedMilliseconds
$firstHeader = $(if ([string]$matched.surfaceMode -ceq "integrated") { Test-IntegratedMomentsSurface $firstFrame $surfaceScanBounds $scale } else { @{ ok = $true } })
if (-not $firstHeader.ok) { Close-And-Write $firstHeader $firstFrame }
$firstSurfaceAnchorHash = $(if ([string]$matched.surfaceMode -ceq "integrated") {
  Get-MomentsPixelHash $firstFrame $firstHeader.selectedGreenRunBounds
} else { "" })
if ([string]$matched.surfaceMode -ceq "integrated" -and -not $firstSurfaceAnchorHash) {
  Close-And-Write @{ ok = $false; reason = "moments_integrated_surface_not_proven" } $firstFrame
}
$firstViewport = Get-MomentsVisualViewportBounds $relativeRenderPaneBounds $firstHeader ([string]$matched.surfaceMode)
if (-not $firstViewport.ok) { Close-And-Write $firstViewport $firstFrame }
$phaseTimings["first_surface_ms"] = [int]($probeStopwatch.ElapsedMilliseconds - $phaseStartedAt)
$phaseStartedAt = $probeStopwatch.ElapsedMilliseconds
$firstRead = Get-MomentsVisualPostCandidates $firstFrame $firstViewport.bounds (-not $interactionOnly)
$phaseTimings["first_candidates_ms"] = [int]($probeStopwatch.ElapsedMilliseconds - $phaseStartedAt)
$firstReading = @()
$phaseStartedAt = $probeStopwatch.ElapsedMilliseconds
Start-Sleep -Milliseconds 180
$phaseTimings["stability_wait_ms"] = [int]($probeStopwatch.ElapsedMilliseconds - $phaseStartedAt)
$phaseStartedAt = $probeStopwatch.ElapsedMilliseconds
$secondFrame = Get-MomentsVisualFrame $hWnd $matched.rect $matched.pid $false
if (-not $secondFrame.ok) { Close-And-Write $secondFrame $firstFrame }
$phaseTimings["second_capture_ms"] = [int]($probeStopwatch.ElapsedMilliseconds - $phaseStartedAt)
$phaseStartedAt = $probeStopwatch.ElapsedMilliseconds
$secondHeader = $(if ([string]$matched.surfaceMode -ceq "integrated") {
  $secondSurfaceAnchorHash = Get-MomentsPixelHash $secondFrame $firstHeader.selectedGreenRunBounds
  $secondGreenRatio = Get-MomentsSelectedGreenRatio $secondFrame $firstHeader.selectedGreenRunBounds
  if ($secondSurfaceAnchorHash -and [string]$secondSurfaceAnchorHash -ceq [string]$firstSurfaceAnchorHash -and $secondGreenRatio -ge 0.42) {
    @{
      ok = $true
      mode = "integrated_selected_moments_local_relock"
      greenRatio = [double]$secondGreenRatio
      contentLeft = [double]$firstHeader.contentLeft
      selectedGreenRunBounds = $firstHeader.selectedGreenRunBounds
    }
  } else {
    @{ ok = $false; reason = "moments_integrated_surface_not_proven" }
  }
} else { @{ ok = $true } })
if (-not $secondHeader.ok) { Close-And-Write $secondHeader $firstFrame $secondFrame }
$secondViewport = Get-MomentsVisualViewportBounds $relativeRenderPaneBounds $secondHeader ([string]$matched.surfaceMode)
if (-not $secondViewport.ok) { Close-And-Write $secondViewport $firstFrame $secondFrame }
if ([Math]::Abs([double]$firstViewport.bounds.left - [double]$secondViewport.bounds.left) -gt $script:momentsVisualStabilityTolerancePx -or
  [Math]::Abs([double]$firstViewport.bounds.width - [double]$secondViewport.bounds.width) -gt $script:momentsVisualStabilityTolerancePx) {
  Close-And-Write @{
    ok = $false
    reason = "moments_post_changed"
    diagnostics = @{ changeStage = "viewport_geometry" }
  } $firstFrame $secondFrame
}
$phaseTimings["second_surface_ms"] = [int]($probeStopwatch.ElapsedMilliseconds - $phaseStartedAt)
$phaseStartedAt = $probeStopwatch.ElapsedMilliseconds
$secondRead = $(if ($interactionOnly) {
  Get-LocalStableInteractionRead $secondFrame $secondViewport.bounds $firstRead
} else {
  Get-MomentsVisualPostCandidates $secondFrame $secondViewport.bounds $true
})
$phaseTimings["second_candidates_ms"] = [int]($probeStopwatch.ElapsedMilliseconds - $phaseStartedAt)
$secondReading = @()
$stableMenus = @(Get-UniqueStableVisualCandidates $firstRead.menus $secondRead.menus "menu")
$stablePosts = $(if ($interactionOnly) {
  @(Get-UniqueStableVisualCandidates $firstRead.interactionPosts $secondRead.interactionPosts "post")
} else {
  @(Get-UniqueStableVisualCandidates $firstRead.posts $secondRead.posts "post")
})
$stableReading = @()
if ($allowBodyOnly -and $stablePosts.Count -eq 0) {
  $firstReading = @(Get-MomentsVisualReadingCandidates $firstFrame $firstViewport.bounds ($firstRead.visibleAvatars))
  $secondReading = @(Get-MomentsVisualReadingCandidates $secondFrame $secondViewport.bounds ($secondRead.visibleAvatars))
  $stableReading = @(Get-UniqueStableVisualCandidates $firstReading $secondReading "reading")
}
$observedCandidateCount = @($firstRead.menus).Count + @($secondRead.menus).Count +
  @($firstRead.posts).Count + @($secondRead.posts).Count + @($firstReading).Count + @($secondReading).Count
if ($observedCandidateCount -gt 0 -and $stableMenus.Count -eq 0 -and $stablePosts.Count -eq 0 -and $stableReading.Count -eq 0) {
  Close-And-Write @{
    ok = $false
    reason = "moments_post_changed"
    diagnostics = @{
      changeStage = "candidate_stability"
      firstMenuCount = @($firstRead.menus).Count
      secondMenuCount = @($secondRead.menus).Count
      stableMenuCount = $stableMenus.Count
      firstPostCount = @($firstRead.posts).Count
      secondPostCount = @($secondRead.posts).Count
      stablePostCount = $stablePosts.Count
      firstReadingCount = @($firstReading).Count
      secondReadingCount = @($secondReading).Count
      stableReadingCount = $stableReading.Count
    }
  } $firstFrame $secondFrame
}
$posts = @($stablePosts)
if ($posts.Count -eq 0) {
  if ($allowBodyOnly -and $stableReading.Count -gt 0) {
    $absoluteReadingPosts = New-Object System.Collections.Generic.List[object]
    foreach ($post in @($stableReading)) {
      $absoluteBounds = ConvertTo-AbsoluteVisualBounds $post.bounds $matched.left $matched.top
      $absoluteAvatarBounds = ConvertTo-AbsoluteVisualBounds $post.avatarBounds $matched.left $matched.top
      if (-not (Test-VisualBoundsInside $absoluteBounds $renderEvidence.pane.bounds) -or
        -not (Test-VisualBoundsInside $absoluteAvatarBounds $renderEvidence.pane.bounds)) { continue }
      [void]$absoluteReadingPosts.Add(@{
        text = [string]$post.text
        identityText = [string]$post.identityText
        stableAnchorText = [string]$post.stableAnchorText
        structureVerified = $true
        regionHash = [string]$post.regionHash
        avatarHash = [string]$post.avatarHash
        layoutHash = [string]$post.layoutHash
        bounds = $absoluteBounds
        avatarBounds = $absoluteAvatarBounds
        partialVisible = $true
        bodyOnly = $true
      })
    }
    if ($absoluteReadingPosts.Count -gt 0) {
      $readingResult = $surfaceResult.Clone()
      $readingResult["posts"] = @()
      $readingResult["readingPosts"] = @($absoluteReadingPosts.ToArray())
      Close-And-Write $readingResult $firstFrame $secondFrame
    }
  }
  $menuOnlyMenus = New-Object System.Collections.Generic.List[object]
  foreach ($menu in @($stableMenus)) {
    $absoluteMenuBounds = ConvertTo-AbsoluteVisualBounds $menu.bounds $matched.left $matched.top
    $menuHash = Get-MomentsPixelHash $secondFrame $menu.bounds
    if (-not $menuHash -or -not (Test-VisualBoundsInside $absoluteMenuBounds $renderEvidence.pane.bounds)) { continue }
    [void]$menuOnlyMenus.Add(@{
      menuHash = [string]$menuHash
      menuBounds = $absoluteMenuBounds
    })
  }
  if ($menuOnlyMenus.Count -gt 0) {
    $menuOnlyResult = $surfaceResult.Clone()
    $menuOnlyResult["posts"] = @()
    $menuOnlyResult["menuOnlyMenus"] = @($menuOnlyMenus.ToArray())
    Close-And-Write $menuOnlyResult $firstFrame $secondFrame
  }
  Close-And-Write @{
    ok = $false
    reason = "moments_post_not_found"
    surface = $surfaceResult
    diagnostics = @{
      visualViewport = $secondViewport.bounds
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
  if (-not (Test-VisualBoundsInside $absoluteBounds $renderEvidence.pane.bounds) -or
    -not (Test-VisualBoundsInside $absoluteMenuBounds $renderEvidence.pane.bounds) -or
    -not (Test-VisualBoundsInside $absoluteAvatarBounds $renderEvidence.pane.bounds)) {
    Close-And-Write @{ ok = $false; reason = "moments_post_identity_missing" } $firstFrame $secondFrame
  }
  [void]$absolutePosts.Add(@{
    text = [string]$post.text
    identityText = [string]$post.identityText
    stableAnchorText = [string]$post.stableAnchorText
    structureVerified = $true
    regionHash = [string]$post.regionHash
    avatarHash = [string]$post.avatarHash
    layoutHash = [string]$post.layoutHash
    menuHash = [string]$post.menuHash
    interactionOnly = [bool]$post.interactionOnly
    bounds = $absoluteBounds
    menuBounds = $absoluteMenuBounds
    avatarBounds = $absoluteAvatarBounds
    partialVisible = [bool]$post.partialVisible
  })
}
$result = $surfaceResult.Clone()
$result["posts"] = @($absolutePosts.ToArray())
$result["diagnostics"] = @{
  firstMenu = $firstRead.menuDiagnostics
  secondMenu = $secondRead.menuDiagnostics
  stableMenuCount = $stableMenus.Count
  stablePostCount = $stablePosts.Count
  secondPassMode = $(if ($interactionOnly) { "local_interaction_anchor" } else { "full_post_ocr" })
  phaseTimings = $phaseTimings
  totalMs = [int]$probeStopwatch.ElapsedMilliseconds
}
Close-And-Write $result $firstFrame $secondFrame
`;

function probeVisualWechatMomentsWindow(expectedWindow, options = {}) {
  const expectedSurface = normalizeExpectedMomentsSurface(expectedWindow);
  return runPowerShell(
    MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT,
    {
      XIAOXI_MOMENTS_EXPECTED_SURFACE_BASE64: expectedSurface
        ? Buffer.from(JSON.stringify(expectedSurface), "utf8").toString("base64")
        : "",
      XIAOXI_MOMENTS_ALLOW_BODY_ONLY: options.allowBodyOnly === true ? "1" : "",
      XIAOXI_MOMENTS_INTERACTION_ONLY: options.interactionOnly === true ? "1" : ""
    },
    { ensure: false, sta: true, timeout: 30000, diagnostics: true }
  );
}

module.exports = {
  MOMENTS_VISUAL_STABILITY_TOLERANCE_PX,
  MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT,
  probeVisualWechatMomentsWindow
};
