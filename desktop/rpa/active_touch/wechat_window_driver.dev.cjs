const {
  focusWechatWindow,
  runPowerShell,
  verifyWechatCurrentConversation: verifyWechatCurrentConversationSafe
} = require("./wechat_window_driver.cjs");

const SEND_MESSAGE_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
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
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@
$expectedPid = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID")
$expectedHandle = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_HWND")
$expectedConversation = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_CONVERSATION")
$expectedMessage = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_MESSAGE")
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
    if ($proc -and $matchesExpected -and [int64]$proc.MainWindowHandle -eq $hWnd.ToInt64() -and $processNames -contains $proc.ProcessName -and $title -eq "微信" -and $w -ge 400 -and $h -ge 300 -and $rect.Left -gt -1000 -and $rect.Top -gt -1000) {
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
  @{ ok = $false; reason = "wechat_focus_failed"; title = $matched.title; processName = $matched.processName } | ConvertTo-Json -Compress
  exit
}
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$matched.hWnd)
if ($root -eq $null -or [string]::IsNullOrWhiteSpace($expectedConversation) -or [string]::IsNullOrWhiteSpace($expectedMessage)) {
  @{ ok = $false; reason = "atomic_send_context_missing" } | ConvertTo-Json -Compress
  exit
}
$windowRect = $root.Current.BoundingRectangle
$headerLeft = $windowRect.Left + [Math]::Max(240, $windowRect.Width * 0.22)
$conversationVerified = $false
$conversationElement = $null
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
for ($index = 0; $index -lt $all.Count; $index++) {
  $element = $all.Item($index)
  if ((Get-ElementText $element) -cne $expectedConversation) { continue }
  try { $elementRect = $element.Current.BoundingRectangle } catch { continue }
  if ($elementRect.Left -ge $headerLeft -and $elementRect.Top -ge ($windowRect.Top + 25) -and $elementRect.Top -le ($windowRect.Top + 125)) {
    $conversationVerified = $true
    $conversationElement = $element
    break
  }
}
if (-not $conversationVerified) {
  @{ ok = $false; reason = "atomic_conversation_changed" } | ConvertTo-Json -Compress
  exit
}

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

  $conversationVerified = $false
  try {
    $currentHeaderRect = $conversationElement.Current.BoundingRectangle
    $conversationVerified = -not $conversationElement.Current.IsOffscreen -and
      (Get-ElementText $conversationElement) -ceq $expectedConversation -and
      $currentHeaderRect.Left -ge $headerLeft -and $currentHeaderRect.Top -ge ($windowRect.Top + 25) -and $currentHeaderRect.Top -le ($windowRect.Top + 125)
  } catch {}
  if (-not $conversationVerified) {
    @{ ok = $false; reason = "atomic_conversation_changed"; conversationVerified = $false; draftVerified = $draftVerified; sendAttempted = $false } | ConvertTo-Json -Compress
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
@{ ok = $true; title = $matched.title; focused = $matched.focused; processName = $matched.processName; pid = $matched.pid; hWnd = $matched.hWnd; sendAction = $sendAction; sendAttempted = $sendAttempted; conversationVerified = $conversationVerified; draftVerified = $draftVerified } | ConvertTo-Json -Compress
`;

function clickWechatSendButton(_sendKey = "{ENTER}", context = {}) {
  return runPowerShell(SEND_MESSAGE_SCRIPT, {
    XIAOXI_EXPECTED_PID: String(context.pid ?? ""),
    XIAOXI_EXPECTED_HWND: String(context.hWnd ?? ""),
    XIAOXI_EXPECTED_CONVERSATION: String(context.expectedConversation ?? ""),
    XIAOXI_EXPECTED_MESSAGE: String(context.expectedMessage ?? ""),
    XIAOXI_INPUT_X_RATIO: String(context.inputPoint?.xRatio ?? ""),
    XIAOXI_INPUT_Y_RATIO: String(context.inputPoint?.yRatio ?? "")
  }, { ensure: false });
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

function verifyWechatCurrentConversation(expectedTitle, context = {}) {
  let result = verifyWechatCurrentConversationSafe(expectedTitle);
  if (!result.ok && context.allowExactSearchFallback === true) {
    const currentWindow = focusWechatWindow();
    const sameWindow = currentWindow.ok
      && Number(currentWindow.pid) === Number(context.expectedPid)
      && String(currentWindow.hWnd) === String(context.expectedHWnd)
      && ["Weixin", "WeChat"].includes(currentWindow.processName);
    if (sameWindow) {
      result = {
        ...currentWindow,
        ok: true,
        title: String(expectedTitle),
        windowTitle: currentWindow.title,
        verificationMode: "exact_wechat_id_search"
      };
    }
  }
  if (!result.ok) return result;
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

module.exports = {
  clickWechatSendButton,
  detectActiveWechatAccount,
  verifyWechatCurrentConversation,
  verifyWechatMessageBubble
};
