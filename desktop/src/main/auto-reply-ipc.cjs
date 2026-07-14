const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readContacts } = require("../../rpa/active_touch/state_machine.cjs");

const POLL_INTERVAL_MS = 5_000;
const DAILY_REPLY_LIMIT = 20;
const CONTACT_COOLDOWN_MS = 30 * 60 * 1000;
const consumedClickTokens = new Set();

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
  const temporary = `${file}.tmp`;
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

function minuteOfDay(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function isWithinWorkHours(date, startValue, endValue) {
  const start = minuteOfDay(startValue);
  const end = minuteOfDay(endValue);
  if (start === null || end === null) return false;
  const current = date.getHours() * 60 + date.getMinutes();
  if (start <= end) return current >= start && current <= end;
  return current >= start || current <= end;
}

function createDefaultState() {
  return {
    version: 1,
    status: "stopped",
    contact_ids: [],
    contact_snapshots: [],
    instruction: "礼貌、简短地回复；信息不足时先问一个澄清问题",
    work_start: "09:00",
    work_end: "18:00",
    reply_count: 0,
    skipped_count: 0,
    daily_date: "",
    last_reply_at: {},
    processed: {},
    last_event: "",
    last_error: "",
    updated_at: ""
  };
}

function createAutoReplyController(options = {}) {
  const dataDir = String(options.dataDir || "");
  const activeTouchDir = String(options.activeTouchDir || "");
  const stateFile = path.join(dataDir, "auto-reply-state.json");
  const coordinator = options.coordinator;
  const deepSeekClient = options.deepSeekClient;
  const send = options.send;
  const runStep = options.runStep;
  const scanIncoming = options.scanIncoming || require("../../rpa/active_touch/wechat_auto_reply_driver.cjs").scanWechatIncoming;
  const verifyIncoming = options.verifyIncoming || require("../../rpa/active_touch/wechat_auto_reply_driver.cjs").verifyWechatIncoming;
  const schedule = options.schedule || setTimeout;
  const cancelSchedule = options.cancelSchedule || clearTimeout;
  const now = options.now || (() => new Date());
  let state = { ...createDefaultState(), ...readJson(stateFile, {}) };
  if (state.status === "running") {
    state.status = "paused";
    state.last_event = "recovered_after_restart";
    state.updated_at = now().toISOString();
    writeAtomic(stateFile, state);
  }
  let timer = null;
  let scanActive = false;

  function save() {
    state.updated_at = now().toISOString();
    writeAtomic(stateFile, state);
  }

  function publicState() {
    return {
      ...state,
      processed_count: Object.keys(state.processed || {}).length,
      contact_snapshots: undefined,
      processed: undefined,
      last_reply_at: undefined
    };
  }

  function resetDailyCounters(current) {
    const today = dayKey(current);
    if (state.daily_date === today) return;
    state.daily_date = today;
    state.reply_count = 0;
    state.skipped_count = 0;
  }

  function queueNext() {
    if (timer || state.status !== "running") return;
    timer = schedule(async () => {
      timer = null;
      await runOnce();
      queueNext();
    }, POLL_INTERVAL_MS);
  }

  function selectedContacts() {
    const selected = new Set(state.contact_ids);
    return (Array.isArray(state.contact_snapshots) ? state.contact_snapshots : []).filter((contact) => contact.allowed !== false && selected.has(contact.id));
  }

  function start(payload = {}) {
    const contactIds = [...new Set((Array.isArray(payload.contactIds) ? payload.contactIds : []).map(String).filter(Boolean))];
    const contacts = readContacts(activeTouchDir).filter((contact) => contact.allowed !== false && contactIds.includes(contact.id));
    if (!contacts.length || contacts.length !== contactIds.length) return { ok: false, error: "请选择已同步且允许操作的联系人" };
    if (contactIds.length > 20) return { ok: false, error: "自动回复白名单最多选择20位联系人" };
    if (new Set(contacts.map((contact) => contact.name)).size !== contacts.length) return { ok: false, error: "白名单中存在同名联系人，无法安全自动回复" };
    const accountIds = new Set(contacts.map((contact) => contact.wechatAccountId).filter(Boolean));
    if (accountIds.size !== 1 || contacts.some((contact) => !contact.wechatAccountId)) return { ok: false, error: "自动回复白名单必须来自同一个微信账号，请重新同步后选择" };
    const workStart = String(payload.workStart || "09:00");
    const workEnd = String(payload.workEnd || "18:00");
    if (minuteOfDay(workStart) === null || minuteOfDay(workEnd) === null) return { ok: false, error: "工作时间格式无效" };
    try {
      deepSeekClient.assertAvailable();
    } catch (error) {
      return { ok: false, error: error.message, code: error.code };
    }
    if (typeof send !== "function" || typeof runStep !== "function") return { ok: false, error: "当前版本未启用真实发送执行器" };

    state.contact_ids = contactIds;
    state.contact_snapshots = contacts;
    state.instruction = normalizeText(payload.instruction) || createDefaultState().instruction;
    state.work_start = workStart;
    state.work_end = workEnd;
    state.status = "running";
    state.last_event = "started";
    state.last_error = "";
    resetDailyCounters(now());
    save();
    queueNext();
    return { ok: true, state: publicState() };
  }

  function pause(reason = "paused_by_user") {
    if (timer) cancelSchedule(timer);
    timer = null;
    state.status = "paused";
    state.last_event = reason;
    save();
    return { ok: true, state: publicState() };
  }

  function remember(hash, value) {
    state.processed ||= {};
    state.processed[hash] = value;
    const hashes = Object.keys(state.processed);
    if (hashes.length > 1000) delete state.processed[hashes[0]];
  }

  async function runOnce() {
    if (scanActive || state.status !== "running") return publicState();
    scanActive = true;
    const current = now();
    resetDailyCounters(current);
    if (!isWithinWorkHours(current, state.work_start, state.work_end)) {
      state.last_event = "outside_work_hours";
      save();
      scanActive = false;
      return publicState();
    }
    if (state.reply_count >= DAILY_REPLY_LIMIT) {
      state.last_event = "daily_limit_reached";
      save();
      scanActive = false;
      return publicState();
    }

    const lock = coordinator?.acquire({ state: "replying", taskId: `auto-reply-${current.getTime()}`, account: "unknown", phase: "scan-unread" });
    if (!lock?.ok) {
      state.last_event = "wechat_operation_busy";
      save();
      scanActive = false;
      return publicState();
    }

    try {
      const contacts = selectedContacts();
      const candidate = await Promise.resolve(scanIncoming(contacts.map((contact) => contact.name)));
      if (!candidate?.ok) {
        state.last_event = candidate?.reason || "no_unread_message";
        state.last_error = "";
        save();
        return publicState();
      }

      const contact = contacts.find((item) => item.name === normalizeText(candidate.conversation));
      if (!contact) {
        state.last_event = "conversation_not_in_whitelist";
        save();
        return publicState();
      }
      const incoming = normalizeText(candidate.message);
      const fingerprint = crypto.createHash("sha256")
        .update(`${contact.wechatAccountId || "unknown"}\n${contact.id}\n${incoming}`)
        .digest("hex");
      if (state.processed?.[fingerprint]) {
        state.last_event = "duplicate_skipped";
        save();
        return publicState();
      }
      if (!isReplyableText(incoming)) {
        remember(fingerprint, { status: "skipped", contact_id: contact.id, conversation: contact.name, at: current.toISOString() });
        state.skipped_count += 1;
        state.last_event = "unsupported_or_risky_message";
        save();
        return publicState();
      }
      const lastReplyAt = new Date(state.last_reply_at?.[contact.id] || 0).getTime();
      if (Number.isFinite(lastReplyAt) && current.getTime() - lastReplyAt < CONTACT_COOLDOWN_MS) {
        remember(fingerprint, { status: "skipped", contact_id: contact.id, conversation: contact.name, at: current.toISOString() });
        state.skipped_count += 1;
        state.last_event = "contact_cooldown";
        save();
        return publicState();
      }

      remember(fingerprint, { status: "processing", contact_id: contact.id, conversation: contact.name, at: current.toISOString() });
      state.last_event = "generating_reply";
      save();
      coordinator.update(lock.lock.owner, "generate-reply");
      const generated = await deepSeekClient.reply({ incoming, instruction: state.instruction });
      const reply = normalizeText(generated?.reply);
      if (!isReplyableText(reply)) throw new Error("DeepSeek 返回的回复未通过安全检查");

      let incomingStillCurrent = true;
      const beforeDraft = async () => {
        if (state.status !== "running") return false;
        const verification = await Promise.resolve(verifyIncoming(candidate));
        incomingStillCurrent = verification?.ok === true;
        return incomingStillCurrent;
      };
      coordinator.update(lock.lock.owner, "send-reply");
      const result = await send({
        baseDir: activeTouchDir,
        authorized: true,
        contactId: contact.id,
        frozenContact: contact,
        message: reply,
        beforeDraft,
        runStep: (command, args) => runStep(command, args, lock.lock.owner)
      });

      if (!incomingStillCurrent || result?.blocked_reason === "incoming_message_changed") {
        state.processed[fingerprint].status = "skipped";
        state.skipped_count += 1;
        state.last_event = "manual_reply_or_message_changed";
        state.last_error = "";
        save();
        return publicState();
      }
      if (!result?.ok) {
        state.processed[fingerprint].status = "failed";
        state.status = "paused";
        state.last_event = "send_failed_paused";
        state.last_error = String(result?.error || result?.blocked_reason || "自动回复发送未通过校验");
        save();
        return publicState();
      }

      state.processed[fingerprint].status = "sent_verified";
      state.last_reply_at ||= {};
      state.last_reply_at[contact.id] = current.toISOString();
      state.reply_count += 1;
      state.last_event = "reply_sent_verified";
      state.last_error = "";
      save();
      return publicState();
    } catch (error) {
      state.status = "paused";
      state.last_event = "auto_reply_error_paused";
      state.last_error = String(error?.message || error || "自动回复失败");
      save();
      return publicState();
    } finally {
      coordinator.release(lock.lock.owner);
      scanActive = false;
    }
  }

  return { pause, runOnce, start, status: publicState };
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
    return controller.start(payload);
  });
  ipcMain.handle("auto-reply:pause", () => controller.pause());
  return controller;
}

module.exports = { createAutoReplyController, isReplyableText, registerAutoReplyIpc };
