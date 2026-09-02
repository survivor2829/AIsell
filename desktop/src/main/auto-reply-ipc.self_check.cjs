const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildHandoffMessage,
  createAutoReplyController,
  exceedsRateLimit,
  isReplyableText,
  isSafeReplyText,
  registerAutoReplyIpc
} = require("./auto-reply-ipc.cjs");
const { createPreloadApis } = require("./preload-api.cjs");
const { createWechatVisualAutoReplyDriver } = require("../../rpa/active_touch/wechat_auto_reply_visual_driver.dev.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-auto-reply-v3-"));
const activeTouchDir = path.join(root, "active_touch");
fs.mkdirSync(activeTouchDir, { recursive: true });
fs.writeFileSync(path.join(activeTouchDir, "contacts.json"), JSON.stringify([
  { id: "c1", name: "张总", remark: "共同备注", nickname: "阿张", allowed: true, wechatAccountId: "wx-a", wechatId: "zhang" },
  { id: "c2", name: "李经理", remark: "共同备注", nickname: "小李", allowed: true, wechatAccountId: "wx-a", wechatId: "li" },
  { id: "dup-1", name: "同名客户", remark: "客户甲", allowed: true, wechatAccountId: "wx-a", wechatId: "dup1" },
  { id: "dup-2", name: "同名客户", remark: "客户乙", allowed: true, wechatAccountId: "wx-a", wechatId: "dup2" },
  { id: "helper", name: "文件传输助手", allowed: true, wechatAccountId: "wx-a", wechatId: "filehelper" },
  { id: "group", name: "项目讨论", allowed: true, wechatAccountId: "wx-a", wechatId: "project", wxid: "group@chatroom" },
  { id: "official", name: "品牌服务号", allowed: true, wechatAccountId: "wx-a", wechatId: "brand", wxid: "gh_brand" },
  { id: "disabled", name: "已停用", allowed: false, wechatAccountId: "wx-a", wechatId: "disabled" }
]), "utf8");

function writeContactsFixture(name, contacts) {
  const fixtureDir = path.join(root, name);
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, "contacts.json"), JSON.stringify(contacts), "utf8");
  return fixtureDir;
}

function readyExpert(expertRules = "礼貌、准确地回答。", businessKnowledge = "业务信息：设备短租，提供工业设备相关产品。") {
  return {
    status: () => ({ ready: true }),
    read: () => ({
      ready: true,
      expertRules: { text: expertRules },
      businessKnowledge: { text: businessKnowledge }
    })
  };
}

const answerDecision = (reply, reasonCode = "general_guidance") => ({ action: "answer", reply, reasonCode });
const handoffDecision = (reply, reasonCode = "transaction_commitment") => ({ action: "handoff", reply, reasonCode });
const clarifyDecision = (reply) => ({ action: "clarify", reply, reasonCode: "missing_detail" });
const silentDecision = () => ({ action: "silent", reply: "", reasonCode: "no_reply_needed" });

