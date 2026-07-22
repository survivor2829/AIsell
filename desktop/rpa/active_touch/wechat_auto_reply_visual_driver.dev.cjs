const { createHash } = require("node:crypto");
const { MOMENTS_VISUAL_READONLY_POWERSHELL } = require("./moments_visual_probe.dev.cjs");
const { runPowerShellAsync } = require("./wechat_window_driver.cjs");

const AUTO_REPLY_VISUAL_SCRIPT = String.raw`
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient

${MOMENTS_VISUAL_READONLY_POWERSHELL}

$script:AutoReplyVisualScale = 1.0

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32WechatAutoReplyVisual {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@

function Write-AutoReplyVisualResult($value) {
  $value | ConvertTo-Json -Compress -Depth 8
  exit
}

function Normalize-AutoReplyVisualText([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  $normalized = $value.Normalize([Text.NormalizationForm]::FormKC)
  return [Text.RegularExpressions.Regex]::Replace($normalized, "\s+", "").Trim()
}

function Get-AutoReplyVisualSha256([string]$value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$value))
    return ([BitConverter]::ToString($digest).Replace("-", "").ToLowerInvariant())
  } finally {
    $sha.Dispose()
  }
}

function Scale-AutoReplyVisualMetric([double]$value) {
  return $value * [double]$script:AutoReplyVisualScale
}

function Test-AutoReplyVisualTimeText([string]$value) {
  $text = Normalize-AutoReplyVisualText $value
  if (-not $text) { return $true }
  return $text -match "^(?:[0-2]?[0-9]:[0-5][0-9]|昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天]|[0-9]{1,2}/[0-9]{1,2}|[0-9]{4}/[0-9]{1,2}/[0-9]{1,2})$"
}

function Test-AutoReplyVisualPureText([string]$value) {
  $text = Normalize-AutoReplyVisualText $value
  if (-not $text -or $text.Length -gt 200) { return $false }
  if (Test-AutoReplyVisualTimeText $text) { return $false }
  if ($text -match "^\[(?:图片|动画表情|表情|语音|视频|文件|链接|小程序|位置|音乐|聊天记录|转账|红包|通话)\]$") { return $false }
  if ($text -match "^(?:图片|动画表情|语音|视频|文件|链接|小程序|位置|音乐|聊天记录|转账|红包|通话)$") { return $false }
  return $true
}

function Get-AutoReplyVisualLines($ocr) {
  $lines = New-Object System.Collections.Generic.List[object]
  foreach ($line in @($ocr.lines)) {
    if ($line -eq $null) { continue }
    $compact = Normalize-AutoReplyVisualText ([string]$line.text)
    if (-not $compact) { continue }
    [void]$lines.Add([pscustomobject]@{
      compact = $compact
      bounds = @{
        left = [double]$line.bounds.left
        top = [double]$line.bounds.top
        width = [double]$line.bounds.width
        height = [double]$line.bounds.height
      }
    })
  }
  return @($lines.ToArray())
}

function Test-AutoReplyVisualSidebarNameLine([string]$lineText, [string]$name) {
  if ([string]::IsNullOrWhiteSpace($lineText) -or [string]::IsNullOrWhiteSpace($name)) { return $false }
  if (-not $lineText.StartsWith($name, [StringComparison]::Ordinal)) { return $false }
  $suffix = $lineText.Substring($name.Length)
  return -not $suffix -or (Test-AutoReplyVisualTimeText $suffix)
}

function Test-AutoReplyVisualRedPixel($frame, [int]$x, [int]$y) {
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $frame.width -or $y -ge $frame.height) { return $false }
  $offset = ($y * $frame.stride) + ($x * 4)
  $blue = [int]$frame.bytes[$offset]
  $green = [int]$frame.bytes[$offset + 1]
  $red = [int]$frame.bytes[$offset + 2]
  # WeChat's unread badge uses the stable #FA5151 family. Requiring its lighter
  # red channel mix separates it from the darker saturated reds commonly found
  # in contact avatars, so the wider 4.1.12 search band does not create false
  # unread rows from brand artwork.
  return $red -ge 235 -and $green -ge 50 -and $green -le 125 -and
    $blue -ge 45 -and $blue -le 125 -and
    ($red - $green) -ge 105 -and ($red - $blue) -ge 105
}

function Test-AutoReplyVisualGreenPixel($frame, [int]$x, [int]$y) {
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $frame.width -or $y -ge $frame.height) { return $false }
  $offset = ($y * $frame.stride) + ($x * 4)
  $blue = [int]$frame.bytes[$offset]
  $green = [int]$frame.bytes[$offset + 1]
  $red = [int]$frame.bytes[$offset + 2]
  return $green -ge 105 -and $green -ge ($red + 28) -and $green -ge ($blue + 18)
}

function Get-AutoReplyVisualGreenRatio($frame, $rect) {
  $green = 0
  $total = 0
  $left = [int][Math]::Max(0, [Math]::Floor([double]$rect.left))
  $top = [int][Math]::Max(0, [Math]::Floor([double]$rect.top))
  $right = [int][Math]::Min($frame.width, [Math]::Ceiling([double]$rect.left + [double]$rect.width))
  $bottom = [int][Math]::Min($frame.height, [Math]::Ceiling([double]$rect.top + [double]$rect.height))
  for ($y = $top; $y -lt $bottom; $y += 2) {
    for ($x = $left; $x -lt $right; $x += 2) {
      if (Test-AutoReplyVisualGreenPixel $frame $x $y) { $green += 1 }
      $total += 1
    }
  }
  if ($total -eq 0) { return 0.0 }
  return [double]$green / [double]$total
}

function Get-AutoReplyVisualMessageRole($frame, $line, [double]$sidebarRight, $bubbleRect) {
  $paneWidth = [Math]::Max(1.0, [double]$frame.width - $sidebarRight)
  $left = [double]$line.bounds.left
  $right = $left + [double]$line.bounds.width
  $greenRatio = Get-AutoReplyVisualGreenRatio $frame $bubbleRect

  # WeChat renders our outgoing bubbles green. This local pixel proof takes
  # precedence over OCR geometry because a long right-aligned bubble can cross
  # the chat midpoint and make its text look left-aligned.
  if ($greenRatio -ge 0.16) { return "assistant" }

  # Geometry is only a conservative fallback. A line must be clearly anchored
  # to an edge; an ambiguous middle line is never treated as customer input.
  $rightInset = [Math]::Max((Scale-AutoReplyVisualMetric 18.0), $paneWidth * 0.035)
  if ($right -ge ([double]$frame.width - $rightInset) -and
      $left -ge ($sidebarRight + ($paneWidth * 0.18))) { return "assistant" }
  if ($left -le ($sidebarRight + ($paneWidth * 0.18)) -and
      $right -le ($sidebarRight + ($paneWidth * 0.84))) { return "user" }
  return "unknown"
}

function Get-AutoReplyVisualRowStats($frame, [int]$y, [int]$left, [int]$right) {
  if ($y -lt 0 -or $y -ge $frame.height -or $right -le $left) {
    return @{ samples = 0; luminance = 0.0; variance = 0.0; neutralRatio = 0.0; lightNeutralRatio = 0.0 }
  }
  $samples = 0
  $neutralPixels = 0
  $lightNeutralPixels = 0
  $luminanceTotal = 0.0
  $luminanceSquaredTotal = 0.0
  for ($x = [Math]::Max(0, $left); $x -lt [Math]::Min($frame.width, $right); $x += 4) {
    $offset = ($y * $frame.stride) + ($x * 4)
    $blue = [int]$frame.bytes[$offset]
    $green = [int]$frame.bytes[$offset + 1]
    $red = [int]$frame.bytes[$offset + 2]
    $maximum = [Math]::Max($red, [Math]::Max($green, $blue))
    $minimum = [Math]::Min($red, [Math]::Min($green, $blue))
    $luminance = ($red + $green + $blue) / 3.0
    $neutral = ($maximum - $minimum) -le 12
    if ($neutral) { $neutralPixels += 1 }
    if ($neutral -and $luminance -ge 238) { $lightNeutralPixels += 1 }
    $luminanceTotal += $luminance
    $luminanceSquaredTotal += ($luminance * $luminance)
    $samples += 1
  }
  if ($samples -eq 0) {
    return @{ samples = 0; luminance = 0.0; variance = 0.0; neutralRatio = 0.0; lightNeutralRatio = 0.0 }
  }
  $mean = $luminanceTotal / [double]$samples
  return @{
    samples = $samples
    luminance = $mean
    variance = [Math]::Max(0.0, ($luminanceSquaredTotal / [double]$samples) - ($mean * $mean))
    neutralRatio = [double]$neutralPixels / [double]$samples
    lightNeutralRatio = [double]$lightNeutralPixels / [double]$samples
  }
}

function Get-AutoReplyVisualHorizontalEdgeStats($frame, [int]$y, [int]$left, [int]$right, [int]$offset) {
  if ($y -lt $offset -or $y -ge ($frame.height - $offset) -or $right -le $left) {
    return @{ samples = 0; edgeRatio = 0.0; luminance = 0.0 }
  }
  $samples = 0
  $edgePixels = 0
  $luminanceTotal = 0.0
  for ($x = [Math]::Max(0, $left); $x -lt [Math]::Min($frame.width, $right); $x += 4) {
    $centerOffset = ($y * $frame.stride) + ($x * 4)
    $aboveOffset = (($y - $offset) * $frame.stride) + ($x * 4)
    $belowOffset = (($y + $offset) * $frame.stride) + ($x * 4)
    $blue = [int]$frame.bytes[$centerOffset]
    $green = [int]$frame.bytes[$centerOffset + 1]
    $red = [int]$frame.bytes[$centerOffset + 2]
    $maximum = [Math]::Max($red, [Math]::Max($green, $blue))
    $minimum = [Math]::Min($red, [Math]::Min($green, $blue))
    $centerLuminance = ($red + $green + $blue) / 3.0
    $aboveLuminance = ([int]$frame.bytes[$aboveOffset] + [int]$frame.bytes[$aboveOffset + 1] + [int]$frame.bytes[$aboveOffset + 2]) / 3.0
    $belowLuminance = ([int]$frame.bytes[$belowOffset] + [int]$frame.bytes[$belowOffset + 1] + [int]$frame.bytes[$belowOffset + 2]) / 3.0
    if (($maximum - $minimum) -le 12 -and
        $centerLuminance -ge 180 -and $centerLuminance -le 252 -and
        $centerLuminance -le ($aboveLuminance - 2.0) -and
        $centerLuminance -le ($belowLuminance - 2.0)) {
      $edgePixels += 1
    }
    $luminanceTotal += $centerLuminance
    $samples += 1
  }
  if ($samples -eq 0) { return @{ samples = 0; edgeRatio = 0.0; luminance = 0.0 } }
  return @{
    samples = $samples
    edgeRatio = [double]$edgePixels / [double]$samples
    luminance = $luminanceTotal / [double]$samples
  }
}

function Test-AutoReplyVisualEditorArea($frame, [int]$dividerY, [int]$left, [int]$right) {
  # Only inspect the shallow, normally blank strip immediately below the
  # divider. Toolbar icons and a typed draft can exist deeper in the editor.
  $validRows = 0
  foreach ($logicalOffset in @(4.0, 8.0, 14.0)) {
    $rowY = $dividerY + [Math]::Max(2, [int][Math]::Round((Scale-AutoReplyVisualMetric $logicalOffset)))
    if ($rowY -ge $frame.height) { return $false }
    $row = Get-AutoReplyVisualRowStats $frame $rowY $left $right
    if ($row.samples -eq 0 -or $row.luminance -lt 238.0 -or
        $row.neutralRatio -lt 0.88 -or $row.lightNeutralRatio -lt 0.82 -or
        $row.variance -gt 420.0) { return $false }
    $validRows += 1
  }
  return $validRows -eq 3
}

function Get-AutoReplyVisualChatBottom($frame, [double]$sidebarRight) {
  # The composer begins at a long neutral horizontal separator. Detect it so
  # the final real bubble row remains eligible without admitting draft text.
  $left = [int][Math]::Max(0, [Math]::Round($sidebarRight + (Scale-AutoReplyVisualMetric 8.0)))
  $right = [int][Math]::Min($frame.width, [Math]::Round([double]$frame.width - (Scale-AutoReplyVisualMetric 8.0)))
  $startY = [int][Math]::Floor([double]$frame.height * 0.55)
  $endY = [int][Math]::Ceiling([double]$frame.height * 0.92)
  $candidateY = -1
  for ($y = $startY; $y -le $endY; $y++) {
    $edge = Get-AutoReplyVisualHorizontalEdgeStats $frame $y $left $right 3
    if ($edge.samples -eq 0 -or $edge.edgeRatio -lt 0.78) { continue }
    if (-not (Test-AutoReplyVisualEditorArea $frame $y $left $right)) { continue }
    # Chat bubbles can create shorter horizontal edges above the composer. The
    # proven composer divider is the lowest broad edge with a light editor below.
    $candidateY = $y
  }
  if ($candidateY -ge 0) {
    return @{
      ok = $true
      bottom = [double][Math]::Max(0, $candidateY - [Math]::Max(1, [int][Math]::Round($script:AutoReplyVisualScale * 2.0)))
      dividerY = [double]$candidateY
      source = "composer_divider"
    }
  }
  return @{ ok = $false; reason = "chat_boundary_unresolved"; source = "none" }
}

function Test-AutoReplyVisualUnreadDot($frame, $nameBounds) {
  # WeChat versions place the unread badge anywhere from above the name to the
  # name's vertical center. Keep the horizontal band tight around the avatar's
  # upper-right edge so a red avatar body is still rejected by blob geometry.
  # The 4.1.12 sidebar at 125% DPI places the badge over the avatar, farther
  # left than 4.1.11. The former 16-pixel strip clipped the circle into a thin
  # fragment, which then failed the round-blob test. Capture the complete
  # avatar upper-right band; the component size/roundness checks below still
  # reject a full red avatar and irregular artwork.
  $xStart = [int][Math]::Max(0, [Math]::Floor([double]$nameBounds.left - (Scale-AutoReplyVisualMetric 44.0)))
  # Some OCR providers merge the white badge count into the adjacent name
  # line, making the reported text bounds begin at the badge itself. Include a
  # small band to the right of that bound so this representation is equivalent
  # to providers that return the name and badge separately.
  $xEnd = [int][Math]::Min($frame.width - 1, [Math]::Ceiling([double]$nameBounds.left + (Scale-AutoReplyVisualMetric 24.0)))
  $yStart = [int][Math]::Max(0, [Math]::Floor([double]$nameBounds.top - (Scale-AutoReplyVisualMetric 22.0)))
  $yEnd = [int][Math]::Min($frame.height - 1, [Math]::Ceiling(
    [double]$nameBounds.top + [Math]::Max((Scale-AutoReplyVisualMetric 12.0), [double]$nameBounds.height * 0.65)
  ))
  $regionWidth = $xEnd - $xStart + 1
  $regionHeight = $yEnd - $yStart + 1
  if ($regionWidth -lt (Scale-AutoReplyVisualMetric 8.0) -or $regionHeight -lt (Scale-AutoReplyVisualMetric 8.0)) { return $false }
  $mask = New-Object bool[] ($regionWidth * $regionHeight)
  for ($localY = 0; $localY -lt $regionHeight; $localY++) {
    for ($localX = 0; $localX -lt $regionWidth; $localX++) {
      $mask[($localY * $regionWidth) + $localX] = Test-AutoReplyVisualRedPixel $frame ($xStart + $localX) ($yStart + $localY)
    }
  }
  $seen = New-Object bool[] $mask.Length
  for ($seedY = 0; $seedY -lt $regionHeight; $seedY++) {
    for ($seedX = 0; $seedX -lt $regionWidth; $seedX++) {
      $seedIndex = ($seedY * $regionWidth) + $seedX
      if (-not $mask[$seedIndex] -or $seen[$seedIndex]) { continue }
      $queue = New-Object System.Collections.Generic.Queue[int]
      $queue.Enqueue($seedIndex)
      $seen[$seedIndex] = $true
      $minX = $seedX; $maxX = $seedX; $minY = $seedY; $maxY = $seedY; $count = 0
      while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        $currentY = [int][Math]::Floor($current / $regionWidth)
        $currentX = $current - ($currentY * $regionWidth)
        $minX = [Math]::Min($minX, $currentX); $maxX = [Math]::Max($maxX, $currentX)
        $minY = [Math]::Min($minY, $currentY); $maxY = [Math]::Max($maxY, $currentY); $count += 1
        foreach ($delta in @(@(-1,-1), @(0,-1), @(1,-1), @(-1,0), @(1,0), @(-1,1), @(0,1), @(1,1))) {
          $nextX = $currentX + $delta[0]; $nextY = $currentY + $delta[1]
          if ($nextX -lt 0 -or $nextY -lt 0 -or $nextX -ge $regionWidth -or $nextY -ge $regionHeight) { continue }
          $nextIndex = ($nextY * $regionWidth) + $nextX
          if ($mask[$nextIndex] -and -not $seen[$nextIndex]) {
            $seen[$nextIndex] = $true
            $queue.Enqueue($nextIndex)
          }
        }
      }
      $width = $maxX - $minX + 1; $height = $maxY - $minY + 1
      $minimumBlob = Scale-AutoReplyVisualMetric 5.0
      $maximumBlob = Scale-AutoReplyVisualMetric 25.0
      $minimumPixels = 14.0 * $script:AutoReplyVisualScale * $script:AutoReplyVisualScale
      $maximumPixels = 520.0 * $script:AutoReplyVisualScale * $script:AutoReplyVisualScale
      if ($width -lt $minimumBlob -or $width -gt $maximumBlob -or $height -lt $minimumBlob -or $height -gt $maximumBlob -or $count -lt $minimumPixels -or $count -gt $maximumPixels) { continue }
      $ratio = [double][Math]::Max($width, $height) / [double][Math]::Max(1, [Math]::Min($width, $height))
      $density = [double]$count / [double]($width * $height)
      if ($ratio -le 1.75 -and $density -ge 0.25) { return $true }
    }
  }
  return $false
}

function Get-AutoReplyVisualUnreadBadges($frame, [double]$sidebarRight) {
  # Discover unread events from WeChat's own badge pixels before involving
  # contact OCR. This is the cross-machine path for renamed contacts and OCR
  # providers that merge the badge count into the adjacent name line.
  $xStart = [int][Math]::Max(0, [Math]::Floor((Scale-AutoReplyVisualMetric 58.0)))
  $xEnd = [int][Math]::Min($frame.width - 1, [Math]::Ceiling([Math]::Min($sidebarRight - (Scale-AutoReplyVisualMetric 80.0), (Scale-AutoReplyVisualMetric 170.0))))
  $yStart = [int][Math]::Max(0, [Math]::Floor((Scale-AutoReplyVisualMetric 70.0)))
  $yEnd = [int][Math]::Min($frame.height - 1, [Math]::Ceiling($frame.height - (Scale-AutoReplyVisualMetric 42.0)))
  if ($xEnd -le $xStart -or $yEnd -le $yStart) { return @() }
  $regionWidth = $xEnd - $xStart + 1; $regionHeight = $yEnd - $yStart + 1
  $mask = New-Object bool[] ($regionWidth * $regionHeight)
  for ($localY = 0; $localY -lt $regionHeight; $localY++) {
    for ($localX = 0; $localX -lt $regionWidth; $localX++) {
      $mask[($localY * $regionWidth) + $localX] = Test-AutoReplyVisualRedPixel $frame ($xStart + $localX) ($yStart + $localY)
    }
  }
  $seen = New-Object bool[] $mask.Length
  $badges = New-Object System.Collections.Generic.List[object]
  for ($seedY = 0; $seedY -lt $regionHeight; $seedY++) {
    for ($seedX = 0; $seedX -lt $regionWidth; $seedX++) {
      $seedIndex = ($seedY * $regionWidth) + $seedX
      if (-not $mask[$seedIndex] -or $seen[$seedIndex]) { continue }
      $queue = New-Object System.Collections.Generic.Queue[int]
      $queue.Enqueue($seedIndex); $seen[$seedIndex] = $true
      $minX = $seedX; $maxX = $seedX; $minY = $seedY; $maxY = $seedY; $count = 0
      while ($queue.Count -gt 0) {
        $current = $queue.Dequeue(); $currentY = [int][Math]::Floor($current / $regionWidth); $currentX = $current - ($currentY * $regionWidth)
        $minX = [Math]::Min($minX, $currentX); $maxX = [Math]::Max($maxX, $currentX)
        $minY = [Math]::Min($minY, $currentY); $maxY = [Math]::Max($maxY, $currentY); $count += 1
        foreach ($delta in @(@(-1,-1), @(0,-1), @(1,-1), @(-1,0), @(1,0), @(-1,1), @(0,1), @(1,1))) {
          $nextX = $currentX + $delta[0]; $nextY = $currentY + $delta[1]
          if ($nextX -lt 0 -or $nextY -lt 0 -or $nextX -ge $regionWidth -or $nextY -ge $regionHeight) { continue }
          $nextIndex = ($nextY * $regionWidth) + $nextX
          if ($mask[$nextIndex] -and -not $seen[$nextIndex]) { $seen[$nextIndex] = $true; $queue.Enqueue($nextIndex) }
        }
      }
      $width = $maxX - $minX + 1; $height = $maxY - $minY + 1
      $minimumBlob = Scale-AutoReplyVisualMetric 8.0; $maximumBlob = Scale-AutoReplyVisualMetric 28.0
      $minimumPixels = 28.0 * $script:AutoReplyVisualScale * $script:AutoReplyVisualScale
      if ($width -lt $minimumBlob -or $width -gt $maximumBlob -or $height -lt $minimumBlob -or $height -gt $maximumBlob -or $count -lt $minimumPixels) { continue }
      $ratio = [double][Math]::Max($width, $height) / [double][Math]::Max(1, [Math]::Min($width, $height))
      $density = [double]$count / [double]($width * $height)
      if ($ratio -gt 1.65 -or $density -lt 0.25) { continue }
      [void]$badges.Add([pscustomobject]@{
        left = $xStart + $minX; top = $yStart + $minY; width = $width; height = $height
        centerX = $xStart + (($minX + $maxX) * 0.5); centerY = $yStart + (($minY + $maxY) * 0.5)
      })
    }
  }
  return @($badges.ToArray() | Sort-Object top, left)
}

function Test-AutoReplyVisualBadgeRemains($frame, $badge) {
  $left = [int][Math]::Max(0, [Math]::Floor([double]$badge.left - 2)); $top = [int][Math]::Max(0, [Math]::Floor([double]$badge.top - 2))
  $right = [int][Math]::Min($frame.width - 1, [Math]::Ceiling([double]$badge.left + [double]$badge.width + 2))
  $bottom = [int][Math]::Min($frame.height - 1, [Math]::Ceiling([double]$badge.top + [double]$badge.height + 2))
  $count = 0
  for ($y = $top; $y -le $bottom; $y++) { for ($x = $left; $x -le $right; $x++) { if (Test-AutoReplyVisualRedPixel $frame $x $y) { $count += 1 } } }
  return $count -ge [Math]::Max(8, [int][Math]::Round(18.0 * $script:AutoReplyVisualScale * $script:AutoReplyVisualScale))
}

function Get-AutoReplyVisualSidebarRows($frame, $lines, $allowedSet, [double]$sidebarRight) {
  $nameMatches = New-Object System.Collections.Generic.List[object]
  foreach ($line in $lines) {
    $left = [double]$line.bounds.left; $top = [double]$line.bounds.top
    $right = $left + [double]$line.bounds.width
    if ($left -lt (Scale-AutoReplyVisualMetric 42.0) -or $right -gt ($sidebarRight + (Scale-AutoReplyVisualMetric 8.0)) -or $top -lt (Scale-AutoReplyVisualMetric 72.0) -or $top -gt ($frame.height - (Scale-AutoReplyVisualMetric 42.0))) { continue }
    foreach ($name in $allowedSet) {
      if (Test-AutoReplyVisualSidebarNameLine ([string]$line.compact) ([string]$name)) {
        [void]$nameMatches.Add([pscustomobject]@{ name = [string]$name; line = $line; discovered = $false })
      }
    }
  }
  # Auto reply follows actual unread one-to-one sessions. Contact sync is used
  # by active touch and can expose a stale nickname while WeChat renders a local
  # remark. Discover that rendered name from the unread badge instead of
  # silently filtering the customer out through the synced-name whitelist.
  foreach ($line in $lines) {
    $left = [double]$line.bounds.left; $top = [double]$line.bounds.top
    $right = $left + [double]$line.bounds.width
    $name = Normalize-AutoReplyVisualText ([string]$line.compact)
    $looksLikePreview = @($lines | Where-Object {
      $otherTop = [double]$_.bounds.top
      $otherLeft = [double]$_.bounds.left
      $otherTop -lt $top -and
        $otherTop -ge ($top - (Scale-AutoReplyVisualMetric 34.0)) -and
        [Math]::Abs($otherLeft - $left) -le (Scale-AutoReplyVisualMetric 18.0) -and
        (Test-AutoReplyVisualPureText ([string]$_.compact))
    }).Count -gt 0
    if (-not $name -or $name.Length -gt 64 -or $looksLikePreview -or
        $left -lt (Scale-AutoReplyVisualMetric 42.0) -or
        $right -gt ($sidebarRight + (Scale-AutoReplyVisualMetric 8.0)) -or
        $top -lt (Scale-AutoReplyVisualMetric 72.0) -or
        $top -gt ($frame.height - (Scale-AutoReplyVisualMetric 42.0)) -or
        -not (Test-AutoReplyVisualPureText $name) -or
        $allowedSet.Contains($name) -or
        $script:AutoReplyVisualExcludedNames.Contains($name) -or
        -not (Test-AutoReplyVisualUnreadDot $frame $line.bounds)) { continue }
    [void]$nameMatches.Add([pscustomobject]@{ name = $name; line = $line; discovered = $true })
  }
  $rows = New-Object System.Collections.Generic.List[object]
  foreach ($group in @($nameMatches.ToArray() | Group-Object name)) {
    if ($group.Count -ne 1) {
      return @{ ok = $false; reason = "visual_sidebar_match_ambiguous"; rows = @() }
    }
    $match = $group.Group[0]
    $nameLine = $match.line
    $nameBottom = [double]$nameLine.bounds.top + [double]$nameLine.bounds.height
    $previewCandidates = @($lines | Where-Object {
      $candidateLeft = [double]$_.bounds.left
      $candidateTop = [double]$_.bounds.top
      $candidateRight = $candidateLeft + [double]$_.bounds.width
      $candidateTop -ge ($nameBottom - (Scale-AutoReplyVisualMetric 3.0)) -and
        $candidateTop -le ([double]$nameLine.bounds.top + (Scale-AutoReplyVisualMetric 58.0)) -and
        $candidateLeft -ge ([double]$nameLine.bounds.left - (Scale-AutoReplyVisualMetric 14.0)) -and
        $candidateRight -le ($sidebarRight + (Scale-AutoReplyVisualMetric 8.0)) -and
        (Test-AutoReplyVisualPureText ([string]$_.compact))
    } | Sort-Object { [double]$_.bounds.top }, { [double]$_.bounds.left })
    if ($previewCandidates.Count -eq 0) { continue }
    $previewLine = $previewCandidates[0]
    $preview = Normalize-AutoReplyVisualText ([string]$previewLine.compact)
    if (-not (Test-AutoReplyVisualPureText $preview)) { continue }
    $isDraft = $preview -match "^\[?草稿\]?[：:]?"
    [void]$rows.Add([pscustomobject]@{
      conversation = [string]$match.name
      preview = $preview
      signature = Get-AutoReplyVisualSha256 $preview
      unread = [bool](Test-AutoReplyVisualUnreadDot $frame $nameLine.bounds)
      draft = [bool]$isDraft
      discoveredConversation = [bool]$match.discovered
      nameBounds = $nameLine.bounds
      previewBounds = $previewLine.bounds
    })
  }
  return @{ ok = $true; rows = @($rows.ToArray() | Sort-Object { [double]$_.nameBounds.top }) }
}

function Get-AutoReplyVisualBaseline($baselines, [string]$conversation) {
  if ($baselines -eq $null) { return "" }
  foreach ($property in $baselines.PSObject.Properties) {
    if ($property.Name -ceq $conversation) { return ([string]$property.Value).ToLowerInvariant() }
  }
  return ""
}

function Get-AutoReplyVisualSidebarRight([double]$windowWidth, [double]$dpi) {
  # UI Automation and capture coordinates are physical pixels, while WeChat's
  # sidebar is about 300 device-independent pixels. Scale the boundary using
  # the actual target-window DPI so 100%, 125% and 150% displays agree.
  if ($dpi -lt 72 -or $dpi -gt 480) { $dpi = 96.0 }
  $scale = $dpi / 96.0
  $expected = 300.0 * $scale
  $compactLimit = [Math]::Max(230.0 * $scale, $windowWidth * 0.45)
  return [Math]::Min($expected, $compactLimit)
}

function Test-AutoReplyVisualViewportOwned($windowRect, [int]$expectedProcessId) {
  $width = [double]($windowRect.Right - $windowRect.Left)
  $height = [double]($windowRect.Bottom - $windowRect.Top)
  foreach ($xRatio in @(0.08, 0.5, 0.92)) {
    foreach ($yRatio in @(0.08, 0.5, 0.92)) {
      $point = New-Object Win32WechatMomentsVisualReadOnly+POINT
      $point.X = [int][Math]::Round($windowRect.Left + ($width * $xRatio))
      $point.Y = [int][Math]::Round($windowRect.Top + ($height * $yRatio))
      $hit = [Win32WechatMomentsVisualReadOnly]::WindowFromPoint($point)
      if ($hit -eq [IntPtr]::Zero) { return $false }
      [uint32]$hitProcessId = 0
      [void][Win32WechatMomentsVisualReadOnly]::GetWindowThreadProcessId($hit, [ref]$hitProcessId)
      if ([int]$hitProcessId -ne $expectedProcessId) { return $false }
    }
  }
  return $true
}

function Get-AutoReplyVisualFrame([IntPtr]$hWnd, $windowRect, [int]$expectedProcessId) {
  if (-not [Win32WechatMomentsVisualReadOnly]::IsWindowVisible($hWnd) -or [Win32WechatMomentsVisualReadOnly]::IsIconic($hWnd)) {
    return @{ ok = $false; reason = "wechat_window_missing" }
  }
  [void][Win32WechatMomentsVisualReadOnly]::ShowWindowAsync($hWnd, 9)
  [void][Win32WechatMomentsVisualReadOnly]::SetForegroundWindow($hWnd)
  Start-Sleep -Milliseconds 140
  if ([Win32WechatMomentsVisualReadOnly]::GetForegroundWindow() -ne $hWnd) { return @{ ok = $false; reason = "wechat_window_not_foreground" } }
  if (-not (Test-AutoReplyVisualViewportOwned $windowRect $expectedProcessId)) { return @{ ok = $false; reason = "wechat_window_obscured" } }
  $width = [int]($windowRect.Right - $windowRect.Left); $height = [int]($windowRect.Bottom - $windowRect.Top)
  $bitmap = $null; $graphics = $null
  try {
    $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen([int]$windowRect.Left, [int]$windowRect.Top, 0, 0, [System.Drawing.Size]::new($width, $height), [System.Drawing.CopyPixelOperation]::SourceCopy)
  } catch {
    if ($bitmap) { $bitmap.Dispose() }
    return @{ ok = $false; reason = "visual_capture_failed" }
  } finally {
    if ($graphics) { $graphics.Dispose() }
  }
  try {
    $lockRect = [System.Drawing.Rectangle]::new(0, 0, $width, $height)
    $bitmapData = $bitmap.LockBits($lockRect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $stride = [Math]::Abs([int]$bitmapData.Stride)
      $bytes = New-Object byte[] ($stride * $height)
      [Runtime.InteropServices.Marshal]::Copy($bitmapData.Scan0, $bytes, 0, $bytes.Length)
    } finally {
      $bitmap.UnlockBits($bitmapData)
    }
  } catch {
    $bitmap.Dispose()
    return @{ ok = $false; reason = "visual_capture_failed" }
  }
  return @{ ok = $true; bitmap = $bitmap; bytes = $bytes; stride = $stride; width = $width; height = $height }
}

function Test-AutoReplyVisualPointOwned([int]$screenX, [int]$screenY, [IntPtr]$expectedHWnd, [int]$expectedPid) {
  $point = New-Object Win32WechatMomentsVisualReadOnly+POINT
  $point.X = $screenX; $point.Y = $screenY
  $hit = [Win32WechatMomentsVisualReadOnly]::WindowFromPoint($point)
  if ($hit -eq [IntPtr]::Zero) { return $false }
  $hitRoot = [Win32WechatMomentsVisualReadOnly]::GetAncestor($hit, 2)
  if ($hitRoot -eq [IntPtr]::Zero) { return $false }
  [uint32]$hitPid = 0
  [void][Win32WechatMomentsVisualReadOnly]::GetWindowThreadProcessId($hit, [ref]$hitPid)
  [uint32]$rootPid = 0
  [void][Win32WechatMomentsVisualReadOnly]::GetWindowThreadProcessId($hitRoot, [ref]$rootPid)
  return [int]$hitPid -eq $expectedPid -and [int]$rootPid -eq $expectedPid -and [Win32WechatMomentsVisualReadOnly]::GetForegroundWindow() -eq $expectedHWnd
}

function Open-AutoReplyVisualConversation($row, [IntPtr]$hWnd, [int]$expectedProcessId, $windowRect) {
  [void][Win32WechatMomentsVisualReadOnly]::ShowWindowAsync($hWnd, 9)
  [void][Win32WechatMomentsVisualReadOnly]::SetForegroundWindow($hWnd)
  Start-Sleep -Milliseconds 120
  if ([Win32WechatMomentsVisualReadOnly]::GetForegroundWindow() -ne $hWnd) { return $false }
  # Click the center of the matched name glyphs. The previous Y coordinate sat
  # in the preview line, which is less reliable in a compressed session list.
  $localX = [int][Math]::Round([double]$row.nameBounds.left + [Math]::Min((Scale-AutoReplyVisualMetric 40.0), [Math]::Max((Scale-AutoReplyVisualMetric 8.0), [double]$row.nameBounds.width * 0.5)))
  $localY = [int][Math]::Round([double]$row.nameBounds.top + ([double]$row.nameBounds.height * 0.5))
  $screenX = [int]$windowRect.Left + $localX; $screenY = [int]$windowRect.Top + $localY
  if (-not (Test-AutoReplyVisualPointOwned $screenX $screenY $hWnd $expectedProcessId)) { return $false }
  $oldPoint = New-Object Win32WechatAutoReplyVisual+POINT
  [void][Win32WechatAutoReplyVisual]::GetCursorPos([ref]$oldPoint)
  try {
    [void][Win32WechatAutoReplyVisual]::SetCursorPos($screenX, $screenY)
    [Win32WechatAutoReplyVisual]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 45
    [Win32WechatAutoReplyVisual]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 430
  } finally {
    [void][Win32WechatAutoReplyVisual]::SetCursorPos($oldPoint.X, $oldPoint.Y)
  }
  return [Win32WechatMomentsVisualReadOnly]::GetForegroundWindow() -eq $hWnd
}

function Get-AutoReplyVisualHeader($lines, [string]$conversation, [double]$sidebarRight, [double]$frameWidth) {
  $headerLines = @($lines | Where-Object {
    [double]$_.bounds.left -ge ($sidebarRight + (Scale-AutoReplyVisualMetric 8.0)) -and
      [double]$_.bounds.left -lt ($frameWidth - (Scale-AutoReplyVisualMetric 20.0)) -and
      [double]$_.bounds.top -ge (Scale-AutoReplyVisualMetric 20.0) -and [double]$_.bounds.top -le (Scale-AutoReplyVisualMetric 108.0)
  })
  $prefixed = @($headerLines | Where-Object { ([string]$_.compact).StartsWith($conversation, [StringComparison]::Ordinal) })
  $exact = @($prefixed | Where-Object { [string]$_.compact -ceq $conversation })
  if ($prefixed.Count -ne 1 -or $exact.Count -ne 1) { return @{ ok = $false; reason = "conversation_title_mismatch" } }
  return @{ ok = $true; line = $exact[0] }
}

function Get-AutoReplyVisualAnyHeader($lines, [double]$sidebarRight, [double]$frameWidth) {
  $matches = @($lines | Where-Object {
    $text = Normalize-AutoReplyVisualText ([string]$_.compact)
    $text -and $text.Length -le 64 -and -not (Test-AutoReplyVisualTimeText $text) -and
      [double]$_.bounds.left -ge ($sidebarRight + (Scale-AutoReplyVisualMetric 8.0)) -and
      [double]$_.bounds.left -lt ($frameWidth - (Scale-AutoReplyVisualMetric 80.0)) -and
      [double]$_.bounds.top -ge (Scale-AutoReplyVisualMetric 20.0) -and [double]$_.bounds.top -le (Scale-AutoReplyVisualMetric 108.0)
  } | Sort-Object { [double]$_.bounds.left }, { [double]$_.bounds.top })
  if ($matches.Count -eq 0) { return @{ ok = $false; reason = "conversation_title_mismatch" } }
  return @{ ok = $true; conversation = Normalize-AutoReplyVisualText ([string]$matches[0].compact); line = $matches[0] }
}

function Get-AutoReplyVisualCurrentConversation($lines, $allowedSet, [double]$sidebarRight, [double]$frameWidth) {
  $matches = New-Object System.Collections.Generic.List[string]
  foreach ($line in $lines) {
    if ([double]$line.bounds.left -lt ($sidebarRight + (Scale-AutoReplyVisualMetric 8.0)) -or
        [double]$line.bounds.left -ge ($frameWidth - (Scale-AutoReplyVisualMetric 20.0)) -or
        [double]$line.bounds.top -lt (Scale-AutoReplyVisualMetric 20.0) -or [double]$line.bounds.top -gt (Scale-AutoReplyVisualMetric 108.0)) { continue }
    foreach ($name in $allowedSet) {
      if ([string]$line.compact -ceq [string]$name) { [void]$matches.Add([string]$name) }
    }
  }
  $unique = @($matches.ToArray() | Select-Object -Unique)
  if ($unique.Count -eq 0) { return @{ ok = $true; active = $false; conversation = "" } }
  if ($unique.Count -ne 1) { return @{ ok = $false; reason = "current_conversation_ambiguous" } }
  return @{ ok = $true; active = $true; conversation = [string]$unique[0] }
}

function Get-AutoReplyVisualBubbleRect($frame, $line, [double]$sidebarRight) {
  $left = [Math]::Max($sidebarRight, [double]$line.bounds.left - (Scale-AutoReplyVisualMetric 12.0))
  $top = [Math]::Max(0.0, [double]$line.bounds.top - (Scale-AutoReplyVisualMetric 8.0))
  $right = [Math]::Min([double]$frame.width, [double]$line.bounds.left + [double]$line.bounds.width + (Scale-AutoReplyVisualMetric 12.0))
  $bottom = [Math]::Min([double]$frame.height, [double]$line.bounds.top + [double]$line.bounds.height + (Scale-AutoReplyVisualMetric 8.0))
  return @{
    left = $left
    top = $top
    width = [Math]::Max(1.0, $right - $left)
    height = [Math]::Max(1.0, $bottom - $top)
  }
}

function Merge-AutoReplyVisualMessageParts($parts, [bool]$sameRow = $false) {
  $items = @($parts)
  if ($items.Count -eq 0) { return $null }
  $left = [double]::PositiveInfinity
  $top = [double]::PositiveInfinity
  $right = 0.0
  $bottom = 0.0
  $partCount = 0
  $texts = New-Object System.Collections.Generic.List[string]
  $orderedItems = if ($sameRow) {
    @($items | Sort-Object { [double]$_.bounds.left }, { [double]$_.bounds.top })
  } else {
    @($items | Sort-Object { [double]$_.bounds.top }, { [double]$_.bounds.left })
  }
  foreach ($item in $orderedItems) {
    $itemLeft = [double]$item.bounds.left
    $itemTop = [double]$item.bounds.top
    $itemRight = $itemLeft + [double]$item.bounds.width
    $itemBottom = $itemTop + [double]$item.bounds.height
    $left = [Math]::Min($left, $itemLeft)
    $top = [Math]::Min($top, $itemTop)
    $right = [Math]::Max($right, $itemRight)
    $bottom = [Math]::Max($bottom, $itemBottom)
    [void]$texts.Add((Normalize-AutoReplyVisualText ([string]$item.compact)))
    $itemPartCount = if ($item.PSObject.Properties["partCount"] -ne $null) { [int]$item.partCount } else { 1 }
    $partCount += [Math]::Max(1, $itemPartCount)
  }
  return [pscustomobject]@{
    compact = [string]::Join("", $texts.ToArray())
    bounds = @{
      left = $left
      top = $top
      width = [Math]::Max(1.0, $right - $left)
      height = [Math]::Max(1.0, $bottom - $top)
    }
    partCount = $partCount
  }
}

function Get-AutoReplyVisualMessageRows($messageLines) {
  $rows = New-Object System.Collections.Generic.List[object]
  $current = New-Object System.Collections.Generic.List[object]
  foreach ($line in @($messageLines | Sort-Object { [double]$_.bounds.top }, { [double]$_.bounds.left })) {
    if ($current.Count -eq 0) { [void]$current.Add($line); continue }
    $row = Merge-AutoReplyVisualMessageParts $current.ToArray() $true
    $rowCenter = [double]$row.bounds.top + ([double]$row.bounds.height * 0.5)
    $lineCenter = [double]$line.bounds.top + ([double]$line.bounds.height * 0.5)
    $centerTolerance = [Math]::Max((Scale-AutoReplyVisualMetric 8.0), [Math]::Min([double]$row.bounds.height, [double]$line.bounds.height) * 0.45)
    $rowRight = [double]$row.bounds.left + [double]$row.bounds.width
    $lineRight = [double]$line.bounds.left + [double]$line.bounds.width
    $horizontalSeparation = [Math]::Max(0.0, [Math]::Max([double]$row.bounds.left, [double]$line.bounds.left) - [Math]::Min($rowRight, $lineRight))
    $sameRow = [Math]::Abs($lineCenter - $rowCenter) -le $centerTolerance -and
      $horizontalSeparation -le (Scale-AutoReplyVisualMetric 40.0)
    if ($sameRow) {
      [void]$current.Add($line)
      continue
    }
    [void]$rows.Add($row)
    $current.Clear()
    [void]$current.Add($line)
  }
  if ($current.Count -gt 0) { [void]$rows.Add((Merge-AutoReplyVisualMessageParts $current.ToArray() $true)) }
  return @($rows.ToArray())
}

function Test-AutoReplyVisualMessageRowsSameBubble($frame, $block, $row, [double]$sidebarRight) {
  $blockBottom = [double]$block.bounds.top + [double]$block.bounds.height
  $verticalGap = [double]$row.bounds.top - $blockBottom
  if ($verticalGap -lt -(Scale-AutoReplyVisualMetric 2.0) -or
      $verticalGap -gt (Scale-AutoReplyVisualMetric 10.0)) { return $false }
  $blockLeft = [double]$block.bounds.left
  $blockRight = $blockLeft + [double]$block.bounds.width
  $rowLeft = [double]$row.bounds.left
  $rowRight = $rowLeft + [double]$row.bounds.width
  $overlap = [Math]::Max(0.0, [Math]::Min($blockRight, $rowRight) - [Math]::Max($blockLeft, $rowLeft))
  $minimumWidth = [Math]::Max(1.0, [Math]::Min([double]$block.bounds.width, [double]$row.bounds.width))
  $aligned = $overlap -ge ($minimumWidth * 0.20) -or
    [Math]::Abs($blockLeft - $rowLeft) -le (Scale-AutoReplyVisualMetric 24.0) -or
    [Math]::Abs($blockRight - $rowRight) -le (Scale-AutoReplyVisualMetric 24.0)
  if (-not $aligned) { return $false }
  $blockRole = Get-AutoReplyVisualMessageRole $frame $block $sidebarRight (Get-AutoReplyVisualBubbleRect $frame $block $sidebarRight)
  $rowRole = Get-AutoReplyVisualMessageRole $frame $row $sidebarRight (Get-AutoReplyVisualBubbleRect $frame $row $sidebarRight)
  return $blockRole -ceq "unknown" -or $rowRole -ceq "unknown" -or $blockRole -ceq $rowRole
}

function Get-AutoReplyVisualMessageBlocks($frame, $messageLines, [double]$sidebarRight) {
  $blocks = New-Object System.Collections.Generic.List[object]
  $currentRows = New-Object System.Collections.Generic.List[object]
  foreach ($row in @(Get-AutoReplyVisualMessageRows $messageLines)) {
    if ($currentRows.Count -eq 0) { [void]$currentRows.Add($row); continue }
    $block = Merge-AutoReplyVisualMessageParts $currentRows.ToArray()
    if (Test-AutoReplyVisualMessageRowsSameBubble $frame $block $row $sidebarRight) {
      [void]$currentRows.Add($row)
      continue
    }
    [void]$blocks.Add($block)
    $currentRows.Clear()
    [void]$currentRows.Add($row)
  }
  if ($currentRows.Count -gt 0) { [void]$blocks.Add((Merge-AutoReplyVisualMessageParts $currentRows.ToArray())) }
  return @($blocks.ToArray())
}

function Get-AutoReplyVisualLatestMessageEvidence($frame, $lines, [double]$sidebarRight) {
  $chatBoundary = Get-AutoReplyVisualChatBottom $frame $sidebarRight
  if (-not $chatBoundary.ok) {
    return @{ ok = $false; reason = "chat_boundary_unresolved"; boundarySource = [string]$chatBoundary.source }
  }
  $chatBottom = [double]$chatBoundary.bottom
  $messageLines = @($lines | Where-Object {
    [double]$_.bounds.left -ge ($sidebarRight + (Scale-AutoReplyVisualMetric 14.0)) -and
      [double]$_.bounds.top -ge (Scale-AutoReplyVisualMetric 108.0) -and
      [double]$_.bounds.top -le $chatBottom -and
      (Test-AutoReplyVisualPureText ([string]$_.compact))
  } | Sort-Object { [double]$_.bounds.top }, { [double]$_.bounds.left })
  $messageBlocks = @(Get-AutoReplyVisualMessageBlocks $frame $messageLines $sidebarRight)
  if ($messageBlocks.Count -eq 0) {
    return @{
      ok = $true
      hasMessage = $false
      evidenceSignature = Get-AutoReplyVisualSha256 "empty"
    }
  }
  $latest = $messageBlocks[-1]
  $message = Normalize-AutoReplyVisualText ([string]$latest.compact)
  $bubbleRect = Get-AutoReplyVisualBubbleRect $frame $latest $sidebarRight
  $pixelHash = Get-MomentsPixelHash $frame $bubbleRect
  if (-not $pixelHash) { return @{ ok = $false; reason = "latest_text_message_missing" } }
  $latestRole = Get-AutoReplyVisualMessageRole $frame $latest $sidebarRight $bubbleRect
  $logicalScale = [Math]::Max(0.5, [double]$script:AutoReplyVisualScale)
  $bubbleWidthBucket = [int][Math]::Round(([double]$latest.bounds.width / $logicalScale) / 8.0)
  $bubbleHeightBucket = [int][Math]::Round(([double]$latest.bounds.height / $logicalScale) / 4.0)
  $evidenceSeed = [string]::Join([char]10, @(
    $message,
    $latestRole,
    ("w:{0}" -f $bubbleWidthBucket),
    ("h:{0}" -f $bubbleHeightBucket)
  ))
  return @{
    ok = $true
    hasMessage = $true
    message = $message
    line = $latest
    pixelHash = $pixelHash
    latestRole = $latestRole
    evidenceSignature = Get-AutoReplyVisualSha256 $evidenceSeed
  }
}

function Get-AutoReplyVisualLatestIncoming($frame, $lines, [string]$expectedMessage, [double]$sidebarRight) {
  $latest = Get-AutoReplyVisualLatestMessageEvidence $frame $lines $sidebarRight
  if (-not $latest.ok) { return @{ ok = $false; reason = [string]$latest.reason } }
  if (-not $latest.hasMessage) { return @{ ok = $false; reason = "latest_text_message_missing" } }
  if ([string]$latest.latestRole -ceq "assistant") {
    return @{
      ok = $false
      reason = "latest_message_not_incoming"
      message = [string]$latest.message
      line = $latest.line
      pixelHash = [string]$latest.pixelHash
      evidenceSignature = [string]$latest.evidenceSignature
      latestRole = [string]$latest.latestRole
    }
  }
  if ([string]$latest.latestRole -cne "user") {
    return @{
      ok = $false
      reason = "latest_message_role_unresolved"
      message = [string]$latest.message
      line = $latest.line
      pixelHash = [string]$latest.pixelHash
      evidenceSignature = [string]$latest.evidenceSignature
      latestRole = [string]$latest.latestRole
    }
  }
  if ([string]$latest.message -cne (Normalize-AutoReplyVisualText $expectedMessage)) {
    return @{
      ok = $false
      reason = "unread_preview_mismatch"
      hasMessage = $true
      message = [string]$latest.message
      line = $latest.line
      pixelHash = [string]$latest.pixelHash
      evidenceSignature = [string]$latest.evidenceSignature
      latestRole = [string]$latest.latestRole
    }
  }
  return $latest
}

function Test-AutoReplyVisualStableIncomingEvidence($first, $second) {
  if ($first -eq $null -or $second -eq $null -or
      -not $first.hasMessage -or -not $second.hasMessage -or
      [string]$first.latestRole -cne "user" -or [string]$second.latestRole -cne "user") { return $false }
  $firstSignature = [string]$first.evidenceSignature
  $secondSignature = [string]$second.evidenceSignature
  return $firstSignature -match "^[a-f0-9]{64}$" -and $firstSignature -ceq $secondSignature
}

function Test-AutoReplyVisualBoundIncomingEvidence(
  [string]$observedRuntimeId,
  [string]$observedMessageSignature,
  [string]$boundRuntimeId,
  [string]$boundMessageSignature,
  [int]$matchingSidebarRows
) {
  if ($boundRuntimeId -notmatch "^visual:v1:[a-f0-9]{64}$" -or
      $boundMessageSignature -notmatch "^[a-f0-9]{64}$") { return $false }
  if ($observedRuntimeId -ceq $boundRuntimeId -and
      $observedMessageSignature -ceq $boundMessageSignature) { return $true }
  return $matchingSidebarRows -eq 1
}

function Test-AutoReplyVisualCurrentMessageTransition(
  [string]$previousPreviewSignature,
  [string]$currentPreviewSignature,
  [string]$previousMessageSignature,
  [string]$currentMessageSignature
) {
  foreach ($signature in @($previousPreviewSignature, $currentPreviewSignature, $previousMessageSignature, $currentMessageSignature)) {
    if ($signature -notmatch "^[a-f0-9]{64}$") { return $false }
  }
  return $previousPreviewSignature -cne $currentPreviewSignature -and
    $previousMessageSignature -cne $currentMessageSignature
}

function Test-AutoReplyVisualSignature([string]$value) {
  return $value -match "^[a-f0-9]{64}$"
}

function Resolve-AutoReplyVisualCurrentTransition(
  [string]$previousPreviewSignature,
  [string]$previousMessageSignature,
  $first,
  $second
) {
  if (-not (Test-AutoReplyVisualSignature $previousPreviewSignature) -or
      -not (Test-AutoReplyVisualSignature $previousMessageSignature) -or
      $first -eq $null -or -not $first.ok) {
    return @{ action = "unresolved"; reason = "current_transition_unresolved"; detail = "first_frame_invalid" }
  }
  $firstPreviewSignature = [string]$first.previewSignature
  $firstMessageSignature = [string]$first.messageSignature
  if (-not (Test-AutoReplyVisualSignature $firstPreviewSignature) -or
      -not (Test-AutoReplyVisualSignature $firstMessageSignature)) {
    return @{ action = "unresolved"; reason = "current_transition_unresolved"; detail = "first_frame_identity_invalid" }
  }
  $previewChanged = $previousPreviewSignature -cne $firstPreviewSignature
  $messageChanged = $previousMessageSignature -cne $firstMessageSignature
  if (-not $previewChanged -and -not $messageChanged) { return @{ action = "none" } }
  if ($second -eq $null -or -not $second.ok) {
    return @{ action = "unresolved"; reason = "current_transition_unresolved"; detail = "second_frame_invalid" }
  }
  $secondPreviewSignature = [string]$second.previewSignature
  $secondMessageSignature = [string]$second.messageSignature
  if (-not (Test-AutoReplyVisualSignature $secondPreviewSignature) -or
      -not (Test-AutoReplyVisualSignature $secondMessageSignature) -or
      [string]$first.conversation -cne [string]$second.conversation) {
    return @{ action = "unresolved"; reason = "current_transition_unresolved"; detail = "second_frame_unstable" }
  }
  if ($firstPreviewSignature -cne $secondPreviewSignature -or
      $firstMessageSignature -cne $secondMessageSignature) {
    # Immediately after a verified send, WeChat can reflow the green outgoing
    # bubble for more than one capture interval. Two independent assistant-role
    # frames prove this is not customer input, so wait for the visual boundary
    # to settle instead of pausing the listener. Never advance an unstable hash.
    if ($first.hasMessage -and $second.hasMessage -and
        -not [bool]$first.draft -and -not [bool]$second.draft -and
        [string]$first.latestRole -ceq "assistant" -and
        [string]$second.latestRole -ceq "assistant") {
      return @{
        action = "settle"
        reason = "current_outgoing_settling"
        conversation = [string]$second.conversation
        latestRole = "assistant"
      }
    }
    return @{ action = "unresolved"; reason = "current_transition_unresolved"; detail = "second_frame_unstable" }
  }

  # A stable one-channel change is visual settling, not an incoming turn. Move
  # only that channel's boundary so a later change in the other channel cannot
  # combine with it into a synthetic two-channel event.
  if ($previewChanged -xor $messageChanged) {
    $resolved = @{
      action = "consume"
      reason = "current_visual_drift_consumed"
      conversation = [string]$second.conversation
      latestRole = [string]$second.latestRole
      messageSignature = $secondMessageSignature
    }
    if ($previewChanged) {
      $resolved["baselineAdvance"] = @{ conversation = [string]$second.conversation; signature = $secondPreviewSignature }
    } else {
      $resolved["messageBaselineAdvance"] = @{ conversation = [string]$second.conversation; signature = $secondMessageSignature }
    }
    return $resolved
  }

  # A real current-open incoming transition must be present, non-draft and
  # identical in two independent frames before it can become a candidate.
  if (-not $first.hasMessage -or -not $second.hasMessage -or
      [bool]$first.draft -or [bool]$second.draft -or
      [string]$first.latestRole -cne [string]$second.latestRole) {
    return @{ action = "unresolved"; reason = "current_transition_unresolved"; detail = "two_channel_evidence_invalid" }
  }
  if ([string]$second.latestRole -ceq "user") {
    return @{ action = "candidate"; conversation = [string]$second.conversation }
  }
  if ([string]$second.latestRole -ceq "assistant") {
    return @{
      action = "boundary"
      reason = "latest_message_not_incoming"
      conversation = [string]$second.conversation
      latestRole = "assistant"
      messageSignature = $secondMessageSignature
      baselineAdvance = @{ conversation = [string]$second.conversation; signature = $secondPreviewSignature }
      messageBaselineAdvance = @{ conversation = [string]$second.conversation; signature = $secondMessageSignature }
    }
  }
  return @{ action = "unresolved"; reason = "current_transition_unresolved"; detail = "latest_role_unresolved" }
}

function Get-AutoReplyVisualObservation([IntPtr]$hWnd, [int]$expectedProcessId, $windowRect) {
  $frame = Get-AutoReplyVisualFrame $hWnd $windowRect $expectedProcessId
  if (-not $frame.ok) { return @{ ok = $false; reason = [string]$frame.reason } }
  try {
    $ocr = Get-MomentsOcrObservation $frame @{ left = 0.0; top = 0.0; width = [double]$frame.width; height = [double]$frame.height }
    if (-not $ocr.ok) {
      Close-MomentsVisualFrame $frame
      return @{ ok = $false; reason = [string]$ocr.reason }
    }
    return @{ ok = $true; frame = $frame; lines = @(Get-AutoReplyVisualLines $ocr) }
  } catch {
    Close-MomentsVisualFrame $frame
    return @{ ok = $false; reason = "visual_ocr_failed" }
  }
}

function Get-AutoReplyVisualCurrentTransitionSnapshot(
  [IntPtr]$hWnd,
  [int]$expectedProcessId,
  $windowRect,
  $allowedSet,
  [double]$sidebarRight,
  [string]$expectedConversation
) {
  $observation = Get-AutoReplyVisualObservation $hWnd $expectedProcessId $windowRect
  if (-not $observation.ok) { return @{ ok = $false; reason = [string]$observation.reason } }
  $frame = $observation.frame
  try {
    $sidebar = Get-AutoReplyVisualSidebarRows $frame $observation.lines $allowedSet $sidebarRight
    if (-not $sidebar.ok) { return @{ ok = $false; reason = [string]$sidebar.reason } }
    $currentConversation = Get-AutoReplyVisualCurrentConversation $observation.lines $allowedSet $sidebarRight ([double]$frame.width)
    if (-not $currentConversation.ok -or -not $currentConversation.active -or
        [string]$currentConversation.conversation -cne $expectedConversation) {
      return @{ ok = $false; reason = "current_conversation_changed" }
    }
    $matchingRows = @($sidebar.rows | Where-Object { [string]$_.conversation -ceq $expectedConversation })
    if ($matchingRows.Count -ne 1) { return @{ ok = $false; reason = "current_sidebar_row_unresolved" } }
    $latest = Get-AutoReplyVisualLatestMessageEvidence $frame $observation.lines $sidebarRight
    if (-not $latest.ok) { return @{ ok = $false; reason = [string]$latest.reason } }
    return @{
      ok = $true
      conversation = $expectedConversation
      previewSignature = [string]$matchingRows[0].signature
      draft = [bool]$matchingRows[0].draft
      hasMessage = [bool]$latest.hasMessage
      message = [string]$latest.message
      latestRole = [string]$latest.latestRole
      messageSignature = [string]$latest.evidenceSignature
    }
  } finally {
    Close-MomentsVisualFrame $frame
  }
}

$mode = [Environment]::GetEnvironmentVariable("XIAOXI_AUTO_REPLY_MODE")
try { $allowed = @(([Environment]::GetEnvironmentVariable("XIAOXI_ALLOWED_NAMES") | ConvertFrom-Json)) } catch { Write-AutoReplyVisualResult @{ ok = $false; reason = "whitelist_invalid" } }
$allowedSet = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($name in $allowed) {
  $normalizedName = Normalize-AutoReplyVisualText ([string]$name)
  if ($normalizedName) { [void]$allowedSet.Add($normalizedName) }
}
if ($allowedSet.Count -eq 0) { Write-AutoReplyVisualResult @{ ok = $false; reason = "whitelist_empty" } }
$script:AutoReplyVisualExcludedNames = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
try { $excludedNames = @(([Environment]::GetEnvironmentVariable("XIAOXI_EXCLUDED_NAMES") | ConvertFrom-Json)) } catch { $excludedNames = @() }
foreach ($name in $excludedNames) {
  [void]$script:AutoReplyVisualExcludedNames.Add((Normalize-AutoReplyVisualText $name))
}
try { $baselines = [Environment]::GetEnvironmentVariable("XIAOXI_VISUAL_BASELINES") | ConvertFrom-Json } catch { $baselines = $null }
try { $messageBaselines = [Environment]::GetEnvironmentVariable("XIAOXI_VISUAL_MESSAGE_BASELINES") | ConvertFrom-Json } catch { $messageBaselines = $null }
$expectedConversation = Normalize-AutoReplyVisualText ([Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_CONVERSATION"))
$expectedMessage = Normalize-AutoReplyVisualText ([Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_MESSAGE"))
$expectedRuntimeId = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_RUNTIME_ID")
$expectedPreviewSignature = ([string][Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PREVIEW_SIGNATURE")).Trim().ToLowerInvariant()
$expectedMessageSignature = ([string][Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_MESSAGE_SIGNATURE")).Trim().ToLowerInvariant()
try { $expectedPid = [int][Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID") } catch { $expectedPid = 0 }
try { $expectedHWnd = [int64][Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_HWND") } catch { $expectedHWnd = 0 }

$processes = @(Get-Process -Name Weixin, WeChat -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ceq "微信" })
if ($processes.Count -eq 0) { Write-AutoReplyVisualResult @{ ok = $false; reason = "wechat_window_missing" } }
if ($processes.Count -ne 1) { Write-AutoReplyVisualResult @{ ok = $false; reason = "wechat_window_ambiguous" } }
$process = $processes[0]
$hWnd = [IntPtr]$process.MainWindowHandle
if ($expectedPid -gt 0 -and $expectedPid -ne [int]$process.Id) { Write-AutoReplyVisualResult @{ ok = $false; reason = "wechat_process_changed"; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
if ($expectedHWnd -gt 0 -and $expectedHWnd -ne [int64]$hWnd) { Write-AutoReplyVisualResult @{ ok = $false; reason = "wechat_window_changed"; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd)
if ($root -eq $null) { Write-AutoReplyVisualResult @{ ok = $false; reason = "automation_root_missing" } }
try { $windowRect = $root.Current.BoundingRectangle } catch { Write-AutoReplyVisualResult @{ ok = $false; reason = "wechat_window_not_ready" } }
if ($windowRect.Width -lt 600 -or $windowRect.Height -lt 500) { Write-AutoReplyVisualResult @{ ok = $false; reason = "wechat_window_not_ready" } }

$windowDpi = [double]96
try {
  $reportedDpi = [Win32WechatAutoReplyVisual]::GetDpiForWindow($hWnd)
  if ($reportedDpi -ge 72 -and $reportedDpi -le 480) { $windowDpi = [double]$reportedDpi }
} catch {}
$script:AutoReplyVisualScale = [Math]::Min(4.0, [Math]::Max(0.5, $windowDpi / 120.0))
$sidebarRight = Get-AutoReplyVisualSidebarRight ([double]$windowRect.Width) $windowDpi
$observation = Get-AutoReplyVisualObservation $hWnd ([int]$process.Id) $windowRect
if (-not $observation.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$observation.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
$frame = $observation.frame
try {
  $sidebar = Get-AutoReplyVisualSidebarRows $frame $observation.lines $allowedSet $sidebarRight
  if (-not $sidebar.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$sidebar.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
  $rows = @($sidebar.rows)
  foreach ($row in $rows) {
    if ([bool]$row.discoveredConversation) { [void]$allowedSet.Add([string]$row.conversation) }
  }
  $currentConversationDiscovered = $false
  $currentConversation = Get-AutoReplyVisualCurrentConversation $observation.lines $allowedSet $sidebarRight ([double]$frame.width)
  if (-not $currentConversation.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$currentConversation.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
  if (-not $currentConversation.active) {
    $anyHeader = Get-AutoReplyVisualAnyHeader $observation.lines $sidebarRight ([double]$frame.width)
    if ($anyHeader.ok -and $anyHeader.conversation) {
      [void]$allowedSet.Add([string]$anyHeader.conversation)
      $expandedSidebar = Get-AutoReplyVisualSidebarRows $frame $observation.lines $allowedSet $sidebarRight
      if ($expandedSidebar.ok) {
        $rows = @($expandedSidebar.rows)
        $currentConversation = Get-AutoReplyVisualCurrentConversation $observation.lines $allowedSet $sidebarRight ([double]$frame.width)
        $currentConversationDiscovered = $currentConversation.ok -and $currentConversation.active
      }
    }
  }
  $sessionBaselines = @($rows | ForEach-Object { @{ conversation = [string]$_.conversation; signature = [string]$_.signature } })
  $currentMessage = $null
  $sessionMessageBaselines = @()
  if ($currentConversation.active) {
    $currentMessage = Get-AutoReplyVisualLatestMessageEvidence $frame $observation.lines $sidebarRight
    if (-not $currentMessage.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$currentMessage.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
    $sessionMessageBaselines = @(@{
      conversation = [string]$currentConversation.conversation
      signature = [string]$currentMessage.evidenceSignature
    })
  }
  $currentResultConversation = if ($currentConversation.active) { [string]$currentConversation.conversation } else { "" }
  $currentResultLatestRole = if ($currentMessage -ne $null -and $currentMessage.hasMessage) { [string]$currentMessage.latestRole } else { "" }
  $currentResultMessageSignature = if ($currentMessage -ne $null) { [string]$currentMessage.evidenceSignature } else { "" }
  if ($mode -eq "prime") {
    Write-AutoReplyVisualResult @{
      ok = $true
      source = "session_prime"
      pid = [int]$process.Id
      hWnd = [int64]$hWnd
      conversation = $currentResultConversation
      latestRole = $currentResultLatestRole
      messageSignature = $currentResultMessageSignature
      discoveredConversation = [bool]$currentConversationDiscovered
      sessionBaselines = $sessionBaselines
      sessionMessageBaselines = $sessionMessageBaselines
    }
  }

  if ($mode -eq "recover") {
    if (-not $expectedConversation -or
        $expectedPreviewSignature -notmatch "^[a-f0-9]{64}$" -or
        $expectedMessageSignature -notmatch "^[a-f0-9]{64}$") {
      Write-AutoReplyVisualResult @{ ok = $false; reason = "incoming_identity_missing" }
    }
    if (-not $currentConversation.active -or [string]$currentConversation.conversation -cne $expectedConversation) {
      Write-AutoReplyVisualResult @{ ok = $false; reason = "conversation_title_mismatch"; pid = [int]$process.Id; hWnd = [int64]$hWnd }
    }
    $expectedRows = @($rows | Where-Object { [string]$_.conversation -ceq $expectedConversation -and [string]$_.signature -ceq $expectedPreviewSignature })
    if ($expectedRows.Count -ne 1) {
      Write-AutoReplyVisualResult @{ ok = $false; reason = "incoming_message_changed"; pid = [int]$process.Id; hWnd = [int64]$hWnd }
    }
    $header = Get-AutoReplyVisualHeader $observation.lines $expectedConversation $sidebarRight ([double]$frame.width)
    if (-not $header.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$header.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
    if ($currentMessage -eq $null -or -not $currentMessage.hasMessage) {
      Write-AutoReplyVisualResult @{ ok = $false; reason = "latest_text_message_missing"; pid = [int]$process.Id; hWnd = [int64]$hWnd }
    }
    if ([string]$currentMessage.latestRole -cne "user") {
      $roleReason = if ([string]$currentMessage.latestRole -ceq "assistant") { "latest_message_not_incoming" } else { "latest_message_role_unresolved" }
      Write-AutoReplyVisualResult @{ ok = $false; reason = $roleReason; pid = [int]$process.Id; hWnd = [int64]$hWnd; latestRole = [string]$currentMessage.latestRole }
    }
    if ([string]$currentMessage.evidenceSignature -cne $expectedMessageSignature) {
      Write-AutoReplyVisualResult @{ ok = $false; reason = "incoming_message_changed"; pid = [int]$process.Id; hWnd = [int64]$hWnd }
    }
    $recoveredMessage = [string]$currentMessage.message
    $runtimeSeed = [string]::Join([char]10, @($expectedConversation, $expectedMessageSignature))
    $runtimeId = "visual:v1:" + (Get-AutoReplyVisualSha256 $runtimeSeed)
    Write-AutoReplyVisualResult @{
      ok = $true
      conversation = $expectedConversation
      message = $recoveredMessage
      runtimeId = $runtimeId
      previewSignature = $expectedPreviewSignature
      messageSignature = $expectedMessageSignature
      pid = [int]$process.Id
      hWnd = [int64]$hWnd
      source = "pending_recovery"
      latestRole = "user"
      context = @(@{ role = "user"; content = $recoveredMessage; key = $runtimeId })
    }
  }

  if ($mode -eq "verify") {
    if (-not $expectedConversation -or -not $expectedMessage -or -not $expectedRuntimeId -or
        $expectedMessageSignature -notmatch "^[a-f0-9]{64}$") { Write-AutoReplyVisualResult @{ ok = $false; reason = "incoming_message_missing" } }
    $expectedRows = @($rows | Where-Object { [string]$_.conversation -ceq $expectedConversation -and [string]$_.preview -ceq $expectedMessage })
    $currentConversationMatches = $currentConversation.active -and [string]$currentConversation.conversation -ceq $expectedConversation
    if ($expectedRows.Count -ne 1 -and -not $currentConversationMatches) { Write-AutoReplyVisualResult @{ ok = $false; reason = "incoming_message_changed"; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
    $header = Get-AutoReplyVisualHeader $observation.lines $expectedConversation $sidebarRight ([double]$frame.width)
    if (-not $header.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$header.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
    # The sidebar and chat bubble use different font sizes. The same Chinese text
    # can therefore have deterministic OCR drift (for example “你好” vs “亻子”).
    # Verify the exact bubble evidence captured during scan instead of comparing
    # text recognized from two different visual regions.
    $latest = Get-AutoReplyVisualLatestMessageEvidence $frame $observation.lines $sidebarRight
    if (-not $latest.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$latest.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
    if (-not $latest.hasMessage) { Write-AutoReplyVisualResult @{ ok = $false; reason = "latest_text_message_missing"; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
    if ([string]$latest.latestRole -ceq "assistant") { Write-AutoReplyVisualResult @{ ok = $false; reason = "latest_message_not_incoming"; pid = [int]$process.Id; hWnd = [int64]$hWnd; latestRole = "assistant" } }
    if ([string]$latest.latestRole -cne "user") { Write-AutoReplyVisualResult @{ ok = $false; reason = "latest_message_role_unresolved"; pid = [int]$process.Id; hWnd = [int64]$hWnd; latestRole = [string]$latest.latestRole } }
    $observedMessageSignature = [string]$latest.evidenceSignature
    $runtimeSeed = [string]::Join([char]10, @($expectedConversation, $observedMessageSignature))
    $observedRuntimeId = "visual:v1:" + (Get-AutoReplyVisualSha256 $runtimeSeed)
    $bubbleEvidenceMatches = $observedRuntimeId -ceq $expectedRuntimeId -and $observedMessageSignature -ceq $expectedMessageSignature
    # OCR of the large chat bubble can drift between otherwise identical frames.
    # When that happens, bind the turn through the independently recognized
    # selected sidebar preview, while still requiring the exact header and a
    # latest customer-role bubble. A changed preview cannot use this fallback.
    if (-not (Test-AutoReplyVisualBoundIncomingEvidence $observedRuntimeId $observedMessageSignature $expectedRuntimeId $expectedMessageSignature $expectedRows.Count)) {
      Write-AutoReplyVisualResult @{ ok = $false; reason = "incoming_message_changed"; pid = [int]$process.Id; hWnd = [int64]$hWnd }
    }
    Write-AutoReplyVisualResult @{
      ok = $true
      conversation = $expectedConversation
      message = $expectedMessage
      runtimeId = $expectedRuntimeId
      messageSignature = $expectedMessageSignature
      observedMessageSignature = $observedMessageSignature
      evidenceReconciled = -not $bubbleEvidenceMatches
      pid = [int]$process.Id
      hWnd = [int64]$hWnd
      source = "verify"
      latestRole = "user"
      context = @(@{ role = "user"; content = $expectedMessage; key = $runtimeId })
    }
  }

  $candidates = New-Object System.Collections.Generic.List[object]
  foreach ($row in $rows) {
    # OCR-only preview changes are not an event signal: small recognition jitter
    # previously caused a click on every scan. Background sessions require a
    # geometric unread badge; the already-open session uses message-area evidence.
    if ($row.unread -and -not $row.draft) {
      $row | Add-Member -NotePropertyName source -NotePropertyValue "unread" -Force
      [void]$candidates.Add($row)
    }
  }
  if ($candidates.Count -eq 0) {
    $badgeFallbacks = @(Get-AutoReplyVisualUnreadBadges $frame $sidebarRight)
    if ($badgeFallbacks.Count -gt 0) {
      $badge = $badgeFallbacks[0]
      $badgeSeed = [string]::Join(":", @([int][Math]::Round([double]$badge.centerX), [int][Math]::Round([double]$badge.centerY)))
      [void]$candidates.Add([pscustomobject]@{
        conversation = ""
        preview = ""
        signature = Get-AutoReplyVisualSha256 ("unread-badge:" + $badgeSeed)
        unread = $true
        draft = $false
        discoveredConversation = $true
        badgeOnly = $true
        badgeBounds = $badge
        nameBounds = @{
          left = [double]$sidebarRight * 0.55
          top = [double]$badge.centerY + (Scale-AutoReplyVisualMetric 6.0)
          width = Scale-AutoReplyVisualMetric 50.0
          height = Scale-AutoReplyVisualMetric 2.0
        }
      })
    }
  }
  if ($candidates.Count -eq 0) {
    if ($currentConversation.active -and $currentMessage -ne $null) {
      $currentName = [string]$currentConversation.conversation
      $currentRow = @($rows | Where-Object { [string]$_.conversation -ceq $currentName })
      $previousPreviewSignature = Get-AutoReplyVisualBaseline $baselines $currentName
      $previousMessageSignature = Get-AutoReplyVisualBaseline $messageBaselines $currentName
      $previousBoundariesValid = (Test-AutoReplyVisualSignature $previousPreviewSignature) -and
        (Test-AutoReplyVisualSignature $previousMessageSignature)
      if ($previousBoundariesValid -and $currentRow.Count -ne 1) {
        Write-AutoReplyVisualResult @{
          ok = $false
          reason = "current_transition_unresolved"
          transitionDetail = "current_sidebar_row_unresolved"
          pid = [int]$process.Id
          hWnd = [int64]$hWnd
          conversation = $currentName
        }
      }
      if ($currentRow.Count -eq 1) {
        # Keep the actual draft-row signature as visual state. Draft status
        # blocks a candidate, but discarding its signature would let clearing a
        # draft be combined with a later, unrelated bubble OCR change.
        $currentPreviewSignature = [string]$currentRow[0].signature
        $currentMessageSignature = [string]$currentMessage.evidenceSignature
        if ($previousBoundariesValid -and
            (-not (Test-AutoReplyVisualSignature $currentPreviewSignature) -or
             -not (Test-AutoReplyVisualSignature $currentMessageSignature))) {
          Write-AutoReplyVisualResult @{
            ok = $false
            reason = "current_transition_unresolved"
            transitionDetail = "current_identity_invalid"
            pid = [int]$process.Id
            hWnd = [int64]$hWnd
            conversation = $currentName
          }
        }
        if ($previousBoundariesValid) {
          $previewChanged = $previousPreviewSignature -cne $currentPreviewSignature
          $messageChanged = $previousMessageSignature -cne $currentMessageSignature
          $currentMessageTransition = Test-AutoReplyVisualCurrentMessageTransition $previousPreviewSignature $currentPreviewSignature $previousMessageSignature $currentMessageSignature
          if ($previewChanged -or $messageChanged) {
            $firstCurrentSnapshot = @{
              ok = $true
              conversation = $currentName
              previewSignature = $currentPreviewSignature
              draft = [bool]$currentRow[0].draft
              hasMessage = [bool]$currentMessage.hasMessage
              message = [string]$currentMessage.message
              latestRole = [string]$currentMessage.latestRole
              messageSignature = $currentMessageSignature
            }
            Start-Sleep -Milliseconds 140
            $secondCurrentSnapshot = Get-AutoReplyVisualCurrentTransitionSnapshot $hWnd ([int]$process.Id) $windowRect $allowedSet $sidebarRight $currentName
            $resolvedTransition = Resolve-AutoReplyVisualCurrentTransition $previousPreviewSignature $previousMessageSignature $firstCurrentSnapshot $secondCurrentSnapshot
            if ([string]$resolvedTransition.action -eq "unresolved") {
              Write-AutoReplyVisualResult @{
                ok = $false
                reason = "current_transition_unresolved"
                transitionDetail = [string]$resolvedTransition.detail
                pid = [int]$process.Id
                hWnd = [int64]$hWnd
                conversation = $currentName
                pendingPreviewSignature = [string]$firstCurrentSnapshot.previewSignature
                pendingMessageSignature = [string]$firstCurrentSnapshot.messageSignature
                predecessorPreviewSignature = $previousPreviewSignature
                predecessorMessageSignature = $previousMessageSignature
              }
            }
            if ([string]$resolvedTransition.action -eq "consume" -or
                [string]$resolvedTransition.action -eq "boundary" -or
                [string]$resolvedTransition.action -eq "settle") {
              $transitionResult = @{
                ok = $false
                reason = [string]$resolvedTransition.reason
                pid = [int]$process.Id
                hWnd = [int64]$hWnd
                conversation = $currentName
                message = [string]$secondCurrentSnapshot.message
                latestRole = [string]$resolvedTransition.latestRole
                messageSignature = [string]$resolvedTransition.messageSignature
              }
              if ($resolvedTransition.baselineAdvance -ne $null) {
                $transitionResult["baselineAdvance"] = $resolvedTransition.baselineAdvance
              }
              if ($resolvedTransition.messageBaselineAdvance -ne $null) {
                $transitionResult["messageBaselineAdvance"] = $resolvedTransition.messageBaselineAdvance
              }
              Write-AutoReplyVisualResult $transitionResult
            }
            if ([string]$resolvedTransition.action -eq "candidate" -and $currentMessageTransition) {
              $confirmedPreviewSignature = [string]$secondCurrentSnapshot.previewSignature
              $confirmedMessageSignature = [string]$secondCurrentSnapshot.messageSignature
              $confirmedMessage = [string]$secondCurrentSnapshot.message
              $runtimeSeed = [string]::Join([char]10, @($currentName, $confirmedMessageSignature))
              $runtimeId = "visual:v1:" + (Get-AutoReplyVisualSha256 $runtimeSeed)
              Write-AutoReplyVisualResult @{
                ok = $true
                conversation = $currentName
                message = $confirmedMessage
                runtimeId = $runtimeId
                previewSignature = $confirmedPreviewSignature
                messageSignature = $confirmedMessageSignature
                pid = [int]$process.Id
                hWnd = [int64]$hWnd
                source = "current_message_change"
                latestRole = "user"
                context = @(@{ role = "user"; content = $confirmedMessage; key = $runtimeId })
              }
            }
          }
        }
      }
    }
    Write-AutoReplyVisualResult @{
      ok = $false
      reason = "no_unread_message"
      pid = [int]$process.Id
      hWnd = [int64]$hWnd
      conversation = $currentResultConversation
      latestRole = $currentResultLatestRole
      messageSignature = $currentResultMessageSignature
      sessionBaselines = $sessionBaselines
      sessionMessageBaselines = $sessionMessageBaselines
    }
  }
  $unreadCandidates = @($candidates.ToArray() | Where-Object { $_.unread })
  $candidate = if ($unreadCandidates.Count -gt 0) { $unreadCandidates[0] } else { $candidates[0] }
  $conversation = [string]$candidate.conversation; $preview = [string]$candidate.preview
  $source = if ([bool]$candidate.badgeOnly) { "unread_badge" } else { [string]$candidate.source }
} finally {
  Close-MomentsVisualFrame $frame
}

if (-not (Open-AutoReplyVisualConversation $candidate $hWnd ([int]$process.Id) $windowRect)) {
  Write-AutoReplyVisualResult @{ ok = $false; reason = "conversation_open_failed"; pid = [int]$process.Id; hWnd = [int64]$hWnd }
}
$openedObservation = Get-AutoReplyVisualObservation $hWnd ([int]$process.Id) $windowRect
if (-not $openedObservation.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$openedObservation.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
$openedFrame = $openedObservation.frame
try {
  if ([bool]$candidate.badgeOnly) {
    if (Test-AutoReplyVisualBadgeRemains $openedFrame $candidate.badgeBounds) {
      Write-AutoReplyVisualResult @{ ok = $false; reason = "no_unread_message"; pid = [int]$process.Id; hWnd = [int64]$hWnd }
    }
    $header = Get-AutoReplyVisualAnyHeader $openedObservation.lines $sidebarRight ([double]$openedFrame.width)
    if ($header.ok) { $conversation = [string]$header.conversation }
  } else {
    $header = Get-AutoReplyVisualHeader $openedObservation.lines $conversation $sidebarRight ([double]$openedFrame.width)
  }
  if (-not $header.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$header.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
  if ([bool]$candidate.badgeOnly) {
    $badgeLatest = Get-AutoReplyVisualLatestMessageEvidence $openedFrame $openedObservation.lines $sidebarRight
    if (-not $badgeLatest.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$badgeLatest.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
    if (-not $badgeLatest.hasMessage) { Write-AutoReplyVisualResult @{ ok = $false; reason = "latest_text_message_missing"; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
    if ([string]$badgeLatest.latestRole -cne "user") {
      $badgeRoleReason = if ([string]$badgeLatest.latestRole -ceq "assistant") { "latest_message_not_incoming" } else { "latest_message_role_unresolved" }
      Write-AutoReplyVisualResult @{ ok = $false; reason = $badgeRoleReason; pid = [int]$process.Id; hWnd = [int64]$hWnd; conversation = $conversation; latestRole = [string]$badgeLatest.latestRole }
    }
    $preview = [string]$badgeLatest.message
    $candidate.signature = Get-AutoReplyVisualSha256 ([string]$badgeLatest.evidenceSignature)
  }
  $latest = Get-AutoReplyVisualLatestIncoming $openedFrame $openedObservation.lines $preview $sidebarRight
  $resolvedMessage = $preview
  if (-not $latest.ok) {
    if ([string]$latest.reason -ceq "latest_message_not_incoming") {
      Write-AutoReplyVisualResult @{
        ok = $false
        reason = "latest_message_not_incoming"
        pid = [int]$process.Id
        hWnd = [int64]$hWnd
        conversation = $conversation
        message = [string]$latest.message
        latestRole = [string]$latest.latestRole
        messageSignature = [string]$latest.evidenceSignature
        baselineAdvance = @{ conversation = $conversation; signature = [string]$candidate.signature }
        messageBaselineAdvance = @{ conversation = $conversation; signature = [string]$latest.evidenceSignature }
      }
    }
    if ([string]$latest.reason -cne "unread_preview_mismatch") {
      Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$latest.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd }
    }

    $pendingRuntimeSeed = [string]::Join([char]10, @($conversation, [string]$latest.evidenceSignature))
    $pendingRuntimeId = "visual:v1:" + (Get-AutoReplyVisualSha256 $pendingRuntimeSeed)

    # Opening the unread row consumes its red badge. Before accepting OCR drift,
    # prove that the exact allowed conversation is still open and that the same
    # incoming bubble is stable across a second independent capture.
    Start-Sleep -Milliseconds 140
    $confirmation = Get-AutoReplyVisualObservation $hWnd ([int]$process.Id) $windowRect
    if (-not $confirmation.ok) {
      Write-AutoReplyVisualResult @{
        ok = $false
        reason = "unread_preview_pending"
        pendingReason = [string]$confirmation.reason
        pid = [int]$process.Id
        hWnd = [int64]$hWnd
        conversation = $conversation
        message = $preview
        runtimeId = $pendingRuntimeId
        previewSignature = [string]$candidate.signature
        messageSignature = [string]$latest.evidenceSignature
        source = $source
        latestRole = "user"
        context = @(@{ role = "user"; content = $preview; key = $pendingRuntimeId })
      }
    }
    $confirmationFrame = $confirmation.frame
    try {
      $confirmationHeader = Get-AutoReplyVisualHeader $confirmation.lines $conversation $sidebarRight ([double]$confirmationFrame.width)
      if (-not $confirmationHeader.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$confirmationHeader.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
      $confirmedLatest = Get-AutoReplyVisualLatestMessageEvidence $confirmationFrame $confirmation.lines $sidebarRight
      if (-not $confirmedLatest.ok) {
        Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$confirmedLatest.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd }
      }
      if (-not (Test-AutoReplyVisualStableIncomingEvidence $latest $confirmedLatest)) {
        if ($confirmedLatest -ne $null -and $confirmedLatest.ok -and $confirmedLatest.hasMessage -and [string]$confirmedLatest.latestRole -ceq "assistant") {
          Write-AutoReplyVisualResult @{
            ok = $false
            reason = "latest_message_not_incoming"
            pid = [int]$process.Id
            hWnd = [int64]$hWnd
            conversation = $conversation
            message = [string]$confirmedLatest.message
            latestRole = "assistant"
            messageSignature = [string]$confirmedLatest.evidenceSignature
            baselineAdvance = @{ conversation = $conversation; signature = [string]$candidate.signature }
            messageBaselineAdvance = @{ conversation = $conversation; signature = [string]$confirmedLatest.evidenceSignature }
          }
        }
        Write-AutoReplyVisualResult @{
          ok = $false
          reason = "unread_preview_pending"
          pendingReason = if ($confirmedLatest -ne $null -and $confirmedLatest.ok -and $confirmedLatest.hasMessage -and [string]$confirmedLatest.latestRole -ceq "user") { "second_frame_evidence_changed" } else { "second_frame_incoming_unresolved" }
          pid = [int]$process.Id
          hWnd = [int64]$hWnd
          conversation = $conversation
          message = $preview
          runtimeId = $pendingRuntimeId
          previewSignature = [string]$candidate.signature
          messageSignature = [string]$latest.evidenceSignature
          source = $source
          latestRole = "user"
          context = @(@{ role = "user"; content = $preview; key = $pendingRuntimeId })
        }
      }
      $latest = $confirmedLatest
    } finally {
      Close-MomentsVisualFrame $confirmationFrame
    }
  } else {
    $resolvedMessage = [string]$latest.message
  }
  $runtimeSeed = [string]::Join([char]10, @($conversation, [string]$latest.evidenceSignature))
  $runtimeId = "visual:v1:" + (Get-AutoReplyVisualSha256 $runtimeSeed)
  Write-AutoReplyVisualResult @{
    ok = $true
    conversation = $conversation
    message = $resolvedMessage
    runtimeId = $runtimeId
    previewSignature = [string]$candidate.signature
    messageSignature = [string]$latest.evidenceSignature
    pid = [int]$process.Id
    hWnd = [int64]$hWnd
    source = $source
    discoveredConversation = [bool]$candidate.discoveredConversation
    latestRole = "user"
    context = @(@{ role = "user"; content = $resolvedMessage; key = $runtimeId })
  }
} finally {
  Close-MomentsVisualFrame $openedFrame
}
`;

