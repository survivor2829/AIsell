const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  AUTO_REPLY_SCAN_SCRIPT,
  classifyAvatarSide,
  createWechatAutoReplyDriver: createWechatAutoReplyDriverWithWindowLayout,
  mergeContextPages
} = require("./wechat_auto_reply_driver.cjs");
const {
  NORMALIZE_WECHAT_WINDOW_SCRIPT,
  WECHAT_STABLE_WINDOW_LAYOUT,
  focusWechatWindowAsync,
  normalizeWechatMainWindowAsync,
  runPowerShellAsync
} = require("./wechat_window_driver.cjs");

const normalizedWindow = { ok: true, normalized: true, pid: 81, hWnd: "91", x: 0, y: 0, width: 1100, height: 700 };
function createWechatAutoReplyDriver(powerShellRunner, windowNormalizer = async () => normalizedWindow) {
  return createWechatAutoReplyDriverWithWindowLayout(powerShellRunner, windowNormalizer);
}

async function main() {
const layoutCalls = [];
const layoutRunner = (script, env, options) => {
  layoutCalls.push({ script, env, options });
  return normalizedWindow;
};
const normalized = await normalizeWechatMainWindowAsync({ expectedPid: 81, expectedHWnd: "91" }, layoutRunner);
assert.equal(normalized.ok, true);
assert.equal(layoutCalls[0].script, NORMALIZE_WECHAT_WINDOW_SCRIPT);
assert.equal(layoutCalls[0].env.XIAOXI_EXPECTED_PID, "81");
assert.equal(layoutCalls[0].env.XIAOXI_EXPECTED_HWND, "91");
assert.equal(layoutCalls[0].env.XIAOXI_WECHAT_WINDOW_WIDTH, String(WECHAT_STABLE_WINDOW_LAYOUT.width));
assert.equal(layoutCalls[0].env.XIAOXI_WECHAT_WINDOW_HEIGHT, String(WECHAT_STABLE_WINDOW_LAYOUT.height));
assert.deepEqual(WECHAT_STABLE_WINDOW_LAYOUT, { width: 880, height: 560 }, "the shared layout must be expressed in logical pixels");
assert.equal(layoutCalls[0].options.ensure, true);
assert.match(NORMALIZE_WECHAT_WINDOW_SCRIPT, /SetWindowPos/);
assert.match(NORMALIZE_WECHAT_WINDOW_SCRIPT, /SetThreadDpiAwarenessContext/);
assert.doesNotMatch(NORMALIZE_WECHAT_WINDOW_SCRIPT, /SetProcessDPIAware/);
assert.match(NORMALIZE_WECHAT_WINDOW_SCRIPT, /GetDpiForWindow/);
assert.match(NORMALIZE_WECHAT_WINDOW_SCRIPT, /\$targetWidth \* \$dpiScale/);
assert.match(NORMALIZE_WECHAT_WINDOW_SCRIPT, /PrimaryScreen\.WorkingArea/);
assert.ok(NORMALIZE_WECHAT_WINDOW_SCRIPT.indexOf("$movedToTargetDisplay") < NORMALIZE_WECHAT_WINDOW_SCRIPT.indexOf("GetDpiForWindow($hWnd)"), "mixed-DPI layout must move to the target display before reading its DPI");
assert.match(NORMALIZE_WECHAT_WINDOW_SCRIPT, /wechat_window_ambiguous/);
const windowDriverSource = fs.readFileSync(path.join(__dirname, "wechat_window_driver.cjs"), "utf8");
assert.doesNotMatch(windowDriverSource, /D:\\\\微信\\\\Weixin\\\\Weixin\.exe/u, "the launcher must not embed this development machine's WeChat path");
assert.doesNotMatch(windowDriverSource, /(?:Left|Top) -gt -1000/u, "valid windows on a left-side monitor must not be rejected by coordinate magic numbers");
await focusWechatWindowAsync({ expectedPid: 81, expectedHWnd: "91" }, layoutRunner);
assert.equal(layoutCalls[1].script, NORMALIZE_WECHAT_WINDOW_SCRIPT, "active-touch focus must use the same stable window layout contract");

const executionOrder = [];
const normalizedDriver = createWechatAutoReplyDriverWithWindowLayout(
  () => {
    executionOrder.push("scan");
    return { ok: true, conversation: "张总", message: "您好", runtimeId: "normalized-1", latestRole: "user", pid: 81, hWnd: 91, context: [{ role: "user", content: "您好", key: "normalized-1" }] };
  },
  async () => {
    executionOrder.push("normalize");
    return normalizedWindow;
  }
);
assert.equal((await normalizedDriver.scanWechatIncoming(["张总"])).ok, true);
assert.deepEqual(executionOrder, ["normalize", "scan"], "auto-reply scans must normalize the WeChat window before reading it");
let blockedScanCalls = 0;
const blockedByLayout = createWechatAutoReplyDriverWithWindowLayout(
  () => { blockedScanCalls += 1; return { ok: true }; },
  async () => ({ ok: false, reason: "wechat_window_not_ready" })
);
assert.equal((await blockedByLayout.primeWechatSession(["张总"])).reason, "wechat_window_not_ready");
assert.equal(blockedScanCalls, 0, "a failed window layout must stop before the auto-reply scanner runs");

assert.equal(classifyAvatarSide({ leftAvatar: true, rightAvatar: false, textWidth: 80 }), "user", "short incoming text must use the left avatar");
assert.equal(classifyAvatarSide({ leftAvatar: true, rightAvatar: false, textWidth: 760 }), "user", "long incoming text must not become outgoing");
assert.equal(classifyAvatarSide({ leftAvatar: false, rightAvatar: true, textWidth: 80 }), "assistant", "short outgoing text must use the right avatar");
assert.equal(classifyAvatarSide({ leftAvatar: false, rightAvatar: true, textWidth: 760 }), "assistant", "long outgoing text must not become incoming");
assert.equal(classifyAvatarSide({ leftAvatar: true, rightAvatar: true }), null, "two avatars are ambiguous");
assert.equal(classifyAvatarSide({ leftAvatar: false, rightAvatar: false }), null, "a missing avatar is ambiguous");

const sameText = mergeContextPages([
  { role: "user", content: "你好", key: "same-user" },
  { role: "assistant", content: "你好", key: "same-assistant" },
  { role: "assistant", content: "还有什么可以帮您", key: "assistant-2" },
  { role: "user", content: "请介绍服务", key: "latest-user" }
]);
assert.equal(sameText.ok, true);
assert.deepEqual(sameText.context.map(({ role, content, key }) => ({ role, content, key })), [
  { role: "user", content: "你好", key: "same-user" },
  { role: "assistant", content: "你好", key: "same-assistant" },
  { role: "assistant", content: "还有什么可以帮您", key: "assistant-2" },
  { role: "user", content: "请介绍服务", key: "latest-user" }
], "same text in both directions and consecutive same-side messages must be preserved");

const fourteen = Array.from({ length: 14 }, (_, index) => ({
  role: index % 3 === 0 ? "assistant" : "user",
  content: `message-${index + 1}`,
  key: `key-${index + 1}`
}));
const twoScreens = mergeContextPages(fourteen.slice(5), fourteen.slice(0, 8));
assert.equal(twoScreens.ok, true);
assert.deepEqual(twoScreens.context.map((item) => item.key), fourteen.slice(2).map((item) => item.key), "two screens must merge in order and cap context at 12");

assert.equal(mergeContextPages(
  [{ role: "user", content: "latest", key: "repeat" }],
  [
    { role: "assistant", content: "older", key: "repeat" },
    { role: "user", content: "latest", key: "repeat" }
  ]
).reason, "history_overlap_ambiguous", "a non-unique overlap must fail closed");
assert.equal(mergeContextPages(
  [{ role: "user", content: "latest", key: "latest" }],
  [{ role: "assistant", content: "older", key: "older" }]
).reason, "history_overlap_missing", "screens without a stable overlap must fail closed");

const calls = [];
const scannedContext = [
  { role: "assistant", content: "您好", key: "message-0" },
  { role: "user", content: "你好", key: "message-1" }
];
const driver = createWechatAutoReplyDriver((script, env, options) => {
  calls.push({ script, env, options });
  return { ok: true, conversation: "张总", message: "你好", runtimeId: "message-1", context: scannedContext };
});

const scanResult = await driver.scanWechatIncoming([" 张总 ", "李经理", "张总"]);
assert.deepEqual(scanResult.conversation, "张总");
assert.deepEqual(scanResult.context, scannedContext, "scan results must preserve role-tagged context");
assert.deepEqual(JSON.parse(calls[0].env.XIAOXI_ALLOWED_NAMES), ["张总", "李经理"]);
assert.deepEqual(JSON.parse(calls[0].env.XIAOXI_SESSION_BASELINES), {});
assert.equal(calls[0].env.XIAOXI_SESSION_PRIMED, "false");
assert.equal(calls[0].env.XIAOXI_SESSION_PRIMED_AT, "0");
assert.equal(calls[0].env.XIAOXI_AUTO_REPLY_MODE, "scan");
assert.equal(calls[0].options.ensure, false);
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("$automationId.StartsWith(\"session_item_\""), true, "current WeChat session items must match by their exact automation-id prefix and allowed name");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("\\[[1-9][0-9]*条\\]"), true, "current WeChat unread count must be recognized from the session item name");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("selection.Select(); Start-Sleep -Milliseconds 400; return $true"), false, "selection hints must not bypass the click fallback");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("chat_message_list.qt_scrollarea_viewport.chat_bubble_item_view"), true, "current WeChat message bubbles must be accepted by exact automation id");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("function Get-SessionPreview"), true, "the unread session preview must prove which bubble is incoming");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("unread_preview_mismatch"), true, "preview and latest bubble mismatch must fail closed");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("wechat_window_ambiguous"), true, "multiple visible personal WeChat windows must fail closed instead of selecting a different account");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("$bubbleCandidates.Count -gt 0"), true, "exact message bubbles must take priority over legacy text nodes");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("Add-Type -AssemblyName System.Drawing"), true, "avatar-side detection must use an in-memory screenshot");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("CopyFromScreen"), true, "the screenshot must be captured in memory without a file");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("SetThreadDpiAwarenessContext"), true, "screenshot and UIA coordinates must share the per-monitor physical DPI coordinate space");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("SetProcessDPIAware"), false);
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes(".Save("), false, "chat screenshots must never be saved");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("function Measure-AvatarBand"), true, "roles must come from left and right avatar bands");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("SetScrollPercent"), true, "history may inspect at most one older viewport");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("history_avatar_ambiguous"), true, "missing or double avatars must fail closed");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("history_overlap_ambiguous"), true, "non-unique page overlap must fail closed");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("history_restore_failed"), true, "failure to restore the current viewport must fail closed");
const unconditionalBottomGate = AUTO_REPLY_SCAN_SCRIPT.indexOf("if ($beforePercent -lt 98.5)");
const shortHistoryGate = AUTO_REPLY_SCAN_SCRIPT.indexOf("if ($mode -eq \"scan\" -and $currentItems.Count -lt 12");
assert.ok(unconditionalBottomGate >= 0 && unconditionalBottomGate < shortHistoryGate, "scan mode must prove the conversation is at the bottom even when 12 or more bubbles are visible");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("latest_message_not_incoming"), true, "the newest message must be classified as incoming");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("outgoingEdge"), false, "message width must never classify direction");
assert.equal(calls[0].script.includes("GZipStream"), true, "the large fixed script must be decompressed in memory");
assert.ok(Buffer.from(calls[0].script, "utf16le").toString("base64").length < 64 * 1024, "the compressed PowerShell payload sent over stdin must stay bounded");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("candidateSource = \"current_open\""), true, "the foreground current conversation must support later messages without an unread badge");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("GetForegroundWindow() -ne $hWnd) { Write-Result @{ ok = $false; reason = \"no_unread_message\""), false, "a changed current conversation must be detected before requiring WeChat to be foreground");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("history_window_not_foreground"), true, "a changed conversation must still fail closed if WeChat cannot be foregrounded for visual verification");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("Find-EligibleSessionRows $all $allowedSet"), true, "all-contact polling must traverse the visible session tree once");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("function Get-SessionPreviewSignature"), true, "visible session previews must have content-free change signatures");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("function Test-SessionMetaElement"), true, "preview signatures must exclude right-top time and date metadata by geometry");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("function Normalize-SessionAggregatePreview"), true, "self-drawn aggregate session rows must have a strict preview-only fallback");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes('foreach ($index in $exactElementIndices)'), true, "session_item identities must be evaluated before weaker text fallbacks");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes('$aggregateChildren = $aggregateList.FindAll([System.Windows.Automation.TreeScope]::Children'), true, "aggregate compatibility must inspect only direct children of one verified conversation list");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes('if ($sessionLists.Count -eq 1)'), true, "multiple visible conversation lists must disable aggregate compatibility");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes('Test-AggregateSessionListItem $item $aggregateListRect'), true, "aggregate rows must be visible list items fully contained by the verified list");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes('$value["sessionProbe"] = $script:sessionProbeDiagnostics'), true, "unsupported session probes must return content-free diagnostic counters");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("function Test-UnreadBadgeGeometry"), true, "numeric unread hints must pass a dedicated geometry gate");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("function Test-UnreadName"), true, "unread labels in ordinary element names must use an exact status shape");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("$itemRect.Right -gt $leftLimit"), true, "a session row must stay completely inside the left conversation region");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("$sessionRows.Count -eq 0 -or $script:sessionBaselines.Count -eq 0"), false, "a verified session schema must remain healthy while no allowed contact currently has an unread aggregate row");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes('$text -match "^[1-9][0-9]{0,2}$" -or\n      $text -match'), false, "numeric preview or badge changes must participate in the signature instead of being silently discarded");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("$minimumRowWidth = [Math]::Min(240.0"), true, "ultrawide windows must not scale the minimum session-row width past the real sidebar width");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("preview_change"), true, "a changed preview must detect messages even when WeChat does not expose an unread badge");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("$firstSeen = $sessionPreviewPrimed"), true, "a conversation first surfaced after priming must be verified instead of silently becoming a baseline");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("Test-SessionSincePrime ([string]$row.displayTime) $sessionPrimedAtMs"), true, "a first-seen row must prove a post-prime timestamp instead of treating manual scrolling as a new message");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("session_probe_unsupported"), true, "an unsupported session tree must never be reported as a healthy empty scan");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("source = \"current_probe\""), true, "an unchanged foreground conversation must be deduplicated before screenshot history work");
const primeModeStart = AUTO_REPLY_SCAN_SCRIPT.indexOf("if ($mode -eq \"prime\")");
const scanModeStart = AUTO_REPLY_SCAN_SCRIPT.indexOf("if ($mode -eq \"scan\")", primeModeStart);
const primeModeSource = AUTO_REPLY_SCAN_SCRIPT.slice(primeModeStart, scanModeStart);
assert.equal(primeModeSource.includes("VerticalScrollPercent -lt 98.5"), true, "startup priming must refuse a conversation that is not at the bottom");
assert.equal(primeModeSource.includes("Test-BubbleSequence $primeBubblesBefore $primeBubblesAfter"), true, "startup priming must reject messages that change while being observed");
assert.equal(primeModeSource.includes("conversation_title_changed"), true, "startup priming must revalidate the selected conversation header");
const scanModeSource = AUTO_REPLY_SCAN_SCRIPT.slice(scanModeStart);
assert.ok(scanModeSource.indexOf('reason = "session_probe_unsupported"') < scanModeSource.indexOf("Find-CurrentEligibleConversation $all"), "full session-list compatibility must be checked before falling back to only the open conversation");

