const {
  focusWechatWindow,
  focusWechatWindowAsync,
  runPowerShell,
  runPowerShellAsync,
  verifyWechatCurrentConversation: verifyWechatCurrentConversationSafe,
  verifyWechatCurrentConversationAsync: verifyWechatCurrentConversationSafeAsync
} = require("./wechat_window_driver.cjs");

const SEND_MESSAGE_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32WechatSendMessage {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@
$expectedPid = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID")
$expectedHandle = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_HWND")
$expectedConversation = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_CONVERSATION")
$expectedConversationMode = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_CONVERSATION_MODE")
$expectedConversationToken = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_CONVERSATION_TOKEN")
$expectedMessage = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_MESSAGE")
$expectedIncomingMessage = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_INCOMING_MESSAGE")
$expectedIncomingRuntimeId = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_INCOMING_RUNTIME_ID")
$inputXText = [Environment]::GetEnvironmentVariable("XIAOXI_INPUT_X_RATIO")
$inputYText = [Environment]::GetEnvironmentVariable("XIAOXI_INPUT_Y_RATIO")

function Normalize-WechatDraftText([string]$value) {
  $normalized = ([string]$value).Replace([Environment]::NewLine, [string][char]10)
  $normalized = $normalized.Replace([string][char]13, [string][char]10)
  return $normalized.TrimEnd([char[]]@([char]0xFFFC))
}

$normalizedExpectedMessage = Normalize-WechatDraftText $expectedMessage

function Get-ElementText([System.Windows.Automation.AutomationElement]$element) {
  try {
    $name = [string]$element.Current.Name
    if (-not [string]::IsNullOrWhiteSpace($name)) { return $name.Trim() }
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($pattern -and -not [string]::IsNullOrWhiteSpace($pattern.Current.Value)) { return ([string]$pattern.Current.Value).Trim() }
  } catch {}
  return ""
}

function Get-ElementKey([System.Windows.Automation.AutomationElement]$element, $rect, [string]$text) {
  try {
    $runtimeId = $element.GetRuntimeId()
    if ($runtimeId -and $runtimeId.Count -gt 0) { return [string]($runtimeId -join ".") }
  } catch {}
  return [string]("rect:{0}:{1}:{2}:{3}:{4}" -f [int]$rect.Left, [int]$rect.Top, [int]$rect.Right, [int]$rect.Bottom, $text)
}

function Get-ConversationObservation([IntPtr]$hWnd, [string]$expectedTitle, [string]$verificationMode) {
  $freshRoot = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd)
  if ($freshRoot -eq $null) { return @{ ok = $false; reason = "automation_root_missing" } }
  try { $freshRect = $freshRoot.Current.BoundingRectangle } catch { return @{ ok = $false; reason = "automation_root_missing" } }
  # WeChat 4.1's left session list occupies roughly the first third of the window.
  # Keep the identity token wholly inside the chat header so a sidebar [Draft]
  # preview cannot change the active-conversation fingerprint.
  $headerLeft = $freshRect.Left + ($freshRect.Width * 0.36)
  $titleVisible = $false
  try {
    $freshAll = $freshRoot.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    for ($index = 0; $index -lt $freshAll.Count; $index++) {
      $candidate = $freshAll.Item($index)
      if ((Get-ElementText $candidate) -cne $expectedTitle) { continue }
      try { $candidateRect = $candidate.Current.BoundingRectangle } catch { continue }
      if (-not $candidate.Current.IsOffscreen -and $candidateRect.Left -ge $headerLeft -and $candidateRect.Top -ge ($freshRect.Top + 25) -and $candidateRect.Top -le ($freshRect.Top + 125)) {
        $titleVisible = $true
        break
      }
    }
  } catch {}

  $visualHash = ""
  try {
    $captureLeft = [int]$headerLeft
    $captureTop = [int]($freshRect.Top + 28)
    $captureRight = [int]($freshRect.Left + ($freshRect.Width * 0.78))
    $captureBottom = [int][Math]::Min($freshRect.Bottom - 1, $freshRect.Top + 112)
    $captureWidth = $captureRight - $captureLeft
    $captureHeight = $captureBottom - $captureTop
    if ($captureWidth -ge 120 -and $captureHeight -ge 40) {
      $bitmap = New-Object System.Drawing.Bitmap($captureWidth, $captureHeight)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($captureLeft, $captureTop, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
      $stream = New-Object System.IO.MemoryStream
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $sha = [System.Security.Cryptography.SHA256]::Create()
      $visualHash = -join ($sha.ComputeHash($stream.ToArray()) | ForEach-Object { $_.ToString("x2") })
      $sha.Dispose()
      $stream.Dispose()
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  } catch { $visualHash = "" }

  $visualMode = $verificationMode -eq "exact_wechat_id_search"
  $verified = -not [string]::IsNullOrWhiteSpace($visualHash) -and ($visualMode -or $titleVisible)
  return @{
    ok = $verified
    reason = $(if ($verified) { "" } elseif ([string]::IsNullOrWhiteSpace($visualHash)) { "conversation_visual_token_unavailable" } else { "atomic_conversation_changed" })
    titleVisible = $titleVisible
    titleMode = $(if ($titleVisible) { "uia_header" } else { "visual_header" })
    token = $(if ([string]::IsNullOrWhiteSpace($visualHash)) { "" } else { "conversation:v1:$($matched.pid):$($matched.hWnd):$visualHash" })
    root = $freshRoot
    rect = $freshRect
  }
}

function Get-ComposerObservation([System.Windows.Automation.AutomationElement]$freshRoot, $freshRect, [int]$x, [int]$y, [string]$verificationMode) {
  $chatLeft = $freshRect.Left + [Math]::Max(240, $freshRect.Width * 0.22)
  $composerTop = $freshRect.Top + ($freshRect.Height * 0.64)
  $pointInsideComposer = $x -ge $chatLeft -and $x -lt $freshRect.Right -and $y -ge $composerTop -and $y -lt ($freshRect.Bottom - 18)
  if (-not $pointInsideComposer) { return @{ ok = $false; reason = "atomic_composer_point_invalid" } }
  $point = New-Object Win32WechatSendMessage+POINT
  $point.X = $x
  $point.Y = $y
  $pointWindow = [Win32WechatSendMessage]::WindowFromPoint($point)
  if ($pointWindow -eq [IntPtr]::Zero -or [Win32WechatSendMessage]::GetAncestor($pointWindow, 2).ToInt64() -ne [int64]$matched.hWnd) {
    return @{ ok = $false; reason = "atomic_composer_obscured" }
  }
  [uint32]$pointProcessId = 0
  [void][Win32WechatSendMessage]::GetWindowThreadProcessId($pointWindow, [ref]$pointProcessId)
  $pointClass = New-Object System.Text.StringBuilder 256
  [void][Win32WechatSendMessage]::GetClassName($pointWindow, $pointClass, $pointClass.Capacity)
  $pointRect = New-Object Win32WechatSendMessage+RECT
  $pointRectAvailable = [Win32WechatSendMessage]::GetWindowRect($pointWindow, [ref]$pointRect)
  $pointClassName = $pointClass.ToString()
  $renderChildClass = $pointClassName.StartsWith("MMUIRender", [System.StringComparison]::Ordinal)
  $wechatQtRootClass = $pointWindow.ToInt64() -eq [int64]$matched.hWnd -and
    $pointClassName.StartsWith("Qt", [System.StringComparison]::Ordinal) -and
    $pointClassName.EndsWith("QWindowIcon", [System.StringComparison]::Ordinal)
  $renderSurfaceOwnsComposer = $pointRectAvailable -and
    $pointRect.Left -le ($chatLeft + 40) -and $pointRect.Right -ge ($freshRect.Right - 40) -and
    $pointRect.Top -le $composerTop -and $pointRect.Bottom -ge ($freshRect.Bottom - 24)
  $composerDiagnostics = @{
    pointWindow = $pointWindow.ToInt64()
    pointProcessId = $pointProcessId
    pointClass = $pointClass.ToString()
    pointRect = @{ left = $pointRect.Left; top = $pointRect.Top; right = $pointRect.Right; bottom = $pointRect.Bottom }
    renderChildClass = $renderChildClass
    wechatQtRootClass = $wechatQtRootClass
    renderSurfaceOwnsComposer = $renderSurfaceOwnsComposer
    verificationMode = $verificationMode
  }
  $visualConversationMode = @("visual_header", "exact_wechat_id_search") -contains $verificationMode
  if ($visualConversationMode) {
    if ($pointProcessId -eq [uint32]$matched.pid -and ($renderChildClass -or $wechatQtRootClass) -and $renderSurfaceOwnsComposer) {
      return @{
        ok = $true
        token = "composer:v1:win32:\${pointClassName}:$($pointWindow.ToInt64()):$($pointRect.Left):$($pointRect.Top):$($pointRect.Right):$($pointRect.Bottom)"
        controlType = "Win32.RenderSurface"
        automationId = ""
        proofMode = $(if ($renderChildClass) { "visual_render_composer" } else { "visual_qt_root_composer" })
      }
    }
  }
  $element = $null
  try { $element = [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($x, $y))) } catch {}
  if ($element -eq $null) { return @{ ok = $false; reason = "atomic_composer_not_verified" } }
  for ($depth = 0; $depth -lt 8 -and $element -ne $null; $depth++) {
    try {
      $elementRect = $element.Current.BoundingRectangle
      $controlType = [string]$element.Current.ControlType.ProgrammaticName
      $automationId = [string]$element.Current.AutomationId
      $sameProcess = [int]$element.Current.ProcessId -eq [int]$matched.pid
      $containsPoint = $x -ge $elementRect.Left -and $x -lt $elementRect.Right -and $y -ge $elementRect.Top -and $y -lt $elementRect.Bottom
      $visible = -not $element.Current.IsOffscreen -and $elementRect.Width -ge 40 -and $elementRect.Height -ge 18
      $confinedToComposer = $elementRect.Left -ge ($chatLeft - 8) -and $elementRect.Top -ge ($composerTop - 8) -and $elementRect.Right -le ($freshRect.Right + 1) -and $elementRect.Bottom -le ($freshRect.Bottom + 1) -and $elementRect.Height -le ($freshRect.Height * 0.36)
      $explicitEditor = @("ControlType.Edit", "ControlType.Document") -contains $controlType
      $renderSurface = @("ControlType.Custom", "ControlType.Pane") -contains $controlType -and $elementRect.Left -le ($chatLeft + 40) -and $elementRect.Right -ge ($freshRect.Right - 40) -and $elementRect.Top -le $composerTop -and $elementRect.Bottom -ge ($freshRect.Bottom - 24)
      $boundedRenderEditor = ($confinedToComposer -or $renderSurface) -and @("ControlType.Custom", "ControlType.Pane") -contains $controlType
      if ($sameProcess -and $containsPoint -and $visible -and ($explicitEditor -or $boundedRenderEditor)) {
        return @{
          ok = $true
          token = "composer:v1:$($controlType):$($automationId):$([int]$elementRect.Left):$([int]$elementRect.Top):$([int]$elementRect.Right):$([int]$elementRect.Bottom)"
          controlType = $controlType
          automationId = $automationId
          proofMode = $(if ($explicitEditor) { "uia_editor" } elseif ($confinedToComposer) { "bounded_render_composer" } else { "render_composer_region" })
        }
      }
    } catch {}
    try { $element = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($element) } catch { $element = $null }
  }
  return @{ ok = $false; reason = "atomic_composer_not_verified"; diagnostics = $composerDiagnostics }
}
  $processNames = @("Weixin", "WeChat")
$matched = $null
$callback = [Win32WechatSendMessage+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if ($matched -ne $null) { return $true }
  if ([Win32WechatSendMessage]::IsWindowVisible($hWnd)) {
    $text = New-Object System.Text.StringBuilder 512
    [void][Win32WechatSendMessage]::GetWindowText($hWnd, $text, $text.Capacity)
    $title = $text.ToString().Trim()
    $rect = New-Object Win32WechatSendMessage+RECT
    [void][Win32WechatSendMessage]::GetWindowRect($hWnd, [ref]$rect)
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    [uint32]$windowProcessId = 0
    [void][Win32WechatSendMessage]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
    $proc = Get-Process -Id $windowProcessId -ErrorAction SilentlyContinue
    $matchesExpected = ([string]::IsNullOrWhiteSpace($expectedPid) -or [string]$windowProcessId -eq $expectedPid) -and ([string]::IsNullOrWhiteSpace($expectedHandle) -or [string]$hWnd.ToInt64() -eq $expectedHandle)
    if ($proc -and $matchesExpected -and [int64]$proc.MainWindowHandle -eq $hWnd.ToInt64() -and $processNames -contains $proc.ProcessName -and $title -eq "微信" -and $w -ge 400 -and $h -ge 300) {
      [void][Win32WechatSendMessage]::ShowWindowAsync($hWnd, 9)
      $focused = [Win32WechatSendMessage]::SetForegroundWindow($hWnd)
      if (-not $focused) { try { $focused = (New-Object -ComObject WScript.Shell).AppActivate([int]$windowProcessId) } catch {} }
      Start-Sleep -Milliseconds 200
      $focused = $focused -or ([Win32WechatSendMessage]::GetForegroundWindow() -eq $hWnd)
      $script:matched = @{ title = $title; focused = $focused; processName = $proc.ProcessName; pid = $windowProcessId; hWnd = $hWnd.ToInt64() }
    }
  }
  return $true
}
[void][Win32WechatSendMessage]::EnumWindows($callback, [IntPtr]::Zero)
if ($matched -eq $null) {
  @{ ok = $false; reason = "atomic_expected_window_not_found"; sendAttempted = $false } | ConvertTo-Json -Compress
  exit
}
if (-not $matched.focused) {
  @{ ok = $false; reason = "wechat_focus_failed"; title = $matched.title; processName = $matched.processName; sendAttempted = $false } | ConvertTo-Json -Compress
  exit
}
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$matched.hWnd)
if ($root -eq $null -or [string]::IsNullOrWhiteSpace($expectedConversation) -or [string]::IsNullOrWhiteSpace($expectedMessage)) {
  @{ ok = $false; reason = "atomic_send_context_missing"; sendAttempted = $false } | ConvertTo-Json -Compress
  exit
}
$conversationBefore = Get-ConversationObservation ([IntPtr][int64]$matched.hWnd) $expectedConversation $expectedConversationMode
$conversationVerified = $conversationBefore.ok -and -not [string]::IsNullOrWhiteSpace($conversationBefore.token)
if ($conversationVerified -and $expectedConversationMode -ne "exact_wechat_id_search" -and -not [string]::IsNullOrWhiteSpace($expectedConversationToken)) {
  $conversationVerified = $conversationBefore.token -ceq $expectedConversationToken
}
if (-not $conversationVerified) {
  @{ ok = $false; reason = $(if ($conversationBefore.reason) { $conversationBefore.reason } else { "atomic_conversation_changed" }); conversationToken = $conversationBefore.token; conversationTitleMode = $conversationBefore.titleMode; sendAttempted = $false } | ConvertTo-Json -Compress
  exit
}
$boundConversationToken = $(if ([string]::IsNullOrWhiteSpace($expectedConversationToken)) { $conversationBefore.token } else { $expectedConversationToken })
$root = $conversationBefore.root
$windowRect = $conversationBefore.rect

