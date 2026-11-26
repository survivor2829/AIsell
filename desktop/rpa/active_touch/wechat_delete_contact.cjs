"use strict";
// Deletes one friend in personal WeChat (user 2026-11-25: a contact who blocked or deleted the account should
// also leave the WeChat friend list). Path measured on WeChat 4.2.0.53 on the dev test account:
//   chat → 聊天信息 → the member cell → profile card (its own window, mmui::ProfileUniquePop) → 更多 → 删除联系人
//   → confirm 删除"<name>"？ → 删除
// Every element is found by its UI Automation name/type/class and clicked at the centre of its live bounding box:
// no coordinate or ratio is written down, so display scaling and window size do not matter.
// Identity is checked four times — chat title, member cell, profile card name (and 微信号 when known), and the
// confirm text — and any mismatch stops before 删除. After 删除 the result is read back; if it cannot be, the
// outcome is unknown and nothing is retried.
const { focusWechatWindowAsync, runPowerShellAsync, openWechatSearchResultAsync } = require("./wechat_window_driver.cjs");
const { customerSearchPlan } = require("./state_machine.cjs");
const { VISUAL_DELETE_SCRIPT } = require("./wechat_delete_contact_visual.cjs");
// The UI Automation steps cannot start: this WeChat gives no tree (b070e34b, 2026-11-26). Read the screen instead.
const NO_UIA_TREE = new Set(["wechat_main_window_not_found", "search_box_not_found"]);

