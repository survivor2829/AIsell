const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWechatWorkflowController } = require("./wechat-workflow.cjs");
const { createAiExpertStore } = require("./ai-expert.cjs");
const { EventEmitter } = require("node:events");
const { registerWechatWorkflowIpc } = require("./wechat-workflow-ipc.cjs");

async function checkFloatingProgress() {
  const windows = [];
  const diagnosticEvents = [];
  const handlers = new Map();
  const mainWindow = {
    webContents: { send() {} }, isDestroyed: () => false,
    show() {}, hide() {}, focus() {}
  };
  class ProgressWindow extends EventEmitter {
    constructor(settings) {
      super(); this.settings = settings; this.visible = false; this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), { send() {}, setWindowOpenHandler() {}, async executeJavaScript() { return true; } });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    setMenu() {}
    setPosition() {}
    async loadFile() {}
    showInactive() { this.visible = true; }
    show() { throw new Error("Progress window must not steal WeChat focus"); }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-workflow-window-"));
  const control = registerWechatWorkflowIpc({
    logger: { event: (...args) => diagnosticEvents.push(args) },
    rootDir, autoReplyDir: path.join(rootDir, "reply"), activeTouchDir: path.join(rootDir, "touch"), momentsDir: path.join(rootDir, "moments"),
    autoSchedule: false, getAccount: () => "test-account", getMainWindow: () => mainWindow,
    executors: { interact: { prepareWorkflowTask: () => ({ payload: { maxPosts: 1 } }) } },
    rendererPath: __filename, preloadPath: __filename,
    electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, BrowserWindow: ProgressWindow, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) } }
  });
  const event = { sender: mainWindow.webContents };
  await control.addTask({ type: "interact", payload: { maxPosts: 1 } });
  const invoke = (name, payload) => handlers.get(`wechat-workflow:${name}`)(event, payload);
  const refused = await invoke("start", { clickToken: "invalid" });
  assert.equal(refused.ok, false);
  assert.equal(diagnosticEvents.at(-1)[2].reason, "invalid_click");
  assert.equal(diagnosticEvents.at(-1)[2].stage, "click_validation");
  const started = await invoke("start", { clickToken: require("node:crypto").randomUUID() });
  assert.equal(started.ok, true);
  assert.equal(windows.length, 1, "starting the unified workflow must automatically create its progress window");
  assert.equal(windows[0].visible, true, "progress must be visible before queued WeChat work begins");
  assert.equal(windows[0].settings.frame, false);
  await invoke("show-main");
  assert.equal(windows[0].visible, true, "returning to the main page must retain progress while work is running");
  await invoke("pause");
  await invoke("show-main");
  assert.equal(windows[0].visible, false);
  const synced = await control.runContactSync(async () => {
    assert.equal(windows[0].visible, true, "contact synchronization also requires a visible progress window");
    return { ok: true, state: { contact_count: 3, last_stage: "synced" } };
  }, () => ({ last_stage: "waiting_login_window" }));
  assert.equal(synced.ok, true);
  const status = await invoke("status");
  assert.equal(status.state.contactSync.running, false);
  assert.equal(status.state.contactSync.contactCount, 3);
  assert.equal(windows.length, 1, "all task types reuse one floating window");
  await control.dispose();
}

async function checkWorkflowDiagnostics() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-workflow-diagnostics-"));
  const events = [];
  const logger = {
    event: (_module, name, details, metadata) => { assert.equal(metadata.trace, true); events.push({ name, ...details }); },
    begin: (_module, name, details, metadata) => {
      assert.equal(metadata.trace, true, "workflow operation traces must opt into info retention");
      events.push({ name: `${name}.started`, ...details });
      return { end: (result) => events.push({ name: `${name}.ended`, ...result }) };
    }
  };
  let replyResult = { handled: false };
  let throwReply = false;
  const control = createWechatWorkflowController({
    rootDir, autoReplyDir: path.join(rootDir, "reply"), activeTouchDir: path.join(rootDir, "touch"), momentsDir: path.join(rootDir, "moments"),
    logger, autoSchedule: false, getAccount: () => "private-account",
    reply: {
      prepareWorkflowRecipients: async () => [{ id: "private-customer", name: "private-name" }],
      runWorkflowStep: async () => { if (throwReply) throw new Error("injected failure"); return replyResult; }
    },
    executors: { touch: {
      prepareWorkflowTask: () => ({ contacts: [{ id: "private-customer" }], script: "private-script" }),
      runWorkflowStep: async () => ({ status: "needs_attention", error: "无法确认发送结果" })
    } }
  });
  await assert.rejects(control.start(), /没有待执行任务/);
  assert.equal(events.at(-1).reason, "no_pending_work");
  await control.addRecipients(["private-customer"]);
  await control.start();
  const beforeIdle = events.length;
  await control.tick(); await control.tick();
  assert.equal(events.length, beforeIdle, "ordinary empty reply polling must be quiet");
  throwReply = true;
  await assert.rejects(control.tick(), /injected failure/);
  assert.equal(events.at(-1).stage, "reply_step");
  throwReply = false;
  await control.pause();
  replyResult = { handled: false, status: "needs_attention", error: "所选联系人没有可唯一识别的会话名称" };
  await control.addTask({ type: "touch", payload: {} });
  await control.start(); await control.tick();
  assert(events.some((event) => event.name === "reply.result" && event.reason === "contact_identity_ambiguous"));
  assert(events.some((event) => event.name === "task_step.ended" && event.stage === "task_result" && event.reason === "task_needs_attention"));
  assert.equal(/private-customer|private-name|private-script|private-account/.test(JSON.stringify(events)), false, "diagnostics must not receive customer payloads");
  await control.dispose();
}

