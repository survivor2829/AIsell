const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createKeywordAcquisitionController } = require("./keyword-acquisition.cjs");
const { parsePageResponse, allowedUrl } = require("./douyin-browser-adapter.cjs");
const { registerKeywordAcquisitionIpc } = require("./keyword-acquisition-ipc.cjs");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-keyword-self-check-"));
const expertStore = { status: () => ({ ready: true }), read: () => ({ ready: true, expertRules: { text: "回复简洁；未知事实转人工" }, businessKnowledge: { text: "只回答已经提供的商品资料" } }) };
const comment = (peerId = "customer_one", cid = "1") => ({ id: cid, peerId, name: "测试客户", text: "多少钱，怎么买？", videoId: "123", sourceUrl: "https://www.douyin.com/video/123", keyword: "测试关键词" });
const account = { id: "operator_one", name: "测试账号" };
function fakeAdapter(overrides = {}) {
  return {
    status: () => ({ state: "connected", account, capabilities: { discover: true, send: true, inbox: true } }),
    assertAccount: (expected) => { if (expected && expected !== account.id) throw Object.assign(new Error("账号不符"), { code: "DOUYIN_ACCOUNT_CHANGED" }); },
    discover: async ({ onComment }) => { await onComment(comment()); await onComment(comment()); await onComment({ ...comment("no_signal"), text: "路过" }); },
    openConversation: async () => {}, readConversation: async () => [], stop() {}, dispose() {},
    send: async ({ onTransition }) => { await onTransition("clicked"); return { status: "sent_verified", messageId: "outgoing_one" }; }, ...overrides
  };
}
async function main() {
  const profile = "https://www.douyin.com/aweme/v1/web/user/profile/self/";
  assert.deepEqual(parsePageResponse(profile, { user: { sec_uid: "operator_one", nickname: "测试" } }).account, { id: "operator_one", name: "测试" });
  assert.equal(parsePageResponse(profile, { status_code: 8 }).account, null);
  assert.deepEqual(parsePageResponse("https://www.douyin.com.evil.test/aweme/v1/web/user/profile/self/", { user: { sec_uid: "operator_one" } }), {});
  assert.equal(allowedUrl("file:///C:/Users/Scott"), false);
  const parsed = parsePageResponse("https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=123", { comments: [
    { cid: "real", aweme_id: "123", text: "多少钱", user: { sec_uid: "customer_one", nickname: "客户" } },
    { cid: "ambiguous", text: "多少钱", user: { nickname: "同名客户" } }
  ] });
  assert.equal(parsed.comments.length, 1, "Missing identity must not produce an actionable platform lead");

  const dataDir = path.join(temporary, "records");
  let sendCount = 0;
  const adapter = fakeAdapter({ send: async ({ onTransition }) => { sendCount += 1; await onTransition("clicked"); throw new Error("browser crashed after click"); } });
  const controller = createKeywordAcquisitionController({ dataDir, adapter, expertStore });
  const task = controller.saveTask({ keywords: ["测试关键词"], limit: 30, contactLimit: 1, firstMessage: "你好，想了解哪方面？" });
  controller.startTask(task.id); await controller.settled();
  let snapshot = controller.snapshot();
  assert.equal(snapshot.runs[0].status, "completed");
  assert.equal(snapshot.runs[0].observed, 3);
  assert.equal(snapshot.leads.length, 1, "Repeat comments from one person and non-signals must not inflate leads");
  const lead = snapshot.leads[0];
  controller.saveConversation({ leadId: lead.id, draft: "你好" });
  await assert.rejects(controller.sendDraft(lead.id), /browser crashed/);
  assert.equal(controller.snapshot().attempts[0].status, "outcome_unknown");
  await controller.dispose();
  const restored = createKeywordAcquisitionController({ dataDir, adapter, expertStore });
  await assert.rejects(restored.sendDraft(lead.id), (error) => error.code === "KEYWORD_DUPLICATE_SEND");
  assert.equal(sendCount, 1, "Unknown outcome must survive restart and never be retried");
  adapter.discover = async ({ onComment }) => onComment(comment("customer_two", "2"));
  restored.startTask(task.id); await restored.settled();
  const second = restored.snapshot().leads.find((item) => item.peerId === "customer_two");
  restored.saveConversation({ leadId: second.id, draft: "你好" });
  await assert.rejects(restored.sendDraft(second.id), (error) => error.code === "KEYWORD_CONTACT_LIMIT");
  assert.equal(sendCount, 1, "Unknown delivery consumes the contact quota");
  const manual = restored.saveLead({ name: "人工线索", comment: "想了解服务", source: "douyin", peerId: "fake_peer" });
  assert.equal(manual.source, "manual");
  await assert.rejects(restored.sendDraft(manual.id), (error) => error.code === "KEYWORD_MANUAL_LEAD");
  const beforeInvalid = restored.snapshot().leads.length;
  assert.throws(() => restored.saveLead({ name: "bad", comment: "多少钱", status: "sent_verified" }));
  assert.equal(restored.snapshot().leads.length, beforeInvalid, "Rejected input must not partially mutate state");
  await restored.dispose();

  let finishDiscovery; let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const stopped = createKeywordAcquisitionController({ dataDir: path.join(temporary, "stop"), adapter: fakeAdapter({ discover: async ({ onComment }) => { entered(); await new Promise((resolve) => { finishDiscovery = resolve; }); await onComment(comment()); } }) });
  stopped.startTask(stopped.saveTask({ keywords: "测试" }).id); await started; stopped.pause(); finishDiscovery(); await stopped.settled();
  assert.equal(stopped.snapshot().leads.length, 0, "A stopped run must reject late collector output");
  assert.equal(stopped.snapshot().runs[0].status, "paused"); await stopped.dispose();

  let finishDraft;
  const drafting = createKeywordAcquisitionController({ dataDir: path.join(temporary, "draft"), adapter: fakeAdapter(), expertStore,
    deepSeekClient: { reply: () => new Promise((resolve) => { finishDraft = resolve; }) } });
  const draftLead = drafting.saveLead({ name: "草稿客户", comment: "想了解服务" });
  const generation = drafting.generateDraft(draftLead.id);
  drafting.saveConversation({ leadId: draftLead.id, draft: "用户刚刚写的新草稿", mode: "human" });
  finishDraft({ action: "reply", reply: "过期AI结果" });
  await assert.rejects(generation, (error) => error.code === "KEYWORD_DRAFT_CHANGED");
  assert.equal(drafting.snapshot().conversations[0].draft, "用户刚刚写的新草稿"); await drafting.dispose();

  const unready = fakeAdapter({ status: () => ({ state: "closed", account: null, capabilities: { discover: true, send: false, inbox: false } }), assertAccount: () => { throw Object.assign(new Error("请先登录"), { code: "DOUYIN_LOGIN_REQUIRED" }); } });
  const offline = createKeywordAcquisitionController({ dataDir: path.join(temporary, "offline"), adapter: unready });
  const offlineTask = offline.saveTask({ keywords: "测试", firstMessage: "你好", autoContact: true });
  assert.equal(offlineTask.autoContact, true, "Task configuration can be saved before platform integration is ready");
  offline.startTask(offlineTask.id); await offline.settled();
  assert.equal(offline.snapshot().runs[0].status, "blocked");
  assert.equal(offline.snapshot().runs[0].code, "DOUYIN_LOGIN_REQUIRED"); await offline.dispose();

  const handlers = new Map(); const frame = {}; const webContents = { mainFrame: frame, send() {} };
  const registration = registerKeywordAcquisitionIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: (name) => handlers.delete(name) },
    dataDir: path.join(temporary, "ipc"), getMainWindow: () => ({ webContents, isDestroyed: () => false }) });
  const forbidden = await handlers.get("keyword-acquisition:save-task")({ sender: {}, senderFrame: {} }, { keywords: "禁止" });
  assert.equal(forbidden.code, "KEYWORD_IPC_FORBIDDEN");
  const approved = await handlers.get("keyword-acquisition:save-task")({ sender: webContents, senderFrame: frame }, { keywords: "允许" });
  assert.equal(approved.ok, true); assert.equal(approved.state.tasks.length, 1); await registration.dispose();

  const corruptDir = path.join(temporary, "corrupt"); fs.mkdirSync(corruptDir); fs.writeFileSync(path.join(corruptDir, "state.json"), "{broken");
  assert.throws(() => createKeywordAcquisitionController({ dataDir: corruptDir }), (error) => error.code === "KEYWORD_STATE_INVALID");
  assert.equal(fs.readFileSync(path.join(corruptDir, "state.json"), "utf8"), "{broken");
  const degraded = registerKeywordAcquisitionIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: (name) => handlers.delete(name) }, dataDir: corruptDir,
    getMainWindow: () => ({ webContents, isDestroyed: () => false }) });
  assert.equal((await handlers.get("keyword-acquisition:status")({ sender: webContents, senderFrame: frame })).code, "KEYWORD_STATE_INVALID", "A damaged module must not prevent the rest of the desktop app from starting");
  await degraded.dispose();
  console.log("keyword acquisition self-check passed (no platform login, sends or paid AI calls)");
}
main().finally(() => {
  const base = path.resolve(os.tmpdir()); const target = path.resolve(temporary); const relative = path.relative(base, target);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(target).startsWith("xiaoxi-keyword-self-check-"));
  fs.rmSync(target, { recursive: true, force: true });
}).catch((error) => { console.error(error); process.exitCode = 1; });
