const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildHandoffMessage,
  createAutoReplyController,
  exceedsRateLimit,
  isReplyableText,
  registerAutoReplyIpc
} = require("./auto-reply-ipc.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-auto-reply-v2-"));
const activeTouchDir = path.join(root, "active_touch");
fs.mkdirSync(activeTouchDir, { recursive: true });
fs.writeFileSync(path.join(activeTouchDir, "contacts.json"), JSON.stringify([
  { id: "c1", name: "张总", allowed: true, wechatAccountId: "wx-a", wechatId: "zhang" },
  { id: "c2", name: "李经理", allowed: true, wechatAccountId: "wx-a", wechatId: "li" },
  { id: "dup-1", name: "同名客户", allowed: true, wechatAccountId: "wx-a", wechatId: "dup1" },
  { id: "dup-2", name: "同名客户", allowed: true, wechatAccountId: "wx-a", wechatId: "dup2" },
  { id: "helper", name: "文件传输助手", allowed: true, wechatAccountId: "wx-a", wechatId: "filehelper" },
  { id: "group", name: "项目讨论", allowed: true, wechatAccountId: "wx-a", wechatId: "project", wxid: "group@chatroom" },
  { id: "official", name: "品牌服务号", allowed: true, wechatAccountId: "wx-a", wechatId: "brand", wxid: "gh_brand" },
  { id: "disabled", name: "已停用", allowed: false, wechatAccountId: "wx-a", wechatId: "disabled" }
]), "utf8");

