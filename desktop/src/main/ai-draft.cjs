const COMMON_SURNAMES = "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉龚程邢裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴郁胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰雍桑寿通燕浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁";
const PERSON_TITLE_RE = /^[\u4e00-\u9fa5]{1,6}(总|姐|哥|老师|老板|经理|先生|女士|总监|主任)$/;
const COMPOUND_SURNAMES = /^(欧阳|司马|上官|诸葛|夏侯|东方|皇甫|尉迟|公孙|慕容|长孙|宇文|令狐|独孤|南宫|闻人|轩辕|澹台)/;
const GENERIC_ENTITY_SUFFIX_RE = /公司|集团|科技|商贸|实业|中心|工作室|门店|店铺|工厂|部门|团队|区域|部/gu;

function contactSalutation(contact) {
  for (const value of [contact?.remark, contact?.nickname]) {
    const text = String(value || "").normalize("NFKC");
    const match = text.match(/(?:^|[\s,，、;；:：_—-])([\u4e00-\u9fa5]{1,20})(总|经理|总监|主任|老师|老板)(?=$|[\s,，、;；:：_—-]|\d{6,})/u);
    if (!match) continue;
    const prefix = match[1];
    const boundaries = [...prefix.matchAll(GENERIC_ENTITY_SUFFIX_RE)];
    const lastBoundary = boundaries.at(-1);
    const name = lastBoundary ? prefix.slice(lastBoundary.index + lastBoundary[0].length) : prefix;
    const compound = name.match(COMPOUND_SURNAMES)?.[0] || "";
    if (name.length >= 1 && name.length <= (compound ? 4 : 3)) {
      const surname = compound || (COMMON_SURNAMES.includes(name[0]) ? name[0] : "");
      if (surname) return { type: "title", value: surname + match[2] };
    }
  }
  return { type: "generic", value: "" };
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
