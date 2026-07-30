const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const probeFile = path.join(__dirname, "moments_visual_probe.dev.cjs");
const dryRunFile = path.join(__dirname, "moments_visual_dry_run.dev.cjs");
const actionFile = path.join(__dirname, "moments_visual_action_driver.dev.cjs");
const windowDriverFile = path.join(__dirname, "wechat_window_driver.cjs");
const probeSource = fs.readFileSync(probeFile, "utf8");
const dryRunSource = fs.readFileSync(dryRunFile, "utf8");
const actionSource = fs.readFileSync(actionFile, "utf8").replace(/\r\n?/gu, "\n");
const windowDriverSource = fs.readFileSync(windowDriverFile, "utf8");
const { MOMENTS_VISUAL_READONLY_POWERSHELL } = require(probeFile);
const { MOMENTS_VISUAL_STABILITY_TOLERANCE_PX, MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT } = require(dryRunFile);
const visualActionDriver = require(actionFile);
const {
  MOMENTS_VISUAL_ACTION_POWERSHELL,
  MOMENTS_VISUAL_POST_RELOCK_TOLERANCE_PX
} = visualActionDriver;

assert.equal(typeof MOMENTS_VISUAL_READONLY_POWERSHELL, "string");
assert.equal(typeof MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT, "string");
assert.ok(MOMENTS_VISUAL_READONLY_POWERSHELL.length > 1_000);
assert.ok(MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT.includes(MOMENTS_VISUAL_READONLY_POWERSHELL));
assert.equal(MOMENTS_VISUAL_STABILITY_TOLERANCE_PX, 12);
assert.equal(typeof MOMENTS_VISUAL_ACTION_POWERSHELL, "string");
assert.ok(MOMENTS_VISUAL_ACTION_POWERSHELL.length > 10_000);
assert.equal(MOMENTS_VISUAL_POST_RELOCK_TOLERANCE_PX, 12);
assert.match(probeSource, /SetThreadDpiAwarenessContext\(IntPtr dpiContext\)/u);
assert.match(probeSource, /SetThreadDpiAwarenessContext\(\[IntPtr\]\(-4\)\)/u);
assert.doesNotMatch(probeSource, /SetProcessDPIAware/u);

const parsePowerShell = [
  "$tokens = $null",
  "$errors = $null",
  "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))",
  "[void][System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)",
  "if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.ToString()) }; exit 1 }"
].join("; ");
const parsedVisualAction = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", parsePowerShell], {
  input: Buffer.from(MOMENTS_VISUAL_ACTION_POWERSHELL, "utf8").toString("base64"),
  encoding: "utf8"
});
assert.equal(parsedVisualAction.status, 0, parsedVisualAction.stderr || "visual action PowerShell must parse");
const parsedVisualDryRun = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", parsePowerShell], {
  input: Buffer.from(MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT, "utf8").toString("base64"),
  encoding: "utf8"
});
assert.equal(parsedVisualDryRun.status, 0, parsedVisualDryRun.stderr || "visual dry-run PowerShell must parse");

const visualBoundsFunction = MOMENTS_VISUAL_ACTION_POWERSHELL.match(
  /function Test-VisualBounds\([^\n]+\) \{[\s\S]*?\n\}/u
)?.[0] ?? "";
const visualBoundsNearFunction = MOMENTS_VISUAL_ACTION_POWERSHELL.match(
  /function Test-VisualBoundsNear\([^\n]+\) \{[\s\S]*?\n\}/u
)?.[0] ?? "";
const visualBoundsInsideFunction = MOMENTS_VISUAL_ACTION_POWERSHELL.match(
  /function Test-VisualBoundsInside\([^\n]+\) \{[\s\S]*?\n\}/u
)?.[0] ?? "";
assert.ok(
  visualBoundsFunction && visualBoundsNearFunction && visualBoundsInsideFunction,
  "visual geometry helpers should be extractable"
);
const relockGeometryProgram = `${visualBoundsFunction}\n${visualBoundsNearFunction}\n$tolerance = ${MOMENTS_VISUAL_POST_RELOCK_TOLERANCE_PX.toFixed(1)}\n$expected = @{ left = 100.0; top = 200.0; width = 300.0; height = 180.0 }\n$within = @{ left = 112.0; top = 188.0; width = 312.0; height = 168.0 }\n$beyond = @{ left = 112.1; top = 200.0; width = 300.0; height = 180.0 }\n$alsoWithin = @{ left = 94.0; top = 205.0; width = 300.0; height = 180.0 }\n$matches = @(@($within, $alsoWithin) | Where-Object { Test-VisualBoundsNear $_ $expected $tolerance })\n@{ within = (Test-VisualBoundsNear $within $expected $tolerance); beyond = (Test-VisualBoundsNear $beyond $expected $tolerance); matchCount = $matches.Count; unique = ($matches.Count -eq 1) } | ConvertTo-Json -Compress`;
const relockGeometryHarness = spawnSync("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); Invoke-Expression $source"
], {
  input: Buffer.from(relockGeometryProgram, "utf8").toString("base64"),
  encoding: "utf8",
  windowsHide: true
});
assert.equal(relockGeometryHarness.status, 0, relockGeometryHarness.stderr || "visual relock geometry harness must run");
assert.deepEqual(JSON.parse(relockGeometryHarness.stdout.trim()), {
  matchCount: 2,
  beyond: false,
  unique: false,
  within: true
});

const visualMenuResolverFunction = MOMENTS_VISUAL_ACTION_POWERSHELL.match(
  /(function Resolve-VisualMenuAnchor\([\s\S]*?\n\})\n\nfunction ConvertTo-RelativeVisualBounds/u
)?.[1] ?? "";
assert.ok(visualMenuResolverFunction, "visual menu resolver should be extractable");
const visualMenuResolverProgram = `${visualBoundsFunction}
${visualBoundsNearFunction}
${visualMenuResolverFunction}
$expected = @{ left = 100.0; top = 200.0; width = 36.0; height = 24.0 }
$exact = @{ centerX = 118.0; centerY = 212.0; bounds = @{ left = 100.0; top = 200.0; width = 36.0; height = 24.0 } }
$overlap = @{ centerX = 118.8; centerY = 211.5; bounds = @{ left = 100.8; top = 199.5; width = 36.0; height = 24.0 } }
$distinct = @{ centerX = 126.0; centerY = 220.0; bounds = @{ left = 108.0; top = 208.0; width = 36.0; height = 24.0 } }
$deduped = Resolve-VisualMenuAnchor @($overlap, $exact) $expected 12.0
$nearest = Resolve-VisualMenuAnchor @($exact, $distinct) $expected 12.0
$missing = Resolve-VisualMenuAnchor @() $expected 12.0
@{
  dedupedOk = $deduped.ok
  dedupedRaw = $deduped.diagnostics.rawCandidateCount
  dedupedCount = $deduped.diagnostics.distinctCandidateCount
  chosenLeft = $deduped.menu.bounds.left
  nearestOk = $nearest.ok
  nearestLeft = $nearest.menu.bounds.left
  nearestCount = $nearest.diagnostics.distinctCandidateCount
  missingReason = $missing.reason
} | ConvertTo-Json -Compress`;
const visualMenuResolverHarness = spawnSync("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(visualMenuResolverProgram, "utf16le").toString("base64")
], {
  encoding: "utf8",
  windowsHide: true
});
assert.equal(visualMenuResolverHarness.status, 0, visualMenuResolverHarness.stderr || "visual menu resolver harness must run");
assert.deepEqual(JSON.parse(visualMenuResolverHarness.stdout.trim()), {
  missingReason: "moments_menu_not_found",
  nearestCount: 2,
  nearestLeft: 100,
  nearestOk: true,
  chosenLeft: 100,
  dedupedRaw: 2,
  dedupedCount: 1,
  dedupedOk: true
});

