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
}
"@
[XiaoxiDel]::SetProcessDPIAware() | Out-Null
$name = [string]$env:XIAOXI_DELETE_NAME
$wechatId = [string]$env:XIAOXI_DELETE_WECHAT_ID
$confirm = $env:XIAOXI_DELETE_CONFIRM -eq "1"
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
function Wait-Element([scriptblock]$probe, [int]$timeoutMs = 3000) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
  do { $found = & $probe; if ($found) { return $found }; Start-Sleep -Milliseconds 150 } while ([DateTime]::UtcNow -lt $deadline)
  return $null
}
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
  return $true
}
function Close-Profile {
  # Leave nothing open. A dialog drawn inside the main window (e.g. 发起群聊 from a stray press on 添加) is
  # cancelled by its own 取消; then the profile card's confirm is cancelled and Esc closes its menu/card.
  $mainWindow = Get-WxWindow "mmui::MainWindow"
  foreach ($inner in (Find-Elements $mainWindow "Window" $null "")) {
    $innerCancel = Find-Elements $inner "Button" "取消" "" | Select-Object -First 1
    if ($innerCancel) { Click-Element $innerCancel | Out-Null; Start-Sleep -Milliseconds 300 }
  }
  $pop = Get-WxWindow "mmui::ProfileUniquePop"
  if (-not $pop) { return }
  $cancel = Find-Elements $pop "Button" "取消" "" | Select-Object -First 1
  if ($cancel) { Click-Element $cancel | Out-Null; Start-Sleep -Milliseconds 300 }
  foreach ($i in 1..2) { [XiaoxiDel]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero); [XiaoxiDel]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 200 }
}
function Stop-Before($stage, $reason, $extra = @{}) {
  $extra["windows"] = @(Get-WxWindows | ForEach-Object { $_.Current.ClassName })
  Close-Profile; Out-Result $false $stage $reason $extra
}

if (-not $name) { Out-Result $false "input" "delete_name_missing" }
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
if (-not (Find-Elements $main "Button" $null "mmui::ChatMemberCell").Count) { Click-Element $info | Out-Null }
$members = Wait-Element { $cells = Find-Elements (Get-WxWindow "mmui::MainWindow") "Button" $null "mmui::ChatMemberCell"; if ($cells.Count) { ,$cells } }
if (-not $members) { Stop-Before "member" "chat_member_not_found" }
if (@($members).Count -ne 1 -or $members[0].Current.Name -ne $name) { Stop-Before "member" "chat_member_mismatch" @{ members = @($members).Count } }
Click-Element $members[0] | Out-Null

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
Click-Element $more | Out-Null
$menuItem = Wait-Element { Find-Elements (Get-WxWindow "mmui::ProfileUniquePop") "MenuItem" "删除联系人" "" | Select-Object -First 1 }
if (-not $menuItem) { Stop-Before "menu" "delete_menu_item_not_found" }
Click-Element $menuItem | Out-Null

# 5. The confirm text names exactly this person.
$question = '删除"' + $name + '"？'
$dialog = Wait-Element { $p = Get-WxWindow "mmui::ProfileUniquePop"; if ($p -and (Find-Elements $p "Text" $question "").Count) { $p } }
if (-not $dialog) { Stop-Before "confirm" "confirm_text_mismatch" }
$deleteButton = Find-Elements $dialog "Button" "删除" "" | Select-Object -First 1
if (-not $deleteButton) { Stop-Before "confirm" "confirm_button_not_found" }
if (-not $confirm) { Stop-Before "confirm" "dry_run_stopped_before_delete" @{ dryRun = $true; reached = "confirm" } }
Click-Element $deleteButton | Out-Null

# 6. Read the result back: the card is gone and no chat row or open chat carries the name.
$gone = Wait-Element {
  $p = Get-WxWindow "mmui::ProfileUniquePop"
  $m = Get-WxWindow "mmui::MainWindow"
  $rows = Find-Elements $m "ListItem" $null "mmui::ChatSessionCell" | Where-Object { $_.Current.Name -eq $name -or $_.Current.Name.StartsWith($name + " ") }
  $open = Find-Elements $m "Text" $name "mmui::XTextView"
  if (-not $p -and -not @($rows).Count -and -not @($open).Count) { $true }
} 5000
if ($gone) { Out-Result $true "done" "" @{ deleted = $true } }
Out-Result $false "verify" "delete_outcome_unknown" @{ outcomeUnknown = $true }
`;

// contact: { name, remark, nickname, wechatId } from the synced contact list. confirm=false stops at the confirm
// dialog (a look-only run). Returns { ok, deleted, outcomeUnknown, stage, reason }.
async function deleteWechatContact(contact, { confirm = false, runner = runPowerShellAsync, openConversation = openWechatSearchResultAsync, focus = focusWechatWindowAsync } = {}) {
  const name = String(contact?.remark || contact?.name || contact?.nickname || "").trim();
  if (!name) return { ok: false, stage: "input", reason: "delete_name_missing" };
  const window = await Promise.resolve(focus({}));
  if (!window?.ok) return { ok: false, stage: "window", reason: String(window?.reason || "wechat_window_not_ready") };
  const context = { pid: window.pid, hWnd: window.hWnd };
  const plan = customerSearchPlan(contact);
  let opened = await Promise.resolve(openConversation(plan.query, { ...context, searchQueryType: plan.queryType, searchIdentity: { query: plan.query, expectedName: name } }));
  if (!opened?.ok && plan.fallbackQuery && plan.fallbackQuery !== plan.query) {
    opened = await Promise.resolve(openConversation(plan.fallbackQuery, { ...context, searchQueryType: "name_fallback", searchIdentity: { query: plan.fallbackQuery, expectedName: name } }));
  }
  if (!opened?.ok) return { ok: false, stage: "open", reason: String(opened?.reason || "conversation_open_failed") };
  const result = await Promise.resolve(runner(DELETE_SCRIPT, {
    XIAOXI_DELETE_NAME: name,
    XIAOXI_DELETE_WECHAT_ID: String(contact?.wechatId || "").trim(),
    XIAOXI_DELETE_CONFIRM: confirm ? "1" : "0",
    XIAOXI_EXPECTED_PID: String(window.pid || "")
  }, { ensure: false, timeout: 40000 }));
  return { ok: result?.ok === true, deleted: result?.deleted === true, outcomeUnknown: result?.outcomeUnknown === true,
    dryRun: result?.dryRun === true, stage: String(result?.stage || "script"), reason: String(result?.reason || (result?.ok ? "" : "delete_script_failed")),
    ...(Array.isArray(result?.windows) ? { windows: result.windows } : {}) };
}

module.exports = { deleteWechatContact, DELETE_SCRIPT };