$inputXRatio = 0.65
$inputYRatio = 0.0
$inputPointAvailable = [double]::TryParse($inputXText, [ref]$inputXRatio) -and [double]::TryParse($inputYText, [ref]$inputYRatio) -and $inputXRatio -gt 0 -and $inputXRatio -lt 1 -and $inputYRatio -gt 0 -and $inputYRatio -lt 1
$oldPoint = New-Object Win32WechatSendMessage+POINT
[void][Win32WechatSendMessage]::GetCursorPos([ref]$oldPoint)
$oldClipboard = ""
try { $oldClipboard = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
$draftVerified = $false
$sendAction = ""
$sendAttempted = $false
try {
  $inputX = [int]($windowRect.Left + ($windowRect.Width * $(if ($inputPointAvailable) { $inputXRatio } else { 0.65 })))
  $inputY = $(if ($inputPointAvailable) { [int]($windowRect.Top + ($windowRect.Height * $inputYRatio)) } else { [int]($windowRect.Bottom - 105) })
  [void][Win32WechatSendMessage]::SetCursorPos($inputX, $inputY)
  [Win32WechatSendMessage]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 35
  [Win32WechatSendMessage]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  $composerBefore = Get-ComposerObservation $root $windowRect $inputX $inputY $expectedConversationMode
  if (-not $composerBefore.ok) {
    @{ ok = $false; reason = $composerBefore.reason; composerDiagnostics = $composerBefore.diagnostics; conversationVerified = $conversationVerified; composerVerified = $false; sendAttempted = $false } | ConvertTo-Json -Compress -Depth 6
    exit
  }
  $probe = "__XIAOXI_ATOMIC_SEND_" + [Guid]::NewGuid().ToString("N")
  Set-Clipboard -Value $probe
  [System.Windows.Forms.SendKeys]::SendWait("^a")
  [System.Windows.Forms.SendKeys]::SendWait("^c")
  Start-Sleep -Milliseconds 120
  $copiedDraft = [string](Get-Clipboard -Raw -ErrorAction Stop)
  $draftVerified = (Normalize-WechatDraftText $copiedDraft) -ceq $normalizedExpectedMessage
  if (-not $draftVerified -or [Win32WechatSendMessage]::GetForegroundWindow().ToInt64() -ne [int64]$matched.hWnd) {
    @{ ok = $false; reason = $(if ($draftVerified) { "atomic_wechat_focus_changed" } else { "atomic_draft_changed" }); conversationVerified = $conversationVerified; draftVerified = $draftVerified; sendAttempted = $false } | ConvertTo-Json -Compress
    exit
  }

  $conversationAfterDraft = Get-ConversationObservation ([IntPtr][int64]$matched.hWnd) $expectedConversation $expectedConversationMode
  $conversationVerified = $conversationAfterDraft.ok -and ($expectedConversationMode -eq "exact_wechat_id_search" -or $conversationAfterDraft.token -ceq $boundConversationToken)
  if (-not $conversationVerified) {
    @{ ok = $false; reason = "atomic_conversation_changed"; conversationVerified = $false; conversationToken = $conversationAfterDraft.token; draftVerified = $draftVerified; composerVerified = $composerBefore.ok; sendAttempted = $false } | ConvertTo-Json -Compress
    exit
  }
  $root = $conversationAfterDraft.root
  $windowRect = $conversationAfterDraft.rect
  $composerAfterDraft = Get-ComposerObservation $root $windowRect $inputX $inputY $expectedConversationMode
  $composerVerified = $composerAfterDraft.ok -and $composerAfterDraft.token -ceq $composerBefore.token
  if (-not $composerVerified) {
    @{ ok = $false; reason = "atomic_composer_changed"; conversationVerified = $conversationVerified; draftVerified = $draftVerified; composerVerified = $false; sendAttempted = $false } | ConvertTo-Json -Compress
    exit
  }

  if ([Win32WechatSendMessage]::GetForegroundWindow().ToInt64() -ne [int64]$matched.hWnd) {
    @{ ok = $false; reason = "atomic_wechat_focus_changed"; conversationVerified = $conversationVerified; draftVerified = $draftVerified; sendAttempted = $false } | ConvertTo-Json -Compress
    exit
  }

  try {
    $clickRect = $root.Current.BoundingRectangle
  } catch {
    @{ ok = $false; reason = "wechat_send_point_invalid"; conversationVerified = $conversationVerified; draftVerified = $draftVerified; sendAttempted = $false } | ConvertTo-Json -Compress
    exit
  }
  $dpi = 96
  try {
    $windowDpi = [int][Win32WechatSendMessage]::GetDpiForWindow([IntPtr][int64]$matched.hWnd)
    if ($windowDpi -gt 0) { $dpi = $windowDpi }
  } catch {}
  $dpiScale = [double]$dpi / 96.0
  $sendRightOffsetDip = 64
  $sendBottomOffsetDip = 42
  $sendX = [int]($clickRect.Right - [Math]::Round($sendRightOffsetDip * $dpiScale))
  $sendY = [int]($clickRect.Bottom - [Math]::Round($sendBottomOffsetDip * $dpiScale))
  $clickWidth = $clickRect.Width
  $clickHeight = $clickRect.Height
  $sendPointValid = $sendX -ge ($clickRect.Left + ($clickWidth * 0.70)) -and $sendX -lt $clickRect.Right -and
    $sendY -ge ($clickRect.Top + ($clickHeight * 0.65)) -and $sendY -lt $clickRect.Bottom
  if (-not $sendPointValid) {
    @{ ok = $false; reason = "wechat_send_point_invalid"; conversationVerified = $conversationVerified; draftVerified = $draftVerified; sendAttempted = $false } | ConvertTo-Json -Compress
    exit
  }
  $cursorMoved = [Win32WechatSendMessage]::SetCursorPos($sendX, $sendY)
  $sendPoint = New-Object Win32WechatSendMessage+POINT
  $cursorVerified = $cursorMoved -and [Win32WechatSendMessage]::GetCursorPos([ref]$sendPoint) -and [Math]::Abs($sendPoint.X - $sendX) -le 1 -and [Math]::Abs($sendPoint.Y - $sendY) -le 1
  if (-not $cursorVerified -or [Win32WechatSendMessage]::GetForegroundWindow().ToInt64() -ne [int64]$matched.hWnd) {
    @{ ok = $false; reason = "wechat_send_cursor_mismatch"; conversationVerified = $conversationVerified; draftVerified = $draftVerified; sendAttempted = $false } | ConvertTo-Json -Compress
    exit
  }
  $pointWindow = [Win32WechatSendMessage]::WindowFromPoint($sendPoint)
  if ($pointWindow -eq [IntPtr]::Zero -or [Win32WechatSendMessage]::GetAncestor($pointWindow, 2).ToInt64() -ne [int64]$matched.hWnd) {
    @{ ok = $false; reason = "wechat_send_point_obscured"; conversationVerified = $conversationVerified; draftVerified = $draftVerified; sendAttempted = $false } | ConvertTo-Json -Compress
    exit
  }
  if (-not [string]::IsNullOrWhiteSpace($expectedIncomingMessage) -and -not [string]::IsNullOrWhiteSpace($expectedIncomingRuntimeId)) {
    $chatList = $null
    $latestBubble = $null
    $latestBubbleText = ""
    $latestBubbleKey = ""
    try {
      $currentAll = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      for ($index = 0; $index -lt $currentAll.Count; $index++) {
        $element = $currentAll.Item($index)
        if ([string]$element.Current.AutomationId -ceq "chat_message_list") { $chatList = $element; break }
      }
      if ($chatList -ne $null) {
        $chatRect = $chatList.Current.BoundingRectangle
        $bubbleElements = $chatList.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        $latestBottom = [double]::MinValue
        for ($index = 0; $index -lt $bubbleElements.Count; $index++) {
          $element = $bubbleElements.Item($index)
          if ($element.Current.ControlType -ne [System.Windows.Automation.ControlType]::ListItem) { continue }
          if ([string]$element.Current.AutomationId -cne "chat_message_list.qt_scrollarea_viewport.chat_bubble_item_view") { continue }
          if ($element.Current.IsOffscreen) { continue }
          $text = Get-ElementText $element
          if ([string]::IsNullOrWhiteSpace($text) -or $text.Length -gt 500) { continue }
          $rect = $element.Current.BoundingRectangle
          if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }
          if ($rect.Top -lt ($chatRect.Top - 1) -or $rect.Bottom -gt ($chatRect.Bottom + 1)) { continue }
          if ([double]$rect.Bottom -ge $latestBottom) {
            $latestBottom = [double]$rect.Bottom
            $latestBubble = $element
            $latestBubbleText = [string]$text
            $latestBubbleKey = Get-ElementKey $element $rect $text
          }
        }
      }
    } catch {}
    if ($latestBubble -eq $null -or $latestBubbleText -cne $expectedIncomingMessage -or $latestBubbleKey -cne $expectedIncomingRuntimeId) {
      @{ ok = $false; reason = "incoming_message_changed"; conversationVerified = $conversationVerified; draftVerified = $draftVerified; sendAttempted = $false } | ConvertTo-Json -Compress
      exit
    }
  }
  $sendAttempted = $true
  [Win32WechatSendMessage]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 35
  [Win32WechatSendMessage]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  $sendAction = "mouse_click_relative_send_area"
} finally {
  try { Set-Clipboard -Value $oldClipboard } catch {}
  [void][Win32WechatSendMessage]::SetCursorPos($oldPoint.X, $oldPoint.Y)
}
Start-Sleep -Milliseconds 300
@{ ok = $true; title = $matched.title; focused = $matched.focused; processName = $matched.processName; pid = $matched.pid; hWnd = $matched.hWnd; sendAction = $sendAction; sendAttempted = $sendAttempted; conversationVerified = $conversationVerified; conversationToken = $boundConversationToken; conversationTitleMode = $conversationAfterDraft.titleMode; composerVerified = $composerVerified; composerToken = $composerAfterDraft.token; draftVerified = $draftVerified } | ConvertTo-Json -Compress
`;

const OBSERVE_CONVERSATION_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32WechatConversationObservation {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$expectedPid = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID")
$expectedHandle = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_HWND")
$expectedConversation = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_CONVERSATION")
$verificationMode = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_CONVERSATION_MODE")
if ([string]::IsNullOrWhiteSpace($expectedPid) -or [string]::IsNullOrWhiteSpace($expectedHandle) -or [string]::IsNullOrWhiteSpace($expectedConversation)) {
  @{ ok = $false; reason = "conversation_observation_context_missing" } | ConvertTo-Json -Compress
  exit
}
$process = Get-Process -Id ([int]$expectedPid) -ErrorAction SilentlyContinue
$expectedHWnd = [IntPtr][int64]$expectedHandle
[uint32]$observedWindowPid = 0
$expectedWindowExists = [Win32WechatConversationObservation]::IsWindow($expectedHWnd)
$expectedWindowVisible = [Win32WechatConversationObservation]::IsWindowVisible($expectedHWnd)
$expectedWindowThreadId = [Win32WechatConversationObservation]::GetWindowThreadProcessId($expectedHWnd, [ref]$observedWindowPid)
$windowStillOwned = $expectedWindowExists -and $expectedWindowVisible -and
  $expectedWindowThreadId -ne 0 -and
  $observedWindowPid -eq [uint32][int]$expectedPid
if ($process -eq $null -or @("Weixin", "WeChat") -notcontains $process.ProcessName -or -not $windowStillOwned) {
  @{ ok = $false; reason = "real_send_session_changed"; expectedHWnd = [int64]$expectedHWnd; expectedPid = [int]$expectedPid; processName = [string]$process.ProcessName; windowExists = $expectedWindowExists; windowVisible = $expectedWindowVisible; windowThreadId = $expectedWindowThreadId; observedWindowPid = $observedWindowPid } | ConvertTo-Json -Compress
  exit
}
$root = [System.Windows.Automation.AutomationElement]::FromHandle($expectedHWnd)
if ($root -eq $null) {
  @{ ok = $false; reason = "automation_root_missing" } | ConvertTo-Json -Compress
  exit
}
try { $windowRect = $root.Current.BoundingRectangle } catch {
  @{ ok = $false; reason = "automation_root_missing" } | ConvertTo-Json -Compress
  exit
}
function Get-ObservedElementText([System.Windows.Automation.AutomationElement]$element) {
  try {
    $name = [string]$element.Current.Name
    if (-not [string]::IsNullOrWhiteSpace($name)) { return $name.Trim() }
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($pattern -and -not [string]::IsNullOrWhiteSpace($pattern.Current.Value)) { return ([string]$pattern.Current.Value).Trim() }
  } catch {}
  return ""
}
# Exclude the session-list preview from the conversation identity token. Typing a
# draft updates that preview even though the active conversation has not changed.
$headerLeft = $windowRect.Left + ($windowRect.Width * 0.36)
$titleVisible = $false
try {
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  for ($index = 0; $index -lt $all.Count; $index++) {
    $element = $all.Item($index)
    if ((Get-ObservedElementText $element) -cne $expectedConversation) { continue }
    try { $rect = $element.Current.BoundingRectangle } catch { continue }
    if (-not $element.Current.IsOffscreen -and $rect.Left -ge $headerLeft -and $rect.Top -ge ($windowRect.Top + 25) -and $rect.Top -le ($windowRect.Top + 125)) {
      $titleVisible = $true
      break
    }
  }
} catch {}
$visualHash = ""
try {
  $captureLeft = [int]$headerLeft
  $captureTop = [int]($windowRect.Top + 28)
  $captureRight = [int]($windowRect.Left + ($windowRect.Width * 0.78))
  $captureBottom = [int][Math]::Min($windowRect.Bottom - 1, $windowRect.Top + 112)
  $captureWidth = $captureRight - $captureLeft
  $captureHeight = $captureBottom - $captureTop
  if ($captureWidth -ge 120 -and $captureHeight -ge 40) {
    $bitmap = New-Object System.Drawing.Bitmap($captureWidth, $captureHeight)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($captureLeft, $captureTop, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $visualHash = -join ($sha.ComputeHash($stream.ToArray()) | ForEach-Object { $_.ToString("x2") })
    $sha.Dispose()
    $stream.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  }
} catch { $visualHash = "" }
$visualFallback = $verificationMode -eq "exact_wechat_id_search"
$verified = -not [string]::IsNullOrWhiteSpace($visualHash) -and ($visualFallback -or $titleVisible)
@{
  ok = $verified
  reason = $(if ($verified) { "" } elseif ([string]::IsNullOrWhiteSpace($visualHash)) { "conversation_visual_token_unavailable" } else { "atomic_conversation_changed" })
  title = $(if ($titleVisible) { $expectedConversation } else { "" })
  windowTitle = $process.MainWindowTitle
  processName = $process.ProcessName
  pid = $process.Id
  hWnd = [int64]$expectedHWnd
  verificationMode = $verificationMode
  conversationTitleMode = $(if ($titleVisible) { "uia_header" } else { "visual_header" })
  conversationToken = $(if ([string]::IsNullOrWhiteSpace($visualHash)) { "" } else { "conversation:v1:$($process.Id):$([int64]$expectedHWnd):$visualHash" })
} | ConvertTo-Json -Compress
`;

