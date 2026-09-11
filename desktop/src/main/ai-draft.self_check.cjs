const assert = require("node:assert/strict");
const { contactSalutation, generateFixedScriptFallback, generatePersonalizedDraft, sanitizeAiMessage } = require("./ai-draft.cjs");

async function main() {
  assert.deepEqual(contactSalutation({ remark: "张总" }), { type: "person", value: "张总" });
  assert.deepEqual(contactSalutation({ remark: "客户设备采购", nickname: "设备采购", name: "黄佳佳" }), { type: "person", value: "黄佳佳" });
  assert.deepEqual(contactSalutation({ remark: "欧阳娜娜" }), { type: "person", value: "欧阳娜娜" });
  assert.deepEqual(contactSalutation({ nickname: "示例轴承 万向轮" }), { type: "generic", value: "" });
  assert.equal(sanitizeAiMessage(" 张总，您好 "), "张总，您好");
  assert.deepEqual(generateFixedScriptFallback({
    task: { script: "{称呼}，您好，请问近期是否需要设备支持？" },
    result: { contact: { remark: "张总" } },
    error: Object.assign(new Error("rate limited"), { code: "AI_RATE_LIMITED" })
  }), {
    message: "张总，您好，请问近期是否需要设备支持？",
    usedAi: false,
    fallbackCode: "AI_RATE_LIMITED",
    reason: "DeepSeek 文案生成失败（AI_RATE_LIMITED），已使用用户确认的固定话术"
  });
  assert.equal(generateFixedScriptFallback({
    task: { script: "{称呼}，您好，请问近期是否需要设备支持？" },
    result: { contact: { nickname: "示例轴承 万向轮" } },
    error: new Error("offline")
  }).message, "您好，请问近期是否需要设备支持？");
  const classified = await generatePersonalizedDraft({
    client: {
      async classifySalutation() { return { salutation: { value: "老王", source: "remark" } }; },
      async draft() { return { draft: "您好，想和您沟通一下设备需求。" }; }
    },
    task: { script: "{称呼}，您好，想和您沟通一下设备需求。" },
    result: { contact: { remark: "客户老王采购", nickname: "设备采购" } }
  });
  assert.equal(classified.message.startsWith("您好"), true, "an embedded model-selected fragment must fall back to the generic salutation");
  await assert.rejects(() => generatePersonalizedDraft({
    client: {
      async classifySalutation() { return { salutation: { value: "张总", source: "none" } }; },
      async draft() { return { draft: "张总，您好，想和您沟通一下设备需求。" }; }
    },
    task: { script: "{称呼}，您好，想和您沟通一下设备需求。" },
    result: { contact: { remark: "客户备注" } }
  }), (error) => error.code === "AI_RESPONSE_INVALID");
  await assert.rejects(() => generatePersonalizedDraft({
    client: { async draft() { return { draft: "张总监，您好，想和您沟通一下设备需求。" }; } },
    task: { script: "{称呼}，您好，想和您沟通一下设备需求。" },
    result: { contact: { remark: "张总" } }
  }), (error) => error.code === "AI_RESPONSE_INVALID");
  assert.equal(generateFixedScriptFallback({ task: { script: "" } }), null);
  console.log("ai-draft self-check passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
