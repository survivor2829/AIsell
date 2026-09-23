const assert = require("node:assert/strict");
const {
  contactSalutation, timeGreeting, greetingForContact, fillRespectfulTemplate,
  generateFixedScriptFallback, generatePersonalizedDraft, sanitizeAiMessage
} = require("./ai-draft.cjs");

async function main() {
  assert.deepEqual(contactSalutation({ remark: "张总" }), { type: "title", value: "张总" });
  assert.deepEqual(contactSalutation({ remark: "李经理" }), { type: "title", value: "李经理" });
  for (const [remark, expected] of [
    ["刘国强总", "刘总"], ["王建国经理", "王经理"], ["张伟经理", "张经理"],
    ["保洁部陈主任", "陈主任"], ["王总", "王总"], ["李白老师", ""],
    ["物业管理公司总经理", ""], ["华东区域经理", ""], ["小李", ""], ["张三", ""],
    ["苏州陈总", ""], ["万科李总", ""], ["华为李总", ""],
    ["平安李经理", ""], ["高三王老师", ""], ["韩语李老师", ""],
    ["东区王经理", "王经理"], ["华东区王经理", "王经理"], ["上海张经理", "张经理"],
    ["恒大许总", "许总"], ["钢琴陈老师", "陈老师"], ["上海市张总", "张总"],
    ["项目经理", ""], ["高级经理", ""], ["车间主任", ""],
    ["居委会主任", ""], ["常务副总", ""], ["包子铺老板", ""],
    ["房产经理", ""], ["金牌经理", ""], ["华东经理", ""],
    ["王总 助理", ""], ["王总-司机", ""], ["介绍人：王总", ""],
    ["王总的助理", ""], ["王总经理", "王总"], ["张伟总经理", "张总"],
    ["物业管理公司王总经理", "王总"], ["欧阳娜娜总", "欧阳总"], ["司马光老师", "司马老师"],
    ["小王总", "王总"], ["老王总", "王总"], ["大刘总", ""],
    ["常玉林总", ""], ["聂小龙总", ""], ["张文龙总", ""],
    ["陈伟强总", "陈总"], ["王志刚老师", "王老师"], ["李副总", "李总"],
    ["王总13800138000", "王总"], ["客户-王总", "王总"], ["客户‑王总", "王总"], ["王总(华东)", ""],
    ["13800138000王总", ""], ["Tony王总", ""], ["曾总", "曾总"]
  ]) {
    assert.deepEqual(contactSalutation({ remark }), expected
      ? { type: "title", value: expected } : { type: "generic", value: "" }, remark);
  }
  for (const [contact, expected] of [
    [{ remark: "上海张经理", nickname: "房产经理" }, "张经理"],
    [{ remark: "小王总", nickname: "花店老板" }, "王总"],
    [{ remark: "客户A", nickname: "王总" }, ""],
    [{ remark: "", nickname: "王总" }, "王总"]
  ]) assert.deepEqual(contactSalutation(contact), expected
    ? { type: "title", value: expected } : { type: "generic", value: "" });
  for (const [remark, correctSurname] of [
    ["苏州陈总", "陈"], ["杭州李总", "李"], ["万科李总", "李"],
    ["华为李总", "李"], ["东区王经理", "王"], ["平安李经理", "李"],
    ["高三王老师", "王"], ["江苏张总", "张"], ["金地陈总", "陈"], ["国美黄总", "黄"]
  ]) {
    const salutation = contactSalutation({ remark });
    assert.ok(salutation.type === "generic" || salutation.value.startsWith(correctSurname), remark);
  }
  for (const contact of [
    { name: "黄佳佳" }, { remark: "欧阳娜娜" },
    { nickname: "产品服务顾问森妮19101706971" }, { remark: "上海星辰科技13800138000" }
  ]) assert.deepEqual(contactSalutation(contact), { type: "generic", value: "" });

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
