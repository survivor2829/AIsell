const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  AUTO_REPLY_SCAN_SCRIPT,
  classifyAvatarSide,
  createWechatAutoReplyDriver: createWechatAutoReplyDriverWithWindowLayout,
  mergeContextPages
} = require("./wechat_auto_reply_driver.cjs");
const { AUTO_REPLY_VISUAL_SCRIPT } = require("./wechat_auto_reply_visual_driver.dev.cjs");
const {
  NORMALIZE_WECHAT_WINDOW_SCRIPT,
  WECHAT_RPA_BACKGROUND_MIN_IDLE_MS,
  WECHAT_RPA_WINDOW_LAYOUT_MODE,
  focusWechatWindowAsync,
  normalizeWechatMainWindowAsync,
  prepareWechatRpaWindowAsync,
  runPowerShellAsync
} = require("./wechat_window_driver.cjs");

const normalizedWindow = {
  ok: true,
  normalized: true,
  layoutMode: "stable_target",
  focused: true,
  pid: 81,
  hWnd: "91",
  x: 0,
  y: 0,
  width: 1100,
  height: 700,
  dpi: 120
};
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
assert.equal(layoutCalls[0].env.XIAOXI_WECHAT_WINDOW_WIDTH, undefined);
assert.equal(layoutCalls[0].env.XIAOXI_WECHAT_WINDOW_HEIGHT, undefined);
assert.equal(layoutCalls[0].env.XIAOXI_WECHAT_MIN_IDLE_MS, "0", "legacy normalization stays best-effort unless a caller opts into an idle gate");
assert.equal(WECHAT_RPA_WINDOW_LAYOUT_MODE, "stable_target");
assert.equal(WECHAT_RPA_BACKGROUND_MIN_IDLE_MS, 15_000);
assert.equal(layoutCalls[0].options.ensure, false, "the canonical normalizer must not run a second legacy window detector first");
assert.match(NORMALIZE_WECHAT_WINDOW_SCRIPT, /SetWindowPos\(\$hWnd, \[IntPtr\]::Zero, \$workArea\.Left, \$workArea\.Top, \$width, \$height, 0x0014\)/);
assert.match(NORMALIZE_WECHAT_WINDOW_SCRIPT, /IsZoomed/);
assert.doesNotMatch(NORMALIZE_WECHAT_WINDOW_SCRIPT, /ShowWindowAsync\(\$hWnd, 3\)/, "the shared chat layout must not maximize WeChat");
assert.match(NORMALIZE_WECHAT_WINDOW_SCRIPT, /\$targetWidth = 1120[\s\S]*\$targetHeight = 760/u);
assert.match(NORMALIZE_WECHAT_WINDOW_SCRIPT, /\[System\.Windows\.Forms\.Screen\]::FromHandle\(\$hWnd\)\.WorkingArea/);
assert.match(NORMALIZE_WECHAT_WINDOW_SCRIPT, /SetThreadDpiAwarenessContext/);
assert.doesNotMatch(NORMALIZE_WECHAT_WINDOW_SCRIPT, /SetProcessDPIAware/);
assert.match(NORMALIZE_WECHAT_WINDOW_SCRIPT, /GetDpiForWindow/);
assert.doesNotMatch(NORMALIZE_WECHAT_WINDOW_SCRIPT, /PrimaryScreen\.WorkingArea/);
assert.match(NORMALIZE_WECHAT_WINDOW_SCRIPT, /wechat_window_ambiguous/);
assert.match(
  NORMALIZE_WECHAT_WINDOW_SCRIPT,
  /\$expectedHandleWasProvided -and -not \$expectedHandleIsValid[\s\S]*wechat_window_identity_mismatch/u,
  "an invalid exact HWND must fail before enumerating or arranging a different WeChat window"
);
assert.match(
  NORMALIZE_WECHAT_WINDOW_SCRIPT,
  /\$hiddenMainRecoveryEligible = -not \$visible[\s\S]*\$hasMainRenderChild[\s\S]*QWindowIcon[\s\S]*0x00040000[\s\S]*0x00000080/u,
  "a tray-hidden WeChat main window must retain geometry, class, owner and Win32 style evidence"
);
assert.match(
  NORMALIZE_WECHAT_WINDOW_SCRIPT,
  /if \(-not \$exactExpectedHandle -and -not \$visible -and -not \$hiddenMainRecoveryEligible\) \{ return \$null \}/u,
  "enumeration must retain only strongly evidenced hidden main windows instead of rejecting all hidden HWNDs"
);
assert.match(
  NORMALIZE_WECHAT_WINDOW_SCRIPT,
  /function Select-WechatMainCandidates\(\[object\[\]\]\$candidates\)[\s\S]*Test-WechatMainCandidate \$candidate[\s\S]*Test-WechatShellNavigation \$candidate[\s\S]*Where-Object \{ Test-WechatMainCandidate \$_ \}/u,
  "main-shell evidence must exclude visible auxiliary WeChat windows without requiring one render class"
);
assert.match(
  NORMALIZE_WECHAT_WINDOW_SCRIPT,
  /function Get-WechatWindowRecoveryCandidate\(\[object\[\]\]\$candidates\)[\s\S]*Qt\(\?:\\d\+\)\?QWindowIcon[\s\S]*window_recovery_candidate_count[\s\S]*@\(\$candidates\)\.Count -ne 1[\s\S]*\$recoverable\.Count -ne 1[\s\S]*if \(-not \$inspectOnly -and \$matches\.Count -eq 0\)[\s\S]*Test-XiaoxiUserIdle[\s\S]*window_recovery_attempted = \$true[\s\S]*Request-PersonalWechatActivation \$recoveryCandidate[\s\S]*Get-WechatWindowCandidates/u,
  "a non-inspection path may only trigger one executable restore after idle validation and unique-candidate proof"
);
assert.match(
  NORMALIZE_WECHAT_WINDOW_SCRIPT,
  /Request-PersonalWechatActivation \$recoveryCandidate[\s\S]*Get-WechatWindowCandidates[\s\S]*Where-Object \{ \[int\]\$_\.pid -eq \[int\]\$recoveryCandidate\.pid \}[\s\S]*Select-WechatMainCandidates \$recoveredSamePidCandidates[\s\S]*\$recoveredMatches\.Count -eq 1/u,
  "post-activation discovery must accept one strict main window from the same WeChat PID only"
);
assert.match(
  NORMALIZE_WECHAT_WINDOW_SCRIPT,
  /\$windowDiagnostic\.window_main_count = \$matches\.Count[\s\S]*if \(\$matches\.Count -eq 0\)[\s\S]*personal_wechat_main_window_not_found/u,
  "automatic discovery must still fail closed when recovery cannot prove a main window"
);
assert.match(
  NORMALIZE_WECHAT_WINDOW_SCRIPT,
  /if \(\$matches\.Count -gt 1\)[\s\S]*reason = "wechat_window_ambiguous"/u,
  "multiple structurally valid personal WeChat main windows must fail closed instead of being selected by area"
);
assert.match(
  NORMALIZE_WECHAT_WINDOW_SCRIPT,
  /function Test-MatchedWechatWindowIdentity[\s\S]*if \(-not \(Test-MatchedWechatWindowIdentity \$hWnd \$matched\)\)[\s\S]*\$wasIconic = \[Win32WechatWindow\]::IsIconic\(\$hWnd\)[\s\S]*if \(\$wasIconic\) \{[\s\S]*ShowWindowAsync\(\$hWnd, 9\)[\s\S]*elseif \(-not \$nativeActivationRequested\) \{[\s\S]*if \(-not \(Request-PersonalWechatActivation \$matched\)\)[\s\S]*\$nativeActivationRequested = \$true[\s\S]*for \(\$restoreAttempt = 0; \$restoreAttempt -lt 20; \$restoreAttempt\+\+\)[\s\S]*\$restoredIdentity = Test-MatchedWechatWindowIdentity \$hWnd \$matched/u,
  "tray recovery must re-prove exact identity while waiting for an already-requested native restore instead of duplicating it"
);
assert.match(
  NORMALIZE_WECHAT_WINDOW_SCRIPT,
  /processPath = \[string\]\$proc\.Path/u,
  "the exact matched WeChat executable must be retained for native activation"
);
assert.match(
  NORMALIZE_WECHAT_WINDOW_SCRIPT,
  /function Request-PersonalWechatActivation\(\[object\]\$window\)[\s\S]*Test-Path -LiteralPath \$path -PathType Leaf[\s\S]*Start-Process -FilePath \$path -ArgumentList "--scene=startmenu"/u,
  "a tray-hidden Qt main window must be restored through WeChat's installed start-menu activation contract"
);
const nativeActivationStart = NORMALIZE_WECHAT_WINDOW_SCRIPT.indexOf("function Request-PersonalWechatActivation");
const nativeActivationEnd = NORMALIZE_WECHAT_WINDOW_SCRIPT.indexOf("function Request-ExactWechatForeground", nativeActivationStart);
const nativeActivationSource = NORMALIZE_WECHAT_WINDOW_SCRIPT.slice(nativeActivationStart, nativeActivationEnd);
assert.doesNotMatch(
  nativeActivationSource,
  /XIAOXI_WECHAT_EXE/u,
  "native activation must never fall back from the matched process path to another installed WeChat"
);
assert.match(
  NORMALIZE_WECHAT_WINDOW_SCRIPT,
  /function Request-ExactWechatForeground\(\[IntPtr\]\$hWnd, \[object\]\$window, \[bool\]\$nativeActivationAlreadyRequested\)[\s\S]*if \(-not \$nativeActivationAlreadyRequested -and \(Request-PersonalWechatActivation \$window\)\)[\s\S]*GetForegroundWindow\(\) -eq \$hWnd[\s\S]*AttachThreadInput/u,
  "foreground handoff must let WeChat reconcile its own Qt state before using the Win32 fallback"
);
assert.match(
  NORMALIZE_WECHAT_WINDOW_SCRIPT,
  /\$nativeActivationRequested = \$false[\s\S]*Request-PersonalWechatActivation \$matched[\s\S]*\$nativeActivationRequested = \$true[\s\S]*Request-ExactWechatForeground \$hWnd \$matched \$nativeActivationRequested/u,
  "one window-preparation transaction must request WeChat native activation at most once"
);
assert.match(NORMALIZE_WECHAT_WINDOW_SCRIPT, /GetLastInputInfo/u);
assert.match(NORMALIZE_WECHAT_WINDOW_SCRIPT, /wechat_user_active/u);
assert.match(
  NORMALIZE_WECHAT_WINDOW_SCRIPT,
  /\$matched = \$matches\[0\][\s\S]*?if \(-not \(Test-XiaoxiUserIdle\)\) \{ Stop-ForActiveUser \$matched\.pid \$hWnd; exit \}/u,
  "a background preflight must defer while the user is active even when WeChat already has the target geometry"
);
assert.match(NORMALIZE_WECHAT_WINDOW_SCRIPT, /AttachThreadInput/u);
assert.match(NORMALIZE_WECHAT_WINDOW_SCRIPT, /BringWindowToTop/u);
assert.match(NORMALIZE_WECHAT_WINDOW_SCRIPT, /GetForegroundWindow\(\) -eq \$hWnd/u, "foreground success must be proven against the exact HWND");
const windowDriverSource = fs.readFileSync(path.join(__dirname, "wechat_window_driver.cjs"), "utf8");
assert.doesNotMatch(windowDriverSource, /D:\\\\微信\\\\Weixin\\\\Weixin\.exe/u, "the launcher must not embed this development machine's WeChat path");
assert.doesNotMatch(windowDriverSource, /(?:Left|Top) -gt -1000/u, "valid windows on a left-side monitor must not be rejected by coordinate magic numbers");
await focusWechatWindowAsync({ expectedPid: 81, expectedHWnd: "91" }, layoutRunner);
assert.equal(layoutCalls[1].script, NORMALIZE_WECHAT_WINDOW_SCRIPT, "active-touch focus must use the same maximized work-area contract");

const prepared = await prepareWechatRpaWindowAsync({
  expectedPid: 81,
  expectedHWnd: "91",
  minIdleMs: WECHAT_RPA_BACKGROUND_MIN_IDLE_MS,
  requireFocused: true
}, layoutRunner);
assert.equal(prepared.ok, true);
assert.equal(layoutCalls[2].env.XIAOXI_WECHAT_MIN_IDLE_MS, "15000");
assert.equal((await prepareWechatRpaWindowAsync({}, async () => ({
  ...normalizedWindow,
  normalized: false,
  layoutMode: "current_usable"
}))).reason, "wechat_window_not_ready");
assert.equal((await prepareWechatRpaWindowAsync({ requireFocused: true }, async () => ({
  ...normalizedWindow,
  focused: false
}))).reason, "wechat_window_not_foreground");
assert.equal((await prepareWechatRpaWindowAsync({ expectedHWnd: "92" }, async () => normalizedWindow)).reason, "wechat_window_identity_mismatch");
assert.equal((await prepareWechatRpaWindowAsync({}, async () => ({ ok: false, reason: "wechat_user_active" }))).reason, "wechat_user_active");

const executionOrder = [];
const executionPrepareContexts = [];
const normalizedDriver = createWechatAutoReplyDriverWithWindowLayout(
  (script, env) => {
    executionOrder.push(env.XIAOXI_AUTO_REPLY_MODE);
    assert.equal(script, AUTO_REPLY_VISUAL_SCRIPT, "production auto-reply must stay on the visual adapter for the whole run");
    if (env.XIAOXI_AUTO_REPLY_MODE === "prime") {
      return { ok: true, source: "session_prime", pid: 81, hWnd: 91 };
    }
    return { ok: false, reason: "no_unread_message", pid: 81, hWnd: 91, window: { x: 0, y: 0, width: 1100, height: 700 }, dpi: 120 };
  },
  async (context) => {
    executionOrder.push("normalize");
    executionPrepareContexts.push(context);
    return normalizedWindow;
  }
);
assert.equal(
  (await normalizedDriver.scanWechatIncoming(["张总"])).reason,
  "current_session_baselined",
  "the first visual observation establishes a baseline instead of replying to pre-start content"
);
assert.deepEqual(executionOrder, ["normalize", "prime"], "the first scan must normalize once and establish a visual baseline");
await normalizedDriver.scanWechatIncoming(["layout-cache-contact"]);
assert.deepEqual(executionOrder, ["normalize", "prime", "normalize", "scan"], "every background poll must pass the shared strict window preflight");
assert.equal(executionPrepareContexts[0].minIdleMs, 0);
assert.deepEqual(executionPrepareContexts[1], {
  expectedPid: 81,
  expectedHWnd: "91",
  minIdleMs: 0,
  requireFocused: true
}, "the next poll must freeze the exact PID/HWND without waiting on a session-wide idle timer");

const retryPrepareContexts = [];
const deferredPrimeDriver = createWechatAutoReplyDriverWithWindowLayout(
  (script, env) => {
    assert.equal(script, AUTO_REPLY_VISUAL_SCRIPT);
    assert.equal(env.XIAOXI_AUTO_REPLY_MODE, "prime");
    return { ok: false, reason: "history_ocr_failed" };
  },
  async (context) => {
    retryPrepareContexts.push(context);
    return normalizedWindow;
  }
);
assert.equal((await deferredPrimeDriver.primeWechatSession(["deferred-prime-contact"])).reason, "history_ocr_failed");
assert.equal((await deferredPrimeDriver.primeWechatSession(["deferred-prime-contact"])).reason, "history_ocr_failed");
assert.equal(retryPrepareContexts[0].minIdleMs, 0);
assert.equal(
  retryPrepareContexts[1].minIdleMs,
  0,
  "a deferred prime retry must not mistake recent automation input for an active user"
);

let movedScanCalls = 0;
let movedNormalizeCalls = 0;
const movedPrepareContexts = [];
const movedWindowDriver = createWechatAutoReplyDriverWithWindowLayout(
  (script, env) => {
    assert.equal(script, AUTO_REPLY_VISUAL_SCRIPT);
    if (env.XIAOXI_AUTO_REPLY_MODE === "prime") {
      return { ok: true, source: "session_prime", pid: 81, hWnd: 91 };
    }
    movedScanCalls += 1;
    return {
      ok: false,
      reason: "no_unread_message",
      pid: 81,
      hWnd: 91,
      window: movedScanCalls === 1
        ? { x: 0, y: 0, width: 1100, height: 700 }
        : { x: 24, y: 0, width: 1100, height: 700 },
      dpi: 120
    };
  },
  async (context) => {
    movedNormalizeCalls += 1;
    movedPrepareContexts.push(context);
    return normalizedWindow;
  }
);
assert.equal((await movedWindowDriver.primeWechatSession(["layout-change-contact"])).primed, true);
assert.equal((await movedWindowDriver.scanWechatIncoming(["layout-change-contact"])).reason, "no_unread_message");
assert.equal(movedNormalizeCalls, 2);
assert.equal((await movedWindowDriver.scanWechatIncoming(["layout-change-contact"])).reason, "wechat_window_changed");
assert.equal(movedNormalizeCalls, 3, "a changed rectangle is rejected in-place; repair is deferred to the next transaction entry");
assert.deepEqual(movedPrepareContexts[0], { minIdleMs: 0, requireFocused: true }, "a user-started initial prime may arrange the explicitly requested WeChat window immediately");
assert.equal(movedPrepareContexts[1].expectedPid, 81);
assert.equal(movedPrepareContexts[1].expectedHWnd, "91");
assert.equal(movedPrepareContexts[1].minIdleMs, 0, "each background scan proceeds without a session-wide idle delay");
assert.equal(movedPrepareContexts[1].requireFocused, true);
assert.equal(movedPrepareContexts[2].expectedPid, 81);
assert.equal(movedPrepareContexts[2].expectedHWnd, "91");
assert.equal(movedPrepareContexts[2].minIdleMs, 0);

let blockedExternalInputScannerCalls = 0;
let blockedExternalInputPrepareCalls = 0;
const blockedExternalInputScan = createWechatAutoReplyDriverWithWindowLayout(
  (script, env) => {
    blockedExternalInputScannerCalls += 1;
    assert.equal(env.XIAOXI_AUTO_REPLY_MODE, "prime");
    return { ok: true, source: "session_prime", pid: 81, hWnd: 91 };
  },
  async () => {
    blockedExternalInputPrepareCalls += 1;
    return blockedExternalInputPrepareCalls === 1
      ? normalizedWindow
      : { ok: false, reason: "wechat_external_input_detected" };
  }
);
assert.equal((await blockedExternalInputScan.primeWechatSession(["external-input-contact"])).primed, true);
assert.equal((await blockedExternalInputScan.scanWechatIncoming(["external-input-contact"])).reason, "wechat_external_input_detected");
assert.equal(blockedExternalInputScannerCalls, 1, "input detected during the critical window transaction must stop before the scanner runs");

const restartedPrepareContexts = [];
const restartedScannerModes = [];
let restartedPrepareAttempt = 0;
const restartedWindowDriver = createWechatAutoReplyDriverWithWindowLayout(
  (script, env) => {
    restartedScannerModes.push(env.XIAOXI_AUTO_REPLY_MODE);
    return {
      ok: true,
      source: "session_prime",
      pid: restartedScannerModes.length === 1 ? 81 : 82,
      hWnd: restartedScannerModes.length === 1 ? 91 : 92
    };
  },
  async (context) => {
    restartedPrepareContexts.push(context);
    restartedPrepareAttempt += 1;
    if (restartedPrepareAttempt === 2) return { ok: false, reason: "wechat_window_identity_mismatch" };
    return restartedPrepareAttempt === 1
      ? normalizedWindow
      : { ...normalizedWindow, pid: 82, hWnd: "92" };
  }
);
assert.equal((await restartedWindowDriver.primeWechatSession(["restarted-window-contact"])).primed, true);
assert.equal(
  (await restartedWindowDriver.scanWechatIncoming(["restarted-window-contact"])).reason,
  "wechat_window_identity_mismatch",
  "the first poll after a restart must reset the stale exact binding without scanning"
);
assert.deepEqual(restartedScannerModes, ["prime"]);
assert.equal(
  (await restartedWindowDriver.scanWechatIncoming(["restarted-window-contact"])).reason,
  "current_session_baselined",
  "the next idle poll may discover the replacement HWND but must establish a fresh baseline before emitting a candidate"
);
assert.deepEqual(restartedScannerModes, ["prime", "prime"]);
assert.equal(restartedPrepareContexts[1].expectedPid, 81);
assert.equal(restartedPrepareContexts[1].expectedHWnd, "91");
assert.equal(restartedPrepareContexts[1].minIdleMs, 0);
assert.equal(restartedPrepareContexts[2].expectedPid, undefined);
assert.equal(restartedPrepareContexts[2].expectedHWnd, undefined);
assert.equal(restartedPrepareContexts[2].minIdleMs, 0);
let blockedScanCalls = 0;
const blockedByLayout = createWechatAutoReplyDriverWithWindowLayout(
  () => { blockedScanCalls += 1; return { ok: true }; },
  async () => ({ ok: false, reason: "wechat_window_not_ready" })
);
assert.equal((await blockedByLayout.primeWechatSession(["张总"])).reason, "wechat_window_not_ready");
assert.equal(blockedScanCalls, 0, "a failed window layout must stop before the auto-reply scanner runs");

const blockedByBestEffortLayout = createWechatAutoReplyDriverWithWindowLayout(
  () => { throw new Error("scanner must not run"); },
  async () => ({ ...normalizedWindow, normalized: false, layoutMode: "current_usable" })
);
assert.equal(
  (await blockedByBestEffortLayout.primeWechatSession(["strict-layout-contact"])).reason,
  "wechat_window_not_ready",
  "auto-reply execution must not accept the legacy best-effort layout result"
);
const blockedByMissingFocus = createWechatAutoReplyDriverWithWindowLayout(
  () => { throw new Error("scanner must not run"); },
  async () => ({ ...normalizedWindow, focused: false })
);
assert.equal((await blockedByMissingFocus.primeWechatSession(["strict-focus-contact"])).reason, "wechat_window_not_foreground");

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
const productionPreviewSignature = "a".repeat(64);
const productionMessageBaseline = "b".repeat(64);
const productionMessageSignature = "c".repeat(64);
const productionEvidenceRuntimeId = `visual:v1:${"d".repeat(64)}`;
const scannedContext = [
  { role: "assistant", content: "您好", key: `visual:v1:${"e".repeat(64)}` },
  { role: "user", content: "你好", key: productionEvidenceRuntimeId }
];
const productionVisualResults = [
  {
    ok: true,
    source: "session_prime",
    pid: 81,
    hWnd: 91,
    sessionBaselines: [{ conversation: "张总", signature: productionPreviewSignature }],
    sessionMessageBaselines: [{ conversation: "张总", signature: productionMessageBaseline }]
  },
  {
    ok: true,
    conversation: "张总",
    message: "你好",
    runtimeId: productionEvidenceRuntimeId,
    previewSignature: productionPreviewSignature,
    messageSignature: productionMessageSignature,
    pid: 81,
    hWnd: 91,
    source: "current_open",
    latestRole: "user",
    context: scannedContext
  },
  {
    ok: true,
    conversation: "张总",
    message: "你好",
    runtimeId: productionEvidenceRuntimeId,
    messageSignature: productionMessageSignature,
    pid: 81,
    hWnd: 91,
    source: "verify",
    latestRole: "user",
    context: scannedContext
  }
];
const driver = createWechatAutoReplyDriver((script, env, options) => {
  calls.push({ script, env, options });
  return productionVisualResults.shift();
});

assert.equal((await driver.primeWechatSession([" 张总 ", "李经理", "张总"])).primed, true);
const scanResult = await driver.scanWechatIncoming([" 张总 ", "李经理", "张总"]);
assert.equal(scanResult.conversation, "张总");
assert.equal(scanResult.visualMode, "visual_render_v1");
assert.match(scanResult.runtimeId, /^visual:v2:[a-f0-9]{64}$/u);
assert.equal(scanResult.visualEvidenceRuntimeId, productionEvidenceRuntimeId);
assert.equal(scanResult.context.at(-1).key, scanResult.runtimeId, "the public occurrence identity must replace the one-frame evidence key in context");
assert.equal(calls[0].script, AUTO_REPLY_VISUAL_SCRIPT, "the production driver must start directly on the visual adapter");
assert.deepEqual(JSON.parse(calls[0].env.XIAOXI_ALLOWED_NAMES), ["张总", "李经理"]);
assert.deepEqual(JSON.parse(calls[0].env.XIAOXI_VISUAL_BASELINES), {});
assert.deepEqual(JSON.parse(calls[0].env.XIAOXI_VISUAL_MESSAGE_BASELINES), {});
assert.equal(calls[0].env.XIAOXI_AUTO_REPLY_MODE, "prime");
assert.equal(calls[0].env.XIAOXI_SESSION_BASELINES, undefined, "the production path must not initialize the legacy UIA baseline contract");
assert.equal(calls[0].options.ensure, false);
assert.equal(calls[0].options.sta, true);
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("$automationId.StartsWith(\"session_item_\""), true, "current WeChat session items must match by their exact automation-id prefix and allowed name");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("\\[[1-9][0-9]*条\\]"), true, "current WeChat unread count must be recognized from the session item name");
assert.equal(AUTO_REPLY_SCAN_SCRIPT.includes("selection.Select(); Start-Sleep -Milliseconds 400; return $true"), false, "selection hints must not bypass the click fallback");
assert.doesNotMatch(AUTO_REPLY_SCAN_SCRIPT, /ShowWindowAsync|SetForegroundWindow|AppActivate/u, "the exact scan transaction must never steal foreground after its shared preflight");
assert.match(AUTO_REPLY_SCAN_SCRIPT, /function Test-ExactPointOwned[\s\S]*WindowFromPoint[\s\S]*GetAncestor[\s\S]*GetWindowThreadProcessId/u, "the fallback click must prove exact HWND and PID ownership");
assert.match(AUTO_REPLY_SCAN_SCRIPT, /function Open-Session[\s\S]*Test-ExactForeground[\s\S]*SelectionItemPattern[\s\S]*Test-ExactForeground[\s\S]*InvokePattern[\s\S]*Test-ExactForeground[\s\S]*mouse_event/u, "session opening must recheck the exact foreground around every input path");
assert.match(AUTO_REPLY_SCAN_SCRIPT, /Test-ExactForeground \$hWnd[^]*SetScrollPercent[^]*Test-ExactForeground \$hWnd[^]*SetScrollPercent/u, "history inspection must not scroll after the exact window loses foreground");
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
assert.equal(calls[0].script.includes("GZipStream"), false, "the active visual adapter must not be mistaken for the legacy compressed UIA script");
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

