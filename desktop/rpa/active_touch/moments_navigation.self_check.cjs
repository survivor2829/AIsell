const assert = require("node:assert/strict");

const {
  MOMENTS_NAVIGATION_POWERSHELL,
  openWechatMoments,
  scrollWechatMomentsFeed
} = require("./moments_navigation.dev.cjs");

assert.equal(typeof openWechatMoments, "function");
assert.equal(typeof scrollWechatMomentsFeed, "function");
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /NameProperty,\s*"朋友圈"/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /GetAncestor\(\[Win32WechatMomentsNavigation\]::WindowFromPoint\(\$point\), 2\)/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /if \(\$hitRoot -ne \[IntPtr\]\$window\.hWnd\)/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /mouse_event\(0x0800, 0, 0, -540/u);
assert.match(MOMENTS_NAVIGATION_POWERSHELL, /moments_window_open_timeout/u);
assert.doesNotMatch(MOMENTS_NAVIGATION_POWERSHELL, /SendKeys/u);
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

console.log("moments navigation self-check passed");
