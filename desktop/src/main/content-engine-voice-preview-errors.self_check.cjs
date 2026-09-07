const assert = require("node:assert/strict");
const { publicError } = require("./content-engine-ipc.cjs");

const failureCodes = [
  "auto_mix_voice_preview_unavailable", "auto_mix_voice_preview_outcome_unknown",
  "auto_mix_voice_outcome_unknown", "auto_mix_voice_invalid", "auto_mix_voice_write_failed",
  "auto_mix_voice_unavailable", "auto_mix_voice_persona_invalid",
  "cloud_request_failed", "cloud_request_rejected"
];

assert.deepEqual(failureCodes.map((code) => {
  const result = publicError(Object.assign(new Error("private provider detail 403"), { code }));
  return {
    ok: result.ok,
    code: result.code,
    leakedDetail: /private provider detail|403/u.test(result.error),
    unknownStopsRetry: !code.endsWith("outcome_unknown") || result.error.includes("请勿重复提交")
  };
}), failureCodes.map((code) => ({ ok: false, code, leakedDetail: false, unknownStopsRetry: true })));

const businessMessage = "火山语音拒绝本次合成（代码 45000030），请检查音色权限、服务开通状态与额度。";
const adapterFailures = [
  ["cloud_request_rejected", businessMessage, "代码 45000030"],
  ["cloud_request_failed", "火山语音鉴权失败，请检查 API Key、服务开通与音色权限。（HTTP 403）", "HTTP 403"],
  ["cloud_request_failed", "火山语音额度不足或请求限流，请检查用量。（HTTP 429）", "HTTP 429"],
  ["cloud_request_failed", "火山语音未接受当前参数，请检查音色与模型是否匹配。（HTTP 400）", "HTTP 400"],
  ["cloud_request_failed", "火山语音服务请求失败，请稍后检查服务状态。（HTTP 503）", "HTTP 503"]
];
for (const [code, message, numericDetail] of adapterFailures) {
  const result = publicError(Object.assign(new Error(message), { code }));
  assert.equal(result.code, code);
  assert.ok(result.error.includes(numericDetail));
  for (const altered of [`secret ${message}`, `${message} secret`, `${message}\n`]) {
    const rejected = publicError(Object.assign(new Error(altered), { code }));
    assert.equal(rejected.code, code);
    assert.ok(!rejected.error.includes(numericDetail) && !rejected.error.includes("secret"));
  }
}
assert.ok(!publicError(Object.assign(new Error(businessMessage), {
  code: "cloud_request_failed"
})).error.includes("45000030"));

console.log("voice preview public error self-check passed");
