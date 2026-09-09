const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { writeJsonAtomic } = require("../../src/main/atomic-file.cjs");
const { runPowerShellAsync } = require("./wechat_window_driver.cjs");
const { WECHAT_SEND_OBSERVATION_SCRIPT, WECHAT_SEND_BUTTON_OFFSETS, sendMessageEnvironment } = require("./wechat_window_driver.dev.cjs");

// Reuse the text sender's conversation and composer adapter. Images add only
// clipboard image proof and WeChat's native preview/inline draft handling.
const IMAGE_SEND_SCRIPT = `$ErrorActionPreference = "Stop"
${WECHAT_SEND_OBSERVATION_SCRIPT}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32WechatImage {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
  public static uint InputTick() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); if (!GetLastInputInfo(ref i)) throw new Exception("image_input_unavailable"); return i.dwTime; }
}
"@
$imagePath = $env:XIAOXI_IMAGE_PATH
$expectedImageHash = $env:XIAOXI_IMAGE_SHA256
$script:inputTick = [Win32WechatImage]::InputTick()
$script:clipboardOwned = $false
$script:clipboardSequence = [uint32]0
$sendAttempted = $false
$oldClipboard = $null
$sourceImage = $null
$verificationMode = ""

function Assert-ImageLease {
  if ([Win32WechatImage]::InputTick() -ne $script:inputTick) { throw "wechat_external_input_detected" }
}
function Assert-ImageWindow([IntPtr]$window) {
  Assert-ImageLease
  [uint32]$ownerPid = 0
  [void][Win32WechatSendMessage]::GetWindowThreadProcessId($window, [ref]$ownerPid)
  if (-not [Win32WechatSendMessage]::IsWindowVisible($window) -or
      [Win32WechatSendMessage]::GetForegroundWindow() -ne $window -or [string]$ownerPid -ne $expectedPid) { throw "image_window_changed" }
}
function Set-ImageClipboardOwned {
  $script:clipboardOwned = $true
  $script:clipboardSequence = [Win32WechatImage]::GetClipboardSequenceNumber()
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
  $script:inputTick = [Win32WechatImage]::InputTick()
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
  $script:inputTick = [Win32WechatImage]::InputTick()
}
function Read-ImageDraft([IntPtr]$window) {
  Assert-ImageWindow $window
  $sentinel = "xiaoxi-image-copy-" + [Guid]::NewGuid().ToString("N")
  [System.Windows.Forms.Clipboard]::SetText($sentinel)
  Set-ImageClipboardOwned
  Image-Keys "^a" $window
  Image-Keys "^c" $window
  Start-Sleep -Milliseconds 120
  Assert-ImageWindow $window
  Set-ImageClipboardOwned
  if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
    $copiedImage = [System.Windows.Forms.Clipboard]::GetImage()
    try { return @{ empty = $false; image = $true; fingerprint = (Image-Fingerprint $copiedImage); width = $copiedImage.Width; height = $copiedImage.Height } }
    finally { $copiedImage.Dispose() }
  }
  if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) { return @{ empty = $false; image = $false; fileDrop = $true } }
  $copiedText = [System.Windows.Forms.Clipboard]::GetText()
  return @{ empty = ($copiedText -ceq $sentinel -or [string]::IsNullOrEmpty($copiedText)); image = $false }
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
  if ([string]::IsNullOrWhiteSpace($expectedConversation) -or $expectedImageHash -notmatch "^[a-f0-9]{64}$") { throw "image_context_missing" }
  $fileSha = [Security.Cryptography.SHA256]::Create()
  try { $fileHash = [BitConverter]::ToString($fileSha.ComputeHash([IO.File]::ReadAllBytes($imagePath))).Replace("-", "").ToLowerInvariant() }
  finally { $fileSha.Dispose() }
  if ($fileHash -cne $expectedImageHash) { throw "touch_image_changed" }
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
  $clipboard = [System.Windows.Forms.Clipboard]::GetDataObject()
  $oldClipboard = New-Object System.Windows.Forms.DataObject
  if ($clipboard) {
    foreach ($format in $clipboard.GetFormats($false)) {
      try { $oldClipboard.SetData($format, $false, $clipboard.GetData($format, $false)) } catch {}
    }
  }
  Click-ImagePoint $inputX $inputY $mainWindow
  if (-not (Read-ImageDraft $mainWindow).empty) { throw "image_existing_draft" }
  # Windows' bitmap clipboard does not consistently preserve PNG alpha.
  # Normalize once before both copying and fingerprinting, so the two sides
  # compare the same opaque pixels rather than different alpha conversions.
  $loadedImage = [System.Drawing.Image]::FromFile($imagePath)
  try {
    $sourceImage = New-Object System.Drawing.Bitmap($loadedImage.Width, $loadedImage.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $sourceGraphics = [System.Drawing.Graphics]::FromImage($sourceImage)
    try { $sourceGraphics.Clear([System.Drawing.Color]::White); $sourceGraphics.DrawImageUnscaled($loadedImage, 0, 0) }
    finally { $sourceGraphics.Dispose() }
  } finally { $loadedImage.Dispose() }
  $fingerprint = Image-Fingerprint $sourceImage
  [System.Windows.Forms.Clipboard]::SetImage($sourceImage)
  Set-ImageClipboardOwned
  [void](Observe-ImageConversation)
  Image-Keys "^v" $mainWindow
  Start-Sleep -Milliseconds 350
  Assert-ImageLease
  $sendWindow = [Win32WechatSendMessage]::GetForegroundWindow()
  $dialog = $sendWindow -ne $mainWindow
  if ($dialog) {
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
    Click-ImagePoint $inputX $inputY $mainWindow
    $draft = Read-ImageDraft $mainWindow
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
  Assert-ImageWindow $sendWindow
  # Mark uncertainty before entering the only irreversible click.
  $sendAttempted = $true
  Click-ImagePoint $sendX $sendY $sendWindow
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
  @{ ok = $true; sendAttempted = $true; verificationMode = $verificationMode; conversationVerified = $true; draftVerified = $true } | ConvertTo-Json -Compress
} catch {
  $reason = [string]$_.Exception.Message
  if ($reason -notmatch "^[a-z][a-z0-9_]{1,79}$") { $reason = "image_driver_failed" }
  # Keep diagnostic identifiers locally, never clipboard contents or exception text.
  $errorId = ([string]$_.FullyQualifiedErrorId -split ",")[0]
  if ($errorId -notmatch "^[A-Za-z0-9_.-]{1,120}$") { $errorId = "unknown" }
  @{ ok = $false; reason = $reason; sendAttempted = $sendAttempted; errorLine = $_.InvocationInfo.ScriptLineNumber; errorId = $errorId } | ConvertTo-Json -Compress
} finally {
  if ($sourceImage) { $sourceImage.Dispose() }
  if ($script:clipboardOwned -and [Win32WechatImage]::GetClipboardSequenceNumber() -eq $script:clipboardSequence) {
    try { if ($oldClipboard -and $oldClipboard.GetFormats().Length -gt 0) { [System.Windows.Forms.Clipboard]::SetDataObject($oldClipboard, $true) } else { [System.Windows.Forms.Clipboard]::Clear() } } catch {}
  }
}
`;

