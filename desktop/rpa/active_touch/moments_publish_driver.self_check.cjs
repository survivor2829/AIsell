const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MOMENTS_PUBLISH_CAMERA_PROFILE,
  MOMENTS_PUBLISH_FILE_DIALOG_TITLE_PREFIXES,
  MOMENTS_PUBLISH_POWERSHELL,
  PUBLISH_MARKER_DIRECTORY,
  validMarkerPath,
  verificationToken
} = require("./moments_publish_driver.dev.cjs");
const {
  MOMENTS_INTEGRATED_SURFACE_EVIDENCE_POWERSHELL
} = require("./moments_surface_evidence.dev.cjs");
const { MOMENTS_VISUAL_READONLY_POWERSHELL } = require("./moments_visual_probe.dev.cjs");

assert.deepEqual(MOMENTS_PUBLISH_CAMERA_PROFILE, {
  name: "wechat_moments_render_pane_camera_glyph",
  standaloneLogicalRight: 24,
  standaloneLogicalTop: 24,
  integratedLogicalRight: 32,
  integratedLogicalTop: 56,
  logicalRadiusX: 17,
  logicalRadiusY: 13,
  logicalHeaderHeight: 80
});
assert.deepEqual(MOMENTS_PUBLISH_FILE_DIALOG_TITLE_PREFIXES, ["打开", "选择文件", "Open"]);
assert.equal(PUBLISH_MARKER_DIRECTORY, "publish_markers");
assert.ok(
  MOMENTS_PUBLISH_POWERSHELL.includes(MOMENTS_INTEGRATED_SURFACE_EVIDENCE_POWERSHELL),
  "publishing and interactions must share the same integrated Moments page proof"
);
const parsePowerShell = [
  "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))",
  "$tokens=$null",
  "$errors=$null",
  "[void][System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)",
  "if($errors.Count){$errors | ForEach-Object {$_.ToString()}; exit 1}"
].join(";");
const parsedPublish = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", parsePowerShell], {
  input: Buffer.from(MOMENTS_PUBLISH_POWERSHELL, "utf8").toString("base64"),
  encoding: "utf8"
});
assert.equal(parsedPublish.status, 0, parsedPublish.stderr || parsedPublish.stdout || "publish PowerShell must parse");
assert.doesNotMatch(MOMENTS_PUBLISH_POWERSHELL, /ShowWindowAsync|SetForegroundWindow|AppActivate/u,
  "publishing must stop on focus loss instead of stealing the user's foreground window");
assert.doesNotMatch(MOMENTS_PUBLISH_POWERSHELL, /Get-MomentsVisualFrame\s+\$lock\.hWnd\s+\$lock\.rect\s+\$lock\.pid\s+\$true/u,
  "publishing frames must use passive foreground checks");

assert.match(
  MOMENTS_PUBLISH_POWERSHELL,
  /\$title -cne \$expectedTitle[\s\S]*\$className -cne \$expectedClassName[\s\S]*@\("standalone", "integrated"\) -notcontains \$surfaceMode/u,
  "the driver must rebind the exact navigation-captured window profile"
);
assert.doesNotMatch(MOMENTS_PUBLISH_POWERSHELL, /\$title -cne "朋友圈"/u);
assert.match(
  MOMENTS_PUBLISH_POWERSHELL,
  /GetWindowThreadProcessId\(\$hWnd, \[ref\]\$actualPid\)[\s\S]*\[int\]\$actualPid -ne \$expectedPid[\s\S]*@\("Weixin", "WeChat"\) -notcontains \$process\.ProcessName/u,
  "the supplied HWND must belong to the supplied WeChat PID"
);
assert.match(
  MOMENTS_PUBLISH_POWERSHELL,
  /Get-MomentsRenderPaneEvidence \$root \$expectedPid[\s\S]*renderPane = \$renderPane\.pane/u,
  "all object evidence must remain bound to the unique MMUI render pane"
);

const manifestSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishFileSha256"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishWindowLock")
);
assert.match(manifestSource, /SHA256\]::Create\(\)[\s\S]*ComputeHash\(\$stream\)/u);
assert.match(manifestSource, /\$paths\.Count -ne \$declaredCount[\s\S]*\$manifest\.Count -ne \$declaredCount/u);
assert.match(manifestSource, /\$filePath -cne \$paths\[\$index\]/u);
assert.match(manifestSource, /\$expectedHash -notmatch "\^\[a-f0-9\]\{64\}\$"/u);
assert.match(manifestSource, /\$file\.Length -ne \$expectedSize[\s\S]*\$file\.Extension[\s\S]*\$file\.Name/u);
assert.match(manifestSource, /PadLeft\(2, "0"\)[\s\S]*Substring\(0, 12\)[\s\S]*\$expectedExtension/u,
  "the staged basename must bind ordinal, content hash and extension");
assert.match(manifestSource, /Get-PublishFileSha256 \$file\.FullName[\s\S]*\$actualHash -cne \$expectedHash/u);

const flowMatches = [...MOMENTS_PUBLISH_POWERSHELL.matchAll(/try \{\r?\n  \$contextJson =/gu)];
assert.equal(flowMatches.length, 1, "the publish flow must have one top-level context entrypoint");
const flowStart = flowMatches[0].index;
const flowSource = MOMENTS_PUBLISH_POWERSHELL.slice(flowStart);
const topLevelCatchSource = flowSource.slice(flowSource.lastIndexOf("} catch {"));
assert.match(topLevelCatchSource, /failureKind = "powershell_exception"/u);
assert.match(topLevelCatchSource, /exceptionCategory = \(\[string\]\$_\.CategoryInfo\.Category\)/u);
assert.match(topLevelCatchSource, /exceptionType =/u);
assert.doesNotMatch(
  topLevelCatchSource,
  /Exception\.Message|StackTrace|InvocationInfo|ScriptStackTrace/u,
  "publish diagnostics must retain only code-like exception breadcrumbs"
);
const topLevelCatchProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-STA",
  "-NonInteractive",
  "-Command",
  "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); Invoke-Expression $source"
], {
  input: Buffer.from(MOMENTS_PUBLISH_POWERSHELL, "utf8").toString("base64"),
  encoding: "utf8",
  env: { ...process.env, XIAOXI_MOMENTS_PUBLISH_CONTEXT_BASE64: "not-base64!" },
  windowsHide: true,
  timeout: 30_000
});
assert.equal(
  topLevelCatchProbe.status,
  0,
  topLevelCatchProbe.stderr || topLevelCatchProbe.stdout || "top-level publish catch must return JSON"
);
const topLevelCatchResult = JSON.parse(topLevelCatchProbe.stdout.trim().split(/\r?\n/u).at(-1));
assert.equal(topLevelCatchResult.ok, false);
assert.equal(topLevelCatchResult.stage, "initialized");
assert.equal(topLevelCatchResult.failureKind, "powershell_exception");
assert.match(topLevelCatchResult.exceptionCategory, /^[A-Za-z][A-Za-z0-9_]{0,63}$/u);
assert.match(topLevelCatchResult.exceptionType, /^[A-Za-z][A-Za-z0-9_.+]{0,159}$/u);
assert.equal(Object.hasOwn(topLevelCatchResult, "exceptionMessage"), false);
const preManifestIndex = flowSource.indexOf("$manifestProof = Test-PublishMediaManifest $context");
const fileSelectionIndex = flowSource.indexOf("Set-PublishDialogFiles $fileDialog $mediaPaths");
const finalManifestIndex = flowSource.indexOf("$finalManifestProof = Test-PublishMediaManifest $context");
const publishClickIndex = flowSource.indexOf("$publishClick = Invoke-PublishOwnedClick");
assert.ok(preManifestIndex >= 0 && fileSelectionIndex > preManifestIndex,
  "every staged file must be rehashed before it reaches the file dialog");
assert.ok(finalManifestIndex > fileSelectionIndex && publishClickIndex > finalManifestIndex,
  "every staged file must be rehashed again immediately before the irreversible phase");

const fileDialogSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Test-PublishFileDialogLease"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Wait-PublishMediaProcessing")
);
assert.match(fileDialogSource, /function Get-PublishFileDialog\(\$lock\)/u);
assert.doesNotMatch(
  fileDialogSource,
  /expectedInputTick|GetLastInputTick|moments_publish_external_input_detected/u,
  "file-dialog discovery and UIA readback must not inherit a workflow-wide Windows input tick"
);
assert.doesNotMatch(
  fileDialogSource,
  /\[uint32\]\$pid\b|\[ref\]\$pid\b/iu,
  "PowerShell's case-insensitive $PID automatic variable must never be used as a writable out parameter"
);
assert.match(fileDialogSource, /\[int\]\$candidatePid -ne \$expectedPid/u);
assert.doesNotMatch(
  fileDialogSource,
  /\$matches\b/iu,
  "a collector must not alias PowerShell's case-insensitive $Matches regex automatic variable"
);
assert.match(fileDialogSource, /\$dialogCandidates\.Add\(/u);
assert.match(fileDialogSource, /#32770/u);
assert.match(fileDialogSource, /\^\(打开\|选择文件\|Open\)/u);
assert.match(fileDialogSource, /GetWindow\(\$hWnd, 4\) -ne \$expectedOwner/u);
assert.match(fileDialogSource, /AtomicKeyChord[\s\S]*AtomicUnicodeText[\s\S]*AtomicVirtualKey/u);
assert.match(
  fileDialogSource,
  /GetDlgItem\(\$dialogHandle, 1\)[\s\S]*GetDlgCtrlID\(\$buttonHandle\) -ne 1[\s\S]*GetClassName\(\$buttonHandle[\s\S]*GetWindowText\(\$buttonHandle/u,
  "the standard file dialog Open action must bind the native IDOK child instead of counting duplicate UIA wrappers"
);
assert.match(fileDialogSource, /AtomicVirtualKey\(0x0D\)[\s\S]*moments_publish_file_dialog_did_not_close/u);
assert.doesNotMatch(fileDialogSource, /openButtons\.Count -ne 1|moments_publish_open_button_ambiguous/u);
assert.match(
  fileDialogSource,
  /function Set-PublishDialogFiles\(\$dialog, \$mediaPaths\)[\s\S]*AtomicKeyChord\(0x12, 0x4E\)[\s\S]*AtomicKeyChord\(0x11, 0x41\)[\s\S]*AtomicUnicodeText\(\$fileValue\)[\s\S]*AtomicVirtualKey\(0x0D\)/u,
  "the file dialog must use its File name accelerator, exact replacement, and Enter instead of depending on Windows' internal control tree"
);
assert.doesNotMatch(
  fileDialogSource,
  /Get-PublishFileNameTarget|Set-PublishNativeTextTarget|horizontalGap|verticalGap|bottomActionField/u,
  "filename entry must not depend on direct or geometric discovery of nested common-dialog controls"
);
assert.match(
  fileDialogSource,
  /function Test-PublishFileDialogLease[\s\S]*GetWindowThreadProcessId\(\$hWnd, \[ref\]\$candidatePid\)[\s\S]*\$classText\.ToString\(\) -cne \[string\]\$dialog\.className[\s\S]*\$titleText\.ToString\(\)\.Trim\(\) -cne \[string\]\$dialog\.title[\s\S]*GetWindow\(\$hWnd, 4\) -ne \[IntPtr\]\$dialog\.owner[\s\S]*GetForegroundWindow\(\) -ne \$hWnd/u,
  "every dialog action must retain the exact acquired PID/HWND/class/title/owner and foreground"
);
assert.match(
  fileDialogSource,
  /function Set-PublishDialogFiles\(\$dialog, \$mediaPaths\)[\s\S]*Test-PublishFileDialogLease \$dialog[\s\S]*AtomicUnicodeText\(\$fileValue\)[\s\S]*Test-PublishFileDialogLease \$dialog[\s\S]*AtomicVirtualKey\(0x0D\)[\s\S]*IsWindowVisible/u,
  "keyboard filename entry and confirmation must retain exact dialog identity and require the owned dialog to close"
);

const fileDialogProbeSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  0,
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Set-PublishDialogFiles")
);
const fileDialogProbeProgram = `
${fileDialogProbeSource}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PublishDialogFixture {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateWindowEx(
    uint exStyle,
    string className,
    string windowName,
    uint style,
    int x,
    int y,
    int width,
    int height,
    IntPtr parent,
    IntPtr menu,
    IntPtr instance,
    IntPtr param
  );
  [DllImport("user32.dll")]
  public static extern bool DestroyWindow(IntPtr hWnd);
}
"@
[uint32]$visiblePopup = 2415919104
$owner = [PublishDialogFixture]::CreateWindowEx(
  0, "STATIC", "fixture-owner", $visiblePopup,
  -32000, -32000, 1, 1,
  [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero
)
$dialog = [PublishDialogFixture]::CreateWindowEx(
  0, "#32770", "选择文件", $visiblePopup,
  -32000, -32000, 640, 480,
  $owner, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero
)
try {
  if ($owner -eq [IntPtr]::Zero -or $dialog -eq [IntPtr]::Zero) {
    throw "file_dialog_fixture_creation_failed"
  }
  $lock = @{
    hWnd = $owner
    pid = [Diagnostics.Process]::GetCurrentProcess().Id
  }
  $dialogResult = Get-PublishFileDialog $lock
  @{ dialog = $dialogResult } | ConvertTo-Json -Compress -Depth 6
} finally {
  if ($dialog -ne [IntPtr]::Zero) { [void][PublishDialogFixture]::DestroyWindow($dialog) }
  if ($owner -ne [IntPtr]::Zero) { [void][PublishDialogFixture]::DestroyWindow($owner) }
}
`;
const fileDialogProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-STA",
  "-NonInteractive",
  "-Command",
  "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); Invoke-Expression $source"
], {
  input: Buffer.from(fileDialogProbeProgram, "utf8").toString("base64"),
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000
});
assert.equal(
  fileDialogProbe.status,
  0,
  fileDialogProbe.stderr || fileDialogProbe.stdout || "file-dialog enumeration must not throw"
);
const fileDialogProbeResult = JSON.parse(fileDialogProbe.stdout.trim());
if (fileDialogProbeResult.dialog.ok) {
  assert.equal(fileDialogProbeResult.dialog.dialog.title, "选择文件");
  assert.equal(fileDialogProbeResult.dialog.dialog.className, "#32770");
} else {
  assert.equal(fileDialogProbeResult.dialog.reason, "moments_publish_file_dialog_not_foreground");
}

const unsupportedFileDialogProbeProgram = fileDialogProbeProgram.replace(
  '0, "#32770", "选择文件", $visiblePopup,',
  '0, "#32770", "另存为", $visiblePopup,'
);
assert.notEqual(unsupportedFileDialogProbeProgram, fileDialogProbeProgram);
const unsupportedFileDialogProbe = spawnSync("powershell.exe", [
  "-NoProfile",
  "-STA",
  "-NonInteractive",
  "-Command",
  "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); Invoke-Expression $source"
], {
  input: Buffer.from(unsupportedFileDialogProbeProgram, "utf8").toString("base64"),
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000
});
assert.equal(
  unsupportedFileDialogProbe.status,
  0,
  unsupportedFileDialogProbe.stderr || unsupportedFileDialogProbe.stdout || "unsupported dialog-title probe must run"
);
assert.equal(
  JSON.parse(unsupportedFileDialogProbe.stdout.trim()).dialog.reason,
  "moments_publish_file_dialog_missing",
  "unrelated common dialogs must remain outside the WeChat media-selection allowlist"
);

const mediaEvidenceSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishAccessibilityMetadata"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishFocusedTarget")
);
assert.match(mediaEvidenceSource, /\$lock\.renderPane\.element\.FindAll/u);
assert.match(mediaEvidenceSource, /Current\.Name[\s\S]*Current\.AutomationId[\s\S]*Current\.HelpText[\s\S]*Current\.ItemStatus[\s\S]*Current\.ItemType/u);
assert.match(mediaEvidenceSource, /\\d\{2\}-\[a-f0-9\]\{12\}\\\.\(\?:jpeg\|jpg\|png\|mov\|mp4\)/u);
assert.match(
  mediaEvidenceSource,
  /\$allowedTypes = @\("ControlType\.Image", "ControlType\.ListItem", "ControlType\.Button", "ControlType\.Custom"\)[\s\S]*\$allowedTypes -notcontains \$controlType/u,
  "only allowlisted attachment-shaped controls may supply media evidence"
);
assert.match(
  mediaEvidenceSource,
  /Current\.IsOffscreen[\s\S]*Test-MomentsVisualBoundsInside \$absoluteBounds \$containerBounds[\s\S]*TreeScope\]::Children[\s\S]*\$children\.Count -ne 0/u,
  "media evidence must come from visible leaf controls inside the bound container"
);
assert.match(mediaEvidenceSource, /Test-MomentsVisualBoundsInside \$containerBounds \$lock\.renderPane\.bounds/u);
assert.match(mediaEvidenceSource, /\$matchedExpectedNames\.Count -ne 1 -or \$stagedNames\.Count -ne 1/u);
assert.match(
  mediaEvidenceSource,
  /\$runtimeIdByName\.ContainsKey\(\$matchedName\) -or \$nameByRuntimeId\.ContainsKey\(\$runtimeId\)[\s\S]*\$runtimeIdByName\[\$matchedName\] = \$runtimeId[\s\S]*\$nameByRuntimeId\[\$runtimeId\] = \$matchedName/u,
  "every expected media name must bind one distinct UIA runtime id"
);
assert.match(mediaEvidenceSource, /\$discoveredSet\.Count -ne \$expectedSet\.Count -or \$runtimeIdByName\.Count -ne \$expectedSet\.Count/u);
assert.match(mediaEvidenceSource, /\$parts\.Add\(\$name \+ "=" \+ \[string\]\$runtimeIdByName\[\$name\]\)/u);
assert.match(mediaEvidenceSource, /\$evidenceKey -cne \$expectedEvidenceKey/u,
  "the final proof must rebind the same accessibility attachment objects");
assert.match(flowSource, /Wait-PublishMediaProcessing[\s\S]*Test-PublishComposerMediaEvidence \$lock \$manifestProof/u);
assert.equal(
  (flowSource.match(/Test-PublishComposerMediaEvidence \$lock \$manifestProof/gu) ?? []).length,
  1,
  "the independent composer must prove loaded media once; later button visibility must not masquerade as repeated media proof"
);
assert.match(
  flowSource,
  /\$finalManifestProof = Test-PublishMediaManifest \$context[\s\S]*\$finalContentProof = Test-PublishComposerContentFinal \$lock \$expectedContent[\s\S]*\$freshObservation = Get-PublishButtonObservation[\s\S]*Invoke-PublishOwnedClick/u,
  "the source media manifest and complete composer content must be rebound immediately before the irreversible click"
);

const editorSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishFocusedTarget"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Find-PublishButton")
);
assert.match(editorSource, /AutomationElement\]::FocusedElement/u);
assert.match(editorSource, /IsKeyboardFocusable[\s\S]*HasKeyboardFocus/u);
assert.match(editorSource, /\$lock\.renderPane\.element\.FindAll/u);
assert.match(editorSource, /ControlType\.Edit[\s\S]*ValuePattern\]::Pattern[\s\S]*IsReadOnly/u);
assert.doesNotMatch(editorSource, /ControlType\.Document|TextPattern\]::Pattern|DocumentRange/u);
assert.match(
  editorSource,
  /\$bounds\.Width -lt \(\[double\]\$paneBounds\.width \* 0\.45\)[\s\S]*\$bounds\.Height -lt \(\[double\]\$paneBounds\.height \* 0\.06\)/u,
  "the writable Edit must occupy a substantial portion of the composer"
);
assert.match(editorSource, /Test-MomentsVisualBoundsInside \$absoluteBounds \$paneBounds/u);
assert.match(editorSource, /\$candidates\.Count -ne 1[\s\S]*moments_publish_editor_ambiguous[\s\S]*moments_publish_editor_not_writable/u);
assert.match(editorSource, /function Get-PublishEditorObservation[\s\S]*Get-PublishFocusedTarget \$lock[\s\S]*runtimeId[\s\S]*Get-MomentsOcrObservation \$frame \$relativeBounds/u,
  "content OCR must be cropped to the rebound writable editor"
);
assert.match(
  flowSource,
  /Wait-PublishComposerWindowLock \$context \$mainLock[\s\S]*Set-PublishComposerContent \$lock \$expectedContent \$token/u,
  "after the file dialog, the flow must wait boundedly for and then rebind the owned composer before entering content"
);
const composerWindowSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishComposerWindowLock"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Test-PublishOwnedPoint")
);
assert.match(composerWindowSource, /GetWindow\(\$candidateHWnd, 4\) -ne \$expectedOwner/u);
assert.match(composerWindowSource, /\[int\]\$candidatePid -ne \$expectedPid/u);
assert.match(composerWindowSource, /\$titleText\.ToString\(\)\.Trim\(\) -cne \$expectedTitle/u);
assert.match(composerWindowSource, /\$classText\.ToString\(\)\.Trim\(\) -cne \$expectedClassName/u);
assert.match(composerWindowSource, /\$composerCandidates\.Count -ne 1[\s\S]*moments_publish_composer_ambiguous/u);
assert.match(composerWindowSource, /GetForegroundWindow\(\) -ne \[IntPtr\]\$candidate\.hWnd/u,
  "the separate composer must remain the unique foreground window owned by the locked WeChat main window");
