const TOP_SURNAMES = new Set("王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤");
const PERSON_TITLE_RE = /^[\u4e00-\u9fa5]{1,6}(总|姐|哥|老师|老板|经理|先生|女士|总监|主任)$/;
const SEP = String.raw`[\s,，、;；:：_·/|\p{Pd}−]`;
const ORG_END_RE = /(?:公司|集团|科技|商贸|实业|中心|工作室|门店|店铺|工厂|厂|店|部门|部|团队|物业|酒店|医院|学校|大厦|广场|有限|股份|超市|商场|银行|小区|园区|分公司|总部|办事处|事业部|项目部)$/u;
const RELATION_RE = /助理|秘书|司机|老公|老婆|爱人|太太|夫人|家属|儿子|女儿|介绍|推荐|朋友|同事|亲戚|的|媳妇|老板娘|嫂|来源|渠道|引荐|邀请|跟进|业务员|销售|客服|跟单|经办|录入|归属|上级|领导|决策|拍板|下属|员工|财务|会计|出纳|采购|前台|对接|店员|徒弟|学生|家长|保姆|阿姨|保安|文员|仓管|父|母|爸|妈|舅|侄|甥|婿|姐夫|妹夫|表|岳/u;
const SALUTATION_RE = new RegExp(String.raw`^(?:([一-龥A-Za-z0-9]+)${SEP}+)?([一-龥])(总经理|总监|总|经理|主任|老师|老板)(?:(${SEP}*\+?\d[\d\s-]*))?${SEP}*$`, "u");

function contactSalutation(contact) {
  const generic = { type: "generic", value: "" };
  const remark = String(contact?.remark || "").replace(/[\u3200-\u32ff\u2460-\u24ff]/gu, "").normalize("NFKC").trim();
  if (!remark || RELATION_RE.test(remark)) return generic;
  const match = remark.match(SALUTATION_RE);
  if (!match) return generic;
  if (match[1] && (match[1].length > 24 || !ORG_END_RE.test(match[1]))) return generic;
  if (match[4] && (match[4].match(/\d/gu) || []).length < 6) return generic;
  if (!TOP_SURNAMES.has(match[2])) return generic;
  return { type: "title", value: match[2] + (match[3] === "总经理" ? "总" : match[3]) };
}

function timeGreeting(at = new Date()) {
  const hour = at instanceof Date ? at.getHours() : NaN;
  if (!Number.isInteger(hour) || hour < 5 || hour >= 23) return "您好";
  if (hour < 11) return "早上好";
  if (hour < 13) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function greetingForContact(contact, at = new Date()) {
  const title = contactSalutation(contact);
  const greeting = timeGreeting(at);
  return title.type === "title" ? `${title.value}，${greeting}` : greeting;
}

function fillRespectfulTemplate(template, contact, at = new Date()) {
  const greeting = greetingForContact(contact, at);
  const source = String(template || "").trim();
  if (!source) return "";
  let message = source
    .replace(/\{称呼\}[，,、\s]*(?:您好|你好|早上好|中午好|下午好|晚上好)?[，,、\s]*/gu, `${greeting}，`)
    .replace(/\{称呼\}/gu, greeting);
  if (source.includes("{称呼}") || message.startsWith(greeting)) return message;
  const names = [contact?.name, contact?.remark, contact?.nickname]
    .map((value) => String(value || "").trim())
    .filter((value) => /^[\u4e00-\u9fa5]{2,4}$/u.test(value) && !PERSON_TITLE_RE.test(value));
  const opening = names.find((name) => message.startsWith(name));
  if (opening) message = message.slice(opening.length).replace(/^[，,、:：\s]*/u, "");
  message = message.replace(/^(您好|你好|早上好|中午好|下午好|晚上好)[，,、\s]*/u, "");
  return `${greeting}，${message}`;
}

function sanitizeAiMessage(content) {
  const text = String(content ?? "").replace(/\s+/g, " ").trim();
  return text.length >= 2 && text.length <= 260 ? text : "";
}

async function generatePersonalizedDraft({ client, task, result }) {
  const salutation = contactSalutation(result.contact);
  result.salutation = salutation;
  const greeting = greetingForContact(result.contact);
  const data = await client.draft({ task, result: { ...result, salutation, greeting } });
  const message = sanitizeAiMessage(data.draft);
  if (!message) throw new Error("DeepSeek 未返回可用文案。");
  if (!message.startsWith(greeting)
    || (result.contact?.name && String(result.contact.name).length >= 2
      && message.includes(String(result.contact.name))
      && String(result.contact.name) !== salutation.value)) {
    const error = new Error("DeepSeek 未按已确认称呼开场。");
    error.code = "AI_RESPONSE_INVALID";
    throw error;
  }
  return { message, usedAi: true, reason: "" };
}

function generateFixedScriptFallback({ task, result, error } = {}) {
  const script = String(task?.script || "").trim();
  if (!script) return null;
  let message = fillRespectfulTemplate(script, result?.contact);
  message = sanitizeAiMessage(message);
  if (!message) return null;
  const code = String(error?.code || "AI_GENERATION_FAILED");
  return {
    message,
    usedAi: false,
    fallbackCode: code,
    reason: `DeepSeek 文案生成失败（${code}），已使用用户确认的固定话术`
  };
}

module.exports = { contactSalutation, timeGreeting, greetingForContact, fillRespectfulTemplate, generateFixedScriptFallback, generatePersonalizedDraft, sanitizeAiMessage };
