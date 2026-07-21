const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { MOMENTS_VISUAL_READONLY_POWERSHELL } = require("./moments_visual_probe.dev.cjs");
const {
  AUTO_REPLY_VISUAL_SCRIPT,
  createWechatVisualAutoReplyDriver
} = require("./wechat_auto_reply_visual_driver.dev.cjs");

async function main() {
assert.equal(typeof AUTO_REPLY_VISUAL_SCRIPT, "string");
assert.ok(AUTO_REPLY_VISUAL_SCRIPT.includes(MOMENTS_VISUAL_READONLY_POWERSHELL));
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /Get-MomentsRenderPaneEvidence \$root/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /Get-AutoReplyVisualFrame \$hWnd \$windowRect \$expectedProcessId/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /Get-MomentsOcrObservation \$frame/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /function Get-AutoReplyVisualCurrentConversation/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /function Get-AutoReplyVisualLatestMessageEvidence/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /function Get-AutoReplyVisualSidebarRight/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$viewportHash = Get-MomentsPixelHash \$frame \$viewportRect/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /evidenceSignature = Get-AutoReplyVisualSha256 \$evidenceSeed/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$processes\.Count -ne 1/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /WindowFromPoint\(\$point\)/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$hitRoot = \[Win32WechatMomentsVisualReadOnly\]::GetAncestor\(\$hit, 2\)/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /GetWindowThreadProcessId\(\$hit, \[ref\]\$hitPid\)/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /GetWindowThreadProcessId\(\$hitRoot, \[ref\]\$rootPid\)/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /GetForegroundWindow\(\) -ne \$hWnd/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$candidates\.Count -eq 0/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$unreadCandidates = @\(\$candidates\.ToArray\(\) \| Where-Object \{ \$_\.unread \}\)/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$candidate = if \(\$unreadCandidates\.Count -gt 0\) \{ \$unreadCandidates\[0\] \} else \{ \$candidates\[0\] \}/u);
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /\$candidates\.Count -ne 1/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$prefixed\.Count -ne 1 -or \$exact\.Count -ne 1/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\[double\]\$latest\.bounds\.left -ge \$chatMid/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /"visual:v1:" \+ \(Get-AutoReplyVisualSha256/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /if \(\$row\.unread\)/u);
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /\$row\.unread -or \$changed/u);
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /source -NotePropertyValue .*preview_change/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$nameBounds\.left - \(Scale-AutoReplyVisualMetric 32\.0\)/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$nameBounds\.top - \(Scale-AutoReplyVisualMetric 22\.0\)/u);
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /\$nameBounds\.left - 78\.0/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$windowDpi \/ 120\.0/u, "physical visual thresholds must scale from the live-tested 120-DPI baseline");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$script:AutoReplyVisualScale \* \$script:AutoReplyVisualScale/u, "pixel-area thresholds must scale quadratically");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$row\.nameBounds\.top \+ \(\[double\]\$row\.nameBounds\.height \* 0\.5\)/u);
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /\$row\.nameBounds\.height \+ 8\.0/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /baselineAdvance = @\{ conversation = \$conversation; signature = \[string\]\$candidate\.signature \}/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /messageBaselineAdvance = @\{ conversation = \$conversation; signature = \[string\]\$latest\.evidenceSignature \}/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /source = "current_message_change"/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$expectedRows\.Count -ne 1 -and -not \$currentConversationMatches/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$messageChanged = \$previousMessageSignature -match "\^\[a-f0-9\]\{64\}\$" -and \$previousMessageSignature -cne \$currentMessageSignature/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$red -ge 205[\s\S]*\$ratio -le 1\.75 -and \$density -ge 0\.25/u);
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /SendKeys|Set-Clipboard|Get-Clipboard/iu);
assert.ok(
  AUTO_REPLY_VISUAL_SCRIPT.indexOf('if ($mode -eq "prime")') < AUTO_REPLY_VISUAL_SCRIPT.indexOf("$candidates = New-Object"),
  "prime must succeed before candidate selection, including when no allowed rows are visible"
);

const normalizationStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Normalize-AutoReplyVisualText");
const normalizationEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Get-AutoReplyVisualSha256", normalizationStart);
assert.ok(normalizationStart >= 0 && normalizationEnd > normalizationStart);
const normalizationFunction = AUTO_REPLY_VISUAL_SCRIPT.slice(normalizationStart, normalizationEnd);
assert.match(normalizationFunction, /Replace\(\$normalized, "\\s\+", ""\)/u, "OCR whitespace must use a single PowerShell regex backslash");
assert.doesNotMatch(normalizationFunction, /"\\\\s\+"/u, "a double regex backslash would preserve OCR-inserted spaces");

const sidebarStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Get-AutoReplyVisualSidebarRight");
const sidebarEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Test-AutoReplyVisualViewportOwned", sidebarStart);
assert.ok(sidebarStart >= 0 && sidebarEnd > sidebarStart);
const sidebarFunction = AUTO_REPLY_VISUAL_SCRIPT.slice(sidebarStart, sidebarEnd);
const sidebarProgram = `${sidebarFunction}
@{
  narrow100 = Get-AutoReplyVisualSidebarRight 660 96
  wide100 = Get-AutoReplyVisualSidebarRight 880 96
  wide125 = Get-AutoReplyVisualSidebarRight 1100 120
  wide150 = Get-AutoReplyVisualSidebarRight 1320 144
  oversized100 = Get-AutoReplyVisualSidebarRight 1400 96
} | ConvertTo-Json -Compress`;
const sidebarProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(sidebarProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(sidebarProbe.status, 0, sidebarProbe.stderr || sidebarProbe.stdout);
assert.deepEqual(JSON.parse(sidebarProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  narrow100: 297,
  oversized100: 300,
  wide100: 300,
  wide125: 375,
  wide150: 450
});

const unreadStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Test-AutoReplyVisualRedPixel");
const unreadEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Get-AutoReplyVisualSidebarRows", unreadStart);
assert.ok(unreadStart >= 0 && unreadEnd > unreadStart);
const unreadFunctions = AUTO_REPLY_VISUAL_SCRIPT.slice(unreadStart, unreadEnd);
const scaleStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Scale-AutoReplyVisualMetric");
const scaleEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Test-AutoReplyVisualTimeText", scaleStart);
assert.ok(scaleStart >= 0 && scaleEnd > scaleStart);
const scaleFunction = AUTO_REPLY_VISUAL_SCRIPT.slice(scaleStart, scaleEnd);
const unreadProgram = `
${scaleFunction}
${unreadFunctions}
function New-TestFrame([double]$scale) {
  $width = [int][Math]::Round(160 * $scale); $height = [int][Math]::Round(100 * $scale); $stride = $width * 4
  return @{ width = $width; height = $height; stride = $stride; bytes = (New-Object byte[] ($stride * $height)) }
}
function Set-TestRedRect($frame, [int]$left, [int]$top, [int]$width, [int]$height) {
  for ($y = $top; $y -lt ($top + $height); $y++) {
    for ($x = $left; $x -lt ($left + $width); $x++) {
      $offset = ($y * $frame.stride) + ($x * 4)
      $frame.bytes[$offset] = 20
      $frame.bytes[$offset + 1] = 20
      $frame.bytes[$offset + 2] = 235
      $frame.bytes[$offset + 3] = 255
    }
  }
}
function Test-UnreadAtScale([double]$scale) {
  $script:AutoReplyVisualScale = $scale
  $nameBounds = @{ left = 90.0 * $scale; top = 40.0 * $scale; width = 56.0 * $scale; height = 18.0 * $scale }
  $redAvatar = New-TestFrame $scale
  Set-TestRedRect $redAvatar ([int][Math]::Round(62 * $scale)) ([int][Math]::Round(40 * $scale)) ([int][Math]::Round(11 * $scale)) ([int][Math]::Round(11 * $scale))
  $realBadge = New-TestFrame $scale
  Set-TestRedRect $realBadge ([int][Math]::Round(72 * $scale)) ([int][Math]::Round(26 * $scale)) ([int][Math]::Round(11 * $scale)) ([int][Math]::Round(11 * $scale))
  return @{
    redAvatar = [bool](Test-AutoReplyVisualUnreadDot $redAvatar $nameBounds)
    realBadge = [bool](Test-AutoReplyVisualUnreadDot $realBadge $nameBounds)
  }
}
@{
  dpi96 = Test-UnreadAtScale 0.8
  dpi120 = Test-UnreadAtScale 1.0
  dpi144 = Test-UnreadAtScale 1.2
} | ConvertTo-Json -Compress
`;
const unreadProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(unreadProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(unreadProbe.status, 0, unreadProbe.stderr || unreadProbe.stdout);
assert.deepEqual(JSON.parse(unreadProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  dpi96: { realBadge: true, redAvatar: false },
  dpi120: { realBadge: true, redAvatar: false },
  dpi144: { realBadge: true, redAvatar: false }
});

const normalizationProgram = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
${normalizationFunction}
@{
  formKC = (Normalize-AutoReplyVisualText "Ａ 测 试 客 户")
  allWhitespace = (Normalize-AutoReplyVisualText "你 是` + "`t" + `谁` + "`r`n" + `")
  empty = (Normalize-AutoReplyVisualText " ` + "`t" + ` ")
} | ConvertTo-Json -Compress
`;
const normalizationProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(normalizationProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(normalizationProbe.status, 0, normalizationProbe.stderr || normalizationProbe.stdout);
const normalizationJson = normalizationProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
assert.deepEqual(JSON.parse(normalizationJson), {
  formKC: "A测试客户",
  allWhitespace: "你是谁",
  empty: ""
});

const parserCommand = "$source=[Console]::In.ReadToEnd(); $tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors); if($errors.Count){$errors | ForEach-Object {$_.ToString()}; exit 1}";
const syntaxProbe = spawnSync("powershell.exe", ["-NoProfile", "-Command", parserCommand], {
  input: AUTO_REPLY_VISUAL_SCRIPT,
  encoding: "utf8"
});
assert.equal(syntaxProbe.status, 0, syntaxProbe.stderr || syntaxProbe.stdout);

const previewSignature = createHash("sha256").update("你是谁", "utf8").digest("hex");
const initialMessageSignature = createHash("sha256").update("initial-message-view", "utf8").digest("hex");
const messageSignature = createHash("sha256").update("next-message-view", "utf8").digest("hex");
const runtimeId = `visual:v1:${"a".repeat(64)}`;
const calls = [];
const results = [
  {
    ok: true,
    source: "session_prime",
    pid: 81,
    hWnd: 91,
    sessionBaselines: [{ conversation: "A测试客户", signature: previewSignature }],
    sessionMessageBaselines: [{ conversation: "A测试客户", signature: initialMessageSignature }]
  },
  {
    ok: true,
    conversation: "A测试客户",
    message: "你是谁",
    runtimeId,
    previewSignature,
    messageSignature,
    pid: 81,
    hWnd: 91,
    source: "unread",
    latestRole: "user",
    context: [{ role: "user", content: "你是谁", key: runtimeId }]
  },
  {
    ok: true,
    conversation: "A测试客户",
    message: "你是谁",
    runtimeId,
    messageSignature,
    pid: 81,
    hWnd: 91,
    source: "verify",
    latestRole: "user",
    context: [{ role: "user", content: "你是谁", key: runtimeId }]
  },
  {
    ok: false,
    reason: "no_unread_message",
    pid: 81,
    hWnd: 91,
    sessionBaselines: []
  }
];
const driver = createWechatVisualAutoReplyDriver((script, env, options) => {
  calls.push({ script, env, options });
  return results.shift();
});

assert.deepEqual(await driver.primeWechatSession([" A 测试客户 "]), {
  ok: true,
  primed: true,
  pid: 81,
  hWnd: "91"
});
const candidate = await driver.scanWechatIncoming(["A 测试客户"]);
assert.equal(candidate.ok, true);
assert.equal(candidate.conversation, "A 测试客户");
assert.equal(candidate.message, "你是谁");
assert.match(candidate.runtimeId, /^visual:v2:[a-f0-9]{64}$/u);
assert.equal(candidate.visualEvidenceRuntimeId, runtimeId);
assert.equal(candidate.visualMode, "visual_render_v1");
assert.deepEqual(candidate.context, [{ role: "user", content: "你是谁", key: candidate.runtimeId }]);
const verified = await driver.verifyWechatIncoming(candidate);
assert.equal(verified.ok, true);
assert.equal(verified.conversation, "A 测试客户");
assert.equal(verified.runtimeId, candidate.runtimeId);
assert.equal(verified.visualEvidenceRuntimeId, runtimeId);
assert.deepEqual(verified.context, [{ role: "user", content: "你是谁", key: candidate.runtimeId }]);

assert.equal(driver.scanWechatIncoming.requeue(candidate), true);
assert.equal(driver.scanWechatIncoming.requeue(candidate), true, "retry deduplication must be idempotent");
const retried = await driver.scanWechatIncoming(["A 测试客户"]);
assert.equal(retried.runtimeId, candidate.runtimeId, "spaced contact names must remain eligible for retry");
assert.equal(retried.scanProbe.reason, "no_unread_message");

assert.equal(calls.length, 4);
assert.ok(calls.every((call) => call.script === AUTO_REPLY_VISUAL_SCRIPT));
assert.ok(calls.every((call) => call.options.ensure === false && call.options.sta === true && call.options.timeout === 30_000));
assert.deepEqual(JSON.parse(calls[0].env.XIAOXI_ALLOWED_NAMES), ["A测试客户"]);
assert.equal(calls[1].env.XIAOXI_EXPECTED_PID, "81");
assert.equal(calls[1].env.XIAOXI_EXPECTED_HWND, "91");
assert.equal(JSON.parse(calls[1].env.XIAOXI_VISUAL_BASELINES)["A测试客户"], previewSignature);
assert.equal(JSON.parse(calls[1].env.XIAOXI_VISUAL_MESSAGE_BASELINES)["A测试客户"], initialMessageSignature);
assert.equal(calls[2].env.XIAOXI_EXPECTED_CONVERSATION, "A测试客户");
assert.equal(calls[2].env.XIAOXI_EXPECTED_MESSAGE, "你是谁");
assert.equal(calls[2].env.XIAOXI_EXPECTED_RUNTIME_ID, runtimeId);
assert.equal(JSON.parse(calls[2].env.XIAOXI_VISUAL_MESSAGE_BASELINES)["A测试客户"], messageSignature);

driver.scanWechatIncoming.resetBaselines();

const autoPrimeCalls = [];
const autoPrimeDriver = createWechatVisualAutoReplyDriver((script, env) => {
  autoPrimeCalls.push(env.XIAOXI_AUTO_REPLY_MODE);
  return {
    ok: true,
    source: "session_prime",
    pid: 11,
    hWnd: 12,
    sessionBaselines: [{ conversation: "A测试客户", signature: previewSignature }]
  };
});
assert.equal((await autoPrimeDriver.scanWechatIncoming(["A测试客户"])).reason, "current_session_baselined");
assert.deepEqual(autoPrimeCalls, ["prime"]);

const emptyPrimeDriver = createWechatVisualAutoReplyDriver(() => ({
  ok: true,
  source: "session_prime",
  pid: 21,
  hWnd: 22,
  sessionBaselines: []
}));
assert.deepEqual(await emptyPrimeDriver.primeWechatSession(["A测试客户"]), {
  ok: true,
  primed: true,
  pid: 21,
  hWnd: "22"
});

let ambiguousCalls = 0;
const ambiguousDriver = createWechatVisualAutoReplyDriver(() => {
  ambiguousCalls += 1;
  throw new Error("ambiguous names must be rejected before invoking PowerShell");
});
assert.equal((await ambiguousDriver.primeWechatSession(["A B", "AB"])).reason, "whitelist_name_ambiguous");
assert.equal((await ambiguousDriver.scanWechatIncoming(["A B", "AB"])).reason, "whitelist_name_ambiguous");
assert.equal(ambiguousCalls, 0);

const repeatedResults = [
  { ok: true, source: "session_prime", pid: 31, hWnd: 32, sessionBaselines: [] },
  {
    ok: true,
    conversation: "A测试客户",
    message: "相同消息",
    runtimeId,
    previewSignature,
    messageSignature,
    pid: 31,
    hWnd: 32,
    source: "unread",
    latestRole: "user",
    context: [{ role: "user", content: "相同消息", key: runtimeId }]
  },
  {
    ok: true,
    conversation: "A测试客户",
    message: "相同消息",
    runtimeId,
    previewSignature,
    messageSignature,
    pid: 31,
    hWnd: 32,
    source: "unread",
    latestRole: "user",
    context: [{ role: "user", content: "相同消息", key: runtimeId }]
  }
];
const repeatedDriver = createWechatVisualAutoReplyDriver(() => repeatedResults.shift());
assert.equal((await repeatedDriver.primeWechatSession(["A测试客户"])).ok, true);
const repeatedFirst = await repeatedDriver.scanWechatIncoming(["A测试客户"]);
const repeatedSecond = await repeatedDriver.scanWechatIncoming(["A测试客户"]);
assert.equal(repeatedFirst.visualEvidenceRuntimeId, runtimeId);
assert.equal(repeatedSecond.visualEvidenceRuntimeId, runtimeId);
assert.notEqual(repeatedFirst.runtimeId, repeatedSecond.runtimeId, "identical repeated messages must receive unique public runtime IDs");
assert.deepEqual(repeatedFirst.context, [{ role: "user", content: "相同消息", key: repeatedFirst.runtimeId }]);
assert.deepEqual(repeatedSecond.context, [{ role: "user", content: "相同消息", key: repeatedSecond.runtimeId }]);

const samePreviewSignature = createHash("sha256").update("重复内容", "utf8").digest("hex");
const gateBeforeSignature = createHash("sha256").update("current-open-before", "utf8").digest("hex");
const gateAfterSignature = createHash("sha256").update("current-open-after", "utf8").digest("hex");
const gateCalls = [];
const gateResults = [
  {
    ok: true,
    source: "session_prime",
    pid: 35,
    hWnd: 36,
    sessionBaselines: [{ conversation: "A测试客户", signature: samePreviewSignature }],
    sessionMessageBaselines: [{ conversation: "A测试客户", signature: gateBeforeSignature }]
  },
  {
    ok: true,
    conversation: "A测试客户",
    message: "重复内容",
    runtimeId,
    previewSignature: samePreviewSignature,
    messageSignature: gateAfterSignature,
    pid: 35,
    hWnd: 36,
    source: "current_message_change",
    latestRole: "user",
    context: [{ role: "user", content: "重复内容", key: runtimeId }]
  }
];
const gateDriver = createWechatVisualAutoReplyDriver((script, env) => {
  gateCalls.push(env);
  return gateResults.shift();
});
assert.equal((await gateDriver.primeWechatSession(["A测试客户"])).ok, true);
const samePreviewCandidate = await gateDriver.scanWechatIncoming(["A测试客户"]);
assert.equal(samePreviewCandidate.ok, true);
assert.equal(samePreviewCandidate.source, "current_message_change");
assert.equal(samePreviewCandidate.message, "重复内容");
assert.equal(samePreviewCandidate.visualMode, "visual_render_v1");
assert.equal(JSON.parse(gateCalls[1].XIAOXI_VISUAL_BASELINES)["A测试客户"], samePreviewSignature);
assert.equal(JSON.parse(gateCalls[1].XIAOXI_VISUAL_MESSAGE_BASELINES)["A测试客户"], gateBeforeSignature);

const advancedSignature = createHash("sha256").update("已回复", "utf8").digest("hex");
const advancedMessageSignature = createHash("sha256").update("outgoing-message-view", "utf8").digest("hex");
const advanceCalls = [];
const advanceResults = [
  {
    ok: true,
    source: "session_prime",
    pid: 41,
    hWnd: 42,
    sessionBaselines: [{ conversation: "A测试客户", signature: previewSignature }],
    sessionMessageBaselines: [{ conversation: "A测试客户", signature: initialMessageSignature }]
  },
  {
    ok: false,
    reason: "latest_message_not_incoming",
    pid: 41,
    hWnd: 42,
    baselineAdvance: { conversation: "A测试客户", signature: advancedSignature },
    messageBaselineAdvance: { conversation: "A测试客户", signature: advancedMessageSignature }
  },
  { ok: false, reason: "no_unread_message", pid: 41, hWnd: 42, sessionBaselines: [] }
];
const advanceDriver = createWechatVisualAutoReplyDriver((script, env) => {
  advanceCalls.push(env);
  return advanceResults.shift();
});
assert.equal((await advanceDriver.primeWechatSession(["A测试客户"])).ok, true);
assert.equal((await advanceDriver.scanWechatIncoming(["A测试客户"])).reason, "latest_message_not_incoming");
assert.equal((await advanceDriver.scanWechatIncoming(["A测试客户"])).reason, "no_unread_message");
assert.equal(JSON.parse(advanceCalls[1].XIAOXI_VISUAL_BASELINES)["A测试客户"], previewSignature);
assert.equal(JSON.parse(advanceCalls[2].XIAOXI_VISUAL_BASELINES)["A测试客户"], advancedSignature);
assert.equal(JSON.parse(advanceCalls[1].XIAOXI_VISUAL_MESSAGE_BASELINES)["A测试客户"], initialMessageSignature);
assert.equal(JSON.parse(advanceCalls[2].XIAOXI_VISUAL_MESSAGE_BASELINES)["A测试客户"], advancedMessageSignature);

assert.equal((await driver.verifyWechatIncoming({ conversation: "", message: "" })).reason, "incoming_message_missing");
assert.equal((await driver.verifyWechatIncoming({ conversation: "A测试客户", message: "你是谁", runtimeId: "bad" })).reason, "incoming_identity_missing");
assert.equal((await driver.scanWechatIncoming([])).reason, "whitelist_empty");

console.log("wechat auto-reply visual driver self-check passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
