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
const selectionStart = NORMALIZE_WECHAT_WINDOW_SCRIPT.indexOf('if (-not $expectedHandleIsValid) {\n  $structuredMainMatches');
const selectionEnd = NORMALIZE_WECHAT_WINDOW_SCRIPT.indexOf('$matched = $matches[0]', selectionStart);
assert.ok(selectionStart >= 0 && selectionEnd > selectionStart);
const selection = NORMALIZE_WECHAT_WINDOW_SCRIPT.slice(selectionStart, selectionEnd + '$matched = $matches[0]'.length).replace(/\bexit\b/g, "return");
const selected = runPowerShell(`
${WECHAT_MAIN_WINDOW_RULES_SCRIPT}
function Set-WechatWindowStage([string]$stage) {}
function Select-Fixture([object[]]$windows) {
  $expectedHandleIsValid = $false
  $windowDiagnostic = @{}
  $matches = New-Object System.Collections.Generic.List[object]
  foreach ($window in $windows) { [void]$matches.Add($window) }
  ${selection}
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
console.log("wechat window layout and candidate-selection self-check passed");