const sessionSignatureA = "a".repeat(64);
const sessionSignatureB = "b".repeat(64);
const previewBaselineCalls = [];
const previewBaselineResults = [
  { ok: true, source: "session_prime", pid: 81, hWnd: 91, sessionBaselines: [{ conversation: "张总", signature: sessionSignatureA }] },
  { ok: false, reason: "no_unread_message", sessionBaselines: [{ conversation: "张总", signature: sessionSignatureB }] },
  { ok: false, reason: "no_unread_message" }
];
const previewBaselineDriver = createWechatAutoReplyDriver((script, env) => {
  previewBaselineCalls.push(env);
  return previewBaselineResults.shift();
});
assert.equal((await previewBaselineDriver.primeWechatSession(["张总"])).primed, true, "priming visible session previews must not require an open conversation");
await previewBaselineDriver.scanWechatIncoming(["张总"]);
assert.equal(previewBaselineCalls[1].XIAOXI_SESSION_PRIMED, "true", "the PowerShell scan must distinguish a post-prime first-seen row from startup history");
assert.ok(Number(previewBaselineCalls[1].XIAOXI_SESSION_PRIMED_AT) > 0, "post-prime recency checks must receive the listener start time");
assert.equal(JSON.parse(previewBaselineCalls[1].XIAOXI_SESSION_BASELINES)["张总"], sessionSignatureA, "scan must receive the startup preview baseline");
await previewBaselineDriver.scanWechatIncoming(["张总"]);
assert.equal(JSON.parse(previewBaselineCalls[2].XIAOXI_SESSION_BASELINES)["张总"], sessionSignatureA, "an unverified changed preview must not advance its baseline");

