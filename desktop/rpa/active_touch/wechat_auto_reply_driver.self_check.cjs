const assert = require("node:assert/strict");
const {
  AUTO_REPLY_SCAN_SCRIPT,
  classifyAvatarSide,
  createWechatAutoReplyDriver,
  mergeContextPages
} = require("./wechat_auto_reply_driver.cjs");
const { runPowerShellAsync } = require("./wechat_window_driver.cjs");

async function main() {
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
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("SetProcessDPIAware"), true, "screenshot and UIA coordinates must share the physical DPI coordinate space");
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
assert.ok(Buffer.from(calls[0].script, "utf16le").toString("base64").length < 30000, "the PowerShell command must stay below the Windows command-line limit");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("candidateSource = \"current_open\""), true, "the foreground current conversation must support later messages without an unread badge");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("GetForegroundWindow() -ne $hWnd) { Write-Result @{ ok = $false; reason = \"no_unread_message\""), false, "a changed current conversation must be detected before requiring WeChat to be foreground");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("history_window_not_foreground"), true, "a changed conversation must still fail closed if WeChat cannot be foregrounded for visual verification");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("Find-UnreadSessionMatches $all $allowedSet"), true, "all-contact polling must traverse the visible session tree once");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("source = \"current_probe\""), true, "an unchanged foreground conversation must be deduplicated before screenshot history work");
const primeModeStart = AUTO_REPLY_SCAN_SCRIPT.indexOf("if ($mode -eq \"prime\")");
const scanModeStart = AUTO_REPLY_SCAN_SCRIPT.indexOf("if ($mode -eq \"scan\")", primeModeStart);
const primeModeSource = AUTO_REPLY_SCAN_SCRIPT.slice(primeModeStart, scanModeStart);
assert.equal(primeModeSource.includes("VerticalScrollPercent -lt 98.5"), true, "startup priming must refuse a conversation that is not at the bottom");
assert.equal(primeModeSource.includes("Test-BubbleSequence $primeBubblesBefore $primeBubblesAfter"), true, "startup priming must reject messages that change while being observed");
assert.equal(primeModeSource.includes("conversation_title_changed"), true, "startup priming must revalidate the selected conversation header");

const currentOpenResults = [
  { ok: true, source: "current_probe", conversation: "张总", runtimeId: "assistant-1", pid: 81, hWnd: 91 },
  { ok: true, source: "current_open", conversation: "张总", message: "我刚回复过", runtimeId: "assistant-1", latestRole: "assistant", pid: 81, hWnd: 91, context: [{ role: "assistant", content: "我刚回复过", key: "assistant-1" }] },
  { ok: true, source: "current_open", conversation: "张总", message: "那第二个呢", runtimeId: "user-2", latestRole: "user", pid: 81, hWnd: 91, context: [{ role: "user", content: "那第二个呢", key: "user-2" }] },
  { ok: true, source: "current_open", conversation: "张总", message: "人工抢先回复", runtimeId: "assistant-3", latestRole: "assistant", pid: 81, hWnd: 91, context: [{ role: "assistant", content: "人工抢先回复", key: "assistant-3" }] },
  { ok: true, source: "current_open", conversation: "张总", message: "还有吗", runtimeId: "user-4", latestRole: "user", pid: 81, hWnd: 91, context: [{ role: "user", content: "还有吗", key: "user-4" }] }
];
const currentOpenDriver = createWechatAutoReplyDriver(() => currentOpenResults.shift());
assert.equal(typeof currentOpenDriver.scanWechatIncoming.resetBaselines, "function");
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

assert.equal((await driver.verifyWechatIncoming({ conversation: "张总", message: "你好", runtimeId: "42.81.7", pid: 81, hWnd: 91 })).ok, true);
assert.equal(calls[1].env.XIAOXI_AUTO_REPLY_MODE, "verify");
assert.equal(calls[1].env.XIAOXI_EXPECTED_CONVERSATION, "张总");
assert.equal(calls[1].env.XIAOXI_EXPECTED_MESSAGE, "你好");
assert.equal(calls[1].env.XIAOXI_EXPECTED_RUNTIME_ID, "42.81.7");
assert.equal(calls[1].env.XIAOXI_EXPECTED_PID, "81");
assert.equal(calls[1].env.XIAOXI_EXPECTED_HWND, "91");
assert.equal((await driver.verifyWechatIncoming({ conversation: "", message: "" })).reason, "incoming_message_missing");
assert.equal((await driver.verifyWechatIncoming({ conversation: "张总", message: "你好" })).reason, "incoming_identity_missing");

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