async function main() {
  assert.equal(isReplyableText("你好，方便介绍一下吗？"), true);
  assert.equal(isReplyableText("[图片]"), false);
  assert.equal(isReplyableText("请把验证码和银行卡发给我"), false);
  assert.equal(exceedsRateLimit([], Date.now()), false);
  assert.equal(exceedsRateLimit(Array.from({ length: 29 }, (_, index) => ({ contact_id: "c1", at: new Date(Date.now() - index * 1000).toISOString() })), Date.now()), false);
  assert.equal(exceedsRateLimit(Array.from({ length: 30 }, (_, index) => ({ contact_id: `c${index}`, at: new Date(Date.now() - index * 1000).toISOString() })), Date.now()), true);
  assert.match(buildHandoffMessage({ conversation: "张总", reason: "客户询价", latest: "第二个方案多少钱", at: new Date("2026-07-14T10:00:00+08:00") }), /张总[\s\S]*客户询价[\s\S]*第二个方案多少钱[\s\S]*请人工跟进/);

  const candidates = [
    {
      ok: true,
      conversation: "张总",
      message: "第二个方案适合粉尘车间吗？",
      runtimeId: "message-1",
      pid: 81,
      hWnd: "91",
      context: [
        { role: "assistant", content: "我们有基础版和进阶版。", key: "a-1" },
        { role: "user", content: "第二个方案适合粉尘车间吗？", key: "u-1" }
      ]
    },
    {
      ok: true,
      conversation: "张总",
      message: "第二个方案适合粉尘车间吗？",
      runtimeId: "message-1",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "第二个方案适合粉尘车间吗？", key: "u-1" }]
    },
    {
      ok: true,
      conversation: "张总",
      message: "第二个方案适合粉尘车间吗？",
      runtimeId: "message-2",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "第二个方案适合粉尘车间吗？", key: "u-2" }]
    },
    {
      ok: true,
      conversation: "李经理",
      message: "人工已经回复了吗？",
      runtimeId: "message-3",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "人工已经回复了吗？", key: "u-3" }]
    }
  ];
  const decisions = [
    { reply: "我先根据场景继续帮您缩小范围。", intent: true, intentReason: "客户初步询价", needsHuman: false, handoffReason: "" },
    { reply: "收到，我继续帮您确认第二个方案。", intent: false, intentReason: "", needsHuman: false, handoffReason: "" },
    { reply: "我帮您确认一下，稍后回复您。", intent: false, intentReason: "", needsHuman: true, handoffReason: "资料未覆盖" }
  ];
  const scannedNames = [];
  const sent = [];
  const sentAttemptIds = [];
  const handoffs = [];
  const scheduledDelays = [];
  let verifyAllowed = true;
  let replyCalls = 0;
  const coordinator = {
    acquire: ({ state }) => state === "replying" ? { ok: true, lock: { owner: "reply-owner" } } : { ok: false },
    update: () => ({ ok: true }),
    release: () => ({ ok: true })
  };
  const controller = createAutoReplyController({
    dataDir: path.join(root, "auto_reply"),
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "业务信息：设备短租。意向判定：客户继续了解方案。" }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async ({ context, expert }) => {
        replyCalls += 1;
        assert.equal(context.at(-1).role, "user");
        assert.match(expert, /设备短租/);
        return decisions.shift();
      }
    },
    scanIncoming: (names) => {
      scannedNames.push([...names]);
      return candidates.shift() || { ok: false, reason: "no_unread_message" };
    },
    verifyIncoming: () => ({ ok: verifyAllowed }),
    send: async (options) => {
      sent.push(options.frozenContact.name);
      sentAttemptIds.push(options.attemptId);
      const allowed = await options.beforeDraft();
      return allowed ? { ok: true, state: { real_send_status: "sent_verified" } } : { ok: false, blocked_reason: "incoming_message_changed" };
    },
    sendHandoff: async ({ message }) => { handoffs.push(message); return { ok: true }; },
    runStep: async () => ({ ok: true }),
    schedule: (_callback, delay) => { scheduledDelays.push(delay); return 1; },
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });

  assert.equal((await controller.start()).ok, true);
  assert.equal(scheduledDelays[0], 0, "listener start must prime the current open conversation before the first five-second interval");
  await controller.runOnce();
  assert.equal(controller.status().reply_count, 1);
  assert.match(sentAttemptIds[0], /^[a-f0-9]{64}$/, "each incoming turn must supply a stable real-send attempt id");
  assert.equal(handoffs.length, 0, "interest that can continue through AI guidance must not alert a human");
  assert.deepEqual(scannedNames[0].sort(), ["张总", "李经理", "已停用"].sort(), "legacy whitelist flags must not narrow the synced private-contact scope");

  await controller.runOnce();
  assert.equal(sent.length, 1, "same runtime message must not send twice");
  assert.equal(replyCalls, 1, "duplicate must not call AI twice");

  await controller.runOnce();
  assert.equal(sent.length, 2, "same text with a new runtime identity is a new turn");
  assert.notEqual(sentAttemptIds[1], sentAttemptIds[0], "different incoming turns must not share a real-send attempt id");
  assert.equal(controller.status().reply_count, 2);

  verifyAllowed = false;
  await controller.runOnce();
  assert.equal(sent.length, 3);
  assert.equal(controller.status().last_event, "manual_reply_or_message_changed");
  assert.equal(controller.status().status, "running");
  assert.equal("contact_ids" in controller.status(), false);
  assert.equal("work_start" in controller.status(), false);
  assert.equal("skipped_count" in controller.status(), false);
  controller.pause();

  const recycledCandidates = [
    { message: "first inquiry", context: [{ role: "user", content: "first inquiry", key: "reused-slot" }] },
    { message: "second inquiry", context: [{ role: "user", content: "second inquiry", key: "reused-slot" }] },
    { message: "second inquiry", context: [{ role: "user", content: "second inquiry", key: "reused-slot" }] },
    { message: "second inquiry", runtimeId: "reused-slot-2", context: [
      { role: "assistant", content: "new preceding context", key: "history-new" },
      { role: "user", content: "second inquiry", key: "reused-slot-2" }
    ] }
  ].map((candidate) => ({
    ok: true,
    conversation: "张总",
    runtimeId: "reused-slot",
    pid: 81,
    hWnd: "91",
    ...candidate
  }));
  let recycledSends = 0;
  const recycledController = createAutoReplyController({
    dataDir: path.join(root, "recycled_runtime_id"),
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "Reply briefly." }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => ({ reply: "Acknowledged.", intent: false, intentReason: "", needsHuman: false, handoffReason: "" })
    },
    scanIncoming: () => recycledCandidates.shift() || { ok: false, reason: "no_unread_message" },
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      if (!(await options.beforeDraft())) return { ok: false, blocked_reason: "incoming_message_changed" };
      recycledSends += 1;
      return { ok: true };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await recycledController.start()).ok, true);
  await recycledController.runOnce();
  await recycledController.runOnce();
  assert.equal(recycledSends, 2, "a recycled UIA runtime id with different message content must be a new turn");
  await recycledController.runOnce();
  assert.equal(recycledSends, 2, "the exact same runtime id and context must still be deduplicated");
  await recycledController.runOnce();
  assert.equal(recycledSends, 3, "repeated text with a new runtime identity must remain a new turn");
  recycledController.pause();

  let releaseStartupPrime;
  let markStartupPrime;
  let startupSettled = false;
  const startupPrimeEntered = new Promise((resolve) => { markStartupPrime = resolve; });
  const startupPrimeGate = new Promise((resolve) => { releaseStartupPrime = resolve; });
  const startupDelays = [];
  const startupController = createAutoReplyController({
    dataDir: path.join(root, "startup_prime"),
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "礼貌回复。" }) },
    deepSeekClient: { assertAvailable: () => true },
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    primeIncoming: async () => {
      markStartupPrime();
      return startupPrimeGate;
    },
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: (_callback, delay) => { startupDelays.push(delay); return 1; },
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  const startup = startupController.start().then((result) => { startupSettled = true; return result; });
  await startupPrimeEntered;
  assert.equal(startupSettled, false, "start must not report running before the current-session baseline probe completes");
  assert.equal(startupController.status().status, "starting");
  releaseStartupPrime({ ok: true, primed: true });
  assert.equal((await startup).state.status, "running");
  assert.equal(startupDelays[0], 0);
  startupController.pause();

  const scrolledPrimeController = createAutoReplyController({
    dataDir: path.join(root, "startup_prime_scrolled"),
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "礼貌回复。" }) },
    deepSeekClient: { assertAvailable: () => true },
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    primeIncoming: async () => ({ ok: false, reason: "history_not_at_bottom" }),
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await scrolledPrimeController.start()).ok, false);
  assert.equal(scrolledPrimeController.status().status, "paused", "startup must stay paused when the current conversation is not at the bottom");
  assert.equal(scrolledPrimeController.status().last_event, "start_failed");

  let riskyHistoryAiCalls = 0;
  const riskyHistoryController = createAutoReplyController({
    dataDir: path.join(root, "risky_history"),
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "不得处理敏感信息。" }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => {
        riskyHistoryAiCalls += 1;
        return { reply: "收到。", intent: false, intentReason: "", needsHuman: false, handoffReason: "" };
      }
    },
    scanIncoming: () => ({
      ok: true,
      conversation: "张总",
      message: "那普通方案呢？",
      runtimeId: "risky-history-1",
      pid: 81,
      hWnd: "91",
      context: [
        { role: "user", content: "我的验证码是123456", key: "risky-old" },
        { role: "user", content: "那普通方案呢？", key: "safe-latest" }
      ]
    }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await riskyHistoryController.start()).ok, true);
  await riskyHistoryController.runOnce();
  assert.equal(riskyHistoryAiCalls, 0, "risky earlier history must never be sent to DeepSeek");
  assert.equal(riskyHistoryController.status().last_event, "unsupported_or_risky_message");
  riskyHistoryController.pause();

  let takeoverChecks = 0;
  const takeoverController = createAutoReplyController({
    dataDir: path.join(root, "takeover_after_draft"),
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "礼貌回复。" }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => ({ reply: "好的，我来说明。", intent: false, intentReason: "", needsHuman: false, handoffReason: "" })
    },
    scanIncoming: () => ({
      ok: true,
      conversation: "张总",
      message: "请继续说明",
      runtimeId: "takeover-after-draft",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "请继续说明", key: "takeover-user" }]
    }),
    verifyIncoming: () => ({ ok: ++takeoverChecks === 1 }),
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      assert.equal(typeof options.shouldContinue, "function");
      return (await options.shouldContinue())
        ? { ok: true }
        : { ok: false, blocked_reason: "batch_cancelled" };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await takeoverController.start()).ok, true);
  await takeoverController.runOnce();
  assert.equal(takeoverController.status().reply_count, 0);
  assert.equal(takeoverController.status().last_event, "manual_reply_or_message_changed");
  assert.equal(takeoverController.status().status, "running");
  takeoverController.pause();

  let pauseDuringSendController;
  pauseDuringSendController = createAutoReplyController({
    dataDir: path.join(root, "pause_during_send"),
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "礼貌回复。" }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => ({ reply: "收到。", intent: false, intentReason: "", needsHuman: false, handoffReason: "" })
    },
    scanIncoming: () => ({
      ok: true,
      conversation: "张总",
      message: "暂停测试",
      runtimeId: "pause-during-send",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "暂停测试", key: "pause-during-send" }]
    }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => {
      pauseDuringSendController.pause();
      return { ok: false, blocked_reason: "batch_cancelled" };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await pauseDuringSendController.start()).ok, true);
  await pauseDuringSendController.runOnce();
  assert.equal(pauseDuringSendController.status().status, "paused");
  assert.equal(pauseDuringSendController.status().last_event, "paused_by_user");
  assert.equal(pauseDuringSendController.status().last_error, "");

  let resolveOldReply;
  let markOldReplyStarted;
  let expertText = "旧话术";
  let staleSendCalls = 0;
  const oldReplyStarted = new Promise((resolve) => { markOldReplyStarted = resolve; });
  const oldReply = new Promise((resolve) => { resolveOldReply = resolve; });
  const staleRunController = createAutoReplyController({
    dataDir: path.join(root, "stale_run_epoch"),
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: expertText }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async ({ expert }) => {
        assert.equal(expert, "旧话术");
        markOldReplyStarted();
        return oldReply;
      }
    },
    scanIncoming: () => ({
      ok: true,
      conversation: "张总",
      message: "旧请求",
      runtimeId: "stale-run",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "旧请求", key: "stale-run" }]
    }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => { staleSendCalls += 1; return { ok: true }; },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await staleRunController.start()).ok, true);
  const staleRun = staleRunController.runOnce();
  await oldReplyStarted;
  staleRunController.pause();
  expertText = "新话术";
  const staleRestart = staleRunController.start();
  resolveOldReply({ reply: "旧话术生成的回复", intent: false, intentReason: "", needsHuman: false, handoffReason: "" });
  await staleRun;
  assert.equal((await staleRestart).ok, true);
  assert.equal(staleSendCalls, 0, "pause, expert replacement, and restart must invalidate the old generation epoch");
  assert.equal(staleRunController.status().status, "running");
  staleRunController.pause();

  const handoffCandidates = ["intent-1", "intent-2"].map((runtimeId) => ({
    ok: true,
    conversation: "张总",
    message: "请给我第二个方案的正式报价，我准备下单",
    runtimeId,
    pid: 81,
    hWnd: "91",
    context: [{ role: "user", content: "请给我第二个方案的正式报价，我准备下单", key: "same-intent-context" }]
  }));
  let deduplicatedHandoffs = 0;
  const handoffDataDir = path.join(root, "handoff_dedupe");
  const handoffController = createAutoReplyController({
    dataDir: handoffDataDir,
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "人工提醒：客户明确要求正式报价或下单时提醒人工。" }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => ({ reply: "收到，我把正式报价需求交给同事确认。", intent: true, intentReason: "客户准备下单", needsHuman: true, handoffReason: "需要正式报价" })
    },
    scanIncoming: () => handoffCandidates.shift() || { ok: false, reason: "no_unread_message" },
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => (await options.beforeDraft()) ? { ok: true } : { ok: false },
    sendHandoff: async ({ message }) => {
      assert.match(message, /原因：需要正式报价/);
      deduplicatedHandoffs += 1;
      return { ok: true };
    },
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await handoffController.start()).ok, true);
  await handoffController.runOnce();
  await handoffController.runOnce();
  assert.equal(handoffController.status().reply_count, 2);
  assert.equal(deduplicatedHandoffs, 1, "the same intent context must alert only once");
  assert.equal(JSON.parse(fs.readFileSync(path.join(handoffDataDir, "auto-reply-state.json"), "utf8")).pending_handoff, null, "a verified handoff must clear its pending identity");
  handoffController.pause();

  const pauseDuringHandoffDir = path.join(root, "pause_during_handoff");
  let resolvePendingHandoff;
  let markHandoffStarted;
  const handoffStarted = new Promise((resolve) => { markHandoffStarted = resolve; });
  const pendingHandoffResult = new Promise((resolve) => { resolvePendingHandoff = resolve; });
  const pauseDuringHandoffController = createAutoReplyController({
    dataDir: pauseDuringHandoffDir,
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "需要人工跟进。" }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => ({ reply: "这个问题我帮您确认一下，稍后回复您。", intent: false, intentReason: "", needsHuman: true, handoffReason: "需要人工确认" })
    },
    scanIncoming: () => ({
      ok: true,
      conversation: "张总",
      message: "请人工确认",
      runtimeId: "pause-during-handoff-1",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "请人工确认", key: "pause-during-handoff-1" }]
    }),
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => (await options.beforeDraft()) ? { ok: true } : { ok: false },
    sendHandoff: async () => {
      markHandoffStarted();
      return pendingHandoffResult;
    },
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await pauseDuringHandoffController.start()).ok, true);
  const pendingRun = pauseDuringHandoffController.runOnce();
  await handoffStarted;
  pauseDuringHandoffController.pause();
  const pausedHandoffState = JSON.parse(fs.readFileSync(path.join(pauseDuringHandoffDir, "auto-reply-state.json"), "utf8"));
  assert.equal(pausedHandoffState.last_event, "handoff_confirmation_required", "pausing during handoff must require an explicit manual check");
  assert.match(pausedHandoffState.last_error, /张总/);
  resolvePendingHandoff({ ok: true });
  await pendingRun;

  const unknownDataDir = path.join(root, "unknown_handoff");
  const unknownController = createAutoReplyController({
    dataDir: unknownDataDir,
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "无法回答：我帮您确认一下，稍后回复您。" }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => ({ reply: "这个问题我帮您确认一下，稍后回复您。", intent: false, intentReason: "模型附带的次要解释", needsHuman: true, handoffReason: "资料未覆盖" })
    },
    scanIncoming: () => ({
      ok: true,
      conversation: "李经理",
      message: "这个尺寸能定制吗？",
      runtimeId: "unknown-1",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "这个尺寸能定制吗？", key: "unknown-context" }]
    }),
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => (await options.beforeDraft()) ? { ok: true } : { ok: false },
    sendHandoff: async ({ message }) => {
      assert.match(message, /原因：资料未覆盖/, "unknown-problem handoffs must prefer handoffReason over an unrelated intentReason");
      const persisted = JSON.parse(fs.readFileSync(path.join(unknownDataDir, "auto-reply-state.json"), "utf8"));
      assert.equal(persisted.reply_count, 1, "verified customer reply must be durable before handoff I/O");
      assert.equal(Object.values(persisted.processed).at(-1).status, "sent_verified");
      assert.equal(persisted.last_event, "handoff_pending");
      assert.equal(persisted.pending_handoff.conversation, "李经理", "the pending handoff identity must be durable before handoff I/O");
      assert.match(persisted.pending_handoff.key, /^[a-f0-9]{64}$/, "the pending handoff must persist its dedupe key before handoff I/O");
      return { ok: false, blocked_reason: "handoff_outcome_unknown" };
    },
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await unknownController.start()).ok, true);
  await unknownController.runOnce();
  assert.equal(unknownController.status().reply_count, 1, "safe placeholder is sent before handoff");
  assert.equal(unknownController.status().status, "paused");
  assert.equal(unknownController.status().last_event, "handoff_confirmation_required");
  assert.match(unknownController.status().last_error, /文件传输助手人工检查，确认后点击确认按钮继续/);

  const pendingBeforeRestart = JSON.parse(fs.readFileSync(path.join(unknownDataDir, "auto-reply-state.json"), "utf8")).pending_handoff;
  const blockedPendingController = createAutoReplyController({
    dataDir: unknownDataDir,
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "有效话术" }) },
    deepSeekClient: { assertAvailable: () => { throw new Error("依赖预检失败"); } },
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal(blockedPendingController.status().last_event, "handoff_confirmation_required", "a pending handoff must remain confirmation-required after controller reconstruction");
  assert.equal((await blockedPendingController.start()).ok, false, "failed dependency preflight must not acknowledge a pending handoff");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(unknownDataDir, "auto-reply-state.json"), "utf8")).pending_handoff, pendingBeforeRestart);

  const confirmedPendingController = createAutoReplyController({
    dataDir: unknownDataDir,
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "有效话术" }) },
    deepSeekClient: { assertAvailable: () => true },
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal(confirmedPendingController.status().last_event, "handoff_confirmation_required");
  assert.equal((await confirmedPendingController.start()).ok, true, "the trusted start action is the explicit manual acknowledgement");
  const acknowledgedPendingState = JSON.parse(fs.readFileSync(path.join(unknownDataDir, "auto-reply-state.json"), "utf8"));
  assert.equal(acknowledgedPendingState.pending_handoff, null);
  assert.equal(acknowledgedPendingState.handoff_notified[pendingBeforeRestart.key].status, "manual_acknowledged");
  confirmedPendingController.pause();

  const aiConfigFailureDir = path.join(root, "ai_configuration_failure");
  let aiConfigFailureSends = 0;
  let aiConfigFailureHandoffs = 0;
  const aiConfigFailureController = createAutoReplyController({
    dataDir: aiConfigFailureDir,
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "业务信息：工业清洁设备。" }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => ({
        reply: "这个问题我帮您确认一下，稍后回复您。",
        intent: false,
        intentReason: "",
        needsHuman: true,
        handoffReason: "DeepSeek(API_KEY_INVALID)需要人工跟进",
        pauseAfterHandoff: true,
        pauseReason: "DeepSeek API Key 无效"
      })
    },
    scanIncoming: () => ({
      ok: true,
      conversation: "张总",
      message: "想了解清洁设备",
      runtimeId: "ai-failure-retry-1",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "想了解清洁设备", key: "ai-failure-retry-1" }]
    }),
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      aiConfigFailureSends += 1;
      return (await options.beforeDraft()) ? { ok: true } : { ok: false };
    },
    sendHandoff: async ({ message }) => {
      aiConfigFailureHandoffs += 1;
      assert.match(message, /API_KEY_INVALID/);
      return { ok: true };
    },
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await aiConfigFailureController.start()).ok, true);
  await aiConfigFailureController.runOnce();
  assert.equal(aiConfigFailureSends, 1, "persistent AI failures must not lose the already-scanned incoming message");
  assert.equal(aiConfigFailureHandoffs, 1, "persistent AI failures must alert a human before pausing");
  assert.equal(aiConfigFailureController.status().reply_count, 1);
  assert.equal(aiConfigFailureController.status().status, "paused");
  assert.equal(aiConfigFailureController.status().last_event, "ai_configuration_paused");
  assert.match(aiConfigFailureController.status().last_error, /API Key 无效/);

  const rateCases = [
    {
      name: "global",
      events: Array.from({ length: 30 }, (_, index) => ({ contact_id: `other-${index}`, at: new Date(Date.parse("2026-07-14T10:00:00+08:00") - index * 1000).toISOString() }))
    }
  ];
  for (const rateCase of rateCases) {
    const rateDir = path.join(root, `rate_${rateCase.name}`);
    fs.mkdirSync(rateDir, { recursive: true });
    fs.writeFileSync(path.join(rateDir, "auto-reply-state.json"), JSON.stringify({ version: 2, status: "paused", daily_date: "2026-07-14", rate_events: rateCase.events }), "utf8");
    let rateAiCalls = 0;
    let rateSendCalls = 0;
    const rateController = createAutoReplyController({
      dataDir: rateDir,
      activeTouchDir,
      coordinator,
      expertStore: { read: () => ({ text: "安全话术" }) },
      deepSeekClient: { assertAvailable: () => true, reply: async () => { rateAiCalls += 1; return {}; } },
      scanIncoming: () => ({
        ok: true,
        conversation: "张总",
        message: "继续",
        runtimeId: `rate-${rateCase.name}`,
        pid: 81,
        hWnd: "91",
        context: [{ role: "user", content: "继续", key: `rate-${rateCase.name}` }]
      }),
      verifyIncoming: () => ({ ok: true }),
      send: async () => { rateSendCalls += 1; return { ok: true }; },
      sendHandoff: async () => ({ ok: true }),
      runStep: async () => ({ ok: true }),
      schedule: () => 1,
      cancelSchedule: () => undefined,
      now: () => new Date("2026-07-14T10:00:00+08:00")
    });
    assert.equal((await rateController.start()).ok, true);
    await rateController.runOnce();
    assert.equal(rateController.status().status, "paused");
    assert.equal(rateController.status().last_event, "rate_limit_paused");
    assert.equal(rateAiCalls, 0);
    assert.equal(rateSendCalls, 0);
  }

  for (const coordinatorFailure of [
    {
      name: "acquire",
      expectedEvent: "auto_reply_error_paused",
      coordinator: {
        acquire: () => { throw new Error("runtime lock acquire failed"); },
        update: () => ({ ok: true }),
        release: () => ({ ok: true })
      }
    },
    {
      name: "release",
      expectedEvent: "runtime_lock_release_failed_paused",
      coordinator: {
        acquire: () => ({ ok: true, lock: { owner: "throwing-release-owner" } }),
        update: () => ({ ok: true }),
        release: () => { throw new Error("runtime lock release failed"); }
      }
    }
  ]) {
    const scheduledCallbacks = [];
    const failureController = createAutoReplyController({
      dataDir: path.join(root, `coordinator_${coordinatorFailure.name}_failure`),
      activeTouchDir,
      coordinator: coordinatorFailure.coordinator,
      expertStore: { read: () => ({ text: "有效话术" }) },
      deepSeekClient: { assertAvailable: () => true },
      send: async () => ({ ok: true }),
      sendHandoff: async () => ({ ok: true }),
      runStep: async () => ({ ok: true }),
      scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
      verifyIncoming: () => ({ ok: true }),
      schedule: (callback) => { scheduledCallbacks.push(callback); return scheduledCallbacks.length; },
      cancelSchedule: () => undefined,
      now: () => new Date("2026-07-14T10:00:00+08:00")
    });
    assert.equal((await failureController.start()).ok, true);
    assert.equal(scheduledCallbacks.length, 1);
    await assert.doesNotReject(() => scheduledCallbacks[0](), `${coordinatorFailure.name} failure must not escape the scheduled callback`);
    assert.equal(failureController.status().status, "paused");
    assert.equal(failureController.status().last_event, coordinatorFailure.expectedEvent);
    assert.match(failureController.status().last_error, new RegExp(`runtime lock ${coordinatorFailure.name} failed`));
    assert.equal(scheduledCallbacks.length, 1, "a failed poll must not silently remain running or schedule another poll");
  }

  const handlers = new Map();
  const webContents = {};
  registerAutoReplyIpc({
    dataDir: path.join(root, "ipc_auto_reply"),
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "test" }) },
    deepSeekClient: { assertAvailable: () => true },
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    verifyIncoming: () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    getMainWindow: () => ({ isDestroyed: () => false, isFocused: () => true, webContents }),
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }
  });
  assert.deepEqual([...handlers.keys()].sort(), ["auto-reply:pause", "auto-reply:start", "auto-reply:status"]);
  assert.equal((await handlers.get("auto-reply:start")({ sender: webContents }, {})).ok, false);
  assert.equal((await handlers.get("auto-reply:start")({ sender: webContents }, { clickToken: "trusted" })).ok, true);

  const recoveryDir = path.join(root, "recovery_auto_reply");
  fs.mkdirSync(recoveryDir, { recursive: true });
  fs.writeFileSync(path.join(recoveryDir, "auto-reply-state.json"), JSON.stringify({ version: 1, status: "running", daily_date: "2026-07-14", reply_count: 7, contact_ids: ["c1"], processed: { old: true } }), "utf8");
  const recovered = createAutoReplyController({
    dataDir: recoveryDir,
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "test" }) },
    deepSeekClient: { assertAvailable: () => true },
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    verifyIncoming: () => ({ ok: true }),
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  const migratedState = JSON.parse(fs.readFileSync(path.join(recoveryDir, "auto-reply-state.json"), "utf8"));
  assert.equal(migratedState.version, 2);
  assert.deepEqual(migratedState.processed, {}, "legacy fingerprints must be discarded during v1 migration");
  assert.equal("contact_ids" in migratedState, false, "legacy whitelist state must be discarded during v1 migration");
  assert.equal(recovered.status().status, "paused");
  assert.equal(recovered.status().reply_count, 7);
  assert.equal(recovered.status().last_event, "state_upgraded_paused");
  assert.deepEqual(Object.keys(recovered.status()).sort(), ["last_error", "last_event", "reply_count", "status", "updated_at"].sort(), "public v2 state must expose only the five documented fields");

  const runningRecoveryDir = path.join(root, "running_recovery_auto_reply");
  fs.mkdirSync(runningRecoveryDir, { recursive: true });
  fs.writeFileSync(path.join(runningRecoveryDir, "auto-reply-state.json"), JSON.stringify({ version: 2, status: "running", daily_date: "2026-07-14", reply_count: 2 }), "utf8");
  const runningRecovery = createAutoReplyController({
    dataDir: runningRecoveryDir,
    activeTouchDir,
    coordinator,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal(runningRecovery.status().status, "paused");
  assert.equal(runningRecovery.status().last_event, "recovered_after_restart");
  assert.equal(JSON.parse(fs.readFileSync(path.join(runningRecoveryDir, "auto-reply-state.json"), "utf8")).status, "paused");

  const startingRecoveryDir = path.join(root, "starting_recovery");
  fs.mkdirSync(startingRecoveryDir, { recursive: true });
  fs.writeFileSync(path.join(startingRecoveryDir, "auto-reply-state.json"), JSON.stringify({ version: 2, status: "starting", daily_date: "2026-07-14", reply_count: 2 }), "utf8");
  const startingRecovery = createAutoReplyController({
    dataDir: startingRecoveryDir,
    activeTouchDir,
    coordinator,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal(startingRecovery.status().status, "paused", "a crash during baseline priming must recover paused");
  assert.equal(startingRecovery.status().last_event, "recovered_after_restart");

  const interruptedHandoffDir = path.join(root, "interrupted_handoff_recovery");
  fs.mkdirSync(interruptedHandoffDir, { recursive: true });
  fs.writeFileSync(path.join(interruptedHandoffDir, "auto-reply-state.json"), JSON.stringify({
    version: 2,
    status: "running",
    daily_date: "2026-07-14",
    reply_count: 1,
    last_event: "handoff_pending",
    pending_handoff: { key: "pending-handoff-key", contact_id: "c1", conversation: "张总", at: "2026-07-14T02:00:00.000Z" },
    processed: {
      pending: { status: "sent_verified", contact_id: "c1", conversation: "张总", at: "2026-07-14T02:00:00.000Z" },
      newerUnrelated: { status: "sent_verified", contact_id: "c2", conversation: "李经理", at: "2026-07-14T03:00:00.000Z" }
    }
  }), "utf8");
  const interruptedHandoff = createAutoReplyController({
    dataDir: interruptedHandoffDir,
    activeTouchDir,
    coordinator,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal(interruptedHandoff.status().status, "paused");
  assert.equal(interruptedHandoff.status().last_event, "handoff_confirmation_required");
  assert.match(interruptedHandoff.status().last_error, /人工检查/);
  assert.match(interruptedHandoff.status().last_error, /张总/, "an interrupted handoff must identify the customer without persisting message text");
  assert.doesNotMatch(interruptedHandoff.status().last_error, /李经理/, "an interrupted handoff must not point at an older verified customer");

  const midnightDir = path.join(root, "midnight_auto_reply");
  fs.mkdirSync(midnightDir, { recursive: true });
  fs.writeFileSync(path.join(midnightDir, "auto-reply-state.json"), JSON.stringify({ version: 2, status: "paused", daily_date: "2026-07-13", reply_count: 4 }), "utf8");
  const afterMidnight = createAutoReplyController({
    dataDir: midnightDir,
    activeTouchDir,
    coordinator,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(midnightDir, "auto-reply-state.json"), "utf8")).reply_count, 0, "v2 day rollover must persist during recovery");
  assert.equal(afterMidnight.status().reply_count, 0, "paused status must not show yesterday's replies as today's count");
  assert.equal(JSON.parse(fs.readFileSync(path.join(midnightDir, "auto-reply-state.json"), "utf8")).reply_count, 0);

  const crossingDir = path.join(root, "midnight_crossing_send");
  let crossingClock = new Date("2026-07-14T23:59:59+08:00");
  const crossingController = createAutoReplyController({
    dataDir: crossingDir,
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "礼貌回复。" }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => ({ reply: "新的一天收到。", intent: false, intentReason: "", needsHuman: false, handoffReason: "" })
    },
    scanIncoming: () => ({
      ok: true,
      conversation: "张总",
      message: "跨天测试",
      runtimeId: "midnight-crossing",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "跨天测试", key: "midnight-crossing" }]
    }),
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      crossingClock = new Date("2026-07-15T00:00:01+08:00");
      return { ok: true };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => crossingClock
  });
  assert.equal((await crossingController.start()).ok, true);
  await crossingController.runOnce();
  const crossingState = JSON.parse(fs.readFileSync(path.join(crossingDir, "auto-reply-state.json"), "utf8"));
  assert.equal(crossingState.daily_date, "2026-07-15");
  assert.equal(crossingState.reply_count, 1, "a reply verified after midnight must count toward the new day");
  crossingController.pause();
  console.log("auto-reply v2 self-check passed");
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
