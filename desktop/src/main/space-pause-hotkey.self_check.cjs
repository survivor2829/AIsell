// Double press of the space bar pauses 微信拓客: what counts as a double press, and the hook process
// lifecycle (one at a time, stopped with the run, no restart storm when it cannot start).
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createDoubleTapDetector, createSpacePauseHotkey, HOOK_CSHARP } = require("./space-pause-hotkey.cjs");

// Two bare presses within 450 ms.
let detect = createDoubleTapDetector();
assert.equal(detect("d 1000"), false);
assert.equal(detect("d 1300"), true);
// A third press right after is a new count, not a second pause.
assert.equal(detect("d 1500"), false);
// Too slow.
detect = createDoubleTapDetector();
assert.equal(detect("d 1000"), false);
assert.equal(detect("d 1451"), false);
assert.equal(detect("d 1700"), true, "the slow second press starts the next pair");
// Typing "a b c": another key between the spaces cancels.
detect = createDoubleTapDetector();
assert.equal(detect("d 1000"), false);
assert.equal(detect("o 1100"), false);
assert.equal(detect("d 1200"), false);
// Ctrl+Space / Shift+Space (input method switches) come as "o" and never count.
detect = createDoubleTapDetector();
assert.equal(detect("o 1000"), false);
assert.equal(detect("o 1100"), false);
// Tick counter wrap and junk lines.
detect = createDoubleTapDetector();
assert.equal(detect("d 4294967200"), false);
assert.equal(detect("d 100"), false);
assert.equal(detect("ready"), false);
assert.equal(detect("d x"), false);

// The hook ignores injected keys (the automation's own), only reads the space bar and swallows it
// only while WeChat is in front.
assert.match(HOOK_CSHARP, /\(flags & 0x10u\) == 0/u);
assert.match(HOOK_CSHARP, /if \(swallow && WechatInFront\(\)\) return new IntPtr\(1\);/u);
assert.doesNotMatch(HOOK_CSHARP, /Post\([^)]*vk/u, "no key code ever leaves the hook");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.exitCode = null;
  child.written = [];
  child.stdin = { write(text) { child.written.push(text); }, end() { child.exitCode = 0; child.emit("exit", 0); } };
  child.kill = () => { child.exitCode = 1; child.emit("exit", 1); };
  return child;
}

let clock = 1_000_000;
const spawned = [];
const events = [];
let taps = 0;
const hotkey = createSpacePauseHotkey({
  platform: "win32",
  now: () => clock,
  spawnProcess: (file, args, options) => { const child = fakeChild(); spawned.push({ file, args, options, child }); return child; },
  onEvent: (event, details) => events.push({ event, ...details }),
  onDoubleTap: () => { taps += 1; }
});
assert.equal(hotkey.start(), true);
assert.equal(hotkey.start(), false, "one hook at a time");
assert.equal(spawned.length, 1);
assert.equal(spawned[0].file, "powershell.exe");
assert.equal(spawned[0].options.windowsHide, true);
spawned[0].child.stdout.emit("data", "ready\r\nd 10");
spawned[0].child.stdout.emit("data", "00\r\nd 1200\r\n");
assert.equal(taps, 1, "lines split across chunks still count");
// Spaces in WeChat are held back only while a step runs; the setting reaches the hook once it is up
// and on every change.
assert.deepEqual(spawned[0].child.written, ["s0\n"]);
assert.equal(hotkey.ready(), true);
hotkey.setSwallow(true);
hotkey.setSwallow(true);
hotkey.setSwallow(false);
assert.deepEqual(spawned[0].child.written, ["s0\n", "s1\n", "s0\n"]);
assert.deepEqual(events[0], { event: "ready" });

// Stopped with the run: the pipe closes, nothing reported as a failure, it can start again at once.
hotkey.stop();
assert.equal(hotkey.running(), false);
assert.equal(spawned[0].child.exitCode, 0);
assert.ok(!events.some((item) => item.event === "unavailable"));
spawned[0].child.stdout.emit("data", "d 2000\r\nd 2100\r\n");
assert.equal(taps, 1, "a stopped hook never pauses");
assert.equal(hotkey.start(), true);

// Gone on its own: reported, and not restarted on every state update for a minute.
spawned[1].child.emit("exit", 5);
assert.deepEqual(events.at(-1), { event: "unavailable", kind: "exited_5" });
assert.equal(hotkey.start(), false);
clock += 60_001;
assert.equal(hotkey.start(), true);
spawned[2].child.stdout.emit("data", "failed 5\r\n");
assert.deepEqual(events.at(-1), { event: "unavailable", kind: "hook_failed", win_error: 5 });
assert.equal(hotkey.running(), false);

// Elsewhere than Windows nothing starts.
assert.equal(createSpacePauseHotkey({ platform: "linux", spawnProcess: () => { throw new Error("no"); } }).start(), false);

console.log("space pause hotkey checks passed");