assert.match(
  composerWindowSource,
  /function Wait-PublishComposerWindowLock[\s\S]*\$attempt -lt 30[\s\S]*moments_publish_composer_not_found[\s\S]*moments_publish_composer_not_foreground[\s\S]*Start-Sleep -Milliseconds 200/u,
  "the post-dialog composer transition must tolerate only bounded not-found/foreground settling"
);
const composerWaitFunction = composerWindowSource.match(
  /function Wait-PublishComposerWindowLock\([^\n]+\) \{[\s\S]*?\n\}/u
)?.[0] ?? "";
assert.ok(composerWaitFunction, "the bounded composer wait helper must be extractable");
const composerWaitHarness = spawnSync("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));Invoke-Expression $source"
], {
  input: Buffer.from(`
function Start-Sleep { param([int]$Milliseconds) }
${composerWaitFunction}
$script:probe = 0
function Get-PublishComposerWindowLock($context, $mainLock) {
  $script:probe += 1
  if ($script:probe -lt 3) { return @{ ok = $false; reason = "moments_publish_composer_not_found" } }
  return @{ ok = $true; hWnd = 42 }
}
$settled = Wait-PublishComposerWindowLock @{} @{ ok = $true }
$settledCalls = $script:probe
$script:probe = 0
function Get-PublishComposerWindowLock($context, $mainLock) {
  $script:probe += 1
  return @{ ok = $false; reason = "moments_publish_composer_ambiguous" }
}
$ambiguous = Wait-PublishComposerWindowLock @{} @{ ok = $true }
@{ settledOk = [bool]$settled.ok; settledCalls = $settledCalls; ambiguousReason = [string]$ambiguous.reason; ambiguousCalls = $script:probe } | ConvertTo-Json -Compress
`, "utf8").toString("base64"),
  encoding: "utf8",
  windowsHide: true
});
assert.equal(composerWaitHarness.status, 0, composerWaitHarness.stderr || "bounded composer wait harness must run");
assert.deepEqual(JSON.parse(composerWaitHarness.stdout.trim()), {
  ambiguousCalls: 1,
  ambiguousReason: "moments_publish_composer_ambiguous",
  settledCalls: 3,
  settledOk: true
});
const composerInputSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Set-PublishComposerContent"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishBoundMediaEvidence")
);
const clipboardReadbackSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishSelectedContent"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Set-PublishComposerContent")
);
const clipboardPasteSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Set-PublishComposerContentFromClipboard"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Set-PublishComposerContent($lock, [string]$expectedContent, [string]$token)")
);
assert.doesNotMatch(
  composerInputSource,
  /Find-PublishButton/u,
  "the reversible content step must not require publish-button recognition before it can type"
);
assert.match(
  composerInputSource,
  /Get-PublishFullObservation \$lock \$true[\s\S]*Invoke-PublishOwnedClick[\s\S]*AtomicKeyChord\(0x11, 0x41\)[\s\S]*Set-PublishComposerContentFromClipboard \$lock \$expectedContent/u,
  "composer input must replace any selected draft through a Unicode clipboard paste"
);
assert.doesNotMatch(
  composerInputSource,
  /AtomicUnicodeText\(\$expectedContent\)/u,
  "the WeChat rich editor must not receive the whole body as UTF-16 keyboard code units"
);
assert.match(
  clipboardReadbackSource,
  /function Get-PublishSelectedContent[\s\S]*Clipboard\]::GetDataObject\(\)[\s\S]*Clipboard\]::SetText\(\$probe, \[Windows\.Forms\.TextDataFormat\]::UnicodeText\)[\s\S]*AtomicKeyChord\(0x11, 0x43\)[\s\S]*Wait-PublishClipboardSelection \$probe \$requireNonEmpty[\s\S]*finally[\s\S]*Clipboard\]::SetDataObject\(\$backup, \$true\)/u,
  "exact text readback must wait past its sentinel and restore the user's clipboard"
);
assert.match(
  clipboardPasteSource,
  /function Set-PublishComposerContentFromClipboard[\s\S]*Clipboard\]::GetDataObject\(\)[\s\S]*Clipboard\]::SetText\(\$expectedContent, \[Windows\.Forms\.TextDataFormat\]::UnicodeText\)[\s\S]*Test-PublishExactContent[\s\S]*SendKeys\]::SendWait\("\^v"\)[\s\S]*finally[\s\S]*Clipboard\]::SetDataObject\(\$backup, \$true\)/u,
  "Unicode paste must synchronously submit its payload and restore the user's clipboard in finally"
);
assert.doesNotMatch(
  clipboardPasteSource,
  /AtomicKeyChord\(0x11, 0x56\)/u,
  "clipboard restoration must not race an asynchronous SendInput paste"
);
assert.match(
  composerInputSource,
  /\$existingContent = Get-PublishSelectedContent \$lock[\s\S]*moments_publish_editor_not_empty[\s\S]*\$exactReadback = Get-PublishSelectedContent \$lock \$true[\s\S]*Test-PublishExactContent \(\[string\]\$exactReadback\.value\) \$expectedContent/u,
  "the full selected editor value must be checked before input and exactly rebound after input"
);
const composerPostExactSource = composerInputSource.slice(
  composerInputSource.indexOf("$exactReadback = Get-PublishSelectedContent"),
  composerInputSource.indexOf("function Test-PublishComposerContentFinal")
);
assert.doesNotMatch(
  composerPostExactSource,
  /Get-PublishFullObservation|\.compact|IndexOf\(\$token/u,
  "an exact clipboard readback must not be blocked again by any weaker OCR text decision"
);
assert.match(
  composerInputSource,
  /\$exactReadback = Get-PublishSelectedContent \$lock \$true[\s\S]*Test-PublishExactContent \(\[string\]\$exactReadback\.value\) \$expectedContent[\s\S]*AtomicVirtualKey\(0x27\)[\s\S]*return @\{ ok = \$true; runtimeId = "composer:"/u,
  "successful exact readback must collapse the selection and continue to fresh pre-publish verification"
);
assert.match(
  composerInputSource,
  /function Test-PublishComposerContentFinal[\s\S]*AtomicKeyChord\(0x11, 0x41\)[\s\S]*Get-PublishSelectedContent \$lock \$true[\s\S]*Test-PublishExactContent \(\[string\]\$readback\.value\) \$expectedContent/u,
  "the complete content must be rebound again immediately before the irreversible phase"
);
const exactContentNormalizerSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Normalize-PublishExactContent"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishFileSha256")
);
const exactContentSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Test-PublishExactContent"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishClipboardUnicodeSnapshot")
);
const exactContentHarness = spawnSync("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));Invoke-Expression $source"
], {
  input: Buffer.from(`
${exactContentNormalizerSource}
${exactContentSource}
$cr = [string][char]13; $lf = [string][char]10
$expected = "A📢B🤖C🛠️D♻️E⚠️F👇G" + $lf + $lf + "第二行"
@{
  exact = Test-PublishExactContent ("A📢B🤖C🛠️D♻️E⚠️F👇G" + $cr + $lf + $cr + $lf + "第二行") $expected
  reordered = Test-PublishExactContent ("📢🤖🛠️👇ABCD♻️E⚠️FG" + $lf + $lf + "第二行") $expected
  missingVariationSelector = Test-PublishExactContent ("A📢B🤖C🛠D♻️E⚠️F👇G" + $lf + $lf + "第二行") $expected
  flattened = Test-PublishExactContent "A📢B🤖C🛠️D♻️E⚠️F👇G 第二行" $expected
  suffixed = Test-PublishExactContent ($expected + " extra") $expected
} | ConvertTo-Json -Compress
`, "utf8").toString("base64"),
  encoding: "utf8",
  windowsHide: true
});
assert.equal(exactContentHarness.status, 0, exactContentHarness.stderr || "exact content harness must run");
assert.deepEqual(JSON.parse(exactContentHarness.stdout.trim()), {
  exact: true,
  flattened: false,
  missingVariationSelector: false,
  reordered: false,
  suffixed: false
});
const clipboardWaitSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Wait-PublishClipboardSelection"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishSelectedContent")
);
const clipboardWaitHarness = spawnSync("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));Invoke-Expression $source"
], {
  input: Buffer.from(`
${clipboardWaitSource}
function Normalize-PublishExactContent([string]$value) { return $value }
$script:values = [Collections.Queue]::new()
function Get-PublishClipboardUnicodeSnapshot {
  $value = $(if ($script:values.Count -gt 0) { [string]$script:values.Dequeue() } else { "__probe__" })
  if ($value -ceq "__error__") {
    return @{ ok = $false; reason = "moments_publish_clipboard_readback_failed" }
  }
  return @{ ok = $true; value = $value }
}
$script:values.Enqueue("__probe__"); $script:values.Enqueue("delayed text")
$delayed = Wait-PublishClipboardSelection "__probe__" $true
$script:values.Clear(); $script:values.Enqueue("__probe__")
$requiredTimeout = Wait-PublishClipboardSelection "__probe__" $true
$script:values.Clear(); $script:values.Enqueue("__probe__")
$optionalEmpty = Wait-PublishClipboardSelection "__probe__" $false
$script:values.Clear(); 1..15 | ForEach-Object { $script:values.Enqueue("__error__") }
$optionalErrors = Wait-PublishClipboardSelection "__probe__" $false
@{
  delayedOk = [bool]$delayed.ok
  delayedValue = [string]$delayed.value
  requiredReason = [string]$requiredTimeout.reason
  optionalEmptyOk = [bool]$optionalEmpty.ok
  optionalEmptyValue = [string]$optionalEmpty.value
  optionalErrorsReason = [string]$optionalErrors.reason
} | ConvertTo-Json -Compress
`, "utf8").toString("base64"),
  encoding: "utf8",
  windowsHide: true
});
assert.equal(clipboardWaitHarness.status, 0, clipboardWaitHarness.stderr || "clipboard wait harness must run");
assert.deepEqual(JSON.parse(clipboardWaitHarness.stdout.trim()), {
  delayedOk: true,
  delayedValue: "delayed text",
  optionalEmptyOk: true,
  optionalEmptyValue: "",
  optionalErrorsReason: "moments_publish_clipboard_readback_failed",
  requiredReason: "moments_publish_clipboard_readback_failed"
});
const mediaProcessingIndex = flowSource.indexOf("$processed = Wait-PublishMediaProcessing $lock");
const contentInputIndex = flowSource.indexOf('$script:publishStage = "content_input"', mediaProcessingIndex);
assert.doesNotMatch(
  flowSource.slice(mediaProcessingIndex, contentInputIndex),
  /GetLastInputTick|external_input_detected/u,
  "passive media processing must be decided by media evidence, not unrelated Windows input"
);

const cameraSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Find-PublishVisualCameraTarget"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishFileDialog")
);
assert.match(cameraSource, /\$lock\.scale/u);
assert.match(cameraSource, /\$paneBounds = \$lock\.renderPane\.bounds/u);
assert.match(cameraSource, /\$integrated[\s\S]*32\.0[\s\S]*24\.0[\s\S]*56\.0[\s\S]*24\.0/u);
assert.match(cameraSource, /\$dark -ge 18[\s\S]*\$darkRatio -ge 0\.018[\s\S]*\$darkRatio -le 0\.38/u);
assert.match(cameraSource, /\$light -ge 18[\s\S]*\$lightRatio -ge 0\.018[\s\S]*\$lightRatio -le 0\.38/u);
assert.match(cameraSource, /\$darkOk -eq \$lightOk[\s\S]*moments_publish_camera_not_found/u);
assert.match(cameraSource, /\$sumX[\s\S]*\$sumY[\s\S]*\[Math\]::Round/u);
const findCameraSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Find-PublishCameraTarget"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Test-PublishFileDialogLease")
);
const cameraEvidenceTickIndex = findCameraSource.indexOf("$evidenceInputTick = [Win32WechatMomentsPublish]::GetLastInputTick()");
const cameraUiaDiscoveryIndex = findCameraSource.indexOf("$lock.root.FindAll(");
const cameraVisualDiscoveryIndex = findCameraSource.indexOf("$frame = Get-MomentsVisualFrame");
assert.ok(
  cameraEvidenceTickIndex >= 0
    && cameraUiaDiscoveryIndex > cameraEvidenceTickIndex
    && cameraVisualDiscoveryIndex > cameraEvidenceTickIndex,
  "camera evidence must lease user input before either UIA or visual discovery begins"
);
assert.match(
  findCameraSource,
  /if \(\$uiaMatches\.Count -eq 1\) \{[\s\S]*return @\{ ok = \$true; target = \$uiaMatches\[0\]; inputTick = \[uint32\]\$evidenceInputTick \}/u,
  "the UIA camera success path must return its pre-discovery input lease"
);
assert.match(
  findCameraSource,
  /\$visual = Find-PublishVisualCameraTarget[\s\S]*if \(\$visual\.ok\) \{ \$visual\.inputTick = \[uint32\]\$evidenceInputTick \}[\s\S]*return \$visual/u,
  "the visual camera success path must return its pre-discovery input lease"
);
assert.match(MOMENTS_PUBLISH_POWERSHELL, /\$dpi \/ 96\.0/u);
assert.doesNotMatch(cameraSource, /\.png|push_icon|moment_person_icon/iu);

const visualCameraStart = MOMENTS_PUBLISH_POWERSHELL.indexOf("function Find-PublishVisualCameraTarget");
const visualCameraEnd = MOMENTS_PUBLISH_POWERSHELL.indexOf("function Find-PublishCameraTarget");
const visualCameraSource = MOMENTS_PUBLISH_POWERSHELL.slice(visualCameraStart, visualCameraEnd);
const cameraVisualHarnessProgram = `
$ErrorActionPreference = "Stop"
function Get-MomentsPixel($frame, [int]$x, [int]$y) {
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $frame.width -or $y -ge $frame.height) { return $null }
  $offset = ($y * $frame.stride) + ($x * 4)
  return @{ b = [int]$frame.bytes[$offset]; g = [int]$frame.bytes[$offset + 1]; r = [int]$frame.bytes[$offset + 2] }
}
${visualCameraSource}
function New-CameraFrame([int]$background, [int]$foreground, [bool]$drawCamera, [bool]$standalone) {
  $width = 1100; $height = 100; $stride = $width * 4
  $bytes = New-Object byte[] ($stride * $height)
  for ($offset = 0; $offset -lt $bytes.Length; $offset += 4) {
    $bytes[$offset] = $background; $bytes[$offset + 1] = $background
    $bytes[$offset + 2] = $background; $bytes[$offset + 3] = 255
  }
  if ($drawCamera) {
    $centerX = $(if ($standalone) { 1062 } else { 1052 })
    $centerY = $(if ($standalone) { 30 } else { 70 })
    for ($y = $centerY - 8; $y -le $centerY + 8; $y++) {
      for ($x = $centerX - 10; $x -le $centerX + 10; $x++) {
        $offset = ($y * $stride) + ($x * 4)
        $bytes[$offset] = $foreground; $bytes[$offset + 1] = $foreground; $bytes[$offset + 2] = $foreground
      }
    }
  }
  return @{ width = $width; height = $height; stride = $stride; bytes = $bytes }
}
$pane = @{ left = 9; top = 0; width = 1083; height = 100 }
$integratedLock = @{ rect = @{ Left = 0; Top = 0 }; scale = 1.25; surfaceMode = "integrated" }
$standaloneLock = @{ rect = @{ Left = 0; Top = 0 }; scale = 1.25; surfaceMode = "standalone" }
$darkOnLight = Find-PublishVisualCameraTarget (New-CameraFrame 245 65 $true $false) $integratedLock $pane
$lightOnDark = Find-PublishVisualCameraTarget (New-CameraFrame 55 245 $true $false) $integratedLock $pane
$missing = Find-PublishVisualCameraTarget (New-CameraFrame 245 65 $false $false) $integratedLock $pane
$standalone = Find-PublishVisualCameraTarget (New-CameraFrame 245 65 $true $true) $standaloneLock $pane
@{
  darkOnLight = $darkOnLight
  lightOnDark = $lightOnDark
  missing = $missing
  standalone = $standalone
} | ConvertTo-Json -Compress -Depth 6
`;
const cameraVisualHarness = spawnSync("powershell.exe", [
  "-NoProfile",
  "-STA",
  "-NonInteractive",
  "-Command",
  "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); Invoke-Expression $source"
], {
  input: Buffer.from(cameraVisualHarnessProgram, "utf8").toString("base64"),
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000
});
assert.equal(
  cameraVisualHarness.status,
  0,
  cameraVisualHarness.stderr || cameraVisualHarness.stdout || "camera visual harness must run"
);
const cameraVisualResult = JSON.parse(cameraVisualHarness.stdout.trim());
assert.deepEqual(cameraVisualResult.darkOnLight, {
  target: { y: 70, x: 1052, mode: "wechat_moments_render_pane_camera_glyph_integrated_dark" },
  ok: true
});
assert.deepEqual(cameraVisualResult.lightOnDark, {
  target: { y: 70, x: 1052, mode: "wechat_moments_render_pane_camera_glyph_integrated_light" },
  ok: true
});
assert.deepEqual(cameraVisualResult.standalone, {
  target: { y: 30, x: 1062, mode: "wechat_moments_render_pane_camera_glyph_standalone_dark" },
  ok: true
});
assert.deepEqual(cameraVisualResult.missing, {
  reason: "moments_publish_camera_not_found",
  ok: false
});
const surfaceSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Test-PublishMomentsSurface"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Find-PublishCameraTarget")
);
assert.match(surfaceSource, /\$lock\.surfaceMode -ceq "standalone"/u);
assert.match(surfaceSource, /Test-IntegratedMomentsSurface \$frame \$surfaceScanBounds \(\[double\]\$lock\.scale\)/u);
assert.match(surfaceSource, /integrated_selected_sidebar_ocr_and_green_band/u);
assert.match(surfaceSource, /moments_publish_integrated_surface_not_proven/u);
assert.doesNotMatch(surfaceSource, /integrated_header_ocr/u);
assert.match(flowSource, /Test-PublishMomentsSurface \$lock[\s\S]*Get-PublishFullObservation \$lock/u);

const publishButtonSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Find-PublishButton"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Write-PublishMarker")
);
assert.match(publishButtonSource, /\$compact -cne "发表"/u);
assert.match(publishButtonSource, /\$visualMatches\.Count -gt 1/u);
assert.match(publishButtonSource, /\$visualMatches\.Count -eq 1/u);
assert.match(publishButtonSource, /moments_publish_button_ambiguous/u);
assert.doesNotMatch(
  publishButtonSource,
  /legacyRight/u,
  "the new left-side composer must not be rejected by the obsolete right-half layout gate"
);
const publishObservationSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishVisualButtonCandidates"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Test-PublishMomentsSurface")
);
assert.match(
  publishObservationSource,
  /\[bool\]\$includePublishButtonCandidates = \$false[\s\S]*if \(\$includePublishButtonCandidates -and/u,
  "ordinary media and content observations must not pay for publish-button scanning"
);
assert.match(publishObservationSource, /Get-PublishVisualButtonCandidates \$frame/u);
assert.match(publishObservationSource, /publishButtonVisualCandidates = @\(\$publishButtonVisualCandidates\)/u);
assert.match(publishObservationSource, /Test-MomentsSelectedGreenFramePixel/u);
assert.match(publishObservationSource, /visual_green_action/u);
assert.match(
  publishObservationSource,
  /function Get-PublishButtonObservation[\s\S]*Get-PublishVisualButtonCandidates \$frame[\s\S]*\$publishButtonVisualCandidates\.Count -ne 1[\s\S]*Get-MomentsOcrObservation \$frame \$buttonRegion/u,
  "publish-button discovery must scan the captured pixels first and only pay for scoped OCR when visual proof is not unique"
);
assert.match(
  flowSource,
  /Get-PublishButtonObservation \$lock[\s\S]*Start-Sleep -Milliseconds 1000/u,
  "the button search must use the dedicated observation and allow the current WeChat scroll animation to settle"
);

const publishButtonObservationFunctionSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishButtonObservation"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Test-PublishMomentsSurface")
).replaceAll("[Win32WechatMomentsPublish]::GetLastInputTick()", "Get-TestPublishInputTick");
const publishNormalizeSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Normalize-PublishText"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Normalize-PublishExactContent")
);
const publishButtonObservationHarness = spawnSync("powershell.exe", [
  "-NoProfile",
  "-STA",
  "-NonInteractive",
  "-Command",
  "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));Invoke-Expression $source"
], {
  input: Buffer.from(`
${publishNormalizeSource}
${publishButtonObservationFunctionSource}
$script:ocrCalls = 0
$script:visualCandidates = @(@{
  x = 151
  y = 540
  bounds = @{ left = 81; top = 521; width = 140; height = 38 }
  mode = "visual_green_action"
  greenRatio = 0.957
})
function Get-TestPublishInputTick { return [uint32]123 }
function Get-MomentsVisualFrame { return @{ ok = $true; width = 453; height = 601 } }
function Close-MomentsVisualFrame { param($frame) }
function Get-PublishVisualButtonCandidates { param($frame); return @($script:visualCandidates) }
function Get-MomentsOcrObservation {
  param($frame, $rect)
  $script:ocrCalls += 1
  return @{
    ok = $true
    lines = @(@{ text = "发表"; compact = "发表"; bounds = @{ left = 134; top = 52; width = 35; height = 17 } })
  }
}
$lock = @{ hWnd = 1; rect = @{}; pid = 1 }
$visual = Get-PublishButtonObservation $lock
$visualOcrCalls = $script:ocrCalls
$script:visualCandidates = @()
$scoped = Get-PublishButtonObservation $lock
$scopedSample = Get-PublishButtonSearchSample $scoped "settle" 2
@{
  visualCount = [int]$visual.searchEvidence.visualCount
  visualOcrMode = [string]$visual.searchEvidence.ocrMode
  visualOcrCalls = $visualOcrCalls
  scopedOcrCalls = $script:ocrCalls
  scopedExactCount = [int]$scoped.searchEvidence.ocrExactCount
  scopedLineTop = [int]$scoped.ocr.lines[0].bounds.top
  samplePhase = [string]$scopedSample.phase
  sampleAttempt = [int]$scopedSample.attempt
} | ConvertTo-Json -Compress
`, "utf8").toString("base64"),
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000
});
assert.equal(
  publishButtonObservationHarness.status,
  0,
  publishButtonObservationHarness.stderr || publishButtonObservationHarness.stdout || "publish button observation harness must run"
);
assert.deepEqual(JSON.parse(publishButtonObservationHarness.stdout.trim()), {
  sampleAttempt: 2,
  samplePhase: "settle",
  scopedExactCount: 1,
  scopedLineTop: 532,
  scopedOcrCalls: 1,
  visualCount: 1,
  visualOcrCalls: 0,
  visualOcrMode: "skipped_visual_unique"
});

const publishVisualHelperSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishVisualButtonCandidates"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishFullObservation")
);
const publishVisualHarness = spawnSync("powershell.exe", [
  "-NoProfile",
  "-STA",
  "-NonInteractive",
  "-Command",
  "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));Invoke-Expression $source"
], {
  input: Buffer.from(`
${MOMENTS_VISUAL_READONLY_POWERSHELL}
${MOMENTS_INTEGRATED_SURFACE_EVIDENCE_POWERSHELL}
${publishVisualHelperSource}
function New-PublishButtonTestFrame([int]$width, [int]$height) {
  return @{
    ok = $true
    width = $width
    height = $height
    stride = $width * 4
    bytes = New-Object byte[] ($width * $height * 4)
  }
}
function Add-PublishButtonTestRect($frame, [int]$left, [int]$top, [int]$width, [int]$height) {
  for ($y = $top; $y -lt ($top + $height); $y++) {
    for ($x = $left; $x -lt ($left + $width); $x++) {
      $offset = ($y * $frame.stride) + ($x * 4)
      $frame.bytes[$offset] = 96
      $frame.bytes[$offset + 1] = 193
      $frame.bytes[$offset + 2] = 7
      $frame.bytes[$offset + 3] = 255
    }
  }
}
$singleFrame = New-PublishButtonTestFrame 453 601
Add-PublishButtonTestRect $singleFrame 81 521 140 38
$doubleFrame = New-PublishButtonTestFrame 453 601
Add-PublishButtonTestRect $doubleFrame 81 521 140 38
Add-PublishButtonTestRect $doubleFrame 250 521 140 38
$tinyFrame = New-PublishButtonTestFrame 453 601
Add-PublishButtonTestRect $tinyFrame 81 521 12 12
$upperFrame = New-PublishButtonTestFrame 453 601
Add-PublishButtonTestRect $upperFrame 81 220 140 38
$middleLowerFrame = New-PublishButtonTestFrame 453 601
Add-PublishButtonTestRect $middleLowerFrame 81 430 140 38
$lastScrollFrame = New-PublishButtonTestFrame 453 652
Add-PublishButtonTestRect $lastScrollFrame 82 625 140 27
@{
  single = @(Get-PublishVisualButtonCandidates $singleFrame)
  double = @(Get-PublishVisualButtonCandidates $doubleFrame)
  tiny = @(Get-PublishVisualButtonCandidates $tinyFrame)
  upper = @(Get-PublishVisualButtonCandidates $upperFrame)
  middleLower = @(Get-PublishVisualButtonCandidates $middleLowerFrame)
  lastScroll = @(Get-PublishVisualButtonCandidates $lastScrollFrame)
} | ConvertTo-Json -Compress -Depth 8
`, "utf8").toString("base64"),
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000
});
assert.equal(
  publishVisualHarness.status,
  0,
  publishVisualHarness.stderr || publishVisualHarness.stdout || "publish visual button harness must run"
);
const publishVisualResult = JSON.parse(publishVisualHarness.stdout.trim());
assert.equal(publishVisualResult.single.length, 1);
assert.equal(publishVisualResult.single[0].mode, "visual_green_action");
assert.ok(Math.abs(publishVisualResult.single[0].x - 151) <= 3);
assert.ok(Math.abs(publishVisualResult.single[0].y - 540) <= 3);
assert.equal(publishVisualResult.double.length, 2);
assert.deepEqual(publishVisualResult.tiny, []);
assert.deepEqual(publishVisualResult.upper, []);
assert.deepEqual(publishVisualResult.middleLower, []);
assert.equal(publishVisualResult.lastScroll.length, 1);
assert.equal(publishVisualResult.lastScroll[0].mode, "visual_green_action");
assert.ok(Math.abs(publishVisualResult.lastScroll[0].x - 152) <= 3);
assert.ok(Math.abs(publishVisualResult.lastScroll[0].y - 639) <= 3);

const normalizePublishTextSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Normalize-PublishText"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Normalize-PublishExactContent")
);
const publishButtonHarness = spawnSync("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));Invoke-Expression $source"
], {
  input: Buffer.from(`
${normalizePublishTextSource}
${publishButtonSource}
$visual = @{
  x = 151
  y = 540
  bounds = @{ left = 81; top = 521; width = 140; height = 38 }
  mode = "visual_green_action"
}
$otherVisual = @{
  x = 320
  y = 540
  bounds = @{ left = 250; top = 521; width = 140; height = 38 }
  mode = "visual_green_action"
}
$noOcr = @{ width = 453; height = 601; ocr = @{ lines = @() }; publishButtonVisualCandidates = @($visual) }
$doubleVisual = @{ width = 453; height = 601; ocr = @{ lines = @() }; publishButtonVisualCandidates = @($visual, $otherVisual) }
$matchingOcr = @{
  width = 453
  height = 601
  ocr = @{ lines = @(@{ compact = "发表"; bounds = @{ left = 134; top = 532; width = 35; height = 17 } }) }
  publishButtonVisualCandidates = @($visual)
}
$conflictingOcr = @{
  width = 453
  height = 601
  ocr = @{ lines = @(@{ compact = "发表"; bounds = @{ left = 284; top = 532; width = 35; height = 17 } }) }
  publishButtonVisualCandidates = @($visual)
}
$leftOcrOnly = @{
  width = 453
  height = 601
  ocr = @{ lines = @(@{ compact = "发表"; bounds = @{ left = 134; top = 532; width = 35; height = 17 } }) }
  publishButtonVisualCandidates = @()
}
$legacyOcrOnly = @{
  width = 453
  height = 601
  ocr = @{ lines = @(@{ compact = "发表"; bounds = @{ left = 300; top = 532; width = 35; height = 17 } }) }
  publishButtonVisualCandidates = @()
}
$tooHighOcrOnly = @{
  width = 453
  height = 601
  ocr = @{ lines = @(@{ compact = "鍙戣〃"; bounds = @{ left = 134; top = 200; width = 35; height = 17 } }) }
  publishButtonVisualCandidates = @()
}
@{
  noOcr = Find-PublishButton $noOcr
  doubleVisual = Find-PublishButton $doubleVisual
  matchingOcr = Find-PublishButton $matchingOcr
  conflictingOcr = Find-PublishButton $conflictingOcr
  leftOcrOnly = Find-PublishButton $leftOcrOnly
  legacyOcrOnly = Find-PublishButton $legacyOcrOnly
  tooHighOcrOnly = Find-PublishButton $tooHighOcrOnly
} | ConvertTo-Json -Compress -Depth 8
`, "utf8").toString("base64"),
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000
});
assert.equal(
  publishButtonHarness.status,
  0,
  publishButtonHarness.stderr || publishButtonHarness.stdout || "publish button resolver harness must run"
);
const publishButtonResult = JSON.parse(publishButtonHarness.stdout.trim());
assert.equal(publishButtonResult.noOcr.ok, true);
assert.equal(publishButtonResult.noOcr.target.mode, "visual_green_action");
assert.equal(publishButtonResult.matchingOcr.ok, true);
assert.equal(publishButtonResult.matchingOcr.target.mode, "visual_green_action");
assert.equal(publishButtonResult.doubleVisual.reason, "moments_publish_button_ambiguous");
assert.equal(publishButtonResult.conflictingOcr.reason, "moments_publish_button_ambiguous");
assert.equal(publishButtonResult.leftOcrOnly.ok, true);
assert.equal(publishButtonResult.leftOcrOnly.target.mode, "ocr_exact_label");
assert.equal(publishButtonResult.legacyOcrOnly.ok, true);
assert.equal(publishButtonResult.tooHighOcrOnly.reason, "moments_publish_button_not_found");
const baselineIndex = flowSource.indexOf('reason = "moments_publish_verification_token_not_unique"');
const cameraClickIndex = flowSource.indexOf("$cameraClick = Invoke-PublishOwnedClick");
assert.ok(baselineIndex >= 0 && cameraClickIndex > baselineIndex,
  "the verification token must be unique before opening the composer");
