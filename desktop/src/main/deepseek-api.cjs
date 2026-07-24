const fs = require("node:fs");
const path = require("node:path");
const { sanitizeAiMessage } = require("./ai-draft.cjs");
const { diagnostics } = require("./diagnostics.cjs");
const { writeFileAtomic } = require("./atomic-file.cjs");

const DEEPSEEK_ORIGIN = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const REQUEST_TIMEOUT_MS = 25_000;
const AUTO_REPLY_FALLBACK = "这个问题我帮您确认一下，稍后回复您。";
const TEMPORARY_REPLY_FAILURES = new Set(["AI_NETWORK_ERROR", "AI_REQUEST_TIMEOUT", "AI_RATE_LIMITED", "AI_REQUEST_FAILED"]);
const PAUSING_REPLY_FAILURES = new Set(["API_KEY_MISSING", "API_KEY_UNREADABLE", "API_KEY_INVALID", "SECURE_STORAGE_UNAVAILABLE", "AI_BALANCE_INSUFFICIENT", "AI_REQUEST_REJECTED"]);

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
      throw new DeepSeekApiError("API_KEY_UNREADABLE", "已保存的 DeepSeek API Key 无法在当前 Windows 用户下解密，请重新填写。");
    }
  }

  return {
    status() {
      if (!encryptionAvailable()) {
        return {
          configured: false,
          maskedKey: "",
          code: "SECURE_STORAGE_UNAVAILABLE",
          error: "无法启用 Windows 账户加密存储，请检查当前 Windows 用户后重试。"
        };
      }
      if (!fs.existsSync(keyFile)) return { configured: false, maskedKey: "" };
      try {
        return { configured: true, maskedKey: maskApiKey(read()) };
      } catch (error) {
        return {
          configured: false,
          maskedKey: "",
          code: String(error?.code || "API_KEY_UNREADABLE"),
          error: String(error?.message || "已保存的 DeepSeek API Key 无法读取，请重新填写。")
        };
      }
    },
    read,
    write(value) {
      const key = String(value || "").trim();
      if (!key) throw new DeepSeekApiError("API_KEY_MISSING", "请输入 DeepSeek API Key。");
      if (!encryptionAvailable()) throw new DeepSeekApiError("SECURE_STORAGE_UNAVAILABLE", "无法启用 Windows 账户加密存储，请检查当前 Windows 用户后重试。");
      fs.mkdirSync(rootDir, { recursive: true });
      writeFileAtomic(keyFile, safeStorage.encryptString(key), { mode: 0o600 });
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

function replyPrompt({ context, expert, recovery = false }) {
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
2. 自动回复不得使用联系人姓名或昵称，不得从客户消息中猜测称呼；需要问候时只使用“您好”。
3. 在话术允许范围内先做专业判断，给出最相关方向和简短理由；缺少的信息可以通过一个关键问题确认时，继续由AI沟通。
4. 不编造话术文件中没有的价格、政策、承诺、活动、库存或身份。
5. 不索要验证码、密码、银行卡、身份证等敏感信息，不引导转账。
6. 按话术文件中的“意向判定”判断intent；intent与needsHuman分别判断，一般咨询、初步询价或愿意留下需求可以intent为true但needsHuman为false。
7. 可以通过一个关键问题继续判断时needsHuman为false；只有客户明确要求实时报价、下单、实时库存或必须人工承诺时needsHuman为true。话术文件明确规定必须核实的货期、合同、售后、预约等实时事实，客户主动要求人工，或话术资料确实无法可靠回答且继续澄清也不能解决时，也设为true并使用话术文件中的无法回答话术；文件未提供时回复“${AUTO_REPLY_FALLBACK}”。
8. 只输出一个JSON对象，不加Markdown或解释，字段必须完整：
{"reply":"发给客户的消息","intent":false,"intentReason":"","needsHuman":false,"handoffReason":""}${recovery ? "\n8. 当前为结构化恢复请求：必须输出非空、完整且可被JSON.parse解析的JSON对象。" : ""}`
    },
    {
      role: "system",
      content: `AI专家话术文件：\n${String(expert || "").trim()}`
    },
    ...messages
  ];
}

function completionChoice(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.choices) || !payload.choices.length) {
    throw new DeepSeekApiError("AI_RESPONSE_INVALID", "DeepSeek 返回的数据缺少有效的生成结果");
  }
  const choice = payload.choices[0];
  if (!choice || typeof choice !== "object" || !choice.message || typeof choice.message !== "object" || !("content" in choice.message)) {
    throw new DeepSeekApiError("AI_RESPONSE_INVALID", "DeepSeek 返回的数据结构不完整");
  }
  if (choice.message.content !== null && typeof choice.message.content !== "string") {
    throw new DeepSeekApiError("AI_RESPONSE_INVALID", "DeepSeek 返回的文案格式无效");
  }
  return {
    finishReason: String(choice.finish_reason || ""),
    content: choice.message.content === null ? "" : choice.message.content
  };
}

function validateUsableMessage(value, { emptyCode = "AI_RESPONSE_INVALID", emptyMessage, lengthMessage } = {}) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new DeepSeekApiError(emptyCode, emptyMessage || "DeepSeek 未返回可用文案");
  if (text.length < 2 || text.length > 260) {
    throw new DeepSeekApiError("AI_RESPONSE_LENGTH_INVALID", lengthMessage || "DeepSeek 返回的文案长度不符合发送要求");
  }
  const sanitized = sanitizeAiMessage(text);
  if (!sanitized) throw new DeepSeekApiError("AI_RESPONSE_INVALID", emptyMessage || "DeepSeek 未返回可用文案");
  return sanitized;
}

function parseReplyDecision(value) {
  const raw = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new DeepSeekApiError("AI_RESPONSE_INVALID", "DeepSeek 未返回有效的结构化回复"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || typeof parsed.reply !== "string"
    || typeof parsed.intent !== "boolean"
    || typeof parsed.intentReason !== "string"
    || typeof parsed.needsHuman !== "boolean"
    || typeof parsed.handoffReason !== "string") {
    throw new DeepSeekApiError("AI_RESPONSE_INVALID", "DeepSeek 未返回完整的结构化回复");
  }
  const reply = sanitizeAutoReplySalutation(validateUsableMessage(parsed.reply, {
    emptyMessage: "DeepSeek 未返回可用回复",
    lengthMessage: "DeepSeek 返回的回复长度不符合发送要求"
  }));
  return {
    reply,
    intent: parsed.intent,
    intentReason: parsed.intentReason.trim().slice(0, 200),
    needsHuman: parsed.needsHuman,
    handoffReason: parsed.handoffReason.trim().slice(0, 200)
  };
}

function parseReplyPayload(payload) {
  const { finishReason, content } = completionChoice(payload);
  if (finishReason === "length") throw new DeepSeekApiError("AI_RESPONSE_TRUNCATED", "DeepSeek 返回的结构化回复被截断");
  if (finishReason === "content_filter") throw new DeepSeekApiError("AI_CONTENT_FILTERED", "DeepSeek 本次回复被安全策略拦截");
  if (finishReason && finishReason !== "stop") throw new DeepSeekApiError("AI_RESPONSE_INCOMPLETE", "DeepSeek 本次生成未完整结束");
  if (!content.trim()) throw new DeepSeekApiError("AI_RESPONSE_EMPTY", "DeepSeek 返回空内容");
  return parseReplyDecision(content);
}

function sanitizeAutoReplySalutation(value) {
  return String(value || "")
    .replace(/^(您好|你好)[，,\s]+[^，,。！？!?：:\n]{1,8}[，,]\s*/u, "$1，")
    .replace(/^[^，,。！？!?：:\n]{1,8}[，,]\s*(您好|你好)([！!。，,\s]*)/u, "$1$2")
    .trim();
}

function parsePlainPayload(payload, unavailableMessage) {
  const { finishReason, content } = completionChoice(payload);
  if (finishReason === "length") throw new DeepSeekApiError("AI_RESPONSE_TRUNCATED", "DeepSeek 返回的文案被截断");
  if (finishReason === "content_filter") throw new DeepSeekApiError("AI_CONTENT_FILTERED", "DeepSeek 本次文案被内容策略拦截");
  if (finishReason && finishReason !== "stop") throw new DeepSeekApiError("AI_RESPONSE_INCOMPLETE", "DeepSeek 本次文案未完整结束");
  return validateUsableMessage(content, {
    emptyCode: "AI_RESPONSE_EMPTY",
    emptyMessage: unavailableMessage,
    lengthMessage: "DeepSeek 返回的文案长度不符合发送要求"
  });
}

function replyFailureDiagnostic(error, attempt) {
  return `${attempt}:${error.code}`;
}

function fallbackReply(diagnostics, pauseReason = "") {
  const failureSummary = diagnostics.filter(Boolean).join("、");
  const warningCode = String(diagnostics.filter(Boolean).at(-1) || "AI_RESPONSE_INVALID").split(":").at(-1) || "AI_RESPONSE_INVALID";
  const reply = {
    reply: AUTO_REPLY_FALLBACK,
    intent: false,
    intentReason: "",
    needsHuman: true,
    handoffReason: `DeepSeek连续未生成可靠回复${failureSummary ? `（${failureSummary}）` : ""}，请查看客户需求`,
    aiWarningCode: warningCode,
    aiWarning: `DeepSeek 本次未生成可靠回复（${warningCode}），已发送兜底消息并提醒人工。`
  };
  return pauseReason
    ? { ...reply, pauseAfterHandoff: true, pauseReason: String(pauseReason).slice(0, 200) }
    : reply;
}

async function responseError(response) {
  if (response.status === 401 || response.status === 403) return new DeepSeekApiError("API_KEY_INVALID", "DeepSeek API Key 无效或已失效，请检查后重新填写。");
  if (response.status === 402) return new DeepSeekApiError("AI_BALANCE_INSUFFICIENT", "DeepSeek 账户余额不足，请充值后再试。");
  if (response.status === 408) return new DeepSeekApiError("AI_REQUEST_TIMEOUT", "DeepSeek 请求超时，请稍后重试。");
  if (response.status === 429) return new DeepSeekApiError("AI_RATE_LIMITED", "DeepSeek 请求过于频繁，请稍后再试。");
  if (response.status >= 500) return new DeepSeekApiError("AI_REQUEST_FAILED", "DeepSeek 服务暂时不可用，请稍后重试。");
  let text = "";
  try { text = JSON.stringify(await response.json()).toLowerCase(); } catch {}
  if (/insufficient_balance|余额不足/.test(text)) return new DeepSeekApiError("AI_BALANCE_INSUFFICIENT", "DeepSeek 账户余额不足，请充值后再试。");
  return new DeepSeekApiError("AI_REQUEST_REJECTED", "DeepSeek 拒绝了本次请求，请检查模型和请求配置。");
}

function createDeepSeekClient({ keyStore, fetchImpl = global.fetch, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  async function request({ key, messages, maxTokens = 180, responseFormat, disableThinking = false }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const operation = diagnostics().begin("deepseek", "chat_completion", {
      model: DEEPSEEK_MODEL,
      message_count: Array.isArray(messages) ? messages.length : 0,
      message_roles: Array.isArray(messages) ? messages.map((message) => String(message?.role || "")) : [],
      input_characters: Array.isArray(messages) ? messages.reduce((total, message) => total + String(message?.content || "").length, 0) : 0,
      max_tokens: maxTokens,
      response_format: responseFormat?.type || "plain",
      thinking_disabled: disableThinking,
      timeout_ms: requestTimeoutMs
    });
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
          ...(responseFormat ? { response_format: responseFormat } : {}),
          ...(disableThinking ? { thinking: { type: "disabled" } } : {})
        })
      });
      if (!response.ok) throw await responseError(response);
      try {
        const payload = await response.json();
        operation.end({
          ok: true,
          http_status: response.status,
          finish_reason: payload?.choices?.[0]?.finish_reason || "",
          output_characters: String(payload?.choices?.[0]?.message?.content || "").length,
          reasoning_characters: String(payload?.choices?.[0]?.message?.reasoning_content || "").length,
          prompt_tokens: Number(payload?.usage?.prompt_tokens) || 0,
          completion_tokens: Number(payload?.usage?.completion_tokens) || 0
        });
        return payload;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        throw new DeepSeekApiError("AI_RESPONSE_INVALID", "DeepSeek 返回的数据无法解析，请稍后重试。");
      }
    } catch (error) {
      if (error instanceof DeepSeekApiError) {
        operation.end({ ok: false, error }, { ok: false, code: error.code });
        throw error;
      }
      if (error?.name === "AbortError") {
        const failure = new DeepSeekApiError("AI_REQUEST_TIMEOUT", "DeepSeek 请求超时，请检查网络后重试。");
        operation.end({ ok: false, error: failure }, { ok: false, code: failure.code });
        throw failure;
      }
      const failure = new DeepSeekApiError("AI_NETWORK_ERROR", "无法连接 DeepSeek，请检查网络后重试。");
      operation.end({ ok: false, error: failure }, { ok: false, code: failure.code });
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  async function generateDraftWithKey(key, { task, result }) {
    const salutation = result?.salutation?.type === "person" ? result.salutation.value : "";
    const messages = prompt({ salutation, script: String(task?.script || "").trim() });
    let lastError;
    for (const maxTokens of [300, 600]) {
      try {
        const payload = await request({ key, messages, maxTokens, disableThinking: true });
        return { draft: parsePlainPayload(payload, "DeepSeek 未返回可用文案。") };
      } catch (error) {
        lastError = error;
        const recoverable = [
          "AI_RESPONSE_EMPTY",
          "AI_RESPONSE_TRUNCATED",
          "AI_RESPONSE_INCOMPLETE",
          "AI_RESPONSE_INVALID",
          "AI_RESPONSE_LENGTH_INVALID"
        ].includes(String(error?.code || ""));
        if (!recoverable || maxTokens === 600) throw error;
      }
    }
    throw lastError || new DeepSeekApiError("AI_RESPONSE_INVALID", "DeepSeek 未返回可用文案。");
  }

  async function generateReplyWithKey(key, { context, expert }, { strict = false } = {}) {
    if (!String(expert || "").trim()) throw new DeepSeekApiError("AI_EXPERT_MISSING", "请先在 AI专家 中添加话术文件。");
    const normalizedContext = (Array.isArray(context) ? context : []).filter((message) => String(message?.content || "").trim()).slice(-12);
    if (!normalizedContext.length || normalizedContext.at(-1)?.role !== "user") {
      throw new DeepSeekApiError("AI_CONTEXT_INVALID", "未读取到可靠的客户最新消息，自动回复已取消。");
    }
    const attempts = [
      { name: "json", maxTokens: 300, responseFormat: { type: "json_object" } },
      { name: "json-recovery", maxTokens: 600, responseFormat: { type: "json_object" }, recovery: true }
    ];
    const diagnostics = [];
    let lastError;
    for (let index = 0; index < attempts.length; index += 1) {
      const { name, recovery, ...options } = attempts[index];
      const messages = replyPrompt({ context: normalizedContext, expert, recovery });
      try {
        const payload = await request({ key, ...options, messages, disableThinking: true });
        return parseReplyPayload(payload);
      } catch (error) {
        lastError = error;
        const code = String(error?.code || "");
        const outputFailure = code.startsWith("AI_RESPONSE_") || code === "AI_CONTENT_FILTERED";
        const temporaryFailure = TEMPORARY_REPLY_FAILURES.has(code);
        const pausingFailure = PAUSING_REPLY_FAILURES.has(code);
        if (!(error instanceof DeepSeekApiError) || (!outputFailure && !temporaryFailure && !pausingFailure)) throw error;
        diagnostics.push(replyFailureDiagnostic(error, `${index + 1}/${name}`));
        if (strict && (pausingFailure || code === "AI_CONTENT_FILTERED" || temporaryFailure)) throw error;
        if (pausingFailure) return fallbackReply(diagnostics, error.message);
        if (code === "AI_CONTENT_FILTERED" || temporaryFailure) return fallbackReply(diagnostics);
      }
    }
    if (strict) throw lastError || new DeepSeekApiError("AI_RESPONSE_INVALID", "DeepSeek 未返回可用的结构化回复");
    return fallbackReply(diagnostics);
  }

  return {
    assertAvailable: () => keyStore.read(),
    async test(value) {
      const key = String(value || "").trim() || keyStore.read();
      const draft = await generateDraftWithKey(key, {
        task: { script: "您好，这是 DeepSeek 文案能力测试，请用一句自然问候回复。" },
        result: { salutation: { type: "person", value: "测试客户" } }
      });
      const reply = await generateReplyWithKey(key, {
        context: [{ role: "user", content: "你好，我想了解测试服务。" }],
        expert: "可礼貌介绍测试服务，并询问客户想了解哪一方面。"
      }, { strict: true });
      return {
        provider: "deepseek",
        model: DEEPSEEK_MODEL,
        capabilities: {
          activeTouch: { ok: true, outputLength: draft.draft.length },
          autoReply: { ok: true, outputLength: reply.reply.length }
        }
      };
    },
    async draft(input) {
      return generateDraftWithKey(keyStore.read(), input);
    },
    async reply(input) {
      let key;
      try {
        key = keyStore.read();
      } catch (error) {
        const code = String(error?.code || "");
        if (!PAUSING_REPLY_FAILURES.has(code)) throw error;
        return fallbackReply([replyFailureDiagnostic(error, "0/config")], error.message);
      }
      return generateReplyWithKey(key, input);
    }
  };
}

module.exports = { DEEPSEEK_MODEL, DeepSeekApiError, createDeepSeekClient, createDeepSeekKeyStore, maskApiKey, parsePlainPayload, parseReplyDecision, prompt, replyPrompt };
