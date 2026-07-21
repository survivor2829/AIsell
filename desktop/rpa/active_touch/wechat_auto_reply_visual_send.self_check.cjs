const assert = require("node:assert/strict");
const {
  WECHAT_VISUAL_AUTO_REPLY_POWERSHELL,
  createVisualAutoReplySender
} = require("./wechat_auto_reply_visual_send.dev.cjs");

assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /GetWindowThreadProcessId[\s\S]*MainWindowHandle[\s\S]*-cne "微信"/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /Get-MomentsRenderPaneEvidence/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /Test-VisualSendConversation[\s\S]*Normalize-VisualSendText/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Test-VisualSendIncoming[\s\S]*height = \[double\]\(\$frame\.height \* 0\.69\)/u, "incoming verification must include messages immediately above the composer");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Test-VisualSendLatestIncoming[\s\S]*Get-MomentsOcrObservation \$frame @\{ left = 0\.0; top = 0\.0; width = \[double\]\$frame\.width; height = \[double\]\$frame\.height \}/u, "the final incoming guard must reuse full-frame OCR geometry");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /\$guard = Get-VisualSendFrame[\s\S]*Test-VisualSendLatestIncoming \$guard[\s\S]*visual_send_incoming_changed[\s\S]*\$sendAttempted = \$true/u, "the latest incoming line must be rechecked immediately before the click");
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /Read-VisualSendDraft[\s\S]*\^a[\s\S]*\^c/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /Read-VisualSendDraft[\s\S]*Test-VisualSendOwnedPoint/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /Normalize-VisualSendDraftText[\s\S]*-ceq \(Normalize-VisualSendDraftText \$expectedReply\)/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Write-VisualSendDraft[\s\S]*\^v[\s\S]*Read-VisualSendDraft/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Find-VisualSendButton[\s\S]*ocr_send_label/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /function Find-VisualSendGreenComponents[\s\S]*green_component/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /greenRatio -ge 0\.35[\s\S]*componentRight -ge \(\$frame\.width \* 0\.91\)[\s\S]*components\.Count -ne 1/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /WindowFromPoint[\s\S]*GetAncestor/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /\$sendAttempted = \$true[\s\S]*mouse_event\(0x0002[\s\S]*mouse_event\(0x0004/u);
assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, /draft_consumed_same_header/u);

const calls = [];
const sender = createVisualAutoReplySender({
  powerShellRunner: async (_script, env, options) => {
    calls.push({ kind: "powershell", env, options });
    if (env.XIAOXI_VISUAL_SEND_PHASE === "preflight") {
      return { ok: true, conversationVerified: true, incomingVerified: true, sendAttempted: false, pid: 77, hWnd: 88 };
    }
    return {
      ok: true,
      sendAttempted: true,
      conversationVerified: true,
      draftVerified: true,
      verificationMode: "draft_consumed_same_header",
      pid: 77,
      hWnd: 88
    };
  },
  draftInput: async (message, context) => {
    calls.push({ kind: "draft", message, context });
    return { ok: true, draftVerified: true };
  }
});