const newlyVisibleCalls = [];
const newlyVisibleResults = [
  { ok: true, source: "session_prime", pid: 81, hWnd: 91, sessionBaselines: [{ conversation: "张总", signature: sessionSignatureA }] },
  { ok: false, reason: "no_unread_message", sessionBaselines: [{ conversation: "张总", signature: sessionSignatureA }, { conversation: "李经理", signature: sessionSignatureB }] },
  { ok: false, reason: "no_unread_message" }
];
const newlyVisibleDriver = createWechatAutoReplyDriver((script, env) => {
  newlyVisibleCalls.push(env);
  return newlyVisibleResults.shift();
});
await newlyVisibleDriver.primeWechatSession(["张总", "李经理"]);
await newlyVisibleDriver.scanWechatIncoming(["张总", "李经理"]);
await newlyVisibleDriver.scanWechatIncoming(["张总", "李经理"]);
assert.equal(Object.hasOwn(JSON.parse(newlyVisibleCalls[2].XIAOXI_SESSION_BASELINES), "李经理"), false, "a newly visible row without verified new-message evidence must not silently become a baseline");

const failedPreviewCalls = [];
const failedPreviewResults = [
  { ok: true, source: "session_prime", pid: 81, hWnd: 91, sessionBaselines: [{ conversation: "张总", signature: sessionSignatureA }] },
  { ok: false, reason: "conversation_title_mismatch", sessionBaselinePending: "张总", sessionBaselines: [{ conversation: "张总", signature: sessionSignatureB }] },
  { ok: true, source: "preview_change", conversation: "张总", message: "新问题", runtimeId: "preview-user-1", latestRole: "user", sessionBaselinePending: "张总", sessionBaselines: [{ conversation: "张总", signature: sessionSignatureB }], context: [{ role: "user", content: "新问题", key: "preview-user-1" }] },
  { ok: false, reason: "no_unread_message" }
];
const failedPreviewDriver = createWechatAutoReplyDriver((script, env) => {
  failedPreviewCalls.push(env);
  return failedPreviewResults.shift();
});
await failedPreviewDriver.primeWechatSession(["张总"]);
assert.equal((await failedPreviewDriver.scanWechatIncoming(["张总"])).reason, "conversation_title_mismatch");
await failedPreviewDriver.scanWechatIncoming(["张总"]);
assert.equal(JSON.parse(failedPreviewCalls[2].XIAOXI_SESSION_BASELINES)["张总"], sessionSignatureA, "a transient failure after opening a changed row must preserve the old signature so the message is retried");
await failedPreviewDriver.scanWechatIncoming(["张总"]);
assert.equal(JSON.parse(failedPreviewCalls[3].XIAOXI_SESSION_BASELINES)["张总"], sessionSignatureB, "a verified preview candidate may commit the new signature");

const firstSeenFailureCalls = [];
const firstSeenFailureResults = [
  { ok: true, source: "session_prime", pid: 81, hWnd: 91, sessionBaselines: [] },
  { ok: false, reason: "history_changed_during_scan", sessionBaselinePending: "张总", sessionBaselines: [{ conversation: "张总", signature: sessionSignatureB }] },
  { ok: false, reason: "no_unread_message" }
];
const firstSeenFailureDriver = createWechatAutoReplyDriver((script, env) => {
  firstSeenFailureCalls.push(env);
  return firstSeenFailureResults.shift();
});
await firstSeenFailureDriver.primeWechatSession(["张总"]);
await firstSeenFailureDriver.scanWechatIncoming(["张总"]);
await firstSeenFailureDriver.scanWechatIncoming(["张总"]);
assert.equal(JSON.parse(firstSeenFailureCalls[2].XIAOXI_SESSION_BASELINES)["张总"], "0".repeat(64), "a first-seen row that fails after opening must remain visibly changed on the next scan");

