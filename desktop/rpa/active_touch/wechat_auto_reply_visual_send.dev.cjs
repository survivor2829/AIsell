const { MOMENTS_VISUAL_READONLY_POWERSHELL } = require("./moments_visual_probe.dev.cjs");
const { runPowerShellAsync } = require("./wechat_window_driver.cjs");

const WECHAT_VISUAL_AUTO_REPLY_POWERSHELL = String.raw`
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32WechatVisualAutoReply {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maximum);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extraInfo);
}
"@

${MOMENTS_VISUAL_READONLY_POWERSHELL}

$expectedPidText = [Environment]::GetEnvironmentVariable("XIAOXI_VISUAL_SEND_PID")
$expectedHWndText = [Environment]::GetEnvironmentVariable("XIAOXI_VISUAL_SEND_HWND")
$expectedConversation = [Environment]::GetEnvironmentVariable("XIAOXI_VISUAL_SEND_CONVERSATION")
$expectedIncoming = [Environment]::GetEnvironmentVariable("XIAOXI_VISUAL_SEND_INCOMING")
$incomingWasVerified = [Environment]::GetEnvironmentVariable("XIAOXI_VISUAL_SEND_INCOMING_VERIFIED") -ceq "true"
$expectedReply = [Environment]::GetEnvironmentVariable("XIAOXI_VISUAL_SEND_REPLY")
$phase = [Environment]::GetEnvironmentVariable("XIAOXI_VISUAL_SEND_PHASE")

function Write-VisualSendResult($value) {
  $value | ConvertTo-Json -Compress -Depth 8
  exit
}

function Normalize-VisualSendText([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  return [Text.RegularExpressions.Regex]::Replace(
    $value.Normalize([Text.NormalizationForm]::FormKC),
    "\s+",
    ""
  ).Trim()
}

function Normalize-VisualSendDraftText([string]$value) {
  $normalized = ([string]$value).Replace([Environment]::NewLine, [string][char]10)
  $normalized = $normalized.Replace([string][char]13, [string][char]10)
  return $normalized.TrimEnd([char[]]@([char]0xFFFC))
}

function Get-VisualSendLock {
  if ($expectedPidText -notmatch '^[1-9][0-9]*$' -or $expectedHWndText -notmatch '^[1-9][0-9]*$' -or
    [string]::IsNullOrWhiteSpace($expectedConversation) -or [string]::IsNullOrWhiteSpace($expectedReply)) {
    return @{ ok = $false; reason = "visual_send_context_invalid" }
  }
  $expectedPid = [int]$expectedPidText
  $hWnd = [IntPtr][int64]$expectedHWndText
  if (-not [Win32WechatVisualAutoReply]::IsWindowVisible($hWnd) -or [Win32WechatVisualAutoReply]::IsIconic($hWnd)) {
    return @{ ok = $false; reason = "visual_send_window_not_visible" }
  }
  [uint32]$actualPid = 0
  [void][Win32WechatVisualAutoReply]::GetWindowThreadProcessId($hWnd, [ref]$actualPid)
  $process = Get-Process -Id $actualPid -ErrorAction SilentlyContinue
  $title = New-Object Text.StringBuilder 64
  [void][Win32WechatVisualAutoReply]::GetWindowText($hWnd, $title, $title.Capacity)
  if ($process -eq $null -or [int]$actualPid -ne $expectedPid -or
    @("Weixin", "WeChat") -notcontains $process.ProcessName -or
    [int64]$process.MainWindowHandle -ne $hWnd.ToInt64() -or $title.ToString().Trim() -cne "微信") {
    return @{ ok = $false; reason = "visual_send_window_identity_mismatch" }
  }
  $rect = New-Object Win32WechatVisualAutoReply+RECT
  if (-not [Win32WechatVisualAutoReply]::GetWindowRect($hWnd, [ref]$rect) -or
    ($rect.Right - $rect.Left) -lt 500 -or ($rect.Bottom - $rect.Top) -lt 400) {
    return @{ ok = $false; reason = "visual_send_window_geometry_invalid" }
  }
  [void][Win32WechatVisualAutoReply]::ShowWindowAsync($hWnd, 9)
  $focused = [Win32WechatVisualAutoReply]::SetForegroundWindow($hWnd)
  if (-not $focused) {
    try { $focused = (New-Object -ComObject WScript.Shell).AppActivate([int]$expectedPid) } catch {}
  }
  Start-Sleep -Milliseconds 180
  if ([Win32WechatVisualAutoReply]::GetForegroundWindow() -ne $hWnd) {
    try { [void](New-Object -ComObject WScript.Shell).AppActivate([int]$expectedPid) } catch {}
    Start-Sleep -Milliseconds 180
  }
  if ([Win32WechatVisualAutoReply]::GetForegroundWindow() -ne $hWnd) {
    return @{ ok = $false; reason = "visual_send_window_not_foreground" }
  }
  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd) } catch { $root = $null }
  if ($root -eq $null -or [int]$root.Current.ProcessId -ne $expectedPid) {
    return @{ ok = $false; reason = "visual_send_automation_root_missing" }
  }
  $pane = Get-MomentsRenderPaneEvidence $root $expectedPid
  if (-not $pane.ok) { return @{ ok = $false; reason = "visual_send_render_pane_missing" } }
  return @{ ok = $true; pid = $expectedPid; hWnd = $hWnd; rect = $rect; root = $root; pane = $pane.pane }
}

function Get-VisualSendFrame($lock) {
  $frame = Get-MomentsVisualFrame $lock.hWnd $lock.rect $lock.pid $false
  if (-not $frame.ok) { return @{ ok = $false; reason = $frame.reason } }
  return $frame
}

function Test-VisualSendConversation($frame) {
  $headerRect = @{
    left = [double]($frame.width * 0.08)
    top = [double]($frame.height * 0.025)
    width = [double]($frame.width * 0.90)
    height = [double]([Math]::Max(70, $frame.height * 0.13))
  }
  $ocr = Get-MomentsScaledOcrObservation $frame $headerRect 3
  if (-not $ocr.ok) { return @{ ok = $false; reason = "visual_send_header_ocr_failed" } }
  $expected = Normalize-VisualSendText $expectedConversation
  $minimumHeaderCenterX = [Math]::Min(
    [double]$frame.width * 0.38,
    [Math]::Max([double]$frame.width * 0.20, 230.0)
  )
  $matches = @($ocr.lines | Where-Object {
    $absoluteCenterX = [double]$headerRect.left + [double]$_.bounds.left + ([double]$_.bounds.width / 2.0)
    $absoluteCenterY = [double]$headerRect.top + [double]$_.bounds.top + ([double]$_.bounds.height / 2.0)
    (Normalize-VisualSendText ([string]$_.text)) -ceq $expected -and
      $absoluteCenterX -ge $minimumHeaderCenterX -and $absoluteCenterY -le ([double]$frame.height * 0.13)
  })
  if ($matches.Count -ne 1) { return @{ ok = $false; reason = "visual_send_conversation_not_verified" } }
  return @{ ok = $true }
}

function Test-VisualSendIncoming($frame) {
  if ([string]::IsNullOrWhiteSpace($expectedIncoming)) { return $true }
  $bodyRect = @{
    left = [double]($frame.width * 0.23)
    top = [double]($frame.height * 0.13)
    width = [double]($frame.width * 0.75)
    height = [double]($frame.height * 0.69)
  }
  $ocr = Get-MomentsOcrObservation $frame $bodyRect
  if (-not $ocr.ok) { return $false }
  $wanted = Normalize-VisualSendText $expectedIncoming
  $observed = Normalize-VisualSendText ([string]$ocr.text)
  return $wanted.Length -gt 0 -and $observed.Contains($wanted)
}

function Test-VisualSendPureMessageText([string]$value) {
  $text = Normalize-VisualSendText $value
  if (-not $text -or $text.Length -gt 200) { return $false }
  if ($text -match "^(?:[0-2]?[0-9]:[0-5][0-9]|昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天]|[0-9]{1,2}/[0-9]{1,2}|[0-9]{4}/[0-9]{1,2}/[0-9]{1,2})$") { return $false }
  if ($text -match "^\[(?:图片|动画表情|表情|语音|视频|文件|链接|小程序|位置|音乐|聊天记录|转账|红包|通话)\]$") { return $false }
  if ($text -match "^(?:图片|动画表情|语音|视频|文件|链接|小程序|位置|音乐|聊天记录|转账|红包|通话)$") { return $false }
  return $true
}

function Test-VisualSendLatestIncoming($frame) {
  if ([string]::IsNullOrWhiteSpace($expectedIncoming)) { return $true }
  # Use the same full-frame OCR geometry as the scanner. A cropped OCR pass can
  # recognize the same Chinese line differently, while draft input can move the
  # line without changing its identity.
  $ocr = Get-MomentsOcrObservation $frame @{ left = 0.0; top = 0.0; width = [double]$frame.width; height = [double]$frame.height }
  if (-not $ocr.ok) { return $false }
  $sidebarRight = [double]$frame.width * 0.273
  $chatMid = $sidebarRight + (([double]$frame.width - $sidebarRight) * 0.58)
  $messageLines = New-Object System.Collections.Generic.List[object]
  foreach ($line in @($ocr.lines)) {
    if ($line -eq $null -or -not (Test-VisualSendPureMessageText ([string]$line.text))) { continue }
    $left = [double]$line.bounds.left
    $top = [double]$line.bounds.top
    if ($left -lt ([double]$frame.width * 0.286) -or $left -ge ([double]$frame.width * 0.982) -or
      $top -lt ([double]$frame.height * 0.154) -or $top -gt ([double]$frame.height * 0.81)) { continue }
    [void]$messageLines.Add([pscustomobject]@{
      text = Normalize-VisualSendText ([string]$line.text)
      left = $left
      top = $top
    })
  }
  if ($messageLines.Count -eq 0) { return $false }
  $latest = @($messageLines.ToArray() | Sort-Object top, left | Select-Object -Last 1)[0]
  return [string]$latest.text -ceq (Normalize-VisualSendText $expectedIncoming) -and [double]$latest.left -lt $chatMid
}

function Test-VisualSendGreenPixel($frame, [int]$x, [int]$y) {
  $pixel = Get-MomentsPixel $frame $x $y
  return $pixel -ne $null -and $pixel.g -ge 105 -and $pixel.g -ge ($pixel.r + 28) -and $pixel.g -ge ($pixel.b + 18)
}

function Get-VisualSendGreenRatio($frame, [int]$left, [int]$top, [int]$right, [int]$bottom) {
  $green = 0
  $total = 0
  for ($y = [Math]::Max(0, $top); $y -lt [Math]::Min($frame.height, $bottom); $y += 2) {
    for ($x = [Math]::Max(0, $left); $x -lt [Math]::Min($frame.width, $right); $x += 2) {
      if (Test-VisualSendGreenPixel $frame $x $y) { $green += 1 }
      $total += 1
    }
  }
  if ($total -eq 0) { return 0.0 }
  return [double]$green / [double]$total
}

function Find-VisualSendGreenComponents($frame, $region) {
  $step = 2
  $columns = [int][Math]::Floor([double]$region.width / $step)
  $rows = [int][Math]::Floor([double]$region.height / $step)
  if ($columns -lt 10 -or $rows -lt 10) { return @() }
  $mask = New-Object bool[] ($columns * $rows)
  for ($row = 0; $row -lt $rows; $row++) {
    for ($column = 0; $column -lt $columns; $column++) {
      $x = [int]$region.left + ($column * $step)
      $y = [int]$region.top + ($row * $step)
      $mask[($row * $columns) + $column] = Test-VisualSendGreenPixel $frame $x $y
    }
  }
  $seen = New-Object bool[] $mask.Length
  $found = New-Object System.Collections.Generic.List[object]
  for ($seedRow = 0; $seedRow -lt $rows; $seedRow++) {
    for ($seedColumn = 0; $seedColumn -lt $columns; $seedColumn++) {
      $seed = ($seedRow * $columns) + $seedColumn
      if (-not $mask[$seed] -or $seen[$seed]) { continue }
      $queue = New-Object System.Collections.Generic.Queue[int]
      $queue.Enqueue($seed); $seen[$seed] = $true
      $minimumColumn = $seedColumn; $maximumColumn = $seedColumn
      $minimumRow = $seedRow; $maximumRow = $seedRow; $count = 0
      while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        $currentRow = [int][Math]::Floor($current / $columns)
        $currentColumn = $current - ($currentRow * $columns)
        $minimumColumn = [Math]::Min($minimumColumn, $currentColumn)
        $maximumColumn = [Math]::Max($maximumColumn, $currentColumn)
        $minimumRow = [Math]::Min($minimumRow, $currentRow)
        $maximumRow = [Math]::Max($maximumRow, $currentRow)
        $count += 1
        foreach ($delta in @(@(-1,0), @(1,0), @(0,-1), @(0,1))) {
          $nextColumn = $currentColumn + $delta[0]; $nextRow = $currentRow + $delta[1]
          if ($nextColumn -lt 0 -or $nextRow -lt 0 -or $nextColumn -ge $columns -or $nextRow -ge $rows) { continue }
          $next = ($nextRow * $columns) + $nextColumn
          if ($mask[$next] -and -not $seen[$next]) { $seen[$next] = $true; $queue.Enqueue($next) }
        }
      }
      $left = [int]$region.left + ($minimumColumn * $step)
      $top = [int]$region.top + ($minimumRow * $step)
      $width = (($maximumColumn - $minimumColumn) + 1) * $step
      $height = (($maximumRow - $minimumRow) + 1) * $step
      if ($count -ge 50 -and $width -ge [Math]::Max(38, $frame.width * 0.025) -and
        $width -le ($frame.width * 0.18) -and $height -ge 20 -and $height -le ($frame.height * 0.10) -and
        ([double]$width / [double]$height) -ge 1.3 -and ([double]$width / [double]$height) -le 7.0) {
        $greenRatio = Get-VisualSendGreenRatio $frame $left $top ($left + $width) ($top + $height)
        if ($greenRatio -ge 0.35) {
          [void]$found.Add(@{ x = [int]($left + ($width / 2)); y = [int]($top + ($height / 2)); width = $width; height = $height; greenRatio = $greenRatio; source = "green_component" })
        }
      }
    }
  }
  return @($found.ToArray())
}

function Find-VisualSendButton($frame) {
  $region = @{
    left = [double]($frame.width * 0.70)
    top = [double]($frame.height * 0.74)
    width = [double]($frame.width * 0.29)
    height = [double]($frame.height * 0.25)
  }
  $ocr = Get-MomentsScaledOcrObservation $frame $region 3
  if ($ocr.ok) {
    $labelMatches = New-Object System.Collections.Generic.List[object]
    foreach ($word in @($ocr.words)) {
      if ((Normalize-VisualSendText ([string]$word.text)) -cne "发送") { continue }
      $x = [int]($region.left + [double]$word.bounds.left + ([double]$word.bounds.width / 2.0))
      $y = [int]($region.top + [double]$word.bounds.top + ([double]$word.bounds.height / 2.0))
      $halfWidth = [int][Math]::Max(24, [double]$word.bounds.width * 2.2)
      $halfHeight = [int][Math]::Max(14, [double]$word.bounds.height * 1.5)
      $ratio = Get-VisualSendGreenRatio $frame ($x - $halfWidth) ($y - $halfHeight) ($x + $halfWidth) ($y + $halfHeight)
      if ($ratio -ge 0.18 -and $x -ge ($frame.width * 0.70) -and $y -ge ($frame.height * 0.74)) {
        [void]$labelMatches.Add(@{ x = $x; y = $y; source = "ocr_send_label"; greenRatio = $ratio })
      }
    }
    if ($labelMatches.Count -eq 1) { return @{ ok = $true; point = $labelMatches[0] } }
  }
  $components = @(Find-VisualSendGreenComponents $frame $region | Where-Object {
    $componentRight = [double]$_.x + ([double]$_.width / 2.0)
    $componentBottom = [double]$_.y + ([double]$_.height / 2.0)
    $_.x -ge ($frame.width * 0.82) -and $_.y -ge ($frame.height * 0.83) -and
      $componentRight -ge ($frame.width * 0.91) -and $componentRight -le ($frame.width * 0.995) -and
      $componentBottom -ge ($frame.height * 0.86) -and $componentBottom -le ($frame.height * 0.995)
  })
  if ($components.Count -ne 1) { return @{ ok = $false; reason = "visual_send_button_not_unique" } }
  return @{ ok = $true; point = $components[0] }
}

function Test-VisualSendOwnedPoint($lock, [int]$x, [int]$y) {
  $point = New-Object Win32WechatVisualAutoReply+POINT
  $point.X = [int]($lock.rect.Left + $x); $point.Y = [int]($lock.rect.Top + $y)
  $hit = [Win32WechatVisualAutoReply]::WindowFromPoint($point)
  if ($hit -eq [IntPtr]::Zero -or [Win32WechatVisualAutoReply]::GetAncestor($hit, 2) -ne $lock.hWnd) { return $false }
  [uint32]$hitPid = 0
  [void][Win32WechatVisualAutoReply]::GetWindowThreadProcessId($hit, [ref]$hitPid)
  return [int]$hitPid -eq $lock.pid
}

function Read-VisualSendDraft($lock) {
  $width = [double]($lock.rect.Right - $lock.rect.Left)
  $height = [double]($lock.rect.Bottom - $lock.rect.Top)
  $relativeX = [int]($width * 0.64)
  $relativeY = [int]($height * 0.87)
  if (-not (Test-VisualSendOwnedPoint $lock $relativeX $relativeY)) {
    return @{ ok = $false; empty = $false; exact = $false }
  }
  $x = [int]($lock.rect.Left + $relativeX)
  $y = [int]($lock.rect.Top + $relativeY)
  $oldClipboard = ""
  try { $oldClipboard = [string](Get-Clipboard -Raw -ErrorAction SilentlyContinue) } catch {}
  $sentinel = "__XIAOXI_VISUAL_EMPTY_" + [Guid]::NewGuid().ToString("N")
  try {
    [void][Win32WechatVisualAutoReply]::SetCursorPos($x, $y)
    [Win32WechatVisualAutoReply]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 35
    [Win32WechatVisualAutoReply]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 90
    Set-Clipboard -Value $sentinel
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 45
    [System.Windows.Forms.SendKeys]::SendWait("^c")
    Start-Sleep -Milliseconds 150
    $copied = [string](Get-Clipboard -Raw -ErrorAction Stop)
    return @{
      ok = $true
      empty = $copied -ceq $sentinel
      exact = (Normalize-VisualSendDraftText $copied) -ceq (Normalize-VisualSendDraftText $expectedReply)
    }
  } catch {
    return @{ ok = $false; empty = $false; exact = $false }
  } finally {
    try { Set-Clipboard -Value $oldClipboard } catch {}
  }
}

function Write-VisualSendDraft($lock) {
  $width = [double]($lock.rect.Right - $lock.rect.Left)
  $height = [double]($lock.rect.Bottom - $lock.rect.Top)
  $relativeX = [int]($width * 0.64)
  $relativeY = [int]($height * 0.87)
  if (-not (Test-VisualSendOwnedPoint $lock $relativeX $relativeY) -or
    [Win32WechatVisualAutoReply]::GetForegroundWindow() -ne $lock.hWnd) {
    return @{ ok = $false; exact = $false }
  }
  $x = [int]($lock.rect.Left + $relativeX)
  $y = [int]($lock.rect.Top + $relativeY)
  $oldClipboard = ""
  try { $oldClipboard = [string](Get-Clipboard -Raw -ErrorAction SilentlyContinue) } catch {}
  try {
    [void][Win32WechatVisualAutoReply]::SetCursorPos($x, $y)
    [Win32WechatVisualAutoReply]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 35
    [Win32WechatVisualAutoReply]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 90
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Set-Clipboard -Value $expectedReply
    Start-Sleep -Milliseconds 60
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 260
  } catch {
    return @{ ok = $false; exact = $false }
  } finally {
    try { Set-Clipboard -Value $oldClipboard } catch {}
  }
  if ([Win32WechatVisualAutoReply]::GetForegroundWindow() -ne $lock.hWnd) {
    return @{ ok = $false; exact = $false }
  }
  $readback = Read-VisualSendDraft $lock
  return @{ ok = $readback.ok -and $readback.exact; exact = $readback.exact }
}

function Test-VisualSendOutgoingBubble($frame) {
  $rect = @{
    left = [double]($frame.width * 0.45)
    top = [double]($frame.height * 0.13)
    width = [double]($frame.width * 0.53)
    height = [double]($frame.height * 0.64)
  }
  $ocr = Get-MomentsOcrObservation $frame $rect
  if (-not $ocr.ok) { return $false }
  $wanted = Normalize-VisualSendText $expectedReply
  return @($ocr.lines | Where-Object {
    (Normalize-VisualSendText ([string]$_.text)) -ceq $wanted -and
    ([double]$_.bounds.left + ([double]$_.bounds.width / 2.0)) -ge ([double]$rect.width * 0.35)
  }).Count -ge 1
}

$lock = Get-VisualSendLock
if (-not $lock.ok) {
  Write-VisualSendResult @{ ok = $false; reason = $lock.reason; sendAttempted = $false; conversationVerified = $false; draftVerified = $false }
}
$frame = Get-VisualSendFrame $lock
if (-not $frame.ok) {
  Write-VisualSendResult @{ ok = $false; reason = $frame.reason; sendAttempted = $false; conversationVerified = $false; draftVerified = $false; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
}
try {
  $conversation = Test-VisualSendConversation $frame
  if (-not $conversation.ok) {
    Write-VisualSendResult @{ ok = $false; reason = $conversation.reason; sendAttempted = $false; conversationVerified = $false; draftVerified = $false; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
  }
  if ($phase -ceq "preflight") {
    $incomingVerified = $incomingWasVerified -or (Test-VisualSendIncoming $frame)
    if (-not $incomingVerified) {
      Write-VisualSendResult @{ ok = $false; reason = "visual_send_incoming_not_verified"; sendAttempted = $false; conversationVerified = $true; incomingVerified = $false; draftVerified = $false; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
    }
    Write-VisualSendResult @{ ok = $true; sendAttempted = $false; conversationVerified = $true; incomingVerified = $incomingVerified; draftVerified = $false; verificationMode = "visual_preflight"; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
  }
  if ($phase -ceq "draft") {
    $written = Write-VisualSendDraft $lock
    if (-not $written.ok) {
      Write-VisualSendResult @{ ok = $false; reason = "visual_send_draft_input_failed"; sendAttempted = $false; conversationVerified = $true; draftVerified = $false; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
    }
    Write-VisualSendResult @{ ok = $true; sendAttempted = $false; conversationVerified = $true; draftVerified = $true; verificationMode = "visual_draft_roundtrip"; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
  }
} finally {
  Close-MomentsVisualFrame $frame
}

if ($phase -cne "send") {
  Write-VisualSendResult @{ ok = $false; reason = "visual_send_phase_invalid"; sendAttempted = $false; conversationVerified = $true; draftVerified = $false; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
}

$draft = Read-VisualSendDraft $lock
if (-not $draft.ok -or -not $draft.exact -or [Win32WechatVisualAutoReply]::GetForegroundWindow() -ne $lock.hWnd) {
  Write-VisualSendResult @{ ok = $false; reason = "visual_send_draft_not_verified"; sendAttempted = $false; conversationVerified = $true; draftVerified = $false; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
}

$fresh = Get-VisualSendFrame $lock
if (-not $fresh.ok) {
  Write-VisualSendResult @{ ok = $false; reason = $fresh.reason; sendAttempted = $false; conversationVerified = $true; draftVerified = $true; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
}
$button = $null
try {
  $conversation = Test-VisualSendConversation $fresh
  if (-not $conversation.ok) {
    Write-VisualSendResult @{ ok = $false; reason = "visual_send_conversation_changed"; sendAttempted = $false; conversationVerified = $false; draftVerified = $true; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
  }
  $button = Find-VisualSendButton $fresh
  if (-not $button.ok) {
    Write-VisualSendResult @{ ok = $false; reason = $button.reason; sendAttempted = $false; conversationVerified = $true; draftVerified = $true; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
  }
} finally {
  Close-MomentsVisualFrame $fresh
}

if ([Win32WechatVisualAutoReply]::GetForegroundWindow() -ne $lock.hWnd -or
  -not (Test-VisualSendOwnedPoint $lock ([int]$button.point.x) ([int]$button.point.y))) {
  Write-VisualSendResult @{ ok = $false; reason = "visual_send_button_not_owned"; sendAttempted = $false; conversationVerified = $true; draftVerified = $true; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
}
$guard = Get-VisualSendFrame $lock
if (-not $guard.ok) {
  Write-VisualSendResult @{ ok = $false; reason = $guard.reason; sendAttempted = $false; conversationVerified = $true; draftVerified = $true; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
}
$latestIncomingStillCurrent = $false
try {
  $guardConversation = Test-VisualSendConversation $guard
  $latestIncomingStillCurrent = $guardConversation.ok -and (Test-VisualSendLatestIncoming $guard)
} finally {
  Close-MomentsVisualFrame $guard
}
if (-not $latestIncomingStillCurrent) {
  Write-VisualSendResult @{ ok = $false; reason = "visual_send_incoming_changed"; sendAttempted = $false; conversationVerified = $true; draftVerified = $true; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
}
$screenX = [int]($lock.rect.Left + [int]$button.point.x)
$screenY = [int]($lock.rect.Top + [int]$button.point.y)
$oldPoint = New-Object Win32WechatVisualAutoReply+POINT
[void][Win32WechatVisualAutoReply]::GetCursorPos([ref]$oldPoint)
$moved = [Win32WechatVisualAutoReply]::SetCursorPos($screenX, $screenY)
Start-Sleep -Milliseconds 50
$actualPoint = New-Object Win32WechatVisualAutoReply+POINT
$cursorExact = $moved -and [Win32WechatVisualAutoReply]::GetCursorPos([ref]$actualPoint) -and
  [Math]::Abs($actualPoint.X - $screenX) -le 1 -and [Math]::Abs($actualPoint.Y - $screenY) -le 1
if (-not $cursorExact -or [Win32WechatVisualAutoReply]::GetForegroundWindow() -ne $lock.hWnd -or
  -not (Test-VisualSendOwnedPoint $lock ([int]$button.point.x) ([int]$button.point.y))) {
  [void][Win32WechatVisualAutoReply]::SetCursorPos($oldPoint.X, $oldPoint.Y)
  Write-VisualSendResult @{ ok = $false; reason = "visual_send_cursor_not_verified"; sendAttempted = $false; conversationVerified = $true; draftVerified = $true; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
}

$sendAttempted = $true
[Win32WechatVisualAutoReply]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 35
[Win32WechatVisualAutoReply]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
[void][Win32WechatVisualAutoReply]::SetCursorPos($oldPoint.X, $oldPoint.Y)
Start-Sleep -Milliseconds 550

$postLock = Get-VisualSendLock
if (-not $postLock.ok) {
  Write-VisualSendResult @{ ok = $false; reason = "visual_send_outcome_unknown"; outcomeUnknown = $true; sendAttempted = $true; conversationVerified = $false; draftVerified = $true; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
}
$postFrame = Get-VisualSendFrame $postLock
$sameConversation = $false
$bubbleVerified = $false
if ($postFrame.ok) {
  try {
    $sameConversation = (Test-VisualSendConversation $postFrame).ok
    if ($sameConversation) { $bubbleVerified = Test-VisualSendOutgoingBubble $postFrame }
  } finally {
    Close-MomentsVisualFrame $postFrame
  }
}
$afterDraft = Read-VisualSendDraft $postLock
$draftConsumed = $afterDraft.ok -and $afterDraft.empty
$verificationMode = if ($sameConversation -and $bubbleVerified -and $draftConsumed) {
  "visual_message_bubble"
} elseif ($sameConversation -and $draftConsumed) {
  "draft_consumed_same_header"
} else {
  ""
}
if (-not $sameConversation -or -not $draftConsumed) {
  Write-VisualSendResult @{ ok = $false; reason = "visual_send_outcome_unknown"; outcomeUnknown = $true; sendAttempted = $true; conversationVerified = $sameConversation; draftVerified = $true; draftConsumed = $draftConsumed; verificationMode = $verificationMode; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
}
Write-VisualSendResult @{ ok = $true; sendAttempted = $true; conversationVerified = $true; draftVerified = $true; draftConsumed = $true; bubbleVerified = $bubbleVerified; verificationMode = $verificationMode; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
`;

