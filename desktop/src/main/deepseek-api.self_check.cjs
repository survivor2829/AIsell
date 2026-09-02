const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DEEPSEEK_MODEL,
  DeepSeekApiError,
  createDeepSeekClient,
  createDeepSeekKeyStore,
  isExplicitConversationClosure,
  maskApiKey,
  momentsCommentPrompt,
  parseMomentsCommentPayload,
  parsePlainPayload,
  parsePlainRecoveryAnswer,
  parseReplyDecision,
  prompt,
  replyPrompt
} = require("./deepseek-api.cjs");
const { errorCategory, registerDeepSeekApiIpc } = require("./deepseek-api-ipc.cjs");
const { configureDiagnostics } = require("./diagnostics.cjs");

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
  assert.match(momentsMessages[0].content, /可能只是可见片段，不要求全文/);
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
  assert.deepEqual(
    parseReplyDecision(JSON.stringify({ action: "answer", reply: "收到", reasonCode: "missing_detail" })),
    { action: "answer", reply: "收到", reasonCode: "missing_detail" },
    "a known diagnostic reason must not override or block the selected business action"
  );
  assert.throws(
    () => parseReplyDecision(JSON.stringify({ action: "unknown", reply: "收到", reasonCode: "general_guidance" })),
    (error) => error.code === "AI_RESPONSE_INVALID" && error.diagnosticCode === "action_invalid"
  );
  assert.throws(
    () => parseReplyDecision(JSON.stringify({ action: "answer", reply: "收到", reasonCode: "unknown" })),
    (error) => error.code === "AI_RESPONSE_INVALID" && error.diagnosticCode === "reason_code_invalid"
  );
  assert.throws(() => parseReplyDecision(JSON.stringify({ action: "silent", reply: "收到", reasonCode: "no_reply_needed" })), (error) => error.code === "AI_RESPONSE_INVALID");
  assert.equal(isExplicitConversationClosure("好的，谢谢"), true);
  assert.equal(isExplicitConversationClosure("暂时不用了"), true);
  assert.equal(isExplicitConversationClosure("我想买一台洗地机"), false);
  assert.equal(isExplicitConversationClosure("谢谢，设备怎么选？"), false);
  assert.throws(() => parseReplyDecision(JSON.stringify({ action: "answer", reply: "", reasonCode: "general_guidance" })), (error) => error.code === "AI_RESPONSE_INVALID");
  assert.throws(() => parseReplyDecision(JSON.stringify({ action: "clarify", reply: "请问具体面积？", reasonCode: "missing_detail" }), { clarificationAllowed: false }), (error) => error.code === "AI_RESPONSE_INVALID", "a second clarification must be rejected as structured output");
  assert.deepEqual(
    parseReplyDecision(JSON.stringify({ action: "answer", reply: "收到", reasonCode: "general_guidance", extra: true })),
    { action: "answer", reply: "收到", reasonCode: "general_guidance" },
    "non-control provider metadata must not change the normalized decision"
  );
  assert.equal(parsePlainPayload({ choices: [{ finish_reason: "stop", message: { content: "连接正常" } }] }, "missing"), "连接正常");
  assert.throws(() => parsePlainPayload({ choices: [{ finish_reason: "stop", message: { content: "" } }] }, "missing"), (error) => error.code === "AI_RESPONSE_EMPTY");
  assert.throws(() => parsePlainPayload({}, "missing"), (error) => error.code === "AI_RESPONSE_INVALID", "a malformed provider envelope must not be reported as empty content");
  assert.throws(() => parsePlainPayload({ choices: [{ finish_reason: "stop", message: { content: null } }] }, "missing"), (error) => error.code === "AI_RESPONSE_EMPTY", "an explicit null completion is empty content");
  assert.equal(parsePlainPayload({ choices: [{ finish_reason: "stop", message: { content: [{ type: "text", text: "分段" }, { type: "text", text: "回复" }] } }] }, "missing"), "分段回复", "structured content parts must be normalized before validation");
  assert.deepEqual(
    parsePlainRecoveryAnswer({ choices: [{ finish_reason: "stop", message: { content: "可以先清理表面，再根据现场面积选择设备。" } }] }),
    { action: "answer", reply: "可以先清理表面，再根据现场面积选择设备。", reasonCode: "general_guidance" },
    "a non-empty plain recovery response must remain usable instead of being discarded as invalid JSON"
  );
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
  const compatibleExtraFieldContent = JSON.stringify({
    action: "answer",
    reply: "这类情况可以先清理表面铁屑，再根据现场面积选择合适的处理方式。",
    reasonCode: "general_guidance",
    confidence: "high"
  });
  assert.deepEqual(
    parseReplyDecision(compatibleExtraFieldContent),
    { action: "answer", reply: "这类情况可以先清理表面铁屑，再根据现场面积选择合适的处理方式。", reasonCode: "general_guidance" },
    "an otherwise valid decision must not fail because the provider added a non-control metadata field"
  );
  const emptyRetryBodies = [];
  const emptyRetryInput = {
    expert,
    context: [
      { role: "user", content: "之前的问题一" },
      { role: "assistant", content: "之前的回答一" },
      { role: "user", content: "之前的问题二" },
      { role: "assistant", content: "之前的回答二" },
      { role: "user", content: "之前的问题三" },
      { role: "assistant", content: "之前的回答三" },
      { role: "user", content: "工厂粉尘多，想了解高压清洗机。" }
    ]
  };
  const emptyRetryPayloads = [
    { id: "req-empty-json", choices: [{ finish_reason: "stop", message: { content: "" } }] },
    { id: "req-plain-recovery", choices: [{ finish_reason: "stop", message: { content: validRetryContent } }] }
  ];
  const emptyRetryClient = createDeepSeekClient({ keyStore: store, fetchImpl: async (_url, request) => {
    emptyRetryBodies.push(JSON.parse(request.body));
    return { ok: true, json: async () => emptyRetryPayloads.shift() };
  } });
  assert.equal((await emptyRetryClient.reply(emptyRetryInput)).action, "answer");
  assert.equal(emptyRetryBodies.length, 2, "an empty structured response must retry exactly once before sending");
  assert.equal(emptyRetryBodies[0].max_tokens, 300);
  assert.equal(emptyRetryBodies[1].max_tokens, 600, "the retry must allow a complete JSON response");
  assert.equal(emptyRetryBodies[0].temperature, 0.2, "auto-reply should use a low-temperature deterministic request");
  assert.equal(emptyRetryBodies[1].temperature, 0, "empty-response recovery should remove sampling randomness");
  assert.ok(emptyRetryBodies[1].messages.length < emptyRetryBodies[0].messages.length, "empty-response recovery should compact conversation context");
  assert.deepEqual(emptyRetryBodies[0].response_format, { type: "json_object" });
  assert.equal(emptyRetryBodies[1].response_format, undefined, "the single recovery must leave the repeated JSON mode");
  assert.deepEqual(emptyRetryBodies[1].thinking, { type: "disabled" }, "structured recovery must remain in non-thinking mode");
  assert.match(emptyRetryBodies[1].messages[0].content, /备用结构化恢复请求/, "the recovery must use the alternate structured strategy");
  assert.match(emptyRetryBodies[1].messages[0].content, /reply必须是非空字符串/, "the recovery must explicitly forbid an empty reply");
  const silentRepairBodies = [];
  let silentRepairCalls = 0;
  const silentRepairClient = createDeepSeekClient({ keyStore: store, fetchImpl: async (_url, request) => {
    silentRepairBodies.push(JSON.parse(request.body));
    silentRepairCalls += 1;
    const content = silentRepairCalls === 1
      ? JSON.stringify({ action: "silent", reply: "", reasonCode: "no_reply_needed" })
      : validRetryContent;
    return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content } }] }) };
  } });
  assert.equal((await silentRepairClient.reply(retryInput)).action, "answer", "a business question must never be silently discarded because the model selected silent");
  assert.equal(silentRepairCalls, 2, "an ineligible silent decision must use the one structured recovery attempt");
  assert.match(silentRepairBodies[1].messages[0].content, /不得选择silent/, "the recovery request must explicitly require a customer reply");
  let closingSilentCalls = 0;
  const closingSilentClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => {
    closingSilentCalls += 1;
    return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ action: "silent", reply: "", reasonCode: "no_reply_needed" }) } }] }) };
  } });
  assert.deepEqual(await closingSilentClient.reply({ ...retryInput, context: [{ role: "user", content: "好的，谢谢" }] }), {
    action: "silent",
    reply: "",
    reasonCode: "no_reply_needed"
  }, "an explicit closing message may remain silent");
  assert.equal(closingSilentCalls, 1);
  let plainRecoveryCalls = 0;
  const plainRecoveryClient = createDeepSeekClient({ keyStore: store, fetchImpl: async () => ({
    ok: true,
    json: async () => (++plainRecoveryCalls === 1
      ? { choices: [{ finish_reason: "stop", message: { content: "   " } }] }
      : { choices: [{ finish_reason: "stop", message: { content: "可以先清理表面，再根据现场面积选择设备。" } }] })
  }) });
  assert.deepEqual(await plainRecoveryClient.reply(emptyRetryInput), {
    action: "answer",
    reply: "可以先清理表面，再根据现场面积选择设备。",
    reasonCode: "general_guidance"
  }, "a useful plain recovery response must be accepted after the first empty output");
  assert.equal(plainRecoveryCalls, 2);
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
  const invalidRetryBodies = [];
  const invalidRetryClient = createDeepSeekClient({ keyStore: store, fetchImpl: async (_url, request) => {
    invalidRetryBodies.push(JSON.parse(request.body));
    return {
      ok: true,
      json: async () => (++invalidCalls === 1
        ? { choices: [{ finish_reason: "stop", message: { content: "not-json" } }] }
        : { choices: [{ finish_reason: "stop", message: { content: validRetryContent } }] })
    };
  } });
  assert.equal((await invalidRetryClient.reply(retryInput)).action, "answer");
  assert.equal(invalidCalls, 2, "invalid JSON must retry exactly once");
  assert.deepEqual(invalidRetryBodies[0].response_format, { type: "json_object" });
  assert.equal(invalidRetryBodies[1].response_format, undefined, "recovery must leave JSON mode instead of repeating the same provider constraint");
  const metadataMismatchRoot = path.join(root, "metadata-mismatch-diagnostics");
  configureDiagnostics({ rootDir: metadataMismatchRoot });
  let metadataMismatchCalls = 0;
  const invalidSemanticContent = JSON.stringify({ action: "answer", reply: "这类问题可以先清理表面，再根据现场情况选择处理方式。", reasonCode: "missing_detail" });
  const metadataMismatchClient = createDeepSeekClient({
    keyStore: store,
    fetchImpl: async () => {
      metadataMismatchCalls += 1;
      return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: invalidSemanticContent } }] }) };
    }
  });
  assert.deepEqual(await metadataMismatchClient.reply(retryInput), {
    action: "answer",
    reply: "这类问题可以先清理表面，再根据现场情况选择处理方式。",
    reasonCode: "missing_detail"
  }, "a known diagnostic mismatch must preserve the selected business action");
  assert.equal(metadataMismatchCalls, 1, "a diagnostic mismatch must not trigger a model retry");
  const metadataMismatchDiagnostics = fs.readFileSync(path.join(metadataMismatchRoot, "logs", "diagnostics.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === "reply_decision_metadata_mismatch");
  const metadataMismatchDetails = metadataMismatchDiagnostics[0].details;
  assert.equal(metadataMismatchDetails.attempt, 1);
  assert.equal(metadataMismatchDetails.observed_action, "answer");
  assert.equal(metadataMismatchDetails.observed_reason_code, "missing_detail");
  assert.equal(JSON.stringify(metadataMismatchDetails).includes(invalidSemanticContent), false, "mismatch diagnostics must expose only safe action/reason enums");
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
  const replyDiagnosticRoot = path.join(root, "reply-diagnostics");
  configureDiagnostics({ rootDir: replyDiagnosticRoot });
  let malformedDecisionCalls = 0;
  const malformedDecisionClient = createDeepSeekClient({
    keyStore: store,
    fetchImpl: async () => {
      malformedDecisionCalls += 1;
      return {
        ok: true,
        json: async () => ({
          choices: [{
            finish_reason: "stop",
            message: { content: JSON.stringify({ action: "answer", reasonCode: "general_guidance" }) }
          }]
        })
      };
    }
  });
  await assert.rejects(
    () => malformedDecisionClient.reply(retryInput),
    (error) => error.code === "AI_RESPONSE_INVALID" && error.diagnosticCode === "decision_fields_invalid"
  );
  const replyDiagnosticLines = fs.readFileSync(path.join(replyDiagnosticRoot, "logs", "diagnostics.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.event === "reply_parse_failed");
  assert.equal(replyDiagnosticLines.length, malformedDecisionCalls, "each structured-response attempt must leave a diagnostic event");
  assert.equal(malformedDecisionCalls, 2, "a recoverable structured failure must retry exactly once");
  assert.deepEqual(replyDiagnosticLines.map((entry) => entry.details.parse_code), ["decision_fields_invalid", "decision_fields_invalid"]);
  assert.equal(JSON.stringify(replyDiagnosticLines).includes(retryInput.context[0].content), false, "reply diagnostics must not contain customer text");
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
