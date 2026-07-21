const { createHash, randomBytes } = require("node:crypto");
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
  return $red -ge 205 -and $green -le 125 -and $blue -le 125 -and ($red - $green) -ge 85 -and ($red - $blue) -ge 85
}

function Test-AutoReplyVisualUnreadDot($frame, $nameBounds) {
  # The avatar occupies most of the old name.left-78..-6 search area. Brand-red
  # avatars therefore looked like unread badges. Only inspect the small cap at
  # the avatar's upper-right edge, above the contact-name text baseline.
  $xStart = [int][Math]::Max(0, [Math]::Floor([double]$nameBounds.left - (Scale-AutoReplyVisualMetric 32.0)))
  $xEnd = [int][Math]::Min($frame.width - 1, [Math]::Ceiling([double]$nameBounds.left - (Scale-AutoReplyVisualMetric 4.0)))
  $yStart = [int][Math]::Max(0, [Math]::Floor([double]$nameBounds.top - (Scale-AutoReplyVisualMetric 22.0)))
  $yEnd = [int][Math]::Min($frame.height - 1, [Math]::Ceiling([double]$nameBounds.top - (Scale-AutoReplyVisualMetric 1.0)))
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

function Get-AutoReplyVisualSidebarRows($frame, $lines, $allowedSet, [double]$sidebarRight) {
  $nameMatches = New-Object System.Collections.Generic.List[object]
  foreach ($line in $lines) {
    $left = [double]$line.bounds.left; $top = [double]$line.bounds.top
    $right = $left + [double]$line.bounds.width
    if ($left -lt (Scale-AutoReplyVisualMetric 42.0) -or $right -gt ($sidebarRight + (Scale-AutoReplyVisualMetric 8.0)) -or $top -lt (Scale-AutoReplyVisualMetric 72.0) -or $top -gt ($frame.height - (Scale-AutoReplyVisualMetric 42.0))) { continue }
    foreach ($name in $allowedSet) {
      if (Test-AutoReplyVisualSidebarNameLine ([string]$line.compact) ([string]$name)) {
        [void]$nameMatches.Add([pscustomobject]@{ name = [string]$name; line = $line })
      }
    }
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
    [void]$rows.Add([pscustomobject]@{
      conversation = [string]$match.name
      preview = $preview
      signature = Get-AutoReplyVisualSha256 $preview
      unread = [bool](Test-AutoReplyVisualUnreadDot $frame $nameLine.bounds)
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

function Get-AutoReplyVisualLatestMessageEvidence($frame, $lines, [double]$sidebarRight) {
  $chatBottom = [double]$frame.height * 0.81
  $chatMid = $sidebarRight + (([double]$frame.width - $sidebarRight) * 0.58)
  $viewportRect = @{
    left = $sidebarRight + (Scale-AutoReplyVisualMetric 10.0)
    top = Scale-AutoReplyVisualMetric 108.0
    width = [Math]::Max(1.0, [double]$frame.width - $sidebarRight - (Scale-AutoReplyVisualMetric 24.0))
    height = [Math]::Max(1.0, $chatBottom - (Scale-AutoReplyVisualMetric 108.0))
  }
  $viewportHash = Get-MomentsPixelHash $frame $viewportRect
  if (-not $viewportHash) { return @{ ok = $false; reason = "latest_text_message_missing" } }
  $messageLines = @($lines | Where-Object {
    [double]$_.bounds.left -ge ($sidebarRight + (Scale-AutoReplyVisualMetric 14.0)) -and
      [double]$_.bounds.top -ge (Scale-AutoReplyVisualMetric 108.0) -and [double]$_.bounds.top -le $chatBottom -and
      (Test-AutoReplyVisualPureText ([string]$_.compact))
  } | Sort-Object { [double]$_.bounds.top }, { [double]$_.bounds.left })
  if ($messageLines.Count -eq 0) {
    return @{
      ok = $true
      hasMessage = $false
      viewportHash = $viewportHash
      evidenceSignature = Get-AutoReplyVisualSha256 ([string]::Join([char]10, @("empty", $viewportHash)))
    }
  }
  $latest = $messageLines[-1]
  $message = Normalize-AutoReplyVisualText ([string]$latest.compact)
  $pixelRect = @{
    left = [Math]::Max($sidebarRight, [double]$latest.bounds.left - (Scale-AutoReplyVisualMetric 8.0))
    top = [Math]::Max(0.0, [double]$latest.bounds.top - (Scale-AutoReplyVisualMetric 6.0))
    width = [Math]::Min([double]$frame.width, [double]$latest.bounds.left + [double]$latest.bounds.width + (Scale-AutoReplyVisualMetric 8.0)) - [Math]::Max($sidebarRight, [double]$latest.bounds.left - (Scale-AutoReplyVisualMetric 8.0))
    height = [Math]::Min([double]$frame.height, [double]$latest.bounds.top + [double]$latest.bounds.height + (Scale-AutoReplyVisualMetric 6.0)) - [Math]::Max(0.0, [double]$latest.bounds.top - (Scale-AutoReplyVisualMetric 6.0))
  }
  $pixelHash = Get-MomentsPixelHash $frame $pixelRect
  if (-not $pixelHash) { return @{ ok = $false; reason = "latest_text_message_missing" } }
  $latestRole = if ([double]$latest.bounds.left -ge $chatMid) { "assistant" } else { "user" }
  $evidenceSeed = [string]::Join([char]10, @(
    $message,
    $latestRole,
    $pixelHash,
    $viewportHash,
    ("{0:N1}" -f [double]$latest.bounds.left),
    ("{0:N1}" -f [double]$latest.bounds.top),
    ("{0:N1}" -f [double]$latest.bounds.width),
    ("{0:N1}" -f [double]$latest.bounds.height)
  ))
  return @{
    ok = $true
    hasMessage = $true
    message = $message
    line = $latest
    pixelHash = $pixelHash
    viewportHash = $viewportHash
    latestRole = $latestRole
    evidenceSignature = Get-AutoReplyVisualSha256 $evidenceSeed
  }
}

function Get-AutoReplyVisualLatestIncoming($frame, $lines, [string]$expectedMessage, [double]$sidebarRight) {
  $latest = Get-AutoReplyVisualLatestMessageEvidence $frame $lines $sidebarRight
  if (-not $latest.ok -or -not $latest.hasMessage) { return @{ ok = $false; reason = "latest_text_message_missing" } }
  if ([string]$latest.message -cne (Normalize-AutoReplyVisualText $expectedMessage)) { return @{ ok = $false; reason = "unread_preview_mismatch" } }
  if ([string]$latest.latestRole -cne "user") {
    return @{
      ok = $false
      reason = "latest_message_not_incoming"
      message = [string]$latest.message
      line = $latest.line
      pixelHash = [string]$latest.pixelHash
      viewportHash = [string]$latest.viewportHash
      evidenceSignature = [string]$latest.evidenceSignature
      latestRole = "assistant"
    }
  }
  return $latest
}

function Get-AutoReplyVisualObservation([IntPtr]$hWnd, [int]$expectedProcessId, $windowRect) {
  $frame = Get-AutoReplyVisualFrame $hWnd $windowRect $expectedProcessId
  if (-not $frame.ok) { return @{ ok = $false; reason = [string]$frame.reason } }
  try {
    $ocr = Get-MomentsOcrObservation $frame @{ left = 0.0; top = 0.0; width = [double]$frame.width; height = [double]$frame.height }
    if (-not $ocr.ok) { return @{ ok = $false; reason = [string]$ocr.reason } }
    return @{ ok = $true; frame = $frame; lines = @(Get-AutoReplyVisualLines $ocr) }
  } catch {
    Close-MomentsVisualFrame $frame
    return @{ ok = $false; reason = "visual_ocr_failed" }
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
try { $baselines = [Environment]::GetEnvironmentVariable("XIAOXI_VISUAL_BASELINES") | ConvertFrom-Json } catch { $baselines = $null }
try { $messageBaselines = [Environment]::GetEnvironmentVariable("XIAOXI_VISUAL_MESSAGE_BASELINES") | ConvertFrom-Json } catch { $messageBaselines = $null }
$expectedConversation = Normalize-AutoReplyVisualText ([Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_CONVERSATION"))
$expectedMessage = Normalize-AutoReplyVisualText ([Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_MESSAGE"))
$expectedRuntimeId = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_RUNTIME_ID")
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
$paneEvidence = Get-MomentsRenderPaneEvidence $root ([int]$process.Id)
if (-not $paneEvidence.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$paneEvidence.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
if ([double]$paneEvidence.pane.bounds.width -lt ($windowRect.Width * 0.7) -or [double]$paneEvidence.pane.bounds.height -lt ($windowRect.Height * 0.7)) {
  Write-AutoReplyVisualResult @{ ok = $false; reason = "visual_render_pane_mismatch"; pid = [int]$process.Id; hWnd = [int64]$hWnd }
}

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
  $sessionBaselines = @($rows | ForEach-Object { @{ conversation = [string]$_.conversation; signature = [string]$_.signature } })
  $currentConversation = Get-AutoReplyVisualCurrentConversation $observation.lines $allowedSet $sidebarRight ([double]$frame.width)
  if (-not $currentConversation.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$currentConversation.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
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
  if ($mode -eq "prime") {
    Write-AutoReplyVisualResult @{
      ok = $true
      source = "session_prime"
      pid = [int]$process.Id
      hWnd = [int64]$hWnd
      sessionBaselines = $sessionBaselines
      sessionMessageBaselines = $sessionMessageBaselines
    }
  }

  if ($mode -eq "verify") {
    if (-not $expectedConversation -or -not $expectedMessage -or -not $expectedRuntimeId) { Write-AutoReplyVisualResult @{ ok = $false; reason = "incoming_message_missing" } }
    $expectedRows = @($rows | Where-Object { [string]$_.conversation -ceq $expectedConversation -and [string]$_.preview -ceq $expectedMessage })
    $currentConversationMatches = $currentConversation.active -and [string]$currentConversation.conversation -ceq $expectedConversation
    if ($expectedRows.Count -ne 1 -and -not $currentConversationMatches) { Write-AutoReplyVisualResult @{ ok = $false; reason = "incoming_message_changed"; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
    $header = Get-AutoReplyVisualHeader $observation.lines $expectedConversation $sidebarRight ([double]$frame.width)
    if (-not $header.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$header.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
    $latest = Get-AutoReplyVisualLatestIncoming $frame $observation.lines $expectedMessage $sidebarRight
    if (-not $latest.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$latest.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
    $runtimeSeed = [string]::Join([char]10, @($expectedConversation, $latest.message, $latest.pixelHash, ("{0:N1}" -f [double]$latest.line.bounds.left), ("{0:N1}" -f [double]$latest.line.bounds.top)))
    $runtimeId = "visual:v1:" + (Get-AutoReplyVisualSha256 $runtimeSeed)
    if ($runtimeId -cne $expectedRuntimeId) { Write-AutoReplyVisualResult @{ ok = $false; reason = "incoming_message_changed"; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
    Write-AutoReplyVisualResult @{
      ok = $true
      conversation = $expectedConversation
      message = $latest.message
      runtimeId = $runtimeId
      messageSignature = [string]$latest.evidenceSignature
      pid = [int]$process.Id
      hWnd = [int64]$hWnd
      source = "verify"
      latestRole = "user"
      context = @(@{ role = "user"; content = $latest.message; key = $runtimeId })
    }
  }

  $candidates = New-Object System.Collections.Generic.List[object]
  foreach ($row in $rows) {
    # OCR-only preview changes are not an event signal: small recognition jitter
    # previously caused a click on every scan. Background sessions require a
    # geometric unread badge; the already-open session uses message-area evidence.
    if ($row.unread) {
      $row | Add-Member -NotePropertyName source -NotePropertyValue "unread" -Force
      [void]$candidates.Add($row)
    }
  }
  if ($candidates.Count -eq 0) {
    if ($currentConversation.active -and $currentMessage -ne $null) {
      $currentName = [string]$currentConversation.conversation
      $previousMessageSignature = Get-AutoReplyVisualBaseline $messageBaselines $currentName
      $currentMessageSignature = [string]$currentMessage.evidenceSignature
      $messageChanged = $previousMessageSignature -match "^[a-f0-9]{64}$" -and $previousMessageSignature -cne $currentMessageSignature
      if ($messageChanged -and $currentMessage.hasMessage) {
        $currentRow = @($rows | Where-Object { [string]$_.conversation -ceq $currentName } | Select-Object -First 1)
        $currentPreviewSignature = if ($currentRow.Count -eq 1) { [string]$currentRow[0].signature } else { Get-AutoReplyVisualSha256 ([string]$currentMessage.message) }
        if ([string]$currentMessage.latestRole -cne "user") {
          Write-AutoReplyVisualResult @{
            ok = $false
            reason = "latest_message_not_incoming"
            pid = [int]$process.Id
            hWnd = [int64]$hWnd
            baselineAdvance = @{ conversation = $currentName; signature = $currentPreviewSignature }
            messageBaselineAdvance = @{ conversation = $currentName; signature = $currentMessageSignature }
          }
        }
        $runtimeSeed = [string]::Join([char]10, @(
          $currentName,
          [string]$currentMessage.message,
          [string]$currentMessage.pixelHash,
          ("{0:N1}" -f [double]$currentMessage.line.bounds.left),
          ("{0:N1}" -f [double]$currentMessage.line.bounds.top)
        ))
        $runtimeId = "visual:v1:" + (Get-AutoReplyVisualSha256 $runtimeSeed)
        Write-AutoReplyVisualResult @{
          ok = $true
          conversation = $currentName
          message = [string]$currentMessage.message
          runtimeId = $runtimeId
          previewSignature = $currentPreviewSignature
          messageSignature = $currentMessageSignature
          pid = [int]$process.Id
          hWnd = [int64]$hWnd
          source = "current_message_change"
          latestRole = "user"
          context = @(@{ role = "user"; content = [string]$currentMessage.message; key = $runtimeId })
        }
      }
    }
    Write-AutoReplyVisualResult @{
      ok = $false
      reason = "no_unread_message"
      pid = [int]$process.Id
      hWnd = [int64]$hWnd
      sessionBaselines = $sessionBaselines
      sessionMessageBaselines = $sessionMessageBaselines
    }
  }
  $unreadCandidates = @($candidates.ToArray() | Where-Object { $_.unread })
  $candidate = if ($unreadCandidates.Count -gt 0) { $unreadCandidates[0] } else { $candidates[0] }
  $conversation = [string]$candidate.conversation; $preview = [string]$candidate.preview; $source = [string]$candidate.source
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
  $header = Get-AutoReplyVisualHeader $openedObservation.lines $conversation $sidebarRight ([double]$openedFrame.width)
  if (-not $header.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$header.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
  $latest = Get-AutoReplyVisualLatestIncoming $openedFrame $openedObservation.lines $preview $sidebarRight
  if (-not $latest.ok) {
    if ([string]$latest.reason -ceq "latest_message_not_incoming") {
      Write-AutoReplyVisualResult @{
        ok = $false
        reason = "latest_message_not_incoming"
        pid = [int]$process.Id
        hWnd = [int64]$hWnd
        baselineAdvance = @{ conversation = $conversation; signature = [string]$candidate.signature }
        messageBaselineAdvance = @{ conversation = $conversation; signature = [string]$latest.evidenceSignature }
      }
    }
    Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$latest.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd }
  }
  $runtimeSeed = [string]::Join([char]10, @($conversation, $latest.message, $latest.pixelHash, ("{0:N1}" -f [double]$latest.line.bounds.left), ("{0:N1}" -f [double]$latest.line.bounds.top)))
  $runtimeId = "visual:v1:" + (Get-AutoReplyVisualSha256 $runtimeSeed)
  Write-AutoReplyVisualResult @{
    ok = $true
    conversation = $conversation
    message = $latest.message
    runtimeId = $runtimeId
    previewSignature = [string]$candidate.signature
    messageSignature = [string]$latest.evidenceSignature
    pid = [int]$process.Id
    hWnd = [int64]$hWnd
    source = $source
    latestRole = "user"
    context = @(@{ role = "user"; content = $latest.message; key = $runtimeId })
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
  const previewBaselines = new Map();
  const messageBaselines = new Map();
  const retryCandidates = [];
  const eventSessionId = randomBytes(16).toString("hex");
  let eventSequence = 0;
  let primedProcess = null;

  function decorateCandidate(result, identity) {
    const evidenceRuntimeId = String(result?.runtimeId || "").trim();
    eventSequence += 1;
    const runtimeId = `visual:v2:${createHash("sha256").update(`${eventSessionId}\n${eventSequence}\n${evidenceRuntimeId}`, "utf8").digest("hex")}`;
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
    if (replace) messageBaselines.clear();
    const rows = Array.isArray(result?.sessionMessageBaselines) ? result.sessionMessageBaselines : [];
    for (const row of rows.slice(0, 1_000)) {
      const conversation = compactContactName(row?.conversation);
      const signature = String(row?.signature || "").trim().toLowerCase();
      if (!allowed.includes(conversation) || !isSha256(signature)) continue;
      if (missingOnly && messageBaselines.has(conversation)) continue;
      messageBaselines.set(conversation, signature);
    }
  }

  function applyMessageBaselineAdvance(result, allowed) {
    const conversation = compactContactName(result?.messageBaselineAdvance?.conversation);
    const signature = String(result?.messageBaselineAdvance?.signature || "").trim().toLowerCase();
    if (allowed.includes(conversation) && isSha256(signature)) messageBaselines.set(conversation, signature);
  }

  function takeRetry(allowed, scanProbe) {
    while (retryCandidates.length) {
      const candidate = retryCandidates.shift();
      if (allowed.includes(compactContactName(candidate.conversation))) return { ...candidate, scanProbe };
    }
    return null;
  }

  function invoke(mode, allowed, extra = {}) {
    return Promise.resolve(powerShellRunner(AUTO_REPLY_VISUAL_SCRIPT, {
      XIAOXI_AUTO_REPLY_MODE: mode,
      XIAOXI_ALLOWED_NAMES: JSON.stringify(allowed),
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
    applyBaselines(result, allowed, { replace: true });
    applyMessageBaselines(result, allowed, { replace: true });
    primedProcess = process;
    return { ok: true, primed: true, pid: process.pid, hWnd: process.hWnd };
  }

  async function scanWechatIncoming(names) {
    const nameIdentity = allowedNameIdentity(names);
    const allowed = nameIdentity.compactNames;
    if (nameIdentity.ambiguous) return { ok: false, reason: "whitelist_name_ambiguous" };
    if (!allowed.length) return { ok: false, reason: "whitelist_empty" };
    if (!primedProcess) {
      const prime = await primeWechatSession(names);
      return prime?.ok === true ? { ok: false, reason: "current_session_baselined" } : prime;
    }
    const result = await invoke("scan", allowed, {
      XIAOXI_EXPECTED_PID: String(primedProcess.pid),
      XIAOXI_EXPECTED_HWND: primedProcess.hWnd
    });
    const identity = processIdentity(result);
    if (identity && (identity.pid !== primedProcess.pid || identity.hWnd !== primedProcess.hWnd)) {
      const processChanged = identity.pid !== primedProcess.pid;
      previewBaselines.clear();
      messageBaselines.clear();
      primedProcess = null;
      return { ...result, ok: false, reason: processChanged ? "wechat_process_changed" : "wechat_window_changed" };
    }
    if (result?.reason === "wechat_process_changed" || result?.reason === "wechat_window_changed") {
      previewBaselines.clear();
      messageBaselines.clear();
      primedProcess = null;
      return result;
    }
    if (result?.ok !== true) {
      if (result?.reason === "latest_message_not_incoming") applyBaselineAdvance(result, allowed);
      else applyBaselines(result, allowed, { missingOnly: true });
      if (result?.reason === "latest_message_not_incoming") applyMessageBaselineAdvance(result, allowed);
      else applyMessageBaselines(result, allowed, { missingOnly: true });
      return takeRetry(allowed, { ok: false, reason: result?.reason || "scan_result_invalid" }) || result;
    }
    const conversation = compactContactName(result.conversation);
    const message = String(result.message || "").trim();
    const runtimeId = String(result.runtimeId || "").trim();
    const signature = String(result.previewSignature || "").trim().toLowerCase();
    const messageSignature = String(result.messageSignature || "").trim().toLowerCase();
    if (!allowed.includes(conversation) || !message) return { ok: false, reason: "incoming_message_missing" };
    if (!/^visual:v1:[a-f0-9]{64}$/u.test(runtimeId) || !isSha256(signature) || !isSha256(messageSignature)) return { ok: false, reason: "incoming_identity_missing" };
    previewBaselines.set(conversation, signature);
    messageBaselines.set(conversation, messageSignature);
    return decorateCandidate(result, nameIdentity);
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

  scanWechatIncoming.primeBaselines = primeWechatSession;
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
    primedProcess = null;
  };

  return { primeWechatSession, scanWechatIncoming, verifyWechatIncoming };
}

const driver = createWechatVisualAutoReplyDriver();

module.exports = {
  AUTO_REPLY_VISUAL_SCRIPT,
  createWechatVisualAutoReplyDriver,
  ...driver
};
