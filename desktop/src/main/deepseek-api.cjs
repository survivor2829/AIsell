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
    if (!fs.existsSync(keyFile)) throw new DeepSeekApiError("API_KEY_MISSING", "请先在 API密钥 中保存 DeepSeek API Key。");
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
  const baseScript = String(script || "").replaceAll("{称呼}", salutation || "").replace(/^，/, "");
  return [
    {
      role: "system",
      content: `你是微信一对一客户触达文案助手。请根据提供的基础话术，改写成一条可以直接发送给客户的完整微信消息。
要求：
1. 使用提供的称呼自然开场；没有明确姓名时只使用“您好”，不得编造姓名。
2. 保留基础话术中的核心业务、优惠信息和询问目的。
3. 不得增加基础话术中没有提供的价格、承诺、活动或客户信息。
4. 表达自然、简洁、有礼貌，不要像群发广告，不要过度营销。
5. 控制在50至90个汉字，以一个容易回复的问题结尾。
6. 自然加入2至3个与语义相关的Emoji，最少2个；优先放在问候后或业务亮点处，不得连续堆叠，不使用夸张、催促类表情。
7. 只输出最终文案，不解释、不编号、不加引号，不得输出称呼以外的联系人隐私。`
    },
    { role: "user", content: `客户称呼：${greeting}\n基础话术：${baseScript}` }
  ];
}

function replyPrompt({ context, expert }) {
  const messages = (Array.isArray(context) ? context : [])
    .slice(-12)
    .map((message) => ({
      role: message?.role === "assistant" ? "assistant" : "user",
      content: String(message?.content || "").trim()
    }))
    .filter((message) => message.content);
  return [
    {
      role: "system",
      content: `你是微信一对一客服回复助手。只根据AI专家话术文件和最近对话生成可直接发送的回复，并判断是否需要人工跟进。
要求：
1. 回复自然、礼貌、简短，不重复询问对话中已经回答过的信息。
2. 在话术允许范围内先做专业判断，给出最相关方向和简短理由；缺少的信息可以通过一个关键问题确认时，继续由AI沟通。
3. 不编造话术文件中没有的价格、政策、承诺、活动、库存或身份。
4. 不索要验证码、密码、银行卡、身份证等敏感信息，不引导转账。
5. 按话术文件中的“意向判定”判断intent；intent与needsHuman分别判断，一般咨询、初步询价或愿意留下需求可以intent为true但needsHuman为false。
6. 可以通过一个关键问题继续判断时needsHuman为false；只有客户明确要求实时报价、下单、实时库存或必须人工承诺时needsHuman为true。话术文件明确规定必须核实的货期、合同、售后、预约等实时事实，客户主动要求人工，或话术资料确实无法可靠回答且继续澄清也不能解决时，也设为true并使用话术文件中的无法回答话术；文件未提供时回复“这个问题我帮您确认一下，稍后回复您。”。
7. 只输出一个JSON对象，不加Markdown或解释，字段必须完整：
{"reply":"发给客户的消息","intent":false,"intentReason":"","needsHuman":false,"handoffReason":""}`
    },
    {
      role: "system",
      content: `AI专家话术文件：\n${String(expert || "").trim()}`
    },
    ...messages
  ];
}

function parseReplyDecision(value) {
  const raw = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new DeepSeekApiError("AI_RESPONSE_INVALID", "DeepSeek 未返回有效的结构化回复，自动回复已暂停。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || typeof parsed.reply !== "string"
    || typeof parsed.intent !== "boolean"
    || typeof parsed.intentReason !== "string"
    || typeof parsed.needsHuman !== "boolean"
    || typeof parsed.handoffReason !== "string") {
    throw new DeepSeekApiError("AI_RESPONSE_INVALID", "DeepSeek 未返回完整的结构化回复，自动回复已暂停。");
  }
  const reply = sanitizeAiMessage(parsed.reply);
  if (!reply) throw new DeepSeekApiError("AI_RESPONSE_INVALID", "DeepSeek 未返回可用回复，自动回复已暂停。");
  return {
    reply,
    intent: parsed.intent,
    intentReason: parsed.intentReason.trim().slice(0, 200),
    needsHuman: parsed.needsHuman,
    handoffReason: parsed.handoffReason.trim().slice(0, 200)
  };
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

function createDeepSeekClient({ keyStore, fetchImpl = global.fetch, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  async function request({ key, messages, maxTokens = 180, responseFormat }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(`${DEEPSEEK_ORIGIN}/chat/completions`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: DEEPSEEK_MODEL,
          messages,
          temperature: 0.4,
          max_tokens: maxTokens,
          ...(responseFormat ? { response_format: responseFormat, thinking: { type: "disabled" } } : {})
        })
      });
      if (!response.ok) throw await responseError(response);
      return await response.json();
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
    },
    async reply({ context, expert }) {
      if (!String(expert || "").trim()) throw new DeepSeekApiError("AI_EXPERT_MISSING", "请先在 AI专家 中添加话术文件。");
      const normalizedContext = (Array.isArray(context) ? context : []).filter((message) => String(message?.content || "").trim()).slice(-12);
      if (!normalizedContext.length || normalizedContext.at(-1)?.role !== "user") {
        throw new DeepSeekApiError("AI_CONTEXT_INVALID", "未读取到可靠的客户最新消息，自动回复已取消。");
      }
      const key = keyStore.read();
      const payload = await request({
        key,
        messages: replyPrompt({ context: normalizedContext, expert }),
        maxTokens: 300,
        responseFormat: { type: "json_object" }
      });
      return parseReplyDecision(payload.choices?.[0]?.message?.content || "");
    }
  };
}

module.exports = { DEEPSEEK_MODEL, DeepSeekApiError, createDeepSeekClient, createDeepSeekKeyStore, maskApiKey, parseReplyDecision, prompt, replyPrompt };