function observationEnvironment(expectedTitle, context = {}) {
  return {
    XIAOXI_EXPECTED_PID: String(context.expectedPid ?? context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.expectedHWnd ?? context.hWnd ?? ""),
    XIAOXI_EXPECTED_CONVERSATION: String(expectedTitle ?? ""),
    XIAOXI_EXPECTED_CONVERSATION_MODE: String(context.verificationMode ?? "conversation_title")
  };
}

function observeWechatConversation(expectedTitle, context = {}) {
  if (!String(expectedTitle ?? "").trim()) return { ok: false, reason: "conversation_observation_context_missing" };
  return runPowerShell(OBSERVE_CONVERSATION_SCRIPT, observationEnvironment(expectedTitle, context), { ensure: false });
}

function observeWechatConversationAsync(expectedTitle, context = {}) {
  if (!String(expectedTitle ?? "").trim()) return Promise.resolve({ ok: false, reason: "conversation_observation_context_missing" });
  return runPowerShellAsync(OBSERVE_CONVERSATION_SCRIPT, observationEnvironment(expectedTitle, context), { ensure: false });
}

const SEND_RESULTS = new Set(["not_attempted", "sent_verified", "outcome_unknown"]);

function normalizeAtomicSendResult(result) {
  const raw = result && typeof result === "object" ? result : { ok: false, reason: "atomic_send_result_invalid" };
  if (SEND_RESULTS.has(raw.sendResult)) return raw;
  if (raw.sendAttempted === false) return { ...raw, sendResult: "not_attempted" };
  return { ...raw, sendResult: "outcome_unknown" };
}

