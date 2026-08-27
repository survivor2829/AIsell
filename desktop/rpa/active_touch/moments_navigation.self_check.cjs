const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const navigationPath = path.join(__dirname, "moments_navigation.dev.cjs");
const calls = [];
const prepareCalls = [];
const inspectCalls = [];
const surfaceInspectCalls = [];
const surfaceInspectRunners = [];
const surfaceFocusCalls = [];
const surfaceFocusRunners = [];
const initialHost = {
  ok: true,
  normalized: true,
  layoutMode: "stable_target",
  focused: true,
  pid: 42,
  hWnd: "84",
  x: 0,
  y: 0,
  width: 1120,
  height: 760,
  dpi: 96,
  title: "微信",
  windowClass: "mmui::MainWindow"
};
const openedSurface = {
  ok: true,
  action: "moments-open",
  surfaceMode: "integrated",
  title: "微信",
  className: "mmui::MainWindow",
  pid: 42,
  hWnd: "84"
};
let prepareBehavior = async (context) => ({
  ...initialHost,
  pid: context.expectedPid ?? initialHost.pid,
  hWnd: String(context.expectedHWnd ?? initialHost.hWnd)
});
const defaultInspectBehavior = async (context) => ({
  ...initialHost,
  inspectionOnly: true,
  pid: context.expectedPid ?? initialHost.pid,
  hWnd: String(context.expectedHWnd ?? initialHost.hWnd)
});
let inspectBehavior = defaultInspectBehavior;
const defaultSurfaceInspectBehavior = async (context) => ({
  ...initialHost,
  inspectionOnly: true,
  surfaceMode: context.surfaceMode,
  title: context.expectedTitle,
  windowClass: context.expectedWindowClass,
  pid: context.expectedPid,
  hWnd: String(context.expectedHWnd)
});
let surfaceInspectBehavior = defaultSurfaceInspectBehavior;
const defaultSurfaceFocusBehavior = async (context) => {
  const integrated = context.surfaceMode === "integrated";
  return {
    ok: true,
    focusOnly: true,
    inspectionOnly: false,
    normalized: true,
    layoutMode: integrated ? "stable_target" : "preserve_native_moments_popup",
    focused: true,
    surfaceMode: context.surfaceMode,
    title: context.title,
    windowClass: context.windowClass ?? context.className,
    processName: context.processName ?? "Weixin",
    pid: context.pid,
    hWnd: String(context.hWnd),
    x: integrated ? Number(context.x ?? context.left) : 0,
    y: integrated ? Number(context.y ?? context.top) : 0,
    width: integrated ? Number(context.width) : 680,
    height: integrated ? Number(context.height) : 820,
    dpi: Number(context.dpi ?? 96)
  };
};
let surfaceFocusBehavior = defaultSurfaceFocusBehavior;
const defaultPowerShellBehavior = async (_script, env) => env.XIAOXI_MOMENTS_NAV_ACTION === "open"
  ? openedSurface
  : { ok: false, reason: "self_check_boundary" };
