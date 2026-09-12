const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { generateFixedScriptFallback, generatePersonalizedDraft } = require("./ai-draft.cjs");
const { diagnostics } = require("./diagnostics.cjs");
const { summarizeSendResult } = require("../shared/wechat-send-diagnostics.cjs");
const { normalizeTouchLink } = require("./touch-media.cjs");
const { executeMessageSequence, messageParts, canContinueTouchResult, unknownMessagePart, resolveUnknownMessagePart } = require("./touch-message-sequence.cjs");
const {
  authorizeTask,
  classifyContacts,
  createTask,
  identityKey,
  isBatchAuthorized,
  loadTaskState,
  saveTaskState,
  sendDelayMs,
  taskSnapshotHash
} = require("../../rpa/active_touch/touch_task_state.cjs");

const UNCERTAIN_SEND_STATES = new Set(["sending", "prepared", "clicked", "outcome_unknown"]);
const IDENTITY_SKIP_REASONS = new Set([
  "contact_unavailable",
  "exact_search_result_not_found",
  "search_result_not_opened",
  "customer_conversation_not_found"
]);
const MANUAL_RESOLUTION_REASONS = {
  sent: "用户已确认发送成功",
  not_sent: "用户已确认未发送，等待再次启动",
  skip: "用户无法确认发送结果，已跳过当前联系人"
};

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

  function identitySkipReason(result) {
    const code = String(result?.blocked_reason || result?.state?.blocked_reason || "");
    return IDENTITY_SKIP_REASONS.has(code) ? code : "";
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
    const signature = workflowSignature({ script, contacts, imageIds, link });
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
        task = authorizeTask(task, now().toISOString());
        persist();
        writeJsonAtomic(bindingFile, { taskId: id, signature });
      }
      if (task.integrity_error) return response("needs_attention", { error: task.pause_reason || "触达任务进度已损坏" });
      if (task.manual_resolution_pending && taskRecord?.status !== "needs_attention") {
        delete task.manual_resolution_pending;
        persist();
      }
      if (task.status === "paused") {
        const resumableFreshEdit = multipart && task.phase === "preparing_batch"
          && !Object.prototype.hasOwnProperty.call(task.results[task.current_index] || {}, "message_parts")
          && ["pending", "generated"].includes(task.results[task.current_index]?.status)
          && task.results[task.current_index]?.retry_blocked === false
          && task.results[task.current_index]?.send_attempted === false;
        if (!resumableFreshEdit && !canContinueTouchResult(task.results[task.current_index], multipart)) return response("needs_attention", { error: task.pause_reason || "触达任务需要处理" });
        task.status = "running";
        task.pause_reason = "";
        if (multipart) task.results[task.current_index].status = "generated";
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
      if (!isBatchAuthorized(task)) return attention("本次任务授权无效，已阻断真实发送", null, "batch_authorization_missing");
      if ((UNCERTAIN_SEND_STATES.has(current.status) || current.retry_blocked) && !canContinueTouchResult(current, multipart)) {
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
        current.retry_blocked = false;
        current.send_attempted = false;
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
      current.send_attempted = null;
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
            authorized: isBatchAuthorized(task),
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
              row.send_attempted = status === "sent_verified" ? true : status === "not_attempted" ? false : null;
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
        task.results[index].send_attempted = null;
        return attention("执行器异常，发送结果无法确认；系统不会自动补发", { deliveryStatus: "outcome_unknown" });
      }
      current = task.results[index];
      if (result?.ok && result?.state?.real_send_status === "sent_verified") {
        current.status = "sent_verified";
        current.retry_blocked = true;
        current.send_attempted = true;
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
        const reasonCode = identitySkipReason(result);
        if (reasonCode) {
          current.status = "identity_skipped";
          current.reason = String(result.error || reasonCode) + "，已跳过当前联系人";
          current.retry_blocked = true;
          current.send_attempted = false;
          current.updated_at = now().toISOString();
          task.current_index = index + 1;
          if (task.current_index >= task.total) {
            task.status = "completed";
            task.completed_at = now().toISOString();
          }
          persist();
          return response(task.status === "completed" ? "completed" : "pending", {
            result: { deliveryStatus: "not_attempted", skipped: true, reasonCode }
          });
        }
        current.status = "generated";
        current.retry_blocked = false;
        current.send_attempted = false;
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
      current.send_attempted = null;
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

  function canRetryWorkflowTask(record, payload) {
    const task = loadTaskState(workflowDirectory(record.id));
    const multipart = payload ? (Array.isArray(payload.imageIds) && payload.imageIds.length > 0 || Boolean(payload.link)) : undefined;
    return !task.integrity_error && task.status === "paused" && canContinueTouchResult(task.results[task.current_index], multipart);
  }

  function describeUnknownWorkflowTask(record) {
    const id = String(record?.id || record || "").trim();
    if (!id) return null;
    const task = loadTaskState(workflowDirectory(id));
    const current = task.results?.[task.current_index];
    if (task.integrity_error) return null;
    if (task.status === "paused" && current?.status === "outcome_unknown") {
      const unknown = unknownMessagePart(current);
      if (Array.isArray(current.message_parts) && !unknown) return null;
      return {
        required: true,
        contactLabel: String(current.name || current.contact?.name || current.id || "当前联系人"),
        partKind: unknown ? String(unknown.part.kind || "") : "text"
      };
    }
    if (task.manual_resolution_pending?.resolutionId) {
      return { required: false, reconciliation: task.manual_resolution_pending };
    }
    return null;
  }

  function resolveUnknownWorkflowTask(record, resolution, resolutionId = crypto.randomUUID()) {
    const id = String(record?.id || record || "").trim();
    if (!id || !["sent", "not_sent", "skip"].includes(resolution) || !/^[a-f0-9-]{36}$/u.test(String(resolutionId))) throw new Error("请选择有效的发送结果。");
    const taskDir = workflowDirectory(id);
    const task = loadTaskState(taskDir);
    if (task.manual_resolution_pending?.resolutionId === resolutionId) return task.manual_resolution_pending;
    const current = task.results?.[task.current_index];
    if (task.integrity_error) throw new Error("触达任务进度校验失败，暂不能处理。");
    if (task.status !== "paused" || current?.status !== "outcome_unknown") throw new Error("这项任务没有待确认的发送结果。");
    const unknown = unknownMessagePart(current);
    const multipart = Array.isArray(current.message_parts);
    if (multipart && !unknown) throw new Error("不确定的消息段记录不完整，无法安全处理。");

    const resolvedAt = now().toISOString();
    const priorRequestId = String(current.request_id || "");
    const history = Array.isArray(current.manual_resolution_history) ? current.manual_resolution_history : [];
    current.manual_resolution_history = [...history, {
      resolution,
      resolution_id: resolutionId,
      resolved_at: resolvedAt,
      previous_request_id: priorRequestId,
      previous_attempt_key: String(current.attempt_key || ""),
      previous_attempt_id: unknown ? `${priorRequestId}:${unknown.index}` : String(current.attempt_key || priorRequestId),
      previous_status: "outcome_unknown",
      ...(unknown ? { part_index: unknown.index, part_kind: String(unknown.part.kind || "") } : {})
    }];
    current.manual_resolution = resolution;
    current.manual_resolved_at = resolvedAt;
    current.awaiting_resolution = false;
    current.reason = MANUAL_RESOLUTION_REASONS[resolution];
    current.updated_at = resolvedAt;

    let advance = resolution === "skip";
    if (resolution === "skip") {
      current.status = "outcome_unknown_skipped";
      current.retry_blocked = true;
      current.send_attempted = null;
    } else if (multipart) {
      const resolved = resolveUnknownMessagePart(current, resolution, resolvedAt);
      advance = resolved.allSent;
      current.status = advance ? "sent_verified" : "generated";
      current.retry_blocked = advance;
      current.send_attempted = advance ? true : false;
    } else if (resolution === "sent") {
      current.status = "sent_verified";
      current.retry_blocked = true;
      current.send_attempted = true;
      advance = true;
    } else {
      current.status = "generated";
      current.retry_blocked = false;
      current.send_attempted = false;
    }

    if (resolution === "not_sent") {
      current.request_id = crypto.randomUUID();
      current.attempt_key = "";
      current.manual_resolution_history.at(-1).next_request_id = current.request_id;
      current.manual_resolution_history.at(-1).next_attempt_id = unknown ? `${current.request_id}:${unknown.index}` : current.request_id;
    }
    if (advance) {
      task.current_index += 1;
      if (resolution === "sent" && task.current_index < task.total) {
        task.next_send_not_before = new Date(now().getTime() + sendDelayMs(options.random || Math.random)).toISOString();
      }
    }
    task.status = task.current_index >= task.total ? "completed" : "paused";
    task.phase = task.status === "completed" ? "completed" : "preparing_batch";
    task.pause_reason = task.status === "completed" ? "" : "人工处理已保存，请再次点击启动程序继续。";
    if (task.status === "completed") task.completed_at = resolvedAt;
    const outcome = {
      resolution, resolutionId, resolvedAt, completed: task.status === "completed",
      progress: { done: task.current_index, total: task.total },
      partKind: unknown ? String(unknown.part.kind || "") : "text",
      partIndex: unknown ? unknown.index : null,
      identityRotated: resolution === "not_sent"
    };
    current.manual_resolution_history.at(-1).outcome = outcome;
    task.manual_resolution_pending = outcome;
    saveTaskState(taskDir, task);
    return outcome;
  }

  function acknowledgeUnknownWorkflowResolution(record, resolutionId) {
    const id = String(record?.id || record || "").trim();
    if (!id || !resolutionId) return false;
    const taskDir = workflowDirectory(id);
    const task = loadTaskState(taskDir);
    if (task.manual_resolution_pending?.resolutionId !== resolutionId) return false;
    delete task.manual_resolution_pending;
    saveTaskState(taskDir, task);
    return true;
  }

  function updateWorkflowTask(id, payload = {}) {
    const taskId = String(id || "").trim();
    const taskDir = workflowDirectory(taskId);
    const bindingFile = path.join(taskDir, "workflow-binding.json");
    if (!taskId || !fs.existsSync(bindingFile)) throw new Error("触达任务尚未建立可编辑的执行记录，请先暂停后重试。");
    let task = loadTaskState(taskDir);
    const current = task.results[task.current_index];
    if (task.integrity_error) throw new Error("触达任务进度校验失败，暂不能编辑。");
    if (task.current_index >= task.total || ["completed", "stopped"].includes(task.status)) throw new Error("这项触达任务已经结束，不能继续编辑。");
    if (current && (current.status === "sent_verified" || [...UNCERTAIN_SEND_STATES].includes(current.status) || current.retry_blocked)) {
      throw new Error("当前联系人发送结果尚未确认，请先核对微信后再编辑。");
    }
    const expectedIds = task.results.map((result) => String(result?.id || ""));
    const nextContacts = Array.isArray(payload.contacts) ? payload.contacts : [];
    if (JSON.stringify(expectedIds) !== JSON.stringify(nextContacts.map((contact) => String(contact?.id || "")))) {
      throw new Error("任务已经开始，只能修改话术，不能修改已冻结的联系人范围。");
    }
    const script = String(payload.script || "").trim();
    if (!script) throw new Error("请填写触达话术");
    const imageIds = Array.isArray(payload.imageIds) ? payload.imageIds : [];
    const link = String(payload.link || "");
    for (const result of task.results.slice(task.current_index)) {
      if (!result || !["pending", "generated", "not_attempted"].includes(result.status)
        || result.send_attempted !== false
        || result.retry_blocked
        || result.message_parts?.some((part) => ["sending", "prepared", "clicked", "sent_verified", "outcome_unknown"].includes(part?.status))) {
        throw new Error("任务中存在尚未确认的发送结果，请先核对微信后再编辑。");
      }
      result.status = "pending";
      result.reason = "";
      result.message = "";
      result.ai_status = "";
      result.ai_reason = "";
      result.ai_error_code = "";
      result.ai_attempts = 0;
      result.awaiting_resolution = false;
      result.retry_blocked = false;
      result.send_attempted = false;
      delete result.message_parts;
      result.updated_at = now().toISOString();
    }
    task.script = script;
    task.status = "paused";
    task.phase = "preparing_batch";
    task.pause_reason = "话术已修改，点击启动程序继续未发送联系人";
    task.snapshot_hash = taskSnapshotHash(task);
    task = authorizeTask(task, now().toISOString());
    saveTaskState(taskDir, task);
    writeJsonAtomic(bindingFile, { taskId, signature: workflowSignature({ script, contacts: task.results.map((result) => result.contact), imageIds, link }) });
    return { script, ...(imageIds.length || link ? { imageIds, link } : {}), contacts: task.results.map((result) => result.contact), preparedAt: now().toISOString() };
  }
  function hasStartedWorkflowTask(id) {
    const taskDir = workflowDirectory(String(id || "").trim());
    return fs.existsSync(path.join(taskDir, "touch_task.json"));
  }
  return { prepareWorkflowTask, updateWorkflowTask, hasStartedWorkflowTask, runWorkflowStep, canRetryWorkflowTask, describeUnknownWorkflowTask, resolveUnknownWorkflowTask, acknowledgeUnknownWorkflowResolution,
    describeImages: (ids = []) => ids.map((id) => options.mediaStore.describe(id)),
    importImages: (paths) => options.mediaStore.importFiles(paths) };
}

function workflowSignature({ script, contacts, imageIds = [], link = "" }) {
  const multipart = imageIds.length > 0 || Boolean(link);
  return crypto.createHash("sha256").update(JSON.stringify({
    script: String(script || "").trim(),
    contacts: contacts.map(identityKey),
    ...(multipart ? { imageIds, link } : {})
  })).digest("hex");
}

module.exports = { createTouchWorkflow };
