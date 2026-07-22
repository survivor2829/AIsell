const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  WECHAT_VISUAL_AUTO_REPLY_POWERSHELL,
  createVisualAutoReplySender
} = require("./wechat_auto_reply_visual_send.dev.cjs");

assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /GetWindowThreadProcessId[\s\S]*MainWindowHandle[\s\S]*-cne "微信"/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /Get-MomentsRenderPaneEvidence/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /Test-VisualSendConversation[\s\S]*Normalize-VisualSendText/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Test-VisualSendIncoming[\s\S]*height = \[double\]\(\$frame\.height \* 0\.69\)/u, "incoming verification must include messages immediately above the composer");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Test-VisualSendLatestIncoming[\s\S]*Get-MomentsOcrObservation \$frame @\{ left = 0\.0; top = 0\.0; width = \[double\]\$frame\.width; height = \[double\]\$frame\.height \}/u, "the final incoming guard must reuse full-frame OCR geometry");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Get-VisualSendIncomingEvidenceSignature[\s\S]*\$dpi \/ 120\.0[\s\S]*Get-VisualSendSha256/u, "the final guard must reproduce the scanner's stable bubble identity");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /\$expectedIncomingSignature -match "\^\[a-f0-9\]\{64\}\$"[\s\S]*Get-VisualSendIncomingEvidenceSignature/u, "a bound bubble signature must take precedence over cross-region OCR text equality");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Test-VisualSendSelectedSidebarPreview[\s\S]*Test-VisualSendSidebarNameLine[\s\S]*Normalize-VisualSendText/u, "OCR drift fallback must bind the exact selected sidebar row");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /Get-VisualSendIncomingEvidenceSignature[\s\S]*Test-VisualSendSelectedSidebarPreview/u, "the selected-row fallback may run only after exact bubble evidence fails");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Get-VisualSendMessageRole/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /\$greenRatio -ge 0\.16/u, "the final guard must reject our long green bubbles before using geometry");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /GetDpiForWindow/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Get-VisualSendSidebarRight/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Get-VisualSendChatBottom/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /return \[double\]\$frame\.height \* 0\.60/u, "unknown composer geometry must fail closed above a potentially enlarged composer");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /\$top -gt \$chatBottom/u, "draft text below the proven divider must be excluded");
assert.doesNotMatch(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /frame\.width \* 0\.273|frame\.height \* 0\.88/u, "final geometry must not use one-machine fixed ratios");
assert.doesNotMatch(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /\$chatMid/u, "the final guard must not infer sender from one midpoint comparison");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /\$guard = Get-VisualSendFrame[\s\S]*Test-VisualSendLatestIncoming \$guard[\s\S]*visual_send_incoming_changed[\s\S]*\$sendAttempted = \$true/u, "the latest incoming line must be rechecked immediately before the click");
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
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /\$sendAttempted = \$true[\s\S]*mouse_event\(0x0002[\s\S]*mouse_event\(0x0004/u);
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
  user = Get-VisualSendIncomingEvidenceSignature $line "user" 120.0
  assistant = Get-VisualSendIncomingEvidenceSignature $line "assistant" 120.0
} | ConvertTo-Json -Compress
`;
const evidenceProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(evidenceProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(evidenceProbe.status, 0, evidenceProbe.stderr || evidenceProbe.stdout);
const evidenceResult = JSON.parse(evidenceProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1));
assert.equal(evidenceResult.user, createHash("sha256").update("bubble-ocr\nuser\nw:10\nh:4", "utf8").digest("hex"));
assert.notEqual(evidenceResult.assistant, evidenceResult.user, "an outgoing role must never satisfy the bound incoming evidence");

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
  assert.deepEqual(result, {
    ok: true,
    send_attempted: true,
    conversationVerified: true,
    draftVerified: true,
    verificationMode: "draft_consumed_same_header",
    pid: 77,
    hWnd: 88
  });
  assert.equal(beforeSendCalled, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].env.XIAOXI_VISUAL_SEND_PHASE, "preflight");
  assert.equal(calls[0].env.XIAOXI_VISUAL_SEND_CONVERSATION, "A测试客户");
  assert.equal(calls[0].env.XIAOXI_VISUAL_SEND_INCOMING, "你是谁");
  assert.equal(calls[0].options.sta, true);
  assert.deepEqual(calls[1], { kind: "draft", message: "你好，这是本机视觉发送自检", context: { pid: 77, hWnd: 88 } });
  assert.equal(calls[2].env.XIAOXI_VISUAL_SEND_PHASE, "send");

  const trustedIncomingEnvironments = [];
  const trustedIncomingSignature = "a".repeat(64);
  const trustedIncoming = await createVisualAutoReplySender({
    powerShellRunner: async (_script, env) => {
      trustedIncomingEnvironments.push(env);
      if (env.XIAOXI_VISUAL_SEND_PHASE === "preflight") {
        return { ok: true, conversationVerified: true, sendAttempted: false, incomingVerified: false };
      }
      return { ok: true, sendAttempted: true, conversationVerified: true, draftVerified: true, verificationMode: "draft_consumed_same_header" };
    },
    draftInput: async () => ({ ok: true, draftVerified: true })
  })({
    pid: 77,
    hWnd: 88,
    conversation: "A测试客户",
    incomingMessage: "扫描阶段已经严格确认的消息",
    incomingMessageSignature: trustedIncomingSignature,
    incomingVerified: true,
    reply: "继续完成发送"
  });
  assert.equal(trustedIncoming.ok, true, "a strict controller verification must not be contradicted by a second whole-pane OCR crop");
  assert.equal(trustedIncomingEnvironments[0].XIAOXI_VISUAL_SEND_INCOMING, "扫描阶段已经严格确认的消息");
  assert.equal(trustedIncomingEnvironments[0].XIAOXI_VISUAL_SEND_INCOMING_VERIFIED, "true");
  assert.equal(trustedIncomingEnvironments[0].XIAOXI_VISUAL_SEND_INCOMING_SIGNATURE, trustedIncomingSignature);
  assert.equal(trustedIncomingEnvironments.at(-1).XIAOXI_VISUAL_SEND_INCOMING, "扫描阶段已经严格确认的消息", "the send phase must retain the expected incoming text for its final guard");
  assert.equal(trustedIncomingEnvironments.at(-1).XIAOXI_VISUAL_SEND_INCOMING_SIGNATURE, trustedIncomingSignature, "the send phase must retain the bound bubble evidence for its final guard");

  let sendRunnerCalls = 0;
  const cancelled = await createVisualAutoReplySender({
    powerShellRunner: async () => {
      sendRunnerCalls += 1;
      return { ok: true, conversationVerified: true };
    },
    draftInput: async () => ({ ok: true, draftVerified: true })
  })({ pid: 1, hWnd: 2, conversation: "A测试客户", reply: "不会发送", beforeSend: () => false });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.send_attempted, false);
  assert.equal(cancelled.reason, "visual_send_cancelled");
  assert.equal(sendRunnerCalls, 1);

  let unknownCalls = 0;
  const unknown = await createVisualAutoReplySender({
    powerShellRunner: async (_script, env) => {
      unknownCalls += 1;
      return env.XIAOXI_VISUAL_SEND_PHASE === "preflight"
        ? { ok: true, sendAttempted: false, conversationVerified: true }
        : { ok: false, reason: "powershell_timeout" };
    },
    draftInput: async () => ({ ok: true, draftVerified: true })
  })({ pid: 3, hWnd: 4, conversation: "A测试客户", reply: "只尝试一次" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.send_attempted, true);
  assert.equal(unknown.outcomeUnknown, true);
  assert.equal(unknownCalls, 2);

  let rejectedSendCalls = 0;
  const rejectedSend = await createVisualAutoReplySender({
    powerShellRunner: async (_script, env) => {
      if (env.XIAOXI_VISUAL_SEND_PHASE === "preflight") {
        return { ok: true, sendAttempted: false, conversationVerified: true };
      }
      rejectedSendCalls += 1;
      throw new Error("simulated timeout after possible click");
    },
    draftInput: async () => ({ ok: true, draftVerified: true })
  })({ pid: 33, hWnd: 44, conversation: "TestCustomer", incomingMessage: "hello", incomingVerified: true, reply: "world" });
  assert.deepEqual(rejectedSend, {
    ok: false,
    send_attempted: true,
    conversationVerified: true,
    draftVerified: true,
    verificationMode: "",
    pid: 33,
    hWnd: 44,
    reason: "visual_send_outcome_unknown",
    outcomeUnknown: true
  });
  assert.equal(rejectedSendCalls, 1, "a rejected final send phase must become terminal unknown, never an automatic retry");

  const visualPhases = [];
  const visualDraft = await createVisualAutoReplySender({
    powerShellRunner: async (_script, env) => {
      visualPhases.push(env.XIAOXI_VISUAL_SEND_PHASE);
      if (env.XIAOXI_VISUAL_SEND_PHASE === "preflight") {
        return { ok: true, sendAttempted: false, conversationVerified: true };
      }
      if (env.XIAOXI_VISUAL_SEND_PHASE === "draft") {
        return { ok: true, sendAttempted: false, conversationVerified: true, draftVerified: true };
      }
      return { ok: true, sendAttempted: true, conversationVerified: true, draftVerified: true, verificationMode: "draft_consumed_same_header" };
    }
  })({ pid: 5, hWnd: 6, conversation: "A测试客户", reply: "视觉同 DPI 输入" });
  assert.equal(visualDraft.ok, true);
  assert.deepEqual(visualPhases, ["preflight", "draft", "send"]);

  let mismatchDraftCalls = 0;
  const mismatch = await createVisualAutoReplySender({
    powerShellRunner: async () => ({ ok: true, sendAttempted: false, conversationVerified: true, incomingVerified: false }),
    draftInput: async () => {
      mismatchDraftCalls += 1;
      return { ok: true, draftVerified: true };
    }
  })({ pid: 7, hWnd: 8, conversation: "A测试客户", incomingMessage: "本条必须仍可见", reply: "不应输入" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "visual_send_incoming_not_verified");
  assert.equal(mismatchDraftCalls, 0);

  const invalid = await sender({ pid: 0, hWnd: 2, conversation: "", reply: "x" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.send_attempted, false);
  assert.equal(invalid.reason, "visual_send_context_invalid");

  console.log("wechat auto-reply visual send self-check passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