let powerShellBehavior = defaultPowerShellBehavior;
const powerShellRunner = (script, env, options) => {
  calls.push({ script, env, options });
  return powerShellBehavior(script, env, options);
};
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (
    request === "./wechat_window_driver.cjs"
    && path.resolve(parent?.filename || "") === path.resolve(navigationPath)
  ) {
    return {
      WECHAT_MOMENTS_STANDALONE_WINDOW_LAYOUT_MODE: "preserve_native_moments_popup",
      WECHAT_RPA_WINDOW_LAYOUT_MODE: "stable_target",
      inspectForegroundWechatMainWindow: async (context) => {
        inspectCalls.push(context);
        return inspectBehavior(context);
      },
      inspectForegroundWechatRpaSurface: async (context, runner) => {
        surfaceInspectCalls.push(context);
        surfaceInspectRunners.push(runner);
        return surfaceInspectBehavior(context);
      },
      focusExactWechatRpaSurfaceAsync: async (context, runner) => {
        surfaceFocusCalls.push(context);
        surfaceFocusRunners.push(runner);
        return surfaceFocusBehavior(context);
      },
      prepareWechatRpaWindowAsync: async (context) => {
        prepareCalls.push(context);
        return prepareBehavior(context);
      },
      isPreparedWechatRpaLayout: (result) => result?.normalized === true && result.layoutMode === "stable_target",
      runPowerShellAsync: powerShellRunner
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

delete require.cache[require.resolve(navigationPath)];
let navigation;
try {
  navigation = require(navigationPath);
} finally {
  Module._load = originalLoad;
}

const {
  MOMENTS_INTEGRATED_TRANSITION_VISUAL_CHECKS,
  MOMENTS_NAVIGATION_OPEN_TIMEOUT_MS,
  MOMENTS_NAVIGATION_POWERSHELL,
  openWechatMoments,
  resolveMomentsScrollPlan,
  scrollWechatMomentsFeed
} = navigation;
const {
  focusExactWechatRpaSurfaceAsync: focusRealWechatRpaSurfaceAsync,
  runPowerShellAsync: runRealPowerShellAsync
} = require("./wechat_window_driver.cjs");

const windowDriverSource = fs.readFileSync(path.join(__dirname, "wechat_window_driver.cjs"), "utf8");
const surfaceInspectorStart = windowDriverSource.indexOf("const INSPECT_WECHAT_RPA_SURFACE_SCRIPT = `");
const surfaceInspectorEnd = windowDriverSource.indexOf("`;", surfaceInspectorStart);
assert.ok(surfaceInspectorStart >= 0 && surfaceInspectorEnd > surfaceInspectorStart);
const surfaceInspectorSource = windowDriverSource.slice(surfaceInspectorStart, surfaceInspectorEnd);
assert.match(surfaceInspectorSource, /AttachThreadInput/u);
assert.match(surfaceInspectorSource, /BringWindowToTop/u);
assert.match(surfaceInspectorSource, /SetForegroundWindow/u);
assert.match(surfaceInspectorSource, /SetWindowPos/u,
  "the exact popup handoff must normalize the locked standalone Moments window");
assert.doesNotMatch(surfaceInspectorSource, /Start-Process/u,
  "the exact popup handoff must never launch a replacement process");
assert.match(surfaceInspectorSource, /\[uint32\]\$finalObservedInputTick = \[Win32WechatRpaSurfaceInspector\]::GetLastInputTick\(\)/u);
assert.match(surfaceInspectorSource, /\$finalObservedInputTick -ne \$inputTick/u,
  "the exact popup handoff must recheck its input lease at the final success boundary");

assert.equal(typeof openWechatMoments, "function");
assert.equal(typeof scrollWechatMomentsFeed, "function");
assert.equal(typeof resolveMomentsScrollPlan, "function");
assert.deepEqual(resolveMomentsScrollPlan({ renderPaneBounds: { height: 720 } }, "read_post_up"), {
  mode: "read_post_up",
  viewportHeight: 720,
  delta: 240
});
assert.deepEqual(resolveMomentsScrollPlan({ renderPaneBounds: { height: 900 } }, "seek_post_menu_down"), {
  mode: "seek_post_menu_down",
  viewportHeight: 900,
  delta: -300
});
assert.deepEqual(resolveMomentsScrollPlan({ renderPaneBounds: { height: 900 } }, "advance_feed"), {
  mode: "advance_feed",
  viewportHeight: 900,
  delta: -480
});
assert.deepEqual(resolveMomentsScrollPlan({ height: 1200 }, "advance_feed"), {
  mode: "advance_feed",
  viewportHeight: 1200,
  delta: -600
});
assert.equal(resolveMomentsScrollPlan({ height: 900 }, "seek_post_mneu_down"), null,
  "an unknown internal scroll intent must never silently advance the feed");
assert.equal(MOMENTS_NAVIGATION_OPEN_TIMEOUT_MS, 45_000);
assert.equal(MOMENTS_INTEGRATED_TRANSITION_VISUAL_CHECKS, 6,
  "the integrated Discover transition needs a bounded multi-frame window for slower WeChat rendering");
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /NameProperty,\s*"朋友圈"/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /GetClassName/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /className = \$classText\.ToString\(\)\.Trim\(\)/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /\$hit = \[Win32WechatMomentsNavigation\]::WindowFromPoint\(\$point\)[\s\S]*GetAncestor\(\$hit, 2\)/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /function Invoke-MomentsGuardedClick[\s\S]*\$hitRoot -ne \[IntPtr\]\$window\.hWnd -or \[int\]\$hitPid -ne \[int\]\$window\.pid/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /function Test-MomentsWindowStable[\s\S]*GetWindowText[\s\S]*GetClassName[\s\S]*GetWindowRect/u);
const stableMomentsHostSource = MOMENTS_NAVIGATION_POWERSHELL.slice(
  MOMENTS_NAVIGATION_POWERSHELL.indexOf("function Test-MomentsWindowStable"),
  MOMENTS_NAVIGATION_POWERSHELL.indexOf("function Invoke-MomentsGuardedClick")
);
assert.match(
  stableMomentsHostSource,
  /GetWindowText[\s\S]*GetClassName[\s\S]*GetWindowRect[\s\S]*\$rect\.Left -eq \[int\]\$window\.left[\s\S]*\$window\.height/u,
  "the original chat host must retain exact HWND identity and geometry while a popup takes foreground"
);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /GetLastInputTick/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /GetLastInputIdleMilliseconds/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /XIAOXI_MOMENTS_MIN_IDLE_MS/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /moments_user_input_detected/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /XIAOXI_MOMENTS_SCROLL_MODE/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /read_post_up/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /seek_post_menu_down/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /XIAOXI_MOMENTS_SCROLL_DELTA/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /GuardedWheel\(\$x, \$y, \$wheelDelta, \$expectedInputTick\)/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /moments_window_open_timeout/u);
const integratedEntryStateSource = MOMENTS_NAVIGATION_POWERSHELL.slice(
  MOMENTS_NAVIGATION_POWERSHELL.indexOf("function Get-IntegratedMomentsEntryState"),
  MOMENTS_NAVIGATION_POWERSHELL.indexOf("function Get-IntegratedDiscoverDiagnostics")
);
assert.doesNotMatch(
  integratedEntryStateSource,
  /integrated_visual_observation_changed/u,
  "mouse activity while processing a frozen read-only frame must not invalidate that observation"
);
assert.match(
  integratedEntryStateSource,
  /Get-IntegratedMomentsEntryEvidence \$frame[\s\S]*\[uint32\]\$evidenceInputTick = Get-MomentsLastInputTick[\s\S]*inputTick = \[uint32\]\$evidenceInputTick/u,
  "the reader must lease current input only after finishing frozen-frame recognition"
);
const openMomentsSource = MOMENTS_NAVIGATION_POWERSHELL.slice(
  MOMENTS_NAVIGATION_POWERSHELL.indexOf("function Open-Moments"),
  MOMENTS_NAVIGATION_POWERSHELL.indexOf("function Scroll-Moments")
);
assert.match(
  openMomentsSource,
  /\$integratedEntry = Get-IntegratedMomentsEntryState \$main[\s\S]*GetLastInputTick\(\) -ne \[uint32\]\$integratedEntry\.inputTick[\s\S]*\$integratedInputTick = \[uint32\]\$integratedEntry\.inputTick/u,
  "a stable fresh observation may replace the older pre-observation input lease before the first click"
);
const passiveLeaseRebaseCount = (
  openMomentsSource.match(/\$integratedInputTick = \[uint32\]\$(?:integratedEntry|currentEntry)\.inputTick/gu) || []
).length;
const guardedClickLeaseAdvanceCount = (
  openMomentsSource.match(/\$integratedInputTick = \[uint32\]\$(?:discoverClick|entryClick)\.inputTick/gu) || []
).length;
assert.match(
  openMomentsSource,
  /\$currentEntry = Get-IntegratedMomentsEntryState \$current[\s\S]*\$integratedInputTick = \[uint32\]\$currentEntry\.inputTick/u,
  "a fresh exact transition observation must rebase navigation input before any later click"
);
assert.equal(
  (openMomentsSource.match(/\$attempt -lt \$integratedTransitionVisualChecks/gu) || []).length,
  2,
  "each expensive integrated transition must use the shared bounded visual-check budget"
);
assert.match(
  openMomentsSource,
  /\[int\]\$integratedTransitionVisualChecks = 6/u,
  "the generated PowerShell must receive the bounded visual-check budget"
);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /function Resolve-ExpectedMomentsHost/u);
assert.match(
  MOMENTS_NAVIGATION_POWERSHELL,
  /\[int\]\$_\.pid -eq \$expectedPid[\s\S]*\[int64\]\$_\.hWnd -eq \$expectedHWnd[\s\S]*\$_\.title -ceq \[string\]\$expected\.title[\s\S]*\$_\.className -ceq \[string\]\$expected\.windowClass/u,
  "navigation must rebind the exact preflight PID/HWND/title/class"
);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /\[int\]\$window\.left -ne \[int\]\$expected\.x[\s\S]*\[int\]\$window\.dpi -ne \[int\]\$expected\.dpi/u);
assert.doesNotMatch(MOMENTS_NAVIGATION_POWERSHELL, /SendKeys/u);
assert.doesNotMatch(MOMENTS_NAVIGATION_POWERSHELL, /function Focus-Window/u, "scroll must never steal foreground after its idle preflight");
assert.doesNotMatch(
  MOMENTS_NAVIGATION_POWERSHELL,
  /\[uint32\]\$pid\b/u,
  "PowerShell $PID is read-only and must not be reused as the window process-id out parameter"
);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /\[uint32\]\$windowProcessId = 0/u);
assert.doesNotMatch(
  MOMENTS_NAVIGATION_POWERSHELL,
  /return @\(\$windows\)/u,
  "PowerShell 5 cannot reliably wrap the generic window list with an array subexpression"
);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /return \$windows/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /GetDpiForWindow/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /function Invoke-MomentsSidebarFallback/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /\(26 \* \$scale\)/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /\(248 \* \$scale\)/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /moments_entry_fallback_not_owned/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /entryMode = "dpi_sidebar_fallback"/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /XIAOXI_MOMENTS_ALLOW_INTEGRATED/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /Write-MomentsOpenSuccess[^\r\n]*"standalone"/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /Write-MomentsOpenSuccess[^\r\n]*"integrated"/u);
assert.match(
  MOMENTS_NAVIGATION_POWERSHELL,
  /\[int\]\$_\.pid -eq \[int\]\$main\.pid[\s\S]*\[int64\]\$_\.hWnd -eq \[int64\]\$main\.hWnd[\s\S]*\[string\]\$_\.title -ceq \[string\]\$main\.title/u,
  "the integrated compatibility path must retain the exact original host HWND/PID"
);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /function Get-IntegratedMomentsEntryState/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /\$activeRows = New-Object System\.Collections\.Generic\.List\[int\][\s\S]*\$rowGroups = New-Object System\.Collections\.Generic\.List\[object\]/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /Get-IntegratedMomentsEntryEvidence \$frame \$surfaceScanBounds/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /discoverSelectedMatchCount = \$selectedDiscoverMatches\.Count/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /discoverCandidateDiagnostics = @\(\$discoverEvidence\.candidateDiagnostics\)/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /function Get-IntegratedDiscoverDiagnostics/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /entryRegionBounds = \$entryEvidence\.region/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /function Invoke-IntegratedMomentsEntry/u);
assert.match(
  MOMENTS_NAVIGATION_POWERSHELL,
  /function Invoke-IntegratedDiscoverEntry[\s\S]*moments_discover_entry_not_owned/u,
  "the new first stage must use a dedicated owned Discover navigation click"
);
assert.match(
  MOMENTS_NAVIGATION_POWERSHELL,
  /function Invoke-MomentsGuardedClick[\s\S]*inputTick = \[uint32\]\$nextInputTick/u,
  "each successful navigation click must return a fresh user-input lease"
);
const settledInputLeaseStart = MOMENTS_NAVIGATION_POWERSHELL.indexOf(
  "function Get-MomentsSettledInputTick"
);
const settledInputLeaseEnd = MOMENTS_NAVIGATION_POWERSHELL.indexOf(
  "function Invoke-MomentsGuardedClick",
  settledInputLeaseStart
);
assert.ok(
  settledInputLeaseStart >= 0 && settledInputLeaseEnd > settledInputLeaseStart,
  "owned navigation clicks must wait for their delayed Windows input tick before leasing it"
);
const settledInputLeaseSource = MOMENTS_NAVIGATION_POWERSHELL.slice(
  settledInputLeaseStart,
  settledInputLeaseEnd
);