assert.equal((await driver.verifyWechatIncoming(scanResult)).ok, true);
assert.equal(calls[2].script, AUTO_REPLY_VISUAL_SCRIPT);
assert.equal(calls[2].env.XIAOXI_AUTO_REPLY_MODE, "verify");
assert.equal(calls[2].env.XIAOXI_EXPECTED_CONVERSATION, "张总");
assert.equal(calls[2].env.XIAOXI_EXPECTED_MESSAGE, "你好");
assert.equal(calls[2].env.XIAOXI_EXPECTED_RUNTIME_ID, productionEvidenceRuntimeId, "verification must bind to the observed bubble evidence, not the public occurrence id");
assert.equal(calls[2].env.XIAOXI_EXPECTED_MESSAGE_SIGNATURE, productionMessageSignature);
assert.equal(calls[2].env.XIAOXI_EXPECTED_PID, "81");
assert.equal(calls[2].env.XIAOXI_EXPECTED_HWND, "91");
assert.equal(driver.scanWechatIncoming.noteVerifiedSend(scanResult, { verificationMode: "visual_message_bubble" }), true);
assert.equal(typeof driver.scanWechatIncoming.restorePendingObservation, "function");
assert.equal(typeof driver.scanWechatIncoming.resetBaselines, "function");
assert.equal((await driver.verifyWechatIncoming({ conversation: "", message: "" })).reason, "incoming_message_missing");
assert.equal((await driver.verifyWechatIncoming({ conversation: "张总", message: "你好" })).reason, "incoming_identity_missing");