async function main() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-workflow-check-"));
  let clock = new Date(2026, 8, 2, 11, 0);
  let account = "test-account";
  let customerWaiting = false;
  const calls = [];
  let release = null;
  let held = false;
  const publishOutcomes = new Map();
  const executors = Object.fromEntries(["touch", "publish", "interact"].map((type) => [type, {
    prepareWorkflowTask: (_id, payload) => ({ ok: true, payload: { ...payload, contacts: (payload.contactIds || []).map((id) => ({ id, name: id })), maxPosts: payload.maxPosts || 1 } }),
    workflowDraft: () => ({ media: { media_kind: "images", media_count: 1, files: [{ name: "example.png" }] } }),
    workflowOutcome: (id) => publishOutcomes.get(id),
    runWorkflowStep: async (task) => {
      calls.push(task.title);
      if (task.title === "busy") return { status: "pending", progress: task.progress };
      if (held) await new Promise((resolve) => { release = resolve; });
      const progress = { done: task.progress.done + 1, total: task.progress.total };
      return { status: task.title === "unknown" ? "needs_attention" : progress.done >= progress.total ? "completed" : "pending", progress };
    }
  }]));
  const options = {
    rootDir, autoReplyDir: path.join(rootDir, "auto_reply"), activeTouchDir: path.join(rootDir, "active_touch"), momentsDir: path.join(rootDir, "moments"),
    now: () => clock, getAccount: () => account, executors, autoSchedule: false,
    reply: { runWorkflowStep: async ({ onProgress }) => {
      onProgress("正在从朋友圈返回聊天页面");
      if (customerWaiting) { calls.push("reply"); customerWaiting = false; onProgress("客户回复已发送"); return { handled: true }; }
      return { handled: false };
    } }
  };
  const control = createWechatWorkflowController(options);
  const replyOnlyRoot = path.join(rootDir, "reply-only");
  const replyOptions = { ...options, rootDir: replyOnlyRoot, autoReplyDir: path.join(replyOnlyRoot, "reply"),
    reply: { prepareWorkflowRecipients: (ids) => {
      if (!Array.isArray(ids) || ids.some((id) => id !== "selected")) throw new Error("联系人无效");
      return ids.map((id) => ({ id, name: "已选联系人", wechatAccountId: "test-account" }));
    } } };
  const replyOnly = createWechatWorkflowController(replyOptions);
  await assert.rejects(replyOnly.addRecipients(["unknown"]), /联系人无效/);
  await replyOnly.addRecipients(["selected"]);
  assert.equal(replyOnly.status().tasks.length, 0, "Reply-only setup must not invent a touch task");
  assert.equal(replyOnly.status().enabled, false, "Saving recipients must not start messaging");
  await replyOnly.dispose();
  const savedReply = createWechatWorkflowController(replyOptions);
  assert.equal(savedReply.status().recipients[0].id, "selected", "Reply recipients persist without a touch task");
  await savedReply.dispose();
  const first = await control.addTask({ type: "touch", title: "touch", payload: { contactIds: ["a", "b"], script: "hello" } });
  await control.addTask({ type: "publish", title: "future", scheduledAt: new Date(2026, 8, 2, 18).toISOString(), payload: { content: "future" } });
  await control.addTask({ type: "publish", title: "due", scheduledAt: new Date(2026, 8, 2, 10).toISOString(), payload: { content: "now" } });
  const daily = await control.addTask({ type: "interact", title: "daily", repeat: "daily", payload: { maxPosts: 1 } });
  assert.equal(control.status().enabled, false, "saving must not start WeChat");
  assert.equal(control.status().recipients.length, 2, "entire task audience enrolled before first send");
  assert.equal(control.status().tasks.find((task) => task.id === control.status().nextTaskId).title, "due", "displayed next task follows scheduler priority");
  await control.start();
  assert.equal(control.status().replyStatus, "准备接待客户");
  customerWaiting = true;
  await control.tick();
  assert.deepEqual(calls, ["reply"], "customer reply wins over due publication");
  assert.equal(control.status().replyStatus, "客户回复已发送", "workflow must forward the executor's actual progress");
  await control.tick();
  await control.tick();
  customerWaiting = true;
  await control.tick();
  await control.tick();
  await control.tick();
  assert.deepEqual(calls, ["reply", "due", "touch", "reply", "touch", "daily"]);
  await control.tick();
  assert.equal(calls.length, 6, "future work and completed daily task cannot loop");
  await assert.rejects(control.updateTask({ id: daily.task.id, type: "interact", payload: { maxPosts: 2 } }), /先暂停/);
  await control.pause();
  await control.updateTask({ id: daily.task.id, type: "interact", title: "daily", repeat: "daily", payload: { maxPosts: 2, commentGuidance: "new preference" } });
  await control.start();
  await control.tick();
  assert.equal(calls.length, 6, "editing tomorrow's daily arrangement must not repeat today's completed work");
  assert.equal(control.status().phase, "scheduled");
  await control.pause();
  await control.removeRecipient("a");
  await control.pause();
  await control.dispose();
  const restored = createWechatWorkflowController(options);
  assert.equal(restored.status().enabled, false, "restart requires explicit start");
  assert.deepEqual(restored.status().recipients.map((p) => p.id), ["b"]);
  assert.equal(restored.status().tasks.find((t) => t.id === first.task.id).status, "completed");
  account = "other-account";
  assert.equal(restored.status().recipients.length, 0, "audiences never cross accounts");
  account = "test-account";
  clock = new Date(2026, 8, 3, 11);
  await restored.start();
  assert.equal(restored.status().tasks.find((t) => t.id === daily.task.id).progress.total, 2, "tomorrow uses the edited daily target");
  await restored.tick();
  await restored.tick();
  assert.equal(restored.status().tasks.find((t) => t.title === "future").status, "missed");
  assert.equal(restored.status().tasks.find((t) => t.id === daily.task.id).lastCompletedDate, "2026-09-03");
  await restored.pause();
  await restored.cancelTask(daily.task.id);
  assert.equal(restored.status().tasks.find((t) => t.id === daily.task.id).status, "cancelled", "completed daily tasks can stop future occurrences");
  const unknown = await restored.addTask({ type: "publish", title: "unknown", payload: { content: "one" } });
  await restored.start();
  await restored.tick();
  await restored.tick();
  assert.equal(calls.filter((c) => c === "unknown").length, 1, "unknown send must never automatically retry");
  assert.equal(restored.status().tasks.find((t) => t.id === unknown.task.id).status, "needs_attention");
  publishOutcomes.set(unknown.task.id, { status: "completed", progress: { done: 1, total: 1 } });
  restored.refresh();
  assert.equal(restored.status().tasks.find((t) => t.id === unknown.task.id).status, "completed", "manual verified publication updates the plan without resending");
  await restored.pause();
  await restored.addTask({ type: "touch", title: "held", payload: { contactIds: ["c", "d"], script: "hello" } });
  await restored.start();
  held = true;
  const step = restored.tick();
  while (!release) await Promise.resolve();
  const pause = restored.pause();
  assert.equal(restored.status().phase, "pausing");
  release(); held = false;
  await Promise.all([step, pause]);
  assert.equal(restored.status().enabled, false);
  assert.equal(restored.status().tasks.find((t) => t.title === "held").progress.done, 1);
  await restored.start(); await restored.tick();
  assert.equal(restored.status().tasks.find((t) => t.title === "held").status, "completed");
  await restored.pause();
  const busy = await restored.addTask({ type: "publish", title: "busy", scheduledAt: clock.toISOString(), payload: { content: "busy" } });
  await restored.start();
  await restored.tick();
  clock = new Date(2026, 8, 4, 11);
  restored.refresh();
  assert.equal(restored.status().tasks.find((t) => t.id === busy.task.id).status, "missed", "busy preflight cannot count as execution across dates");
  await restored.dispose();

  const batchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-workflow-batch-"));
  const batch = createWechatWorkflowController({ ...options, rootDir: batchRoot, autoReplyDir: path.join(batchRoot, "reply") });
  await assert.rejects(batch.start(), /没有待执行任务/);
  assert.equal(batch.status().enabled, false, "empty plans cannot appear to start");
  await batch.setReplyEnabled(false);
  await batch.addTask({ type: "touch", title: "batch", payload: { contactIds: ["a"], script: "test" } });
  await batch.start(); await batch.tick();
  assert.equal(batch.status().phase, "completed");
  assert.equal(batch.status().enabled, false, "completed finite work releases the computer");
  await batch.addTask({ type: "publish", title: "unknown", payload: { content: "test" } });
  await batch.start(); await batch.tick();
  assert.equal(batch.status().phase, "needs_attention", "unfinished work must not look completed or idle");
  await batch.dispose();

  const retryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-workflow-retry-"));
  let retryAllowed = true;
  const retryOptions = { ...options, rootDir: retryRoot, autoReplyDir: path.join(retryRoot, "reply"),
    executors: { interact: {
      prepareWorkflowTask: () => ({ payload: { maxPosts: 2 } }),
      runWorkflowStep: async () => ({ status: "needs_attention", error: "preflight_failed", progress: { done: 0, total: 2, liked: 0 } }),
      canRetryWorkflowTask: () => retryAllowed
    } }
  };
  const retry = createWechatWorkflowController(retryOptions);
  await retry.setReplyEnabled(false);
  const retryTask = await retry.addTask({ type: "interact", payload: { maxPosts: 2 } });
  await retry.start(); await retry.tick();
  await assert.rejects(retry.start(), /没有待执行任务/);
  await retry.dispose();
  const retryRestored = createWechatWorkflowController(retryOptions);
  assert.equal(retryRestored.status().lastTaskId, retryTask.task.id, "restart restores the displayed task");
  assert.equal(retryRestored.status().tasks[0].progress.liked, 0);
  retryAllowed = false;
  await assert.rejects(retryRestored.retryTask(retryTask.task.id), /不能直接重试/);
  retryAllowed = true;
  await retryRestored.retryTask(retryTask.task.id);
  assert.equal(retryRestored.status().tasks[0].status, "pending");
  assert.equal(retryRestored.status().enabled, false, "requeue needs a separate explicit start");
  await retryRestored.dispose();

  const expert = createAiExpertStore({ rootDir });
  expert.save({ expertRules: "回答简洁，不编造", businessKnowledge: "提供设备维护" });
  const before = expert.read();
  expert.saveConversation({ messages: [{ role: "user", content: "补充资料" }], expertRules: "新草稿", businessKnowledge: "新草稿" });
  assert.deepEqual(expert.read(), before, "interview drafts cannot silently replace live expert");
  assert.equal(expert.conversation().messages.length, 1);
  await checkFloatingProgress();
  await checkWorkflowDiagnostics();
  const traceRoot = path.join(rootDir, "waiting-diagnostics");
  const traceLogger = require("./diagnostics.cjs").createDiagnosticLogger({ rootDir: traceRoot });
  let waitingForNextStep = true;
  const waitingControl = createWechatWorkflowController({ ...options,
    rootDir: traceRoot, autoReplyDir: path.join(traceRoot, "reply"), logger: traceLogger,
    executors: { interact: {
      prepareWorkflowTask: () => ({ payload: { maxPosts: 1 } }),
      runWorkflowStep: async () => ({ status: waitingForNextStep ? "pending" : "completed",
        progress: { done: waitingForNextStep ? 0 : 1, total: 1 } })
    } }
  });
  await waitingControl.setReplyEnabled(false);
  await waitingControl.addTask({ type: "interact", payload: { maxPosts: 1 } });
  await waitingControl.start(); await waitingControl.tick();
  const waitingTraceCount = traceLogger.readRecent(100).length;
  await waitingControl.tick(); await waitingControl.tick();
  assert.equal(traceLogger.readRecent(100).length, waitingTraceCount, "Unchanged pending tasks must not flood diagnostic history");
  waitingForNextStep = false;
  await waitingControl.tick();
  assert.equal(traceLogger.readRecent(100).some(entry => entry.event === "task_step.finished" && entry.details.status === "completed"), true,
    "Changed results must be retained even when their repeated begin was quiet");
  await waitingControl.dispose();
  process.stdout.write("Workflow checks passed: priority, continuation, daily reset, restart, audience, unknown result, pause, expert drafts.\n");
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
