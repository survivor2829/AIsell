// The input-method guard: switches once when the app starts operating WeChat, remembers "already
// English" so the 750 ms refresh never respawns PowerShell, restores exactly what it changed, and a
// failed switch is retried at most once a minute (the run never waits on it).
const assert = require("node:assert/strict");
const { createWechatInputMethodGuard, SWITCH_SCRIPT, RESTORE_SCRIPT } = require("./wechat_input_method.cjs");

(async () => {
  const calls = [], logs = [];
  let answer = { ok: true, changed: true, hWnd: 11, previous: 0x08040804, us: 0x04090409, loaded: true };
  const run = async (script, env) => { calls.push({ kind: script === SWITCH_SCRIPT ? "switch" : script === RESTORE_SCRIPT ? "restore" : "other", env }); return script === SWITCH_SCRIPT ? answer : { ok: true, restored: true, unloaded: true }; };
  const guard = createWechatInputMethodGuard({ run, log: (name) => logs.push(name) });

  await guard.sync(true); await guard.sync(true); await guard.sync(true);
  assert.deepEqual(calls.map((call) => call.kind), ["switch"], "switches once while active");
  await guard.sync(false);
  assert.deepEqual(calls.map((call) => call.kind), ["switch", "restore"], "restores when the app stops operating WeChat");
  assert.deepEqual(calls[1].env, { XIAOXI_IME_HWND: "11", XIAOXI_IME_PREVIOUS: String(0x08040804), XIAOXI_IME_US: String(0x04090409), XIAOXI_IME_LOADED: "1" },
    "restore puts back the recorded layout and unloads the one it loaded");
  await guard.sync(false);
  assert.equal(calls.length, 2, "nothing more to restore");

  calls.length = 0; answer = { ok: true, changed: false, hWnd: 11, previous: 0x04090409 };
  await guard.sync(true); await guard.sync(true); await guard.sync(false);
  assert.deepEqual(calls.map((call) => call.kind), ["switch"], "already English: asked once, nothing to restore");

  calls.length = 0; answer = { ok: false, reason: "us_layout_unavailable" };
  const failing = createWechatInputMethodGuard({ run, log: (name) => logs.push(name) });
  await failing.sync(true); await failing.sync(false); await failing.sync(true);
  assert.deepEqual(calls.map((call) => call.kind), ["switch"], "a failed switch waits a minute before trying again and has nothing to restore");
  assert.ok(logs.includes("input_method.switch_failed"), "the failure is logged");

  const throwing = createWechatInputMethodGuard({ run: async () => { throw Object.assign(Error("boom"), { code: "powershell_timeout" }); } });
  await throwing.sync(true);
  assert.equal(throwing.state().switched, false, "a runner error never breaks the run");

  assert.match(SWITCH_SCRIPT, /0x0050/u, "the switch is WeChat's own WM_INPUTLANGCHANGEREQUEST");
  assert.match(RESTORE_SCRIPT, /GetKeyboardLayout\(\$thread\) -eq \[int64\]\$us/u, "a layout the customer picked meanwhile is left alone");
  console.log("wechat input method guard self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });
