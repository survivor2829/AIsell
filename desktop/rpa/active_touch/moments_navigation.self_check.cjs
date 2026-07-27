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

console.log("moments navigation self-check passed");