const wrapperTurnSignature = "7".repeat(64);
const wrapperTurnEvidence = `visual:v1:${"8".repeat(64)}`;
const wrapperTurnRawCandidate = {
  ok: true,
  conversation: "轮次恢复客户",
  message: "相同问题",
  runtimeId: wrapperTurnEvidence,
  previewSignature: wrapperTurnSignature,
  messageSignature: wrapperTurnSignature,
  pid: 181,
  hWnd: 191,
  source: "current_message_change",
  latestRole: "user",
  context: [{ role: "user", content: "相同问题", key: wrapperTurnEvidence }]
};
const wrapperTurnResults = [
  { ok: true, source: "session_prime", pid: 181, hWnd: 191, sessionBaselines: [], sessionMessageBaselines: [] },
  { ...wrapperTurnRawCandidate },
  { ...wrapperTurnRawCandidate }
];
const wrapperTurnDriver = createWechatAutoReplyDriver(
  (script) => {
    assert.equal(script, AUTO_REPLY_VISUAL_SCRIPT);
    return wrapperTurnResults.shift();
  },
  async () => ({ ...normalizedWindow, pid: 181, hWnd: "191" })
);
assert.equal(typeof wrapperTurnDriver.scanWechatIncoming.restoreTurnBoundaries, "function");
assert.equal(typeof wrapperTurnDriver.scanWechatIncoming.noteSendAttempted, "function");
assert.equal(wrapperTurnDriver.scanWechatIncoming.restoreTurnBoundaries([{
  conversation: "轮次恢复客户",
  turnEpoch: 3,
  runtimeId: `visual:v2:${"6".repeat(64)}`
}]), 1, "the production wrapper must restore the visual adapter's durable contact turn");
assert.equal((await wrapperTurnDriver.primeWechatSession(["轮次恢复客户"])).ok, true);
const wrapperRestoredTurn = await wrapperTurnDriver.scanWechatIncoming(["轮次恢复客户"]);
const wrapperUnknownAttempt = wrapperTurnDriver.scanWechatIncoming.noteSendAttempted(wrapperRestoredTurn, { outcomeUnknown: true });
assert.deepEqual(wrapperUnknownAttempt, { advanced: false, outcomeUnknown: true, turnEpoch: 3 }, "outcome_unknown must preserve the current durable turn through the production wrapper");
assert.deepEqual(
  wrapperTurnDriver.scanWechatIncoming.noteSendAttempted(wrapperRestoredTurn, { outcomeUnknown: true }),
  { advanced: false, outcomeUnknown: true, turnEpoch: 3 },
  "replaying the same outcome_unknown callback must be idempotent"
);
const wrapperNextSameText = await wrapperTurnDriver.scanWechatIncoming(["轮次恢复客户"]);
assert.equal(wrapperNextSameText.runtimeId, wrapperRestoredTurn.runtimeId, "the unresolved original bubble must retain its occurrence ID through the real wrapper");

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