async function sendWechatImage({ baseDir, attemptId, image, context, onTransition, isExecutionAllowed, runner = runPowerShellAsync }) {
  const allowed = async () => !isExecutionAllowed || await isExecutionAllowed() === true;
  const failure = (reason, attempted = false) => ({ ok: false, blocked_reason: reason, send_attempted: attempted,
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
  const controller = new AbortController();
  const monitor = setInterval(() => { allowed().then(ok => { if (!ok) controller.abort(); }).catch(() => controller.abort()); }, 100);
  let result;
  try {
    result = await runner(IMAGE_SEND_SCRIPT, { ...sendMessageEnvironment(context), XIAOXI_IMAGE_PATH: image.path, XIAOXI_IMAGE_SHA256: image.sha256 },
      { ensure: false, sta: true, timeout: 30_000, signal: controller.signal });
  } catch { return failure("image_driver_exception", null); }
  finally { clearInterval(monitor); }
  if (result?.ok !== true || result.sendAttempted !== true || result.draftVerified !== true || result.conversationVerified !== true) {
    saveReceipt(result?.sendAttempted === false ? "not_attempted" : "outcome_unknown", result);
    return failure(result?.reason || "image_send_not_confirmed", result?.sendAttempted === false ? false : null);
  }
  saveReceipt("sent_verified");
  onTransition?.("sent_verified");
  return { ok: true, send_attempted: true, state: { real_send_status: "sent_verified" }, verification_mode: result.verificationMode };
}

module.exports = { IMAGE_SEND_SCRIPT, sendWechatImage };