const secondContactSignatureA = "c".repeat(64);
const secondContactSignatureB = "d".repeat(64);
const simultaneousCalls = [];
const simultaneousResults = [
  { ok: true, source: "session_prime", pid: 81, hWnd: 91, sessionBaselines: [{ conversation: "张总", signature: sessionSignatureA }, { conversation: "李经理", signature: secondContactSignatureA }] },
  { ok: true, source: "preview_change", conversation: "张总", message: "问题一", runtimeId: "sim-user-1", latestRole: "user", pid: 81, hWnd: 91, sessionBaselinePending: "张总", sessionBaselines: [{ conversation: "张总", signature: sessionSignatureB }, { conversation: "李经理", signature: secondContactSignatureB }], context: [{ role: "user", content: "问题一", key: "sim-user-1" }] },
  { ok: false, reason: "no_unread_message" }
];
const simultaneousDriver = createWechatAutoReplyDriver((script, env) => {
  simultaneousCalls.push(env);
  return simultaneousResults.shift();
});
await simultaneousDriver.primeWechatSession(["张总", "李经理"]);
await simultaneousDriver.scanWechatIncoming(["张总", "李经理"]);
await simultaneousDriver.scanWechatIncoming(["张总", "李经理"]);
const simultaneousNextBaselines = JSON.parse(simultaneousCalls[2].XIAOXI_SESSION_BASELINES);
assert.equal(simultaneousNextBaselines["张总"], sessionSignatureB, "the selected verified conversation may commit its changed signature");
assert.equal(simultaneousNextBaselines["李经理"], secondContactSignatureA, "another changed conversation must retain its old signature until it is selected and verified");

const processChangeCalls = [];
const processChangeResults = [
  { ok: true, source: "session_prime", pid: 81, hWnd: 91, sessionBaselines: [{ conversation: "张总", signature: sessionSignatureA }] },
  { ok: false, reason: "wechat_process_changed", pid: 82, hWnd: 92 },
  { ok: true, source: "session_prime", pid: 82, hWnd: 92, sessionBaselines: [{ conversation: "张总", signature: sessionSignatureB }] }
];
const processChangeDriver = createWechatAutoReplyDriver((script, env) => {
  processChangeCalls.push(env);
  return processChangeResults.shift();
});
await processChangeDriver.primeWechatSession(["张总"]);
assert.equal((await processChangeDriver.scanWechatIncoming(["张总"])).reason, "wechat_process_changed");
assert.equal(processChangeCalls[1].XIAOXI_SESSION_EXPECTED_PID, "81");
assert.equal(processChangeCalls[1].XIAOXI_SESSION_EXPECTED_HWND, "91");
assert.equal((await processChangeDriver.scanWechatIncoming(["张总"])).reason, "current_session_baselined", "a changed WeChat process must re-prime instead of comparing against the old process baseline");
assert.equal(processChangeCalls[2].XIAOXI_AUTO_REPLY_MODE, "prime");
assert.deepEqual(JSON.parse(processChangeCalls[2].XIAOXI_SESSION_BASELINES), {}, "process changes must discard old preview signatures before re-priming");

const currentOpenResults = [
  { ok: true, source: "current_probe", conversation: "张总", runtimeId: "assistant-1", pid: 81, hWnd: 91 },
  { ok: true, source: "current_open", conversation: "张总", message: "我刚回复过", runtimeId: "assistant-1", latestRole: "assistant", pid: 81, hWnd: 91, context: [{ role: "assistant", content: "我刚回复过", key: "assistant-1" }] },
  { ok: true, source: "current_open", conversation: "张总", message: "那第二个呢", runtimeId: "user-2", latestRole: "user", pid: 81, hWnd: 91, context: [{ role: "user", content: "那第二个呢", key: "user-2" }] },
  { ok: true, source: "current_open", conversation: "张总", message: "人工抢先回复", runtimeId: "assistant-3", latestRole: "assistant", pid: 81, hWnd: 91, context: [{ role: "assistant", content: "人工抢先回复", key: "assistant-3" }] },
  { ok: true, source: "current_open", conversation: "张总", message: "还有吗", runtimeId: "user-4", latestRole: "user", pid: 81, hWnd: 91, context: [{ role: "user", content: "还有吗", key: "user-4" }] }
];
const currentOpenDriver = createWechatAutoReplyDriver(() => currentOpenResults.shift());
assert.equal(typeof currentOpenDriver.scanWechatIncoming.resetBaselines, "function");
assert.equal(typeof currentOpenDriver.scanWechatIncoming.noteVerifiedSend, "function");
assert.equal((await currentOpenDriver.primeWechatSession(["张总"])).primed, true, "listener start must await a current-conversation-only baseline probe");
assert.equal((await currentOpenDriver.scanWechatIncoming(["张总"])).reason, "no_unread_message");
assert.equal((await currentOpenDriver.scanWechatIncoming(["张总"])).runtimeId, "user-2", "a new incoming message in the open conversation must be returned without an unread badge");
assert.equal((await currentOpenDriver.scanWechatIncoming(["张总"])).reason, "latest_message_not_incoming", "a later human reply must advance the baseline without triggering auto reply");
assert.equal((await currentOpenDriver.scanWechatIncoming(["张总"])).runtimeId, "user-4");

const unreadThenOpen = [
  { ok: true, source: "unread", conversation: "李经理", message: "第一个问题", runtimeId: "user-1", latestRole: "user", pid: 82, hWnd: 92, context: [{ role: "user", content: "第一个问题", key: "user-1" }] },
  { ok: true, source: "current_open", conversation: "李经理", message: "快速追问", runtimeId: "user-2", latestRole: "user", pid: 82, hWnd: 92, context: [{ role: "user", content: "快速追问", key: "user-2" }] }
];
const unreadThenOpenDriver = createWechatAutoReplyDriver(() => unreadThenOpen.shift());
assert.equal((await unreadThenOpenDriver.scanWechatIncoming(["李经理"])).runtimeId, "user-1");
assert.equal((await unreadThenOpenDriver.scanWechatIncoming(["李经理"])).runtimeId, "user-2", "a rapid follow-up after an unread reply must not be swallowed as a new baseline");