function runSettledInputLeaseProbe(ticks) {
  const encodedTicks = Buffer.from(JSON.stringify(ticks), "utf8").toString("base64");
  const program = `
$script:selfCheckTicks = @(
  ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encodedTicks}")) | ConvertFrom-Json)
)
$script:selfCheckTickIndex = 0
function Get-MomentsLastInputTick {
  $index = [Math]::Min($script:selfCheckTickIndex, $script:selfCheckTicks.Count - 1)
  $value = [uint32]$script:selfCheckTicks[$index]
  $script:selfCheckTickIndex += 1
  return $value
}
${settledInputLeaseSource}
@{
  tick = [uint32](Get-MomentsSettledInputTick 1 4)
  reads = [int]$script:selfCheckTickIndex
} | ConvertTo-Json -Compress
`;
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); Invoke-Expression $source"
  ], {
    input: Buffer.from(program, "utf8").toString("base64"),
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000
  });
  assert.equal(result.status, 0, result.stderr || "settled input lease probe must run");
  return JSON.parse(result.stdout.trim());
}

assert.deepEqual(
  runSettledInputLeaseProbe([10, 20, 20]),
  { reads: 3, tick: 20 },
  "a delayed tick from the program's own click must become the next input lease"
);
assert.deepEqual(
  runSettledInputLeaseProbe([10, 20, 30, 40]),
  { reads: 4, tick: 4294967295 },
  "continuously changing input must not be mistaken for a settled owned click"
);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /function Test-IntegratedMomentsEntryReadyToClick/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /\$integratedEntryMode = "integrated_sidebar_ocr"/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /\$integratedEntryMode = "integrated_discover_then_moments"/u);
assert.match(
  MOMENTS_NAVIGATION_POWERSHELL,
  /moments_discover_entry_not_found[\s\S]*diagnostics = @\{ discover = Get-IntegratedDiscoverDiagnostics \$integratedEntry \}/u,
  "a blocked Discover preflight must return numeric candidate diagnostics without a screenshot"
);

const openSource = MOMENTS_NAVIGATION_POWERSHELL.slice(
  MOMENTS_NAVIGATION_POWERSHELL.indexOf("function Open-Moments"),
  MOMENTS_NAVIGATION_POWERSHELL.indexOf("function Scroll-Moments")
);
assert.match(
  openSource,
  /Test-IntegratedMomentsAlreadyOpen \$integratedEntry[\s\S]*Write-MomentsOpenSuccess[\s\S]*\$selectedDiscoverEntries\.Count -ne 1/u,
  "a uniquely selected Moments page must be accepted before the redundant primary-rail Discover check"
);
assert.match(
  openSource,
  /if \(\[int\]\$integratedEntry\.discoverExactMatchCount -ne 1\)[\s\S]*for \(\$preflightAttempt = 0; \$preflightAttempt -lt \$integratedTransitionVisualChecks; \$preflightAttempt\+\+\)[\s\S]*Test-IntegratedMomentsAlreadyOpen \$currentEntry[\s\S]*Write-MomentsOpenSuccess[\s\S]*moments_discover_entry_not_found/u,
  "a transient first-frame Discover miss must receive bounded passive re-observation and accept direct Moments-page proof"
);
const ocrEntryIndex = openSource.indexOf("$integratedEntry = Get-IntegratedMomentsEntryState $main");
const uiaEntryIndex = openSource.indexOf("$nameCondition = [System.Windows.Automation.PropertyCondition]");
const fallbackIndex = openSource.indexOf("$fallback = Invoke-MomentsSidebarFallback $main");
assert.ok(ocrEntryIndex >= 0 && uiaEntryIndex > ocrEntryIndex && fallbackIndex > uiaEntryIndex,
  "integrated navigation must try exact OCR before UIA and the legacy fallback");
