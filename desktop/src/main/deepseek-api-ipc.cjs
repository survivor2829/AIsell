const { ipcMain } = require("electron");
const { diagnostics } = require("./diagnostics.cjs");

function errorCategory(code) {
  if (["API_KEY_MISSING", "API_KEY_UNREADABLE", "API_KEY_INVALID", "SECURE_STORAGE_UNAVAILABLE"].includes(code)) return "configuration";
  if (code === "AI_NETWORK_ERROR") return "network";
  if (code === "AI_REQUEST_TIMEOUT") return "timeout";
  if (code === "AI_RATE_LIMITED") return "rate_limit";
  if (code === "AI_BALANCE_INSUFFICIENT") return "billing";
  if (["AI_REQUEST_FAILED", "AI_REQUEST_REJECTED"].includes(code)) return "http";
  if (code === "AI_RESPONSE_EMPTY") return "empty_content";
  if (code === "AI_RESPONSE_INVALID") return "parse_error";
  if (code === "AI_RESPONSE_LENGTH_INVALID") return "unusable_content";
  if (["AI_RESPONSE_TRUNCATED", "AI_RESPONSE_INCOMPLETE"].includes(code)) return "incomplete_content";
  if (code === "AI_CONTENT_FILTERED") return "filtered_content";
  return "provider";
}

function publicError(error) {
  const code = String(error?.code || "AI_REQUEST_FAILED");
  return { ok: false, code, category: errorCategory(code), error: String(error?.message || "DeepSeek 请求失败，请稍后重试。") };
}

function registerDeepSeekApiIpc({ keyStore, client } = {}) {
  ipcMain.handle("deepseek-api:status", () => {
    const result = { ok: true, data: keyStore.status() };
    diagnostics().event("deepseek", "key_status", { configured: result.data?.configured === true });
    return result;
  });
  ipcMain.handle("deepseek-api:save", (_event, payload = {}) => {
    const operation = diagnostics().begin("deepseek", "key_save", { apiKey: payload.apiKey });
    try {
      const result = { ok: true, data: keyStore.write(payload.apiKey) };
      operation.end({ ok: true, configured: result.data?.configured === true });
      return result;
    } catch (error) {
      operation.fail(error);
      return publicError(error);
    }
  });
  ipcMain.handle("deepseek-api:test", async (_event, payload = {}) => {
    const operation = diagnostics().begin("deepseek", "connection_test", { supplied_key: Boolean(payload.apiKey) });
    try {
      const result = { ok: true, data: await client.test(payload.apiKey) };
      operation.end({ ok: true, model: result.data?.model || "", reply_length: String(result.data?.reply || "").length });
      return result;
    } catch (error) {
      operation.fail(error);
      return publicError(error);
    }
  });
  ipcMain.handle("deepseek-api:delete", () => {
    const operation = diagnostics().begin("deepseek", "key_delete");
    try {
      const result = { ok: true, data: keyStore.clear() };
      operation.end({ ok: true });
      return result;
    } catch (error) {
      operation.fail(error);
      return publicError(error);
    }
  });
}

module.exports = { errorCategory, registerDeepSeekApiIpc };