function allowedNameIdentity(names) {
  const compactToOriginal = new Map();
  const collisions = new Set();
  for (const value of Array.isArray(names) ? names : []) {
    const original = String(value || "").normalize("NFKC").trim().replace(/\s+/gu, " ");
    const compact = original.replace(/\s+/gu, "");
    if (!compact) continue;
    const previous = compactToOriginal.get(compact);
    if (previous && previous !== original) collisions.add(compact);
    else compactToOriginal.set(compact, original);
  }
  for (const compact of collisions) compactToOriginal.delete(compact);
  return {
    compactNames: [...compactToOriginal.keys()],
    compactToOriginal,
    originalNames: [...compactToOriginal.values()],
    ambiguous: collisions.size > 0
  };
}

function compactContactName(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, "").trim();
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/u.test(String(value || "").trim().toLowerCase());
}

function candidateKey(candidate) {
  return [candidate?.conversation, candidate?.runtimeId, candidate?.message].map((value) => String(value || "")).join("\n");
}

function createWechatVisualAutoReplyDriver(powerShellRunner = runPowerShellAsync) {
  const pendingVerifyAttemptLimit = 3;
  const previewBaselines = new Map();
  const messageBaselines = new Map();
  const occurrenceStates = new Map();
  const retryCandidates = [];
  const discoveredConversationNames = new Set();
  let primedProcess = null;
  let pendingOpenedUnread = null;
  let restoredPendingObservation = null;

  function restorePendingObservation(value) {
    const conversation = compactContactName(value?.conversation);
    const pid = Math.floor(Number(value?.pid));
    const hWnd = String(value?.hWnd || "").trim();
    const previewSignature = String(value?.preview_signature || "").trim().toLowerCase();
    const messageSignature = String(value?.message_signature || "").trim().toLowerCase();
    if (!conversation || !Number.isSafeInteger(pid) || pid <= 0 || !/^[0-9]{1,20}$/u.test(hWnd)
      || !isSha256(previewSignature) || !isSha256(messageSignature)) return false;
    restoredPendingObservation = {
      conversation,
      pid,
      hWnd,
      previewSignature,
      messageSignature,
      predecessorPreviewSignature: String(value?.predecessor_preview_signature || "").trim().toLowerCase(),
      predecessorMessageSignature: String(value?.predecessor_message_signature || "").trim().toLowerCase()
    };
    previewBaselines.clear();
    messageBaselines.clear();
    occurrenceStates.clear();
    retryCandidates.length = 0;
    pendingOpenedUnread = null;
    if (isSha256(restoredPendingObservation.predecessorPreviewSignature)) {
      previewBaselines.set(conversation, restoredPendingObservation.predecessorPreviewSignature);
    }
    if (isSha256(restoredPendingObservation.predecessorMessageSignature)) {
      messageBaselines.set(conversation, restoredPendingObservation.predecessorMessageSignature);
    }
    primedProcess = { pid, hWnd };
    return true;
  }

  function decorateCandidate(result, identity, predecessorSignature) {
    const evidenceRuntimeId = String(result?.runtimeId || "").trim();
    const conversation = compactContactName(result?.conversation);
    const previewSignature = String(result?.previewSignature || "").trim().toLowerCase();
    const messageSignature = String(result?.messageSignature || "").trim().toLowerCase();
    const active = occurrenceStates.get(conversation);
    let runtimeId = active?.active === true
      && isSha256(previewSignature)
      && active.previewSignature === previewSignature
      ? active.runtimeId
      : "";
    if (!runtimeId) {
      runtimeId = `visual:v2:${createHash("sha256").update([
        "visual-occurrence-v2",
        conversation,
        evidenceRuntimeId,
        previewSignature,
        messageSignature,
        String(predecessorSignature || "")
      ].join("\n"), "utf8").digest("hex")}`;
      occurrenceStates.set(conversation, {
        active: true,
        previewSignature,
        evidenceRuntimeId,
        messageSignature,
        runtimeId
      });
    } else {
      // Keep one occurrence identity while the selected-row preview is the
      // same. Bubble OCR text/bounds may legitimately drift between frames;
      // the latest evidence is still retained for the next verification.
      occurrenceStates.set(conversation, {
        ...active,
        previewSignature,
        evidenceRuntimeId,
        messageSignature,
        runtimeId
      });
    }
    const context = rewriteLatestContextKey(result?.context, runtimeId);
    return {
      ...result,
      conversation: identity.compactToOriginal.get(String(result.conversation || "")) || String(result.conversation || ""),
      runtimeId,
      visualEvidenceRuntimeId: evidenceRuntimeId,
      visualMode: "visual_render_v1",
      context
    };
  }

  function observeMessageSignature(conversation, signature) {
    const current = occurrenceStates.get(conversation);
    if (current?.active === true && current.messageSignature !== signature) {
      occurrenceStates.set(conversation, { ...current, active: false, boundarySignature: signature });
    }
    messageBaselines.set(conversation, signature);
  }

  function rewriteLatestContextKey(context, runtimeId) {
    return Array.isArray(context)
      ? context.map((item, index, items) => index === items.length - 1 ? { ...item, key: runtimeId } : item)
      : context;
  }

  function processIdentity(result) {
    const pid = Math.floor(Number(result?.pid));
    const hWnd = String(result?.hWnd || "").trim();
    return Number.isSafeInteger(pid) && pid > 0 && /^[1-9][0-9]{0,19}$/u.test(hWnd) ? { pid, hWnd } : null;
  }

  function applyBaselines(result, allowed, { replace = false, missingOnly = false } = {}) {
    if (replace) previewBaselines.clear();
    const rows = Array.isArray(result?.sessionBaselines) ? result.sessionBaselines : [];
    for (const row of rows.slice(0, 1_000)) {
      const conversation = compactContactName(row?.conversation);
      const signature = String(row?.signature || "").trim().toLowerCase();
      if (!allowed.includes(conversation) || !isSha256(signature)) continue;
      if (missingOnly && previewBaselines.has(conversation)) continue;
      previewBaselines.set(conversation, signature);
    }
  }

  function applyBaselineAdvance(result, allowed) {
    const conversation = compactContactName(result?.baselineAdvance?.conversation);
    const signature = String(result?.baselineAdvance?.signature || "").trim().toLowerCase();
    if (allowed.includes(conversation) && isSha256(signature)) previewBaselines.set(conversation, signature);
  }

  function applyMessageBaselines(result, allowed, { replace = false, missingOnly = false } = {}) {
    if (replace) {
      messageBaselines.clear();
      occurrenceStates.clear();
    }
    const rows = Array.isArray(result?.sessionMessageBaselines) ? result.sessionMessageBaselines : [];
    for (const row of rows.slice(0, 1_000)) {
      const conversation = compactContactName(row?.conversation);
      const signature = String(row?.signature || "").trim().toLowerCase();
      if (!allowed.includes(conversation) || !isSha256(signature)) continue;
      if (missingOnly && messageBaselines.has(conversation)) continue;
      observeMessageSignature(conversation, signature);
    }
  }

  function applyMessageBaselineAdvance(result, allowed) {
    const conversation = compactContactName(result?.messageBaselineAdvance?.conversation);
    const signature = String(result?.messageBaselineAdvance?.signature || "").trim().toLowerCase();
    if (allowed.includes(conversation) && isSha256(signature)) observeMessageSignature(conversation, signature);
  }

  async function recoverPendingObservation(nameIdentity, allowed) {
    const pending = restoredPendingObservation;
    if (!pending) return null;
    if (!allowed.includes(pending.conversation)) {
      restoredPendingObservation = null;
      return { ok: false, reason: "whitelist_invalid" };
    }
    const result = await invoke("recover", [pending.conversation], {
      XIAOXI_EXPECTED_CONVERSATION: pending.conversation,
      XIAOXI_EXPECTED_PREVIEW_SIGNATURE: pending.previewSignature,
      XIAOXI_EXPECTED_MESSAGE_SIGNATURE: pending.messageSignature,
      XIAOXI_EXPECTED_PID: String(pending.pid),
      XIAOXI_EXPECTED_HWND: pending.hWnd
    });
    const identity = processIdentity(result);
    if (identity && (identity.pid !== pending.pid || identity.hWnd !== pending.hWnd)) {
      restoredPendingObservation = null;
      primedProcess = null;
      return { ...result, ok: false, reason: identity.pid !== pending.pid ? "wechat_process_changed" : "wechat_window_changed" };
    }
    if (result?.ok !== true) {
      const terminal = new Set([
        "conversation_title_mismatch",
        "incoming_message_changed",
        "latest_message_not_incoming",
        "wechat_process_changed",
        "wechat_window_changed"
      ]).has(String(result?.reason || ""));
      if (terminal) restoredPendingObservation = null;
      return terminal ? result : {
        ...result,
        ok: false,
        reason: "current_transition_unresolved",
        conversation: pending.conversation,
        pid: pending.pid,
        hWnd: pending.hWnd,
        pendingPreviewSignature: pending.previewSignature,
        pendingMessageSignature: pending.messageSignature,
        predecessorPreviewSignature: pending.predecessorPreviewSignature,
        predecessorMessageSignature: pending.predecessorMessageSignature
      };
    }
    restoredPendingObservation = null;
    const predecessor = isSha256(pending.predecessorMessageSignature) ? pending.predecessorMessageSignature : "";
    const decorated = decorateCandidate(result, nameIdentity, predecessor);
    previewBaselines.set(pending.conversation, pending.previewSignature);
    observeMessageSignature(pending.conversation, pending.messageSignature);
    return decorated;
  }

  function takeRetry(allowed, scanProbe) {
    while (retryCandidates.length) {
      const candidate = retryCandidates.shift();
      if (allowed.includes(compactContactName(candidate.conversation))) return { ...candidate, scanProbe };
    }
    return null;
  }

  function pendingCandidateFromResult(result, allowed) {
    const conversation = compactContactName(result?.conversation);
    const message = String(result?.message || "").normalize("NFKC").replace(/\s+/gu, "").trim();
    const runtimeId = String(result?.runtimeId || "").trim();
    const previewSignature = String(result?.previewSignature || "").trim().toLowerCase();
    const messageSignature = String(result?.messageSignature || "").trim().toLowerCase();
    const process = processIdentity(result);
    const discoveredConversation = result?.discoveredConversation === true;
    if ((!allowed.includes(conversation) && !discoveredConversation) || !message || String(result?.latestRole || "") !== "user"
      || !/^visual:v1:[a-f0-9]{64}$/u.test(runtimeId) || !isSha256(previewSignature)
      || !isSha256(messageSignature) || !process) return null;
    return {
      ok: true,
      conversation,
      message,
      runtimeId,
      previewSignature,
      messageSignature,
      pid: process.pid,
      hWnd: process.hWnd,
      source: String(result?.source || "unread"),
      latestRole: "user",
      discoveredConversation,
      pendingVerifyAttempts: 0,
      context: [{ role: "user", content: message, key: runtimeId }]
    };
  }

  async function settlePendingOpenedUnread(nameIdentity, allowed) {
    const pending = pendingOpenedUnread;
    if (!pending) return null;
    if (!allowed.includes(pending.conversation) && pending.discoveredConversation !== true) {
      pendingOpenedUnread = null;
      return null;
    }
    const verification = await verifyWechatIncoming({
      ...pending,
      visualMode: "visual_render_v1",
      visualEvidenceRuntimeId: pending.runtimeId
    });
    const identity = processIdentity(verification);
    if (identity && primedProcess && (identity.pid !== primedProcess.pid || identity.hWnd !== primedProcess.hWnd)) {
      const processChanged = identity.pid !== primedProcess.pid;
      previewBaselines.clear();
      messageBaselines.clear();
      occurrenceStates.clear();
      pendingOpenedUnread = null;
      primedProcess = null;
      return { ...verification, ok: false, reason: processChanged ? "wechat_process_changed" : "wechat_window_changed" };
    }
    if (verification?.ok !== true) {
      const terminalReasons = new Set([
        "conversation_title_mismatch",
        "incoming_message_changed",
        "incoming_message_missing",
        "latest_message_not_incoming",
        "wechat_process_changed",
        "wechat_window_changed"
      ]);
      if (terminalReasons.has(String(verification?.reason || ""))) pendingOpenedUnread = null;
      else {
        pending.pendingVerifyAttempts = Math.max(0, Math.floor(Number(pending.pendingVerifyAttempts) || 0)) + 1;
        if (pending.pendingVerifyAttempts >= pendingVerifyAttemptLimit) pendingOpenedUnread = null;
      }
      return pendingOpenedUnread
        ? { ...verification, ok: false, reason: "unread_preview_pending", pendingReason: String(verification?.reason || "pending_verify_failed") }
        : terminalReasons.has(String(verification?.reason || ""))
          ? verification
          : { ...verification, ok: false, reason: "unread_preview_unresolved", pendingReason: String(verification?.reason || "pending_verify_failed") };
    }
    const verifiedConversation = compactContactName(verification.conversation);
    const verifiedMessage = String(verification.message || "").normalize("NFKC").replace(/\s+/gu, "").trim();
    const verifiedRuntimeId = String(verification.visualEvidenceRuntimeId || "").trim();
    const verifiedSignature = String(verification.messageSignature || "").trim().toLowerCase();
    if (verifiedConversation !== pending.conversation || verifiedMessage !== pending.message
      || verifiedRuntimeId !== pending.runtimeId || verifiedSignature !== pending.messageSignature
      || String(verification.latestRole || "") !== "user") {
      pendingOpenedUnread = null;
      return { ...verification, ok: false, reason: "incoming_message_changed" };
    }
    pendingOpenedUnread = null;
    const predecessorSignature = messageBaselines.get(pending.conversation) || "";
    const decorated = decorateCandidate(pending, nameIdentity, predecessorSignature);
    previewBaselines.set(pending.conversation, pending.previewSignature);
    observeMessageSignature(pending.conversation, pending.messageSignature);
    return decorated;
  }

  function invoke(mode, allowed, extra = {}) {
    return Promise.resolve(powerShellRunner(AUTO_REPLY_VISUAL_SCRIPT, {
      XIAOXI_AUTO_REPLY_MODE: mode,
      XIAOXI_ALLOWED_NAMES: JSON.stringify(allowed),
      XIAOXI_EXCLUDED_NAMES: JSON.stringify(["文件传输助手", "微信团队", "服务通知", "订阅号消息", "群聊"]),
      XIAOXI_VISUAL_BASELINES: JSON.stringify(Object.fromEntries(previewBaselines)),
      XIAOXI_VISUAL_MESSAGE_BASELINES: JSON.stringify(Object.fromEntries(messageBaselines)),
      ...extra
    }, { ensure: false, sta: true, timeout: 30_000 }));
  }

  async function primeWechatSession(names) {
    const nameIdentity = allowedNameIdentity(names);
    const allowed = nameIdentity.compactNames;
    if (nameIdentity.ambiguous) return { ok: false, reason: "whitelist_name_ambiguous" };
    if (!allowed.length) return { ok: false, reason: "whitelist_empty" };
    const result = await invoke("prime", allowed);
    if (result?.ok !== true) return result;
    const process = processIdentity(result);
    if (!process) return { ok: false, reason: "incoming_identity_missing" };
    const observedCompactConversation = compactContactName(result.conversation);
    if (result?.discoveredConversation === true && observedCompactConversation) discoveredConversationNames.add(observedCompactConversation);
    const effectiveAllowed = [...new Set([...allowed, ...discoveredConversationNames])];
    applyBaselines(result, effectiveAllowed, { replace: true });
    applyMessageBaselines(result, effectiveAllowed, { replace: true });
    pendingOpenedUnread = null;
    restoredPendingObservation = null;
    primedProcess = process;
    const observedConversation = nameIdentity.compactToOriginal.get(compactContactName(result.conversation)) || String(result.conversation || "");
    const observedRole = String(result.latestRole || "");
    const observedSignature = String(result.messageSignature || "").trim().toLowerCase();
    return {
      ok: true,
      primed: true,
      pid: process.pid,
      hWnd: process.hWnd,
      ...(observedConversation ? { conversation: observedConversation } : {}),
      ...(observedRole ? { latestRole: observedRole } : {}),
      ...(isSha256(observedSignature) ? { messageSignature: observedSignature } : {})
    };
  }

  async function scanWechatIncoming(names) {
    const nameIdentity = allowedNameIdentity(names);
    const allowed = [...new Set([...nameIdentity.compactNames, ...discoveredConversationNames])];
    if (nameIdentity.ambiguous) return { ok: false, reason: "whitelist_name_ambiguous" };
    if (!allowed.length) return { ok: false, reason: "whitelist_empty" };
    if (!primedProcess) {
      const prime = await primeWechatSession(names);
      return prime?.ok === true ? { ...prime, ok: false, reason: "current_session_baselined" } : prime;
    }
    const restoredResult = await recoverPendingObservation(nameIdentity, allowed);
    if (restoredResult) return restoredResult;
    const pendingResult = await settlePendingOpenedUnread(nameIdentity, allowed);
    if (pendingResult) return pendingResult;
    const result = await invoke("scan", allowed, {
      XIAOXI_EXPECTED_PID: String(primedProcess.pid),
      XIAOXI_EXPECTED_HWND: primedProcess.hWnd
    });
    const identity = processIdentity(result);
    if (identity && (identity.pid !== primedProcess.pid || identity.hWnd !== primedProcess.hWnd)) {
      const processChanged = identity.pid !== primedProcess.pid;
      previewBaselines.clear();
      messageBaselines.clear();
      occurrenceStates.clear();
      pendingOpenedUnread = null;
      primedProcess = null;
      return { ...result, ok: false, reason: processChanged ? "wechat_process_changed" : "wechat_window_changed" };
    }
    if (result?.reason === "wechat_process_changed" || result?.reason === "wechat_window_changed") {
      previewBaselines.clear();
      messageBaselines.clear();
      occurrenceStates.clear();
      pendingOpenedUnread = null;
      primedProcess = null;
      return result;
    }
    const observedConversation = compactContactName(result?.conversation);
    if (result?.discoveredConversation === true && observedConversation) discoveredConversationNames.add(observedConversation);
    if (result?.ok !== true) {
      if (result?.reason === "unread_preview_pending") {
        const pending = pendingCandidateFromResult(result, allowed);
        if (!pending) return { ...result, ok: false, reason: "incoming_identity_missing" };
        if (primedProcess && (pending.pid !== primedProcess.pid || pending.hWnd !== primedProcess.hWnd)) {
          pendingOpenedUnread = null;
          return { ...result, ok: false, reason: pending.pid !== primedProcess.pid ? "wechat_process_changed" : "wechat_window_changed" };
        }
        pendingOpenedUnread = pending;
        return { ...result, ok: false, reason: "unread_preview_pending" };
      }
      // An unstable two-frame transition is a run-level safety fence. Never
      // let an older retry candidate hide it and continue toward AI/send.
      if (result?.reason === "wechat_focus_failed"
        || result?.reason === "chat_boundary_unresolved"
        || result?.reason === "latest_message_role_unresolved"
        || result?.reason === "current_transition_unresolved"
        || result?.reason === "current_outgoing_settling") return result;
      if (result?.reason === "latest_message_not_incoming" || result?.reason === "current_visual_drift_consumed") applyBaselineAdvance(result, allowed);
      else applyBaselines(result, allowed, { missingOnly: true });
      if (result?.reason === "latest_message_not_incoming" || result?.reason === "current_visual_drift_consumed") applyMessageBaselineAdvance(result, allowed);
      else applyMessageBaselines(result, allowed, { missingOnly: true });
      return takeRetry(allowed, { ok: false, reason: result?.reason || "scan_result_invalid" }) || result;
    }
    const conversation = compactContactName(result.conversation);
    const message = String(result.message || "").trim();
    const runtimeId = String(result.runtimeId || "").trim();
    const signature = String(result.previewSignature || "").trim().toLowerCase();
    const messageSignature = String(result.messageSignature || "").trim().toLowerCase();
    if ((!allowed.includes(conversation) && result?.discoveredConversation !== true) || !message) return { ok: false, reason: "incoming_message_missing" };
    if (!/^visual:v1:[a-f0-9]{64}$/u.test(runtimeId) || !isSha256(signature) || !isSha256(messageSignature)) return { ok: false, reason: "incoming_identity_missing" };
    const predecessorSignature = messageBaselines.get(conversation) || "";
    const decorated = decorateCandidate({
      ...result,
      discoveredConversation: result?.discoveredConversation === true || discoveredConversationNames.has(conversation)
    }, nameIdentity, predecessorSignature);
    previewBaselines.set(conversation, signature);
    observeMessageSignature(conversation, messageSignature);
    return decorated;
  }

  async function verifyWechatIncoming(candidate = {}) {
    const nameIdentity = allowedNameIdentity([candidate.conversation]);
    const conversation = nameIdentity.compactNames[0] || "";
    const message = String(candidate.message || "").normalize("NFKC").replace(/\s+/gu, "").trim();
    const runtimeId = String(candidate.runtimeId || "").trim();
    const evidenceRuntimeId = String(candidate.visualEvidenceRuntimeId || runtimeId).trim();
    if (!conversation || !message) return { ok: false, reason: "incoming_message_missing" };
    if (!/^visual:v[12]:[a-f0-9]{64}$/u.test(runtimeId) || !/^visual:v1:[a-f0-9]{64}$/u.test(evidenceRuntimeId)) return { ok: false, reason: "incoming_identity_missing" };
    const result = await invoke("verify", [conversation], {
      XIAOXI_EXPECTED_CONVERSATION: conversation,
      XIAOXI_EXPECTED_MESSAGE: message,
      XIAOXI_EXPECTED_RUNTIME_ID: evidenceRuntimeId,
      XIAOXI_EXPECTED_MESSAGE_SIGNATURE: String(candidate.messageSignature || ""),
      XIAOXI_EXPECTED_PID: String(candidate.pid || ""),
      XIAOXI_EXPECTED_HWND: String(candidate.hWnd || "")
    });
    return result?.ok === true
      ? {
          ...result,
          conversation: nameIdentity.compactToOriginal.get(conversation) || String(candidate.conversation || ""),
          runtimeId,
          visualEvidenceRuntimeId: evidenceRuntimeId,
          context: rewriteLatestContextKey(result.context, runtimeId)
        }
      : result;
  }

  function noteVerifiedSend(candidate = {}, metadata = {}) {
    const verificationMode = String(metadata?.verificationMode || "");
    if (!new Set(["visual_message_bubble", "draft_consumed_same_header"]).has(verificationMode)) return false;
    const conversation = compactContactName(candidate?.conversation);
    const runtimeId = String(candidate?.runtimeId || "").trim();
    const active = occurrenceStates.get(conversation);
    if (!conversation || !/^visual:v2:[a-f0-9]{64}$/u.test(runtimeId) || active?.runtimeId !== runtimeId) return false;
    const boundarySignature = createHash("sha256").update([
      "visual-verified-outgoing-boundary-v1",
      conversation,
      runtimeId,
      String(candidate?.visualEvidenceRuntimeId || "")
    ].join("\n"), "utf8").digest("hex");
    if (active.active !== true) return active.boundarySignature === boundarySignature;
    occurrenceStates.set(conversation, { ...active, active: false, boundarySignature });
    // A successful sender result proves either the outgoing bubble itself or
    // the exact click plus consumed draft in the same bound conversation.
    // Advancing to an opaque boundary keeps an immediately following identical
    // customer bubble observable before the next regular assistant scan.
    previewBaselines.set(conversation, boundarySignature);
    messageBaselines.set(conversation, boundarySignature);
    return true;
  }

  scanWechatIncoming.primeBaselines = primeWechatSession;
  scanWechatIncoming.restorePendingObservation = restorePendingObservation;
  scanWechatIncoming.noteVerifiedSend = noteVerifiedSend;
  scanWechatIncoming.requeue = (candidate) => {
    if (candidate?.ok !== true || !/^visual:v[12]:[a-f0-9]{64}$/u.test(String(candidate.runtimeId || ""))) return false;
    const key = candidateKey(candidate);
    if (retryCandidates.some((item) => candidateKey(item) === key)) return true;
    if (retryCandidates.length >= 1_000) return false;
    const { scanProbe: _discardedProbe, ...copy } = candidate;
    retryCandidates.push(copy);
    return true;
  };
  scanWechatIncoming.resetBaselines = () => {
    previewBaselines.clear();
    messageBaselines.clear();
    occurrenceStates.clear();
    retryCandidates.length = 0;
    discoveredConversationNames.clear();
    pendingOpenedUnread = null;
    restoredPendingObservation = null;
    primedProcess = null;
  };

  return { primeWechatSession, scanWechatIncoming, verifyWechatIncoming, noteVerifiedSend };
}

const driver = createWechatVisualAutoReplyDriver();

module.exports = {
  AUTO_REPLY_VISUAL_SCRIPT,
  createWechatVisualAutoReplyDriver,
  ...driver
};
