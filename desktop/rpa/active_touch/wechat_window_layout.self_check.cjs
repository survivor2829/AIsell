const assert = require("node:assert/strict");
const {
  WECHAT_RPA_WINDOW_LAYOUTS,
  resolveWechatRpaWindowTarget
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

console.log("wechat window layout self-check passed");
