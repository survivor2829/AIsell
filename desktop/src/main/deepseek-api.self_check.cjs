const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEEPSEEK_MODEL, createDeepSeekClient, createDeepSeekKeyStore, maskApiKey, prompt } = require("./deepseek-api.cjs");

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
    return { ok: true, json: async () => ({ choices: [{ message: { content: "您好，欢迎了解我们的服务。" } }] }) };
  } });
  assert.equal((await client.draft({ task: { script: "欢迎咨询" }, result: { request_id: "request", salutation: { type: "person", value: "张总" } } })).draft, "您好，欢迎了解我们的服务。");
  assert.equal((await client.reply({ incoming: "请问怎么收费？", instruction: "礼貌简短" })).reply, "您好，欢迎了解我们的服务。");
  assert.equal(JSON.stringify(requests.at(-1)).includes("张总"), false, "auto-reply request must not include the contact name");
  store.clear();
  await assert.rejects(() => client.test(), (error) => error.code === "API_KEY_MISSING");
  const preload = fs.readFileSync(path.join(__dirname, "preload-api.cjs"), "utf8");
  assert.equal(preload.includes("deepseek-api:read"), false, "preload must not expose a Key read IPC");
  console.log("deepseek-api self-check passed");
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch((error) => { console.error(error); process.exit(1); });