const DELETE_SCRIPT = String.raw`
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class XiaoxiDel {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  // KEYBDINPUT inside INPUT: the union starts at 8 on 64-bit, at 4 on 32-bit (either PowerShell may run this).
  [StructLayout(LayoutKind.Explicit, Size = 40)] public struct INPUT64 {
    [FieldOffset(0)] public uint type; [FieldOffset(8)] public ushort vk; [FieldOffset(10)] public ushort scan;
    [FieldOffset(12)] public uint flags; [FieldOffset(16)] public uint time; [FieldOffset(24)] public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit, Size = 28)] public struct INPUT32 {
    [FieldOffset(0)] public uint type; [FieldOffset(4)] public ushort vk; [FieldOffset(6)] public ushort scan;
    [FieldOffset(8)] public uint flags; [FieldOffset(12)] public uint time; [FieldOffset(16)] public IntPtr extra; }
  [DllImport("user32.dll", EntryPoint = "SendInput")] static extern uint Send64(uint count, INPUT64[] inputs, int size);
  [DllImport("user32.dll", EntryPoint = "SendInput")] static extern uint Send32(uint count, INPUT32[] inputs, int size);
  // Types text as Unicode key presses: no clipboard, no input method in the way. False when Windows refused a key.
  public static bool TypeText(string text) {
    foreach (char ch in text) {
      uint sent;
      if (IntPtr.Size == 8) {
        var press = new INPUT64[2];
        press[0].type = 1; press[0].scan = ch; press[0].flags = 0x0004;
        press[1].type = 1; press[1].scan = ch; press[1].flags = 0x0004 | 0x0002;
        sent = Send64(2, press, Marshal.SizeOf(typeof(INPUT64)));
      } else {
        var press = new INPUT32[2];
        press[0].type = 1; press[0].scan = ch; press[0].flags = 0x0004;
        press[1].type = 1; press[1].scan = ch; press[1].flags = 0x0004 | 0x0002;
        sent = Send32(2, press, Marshal.SizeOf(typeof(INPUT32)));
      }
      if (sent != 2) return false;
      System.Threading.Thread.Sleep(15);
    }
    return true;
  }
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  public static uint LastInputTick() { var info = new LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(info);
    if (Environment.GetEnvironmentVariable("XIAOXI_UNATTENDED_INPUT") == "1") return 1u; return GetLastInputInfo(ref info) ? info.dwTime : UInt32.MaxValue; }
}
"@
[XiaoxiDel]::SetProcessDPIAware() | Out-Null
$name = [string]$env:XIAOXI_DELETE_NAME
$wechatId = [string]$env:XIAOXI_DELETE_WECHAT_ID
$confirm = $env:XIAOXI_DELETE_CONFIRM -eq "1"
$phase = [string]$env:XIAOXI_DELETE_PHASE
$expectedPid = [string]$env:XIAOXI_EXPECTED_PID
$expectedHwnd = [string]$env:XIAOXI_EXPECTED_HWND
$uniqueName = $env:XIAOXI_DELETE_UNIQUE_NAME -eq "1"
$ui = [System.Windows.Automation.AutomationElement]
$all = [System.Windows.Automation.Condition]::TrueCondition
$scope = [System.Windows.Automation.TreeScope]

function Out-Result($ok, $stage, $reason, $extra = @{}) {
  $result = @{ ok = [bool]$ok; stage = [string]$stage; reason = [string]$reason }
  foreach ($key in $extra.Keys) { $result[$key] = $extra[$key] }
  $result | ConvertTo-Json -Compress
  exit 0
}
function Get-WxWindows {
  $pids = @(Get-Process Weixin -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  @($ui::RootElement.FindAll($scope::Children, $all) | Where-Object { $pids -contains $_.Current.ProcessId })
}
function Get-WxWindow([string]$className) { Get-WxWindows | Where-Object { $_.Current.ClassName -eq $className } | Select-Object -First 1 }
# The chat window: the one the shared window rules already confirmed (its handle), whatever UI Automation calls
# it. 4.2.0.53 reports mmui::MainWindow, but 1.3.73 on a 200% laptop (b070e34b, 2026-11-26) found no window of
# that class and skipped all 36 people; a WeChat window holding the 搜索 box and the chat list is the fallback.
function Get-WxMain {
  if ($expectedHwnd) {
    try {
      $byHandle = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$expectedHwnd)
      if ($byHandle -and (-not $expectedPid -or [string]$byHandle.Current.ProcessId -eq $expectedPid)) { return $byHandle }
    } catch { }
  }
  $byClass = Get-WxWindow "mmui::MainWindow"
  if ($byClass) { return $byClass }
  # Only the chat window: the 搜索 box and the chat list together (a contacts or Moments window has a search box too).
  foreach ($w in @(Get-WxWindows)) {
    if (@(Find-Elements $w "Edit" "搜索" "").Count -and @(Find-Elements $w "ListItem" $null "mmui::ChatSessionCell").Count) { return $w }
  }
  $null
}
# $elementName is untyped on purpose: a [string] parameter turns $null ("any name") into "".
function Find-Elements($root, [string]$type, $elementName, [string]$className) {
  if (-not $root) { return @() }
  @($root.FindAll($scope::Descendants, $all) | Where-Object {
    $c = $_.Current
    (-not $type -or $c.ControlType.ProgrammaticName -eq "ControlType.$type") -and
    ($null -eq $elementName -or $c.Name -eq $elementName) -and
    (-not $className -or $c.ClassName -eq $className)
  })
}
# The first WeChat window holding a matching element: the 更多 menu and the delete confirm are drawn inside the
# profile card on 4.2.0.53, but another build or Windows version may give them a popup window of their own
# (user report 2026-11-25: the menu showed and vanished because it was looked for in the card only).
# Popups are searched before the main window, and by a UIA condition (not a full tree walk) so a short-lived menu
# is read before it closes.
function Find-Anywhere([string]$type, [string]$elementName) {
  $condition = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition($ui::ControlTypeProperty, [System.Windows.Automation.ControlType]::$type)),
    (New-Object System.Windows.Automation.PropertyCondition($ui::NameProperty, $elementName)))
  $windows = @(Get-WxWindows)
  foreach ($w in @($windows | Where-Object { $_.Current.ClassName -ne "mmui::MainWindow" }) + @($windows | Where-Object { $_.Current.ClassName -eq "mmui::MainWindow" })) {
    $hit = $w.FindFirst($scope::Descendants, $condition); if ($hit) { return $hit }
  }
  return $null
}
# The confirm's own button: walk up from the 删除"<name>"？ text to the nearest container holding exactly one button
# with this name. Never the first 删除 of a whole window (another build may draw the confirm inside the main window).
function Find-ConfirmButton([string]$buttonName) {
  $text = Find-Anywhere "Text" $question
  if (-not $text) { return $null }
  $condition = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition($ui::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
    (New-Object System.Windows.Automation.PropertyCondition($ui::NameProperty, $buttonName)))
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $node = $text
  foreach ($level in 1..4) {
    $node = $walker.GetParent($node)
    if (-not $node) { return $null }
    $buttons = $node.FindAll($scope::Descendants, $condition)
    if ($buttons.Count -eq 1) { return $buttons[0] }
    if ($buttons.Count -gt 1) { return $null }
  }
  return $null
}
function Wait-Element([scriptblock]$probe, [int]$timeoutMs = 3000) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
  do { $found = & $probe; if ($found) { return $found }; Start-Sleep -Milliseconds 150 } while ([DateTime]::UtcNow -lt $deadline)
  return $null
}
# Someone touching the mouse or keyboard stops the run before the next press (our own presses move the mark).
$script:ownInputTick = [XiaoxiDel]::LastInputTick()
function Test-UserInput { ([XiaoxiDel]::LastInputTick() - $script:ownInputTick) -gt 300 }
function Click-Element($element) {
  # Panels slide in: click only once the element has stopped moving (two equal reads in a row).
  $box = $element.Current.BoundingRectangle
  foreach ($i in 1..12) {
    Start-Sleep -Milliseconds 100
    $next = $element.Current.BoundingRectangle
    if ($next.X -eq $box.X -and $next.Y -eq $box.Y -and $next.Width -eq $box.Width) { break }
    $box = $next
  }
  if ($box.Width -le 0 -or $box.Height -le 0) { return $false }
  [XiaoxiDel]::SetCursorPos([int]($box.X + $box.Width / 2), [int]($box.Y + $box.Height / 2)) | Out-Null
  Start-Sleep -Milliseconds 90
  [XiaoxiDel]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [XiaoxiDel]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  $script:ownInputTick = [XiaoxiDel]::LastInputTick()
  return $true
}
function Press-Element($element, $stage) {
  if (Test-UserInput) { Stop-Before $stage "wechat_external_input_detected" }
  Click-Element $element | Out-Null
}
function Close-Profile {
  # Leave nothing open. A dialog drawn inside the main window (e.g. 发起群聊 from a stray press on 添加) is
  # cancelled by its own 取消; then the profile card's confirm is cancelled and Esc closes its menu/card.
  $mainWindow = Get-WxMain
  foreach ($inner in (Find-Elements $mainWindow "Window" $null "")) {
    $innerCancel = Find-Elements $inner "Button" "取消" "" | Select-Object -First 1
    if ($innerCancel) { Click-Element $innerCancel | Out-Null; Start-Sleep -Milliseconds 300 }
  }
  if ($question) {
    $cancel = Find-ConfirmButton "取消"
    if ($cancel) { Click-Element $cancel | Out-Null; Start-Sleep -Milliseconds 300 }
  }
  $pop = Get-WxWindow "mmui::ProfileUniquePop"
  if (-not $pop) { return }
  $cancel = Find-Elements $pop "Button" "取消" "" | Select-Object -First 1
  if ($cancel) { Click-Element $cancel | Out-Null; Start-Sleep -Milliseconds 300 }
  # Esc only while the card is still open: one more Esc on the main window hides WeChat to the tray.
  foreach ($i in 1..3) {
    if (-not (Get-WxWindow "mmui::ProfileUniquePop")) { break }
    [XiaoxiDel]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero); [XiaoxiDel]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 250
  }
  $script:ownInputTick = [XiaoxiDel]::LastInputTick()
}
function Stop-Before($stage, $reason, $extra = @{}) {
  # Which WeChat windows were open and what the step saw: the failure report then shows where a build differs.
  # (Plain identifiers under *_kind keys: the diagnostic log keeps those readable and hashes anything else.)
  $extra["window_kind"] = @(Get-WxWindows | ForEach-Object { $_.Current.ClassName })
  Close-Profile; Out-Result $false $stage $reason $extra
}

$question = ""
if (-not $name) { Out-Result $false "input" "delete_name_missing" }
$question = '删除"' + $name + '"？'

# First call: open this person's chat from WeChat's own search (user 2026-11-25: type the 微信号 and click the result,
# the way that works; no screenshot reading, no Enter). The result rows are read by UI Automation (class
# SearchContentCellView, named by the display name): the topmost row named exactly this person. Section headings
# (联系人/群聊) are not relied on: UI Automation does not always list them. Rows of the same name may be this person's
# chat history, or a group chat: a group is refused by the member-cell check, another friend by the card's 微信号.
# Keys go to the search box only: it is cleared and typed into only while it has the keyboard focus, so a draft in
# the chat input can never be touched.
function Clear-Search($searchBox) {
  if (-not $searchBox -or -not $searchBox.Current.HasKeyboardFocus) { return }
  [XiaoxiDel]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero); [XiaoxiDel]::keybd_event(0x41, 0, 0, [UIntPtr]::Zero)
  [XiaoxiDel]::keybd_event(0x41, 0, 2, [UIntPtr]::Zero); [XiaoxiDel]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
  [XiaoxiDel]::keybd_event(0x08, 0, 0, [UIntPtr]::Zero); [XiaoxiDel]::keybd_event(0x08, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
  $script:ownInputTick = [XiaoxiDel]::LastInputTick()
}
function Get-ContactResults($mainWindow) {
  if (-not $mainWindow) { return @() }
  $condition = New-Object System.Windows.Automation.PropertyCondition($ui::ClassNameProperty, "mmui::SearchContentCellView")
  @($mainWindow.FindAll($scope::Descendants, $condition))
}
if ($phase -eq "open") {
  $query = [string]$env:XIAOXI_DELETE_QUERY
  Close-Profile
  $main = Get-WxMain
  if (-not $main) { Out-Result $false "open" "wechat_main_window_not_found" @{ window_kind = @(Get-WxWindows | ForEach-Object { $_.Current.ClassName }) } }
  # Only the box WeChat names 搜索; never another edit box (the chat input holds the customer's drafts).
  $box = Find-Elements $main "Edit" "搜索" "" | Select-Object -First 1
  if (-not $box) { Out-Result $false "open" "search_box_not_found" }
  # The first click after WeChat comes to the front may only activate the window: click the box again if needed.
  $focused = $false
  foreach ($try in 1..3) {
    Press-Element $box "open"
    if (Wait-Element { if ($box.Current.HasKeyboardFocus) { $true } } 1500) { $focused = $true; break }
  }
  if (-not $focused) { Out-Result $false "open" "search_box_not_focused" }
  Clear-Search $box
  if (-not [XiaoxiDel]::TypeText($query)) { Clear-Search $box; Out-Result $false "open" "search_input_failed" }
  $script:ownInputTick = [XiaoxiDel]::LastInputTick()
  # What landed in the box, when WeChat exposes it: anything else is not searched on.
  $typed = $null
  try { $typed = [string]$box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { }
  if ($null -ne $typed -and $typed -and $typed -ne $query) { Clear-Search $box; Out-Result $false "open" "search_input_failed" }
  $state = @{ rows = 0 }
  $found = Wait-Element {
    $rows = @(Get-ContactResults (Get-WxMain))
    $state.rows = $rows.Count
    $same = @($rows | Where-Object { $_.Current.Name -eq $name })
    if ($same.Count) { ,$same }
  } 6000
  # No rows at all: WeChat had not answered yet (worth another try). Rows without this name: not found.
  if (-not $found) { Clear-Search $box; Out-Result $false "open" $(if ($state.rows) { "search_result_not_found" } else { "search_results_not_loaded" }) @{ result_count = $state.rows } }
  $target = @($found) | Sort-Object { $_.Current.BoundingRectangle.Y } | Select-Object -First 1
  Press-Element $target "open"
  # The chat is open when its title (left of 聊天信息) is this person.
  $opened = Wait-Element {
    $m = Get-WxMain
    $infoButton = Find-Elements $m "Button" "聊天信息" "" | Select-Object -First 1
    if ($infoButton) {
      $ib = $infoButton.Current.BoundingRectangle
      Find-Elements $m "Text" $name "" | Where-Object { $b = $_.Current.BoundingRectangle; $b.X -lt $ib.X -and [Math]::Abs(($b.Y + $b.Height / 2) - ($ib.Y + $ib.Height / 2)) -le $ib.Height } | Select-Object -First 1
    }
  } 4000
  if (-not $opened) { Out-Result $false "open" "chat_not_opened" }
  Out-Result $true "open" "" @{ opened = $true }
}

# Second call: the confirm dialog the first call left open must still name exactly this person; only then 删除
# is pressed. Anything after the press that cannot be read back is unknown (the caller treats a timeout the same).
if ($phase -eq "commit") {
  if (-not (Find-Anywhere "Text" $question)) { Stop-Before "commit" "confirm_dialog_gone" @{ notClicked = $true } }
  $deleteButton = Find-ConfirmButton "删除"
  if (-not $deleteButton) { Stop-Before "commit" "confirm_button_not_found" @{ notClicked = $true } }
  if (Test-UserInput) { Stop-Before "commit" "wechat_external_input_detected" @{ notClicked = $true } }
  Click-Element $deleteButton | Out-Null
  $gone = Wait-Element {
    $p = if (Get-WxWindow "mmui::ProfileUniquePop") { $true } else { Find-Anywhere "Text" $question }
    $m = Get-WxMain
    $rows = Find-Elements $m "ListItem" $null "mmui::ChatSessionCell" | Where-Object { $_.Current.Name -eq $name -or $_.Current.Name.StartsWith($name + " ") }
    $open = Find-Elements $m "Text" $name "mmui::XTextView"
    if (-not $p -and -not @($rows).Count -and -not @($open).Count) { $true }
  } 5000
  if ($gone) { Out-Result $true "done" "" @{ deleted = $true } }
  Out-Result $false "verify" "delete_outcome_unknown" @{ outcomeUnknown = $true }
}
Close-Profile
$main = Get-WxMain
if (-not $main) { Out-Result $false "window" "wechat_main_window_not_found" @{ window_kind = @(Get-WxWindows | ForEach-Object { $_.Current.ClassName }) } }
if ($expectedPid -and [string]$main.Current.ProcessId -ne $expectedPid) { Out-Result $false "window" "wechat_window_changed" }

# 1. The open chat is this person: the title sits on the row of the 聊天信息 button, left of it.
$info = Find-Elements $main "Button" "聊天信息" "" | Select-Object -First 1
if (-not $info) { Out-Result $false "title" "chat_info_button_not_found" }
$infoBox = $info.Current.BoundingRectangle
$title = Find-Elements $main "Text" $name "" | Where-Object {
  $b = $_.Current.BoundingRectangle; $b.X -lt $infoBox.X -and [Math]::Abs(($b.Y + $b.Height / 2) - ($infoBox.Y + $infoBox.Height / 2)) -le $infoBox.Height
} | Select-Object -First 1
if (-not $title) { Out-Result $false "title" "chat_title_mismatch" }

# 2. 聊天信息 → the one member cell, named exactly (a group chat has several and is refused). The button toggles
# the side panel, so it is pressed only when the panel is not already open.
if (-not (Find-Elements $main "Button" $null "mmui::ChatMemberCell").Count) { Press-Element $info "member" }
$members = Wait-Element { $cells = Find-Elements (Get-WxMain) "Button" $null "mmui::ChatMemberCell"; if ($cells.Count) { ,$cells } }
if (-not $members) { Stop-Before "member" "chat_member_not_found" }
if (@($members).Count -ne 1 -or $members[0].Current.Name -ne $name) { Stop-Before "member" "chat_member_mismatch" @{ members = @($members).Count } }
Press-Element $members[0] "profile"

# 3. The profile card shows the same name, and the same 微信号 when the contact list has one.
$pop = Wait-Element { $p = Get-WxWindow "mmui::ProfileUniquePop"; if ($p -and (Find-Elements $p "Text" $name "").Count) { $p } }
if (-not $pop) { Stop-Before "profile" "profile_card_not_found" }
# The 微信号 is read the way WeChat may draw it: a "微信号：" label with the value beside it (Text, or a selectable
# Edit whose text is its Value), or one element "微信号：xxx". Same row = vertical centres within the label height.
function Get-ElementText($element) {
  $text = [string]$element.Current.Name
  if (-not $text) { try { $text = [string]$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { } }
  return $text
}
$idCheck = @{ id_label_kind = "none"; id_value_kind = "none"; shown_length = 0; stored_length = $wechatId.Length }
$shownId = ""
$cardNodes = @($pop.FindAll($scope::Descendants, $all))
$idLabel = $cardNodes | Where-Object { $_.Current.Name -match '^\s*微信号\s*[:：]?' } | Select-Object -First 1
if ($idLabel) {
  $inline = ([string]$idLabel.Current.Name -replace '^\s*微信号\s*[:：]?\s*', '')
  if ($inline) { $shownId = $inline; $idCheck.id_label_kind = "inline"; $idCheck.id_value_kind = "inline" }
  else {
    $idCheck.id_label_kind = "separate"
    $labelBox = $idLabel.Current.BoundingRectangle
    $middle = $labelBox.Y + $labelBox.Height / 2
    $value = $cardNodes | Where-Object {
      $b = $_.Current.BoundingRectangle
      $b.X -ge ($labelBox.X + $labelBox.Width - 2) -and $b.Width -gt 0 -and [Math]::Abs(($b.Y + $b.Height / 2) - $middle) -le [Math]::Max($labelBox.Height, 12) -and (Get-ElementText $_)
    } | Sort-Object { $_.Current.BoundingRectangle.X } | Select-Object -First 1
    if ($value) { $shownId = Get-ElementText $value; $idCheck.id_value_kind = $value.Current.ControlType.ProgrammaticName.Replace("ControlType.", "").ToLower() }
  }
}
$normal = { param($text) ([string]$text -replace '[\s\u200b-\u200f\ufeff]', '').ToLowerInvariant() }
$idCheck.shown_length = $shownId.Length
$idCheck.same_ignoring_case = ((& $normal $shownId) -eq (& $normal $wechatId))
# Evidence only (a 微信号 differing in _ or - is a different 微信号): shows in the report whether a read lost symbols.
$idCheck.same_ignoring_symbols = (((& $normal $shownId) -replace '[_\-]', '') -eq ((& $normal $wechatId) -replace '[_\-]', ''))
$idCheck.id_check_state = if (-not $wechatId) { "no_stored_id" } elseif ($idCheck.same_ignoring_case) { "matched" }
  elseif ($shownId) { "mismatch" } elseif ($uniqueName) { "degraded_unread" } else { "unread" }
# Name already matched three times (title, member cell, card). A 微信号 read on the card that differs is another person:
# always stop (a delete cannot be undone). One that cannot be read at all is skipped only when no other synced friend
# shows this name (degraded, reported with how the card was read); otherwise stop.
if ($idCheck.id_check_state -eq "mismatch") { Stop-Before "profile" "profile_wechat_id_mismatch" @{ id_check = $idCheck } }
if ($idCheck.id_check_state -eq "unread") { Stop-Before "profile" "profile_wechat_id_unreadable" @{ id_check = $idCheck } }

# 4. 更多 (the card's own) → 删除联系人.
$more = Find-Elements $pop "Button" "更多" "" | Select-Object -First 1
if (-not $more) { Stop-Before "menu" "profile_more_not_found" }
Press-Element $more "menu"
$menuItem = Wait-Element { Find-Anywhere "MenuItem" "删除联系人" } 4000
# The menu closed again before it could be read (it flashes when the card is still settling): open it once more,
# only while the card is still there.
if (-not $menuItem) {
  $more = Find-Elements (Get-WxWindow "mmui::ProfileUniquePop") "Button" "更多" "" | Select-Object -First 1
  if (-not $more) { Stop-Before "menu" "profile_card_closed" }
  Start-Sleep -Milliseconds 400
  Press-Element $more "menu"
  $menuItem = Wait-Element { Find-Anywhere "MenuItem" "删除联系人" } 4000
}
if (-not $menuItem) {
  $items = @(Get-WxWindows | ForEach-Object { Find-Elements $_ "MenuItem" $null "" } | ForEach-Object { $_.Current.Name } | Select-Object -First 8)
  Stop-Before "menu" "delete_menu_item_not_found" @{ menuItems = $items }
}
Press-Element $menuItem "confirm"

# 5. The confirm text names exactly this person; the dialog is left open for the commit call.
$dialog = Wait-Element { Find-Anywhere "Text" $question } 5000
if (-not $dialog) {
  # A confirm naming someone else is a wrong person; no confirm at all is WeChat being slow (worth another try).
  $other = @(Get-WxWindows | ForEach-Object { Find-Elements $_ "Text" $null "" } | Where-Object { ([string]$_.Current.Name).StartsWith('删除"') })
  Stop-Before "confirm" $(if ($other.Count) { "confirm_text_mismatch" } else { "confirm_dialog_not_shown" })
}
if (-not (Find-ConfirmButton "删除")) { Stop-Before "confirm" "confirm_button_not_found" }
if (-not $confirm) { Stop-Before "confirm" "dry_run_stopped_before_delete" @{ dryRun = $true; reached = "confirm"; id_check = $idCheck } }
Out-Result $true "confirm" "" @{ ready = $true; id_check = $idCheck }
`;