function sendMessageEnvironment(context = {}) {
  return {
    XIAOXI_EXPECTED_PID: String(context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.hWnd ?? ""),
    XIAOXI_EXPECTED_CONVERSATION: String(context.expectedConversation ?? ""),
    XIAOXI_EXPECTED_CONVERSATION_MODE: String(context.expectedConversationMode ?? "conversation_title"),
    XIAOXI_EXPECTED_CONVERSATION_TOKEN: String(context.expectedConversationToken ?? ""),
    XIAOXI_EXPECTED_MESSAGE: String(context.expectedMessage ?? ""),
    XIAOXI_EXPECTED_INCOMING_MESSAGE: String(context.expectedIncomingMessage ?? ""),
    XIAOXI_EXPECTED_INCOMING_RUNTIME_ID: String(context.expectedIncomingRuntimeId ?? ""),
    XIAOXI_INPUT_X_RATIO: String(context.inputPoint?.xRatio ?? ""),
    XIAOXI_INPUT_Y_RATIO: String(context.inputPoint?.yRatio ?? "")
  };
}

function clickWechatSendButton(_sendKey = "{ENTER}", context = {}) {
  return normalizeAtomicSendResult(runPowerShell(SEND_MESSAGE_SCRIPT, sendMessageEnvironment(context), { ensure: false }));
}

