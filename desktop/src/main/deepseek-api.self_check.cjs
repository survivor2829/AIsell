const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEEPSEEK_MODEL, createDeepSeekClient, createDeepSeekKeyStore, maskApiKey, parseReplyDecision, prompt } = require("./deepseek-api.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-deepseek-"));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`encrypted:${value}`), decryptString: (value) => value.toString().replace(/^encrypted:/, "") };

async function main() {
  const store = createDeepSeekKeyStore({ rootDir: root, safeStorage });
  assert.deepEqual(store.status(), { configured: false, maskedKey: "" });
  store.write("test-customer-key");
  assert.equal(store.read(), "test-customer-key");
  assert.equal(store.status().maskedKey, maskApiKey("test-customer-key"));
  assert.equal(maskApiKey("sk-a"), "****");
  const messages = prompt({ salutation: "张总", script: "{称呼}，您好，我们这边有清洁设备短租方案。" });
  assert.match(messages[0].content, /完整微信消息/);
  assert.match(messages[0].content, /50至90个汉字/);
  assert.match(messages[0].content, /自然加入2至3个/);
  assert.match(messages[0].content, /最少2个/);
  assert.match(messages[0].content, /不得连续堆叠/);
  assert.equal(messages[1].content, "客户称呼：张总，您好\n基础话术：张总，您好，我们这边有清洁设备短租方案。");
  assert.equal(prompt({ salutation: "", script: "{称呼}，您好，欢迎了解。" })[1].content, "客户称呼：您好\n基础话术：您好，欢迎了解。");
  const requests = [];
  const client = createDeepSeekClient({ keyStore: store, fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body);
    requests.push(body);
    assert.equal(body.model, DEEPSEEK_MODEL);
    assert.match(request.headers.authorization, /^Bearer /);
    const isReply = body.messages[0].content.includes("微信一对一客服回复助手");
    const content = isReply
      ? JSON.stringify({ reply: "可以的，请问您想先了解哪种方案？", intent: true, intentReason: "客户主动询问方案", needsHuman: true, handoffReason: "需要人工提供报价" })
      : "您好，欢迎了解我们的服务。";
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  } });
  assert.equal((await client.draft({ task: { script: "欢迎咨询" }, result: { request_id: "request", salutation: { type: "person", value: "张总" } } })).draft, "您好，欢迎了解我们的服务。");
  assert.equal(requests.at(-1).response_format, undefined, "plain-text draft must not enable JSON mode");
  assert.equal(requests.at(-1).thinking, undefined, "plain-text draft must keep the model default");
  const decision = await client.reply({
    expert: "业务信息：设备短租。意向判定：询价时提醒人工。",
    context: [
      { role: "assistant", content: "您好，想了解哪方面？" },
      { role: "user", content: "请问怎么收费？" }
    ]
  });
  assert.deepEqual(decision, {
    reply: "可以的，请问您想先了解哪种方案？",
    intent: true,
    intentReason: "客户主动询问方案",
    needsHuman: true,
    handoffReason: "需要人工提供报价"
  });
  assert.deepEqual(requests.at(-1).response_format, { type: "json_object" }, "auto-reply must use DeepSeek JSON mode");
  assert.deepEqual(requests.at(-1).thinking, { type: "disabled" }, "structured auto-reply must disable thinking mode");
  assert.deepEqual(parseReplyDecision("```json\n{\"reply\":\"稍等，我帮您确认。\",\"intent\":false,\"intentReason\":\"\",\"needsHuman\":true,\"handoffReason\":\"资料未覆盖\"}\n```"), {
    reply: "稍等，我帮您确认。",
    intent: false,
    intentReason: "",
    needsHuman: true,
    handoffReason: "资料未覆盖"
  });
  assert.throws(() => parseReplyDecision("not-json"), (error) => error.code === "AI_RESPONSE_INVALID");
  assert.throws(() => parseReplyDecision(JSON.stringify({ reply: "收到", intent: false })), (error) => error.code === "AI_RESPONSE_INVALID");
  assert.throws(() => parseReplyDecision(JSON.stringify({ reply: "   ", intent: false, intentReason: "", needsHuman: false, handoffReason: "" })), (error) => error.code === "AI_RESPONSE_INVALID");
  assert.equal(parseReplyDecision(JSON.stringify({ reply: "收到", intent: true, intentReason: "有意向", needsHuman: false, handoffReason: "" })).needsHuman, true, "intent must always require a human handoff");
  assert.equal(JSON.stringify(requests.at(-1)).includes("张总"), false, "auto-reply request must not include the contact name");
  assert.equal(JSON.stringify(requests.at(-1)).includes("设备短租"), true);
  assert.equal(JSON.stringify(requests.at(-1)).includes("请问怎么收费"), true);
  const stalledClient = createDeepSeekClient({
    keyStore: store,
    requestTimeoutMs: 5,
    fetchImpl: async (_url, request) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }))
    })
  });
  await assert.rejects(() => stalledClient.test(), (error) => error.code === "AI_REQUEST_TIMEOUT");
  store.clear();
  await assert.rejects(() => client.test(), (error) => error.code === "API_KEY_MISSING");
  const preload = fs.readFileSync(path.join(__dirname, "preload-api.cjs"), "utf8");
  assert.equal(preload.includes("deepseek-api:read"), false, "preload must not expose a Key read IPC");
  console.log("deepseek-api self-check passed");
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch((error) => { console.error(error); process.exit(1); });
