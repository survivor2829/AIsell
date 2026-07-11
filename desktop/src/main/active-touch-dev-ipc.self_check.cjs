const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const handlers = new Map();
const stepCalls = [];
const armCalls = [];
const executeCalls = [];
let runBehavior = async (args) => {
  stepCalls.push(args);
  return { ok: true, action: args[0] };
};
let executeBehavior = async (options) => {
  executeCalls.push(options);
  return { ok: true, action: "send", state: { real_send_status: "sent_verified" } };
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  if (request === "./active-touch-ipc.cjs") return { runActiveTouchDev: (args) => runBehavior(args) };
  if (request === "../../rpa/active_touch/state_machine.dev.cjs") {
    return {
      executeVerifiedContactSend: (options) => executeBehavior(options),
      setRealSendArm: (dataDir, enabled) => {
        armCalls.push([dataDir, enabled]);
        return { ok: true, action: "set-real-send-arm" };
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const modulePath = path.join(__dirname, "active-touch-dev-ipc.cjs");
delete require.cache[require.resolve(modulePath)];
const { registerActiveTouchDevIpc } = require(modulePath);
Module._load = originalLoad;

const webContents = { id: 7 };
let focused = true;
const mainWindow = { webContents, isDestroyed: () => false, isFocused: () => focused };
registerActiveTouchDevIpc({ dataDir: "test-data", getMainWindow: () => mainWindow });
const sendSelected = handlers.get("active-touch:send-selected-contact");

(async () => {
  assert.equal((await sendSelected({ sender: webContents }, { clickToken: "", contactId: "c1", message: "hello" })).blocked_reason, "trusted_user_click_required");
  focused = false;
  assert.equal((await sendSelected({ sender: webContents }, { clickToken: "click-1", contactId: "c1", message: "hello" })).blocked_reason, "trusted_user_click_required");
  focused = true;
  assert.equal((await sendSelected({ sender: webContents }, { clickToken: "click-2", contactId: "", message: "hello" })).blocked_reason, "contact_or_message_missing");

  const result = await sendSelected({ sender: webContents }, { clickToken: "click-3", contactId: "c1", message: " hello " });
  assert.equal(result.ok, true);
  assert.equal(executeCalls.length, 1);
  assert.equal(executeCalls[0].baseDir, "test-data");
  assert.equal(executeCalls[0].contactId, "c1");
  assert.equal(executeCalls[0].message, "hello");
  assert.equal(executeCalls[0].authorized, true);
  assert.equal(typeof executeCalls[0].runStep, "function");
  await executeCalls[0].runStep("calibrate", []);
  assert.deepEqual(stepCalls, [["calibrate"]]);
  assert.equal(armCalls.length, 0);

  stepCalls.length = 0;
  armCalls.length = 0;
  executeCalls.length = 0;
  executeBehavior = async (options) => {
    executeCalls.push(options);
    return { ok: false, blocked_reason: "session_changed" };
  };
  assert.equal((await sendSelected({ sender: webContents }, { clickToken: "click-4", contactId: "c1", message: "hello" })).blocked_reason, "session_changed");
  assert.equal(armCalls.length, 0);
  assert.equal(executeCalls.length, 1);

  let releaseSend;
  executeBehavior = (options) => {
    executeCalls.push(options);
    return new Promise((resolve) => { releaseSend = () => resolve({ ok: true }); });
  };
  const first = sendSelected({ sender: webContents }, { clickToken: "click-5", contactId: "c1", message: "hello" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await sendSelected({ sender: webContents }, { clickToken: "click-6", contactId: "c1", message: "hello" })).blocked_reason, "real_send_in_flight");
  releaseSend();
  await first;

  console.log("active-touch-dev-ipc self-check passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
