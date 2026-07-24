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
const visualDriverSource = createWechatVisualAutoReplyDriver.toString();
assert.ok(AUTO_REPLY_VISUAL_SCRIPT.includes(MOMENTS_VISUAL_READONLY_POWERSHELL));
const autoReplyEntry = AUTO_REPLY_VISUAL_SCRIPT.slice(AUTO_REPLY_VISUAL_SCRIPT.indexOf('$mode = [Environment]::GetEnvironmentVariable("XIAOXI_AUTO_REPLY_MODE")'));
assert.doesNotMatch(autoReplyEntry, /Get-MomentsRenderPaneEvidence/u, "auto reply must not require the Moments-only MMUIRenderSubWindowHW child pane");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /Get-AutoReplyVisualFrame \$hWnd \$windowRect \$expectedProcessId/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /Get-MomentsOcrObservation \$frame/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$ocrDownscale = if \(\[double\]\$script:AutoReplyVisualScale -ge 2\.5\) \{ 2 \} else \{ 1 \}[\s\S]*Get-MomentsDownscaledOcrObservation/u, "300% DPI scans should reduce OCR pixels while normal desktop and laptop scaling remains unchanged");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /function Get-AutoReplyVisualCurrentConversation/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /function Get-AutoReplyVisualAnyHeader/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /function Get-AutoReplyVisualUnreadBadges/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /function Get-AutoReplyVisualUnreadRowPreview/u, "a red-dot event must preserve the sidebar preview before opening the chat");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$badgePreview = Get-AutoReplyVisualUnreadRowPreview \$observation\.lines \$badge \$sidebarRight[\s\S]*preview = \$badgePreview/u, "the independent sidebar OCR must travel with the red-dot candidate");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /if \(-not \$preview\)[\s\S]*\$preview = \[string\]\$badgeLatest\.message/u, "bubble OCR must only replace a missing sidebar preview");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$resolvedMessage = Resolve-AutoReplyVisualMessageText \$preview \(\[string\]\$confirmedLatest\.message\)/u, "a stable second bubble frame must still be reconciled with the pre-click sidebar preview");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /badgeOnly = \$true[\s\S]*source = "unread_badge"/u, "an OCR-unresolved unread badge must use the row-opening fallback");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$row\.badgeBounds\.centerX[\s\S]*\$row\.badgeBounds\.centerY/u, "the unread fallback must click WeChat's own badge geometry");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /badgeOnly = \$true[\s\S]*messageDriven = \$true/u, "a red-dot inbound event must be message-driven rather than contact-name authorized");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /Message-driven auto reply keeps the observed title only as diagnostic[\s\S]*\$conversation = \[string\]\$header\.conversation/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /if \(-not \[bool\]\$candidate\.badgeOnly\)[\s\S]*Get-AutoReplyVisualHeader \$confirmation\.lines/u, "title confirmation must remain for named paths but not block a red-dot message event");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /if \(\$expectedMessageDriven\)[\s\S]*state = "message_driven"[\s\S]*Get-AutoReplyVisualHeader \$observation\.lines/u, "final incoming verification must not restore the contact-title gate");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$bubbleEvidenceMatches = \$observedMessageSignature -ceq \$expectedMessageSignature -and \([\s\S]*\$expectedMessageDriven -or/u, "message-driven verification must bind the same incoming bubble without a title-derived runtime id");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /function Get-AutoReplyVisualLatestMessageEvidence/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /function Get-AutoReplyVisualSidebarRight/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /function Get-AutoReplyVisualMessageRole/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /function Get-AutoReplyVisualMessageRows/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /function Get-AutoReplyVisualMessageBlocks/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /Merge-AutoReplyVisualMessageParts \$current\.ToArray\(\) \$true/u, "same-row OCR fragments must be ordered by horizontal position before aggregation");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$latest = \$messageBlocks\[-1\][\s\S]*Get-AutoReplyVisualMessageRole \$frame \$latest/u, "role and evidence must use the aggregated bubble rather than its last OCR fragment");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$greenRatio -ge 0\.16/u, "outgoing green bubble proof must take priority over OCR geometry");
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /\$viewportHash|\$viewportRect/u, "whole-viewport changes must not alter message identity");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /evidenceSignature = Get-AutoReplyVisualSha256 \$semanticSeed/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /diagnosticSignature = Get-AutoReplyVisualSha256 \$diagnosticSeed/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /function Get-AutoReplyVisualChatBottom/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /Get-AutoReplyVisualChatBottom \$frame \$sidebarRight/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /source = "normalized_window_ratio"/u, "an unrecognized composer theme must use a conservative normalized boundary instead of blocking the listener");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /bottom = \[double\]\[Math\]::Max/u, "a proven divider must return a structured boundary");
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /composerReserveFallback|Test-AutoReplyVisualMessageLinePosition/u);
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /\$chatBottom = \[double\]\$frame\.height \* 0\.88/u, "a fixed permissive cutoff can admit composer drafts");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /function Resolve-AutoReplyVisualWechatWindow/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /PrintWindow\(\$hWnd, \$hdc, 2\)/u, "background observation must capture the bound HWND rather than a covering Electron window");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /Test-AutoReplyVisualFrameContent/u, "blank or failed PrintWindow output must never reach OCR");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /captureMethod -ceq "hwnd_printwindow"[\s\S]*reason = "visual_ocr_structure_missing"/u, "a compositor shell without chat structure must force one real screen capture");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /if \(-not \$allowForegroundFallback\) \{ return @\{ ok = \$false; reason = "visual_capture_failed" \} \}/u, "passive polling must not steal foreground when HWND capture is unavailable");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$previousForeground = \[Win32WechatMomentsVisualReadOnly\]::GetForegroundWindow\(\)[\s\S]*finally \{[\s\S]*SetForegroundWindow\(\$previousForeground\)/u, "a live screen freshness check must best-effort restore the user's previous foreground window");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\[Win32WechatAutoReplyVisual\]::EnumWindows\(\$callback, \[IntPtr\]::Zero\)/u);
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /\.MainWindowHandle/u, "window discovery must enumerate visible top-level HWNDs because WeChat 4.x can expose MainWindowHandle=0");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /WindowFromPoint\(\$point\)/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$hitRoot = \[Win32WechatMomentsVisualReadOnly\]::GetAncestor\(\$hit, 2\)/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /GetWindowThreadProcessId\(\$hit, \[ref\]\$hitPid\)/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /GetWindowThreadProcessId\(\$hitRoot, \[ref\]\$rootPid\)/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /GetForegroundWindow\(\) -ne \$hWnd/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$candidates\.Count -eq 0/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$unreadCandidates = @\(\$candidates\.ToArray\(\) \| Where-Object \{ \$_\.unread \}\)/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$candidate = if \(\$unreadCandidates\.Count -gt 0\) \{ \$unreadCandidates\[0\] \} else \{ \$candidates\[0\] \}/u);
assert.match(
  AUTO_REPLY_VISUAL_SCRIPT,
  /function Get-AutoReplyVisualHeader[\s\S]*Test-AutoReplyVisualConversationMatch/u,
  "header verification must tolerate bounded OCR drift instead of requiring exact text"
);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /state = "matched"/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /state = "unresolved"[\s\S]*reason = "conversation_title_unresolved"/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /state = if \(\$clearlyDifferent\) \{ "different" \} else \{ "unresolved" \}/u, "only a clearly different title may block the bound bubble");
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /\$chatMid/u, "role classification must not depend on a single midpoint test");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /"visual:v1:" \+ \(Get-AutoReplyVisualSha256/u);
assert.match(visualDriverSource, /visual-occurrence-bubble-v3/u);
assert.doesNotMatch(visualDriverSource, /randomBytes|driverSessionId|occurrenceSequence/u, "occurrence IDs must not depend on a process session or scan counter");
assert.match(visualDriverSource, /restorePendingObservation/u, "pending evidence must have a restart recovery entry point");
assert.match(visualDriverSource, /active\.messageSignature === messageSignature \|\| sameObservedMessage\(active\.message, message\)[\s\S]*active\.runtimeId/u, "an active occurrence must reuse its public ID while the authoritative bubble is unchanged or has bounded OCR drift");
assert.match(visualDriverSource, /visual-occurrence-bubble-v3[\s\S]*conversation[\s\S]*messageSignature[\s\S]*String\(turn\.epoch\)/u, "a new occurrence must include the per-contact turn epoch without using sidebar geometry");
assert.match(visualDriverSource, /if \(outcomeUnknown\)[\s\S]*advanced: false[\s\S]*turnEpoch: previousTurn\.epoch/u, "an unknown send result must retain the current occurrence and epoch");
assert.match(visualDriverSource, /observeAssistantBoundary[\s\S]*turnEpoch = previousTurn\.epoch \+ 1/u, "an observed outgoing boundary must advance the contact turn once");
assert.doesNotMatch(visualDriverSource, /liveScreenRefreshIntervalMs|lastLiveScreenCheckAt|forceLiveScreen/u, "stable background polling must never periodically steal foreground");
assert.doesNotMatch(visualDriverSource, /foregroundCaptureMode/u, "one successful fallback must not permanently force every poll to steal foreground");
assert.match(visualDriverSource, /scanWechatIncoming\.resetBaselines[\s\S]*retryCandidates\.length = 0/u, "a restarted listener must not inherit an unsent candidate from the previous run");
assert.doesNotMatch(visualDriverSource, /eventSequence|eventSessionId/u, "stable visual evidence must not receive a new ID on every scan");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /if \(\$row\.unread -and -not \$row\.draft -and \$newSinceStartupBoundary -and -not \$sameHistoricalUnread\)/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /if \(-not \[bool\]\$match\.exact -or -not \$unread\) \{ continue \}/u, "a missing preview may locate only an exact allowlisted unread row");
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /-not \(Test-AutoReplyVisualUnreadDot \$frame \$line\.bounds\)/u, "an arbitrary unread title must never add itself to the one-to-one whitelist");
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /\$row\.unread -or \$changed/u);
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /source -NotePropertyValue .*preview_change/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$nameBounds\.left - \(Scale-AutoReplyVisualMetric 44\.0\)/u, "4.1.12 at 125% DPI must capture the complete badge over the avatar rather than a clipped edge");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$nameBounds\.left \+ \(Scale-AutoReplyVisualMetric 24\.0\)/u, "badge-count OCR merged into a name line must still keep the badge inside the probe");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$nameBounds\.top - \(Scale-AutoReplyVisualMetric 22\.0\)/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$nameBounds\.height \* 0\.65/u, "unread search must include badges vertically aligned with the contact name");
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /\$nameBounds\.left - 78\.0/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$windowDpi \/ 96\.0/u, "physical visual thresholds must scale from Windows' logical 96-DPI baseline");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$script:AutoReplyVisualScale \* \$script:AutoReplyVisualScale/u, "pixel-area thresholds must scale quadratically");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$row\.nameBounds\.top \+ \(\[double\]\$row\.nameBounds\.height \* 0\.5\)/u);
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /\$row\.nameBounds\.height \+ 8\.0/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /baselineAdvance = @\{ conversation = \$conversation; signature = \[string\]\$candidate\.signature \}/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /messageBaselineAdvance = @\{ conversation = \$conversation; signature = \[string\]\$latest\.evidenceSignature \}/u);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /source = "current_message_change"/u);
const unresolvedBadgeCapture = AUTO_REPLY_VISUAL_SCRIPT.indexOf("$unresolvedUnreadBadgeCount = $badgeFallbacks.Count");
const allowlistedCurrentTransition = AUTO_REPLY_VISUAL_SCRIPT.indexOf("$currentMessageChanged = $previousMessageSignature -cne $currentMessageSignature", unresolvedBadgeCapture);
const unresolvedBadgeFallback = AUTO_REPLY_VISUAL_SCRIPT.indexOf("badgeOnly = $true", allowlistedCurrentTransition);
assert.ok(
  unresolvedBadgeCapture >= 0 && allowlistedCurrentTransition > unresolvedBadgeCapture && unresolvedBadgeFallback > allowlistedCurrentTransition,
  "an allowlisted current-chat bubble gets priority before opening an OCR-unresolved unread badge"
);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /source = "current_message_change"[\s\S]*unreadBadgeCount = \[int\]\$unresolvedUnreadBadgeCount/u, "the winning allowlisted current-chat candidate must retain the unknown-dot diagnostic without being starved by it");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$previousMessageSignature -cne \$currentMessageSignature/u, "the chat bubble alone decides whether the open conversation advanced");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /Start-Sleep -Milliseconds 140[\s\S]*Get-AutoReplyVisualCurrentTransitionSnapshot \$hWnd \(\[int\]\$process\.Id\) \$windowRect \$allowedSet \$sidebarRight \$currentName/u, "a changed bubble must remain stable across a second frame before becoming a candidate");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /Resolve-AutoReplyVisualCurrentTransition \$previousPreviewSignature \$previousMessageSignature \$firstCurrentSnapshot \$secondCurrentSnapshot/u);
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /reason = "current_visual_drift_consumed"/u, "sidebar-only drift must never consume the authoritative message boundary");
assert.doesNotMatch(visualDriverSource, /current_visual_drift_consumed/u, "the JS adapter must not advance either baseline for a legacy sidebar-drift result");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /reason = "current_transition_unresolved"/u);
assert.match(visualDriverSource, /result\?\.reason === "wechat_focus_failed"[\s\S]*result\?\.reason === "chat_boundary_unresolved"[\s\S]*result\?\.reason === "latest_message_role_unresolved"[\s\S]*result\?\.reason === "current_transition_unresolved"[\s\S]*result\?\.reason === "current_outgoing_settling"\) return result;[\s\S]*return takeRetry/u, "focus loss, unresolved role or boundary, and unstable transitions must fence older retry candidates");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$latest\.latestRole -ceq "assistant"[\s\S]*reason = "latest_message_not_incoming"[\s\S]*\$latest\.latestRole -cne "user"[\s\S]*reason = "latest_message_role_unresolved"/u, "unknown role must fail closed instead of advancing an outgoing boundary");
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /Get-AutoReplyVisualSha256 \(\[string\]\$currentMessage\.message\)/u, "missing sidebar evidence must not be synthesized from the drifting bubble OCR");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /draft = \[bool\]\$isDraft/u, "draft-marked sidebar previews must be baselined but never become customer messages");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$currentPreviewSignature = if \(\$currentRow\.Count -eq 1\) \{ \[string\]\$currentRow\[0\]\.signature \} else \{ "" \}/u, "sidebar preview remains optional diagnostic metadata for an open conversation");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$red -ge 235[\s\S]*\$green -ge 50[\s\S]*\$ratio -le 1\.75 -and \$density -ge 0\.25/u);
assert.doesNotMatch(AUTO_REPLY_VISUAL_SCRIPT, /SendKeys|Set-Clipboard|Get-Clipboard/iu);
assert.ok(
  AUTO_REPLY_VISUAL_SCRIPT.indexOf('if ($mode -eq "prime")') < AUTO_REPLY_VISUAL_SCRIPT.indexOf("$candidates = New-Object"),
  "prime must succeed before candidate selection, including when no allowed rows are visible"
);

const normalizationStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Normalize-AutoReplyVisualText");
const normalizationEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Get-AutoReplyVisualSha256", normalizationStart);
assert.ok(normalizationStart >= 0 && normalizationEnd > normalizationStart);
const normalizationFunction = AUTO_REPLY_VISUAL_SCRIPT.slice(normalizationStart, normalizationEnd);
const refinedResolverStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Resolve-AutoReplyVisualRefinedBubbleText");
const refinedResolverEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Get-AutoReplyVisualRefinedBubbleText", refinedResolverStart);
assert.ok(refinedResolverStart >= 0 && refinedResolverEnd > refinedResolverStart);
const refinedResolverFunction = AUTO_REPLY_VISUAL_SCRIPT.slice(refinedResolverStart, refinedResolverEnd);
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /Get-MomentsScaledOcrObservation \$frame \$bubbleRect 3/u, "message content must be re-read from a tight 3x bubble crop");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$rawMessage = Normalize-AutoReplyVisualText[\s\S]*\$refinedMessage = if[\s\S]*Get-AutoReplyVisualRefinedBubbleText[\s\S]*\$message = \[string\]\$refinedMessage\.message/u, "full-window OCR may locate a bubble but must not remain the final message text");
const allowedResolutionStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Resolve-AutoReplyVisualAllowedConversation");
const allowedResolutionEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Scale-AutoReplyVisualMetric", allowedResolutionStart);
assert.ok(allowedResolutionStart >= 0 && allowedResolutionEnd > allowedResolutionStart);
const allowedResolutionFunction = AUTO_REPLY_VISUAL_SCRIPT.slice(allowedResolutionStart, allowedResolutionEnd);
assert.match(normalizationFunction, /Replace\(\$normalized, "\\s\+", ""\)/u, "OCR whitespace must use a single PowerShell regex backslash");
assert.doesNotMatch(normalizationFunction, /"\\\\s\+"/u, "a double regex backslash would preserve OCR-inserted spaces");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /function Resolve-AutoReplyVisualSidebarConversation[\s\S]*\$fuzzyMatches\.Count -eq 1[\s\S]*ambiguous = \$fuzzyMatches\.Count -gt 1/u, "one physical OCR row must be ambiguous when it fuzzily matches multiple allowlisted contacts");
assert.match(allowedResolutionFunction, /\$bestMatches\.Count -eq 1[\s\S]*nearest = \$true/u, "header OCR drift may pass only when one allowlisted contact is uniquely nearest");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /\$resolvedName\.ambiguous[\s\S]*reason = "visual_sidebar_match_ambiguous"/u, "ambiguous physical rows must never become logical contact candidates");

const conversationFunctionsStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Get-AutoReplyVisualEditDistance");
const conversationFunctionsEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Test-AutoReplyVisualMessageMatch", conversationFunctionsStart);
const sidebarResolverStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Test-AutoReplyVisualTimeText");
const sidebarResolverEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Test-AutoReplyVisualRedPixel", sidebarResolverStart);
assert.ok(conversationFunctionsStart >= 0 && conversationFunctionsEnd > conversationFunctionsStart && sidebarResolverStart >= 0 && sidebarResolverEnd > sidebarResolverStart);
const similarContactProgram = `
${normalizationFunction.slice(0, normalizationFunction.indexOf("function Get-AutoReplyVisualEditDistance"))}
${AUTO_REPLY_VISUAL_SCRIPT.slice(conversationFunctionsStart, conversationFunctionsEnd)}
${AUTO_REPLY_VISUAL_SCRIPT.slice(sidebarResolverStart, sidebarResolverEnd)}
$allowed = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
[void]$allowed.Add("A1ZZ")
[void]$allowed.Add("A2ZZ")
$ambiguous = Resolve-AutoReplyVisualSidebarConversation "A3ZZ" $allowed
$exact = Resolve-AutoReplyVisualSidebarConversation "A1ZZ" $allowed
@{
  ambiguous = [bool]$ambiguous.ambiguous
  ambiguousOk = [bool]$ambiguous.ok
  exact = [string]$exact.conversation
  exactOk = [bool]$exact.ok
} | ConvertTo-Json -Compress
`;
const similarContactProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(similarContactProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(similarContactProbe.status, 0, similarContactProbe.stderr || similarContactProbe.stdout);
assert.deepEqual(JSON.parse(similarContactProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  ambiguous: true,
  ambiguousOk: false,
  exact: "A1ZZ",
  exactOk: true
});

const semanticSeedStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("$semanticSeed =");
const semanticSeedEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("$diagnosticSeed =", semanticSeedStart);
assert.ok(semanticSeedStart >= 0 && semanticSeedEnd > semanticSeedStart);
const semanticSeedBlock = AUTO_REPLY_VISUAL_SCRIPT.slice(semanticSeedStart, semanticSeedEnd);
assert.match(semanticSeedBlock, /visual-message-semantic-v1[\s\S]*\$message[\s\S]*\$latestRole/u, "message identity must use only normalized bubble text and role");
assert.doesNotMatch(semanticSeedBlock, /\$pixelHash|bubbleWidthBucket|bubbleHeightBucket|viewportHash|bounds\.left|bounds\.top/u, "DPI, pixels, geometry and viewport movement must not churn identity");
const diagnosticSeedStart = semanticSeedEnd;
const diagnosticSeedEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("return @{", diagnosticSeedStart);
const diagnosticSeedBlock = AUTO_REPLY_VISUAL_SCRIPT.slice(diagnosticSeedStart, diagnosticSeedEnd);
assert.match(diagnosticSeedBlock, /\$bubbleWidthBucket[\s\S]*\$bubbleHeightBucket[\s\S]*\$pixelHash/u, "shape and pixel evidence may remain diagnostic-only");

const sidebarStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Get-AutoReplyVisualSidebarRight");
const sidebarEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Get-AutoReplyVisualFrame", sidebarStart);
assert.ok(sidebarStart >= 0 && sidebarEnd > sidebarStart);
assert.doesNotMatch(autoReplyEntry, /Test-AutoReplyVisualViewportOwned/u, "the active auto-reply path must not require all nine viewport points to be unobscured");
assert.match(AUTO_REPLY_VISUAL_SCRIPT, /function Test-AutoReplyVisualPointOwned/u, "conversation clicks must still verify the owned action point");
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
const unreadRedEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Test-AutoReplyVisualGreenPixel", unreadStart);
const unreadDotStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Test-AutoReplyVisualUnreadDot", unreadRedEnd);
const unreadPreviewStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Get-AutoReplyVisualUnreadRowPreview", unreadDotStart);
const badgeRemainsStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Test-AutoReplyVisualBadgeRemains", unreadPreviewStart);
const unreadEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Test-AutoReplyVisualSelectedSidebarRow", unreadDotStart);
assert.ok(unreadStart >= 0 && unreadRedEnd > unreadStart && unreadDotStart > unreadRedEnd
  && unreadPreviewStart > unreadDotStart && badgeRemainsStart > unreadPreviewStart && unreadEnd > badgeRemainsStart);
const unreadFunctions = AUTO_REPLY_VISUAL_SCRIPT.slice(unreadStart, unreadRedEnd)
  + AUTO_REPLY_VISUAL_SCRIPT.slice(unreadDotStart, unreadPreviewStart)
  + AUTO_REPLY_VISUAL_SCRIPT.slice(badgeRemainsStart, unreadEnd);
const scaleStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Scale-AutoReplyVisualMetric");
const scaleEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Test-AutoReplyVisualTimeText", scaleStart);
assert.ok(scaleStart >= 0 && scaleEnd > scaleStart);
const scaleFunction = AUTO_REPLY_VISUAL_SCRIPT.slice(scaleStart, scaleEnd);
const roleStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Test-AutoReplyVisualGreenPixel");
const roleCoreEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Get-AutoReplyVisualRowStats", roleStart);
const roleEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Test-AutoReplyVisualUnreadDot", roleStart);
assert.ok(roleStart >= 0 && roleCoreEnd > roleStart && roleEnd > roleCoreEnd);
const roleCoreFunctions = AUTO_REPLY_VISUAL_SCRIPT.slice(roleStart, roleCoreEnd);
const roleFunctions = AUTO_REPLY_VISUAL_SCRIPT.slice(roleStart, roleEnd);
const roleProgram = `
${scaleFunction}
${roleFunctions}
$script:AutoReplyVisualScale = 1.0
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
function New-RoleLine([double]$left, [double]$top, [double]$width, [double]$height) {
  return [pscustomobject]@{ bounds = @{ left = $left; top = $top; width = $width; height = $height } }
}
$sidebar = 300.0
$outgoingFrame = New-RoleFrame
$outgoingLine = New-RoleLine 360 300 580 22
$outgoingRect = @{ left = 348; top = 292; width = 604; height = 38 }
Set-RoleGreenRect $outgoingFrame 348 292 604 38
$plainFrame = New-RoleFrame
@{
  longGreenOutgoing = Get-AutoReplyVisualMessageRole $outgoingFrame $outgoingLine $sidebar $outgoingRect
  leftIncoming = Get-AutoReplyVisualMessageRole $plainFrame (New-RoleLine 320 300 350 22) $sidebar @{ left = 308; top = 292; width = 374; height = 38 }
  middleAmbiguous = Get-AutoReplyVisualMessageRole $plainFrame (New-RoleLine 520 300 180 22) $sidebar @{ left = 508; top = 292; width = 204; height = 38 }
  rightOutgoingFallback = Get-AutoReplyVisualMessageRole $plainFrame (New-RoleLine 700 300 285 22) $sidebar @{ left = 688; top = 292; width = 309; height = 38 }
} | ConvertTo-Json -Compress
`;
const roleProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(roleProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(roleProbe.status, 0, roleProbe.stderr || roleProbe.stdout);
assert.deepEqual(JSON.parse(roleProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  leftIncoming: "user",
  longGreenOutgoing: "assistant",
  middleAmbiguous: "unknown",
  rightOutgoingFallback: "assistant"
});
const chatBoundaryProgram = `
${scaleFunction}
${roleFunctions}
$script:AutoReplyVisualScale = 1.0
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
function Set-ChatDivider($frame, [int]$y, [byte]$value, [int]$left = 0, [int]$right = -1) {
  if ($right -lt 0) { $right = $frame.width }
  for ($x = [Math]::Max(0, $left); $x -lt [Math]::Min($frame.width, $right); $x++) {
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
$script:AutoReplyVisualScale = 0.8
$dividerFrame = New-ChatFrame 867 554 250
# A very wide bubble edge can look divider-like above the real composer. The
# lowest full-width 247-luminance separator must win at the live geometry.
Set-ChatDivider $dividerFrame 350 230 310 900
Set-ChatDivider $dividerFrame 411 247
Set-ChatDraftText $dividerFrame 430
$tallComposerFrame = New-ChatFrame 867 554 250
Set-ChatDivider $tallComposerFrame 350 247
$noDividerFrame = New-ChatFrame 867 554 250
$physicalFrame = New-ChatFrame 1081 690 250
Set-ChatDivider $physicalFrame 513 247
$detected = Get-AutoReplyVisualChatBottom $dividerFrame 300.0
$tallDetected = Get-AutoReplyVisualChatBottom $tallComposerFrame 300.0
$unresolved = Get-AutoReplyVisualChatBottom $noDividerFrame 300.0
$script:AutoReplyVisualScale = 1.0
$physicalDetected = Get-AutoReplyVisualChatBottom $physicalFrame 375.0
@{
  detectedOk = [bool]$detected.ok
  detectedBottom = [double]$detected.bottom
  detectedDivider = [double]$detected.dividerY
  detectedSource = [string]$detected.source
  tallBottom = [double]$tallDetected.bottom
  unresolvedOk = [bool]$unresolved.ok
  unresolvedReason = [string]$unresolved.reason
  unresolvedBottom = [double]$unresolved.bottom
  unresolvedSource = [string]$unresolved.source
  physicalBottom = [double]$physicalDetected.bottom
  physicalDivider = [double]$physicalDetected.dividerY
  includesLiveMessage = [bool](365 -le [double]$detected.bottom)
  excludesComposerDraft = [bool](430 -gt [double]$detected.bottom)
} | ConvertTo-Json -Compress
`;
const chatBoundaryProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(chatBoundaryProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(chatBoundaryProbe.status, 0, chatBoundaryProbe.stderr || chatBoundaryProbe.stdout);
const chatBoundaryResult = JSON.parse(chatBoundaryProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1));
assert.equal(chatBoundaryResult.detectedOk, true);
assert.equal(chatBoundaryResult.detectedDivider, 411, "the lowest proven divider must beat a wide bubble edge");
assert.equal(chatBoundaryResult.detectedBottom, 409);
assert.equal(chatBoundaryResult.detectedSource, "composer_divider");
assert.equal(chatBoundaryResult.tallBottom, 348, "a manually enlarged composer must still be detected");
assert.equal(chatBoundaryResult.unresolvedOk, true);
assert.equal(chatBoundaryResult.unresolvedSource, "normalized_window_ratio");
assert.ok(Math.abs(chatBoundaryResult.unresolvedBottom - (554 * 0.74)) < 0.01, "theme-independent fallback must be tied to normalized window geometry");
assert.equal(chatBoundaryResult.physicalDivider, 513, "the original 1081x690 frame divider must be structurally detected");
assert.equal(chatBoundaryResult.physicalBottom, 511);
assert.equal(chatBoundaryResult.includesLiveMessage, true, "the live bottom incoming row must remain inside the proven chat viewport");
assert.equal(chatBoundaryResult.excludesComposerDraft, true);

const messageAggregationStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Get-AutoReplyVisualBubbleRect");
const latestEvidenceStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Get-AutoReplyVisualLatestMessageEvidence", messageAggregationStart);
const latestEvidenceEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Get-AutoReplyVisualLatestIncoming", latestEvidenceStart);
assert.ok(messageAggregationStart >= 0 && latestEvidenceStart > messageAggregationStart && latestEvidenceEnd > latestEvidenceStart);
const messageAggregationFunctions = AUTO_REPLY_VISUAL_SCRIPT.slice(messageAggregationStart, latestEvidenceStart);
const latestEvidenceFunction = AUTO_REPLY_VISUAL_SCRIPT.slice(latestEvidenceStart, latestEvidenceEnd);
const pureTextStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Test-AutoReplyVisualTimeText");
const pureTextEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Get-AutoReplyVisualLines", pureTextStart);
assert.ok(pureTextStart >= 0 && pureTextEnd > pureTextStart);
const pureTextFunctions = AUTO_REPLY_VISUAL_SCRIPT.slice(pureTextStart, pureTextEnd);
const latestEvidenceProgram = `
${scaleFunction}
${latestEvidenceFunction}
${pureTextFunctions}
$script:AutoReplyVisualScale = 0.8
function Normalize-AutoReplyVisualText([string]$value) { return $value }
function Get-AutoReplyVisualSha256([string]$value) { return ("a" * 64) }
function Get-MomentsPixelHash($frame, $rect) { return ("b" * 64) }
function Get-AutoReplyVisualMessageBlocks($frame, $messageLines, [double]$sidebarRight) { return @($messageLines) }
function Get-AutoReplyVisualBubbleRect($frame, $line, [double]$sidebarRight) { return @{ left = 0; top = 0; width = 10; height = 10 } }
function Get-AutoReplyVisualMessageRole($frame, $line, [double]$sidebarRight, $bubbleRect) { return "user" }
function Get-AutoReplyVisualRefinedBubbleText($frame, $bubbleRect, [string]$rawText) { return @{ message = $rawText; source = "fixture"; refined = $rawText } }
function Get-AutoReplyVisualChatBottom($frame, [double]$sidebarRight) {
  if (-not $script:EvidenceBoundaryOk) { return @{ ok = $false; reason = "chat_boundary_unresolved"; source = "none" } }
  return @{ ok = $true; bottom = [double]$script:EvidenceBottom; source = "test_divider" }
}
function New-EvidenceFrame([int]$width, [int]$height) { return @{ width = $width; height = $height; stride = ($width * 4); bytes = @() } }
function New-EvidenceLine([string]$text, [double]$left, [double]$top, [double]$width = 180.0, [double]$height = 22.0) {
  return [pscustomobject]@{ compact = $text; bounds = @{ left = $left; top = $top; width = $width; height = $height } }
}
$script:EvidenceBoundaryOk = $true
$script:EvidenceBottom = 409.0
$normalizedFrame = New-EvidenceFrame 867 554
$lines = @(
  (New-EvidenceLine "live-message" 330 365),
  (New-EvidenceLine "typed-draft" 330 430),
  (New-EvidenceLine "11:25" 700 390 60 18)
)
$proven = Get-AutoReplyVisualLatestMessageEvidence $normalizedFrame $lines 300.0
$script:EvidenceBoundaryOk = $false
$unresolved = Get-AutoReplyVisualLatestMessageEvidence $normalizedFrame $lines 300.0
@{
  provenOk = [bool]$proven.ok
  provenMessage = [string]$proven.message
  provenTop = [double]$proven.line.bounds.top
  unresolvedOk = [bool]$unresolved.ok
  unresolvedReason = [string]$unresolved.reason
  unresolvedHasEvidence = [bool]$unresolved.ContainsKey("evidenceSignature")
} | ConvertTo-Json -Compress
`;
const latestEvidenceProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(latestEvidenceProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(latestEvidenceProbe.status, 0, latestEvidenceProbe.stderr || latestEvidenceProbe.stdout);
assert.deepEqual(JSON.parse(latestEvidenceProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  provenMessage: "live-message",
  provenOk: true,
  provenTop: 365,
  unresolvedHasEvidence: false,
  unresolvedOk: false,
  unresolvedReason: "chat_boundary_unresolved"
}, "a composer draft must stay excluded and an unproven frame must emit no message evidence");

const messageAggregationProgram = `
${scaleFunction}
${roleCoreFunctions}
${messageAggregationFunctions}
$script:AutoReplyVisualScale = 1.0
function Normalize-AutoReplyVisualText([string]$value) { return $value }
function New-AggregationLine([string]$text, [double]$left, [double]$top, [double]$width, [double]$height = 22.0) {
  return [pscustomobject]@{ compact = $text; bounds = @{ left = $left; top = $top; width = $width; height = $height } }
}
$frame = @{ width = 1081; height = 690; stride = 4324; bytes = (New-Object byte[] (4324 * 690)) }
$physicalBlocks = @(Get-AutoReplyVisualMessageBlocks $frame @(
  (New-AggregationLine "本机回归0722-2" 487 466 128),
  (New-AggregationLine "洗地机日常维护需要注意什么?" 633 466 236)
) 375.0)
$physical = $physicalBlocks[-1]
$physicalRole = Get-AutoReplyVisualMessageRole $frame $physical 375.0 (Get-AutoReplyVisualBubbleRect $frame $physical 375.0)
$multiBlocks = @(Get-AutoReplyVisualMessageBlocks $frame @(
  (New-AggregationLine "多行第一段" 487 400 300),
  (New-AggregationLine "多行第二段" 500 430 270)
) 375.0)
$separateBlocks = @(Get-AutoReplyVisualMessageBlocks $frame @(
  (New-AggregationLine "上一条消息" 487 390 220),
  (New-AggregationLine "最新一条消息" 487 445 220)
) 375.0)
@{
  physicalBlockCount = $physicalBlocks.Count
  physicalMessage = [string]$physical.compact
  physicalRole = [string]$physicalRole
  physicalLeft = [double]$physical.bounds.left
  physicalWidth = [double]$physical.bounds.width
  physicalPartCount = [int]$physical.partCount
  multiBlockCount = $multiBlocks.Count
  multiLineMessage = [string]$multiBlocks[-1].compact
  multiLineHeight = [double]$multiBlocks[-1].bounds.height
  separateBlockCount = $separateBlocks.Count
  separateLatest = [string]$separateBlocks[-1].compact
} | ConvertTo-Json -Compress
`;
const messageAggregationProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(messageAggregationProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(messageAggregationProbe.status, 0, messageAggregationProbe.stderr || messageAggregationProbe.stdout);
assert.deepEqual(JSON.parse(messageAggregationProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  multiBlockCount: 1,
  multiLineHeight: 52,
  multiLineMessage: "多行第一段多行第二段",
  physicalBlockCount: 1,
  physicalLeft: 487,
  physicalMessage: "本机回归0722-2洗地机日常维护需要注意什么?",
  physicalPartCount: 2,
  physicalRole: "user",
  physicalWidth: 382,
  separateBlockCount: 2,
  separateLatest: "最新一条消息"
}, "OCR fragments may merge only within one conservative bubble block");

const unknownIncomingStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Get-AutoReplyVisualLatestIncoming");
const unknownIncomingEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Test-AutoReplyVisualStableIncomingEvidence", unknownIncomingStart);
assert.ok(unknownIncomingStart >= 0 && unknownIncomingEnd > unknownIncomingStart);
const unknownIncomingProgram = `
${AUTO_REPLY_VISUAL_SCRIPT.slice(unknownIncomingStart, unknownIncomingEnd)}
function Normalize-AutoReplyVisualText([string]$value) { return $value }
function Get-AutoReplyVisualLatestMessageEvidence($frame, $lines, [double]$sidebarRight) {
  return @{ ok = $true; hasMessage = $true; message = "fragment"; latestRole = "unknown"; pixelHash = "p"; evidenceSignature = ("a" * 64); line = @{ bounds = @{} } }
}
Get-AutoReplyVisualLatestIncoming @{} @() "fragment" 375.0 | ConvertTo-Json -Compress
`;
const unknownIncomingProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(unknownIncomingProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(unknownIncomingProbe.status, 0, unknownIncomingProbe.stderr || unknownIncomingProbe.stdout);
assert.deepEqual(JSON.parse(unknownIncomingProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  evidenceSignature: "a".repeat(64),
  latestRole: "unknown",
  line: { bounds: {} },
  message: "fragment",
  ok: false,
  pixelHash: "p",
  reason: "latest_message_role_unresolved"
});
const unreadProgram = `
${scaleFunction}
${unreadFunctions}
function New-TestFrame([double]$scale) {
  $width = [int][Math]::Round(160 * $scale); $height = [int][Math]::Round(160 * $scale); $stride = $width * 4
  return @{ width = $width; height = $height; stride = $stride; bytes = (New-Object byte[] ($stride * $height)) }
}
function Set-TestRedRect($frame, [int]$left, [int]$top, [int]$width, [int]$height, [int]$red = 249, [int]$green = 81, [int]$blue = 81) {
  for ($y = $top; $y -lt ($top + $height); $y++) {
    for ($x = $left; $x -lt ($left + $width); $x++) {
      $offset = ($y * $frame.stride) + ($x * 4)
      $frame.bytes[$offset] = $blue
      $frame.bytes[$offset + 1] = $green
      $frame.bytes[$offset + 2] = $red
      $frame.bytes[$offset + 3] = 255
    }
  }
}
function Test-UnreadAtScale([double]$scale) {
  $script:AutoReplyVisualScale = $scale
  $nameBounds = @{ left = 90.0 * $scale; top = 40.0 * $scale; width = 56.0 * $scale; height = 18.0 * $scale }
  $redAvatar = New-TestFrame $scale
  Set-TestRedRect $redAvatar ([int][Math]::Round(62 * $scale)) ([int][Math]::Round(40 * $scale)) ([int][Math]::Round(11 * $scale)) ([int][Math]::Round(11 * $scale)) 218 40 28
  $realBadge = New-TestFrame $scale
  Set-TestRedRect $realBadge ([int][Math]::Round(72 * $scale)) ([int][Math]::Round(26 * $scale)) ([int][Math]::Round(11 * $scale)) ([int][Math]::Round(11 * $scale))
  $alignedBadge = New-TestFrame $scale
  Set-TestRedRect $alignedBadge ([int][Math]::Round(72 * $scale)) ([int][Math]::Round(38 * $scale)) ([int][Math]::Round(11 * $scale)) ([int][Math]::Round(11 * $scale))
  $globalBadge = New-TestFrame $scale
  Set-TestRedRect $globalBadge ([int][Math]::Round(72 * $scale)) ([int][Math]::Round(75 * $scale)) ([int][Math]::Round(11 * $scale)) ([int][Math]::Round(11 * $scale))
  return @{
    redAvatar = [bool](Test-AutoReplyVisualUnreadDot $redAvatar $nameBounds)
    realBadge = [bool](Test-AutoReplyVisualUnreadDot $realBadge $nameBounds)
    alignedBadge = [bool](Test-AutoReplyVisualUnreadDot $alignedBadge $nameBounds)
    globalRedAvatarCount = @(Get-AutoReplyVisualUnreadBadges $redAvatar (300 * $scale)).Count
    globalBadgeCount = @(Get-AutoReplyVisualUnreadBadges $globalBadge (300 * $scale)).Count
    badgeRemains = [bool](Test-AutoReplyVisualBadgeRemains $realBadge @{ left = 72 * $scale; top = 26 * $scale; width = 11 * $scale; height = 11 * $scale })
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
  dpi96: { alignedBadge: true, realBadge: true, redAvatar: false, globalRedAvatarCount: 0, globalBadgeCount: 1, badgeRemains: true },
  dpi120: { alignedBadge: true, realBadge: true, redAvatar: false, globalRedAvatarCount: 0, globalBadgeCount: 1, badgeRemains: true },
  dpi144: { alignedBadge: true, realBadge: true, redAvatar: false, globalRedAvatarCount: 0, globalBadgeCount: 1, badgeRemains: true }
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

const conversationMatchProgram = `
${normalizationFunction}
${allowedResolutionFunction}
$singleAllowed = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
[void]$singleAllowed.Add(("A" + [char]27979 + [char]35797 + [char]23458 + [char]25143))
$nearest = Resolve-AutoReplyVisualAllowedConversation ("A" + [char]27979 + [char]35797 + [char]23458 + [char]23608) $singleAllowed
$ambiguousAllowed = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
[void]$ambiguousAllowed.Add(("A" + [char]27979 + [char]35797 + [char]23458 + [char]25143))
[void]$ambiguousAllowed.Add(("B" + [char]27979 + [char]35797 + [char]23458 + [char]25143))
$ambiguous = Resolve-AutoReplyVisualAllowedConversation ("C" + [char]27979 + [char]35797 + [char]23458 + [char]25143) $ambiguousAllowed
@{
  drift = Test-AutoReplyVisualConversationMatch ("A" + [char]27979 + [char]35797 + [char]23458 + [char]25143) ("A" + [char]27701 + [char]21017 + [char]35797 + [char]23458 + [char]25143)
  unrelated = Test-AutoReplyVisualConversationMatch ("A" + [char]27979 + [char]35797 + [char]23458 + [char]25143) ("B" + [char]27979 + [char]35797 + [char]23458 + [char]25143)
  nearest = [bool]$nearest.ok
  nearestName = [string]$nearest.conversation
  ambiguous = [bool]$ambiguous.ambiguous
} | ConvertTo-Json -Compress
`;
const conversationMatchProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(conversationMatchProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(conversationMatchProbe.status, 0, conversationMatchProbe.stderr || conversationMatchProbe.stdout);
assert.deepEqual(JSON.parse(conversationMatchProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  ambiguous: true,
  drift: true,
  nearest: true,
  nearestName: "A测试客户",
  unrelated: false
});

const messageTextProgram = `
${normalizationFunction}
${refinedResolverFunction}
$prefix = ([string][char]25105) + [char]26469 + [char]21672 + [char]35810 + [char]19968 + [char]19979
$suffix = ([string][char]35774) + [char]22791 + [char]30340
$preview = $prefix + [char]28165 + [char]27905 + $suffix
$bubble = $prefix + [char]23578 + [char]21513 + $suffix
$shortPrefix = ([string][char]25105) + [char]38656 + [char]35201
$correctShort = $shortPrefix + [char]28165 + [char]27905 + [char]35774 + [char]22791
$wrongShort = $shortPrefix + [char]23578 + [char]21513 + [char]35774 + [char]22791
$partialShort = $shortPrefix + [char]28165 + [char]27905 + [char]22791
@{
  corrected = Resolve-AutoReplyVisualMessageText $preview $bubble
  truncated = Resolve-AutoReplyVisualMessageText ($prefix + [char]28165 + [char]27905 + "...") $bubble
  unrelated = Resolve-AutoReplyVisualMessageText $preview ($prefix + [char]24037 + [char]19994 + [char]21560 + [char]23576 + [char]22120)
  refinedExact = (Resolve-AutoReplyVisualRefinedBubbleText $wrongShort $correctShort) -ceq $correctShort
  refinedPartialRejected = (Resolve-AutoReplyVisualRefinedBubbleText $wrongShort $partialShort) -ceq $wrongShort
} | ConvertTo-Json -Compress
`;
const messageTextProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(messageTextProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(messageTextProbe.status, 0, messageTextProbe.stderr || messageTextProbe.stdout);
assert.deepEqual(JSON.parse(messageTextProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  corrected: "我来咨询一下清洁设备的",
  refinedExact: true,
  refinedPartialRejected: true,
  truncated: "我来咨询一下尚吉设备的",
  unrelated: "我来咨询一下工业吸尘器"
});

const parserCommand = "$source=[Console]::In.ReadToEnd(); $tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors); if($errors.Count){$errors | ForEach-Object {$_.ToString()}; exit 1}";
const syntaxProbe = spawnSync("powershell.exe", ["-NoProfile", "-Command", parserCommand], {
  input: AUTO_REPLY_VISUAL_SCRIPT,
  encoding: "utf8"
});
assert.equal(syntaxProbe.status, 0, syntaxProbe.stderr || syntaxProbe.stdout);

const latestIncomingStart = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Get-AutoReplyVisualLatestIncoming");
const latestIncomingEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Test-AutoReplyVisualStableIncomingEvidence", latestIncomingStart);
assert.ok(latestIncomingStart >= 0 && latestIncomingEnd > latestIncomingStart);
const latestIncomingFunction = AUTO_REPLY_VISUAL_SCRIPT.slice(latestIncomingStart, latestIncomingEnd);
assert.ok(
  latestIncomingFunction.indexOf('[string]$latest.latestRole -cne "user"')
    < latestIncomingFunction.indexOf('reason = "unread_preview_mismatch"'),
  "an assistant/unknown latest bubble must be rejected before comparing OCR preview text"
);

const stableIncomingStart = latestIncomingEnd;
const stableIncomingEnd = AUTO_REPLY_VISUAL_SCRIPT.indexOf("function Get-AutoReplyVisualObservation", stableIncomingStart);
assert.ok(stableIncomingEnd > stableIncomingStart);
const stableIncomingFunction = AUTO_REPLY_VISUAL_SCRIPT.slice(stableIncomingStart, stableIncomingEnd);
const stableSignature = "a".repeat(64);
const changedStableSignature = "b".repeat(64);
const stableIncomingProgram = `
${normalizationFunction}
${stableIncomingFunction}
$sameFirst = [pscustomobject]@{ hasMessage = $true; latestRole = "user"; message = "咨询清洁设备"; evidenceSignature = "${stableSignature}" }
$sameSecond = [pscustomobject]@{ hasMessage = $true; latestRole = "user"; message = "咨询清洁设备"; evidenceSignature = "${stableSignature}" }
$driftedSecond = [pscustomobject]@{ hasMessage = $true; latestRole = "user"; message = "咨询尚洁设备"; evidenceSignature = "${changedStableSignature}" }
$changedSecond = [pscustomobject]@{ hasMessage = $true; latestRole = "user"; message = "完全不同问题"; evidenceSignature = "${changedStableSignature}" }
@{
  sameEvidence = [bool](Test-AutoReplyVisualStableIncomingEvidence $sameFirst $sameSecond)
  driftedEvidence = [bool](Test-AutoReplyVisualStableIncomingEvidence $sameFirst $driftedSecond)
  changedEvidence = [bool](Test-AutoReplyVisualStableIncomingEvidence $sameFirst $changedSecond)
} | ConvertTo-Json -Compress
`;
const stableIncomingProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(stableIncomingProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(stableIncomingProbe.status, 0, stableIncomingProbe.stderr || stableIncomingProbe.stdout);
assert.deepEqual(JSON.parse(stableIncomingProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  changedEvidence: false,
  driftedEvidence: true,
  sameEvidence: true
});

const boundRuntime = `visual:v1:${"c".repeat(64)}`;
const driftedRuntime = `visual:v1:${"d".repeat(64)}`;
const boundIncomingProgram = `
${normalizationFunction}
${stableIncomingFunction}
@{
  exactBubble = [bool](Test-AutoReplyVisualBoundIncomingEvidence "${boundRuntime}" "${stableSignature}" "${boundRuntime}" "${stableSignature}" 0)
  reconciledSidebar = [bool](Test-AutoReplyVisualBoundIncomingEvidence "${driftedRuntime}" "${changedStableSignature}" "${boundRuntime}" "${stableSignature}" 1)
  changedSidebar = [bool](Test-AutoReplyVisualBoundIncomingEvidence "${driftedRuntime}" "${changedStableSignature}" "${boundRuntime}" "${stableSignature}" 0)
  ambiguousSidebar = [bool](Test-AutoReplyVisualBoundIncomingEvidence "${driftedRuntime}" "${changedStableSignature}" "${boundRuntime}" "${stableSignature}" 2)
  invalidBinding = [bool](Test-AutoReplyVisualBoundIncomingEvidence "${driftedRuntime}" "${changedStableSignature}" "bad" "${stableSignature}" 1)
} | ConvertTo-Json -Compress
`;
const boundIncomingProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(boundIncomingProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(boundIncomingProbe.status, 0, boundIncomingProbe.stderr || boundIncomingProbe.stdout);
assert.deepEqual(JSON.parse(boundIncomingProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  ambiguousSidebar: false,
  changedSidebar: false,
  exactBubble: true,
  invalidBinding: false,
  reconciledSidebar: true
});

const previewBeforeTransition = "1".repeat(64);
const previewAfterTransition = "2".repeat(64);
const messageBeforeTransition = "3".repeat(64);
const messageAfterTransition = "4".repeat(64);
const currentTransitionProgram = `
${stableIncomingFunction}
@{
  bothChanged = [bool](Test-AutoReplyVisualCurrentMessageTransition "${previewBeforeTransition}" "${previewAfterTransition}" "${messageBeforeTransition}" "${messageAfterTransition}")
  bubbleOnly = [bool](Test-AutoReplyVisualCurrentMessageTransition "${previewBeforeTransition}" "${previewBeforeTransition}" "${messageBeforeTransition}" "${messageAfterTransition}")
  previewOnly = [bool](Test-AutoReplyVisualCurrentMessageTransition "${previewBeforeTransition}" "${previewAfterTransition}" "${messageBeforeTransition}" "${messageBeforeTransition}")
  missingPreview = [bool](Test-AutoReplyVisualCurrentMessageTransition "" "${previewAfterTransition}" "${messageBeforeTransition}" "${messageAfterTransition}")
} | ConvertTo-Json -Compress
`;
const currentTransitionProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(currentTransitionProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(currentTransitionProbe.status, 0, currentTransitionProbe.stderr || currentTransitionProbe.stdout);
assert.deepEqual(JSON.parse(currentTransitionProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  bothChanged: true,
  bubbleOnly: true,
  missingPreview: true,
  previewOnly: false
});

const previewLaterTransition = "5".repeat(64);
const messageLaterTransition = "6".repeat(64);
const atomicTransitionProgram = `
${stableIncomingFunction}
function New-CurrentSnapshot([string]$preview, [string]$message, [bool]$draft = $false, [string]$role = "user") {
  return [pscustomobject]@{
    ok = $true
    conversation = "A"
    previewSignature = $preview
    messageSignature = $message
    draft = $draft
    hasMessage = $true
    latestRole = $role
    message = "hello"
  }
}

# Prime(previewA,bubbleA) -> previewB,bubbleA is presentation-only and must not
# consume anything. A later stable customer bubbleB is the single message
# transition and must become a candidate regardless of preview timing.
$previewBoundary = "${previewBeforeTransition}"
$messageBoundary = "${messageBeforeTransition}"
$clearDraftFirst = New-CurrentSnapshot "${previewAfterTransition}" "${messageBeforeTransition}"
$clearDraftSecond = New-CurrentSnapshot "${previewAfterTransition}" "${messageBeforeTransition}"
$clearDraft = Resolve-AutoReplyVisualCurrentTransition $previewBoundary $messageBoundary $clearDraftFirst $clearDraftSecond
$bubbleDriftFirst = New-CurrentSnapshot "${previewAfterTransition}" "${messageAfterTransition}"
$bubbleDriftSecond = New-CurrentSnapshot "${previewAfterTransition}" "${messageAfterTransition}"
$bubbleDrift = Resolve-AutoReplyVisualCurrentTransition $previewBoundary $messageBoundary $bubbleDriftFirst $bubbleDriftSecond
if ([string]$bubbleDrift.action -eq "candidate") { $messageBoundary = "${messageAfterTransition}" }
$previewAfterCandidateFirst = New-CurrentSnapshot "${previewLaterTransition}" "${messageAfterTransition}"
$previewAfterCandidateSecond = New-CurrentSnapshot "${previewLaterTransition}" "${messageAfterTransition}"
$previewAfterCandidate = Resolve-AutoReplyVisualCurrentTransition $previewBoundary $messageBoundary $previewAfterCandidateFirst $previewAfterCandidateSecond

# Reverse ordering: the bubble is still a candidate immediately; once its
# authoritative boundary is recorded, a later preview change is a no-op.
$reversePreviewBoundary = "${previewBeforeTransition}"
$reverseMessageBoundary = "${messageBeforeTransition}"
$reverseBubbleFirst = New-CurrentSnapshot "${previewBeforeTransition}" "${messageAfterTransition}"
$reverseBubbleSecond = New-CurrentSnapshot "${previewBeforeTransition}" "${messageAfterTransition}"
$reverseBubble = Resolve-AutoReplyVisualCurrentTransition $reversePreviewBoundary $reverseMessageBoundary $reverseBubbleFirst $reverseBubbleSecond
if ([string]$reverseBubble.action -eq "candidate") { $reverseMessageBoundary = "${messageAfterTransition}" }
$reversePreviewFirst = New-CurrentSnapshot "${previewAfterTransition}" "${messageAfterTransition}"
$reversePreviewSecond = New-CurrentSnapshot "${previewAfterTransition}" "${messageAfterTransition}"
$reversePreview = Resolve-AutoReplyVisualCurrentTransition $reversePreviewBoundary $reverseMessageBoundary $reversePreviewFirst $reversePreviewSecond

$genuineFirst = New-CurrentSnapshot "${previewAfterTransition}" "${messageAfterTransition}"
$genuineSecond = New-CurrentSnapshot "${previewAfterTransition}" "${messageAfterTransition}"
$genuine = Resolve-AutoReplyVisualCurrentTransition "${previewBeforeTransition}" "${messageBeforeTransition}" $genuineFirst $genuineSecond
$unstableSecond = New-CurrentSnapshot "${previewLaterTransition}" "${messageLaterTransition}"
$unstable = Resolve-AutoReplyVisualCurrentTransition "${previewBeforeTransition}" "${messageBeforeTransition}" $genuineFirst $unstableSecond
$draftBothFirst = New-CurrentSnapshot "${previewAfterTransition}" "${messageAfterTransition}" $true
$draftBothSecond = New-CurrentSnapshot "${previewAfterTransition}" "${messageAfterTransition}" $true
$draftBoth = Resolve-AutoReplyVisualCurrentTransition "${previewBeforeTransition}" "${messageBeforeTransition}" $draftBothFirst $draftBothSecond

@{
  clearDraftAction = [string]$clearDraft.action
  bubbleDriftAction = [string]$bubbleDrift.action
  previewAfterCandidateAction = [string]$previewAfterCandidate.action
  sequentialCandidateCount = [int](@($clearDraft, $bubbleDrift | Where-Object { [string]$_.action -eq "candidate" }).Count)
  reverseBubbleAction = [string]$reverseBubble.action
  reversePreviewAction = [string]$reversePreview.action
  reverseCandidateCount = [int](@($reverseBubble, $reversePreview | Where-Object { [string]$_.action -eq "candidate" }).Count)
  genuineAction = [string]$genuine.action
  unstableReason = [string]$unstable.reason
  draftBothReason = [string]$draftBoth.reason
} | ConvertTo-Json -Compress
`;
const atomicTransitionProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(atomicTransitionProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(atomicTransitionProbe.status, 0, atomicTransitionProbe.stderr || atomicTransitionProbe.stdout);
assert.deepEqual(JSON.parse(atomicTransitionProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  bubbleDriftAction: "candidate",
  clearDraftAction: "none",
  draftBothReason: "",
  genuineAction: "candidate",
  previewAfterCandidateAction: "none",
  reverseBubbleAction: "candidate",
  reverseCandidateCount: 1,
  reversePreviewAction: "none",
  sequentialCandidateCount: 1,
  unstableReason: "current_transition_unresolved"
});

const outgoingSettlingProgram = `
${stableIncomingFunction}
function New-OutgoingSnapshot([string]$preview, [string]$message) {
  return [pscustomobject]@{
    ok = $true
    conversation = "A"
    previewSignature = $preview
    messageSignature = $message
    draft = $false
    hasMessage = $true
    latestRole = "assistant"
    message = "reply"
  }
}
$first = New-OutgoingSnapshot "${previewAfterTransition}" "${messageAfterTransition}"
$second = New-OutgoingSnapshot "${previewLaterTransition}" "${messageLaterTransition}"
$result = Resolve-AutoReplyVisualCurrentTransition "${previewBeforeTransition}" "${messageBeforeTransition}" $first $second
@{
  action = [string]$result.action
  reason = [string]$result.reason
  hasAdvance = [bool]($result.baselineAdvance -ne $null -or $result.messageBaselineAdvance -ne $null)
} | ConvertTo-Json -Compress
`;
const outgoingSettlingProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(outgoingSettlingProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(outgoingSettlingProbe.status, 0, outgoingSettlingProbe.stderr || outgoingSettlingProbe.stdout);
assert.deepEqual(JSON.parse(outgoingSettlingProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  action: "settle",
  hasAdvance: false,
  reason: "current_outgoing_settling"
});

const mismatchedStableProgram = `
${normalizationFunction}
function Get-AutoReplyVisualLatestMessageEvidence($frame, $lines, [double]$sidebarRight) {
  return @{
    ok = $true
    hasMessage = $true
    message = "亻子"
    latestRole = "user"
    evidenceSignature = "${stableSignature}"
  }
}
${latestIncomingFunction}
${stableIncomingFunction}
$mismatch = Get-AutoReplyVisualLatestIncoming $null @() "你好" 0.0
$secondFrame = [pscustomobject]@{
  ok = $true
  hasMessage = $true
  message = "亻子"
  latestRole = "user"
  evidenceSignature = "${stableSignature}"
}
@{
  mismatchReason = [string]$mismatch.reason
  mismatchPreservesMessageEvidence = [bool]$mismatch.hasMessage
  mismatchStabilizesWithSecondFrame = [bool](Test-AutoReplyVisualStableIncomingEvidence $mismatch $secondFrame)
} | ConvertTo-Json -Compress
`;
const mismatchedStableProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-EncodedCommand",
  Buffer.from(mismatchedStableProgram, "utf16le").toString("base64")
], { encoding: "utf8" });
assert.equal(mismatchedStableProbe.status, 0, mismatchedStableProbe.stderr || mismatchedStableProbe.stdout);
assert.deepEqual(JSON.parse(mismatchedStableProbe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
  mismatchPreservesMessageEvidence: true,
  mismatchReason: "unread_preview_mismatch",
  mismatchStabilizesWithSecondFrame: true
});

const pendingPreviewBefore = createHash("sha256").update("pending-preview-before", "utf8").digest("hex");
const pendingMessageBefore = createHash("sha256").update("pending-message-before", "utf8").digest("hex");
const pendingPreviewSignature = createHash("sha256").update("你好", "utf8").digest("hex");
const pendingBubbleSignature = stableSignature;
const pendingEvidenceRuntimeId = `visual:v1:${"c".repeat(64)}`;
const pendingCalls = [];
const pendingResults = [
  {
    ok: true,
    source: "session_prime",
    pid: 71,
    hWnd: 72,
    sessionBaselines: [{ conversation: "A测试客户", signature: pendingPreviewBefore }],
    sessionMessageBaselines: [{ conversation: "A测试客户", signature: pendingMessageBefore }]
  },
  {
    ok: false,
    reason: "unread_preview_pending",
    pendingReason: "second_frame_incoming_unresolved",
    conversation: "A测试客户",
    message: "你好",
    runtimeId: pendingEvidenceRuntimeId,
    previewSignature: pendingPreviewSignature,
    messageSignature: pendingBubbleSignature,
    pid: 71,
    hWnd: 72,
    source: "unread",
    latestRole: "user",
    context: [{ role: "user", content: "你好", key: pendingEvidenceRuntimeId }]
  },
  {
    ok: true,
    conversation: "A测试客户",
    message: "你好",
    runtimeId: pendingEvidenceRuntimeId,
    messageSignature: pendingBubbleSignature,
    pid: 71,
    hWnd: 72,
    source: "verify",
    latestRole: "user",
    context: [{ role: "user", content: "你好", key: pendingEvidenceRuntimeId }]
  },
  { ok: false, reason: "no_unread_message", pid: 71, hWnd: 72, sessionBaselines: [] }
];
const pendingDriver = createWechatVisualAutoReplyDriver((_script, env) => {
  pendingCalls.push(env);
  return pendingResults.shift();
});
assert.equal((await pendingDriver.primeWechatSession(["A测试客户"])).ok, true);
const pendingFirstScan = await pendingDriver.scanWechatIncoming(["A测试客户"]);
assert.equal(pendingFirstScan.ok, false);
assert.equal(pendingFirstScan.reason, "unread_preview_pending");
const recoveredPending = await pendingDriver.scanWechatIncoming(["A测试客户"]);
assert.equal(recoveredPending.ok, true);
assert.equal(recoveredPending.message, "你好");
assert.equal(recoveredPending.visualEvidenceRuntimeId, pendingEvidenceRuntimeId);
assert.equal(recoveredPending.messageSignature, pendingBubbleSignature);
assert.deepEqual(recoveredPending.context, [{ role: "user", content: "你好", key: recoveredPending.runtimeId }]);
assert.equal(pendingCalls[2].XIAOXI_AUTO_REPLY_MODE, "verify");
assert.equal(JSON.parse(pendingCalls[2].XIAOXI_VISUAL_BASELINES)["A测试客户"], pendingPreviewBefore, "pending preview evidence must not advance before verification succeeds");
assert.equal(JSON.parse(pendingCalls[2].XIAOXI_VISUAL_MESSAGE_BASELINES)["A测试客户"], pendingMessageBefore, "pending bubble evidence must not advance before verification succeeds");
const afterRecoveredPending = await pendingDriver.scanWechatIncoming(["A测试客户"]);
assert.equal(afterRecoveredPending.ok, false, "one recovered unread observation must emit only one candidate");
assert.equal(afterRecoveredPending.reason, "no_unread_message");
assert.equal(JSON.parse(pendingCalls[3].XIAOXI_VISUAL_BASELINES)["A测试客户"], pendingPreviewSignature);
assert.equal(JSON.parse(pendingCalls[3].XIAOXI_VISUAL_MESSAGE_BASELINES)["A测试客户"], pendingBubbleSignature);

const restoredPendingCalls = [];
const restoredPendingDriver = createWechatVisualAutoReplyDriver((_script, env) => {
  restoredPendingCalls.push(env);
  return {
    ok: true,
    conversation: "A测试客户",
    message: "重启后重新识别",
    runtimeId: pendingEvidenceRuntimeId,
    previewSignature: pendingPreviewSignature,
    messageSignature: pendingBubbleSignature,
    pid: 71,
    hWnd: 72,
    source: "pending_recovery",
    latestRole: "user",
    context: [{ role: "user", content: "重启后重新识别", key: pendingEvidenceRuntimeId }]
  };
});
assert.equal(restoredPendingDriver.scanWechatIncoming.restorePendingObservation({
  conversation: "A测试客户",
  pid: 71,
  hWnd: "72",
  preview_signature: pendingPreviewSignature,
  message_signature: pendingBubbleSignature,
  predecessor_preview_signature: pendingPreviewBefore,
  predecessor_message_signature: pendingMessageBefore
}), true);
const restoredAfterRestart = await restoredPendingDriver.scanWechatIncoming(["A测试客户"]);
assert.equal(restoredAfterRestart.ok, true);
assert.equal(restoredAfterRestart.message, "重启后重新识别");
assert.equal(restoredPendingCalls.length, 1, "pending restart recovery must not run a fresh prime first");
assert.equal(restoredPendingCalls[0].XIAOXI_AUTO_REPLY_MODE, "recover");
assert.equal(restoredPendingCalls[0].XIAOXI_EXPECTED_PREVIEW_SIGNATURE, pendingPreviewSignature);
assert.equal(restoredPendingCalls[0].XIAOXI_EXPECTED_MESSAGE_SIGNATURE, pendingBubbleSignature);
assert.equal("XIAOXI_EXPECTED_MESSAGE" in restoredPendingCalls[0], false, "recovery must re-read message text instead of persisting it");

function createDeterministicOccurrenceDriver() {
  const results = [
    {
      ok: true,
      source: "session_prime",
      pid: 79,
      hWnd: 80,
      sessionBaselines: [{ conversation: "A测试客户", signature: pendingPreviewBefore }],
      sessionMessageBaselines: [{ conversation: "A测试客户", signature: pendingMessageBefore }]
    },
    {
      ok: true,
      conversation: "A测试客户",
      message: "相同进站消息",
      runtimeId: pendingEvidenceRuntimeId,
      previewSignature: pendingPreviewSignature,
      messageSignature: pendingBubbleSignature,
      pid: 79,
      hWnd: 80,
      source: "unread",
      latestRole: "user",
      context: [{ role: "user", content: "相同进站消息", key: pendingEvidenceRuntimeId }]
    }
  ];
  return createWechatVisualAutoReplyDriver(() => results.shift());
}
const deterministicFirstDriver = createDeterministicOccurrenceDriver();
const deterministicSecondDriver = createDeterministicOccurrenceDriver();
await deterministicFirstDriver.primeWechatSession(["A测试客户"]);
await deterministicSecondDriver.primeWechatSession(["A测试客户"]);
const deterministicFirst = await deterministicFirstDriver.scanWechatIncoming(["A测试客户"]);
const deterministicSecond = await deterministicSecondDriver.scanWechatIncoming(["A测试客户"]);
assert.equal(deterministicFirst.runtimeId, deterministicSecond.runtimeId, "the same evidence chain must keep one occurrence ID across process reconstruction");

const resetPendingModes = [];
let resetPendingCall = 0;
const resetPendingDriver = createWechatVisualAutoReplyDriver((_script, env) => {
  resetPendingModes.push(env.XIAOXI_AUTO_REPLY_MODE);
  resetPendingCall += 1;
  if (resetPendingCall === 1 || resetPendingCall === 3) {
    return { ok: true, source: "session_prime", pid: 73, hWnd: 74, sessionBaselines: [], sessionMessageBaselines: [] };
  }
  if (resetPendingCall === 2) {
    return {
      ok: false,
      reason: "unread_preview_pending",
      conversation: "A测试客户",
      message: "你好",
      runtimeId: pendingEvidenceRuntimeId,
      previewSignature: pendingPreviewSignature,
      messageSignature: pendingBubbleSignature,
      pid: 73,
      hWnd: 74,
      source: "unread",
      latestRole: "user"
    };
  }
  throw new Error("reset must clear pending instead of attempting verification");
});
assert.equal((await resetPendingDriver.primeWechatSession(["A测试客户"])).ok, true);
assert.equal((await resetPendingDriver.scanWechatIncoming(["A测试客户"])).reason, "unread_preview_pending");
resetPendingDriver.scanWechatIncoming.resetBaselines();
assert.equal((await resetPendingDriver.scanWechatIncoming(["A测试客户"])).reason, "current_session_baselined");
assert.deepEqual(resetPendingModes, ["prime", "scan", "prime"]);

const unresolvedPendingModes = [];
const unresolvedPendingResult = {
  ok: false,
  reason: "unread_preview_pending",
  conversation: "A测试客户",
  message: "你好",
  runtimeId: pendingEvidenceRuntimeId,
  previewSignature: pendingPreviewSignature,
  messageSignature: pendingBubbleSignature,
  pid: 75,
  hWnd: 76,
  source: "unread",
  latestRole: "user"
};
const unresolvedPendingResults = [
  { ok: true, source: "session_prime", pid: 75, hWnd: 76, sessionBaselines: [], sessionMessageBaselines: [] },
  unresolvedPendingResult,
  { ok: false, reason: "visual_ocr_failed", pid: 75, hWnd: 76 },
  { ok: false, reason: "visual_ocr_failed", pid: 75, hWnd: 76 },
  { ok: false, reason: "visual_ocr_failed", pid: 75, hWnd: 76 },
  { ok: false, reason: "no_unread_message", pid: 75, hWnd: 76, sessionBaselines: [], sessionMessageBaselines: [] }
];
const unresolvedPendingDriver = createWechatVisualAutoReplyDriver((_script, env) => {
  unresolvedPendingModes.push(env.XIAOXI_AUTO_REPLY_MODE);
  return unresolvedPendingResults.shift();
});
assert.equal((await unresolvedPendingDriver.primeWechatSession(["A测试客户"])).ok, true);
assert.equal((await unresolvedPendingDriver.scanWechatIncoming(["A测试客户"])).reason, "unread_preview_pending");
assert.equal((await unresolvedPendingDriver.scanWechatIncoming(["A测试客户"])).reason, "unread_preview_pending");
assert.equal((await unresolvedPendingDriver.scanWechatIncoming(["A测试客户"])).reason, "unread_preview_pending");
assert.equal((await unresolvedPendingDriver.scanWechatIncoming(["A测试客户"])).reason, "unread_preview_unresolved", "a permanently unreadable pending event must not starve every other contact forever");
assert.equal((await unresolvedPendingDriver.scanWechatIncoming(["A测试客户"])).reason, "no_unread_message");
assert.deepEqual(unresolvedPendingModes, ["prime", "scan", "verify", "verify", "verify", "scan"]);

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

const boundaryFenceCalls = [];
const boundaryFenceResults = [
  {
    ok: true,
    source: "session_prime",
    pid: 81,
    hWnd: 91,
    sessionBaselines: [{ conversation: "A测试客户", signature: previewSignature }],
    sessionMessageBaselines: [{ conversation: "A测试客户", signature: initialMessageSignature }]
  },
  {
    ok: false,
    reason: "chat_boundary_unresolved",
    pid: 81,
    hWnd: 91,
    sessionBaselines: [{ conversation: "A测试客户", signature: changedStableSignature }],
    sessionMessageBaselines: [{ conversation: "A测试客户", signature: messageSignature }],
    baselineAdvance: { conversation: "A测试客户", signature: changedStableSignature },
    messageBaselineAdvance: { conversation: "A测试客户", signature: messageSignature }
  },
  { ok: false, reason: "no_unread_message", pid: 81, hWnd: 91 }
];
const boundaryFenceDriver = createWechatVisualAutoReplyDriver((script, env) => {
  boundaryFenceCalls.push(env);
  return boundaryFenceResults.shift();
});
assert.equal((await boundaryFenceDriver.primeWechatSession(["A 测试客户"])).ok, true);
assert.equal(boundaryFenceDriver.scanWechatIncoming.requeue(candidate), true);
const boundaryFence = await boundaryFenceDriver.scanWechatIncoming(["A 测试客户"]);
assert.equal(boundaryFence.ok, false);
assert.equal(boundaryFence.reason, "chat_boundary_unresolved", "an unproven boundary must not release an older retry");
assert.equal(boundaryFence.scanProbe, undefined);
await boundaryFenceDriver.scanWechatIncoming(["A 测试客户"]);
assert.equal(JSON.parse(boundaryFenceCalls[2].XIAOXI_VISUAL_BASELINES)["A测试客户"], previewSignature, "an unresolved frame must not advance the preview boundary");
assert.equal(JSON.parse(boundaryFenceCalls[2].XIAOXI_VISUAL_MESSAGE_BASELINES)["A测试客户"], initialMessageSignature, "an unresolved frame must not advance the message boundary");

for (const fencedReason of ["wechat_focus_failed", "latest_message_role_unresolved"]) {
  const fencedCalls = [];
  const fencedResults = [
    {
      ok: true,
      source: "session_prime",
      pid: 81,
      hWnd: 91,
      sessionBaselines: [{ conversation: "A测试客户", signature: previewSignature }],
      sessionMessageBaselines: [{ conversation: "A测试客户", signature: initialMessageSignature }]
    },
    {
      ok: false,
      reason: fencedReason,
      latestRole: fencedReason === "latest_message_role_unresolved" ? "unknown" : undefined,
      pid: 81,
      hWnd: 91,
      baselineAdvance: { conversation: "A测试客户", signature: changedStableSignature },
      messageBaselineAdvance: { conversation: "A测试客户", signature: messageSignature }
    },
    { ok: false, reason: "no_unread_message", pid: 81, hWnd: 91 }
  ];
  const fencedDriver = createWechatVisualAutoReplyDriver((script, env) => {
    fencedCalls.push(env);
    return fencedResults.shift();
  });
  assert.equal((await fencedDriver.primeWechatSession(["A 测试客户"])).ok, true);
  assert.equal(fencedDriver.scanWechatIncoming.requeue(candidate), true);
  const fenced = await fencedDriver.scanWechatIncoming(["A 测试客户"]);
  assert.equal(fenced.reason, fencedReason);
  assert.equal(fenced.scanProbe, undefined, `${fencedReason} must not release an older retry`);
  await fencedDriver.scanWechatIncoming(["A 测试客户"]);
  assert.equal(JSON.parse(fencedCalls[2].XIAOXI_VISUAL_BASELINES)["A测试客户"], previewSignature, `${fencedReason} must not advance preview state`);
  assert.equal(JSON.parse(fencedCalls[2].XIAOXI_VISUAL_MESSAGE_BASELINES)["A测试客户"], initialMessageSignature, `${fencedReason} must not advance message state`);
}

const unresolvedFenceResults = [
  {
    ok: true,
    source: "session_prime",
    pid: 81,
    hWnd: 91,
    sessionBaselines: [{ conversation: "A测试客户", signature: previewSignature }],
    sessionMessageBaselines: [{ conversation: "A测试客户", signature: initialMessageSignature }]
  },
  { ok: false, reason: "current_transition_unresolved", pid: 81, hWnd: 91 }
];
const unresolvedFenceDriver = createWechatVisualAutoReplyDriver(() => unresolvedFenceResults.shift());
assert.equal((await unresolvedFenceDriver.primeWechatSession(["A 测试客户"])).ok, true);
assert.equal(unresolvedFenceDriver.scanWechatIncoming.requeue(candidate), true);
const unresolvedFence = await unresolvedFenceDriver.scanWechatIncoming(["A 测试客户"]);
assert.equal(unresolvedFence.ok, false, "an unresolved live transition must not be replaced by a cached retry candidate");
assert.equal(unresolvedFence.reason, "current_transition_unresolved");
assert.equal(unresolvedFence.scanProbe, undefined);

const outgoingSettlingFenceResults = [
  {
    ok: true,
    source: "session_prime",
    pid: 81,
    hWnd: 91,
    sessionBaselines: [{ conversation: "A测试客户", signature: previewSignature }],
    sessionMessageBaselines: [{ conversation: "A测试客户", signature: initialMessageSignature }]
  },
  { ok: false, reason: "current_outgoing_settling", pid: 81, hWnd: 91, latestRole: "assistant" }
];
const outgoingSettlingFenceDriver = createWechatVisualAutoReplyDriver(() => outgoingSettlingFenceResults.shift());
assert.equal((await outgoingSettlingFenceDriver.primeWechatSession(["A 测试客户"])).ok, true);
assert.equal(outgoingSettlingFenceDriver.scanWechatIncoming.requeue(candidate), true);
const outgoingSettlingFence = await outgoingSettlingFenceDriver.scanWechatIncoming(["A 测试客户"]);
assert.equal(outgoingSettlingFence.ok, false);
assert.equal(outgoingSettlingFence.reason, "current_outgoing_settling", "a reflowing assistant bubble must wait instead of releasing an older retry");
assert.equal(outgoingSettlingFence.scanProbe, undefined);

assert.equal(calls.length, 4);
assert.ok(calls.every((call) => call.script === AUTO_REPLY_VISUAL_SCRIPT));
assert.ok(calls.every((call) => call.options.ensure === false && call.options.sta === true && call.options.timeout === 45_000));
assert.deepEqual(JSON.parse(calls[0].env.XIAOXI_ALLOWED_NAMES), ["A测试客户"]);
assert.equal(calls[1].env.XIAOXI_EXPECTED_PID, "81");
assert.equal(calls[1].env.XIAOXI_EXPECTED_HWND, "91");
assert.equal(JSON.parse(calls[1].env.XIAOXI_VISUAL_BASELINES)["A测试客户"], previewSignature);
assert.equal(JSON.parse(calls[1].env.XIAOXI_VISUAL_MESSAGE_BASELINES)["A测试客户"], initialMessageSignature);
assert.equal(calls[2].env.XIAOXI_EXPECTED_CONVERSATION, "A测试客户");
assert.equal(calls[2].env.XIAOXI_EXPECTED_MESSAGE, "你是谁");
assert.equal(calls[2].env.XIAOXI_EXPECTED_RUNTIME_ID, runtimeId);
assert.equal(calls[2].env.XIAOXI_EXPECTED_MESSAGE_SIGNATURE, messageSignature);
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

const primedObservationSignature = createHash("sha256").update("primed-assistant", "utf8").digest("hex");
const primedObservationDriver = createWechatVisualAutoReplyDriver(() => ({
  ok: true,
  source: "session_prime",
  pid: 15,
  hWnd: 16,
  conversation: "TestCustomer",
  latestRole: "assistant",
  messageSignature: primedObservationSignature,
  sessionBaselines: [],
  sessionMessageBaselines: [{ conversation: "TestCustomer", signature: primedObservationSignature }]
}));
assert.deepEqual(await primedObservationDriver.scanWechatIncoming(["TestCustomer"]), {
  ok: false,
  primed: true,
  pid: 15,
  hWnd: "16",
  conversation: "TestCustomer",
  latestRole: "assistant",
  messageSignature: primedObservationSignature,
  reason: "current_session_baselined"
});

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
    viewportHash: "1".repeat(64),
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
    viewportHash: "2".repeat(64),
    latestRole: "user",
    context: [{ role: "user", content: "相同消息", key: runtimeId }]
  }
];
const differentPreviewSignature = createHash("sha256").update("不同消息", "utf8").digest("hex");
const differentPreviewEvidenceRuntimeId = `visual:v1:${"d".repeat(64)}`;
repeatedResults.push({
  ...repeatedResults[1],
  runtimeId: differentPreviewEvidenceRuntimeId,
  previewSignature: differentPreviewSignature,
  viewportHash: "3".repeat(64),
  context: [{ role: "user", content: repeatedResults[1].message, key: differentPreviewEvidenceRuntimeId }]
});
const distinctEvidenceRuntimeId = `visual:v1:${"b".repeat(64)}`;
repeatedResults.push({
  ...repeatedResults[1],
  runtimeId: distinctEvidenceRuntimeId,
  message: "另一条消息",
  messageSignature: createHash("sha256").update("second-local-occurrence", "utf8").digest("hex"),
  viewportHash: "4".repeat(64),
  context: [{ role: "user", content: "另一条消息", key: distinctEvidenceRuntimeId }]
});
const repeatedDriver = createWechatVisualAutoReplyDriver(() => repeatedResults.shift());
assert.equal((await repeatedDriver.primeWechatSession(["A测试客户"])).ok, true);
const repeatedFirst = await repeatedDriver.scanWechatIncoming(["A测试客户"]);
const repeatedSecond = await repeatedDriver.scanWechatIncoming(["A测试客户"]);
const differentPreviewOccurrence = await repeatedDriver.scanWechatIncoming([repeatedFirst.conversation]);
const distinctOccurrence = await repeatedDriver.scanWechatIncoming([repeatedFirst.conversation]);
assert.equal(repeatedFirst.visualEvidenceRuntimeId, runtimeId);
assert.equal(repeatedSecond.visualEvidenceRuntimeId, runtimeId);
assert.equal(repeatedFirst.runtimeId, repeatedSecond.runtimeId, "the same local evidence must keep one public runtime ID across rescans and viewport changes");
assert.equal(differentPreviewOccurrence.visualEvidenceRuntimeId, differentPreviewEvidenceRuntimeId);
assert.equal(differentPreviewOccurrence.runtimeId, repeatedFirst.runtimeId, "sidebar preview changes must not split one authoritative bubble occurrence");
assert.equal(distinctOccurrence.visualEvidenceRuntimeId, distinctEvidenceRuntimeId);
assert.notEqual(distinctOccurrence.runtimeId, repeatedFirst.runtimeId, "a different authoritative bubble must create a new occurrence");
assert.deepEqual(repeatedFirst.context, [{ role: "user", content: "相同消息", key: repeatedFirst.runtimeId }]);
assert.deepEqual(repeatedSecond.context, [{ role: "user", content: "相同消息", key: repeatedSecond.runtimeId }]);

const samePreviewSignature = createHash("sha256").update("重复内容", "utf8").digest("hex");
const boundaryPreviewSignature = createHash("sha256").update("same", "utf8").digest("hex");
const boundaryMessageSignature = createHash("sha256").update("same-bubble", "utf8").digest("hex");
const boundaryAssistantSignature = createHash("sha256").update("assistant-boundary", "utf8").digest("hex");
const boundaryEvidenceRuntimeId = `visual:v1:${"c".repeat(64)}`;
const boundaryCandidate = {
  ok: true,
  conversation: "TestCustomer",
  message: "same",
  runtimeId: boundaryEvidenceRuntimeId,
  previewSignature: boundaryPreviewSignature,
  messageSignature: boundaryMessageSignature,
  pid: 51,
  hWnd: 52,
  source: "unread",
  latestRole: "user",
  context: [{ role: "user", content: "same", key: boundaryEvidenceRuntimeId }]
};
const boundaryResults = [
  {
    ok: true,
    source: "session_prime",
    pid: 51,
    hWnd: 52,
    sessionBaselines: [{ conversation: "TestCustomer", signature: boundaryPreviewSignature }],
    sessionMessageBaselines: [{ conversation: "TestCustomer", signature: createHash("sha256").update("before", "utf8").digest("hex") }]
  },
  boundaryCandidate,
  {
    ok: false,
    reason: "latest_message_not_incoming",
    pid: 51,
    hWnd: 52,
    conversation: "TestCustomer",
    latestRole: "assistant",
    messageSignature: boundaryAssistantSignature,
    baselineAdvance: { conversation: "TestCustomer", signature: boundaryPreviewSignature },
    messageBaselineAdvance: { conversation: "TestCustomer", signature: boundaryAssistantSignature }
  },
  boundaryCandidate
];
const boundaryDriver = createWechatVisualAutoReplyDriver(() => boundaryResults.shift());
assert.equal((await boundaryDriver.primeWechatSession(["TestCustomer"])).ok, true);
const boundaryFirst = await boundaryDriver.scanWechatIncoming(["TestCustomer"]);
assert.equal(boundaryDriver.scanWechatIncoming.noteVerifiedSend(boundaryFirst, { verificationMode: "visual_message_bubble" }), true);
const assistantBoundary = await boundaryDriver.scanWechatIncoming(["TestCustomer"]);
const boundarySecond = await boundaryDriver.scanWechatIncoming(["TestCustomer"]);
assert.equal(assistantBoundary.latestRole, "assistant", "the scanner must expose the observed assistant turn fence");
assert.equal(boundaryFirst.visualEvidenceRuntimeId, boundarySecond.visualEvidenceRuntimeId);
assert.notEqual(boundaryFirst.runtimeId, boundarySecond.runtimeId, "the same customer text after a verified send turn is a new occurrence");

const immediateSameSignature = createHash("sha256").update("immediate-identical-bubble", "utf8").digest("hex");
const immediateSameEvidenceRuntimeId = `visual:v1:${"d".repeat(64)}`;
const immediateSameUnderlying = {
  ok: true,
  conversation: "TestCustomer",
  message: "same immediate text",
  runtimeId: immediateSameEvidenceRuntimeId,
  previewSignature: boundaryPreviewSignature,
  messageSignature: immediateSameSignature,
  pid: 61,
  hWnd: 62,
  source: "current_message_change",
  latestRole: "user",
  context: [{ role: "user", content: "same immediate text", key: immediateSameEvidenceRuntimeId }]
};
let immediateSameCall = 0;
const immediateSameDriver = createWechatVisualAutoReplyDriver((_script, env) => {
  immediateSameCall += 1;
  if (immediateSameCall === 1) {
    return {
      ok: true,
      source: "session_prime",
      pid: 61,
      hWnd: 62,
      sessionBaselines: [{ conversation: "TestCustomer", signature: boundaryPreviewSignature }],
      sessionMessageBaselines: [{ conversation: "TestCustomer", signature: createHash("sha256").update("before-immediate", "utf8").digest("hex") }]
    };
  }
  if (immediateSameCall === 3) {
    const outgoingPreviewBoundary = JSON.parse(env.XIAOXI_VISUAL_BASELINES).TestCustomer;
    const outgoingMessageBoundary = JSON.parse(env.XIAOXI_VISUAL_MESSAGE_BASELINES).TestCustomer;
    assert.notEqual(outgoingPreviewBoundary, boundaryPreviewSignature, "a verified send must advance the sidebar baseline before an identical customer follow-up");
    assert.notEqual(outgoingMessageBoundary, immediateSameSignature, "a verified outgoing bubble must advance the message baseline before the next poll");
    assert.equal(outgoingPreviewBoundary, outgoingMessageBoundary, "both visual channels must share the same opaque outgoing boundary");
  }
  return immediateSameUnderlying;
});
assert.equal((await immediateSameDriver.primeWechatSession(["TestCustomer"])).ok, true);
const immediateSameFirst = await immediateSameDriver.scanWechatIncoming(["TestCustomer"]);
assert.equal(immediateSameDriver.scanWechatIncoming.noteVerifiedSend(immediateSameFirst, { verificationMode: "draft_consumed_same_header" }), true, "a verified click plus consumed draft must advance the same outgoing boundary recorded by the controller");
assert.equal(immediateSameDriver.scanWechatIncoming.noteVerifiedSend(immediateSameFirst, { verificationMode: "visual_message_bubble" }), true, "stronger bubble proof must remain idempotent for the same sent turn");
const immediateSameSecond = await immediateSameDriver.scanWechatIncoming(["TestCustomer"]);
assert.equal(immediateSameSecond.visualEvidenceRuntimeId, immediateSameFirst.visualEvidenceRuntimeId);
assert.notEqual(immediateSameSecond.runtimeId, immediateSameFirst.runtimeId, "an OCR-verified outgoing bubble must separate an immediate identical customer occurrence");

const gateBeforeSignature = createHash("sha256").update("current-open-before", "utf8").digest("hex");
const gateAfterSignature = createHash("sha256").update("current-open-after", "utf8").digest("hex");
const gatePreviewAfterSignature = createHash("sha256").update("current-open-preview-after", "utf8").digest("hex");
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
    previewSignature: gatePreviewAfterSignature,
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
const confirmedCurrentCandidate = await gateDriver.scanWechatIncoming(["A测试客户"]);
assert.equal(confirmedCurrentCandidate.ok, true, "a stable two-channel transition must produce one candidate");
assert.equal(confirmedCurrentCandidate.source, "current_message_change");
assert.equal(confirmedCurrentCandidate.message, "重复内容");
assert.equal(confirmedCurrentCandidate.visualMode, "visual_render_v1");
assert.equal(JSON.parse(gateCalls[1].XIAOXI_VISUAL_BASELINES)["A测试客户"], samePreviewSignature);
assert.equal(JSON.parse(gateCalls[1].XIAOXI_VISUAL_MESSAGE_BASELINES)["A测试客户"], gateBeforeSignature);

const atomicPreviewBefore = createHash("sha256").update("atomic-preview-before", "utf8").digest("hex");
const atomicPreviewAfter = createHash("sha256").update("atomic-preview-after", "utf8").digest("hex");
const atomicMessageBefore = createHash("sha256").update("atomic-message-before", "utf8").digest("hex");
const atomicMessageAfter = createHash("sha256").update("atomic-message-after", "utf8").digest("hex");
const atomicEvidenceRuntimeId = `visual:v1:${"e".repeat(64)}`;
const atomicCandidate = {
  ok: true,
  conversation: "A测试客户",
  message: "异步客户消息",
  runtimeId: atomicEvidenceRuntimeId,
  previewSignature: atomicPreviewAfter,
  messageSignature: atomicMessageAfter,
  pid: 37,
  hWnd: 38,
  source: "current_message_change",
  latestRole: "user",
  context: [{ role: "user", content: "异步客户消息", key: atomicEvidenceRuntimeId }]
};

const previewThenBubbleCalls = [];
const previewThenBubbleResults = [
  {
    ok: true,
    source: "session_prime",
    pid: 37,
    hWnd: 38,
    sessionBaselines: [{ conversation: "A测试客户", signature: atomicPreviewBefore }],
    sessionMessageBaselines: [{ conversation: "A测试客户", signature: atomicMessageBefore }]
  },
  { ok: false, reason: "no_unread_message", pid: 37, hWnd: 38 },
  atomicCandidate,
  { ok: false, reason: "no_unread_message", pid: 37, hWnd: 38 }
];
const previewThenBubbleDriver = createWechatVisualAutoReplyDriver((script, env) => {
  previewThenBubbleCalls.push(env);
  return previewThenBubbleResults.shift();
});
assert.equal((await previewThenBubbleDriver.primeWechatSession(["A测试客户"])).ok, true);
const previewOnly = await previewThenBubbleDriver.scanWechatIncoming(["A测试客户"]);
const laterBubble = await previewThenBubbleDriver.scanWechatIncoming(["A测试客户"]);
assert.equal(previewOnly.reason, "no_unread_message");
assert.equal(laterBubble.ok, true, "a later stable customer bubble must not be swallowed because the sidebar preview updated first");
assert.equal(laterBubble.messageSignature, atomicMessageAfter);
await previewThenBubbleDriver.scanWechatIncoming(["A测试客户"]);
assert.equal(JSON.parse(previewThenBubbleCalls[2].XIAOXI_VISUAL_BASELINES)["A测试客户"], atomicPreviewBefore);
assert.equal(JSON.parse(previewThenBubbleCalls[2].XIAOXI_VISUAL_MESSAGE_BASELINES)["A测试客户"], atomicMessageBefore);
assert.equal(JSON.parse(previewThenBubbleCalls[3].XIAOXI_VISUAL_BASELINES)["A测试客户"], atomicPreviewAfter);
assert.equal(JSON.parse(previewThenBubbleCalls[3].XIAOXI_VISUAL_MESSAGE_BASELINES)["A测试客户"], atomicMessageAfter);

const bubbleThenPreviewCalls = [];
const bubbleThenPreviewResults = [
  {
    ok: true,
    source: "session_prime",
    pid: 39,
    hWnd: 40,
    sessionBaselines: [{ conversation: "A测试客户", signature: atomicPreviewBefore }],
    sessionMessageBaselines: [{ conversation: "A测试客户", signature: atomicMessageBefore }]
  },
  { ...atomicCandidate, pid: 39, hWnd: 40, previewSignature: atomicPreviewBefore },
  { ok: false, reason: "no_unread_message", pid: 39, hWnd: 40 },
  { ok: false, reason: "no_unread_message", pid: 39, hWnd: 40 }
];
const bubbleThenPreviewDriver = createWechatVisualAutoReplyDriver((script, env) => {
  bubbleThenPreviewCalls.push(env);
  return bubbleThenPreviewResults.shift();
});
assert.equal((await bubbleThenPreviewDriver.primeWechatSession(["A测试客户"])).ok, true);
const bubbleFirst = await bubbleThenPreviewDriver.scanWechatIncoming(["A测试客户"]);
const previewLater = await bubbleThenPreviewDriver.scanWechatIncoming(["A测试客户"]);
assert.equal(bubbleFirst.ok, true, "a stable customer bubble must become a candidate before the sidebar preview catches up");
assert.equal(previewLater.reason, "no_unread_message", "a later preview-only change must not produce a second candidate");
await bubbleThenPreviewDriver.scanWechatIncoming(["A测试客户"]);
assert.equal(JSON.parse(bubbleThenPreviewCalls[2].XIAOXI_VISUAL_BASELINES)["A测试客户"], atomicPreviewBefore);
assert.equal(JSON.parse(bubbleThenPreviewCalls[2].XIAOXI_VISUAL_MESSAGE_BASELINES)["A测试客户"], atomicMessageAfter);
assert.equal(JSON.parse(bubbleThenPreviewCalls[3].XIAOXI_VISUAL_BASELINES)["A测试客户"], atomicPreviewBefore);
assert.equal(JSON.parse(bubbleThenPreviewCalls[3].XIAOXI_VISUAL_MESSAGE_BASELINES)["A测试客户"], atomicMessageAfter);

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

const captureFallbackCalls = [];
const captureFallbackEvidence = `visual:v1:${"e".repeat(64)}`;
const captureFallbackSignature = "e".repeat(64);
const captureFallbackDriver = createWechatVisualAutoReplyDriver((_script, env) => {
  captureFallbackCalls.push(env);
  if (captureFallbackCalls.length === 1) return { ok: false, reason: "moments_visual_ocr_unavailable", captureMode: "hwnd_printwindow" };
  if (captureFallbackCalls.length === 2) return {
    ok: true, source: "session_prime", captureMode: "foreground_screen", pid: 101, hWnd: 102,
    sessionBaselines: [], sessionMessageBaselines: []
  };
  return {
    ok: true, conversation: "CaptureCustomer", message: "hello", runtimeId: captureFallbackEvidence,
    previewSignature: captureFallbackSignature, messageSignature: captureFallbackSignature,
    pid: 101, hWnd: 102, source: "unread", latestRole: "user",
    context: [{ role: "user", content: "hello", key: captureFallbackEvidence }]
  };
});
assert.equal((await captureFallbackDriver.primeWechatSession(["CaptureCustomer"])).ok, true, "a compositor shell whose OCR is unusable must get one forced foreground retry");
assert.equal(captureFallbackCalls[0].XIAOXI_ALLOW_FOCUS_FALLBACK, "");
assert.equal(captureFallbackCalls[1].XIAOXI_ALLOW_FOCUS_FALLBACK, "1");
assert.equal(captureFallbackCalls[1].XIAOXI_FORCE_SCREEN_CAPTURE, "1", "the fallback must skip a misleading compositor PrintWindow frame");
assert.equal((await captureFallbackDriver.scanWechatIncoming(["CaptureCustomer"])).ok, true);
assert.equal(captureFallbackCalls[2].XIAOXI_ALLOW_FOCUS_FALLBACK, "", "a successful live fallback must return the next poll to background PrintWindow");
assert.equal(captureFallbackCalls[2].XIAOXI_FORCE_SCREEN_CAPTURE, "");
assert.equal((await captureFallbackDriver.scanWechatIncoming(["CaptureCustomer"])).ok, true);
assert.equal(captureFallbackCalls[3].XIAOXI_ALLOW_FOCUS_FALLBACK, "", "a long stable background run must not steal foreground");
assert.equal(captureFallbackCalls[3].XIAOXI_FORCE_SCREEN_CAPTURE, "");

const startupBoundaryCalls = [];
const startupOldPreview = "a".repeat(64);
const startupOldMessage = "b".repeat(64);
const startupNewMessage = "c".repeat(64);
const startupEvidenceRuntime = `visual:v1:${"f".repeat(64)}`;
const startupBoundaryDriver = createWechatVisualAutoReplyDriver((_script, env) => {
  startupBoundaryCalls.push(env);
  return startupBoundaryCalls.length === 1 ? {
    ok: true, source: "session_prime", startupBoundarySupported: true, pid: 111, hWnd: 112,
    conversation: "BoundaryCustomer", latestRole: "user", messageSignature: startupOldMessage,
    sessionBaselines: [{ conversation: "BoundaryCustomer", signature: startupOldPreview, preview: "old", unread: false }],
    sessionMessageBaselines: [{ conversation: "BoundaryCustomer", signature: startupOldMessage, message: "old", latestRole: "user" }]
  } : {
    ok: true, conversation: "BoundaryCustomer", message: "new during start", runtimeId: startupEvidenceRuntime,
    previewSignature: startupOldPreview, messageSignature: startupNewMessage, pid: 111, hWnd: 112,
    source: "current_message_change", latestRole: "user",
    context: [{ role: "user", content: "new during start", key: startupEvidenceRuntime }]
  };
});
assert.equal((await startupBoundaryDriver.primeWechatSession(["BoundaryCustomer"])).ok, true);
assert.deepEqual(startupBoundaryCalls.map((env) => env.XIAOXI_AUTO_REPLY_MODE), ["prime", "prime_confirm"]);
assert.equal(JSON.parse(startupBoundaryCalls[1].XIAOXI_STARTUP_MESSAGES).BoundaryCustomer.message, "old");
const startupCandidate = await startupBoundaryDriver.scanWechatIncoming(["BoundaryCustomer"]);
assert.equal(startupCandidate.ok, true, "a message appearing inside prime must be queued, not baselined away");
assert.equal(startupCandidate.message, "new during start");
assert.equal(startupBoundaryCalls.length, 2, "the startup occurrence must be returned before another visual scan");

const repeatedTurnSignature = "d".repeat(64);
const repeatedTurnEvidence = `visual:v1:${"9".repeat(64)}`;
const repeatedTurnCandidate = {
  ok: true, conversation: "RepeatCustomer", message: "same", runtimeId: repeatedTurnEvidence,
  previewSignature: repeatedTurnSignature, messageSignature: repeatedTurnSignature,
  pid: 121, hWnd: 122, source: "current_message_change", latestRole: "user",
  context: [{ role: "user", content: "same", key: repeatedTurnEvidence }]
};
const assistantTurn = {
  ok: false, reason: "latest_message_not_incoming", latestRole: "assistant", pid: 121, hWnd: 122,
  messageBaselineAdvance: { conversation: "RepeatCustomer", signature: "8".repeat(64) }
};
const repeatedTurnResults = [{ ok: true, source: "session_prime", pid: 121, hWnd: 122, sessionBaselines: [], sessionMessageBaselines: [] }];
for (let index = 0; index < 4; index += 1) {
  repeatedTurnResults.push({ ...repeatedTurnCandidate });
  if (index < 3) repeatedTurnResults.push({ ...assistantTurn });
}
const repeatedTurnDriver = createWechatVisualAutoReplyDriver(() => repeatedTurnResults.shift());
assert.equal((await repeatedTurnDriver.primeWechatSession(["RepeatCustomer"])).ok, true);
const repeatedTurnIds = [];
let lastAdvance;
for (let index = 0; index < 4; index += 1) {
  const candidate = await repeatedTurnDriver.scanWechatIncoming(["RepeatCustomer"]);
  repeatedTurnIds.push(candidate.runtimeId);
  lastAdvance = repeatedTurnDriver.scanWechatIncoming.noteSendAttempted(candidate, index === 3
    ? { outcomeUnknown: true }
    : { verificationMode: "visual_message_bubble" });
  assert.equal(lastAdvance.turnEpoch, index === 3 ? 3 : index + 1);
  assert.equal(lastAdvance.advanced, index !== 3, "an unknown outcome must not manufacture a new turn epoch");
  if (index < 3) assert.equal((await repeatedTurnDriver.scanWechatIncoming(["RepeatCustomer"])).latestRole, "assistant");
}
assert.equal(new Set(repeatedTurnIds).size, 4, "four identical customer turns must have four occurrence IDs");
const repeatedUnknown = repeatedTurnDriver.scanWechatIncoming.noteSendAttempted(
  { ...repeatedTurnCandidate, runtimeId: repeatedTurnIds[3] }, { outcomeUnknown: true }
);
assert.equal(repeatedUnknown.turnEpoch, 3, "repeating one outcome-unknown attempt must retain the same epoch");
assert.equal(repeatedUnknown.advanced, false);

const unknownBoundarySignature = "6".repeat(64);
const unknownResults = [
  { ok: true, source: "session_prime", pid: 131, hWnd: 132, sessionBaselines: [], sessionMessageBaselines: [] },
  { ...repeatedTurnCandidate, pid: 131, hWnd: 132 },
  { ...repeatedTurnCandidate, pid: 131, hWnd: 132 },
  {
    ok: false, reason: "latest_message_not_incoming", latestRole: "assistant", pid: 131, hWnd: 132,
    messageBaselineAdvance: { conversation: "RepeatCustomer", signature: unknownBoundarySignature }
  },
  { ...repeatedTurnCandidate, pid: 131, hWnd: 132 }
];
const unknownDriver = createWechatVisualAutoReplyDriver(() => unknownResults.shift());
assert.equal((await unknownDriver.primeWechatSession(["RepeatCustomer"])).ok, true);
const unknownFirst = await unknownDriver.scanWechatIncoming(["RepeatCustomer"]);
const unknownAttempt = unknownDriver.scanWechatIncoming.noteSendAttempted(unknownFirst, { outcomeUnknown: true });
assert.equal(unknownAttempt.advanced, false);
assert.equal(unknownAttempt.turnEpoch, 0);
const unknownSameBubble = await unknownDriver.scanWechatIncoming(["RepeatCustomer"]);
assert.equal(unknownSameBubble.runtimeId, unknownFirst.runtimeId, "an unknown result must leave the original bubble on its original public ID");
assert.equal(unknownDriver.scanWechatIncoming.requeue(unknownSameBubble), true, "a cancelled retry may still exist before an outgoing boundary is observed");
assert.equal((await unknownDriver.scanWechatIncoming(["RepeatCustomer"])).latestRole, "assistant");
const afterUnknownAssistant = await unknownDriver.scanWechatIncoming(["RepeatCustomer"]);
assert.notEqual(afterUnknownAssistant.runtimeId, unknownFirst.runtimeId, "an observed assistant boundary must give future identical customer text a new occurrence ID");
assert.equal(afterUnknownAssistant.message, unknownFirst.message, "the new turn may legitimately repeat the same customer text");

const restartTurnCalls = [];
const restartTurnDriver = createWechatVisualAutoReplyDriver((_script, env) => {
  restartTurnCalls.push(env);
  return restartTurnCalls.length === 1 ? {
    ok: true, source: "session_prime", pid: 121, hWnd: 122,
    sessionBaselines: [{ conversation: "RepeatCustomer", signature: "7".repeat(64), preview: "assistant", unread: false }],
    sessionMessageBaselines: [{ conversation: "RepeatCustomer", signature: "8".repeat(64), message: "assistant", latestRole: "assistant" }]
  } : { ...repeatedTurnCandidate };
});
assert.equal(restartTurnDriver.scanWechatIncoming.restoreTurnBoundaries([{
  conversation: "RepeatCustomer", turnEpoch: 3, runtimeId: repeatedTurnIds[2]
}]), 1);
assert.equal((await restartTurnDriver.primeWechatSession(["RepeatCustomer"])).ok, true);
const afterRestartSameText = await restartTurnDriver.scanWechatIncoming(["RepeatCustomer"]);
assert.notEqual(afterRestartSameText.runtimeId, repeatedTurnIds[2], "the next identical turn must remain distinct from the restored verified turn after restart");
assert.equal(afterRestartSameText.runtimeId, repeatedTurnIds[3], "observing the restored verified assistant boundary must not advance the epoch a second time");
assert.equal(JSON.parse(restartTurnCalls[1].XIAOXI_VISUAL_MESSAGE_BASELINES).RepeatCustomer.length, 64, "assistant observation must keep a valid restored turn baseline");

const restartUnknownResults = [
  {
    ok: true, source: "session_prime", pid: 121, hWnd: 122,
    sessionBaselines: [{ conversation: "RepeatCustomer", signature: "7".repeat(64), preview: "assistant", unread: false }],
    sessionMessageBaselines: [{ conversation: "RepeatCustomer", signature: "8".repeat(64), message: "assistant", latestRole: "assistant" }]
  },
  { ...repeatedTurnCandidate }
];
const restartUnknownDriver = createWechatVisualAutoReplyDriver(() => restartUnknownResults.shift());
assert.equal(restartUnknownDriver.scanWechatIncoming.restoreTurnBoundaries([
  { conversation: "RepeatCustomer", turnEpoch: 3, runtimeId: repeatedTurnIds[2] },
  { conversation: "RepeatCustomer", turnEpoch: 0, runtimeId: repeatedTurnIds[3] }
]), 1);
assert.equal((await restartUnknownDriver.primeWechatSession(["RepeatCustomer"])).ok, true);
const afterRestartUnknownAssistant = await restartUnknownDriver.scanWechatIncoming(["RepeatCustomer"]);
assert.notEqual(afterRestartUnknownAssistant.runtimeId, repeatedTurnIds[3], "an assistant bubble observed after a restored unknown attempt must open the next epoch instead of reviving the unknown occurrence");

assert.equal((await driver.verifyWechatIncoming({ conversation: "", message: "" })).reason, "incoming_message_missing");
assert.equal((await driver.verifyWechatIncoming({ conversation: "A测试客户", message: "你是谁", runtimeId: "bad" })).reason, "incoming_identity_missing");
assert.equal((await driver.scanWechatIncoming([])).reason, "whitelist_empty");

console.log("wechat auto-reply visual driver self-check passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
