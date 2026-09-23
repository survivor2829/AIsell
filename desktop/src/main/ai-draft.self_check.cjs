const assert = require("node:assert/strict");
const {
  contactSalutation, timeGreeting, greetingForContact, fillRespectfulTemplate,
  generateFixedScriptFallback, generatePersonalizedDraft, sanitizeAiMessage
} = require("./ai-draft.cjs");

async function main() {
  assert.deepEqual(contactSalutation({ remark: "张总" }), { type: "title", value: "张总" });
  assert.deepEqual(contactSalutation({ remark: "李经理" }), { type: "title", value: "李经理" });
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
