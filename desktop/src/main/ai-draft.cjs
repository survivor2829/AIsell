const COMMON_SURNAMES = "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉龚程邢裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴郁胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰雍桑寿通燕浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁";
const BUSINESS_WORDS = /(公司|工厂|物业|保洁|清洁|设备|轴承|万向轮|润滑油|售后|采购|客服|主管|经理|展会|会员|福利|厂家|产品|业务|团队|群|助手|文件传输|手机号|电话)/;
const PERSON_TITLE_RE = /^[\u4e00-\u9fa5](总|姐|哥|老师|老板|经理|先生|女士)$/;

function extractPersonalSalutation(value) {
  for (const token of String(value || "").trim().split(/[，,\s/|_()（）【】\[\]-]+/).filter(Boolean)) {
    if (BUSINESS_WORDS.test(token) || /\d{4,}/.test(token)) continue;
    if (PERSON_TITLE_RE.test(token)) return token;
    const clean = token.replace(/(先生|女士|老师|经理|老板|总)$/g, "");
    if (/^[\u4e00-\u9fa5]{2,4}$/.test(clean) && COMMON_SURNAMES.includes(clean[0])) return token;
  }
  return "";
}

function contactSalutation(contact) {
  const value = extractPersonalSalutation(contact?.remark) || extractPersonalSalutation(contact?.nickname || contact?.name);
  return value ? { type: "person", value } : { type: "generic", value: "" };
}

function sanitizeAiMessage(content) {
  const text = String(content ?? "").replace(/\s+/g, " ").trim();
  return text.length >= 2 && text.length <= 260 ? text : "";
}

async function generatePersonalizedDraft({ client, task, result }) {
  const salutation = contactSalutation(result.contact);
  const data = await client.draft({ task, result: { ...result, salutation } });
  const message = sanitizeAiMessage(data.draft);
  if (!message) throw new Error("DeepSeek 未返回可用文案，任务已暂停。");
  return { message, usedAi: true, reason: "" };
}

module.exports = { contactSalutation, generatePersonalizedDraft, sanitizeAiMessage };
