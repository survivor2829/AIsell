const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readContacts } = require("../../rpa/active_touch/state_machine.cjs");

const POLL_INTERVAL_MS = 5_000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const CONTACT_RATE_LIMIT = 6;
const GLOBAL_RATE_LIMIT = 30;
const MAX_STATE_ENTRIES = 1_000;
const consumedClickTokens = new Set();
const SYSTEM_IDS = new Set([
  "filehelper",
  "fmessage",
  "floatbottle",
  "medianote",
  "newsapp",
  "notifymessage",
  "weixin"
]);
const SYSTEM_NAMES = new Set([
  "文件传输助手",
  "微信团队",
  "服务通知",
  "订阅号消息"
]);

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isReplyableText(value) {
  const text = normalizeText(value);
  if (!text || text.length > 500) return false;
  if (/^\[(图片|语音|文件|视频|表情|位置|小程序|链接|红包|转账)\]$/u.test(text)) return false;
  if (/(撤回了一条消息|以上是打招呼的内容|你已添加了|系统消息)/u.test(text)) return false;
  if (/(验证码|密码|银行卡|身份证|转账|付款|退款|赔偿|报警|律师|合同|发票|投诉)/u.test(text)) return false;
  return true;
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function dayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function createDefaultState() {
  return {
    version: 2,
    status: "stopped",
    reply_count: 0,
    daily_date: "",
    processed: {},
    handoff_notified: {},
    rate_events: [],
    last_event: "",
    last_error: "",
    updated_at: ""
  };
}

function migrateState(raw, current) {
  if (!raw || Object.keys(raw).length === 0) return createDefaultState();
  if (raw.version === 2) {
    const next = { ...createDefaultState(), ...raw };
    next.processed = raw.processed && typeof raw.processed === "object" ? raw.processed : {};
    next.handoff_notified = raw.handoff_notified && typeof raw.handoff_notified === "object" ? raw.handoff_notified : {};
    next.rate_events = Array.isArray(raw.rate_events) ? raw.rate_events : [];
    if (next.status === "running" || next.status === "starting") {
      next.status = "paused";
      if (next.last_event === "handoff_pending") {
        next.last_event = "handoff_interrupted";
        next.last_error = "上次人工提醒发送结果未确认，请在文件传输助手中人工检查";
      } else {
        next.last_event = "recovered_after_restart";
      }
    }
    if (next.daily_date !== dayKey(current)) {
      next.daily_date = dayKey(current);
      next.reply_count = 0;
    }
    return next;
  }
  return {
    ...createDefaultState(),
    status: "paused",
    reply_count: raw.daily_date === dayKey(current) ? Math.max(0, Number(raw.reply_count) || 0) : 0,
    daily_date: raw.daily_date === dayKey(current) ? raw.daily_date : dayKey(current),
    last_event: "state_upgraded_paused"
  };
}

function isSystemContact(contact) {
  const identifiers = [contact?.wechatId, contact?.wxid, contact?.id]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  const name = normalizeText(contact?.name);
  return !identifiers.length
    || identifiers.some((id) => SYSTEM_IDS.has(id) || id.endsWith("@chatroom") || id.startsWith("gh_"))
    || SYSTEM_NAMES.has(name)
    || /群聊$/u.test(name);
}

function eligibleContacts(activeTouchDir) {
  const contacts = readContacts(activeTouchDir)
    .filter((contact) => contact.wechatAccountId && !isSystemContact(contact));
  const counts = new Map();
  for (const contact of contacts) {
    const name = normalizeText(contact.name);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return contacts.filter((contact) => counts.get(normalizeText(contact.name)) === 1);
}

function normalizedContext(candidate) {
  if (!Array.isArray(candidate?.context)) return [];
  const context = candidate.context
    .slice(-12)
    .map((item) => ({
      role: item?.role === "assistant" ? "assistant" : item?.role === "user" ? "user" : "",
      content: normalizeText(item?.content),
      key: normalizeText(item?.key)
    }))
    .filter((item) => item.role && item.content);
  const latest = context.at(-1);
  if (!latest || latest.role !== "user" || latest.content !== normalizeText(candidate.message)) return [];
  return context;
}

function fingerprintFor(contact, candidate) {
  const runtimeId = normalizeText(candidate?.runtimeId);
  const incoming = normalizeText(candidate?.message);
  if (!runtimeId || !incoming) return "";
  return crypto.createHash("sha256")
    .update(JSON.stringify([
      contact.wechatAccountId || "unknown",
      contact.id,
      runtimeId,
      incoming
    ]))
    .digest("hex");
}

function recentRateEvents(events, nowMs) {
  return (Array.isArray(events) ? events : []).filter((event) => {
    const at = new Date(event?.at || 0).getTime();
    return Number.isFinite(at) && at <= nowMs && nowMs - at < RATE_WINDOW_MS;
  });
}

function exceedsRateLimit(events, contactId, nowMs = Date.now()) {
  const recent = recentRateEvents(events, nowMs);
  if (recent.length >= GLOBAL_RATE_LIMIT) return true;
  return recent.filter((event) => String(event.contact_id) === String(contactId)).length >= CONTACT_RATE_LIMIT;
}

function buildHandoffMessage({ conversation, reason, latest, at = new Date() }) {
  return [
    "【需人工跟进】",
    `客户：${normalizeText(conversation) || "未知客户"}`,
    `原因：${normalizeText(reason) || "需要人工确认"}`,
    `最新需求：${normalizeText(latest) || "未识别"}`,
    `时间：${at.toLocaleString("zh-CN", { hour12: false })}`,
    "请人工跟进"
  ].join("\n");
}

function createAutoReplyController(options = {}) {
  const dataDir = String(options.dataDir || "");
  const activeTouchDir = String(options.activeTouchDir || "");
  const stateFile = path.join(dataDir, "auto-reply-state.json");
  const coordinator = options.coordinator;
  const deepSeekClient = options.deepSeekClient;
  const expertStore = options.expertStore;
  const send = options.send;
  const sendHandoff = options.sendHandoff;
  const runStep = options.runStep;
  const scanIncoming = options.scanIncoming || require("../../rpa/active_touch/wechat_auto_reply_driver.cjs").scanWechatIncoming;
  const primeIncoming = options.primeIncoming || scanIncoming.primeBaselines;
  const verifyIncoming = options.verifyIncoming || require("../../rpa/active_touch/wechat_auto_reply_driver.cjs").verifyWechatIncoming;
  const schedule = options.schedule || setTimeout;
  const cancelSchedule = options.cancelSchedule || clearTimeout;
  const now = options.now || (() => new Date());
  const rawState = readJson(stateFile, null);
  let state = migrateState(rawState, now());
  if (rawState && (
    rawState.version !== 2
    || rawState.status === "running"
    || rawState.status === "starting"
    || rawState.daily_date !== state.daily_date
    || Number(rawState.reply_count) !== state.reply_count
  )) {
    state.updated_at = now().toISOString();
    writeAtomic(stateFile, state);
  }
  let timer = null;
  let scanActive = false;
  let runEpoch = 0;
  let starting = false;

  function save() {
    state.updated_at = now().toISOString();
    writeAtomic(stateFile, state);
  }

  function publicState() {
    return {
      status: state.status,
      reply_count: state.reply_count,
      last_event: state.last_event,
      last_error: state.last_error,
      updated_at: state.updated_at
    };
  }

  function resetDailyCounter(current) {
    const today = dayKey(current);
    if (state.daily_date === today) return;
    state.daily_date = today;
    state.reply_count = 0;
  }

  function status() {
    const previousDate = state.daily_date;
    resetDailyCounter(now());
    if (state.daily_date !== previousDate) save();
    return publicState();
  }

  function queueNext(delay = POLL_INTERVAL_MS) {
    if (timer || state.status !== "running") return;
    timer = schedule(async () => {
      timer = null;
      await runOnce();
      queueNext();
    }, delay);
  }

  function trimMap(map) {
    const keys = Object.keys(map || {});
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_STATE_ENTRIES))) delete map[key];
  }

  function remember(hash, value) {
    state.processed ||= {};
    state.processed[hash] = value;
    trimMap(state.processed);
  }

  function pause(reason = "paused_by_user") {
    runEpoch += 1;
    if (timer) cancelSchedule(timer);
    timer = null;
    state.status = "paused";
    state.last_event = reason;
    save();
    return { ok: true, state: publicState() };
  }

  async function waitForScanIdle() {
    while (scanActive) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async function start() {
    if (state.status === "running") return { ok: true, state: publicState() };
    if (starting) return { ok: false, error: "自动回复正在启动，请稍候" };
    const contacts = eligibleContacts(activeTouchDir);
    if (!contacts.length) return { ok: false, error: "没有可安全识别的已同步一对一联系人" };
    try {
      deepSeekClient?.assertAvailable();
      const expert = expertStore?.read();
      if (!normalizeText(expert?.text)) return { ok: false, error: "请先在 AI专家 导入自动回复话术文件" };
    } catch (error) {
      return { ok: false, error: String(error?.message || error), code: error?.code };
    }
    if (typeof send !== "function" || typeof sendHandoff !== "function" || typeof runStep !== "function") {
      return { ok: false, error: "当前版本未启用经校验的自动回复执行器" };
    }
    starting = true;
    runEpoch += 1;
    const startEpoch = runEpoch;
    state.status = "starting";
    state.last_event = "starting";
    state.last_error = "";
    resetDailyCounter(now());
    save();
    try {
      await waitForScanIdle();
      if (runEpoch !== startEpoch || state.status !== "starting") return { ok: false, error: "自动回复启动已取消", state: publicState() };
      scanIncoming.resetBaselines?.();
      if (typeof primeIncoming === "function") {
        const primed = await Promise.resolve(primeIncoming(contacts.map((contact) => contact.name)));
        if (primed?.ok !== true && primed?.reason !== "no_current_conversation") {
          throw new Error(primed?.reason || "微信当前会话基线初始化失败");
        }
      }
      if (runEpoch !== startEpoch || state.status !== "starting") return { ok: false, error: "自动回复启动已取消", state: publicState() };
      deepSeekClient?.assertAvailable();
      const latestExpert = expertStore?.read();
      if (!normalizeText(latestExpert?.text)) throw new Error("请先在 AI专家 导入自动回复话术文件");
      state.status = "running";
      state.last_event = "started";
      save();
      queueNext(0);
      return { ok: true, state: publicState() };
    } catch (error) {
      if (runEpoch === startEpoch && state.status === "starting") {
        state.status = "paused";
        state.last_event = "start_failed";
        state.last_error = String(error?.message || error || "自动回复启动失败");
        save();
      }
      return { ok: false, error: String(error?.message || error || "自动回复启动失败"), state: publicState() };
    } finally {
      starting = false;
    }
  }

  function pauseWithError(event, error) {
    state.status = "paused";
    state.last_event = event;
    state.last_error = String(error || "自动回复已暂停");
  }

  async function runOnce() {
    if (scanActive || state.status !== "running") return publicState();
    scanActive = true;
    const activeEpoch = runEpoch;
    const isCurrentRun = () => state.status === "running" && runEpoch === activeEpoch;
    const current = now();
    resetDailyCounter(current);
    const lock = coordinator?.acquire({
      state: "replying",
      taskId: `auto-reply-${current.getTime()}`,
      account: "unknown",
      phase: "scan-unread"
    });
    if (!lock?.ok) {
      state.last_event = "wechat_operation_busy";
      state.last_error = "";
      save();
      scanActive = false;
      return publicState();
    }

    try {
      const contacts = eligibleContacts(activeTouchDir);
      const candidate = await Promise.resolve(scanIncoming(contacts.map((contact) => contact.name)));
      if (!isCurrentRun()) return publicState();
      if (!candidate?.ok) {
        state.last_event = candidate?.reason || "no_unread_message";
        state.last_error = "";
        save();
        return publicState();
      }

      const conversation = normalizeText(candidate.conversation);
      const contact = contacts.find((item) => normalizeText(item.name) === conversation);
      if (!contact) {
        state.last_event = "conversation_not_eligible";
        state.last_error = "";
        save();
        return publicState();
      }
      const context = normalizedContext(candidate);
      const incoming = normalizeText(candidate.message);
      const fingerprint = fingerprintFor(contact, candidate);
      if (!context.length || !fingerprint) {
        state.last_event = "ambiguous_message_context";
        state.last_error = "";
        save();
        return publicState();
      }
      if (state.processed?.[fingerprint]) {
        state.last_event = "duplicate_skipped";
        state.last_error = "";
        save();
        return publicState();
      }
      if (context.some((item) => !isReplyableText(item.content))) {
        remember(fingerprint, { status: "skipped", contact_id: contact.id, conversation, at: current.toISOString() });
        state.last_event = "unsupported_or_risky_message";
        state.last_error = "";
        save();
        return publicState();
      }

      state.rate_events = recentRateEvents(state.rate_events, current.getTime());
      if (exceedsRateLimit(state.rate_events, contact.id, current.getTime())) {
        pauseWithError("rate_limit_paused", "触发异常频率熔断，请人工检查后再启动");
        save();
        return publicState();
      }

      const expert = expertStore?.read();
      if (!normalizeText(expert?.text)) throw new Error("AI专家话术文件不可用");
      remember(fingerprint, { status: "processing", contact_id: contact.id, conversation, at: current.toISOString() });
      state.last_event = "generating_reply";
      state.last_error = "";
      save();
      coordinator.update(lock.lock.owner, "generate-reply");
      const generated = await deepSeekClient.reply({ context, expert: expert.text });
      if (!isCurrentRun()) {
        state.processed[fingerprint].status = "cancelled";
        save();
        return publicState();
      }
      const reply = normalizeText(generated?.reply);
      if (!isReplyableText(reply)) throw new Error("DeepSeek 返回的回复未通过安全检查");

      let incomingStillCurrent = true;
      let draftPhaseStarted = false;
      const verifyCurrent = async () => {
        if (!isCurrentRun()) {
          incomingStillCurrent = false;
          return false;
        }
        const verification = await Promise.resolve(verifyIncoming(candidate));
        incomingStillCurrent = verification?.ok === true;
        return incomingStillCurrent;
      };
      const beforeDraft = async () => {
        draftPhaseStarted = true;
        return verifyCurrent();
      };
      const shouldContinue = () => draftPhaseStarted ? verifyCurrent() : isCurrentRun();
      coordinator.update(lock.lock.owner, "send-reply");
      const result = await send({
        baseDir: activeTouchDir,
        authorized: true,
        contactId: contact.id,
        frozenContact: contact,
        message: reply,
        attemptId: fingerprint,
        beforeDraft,
        shouldContinue,
        runStep: (command, args) => runStep(command, args, lock.lock.owner)
      });

      if (!isCurrentRun() && result?.blocked_reason === "batch_cancelled") {
        state.processed[fingerprint].status = "cancelled";
        save();
        return publicState();
      }
      if (!isCurrentRun()) {
        if (result?.ok) {
          const staleSentAt = now();
          resetDailyCounter(staleSentAt);
          state.processed[fingerprint].status = "sent_verified";
          state.reply_count += 1;
          state.rate_events.push({ contact_id: contact.id, at: staleSentAt.toISOString() });
          pauseWithError("stale_run_send_paused", "旧运行轮次在暂停后仍完成了发送，请人工检查");
        } else {
          state.processed[fingerprint].status = "cancelled";
        }
        save();
        return publicState();
      }
      if (!incomingStillCurrent || result?.blocked_reason === "incoming_message_changed") {
        state.processed[fingerprint].status = "cancelled";
        state.last_event = "manual_reply_or_message_changed";
        state.last_error = "";
        save();
        return publicState();
      }
      if (!result?.ok) {
        state.processed[fingerprint].status = "failed";
        pauseWithError("send_failed_paused", result?.error || result?.blocked_reason || "自动回复发送未通过校验");
        save();
        return publicState();
      }

      const sentAt = now();
      resetDailyCounter(sentAt);
      state.processed[fingerprint].status = "sent_verified";
      state.reply_count += 1;
      state.rate_events.push({ contact_id: contact.id, at: sentAt.toISOString() });
      state.last_event = "reply_sent_verified";
      state.last_error = "";
      save();

      if (generated?.intent === true || generated?.needsHuman === true) {
        const reason = normalizeText(generated?.intent === true
          ? generated?.intentReason || generated?.handoffReason
          : generated?.handoffReason || generated?.intentReason) || "需要人工跟进";
        const handoffKey = crypto.createHash("sha256")
          .update(`${contact.id}\n${context.map((item) => `${item.role}:${item.key || item.content}`).join("\n")}`)
          .digest("hex");
        if (!state.handoff_notified?.[handoffKey]) {
          if (!isCurrentRun()) return publicState();
          const message = buildHandoffMessage({ conversation, reason, latest: incoming, at: sentAt });
          state.last_event = "handoff_pending";
          save();
          coordinator.update(lock.lock.owner, "send-handoff");
          const handoffResult = await sendHandoff({
            authorized: true,
            message,
            expectedPid: candidate.pid,
            sourceWindowHandle: candidate.hWnd
          });
          if (!handoffResult?.ok) {
            pauseWithError("handoff_failed_paused", handoffResult?.error || handoffResult?.blocked_reason || "人工提醒发送失败");
            save();
            return publicState();
          }
          state.handoff_notified ||= {};
          state.handoff_notified[handoffKey] = { contact_id: contact.id, at: sentAt.toISOString() };
          trimMap(state.handoff_notified);
          state.last_event = generated.intent === true ? "intent_handoff_sent" : "human_handoff_sent";
        }
      }
      save();
      return publicState();
    } catch (error) {
      if (!isCurrentRun()) return publicState();
      pauseWithError("auto_reply_error_paused", error?.message || error || "自动回复失败");
      save();
      return publicState();
    } finally {
      coordinator.release(lock.lock.owner);
      scanActive = false;
    }
  }

  return { pause, runOnce, start, status };
}

function registerAutoReplyIpc(options = {}) {
  const ipcMain = options.ipcMain || require("electron").ipcMain;
  const getMainWindow = options.getMainWindow;
  const controller = createAutoReplyController(options);

  ipcMain.handle("auto-reply:status", () => ({ ok: true, state: controller.status() }));
  ipcMain.handle("auto-reply:start", (event, payload = {}) => {
    const token = String(payload.clickToken || "");
    const mainWindow = getMainWindow?.();
    if (!token || consumedClickTokens.has(token) || !mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || !mainWindow.isFocused()) {
      return { ok: false, error: "请在主窗口中手动点击启动自动回复" };
    }
    consumedClickTokens.add(token);
    if (consumedClickTokens.size > 200) consumedClickTokens.delete(consumedClickTokens.values().next().value);
    return controller.start();
  });
  ipcMain.handle("auto-reply:pause", () => controller.pause());
  return controller;
}

module.exports = {
  buildHandoffMessage,
  createAutoReplyController,
  exceedsRateLimit,
  isReplyableText,
  registerAutoReplyIpc
};
