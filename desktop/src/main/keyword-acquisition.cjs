const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-file.cjs");

const fail = (code, message) => Object.assign(new Error(message), { code });
const text = (value, max = 2000) => String(value ?? "").trim().slice(0, max);
const stamp = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const clone = (value) => JSON.parse(JSON.stringify(value));
const purchaseSignals = (value) => [
  ["询价", /多少钱|价格多少|什么价|怎么卖|报价|价位/],
  ["购买", /怎么买|哪里买|哪里下单|想买|求购|有货吗|怎么买到|能发货|如何购买/],
  ["联系", /怎么联系|联系方式|地址在哪|门店在哪|可以了解|想了解/]
].filter(([, pattern]) => pattern.test(value)).map(([label]) => label);

function createKeywordAcquisitionController({ dataDir, adapter, expertStore, deepSeekClient, onChange = () => {}, schedule = setTimeout, cancelSchedule = clearTimeout }) {
  const stateFile = path.join(dataDir, "state.json");
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (state?.version !== 1 || !["tasks", "runs", "leads", "conversations", "attempts"].every((key) => Array.isArray(state[key]))) throw new Error("invalid state");
  } catch (error) {
    if (error.code !== "ENOENT") throw fail("KEYWORD_STATE_INVALID", "关键词获客记录无法读取，原文件已保留，请通过吐槽中心联系处理。");
    state = { version: 1, partitionId: id(), tasks: [], runs: [], leads: [], conversations: [], attempts: [] };
    writeJsonAtomic(stateFile, state);
  }
  let epoch = 0;
  let activePromise = null;
  let activeRunId = "";
  let timer = null;
  let browserBusy = false;
  let closed = false;
  let disposal = null;
  let browserState = { state: "closed", account: null, capabilities: { discover: false, send: false, inbox: false } };
  for (const run of state.runs) if (run.status === "running") { run.status = "paused"; run.reason = "上次任务已中断，点击开始可继续查找。"; run.finishedAt = stamp(); }
  for (const attempt of state.attempts) if (["prepared", "clicked"].includes(attempt.status)) { attempt.status = "outcome_unknown"; attempt.reason = "上次发送中断，请在抖音核对；系统不会自动重发。"; }
  for (const conversation of state.conversations) conversation.mode = "human";
  for (const task of state.tasks) if (task.status === "running") task.status = "paused";
  writeJsonAtomic(stateFile, state);

  function notify() { if (!closed) onChange(snapshot()); }
  function save() { writeJsonAtomic(stateFile, state); notify(); }
  function snapshot() {
    return clone({ ...state, partitionId: undefined, browser: adapter?.status() || browserState, expertReady: Boolean(expertStore?.status().ready), busy: Boolean(activePromise || browserBusy) });
  }
  function find(collection, key, label) {
    const item = state[collection].find((entry) => entry.id === key);
    if (!item) throw fail("KEYWORD_RECORD_MISSING", `没有找到这条${label}。`);
    return item;
  }
  function conversationFor(lead) {
    let conversation = state.conversations.find((entry) => entry.leadId === lead.id);
    if (!conversation) { conversation = { id: id(), leadId: lead.id, mode: "human", draft: state.tasks.find((task) => task.id === lead.taskId)?.firstMessage || "", messages: [], lastRepliedMessageId: "", revision: 0, updatedAt: stamp() }; state.conversations.push(conversation); }
    return conversation;
  }
  function currentAdapter() {
    if (!adapter) throw fail("DOUYIN_BROWSER_UNAVAILABLE", "抖音浏览器尚未连接，请重新打开桌面应用。");
    return adapter;
  }
  function canContinue(runEpoch) { return !closed && epoch === runEpoch; }
  function assertIdle() { if (activePromise || browserBusy) throw fail("KEYWORD_BUSY", "当前操作尚未结束，请先停止或等待完成。"); }
  async function exclusive(operation) {
    assertIdle(); browserBusy = true; notify();
    try { return await operation(); } finally { browserBusy = false; notify(); }
  }
  function saveTask(input = {}) {
    const existing = input.id ? find("tasks", input.id, "任务") : null;
    if (existing?.status === "running") throw fail("KEYWORD_TASK_RUNNING", "请先停止任务再修改。");
    const keywords = [...new Set((Array.isArray(input.keywords) ? input.keywords : String(input.keywords || "").split(/[\n,，、]/)).map((value) => text(value, 80)).filter(Boolean))];
    if (!keywords.length || keywords.length > 10) throw fail("KEYWORD_INPUT_INVALID", "请填写 1 到 10 个关键词。");
    const limit = Number(input.limit ?? 30);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail("KEYWORD_LIMIT_INVALID", "每次最多查看 1 到 100 条评论。");
    const contactLimit = Number(input.contactLimit ?? existing?.contactLimit ?? 5);
    if (!Number.isInteger(contactLimit) || contactLimit < 1 || contactLimit > 100) throw fail("KEYWORD_CONTACT_LIMIT_INVALID", "联系上限须为 1 到 100 人。");
    const firstMessage = text(input.firstMessage, 1000);
    if (input.autoContact && !firstMessage) throw fail("KEYWORD_MESSAGE_REQUIRED", "开启自动联系前，请填写首条私信。");
    const task = { ...(existing || { id: id(), createdAt: stamp() }), name: text(input.name, 80) || keywords.join("、").slice(0, 80), keywords,
      firstMessage, autoContact: Boolean(input.autoContact), limit, contactLimit, expertRef: "default", status: "ready", updatedAt: stamp() };
    if (existing) Object.assign(existing, task); else state.tasks.unshift(task);
    save(); return task;
  }
  function upsertObservedLead(comment, task, accountId) {
    const signals = purchaseSignals(comment.text);
    if (!signals.length) return null;
    let lead = state.leads.find((entry) => entry.accountId === accountId && entry.peerId === comment.peerId);
    if (!lead) {
      lead = { id: id(), taskId: task.id, accountId, peerId: comment.peerId, name: text(comment.name, 100) || "抖音用户", source: "douyin", sourceUrl: comment.sourceUrl,
        keyword: comment.keyword, comment: comment.text, commentId: comment.id, signals, status: "new", notes: "", createdAt: stamp(), updatedAt: stamp() };
      state.leads.unshift(lead);
    }
    return lead;
  }
  function saveLead(input = {}) {
    if (input.status != null && !["new", "qualified", "ignored"].includes(input.status)) throw fail("KEYWORD_LEAD_STATUS", "请选择有效的跟进状态。");
    let lead = input.id ? find("leads", input.id, "线索") : null;
    if (!lead) {
      const name = text(input.name, 100); const comment = text(input.comment);
      if (!name || !comment) throw fail("KEYWORD_LEAD_INPUT", "请填写客户称呼和需求原话。");
      lead = { id: id(), taskId: text(input.taskId, 80), accountId: "", peerId: "", name, source: "manual", sourceUrl: "", keyword: "", comment, commentId: "", signals: purchaseSignals(comment), status: "new", notes: "", createdAt: stamp() };
      state.leads.unshift(lead);
    }
    if (input.status != null) {
      lead.status = input.status;
    }
    if (input.notes != null) lead.notes = text(input.notes, 2000);
    lead.updatedAt = stamp(); save(); return lead;
  }
  function saveConversation(input = {}) {
    const lead = find("leads", input.leadId, "线索");
    if (input.mode != null) {
      if (!["human", "auto"].includes(input.mode)) throw fail("KEYWORD_CONVERSATION_MODE", "请选择人工跟进或 AI 接待。");
      if (input.mode === "auto") {
        assertPlatformLead(lead);
        if (!currentAdapter().status().capabilities.inbox || !currentAdapter().status().capabilities.send) throw fail("DOUYIN_INBOX_UNVERIFIED", "请先在抖音打开会话并同步消息，验证私信通道后再开启 AI 接待。");
        readExpert();
        if (state.attempts.some((attempt) => attempt.leadId === lead.id && attempt.status === "outcome_unknown")) throw fail("KEYWORD_SEND_UNKNOWN", "这段会话有待核对的发送结果，请先在抖音检查并人工跟进。");
      }
    }
    const conversation = conversationFor(lead);
    if (input.draft != null) conversation.draft = text(input.draft, 1000);
    if (input.mode != null) conversation.mode = input.mode;
    conversation.revision = Number(conversation.revision || 0) + 1;
    conversation.updatedAt = stamp(); save(); scheduleReception(); return conversation;
  }
  function readExpert() {
    const documents = expertStore?.read();
    if (!documents?.ready) throw fail("KEYWORD_EXPERT_REQUIRED", "请先在“你的 AI 专家”保存专家规则和业务知识。");
    return { expertRules: documents.expertRules.text, businessKnowledge: documents.businessKnowledge.text };
  }
  function assertPlatformLead(lead) {
    if (lead.source !== "douyin" || !lead.peerId || !lead.accountId) throw fail("KEYWORD_MANUAL_LEAD", "这条手动线索尚未绑定抖音会话，可以保存草稿并人工跟进。");
    currentAdapter().assertAccount(lead.accountId);
  }
  async function draftReply(leadId, expectedEpoch = epoch) {
    const lead = find("leads", leadId, "线索"); const conversation = conversationFor(lead);
    const revision = Number(conversation.revision || 0); const mode = conversation.mode;
    const expert = readExpert();
    if (!deepSeekClient?.reply) throw fail("KEYWORD_AI_UNAVAILABLE", "AI 服务暂未连接，请稍后再试。");
    const context = conversation.messages.filter((message) => ["incoming", "outgoing"].includes(message.direction)).slice(-12)
      .map((message) => ({ role: message.direction === "incoming" ? "user" : "assistant", content: message.text }));
    if (!context.length) context.push({ role: "user", content: lead.comment });
    const result = await deepSeekClient.reply({ context, expert, clarificationAllowed: true });
    if (!canContinue(expectedEpoch) || Number(conversation.revision || 0) !== revision || conversation.mode !== mode) throw fail("KEYWORD_DRAFT_CHANGED", "会话已更新，本次 AI 文案没有覆盖现有草稿。");
    if (result.action === "silent") { conversation.draft = ""; conversation.mode = "human"; conversation.lastReason = "AI 建议暂不回复，请人工确认。"; }
    else if (!text(result.reply)) throw fail("KEYWORD_AI_EMPTY", "AI 暂未生成可用回复，请重试或自行填写。");
    else { conversation.draft = text(result.reply, 1000); if (result.action === "handoff") { conversation.mode = "human"; conversation.lastReason = "AI 建议人工跟进。"; } }
    conversation.revision = Number(conversation.revision || 0) + 1; conversation.updatedAt = stamp(); save(); return conversation;
  }
  async function syncMessages(leadId) {
    const lead = find("leads", leadId, "线索"); assertPlatformLead(lead);
    const messages = await currentAdapter().readConversation({ peerId: lead.peerId, accountId: lead.accountId });
    const conversation = conversationFor(lead);
    for (const message of messages) {
      if (!message.id || !text(message.text) || !["incoming", "outgoing"].includes(message.direction) || conversation.messages.some((entry) => entry.id === message.id)) continue;
      // An optimistic outgoing bubble is not a delivery receipt.
      if (message.direction === "outgoing" && message.status !== "sent") continue;
      conversation.messages.push({ id: message.id, direction: message.direction, text: text(message.text), createdAt: message.createdAt || stamp() });
    }
    conversation.revision = Number(conversation.revision || 0) + 1; conversation.updatedAt = stamp(); save(); return conversation;
  }
  async function deliver(leadId, runEpoch, taskId) {
    const lead = find("leads", leadId, "线索"); assertPlatformLead(lead);
    const conversation = conversationFor(lead); const outgoing = text(conversation.draft, 1000);
    if (!outgoing) throw fail("KEYWORD_MESSAGE_REQUIRED", "请先填写或生成私信文案。");
    const incomingId = conversation.messages.filter((message) => message.direction === "incoming").at(-1)?.id || "first-contact";
    const previous = state.attempts.find((attempt) => attempt.leadId === lead.id && (attempt.status === "outcome_unknown" || attempt.incomingId === incomingId && ["prepared", "clicked", "sent_verified"].includes(attempt.status)));
    if (previous) throw fail("KEYWORD_DUPLICATE_SEND", previous.status === "sent_verified" ? "这条消息已经发送，等待客户回复后再继续。" : "这段会话的发送结果尚未核对，系统不会自动补发。");
    const task = find("tasks", taskId || lead.taskId, "来源任务");
    const contacted = new Set(state.attempts.filter((attempt) => (attempt.taskId || state.leads.find((entry) => entry.id === attempt.leadId)?.taskId) === task.id && ["prepared", "clicked", "sent_verified", "outcome_unknown"].includes(attempt.status)).map((attempt) => attempt.leadId));
    if (!contacted.has(leadId) && contacted.size >= (task.contactLimit || 5)) throw fail("KEYWORD_CONTACT_LIMIT", "已达到这项任务的联系人数上限，待核对的发送也占用名额。");
    if (!canContinue(runEpoch)) throw fail("KEYWORD_STOPPED", "操作已停止。");
    const conversationRevision = Number(conversation.revision || 0); const mode = conversation.mode;
    const attempt = { id: id(), taskId: task.id, leadId, incomingId, accountId: lead.accountId, status: "prepared", text: outgoing, createdAt: stamp(), updatedAt: stamp() };
    state.attempts.push(attempt); save();
    try {
      const result = await currentAdapter().send({ peerId: lead.peerId, accountId: lead.accountId, text: outgoing,
        expectedIncomingId: incomingId === "first-contact" ? "" : incomingId,
        shouldContinue: () => canContinue(runEpoch) && conversation.mode === mode && Number(conversation.revision || 0) === conversationRevision,
        onTransition: async (transition) => { if (transition === "clicked") { attempt.status = "clicked"; attempt.updatedAt = stamp(); save(); } } });
      if (result?.status === "sent_verified" && result.messageId) {
        attempt.status = "sent_verified"; attempt.messageId = result.messageId; conversation.lastRepliedMessageId = incomingId;
        if (!conversation.messages.some((message) => message.id === result.messageId)) conversation.messages.push({ id: result.messageId, direction: "outgoing", text: outgoing, createdAt: stamp() });
        if (conversation.draft === outgoing) conversation.draft = "";
        lead.status = "contacted";
      } else { attempt.status = "outcome_unknown"; attempt.reason = result?.reason || "发送结果尚未确认，请在抖音检查，系统不会自动补发。"; conversation.mode = "human"; }
    } catch (error) {
      attempt.status = attempt.status === "clicked" ? "outcome_unknown" : "not_attempted";
      attempt.reason = attempt.status === "outcome_unknown" ? "发送过程中断，请在抖音核对，系统不会自动补发。" : text(error.message);
      conversation.mode = "human"; attempt.updatedAt = stamp(); save(); throw error;
    }
    attempt.updatedAt = stamp(); conversation.updatedAt = stamp(); save();
    if (attempt.status === "outcome_unknown") throw fail("KEYWORD_SEND_UNKNOWN", attempt.reason);
    return attempt;
  }
  async function executeTask(task, run, runEpoch) {
    try {
      const browser = currentAdapter().status();
      currentAdapter().assertAccount(); run.accountId = browser.account.id; save();
      await currentAdapter().discover({ keywords: task.keywords, limit: task.limit, accountId: run.accountId,
        shouldContinue: () => canContinue(runEpoch),
        onProgress: (detail) => { if (canContinue(runEpoch)) { run.detail = detail; save(); } },
        onComment: async (comment) => {
          if (!canContinue(runEpoch)) return;
          run.observed += 1;
          const lead = upsertObservedLead(comment, task, run.accountId);
          if (lead && !run.leadIds.includes(lead.id)) run.leadIds.push(lead.id);
          save();
        } });
      if (canContinue(runEpoch) && task.autoContact && run.leadIds.length) {
        if (!currentAdapter().status().capabilities.send) throw fail("DOUYIN_SEND_UNVERIFIED", "线索已保存；私信通道尚未完成验证，请打开客户会话核对后继续。");
        for (const leadId of run.leadIds) {
          if (!canContinue(runEpoch)) break;
          const lead = find("leads", leadId, "线索");
          if (["ignored", "contacted"].includes(lead.status)) continue;
          const conversation = conversationFor(lead);
          if (!conversation.draft) conversation.draft = task.firstMessage;
          save();
          // The adapter only sends once the correct conversation is verifiable;
          // unsupported routing stops here without claiming a successful contact.
          await currentAdapter().openConversation(lead.peerId);
          await deliver(leadId, runEpoch, task.id);
        }
      }
      if (canContinue(runEpoch)) { run.status = "completed"; run.detail = `已查看 ${run.observed} 条评论，发现 ${run.leadIds.length} 条线索`; task.status = "completed"; }
    } catch (error) {
      if (canContinue(runEpoch)) { run.status = "blocked"; run.code = error.code || "KEYWORD_OPERATION_FAILED"; run.reason = text(error.message) || "查找暂未完成，请重试。"; task.status = "blocked"; }
    } finally {
      run.finishedAt = stamp(); if (run.status === "running") { run.status = "paused"; task.status = "paused"; }
      save();
    }
  }
  function startTask(taskId) {
    assertIdle();
    const task = find("tasks", taskId, "任务"); const runEpoch = ++epoch;
    const run = { id: id(), taskId, status: "running", observed: 0, leadIds: [], detail: "正在连接抖音", reason: "", startedAt: stamp() };
    state.runs.unshift(run); task.status = "running"; task.lastRunId = run.id; activeRunId = run.id; save();
    activePromise = Promise.resolve().then(() => executeTask(task, run, runEpoch)).finally(() => { activePromise = null; activeRunId = ""; notify(); scheduleReception(); });
    notify(); return run;
  }
  function pause(reason = "已停止，线索和会话已保存。") {
    if (closed) return snapshot();
    epoch += 1; if (timer) cancelSchedule(timer); timer = null;
    adapter?.stop?.();
    const run = state.runs.find((item) => item.id === activeRunId);
    if (run?.status === "running") { run.status = "paused"; run.reason = reason; const task = state.tasks.find((item) => item.id === run.taskId); if (task) task.status = "paused"; }
    for (const conversation of state.conversations) conversation.mode = "human";
    save(); return snapshot();
  }
  function acceptBrowserStatus(value) {
    const previousAccount = browserState.account?.id;
    browserState = value;
    if (previousAccount && value.account?.id !== previousAccount || ["closed", "interrupted", "verification_required"].includes(value.state)) pause("抖音连接已变化，任务已暂停。");
    else notify();
  }
  function scheduleReception() {
    if (closed || timer || !state.conversations.some((conversation) => conversation.mode === "auto")) return;
    timer = schedule(async () => {
      timer = null;
      if (activePromise || browserBusy) { scheduleReception(); return; }
      browserBusy = true; const runEpoch = epoch;
      try {
        for (const conversation of state.conversations.filter((entry) => entry.mode === "auto")) {
          if (!canContinue(runEpoch)) break;
          try {
            await syncMessages(conversation.leadId);
            const last = conversation.messages.at(-1);
            if (!last || last.direction !== "incoming" || last.id === conversation.lastRepliedMessageId) continue;
            await draftReply(conversation.leadId, runEpoch);
            if (conversation.mode === "auto" && conversation.draft && canContinue(runEpoch)) await deliver(conversation.leadId, runEpoch);
          } catch (error) { conversation.mode = "human"; conversation.lastReason = text(error.message); save(); }
        }
      } finally { browserBusy = false; notify(); scheduleReception(); }
    }, 15_000);
  }
  function dispose() {
    if (!disposal) disposal = (async () => { pause("应用已关闭，任务已暂停。"); closed = true; adapter?.dispose(); if (activePromise) await activePromise; })();
    return disposal;
  }
  return {
    partitionId: state.partitionId, snapshot, saveTask, saveLead, saveConversation, startTask, pause, acceptBrowserStatus,
    attachAdapter(value) { adapter = value; browserState = adapter.status(); },
    openBrowser: () => exclusive(() => currentAdapter().open()),
    refreshAccount: () => exclusive(() => currentAdapter().refreshAccount()),
    openSource: (leadId) => exclusive(async () => { const lead = find("leads", leadId, "线索"); if (!lead.sourceUrl) throw fail("KEYWORD_SOURCE_MISSING", "这条手动线索没有抖音来源链接。"); await currentAdapter().openSource(lead.sourceUrl); }),
    openConversation: (leadId) => exclusive(async () => { const lead = find("leads", leadId, "线索"); assertPlatformLead(lead); await currentAdapter().openConversation(lead.peerId); conversationFor(lead); save(); }),
    syncConversation: (leadId) => exclusive(() => syncMessages(leadId)),
    generateDraft: (leadId) => exclusive(() => draftReply(leadId)),
    sendDraft: (leadId) => exclusive(() => deliver(leadId, epoch)),
    settled: () => activePromise || Promise.resolve(), dispose
  };
}

module.exports = { createKeywordAcquisitionController, purchaseSignals };
