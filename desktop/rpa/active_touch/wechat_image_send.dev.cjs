const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { writeJsonAtomic } = require("../../src/main/atomic-file.cjs");
const { runPowerShellAsync } = require("./wechat_window_driver.cjs");
const { WECHAT_SEND_OBSERVATION_SCRIPT, WECHAT_SEND_BUTTON_OFFSETS, sendMessageEnvironment } = require("./wechat_window_driver.dev.cjs");

// Reuse the text sender's conversation and composer adapter. Images add only
// clipboard image proof and WeChat's native preview/inline draft handling.
const IMAGE_SEND_SCRIPT = `$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1/.NET Framework lacks the newer environment tick API. Use a
# process-relative Stopwatch clock so stage deadlines stay monotonic and bounded.
$script:imageClockStart = [System.Diagnostics.Stopwatch]::GetTimestamp()
function Get-UptimeMs {
  $delta = [System.Diagnostics.Stopwatch]::GetTimestamp() - $script:imageClockStart
  $frequency = [System.Diagnostics.Stopwatch]::Frequency
  [long](($delta / $frequency) * 1000 + (($delta % $frequency) * 1000 / $frequency))
}
[void]($script:imageScriptStartedAt = Get-UptimeMs)
[Console]::Error.WriteLine("image_send_stage:script_started")
[Console]::Error.WriteLine("image_preload:observation_start")
${WECHAT_SEND_OBSERVATION_SCRIPT}
[Console]::Error.WriteLine("image_preload:observation_finish elapsed_ms=" + (Get-UptimeMs - $script:imageScriptStartedAt))
[Console]::Error.WriteLine("image_preload:image_add_type_start")
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32WechatImage {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern bool OpenClipboard(IntPtr hWndNewOwner);
  [DllImport("user32.dll")] public static extern bool CloseClipboard();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
  public static uint InputTick() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); if (!GetLastInputInfo(ref i)) throw new Exception("image_input_unavailable"); return i.dwTime; }
}
"@
[Console]::Error.WriteLine("image_preload:image_add_type_finish elapsed_ms=" + (Get-UptimeMs - $script:imageScriptStartedAt))
$imagePath = $env:XIAOXI_IMAGE_PATH
$expectedImageHash = $env:XIAOXI_IMAGE_SHA256
$script:inputTick = [Win32WechatImage]::InputTick()
$script:clipboardOwned = $false
$script:clipboardSequence = [uint32]0
$sendAttempted = $false
$oldClipboard = $null
$sourceImage = $null
$verificationMode = ""
$script:imageStage = "context"
$script:imageClipboardOperation = "none"
$script:imageClipboardWriteAttempts = 0
$script:imageClipboardReadAttempts = 0
[void]($script:imageStageStartedAt = Get-UptimeMs)
$script:imageLeaseSettleIntervalMs = 30
$script:imageLeaseSettleSamples = 2
$script:imageLeaseSettleTimeoutMs = 250
$script:imageClipboardWriteJoinTimeoutMs = 5000
$script:imageStageBudgets = @{
  sentinel_write = 15000; image_load = 60000; clipboard_bitmap = 45000;
  paste = 30000; read_back = 20000; click_send = 30000; post_confirm = 30000
}
function Write-ImageProgress([string]$stage, [string]$status) {
  $elapsed = [Math]::Max(0, (Get-UptimeMs) - $script:imageStageStartedAt)
  $retryIndex = 0; if ($env:XIAOXI_IMAGE_RETRY_INDEX) { [int]::TryParse([string]$env:XIAOXI_IMAGE_RETRY_INDEX, [ref]$retryIndex) | Out-Null }
  $payload = @{ stage = $stage; status = $status; elapsed_ms = $elapsed; clipboard_write_attempts = $script:imageClipboardWriteAttempts; clipboard_read_attempts = $script:imageClipboardReadAttempts; retry_index = $retryIndex; at = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json -Compress
  [Console]::Error.WriteLine("image_progress:" + $payload)
}
function Complete-ImageStage([string]$stage) {
  if ([string]$script:imageStage -ne $stage) { return }
  $elapsed = [Math]::Max(0, (Get-UptimeMs) - $script:imageStageStartedAt)
  Write-ImageProgress $stage "finish"
  $budget = [int]($script:imageStageBudgets[$stage] | ForEach-Object { $_ })
  if ($budget -gt 0 -and $elapsed -gt $budget) { throw "image_stage_timeout" }
}
function Assert-ImageStageBudget {
  $stage = [string]$script:imageStage
  $budget = [int]($script:imageStageBudgets[$stage] | ForEach-Object { $_ })
  if ($budget -gt 0 -and ((Get-UptimeMs) - $script:imageStageStartedAt) -gt $budget) { throw "image_stage_timeout" }
}

function Set-ImageStage([string]$stage) {
  $previous = [string]$script:imageStage
  if ($previous -and $previous -ne "context") {
    Complete-ImageStage $previous
  }
  $script:imageStage = $stage
  [void]($script:imageStageStartedAt = Get-UptimeMs)
  [Console]::Error.WriteLine("image_send_stage:" + $stage)
  if ($script:imageStageBudgets.ContainsKey($stage)) { Write-ImageProgress $stage "start" }
}
function Invoke-ImageClipboardWrite([string]$operation, [scriptblock]$write, [IntPtr]$window) {
  $script:imageClipboardOperation = $operation
  [Console]::Error.WriteLine("image_clipboard_operation:" + $operation)
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    $script:imageClipboardWriteAttempts = [Math]::Max($script:imageClipboardWriteAttempts, $attempt)
    try {
      if (-not [Win32WechatImage]::OpenClipboard([IntPtr]::Zero)) { throw "image_clipboard_probe_failed" }
      [void][Win32WechatImage]::CloseClipboard()
      $writeStarted = Get-UptimeMs
      & $write
      if ((Get-UptimeMs) - $writeStarted -gt $script:imageClipboardWriteJoinTimeoutMs) { throw "image_clipboard_write_timeout" }
      return
    } catch {
      $exception = $_.Exception
      $busy = $false
      for ($depth = 0; $exception -and $depth -lt 6; $depth++) {
        if (("hresult_{0:X8}" -f $exception.HResult) -ceq "hresult_800401D0") { $busy = $true; break }
        $exception = $exception.InnerException
      }
      if (-not $busy -or $attempt -eq 5) { throw }
      Start-Sleep -Milliseconds (80 * $attempt)
      Assert-ImageWindowIdentity $window
    }
  }
}

function Assert-ImageLease {
  if ([Win32WechatImage]::InputTick() -ne $script:inputTick) { throw "wechat_external_input_detected" }
}
function Assert-ImageWindowIdentity([IntPtr]$window) {
  [uint32]$ownerPid = 0
  [void][Win32WechatSendMessage]::GetWindowThreadProcessId($window, [ref]$ownerPid)
  if (-not [Win32WechatSendMessage]::IsWindowVisible($window) -or [string]$ownerPid -ne $expectedPid) { throw "image_window_changed" }
}
function Assert-ImageWindow([IntPtr]$window) { Assert-ImageLease; Assert-ImageWindowIdentity $window; if ([Win32WechatSendMessage]::GetForegroundWindow() -ne $window) { throw "image_window_changed" } }
function Settle-ImageInputLease {
  $started = Get-UptimeMs
  $last = [Win32WechatImage]::InputTick()
  $stable = 0
  do {
    Start-Sleep -Milliseconds $script:imageLeaseSettleIntervalMs
    $current = [Win32WechatImage]::InputTick()
    if ($current -eq $last) { $stable++ } else { $stable = 0; $last = $current }
    if ($stable -ge $script:imageLeaseSettleSamples) { [void]($script:inputTick = $current); return }
  } while ((Get-UptimeMs) - $started -lt $script:imageLeaseSettleTimeoutMs)
  [void]($script:inputTick = $last)
}
function Set-ImageClipboardOwned {
  [void]($script:clipboardOwned = $true)
  [void]($script:clipboardSequence = [Win32WechatImage]::GetClipboardSequenceNumber())
}
function Image-Fingerprint([System.Drawing.Image]$source) {
  $bitmap = New-Object System.Drawing.Bitmap($source.Width, $source.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.DrawImageUnscaled($source, 0, 0)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $bitmap.Width, $bitmap.Height)
    $data = $bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $bytes = New-Object byte[] ([Math]::Abs($data.Stride) * $data.Height)
      [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
      $sha = [Security.Cryptography.SHA256]::Create()
      try { return [Convert]::ToBase64String($sha.ComputeHash($bytes)) } finally { $sha.Dispose() }
    } finally { $bitmap.UnlockBits($data) }
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
function Click-ImagePoint([int]$x, [int]$y, [IntPtr]$window) {
  Assert-ImageWindow $window
  [void][Win32WechatSendMessage]::SetCursorPos($x, $y)
  Settle-ImageInputLease
  $point = New-Object Win32WechatSendMessage+POINT
  if (-not [Win32WechatSendMessage]::GetCursorPos([ref]$point) -or [Math]::Abs($point.X-$x) -gt 1 -or [Math]::Abs($point.Y-$y) -gt 1) { throw "image_click_point_changed" }
  $pointWindow = [Win32WechatSendMessage]::WindowFromPoint($point)
  [uint32]$pointPid = 0
  [void][Win32WechatSendMessage]::GetWindowThreadProcessId($pointWindow, [ref]$pointPid)
  if ([string]$pointPid -ne $expectedPid -or [Win32WechatSendMessage]::GetAncestor($pointWindow, 2) -ne $window) { throw "image_click_point_obscured" }
  Assert-ImageWindow $window
  [Win32WechatSendMessage]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [Win32WechatSendMessage]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  $script:inputTick = [Win32WechatImage]::InputTick()
}
function Image-Keys([string]$keys, [IntPtr]$window) {
  Assert-ImageWindow $window
  [System.Windows.Forms.SendKeys]::SendWait($keys)
  Settle-ImageInputLease
}
function Invoke-ImageClipboardRead([string]$sentinel, [IntPtr]$window) {
  for ($readAttempt = 1; $readAttempt -le 5; $readAttempt++) {
    Assert-ImageStageBudget
    $script:imageClipboardReadAttempts = [Math]::Max($script:imageClipboardReadAttempts, $readAttempt)
    try {
      if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
        $copiedImage = [System.Windows.Forms.Clipboard]::GetImage()
        try { return @{ empty = $false; image = $true; fingerprint = (Image-Fingerprint $copiedImage); width = $copiedImage.Width; height = $copiedImage.Height } }
        finally { $copiedImage.Dispose() }
      }
      if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) { return @{ empty = $false; image = $false; fileDrop = $true } }
      $copiedText = [System.Windows.Forms.Clipboard]::GetText()
      return @{ empty = ($copiedText -ceq $sentinel -or [string]::IsNullOrEmpty($copiedText)); image = $false }
    } catch {
      $exception = $_.Exception
      $busy = $false
      for ($depth = 0; $exception -and $depth -lt 6; $depth++) {
        if (("hresult_{0:X8}" -f $exception.HResult) -ceq "hresult_800401D0") { $busy = $true; break }
        $exception = $exception.InnerException
      }
      if (-not $busy -or $readAttempt -eq 5) { throw }
      Start-Sleep -Milliseconds (40 * $readAttempt)
      Assert-ImageWindowIdentity $window
    }
  }
}
function Read-ImageDraft([IntPtr]$window, [bool]$expectImage = $false) {
  Assert-ImageWindow $window
  $sentinel = "xiaoxi-image-copy-" + [Guid]::NewGuid().ToString("N")
  Set-ImageStage "sentinel_write"
  Invoke-ImageClipboardWrite "draft_sentinel_write" { [System.Windows.Forms.Clipboard]::SetText($sentinel) } $window
  Set-ImageClipboardOwned
  Set-ImageStage "read_back"
  Image-Keys "^a" $window
  $copyLimit = $(if ($expectImage) { 5 } else { 1 })
  $lastDraft = @{ empty = $true; image = $false }
  for ($copyAttempt = 1; $copyAttempt -le 5; $copyAttempt++) {
    if ($copyAttempt -gt $copyLimit) { break }
    $script:imageClipboardReadAttempts = [Math]::Max($script:imageClipboardReadAttempts, $copyAttempt)
    $beforeCopySequence = [Win32WechatImage]::GetClipboardSequenceNumber()
    Image-Keys "^c" $window
    $waitUntil = (Get-UptimeMs) + (120 + (80 * $copyAttempt))
  do {
    Assert-ImageStageBudget
      Start-Sleep -Milliseconds 40
      Assert-ImageWindowIdentity $window
      $copySequence = [Win32WechatImage]::GetClipboardSequenceNumber()
    } while ($copySequence -eq $beforeCopySequence -and (Get-UptimeMs) -lt $waitUntil)
    if ($copySequence -eq $beforeCopySequence) {
      if (-not $expectImage) { return @{ empty = $true; image = $false } }
      continue
    }
    Set-ImageClipboardOwned
    Assert-ImageWindow $window
    $lastDraft = Invoke-ImageClipboardRead $sentinel $window
    if ($lastDraft.image) { return $lastDraft }
    if (-not $expectImage) { return $lastDraft }
    Start-Sleep -Milliseconds (80 * $copyAttempt)
      Assert-ImageWindowIdentity $window
    Image-Keys "^a" $window
  }
  return $lastDraft
}
function Observe-ImageConversation {
  $observation = Get-ConversationObservation $mainWindow $expectedConversation $expectedConversationMode
  if (-not $observation.ok -or $observation.token -cne $script:boundToken) { throw "atomic_conversation_changed" }
  return $observation
}
function Image-DialogEvidence([IntPtr]$window) {
  Assert-ImageWindow $window
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $buttons = @()
  $imageCount = 0
  $namedRecipient = $false
  for ($i = 0; $i -lt $all.Count; $i++) {
    $element = $all.Item($i)
    if ($element.Current.IsOffscreen -or [int]$element.Current.ProcessId -ne [int]$expectedPid) { continue }
    $name = [string]$element.Current.Name
    if ($name -ceq $expectedConversation) { $namedRecipient = $true }
    if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Image) { $imageCount++ }
    if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $element.Current.IsEnabled -and $name -match "^(发送(\\([Ss]\\))?|Send)$") { $buttons += $element }
  }
  $owned = [Win32WechatImage]::GetWindow($window, 4) -eq $mainWindow
  if ($buttons.Count -ne 1 -or $imageCount -ne 1 -or (-not $owned -and -not $namedRecipient)) { return $null }
  return $buttons[0].Current.BoundingRectangle
}

try {
  Set-ImageStage "context"
  if ([string]::IsNullOrWhiteSpace($expectedConversation) -or $expectedImageHash -notmatch "^[a-f0-9]{64}$") { throw "image_context_missing" }
  Set-ImageStage "source_file"
  $fileSha = [Security.Cryptography.SHA256]::Create()
  try { $fileHash = [BitConverter]::ToString($fileSha.ComputeHash([IO.File]::ReadAllBytes($imagePath))).Replace("-", "").ToLowerInvariant() }
  finally { $fileSha.Dispose() }
  if ($fileHash -cne $expectedImageHash) { throw "touch_image_changed" }
  Set-ImageStage "window_binding"
  $mainWindow = [IntPtr][int64]$expectedHandle
  Assert-ImageWindow $mainWindow
  $matched = @{ pid = [int]$expectedPid; hWnd = $mainWindow.ToInt64() }
  $initial = Get-ConversationObservation $mainWindow $expectedConversation $expectedConversationMode
  if (-not $initial.ok) { throw "atomic_conversation_changed" }
  $initialTokenMatches = $initial.token -ceq $expectedConversationToken
  $exactSearchBinding = $expectedConversationMode -eq "exact_wechat_id_search" -and ($initial.titleVisible -or $initial.titleMode -eq "visual_header")
  if (-not $initialTokenMatches -and -not $exactSearchBinding) { throw "atomic_conversation_changed" }
  $script:boundToken = $initial.token
  $rect = $initial.rect
  $inputX = [int]($rect.Left + $rect.Width * 0.65)
  $inputY = [int]($rect.Bottom - 105)
  $composer = Get-ComposerObservation $initial.root $rect $inputX $inputY $initial.titleMode
  if (-not $composer.ok) { throw "atomic_composer_not_verified" }
  # Clipboard contents stay in this child process and are restored only while owned.
  Set-ImageStage "clipboard_backup"
  $clipboard = [System.Windows.Forms.Clipboard]::GetDataObject()
  $oldClipboard = New-Object System.Windows.Forms.DataObject
  if ($clipboard) {
    foreach ($format in $clipboard.GetFormats($false)) {
      try { $oldClipboard.SetData($format, $false, $clipboard.GetData($format, $false)) } catch {}
    }
  }
  Set-ImageStage "existing_draft_check"
  Click-ImagePoint $inputX $inputY $mainWindow
  $existingDraft = Read-ImageDraft $mainWindow
  if (-not $existingDraft.empty) {
    # Once a real touch task owns the verified composer, any leftover text or
    # image is stale input. Replace it only after proving the clear completed;
    # never continue with a mixed or unknown draft.
    Set-ImageStage "existing_draft_clear"
    Image-Keys "^a" $mainWindow
    Image-Keys "{BACKSPACE}" $mainWindow
    Start-Sleep -Milliseconds 120
    if (-not (Read-ImageDraft $mainWindow).empty) { throw "image_existing_draft_clear_failed" }
  }
  # Windows' bitmap clipboard does not consistently preserve PNG alpha.
  # Normalize once before both copying and fingerprinting, so the two sides
  # compare the same opaque pixels rather than different alpha conversions.
  Set-ImageStage "image_load"
  $loadedImage = [System.Drawing.Image]::FromFile($imagePath)
  try {
    $sourceImage = New-Object System.Drawing.Bitmap($loadedImage.Width, $loadedImage.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $sourceGraphics = [System.Drawing.Graphics]::FromImage($sourceImage)
    try { $sourceGraphics.Clear([System.Drawing.Color]::White); $sourceGraphics.DrawImageUnscaled($loadedImage, 0, 0) }
    finally { $sourceGraphics.Dispose() }
  } finally { $loadedImage.Dispose() }
  $fingerprint = Image-Fingerprint $sourceImage
  Set-ImageStage "clipboard_bitmap"
  Invoke-ImageClipboardWrite "image_write" { [System.Windows.Forms.Clipboard]::SetImage($sourceImage) } $mainWindow
  Set-ImageClipboardOwned
  [void](Observe-ImageConversation)
  Set-ImageStage "paste"
  Image-Keys "^v" $mainWindow
  Start-Sleep -Milliseconds 350
  Assert-ImageLease
  $sendWindow = [Win32WechatSendMessage]::GetForegroundWindow()
  $dialog = $sendWindow -ne $mainWindow
  if ($dialog) {
    Set-ImageStage "preview_verification"
    # A freshly opened preview must belong to this WeChat conversation.
    $sendRect = $null
    for ($i = 0; $i -lt 12 -and $null -eq $sendRect; $i++) {
      $sendRect = Image-DialogEvidence $sendWindow
      if ($null -eq $sendRect) { Start-Sleep -Milliseconds 150 }
    }
    if ($null -eq $sendRect) { throw "image_preview_not_verified" }
    [void](Observe-ImageConversation)
    $sendX = [int]($sendRect.Left + $sendRect.Width / 2)
    $sendY = [int]($sendRect.Top + $sendRect.Height / 2)
    $verificationMode = "image_preview_consumed"
  } else {
    Set-ImageStage "read_back"
    Click-ImagePoint $inputX $inputY $mainWindow
    $draft = Read-ImageDraft $mainWindow $true
    if (-not $draft.image -or $draft.fingerprint -cne $fingerprint -or $draft.width -ne $sourceImage.Width -or $draft.height -ne $sourceImage.Height) {
      $reason = $(if ($draft.fileDrop) { "image_draft_file_list" } elseif (-not $draft.image) { "image_draft_format_unavailable" } elseif ($draft.width -ne $sourceImage.Width -or $draft.height -ne $sourceImage.Height) { "image_draft_dimensions_changed" } else { "image_draft_pixels_changed" })
      throw $reason
    }
    $current = Observe-ImageConversation
    $dpi = [Win32WechatSendMessage]::GetDpiForWindow($mainWindow)
    if ($dpi -le 0) { $dpi = 96 }
    $sendX = [int]($current.rect.Right - ${WECHAT_SEND_BUTTON_OFFSETS.right} * $dpi / 96.0)
    $sendY = [int]($current.rect.Bottom - ${WECHAT_SEND_BUTTON_OFFSETS.bottom} * $dpi / 96.0)
    $verificationMode = "image_draft_consumed"
  }
  Set-ImageStage "click_send"
  Assert-ImageWindow $sendWindow
  # Mark uncertainty before entering the only irreversible click.
  $sendAttempted = $true
  Click-ImagePoint $sendX $sendY $sendWindow
  Set-ImageStage "post_confirm"
  $confirmed = $false
  for ($i = 0; $i -lt 15 -and -not $confirmed; $i++) {
    Start-Sleep -Milliseconds 200
    Assert-ImageLease
    if ([Win32WechatSendMessage]::GetForegroundWindow() -ne $mainWindow) { continue }
    if ($dialog -and [Win32WechatSendMessage]::IsWindowVisible($sendWindow)) { continue }
    $after = Observe-ImageConversation
    $afterComposer = Get-ComposerObservation $after.root $after.rect $inputX $inputY $after.titleMode
    if (-not $afterComposer.ok) { throw "atomic_composer_changed" }
    Click-ImagePoint $inputX $inputY $mainWindow
    $confirmed = (Read-ImageDraft $mainWindow).empty
  }
  if (-not $confirmed) { throw "image_send_not_confirmed" }
  Complete-ImageStage "post_confirm"
  @{ ok = $true; sendAttempted = $true; verificationMode = $verificationMode; conversationVerified = $true; draftVerified = $true } | ConvertTo-Json -Compress
} catch {
  $reason = [string]$_.Exception.Message
  if ($reason -notmatch "^[a-z][a-z0-9_]{1,79}$") { $reason = "image_driver_failed" }
  try { Complete-ImageStage $script:imageStage } catch {}
  $ruleId = switch ($script:imageStage) {
    "context" { "image-r001" }
    "source_file" { "image-r002" }
    "window_binding" { "image-r003" }
    "clipboard_backup" { "image-r004" }
    "existing_draft_check" { "image-r005" }
    "existing_draft_clear" { "image-r013" }
    "sentinel_write" { if ($reason -eq "image_stage_timeout") { "image-r014" } else { "image-r016" } }
    "image_load" { "image-r006" }
    "clipboard_bitmap" { "image-r007" }
    "paste" { "image-r008" }
    "preview_verification" { "image-r009" }
    "read_back" { "image-r010" }
    "click_send" { "image-r011" }
    "post_confirm" { "image-r012" }
    default { "image-r099" }
  }
  [void](Write-XiaoxiFailure $ruleId $reason)
  # Keep diagnostic identifiers locally, never clipboard contents or exception text.
  $errorId = ([string]$_.FullyQualifiedErrorId -split ",")[0]
  if ($errorId -notmatch "^[A-Za-z0-9_.-]{1,120}$") { $errorId = "unknown" }
  $errorType = [string]$_.Exception.GetType().FullName
  if ($errorType -notmatch "^[A-Za-z0-9_.-]{1,120}$") { $errorType = "unknown" }
  $errorHResult = ('hresult_{0:X8}' -f $_.Exception.HResult)
  $scriptLine = $_.InvocationInfo.ScriptLineNumber
  $sourceLine = if ($script:imageStage -eq "read_back" -and $reason -eq "wechat_external_input_detected") { 177 } elseif ($reason -eq "wechat_external_input_detected") { 85 } else { $null }
  @{ ok = $false; reason = $reason; sendAttempted = $sendAttempted; ruleId = $ruleId; driverStage = $script:imageStage; clipboardOperation = $script:imageClipboardOperation; clipboardWriteAttempts = $script:imageClipboardWriteAttempts; clipboardReadAttempts = $script:imageClipboardReadAttempts; script_line = $scriptLine; source_file = "desktop/rpa/active_touch/wechat_image_send.dev.cjs"; source_line = $sourceLine; errorLine = $scriptLine; errorId = $errorId; errorType = $errorType; errorHResult = $errorHResult } | ConvertTo-Json -Compress
} finally {
  if ($sourceImage) { $sourceImage.Dispose() }
  if ($script:clipboardOwned -and [Win32WechatImage]::GetClipboardSequenceNumber() -eq $script:clipboardSequence) {
    try { if ($oldClipboard -and $oldClipboard.GetFormats().Length -gt 0) { [System.Windows.Forms.Clipboard]::SetDataObject($oldClipboard, $true) } else { [System.Windows.Forms.Clipboard]::Clear() } } catch {}
  }
}
`;