const processChangeCalls = [];
let processChangeNormalizeCalls = 0;
const processChangeResults = [
  { ok: true, source: "session_prime", pid: 81, hWnd: 91 },
  { ok: false, reason: "wechat_process_changed", pid: 82, hWnd: 92 },
  { ok: true, source: "session_prime", pid: 82, hWnd: 92 }
];
const processChangeDriver = createWechatAutoReplyDriverWithWindowLayout(
  (script, env) => {
    assert.equal(script, AUTO_REPLY_VISUAL_SCRIPT);
    processChangeCalls.push(env);
    return processChangeResults.shift();
  },
  async () => {
    processChangeNormalizeCalls += 1;
    return processChangeNormalizeCalls === 1
      ? normalizedWindow
      : { ...normalizedWindow, pid: 82, hWnd: "92" };
  }
);
assert.equal((await processChangeDriver.primeWechatSession(["A测试客户"])).primed, true);
assert.equal((await processChangeDriver.scanWechatIncoming(["A测试客户"])).reason, "wechat_process_changed");
assert.equal((await processChangeDriver.scanWechatIncoming(["A测试客户"])).reason, "current_session_baselined", "a changed visual HWND must establish a fresh baseline before another message can be emitted");
assert.deepEqual(processChangeCalls.map((env) => env.XIAOXI_AUTO_REPLY_MODE), ["prime", "scan", "prime"]);
assert.equal(processChangeCalls[1].XIAOXI_EXPECTED_PID, "81");
assert.equal(processChangeCalls[1].XIAOXI_EXPECTED_HWND, "91");
assert.equal(processChangeCalls[2].XIAOXI_EXPECTED_PID, "82");
assert.equal(processChangeCalls[2].XIAOXI_EXPECTED_HWND, "92");
assert.equal(processChangeNormalizeCalls, 3, "each scan must preflight, including the fresh-baseline transaction after a dead visual window identity");

