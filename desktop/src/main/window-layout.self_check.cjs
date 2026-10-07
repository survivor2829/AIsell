const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { windowLayout, keepWindowInWorkArea } = require("./window-layout.cjs");

function assertFits(bounds, area) {
  assert.ok(bounds.x >= area.x && bounds.y >= area.y);
  assert.ok(bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y + bounds.height <= area.y + area.height);
  assert.ok(bounds.minWidth <= area.width && bounds.minHeight <= area.height);
}

for (const area of [
  { x: 0, y: 0, width: 1366, height: 728 },
  { x: 0, y: 0, width: 1280, height: 680 },
  { x: -1536, y: 32, width: 1536, height: 792 }
]) {
  assertFits(windowLayout(area), area);
  assertFits(windowLayout(area, { x: 4000, y: -500, width: 1440, height: 900 }), area);
}

const screen = new EventEmitter();
let workArea = { x: 0, y: 0, width: 1920, height: 1040 };
screen.getDisplayMatching = () => ({ workArea });
const window = new EventEmitter();
let bounds = { x: 250, y: 80, width: 1440, height: 900 }, minimum = [1180, 760];
let maximized = false, writes = 0;
Object.assign(window, {
  isDestroyed: () => false, isMinimized: () => false, isMaximized: () => maximized,
  isFullScreen: () => false, getBounds: () => ({ ...bounds }), getMinimumSize: () => minimum,
  setMinimumSize: (width, height) => { minimum = [width, height]; },
  setBounds: (next) => { writes++; bounds = next; window.emit("moved"); window.emit("resized"); }
});
keepWindowInWorkArea(window, screen);
window.emit("moved");
assert.equal(writes, 0, "A valid window must not jump after normal movement.");
workArea = { x: -1280, y: 0, width: 1280, height: 680 };
maximized = true;
screen.emit("display-metrics-changed");
assert.equal(writes, 0, "The OS keeps control of maximized bounds.");
assert.deepEqual(minimum, [1180, 680]);
maximized = false;
window.emit("unmaximize");
assertFits({ ...bounds, minWidth: minimum[0], minHeight: minimum[1] }, workArea);
assert.equal(writes, 1, "Bounds callbacks must not produce an update loop.");
screen.emit("display-metrics-changed");
assert.equal(writes, 1, "Unchanged metrics must not rewrite bounds.");
window.emit("closed");
assert.equal(screen.listenerCount("display-metrics-changed"), 0);
assert.equal(screen.listenerCount("display-removed"), 0);
console.log("window layout self-check passed: small/scaled displays, negative origins, restore, no move loop, listener cleanup");
