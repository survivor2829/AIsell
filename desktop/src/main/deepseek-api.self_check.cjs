const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEEPSEEK_MODEL, createDeepSeekClient, createDeepSeekKeyStore, maskApiKey, parsePlainPayload, parseReplyDecision, prompt, replyPrompt } = require("./deepseek-api.cjs");
const { errorCategory } = require("./deepseek-api-ipc.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-deepseek-"));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`encrypted:${value}`), decryptString: (value) => value.toString().replace(/^encrypted:/, "") };

async function main() {
  const store = createDeepSeekKeyStore({ rootDir: root, safeStorage });
  assert.deepEqual(store.status(), { configured: false, maskedKey: "" });
  store.write("test-customer-key");
  assert.equal(store.read(), "test-customer-key");
  assert.equal(store.status().maskedKey, maskApiKey("test-customer-key"));
  assert.equal(maskApiKey("sk-a"), "****");
  assert.equal(errorCategory("API_KEY_INVALID"), "configuration");
  assert.equal(errorCategory("AI_RATE_LIMITED"), "rate_limit");
  assert.equal(errorCategory("AI_RESPONSE_EMPTY"), "empty_content");
  assert.equal(errorCategory("AI_RESPONSE_INVALID"), "parse_error");
  assert.equal(errorCategory("AI_RESPONSE_LENGTH_INVALID"), "unusable_content");
  const unreadableRoot = path.join(root, "foreign-windows-user");
  fs.mkdirSync(unreadableRoot, { recursive: true });
  const unreadableKeyFile = path.join(unreadableRoot, "deepseek-api-key.bin");
  fs.writeFileSync(unreadableKeyFile, "encrypted-on-another-computer", "utf8");
  const unreadableStore = createDeepSeekKeyStore({
    rootDir: unreadableRoot,
    safeStorage: {
      isEncryptionAvailable: () => true,
      decryptString: () => { throw new Error("different DPAPI user"); }
    }
  });
  assert.deepEqual(unreadableStore.status(), {
    configured: false,
    maskedKey: "",
    code: "API_KEY_UNREADABLE",
    error: "已保存的 DeepSeek API Key 无法在当前 Windows 用户下解密，请重新填写。"
  });
  assert.throws(() => unreadableStore.read(), (error) => error.code === "API_KEY_UNREADABLE");
  assert.equal(fs.existsSync(unreadableKeyFile), true, "a key encrypted for another Windows user must not be deleted automatically");
  const messages = prompt({ salutation: "张总", script: "{称呼}，您好，我们这边有清洁设备短租方案。" });
  assert.match(messages[0].content, /完整微信消息/);
  assert.match(messages[0].content, /50至90个汉字/);
  assert.match(messages[0].content, /自然加入2至3个/);
  assert.match(messages[0].content, /最少2个/);
  assert.match(messages[0].content, /不得连续堆叠/);
  assert.equal(messages[1].content, "客户称呼：张总，您好\n基础话术：张总，您好，我们这边有清洁设备短租方案。");
  assert.equal(prompt({ salutation: "", script: "{称呼}，您好，欢迎了解。" })[1].content, "客户称呼：您好\n基础话术：您好，欢迎了解。");
  const replyPolicy = replyPrompt({
    expert: "意向判定：客户初步询价属于意向，但先继续判断需求。",
    context: [{ role: "user", content: "工厂一千平，粉尘多。" }]
  })[0].content;
  assert.match(replyPolicy, /intent与needsHuman分别判断/);
  assert.doesNotMatch(replyPolicy, /有意向时intent和needsHuman都为true/);
  assert.match(replyPolicy, /可以通过一个关键问题继续判断时.*needsHuman为false/);
  assert.match(replyPolicy, /明确要求实时报价、下单、实时库存或必须人工承诺时.*needsHuman为true/);
  const requests = [];
  const client = createDeepSeekClient({ keyStore: store, fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body);
    requests.push(body);
    assert.equal(body.model, DEEPSEEK_MODEL);
    assert.match(request.headers.authorization, /^Bearer /);
    const isReply = body.messages[0].content.includes("微信一对一客服回复助手");
    const content = isReply
      ? JSON.stringify({ reply: "收到，我把正式报价需求交给同事核实。", intent: true, intentReason: "客户准备下单", needsHuman: true, handoffReason: "需要正式报价" })
      : "您好，欢迎了解我们的服务。";
    return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content } }] }) };
  } });
  const requestsBeforeCapabilityTest = requests.length;
  const capabilityResult = await client.test("test-customer-key");
  assert.deepEqual(capabilityResult, {
    provider: "deepseek",
    model: DEEPSEEK_MODEL,
    capabilities: {
      activeTouch: { ok: true, outputLength: 13 },
      autoReply: { ok: true, outputLength: 18 }
    }
  });
  const capabilityRequests = requests.slice(requestsBeforeCapabilityTest);
  assert.equal(capabilityRequests.length, 2, "connection tests must validate both production output modes");
  assert.equal(capabilityRequests[0].max_tokens, 300);
  assert.equal(capabilityRequests[0].response_format, undefined, "connection tests must validate active-touch plain text output");
  assert.deepEqual(capabilityRequests[0].thinking, { type: "disabled" });
  assert.equal(capabilityRequests[1].max_tokens, 300);
  assert.deepEqual(capabilityRequests[1].response_format, { type: "json_object" }, "connection tests must validate auto-reply structured output");
  assert.deepEqual(capabilityRequests[1].thinking, { type: "disabled" }, "connection tests must not accept reasoning-only HTTP 200 responses");
  assert.equal((await client.draft({ task: { script: "欢迎咨询" }, result: { request_id: "request", salutation: { type: "person", value: "张总" } } })).draft, "您好，欢迎了解我们的服务。");
  assert.equal(requests.at(-1).response_format, undefined, "plain-text draft must not enable JSON mode");
  assert.deepEqual(requests.at(-1).thinking, { type: "disabled" }, "plain-text draft must not spend its completion budget on hidden reasoning");
  assert.equal(requests.at(-1).max_tokens, 300);
  const requestsBeforeReply = requests.length;
  const decision = await client.reply({
    expert: "业务信息：设备短租。人工提醒：明确要求正式报价或下单时提醒人工。",
    context: [
      { role: "assistant", content: "您好，想了解哪方面？" },
      { role: "user", content: "请给我正式报价，我准备下单。" }
    ]
  });
  assert.deepEqual(decision, {
    reply: "收到，我把正式报价需求交给同事核实。",
    intent: true,
    intentReason: "客户准备下单",
    needsHuman: true,
    handoffReason: "需要正式报价"
  });
  assert.deepEqual(requests.at(-1).response_format, { type: "json_object" }, "auto-reply must use DeepSeek JSON mode");
  assert.deepEqual(requests.at(-1).thinking, { type: "disabled" }, "structured auto-reply must disable thinking mode");
  assert.equal(requests.length, requestsBeforeReply + 1, "a valid structured response must not trigger a retry");
  assert.deepEqual(parseReplyDecision("```json\n{\"reply\":\"稍等，我帮您确认。\",\"intent\":false,\"intentReason\":\"\",\"needsHuman\":true,\"handoffReason\":\"资料未覆盖\"}\n```"), {
    reply: "稍等，我帮您确认。",
    intent: false,
    intentReason: "",
    needsHuman: true,
    handoffReason: "资料未覆盖"
  });
  assert.throws(() => parseReplyDecision("not-json"), (error) => error.code === "AI_RESPONSE_INVALID");
  assert.throws(() => parseReplyDecision(JSON.stringify({ reply: "收到", intent: false })), (error) => error.code === "AI_RESPONSE_INVALID");
  assert.throws(() => parseReplyDecision(JSON.stringify({ reply: "收到", intent: "false", intentReason: "", needsHuman: false, handoffReason: "" })), (error) => error.code === "AI_RESPONSE_INVALID");
  assert.throws(() => parseReplyDecision(JSON.stringify({ reply: "   ", intent: false, intentReason: "", needsHuman: false, handoffReason: "" })), (error) => error.code === "AI_RESPONSE_INVALID");
  assert.equal(parsePlainPayload({ choices: [{ finish_reason: "stop", message: { content: "连接正常" } }] }, "missing"), "连接正常");
  assert.throws(() => parsePlainPayload({ choices: [{ finish_reason: "stop", message: { content: "" } }] }, "missing"), (error) => error.code === "AI_RESPONSE_EMPTY");
  assert.throws(() => parsePlainPayload({}, "missing"), (error) => error.code === "AI_RESPONSE_INVALID", "a malformed provider envelope must not be reported as empty content");
  assert.throws(() => parsePlainPayload({ choices: [{ finish_reason: "stop", message: { content: null } }] }, "missing"), (error) => error.code === "AI_RESPONSE_EMPTY", "an explicit null completion is empty content");
  assert.throws(() => parsePlainPayload({ choices: [{ finish_reason: "stop", message: { content: "长".repeat(261) } }] }, "missing"), (error) => error.code === "AI_RESPONSE_LENGTH_INVALID");
  assert.throws(() => parseReplyDecision(JSON.stringify({ reply: "长".repeat(261), intent: false, intentReason: "", needsHuman: false, handoffReason: "" })), (error) => error.code === "AI_RESPONSE_LENGTH_INVALID");
  assert.throws(() => parsePlainPayload({ choices: [{ finish_reason: "length", message: { content: "未完成" } }] }, "missing"), (error) => error.code === "AI_RESPONSE_TRUNCATED");
  assert.equal(parseReplyDecision(JSON.stringify({ reply: "收到", intent: true, intentReason: "有意向", needsHuman: false, handoffReason: "" })).needsHuman, false, "interest alone must not force a human handoff");
  assert.equal(JSON.stringify(requests.at(-1)).includes("张总"), false, "auto-reply request must not include the contact name");
  assert.equal(JSON.stringify(requests.at(-1)).includes("设备短租"), true);
  assert.equal(JSON.stringify(requests.at(-1)).includes("请给我正式报价"), true);
  const retryInput = {
    expert: "业务信息：工业清洁设备。",
    context: [{ role: "user", content: "工厂粉尘多，想了解高压清洗机。" }]
  };
  const draftRetryBodies = [];
  const draftRetryPayloads = [
    { choices: [{ finish_reason: "length", message: { content: "" } }] },
    { choices: [{ finish_reason: "stop", message: { content: "您好，这是恢复后的完整测试文案。" } }] }
  ];
  const draftRetryClient = createDeepSeekClient({ keyStore: store, fetchImpl: async (_url, request) => {
    draftRetryBodies.push(JSON.parse(request.body));
    return { ok: true, json: async () => draftRetryPayloads.shift() };
  } });
  assert.equal((await draftRetryClient.draft({ task: { script: "测试服务" }, result: { salutation: { type: "generic", value: "" } } })).draft, "您好，这是恢复后的完整测试文案。");
  assert.deepEqual(draftRetryBodies.map((body) => body.max_tokens), [300, 600]);
  assert.equal(draftRetryBodies.every((body) => body.thinking?.type === "disabled"), true);
  const validRetryContent = JSON.stringify({ reply: "粉尘主要在开阔地面，还是设备周边和边角？", intent: true, intentReason: "客户正在选型", needsHuman: false, handoffReason: "" });
  const emptyRetryBodies = [];
  const emptyRetryPayloads = [
    { id: "req-empty-json", choices: [{ finish_reason: "stop", message: { content: "" } }] },
    { id: "req-plain-recovery", choices: [{ finish_reason: "stop", message: { content: validRetryContent } }] }
  ];
  const emptyRetryClient = createDeepSeekClient({ keyStore: store, fetchImpl: async (_url, request) => {
    emptyRetryBodies.push(JSON.parse(request.body));
    return { ok: true, json: async () => emptyRetryPayloads.shift() };
  } });
  assert.equal((await emptyRetryClient.reply(retryInput)).reply, "粉尘主要在开阔地面，还是设备周边和边角？");
  assert.equal(emptyRetryBodies.length, 2, "an empty structured response must retry exactly once before sending");
  assert.equal(emptyRetryBodies[0].max_tokens, 300);
  assert.equal(emptyRetryBodies[1].max_tokens, 600, "the retry must allow a complete JSON response");
  assert.deepEqual(emptyRetryBodies[0].response_format, { type: "json_object" });
  assert.deepEqual(emptyRetryBodies[1].response_format, { type: "json_object" }, "the single recovery must keep the structured output contract");
  assert.deepEqual(emptyRetryBodies[1].thinking, { type: "disabled" }, "structured recovery must remain in non-thinking mode");
  assert.match(emptyRetryBodies[1].messages[0].content, /结构化恢复请求/, "the plain retry must strengthen the JSON instruction");
  let truncatedCalls = 0;
  const truncatedRetryClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => ({
    ok: true,
    json: async () => (++truncatedCalls === 1
      ? { choices: [{ finish_reason: "length", message: { content: "{\"reply\":\"已截断" } }] }
      : { choices: [{ finish_reason: "stop", message: { content: validRetryContent } }] })
  }) });
  assert.equal((await truncatedRetryClient.reply(retryInput)).needsHuman, false);
  assert.equal(truncatedCalls, 2, "a truncated structured response must retry exactly once");
  let invalidCalls = 0;
  const invalidRetryClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => ({
    ok: true,
    json: async () => (++invalidCalls === 1
      ? { choices: [{ finish_reason: "stop", message: { content: "not-json" } }] }
      : { choices: [{ finish_reason: "stop", message: { content: validRetryContent } }] })
  }) });
  assert.equal((await invalidRetryClient.reply(retryInput)).intent, true);
  assert.equal(invalidCalls, 2, "invalid JSON must retry exactly once");
  let recoveredCalls = 0;
  const finalRecoveryBodies = [];
  const finalRecoveryClient = createDeepSeekClient({ keyStore: store, fetchImpl: async (_url, request) => {
    finalRecoveryBodies.push(JSON.parse(request.body));
    return {
      ok: true,
      json: async () => {
        recoveredCalls += 1;
        if (recoveredCalls === 1) return { choices: [{ finish_reason: "stop", message: { content: "" } }] };
        if (recoveredCalls === 2) return { choices: [{ finish_reason: "stop", message: { content: "收到，我先了解一下您的使用面积。" } }] };
        return { choices: [{ finish_reason: "stop", message: { content: validRetryContent } }] };
      }
    };
  } });
  assert.equal((await finalRecoveryClient.reply(retryInput)).needsHuman, true, "two failed structured attempts must use the bounded fallback");
  assert.equal(recoveredCalls, 2, "reply generation must never exceed one recovery call");
  assert.deepEqual(finalRecoveryBodies.map((body) => [body.max_tokens, body.response_format?.type || "plain"]), [
    [300, "json_object"],
    [600, "json_object"]
  ], "the recovery must keep JSON mode and use the larger completion budget");
  assert.equal(finalRecoveryBodies.every((body) => body.thinking?.type === "disabled"), true, "every reply attempt must keep thinking disabled");
  assert.notEqual(finalRecoveryBodies[0].messages[0].content, finalRecoveryBodies[1].messages[0].content, "recovery attempts must strengthen the reply contract");
  const privateModelOutput = "RAW_PRIVATE_MODEL_OUTPUT";
  const privateReasoning = "RAW_PRIVATE_REASONING";
  let exhaustedCalls = 0;
  const exhaustedClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => {
    exhaustedCalls += 1;
    return { ok: true, json: async () => exhaustedCalls === 1
      ? { id: "req-length", usage: { completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 123 } }, choices: [{ finish_reason: "length", message: { content: privateModelOutput, reasoning_content: privateReasoning } }] }
      : { id: "req-empty", usage: { completion_tokens: 0, completion_tokens_details: { reasoning_tokens: 0 } }, choices: [{ finish_reason: "stop", message: { content: "", reasoning_content: `${privateReasoning}-2` } }] } };
  } });
  const exhausted = await exhaustedClient.reply(retryInput);
  assert.equal(exhausted.reply, "这个问题我帮您确认一下，稍后回复您。");
  assert.equal(exhausted.intent, false);
  assert.equal(exhausted.needsHuman, true, "two invalid responses must use the existing human handoff path");
  assert.equal(exhausted.aiWarningCode, "AI_RESPONSE_EMPTY");
  assert.match(exhausted.aiWarning, /已发送兜底消息并提醒人工/);
  assert.match(exhausted.handoffReason, /AI_RESPONSE_TRUNCATED/);
  assert.match(exhausted.handoffReason, /AI_RESPONSE_EMPTY/);
  assert.doesNotMatch(exhausted.handoffReason, /finish=|content=|tokens=|id=/, "file-helper handoff must stay short and business-readable");
  assert.equal(exhausted.handoffReason.includes(privateModelOutput), false, "provider diagnostics must not expose raw model output");
  assert.equal(exhausted.handoffReason.includes(privateReasoning), false, "provider diagnostics must not expose raw model reasoning");
  assert.equal(exhausted.handoffReason.includes(retryInput.context[0].content), false, "provider diagnostics must not repeat customer messages");
  assert.equal(exhausted.handoffReason.includes("test-customer-key"), false, "provider diagnostics must not expose the API key");
  assert.equal(exhaustedCalls, 2, "one recovery attempt must fall back instead of retrying again");
  let incompleteCalls = 0;
  const incompleteRetryClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => ({
    ok: true,
    json: async () => (++incompleteCalls === 1
      ? { choices: [{ finish_reason: "insufficient_system_resource", message: { content: "" } }] }
      : { choices: [{ finish_reason: "stop", message: { content: validRetryContent } }] })
  }) });
  assert.equal((await incompleteRetryClient.reply(retryInput)).intent, true);
  assert.equal(incompleteCalls, 2, "an incomplete generation must retry exactly once");
  let filteredCalls = 0;
  const filteredClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => {
    filteredCalls += 1;
    return { ok: true, json: async () => ({ id: "req-filtered", choices: [{ finish_reason: "content_filter", message: { content: "" } }] }) };
  } });
  const filtered = await filteredClient.reply(retryInput);
  assert.equal(filtered.needsHuman, true);
  assert.match(filtered.handoffReason, /AI_CONTENT_FILTERED/);
  assert.doesNotMatch(filtered.handoffReason, /req-filtered/, "operator reminders must not include provider request ids");
  assert.equal(filteredCalls, 1, "content-filtered output must hand off without retrying");
  let networkCalls = 0;
  const networkFailureClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => {
    networkCalls += 1;
    throw new Error("offline");
  } });
  const networkFallback = await networkFailureClient.reply(retryInput);
  assert.equal(networkFallback.needsHuman, true, "temporary transport failures must use the human handoff path instead of pausing the listener");
  assert.match(networkFallback.handoffReason, /AI_NETWORK_ERROR/);
  assert.equal(networkCalls, 1, "transport failures must hand off without an automatic retry");
  let recoveryNetworkCalls = 0;
  const recoveryNetworkClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => {
    recoveryNetworkCalls += 1;
    if (recoveryNetworkCalls === 1) return { ok: true, json: async () => ({ id: "req-before-network", choices: [{ finish_reason: "stop", message: { content: "" } }] }) };
    throw new Error("offline during recovery");
  } });
  const recoveryNetworkFallback = await recoveryNetworkClient.reply(retryInput);
  assert.equal(recoveryNetworkFallback.needsHuman, true);
  assert.match(recoveryNetworkFallback.handoffReason, /AI_RESPONSE_EMPTY/);
  assert.match(recoveryNetworkFallback.handoffReason, /AI_NETWORK_ERROR/, "the final handoff must retain both the provider-output and recovery-transport failures");
  assert.equal(recoveryNetworkCalls, 2);
  const invalidKeyClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  const invalidKeyFallback = await invalidKeyClient.reply(retryInput);
  assert.equal(invalidKeyFallback.needsHuman, true);
  assert.equal(invalidKeyFallback.pauseAfterHandoff, true, "persistent configuration failures must pause only after the scanned message is safely handed off");
  assert.match(invalidKeyFallback.pauseReason, /API Key 无效/);
  assert.match(invalidKeyFallback.handoffReason, /API_KEY_INVALID/);
  for (const temporaryResponse of [
    { status: 408, body: {}, code: "AI_REQUEST_TIMEOUT" },
    { status: 429, body: {}, code: "AI_RATE_LIMITED" },
    { status: 500, body: { error: "load balancer unavailable" }, code: "AI_REQUEST_FAILED" }
  ]) {
    const temporaryClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => ({ ok: false, status: temporaryResponse.status, json: async () => temporaryResponse.body }) });
    const temporaryFallback = await temporaryClient.reply(retryInput);
    assert.equal(temporaryFallback.needsHuman, true);
    assert.equal(temporaryFallback.pauseAfterHandoff, undefined, `HTTP ${temporaryResponse.status} must not pause the listener`);
    assert.match(temporaryFallback.handoffReason, new RegExp(temporaryResponse.code));
  }
  const rejectedRequestClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid request" }) }) });
  const rejectedRequestFallback = await rejectedRequestClient.reply(retryInput);
  assert.equal(rejectedRequestFallback.pauseAfterHandoff, true, "persistent request errors must hand off the current customer and then pause for correction");
  assert.match(rejectedRequestFallback.handoffReason, /AI_REQUEST_REJECTED/);
  const balanceClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => ({ ok: false, status: 402, json: async () => ({}) }) });
  const balanceFallback = await balanceClient.reply(retryInput);
  assert.equal(balanceFallback.pauseAfterHandoff, true);
  assert.match(balanceFallback.handoffReason, /AI_BALANCE_INSUFFICIENT/);
  const stalledClient = createDeepSeekClient({
    keyStore: store,
    requestTimeoutMs: 5,
    fetchImpl: async (_url, request) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }))
    })
  });
  assert.equal(parseReplyDecision(JSON.stringify({ reply: "您好，丫子，有什么可以帮您的吗？", intent: false, intentReason: "", needsHuman: false, handoffReason: "" })).reply, "您好，有什么可以帮您的吗？");
  assert.equal(parseReplyDecision(JSON.stringify({ reply: "张总，您好，请问想了解哪类设备？", intent: false, intentReason: "", needsHuman: false, handoffReason: "" })).reply, "您好，请问想了解哪类设备？");
  await assert.rejects(() => stalledClient.test(), (error) => error.code === "AI_REQUEST_TIMEOUT");
  const invalidPayloadClient = createDeepSeekClient({
    keyStore: store,
    fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError("invalid json"); } })
  });
  await assert.rejects(() => invalidPayloadClient.test(), (error) => error.code === "AI_RESPONSE_INVALID", "an unparsable HTTP 200 payload is a provider response error, not a network failure");
  store.clear();
  await assert.rejects(() => client.test(), (error) => error.code === "API_KEY_MISSING");
  const preload = fs.readFileSync(path.join(__dirname, "preload-api.cjs"), "utf8");
  assert.equal(preload.includes("deepseek-api:read"), false, "preload must not expose a Key read IPC");
  const renderer = fs.readFileSync(path.join(__dirname, "../renderer/App.tsx"), "utf8");
  const saveAndTestBlock = renderer.slice(renderer.indexOf("const saveAndTest"), renderer.indexOf("return (", renderer.indexOf("const saveAndTest")));
  assert.ok(saveAndTestBlock.indexOf(".test({ apiKey: value })") < saveAndTestBlock.indexOf(".save({ apiKey: value })"), "a replacement Key must pass the production capability test before it can replace the saved Key");
  for (const relativeFile of ["../../scripts/build-portable-release.cjs", "../../scripts/portable-release.self_check.cjs", "../../scripts/check-clean-runtime.cjs"]) {
    const releaseGuard = fs.readFileSync(path.join(__dirname, relativeFile), "utf8");
    assert.match(releaseGuard, /deepseek-api-key\.bin/u, `${relativeFile} must keep the encrypted runtime Key outside portable packages`);
  }
  console.log("deepseek-api self-check passed");
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch((error) => { console.error(error); process.exit(1); });
