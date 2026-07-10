const assert = require("node:assert/strict");
const { contactSalutation, sanitizeAiMessage } = require("./ai-draft.cjs");

async function main() {
  assert.deepEqual(contactSalutation({ remark: "张总" }), { type: "person", value: "张总" });
  assert.deepEqual(contactSalutation({ nickname: "示例轴承 万向轮" }), { type: "generic", value: "" });
  assert.equal(sanitizeAiMessage(" 张总，您好 "), "张总，您好");
  console.log("ai-draft self-check passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
