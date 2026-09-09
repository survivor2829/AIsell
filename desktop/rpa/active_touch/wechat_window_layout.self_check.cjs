const assert = require("node:assert/strict");
const {
  WECHAT_RPA_WINDOW_LAYOUTS,
  resolveWechatRpaWindowTarget,
  NORMALIZE_WECHAT_WINDOW_SCRIPT,
  WECHAT_MAIN_WINDOW_RULES_SCRIPT = "",
  runPowerShell
} = require("./wechat_window_driver.cjs");

assert.deepEqual(WECHAT_RPA_WINDOW_LAYOUTS, {
  main: { width: 1120, height: 760, layoutMode: "stable_target" },
  momentsStandalone: { layoutMode: "preserve_native_moments_popup" }
});

const workArea = { left: 12, top: 24, width: 2200, height: 1200 };
assert.deepEqual(resolveWechatRpaWindowTarget({ surfaceMode: "integrated", dpi: 96, workArea }), {
  x: 12,
  y: 24,
  width: 1120,
  height: 760,
  dpi: 96,
  layoutMode: "stable_target"
});
assert.deepEqual(resolveWechatRpaWindowTarget({ surfaceMode: "integrated", dpi: 120, workArea }), {
  x: 12,
  y: 24,
  width: 1400,
  height: 950,
  dpi: 120,
  layoutMode: "stable_target"
});
assert.deepEqual(resolveWechatRpaWindowTarget({ surfaceMode: "integrated", dpi: 144, workArea }), {
  x: 12,
  y: 24,
  width: 1680,
  height: 1140,
  dpi: 144,
  layoutMode: "stable_target"
});
assert.equal(resolveWechatRpaWindowTarget({ surfaceMode: "standalone", dpi: 120, workArea }), null,
  "standalone Moments must preserve its captured native geometry instead of inventing a target size");

assert.equal(resolveWechatRpaWindowTarget({ surfaceMode: "unknown", dpi: 96, workArea }), null);
assert.equal(resolveWechatRpaWindowTarget({ surfaceMode: "integrated", dpi: 0, workArea }), null);

// Run the actual candidate-selection block against window metadata. No window
// discovery, activation, mouse input or WeChat process is involved.
const selectionStart = NORMALIZE_WECHAT_WINDOW_SCRIPT.indexOf("function Select-WechatMainCandidates");
const selectionEnd = NORMALIZE_WECHAT_WINDOW_SCRIPT.indexOf("function Get-WechatWindowRecoveryCandidate", selectionStart);
assert.ok(selectionStart >= 0 && selectionEnd > selectionStart);
const selection = NORMALIZE_WECHAT_WINDOW_SCRIPT.slice(selectionStart, selectionEnd);
const enumerationStart = NORMALIZE_WECHAT_WINDOW_SCRIPT.indexOf("function Get-WechatWindowCandidates {");
const enumerationEnd = NORMALIZE_WECHAT_WINDOW_SCRIPT.indexOf("function Update-WechatWindowCandidateDiagnostics", enumerationStart);
const enumeration = NORMALIZE_WECHAT_WINDOW_SCRIPT.slice(enumerationStart, enumerationEnd);
const counts = runPowerShell(`
Add-Type 'public static class Win32WechatWindow { public static long[] WindowsForProcesses(int[] pids) { return new long[] { 1, 2 }; } }'
$windowDiagnostic = @{}
$wechatProcesses = @{ 1 = $true }
function Get-WechatWindowCandidate($h, $fallback) {
  $windowDiagnostic.window_hidden_count += 1
  $windowDiagnostic.window_minimized_count += 1
  $windowDiagnostic.window_rejected_layout_count += 1
  $windowDiagnostic.window_class_code = 'fixture'
  return $null
}
${enumeration}
$null = Get-WechatWindowCandidates
$null = Get-WechatWindowCandidates
$second = $windowDiagnostic.Clone()
$wechatProcesses = @{}
$null = Get-WechatWindowCandidates
@{ ok=$true; second=$second; empty=$windowDiagnostic } | ConvertTo-Json -Depth 4 -Compress
`, {}, { ensure: false, timeout: 15_000 });
assert.equal(counts.ok, true, JSON.stringify(counts));
for (const key of ["window_native_count", "window_hidden_count", "window_minimized_count", "window_rejected_layout_count"]) {
  assert.equal(counts.second[key], 2, `${key} must describe one enumeration, not accumulated recovery samples`);
  assert.equal(counts.empty[key], 0);
}
assert.equal(counts.empty.window_class_code, undefined);
const selected = runPowerShell(`
${WECHAT_MAIN_WINDOW_RULES_SCRIPT}
function Set-WechatWindowStage([string]$stage) {}
function Test-WechatShellNavigation([object]$window) { return [bool]$window.shellNavigation }
${selection}
function Select-Fixture([object[]]$windows) {
  $windowDiagnostic = @{}
  $matches = @(Select-WechatMainCandidates $windows)
  if ($matches.Count -eq 0) { @{ ok = $false; reason = "personal_wechat_main_window_not_found" } | ConvertTo-Json -Compress; return }
  if ($matches.Count -gt 1) { @{ ok = $false; reason = "wechat_window_ambiguous" } | ConvertTo-Json -Compress; return }
  $matched = $matches[0]
  @{ ok = $true; hWnd = [int64]$matched.hWnd } | ConvertTo-Json -Compress
}
$main = @{ hWnd=101; windowClass='mmui::MainWindow'; hasMainRenderChild=$false; owner=0; layoutRank=2; styleRank=4; classRank=3; area=851200; visible=$true; toolWindow=$false; shellNavigation=$false }
$other = $main.Clone(); $other.hWnd=102; $other.windowClass='QtUnknownQWindowIcon'; $other.classRank=0; $other.area=2000000
$owned = $main.Clone(); $owned.hWnd=103; $owned.owner=101
$legacy = $main.Clone(); $legacy.hWnd=104; $legacy.windowClass='QtQWindowIcon'; $legacy.classRank=0; $legacy.hasMainRenderChild=$true
$second = $main.Clone(); $second.hWnd=105; $second.area=900000
$shell = $other.Clone(); $shell.hWnd=106; $shell.shellNavigation=$true
@{
  ok=$true
  main=(Select-Fixture @($main,$other) | ConvertFrom-Json)
  unknown=(Select-Fixture @($other,$owned) | ConvertFrom-Json)
  ambiguous=(Select-Fixture @($main,$second) | ConvertFrom-Json)
  legacy=(Select-Fixture @($legacy) | ConvertFrom-Json)
  shell=(Select-Fixture @($shell) | ConvertFrom-Json)
} | ConvertTo-Json -Depth 5 -Compress
`, {}, { ensure: false, timeout: 15_000 });
assert.equal(selected.ok, true, JSON.stringify(selected));
assert.equal(selected.main.ok, true, "A recognized main HWND must not be discarded solely because its render-child class changed");
assert.equal(selected.main.hWnd, 101);
assert.equal(selected.unknown.ok, false, "A large unknown Qt window or owned popup is not sufficient main-window evidence");
assert.equal(selected.ambiguous.reason, "wechat_window_ambiguous", "Never choose a second main window merely because it is larger");
assert.equal(selected.legacy.hWnd, 104, "Retain the existing render-child adapter");
assert.equal(selected.shell.hWnd, 106, "An independently verified chat/contact navigation shell can identify the Qt main host");