// The same delete by looking at the screen (wechat_delete_contact_visual.cjs). The chat is opened with touch's own
// search and its title checked first, as touch does before it sends.
async function deleteVisually({ name, wechatId, plan, uniqueName, confirm, window, runner, opener, titleCheck, stopped }, markCommitting) {
  // As touch does (state_machine.cjs): after an unconfirmed 微信号 the name search may not take the first row.
  const queries = plan.queryType === "wechat_id" ? [[wechatId, "wechat_id"], [plan.fallbackQuery, "name_fallback"]] : [[plan.query, plan.queryType || "name"]];
  let opened = null;
  for (const [query, type] of queries) {
    if (!query) continue;
    if (stopped()) return { ok: false, stage: "open", reason: "stopped_by_user", visual: true };
    const fallbackReason = plan.queryType !== "wechat_id" ? String(plan.fallbackReason || "") : type === "wechat_id" ? ""
      : opened?.reason === "search_result_identity_unverified" ? "wechat_id_unverified" : "wechat_id_no_result";
    opened = await Promise.resolve(opener(query, { pid: window.pid, hWnd: window.hWnd, minIdleMs: 0, searchQueryType: type,
      searchFallbackReason: fallbackReason, searchIdentity: { expectedName: name } }));
    if (opened?.ok) break;
    if (!["exact_search_result_not_found", "search_result_identity_unverified"].includes(String(opened?.reason || ""))) break;
  }
  if (!opened?.ok) return { ok: false, stage: "open", reason: String(opened?.reason || "chat_not_opened"), visual: true };
  const title = await Promise.resolve(titleCheck(name, { pid: window.pid, hWnd: window.hWnd, verificationMode: "conversation_title" }));
  // The title is read from the screen too and can lose a character (a 1 read as l, dev machine 2026-11-26). The
  // card's 微信号 then decides alone: it must match exactly; without one to compare, stop.
  if (!title?.ok && !wechatId) return { ok: false, stage: "open", reason: "chat_title_mismatch", visual: true };
  // A row opened from a 微信号 one or two characters off (touch re-checks it strictly): the card must match exactly.
  const near = String(opened?.searchResultMode || "") === "sectioned_wechat_id_near";
  if (near && !wechatId) return { ok: false, stage: "open", reason: "chat_title_mismatch", visual: true };
  const environment = { XIAOXI_DELETE_NAME: name, XIAOXI_DELETE_WECHAT_ID: wechatId, XIAOXI_EXPECTED_PID: String(window.pid || ""),
    XIAOXI_EXPECTED_HWND: String(window.hWnd || ""), XIAOXI_DELETE_UNIQUE_NAME: uniqueName === true ? "1" : "0",
    XIAOXI_DELETE_REQUIRE_ID: title?.ok && !near ? "0" : "1" };
  const prepared = await Promise.resolve(runner(VISUAL_DELETE_SCRIPT, { ...environment, XIAOXI_VDEL_PHASE: "prepare", XIAOXI_DELETE_CONFIRM: confirm ? "1" : "0" }, { ensure: false, timeout: 60000 }));
  if (!prepared?.ok || prepared.ready !== true) return prepared || { ok: false, stage: "script", reason: "delete_script_failed", visual: true };
  markCommitting();
  // The windows that were already open before prepare: commit never takes, closes or counts them.
  const committed = await Promise.resolve(runner(VISUAL_DELETE_SCRIPT, { ...environment, XIAOXI_VDEL_PHASE: "commit",
    XIAOXI_VDEL_HAS_BASELINE: "1", XIAOXI_VDEL_BASELINE: String(prepared.baseline || "") },
    { ensure: false, timeout: 30000 }));
  // After the press: anything short of a clear "deleted" or "not pressed" is unknown, never retried.
  const known = committed?.deleted === true || committed?.notClicked === true;
  return { ...(committed || {}), ...(known ? {} : { ok: false, deleted: false, outcomeUnknown: true, stage: String(committed?.stage || "commit"),
    reason: String(committed?.reason || "delete_outcome_unknown") }), ...(prepared.id_check ? { id_check: prepared.id_check } : {}) };
}

