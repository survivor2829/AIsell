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
console.log("sprite floor self-check passed");
