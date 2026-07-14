const { runPowerShell } = require("./wechat_window_driver.cjs");

const AUTO_REPLY_SCAN_SCRIPT = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32WechatAutoReply {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@

function Write-Result($value) {
  $value | ConvertTo-Json -Compress -Depth 5
  exit
}

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

function Test-Unread([System.Windows.Automation.AutomationElement]$item) {
  $itemText = Get-ElementText $item
  if ($itemText -match "\\[[1-9][0-9]*条\\]" -or $itemText -match "unread|new message") { return $true }
  try {
    if ([string]$item.Current.ItemStatus -match "未读|新消息|unread|new message") { return $true }
  } catch {}
  try {
    if ([string]$item.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::HelpTextProperty) -match "未读|新消息|unread|new message") { return $true }
  } catch {}
  try {
    $children = $item.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    for ($index = 0; $index -lt $children.Count; $index++) {
      $child = $children.Item($index)
      $text = Get-ElementText $child
      try { $childStatus = [string]$child.Current.ItemStatus } catch { $childStatus = "" }
      try { $helpText = [string]$child.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::HelpTextProperty) } catch { $helpText = "" }
      if ($text -match "未读|新消息|unread|new message" -or $childStatus -match "未读|新消息|unread|new message" -or $helpText -match "未读|新消息|unread|new message") { return $true }
      if ($text -notmatch "^[1-9][0-9]{0,2}$") { continue }
      try { $rect = $child.Current.BoundingRectangle } catch { continue }
      if ($rect.Width -le 40 -and $rect.Height -le 30) { return $true }
    }
  } catch {}
  return $false
}

function Get-SessionPreview([System.Windows.Automation.AutomationElement]$item, [string]$name) {
  $itemText = Get-ElementText $item
  if ([string]::IsNullOrWhiteSpace($itemText)) { return "" }
  if ($itemText.StartsWith($name, [System.StringComparison]::Ordinal)) {
    $itemText = $itemText.Substring($name.Length).Trim()
  }
  $itemText = [regex]::Replace($itemText, "^\\s*\\[[1-9][0-9]*条\\]\\s*", "")
  $itemText = [regex]::Replace($itemText, "\\s+(?:[01]?\\d|2[0-3]):[0-5]\\d$", "")
  return $itemText.Trim()
}

function Find-SessionItem($all, [string]$name, $windowRect) {
  $windowWidth = $windowRect.Right - $windowRect.Left
  $leftLimit = $windowRect.Left + [Math]::Max(280, $windowWidth * 0.42)
  for ($index = 0; $index -lt $all.Count; $index++) {
    $element = $all.Item($index)
    try { $automationId = [string]$element.Current.AutomationId } catch { $automationId = "" }
    if ($automationId -ceq "session_item_$name") { return $element }
    if ((Get-ElementText $element) -cne $name) { continue }
    try { $rect = $element.Current.BoundingRectangle } catch { continue }
    if ($rect.Left -ge $leftLimit -or $rect.Top -lt ($windowRect.Top + 55) -or $rect.Bottom -gt ($windowRect.Bottom - 35)) { continue }
    $item = $element
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    for ($level = 0; $level -lt 7; $level++) {
      try { $itemRect = $item.Current.BoundingRectangle } catch { break }
      if ($itemRect.Width -ge 150 -and $itemRect.Height -ge 36 -and $itemRect.Height -le 120 -and $itemRect.Left -lt $leftLimit) { return $item }
      try { $item = $walker.GetParent($item) } catch { $item = $null }
      if ($item -eq $null) { break }
    }
  }
  return $null
}

function Open-Session([System.Windows.Automation.AutomationElement]$item, [IntPtr]$hWnd) {
  [void][Win32WechatAutoReply]::ShowWindowAsync($hWnd, 9)
  [void][Win32WechatAutoReply]::SetForegroundWindow($hWnd)
  Start-Sleep -Milliseconds 150
  try {
    $selection = $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    if ($selection) { $selection.Select(); Start-Sleep -Milliseconds 150 }
  } catch {}
  try {
    $invoke = $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    if ($invoke) { $invoke.Invoke(); Start-Sleep -Milliseconds 150 }
  } catch {}
  try {
    $rect = $item.Current.BoundingRectangle
    $point = New-Object Win32WechatAutoReply+POINT
    [void][Win32WechatAutoReply]::GetCursorPos([ref]$point)
    [void][Win32WechatAutoReply]::SetCursorPos([int](($rect.Left + $rect.Right) / 2), [int](($rect.Top + $rect.Bottom) / 2))
    [Win32WechatAutoReply]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 50
    [Win32WechatAutoReply]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 450
    [void][Win32WechatAutoReply]::SetCursorPos($point.X, $point.Y)
    return $true
  } catch { return $false }
}

