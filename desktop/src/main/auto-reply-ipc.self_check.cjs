const assert = require("node:assert/strict");
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
const { createWechatVisualAutoReplyDriver } = require("../../rpa/active_touch/wechat_auto_reply_visual_driver.dev.cjs");

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
    { reply: "我先根据场景继续帮您缩小范围。", intent: true, intentReason: "客户初步询价", needsHuman: false, handoffReason: "" },
    { reply: "收到，我继续帮您确认第二个方案。", intent: false, intentReason: "", needsHuman: false, handoffReason: "" },
    { reply: "我帮您确认一下，稍后回复您。", intent: false, intentReason: "", needsHuman: true, handoffReason: "资料未覆盖" }
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
  const coordinator = {
    acquire: ({ state }) => state === "replying" ? { ok: true, lock: { owner: "reply-owner" } } : { ok: false },
    update: () => ({ ok: true }),
    release: () => ({ ok: true })
  };
  const controller = createAutoReplyController({
    dataDir: autoReplyDir,
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
    deepSeekClient = { assertAvailable: () => true, reply: async () => ({ reply: "Acknowledged.", needsHuman: false }) }
  }) => ({
    dataDir,
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "Reply briefly." }) },
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
      reply: async () => { duplicateEvidenceAiCalls += 1; return { reply: "Acknowledged.", needsHuman: false }; }
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
  assert.equal(duplicateEvidenceController.status().status, "paused");
  assert.equal(duplicateEvidenceController.status().last_event, "reply_guard_duplicate_evidence_paused");
  assert.match(duplicateEvidenceController.status().last_error, /同一条客户/);
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
  assert.equal(restartedDuplicateController.status().last_event, "reply_guard_duplicate_evidence_paused");

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
  assert.equal(incompleteVerificationSends, 1, "visual { ok: true } without exact occurrence fields must not unlock the fence");
  assert.equal(incompleteVerificationController.status().last_event, "reply_guard_unverified_followup_paused");

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
  assert.equal(contactFuseSends, 3, "the same-contact visual emergency fuse must block the fourth rapid send");
  assert.equal(contactFuseController.status().status, "paused");
  assert.equal(contactFuseController.status().last_event, "same_contact_visual_rate_limit_paused");

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
    expertStore: { read: () => ({ text: "礼貌回复。" }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => { retryableAiCalls += 1; return { reply: "好的，我再试一次。", intent: false, intentReason: "", needsHuman: false, handoffReason: "" }; }
    },
    scanIncoming: () => retryableCandidate,
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      retryableSendCalls += 1;
      return retryableSendCalls === 1
        ? { ok: false, error: "generic_visual_error", blocked_reason: "atomic_draft_changed", send_attempted: false }
        : { ok: true, send_attempted: true };
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
  assert.match(retryableController.status().last_error, /atomic_draft_changed/, "the actionable visual block reason must take priority over a generic sender error");
  assert.doesNotMatch(retryableController.status().last_error, /generic_visual_error/);
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
  retryableController.pause();

  const rejectedRetryScan = () => ({ ...retryableCandidate, runtimeId: "queue-full-1", context: [{ role: "user", content: retryableCandidate.message, key: "queue-full-1" }] });
  rejectedRetryScan.requeue = () => false;
  const rejectedRetryController = createAutoReplyController({
    dataDir: path.join(root, "rejected_retry_queue"),
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "礼貌回复。" }) },
    deepSeekClient: { assertAvailable: () => true, reply: async () => ({ reply: "收到。", intent: false, intentReason: "", needsHuman: false, handoffReason: "" }) },
    scanIncoming: rejectedRetryScan,
    verifyIncoming: () => ({ ok: true }),
    send: async (options) => { assert.equal(await options.beforeDraft(), true); return { ok: false, blocked_reason: "atomic_draft_changed", send_attempted: false }; },
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

  let unknownSendCalls = 0;
  const unknownSendDataDir = path.join(root, "unknown_customer_send");
  const unknownSendController = createAutoReplyController({
    dataDir: unknownSendDataDir,
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "礼貌回复。" }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => ({ reply: "收到。", intent: false, intentReason: "", needsHuman: false, handoffReason: "" })
    },
    scanIncoming: () => ({ ...retryableCandidate, message: "结果未知不能重发", runtimeId: "unknown-send-1", context: [{ role: "user", content: "结果未知不能重发", key: "unknown-send-1" }] }),
    verifyIncoming: () => ({ ok: true }),
    send: async () => { unknownSendCalls += 1; return { ok: false, blocked_reason: "outcome_unknown", send_attempted: null }; },
    sendHandoff: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal((await unknownSendController.start()).ok, true);
  await unknownSendController.runOnce();
  assert.equal(unknownSendController.status().status, "paused");
  assert.equal(Object.values(JSON.parse(fs.readFileSync(path.join(unknownSendDataDir, "auto-reply-state.json"), "utf8")).processed).at(-1).status, "outcome_unknown");
  assert.equal((await unknownSendController.start()).ok, true);
  await unknownSendController.runOnce();
  assert.equal(unknownSendCalls, 1, "an unknown customer-send outcome must remain terminal and never auto-resend");
  unknownSendController.pause();

  const unknownVisualDir = path.join(root, "unknown_visual_occurrence_fence");
  const unknownVisualFirst = visualGuardCandidate({ message: "visual outcome is unknown", runtimeChar: "9", evidenceChar: "b" });
  let unknownVisualSends = 0;
  const unknownVisualController = createAutoReplyController(guardedControllerOptions({
    dataDir: unknownVisualDir,
    scanIncoming: () => unknownVisualFirst,
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true);
      unknownVisualSends += 1;
      return { ok: false, blocked_reason: "outcome_unknown", send_attempted: null };
    }
  }));
  assert.equal((await unknownVisualController.start()).ok, true);
  await unknownVisualController.runOnce();
  assert.equal(unknownVisualController.status().last_event, "send_outcome_unknown_paused");
  assert.equal(JSON.parse(fs.readFileSync(path.join(unknownVisualDir, "auto-reply-state.json"), "utf8")).reply_guards.c1.delivery_status, "outcome_unknown");

  const unknownVisualRewrapped = visualGuardCandidate({ message: "visual outcome is unknown", runtimeChar: "0", evidenceChar: "b" });
  const unknownVisualRestarted = createAutoReplyController(guardedControllerOptions({
    dataDir: unknownVisualDir,
    scanIncoming: () => unknownVisualRewrapped,
    send: async () => { unknownVisualSends += 1; return { ok: true }; }
  }));
  assert.equal((await unknownVisualRestarted.start()).ok, true);
  await unknownVisualRestarted.runOnce();
  assert.equal(unknownVisualSends, 1, "an outcome-unknown occurrence fence must survive restart and reject a rewrapped runtime ID");
  assert.equal(unknownVisualRestarted.status().last_event, "reply_guard_duplicate_evidence_paused");

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
    expertStore: { read: () => ({ text: "礼貌回复。" }) },
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
    expertStore: { read: () => ({ text: "礼貌回复。" }) },
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
  assert.equal(scrolledPrimeController.status().scan_health, "warning");
  assert.equal(scrolledPrimeController.status().last_scan_reason, "history_not_at_bottom");

  const unsupportedSessionPrimeController = createAutoReplyController({
    dataDir: path.join(root, "startup_session_probe_unsupported"),
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "礼貌回复。" }) },
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
    expertStore: { read: () => ({ text: "test" }) },
    deepSeekClient: { assertAvailable: () => true },
    scanIncoming: () => ({
      ok: false,
      reason: "visual_sidebar_match_ambiguous",
      pid: 81,
      hWnd: "91",
      conversation: "visual-contact-canary",
      message: "visual-message-canary",
      context: [{ role: "user", content: "visual-context-canary", key: "visual-key-canary" }]
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
  assert.doesNotMatch(visualDiagnosticLog, /visual-contact-canary|visual-message-canary|visual-context-canary|visual-key-canary/, "visual scan diagnostics must not persist contact or message content");
  visualDiagnosticController.pause();

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
    expertStore: { read: () => ({ text: "Reply briefly." }) },
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

  const pendingHealthController = createAutoReplyController({
    dataDir: path.join(root, "scan_pending_health"),
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "Reply briefly." }) },
    deepSeekClient: { assertAvailable: () => true, reply: async () => { throw new Error("AI must wait for pending visual evidence"); } },
    scanIncoming: () => ({ ok: false, reason: "unread_preview_pending", pid: 81, hWnd: "91" }),
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
  pendingHealthController.pause();

  const consumedVisualDriftController = createAutoReplyController({
    dataDir: path.join(root, "scan_consumed_visual_drift"),
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "Reply briefly." }) },
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
    expertStore: { read: () => ({ text: "Reply briefly." }) },
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
    expertStore: { read: () => ({ text: "Reply briefly." }) },
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
  assert.equal(unresolvedHealthController.status().status, "running", "an unresolved opened-unread observation must stay pending without stopping the global listener");
  assert.equal(unresolvedHealthController.status().last_event, "pending_observation_retrying");
  assert.equal(unresolvedHealthController.status().pending_retry_count, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "scan_unresolved_health", "auto-reply-state.json"), "utf8")).pending_observation.reason, "unread_preview_unresolved");

  const unresolvedCurrentTransitionController = createAutoReplyController({
    dataDir: path.join(root, "scan_current_transition_unresolved"),
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "Reply briefly." }) },
    deepSeekClient: { assertAvailable: () => true },
    scanIncoming: () => ({ ok: false, reason: "current_transition_unresolved", pid: 81, hWnd: "91" }),
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
  assert.equal(unresolvedCurrentTransitionController.status().last_event, "pending_observation_retrying");
  assert.equal(unresolvedCurrentTransitionController.status().pending_retry_count, 1);

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
    expertStore: { read: () => ({ text: "Reply briefly." }) },
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
  assert.equal(fencedRetryController.status().last_event, "pending_observation_retrying");
  assert.equal(fencedRetryAiCalls, 0);
  assert.equal(fencedRetrySendCalls, 0);

  const pendingRestartDir = path.join(root, "pending_observation_restart");
  const pendingPreviewSignature = "d".repeat(64);
  const pendingMessageSignature = "e".repeat(64);
  const pendingVisualRuntime = `visual:v1:${"f".repeat(64)}`;
  const pendingFirstScan = () => ({
    ok: false,
    reason: "current_transition_unresolved",
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
    expertStore: { read: () => ({ text: "Reply briefly." }) },
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
    expertStore: { read: () => ({ text: "Reply briefly." }) },
    deepSeekClient: { assertAvailable: () => true, reply: async () => ({ reply: "收到。", needsHuman: false }) },
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
  await pendingRestartController.runOnce();
  assert.equal(pendingRestartSends, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(pendingRestartDir, "auto-reply-state.json"), "utf8")).pending_observation, null);
  pendingRestartController.pause();

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
    expertStore: { read: () => ({ text: "Reply briefly." }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => { repeatedOccurrenceAiCalls += 1; return { reply: "只回复一次。", needsHuman: false }; }
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
    expertStore: { read: () => ({ text: "礼貌回复。" }) },
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
    expertStore: { read: () => ({ text: "礼貌回复。" }) },
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
    expertStore: { read: () => ({ text: "礼貌回复。" }) },
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

  const cachedRetryController = createAutoReplyController({
    dataDir: path.join(root, "cached_retry_without_probe"),
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "礼貌回复。" }) },
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
    expertStore: { read: () => ({ text: "礼貌回复。" }) },
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
    expertStore: { read: () => ({ text: "不得处理敏感信息。" }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async ({ context }) => {
        safeHistoryAiCalls += 1;
        assert.deepEqual(context, [{ role: "user", content: "发票怎么开？", key: "safe-latest" }]);
        return { reply: "合同和发票都可以处理，付款后我帮您跟进。", intent: false, intentReason: "", needsHuman: false, handoffReason: "" };
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
    expertStore: { read: () => ({ text: "不得索取敏感信息或要求客户直接付款。" }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => ({ reply: "请先支付定金", intent: false, intentReason: "", needsHuman: false, handoffReason: "" })
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
    expertStore: { read: () => ({ text: "不得处理敏感信息。" }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => { latestSecretAiCalls += 1; return { reply: "收到。", intent: false, intentReason: "", needsHuman: false, handoffReason: "" }; }
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

  let visualPostDraftChecks = 0;
  const visualPostDraftController = createAutoReplyController({
    dataDir: path.join(root, "visual_post_draft_reflow"),
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "Reply politely." }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => ({ reply: "Understood.", intent: false, intentReason: "", needsHuman: false, handoffReason: "" })
    },
    scanIncoming: () => ({
      ok: true,
      conversation: retryableCandidate.conversation,
      message: "Visual incoming message",
      runtimeId: "visual-post-draft-runtime",
      visualMode: "visual_render_v1",
      pid: 81,
      hWnd: "91",
      context: [{ role: "user", content: "Visual incoming message", key: "visual-user" }]
    }),
    verifyIncoming: () => ({ ok: ++visualPostDraftChecks === 1 }),
    send: async (options) => {
      assert.equal(await options.beforeDraft(), true, "visual incoming identity must still be strict before drafting");
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
  assert.equal(visualPostDraftChecks, 1, "visual incoming verification must run once before the draft is typed");
  assert.equal(visualPostDraftController.status().reply_count, 1);
  assert.equal(visualPostDraftController.status().last_event, "reply_sent_verified");
  visualPostDraftController.pause();

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

  const staleUnknownRewrapped = visualGuardCandidate({ message: staleUnknownFirst.message, runtimeChar: "b", evidenceChar: "f" });
  const staleUnknownRestarted = createAutoReplyController(guardedControllerOptions({
    dataDir: staleUnknownDir,
    scanIncoming: () => staleUnknownRewrapped,
    send: async () => { staleUnknownSendCalls += 1; return { ok: true }; }
  }));
  assert.equal((await staleUnknownRestarted.start()).ok, true);
  await staleUnknownRestarted.runOnce();
  assert.equal(staleUnknownSendCalls, 1, "a stale outcome-unknown occurrence must remain fenced after restart");
  assert.equal(staleUnknownRestarted.status().last_event, "reply_guard_duplicate_evidence_paused");

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

  let retryHandoffCalls = 0;
  let retryHandoffCustomerSends = 0;
  let retryHandoffCandidateAvailable = true;
  const retryHandoffDataDir = path.join(root, "handoff_pre_send_retry");
  const retryHandoffController = createAutoReplyController({
    dataDir: retryHandoffDataDir,
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "明确意向后提醒人工。" }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => ({ reply: "收到，我先帮您登记。", intent: true, intentReason: "客户准备下单", needsHuman: true, handoffReason: "需要正式报价" })
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
  assert.equal(retryHandoffController.status().last_event, "intent_handoff_sent");
  retryHandoffController.pause();

  const fairnessCandidates = [
    { runtimeId: "fairness-1", message: "这个需求请人工确认" },
    { runtimeId: "fairness-2", message: "另一个普通问题" }
  ];
  let fairnessCustomerSends = 0;
  let fairnessHandoffCalls = 0;
  let fairnessAiCalls = 0;
  const fairnessController = createAutoReplyController({
    dataDir: path.join(root, "handoff_retry_fairness"),
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "需要时提醒人工，其他问题直接回答。" }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => {
        fairnessAiCalls += 1;
        return fairnessAiCalls === 1
          ? { reply: "收到，我请同事确认。", intent: false, intentReason: "", needsHuman: true, handoffReason: "需要人工确认" }
          : { reply: "这个普通问题可以直接处理。", intent: false, intentReason: "", needsHuman: false, handoffReason: "" };
      }
    },
    scanIncoming: () => {
      const candidate = fairnessCandidates.shift();
      return candidate ? {
        ok: true,
        conversation: "张总",
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
    { runtimeId: "retry-error-1", message: "先提醒人工" },
    { runtimeId: "retry-error-2", message: "随后触发另一个错误" }
  ];
  let retryThenErrorAiCalls = 0;
  let retryThenErrorHandoffCalls = 0;
  let retryThenErrorCustomerSends = 0;
  const retryThenErrorDir = path.join(root, "handoff_retry_then_other_error");
  const retryThenErrorController = createAutoReplyController({
    dataDir: retryThenErrorDir,
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "需要时提醒人工。" }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => {
        retryThenErrorAiCalls += 1;
        if (retryThenErrorAiCalls > 1) throw new Error("另一个客户生成失败");
        return { reply: "收到，我请同事确认。", intent: false, intentReason: "", needsHuman: true, handoffReason: "需要人工确认" };
      }
    },
    scanIncoming: () => {
      const candidate = retryThenErrorCandidates.shift();
      return candidate ? {
        ok: true,
        conversation: "张总",
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
  assert.equal(retryThenErrorController.status().last_event, "auto_reply_error_paused", "an unrelated failure must not relabel a proven-unsent handoff as outcome unknown");
  assert.ok(JSON.parse(fs.readFileSync(path.join(retryThenErrorDir, "auto-reply-state.json"), "utf8")).pending_handoff);
  assert.equal((await retryThenErrorController.start()).ok, true);
  await retryThenErrorController.runOnce();
  assert.equal(retryThenErrorHandoffCalls, 2, "the proven-unsent handoff must survive restart and retry instead of being acknowledged away");
  assert.equal(retryThenErrorCustomerSends, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(retryThenErrorDir, "auto-reply-state.json"), "utf8")).pending_handoff, null);
  retryThenErrorController.pause();

  const restartQueueDir = path.join(root, "handoff_queue_restart");
  const restartQueueCandidates = ["restart-handoff-1", "restart-handoff-2"];
  const deliveredRestartHandoffs = [];
  let deliverRestartHandoffs = false;
  let restartQueueCustomerSends = 0;
  const restartQueueController = createAutoReplyController({
    dataDir: restartQueueDir,
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "都需要人工提醒。" }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async ({ context }) => ({
        reply: "收到，我请同事确认。",
        intent: false,
        intentReason: "",
        needsHuman: !context.at(-1).content.startsWith("fresh-after-backlog"),
        handoffReason: "需要人工确认"
      })
    },
    scanIncoming: () => {
      const runtimeId = restartQueueCandidates.shift();
      return runtimeId ? { ok: true, conversation: "张总", message: runtimeId, runtimeId, pid: 81, hWnd: "91", context: [{ role: "user", content: runtimeId, key: runtimeId }] } : { ok: false, reason: "no_unread_message" };
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
  restartQueueCandidates.push("fresh-after-backlog-1", "fresh-after-backlog-2");
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
    expertStore: { read: () => ({ text: "有效话术" }) },
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
  assert.equal((await restoredQueueController.start()).ok, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(restartQueueDir, "auto-reply-state.json"), "utf8")).pending_handoffs.length, 2, "a failed start must not discard known-unsent handoff identities");
  restoredQueuePrimeOk = true;
  const restoredQueueStart = await restoredQueueController.start();
  assert.equal(restoredQueueStart.ok, true, "known-unsent handoffs must not block automatic replies after restart");
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
        aiWarningCode: "API_KEY_INVALID",
        aiWarning: "DeepSeek 本次未生成可靠回复，已发送兜底消息并提醒人工。",
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
  assert.equal(aiConfigFailureController.status().last_ai_warning_code, "API_KEY_INVALID");
  assert.match(aiConfigFailureController.status().last_ai_warning, /已发送兜底消息并提醒人工/);

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
  const autoReplyUpdates = [];
  const webContents = { send: (channel, payload) => autoReplyUpdates.push({ channel, payload }) };
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
  assert.deepEqual([...handlers.keys()].sort(), ["auto-reply:acknowledge-manual-followup", "auto-reply:pause", "auto-reply:start", "auto-reply:status"]);
  assert.equal((await handlers.get("auto-reply:start")({ sender: webContents }, {})).ok, false);
  assert.equal((await handlers.get("auto-reply:start")({ sender: webContents }, { clickToken: "trusted" })).ok, true);
  assert.equal(autoReplyUpdates.at(-1).channel, "auto-reply:update");
  assert.equal(autoReplyUpdates.at(-1).payload.state.status, "running", "successful start must push authoritative state without waiting for renderer polling");
  assert.equal((await handlers.get("auto-reply:acknowledge-manual-followup")({ sender: webContents }, {})).ok, false);
  assert.equal((await handlers.get("auto-reply:acknowledge-manual-followup")({ sender: webContents }, { clickToken: "trusted-ack" })).ok, true);
  await handlers.get("auto-reply:pause")({ sender: webContents }, {});
  assert.equal(autoReplyUpdates.at(-1).payload.state.status, "paused", "pause must push state immediately");
  assert.match(fs.readFileSync(path.join(__dirname, "preload-api.cjs"), "utf8"), /auto-reply:update[\s\S]*removeListener/u, "preload must expose a removable auto-reply state subscription");

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
  assert.equal(recovered.status().scan_health, "unknown");
  assert.equal(recovered.status().last_scan_at, "");
  assert.equal(recovered.status().last_scan_success_at, "");
  assert.equal(recovered.status().last_scan_reason, "");
  assert.equal(recovered.status().consecutive_scan_failures, 0);
  assert.deepEqual(Object.keys(recovered.status()).sort(), [
    "consecutive_scan_failures",
    "last_error",
    "last_event",
    "last_ai_warning",
    "last_ai_warning_code",
    "last_scan_at",
    "last_scan_reason",
    "last_scan_success_at",
    "pending_retry_count",
    "reply_count",
    "scan_health",
    "status",
    "updated_at"
  ].sort(), "public v2 state must expose only the documented control and scan-health fields");

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
      version: 2,
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
    version: 2,
    status: "paused",
    daily_date: "2026-07-14",
    processed: {
      interrupted: { status: "sending", contact_id: "c1", at: "2026-07-14T02:00:00.000Z" },
      verified: { status: "sent_verified", contact_id: "c2", at: "2026-07-14T01:00:00.000Z" }
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
  assert.equal(interruptedSendState.processed.verified.status, "sent_verified", "restart recovery must not rewrite completed sends");
  assert.equal(interruptedSendState.reply_guards.c1.delivery_status, "outcome_unknown", "an interrupted send must recover a persistent occurrence fence");
  assert.equal(interruptedSendState.reply_guards.c1.turn_state, "awaiting_outgoing_observation");
  assert.equal(interruptedSendState.reply_guards.c2, undefined, "an unrelated historical sent_verified entry without occurrence evidence must not migrate into a blocking contact fence");

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
  assert.equal(JSON.parse(fs.readFileSync(path.join(legacyRawGuardDir, "auto-reply-state.json"), "utf8")).reply_guards.c2.turn_state, "outgoing_observed", "legacy verified guards must migrate out of the old awaiting state");

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

  let discoveredSend = null;
  const discoveredController = createAutoReplyController({
    dataDir: path.join(root, "discovered_alias"),
    activeTouchDir,
    coordinator,
    expertStore: { read: () => ({ text: "Reply briefly." }) },
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async () => ({ reply: "Received.", intent: false, intentReason: "", needsHuman: false, handoffReason: "" })
    },
    scanIncoming: () => ({
      ok: true,
      conversation: "Remote Alias",
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
  assert.equal(discoveredSend?.expectedConversation, "Remote Alias", "auto reply must use the actual rendered WeChat alias even when it is absent from contacts.json");
  assert.equal(discoveredController.status().reply_count, 1);
  discoveredController.pause();
  console.log("auto-reply v2 self-check passed");
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
