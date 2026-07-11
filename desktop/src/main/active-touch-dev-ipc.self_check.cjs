const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const handlers = new Map();
const stepCalls = [];
const armCalls = [];
const sendCalls = [];
let runBehavior = async (args) => {
  stepCalls.push(args);
  return { ok: true, action: args[0] };
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  if (request === "./active-touch-ipc.cjs") return { runActiveTouchDev: (args) => runBehavior(args) };
  if (request === "../../rpa/active_touch/state_machine.dev.cjs") {
    return {
      setRealSendArm: (dataDir, enabled) => {
        armCalls.push([dataDir, enabled]);
        return { ok: true, action: "set-real-send-arm" };
      },
      sendReal: (dataDir, options) => {
        sendCalls.push([dataDir, options]);
        return { ok: true, action: "send", state: { real_send_status: "sent_verified" } };
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
  assert.deepEqual(stepCalls, [
    ["select-customer", "--id", "c1"],
    ["calibrate"],
    ["click-search-result-dry-run"],
    ["verify-real-send-session"],
    ["input-message-dry-run", "--message", "hello"],
    ["send", "--dry-run", "--message", "hello"]
  ]);
  assert.deepEqual(armCalls, [["test-data", true]]);
  assert.deepEqual(sendCalls, [["test-data", { allowRealSend: true, userConfirmed: true, message: "hello" }]]);

  stepCalls.length = 0;
  armCalls.length = 0;
  sendCalls.length = 0;
  runBehavior = async (args) => {
    stepCalls.push(args);
    return args[0] === "verify-real-send-session" ? { ok: false, blocked_reason: "session_changed" } : { ok: true };
  };
  assert.equal((await sendSelected({ sender: webContents }, { clickToken: "click-4", contactId: "c1", message: "hello" })).blocked_reason, "session_changed");
  assert.equal(armCalls.length, 0);
  assert.equal(sendCalls.length, 0);

  let releaseStep;
  runBehavior = (args) => {
    stepCalls.push(args);
    return new Promise((resolve) => { releaseStep = () => resolve({ ok: true }); });
  };
  const first = sendSelected({ sender: webContents }, { clickToken: "click-5", contactId: "c1", message: "hello" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await sendSelected({ sender: webContents }, { clickToken: "click-6", contactId: "c1", message: "hello" })).blocked_reason, "real_send_in_flight");
  releaseStep();
  runBehavior = async (args) => {
    stepCalls.push(args);
    return { ok: true };
  };
  await first;

  console.log("active-touch-dev-ipc self-check passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