async function clickWechatSendButtonAsync(_sendKey = "{ENTER}", context = {}) {
  return normalizeAtomicSendResult(await runPowerShellAsync(SEND_MESSAGE_SCRIPT, sendMessageEnvironment(context), { ensure: false }));
}

const DETECT_ACTIVE_ACCOUNT_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$expectedPid = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID")
$expectedAccountId = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_ACCOUNT_ID")
$wechatRoot = [Environment]::GetEnvironmentVariable("XIAOXI_WECHAT_ROOT")
if ([string]::IsNullOrWhiteSpace($expectedPid)) {
  @{ ok = $false; reason = "wechat_pid_missing" } | ConvertTo-Json -Compress
  exit
}
$process = Get-Process -Id ([int]$expectedPid) -ErrorAction SilentlyContinue
if ($process -eq $null -or @("Weixin", "WeChat") -notcontains $process.ProcessName) {
  @{ ok = $false; reason = "personal_wechat_process_missing" } | ConvertTo-Json -Compress
  exit
}
$exePath = $process.Path
if ([string]::IsNullOrWhiteSpace($exePath)) {
  try { $exePath = (Get-CimInstance Win32_Process -Filter "ProcessId = $expectedPid").ExecutablePath } catch {}
}
if ([string]::IsNullOrWhiteSpace($exePath)) {
  @{ ok = $false; reason = "wechat_executable_path_missing" } | ConvertTo-Json -Compress
  exit
}
$exeDir = Split-Path $exePath -Parent
$installRoot = Split-Path $exeDir -Parent
$roots = if (-not [string]::IsNullOrWhiteSpace($wechatRoot)) {
  @($wechatRoot)
} else {
  @(
    (Join-Path $installRoot "xwechat_files"),
    (Join-Path $exeDir "xwechat_files")
  ) | Select-Object -Unique
}
$accounts = @()
foreach ($root in $roots) {
  if (Test-Path -LiteralPath $root -PathType Container) {
    foreach ($account in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "^wxid_[A-Za-z0-9_]+$" })) {
      $latestWal = Get-ChildItem -LiteralPath (Join-Path $account.FullName "db_storage") -Recurse -File -Filter "*.db-wal" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
      $accounts += [pscustomobject]@{
        account = $account
        activityPath = $(if ($latestWal) { $latestWal.FullName } else { $account.FullName })
        activityTimeUtc = $(if ($latestWal) { $latestWal.LastWriteTimeUtc } else { $account.LastWriteTimeUtc })
      }
    }
  }
}
$uniqueAccounts = @($accounts | Group-Object { $_.account.Name } | ForEach-Object { $_.Group | Sort-Object activityTimeUtc -Descending | Select-Object -First 1 })
if (-not [string]::IsNullOrWhiteSpace($expectedAccountId)) {
  $uniqueAccounts = @($uniqueAccounts | Where-Object { $_.account.Name -eq $expectedAccountId })
}
if ($uniqueAccounts.Count -eq 0) {
  @{ ok = $false; reason = "wechat_account_directory_missing" } | ConvertTo-Json -Compress
  exit
}
if ($uniqueAccounts.Count -ne 1) {
  @{ ok = $false; reason = "wechat_account_ambiguous"; accountCount = $uniqueAccounts.Count } | ConvertTo-Json -Compress
  exit
}
$active = $uniqueAccounts[0]
@{
  ok = $true
  accountId = $active.account.Name
  accountPath = $active.account.FullName
  activityPath = $active.activityPath
  lastActivityTimeUtc = $active.activityTimeUtc.ToString("o")
} | ConvertTo-Json -Compress
`;

function detectActiveWechatAccount(context = {}) {
  if (!context.pid) return { ok: false, reason: "wechat_pid_missing" };
  return runPowerShell(DETECT_ACTIVE_ACCOUNT_SCRIPT, {
    XIAOXI_EXPECTED_PID: String(context.pid),
    XIAOXI_EXPECTED_ACCOUNT_ID: String(context.expectedAccountId ?? ""),
    XIAOXI_WECHAT_ROOT: String(context.wechatRoot ?? "")
  });
}

function detectActiveWechatAccountAsync(context = {}) {
  if (!context.pid) return Promise.resolve({ ok: false, reason: "wechat_pid_missing" });
  return runPowerShellAsync(DETECT_ACTIVE_ACCOUNT_SCRIPT, {
    XIAOXI_EXPECTED_PID: String(context.pid),
    XIAOXI_EXPECTED_ACCOUNT_ID: String(context.expectedAccountId ?? ""),
    XIAOXI_WECHAT_ROOT: String(context.wechatRoot ?? "")
  }, { ensure: false });
}

function verifyWechatCurrentConversation(expectedTitle, context = {}) {
  const expectedWindow = { pid: context.expectedPid, hWnd: context.expectedHWnd };
  const verificationMode = context.allowExactSearchFallback === true ? "exact_wechat_id_search" : "conversation_title";
  let result = verifyWechatCurrentConversationSafe(expectedTitle, expectedWindow);
  if (!result.ok && context.allowExactSearchFallback === true) result = focusWechatWindow({ expectedPid: context.expectedPid, expectedHWnd: context.expectedHWnd });
  if (!result.ok) return result;
  const sameWindow = Number(result.pid) === Number(context.expectedPid)
    && String(result.hWnd) === String(context.expectedHWnd)
    && ["Weixin", "WeChat"].includes(result.processName);
  if (!sameWindow) return { ok: false, reason: "real_send_session_changed" };
  const observation = observeWechatConversation(expectedTitle, { ...expectedWindow, verificationMode });
  if (!observation.ok || !String(observation.conversationToken ?? "").trim()) return observation;
  result = {
    ...result,
    ...observation,
    ok: true,
    title: observation.title || String(expectedTitle),
    verificationMode
  };
  const account = detectActiveWechatAccount({
    pid: result.pid,
    expectedAccountId: context.expectedAccountId,
    wechatRoot: context.wechatRoot
  });
  return {
    ...result,
    accountId: account.ok ? String(account.accountId ?? "") : "",
    accountVerified: account.ok === true,
    accountReason: account.ok ? "" : String(account.reason ?? "wechat_account_not_verified")
  };
}

async function verifyWechatCurrentConversationAsync(expectedTitle, context = {}) {
  const expectedWindow = { pid: context.expectedPid, hWnd: context.expectedHWnd };
  const verificationMode = context.allowExactSearchFallback === true ? "exact_wechat_id_search" : "conversation_title";
  let result = await verifyWechatCurrentConversationSafeAsync(expectedTitle, expectedWindow);
  if (!result.ok && context.allowExactSearchFallback === true) result = await focusWechatWindowAsync({ expectedPid: context.expectedPid, expectedHWnd: context.expectedHWnd });
  if (!result.ok) return result;
  const sameWindow = Number(result.pid) === Number(context.expectedPid)
    && String(result.hWnd) === String(context.expectedHWnd)
    && ["Weixin", "WeChat"].includes(result.processName);
  if (!sameWindow) return { ok: false, reason: "real_send_session_changed" };
  const observation = await observeWechatConversationAsync(expectedTitle, { ...expectedWindow, verificationMode });
  if (!observation.ok || !String(observation.conversationToken ?? "").trim()) return observation;
  result = {
    ...result,
    ...observation,
    ok: true,
    title: observation.title || String(expectedTitle),
    verificationMode
  };
  const account = await detectActiveWechatAccountAsync({
    pid: result.pid,
    expectedAccountId: context.expectedAccountId,
    wechatRoot: context.wechatRoot
  });
  return {
    ...result,
    accountId: account.ok ? String(account.accountId ?? "") : "",
    accountVerified: account.ok === true,
    accountReason: account.ok ? "" : String(account.reason ?? "wechat_account_not_verified")
  };
}

const MESSAGE_BUBBLE_PROOF_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32WechatMessageProof {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@
$message = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_MESSAGE")
$phase = [Environment]::GetEnvironmentVariable("XIAOXI_VERIFY_PHASE")
$expectedPid = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID")
$expectedHandle = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_HWND")
$inputXText = [Environment]::GetEnvironmentVariable("XIAOXI_INPUT_X_RATIO")
$inputYText = [Environment]::GetEnvironmentVariable("XIAOXI_INPUT_Y_RATIO")
$beforeJson = [Environment]::GetEnvironmentVariable("XIAOXI_BEFORE_SNAPSHOT")
function Normalize-WechatProofText([string]$value) {
  $normalized = ([string]$value).Replace([Environment]::NewLine, [string][char]10)
  $normalized = $normalized.Replace([string][char]13, [string][char]10)
  return $normalized.TrimEnd([char[]]@([char]0xFFFC))
}
$normalizedMessage = Normalize-WechatProofText $message
if ([string]::IsNullOrWhiteSpace($message) -or [string]::IsNullOrWhiteSpace($expectedPid) -or [string]::IsNullOrWhiteSpace($expectedHandle)) {
  @{ ok = $false; reason = "window_or_message_missing" } | ConvertTo-Json -Compress
  exit
}
$process = Get-Process -Id ([int]$expectedPid) -ErrorAction SilentlyContinue
if (
  $process -eq $null -or
  @("Weixin", "WeChat") -notcontains $process.ProcessName -or
  [string]$process.MainWindowHandle -ne [string]$expectedHandle -or
  $process.MainWindowTitle -ne "微信"
) {
  @{ ok = $false; reason = "real_send_session_changed" } | ConvertTo-Json -Compress
  exit
}
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$expectedHandle)
if ($root -eq $null) {
  @{ ok = $false; reason = "automation_root_missing" } | ConvertTo-Json -Compress
  exit
}
Start-Sleep -Milliseconds 350
$windowRect = $root.Current.BoundingRectangle
$windowWidth = $windowRect.Width
$windowHeight = $windowRect.Height
$chatLeft = $windowRect.Left + ($windowWidth * 0.25)
$chatTop = $windowRect.Top + 45
$chatBottom = $windowRect.Bottom - 125
$outgoingEdge = $windowRect.Left + ($windowWidth * 0.80)
$inputXRatio = 0.65
$inputYRatio = 0.0
$inputPointAvailable = [double]::TryParse($inputXText, [ref]$inputXRatio) -and [double]::TryParse($inputYText, [ref]$inputYRatio) -and $inputXRatio -gt 0 -and $inputXRatio -lt 1 -and $inputYRatio -gt 0 -and $inputYRatio -lt 1

function Read-InputDraft {
  $sameWindow = [Win32WechatMessageProof]::GetForegroundWindow().ToInt64() -eq [int64]$expectedHandle
  if (-not $sameWindow) { return @{ ok = $false; sameWindow = $false; isEmpty = $false; text = "" } }
  $oldPoint = New-Object Win32WechatMessageProof+POINT
  [void][Win32WechatMessageProof]::GetCursorPos([ref]$oldPoint)
  $oldClipboard = ""
  try { $oldClipboard = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
  $result = @{ ok = $false; sameWindow = $true; isEmpty = $false; text = "" }
  try {
    $x = [int]($windowRect.Left + ($windowWidth * $(if ($inputPointAvailable) { $inputXRatio } else { 0.65 })))
    $y = $(if ($inputPointAvailable) { [int]($windowRect.Top + ($windowHeight * $inputYRatio)) } else { [int]($windowRect.Bottom - 105) })
    [void][Win32WechatMessageProof]::SetCursorPos($x, $y)
    [Win32WechatMessageProof]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 50
    [Win32WechatMessageProof]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 120
    $sentinel = "__XIAOXI_EMPTY_DRAFT_" + [Guid]::NewGuid().ToString("N")
    Set-Clipboard -Value $sentinel
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 50
    [System.Windows.Forms.SendKeys]::SendWait("^c")
    Start-Sleep -Milliseconds 180
    $copied = [string](Get-Clipboard -Raw -ErrorAction Stop)
    $isEmpty = $copied -ceq $sentinel
    $result = @{ ok = $true; sameWindow = $true; isEmpty = $isEmpty; text = $(if ($isEmpty) { "" } else { $copied }) }
  } catch {}
  try { Set-Clipboard -Value $oldClipboard } catch {}
  [void][Win32WechatMessageProof]::SetCursorPos($oldPoint.X, $oldPoint.Y)
  return $result
}

function Get-ElementText([System.Windows.Automation.AutomationElement]$element) {
  $name = $element.Current.Name
  if (-not [string]::IsNullOrWhiteSpace($name)) { return [string]$name }
  try {
    $valuePattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($valuePattern -and -not [string]::IsNullOrWhiteSpace($valuePattern.Current.Value)) {
      return [string]$valuePattern.Current.Value
    }
  } catch {}
  return ""
}

function Get-ElementKey([System.Windows.Automation.AutomationElement]$element, $rect, [string]$text) {
  try {
    $runtimeId = $element.GetRuntimeId()
    if ($runtimeId -and $runtimeId.Count -gt 0) { return [string]($runtimeId -join ".") }
  } catch {}
  return [string]("rect:{0}:{1}:{2}:{3}:{4}" -f [int]$rect.Left, [int]$rect.Top, [int]$rect.Right, [int]$rect.Bottom, $text)
}

$all = $root.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition
)
$candidates = New-Object System.Collections.Generic.List[object]
for ($index = 0; $index -lt $all.Count; $index++) {
  $element = $all.Item($index)
  $text = Get-ElementText $element
  if ([string]::IsNullOrWhiteSpace($text)) { continue }
  try { $rect = $element.Current.BoundingRectangle } catch { continue }
  if (
    $rect.Width -le 0 -or
    $rect.Height -le 0 -or
    $rect.Right -lt $chatLeft -or
    $rect.Top -lt $chatTop -or
    $rect.Bottom -gt $chatBottom
  ) { continue }
  $normalizedText = Normalize-WechatProofText $text
  $isExpectedText = $normalizedText -ceq $normalizedMessage
  if ($rect.Height -gt [Math]::Max(240, $windowHeight * 0.35) -and -not $isExpectedText) { continue }
  $key = Get-ElementKey $element $rect $text
  [void]$candidates.Add([pscustomobject]@{
    normalizedText = [string]$normalizedText
    key = [string]$key
    left = [double]$rect.Left
    top = [double]$rect.Top
    right = [double]$rect.Right
    bottom = [double]$rect.Bottom
    outgoing = ([double]$rect.Right -ge $outgoingEdge -and (($rect.Left + $rect.Right) / 2) -ge ($windowRect.Left + ($windowWidth * 0.55)))
  })
}
$exactCandidates = @($candidates | Where-Object { $_.normalizedText -ceq $normalizedMessage })
$outgoingExactBefore = @($exactCandidates | Where-Object { $_.outgoing })
$snapshot = @{
  runtimeIds = @($exactCandidates | ForEach-Object { $_.key } | Select-Object -Unique)
  exactCount = $outgoingExactBefore.Count
  capturedAtUtc = [DateTime]::UtcNow.ToString("o")
}
if ($phase -eq "before") {
  $draftBefore = Read-InputDraft
  $snapshot.draftExact = $draftBefore.ok -and -not $draftBefore.isEmpty -and (Normalize-WechatProofText $draftBefore.text) -ceq $normalizedMessage
  @{
    ok = $true
    snapshot = $snapshot
  } | ConvertTo-Json -Compress -Depth 5
  exit
}
if ($phase -ne "after") {
  @{ ok = $false; reason = "message_verify_phase_invalid" } | ConvertTo-Json -Compress
  exit
}
$beforeKeys = @()
$beforeExactCount = 0
try {
  if (-not [string]::IsNullOrWhiteSpace($beforeJson)) {
    $beforeSnapshot = $beforeJson | ConvertFrom-Json
    $beforeKeys = @($beforeSnapshot.runtimeIds)
    $beforeExactCount = [int]$beforeSnapshot.exactCount
  }
} catch {
  @{ ok = $false; reason = "message_snapshot_invalid" } | ConvertTo-Json -Compress
  exit
}
$outgoingExact = @($exactCandidates | Where-Object { $_.outgoing })
$newOutgoingExact = @($outgoingExact | Where-Object { $beforeKeys -notcontains $_.key })
$selected = $newOutgoingExact | Sort-Object bottom -Descending | Select-Object -First 1
if ($selected -eq $null) {
  $selected = $outgoingExact | Sort-Object bottom -Descending | Select-Object -First 1
}
$latestOutgoing = $candidates | Where-Object { $_.outgoing } | Sort-Object bottom -Descending | Select-Object -First 1
$exactMatch = $selected -ne $null -and $selected.normalizedText -ceq $normalizedMessage
$outgoing = $selected -ne $null -and $selected.outgoing -eq $true
$countIncreased = $outgoingExact.Count -gt $beforeExactCount
$isNew = $selected -ne $null -and $beforeKeys -notcontains $selected.key -and $countIncreased
$isLatest = $selected -ne $null -and $latestOutgoing -ne $null -and $selected.bottom -ge ($latestOutgoing.bottom - 2)
$draftAfter = Read-InputDraft
$draftConsumed = $beforeSnapshot.draftExact -eq $true -and $draftAfter.ok -and $draftAfter.sameWindow -and $draftAfter.isEmpty
$verificationMode = $(if ($exactMatch -and $outgoing -and $isLatest -and $isNew) { "message_bubble" } elseif ($draftConsumed) { "draft_consumed" } else { "" })
@{
  ok = (($selected -ne $null) -or $draftConsumed)
  messageText = $(if ($selected -ne $null) { [string]$selected.normalizedText } else { "" })
  exactMatch = $exactMatch
  outgoing = $outgoing
  isLatest = $isLatest
  isNew = $isNew
  draftConsumed = $draftConsumed
  sameWindow = $draftAfter.sameWindow
  verificationMode = $verificationMode
  title = $process.MainWindowTitle
  processName = $process.ProcessName
  pid = $process.Id
  hWnd = [int64]$process.MainWindowHandle
} | ConvertTo-Json -Compress
`;