let retryScanCalls = 0;
const retryCandidate = { ok: true, source: "unread", conversation: "李经理", message: "请再试一次", runtimeId: "retry-1", latestRole: "user", pid: 82, hWnd: 92, context: [{ role: "user", content: "请再试一次", key: "retry-1" }] };
const freshCandidate = { ok: true, source: "unread", conversation: "李经理", message: "新的客户消息", runtimeId: "fresh-2", latestRole: "user", pid: 82, hWnd: 92, context: [{ role: "user", content: "新的客户消息", key: "fresh-2" }] };
const retryResults = [retryCandidate, freshCandidate];
const retryDriver = createWechatAutoReplyDriver(() => { retryScanCalls += 1; return retryResults.shift() || { ok: false, reason: "no_unread_message" }; });
const firstRetryCandidate = await retryDriver.scanWechatIncoming(["李经理"]);
assert.equal(retryDriver.scanWechatIncoming.requeue(firstRetryCandidate), true);
assert.equal((await retryDriver.scanWechatIncoming(["李经理"])).runtimeId, "fresh-2", "a pending retry must not starve a newly arrived customer message");
const deferredRetry = await retryDriver.scanWechatIncoming(["李经理"]);
assert.equal(deferredRetry.runtimeId, "retry-1", "the deferred retry must run after one fresh customer message");
assert.deepEqual(deferredRetry.scanProbe, { ok: null, reason: "retry_candidate_without_probe" }, "a deferred cached retry must not pretend that a live probe ran");
assert.equal(retryScanCalls, 2, "the deferred retry should not need another PowerShell scan");

const boundaryProbeEnvironments = [];
const boundaryProbeResults = [
  {
    ok: false,
    reason: "chat_boundary_unresolved",
    sessionBaselinePending: "李经理",
    sessionBaselines: [{ conversation: "李经理", signature: "d".repeat(64) }]
  },
  { ...freshCandidate, runtimeId: "fresh-after-boundary" }
];
const boundaryFenceDriver = createWechatAutoReplyDriver((script, env) => {
  boundaryProbeEnvironments.push(env);
  return boundaryProbeResults.shift() || { ok: false, reason: "no_unread_message" };
});
assert.equal(boundaryFenceDriver.scanWechatIncoming.requeue(retryCandidate), true);
const unresolvedBoundary = await boundaryFenceDriver.scanWechatIncoming(["李经理"]);
assert.deepEqual(unresolvedBoundary, { ok: false, reason: "chat_boundary_unresolved", sessionBaselinePending: "李经理", sessionBaselines: [{ conversation: "李经理", signature: "d".repeat(64) }] });
assert.equal(unresolvedBoundary.runtimeId, undefined, "an unresolved chat boundary must not release a queued candidate toward AI/send");
const freshAfterBoundary = await boundaryFenceDriver.scanWechatIncoming(["李经理"]);
assert.equal(freshAfterBoundary.runtimeId, "fresh-after-boundary", "a fresh proven customer message must be scanned before an older retry after boundary recovery");
assert.deepEqual(JSON.parse(boundaryProbeEnvironments[1].XIAOXI_SESSION_BASELINES), {}, "an unresolved chat boundary must not advance or seed session baselines");
const retryAfterBoundary = await boundaryFenceDriver.scanWechatIncoming(["李经理"]);
assert.equal(retryAfterBoundary.runtimeId, "retry-1", "the queued retry must remain available after the boundary becomes provable");
assert.equal(boundaryProbeEnvironments.length, 2, "the preserved retry should be released only after one later fresh probe");

const roleProbeEnvironments = [];
const roleProbeResults = [
  {
    ok: false,
    reason: "latest_message_role_unresolved",
    sessionBaselinePending: "李经理",
    sessionBaselines: [{ conversation: "李经理", signature: "e".repeat(64) }]
  },
  {
    ...freshCandidate,
    runtimeId: "must-not-escape-role-probe",
    scanProbe: { ok: false, reason: "latest_message_role_unresolved" },
    sessionBaselinePending: "李经理",
    sessionBaselines: [{ conversation: "李经理", signature: "f".repeat(64) }]
  },
  { ...freshCandidate, runtimeId: "fresh-after-role-proof" }
];
const roleFenceDriver = createWechatAutoReplyDriver((script, env) => {
  roleProbeEnvironments.push(env);
  return roleProbeResults.shift() || { ok: false, reason: "no_unread_message" };
});
assert.equal(roleFenceDriver.scanWechatIncoming.requeue(retryCandidate), true);
const unresolvedDirectRole = await roleFenceDriver.scanWechatIncoming(["李经理"]);
assert.equal(unresolvedDirectRole.reason, "latest_message_role_unresolved");
assert.equal(unresolvedDirectRole.runtimeId, undefined, "a direct unresolved role must not release a queued candidate toward AI/send");
const unresolvedNestedRole = await roleFenceDriver.scanWechatIncoming(["李经理"]);
assert.deepEqual(unresolvedNestedRole, {
  ok: false,
  reason: "latest_message_role_unresolved",
  scanProbe: { ok: false, reason: "latest_message_role_unresolved" }
});
assert.equal(unresolvedNestedRole.runtimeId, undefined, "an unresolved nested role probe must not escape as a send candidate");
assert.equal((await roleFenceDriver.scanWechatIncoming(["李经理"])).runtimeId, "fresh-after-role-proof");
assert.deepEqual(JSON.parse(roleProbeEnvironments[2].XIAOXI_SESSION_BASELINES), {}, "unresolved direct and nested role evidence must not advance or seed session baselines");
assert.equal((await roleFenceDriver.scanWechatIncoming(["李经理"])).runtimeId, "retry-1", "the queued retry must survive direct and nested unresolved role evidence");
assert.equal(roleProbeEnvironments.length, 3);

let focusNormalizeCalls = 0;
let focusScanCalls = 0;
const focusFenceDriver = createWechatAutoReplyDriverWithWindowLayout(
  () => {
    focusScanCalls += 1;
    return { ...freshCandidate, runtimeId: "fresh-after-focus" };
  },
  async () => {
    focusNormalizeCalls += 1;
    return focusNormalizeCalls === 1 ? { ok: false, reason: "wechat_focus_failed" } : normalizedWindow;
  }
);
assert.equal(focusFenceDriver.scanWechatIncoming.requeue(retryCandidate), true);
const failedFocus = await focusFenceDriver.scanWechatIncoming(["李经理"]);
assert.deepEqual(failedFocus, { ok: false, reason: "wechat_focus_failed" });
assert.equal(failedFocus.runtimeId, undefined, "a focus failure must not release a queued candidate toward AI/send");
assert.equal(focusScanCalls, 0, "a focus failure must stop before the scanner can observe or advance baselines");
assert.equal((await focusFenceDriver.scanWechatIncoming(["李经理"])).runtimeId, "fresh-after-focus");
assert.equal((await focusFenceDriver.scanWechatIncoming(["李经理"])).runtimeId, "retry-1", "a retry must remain queued across a transient focus failure");
assert.equal(focusScanCalls, 1);

