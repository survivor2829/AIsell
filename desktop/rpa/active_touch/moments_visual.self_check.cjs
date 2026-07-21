const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const probeFile = path.join(__dirname, "moments_visual_probe.dev.cjs");
const dryRunFile = path.join(__dirname, "moments_visual_dry_run.dev.cjs");
const actionFile = path.join(__dirname, "moments_visual_action_driver.dev.cjs");
const windowDriverFile = path.join(__dirname, "wechat_window_driver.cjs");
const probeSource = fs.readFileSync(probeFile, "utf8");
const dryRunSource = fs.readFileSync(dryRunFile, "utf8");
const actionSource = fs.readFileSync(actionFile, "utf8");
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
assert.ok(visualBoundsFunction && visualBoundsNearFunction, "visual geometry helpers should be extractable");
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
for (const name of ["comment", "commentReadback", "inspectCommentDraft", "inspectMenu", "like"]) {
  assert.equal(typeof visualActionDriver[name], "function");
}
for (const name of ["comment", "commentReadback", "inspectCommentDraft", "inspectMenu", "like"]) {
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
assert.match(currentPostLock, /\$avatarHash = Get-MomentsPixelHash \$frame \$post\.avatarBounds/u);
const freshMenuLock = actionSource.match(
  /function Get-FreshVisualMenuAnchor\([\s\S]*?\n\}\n\nfunction Test-VisualOwnedHit/u
)?.[0] ?? "";
assert.ok(freshMenuLock, "fresh visual menu lock should be present");
assert.match(freshMenuLock, /Test-VisualBoundsNear \$_\.bounds \$expectedMenuBounds \$script:momentsVisualPostRelockTolerancePx/u);
assert.match(freshMenuLock, /\$expectedHash -and \$hash -cne \$expectedHash/u);
assert.match(actionSource, /SetThreadDpiAwarenessContext\(\[IntPtr\]\(-4\)\)/u);
assert.match(actionSource, /Qt51514QWindowToolSaveBits/u);
assert.match(actionSource, /\$titleText\.ToString\(\)\.Trim\(\) -cne "Weixin"/u);
assert.match(actionSource, /Test-VisualBoundsInside \$popupBounds \$lockedBounds/u);
assert.match(actionSource, /\$surfaceInsidePopup -and \$pointInsideSurface/u);

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
assert.match(actionSource, /if \(\$sendBefore\.ok\)[\s\S]*moments_comment_preexisting_draft[\s\S]*\$sendBefore\.reason -cne "moments_comment_send_button_not_found"[\s\S]*moments_comment_draft_state_unknown/u);
const stableBlankCommentSource = actionSource.match(
  /function Get-VisualStableBlankCommentCheckpoint\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(stableBlankCommentSource, "bounded passive blank-comment checkpoint should be present");
const blankCommentFrameReaderSource = actionSource.match(
  /function Read-VisualBlankCommentFrame\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(blankCommentFrameReaderSource, "blank-comment frame reader should be present");
assert.match(blankCommentFrameReaderSource, /Get-MomentsVisualFrame \$lock\.hWnd \$lock\.windowRect \$lock\.pid \$false/u);
assert.match(blankCommentFrameReaderSource, /try \{[\s\S]*Get-VisualCommentComposer[\s\S]*Get-VisualSendButton[\s\S]*Get-MomentsPixelHash[\s\S]*\} finally \{\s*Close-MomentsVisualFrame \$frame/u);
assert.doesNotMatch(blankCommentFrameReaderSource, /Click|AtomicMouse|Keyboard|Clipboard|SetCursorPos|Focus-|Open-Visual/u);
assert.match(stableBlankCommentSource, /for \(\$pass = 0; \$pass -lt 2; \$pass\+\+\)/u);
assert.match(stableBlankCommentSource, /\$startedTick -eq \[uint32\]::MaxValue/u);
assert.match(stableBlankCommentSource, /\$pass -gt 0 -and \$startedTick -ne \$retryBaselineTick/u);
assert.match(stableBlankCommentSource, /\$finishedTick -eq \[uint32\]::MaxValue/u);
assert.match(stableBlankCommentSource, /\$finishedTick -eq \$startedTick[\s\S]*checkpointPass = \$pass/u);
assert.match(stableBlankCommentSource, /if \(\$pass -eq 0\)[\s\S]*\$retryBaselineTick = \$finishedTick[\s\S]*continue/u);
assert.match(stableBlankCommentSource, /\$stableState\.send\.ok -or \$settledState\.send\.ok[\s\S]*moments_comment_preexisting_draft/u);
assert.match(stableBlankCommentSource, /moments_comment_draft_state_unknown/u);
assert.match(stableBlankCommentSource, /Test-VisualBoundsNear \$stableState\.composer\.bounds \$expectedComposerBounds 4\.0[\s\S]*moments_comment_editor_changed/u);
assert.match(stableBlankCommentSource, /\$stableState\.avatarHash -cne \$expectedAvatarHash[\s\S]*moments_post_anchor_changed/u);
assert.doesNotMatch(stableBlankCommentSource, /Click|AtomicMouse|Keyboard|Clipboard|SetCursorPos|Focus-|Open-Visual/u);
assert.match(actionSource, /\$blankCheckpoint = Get-VisualStableBlankCommentCheckpoint[\s\S]*\$blankCheckpoint\.safeToDismiss[\s\S]*Dismiss-VisualCommentComposer[\s\S]*\$emptyCheckFinishedTick = \[uint32\]\$blankCheckpoint\.inputTick/u);
const stableBlankCommentProbeSource = `
$ErrorActionPreference = "Stop"
${stableBlankCommentSource}
function Start-Sleep { param([int]$Milliseconds) }
function Get-VisualInputTick {
  if ($script:tickIndex -ge $script:ticks.Count) { throw "tick underflow" }
  [uint32]$value = [uint32]$script:ticks[$script:tickIndex]
  $script:tickIndex += 1
  return $value
}
function Test-VisualLockedForeground($lock) {
  if ($script:foregroundIndex -ge $script:foregroundStates.Count) {
    return [bool]$script:foregroundStates[$script:foregroundStates.Count - 1]
  }
  $value = [bool]$script:foregroundStates[$script:foregroundIndex]
  $script:foregroundIndex += 1
  return $value
}
function Read-VisualBlankCommentFrame($lock, $menu, $expectedAvatarBounds) {
  if ($script:frameIndex -ge $script:frames.Count) { throw "frame underflow" }
  $value = $script:frames[$script:frameIndex]
  $script:frameIndex += 1
  return $value
}
function Test-VisualBoundsNear($first, $second, [double]$tolerance) {
  return $first -ne $null -and $second -ne $null -and [string]$first.token -ceq [string]$second.token
}
function New-BlankFrame(
  [string]$marker,
  [bool]$sendOk = $false,
  [bool]$composerOk = $true,
  [string]$boundsToken = "b",
  [string]$avatarHash = "hash",
  [string]$sendReason = "moments_comment_send_button_not_found"
) {
  return @{
    ok = $true
    marker = $marker
    composer = @{ ok = $composerOk; bounds = @{ token = $boundsToken }; marker = $marker }
    send = @{ ok = $sendOk; reason = $(if ($sendOk) { "" } else { $sendReason }); marker = $marker }
    avatarHash = $avatarHash
  }
}
function Invoke-BlankCase([object[]]$Ticks, [object[]]$Frames, [object[]]$ForegroundStates = @($true)) {
  $script:ticks = @($Ticks)
  $script:frames = @($Frames)
  $script:tickIndex = 0
  $script:frameIndex = 0
  $script:foregroundStates = @($ForegroundStates)
  $script:foregroundIndex = 0
  return Get-VisualStableBlankCommentCheckpoint @{} @{} @{ token = "b" } @{} "hash"
}

$result = Invoke-BlankCase -Ticks @([uint32]100, [uint32]100) -Frames @(
  (New-BlankFrame "quiet-1"), (New-BlankFrame "quiet-2")
)
if (-not $result.ok -or $result.checkpointPass -ne 0 -or $script:frameIndex -ne 2) { throw "quiet first pass must succeed" }

$result = Invoke-BlankCase -Ticks @([uint32]100, [uint32]101, [uint32]101, [uint32]101) -Frames @(
  (New-BlankFrame "discard-1"), (New-BlankFrame "discard-2"),
  (New-BlankFrame "accept-1"), (New-BlankFrame "accept-2")
)
if (-not $result.ok -or $result.checkpointPass -ne 1 -or $script:frameIndex -ne 4 -or $result.inputTick -ne 101 -or
  $result.composer.marker -cne "accept-2" -or $result.send.marker -cne "accept-2") { throw "one delayed tick must discard the first pass and return second-pass evidence" }

$result = Invoke-BlankCase -Ticks @([uint32]100, [uint32]101, [uint32]102) -Frames @(
  (New-BlankFrame "between-1"), (New-BlankFrame "between-2")
)
if ($result.ok -or $result.reason -cne "moments_external_input_detected" -or $script:frameIndex -ne 2) { throw "input between passes must not be rebased" }

$result = Invoke-BlankCase -Ticks @([uint32]100, [uint32]101, [uint32]101, [uint32]102) -Frames @(
  (New-BlankFrame "change-1"), (New-BlankFrame "change-2"),
  (New-BlankFrame "change-3"), (New-BlankFrame "change-4")
)
if ($result.ok -or $result.reason -cne "moments_external_input_detected" -or $result.safeToDismiss -eq $true -or $script:frameIndex -ne 4) { throw "a second changing pass must block without cleanup" }

$result = Invoke-BlankCase -Ticks @([uint32]::MaxValue) -Frames @()
if ($result.ok -or $result.reason -cne "moments_external_input_detected" -or $script:frameIndex -ne 0) { throw "MaxValue start tick must block without frames" }

$result = Invoke-BlankCase -Ticks @([uint32]100, [uint32]::MaxValue) -Frames @(
  (New-BlankFrame "max-1"), (New-BlankFrame "max-2")
)
if ($result.ok -or $result.reason -cne "moments_external_input_detected" -or $script:frameIndex -ne 2) { throw "MaxValue finish tick must block without retry" }

$result = Invoke-BlankCase -Ticks @([uint32]100, [uint32]101) -Frames @(
  (New-BlankFrame "draft-1" $true), (New-BlankFrame "draft-2")
)
if ($result.ok -or $result.reason -cne "moments_comment_preexisting_draft" -or $script:frameIndex -ne 2) { throw "a visible draft must outrank tick rebase" }

$result = Invoke-BlankCase -Ticks @([uint32]100, [uint32]101) -Frames @(
  (New-BlankFrame "unknown-1" $false $false), (New-BlankFrame "unknown-2")
)
if ($result.ok -or $result.reason -cne "moments_comment_draft_state_unknown" -or $result.safeToDismiss -eq $true -or $script:frameIndex -ne 2) { throw "unknown draft state must block without retry or cleanup" }

$result = Invoke-BlankCase -Ticks @([uint32]100, [uint32]101) -Frames @(
  (New-BlankFrame "bounds-1" $false $true "changed"), (New-BlankFrame "bounds-2")
)
if ($result.ok -or $result.reason -cne "moments_comment_editor_changed") { throw "changed composer bounds must block without retry" }

$result = Invoke-BlankCase -Ticks @([uint32]100, [uint32]101) -Frames @(
  (New-BlankFrame "anchor-1" $false $true "b" "changed"), (New-BlankFrame "anchor-2")
)
if ($result.ok -or $result.reason -cne "moments_post_anchor_changed") { throw "changed anchor must block without retry" }

$result = Invoke-BlankCase -Ticks @([uint32]100) -Frames @() -ForegroundStates @($false)
if ($result.ok -or $result.reason -cne "moments_window_not_foreground" -or $script:frameIndex -ne 0) { throw "lost foreground must block without frames" }

$result = Invoke-BlankCase -Ticks @([uint32]100, [uint32]101) -Frames @(
  (New-BlankFrame "foreground-1"), (New-BlankFrame "foreground-2")
) -ForegroundStates @($true, $false)
if ($result.ok -or $result.reason -cne "moments_external_input_detected" -or $result.safeToDismiss -eq $true -or $script:frameIndex -ne 2) { throw "foreground loss after frames must block without retry or cleanup" }
`;
const stableBlankCommentProbe = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(stableBlankCommentProbeSource, "utf16le").toString("base64")],
  { encoding: "utf8", windowsHide: true },
);
assert.equal(stableBlankCommentProbe.status, 0, stableBlankCommentProbe.stderr || "blank-comment quiet rebase behavior probe must pass");
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
assert.match(actionSource, /if \(-not \$draftProbe\.ok\)[\s\S]*Dismiss-VisualCommentComposer \$lock \$opened\.menu \$emptyCheckFinishedTick[\s\S]*moments_comment_draft_close_unverified[\s\S]*reason = \[string\]\$draftProbe\.reason/u);
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
assert.match(preMutationCommentSource, /if \(-not \$draftProbe\.ok\)[\s\S]*Dismiss-VisualCommentComposer/u);
assert.match(
  actionSource,
  /\$beforeCandidate = Find-VisualCommentCandidate \$beforeFrame \$opened\.postBounds \$opened\.menu \$commentText "exact"/u,
);
assert.match(
  actionSource,
  /Find-VisualCommentCandidate \$beforeFrame[^\n]+"exact"[\s\S]*\$beforeCandidate\.candidateCount -gt 0[\s\S]*moments_comment_duplicate/u,
);
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
assert.match(actionSource, /\$sendBefore\.ok -or -not \$sendButton\.ok/u);
assert.match(actionSource, /"comment_check"[\s\S]*Clear-And-CloseVisualCommentDraft/u);
assert.match(actionSource, /status = "comment_draft_verified"[\s\S]*actionAttempted = \$false/u);
assert.match(actionSource, /targeted_uia_value_roundtrip_and_unique_enabled_button_transition/u);
assert.match(actionSource, /\$finalEditor = Get-VisualCommentEditorAdapter \$lock \$composer\.bounds \$editorRuntimeId \$editorBounds[\s\S]*String\]::Equals\(\[string\]\$finalEditor\.value, \$commentText, \[StringComparison\]::Ordinal\)[\s\S]*GetLastInputTick\(\) -ne \$commentInputTick/u);
assert.match(actionSource, /Invoke-VisualOwnedClick \$sendX \$sendY \$lock \(\[int64\]\$context\.deadlineMs\) \$true \$true \$null \$commentInputTick/u);
assert.match(actionSource, /function Invoke-VisualOwnedClick\([\s\S]*\$expectedInputTick[\s\S]*GetLastInputTick\(\) -ne \$expectedInputTick[\s\S]*AtomicMouseClick\(\$screenX, \$screenY, \$false\)/u);
assert.match(actionSource, /status = "visible_verified"[\s\S]*commentVerified = \$true[\s\S]*unique_exact_ocr_candidate_and_stable_post_v1[\s\S]*verificationLevel = "visible_exact"[\s\S]*readbackSeed = \$readbackSeed/u);
assert.match(actionSource, /normalizedOcrCountBefore[\s\S]*normalizedOcrCountAfter/u);
assert.doesNotMatch(actionSource, /Get-VisualExactTextCount|exactCountBefore|exactCountAfter/u);

const visualClipboardRoundTripSource = actionSource.match(
  /function Invoke-VisualCommentCheckClipboardRoundTrip\([\s\S]*?\nfunction Clear-And-CloseVisualSelectedCommentDraft/u,
)?.[0] ?? "";
assert.ok(visualClipboardRoundTripSource, "locked visual clipboard comment preparation transaction should be present");
assert.doesNotMatch(visualClipboardRoundTripSource, /Write-VisualResult|Invoke-VisualOwnedClick\s+\$send|AtomicMouseClick|0x0D|VK_RETURN/u);
assert.equal((visualClipboardRoundTripSource.match(/\$failureReason = ""/gu) ?? []).length, 1, "comment-check failures must not be cleared after cleanup");
assert.match(actionSource, /if \(-not \$draftProbe\.ok\)[\s\S]*\$draftProbe\.reason -ceq "moments_comment_editor_targeting_unsupported"[\s\S]*@\("comment", "comment_check"\) -contains [^\n]+XIAOXI_MOMENTS_VISUAL_ACTION[\s\S]*Invoke-VisualCommentCheckClipboardRoundTrip/u);
assert.match(visualClipboardRoundTripSource, /\[bool\]\$retainExactDraftForSend = \$false/u);
assert.match(visualClipboardRoundTripSource, /if \(\$retainExactDraftForSend\) \{[\s\S]*\$readyState = Get-LockedVisualCommentState[\s\S]*\$stableReadyState = Get-LockedVisualCommentState[\s\S]*Test-VisualBoundsNear \$readyState\.send\.bounds \$stableReadyState\.send\.bounds 3\.0[\s\S]*Test-VisualDeadlineMargin \$deadlineMs 10000[\s\S]*Test-VisualBounds \$sendBounds 64 22[\s\S]*GetForegroundWindow\(\) -ne \$lock\.hWnd[\s\S]*GetLastInputTick\(\) -ne \$inputTick[\s\S]*\$draftRetainedForSend = \$true/u);
assert.match(visualClipboardRoundTripSource, /if \(\$draftRetainedForSend\)[\s\S]*status = "comment_draft_ready_for_send"[\s\S]*actionAttempted = \$false[\s\S]*inputTick = \$inputTick[\s\S]*clipboardRestored = \$clipboardRestored[\s\S]*draftRetainedForSend = \$true/u);
assert.match(actionSource, /\$retainExactDraftForSend = [^\n]+XIAOXI_MOMENTS_VISUAL_ACTION -ceq "comment"[\s\S]*if \(-not \$retainExactDraftForSend\) \{ Write-VisualResult \$clipboardRoundTrip \}[\s\S]*status -cne "comment_draft_ready_for_send"[\s\S]*\$visualClipboardSend = \$true/u);
assert.match(actionSource, /\$blankCheckpoint = Get-VisualStableBlankCommentCheckpoint[\s\S]*\$composer = \$blankCheckpoint\.composer[\s\S]*\$sendBefore = \$blankCheckpoint\.send[\s\S]*\$emptyCheckFinishedTick = \[uint32\]\$blankCheckpoint\.inputTick[\s\S]*\$draftProbe = Get-VisualCommentDraftTargeted/u);
assert.match(visualClipboardRoundTripSource, /Focus-VisualCommentKeyboardTarget[\s\S]*Get-LockedVisualCommentState[\s\S]*moments_comment_send_button_not_found[\s\S]*TryCaptureTextClipboard/u);
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
const immediateDismissIndex = visualClipboardRoundTripSource.indexOf("$composerClosed = Dismiss-VisualCommentComposer", boundedEmptyProofIndex);
const clipboardRestoreAfterCleanupIndex = visualClipboardRoundTripSource.indexOf("$clipboardRestoreSucceeded = Restore-VisualClipboard", immediateDismissIndex);
const retainedReadyProofIndex = visualClipboardRoundTripSource.indexOf("$readyState = Get-LockedVisualCommentState", clipboardRestoreAfterCleanupIndex);
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
assert.match(immediateCommentCheckCleanupSource, /Invoke-VisualOwnedKeyboardBackspace[\s\S]*Wait-VisualSelectedCommentDraftEmptyPair[\s\S]*Dismiss-VisualCommentComposer/u);
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
assert.match(visualClipboardRoundTripSource, /\$emptyStateCandidate = \$true[\s\S]*Dismiss-VisualCommentComposer[\s\S]*if \(\$composerClosed\)[\s\S]*\$draftCleared = \$true/u);
assert.match(actionSource, /function Dismiss-VisualCommentComposer[\s\S]*for \(\$attempt = 0; \$attempt -lt 7; \$attempt\+\+\)[\s\S]*\$missingFrames -ge 2/u);
assert.match(visualClipboardRoundTripSource, /moments_comment_draft_empty_state_unverified[\s\S]*moments_comment_composer_dismiss_unverified/u);
const selectedDraftEmptyStateSource = actionSource.match(
  /function Test-VisualSelectedCommentDraftEmpty\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(selectedDraftEmptyStateSource, "strict selected-draft empty-state predicate should be present");
assert.match(selectedDraftEmptyStateSource, /\$state\.ok[\s\S]*-not \$state\.send\.ok[\s\S]*\$state\.send\.reason -ceq "moments_comment_send_button_not_found"/u);
const selectedDraftEmptyPairSource = actionSource.match(
  /function Wait-VisualSelectedCommentDraftEmptyPair\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(selectedDraftEmptyPairSource, "bounded selected-draft empty-pair proof should be present");
assert.doesNotMatch(selectedDraftEmptyPairSource, /Invoke-VisualOwnedKeyboardBackspace|Focus-VisualCommentKeyboardTarget|Dismiss-VisualCommentComposer|Invoke-VisualOwnedClick|AtomicMouseClick|Clipboard/u);
assert.match(selectedDraftEmptyPairSource, /for \(\$pass = 0; \$pass -lt 2; \$pass\+\+\)/u);
assert.equal((selectedDraftEmptyPairSource.match(/Get-LockedVisualCommentState/gu) ?? []).length, 2, "each quiet pass must inspect exactly two locked frames");
assert.match(selectedDraftEmptyPairSource, /\$startedTick = Get-VisualInputTick[\s\S]*\$retryBaselineTick[\s\S]*\$quietStartTick = Get-VisualInputTick/u);
assert.match(selectedDraftEmptyPairSource, /Test-VisualLockedForeground \$lock[\s\S]*\$firstEmptyState = Get-LockedVisualCommentState[\s\S]*Start-Sleep -Milliseconds 500[\s\S]*\$secondEmptyState = Get-LockedVisualCommentState/u);
assert.match(selectedDraftEmptyPairSource, /Test-VisualSelectedCommentDraftEmpty \$firstEmptyState[\s\S]*Test-VisualSelectedCommentDraftEmpty \$secondEmptyState/u);
assert.match(selectedDraftEmptyPairSource, /\$finishedTick -eq \$startedTick[\s\S]*inputTick = \$finishedTick[\s\S]*if \(\$pass -eq 0 -and -not \$inputTickRebased\)[\s\S]*\$retryBaselineTick = \$finishedTick[\s\S]*continue/u);
assert.match(selectedDraftEmptyPairSource, /firstStateReason[\s\S]*firstSendReason[\s\S]*secondStateReason[\s\S]*secondSendReason/u);
assert.match(visualClipboardRoundTripSource, /\$emptyProof = Wait-VisualSelectedCommentDraftEmptyPair[\s\S]*if \(-not \$emptyProof\.ok\)[\s\S]*\$draftCleanupDiagnostics = \$emptyProof\.diagnostics[\s\S]*\$inputTick = \[uint32\]\$emptyProof\.inputTick[\s\S]*Dismiss-VisualCommentComposer \$lock \$menu \$inputTick/u);
const selectedDraftEmptyPairProbeSource = `
$ErrorActionPreference = "Stop"
${selectedDraftEmptyStateSource}
${selectedDraftEmptyPairSource}
function Start-Sleep { param([int]$Milliseconds) }
function Get-VisualInputTick {
  if ($script:tickIndex -ge $script:ticks.Count) { throw "tick underflow" }
  [uint32]$value = [uint32]$script:ticks[$script:tickIndex]
  $script:tickIndex += 1
  return $value
}
function Test-VisualLockedForeground($lock) { return $true }
function Get-LockedVisualCommentState($lock, $menu, $bounds, $avatarBounds, [string]$avatarHash) {
  if ($script:frameIndex -ge $script:frames.Count) { throw "frame underflow" }
  $value = $script:frames[$script:frameIndex]
  $script:frameIndex += 1
  return $value
}
function New-EmptyState([string]$marker, [bool]$sendOk = $false) {
  return @{ ok = $true; marker = $marker; composer = @{ ok = $true; bounds = @{} }; send = @{ ok = $sendOk; reason = $(if ($sendOk) { "" } else { "moments_comment_send_button_not_found" }) }; avatarHash = "hash" }
}
function Invoke-EmptyPairCase([object[]]$Ticks, [object[]]$Frames, [uint32]$ExpectedTick = 100) {
  $script:ticks = @($Ticks); $script:frames = @($Frames); $script:tickIndex = 0; $script:frameIndex = 0
  return Wait-VisualSelectedCommentDraftEmptyPair @{} @{} @{} @{} "hash" $ExpectedTick
}
$result = Invoke-EmptyPairCase @([uint32]100, [uint32]100) @((New-EmptyState "quiet-1"), (New-EmptyState "quiet-2"))
if (-not $result.ok -or $result.inputTick -ne 100 -or $result.inputTickRebased) { throw "quiet pair must pass without rebase" }
$result = Invoke-EmptyPairCase @([uint32]101, [uint32]101, [uint32]101) @((New-EmptyState "late-1"), (New-EmptyState "late-2"))
if (-not $result.ok -or $result.inputTick -ne 101 -or -not $result.inputTickRebased -or $script:frameIndex -ne 2) { throw "one late owned tick must pass only after a quiet pair" }
$result = Invoke-EmptyPairCase @([uint32]100, [uint32]101, [uint32]101, [uint32]101) @((New-EmptyState "discard-1"), (New-EmptyState "discard-2"), (New-EmptyState "accept-1"), (New-EmptyState "accept-2"))
if (-not $result.ok -or $result.inputTick -ne 101 -or $result.checkpointPass -ne 1 -or $script:frameIndex -ne 4) { throw "tick drift must discard the first pair and require a fresh quiet pair" }
$result = Invoke-EmptyPairCase @([uint32]100, [uint32]101, [uint32]102) @((New-EmptyState "change-1"), (New-EmptyState "change-2"))
if ($result.ok -or $result.reason -cne "moments_external_input_detected" -or $result.safeToDismiss) { throw "a second tick change must fail closed" }
$result = Invoke-EmptyPairCase @([uint32]101, [uint32]101, [uint32]102) @((New-EmptyState "late-change-1"), (New-EmptyState "late-change-2"))
if ($result.ok -or $result.reason -cne "moments_external_input_detected" -or $result.safeToDismiss -or $script:frameIndex -ne 2) { throw "a tick change after initial rebase must fail closed" }
$result = Invoke-EmptyPairCase @([uint32]100, [uint32]100) @((New-EmptyState "draft-1" $true), (New-EmptyState "draft-2"))
if ($result.ok -or $result.reason -cne "moments_comment_draft_empty_state_unverified" -or $result.safeToDismiss) { throw "enabled send must fail closed" }
`;
const selectedDraftEmptyPairProbe = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(selectedDraftEmptyPairProbeSource, "utf16le").toString("base64")],
  { encoding: "utf8", windowsHide: true },
);
assert.equal(selectedDraftEmptyPairProbe.status, 0, selectedDraftEmptyPairProbe.stderr || "selected-draft late-tick quiet-pass probe must pass");
const selectedDraftCleanupSource = actionSource.match(
  /function Clear-And-CloseVisualSelectedCommentDraft\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(selectedDraftCleanupSource, "exact selected visual draft cleanup should be present");
assert.doesNotMatch(selectedDraftCleanupSource, /Clipboard|0x41|0x43|0x56|Invoke-VisualOwnedClick|AtomicMouseClick|Write-VisualResult|0x0D|VK_RETURN/u);
assert.match(selectedDraftCleanupSource, /GetForegroundWindow\(\) -ne \$lock\.hWnd[\s\S]*GetLastInputTick\(\) -ne \$expectedInputTick[\s\S]*Invoke-VisualOwnedKeyboardBackspace/u);
assert.match(selectedDraftCleanupSource, /Invoke-VisualOwnedKeyboardBackspace[\s\S]*Wait-VisualSelectedCommentDraftEmptyPair[\s\S]*Dismiss-VisualCommentComposer/u);
assert.match(actionSource, /\$preSendLock = Get-LockedVisualRoot \$context[\s\S]*Get-LockedVisualCommentState \$preSendLock[\s\S]*Test-VisualBoundsNear \$preSendState\.send\.bounds \$clipboardRoundTrip\.sendBounds 3\.0[\s\S]*Test-VisualDeadlineMargin \(\[int64\]\$context\.deadlineMs\) 10000[\s\S]*GetForegroundWindow\(\) -eq \$preSendLock\.hWnd[\s\S]*GetLastInputTick\(\) -eq \[uint32\]\$clipboardRoundTrip\.inputTick/u);
assert.match(actionSource, /if \(-not \$preSendProofOk\)[\s\S]*Clear-And-CloseVisualSelectedCommentDraft[\s\S]*moments_comment_draft_close_unverified[\s\S]*moments_comment_editor_changed/u);
const visualSendFailureSource = actionSource.match(
  /if \(-not \(Invoke-VisualOwnedClick \$sendX \$sendY[\s\S]*?\n    Start-Sleep -Milliseconds 60/u,
)?.[0] ?? "";
assert.ok(visualSendFailureSource, "guarded visual send failure path should be present");
assert.match(visualSendFailureSource, /if \(\$visualClipboardSend\)[\s\S]*-not \$script:visualActionAttempted -and[\s\S]*Clear-And-CloseVisualSelectedCommentDraft[\s\S]*moments_comment_send_blocked/u);
assert.doesNotMatch(visualSendFailureSource, /if \(\$script:visualActionAttempted\s+-and[\s\S]*Clear-And-CloseVisualSelectedCommentDraft/u);
const postSendCommentStateSource = actionSource.match(
  /function Get-VisualPostSendCommentState\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(postSendCommentStateSource, "strict passive post-send comment state should be present");
assert.doesNotMatch(postSendCommentStateSource, /Invoke-VisualOwnedClick|AtomicMouseClick|Invoke-VisualOwnedKeyboard|AtomicKeyboard|Clipboard|Open-LockedVisualMenu|SetForegroundWindow/u);
assert.equal((postSendCommentStateSource.match(/GetLastInputTick/gu) ?? []).length, 2, "post-send frames must verify the exact input tick before and after capture");
assert.match(postSendCommentStateSource, /Get-LockedVisualRoot \$context[\s\S]*GetForegroundWindow\(\) -ne \$stateLock\.hWnd[\s\S]*Get-MomentsVisualFrame \$stateLock\.hWnd \$stateLock\.windowRect \$stateLock\.pid \$false/u);
assert.match(postSendCommentStateSource, /\$composerCompleted = -not \$composer\.ok -and \[string\]\$composer\.reason -ceq "moments_comment_composer_not_found"[\s\S]*\$avatarHash -ceq \$opened\.avatarHash[\s\S]*\$menuMatches\.Count -eq 1/u);
assert.equal((postSendCommentStateSource.match(/Find-VisualCommentCandidate/gu) ?? []).length, 1, "post-send state may perform at most one OCR candidate lookup per call");
assert.match(postSendCommentStateSource, /Find-VisualCommentCandidate[^\n]+\$commentText "exact"/u);
assert.match(postSendCommentStateSource, /Get-MomentsPixelHash \$frame \$expectedCandidateBounds[\s\S]*\$observedCandidateHash -ceq \$expectedCandidateHash/u);
assert.match(postSendCommentStateSource, /\$hashProofRequired[\s\S]*moments_comment_readback_seed_unstable[\s\S]*GetLastInputTick\(\)[\s\S]*moments_external_input_detected/u);
const postSendBudgetSource = actionSource.match(
  /function Test-VisualPostSendBudget\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(postSendBudgetSource, "post-send acceptance budget should be explicit");
assert.match(postSendBudgetSource, /\$nowMs -lt \$settleDeadlineMs[\s\S]*\$script:visualWorkerSoftDeadlineMs[\s\S]*Test-VisualDeadlineMargin[^\n]+5000/u);
const postSendSurfaceSettleSource = actionSource.match(
  /function Wait-VisualPostSendSurfaceSettled\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(postSendSurfaceSettleSource, "bounded passive post-send surface settle should be present");
assert.doesNotMatch(postSendSurfaceSettleSource, /Find-VisualCommentCandidate|Invoke-VisualOwnedClick|AtomicMouseClick|Keyboard|Clipboard/u);
assert.match(postSendSurfaceSettleSource, /for \(\$attempt = 0; \$attempt -lt 20; \$attempt\+\+\)[\s\S]*Test-VisualPostSendBudget[\s\S]*Get-VisualPostSendCommentState[\s\S]*\$consecutiveFrames -ge 2[\s\S]*Start-Sleep -Milliseconds 120/u);
assert.match(postSendSurfaceSettleSource, /Get-VisualPostSendCommentState[\s\S]*Test-VisualPostSendBudget[\s\S]*if \(\$lastState\.ok\)/u);
const readbackSeedWaitSource = actionSource.match(
  /function Wait-VisualCommentReadbackSeed\([\s\S]*?\n\}/u,
)?.[0] ?? "";
assert.ok(readbackSeedWaitSource, "bounded passive readback-seed wait should be present");
assert.doesNotMatch(readbackSeedWaitSource, /Invoke-VisualOwnedClick|AtomicMouseClick|Keyboard|Clipboard|Open-LockedVisualMenu/u);
assert.match(readbackSeedWaitSource, /\$sampleOffsetsMs = @\(0, 2200, 5000\)[\s\S]*for \(\$ocrAttempt = 0; \$ocrAttempt -lt \$sampleOffsetsMs\.Count; \$ocrAttempt\+\+\)[\s\S]*Start-Sleep -Milliseconds \$sampleWaitMs[\s\S]*Wait-VisualPostSendSurfaceSettled[\s\S]*Start-Sleep -Milliseconds 350[\s\S]*Get-VisualPostSendCommentState[^\n]+\$true[\s\S]*Start-Sleep -Milliseconds 160[\s\S]*Get-VisualPostSendCommentState[^\n]+\$false \$candidateState\.candidate\.bounds/u);
assert.ok((readbackSeedWaitSource.match(/Test-VisualPostSendBudget/gu) ?? []).length >= 5, "every passive wait/capture stage must recheck all post-send deadlines");
assert.match(readbackSeedWaitSource, /GetLastInputTick\(\) -ne \$expectedInputTick[\s\S]*moments_external_input_detected/u);
assert.match(readbackSeedWaitSource, /if \(-not \$surface\.ok\)[\s\S]*Test-VisualPostSendBudget[\s\S]*continue/u);
assert.match(readbackSeedWaitSource, /candidateCount = \[int\]\$candidateState\.candidate\.candidateCount[\s\S]*candidateExactMatch = \[bool\]\$candidateState\.candidate\.exactMatch[\s\S]*candidateHashStable = \[bool\]\$stableState\.diagnostics\.candidateHashStable[\s\S]*candidateStable = \$true/u);
assert.match(actionSource, /\$script:visualWorkerSoftDeadlineMs = \(Get-VisualEpochMs\) \+ 45000/u);
assert.match(actionSource, /\$script:visualPostSendSettleMs = 15000[\s\S]*\$script:visualPostSendRequiredMs = 18000[\s\S]*\$script:visualCommentReadbackRequiredMs = 30000[\s\S]*\$script:visualContextPostSendRequiredMs = \$script:visualPostSendSettleMs \+ \$script:visualCommentReadbackRequiredMs/u);
assert.match(actionSource, /\$preSendNowMs = Get-VisualEpochMs[\s\S]*visualWorkerSoftDeadlineMs - \$preSendNowMs[\s\S]*visualPostSendRequiredMs[\s\S]*Clear-And-CloseVisualSelectedCommentDraft[\s\S]*Clear-And-CloseVisualCommentDraft[\s\S]*moments_comment_send_budget_exhausted/u);
assert.match(actionSource, /\$preSendNowMs = Get-VisualEpochMs[\s\S]*Test-VisualDeadlineMargin \(\[int64\]\$context\.deadlineMs\) \$script:visualContextPostSendRequiredMs/u);
assert.match(actionSource, /\$postClickInputTick = [^\n]+GetLastInputTick[\s\S]*Start-Sleep -Milliseconds 60[\s\S]*GetLastInputTick\(\) -ne \$postClickInputTick[\s\S]*moments_external_input_detected[\s\S]*\$nowAfterClickMs \+ \$script:visualPostSendSettleMs[\s\S]*\$script:visualWorkerSoftDeadlineMs[\s\S]*\$context\.deadlineMs - 5000[\s\S]*Wait-VisualCommentReadbackSeed/u);
assert.doesNotMatch(actionSource, /Start-Sleep -Milliseconds 650/u);
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
assert.match(stableBlankCommentSource, /Start-Sleep -Milliseconds 140\s+\$stableState = Read-VisualBlankCommentFrame[\s\S]*Start-Sleep -Milliseconds 260\s+\$settledState = Read-VisualBlankCommentFrame/u);
assert.match(stableBlankCommentSource, /\$stableState\.composer\.ok[\s\S]*\$settledState\.composer\.ok[\s\S]*Test-VisualBoundsNear \$stableState\.composer\.bounds \$settledState\.composer\.bounds 4\.0/u);
assert.match(stableBlankCommentSource, /\$stableState\.send\.reason -cne "moments_comment_send_button_not_found"[\s\S]*\$settledState\.send\.reason -cne "moments_comment_send_button_not_found"/u);

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
assert.match(actionSource, /function Test-VisualCommentReadbackSeed[\s\S]*seed\.expectedInputTick -ge \[uint32\]::MaxValue[\s\S]*GetLastInputTick\(\) -eq \[uint32\]\$seed\.expectedInputTick/u);
assert.match(actionSource, /expectedInputTick = \[uint32\]\$postClickInputTick/u);
assert.match(actionSource, /\$copyX = [^\n]+\$copyEntry\.bounds/u);
assert.match(actionSource, /public static bool TryCaptureTextClipboard/u);
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
assert.match(visualClipboardRoundTripSource, /\$exactDraftProven = \$true[\s\S]*GetLastInputTick\(\) -ne \$inputTick[\s\S]*\$clipboardRestoreSucceeded = Restore-VisualClipboard[\s\S]*TryClipboardTextMatches\([\s\S]*\$originalClipboardText[\s\S]*\$originalClipboardMatches[\s\S]*if \(-not \$clipboardRestoreSucceeded\)[\s\S]*moments_comment_clipboard_restore_failed[\s\S]*\$readyState = Get-LockedVisualCommentState/u);
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

// A filled heart may create a wider color gap than the outline state. Both
// states still require the same unique popup geometry and exact 评论 anchor.
assert.match(actionSource, /\$x - \$lastDark\) -gt \[Math\]::Max\(18\.0, \[double\]\$frame\.width \* 0\.05\)/u);
assert.match(actionSource, /\$widthRatio -ge 0\.32[\s\S]*\$visualState = "赞"/u);
assert.match(actionSource, /\$widthRatio -ge 0\.78[\s\S]*\$visualState = "取消"/u);
assert.match(actionSource, /VISUAL_ACTION_TIMEOUT_CAP_MS = Object\.freeze\(\{[\s\S]*inspect: 20_000[\s\S]*comment_check: 85_000[\s\S]*comment: 55_000[\s\S]*comment_readback: 30_000/u);
assert.doesNotMatch(actionSource, /comment_check: 35_000/u);
assert.match(actionSource, /const timeoutMs = Math\.min\(timeoutCapMs, Math\.max\(1_000, remainingMs \+ 2_500\)\)/u);
assert.match(actionSource, /runPowerShell\(MOMENTS_VISUAL_ACTION_POWERSHELL, env,[\s\S]*sta: true,[\s\S]*timeout: timeoutMs,[\s\S]*diagnostics: true/u);
assert.match(actionSource, /action === "comment_readback"[\s\S]*runPowerShellAsync\(MOMENTS_VISUAL_ACTION_POWERSHELL[\s\S]*sta: true,[\s\S]*timeout: false/u);
assert.match(actionSource, /function commentReadback[\s\S]*runVisualAction\("comment_readback", context\)[\s\S]*result\.then\(normalizeResult\)/u);
assert.match(actionSource, /Test-VisualDeadlineMargin \(\[int64\]\$context\.deadlineMs\) 5000[\s\S]*Test-VisualDeadlineMargin \(\[int64\]\$context\.deadlineMs\) 10000/u);
assert.match(windowDriverSource, /spawnOptions\.timeout = timeout/u);
assert.match(windowDriverSource, /function runPowerShellAsync[\s\S]*options\.timeout === false \? null[\s\S]*options\.sta === true[\s\S]*timeout === null \? null : setTimeout/u);

console.log("moments visual self-check passed");
