const TOP_SURNAMES = new Set("王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤");
const PERSON_TITLE_RE = /^[\u4e00-\u9fa5]{1,6}(总|姐|哥|老师|老板|经理|先生|女士|总监|主任)$/;
const SEP = String.raw`[\s,，、;；:：_·/|\p{Pd}−]`;
const ORG_END_RE = /(?:公司|集团|科技|商贸|实业|中心|工作室|门店|店铺|工厂|厂|店|部门|部|团队|物业|酒店|医院|学校|大厦|广场|有限|股份|超市|商场|银行|小区|园区|分公司|总部|办事处|事业部|项目部)$/u;
const RELATION_RE = /助理|秘书|司机|老公|老婆|爱人|太太|夫人|家属|儿子|女儿|介绍|推荐|朋友|同事|亲戚|的|媳妇|老板娘|嫂|来源|渠道|引荐|邀请|跟进|业务员|销售|客服|跟单|经办|录入|归属|上级|领导|决策|拍板|下属|员工|财务|会计|出纳|采购|前台|对接|店员|徒弟|学生|家长|保姆|阿姨|保安|文员|仓管|父|母|爸|妈|舅|侄|甥|婿|姐夫|妹夫|表|岳/u;
const SALUTATION_RE = new RegExp(String.raw`^(?:([一-龥A-Za-z0-9]+)${SEP}+)?([一-龥])(总经理|总监|总|经理|主任|老师|老板)(?:(${SEP}*\+?\d[\d\s-]*))?${SEP}*$`, "u");
const PERSON_REMARK_RE = new RegExp(String.raw`^(?:([一-龥A-Za-z0-9]+)${SEP}+)?([一-龥]{2,4}?)(总经理|总监|总|经理|主任|老师|老板)?(?:(${SEP}*\+?\d[\d\s-]*))?${SEP}*$`, "u");
const JOINED_ORG_TITLE_RE = new RegExp(String.raw`^([一-龥A-Za-z0-9]+)([一-龥])(总经理|总监|总|经理|主任|老师|老板)(?:(${SEP}*\+?\d[\d\s-]*))?${SEP}*$`, "u");
const ORG_ROLE_RE = /(?:厂方|店家|店东|厂房|院方|校方|资方|甲方|乙方|物业方|医院方)(?:总经理|总监|总|经理|主任|老师|老板)/u;
const COMPOUND_SURNAMES = new Set(["欧阳", "司马", "上官", "诸葛", "夏侯", "皇甫", "尉迟", "公孙", "慕容", "司徒", "司空"]);
const NON_PERSON_NAME_RE = /公司|集团|物业|中心|商贸|实业|有限|股份|银行|医院|酒店|广场|万达|[省市州县区厂店部校科酒]|经理|主任|老板|老师|先生|女士|总/u;

function contactSalutation(contact) {
  const generic = { type: "generic", value: "" };
  const rawRemark = String(contact?.remark || "");
  if (rawRemark.length > 64) return generic;
  const remark = rawRemark.replace(/[\u3200-\u32ff\u2460-\u24ff]/gu, "").normalize("NFKC").trim();
  if (!remark || RELATION_RE.test(remark)) return generic;
  const joined = !ORG_ROLE_RE.test(remark) && remark.match(JOINED_ORG_TITLE_RE);
  const strict = remark.match(SALUTATION_RE) || (joined && ORG_END_RE.test(joined[1]) ? joined : null);
  const match = strict || remark.match(PERSON_REMARK_RE);
  if (!match) return generic;
  if (match[1] && (match[1].length > 24 || !ORG_END_RE.test(match[1]))) return generic;
  if (match[4] && (match[4].match(/\d/gu) || []).length < 6) return generic;
  const person = match[2];
  const surname = COMPOUND_SURNAMES.has(person.slice(0, 2)) ? person.slice(0, 2) : person[0];
  if (!strict && (NON_PERSON_NAME_RE.test(person)
    || person.length <= surname.length || person.length > surname.length + 2
    || (match[3] && person.length !== surname.length + 2))) return generic;
  if (surname.length === 1 && !TOP_SURNAMES.has(surname)) return generic;
  return { type: "title", value: surname + (!match[3] || match[3] === "总经理" ? "总" : match[3]) };
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
  if (title.type === "title") return `${title.value}，${greeting}`;
  return greeting;
}