assert.match(openSource, /\$integratedEntry\.exactMatchCount -gt 1[\s\S]*moments_entry_ambiguous/u);
assert.match(
  openSource,
  /\$selectedDiscoverEntries\.Count -ne 1[\s\S]*\$discoverClick = Invoke-IntegratedDiscoverEntry[\s\S]*\$integratedInputTick = \[uint32\]\$discoverClick\.inputTick[\s\S]*Get-IntegratedMomentsEntryState \$current/u,
  "chat-page integrated navigation must enter Discover and advance the lease only from that guarded click"
);
const postDiscoverTransitionSource = openSource.slice(
  openSource.indexOf("$revealedEntry = $false"),
  openSource.indexOf("if (-not $revealedEntry)")
);
assert.match(
  postDiscoverTransitionSource,
  /Test-IntegratedMomentsAlreadyOpen \$currentEntry[\s\S]*Test-IntegratedMomentsEntryReadyToClick \$currentEntry/u,
  "after clicking Discover, a unique Moments row must drive the next decision from the fresh frame"
);
assert.doesNotMatch(
  postDiscoverTransitionSource,
  /discoverExactMatchCount|currentSelectedDiscover/u,
  "the already-consumed Discover icon proof must not gate the revealed Moments row"
);
const postMomentsTransitionSource = openSource.slice(
  openSource.indexOf("$entryClick = Invoke-IntegratedMomentsEntry"),
  openSource.indexOf('Write-Result @{ ok = $false; reason = "moments_window_open_timeout"')
);
assert.match(
  postMomentsTransitionSource,
  /\$integratedInputTick = \[uint32\]\$entryClick\.inputTick[\s\S]*Get-IntegratedMomentsEntryState \$current[\s\S]*Test-IntegratedMomentsAlreadyOpen \$currentEntry[\s\S]*Write-MomentsOpenSuccess/u,
  "the selected-page proof may observe new frames but only the guarded click advances the lease"
);
assert.doesNotMatch(
  postMomentsTransitionSource,
  /discoverExactMatchCount|currentSelectedDiscover/u,
  "after clicking Moments, only the selected Moments page and its content boundary prove success"
);
assert.doesNotMatch(
  openSource,
  /exactMatchCount -eq 1 -and \$[a-zA-Z]+Selected\.Count -eq 1\) \{\s*Write-MomentsOpenSuccess/u,
  "a selected Moments row without its content boundary must never be reported as open"
);
assert.match(openSource, /elseif \(-not \$allowIntegrated\) \{\s*\$fallback = Invoke-MomentsSidebarFallback/u,
  "the old coordinate fallback must be unreachable in the integrated path");

const openMomentsDecisionSource = openSource.replace(
  /try \{ \$root = \[System\.Windows\.Automation\.AutomationElement\]::FromHandle\(\[IntPtr\]\$main\.hWnd\) \} catch \{ \$root = \$null \}/u,
  "$root = @{ selfCheckRoot = $true }"
).replace(
  /\[Win32WechatMomentsNavigation\]::GetForegroundWindow\(\)/gu,
  "(Get-SelfCheckForegroundWindow)"
).replace(
  /\[Win32WechatMomentsNavigation\]::GetLastInputTick\(\)/gu,
  "(Get-SelfCheckInputTick)"
);
assert.notEqual(
  openMomentsDecisionSource,
  openSource,
  "the surface decision probe must replace only the live UIAutomation root lookup"
);

function momentsSurfaceFixture(overrides = {}) {
  return {
    pid: 42,
    hWnd: "84",
    processName: "Weixin",
    title: "微信",
    className: "mmui::MainWindow",
    left: 0,
    top: 0,
    width: 1120,
    height: 760,
    dpi: 96,
    ...overrides
  };
}

async function runOpenSurfaceDecisionProbe({
  standaloneWindows = [],
  integratedProven,
  userInputBeforeFreshObservation = false,
  userInputBetweenClicks = false,
  userInputAfterFinalClick = false,
  hostChangesAfterClick = false,
  standaloneAppearsAfterIntegrated = false
}) {
  const host = momentsSurfaceFixture();
  const fixture = Buffer.from(JSON.stringify({
    host,
    windows: [host, ...standaloneWindows],
    integratedProven,
    userInputBeforeFreshObservation,
    userInputBetweenClicks,
    userInputAfterFinalClick,
    hostChangesAfterClick,
    standaloneAppearsAfterIntegrated,
    foregroundHWnd: standaloneWindows[0]?.hWnd || host.hWnd
  }), "utf8").toString("base64");
  return runRealPowerShellAsync(`
$script:fixture = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${fixture}")) | ConvertFrom-Json
$script:entryReadCount = 0
$script:inputTick = [uint32]10
$script:popupVisibleThisObservation = -not [bool]$script:fixture.standaloneAppearsAfterIntegrated
function Write-Result($value) { $value | ConvertTo-Json -Compress -Depth 8; exit }
function Write-MomentsOpenSuccess($window, [string]$surfaceMode, [bool]$alreadyOpen, [string]$entryMode) {
  Write-Result @{
    ok = $true
    surfaceMode = $surfaceMode
    alreadyOpen = $alreadyOpen
    entryMode = $entryMode
    pid = [int]$window.pid
    hWnd = [string]$window.hWnd
    title = [string]$window.title
    className = [string]$window.className
    x = [int]$window.left
    y = [int]$window.top
    width = [int]$window.width
    height = [int]$window.height
  }
}
function Resolve-ExpectedMomentsHost { return @{ ok = $true; window = $script:fixture.host } }
function Get-MomentsMinimumIdleMs { return 0 }
function Test-MomentsUserIdle([int]$minimumIdleMs) { return $true }
function Test-MomentsWindowStable($window, [bool]$requireForeground = $true) {
  if ([bool]$script:fixture.hostChangesAfterClick -and $script:entryReadCount -ge 2) { return $false }
  $popupIsVisible = $script:fixture.windows.Count -gt 1 -and [bool]$script:popupVisibleThisObservation
  $popupOwnsForeground = [int64](Get-SelfCheckForegroundWindow) -ne [int64]$script:fixture.host.hWnd
  if ($requireForeground -and $popupIsVisible -and $popupOwnsForeground -and [int64]$window.hWnd -eq [int64]$script:fixture.host.hWnd) {
    return $false
  }
  return $true
}
function Get-MomentsWindowFingerprint($window) {
  return @(
    [string]$window.pid, [string]$window.hWnd, [string]$window.title, [string]$window.className,
    [string]$window.left, [string]$window.top, [string]$window.width, [string]$window.height, [string]$window.dpi
  ) -join "|"
}
function Get-SelfCheckForegroundWindow {
  if (-not [bool]$script:popupVisibleThisObservation) {
    return [IntPtr][int64]$script:fixture.host.hWnd
  }
  return [IntPtr][int64]$script:fixture.foregroundHWnd
}
function Get-SelfCheckInputTick {
  if ([bool]$script:fixture.userInputAfterFinalClick -and $script:inputTick -eq [uint32]21) { return [uint32]99 }
  if ([bool]$script:fixture.userInputBetweenClicks -and $script:entryReadCount -ge 1) { return [uint32]99 }
  return [uint32]$script:inputTick
}
function Get-WechatWindows {
  $script:popupVisibleThisObservation = -not [bool]$script:fixture.standaloneAppearsAfterIntegrated -or $script:entryReadCount -ge 3
  if (-not [bool]$script:popupVisibleThisObservation) {
    return @($script:fixture.host)
  }
  return @($script:fixture.windows)
}
function Get-MomentsWindow { return @(Get-WechatWindows | Where-Object { [string]$_.title -ceq "朋友圈" }) }
function Get-IntegratedMomentsEntryState($window) {
  $script:entryReadCount += 1
  if ($script:entryReadCount -eq 1) {
    if ([bool]$script:fixture.userInputBeforeFreshObservation) { $script:inputTick = [uint32]11 }
    return @{
      ok = $true; inputTick = [uint32]$script:inputTick; alreadyOpen = $false; readyToClick = $false
      discoverExactMatchCount = 1; discoverEntries = @(@{ selected = $false })
      exactMatchCount = 0; entries = @()
    }
  }
  if ($script:entryReadCount -eq 2) {
    return @{
      ok = $true; inputTick = [uint32](Get-SelfCheckInputTick); alreadyOpen = $false; readyToClick = $true
      discoverExactMatchCount = 0; discoverEntries = @()
      exactMatchCount = 1; entries = @(@{ selected = $false; contentBoundaryProven = $false })
    }
  }
  $integratedOpen = [bool]$script:fixture.integratedProven
  return @{
    ok = $true; inputTick = [uint32](Get-SelfCheckInputTick)
    alreadyOpen = $integratedOpen; readyToClick = (-not $integratedOpen)
    discoverExactMatchCount = 0; discoverEntries = @()
    exactMatchCount = 1
    entries = @(@{ selected = $integratedOpen; contentBoundaryProven = $integratedOpen })
  }
}
function Test-IntegratedMomentsAlreadyOpen($entryState) { return [bool]$entryState.alreadyOpen }
function Test-IntegratedMomentsEntryReadyToClick($entryState) { return [bool]$entryState.readyToClick }
function Invoke-IntegratedDiscoverEntry($window, $entryState, [uint32]$inputTick) {
  if ($inputTick -ne [uint32](Get-SelfCheckInputTick)) { return @{ ok = $false; reason = "moments_user_input_detected" } }
  $script:inputTick = [uint32]20
  return @{ ok = $true; inputTick = [uint32]$script:inputTick }
}
function Invoke-IntegratedMomentsEntry($window, $entryState, [uint32]$inputTick) {
  [uint32]$liveInputTick = [uint32](Get-SelfCheckInputTick)
  if ($inputTick -ne $liveInputTick) { return @{ ok = $false; reason = "moments_user_input_detected" } }
  $script:inputTick = [uint32]21
  return @{ ok = $true; inputTick = [uint32]$script:inputTick }
}
function Get-IntegratedDiscoverDiagnostics($entryState) { return @{} }
function Get-IntegratedMomentsEntryDiagnostics($entryState) { return @{} }
${openMomentsDecisionSource}
Open-Moments
`, {
    XIAOXI_MOMENTS_ALLOW_INTEGRATED: "1",
    XIAOXI_MOMENTS_MIN_IDLE_MS: "0"
  }, { ensure: false, timeout: 6_000 });
}

const parsePowerShell = [
  "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))",
  "$tokens=$null",
  "$errors=$null",
  "[void][System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)",
  "if($errors.Count){$errors | ForEach-Object {$_.ToString()}; exit 1}"
].join(";");
const parsedNavigation = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", parsePowerShell], {
  input: Buffer.from(MOMENTS_NAVIGATION_POWERSHELL, "utf8").toString("base64"),
  encoding: "utf8"
});
assert.equal(parsedNavigation.status, 0, parsedNavigation.stderr || parsedNavigation.stdout || "navigation PowerShell must parse");