const pauseStartDriver = createWechatAutoReplyDriver(() => ({ ok: false, reason: "no_unread_message" }));
assert.equal(pauseStartDriver.scanWechatIncoming.requeue(retryCandidate), true);
pauseStartDriver.scanWechatIncoming.resetBaselines();
assert.equal((await pauseStartDriver.scanWechatIncoming(["李经理"])).runtimeId, "retry-1", "resetting UIA baselines on pause-start must preserve proven-unsent retries");

const failedProbeRetryDriver = createWechatAutoReplyDriver(() => ({ ok: false, reason: "powershell_timeout" }));
assert.equal(failedProbeRetryDriver.scanWechatIncoming.requeue(retryCandidate), true);
const failedProbeRetry = await failedProbeRetryDriver.scanWechatIncoming(["李经理"]);
assert.equal(failedProbeRetry.runtimeId, "retry-1");
assert.deepEqual(failedProbeRetry.scanProbe, { ok: false, reason: "powershell_timeout" }, "a cached retry must preserve the failed live-probe health instead of looking like a healthy scan");

const recoveredProbeResults = [
  { ok: false, reason: "powershell_timeout" },
  { ok: true, source: "current_probe", conversation: "李经理", runtimeId: "baseline-after-recovery", pid: 82, hWnd: 92 }
];
const recoveredProbeRetryDriver = createWechatAutoReplyDriver(() => recoveredProbeResults.shift());
assert.equal(recoveredProbeRetryDriver.scanWechatIncoming.requeue(retryCandidate), true);
const failedProbeCandidate = await recoveredProbeRetryDriver.scanWechatIncoming(["李经理"]);
assert.deepEqual(failedProbeCandidate.scanProbe, { ok: false, reason: "powershell_timeout" });
assert.equal(recoveredProbeRetryDriver.scanWechatIncoming.requeue(failedProbeCandidate), true);
const recoveredProbeCandidate = await recoveredProbeRetryDriver.scanWechatIncoming(["李经理"]);
assert.deepEqual(recoveredProbeCandidate.scanProbe, { ok: true, reason: "current_session_baselined" }, "requeue must discard stale probe metadata and attach the current live-probe result");

const boundedRetryDriver = createWechatAutoReplyDriver(() => ({ ok: false, reason: "no_unread_message" }));
for (let index = 0; index < 1_000; index += 1) {
  assert.equal(boundedRetryDriver.scanWechatIncoming.requeue({ ...retryCandidate, runtimeId: `bounded-${index}` }), true);
}
assert.equal(boundedRetryDriver.scanWechatIncoming.requeue({ ...retryCandidate, runtimeId: "bounded-overflow" }), false, "a full retry queue must fail visibly instead of dropping a customer turn silently");

assert.equal((await driver.verifyWechatIncoming({ conversation: "张总", message: "你好", runtimeId: "42.81.7", pid: 81, hWnd: 91 })).ok, true);
assert.equal(calls[1].env.XIAOXI_AUTO_REPLY_MODE, "verify");
assert.equal(calls[1].env.XIAOXI_EXPECTED_CONVERSATION, "张总");
assert.equal(calls[1].env.XIAOXI_EXPECTED_MESSAGE, "你好");
assert.equal(calls[1].env.XIAOXI_EXPECTED_RUNTIME_ID, "42.81.7");
assert.equal(calls[1].env.XIAOXI_EXPECTED_PID, "81");
assert.equal(calls[1].env.XIAOXI_EXPECTED_HWND, "91");
assert.equal((await driver.verifyWechatIncoming({ conversation: "", message: "" })).reason, "incoming_message_missing");
assert.equal((await driver.verifyWechatIncoming({ conversation: "张总", message: "你好" })).reason, "incoming_identity_missing");

const recencyFunctionStart = AUTO_REPLY_SCAN_SCRIPT.indexOf("function Test-SessionSincePrime");
const recencyFunctionEnd = AUTO_REPLY_SCAN_SCRIPT.indexOf("function Find-EligibleSessionRows", recencyFunctionStart);
assert.ok(recencyFunctionStart >= 0 && recencyFunctionEnd > recencyFunctionStart);
const currentMinute = new Date();
currentMinute.setSeconds(0, 0);
const previousMinute = new Date(currentMinute.getTime() - 60_000);
const currentMinuteText = `${String(currentMinute.getHours()).padStart(2, "0")}:${String(currentMinute.getMinutes()).padStart(2, "0")}`;
const recencyProbe = await runPowerShellAsync(`${AUTO_REPLY_SCAN_SCRIPT.slice(recencyFunctionStart, recencyFunctionEnd)}
@{
  recent = Test-SessionSincePrime "${currentMinuteText}" ${previousMinute.getTime()}
  sameMinute = Test-SessionSincePrime "${currentMinuteText}" ${currentMinute.getTime()}
  justNow = Test-SessionSincePrime "刚刚" ${currentMinute.getTime()}
  old = Test-SessionSincePrime "昨天" ${currentMinute.getTime()}
} | ConvertTo-Json -Compress`, {}, { ensure: false, timeout: 5000 });
assert.equal(recencyProbe.recent, true, "a first-seen row timestamped after the listener start minute may be verified as a new candidate");
assert.equal(recencyProbe.sameMinute, false, "minute-level timestamps must fail closed when the row could predate listener start within the same minute");
assert.equal(recencyProbe.justNow, false, "an ambiguous just-now label must not turn a manually revealed old row into a candidate");
assert.equal(recencyProbe.old, false, "an old row exposed by manual scrolling must not be treated as a new message");

const badgeFunctionStart = AUTO_REPLY_SCAN_SCRIPT.indexOf("function Test-UnreadBadgeGeometry");
const badgeFunctionEnd = AUTO_REPLY_SCAN_SCRIPT.indexOf("function Test-Unread", badgeFunctionStart + 1);
assert.ok(badgeFunctionStart >= 0 && badgeFunctionEnd > badgeFunctionStart);
const badgeGeometryProbe = await runPowerShellAsync(`${AUTO_REPLY_SCAN_SCRIPT.slice(badgeFunctionStart, badgeFunctionEnd)}
$row = [pscustomobject]@{ Left = 0; Top = 0; Width = 300; Height = 80 }
@{
  realBadge = Test-UnreadBadgeGeometry ([pscustomobject]@{ Left = 58; Top = 8; Right = 78; Bottom = 28; Width = 20; Height = 20 }) $row
  numericPreview = Test-UnreadBadgeGeometry ([pscustomobject]@{ Left = 92; Top = 44; Right = 104; Bottom = 64; Width = 12; Height = 20 }) $row
} | ConvertTo-Json -Compress`, {}, { ensure: false, timeout: 5000 });
assert.equal(badgeGeometryProbe.realBadge, true, "a compact numeric badge in the avatar's upper half must remain detectable");
assert.equal(badgeGeometryProbe.numericPreview, false, "a pure-numeric message preview in the lower half must never be treated as unread");