const visualSendButtonFunction = MOMENTS_VISUAL_ACTION_POWERSHELL.match(
  /function Get-VisualSendButton\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(visualSendButtonFunction, "visual send button detector should be extractable");
const visualGreenClassifierFunction = MOMENTS_VISUAL_ACTION_POWERSHELL.match(
  /function Test-VisualWechatGreenPixel\(\$pixel\) \{[\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(visualGreenClassifierFunction, "the production green classifier should be extractable");
const visualSendButtonProgram = `
$ErrorActionPreference = "Stop"
${visualGreenClassifierFunction}
function Get-MomentsPixel($frame, [int]$x, [int]$y) {
  return $(if ($frame.green.ContainsKey("$x,$y")) { $frame.green["$x,$y"] } else { $null })
}
${visualBoundsFunction}
${visualBoundsInsideFunction}
function Get-MomentsHighContrastOcrObservation($frame, $region, [int]$scale) {
  return @{ ok = $false; reason = "ocr_unavailable" }
}
function Normalize-VisualText([string]$value) { return $value }
function New-GreenFrame { return @{ green = @{} } }
function Add-GreenRect($frame, [int]$left, [int]$top, [int]$width, [int]$height) {
  $green = @{ r = 7; g = 168; b = 99 }
  for ($y = $top; $y -lt ($top + $height); $y++) {
    for ($x = $left; $x -lt ($left + $width); $x++) { $frame.green["$x,$y"] = $green }
  }
}
function Add-GreenInsetBorder($frame, [int]$width, [int]$height) {
  Add-GreenRect $frame 6 6 ($width - 12) 6
  Add-GreenRect $frame 6 ($height - 12) ($width - 12) 6
  Add-GreenRect $frame 6 6 6 ($height - 12)
  Add-GreenRect $frame ($width - 12) 6 6 ($height - 12)
}
${visualSendButtonFunction}
$composer = @{ ok = $true; bounds = @{ left = 0.0; top = 0.0; width = 420.0; height = 140.0 } }

$borderOnlyFrame = New-GreenFrame
Add-GreenInsetBorder $borderOnlyFrame 420 140
$borderOnly = Get-VisualSendButton $borderOnlyFrame $composer

$singleFrame = New-GreenFrame
Add-GreenInsetBorder $singleFrame 420 140
Add-GreenRect $singleFrame 315 82 86 36
$single = Get-VisualSendButton $singleFrame $composer

$twoFrame = New-GreenFrame
Add-GreenRect $twoFrame 288 82 55 36
Add-GreenRect $twoFrame 350 82 55 36
$two = Get-VisualSendButton $twoFrame $composer

$ocrEmptyFrame = New-GreenFrame
Add-GreenRect $ocrEmptyFrame 315 82 86 36
$ocrEmpty = Get-VisualSendButton $ocrEmptyFrame $composer

$nearEdgeFrame = New-GreenFrame
Add-GreenRect $nearEdgeFrame 326 96 88 36
$nearEdge = Get-VisualSendButton $nearEdgeFrame $composer

@{
  borderOnlyOk = [bool]$borderOnly.ok
  borderOnlyReason = [string]$borderOnly.reason
  singleOk = [bool]$single.ok
  singleCandidateCount = [int]$single.candidateCount
  twoOk = [bool]$two.ok
  twoReason = [string]$two.reason
  twoCandidateCount = [int]$two.candidateCount
  ocrEmptyOk = [bool]$ocrEmpty.ok
  ocrEmptyLabelVerified = [bool]$ocrEmpty.labelVerified
  nearEdgeOk = [bool]$nearEdge.ok
} | ConvertTo-Json -Compress
`;
const visualSendButtonHarness = spawnSync("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(visualSendButtonProgram, "utf16le").toString("base64"),
], {
  encoding: "utf8",
  windowsHide: true,
});
assert.equal(
  visualSendButtonHarness.status,
  0,
  visualSendButtonHarness.stderr || "visual send button component harness must run",
);
assert.deepEqual(JSON.parse(visualSendButtonHarness.stdout.trim()), {
  borderOnlyOk: false,
  borderOnlyReason: "moments_comment_send_button_not_found",
  nearEdgeOk: true,
  ocrEmptyLabelVerified: false,
  ocrEmptyOk: true,
  singleCandidateCount: 1,
  singleOk: true,
  twoCandidateCount: 2,
  twoOk: false,
  twoReason: "moments_comment_send_button_ambiguous",
});

const embeddedCSharp = MOMENTS_VISUAL_ACTION_POWERSHELL.match(/Add-Type @"\r?\n([\s\S]*?)\r?\n"@/u)?.[1] ?? "";
assert.ok(embeddedCSharp, "visual action embedded C# should be present");
const compiledVisualAction = spawnSync("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "Add-Type -TypeDefinition ([Console]::In.ReadToEnd()) -ErrorAction Stop"
], {
  input: embeddedCSharp,
  encoding: "utf8",
  windowsHide: true
});
assert.equal(compiledVisualAction.status, 0, compiledVisualAction.stderr || "visual action embedded C# must compile");

const script = MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT;

// The visual profile is an exact, unique window and render-pane identity.
assert.match(script, /\$processNames = @\("Weixin", "WeChat"\)/u);
assert.match(script, /\$title -cne "朋友圈"/u);
const windowSelection = script.match(/\[void\]\[Win32WechatMomentsVisualProbe\]::EnumWindows\(\$callback, \[IntPtr\]::Zero\)([\s\S]*?)\$matched = \$matches\[0\]/u)?.[1] ?? "";
assert.ok(windowSelection);
assert.match(windowSelection, /\$matches\.Count -ne 1[\s\S]*moments_window_ambiguous/u);
assert.match(script, /\$rootAutomationId -cne ""[\s\S]*\$rootName -cne "朋友圈"[\s\S]*\$rootControlType -cne "ControlType\.Window"[\s\S]*\$rootProcessId -ne \$matched\.pid/u);
const renderPaneEvidence = script.match(/function Get-MomentsRenderPaneEvidence\([^\n]+\) \{([\s\S]*?)\n\}/u)?.[1] ?? "";
assert.ok(renderPaneEvidence);
assert.match(renderPaneEvidence, /\$root\.FindAll\(\[System\.Windows\.Automation\.TreeScope\]::Children, \$paneType\)/u);
assert.match(renderPaneEvidence, /\$pane\.Current\.Name -cne "MMUIRenderSubWindowHW" -or \[int\]\$pane\.Current\.ProcessId -ne \$expectedPid/u);
assert.match(renderPaneEvidence, /\$controlType -cne "ControlType\.Pane"/u);
assert.match(renderPaneEvidence, /\$matches\.Count -ne 1[\s\S]*moments_render_pane_ambiguous/u);
assert.doesNotMatch(script, /\$title\s+-(?:like|match)\b/iu);

// This fallback must conflict with, rather than overlap, the UIA sns_list profile.
assert.match(script, /AutomationIdProperty,[\s\S]*"sns_list"/u);
assert.match(script, /\$feeds = \$root\.FindAll\(\[System\.Windows\.Automation\.TreeScope\]::Descendants, \$feedCondition\)/u);
assert.match(script, /\$feeds\.Count -ne 0[\s\S]*moments_visual_profile_conflict/u);

// Two independently captured observations must agree before a post is accepted.
const foregroundRecovery = script.match(
  /function Request-MomentsVisualForeground\([^\n]+\) \{([\s\S]*?)\n\}/u,
)?.[1] ?? "";
assert.ok(foregroundRecovery, "visual capture should have bounded foreground recovery");
assert.match(foregroundRecovery, /foreach \(\$delayMs in @\(80, 140, 220, 320\)\)/u);
assert.match(foregroundRecovery, /SetForegroundWindow\(\$hWnd\)[\s\S]*Start-Sleep -Milliseconds \$delayMs/u);
assert.match(
  script,
  /\$foregroundReady = Request-MomentsVisualForeground \$hWnd[\s\S]*if \(-not \$foregroundReady\)[\s\S]*moments_window_not_foreground/u,
);
assert.match(script, /\$firstFrame = Get-MomentsVisualFrame \$hWnd \$matched\.rect \$matched\.pid \$true/u);
assert.match(script, /\$secondFrame = Get-MomentsVisualFrame \$hWnd \$matched\.rect \$matched\.pid \$false/u);
assert.match(script, /Start-Sleep -Milliseconds 180/u);
assert.match(script, /Test-VisualMenuSequence \$firstRead\.menus \$secondRead\.menus/u);
assert.match(script, /Test-VisualPostSequence \$firstRead\.posts \$secondRead\.posts/u);
assert.match(script, /\$script:momentsVisualStabilityTolerancePx = 12\.0/u);
assert.doesNotMatch(script, /Test-Visual(?:Menu|Post)Sequence[\s\S]*?-gt 1\.5/u);
assert.match(script, /Test-MomentsStablePostIdentityText \(\[string\]\$left\[\$index\]\.identityText\) \(\[string\]\$right\[\$index\]\.identityText\) \(\[string\]\$left\[\$index\]\.stableAnchorText\) \(\[string\]\$right\[\$index\]\.stableAnchorText\)/u);
assert.match(script, /\[string\]\$left\[\$index\]\.avatarHash -cne \[string\]\$right\[\$index\]\.avatarHash/u);
assert.match(script, /foreach \(\$boundsField in @\("bounds", "menuBounds", "avatarBounds"\)\)/u);
assert.match(script, /Close-And-Write \$result \$firstFrame \$secondFrame/u);
const visualPostSelection = script.match(/\$posts = @\(\$secondRead\.posts\)([\s\S]*?)\$result = @\{/u)?.[1] ?? "";
assert.ok(visualPostSelection, "visual post selection should be present");
assert.doesNotMatch(visualPostSelection, /moments_post_ambiguous/u);
assert.match(visualPostSelection, /foreach \(\$post in \$posts\)/u);
assert.match(visualPostSelection, /\$absolutePosts\.Add\(/u);
assert.match(script, /posts = @\(\$absolutePosts\.ToArray\(\)\)/u);

// Relative-time presentation changes and one-character OCR jitter are accepted,
// while a genuinely different post remains rejected.
const similarityProgram = `${MOMENTS_VISUAL_READONLY_POWERSHELL}\n@{ relativeTime = (Test-MomentsStableContentSimilarity "小明 今日客户跟进记录 刚刚 评论" "小明 今日客户跟进记录 1分钟前 评论"); ocrJitter = (Test-MomentsStableContentSimilarity "小明 今日朋友圈内容用于稳定识别测试 刚刚" "小明 今日朋友圈內容用于稳定识别测试 1分钟前"); differentPost = (Test-MomentsStableContentSimilarity "小明 今日朋友圈内容用于稳定识别测试 刚刚" "小明 完全不同的一条广告活动内容 刚刚") } | ConvertTo-Json -Compress`;
const similarityHarness = spawnSync("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); Invoke-Expression $source"
], {
  input: Buffer.from(similarityProgram, "utf8").toString("base64"),
  encoding: "utf8",
  windowsHide: true
});
assert.equal(similarityHarness.status, 0, similarityHarness.stderr || "stable-content similarity harness must run");
assert.deepEqual(JSON.parse(similarityHarness.stdout.trim()), {
  relativeTime: true,
  ocrJitter: true,
  differentPost: false
});

// OCR identity, hashes, and all click-relevant geometry remain bound to the snapshot.
assert.match(script, /\[Windows\.Globalization\.Language\]::new\("zh-Hans-CN"\)/u);
assert.match(script, /\[Windows\.Media\.Ocr\.OcrEngine\]::TryCreateFromLanguage\(\$language\)/u);
assert.doesNotMatch(script, /TryCreateFromUserProfileLanguages/u);
assert.match(script, /\$digest = \$sha\.ComputeHash\(\$buffer\)/u);
assert.match(script, /\$layoutDigest = \$sha\.ComputeHash\(\$layoutBytes\)/u);
assert.match(script, /\$avatarHash = Get-MomentsPixelHash \$frame \$avatar\.bounds/u);
assert.match(script, /regionHash = \$regionHash/u);
assert.match(script, /avatarHash = \$avatarHash/u);
assert.match(script, /layoutHash = \[string\]\$ocr\.layoutHash/u);
const identityTextBuilder = script.match(/function Get-MomentsPostIdentityText\([^\n]+\) \{([\s\S]*?)\n\}/u)?.[1] ?? "";
assert.ok(identityTextBuilder);
assert.match(identityTextBuilder, /\$menuRowBottom = \[double\]\$menuBounds\.top \+ \[double\]\$menuBounds\.height - \[double\]\$postRect\.top/u);
assert.match(identityTextBuilder, /\$lineCenterY = \[double\]\$_\.bounds\.top \+ \(\[double\]\$_\.bounds\.height \/ 2\.0\)/u);
assert.match(identityTextBuilder, /\$lineCenterY -le \$menuRowBottom/u);
assert.match(script, /Get-MomentsPostIdentityText \$ocr \$postRect \$menu\.bounds/u);
assert.match(script, /identityText = \[string\]\$identityText/u);
assert.match(script, /stableAnchorText = \[string\]\$stableAnchorText/u);
assert.match(script, /identityText = \[string\]\$post\.identityText/u);
assert.match(script, /stableAnchorText = \[string\]\$post\.stableAnchorText/u);
assert.match(script, /avatarHash = \[string\]\$post\.avatarHash/u);
assert.match(script, /partialVisible = \[bool\]\$post\.partialVisible/u);

const stableAnchorFunction = MOMENTS_VISUAL_READONLY_POWERSHELL.match(
  /function Get-MomentsPostStableAnchorText\([^\n]+\) \{[\s\S]*?\n\}/u
)?.[0] ?? "";
assert.ok(stableAnchorFunction, "stable anchor builder should be extractable");
assert.match(stableAnchorFunction, /\$anchorLines\.Count -lt 2/u);
assert.match(stableAnchorFunction, /\$normalized\.Length -lt 16/u);
const stableAnchorProgram = `${stableAnchorFunction}
$ocr = @{ lines = @(
  @{ compact = "author stable"; bounds = @{ left = 70.0; top = 8.0; width = 120.0; height = 12.0 } },
  @{ compact = "fixed body line"; bounds = @{ left = 70.0; top = 30.0; width = 160.0; height = 16.0 } },
  @{ compact = "dynamic video subtitle"; bounds = @{ left = 70.0; top = 82.0; width = 190.0; height = 18.0 } },
  @{ compact = "55 minutes video channel"; bounds = @{ left = 70.0; top = 150.0; width = 190.0; height = 18.0 } }
) }
$post = @{ left = 100.0; top = 100.0; width = 500.0; height = 220.0 }
$avatar = @{ left = 106.0; top = 106.0; width = 50.0; height = 50.0 }
@{ anchor = (Get-MomentsPostStableAnchorText $ocr $post $avatar); authorOnly = (Get-MomentsPostStableAnchorText @{ lines = @($ocr.lines[0]) } $post $avatar) } | ConvertTo-Json -Compress`;
const stableAnchorHarness = spawnSync("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); Invoke-Expression $source"
], {
  input: Buffer.from(stableAnchorProgram, "utf8").toString("base64"),
  encoding: "utf8",
  windowsHide: true
});
assert.equal(stableAnchorHarness.status, 0, stableAnchorHarness.stderr || "stable anchor builder harness must run");
assert.deepEqual(JSON.parse(stableAnchorHarness.stdout.trim()), {
  authorOnly: "",
  anchor: "author stable fixed body line"
});
assert.match(probeSource, /function Get-MomentsVisualPostCandidates\(\$frame, \$viewportBounds\)/u);
assert.match(probeSource, /Find-MomentsMenuDots \$frame \| Where-Object \{ Test-MomentsVisualBoundsInside \$_\.bounds \$viewportBounds \}/u);
assert.match(probeSource, /Find-MomentsAvatarForMenu \$frame \$menus \$index \$viewportBounds/u);
assert.match(probeSource, /\$postBottom = \[Math\]::Min\(\$viewportBottom, \$unclippedPostBottom\)/u);
assert.match(probeSource, /partialVisible = \$unclippedPostBottom -gt \$viewportBottom/u);
assert.doesNotMatch(probeSource, /\$postBottom -gt \$safeBottom/u);
assert.match(script, /function Test-VisualBoundsInside\(\$inner, \$outer\)/u);
assert.match(script, /Test-VisualBoundsInside \$renderEvidence\.pane\.bounds \$windowBounds/u);
assert.match(script, /Get-MomentsVisualPostCandidates \$firstFrame \$relativeRenderPaneBounds/u);
assert.match(script, /Get-MomentsVisualPostCandidates \$secondFrame \$relativeRenderPaneBounds/u);
assert.match(script, /Test-VisualBoundsInside \$absoluteBounds \$renderEvidence\.pane\.bounds/u);
assert.match(script, /Test-VisualBoundsInside \$absoluteMenuBounds \$renderEvidence\.pane\.bounds/u);
assert.match(script, /Test-VisualBoundsInside \$absoluteAvatarBounds \$renderEvidence\.pane\.bounds/u);
assert.match(actionSource, /Get-MomentsVisualPostCandidates \$frame \$expectedRenderPaneBounds/u);
assert.match(actionSource, /boundsWithin\(snapshot\.menu_bounds, window\.renderPaneBounds\)/u);
assert.match(actionSource, /boundsWithin\(snapshot\.avatar_bounds, window\.renderPaneBounds\)/u);
for (const field of ["bounds", "menuBounds", "avatarBounds"]) {
  assert.match(script, new RegExp(`${field} = \\$absolute`, "u"));
}

// The current render profile uses exactly two substantial dots. Three tiny text
// ellipsis components are rejected by the per-dot size and pixel-count floor.
const menuMorphology = script.match(/function Find-MomentsMenuDots\(\$frame\) \{([\s\S]*?)\n\}/u)?.[1] ?? "";
assert.ok(menuMorphology);
assert.match(menuMorphology, /for \(\$firstIndex = 0; \$firstIndex -lt \$ordered\.Count; \$firstIndex\+\+\)/u);
assert.match(menuMorphology, /for \(\$secondIndex = \$firstIndex \+ 1; \$secondIndex -lt \$ordered\.Count; \$secondIndex\+\+\)/u);
assert.doesNotMatch(menuMorphology, /\$thirdIndex/u);
assert.match(menuMorphology, /\$first\.width -lt 4 -or \$first\.height -lt 3 -or \$first\.count -lt 10/u);
assert.match(menuMorphology, /\$second\.width -lt 4 -or \$second\.height -lt 3 -or \$second\.count -lt 10/u);
assert.match(menuMorphology, /\$matched = @\(\$first, \$second\)/u);
assert.match(menuMorphology, /Abs\(\$first\.centerY - \$second\.centerY\) -gt 2\.0/u);
assert.match(menuMorphology, /\$gapOne -lt 2 -or \$gapOne -gt 8/u);
assert.match(menuMorphology, /Abs\(\$first\.width - \$second\.width\) -gt 2/u);
assert.match(menuMorphology, /Abs\(\$first\.height - \$second\.height\) -gt 2/u);
assert.match(menuMorphology, /Abs\(\$first\.count - \$second\.count\) -gt 12/u);
assert.match(menuMorphology, /\$lightRatio -lt 0\.58/u);

// Screen capture is read-only: no cursor, mouse, keyboard, clipboard, or UIA
// input pattern may be introduced into either visual script.
const forbiddenInputTokens = [
  "SetCursorPos",
  "GetCursorPos",
  "mouse_event",
  "SendInput",
  "keybd_event",
  "SendKeys",
  "GetAsyncKeyState",
  "PostMessage",
  "SendMessage",
  "SetFocus",
  "InvokePattern",
  "LegacyIAccessiblePattern",
  "SelectionItemPattern",
  "TogglePattern",
  "ExpandCollapsePattern",
  "ValuePattern",
  "ScrollPattern",
  "Get-Clipboard",
  "Set-Clipboard",
  "OpenClipboard",
  "GetClipboardData",
  "SetClipboardData",
  "System.Windows.Forms.Clipboard"
];
for (const token of forbiddenInputTokens) {
  assert.equal(script.includes(token), false, `visual read-only probe must not contain ${token}`);
}

// The only bitmap Save serializes an OCR crop to memory; no path-backed image
// persistence or generic file-writing primitive is allowed.
const bitmapSaveCalls = MOMENTS_VISUAL_READONLY_POWERSHELL.match(/\.Save\s*\(/gu) ?? [];
assert.equal(bitmapSaveCalls.length, 1);
assert.match(MOMENTS_VISUAL_READONLY_POWERSHELL, /\$memory = \[IO\.MemoryStream\]::new\(\)/u);
assert.match(MOMENTS_VISUAL_READONLY_POWERSHELL, /\$crop\.Save\(\$memory, \[System\.Drawing\.Imaging\.ImageFormat\]::Png\)/u);
for (const token of ["FileStream", "WriteAllBytes", "WriteAllText", "Out-File", "Set-Content", "Add-Content", "Export-Clixml"]) {
  assert.equal(MOMENTS_VISUAL_READONLY_POWERSHELL.includes(token), false, `visual read-only probe must not persist with ${token}`);
}
assert.doesNotMatch(MOMENTS_VISUAL_READONLY_POWERSHELL, /\.Save\s*\(\s*["']/u);
assert.doesNotMatch(MOMENTS_VISUAL_READONLY_POWERSHELL, /\.Save\s*\(\s*\$(?:path|file|output|destination)\b/iu);

// The Node wrapper keeps PowerShell non-installing, STA, bounded, and diagnostic.
assert.match(
  dryRunSource,
  /runPowerShell\(MOMENTS_VISUAL_WINDOW_PROBE_SCRIPT, \{\}, \{ ensure: false, sta: true, timeout: 30000, diagnostics: true \}\)/u
);
assert.doesNotMatch(dryRunSource, /runPowerShell\([^\n]+ensure: true/u);
assert.match(probeSource, /module\.exports = \{ MOMENTS_VISUAL_READONLY_POWERSHELL \}/u);
assert.match(probeSource, /\$task\.Wait\(1500\)/u);
assert.doesNotMatch(probeSource, /\$task\.Wait\(\)/u);

// Visual actions remain test-only and fail closed before PowerShell when the
// immutable observation context is missing.
for (const name of ["comment", "commentOccurrenceCheck", "commentReadback", "inspectCommentDraft", "inspectMenu", "like"]) {
  assert.equal(typeof visualActionDriver[name], "function");
}
for (const name of ["comment", "commentOccurrenceCheck", "commentReadback", "inspectCommentDraft", "inspectMenu", "like"]) {
  const result = visualActionDriver[name]({});
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.actionAttempted, false);
}
assert.match(actionSource, /identityMode === "visual_mmui_render"/u);
assert.match(actionSource, /version: 5/u);
assert.match(actionSource, /avatarHash: String\(snapshot\.avatar_hash \?\? ""\)/u);
assert.match(actionSource, /SHA256_PATTERN\.test\(String\(snapshot\.avatar_hash \?\? ""\)\)/u);
assert.match(actionSource, /identityText: String\(snapshot\.identity_text \?\? ""\)/u);
assert.match(actionSource, /stableAnchorText: String\(snapshot\.stable_anchor_text\)/u);
assert.match(actionSource, /momentsPostFingerprint\(snapshot\.identity_text\) === snapshot\.post_fingerprint/u);
assert.match(actionSource, /post\.identityText[\s\S]*snapshot\.identity_text/u);
const stablePostIdentityFunction = MOMENTS_VISUAL_ACTION_POWERSHELL.match(
  /function Test-MomentsStablePostIdentity\([^\n]+\) \{[\s\S]*?\n\}/u
)?.[0] ?? "";
assert.ok(stablePostIdentityFunction, "stable post identity helper should be extractable");
const stablePostIdentityProgram = `${MOMENTS_VISUAL_READONLY_POWERSHELL}
${stablePostIdentityFunction}
$fullPost = @{ identityText = "same complete identity"; stableAnchorText = "" }
$fullSnapshot = @{ identity_text = "same complete identity"; stable_anchor_text = "" }
$dynamicPost = @{ identityText = "author fixed body zzzzz dynamic frame"; stableAnchorText = "author stable fixed body line" }
$dynamicSnapshot = @{ identity_text = "author fixed body aaaaa changing frame"; stable_anchor_text = "author stable fixed body line" }
$differentSnapshot = @{ identity_text = "author fixed body aaaaa changing frame"; stable_anchor_text = "different author and body text" }
$noAnchorPost = @{ identityText = "author fixed body zzzzz dynamic frame"; stableAnchorText = "" }
@{
  full = (Test-MomentsStablePostIdentity $fullPost $fullSnapshot)
  dynamic = (Test-MomentsStablePostIdentity $dynamicPost $dynamicSnapshot)
  different = (Test-MomentsStablePostIdentity $dynamicPost $differentSnapshot)
  missing = (Test-MomentsStablePostIdentity $noAnchorPost $dynamicSnapshot)
} | ConvertTo-Json -Compress`;
const stablePostIdentityHarness = spawnSync("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); Invoke-Expression $source"
], {
  input: Buffer.from(stablePostIdentityProgram, "utf8").toString("base64"),
  encoding: "utf8",
  windowsHide: true
});
assert.equal(stablePostIdentityHarness.status, 0, stablePostIdentityHarness.stderr || "stable post identity harness must run");
assert.deepEqual(JSON.parse(stablePostIdentityHarness.stdout.trim()), {
  missing: false,
  dynamic: true,
  different: false,
  full: true
});
const currentPostLock = actionSource.match(
  /function Get-CurrentLockedVisualPost\([\s\S]*?\n\}\n\nfunction Get-FreshVisualMenuAnchor/u
)?.[0] ?? "";
assert.ok(currentPostLock, "current visual post lock should be present");
assert.match(
  currentPostLock,
  /Get-MomentsVisualFrame \$lock\.hWnd \$lock\.windowRect \$lock\.pid \$activate \$false/u,
  "action relock should rely on the exact target checks instead of whole-window ownership"
);
assert.doesNotMatch(currentPostLock, /regionHash|region_hash/u);
assert.doesNotMatch(currentPostLock, /\$posts\.Count -ne 1/u);
assert.match(currentPostLock, /Test-MomentsStablePostIdentity \$post \$snapshot/u);
assert.match(currentPostLock, /\[string\]\$post\.avatarHash -cne \[string\]\$snapshot\.avatar_hash/u);
assert.doesNotMatch(currentPostLock, /snapshot\.layout_hash/u);
assert.match(currentPostLock, /\$matchingPosts\.Count -eq 0[\s\S]*moments_post_changed/u);
assert.match(currentPostLock, /\$matchingPosts\.Count -ne 1[\s\S]*moments_post_ambiguous/u);
assert.match(currentPostLock, /Test-VisualBoundsNear \$post\.bounds \$expectedBounds \$script:momentsVisualPostRelockTolerancePx/u);
assert.match(currentPostLock, /Test-VisualBoundsNear \$post\.menuBounds \$expectedMenuBounds \$script:momentsVisualPostRelockTolerancePx/u);
assert.match(currentPostLock, /Test-VisualBoundsNear \$post\.avatarBounds \$expectedAvatarBounds \$script:momentsVisualPostRelockTolerancePx/u);
assert.match(currentPostLock, /Resolve-VisualMenuAnchor \$read\.menus \$post\.menuBounds 1\.5[\s\S]*diagnostics = \$menuResolution\.diagnostics/u);
assert.match(currentPostLock, /\$avatarHash = Get-MomentsPixelHash \$frame \$post\.avatarBounds/u);
const freshMenuLock = actionSource.match(
  /function Get-FreshVisualMenuAnchor\([\s\S]*?\n\}\n\nfunction Test-VisualOwnedHit/u
)?.[0] ?? "";
assert.ok(freshMenuLock, "fresh visual menu lock should be present");
assert.match(
  freshMenuLock,
  /Get-MomentsVisualFrame \$lock\.hWnd \$lock\.windowRect \$lock\.pid \$activate \$false/u,
  "fresh menu relock should not fail on an unrelated transient overlay"
);
const openMenuReader = actionSource.match(
  /function Read-OpenVisualMenu\([\s\S]*?\n\}(?=\n\nfunction Open-LockedVisualMenu)/u
)?.[0] ?? "";
assert.ok(openMenuReader, "open visual menu reader should be present");
const openMenuReadOnceSource = actionSource.match(
  /function Read-OpenVisualMenuOnce\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(openMenuReadOnceSource, "single-frame open visual menu reader should be present");
const visualMenuTextEntryFunction = actionSource.match(
  /(function Get-VisualMenuTextEntry\([\s\S]*?\n\})\n\nfunction Get-VisualMenuLabelSignature/u,
)?.[1] ?? "";
assert.ok(visualMenuTextEntryFunction, "visual menu OCR entry parser should be extractable");
const visualMenuLabelSignatureFunction = actionSource.match(
  /(function Get-VisualMenuLabelSignature\([\s\S]*?\n\})\n\nfunction Get-VisualMenuTargetedOcrRegion/u,
)?.[1] ?? "";
assert.ok(visualMenuLabelSignatureFunction, "visual menu label signature reader should be extractable");
const visualMenuTargetedOcrRegionFunction = actionSource.match(
  /(function Get-VisualMenuTargetedOcrRegion\([\s\S]*?\n\})\n\nfunction Resolve-VisualLikeMenuState/u,
)?.[1] ?? "";
assert.ok(visualMenuTargetedOcrRegionFunction, "targeted menu OCR region builder should be extractable");
const visualLikeMenuStateFunction = actionSource.match(
  /(function Resolve-VisualLikeMenuState\([\s\S]*?\n\})\n\nfunction Read-OpenVisualMenuOnce/u,
)?.[1] ?? "";
assert.ok(visualLikeMenuStateFunction, "visual like menu state resolver should be extractable");
const visualLikeMenuStateProgram = `${visualLikeMenuStateFunction}
$likeSignature = @{ ok = $true; horizontalEdgeClear = $true; bounds = @{ left = 10.0; top = 20.0; width = 17.0; height = 10.0 }; centerX = 18.5; centerY = 25.0 }
$commentSignature = @{ ok = $true; horizontalEdgeClear = $true; bounds = @{ left = 30.0; top = 20.0; width = 35.0; height = 10.0 }; centerX = 47.5; centerY = 25.0 }
$like = Resolve-VisualLikeMenuState $null $likeSignature $commentSignature
$cancelSignature = @{ ok = $true; horizontalEdgeClear = $true; bounds = @{ left = 10.0; top = 20.0; width = 31.0; height = 10.0 }; centerX = 25.5; centerY = 25.0 }
$cancel = Resolve-VisualLikeMenuState $null $cancelSignature $commentSignature
$gapSignature = @{ ok = $true; horizontalEdgeClear = $true; bounds = @{ left = 10.0; top = 20.0; width = 27.0; height = 10.0 }; centerX = 23.5; centerY = 25.0 }
$gap = Resolve-VisualLikeMenuState $null $gapSignature $commentSignature
$boundaryReferenceSignature = @{ ok = $true; horizontalEdgeClear = $true; bounds = @{ left = 120.0; top = 20.0; width = 100.0; height = 10.0 }; centerX = 170.0; centerY = 25.0 }
$lowerBoundarySignature = @{ ok = $true; horizontalEdgeClear = $true; bounds = @{ left = 10.0; top = 20.0; width = 42.0; height = 10.0 }; centerX = 31.0; centerY = 25.0 }
$upperBoundarySignature = @{ ok = $true; horizontalEdgeClear = $true; bounds = @{ left = 10.0; top = 20.0; width = 60.0; height = 10.0 }; centerX = 40.0; centerY = 25.0 }
$belowBoundarySignature = @{ ok = $true; horizontalEdgeClear = $true; bounds = @{ left = 10.0; top = 20.0; width = 41.0; height = 10.0 }; centerX = 30.5; centerY = 25.0 }
$aboveBoundarySignature = @{ ok = $true; horizontalEdgeClear = $true; bounds = @{ left = 10.0; top = 20.0; width = 61.0; height = 10.0 }; centerX = 40.5; centerY = 25.0 }
$lowerBoundary = Resolve-VisualLikeMenuState $null $lowerBoundarySignature $boundaryReferenceSignature
$upperBoundary = Resolve-VisualLikeMenuState $null $upperBoundarySignature $boundaryReferenceSignature
$belowBoundary = Resolve-VisualLikeMenuState $null $belowBoundarySignature $boundaryReferenceSignature
$aboveBoundary = Resolve-VisualLikeMenuState $null $aboveBoundarySignature $boundaryReferenceSignature
$shortSignature = @{ ok = $true; horizontalEdgeClear = $true; bounds = @{ left = 10.0; top = 20.0; width = 17.0; height = 7.0 }; centerX = 18.5; centerY = 23.5 }
$short = Resolve-VisualLikeMenuState $null $shortSignature $commentSignature
$tallSignature = @{ ok = $true; horizontalEdgeClear = $true; bounds = @{ left = 10.0; top = 20.0; width = 17.0; height = 13.0 }; centerX = 18.5; centerY = 26.5 }
$tall = Resolve-VisualLikeMenuState $null $tallSignature $commentSignature
$missingReference = Resolve-VisualLikeMenuState $null $likeSignature @{ ok = $false }
$croppedLike = Resolve-VisualLikeMenuState $null @{
  ok = $true
  horizontalEdgeClear = $false
  bounds = @{ left = 10.0; top = 20.0; width = 17.0; height = 10.0 }
  centerX = 18.5
  centerY = 25.0
} $commentSignature
$croppedLikeVerify = Resolve-VisualLikeMenuState $null @{
  ok = $true
  horizontalEdgeClear = $false
  bounds = @{ left = 10.0; top = 20.0; width = 17.0; height = 10.0 }
  centerX = 18.5
  centerY = 25.0
} $commentSignature "ocr" "verify_outcome"
$croppedCancelSignature = @{
  ok = $true
  horizontalEdgeClear = $false
  bounds = @{ left = 10.0; top = 20.0; width = 31.0; height = 10.0 }
  centerX = 25.5
  centerY = 25.0
}
$croppedCancelAuthorize = Resolve-VisualLikeMenuState $null $croppedCancelSignature $commentSignature "ocr" "authorize_action"
$croppedCancelVerify = Resolve-VisualLikeMenuState $null $croppedCancelSignature $commentSignature "ocr" "verify_outcome"
$croppedCancelUnknownPurpose = Resolve-VisualLikeMenuState $null $croppedCancelSignature $commentSignature "ocr" "unexpected"
$croppedComment = Resolve-VisualLikeMenuState $null $likeSignature @{
  ok = $true
  horizontalEdgeClear = $false
  bounds = @{ left = 30.0; top = 20.0; width = 35.0; height = 10.0 }
  centerX = 47.5
  centerY = 25.0
}
$ocrEntry = @{ text = "赞"; bounds = @{ left = 10.0; top = 20.0; width = 17.0; height = 10.0 }; centerX = 18.5; centerY = 25.0 }
$ocr = Resolve-VisualLikeMenuState $ocrEntry @{ ok = $false } @{ ok = $false }
$cancelOcrEntry = @{ text = "取消"; bounds = @{ left = 10.0; top = 20.0; width = 31.0; height = 10.0 }; centerX = 25.5; centerY = 25.0 }
$cancelOcr = Resolve-VisualLikeMenuState $cancelOcrEntry $likeSignature $commentSignature
$croppedTargetedOcr = Resolve-VisualLikeMenuState $ocrEntry @{
  ok = $true
  horizontalEdgeClear = $false
  bounds = @{ left = 10.0; top = 20.0; width = 17.0; height = 10.0 }
  centerX = 18.5
  centerY = 25.0
} $commentSignature "targeted_ocr"
@{
  likeOk = ([string]$like.entry.text -ceq "赞")
  likeMode = [string]$like.mode
  cancelOk = ([string]$cancel.entry.text -ceq "取消")
  cancelMode = [string]$cancel.mode
  gapHasEntry = ($gap.entry -ne $null)
  gapMode = [string]$gap.mode
  shortHasEntry = ($short.entry -ne $null)
  shortMode = [string]$short.mode
  tallHasEntry = ($tall.entry -ne $null)
  tallMode = [string]$tall.mode
  missingReferenceHasEntry = ($missingReference.entry -ne $null)
  missingReferenceMode = [string]$missingReference.mode
  croppedLikeHasEntry = ($croppedLike.entry -ne $null)
  croppedLikeMode = [string]$croppedLike.mode
  croppedLikeVerifyHasEntry = ($croppedLikeVerify.entry -ne $null)
  croppedLikeVerifyMode = [string]$croppedLikeVerify.mode
  croppedCancelAuthorizeHasEntry = ($croppedCancelAuthorize.entry -ne $null)
  croppedCancelAuthorizeMode = [string]$croppedCancelAuthorize.mode
  croppedCancelVerifyOk = ([string]$croppedCancelVerify.entry.text -ceq "取消")
  croppedCancelVerifyMode = [string]$croppedCancelVerify.mode
  croppedCancelVerifyRequiresStability = [bool]$croppedCancelVerify.requiresStability
  croppedCancelUnknownPurposeHasEntry = ($croppedCancelUnknownPurpose.entry -ne $null)
  croppedCancelUnknownPurpose = [string]$croppedCancelUnknownPurpose.proofPurpose
  croppedCommentHasEntry = ($croppedComment.entry -ne $null)
  croppedCommentMode = [string]$croppedComment.mode
  lowerBoundaryOk = ([string]$lowerBoundary.entry.text -ceq "赞")
  lowerBoundaryMode = [string]$lowerBoundary.mode
  upperBoundaryOk = ([string]$upperBoundary.entry.text -ceq "赞")
  upperBoundaryMode = [string]$upperBoundary.mode
  belowBoundaryHasEntry = ($belowBoundary.entry -ne $null)
  belowBoundaryMode = [string]$belowBoundary.mode
  aboveBoundaryHasEntry = ($aboveBoundary.entry -ne $null)
  aboveBoundaryMode = [string]$aboveBoundary.mode
  ocrOk = ([string]$ocr.entry.text -ceq "赞")
  ocrMode = [string]$ocr.mode
  cancelOcrOk = ([string]$cancelOcr.entry.text -ceq "取消")
  cancelOcrMode = [string]$cancelOcr.mode
  croppedTargetedOcrHasEntry = ($croppedTargetedOcr.entry -ne $null)
  croppedTargetedOcrMode = [string]$croppedTargetedOcr.mode
} | ConvertTo-Json -Compress`;
const visualLikeMenuStateHarness = spawnSync("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(visualLikeMenuStateProgram, "utf16le").toString("base64")
], {
  encoding: "utf8",
  windowsHide: true
});
assert.equal(
  visualLikeMenuStateHarness.status,
  0,
  visualLikeMenuStateHarness.stderr || "visual like menu state resolver harness must run"
);
assert.deepEqual(JSON.parse(visualLikeMenuStateHarness.stdout.trim()), {
  aboveBoundaryHasEntry: false,
  aboveBoundaryMode: "ambiguous",
  belowBoundaryHasEntry: false,
  belowBoundaryMode: "ambiguous",
  cancelOk: true,
  cancelMode: "visual_signature",
  cancelOcrOk: true,
  cancelOcrMode: "ocr",
  croppedCancelAuthorizeHasEntry: false,
  croppedCancelAuthorizeMode: "ambiguous",
  croppedCancelUnknownPurpose: "authorize_action",
  croppedCancelUnknownPurposeHasEntry: false,
  croppedCancelVerifyMode: "visual_signature",
  croppedCancelVerifyOk: true,
  croppedCancelVerifyRequiresStability: true,
  croppedCommentHasEntry: false,
  croppedCommentMode: "ambiguous",
  croppedLikeHasEntry: false,
  croppedLikeMode: "ambiguous",
  croppedLikeVerifyHasEntry: false,
  croppedLikeVerifyMode: "ambiguous",
  croppedTargetedOcrHasEntry: false,
  croppedTargetedOcrMode: "ambiguous",
  gapHasEntry: false,
  gapMode: "ambiguous",
  lowerBoundaryOk: true,
  lowerBoundaryMode: "visual_signature",
  likeOk: true,
  likeMode: "visual_signature",
  missingReferenceHasEntry: false,
  missingReferenceMode: "ambiguous",
  ocrOk: true,
  ocrMode: "ocr",
  shortHasEntry: false,
  shortMode: "ambiguous",
  tallHasEntry: false,
  tallMode: "ambiguous",
  upperBoundaryOk: true,
  upperBoundaryMode: "visual_signature"
});
const visualLikeMenuReaderProgram = `
${visualMenuTextEntryFunction}
${visualMenuLabelSignatureFunction}
${visualMenuTargetedOcrRegionFunction}
${visualLikeMenuStateFunction}
${openMenuReadOnceSource}
$script:readerScenario = ""
function Get-MomentsVisualFrame { return @{ ok = $true; width = 600; height = 800 } }
function Get-VisualOpenMenuBounds {
  return @{
    ok = $true
    bounds = @{ left = 200.0; top = 100.0; width = 200.0; height = 44.0 }
    diagnostics = @{ segmentCount = 2; strictCandidateCount = 1; fallbackCandidateCount = 0 }
  }
}
function Get-MomentsPixel($frame, [int]$x, [int]$y) {
  $light = @{ r = 220; g = 220; b = 220 }
  $dark = @{ r = 20; g = 20; b = 20 }
  if ($y -lt 112 -or $y -gt 121) { return $dark }
  if ($x -ge 350 -and $x -le 384) { return $light }
  if ($script:readerScenario -ceq "cancel" -and $x -ge 258 -and $x -le 288) { return $light }
  if ($script:readerScenario -ceq "cancel_cropped" -and $x -ge 252 -and $x -le 282) { return $light }
  if ($script:readerScenario -ceq "cropped" -and $x -ge 252 -and $x -le 268) { return $light }
  if (@("like", "like_ocr_miss") -contains $script:readerScenario -and $x -ge 260 -and $x -le 276) { return $light }
  return $dark
}
function Test-VisualBounds($bounds, [double]$minimumWidth, [double]$minimumHeight) {
  return [double]$bounds.width -ge $minimumWidth -and [double]$bounds.height -ge $minimumHeight
}
function Normalize-VisualText([string]$value) { return $value }
function Test-VisualBoundsInside($inner, $outer) {
  return [double]$inner.left -ge [double]$outer.left -and
    [double]$inner.top -ge [double]$outer.top -and
    ([double]$inner.left + [double]$inner.width) -le ([double]$outer.left + [double]$outer.width) -and
    ([double]$inner.top + [double]$inner.height) -le ([double]$outer.top + [double]$outer.height)
}
function Get-MomentsHighContrastOcrObservation($frame, $region, [int]$scale = 4) {
  if (@("like", "cropped") -contains $script:readerScenario -and [bool]$region.targetedLike) {
    return @{
      ok = $true
      text = "赞"
      words = @(@{ bounds = @{ left = 4.0; top = 4.0; width = 10.0; height = 10.0 } })
    }
  }
  return @{ ok = $false }
}
function Get-MomentsScaledOcrObservation { return @{ ok = $false } }
function Close-MomentsVisualFrame {}
function Invoke-ReaderCase([string]$scenario, [string]$proofPurpose = "authorize_action") {
  $script:readerScenario = $scenario
  $result = Read-OpenVisualMenuOnce @{} @{} "like" $proofPurpose
  return [pscustomobject]@{
    scenario = $scenario
    proofPurpose = $proofPurpose
    ok = [bool]$result.ok
    expectedState = ([string]$result.menuState -ceq $(if ($scenario -like "cancel*") { "取消" } else { "赞" }))
    resolutionMode = [string]$result.diagnostics.likeResolutionMode
    requiresStability = [bool]$result.diagnostics.requiresStability
    likeOcrMatched = [bool]$result.diagnostics.likeOcrMatched
    likeBaseOcrMatched = [bool]$result.diagnostics.likeBaseOcrMatched
    targetedLikeOcrAttempted = [bool]$result.diagnostics.targetedLikeOcrAttempted
    targetedLikeOcrMatched = [bool]$result.diagnostics.targetedLikeOcrMatched
    commentOcrMatched = [bool]$result.diagnostics.commentOcrMatched
    likeEdgeClear = [bool]$result.diagnostics.likeSignatureEdgeClear
    commentEdgeClear = [bool]$result.diagnostics.commentSignatureEdgeClear
  }
}
@(
  (Invoke-ReaderCase "like"),
  (Invoke-ReaderCase "like_ocr_miss"),
  (Invoke-ReaderCase "cancel"),
  (Invoke-ReaderCase "cropped"),
  (Invoke-ReaderCase "cancel_cropped"),
  (Invoke-ReaderCase "cancel_cropped" "verify_outcome")
) | ConvertTo-Json -Depth 5 -Compress
`;
const visualLikeMenuReaderScript = path.join(
  os.tmpdir(),
  `xiaoxi-moments-menu-reader-${process.pid}-${Date.now()}.ps1`,
);
let visualLikeMenuReaderHarness;
try {
  fs.writeFileSync(visualLikeMenuReaderScript, `\uFEFF${visualLikeMenuReaderProgram}`, "utf8");
  visualLikeMenuReaderHarness = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", visualLikeMenuReaderScript],
    { encoding: "utf8", windowsHide: true },
  );
} finally {
  fs.rmSync(visualLikeMenuReaderScript, { force: true });
}
assert.equal(
  visualLikeMenuReaderHarness.status,
  0,
  visualLikeMenuReaderHarness.stderr
    || visualLikeMenuReaderHarness.error?.stack
    || `production menu reader harness must run (signal=${visualLikeMenuReaderHarness.signal ?? "none"})`,
);
assert.deepEqual(JSON.parse(visualLikeMenuReaderHarness.stdout.trim()), [
  {
    scenario: "like",
    proofPurpose: "authorize_action",
    ok: true,
    expectedState: true,
    resolutionMode: "targeted_ocr",
    requiresStability: false,
    likeOcrMatched: true,
    likeBaseOcrMatched: false,
    targetedLikeOcrAttempted: true,
    targetedLikeOcrMatched: true,
    commentOcrMatched: false,
    likeEdgeClear: true,
    commentEdgeClear: true,
  },
  {
    scenario: "like_ocr_miss",
    proofPurpose: "authorize_action",
    ok: true,
    expectedState: true,
    resolutionMode: "visual_signature",
    requiresStability: false,
    likeOcrMatched: false,
    likeBaseOcrMatched: false,
    targetedLikeOcrAttempted: true,
    targetedLikeOcrMatched: false,
    commentOcrMatched: false,
    likeEdgeClear: true,
    commentEdgeClear: true,
  },
  {
    scenario: "cancel",
    proofPurpose: "authorize_action",
    ok: true,
    expectedState: true,
    resolutionMode: "visual_signature",
    requiresStability: false,
    likeOcrMatched: false,
    likeBaseOcrMatched: false,
    targetedLikeOcrAttempted: true,
    targetedLikeOcrMatched: false,
    commentOcrMatched: false,
    likeEdgeClear: true,
    commentEdgeClear: true,
  },
  {
    scenario: "cropped",
    proofPurpose: "authorize_action",
    ok: false,
    expectedState: false,
    resolutionMode: "ambiguous",
    requiresStability: false,
    likeOcrMatched: true,
    likeBaseOcrMatched: false,
    targetedLikeOcrAttempted: true,
    targetedLikeOcrMatched: true,
    commentOcrMatched: false,
    likeEdgeClear: false,
    commentEdgeClear: true,
  },
  {
    scenario: "cancel_cropped",
    proofPurpose: "authorize_action",
    ok: false,
    expectedState: false,
    resolutionMode: "ambiguous",
    requiresStability: false,
    likeOcrMatched: false,
    likeBaseOcrMatched: false,
    targetedLikeOcrAttempted: true,
    targetedLikeOcrMatched: false,
    commentOcrMatched: false,
    likeEdgeClear: false,
    commentEdgeClear: true,
  },
  {
    scenario: "cancel_cropped",
    proofPurpose: "verify_outcome",
    ok: true,
    expectedState: true,
    resolutionMode: "visual_signature",
    requiresStability: true,
    likeOcrMatched: false,
    likeBaseOcrMatched: false,
    targetedLikeOcrAttempted: true,
    targetedLikeOcrMatched: false,
    commentOcrMatched: false,
    likeEdgeClear: false,
    commentEdgeClear: true,
  },
]);
assert.doesNotMatch(
  openMenuReader,
  /Invoke-VisualOwnedClick|AtomicMouse|Keyboard|Clipboard|SetCursorPos|Focus-|Open-LockedVisualMenu|Close-VisualMenu/u,
  "an ambiguous menu frame may only trigger one passive reread",
);
assert.match(openMenuReader, /Read-OpenVisualMenuOnce \$lock \$menu \$requestedAction \$normalizedProofPurpose/u);
for (const field of [
  "menuReadRetryCount",
  "firstReason",
  "secondReason",
  "requestedAction",
  "proofPurpose",
  "firstRequiresStability",
  "secondRequiresStability",
  "outcomeObservationCount",
  "firstSegmentCount",
  "secondSegmentCount",
  "firstStrictCandidateCount",
  "secondStrictCandidateCount",
  "firstFallbackCandidateCount",
  "secondFallbackCandidateCount",
  "firstLikeOcrMatched",
  "firstLikeBaseOcrMatched",
  "firstTargetedLikeOcrAttempted",
  "firstTargetedLikeOcrMatched",
  "firstCommentOcrMatched",
  "firstLikeSignatureOk",
  "firstCommentSignatureOk",
  "firstLikeSignatureEdgeClear",
  "firstCommentSignatureEdgeClear",
  "firstLikeResolutionMode",
  "firstWidthRatio",
  "firstHeightRatio",
  "secondLikeOcrMatched",
  "secondLikeBaseOcrMatched",
  "secondTargetedLikeOcrAttempted",
  "secondTargetedLikeOcrMatched",
  "secondCommentOcrMatched",
  "secondLikeSignatureOk",
  "secondCommentSignatureOk",
  "secondLikeSignatureEdgeClear",
  "secondCommentSignatureEdgeClear",
  "secondLikeResolutionMode",
  "secondWidthRatio",
  "secondHeightRatio",
]) {
  assert.match(openMenuReader, new RegExp(`\\b${field}\\b`, "u"), `menu retry diagnostics must include ${field}`);
}
const passiveMenuRetryProbeSource = `
${openMenuReader}
$script:menuScenario = ""
$script:menuReadCount = 0
function Start-Sleep { param([int]$Milliseconds) }
function Read-OpenVisualMenuOnce($lock, $menu, [string]$requestedAction, [string]$proofPurpose = "authorize_action") {
  $script:menuReadCount += 1
  if ($script:menuScenario -ceq "retry_success" -and $script:menuReadCount -eq 1) {
    return @{
      ok = $false
      reason = "moments_menu_surface_ambiguous"
      diagnostics = @{ segmentCount = 3; strictCandidateCount = 0; fallbackCandidateCount = 2 }
    }
  }
  if ($script:menuScenario -ceq "retry_failure") {
    $segmentCount = $(if ($script:menuReadCount -eq 1) { 3 } else { 4 })
    $fallbackCount = $(if ($script:menuReadCount -eq 1) { 2 } else { 3 })
    return @{
      ok = $false
      reason = "moments_menu_surface_ambiguous"
      diagnostics = @{ segmentCount = $segmentCount; strictCandidateCount = 0; fallbackCandidateCount = $fallbackCount }
    }
  }
  return @{
    ok = $true
    menuState = "unknown"
    comment = @{ centerX = 450.0; centerY = 320.0 }
    menuSurface = @{ left = 320.0; top = 290.0; width = 180.0; height = 60.0 }
    diagnostics = @{ segmentCount = 1; strictCandidateCount = 1; fallbackCandidateCount = 0 }
  }
}
function Invoke-MenuRetryCase([string]$scenario) {
  $script:menuScenario = $scenario
  $script:menuReadCount = 0
  $result = Read-OpenVisualMenu @{} @{} "comment"
  return [pscustomobject]@{
    scenario = $scenario
    ok = [bool]$result.ok
    reason = [string]$result.reason
    reads = $script:menuReadCount
    menuReadRetryCount = [int]$result.diagnostics.menuReadRetryCount
    firstReason = [string]$result.diagnostics.firstReason
    secondReason = [string]$result.diagnostics.secondReason
    requestedAction = [string]$result.diagnostics.requestedAction
    firstSegmentCount = [int]$result.diagnostics.firstSegmentCount
    secondSegmentCount = [int]$result.diagnostics.secondSegmentCount
    firstStrictCandidateCount = [int]$result.diagnostics.firstStrictCandidateCount
    secondStrictCandidateCount = [int]$result.diagnostics.secondStrictCandidateCount
    firstFallbackCandidateCount = [int]$result.diagnostics.firstFallbackCandidateCount
    secondFallbackCandidateCount = [int]$result.diagnostics.secondFallbackCandidateCount
  }
}
@(
  (Invoke-MenuRetryCase "first_success"),
  (Invoke-MenuRetryCase "retry_success"),
  (Invoke-MenuRetryCase "retry_failure")
) | ConvertTo-Json -Depth 6 -Compress
`;
const passiveMenuRetryProbe = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(passiveMenuRetryProbeSource, "utf16le").toString("base64")],
  { encoding: "utf8", windowsHide: true },
);
assert.equal(passiveMenuRetryProbe.status, 0, passiveMenuRetryProbe.stderr || "passive menu retry probe must run");
assert.deepEqual(JSON.parse(passiveMenuRetryProbe.stdout.trim()), [
  {
    scenario: "first_success",
    ok: true,
    reason: "",
    reads: 1,
    menuReadRetryCount: 0,
    firstReason: "",
    secondReason: "",
    requestedAction: "comment",
    firstSegmentCount: 1,
    secondSegmentCount: 0,
    firstStrictCandidateCount: 1,
    secondStrictCandidateCount: 0,
    firstFallbackCandidateCount: 0,
    secondFallbackCandidateCount: 0,
  },
  {
    scenario: "retry_success",
    ok: true,
    reason: "",
    reads: 2,
    menuReadRetryCount: 1,
    firstReason: "moments_menu_surface_ambiguous",
    secondReason: "",
    requestedAction: "comment",
    firstSegmentCount: 3,
    secondSegmentCount: 1,
    firstStrictCandidateCount: 0,
    secondStrictCandidateCount: 1,
    firstFallbackCandidateCount: 2,
    secondFallbackCandidateCount: 0,
  },
  {
    scenario: "retry_failure",
    ok: false,
    reason: "moments_menu_surface_ambiguous",
    reads: 2,
    menuReadRetryCount: 1,
    firstReason: "moments_menu_surface_ambiguous",
    secondReason: "moments_menu_surface_ambiguous",
    requestedAction: "comment",
    firstSegmentCount: 3,
    secondSegmentCount: 4,
    firstStrictCandidateCount: 0,
    secondStrictCandidateCount: 0,
    firstFallbackCandidateCount: 2,
    secondFallbackCandidateCount: 3,
  },
]);
const outcomeStabilityProbeSource = `
${openMenuReader}
$script:outcomeFrames = @()
$script:outcomeReadCount = 0
function Start-Sleep { param([int]$Milliseconds) }
function Test-VisualBoundsNear($left, $right, [double]$tolerance) {
  if ($left -eq $null -or $right -eq $null) { return $false }
  return [Math]::Abs([double]$left.left - [double]$right.left) -le $tolerance -and
    [Math]::Abs([double]$left.top - [double]$right.top) -le $tolerance -and
    [Math]::Abs([double]$left.width - [double]$right.width) -le $tolerance -and
    [Math]::Abs([double]$left.height - [double]$right.height) -le $tolerance
}
function New-OutcomeFrame(
  [bool]$ok,
  [string]$state,
  [bool]$requiresStability,
  [double]$left = 100.0,
  [string]$reason = ""
) {
  if (-not $ok) {
    return @{
      ok = $false
      reason = $(if ($reason) { $reason } else { "moments_menu_ambiguous" })
      diagnostics = @{
        segmentCount = 1
        strictCandidateCount = 1
        fallbackCandidateCount = 0
        requiresStability = $false
        likeResolutionMode = "ambiguous"
      }
    }
  }
  return @{
    ok = $true
    menuState = $state
    like = @{ bounds = @{ left = $left; top = 120.0; width = 31.0; height = 10.0 } }
    menuSurface = @{ left = $left - 20.0; top = 100.0; width = 200.0; height = 44.0 }
    diagnostics = @{
      segmentCount = 1
      strictCandidateCount = 1
      fallbackCandidateCount = 0
      requiresStability = $requiresStability
      likeResolutionMode = "visual_signature"
    }
  }
}
function Read-OpenVisualMenuOnce($lock, $menu, [string]$requestedAction, [string]$proofPurpose = "authorize_action") {
  $frame = $script:outcomeFrames[$script:outcomeReadCount]
  $script:outcomeReadCount += 1
  return $frame
}
function Invoke-OutcomeStabilityCase([string]$scenario) {
  $script:outcomeReadCount = 0
  if ($scenario -ceq "stable") {
    $script:outcomeFrames = @(
      (New-OutcomeFrame $true "取消" $true 100.0),
      (New-OutcomeFrame $true "取消" $true 101.0)
    )
  } elseif ($scenario -ceq "drift") {
    $script:outcomeFrames = @(
      (New-OutcomeFrame $true "取消" $true 100.0),
      (New-OutcomeFrame $true "取消" $true 110.0)
    )
  } elseif ($scenario -ceq "single_weak") {
    $script:outcomeFrames = @(
      (New-OutcomeFrame $false "" $false 100.0 "moments_menu_ambiguous"),
      (New-OutcomeFrame $true "取消" $true 100.0)
    )
  } else {
    $script:outcomeFrames = @(
      (New-OutcomeFrame $true "取消" $true 100.0),
      (New-OutcomeFrame $true "赞" $false 100.0)
    )
  }
  $result = Read-OpenVisualMenu @{} @{} "like" "verify_outcome"
  return [pscustomobject]@{
    scenario = $scenario
    ok = [bool]$result.ok
    reason = [string]$result.reason
    reads = $script:outcomeReadCount
    proofPurpose = [string]$result.diagnostics.proofPurpose
    observationCount = [int]$result.diagnostics.outcomeObservationCount
  }
}
@(
  (Invoke-OutcomeStabilityCase "stable"),
  (Invoke-OutcomeStabilityCase "drift"),
  (Invoke-OutcomeStabilityCase "single_weak"),
  (Invoke-OutcomeStabilityCase "changed")
) | ConvertTo-Json -Depth 6 -Compress
`;
const outcomeStabilityProbe = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(outcomeStabilityProbeSource, "utf16le").toString("base64")],
  { encoding: "utf8", windowsHide: true },
);
assert.equal(
  outcomeStabilityProbe.status,
  0,
  outcomeStabilityProbe.stderr || "post-click outcome stability probe must run",
);
assert.deepEqual(JSON.parse(outcomeStabilityProbe.stdout.trim()), [
  {
    scenario: "stable",
    ok: true,
    reason: "",
    reads: 2,
    proofPurpose: "verify_outcome",
    observationCount: 2,
  },
  {
    scenario: "drift",
    ok: false,
    reason: "moments_menu_ambiguous",
    reads: 2,
    proofPurpose: "verify_outcome",
    observationCount: 1,
  },
  {
    scenario: "single_weak",
    ok: false,
    reason: "moments_menu_ambiguous",
    reads: 2,
    proofPurpose: "verify_outcome",
    observationCount: 1,
  },
  {
    scenario: "changed",
    ok: false,
    reason: "moments_menu_ambiguous",
    reads: 2,
    proofPurpose: "verify_outcome",
    observationCount: 1,
  },
]);
const menuLabelDiagnosticsProbeSource = `
${openMenuReader}
$script:menuReadCount = 0
function Start-Sleep { param([int]$Milliseconds) }
function Read-OpenVisualMenuOnce($lock, $menu, [string]$requestedAction, [string]$proofPurpose = "authorize_action") {
  $script:menuReadCount += 1
  if ($script:menuReadCount -eq 1) {
    return @{
      ok = $false
      reason = "moments_menu_ambiguous"
      diagnostics = @{
        segmentCount = 2
        strictCandidateCount = 1
        fallbackCandidateCount = 0
        likeOcrMatched = $false
        likeBaseOcrMatched = $false
        targetedLikeOcrAttempted = $true
        targetedLikeOcrMatched = $false
        commentOcrMatched = $false
        likeSignatureOk = $true
        commentSignatureOk = $true
        likeSignatureEdgeClear = $false
        commentSignatureEdgeClear = $true
        likeResolutionMode = "ambiguous"
        widthRatio = 0.70
        heightRatio = 1.00
      }
    }
  }
  return @{
    ok = $false
    reason = "moments_menu_ambiguous"
    diagnostics = @{
      segmentCount = 2
      strictCandidateCount = 1
      fallbackCandidateCount = 0
      likeOcrMatched = $false
      likeBaseOcrMatched = $false
      targetedLikeOcrAttempted = $true
      targetedLikeOcrMatched = $false
      commentOcrMatched = $true
      likeSignatureOk = $false
      commentSignatureOk = $true
      likeSignatureEdgeClear = $false
      commentSignatureEdgeClear = $true
      likeResolutionMode = "ambiguous"
      widthRatio = 0.00
      heightRatio = 0.00
    }
  }
}
$result = Read-OpenVisualMenu @{} @{} "like"
@{
  firstLikeOcrMatched = [bool]$result.diagnostics.firstLikeOcrMatched
  firstLikeBaseOcrMatched = [bool]$result.diagnostics.firstLikeBaseOcrMatched
  firstTargetedLikeOcrAttempted = [bool]$result.diagnostics.firstTargetedLikeOcrAttempted
  firstTargetedLikeOcrMatched = [bool]$result.diagnostics.firstTargetedLikeOcrMatched
  firstCommentOcrMatched = [bool]$result.diagnostics.firstCommentOcrMatched
  firstLikeSignatureOk = [bool]$result.diagnostics.firstLikeSignatureOk
  firstCommentSignatureOk = [bool]$result.diagnostics.firstCommentSignatureOk
  firstLikeSignatureEdgeClear = [bool]$result.diagnostics.firstLikeSignatureEdgeClear
  firstCommentSignatureEdgeClear = [bool]$result.diagnostics.firstCommentSignatureEdgeClear
  firstLikeResolutionMode = [string]$result.diagnostics.firstLikeResolutionMode
  firstWidthRatio = [double]$result.diagnostics.firstWidthRatio
  firstHeightRatio = [double]$result.diagnostics.firstHeightRatio
  secondLikeOcrMatched = [bool]$result.diagnostics.secondLikeOcrMatched
  secondLikeBaseOcrMatched = [bool]$result.diagnostics.secondLikeBaseOcrMatched
  secondTargetedLikeOcrAttempted = [bool]$result.diagnostics.secondTargetedLikeOcrAttempted
  secondTargetedLikeOcrMatched = [bool]$result.diagnostics.secondTargetedLikeOcrMatched
  secondCommentOcrMatched = [bool]$result.diagnostics.secondCommentOcrMatched
  secondLikeSignatureOk = [bool]$result.diagnostics.secondLikeSignatureOk
  secondCommentSignatureOk = [bool]$result.diagnostics.secondCommentSignatureOk
  secondLikeSignatureEdgeClear = [bool]$result.diagnostics.secondLikeSignatureEdgeClear
  secondCommentSignatureEdgeClear = [bool]$result.diagnostics.secondCommentSignatureEdgeClear
  secondLikeResolutionMode = [string]$result.diagnostics.secondLikeResolutionMode
  secondWidthRatio = [double]$result.diagnostics.secondWidthRatio
  secondHeightRatio = [double]$result.diagnostics.secondHeightRatio
} | ConvertTo-Json -Compress
`;
const menuLabelDiagnosticsProbe = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(menuLabelDiagnosticsProbeSource, "utf16le").toString("base64")],
  { encoding: "utf8", windowsHide: true },
);
assert.equal(menuLabelDiagnosticsProbe.status, 0, menuLabelDiagnosticsProbe.stderr || "menu label diagnostics probe must run");
assert.deepEqual(JSON.parse(menuLabelDiagnosticsProbe.stdout.trim()), {
  firstCommentOcrMatched: false,
  firstCommentSignatureEdgeClear: true,
  firstCommentSignatureOk: true,
  firstHeightRatio: 1,
  firstLikeBaseOcrMatched: false,
  firstLikeOcrMatched: false,
  firstLikeSignatureEdgeClear: false,
  firstLikeResolutionMode: "ambiguous",
  firstLikeSignatureOk: true,
  firstTargetedLikeOcrAttempted: true,
  firstTargetedLikeOcrMatched: false,
  firstWidthRatio: 0.7,
  secondCommentOcrMatched: true,
  secondCommentSignatureEdgeClear: true,
  secondCommentSignatureOk: true,
  secondHeightRatio: 0,
  secondLikeBaseOcrMatched: false,
  secondLikeOcrMatched: false,
  secondLikeSignatureEdgeClear: false,
  secondLikeResolutionMode: "ambiguous",
  secondLikeSignatureOk: false,
  secondTargetedLikeOcrAttempted: true,
  secondTargetedLikeOcrMatched: false,
  secondWidthRatio: 0
});
const openLockedMenuSource = actionSource.match(
  /function Open-LockedVisualMenu\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(openLockedMenuSource, "locked visual menu opener should be present");
assert.equal(
  (openLockedMenuSource.match(/Invoke-VisualOwnedClick/gu) ?? []).length,
  1,
  "opening a menu, including its passive read retry, may click the three-dot anchor only once",
);
assert.equal(
  (openLockedMenuSource.match(/Read-OpenVisualMenu \$lock \$menu/gu) ?? []).length,
  1,
  "the menu opener must delegate the bounded passive retry to one reader call",
);
assert.match(openLockedMenuSource, /menuSurface = \$read\.menuSurface/u);
assert.match(openLockedMenuSource, /diagnostics = \$read\.diagnostics/u);
assert.match(
  openLockedMenuSource,
  /\$read\.cleanupReason = "moments_menu_close_blocked"[\s\S]*return \$read/u,
  "menu cleanup failure must preserve the primary read failure and attach a separate cleanup reason",
);
assert.doesNotMatch(
  openLockedMenuSource,
  /return @\{ ok = \$false; reason = "moments_menu_close_blocked" \}/u,
  "menu cleanup failure must not overwrite the original menu read reason",
);
const openMenuSegmentResolverSource = actionSource.match(
  /function Resolve-VisualOpenMenuHorizontalSegment\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(openMenuSegmentResolverSource, "open menu segment resolver should be present");
assert.match(openMenuSegmentResolverSource, /\$strictMatches[\s\S]*\$strictMatches\.Count -eq 1[\s\S]*geometryFallback = \$false/u);
assert.match(openMenuSegmentResolverSource, /\$requestedAction -cne "comment"[\s\S]*\$fallbackMatches[\s\S]*\$fallbackMatches\.Count -ne 1[\s\S]*geometryFallback = \$true/u);
const openMenuSegmentResolverProbeSource = `
$ErrorActionPreference = "Stop"
${openMenuSegmentResolverSource}
$strict = Resolve-VisualOpenMenuHorizontalSegment @(@{ left = 310; right = 499 }) 568 520 "like"
if (-not $strict.ok -or $strict.geometryFallback) { throw "strict popup segment must pass without fallback" }
$commentFallback = Resolve-VisualOpenMenuHorizontalSegment @(@{ left = 355; right = 499 }) 568 520 "comment"
if (-not $commentFallback.ok -or -not $commentFallback.geometryFallback) { throw "narrow unique comment popup must use geometry fallback" }
$likeBlocked = Resolve-VisualOpenMenuHorizontalSegment @(@{ left = 355; right = 499 }) 568 520 "like"
if ($likeBlocked.ok -or $likeBlocked.reason -cne "moments_menu_surface_ambiguous") { throw "like mode must retain strict popup proof" }
$ambiguous = Resolve-VisualOpenMenuHorizontalSegment @(
  @{ left = 355; right = 499 },
  @{ left = 360; right = 505 }
) 568 520 "comment"
if ($ambiguous.ok -or $ambiguous.candidateCount -ne 2) { throw "multiple comment fallback segments must remain ambiguous" }
`;
const openMenuSegmentResolverProbe = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(openMenuSegmentResolverProbeSource, "utf16le").toString("base64")],
  { encoding: "utf8", windowsHide: true },
);
assert.equal(openMenuSegmentResolverProbe.status, 0, openMenuSegmentResolverProbe.stderr || "open menu segment fallback behavior probe must pass");
assert.match(
  openMenuReadOnceSource,
  /Get-MomentsVisualFrame \$lock\.hWnd \$lock\.windowRect \$lock\.pid \$false \$false/u,
  "the WeChat-owned popup menu must not be mistaken for an external full-window obstruction"
);
assert.match(
  openMenuReadOnceSource,
  /function Read-OpenVisualMenuOnce\([\s\S]*\[string\]\$requestedAction,[\s\S]*\[string\]\$proofPurpose = "authorize_action"[\s\S]*\)/u,
  "menu reading should separate the requested action from the evidence purpose",
);
assert.match(openMenuReadOnceSource, /Get-VisualOpenMenuBounds \$frame \$menu \$requestedAction/u);
assert.match(
  openMenuReadOnceSource,
  /\$requestedAction -ceq "comment"[\s\S]*\$commentEntry -eq \$null[\s\S]*centerX = \[double\]\$surface\.bounds\.left \+ \(\$cellWidth \* 1\.5\)/u,
  "comment action should use the verified right menu cell when OCR text is unavailable",
);
assert.match(
  actionSource,
  /Read-OpenVisualMenu \$lock \$menu \(\[string\]\$context\.requestedAction\) "authorize_action"/u,
);
const likeActionStart = actionSource.indexOf('if ([string]$env:XIAOXI_MOMENTS_VISUAL_ACTION -ceq "like")');
const commentActionStart = actionSource.indexOf('if (@("comment", "comment_check")', likeActionStart);
const commentActionEnd = actionSource.indexOf("\n  [void](Close-VisualMenu $lock)", commentActionStart);
assert.ok(likeActionStart >= 0 && commentActionStart > likeActionStart && commentActionEnd > commentActionStart);
const likeActionSource = actionSource.slice(likeActionStart, commentActionStart);
const commentActionSource = actionSource.slice(commentActionStart, commentActionEnd);
assert.doesNotMatch(
  likeActionSource,
  /Read-OpenVisualMenu \$lock \$opened\.menu "comment"/u,
  "like refresh must not use the comment-only menu contract",
);
const alreadyLikedNoOpSource = likeActionSource.slice(
  likeActionSource.indexOf('if (@("取消", "取消赞")'),
  likeActionSource.indexOf("$freshMenu = Read-OpenVisualMenu"),
);
assert.match(
  alreadyLikedNoOpSource,
  /status = "already_liked_verified"[\s\S]*actionAttempted = \$false/u,
  "production like action must return a verified no-op for an already-liked post",
);
assert.doesNotMatch(
  alreadyLikedNoOpSource,
  /Invoke-VisualOwnedClick/u,
  "production like action must not click when the menu already shows 取消",
);
assert.match(
  likeActionSource,
  /\$freshMenu = Read-OpenVisualMenu \$lock \$opened\.menu "like" "authorize_action"[\s\S]*reason = "moments_menu_changed"[\s\S]*diagnostics = \$freshMenu\.diagnostics/u,
  "a failed pre-click refresh must preserve the detailed menu diagnostics",
);
assert.match(
  likeActionSource,
  /\$afterMenu = Read-OpenVisualMenu \$afterLock \$afterAnchor\.menu "like" "verify_outcome"[\s\S]*reason = "moments_like_verification_failed"[\s\S]*diagnostics = \$afterMenu\.diagnostics/u,
  "a failed post-click verification must preserve the detailed menu diagnostics",
);
assert.match(
  alreadyLikedNoOpSource,
  /Close-VisualMenu \$lock[\s\S]*cleanupReason = "moments_menu_close_blocked"[\s\S]*status = "already_liked_verified"[\s\S]*cleanupReason = \$cleanupReason/u,
  "closing an already-liked menu is cleanup and must not overturn the verified no-op",
);
assert.match(
  likeActionSource,
  /\$cleanupReason = ""[\s\S]*Close-VisualMenu \$afterLock[\s\S]*status = "verified"[\s\S]*cleanupReason = \$cleanupReason/u,
  "post-click menu cleanup failure must remain a warning after the cancel state is verified",
);
assert.doesNotMatch(
  likeActionSource,
  /Close-VisualMenu \$afterLock\)\) \{\s*Write-VisualResult @\{\s*ok = \$false;\s*status = "outcome_unknown"/u,
  "cleanup failure must not replace a verified like with outcome_unknown",
);
assert.match(
  commentActionSource,
  /\$commentX = [^\n]*\$opened\.comment\.centerX[\s\S]*\$commentY = [^\n]*\$opened\.comment\.centerY/u,
  "the comment branch must use the comment cell from the bounded menu read",
);
assert.doesNotMatch(
  commentActionSource,
  /Read-OpenVisualMenu|Open-LockedVisualMenu/u,
  "the comment branch must not re-read or reopen the menu after the bounded reader succeeds",
);
assert.match(
  commentActionSource,
  /\$commentClick = Invoke-VisualOwnedClickDetailed \$commentX \$commentY \$lock [^\n]*\$opened\.menuSurface[\s\S]*if \(-not \$commentClick\.ok\)[\s\S]*diagnostics = \$commentClick\.diagnostics/u,
  "the comment branch must use the detailed owned click and preserve its diagnostics",
);
assert.doesNotMatch(
  commentActionSource,
  /\$comment[XY] = [^\n]*\$opened\.like\.center[XY]/u,
  "the comment branch must never derive its click from the like entry",
);
assert.doesNotMatch(
  commentActionSource,
  /Test-VisualBoundsNear [^\n]*\.comment\.bounds/u,
  "comment pre-send refresh should trust the newly verified right-hand cell instead of comparing OCR-label and geometry-cell rectangles",
);
assert.match(
  actionSource,
  /requestedAction: String\(context\.action \?\? action\)/u,
  "the inspect preflight must preserve whether the caller intends to like or comment",
);
assert.match(freshMenuLock, /Resolve-VisualMenuAnchor \$menus \$expectedMenuBounds \$script:momentsVisualPostRelockTolerancePx/u);
assert.match(freshMenuLock, /moments_menu_not_found[\s\S]*Start-Sleep -Milliseconds 160[\s\S]*continue/u);
assert.match(freshMenuLock, /\$expectedHash -and \$hash -cne \$expectedHash/u);
assert.match(actionSource, /SetThreadDpiAwarenessContext\(\[IntPtr\]\(-4\)\)/u);
const ownedHitSource = actionSource.match(
  /function Test-VisualOwnedHitDetailed\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(ownedHitSource, "detailed owned-hit validation should be present");
assert.doesNotMatch(
  ownedHitSource,
  /Qt51514QWindowToolSaveBits|Weixin|GetClassName|GetWindowText/u,
  "owned popup clicks must not depend on a Qt build-specific class name or window title",
);
assert.match(ownedHitSource, /GetWindowThreadProcessId\(\$hit,[^\n]*\$hitPid[\s\S]*\[int\]\$hitPid -ne \[int\]\$lock\.pid/u);
assert.match(ownedHitSource, /IsWindowVisible\(\$hitRoot\)[\s\S]*IsIconic\(\$hitRoot\)/u);
for (const field of [
  "pointInsideSurface",
  "surfaceInsidePopup",
  "surfaceInsideWindow",
]) {
  assert.match(ownedHitSource, new RegExp(`\\b${field}\\b`, "u"), `owned-hit diagnostics must include ${field}`);
}
const ownedClickDetailedSource = actionSource.match(
  /function Invoke-VisualOwnedClickDetailed\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(ownedClickDetailedSource, "detailed owned click helper should be present");
assert.doesNotMatch(
  ownedClickDetailedSource,
  /Qt51514QWindowToolSaveBits|Weixin|GetClassName|GetWindowText/u,
  "the click helper must use ownership and geometry rather than popup class/title literals",
);
assert.match(ownedClickDetailedSource, /Test-VisualOwnedHitDetailed[\s\S]*SetCursorPos[\s\S]*Test-VisualOwnedHitDetailed/u);
assert.match(
  ownedClickDetailedSource,
  /\$secondProof = Test-VisualOwnedHitDetailed[\s\S]*\$diagnostics\[\$name\] = \[bool\]\$secondProof\.diagnostics\.\$name/u,
  "confirmed-hit failures must report the second geometry proof instead of stale first-hit values",
);
assert.match(ownedClickDetailedSource, /firstRootMatchesSecond/u);
assert.match(ownedClickDetailedSource, /foregroundOk/u);
assert.match(ownedClickDetailedSource, /ownedClickReason/u);
assert.match(ownedClickDetailedSource, /ownedClickPhase/u);

// Comment text is never hard-coded. UIA remains the primary targeted path. The
// custom-rendered fallback is action-scoped: it may prepare an exact draft for
// the existing guarded send click, but admits only a locked clipboard roundtrip
// with a tiny keyboard allowlist that excludes Enter.
assert.doesNotMatch(actionSource, /0717-2/u);
assert.match(actionSource, /GetClipboardSequenceNumber/u);
assert.doesNotMatch(actionSource, /SendKeys|SendWait|keybd_event/u);
assert.doesNotMatch(actionSource, /System\.Windows\.Forms\.Clipboard/u);
assert.match(actionSource, /StructLayout\(LayoutKind\.Explicit\)[\s\S]*FieldOffset\(8\)[\s\S]*KEYBDINPUT/u);
assert.match(actionSource, /AtomicKeyboardChord\(ushort modifier, ushort key\)[\s\S]*modifier != 0x11[\s\S]*key != 0x41 && key != 0x43 && key != 0x56/u);
assert.match(actionSource, /AtomicKeyboardBackspace\(\)[\s\S]*KeyboardScanInput\(BackspaceScanCode, false\)[\s\S]*KeyboardScanInput\(BackspaceScanCode, true\)/u);
assert.match(actionSource, /AtomicKeyboardEscape\(\)[\s\S]*const ushort VkEscape = 0x1B[\s\S]*KeyboardInput\(VkEscape, false\)[\s\S]*KeyboardInput\(VkEscape, true\)/u);
assert.match(actionSource, /if \(sent == inputs\.Length\) return true;[\s\S]*KeyboardInput\(key, true\)[\s\S]*KeyboardInput\(modifier, true\)/u);
assert.doesNotMatch(actionSource, /0x0D|VK_RETURN|AtomicKeyboardEnter/u);
assert.match(actionSource, /if \(\$sendBefore\.ok\)[\s\S]*moments_comment_preexisting_draft[\s\S]*Get-VisualCommentDraftTargeted \$lock \$composer\.bounds \$emptyCheckFinishedTick[\s\S]*Set-VisualCommentTextTargeted \$lock \$composer\.bounds \$commentText \$editorRuntimeId \$editorBounds/u);
assert.doesNotMatch(
  commentActionSource,
  /\$sendBefore\.reason -cne "moments_comment_send_button_not_found"[\s\S]*moments_comment_draft_state_unknown/u,
  "an ambiguous first send-button frame must reach the passive blank checkpoint instead of failing immediately",
);
assert.match(commentActionSource, /\$sendBefore\.ok[\s\S]*moments_comment_preexisting_draft[\s\S]*Get-VisualStableBlankCommentCheckpoint/u);
const openedCommentComposerProofSource = actionSource.match(
  /\$composerFrame = Get-MomentsVisualFrame[\s\S]*?Set-VisualActionStage "composer_opened"/u,
)?.[0] ?? "";
assert.ok(openedCommentComposerProofSource, "opened comment composer proof should be present");
assert.match(
  openedCommentComposerProofSource,
  /\$composer = Get-VisualCommentComposer[\s\S]*if \(-not \$composer\.ok\)[\s\S]*if \(\$composerAvatarHash\) \{ \$opened\.avatarHash = \$composerAvatarHash \}/u,
  "the unique composer is sufficient to continue; a missing avatar sample must not block comment input",
);
assert.doesNotMatch(openedCommentComposerProofSource, /Find-MomentsMenuDots|Resolve-VisualMenuAnchor|composerMenuResolution/u);
assert.doesNotMatch(actionSource, /if \([^\n]*\$composerAvatarHash -cne \$opened\.avatarHash/u);

const duplicateCheckIndex = actionSource.indexOf("$beforeCandidate = Find-VisualCommentCandidate");
const duplicateCountIndex = actionSource.indexOf("$normalizedOcrCountBefore = [int]$beforeCandidate.normalizedTextCount");
const openLockedMenuIndex = actionSource.indexOf("$opened = Open-LockedVisualMenu");
assert.ok(
  duplicateCheckIndex >= 0 &&
    duplicateCountIndex > duplicateCheckIndex &&
    openLockedMenuIndex > duplicateCheckIndex &&
    openLockedMenuIndex > duplicateCountIndex,
  "duplicate detection must finish before opening the transient action menu",
);
assert.doesNotMatch(
  actionSource,
  /\$beforeOcr = Get-MomentsOcrObservation/u,
  "duplicate detection must reuse the candidate OCR observations instead of scanning the post twice",
);

const commentOccurrenceStart = actionSource.indexOf(
  'if ([string]$env:XIAOXI_MOMENTS_VISUAL_ACTION -ceq "comment_occurrence_check")',
);
const commentOccurrenceEnd = actionSource.indexOf("\n  [string]$commentText = \"\"", commentOccurrenceStart);
assert.ok(
  commentOccurrenceStart >= 0 && commentOccurrenceEnd > commentOccurrenceStart,
  "read-only comment occurrence branch should be present",
);
const commentOccurrenceSource = actionSource.slice(commentOccurrenceStart, commentOccurrenceEnd);
assert.equal(
  (commentOccurrenceSource.match(/Get-CurrentLockedVisualPost \$lock \$context \$true/gu) ?? []).length,
  2,
  "comment occurrence proof must capture and relock exactly two visual frames",
);
assert.equal(
  (commentOccurrenceSource.match(/Find-VisualCommentCandidate[\s\S]*?"exact"/gu) ?? []).length,
  2,
  "both occurrence frames must use exact comment-region matching",
);
assert.match(
  commentOccurrenceSource,
  /Find-VisualCommentCandidate[\s\S]*?"exact" \$firstOccurrencePost\.nextPostTop[\s\S]*Find-VisualCommentCandidate[\s\S]*?"exact" \$secondOccurrencePost\.nextPostTop/u,
  "both occurrence frames must stop at the next proven post boundary",
);
assert.match(
  actionSource,
  /\$followingBoundaries = @\(\$read\.postBoundaries[\s\S]*\$followingBoundaries\[0\]\.ok[\s\S]*\$nextPostTop/u,
  "the next post boundary must come from the nearest menu/avatar proof, not the next OCR-readable post",
);
assert.match(
  probeSource,
  /\$postBoundaries\.Add\([\s\S]*menuBounds = \$menu\.bounds[\s\S]*avatarBounds = \$avatar\.bounds[\s\S]*postBoundaries = @\(\$postBoundaries\.ToArray\(\)/u,
  "post boundary evidence must be retained before body OCR filtering",
);
assert.match(
  commentOccurrenceSource,
  /\$occurrenceResolution = Resolve-VisualCommentOccurrence[\s\S]*commentOccurrence = "present"/u,
);
assert.match(
  commentOccurrenceSource,
  /\$occurrenceResolution\.commentOccurrence -ceq "absent"[\s\S]*commentOccurrence = "absent"/u,
);
assert.match(
  commentOccurrenceSource,
  /reason = "moments_comment_occurrence_unresolved"[\s\S]*actionAttempted = \$false/u,
);
assert.match(
  actionSource,
  /\$matchMode -ceq "exact" -and -not \$match\.ok[\s\S]*Get-VisualCommentLineMatch \$expected \$lineText "fuzzy"/u,
  "exact occurrence checks must retain near-text OCR matches as an absence veto",
);
assert.doesNotMatch(
  commentOccurrenceSource,
  /Invoke-VisualOwnedClick|AtomicMouseClick|AtomicKeyboard|Invoke-VisualOwnedUnicodeText|Open-LockedVisualMenu/u,
  "comment occurrence proof must remain read-only and must not open a menu, click, or type",
);

const commentTextRegionFunction = MOMENTS_VISUAL_ACTION_POWERSHELL.match(
  /function Get-VisualCommentTextRegion\([\s\S]*?\n\}/u,
)?.[0] ?? "";
const commentOccurrenceResolverFunction = MOMENTS_VISUAL_ACTION_POWERSHELL.match(
  /function Resolve-VisualCommentOccurrence\([\s\S]*?\n\}/u,
)?.[0] ?? "";
const visualLocatorBoundsSameFunction = MOMENTS_VISUAL_ACTION_POWERSHELL.match(
  /function Test-VisualLocatorBoundsSame\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(
  commentTextRegionFunction && commentOccurrenceResolverFunction && visualLocatorBoundsSameFunction,
  "comment region and occurrence decision helpers should be extractable",
);
const commentOccurrenceProgram = `
${visualBoundsFunction}
${visualBoundsNearFunction}
${visualLocatorBoundsSameFunction}
${commentTextRegionFunction}
${commentOccurrenceResolverFunction}
$frame = @{ width = 800.0; height = 600.0 }
$post = @{ left = 100.0; top = 100.0; width = 500.0; height = 200.0 }
$menu = @{ bounds = @{ left = 540.0; top = 250.0; width = 40.0; height = 20.0 } }
$boundedRegion = Get-VisualCommentTextRegion $frame $post $menu 500.0
$unboundedRegion = Get-VisualCommentTextRegion $frame $post $menu
$stableRegion = @{ left = 150.0; top = 274.0; width = 450.0; height = 222.0 }
$wrappedFirst = @{ ok = $false; reason = "moments_comment_candidate_not_found"; candidateCount = 0; normalizedTextCount = 1; fuzzyCandidateCount = 0; regionComplete = $true; regionBounds = $stableRegion; regionPixelHash = "a" }
$wrappedSecond = @{ ok = $false; reason = "moments_comment_candidate_not_found"; candidateCount = 0; normalizedTextCount = 1; fuzzyCandidateCount = 0; regionComplete = $true; regionBounds = $stableRegion; regionPixelHash = "a" }
$absentFirst = @{ ok = $false; reason = "moments_comment_candidate_not_found"; candidateCount = 0; normalizedTextCount = 0; fuzzyCandidateCount = 0; regionComplete = $true; regionBounds = $stableRegion; regionPixelHash = "b" }
$absentSecond = @{ ok = $false; reason = "moments_comment_candidate_not_found"; candidateCount = 0; normalizedTextCount = 0; fuzzyCandidateCount = 0; regionComplete = $true; regionBounds = $stableRegion; regionPixelHash = "b" }
$ocrDrift = @{ ok = $false; reason = "moments_comment_candidate_not_found"; candidateCount = 0; normalizedTextCount = 0; fuzzyCandidateCount = 1; regionComplete = $true; regionBounds = $stableRegion; regionPixelHash = "c" }
$clipped = @{ ok = $false; reason = "moments_comment_candidate_not_found"; candidateCount = 0; normalizedTextCount = 0; fuzzyCandidateCount = 0; regionComplete = $false; regionBounds = $stableRegion; regionPixelHash = "b" }
$wrapped = Resolve-VisualCommentOccurrence $wrappedFirst $wrappedSecond
$absent = Resolve-VisualCommentOccurrence $absentFirst $absentSecond
$ocrDriftResult = Resolve-VisualCommentOccurrence $ocrDrift $ocrDrift
$cropped = Resolve-VisualCommentOccurrence $clipped $clipped
@{
  boundedComplete = $boundedRegion.complete
  boundedBottom = $boundedRegion.top + $boundedRegion.height
  boundedBeforeNextPost = ($boundedRegion.top + $boundedRegion.height) -lt 500.0
  unboundedComplete = $unboundedRegion.complete
  unboundedBottom = $unboundedRegion.top + $unboundedRegion.height
  wrapped = $wrapped.commentOccurrence
  absent = $absent.commentOccurrence
  ocrDrift = $ocrDriftResult.commentOccurrence
  cropped = $cropped.commentOccurrence
} | ConvertTo-Json -Compress
`;
const commentOccurrenceHarness = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(commentOccurrenceProgram, "utf16le").toString("base64")],
  { encoding: "utf8", windowsHide: true },
);
assert.equal(
  commentOccurrenceHarness.status,
  0,
  commentOccurrenceHarness.stderr || "comment occurrence decision probe should run",
);
assert.deepEqual(JSON.parse(commentOccurrenceHarness.stdout.trim()), {
  boundedComplete: true,
  boundedBottom: 496,
  boundedBeforeNextPost: true,
  unboundedComplete: false,
  unboundedBottom: 300,
  wrapped: "unresolved",
  absent: "absent",
  ocrDrift: "unresolved",
  cropped: "unresolved",
});

const commentStageIndexes = Object.fromEntries(
  [
    "menu_opened",
    "comment_entry_clicked",
    "composer_opened",
    "send_clicked",
    "send_verified",
  ].map((stage) => [stage, actionSource.indexOf(`Set-VisualActionStage "${stage}"`)]),
);
assert.ok(
  commentStageIndexes.menu_opened >= 0 &&
    commentStageIndexes.menu_opened < commentStageIndexes.comment_entry_clicked &&
    commentStageIndexes.comment_entry_clicked < commentStageIndexes.composer_opened &&
    commentStageIndexes.composer_opened < commentStageIndexes.send_clicked &&
    commentStageIndexes.send_clicked < commentStageIndexes.send_verified,
  "comment lifecycle stages must follow menu → entry → composer → send click → verification",
);
const draftWrittenIndexes = [...actionSource.matchAll(/Set-VisualActionStage "draft_written"/gu)].map(
  (match) => match.index,
);
const sendButtonLocatedIndexes = [
  ...actionSource.matchAll(/Set-VisualActionStage "send_button_located"/gu),
].map((match) => match.index);
assert.equal(draftWrittenIndexes.length, 2, "UIA and visual clipboard input paths must both log draft_written");
assert.equal(
  sendButtonLocatedIndexes.length,
  2,
  "UIA and visual clipboard input paths must both log send_button_located",
);
for (let index = 0; index < draftWrittenIndexes.length; index += 1) {
  assert.ok(
    commentStageIndexes.composer_opened < draftWrittenIndexes[index] &&
      draftWrittenIndexes[index] < sendButtonLocatedIndexes[index] &&
      sendButtonLocatedIndexes[index] < commentStageIndexes.send_clicked,
    "each comment input path must write the draft, locate the button, then click send",
  );
}
const sendMarkerSource = actionSource.match(
  /function Write-VisualCommentSendMarker\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(sendMarkerSource, "the visual comment path must durably mark the irreversible send attempt");
assert.match(sendMarkerSource, /\$clickedAt = \[DateTime\]::UtcNow\.ToString\("o"\)/u);
assert.match(sendMarkerSource, /\[IO\.File\]::WriteAllText\([\s\S]*\[IO\.File\]::Move\(\$temporaryPath, \$fullPath\)/u);
assert.match(sendMarkerSource, /\$script:visualSendClickedAt = \$clickedAt/u);
assert.match(sendMarkerSource, /avatar_hash = \$avatarHash/u);
assert.match(sendMarkerSource, /identity_text = \$identityText/u);
assert.match(sendMarkerSource, /stable_anchor_text = \$stableAnchorText/u);
assert.doesNotMatch(sendMarkerSource, /\$context\.commentText\b/u, "the durable marker must never contain the comment body");
assert.equal(
  (actionSource.match(/Write-VisualCommentSendMarker \$context/gu) ?? []).length,
  1,
  "only the final comment send click may create a comment marker",
);
const ownedClickSource = actionSource.match(
  /function Invoke-VisualOwnedClick\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.match(
  `${ownedClickDetailedSource}\n${ownedClickSource}`,
  /& \$beforeIrreversibleClick[\s\S]*\$script:visualActionAttempted = \$true[\s\S]*AtomicMouseClick/u,
  "the durable marker must be written before the irreversible click attempt",
);

const lockedCommentSendStateSource = actionSource.match(
  /function Get-LockedVisualCommentSendState\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(lockedCommentSendStateSource, "minimal pre-send comment state should be present");
assert.match(lockedCommentSendStateSource, /\$composer = Get-VisualCommentComposer \$frame \$menu/u);
assert.match(lockedCommentSendStateSource, /\$send = Get-VisualSendButton \$frame \$composer/u);
assert.match(
  lockedCommentSendStateSource,
  /-not \$send\.ok -or -not \(Test-VisualBoundsInside \$send\.bounds \$composer\.bounds\)/u,
  "pre-send proof should require only one composer and one send button inside it",
);
assert.doesNotMatch(
  lockedCommentSendStateSource,
  /avatarHash|Test-VisualBoundsNear|GetLastInputTick|Test-VisualDeadlineMargin/u,
  "pre-send proof must not reintroduce anchor hashes, pixel tolerances, input ticks, or long time budgets",
);

const stableBlankCommentSource = actionSource.match(
  /function Get-VisualStableBlankCommentCheckpoint\([\s\S]*?\n\}/u,
)?.[0] ?? "";
const blankCommentFrameReaderSource = actionSource.match(
  /function Read-VisualBlankCommentFrame\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(blankCommentFrameReaderSource, "single passive blank-comment frame reader should be present");
assert.ok(stableBlankCommentSource, "stable blank-comment checkpoint should be present");
assert.doesNotMatch(blankCommentFrameReaderSource, /Click|AtomicMouse|Keyboard|Clipboard|SetCursorPos|Focus-|Open-Visual/u);
assert.doesNotMatch(
  stableBlankCommentSource,
  /Click|AtomicMouse|Keyboard|Clipboard|SetCursorPos|Focus-|Open-Visual|Open-LockedVisualMenu/u,
  "blank-state retry must remain entirely passive",
);
for (const field of [
  "blankCheckpointRetryCount",
  "retryReason",
  "checkpointPass",
  "startedInputTick",
  "finishedInputTick",
  "inputTickStable",
  "stableComposerOk",
  "stableComposerReason",
  "settledComposerOk",
  "settledComposerReason",
  "stableSendOk",
  "stableSendReason",
  "settledSendOk",
  "settledSendReason",
  "stableSendCandidateCount",
  "settledSendCandidateCount",
]) {
  assert.match(stableBlankCommentSource, new RegExp(`\\b${field}\\b`, "u"), `blank checkpoint diagnostics must include ${field}`);
}
const passiveBlankRetryProbeSource = `
${stableBlankCommentSource}
$script:blankScenario = ""
$script:blankReadCount = 0
function Start-Sleep { param([int]$Milliseconds) }
function Get-VisualInputTick { return [uint32]101 }
function Test-VisualLockedForeground { param($lock); return $true }
function Test-VisualBoundsNear { param($actual, $expected, [double]$tolerance); return $true }
function New-BlankFrame([bool]$composerOk, [string]$composerReason, [bool]$sendOk, [string]$sendReason, [int]$sendCandidateCount) {
  return @{
    ok = $true
    composer = @{
      ok = $composerOk
      reason = $composerReason
      bounds = @{ left = 100.0; top = 200.0; width = 300.0; height = 80.0 }
      candidateCount = $(if ($composerOk) { 1 } else { 2 })
      potentialCandidateCount = $(if ($composerOk) { 1 } else { 2 })
      validCandidateCount = $(if ($composerOk) { 1 } else { 0 })
    }
    send = @{
      ok = $sendOk
      reason = $sendReason
      candidateCount = $sendCandidateCount
      connectedComponentCount = $sendCandidateCount
      potentialCandidateCount = $sendCandidateCount
      borderRejectedCount = 0
    }
    avatarHash = "avatar"
  }
}
function Read-VisualBlankCommentFrame($lock, $menu, $expectedAvatarBounds) {
  $script:blankReadCount += 1
  if ($script:blankScenario -ceq "old_draft") {
    return New-BlankFrame $true "" $true "" 1
  }
  if ($script:blankScenario -ceq "retry_failure" -or $script:blankReadCount -le 2) {
    return New-BlankFrame $false "moments_comment_composer_not_found" $false "moments_comment_send_button_ambiguous" 2
  }
  return New-BlankFrame $true "" $false "moments_comment_send_button_not_found" 0
}
function Invoke-BlankRetryCase([string]$scenario) {
  $script:blankScenario = $scenario
  $script:blankReadCount = 0
  $result = Get-VisualStableBlankCommentCheckpoint @{} @{} @{ left = 100.0; top = 200.0; width = 300.0; height = 80.0 } @{} "avatar"
  return [pscustomobject]@{
    scenario = $scenario
    ok = [bool]$result.ok
    reason = [string]$result.reason
    reads = $script:blankReadCount
    retryCount = [int]$result.diagnostics.blankCheckpointRetryCount
    retryReason = [string]$result.diagnostics.retryReason
    checkpointPass = [int]$result.diagnostics.checkpointPass
    startedInputTick = [uint32]$result.diagnostics.startedInputTick
    finishedInputTick = [uint32]$result.diagnostics.finishedInputTick
    inputTickStable = [bool]$result.diagnostics.inputTickStable
    stableComposerOk = [bool]$result.diagnostics.stableComposerOk
    stableComposerReason = [string]$result.diagnostics.stableComposerReason
    settledComposerOk = [bool]$result.diagnostics.settledComposerOk
    settledComposerReason = [string]$result.diagnostics.settledComposerReason
    stableSendOk = [bool]$result.diagnostics.stableSendOk
    stableSendReason = [string]$result.diagnostics.stableSendReason
    settledSendOk = [bool]$result.diagnostics.settledSendOk
    settledSendReason = [string]$result.diagnostics.settledSendReason
    stableSendCandidateCount = [int]$result.diagnostics.stableSendCandidateCount
    settledSendCandidateCount = [int]$result.diagnostics.settledSendCandidateCount
  }
}
@(
  (Invoke-BlankRetryCase "retry_success"),
  (Invoke-BlankRetryCase "retry_failure"),
  (Invoke-BlankRetryCase "old_draft")
) | ConvertTo-Json -Depth 6 -Compress
`;
const passiveBlankRetryProbe = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(passiveBlankRetryProbeSource, "utf16le").toString("base64")],
  { encoding: "utf8", windowsHide: true },
);
assert.equal(passiveBlankRetryProbe.status, 0, passiveBlankRetryProbe.stderr || "passive blank retry probe must run");
const [blankRetrySuccess, blankRetryFailure, oldDraftNoRetry] = JSON.parse(passiveBlankRetryProbe.stdout.trim());
assert.deepEqual(blankRetrySuccess, {
  scenario: "retry_success",
  ok: true,
  reason: "",
  reads: 4,
  retryCount: 1,
  retryReason: "moments_comment_draft_state_unknown",
  checkpointPass: 1,
  startedInputTick: 101,
  finishedInputTick: 101,
  inputTickStable: true,
  stableComposerOk: true,
  stableComposerReason: "",
  settledComposerOk: true,
  settledComposerReason: "",
  stableSendOk: false,
  stableSendReason: "moments_comment_send_button_not_found",
  settledSendOk: false,
  settledSendReason: "moments_comment_send_button_not_found",
  stableSendCandidateCount: 0,
  settledSendCandidateCount: 0,
});
assert.deepEqual(blankRetryFailure, {
  scenario: "retry_failure",
  ok: false,
  reason: "moments_comment_draft_state_unknown",
  reads: 4,
  retryCount: 1,
  retryReason: "moments_comment_draft_state_unknown",
  checkpointPass: 1,
  startedInputTick: 101,
  finishedInputTick: 101,
  inputTickStable: true,
  stableComposerOk: false,
  stableComposerReason: "moments_comment_composer_not_found",
  settledComposerOk: false,
  settledComposerReason: "moments_comment_composer_not_found",
  stableSendOk: false,
  stableSendReason: "moments_comment_send_button_ambiguous",
  settledSendOk: false,
  settledSendReason: "moments_comment_send_button_ambiguous",
  stableSendCandidateCount: 2,
  settledSendCandidateCount: 2,
});
assert.equal(oldDraftNoRetry.ok, false);
assert.equal(oldDraftNoRetry.reason, "moments_comment_preexisting_draft");
assert.equal(oldDraftNoRetry.retryCount, 0, "a proven old draft must never be retried");
assert.ok(oldDraftNoRetry.reads <= 2, "a proven old draft must stop before any second checkpoint pass");
assert.match(
  commentActionSource,
  /if \(-not \$blankCheckpoint\.ok\)[\s\S]*diagnostics = \$blankCheckpoint\.diagnostics/u,
  "blank checkpoint failures must return their bounded diagnostics to the caller",
);
const editorAdapterSource = actionSource.match(
  /function Get-VisualCommentEditorAdapter\(\$lock, \$composerBounds,[\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(editorAdapterSource, "unique targeted editor adapter should be present");
assert.match(editorAdapterSource, /FindAll\([\s\S]*TreeScope\]::Descendants[\s\S]*Condition\]::TrueCondition/u);
assert.match(editorAdapterSource, /AutomationElement\]::FocusedElement/u);
assert.match(editorAdapterSource, /AutomationElement\]::FromPoint\(\$point\)/u);
assert.match(editorAdapterSource, /TreeWalker\]::ControlViewWalker\.GetParent\(\$current\)/u);
assert.match(editorAdapterSource, /foreach \(\$horizontalRatio in @\(0\.18, 0\.50, 0\.82\)\)/u);
assert.match(editorAdapterSource, /ProcessId -ne \[int\]\$lock\.pid[\s\S]*IsEnabled[\s\S]*IsOffscreen/u);
assert.match(editorAdapterSource, /ControlType\.Edit[\s\S]*ControlType\.Document/u);
assert.match(editorAdapterSource, /Test-VisualBoundsInside \$bounds \$expandedComposer/u);
assert.match(editorAdapterSource, /ValuePattern\]::Pattern[\s\S]*Current\.IsReadOnly/u);
assert.doesNotMatch(editorAdapterSource, /LegacyIAccessiblePattern|AccessibleRole|AccessibleStates/u);
assert.match(editorAdapterSource, /\$candidates\.Count -ne 1[\s\S]*runtimeId = \$candidate\.runtimeId/u);
const draftProbeSource = actionSource.match(
  /function Get-VisualCommentDraftTargeted\(\$lock, \$composerBounds, \[uint32\]\$expectedInputTick\) \{[\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(draftProbeSource, "exact preexisting draft probe should be present");
assert.doesNotMatch(draftProbeSource, /Clipboard|Backspace|SendKeys|SendWait/u);
assert.match(draftProbeSource, /Get-VisualCommentEditorAdapter \$lock \$composerBounds/u);
assert.match(draftProbeSource, /\$null -eq \$value[\s\S]*\(\[string\]\$value\)\.Length -eq 0/u);
assert.match(draftProbeSource, /editorRuntimeId = \[string\]\$adapter\.runtimeId/u);
assert.match(actionSource, /if \(-not \$draftProbe\.ok\)[\s\S]*reason = \[string\]\$draftProbe\.reason[\s\S]*if \(-not \$draftProbe\.empty\)[\s\S]*moments_comment_preexisting_draft/u);
assert.match(actionSource, /if \(-not \$draftProbe\.ok\)[\s\S]*Dismiss-VisualProvenEmptyCommentComposer \$lock \$opened\.menu \$composer\.bounds \$opened\.expectedAvatarBounds \$opened\.avatarHash \$emptyCheckFinishedTick[\s\S]*moments_comment_draft_close_unverified[\s\S]*reason = \[string\]\$draftProbe\.reason/u);
const targetedSetSource = actionSource.match(
  /function Set-VisualCommentTextTargeted\(\$lock, \$composerBounds,[\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(targetedSetSource, "targeted exact comment setter should be present");
assert.match(targetedSetSource, /Get-VisualCommentEditorAdapter \$lock \$composerBounds \$editorRuntimeId \$editorBounds/u);
assert.match(targetedSetSource, /String\]::Equals\(\[string\]\$adapter\.value, "", \[StringComparison\]::Ordinal\)/u);
assert.match(targetedSetSource, /Set-VisualCommentEditorAdapterValue \$adapter \$commentText/u);
assert.match(targetedSetSource, /String\]::Equals\(\[string\]\$confirmed\.value, \$commentText, \[StringComparison\]::Ordinal\)/u);
const preMutationCommentSource = actionSource.match(
  /\$composerFrame = Get-MomentsVisualFrame[\s\S]*?\$roundTrip = Set-VisualCommentTextTargeted/u,
)?.[0] ?? "";
assert.ok(preMutationCommentSource, "pre-mutation comment validation source should be present");
assert.match(preMutationCommentSource, /if \(-not \$draftProbe\.ok\)[\s\S]*Dismiss-VisualProvenEmptyCommentComposer/u);
const compactCommentTextSource = actionSource.match(
  /function Get-VisualCompactLocatorText\([\s\S]*?\n\}/u,
)?.[0] ?? "";
const longestCommentTextSource = actionSource.match(
  /function Get-VisualLongestCommonSubstringLength\([\s\S]*?\n\}/u,
)?.[0] ?? "";
const commentLineMatchSource = actionSource.match(
  /function Get-VisualCommentLineMatch\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(
  compactCommentTextSource && longestCommentTextSource && commentLineMatchSource,
  "exact duplicate and fuzzy readback text helpers should be extractable",
);
const commentLineMatchProbeSource = [
  compactCommentTextSource,
  longestCommentTextSource,
  commentLineMatchSource,
  "$target = '回读验收V2-0720-A'",
  "$oldComment = '回读验收QK7R'",
  "$oldExact = Get-VisualCommentLineMatch $target $oldComment 'exact'",
  "$oldFuzzy = Get-VisualCommentLineMatch $target $oldComment 'fuzzy'",
  "$publishedExact = Get-VisualCommentLineMatch $target '玺哥：回读验收V2-0720-A' 'exact'",
  "$normalizedExact = Get-VisualCommentLineMatch $target '玺哥： 回读 验收Ｖ２－０７２０－Ａ' 'exact'",
  "$siblingExact = Get-VisualCommentLineMatch $target '玺哥：回读验收V2-0720-B' 'exact'",
  "$siblingFuzzy = Get-VisualCommentLineMatch $target '玺哥：回读验收V2-0720-B' 'fuzzy'",
  "$superstringExact = Get-VisualCommentLineMatch $target '玺哥：回读验收V2-0720-A-extra' 'exact'",
  "$prefixedSuperstringExact = Get-VisualCommentLineMatch $target '玺哥：extra回读验收V2-0720-A' 'exact'",
  "$colonPrefixedSuperstringExact = Get-VisualCommentLineMatch $target '玺哥：extra：回读验收V2-0720-A' 'exact'",
  "$ocrFuzzy = Get-VisualCommentLineMatch $target '回读验收V2-072O-A' 'fuzzy'",
  "[pscustomobject]@{ oldExact = $oldExact.ok; oldFuzzy = $oldFuzzy.ok; oldCommon = $oldFuzzy.common; publishedExact = $publishedExact.ok; normalizedExact = $normalizedExact.ok; siblingExact = $siblingExact.ok; siblingFuzzy = $siblingFuzzy.ok; superstringExact = $superstringExact.ok; prefixedSuperstringExact = $prefixedSuperstringExact.ok; colonPrefixedSuperstringExact = $colonPrefixedSuperstringExact.ok; ocrFuzzy = $ocrFuzzy.ok } | ConvertTo-Json -Compress",
].join("\n");
const commentLineMatchProbe = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(commentLineMatchProbeSource, "utf16le").toString("base64")],
  { encoding: "utf8", windowsHide: true },
);
assert.equal(commentLineMatchProbe.status, 0, commentLineMatchProbe.stderr || "comment line match probe should run");
assert.deepEqual(JSON.parse(commentLineMatchProbe.stdout.trim()), {
  oldExact: false,
  oldFuzzy: true,
  oldCommon: 4,
  publishedExact: true,
  normalizedExact: true,
  siblingExact: false,
  siblingFuzzy: true,
  superstringExact: false,
  prefixedSuperstringExact: false,
  colonPrefixedSuperstringExact: false,
  ocrFuzzy: true,
});
assert.match(actionSource, /"comment_check"[\s\S]*Clear-And-CloseVisualCommentDraft/u);
assert.match(actionSource, /status = "comment_draft_verified"[\s\S]*actionAttempted = \$false/u);
assert.match(actionSource, /targeted_uia_value_roundtrip_and_unique_enabled_button_transition/u);
assert.match(
  actionSource,
  /\$finalEditor = Get-VisualCommentEditorAdapter \$lock \$composer\.bounds \$editorRuntimeId \$editorBounds[\s\S]*String\]::Equals\(\[string\]\$finalEditor\.value, \$commentText, \[StringComparison\]::Ordinal\)[\s\S]*GetForegroundWindow\(\) -ne \$lock\.hWnd/u,
  "targeted input must prove the intended draft is still present in the foreground composer",
);
assert.match(
  actionSource,
  /Invoke-VisualOwnedClick \$sendX \$sendY \$lock \(\[int64\]\$context\.deadlineMs\) \$true \$true \$null \(\[uint32\]::MaxValue\) \{ Write-VisualCommentSendMarker \$context \}/u,
  "the final send click must not be vetoed by a global Windows input tick",
);
assert.match(actionSource, /action === "comment"[\s\S]*validCommentSendMarkerPath\(context\.sendMarkerPath, context\.postFingerprint\)/u);

const writeVisualResultSource = actionSource.match(
  /function Write-VisualResult\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(writeVisualResultSource, "structured visual result writer should be present");
assert.match(writeVisualResultSource, /\$value\.stage = \$script:visualActionStage/u);
assert.match(writeVisualResultSource, /\$value\.sendClickedAt = \$script:visualSendClickedAt/u);
assert.match(writeVisualResultSource, /\$value\.primaryReason = \[string\]\$value\.reason/u);
assert.match(writeVisualResultSource, /\$value\.cleanupReason = ""/u);
assert.match(writeVisualResultSource, /\$value\.verificationMode = ""/u);
assert.match(writeVisualResultSource, /\$value\.realActionAttempted = \[bool\]/u);
const writeVisualResultProbeSource = `
$script:visualActionStage = "draft_written"
$script:visualSendClickedAt = ""
$script:visualActionAttempted = $false
${writeVisualResultSource}
Write-VisualResult @{
  ok = $false
  status = "blocked"
  reason = "primary_failure"
  primaryReason = "primary_failure"
  cleanupReason = "cleanup_failure"
  actionAttempted = $false
}
`;
const writeVisualResultProbe = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(writeVisualResultProbeSource, "utf16le").toString("base64"),
  ],
  { encoding: "utf8", windowsHide: true },
);
assert.equal(writeVisualResultProbe.status, 0, writeVisualResultProbe.stderr || "structured result probe must run");
const writeVisualResultValue = JSON.parse(writeVisualResultProbe.stdout.trim());
assert.equal(writeVisualResultValue.reason, "primary_failure");
assert.equal(writeVisualResultValue.primaryReason, "primary_failure");
assert.equal(writeVisualResultValue.cleanupReason, "cleanup_failure");

const verifiedCommentSuccessSource = actionSource.match(
  /if \(\$seedResult\.stateTransitionVerified -eq \$true\) \{[\s\S]*?\n    \}/u,
)?.[0] ?? "";
assert.ok(verifiedCommentSuccessSource, "verified comment success branch should be present");
assert.match(
  verifiedCommentSuccessSource,
  /Set-VisualActionStage "send_verified"[\s\S]*ok = \$true[\s\S]*status = "visible_verified"[\s\S]*commentVerified = \$true[\s\S]*verificationMode = \[string\]\$seedResult\.verificationMode/u,
  "only a verified post-send state transition may return comment success",
);
assert.equal(
  (actionSource.match(/commentVerified = \$true/gu) ?? []).length,
  1,
  "comment success must have a single verified result path",
);
const finalSendTail = actionSource.slice(
  actionSource.indexOf("Invoke-VisualOwnedClick $sendX $sendY"),
  actionSource.indexOf("\n  [void](Close-VisualMenu $lock)", actionSource.indexOf("Invoke-VisualOwnedClick $sendX $sendY")),
);
assert.equal(
  (finalSendTail.match(/ok = \$true/gu) ?? []).length,
  1,
  "the post-click path must expose exactly one success result",
);
assert.ok(
  finalSendTail.indexOf("if ($seedResult.stateTransitionVerified -eq $true)") <
    finalSendTail.indexOf("ok = $true"),
  "post-click success must be nested behind state-transition verification",
);

const visualClipboardRoundTripSource = actionSource.match(
  /function Invoke-VisualCommentCheckClipboardRoundTrip\([\s\S]*?\nfunction Clear-And-CloseVisualSelectedCommentDraft/u,
)?.[0] ?? "";
assert.ok(visualClipboardRoundTripSource, "locked visual clipboard comment preparation transaction should be present");
assert.doesNotMatch(visualClipboardRoundTripSource, /Write-VisualResult|Invoke-VisualOwnedClick\s+\$send|AtomicMouseClick|0x0D|VK_RETURN/u);
assert.equal((visualClipboardRoundTripSource.match(/\$failureReason = ""/gu) ?? []).length, 1, "comment-check failures must not be cleared after cleanup");
assert.match(actionSource, /if \(-not \$draftProbe\.ok\)[\s\S]*\$draftProbe\.reason -ceq "moments_comment_editor_targeting_unsupported"[\s\S]*@\("comment", "comment_check"\) -contains [^\n]+XIAOXI_MOMENTS_VISUAL_ACTION[\s\S]*Invoke-VisualCommentCheckClipboardRoundTrip/u);
assert.match(visualClipboardRoundTripSource, /\[bool\]\$retainExactDraftForSend = \$false/u);
assert.match(visualClipboardRoundTripSource, /if \(\$draftRetainedForSend\)[\s\S]*status = "comment_draft_ready_for_send"[\s\S]*actionAttempted = \$false[\s\S]*inputTick = \$inputTick[\s\S]*clipboardRestored = \$clipboardRestored[\s\S]*draftRetainedForSend = \$true/u);
assert.match(actionSource, /\$retainExactDraftForSend = [^\n]+XIAOXI_MOMENTS_VISUAL_ACTION -ceq "comment"[\s\S]*if \(-not \$retainExactDraftForSend\) \{ Write-VisualResult \$clipboardRoundTrip \}[\s\S]*status -cne "comment_draft_ready_for_send"[\s\S]*\$visualClipboardSend = \$true/u);
assert.match(visualClipboardRoundTripSource, /Set-VisualKnownClipboardText[\s\S]*\$commentText[\s\S]*Invoke-VisualOwnedKeyboardChord[^\n]+0x56/u);
const ownedKeyboardChordSource = actionSource.match(
  /function Invoke-VisualOwnedKeyboardChord\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(ownedKeyboardChordSource, "owned keyboard chord helper should be present");
assert.match(ownedKeyboardChordSource, /TryClipboardTextMatches\([\s\S]*\$expectedClipboardSequence[\s\S]*\$currentClipboardSequence = [^\n]+GetClipboardSequenceNumber[\s\S]*TryClipboardTextMatches\([\s\S]*\$currentClipboardSequence[\s\S]*\$expectedClipboardText[\s\S]*\$verifiedClipboardSequence = \$currentClipboardSequence/u);
assert.match(ownedKeyboardChordSource, /AtomicKeyboardChord[\s\S]*inputMayHaveBeenIssued = \$true[\s\S]*clipboardSequence = \$verifiedClipboardSequence/u);
const setKnownClipboardSource = actionSource.match(
  /function Set-VisualKnownClipboardText\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(setKnownClipboardSource, "known clipboard setter should be present");
assert.match(setKnownClipboardSource, /TryClipboardTextMatches\([\s\S]*\$expectedSequence[\s\S]*\$currentExpectedSequence = [^\n]+GetClipboardSequenceNumber[\s\S]*TryClipboardTextMatches\([\s\S]*\$currentExpectedSequence[\s\S]*\$expectedText[\s\S]*\$expectedSequence = \$currentExpectedSequence[\s\S]*AtomicReplaceTextClipboard/u);
const copyFailureClipboardSource = actionSource.match(
  /function Get-VisualClipboardAfterCopyFailure\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(copyFailureClipboardSource, "copy failure clipboard reconciliation should be present");
assert.match(copyFailureClipboardSource, /TryClipboardTextMatches\([\s\S]*\$sentinel[\s\S]*TryCaptureCopiedTextClipboardState[\s\S]*\$copiedSequence -ne \$sentinelSequence[\s\S]*ClipboardOwnerMatchesLockedProcess[\s\S]*StringComparison\]::Ordinal[\s\S]*known = \$false/u);
assert.match(visualClipboardRoundTripSource, /if \(-not \$copy\.ok\)[\s\S]*\$copy\.inputMayHaveBeenIssued[\s\S]*Get-VisualClipboardAfterCopyFailure[\s\S]*\$clipboardStateKnown = \$true[\s\S]*\$clipboardStateKnown = \$false[\s\S]*throw/u);
assert.match(visualClipboardRoundTripSource, /\$ownedClipboardSequence = \[uint32\]\$paste\.clipboardSequence[\s\S]*\$sentinelSequence = \$ownedClipboardSequence[\s\S]*\$sentinelSequence = \$ownedClipboardSequence/u);
assert.match(visualClipboardRoundTripSource, /xiaoxi-comment-check-sentinel-[\s\S]*0x41[\s\S]*0x43/u);
assert.match(visualClipboardRoundTripSource, /\$copiedSequence -eq \$sentinelSequence[\s\S]*ClipboardOwnerMatchesLockedProcess[\s\S]*StringComparison\]::Ordinal/u);
const exactDraftProofIndex = visualClipboardRoundTripSource.indexOf("$exactDraftProven = $true");
const commentCheckCleanupBranchIndex = visualClipboardRoundTripSource.indexOf("if (-not $retainExactDraftForSend)", exactDraftProofIndex);
const immediateBackspaceIndex = visualClipboardRoundTripSource.indexOf("Invoke-VisualOwnedKeyboardBackspace", commentCheckCleanupBranchIndex);
const boundedEmptyProofIndex = visualClipboardRoundTripSource.indexOf("Wait-VisualSelectedCommentDraftEmptyPair", immediateBackspaceIndex);
const immediateDismissIndex = visualClipboardRoundTripSource.indexOf("$composerClosed = Dismiss-VisualProvenEmptyCommentComposer", boundedEmptyProofIndex);
const clipboardRestoreAfterCleanupIndex = visualClipboardRoundTripSource.indexOf("$clipboardRestoreSucceeded = Restore-VisualClipboard", immediateDismissIndex);
const retainedReadyProofIndex = visualClipboardRoundTripSource.indexOf("$readyState = Get-LockedVisualCommentSendState", clipboardRestoreAfterCleanupIndex);
assert.ok(
  exactDraftProofIndex >= 0
    && commentCheckCleanupBranchIndex > exactDraftProofIndex
    && immediateBackspaceIndex > commentCheckCleanupBranchIndex
    && boundedEmptyProofIndex > immediateBackspaceIndex
    && immediateDismissIndex > boundedEmptyProofIndex
    && clipboardRestoreAfterCleanupIndex > immediateDismissIndex
    && retainedReadyProofIndex > clipboardRestoreAfterCleanupIndex,
  "comment_check must immediately clear the exactly selected draft, prove empty/closed, restore the clipboard, and leave ready/send probing to retained real comments",
);
const immediateCommentCheckCleanupSource = visualClipboardRoundTripSource.slice(
  commentCheckCleanupBranchIndex,
  clipboardRestoreAfterCleanupIndex,
);
assert.doesNotMatch(immediateCommentCheckCleanupSource, /Focus-VisualCommentKeyboardTarget|\$readyState|\$stableReadyState/u);
assert.equal(
  (immediateCommentCheckCleanupSource.match(/Invoke-VisualOwnedKeyboardBackspace/gu) ?? []).length,
  1,
  "comment_check exact-draft cleanup must issue one guarded Backspace without refocusing",
);
assert.match(immediateCommentCheckCleanupSource, /Invoke-VisualOwnedKeyboardBackspace[\s\S]*Wait-VisualSelectedCommentDraftEmptyPair[\s\S]*Dismiss-VisualProvenEmptyCommentComposer/u);
assert.match(immediateCommentCheckCleanupSource, /moments_comment_draft_empty_state_unverified[\s\S]*moments_comment_composer_dismiss_unverified/u);
assert.match(actionSource, /private const ushort BackspaceScanCode = 0x0E[\s\S]*private static INPUT KeyboardScanInput[\s\S]*KeyEventfScanCode/u);
assert.match(actionSource, /private static INPUT KeyboardScanInput[\s\S]*virtualKey = 0[\s\S]*scanCode = scanCode[\s\S]*flags = KeyEventfScanCode/u);
assert.match(actionSource, /public static bool AtomicKeyboardBackspace\(\)[\s\S]*KeyboardScanInput\(BackspaceScanCode, false\)[\s\S]*KeyboardScanInput\(BackspaceScanCode, true\)[\s\S]*SendInput/u);
assert.match(actionSource, /AtomicKeyboardBackspace\(\)[\s\S]*INPUT\[\] releases = new INPUT\[\] \{ KeyboardScanInput\(BackspaceScanCode, true\) \}/u);
const ownedKeyboardBackspaceSource = actionSource.match(
  /function Invoke-VisualOwnedKeyboardBackspace\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(ownedKeyboardBackspaceSource, "owned Backspace helper should be present");
assert.match(ownedKeyboardBackspaceSource, /Test-VisualOwnedKeyboardTarget[\s\S]*AtomicKeyboardBackspace[\s\S]*GetLastInputTick[\s\S]*ok = \$true/u);
assert.doesNotMatch(ownedKeyboardBackspaceSource, /GetForegroundWindow/u);
const visualClipboardRoundTripFinallySource = visualClipboardRoundTripSource.slice(
  visualClipboardRoundTripSource.indexOf("  } finally {"),
);
assert.match(visualClipboardRoundTripFinallySource, /Restore-VisualClipboard[\s\S]*if \(\$retainExactDraftForSend -and -not \$draftRetainedForSend -and \$draftMayExist -and \$exactDraftProven\)[\s\S]*Invoke-VisualOwnedKeyboardBackspace/u);
assert.doesNotMatch(visualClipboardRoundTripFinallySource, /if \(-not \$retainExactDraftForSend[^\n]*\$exactDraftProven\)[\s\S]*Invoke-VisualOwnedKeyboardBackspace/u);
assert.doesNotMatch(visualClipboardRoundTripFinallySource, /Focus-VisualCommentKeyboardTarget/u);
assert.match(visualClipboardRoundTripSource, /\$emptyStateCandidate = \$true[\s\S]*Dismiss-VisualProvenEmptyCommentComposer[\s\S]*if \(\$composerClosed\)[\s\S]*\$draftCleared = \$true/u);
assert.match(actionSource, /function Dismiss-VisualCommentComposer[\s\S]*for \(\$attempt = 0; \$attempt -lt 7; \$attempt\+\+\)[\s\S]*\$missingFrames -ge 2/u);
assert.match(visualClipboardRoundTripSource, /moments_comment_draft_empty_state_unverified[\s\S]*moments_comment_composer_dismiss_unverified/u);
const selectedDraftEmptyStateSource = actionSource.match(
  /function Test-VisualSelectedCommentDraftEmpty\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(selectedDraftEmptyStateSource, "strict selected-draft empty-state predicate should be present");
assert.match(selectedDraftEmptyStateSource, /\$state\.ok[\s\S]*-not \$state\.send\.ok[\s\S]*\$state\.send\.reason -ceq "moments_comment_send_button_not_found"/u);
const provenEmptyDismissSource = actionSource.match(
  /function Dismiss-VisualProvenEmptyCommentComposer\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(provenEmptyDismissSource, "clipboard-compatible proven-empty composer dismissal should be present");
assert.doesNotMatch(provenEmptyDismissSource, /SetForegroundWindow|ShowWindowAsync|Invoke-VisualOwnedKeyboardBackspace|AtomicMouseClick/u);
const selectedDraftCleanupSource = actionSource.match(
  /function Clear-And-CloseVisualSelectedCommentDraft\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(selectedDraftCleanupSource, "exact selected visual draft cleanup should be present");
assert.doesNotMatch(selectedDraftCleanupSource, /Clipboard|0x41|0x43|0x56|Invoke-VisualOwnedClick|AtomicMouseClick|Write-VisualResult|0x0D|VK_RETURN/u);
assert.match(selectedDraftCleanupSource, /Invoke-VisualOwnedKeyboardBackspace[\s\S]*Wait-VisualSelectedCommentDraftEmptyPair[\s\S]*Dismiss-VisualProvenEmptyCommentComposer/u);
const visualSendFailureSource = actionSource.match(
  /if \(-not \(Invoke-VisualOwnedClick \$sendX \$sendY[\s\S]*?\n    Set-VisualActionStage "send_clicked"/u,
)?.[0] ?? "";
assert.ok(visualSendFailureSource, "guarded visual send failure path should be present");
assert.match(visualSendFailureSource, /if \(\$visualClipboardSend\)[\s\S]*-not \$script:visualActionAttempted -and[\s\S]*Clear-And-CloseVisualSelectedCommentDraft[\s\S]*moments_comment_send_blocked/u);
assert.doesNotMatch(visualSendFailureSource, /if \(\$script:visualActionAttempted\s+-and[\s\S]*Clear-And-CloseVisualSelectedCommentDraft/u);
const postSendCommentStateSource = actionSource.match(
  /function Get-VisualPostSendCommentState\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(postSendCommentStateSource, "strict passive post-send comment state should be present");
assert.doesNotMatch(postSendCommentStateSource, /Invoke-VisualOwnedClick|AtomicMouseClick|Invoke-VisualOwnedKeyboard|AtomicKeyboard|Clipboard|Open-LockedVisualMenu|SetForegroundWindow/u);
assert.equal((postSendCommentStateSource.match(/GetLastInputTick/gu) ?? []).length, 0, "passive post-send readback must not fail because unrelated Windows input ticks changed");
assert.match(postSendCommentStateSource, /Get-LockedVisualRoot \$context[\s\S]*GetForegroundWindow\(\) -ne \$stateLock\.hWnd[\s\S]*Get-MomentsVisualFrame \$stateLock\.hWnd \$stateLock\.windowRect \$stateLock\.pid \$false/u);
assert.match(postSendCommentStateSource, /\$composerClosed = -not \$composer\.ok[\s\S]*\$sendInactive = \$composer\.ok -and -not \$send\.ok[\s\S]*\$composerCompleted = \$composerClosed -or \$sendInactive/u);
assert.match(postSendCommentStateSource, /Get-VisualSendButton \$frame \$composer \$false[\s\S]*ok = \[bool\]\$composerCompleted/u);
assert.doesNotMatch(postSendCommentStateSource, /Find-MomentsMenuDots|Resolve-VisualMenuAnchor|Get-MomentsPixelHash|Find-VisualCommentCandidate/u);
const postSendSurfaceSettleSource = actionSource.match(
  /function Wait-VisualPostSendSurfaceSettled\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(postSendSurfaceSettleSource, "bounded passive post-send surface settle should be present");
assert.doesNotMatch(postSendSurfaceSettleSource, /Find-VisualCommentCandidate|Invoke-VisualOwnedClick|AtomicMouseClick|Keyboard|Clipboard/u);
const postSendStateCaptureIndex = postSendSurfaceSettleSource.indexOf(
  "$lastState = Get-VisualPostSendCommentState $context $opened",
);
const postCaptureBudgetIndex = postSendSurfaceSettleSource.indexOf(
  "if (-not (Test-VisualPostSendBudget $context $settleDeadlineMs))",
  postSendStateCaptureIndex + 1,
);
assert.ok(postSendStateCaptureIndex >= 0, "post-send state should be captured");
assert.match(
  postSendSurfaceSettleSource.slice(postCaptureBudgetIndex),
  /if \(\$lastState\.ok\)[\s\S]*\$deadlineConfirmation = Get-VisualPostSendCommentState \$context \$opened[\s\S]*if \(\$deadlineConfirmation\.ok\) \{ return \$deadlineConfirmation \}/u,
  "a success captured at the deadline should receive one final passive confirmation frame",
);
assert.match(
  postSendSurfaceSettleSource,
  /if \(\$lastState\.ok\)[\s\S]*\$consecutiveFrames \+= 1[\s\S]*\$consecutiveFrames -ge 2/u,
  "ordinary post-send transitions should still require two consecutive frames",
);
const postSendDeadlineEdgeProbeSource = `
${postSendSurfaceSettleSource}
$script:budgetChecks = 0
$script:stateReads = 0
function Test-VisualPostSendBudget($context, [int64]$settleDeadlineMs) {
  $script:budgetChecks += 1
  return $script:budgetChecks -eq 1
}
function Get-VisualPostSendCommentState($context, $opened) {
  $script:stateReads += 1
  return @{
    ok = $true
    diagnostics = @{
      composerCompleted = $true
      composerClosed = $true
      sendInactive = $false
      sendCandidateCount = 0
    }
  }
}
function Start-Sleep { param([int]$Milliseconds) }
$result = Wait-VisualPostSendSurfaceSettled @{} @{} 1
@{
  ok = [bool]$result.ok
  composerClosed = [bool]$result.diagnostics.composerClosed
  budgetChecks = [int]$script:budgetChecks
  stateReads = [int]$script:stateReads
} | ConvertTo-Json -Compress
`;
const postSendDeadlineEdgeProbe = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(postSendDeadlineEdgeProbeSource, "utf16le").toString("base64"),
  ],
  { encoding: "utf8", windowsHide: true },
);
assert.equal(
  postSendDeadlineEdgeProbe.status,
  0,
  postSendDeadlineEdgeProbe.stderr || "post-send deadline-edge probe must run",
);
assert.deepEqual(JSON.parse(postSendDeadlineEdgeProbe.stdout.trim()), {
  budgetChecks: 2,
  composerClosed: true,
  ok: true,
  stateReads: 2,
});
const postSendTransientMissingProbeSource = `
${postSendSurfaceSettleSource}
$script:budgetChecks = 0
$script:stateReads = 0
function Test-VisualPostSendBudget($context, [int64]$settleDeadlineMs) {
  $script:budgetChecks += 1
  return $script:budgetChecks -eq 1
}
function Get-VisualPostSendCommentState($context, $opened) {
  $script:stateReads += 1
  if ($script:stateReads -eq 1) {
    return @{
      ok = $true
      diagnostics = @{
        composerCompleted = $true
        composerClosed = $true
        sendInactive = $false
        sendCandidateCount = 0
      }
    }
  }
  return @{
    ok = $false
    reason = "moments_comment_composer_not_settled"
    diagnostics = @{
      composerCompleted = $false
      composerClosed = $false
      sendInactive = $false
      sendCandidateCount = 1
    }
  }
}
function Start-Sleep { param([int]$Milliseconds) }
$result = Wait-VisualPostSendSurfaceSettled @{} @{} 1
@{
  ok = [bool]$result.ok
  reason = [string]$result.reason
  stateReads = [int]$script:stateReads
} | ConvertTo-Json -Compress
`;
const postSendTransientMissingProbe = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(postSendTransientMissingProbeSource, "utf16le").toString("base64"),
  ],
  { encoding: "utf8", windowsHide: true },
);
assert.equal(
  postSendTransientMissingProbe.status,
  0,
  postSendTransientMissingProbe.stderr || "post-send transient-missing probe must run",
);
assert.deepEqual(JSON.parse(postSendTransientMissingProbe.stdout.trim()), {
  ok: false,
  reason: "moments_comment_readback_seed_timeout",
  stateReads: 2,
});
const readbackSeedWaitSource = actionSource.match(
  /function Wait-VisualCommentReadbackSeed\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(readbackSeedWaitSource, "bounded passive readback-seed wait should be present");
assert.doesNotMatch(readbackSeedWaitSource, /Invoke-VisualOwnedClick|AtomicMouseClick|Keyboard|Clipboard|Open-LockedVisualMenu/u);
assert.doesNotMatch(readbackSeedWaitSource, /GetLastInputTick|moments_external_input_detected/u);
assert.match(readbackSeedWaitSource, /Wait-VisualPostSendSurfaceSettled[\s\S]*if \(-not \$surface\.ok\)[\s\S]*stateTransitionVerified = \$true[\s\S]*verificationMode = "composer_closed_or_send_inactive_v1"/u);
assert.doesNotMatch(readbackSeedWaitSource, /Find-VisualCommentCandidate|Get-MomentsOcrObservation|Invoke-VisualCommentReadback|locatorOnly/u);
const neutralTitleBarClickSource = actionSource.match(
  /function Invoke-VisualNeutralTitleBarClick\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(neutralTitleBarClickSource, "neutral title-bar click helper should be present");
assert.doesNotMatch(neutralTitleBarClickSource, /SetForegroundWindow|ShowWindowAsync/u);
assert.match(visualClipboardRoundTripSource, /actionAttempted = \$false[\s\S]*visual_clipboard_ordinal_roundtrip_and_unique_enabled_button_transition/u);

// A reaction row may contain green pixels after a successful like. Composer
// detection isolates connected components and still accepts exactly one
// component that passes the original size and four-edge proof.
const visualCommentComposerSource = actionSource.match(
  /function Get-VisualCommentComposer\(\$frame, \$menu\) \{[\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(visualCommentComposerSource, "visual comment composer detector should be present");
assert.match(visualCommentComposerSource, /\$scanBottom = \[int\]\[Math\]::Max\(\$scanTop, \$frame\.height - 12\)/u);
assert.doesNotMatch(visualCommentComposerSource, /\$frame\.height \* 0\.19/u);
assert.match(visualCommentComposerSource, /\$mask = New-Object bool\[\]/u);
assert.match(visualCommentComposerSource, /System\.Collections\.Generic\.Queue\[int\]/u);
assert.match(visualCommentComposerSource, /for \(\$deltaY = -1; \$deltaY -le 1; \$deltaY\+\+\)[\s\S]*for \(\$deltaX = -1; \$deltaX -le 1; \$deltaX\+\+\)/u);
assert.match(visualCommentComposerSource, /\$componentPixelCount -lt 180/u);
assert.match(visualCommentComposerSource, /\$potentialCandidateCount \+= 1/u);
assert.match(visualCommentComposerSource, /Test-VisualBounds \$bounds \(\[double\]\$frame\.width \* 0\.54\) 64/u);
assert.match(visualCommentComposerSource, /\$topEdge -lt \(\[double\]\$bounds\.width \* 0\.42\)[\s\S]*\$rightEdge -lt \(\[double\]\$bounds\.height \* 0\.35\)/u);
assert.match(visualCommentComposerSource, /\$validCandidates\.Count -ne 1/u);
assert.match(visualCommentComposerSource, /\$validCandidates\.Count -eq 0 -and \$potentialCandidateCount -eq 0[\s\S]*moments_comment_composer_not_found/u);
assert.doesNotMatch(visualCommentComposerSource, /Sort-Object|largest|maximum component/iu);

// Published comments are verified only through the unique Copy menu item and
// an ordinal clipboard proof. The adjacent Delete item is never selected.
assert.match(actionSource, /function Invoke-VisualCommentReadback/u);
assert.match(actionSource, /GetWindow\(IntPtr hWnd, uint command\)/u);
assert.match(actionSource, /\$popup\.owner -ne \$lock\.hWnd/u);
assert.match(actionSource, /Qt51514QWindowToolSaveBits/u);
assert.match(actionSource, /\[string\]\$popup\.title -cne "Weixin"/u);
assert.match(actionSource, /function Test-VisualBoundsInsideWithTolerance[\s\S]*\$tolerance -lt 0[\s\S]*outer\.height \+ \$tolerance/u);
assert.match(actionSource, /function Get-VisualVirtualScreenBounds[\s\S]*GetSystemMetrics\(76\)[\s\S]*GetSystemMetrics\(79\)/u);
assert.match(actionSource, /function Test-VisualPointInsideBoundsWithTolerance/u);
assert.match(actionSource, /function Test-VisualReadbackPopupGeometry/u);
assert.match(actionSource, /Test-VisualBoundsInsideWithTolerance \$popupBounds \$virtualScreenBounds 3\.0/u);
assert.match(actionSource, /Test-VisualPointInsideBoundsWithTolerance \$anchorX \$anchorY \$lockedBounds 0\.0/u);
assert.match(actionSource, /Test-VisualPointInsideBoundsWithTolerance \$anchorX \$anchorY \$popupBounds 3\.0/u);
assert.doesNotMatch(actionSource, /Test-VisualReadbackPopupBoundsInside|moments_comment_readback_popup_outside_window/u);
assert.match(actionSource, /popupDirectOwnerVerified[\s\S]*popupStable[\s\S]*popupPlacementAnchored/u);
assert.match(actionSource, /Close-VisualReadbackPopups \$beforeHandles \$popupCandidates \$lock \$candidateX \$candidateY/u);
assert.equal(
  actionSource.split("Test-VisualReadbackPopupCleanupCandidate $candidate $lock $anchorX $anchorY").length - 1,
  2,
  "cleanup must revalidate the exact popup identity and anchor twice",
);
const visualBoundsSource = actionSource.match(
  /function Test-VisualBounds\(\$bounds,[\s\S]*?\n\}/u,
)?.[0] ?? "";
const tolerantBoundsSource = actionSource.match(
  /function Test-VisualBoundsInsideWithTolerance\([\s\S]*?\n\}/u,
)?.[0] ?? "";
const pointInsideSource = actionSource.match(
  /function Test-VisualPointInsideBoundsWithTolerance\([\s\S]*?\n\}/u,
)?.[0] ?? "";
const popupGeometrySource = actionSource.match(
  /function Test-VisualReadbackPopupGeometry\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(
  visualBoundsSource && tolerantBoundsSource && pointInsideSource && popupGeometrySource,
  "visual popup geometry helpers should be extractable",
);
const popupGeometryProbeSource = [
  visualBoundsSource,
  tolerantBoundsSource,
  pointInsideSource,
  popupGeometrySource,
  "$locked = @{ left = 307.0; top = 0.0; width = 568.0; height = 1034.0 }",
  "$virtual = @{ left = 0.0; top = 0.0; width = 900.0; height = 1080.0 }",
  "$results = @(",
  "  (Test-VisualReadbackPopupGeometry @{ left = 634.0; top = 863.0; width = 263.0; height = 206.0 } $locked $virtual 667 899)",
  "  (Test-VisualReadbackPopupGeometry @{ left = 634.0; top = 863.0; width = 269.0; height = 206.0 } $locked $virtual 667 899)",
  "  (Test-VisualReadbackPopupGeometry @{ left = 634.0; top = 863.0; width = 270.0; height = 206.0 } $locked $virtual 667 899)",
  "  (Test-VisualReadbackPopupGeometry @{ left = 880.0; top = 863.0; width = 20.0; height = 206.0 } $locked $virtual 667 899)",
  "  (Test-VisualReadbackPopupGeometry @{ left = 634.0; top = 863.0; width = 269.0; height = 206.0 } $locked $virtual 900 899)",
  "  (Test-VisualReadbackPopupGeometry @{ left = 634.0; top = 863.0; width = 269.0; height = 206.0 } $locked $virtual 875 899)",
  "  (Test-VisualReadbackPopupGeometry @{ left = 634.0; top = 863.0; width = 269.0; height = 206.0 } $locked $virtual 667 1034)",
  ")",
  "$results | ConvertTo-Json -Compress"
].join("\n");
const popupGeometryProbe = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(popupGeometryProbeSource, "utf16le").toString("base64")],
  { encoding: "utf8" },
);
assert.equal(popupGeometryProbe.status, 0, popupGeometryProbe.stderr || "visual popup geometry probe should run");
assert.deepEqual(JSON.parse(popupGeometryProbe.stdout.trim()), [true, true, false, false, false, false, false]);

const safePopupSource = actionSource.match(
  /function Get-VisualSafeReadbackPopup\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(safePopupSource, "safe readback popup acquisition should be extractable");
assert.ok(
  safePopupSource.indexOf("$stableCount -ge 2") < safePopupSource.indexOf("Get-VisualReadbackPopupPlacement"),
  "popup placement must be checked only after two stable frames",
);
const stablePopupProbeSource = [
  safePopupSource,
  "function Test-VisualDeadline { param([int64]$deadlineMs) return $true }",
  "function Start-Sleep { param([int]$Milliseconds) }",
  "$script:windowCalls = 0",
  "$script:placementCalls = 0",
  "function Get-VisualProcessWindows {",
  "  param([int]$expectedPid)",
  "  $script:windowCalls++",
  "  $left = if ($script:windowCalls -eq 1) { 900.0 } else { 634.0 }",
  "  return ,@{ hWnd = [IntPtr]4200; hWndText = '4200'; pid = 41; className = 'Qt51514QWindowToolSaveBits'; title = 'Weixin'; owner = [IntPtr]4100; bounds = @{ left = $left; top = 863.0; width = 263.0; height = 206.0 } }",
  "}",
  "function Get-VisualReadbackPopupPlacement { param($popupBounds, $lock, [int]$anchorX, [int]$anchorY); $script:placementCalls++; return @{ ok = $true; reason = '' } }",
  "$lock = @{ pid = 41; hWnd = [IntPtr]4100 }",
  "$result = Get-VisualSafeReadbackPopup $lock @() 667 899 ([int64]::MaxValue)",
  "[pscustomobject]@{ ok = $result.ok; owner = $result.ownerVerified; stable = $result.stable; anchored = $result.placementAnchored; windows = $script:windowCalls; placements = $script:placementCalls } | ConvertTo-Json -Compress",
].join("\n");
const stablePopupProbe = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(stablePopupProbeSource, "utf16le").toString("base64")],
  { encoding: "utf8", windowsHide: true },
);
assert.equal(stablePopupProbe.status, 0, stablePopupProbe.stderr || "stable popup probe should run");
assert.deepEqual(JSON.parse(stablePopupProbe.stdout.trim()), {
  ok: true,
  owner: true,
  stable: true,
  anchored: true,
  windows: 3,
  placements: 1,
});
assert.match(actionSource, /function Get-VisualExactCommentMenuObservation/u);
assert.match(actionSource, /\$raw = Get-MomentsOcrObservation[\s\S]*\$scaled = Get-MomentsScaledOcrObservation/u);
assert.match(actionSource, /foreach \(\$label in @\("复制", "搜一搜", "删除"\)\)/u);
assert.match(actionSource, /\$rawMatches\.Count -ne 1 -or \$scaledMatches\.Count -ne 1/u);
assert.match(actionSource, /\$copyCenterY -ge \(\[double\]\$frame\.height \* 0\.34\)/u);
assert.match(actionSource, /\$deleteCenterY -le \(\[double\]\$frame\.height \* 0\.58\)/u);
assert.match(actionSource, /Invoke-VisualOwnedRightClick[\s\S]*Invoke-VisualOwnedPopupClick/u);
assert.match(actionSource, /function Invoke-VisualOwnedRightClick\([^\n]+\$expectedInputTick\)[\s\S]*\$expectedInputTick -eq \[uint32\]::MaxValue[\s\S]*GetLastInputTick\(\) -ne \$expectedInputTick[\s\S]*AtomicMouseClick/u);
assert.match(actionSource, /"menuBounds",\s*"expectedInputTick",\s*"createdAtMs"[\s\S]*Number\.isInteger\(seed\.expectedInputTick\)[\s\S]*seed\.expectedInputTick < 0xffff_ffff/u);
assert.match(actionSource, /function Test-VisualCommentReadbackSeed[\s\S]*seed\.expectedInputTick -ge \[uint32\]::MaxValue[\s\S]*IsWindowVisible\(\$lock\.hWnd\)/u);
const readbackSeedValidationSource = actionSource.match(
  /function Test-VisualCommentReadbackSeed\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.doesNotMatch(readbackSeedValidationSource, /GetLastInputTick/u);
assert.match(actionSource, /\$copyX = [^\n]+\$copyEntry\.bounds/u);
assert.match(actionSource, /public static bool TryCaptureTextClipboard/u);
assert.match(
  actionSource,
  /public static bool AtomicKeyboardUnicodeText\(string text\)[\s\S]*KeyEventfUnicode[\s\S]*SendInput/u,
  "comment input must have a clipboard-independent Unicode keyboard fallback",
);
assert.match(
  actionSource,
  /function Invoke-VisualCommentUnicodeDraftForSend[\s\S]*Invoke-VisualOwnedUnicodeText[\s\S]*comment_draft_ready_for_send/u,
  "unsupported clipboard contents should fall back to direct Unicode input",
);
assert.match(
  actionSource,
  /\$clipboardCanRoundTrip = [\s\S]*TryCaptureTextClipboard[\s\S]*if \(\$retainExactDraftForSend -and -not \$clipboardCanRoundTrip\)[\s\S]*Invoke-VisualCommentUnicodeDraftForSend/u,
  "clipboard backup failure must not stop a real comment before typing",
);
assert.match(actionSource, /TryCaptureTextClipboard[\s\S]*for \(int captureAttempt = 0; captureAttempt < 6; captureAttempt\+\+\)[\s\S]*Thread\.Sleep\(35\)[\s\S]*if \(result\) return true/u);
assert.match(
  actionSource,
  /TryCaptureTextClipboard[\s\S]*?ClipboardContainsOnlyTextFormatsLocked\(\)\s*&&\s*TryReadUnicodeTextLocked/u,
  "rich clipboard formats must bypass destructive text-only replacement and use Unicode input instead",
);
assert.match(actionSource, /public static int AtomicReplaceTextClipboard/u);
assert.match(actionSource, /OpenClipboard\(owner\)[\s\S]*GetClipboardSequenceNumber\(\) != expectedSequence[\s\S]*EmptyClipboard\(\)[\s\S]*SetClipboardData/u);
assert.match(actionSource, /OpenClipboardWithRetry[\s\S]*CloseClipboardWithRetry/u);
assert.match(actionSource, /AtomicReplaceTextClipboard\([\s\S]*out uint replacementSequence, out bool cleanupSucceeded\)[\s\S]*cleanupSucceeded = cleanupOk;[\s\S]*return result;/u);
assert.match(actionSource, /fallbackMemory = IntPtr\.Zero;[\s\S]*replacementSequence = GetClipboardSequenceNumber\(\);[\s\S]*result = 2/u);
assert.match(actionSource, /result = expectedEmpty \? 2 : -1/u);
assert.match(actionSource, /TryCaptureTextClipboard\([\s\S]*\[ref\]\$originalClipboardText/u);
assert.match(actionSource, /\$currentSequence -ne \$beforeSequence/u);
assert.match(actionSource, /TryCaptureCopiedTextClipboard\([\s\S]*\$capturedCopiedSequence -eq \$copiedSequence/u);
assert.match(actionSource, /GetClipboardOwner\(\)[\s\S]*GetWindowThreadProcessId\(owner, out ownerPid\)[\s\S]*confirmedOwnerPid == ownerPid/u);
assert.match(actionSource, /\[int\]\$clipboardOwnerPid -ne \[int\]\$lock\.pid/u);
assert.match(actionSource, /\[StringComparison\]::Ordinal/u);
assert.match(actionSource, /clipboardOwnedByLockedProcess/u);
assert.match(actionSource, /public static bool ClipboardOwnerMatchesLockedProcess[\s\S]*GetWindowThreadProcessId\(expectedWindow, out expectedWindowPid\)[\s\S]*expectedWindowPid != expectedPid[\s\S]*GetWindowThreadProcessId\(owner, out ownerPid\)[\s\S]*ownerPid == expectedPid/u);
assert.doesNotMatch(actionSource, /ClipboardOwnerBelongsToWindow|OleMainThreadWndClass/u);
assert.match(actionSource, /\$clipboardOwnedSequence = \$capturedCopiedSequence[\s\S]*ClipboardOwnerMatchesLockedProcess/u);
assert.match(actionSource, /clipboardOrdinalMatched/u);
assert.match(actionSource, /clipboardRestored = Restore-VisualClipboard/u);
assert.match(actionSource, /function Invoke-VisualOwnedPopupClick\([^\n]+\$expectedCopyBounds/u);
assert.match(actionSource, /function Test-VisualOwnedPopupCopyTarget[\s\S]*Get-VisualScreenFrame \$popup\.bounds[\s\S]*Get-VisualExactCommentMenuObservation \$frame/u);
assert.match(actionSource, /Test-VisualBoundsNear \$freshMenu\.copy\.bounds \$expectedCopyBounds 3\.0/u);
assert.match(actionSource, /Test-VisualOwnedPopupCopyTarget \$copyX \$copyY[\s\S]*Test-VisualDeadlineMargin \(\[int64\]\$context\.deadlineMs\) 3000[\s\S]*xiaoxi-comment-readback-sentinel-/u);
assert.match(actionSource, /GetCursorPos\(\[ref\]\$finalPoint\)[\s\S]*ClipboardTextMatches\(\$expectedClipboardSequence, \$false, \$expectedClipboardText\)[\s\S]*AtomicMouseClick\(\$screenX, \$screenY, \$false\)/u);
assert.match(actionSource, /public static bool TryClipboardTextMatches[\s\S]*OpenClipboardWithRetry\(IntPtr\.Zero\)[\s\S]*return captured/u);
assert.match(actionSource, /function Restore-VisualClipboard[\s\S]*AtomicReplaceTextClipboard\([\s\S]*TryClipboardTextMatches\([\s\S]*\$ownedReadable -and -not \$ownedMatches/u);
assert.match(actionSource, /function Restore-VisualClipboard[\s\S]*\$cleanupFailed = \$false[\s\S]*\[ref\]\$replaceCleanupSucceeded[\s\S]*-not \$replaceCleanupSucceeded[\s\S]*-not \$cleanupFailed/u);
const clipboardRestoreSource = actionSource.match(
  /function Restore-VisualClipboard\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(clipboardRestoreSource, "clipboard restore helper should be present");
assert.match(clipboardRestoreSource, /for \(\$attempt = 0; \$attempt -lt 6; \$attempt\+\+\)/u);
const ownedMatchIndex = clipboardRestoreSource.indexOf("$ownedReadable -and $ownedMatches");
const changedSequenceRejectIndex = clipboardRestoreSource.indexOf("$currentSequence -ne $ownedSequence");
assert.ok(ownedMatchIndex >= 0 && changedSequenceRejectIndex > ownedMatchIndex, "same ordinal-owned clipboard text should rebind an asynchronously advanced sequence before rejection");
assert.match(clipboardRestoreSource, /\$ownedReadable -and \$ownedMatches[\s\S]*\$ownedSequence = \$currentSequence[\s\S]*continue/u);
const ownedSequenceRebindSource = clipboardRestoreSource.match(
  /if \(\$ownedReadable -and \$ownedMatches\) \{[\s\S]*?\n\s*\}/u,
)?.[0] ?? "";
assert.ok(ownedSequenceRebindSource, "owned clipboard sequence rebind should be present");
assert.doesNotMatch(ownedSequenceRebindSource, /\$owned(?:Text|Empty)\s*=/u);
assert.match(visualClipboardRoundTripSource, /\$exactDraftProven = \$true[\s\S]*\$clipboardRestoreSucceeded = Restore-VisualClipboard[\s\S]*TryClipboardTextMatches\([\s\S]*\$originalClipboardText[\s\S]*\$originalClipboardMatches[\s\S]*if \(-not \$clipboardRestoreSucceeded\)[\s\S]*moments_comment_clipboard_restore_failed[\s\S]*\$readyState = Get-LockedVisualCommentSendState/u);
assert.doesNotMatch(visualClipboardRoundTripSource, /\$failureReason -ceq "moments_comment_clipboard_restore_failed"[\s\S]*\$failureReason = ""/u);
assert.match(actionSource, /replacementSequence != expectedSequence \? 1 : 3[\s\S]*\$restoreStatus -eq 1 -or \$restoreStatus -eq 3/u);
assert.match(actionSource, /\$restoreStatus -eq 2[\s\S]*\$ownedSequence = \$restoredSequence/u);
assert.match(actionSource, /\$restoreStatus -eq -1[\s\S]*\$ownedEmpty = \$true/u);
assert.match(actionSource, /function Close-VisualReadbackPopups/u);
assert.match(actionSource, /\$rightClickIssued = \$true[\s\S]*Close-VisualReadbackPopups \$beforeHandles \$popupCandidates \$lock/u);
assert.match(actionSource, /AtomicMouseClick\(\$neutralX, \$neutralY, \$false\)/u);
assert.match(actionSource, /unique_copy_menu_clipboard_sequence_ordinal_v2/u);
assert.doesNotMatch(actionSource, /SendWait\("\{DOWN\}"\)|SendWait\("\{ENTER\}"\)/u);
assert.doesNotMatch(actionSource, /Invoke-VisualOwnedPopupClick[^\n]+(?:delete|删除)/iu);

// Closing an ambiguous action menu must never send a blind Escape: if the
// overlay did not open, Escape can close the entire Moments window. The safe
// path revalidates a neutral title-bar hit and clicks only the locked window.
const neutralTitleBarSource = actionSource.match(
  /function Invoke-VisualNeutralTitleBarClick\(\$lock, \[uint32\]\$expectedInputTick = \[uint32\]::MaxValue\) \{[\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(neutralTitleBarSource, "neutral title-bar click source should be present");
assert.match(neutralTitleBarSource, /GetForegroundWindow\(\) -ne \$lock\.hWnd/u);
assert.match(neutralTitleBarSource, /GetWindowRect\(\$lock\.hWnd, \[ref\]\$currentRect\)/u);
assert.match(neutralTitleBarSource, /\$currentRect\.Left -ne \$lock\.windowRect\.Left[\s\S]*\$currentRect\.Bottom -ne \$lock\.windowRect\.Bottom/u);
assert.match(neutralTitleBarSource, /GetWindowThreadProcessId\(\$lock\.hWnd, \[ref\]\$currentPid\)[\s\S]*\[int\]\$currentPid -ne \[int\]\$lock\.pid/u);
assert.match(neutralTitleBarSource, /GetWindowText\(\$lock\.hWnd, \$currentTitle[\s\S]*Trim\(\) -cne "朋友圈"/u);
assert.match(neutralTitleBarSource, /WindowFromPoint\(\$neutralPoint\)/u);
assert.match(neutralTitleBarSource, /GetAncestor\(\$actualNeutralHit, 2\) -ne \$lock\.hWnd/u);
assert.match(neutralTitleBarSource, /GetWindowRect\(\$lock\.hWnd, \[ref\]\$confirmedRect\)[\s\S]*\$confirmedRect\.Left -ne \$currentRect\.Left[\s\S]*\$confirmedRect\.Bottom -ne \$currentRect\.Bottom/u);
assert.match(neutralTitleBarSource, /AtomicMouseClick\(\$neutralX, \$neutralY, \$false\)/u);
assert.match(neutralTitleBarSource, /IsWindowVisible\(\$lock\.hWnd\)/u);

const closeVisualMenuSource = actionSource.match(
  /function Close-VisualMenu\(\$lock = \$null\) \{[\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(closeVisualMenuSource, "Close-VisualMenu source should be present");
assert.doesNotMatch(closeVisualMenuSource, /SendKeys|\{ESC\}/u);
assert.match(closeVisualMenuSource, /Invoke-VisualNeutralTitleBarClick \$lock/u);
assert.match(actionSource, /function Close-And-VerifyUnchanged[\s\S]*-not \(Close-VisualMenu \$lock\)[\s\S]*moments_menu_close_blocked/u);
assert.doesNotMatch(actionSource, /^\s*Close-VisualMenu\b/mu);

const dismissCommentComposerSource = actionSource.match(
  /function Dismiss-VisualCommentComposer\(\$lock, \$menu, \[uint32\]\$expectedInputTick\) \{[\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(dismissCommentComposerSource, "safe comment composer dismissal should be present");
assert.doesNotMatch(dismissCommentComposerSource, /SendKeys|\{ESC\}/u);
assert.match(dismissCommentComposerSource, /Invoke-VisualNeutralTitleBarClick \$lock \$expectedInputTick/u);
assert.match(dismissCommentComposerSource, /moments_comment_composer_not_found/u);
assert.doesNotMatch(actionSource, /^\s*Dismiss-VisualCommentComposer\b/mu);

const exactEmptyComposerEscapeSource = actionSource.match(
  /function Dismiss-VisualExactEmptyCommentComposer\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(exactEmptyComposerEscapeSource, "exact-empty comment composer Escape dismissal should be present");
assert.match(exactEmptyComposerEscapeSource, /GetForegroundWindow\(\) -ne \$lock\.hWnd/u);
assert.match(exactEmptyComposerEscapeSource, /GetWindowThreadProcessId\(\$lock\.hWnd, \[ref\]\$currentPid\)[\s\S]*\[int\]\$currentPid -ne \[int\]\$lock\.pid/u);
assert.match(exactEmptyComposerEscapeSource, /Get-VisualSendButton \$emptyFrame \$emptyComposer[\s\S]*moments_comment_send_button_not_found/u);
assert.match(exactEmptyComposerEscapeSource, /Get-VisualCommentEditorAdapter \$lock \$expectedComposerBounds \$editorRuntimeId \$editorBounds[\s\S]*String\]::Equals\(\[string\]\$exactEmptyEditor\.value, "", \[StringComparison\]::Ordinal\)/u);
assert.match(exactEmptyComposerEscapeSource, /\$exactEmptyEditor\.element\.SetFocus\(\)[\s\S]*AutomationElement\]::FocusedElement[\s\S]*\$focusedRuntimeId -cne \$editorRuntimeId/u);
assert.match(exactEmptyComposerEscapeSource, /\$focusedEmptyEditor = Get-VisualCommentEditorAdapter[\s\S]*String\]::Equals\(\[string\]\$focusedEmptyEditor\.value, "", \[StringComparison\]::Ordinal\)[\s\S]*AtomicKeyboardEscape\(\)/u);
assert.match(exactEmptyComposerEscapeSource, /AtomicKeyboardEscape\(\)[\s\S]*\$missingFrames \+= 1[\s\S]*\$missingFrames -ge 2/u);
assert.match(exactEmptyComposerEscapeSource, /return Dismiss-VisualCommentComposer \$lock \$menu \$escapeInputTick/u);
assert.doesNotMatch(exactEmptyComposerEscapeSource, /AtomicMouseClick|SendKeys|SendWait/u);

const clearCommentDraftSource = actionSource.match(
  /function Clear-And-CloseVisualCommentDraft\(\$lock, \$menu, \$expectedComposerBounds, \[string\]\$expectedText, \[string\]\$editorRuntimeId, \$editorBounds\) \{[\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(clearCommentDraftSource, "safe comment draft cleanup source should be present");
assert.doesNotMatch(clearCommentDraftSource, /\{ESC\}/u);
assert.doesNotMatch(clearCommentDraftSource, /Clipboard|Backspace|SendKeys|SendWait|Invoke-VisualOwnedClick/u);
assert.match(clearCommentDraftSource, /Clear-VisualCommentTextTargetedIfExact \$lock \$composer\.bounds \$expectedText \$editorRuntimeId \$editorBounds \$cleanupInputTick/u);
assert.match(clearCommentDraftSource, /Get-MomentsVisualFrame/u);
assert.match(clearCommentDraftSource, /moments_comment_send_button_not_found/u);
assert.match(clearCommentDraftSource, /\$finalEmptyEditor = Get-VisualCommentEditorAdapter[\s\S]*GetLastInputTick\(\) -ne \$cleanupInputTick[\s\S]*return Dismiss-VisualExactEmptyCommentComposer \$lock \$menu \$composer\.bounds \$editorRuntimeId \$editorBounds \$cleanupInputTick/u);
assert.match(clearCommentDraftSource, /\} catch \{\}[\s\S]*return \$false/u);

const clearCommentTextSource = actionSource.match(
  /function Clear-VisualCommentTextTargetedIfExact\(\$lock, \$composerBounds, \[string\]\$expectedText, \[string\]\$editorRuntimeId, \$editorBounds, \[uint32\]\$expectedInputTick\) \{[\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(clearCommentTextSource, "exact owned draft clear transaction should be present");
assert.doesNotMatch(clearCommentTextSource, /Clipboard|Backspace|SendKeys|SendWait/u);
assert.match(clearCommentTextSource, /Get-VisualCommentEditorAdapter \$lock \$composerBounds \$editorRuntimeId \$editorBounds/u);
assert.match(clearCommentTextSource, /String\]::Equals\(\[string\]\$adapter\.value, \$expectedText, \[StringComparison\]::Ordinal\)/u);
assert.match(clearCommentTextSource, /Set-VisualCommentEditorAdapterValue \$adapter ""/u);
assert.match(clearCommentTextSource, /String\]::Equals\(\[string\]\$confirmed\.value, "", \[StringComparison\]::Ordinal\)/u);
assert.doesNotMatch(actionSource, /^\s*Clear-And-CloseVisualCommentDraft\b/mu);
assert.doesNotMatch(actionSource, /\{ESC\}/u);
assert.match(actionSource, /moments_comment_draft_close_unverified/u);

// The broad and targeted OCR passes may both miss the isolated like glyph.
// A complete narrow glyph may authorize a like. A cropped wide cancel label is
// outcome-only evidence and must request a second stable passive observation.
assert.match(actionSource, /\$x - \$lastDark\) -gt \[Math\]::Max\(18\.0, \[double\]\$frame\.width \* 0\.05\)/u);
assert.match(actionSource, /Get-VisualMenuTargetedOcrRegion[\s\S]*Get-MomentsHighContrastOcrObservation \$frame \$targetedLikeRegion 5/u);
assert.match(
  actionSource,
  /\[bool\]\$likeSignature\.horizontalEdgeClear -and[\s\S]*?\$widthRatio -ge 0\.42 -and \$widthRatio -le 0\.60\)[\s\S]*?\$visualState = "赞"/u,
);
assert.doesNotMatch(actionSource, /\$widthRatio -ge 0\.32 -and \$widthRatio -le 0\.68\) \{ \$visualState = "赞" \}/u);
assert.match(
  actionSource,
  /\$widthRatio -ge 0\.78 -and \$widthRatio -le 1\.42[\s\S]*?\$normalizedProofPurpose -ceq "verify_outcome"[\s\S]*?\$visualState = "取消"[\s\S]*?\$requiresStability = -not \[bool\]\$likeSignature\.horizontalEdgeClear/u,
);
assert.match(actionSource, /\[string\]\$proofPurpose = "authorize_action"/u);
assert.doesNotMatch(actionSource, /0\.885714/u);
const visualActionTimeoutCapsSource = actionSource.match(
  /VISUAL_ACTION_TIMEOUT_CAP_MS = Object\.freeze\(\{[\s\S]*?\}\);/u,
)?.[0] ?? "";
assert.ok(visualActionTimeoutCapsSource, "visual action timeout caps should be present");
assert.match(
  visualActionTimeoutCapsSource,
  /inspect: 20_000[\s\S]*like: 30_000[\s\S]*comment_occurrence_check: 45_000[\s\S]*comment_check: 85_000/u,
);
assert.doesNotMatch(visualActionTimeoutCapsSource, /\bcomment:|\bcomment_readback:/u);
assert.doesNotMatch(actionSource, /comment_check: 35_000/u);
assert.match(actionSource, /const timeoutMs = Math\.min\(timeoutCapMs, Math\.max\(1_000, remainingMs \+ 2_500\)\)/u);
assert.match(actionSource, /runPowerShell\(MOMENTS_VISUAL_ACTION_POWERSHELL, env,[\s\S]*sta: true,[\s\S]*timeout: timeoutMs,[\s\S]*diagnostics: true/u);
const runVisualActionSource = actionSource.match(
  /function runVisualAction\(action, context = \{\}\) \{[\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(runVisualActionSource, "visual action runner should be present");
assert.match(
  runVisualActionSource,
  /action === "comment"[\s\S]*action === "comment_readback"[\s\S]*action === "comment_occurrence_check"[\s\S]*runPowerShellAsync\(MOMENTS_VISUAL_ACTION_POWERSHELL[\s\S]*sta: true,[\s\S]*timeout: false/u,
);
assert.match(runVisualActionSource, /return runPowerShell\(MOMENTS_VISUAL_ACTION_POWERSHELL, env,[\s\S]*timeout: timeoutMs/u);
const commentAdapterSource = actionSource.match(
  /function comment\(context = \{\}\) \{[\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(commentAdapterSource, "comment adapter should be present");
assert.match(commentAdapterSource, /if \(!result\?\.ok\) return result[\s\S]*observationId: String\(context\.observationId \?\? ""\)[\s\S]*commentText/u);
assert.match(commentAdapterSource, /runVisualAction\("comment", context\)[\s\S]*typeof result\?\.then === "function" \? result\.then\(normalizeResult\) : normalizeResult\(result\)/u);
assert.match(actionSource, /function commentReadback[\s\S]*runVisualAction\("comment_readback", context\)[\s\S]*result\.then\(normalizeResult\)/u);
assert.match(
  actionSource,
  /function commentOccurrenceCheck[\s\S]*runVisualAction\("comment_occurrence_check", context\)[\s\S]*result\.then\(normalizeResult\)/u,
);
assert.match(actionSource, /function commentOccurrenceCheck[\s\S]*actionAttempted: false[\s\S]*realActionAttempted: false/u);
assert.match(windowDriverSource, /spawnOptions\.timeout = timeout/u);
assert.match(windowDriverSource, /function runPowerShellAsync[\s\S]*options\.timeout === false \? null[\s\S]*options\.sta === true[\s\S]*timeout === null \? null : setTimeout/u);

const commentPromiseHarnessSource = `
const assert = require("node:assert/strict");
const commentSource = Buffer.from(${JSON.stringify(Buffer.from(commentAdapterSource, "utf8").toString("base64"))}, "base64").toString("utf8");
const queue = [];
const comment = new Function("exactCommentText", "blocked", "runVisualAction", commentSource + "; return comment;")(
  (value) => String(value ?? ""),
  (reason) => ({ ok: false, status: "blocked", reason, actionAttempted: false }),
  (action) => {
    assert.equal(action, "comment");
    assert.ok(queue.length > 0);
    return queue.shift();
  },
);
(async () => {
  const context = { observationId: "observation-final", commentText: "exact-comment" };
  const workerSuccess = { ok: true, status: "visible_verified", actionAttempted: true, observationId: "stale", commentText: "stale", proof: { kept: true } };
  let releaseSlowWorker;
  queue.push(new Promise((resolve) => { releaseSlowWorker = resolve; }));
  const pending = comment(context);
  assert.equal(typeof pending.then, "function", "a long-running comment worker must remain asynchronous without a local hard timeout");
  setImmediate(() => releaseSlowWorker(workerSuccess));
  const normalized = await pending;
  assert.equal(normalized.observationId, context.observationId);
  assert.equal(normalized.commentText, context.commentText);
  assert.equal(normalized.actionAttempted, true);
  assert.deepEqual(normalized.proof, { kept: true });

  const failedAfterClick = { ok: false, status: "outcome_unknown", reason: "post_click_proof_failed", actionAttempted: true };
  queue.push(Promise.resolve(failedAfterClick));
  assert.strictEqual(await comment(context), failedAfterClick, "post-click failure metadata must pass through unchanged");
  const failedBeforeClick = { ok: false, status: "blocked", reason: "pre_click_blocked", actionAttempted: false };
  queue.push(Promise.resolve(failedBeforeClick));
  assert.strictEqual(await comment(context), failedBeforeClick, "pre-click failure metadata must pass through unchanged");

  queue.push(workerSuccess);
  const syncNormalized = comment(context);
  assert.equal(typeof syncNormalized.then, "undefined");
  assert.equal(syncNormalized.observationId, context.observationId);
  assert.equal(syncNormalized.commentText, context.commentText);
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;
const commentPromiseHarness = spawnSync(process.execPath, ["-e", commentPromiseHarnessSource], {
  encoding: "utf8",
  windowsHide: true,
});
assert.equal(commentPromiseHarness.status, 0, commentPromiseHarness.stderr || "comment Promise normalization harness must pass");

console.log("moments visual self-check passed");