const scrollSource = MOMENTS_NAVIGATION_POWERSHELL.slice(
  MOMENTS_NAVIGATION_POWERSHELL.indexOf("function Scroll-Moments"),
  MOMENTS_NAVIGATION_POWERSHELL.indexOf("$action = [string]$env:XIAOXI_MOMENTS_NAV_ACTION")
);
assert.ok(scrollSource, "the bounded Moments scroll flow must be extractable");
assert.match(
  scrollSource,
  /\[int\]\$_\.pid -eq \$expectedPid[\s\S]*\[int64\]\$_\.hWnd -eq \$expectedHWnd[\s\S]*\$_\.title -ceq \[string\]\$expected\.title[\s\S]*\$_\.className -ceq \[string\]\$expected\.className/u,
  "scroll must rebind the exact PID/HWND/title/class captured by the observation"
);
assert.match(
  scrollSource,
  /\[int\]\$window\.left -ne \$expectedLeft[\s\S]*\[int\]\$window\.height -ne \$expectedHeight[\s\S]*moments_window_changed/u,
  "scroll must fail closed when geometry changed after the observation"
);
assert.match(scrollSource, /\$surfaceMode -ceq "standalone"[\s\S]*\$expected\.title -cne "朋友圈"/u);
assert.match(scrollSource, /\$surfaceMode -ceq "integrated"[\s\S]*\$expected\.title -cne "微信"/u);
assert.match(scrollSource, /Get-MomentsRenderPaneEvidence \$root \$expectedPid/u);
assert.match(scrollSource, /\$paneEvidence\.pane\.runtimeId -cne \[string\]\$expected\.renderPaneRuntimeId/u);
assert.match(scrollSource, /\$scrollBounds = \$paneEvidence\.pane\.bounds/u);
assert.match(scrollSource, /if \(\$surfaceMode -ceq "integrated"\)[\s\S]*Test-IntegratedMomentsSurface/u);
assert.match(scrollSource, /\$hitRoot -ne \[IntPtr\]\$window\.hWnd -or \[int\]\$hitPid -ne \$expectedPid/u);

const paneProofIndex = scrollSource.indexOf("$paneEvidence = Get-MomentsRenderPaneEvidence");
const pageProofIndex = scrollSource.indexOf("$surfaceProof = Test-IntegratedMomentsSurface");
const ownedHitIndex = scrollSource.indexOf("$hitRoot -ne [IntPtr]$window.hWnd");
const inputGuardIndex = scrollSource.indexOf("$expectedInputTick = [Win32WechatMomentsNavigation]::GetLastInputTick()");
const stableWindowIndex = scrollSource.indexOf("Test-MomentsWindowStable $window", inputGuardIndex);
const wheelIndex = scrollSource.indexOf("GuardedWheel($x, $y, $wheelDelta, $expectedInputTick)");
assert.ok(
  paneProofIndex >= 0
  && pageProofIndex > paneProofIndex
  && ownedHitIndex > pageProofIndex
  && inputGuardIndex > ownedHitIndex
  && stableWindowIndex > inputGuardIndex
  && wheelIndex > stableWindowIndex,
  "render-pane, page, owned-hit, user-input and live-window proofs must all precede the wheel input"
);

const integratedWindow = {
  surfaceMode: "integrated",
  title: "微信",
  className: "mmui::MainWindow",
  processName: "Weixin",
  pid: 42,
  hWnd: "84",
  left: 0,
  top: 0,
  width: 1120,
  height: 760,
  rootName: "微信",
  identityMode: "visual_mmui_render",
  renderPaneName: "MMUIRenderSubWindowHW",
  renderPaneAutomationId: "",
  renderPaneControlType: "ControlType.Pane",
  renderPaneProcessId: 42,
  renderPaneRuntimeId: "42.9.render",
  renderPaneBounds: { left: 310, top: 40, width: 810, height: 720 }
};
const standaloneWindow = {
  surfaceMode: "standalone",
  title: "朋友圈",
  className: "Qt51514QWindowIcon",
  processName: "Weixin",
  pid: 42,
  hWnd: "85",
  left: 0,
  top: 0,
  width: 680,
  height: 820,
  rootName: "朋友圈",
  identityMode: "automation_id"
};

