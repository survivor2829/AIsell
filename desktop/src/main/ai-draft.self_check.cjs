const assert = require("node:assert/strict");
const {
  contactSalutation, timeGreeting, greetingForContact, fillRespectfulTemplate,
  generateFixedScriptFallback, generatePersonalizedDraft, sanitizeAiMessage
} = require("./ai-draft.cjs");

async function main() {
  const strictTitles = [
    ["王总", "王总"], ["李经理", "李经理"], ["曾总", "曾总"], ["王总经理", "王总"],
    ["王总13800138000", "王总"], ["王总 138 0013 8000", "王总"],
    ["万科物业-李总", "李总"], ["万科物业 李总", "李总"], ["保洁部 陈主任", "陈主任"],
    ["XX保洁公司 张经理", "张经理"], ["华润万家超市-王经理", "王经理"],
    ["方经理", "方经理"], ["高老师", "高老师"], ["马老板", "马老板"]
  ];
  for (const [remark, expected] of strictTitles) {
    assert.deepEqual(contactSalutation({ remark }), { type: "title", value: expected }, remark);
  }
  const strictGeneric = [
    "凯驰厂家经理", "洗地机厂家老板", "扫地车厂商经理", "洗地机厂方经理", "物业方经理",
    "万科物业方经理", "医院方主任", "便利店家老板", "凯驰店东老板", "工业园厂房经理",
    "城管市容经理", "物业和经理", "王总-客户公司", "王总 同学公司", "王总-行政部",
    "东方经理", "东方总", "南宫经理", "小熊经理", "国美 国总", "平安 平总",
    "东莞-东总", "成都 成总", "鱼老板", "米老板", "花老板", "水老板", "车老板", "房老板",
    "河南省代经理", "郑州市代老板", "代总经理", "XX公司代总经理", "王总 李经理",
    "王总/李总", "李经理 王总", "李经理(王总)", "李经理【王总】", "小李(王总)",
    "张伟 李总", "老张 李总", "王工 李总", "王董 李总", "小舅子 王总", "爸爸 王总",
    "嫂子 王总", "老板娘(张总)", "师母(王老师)", "保姆 王总", "保洁阿姨-王总",
    "店员-李老板", "业务员-王总", "文员 李经理", "跟单 李总", "徒弟 王老师",
    "学生 王老师", "家长 王老师", "李经理 上级:王总", "张总 跟进人:李经理",
    "来源：王总", "父亲:王总", "王总 by 李经理", "Assistant: 王总", "批发市场 米老板",
    "🐟 鱼老板", "㊎老板", "VIP-㊎老板", "河北 南宫经理", "王总(李经理)",
    "刘国强总", "王建国经理", "苏州陈总", "万科李总", "苏州聂总", "郑州翟总经理",
    "关小龙总", "白酒老板", "高校老师", "万达经理", "李总-财务小刘", "王总 媳妇",
    "东方证券经理", "项目经理", "车间主任", "班主任", "居委会主任", "常务副总",
    "大老板", "Tony王总", "王总(华东)", "介绍人：王总", "王总的助理", "李副总",
    "小王总", "欧阳总"
  ];
  for (const remark of strictGeneric) {
    assert.deepEqual(contactSalutation({ remark }), { type: "generic", value: "" }, remark);
  }
  for (const contact of [{ remark: "", nickname: "王总" }, { remark: "客户A", nickname: "王总" }]) {
    assert.deepEqual(contactSalutation(contact), { type: "generic", value: "" });
  }
  for (const [hour, expected] of [[4, "您好"], [8, "早上好"], [12, "中午好"], [16, "下午好"], [20, "晚上好"], [23, "您好"]]) {
    assert.equal(timeGreeting(new Date(2026, 8, 23, hour)), expected);
  }
  const morning = new Date(2026, 8, 23, 8);
  assert.equal(greetingForContact({ remark: "张总" }, morning), "张总，早上好");
  assert.equal(fillRespectfulTemplate("{称呼}，您好，请问近期是否需要设备支持？", { remark: "张总" }, morning),
    "张总，早上好，请问近期是否需要设备支持？");
  assert.equal(fillRespectfulTemplate("{称呼}，您好，请问近期是否需要设备支持？", { name: "黄佳佳" }, morning),
    "早上好，请问近期是否需要设备支持？");
  assert.equal(fillRespectfulTemplate("黄佳佳，您好，请问近期是否需要设备支持？", { name: "黄佳佳" }, morning),
    "早上好，请问近期是否需要设备支持？");
  assert.equal(sanitizeAiMessage(" 张总，您好 "), "张总，您好");

  const contact = { remark: "张总" };
  const fallback = generateFixedScriptFallback({
    task: { script: "{称呼}，您好，请问近期是否需要设备支持？" },
    result: { contact }, error: Object.assign(new Error("rate limited"), { code: "AI_RATE_LIMITED" })
  });
  assert.equal(fallback.message, `${greetingForContact(contact)}，请问近期是否需要设备支持？`);
  assert.equal(fallback.usedAi, false);
  assert.equal(fallback.fallbackCode, "AI_RATE_LIMITED");

  const valid = await generatePersonalizedDraft({
    client: { async draft({ result }) { return { draft: `${result.greeting}，想和您沟通一下设备需求。` }; } },
    task: { script: "{称呼}，您好，想和您沟通一下设备需求。" }, result: { contact }
  });
  assert.equal(valid.message.startsWith(greetingForContact(contact)), true);
  await assert.rejects(() => generatePersonalizedDraft({
    client: { async draft() { return { draft: "黄佳佳，您好，想和您沟通一下设备需求。" }; } },
    task: { script: "{称呼}，您好，想和您沟通一下设备需求。" },
    result: { contact: { name: "黄佳佳" } }
  }), (error) => error.code === "AI_RESPONSE_INVALID");
  assert.equal(generateFixedScriptFallback({ task: { script: "" } }), null);
  console.log("ai-draft self-check passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
