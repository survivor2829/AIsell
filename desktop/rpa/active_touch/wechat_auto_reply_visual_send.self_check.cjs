const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  WECHAT_VISUAL_AUTO_REPLY_POWERSHELL,
  createVisualAutoReplySender
} = require("./wechat_auto_reply_visual_send.dev.cjs");

assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /GetWindowThreadProcessId\(\$hWnd, \[ref\]\$actualPid\)[\s\S]*\[int\]\$actualPid -ne \$expectedPid[\s\S]*@\("Weixin", "WeChat"\) -notcontains \$process\.ProcessName/u);
const visualSendLock = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.slice(
  WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Get-VisualSendLock"),
  WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Get-VisualSendFrame")
);
assert.doesNotMatch(visualSendLock, /Get-MomentsRenderPaneEvidence|visual_send_render_pane_missing/u, "visual send must use the verified WeChat top-level window instead of a Moments-only child pane");
assert.doesNotMatch(visualSendLock, /MainWindowHandle|MainWindowTitle|GetWindowText|AutomationElement|UIAutomation|automation_root/u, "the cross-machine lock must bind the expected HWND to its owning WeChat PID without unreliable process-main-window, title or UIA gates");
assert.match(visualSendLock, /IsWindowVisible\(\$hWnd\)[\s\S]*IsIconic\(\$hWnd\)[\s\S]*GetWindowRect\(\$hWnd[\s\S]*GetForegroundWindow\(\) -ne \$hWnd/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /Test-VisualSendConversation[\s\S]*Normalize-VisualSendText/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /state = "matched"[\s\S]*state = "different"[\s\S]*state = "unresolved"/u, "header OCR must expose matched, explicit-different and unresolved states");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /\[Math\]::Min\(\$expected\.Length, \$observed\.Length\) -ge 4[\s\S]*\$distance \/ \[double\]\$maximumLength\) -ge 0\.55/u, "sender and observer must share the clearly-different title threshold");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Get-VisualSendConversationBinding[\s\S]*state -ceq "matched"[\s\S]*Test-VisualSendSelectedSidebarConversation[\s\S]*proof = "selected_sidebar_row"[\s\S]*visual_send_conversation_not_bound/u, "conversation identity must be either a matched header or the uniquely selected expected sidebar row");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /if \(\$messageDriven\)[\s\S]*proof = "message_driven"[\s\S]*headerState = "not_required"/u, "red-dot auto reply must bind the live incoming message without a contact-name gate");
const postClickVerification = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.slice(
  WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("$postLock = Get-VisualSendLock"),
  WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("$afterDraft = Read-VisualSendDraft")
);
assert.match(postClickVerification, /\$sameConversation = \$true/u, "post-click verification must retain the exact HWND already bound immediately before clicking");
assert.doesNotMatch(postClickVerification, /Get-VisualSendFrame|Test-VisualSendConversation|Test-VisualSendOutgoingBubble|Get-MomentsOcrObservation/u, "post-click verification must not run a third full-frame OCR pass");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /\$script:VisualSendOcrDownscale = if \(\[double\]\$dpi -ge 240\.0\) \{ 2 \} else \{ 1 \}/u, "only extreme-DPI windows should use adaptive OCR downscaling");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Test-VisualSendIncoming[\s\S]*height = \[double\]\(\$frame\.height \* 0\.69\)/u, "incoming verification must include messages immediately above the composer");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Test-VisualSendLatestIncoming[\s\S]*Get-MomentsDownscaledOcrObservation \$frame @\{ left = 0\.0; top = 0\.0; width = \[double\]\$frame\.width; height = \[double\]\$frame\.height \} \$script:VisualSendOcrDownscale/u, "the final incoming guard must reuse full-frame OCR geometry with adaptive high-DPI downscaling");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Get-VisualSendIncomingEvidenceSignature[\s\S]*visual-message-semantic-v1[\s\S]*Normalize-VisualSendText[\s\S]*\$role[\s\S]*Get-VisualSendSha256/u, "the final guard must reproduce the scanner's semantic bubble identity");
assert.doesNotMatch(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /\/ 120\.0/u, "all Win32 DPI scaling must use the 96-DPI logical baseline");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /\$dpi \/ 96\.0/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /\$expectedIncomingSignature -match "\^\[a-f0-9\]\{64\}\$"[\s\S]*Get-VisualSendIncomingEvidenceSignature/u, "a bound bubble signature must take precedence over cross-region OCR text equality");
assert.doesNotMatch(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /incomingWasVerified|XIAOXI_VISUAL_SEND_INCOMING_VERIFIED/u, "the sender must never trust the occurrence observed before AI generation");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /@\("preflight", "draft"\) -contains \$phase[\s\S]*Test-VisualSendLatestIncoming[\s\S]*visual_send_incoming_changed[\s\S]*if \(\$phase -ceq "draft"\)[\s\S]*Write-VisualSendDraft/u, "both preflight and the final pre-draft phase must bind the live latest customer bubble before writing");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Test-VisualSendSelectedSidebarConversation[\s\S]*Resolve-VisualSendSidebarConversation[\s\S]*visual_send_sidebar_contact_ambiguous[\s\S]*\$nameMatches\.Count -ne 1[\s\S]*Get-VisualSendGreenRatio[\s\S]*\$greenRatio -ge 0\.55/u, "title fallback must globally disambiguate the expected contact and prove its selected green row");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /Preview OCR is optional[\s\S]*\$previewCandidates\.Count -gt 0[\s\S]*\$nameBottom \+ \(20\.0 \* \$logicalScale\)/u, "selected-row identity must not require preview OCR");
const latestIncomingFunction = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.slice(
  WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Test-VisualSendLatestIncoming"),
  WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Test-VisualSendGreenPixel")
);
assert.doesNotMatch(latestIncomingFunction, /SelectedSidebarConversation|SidebarPreview/u, "sidebar identity is separate from proof of the latest incoming bubble");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Get-VisualSendMessageRole/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /\$greenRatio -ge 0\.16/u, "the final guard must reject our long green bubbles before using geometry");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /GetDpiForWindow/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Get-VisualSendSidebarRight/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Get-VisualSendChatBottom/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /return \[double\]\$frame\.height \* 0\.60/u, "unknown composer geometry must fail closed above a potentially enlarged composer");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /\$top -gt \$chatBottom/u, "draft text below the proven divider must be excluded");
assert.doesNotMatch(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /frame\.width \* 0\.273|frame\.height \* 0\.88/u, "final geometry must not use one-machine fixed ratios");
assert.doesNotMatch(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /\$chatMid/u, "the final guard must not infer sender from one midpoint comparison");
const sendClickPhase = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.slice(
  WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf('if ($phase -cne "send")'),
  WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("$sendAttempted = $true")
);
assert.doesNotMatch(sendClickPhase, /Test-VisualSendLatestIncoming|visual_send_incoming_changed/u, "composer expansion must not trigger a second geometry-dependent incoming check");
assert.match(sendClickPhase, /Get-VisualSendConversationBinding \$fresh[\s\S]*if \(-not \$freshBinding\.ok\)[\s\S]*Clear-VisualSendDraft \$lock[\s\S]*reason = \$freshBinding\.reason/u, "the final click phase must rebind the expected conversation and clear the draft if it changed");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Clear-VisualSendDraft[\s\S]*\{BACKSPACE\}[\s\S]*\$readback\.empty/u, "pre-click failures need a verified draft cleanup path");
assert.match(sendClickPhase, /Find-VisualSendButton[\s\S]*Clear-VisualSendDraft \$lock[\s\S]*visual_send_button_not_owned[\s\S]*Clear-VisualSendDraft \$lock[\s\S]*visual_send_cursor_not_verified/u, "owned pre-click failures must not leave a stale draft behind");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Test-VisualSendOutgoingBubble[\s\S]*Get-VisualSendChatBottom \$frame \$sidebarRight[\s\S]*Test-VisualSendOutgoingLineEvidence/u, "post-send verification must inspect the dynamic bottom of the chat");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Test-VisualSendOutgoingLineEvidence[\s\S]*\$latest = \$ordered\[-1\][\s\S]*Get-VisualSendLineGreenRatio[\s\S]*Test-VisualSendGreenBridge/u, "only the latest connected green bubble may verify a send");
assert.doesNotMatch(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Test-VisualSendOutgoingBubble[\s\S]*height = \[double\]\(\$frame\.height \* 0\.64\)/u, "post-send verification must not stop above a bottom bubble");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /Read-VisualSendDraft[\s\S]*\^a[\s\S]*\^c/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /Read-VisualSendDraft[\s\S]*Test-VisualSendOwnedPoint/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /Normalize-VisualSendDraftText[\s\S]*-ceq \(Normalize-VisualSendDraftText \$expectedReply\)/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Write-VisualSendDraft[\s\S]*\^v[\s\S]*Read-VisualSendDraft/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Find-VisualSendButton[\s\S]*ocr_send_label/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Find-VisualSendGreenComponents[\s\S]*green_component/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /greenRatio -ge 0\.35[\s\S]*componentRight -ge \(\$frame\.width \* 0\.91\)[\s\S]*components\.Count -ne 1/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /WindowFromPoint[\s\S]*GetAncestor/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /Get-MomentsVisualFrame \$lock\.hWnd \$lock\.rect \$lock\.pid \$false \$false/u, "auto-reply capture must skip the Moments-only nine-point viewport ownership gate");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Get-MomentsVisualFrame\([\s\S]*\[bool\]\$requireFullViewportOwnership = \$true[\s\S]*if \(\$requireFullViewportOwnership -and/u, "Moments capture must keep full-viewport ownership as its default");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /\$sendAttempted = \$true[\s\S]*AtomicMouseClick\(\$screenX, \$screenY\)[\s\S]*Update-VisualSendInputLease/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /draft_consumed_same_header/u);
assert.match(createVisualAutoReplySender.toString(), /catch \{[\s\S]*visual_send_outcome_unknown[\s\S]*sendAttempted: true/u, "a rejected final send phase must be fenced as possibly clicked");

const normalizeStart = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Normalize-VisualSendText");
const lockStart = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Get-VisualSendLock", normalizeStart);
const evidenceStart = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Get-VisualSendIncomingEvidenceSignature");
const evidenceEnd = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Test-VisualSendLatestIncoming", evidenceStart);
assert.ok(normalizeStart >= 0 && lockStart > normalizeStart && evidenceStart >= 0 && evidenceEnd > evidenceStart);
const evidenceProgram = `
${WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.slice(normalizeStart, lockStart)}
${WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.slice(evidenceStart, evidenceEnd)}
$line = @{ text = "bubble-ocr"; width = 80.0; height = 16.0 }
@{
  user96 = Get-VisualSendIncomingEvidenceSignature $line "user" 96.0
  user144 = Get-VisualSendIncomingEvidenceSignature $line "user" 144.0
  assistant = Get-VisualSendIncomingEvidenceSignature $line "assistant" 96.0
} | ConvertTo-Json -Compress
`;
const evidenceProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(evidenceProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(evidenceProbe.status, 0, evidenceProbe.stderr || evidenceProbe.stdout);
const evidenceResult = JSON.parse(evidenceProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1));
assert.equal(evidenceResult.user96, createHash("sha256").update("visual-message-semantic-v1\nbubble-ocr\nuser", "utf8").digest("hex"));
assert.equal(evidenceResult.user144, evidenceResult.user96, "DPI reflow must not change a semantic incoming occurrence");
assert.notEqual(evidenceResult.assistant, evidenceResult.user96, "an outgoing role must never satisfy the bound incoming evidence");

const conversationMatchProgram = `
${WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.slice(normalizeStart, lockStart)}
@{
  drift = Test-VisualSendConversationMatch ("A" + [char]27979 + [char]35797 + [char]23458 + [char]25143) ("A" + [char]27701 + [char]21017 + [char]35797 + [char]23458 + [char]25143)
  unrelated = Test-VisualSendConversationMatch ("A" + [char]27979 + [char]35797 + [char]23458 + [char]25143) ("B" + [char]27979 + [char]35797 + [char]23458 + [char]25143)
} | ConvertTo-Json -Compress
`;
const conversationMatchProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(conversationMatchProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(conversationMatchProbe.status, 0, conversationMatchProbe.stderr || conversationMatchProbe.stdout);
assert.deepEqual(JSON.parse(conversationMatchProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  drift: true,
  unrelated: false
});

const uniqueConversationProgram = `
$allowedConversationNames = @("A1ZZ", "A2ZZ")
$expectedConversation = "A1ZZ"
$expectedConversationEvidence = "A3ZZ"
${WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.slice(normalizeStart, lockStart)}
$ambiguous = Resolve-VisualSendAllowedConversation "A3ZZ"
$exact = Resolve-VisualSendAllowedConversation "A1ZZ"
@{
  ambiguous = [bool]$ambiguous.ambiguous
  ambiguousOk = [bool]$ambiguous.ok
  exact = [string]$exact.conversation
  exactOk = [bool]$exact.ok
} | ConvertTo-Json -Compress
`;
const uniqueConversationProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(uniqueConversationProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(uniqueConversationProbe.status, 0, uniqueConversationProbe.stderr || uniqueConversationProbe.stdout);
assert.deepEqual(JSON.parse(uniqueConversationProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  ambiguous: true,
  ambiguousOk: false,
  exact: "A1ZZ",
  exactOk: true
});

const conversationProbeStart = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Test-VisualSendConversation($frame)");
const conversationProbeEnd = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Test-VisualSendIncoming($frame)", conversationProbeStart);
assert.ok(conversationProbeStart >= 0 && conversationProbeEnd > conversationProbeStart);
const conversationStateProgram = `
$allowedConversationNames = @("ATestCustomer")
$expectedConversation = "ATestCustomer"
$expectedConversationEvidence = "ATestCustomer"
${WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.slice(normalizeStart, lockStart)}
${WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.slice(conversationProbeStart, conversationProbeEnd)}
$script:headerCase = "matched"
function Get-MomentsScaledOcrObservation($frame, $rect, $scale) {
  if ($script:headerCase -ceq "failed") { return @{ ok = $false; lines = @() } }
  $texts = switch ($script:headerCase) {
    "matched" { @("ATestCustomer") }
    "different" { @("CompletelyOther") }
    "firstDrift" { @("BTestCustomer") }
    "lastDrift" { @("ATestCustomeX") }
    "short" { @("Bob") }
    "ambiguous" { @("BTestCustomer", "Settings") }
  }
  $lines = @($texts | ForEach-Object {
    [pscustomobject]@{ text = $_; bounds = @{ left = 250.0; top = 10.0; width = 110.0; height = 20.0 } }
  })
  return @{ ok = $true; lines = $lines }
}
$frame = @{ width = 1000; height = 700 }
$script:headerCase = "matched"; $matched = Test-VisualSendConversation $frame
$script:headerCase = "different"; $different = Test-VisualSendConversation $frame
$script:headerCase = "firstDrift"; $firstDrift = Test-VisualSendConversation $frame
$script:headerCase = "lastDrift"; $lastDrift = Test-VisualSendConversation $frame
$script:headerCase = "short"; $short = Test-VisualSendConversation $frame
$script:headerCase = "ambiguous"; $ambiguous = Test-VisualSendConversation $frame
$script:headerCase = "failed"; $failed = Test-VisualSendConversation $frame
@{
  matched = $matched.state
  different = $different.state
  differentOk = $different.ok
  firstDrift = $firstDrift.state
  lastDrift = $lastDrift.state
  short = $short.state
  ambiguous = $ambiguous.state
  failed = $failed.state
} | ConvertTo-Json -Compress
`;
const conversationStateProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(conversationStateProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(conversationStateProbe.status, 0, conversationStateProbe.stderr || conversationStateProbe.stdout);
assert.deepEqual(JSON.parse(conversationStateProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  ambiguous: "unresolved",
  different: "different",
  differentOk: false,
  failed: "unresolved",
  firstDrift: "unresolved",
  lastDrift: "unresolved",
  short: "unresolved",
  matched: "matched"
});

const pureStart = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Test-VisualSendPureMessageText");
const previewHelperEnd = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Get-VisualSendSidebarRight", pureStart);
assert.ok(pureStart >= 0 && previewHelperEnd > pureStart);
const previewHelperProgram = `
${WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.slice(normalizeStart, lockStart)}
${WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.slice(pureStart, previewHelperEnd)}
$expectedConversation = "A测试客户"
$expectedIncoming = "你好"
$frame = @{ height = 700 }
$name = [pscustomobject]@{ text = "A测试客户10:28"; bounds = @{ left = 80.0; top = 100.0; width = 110.0; height = 20.0 } }
$matching = [pscustomobject]@{ text = "你好"; bounds = @{ left = 80.0; top = 122.0; width = 45.0; height = 18.0 } }
$changed = [pscustomobject]@{ text = "另一条"; bounds = @{ left = 80.0; top = 122.0; width = 60.0; height = 18.0 } }
$draft = [pscustomobject]@{ text = "[草稿]你好"; bounds = @{ left = 80.0; top = 122.0; width = 95.0; height = 18.0 } }
@{
  exact = Test-VisualSendSelectedSidebarPreview $frame @($name, $matching) 300.0 1.0
  changed = Test-VisualSendSelectedSidebarPreview $frame @($name, $changed) 300.0 1.0
  draft = Test-VisualSendSelectedSidebarPreview $frame @($name, $draft) 300.0 1.0
  ambiguous = Test-VisualSendSelectedSidebarPreview $frame @($name, $name, $matching) 300.0 1.0
} | ConvertTo-Json -Compress
`;
const previewHelperProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(previewHelperProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(previewHelperProbe.status, 0, previewHelperProbe.stderr || previewHelperProbe.stdout);
assert.deepEqual(JSON.parse(previewHelperProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  ambiguous: false,
  changed: false,
  draft: false,
  exact: true
});

const sidebarNameStart = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Test-VisualSendPureMessageText");
const sidebarNameEnd = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Get-VisualSendSidebarRight", sidebarNameStart);
const selectedRowStart = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Test-VisualSendSelectedSidebarConversation");
const selectedRowEnd = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Get-VisualSendLineGreenRatio", selectedRowStart);
assert.ok(sidebarNameStart >= 0 && sidebarNameEnd > sidebarNameStart && selectedRowStart >= 0 && selectedRowEnd > selectedRowStart);
const selectedRowProgram = `
${WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.slice(normalizeStart, lockStart)}
${WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.slice(sidebarNameStart, sidebarNameEnd)}
${WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.slice(selectedRowStart, selectedRowEnd)}
$allowedConversationNames = @("ATestCustomer", "BTestCustomer")
$expectedConversation = "ATestCustomer"
$expectedConversationEvidence = "ATestCustomer"
$script:VisualSendAllowedNames = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($name in $allowedConversationNames) { [void]$script:VisualSendAllowedNames.Add($name) }
$frame = @{ width = 1000; height = 700 }
$script:headerState = "unresolved"
$script:selectedNameTop = 180.0
$script:duplicateExpected = $false
$script:includePreview = $true
function Test-VisualSendConversation($frame) {
  return @{ ok = $script:headerState -ceq "matched"; state = $script:headerState; reason = "test_header" }
}
function Get-MomentsOcrObservation($frame, $rect) {
  $lines = New-Object System.Collections.Generic.List[object]
  [void]$lines.Add([pscustomobject]@{ text = "ATestCustomer"; bounds = @{ left = 80.0; top = 100.0; width = 112.0; height = 20.0 } })
  [void]$lines.Add([pscustomobject]@{ text = "BTestCustomer"; bounds = @{ left = 80.0; top = 180.0; width = 112.0; height = 20.0 } })
  if ($script:includePreview) {
    # Both contacts have identical previews. Preview text must not identify the
    # selected conversation.
    [void]$lines.Add([pscustomobject]@{ text = "same-message"; bounds = @{ left = 80.0; top = 122.0; width = 90.0; height = 18.0 } })
    [void]$lines.Add([pscustomobject]@{ text = "same-message"; bounds = @{ left = 80.0; top = 202.0; width = 90.0; height = 18.0 } })
  }
  if ($script:duplicateExpected) {
    [void]$lines.Add([pscustomobject]@{ text = "ATestCustomer"; bounds = @{ left = 80.0; top = 260.0; width = 112.0; height = 20.0 } })
  }
  return @{ ok = $true; lines = @($lines.ToArray()) }
}
function Get-MomentsDownscaledOcrObservation($frame, $rect, [int]$factor = 1) {
  return Get-MomentsOcrObservation $frame $rect
}
function Get-VisualSendGreenRatio($frame, [int]$left, [int]$top, [int]$right, [int]$bottom) {
  $selectedStripTop = [int]($script:selectedNameTop - 8.0)
  return $(if ([Math]::Abs($top - $selectedStripTop) -le 1) { 0.9 } else { 0.1 })
}
$wrongContactSameText = Get-VisualSendConversationBinding $frame 300.0 96.0
$script:selectedNameTop = 100.0
$expectedSelected = Get-VisualSendConversationBinding $frame 300.0 96.0
$script:includePreview = $false
$expectedSelectedWithoutPreview = Get-VisualSendConversationBinding $frame 300.0 96.0
$script:duplicateExpected = $true
$ambiguousExpected = Get-VisualSendConversationBinding $frame 300.0 96.0
$script:duplicateExpected = $false
$script:selectedNameTop = 180.0
$script:headerState = "matched"
$matchedHeader = Get-VisualSendConversationBinding $frame 300.0 96.0
@{
  wrongContactSameText = $wrongContactSameText.ok
  expectedSelected = $expectedSelected.ok
  expectedProof = $expectedSelected.proof
  expectedSelectedWithoutPreview = $expectedSelectedWithoutPreview.ok
  ambiguousExpected = $ambiguousExpected.ok
  matchedHeader = $matchedHeader.ok
  matchedHeaderProof = $matchedHeader.proof
} | ConvertTo-Json -Compress
`;
const selectedRowTemp = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-visual-send-self-check-"));
const selectedRowFile = path.join(selectedRowTemp, "selected-row.ps1");
fs.writeFileSync(selectedRowFile, selectedRowProgram, "utf8");
let selectedRowProbe;
try {
  selectedRowProbe = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", selectedRowFile], { encoding: "utf8" });
} finally {
  fs.rmSync(selectedRowTemp, { recursive: true, force: true });
}
assert.equal(selectedRowProbe.status, 0, selectedRowProbe.stderr || selectedRowProbe.stdout);
assert.deepEqual(JSON.parse(selectedRowProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  ambiguousExpected: false,
  expectedProof: "selected_sidebar_row",
  expectedSelected: true,
  expectedSelectedWithoutPreview: true,
  matchedHeader: true,
  matchedHeaderProof: "header_title",
  wrongContactSameText: false
});

const sidebarStart = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Get-VisualSendSidebarRight");
const sidebarEnd = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Get-VisualSendRowStats", sidebarStart);
assert.ok(sidebarStart >= 0 && sidebarEnd > sidebarStart);
const sidebarFunction = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.slice(sidebarStart, sidebarEnd);
const sidebarProgram = `${sidebarFunction}
@{
  narrow100 = Get-VisualSendSidebarRight 660 96
  wide100 = Get-VisualSendSidebarRight 880 96
  wide125 = Get-VisualSendSidebarRight 1100 120
  wide150 = Get-VisualSendSidebarRight 1320 144
} | ConvertTo-Json -Compress`;
const sidebarProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(sidebarProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(sidebarProbe.status, 0, sidebarProbe.stderr || sidebarProbe.stdout);
assert.deepEqual(JSON.parse(sidebarProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  narrow100: 297,
  wide100: 300,
  wide125: 375,
  wide150: 450
});

const chatStart = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Get-VisualSendRowStats");
const chatEnd = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Test-VisualSendLatestIncoming", chatStart);
assert.ok(chatStart >= 0 && chatEnd > chatStart);
const chatFunctions = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.slice(chatStart, chatEnd);
const chatProgram = `
function Get-MomentsPixel($frame, [int]$x, [int]$y) {
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $frame.width -or $y -ge $frame.height) { return $null }
  $offset = ($y * $frame.stride) + ($x * 4)
  return @{ b = [int]$frame.bytes[$offset]; g = [int]$frame.bytes[$offset + 1]; r = [int]$frame.bytes[$offset + 2] }
}
${chatFunctions}
function New-ChatFrame([int]$width, [int]$height, [byte]$fill) {
  $stride = $width * 4
  $frame = @{ width = $width; height = $height; stride = $stride; bytes = (New-Object byte[] ($stride * $height)) }
  for ($y = 0; $y -lt $height; $y++) {
    for ($x = 0; $x -lt $width; $x++) {
      $offset = ($y * $stride) + ($x * 4)
      $frame.bytes[$offset] = $fill
      $frame.bytes[$offset + 1] = $fill
      $frame.bytes[$offset + 2] = $fill
      $frame.bytes[$offset + 3] = 255
    }
  }
  return $frame
}
function Set-ChatDivider($frame, [int]$y, [byte]$value) {
  for ($x = 0; $x -lt $frame.width; $x++) {
    $offset = ($y * $frame.stride) + ($x * 4)
    $frame.bytes[$offset] = $value
    $frame.bytes[$offset + 1] = $value
    $frame.bytes[$offset + 2] = $value
  }
}
function Set-ChatDraftText($frame, [int]$y) {
  for ($x = 170; $x -lt 270; $x++) {
    $offset = ($y * $frame.stride) + ($x * 4)
    $frame.bytes[$offset] = 30
    $frame.bytes[$offset + 1] = 30
    $frame.bytes[$offset + 2] = 30
  }
}
$dividerFrame = New-ChatFrame 500 300 248
Set-ChatDivider $dividerFrame 220 230
Set-ChatDivider $dividerFrame 248 220
Set-ChatDraftText $dividerFrame 270
$tallComposerFrame = New-ChatFrame 500 300 248
Set-ChatDivider $tallComposerFrame 195 220
$noDividerFrame = New-ChatFrame 500 300 248
$detected = Get-VisualSendChatBottom $dividerFrame 150.0
$tallDetected = Get-VisualSendChatBottom $tallComposerFrame 150.0
$fallback = Get-VisualSendChatBottom $noDividerFrame 150.0
@{
  detected = $detected
  tallDetected = $tallDetected
  fallback = $fallback
  keepsBottomBubble = [bool](245 -le $detected)
  bottomBubbleNeedsDetection = [bool](245 -gt $fallback)
  excludesComposerDraft = [bool](249 -gt $detected)
} | ConvertTo-Json -Compress
`;
const chatProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(chatProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(chatProbe.status, 0, chatProbe.stderr || chatProbe.stdout);
const chatResult = JSON.parse(chatProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1));
assert.equal(chatResult.detected, 246);
assert.equal(chatResult.tallDetected, 193, "the final send guard must honor a manually enlarged composer");
assert.ok(Math.abs(chatResult.fallback - 180) < 0.001, "the final send guard must fail closed when the divider is unproven");
assert.equal(chatResult.keepsBottomBubble, true);
assert.equal(chatResult.bottomBubbleNeedsDetection, true);
assert.equal(chatResult.excludesComposerDraft, true);

const greenRoleStart = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Test-VisualSendGreenPixel");
const greenRoleEnd = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.indexOf("function Find-VisualSendGreenComponents", greenRoleStart);
assert.ok(greenRoleStart >= 0 && greenRoleEnd > greenRoleStart);
const greenRoleFunctions = WECHAT_VISUAL_AUTO_REPLY_POWERSHELL.slice(greenRoleStart, greenRoleEnd);
const greenRoleProgram = `
function Get-MomentsPixel($frame, [int]$x, [int]$y) {
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $frame.width -or $y -ge $frame.height) { return $null }
  $offset = ($y * $frame.stride) + ($x * 4)
  return @{ b = [int]$frame.bytes[$offset]; g = [int]$frame.bytes[$offset + 1]; r = [int]$frame.bytes[$offset + 2] }
}
function Normalize-VisualSendText([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  return [Text.RegularExpressions.Regex]::Replace($value, "\\s+", "").Trim()
}
${greenRoleFunctions}
function New-RoleFrame {
  $width = 1000; $height = 600; $stride = $width * 4
  return @{ width = $width; height = $height; stride = $stride; bytes = (New-Object byte[] ($stride * $height)) }
}
function Set-RoleGreenRect($frame, [int]$left, [int]$top, [int]$width, [int]$height) {
  for ($y = $top; $y -lt ($top + $height); $y++) {
    for ($x = $left; $x -lt ($left + $width); $x++) {
      $offset = ($y * $frame.stride) + ($x * 4)
      $frame.bytes[$offset] = 90
      $frame.bytes[$offset + 1] = 230
      $frame.bytes[$offset + 2] = 145
      $frame.bytes[$offset + 3] = 255
    }
  }
}
$sidebar = 273.0
$greenFrame = New-RoleFrame
Set-RoleGreenRect $greenFrame 335 290 620 44
$plainFrame = New-RoleFrame
$shortFrame = New-RoleFrame
Set-RoleGreenRect $shortFrame 690 488 270 48
$shortLines = @([pscustomobject]@{ text = "short"; left = 710; top = 500; width = 220; height = 22 })
$multiFrame = New-RoleFrame
Set-RoleGreenRect $multiFrame 570 435 370 86
$multiLines = @(
  [pscustomobject]@{ text = "first"; left = 600; top = 450; width = 300; height = 22 },
  [pscustomobject]@{ text = "second"; left = 600; top = 480; width = 180; height = 22 }
)
$historyFrame = New-RoleFrame
Set-RoleGreenRect $historyFrame 690 360 270 48
Set-RoleGreenRect $historyFrame 690 480 270 48
$historyDifferentLines = @(
  [pscustomobject]@{ text = "target"; left = 710; top = 372; width = 220; height = 22 },
  [pscustomobject]@{ text = "different"; left = 710; top = 492; width = 220; height = 22 }
)
$historyNonGreenFrame = New-RoleFrame
Set-RoleGreenRect $historyNonGreenFrame 690 360 270 48
$historyNonGreenLines = @(
  [pscustomobject]@{ text = "target"; left = 710; top = 372; width = 220; height = 22 },
  [pscustomobject]@{ text = "target"; left = 320; top = 500; width = 220; height = 22 }
)
@{
  longGreenOutgoing = Get-VisualSendMessageRole $greenFrame ([pscustomobject]@{ left = 350; top = 300; width = 590; height = 22 }) $sidebar 1.0
  leftIncoming = Get-VisualSendMessageRole $plainFrame ([pscustomobject]@{ left = 300; top = 300; width = 350; height = 22 }) $sidebar 1.0
  middleAmbiguous = Get-VisualSendMessageRole $plainFrame ([pscustomobject]@{ left = 520; top = 300; width = 180; height = 22 }) $sidebar 1.0
  bottomShortBubble = Test-VisualSendOutgoingLineEvidence $shortFrame $shortLines "short" $sidebar
  multilineBubble = Test-VisualSendOutgoingLineEvidence $multiFrame $multiLines "first second" $sidebar
  historicalSameLatestDifferent = Test-VisualSendOutgoingLineEvidence $historyFrame $historyDifferentLines "target" $sidebar
  historicalSameLatestNonGreen = Test-VisualSendOutgoingLineEvidence $historyNonGreenFrame $historyNonGreenLines "target" $sidebar
} | ConvertTo-Json -Compress
`;
const greenRoleProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(greenRoleProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(greenRoleProbe.status, 0, greenRoleProbe.stderr || greenRoleProbe.stdout);
assert.deepEqual(JSON.parse(greenRoleProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  bottomShortBubble: true,
  historicalSameLatestDifferent: false,
  historicalSameLatestNonGreen: false,
  leftIncoming: "user",
  longGreenOutgoing: "assistant",
  middleAmbiguous: "unknown",
  multilineBubble: true
});

const parserCommand = "[Console]::InputEncoding=[Text.Encoding]::UTF8; $source=[Console]::In.ReadToEnd(); $tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors); if($errors.Count){$errors | ForEach-Object {$_.ToString()}; exit 1}";
const syntaxProbe = spawnSync("powershell.exe", ["-NoProfile", "-Command", parserCommand], {
  input: WECHAT_VISUAL_AUTO_REPLY_POWERSHELL,
  encoding: "utf8"
});
assert.equal(syntaxProbe.status, 0, syntaxProbe.stderr || syntaxProbe.stdout);

const calls = [];
const sender = createVisualAutoReplySender({
  powerShellRunner: async (_script, env, options) => {
    calls.push({ kind: "powershell", env, options });
    if (env.XIAOXI_VISUAL_SEND_PHASE === "preflight") {
      return { ok: true, conversationVerified: true, incomingVerified: true, sendAttempted: false, pid: 77, hWnd: 88 };
    }
    return {
      ok: true,
      sendAttempted: true,
      conversationVerified: true,
      draftVerified: true,
      verificationMode: "draft_consumed_same_header",
      pid: 77,
      hWnd: 88
    };
  },
  draftInput: async (message, context) => {
    calls.push({ kind: "draft", message, context });
    return { ok: true, draftVerified: true };
  }
});

(async () => {
  let beforeSendCalled = false;
  const result = await sender({
    pid: 77,
    hWnd: 88,
    conversation: "A测试客户",
    incomingMessage: "你是谁",
    reply: "你好，这是本机视觉发送自检",
    beforeSend: async (context) => {
      beforeSendCalled = true;
      assert.equal(context.conversation, "A测试客户");
      return true;
    }
  });
  assert.deepEqual({ ...result, diagnostics: undefined }, {
    ok: true,
    send_attempted: true,
    conversationVerified: true,
    draftVerified: true,
    verificationMode: "draft_consumed_same_header",
    pid: 77,
    hWnd: 88,
    diagnostics: undefined
  });
  assert.equal(result.diagnostics.phase, "completed");
  assert.equal(Number.isFinite(result.diagnostics.timings.total_ms), true);
  assert.equal(beforeSendCalled, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].env.XIAOXI_VISUAL_SEND_PHASE, "preflight");
  assert.equal(calls[0].env.XIAOXI_VISUAL_SEND_CONVERSATION_EVIDENCE, calls[0].env.XIAOXI_VISUAL_SEND_CONVERSATION);
  assert.deepEqual(JSON.parse(calls[0].env.XIAOXI_VISUAL_SEND_ALLOWED_NAMES), [calls[0].env.XIAOXI_VISUAL_SEND_CONVERSATION]);
  assert.equal(calls[0].env.XIAOXI_VISUAL_SEND_CONVERSATION, "A测试客户");
  assert.equal(calls[0].env.XIAOXI_VISUAL_SEND_INCOMING, "你是谁");
  assert.equal(calls[0].options.sta, true);
  assert.deepEqual(calls[1], { kind: "draft", message: "你好，这是本机视觉发送自检", context: { pid: 77, hWnd: 88 } });
  assert.equal(calls[2].env.XIAOXI_VISUAL_SEND_PHASE, "send");

  const staleIncomingEnvironments = [];
  let staleIncomingDraftCalls = 0;
  const staleIncomingSignature = "a".repeat(64);
  const staleIncoming = await createVisualAutoReplySender({
    powerShellRunner: async (_script, env) => {
      staleIncomingEnvironments.push(env);
      if (env.XIAOXI_VISUAL_SEND_PHASE === "preflight") {
        return { ok: true, conversationVerified: true, sendAttempted: false, incomingVerified: false };
      }
      return { ok: true, sendAttempted: true, conversationVerified: true, draftVerified: true, verificationMode: "draft_consumed_same_header" };
    },
    draftInput: async () => {
      staleIncomingDraftCalls += 1;
      return { ok: true, draftVerified: true };
    }
  })({
    pid: 77,
    hWnd: 88,
    conversation: "A测试客户",
    incomingMessage: "扫描阶段已经严格确认的消息",
    incomingMessageSignature: staleIncomingSignature,
    incomingVerified: true,
    reply: "继续完成发送"
  });
  assert.equal(staleIncoming.ok, false, "a stale controller proof must never override the live latest-bubble observation");
  assert.equal(staleIncoming.send_attempted, false);
  assert.equal(staleIncoming.reason, "visual_send_incoming_changed");
  assert.equal(staleIncomingDraftCalls, 0, "a changed occurrence must be discarded before any draft is written");
  assert.equal(staleIncomingEnvironments.length, 1);
  assert.equal(staleIncomingEnvironments[0].XIAOXI_VISUAL_SEND_INCOMING, "扫描阶段已经严格确认的消息");
  assert.equal(staleIncomingEnvironments[0].XIAOXI_VISUAL_SEND_INCOMING_SIGNATURE, staleIncomingSignature);
  assert.equal("XIAOXI_VISUAL_SEND_INCOMING_VERIFIED" in staleIncomingEnvironments[0], false);

  let sendRunnerCalls = 0;
  const cancelled = await createVisualAutoReplySender({
    powerShellRunner: async () => {
      sendRunnerCalls += 1;
      return { ok: true, conversationVerified: true, incomingVerified: true };
    },
    draftInput: async () => ({ ok: true, draftVerified: true })
  })({ pid: 1, hWnd: 2, conversation: "A测试客户", incomingMessage: "仍是这一条", reply: "不会发送", beforeSend: () => false });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.send_attempted, false);
  assert.equal(cancelled.reason, "visual_send_cancelled");
  assert.equal(sendRunnerCalls, 1);

  let unknownCalls = 0;
  const unknown = await createVisualAutoReplySender({
    powerShellRunner: async (_script, env) => {
      unknownCalls += 1;
      return env.XIAOXI_VISUAL_SEND_PHASE === "preflight"
        ? { ok: true, sendAttempted: false, conversationVerified: true, incomingVerified: true }
        : { ok: false, reason: "powershell_timeout" };
    },
    draftInput: async () => ({ ok: true, draftVerified: true })
  })({ pid: 3, hWnd: 4, conversation: "A测试客户", incomingMessage: "仍是这一条", reply: "只尝试一次" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.send_attempted, true);
  assert.equal(unknown.outcomeUnknown, true);
  assert.equal(unknownCalls, 2);

  let rejectedSendCalls = 0;
  const rejectedSend = await createVisualAutoReplySender({
    powerShellRunner: async (_script, env) => {
      if (env.XIAOXI_VISUAL_SEND_PHASE === "preflight") {
        return { ok: true, sendAttempted: false, conversationVerified: true, incomingVerified: true };
      }
      rejectedSendCalls += 1;
      throw new Error("simulated timeout after possible click");
    },
    draftInput: async () => ({ ok: true, draftVerified: true })
  })({ pid: 33, hWnd: 44, conversation: "TestCustomer", incomingMessage: "hello", incomingVerified: true, reply: "world" });
  assert.deepEqual({ ...rejectedSend, diagnostics: undefined }, {
    ok: false,
    send_attempted: true,
    conversationVerified: true,
    draftVerified: true,
    verificationMode: "",
    pid: 33,
    hWnd: 44,
    reason: "visual_send_outcome_unknown",
    outcomeUnknown: true,
    diagnostics: undefined
  });
  assert.equal(rejectedSendCalls, 1, "a rejected final send phase must become terminal unknown, never an automatic retry");

  const visualEnvironments = [];
  const visualDraft = await createVisualAutoReplySender({
    powerShellRunner: async (_script, env) => {
      visualEnvironments.push(env);
      if (env.XIAOXI_VISUAL_SEND_PHASE === "preflight") {
        return { ok: true, sendAttempted: false, conversationVerified: true, incomingVerified: true };
      }
      if (env.XIAOXI_VISUAL_SEND_PHASE === "draft") {
        return { ok: true, sendAttempted: false, conversationVerified: true, draftVerified: true, inputTick: 322 };
      }
      return { ok: true, sendAttempted: true, conversationVerified: true, draftVerified: true, verificationMode: "draft_consumed_same_header" };
    }
  })({ pid: 5, hWnd: 6, conversation: "A测试客户", incomingMessage: "仍是这一条", reply: "视觉同 DPI 输入", expectedInputTick: 321 });
  assert.equal(visualDraft.ok, true);
  assert.deepEqual(visualEnvironments.map((env) => env.XIAOXI_VISUAL_SEND_PHASE), ["draft", "send"], "production visual send must not run duplicate full-frame preflight OCR");
  assert.equal(visualEnvironments[0].XIAOXI_VISUAL_SEND_EXPECTED_INPUT_TICK, "321", "the draft process must inherit the inspector input lease");
  assert.equal(visualEnvironments[1].XIAOXI_VISUAL_SEND_EXPECTED_INPUT_TICK, "322", "the send process must inherit the draft's final input lease");

  let mismatchDraftCalls = 0;
  const mismatch = await createVisualAutoReplySender({
    powerShellRunner: async () => ({ ok: true, sendAttempted: false, conversationVerified: true, incomingVerified: false }),
    draftInput: async () => {
      mismatchDraftCalls += 1;
      return { ok: true, draftVerified: true };
    }
  })({ pid: 7, hWnd: 8, conversation: "A测试客户", incomingMessage: "本条必须仍可见", reply: "不应输入" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "visual_send_incoming_changed");
  assert.equal(mismatchDraftCalls, 0);

  let missingOccurrenceRunnerCalls = 0;
  const missingOccurrence = await createVisualAutoReplySender({
    powerShellRunner: async () => {
      missingOccurrenceRunnerCalls += 1;
      return { ok: true };
    }
  })({ pid: 9, hWnd: 10, conversation: "A测试客户", reply: "不应执行" });
  assert.equal(missingOccurrence.ok, false);
  assert.equal(missingOccurrence.send_attempted, false);
  assert.equal(missingOccurrence.reason, "visual_send_context_invalid");
  assert.equal(missingOccurrenceRunnerCalls, 0, "auto reply requires an expected inbound occurrence before opening the send runtime");

  const invalid = await sender({ pid: 0, hWnd: 2, conversation: "", reply: "x" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.send_attempted, false);
  assert.equal(invalid.reason, "visual_send_context_invalid");

  console.log("wechat auto-reply visual send self-check passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