function visualSendEnvironment(options, phase) {
  return {
    XIAOXI_VISUAL_SEND_PID: String(options.pid ?? ""),
    XIAOXI_VISUAL_SEND_HWND: String(options.hWnd ?? ""),
    XIAOXI_VISUAL_SEND_CONVERSATION: String(options.conversation ?? ""),
    XIAOXI_VISUAL_SEND_INCOMING: String(options.incomingMessage ?? ""),
    // The controller's strict line/pixel proof avoids a second incompatible
    // preflight crop. The send phase still checks that this text remains the
    // latest incoming line immediately before the click.
    XIAOXI_VISUAL_SEND_INCOMING_VERIFIED: options.incomingVerified === true ? "true" : "false",
    XIAOXI_VISUAL_SEND_REPLY: String(options.reply ?? ""),
    XIAOXI_VISUAL_SEND_PHASE: phase
  };
}

function normalizeVisualSendResult(result, fallback) {
  return {
    ok: result?.ok === true,
    send_attempted: result?.sendAttempted === true,
    conversationVerified: result?.conversationVerified === true,
    draftVerified: result?.draftVerified === true,
    verificationMode: String(result?.verificationMode ?? ""),
    pid: Number(result?.pid ?? fallback.pid),
    hWnd: Number(result?.hWnd ?? fallback.hWnd),
    ...(result?.reason ? { reason: String(result.reason) } : {}),
    ...(result?.outcomeUnknown === true ? { outcomeUnknown: true } : {})
  };
}