$mode = [Environment]::GetEnvironmentVariable("XIAOXI_AUTO_REPLY_MODE")
$expectedConversation = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_CONVERSATION")
$expectedMessage = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_MESSAGE")
$expectedRuntimeId = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_RUNTIME_ID")
$expectedPid = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_PID")
$expectedHwnd = [Environment]::GetEnvironmentVariable("XIAOXI_EXPECTED_HWND")
try { $allowed = @(([Environment]::GetEnvironmentVariable("XIAOXI_ALLOWED_NAMES") | ConvertFrom-Json)) } catch { Write-Result @{ ok = $false; reason = "whitelist_invalid" } }
if ($allowed.Count -eq 0) { Write-Result @{ ok = $false; reason = "whitelist_empty" } }

$process = Get-Process -Name Weixin, WeChat -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq "微信" } |
  Sort-Object Id -Descending |
  Select-Object -First 1
if ($process -eq $null) { Write-Result @{ ok = $false; reason = "wechat_window_missing" } }
if ($mode -eq "verify") {
  if ($expectedPid -and [int]$expectedPid -ne $process.Id) { Write-Result @{ ok = $false; reason = "wechat_process_changed" } }
  if ($expectedHwnd -and [int64]$expectedHwnd -ne [int64]$process.MainWindowHandle) { Write-Result @{ ok = $false; reason = "wechat_window_changed" } }
}

$hWnd = [IntPtr]$process.MainWindowHandle
try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd) } catch { $root = $null }
if ($root -eq $null) { Write-Result @{ ok = $false; reason = "automation_root_missing" } }
$windowRect = $root.Current.BoundingRectangle
if ($windowRect.Width -lt 400 -or $windowRect.Height -lt 300) { Write-Result @{ ok = $false; reason = "wechat_window_not_ready" } }
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)

if ($mode -eq "scan") {
  $matches = New-Object System.Collections.Generic.List[object]
  foreach ($name in $allowed) {
    $item = Find-SessionItem $all ([string]$name) $windowRect
    if ($item -eq $null -or -not (Test-Unread $item)) { continue }
    try { $rect = $item.Current.BoundingRectangle } catch { continue }
    [void]$matches.Add([pscustomobject]@{ name = [string]$name; item = $item; preview = Get-SessionPreview $item ([string]$name); top = [double]$rect.Top })
  }
  $match = $matches | Sort-Object top | Select-Object -First 1
  if ($match -eq $null) { Write-Result @{ ok = $false; reason = "no_unread_message" } }
  if ([string]::IsNullOrWhiteSpace([string]$match.preview)) { Write-Result @{ ok = $false; reason = "unread_preview_missing" } }
  if (-not (Open-Session $match.item $hWnd)) { Write-Result @{ ok = $false; reason = "conversation_open_failed" } }
  $expectedConversation = $match.name
  $expectedMessage = [string]$match.preview
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
}

$titleFound = $false
$headerLeft = $windowRect.Left + [Math]::Max(240, $windowRect.Width * 0.22)
for ($index = 0; $index -lt $all.Count; $index++) {
  $element = $all.Item($index)
  if ((Get-ElementText $element) -cne $expectedConversation) { continue }
  try { $rect = $element.Current.BoundingRectangle } catch { continue }
  if ($rect.Left -ge $headerLeft -and $rect.Top -ge ($windowRect.Top + 25) -and $rect.Top -le ($windowRect.Top + 125)) { $titleFound = $true; break }
}
if (-not $titleFound) { Write-Result @{ ok = $false; reason = "conversation_title_mismatch" } }