assert.match(
  flowSource,
  /\[uint32\]\$cameraInputTick = \[uint32\]\$camera\.inputTick[\s\S]*Invoke-PublishOwnedClick \$camera\.target\.x \$camera\.target\.y \$lock \$false \$cameraInputTick/u,
  "the reversible camera click must use the lease from the camera evidence, not a new baseline captured afterward"
);
const cameraDiscoveryIndex = flowSource.indexOf("$camera = Find-PublishCameraTarget $lock");
assert.doesNotMatch(
  flowSource.slice(cameraDiscoveryIndex, cameraClickIndex),
  /GetLastInputTick/u,
  "the camera click must not replace its pre-discovery lease with a newer input baseline"
);
assert.doesNotMatch(
  flowSource,
  /Get-PublishFileDialog \$lock \$\w*InputTick|Set-PublishDialogFiles \$fileDialog \$mediaPaths \$\w*InputTick|Test-PublishFileDialogLease \$fileDialog \$\w*InputTick/u,
  "camera input state must not leak into file-dialog discovery, selection, or close waiting"
);
assert.doesNotMatch(
  flowSource,
  /GetLastInputTick\(\) -ne \$expectedInputTick/u,
  "passive waits, media proof, editor readback, and scroll discovery must not share a workflow-wide input lease"
);
assert.match(flowSource, /\$focusedTarget = Set-PublishComposerContent \$lock \$expectedContent \$token/u);
assert.doesNotMatch(
  flowSource,
  /\$mediaEvidenceAfterContent|\$finalMediaEvidence|Test-PublishComposerMediaEvidence \$lock \$manifestProof \(\[string\]\$mediaEvidence\.evidenceKey\)/u,
  "button visibility must not masquerade as a second media proof or block the later bounded button search"
);
assert.match(
  flowSource,
  /GetForegroundWindow\(\) -ne \$lock\.hWnd[\s\S]*Test-PublishOwnedPoint \$wheelX \$wheelY \$lock[\s\S]*AtomicMouseWheel\(-600\)/u,
  "each reversible scroll must retain exact foreground-window and owned-point proof"
);
const publishButtonSearchSource = flowSource.slice(
  flowSource.indexOf('$script:publishStage = "prepublish_verification"'),
  flowSource.indexOf("$finalManifestProof = Test-PublishMediaManifest", flowSource.indexOf('$script:publishStage = "prepublish_verification"'))
);
const contentWriteIndex = flowSource.indexOf("$focusedTarget = Set-PublishComposerContent $lock $expectedContent $token");
const firstButtonCaptureIndex = flowSource.indexOf("$observation = Get-PublishButtonObservation $lock", contentWriteIndex);
const postContentLockRefreshIndex = flowSource.indexOf("$lock = Get-PublishComposerWindowLock $context $mainLock", contentWriteIndex);
assert.ok(
  postContentLockRefreshIndex > contentWriteIndex && postContentLockRefreshIndex < firstButtonCaptureIndex,
  "the composer lock must be refreshed after content input can resize the WeChat composer and before any button frame is captured"
);
assert.match(
  publishButtonSearchSource,
  /for \(\$observationAttempt[\s\S]*\$lock = Get-PublishComposerWindowLock \$context \$mainLock[\s\S]*if \(-not \$lock\.ok\)[\s\S]*Get-PublishButtonObservation \$lock/u,
  "every scroll observation must capture the current composer geometry instead of reusing a stale rect"
);
assert.match(
  publishButtonSearchSource,
  /for \(\$settleAttempt[\s\S]*\$lock = Get-PublishComposerWindowLock \$context \$mainLock[\s\S]*if \(-not \$lock\.ok\)[\s\S]*Get-PublishButtonObservation \$lock/u,
  "every settle observation must capture the current composer geometry instead of reusing a stale rect"
);
assert.match(
  publishButtonSearchSource,
  /\$maximumPublishButtonScrolls = 12[\s\S]*for \(\$observationAttempt = 0; \$observationAttempt -le \$maximumPublishButtonScrolls; \$observationAttempt\+\+\)[\s\S]*Find-PublishButton \$observation[\s\S]*if \(\$observationAttempt -eq \$maximumPublishButtonScrolls\) \{ break \}[\s\S]*AtomicMouseWheel\(-600\)/u,
  "the final reversible scroll must be followed by one last passive button observation"
);
assert.match(
  flowSource,
  /\$observation = Get-PublishButtonObservation \$lock[\s\S]*\$freshObservation = Get-PublishButtonObservation \$lock[\s\S]*\$postMarkerObservation = Get-PublishButtonObservation \$lock/u,
  "the bounded search, fresh pre-click check, and post-marker rebound must all use the dedicated button observation"
);

const markerSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Write-PublishMarker"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishPostCandidateKey")
);
const buttonReboundSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Test-PublishButtonRebound"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Write-PublishMarker")
);
assert.match(buttonReboundSource, /\$expectedContainsCurrent[\s\S]*\$currentContainsExpected[\s\S]*return \$expectedContainsCurrent -and \$currentContainsExpected/u);
const buttonReboundHarness = spawnSync("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));Invoke-Expression $source"
], {
  input: Buffer.from(`
${buttonReboundSource}
$expected = @{ x = 100; y = 50; bounds = @{ left = 80; top = 40; width = 40; height = 20 } }
$stable = @{ x = 100; y = 50; bounds = @{ left = 80; top = 40; width = 40; height = 20 } }
$jittered = @{ x = 102; y = 51; bounds = @{ left = 82; top = 41; width = 40; height = 20 } }
$other = @{ x = 180; y = 90; bounds = @{ left = 160; top = 80; width = 40; height = 20 } }
@{
  stable = Test-PublishButtonRebound $expected $stable
  jittered = Test-PublishButtonRebound $expected $jittered
  other = Test-PublishButtonRebound $expected $other
} | ConvertTo-Json -Compress
`, "utf8").toString("base64"),
  encoding: "utf8",
  windowsHide: true
});
assert.equal(buttonReboundHarness.status, 0, buttonReboundHarness.stderr || "button rebound harness must run");
assert.deepEqual(JSON.parse(buttonReboundHarness.stdout.trim()), {
  jittered: true,
  other: false,
  stable: true
});
assert.match(markerSource, /\$expectedName = \$fingerprint \+ "\." \+ \$attemptId \+ "\.json"/u);
assert.match(markerSource, /FileOptions\]::WriteThrough/u);
assert.match(markerSource, /\$stream\.Flush\(\$true\)[\s\S]*\[IO\.File\]::Move\(\$temporaryPath, \$markerPath\)[\s\S]*return \[IO\.File\]::Exists\(\$markerPath\)/u);
assert.doesNotMatch(
  markerSource,
  /Remove-PublishMarkerBeforeAction|\[IO\.File\]::Delete\(\$markerPath\)/u,
  "a durable marker must never be auto-deleted after an uncertain final-click preparation"
);
const ownedClickSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Invoke-PublishOwnedClick"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishFullObservation")
);
assert.match(
  ownedClickSource,
  /AtomicMouseClick\(\$screenX, \$screenY\)[\s\S]*\[uint32\]\$inputTick = \[Win32WechatMomentsPublish\]::GetLastInputTick\(\)[\s\S]*return @\{ ok = \$true; inputTick = \$inputTick \}/u,
  "an owned click must return the resulting LastInputTick to the next phase"
);
assert.match(
  ownedClickSource,
  /\$postMarkerValidation = & \$afterMarkerValidation[\s\S]*\$expectedInputTick = \[uint32\]\$postMarkerValidation\.inputTick/u,
  "the irreversible click must rebase only from a successful post-marker button observation"
);
const markerCallbackIndex = ownedClickSource.indexOf("& $beforeIrreversibleClick");
const markerForegroundIndex = ownedClickSource.indexOf(
  "[Win32WechatMomentsPublish]::GetForegroundWindow() -ne $lock.hWnd",
  markerCallbackIndex
);
const markerOwnedPointIndex = ownedClickSource.indexOf(
  "-not (Test-PublishOwnedPoint $screenX $screenY $lock)",
  markerForegroundIndex
);
const markerInputTickIndex = ownedClickSource.indexOf(
  "[Win32WechatMomentsPublish]::GetLastInputTick() -ne $expectedInputTick",
  markerOwnedPointIndex
);
const markerButtonValidationIndex = ownedClickSource.indexOf("& $afterMarkerValidation", markerInputTickIndex);
const finalForegroundIndex = ownedClickSource.indexOf(
  "[Win32WechatMomentsPublish]::GetForegroundWindow() -ne $lock.hWnd",
  markerButtonValidationIndex
);
const finalOwnedPointIndex = ownedClickSource.indexOf(
  "-not (Test-PublishOwnedPoint $screenX $screenY $lock)",
  finalForegroundIndex
);
const finalInputTickIndex = ownedClickSource.indexOf(
  "[Win32WechatMomentsPublish]::GetLastInputTick() -ne $expectedInputTick",
  finalOwnedPointIndex
);
const actionAttemptedIndex = ownedClickSource.indexOf("$script:publishActionAttempted = $true");
const atomicClickIndex = ownedClickSource.indexOf("AtomicMouseClick($screenX, $screenY)");
assert.ok(
  markerCallbackIndex >= 0
    && markerForegroundIndex > markerCallbackIndex
    && markerOwnedPointIndex > markerForegroundIndex
    && markerInputTickIndex > markerOwnedPointIndex
    && markerButtonValidationIndex > markerInputTickIndex
    && finalForegroundIndex > markerButtonValidationIndex
    && finalOwnedPointIndex > finalForegroundIndex
    && finalInputTickIndex > finalOwnedPointIndex
    && actionAttemptedIndex > finalInputTickIndex
    && atomicClickIndex > actionAttemptedIndex,
  "after the durable marker, foreground, owned point, input tick, and button identity must be revalidated before actionAttempted and click"
);
const markerWriteIndex = flowSource.indexOf("Write-PublishMarker $context", publishClickIndex);
const postMarkerObservationIndex = flowSource.indexOf("$postMarkerObservation = Get-PublishButtonObservation $lock", markerWriteIndex);
const postMarkerButtonIndex = flowSource.indexOf("$postMarkerButton = Find-PublishButton $postMarkerObservation", postMarkerObservationIndex);
const postMarkerCoordinateIndex = flowSource.indexOf("Test-PublishButtonRebound $freshButton.target $postMarkerButton.target", postMarkerButtonIndex);
const publishClickLeaseIndex = flowSource.indexOf("$publishClickInputTick = [uint32]$freshObservation.inputTick", publishClickIndex - 1000);
assert.ok(
  publishClickLeaseIndex >= 0
    && markerWriteIndex > publishClickIndex
    && postMarkerObservationIndex > markerWriteIndex
    && postMarkerButtonIndex > postMarkerObservationIndex
    && postMarkerCoordinateIndex > postMarkerButtonIndex,
  "the post-marker callback must observe the publish button again and prove the original click point still belongs to the same semantic button"
);
assert.match(
  flowSource,
  /if \(-not \$publishClick\.ok\) \{[\s\S]*\$clickOutcomeUnknown = \$script:publishActionAttempted -or[\s\S]*\[IO\.File\]::Exists\(\[string\]\$context\.markerPath\)[\s\S]*status = \$\(if \(\$clickOutcomeUnknown\) \{ "outcome_unknown" \} else \{ "blocked" \}\)/u,
  "any failed final-click preparation with a durable marker must remain outcome_unknown for manual resolution"
);

const fullObservationSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishFullObservation"),
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Find-PublishCameraTarget")
);
assert.match(
  fullObservationSource,
  /\[bool\]\$includePosts = \$false[\s\S]*\[uint32\]\$evidenceInputTick = \[Win32WechatMomentsPublish\]::GetLastInputTick\(\)[\s\S]*Test-IntegratedMomentsSurface \$frame \$surfaceScanBounds[\s\S]*Get-MomentsVisualViewportBounds \$relativePaneBounds \$surfaceProof[\s\S]*Get-MomentsVisualPostCandidates \$frame \$visualViewport\.bounds[\s\S]*viewportCompact = \$viewportCompact[\s\S]*viewportHash = \$viewportHash[\s\S]*posts = \$posts[\s\S]*inputTick = \[uint32\]\$evidenceInputTick/u
);
const verificationSource = MOMENTS_PUBLISH_POWERSHELL.slice(
  MOMENTS_PUBLISH_POWERSHELL.indexOf("function Get-PublishPostCandidateKey"),
  flowStart
);
assert.match(verificationSource, /\$observation\.pixelHash -ceq \$baselineHash/u);
assert.match(
  verificationSource,
  /\$preclickMediaEvidence[\s\S]*@\("uia_one_to_one", "visual_presence_only"\) -notcontains \$preclickMediaProofMode[\s\S]*visual_presence_only[\s\S]*evidenceKey -notmatch "\^\[a-f0-9\]\{64\}\$"[\s\S]*moments_publish_post_media_not_proven/u,
  "the independent composer may use a concrete visual media receipt, but an absent or malformed receipt must remain unverified"
);
assert.match(verificationSource, /\$post\.bounds\.left[\s\S]*\$post\.menuBounds\.top[\s\S]*\$avatarHash \+ "\|" \+ \$identity \+ "\|" \+ \$geometry/u,
  "the candidate key must bind identity, avatar and stable on-screen geometry");
