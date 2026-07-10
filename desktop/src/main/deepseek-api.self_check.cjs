const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEEPSEEK_MODEL, createDeepSeekClient, createDeepSeekKeyStore, maskApiKey } = require("./deepseek-api.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-deepseek-"));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`encrypted:${value}`), decryptString: (value) => value.toString().replace(/^encrypted:/, "") };

async function main() {
  const store = createDeepSeekKeyStore({ rootDir: root, safeStorage });
  assert.deepEqual(store.status(), { configured: false, maskedKey: "" });
  store.write("test-customer-key");
  assert.equal(store.read(), "test-customer-key");
  assert.equal(store.status().maskedKey, maskApiKey("test-customer-key"));
  assert.equal(maskApiKey("sk-a"), "****");
  const client = createDeepSeekClient({ keyStore: store, fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.model, DEEPSEEK_MODEL);
    assert.match(request.headers.authorization, /^Bearer /);
    return { ok: true, json: async () => ({ choices: [{ message: { content: "您好，欢迎了解我们的服务。" } }] }) };
  } });
  assert.equal((await client.draft({ task: { script: "欢迎咨询" }, result: { request_id: "request", salutation: { type: "person", value: "张总" } } })).draft, "您好，欢迎了解我们的服务。");
  store.clear();
  await assert.rejects(() => client.test(), (error) => error.code === "API_KEY_MISSING");
  const preload = fs.readFileSync(path.join(__dirname, "preload-api.cjs"), "utf8");
  assert.equal(preload.includes("deepseek-api:read"), false, "preload must not expose a Key read IPC");
  console.log("deepseek-api self-check passed");
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch((error) => { console.error(error); process.exit(1); });