(async () => {
  const exactSurfaceRunnerCalls = [];
  const exactSurfaceRunner = async (script, env, options) => {
    exactSurfaceRunnerCalls.push({ script, env, options });
    const integrated = env.XIAOXI_WECHAT_SURFACE_MODE === "integrated";
    return {
      ok: true,
      focusOnly: true,
      inspectionOnly: false,
      normalized: true,
      layoutMode: integrated ? "stable_target" : "preserve_native_moments_popup",
      focused: true,
      surfaceMode: env.XIAOXI_WECHAT_SURFACE_MODE,
      title: env.XIAOXI_WECHAT_EXPECTED_TITLE,
      windowClass: env.XIAOXI_WECHAT_EXPECTED_CLASS,
      processName: "Weixin",
      pid: Number(env.XIAOXI_EXPECTED_PID),
      hWnd: env.XIAOXI_EXPECTED_HWND,
      x: integrated ? Number(env.XIAOXI_WECHAT_EXPECTED_X) : 0,
      y: integrated ? Number(env.XIAOXI_WECHAT_EXPECTED_Y) : 0,
      width: integrated ? Number(env.XIAOXI_WECHAT_EXPECTED_WIDTH) : 680,
      height: integrated ? Number(env.XIAOXI_WECHAT_EXPECTED_HEIGHT) : 820,
      dpi: 96
    };
  };
  const exactSurface = await focusRealWechatRpaSurfaceAsync(standaloneWindow, exactSurfaceRunner);
  assert.equal(exactSurface.ok, true);
  assert.equal(exactSurfaceRunnerCalls.length, 1);
  assert.equal(exactSurfaceRunnerCalls[0].env.XIAOXI_WECHAT_FOCUS_EXACT, "1");
  assert.equal(exactSurfaceRunnerCalls[0].env.XIAOXI_WECHAT_EXPECTED_X, String(standaloneWindow.left));
  assert.equal(exactSurfaceRunnerCalls[0].env.XIAOXI_WECHAT_EXPECTED_Y, String(standaloneWindow.top));
  assert.equal(exactSurfaceRunnerCalls[0].env.XIAOXI_WECHAT_EXPECTED_DPI, "",
    "legacy locked observations may omit DPI; focus must still prove DPI stayed unchanged during its own transaction");
  const changedGeometry = await focusRealWechatRpaSurfaceAsync(standaloneWindow, async (script, env, options) => ({
    ...(await exactSurfaceRunner(script, env, options)),
    layoutMode: "preserve_native_popup"
  }));
  assert.equal(changedGeometry.reason, "moments_window_identity_mismatch");
  const focusLost = await focusRealWechatRpaSurfaceAsync(standaloneWindow, async (script, env, options) => ({
    ...(await exactSurfaceRunner(script, env, options)),
    focused: false
  }));
  assert.equal(focusLost.ok, false);
  const integratedExactSurface = await focusRealWechatRpaSurfaceAsync(integratedWindow, exactSurfaceRunner);
  assert.equal(integratedExactSurface.ok, true);
  assert.equal(integratedExactSurface.surfaceMode, "integrated");
  assert.equal(integratedExactSurface.normalized, true);
  assert.equal(integratedExactSurface.layoutMode, "stable_target");

  const alreadyOpenFunctionStart = MOMENTS_NAVIGATION_POWERSHELL.indexOf("function Test-IntegratedMomentsAlreadyOpen");
  const alreadyOpenFunctionEnd = MOMENTS_NAVIGATION_POWERSHELL.indexOf("function Invoke-IntegratedMomentsEntry");
  assert.ok(alreadyOpenFunctionStart >= 0 && alreadyOpenFunctionEnd > alreadyOpenFunctionStart);
  const alreadyOpenProbe = await runRealPowerShellAsync(`${MOMENTS_NAVIGATION_POWERSHELL.slice(alreadyOpenFunctionStart, alreadyOpenFunctionEnd)}
@{
  ok = $true
  accepted = (Test-IntegratedMomentsAlreadyOpen @{ ok = $true; exactMatchCount = 1; entries = @(@{ selected = $true; contentBoundaryProven = $true }) })
  missingBoundary = (Test-IntegratedMomentsAlreadyOpen @{ ok = $true; exactMatchCount = 1; entries = @(@{ selected = $true; contentBoundaryProven = $false }) })
  ambiguous = (Test-IntegratedMomentsAlreadyOpen @{ ok = $true; exactMatchCount = 2; entries = @(@{ selected = $true; contentBoundaryProven = $true }, @{ selected = $true; contentBoundaryProven = $true }) })
  revealedWithoutDiscover = (Test-IntegratedMomentsEntryReadyToClick @{ ok = $true; exactMatchCount = 1; discoverExactMatchCount = 0; entries = @(@{ selected = $false; contentBoundaryProven = $false }) })
  selectedNotReadyToClick = (Test-IntegratedMomentsEntryReadyToClick @{ ok = $true; exactMatchCount = 1; discoverExactMatchCount = 0; entries = @(@{ selected = $true; contentBoundaryProven = $false }) })
  missingEntry = (Test-IntegratedMomentsEntryReadyToClick @{ ok = $true; exactMatchCount = 0; entries = @() })
  ambiguousEntry = (Test-IntegratedMomentsEntryReadyToClick @{ ok = $true; exactMatchCount = 2; entries = @(@{ selected = $false }, @{ selected = $false }) })
} | ConvertTo-Json -Compress`, {}, { ensure: false, timeout: 5_000 });
  assert.deepEqual(alreadyOpenProbe, {
    ok: true,
    accepted: true,
    missingBoundary: false,
    ambiguous: false,
    revealedWithoutDiscover: true,
    selectedNotReadyToClick: false,
    missingEntry: false,
    ambiguousEntry: false
  });

  const narrowStandalone = momentsSurfaceFixture({
    hWnd: "85",
    title: "朋友圈",
    className: "Qt51514QWindowIcon",
    left: 960,
    top: 72,
    width: 550,
    height: 720
  });
  const secondStandalone = momentsSurfaceFixture({
    hWnd: "86",
    title: "朋友圈",
    className: "Qt51514QWindowIcon",
    left: 380,
    top: 96,
    width: 540,
    height: 700
  });
  const surfaceDecisionResults = await Promise.all([
    runOpenSurfaceDecisionProbe({ standaloneWindows: [narrowStandalone], integratedProven: false }),
    runOpenSurfaceDecisionProbe({ standaloneWindows: [], integratedProven: true }),
    runOpenSurfaceDecisionProbe({ standaloneWindows: [narrowStandalone], integratedProven: true }),
    runOpenSurfaceDecisionProbe({ standaloneWindows: [narrowStandalone, secondStandalone], integratedProven: false }),
    runOpenSurfaceDecisionProbe({ standaloneWindows: [], integratedProven: true, userInputBetweenClicks: true }),
    runOpenSurfaceDecisionProbe({
      standaloneWindows: [narrowStandalone],
      integratedProven: false,
      hostChangesAfterClick: true,
      standaloneAppearsAfterIntegrated: true
    }),
    runOpenSurfaceDecisionProbe({
      standaloneWindows: [narrowStandalone],
      integratedProven: true,
      standaloneAppearsAfterIntegrated: true
    }),
    runOpenSurfaceDecisionProbe({ standaloneWindows: [], integratedProven: true, userInputAfterFinalClick: true }),
    runOpenSurfaceDecisionProbe({ standaloneWindows: [], integratedProven: true, userInputBeforeFreshObservation: true })
  ]);
  const summarizeSurfaceDecision = (result) => result?.ok === true
    ? {
        ok: true,
        surfaceMode: result.surfaceMode,
        hWnd: String(result.hWnd),
        width: result.width,
        height: result.height
      }
    : { ok: false, reason: result?.reason };
  const surfaceDecisionSummary = {
    uniqueStandalone: summarizeSurfaceDecision(surfaceDecisionResults[0]),
    originalIntegrated: summarizeSurfaceDecision(surfaceDecisionResults[1]),
    simultaneousIntegratedAndStandalone: summarizeSurfaceDecision(surfaceDecisionResults[2]),
    multipleStandalone: summarizeSurfaceDecision(surfaceDecisionResults[3]),
    userInputBetweenClicks: summarizeSurfaceDecision(surfaceDecisionResults[4]),
    changedOriginalHost: summarizeSurfaceDecision(surfaceDecisionResults[5]),
    transientIntegratedThenStandalone: summarizeSurfaceDecision(surfaceDecisionResults[6]),
    userInputAfterFinalClick: summarizeSurfaceDecision(surfaceDecisionResults[7]),
    freshObservationAfterEarlierInput: summarizeSurfaceDecision(surfaceDecisionResults[8])
  };

  const signal = new AbortController().signal;
  const integratedResult = await openWechatMoments({ allowIntegrated: true, minIdleMs: 275, signal });
  const standaloneResult = await openWechatMoments();
  await scrollWechatMomentsFeed({ expectedWindow: integratedWindow });
  await scrollWechatMomentsFeed({ expectedWindow: standaloneWindow });
  await scrollWechatMomentsFeed({ expectedWindow: integratedWindow, scrollMode: "align_partial_post" });

  assert.equal(integratedResult.ok, true);
  assert.equal(integratedResult.normalized, true);
  assert.equal(integratedResult.layoutMode, "stable_target");
  assert.equal(standaloneResult.ok, true);
  assert.equal(surfaceInspectRunners[0], powerShellRunner,
    "post-open identity verification must use the non-blocking PowerShell runner");
  assert.equal(surfaceInspectRunners[1], powerShellRunner,
    "standalone popup verification must also stay off the Electron main thread");
  assert.equal(calls.length, 5);
  assert.equal(calls[0].script, MOMENTS_NAVIGATION_POWERSHELL);
  assert.equal(calls[0].env.XIAOXI_MOMENTS_NAV_ACTION, "open");
  assert.equal(calls[0].env.XIAOXI_MOMENTS_ALLOW_INTEGRATED, "1");
  assert.equal(calls[0].env.XIAOXI_MOMENTS_MIN_IDLE_MS, "275");
  assert.strictEqual(calls[0].options.signal, signal);
  assert.equal(calls[0].options.ensure, false, "preflight owns window preparation; navigation must not pick a second window");
  assert.equal(calls[0].options.timeout, MOMENTS_NAVIGATION_OPEN_TIMEOUT_MS);
  assert.equal(calls[1].options.timeout, MOMENTS_NAVIGATION_OPEN_TIMEOUT_MS);
  assert.deepEqual(
    JSON.parse(Buffer.from(calls[0].env.XIAOXI_MOMENTS_EXPECTED_HOST_BASE64, "base64").toString("utf8")),
    { ...initialHost, surfaceMode: "integrated" },
    "navigation must receive the exact normalized host returned by preflight"
  );
  assert.equal(calls[1].env.XIAOXI_MOMENTS_ALLOW_INTEGRATED, "0", "standalone remains the default open mode");
  assert.equal(calls[2].env.XIAOXI_MOMENTS_NAV_ACTION, "scroll");
  assert.equal(calls[2].env.XIAOXI_MOMENTS_MIN_IDLE_MS, "0");
  assert.deepEqual(
    JSON.parse(Buffer.from(calls[2].env.XIAOXI_MOMENTS_EXPECTED_WINDOW_BASE64, "base64").toString("utf8")),
    integratedWindow
  );
  assert.deepEqual(
    JSON.parse(Buffer.from(calls[3].env.XIAOXI_MOMENTS_EXPECTED_WINDOW_BASE64, "base64").toString("utf8")),
    standaloneWindow,
    "the standalone observation profile must remain usable by the bounded scroll path"
  );
  assert.equal(calls[2].env.XIAOXI_MOMENTS_SCROLL_MODE, "advance_feed");
  assert.equal(calls[3].env.XIAOXI_MOMENTS_SCROLL_MODE, "advance_feed");
  assert.equal(calls[4].env.XIAOXI_MOMENTS_SCROLL_MODE, "seek_post_menu_down");
  assert.equal(calls[2].env.XIAOXI_MOMENTS_SCROLL_DELTA, "-420");
  assert.equal(calls[3].env.XIAOXI_MOMENTS_SCROLL_DELTA, "-480");
  assert.equal(calls[4].env.XIAOXI_MOMENTS_SCROLL_DELTA, "-240");
  assert.deepEqual(calls[2].options, {
    ensure: false,
    sta: true,
    timeout: 10_000,
    diagnostics: true
  });
  assert.deepEqual(prepareCalls, [
    { minIdleMs: 275, requireFocused: true, signal },
    { minIdleMs: 0, requireFocused: true, signal: undefined }
  ], "only open may arrange the window; post-observation scroll must never change geometry");
  const baselineLegacyInspectCalls = inspectCalls.slice();
  const baselineSurfaceInspectCalls = surfaceInspectCalls.slice();

  const callsBeforeIntegratedHandoff = calls.length;
  const prepareCallsBeforeIntegratedHandoff = prepareCalls.length;
  const focusCallsBeforeIntegratedHandoff = surfaceFocusCalls.length;
  const integratedHandoffWindow = { ...integratedWindow, dpi: 96 };
  const exactHandoff = await openWechatMoments({
    allowIntegrated: true,
    minIdleMs: 0,
    expectedWindow: integratedHandoffWindow
  });
  assert.equal(exactHandoff.ok, true);
  assert.equal(exactHandoff.alreadyOpen, true);
  assert.equal(exactHandoff.surfaceMode, "integrated");
  assert.equal(exactHandoff.layoutMode, "stable_target");
  assert.equal(calls.length, callsBeforeIntegratedHandoff,
    "an exact integrated handoff must not rerun navigation PowerShell");
  assert.equal(prepareCalls.length, prepareCallsBeforeIntegratedHandoff,
    "an exact integrated handoff must not normalize or resize the observed window");
  assert.equal(surfaceFocusCalls.length, focusCallsBeforeIntegratedHandoff + 1);
  assert.deepEqual(surfaceFocusCalls.at(-1), {
    ...integratedHandoffWindow,
    pid: 42,
    hWnd: "84",
    minIdleMs: 0,
    signal: undefined
  });
  const callsBeforeInvalidHandoff = calls.length;
  assert.equal((await openWechatMoments({ expectedWindow: { pid: 0, hWnd: "" } })).reason, "moments_window_identity_mismatch");
  assert.equal((await openWechatMoments({ expectedWindow: { pid: 42, hWnd: "84" } })).reason, "moments_window_identity_mismatch");
  assert.equal((await openWechatMoments({ expectedWindow: null })).reason, "moments_window_identity_mismatch");
  assert.equal((await openWechatMoments({ expectedWindow: "84" })).reason, "moments_window_identity_mismatch");
  assert.equal((await openWechatMoments({ expectedWindow: [] })).reason, "moments_window_identity_mismatch");
  assert.equal(calls.length, callsBeforeInvalidHandoff);

  const nativePopupOpened = {
    ...narrowStandalone,
    ok: true,
    action: "moments-open",
    surfaceMode: "standalone",
    alreadyOpen: false,
    entryMode: "uia_name",
    x: narrowStandalone.left,
    y: narrowStandalone.top
  };
  const nativePopupFocus = {
    ok: true,
    focusOnly: true,
    inspectionOnly: false,
    normalized: true,
    layoutMode: "preserve_native_moments_popup",
    focused: true,
    surfaceMode: "standalone",
    pid: nativePopupOpened.pid,
    hWnd: nativePopupOpened.hWnd,
    title: nativePopupOpened.title,
    windowClass: nativePopupOpened.className,
    x: 0,
    y: 0,
    width: 680,
    height: 820,
    dpi: nativePopupOpened.dpi
  };
  const prepareCallsBeforeNativePopup = prepareCalls.length;
  const focusCallsBeforeNativePopup = surfaceFocusCalls.length;
  powerShellBehavior = async (_script, env) => env.XIAOXI_MOMENTS_NAV_ACTION === "open"
    ? nativePopupOpened
    : { ok: false, reason: "self_check_boundary" };
  surfaceFocusBehavior = async () => nativePopupFocus;
  const nativePopupResult = await openWechatMoments({ allowIntegrated: true });
  const nativePopupPrepareCalls = prepareCalls.slice(prepareCallsBeforeNativePopup);
  const nativePopupFocusCalls = surfaceFocusCalls.slice(focusCallsBeforeNativePopup);
  const nativePopupSurfaceInspectCall = nativePopupFocusCalls[0]
    ? {
        expectedPid: nativePopupFocusCalls[0].pid,
        expectedHWnd: String(nativePopupFocusCalls[0].hWnd),
        expectedTitle: nativePopupFocusCalls[0].title,
        expectedWindowClass: nativePopupFocusCalls[0].windowClass,
        surfaceMode: nativePopupFocusCalls[0].surfaceMode
      }
    : null;
  powerShellBehavior = defaultPowerShellBehavior;
  surfaceFocusBehavior = defaultSurfaceFocusBehavior;

  assert.deepEqual({
    surfaceDecisions: surfaceDecisionSummary,
    inputLease: {
      passiveObservationRebases: passiveLeaseRebaseCount,
      guardedClickAdvances: guardedClickLeaseAdvanceCount
    },
    baselinePostOpenInspection: {
      legacyCallCount: baselineLegacyInspectCalls.length,
      exactSurfaceCalls: baselineSurfaceInspectCalls.map((context) => ({
        expectedPid: context.expectedPid,
        expectedHWnd: String(context.expectedHWnd),
        expectedTitle: context.expectedTitle,
        expectedWindowClass: context.expectedWindowClass,
        surfaceMode: context.surfaceMode
      }))
    },
    nativePopup: nativePopupResult?.ok === true
      ? {
          ok: true,
          surfaceMode: nativePopupResult.surfaceMode,
          hWnd: String(nativePopupResult.hWnd),
          x: nativePopupResult.x,
          y: nativePopupResult.y,
          width: nativePopupResult.width,
          height: nativePopupResult.height,
          layoutMode: nativePopupResult.layoutMode
        }
      : { ok: false, reason: nativePopupResult?.reason },
    nativePopupPrepareCalls,
    nativePopupSurfaceInspectCall
  }, {
    surfaceDecisions: {
      uniqueStandalone: { ok: true, surfaceMode: "standalone", hWnd: "85", width: 550, height: 720 },
      originalIntegrated: { ok: true, surfaceMode: "integrated", hWnd: "84", width: 1120, height: 760 },
      simultaneousIntegratedAndStandalone: { ok: true, surfaceMode: "standalone", hWnd: "85", width: 550, height: 720 },
      multipleStandalone: { ok: false, reason: "moments_window_ambiguous" },
      // This fixture changes the input lease after the exact target observation but
      // before GuardedClick. Keep rejecting that atomic stale-target boundary even
      // though input changes during the following page transition are now rebased.
      userInputBetweenClicks: { ok: false, reason: "moments_user_input_detected" },
      changedOriginalHost: { ok: false, reason: "moments_window_changed" },
      transientIntegratedThenStandalone: { ok: true, surfaceMode: "standalone", hWnd: "85", width: 550, height: 720 },
      userInputAfterFinalClick: { ok: true, surfaceMode: "integrated", hWnd: "84", width: 1120, height: 760 },
      freshObservationAfterEarlierInput: { ok: true, surfaceMode: "integrated", hWnd: "84", width: 1120, height: 760 }
    },
    inputLease: {
      passiveObservationRebases: 4,
      guardedClickAdvances: 2
    },
    baselinePostOpenInspection: {
      legacyCallCount: 0,
      exactSurfaceCalls: [
        {
          expectedPid: 42,
          expectedHWnd: "84",
          expectedTitle: "微信",
          expectedWindowClass: "mmui::MainWindow",
          surfaceMode: "integrated"
        },
        {
          expectedPid: 42,
          expectedHWnd: "84",
          expectedTitle: "微信",
          expectedWindowClass: "mmui::MainWindow",
          surfaceMode: "integrated"
        }
      ]
    },
    nativePopup: {
      ok: true,
      surfaceMode: "standalone",
      hWnd: "85",
      x: 0,
      y: 0,
      width: 680,
      height: 820,
      layoutMode: "preserve_native_moments_popup"
    },
    nativePopupPrepareCalls: [
      { minIdleMs: 0, requireFocused: true, signal: undefined }
    ],
    nativePopupSurfaceInspectCall: {
      expectedPid: 42,
      expectedHWnd: "85",
      expectedTitle: "朋友圈",
      expectedWindowClass: "Qt51514QWindowIcon",
      surfaceMode: "standalone"
    }
  }, "surface arbitration must accept either account-specific presentation, reject ambiguity, and normalize the locked popup geometry");

  const standaloneHandoffWindow = { ...standaloneWindow, dpi: 96 };
  const callsBeforeStandaloneHandoff = calls.length;
  const prepareCallsBeforeStandaloneHandoff = prepareCalls.length;
  const focusCallsBeforeStandaloneHandoff = surfaceFocusCalls.length;
  const standaloneHandoff = await openWechatMoments({
    expectedWindow: standaloneHandoffWindow,
    minIdleMs: 125
  });
  assert.equal(standaloneHandoff.ok, true);
  assert.equal(standaloneHandoff.alreadyOpen, true);
  assert.equal(standaloneHandoff.layoutMode, "preserve_native_moments_popup");
  assert.deepEqual(
    [standaloneHandoff.x, standaloneHandoff.y, standaloneHandoff.width, standaloneHandoff.height, standaloneHandoff.dpi],
    [standaloneHandoffWindow.left, standaloneHandoffWindow.top, standaloneHandoffWindow.width, standaloneHandoffWindow.height, standaloneHandoffWindow.dpi]
  );
  assert.equal(calls.length, callsBeforeStandaloneHandoff,
    "an exact standalone handoff must not rerun navigation PowerShell");
  assert.equal(prepareCalls.length, prepareCallsBeforeStandaloneHandoff,
    "an exact standalone handoff must never enter the main-window normalizer");
  assert.equal(surfaceFocusCalls.length, focusCallsBeforeStandaloneHandoff + 1);
  assert.deepEqual(surfaceFocusCalls.at(-1), {
    ...standaloneHandoffWindow,
    pid: 42,
    hWnd: "85",
    minIdleMs: 125,
    signal: undefined
  });
  assert.equal(surfaceFocusRunners.at(-1), powerShellRunner,
    "exact popup focus must run asynchronously off the Electron main thread");

  const callsBeforeWaitedScroll = calls.length;
  const waitedScroll = await scrollWechatMomentsFeed({
    expectedWindow: integratedWindow,
    minIdleMs: 15_000,
    shouldContinue: () => true
  });
  assert.equal(calls.length, callsBeforeWaitedScroll + 1);
  assert.equal(calls.at(-1).env.XIAOXI_MOMENTS_MIN_IDLE_MS, "15000");
  assert.equal(waitedScroll.reason, "self_check_boundary");

  let continueBeforeScroll = false;
  const callsBeforeCancelledScroll = calls.length;
  const cancelledScroll = await scrollWechatMomentsFeed({
    expectedWindow: integratedWindow,
    minIdleMs: 15_000,
    shouldContinue: () => continueBeforeScroll
  });
  assert.equal(cancelledScroll.reason, "moments_scroll_cancelled");
  assert.equal(calls.length, callsBeforeCancelledScroll, "a stopped campaign must not inject a wheel");

  const powerShellCallsBeforeBlockedPreflight = calls.length;
  prepareBehavior = async () => ({ ok: false, reason: "wechat_user_active" });
  const blockedPreflight = await openWechatMoments({ allowIntegrated: true, minIdleMs: 900 });
  assert.equal(blockedPreflight.reason, "wechat_user_active");
  assert.equal(calls.length, powerShellCallsBeforeBlockedPreflight, "a failed preflight must not navigate or click");

  prepareBehavior = async () => initialHost;
  inspectBehavior = async () => ({ ...initialHost, inspectionOnly: true, hWnd: "99" });
  surfaceInspectBehavior = async (context) => ({
    ...initialHost,
    inspectionOnly: true,
    surfaceMode: context.surfaceMode,
    title: context.expectedTitle,
    windowClass: context.expectedWindowClass,
    pid: context.expectedPid,
    hWnd: "99"
  });
  const changedAfterNavigation = await openWechatMoments({ allowIntegrated: true });
  assert.equal(changedAfterNavigation.reason, "moments_window_identity_mismatch");

  delete require.cache[require.resolve(navigationPath)];
  console.log("moments navigation self-check passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
