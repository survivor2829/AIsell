const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-file.cjs");

const TASK_TYPES = new Set(["touch", "publish", "interact"]);
const TITLES = { touch: "精准触达", publish: "发布朋友圈", interact: "朋友圈互动" };

function localDate(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error("计划资料无法读取，请保留数据并查看日志诊断。");
  }
}

function createWechatWorkflowController(options) {
  const now = options.now || (() => new Date());
  const executors = options.executors || {};
  const stateFile = path.join(options.rootDir, "wechat_workflow", "state.json");
  const recipientsFile = path.join(options.autoReplyDir, "workflow-recipients.json");
  const directories = { touch: options.activeTouchDir, publish: options.momentsDir, interact: options.momentsDir };
  let store = { version: 1, tasks: [] };
  let recipients = { version: 1, accounts: {} };
  let enabled = false;
  let phase = "paused";
  let currentTaskId = null;
  let lastTaskId = null;
  let error = "";
  let replyStatus = "尚未启动";
  let replyError = "";
  let loadError = "";
  let timer = null;
  let inFlight = null;
  let disposed = false;
  let mutation = Promise.resolve();
  let mutating = false;
  let revision = 0;
  const getAccount = () => String(options.getAccount?.() || "");
  const emit = () => { revision += 1; options.onUpdate?.(status()); };

  try {
    store = readJson(stateFile, store);
    recipients = readJson(recipientsFile, recipients);
    if (store.version !== 1 || !Array.isArray(store.tasks) || recipients.version !== 1 || !recipients.accounts) {
      throw new Error("计划数据版本无法识别，请保留数据并查看日志诊断。");
    }
    for (const task of store.tasks) {
      if (!TASK_TYPES.has(task.type) || !/^[a-f0-9-]{36}$/.test(task.id)) throw new Error("计划数据格式异常，请查看日志诊断。");
      if (task.status === "running") task.status = task.cancelRequested ? "cancelled" : "pending";
    }
    lastTaskId = store.tasks.find((task) => task.id === store.lastTaskId)?.id
      || [...store.tasks].reverse().find((task) => ["completed", "needs_attention"].includes(task.status))?.id || null;
  } catch (failure) {
    loadError = failure.message;
    error = loadError;
  }

  function assertHealthy() { if (loadError) throw new Error(loadError); }
  function persist() { assertHealthy(); store.lastTaskId = lastTaskId; writeJsonAtomic(stateFile, store); }
  function canRetry(task) {
    if (task.status !== "needs_attention" || task.accountName !== getAccount()) return false;
    try { return executors[task.type]?.canRetryWorkflowTask?.(task) === true; }
    catch { return false; }
  }
  function taskPath(task) { return path.join(directories[task.type], "planned_tasks", `${task.id}.json`); }
  function readPayload(task) {
    const saved = readJson(taskPath(task), null);
    if (!saved || saved.id !== task.id || !saved.payload) throw new Error("任务资料缺失，请重新编辑并加入计划。");
    return saved.payload;
  }
  function writePayload(task, payload) { writeJsonAtomic(taskPath(task), { id: task.id, type: task.type, payload }); }
  function accountRecipients() { return recipients.accounts[getAccount()] || []; }

  function status() {
    return {
      enabled, phase, currentTaskId, lastTaskId, replyEnabled: store.replyEnabled !== false,
      nextTaskId: nextTask()?.id || null, error, replyStatus, replyError, revision,
      tasks: store.tasks.map((task) => ({ ...task, canRetry: canRetry(task), accountMismatch: Boolean(task.accountName && task.accountName !== getAccount()) })),
      recipients: accountRecipients().map((contact) => ({ id: contact.id, label: contact.remark || contact.nickname || contact.name || contact.id }))
    };
  }

  function enroll(task, payload) {
    if (task.type !== "touch" || task.enrolled) return;
    const existing = new Map((recipients.accounts[task.accountName] || []).map((contact) => [contact.id, contact]));
    for (const contact of payload.contacts || []) existing.set(contact.id, contact);
    const next = { ...recipients, accounts: { ...recipients.accounts, [task.accountName]: [...existing.values()] } };
    writeJsonAtomic(recipientsFile, next);
    recipients = next;
    task.enrolled = true;
    persist();
  }

  function schedule(delay = options.pollIntervalMs ?? 2500) {
    if (!enabled || disposed || options.autoSchedule === false) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; tick().catch(fail); }, delay);
    timer.unref?.();
  }

  function fail(failure) {
    enabled = false;
    phase = "needs_attention";
    error = failure?.message || "计划执行异常，请查看任务详情。";
    clearTimeout(timer);
    emit();
  }

  function refreshDay() {
    const today = localDate(now());
    let changed = false;
    for (const task of store.tasks) {
      if (task.repeat === "daily" && !["cancelled", "needs_attention", "running"].includes(task.status) && task.occurrenceDate !== today) {
        task.status = "pending";
        task.progress = { done: 0, total: readPayload(task).maxPosts };
        task.occurrenceDate = today;
        task.error = "";
        delete task.startedAt;
        delete task.completedAt;
        delete task.notBefore;
        changed = true;
      }
      if (task.status === "pending" && task.scheduledAt && localDate(task.scheduledAt) < today && !task.startedAt) {
        task.status = "missed";
        task.error = "已错过原定日期，请重新安排时间。";
        changed = true;
      }
    }
    if (changed) persist();
  }

  function reconcilePublishResults() {
    let changed = false;
    for (const task of store.tasks) {
      if (task.type !== "publish" || task.status !== "needs_attention") continue;
      const receipt = executors.publish?.workflowOutcome?.(task.id);
      if (receipt?.status === "completed") {
        task.status = "completed";
        task.progress = receipt.progress;
        task.error = "";
        task.completedAt = new Date(now()).toISOString();
        task.lastCompletedDate = localDate(now());
        changed = true;
      } else if (receipt?.status === "not_published") {
        task.status = "cancelled";
        task.error = "已核实未发布，需要时请重新安排。";
        changed = true;
      }
    }
    if (changed) { persist(); emit(); }
  }

  function dueAt(task) {
    if (task.repeat === "daily" && task.startTime) return new Date(`${localDate(now())}T${task.startTime}:00`).getTime();
    return task.scheduledAt ? new Date(task.scheduledAt).getTime() : null;
  }

  function nextTask() {
    const time = new Date(now()).getTime();
    return store.tasks.filter((task) => task.status === "pending" && (!task.notBefore || task.notBefore <= time)
      && (!task.accountName || task.accountName === getAccount()) && (dueAt(task) === null || dueAt(task) <= time))
      .sort((left, right) => {
        const a = dueAt(left); const b = dueAt(right);
        if (a !== null && b === null) return -1;
        if (a === null && b !== null) return 1;
        return (a !== null && b !== null ? a - b : 0) || left.sequence - right.sequence;
      })[0];
  }

  function settleQueue() {
    if (!enabled) { phase = "paused"; return; }
    const pending = store.tasks.filter((task) => task.status === "pending");
    const blocked = store.tasks.filter((task) => ["needs_attention", "missed"].includes(task.status)
      || (task.status === "pending" && task.accountName && task.accountName !== getAccount()));
    const available = pending.filter((task) => !task.accountName || task.accountName === getAccount());
    if (available.length) {
      phase = nextTask() ? "queued" : "scheduled";
      return;
    }
    if (store.replyEnabled !== false && accountRecipients().length && !replyError) {
      phase = "listening";
      return;
    }
    enabled = false;
    clearTimeout(timer);
    phase = blocked.length || replyError ? "needs_attention" : store.tasks.some((task) => task.status === "completed") ? "completed" : "idle";
  }

  function assertPlanEditable() {
    if (enabled || inFlight || phase === "pausing") throw new Error("请先暂停程序，再调整本轮任务。");
  }

  async function runCycle() {
    assertHealthy();
    refreshDay();
    reconcilePublishResults();
    for (const task of store.tasks) if (task.type === "touch" && !task.enrolled) enroll(task, readPayload(task));
    if (!enabled || mutating) return;
    const people = store.replyEnabled === false ? [] : accountRecipients();
    if (people.length && options.reply?.runWorkflowStep && !replyError) {
      phase = "replying";
      replyStatus = "正在检查客户消息";
      emit();
      const reply = await options.reply.runWorkflowStep({
        recipients: people, accountName: getAccount(), isEnabled: () => enabled,
        onProgress: (text) => { if (enabled) { replyStatus = text; emit(); } }
      });
      replyError = reply.error || "";
      replyStatus = reply.error || reply.progressText || (reply.handled ? replyStatus : "本次未发现待回复消息");
      if (reply.handled || reply.busy || reply.status === "busy") return;
    } else if (!replyError) {
      replyError = people.length ? "自动回复执行器不可用" : "";
      replyStatus = people.length ? "自动回复执行器不可用" : "暂无接待客户";
    }
    if (!enabled || mutating) return;
    const task = nextTask();
    if (!task) { currentTaskId = null; settleQueue(); emit(); return; }
    const executor = executors[task.type];
    currentTaskId = task.id;
    lastTaskId = task.id;
    phase = "working";
    task.status = "running";
    persist();
    emit();
    try {
      if (!executor?.runWorkflowStep) throw new Error("当前版本尚未连接这项任务的执行器。");
      const payload = readPayload(task);
      const result = await executor.runWorkflowStep({ ...task, payload }, { isEnabled: () => enabled && !task.cancelRequested });
      if (!result || !["pending", "completed", "needs_attention"].includes(result.status)) throw new Error("任务返回结果无法确认，请查看任务详情。");
      task.progress = result.progress || task.progress;
      if (task.progress.done > 0) task.startedAt ||= new Date(now()).toISOString();
      task.error = result.error || "";
      task.status = result.status;
      if (task.cancelRequested && result.status !== "needs_attention") task.status = "cancelled";
      if (task.status === "completed") {
        task.completedAt = new Date(now()).toISOString();
        task.lastCompletedDate = localDate(now());
      }
      if (result.retryAfterMs) task.notBefore = new Date(now()).getTime() + result.retryAfterMs;
      else delete task.notBefore;
    } catch (failure) {
      task.status = "needs_attention";
      task.error = failure.message || "任务执行中断，请核对实际结果。";
    } finally {
      currentTaskId = null;
      settleQueue();
      persist();
      emit();
    }
  }

  async function tick() {
    if (!enabled || disposed || inFlight) return;
    inFlight = runCycle();
    try { await inFlight; }
    finally { inFlight = null; schedule(); }
  }

  function serialize(action) {
    const pending = mutation.then(async () => {
      assertHealthy();
      mutating = true;
      try { return await action(); }
      finally { mutating = false; }
    });
    mutation = pending.catch(() => undefined);
    return pending;
  }

  function normalizedSchedule(input) {
    const repeat = input.repeat === "daily" && input.type === "interact" ? "daily" : null;
    let scheduledAt = input.scheduledAt || null;
    let startTime = input.startTime || null;
    if (scheduledAt) {
      const date = new Date(scheduledAt);
      if (!Number.isFinite(date.getTime())) throw new Error("请选择有效的执行时间。");
      scheduledAt = date.toISOString();
      if (repeat && !startTime) startTime = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }
    if (startTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) throw new Error("每日时间应为小时和分钟。");
    return { repeat, scheduledAt: repeat ? null : scheduledAt, startTime: repeat ? startTime : null };
  }

  function unwrap(result) {
    if (result?.ok === false) throw new Error(result.error || result.reason || "任务内容未能保存。");
    return result?.payload || result;
  }

  async function saveTask(input, existing) {
    assertPlanEditable();
    if (!TASK_TYPES.has(input.type) || (existing && input.type !== existing.type)) throw new Error("请选择有效的任务类型。");
    const completedDaily = existing?.repeat === "daily" && existing.status === "completed";
    if (existing && !completedDaily && (existing.status === "running" || existing.progress.done > 0 || !["pending", "missed"].includes(existing.status))) {
      throw new Error("这项任务已经开始，请使用重复任务建立新的安排。");
    }
    const executor = executors[input.type];
    if (!executor?.prepareWorkflowTask) throw new Error("当前版本尚未连接这项任务的执行器。");
    const accountName = getAccount();
    if (!accountName) throw new Error("请先同步当前微信联系人，确认本次使用的微信账号。");
    const task = {
      id: existing?.id || randomUUID(), type: input.type,
      title: String(input.title || TITLES[input.type]).trim().slice(0, 100),
      createdAt: existing?.createdAt || new Date(now()).toISOString(),
      sequence: existing?.sequence ?? Math.max(0, ...store.tasks.map((entry) => entry.sequence || 0)) + 1,
      ...normalizedSchedule(input), accountName, status: "pending", error: "",
      progress: { done: 0, total: 1 }, occurrenceDate: localDate(now()), enrolled: false
    };
    const payload = unwrap(await executor.prepareWorkflowTask(task.id, input.payload || {}));
    task.progress.total = input.type === "touch" ? payload.contacts.length : input.type === "interact" ? payload.maxPosts : 1;
    if (!task.progress.total) throw new Error("请至少选择一位客户或一个互动目标。");
    if (completedDaily) {
      task.status = "completed";
      task.progress = { ...existing.progress };
      task.lastCompletedDate = existing.lastCompletedDate;
      task.completedAt = existing.completedAt;
      task.startedAt = existing.startedAt;
      task.occurrenceDate = existing.occurrenceDate;
    }
    writePayload(task, payload);
    if (existing) store.tasks[store.tasks.indexOf(existing)] = task;
    else store.tasks.push(task);
    persist();
    enroll(task, payload);
    emit();
    schedule(0);
    return { ok: true, state: status(), task: { ...task } };
  }

  function findTask(id) {
    const task = store.tasks.find((entry) => entry.id === id);
    if (!task) throw new Error("这项任务不存在。");
    return task;
  }

  return {
    status, tick,
    refresh: () => {
      if (!loadError) { refreshDay(); reconcilePublishResults(); }
      return { ok: !loadError, state: status(), ...(loadError ? { error: loadError } : {}) };
    },
    addTask: (input) => serialize(() => saveTask(input)),
    addRecipients: (contactIds) => serialize(async () => {
      assertPlanEditable();
      const account = getAccount();
      if (!account) throw new Error("请先同步当前微信联系人。");
      if (!options.reply?.prepareWorkflowRecipients) throw new Error("当前版本未连接接待范围设置。");
      const selected = await options.reply.prepareWorkflowRecipients(contactIds);
      assertPlanEditable();
      if (account !== getAccount()) throw new Error("微信账号已变化，请重新选择联系人。");
      const merged = new Map(accountRecipients().map((contact) => [contact.id, contact]));
      for (const contact of selected) merged.set(contact.id, contact);
      const next = { ...recipients, accounts: { ...recipients.accounts, [account]: [...merged.values()] } };
      writeJsonAtomic(recipientsFile, next); recipients = next;
      emit(); return { ok: true, state: status() };
    }),
    setReplyEnabled: (value) => serialize(() => {
      assertPlanEditable();
      store.replyEnabled = value === true;
      persist(); emit(); return { ok: true, state: status() };
    }),
    updateTask: (input) => serialize(() => saveTask(input, findTask(input.id))),
    retryTask: (id) => serialize(() => {
      assertPlanEditable();
      const task = findTask(id);
      if (!canRetry(task)) throw new Error("无法确认这项任务尚未执行，请先核对微信中的实际结果，不能直接重试。");
      task.status = "pending"; task.error = "";
      delete task.notBefore;
      phase = "paused";
      persist(); emit(); return { ok: true, state: status() };
    }),
    getTask: async (id) => {
      assertHealthy();
      const task = findTask(id);
      const saved = readPayload(task);
      const payload = task.type === "touch" ? { script: saved.script, contactIds: saved.contacts.map((contact) => contact.id) }
        : task.type === "interact" ? { maxPosts: saved.maxPosts, likeEnabled: saved.likeEnabled, commentEnabled: saved.commentEnabled, commentGuidance: saved.commentGuidance }
          : { content: saved.content, sourceTaskId: task.id };
      const media = task.type === "publish" ? (await executors.publish.workflowDraft(task.id))?.media : undefined;
      return { ok: true, task: { ...task, payload, ...(media ? { media } : {}) } };
    },
    cancelTask: (id) => serialize(() => {
      assertPlanEditable();
      const task = findTask(id);
      if (task.status === "running") task.cancelRequested = true;
      else if (task.status !== "completed" || task.repeat === "daily") task.status = "cancelled";
      persist(); emit(); return { ok: true, state: status() };
    }),
    removeRecipient: (id) => serialize(() => {
      assertPlanEditable();
      const next = { ...recipients, accounts: { ...recipients.accounts, [getAccount()]: accountRecipients().filter((person) => person.id !== id) } };
      writeJsonAtomic(recipientsFile, next); recipients = next; emit(); return { ok: true, state: status() };
    }),
    start: async () => {
      assertHealthy();
      if (disposed) throw new Error("程序正在退出。");
      if (enabled || inFlight || mutating) return { ok: true, state: status() };
      refreshDay();
      if (!store.tasks.some((task) => task.status === "pending" && (!task.accountName || task.accountName === getAccount()))
        && !(store.replyEnabled !== false && accountRecipients().length)) {
        throw new Error("没有待执行任务。请将可重试任务重新加入计划；其他未完成任务请先核对结果。");
      }
      enabled = true; error = ""; phase = "listening";
      replyError = "";
      replyStatus = accountRecipients().length ? "准备接待客户" : "暂无接待客户";
      refreshDay(); settleQueue(); emit(); schedule(0); return { ok: true, state: status() };
    },
    pause: async () => {
      enabled = false; clearTimeout(timer);
      phase = inFlight ? "pausing" : "paused";
      emit();
      await inFlight;
      await options.reply?.pauseWorkflow?.();
      phase = "paused"; replyStatus = "已暂停"; emit();
      return { ok: true, state: status() };
    },
    dispose: async () => {
      enabled = false; disposed = true; clearTimeout(timer);
      await inFlight;
      await options.reply?.pauseWorkflow?.();
    }
  };
}

module.exports = { createWechatWorkflowController, localDate };