const unreadNameFunctionStart = AUTO_REPLY_SCAN_SCRIPT.indexOf("function Test-UnreadName");
const unreadNameFunctionEnd = AUTO_REPLY_SCAN_SCRIPT.indexOf("function Test-Unread", unreadNameFunctionStart + 1);
assert.ok(unreadNameFunctionStart >= 0 && unreadNameFunctionEnd > unreadNameFunctionStart);
const unreadNameProbe = await runPowerShellAsync(`${AUTO_REPLY_SCAN_SCRIPT.slice(unreadNameFunctionStart, unreadNameFunctionEnd)}
@{
  exactChinese = Test-UnreadName "新消息"
  exactEnglish = Test-UnreadName "new message"
  exactCount = Test-UnreadName "[3条]"
  compositeCount = Test-UnreadName "客户 [3条] 预览"
  embeddedCount = Test-UnreadName "价格[3条]套餐"
  missingOpenBracket = Test-UnreadName "3条]"
  missingCloseBracket = Test-UnreadName "[3条"
  customerSentence = Test-UnreadName "没有新消息了吗"
  englishSentence = Test-UnreadName "new message 怎么处理"
} | ConvertTo-Json -Compress`, {}, { ensure: false, timeout: 5000 });
assert.equal(unreadNameProbe.exactChinese, true);
assert.equal(unreadNameProbe.exactEnglish, true);
assert.equal(unreadNameProbe.exactCount, true);
assert.equal(unreadNameProbe.compositeCount, false, "an unread-looking marker inside an ordinary composite name must not bypass preview baselines");
assert.equal(unreadNameProbe.embeddedCount, false, "an unread-looking count embedded inside customer text must not match");
assert.equal(unreadNameProbe.missingOpenBracket, false, "an unread count missing its opening bracket must not match");
assert.equal(unreadNameProbe.missingCloseBracket, false, "an unread count missing its closing bracket must not match");
assert.equal(unreadNameProbe.customerSentence, false, "a customer sentence containing 新消息 must not be treated as unread state");
assert.equal(unreadNameProbe.englishSentence, false, "a customer sentence containing new message must not be treated as unread state");

const aggregateUnreadFunctionStart = AUTO_REPLY_SCAN_SCRIPT.indexOf("function Test-AggregateSessionUnread");
const aggregateUnreadFunctionEnd = AUTO_REPLY_SCAN_SCRIPT.indexOf("function Test-Unread", aggregateUnreadFunctionStart + 1);
assert.ok(aggregateUnreadFunctionStart >= 0 && aggregateUnreadFunctionEnd > aggregateUnreadFunctionStart);
const aggregateUnreadProbe = await runPowerShellAsync(`${AUTO_REPLY_SCAN_SCRIPT.slice(aggregateUnreadFunctionStart, aggregateUnreadFunctionEnd)}
@{
  immediateCount = Test-AggregateSessionUnread "A测试客户 [3条] 新问题 18:44" "A测试客户"
  noSpaceBeforeCount = Test-AggregateSessionUnread "A测试客户[3条] 新问题 18:44" "A测试客户"
  previewCount = Test-AggregateSessionUnread "A测试客户 请看 [3条] 方案 18:44" "A测试客户"
  wrongContact = Test-AggregateSessionUnread "B测试客户 [3条] 新问题 18:44" "A测试客户"
  zeroCount = Test-AggregateSessionUnread "A测试客户 [0条] 新问题 18:44" "A测试客户"
} | ConvertTo-Json -Compress`, {}, { ensure: false, timeout: 5000 });
assert.equal(aggregateUnreadProbe.immediateCount, true);
assert.equal(aggregateUnreadProbe.noSpaceBeforeCount, true);
assert.equal(aggregateUnreadProbe.previewCount, false, "an unread-looking count inside the customer preview must not trigger aggregate unread state");
assert.equal(aggregateUnreadProbe.wrongContact, false);
assert.equal(aggregateUnreadProbe.zeroCount, false);

const aggregateNormalizerStart = AUTO_REPLY_SCAN_SCRIPT.indexOf("function Normalize-SessionAggregatePreview");
const aggregateNormalizerEnd = AUTO_REPLY_SCAN_SCRIPT.indexOf("function Get-SessionAggregatePreview", aggregateNormalizerStart);
assert.ok(aggregateNormalizerStart >= 0 && aggregateNormalizerEnd > aggregateNormalizerStart);
const aggregatePreviewProbe = await runPowerShellAsync(`${AUTO_REPLY_SCAN_SCRIPT.slice(aggregateNormalizerStart, aggregateNormalizerEnd)}
@{
  composite = (Normalize-SessionAggregatePreview "A测试客户 [3条] 新问题 18:44" "A测试客户") -ceq "新问题"
  countAndTimeOnly = [string]::IsNullOrEmpty((Normalize-SessionAggregatePreview "A测试客户 [3条] 18:44" "A测试客户"))
  exactName = [string]::IsNullOrEmpty((Normalize-SessionAggregatePreview "A测试客户" "A测试客户"))
  customerSentence = (Normalize-SessionAggregatePreview "A测试客户 没有新消息了吗 18:44" "A测试客户") -ceq "没有新消息了吗"
  wrongPrefix = [string]::IsNullOrEmpty((Normalize-SessionAggregatePreview "18:44 A测试客户 新问题" "A测试客户"))
  timeBeforePreview = [string]::IsNullOrEmpty((Normalize-SessionAggregatePreview "A测试客户 18:44 新问题" "A测试客户"))
} | ConvertTo-Json -Compress`, {}, { ensure: false, timeout: 5000 });
assert.equal(aggregatePreviewProbe.composite, true);
assert.equal(aggregatePreviewProbe.countAndTimeOnly, true);
assert.equal(aggregatePreviewProbe.exactName, true);
assert.equal(aggregatePreviewProbe.customerSentence, true, "ordinary customer text containing 新消息 must remain part of the preview signature");
assert.equal(aggregatePreviewProbe.wrongPrefix, true, "aggregate fallback must prove the exact contact-name prefix");
assert.equal(aggregatePreviewProbe.timeBeforePreview, true, "unexpected metadata ordering must fail closed instead of changing a stale signature");

const aggregateNameResolverStart = AUTO_REPLY_SCAN_SCRIPT.indexOf("function Resolve-UniqueAggregateSessionName");
const aggregateNameResolverEnd = AUTO_REPLY_SCAN_SCRIPT.indexOf("function Test-AggregateSessionListItem", aggregateNameResolverStart);
assert.ok(aggregateNameResolverStart >= 0 && aggregateNameResolverEnd > aggregateNameResolverStart);
const aggregateNameProbe = await runPowerShellAsync(`${AUTO_REPLY_SCAN_SCRIPT.slice(aggregateNameResolverStart, aggregateNameResolverEnd)}
$uniqueNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
[void]$uniqueNames.Add("A测试客户")
$ambiguousNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
[void]$ambiguousNames.Add("A")
[void]$ambiguousNames.Add("A 测试客户")
@{
  unique = (Resolve-UniqueAggregateSessionName "A测试客户 [3条] 新问题 18:44" $uniqueNames) -ceq "A测试客户"
  ambiguous = [string]::IsNullOrEmpty((Resolve-UniqueAggregateSessionName "A 测试客户 [3条] 新问题 18:44" $ambiguousNames))
  embedded = [string]::IsNullOrEmpty((Resolve-UniqueAggregateSessionName "18:44 A测试客户 新问题" $uniqueNames))
} | ConvertTo-Json -Compress`, {}, { ensure: false, timeout: 5000 });
assert.equal(aggregateNameProbe.unique, true);
assert.equal(aggregateNameProbe.ambiguous, true, "overlapping allowed-name prefixes must fail closed");
assert.equal(aggregateNameProbe.embedded, true, "an allowed name outside the exact prefix position must not be accepted");