assert.match(verificationSource, /Test-PublishComposerAbsent \$lock \$editorRuntimeId/u);
assert.doesNotMatch(verificationSource, /if \(\[bool\]\$post\.partialVisible\) \{ continue \}/u,
  "visible content and a fresh footer can verify a tall post without its full card");
assert.match(
  verificationSource,
  /\$identityCompact = Normalize-PublishText \(\[string\]\$post\.identityText\)[\s\S]*\$identityCompact\.IndexOf\(\$expectedVisibleAnchor, \[StringComparison\]::Ordinal\) -lt 0/u,
  "post verification must use the pre-existing-checked visible content anchor so folded long posts remain verifiable"
);
assert.match(verificationSource, /\$post\.ocrLines[\s\S]*刚刚\|1分钟前/u);
assert.match(
  verificationSource,
  /\$matching\.Count -eq 0 -and \$preclickMediaProofMode -ceq "visual_presence_only"[\s\S]*\$observation\.viewportCompact[\s\S]*IndexOf\(\$expectedVisibleAnchor[\s\S]*LastIndexOf\(\$expectedVisibleAnchor[\s\S]*\$observation\.viewportHash[\s\S]*unique_visible_anchor_receipt/u,
  "the independent composer fallback must bind one unique anchor inside the owned feed viewport and a concrete visual receipt"
);
assert.doesNotMatch(
  verificationSource,
  /Get-PublishBoundMediaEvidence \$lock \$manifestProof \$absolutePostBounds|Test-PublishPostMediaEvidence/u,
  "post-publish verification must not require private staged filenames that WeChat no longer exposes"
);
assert.match(verificationSource, /\$manifestProof\.ok[\s\S]*\$manifestProof\.count -lt 1[\s\S]*\$post\.regionHash -notmatch "\^\[a-f0-9\]\{64\}\$"/u,
  "post verification must retain the final pre-click manifest proof and a concrete visual post candidate");
assert.match(verificationSource, /\$matching\.Count -ne 1/u);
assert.doesNotMatch(verificationSource, /\$observation\.compact -notlike|\$observation\.ocr\.lines \| Where-Object/u,
  "whole-window token and unrelated just-now text must never verify a post");
assert.match(flowSource, /Get-PublishFullObservation \$currentLock \$true \$true/u);
assert.match(
  flowSource,
  /\$finalManifestProof = Test-PublishMediaManifest \$context[\s\S]*\$finalContentProof = Test-PublishComposerContentFinal[\s\S]*Invoke-PublishOwnedClick[\s\S]*Test-PublishVerified[\s\S]*\$token[\s\S]*\$finalManifestProof[\s\S]*\$mediaEvidence/u,
  "exact content and media must be proven before the click and rebound to one fresh post afterwards"
);
assert.doesNotMatch(flowSource, /Test-PublishClientAccepted \$after/u,
  "composer closure and a feed repaint alone must never become a terminal publish receipt");
assert.match(flowSource, /status = "outcome_unknown"[\s\S]*reason = "moments_publish_outcome_unknown"/u);

const publishVerificationHarness = spawnSync("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));Invoke-Expression $source"
], {
  input: Buffer.from(`${normalizePublishTextSource}\n${verificationSource}\n${fullObservationSource.slice(0, fullObservationSource.indexOf("function Get-PublishButtonObservation"))}\n
Add-Type 'public class Win32WechatMomentsPublish { public static uint GetLastInputTick() { return 1; } } namespace Windows.Media.Ocr { public class OcrEngine { public static uint MaxImageDimension = 2600; } }'
function Get-MomentsVisualFrame { return @{ ok = $true; width = 1000; height = 800 } }
function Close-MomentsVisualFrame { }
function Get-MomentsVisualViewportBounds { return @{ ok = $true; bounds = @{ left = 300; top = 80; width = 700; height = 700 } } }
function Get-MomentsVisualPostCandidates { return @{ posts = @() } }
function Get-MomentsPixelHash { return ("b" * 64) }
function Get-MomentsOcrObservation($frame, $rect) {
  return @{ ok = $true; text = $(if ($rect.left -eq 300 -and $script:cropMatches) { $anchor } else { "无法识别的正文" }); lines = @() }
}
function Get-MomentsScaledOcrObservation { return @{ ok = $true; text = $anchor + $anchor } }
function Test-PublishComposerAbsent($lock, [string]$runtimeId) { return [bool]$script:composerAbsent }
function Test-PublishMomentsSurface($lock) { return @{ ok = [bool]$script:surfaceVisible; reason = "moments_publish_integrated_surface_not_proven" } }
$anchor = "上海清洁机器人运维AI短视频实训营"
$manifest = @{ ok = $true; count = 1; kind = "image" }
$media = @{ proofMode = "visual_presence_only"; evidenceKey = ("d" * 64) }
$base = @{ ok = $true; pixelHash = ("b" * 64); viewportCompact = "前缀" + $anchor + "后缀"; viewportHash = ("c" * 64); posts = @() }
$script:composerAbsent = $true
$script:surfaceVisible = $true
$fragmentAnchor = "功能测试朋友圈发布与互动验证时间2026年9月9"
$fragmentViews = @("功能氵则试:朋友湖发布与互动验证。时间:2026年9月9日巧时", "功自刂试:朋友圈发布与互动马正。时间:2026年9月9日15时", "功能测试:朋友圈发布与互动马止。时间:2026年9月9日15时")
$fragmentMatch = Test-PublishAnchorFragments $fragmentViews $fragmentAnchor
$missingFragment = Test-PublishAnchorFragments @($fragmentViews[0], $fragmentViews[1]) $fragmentAnchor
$outOfOrder = Test-PublishAnchorFragments @("2026年9月9布与互动验证时间功能测试朋友圈发") $fragmentAnchor
$fusedPost = @{ identityText=$fragmentViews[0]; avatarHash=("e"*64); regionHash=("f"*64); publishAnchorMatched=$fragmentMatch; bounds=@{left=100;top=100;width=600;height=500}; menuBounds=@{left=650;top=490;width=36;height=24}; ocrLines=@(@{compact="1分钟前酉";bounds=@{top=400;height=16}}) }
$fusedObservation = @{ok=$true;pixelHash=("b"*64);posts=@($fusedPost)}
$fusedReceipt = Test-PublishVerified $fusedObservation @{} "editor" $fragmentAnchor $manifest $media ("a"*64)
$fusedPost.ocrLines = @(@{compact="1分钟前";bounds=@{top=100;height=16}})
$bodyTimeReceipt = Test-PublishVerified $fusedObservation @{} "editor" $fragmentAnchor $manifest $media ("a"*64)
$script:cropMatches = $true
$feedLock = @{ rect = @{ Left = 0; Top = 0 }; renderPane = @{ bounds = @{ left = 0; top = 0; width = 1000; height = 800 } }; surfaceMode = "standalone" }
$cropped = Get-PublishFullObservation $feedLock $true $true $false $anchor
$croppedVerified = Test-PublishVerified $cropped @{} "editor" $anchor $manifest $media ("a" * 64)
$script:cropMatches = $false
$scaledDuplicate = Get-PublishFullObservation $feedLock $true $true $false $anchor
$scaledDuplicateVerified = Test-PublishVerified $scaledDuplicate @{} "editor" $anchor $manifest $media ("a" * 64)
$receipt = @{ ok = $true; pixelHash = ("b" * 64); ocr = @{ text = "朋友圈内容" } }
$accepted = Test-PublishClientAccepted $receipt @{} "editor" ("a" * 64)
$clientError = Test-PublishClientAccepted (@{ ok = $true; pixelHash = ("b" * 64); ocr = @{ text = "发布失败 请重试" } }) @{} "editor" ("a" * 64)
$receiptUnchanged = Test-PublishClientAccepted $receipt @{} "editor" ("b" * 64)
$script:composerAbsent = $false
$receiptComposerPresent = Test-PublishClientAccepted $receipt @{} "editor" ("a" * 64)
$script:composerAbsent = $true
$script:surfaceVisible = $false
$receiptWrongSurface = Test-PublishClientAccepted $receipt @{} "editor" ("a" * 64)
$script:surfaceVisible = $true
$positive = Test-PublishVerified $base @{} "editor" $anchor $manifest $media ("a" * 64)
$duplicate = Test-PublishVerified (@{ ok = $true; pixelHash = ("b" * 64); viewportCompact = $anchor + $anchor; viewportHash = ("c" * 64); posts = @() }) @{} "editor" $anchor $manifest $media ("a" * 64)
$unchanged = Test-PublishVerified $base @{} "editor" $anchor $manifest $media ("b" * 64)
$missingMedia = Test-PublishVerified $base @{} "editor" $anchor $manifest @{ proofMode = "visual_presence_only"; evidenceKey = "" } ("a" * 64)
$script:composerAbsent = $false
$composerPresent = Test-PublishVerified $base @{} "editor" $anchor $manifest $media ("a" * 64)
$script:composerAbsent = $true
$uiaWithoutPost = Test-PublishVerified $base @{} "editor" $anchor $manifest @{ proofMode = "uia_one_to_one" } ("a" * 64)
@{ fragmentMatch=$fragmentMatch;missingFragment=$missingFragment;outOfOrder=$outOfOrder;fusedReceipt=$fusedReceipt;bodyTimeReceipt=$bodyTimeReceipt;croppedVerified = $croppedVerified; scaledDuplicateVerified = $scaledDuplicateVerified; accepted = $accepted; clientError = $clientError; receiptUnchanged = $receiptUnchanged; receiptComposerPresent = $receiptComposerPresent; receiptWrongSurface = $receiptWrongSurface; positive = $positive; duplicate = $duplicate; unchanged = $unchanged; missingMedia = $missingMedia; composerPresent = $composerPresent; uiaWithoutPost = $uiaWithoutPost } | ConvertTo-Json -Compress -Depth 8
`, "utf8").toString("base64"),
  encoding: "utf8",
  timeout: 15_000
});
assert.equal(publishVerificationHarness.status, 0, publishVerificationHarness.stderr || publishVerificationHarness.stdout);
const publishVerificationResult = JSON.parse(publishVerificationHarness.stdout.trim());
assert.equal(publishVerificationResult.fragmentMatch, true);
assert.equal(publishVerificationResult.missingFragment, false);
assert.equal(publishVerificationResult.outOfOrder, false);
assert.equal(publishVerificationResult.fusedReceipt.verificationMode, "unique_fresh_post_multi_ocr_fragments");
assert.equal(publishVerificationResult.bodyTimeReceipt.ok, false, "time written in the body is not a fresh footer");
assert.equal(publishVerificationResult.croppedVerified.ok, true, "feed-only OCR recovers an exact anchor missed by whole-window OCR");
assert.equal(publishVerificationResult.scaledDuplicateVerified.ok, false, "scaled OCR must still reject duplicate anchors");
assert.equal(publishVerificationResult.accepted.ok, true);
assert.equal(publishVerificationResult.accepted.verificationMode, "client_accepted_composer_closed_feed_changed");
assert.equal(publishVerificationResult.clientError.reason, "moments_publish_client_rejected");
assert.equal(publishVerificationResult.receiptUnchanged.reason, "moments_publish_feed_unchanged");
assert.equal(publishVerificationResult.receiptComposerPresent.reason, "moments_publish_composer_still_present");
assert.equal(publishVerificationResult.receiptWrongSurface.reason, "moments_publish_integrated_surface_not_proven");
assert.equal(publishVerificationResult.positive.ok, true);
assert.equal(publishVerificationResult.positive.verificationMode, "unique_visible_anchor_receipt");
assert.equal(publishVerificationResult.duplicate.ok, false);
assert.equal(publishVerificationResult.duplicate.reason, "moments_publish_post_not_found");
assert.equal(publishVerificationResult.unchanged.reason, "moments_publish_feed_unchanged");
assert.equal(publishVerificationResult.missingMedia.reason, "moments_publish_post_media_not_proven");
assert.equal(publishVerificationResult.composerPresent.reason, "moments_publish_composer_still_present");
assert.equal(publishVerificationResult.uiaWithoutPost.reason, "moments_publish_post_not_found");
const postPublishVerificationSource = flowSource.slice(
  flowSource.indexOf('$script:publishStage = "postpublish_verification"')
);
assert.match(
  postPublishVerificationSource,
  /\$verificationTimeoutMs = 12000[\s\S]*\$verificationIntervalMs = 500[\s\S]*\[Diagnostics\.Stopwatch\]::StartNew\(\)[\s\S]*while \(\$verificationStopwatch\.ElapsedMilliseconds -lt \$verificationTimeoutMs\)[\s\S]*Test-PublishVerified/u,
  "fresh-post readback must poll exact evidence for a bounded cross-device window"
);
assert.match(
  postPublishVerificationSource,
  /verificationAttempts = \[int\]\$verificationAttempts[\s\S]*verificationElapsedMs = \[int\]\$verificationStopwatch\.ElapsedMilliseconds[\s\S]*lastVerificationReason = \[string\]\$lastVerificationReason/u,
  "exact readback must return attempts, elapsed time and the last failed verification reason"
);
assert.doesNotMatch(
  postPublishVerificationSource,
  /Test-PublishClientAccepted|Invoke-PublishOwnedClick|AtomicMouseClick|SendInput/u,
  "post-publish polling must never weaken the receipt or perform a second publish action"
);

const fingerprint = "a".repeat(64);
const attemptId = "12345678-1234-4abc-8def-1234567890ab";
const validMarker = path.resolve("runtime", "moments", PUBLISH_MARKER_DIRECTORY, `${fingerprint}.${attemptId}.json`);
assert.equal(validMarkerPath(validMarker, fingerprint, attemptId), true);
assert.equal(validMarkerPath(path.resolve("runtime", "moments", PUBLISH_MARKER_DIRECTORY, `${attemptId}.json`), fingerprint, attemptId), false);
assert.equal(validMarkerPath(path.resolve("runtime", "moments", "other", `${fingerprint}.${attemptId}.json`), fingerprint, attemptId), false);
assert.equal(validMarkerPath(`${PUBLISH_MARKER_DIRECTORY}/${fingerprint}.${attemptId}.json`, fingerprint, attemptId), false);
assert.equal(validMarkerPath(validMarker, fingerprint.toUpperCase(), attemptId), false);
assert.equal(validMarkerPath(validMarker, fingerprint, "../escape"), false);
assert.equal(verificationToken("  ＡＢＣ——测试 123456789 "), "ABC测试123456789");
const astralToken = verificationToken("𠀀一二三四五六七八九十");
assert.equal(Array.from(astralToken).length, 11);
assert.equal(astralToken, "𠀀一二三四五六七八九十");

async function runInjectedChecks() {
  const windowDriverPath = require.resolve("./wechat_window_driver.cjs");
  const publishDriverPath = require.resolve("./moments_publish_driver.dev.cjs");
  const windowDriver = require(windowDriverPath);
  const originalRunPowerShellAsync = windowDriver.runPowerShellAsync;
  const calls = [];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-moments-publish-driver-"));
  try {
    windowDriver.runPowerShellAsync = async (...args) => {
      calls.push(args);
      return { ok: false, status: "blocked", reason: "injected_no_action", actionAttempted: false };
    };
    delete require.cache[publishDriverPath];
    const injected = require(publishDriverPath);
    const mediaBytes = Buffer.from("test-media", "utf8");
    const mediaHash = createHash("sha256").update(mediaBytes).digest("hex");
    const mediaPath = path.join(tempRoot, `01-${mediaHash.slice(0, 12)}.jpg`);
    const markerDir = path.join(tempRoot, PUBLISH_MARKER_DIRECTORY);
    const markerPath = path.join(markerDir, `${fingerprint}.${attemptId}.json`);
    fs.writeFileSync(mediaPath, mediaBytes);
    fs.mkdirSync(markerDir);
    const mediaManifest = [{ path: mediaPath, sha256: mediaHash, size: mediaBytes.length, ext: ".jpg" }];
    const publishContent = "ABCDEF first line.\nSecond line 123";
    const request = {
      expectedWindow: {
        pid: 1234,
        hWnd: "5678",
        title: "微信",
        className: "mmui::MainWindow",
        surfaceMode: "integrated",
        x: 0,
        y: 0,
        width: 1100,
        height: 700,
        dpi: 120
      },
      content: publishContent,
      mediaPaths: [mediaPath],
      mediaManifest,
      mediaCount: 1,
      mediaKind: "image",
      fingerprint,
      attemptId,
      markerPath
    };

    const result = await injected.runMomentsPublish(request);
    assert.equal(result.reason, "injected_no_action");
    assert.equal(calls.length, 1, "valid input should reach only the injected PowerShell boundary");
    const [script, env, options] = calls[0];
    assert.equal(script, injected.MOMENTS_PUBLISH_POWERSHELL);
    assert.deepEqual(options, {
      ensure: false,
      sta: true,
      timeout: 150_000,
      diagnostics: false,
      signal: undefined
    });
    const payload = JSON.parse(Buffer.from(env.XIAOXI_MOMENTS_PUBLISH_CONTEXT_BASE64, "base64").toString("utf8"));
    assert.deepEqual(payload, {
      expectedPid: 1234,
      expectedHWnd: "5678",
      expectedTitle: "微信",
      expectedClassName: "mmui::MainWindow",
      expectedSurfaceMode: "integrated",
      expectedX: 0,
      expectedY: 0,
      expectedWidth: 1100,
      expectedHeight: 700,
      expectedDpi: 120,
      content: publishContent,
      verificationToken: "ABCDEFfirstlineSecondlin",
      verificationContent: "ABCDEFfirstlineSecondline123",
      mediaPaths: [mediaPath],
      mediaManifest,
      mediaCount: 1,
      mediaKind: "image",
      fingerprint,
      attemptId,
      markerPath
    });

    const invalidMarker = await injected.runMomentsPublish({ ...request, markerPath: path.join(markerDir, `${attemptId}.json`) });
    assert.equal(invalidMarker.reason, "moments_publish_marker_path_invalid");
    assert.equal(calls.length, 1);

    const invalidWindowProfile = await injected.runMomentsPublish({
      ...request,
      expectedWindow: { ...request.expectedWindow, title: "朋友圈" }
    });
    assert.equal(invalidWindowProfile.reason, "moments_publish_window_identity_invalid");
    assert.equal(calls.length, 1);

    const changedSize = await injected.runMomentsPublish({
      ...request,
      mediaManifest: [{ ...mediaManifest[0], size: mediaBytes.length + 1 }]
    });
    assert.equal(changedSize.reason, "moments_publish_media_manifest_invalid");
    assert.equal(calls.length, 1);

    const wrongKind = await injected.runMomentsPublish({ ...request, mediaKind: "video" });
    assert.equal(wrongKind.reason, "moments_publish_media_manifest_invalid");
    assert.equal(calls.length, 1);
  } finally {
    windowDriver.runPowerShellAsync = originalRunPowerShellAsync;
    delete require.cache[publishDriverPath];
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

runInjectedChecks()
  .then(() => console.log("moments publish driver self-check passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