function fillRespectfulTemplate(template, contact, at = new Date()) {
  const greeting = greetingForContact(contact, at);
  const source = String(template || "");
  if (!source.trim()) return "";
  const title = contactSalutation(contact).value;
  let message = source.replace(/^[ \t\r\n]*\{称呼\}/u, '').replace(/\{称呼\}/gu, title);
  const names = [contact?.name, contact?.remark, contact?.nickname]
    .map((value) => String(value || "").trim())
    .filter((value) => /^[\u4e00-\u9fa5]{2,4}$/u.test(value) && !PERSON_TITLE_RE.test(value));
  const knownOpenings = [...new Set([title, ...names].filter(Boolean))]
    .map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const oldOpening = new RegExp(`^[，,、 \\t\\r\\n]*(?:(?:${knownOpenings.join('|') || '(?!)'})[，,、:： \\t\\r\\n]*)?(?:您好|你好|早上好|中午好|下午好|晚上好)[，,、！!。 \\t]*`, 'u');
  const withoutOpening = message.replace(oldOpening, '');
  if (withoutOpening !== message) return `${greeting}，${withoutOpening}`;
  const opening = names.find((name) => message.startsWith(name));
  if (opening) message = message.slice(opening.length).replace(/^[，,、:：\s]*/u, "");
  message = message.replace(/^[，,、 \t]*/u, '').replace(/^(您好|你好|早上好|中午好|下午好|晚上好)[，,、！!。 \t]*/u, "");
  return `${greeting}，${message}`;
}

// Conservative local guard; the installed WeChat version's boundary still
// requires explicit device acceptance. Do not reuse the 260-character AI cap.
const WECHAT_TEXT_LIMIT = 2000;
function validateTouchMessage(value) {
  const text = String(value ?? '');
  if (!text.trim() || text.length > WECHAT_TEXT_LIMIT) {
    const error = new Error(`触达话术为空或加上问候后超过单条保护上限 ${WECHAT_TEXT_LIMIT} 字符，请缩短话术后重试。`);
    error.code = 'TOUCH_MESSAGE_LENGTH_INVALID';
    throw error;
  }
  return text;
}

function sanitizeAiMessage(content) {
  const text = String(content ?? "").replace(/\s+/g, " ").trim();
  return text.length >= 2 && text.length <= 260 ? text : "";
}

async function generatePersonalizedDraft({ client, task, result }) {
  const salutation = contactSalutation(result.contact);
  result.salutation = salutation;
  const greeting = greetingForContact(result.contact);
  if (task?.aiPolish !== true) {
    return { message: validateTouchMessage(fillRespectfulTemplate(task?.script, result.contact)), usedAi: false, reason: '' };
  }
  const data = await client.draft({ task, result: { ...result, salutation, greeting } });
  const message = validateTouchMessage(String(data.draft ?? '').trim());
  if (!message) throw new Error("DeepSeek 未返回可用文案。");
  if (!message.startsWith(greeting)
    || (result.contact?.name && String(result.contact.name).length >= 2
      && message.includes(String(result.contact.name))
      && !greeting.startsWith(`${result.contact.name}，`)
      && String(result.contact.name) !== salutation.value)) {
    const error = new Error("DeepSeek 未按已确认称呼开场。");
    error.code = "AI_RESPONSE_INVALID";
    throw error;
  }
  return { message, usedAi: true, reason: "" };
}

function generateFixedScriptFallback({ task, result, error } = {}) {
  const script = String(task?.script || "");
  if (!script.trim()) return null;
  const message = validateTouchMessage(fillRespectfulTemplate(script, result?.contact));
  const code = String(error?.code || "AI_GENERATION_FAILED");
  return {
    message,
    usedAi: false,
    fallbackCode: code,
    reason: `DeepSeek 文案生成失败（${code}），已使用用户确认的固定话术`
  };
}

module.exports = { contactSalutation, timeGreeting, greetingForContact, fillRespectfulTemplate, generateFixedScriptFallback, generatePersonalizedDraft, sanitizeAiMessage, validateTouchMessage, WECHAT_TEXT_LIMIT };
