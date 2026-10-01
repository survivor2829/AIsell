const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { publicError } = require("./content-engine-ipc.cjs");

const failureCodes = [
  "auto_mix_voice_preview_unavailable", "auto_mix_voice_preview_outcome_unknown",
  "auto_mix_voice_outcome_unknown", "auto_mix_voice_invalid", "auto_mix_voice_write_failed",
  "auto_mix_voice_unavailable", "auto_mix_voice_persona_invalid",
  "cloud_request_failed", "cloud_request_rejected",
  "auto_mix_voice_download_failed", "cloud_response_invalid", "cloud_response_too_large",
  "provider_gateway_tls_not_configured", "provider_gateway_tls_invalid",
  "auto_mix_voice_preview_not_cached", "provider_usage_write_failed"
];

// Static guard: every code the engine raises while the user waits on a voice preview or
// voice design must reach the page (and the desktop notification) as its own message,
// never as "内容引擎暂时不可用，请重试。".
const engineDir = path.join(__dirname, "../../sidecars/content-engine/content_engine");
function pythonFunction(source, name) {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => new RegExp(`^\\s*def ${name}\\(`, "u").test(line));
  assert.ok(start >= 0, `${name} must exist`);
  const indent = lines[start].search(/\S/u);
  let end = start + 1;
  while (end < lines.length && !(lines[end].trim() && lines[end].search(/\S/u) <= indent && !/^\s*[)\]}#]/u.test(lines[end]))) end += 1;
  return lines.slice(start + 1, end).join("\n");
}
function raisedCodes(file, functions) {
  const source = fs.readFileSync(path.join(engineDir, file), "utf8");
  const body = functions === "*" ? source : functions.map((name) => pythonFunction(source, name)).join("\n");
  const raised = [...body.matchAll(/\bContentEngineError\(\s*([^,)\s]+)/gu)].map((match) => match[1]);
  const bounded = [...body.matchAll(/\b_read_bounded\([^,]+,[^,]+,\s*([^,)\s]+)/gu)].map((match) => match[1]);
  return [...raised, ...bounded].map((literal) => {
    const code = /^['"]([A-Za-z0-9_]+)['"]$/u.exec(literal)?.[1];
    assert.ok(code, `${file} raises a non-literal code ${literal}; map it explicitly`);
    return code;
  });
}
const voiceCodes = new Set([
  ...raisedCodes("provider_tls.py", "*"),
  ...raisedCodes("volcengine_tts.py", "*"),
  // The first definitions are the Bailian client's; the analyzer only forwards to them.
  ...raisedCodes("creative_analysis.py", ["synthesize_auto_mix_phrase", "design_auto_mix_voice", "_request_json"]),
  ...raisedCodes("creative_domain.py", ["preview_auto_mix_voice_persona", "design_auto_mix_voice_persona",
    "approve_auto_mix_voice_persona", "_auto_mix_voice_persona_row"]),
  // Every provider request journals itself first; a failed write stops the preview, design or generation.
  ...raisedCodes("provider_usage.py", ["_append_event"])
]);
for (const expected of ["provider_gateway_tls_invalid", "provider_gateway_tls_not_configured", "auto_mix_voice_download_failed",
  "cloud_response_too_large", "auto_mix_voice_preview_outcome_unknown", "auto_mix_voice_persona_invalid",
  "auto_mix_voice_preview_not_cached", "provider_usage_write_failed"]) {
  assert.ok(voiceCodes.has(expected), `the voice preview scan must see ${expected}`);
}
assert.deepEqual([...voiceCodes].filter((code) => publicError({ code, message: "x" }).code !== code), [],
  "every voice preview or design error code needs a public message");

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

// The free replay's miss names the charge the other button carries; a failed usage
// record says what to check instead of reading as an engine outage.
assert.match(publicError({ code: "auto_mix_voice_preview_not_cached", message: "x" }).error, /已保存试听.*重新生成.*计费/u);
assert.match(publicError({ code: "provider_usage_write_failed", message: "x" }).error, /调用记录.*磁盘/u);

console.log("voice preview public error self-check passed");
