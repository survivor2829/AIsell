const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DEEPSEEK_MODEL,
  DeepSeekApiError,
  createDeepSeekClient,
  createDeepSeekKeyStore,
  maskApiKey,
  momentsCommentPrompt,
  parseMomentsCommentPayload,
  parsePlainPayload,
  parseReplyDecision,
  prompt,
  replyPrompt
} = require("./deepseek-api.cjs");
const { errorCategory, registerDeepSeekApiIpc } = require("./deepseek-api-ipc.cjs");

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

  const ipcHandlers = new Map();
  const providerChanges = [];
  let ipcKey = "";
  registerDeepSeekApiIpc({
    ipcMain: { handle: (channel, handler) => ipcHandlers.set(channel, handler) },
    keyStore: {
      status: () => ({ configured: Boolean(ipcKey), maskedKey: ipcKey ? "sk-****test" : "" }),
      write: (value) => {
        ipcKey = String(value || "");
        return { configured: true, maskedKey: "sk-****test" };
      },
      clear: () => {
        ipcKey = "";
        return { configured: false, maskedKey: "" };
      }
    },
    client: { test: async () => ({ provider: "deepseek", model: DEEPSEEK_MODEL }) },
    onChanged: (change) => providerChanges.push(change)
  });
  const ipcSecret = "ipc-secret-must-not-leak";
  const savedFromIpc = await ipcHandlers.get("deepseek-api:save")(null, { apiKey: ipcSecret });
  assert.equal(savedFromIpc.ok, true);
  assert.equal(JSON.stringify(savedFromIpc).includes(ipcSecret), false);
  assert.deepEqual(providerChanges, [{ action: "saved", configured: true }]);
  const deletedFromIpc = await ipcHandlers.get("deepseek-api:delete")();
  assert.equal(deletedFromIpc.ok, true);
  assert.deepEqual(providerChanges, [
    { action: "saved", configured: true },
    { action: "deleted", configured: false }
  ]);
  const ipcSource = fs.readFileSync(path.join(__dirname, "deepseek-api-ipc.cjs"), "utf8");
  assert.match(ipcSource, /key_save[\s\S]*supplied_key/u);
  assert.doesNotMatch(ipcSource, /key_save[^\n]*apiKey/u);

  const momentsMessages = momentsCommentPrompt({
    postText: "今天完成了新门店的设备安装",
    guidance: "自然一点"
  });
  assert.match(momentsMessages[0].content, /针对帖子里的具体内容/);
  assert.match(momentsMessages[0].content, /额外要求：自然一点/);
  assert.equal(momentsMessages[1].content, "帖子内容：今天完成了新门店的设备安装");
  assert.equal(parseMomentsCommentPayload({
    choices: [{ finish_reason: "stop", message: { content: "“新门店布置得很有质感，开业顺利！”" } }]
  }), "新门店布置得很有质感，开业顺利！");
  assert.throws(() => parseMomentsCommentPayload({
    choices: [{ finish_reason: "stop", message: { content: "长".repeat(81) } }]
  }), (error) => error.code === "AI_RESPONSE_LENGTH_INVALID");
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
  const expert = {
    expertRules: "回答要专业、简洁；只有真实成交或售后动作才转人工。",
    businessKnowledge: "设备短租适用于临时施工；具体价格以正式报价为准。"
  };
  const replyMessages = replyPrompt({
    expert,
    clarificationAllowed: false,
    context: [{ role: "user", content: "工厂一千平，粉尘多。" }]
  });
  const replyPolicy = replyMessages[0].content;
  assert.match(replyPolicy, /answer.*默认动作/s);
  assert.match(replyPolicy, /不能因为问题困难、知识缺失.*handoff/s);
  assert.match(replyPolicy, /公司价格、参数、库存、政策或承诺.*业务知识/s);
  assert.match(replyPolicy, /一般行业知识.*通用技术建议/s);
  assert.match(replyPolicy, /本轮禁止再次选择clarify/);
  assert.match(replyMessages[1].content, /专家规则[\s\S]*只有真实成交或售后动作才转人工/);
  assert.match(replyMessages[2].content, /业务知识[\s\S]*设备短租适用于临时施工/);
  assert.equal(replyMessages.at(-1).content, "工厂一千平，粉尘多。");
  const requests = [];
  const client = createDeepSeekClient({ keyStore: store, fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body);
    requests.push(body);
    assert.equal(body.model, DEEPSEEK_MODEL);
    assert.match(request.headers.authorization, /^Bearer /);
    const isReply = body.messages[0].content.includes("微信一对一客服回复助手");
    const content = isReply
      ? JSON.stringify({ action: "handoff", reply: "收到，我把正式报价需求交给同事核实。", reasonCode: "transaction_commitment" })
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
      autoReply: { ok: true, outputLength: 18 },
      momentsComment: { ok: true, outputLength: 13 }
    }
  });
  const capabilityRequests = requests.slice(requestsBeforeCapabilityTest);
  assert.equal(capabilityRequests.length, 3, "connection tests must validate every production AI output mode");
  assert.equal(capabilityRequests[0].max_tokens, 300);
  assert.equal(capabilityRequests[0].response_format, undefined, "connection tests must validate active-touch plain text output");
  assert.deepEqual(capabilityRequests[0].thinking, { type: "disabled" });
  assert.equal(capabilityRequests[1].max_tokens, 300);
  assert.deepEqual(capabilityRequests[1].response_format, { type: "json_object" }, "connection tests must validate auto-reply structured output");
  assert.deepEqual(capabilityRequests[1].thinking, { type: "disabled" }, "connection tests must not accept reasoning-only HTTP 200 responses");
  assert.equal(capabilityRequests[2].max_tokens, 120);
  assert.equal(capabilityRequests[2].response_format, undefined, "connection tests must validate moments plain-text output");
  assert.deepEqual(capabilityRequests[2].thinking, { type: "disabled" });
  assert.equal((await client.draft({ task: { script: "欢迎咨询" }, result: { request_id: "request", salutation: { type: "person", value: "张总" } } })).draft, "您好，欢迎了解我们的服务。");
  assert.equal(requests.at(-1).response_format, undefined, "plain-text draft must not enable JSON mode");
  assert.deepEqual(requests.at(-1).thinking, { type: "disabled" }, "plain-text draft must not spend its completion budget on hidden reasoning");
  assert.equal(requests.at(-1).max_tokens, 300);
  const momentsBodies = [];
  const momentsClient = createDeepSeekClient({
    keyStore: store,
    fetchImpl: async (_url, request) => {
      momentsBodies.push(JSON.parse(request.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{ finish_reason: "stop", message: { content: "新店布置得很有质感，开业顺利！" } }]
        })
      };
    }
  });
  assert.deepEqual(await momentsClient.momentsComment({
    postText: "今天完成了新门店的设备安装",
    guidance: "自然一点"
  }), { comment: "新店布置得很有质感，开业顺利！" });
  assert.equal(momentsBodies.length, 1);
  assert.equal(momentsBodies[0].max_tokens, 120);
  assert.deepEqual(momentsBodies[0].thinking, { type: "disabled" });
  assert.match(momentsBodies[0].messages[1].content, /新门店的设备安装/);
  const requestsBeforeReply = requests.length;
  const decision = await client.reply({
    expert,
    context: [
      { role: "assistant", content: "您好，想了解哪方面？" },
      { role: "user", content: "请给我正式报价，我准备下单。" }
    ]
  });
  assert.deepEqual(decision, {
    action: "handoff",
    reply: "收到，我把正式报价需求交给同事核实。",
    reasonCode: "transaction_commitment"
  });
  assert.deepEqual(requests.at(-1).response_format, { type: "json_object" }, "auto-reply must use DeepSeek JSON mode");
  assert.deepEqual(requests.at(-1).thinking, { type: "disabled" }, "structured auto-reply must disable thinking mode");
  assert.equal(requests.length, requestsBeforeReply + 1, "a valid structured response must not trigger a retry");
  const validDecisions = [
    { action: "answer", reply: "设备短租适合临时施工。", reasonCode: "business_knowledge" },
    { action: "answer", reply: "可以先清理表面铁屑，再检查涂层是否划伤。", reasonCode: "general_guidance" },
    { action: "answer", reply: "目前资料没有公司库存信息，我可以先介绍一般选型方法。", reasonCode: "company_fact_unavailable" },
    { action: "clarify", reply: "铁屑只是散落在表面，还是已经嵌入涂层？", reasonCode: "missing_detail" },
    { action: "handoff", reply: "好的，我为您转接人工同事。", reasonCode: "explicit_human_request" },
    { action: "handoff", reply: "收到，我请同事继续处理正式下单。", reasonCode: "transaction_commitment" },
    { action: "handoff", reply: "收到，我请售后同事继续处理退款。", reasonCode: "after_sales_action" },
    { action: "silent", reply: "", reasonCode: "no_reply_needed" }
  ];
  for (const expected of validDecisions) {
    assert.deepEqual(parseReplyDecision(`\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``), expected);
  }
  assert.throws(() => parseReplyDecision("not-json"), (error) => error.code === "AI_RESPONSE_INVALID");
  assert.throws(() => parseReplyDecision(JSON.stringify({ action: "answer", reply: "收到" })), (error) => error.code === "AI_RESPONSE_INVALID");
  assert.throws(() => parseReplyDecision(JSON.stringify({ action: "answer", reply: "收到", reasonCode: "missing_detail" })), (error) => error.code === "AI_RESPONSE_INVALID", "action/reason pairs must be compatible");
  assert.throws(() => parseReplyDecision(JSON.stringify({ action: "silent", reply: "收到", reasonCode: "no_reply_needed" })), (error) => error.code === "AI_RESPONSE_INVALID");
  assert.throws(() => parseReplyDecision(JSON.stringify({ action: "answer", reply: "", reasonCode: "general_guidance" })), (error) => error.code === "AI_RESPONSE_INVALID");
  assert.throws(() => parseReplyDecision(JSON.stringify({ action: "clarify", reply: "请问具体面积？", reasonCode: "missing_detail" }), { clarificationAllowed: false }), (error) => error.code === "AI_RESPONSE_INVALID", "a second clarification must be rejected as structured output");
  assert.throws(() => parseReplyDecision(JSON.stringify({ action: "answer", reply: "收到", reasonCode: "general_guidance", extra: true })), (error) => error.code === "AI_RESPONSE_INVALID", "the decision contract must contain exactly three fields");
  assert.equal(parsePlainPayload({ choices: [{ finish_reason: "stop", message: { content: "连接正常" } }] }, "missing"), "连接正常");
  assert.throws(() => parsePlainPayload({ choices: [{ finish_reason: "stop", message: { content: "" } }] }, "missing"), (error) => error.code === "AI_RESPONSE_EMPTY");
  assert.throws(() => parsePlainPayload({}, "missing"), (error) => error.code === "AI_RESPONSE_INVALID", "a malformed provider envelope must not be reported as empty content");
  assert.throws(() => parsePlainPayload({ choices: [{ finish_reason: "stop", message: { content: null } }] }, "missing"), (error) => error.code === "AI_RESPONSE_EMPTY", "an explicit null completion is empty content");
  assert.throws(() => parsePlainPayload({ choices: [{ finish_reason: "stop", message: { content: "长".repeat(261) } }] }, "missing"), (error) => error.code === "AI_RESPONSE_LENGTH_INVALID");
  assert.throws(() => parseReplyDecision(JSON.stringify({ action: "answer", reply: "长".repeat(261), reasonCode: "general_guidance" })), (error) => error.code === "AI_RESPONSE_LENGTH_INVALID");
  assert.throws(() => parsePlainPayload({ choices: [{ finish_reason: "length", message: { content: "未完成" } }] }, "missing"), (error) => error.code === "AI_RESPONSE_TRUNCATED");
  assert.equal(JSON.stringify(requests.at(-1)).includes("张总"), false, "auto-reply request must not include the contact name");
  assert.equal(JSON.stringify(requests.at(-1)).includes(expert.expertRules), true);
  assert.equal(JSON.stringify(requests.at(-1)).includes(expert.businessKnowledge), true);
  assert.equal(JSON.stringify(requests.at(-1)).includes("请给我正式报价"), true);
  const retryInput = {
    expert,
    context: [{ role: "user", content: "工厂粉尘多，想了解高压清洗机。" }]
  };
  let missingExpertFetches = 0;
  const missingExpertClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => {
    missingExpertFetches += 1;
    throw new Error("must not call fetch");
  } });
  await assert.rejects(() => missingExpertClient.reply({ ...retryInput, expert: { expertRules: expert.expertRules, businessKnowledge: "" } }), (error) => error.code === "AI_EXPERT_MISSING");
  await assert.rejects(() => missingExpertClient.reply({ ...retryInput, expert: { expertRules: "", businessKnowledge: expert.businessKnowledge } }), (error) => error.code === "AI_EXPERT_MISSING");
  assert.equal(missingExpertFetches, 0, "auto-reply must require both expert documents before calling DeepSeek");
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
  const validRetryContent = JSON.stringify({ action: "answer", reply: "粉尘较多时可以先按作业面积和角落占比选择设备。", reasonCode: "general_guidance" });
  const emptyRetryBodies = [];
  const emptyRetryPayloads = [
    { id: "req-empty-json", choices: [{ finish_reason: "stop", message: { content: "" } }] },
    { id: "req-plain-recovery", choices: [{ finish_reason: "stop", message: { content: validRetryContent } }] }
  ];
  const emptyRetryClient = createDeepSeekClient({ keyStore: store, fetchImpl: async (_url, request) => {
    emptyRetryBodies.push(JSON.parse(request.body));
    return { ok: true, json: async () => emptyRetryPayloads.shift() };
  } });
  assert.equal((await emptyRetryClient.reply(retryInput)).action, "answer");
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
  assert.equal((await truncatedRetryClient.reply(retryInput)).action, "answer");
  assert.equal(truncatedCalls, 2, "a truncated structured response must retry exactly once");
  let invalidCalls = 0;
  const invalidRetryClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => ({
    ok: true,
    json: async () => (++invalidCalls === 1
      ? { choices: [{ finish_reason: "stop", message: { content: "not-json" } }] }
      : { choices: [{ finish_reason: "stop", message: { content: validRetryContent } }] })
  }) });
  assert.equal((await invalidRetryClient.reply(retryInput)).action, "answer");
  assert.equal(invalidCalls, 2, "invalid JSON must retry exactly once");
  let lengthCalls = 0;
  const lengthRetryClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => ({
    ok: true,
    json: async () => (++lengthCalls === 1
      ? { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ action: "answer", reply: "长".repeat(261), reasonCode: "general_guidance" }) } }] }
      : { choices: [{ finish_reason: "stop", message: { content: validRetryContent } }] })
  }) });
  assert.equal((await lengthRetryClient.reply(retryInput)).action, "answer");
  assert.equal(lengthCalls, 2, "an unusable reply length must retry exactly once");
  let noSecondClarifyCalls = 0;
  const noSecondClarifyClient = createDeepSeekClient({ keyStore: store, fetchImpl: async (_url, request) => {
    noSecondClarifyCalls += 1;
    const body = JSON.parse(request.body);
    if (noSecondClarifyCalls === 2) assert.match(body.messages[0].content, /结构化恢复请求/);
    const content = noSecondClarifyCalls === 1
      ? JSON.stringify({ action: "clarify", reply: "请问具体面积？", reasonCode: "missing_detail" })
      : validRetryContent;
    return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content } }] }) };
  } });
  assert.equal((await noSecondClarifyClient.reply({ ...retryInput, clarificationAllowed: false })).action, "answer");
  assert.equal(noSecondClarifyCalls, 2, "a forbidden second clarification must use the one structured recovery attempt");
  const privateModelOutput = "RAW_PRIVATE_MODEL_OUTPUT";
  const privateReasoning = "RAW_PRIVATE_REASONING";
  let exhaustedCalls = 0;
  const exhaustedClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => {
    exhaustedCalls += 1;
    return { ok: true, json: async () => exhaustedCalls === 1
      ? { id: "req-length", usage: { completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 123 } }, choices: [{ finish_reason: "length", message: { content: privateModelOutput, reasoning_content: privateReasoning } }] }
      : { id: "req-empty", usage: { completion_tokens: 0, completion_tokens_details: { reasoning_tokens: 0 } }, choices: [{ finish_reason: "stop", message: { content: "", reasoning_content: `${privateReasoning}-2` } }] } };
  } });
  await assert.rejects(() => exhaustedClient.reply(retryInput), (error) => {
    assert.equal(error instanceof DeepSeekApiError, true);
    assert.equal(error.code, "AI_RESPONSE_EMPTY");
    assert.equal(error.message.includes(privateModelOutput), false);
    assert.equal(error.message.includes(privateReasoning), false);
    assert.equal(error.message.includes(retryInput.context[0].content), false);
    assert.equal(error.message.includes(expert.expertRules), false);
    assert.equal(error.message.includes("test-customer-key"), false);
    return true;
  }, "two invalid outputs must throw instead of synthesizing customer text");
  assert.equal(exhaustedCalls, 2, "reply generation must never exceed one recovery call");
  let incompleteCalls = 0;
  const incompleteRetryClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => ({
    ok: true,
    json: async () => (++incompleteCalls === 1
      ? { choices: [{ finish_reason: "insufficient_system_resource", message: { content: "" } }] }
      : { choices: [{ finish_reason: "stop", message: { content: validRetryContent } }] })
  }) });
  assert.equal((await incompleteRetryClient.reply(retryInput)).action, "answer");
  assert.equal(incompleteCalls, 2, "an incomplete generation must retry exactly once");
  let filteredCalls = 0;
  const filteredClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => {
    filteredCalls += 1;
    return { ok: true, json: async () => ({ id: "req-filtered", choices: [{ finish_reason: "content_filter", message: { content: "" } }] }) };
  } });
  await assert.rejects(() => filteredClient.reply(retryInput), (error) => error.code === "AI_CONTENT_FILTERED");
  assert.equal(filteredCalls, 1, "content-filtered output must fail immediately without retrying");
  let networkCalls = 0;
  const networkFailureClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => {
    networkCalls += 1;
    throw new Error("offline");
  } });
  await assert.rejects(() => networkFailureClient.reply(retryInput), (error) => error.code === "AI_NETWORK_ERROR");
  assert.equal(networkCalls, 1, "transport failures must fail immediately without an automatic retry");
  const invalidKeyClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  await assert.rejects(() => invalidKeyClient.reply(retryInput), (error) => error.code === "API_KEY_INVALID");
  for (const temporaryResponse of [
    { status: 408, body: {}, code: "AI_REQUEST_TIMEOUT" },
    { status: 429, body: {}, code: "AI_RATE_LIMITED" },
    { status: 500, body: { error: "load balancer unavailable" }, code: "AI_REQUEST_FAILED" }
  ]) {
    const temporaryClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => ({ ok: false, status: temporaryResponse.status, json: async () => temporaryResponse.body }) });
    await assert.rejects(() => temporaryClient.reply(retryInput), (error) => error.code === temporaryResponse.code);
  }
  const rejectedRequestClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid request" }) }) });
  await assert.rejects(() => rejectedRequestClient.reply(retryInput), (error) => error.code === "AI_REQUEST_REJECTED");
  const balanceClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => ({ ok: false, status: 402, json: async () => ({}) }) });
  await assert.rejects(() => balanceClient.reply(retryInput), (error) => error.code === "AI_BALANCE_INSUFFICIENT");
  const unreadableReplyClient = createDeepSeekClient({
    keyStore: { read: () => { throw new DeepSeekApiError("API_KEY_UNREADABLE", "已保存的 DeepSeek API Key 无法读取，请重新填写。"); } },
    fetchImpl: async () => { throw new Error("must not call fetch"); }
  });
  await assert.rejects(() => unreadableReplyClient.reply(retryInput), (error) => error.code === "API_KEY_UNREADABLE", "reply() must propagate key-store failures");
  const stalledClient = createDeepSeekClient({
    keyStore: store,
    requestTimeoutMs: 5,
    fetchImpl: async (_url, request) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }))
    })
  });
  assert.equal(parseReplyDecision(JSON.stringify({ action: "answer", reply: "您好，丫子，有什么可以帮您的吗？", reasonCode: "general_guidance" })).reply, "您好，有什么可以帮您的吗？");
  assert.equal(parseReplyDecision(JSON.stringify({ action: "answer", reply: "张总，您好，请问想了解哪类设备？", reasonCode: "general_guidance" })).reply, "您好，请问想了解哪类设备？");
  await assert.rejects(() => stalledClient.reply(retryInput), (error) => error.code === "AI_REQUEST_TIMEOUT");
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