// A standalone Moments surface must never become a send target, but it may
// provide the one safe executable path with which to ask WeChat to restore its
// actual main host before discovery is retried.
const recoveryStart = NORMALIZE_WECHAT_WINDOW_SCRIPT.indexOf("function Get-WechatWindowRecoveryCandidate");
const recoveryEnd = NORMALIZE_WECHAT_WINDOW_SCRIPT.indexOf("function Test-MatchedWechatWindowIdentity", recoveryStart);
assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart,
  "a strict main-window miss must have a bounded, executable-only recovery path");
const recovery = NORMALIZE_WECHAT_WINDOW_SCRIPT.slice(recoveryStart, recoveryEnd);
const recoverySelection = runPowerShell(`
${recovery}
$windowDiagnostic = @{}
$standalone = @{ hWnd=201; processPath='C:\\Weixin\\Weixin.exe'; pid=8; visible=$true; minimized=$false; toolWindow=$false; owner=0; layoutRank=2; hasMainRenderChild=$false; shellNavigation=$false; windowClass='Qt51514QWindowIcon' }
$sameExecutable = $standalone.Clone(); $sameExecutable.hWnd=202; $sameExecutable.pid=9
$otherExecutable = $standalone.Clone(); $otherExecutable.hWnd=203; $otherExecutable.processPath='C:\\WeChat\\WeChat.exe'
$weakAuxiliary = $standalone.Clone(); $weakAuxiliary.hWnd=204; $weakAuxiliary.windowClass='QtUnknownQWindowIcon'
$unknownQt = $standalone.Clone(); $unknownQt.windowClass='QtUnknownQWindowIcon'
@{
  one=(Get-WechatWindowRecoveryCandidate @($standalone)).hWnd
  crossPid=(Get-WechatWindowRecoveryCandidate @($standalone,$sameExecutable)) -eq $null
  ambiguous=(Get-WechatWindowRecoveryCandidate @($standalone,$otherExecutable)) -eq $null
  weakAuxiliary=(Get-WechatWindowRecoveryCandidate @($standalone,$weakAuxiliary)) -eq $null
  unknownQt=(Get-WechatWindowRecoveryCandidate @($unknownQt)) -eq $null
} | ConvertTo-Json -Compress
`, {}, { ensure: false, timeout: 15_000 });
assert.equal(recoverySelection.one, 201, "the sole standalone surface may request WeChat's own main-window restore");
assert.equal(recoverySelection.crossPid, true, "a second standalone WeChat PID must not be guessed as the same account");
assert.equal(recoverySelection.ambiguous, true, "different executable paths must not be guessed as one recoverable main window");
assert.equal(recoverySelection.weakAuxiliary, true, "a recovery trigger must be the only initial candidate, not merely the only matching one");
assert.equal(recoverySelection.unknownQt, true, "an unknown Qt surface must not become a recovery trigger");