async function sendWechatImage({ baseDir, attemptId, image, context, onTransition, isExecutionAllowed, runner = runPowerShellAsync }) {
  const allowed = async () => !isExecutionAllowed || await isExecutionAllowed() === true;
  const failure = (reason, attempted = false, detail = {}) => ({ ok: false, blocked_reason: reason, send_attempted: attempted,
    ...detail,
    error: attempted === false ? "图片尚未发送，请检查微信中的草稿或图片预览。" : "图片发送结果无法确认，请查看微信；不会自动补发。" });
  if (!baseDir || !attemptId) return failure("image_attempt_context_missing");
  const receiptFile = path.join(baseDir, "image-send.json");
  const binding = crypto.createHash("sha256").update(JSON.stringify([attemptId, image?.sha256])).digest("hex");
  const saveReceipt = (status, detail = {}) => writeJsonAtomic(receiptFile, { binding, status, updatedAt: new Date().toISOString(),
    ...(Number.isInteger(detail.errorLine) ? { errorLine: detail.errorLine } : {}),
    ...(/^[A-Za-z0-9_.-]{1,120}$/.test(detail.errorId || "") ? { errorId: detail.errorId } : {}) });
  try {
    if (fs.existsSync(receiptFile)) {
      const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
      if (receipt.binding !== binding) return failure("image_attempt_changed", null);
      if (receipt.status === "sent_verified") return { ok: true, send_attempted: true, state: { real_send_status: "sent_verified" } };
      if (receipt.status !== "not_attempted") return failure("image_previous_outcome_unknown", null);
    }
  } catch { return failure("image_receipt_unavailable", null); }
  try {
    if (!image?.path || !/^[a-f0-9]{64}$/.test(image.sha256 || "") || crypto.createHash("sha256").update(fs.readFileSync(image.path)).digest("hex") !== image.sha256) return failure("touch_image_changed");
  } catch { return failure("touch_image_unavailable"); }
  if (!await allowed()) return failure("workflow_paused");
  // The owning sequence persists prepared before the child can paste or click.
  saveReceipt("prepared");
  onTransition?.("prepared");
  const mergeAttemptDiagnostics = (attempts) => ({
    image_progress: attempts.flatMap(entry => Array.isArray(entry?.image_progress) ? entry.image_progress : []),
    retry_count: Math.max(0, attempts.length - 1),
    image_progress_lost: attempts.some(entry => !Array.isArray(entry?.image_progress) || entry.image_progress.length === 0)
  });
  const deadline = Date.now() + 180_000;
  const runAttempt = async (retryIndex) => {
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs <= 0) return { ok: false, reason: "powershell_timeout", diagnostics: { image_progress: [], image_progress_lost: true } };
    const controller = new AbortController();
    const monitor = setInterval(() => { allowed().then(ok => { if (!ok) controller.abort(); }).catch(() => controller.abort()); }, 100);
    try {
      return await runner(IMAGE_SEND_SCRIPT, {
        ...sendMessageEnvironment(context), XIAOXI_IMAGE_PATH: image.path, XIAOXI_IMAGE_SHA256: image.sha256,
        XIAOXI_IMAGE_RETRY_INDEX: String(retryIndex)
      }, { ensure: false, sta: true, timeout: remainingMs, signal: controller.signal, diagnostics: true });
    } catch { return { ok: false, reason: "image_driver_exception", diagnostics: { image_progress_lost: true } }; }
    finally { clearInterval(monitor); }
  };
  const isTrustedPreClickTimeout = (candidate, retryIndex) => {
    if (candidate?.reason !== "powershell_timeout") return false;
    const progress = Array.isArray(candidate?.diagnostics?.image_progress)
      ? candidate.diagnostics.image_progress.filter(entry => Number(entry?.retry_index) === retryIndex) : [];
    const last = progress.at(-1);
    return Boolean(last && ["sentinel_write", "image_load", "clipboard_bitmap", "paste", "read_back"].includes(last.stage)
      && !progress.some(entry => ["click_send", "post_confirm"].includes(entry.stage)));
  };
  const diagnosticAttempts = [];
  let result = await runAttempt(0);
  diagnosticAttempts.push(result?.diagnostics || {});
  if (isTrustedPreClickTimeout(result, 0)) {
    if (!await allowed()) return failure("workflow_paused", false, { diagnostics: { attempts: diagnosticAttempts } });
    await new Promise(resolve => setTimeout(resolve, 5_000));
    if (!await allowed()) return failure("workflow_paused", false, { diagnostics: { attempts: diagnosticAttempts, retry_count: 0 } });
    result = await runAttempt(1);
    diagnosticAttempts.push(result?.diagnostics || {});
    if (isTrustedPreClickTimeout(result, 1)) {
      return failure("image_send_pre_click_timeout", false, {
        pre_send_retry_exhausted: true,
        diagnostics: { ...mergeAttemptDiagnostics(diagnosticAttempts), retry_exhausted: true }
      });
    }
  }
  if (diagnosticAttempts.length > 1) result = { ...result, diagnostics: { ...(result?.diagnostics || {}), ...mergeAttemptDiagnostics(diagnosticAttempts) } };
  if (result?.ok !== true || result.sendAttempted !== true || result.draftVerified !== true || result.conversationVerified !== true) {
    saveReceipt(result?.sendAttempted === false ? "not_attempted" : "outcome_unknown", result);
    return failure(result?.reason || "image_send_not_confirmed", result?.sendAttempted === false ? false : null, {
      ...(result?.diagnostics ? { diagnostics: result.diagnostics } : {}),
      ...(/^[a-z0-9_.-]{1,100}$/i.test(result?.ruleId || "") ? { rule_id: result.ruleId } : {}),
      ...(/^[a-z][a-z0-9_]{1,79}$/i.test(result?.driverStage || result?.diagnostics?.image_stage || "") ? { driver_stage: result.driverStage || result.diagnostics.image_stage } : {}),
      ...(/^[a-z][a-z0-9_]{1,79}$/i.test(result?.clipboardOperation || result?.diagnostics?.image_clipboard_operation || "") ? { clipboard_operation: result.clipboardOperation || result.diagnostics.image_clipboard_operation } : {}),
      ...(Number.isInteger(result?.clipboardWriteAttempts) && result.clipboardWriteAttempts >= 0 ? { clipboard_write_attempts: result.clipboardWriteAttempts } : {}),
      ...(Number.isInteger(result?.clipboardReadAttempts) && result.clipboardReadAttempts >= 0 ? { clipboard_read_attempts: result.clipboardReadAttempts } : {}),
      ...(Number.isInteger(result?.errorLine) && result.errorLine >= 0 ? { error_line: result.errorLine } : {}),
      ...(/^[A-Za-z0-9_.-]{1,120}$/.test(result?.errorId || "") ? { driver_error_id: result.errorId } : {}),
      ...(/^[A-Za-z0-9_.-]{1,120}$/.test(result?.errorType || "") ? { driver_exception_type: result.errorType } : {}),
      ...(/^hresult_[0-9A-F]{8}$/i.test(result?.errorHResult || "") ? { driver_exception_hresult: result.errorHResult } : {})
    });
  }
  saveReceipt("sent_verified");
  onTransition?.("sent_verified");
  return { ok: true, send_attempted: true, state: { real_send_status: "sent_verified" }, verification_mode: result.verificationMode };
}

module.exports = { IMAGE_SEND_SCRIPT, sendWechatImage };