const visualFencePreview0 = "1".repeat(64);
const visualFencePreview1 = "2".repeat(64);
const visualFencePreview2 = "3".repeat(64);
const visualFenceMessage0 = "4".repeat(64);
const visualFenceMessage1 = "5".repeat(64);
const visualFenceMessage2 = "6".repeat(64);
const visualEvidence1 = `visual:v1:${"7".repeat(64)}`;
const visualEvidence2 = `visual:v1:${"8".repeat(64)}`;
const visualFenceResults = [
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
    runtimeId: visualEvidence1,
    previewSignature: visualFencePreview1,
    messageSignature: visualFenceMessage1,
    pid: 81,
    hWnd: 91,
    source: "current_open",
    latestRole: "user",
    context: [{ role: "user", content: "旧重试", key: visualEvidence1 }]
  },
  { ok: false, reason: "wechat_focus_failed", pid: 81, hWnd: 91 },
  {
    ok: true,
    conversation: "Visual客户",
    message: "恢复后的新消息",
    runtimeId: visualEvidence2,
    previewSignature: visualFencePreview2,
    messageSignature: visualFenceMessage2,
    pid: 81,
    hWnd: 91,
    source: "current_open",
    latestRole: "user",
    context: [{ role: "user", content: "恢复后的新消息", key: visualEvidence2 }]
  },
  { ok: false, reason: "no_unread_message", pid: 81, hWnd: 91 }
];
const visualFenceDriver = createWechatAutoReplyDriver((script, env) => {
  assert.equal(script, AUTO_REPLY_VISUAL_SCRIPT);
  return visualFenceResults.shift();
});
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
assert.equal(visualRetryAfterFocus.runtimeId, visualRetryCandidate.runtimeId, "a visual fence must preserve a proven-unsent retry without switching to the legacy adapter");
assert.deepEqual(visualRetryAfterFocus.scanProbe, { ok: false, reason: "no_unread_message" });