(async () => {
  let beforeSendCalled = false;
  const result = await sender({
    pid: 77,
    hWnd: 88,
    conversation: "A测试客户",
    incomingMessage: "你是谁",
    reply: "你好，这是本机视觉发送自检",
    beforeSend: async (context) => {
      beforeSendCalled = true;
      assert.equal(context.conversation, "A测试客户");
      return true;
    }
  });
  assert.deepEqual(result, {
    ok: true,
    send_attempted: true,
    conversationVerified: true,
    draftVerified: true,
    verificationMode: "draft_consumed_same_header",
    pid: 77,
    hWnd: 88
  });
  assert.equal(beforeSendCalled, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].env.XIAOXI_VISUAL_SEND_PHASE, "preflight");
  assert.equal(calls[0].env.XIAOXI_VISUAL_SEND_CONVERSATION, "A测试客户");
  assert.equal(calls[0].env.XIAOXI_VISUAL_SEND_INCOMING, "你是谁");
  assert.equal(calls[0].options.sta, true);
  assert.deepEqual(calls[1], { kind: "draft", message: "你好，这是本机视觉发送自检", context: { pid: 77, hWnd: 88 } });
  assert.equal(calls[2].env.XIAOXI_VISUAL_SEND_PHASE, "send");

  const trustedIncomingEnvironments = [];
  const trustedIncoming = await createVisualAutoReplySender({
    powerShellRunner: async (_script, env) => {
      trustedIncomingEnvironments.push(env);
      if (env.XIAOXI_VISUAL_SEND_PHASE === "preflight") {
        return { ok: true, conversationVerified: true, sendAttempted: false, incomingVerified: false };
      }
      return { ok: true, sendAttempted: true, conversationVerified: true, draftVerified: true, verificationMode: "draft_consumed_same_header" };
    },
    draftInput: async () => ({ ok: true, draftVerified: true })
  })({
    pid: 77,
    hWnd: 88,
    conversation: "A测试客户",
    incomingMessage: "扫描阶段已经严格确认的消息",
    incomingVerified: true,
    reply: "继续完成发送"
  });
  assert.equal(trustedIncoming.ok, true, "a strict controller verification must not be contradicted by a second whole-pane OCR crop");
  assert.equal(trustedIncomingEnvironments[0].XIAOXI_VISUAL_SEND_INCOMING, "扫描阶段已经严格确认的消息");
  assert.equal(trustedIncomingEnvironments[0].XIAOXI_VISUAL_SEND_INCOMING_VERIFIED, "true");
  assert.equal(trustedIncomingEnvironments.at(-1).XIAOXI_VISUAL_SEND_INCOMING, "扫描阶段已经严格确认的消息", "the send phase must retain the expected incoming text for its final guard");

  let sendRunnerCalls = 0;
  const cancelled = await createVisualAutoReplySender({
    powerShellRunner: async () => {
      sendRunnerCalls += 1;
      return { ok: true, conversationVerified: true };
    },
    draftInput: async () => ({ ok: true, draftVerified: true })
  })({ pid: 1, hWnd: 2, conversation: "A测试客户", reply: "不会发送", beforeSend: () => false });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.send_attempted, false);
  assert.equal(cancelled.reason, "visual_send_cancelled");
  assert.equal(sendRunnerCalls, 1);

  let unknownCalls = 0;
  const unknown = await createVisualAutoReplySender({
    powerShellRunner: async (_script, env) => {
      unknownCalls += 1;
      return env.XIAOXI_VISUAL_SEND_PHASE === "preflight"
        ? { ok: true, sendAttempted: false, conversationVerified: true }
        : { ok: false, reason: "powershell_timeout" };
    },
    draftInput: async () => ({ ok: true, draftVerified: true })
  })({ pid: 3, hWnd: 4, conversation: "A测试客户", reply: "只尝试一次" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.send_attempted, true);
  assert.equal(unknown.outcomeUnknown, true);
  assert.equal(unknownCalls, 2);

  const visualPhases = [];
  const visualDraft = await createVisualAutoReplySender({
    powerShellRunner: async (_script, env) => {
      visualPhases.push(env.XIAOXI_VISUAL_SEND_PHASE);
      if (env.XIAOXI_VISUAL_SEND_PHASE === "preflight") {
        return { ok: true, sendAttempted: false, conversationVerified: true };
      }
      if (env.XIAOXI_VISUAL_SEND_PHASE === "draft") {
        return { ok: true, sendAttempted: false, conversationVerified: true, draftVerified: true };
      }
      return { ok: true, sendAttempted: true, conversationVerified: true, draftVerified: true, verificationMode: "draft_consumed_same_header" };
    }
  })({ pid: 5, hWnd: 6, conversation: "A测试客户", reply: "视觉同 DPI 输入" });
  assert.equal(visualDraft.ok, true);
  assert.deepEqual(visualPhases, ["preflight", "draft", "send"]);

  let mismatchDraftCalls = 0;
  const mismatch = await createVisualAutoReplySender({
    powerShellRunner: async () => ({ ok: true, sendAttempted: false, conversationVerified: true, incomingVerified: false }),
    draftInput: async () => {
      mismatchDraftCalls += 1;
      return { ok: true, draftVerified: true };
    }
  })({ pid: 7, hWnd: 8, conversation: "A测试客户", incomingMessage: "本条必须仍可见", reply: "不应输入" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "visual_send_incoming_not_verified");
  assert.equal(mismatchDraftCalls, 0);

  const invalid = await sender({ pid: 0, hWnd: 2, conversation: "", reply: "x" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.send_attempted, false);
  assert.equal(invalid.reason, "visual_send_context_invalid");

  console.log("wechat auto-reply visual send self-check passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
