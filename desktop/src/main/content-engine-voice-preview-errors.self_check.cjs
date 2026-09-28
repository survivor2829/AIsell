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

// Save/start rejections used to fall back to "内容引擎暂时不可用，请重试。", which hid
// an unapproved voice behind an apparent engine outage.
const genericFailure = publicError(Object.assign(new Error("x"), { code: "never_registered_code" }));
assert.deepEqual(genericFailure, { ok: false, code: "CONTENT_ENGINE_FAILED", error: "内容引擎暂时不可用，请重试。" });
const saveStartCodes = [
  "auto_mix_voice_persona_approval_required", "auto_mix_voice_persona_not_found", "invalid_voice_persona_id",
  "invalid_narrated_settings", "invalid_narrated_groups", "asset_archived", "invalid_asset_ids", "invalid_asset_id",
  "narrated_script_already_confirmed", "UPDATE_IN_PROGRESS", "CONTENT_ENGINE_METHOD_INVALID"
];
for (const code of saveStartCodes) {
  const result = publicError(Object.assign(new Error("private provider detail 403 C:\\Users\\secret\\draft.json"), { code }));
  assert.equal(result.ok, false);
  assert.equal(result.code, code, `${code} must keep its own code`);
  assert.notEqual(result.error, genericFailure.error, `${code} must not read as an engine outage`);
  assert.match(result.error, /[\u4e00-\u9fff]/u, `${code} must explain itself in Chinese`);
  assert.doesNotMatch(result.error, /private provider detail|403|secret|draft\.json|C:\\/u, `${code} must not leak internals`);
}
assert.match(publicError({ code: "auto_mix_voice_persona_approval_required", message: "请选择已试听批准的声音。" }).error,
  /尚未批准或批准已失效.*声音与配乐/u, "an unapproved voice must say what to do");
// Fixed Chinese settings messages from the engine name the actual field; code echoes,
// key names and paths fall back to the mapped text.
assert.equal(publicError({ code: "invalid_narrated_settings", message: "请选择至少一首配乐，或改为自动配乐。" }).error,
  "请选择至少一首配乐，或改为自动配乐。");
const mappedSettings = publicError({ code: "invalid_narrated_settings", message: "x" }).error;
for (const message of ["invalid_narrated_settings", "target_audience须为150字以内的文字。", "素材位于 C:\\Users\\secret", "\\\\server\\share"]) {
  assert.equal(publicError({ code: "invalid_narrated_settings", message }).error, mappedSettings);
}

console.log("voice preview public error self-check passed");