function verifyWechatMessageBubble(message, context = {}) {
  if (!String(message ?? "").trim()) return { ok: false, reason: "message_missing" };
  const phase = context.phase === "after" ? "after" : "before";
  return runPowerShell(MESSAGE_BUBBLE_PROOF_SCRIPT, {
    XIAOXI_EXPECTED_MESSAGE: String(message),
    XIAOXI_EXPECTED_PID: String(context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.hWnd ?? ""),
    XIAOXI_INPUT_X_RATIO: String(context.inputPoint?.xRatio ?? ""),
    XIAOXI_INPUT_Y_RATIO: String(context.inputPoint?.yRatio ?? ""),
    XIAOXI_VERIFY_PHASE: phase,
    XIAOXI_BEFORE_SNAPSHOT: JSON.stringify(context.beforeSnapshot ?? null)
  }, { ensure: false });
}

function verifyWechatMessageBubbleAsync(message, context = {}) {
  if (!String(message ?? "").trim()) return Promise.resolve({ ok: false, reason: "message_missing" });
  const phase = context.phase === "after" ? "after" : "before";
  return runPowerShellAsync(MESSAGE_BUBBLE_PROOF_SCRIPT, {
    XIAOXI_EXPECTED_MESSAGE: String(message),
    XIAOXI_EXPECTED_PID: String(context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.hWnd ?? ""),
    XIAOXI_INPUT_X_RATIO: String(context.inputPoint?.xRatio ?? ""),
    XIAOXI_INPUT_Y_RATIO: String(context.inputPoint?.yRatio ?? ""),
    XIAOXI_VERIFY_PHASE: phase,
    XIAOXI_BEFORE_SNAPSHOT: JSON.stringify(context.beforeSnapshot ?? null)
  }, { ensure: false });
}

module.exports = {
  clickWechatSendButton,
  clickWechatSendButtonAsync,
  detectActiveWechatAccount,
  normalizeAtomicSendResult,
  observeWechatConversation,
  observeWechatConversationAsync,
  verifyWechatCurrentConversation,
  verifyWechatCurrentConversationAsync,
  verifyWechatMessageBubble,
  verifyWechatMessageBubbleAsync
};
