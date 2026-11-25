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
const { openWechatSearchResultAsync, focusWechatWindowAsync, runPowerShellAsync } = require("./wechat_window_driver.cjs");
const { customerSearchPlan } = require("./state_machine.cjs");

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
function Find-Anywhere([string]$type, $elementName) {
  foreach ($w in (Get-WxWindows)) { $hit = Find-Elements $w $type $elementName "" | Select-Object -First 1; if ($hit) { return $hit } }
  return $null
}
function Find-WindowWith([string]$type, $elementName) {
  foreach ($w in (Get-WxWindows)) { if ((Find-Elements $w $type $elementName "").Count) { return $w } }
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
  $mainWindow = Get-WxWindow "mmui::MainWindow"
  foreach ($inner in (Find-Elements $mainWindow "Window" $null "")) {
    $innerCancel = Find-Elements $inner "Button" "取消" "" | Select-Object -First 1
    if ($innerCancel) { Click-Element $innerCancel | Out-Null; Start-Sleep -Milliseconds 300 }
  }
  if ($question) {
    $confirmWindow = Find-WindowWith "Text" $question
    $cancel = if ($confirmWindow) { Find-Elements $confirmWindow "Button" "取消" "" | Select-Object -First 1 }
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
  $extra["windows"] = @(Get-WxWindows | ForEach-Object { $_.Current.ClassName + "/" + $_.Current.ControlType.ProgrammaticName.Replace("ControlType.", "") })
  Close-Profile; Out-Result $false $stage $reason $extra
}

$question = ""
if (-not $name) { Out-Result $false "input" "delete_name_missing" }
$question = '删除"' + $name + '"？'

# Second call: the confirm dialog the first call left open must still name exactly this person; only then 删除
# is pressed. Anything after the press that cannot be read back is unknown (the caller treats a timeout the same).
if ($phase -eq "commit") {
  $dialog = Find-WindowWith "Text" $question
  if (-not $dialog) { Stop-Before "commit" "confirm_dialog_gone" @{ notClicked = $true } }
  $deleteButton = Find-Elements $dialog "Button" "删除" "" | Select-Object -First 1
  if (-not $deleteButton) { Stop-Before "commit" "confirm_button_not_found" @{ notClicked = $true } }
  if (Test-UserInput) { Stop-Before "commit" "wechat_external_input_detected" @{ notClicked = $true } }
  Click-Element $deleteButton | Out-Null
  $gone = Wait-Element {
    $p = if (Get-WxWindow "mmui::ProfileUniquePop") { $true } else { Find-WindowWith "Text" $question }
    $m = Get-WxWindow "mmui::MainWindow"
    $rows = Find-Elements $m "ListItem" $null "mmui::ChatSessionCell" | Where-Object { $_.Current.Name -eq $name -or $_.Current.Name.StartsWith($name + " ") }
    $open = Find-Elements $m "Text" $name "mmui::XTextView"
    if (-not $p -and -not @($rows).Count -and -not @($open).Count) { $true }
  } 5000
  if ($gone) { Out-Result $true "done" "" @{ deleted = $true } }
  Out-Result $false "verify" "delete_outcome_unknown" @{ outcomeUnknown = $true }
}
Close-Profile
$main = Get-WxWindow "mmui::MainWindow"
if (-not $main) { Out-Result $false "window" "wechat_main_window_not_found" }
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
$members = Wait-Element { $cells = Find-Elements (Get-WxWindow "mmui::MainWindow") "Button" $null "mmui::ChatMemberCell"; if ($cells.Count) { ,$cells } }
if (-not $members) { Stop-Before "member" "chat_member_not_found" }
if (@($members).Count -ne 1 -or $members[0].Current.Name -ne $name) { Stop-Before "member" "chat_member_mismatch" @{ members = @($members).Count } }
Press-Element $members[0] "profile"

# 3. The profile card shows the same name, and the same 微信号 when the contact list has one.
$pop = Wait-Element { $p = Get-WxWindow "mmui::ProfileUniquePop"; if ($p -and (Find-Elements $p "Text" $name "").Count) { $p } }
if (-not $pop) { Stop-Before "profile" "profile_card_not_found" }
$idLabel = Find-Elements $pop "Text" "微信号：" "" | Select-Object -First 1
$shownId = ""
if ($idLabel) {
  $labelBox = $idLabel.Current.BoundingRectangle
  $value = Find-Elements $pop "Text" $null "" | Where-Object {
    $b = $_.Current.BoundingRectangle; $b.X -gt $labelBox.X -and [Math]::Abs($b.Y - $labelBox.Y) -le $labelBox.Height
  } | Sort-Object { $_.Current.BoundingRectangle.X } | Select-Object -First 1
  if ($value) { $shownId = [string]$value.Current.Name }
}
if ($wechatId -and $shownId -ne $wechatId) { Stop-Before "profile" "profile_wechat_id_mismatch" }

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
$dialog = Wait-Element { Find-WindowWith "Text" $question } 4000
if (-not $dialog) { Stop-Before "confirm" "confirm_text_mismatch" }
if (-not (Find-Elements $dialog "Button" "删除" "").Count) { Stop-Before "confirm" "confirm_button_not_found" }
if (-not $confirm) { Stop-Before "confirm" "dry_run_stopped_before_delete" @{ dryRun = $true; reached = "confirm" } }
Out-Result $true "confirm" "" @{ ready = $true }
`;

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

async function deleteOnce(contact, { confirm = false, uniqueName = false, runner = runPowerShellAsync, openConversation = openWechatSearchResultAsync, focus = focusWechatWindowAsync } = {}, markCommitting) {
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
  const context = { pid: window.pid, hWnd: window.hWnd };
  let opened = await Promise.resolve(openConversation(plan.query, { ...context, searchQueryType: plan.queryType, searchIdentity: { query: plan.query, expectedName: name } }));
  if (!opened?.ok && plan.fallbackQuery && plan.fallbackQuery !== plan.query) {
    opened = await Promise.resolve(openConversation(plan.fallbackQuery, { ...context, searchQueryType: "name_fallback", searchIdentity: { query: plan.fallbackQuery, expectedName: name } }));
  }
  if (!opened?.ok) return { ok: false, stage: "open", reason: String(opened?.reason || "conversation_open_failed") };
  const environment = { XIAOXI_DELETE_NAME: name, XIAOXI_DELETE_WECHAT_ID: wechatId, XIAOXI_EXPECTED_PID: String(window.pid || "") };
  const shape = (result, fallback) => ({ ok: result?.ok === true, deleted: result?.deleted === true, outcomeUnknown: result?.outcomeUnknown === true,
    dryRun: result?.dryRun === true, stage: String(result?.stage || "script"), reason: String(result?.reason || (result?.ok ? "" : fallback)),
    ...(Array.isArray(result?.windows) ? { windows: result.windows.map(String).slice(0, 12) } : {}),
    ...(Array.isArray(result?.menuItems) ? { menuItems: result.menuItems.map(String).slice(0, 8) } : {}) });
  // 1) Up to the confirm dialog, every identity checked; nothing is deleted.
  const prepared = await Promise.resolve(runner(DELETE_SCRIPT, { ...environment, XIAOXI_DELETE_PHASE: "prepare", XIAOXI_DELETE_CONFIRM: confirm ? "1" : "0" }, { ensure: false, timeout: 40000 }));
  if (!prepared?.ok || prepared.ready !== true) return shape(prepared, "delete_script_failed");
  // 2) Press 删除 and read it back. Whatever this call returns short of a clear answer is unknown, never retried.
  markCommitting();
  const committed = await Promise.resolve(runner(DELETE_SCRIPT, { ...environment, XIAOXI_DELETE_PHASE: "commit", XIAOXI_DELETE_CONFIRM: "1" }, { ensure: false, timeout: 20000 }));
  if (committed?.deleted === true) return shape(committed, "");
  if (committed?.notClicked === true) return shape(committed, "delete_not_pressed");
  return { ...shape(committed, "delete_outcome_unknown"), ok: false, deleted: false, outcomeUnknown: true, stage: String(committed?.stage || "commit") };
}

module.exports = { deleteWechatContact, DELETE_SCRIPT };
