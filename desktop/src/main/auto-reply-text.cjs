// Split out of auto-reply-ipc.cjs (2026-11-13), unchanged. See auto-reply-ipc.cjs for the controller.
const { AUTO_REPLY_ACTIONS, AUTO_REPLY_REASON_CODES } = require("./auto-reply-decision.cjs");

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function expertDocuments(store) {
  const expert = store?.read?.();
  const expertRules = String(expert?.expertRules?.text || "").trim();
  const businessKnowledge = String(expert?.businessKnowledge?.text || "").trim();
  if (expert?.ready !== true || !expertRules || !businessKnowledge) {
    throw codedError("AI_EXPERT_NOT_READY", "请先在 AI专家 中补齐专家规则和业务知识");
  }
  return { expertRules, businessKnowledge };
}

function replyLooksLikeAnotherQuestion(reply) {
  return /[?？]/u.test(reply)
    || /(?:请问|请提供|请说明|能否|是否|哪(?:个|些|种)?|什么|多少|如何|有没有|需要.{0,10}吗|方便.{0,10}吗)/u.test(reply);
}

function normalizeAutoReplyDecision(value, { clarificationAllowed = true } = {}) {
  const action = normalizeText(value?.action).toLowerCase();
  const reasonCode = normalizeText(value?.reasonCode).toLowerCase();
  const reply = normalizeText(value?.reply);
  if (!AUTO_REPLY_ACTIONS.has(action) || !AUTO_REPLY_REASON_CODES.has(reasonCode)) {
    throw codedError("AI_DECISION_INVALID", "DeepSeek 返回的自动回复动作无效");
  }
  if (action === "silent") {
    if (reply) throw codedError("AI_DECISION_INVALID", "DeepSeek 静默动作不应包含回复内容");
    return { action, reply: "", reasonCode };
  }
  if (!isSafeReplyText(reply)) throw codedError("AI_REPLY_UNSAFE", "DeepSeek 返回的回复未通过安全检查");
  if (action === "clarify" && !clarificationAllowed) {
    if (replyLooksLikeAnotherQuestion(reply)) {
      throw codedError("AI_CLARIFY_LIMIT_EXCEEDED", "DeepSeek 在已澄清一次后仍要求继续追问");
    }
    return { action: "answer", reply, reasonCode: "general_guidance" };
  }
  return { action, reply, reasonCode };
}

function containsSensitiveSecret(text) {
  return /验证码(?:是|为|[:：]|\s)*[0-9０-９]{4,8}/u.test(text)
    || /密码(?:是|为|[:：]|\s)+[^\s，。！？,!?]{4,32}/u.test(text)
    || /密码(?=[^\s，。！？,!?]{4,32}(?=$|[\s，。！？,!?]))(?=[^\s，。！？,!?]*[A-Za-z0-9])[^\s，。！？,!?]{4,32}/u.test(text)
    || /(?:银行卡|卡号)(?:号)?(?:是|为|[:：]|\s)*[0-9０-９][0-9０-９\s-]{11,24}/u.test(text)
    || /身份证(?:号)?(?:是|为|[:：]|\s)*[0-9０-９][0-9０-９XxＸｘ\s-]{13,20}/u.test(text);
}

function requestsSensitiveSecret(text, strict = false) {
  return text.split(/[，,。；;！？!?]/u).some((clause) => {
    if (/(?:不要|无需|不必|切勿|请勿)(?:您|向任何人)?(?:发|发送|提供|告诉|填写|输入|提交|上传).{0,12}(?:验证码|密码|银行卡|身份证)/u.test(clause)
      || /(?:不要|无需|不必|切勿|请勿)(?:把|将)?(?:验证码|密码|银行卡|身份证).{0,8}(?:发|发送|提供|告诉|填写|输入|提交|上传)/u.test(clause)) return false;
    if (strict) {
      return /(?:发|发送|提供|告诉|填写|输入|提交|上传).{0,12}(?:验证码|密码|银行卡|身份证)|(?:验证码|密码|银行卡|身份证).{0,12}(?:发|发送|提供|告诉|填写|输入|提交|上传)/u.test(clause);
    }
    return /(?:请|麻烦|需要).{0,16}(?:验证码|密码|银行卡|身份证).{0,12}(?:发|提供|告诉|填写|输入)/u.test(clause)
      || /(?:请|麻烦|需要).{0,12}(?:发|提供|告诉|填写|输入).{0,12}(?:验证码|密码|银行卡|身份证)/u.test(clause);
  });
}

function isReplyableText(value) {
  const text = normalizeText(value);
  if (!text || text.length > 500) return false;
  if (/^\[(图片|语音|文件|视频|表情|位置|小程序|链接|红包|转账)\]$/u.test(text)) return false;
  if (/(撤回了一条消息|以上是打招呼的内容|你已添加了|系统消息)/u.test(text)) return false;
  if (containsSensitiveSecret(text) || requestsSensitiveSecret(text)) return false;
  return true;
}

function requestsPayment(text) {
  return text.split(/[，,。；;！？!?]/u).some((clause) =>
    /(?:请|请您|需要您|您可以|可以|先|直接|立即|马上|务必|建议您).{0,12}(?:支付|转账|汇款|打款|付(?:款|定金|订金))|(?:支付|转账|汇款|打款).{0,8}(?:到|至|给|进|以下|账户|收款码|链接)|(?:扫码|点击).{0,8}(?:支付|付款|转账|收款码|付款链接|支付链接)/u.test(clause)
  );
}

function isSafeReplyText(value) {
  const text = normalizeText(value);
  if (!isReplyableText(text) || requestsSensitiveSecret(text, true)) return false;
  return !requestsPayment(text);
}

function safeContextSuffix(context) {
  let start = 0;
  for (let index = 0; index < context.length; index += 1) {
    if (!isReplyableText(context[index].content)) start = index + 1;
  }
  return context.slice(start);
}

module.exports = {
  normalizeText,
  codedError,
  expertDocuments,
  replyLooksLikeAnotherQuestion,
  normalizeAutoReplyDecision,
  containsSensitiveSecret,
  requestsSensitiveSecret,
  isReplyableText,
  requestsPayment,
  isSafeReplyText,
  safeContextSuffix
};