// Exercise the actual recovery decision block with re-enumerated metadata.
// The only accepted post-activation result is one strict main candidate from
// the same PID that supplied the standalone surface.
const recoveryFlowStart = NORMALIZE_WECHAT_WINDOW_SCRIPT.indexOf("if (-not $expectedHandleIsValid) {\n  $matches = @(Select-WechatMainCandidates $candidateMatches)");
const recoveryFlowEnd = NORMALIZE_WECHAT_WINDOW_SCRIPT.indexOf("$windowDiagnostic.window_main_count = $matches.Count", recoveryFlowStart);
assert.ok(recoveryFlowStart >= 0 && recoveryFlowEnd > recoveryFlowStart,
  "recovery must re-enumerate and strictly select a proven main window");
const recoveryFlow = NORMALIZE_WECHAT_WINDOW_SCRIPT.slice(recoveryFlowStart, recoveryFlowEnd);
const recoveryFlowResult = runPowerShell(`
$ErrorActionPreference = "Stop"
trap { @{ ok=$false; error=$_.Exception.Message; line=$_.InvocationInfo.ScriptLineNumber } | ConvertTo-Json -Compress; exit 0 }
${WECHAT_MAIN_WINDOW_RULES_SCRIPT}
function Set-WechatWindowStage([string]$stage) {}
function Test-WechatShellNavigation([object]$window) { return [bool]$window.shellNavigation }
${selection}
${recovery}
function Start-Sleep { param([int]$Milliseconds) }
function Invoke-RecoveryFixture([int]$recoveredPid, [bool]$inspectOnly = $false) {
  $script:fixtureReenumeration = 0
  $script:fixtureActivationCount = 0
  $windowDiagnostic = @{ window_recovery_candidate_count = 0; window_recovery_main_count = 0; window_recovery_attempted = $false; window_recovery_succeeded = $false }
  $standalone = @{ hWnd=210; processPath='C:\\Weixin\\Weixin.exe'; pid=8; visible=$true; minimized=$false; toolWindow=$false; owner=0; layoutRank=2; hasMainRenderChild=$false; shellNavigation=$false; windowClass='Qt51514QWindowIcon' }
  $main = @{ hWnd=211; processPath='C:\\Weixin\\Weixin.exe'; pid=$recoveredPid; visible=$true; minimized=$false; toolWindow=$false; owner=0; layoutRank=2; hasMainRenderChild=$true; shellNavigation=$false; windowClass='QtQWindowIcon' }
  function Get-WechatWindowCandidates {
    $script:fixtureReenumeration++
    if ($script:fixtureReenumeration -eq 1) { return @($standalone) }
    return @($main)
  }
  function Update-WechatWindowCandidateDiagnostics([object[]]$candidates) {}
  function Test-XiaoxiUserIdle { return $true }
  function Request-PersonalWechatActivation([object]$window) { $script:fixtureActivationCount++; return $true }
  $expectedHandleIsValid = $false
  $nativeActivationRequested = $false
  $candidateMatches = @(Get-WechatWindowCandidates)
  $matches = @()
  ${recoveryFlow}
  @{ activation=$script:fixtureActivationCount; hWnd=$(if ($matches.Count -eq 1) { [int64]$matches[0].hWnd } else { 0 }); recoverySucceeded=$windowDiagnostic.window_recovery_succeeded; recoveryMainCount=$windowDiagnostic.window_recovery_main_count } | ConvertTo-Json -Compress
}
@{
  samePid=(Invoke-RecoveryFixture 8 | ConvertFrom-Json)
  otherPid=(Invoke-RecoveryFixture 9 | ConvertFrom-Json)
  inspectOnly=(Invoke-RecoveryFixture 8 $true | ConvertFrom-Json)
} | ConvertTo-Json -Depth 5 -Compress
`, {}, { ensure: false, timeout: 15_000 });
assert.ok(recoveryFlowResult?.samePid, `recovery fixture must return all scenarios: ${JSON.stringify(recoveryFlowResult)}`);
assert.equal(recoveryFlowResult.samePid.activation, 1, "a successful recovery may request native activation exactly once");
assert.equal(recoveryFlowResult.samePid.hWnd, 211, "re-enumeration must choose the newly proven main HWND, never the standalone surface");
assert.equal(recoveryFlowResult.samePid.recoverySucceeded, true);
assert.equal(recoveryFlowResult.otherPid.activation, 1, "the trigger remains bounded even when the result is rejected");
assert.equal(recoveryFlowResult.otherPid.hWnd, 0, "a strict main HWND from a different PID must fail closed");
assert.equal(recoveryFlowResult.otherPid.recoverySucceeded, false);
assert.equal(recoveryFlowResult.inspectOnly.activation, 0, "a read-only inspection must never request WeChat activation");
assert.equal(recoveryFlowResult.inspectOnly.hWnd, 0, "a read-only inspection must not promote the standalone surface");
console.log("wechat window layout and candidate-selection self-check passed");