const visualRuntimeId = `visual:v1:${"a".repeat(64)}`;
const visualPreviewSignature = "b".repeat(64);
const visualMessageSignature = "c".repeat(64);
const visualFallbackResults = [
  {
    ok: false,
    reason: "session_probe_unsupported",
    pid: 81,
    hWnd: 91,
    sessionProbe: { schemaObserved: false, elementCount: 2 }
  },
  {
    ok: true,
    source: "session_prime",
    pid: 81,
    hWnd: 91,
    sessionBaselines: [{ conversation: "A测试客户", signature: visualPreviewSignature }]
  },
  {
    ok: true,
    conversation: "A测试客户",
    message: "你是谁",
    runtimeId: visualRuntimeId,
    previewSignature: visualPreviewSignature,
    messageSignature: visualMessageSignature,
    pid: 81,
    hWnd: 91,
    source: "preview_change",
    latestRole: "user",
    context: [{ role: "user", content: "你是谁", key: visualRuntimeId }]
  },
  {
    ok: true,
    conversation: "A测试客户",
    message: "你是谁",
    runtimeId: visualRuntimeId,
    pid: 81,
    hWnd: 91,
    source: "verify",
    latestRole: "user",
    context: [{ role: "user", content: "你是谁", key: visualRuntimeId }]
  }
];
const visualFallbackDriver = createWechatAutoReplyDriver(() => visualFallbackResults.shift());
assert.equal((await visualFallbackDriver.primeWechatSession(["A测试客户"])).ok, true, "an unsupported rendered WeChat tree must transparently prime the visual driver");
const visualFallbackCandidate = await visualFallbackDriver.scanWechatIncoming(["A测试客户"]);
assert.equal(visualFallbackCandidate.visualMode, "visual_render_v1");
assert.match(visualFallbackCandidate.runtimeId, /^visual:v2:[a-f0-9]{64}$/);
assert.equal(visualFallbackCandidate.visualEvidenceRuntimeId, visualRuntimeId);
const verifiedVisualFallback = await visualFallbackDriver.verifyWechatIncoming({ ...visualFallbackCandidate, visualMode: "" });
assert.equal(verifiedVisualFallback.ok, true);
assert.equal(verifiedVisualFallback.runtimeId, visualFallbackCandidate.runtimeId, "visual verification must preserve the public event identity");
assert.equal(visualFallbackDriver.scanWechatIncoming.requeue({ ...visualFallbackCandidate, visualMode: "" }), true, "visual v2 candidates must keep the visual retry queue even after serialization drops the mode field");
visualFallbackDriver.scanWechatIncoming.resetBaselines();

const visualFencePreview0 = "1".repeat(64);
const visualFencePreview1 = "2".repeat(64);
const visualFencePreview2 = "3".repeat(64);
const visualFenceMessage0 = "4".repeat(64);
const visualFenceMessage1 = "5".repeat(64);
const visualFenceMessage2 = "6".repeat(64);
const visualFenceResults = [
  { ok: false, reason: "session_probe_unsupported", pid: 81, hWnd: 91 },
  {
    ok: true,
    source: "session_prime",
    pid: 81,
    hWnd: 91,
    sessionBaselines: [{ conversation: "Visual客户", signature: visualFencePreview0 }],
    sessionMessageBaselines: [{ conversation: "Visual客户", signature: visualFenceMessage0 }]
  },
  {
    ok: true,
    conversation: "Visual客户",
    message: "旧重试",
    runtimeId: `visual:v1:${"7".repeat(64)}`,
    previewSignature: visualFencePreview1,
    messageSignature: visualFenceMessage1,
    pid: 81,
    hWnd: 91,
    source: "preview_change",
    latestRole: "user",
    context: [{ role: "user", content: "旧重试", key: `visual:v1:${"7".repeat(64)}` }]
  },
  { ok: false, reason: "wechat_focus_failed", pid: 81, hWnd: 91 },
  {
    ok: true,
    conversation: "Visual客户",
    message: "恢复后的新消息",
    runtimeId: `visual:v1:${"8".repeat(64)}`,
    previewSignature: visualFencePreview2,
    messageSignature: visualFenceMessage2,
    pid: 81,
    hWnd: 91,
    source: "preview_change",
    latestRole: "user",
    context: [{ role: "user", content: "恢复后的新消息", key: `visual:v1:${"8".repeat(64)}` }]
  },
  { ok: false, reason: "no_unread_message", pid: 81, hWnd: 91 }
];
const visualFenceDriver = createWechatAutoReplyDriver(() => visualFenceResults.shift());
assert.equal((await visualFenceDriver.primeWechatSession(["Visual客户"])).ok, true);
const visualRetryCandidate = await visualFenceDriver.scanWechatIncoming(["Visual客户"]);
assert.equal(visualFenceDriver.scanWechatIncoming.requeue(visualRetryCandidate), true);
const visualFocusFence = await visualFenceDriver.scanWechatIncoming(["Visual客户"]);
assert.equal(visualFocusFence.reason, "wechat_focus_failed");
assert.equal(visualFocusFence.ok, false);
assert.equal(visualFocusFence.runtimeId, undefined, "a visual focus failure must not escape as a queued send candidate");
const visualFreshAfterFocus = await visualFenceDriver.scanWechatIncoming(["Visual客户"]);
assert.equal(visualFreshAfterFocus.message, "恢复后的新消息");
const visualRetryAfterFocus = await visualFenceDriver.scanWechatIncoming(["Visual客户"]);
assert.equal(visualRetryAfterFocus.runtimeId, visualRetryCandidate.runtimeId, "the top-level visual fence must preserve a retry that an inner scanner attached to a failed focus probe");

let eventLoopAdvanced = false;
setTimeout(() => { eventLoopAdvanced = true; }, 0);
const asynchronousProbe = await runPowerShellAsync("Start-Sleep -Milliseconds 150; @{ ok = $true } | ConvertTo-Json -Compress", {}, { ensure: false, timeout: 5000 });
assert.equal(asynchronousProbe.ok, true);
assert.equal(eventLoopAdvanced, true, "auto-reply PowerShell scans must not block Electron's event loop");

console.log("wechat auto-reply driver self-check passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
