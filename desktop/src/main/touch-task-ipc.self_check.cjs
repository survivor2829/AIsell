const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const handlers = new Map();
const windows = [];
class FakeWindow {
  constructor() {
    this.destroyed = false;
    this.webContents = { send() {} };
    windows.push(this);
  }
  isDestroyed() { return this.destroyed; }
  show() {}
  hide() {}
  focus() {}
  setMenu() {}
  setPosition() {}
  on() {}
  loadFile() {}
  loadURL() {}
  close() { this.destroyed = true; }
}
FakeWindow.getAllWindows = () => windows;

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => os.tmpdir() },
      BrowserWindow: FakeWindow,
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 900 } }) }
    };
  }
  if (request === "./ai-draft.cjs") {
    return {
      generatePersonalizedDraft: async ({ result }) => {
        if (result.id === "wxid_batch_2") throw new Error("single-ai-failure");
        return { message: `您好 ${result.name}`, usedAi: true, reason: "" };
      }
    };
  }
  if (request === "./active-touch-ipc.cjs") {
    return {
      runActiveTouch: async (args) => ({
        ok: true,
        action: args[0],
        state: args[0] === "select-customer" ? { selected_customer: currentFrozenContact } : {}
      })
    };
  }
  if (request === "./edition.cjs") return { preloadFile: "preload.cjs", rendererDir: "dist" };
  return originalLoad.call(this, request, parent, isMain);
};

let currentFrozenContact = null;
const modulePath = path.join(__dirname, "touch-task-ipc.cjs");
delete require.cache[require.resolve(modulePath)];
const { registerTouchTaskIpc } = require(modulePath);
Module._load = originalLoad;

function contacts(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `wxid_batch_${index + 1}`,
    name: `批次客户${index + 1}`,
    remark: `批次客户${index + 1}`,
    nickname: `昵称${index + 1}`,
    wxid: `wxid_batch_${index + 1}`,
    wechatId: `batch-${index + 1}`,
    wechatAccountId: "account-a",
    syncedAt: "2026-07-11T00:00:00.000Z",
    allowed: true
  }));
}

async function waitFor(read, predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for task state");
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-touch-task-ipc-"));
  try {
    fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify(contacts(51)), "utf8");
    let sends = 0;
    let executorBehavior = async (options) => {
      sends += 1;
      currentFrozenContact = options.frozenContact;
      options.onTransition("prepared", { real_send_attempt_key: `attempt-${options.contactId}` });
      options.onTransition("clicked", { real_send_attempt_key: `attempt-${options.contactId}` });
      options.onTransition("sent_verified", { real_send_attempt_key: `attempt-${options.contactId}` });
      return { ok: true, state: { real_send_status: "sent_verified", real_send_attempt_key: `attempt-${options.contactId}` } };
    };
    registerTouchTaskIpc({
      getMainWindow: () => ({ isDestroyed: () => false, hide() {}, show() {}, focus() {} }),
      dataDir: dir,
      coordinator: {
        acquire: () => ({ ok: true, lock: { owner: "runner" } }),
        update: () => ({ ok: true }),
        transition: () => ({ ok: true }),
        release: () => ({ ok: true })
      },
      deepSeekClient: { assertAvailable() {} },
      executionMode: "real_send",
      waitForDelay: async () => {},
      realSendExecutor: (options) => executorBehavior(options)
    });

    const start = handlers.get("touch-task:start");
    const status = handlers.get("touch-task:status");
    const resume = handlers.get("touch-task:resume");
    const stop = handlers.get("touch-task:stop");
    await start({}, { script: "默认触达话术", clickToken: "trusted-start" });
    assert.equal((await start({}, { script: "默认触达话术", clickToken: "trusted-start" })).blocked_reason, "trusted_batch_click_required");
    const firstBatch = await waitFor(status, (value) => value.task?.phase === "awaiting_batch_continue");
    assert.equal(firstBatch.task.version, 3);
    assert.equal(firstBatch.task.execution_mode, "real_send");
    assert.equal(firstBatch.task.current_index, 50);
    assert.equal(firstBatch.task.results[1].status, "ai_failed_skipped");
    assert.equal(sends, 49);

    await resume({}, { clickToken: "trusted-continue" });
    const completed = await waitFor(status, (value) => value.task?.status === "completed");
    assert.equal(completed.task.current_index, 51);
    assert.equal(sends, 50);
    assert.equal(completed.task.results.filter((result) => result.status === "sent_verified").length, 50);

    fs.writeFileSync(path.join(dir, "contacts.json"), JSON.stringify(contacts(1)), "utf8");
    executorBehavior = async (options) => {
      sends += 1;
      options.onTransition("prepared", { real_send_attempt_key: "unknown-attempt" });
      options.onTransition("clicked", { real_send_attempt_key: "unknown-attempt" });
      options.onTransition("outcome_unknown", { real_send_attempt_key: "unknown-attempt" });
      return { ok: false, blocked_reason: "outcome_unknown", state: { real_send_status: "outcome_unknown", real_send_attempt_key: "unknown-attempt" } };
    };
    await start({}, { script: "未知结果测试", clickToken: "trusted-unknown" });
    const unknown = await waitFor(status, (value) => value.task?.results?.[0]?.status === "outcome_unknown");
    assert.equal(unknown.task.status, "paused");
    const sendsAfterUnknown = sends;
    await resume({}, { clickToken: "trusted-no-retry" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sends, sendsAfterUnknown);

    stop();
    let releaseSend;
    executorBehavior = (options) => {
      sends += 1;
      return new Promise((resolve) => {
        releaseSend = () => {
          options.onTransition("prepared", { real_send_attempt_key: "double-attempt" });
          options.onTransition("clicked", { real_send_attempt_key: "double-attempt" });
          options.onTransition("sent_verified", { real_send_attempt_key: "double-attempt" });
          resolve({ ok: true, state: { real_send_status: "sent_verified", real_send_attempt_key: "double-attempt" } });
        };
      });
    };
    await start({}, { script: "连续点击测试", clickToken: "trusted-double-1" });
    await waitFor(() => Promise.resolve(sends), (value) => value === sendsAfterUnknown + 1);
    await start({}, { script: "连续点击测试", clickToken: "trusted-double-2" });
    assert.equal(sends, sendsAfterUnknown + 1);
    releaseSend();
    await waitFor(status, (value) => value.task?.status === "completed");
    console.log("touch-task-ipc self-check passed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
