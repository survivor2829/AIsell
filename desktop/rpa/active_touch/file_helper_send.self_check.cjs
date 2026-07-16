const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { executeVerifiedFileHelperSend } = require("./state_machine.dev.cjs");

function drivers(overrides = {}) {
  const calls = [];
  return {
    calls,
    options: {
      authorized: true,
      message: "【需人工跟进】\n客户：张总\n请人工跟进",
      expectedPid: 81,
      sourceWindowHandle: "91",
      openConversation: (name, context) => { calls.push(["open", name, context]); return { ok: true, pid: 81, hWnd: "91", processName: "Weixin" }; },
      verifyConversation: (name, context) => { calls.push(["verify", name, context]); return { ok: true, title: name, pid: 81, hWnd: "91", processName: "Weixin" }; },
      inputDraft: (message, context) => { calls.push(["draft", message, context]); return { ok: true, draftVerified: true, draftPoint: { xRatio: 0.75, yRatio: 0.82 } }; },
      bubbleVerifier: (_message, context) => context.phase === "before"
        ? { ok: true, snapshot: { lastMessageId: "before" }, draftExact: true }
        : { ok: true, messageText: "【需人工跟进】\n客户：张总\n请人工跟进", exactMatch: true, outgoing: true, isLatest: true, isNew: true },
      sendDriver: (_key, context) => { calls.push(["send", context]); return { ok: true, conversationVerified: true, draftVerified: true, sendAttempted: true }; },
      ...overrides
    }
  };
}

async function main() {
  const windowDriverSource = fs.readFileSync(path.join(__dirname, "wechat_window_driver.dev.cjs"), "utf8");
  assert.equal(windowDriverSource.includes("function Normalize-WechatProofText"), true, "message proof must normalize multiline WeChat text");
  assert.equal(windowDriverSource.includes("(Normalize-WechatProofText $draftBefore.text) -ceq $normalizedMessage"), true, "draft-consumed proof must ignore CRLF and trailing U+FFFC differences");

  assert.equal((await executeVerifiedFileHelperSend({})).blocked_reason, "handoff_authorization_missing");

  const success = drivers();
  const result = await executeVerifiedFileHelperSend(success.options);
  assert.equal(result.ok, true);
  assert.deepEqual(success.calls[0], ["open", "文件传输助手", {
    pid: 81,
    hWnd: "91",
    resultAutomationId: "search_item_function_文件传输助手"
  }], "handoff lookup must open the exact local function result instead of the web-search default");
  assert.deepEqual(success.calls.map(([name]) => name), ["open", "verify", "draft", "verify", "send"], "handoff must reverify the bound conversation immediately before its single send click");
  const verifications = success.calls.filter(([name]) => name === "verify");
  assert.equal(verifications.length, 2);
  assert.equal(verifications.every((call) => call.at(1) === "文件传输助手" && call.at(2)?.pid === 81 && call.at(2)?.hWnd === "91"), true);
  assert.deepEqual(success.calls.find(([name]) => name === "draft").at(2), { pid: 81, hWnd: "91" });
  assert.equal(success.calls.find(([name]) => name === "send").at(1).expectedConversation, "文件传输助手");
  assert.equal(success.calls.find(([name]) => name === "send").at(1).expectedMessage, success.options.message);
  assert.equal(success.calls.filter(([name]) => name === "send").length, 1);

  const normalizedProof = drivers({
    bubbleVerifier: (_message, context) => context.phase === "before"
      ? { ok: true, snapshot: { draftExact: true } }
      : { ok: true, messageText: "【需人工跟进】\r\n客户：张总\r\n请人工跟进\uFFFC", exactMatch: true, outgoing: true, isLatest: true, isNew: true }
  });
  assert.equal((await executeVerifiedFileHelperSend(normalizedProof.options)).ok, true, "CRLF and trailing U+FFFC must still verify as the same sent message");

  const wrongWindow = drivers({ openConversation: () => ({ ok: true, pid: 82, hWnd: "92", processName: "Weixin" }) });
  const wrongWindowResult = await executeVerifiedFileHelperSend(wrongWindow.options);
  assert.equal(wrongWindowResult.blocked_reason, "handoff_source_window_changed");
  assert.equal(wrongWindowResult.binding_valid, false);
  assert.equal(wrongWindowResult.send_attempted, false);
  assert.equal(wrongWindow.calls.some(([name]) => name === "send"), false);

  const temporarySearchFailure = drivers({
    openConversation: () => ({ ok: false, reason: "search_result_not_found", pid: 81, hWnd: "91", processName: "Weixin" })
  });
  const temporarySearchResult = await executeVerifiedFileHelperSend(temporarySearchFailure.options);
  assert.equal(temporarySearchResult.blocked_reason, "handoff_conversation_open_failed");
  assert.equal(temporarySearchResult.binding_valid, true, "a temporary search failure must not be mislabeled as a changed WeChat window");
  assert.equal(temporarySearchResult.send_attempted, false);

  const unknownSearchBinding = drivers({
    openConversation: () => ({ ok: false, reason: "uia_unavailable" })
  });
  const unknownSearchResult = await executeVerifiedFileHelperSend(unknownSearchBinding.options);
  assert.equal(unknownSearchResult.binding_valid, undefined, "missing UIA identity is retryable before any send click, not proof that the window changed");
  assert.equal(unknownSearchResult.send_attempted, false);

  const changedDraft = drivers({
    sendDriver: () => ({ ok: false, reason: "atomic_draft_changed", conversationVerified: true, draftVerified: false, sendAttempted: false })
  });
  const changedDraftResult = await executeVerifiedFileHelperSend(changedDraft.options);
  assert.equal(changedDraftResult.blocked_reason, "atomic_draft_changed", "a draft changed before the click is safe to retry");
  assert.equal(changedDraftResult.send_attempted, false);

  let clickCount = 0;
  const unknown = drivers({
    sendDriver: () => { clickCount += 1; return { ok: true, conversationVerified: true, draftVerified: true, sendAttempted: true }; },
    bubbleVerifier: (_message, context) => context.phase === "before"
      ? { ok: true, snapshot: { lastMessageId: "before" }, draftExact: true }
      : { ok: false, reason: "not_verified" }
  });
  const unknownResult = await executeVerifiedFileHelperSend(unknown.options);
  assert.equal(unknownResult.blocked_reason, "handoff_outcome_unknown");
  assert.equal(unknownResult.send_attempted, true);
  assert.equal(clickCount, 1, "handoff send must never retry blindly");

  const missingAttemptMetadata = drivers({
    sendDriver: () => ({ ok: false, reason: "powershell_timeout" })
  });
  const missingAttemptResult = await executeVerifiedFileHelperSend(missingAttemptMetadata.options);
  assert.equal(missingAttemptResult.blocked_reason, "handoff_outcome_unknown");
  assert.equal(missingAttemptResult.send_attempted, null);

  let thrownCalls = 0;
  const thrownDriver = drivers({
    sendDriver: () => { thrownCalls += 1; throw new Error("driver crashed"); }
  });
  const thrownResult = await executeVerifiedFileHelperSend(thrownDriver.options);
  assert.equal(thrownResult.blocked_reason, "handoff_outcome_unknown");
  assert.equal(thrownResult.send_attempted, null);
  assert.equal(thrownCalls, 1, "a throwing handoff driver must never be retried blindly");
  console.log("file-helper send self-check passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
