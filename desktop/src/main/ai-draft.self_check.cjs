const assert = require("node:assert/strict");
const { contactSalutation, generateFixedScriptFallback, sanitizeAiMessage } = require("./ai-draft.cjs");

async function main() {
  assert.deepEqual(contactSalutation({ remark: "张总" }), { type: "person", value: "张总" });
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
  assert.equal(generateFixedScriptFallback({ task: { script: "" } }), null);
  console.log("ai-draft self-check passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