function createVisualAutoReplySender({
  powerShellRunner = runPowerShellAsync,
  draftInput = null
} = {}) {
  return async function sendVisualAutoReplyWithDependencies(options = {}) {
    const pid = Number(options.pid);
    const hWnd = Number(options.hWnd);
    const conversation = String(options.conversation ?? "").trim();
    const reply = String(options.reply ?? "");
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(hWnd) || hWnd <= 0
      || !conversation || !reply.trim() || reply.length > 4000) {
      return normalizeVisualSendResult({ reason: "visual_send_context_invalid" }, { pid, hWnd });
    }
    const request = { ...options, pid, hWnd, conversation, reply };
    const preflight = await powerShellRunner(
      WECHAT_VISUAL_AUTO_REPLY_POWERSHELL,
      visualSendEnvironment(request, "preflight"),
      { ensure: false, sta: true, timeout: 60_000 }
    );
    if (!preflight?.ok) return normalizeVisualSendResult(preflight, request);
    if (request.incomingVerified !== true && String(request.incomingMessage ?? "").trim() && preflight.incomingVerified !== true) {
      return normalizeVisualSendResult({
        reason: "visual_send_incoming_not_verified",
        conversationVerified: true
      }, request);
    }

    const draft = typeof draftInput === "function"
      ? await draftInput(reply, { pid, hWnd })
      : await powerShellRunner(
        WECHAT_VISUAL_AUTO_REPLY_POWERSHELL,
        visualSendEnvironment(request, "draft"),
        { ensure: false, sta: true, timeout: 45_000 }
      );
    if (!draft?.ok || draft.draftVerified !== true) {
      return normalizeVisualSendResult({
        reason: draft?.reason || draft?.draftCheck || "visual_send_draft_input_failed",
        conversationVerified: true
      }, request);
    }

    if (typeof options.beforeSend === "function") {
      let allowed;
      try {
        allowed = await options.beforeSend({ pid, hWnd, conversation, incomingMessage: String(options.incomingMessage ?? ""), reply });
      } catch {
        return normalizeVisualSendResult({ reason: "visual_send_before_send_failed", conversationVerified: true, draftVerified: true }, request);
      }
      if (allowed === false || allowed?.ok === false) {
        return normalizeVisualSendResult({ reason: "visual_send_cancelled", conversationVerified: true, draftVerified: true }, request);
      }
    }

    let sent = await powerShellRunner(
      WECHAT_VISUAL_AUTO_REPLY_POWERSHELL,
      visualSendEnvironment(request, "send"),
      { ensure: false, sta: true, timeout: 75_000 }
    );
    if (!sent || typeof sent.sendAttempted !== "boolean") {
      sent = {
        ok: false,
        reason: sent?.reason || "visual_send_outcome_unknown",
        outcomeUnknown: true,
        sendAttempted: true,
        conversationVerified: true,
        draftVerified: true,
        pid,
        hWnd
      };
    }
    return normalizeVisualSendResult(sent, request);
  };
}

const sendVisualAutoReply = createVisualAutoReplySender();

module.exports = {
  WECHAT_VISUAL_AUTO_REPLY_POWERSHELL,
  createVisualAutoReplySender,
  sendVisualAutoReply
};
