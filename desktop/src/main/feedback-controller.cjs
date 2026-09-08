const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { createTransport } = require("./cloud-transport.cjs");
const { token, UUID } = require("../shared/cloud-contract.cjs");
const { reportEntry } = require("../shared/cloud-report.cjs");

const CATEGORIES = new Set(["problem", "suggestion", "experience"]);
const STATUSES = new Set(["pending", "in_progress", "resolved"]);
const MAX_ATTEMPTS = 5;
const freshDraft = () => ({ id: crypto.randomUUID(), text: "", category: "problem", includeDiagnostics: true, visibility: "public", context: null });
const validationError = (message) => Object.assign(new Error(message), { code: "feedback_validation" });
const errorFor = (code) => ({
  cloud_http_400: "反馈内容未被服务端接受，已保留在本机。",
  cloud_http_403: "当前反馈服务暂不接受请求，已保留在本机。",
  cloud_http_404: "反馈服务尚未上线，内容已保留，服务上线后可重新发送。",
  cloud_http_409: "该反馈编号已存在且内容不一致，已停止重试，请导出诊断后联系支持。",
  feedback_secure_storage: "Windows 安全存储暂不可用，请在原 Windows 账户下重新打开软件。",
  feedback_receipt_invalid: "未收到有效提交回执，反馈仍保留在本机。",
  feedback_unavailable: "当前版本尚未连接反馈服务，内容已保留在本机。"
}[code] || "暂时无法连接，内容已保留在本机；自动重试结束后可手动重新发送。");

function cleanContext(value) {
  if (!value || typeof value !== "object") return null;
  const module = token(value.module), taskId = token(value.taskId);
  return module || taskId ? { module, taskId } : null;
}
function validateInput(value, allowEmpty = false) {
  if (!value || typeof value !== "object" || !UUID.test(value.id || "")) throw validationError("反馈草稿已失效，请重新打开吐槽中心。");
  const text = typeof value.text === "string" ? value.text : "";
  if (Array.from(text).length > 2000 || (!allowEmpty && !text.trim())) throw validationError("请填写 1～2000 字的反馈内容。");
  if (!CATEGORIES.has(value.category)) throw validationError("请选择反馈类型。");
  return { id: value.id, text: allowEmpty ? text : text.trim(), category: value.category,
    visibility: value.visibility === "private" ? "private" : "public", includeDiagnostics: value.includeDiagnostics !== false, context: cleanContext(value.context) };
}
function fingerprint(value, schema = 2) {
  return crypto.createHash("sha256").update(JSON.stringify({ text: value.text, category: value.category,
    includeDiagnostics: value.includeDiagnostics, context: value.context, ...(schema === 2 ? { visibility: value.visibility } : {}) })).digest("hex");
}
function validReceipt(value, id) {
  return value?.id === id && STATUSES.has(value.status) && Number.isSafeInteger(value.receivedAt)
    && value.receivedAt > 0 && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= value.receivedAt;
}

function receiptView(value) {
  return { id: value.id, status: value.status, receivedAt: value.receivedAt, updatedAt: value.updatedAt,
    ...(value.visibility === "public" || value.visibility === "private" ? { visibility: value.visibility } : {}),
    hidden: value.hidden === true, officialReply: typeof value.officialReply === "string" ? value.officialReply.slice(0, 4000) : "" };
}
function publicView(value) {
  if (!UUID.test(value?.id || "") || !validReceipt(value, value.id) || !CATEGORIES.has(value.category)
    || typeof value.text !== "string" || Array.from(value.text).length > 2000 || typeof value.createdAt !== "string") throw new Error("feedback_public_invalid");
  return { id: value.id, text: value.text, category: value.category, createdAt: value.createdAt,
    status: value.status, receivedAt: value.receivedAt, updatedAt: value.updatedAt,
    officialReply: typeof value.officialReply === "string" ? value.officialReply.slice(0, 4000) : "" };
}
function createFeedbackController({ rootDir, config, version, buildId, logger, safeStorage, transport, clock = Date.now }) {
  const filename = path.join(rootDir, "feedback", "state.json");
  let saved;
  try { saved = JSON.parse(fs.readFileSync(filename, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("feedback_store_unreadable"); }
  if (saved && (![1, 2].includes(saved.schema) || !Array.isArray(saved.items))) throw new Error("feedback_store_invalid");
  let state = saved || { schema: 2, installId: crypto.randomUUID(), items: [], draft: freshDraft(), lastRefresh: "" };
  if (state.schema === 1) state = { ...state, schema: 2, draft: { ...state.draft, visibility: "private" } };
  const network = transport || (config?.enabled ? createTransport(config) : null);
  let timer, stopped = false, flushing, refreshing, refreshError = "";
  const listeners = new Set();
  const commit = (next) => { writeJsonAtomic(filename, next, { mode: 0o600 }); state = next; };
  const updateItem = (id, patch) => commit({ ...state, items: state.items.map((item) => item.payload.id === id ? { ...item, ...patch } : item) });
  // A crash while sending is always retryable with the original immutable ID.
  for (const item of state.items) if (item.delivery === "sending") {
    item.delivery = item.attempts >= MAX_ATTEMPTS ? "failed" : "queued";
    item.error = errorFor("feedback_receipt_invalid");
  }
  commit(state);
  let community = { items: [], total: 0, offset: 0, lastRefresh: "", error: "" };
  let snapshotSequence = 0;
  function status() {
    return { snapshotSequence: ++snapshotSequence, enabled: Boolean(network), community: structuredClone(community), draft: structuredClone(state.draft), lastRefresh: state.lastRefresh,
      refreshError, items: state.items.slice().reverse().map((item) => ({
        id: item.payload.id, text: item.payload.text, category: item.payload.category,
        context: structuredClone(item.payload.context), createdAt: item.payload.createdAt, includeDiagnostics: item.includeDiagnostics,
        diagnosticCount: item.payload.diagnostics.length, delivery: item.delivery,
        visibility: item.receipt?.visibility || item.payload.visibility || "private", hidden: item.receipt?.hidden === true, officialReply: item.receipt?.officialReply || "", status: item.receipt?.status || null, receivedAt: item.receipt?.receivedAt || null,
        updatedAt: item.receipt?.updatedAt || null, error: item.error || "", retryable: item.errorCode !== "cloud_http_409"
      })) };
  }
  function notify() { for (const listener of listeners) { try { listener(status()); } catch {} } }
  function saveDraft(payload) {
    const draft = validateInput(payload, true);
    // Ignore delayed saves from a draft that has already been submitted.
    if (draft.id === state.draft.id) commit({ ...state, draft });
    return status();
  }
  function encrypt(value) {
    if (!safeStorage?.isEncryptionAvailable?.()) throw Object.assign(new Error("feedback_secure_storage"), { code: "feedback_secure_storage" });
    return safeStorage.encryptString(value).toString("base64");
  }
  function decrypt(item) {
    try {
      if (!safeStorage?.isEncryptionAvailable?.()) throw new Error();
      const value = safeStorage.decryptString(Buffer.from(item.secret, "base64"));
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error();
      return value;
    } catch { throw Object.assign(new Error("feedback_secure_storage"), { code: "feedback_secure_storage" }); }
  }
  function snapshot(input) {
    const all = input.includeDiagnostics ? (logger?.readRecent?.(200) || []) : [];
    const failures = all.filter((entry) => ["warn", "error", "fatal"].includes(entry.level)
      && (!input.context?.module || entry.module === input.context.module));
    const relatedTraces = new Set(failures.map(entry => entry.trace_id).filter(Boolean));
    const diagnostics = all.filter(entry => failures.includes(entry)
      || (entry.level === "info" && relatedTraces.has(entry.trace_id)))
      .map((entry) => reportEntry(entry, { installId: state.installId })).filter(Boolean).slice(0, 20);
    return { schema: 2, visibility: input.visibility, id: input.id, text: input.text, category: input.category,
      createdAt: new Date(clock()).toISOString(), context: input.context || {}, diagnostics,
      client: { schema: 1, appId: config?.appId || "com.aihuoke.desktop.test", channel: config?.channel || "test",
        installId: state.installId, version, buildId: token(buildId), platform: process.platform,
        arch: process.arch, osRelease: token(os.release()) } };
  }
  async function flushQueue() {
    if (!network || stopped) return status();
    for (const queued of state.items) {
      if (stopped) break;
      const item = state.items.find((value) => value.payload.id === queued.payload.id);
      // A persisted sending item can remain after its acknowledgement could not be saved.
      if (!["queued", "sending"].includes(item.delivery) || item.retryAt > clock()) continue;
      if (item.attempts >= MAX_ATTEMPTS) {
        updateItem(item.payload.id, { delivery: "failed", errorCode: "feedback_receipt_invalid", error: errorFor("feedback_receipt_invalid") });
        notify(); continue;
      }
      const attempts = item.attempts + 1;
      const retryAt = clock() + Math.min(300_000, 15_000 * 2 ** (attempts - 1));
      // Never send a snapshot or token until the exact retry state is durable.
      updateItem(item.payload.id, { delivery: "sending", attempts, retryAt }); notify();
      let patch;
      try {
        const receiptToken = decrypt(item);
        const receipt = await network.request("/v1/feedback", { body: { ...item.payload, receiptToken } });
        if (stopped) break;
        if (!validReceipt(receipt, item.payload.id)) throw Object.assign(new Error("feedback_receipt_invalid"), { code: "feedback_receipt_invalid" });
        patch = { receipt: receiptView(receipt),
          delivery: "sent", error: "", errorCode: "", retryAt: 0 };
      } catch (error) {
        if (stopped) break;
        const code = String(error?.code || error?.message || "");
        const terminal = /cloud_http_(?:400|401|403|404|409|413|422)$/.test(code) || code === "feedback_secure_storage";
        patch = { errorCode: code, error: errorFor(code), delivery: terminal || attempts >= MAX_ATTEMPTS ? "failed" : "queued", retryAt };
      }
      updateItem(item.payload.id, patch); notify();
    }
    return status();
  }
  function flush() {
    if (flushing) return flushing;
    flushing = flushQueue().finally(() => { flushing = undefined; });
    return flushing;
  }
  async function submit(payload) {
    const input = validateInput(payload);
    let item = state.items.find((candidate) => candidate.payload.id === input.id);
    if (item) {
      if (item.inputHash !== fingerprint(input, item.payload.schema)) throw validationError("该反馈已经提交，请在新的草稿中填写补充内容。");
    } else {
      if (input.id !== state.draft.id) throw validationError("反馈草稿已失效，请重新打开吐槽中心。");
      // Preserve the last keystrokes even when secure credential storage fails.
      commit({ ...state, draft: input });
      const secret = encrypt(crypto.randomBytes(32).toString("hex"));
      item = { payload: snapshot(input), secret, inputHash: fingerprint(input), includeDiagnostics: input.includeDiagnostics,
        delivery: network ? "queued" : "failed", attempts: 0, retryAt: 0, errorCode: network ? "" : "feedback_unavailable",
        error: network ? "" : errorFor("feedback_unavailable") };
      commit({ ...state, items: [...state.items, item], draft: freshDraft() }); notify();
    }
    // Persist and return immediately; only a server receipt marks the item sent.
    void flush().catch(() => {});
    return status();
  }
  async function retry(id) {
    const item = state.items.find((candidate) => candidate.payload.id === id);
    if (!item || item.delivery === "sent" || item.delivery === "sending" || item.errorCode === "cloud_http_409") return status();
    if (!network) return status();
    updateItem(id, { delivery: "queued", attempts: 0, retryAt: 0, error: "", errorCode: "" }); notify();
    void flush().catch(() => {});
    return status();
  }
  async function refreshStatuses() {
    if (!network || stopped) return status();
    const sent = state.items.filter((item) => item.delivery === "sent");
    const receipts = new Map();
    try {
      for (let offset = 0; offset < sent.length; offset += 100) {
        const chunk = sent.slice(offset, offset + 100);
        const result = await network.request("/v1/feedback/status", { body: { items: chunk.map((item) => ({ id: item.payload.id, receiptToken: decrypt(item) })) } });
        if (stopped) return status();
        if (!Array.isArray(result?.items) || result.items.length !== chunk.length
          || !chunk.every((item) => result.items.filter((receipt) => validReceipt(receipt, item.payload.id)).length === 1)) {
          throw new Error("feedback_status_invalid");
        }
        for (const item of chunk) {
          const receipt = result.items.find((value) => value.id === item.payload.id);
          if (receipt.receivedAt !== item.receipt.receivedAt || (receipt.updatedAt === item.receipt.updatedAt && receipt.status !== item.receipt.status)) throw new Error("feedback_status_invalid");
          if (receipt.updatedAt > item.receipt.updatedAt) receipts.set(item.payload.id, receiptView(receipt));
        }
      }
      commit({ ...state, lastRefresh: new Date(clock()).toISOString(), items: state.items.map((item) => {
        const receipt = receipts.get(item.payload.id);
        return receipt && receipt.updatedAt > item.receipt.updatedAt ? { ...item, receipt } : item;
      }) });
      refreshError = "";
    } catch { refreshError = "暂时无法更新处理进度，下面保留最近一次状态。"; }
    notify(); return status();
  }
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = refreshStatuses().finally(() => { refreshing = undefined; });
    return refreshing;
  }
  async function publicList(offset = 0) {
    offset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    try {
      if (!network) throw new Error("offline");
      const result = await network.request("/v1/feedback/public?offset=" + offset + "&limit=30");
      if (!Array.isArray(result?.items) || result.items.length > 30 || !Number.isSafeInteger(result.total) || result.total < 0) throw new Error("invalid");
      const items = result.items.map(publicView);
      community = { items, total: result.total, offset, lastRefresh: new Date(clock()).toISOString(), error: "" };
    } catch { community = { ...community, error: "暂时无法刷新公开反馈，保留最近一次内容；请稍后重试。" }; }
    notify(); return status();
  }
  async function withdraw(id) {
    const item = state.items.find((value) => value.payload.id === id);
    if (!item || item.delivery !== "sent" || (item.receipt?.visibility || item.payload.visibility) !== "public") return status();
    if (!network) throw validationError("暂时无法撤回公开，请连接网络后重试。");
    const receipt = await network.request("/v1/feedback/visibility", { body: { id, receiptToken: decrypt(item), visibility: "private" } });
    if (!validReceipt(receipt, id) || receipt.visibility !== "private") throw new Error("feedback_receipt_invalid");
    const current = state.items.find(value => value.payload.id === id);
    if (receipt.receivedAt !== current.receipt.receivedAt) throw new Error("feedback_receipt_invalid");
    if (receipt.updatedAt > current.receipt.updatedAt) updateItem(id, { receipt: receiptView(receipt) });
    community = { ...community, total: Math.max(0, community.total - (community.items.some((value) => value.id === id) ? 1 : 0)), items: community.items.filter((value) => value.id !== id) };
    notify(); return status();
  }
  function start() {
    if (timer || stopped || !network) return;
    void flush().catch(() => {});
    timer = setInterval(() => void flush().catch(() => {}), 15_000); timer.unref?.();
  }
  function stop() { stopped = true; clearInterval(timer); network?.close?.(); }
  return { status, submit, retry, refresh, publicList, withdraw, saveDraft, start, stop, flush,
    onUpdate(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}
module.exports = { createFeedbackController };