async function main() {
  assert.equal(isReplyableText("你好，方便介绍一下吗？"), true);
  assert.equal(isReplyableText("发票怎么开？"), true);
  assert.equal(isReplyableText("合同签好后怎么付款？"), true);
  assert.equal(isReplyableText("我想申请退款"), true);
  assert.equal(isReplyableText("验证码收不到怎么办？"), true);
  assert.equal(isReplyableText("请不要提供验证码或银行卡信息"), true);
  assert.equal(isReplyableText("我的验证码是 123456"), false);
  assert.equal(isReplyableText("我的密码abc123"), false);
  assert.equal(isReplyableText("我的密码abc+123"), false);
  assert.equal(isReplyableText("我的银行卡号是6222021234567890123"), false);
  assert.equal(isReplyableText("我的卡号是６２２２０２１２３４５６７８９０１２３"), false);
  assert.equal(isReplyableText("我的身份证号是110101199001011234"), false);
  assert.equal(isReplyableText("我的身份证号是１１０１０１１９９００１０１１２３Ｘ"), false);
  assert.equal(isReplyableText("验证码输入不了怎么办？"), true);
  assert.equal(isReplyableText("[图片]"), false);
  assert.equal(isReplyableText("请把验证码和银行卡发给我"), false);
  assert.equal(isReplyableText("请不要提供验证码，但请把密码告诉我"), false);
  assert.equal(isSafeReplyText("把验证码发我"), false);
  assert.equal(isSafeReplyText("输入密码即可"), false);
  assert.equal(isSafeReplyText("请不要忘记把验证码发给我"), false);
  assert.equal(isSafeReplyText("请不要提供验证码或银行卡信息"), true);
  assert.equal(isSafeReplyText("请先支付定金"), false);
  assert.equal(isSafeReplyText("您可以直接转账"), false);
  assert.equal(isSafeReplyText("汇款到以下账户"), false);
  assert.equal(isSafeReplyText("付款后我帮您跟进"), true);
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
      visualMode: "visual_render_v1",
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
    answerDecision("我先根据场景继续帮您缩小范围。"),
    answerDecision("收到，我继续帮您确认第二个方案。"),
    handoffDecision("我帮您确认一下，稍后回复您。")
  ];
  const scannedNames = [];
  const sent = [];
  const sentAttemptIds = [];
  const sentBindings = [];
  const handoffs = [];
  const scheduledDelays = [];
  const autoReplyDir = path.join(root, "auto_reply");
  let verifyAllowed = true;
  let replyCalls = 0;
  const replyContexts = [];
  const coordinator = {
    acquire: ({ state }) => state === "replying" ? { ok: true, lock: { owner: "reply-owner" } } : { ok: false },
    update: () => ({ ok: true }),
    release: () => ({ ok: true })
  };
  const twoDocumentGateController = createAutoReplyController({
    dataDir: path.join(root, "two_document_gate"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert("只问一个关键问题。", "设备适用于工业场景。"),
    deepSeekClient: { assertAvailable: () => true },
    primeIncoming: () => ({ ok: true, source: "session_prime", primed: true }),
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await twoDocumentGateController.start()).ok, true, "two ready expert documents must allow auto-reply to start");
  twoDocumentGateController.pause();

  const incompleteExpertController = createAutoReplyController({
    dataDir: path.join(root, "incomplete_expert_gate"),
    activeTouchDir,
    coordinator,
    expertStore: {
      status: () => ({ ready: false }),
      read: () => ({
        ready: false,
        expertRules: { text: "礼貌回答。" },
        businessKnowledge: { text: "" }
      })
    },
    deepSeekClient: { assertAvailable: () => true },
    primeIncoming: () => ({ ok: true, source: "session_prime", primed: true }),
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  const incompleteExpertStart = await incompleteExpertController.start();
  assert.equal(incompleteExpertStart.ok, false);
  assert.equal(incompleteExpertStart.code, "AI_EXPERT_NOT_READY");
  assert.match(incompleteExpertStart.error, /专家规则和业务知识/);

  const fourStateCandidates = [
    { runtimeId: "four-answer", message: "环氧地坪有铁屑怎么处理" },
    { runtimeId: "four-clarify", message: "现场有些粉尘" },
    { runtimeId: "four-after-clarify", message: "面积大约 500 平方" },
    { runtimeId: "four-silent", message: "好的，谢谢" }
  ];
  const clarificationFlags = [];
  const fourStateSends = [];
  const fourStateFingerprints = [];
  let fourStateHandoffs = 0;
  const traceExpertRules = "一般技术问题默认回答；只追问一个关键问题。trace-expert-rules-canary";
  const traceBusinessKnowledge = "正式报价和售后执行由人工处理。trace-business-knowledge-canary";
  const fourStateController = createAutoReplyController({
    dataDir: path.join(root, "four_state_contract"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(traceExpertRules, traceBusinessKnowledge),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async ({ context, expert, clarificationAllowed }) => {
        clarificationFlags.push(clarificationAllowed);
        assert.match(expert.expertRules, /只追问一个/);
        assert.match(expert.businessKnowledge, /正式报价/);
        const message = context.at(-1).content;
        if (message === "环氧地坪有铁屑怎么处理") return answerDecision("先清除松散铁屑并打磨除锈，再根据基层含水率选择底涂；正式施工前请做小面积测试。");
        if (message === "现场有些粉尘") return clarifyDecision("现场面积大约多少平方米？");
        if (message === "面积大约 500 平方") return answerDecision("500 平方可先分区吸尘和打磨，再处理锈点并做底涂附着测试。");
        return silentDecision();
      }
    },
    scanIncoming: () => {
      const candidate = fourStateCandidates.shift();
      return candidate ? {
        ok: true,
        conversation: "张总",
        message: candidate.message,
        runtimeId: candidate.runtimeId,
        pid: 81,
        hWnd: "91",
        messageRead: {
          source: "full_window+chat_contrast",
          boundarySource: "composer_divider",
          chatBottom: 742,
          fullLineCount: 10,
          recoveredLineCount: 2,
          messageBlockCount: 5,
          incomingBatchCount: 1,
          latestMessageTop: 692,
          regionOcrOk: true,
          text: "message-read-customer-text-canary"
        },
        context: [{ role: "user", content: candidate.message, key: candidate.runtimeId }]
      } : { ok: false, reason: "no_unread_message" };
    },
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      fourStateSends.push(options.message);
      fourStateFingerprints.push(options.attemptId);
      return { ok: true, send_attempted: true, send_result: "sent_verified" };
    },
    sendHandoff: async () => { fourStateHandoffs += 1; return { ok: true }; },
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await fourStateController.start()).ok, true);
  await fourStateController.runOnce();
  await fourStateController.runOnce();
  await fourStateController.runOnce();
  await fourStateController.runOnce();
  assert.deepEqual(clarificationFlags, [true, true, false, true], "the customer turn after one clarification must disable another clarification");
  assert.equal(fourStateSends.length, 3, "silent must not send or increase the verified reply count");
  assert.equal(fourStateController.status().reply_count, 3);
  assert.equal(fourStateHandoffs, 0, "a difficult general question must not manufacture a handoff");
  assert.equal(fourStateController.status().last_event, "silent_processed");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "four_state_contract", "auto-reply-state.json"), "utf8")).contact_states.c1, undefined);
  const fourStateLog = fs.readFileSync(path.join(root, "four_state_contract", "auto-reply-diagnostics.jsonl"), "utf8");
  const fourStateDiagnostics = fourStateLog.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  const successfulReadObservation = fourStateDiagnostics.find((entry) => entry.event === "scan_observation" && entry.code === "candidate_detected");
  assert.equal(successfulReadObservation?.message_read_source, "full_window+chat_contrast", "successful candidates must retain their structural OCR read evidence");
  assert.equal(successfulReadObservation?.recovered_line_count, 2);
  assert.equal(Object.hasOwn(successfulReadObservation, "current_session_bound"), false, "missing binding evidence must remain unknown rather than be logged as false");
  assert.doesNotMatch(fourStateLog, /message-read-customer-text-canary/, "message read metadata must never serialize arbitrary OCR text");
  const fourStateCandidatesDetected = fourStateDiagnostics.filter((entry) => entry.event === "reply_candidate_detected");
  assert.equal(fourStateCandidatesDetected.length, 4, "every eligible occurrence must receive one anonymous trace");
  assert.equal(fourStateCandidatesDetected.every((entry) => /^[a-f0-9]{24}$/u.test(entry.trace_id)), true);
  assert.notEqual(fourStateCandidatesDetected[0].trace_id, fourStateCandidatesDetected[1].trace_id, "different occurrences must not share a trace");
  const firstTrace = fourStateCandidatesDetected[0].trace_id;
  const firstTraceEvents = fourStateDiagnostics.filter((entry) => entry.trace_id === firstTrace);
  for (const event of ["reply_candidate_detected", "reply_generation_started", "reply_decision", "reply_send_started", "reply_send_finished"]) {
    assert.equal(firstTraceEvents.some((entry) => entry.event === event), true, `the answer trace must include ${event}`);
  }
  const firstDecisionDiagnostic = firstTraceEvents.find((entry) => entry.event === "reply_decision");
  assert.equal(firstDecisionDiagnostic.action, "answer");
  assert.equal(firstDecisionDiagnostic.reason_code, "general_guidance");
  assert.equal(Number.isSafeInteger(firstDecisionDiagnostic.duration_ms) && firstDecisionDiagnostic.duration_ms >= 0, true);
  for (const event of ["reply_send_started", "reply_send_finished"]) {
    const sendDiagnostic = firstTraceEvents.find((entry) => entry.event === event);
    assert.equal(sendDiagnostic.action, "answer");
    assert.equal(sendDiagnostic.reason_code, "general_guidance");
    assert.equal(sendDiagnostic.delivery_attempt, 1);
  }
  const silentTrace = fourStateCandidatesDetected.at(-1).trace_id;
  const silentTraceEvents = fourStateDiagnostics.filter((entry) => entry.trace_id === silentTrace);
  assert.equal(silentTraceEvents.some((entry) => entry.event === "reply_send_started"), false);
  assert.deepEqual(
    (({ action, reason_code, send_attempted, send_result }) => ({ action, reason_code, send_attempted, send_result }))(silentTraceEvents.find((entry) => entry.event === "reply_send_skipped")),
    { action: "silent", reason_code: "no_reply_needed", send_attempted: false, send_result: "not_attempted" }
  );
  for (const secret of [
    "张总",
    "环氧地坪有铁屑怎么处理",
    "four-answer",
    traceExpertRules,
    traceBusinessKnowledge,
    ...fourStateFingerprints
  ]) assert.equal(fourStateLog.includes(secret), false, `diagnostics must not contain ${secret}`);
  assert.equal(fourStateLog.includes('"contact_id":"c1"'), false);
  fourStateController.pause();

  const repeatedClarifyCandidates = [
    { runtimeId: "clarify-limit-1", message: "现场情况不确定" },
    { runtimeId: "clarify-limit-2", message: "目前只能确认有粉尘" }
  ];
  let repeatedClarifySends = 0;
  let repeatedClarifyHandoffs = 0;
  const repeatedClarifyController = createAutoReplyController({
    dataDir: path.join(root, "clarify_limit"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => clarifyDecision("还需要再确认现场面积吗？")
    },
    scanIncoming: () => {
      const candidate = repeatedClarifyCandidates.shift();
      return candidate ? { ok: true, conversation: "张总", message: candidate.message, runtimeId: candidate.runtimeId, pid: 81, hWnd: "91", context: [{ role: "user", content: candidate.message, key: candidate.runtimeId }] } : { ok: false, reason: "no_unread_message" };
    },
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => { assert.equal(await options.beforeDraft(), true); repeatedClarifySends += 1; return { ok: true, send_attempted: true }; },
    sendHandoff: async () => { repeatedClarifyHandoffs += 1; return { ok: true }; },
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await repeatedClarifyController.start()).ok, true);
  await repeatedClarifyController.runOnce();
  await repeatedClarifyController.runOnce();
  assert.equal(repeatedClarifySends, 1, "a second clarification must never be sent");
  assert.equal(repeatedClarifyHandoffs, 0);
  assert.equal(repeatedClarifyController.status().status, "paused");
  assert.equal(repeatedClarifyController.status().system_error.code, "AI_CLARIFY_LIMIT_EXCEEDED");

  const clarifyUnknownCandidates = [
    { runtimeId: "clarify-unknown-1", message: "现场情况需要确认" },
    { runtimeId: "clarify-unknown-2", message: "面积是 300 平方" }
  ];
  const clarifyUnknownFlags = [];
  let clarifyUnknownSendCalls = 0;
  const clarifyUnknownController = createAutoReplyController({
    dataDir: path.join(root, "clarify_outcome_unknown"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async ({ context, clarificationAllowed }) => {
        clarifyUnknownFlags.push(clarificationAllowed);
        return context.at(-1).content === "现场情况需要确认"
          ? clarifyDecision("现场面积大约多少平方米？")
          : answerDecision("300 平方可先做分区清理和小面积测试。");
      }
    },
    primeIncoming: () => ({ ok: true, source: "session_prime", primed: true }),
    scanIncoming: () => {
      const candidate = clarifyUnknownCandidates.shift();
      return candidate ? { ok: true, conversation: "张总", message: candidate.message, runtimeId: candidate.runtimeId, pid: 81, hWnd: "91", context: [{ role: "user", content: candidate.message, key: candidate.runtimeId }] } : { ok: false, reason: "no_unread_message" };
    },
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      clarifyUnknownSendCalls += 1;
      return clarifyUnknownSendCalls === 1
        ? { ok: false, blocked_reason: "send_outcome_unknown", send_attempted: null, send_result: "outcome_unknown" }
        : { ok: true, send_attempted: true, send_result: "sent_verified" };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await clarifyUnknownController.start()).ok, true);
  await clarifyUnknownController.runOnce();
  assert.equal(clarifyUnknownController.status().status, "paused");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "clarify_outcome_unknown", "auto-reply-state.json"), "utf8")).contact_states.c1.clarify_pending, true, "an outcome-unknown clarification must conservatively count as already asked");
  assert.equal((await clarifyUnknownController.start()).ok, true);
  await clarifyUnknownController.runOnce();
  assert.deepEqual(clarifyUnknownFlags, [true, false]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "clarify_outcome_unknown", "auto-reply-state.json"), "utf8")).contact_states.c1, undefined, "a verified answer after clarification must clear the pending flag");
  clarifyUnknownController.pause();

  const unsentAnswerCandidates = [
    { runtimeId: "unsent-answer-clarify", message: "需要确认现场" },
    { runtimeId: "unsent-answer-reply", message: "面积是 200 平方" }
  ];
  let unsentAnswerCalls = 0;
  const unsentAnswerController = createAutoReplyController({
    dataDir: path.join(root, "answer_not_attempted"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async ({ context }) => context.at(-1).content === "需要确认现场"
        ? clarifyDecision("现场面积大约多少平方米？")
        : answerDecision("200 平方可先做基层清理。")
    },
    scanIncoming: () => {
      const candidate = unsentAnswerCandidates.shift();
      return candidate ? { ok: true, conversation: "张总", message: candidate.message, runtimeId: candidate.runtimeId, pid: 81, hWnd: "91", context: [{ role: "user", content: candidate.message, key: candidate.runtimeId }] } : { ok: false, reason: "no_unread_message" };
    },
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      unsentAnswerCalls += 1;
      return unsentAnswerCalls === 1
        ? { ok: true, send_attempted: true }
        : { ok: false, blocked_reason: "draft_not_sent", send_attempted: false, send_result: "not_attempted" };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await unsentAnswerController.start()).ok, true);
  await unsentAnswerController.runOnce();
  await unsentAnswerController.runOnce();
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "answer_not_attempted", "auto-reply-state.json"), "utf8")).contact_states.c1.clarify_pending, true, "a proven-unsent answer must not clear the earlier clarification boundary");
  unsentAnswerController.pause();

  let manualHandoffCalls = 0;
  const manualHandoffDir = path.join(root, "handoff_draft_manual_review");
  const manualHandoffController = createAutoReplyController({
    dataDir: manualHandoffDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => handoffDecision("收到，员工会继续处理正式报价。")
    },
    scanIncoming: () => ({
      ok: true,
      conversation: "张总",
      message: "请人工给我正式报价",
      runtimeId: "manual-handoff-draft-1",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "请人工给我正式报价", key: "manual-handoff-draft-1" }]
    }),
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      return { ok: false, blocked_reason: "atomic_draft_changed", send_attempted: false, send_result: "not_attempted" };
    },
    sendHandoff: async () => { manualHandoffCalls += 1; return { ok: true, send_attempted: true }; },
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await manualHandoffController.start()).ok, true);
  await manualHandoffController.runOnce();
  const manualHandoffState = JSON.parse(fs.readFileSync(path.join(manualHandoffDir, "auto-reply-state.json"), "utf8"));
  assert.equal(manualHandoffState.contact_states.c1, undefined, "a bridge reply that was never clicked must not prematurely hand the customer to an employee");
  assert.equal(manualHandoffState.manual_followups.length, 0, "a known-unsent bridge reply must remain retryable instead of creating an artificial manual task");
  assert.equal(manualHandoffState.pending_handoffs.length, 0);
  assert.equal(manualHandoffCalls, 0, "the employee handoff bridge must not send after the customer draft becomes uncertain");
  assert.equal(manualHandoffController.status().last_event, "send_retry_pending");
  assert.deepEqual(manualHandoffController.status().held_contacts.map((item) => item.id), []);
  manualHandoffController.pause();

  let metadataMismatchSends = 0;
  let metadataMismatchHandoffs = 0;
  const metadataMismatchController = createAutoReplyController({
    dataDir: path.join(root, "action_reason_metadata_mismatch"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true, reply: async () => ({ action: "answer", reply: "我来继续说明。", reasonCode: "missing_detail" }) },
    scanIncoming: () => ({ ok: true, conversation: "张总", message: "普通问题", runtimeId: "metadata-mismatch-1", pid: 81, hWnd: "91", context: [{ role: "user", content: "普通问题", key: "metadata-mismatch-1" }] }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => { metadataMismatchSends += 1; return { ok: true }; },
    sendHandoff: async () => { metadataMismatchHandoffs += 1; return { ok: true }; },
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await metadataMismatchController.start()).ok, true);
  await metadataMismatchController.runOnce();
  assert.deepEqual([metadataMismatchSends, metadataMismatchHandoffs], [1, 0], "reasonCode metadata must not block action=answer");
  assert.equal(metadataMismatchController.status().system_error, null);
  assert.deepEqual(metadataMismatchController.status().held_contacts, []);

  const ownershipCandidates = [
    { runtimeId: "owner-handoff", conversation: "张总", message: "请人工给我正式报价" },
    { runtimeId: "owner-backlog", conversation: "张总", message: "这是人工处理期间的旧消息" },
    { runtimeId: "owner-other", conversation: "李经理", message: "普通技术问题" },
    { runtimeId: "owner-resumed", conversation: "张总", message: "恢复后的新问题" }
  ];
  const ownershipAiMessages = [];
  const ownershipContexts = [];
  let ownershipSends = 0;
  let ownershipHandoffs = 0;
  let ownershipBaselineResets = 0;
  let ownershipPrimeCalls = 0;
  const ownershipScan = () => {
    const candidate = ownershipCandidates.shift();
    return candidate ? { ok: true, conversation: candidate.conversation, message: candidate.message, runtimeId: candidate.runtimeId, pid: 81, hWnd: "91", context: [{ role: "user", content: candidate.message, key: candidate.runtimeId }] } : { ok: false, reason: "no_unread_message" };
  };
  ownershipScan.resetBaselines = () => { ownershipBaselineResets += 1; };
  const ownershipController = createAutoReplyController({
    dataDir: path.join(root, "contact_ownership_resume"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async ({ context }) => {
        const message = context.at(-1).content;
        ownershipAiMessages.push(message);
        ownershipContexts.push(context.map((item) => ({ ...item })));
        return message === "请人工给我正式报价"
          ? handoffDecision("收到，员工会继续处理正式报价。")
          : answerDecision("这个问题可以继续由 AI 处理。");
      }
    },
    primeIncoming: () => { ownershipPrimeCalls += 1; return { ok: true, source: "session_prime", primed: true }; },
    scanIncoming: ownershipScan,
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => { assert.equal(await options.beforeDraft(), true); ownershipSends += 1; return { ok: true, send_attempted: true }; },
    sendHandoff: async () => { ownershipHandoffs += 1; return { ok: true, send_attempted: true }; },
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await ownershipController.start()).ok, true);
  const resetsAfterOwnershipStart = ownershipBaselineResets;
  await ownershipController.runOnce();
  assert.deepEqual(ownershipController.status().held_contacts.map((item) => item.id), ["c1"]);
  await ownershipController.runOnce();
  assert.equal(ownershipAiMessages.includes("这是人工处理期间的旧消息"), false, "messages observed while human-owned must be consumed without AI");
  await ownershipController.runOnce();
  assert.equal(ownershipAiMessages.includes("普通技术问题"), true, "another customer must keep receiving AI service");
  assert.equal(ownershipController.resumeContact("c1").ok, true);
  assert.equal(ownershipBaselineResets, resetsAfterOwnershipStart, "resuming one customer must not reset every customer's scan baseline");
  assert.equal(ownershipPrimeCalls, 1, "resuming one customer must not re-prime all contacts");
  await ownershipController.runOnce();
  assert.equal(ownershipSends, 3);
  assert.equal(ownershipHandoffs, 1);
  assert.deepEqual(ownershipController.status().held_contacts, []);
  const resumedContext = ownershipContexts.find((context) => context.at(-1)?.content === "恢复后的新问题");
  assert.deepEqual(resumedContext, [{ role: "user", content: "恢复后的新问题", key: "owner-resumed" }], "resume must clear that customer's old AI context");
  ownershipController.pause();

  const cancelledRetryDir = path.join(root, "resume_cancels_old_retry");
  fs.mkdirSync(cancelledRetryDir, { recursive: true });
  const cancelledRetryMessage = "人工期间留下的旧重试消息";
  const cancelledRetryRuntimeId = "resume-old-retry";
  const cancelledRetryFingerprint = crypto.createHash("sha256")
    .update(JSON.stringify(["wx-a", "c1", cancelledRetryRuntimeId, cancelledRetryMessage]))
    .digest("hex");
  fs.writeFileSync(path.join(cancelledRetryDir, "auto-reply-state.json"), JSON.stringify({
    version: 4,
    status: "paused",
    daily_date: "2026-07-14",
    contact_states: { c1: { clarify_pending: true, human_owned: true } },
    processed: {
      [cancelledRetryFingerprint]: { status: "retryable", contact_id: "c1", at: "2026-07-14T02:00:00.000Z" },
      other_customer_retry: { status: "retryable", contact_id: "c2", at: "2026-07-14T02:00:00.000Z" }
    }
  }), "utf8");
  let cancelledRetryAiCalls = 0;
  let cancelledRetrySends = 0;
  const cancelledRetryController = createAutoReplyController({
    dataDir: cancelledRetryDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true, reply: async () => { cancelledRetryAiCalls += 1; return answerDecision("不应发送"); } },
    primeIncoming: () => ({ ok: true, source: "session_prime", primed: true }),
    scanIncoming: () => ({ ok: true, conversation: "张总", message: cancelledRetryMessage, runtimeId: cancelledRetryRuntimeId, pid: 81, hWnd: "91", context: [{ role: "user", content: cancelledRetryMessage, key: cancelledRetryRuntimeId }] }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => { cancelledRetrySends += 1; return { ok: true }; },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal(cancelledRetryController.resumeContact("c1").ok, true);
  const cancelledRetryState = JSON.parse(fs.readFileSync(path.join(cancelledRetryDir, "auto-reply-state.json"), "utf8"));
  assert.equal(cancelledRetryState.processed[cancelledRetryFingerprint].status, "cancelled_after_handoff");
  assert.equal(cancelledRetryState.processed.other_customer_retry.status, "retryable", "resuming c1 must not alter c2 retry state");
  assert.equal((await cancelledRetryController.start()).ok, true);
  await cancelledRetryController.runOnce();
  assert.deepEqual([cancelledRetryAiCalls, cancelledRetrySends], [0, 0], "a resumed customer's old retry occurrence must remain terminal and never be regenerated");
  cancelledRetryController.pause();

  const controller = createAutoReplyController({
    dataDir: autoReplyDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async ({ context, expert }) => {
        replyCalls += 1;
        replyContexts.push(context.map((item) => ({ ...item })));
        assert.equal(context.at(-1).role, "user");
        assert.match(expert.businessKnowledge, /设备短租/);
        return decisions.shift();
      }
    },
    scanIncoming: (names) => {
      scannedNames.push([...names]);
      return candidates.shift() || { ok: false, reason: "no_unread_message" };
    },
    verifyIncoming: () => ({ ok: verifyAllowed }),
    send: async (options) => {
      assert.equal(options.windowMinIdleMs, 0, "auto-reply must not mistake recent session input for an active user before sending");
      sent.push(options.frozenContact.name);
      sentAttemptIds.push(options.attemptId);
      sentBindings.push({
        baseDir: options.baseDir,
        contactsDir: options.contactsDir,
        visualMode: options.visualMode,
        expectedPid: options.expectedPid,
        expectedHWnd: options.expectedHWnd,
        expectedConversation: options.expectedConversation
      });
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
  assert.equal(scheduledDelays[0], 5_000, "listener start must return to the renderer before the first five-second scan interval");
  await controller.runOnce();
  assert.equal(controller.status().reply_count, 1);
  assert.match(sentAttemptIds[0], /^[a-f0-9]{64}$/, "each incoming turn must supply a stable real-send attempt id");
  assert.deepEqual(sentBindings[0], {
    baseDir: autoReplyDir,
    contactsDir: activeTouchDir,
    visualMode: "visual_render_v1",
    expectedPid: 81,
    expectedHWnd: "91",
    expectedConversation: "张总"
  }, "visual candidates must keep their exact WeChat binding through the real-send call");
  assert.equal(handoffs.length, 0, "interest that can continue through AI guidance must not alert a human");
  assert.deepEqual(scannedNames[0].sort(), ["张总", "阿张", "李经理", "小李", "客户甲", "客户乙", "已停用"].sort(), "the observer must receive every unique display alias, exclude collisions, and never treat opaque WeChat IDs as titles");

  await controller.runOnce();
  assert.equal(sent.length, 1, "same runtime message must not send twice");
  assert.equal(replyCalls, 1, "duplicate must not call AI twice");

  await controller.runOnce();
  assert.equal(sent.length, 2, "same text with a new runtime identity is a new turn");
  assert.notEqual(sentAttemptIds[1], sentAttemptIds[0], "different incoming turns must not share a real-send attempt id");
  assert.equal(controller.status().reply_count, 2);
  assert.ok(
    replyContexts[1].filter((item) => item.role === "assistant").length >= 2,
    "a later customer turn must include both observed and in-session assistant context"
  );
  const contextDiagnostic = fs.readFileSync(path.join(autoReplyDir, "auto-reply-diagnostics.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === "reply_generation_started")
    .at(-1);
  assert.equal(contextDiagnostic.context_turn_count, replyContexts[1].length);
  assert.equal(contextDiagnostic.user_turn_count, replyContexts[1].filter((item) => item.role === "user").length);

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
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => (answerDecision("Acknowledged."))
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

  const guardConversation = JSON.parse(fs.readFileSync(path.join(activeTouchDir, "contacts.json"), "utf8"))[0].name;
  const visualGuardCandidate = ({ message, runtimeChar, evidenceChar, signatureChar = evidenceChar }) => {
    const runtimeId = `visual:v2:${runtimeChar.repeat(64)}`;
    return {
      ok: true,
      conversation: guardConversation,
      message,
      runtimeId,
      visualEvidenceRuntimeId: `visual:v1:${evidenceChar.repeat(64)}`,
      messageSignature: signatureChar.repeat(64),
      visualMode: "visual_render_v1",
      latestRole: "user",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: message, key: runtimeId }]
    };
  };
  const verifiedVisualCandidate = (candidate) => ({
    ok: true,
    conversation: candidate.conversation,
    message: candidate.message,
    runtimeId: candidate.runtimeId,
    visualEvidenceRuntimeId: candidate.visualEvidenceRuntimeId,
    messageSignature: candidate.messageSignature,
    latestRole: "user"
  });
  const outgoingVisualObservation = (signatureChar) => ({
    ok: false,
    reason: "latest_message_not_incoming",
    latestRole: "assistant",
    messageBaselineAdvance: { conversation: guardConversation, signature: signatureChar.repeat(64) }
  });
  const guardedControllerOptions = ({
    dataDir,
    scanIncoming,
    send,
    verifyIncoming = verifiedVisualCandidate,
    primeIncoming,
    deepSeekClient = { assertAvailable: () => true, reply: async () => (answerDecision("Acknowledged.")) }
  }) => ({
    dataDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient,
    scanIncoming,
    primeIncoming,
    verifyIncoming,
    send,
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });

  const duplicateEvidenceDir = path.join(root, "reply_guard_duplicate_visual_evidence");
  const duplicateEvidenceCandidates = [
    visualGuardCandidate({ message: "one customer occurrence", runtimeChar: "1", evidenceChar: "a" }),
    visualGuardCandidate({ message: "one customer occurrence with OCR drift", runtimeChar: "1", evidenceChar: "a" })
  ];
  let duplicateEvidenceSends = 0;
  let duplicateEvidenceAiCalls = 0;
  const duplicateEvidenceController = createAutoReplyController(guardedControllerOptions({
    dataDir: duplicateEvidenceDir,
    scanIncoming: () => duplicateEvidenceCandidates.shift() || { ok: false, reason: "no_unread_message" },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => { duplicateEvidenceAiCalls += 1; return answerDecision("Acknowledged."); }
    },
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      assert.equal(options.expectedIncomingMessageSignature, "a".repeat(64), "the controller must carry the bound bubble evidence into the final visual sender");
      duplicateEvidenceSends += 1;
      return { ok: true, send_attempted: true };
    }
  }));
  assert.equal((await duplicateEvidenceController.start()).ok, true);
  await duplicateEvidenceController.runOnce();
  await duplicateEvidenceController.runOnce();
  assert.equal(duplicateEvidenceSends, 1, "one occurrence token must not become replyable again after OCR text drift");
  assert.equal(duplicateEvidenceAiCalls, 1, "duplicate occurrence evidence must be stopped before another AI generation/send cycle");
  assert.equal(duplicateEvidenceController.status().status, "running");
  assert.equal(duplicateEvidenceController.status().last_event, "duplicate_skipped");
  assert.equal(duplicateEvidenceController.status().last_error, "");
  const duplicateEvidenceState = JSON.parse(fs.readFileSync(path.join(duplicateEvidenceDir, "auto-reply-state.json"), "utf8"));
  assert.equal(duplicateEvidenceState.reply_guards.c1.delivery_status, "sent_verified");
  assert.equal(duplicateEvidenceState.reply_guards.c1.turn_state, "outgoing_observed", "sent_verified itself is the trusted outgoing boundary for the next turn");
  assert.equal(JSON.stringify(duplicateEvidenceState).includes("one customer occurrence"), false, "the occurrence fence must not persist customer message text");

  let restartedDuplicateSends = 0;
  const restartedDuplicateCandidate = visualGuardCandidate({ message: "one customer occurrence after restart drift", runtimeChar: "1", evidenceChar: "a" });
  const restartedDuplicateController = createAutoReplyController(guardedControllerOptions({
    dataDir: duplicateEvidenceDir,
    scanIncoming: () => restartedDuplicateCandidate,
    send: async () => { restartedDuplicateSends += 1; return { ok: true }; }
  }));
  assert.equal((await restartedDuplicateController.start()).ok, true);
  await restartedDuplicateController.runOnce();
  assert.equal(restartedDuplicateSends, 0, "the occurrence fence must survive restart");
  assert.equal(restartedDuplicateController.status().last_event, "duplicate_skipped");

  const immediateDifferentTurnCandidates = [
    visualGuardCandidate({ message: "first immediate customer turn", runtimeChar: "a", evidenceChar: "b" }),
    visualGuardCandidate({ message: "second immediate customer turn", runtimeChar: "b", evidenceChar: "c" })
  ];
  let immediateDifferentTurnSends = 0;
  let immediateVerifiedBoundaries = 0;
  const immediateDifferentTurnScan = () => immediateDifferentTurnCandidates.shift() || { ok: false, reason: "no_unread_message" };
  immediateDifferentTurnScan.noteVerifiedSend = (_candidate, metadata) => {
    assert.equal(metadata.verificationMode, "draft_consumed_same_header");
    immediateVerifiedBoundaries += 1;
    return true;
  };
  const immediateDifferentTurnController = createAutoReplyController(guardedControllerOptions({
    dataDir: path.join(root, "reply_guard_immediate_different_turn"),
    scanIncoming: immediateDifferentTurnScan,
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      immediateDifferentTurnSends += 1;
      return { ok: true, send_attempted: true, verification_mode: "draft_consumed_same_header" };
    }
  }));
  assert.equal((await immediateDifferentTurnController.start()).ok, true);
  await immediateDifferentTurnController.runOnce();
  await immediateDifferentTurnController.runOnce();
  assert.equal(immediateDifferentTurnSends, 2, "sent_verified must permit an immediately observed, independently verified different customer turn");
  assert.equal(immediateVerifiedBoundaries, 2, "each verified sent turn must advance the visual occurrence boundary even when bubble OCR is temporarily unavailable");
  assert.equal(immediateDifferentTurnController.status().status, "running");
  immediateDifferentTurnController.pause();

  const genuineFollowupCandidates = [
    visualGuardCandidate({ message: "same text repeated by customer", runtimeChar: "4", evidenceChar: "b" }),
    visualGuardCandidate({ message: "same text repeated by customer", runtimeChar: "5", evidenceChar: "b" })
  ];
  let genuineFollowupSends = 0;
  const genuineFollowupController = createAutoReplyController(guardedControllerOptions({
    dataDir: path.join(root, "reply_guard_genuine_followup"),
    scanIncoming: () => genuineFollowupCandidates.shift() || { ok: false, reason: "no_unread_message" },
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      genuineFollowupSends += 1;
      return { ok: true, send_attempted: true };
    }
  }));
  assert.equal((await genuineFollowupController.start()).ok, true);
  await genuineFollowupController.runOnce();
  genuineFollowupController.pause();
  const genuineFollowupRestarted = createAutoReplyController(guardedControllerOptions({
    dataDir: path.join(root, "reply_guard_genuine_followup"),
    scanIncoming: () => genuineFollowupCandidates.shift() || { ok: false, reason: "no_unread_message" },
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      genuineFollowupSends += 1;
      return { ok: true, send_attempted: true };
    }
  }));
  assert.equal((await genuineFollowupRestarted.start()).ok, true);
  await genuineFollowupRestarted.runOnce();
  assert.equal(genuineFollowupSends, 2, "a distinct, exactly verified same-text occurrence may follow sent_verified immediately and survive restart");
  assert.equal(genuineFollowupRestarted.status().status, "running");
  genuineFollowupRestarted.pause();

  const incompleteVerificationCandidates = [
    visualGuardCandidate({ message: "first strict visual occurrence", runtimeChar: "c", evidenceChar: "d" }),
    visualGuardCandidate({ message: "second strict visual occurrence", runtimeChar: "d", evidenceChar: "e" })
  ];
  let incompleteVerificationCalls = 0;
  let incompleteVerificationSends = 0;
  const incompleteVerificationController = createAutoReplyController(guardedControllerOptions({
    dataDir: path.join(root, "reply_guard_incomplete_visual_verification"),
    scanIncoming: () => incompleteVerificationCandidates.shift() || { ok: false, reason: "no_unread_message" },
    verifyIncoming: (candidate) => {
      incompleteVerificationCalls += 1;
      return incompleteVerificationCalls === 1 ? verifiedVisualCandidate(candidate) : { ok: true };
    },
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      incompleteVerificationSends += 1;
      return { ok: true, send_attempted: true };
    }
  }));
  assert.equal((await incompleteVerificationController.start()).ok, true);
  await incompleteVerificationController.runOnce();
  await incompleteVerificationController.runOnce();
  assert.equal(incompleteVerificationSends, 2, "a new stable occurrence must not be blocked by a second OCR identity pass");
  assert.equal(incompleteVerificationCalls, 0, "visual candidates rely on the atomic sender checks after binding");
  assert.equal(incompleteVerificationController.status().last_event, "reply_sent_verified");

  const contactFuseCandidates = [
    visualGuardCandidate({ message: "rapid visual occurrence one", runtimeChar: "6", evidenceChar: "d" }),
    outgoingVisualObservation("2"),
    visualGuardCandidate({ message: "rapid visual occurrence two", runtimeChar: "7", evidenceChar: "e" }),
    outgoingVisualObservation("3"),
    visualGuardCandidate({ message: "rapid visual occurrence three", runtimeChar: "8", evidenceChar: "f" }),
    outgoingVisualObservation("5"),
    visualGuardCandidate({ message: "rapid visual occurrence four", runtimeChar: "9", evidenceChar: "a" })
  ];
  let contactFuseSends = 0;
  const contactFuseController = createAutoReplyController(guardedControllerOptions({
    dataDir: path.join(root, "reply_guard_contact_fuse"),
    scanIncoming: () => contactFuseCandidates.shift() || { ok: false, reason: "no_unread_message" },
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      contactFuseSends += 1;
      return { ok: true, send_attempted: true };
    }
  }));
  assert.equal((await contactFuseController.start()).ok, true);
  await contactFuseController.runOnce();
  await contactFuseController.runOnce();
  await contactFuseController.runOnce();
  await contactFuseController.runOnce();
  await contactFuseController.runOnce();
  await contactFuseController.runOnce();
  await contactFuseController.runOnce();
  assert.equal(contactFuseSends, 4, "four distinct customer occurrences must all be replyable");
  assert.equal(contactFuseController.status().status, "running");
  assert.equal(contactFuseController.status().last_event, "reply_sent_verified");

  const retryableCandidate = {
    ok: true,
    conversation: "张总",
    message: "发送前失败后请重试",
    runtimeId: "pre-send-retry-1",
    pid: 81,
    hWnd: "91",
    context: [{ role: "user", content: "发送前失败后请重试", key: "pre-send-retry-1" }]
  };
  let retryableSendCalls = 0;
  let retryableAiCalls = 0;
  const retryableDataDir = path.join(root, "pre_send_retry");
  const retryableController = createAutoReplyController({
    dataDir: retryableDataDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => { retryableAiCalls += 1; return answerDecision("好的，我再试一次。"); }
    },
    scanIncoming: () => retryableCandidate,
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      retryableSendCalls += 1;
      if (retryableSendCalls === 1) {
        return { ok: false, error: "raw-send-error-canary", blocked_reason: "raw-send-reason-canary", send_attempted: false };
      }
      assert.equal(await options.beforeDraft(), true);
      return { ok: true, send_attempted: true };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await retryableController.start()).ok, true);
  await retryableController.runOnce();
  assert.equal(retryableController.status().status, "running", "a proven pre-send failure must not pause all contacts");
  assert.equal(retryableController.status().reply_count, 0);
  assert.match(retryableController.status().last_error, /回复尚未发出/, "a known-unsent failure must explain recovery without exposing a raw worker reason in the UI");
  assert.doesNotMatch(retryableController.status().last_error, /raw-send-reason-canary|raw-send-error-canary/);
  assert.equal(retryableController.status().last_failure_context?.code, "raw-send-reason-canary", "the precise reason stays in the diagnostic context");
  assert.equal(Object.values(JSON.parse(fs.readFileSync(path.join(retryableDataDir, "auto-reply-state.json"), "utf8")).processed).at(-1).status, "retryable");
  retryableController.pause();
  assert.equal((await retryableController.start()).ok, true);
  await retryableController.runOnce();
  assert.equal(retryableSendCalls, 1, "the first retry poll must back off instead of driving WeChat again immediately");
  await retryableController.runOnce();
  assert.equal(retryableSendCalls, 2, "the same incoming turn must retry after a proven pre-send failure");
  assert.equal(retryableAiCalls, 1, "a send retry must reuse the verified AI result instead of paying to regenerate it");
  assert.equal(retryableController.status().reply_count, 1);
  assert.equal(Object.values(JSON.parse(fs.readFileSync(path.join(retryableDataDir, "auto-reply-state.json"), "utf8")).processed).at(-1).status, "sent_verified");
  const retryDiagnosticsText = fs.readFileSync(path.join(retryableDataDir, "auto-reply-diagnostics.jsonl"), "utf8");
  const retryDiagnostics = retryDiagnosticsText.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  const retryTraceIds = new Set(retryDiagnostics.filter((entry) => entry.event.startsWith("reply_") && entry.trace_id).map((entry) => entry.trace_id));
  assert.equal(retryTraceIds.size, 1, "candidate, decision, failed send, waiting and retry must keep one occurrence trace");
  for (const entry of retryDiagnostics.filter((item) => ["reply_send_started", "reply_send_finished", "reply_retry_enqueued", "reply_retry_waiting"].includes(item.event))) {
    assert.equal(entry.action, "answer");
    assert.equal(entry.reason_code, "general_guidance");
  }
  assert.deepEqual(retryDiagnostics.filter((entry) => entry.event === "reply_send_started").map((entry) => entry.delivery_attempt), [1, 2]);
  assert.deepEqual(retryDiagnostics.filter((entry) => entry.event === "reply_send_finished").map((entry) => entry.delivery_attempt), [1, 2]);
  const unknownSendDiagnostic = retryDiagnostics.find((entry) => entry.event === "reply_send_finished" && entry.code === "unknown_send_reason");
  assert.match(unknownSendDiagnostic.reason_ref, /^[a-f0-9]{12}$/u);
  assert.doesNotMatch(retryDiagnosticsText, /raw-send-error-canary|raw-send-reason-canary/, "raw sender errors and unknown reasons must not enter diagnostics");
  retryableController.pause();

  const userIdleRecoveryCandidate = {
    ...retryableCandidate,
    message: "电脑空闲后再安全发送",
    runtimeId: "pre-send-user-idle-1",
    context: [{ role: "user", content: "电脑空闲后再安全发送", key: "pre-send-user-idle-1" }]
  };
  const userIdleRecoveryDir = path.join(root, "pre_send_user_idle_recovery");
  let userIdleRecoveryAiCalls = 0;
  let userIdleRecoverySendCalls = 0;
  const userIdleRecoveryController = createAutoReplyController({
    dataDir: userIdleRecoveryDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => { userIdleRecoveryAiCalls += 1; return answerDecision("好的，稍后继续处理。"); }
    },
    scanIncoming: () => userIdleRecoveryCandidate,
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      userIdleRecoverySendCalls += 1;
      if (userIdleRecoverySendCalls === 1) {
        return {
          ok: false,
          blocked_reason: "wechat_user_active",
          send_attempted: false,
          send_result: "not_attempted",
          send_diagnostics: {
            phase: "preflight",
            required_idle_ms: 15_000,
            observed_idle_ms: 281,
            timings: { preflight_ms: 15_147 }
          }
        };
      }
      assert.equal(await options.beforeDraft(), true);
      return { ok: true, send_attempted: true, send_result: "sent_verified" };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await userIdleRecoveryController.start()).ok, true);
  await userIdleRecoveryController.runOnce();
  const userIdleRecoveryState = userIdleRecoveryController.status();
  assert.equal(userIdleRecoveryState.status, "running", "a pre-draft idle gate must preserve the listener");
  assert.equal(userIdleRecoveryState.scan_health, "waiting", "a pre-send idle gate is recoverable waiting, not a scan error");
  assert.equal(userIdleRecoveryState.last_scan_reason, "wechat_user_active");
  assert.equal(userIdleRecoveryState.consecutive_scan_failures, 0);
  assert.deepEqual(userIdleRecoveryState.last_failure_context, {
    phase: "send",
    code: "wechat_user_active",
    send_phase: "preflight",
    send_attempted: false,
    send_result: "not_attempted",
    draft_phase_started: false,
    recovery_action: "wait_for_idle_and_retry",
    retry_attempt: 1,
    retry_polls_remaining: 1,
    required_idle_ms: 15_000,
    observed_idle_ms: 281,
    preflight_ms: 15_147
  });
  const userIdleRecoveryDiagnostics = fs.readFileSync(path.join(userIdleRecoveryDir, "auto-reply-diagnostics.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  const userIdleSendFinished = userIdleRecoveryDiagnostics.find((entry) => entry.event === "reply_send_finished");
  assert.deepEqual({
    code: userIdleSendFinished.code,
    send_phase: userIdleSendFinished.send_phase,
    send_attempted: userIdleSendFinished.send_attempted,
    send_result: userIdleSendFinished.send_result,
    required_idle_ms: userIdleSendFinished.required_idle_ms,
    observed_idle_ms: userIdleSendFinished.observed_idle_ms,
    preflight_ms: userIdleSendFinished.preflight_ms
  }, {
    code: "wechat_user_active",
    send_phase: "preflight",
    send_attempted: false,
    send_result: "not_attempted",
    required_idle_ms: 15_000,
    observed_idle_ms: 281,
    preflight_ms: 15_147
  });
  assert.equal(userIdleRecoveryDiagnostics.some((entry) => entry.event === "reply_retry_enqueued" && entry.recovery_action === "wait_for_idle_and_retry"), true);
  await userIdleRecoveryController.runOnce();
  assert.equal(userIdleRecoverySendCalls, 1, "the next poll must back off before another send attempt");
  assert.equal(userIdleRecoveryController.status().last_failure_context?.recovery_action, "retry_waiting");
  await userIdleRecoveryController.runOnce();
  assert.equal(userIdleRecoverySendCalls, 2, "the retained reply must retry after a safe idle gate");
  assert.equal(userIdleRecoveryAiCalls, 1, "a safe retry must reuse the original AI reply");
  assert.equal(userIdleRecoveryController.status().reply_count, 1);
  assert.equal(userIdleRecoveryController.status().last_failure_context, null, "verified delivery must clear the stale recovery notice");
  userIdleRecoveryController.pause();

  let manualInputRequeues = 0;
  const manualInputCandidate = {
    ...userIdleRecoveryCandidate,
    message: "人工正在编辑时不要覆盖",
    runtimeId: "manual-input-1",
    context: [{ role: "user", content: "人工正在编辑时不要覆盖", key: "manual-input-1" }]
  };
  const manualInputScan = () => manualInputCandidate;
  manualInputScan.requeue = () => { manualInputRequeues += 1; return true; };
  const manualInputController = createAutoReplyController({
    dataDir: path.join(root, "manual_input_review"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true, reply: async () => (answerDecision("好的，我会保留你的输入。")) },
    scanIncoming: manualInputScan,
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      return {
        ok: false,
        blocked_reason: "visual_send_external_input_detected",
        send_attempted: false,
        send_result: "not_attempted",
        send_diagnostics: {
          phase: "draft",
          required_idle_ms: 15_000,
          observed_idle_ms: 281,
          timings: { draft_ms: 20 }
        }
      };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await manualInputController.start()).ok, true);
  await manualInputController.runOnce();
  assert.equal(manualInputController.status().status, "running", "manual review of one chat must not stop later monitoring");
  assert.equal(manualInputController.status().last_event, "manual_intervention_required");
  assert.equal(manualInputRequeues, 0, "a possible handwritten WeChat draft must never be automatically overwritten on retry");
  assert.equal(manualInputController.status().last_failure_context?.recovery_action, "manual_review_required");
  assert.equal(manualInputController.status().last_failure_context?.code, "visual_send_external_input_detected", "only an explicit observed external input may stop automatic retry");
  assert.equal(manualInputController.status().last_failure_context?.draft_phase_started, true);
  assert.equal(manualInputController.status().last_failure_context?.send_attempted, false);
  manualInputController.pause();

  const workerDraftRetryCandidate = {
    ...retryableCandidate,
    message: "输入执行器未启动也必须保留本条回复",
    runtimeId: "draft-worker-retry-1",
    context: [{ role: "user", content: "输入执行器未启动也必须保留本条回复", key: "draft-worker-retry-1" }]
  };
  let workerDraftRetryAiCalls = 0;
  let workerDraftRetrySendCalls = 0;
  const workerDraftRetryScan = () => workerDraftRetryCandidate;
  workerDraftRetryScan.requeue = () => true;
  const workerDraftRetryDir = path.join(root, "draft_worker_failure_recovery");
  const workerDraftRetryController = createAutoReplyController({
    dataDir: workerDraftRetryDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => { workerDraftRetryAiCalls += 1; return answerDecision("好的，我会继续处理这条消息。"); }
    },
    scanIncoming: workerDraftRetryScan,
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      workerDraftRetrySendCalls += 1;
      assert.equal(await options.beforeDraft(), true);
      if (workerDraftRetrySendCalls === 1) {
        return {
          ok: false,
          blocked_reason: "powershell_failed",
          send_attempted: false,
          send_result: "not_attempted",
          send_diagnostics: {
            phase: "draft",
            worker: {
              exit_code: 1,
              error_code: "powershell_failed",
              stderr_bytes: 42,
              stderr_sha256: "a".repeat(64)
            }
          }
        };
      }
      return { ok: true, send_attempted: true, send_result: "sent_verified" };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await workerDraftRetryController.start()).ok, true);
  await workerDraftRetryController.runOnce();
  assert.equal(workerDraftRetryController.status().status, "running", "a worker failure before paste/click must not pause the listener");
  assert.equal(workerDraftRetryController.status().last_event, "send_retry_pending");
  assert.equal(workerDraftRetryController.status().last_failure_context?.code, "powershell_failed");
  assert.equal(workerDraftRetryController.status().last_failure_context?.draft_phase_started, true, "controller hand-off alone must not turn a no-click failure into manual review");
  const workerDraftRetryDiagnostics = fs.readFileSync(path.join(workerDraftRetryDir, "auto-reply-diagnostics.jsonl"), "utf8")
    .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  const workerDraftFailure = workerDraftRetryDiagnostics.find((entry) => entry.event === "reply_send_finished");
  assert.equal(workerDraftFailure.code, "powershell_failed", "known worker failures must keep their real diagnostic code");
  assert.deepEqual(workerDraftFailure.worker, {
    exit_code: 1,
    error_code: "powershell_failed",
    stderr_bytes: 42,
    stderr_sha256: "a".repeat(64)
  }, "the durable trail may retain only structural worker diagnostics");
  await workerDraftRetryController.runOnce();
  assert.equal(workerDraftRetrySendCalls, 1, "the retained reply must back off before the retry");
  await workerDraftRetryController.runOnce();
  assert.equal(workerDraftRetrySendCalls, 2, "the same reply must retry after a pre-click worker failure");
  assert.equal(workerDraftRetryAiCalls, 1, "the retry must reuse the already generated reply");
  assert.equal(workerDraftRetryController.status().reply_count, 1);
  workerDraftRetryController.pause();

  const rejectedRetryScan = () => ({ ...retryableCandidate, runtimeId: "queue-full-1", context: [{ role: "user", content: retryableCandidate.message, key: "queue-full-1" }] });
  rejectedRetryScan.requeue = () => false;
  const rejectedRetryController = createAutoReplyController({
    dataDir: path.join(root, "rejected_retry_queue"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true, reply: async () => (answerDecision("收到。")) },
    scanIncoming: rejectedRetryScan,
    verifyIncoming: () => ({ ok: true }),
    send: async () => ({ ok: false, blocked_reason: "atomic_draft_changed", send_attempted: false }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await rejectedRetryController.start()).ok, true);
  await rejectedRetryController.runOnce();
  assert.equal(rejectedRetryController.status().status, "paused");
  assert.equal(rejectedRetryController.status().last_event, "send_retry_queue_paused");

  let changedDuringSendRequeues = 0;
  const changedDuringSendCandidate = visualGuardCandidate({ message: "message changed while sending", runtimeChar: "6", evidenceChar: "7" });
  const changedDuringSendScan = () => changedDuringSendCandidate;
  changedDuringSendScan.requeue = () => { changedDuringSendRequeues += 1; return true; };
  const changedDuringSendController = createAutoReplyController(guardedControllerOptions({
    dataDir: path.join(root, "visual_send_incoming_changed"),
    scanIncoming: changedDuringSendScan,
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      return { ok: false, blocked_reason: "visual_send_incoming_changed", send_attempted: false };
    }
  }));
  assert.equal((await changedDuringSendController.start()).ok, true);
  await changedDuringSendController.runOnce();
  assert.equal(changedDuringSendController.status().last_event, "manual_reply_or_message_changed");
  assert.equal(changedDuringSendRequeues, 0, "a changed incoming bubble must cancel stale generated copy instead of retrying it");

  const supersededContextDir = path.join(root, "visual_send_superseded_context");
  const supersededCandidates = [
    visualGuardCandidate({ message: "first part of customer question", runtimeChar: "a", evidenceChar: "c" }),
    visualGuardCandidate({ message: "second part with the missing detail", runtimeChar: "b", evidenceChar: "d" })
  ];
  const supersededContexts = [];
  let supersededSendCalls = 0;
  const supersededController = createAutoReplyController(guardedControllerOptions({
    dataDir: supersededContextDir,
    scanIncoming: () => supersededCandidates.shift() || { ok: false, reason: "no_unread_message" },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async ({ context }) => {
        supersededContexts.push(context.map((item) => item.content));
        return answerDecision("combined answer");
      }
    },
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      supersededSendCalls += 1;
      if (supersededSendCalls === 1) {
        return {
          ok: false,
          blocked_reason: "visual_send_incoming_changed",
          incoming_change_kind: "proven_different",
          composer_touched: false,
          send_attempted: false
        };
      }
      return { ok: true, send_attempted: true, verification_mode: "visual_message_bubble" };
    }
  }));
  assert.equal((await supersededController.start()).ok, true);
  await supersededController.runOnce();
  await supersededController.runOnce();
  assert.deepEqual(supersededContexts, [
    ["first part of customer question"],
    ["first part of customer question", "second part with the missing detail"]
  ], "a newly arrived bubble must carry the earlier unsent customer turn into one combined answer");
  assert.equal(supersededController.status().reply_count, 1);
  const supersededDurableState = fs.readFileSync(path.join(supersededContextDir, "auto-reply-state.json"), "utf8");
  assert.equal(supersededDurableState.includes("first part of customer question"), false, "superseded customer text must stay memory-only");
  assert.equal(supersededDurableState.includes("second part with the missing detail"), false, "current customer text must not enter durable state");

  const historicalSupersededCandidates = [
    visualGuardCandidate({ message: "earlier completed question", runtimeChar: "d", evidenceChar: "1" }),
    {
      ...visualGuardCandidate({ message: "new question second part", runtimeChar: "e", evidenceChar: "2" }),
      contextKind: "incoming_batch",
      context: [
        { role: "user", content: "new question first part", key: "batch-initial-first" },
        { role: "user", content: "new question second part", key: "batch-initial-tail" }
      ]
    },
    {
      ...visualGuardCandidate({ message: "same repeated detail", runtimeChar: "f", evidenceChar: "3" }),
      contextKind: "incoming_batch",
      context: [
        { role: "user", content: "new question first part", key: "batch-refreshed-first" },
        { role: "user", content: "new question second part", key: "batch-refreshed-previous-tail" },
        { role: "user", content: "same repeated detail", key: "batch-repeated-first" },
        { role: "user", content: "same repeated detail", key: "batch-repeated-tail" }
      ]
    },
    {
      ...visualGuardCandidate({ message: "other customer second part", runtimeChar: "a", evidenceChar: "4" }),
      conversation: "李经理",
      contextKind: "incoming_batch",
      context: [
        { role: "user", content: "other customer first part", key: "other-first" },
        { role: "user", content: "other customer second part", key: "other-tail" }
      ]
    }
  ];
  const historicalSupersededContexts = [];
  let historicalSupersededSends = 0;
  const historicalSupersededController = createAutoReplyController(guardedControllerOptions({
    dataDir: path.join(root, "visual_send_superseded_context_with_history"),
    scanIncoming: () => historicalSupersededCandidates.shift() || { ok: false, reason: "no_unread_message" },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async ({ context }) => {
        historicalSupersededContexts.push(context.map((item) => item.content));
        return answerDecision(historicalSupersededContexts.length === 1 ? "earlier completed answer" : "latest combined answer");
      }
    },
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      historicalSupersededSends += 1;
      if (historicalSupersededSends === 2) {
        return {
          ok: false,
          blocked_reason: "visual_send_incoming_changed",
          incoming_change_kind: "proven_different",
          composer_touched: false,
          send_attempted: false
        };
      }
      return { ok: true, send_attempted: true, verification_mode: "visual_message_bubble" };
    }
  }));
  assert.equal((await historicalSupersededController.start()).ok, true);
  await historicalSupersededController.runOnce();
  await historicalSupersededController.runOnce();
  await historicalSupersededController.runOnce();
  await historicalSupersededController.runOnce();
  assert.deepEqual(historicalSupersededContexts, [
    ["earlier completed question"],
    ["earlier completed question", "earlier completed answer", "new question first part", "new question second part"],
    ["earlier completed question", "earlier completed answer", "new question first part", "new question second part", "same repeated detail", "same repeated detail"],
    ["other customer first part", "other customer second part"]
  ], "incoming batches must retain remembered replies, merge superseded overlap despite changed keys, preserve repeated bubbles and stay within their customer");

  let unresolvedIncomingAiCalls = 0;
  let unresolvedIncomingSendCalls = 0;
  let unresolvedIncomingRequeues = 0;
  const unresolvedIncomingCandidate = visualGuardCandidate({ message: "same multiline customer bubble", runtimeChar: "7", evidenceChar: "8" });
  const unresolvedIncomingScan = () => unresolvedIncomingCandidate;
  unresolvedIncomingScan.requeue = () => { unresolvedIncomingRequeues += 1; return true; };
  const unresolvedIncomingController = createAutoReplyController(guardedControllerOptions({
    dataDir: path.join(root, "visual_send_incoming_ocr_unresolved"),
    scanIncoming: unresolvedIncomingScan,
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => { unresolvedIncomingAiCalls += 1; return answerDecision("one generated reply"); }
    },
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      unresolvedIncomingSendCalls += 1;
      if (unresolvedIncomingSendCalls === 1) {
        return {
          ok: false,
          blocked_reason: "visual_send_incoming_ocr_unresolved",
          incoming_change_kind: "ocr_unresolved",
          composer_touched: false,
          send_attempted: false
        };
      }
      return { ok: true, send_attempted: true, verification_mode: "visual_message_bubble" };
    }
  }));
  assert.equal((await unresolvedIncomingController.start()).ok, true);
  await unresolvedIncomingController.runOnce();
  await unresolvedIncomingController.runOnce();
  await unresolvedIncomingController.runOnce();
  assert.equal(unresolvedIncomingAiCalls, 1, "an OCR-only uncertainty must reuse the generated reply instead of calling AI again");
  assert.equal(unresolvedIncomingSendCalls, 2, "the untouched composer may receive one later evidence recheck");
  assert.equal(unresolvedIncomingRequeues, 2, "the existing bounded backoff queue must own the safe recheck");
  assert.equal(unresolvedIncomingController.status().last_event, "reply_sent_verified");

  let contradictoryUnknownSends = 0;
  let contradictoryUnknownRequeues = 0;
  const contradictoryUnknownCandidate = visualGuardCandidate({ message: "unknown must stay terminal", runtimeChar: "c", evidenceChar: "e" });
  const contradictoryUnknownScan = () => contradictoryUnknownCandidate;
  contradictoryUnknownScan.requeue = () => { contradictoryUnknownRequeues += 1; return true; };
  const contradictoryUnknownController = createAutoReplyController(guardedControllerOptions({
    dataDir: path.join(root, "visual_send_explicit_unknown_precedence"),
    scanIncoming: contradictoryUnknownScan,
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      contradictoryUnknownSends += 1;
      return {
        ok: true,
        blocked_reason: "visual_send_outcome_unknown",
        send_result: "outcome_unknown",
        send_attempted: true,
        composer_touched: false
      };
    }
  }));
  assert.equal((await contradictoryUnknownController.start()).ok, true);
  await contradictoryUnknownController.runOnce();
  assert.equal(contradictoryUnknownController.status().status, "paused");
  assert.equal(contradictoryUnknownController.status().last_event, "send_outcome_unknown_paused");
  assert.equal(contradictoryUnknownController.status().reply_count, 0, "an explicit unknown must never be counted as a verified reply even when a lower layer also reports ok");
  assert.equal(contradictoryUnknownSends, 1);
  assert.equal(contradictoryUnknownRequeues, 0, "an explicit outcome_unknown result must override both ok and untouched-composer evidence");

  let unknownSendCalls = 0;
  const unknownSendDataDir = path.join(root, "unknown_customer_send");
  const expectedUnknownReceipt = {
    receipt_stage: "bubble_read",
    receipt_code: "receipt_unconfirmed",
    receipt_draft_read_stage: "empty",
    receipt_conversation_verified: true,
    receipt_draft_read_ok: true,
    receipt_draft_consumed: true,
    receipt_input_lease_valid: false,
    receipt_bubble_verified: false,
    receipt_verification_attempts: 4
  };
  const unknownSendController = createAutoReplyController({
    dataDir: unknownSendDataDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => (answerDecision("收到。"))
    },
    scanIncoming: () => ({ ...retryableCandidate, message: "结果未知不能重发", runtimeId: "unknown-send-1", context: [{ role: "user", content: "结果未知不能重发", key: "unknown-send-1" }] }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => {
      unknownSendCalls += 1;
      return {
        ok: false,
        blocked_reason: "outcome_unknown",
        send_attempted: null,
        send_diagnostics: {
          receipt: {
            stage: "bubble_read",
            code: "receipt_unconfirmed",
            draft_read_stage: "empty",
            conversation_verified: true,
            draft_read_ok: true,
            draft_consumed: true,
            input_lease_valid: false,
            bubble_verified: false,
            verification_attempts: 4,
            conversation: "receipt-private-contact-canary",
            draft: "receipt-private-reply-canary",
            body: "receipt-private-body-canary",
            apiKey: "sk-receipt-private-key-canary"
          }
        }
      };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await unknownSendController.start()).ok, true);
  await unknownSendController.runOnce();
  assert.equal(unknownSendController.status().status, "paused");
  const receiptFields = (value) => Object.fromEntries(Object.keys(expectedUnknownReceipt).map((field) => [field, value?.[field]]));
  assert.deepEqual(receiptFields(unknownSendController.status().last_failure_context), expectedUnknownReceipt, "unknown delivery must preserve the bounded receipt rather than leave only outcome_unknown");
  const unknownDiagnosticText = fs.readFileSync(path.join(unknownSendDataDir, "auto-reply-diagnostics.jsonl"), "utf8");
  const unknownReceiptDiagnostic = unknownDiagnosticText.trim().split(/\r?\n/u).map((line) => JSON.parse(line)).find((entry) => entry.event === "reply_send_finished");
  assert.deepEqual(receiptFields(unknownReceiptDiagnostic), expectedUnknownReceipt, "send completion logs must carry the exact sanitized receipt fields");
  const restoredUnknownReceipt = createAutoReplyController({ dataDir: unknownSendDataDir, activeTouchDir, coordinator });
  assert.deepEqual(receiptFields(restoredUnknownReceipt.status().last_failure_context), expectedUnknownReceipt, "receipt evidence must survive normalized state readback");
  assert.doesNotMatch(unknownDiagnosticText + fs.readFileSync(path.join(unknownSendDataDir, "auto-reply-state.json"), "utf8"), /receipt-private|sk-receipt/, "receipt persistence must exclude customer, reply, body and Key values");
  assert.equal(Object.values(JSON.parse(fs.readFileSync(path.join(unknownSendDataDir, "auto-reply-state.json"), "utf8")).processed).at(-1).status, "outcome_unknown");
  assert.equal((await unknownSendController.start()).ok, true);
  await unknownSendController.runOnce();
  assert.equal(unknownSendCalls, 1, "an unknown customer-send outcome must remain terminal and never auto-resend");
  unknownSendController.pause();

  const unknownVisualDir = path.join(root, "unknown_visual_occurrence_fence");
  const unknownVisualVerifiedFirst = visualGuardCandidate({ message: "verified visual turn", runtimeChar: "7", evidenceChar: "a" });
  const unknownVisualFirst = visualGuardCandidate({ message: "visual outcome is unknown", runtimeChar: "9", evidenceChar: "b" });
  let unknownVisualSends = 0;
  let unknownVisualBoundaryAttempts = 0;
  let unknownVisualTurnEpoch = 0;
  const unknownVisualCandidates = [unknownVisualVerifiedFirst, unknownVisualFirst];
  const unknownVisualScan = () => unknownVisualCandidates.shift() || { ok: false, reason: "no_unread_message" };
  unknownVisualScan.noteSendAttempted = (_candidate, metadata) => {
    if (metadata.outcomeUnknown === true) {
      unknownVisualBoundaryAttempts += 1;
      return { advanced: false, outcomeUnknown: true, turnEpoch: unknownVisualTurnEpoch };
    }
    assert.equal(metadata.verificationMode, "visual_message_bubble");
    unknownVisualTurnEpoch += 1;
    return { advanced: true, turnEpoch: unknownVisualTurnEpoch };
  };
  const unknownVisualController = createAutoReplyController(guardedControllerOptions({
    dataDir: unknownVisualDir,
    scanIncoming: unknownVisualScan,
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      unknownVisualSends += 1;
      if (unknownVisualSends === 1) return { ok: true, send_attempted: true, verification_mode: "visual_message_bubble" };
      return { ok: false, blocked_reason: "outcome_unknown", send_attempted: null };
    }
  }));
  assert.equal((await unknownVisualController.start()).ok, true);
  await unknownVisualController.runOnce();
  assert.equal(unknownVisualController.status().last_event, "reply_sent_verified", "the first verified visual turn must establish epoch one");
  await unknownVisualController.runOnce();
  assert.equal(unknownVisualController.status().last_event, "send_outcome_unknown_paused");
  const unknownVisualState = JSON.parse(fs.readFileSync(path.join(unknownVisualDir, "auto-reply-state.json"), "utf8"));
  assert.equal(unknownVisualState.reply_guards.c1.delivery_status, "outcome_unknown");
  assert.equal(unknownVisualState.reply_guards.c1.turn_epoch, 1, "an outcome-unknown click must persist the current visual turn even when it did not advance it");
  assert.equal(unknownVisualBoundaryAttempts, 1);

  const unknownVisualRewrapped = visualGuardCandidate({
    message: "visual outcome is unknown after harmless OCR drift",
    runtimeChar: "9",
    evidenceChar: "b"
  });
  let restoredVisualTurns = [];
  const unknownVisualRestartScan = () => unknownVisualRewrapped;
  unknownVisualRestartScan.restoreTurnBoundaries = (turns) => { restoredVisualTurns = turns; return turns.length; };
  const unknownVisualRestarted = createAutoReplyController(guardedControllerOptions({
    dataDir: unknownVisualDir,
    scanIncoming: unknownVisualRestartScan,
    send: async () => { unknownVisualSends += 1; return { ok: true }; }
  }));
  assert.equal((await unknownVisualRestarted.start()).ok, true);
  assert.equal(restoredVisualTurns[0].turnEpoch, 1, "the controller must restore the persisted per-contact turn before priming");
  assert.equal(unknownVisualRewrapped.runtimeId, unknownVisualFirst.runtimeId, "rebuilding the unresolved original bubble must retain its public occurrence ID");
  await unknownVisualRestarted.runOnce();
  assert.equal(unknownVisualSends, 2, "an outcome-unknown v2 occurrence fence must survive restart and reject OCR drift in the same turn");
  assert.equal(unknownVisualRestarted.status().last_event, "outcome_unknown_occurrence_skipped");

  const unknownVisualSameTextNewTurn = visualGuardCandidate({ message: "visual outcome is unknown", runtimeChar: "0", evidenceChar: "b" });
  const unknownVisualSameTextNewTurnController = createAutoReplyController(guardedControllerOptions({
    dataDir: unknownVisualDir,
    scanIncoming: () => unknownVisualSameTextNewTurn,
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      unknownVisualSends += 1;
      return { ok: true, send_attempted: true };
    }
  }));
  assert.equal((await unknownVisualSameTextNewTurnController.start()).ok, true);
  await unknownVisualSameTextNewTurnController.runOnce();
  assert.equal(unknownVisualSends, 3, "the semantic v1 OCR signature must not block a later v2 turn with the same customer text");
  assert.equal(unknownVisualSameTextNewTurnController.status().last_event, "reply_sent_verified");
  unknownVisualSameTextNewTurnController.pause();

  const unknownVisualNewTurn = visualGuardCandidate({ message: "a later customer turn", runtimeChar: "8", evidenceChar: "c" });
  const unknownVisualNewTurnController = createAutoReplyController(guardedControllerOptions({
    dataDir: unknownVisualDir,
    scanIncoming: () => unknownVisualNewTurn,
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      unknownVisualSends += 1;
      return { ok: true, send_attempted: true };
    }
  }));
  assert.equal((await unknownVisualNewTurnController.start()).ok, true);
  await unknownVisualNewTurnController.runOnce();
  assert.equal(unknownVisualSends, 4, "an unknown send fences only that occurrence, not all future messages from the contact");
  assert.equal(unknownVisualNewTurnController.status().last_event, "reply_sent_verified");
  unknownVisualNewTurnController.pause();

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
    expertStore: readyExpert(),
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
  assert.equal(startupController.status().scan_health, "checking", "startup must not claim healthy before the baseline probe completes");
  releaseStartupPrime({ ok: true, primed: true });
  assert.equal((await startup).state.status, "running");
  assert.equal(startupController.status().scan_health, "healthy");
  assert.equal(startupController.status().last_scan_reason, "baseline_ready");
  assert.equal(startupController.status().last_scan_success_at, "2026-07-14T02:00:00.000Z");
  assert.equal(startupDelays[0], 5_000);
  startupController.pause();

  const noCurrentDir = path.join(root, "startup_no_current_conversation");
  const noCurrentController = createAutoReplyController({
    dataDir: noCurrentDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    primeIncoming: async () => ({ ok: false, reason: "no_current_conversation" }),
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await noCurrentController.start()).ok, true, "no selected conversation may still start all-contact unread polling");
  assert.equal(noCurrentController.status().scan_health, "checking", "an allowed skipped prime must not claim success or failure");
  assert.equal(noCurrentController.status().consecutive_scan_failures, 0);
  assert.equal(noCurrentController.status().last_scan_reason, "no_current_conversation");
  const noCurrentLog = fs.readFileSync(path.join(noCurrentDir, "auto-reply-diagnostics.jsonl"), "utf8");
  assert.match(noCurrentLog, /prime_skipped/);
  assert.doesNotMatch(noCurrentLog, /scan_failed/);
  noCurrentController.pause();

  let releaseCancelledPrime;
  let enterCancelledPrime;
  const cancelledPrimeEntered = new Promise((resolve) => { enterCancelledPrime = resolve; });
  const cancelledPrimeGate = new Promise((resolve) => { releaseCancelledPrime = resolve; });
  const cancelledPrimeDir = path.join(root, "startup_prime_cancelled");
  const cancelledPrimeController = createAutoReplyController({
    dataDir: cancelledPrimeDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    primeIncoming: async () => { enterCancelledPrime(); return cancelledPrimeGate; },
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  const cancelledStart = cancelledPrimeController.start();
  await cancelledPrimeEntered;
  cancelledPrimeController.pause();
  releaseCancelledPrime({ ok: true, primed: true });
  assert.equal((await cancelledStart).ok, false);
  assert.equal(cancelledPrimeController.status().status, "paused");
  assert.equal(cancelledPrimeController.status().scan_health, "checking", "a stale prime result must not mutate health after pause");
  assert.doesNotMatch(fs.readFileSync(path.join(cancelledPrimeDir, "auto-reply-diagnostics.jsonl"), "utf8"), /baseline_ready/, "a stale prime result must not write a success diagnostic");

  let scrolledPrimeCalls = 0;
  let scrolledScanCalls = 0;
  const scrolledPrimeController = createAutoReplyController({
    dataDir: path.join(root, "startup_prime_scrolled"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    scanIncoming: () => { scrolledScanCalls += 1; return { ok: false, reason: "no_unread_message" }; },
    primeIncoming: async () => {
      scrolledPrimeCalls += 1;
      return scrolledPrimeCalls === 1
        ? { ok: false, reason: "history_not_at_bottom" }
        : { ok: true, reason: "baseline_ready" };
    },
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await scrolledPrimeController.start()).ok, true);
  assert.equal(scrolledPrimeController.status().status, "running", "a transient viewport prime failure must not stop the listener");
  assert.equal(scrolledPrimeController.status().last_event, "started");
  assert.equal(scrolledPrimeController.status().scan_health, "checking");
  assert.equal(scrolledPrimeController.status().consecutive_scan_failures, 0);
  assert.equal(scrolledPrimeController.status().last_scan_reason, "history_not_at_bottom");
  assert.match(fs.readFileSync(path.join(root, "startup_prime_scrolled", "auto-reply-diagnostics.jsonl"), "utf8"), /prime_deferred/);
  await scrolledPrimeController.runOnce();
  assert.equal(scrolledPrimeCalls, 2, "the next poll must retry a deferred startup prime");
  assert.equal(scrolledScanCalls, 1, "a successful retry may continue into the ordinary scan");
  assert.equal(scrolledPrimeController.status().scan_health, "healthy");
  scrolledPrimeController.pause();

  const unsupportedSessionPrimeController = createAutoReplyController({
    dataDir: path.join(root, "startup_session_probe_unsupported"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    primeIncoming: async () => ({
      ok: false,
      reason: "session_probe_unsupported",
      pid: 81,
      hWnd: "91",
      sessionProbe: {
        v: 1,
        failure: "signature_count_zero",
        schemaObserved: true,
        elementCount: 120,
        eligibleRowCount: 3,
        signatureCount: 0,
        emptySignatureCount: 3,
        rejectedRowLeftBoundary: 2,
        rejectedRowTooNarrow: 1,
        minimumRowWidth: -1,
        maximumRowHeight: Number.MAX_SAFE_INTEGER,
        listRowCount: "7",
        contactName: "probe-contact-secret",
        preview: "probe-message-secret",
        automationId: "session_item_probe-secret",
        negative: -1,
        huge: Number.MAX_SAFE_INTEGER
      }
    }),
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await unsupportedSessionPrimeController.start()).ok, false);
  assert.equal(unsupportedSessionPrimeController.status().last_scan_reason, "session_probe_unsupported", "known UIA compatibility failures must remain actionable instead of being hidden as unknown");
  assert.equal(unsupportedSessionPrimeController.status().scan_health, "warning");
  const unsupportedSessionProbeLog = fs.readFileSync(path.join(root, "startup_session_probe_unsupported", "auto-reply-diagnostics.jsonl"), "utf8");
  assert.match(unsupportedSessionProbeLog, /"probe_failure":"signature_count_zero"/);
  assert.match(unsupportedSessionProbeLog, /"probe_eligible_row_count":3/);
  assert.match(unsupportedSessionProbeLog, /"probe_signature_count":0/);
  assert.match(unsupportedSessionProbeLog, /"probe_rejected_row_left_boundary":2/);
  assert.match(unsupportedSessionProbeLog, /"probe_rejected_row_too_narrow":1/);
  assert.doesNotMatch(unsupportedSessionProbeLog, /"probe_list_row_count"/, "numeric diagnostic fields must not coerce strings");
  assert.doesNotMatch(unsupportedSessionProbeLog, /probe-contact-secret|probe-message-secret|session_item_probe-secret|negative|huge/, "session probe diagnostics must whitelist only content-free counters");
  assert.doesNotMatch(unsupportedSessionProbeLog, /probe_minimum_row_width|probe_maximum_row_height/, "session probe diagnostics must reject out-of-range values even for allowlisted fields");

  const visualDiagnosticDir = path.join(root, "visual_scan_diagnostic");
  const visualDiagnosticController = createAutoReplyController({
    dataDir: visualDiagnosticDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    scanIncoming: () => ({
      ok: false,
      reason: "visual_sidebar_match_ambiguous",
      pid: 81,
      hWnd: "91",
      conversation: "visual-contact-canary",
      message: "visual-message-canary",
      context: [{ role: "user", content: "visual-context-canary", key: "visual-key-canary" }],
      transitionDetail: { reason: "current_identity_invalid", detail: "nested-diagnostic-canary", action: "unresolved", phase: "scan" },
      nestedReason: "conversation_title_unresolved",
      window: { x: -1200, y: 0, width: 1100, height: 700, title: "window-title-canary", key: "window-key-canary" },
      DPI: 120,
      counts: { bubble_count: 3, ocr_rows: 8, romanized_contact_canary: 1, message_text: "count-message-canary", runtime_key: "count-key-canary" }
    }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await visualDiagnosticController.start()).ok, true);
  await visualDiagnosticController.runOnce();
  assert.equal(visualDiagnosticController.status().last_scan_reason, "visual_sidebar_match_ambiguous", "known visual scan failures must remain actionable");
  const visualDiagnosticLog = fs.readFileSync(path.join(visualDiagnosticDir, "auto-reply-diagnostics.jsonl"), "utf8");
  assert.match(visualDiagnosticLog, /"code":"visual_sidebar_match_ambiguous"/);
  assert.match(visualDiagnosticLog, /"transitionDetail":\{"reason":"current_identity_invalid","action":"unresolved","phase":"scan"\}/);
  assert.match(visualDiagnosticLog, /"nestedReason":"conversation_title_unresolved"/);
  assert.match(visualDiagnosticLog, /"window":\{"x":-1200,"y":0,"width":1100,"height":700\}/);
  assert.match(visualDiagnosticLog, /"DPI":120/);
  assert.match(visualDiagnosticLog, /"counts":\{"bubble_count":3,"ocr_rows":8\}/);
  assert.doesNotMatch(visualDiagnosticLog, /visual-contact-canary|visual-message-canary|visual-context-canary|visual-key-canary|window-title-canary|window-key-canary|count-message-canary|count-key-canary|nested-diagnostic-canary|romanized_contact_canary/, "visual scan diagnostics must preserve only structured content-free fields");
  visualDiagnosticController.pause();

  const boundSessionRecheckDir = path.join(root, "bound_session_recheck");
  const boundSessionRecheckSchedules = [];
  let boundSessionExplicitBinding = true;
  const boundSessionMessageRead = {
    source: "full_window+chat_contrast",
    boundarySource: "composer_divider",
    chatBottom: 742,
    fullLineCount: 11,
    recoveredLineCount: 2,
    messageBlockCount: 6,
    incomingBatchCount: 2,
    latestMessageTop: 704,
    regionOcrOk: true,
    text: "message-read-private-text-canary",
    contact: "message-read-private-contact-canary",
    signature: "f".repeat(64)
  };
  const boundSessionRecheckController = createAutoReplyController({
    dataDir: boundSessionRecheckDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    primeIncoming: () => ({ ok: true, reason: "baseline_ready", pid: 81, hWnd: "91" }),
    scanIncoming: () => ({
      ok: false,
      reason: "current_session_recheck_pending",
      source: "untrusted-source-canary",
      scanTrigger: "current_session_recheck",
      activeSessionBound: boundSessionExplicitBinding,
      activeSessionBindingHash: "b".repeat(64),
      activeSessionMessageSignature: "c".repeat(64),
      messageSignature: "d".repeat(64),
      latestRole: "user",
      pid: 81,
      hWnd: "91",
      captureMode: "foreground_screen",
      messageRead: boundSessionMessageRead,
      conversation: "current-session-contact-secret",
      message: "current-session-message-secret",
      context: [{ role: "user", content: "current-session-context-secret", key: "current-session-key-secret" }]
    }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: (callback, delay) => {
      boundSessionRecheckSchedules.push({ callback, delay });
      return boundSessionRecheckSchedules.length;
    },
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await boundSessionRecheckController.start()).ok, true);
  await boundSessionRecheckSchedules.shift().callback();
  assert.equal(boundSessionRecheckController.status().status, "running", "a bound current-session recheck must preserve the listener");
  assert.equal(boundSessionRecheckController.status().last_scan_reason, "current_session_recheck_pending");
  assert.equal(boundSessionRecheckController.status().consecutive_scan_failures, 0, "a bound current-session recheck is incomplete evidence, not a scan failure");
  assert.equal(boundSessionRecheckSchedules.at(-1).delay, 750, "a bound current-session recheck must schedule a fast follow-up poll");
  const boundSessionRecheckLog = fs.readFileSync(path.join(boundSessionRecheckDir, "auto-reply-diagnostics.jsonl"), "utf8");
  const boundSessionObservation = boundSessionRecheckLog.trim().split(/\r?\n/u).map((line) => JSON.parse(line))
    .find((entry) => entry.event === "scan_observation");
  assert.deepEqual({
    code: boundSessionObservation.code,
    scan_source: boundSessionObservation.scan_source,
    scan_trigger: boundSessionObservation.scan_trigger,
    current_session_bound: boundSessionObservation.current_session_bound,
    latest_role: boundSessionObservation.latest_role,
    wechat_pid: boundSessionObservation.wechat_pid,
    wechat_window_handle: boundSessionObservation.wechat_window_handle,
    capture_mode: boundSessionObservation.capture_mode
  }, {
    code: "current_session_recheck_pending",
    scan_source: "scan_driver",
    scan_trigger: "current_session_recheck",
    current_session_bound: true,
    latest_role: "user",
    wechat_pid: 81,
    wechat_window_handle: "91",
    capture_mode: "foreground_screen"
  });
  assert.match(boundSessionObservation.observation_ref, /^[a-f0-9]{24}$/u, "diagnostics must correlate the bound session without retaining its raw hashes");
  assert.deepEqual(Object.fromEntries([
    "message_read_source", "boundary_source", "chat_bottom", "full_line_count", "recovered_line_count",
    "message_block_count", "incoming_batch_count", "latest_message_top", "region_ocr_ok"
  ].map((key) => [key, boundSessionObservation[key]])), {
    message_read_source: "full_window+chat_contrast",
    boundary_source: "composer_divider",
    chat_bottom: 742,
    full_line_count: 11,
    recovered_line_count: 2,
    message_block_count: 6,
    incoming_batch_count: 2,
    latest_message_top: 704,
    region_ocr_ok: true
  });
  assert.doesNotMatch(boundSessionRecheckLog, /untrusted-source-canary|current-session-contact-secret|current-session-message-secret|current-session-context-secret|current-session-key-secret|bbbb|cccc|dddd/, "bound-session diagnostics must not persist source text, customer text, context or raw signatures");
  const readScanObservations = () => fs.readFileSync(path.join(boundSessionRecheckDir, "auto-reply-diagnostics.jsonl"), "utf8")
    .trim().split(/\r?\n/u).map((line) => JSON.parse(line)).filter((entry) => entry.event === "scan_observation");
  await boundSessionRecheckController.runOnce();
  assert.equal(readScanObservations().length, 1, "unchanged OCR observations must respect the existing log throttle");
  boundSessionMessageRead.recoveredLineCount = 3;
  await boundSessionRecheckController.runOnce();
  assert.equal(readScanObservations().length, 2, "changed OCR line recovery must be logged immediately even inside the throttle window");
  assert.equal(readScanObservations().at(-1).recovered_line_count, 3);
  boundSessionExplicitBinding = undefined;
  Object.assign(boundSessionMessageRead, {
    source: "untrusted-read-source-canary",
    boundarySource: "untrusted-boundary-source-canary",
    chatBottom: "742",
    fullLineCount: Infinity,
    recoveredLineCount: 0,
    latestMessageTop: -1,
    regionOcrOk: false
  });
  await boundSessionRecheckController.runOnce();
  const incompleteReadObservation = readScanObservations().at(-1);
  for (const field of ["current_session_bound", "message_read_source", "boundary_source", "chat_bottom", "full_line_count", "latest_message_top"]) {
    assert.equal(Object.hasOwn(incompleteReadObservation, field), false, `unavailable or invalid ${field} must be omitted`);
  }
  assert.equal(incompleteReadObservation.recovered_line_count, 0);
  assert.equal(incompleteReadObservation.region_ocr_ok, false);
  assert.doesNotMatch(fs.readFileSync(path.join(boundSessionRecheckDir, "auto-reply-diagnostics.jsonl"), "utf8"), /message-read-private-text-canary|message-read-private-contact-canary|untrusted-read-source-canary|untrusted-boundary-source-canary|ffff/, "OCR observations must preserve only allowlisted metadata and never raw text, contacts or signatures");
  boundSessionRecheckController.pause();

  const transientFenceDir = path.join(root, "scan_transient_fences");
  const transientFenceResults = [
    { ok: false, reason: "chat_boundary_unresolved", pid: 81, hWnd: "91" },
    { ok: false, reason: "wechat_focus_failed", pid: 81, hWnd: "91" },
    { ok: false, reason: "latest_message_role_unresolved", pid: 81, hWnd: "91" }
  ];
  let transientFenceAiCalls = 0;
  let transientFenceSendCalls = 0;
  let transientFenceRequeues = 0;
  let transientFenceBaselineResets = 0;
  let transientFenceVerifiedBoundaries = 0;
  const transientFenceScan = () => transientFenceResults.shift() || { ok: false, reason: "no_unread_message" };
  transientFenceScan.resetBaselines = () => { transientFenceBaselineResets += 1; };
  transientFenceScan.requeue = () => { transientFenceRequeues += 1; return true; };
  transientFenceScan.noteVerifiedSend = () => { transientFenceVerifiedBoundaries += 1; return true; };
  const transientFenceController = createAutoReplyController({
    dataDir: transientFenceDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => { transientFenceAiCalls += 1; return "不应生成"; }
    },
    scanIncoming: transientFenceScan,
    primeIncoming: () => ({ ok: true, reason: "baseline_ready", pid: 81, hWnd: "91" }),
    verifyIncoming: () => { throw new Error("transient scan fences must not verify a candidate"); },
    send: async () => { transientFenceSendCalls += 1; return { ok: true }; },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await transientFenceController.start()).ok, true);
  assert.equal(transientFenceBaselineResets, 1, "start may reset baselines once before priming");
  const transientFenceStateBefore = JSON.parse(fs.readFileSync(path.join(transientFenceDir, "auto-reply-state.json"), "utf8"));
  await transientFenceController.runOnce();
  assert.equal(transientFenceController.status().status, "running", "an unresolved chat boundary must keep polling instead of pretending the message is absent");
  assert.equal(transientFenceController.status().scan_health, "warning");
  assert.equal(transientFenceController.status().last_scan_reason, "chat_boundary_unresolved");
  assert.equal(transientFenceController.status().last_event, "chat_boundary_unresolved");
  await transientFenceController.runOnce();
  assert.equal(transientFenceController.status().status, "running", "a transient focus failure must keep polling");
  assert.equal(transientFenceController.status().scan_health, "warning");
  assert.equal(transientFenceController.status().last_scan_reason, "wechat_focus_failed");
  assert.equal(transientFenceController.status().consecutive_scan_failures, 2);
  await transientFenceController.runOnce();
  assert.equal(transientFenceController.status().scan_health, "degraded", "repeated boundary failures must be visible instead of looking healthy");
  assert.equal(transientFenceController.status().consecutive_scan_failures, 3);
  assert.equal(transientFenceController.status().last_scan_reason, "latest_message_role_unresolved");
  assert.equal(transientFenceController.status().last_event, "latest_message_role_unresolved");
  const transientFenceStateAfter = JSON.parse(fs.readFileSync(path.join(transientFenceDir, "auto-reply-state.json"), "utf8"));
  assert.deepEqual(transientFenceStateAfter.processed, transientFenceStateBefore.processed, "a boundary/focus fence must not consume or rewrite pending message state");
  assert.deepEqual(transientFenceStateAfter.reply_guards, transientFenceStateBefore.reply_guards, "a boundary/focus fence must not advance an outgoing guard");
  assert.equal(transientFenceAiCalls, 0);
  assert.equal(transientFenceSendCalls, 0);
  assert.equal(transientFenceRequeues, 0, "a boundary/focus fence must not consume or replace a queued retry");
  assert.equal(transientFenceBaselineResets, 1, "a transient scan failure must not reset live baselines");
  assert.equal(transientFenceVerifiedBoundaries, 0, "a transient scan failure must not advance a verified visual boundary");
  const transientFenceLog = fs.readFileSync(path.join(transientFenceDir, "auto-reply-diagnostics.jsonl"), "utf8");
  assert.match(transientFenceLog, /"code":"chat_boundary_unresolved"/);
  assert.match(transientFenceLog, /"code":"wechat_focus_failed"/);
  assert.match(transientFenceLog, /"code":"latest_message_role_unresolved"/);
  assert.doesNotMatch(transientFenceLog, /"code":"unknown_scan_reason"/, "known transient fences must remain diagnosable instead of being collapsed into an unknown status");
  transientFenceController.pause();

  const safeWindowDelayDir = path.join(root, "safe_window_delay_reasons");
  const safeWindowPrimeResults = [
    { ok: false, reason: "wechat_user_active" },
    { ok: false, reason: "wechat_window_identity_mismatch" }
  ];
  let safeWindowDelayAiCalls = 0;
  let safeWindowDelaySendCalls = 0;
  const safeWindowDelayController = createAutoReplyController({
    dataDir: safeWindowDelayDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => { safeWindowDelayAiCalls += 1; return "must not reply"; }
    },
    scanIncoming: () => { throw new Error("a deferred prime must retry before scanning"); },
    primeIncoming: () => safeWindowPrimeResults.shift() || { ok: false, reason: "wechat_user_active" },
    verifyIncoming: () => ({ ok: false }),
    send: async () => { safeWindowDelaySendCalls += 1; return { ok: true }; },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await safeWindowDelayController.start()).ok, true, "active desktop use must defer startup instead of becoming fatal");
  assert.equal(safeWindowDelayController.status().status, "running");
  assert.equal(safeWindowDelayController.status().last_scan_reason, "wechat_user_active");
  assert.equal(safeWindowDelayController.status().scan_health, "waiting", "active keyboard or mouse use must be presented as a recoverable wait, not a scan fault");
  assert.equal(safeWindowDelayController.status().consecutive_scan_failures, 0, "an idle gate must not accumulate scan failures");
  await safeWindowDelayController.runOnce();
  assert.equal(safeWindowDelayController.status().status, "running", "a stale exact HWND must remain retryable while the driver resets its binding");
  assert.equal(safeWindowDelayController.status().last_scan_reason, "wechat_window_identity_mismatch");
  assert.equal(safeWindowDelayAiCalls, 0);
  assert.equal(safeWindowDelaySendCalls, 0);
  const safeWindowDelayLog = fs.readFileSync(path.join(safeWindowDelayDir, "auto-reply-diagnostics.jsonl"), "utf8");
  assert.match(safeWindowDelayLog, /"code":"wechat_user_active"/);
  assert.match(safeWindowDelayLog, /"code":"wechat_window_identity_mismatch"/);
  assert.doesNotMatch(safeWindowDelayLog, /"code":"unknown_scan_reason"/);
  safeWindowDelayController.pause();

  const pendingHealthScan = () => ({
    ok: false,
    reason: "unread_preview_pending",
    conversation: "张总",
    pid: 81,
    hWnd: "91",
    pendingPreviewSignature: "b".repeat(64),
    pendingMessageSignature: "c".repeat(64),
    visualEvidenceRuntimeId: `visual:v1:${"d".repeat(64)}`
  });
  const pendingHealthController = createAutoReplyController({
    dataDir: path.join(root, "scan_pending_health"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true, reply: async () => { throw new Error("AI must wait for pending visual evidence"); } },
    scanIncoming: pendingHealthScan,
    verifyIncoming: () => ({ ok: false }),
    send: async () => { throw new Error("send must wait for pending visual evidence"); },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await pendingHealthController.start()).ok, true);
  await pendingHealthController.runOnce();
  assert.equal(pendingHealthController.status().scan_health, "checking", "a retained opened-unread transaction must be settling, not a false scan warning");
  assert.equal(pendingHealthController.status().consecutive_scan_failures, 0);
  assert.equal(pendingHealthController.status().last_scan_reason, "unread_preview_pending");
  await pendingHealthController.runOnce();
  await pendingHealthController.runOnce();
  await pendingHealthController.runOnce();
  assert.equal(pendingHealthController.status().pending_retry_count, 4, "a read-consumed message must remain recoverable after more than three OCR polls");
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, "scan_pending_health", "auto-reply-state.json"), "utf8")).pending_observation);
  pendingHealthController.pause();

  const consumedVisualDriftController = createAutoReplyController({
    dataDir: path.join(root, "scan_consumed_visual_drift"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true, reply: async () => { throw new Error("consumed visual drift must not call AI"); } },
    scanIncoming: () => ({ ok: false, reason: "current_visual_drift_consumed", pid: 81, hWnd: "91" }),
    verifyIncoming: () => ({ ok: false }),
    send: async () => { throw new Error("consumed visual drift must never send"); },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await consumedVisualDriftController.start()).ok, true);
  await consumedVisualDriftController.runOnce();
  assert.equal(consumedVisualDriftController.status().status, "running");
  assert.equal(consumedVisualDriftController.status().scan_health, "healthy", "a confirmed one-channel visual drift must be consumed without showing a scan warning");
  assert.equal(consumedVisualDriftController.status().consecutive_scan_failures, 0);
  assert.equal(consumedVisualDriftController.status().last_scan_reason, "current_visual_drift_consumed");
  consumedVisualDriftController.pause();

  const outgoingSettlingController = createAutoReplyController({
    dataDir: path.join(root, "scan_current_outgoing_settling"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true, reply: async () => { throw new Error("outgoing settling must not call AI"); } },
    scanIncoming: () => ({ ok: false, reason: "current_outgoing_settling", pid: 81, hWnd: "91", latestRole: "assistant" }),
    verifyIncoming: () => ({ ok: false }),
    send: async () => { throw new Error("outgoing settling must never send"); },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await outgoingSettlingController.start()).ok, true);
  await outgoingSettlingController.runOnce();
  assert.equal(outgoingSettlingController.status().status, "running", "a reflowing assistant bubble must keep the listener alive");
  assert.equal(outgoingSettlingController.status().scan_health, "healthy");
  assert.equal(outgoingSettlingController.status().consecutive_scan_failures, 0);
  assert.equal(outgoingSettlingController.status().last_scan_reason, "current_outgoing_settling");
  outgoingSettlingController.pause();

  const unresolvedHealthController = createAutoReplyController({
    dataDir: path.join(root, "scan_unresolved_health"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    scanIncoming: () => ({ ok: false, reason: "unread_preview_unresolved", pid: 81, hWnd: "91" }),
    verifyIncoming: () => ({ ok: false }),
    send: async () => { throw new Error("unresolved evidence must never send"); },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await unresolvedHealthController.start()).ok, true);
  await unresolvedHealthController.runOnce();
  assert.equal(unresolvedHealthController.status().status, "running", "an unresolved opened-unread observation must not stop the global listener");
  assert.equal(unresolvedHealthController.status().last_event, "unread_preview_unresolved");
  assert.equal(unresolvedHealthController.status().pending_retry_count, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "scan_unresolved_health", "auto-reply-state.json"), "utf8")).pending_observation, null);

  const unresolvedCurrentTransitionController = createAutoReplyController({
    dataDir: path.join(root, "scan_current_transition_unresolved"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    scanIncoming: () => ({
      ok: false,
      reason: "current_transition_unresolved",
      conversation: "张三",
      pid: 81,
      hWnd: "91",
      pendingPreviewSignature: "a".repeat(64),
      pendingMessageSignature: "b".repeat(64)
    }),
    verifyIncoming: () => ({ ok: false }),
    send: async () => { throw new Error("unresolved current transition must never send"); },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await unresolvedCurrentTransitionController.start()).ok, true);
  await unresolvedCurrentTransitionController.runOnce();
  assert.equal(unresolvedCurrentTransitionController.status().status, "running", "an unstable current-open transition must remain unsendable while other polls continue");
  assert.equal(unresolvedCurrentTransitionController.status().last_event, "current_transition_unresolved");
  assert.equal(unresolvedCurrentTransitionController.status().pending_retry_count, 0, "a generic transition fence must never become durable recovery state, even with complete live evidence");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "scan_current_transition_unresolved", "auto-reply-state.json"), "utf8")).pending_observation, null);

  const fencedRetryVisualRuntime = `visual:v1:${"a".repeat(64)}`;
  const fencedRetryVisualCandidate = {
    ok: true,
    conversation: "张总",
    message: "旧的待重试消息",
    runtimeId: fencedRetryVisualRuntime,
    previewSignature: "b".repeat(64),
    messageSignature: "c".repeat(64),
    pid: 81,
    hWnd: "91",
    source: "current_message_change",
    latestRole: "user",
    context: [{ role: "user", content: "旧的待重试消息", key: fencedRetryVisualRuntime }]
  };
  const fencedRetryVisualResults = [
    {
      ok: true,
      source: "session_prime",
      pid: 81,
      hWnd: 91,
      sessionBaselines: [{ conversation: "张总", signature: "b".repeat(64) }],
      sessionMessageBaselines: [{ conversation: "张总", signature: "c".repeat(64) }]
    },
    { ok: false, reason: "current_transition_unresolved", pid: 81, hWnd: 91 }
  ];
  const fencedRetryVisualDriver = createWechatVisualAutoReplyDriver(() => fencedRetryVisualResults.shift());
  let fencedRetryAiCalls = 0;
  let fencedRetrySendCalls = 0;
  const fencedRetryController = createAutoReplyController({
    dataDir: path.join(root, "scan_current_transition_fences_retry"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => { fencedRetryAiCalls += 1; return "不应生成"; }
    },
    scanIncoming: fencedRetryVisualDriver.scanWechatIncoming,
    verifyIncoming: fencedRetryVisualDriver.verifyWechatIncoming,
    send: async () => { fencedRetrySendCalls += 1; return { ok: true }; },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await fencedRetryController.start()).ok, true);
  assert.equal(fencedRetryVisualDriver.scanWechatIncoming.requeue(fencedRetryVisualCandidate), true);
  await fencedRetryController.runOnce();
  assert.equal(fencedRetryController.status().status, "running", "an unresolved live transition must fence sends without stopping the listener");
  assert.equal(fencedRetryController.status().last_event, "current_transition_unresolved");
  assert.equal(fencedRetryAiCalls, 0);
  assert.equal(fencedRetrySendCalls, 0);

  const pendingRestartDir = path.join(root, "pending_observation_restart");
  const pendingPreviewSignature = "d".repeat(64);
  const pendingMessageSignature = "e".repeat(64);
  const pendingVisualRuntime = `visual:v1:${"f".repeat(64)}`;
  const pendingFirstScan = () => ({
    ok: false,
    reason: "unread_preview_pending",
    conversation: "张总",
    pid: 81,
    hWnd: "91",
    pendingPreviewSignature,
    pendingMessageSignature,
    predecessorPreviewSignature: "a".repeat(64),
    predecessorMessageSignature: "b".repeat(64),
    message: "这段客户正文绝不能进入 pending 状态文件"
  });
  const pendingFirstController = createAutoReplyController({
    dataDir: pendingRestartDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    scanIncoming: pendingFirstScan,
    primeIncoming: async () => ({ ok: true, primed: true }),
    verifyIncoming: () => ({ ok: false }),
    send: async () => { throw new Error("pending evidence must not send"); },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await pendingFirstController.start()).ok, true);
  await pendingFirstController.runOnce();
  pendingFirstController.pause();
  const persistedPendingText = fs.readFileSync(path.join(pendingRestartDir, "auto-reply-state.json"), "utf8");
  assert.doesNotMatch(persistedPendingText, /这段客户正文/, "pending recovery metadata must never persist customer message text");
  const persistedPending = JSON.parse(persistedPendingText).pending_observation;
  assert.equal(persistedPending.preview_signature, pendingPreviewSignature);
  assert.equal(persistedPending.message_signature, pendingMessageSignature);

  let restoredPending;
  let restartResetCalls = 0;
  let restartPrimeCalls = 0;
  let pendingRestartSends = 0;
  const recoveredCandidate = {
    ok: true,
    conversation: "张总",
    message: "重启后重新读取到的客户消息",
    runtimeId: `visual:v2:${"1".repeat(64)}`,
    visualEvidenceRuntimeId: pendingVisualRuntime,
    previewSignature: pendingPreviewSignature,
    messageSignature: pendingMessageSignature,
    visualMode: "visual_render_v1",
    pid: 81,
    hWnd: "91",
    latestRole: "user",
    context: [{ role: "user", content: "重启后重新读取到的客户消息", key: `visual:v2:${"1".repeat(64)}` }]
  };
  const pendingRestartScan = () => recoveredCandidate;
  pendingRestartScan.restorePendingObservation = (value) => { restoredPending = value; return true; };
  pendingRestartScan.resetBaselines = () => { restartResetCalls += 1; };
  const pendingRestartController = createAutoReplyController({
    dataDir: pendingRestartDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true, reply: async () => (answerDecision("收到。")) },
    scanIncoming: pendingRestartScan,
    primeIncoming: async () => { restartPrimeCalls += 1; return { ok: true, primed: true }; },
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      pendingRestartSends += 1;
      return { ok: true, verification_mode: "visual_message_bubble" };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:05+08:00")
  });
  assert.equal((await pendingRestartController.start()).ok, true);
  assert.equal(restoredPending.key, persistedPending.key, "restart must restore the exact durable pending observation");
  assert.equal(restartResetCalls, 0, "startup must not reset baselines while a pending observation exists");
  assert.equal(restartPrimeCalls, 0, "startup must not prime over a pending observation");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(pendingRestartDir, "auto-reply-state.json"), "utf8")).pending_observation.key,
    persistedPending.key,
    "a successful driver handoff must remain durable until the recovered candidate is actually observed"
  );
  let restoredPendingAfterCrash;
  const pendingCrashRestartScan = () => recoveredCandidate;
  pendingCrashRestartScan.restorePendingObservation = (value) => { restoredPendingAfterCrash = value; return true; };
  pendingCrashRestartScan.resetBaselines = () => { restartResetCalls += 1; };
  const pendingCrashRestartController = createAutoReplyController({
    dataDir: pendingRestartDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true, reply: async () => (answerDecision("Acknowledged.")) },
    scanIncoming: pendingCrashRestartScan,
    primeIncoming: async () => { restartPrimeCalls += 1; return { ok: true, primed: true }; },
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      pendingRestartSends += 1;
      return { ok: true, verification_mode: "visual_message_bubble" };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:05+08:00")
  });
  assert.equal((await pendingCrashRestartController.start()).ok, true, "a crash after handoff must leave the pending observation recoverable on the next process start");
  assert.equal(restoredPendingAfterCrash.key, persistedPending.key);
  await pendingCrashRestartController.runOnce();
  assert.equal(pendingRestartSends, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(pendingRestartDir, "auto-reply-state.json"), "utf8")).pending_observation, null);
  pendingCrashRestartController.pause();

  const generationCrashDir = path.join(root, "reply_generation_crash_recovery");
  const generationCrashCandidate = visualGuardCandidate({
    message: "recover this occurrence after generation hangs",
    runtimeChar: "7",
    evidenceChar: "8"
  });
  let generationEntered;
  const generationStarted = new Promise((resolve) => { generationEntered = resolve; });
  const generationCrashScan = () => generationCrashCandidate;
  const generationCrashController = createAutoReplyController(guardedControllerOptions({
    dataDir: generationCrashDir,
    scanIncoming: generationCrashScan,
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => {
        generationEntered();
        return new Promise(() => undefined);
      }
    },
    send: async () => { throw new Error("a hung generation must never reach send"); }
  }));
  assert.equal((await generationCrashController.start()).ok, true);
  void generationCrashController.runOnce();
  await generationStarted;
  const generationCrashState = JSON.parse(fs.readFileSync(path.join(generationCrashDir, "auto-reply-state.json"), "utf8"));
  assert.equal(generationCrashState.pending_observation.reason, "reply_in_flight", "a complete occurrence must remain durable while DeepSeek is pending");
  assert.equal(Object.values(generationCrashState.processed)[0].status, "generating");
  assert.equal(JSON.stringify(generationCrashState.pending_observation).includes(generationCrashCandidate.message), false, "in-flight recovery must not persist customer text");

  let restoredGenerationCrash;
  let generationCrashSends = 0;
  const generationRecoveryScan = () => generationCrashCandidate;
  generationRecoveryScan.restorePendingObservation = (value) => { restoredGenerationCrash = value; return true; };
  const generationRecoveryController = createAutoReplyController(guardedControllerOptions({
    dataDir: generationCrashDir,
    scanIncoming: generationRecoveryScan,
    deepSeekClient: { assertAvailable: () => true, reply: async () => (answerDecision("Recovered once.")) },
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      generationCrashSends += 1;
      return { ok: true, send_attempted: true };
    }
  }));
  assert.equal((await generationRecoveryController.start()).ok, true);
  assert.equal(restoredGenerationCrash.reason, "reply_in_flight");
  await generationRecoveryController.runOnce();
  await generationRecoveryController.runOnce();
  assert.equal(generationCrashSends, 1, "a generation crash must recover the same v2 occurrence exactly once");
  assert.equal(JSON.parse(fs.readFileSync(path.join(generationCrashDir, "auto-reply-state.json"), "utf8")).pending_observation, null, "sent_verified is terminal and must clear pending recovery");
  generationRecoveryController.pause();

  const readyCrashDir = path.join(root, "reply_ready_before_draft_crash");
  const readyCrashCandidate = visualGuardCandidate({ message: "generated but not drafted", runtimeChar: "9", evidenceChar: "a" });
  let readySendEntered;
  const readySendStarted = new Promise((resolve) => { readySendEntered = resolve; });
  const readyCrashController = createAutoReplyController(guardedControllerOptions({
    dataDir: readyCrashDir,
    scanIncoming: () => readyCrashCandidate,
    send: async () => {
      readySendEntered();
      return new Promise(() => undefined);
    }
  }));
  assert.equal((await readyCrashController.start()).ok, true);
  void readyCrashController.runOnce();
  await readySendStarted;
  const readyCrashState = JSON.parse(fs.readFileSync(path.join(readyCrashDir, "auto-reply-state.json"), "utf8"));
  assert.equal(Object.values(readyCrashState.processed)[0].status, "ready_to_send", "generation completion before draft must remain a known-unsent state");
  assert.ok(readyCrashState.pending_observation, "known-unsent pre-draft work must retain its occurrence");

  let readyRecoverySends = 0;
  const readyRecoveryScan = () => readyCrashCandidate;
  readyRecoveryScan.restorePendingObservation = () => true;
  const readyRecoveryController = createAutoReplyController(guardedControllerOptions({
    dataDir: readyCrashDir,
    scanIncoming: readyRecoveryScan,
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      readyRecoverySends += 1;
      return { ok: true, send_attempted: true };
    }
  }));
  assert.equal((await readyRecoveryController.start()).ok, true);
  await readyRecoveryController.runOnce();
  await readyRecoveryController.runOnce();
  assert.equal(readyRecoverySends, 1, "a crash before draft begins must recover and send the occurrence once");
  assert.equal(JSON.parse(fs.readFileSync(path.join(readyCrashDir, "auto-reply-state.json"), "utf8")).pending_observation, null);
  readyRecoveryController.pause();

  const sendingCrashDir = path.join(root, "reply_sending_crash_unknown");
  const sendingCrashCandidate = visualGuardCandidate({ message: "sending may have clicked", runtimeChar: "b", evidenceChar: "c" });
  let sendingEntered;
  const sendingStarted = new Promise((resolve) => { sendingEntered = resolve; });
  const sendingCrashController = createAutoReplyController(guardedControllerOptions({
    dataDir: sendingCrashDir,
    scanIncoming: () => sendingCrashCandidate,
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      options.onTransition("prepared");
      sendingEntered();
      return new Promise(() => undefined);
    }
  }));
  assert.equal((await sendingCrashController.start()).ok, true);
  void sendingCrashController.runOnce();
  await sendingStarted;
  const sendingCrashState = JSON.parse(fs.readFileSync(path.join(sendingCrashDir, "auto-reply-state.json"), "utf8"));
  assert.equal(Object.values(sendingCrashState.processed)[0].status, "sending");
  assert.ok(sendingCrashState.pending_observation, "a possibly attempted send keeps its occurrence until restart classifies it");

  let sendingRecoverySends = 0;
  const sendingRecoveryScan = () => sendingCrashCandidate;
  sendingRecoveryScan.restorePendingObservation = () => true;
  const sendingRecoveryController = createAutoReplyController(guardedControllerOptions({
    dataDir: sendingCrashDir,
    scanIncoming: sendingRecoveryScan,
    send: async () => { sendingRecoverySends += 1; return { ok: true, send_attempted: true }; }
  }));
  const sendingRecoveredBeforeStart = JSON.parse(fs.readFileSync(path.join(sendingCrashDir, "auto-reply-state.json"), "utf8"));
  assert.equal(Object.values(sendingRecoveredBeforeStart.processed)[0].status, "outcome_unknown");
  assert.equal(sendingRecoveredBeforeStart.pending_observation, null, "restart must clear pending as soon as sending becomes terminal outcome_unknown");
  assert.equal((await sendingRecoveryController.start()).ok, true);
  await sendingRecoveryController.runOnce();
  const sendingRecoveryState = JSON.parse(fs.readFileSync(path.join(sendingCrashDir, "auto-reply-state.json"), "utf8"));
  assert.equal(sendingRecoverySends, 0, "a crash after draft/send may have started must never auto-resend");
  assert.equal(Object.values(sendingRecoveryState.processed)[0].status, "outcome_unknown");
  assert.equal(sendingRecoveryState.pending_observation, null, "outcome_unknown is terminal and clears pending recovery");
  sendingRecoveryController.pause();

  const stalePendingDir = path.join(root, "stale_pending_window");
  fs.mkdirSync(stalePendingDir, { recursive: true });
  fs.writeFileSync(path.join(stalePendingDir, "auto-reply-state.json"), JSON.stringify({
    version: 4,
    status: "paused",
    daily_date: "2026-07-14",
    pending_observation: {
      reason: "unread_preview_pending",
      conversation: "张总",
      pid: 80,
      hWnd: "90",
      message_signature: "a".repeat(64),
      attempts: 1,
      first_seen_at: "2026-07-14T02:00:00.000Z",
      last_seen_at: "2026-07-14T02:00:00.000Z"
    }
  }), "utf8");
  let stalePendingRestoreCalls = 0;
  let stalePendingResetCalls = 0;
  let stalePendingPrimeCalls = 0;
  const stalePendingScan = () => ({ ok: false, reason: "no_unread_message" });
  stalePendingScan.restorePendingObservation = () => { stalePendingRestoreCalls += 1; return false; };
  stalePendingScan.resetBaselines = () => { stalePendingResetCalls += 1; };
  const stalePendingController = createAutoReplyController({
    dataDir: stalePendingDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    scanIncoming: stalePendingScan,
    primeIncoming: () => { stalePendingPrimeCalls += 1; return { ok: true, reason: "baseline_ready" }; },
    verifyIncoming: () => ({ ok: false }),
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:05+08:00")
  });
  assert.equal((await stalePendingController.start()).ok, true);
  assert.equal(stalePendingRestoreCalls, 1);
  assert.equal(stalePendingResetCalls, 1, "a rejected old PID/HWND must reset the stale driver baseline");
  assert.equal(stalePendingPrimeCalls, 1, "a rejected old PID/HWND must fall back to a fresh prime");
  assert.equal(JSON.parse(fs.readFileSync(path.join(stalePendingDir, "auto-reply-state.json"), "utf8")).pending_observation, null);
  stalePendingController.pause();

  const reboundPendingDir = path.join(root, "pending_observation_window_rebind");
  fs.mkdirSync(reboundPendingDir, { recursive: true });
  fs.writeFileSync(path.join(reboundPendingDir, "auto-reply-state.json"), JSON.stringify({
    version: 4,
    status: "paused",
    daily_date: "2026-07-14",
    pending_observation: {
      reason: "unread_preview_pending",
      conversation: guardConversation,
      pid: 80,
      hWnd: "90",
      message_signature: "a".repeat(64),
      attempts: 1,
      first_seen_at: "2026-07-14T02:00:00.000Z",
      last_seen_at: "2026-07-14T02:00:00.000Z"
    }
  }), "utf8");
  const reboundCandidate = visualGuardCandidate({
    message: "recovered after the WeChat window restarted",
    runtimeChar: "3",
    evidenceChar: "4",
    signatureChar: "a"
  });
  reboundCandidate.pid = 81;
  reboundCandidate.hWnd = "91";
  const reboundResults = [
    { ok: false, reason: "wechat_process_changed", conversation: guardConversation, pid: 81, hWnd: "91" },
    reboundCandidate,
    reboundCandidate
  ];
  const reboundRestores = [];
  let reboundSends = 0;
  const reboundScan = () => reboundResults.shift() || { ok: false, reason: "no_unread_message" };
  reboundScan.restorePendingObservation = (value) => { reboundRestores.push(value); return true; };
  const reboundController = createAutoReplyController(guardedControllerOptions({
    dataDir: reboundPendingDir,
    scanIncoming: reboundScan,
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      reboundSends += 1;
      return { ok: true, send_attempted: true, verification_mode: "visual_message_bubble" };
    }
  }));
  assert.equal((await reboundController.start()).ok, true);
  assert.equal(reboundRestores.length, 1, "startup must hand off the durable observation without consuming it");
  await reboundController.runOnce();
  const reboundState = JSON.parse(fs.readFileSync(path.join(reboundPendingDir, "auto-reply-state.json"), "utf8"));
  assert.equal(reboundState.pending_observation.pid, 81);
  assert.equal(reboundState.pending_observation.hWnd, "91");
  assert.equal(reboundState.pending_observation.rebind_attempts, 1);
  assert.equal(reboundRestores.length, 2, "one changed WeChat window may rebind the same contact + message signature once");
  assert.equal(reboundSends, 0);
  await reboundController.runOnce();
  assert.equal(reboundSends, 1, "the exact recovered message may send only after the new window re-verifies it");
  assert.equal(JSON.parse(fs.readFileSync(path.join(reboundPendingDir, "auto-reply-state.json"), "utf8")).pending_observation, null);
  await reboundController.runOnce();
  assert.equal(reboundSends, 1, "the recovered occurrence must remain exactly-once after its durable pending record is consumed");
  reboundController.pause();

  const boundedRebindDir = path.join(root, "pending_observation_rebind_bounded");
  fs.mkdirSync(boundedRebindDir, { recursive: true });
  fs.writeFileSync(path.join(boundedRebindDir, "auto-reply-state.json"), JSON.stringify({
    version: 4,
    status: "paused",
    daily_date: "2026-07-14",
    pending_observation: {
      reason: "unread_preview_pending",
      conversation: guardConversation,
      pid: 80,
      hWnd: "90",
      message_signature: "a".repeat(64),
      attempts: 1,
      first_seen_at: "2026-07-14T02:00:00.000Z",
      last_seen_at: "2026-07-14T02:00:00.000Z"
    }
  }), "utf8");
  const boundedRebindResults = [
    { ok: false, reason: "wechat_window_changed", conversation: guardConversation, pid: 81, hWnd: "91" },
    { ok: false, reason: "wechat_window_changed", conversation: guardConversation, pid: 82, hWnd: "92" }
  ];
  let boundedRestoreCalls = 0;
  const boundedRebindScan = () => boundedRebindResults.shift() || { ok: false, reason: "no_unread_message" };
  boundedRebindScan.restorePendingObservation = () => { boundedRestoreCalls += 1; return true; };
  const boundedRebindController = createAutoReplyController(guardedControllerOptions({
    dataDir: boundedRebindDir,
    scanIncoming: boundedRebindScan,
    send: async () => { throw new Error("an unresolved second window change must never send"); }
  }));
  assert.equal((await boundedRebindController.start()).ok, true);
  await boundedRebindController.runOnce();
  await boundedRebindController.runOnce();
  assert.equal(boundedRestoreCalls, 2, "window rebinding must be bounded to the initial handoff plus one rebind");
  assert.equal(JSON.parse(fs.readFileSync(path.join(boundedRebindDir, "auto-reply-state.json"), "utf8")).pending_observation, null);
  boundedRebindController.pause();

  const repeatedOccurrenceDir = path.join(root, "same_occurrence_twenty_scans");
  const repeatedOccurrence = {
    ...recoveredCandidate,
    message: "同一个气泡连续扫描二十次",
    runtimeId: `visual:v2:${"2".repeat(64)}`,
    context: [{ role: "user", content: "同一个气泡连续扫描二十次", key: `visual:v2:${"2".repeat(64)}` }]
  };
  let repeatedOccurrenceAiCalls = 0;
  let repeatedOccurrenceSends = 0;
  const repeatedOccurrenceController = createAutoReplyController({
    dataDir: repeatedOccurrenceDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => { repeatedOccurrenceAiCalls += 1; return answerDecision("只回复一次。"); }
    },
    scanIncoming: () => repeatedOccurrence,
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      repeatedOccurrenceSends += 1;
      return { ok: true, verification_mode: "visual_message_bubble" };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:01:00+08:00")
  });
  assert.equal((await repeatedOccurrenceController.start()).ok, true);
  for (let index = 0; index < 20; index += 1) await repeatedOccurrenceController.runOnce();
  assert.equal(repeatedOccurrenceSends, 1, "twenty scans of one occurrence must send exactly once");
  assert.equal(repeatedOccurrenceAiCalls, 1, "duplicate scans must not regenerate AI text");
  assert.equal(repeatedOccurrenceController.status().status, "running");
  repeatedOccurrenceController.pause();

  const healthDir = path.join(root, "scan_health");
  const healthResults = [
    { ok: false, reason: "powershell_timeout" },
    { ok: false, reason: "history_avatar_ambiguous" },
    { ok: false, reason: "sk" + "-reason-secret-must-not-enter-diagnostics" },
    { ok: false, reason: "future_wechat_breakage" },
    {
      ok: true,
      conversation: "未同步客户",
      message: "message-canary-secret-must-not-enter-diagnostics",
      runtimeId: "canary-runtime",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "message-canary-secret-must-not-enter-diagnostics", key: "canary-runtime" }]
    },
    { ok: false, reason: "no_unread_message" },
    { ok: false, reason: "no_unread_message" }
  ];
  const healthController = createAutoReplyController({
    dataDir: healthDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true, reply: async () => { throw new Error("AI must not run in scan health checks"); } },
    scanIncoming: () => healthResults.shift(),
    verifyIncoming: () => ({ ok: true }),
    send: async () => { throw new Error("send must not run in scan health checks"); },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await healthController.start()).ok, true);
  assert.equal(healthController.status().scan_health, "checking");
  await healthController.runOnce();
  assert.equal(healthController.status().scan_health, "warning");
  assert.equal(healthController.status().consecutive_scan_failures, 1);
  await healthController.runOnce();
  assert.equal(healthController.status().scan_health, "warning");
  assert.equal(healthController.status().consecutive_scan_failures, 2);
  await healthController.runOnce();
  assert.equal(healthController.status().scan_health, "degraded", "unknown scan reasons must fail visibly instead of being treated as an empty poll");
  assert.equal(healthController.status().consecutive_scan_failures, 3);
  assert.equal(healthController.status().status, "running", "a degraded scanner must keep retrying so it can self-recover");
  await healthController.runOnce();
  assert.equal(healthController.status().last_scan_reason, "unknown_scan_reason", "unknown scanner reasons must not be persisted verbatim");
  assert.equal(healthController.status().consecutive_scan_failures, 4);
  await healthController.runOnce();
  assert.equal(healthController.status().scan_health, "healthy", "a valid candidate must restore scan health before business eligibility checks");
  assert.equal(healthController.status().last_scan_reason, "candidate_detected");
  assert.equal(healthController.status().last_event, "conversation_not_eligible");
  assert.equal(healthController.status().consecutive_scan_failures, 0);
  assert.equal(healthController.status().last_scan_success_at, "2026-07-14T02:00:00.000Z");
  await healthController.runOnce();
  const healthLogFile = path.join(healthDir, "auto-reply-diagnostics.jsonl");
  const logBeforeRepeatedEmptyPoll = fs.readFileSync(healthLogFile, "utf8").trim().split(/\r?\n/).length;
  await healthController.runOnce();
  assert.equal(fs.readFileSync(healthLogFile, "utf8").trim().split(/\r?\n/).length, logBeforeRepeatedEmptyPoll, "unchanged empty polls must not write a diagnostic line every five seconds");
  const healthLog = fs.readFileSync(healthLogFile, "utf8");
  assert.match(healthLog, /powershell_timeout/);
  assert.match(healthLog, /unknown_scan_reason/);
  assert.match(healthLog, /"reason_ref":"[a-f0-9]{12}"/);
  assert.doesNotMatch(healthLog, /future_wechat_breakage|reason-secret|canary-secret|未同步客户/, "diagnostics must not persist unknown reasons, messages, or contact content");
  healthController.pause();

  const rotationDir = path.join(root, "diagnostic_rotation");
  fs.mkdirSync(rotationDir, { recursive: true });
  const rotationLogFile = path.join(rotationDir, "auto-reply-diagnostics.jsonl");
  const oversizedDiagnostics = Array.from({ length: 1_000 }, (_, index) => JSON.stringify({ v: 1, seq: index, padding: "x".repeat(600) }));
  fs.writeFileSync(rotationLogFile, `${oversizedDiagnostics.join("\n")}\n{invalid-tail`, "utf8");
  const rotationController = createAutoReplyController({
    dataDir: rotationDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await rotationController.start()).ok, true);
  rotationController.pause();
  const rotatedLines = fs.readFileSync(rotationLogFile, "utf8").trim().split(/\r?\n/);
  assert.ok(rotatedLines.length <= 503, "oversized diagnostics must retain at most 500 previous entries plus current transitions");
  assert.doesNotThrow(() => rotatedLines.forEach((line) => JSON.parse(line)), "malformed trailing lines must not poison a rotated diagnostic log");
  assert.ok(fs.statSync(rotationLogFile).size < 512 * 1024, "normal bounded diagnostic entries must rotate below the size limit");
  assert.equal(fs.readdirSync(rotationDir).some((name) => name.endsWith(".tmp")), false, "successful diagnostic rotation must not leave temporary files");

  let busy = true;
  let busyScanCalls = 0;
  const busyController = createAutoReplyController({
    dataDir: path.join(root, "scan_waiting"),
    activeTouchDir,
    coordinator: {
      acquire: () => busy ? { ok: false } : { ok: true, lock: { owner: "waiting-owner" } },
      update: () => ({ ok: true }),
      release: () => ({ ok: true })
    },
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    scanIncoming: () => { busyScanCalls += 1; return { ok: false, reason: "no_unread_message" }; },
    verifyIncoming: () => ({ ok: true }),
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await busyController.start()).ok, true);
  await busyController.runOnce();
  assert.equal(busyController.status().scan_health, "waiting");
  assert.equal(busyController.status().consecutive_scan_failures, 0);
  assert.equal(busyController.status().last_scan_at, "");
  assert.equal(busyScanCalls, 0, "a busy coordinator means no scan was attempted");
  busy = false;
  await busyController.runOnce();
  assert.equal(busyController.status().scan_health, "healthy");
  assert.equal(busyScanCalls, 1);
  busyController.pause();

  const concurrentCandidates = [
    { runtimeId: "concurrent-a", conversation: "张总", message: "客户 A 的问题" },
    { runtimeId: "concurrent-b", conversation: "李经理", message: "客户 B 的问题" }
  ];
  const concurrentSendOrder = [];
  let concurrentScanCalls = 0;
  let releaseFirstConcurrentSend;
  let markFirstConcurrentSend;
  const firstConcurrentSendEntered = new Promise((resolve) => { markFirstConcurrentSend = resolve; });
  const firstConcurrentSendGate = new Promise((resolve) => { releaseFirstConcurrentSend = resolve; });
  const concurrentController = createAutoReplyController({
    dataDir: path.join(root, "single_flight_customer_queue"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true, reply: async () => answerDecision("已收到，我来协助您。") },
    scanIncoming: () => {
      concurrentScanCalls += 1;
      const candidate = concurrentCandidates.shift();
      return candidate ? {
        ok: true,
        conversation: candidate.conversation,
        message: candidate.message,
        runtimeId: candidate.runtimeId,
        pid: 81,
        hWnd: "91",
        context: [{ role: "user", content: candidate.message, key: candidate.runtimeId }]
      } : { ok: false, reason: "no_unread_message" };
    },
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      concurrentSendOrder.push(options.contactId);
      if (concurrentSendOrder.length === 1) {
        markFirstConcurrentSend();
        await firstConcurrentSendGate;
      }
      return { ok: true, send_attempted: true };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await concurrentController.start()).ok, true);
  const firstConcurrentRun = concurrentController.runOnce();
  await firstConcurrentSendEntered;
  await concurrentController.runOnce();
  assert.equal(concurrentScanCalls, 1, "while sending one customer, another scan must not take control of the WeChat window");
  assert.deepEqual(concurrentSendOrder, ["c1"], "only the first customer may own the composer during an in-flight send");
  releaseFirstConcurrentSend();
  await firstConcurrentRun;
  await concurrentController.runOnce();
  assert.deepEqual(concurrentSendOrder, ["c1", "c2"], "the next customer's queued observation must be processed after the first send completes");
  concurrentController.pause();

  const cachedRetryController = createAutoReplyController({
    dataDir: path.join(root, "cached_retry_without_probe"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    scanIncoming: () => ({
      ok: true,
      conversation: "未同步缓存客户",
      message: "缓存重试",
      runtimeId: "cached-retry",
      context: [{ role: "user", content: "缓存重试", key: "cached-retry" }],
      scanProbe: { ok: null, reason: "retry_candidate_without_probe" }
    }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await cachedRetryController.start()).ok, true);
  await cachedRetryController.runOnce();
  assert.equal(cachedRetryController.status().scan_health, "checking", "a cached retry without a live probe must not claim healthy");
  assert.equal(cachedRetryController.status().last_scan_at, "");
  assert.equal(cachedRetryController.status().last_event, "conversation_not_eligible");
  cachedRetryController.pause();

  const throwingScanController = createAutoReplyController({
    dataDir: path.join(root, "scan_exception"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    scanIncoming: () => { throw new Error("scanner exploded"); },
    verifyIncoming: () => ({ ok: true }),
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await throwingScanController.start()).ok, true);
  await throwingScanController.runOnce();
  assert.equal(throwingScanController.status().status, "paused", "a thrown scanner exception keeps the existing immediate-pause behavior");
  assert.equal(throwingScanController.status().last_scan_reason, "scan_exception");

  let safeHistoryAiCalls = 0;
  const safeHistorySends = [];
  const riskyHistoryController = createAutoReplyController({
    dataDir: path.join(root, "risky_history"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async ({ context }) => {
        safeHistoryAiCalls += 1;
        assert.deepEqual(context, [{ role: "user", content: "发票怎么开？", key: "safe-latest" }]);
        return answerDecision("合同和发票都可以处理，付款后我帮您跟进。");
      }
    },
    scanIncoming: () => ({
      ok: true,
      conversation: "张总",
      message: "发票怎么开？",
      runtimeId: "risky-history-1",
      pid: 81,
      hWnd: "91",
      context: [
        { role: "user", content: "我的验证码是123456", key: "risky-old" },
        { role: "user", content: "[图片]", key: "media-old" },
        { role: "user", content: "发票怎么开？", key: "safe-latest" }
      ]
    }),
    verifyIncoming: () => ({ ok: true }),
    send: async ({ message }) => { safeHistorySends.push(message); return { ok: true }; },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await riskyHistoryController.start()).ok, true);
  await riskyHistoryController.runOnce();
  assert.equal(safeHistoryAiCalls, 1, "safe latest request must still reach DeepSeek after unsafe older history is removed");
  assert.deepEqual(safeHistorySends, ["合同和发票都可以处理，付款后我帮您跟进。"]);
  assert.equal(riskyHistoryController.status().status, "running");
  assert.equal(riskyHistoryController.status().last_event, "reply_sent_verified");
  assert.equal(riskyHistoryController.status().reply_count, 1);
  riskyHistoryController.pause();

  let unsafeReplySends = 0;
  const unsafeReplyController = createAutoReplyController({
    dataDir: path.join(root, "unsafe_ai_reply"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => (answerDecision("请先支付定金"))
    },
    scanIncoming: () => ({
      ok: true,
      conversation: "张总",
      message: "怎么下单？",
      runtimeId: "unsafe-ai-reply-1",
      pid: 12,
      hWnd: "34",
      context: [{ role: "user", content: "怎么下单？", key: "unsafe-ai-reply-1" }]
    }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => { unsafeReplySends += 1; return { ok: true }; },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await unsafeReplyController.start()).ok, true);
  await unsafeReplyController.runOnce();
  assert.equal(unsafeReplySends, 0, "unsafe AI payment instructions must never reach the sender");
  assert.equal(unsafeReplyController.status().status, "paused");
  assert.match(unsafeReplyController.status().last_error, /安全检查/);

  let latestSecretAiCalls = 0;
  let latestSecretSendCalls = 0;
  const latestSecretDir = path.join(root, "latest_secret");
  const latestSecretController = createAutoReplyController({
    dataDir: latestSecretDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => { latestSecretAiCalls += 1; return answerDecision("收到。"); }
    },
    scanIncoming: () => ({
      ok: true,
      conversation: "张总",
      message: "我的验证码是123456",
      runtimeId: "latest-secret-1",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "我的验证码是123456", key: "latest-secret-1" }]
    }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => { latestSecretSendCalls += 1; return { ok: true }; },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await latestSecretController.start()).ok, true);
  await latestSecretController.runOnce();
  assert.equal(latestSecretAiCalls, 0, "latest real secret must never reach DeepSeek");
  assert.equal(latestSecretSendCalls, 0);
  assert.equal(latestSecretController.status().status, "running");
  assert.equal(latestSecretController.status().last_event, "unsupported_or_risky_message");
  const latestSecretState = JSON.parse(fs.readFileSync(path.join(latestSecretDir, "auto-reply-state.json"), "utf8"));
  assert.equal(Object.values(latestSecretState.processed).at(-1).status, "skipped");
  await latestSecretController.runOnce();
  assert.equal(latestSecretController.status().last_event, "duplicate_skipped");
  assert.equal(latestSecretAiCalls, 0);
  latestSecretController.pause();

  let takeoverChecks = 0;
  const takeoverController = createAutoReplyController({
    dataDir: path.join(root, "takeover_after_draft"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => (answerDecision("好的，我来说明。"))
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

  let visualPostDraftChecks = 0;
  const visualPostDraftController = createAutoReplyController({
    dataDir: path.join(root, "visual_post_draft_reflow"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => (answerDecision("Understood."))
    },
    scanIncoming: () => ({
      ok: true,
      conversation: retryableCandidate.conversation,
      conversationEvidence: "visual-ocr-contact",
      message: "Visual incoming message",
      runtimeId: "visual-post-draft-runtime",
      visualMode: "visual_render_v1",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "Visual incoming message", key: "visual-user" }]
    }),
    verifyIncoming: () => ({ ok: ++visualPostDraftChecks === 1 }),
    send: async (options) => {
      assert.equal(options.expectedConversationEvidence, "visual-ocr-contact");
      assert.equal(Array.isArray(options.expectedConversationAliases), true);
      assert.equal(options.expectedConversationAliases.includes(retryableCandidate.conversation), true);
      assert.equal(await options.beforeDraft(), true, "a bound visual occurrence must proceed without a second OCR pass");
      assert.equal(await options.shouldContinue(), true, "post-draft layout reflow must not trigger a second pixel-bound incoming check");
      return { ok: true, send_attempted: true };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await visualPostDraftController.start()).ok, true);
  await visualPostDraftController.runOnce();
  assert.equal(visualPostDraftChecks, 0, "visual OCR must not be repeated after AI generation");
  assert.equal(visualPostDraftController.status().reply_count, 1);
  assert.equal(visualPostDraftController.status().last_event, "reply_sent_verified");
  visualPostDraftController.pause();

  let pauseDuringSendController;
  pauseDuringSendController = createAutoReplyController({
    dataDir: path.join(root, "pause_during_send"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => (answerDecision("收到。"))
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

  const staleUnknownDir = path.join(root, "pause_during_unknown_visual_send");
  const staleUnknownFirst = visualGuardCandidate({ message: "paused while visual outcome is unknown", runtimeChar: "a", evidenceChar: "f" });
  let staleUnknownSendCalls = 0;
  let staleUnknownController;
  staleUnknownController = createAutoReplyController(guardedControllerOptions({
    dataDir: staleUnknownDir,
    scanIncoming: () => staleUnknownFirst,
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      staleUnknownSendCalls += 1;
      staleUnknownController.pause();
      return { ok: false, blocked_reason: "visual_send_outcome_unknown", outcomeUnknown: true, send_attempted: null };
    }
  }));
  assert.equal((await staleUnknownController.start()).ok, true);
  await staleUnknownController.runOnce();
  assert.equal(staleUnknownSendCalls, 1);
  assert.equal(staleUnknownController.status().status, "paused");
  assert.equal(staleUnknownController.status().last_event, "send_outcome_unknown_paused");
  const staleUnknownState = JSON.parse(fs.readFileSync(path.join(staleUnknownDir, "auto-reply-state.json"), "utf8"));
  assert.equal(Object.values(staleUnknownState.processed).at(-1).status, "outcome_unknown", "a stale run must preserve an unknown click outcome instead of cancelling it");
  assert.equal(staleUnknownState.reply_guards.c1.delivery_status, "outcome_unknown");

  const staleUnknownRewrapped = visualGuardCandidate({ message: `${staleUnknownFirst.message} OCR drift`, runtimeChar: "a", evidenceChar: "f" });
  const staleUnknownRestarted = createAutoReplyController(guardedControllerOptions({
    dataDir: staleUnknownDir,
    scanIncoming: () => staleUnknownRewrapped,
    send: async () => { staleUnknownSendCalls += 1; return { ok: true }; }
  }));
  assert.equal((await staleUnknownRestarted.start()).ok, true);
  await staleUnknownRestarted.runOnce();
  assert.equal(staleUnknownSendCalls, 1, "a stale outcome-unknown occurrence must remain fenced after restart");
  assert.equal(staleUnknownRestarted.status().last_event, "outcome_unknown_occurrence_skipped");

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
    expertStore: {
      status: () => ({ ready: true }),
      read: () => ({
        ready: true,
        expertRules: { text: expertText },
        businessKnowledge: { text: "工业设备业务知识" }
      })
    },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async ({ expert }) => {
        assert.equal(expert.expertRules, "旧话术");
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
  resolveOldReply(answerDecision("旧话术生成的回复"));
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
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => (handoffDecision("收到，我把正式报价需求交给同事确认。"))
    },
    scanIncoming: () => handoffCandidates.shift() || { ok: false, reason: "no_unread_message" },
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => (await options.beforeDraft()) ? { ok: true } : { ok: false },
    sendHandoff: async ({ message }) => {
      assert.match(message, /原因：需要处理下单、合同或履约/);
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
  assert.equal(handoffController.status().reply_count, 1, "a human-owned customer must not receive another AI reply");
  assert.equal(deduplicatedHandoffs, 1, "the same human-owned customer must alert only once");
  assert.equal(handoffController.status().held_contacts.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(handoffDataDir, "auto-reply-state.json"), "utf8")).pending_handoff, null, "a verified handoff must clear its pending identity");
  handoffController.pause();

  let retryHandoffCalls = 0;
  let retryHandoffCustomerSends = 0;
  let retryHandoffCandidateAvailable = true;
  const retryHandoffDataDir = path.join(root, "handoff_pre_send_retry");
  const retryHandoffController = createAutoReplyController({
    dataDir: retryHandoffDataDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => (handoffDecision("收到，我先帮您登记。"))
    },
    scanIncoming: () => {
      if (!retryHandoffCandidateAvailable) return { ok: false, reason: "no_unread_message" };
      retryHandoffCandidateAvailable = false;
      return {
        ok: true,
        conversation: "张总",
        message: "请给正式报价",
        runtimeId: "handoff-retry-1",
        pid: 81,
        hWnd: "91",
        context: [{ role: "user", content: "请给正式报价", key: "handoff-retry-1" }]
      };
    },
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      retryHandoffCustomerSends += 1;
      return { ok: true, send_attempted: true };
    },
    sendHandoff: async () => {
      retryHandoffCalls += 1;
      return retryHandoffCalls === 1
        ? { ok: false, blocked_reason: "handoff_conversation_open_failed", send_attempted: false, binding_valid: true }
        : { ok: true, send_attempted: true };
    },
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await retryHandoffController.start()).ok, true);
  await retryHandoffController.runOnce();
  assert.equal(retryHandoffController.status().status, "running");
  assert.equal(retryHandoffController.status().last_event, "handoff_retry_pending");
  assert.ok(JSON.parse(fs.readFileSync(path.join(retryHandoffDataDir, "auto-reply-state.json"), "utf8")).pending_handoff);
  await retryHandoffController.runOnce();
  assert.equal(retryHandoffCalls, 1, "the first handoff retry poll must back off");
  const retryHandoffWaitingState = JSON.parse(fs.readFileSync(path.join(retryHandoffDataDir, "auto-reply-state.json"), "utf8"));
  assert.equal(retryHandoffWaitingState.last_scan_reason, "no_unread_message", "scan health observed after a deferred handoff must still be persisted");
  assert.equal(retryHandoffWaitingState.scan_health, "healthy");
  await retryHandoffController.runOnce();
  assert.equal(retryHandoffCalls, 2);
  assert.equal(retryHandoffCustomerSends, 1, "retrying the file-helper handoff must not resend the customer reply");
  assert.equal(JSON.parse(fs.readFileSync(path.join(retryHandoffDataDir, "auto-reply-state.json"), "utf8")).pending_handoff, null);
  assert.equal(retryHandoffController.status().last_event, "human_handoff_sent");
  retryHandoffController.pause();

  const fairnessCandidates = [
    { runtimeId: "fairness-1", conversation: "张总", message: "这个需求请人工确认" },
    { runtimeId: "fairness-2", conversation: "李经理", message: "另一个普通问题" }
  ];
  let fairnessCustomerSends = 0;
  let fairnessHandoffCalls = 0;
  let fairnessAiCalls = 0;
  const fairnessController = createAutoReplyController({
    dataDir: path.join(root, "handoff_retry_fairness"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => {
        fairnessAiCalls += 1;
        return fairnessAiCalls === 1
          ? handoffDecision("收到，我请同事确认。")
          : answerDecision("这个普通问题可以直接处理。");
      }
    },
    scanIncoming: () => {
      const candidate = fairnessCandidates.shift();
      return candidate ? {
        ok: true,
        conversation: candidate.conversation,
        message: candidate.message,
        runtimeId: candidate.runtimeId,
        pid: 81,
        hWnd: "91",
        context: [{ role: "user", content: candidate.message, key: candidate.runtimeId }]
      } : { ok: false, reason: "no_unread_message" };
    },
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => { assert.equal(await options.beforeDraft(), true); fairnessCustomerSends += 1; return { ok: true, send_attempted: true }; },
    sendHandoff: async () => { fairnessHandoffCalls += 1; return { ok: false, blocked_reason: "handoff_source_window_changed", send_attempted: false, binding_valid: false }; },
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await fairnessController.start()).ok, true);
  await fairnessController.runOnce();
  await fairnessController.runOnce();
  assert.equal(fairnessHandoffCalls, 1, "a handoff bound to an old window must not be retried against a different window");
  assert.equal(fairnessCustomerSends, 2, "a file-helper binding change must not starve other customer replies");
  assert.equal(fairnessController.status().status, "running");
  assert.equal(fairnessController.status().last_event, "handoff_manual_followup_required");
  const fairnessState = JSON.parse(fs.readFileSync(path.join(root, "handoff_retry_fairness", "auto-reply-state.json"), "utf8"));
  assert.equal(fairnessState.pending_handoffs.length, 0);
  assert.equal(fairnessState.manual_followups.length, 1);
  fairnessController.pause();

  const retryThenErrorCandidates = [
    { runtimeId: "retry-error-1", conversation: "张总", message: "先提醒人工" },
    { runtimeId: "retry-error-2", conversation: "李经理", message: "随后触发另一个错误" }
  ];
  let retryThenErrorAiCalls = 0;
  let retryThenErrorHandoffCalls = 0;
  let retryThenErrorCustomerSends = 0;
  const retryThenErrorDir = path.join(root, "handoff_retry_then_other_error");
  const retryThenErrorController = createAutoReplyController({
    dataDir: retryThenErrorDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => {
        retryThenErrorAiCalls += 1;
        if (retryThenErrorAiCalls > 1) throw new Error("另一个客户生成失败");
        return handoffDecision("收到，我请同事确认。");
      }
    },
    scanIncoming: () => {
      const candidate = retryThenErrorCandidates.shift();
      return candidate ? {
        ok: true,
        conversation: candidate.conversation,
        message: candidate.message,
        runtimeId: candidate.runtimeId,
        pid: 81,
        hWnd: "91",
        context: [{ role: "user", content: candidate.message, key: candidate.runtimeId }]
      } : { ok: false, reason: "no_unread_message" };
    },
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => { assert.equal(await options.beforeDraft(), true); retryThenErrorCustomerSends += 1; return { ok: true, send_attempted: true }; },
    sendHandoff: async () => {
      retryThenErrorHandoffCalls += 1;
      return retryThenErrorHandoffCalls < 2
        ? { ok: false, blocked_reason: "atomic_draft_changed", send_attempted: false }
        : { ok: true, send_attempted: true };
    },
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await retryThenErrorController.start()).ok, true);
  await retryThenErrorController.runOnce();
  await retryThenErrorController.runOnce();
  assert.equal(retryThenErrorController.status().status, "paused");
  assert.equal(retryThenErrorController.status().last_event, "system_error_paused", "a model failure for another customer must remain a system error, not a handoff");
  assert.ok(JSON.parse(fs.readFileSync(path.join(retryThenErrorDir, "auto-reply-state.json"), "utf8")).pending_handoff);
  assert.equal((await retryThenErrorController.start()).ok, true);
  await retryThenErrorController.runOnce();
  assert.equal(retryThenErrorHandoffCalls, 2, "the proven-unsent handoff must survive restart and retry instead of being acknowledged away");
  assert.equal(retryThenErrorCustomerSends, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(retryThenErrorDir, "auto-reply-state.json"), "utf8")).pending_handoff, null);
  retryThenErrorController.pause();

  const restartQueueDir = path.join(root, "handoff_queue_restart");
  const restartQueueCandidates = [
    { runtimeId: "restart-handoff-1", conversation: "张总" },
    { runtimeId: "restart-handoff-2", conversation: "李经理" }
  ];
  const deliveredRestartHandoffs = [];
  let deliverRestartHandoffs = false;
  let restartQueueCustomerSends = 0;
  const restartQueueController = createAutoReplyController({
    dataDir: restartQueueDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async ({ context }) => context.at(-1).content.startsWith("fresh-after-backlog")
        ? answerDecision("这个普通问题可以直接处理。")
        : handoffDecision("收到，我请同事确认。")
    },
    scanIncoming: () => {
      const candidate = restartQueueCandidates.shift();
      return candidate ? { ok: true, conversation: candidate.conversation, message: candidate.runtimeId, runtimeId: candidate.runtimeId, pid: 81, hWnd: "91", context: [{ role: "user", content: candidate.runtimeId, key: candidate.runtimeId }] } : { ok: false, reason: "no_unread_message" };
    },
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => { assert.equal(await options.beforeDraft(), true); restartQueueCustomerSends += 1; return { ok: true, send_attempted: true }; },
    sendHandoff: async ({ message }) => {
      if (!deliverRestartHandoffs) return { ok: false, blocked_reason: "atomic_draft_changed", send_attempted: false };
      deliveredRestartHandoffs.push(message);
      return { ok: true, send_attempted: true };
    },
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await restartQueueController.start()).ok, true);
  await restartQueueController.runOnce();
  await restartQueueController.runOnce();
  const queuedBeforeRestart = JSON.parse(fs.readFileSync(path.join(restartQueueDir, "auto-reply-state.json"), "utf8"));
  assert.equal(queuedBeforeRestart.pending_handoffs.length, 2, "every queued handoff identity must be durable before process restart");
  assert.deepEqual(queuedBeforeRestart.pending_handoffs.map((item) => item.delivery_state), ["not_attempted", "queued"]);
  assert.equal(JSON.stringify(queuedBeforeRestart.pending_handoffs).includes("请同事"), false, "handoff message bodies must remain memory-only");
  deliverRestartHandoffs = true;
  restartQueueCandidates.push(
    { runtimeId: "fresh-after-backlog-1", conversation: "已停用" },
    { runtimeId: "fresh-after-backlog-2", conversation: "已停用" }
  );
  await restartQueueController.runOnce();
  await restartQueueController.runOnce();
  assert.match(deliveredRestartHandoffs[0], /restart-handoff-1/);
  assert.match(deliveredRestartHandoffs[1], /restart-handoff-2/);
  assert.equal(restartQueueCustomerSends, 4, "a successfully draining handoff backlog must not starve fresh customer replies");
  assert.equal(JSON.parse(fs.readFileSync(path.join(restartQueueDir, "auto-reply-state.json"), "utf8")).pending_handoffs.length, 0, "queued handoffs must drain in FIFO order");
  restartQueueController.pause();
  fs.writeFileSync(path.join(restartQueueDir, "auto-reply-state.json"), JSON.stringify(queuedBeforeRestart, null, 2), "utf8");

  let restoredQueuePrimeOk = false;
  const restoredQueueController = createAutoReplyController({
    dataDir: restartQueueDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    primeIncoming: () => restoredQueuePrimeOk ? { ok: true } : { ok: false, reason: "history_not_at_bottom" },
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal(restoredQueueController.status().last_event, "recovered_after_restart");
  const restoredQueueStart = await restoredQueueController.start();
  assert.equal(restoredQueueStart.ok, true, "a transient prime failure must not block known-unsent handoff recovery after restart");
  assert.equal(restoredQueueStart.state.scan_health, "checking");
  assert.equal(restoredQueueStart.state.last_event, "handoff_manual_followup_required");
  assert.match(restoredQueueStart.state.last_error, /尚未补发/);
  let restoredQueueState = JSON.parse(fs.readFileSync(path.join(restartQueueDir, "auto-reply-state.json"), "utf8"));
  assert.equal(restoredQueueState.pending_handoffs.length, 0);
  assert.equal(restoredQueueState.manual_followups.length, 2);
  await restoredQueueController.runOnce();
  assert.equal(restoredQueueController.status().last_event, "handoff_manual_followup_required", "ordinary polling must not erase a manual followup task");
  assert.equal(restoredQueueController.status().last_error.includes("尚未补发"), true);
  restoredQueueController.acknowledgeManualFollowup();
  restoredQueueState = JSON.parse(fs.readFileSync(path.join(restartQueueDir, "auto-reply-state.json"), "utf8"));
  assert.equal(restoredQueueState.manual_followups.length, 1, "one confirmation must clear only the currently displayed followup");
  assert.equal(Object.values(restoredQueueState.handoff_notified).filter((item) => item.status === "manual_followup_acknowledged").length, 1);
  assert.equal(restoredQueueController.status().last_event, "handoff_manual_followup_required");
  restoredQueueController.acknowledgeManualFollowup();
  restoredQueueState = JSON.parse(fs.readFileSync(path.join(restartQueueDir, "auto-reply-state.json"), "utf8"));
  assert.equal(restoredQueueState.manual_followups.length, 0);
  assert.equal(Object.values(restoredQueueState.handoff_notified).filter((item) => item.status === "manual_followup_acknowledged").length, 2);
  restoredQueueController.pause();

  const pauseDuringHandoffDir = path.join(root, "pause_during_handoff");
  let resolvePendingHandoff;
  let markHandoffStarted;
  let pauseDuringHandoffCalls = 0;
  const handoffStarted = new Promise((resolve) => { markHandoffStarted = resolve; });
  const pendingHandoffResult = new Promise((resolve) => { resolvePendingHandoff = resolve; });
  const pauseDuringHandoffController = createAutoReplyController({
    dataDir: pauseDuringHandoffDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => (handoffDecision("这个问题我帮您确认一下，稍后回复您。"))
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
      pauseDuringHandoffCalls += 1;
      if (pauseDuringHandoffCalls === 1) {
        markHandoffStarted();
        return pendingHandoffResult;
      }
      return { ok: true, send_attempted: true };
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
  resolvePendingHandoff({ ok: false, blocked_reason: "atomic_draft_changed", send_attempted: false, binding_valid: true });
  await pendingRun;
  const knownUnsentAfterPause = JSON.parse(fs.readFileSync(path.join(pauseDuringHandoffDir, "auto-reply-state.json"), "utf8"));
  assert.equal(knownUnsentAfterPause.last_event, "paused_by_user", "a proven pre-click failure must clear the temporary outcome-unknown warning");
  assert.equal(knownUnsentAfterPause.pending_handoff.delivery_state, "not_attempted");
  assert.equal((await pauseDuringHandoffController.start()).ok, true);
  await pauseDuringHandoffController.runOnce();
  await pauseDuringHandoffController.runOnce();
  assert.equal(pauseDuringHandoffCalls, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(pauseDuringHandoffDir, "auto-reply-state.json"), "utf8")).pending_handoff, null);
  pauseDuringHandoffController.pause();

  const resumeDuringHandoffDir = path.join(root, "resume_during_handoff");
  let resolveResumedHandoff;
  let markResumedHandoffStarted;
  const resumedHandoffStarted = new Promise((resolve) => { markResumedHandoffStarted = resolve; });
  const resumedHandoffResult = new Promise((resolve) => { resolveResumedHandoff = resolve; });
  const resumeDuringHandoffController = createAutoReplyController({
    dataDir: resumeDuringHandoffDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => handoffDecision("收到，员工会继续处理正式报价。")
    },
    scanIncoming: () => ({
      ok: true,
      conversation: "张总",
      message: "请人工给我正式报价",
      runtimeId: "resume-during-handoff-1",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "请人工给我正式报价", key: "resume-during-handoff-1" }]
    }),
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => (await options.beforeDraft()) ? { ok: true, send_attempted: true } : { ok: false },
    sendHandoff: async () => {
      markResumedHandoffStarted();
      return resumedHandoffResult;
    },
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await resumeDuringHandoffController.start()).ok, true);
  const resumeDuringHandoffRun = resumeDuringHandoffController.runOnce();
  await resumedHandoffStarted;
  assert.equal(resumeDuringHandoffController.resumeContact("c1").ok, true);
  resolveResumedHandoff({ ok: true, send_attempted: true });
  await assert.doesNotReject(resumeDuringHandoffRun);
  const resumedDuringHandoffState = JSON.parse(fs.readFileSync(path.join(resumeDuringHandoffDir, "auto-reply-state.json"), "utf8"));
  assert.equal(resumedDuringHandoffState.contact_states.c1, undefined);
  assert.equal(resumedDuringHandoffState.pending_handoff, null);
  assert.equal(resumedDuringHandoffState.pending_handoffs.length, 0);
  assert.equal(resumedDuringHandoffState.manual_followups.length, 0);
  assert.equal(resumeDuringHandoffController.status().held_contacts.some((item) => item.id === "c1"), false);
  resumeDuringHandoffController.pause();

  const unknownDataDir = path.join(root, "unknown_handoff");
  const unknownController = createAutoReplyController({
    dataDir: unknownDataDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => (handoffDecision("这个问题我帮您确认一下，稍后回复您。"))
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
      assert.match(message, /原因：需要处理下单、合同或履约/, "handoff notifications must use the fixed reason code label");
      const persisted = JSON.parse(fs.readFileSync(path.join(unknownDataDir, "auto-reply-state.json"), "utf8"));
      assert.equal(persisted.reply_count, 1, "verified customer reply must be durable before handoff I/O");
      assert.equal(Object.values(persisted.processed).at(-1).status, "sent_verified");
      assert.equal(persisted.last_event, "handoff_pending");
      assert.equal(persisted.pending_handoff.conversation, "李经理", "the pending handoff identity must be durable before handoff I/O");
      assert.match(persisted.pending_handoff.key, /^[a-f0-9]{64}$/, "the pending handoff must persist its dedupe key before handoff I/O");
      assert.equal(persisted.pending_handoff.delivery_state, "sending", "a crash during handoff I/O must recover as outcome unknown, not known-unsent");
      return { ok: false, blocked_reason: "handoff_outcome_unknown", send_attempted: null };
    },
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await unknownController.start()).ok, true);
  await unknownController.runOnce();
  assert.equal(unknownController.status().reply_count, 1, "safe placeholder is sent before handoff");
  assert.equal(unknownController.status().status, "running", "an uncertain employee notification must not pause other customers");
  assert.equal(unknownController.status().last_event, "handoff_manual_followup_required");
  assert.equal(unknownController.status().held_contacts.length, 1);
  const unknownHandoffState = JSON.parse(fs.readFileSync(path.join(unknownDataDir, "auto-reply-state.json"), "utf8"));
  assert.equal(unknownHandoffState.pending_handoff, null, "an outcome-unknown notification must be removed from the automatic retry queue");
  assert.equal(unknownHandoffState.manual_followups.length, 1);
  assert.equal(Object.values(unknownHandoffState.handoff_notified).at(-1).status, "outcome_unknown");
  unknownController.pause();

  const aiConfigFailureDir = path.join(root, "ai_configuration_failure");
  let aiConfigFailureSends = 0;
  let aiConfigFailureHandoffs = 0;
  const aiConfigFailureController = createAutoReplyController({
    dataDir: aiConfigFailureDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => {
        const error = new Error("secret-bearing upstream response with sk-trace-key-canary must not be exposed");
        error.code = "API_KEY_INVALID";
        throw error;
      }
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
  assert.equal(aiConfigFailureSends, 0, "model failures must never send a customer fallback");
  assert.equal(aiConfigFailureHandoffs, 0, "model failures must not manufacture a human handoff");
  assert.equal(aiConfigFailureController.status().reply_count, 0);
  assert.equal(aiConfigFailureController.status().status, "paused");
  assert.equal(aiConfigFailureController.status().last_event, "system_error_paused");
  assert.match(aiConfigFailureController.status().last_error, /API Key 无效/);
  assert.deepEqual(aiConfigFailureController.status().system_error, {
    code: "API_KEY_INVALID",
    category: "configuration",
    message: "DeepSeek API Key 无效或已失效，请检查后重新启动。"
  });
  assert.doesNotMatch(JSON.stringify(aiConfigFailureController.status()), /secret-bearing upstream/);
  const aiFailureDiagnosticText = fs.readFileSync(path.join(aiConfigFailureDir, "auto-reply-diagnostics.jsonl"), "utf8");
  const aiFailureDiagnostics = aiFailureDiagnosticText.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  const aiFailureCandidate = aiFailureDiagnostics.find((entry) => entry.event === "reply_candidate_detected");
  const aiFailureSystemError = aiFailureDiagnostics.find((entry) => entry.event === "system_error");
  assert.match(aiFailureCandidate.trace_id, /^[a-f0-9]{24}$/u);
  assert.equal(aiFailureSystemError.trace_id, aiFailureCandidate.trace_id);
  assert.equal(aiFailureSystemError.error_code, "API_KEY_INVALID");
  assert.equal(Number.isSafeInteger(aiFailureSystemError.duration_ms) && aiFailureSystemError.duration_ms >= 0, true);
  assert.equal(aiFailureDiagnostics.some((entry) => entry.trace_id === aiFailureCandidate.trace_id && entry.event === "reply_send_started"), false);
  assert.doesNotMatch(aiFailureDiagnosticText, /secret-bearing upstream|想了解清洁设备|张总|ai-failure-retry-1|trace-key-canary/);

  const emptyGenerationDir = path.join(root, "empty_generation_continues");
  let emptyGenerationSends = 0;
  const emptyGenerationController = createAutoReplyController({
    dataDir: emptyGenerationDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => { const error = new Error("empty"); error.code = "AI_RESPONSE_EMPTY"; throw error; }
    },
    scanIncoming: () => ({
      ok: true,
      conversation: "张总",
      message: "想了解设备",
      runtimeId: "empty-generation-1",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "想了解设备", key: "empty-generation-1" }]
    }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => { emptyGenerationSends += 1; return { ok: true, send_attempted: true }; },
    sendHandoff: async () => ({ ok: true, send_attempted: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await emptyGenerationController.start()).ok, true);
  await emptyGenerationController.runOnce();
  assert.equal(emptyGenerationSends, 0, "an unusable AI output must never send a customer fallback");
  assert.equal(emptyGenerationController.status().status, "running", "one customer's unusable output must not pause the whole listener");
  assert.equal(emptyGenerationController.status().last_event, "reply_generation_skipped");
  assert.equal(emptyGenerationController.status().last_failure_context.recovery_action, "continue_other_contacts");

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
      expertStore: readyExpert(),
      deepSeekClient: { assertAvailable: () => true, reply: async () => { rateAiCalls += 1; return answerDecision("Continue."); } },
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
      send: async (options) => { assert.equal(await options.beforeDraft(), true); rateSendCalls += 1; return { ok: true }; },
      sendHandoff: async () => ({ ok: true }),
      runStep: async () => ({ ok: true }),
      schedule: () => 1,
      cancelSchedule: () => undefined,
      now: () => new Date("2026-07-14T10:00:00+08:00")
    });
    assert.equal((await rateController.start()).ok, true);
    await rateController.runOnce();
    assert.equal(rateController.status().status, "running");
    assert.equal(rateController.status().last_event, "reply_sent_verified");
    assert.equal(rateAiCalls, 1);
    assert.equal(rateSendCalls, 1);
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
      expertStore: readyExpert(),
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
  const autoReplyUpdates = [];
  const floatingUpdates = [];
  const floatingEvents = {};
  const floatingWebContentEvents = {};
  let floatingOptions;
  let floatingLoad;
  let floatingPosition;
  let floatingWebContents;
  let mainHideCalls = 0;
  let mainShowCalls = 0;
  let floatingHideCalls = 0;
  class FakeAutoReplyWindow {
    constructor(options) {
      floatingOptions = options;
      this.webContents = {
        send: (channel, payload) => floatingUpdates.push({ channel, payload }),
        isLoading: () => true,
        once: (event, handler) => { floatingWebContentEvents[event] = handler; }
      };
      floatingWebContents = this.webContents;
      this.destroyed = false;
    }
    setMenu() {}
    setPosition(x, y) { floatingPosition = { x, y }; }
    show() {}
    showInactive() {}
    hide() { floatingHideCalls += 1; }
    focus() {}
    isDestroyed() { return this.destroyed; }
    once(event, handler) { floatingEvents[event] = handler; }
    on(event, handler) { floatingEvents[event] = handler; }
    loadFile(file, options) { floatingLoad = { file, options }; }
    close() {
      floatingEvents.close?.();
      this.destroyed = true;
      floatingEvents.closed?.();
    }
  }
  const webContents = { send: (channel, payload) => autoReplyUpdates.push({ channel, payload }) };
  const ipcMainWindow = {
    isDestroyed: () => false,
    isFocused: () => true,
    webContents,
    hide: () => { mainHideCalls += 1; },
    show: () => { mainShowCalls += 1; },
    focus: () => undefined
  };
  const ipcController = registerAutoReplyIpc({
    dataDir: path.join(root, "ipc_auto_reply"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    verifyIncoming: () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    getMainWindow: () => ipcMainWindow,
    BrowserWindow: FakeAutoReplyWindow,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    preloadPath: path.join(root, "preload.cjs"),
    rendererPath: path.join(root, "index.html"),
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }
  });
  assert.deepEqual([...handlers.keys()].sort(), ["auto-reply:acknowledge-manual-followup", "auto-reply:pause", "auto-reply:resume-contact", "auto-reply:show-main", "auto-reply:start", "auto-reply:status"]);
  assert.equal((await handlers.get("auto-reply:start")({ sender: webContents }, {})).ok, false);
  assert.equal((await handlers.get("auto-reply:start")({ sender: webContents }, { clickToken: "trusted" })).ok, true);
  assert.equal(floatingOptions.alwaysOnTop, true);
  assert.equal(floatingOptions.show, false, "the progress window must be shown inactive so startup does not steal foreground from WeChat");
  assert.deepEqual({ width: floatingOptions.width, height: floatingOptions.height }, { width: 292, height: 286 }, "auto reply and active touch must share one progress-window footprint");
  assert.deepEqual(floatingPosition, { x: 1606, y: 397 }, "auto reply must use the same 22px screen edge and vertical centering as active touch");
  assert.deepEqual(floatingLoad.options, { query: { floating: "auto-reply" } });
  assert.equal(mainHideCalls, 1, "the progress window must be shown immediately so a transient renderer load event cannot leave the user without visible progress");
  floatingWebContentEvents["did-finish-load"]?.();
  assert.equal(mainHideCalls, 1, "the later renderer-ready event must not change the visible-window state");
  assert.equal((await handlers.get("auto-reply:start")({ sender: floatingWebContents }, { clickToken: "floating-cannot-start" })).ok, false, "the floating renderer must not gain the main-window start authority");
  assert.equal(autoReplyUpdates.at(-1).channel, "auto-reply:update");
  assert.equal(autoReplyUpdates.at(-1).payload.state.status, "running", "successful start must push authoritative state without waiting for renderer polling");
  assert.equal(floatingUpdates.at(-1).payload.state.status, "running", "the floating window must receive the same authoritative state");
  assert.equal((await handlers.get("auto-reply:acknowledge-manual-followup")({ sender: webContents }, {})).ok, false);
  assert.equal((await handlers.get("auto-reply:acknowledge-manual-followup")({ sender: webContents }, { clickToken: "trusted-ack" })).ok, true);
  assert.equal((await handlers.get("auto-reply:resume-contact")({ sender: webContents }, { contactId: "c1" })).ok, false);
  assert.equal((await handlers.get("auto-reply:resume-contact")({ sender: webContents }, { clickToken: "trusted-resume", contactId: "c1" })).ok, false, "a trusted resume must still reject a customer who is not human-owned");
  const preloadInvocations = [];
  const preloadAutoReply = createPreloadApis({
    invoke: (channel, payload) => { preloadInvocations.push({ channel, payload }); return Promise.resolve({ ok: true }); },
    on: () => undefined,
    removeListener: () => undefined
  }).autoReply;
  await preloadAutoReply.resumeContact("c1");
  assert.deepEqual(preloadInvocations.at(-1), { channel: "auto-reply:resume-contact", payload: { clickToken: "", contactId: "c1" } });
  let floatingClosePrevented = false;
  floatingEvents.close?.({ preventDefault: () => { floatingClosePrevented = true; } });
  assert.equal(floatingClosePrevented, true, "closing the progress window must hide it instead of destroying the active listener");
  assert.equal(floatingHideCalls, 1);
  assert.equal(ipcController.status().status, "running", "closing the progress window must not pause automatic replies");
  await preloadAutoReply.showMain();
  assert.deepEqual(preloadInvocations.at(-1), { channel: "auto-reply:show-main", payload: undefined });
  const showMainResult = await handlers.get("auto-reply:show-main")();
  assert.equal(showMainResult.ok, true);
  assert.equal(ipcController.status().status, "running", "returning to the main page must not pause automatic replies");
  assert.equal(floatingHideCalls, 2);
  assert.equal(mainShowCalls, 2);
  await handlers.get("auto-reply:pause")({ sender: webContents }, {});
  assert.equal(autoReplyUpdates.at(-1).payload.state.status, "paused", "only the explicit pause control may stop automatic replies");
  assert.match(fs.readFileSync(path.join(__dirname, "preload-api.cjs"), "utf8"), /auto-reply:update[\s\S]*removeListener/u, "preload must expose a removable auto-reply state subscription");

  const failedLoadHandlers = new Map();
  let rejectFloatingLoad;
  let failedLoadMainShown = 0;
  class FailedLoadAutoReplyWindow extends FakeAutoReplyWindow {
    loadFile() {
      return new Promise((resolve, reject) => {
        rejectFloatingLoad = reject;
      });
    }
  }
  const failedLoadWebContents = { send: () => undefined, once: () => undefined };
  const failedLoadMainWindow = {
    isDestroyed: () => false,
    isFocused: () => true,
    webContents: failedLoadWebContents,
    hide: () => undefined,
    show: () => { failedLoadMainShown += 1; },
    focus: () => undefined
  };
  const failedLoadController = registerAutoReplyIpc({
    dataDir: path.join(root, "ipc_auto_reply_failed_float"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    verifyIncoming: () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    getMainWindow: () => failedLoadMainWindow,
    BrowserWindow: FailedLoadAutoReplyWindow,
    preloadPath: path.join(root, "preload.cjs"),
    rendererPath: path.join(root, "missing-index.html"),
    ipcMain: { handle: (channel, handler) => failedLoadHandlers.set(channel, handler) }
  });
  assert.equal((await failedLoadHandlers.get("auto-reply:start")({ sender: failedLoadWebContents }, { clickToken: "trusted-failed-load" })).ok, true);
  rejectFloatingLoad(new Error("fixture renderer load failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failedLoadController.status().status, "running", "a broken progress renderer must not stop the auto-reply listener");
  assert.notEqual(failedLoadController.status().last_event, "progress_window_load_failed");
  assert.equal(failedLoadMainShown, 1, "a broken progress renderer must restore the main window");

  const recoveryDir = path.join(root, "recovery_auto_reply");
  fs.mkdirSync(recoveryDir, { recursive: true });
  fs.writeFileSync(path.join(recoveryDir, "auto-reply-state.json"), JSON.stringify({ version: 1, status: "running", daily_date: "2026-07-14", reply_count: 7, contact_ids: ["c1"], processed: { old: true } }), "utf8");
  const recovered = createAutoReplyController({
    dataDir: recoveryDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    verifyIncoming: () => ({ ok: true }),
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  const migratedState = JSON.parse(fs.readFileSync(path.join(recoveryDir, "auto-reply-state.json"), "utf8"));
  assert.equal(migratedState.version, 4);
  assert.deepEqual(migratedState.processed, {}, "legacy fingerprints must be discarded during v1 migration");
  assert.equal("contact_ids" in migratedState, false, "legacy whitelist state must be discarded during v1 migration");
  assert.equal(recovered.status().status, "paused");
  assert.equal(recovered.status().reply_count, 7);
  assert.equal(recovered.status().last_event, "state_upgraded_paused");
  assert.equal(recovered.status().scan_health, "unknown");
  assert.equal(recovered.status().last_scan_at, "");
  assert.equal(recovered.status().last_scan_success_at, "");
  assert.equal(recovered.status().last_scan_reason, "");
  assert.equal(recovered.status().consecutive_scan_failures, 0);

  const legacyAiWarningDir = path.join(root, "legacy_ai_warning_recovery");
  fs.mkdirSync(legacyAiWarningDir, { recursive: true });
  fs.writeFileSync(path.join(legacyAiWarningDir, "auto-reply-state.json"), JSON.stringify({
    version: 4,
    status: "paused",
    daily_date: "2026-07-14",
    last_event: "app_closed",
    last_error: "",
    system_error: null,
    last_ai_warning_code: "AI_RESPONSE_EMPTY",
    last_ai_warning: "DeepSeek 本次未生成可靠回复（AI_RESPONSE_EMPTY），已发送兜底消息并提醒人工。"
  }), "utf8");
  const legacyAiWarningRecovery = createAutoReplyController({
    dataDir: legacyAiWarningDir,
    activeTouchDir,
    coordinator,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal("last_ai_warning" in legacyAiWarningRecovery.status(), false, "resolved legacy AI warnings must not return as current page state after restart");
  assert.equal("last_ai_warning_code" in legacyAiWarningRecovery.status(), false, "legacy AI warning codes must not return as current page state after restart");
  const cleanedLegacyAiWarningState = JSON.parse(fs.readFileSync(path.join(legacyAiWarningDir, "auto-reply-state.json"), "utf8"));
  assert.equal("last_ai_warning" in cleanedLegacyAiWarningState, false, "restart migration must remove the obsolete AI warning message from runtime state");
  assert.equal("last_ai_warning_code" in cleanedLegacyAiWarningState, false, "restart migration must remove the obsolete AI warning code from runtime state");

  const staleSystemErrorDir = path.join(root, "stale_system_error_recovery");
  fs.mkdirSync(staleSystemErrorDir, { recursive: true });
  fs.writeFileSync(path.join(staleSystemErrorDir, "auto-reply-state.json"), JSON.stringify({
    version: 4,
    status: "paused",
    daily_date: "2026-07-14",
    last_event: "paused_by_user",
    last_error: "DeepSeek 返回格式无效，自动回复已暂停。",
    system_error: { code: "AI_RESPONSE_INVALID", category: "invalid_response" },
    last_failure_context: {
      phase: "generate",
      code: "ai_response_invalid",
      send_attempted: false,
      send_result: "not_attempted"
    }
  }), "utf8");
  const staleSystemErrorRecovery = createAutoReplyController({
    dataDir: staleSystemErrorDir,
    activeTouchDir,
    coordinator,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal(staleSystemErrorRecovery.status().system_error, null, "a previous-process AI failure must not return as a current red error after restart");
  assert.equal(staleSystemErrorRecovery.status().last_failure_context, null);
  assert.equal(staleSystemErrorRecovery.status().last_error, "");
  assert.equal(staleSystemErrorRecovery.status().last_event, "paused_by_user");
  const cleanedStaleSystemErrorState = JSON.parse(fs.readFileSync(path.join(staleSystemErrorDir, "auto-reply-state.json"), "utf8"));
  assert.equal(cleanedStaleSystemErrorState.system_error, null, "restart must remove stale AI errors from current runtime state while diagnostics remain on disk");
  assert.equal(cleanedStaleSystemErrorState.last_failure_context, null);

  assert.deepEqual(Object.keys(recovered.status()).sort(), [
    "activity",
    "consecutive_scan_failures",
    "held_contacts",
    "last_error",
    "last_event",
    "last_scan_at",
    "last_scan_reason",
    "last_scan_success_at",
    "last_failure_context",
    "pending_retry_count",
    "reply_count",
    "scan_health",
    "status",
    "system_error",
    "updated_at"
  ].sort(), "public v4 state must expose only the documented control, handoff, scan-health, and live-activity fields");
  assert.deepEqual(Object.keys(recovered.status().activity).sort(), [
    "action",
    "contact_label",
    "delivery_status",
    "detail_code",
    "phase",
    "phase_started_at",
    "reason_code",
    "trace_id"
  ]);

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
  assert.equal(runningRecovery.status().scan_health, "unknown", "old v2 state without scan fields must remain readable");
  assert.equal(JSON.parse(fs.readFileSync(path.join(runningRecoveryDir, "auto-reply-state.json"), "utf8")).status, "paused");

  for (const internalReason of ["baseline_ready", "candidate_detected", "wechat_operation_busy", "unknown_scan_reason"]) {
    const internalReasonDir = path.join(root, `internal_reason_${internalReason}`);
    fs.mkdirSync(internalReasonDir, { recursive: true });
    fs.writeFileSync(path.join(internalReasonDir, "auto-reply-state.json"), JSON.stringify({
      version: 4,
      status: "paused",
      daily_date: "2026-07-14",
      scan_health: internalReason === "wechat_operation_busy" ? "waiting" : "healthy",
      last_scan_reason: internalReason,
      consecutive_scan_failures: 0
    }), "utf8");
    const internalReasonRecovery = createAutoReplyController({
      dataDir: internalReasonDir,
      activeTouchDir,
      coordinator,
      now: () => new Date("2026-07-14T10:00:00+08:00")
    });
    assert.equal(internalReasonRecovery.status().last_scan_reason, internalReason, `restart must preserve internal scan reason ${internalReason}`);
  }

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

  const interruptedSendDir = path.join(root, "interrupted_send_recovery");
  fs.mkdirSync(interruptedSendDir, { recursive: true });
  fs.writeFileSync(path.join(interruptedSendDir, "auto-reply-state.json"), JSON.stringify({
    version: 4,
    status: "paused",
    daily_date: "2026-07-14",
    processed: {
      interrupted: { status: "sending", action: "clarify", contact_id: "c1", at: "2026-07-14T02:00:00.000Z" },
      interrupted_handoff: { status: "sending", action: "handoff", contact_id: "c2", conversation: "李经理", at: "2026-07-14T02:01:00.000Z" },
      legacy_interrupted: { status: "sending", contact_id: "dup-1", conversation: "客户甲", at: "2026-07-14T02:02:00.000Z" },
      verified: { status: "sent_verified", contact_id: "dup-2", at: "2026-07-14T01:00:00.000Z" }
    },
    last_event: "paused_by_user",
    last_error: ""
  }), "utf8");
  const interruptedSendRecovery = createAutoReplyController({
    dataDir: interruptedSendDir,
    activeTouchDir,
    coordinator,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal(interruptedSendRecovery.status().status, "paused");
  assert.equal(interruptedSendRecovery.status().last_event, "send_outcome_unknown_paused", "a restart during send must surface an actionable pause");
  assert.match(interruptedSendRecovery.status().last_error, /发送结果无法确认/);
  const interruptedSendState = JSON.parse(fs.readFileSync(path.join(interruptedSendDir, "auto-reply-state.json"), "utf8"));
  assert.equal(interruptedSendState.processed.interrupted.status, "outcome_unknown", "a persisted sending attempt must not remain a silent terminal state after restart");
  assert.equal(interruptedSendState.processed.interrupted_handoff.status, "outcome_unknown");
  assert.equal(interruptedSendState.processed.legacy_interrupted.status, "outcome_unknown");
  assert.equal(interruptedSendState.processed.verified.status, "sent_verified", "restart recovery must not rewrite completed sends");
  assert.equal(interruptedSendState.reply_guards.c1.delivery_status, "outcome_unknown", "an interrupted send must recover a persistent occurrence fence");
  assert.equal(interruptedSendState.reply_guards.c1.turn_state, "awaiting_outgoing_observation");
  assert.equal(interruptedSendState.reply_guards["dup-2"], undefined, "an unrelated historical sent_verified entry without occurrence evidence must not migrate into a blocking contact fence");
  assert.deepEqual(interruptedSendState.contact_states.c1, { clarify_pending: true, human_owned: false }, "a possibly-sent clarification must remain consumed after restart");
  assert.deepEqual(interruptedSendState.contact_states.c2, { clarify_pending: false, human_owned: true }, "a possibly-sent handoff must keep that customer under employee ownership after restart");
  assert.deepEqual(interruptedSendState.contact_states["dup-1"], { clarify_pending: false, human_owned: true }, "a legacy v4 send without action must recover conservatively under employee ownership");
  assert.equal(interruptedSendState.manual_followups.length, 2, "interrupted and legacy-unknown handoffs must remain visible as employee followups after restart");
  assert.deepEqual(interruptedSendState.manual_followups.map((item) => [item.contact_id, item.conversation]), [["c2", "李经理"], ["dup-1", "客户甲"]]);

  const legacyRawGuardDir = path.join(root, "legacy_raw_sent_guard");
  fs.mkdirSync(legacyRawGuardDir, { recursive: true });
  fs.writeFileSync(path.join(legacyRawGuardDir, "auto-reply-state.json"), JSON.stringify({
    version: 2,
    status: "paused",
    daily_date: "2026-07-14",
    processed: {},
    reply_guards: {
      c2: {
        contact_id: "c2",
        incoming_evidence: "legacy-evidence",
        evidence_kind: "visual",
        delivery_status: "sent_verified",
        turn_state: "awaiting_outgoing_observation",
        at: "2026-07-14T01:00:00.000Z"
      }
    }
  }), "utf8");
  const legacyRawGuard = createAutoReplyController({
    dataDir: legacyRawGuardDir,
    activeTouchDir,
    coordinator,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(legacyRawGuardDir, "auto-reply-state.json"), "utf8")).reply_guards.c2, undefined, "ordinary v2 visual guards must not block a new portable build");

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

  const mixedRecoveryDir = path.join(root, "mixed_handoff_recovery");
  fs.mkdirSync(mixedRecoveryDir, { recursive: true });
  const knownUnsent = { key: "known-unsent", contact_id: "c1", conversation: "张总", at: "2026-07-14T02:00:00.000Z", delivery_state: "not_attempted" };
  const outcomeUnknown = { key: "outcome-unknown", contact_id: "c2", conversation: "李经理", at: "2026-07-14T03:00:00.000Z", delivery_state: "outcome_unknown" };
  fs.writeFileSync(path.join(mixedRecoveryDir, "auto-reply-state.json"), JSON.stringify({
    version: 2,
    status: "running",
    daily_date: "2026-07-14",
    pending_handoff: knownUnsent,
    pending_handoffs: [knownUnsent, outcomeUnknown]
  }), "utf8");
  const mixedRecovery = createAutoReplyController({
    dataDir: mixedRecoveryDir,
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await mixedRecovery.start()).ok, false, "an outcome-unknown item behind known-unsent metadata must still block for confirmation");
  let mixedState = JSON.parse(fs.readFileSync(path.join(mixedRecoveryDir, "auto-reply-state.json"), "utf8"));
  assert.equal(mixedState.manual_followups.length, 1);
  assert.equal(mixedState.pending_handoffs.length, 1);
  assert.equal(mixedState.pending_handoff.delivery_state, "outcome_unknown");
  assert.equal((await mixedRecovery.start()).ok, true);
  assert.equal(mixedRecovery.status().last_event, "handoff_manual_followup_required");
  mixedRecovery.acknowledgeManualFollowup();
  mixedState = JSON.parse(fs.readFileSync(path.join(mixedRecoveryDir, "auto-reply-state.json"), "utf8"));
  assert.equal(mixedState.manual_followups.length, 0);
  mixedRecovery.pause();

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
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => (answerDecision("新的一天收到。"))
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

  let discoveredSend = null;
  const discoveredController = createAutoReplyController({
    dataDir: path.join(root, "discovered_alias"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => (answerDecision("Received."))
    },
    scanIncoming: () => ({
      ok: true,
      conversation: "阿张",
      discoveredConversation: true,
      message: "Hello from another computer",
      runtimeId: "remote-alias-1",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "Hello from another computer", key: "remote-alias-1" }]
    }),
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      discoveredSend = options;
      assert.equal(await options.beforeDraft(), true);
      return { ok: true };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-15T10:00:00+08:00")
  });
  assert.equal((await discoveredController.start()).ok, true);
  await discoveredController.runOnce();
  assert.equal(discoveredSend?.expectedConversation, "阿张", "a unique synced nickname may bind the rendered WeChat conversation");
  assert.equal(discoveredController.status().reply_count, 1);
  discoveredController.pause();

  let arbitraryDiscoverySends = 0;
  const arbitraryDiscoveryController = createAutoReplyController({
    dataDir: path.join(root, "arbitrary_discovery_rejected"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => (answerDecision("Must not send."))
    },
    scanIncoming: () => ({
      ok: true,
      conversation: "Remote Alias",
      discoveredConversation: true,
      message: "Unknown contact",
      runtimeId: "remote-unknown-1",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "Unknown contact", key: "remote-unknown-1" }]
    }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => { arbitraryDiscoverySends += 1; return { ok: true }; },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-15T10:00:00+08:00")
  });
  assert.equal((await arbitraryDiscoveryController.start()).ok, true);
  await arbitraryDiscoveryController.runOnce();
  assert.equal(arbitraryDiscoverySends, 0, "visual autodiscovery must never authorize an unsynced conversation");
  assert.equal(arbitraryDiscoveryController.status().last_event, "conversation_not_eligible");
  arbitraryDiscoveryController.pause();

  const messageDrivenCandidates = [
    {
      conversationEvidence: "visual-unread-row:128",
      message: "New customer message",
      runtimeId: `visual:v2:${"d".repeat(64)}`,
      messageSignature: "e".repeat(64),
      pid: 81,
      hWnd: "91"
    },
    {
      conversationEvidence: "visual-unread-row:256",
      message: "Another customer message",
      runtimeId: `visual:v2:${"f".repeat(64)}`,
      messageSignature: "a".repeat(64),
      pid: 82,
      hWnd: "92"
    }
  ];
  const messageDrivenSends = [];
  const messageDrivenController = createAutoReplyController({
    dataDir: path.join(root, "message_driven_unread"),
    activeTouchDir,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => (answerDecision("Message-driven reply."))
    },
    scanIncoming: () => {
      const candidate = messageDrivenCandidates.shift();
      return candidate ? {
        ok: true,
        conversation: "OCR title far from the contact name",
        conversationEvidence: candidate.conversationEvidence,
        messageDriven: true,
        source: "unread_badge",
        message: candidate.message,
        runtimeId: candidate.runtimeId,
        messageSignature: candidate.messageSignature,
        visualMode: "visual_render_v1",
        pid: candidate.pid,
        hWnd: candidate.hWnd,
        context: [{ role: "user", content: candidate.message, key: candidate.runtimeId }]
      } : { ok: false, reason: "no_unread_message" };
    },
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      messageDrivenSends.push(options);
      assert.equal(options.messageDriven, true);
      assert.match(options.contactId, /^visual-inbound-/u);
      assert.equal(options.frozenContact.name, "");
      return { ok: true };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-15T10:00:00+08:00")
  });
  assert.equal((await messageDrivenController.start()).ok, true);
  await messageDrivenController.runOnce();
  await messageDrivenController.runOnce();
  assert.equal(messageDrivenSends[0]?.expectedConversation, "OCR title far from the contact name");
  assert.equal(messageDrivenSends.length, 2, "each distinct red-dot message must remain replyable");
  assert.equal(new Set(messageDrivenSends.map((item) => item.contactId)).size, 1, "transient visual evidence must not split one conversation into multiple customer states");
  assert.equal(messageDrivenController.status().reply_count, 2, "a red-dot incoming message must not require contact-name authorization");
  messageDrivenController.pause();

  const strictScopeCandidates = [
    {
      ok: true,
      conversation: "李经理",
      message: "This must stay outside the selected test scope.",
      runtimeId: "strict-other-contact",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "This must stay outside the selected test scope.", key: "strict-other-contact" }]
    },
    {
      ok: true,
      conversation: "OCR title far from the contact name",
      conversationEvidence: "visual-unread-row:strict",
      messageDriven: true,
      message: "This must not bypass the selected test scope.",
      runtimeId: `visual:v2:${"f".repeat(64)}`,
      messageSignature: "a".repeat(64),
      visualMode: "visual_render_v1",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "This must not bypass the selected test scope.", key: `visual:v2:${"f".repeat(64)}` }]
    },
    {
      ok: true,
      conversation: "张总",
      conversationEvidence: "张忐",
      message: "A fuzzy visual title must not be promoted into the selected test contact.",
      runtimeId: `visual:v2:${"e".repeat(64)}`,
      messageSignature: "b".repeat(64),
      visualMode: "visual_render_v1",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "A fuzzy visual title must not be promoted into the selected test contact.", key: `visual:v2:${"e".repeat(64)}` }]
    },
    {
      ok: true,
      conversation: "张总",
      conversationEvidence: "张总",
      messageDriven: false,
      source: "unread_badge",
      message: "This red-dot message belongs to the one selected test contact.",
      runtimeId: `visual:v2:${"c".repeat(64)}`,
      messageSignature: "d".repeat(64),
      visualMode: "visual_render_v1",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "This red-dot message belongs to the one selected test contact.", key: `visual:v2:${"c".repeat(64)}` }]
    }
  ];
  const strictScopeScans = [];
  const strictScopePrimes = [];
  const strictScopeScanOptions = [];
  const strictScopePrimeOptions = [];
  const strictScopeVerifyOptions = [];
  let strictScopeReplies = 0;
  let strictScopeSends = 0;
  const strictScopeDir = path.join(root, "strict_test_scope");
  const strictScopeController = createAutoReplyController({
    dataDir: strictScopeDir,
    activeTouchDir,
    singleContactScopeRequired: true,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => {
        strictScopeReplies += 1;
        return answerDecision("Only the selected contact receives this.");
      }
    },
    primeIncoming: (aliases, matchOptions) => {
      strictScopePrimes.push([...aliases]);
      strictScopePrimeOptions.push(matchOptions);
      return { ok: true, source: "session_prime", primed: true, latestRole: "assistant" };
    },
    scanIncoming: (aliases, matchOptions) => {
      strictScopeScans.push([...aliases]);
      strictScopeScanOptions.push(matchOptions);
      return strictScopeCandidates.shift() || { ok: false, reason: "no_unread_message" };
    },
    verifyIncoming: (_candidate, matchOptions) => {
      strictScopeVerifyOptions.push(matchOptions);
      return { ok: true };
    },
    send: async (options) => {
      strictScopeSends += 1;
      assert.equal(options.contactId, "c1");
      assert.equal(options.messageDriven, false);
      assert.equal(options.exactConversationMatch, true);
      assert.equal(await options.beforeDraft(), true);
      return { ok: true };
    },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-15T10:00:00+08:00")
  });
  assert.equal((await strictScopeController.start()).ok, false, "the test edition must reject a start without an explicitly selected contact");
  assert.equal(strictScopePrimes.length, 0, "a missing test scope must not prime WeChat");
  assert.equal(strictScopeScans.length, 0, "a missing test scope must not scan WeChat");
  assert.equal(strictScopeReplies, 0, "a missing test scope must not call AI");
  assert.equal(strictScopeSends, 0, "a missing test scope must not send");
  const testScopeOptions = strictScopeController.status().test_scope?.available_contacts || [];
  assert.equal(testScopeOptions.find((contact) => contact.id === "c1")?.label, "共同备注（会话：张总）", "the test selector must show a globally unique alias when remarks collide");
  assert.equal(testScopeOptions.find((contact) => contact.id === "c2")?.label, "共同备注（会话：李经理）", "the test selector must distinguish contacts with the same remark");
  assert.equal((await strictScopeController.start({ contactId: "c1" })).ok, true);
  assert.deepEqual(strictScopePrimes[0].sort(), ["张总", "阿张"].sort(), "a selected test contact must retain only aliases that are globally unique across all synced contacts");
  assert.equal(strictScopePrimeOptions[0]?.exactConversationMatch, true, "strict scope must prime with exact conversation matching");
  await strictScopeController.runOnce();
  assert.equal(strictScopeReplies, 0, "a different synced contact must not reach AI in the selected test scope");
  assert.equal(strictScopeSends, 0, "a different synced contact must not receive a reply in the selected test scope");
  assert.equal(strictScopeController.status().last_event, "conversation_not_eligible");
  assert.equal(strictScopeController.status().activity?.phase, "waiting");
  assert.equal(strictScopeController.status().activity?.detail_code, "conversation_not_eligible");
  await strictScopeController.runOnce();
  assert.equal(strictScopeReplies, 0, "an unmapped unread badge must not bypass the selected test scope");
  assert.equal(strictScopeSends, 0, "an unmapped unread badge must not send in the selected test scope");
  await strictScopeController.runOnce();
  assert.equal(strictScopeReplies, 0, "a fuzzy visual title must not bypass the selected test scope");
  assert.equal(strictScopeSends, 0, "a fuzzy visual title must not send in the selected test scope");
  assert.equal(strictScopeScanOptions.at(-1)?.exactConversationMatch, true, "strict scope must scan with exact conversation matching");
  await strictScopeController.runOnce();
  assert.equal(strictScopeReplies, 1);
  assert.equal(strictScopeSends, 1);
  assert.equal(strictScopeController.status().last_event, "reply_sent_verified", "an exactly rebound red-dot occurrence must reach the selected test contact");
  assert.equal(strictScopeController.status().activity?.phase, "sent_verified");
  assert.match(strictScopeController.status().activity?.trace_id || "", /^[a-f0-9]{24}$/u);
  const strictScopeDiagnosticText = fs.readFileSync(path.join(strictScopeDir, "auto-reply-diagnostics.jsonl"), "utf8");
  const strictScopeDiagnostics = strictScopeDiagnosticText.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(strictScopeDiagnostics.some((entry) => entry.event === "reply_candidate_rejected" && entry.code === "conversation_not_eligible"), true, "a clicked-but-rejected conversation must leave a visible diagnostic terminus");
  assert.doesNotMatch(strictScopeDiagnosticText, /This must stay outside|This must not bypass|fuzzy visual title|red-dot message belongs/u, "scope diagnostics must not contain customer text");
  strictScopeController.pause();
  assert.equal((await strictScopeController.start()).ok, false, "pausing must clear the test selection before another start");
  const strictScopeState = JSON.parse(fs.readFileSync(path.join(strictScopeDir, "auto-reply-state.json"), "utf8"));
  assert.equal(Object.hasOwn(strictScopeState, "test_contact_scope"), false, "the selected test contact must never persist in auto-reply state");

  let restartScopeSourcePrimes = 0;
  const restartScopeDir = path.join(root, "strict_test_scope_restart");
  const restartScopeSource = createAutoReplyController({
    dataDir: restartScopeDir,
    activeTouchDir,
    singleContactScopeRequired: true,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true, reply: async () => (answerDecision("Must not send.")) },
    primeIncoming: () => { restartScopeSourcePrimes += 1; return { ok: true, source: "session_prime", primed: true }; },
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-15T10:00:00+08:00")
  });
  assert.equal((await restartScopeSource.start({ contactId: "c1" })).ok, true);
  assert.equal(restartScopeSourcePrimes, 1);
  let restartScopePrimes = 0;
  let restartScopeScans = 0;
  let restartScopeReplies = 0;
  let restartScopeSends = 0;
  const restartedScopeController = createAutoReplyController({
    dataDir: restartScopeDir,
    activeTouchDir,
    singleContactScopeRequired: true,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true, reply: async () => { restartScopeReplies += 1; return answerDecision("Must not send."); } },
    primeIncoming: () => { restartScopePrimes += 1; return { ok: true, source: "session_prime", primed: true }; },
    scanIncoming: () => { restartScopeScans += 1; return { ok: false, reason: "no_unread_message" }; },
    verifyIncoming: () => ({ ok: true }),
    send: async () => { restartScopeSends += 1; return { ok: true }; },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-15T10:00:00+08:00")
  });
  assert.equal(restartedScopeController.status().test_scope?.enforced, false, "a reconstructed controller must not inherit the prior test selection");
  assert.equal((await restartedScopeController.start()).code, "test_contact_required");
  assert.deepEqual([restartScopePrimes, restartScopeScans, restartScopeReplies, restartScopeSends], [0, 0, 0, 0], "restart without a new selection must not touch WeChat, AI or send");

  for (const windowReason of ["wechat_window_changed", "wechat_window_identity_mismatch", "wechat_window_missing"]) {
    let changedWindowScopeScans = 0;
    let changedWindowScopeSends = 0;
    const changedWindowScopeController = createAutoReplyController({
      dataDir: path.join(root, `strict_test_scope_${windowReason}`),
      activeTouchDir,
      singleContactScopeRequired: true,
      coordinator,
      expertStore: readyExpert(),
      deepSeekClient: { assertAvailable: () => true, reply: async () => (answerDecision("Must not send.")) },
      primeIncoming: () => ({ ok: true, source: "session_prime", primed: true }),
      scanIncoming: () => { changedWindowScopeScans += 1; return { ok: false, reason: windowReason }; },
      verifyIncoming: () => ({ ok: true }),
      send: async () => { changedWindowScopeSends += 1; return { ok: true }; },
      sendHandoff: async () => ({ ok: true }),
      runStep: async () => ({ ok: true }),
      schedule: () => 1,
      cancelSchedule: () => undefined,
      now: () => new Date("2026-07-15T10:00:00+08:00")
    });
    assert.equal((await changedWindowScopeController.start({ contactId: "c1" })).ok, true);
    await changedWindowScopeController.runOnce();
    const changedWindowScopeState = changedWindowScopeController.status();
    assert.equal(changedWindowScopeState.status, "paused", `${windowReason} must require a new test-contact selection`);
    assert.equal(changedWindowScopeState.last_event, "test_scope_window_changed");
    assert.equal(changedWindowScopeState.test_scope?.enforced, false, "a paused test scope must not retain the prior contact selection");
    assert.equal(changedWindowScopeSends, 0, "a changed WeChat window must stop before sending");
    const scansBeforeBlockedRerun = changedWindowScopeScans;
    await changedWindowScopeController.runOnce();
    assert.equal(changedWindowScopeScans, scansBeforeBlockedRerun, "the strict scope must stay paused until a new contact is selected");
  }

  const unboundCollisionContacts = writeContactsFixture("strict_test_scope_unbound_collision_contacts", [
    { id: "target", name: "同一会话", allowed: true, wechatAccountId: "wx-target" },
    { id: "unbound", name: "同一会话", allowed: true }
  ]);
  let unboundCollisionPrimeCalls = 0;
  let unboundCollisionScanCalls = 0;
  let unboundCollisionReplyCalls = 0;
  let unboundCollisionSendCalls = 0;
  const unboundCollisionController = createAutoReplyController({
    dataDir: path.join(root, "strict_test_scope_unbound_collision"),
    activeTouchDir: unboundCollisionContacts,
    singleContactScopeRequired: true,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true, reply: async () => { unboundCollisionReplyCalls += 1; return answerDecision("Must not send."); } },
    primeIncoming: () => { unboundCollisionPrimeCalls += 1; return { ok: true, source: "session_prime", primed: true }; },
    scanIncoming: () => { unboundCollisionScanCalls += 1; return { ok: false, reason: "no_unread_message" }; },
    verifyIncoming: () => ({ ok: true }),
    send: async () => { unboundCollisionSendCalls += 1; return { ok: true }; },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-15T10:00:00+08:00")
  });
  assert.equal(unboundCollisionController.status().test_scope?.available_contacts.some((contact) => contact.id === "target"), false, "an unbound colliding alias must make the target unavailable");
  assert.equal((await unboundCollisionController.start({ contactId: "target" })).code, "test_contact_alias_ambiguous");
  assert.deepEqual([unboundCollisionPrimeCalls, unboundCollisionScanCalls, unboundCollisionReplyCalls, unboundCollisionSendCalls], [0, 0, 0, 0]);

  const duplicateIdContacts = writeContactsFixture("strict_test_scope_duplicate_id_contacts", [
    { id: "duplicate-id", name: "甲联系人", allowed: true, wechatAccountId: "wx-a" },
    { id: "duplicate-id", name: "乙联系人", allowed: true, wechatAccountId: "wx-b" }
  ]);
  let duplicateIdPrimeCalls = 0;
  let duplicateIdScanCalls = 0;
  let duplicateIdReplyCalls = 0;
  let duplicateIdSendCalls = 0;
  const duplicateIdController = createAutoReplyController({
    dataDir: path.join(root, "strict_test_scope_duplicate_id"),
    activeTouchDir: duplicateIdContacts,
    singleContactScopeRequired: true,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true, reply: async () => { duplicateIdReplyCalls += 1; return answerDecision("Must not send."); } },
    primeIncoming: () => { duplicateIdPrimeCalls += 1; return { ok: true, source: "session_prime", primed: true }; },
    scanIncoming: () => { duplicateIdScanCalls += 1; return { ok: false, reason: "no_unread_message" }; },
    verifyIncoming: () => ({ ok: true }),
    send: async () => { duplicateIdSendCalls += 1; return { ok: true }; },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-15T10:00:00+08:00")
  });
  assert.equal(duplicateIdController.status().test_scope?.available_contacts.some((contact) => contact.id === "duplicate-id"), false, "ambiguous IDs must not become selectable");
  assert.equal((await duplicateIdController.start({ contactId: "duplicate-id" })).code, "test_contact_id_ambiguous");
  assert.deepEqual([duplicateIdPrimeCalls, duplicateIdScanCalls, duplicateIdReplyCalls, duplicateIdSendCalls], [0, 0, 0, 0]);

  let invalidatedScopeScans = 0;
  let invalidatedScopeSends = 0;
  const invalidatedScopeController = createAutoReplyController({
    dataDir: path.join(root, "strict_test_scope_invalidated"),
    activeTouchDir,
    singleContactScopeRequired: true,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true, reply: async () => (answerDecision("Must not send.")) },
    primeIncoming: () => ({ ok: true, source: "session_prime", primed: true }),
    scanIncoming: () => { invalidatedScopeScans += 1; return { ok: false, reason: "no_unread_message" }; },
    verifyIncoming: () => ({ ok: true }),
    send: async () => { invalidatedScopeSends += 1; return { ok: true }; },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-15T10:00:00+08:00")
  });
  assert.equal((await invalidatedScopeController.start({ contactId: "c1" })).ok, true);
  const changedScopeContacts = JSON.parse(fs.readFileSync(path.join(activeTouchDir, "contacts.json"), "utf8"));
  changedScopeContacts.find((contact) => contact.id === "c1").wechatAccountId = "wx-b";
  fs.writeFileSync(path.join(activeTouchDir, "contacts.json"), JSON.stringify(changedScopeContacts), "utf8");
  await invalidatedScopeController.runOnce();
  assert.equal(invalidatedScopeController.status().status, "paused", "a changed synced account binding must stop the selected test scope");
  assert.equal(invalidatedScopeController.status().last_event, "test_contact_scope_changed");
  assert.equal(invalidatedScopeScans, 0, "a changed selected scope must stop before another WeChat scan");
  assert.equal(invalidatedScopeSends, 0, "a changed selected scope must stop before sending");

  const strictIpcHandlers = new Map();
  registerAutoReplyIpc({
    dataDir: path.join(root, "strict_test_scope_ipc"),
    activeTouchDir,
    singleContactScopeRequired: true,
    coordinator,
    expertStore: readyExpert(),
    deepSeekClient: { assertAvailable: () => true },
    primeIncoming: () => ({ ok: true, source: "session_prime", primed: true }),
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => ({ ok: true }),
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    getMainWindow: () => ({ isDestroyed: () => false, isFocused: () => true, webContents }),
    ipcMain: { handle: (channel, handler) => strictIpcHandlers.set(channel, handler) }
  });
  assert.equal((await strictIpcHandlers.get("auto-reply:start")({ sender: webContents }, { clickToken: "strict-missing-contact" })).ok, false, "the trusted test IPC must still reject a missing contact ID");
  assert.equal((await strictIpcHandlers.get("auto-reply:start")({ sender: webContents }, { clickToken: "strict-selected-contact", contactId: "c1" })).ok, true, "the trusted test IPC must forward the selected contact ID to the controller");
  console.log("auto-reply v4 self-check passed");
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
