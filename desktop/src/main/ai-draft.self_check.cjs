const assert = require("node:assert/strict");
const {
  contactSalutation, timeGreeting, greetingForContact, fillRespectfulTemplate,
  generateFixedScriptFallback, generatePersonalizedDraft, sanitizeAiMessage
} = require("./ai-draft.cjs");

async function main() {
  const strictTitles = [
    ["湛江港濠酒店黄总", "黄总"],
    ["陈东海", "陈总"], ["张三", "张总"], ["刘国强总", "刘总"], ["王建国经理", "王经理"], ["欧阳娜娜", "欧阳总"], ["万科物业-陈东海", "陈总"],
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
    "苏州陈总", "万科李总", "苏州聂总", "郑州翟总经理",
    "关小龙总", "白酒老板", "高校老师", "万达经理", "李总-财务小刘", "王总 媳妇",
    "东方证券经理", "项目经理", "车间主任", "班主任", "居委会主任", "常务副总",
    "大老板", "Tony王总", "王总(华东)", "介绍人：王总", "王总的助理", "李副总",
    "小王总", "欧阳总", "付总", "XX公司 付总经理", `王总${" ".repeat(65)}`
  ];
  for (const remark of strictGeneric) {
    assert.deepEqual(contactSalutation({ remark }), { type: "generic", value: "" }, remark);
  }
  for (const contact of [
    { remark: "", nickname: "王总" }, { remark: "客户A", nickname: "王总" },
    { name: "黄佳佳" },
    { nickname: "产品服务顾问森妮19101706971" }, { remark: "上海星辰科技13800138000" }
  ]) {
    assert.deepEqual(contactSalutation(contact), { type: "generic", value: "" });
  }
  for (const [hour, expected] of [[4, "您好"], [8, "早上好"], [12, "中午好"], [16, "下午好"], [20, "晚上好"], [23, "您好"]]) {
    assert.equal(timeGreeting(new Date(2026, 8, 23, hour)), expected);
  }
  assert.equal(fillRespectfulTemplate("给您介绍设备。", { remark: "陈东海" }, new Date(2026, 9, 8, 9)), "陈总，早上好，给您介绍设备。");
  const morning = new Date(2026, 8, 23, 8);
  assert.equal(greetingForContact({ remark: 'A测试客户' }, morning), '早上好');
  assert.equal(greetingForContact({ remark: '星辰客户经理炎燃19946167505' }, morning), '早上好');
  for (const remark of ['江门博雍汇灿总', '深圳客户追发票的']) {
    assert.equal(greetingForContact({ remark }, morning), '早上好');
  }
  const body = '第一行业务信息  保留双空格\n第二行优惠[加油]\n\n第三行说明。';
  assert.equal(fillRespectfulTemplate('感谢{称呼}支持\n[加油]', { remark:'黄总' }, morning), '黄总，早上好，感谢黄总支持\n[加油]');
  assert.equal(fillRespectfulTemplate('感谢{称呼}支持', {}, morning), '早上好，感谢支持');
  assert.equal(fillRespectfulTemplate('{称呼}，您好，' + body, { remark: '湛江港濠酒店黄总' }, new Date(2026, 9, 22, 15)),
    '黄总，下午好，' + body);
  for (const opening of ['黄总，早上好！', '{称呼}\n下午好！']) {
    assert.equal(fillRespectfulTemplate(opening + '\n' + body, { remark:'湛江港濠酒店黄总' }, new Date(2026,9,22,15)),
      '黄总，下午好，\n' + body);
  }
  const original = await generatePersonalizedDraft({ client: { draft() { throw new Error('原文模式不应调用 AI'); } },
    task: { script: body }, result: { contact: { remark: '黄总' } } });
  assert.equal(original.message, `${greetingForContact({ remark: '黄总' })}，${body}`);
  assert.equal(original.usedAi, false);
  assert.ok(generateFixedScriptFallback({ task: { script: '正文\n'.repeat(150) }, result: { contact: {} } }).message.includes('\n'));
  assert.equal(greetingForContact({ remark: 'wxid_customer' }, morning), '早上好');
  assert.equal(greetingForContact({ remark: '13800138000' }, morning), '早上好');
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
    task: { script: "{称呼}，您好，想和您沟通一下设备需求。", aiPolish: true }, result: { contact }
  });
  assert.equal(valid.message.startsWith(greetingForContact(contact)), true);
  await assert.rejects(() => generatePersonalizedDraft({
    client: { async draft() { return { draft: "黄佳佳，您好，想和您沟通一下设备需求。" }; } },
    task: { script: "{称呼}，您好，想和您沟通一下设备需求。", aiPolish: true },
    result: { contact: { name: "黄佳佳" } }
  }), (error) => error.code === "AI_RESPONSE_INVALID");
  assert.equal(generateFixedScriptFallback({ task: { script: "" } }), null);
  console.log("ai-draft self-check passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