const restoredMessageSignature = "9".repeat(64);
const restoredEvidence = `visual:v1:${"a".repeat(64)}`;
const restoredCalls = [];
const restoredDriver = createWechatAutoReplyDriver((script, env) => {
  restoredCalls.push({ script, env });
  return {
    ok: true,
    conversation: "恢复客户",
    message: "重启前的新问题",
    runtimeId: restoredEvidence,
    previewSignature: "b".repeat(64),
    messageSignature: restoredMessageSignature,
    pid: 81,
    hWnd: 91,
    source: "recover",
    latestRole: "user",
    context: [{ role: "user", content: "重启前的新问题", key: restoredEvidence }]
  };
});
assert.equal(restoredDriver.scanWechatIncoming.restorePendingObservation({
  conversation: "恢复客户",
  pid: 81,
  hWnd: "91",
  preview_signature: "b".repeat(64),
  message_signature: restoredMessageSignature,
  predecessor_message_signature: "c".repeat(64)
}), true);
const restoredCandidate = await restoredDriver.scanWechatIncoming(["恢复客户"]);
assert.equal(restoredCandidate.message, "重启前的新问题");
assert.match(restoredCandidate.runtimeId, /^visual:v2:[a-f0-9]{64}$/u);
assert.equal(restoredCalls[0].script, AUTO_REPLY_VISUAL_SCRIPT);
assert.equal(restoredCalls[0].env.XIAOXI_AUTO_REPLY_MODE, "recover");

let eventLoopAdvanced = false;
setTimeout(() => { eventLoopAdvanced = true; }, 0);
const asynchronousProbe = await runPowerShellAsync("Start-Sleep -Milliseconds 150; @{ ok = $true } | ConvertTo-Json -Compress", {}, { ensure: false, timeout: 5000 });
assert.equal(asynchronousProbe.ok, true);
assert.equal(eventLoopAdvanced, true, "auto-reply PowerShell scans must not block Electron's event loop");

const asynchronousFailureProbe = await runPowerShellAsync(
  'Write-Error "async-diagnostics-marker"; exit 7',
  {},
  { ensure: false, timeout: 5000, diagnostics: true }
);
assert.equal(asynchronousFailureProbe.ok, false);
assert.equal(asynchronousFailureProbe.reason, "powershell_failed");
assert.match(asynchronousFailureProbe.diagnostics.stderr, /async-diagnostics-marker/u);
assert.equal(asynchronousFailureProbe.diagnostics.exit_code, 7);

console.log("wechat auto-reply driver self-check passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
