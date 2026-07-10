const fs = require("node:fs");
const path = require("node:path");
const { sanitizeAiMessage } = require("./ai-draft.cjs");

const DEEPSEEK_ORIGIN = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const REQUEST_TIMEOUT_MS = 25_000;

class DeepSeekApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function maskApiKey(value) {
  const key = String(value || "").trim();
  if (key.length < 8) return key ? "****" : "";
  return key ? `${key.slice(0, 3)}****${key.slice(-4)}` : "";
}

function createDeepSeekKeyStore({ rootDir, safeStorage }) {
  const keyFile = path.join(rootDir, "deepseek-api-key.bin");
  const encryptionAvailable = () => Boolean(safeStorage?.isEncryptionAvailable?.());

  function read() {
    if (!encryptionAvailable()) throw new DeepSeekApiError("SECURE_STORAGE_UNAVAILABLE", "无法启用 Windows 账户加密存储，请检查当前 Windows 用户后重试。");
    if (!fs.existsSync(keyFile)) throw new DeepSeekApiError("API_KEY_MISSING", "请先在账号管理中保存 DeepSeek API Key。");
    try {
      return safeStorage.decryptString(fs.readFileSync(keyFile)).trim();
    } catch {
      fs.rmSync(keyFile, { force: true });
      throw new DeepSeekApiError("API_KEY_MISSING", "已保存的 DeepSeek API Key 无法读取，请重新填写。");
    }
  }

  return {
    status() {
      if (!encryptionAvailable() || !fs.existsSync(keyFile)) return { configured: false, maskedKey: "" };
      try { return { configured: true, maskedKey: maskApiKey(read()) }; } catch { return { configured: false, maskedKey: "" }; }
    },
    read,
    write(value) {
      const key = String(value || "").trim();
      if (!key) throw new DeepSeekApiError("API_KEY_MISSING", "请输入 DeepSeek API Key。");
      if (!encryptionAvailable()) throw new DeepSeekApiError("SECURE_STORAGE_UNAVAILABLE", "无法启用 Windows 账户加密存储，请检查当前 Windows 用户后重试。");
      fs.mkdirSync(rootDir, { recursive: true });
      const temporary = `${keyFile}.tmp`;
      fs.writeFileSync(temporary, safeStorage.encryptString(key), { mode: 0o600 });
      fs.renameSync(temporary, keyFile);
      return this.status();
    },
    clear() { fs.rmSync(keyFile, { force: true }); return { configured: false, maskedKey: "" }; }
  };
}

function prompt({ salutation, script }) {
  const greeting = salutation ? `${salutation}，您好` : "您好";
  return [
    { role: "system", content: "你是微信私域触达文案助手。只输出一条中文首句，不解释、不编号、不含联系人隐私。" },
    { role: "user", content: `基础话术：${script}\n称呼：${greeting}` }
  ];
}

async function responseError(response) {
  if (response.status === 401 || response.status === 403) return new DeepSeekApiError("API_KEY_INVALID", "DeepSeek API Key 无效或已失效，请检查后重新填写。");
  if (response.status === 402) return new DeepSeekApiError("AI_BALANCE_INSUFFICIENT", "DeepSeek 账户余额不足，请充值后再试。");
  if (response.status === 429) return new DeepSeekApiError("AI_RATE_LIMITED", "DeepSeek 请求过于频繁，请稍后再试。");
  let text = "";
  try { text = JSON.stringify(await response.json()).toLowerCase(); } catch {}
  if (/insufficient_balance|余额不足|balance/.test(text)) return new DeepSeekApiError("AI_BALANCE_INSUFFICIENT", "DeepSeek 账户余额不足，请充值后再试。");
  return new DeepSeekApiError("AI_REQUEST_FAILED", "DeepSeek 服务暂时不可用，请稍后重试。");
}

function createDeepSeekClient({ keyStore, fetchImpl = global.fetch } = {}) {
  async function request({ key, messages, maxTokens = 180 }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${DEEPSEEK_ORIGIN}/chat/completions`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: DEEPSEEK_MODEL, messages, temperature: 0.4, max_tokens: maxTokens })
      });
      if (!response.ok) throw await responseError(response);
      return response.json();
    } catch (error) {
      if (error instanceof DeepSeekApiError) throw error;
      if (error?.name === "AbortError") throw new DeepSeekApiError("AI_REQUEST_TIMEOUT", "DeepSeek 请求超时，请检查网络后重试。");
      throw new DeepSeekApiError("AI_NETWORK_ERROR", "无法连接 DeepSeek，请检查网络后重试。");
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    assertAvailable: () => keyStore.read(),
    async test(value) {
      const key = String(value || "").trim() || keyStore.read();
      await request({ key, messages: [{ role: "user", content: "请回复：连接正常" }], maxTokens: 8 });
      return {};
    },
    async draft({ task, result }) {
      const key = keyStore.read();
      const salutation = result.salutation?.type === "person" ? result.salutation.value : "";
      const payload = await request({
        key,
        messages: prompt({ salutation, script: String(task.script || "").trim() })
      });
      const draft = sanitizeAiMessage(payload.choices?.[0]?.message?.content || "");
      if (!draft) throw new DeepSeekApiError("AI_RESPONSE_INVALID", "DeepSeek 未返回可用文案，任务已暂停。");
      return { draft };
    }
  };
}

module.exports = { DEEPSEEK_MODEL, DeepSeekApiError, createDeepSeekClient, createDeepSeekKeyStore, maskApiKey, prompt };
