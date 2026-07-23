const { MOMENTS_VISUAL_READONLY_POWERSHELL } = require("./moments_visual_probe.dev.cjs");
const { runPowerShellAsync } = require("./wechat_window_driver.cjs");

const WECHAT_VISUAL_AUTO_REPLY_POWERSHELL = String.raw`
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
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
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
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
$expectedConversationEvidence = [Environment]::GetEnvironmentVariable("XIAOXI_VISUAL_SEND_CONVERSATION_EVIDENCE")
try { $allowedConversationNames = @(([Environment]::GetEnvironmentVariable("XIAOXI_VISUAL_SEND_ALLOWED_NAMES") | ConvertFrom-Json)) } catch { $allowedConversationNames = @() }
$expectedIncoming = [Environment]::GetEnvironmentVariable("XIAOXI_VISUAL_SEND_INCOMING")
$expectedIncomingSignature = ([string][Environment]::GetEnvironmentVariable("XIAOXI_VISUAL_SEND_INCOMING_SIGNATURE")).Trim().ToLowerInvariant()
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

function Get-VisualSendEditDistance([string]$left, [string]$right) {
  $left = Normalize-VisualSendText $left; $right = Normalize-VisualSendText $right
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

function Test-VisualSendConversationMatch([string]$expected, [string]$observed) {
  $expected = Normalize-VisualSendText $expected; $observed = Normalize-VisualSendText $observed
  if (-not $expected -or -not $observed) { return $false }
  if ($expected -ceq $observed) { return $true }
  $maximumLength = [Math]::Max($expected.Length, $observed.Length)
  if ([Math]::Min($expected.Length, $observed.Length) -lt 4 -or [Math]::Abs($expected.Length - $observed.Length) -gt 2) { return $false }
  if ($expected[0] -cne $observed[0] -or $expected.Substring($expected.Length - 2) -cne $observed.Substring($observed.Length - 2)) { return $false }
  $maximumDistance = [Math]::Max(1, [int][Math]::Floor($maximumLength * 0.34))
  return (Get-VisualSendEditDistance $expected $observed) -le $maximumDistance
}

$script:VisualSendAllowedNames = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($name in @($allowedConversationNames) + @($expectedConversation)) {
  $normalizedName = Normalize-VisualSendText ([string]$name)
  if ($normalizedName) { [void]$script:VisualSendAllowedNames.Add($normalizedName) }
}
$expectedConversation = Normalize-VisualSendText $expectedConversation
$expectedConversationEvidence = Normalize-VisualSendText $(if ($expectedConversationEvidence) { $expectedConversationEvidence } else { $expectedConversation })

function Resolve-VisualSendAllowedConversation([string]$observed) {
  $observed = Normalize-VisualSendText $observed
  if (-not $observed) { return @{ ok = $false; ambiguous = $false; conversation = ""; observed = "" } }
  $exactMatches = @($script:VisualSendAllowedNames | Where-Object { [string]$_ -ceq $observed })
  if ($exactMatches.Count -eq 1) {
    return @{ ok = $true; ambiguous = $false; conversation = [string]$exactMatches[0]; observed = $observed; exact = $true }
  }
  if ($exactMatches.Count -gt 1) {
    return @{ ok = $false; ambiguous = $true; conversation = ""; observed = $observed; exact = $false }
  }
  $fuzzyMatches = @($script:VisualSendAllowedNames | Where-Object {
    Test-VisualSendConversationMatch ([string]$_) $observed
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

function Test-VisualSendFrozenConversationEvidence([string]$observed) {
  if (-not $expectedConversationEvidence) { return $false }
  return Test-VisualSendConversationMatch $expectedConversationEvidence (Normalize-VisualSendText $observed)
}

function Normalize-VisualSendDraftText([string]$value) {
  $normalized = ([string]$value).Replace([Environment]::NewLine, [string][char]10)
  $normalized = $normalized.Replace([string][char]13, [string][char]10)
  return $normalized.TrimEnd([char[]]@([char]0xFFFC))
}

function Get-VisualSendSha256([string]$value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$value))
    return ([BitConverter]::ToString($digest).Replace("-", "").ToLowerInvariant())
  } finally {
    $sha.Dispose()
  }
}

function Get-VisualSendLock {
  if ($expectedPidText -notmatch '^[1-9][0-9]*$' -or $expectedHWndText -notmatch '^[1-9][0-9]*$' -or
    [string]::IsNullOrWhiteSpace($expectedConversation) -or [string]::IsNullOrWhiteSpace($expectedReply) -or
    ([string]::IsNullOrWhiteSpace($expectedIncoming) -and $expectedIncomingSignature -notmatch '^[a-f0-9]{64}$')) {
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
  if ($process -eq $null -or [int]$actualPid -ne $expectedPid -or
    @("Weixin", "WeChat") -notcontains $process.ProcessName) {
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
  return @{ ok = $true; pid = $expectedPid; hWnd = $hWnd; rect = $rect }
}

function Get-VisualSendFrame($lock) {
  # The Moments reader needs an unobscured full viewport. Auto-reply does not:
  # it validates the composer and send-button points immediately before acting.
  # Requiring nine unrelated window points here makes harmless IME/toast overlays
  # block sending on otherwise compatible PCs.
  $frame = Get-MomentsVisualFrame $lock.hWnd $lock.rect $lock.pid $false $false
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
  if (-not $ocr.ok) {
    return @{ ok = $true; state = "unresolved"; reason = "visual_send_header_ocr_unresolved"; candidates = @() }
  }
  $expected = Normalize-VisualSendText $expectedConversation
  $minimumHeaderCenterX = [Math]::Min(
    [double]$frame.width * 0.38,
    [Math]::Max([double]$frame.width * 0.20, 230.0)
  )
  $candidates = @($ocr.lines | Where-Object {
    $absoluteCenterX = [double]$headerRect.left + [double]$_.bounds.left + ([double]$_.bounds.width / 2.0)
    $absoluteCenterY = [double]$headerRect.top + [double]$_.bounds.top + ([double]$_.bounds.height / 2.0)
    $text = Normalize-VisualSendText ([string]$_.text)
    $text -and $text.Length -le 64 -and
      $absoluteCenterX -ge $minimumHeaderCenterX -and
      $absoluteCenterX -le ([double]$frame.width * 0.78) -and
      $absoluteCenterY -le ([double]$frame.height * 0.13)
  })
  $ambiguousMatch = $false
  $matches = @($candidates | Where-Object {
    $observed = Normalize-VisualSendText ([string]$_.text)
    $resolved = Resolve-VisualSendAllowedConversation $observed
    if ($resolved.ambiguous) { $ambiguousMatch = $true }
    $resolved.ok -and [string]$resolved.conversation -ceq $expected -and
      (Test-VisualSendFrozenConversationEvidence $observed)
  })
  if ($matches.Count -ge 1) {
    return @{ ok = $true; state = "matched"; observed = Normalize-VisualSendText ([string]$matches[0].text); candidates = @($candidates).Count }
  }
  if ($ambiguousMatch) {
    return @{ ok = $true; state = "unresolved"; reason = "visual_send_conversation_ambiguous"; candidates = @($candidates).Count }
  }
  # An empty, noisy or multi-line header is an OCR uncertainty, not proof that
  # WeChat changed conversations. Only one clear title in the title band can
  # establish an explicit different-conversation result.
  $clearCandidates = @($candidates | Where-Object {
    $text = Normalize-VisualSendText ([string]$_.text)
    $text.Length -ge 2 -and $text -notmatch "^[\.·…_\-]+$"
  })
  if ($clearCandidates.Count -eq 1) {
    $observed = Normalize-VisualSendText ([string]$clearCandidates[0].text)
    $maximumLength = [Math]::Max($expected.Length, $observed.Length)
    $distance = Get-VisualSendEditDistance $expected $observed
    # Match the observer contract: a short title or a near OCR alias cannot
    # prove that the operator switched conversations. Treat it as explicitly
    # different only when both titles are long enough and substantially apart.
    $clearlyDifferent = [Math]::Min($expected.Length, $observed.Length) -ge 4 -and
      $maximumLength -gt 0 -and ([double]$distance / [double]$maximumLength) -ge 0.55
    if ($clearlyDifferent) {
      return @{
        ok = $false
        state = "different"
        reason = "visual_send_conversation_different"
        observed = $observed
        candidates = @($candidates).Count
      }
    }
  }
  return @{ ok = $true; state = "unresolved"; reason = "visual_send_conversation_unresolved"; candidates = @($candidates).Count }
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

function Test-VisualSendTimeText([string]$value) {
  $text = Normalize-VisualSendText $value
  if (-not $text) { return $true }
  return $text -match "^(?:[0-2]?[0-9]:[0-5][0-9]|昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天]|[0-9]{1,2}/[0-9]{1,2}|[0-9]{4}/[0-9]{1,2}/[0-9]{1,2})$"
}

function Test-VisualSendSidebarNameLine([string]$lineText, [string]$name) {
  $line = Normalize-VisualSendText $lineText
  $wanted = Normalize-VisualSendText $name
  if (-not $line -or -not $wanted) { return $false }
  if (-not $line.StartsWith($wanted, [StringComparison]::Ordinal)) { return Test-VisualSendConversationMatch $wanted $line }
  $suffix = $line.Substring($wanted.Length)
  return -not $suffix -or (Test-VisualSendTimeText $suffix)
}

function Resolve-VisualSendSidebarConversation([string]$observed) {
  $observed = Normalize-VisualSendText $observed
  if (-not $observed) { return @{ ok = $false; ambiguous = $false; conversation = ""; observed = "" } }
  $strongMatches = @($script:VisualSendAllowedNames | Where-Object {
    $name = Normalize-VisualSendText ([string]$_)
    if (-not $observed.StartsWith($name, [StringComparison]::Ordinal)) { return $false }
    $suffix = $observed.Substring($name.Length)
    return -not $suffix -or (Test-VisualSendTimeText $suffix)
  })
  if ($strongMatches.Count -eq 1) {
    $conversation = Normalize-VisualSendText ([string]$strongMatches[0])
    return @{ ok = $true; ambiguous = $false; conversation = $conversation; observed = $conversation; exact = $true }
  }
  if ($strongMatches.Count -gt 1) {
    return @{ ok = $false; ambiguous = $true; conversation = ""; observed = $observed; exact = $false }
  }
  $fuzzyMatches = @($script:VisualSendAllowedNames | Where-Object {
    Test-VisualSendSidebarNameLine $observed ([string]$_)
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

function Test-VisualSendSelectedSidebarPreview($frame, $lines, [double]$sidebarRight, [double]$logicalScale) {
  $expected = Normalize-VisualSendText $expectedIncoming
  if (-not $expected) { return $false }
  $nameMatches = @($lines | Where-Object {
    $left = [double]$_.bounds.left
    $right = $left + [double]$_.bounds.width
    $top = [double]$_.bounds.top
    $left -ge (42.0 * $logicalScale) -and
      $right -le ($sidebarRight + (8.0 * $logicalScale)) -and
      $top -ge (72.0 * $logicalScale) -and
      $top -le ([double]$frame.height - (42.0 * $logicalScale)) -and
      (Test-VisualSendSidebarNameLine ([string]$_.text) $expectedConversation)
  })
  if ($nameMatches.Count -ne 1) { return $false }
  $nameLine = $nameMatches[0]
  $nameBottom = [double]$nameLine.bounds.top + [double]$nameLine.bounds.height
  $previewCandidates = @($lines | Where-Object {
    $left = [double]$_.bounds.left
    $top = [double]$_.bounds.top
    $right = $left + [double]$_.bounds.width
    $top -ge ($nameBottom - (3.0 * $logicalScale)) -and
      $top -le ([double]$nameLine.bounds.top + (58.0 * $logicalScale)) -and
      $left -ge ([double]$nameLine.bounds.left - (14.0 * $logicalScale)) -and
      $right -le ($sidebarRight + (8.0 * $logicalScale)) -and
      (Test-VisualSendPureMessageText ([string]$_.text))
  } | Sort-Object { [double]$_.bounds.top }, { [double]$_.bounds.left })
  if ($previewCandidates.Count -eq 0) { return $false }
  return (Normalize-VisualSendText ([string]$previewCandidates[0].text)) -ceq $expected
}

function Get-VisualSendSidebarRight([double]$windowWidth, [double]$dpi) {
  if ($dpi -lt 72 -or $dpi -gt 480) { $dpi = 96.0 }
  $scale = $dpi / 96.0
  $expected = 300.0 * $scale
  $compactLimit = [Math]::Max(230.0 * $scale, $windowWidth * 0.45)
  return [Math]::Min($expected, $compactLimit)
}

function Get-VisualSendWindowDpi([IntPtr]$hWnd) {
  $dpi = [double]96
  try {
    $reported = [Win32WechatVisualAutoReply]::GetDpiForWindow($hWnd)
    if ($reported -ge 72 -and $reported -le 480) { $dpi = [double]$reported }
  } catch {}
  return $dpi
}

function Get-VisualSendRowStats($frame, [int]$y, [int]$left, [int]$right) {
  if ($y -lt 0 -or $y -ge $frame.height -or $right -le $left) { return @{ samples = 0; dividerRatio = 0.0; luminance = 0.0 } }
  $samples = 0
  $dividerPixels = 0
  $luminanceTotal = 0.0
  for ($x = [Math]::Max(0, $left); $x -lt [Math]::Min($frame.width, $right); $x += 4) {
    $pixel = Get-MomentsPixel $frame $x $y
    if ($pixel -eq $null) { continue }
    $maximum = [Math]::Max($pixel.r, [Math]::Max($pixel.g, $pixel.b))
    $minimum = [Math]::Min($pixel.r, [Math]::Min($pixel.g, $pixel.b))
    $luminance = ($pixel.r + $pixel.g + $pixel.b) / 3.0
    if (($maximum - $minimum) -le 10 -and $luminance -ge 180 -and $luminance -le 244) { $dividerPixels += 1 }
    $luminanceTotal += $luminance
    $samples += 1
  }
  if ($samples -eq 0) { return @{ samples = 0; dividerRatio = 0.0; luminance = 0.0 } }
  return @{
    samples = $samples
    dividerRatio = [double]$dividerPixels / [double]$samples
    luminance = $luminanceTotal / [double]$samples
  }
}

function Get-VisualSendChatBottom($frame, [double]$sidebarRight) {
  $left = [int][Math]::Max(0, [Math]::Round($sidebarRight + 8.0))
  $right = [int][Math]::Min($frame.width, [Math]::Round([double]$frame.width - 8.0))
  $startY = [int][Math]::Floor([double]$frame.height * 0.55)
  $endY = [int][Math]::Ceiling([double]$frame.height * 0.92)
  $candidateY = -1
  for ($y = $startY; $y -le $endY; $y++) {
    $row = Get-VisualSendRowStats $frame $y $left $right
    if ($row.samples -eq 0 -or $row.dividerRatio -lt 0.72) { continue }
    $above = Get-VisualSendRowStats $frame ([Math]::Max(0, $y - 3)) $left $right
    $below = Get-VisualSendRowStats $frame ([Math]::Min($frame.height - 1, $y + 3)) $left $right
    $contrastsAbove = $row.luminance -le ($above.luminance - 3.0)
    $contrastsBelow = $row.luminance -le ($below.luminance - 3.0)
    if ($contrastsAbove -and $contrastsBelow -and [Math]::Abs($above.luminance - $below.luminance) -le 12.0) {
      $candidateY = $y
    }
  }
  if ($candidateY -ge 0) { return [double][Math]::Max(0, $candidateY - 2) }
  return [double]$frame.height * 0.60
}

function Get-VisualSendIncomingEvidenceSignature($line, [string]$role, [double]$dpi) {
  # Keep the pre-click identity byte-for-byte aligned with the observer. Pixel
  # bounds are diagnostic only: DPI and text reflow must not turn the same
  # customer bubble into a different occurrence.
  $evidenceSeed = [string]::Join([char]10, @(
    "visual-message-semantic-v1",
    (Normalize-VisualSendText ([string]$line.text)),
    $role
  ))
  return Get-VisualSendSha256 $evidenceSeed
}

function Test-VisualSendLatestIncoming($frame, [double]$sidebarRight, [double]$dpi) {
  if ([string]::IsNullOrWhiteSpace($expectedIncoming) -and $expectedIncomingSignature -notmatch "^[a-f0-9]{64}$") { return $false }
  # Use the same full-frame OCR geometry as the scanner. A cropped OCR pass can
  # recognize the same Chinese line differently, while draft input can move the
  # line without changing its identity.
  $ocr = Get-MomentsOcrObservation $frame @{ left = 0.0; top = 0.0; width = [double]$frame.width; height = [double]$frame.height }
  if (-not $ocr.ok) { return $false }
  $chatBottom = Get-VisualSendChatBottom $frame $sidebarRight
  $logicalScale = [Math]::Max(0.5, [Math]::Min(4.0, $dpi / 96.0))
  $messageLines = New-Object System.Collections.Generic.List[object]
  foreach ($line in @($ocr.lines)) {
    if ($line -eq $null -or -not (Test-VisualSendPureMessageText ([string]$line.text))) { continue }
    $left = [double]$line.bounds.left
    $top = [double]$line.bounds.top
    $normalizedLine = Normalize-VisualSendText ([string]$line.text)
    if ($left -lt ($sidebarRight + (14.0 * $logicalScale)) -or $left -ge ([double]$frame.width - (20.0 * $logicalScale)) -or
      $top -lt (108.0 * $logicalScale) -or $top -gt $chatBottom) { continue }
    [void]$messageLines.Add([pscustomobject]@{
      text = $normalizedLine
      left = $left
      top = $top
      width = [double]$line.bounds.width
      height = [double]$line.bounds.height
    })
  }
  if ($messageLines.Count -eq 0) { return $false }
  $latest = @($messageLines.ToArray() | Sort-Object top, left | Select-Object -Last 1)[0]
  $latestRole = Get-VisualSendMessageRole $frame $latest $sidebarRight $logicalScale
  if ($latestRole -cne "user") { return $false }
  if ($expectedIncomingSignature -match "^[a-f0-9]{64}$") {
    # Keep this identity calculation byte-for-byte aligned with the scanner.
    # The sidebar text is the semantic message, while this bubble signature is
    # the final guard against the conversation changing before the send click.
    if ((Get-VisualSendIncomingEvidenceSignature $latest $latestRole $dpi) -ceq $expectedIncomingSignature) { return $true }
  }
  $expectedText = Normalize-VisualSendText $expectedIncoming
  $observedText = Normalize-VisualSendText ([string]$latest.text)
  if ($observedText -ceq $expectedText) { return $true }
  # The observer already accepts bounded OCR drift across two captures. Mirror
  # that contract at preflight so a single glyph such as 清/尚 does not turn a
  # proven customer bubble into an artificial send block.
  if ([Math]::Min($expectedText.Length, $observedText.Length) -lt 4 -or
      [Math]::Abs($expectedText.Length - $observedText.Length) -gt 1) { return $false }
  $maximumLength = [Math]::Max($expectedText.Length, $observedText.Length)
  return (Get-VisualSendEditDistance $expectedText $observedText) -le
    [Math]::Max(1, [int][Math]::Floor($maximumLength * 0.15))
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

function Test-VisualSendSelectedSidebarConversation($frame, [double]$sidebarRight, [double]$dpi) {
  # Header OCR is frequently empty on GPU-rendered WeChat windows. In that
  # case, bind the send to the one expected contact row that is visibly
  # selected. Message preview text is deliberately not part of the identity:
  # two contacts can send the same words and preview OCR may be empty.
  $logicalScale = [Math]::Max(0.5, [Math]::Min(4.0, $dpi / 96.0))
  $ocr = Get-MomentsOcrObservation $frame @{
    left = 0.0
    top = 0.0
    width = [double]$frame.width
    height = [double]$frame.height
  }
  if (-not $ocr.ok) {
    return @{ ok = $false; reason = "visual_send_sidebar_ocr_unresolved"; matches = 0 }
  }

  $nameMatches = New-Object System.Collections.Generic.List[object]
  foreach ($line in @($ocr.lines)) {
    $left = [double]$line.bounds.left
    $right = $left + [double]$line.bounds.width
    $top = [double]$line.bounds.top
    if ($left -lt (42.0 * $logicalScale) -or
        $right -gt ($sidebarRight + (8.0 * $logicalScale)) -or
        $top -lt (72.0 * $logicalScale) -or
        $top -gt ([double]$frame.height - (42.0 * $logicalScale))) { continue }
    $resolved = Resolve-VisualSendSidebarConversation ([string]$line.text)
    if ($resolved.ambiguous) {
      return @{ ok = $false; reason = "visual_send_sidebar_contact_ambiguous"; matches = 0 }
    }
    if ($resolved.ok -and [string]$resolved.conversation -ceq $expectedConversation -and
        (Test-VisualSendFrozenConversationEvidence ([string]$resolved.observed))) {
      [void]$nameMatches.Add($line)
    }
  }
  if ($nameMatches.Count -ne 1) {
    return @{
      ok = $false
      reason = $(if ($nameMatches.Count -gt 1) { "visual_send_sidebar_contact_ambiguous" } else { "visual_send_sidebar_contact_unresolved" })
      matches = $nameMatches.Count
    }
  }

  $nameLine = $nameMatches[0]
  $nameBottom = [double]$nameLine.bounds.top + [double]$nameLine.bounds.height
  $previewCandidates = @($ocr.lines | Where-Object {
    $candidateLeft = [double]$_.bounds.left
    $candidateTop = [double]$_.bounds.top
    $candidateRight = $candidateLeft + [double]$_.bounds.width
    $candidateTop -ge ($nameBottom - (3.0 * $logicalScale)) -and
      $candidateTop -le ([double]$nameLine.bounds.top + (58.0 * $logicalScale)) -and
      $candidateLeft -ge ([double]$nameLine.bounds.left - (14.0 * $logicalScale)) -and
      $candidateRight -le ($sidebarRight + (8.0 * $logicalScale))
  } | Sort-Object { [double]$_.bounds.top }, { [double]$_.bounds.left })

  # Preview OCR is optional. Its bounds only help estimate the selected row's
  # height; when it is absent, use the normal one-line preview height.
  $rowBottom = if ($previewCandidates.Count -gt 0) {
    [double]$previewCandidates[0].bounds.top + [double]$previewCandidates[0].bounds.height
  } else {
    $nameBottom + (20.0 * $logicalScale)
  }
  $stripLeft = [int][Math]::Floor([Math]::Max(0.0, $sidebarRight - (20.0 * $logicalScale)))
  $stripRight = [int][Math]::Ceiling([Math]::Min([double]$frame.width, $sidebarRight - (8.0 * $logicalScale)))
  $stripTop = [int][Math]::Floor([Math]::Max(0.0, [double]$nameLine.bounds.top - (8.0 * $logicalScale)))
  $stripBottom = [int][Math]::Ceiling([Math]::Min([double]$frame.height, $rowBottom + (8.0 * $logicalScale)))
  $greenRatio = Get-VisualSendGreenRatio $frame $stripLeft $stripTop $stripRight $stripBottom
  return @{
    ok = $greenRatio -ge 0.55
    reason = $(if ($greenRatio -ge 0.55) { "" } else { "visual_send_sidebar_contact_not_selected" })
    matches = 1
    greenRatio = $greenRatio
  }
}

function Get-VisualSendConversationBinding($frame, [double]$sidebarRight, [double]$dpi) {
  $header = Test-VisualSendConversation $frame
  if ([string]$header.state -ceq "matched") {
    return @{ ok = $true; proof = "header_title"; headerState = "matched"; selectedRow = $null }
  }
  $selectedRow = Test-VisualSendSelectedSidebarConversation $frame $sidebarRight $dpi
  if ($selectedRow.ok) {
    return @{ ok = $true; proof = "selected_sidebar_row"; headerState = [string]$header.state; selectedRow = $selectedRow }
  }
  return @{
    ok = $false
    reason = "visual_send_conversation_not_bound"
    headerState = [string]$header.state
    headerReason = [string]$header.reason
    selectedRow = $selectedRow
  }
}

function Get-VisualSendLineGreenRatio($frame, $line, [double]$sidebarRight) {
  $paneWidth = [Math]::Max(1.0, [double]$frame.width - $sidebarRight)
  $left = [double]$line.left
  $right = $left + [double]$line.width
  $top = [double]$line.top
  $bottom = $top + [double]$line.height
  $paddingX = [Math]::Max(8.0, $paneWidth * 0.012)
  $paddingY = [Math]::Max(6.0, [double]$frame.height * 0.008)
  return Get-VisualSendGreenRatio $frame ([int]($left - $paddingX)) ([int]($top - $paddingY)) ([int]($right + $paddingX)) ([int]($bottom + $paddingY))
}

function Get-VisualSendMessageRole($frame, $line, [double]$sidebarRight, [double]$logicalScale) {
  $paneWidth = [Math]::Max(1.0, [double]$frame.width - $sidebarRight)
  $left = [double]$line.left
  $right = $left + [double]$line.width
  $top = [double]$line.top
  $bottom = $top + [double]$line.height
  $bubbleLeft = [Math]::Max($sidebarRight, $left - (12.0 * $logicalScale))
  $bubbleTop = [Math]::Max(0.0, $top - (8.0 * $logicalScale))
  $bubbleRight = [Math]::Min([double]$frame.width, $right + (12.0 * $logicalScale))
  $bubbleBottom = [Math]::Min([double]$frame.height, $bottom + (8.0 * $logicalScale))
  $greenRatio = Get-VisualSendGreenRatio $frame ([int][Math]::Floor($bubbleLeft)) ([int][Math]::Floor($bubbleTop)) ([int][Math]::Ceiling($bubbleRight)) ([int][Math]::Ceiling($bubbleBottom))

  # Outgoing bubbles are green. Prefer that local proof over the OCR text's
  # left edge: a long outgoing line can cross the pane midpoint.
  if ($greenRatio -ge 0.16) { return "assistant" }

  # Only clear edge anchors may fall back to geometry. Ambiguous middle lines
  # fail closed instead of becoming new customer messages.
  $rightInset = [Math]::Max((18.0 * $logicalScale), $paneWidth * 0.035)
  if ($right -ge ([double]$frame.width - $rightInset) -and
      $left -ge ($sidebarRight + ($paneWidth * 0.18))) { return "assistant" }
  if ($left -le ($sidebarRight + ($paneWidth * 0.18)) -and
      $right -le ($sidebarRight + ($paneWidth * 0.84))) { return "user" }
  return "unknown"
}

function Test-VisualSendGreenBridge($frame, $upper, $lower) {
  $upperBottom = [int][Math]::Ceiling([double]$upper.top + [double]$upper.height)
  $lowerTop = [int][Math]::Floor([double]$lower.top)
  if ($lowerTop -le $upperBottom) { return $true }
  $upperRight = [double]$upper.left + [double]$upper.width
  $lowerRight = [double]$lower.left + [double]$lower.width
  $x = [int][Math]::Min($frame.width - 1, [Math]::Round([Math]::Max($upperRight, $lowerRight) + 6.0))
  $green = 0
  $samples = 0
  for ($y = $upperBottom; $y -le $lowerTop; $y++) {
    if (Test-VisualSendGreenPixel $frame $x $y) { $green += 1 }
    $samples += 1
  }
  return $samples -gt 0 -and ([double]$green / [double]$samples) -ge 0.72
}

function Test-VisualSendOutgoingLineEvidence($frame, $lines, [string]$reply, [double]$sidebarRight) {
  $wanted = Normalize-VisualSendText $reply
  if (-not $wanted) { return $false }
  $ordered = @($lines | Sort-Object { [double]$_.top }, { [double]$_.left })
  if ($ordered.Count -eq 0) { return $false }
  $latest = $ordered[-1]
  if ((Get-VisualSendLineGreenRatio $frame $latest $sidebarRight) -lt 0.16) { return $false }
  $aggregate = Normalize-VisualSendText ([string]$latest.text)
  if ($aggregate -ceq $wanted) { return $true }
  $lower = $latest
  for ($index = $ordered.Count - 2; $index -ge 0; $index--) {
    $upper = $ordered[$index]
    if ((Get-VisualSendLineGreenRatio $frame $upper $sidebarRight) -lt 0.16) { break }
    if (-not (Test-VisualSendGreenBridge $frame $upper $lower)) { break }
    $aggregate = (Normalize-VisualSendText ([string]$upper.text)) + $aggregate
    if ($aggregate -ceq $wanted) { return $true }
    if ($aggregate.Length -ge $wanted.Length) { break }
    $lower = $upper
  }
  return $false
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

function Clear-VisualSendDraft($lock) {
  if ([Win32WechatVisualAutoReply]::GetForegroundWindow() -ne $lock.hWnd) { return $false }
  $width = [double]($lock.rect.Right - $lock.rect.Left)
  $height = [double]($lock.rect.Bottom - $lock.rect.Top)
  $relativeX = [int]($width * 0.64)
  $relativeY = [int]($height * 0.87)
  if (-not (Test-VisualSendOwnedPoint $lock $relativeX $relativeY)) { return $false }
  try {
    [void][Win32WechatVisualAutoReply]::SetCursorPos([int]($lock.rect.Left + $relativeX), [int]($lock.rect.Top + $relativeY))
    [Win32WechatVisualAutoReply]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 35
    [Win32WechatVisualAutoReply]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 70
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    [System.Windows.Forms.SendKeys]::SendWait("{BACKSPACE}")
    Start-Sleep -Milliseconds 120
    $readback = Read-VisualSendDraft $lock
    return $readback.ok -and $readback.empty
  } catch {
    return $false
  }
}

function Test-VisualSendOutgoingBubble($frame, [double]$sidebarRight) {
  $chatBottom = Get-VisualSendChatBottom $frame $sidebarRight
  $ocr = Get-MomentsOcrObservation $frame @{ left = 0.0; top = 0.0; width = [double]$frame.width; height = [double]$frame.height }
  if (-not $ocr.ok) { return $false }
  $messageLines = New-Object System.Collections.Generic.List[object]
  foreach ($line in @($ocr.lines)) {
    if ($line -eq $null -or -not (Test-VisualSendPureMessageText ([string]$line.text))) { continue }
    $left = [double]$line.bounds.left
    $top = [double]$line.bounds.top
    if ($left -lt ($sidebarRight + 14.0) -or $left -ge ([double]$frame.width * 0.982) -or
        $top -lt ([double]$frame.height * 0.13) -or $top -gt $chatBottom) { continue }
    [void]$messageLines.Add([pscustomobject]@{
      text = Normalize-VisualSendText ([string]$line.text)
      left = $left
      top = $top
      width = [double]$line.bounds.width
      height = [double]$line.bounds.height
    })
  }
  return Test-VisualSendOutgoingLineEvidence $frame @($messageLines.ToArray()) $expectedReply $sidebarRight
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
  $dpi = Get-VisualSendWindowDpi $lock.hWnd
  $sidebarRight = Get-VisualSendSidebarRight ([double]$frame.width) $dpi
  $binding = Get-VisualSendConversationBinding $frame $sidebarRight $dpi
  if (-not $binding.ok) {
    Write-VisualSendResult @{ ok = $false; reason = $binding.reason; sendAttempted = $false; conversationVerified = $false; conversationState = [string]$binding.headerState; draftVerified = $false; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
  }
  if (@("preflight", "draft") -contains $phase) {
    $liveIncomingVerified = Test-VisualSendLatestIncoming $frame $sidebarRight $dpi
    # Never reuse the occurrence observed before DeepSeek generation. Even a
    # matched header must still show the expected latest customer bubble now.
    if (-not $liveIncomingVerified) {
      Write-VisualSendResult @{ ok = $false; reason = "visual_send_incoming_changed"; sendAttempted = $false; conversationVerified = $true; conversationState = [string]$binding.headerState; incomingVerified = $false; draftVerified = $false; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
    }
  }
  if ($phase -ceq "preflight") {
    Write-VisualSendResult @{ ok = $true; sendAttempted = $false; conversationVerified = $true; conversationState = [string]$binding.headerState; incomingVerified = $true; draftVerified = $false; verificationMode = $("visual_preflight_{0}" -f $binding.proof); pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
  }
  if ($phase -ceq "draft") {
    $written = Write-VisualSendDraft $lock
    if (-not $written.ok) {
      Write-VisualSendResult @{ ok = $false; reason = "visual_send_draft_input_failed"; sendAttempted = $false; conversationVerified = $true; conversationState = [string]$binding.headerState; draftVerified = $false; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
    }
    Write-VisualSendResult @{ ok = $true; sendAttempted = $false; conversationVerified = $true; conversationState = [string]$binding.headerState; incomingVerified = $true; draftVerified = $true; verificationMode = $("visual_draft_{0}" -f $binding.proof); pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
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
  $freshDpi = Get-VisualSendWindowDpi $lock.hWnd
  $freshSidebarRight = Get-VisualSendSidebarRight ([double]$fresh.width) $freshDpi
  $freshBinding = Get-VisualSendConversationBinding $fresh $freshSidebarRight $freshDpi
  if (-not $freshBinding.ok) {
    [void](Clear-VisualSendDraft $lock)
    Write-VisualSendResult @{ ok = $false; reason = $freshBinding.reason; sendAttempted = $false; conversationVerified = $false; conversationState = [string]$freshBinding.headerState; draftVerified = $true; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
  }
  $button = Find-VisualSendButton $fresh
  if (-not $button.ok) {
    [void](Clear-VisualSendDraft $lock)
    Write-VisualSendResult @{ ok = $false; reason = $button.reason; sendAttempted = $false; conversationVerified = $true; draftVerified = $true; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
  }
} finally {
  Close-MomentsVisualFrame $fresh
}

if ([Win32WechatVisualAutoReply]::GetForegroundWindow() -ne $lock.hWnd -or
  -not (Test-VisualSendOwnedPoint $lock ([int]$button.point.x) ([int]$button.point.y))) {
  [void](Clear-VisualSendDraft $lock)
  Write-VisualSendResult @{ ok = $false; reason = "visual_send_button_not_owned"; sendAttempted = $false; conversationVerified = $true; draftVerified = $true; pid = $lock.pid; hWnd = $lock.hWnd.ToInt64() }
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
  [void](Clear-VisualSendDraft $lock)
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
    $postConversation = Test-VisualSendConversation $postFrame
    $sameConversation = [string]$postConversation.state -cne "different"
    if ($sameConversation) {
      $postDpi = Get-VisualSendWindowDpi $postLock.hWnd
      $postSidebarRight = Get-VisualSendSidebarRight ([double]$postFrame.width) $postDpi
      $bubbleVerified = Test-VisualSendOutgoingBubble $postFrame $postSidebarRight
    }
  } finally {
    Close-MomentsVisualFrame $postFrame
  }
}
$afterDraft = Read-VisualSendDraft $postLock
$draftConsumed = $afterDraft.ok -and $afterDraft.empty
$verificationMode = if ($sameConversation -and $bubbleVerified -and $draftConsumed) {
  "visual_message_bubble"
} elseif ($sameConversation -and $draftConsumed) {
  # Keep the established verification-mode value for controller compatibility;
  # sameConversation here means the expected HWND was retained and no explicit
  # different title was observed, even when title OCR itself was unresolved.
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
    XIAOXI_VISUAL_SEND_CONVERSATION_EVIDENCE: String(options.conversationEvidence ?? options.conversation ?? ""),
    XIAOXI_VISUAL_SEND_ALLOWED_NAMES: JSON.stringify(Array.isArray(options.conversationAliases) ? options.conversationAliases : [options.conversation].filter(Boolean)),
    XIAOXI_VISUAL_SEND_INCOMING: String(options.incomingMessage ?? ""),
    XIAOXI_VISUAL_SEND_INCOMING_SIGNATURE: String(options.incomingMessageSignature ?? ""),
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
    ...(result?.outcomeUnknown === true ? { outcomeUnknown: true } : {}),
    ...(String(result?.conversationState ?? "") ? { conversationState: String(result.conversationState) } : {})
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
    const conversationEvidence = String(options.conversationEvidence ?? conversation).trim();
    const conversationAliases = [...new Set((Array.isArray(options.conversationAliases) ? options.conversationAliases : [conversation])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean))];
    if (!conversationAliases.includes(conversation)) conversationAliases.push(conversation);
    const incomingMessage = String(options.incomingMessage ?? "").trim();
    const incomingMessageSignature = String(options.incomingMessageSignature ?? "").trim().toLowerCase();
    const reply = String(options.reply ?? "");
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(hWnd) || hWnd <= 0
      || !conversation || !conversationEvidence || !conversationAliases.length || !reply.trim() || reply.length > 4000
      || (!incomingMessage && !/^[a-f0-9]{64}$/u.test(incomingMessageSignature))) {
      return normalizeVisualSendResult({ reason: "visual_send_context_invalid" }, { pid, hWnd });
    }
    const request = {
      ...options,
      pid,
      hWnd,
      conversation,
      conversationEvidence,
      conversationAliases,
      incomingMessage,
      incomingMessageSignature,
      reply
    };
    const preflight = await powerShellRunner(
      WECHAT_VISUAL_AUTO_REPLY_POWERSHELL,
      visualSendEnvironment(request, "preflight"),
      { ensure: false, sta: true, timeout: 60_000 }
    );
    if (!preflight?.ok) return normalizeVisualSendResult(preflight, request);
    if (preflight.incomingVerified !== true) {
      return normalizeVisualSendResult({
        reason: "visual_send_incoming_changed",
        conversationVerified: false
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

    let sent;
    try {
      sent = await powerShellRunner(
        WECHAT_VISUAL_AUTO_REPLY_POWERSHELL,
        visualSendEnvironment(request, "send"),
        { ensure: false, sta: true, timeout: 75_000 }
      );
    } catch {
      // The click lives inside this final phase, so a timeout/rejection cannot
      // prove that nothing was sent. Report an attempted unknown outcome and
      // let the controller fence the turn instead of retrying.
      sent = {
        ok: false,
        reason: "visual_send_outcome_unknown",
        outcomeUnknown: true,
        sendAttempted: true,
        conversationVerified: true,
        draftVerified: true,
        pid,
        hWnd
      };
    }
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
