const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { generateFixedScriptFallback, generatePersonalizedDraft } = require("./ai-draft.cjs");
const { diagnostics } = require("./diagnostics.cjs");
const { summarizeSendResult } = require("../shared/wechat-send-diagnostics.cjs");
const { normalizeTouchLink } = require("./touch-media.cjs");
const { executeMessageSequence, messageParts, canContinueSequence } = require("./touch-message-sequence.cjs");
const {
  classifyContacts,
  createTask,
  identityKey,
  loadTaskState,
  saveTaskState,
  sendDelayMs
} = require("../../rpa/active_touch/touch_task_state.cjs");

const UNCERTAIN_SEND_STATES = new Set(["sending", "prepared", "clicked", "outcome_unknown"]);

function createTouchWorkflow(options = {}) {
  const contactsDir = String(options.dataDir || "");
  const coordinator = options.coordinator;
  const now = options.now || (() => new Date());
  let activeStep = false;
  const workflowDirectory = (id) => path.join(contactsDir, "workflow-tasks", crypto.createHash("sha256").update(String(id)).digest("hex"));

  function safetyInterval(nextEligibleAt) {
    const retryAfterMs = Math.max(0, Date.parse(nextEligibleAt) - now().getTime());
    return {
      retryAfterMs,
      waitingReason: "touch_safety_interval",
      result: { nextEligibleAt }
    };
  }

  function prepareWorkflowTask(input = {}) {
    const script = String(input.script || "").trim();
    if (!script) throw new Error("请填写触达话术");
    const link = normalizeTouchLink(input.link);
    const imageIds = options.mediaStore ? options.mediaStore.validateIds(input.imageIds || []) : [];
    if (!options.mediaStore && input.imageIds?.length) throw new Error("图片服务未连接，请重新打开程序。");
    if (!Array.isArray(input.contactIds) || !input.contactIds.length) throw new Error("请选择本次触达的联系人");
    const requested = new Set(input.contactIds.map((id) => String(id).trim()).filter(Boolean));
    if (!requested.size) throw new Error("请选择本次触达的联系人");
    const contacts = options.readContacts();
    if ([...requested].some((id) => !contacts.some((contact) => String(contact.id) === id))) {
      throw new Error("所选联系人已不在同步通讯录，请刷新后重新选择");
    }
    const classification = classifyContacts(contacts);
    const eligible = classification.eligible.filter((contact) => requested.has(String(contact.id)));
    if (!eligible.length) throw new Error("所选联系人暂无可安全触达的对象，请检查联系人资料");
    const snapshot = createTask(script, contacts, now().toISOString(), {
      executionMode: "real_send",
      classification: { ...classification, eligible }
    });
    return {
      script,
      ...(imageIds.length || link ? { imageIds, link } : {}),
      contacts: snapshot.results.map((result) => result.contact),
      excluded: classification.excluded.filter((entry) => requested.has(String(entry.contact.id))),
      preparedAt: now().toISOString()
    };
  }

  async function runWorkflowStep(taskRecord, context = {}) {
    const id = String(taskRecord?.id || "").trim();
    const payload = taskRecord?.payload;
    const contacts = Array.isArray(payload?.contacts) ? payload.contacts : [];
    const script = String(payload?.script || "").trim();
    const enabled = () => typeof context.isEnabled === "function" && context.isEnabled() === true;
    const fallback = { done: Math.max(0, Number(taskRecord?.progress?.done) || 0), total: contacts.length };
    if (!id || !contacts.length || !script) return { status: "needs_attention", progress: fallback, error: "触达任务资料不完整，请重新添加任务" };
    if (!enabled() || activeStep) return { status: "pending", progress: fallback };
    activeStep = true;
    let owner = "";
    let task;
    const taskDir = workflowDirectory(id);
    const imageIds = Array.isArray(payload?.imageIds) ? payload.imageIds : [];
    const link = String(payload?.link || "");
    const multipart = imageIds.length > 0 || Boolean(link);
    const signature = crypto.createHash("sha256").update(JSON.stringify({ script, contacts: contacts.map(identityKey), ...(multipart ? { imageIds, link } : {}) })).digest("hex");
    const bindingFile = path.join(taskDir, "workflow-binding.json");
    const progress = () => ({ done: task?.current_index || 0, total: task?.total || contacts.length });
    const response = (status, extra = {}) => ({ status, progress: progress(), ...extra });
    const persist = () => { task = saveTaskState(taskDir, task); };
    const attention = (error, result, reasonCode = "") => {
      task.status = "paused";
      task.pause_reason = error;
      persist();
      return response("needs_attention", { error, ...(reasonCode ? { reasonCode } : {}), ...(result ? { result } : {}) });
    };
    try {
      if (fs.existsSync(bindingFile)) {
        const binding = JSON.parse(fs.readFileSync(bindingFile, "utf8"));
        if (binding.taskId !== id || binding.signature !== signature) {
          return response("needs_attention", { error: "任务内容与已启动的冻结记录不一致，请添加新任务" });
        }
        if (!fs.existsSync(path.join(taskDir, "touch_task.json"))) {
          return response("needs_attention", { error: "触达进度文件缺失，无法安全判断已发送范围" });
        }
        task = loadTaskState(taskDir);
      } else {
        if (fs.existsSync(path.join(taskDir, "touch_task.json"))) {
          return response("needs_attention", { error: "触达任务绑定记录缺失，无法安全重建进度" });
        }
        task = createTask(script, contacts, now().toISOString(), {
          executionMode: "real_send",
          classification: { eligible: contacts, excluded: [], accountId: String(contacts[0]?.wechatAccountId || "") }
        });
        task.id = id;
        persist();
        writeJsonAtomic(bindingFile, { taskId: id, signature });
      }
      if (task.integrity_error) return response("needs_attention", { error: task.pause_reason || "触达任务进度已损坏" });
      if (task.status === "paused") {
        if (!multipart || !canContinueSequence(task.results[task.current_index])) return response("needs_attention", { error: task.pause_reason || "触达任务需要处理" });
        task.status = "running";
        task.pause_reason = "";
        task.results[task.current_index].status = "generated";
        persist();
      }
      let current = task.results[task.current_index];
      // A completed receipt is authoritative even if the app exited before the
      // queue received the next index. Never send that contact a second time.
      if (current && ["sent_verified", "identity_skipped"].includes(current.status)) {
        task.current_index += 1;
        if (task.current_index >= task.total) task.status = "completed";
        persist();
        return response(task.status === "completed" ? "completed" : "pending");
      }
      if (!current || task.current_index >= task.total) return response("completed");
      if ((UNCERTAIN_SEND_STATES.has(current.status) || current.retry_blocked) && !(multipart && canContinueSequence(current))) {
        return attention("上次发送结果尚未确认，请检查微信；系统不会自动补发");
      }
      if (Date.parse(task.next_send_not_before || "") > now().getTime()) {
        // Propagate the persisted send interval to the unified scheduler.  Without
        // this it immediately re-enters this branch every poll and starves reply
        // checks, even though the contact is deliberately waiting.
        return response("pending", safetyInterval(task.next_send_not_before));
      }
      const liveContacts = options.readContacts();
      const liveClassification = classifyContacts(liveContacts);
      const liveContact = liveClassification.eligible.find((contact) => String(contact.id) === current.id);
      if (!liveContact || identityKey(liveContact) !== current.identity_hash) {
        current.status = "identity_skipped";
        current.reason = "联系人已变化或不再允许触达，已跳过";
        task.current_index += 1;
        if (task.current_index >= task.total) task.status = "completed";
        persist();
        return response(task.status === "completed" ? "completed" : "pending", { result: { deliveryStatus: "not_attempted", skipped: true } });
      }
      if (typeof options.execute !== "function") return attention("当前版本未连接触达执行器");
      if (!current.message) {
        let draft;
        try {
          draft = await generatePersonalizedDraft({ client: options.client, task, result: current });
        } catch (error) {
          draft = generateFixedScriptFallback({ task, result: current, error });
          if (!draft) return attention("触达文案生成失败，请修改话术后重新添加任务");
        }
        current.message = draft.message;
        current.ai_status = draft.usedAi ? "generated" : "fixed_script";
        current.ai_reason = draft.reason || "";
        current.status = "generated";
        persist();
      }
      if (!enabled()) return response("pending");
      const lock = coordinator?.acquire({ state: "touching", taskId: id, account: task.wechat_account_id, phase: "workflow:touch" });
      if (!lock?.ok || !lock.lock?.owner) return response("pending", { result: { reason: lock?.error || "wechat_operation_busy" } });
      owner = lock.lock.owner;
      const index = task.current_index;
      current = task.results[index];
      // The legacy CLI reads its contact list relative to its runtime. Give it
      // this fresh snapshot without changing the global runtime or its task.
      writeJsonAtomic(path.join(taskDir, "contacts.json"), liveContacts);
      let wechatRoot = "";
      try {
        wechatRoot = String(JSON.parse(fs.readFileSync(path.join(contactsDir, "..", "contact_sync", "state.json"), "utf8")).wechat_root || "");
      } catch {}
      const drivers = options.drivers || require("../../rpa/active_touch/wechat_window_driver.dev.cjs");
      current.status = "sending";
      persist();
      let result;
      const sendOperation = diagnostics().begin("active_touch", "workflow_contact_send", { task_id: id, current_index: index }, { trace: true });
      try {
        const executePart = async (part, partIndex, onPartTransition) => {
          const recipientKey = crypto.createHash("sha256").update(current.request_id).digest("hex");
          const executionDir = multipart ? path.join(taskDir, "message-parts", recipientKey, String(partIndex)) : taskDir;
          // Every part has its own CLI transaction. A text receipt must never
          // make the entire contact look complete while images remain unsent.
          fs.mkdirSync(executionDir, { recursive: true });
          if (multipart) writeJsonAtomic(path.join(executionDir, "contacts.json"), liveContacts);
          let image;
          if (part.kind === "image") {
            try { image = options.mediaStore.resolve(part.imageId); }
            catch (error) { return { ok: false, send_attempted: false, blocked_reason: "touch_image_unavailable", error: error.message }; }
          }
          return options.execute({
            baseDir: executionDir,
            contactsDir,
            contactId: current.id,
            message: part.message || `[图片:${part.imageId}]`,
            ...(image ? { image } : {}),
            frozenContact: current.contact,
            attemptId: multipart ? `${current.request_id}:${partIndex}` : current.request_id,
            authorized: true,
            windowMinIdleMs: 0,
            onDiagnostic: (detail) => diagnostics().event("active_touch", "send_stage", detail, {
              trace: true, traceId: sendOperation.traceId, phase: detail.phase, level: detail.ok === false ? "warn" : "info", code: detail.reason
            }),
            isExecutionAllowed: enabled,
            sessionDriver: (name, sessionContext) => drivers.verifyWechatCurrentConversationAsync(name, { ...sessionContext, wechatRoot }),
            sendDriver: (key, sendContext) => enabled()
              ? drivers.clickWechatSendButtonAsync(key, sendContext)
              : { ok: false, sendAttempted: false, reason: "workflow_paused" },
            runStep: (command, args = []) => options.runStep([command, ...args,
              ...(multipart ? ["--task-data-dir", taskDir] : []),
              "--task-id", id, "--contact-id", current.id, "--current-index", String(index)
            ], {
              dataDir: executionDir,
              parentTraceId: sendOperation.traceId,
              owner,
              workflow: "touching",
              phase: command,
              taskId: id,
              contactId: current.id,
              currentIndex: index
            }),
            onTransition: (status, executionState = {}) => {
              if (multipart) { onPartTransition(status); return; }
              const row = task.results[index];
              row.status = status;
              row.attempt_key = String(executionState.real_send_attempt_key || row.attempt_key || "");
              row.retry_blocked = ["prepared", "clicked", "sent_verified", "outcome_unknown"].includes(status);
              row.updated_at = now().toISOString();
              persist();
            }
          });
        };
        if (multipart) {
          current = task.results[index];
          result = await executeMessageSequence({
            row: current, parts: messageParts(current.message, imageIds, link), execute: executePart, isEnabled: enabled,
            persist: () => { task.results[index] = current; persist(); }
          });
        } else result = await executePart({ kind: "text", message: current.message }, 0);
        const detail = summarizeSendResult(result);
        sendOperation.end(detail, { ok: result?.ok === true, code: detail.reason });
      } catch (error) {
        sendOperation.fail(error, { stage: "workflow_contact_send", send_attempted: null });
        task.results[index].status = "outcome_unknown";
        task.results[index].retry_blocked = true;
        return attention("执行器异常，发送结果无法确认；系统不会自动补发", { deliveryStatus: "outcome_unknown" });
      }
      current = task.results[index];
      if (result?.ok && result?.state?.real_send_status === "sent_verified") {
        current.status = "sent_verified";
        current.retry_blocked = true;
        current.reason = "发送成功并已核验";
        task.current_index = index + 1;
        task.next_send_not_before = new Date(now().getTime() + sendDelayMs(options.random || Math.random)).toISOString();
        if (task.current_index >= task.total) {
          task.status = "completed";
          task.completed_at = now().toISOString();
        }
        persist();
        return response(task.status === "completed" ? "completed" : "pending", task.status === "completed"
          ? { result: { deliveryStatus: "sent_verified", contactId: current.id } }
          : { ...safetyInterval(task.next_send_not_before), result: { deliveryStatus: "sent_verified", contactId: current.id, nextEligibleAt: task.next_send_not_before } });
      }
      const notAttempted = result?.send_attempted === false || result?.send_result === "not_attempted";
      if (notAttempted && !["prepared", "clicked", "outcome_unknown"].includes(current.status)) {
        current.status = "generated";
        current.retry_blocked = false;
        persist();
        if (!enabled()) return response("pending", { result: { deliveryStatus: "not_attempted" } });
        return attention(
          String(result.error || result.blocked_reason || "触达未执行，请检查微信后处理任务"),
          { deliveryStatus: "not_attempted" },
          String(result?.blocked_reason || result?.reason || "")
        );
      }
      current.status = "outcome_unknown";
      current.retry_blocked = true;
      return attention(result?.error || "发送结果无法确认，请检查微信；系统不会自动补发", { deliveryStatus: "outcome_unknown" });
    } catch (error) {
      return { status: "needs_attention", progress: task ? progress() : fallback, error: String(error?.message || "触达任务读取失败") };
    } finally {
      try {
        if (owner) coordinator.release(owner);
      } finally {
        activeStep = false;
      }
    }
  }

  function canRetryWorkflowTask(record) {
    const task = loadTaskState(workflowDirectory(record.id));
    return !task.integrity_error && task.status === "paused" && canContinueSequence(task.results[task.current_index]);
  }
  return { prepareWorkflowTask, runWorkflowStep, canRetryWorkflowTask,
    describeImages: (ids = []) => ids.map((id) => options.mediaStore.describe(id)),
    importImages: (paths) => options.mediaStore.importFiles(paths) };
}

module.exports = { createTouchWorkflow };