$chatLeft = $windowRect.Left + [Math]::Max(240, $windowRect.Width * 0.22)
$chatTop = $windowRect.Top + 105
$chatBottom = $windowRect.Bottom - 125
$bubbleCandidates = New-Object System.Collections.Generic.List[object]
$textCandidates = New-Object System.Collections.Generic.List[object]
for ($index = 0; $index -lt $all.Count; $index++) {
  $element = $all.Item($index)
  $text = Get-ElementText $element
  if ([string]::IsNullOrWhiteSpace($text) -or $text.Length -gt 500) { continue }
  try {
    $controlType = $element.Current.ControlType
    $automationId = [string]$element.Current.AutomationId
  } catch { continue }
  $isText = $controlType -eq [System.Windows.Automation.ControlType]::Text
  $isMessageBubble = $controlType -eq [System.Windows.Automation.ControlType]::ListItem -and $automationId -ceq "chat_message_list.qt_scrollarea_viewport.chat_bubble_item_view"
  if (-not $isText -and -not $isMessageBubble) { continue }
  if ($text -match "^([01]?\\d|2[0-3]):[0-5]\\d$" -or $text -match "^(查看更多消息|发送|语音输入|表情|截图|文件)$") { continue }
  try { $rect = $element.Current.BoundingRectangle } catch { continue }
  if ($rect.Width -le 0 -or $rect.Height -le 0 -or $rect.Height -gt [Math]::Max(220, $windowRect.Height * 0.32) -or $rect.Right -lt ($chatLeft + 55) -or $rect.Top -lt $chatTop -or $rect.Bottom -gt $chatBottom) { continue }
  $candidate = [pscustomobject]@{
    text = [string]$text
    key = Get-ElementKey $element $rect $text
    top = [double]$rect.Top
    bottom = [double]$rect.Bottom
  }
  if ($isMessageBubble) { [void]$bubbleCandidates.Add($candidate) } else { [void]$textCandidates.Add($candidate) }
}
$candidates = if ($bubbleCandidates.Count -gt 0) { $bubbleCandidates.ToArray() } else { $textCandidates.ToArray() }
$latest = $candidates | Sort-Object bottom, top -Descending | Select-Object -First 1
if ($latest -eq $null) { Write-Result @{ ok = $false; reason = "latest_text_message_missing" } }
if ($mode -eq "scan" -and $latest.text -cne $expectedMessage) {
  Write-Result @{ ok = $false; reason = "unread_preview_mismatch" }
}
if ($mode -eq "verify" -and ($latest.text -cne $expectedMessage -or $latest.key -cne $expectedRuntimeId)) {
  Write-Result @{ ok = $false; reason = "incoming_message_changed" }
}

Write-Result @{
  ok = $true
  conversation = [string]$expectedConversation
  message = [string]$latest.text
  runtimeId = [string]$latest.key
  pid = [int]$process.Id
  hWnd = [int64]$process.MainWindowHandle
}
`;

function createWechatAutoReplyDriver(powerShellRunner = runPowerShell) {
  function scanWechatIncoming(names) {
    const allowed = [...new Set((Array.isArray(names) ? names : []).map((name) => String(name || "").trim()).filter(Boolean))];
    if (!allowed.length) return { ok: false, reason: "whitelist_empty" };
    return powerShellRunner(AUTO_REPLY_SCAN_SCRIPT, {
      XIAOXI_AUTO_REPLY_MODE: "scan",
      XIAOXI_ALLOWED_NAMES: JSON.stringify(allowed)
    }, { ensure: false });
  }

  function verifyWechatIncoming(candidate = {}) {
    const conversation = String(candidate.conversation || "").trim();
    const message = String(candidate.message || "").trim();
    const runtimeId = String(candidate.runtimeId || "").trim();
    if (!conversation || !message) return { ok: false, reason: "incoming_message_missing" };
    if (!runtimeId) return { ok: false, reason: "incoming_identity_missing" };
    return powerShellRunner(AUTO_REPLY_SCAN_SCRIPT, {
      XIAOXI_AUTO_REPLY_MODE: "verify",
      XIAOXI_ALLOWED_NAMES: JSON.stringify([conversation]),
      XIAOXI_EXPECTED_CONVERSATION: conversation,
      XIAOXI_EXPECTED_MESSAGE: message,
      XIAOXI_EXPECTED_RUNTIME_ID: runtimeId,
      XIAOXI_EXPECTED_PID: String(candidate.pid || ""),
      XIAOXI_EXPECTED_HWND: String(candidate.hWnd || "")
    }, { ensure: false });
  }

  return { scanWechatIncoming, verifyWechatIncoming };
}

const driver = createWechatAutoReplyDriver();

module.exports = { AUTO_REPLY_SCAN_SCRIPT, createWechatAutoReplyDriver, ...driver };
