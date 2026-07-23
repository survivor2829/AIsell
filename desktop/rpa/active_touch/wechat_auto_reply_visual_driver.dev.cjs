const { createHash } = require("node:crypto");
const { MOMENTS_VISUAL_READONLY_POWERSHELL } = require("./moments_visual_probe.dev.cjs");
const { runPowerShellAsync } = require("./wechat_window_driver.cjs");

const AUTO_REPLY_VISUAL_SCRIPT = String.raw`
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient

${MOMENTS_VISUAL_READONLY_POWERSHELL}

$script:AutoReplyVisualScale = 1.0
$script:AutoReplyVisualWindow = $null
$script:AutoReplyVisualDpi = $null
$script:AutoReplyVisualCaptureMethod = ""

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32WechatAutoReplyVisual {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@

function Resolve-AutoReplyVisualWechatWindow([int]$expectedProcessId, [int64]$expectedWindowHandle) {
  if ($expectedWindowHandle -gt 0) {
    $candidateHandle = [IntPtr]$expectedWindowHandle
    if (-not [Win32WechatAutoReplyVisual]::IsWindow($candidateHandle) -or
        -not [Win32WechatAutoReplyVisual]::IsWindowVisible($candidateHandle)) {
      return @{ ok = $false; reason = "wechat_window_changed" }
    }
    [uint32]$candidatePid = 0
    [void][Win32WechatAutoReplyVisual]::GetWindowThreadProcessId($candidateHandle, [ref]$candidatePid)
    if ($expectedProcessId -gt 0 -and [int]$candidatePid -ne $expectedProcessId) {
      return @{ ok = $false; reason = "wechat_process_changed"; pid = [int]$candidatePid; hWnd = [int64]$candidateHandle }
    }
    $candidateProcess = Get-Process -Id ([int]$candidatePid) -ErrorAction SilentlyContinue
    if ($null -eq $candidateProcess -or @("Weixin", "WeChat") -notcontains [string]$candidateProcess.ProcessName) {
      return @{ ok = $false; reason = "wechat_process_changed"; pid = [int]$candidatePid; hWnd = [int64]$candidateHandle }
    }
    $candidateRect = New-Object Win32WechatAutoReplyVisual+RECT
    if (-not [Win32WechatAutoReplyVisual]::GetWindowRect($candidateHandle, [ref]$candidateRect) -or
        ($candidateRect.Right - $candidateRect.Left) -lt 600 -or ($candidateRect.Bottom - $candidateRect.Top) -lt 500) {
      return @{ ok = $false; reason = "wechat_window_not_ready"; pid = [int]$candidatePid; hWnd = [int64]$candidateHandle }
    }
    return @{ ok = $true; process = $candidateProcess; hWnd = $candidateHandle }
  }

  # WeChat 4.x frequently exposes MainWindowHandle=0 even while its compositor
  # window is visible. Enumerate real top-level windows instead of asking the
  # Process object to guess which one is the main window.
  $processNames = @("Weixin", "WeChat")
  if (@(Get-Process -Name Weixin, WeChat -ErrorAction SilentlyContinue).Count -eq 0) { return @{ ok = $false; reason = "wechat_window_missing" } }
  $windows = New-Object System.Collections.Generic.List[object]
  $callback = [Win32WechatAutoReplyVisual+EnumWindowsProc]{
    param([IntPtr]$windowHandle, [IntPtr]$unused)
    if (-not [Win32WechatAutoReplyVisual]::IsWindowVisible($windowHandle)) { return $true }
    [uint32]$windowPid = 0
    [void][Win32WechatAutoReplyVisual]::GetWindowThreadProcessId($windowHandle, [ref]$windowPid)
    $windowProcess = Get-Process -Id ([int]$windowPid) -ErrorAction SilentlyContinue
    if ($null -eq $windowProcess -or $processNames -notcontains [string]$windowProcess.ProcessName) { return $true }
    $rect = New-Object Win32WechatAutoReplyVisual+RECT
    if (-not [Win32WechatAutoReplyVisual]::GetWindowRect($windowHandle, [ref]$rect)) { return $true }
    $width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
    if ($width -lt 600 -or $height -lt 500) { return $true }
    [void]$windows.Add([pscustomobject]@{
      hWnd = $windowHandle
      pid = [int]$windowPid
      width = [int]$width
      height = [int]$height
      area = [int64]$width * [int64]$height
    })
    return $true
  }
  [void][Win32WechatAutoReplyVisual]::EnumWindows($callback, [IntPtr]::Zero)
  $ordered = @($windows.ToArray() | Sort-Object area -Descending)
  if ($ordered.Count -eq 0) { return @{ ok = $false; reason = "wechat_window_missing" } }
  if ($ordered.Count -gt 1 -and [int64]$ordered[0].area -eq [int64]$ordered[1].area) {
    return @{ ok = $false; reason = "wechat_window_ambiguous"; candidateCount = $ordered.Count }
  }
  $selected = $ordered[0]
  $selectedProcess = Get-Process -Id ([int]$selected.pid) -ErrorAction SilentlyContinue
  if ($null -eq $selectedProcess) { return @{ ok = $false; reason = "wechat_window_missing" } }
  return @{ ok = $true; process = $selectedProcess; hWnd = [IntPtr]$selected.hWnd; candidateCount = $ordered.Count }
}

function Write-AutoReplyVisualResult($value) {
  if ($value -is [System.Collections.IDictionary]) {
    $value["adapterVersion"] = "visual-bubble-v3"
    if ($null -ne $script:AutoReplyVisualWindow) { $value["window"] = $script:AutoReplyVisualWindow }
    if ($null -ne $script:AutoReplyVisualDpi) { $value["dpi"] = [int]$script:AutoReplyVisualDpi }
    if ($script:AutoReplyVisualCaptureMethod) { $value["captureMode"] = [string]$script:AutoReplyVisualCaptureMethod }
  }
  $value | ConvertTo-Json -Compress -Depth 8
  exit
}

function Normalize-AutoReplyVisualText([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  $normalized = $value.Normalize([Text.NormalizationForm]::FormKC)
  return [Text.RegularExpressions.Regex]::Replace($normalized, "\s+", "").Trim()
}

function Get-AutoReplyVisualEditDistance([string]$left, [string]$right) {
  $left = Normalize-AutoReplyVisualText $left; $right = Normalize-AutoReplyVisualText $right
  $rows = $left.Length + 1; $columns = $right.Length + 1
  $matrix = New-Object int[] ($rows * $columns)
  for ($i = 0; $i -lt $rows; $i++) { $matrix[$i * $columns] = $i }
  for ($j = 0; $j -lt $columns; $j++) { $matrix[$j] = $j }
  for ($i = 1; $i -lt $rows; $i++) {
    for ($j = 1; $j -lt $columns; $j++) {
      $cost = if ($left[$i - 1] -ceq $right[$j - 1]) { 0 } else { 1 }
      $index = ($i * $columns) + $j
      $matrix[$index] = [Math]::Min(
        [Math]::Min($matrix[(($i - 1) * $columns) + $j] + 1, $matrix[($i * $columns) + $j - 1] + 1),
        $matrix[(($i - 1) * $columns) + $j - 1] + $cost
      )
    }
  }
  return $matrix[(($rows - 1) * $columns) + $columns - 1]
}

function Test-AutoReplyVisualConversationMatch([string]$expected, [string]$observed) {
  $expected = Normalize-AutoReplyVisualText $expected; $observed = Normalize-AutoReplyVisualText $observed
  if (-not $expected -or -not $observed) { return $false }
  if ($expected -ceq $observed) { return $true }
  $maximumLength = [Math]::Max($expected.Length, $observed.Length)
  if ([Math]::Min($expected.Length, $observed.Length) -lt 4 -or [Math]::Abs($expected.Length - $observed.Length) -gt 2) { return $false }
  if ($expected[0] -cne $observed[0] -or $expected.Substring($expected.Length - 2) -cne $observed.Substring($observed.Length - 2)) { return $false }
  $maximumDistance = [Math]::Max(1, [int][Math]::Floor($maximumLength * 0.34))
  return (Get-AutoReplyVisualEditDistance $expected $observed) -le $maximumDistance
}

function Test-AutoReplyVisualMessageMatch([string]$expected, [string]$observed) {
  $expected = Normalize-AutoReplyVisualText $expected; $observed = Normalize-AutoReplyVisualText $observed
  if (-not $expected -or -not $observed) { return $false }
  if ($expected -ceq $observed) { return $true }
  $maximumLength = [Math]::Max($expected.Length, $observed.Length)
  if ([Math]::Min($expected.Length, $observed.Length) -lt 4 -or
      [Math]::Abs($expected.Length - $observed.Length) -gt 1) { return $false }
  $maximumDistance = [Math]::Max(1, [int][Math]::Floor($maximumLength * 0.15))
  return (Get-AutoReplyVisualEditDistance $expected $observed) -le $maximumDistance
}

function Resolve-AutoReplyVisualMessageText([string]$sidebarPreview, [string]$bubbleText) {
  $preview = Normalize-AutoReplyVisualText $sidebarPreview
  $bubble = Normalize-AutoReplyVisualText $bubbleText
  if (-not $bubble) { return $preview }
  if (-not $preview -or $preview -match "(?:\.\.\.|…)$" -or $preview -match "^\[草稿\]") { return $bubble }
  if ($preview -ceq $bubble) { return $bubble }
  $maximumLength = [Math]::Max($preview.Length, $bubble.Length)
  if ([Math]::Min($preview.Length, $bubble.Length) -lt 6 -or [Math]::Abs($preview.Length - $bubble.Length) -gt 2) { return $bubble }
  if ($preview.Substring(0, 2) -cne $bubble.Substring(0, 2) -or
      $preview.Substring($preview.Length - 2) -cne $bubble.Substring($bubble.Length - 2)) { return $bubble }
  $maximumDistance = [Math]::Max(1, [int][Math]::Floor($maximumLength * 0.25))
  if ((Get-AutoReplyVisualEditDistance $preview $bubble) -le $maximumDistance) { return $preview }
  return $bubble
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

function Resolve-AutoReplyVisualAllowedConversation([string]$observed, $allowedSet) {
  $observed = Normalize-AutoReplyVisualText $observed
  if (-not $observed) { return @{ ok = $false; ambiguous = $false; conversation = ""; observed = "" } }
  $exactMatches = @($allowedSet | Where-Object {
    (Normalize-AutoReplyVisualText ([string]$_)) -ceq $observed
  })
  if ($exactMatches.Count -eq 1) {
    return @{ ok = $true; ambiguous = $false; conversation = [string]$exactMatches[0]; observed = $observed; exact = $true }
  }
  if ($exactMatches.Count -gt 1) {
    return @{ ok = $false; ambiguous = $true; conversation = ""; observed = $observed; exact = $false }
  }
  $fuzzyMatches = @($allowedSet | Where-Object {
    Test-AutoReplyVisualConversationMatch ([string]$_) $observed
  })
  if ($fuzzyMatches.Count -eq 1) {
    return @{ ok = $true; ambiguous = $false; conversation = [string]$fuzzyMatches[0]; observed = $observed; exact = $false }
  }
  return @{
    ok = $false
    ambiguous = $fuzzyMatches.Count -gt 1
    conversation = ""
    observed = $observed
    exact = $false
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
  if (-not $lineText.StartsWith($name, [StringComparison]::Ordinal)) {
    return Test-AutoReplyVisualConversationMatch $name $lineText
  }
  $suffix = $lineText.Substring($name.Length)
  return -not $suffix -or (Test-AutoReplyVisualTimeText $suffix)
}

function Resolve-AutoReplyVisualSidebarConversation([string]$observed, $allowedSet) {
  $observed = Normalize-AutoReplyVisualText $observed
  if (-not $observed) { return @{ ok = $false; ambiguous = $false; conversation = ""; observed = "" } }
  $strongMatches = @($allowedSet | Where-Object {
    $name = Normalize-AutoReplyVisualText ([string]$_)
    if (-not $observed.StartsWith($name, [StringComparison]::Ordinal)) { return $false }
    $suffix = $observed.Substring($name.Length)
    return -not $suffix -or (Test-AutoReplyVisualTimeText $suffix)
  })
  if ($strongMatches.Count -eq 1) {
    $conversation = Normalize-AutoReplyVisualText ([string]$strongMatches[0])
    return @{ ok = $true; ambiguous = $false; conversation = $conversation; observed = $conversation; exact = $true }
  }
  if ($strongMatches.Count -gt 1) {
    return @{ ok = $false; ambiguous = $true; conversation = ""; observed = $observed; exact = $false }
  }
  $fuzzyMatches = @($allowedSet | Where-Object {
    Test-AutoReplyVisualSidebarNameLine $observed ([string]$_)
  })
  if ($fuzzyMatches.Count -eq 1) {
    return @{ ok = $true; ambiguous = $false; conversation = [string]$fuzzyMatches[0]; observed = $observed; exact = $false }
  }
  return @{
    ok = $false
    ambiguous = $fuzzyMatches.Count -gt 1
    conversation = ""
    observed = $observed
    exact = $false
  }
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
  # Dark mode, custom contrast and some GPU paths do not expose the light
  # separator reliably. Fall back to the normalized chat/editor split instead
  # of blocking the whole listener; role geometry and bubble-color evidence
  # remain authoritative for the candidate itself.
  return @{
    ok = $true
    bottom = [double][Math]::Max((Scale-AutoReplyVisualMetric 220.0), [Math]::Min($frame.height - (Scale-AutoReplyVisualMetric 100.0), $frame.height * 0.74))
    dividerY = -1.0
    source = "normalized_window_ratio"
  }
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

function Test-AutoReplyVisualSelectedSidebarRow($frame, $nameBounds, $previewBounds, [double]$sidebarRight) {
  # The right edge of a selected conversation row is a broad green strip and
  # contains neither avatar artwork nor message text. It remains observable even
  # when title OCR is empty, which is common on GPU-rendered WeChat windows.
  $top = [Math]::Max(0.0, [double]$nameBounds.top - (Scale-AutoReplyVisualMetric 8.0))
  $bottom = [Math]::Min([double]$frame.height, [double]$previewBounds.top + [double]$previewBounds.height + (Scale-AutoReplyVisualMetric 8.0))
  $rect = @{
    left = [Math]::Max(0.0, $sidebarRight - (Scale-AutoReplyVisualMetric 20.0))
    top = $top
    width = Scale-AutoReplyVisualMetric 12.0
    height = [Math]::Max(1.0, $bottom - $top)
  }
  return (Get-AutoReplyVisualGreenRatio $frame $rect) -ge 0.55
}

function Get-AutoReplyVisualSidebarRows($frame, $lines, $allowedSet, [double]$sidebarRight) {
  $nameMatches = New-Object System.Collections.Generic.List[object]
  foreach ($line in $lines) {
    $left = [double]$line.bounds.left; $top = [double]$line.bounds.top
    $right = $left + [double]$line.bounds.width
    if ($left -lt (Scale-AutoReplyVisualMetric 42.0) -or $right -gt ($sidebarRight + (Scale-AutoReplyVisualMetric 8.0)) -or $top -lt (Scale-AutoReplyVisualMetric 72.0) -or $top -gt ($frame.height - (Scale-AutoReplyVisualMetric 42.0))) { continue }
    $resolvedName = Resolve-AutoReplyVisualSidebarConversation ([string]$line.compact) $allowedSet
    if ($resolvedName.ambiguous) {
      # One physical OCR row must never become two logical contacts. This is
      # the critical difference between OCR tolerance and recipient identity.
      return @{ ok = $false; reason = "visual_sidebar_match_ambiguous"; rows = @() }
    }
    if ($resolvedName.ok) {
      [void]$nameMatches.Add([pscustomobject]@{
        name = [string]$resolvedName.conversation
        observed = [string]$resolvedName.observed
        line = $line
        discovered = $false
        exact = [bool]$resolvedName.exact
      })
    }
  }
  # Do not turn an arbitrary unread title into a new whitelist entry. Contact
  # sync is the authority for one-to-one sessions; an unknown red dot may be a
  # group, service account or system chat and is observation-only.
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
    $unread = [bool](Test-AutoReplyVisualUnreadDot $frame $nameLine.bounds)
    if ($previewCandidates.Count -eq 0) {
      # Exact allowlist identity plus WeChat's geometric red badge is enough to
      # locate the row. Content is accepted only after the latest open-chat
      # bubble is independently proven to be customer-authored.
      if (-not [bool]$match.exact -or -not $unread) { continue }
      $previewLine = [pscustomobject]@{
        compact = ""
        bounds = @{
          left = [double]$nameLine.bounds.left
          top = [double]$nameLine.bounds.top + [double]$nameLine.bounds.height + (Scale-AutoReplyVisualMetric 2.0)
          width = [Math]::Max((Scale-AutoReplyVisualMetric 24.0), [double]$nameLine.bounds.width)
          height = Scale-AutoReplyVisualMetric 18.0
        }
      }
      $preview = ""
    } else {
      $previewLine = $previewCandidates[0]
      $preview = Normalize-AutoReplyVisualText ([string]$previewLine.compact)
      if (-not (Test-AutoReplyVisualPureText $preview)) { continue }
    }
    $isDraft = $preview -match "^\[?草稿\]?[：:]?"
    [void]$rows.Add([pscustomobject]@{
      conversation = [string]$match.name
      conversationEvidence = [string]$match.observed
      preview = $preview
      signature = Get-AutoReplyVisualSha256 $(if ($preview) { $preview } else { "visual-preview-missing-v1" })
      unread = $unread
      draft = [bool]$isDraft
      selected = [bool](Test-AutoReplyVisualSelectedSidebarRow $frame $nameLine.bounds $previewLine.bounds $sidebarRight)
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

function Get-AutoReplyVisualBoundaryText($boundaries, [string]$conversation, [string]$field) {
  if ($boundaries -eq $null) { return "" }
  foreach ($property in $boundaries.PSObject.Properties) {
    if ($property.Name -cne $conversation) { continue }
    $value = $property.Value
    if ($value -is [string]) { return Normalize-AutoReplyVisualText ([string]$value) }
    if ($value -ne $null -and $value.PSObject.Properties.Name -contains $field) {
      return Normalize-AutoReplyVisualText ([string]$value.$field)
    }
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

function Get-AutoReplyVisualBitmapBytes($bitmap, [int]$width, [int]$height) {
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
    return @{ ok = $true; bytes = $bytes; stride = $stride }
  } catch {
    return @{ ok = $false; reason = "visual_capture_failed" }
  }
}

function Test-AutoReplyVisualFrameContent($bytes, [int]$stride, [int]$width, [int]$height) {
  if ($null -eq $bytes -or $bytes.Length -lt ($stride * $height) -or $width -lt 1 -or $height -lt 1) { return $false }
  $stepX = [Math]::Max(1, [int][Math]::Floor($width / 32.0))
  $stepY = [Math]::Max(1, [int][Math]::Floor($height / 24.0))
  $samples = 0; $opaque = 0; $minimumLuma = 255; $maximumLuma = 0
  $colors = [System.Collections.Generic.HashSet[int]]::new()
  for ($y = [int][Math]::Floor($stepY / 2.0); $y -lt $height; $y += $stepY) {
    for ($x = [int][Math]::Floor($stepX / 2.0); $x -lt $width; $x += $stepX) {
      $offset = ($y * $stride) + ($x * 4)
      if ($offset + 3 -ge $bytes.Length) { continue }
      $blue = [int]$bytes[$offset]; $green = [int]$bytes[$offset + 1]; $red = [int]$bytes[$offset + 2]; $alpha = [int]$bytes[$offset + 3]
      $samples += 1
      if ($alpha -ge 128) { $opaque += 1 }
      $luma = [int][Math]::Round(($red * 0.299) + ($green * 0.587) + ($blue * 0.114))
      $minimumLuma = [Math]::Min($minimumLuma, $luma); $maximumLuma = [Math]::Max($maximumLuma, $luma)
      [void]$colors.Add((([int]($red / 16)) -shl 8) -bor (([int]($green / 16)) -shl 4) -bor [int]($blue / 16))
    }
  }
  return $samples -ge 16 -and $opaque -ge [int][Math]::Ceiling($samples * 0.60) -and
    ($maximumLuma - $minimumLuma) -ge 8 -and $colors.Count -ge 3
}

function New-AutoReplyVisualPrintWindowFrame([IntPtr]$hWnd, [int]$width, [int]$height) {
  $bitmap = $null; $graphics = $null; $hdc = [IntPtr]::Zero
  try {
    $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $hdc = $graphics.GetHdc()
    # PW_RENDERFULLCONTENT asks compositor-backed windows (including WeChat
    # 4.x) for their HWND contents instead of copying whichever app happens to
    # cover them on the desktop.
    $printed = [Win32WechatAutoReplyVisual]::PrintWindow($hWnd, $hdc, 2)
    $graphics.ReleaseHdc($hdc); $hdc = [IntPtr]::Zero
    $graphics.Dispose(); $graphics = $null
    if (-not $printed) { $bitmap.Dispose(); return @{ ok = $false; reason = "visual_capture_failed" } }
    $data = Get-AutoReplyVisualBitmapBytes $bitmap $width $height
    if (-not $data.ok -or -not (Test-AutoReplyVisualFrameContent $data.bytes ([int]$data.stride) $width $height)) {
      $bitmap.Dispose()
      return @{ ok = $false; reason = "visual_capture_failed" }
    }
    return @{ ok = $true; bitmap = $bitmap; bytes = $data.bytes; stride = [int]$data.stride; width = $width; height = $height; captureMethod = "hwnd_printwindow" }
  } catch {
    if ($bitmap) { $bitmap.Dispose() }
    return @{ ok = $false; reason = "visual_capture_failed" }
  } finally {
    if ($hdc -ne [IntPtr]::Zero -and $graphics) { try { $graphics.ReleaseHdc($hdc) } catch {} }
    if ($graphics) { $graphics.Dispose() }
  }
}

function New-AutoReplyVisualScreenFrame([IntPtr]$hWnd, $windowRect, [int]$width, [int]$height, [bool]$allowForegroundFallback) {
  $previousForeground = [Win32WechatMomentsVisualReadOnly]::GetForegroundWindow()
  $restoreForeground = $previousForeground -ne $hWnd
  if ($restoreForeground) {
    if (-not $allowForegroundFallback) { return @{ ok = $false; reason = "visual_capture_failed" } }
    [void][Win32WechatMomentsVisualReadOnly]::ShowWindowAsync($hWnd, 9)
    [void][Win32WechatMomentsVisualReadOnly]::SetForegroundWindow($hWnd)
    Start-Sleep -Milliseconds 90
    if ([Win32WechatMomentsVisualReadOnly]::GetForegroundWindow() -ne $hWnd) {
      if ($previousForeground -ne [IntPtr]::Zero -and [Win32WechatAutoReplyVisual]::IsWindow($previousForeground)) {
        [void][Win32WechatMomentsVisualReadOnly]::SetForegroundWindow($previousForeground)
      }
      return @{ ok = $false; reason = "wechat_focus_failed" }
    }
  }
  $bitmap = $null; $graphics = $null
  try {
    $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen([int]$windowRect.Left, [int]$windowRect.Top, 0, 0, [System.Drawing.Size]::new($width, $height), [System.Drawing.CopyPixelOperation]::SourceCopy)
    $graphics.Dispose(); $graphics = $null
    $data = Get-AutoReplyVisualBitmapBytes $bitmap $width $height
    if (-not $data.ok -or -not (Test-AutoReplyVisualFrameContent $data.bytes ([int]$data.stride) $width $height)) {
      $bitmap.Dispose()
      return @{ ok = $false; reason = "visual_capture_failed" }
    }
    return @{ ok = $true; bitmap = $bitmap; bytes = $data.bytes; stride = [int]$data.stride; width = $width; height = $height; captureMethod = "foreground_screen" }
  } catch {
    if ($bitmap) { $bitmap.Dispose() }
    return @{ ok = $false; reason = "visual_capture_failed" }
  } finally {
    if ($graphics) { $graphics.Dispose() }
    if ($restoreForeground -and $previousForeground -ne [IntPtr]::Zero -and
        [Win32WechatAutoReplyVisual]::IsWindow($previousForeground)) {
      # A periodic live freshness check may briefly focus WeChat. Put the user
      # back where they were; Windows may reject the request, so this is best-effort.
      [void][Win32WechatMomentsVisualReadOnly]::SetForegroundWindow($previousForeground)
    }
  }
}

function Get-AutoReplyVisualFrame([IntPtr]$hWnd, $windowRect, [int]$expectedProcessId, [bool]$allowForegroundFallback = $false) {
  if (-not [Win32WechatMomentsVisualReadOnly]::IsWindowVisible($hWnd) -or [Win32WechatMomentsVisualReadOnly]::IsIconic($hWnd)) {
    return @{ ok = $false; reason = "wechat_window_missing" }
  }
  $width = [int]($windowRect.Right - $windowRect.Left); $height = [int]($windowRect.Bottom - $windowRect.Top)
  if ($width -lt 1 -or $height -lt 1) { return @{ ok = $false; reason = "wechat_window_not_ready" } }
  $forceScreenCapture = [Environment]::GetEnvironmentVariable("XIAOXI_FORCE_SCREEN_CAPTURE") -ceq "1"
  if (-not $forceScreenCapture) {
    $printed = New-AutoReplyVisualPrintWindowFrame $hWnd $width $height
    if ($printed.ok) { return $printed }
  }
  # Screen-copy is allowed without focus only when WeChat is already foreground.
  # A focus-changing fallback is reserved for an opened unread transaction or
  # an explicit verify/recover pass; passive five-second polling never steals it.
  return New-AutoReplyVisualScreenFrame $hWnd $windowRect $width $height $allowForegroundFallback
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

function Get-AutoReplyVisualHeaderCandidates($lines, [double]$sidebarRight, [double]$frameWidth) {
  $parts = @($lines | Where-Object {
    $text = Normalize-AutoReplyVisualText ([string]$_.compact)
    $text -and $text.Length -le 64 -and -not (Test-AutoReplyVisualTimeText $text) -and
      [double]$_.bounds.left -ge ($sidebarRight + (Scale-AutoReplyVisualMetric 8.0)) -and
      [double]$_.bounds.left -lt ($frameWidth - (Scale-AutoReplyVisualMetric 80.0)) -and
      [double]$_.bounds.top -ge (Scale-AutoReplyVisualMetric 20.0) -and
      [double]$_.bounds.top -le (Scale-AutoReplyVisualMetric 92.0)
  })
  if ($parts.Count -eq 0) { return @() }
  # OCR engines may split a single title into adjacent fragments. Merge parts
  # on the same text row, but never guess between two distinct header rows.
  return @(Get-AutoReplyVisualMessageRows $parts | Where-Object {
    $text = Normalize-AutoReplyVisualText ([string]$_.compact)
    $text -and $text.Length -le 64 -and
      [double]$_.bounds.left -lt ($sidebarRight + (Scale-AutoReplyVisualMetric 360.0))
  } | Sort-Object { [double]$_.bounds.top }, { [double]$_.bounds.left })
}

function Get-AutoReplyVisualHeaderDiagnostics($candidates) {
  $hashes = @($candidates | ForEach-Object {
    Get-AutoReplyVisualSha256 (Normalize-AutoReplyVisualText ([string]$_.compact))
  })
  return @{ headerCandidateCount = @($candidates).Count; headerCandidateHashes = $hashes }
}

function Get-AutoReplyVisualHeader($lines, [string]$conversation, [double]$sidebarRight, [double]$frameWidth, $allowedSet) {
  $candidates = @(Get-AutoReplyVisualHeaderCandidates $lines $sidebarRight $frameWidth)
  $diagnostics = Get-AutoReplyVisualHeaderDiagnostics $candidates
  $ambiguousMatch = $false
  $matches = @($candidates | Where-Object {
    $resolved = Resolve-AutoReplyVisualAllowedConversation ([string]$_.compact) $allowedSet
    if ($resolved.ambiguous) { $ambiguousMatch = $true }
    $resolved.ok -and [string]$resolved.conversation -ceq (Normalize-AutoReplyVisualText $conversation)
  })
  if ($matches.Count -eq 1) {
    return @{
      ok = $true
      state = "matched"
      line = $matches[0]
      observed = Normalize-AutoReplyVisualText ([string]$matches[0].compact)
      headerCandidateCount = [int]$diagnostics.headerCandidateCount
      headerCandidateHashes = @($diagnostics.headerCandidateHashes)
    }
  }
  if ($ambiguousMatch -or $matches.Count -gt 1 -or $candidates.Count -ne 1) {
    return @{
      ok = $false
      state = "unresolved"
      reason = "conversation_title_unresolved"
      headerCandidateCount = [int]$diagnostics.headerCandidateCount
      headerCandidateHashes = @($diagnostics.headerCandidateHashes)
    }
  }
  $expected = Normalize-AutoReplyVisualText $conversation
  $observed = Normalize-AutoReplyVisualText ([string]$candidates[0].compact)
  # A short title or a near OCR alias cannot prove that WeChat switched chats.
  # Only one clearly different, sufficiently long title is a real mismatch.
  $maximumLength = [Math]::Max($expected.Length, $observed.Length)
  $distance = Get-AutoReplyVisualEditDistance $expected $observed
  $clearlyDifferent = [Math]::Min($expected.Length, $observed.Length) -ge 4 -and
    $maximumLength -gt 0 -and ([double]$distance / [double]$maximumLength) -ge 0.55
  return @{
    ok = $false
    state = if ($clearlyDifferent) { "different" } else { "unresolved" }
    reason = if ($clearlyDifferent) { "conversation_title_mismatch" } else { "conversation_title_unresolved" }
    headerCandidateCount = 1
    headerCandidateHashes = @($diagnostics.headerCandidateHashes)
    observedHeaderHash = Get-AutoReplyVisualSha256 $observed
  }
}

function Get-AutoReplyVisualAnyHeader($lines, [double]$sidebarRight, [double]$frameWidth) {
  $candidates = @(Get-AutoReplyVisualHeaderCandidates $lines $sidebarRight $frameWidth)
  $diagnostics = Get-AutoReplyVisualHeaderDiagnostics $candidates
  if ($candidates.Count -ne 1) {
    return @{
      ok = $false
      state = "unresolved"
      reason = "conversation_title_unresolved"
      headerCandidateCount = [int]$diagnostics.headerCandidateCount
      headerCandidateHashes = @($diagnostics.headerCandidateHashes)
    }
  }
  return @{
    ok = $true
    state = "matched"
    conversation = Normalize-AutoReplyVisualText ([string]$candidates[0].compact)
    line = $candidates[0]
    headerCandidateCount = 1
    headerCandidateHashes = @($diagnostics.headerCandidateHashes)
  }
}

function Get-AutoReplyVisualCurrentConversation($lines, $allowedSet, [double]$sidebarRight, [double]$frameWidth) {
  $matches = New-Object System.Collections.Generic.List[object]
  foreach ($line in $lines) {
    if ([double]$line.bounds.left -lt ($sidebarRight + (Scale-AutoReplyVisualMetric 8.0)) -or
        [double]$line.bounds.left -ge ($frameWidth - (Scale-AutoReplyVisualMetric 20.0)) -or
        [double]$line.bounds.top -lt (Scale-AutoReplyVisualMetric 20.0) -or [double]$line.bounds.top -gt (Scale-AutoReplyVisualMetric 108.0)) { continue }
    $resolved = Resolve-AutoReplyVisualAllowedConversation ([string]$line.compact) $allowedSet
    if ($resolved.ambiguous) { return @{ ok = $false; reason = "current_conversation_ambiguous" } }
    if ($resolved.ok) { [void]$matches.Add([pscustomobject]@{ conversation = [string]$resolved.conversation; observed = [string]$resolved.observed }) }
  }
  $unique = @($matches.ToArray() | Group-Object conversation | ForEach-Object { $_.Group[0] })
  if ($unique.Count -eq 0) { return @{ ok = $true; active = $false; conversation = "" } }
  if ($unique.Count -ne 1) { return @{ ok = $false; reason = "current_conversation_ambiguous" } }
  return @{ ok = $true; active = $true; conversation = [string]$unique[0].conversation; conversationEvidence = [string]$unique[0].observed }
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
  $semanticSeed = [string]::Join([char]10, @(
    "visual-message-semantic-v1",
    $message,
    $latestRole
  ))
  $diagnosticSeed = [string]::Join([char]10, @(
    $message,
    $latestRole,
    ("w:{0}" -f $bubbleWidthBucket),
    ("h:{0}" -f $bubbleHeightBucket),
    $pixelHash
  ))
  return @{
    ok = $true
    hasMessage = $true
    message = $message
    line = $latest
    pixelHash = $pixelHash
    latestRole = $latestRole
    # This is the occurrence identity used across scans. It intentionally does
    # not include pixels or bounding boxes, which drift with DPI and reflow.
    evidenceSignature = Get-AutoReplyVisualSha256 $semanticSeed
    diagnosticSignature = Get-AutoReplyVisualSha256 $diagnosticSeed
    bubbleBounds = $latest.bounds
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
  if ($firstSignature -notmatch "^[a-f0-9]{64}$" -or $secondSignature -notmatch "^[a-f0-9]{64}$") { return $false }
  return $firstSignature -ceq $secondSignature -or
    (Test-AutoReplyVisualMessageMatch ([string]$first.message) ([string]$second.message))
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
  # The chat bubble is the message source of truth. Sidebar preview OCR is only
  # a wake-up/location hint and may update before or after the chat surface.
  return $previousMessageSignature -match "^[a-f0-9]{64}$" -and
    $currentMessageSignature -match "^[a-f0-9]{64}$" -and
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
  if (-not (Test-AutoReplyVisualSignature $previousMessageSignature) -or
      $first -eq $null -or -not $first.ok) {
    return @{ action = "unresolved"; reason = "current_transition_unresolved"; detail = "first_frame_invalid" }
  }
  $firstPreviewSignature = [string]$first.previewSignature
  $firstMessageSignature = [string]$first.messageSignature
  if (-not (Test-AutoReplyVisualSignature $firstMessageSignature)) {
    return @{ action = "unresolved"; reason = "current_transition_unresolved"; detail = "first_frame_identity_invalid" }
  }
  $messageChanged = $previousMessageSignature -cne $firstMessageSignature
  if (-not $messageChanged) { return @{ action = "none" } }
  if ($second -eq $null -or -not $second.ok) {
    return @{ action = "unresolved"; reason = "current_transition_unresolved"; detail = "second_frame_invalid" }
  }
  $secondPreviewSignature = [string]$second.previewSignature
  $secondMessageSignature = [string]$second.messageSignature
  if (-not (Test-AutoReplyVisualSignature $secondMessageSignature) -or
      [string]$first.conversation -cne [string]$second.conversation) {
    return @{ action = "unresolved"; reason = "current_transition_unresolved"; detail = "second_frame_unstable" }
  }
  $sameRole = $first.hasMessage -and $second.hasMessage -and
    [string]$first.latestRole -ceq [string]$second.latestRole
  $similarMessage = $sameRole -and
    (Test-AutoReplyVisualMessageMatch ([string]$first.message) ([string]$second.message))
  if ($firstMessageSignature -cne $secondMessageSignature -and -not $similarMessage) {
    # Immediately after a verified send, WeChat can reflow the green outgoing
    # bubble for more than one capture interval. Two independent assistant-role
    # frames prove this is not customer input, so wait for the visual boundary
    # to settle instead of pausing the listener. Never advance an unstable hash.
    if ($first.hasMessage -and $second.hasMessage -and
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

  # A real current-open incoming transition must be a stable customer bubble.
  # Draft/preview state is not part of its identity.
  if (-not $first.hasMessage -or -not $second.hasMessage -or
      [string]$first.latestRole -cne [string]$second.latestRole) {
    return @{ action = "unresolved"; reason = "current_transition_unresolved"; detail = "message_evidence_invalid" }
  }
  $stableMessage = Resolve-AutoReplyVisualMessageText ([string]$first.message) ([string]$second.message)
  $stableMessageSignature = $secondMessageSignature
  if ($firstMessageSignature -cne $secondMessageSignature) {
    $stableMessageSeed = [string]::Join([char]10, @(
      "visual-message-semantic-v1",
      $stableMessage,
      [string]$second.latestRole
    ))
    $stableMessageSignature = Get-AutoReplyVisualSha256 $stableMessageSeed
  }
  if ([string]$second.latestRole -ceq "user") {
    return @{
      action = "candidate"
      conversation = [string]$second.conversation
      message = $stableMessage
      messageSignature = $stableMessageSignature
    }
  }
  if ([string]$second.latestRole -ceq "assistant") {
    $resolved = @{
      action = "boundary"
      reason = "latest_message_not_incoming"
      conversation = [string]$second.conversation
      latestRole = "assistant"
      message = $stableMessage
      messageSignature = $stableMessageSignature
      messageBaselineAdvance = @{ conversation = [string]$second.conversation; signature = $stableMessageSignature }
    }
    if (Test-AutoReplyVisualSignature $secondPreviewSignature) {
      $resolved["baselineAdvance"] = @{ conversation = [string]$second.conversation; signature = $secondPreviewSignature }
    }
    return $resolved
  }
  return @{ action = "unresolved"; reason = "current_transition_unresolved"; detail = "latest_role_unresolved" }
}

function Get-AutoReplyVisualObservation([IntPtr]$hWnd, [int]$expectedProcessId, $windowRect, [bool]$allowForegroundFallback = $false) {
  $frame = Get-AutoReplyVisualFrame $hWnd $windowRect $expectedProcessId $allowForegroundFallback
  if (-not $frame.ok) { return @{ ok = $false; reason = [string]$frame.reason } }
  $script:AutoReplyVisualCaptureMethod = [string]$frame.captureMethod
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
  # This second frame is requested only after the passive frame proved that the
  # current message changed, so a short focus fallback is justified if HWND
  # capture is unavailable on this specific Windows build.
  $observation = Get-AutoReplyVisualObservation $hWnd $expectedProcessId $windowRect $true
  if (-not $observation.ok) { return @{ ok = $false; reason = [string]$observation.reason } }
  $frame = $observation.frame
  try {
    $sidebar = Get-AutoReplyVisualSidebarRows $frame $observation.lines $allowedSet $sidebarRight
    $header = Get-AutoReplyVisualHeader $observation.lines $expectedConversation $sidebarRight ([double]$frame.width) $allowedSet
    # A compositor-only WeChat window can omit its title from one OCR frame.
    # That is uncertainty, not proof that the chat changed. Only an explicitly
    # different title blocks the already-bound HWND + conversation observation.
    if (-not $header.ok -and [string]$header.state -eq "different") {
      return @{
        ok = $false
        reason = [string]$header.reason
        headerState = [string]$header.state
        headerCandidateCount = [int]$header.headerCandidateCount
        headerCandidateHashes = @($header.headerCandidateHashes)
      }
    }
    $matchingRows = if ($sidebar.ok) { @($sidebar.rows | Where-Object { Test-AutoReplyVisualConversationMatch $expectedConversation ([string]$_.conversation) }) } else { @() }
    $latest = Get-AutoReplyVisualLatestMessageEvidence $frame $observation.lines $sidebarRight
    if (-not $latest.ok) { return @{ ok = $false; reason = [string]$latest.reason } }
    return @{
      ok = $true
      conversation = $expectedConversation
      conversationEvidence = if ($matchingRows.Count -eq 1) { [string]$matchingRows[0].conversationEvidence } elseif ($header.ok) { [string]$header.observed } else { $expectedConversation }
      previewSignature = if ($matchingRows.Count -eq 1) { [string]$matchingRows[0].signature } else { "" }
      draft = if ($matchingRows.Count -eq 1) { [bool]$matchingRows[0].draft } else { $false }
      sidebarRowCount = $matchingRows.Count
      hasMessage = [bool]$latest.hasMessage
      message = [string]$latest.message
      latestRole = [string]$latest.latestRole
      messageSignature = [string]$latest.evidenceSignature
      messageDiagnosticSignature = [string]$latest.diagnosticSignature
      headerState = [string]$header.state
      headerCandidateCount = [int]$header.headerCandidateCount
      headerCandidateHashes = @($header.headerCandidateHashes)
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
try { $startupPreviewBoundaries = [Environment]::GetEnvironmentVariable("XIAOXI_STARTUP_PREVIEWS") | ConvertFrom-Json } catch { $startupPreviewBoundaries = $null }
try { $startupMessageBoundaries = [Environment]::GetEnvironmentVariable("XIAOXI_STARTUP_MESSAGES") | ConvertFrom-Json } catch { $startupMessageBoundaries = $null }
try { $startupUnreadBoundaries = [Environment]::GetEnvironmentVariable("XIAOXI_STARTUP_UNREAD_BOUNDARIES") | ConvertFrom-Json } catch { $startupUnreadBoundaries = $null }
$expectedConversation = Normalize-AutoReplyVisualText ([Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_CONVERSATION"))
$expectedMessage = Normalize-AutoReplyVisualText ([Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_MESSAGE"))
$expectedRuntimeId = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_RUNTIME_ID")
$expectedPreviewSignature = ([string][Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PREVIEW_SIGNATURE")).Trim().ToLowerInvariant()
$expectedMessageSignature = ([string][Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_MESSAGE_SIGNATURE")).Trim().ToLowerInvariant()
try { $expectedPid = [int][Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID") } catch { $expectedPid = 0 }
try { $expectedHWnd = [int64][Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_HWND") } catch { $expectedHWnd = 0 }

$resolvedWindow = Resolve-AutoReplyVisualWechatWindow $expectedPid $expectedHWnd
if (-not $resolvedWindow.ok) {
  Write-AutoReplyVisualResult @{
    ok = $false
    reason = [string]$resolvedWindow.reason
    pid = [int]$resolvedWindow.pid
    hWnd = [int64]$resolvedWindow.hWnd
    windowCandidateCount = [int]$resolvedWindow.candidateCount
  }
}
$process = $resolvedWindow.process
$hWnd = [IntPtr]$resolvedWindow.hWnd
if ($expectedPid -gt 0 -and $expectedPid -ne [int]$process.Id) { Write-AutoReplyVisualResult @{ ok = $false; reason = "wechat_process_changed"; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
if ($expectedHWnd -gt 0 -and $expectedHWnd -ne [int64]$hWnd) { Write-AutoReplyVisualResult @{ ok = $false; reason = "wechat_window_changed"; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
$nativeWindowRect = New-Object Win32WechatAutoReplyVisual+RECT
if (-not [Win32WechatAutoReplyVisual]::GetWindowRect($hWnd, [ref]$nativeWindowRect)) {
  Write-AutoReplyVisualResult @{ ok = $false; reason = "wechat_window_not_ready" }
}
$windowRect = [pscustomobject]@{
  Left = [double]$nativeWindowRect.Left
  Top = [double]$nativeWindowRect.Top
  Right = [double]$nativeWindowRect.Right
  Bottom = [double]$nativeWindowRect.Bottom
  Width = [double]($nativeWindowRect.Right - $nativeWindowRect.Left)
  Height = [double]($nativeWindowRect.Bottom - $nativeWindowRect.Top)
}
if ($windowRect.Width -lt 600 -or $windowRect.Height -lt 500) { Write-AutoReplyVisualResult @{ ok = $false; reason = "wechat_window_not_ready" } }

$windowDpi = [double]96
try {
  $reportedDpi = [Win32WechatAutoReplyVisual]::GetDpiForWindow($hWnd)
  if ($reportedDpi -ge 72 -and $reportedDpi -le 480) { $windowDpi = [double]$reportedDpi }
} catch {}
$script:AutoReplyVisualScale = [Math]::Min(4.0, [Math]::Max(0.5, $windowDpi / 96.0))
$sidebarRight = Get-AutoReplyVisualSidebarRight ([double]$windowRect.Width) $windowDpi
$script:AutoReplyVisualWindow = @{
  x = [int][Math]::Round($windowRect.Left)
  y = [int][Math]::Round($windowRect.Top)
  width = [int][Math]::Round($windowRect.Width)
  height = [int][Math]::Round($windowRect.Height)
  sidebarRight = [int][Math]::Round($sidebarRight)
}
$script:AutoReplyVisualDpi = [int][Math]::Round($windowDpi)
$allowInitialFocusFallback = $mode -eq "verify" -or $mode -eq "recover" -or
  [Environment]::GetEnvironmentVariable("XIAOXI_ALLOW_FOCUS_FALLBACK") -ceq "1"
$observation = Get-AutoReplyVisualObservation $hWnd ([int]$process.Id) $windowRect $allowInitialFocusFallback
if (-not $observation.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$observation.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
$frame = $observation.frame
try {
  $sidebar = Get-AutoReplyVisualSidebarRows $frame $observation.lines $allowedSet $sidebarRight
  if (-not $sidebar.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$sidebar.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
  $rows = @($sidebar.rows)
  $currentConversationDiscovered = $false
  $currentConversation = Get-AutoReplyVisualCurrentConversation $observation.lines $allowedSet $sidebarRight ([double]$frame.width)
  if (-not $currentConversation.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$currentConversation.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
  if (-not $currentConversation.active) {
    $selectedRows = @($rows | Where-Object { [bool]$_.selected })
    if ($selectedRows.Count -eq 1) {
      $currentConversation = @{
        ok = $true
        active = $true
        conversation = [string]$selectedRows[0].conversation
        conversationEvidence = [string]$selectedRows[0].conversationEvidence
        source = "selected_sidebar_row"
      }
    }
  }
  if ([string]$frame.captureMethod -ceq "hwnd_printwindow" -and $rows.Count -eq 0 -and -not $currentConversation.active) {
    # PrintWindow can report success while DirectComposition returns only the
    # non-client shell. Force one real foreground capture before concluding
    # that there is no usable sidebar/current-session structure.
    Write-AutoReplyVisualResult @{ ok = $false; reason = "visual_ocr_structure_missing"; pid = [int]$process.Id; hWnd = [int64]$hWnd }
  }
  $sessionBaselines = @($rows | ForEach-Object { @{
    conversation = [string]$_.conversation
    signature = [string]$_.signature
    preview = [string]$_.preview
    unread = [bool]$_.unread
  } })
  $currentMessage = $null
  $sessionMessageBaselines = @()
  if ($currentConversation.active) {
    $currentMessage = Get-AutoReplyVisualLatestMessageEvidence $frame $observation.lines $sidebarRight
    if (-not $currentMessage.ok) { Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$currentMessage.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd } }
    $sessionMessageBaselines = @(@{
      conversation = [string]$currentConversation.conversation
      signature = [string]$currentMessage.evidenceSignature
      message = [string]$currentMessage.message
      latestRole = [string]$currentMessage.latestRole
      diagnosticSignature = [string]$currentMessage.diagnosticSignature
    })
  }
  $currentResultConversation = if ($currentConversation.active) { [string]$currentConversation.conversation } else { "" }
  $currentResultLatestRole = if ($currentMessage -ne $null -and $currentMessage.hasMessage) { [string]$currentMessage.latestRole } else { "" }
  $currentResultMessageSignature = if ($currentMessage -ne $null) { [string]$currentMessage.evidenceSignature } else { "" }
  if ($mode -eq "prime") {
    Write-AutoReplyVisualResult @{
      ok = $true
      source = "session_prime"
      startupBoundarySupported = $true
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
        $expectedMessageSignature -notmatch "^[a-f0-9]{64}$") {
      Write-AutoReplyVisualResult @{ ok = $false; reason = "incoming_identity_missing" }
    }
    $header = Get-AutoReplyVisualHeader $observation.lines $expectedConversation $sidebarRight ([double]$frame.width) $allowedSet
    if (-not $header.ok -and [string]$header.state -eq "different") {
      Write-AutoReplyVisualResult @{ ok = $false; reason = "conversation_title_mismatch"; pid = [int]$process.Id; hWnd = [int64]$hWnd; headerState = "different"; headerCandidateCount = [int]$header.headerCandidateCount; headerCandidateHashes = @($header.headerCandidateHashes) }
    }
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
      headerState = [string]$header.state
      headerCandidateCount = [int]$header.headerCandidateCount
      headerCandidateHashes = @($header.headerCandidateHashes)
      context = @(@{ role = "user"; content = $recoveredMessage; key = $runtimeId })
    }
  }

  if ($mode -eq "verify") {
    if (-not $expectedConversation -or -not $expectedMessage -or -not $expectedRuntimeId -or
        $expectedMessageSignature -notmatch "^[a-f0-9]{64}$") { Write-AutoReplyVisualResult @{ ok = $false; reason = "incoming_message_missing" } }
    $header = Get-AutoReplyVisualHeader $observation.lines $expectedConversation $sidebarRight ([double]$frame.width) $allowedSet
    if (-not $header.ok -and [string]$header.state -eq "different") {
      Write-AutoReplyVisualResult @{ ok = $false; reason = "conversation_title_mismatch"; pid = [int]$process.Id; hWnd = [int64]$hWnd; headerState = "different"; headerCandidateCount = [int]$header.headerCandidateCount; headerCandidateHashes = @($header.headerCandidateHashes) }
    }
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
    $messageTextMatches = Test-AutoReplyVisualMessageMatch $expectedMessage ([string]$latest.message)
    if (-not $bubbleEvidenceMatches -and -not $messageTextMatches) {
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
      headerState = [string]$header.state
      headerCandidateCount = [int]$header.headerCandidateCount
      headerCandidateHashes = @($header.headerCandidateHashes)
      pid = [int]$process.Id
      hWnd = [int64]$hWnd
      source = "verify"
      latestRole = "user"
      context = @(@{ role = "user"; content = $expectedMessage; key = $runtimeId })
    }
  }

  $candidates = New-Object System.Collections.Generic.List[object]
  $suppressedStartupUnread = 0
  foreach ($row in $rows) {
    # OCR-only preview changes are not an event signal: small recognition jitter
    # previously caused a click on every scan. Background sessions require a
    # geometric unread badge; the already-open session uses message-area evidence.
    $startupPreview = Get-AutoReplyVisualBoundaryText $startupPreviewBoundaries ([string]$row.conversation) "preview"
    $newSinceStartupBoundary = $mode -cne "prime_confirm" -or
      ($startupPreview -and -not (Test-AutoReplyVisualMessageMatch $startupPreview ([string]$row.preview)))
    $historicalUnreadPreview = Get-AutoReplyVisualBoundaryText $startupUnreadBoundaries ([string]$row.conversation) "preview"
    $historicalUnreadSignature = (Get-AutoReplyVisualBoundaryText $startupUnreadBoundaries ([string]$row.conversation) "signature").ToLowerInvariant()
    $sameHistoricalUnread = (Test-AutoReplyVisualSignature $historicalUnreadSignature) -and
      ($historicalUnreadSignature -ceq [string]$row.signature -or
        ($historicalUnreadPreview -and (Test-AutoReplyVisualMessageMatch $historicalUnreadPreview ([string]$row.preview))))
    if ($row.unread -and $sameHistoricalUnread) { $suppressedStartupUnread += 1 }
    if ($row.unread -and -not $row.draft -and $newSinceStartupBoundary -and -not $sameHistoricalUnread) {
      $row | Add-Member -NotePropertyName source -NotePropertyValue "unread" -Force
      [void]$candidates.Add($row)
    }
  }
  # An unread dot that cannot be joined to an allowlisted row is diagnostic
  # only. It must not starve a new bubble in the already-open allowlisted chat.
  $unresolvedUnreadBadgeCount = 0
  if ($candidates.Count -eq 0 -and $suppressedStartupUnread -eq 0) {
    $badgeFallbacks = @(Get-AutoReplyVisualUnreadBadges $frame $sidebarRight)
    $unresolvedUnreadBadgeCount = $badgeFallbacks.Count
  }
  if ($candidates.Count -eq 0) {
    if ($currentConversation.active -and $currentMessage -ne $null) {
      $currentName = [string]$currentConversation.conversation
      $currentRow = @($rows | Where-Object { Test-AutoReplyVisualConversationMatch $currentName ([string]$_.conversation) })
      $previousPreviewSignature = Get-AutoReplyVisualBaseline $baselines $currentName
      $previousMessageSignature = Get-AutoReplyVisualBaseline $messageBaselines $currentName
      $currentPreviewSignature = if ($currentRow.Count -eq 1) { [string]$currentRow[0].signature } else { "" }
      $currentMessageSignature = [string]$currentMessage.evidenceSignature
      $startupMessage = Get-AutoReplyVisualBoundaryText $startupMessageBoundaries $currentName "message"
      $currentMessageChanged = $previousMessageSignature -cne $currentMessageSignature
      if ($mode -ceq "prime_confirm" -and $startupMessage -and
          (Test-AutoReplyVisualMessageMatch $startupMessage ([string]$currentMessage.message))) {
        $currentMessageChanged = $false
      }
      if ((Test-AutoReplyVisualSignature $previousMessageSignature) -and
          -not (Test-AutoReplyVisualSignature $currentMessageSignature)) {
        Write-AutoReplyVisualResult @{
          ok = $false
          reason = "current_transition_unresolved"
          transitionDetail = "current_message_identity_invalid"
          pid = [int]$process.Id
          hWnd = [int64]$hWnd
          conversation = $currentName
          sidebarRowCount = $currentRow.Count
        }
      }
      if ((Test-AutoReplyVisualSignature $previousMessageSignature) -and
          (Test-AutoReplyVisualSignature $currentMessageSignature) -and
          $currentMessageChanged) {
        $firstCurrentSnapshot = @{
          ok = $true
          conversation = $currentName
          previewSignature = $currentPreviewSignature
          draft = if ($currentRow.Count -eq 1) { [bool]$currentRow[0].draft } else { $false }
          hasMessage = [bool]$currentMessage.hasMessage
          message = [string]$currentMessage.message
          latestRole = [string]$currentMessage.latestRole
          messageSignature = $currentMessageSignature
          messageDiagnosticSignature = [string]$currentMessage.diagnosticSignature
          sidebarRowCount = $currentRow.Count
        }
        Start-Sleep -Milliseconds 140
        $secondCurrentSnapshot = Get-AutoReplyVisualCurrentTransitionSnapshot $hWnd ([int]$process.Id) $windowRect $allowedSet $sidebarRight $currentName
        $resolvedTransition = Resolve-AutoReplyVisualCurrentTransition $previousPreviewSignature $previousMessageSignature $firstCurrentSnapshot $secondCurrentSnapshot
        if ([string]$resolvedTransition.action -eq "unresolved") {
          Write-AutoReplyVisualResult @{
            ok = $false
            reason = "current_transition_unresolved"
            transitionDetail = [string]$resolvedTransition.detail
            nestedReason = [string]$secondCurrentSnapshot.reason
            pid = [int]$process.Id
            hWnd = [int64]$hWnd
            conversation = $currentName
            sidebarRowCount = $currentRow.Count
            latestRole = [string]$firstCurrentSnapshot.latestRole
            previewChanged = (Test-AutoReplyVisualSignature $previousPreviewSignature) -and $previousPreviewSignature -cne $currentPreviewSignature
            messageChanged = $true
          }
        }
        if ([string]$resolvedTransition.action -eq "boundary" -or
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
          if ($resolvedTransition.baselineAdvance -ne $null) { $transitionResult["baselineAdvance"] = $resolvedTransition.baselineAdvance }
          if ($resolvedTransition.messageBaselineAdvance -ne $null) { $transitionResult["messageBaselineAdvance"] = $resolvedTransition.messageBaselineAdvance }
          Write-AutoReplyVisualResult $transitionResult
        }
        if ([string]$resolvedTransition.action -eq "candidate") {
          $confirmedPreviewSignature = [string]$secondCurrentSnapshot.previewSignature
          $confirmedMessageSignature = [string]$resolvedTransition.messageSignature
          $confirmedMessage = [string]$resolvedTransition.message
          $runtimeSeed = [string]::Join([char]10, @($currentName, $confirmedMessageSignature))
          $runtimeId = "visual:v1:" + (Get-AutoReplyVisualSha256 $runtimeSeed)
          Write-AutoReplyVisualResult @{
            ok = $true
            conversation = $currentName
            conversationEvidence = [string]$currentConversation.conversationEvidence
            message = $confirmedMessage
            runtimeId = $runtimeId
            previewSignature = $confirmedPreviewSignature
            messageSignature = $confirmedMessageSignature
            pid = [int]$process.Id
            hWnd = [int64]$hWnd
            source = "current_message_change"
            latestRole = "user"
            sidebarRowCount = [int]$secondCurrentSnapshot.sidebarRowCount
            unreadBadgeCount = [int]$unresolvedUnreadBadgeCount
            context = @(@{ role = "user"; content = $confirmedMessage; key = $runtimeId })
          }
        }
      }
    }
    if ($unresolvedUnreadBadgeCount -gt 0) {
      Write-AutoReplyVisualResult @{
        ok = $false
        reason = "unread_contact_unresolved"
        pid = [int]$process.Id
        hWnd = [int64]$hWnd
        unreadBadgeCount = [int]$unresolvedUnreadBadgeCount
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
$openedObservation = Get-AutoReplyVisualObservation $hWnd ([int]$process.Id) $windowRect $true
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
    $header = Get-AutoReplyVisualHeader $openedObservation.lines $conversation $sidebarRight ([double]$openedFrame.width) $allowedSet
  }
  if (-not $header.ok -and ([bool]$candidate.badgeOnly -or [string]$header.state -eq "different")) {
    Write-AutoReplyVisualResult @{ ok = $false; reason = [string]$header.reason; pid = [int]$process.Id; hWnd = [int64]$hWnd; headerState = [string]$header.state; headerCandidateCount = [int]$header.headerCandidateCount; headerCandidateHashes = @($header.headerCandidateHashes) }
  }
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
    $confirmation = Get-AutoReplyVisualObservation $hWnd ([int]$process.Id) $windowRect $true
    if (-not $confirmation.ok) {
      Write-AutoReplyVisualResult @{
        ok = $false
        reason = "unread_preview_pending"
        pendingReason = [string]$confirmation.reason
        pid = [int]$process.Id
        hWnd = [int64]$hWnd
        conversation = $conversation
        conversationEvidence = [string]$candidate.conversationEvidence
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
      $confirmationHeader = Get-AutoReplyVisualHeader $confirmation.lines $conversation $sidebarRight ([double]$confirmationFrame.width) $allowedSet
      if (-not $confirmationHeader.ok -and [string]$confirmationHeader.state -eq "different") {
        Write-AutoReplyVisualResult @{ ok = $false; reason = "conversation_title_mismatch"; pid = [int]$process.Id; hWnd = [int64]$hWnd; headerState = "different"; headerCandidateCount = [int]$confirmationHeader.headerCandidateCount; headerCandidateHashes = @($confirmationHeader.headerCandidateHashes) }
      }
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
          conversationEvidence = [string]$candidate.conversationEvidence
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
      $resolvedMessage = [string]$confirmedLatest.message
    } finally {
      Close-MomentsVisualFrame $confirmationFrame
    }
  } else {
    # The selected unread-row preview and the chat bubble are two independent
    # OCR observations of the same message. Prefer the complete preview only
    # when both agree on stable prefix/suffix anchors; this corrects isolated
    # glyph errors such as 清洁 -> 尚吉 without trusting a stale/truncated row.
    $resolvedMessage = Resolve-AutoReplyVisualMessageText $preview ([string]$latest.message)
  }
  $runtimeSeed = [string]::Join([char]10, @($conversation, [string]$latest.evidenceSignature))
  $runtimeId = "visual:v1:" + (Get-AutoReplyVisualSha256 $runtimeSeed)
  Write-AutoReplyVisualResult @{
    ok = $true
    conversation = $conversation
    conversationEvidence = [string]$candidate.conversationEvidence
    message = $resolvedMessage
    runtimeId = $runtimeId
    previewSignature = [string]$candidate.signature
    messageSignature = [string]$latest.evidenceSignature
    pid = [int]$process.Id
    hWnd = [int64]$hWnd
    source = $source
    discoveredConversation = [bool]$candidate.discoveredConversation
    latestRole = "user"
    headerState = [string]$header.state
    headerCandidateCount = [int]$header.headerCandidateCount
    headerCandidateHashes = @($header.headerCandidateHashes)
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

function compactMessageText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, "").trim();
}

function messageEditDistance(leftValue, rightValue) {
  const left = [...compactMessageText(leftValue)];
  const right = [...compactMessageText(rightValue)];
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function sameObservedMessage(leftValue, rightValue) {
  const left = compactMessageText(leftValue);
  const right = compactMessageText(rightValue);
  if (!left || !right) return false;
  if (left === right) return true;
  if (Math.min([...left].length, [...right].length) < 4
    || Math.abs([...left].length - [...right].length) > 1) return false;
  const maximumLength = Math.max([...left].length, [...right].length);
  return messageEditDistance(left, right) <= Math.max(1, Math.floor(maximumLength * 0.15));
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/u.test(String(value || "").trim().toLowerCase());
}

function candidateKey(candidate) {
  return [candidate?.conversation, candidate?.runtimeId, candidate?.message].map((value) => String(value || "")).join("\n");
}

function createWechatVisualAutoReplyDriver(powerShellRunner = runPowerShellAsync, windowIdentityProvider = () => null) {
  const pendingVerifyAttemptLimit = 3;
  const previewBaselines = new Map();
  const messageBaselines = new Map();
  const occurrenceStates = new Map();
  const turnBoundaries = new Map();
  const startupUnreadBoundaries = new Map();
  const retryCandidates = [];
  let primedProcess = null;
  let pendingOpenedUnread = null;
  let restoredPendingObservation = null;
  let startupBoundary = null;
  let startupBoundaryCandidate = null;

  function shouldForceScreenCapture(result) {
    const reason = String(result?.reason || "");
    if (reason === "visual_capture_failed") return true;
    return result?.captureMode === "hwnd_printwindow" && new Set([
      "visual_ocr_failed",
      "moments_visual_ocr_failed",
      "moments_visual_ocr_unavailable",
      "moments_visual_ocr_region_invalid",
      "visual_ocr_structure_missing",
      "visual_sidebar_match_missing"
    ]).has(reason);
  }

  function restorePendingObservation(value) {
    const conversation = compactContactName(value?.conversation);
    const pid = Math.floor(Number(value?.pid));
    const hWnd = String(value?.hWnd || "").trim();
    const previewSignature = String(value?.preview_signature || "").trim().toLowerCase();
    const messageSignature = String(value?.message_signature || "").trim().toLowerCase();
    if (!conversation || !Number.isSafeInteger(pid) || pid <= 0 || !/^[0-9]{1,20}$/u.test(hWnd)
      || !isSha256(messageSignature)) return false;
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
    const message = compactMessageText(result?.message);
    const active = occurrenceStates.get(conversation);
    const turn = turnBoundaries.get(conversation) || { epoch: 0, pending: false, lastAdvancedRuntimeId: "" };
    const predecessor = String(predecessorSignature || "").trim().toLowerCase();
    let runtimeId = active?.active === true
      && (active.messageSignature === messageSignature || sameObservedMessage(active.message, message))
      ? active.runtimeId
      : "";
    if (!runtimeId) {
      runtimeId = `visual:v2:${createHash("sha256").update([
        "visual-occurrence-bubble-v3",
        conversation,
        messageSignature,
        String(turn.epoch)
      ].join("\n"), "utf8").digest("hex")}`;
      occurrenceStates.set(conversation, {
        active: true,
        previewSignature,
        evidenceRuntimeId,
        message,
        messageSignature,
        predecessorSignature: predecessor,
        runtimeId
      });
    } else {
      // Keep one occurrence identity while the authoritative bubble and turn
      // boundary are unchanged. Sidebar OCR may update independently.
      occurrenceStates.set(conversation, {
        ...active,
        previewSignature,
        evidenceRuntimeId,
        message,
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

  function observeAssistantBoundary(conversationValue, signatureValue) {
    const conversation = compactContactName(conversationValue);
    const signature = String(signatureValue || "").trim().toLowerCase();
    if (!conversation || !isSha256(signature)) return false;
    const previousTurn = turnBoundaries.get(conversation) || {
      epoch: 0,
      pending: false,
      lastAdvancedRuntimeId: "",
      lastAssistantObservationKey: ""
    };
    const active = occurrenceStates.get(conversation);
    const predecessorRuntimeId = String(active?.runtimeId || "");
    const observationKey = `${signature}\n${predecessorRuntimeId}`;
    for (let index = retryCandidates.length - 1; index >= 0; index -= 1) {
      if (compactContactName(retryCandidates[index]?.conversation) === conversation) retryCandidates.splice(index, 1);
    }
    if (previousTurn.pending === true) {
      turnBoundaries.set(conversation, {
        ...previousTurn,
        pending: false,
        lastAssistantObservationKey: observationKey
      });
      if (active) occurrenceStates.set(conversation, { ...active, active: false, boundarySignature: signature });
      return { advanced: false, confirmed: true, turnEpoch: previousTurn.epoch };
    }
    if (previousTurn.lastAssistantObservationKey === observationKey) {
      return { advanced: false, confirmed: false, turnEpoch: previousTurn.epoch };
    }
    const turnEpoch = previousTurn.epoch + 1;
    turnBoundaries.set(conversation, {
      ...previousTurn,
      epoch: turnEpoch,
      pending: false,
      lastAssistantObservationKey: observationKey
    });
    if (active) occurrenceStates.set(conversation, { ...active, active: false, boundarySignature: signature });
    return { advanced: true, confirmed: false, turnEpoch };
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
    if (replace) {
      previewBaselines.clear();
      for (const [conversation, turn] of turnBoundaries) {
        if (turn?.pending === true) previewBaselines.set(conversation, turnBoundarySignature(conversation, turn.epoch));
      }
    }
    const rows = Array.isArray(result?.sessionBaselines) ? result.sessionBaselines : [];
    for (const row of rows.slice(0, 1_000)) {
      const conversation = compactContactName(row?.conversation);
      const signature = String(row?.signature || "").trim().toLowerCase();
      if (!allowed.includes(conversation) || !isSha256(signature)) continue;
      if (row?.unread === false) startupUnreadBoundaries.delete(conversation);
      if (turnBoundaries.get(conversation)?.pending === true) continue;
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
      for (const [conversation, turn] of turnBoundaries) {
        if (turn?.pending === true) messageBaselines.set(conversation, turnBoundarySignature(conversation, turn.epoch));
      }
    }
    const rows = Array.isArray(result?.sessionMessageBaselines) ? result.sessionMessageBaselines : [];
    for (const row of rows.slice(0, 1_000)) {
      const conversation = compactContactName(row?.conversation);
      const signature = String(row?.signature || "").trim().toLowerCase();
      if (!allowed.includes(conversation) || !isSha256(signature)) continue;
      if (String(row?.latestRole || "") === "assistant") observeAssistantBoundary(conversation, signature);
      if (turnBoundaries.get(conversation)?.pending === true) continue;
      if (missingOnly && messageBaselines.has(conversation)) continue;
      observeMessageSignature(conversation, signature);
    }
  }

  function applyMessageBaselineAdvance(result, allowed) {
    const conversation = compactContactName(result?.messageBaselineAdvance?.conversation);
    const signature = String(result?.messageBaselineAdvance?.signature || "").trim().toLowerCase();
    if (!allowed.includes(conversation) || !isSha256(signature)) return;
    if (String(result?.latestRole || "") === "assistant") observeAssistantBoundary(conversation, signature);
    if (turnBoundaries.get(conversation)?.pending !== true) observeMessageSignature(conversation, signature);
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
    if (!allowed.includes(conversation) || !message || String(result?.latestRole || "") !== "user"
      || !/^visual:v1:[a-f0-9]{64}$/u.test(runtimeId)
      || !isSha256(messageSignature) || !process) return null;
    return {
      ok: true,
      conversation,
      conversationEvidence: compactContactName(result?.conversationEvidence) || conversation,
      message,
      runtimeId,
      previewSignature,
      messageSignature,
      pid: process.pid,
      hWnd: process.hWnd,
      source: String(result?.source || "unread"),
      latestRole: "user",
      discoveredConversation: false,
      pendingVerifyAttempts: 0,
      context: [{ role: "user", content: message, key: runtimeId }]
    };
  }

  async function settlePendingOpenedUnread(nameIdentity, allowed) {
    const pending = pendingOpenedUnread;
    if (!pending) return null;
    if (!allowed.includes(pending.conversation)) {
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
    const sharedWindow = typeof windowIdentityProvider === "function" ? windowIdentityProvider() : null;
    return Promise.resolve(powerShellRunner(AUTO_REPLY_VISUAL_SCRIPT, {
      XIAOXI_AUTO_REPLY_MODE: mode,
      XIAOXI_ALLOWED_NAMES: JSON.stringify(allowed),
      XIAOXI_EXCLUDED_NAMES: JSON.stringify(["文件传输助手", "微信团队", "服务通知", "订阅号消息", "群聊"]),
      XIAOXI_VISUAL_BASELINES: JSON.stringify(Object.fromEntries(previewBaselines)),
      XIAOXI_VISUAL_MESSAGE_BASELINES: JSON.stringify(Object.fromEntries(messageBaselines)),
      XIAOXI_STARTUP_UNREAD_BOUNDARIES: JSON.stringify(Object.fromEntries(startupUnreadBoundaries)),
      XIAOXI_EXPECTED_PID: String(sharedWindow?.pid || ""),
      XIAOXI_EXPECTED_HWND: String(sharedWindow?.hWnd || ""),
      XIAOXI_ALLOW_FOCUS_FALLBACK: "",
      XIAOXI_FORCE_SCREEN_CAPTURE: "",
      ...extra
    }, { ensure: false, sta: true, timeout: 30_000 }));
  }

  async function primeWechatSession(names) {
    const nameIdentity = allowedNameIdentity(names);
    const allowed = nameIdentity.compactNames;
    if (nameIdentity.ambiguous) return { ok: false, reason: "whitelist_name_ambiguous" };
    if (!allowed.length) return { ok: false, reason: "whitelist_empty" };
    let result = await invoke("prime", allowed);
    if (result?.ok !== true && shouldForceScreenCapture(result)) {
      result = await invoke("prime", allowed, { XIAOXI_ALLOW_FOCUS_FALLBACK: "1", XIAOXI_FORCE_SCREEN_CAPTURE: "1" });
    }
    if (result?.ok !== true) return result;
    const process = processIdentity(result);
    if (!process) return { ok: false, reason: "incoming_identity_missing" };
    applyBaselines(result, allowed, { replace: true });
    applyMessageBaselines(result, allowed, { replace: true });
    pendingOpenedUnread = null;
    restoredPendingObservation = null;
    primedProcess = process;
    if (result?.startupBoundarySupported === true) {
      const primeRows = Array.isArray(result?.sessionBaselines) ? result.sessionBaselines : [];
      const unreadAtBoundary = new Map(primeRows.map((row) => [compactContactName(row?.conversation), row?.unread === true]));
      startupUnreadBoundaries.clear();
      for (const row of primeRows) {
        const conversation = compactContactName(row?.conversation);
        const signature = String(row?.signature || "").trim().toLowerCase();
        const preview = compactMessageText(row?.preview);
        if (allowed.includes(conversation) && row?.unread === true
          && turnBoundaries.get(conversation)?.pending !== true && isSha256(signature) && preview) {
          startupUnreadBoundaries.set(conversation, { signature, preview });
        }
      }
      startupBoundary = {
        previews: Object.fromEntries(primeRows
          .map((row) => [compactContactName(row?.conversation), { preview: compactMessageText(row?.preview) }])
          .filter(([conversation, value]) => allowed.includes(conversation) && value.preview
            && !(turnBoundaries.get(conversation)?.pending === true && unreadAtBoundary.get(conversation) === true))),
        messages: Object.fromEntries((Array.isArray(result?.sessionMessageBaselines) ? result.sessionMessageBaselines : [])
          .map((row) => [compactContactName(row?.conversation), { message: compactMessageText(row?.message) }])
          .filter(([conversation, value]) => allowed.includes(conversation) && value.message
            && !(turnBoundaries.get(conversation)?.pending === true && unreadAtBoundary.get(conversation) === true)))
      };
      const boundaryResult = await scanWechatIncoming(names);
      if (boundaryResult?.reason === "wechat_process_changed" || boundaryResult?.reason === "wechat_window_changed") return boundaryResult;
      if (boundaryResult?.ok === true) startupBoundaryCandidate = boundaryResult;
    }
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
    const allowed = nameIdentity.compactNames;
    if (nameIdentity.ambiguous) return { ok: false, reason: "whitelist_name_ambiguous" };
    if (!allowed.length) return { ok: false, reason: "whitelist_empty" };
    if (!primedProcess) {
      const prime = await primeWechatSession(names);
      return prime?.ok === true ? { ...prime, ok: false, reason: "current_session_baselined" } : prime;
    }
    if (startupBoundaryCandidate) {
      const candidate = startupBoundaryCandidate;
      startupBoundaryCandidate = null;
      return candidate;
    }
    const restoredResult = await recoverPendingObservation(nameIdentity, allowed);
    if (restoredResult) return restoredResult;
    const pendingResult = await settlePendingOpenedUnread(nameIdentity, allowed);
    if (pendingResult) return pendingResult;
    const boundary = startupBoundary;
    startupBoundary = null;
    const scanMode = boundary ? "prime_confirm" : "scan";
    const scanEnvironment = {
      XIAOXI_EXPECTED_PID: String(primedProcess.pid),
      XIAOXI_EXPECTED_HWND: primedProcess.hWnd,
      ...(boundary ? {
        XIAOXI_STARTUP_PREVIEWS: JSON.stringify(boundary.previews),
        XIAOXI_STARTUP_MESSAGES: JSON.stringify(boundary.messages)
      } : {})
    };
    let result = await invoke(scanMode, allowed, scanEnvironment);
    if (result?.ok !== true && shouldForceScreenCapture(result)) {
      result = await invoke(scanMode, allowed, {
        ...scanEnvironment,
        XIAOXI_ALLOW_FOCUS_FALLBACK: "1",
        XIAOXI_FORCE_SCREEN_CAPTURE: "1"
      });
    }
    const identity = processIdentity(result);
    if (identity && (identity.pid !== primedProcess.pid || identity.hWnd !== primedProcess.hWnd)) {
      const processChanged = identity.pid !== primedProcess.pid;
      previewBaselines.clear();
      messageBaselines.clear();
      occurrenceStates.clear();
      retryCandidates.length = 0;
      pendingOpenedUnread = null;
      restoredPendingObservation = null;
      primedProcess = null;
      return { ...result, ok: false, reason: processChanged ? "wechat_process_changed" : "wechat_window_changed" };
    }
    if (result?.reason === "wechat_process_changed" || result?.reason === "wechat_window_changed") {
      previewBaselines.clear();
      messageBaselines.clear();
      occurrenceStates.clear();
      retryCandidates.length = 0;
      pendingOpenedUnread = null;
      restoredPendingObservation = null;
      primedProcess = null;
      return result;
    }
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
    if (!/^visual:v1:[a-f0-9]{64}$/u.test(runtimeId) || !isSha256(messageSignature)) return { ok: false, reason: "incoming_identity_missing" };
    const predecessorSignature = messageBaselines.get(conversation) || "";
    const decorated = decorateCandidate({ ...result, discoveredConversation: false }, nameIdentity, predecessorSignature);
    startupUnreadBoundaries.delete(conversation);
    const turn = turnBoundaries.get(conversation);
    if (turn?.pending === true) turnBoundaries.set(conversation, { ...turn, pending: false });
    if (isSha256(signature)) previewBaselines.set(conversation, signature);
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

  function turnBoundarySignature(conversation, epoch) {
    return createHash("sha256").update([
      "visual-contact-turn-boundary-v1",
      conversation,
      String(epoch)
    ].join("\n"), "utf8").digest("hex");
  }

  function restoreTurnBoundaries(values) {
    turnBoundaries.clear();
    for (const value of Array.isArray(values) ? values.slice(-1_000) : []) {
      const conversation = compactContactName(value?.conversation);
      const epoch = Math.max(0, Math.floor(Number(value?.turnEpoch) || 0));
      const lastAdvancedRuntimeId = String(value?.runtimeId || "").trim();
      if (!conversation || epoch > Number.MAX_SAFE_INTEGER) continue;
      const restored = turnBoundaries.get(conversation);
      if (epoch < 1) {
        // A later outcome_unknown guard deliberately carries epoch zero. When
        // an older verified turn was also restored for this contact, this
        // unresolved customer occurrence means that older pending boundary is
        // no longer waiting for its assistant bubble. If a bubble is visible
        // now, it is the unknown attempt's own new outgoing boundary.
        if (restored && lastAdvancedRuntimeId && lastAdvancedRuntimeId !== restored.lastAdvancedRuntimeId) {
          turnBoundaries.set(conversation, {
            ...restored,
            pending: false,
            lastUnknownRuntimeId: lastAdvancedRuntimeId
          });
        }
        continue;
      }
      if (restored && restored.epoch > epoch) continue;
      turnBoundaries.set(conversation, {
        epoch,
        pending: true,
        lastAdvancedRuntimeId,
        lastAssistantObservationKey: "",
        lastUnknownRuntimeId: ""
      });
      const signature = turnBoundarySignature(conversation, epoch);
      previewBaselines.set(conversation, signature);
      messageBaselines.set(conversation, signature);
    }
    return turnBoundaries.size;
  }

  function noteSendAttempted(candidate = {}, metadata = {}) {
    const verificationMode = String(metadata?.verificationMode || "");
    const outcomeUnknown = metadata?.outcomeUnknown === true;
    if (!outcomeUnknown && !new Set(["visual_message_bubble", "draft_consumed_same_header"]).has(verificationMode)) return false;
    const conversation = compactContactName(candidate?.conversation);
    const runtimeId = String(candidate?.runtimeId || "").trim();
    const active = occurrenceStates.get(conversation);
    if (!conversation || !/^visual:v2:[a-f0-9]{64}$/u.test(runtimeId) || active?.runtimeId !== runtimeId) return false;
    const previousTurn = turnBoundaries.get(conversation) || { epoch: 0, pending: false, lastAdvancedRuntimeId: "" };
    if (previousTurn.lastAdvancedRuntimeId === runtimeId) {
      return { advanced: true, turnEpoch: previousTurn.epoch };
    }
    if (outcomeUnknown) {
      // An unknown click is durably fenced by the controller using this exact
      // occurrence ID. Do not manufacture a new turn until an outgoing bubble
      // is actually observed, otherwise the same customer bubble would acquire
      // a fresh ID and bypass that fence on the next scan.
      return { advanced: false, outcomeUnknown: true, turnEpoch: previousTurn.epoch };
    }
    const turnEpoch = previousTurn.epoch + 1;
    const boundarySignature = turnBoundarySignature(conversation, turnEpoch);
    turnBoundaries.set(conversation, { epoch: turnEpoch, pending: true, lastAdvancedRuntimeId: runtimeId });
    occurrenceStates.set(conversation, { ...active, active: false, boundarySignature });
    startupUnreadBoundaries.delete(conversation);
    previewBaselines.set(conversation, boundarySignature);
    messageBaselines.set(conversation, boundarySignature);
    return { advanced: true, turnEpoch };
  }

  function noteVerifiedSend(candidate = {}, metadata = {}) {
    return noteSendAttempted(candidate, metadata)?.advanced === true;
  }

  scanWechatIncoming.primeBaselines = primeWechatSession;
  scanWechatIncoming.restorePendingObservation = restorePendingObservation;
  scanWechatIncoming.noteVerifiedSend = noteVerifiedSend;
  scanWechatIncoming.noteSendAttempted = noteSendAttempted;
  scanWechatIncoming.restoreTurnBoundaries = restoreTurnBoundaries;
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
    turnBoundaries.clear();
    startupUnreadBoundaries.clear();
    retryCandidates.length = 0;
    pendingOpenedUnread = null;
    restoredPendingObservation = null;
    startupBoundary = null;
    startupBoundaryCandidate = null;
    primedProcess = null;
  };

  return { primeWechatSession, scanWechatIncoming, verifyWechatIncoming, noteVerifiedSend, noteSendAttempted, restoreTurnBoundaries };
}

const driver = createWechatVisualAutoReplyDriver();

module.exports = {
  AUTO_REPLY_VISUAL_SCRIPT,
  createWechatVisualAutoReplyDriver,
  ...driver
};