// contact: { name, remark, nickname, wechatId } from the synced contact list. confirm=false stops at the confirm
// dialog (a look-only run). uniqueName: the caller checked that no other synced friend shows the same name; without
// a usable 微信号 to compare on the profile card that is the only thing telling two same-named friends apart, so the
// delete is refused without it. Never throws. Returns { ok, deleted, outcomeUnknown, stage, reason }.
async function deleteWechatContact(contact, options = {}) {
  let committing = false;
  try { return await deleteOnce(contact, options, () => { committing = true; }); }
  catch (error) {
    const reason = String(error?.message || "delete_failed").slice(0, 120);
    return committing ? { ok: false, deleted: false, outcomeUnknown: true, stage: "commit", reason } : { ok: false, deleted: false, outcomeUnknown: false, stage: "script", reason };
  }
}

async function deleteOnce(contact, { confirm = false, uniqueName = false, runner = runPowerShellAsync, focus = focusWechatWindowAsync, stopped = () => false,
  opener = openWechatSearchResultAsync, titleCheck = (...args) => require("./wechat_window_driver.dev.cjs").observeWechatConversationAsync(...args),
  visualOnly = process.env.XIAOXI_DELETE_VISUAL === "1" } = {}, markCommitting) {
  const name = String(contact?.remark || contact?.name || contact?.nickname || "").trim();
  if (!name) return { ok: false, stage: "input", reason: "delete_name_missing" };
  const plan = customerSearchPlan(contact);
  // The 微信号 is compared on the profile card only when it is a real one (a placeholder falls back to the name).
  const wechatId = plan.queryType === "wechat_id" ? String(contact?.wechatId || "").trim() : "";
  if (!wechatId && uniqueName !== true) return { ok: false, stage: "input", reason: "contact_name_not_unique" };
  const window = await Promise.resolve(focus({}));
  if (!window?.ok) return { ok: false, stage: "window", reason: String(window?.reason || "wechat_window_not_ready") };
  // The steps below are the WeChat 4 (Weixin.exe) layout measured on 4.2.0.53; WeChat 3 runs as WeChat.exe.
  // (Its Win32 class is a Qt one; mmui::MainWindow is what UI Automation reports, checked by the script.)
  if (!/^weixin$/iu.test(String(window.processName || ""))) {
    return { ok: false, stage: "window", reason: "wechat_version_unsupported" };
  }
  const shapeVisual = (result) => ({ ok: result?.ok === true && result?.deleted === true, deleted: result?.deleted === true, outcomeUnknown: result?.outcomeUnknown === true,
    dryRun: result?.dryRun === true, stage: String(result?.stage || "script"), reason: String(result?.reason || (result?.deleted ? "" : "delete_script_failed")), visual: true,
    ...(result?.notClicked === true ? { notClicked: true } : {}),
    ...(result?.id_check && typeof result.id_check === "object" ? { idCheck: result.id_check } : {}) });
  const visually = async () => shapeVisual(await deleteVisually({ name, wechatId, plan, uniqueName, confirm, window, runner, opener, titleCheck, stopped }, markCommitting));
  if (visualOnly) return visually();
  // Open the chat: by 微信号 first, then by name, each time clicking the search result named exactly this person.
  const queries = [...new Set([wechatId, name].filter(Boolean))];
  let opened = null;
  for (const query of queries) {
    if (stopped()) return { ok: false, stage: "open", reason: "stopped_by_user" };
    opened = await Promise.resolve(runner(DELETE_SCRIPT, { XIAOXI_DELETE_PHASE: "open", XIAOXI_DELETE_QUERY: query, XIAOXI_DELETE_NAME: name, XIAOXI_EXPECTED_PID: String(window.pid || ""), XIAOXI_EXPECTED_HWND: String(window.hWnd || "") },
      { ensure: false, timeout: 25000 }));
    if (opened?.ok === true && opened.opened === true) break;
    // Only "WeChat shows no such row" moves on to the name; anything else (someone at the mouse, no search box) stops.
    if (!["search_result_not_found", "search_results_not_loaded"].includes(String(opened?.reason || ""))) break;
  }
  if (NO_UIA_TREE.has(String(opened?.reason || ""))) return visually();
  if (!(opened?.ok === true && opened.opened === true)) return { ok: false, stage: "open", reason: String(opened?.reason || "conversation_open_failed"),
    ...(Number.isFinite(opened?.result_count) ? { resultCount: opened.result_count } : {}),
    ...(Array.isArray(opened?.window_kind) ? { window_kind: opened.window_kind.map(String).slice(0, 12) } : {}) };
  const environment = { XIAOXI_DELETE_NAME: name, XIAOXI_DELETE_WECHAT_ID: wechatId, XIAOXI_EXPECTED_PID: String(window.pid || ""), XIAOXI_EXPECTED_HWND: String(window.hWnd || ""),
    XIAOXI_DELETE_UNIQUE_NAME: uniqueName === true ? "1" : "0" };
  const shape = (result, fallback) => ({ ok: result?.ok === true, deleted: result?.deleted === true, outcomeUnknown: result?.outcomeUnknown === true,
    dryRun: result?.dryRun === true, stage: String(result?.stage || "script"), reason: String(result?.reason || (result?.ok ? "" : fallback)),
    ...(Array.isArray(result?.windows) ? { windows: result.windows.map(String).slice(0, 12) } : {}),
    ...(Array.isArray(result?.menuItems) ? { menuItems: result.menuItems.map(String).slice(0, 8) } : {}),
    ...(Array.isArray(result?.window_kind) ? { window_kind: result.window_kind.map(String).slice(0, 12) } : {}),
    ...(result?.id_check && typeof result.id_check === "object" ? { idCheck: result.id_check } : {}) });
  // 1) Up to the confirm dialog, every identity checked; nothing is deleted.
  const prepared = await Promise.resolve(runner(DELETE_SCRIPT, { ...environment, XIAOXI_DELETE_PHASE: "prepare", XIAOXI_DELETE_CONFIRM: confirm ? "1" : "0" }, { ensure: false, timeout: 40000 }));
  if (!prepared?.ok || prepared.ready !== true) return shape(prepared, "delete_script_failed");
  // 2) Press 删除 and read it back. Whatever this call returns short of a clear answer is unknown, never retried.
  markCommitting();
  const committed = await Promise.resolve(runner(DELETE_SCRIPT, { ...environment, XIAOXI_DELETE_PHASE: "commit", XIAOXI_DELETE_CONFIRM: "1" }, { ensure: false, timeout: 20000 }));
  if (committed?.deleted === true) return { ...shape(committed, ""), ...(prepared.id_check ? { idCheck: prepared.id_check } : {}) };
  if (committed?.notClicked === true) return shape(committed, "delete_not_pressed");
  return { ...shape(committed, "delete_outcome_unknown"), ok: false, deleted: false, outcomeUnknown: true, stage: String(committed?.stage || "commit") };
}

module.exports = { deleteWechatContact, DELETE_SCRIPT };
