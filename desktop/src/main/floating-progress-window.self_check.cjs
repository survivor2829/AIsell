const assert = require("node:assert/strict");
const { SPRITE_WINDOW, SPRITE_FLOOR_GAP, spriteGround, spritePosition } = require("./floating-progress-window.cjs");

const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
// A visible 48 px taskbar at the bottom: 小玺 stands right on top of it.
const withTaskbar = { bounds, workArea: { x: 0, y: 0, width: 1920, height: 1032 } };
assert.equal(spriteGround(withTaskbar) + SPRITE_WINDOW.height, 1032);
// An auto-hidden or misreported taskbar (customer PC 2026-11-09): the work area is the whole screen, so the
// place the taskbar pops up stays clear.
const hidden = { bounds, workArea: { ...bounds } };
assert.equal(spriteGround(hidden) + SPRITE_WINDOW.height, 1080 - SPRITE_FLOOR_GAP);
// A tall taskbar keeps the work area as the floor; a second screen above the first works the same way.
assert.equal(spriteGround({ bounds, workArea: { x: 0, y: 0, width: 1920, height: 980 } }) + SPRITE_WINDOW.height, 980);
assert.equal(spriteGround({ bounds: { x: 0, y: -900, width: 1600, height: 900 }, workArea: { x: 0, y: -900, width: 1600, height: 900 } }), -SPRITE_FLOOR_GAP - SPRITE_WINDOW.height);
// Older callers pass only a work area.
assert.equal(spriteGround({ x: 0, y: 0, width: 1920, height: 1032 }), 1032 - SPRITE_WINDOW.height);
// A tiny screen never puts 小玺 above the top edge.
assert.equal(spriteGround({ bounds: { x: 0, y: 0, width: 800, height: 300 }, workArea: { x: 0, y: 0, width: 800, height: 300 } }), 0);
assert.deepEqual(spritePosition(hidden, { x: 5000 }), { x: 1920 - SPRITE_WINDOW.width - SPRITE_WINDOW.rightGap, y: spriteGround(hidden) }, "a saved place off this screen is not used");
assert.equal(spritePosition(withTaskbar, { x: 300 }).x, 300);
// During a task 小玺 lets the pointer through where WeChat is put: the work area's top-left 1120×760, or the
// whole work area on a small screen (a 225% laptop, 1120×720 logical: WeChat filled it, 小玺 stood on its input box).
{
  const { insideWechatAutomationArea: inside } = require("./floating-progress-window.cjs");
  const wechat = { width: 1120, height: 760 };
  const big = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }], small = [{ workArea: { x: 0, y: 0, width: 1120, height: 720 } }];
  assert.equal(inside({ x: 728, y: 684 }, small, wechat), true, "the input box of a full-screen WeChat (5a711219)");
  assert.equal(inside({ x: 1500, y: 900 }, big, wechat), false, "beside WeChat on a big screen 小玺 stays clickable");
  assert.equal(inside({ x: 1119, y: 759 }, big, wechat), true);
  assert.equal(inside({ x: 1120, y: 100 }, big, wechat), false);
  assert.equal(inside({ x: 2000, y: 100 }, [...big, { workArea: { x: 1920, y: 0, width: 1920, height: 1040 } }], wechat), true, "WeChat may be on another screen");
  assert.equal(inside({ x: 10, y: 10 }, [], wechat), false);
}
console.log("sprite floor self-check passed");
