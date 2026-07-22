const { ipcMain } = require("electron");

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
  ipcMain.handle("deepseek-api:status", () => ({ ok: true, data: keyStore.status() }));
  ipcMain.handle("deepseek-api:save", (_event, payload = {}) => {
    try { return { ok: true, data: keyStore.write(payload.apiKey) }; } catch (error) { return publicError(error); }
  });
  ipcMain.handle("deepseek-api:test", async (_event, payload = {}) => {
    try { return { ok: true, data: await client.test(payload.apiKey) }; } catch (error) { return publicError(error); }
  });
  ipcMain.handle("deepseek-api:delete", () => {
    try { return { ok: true, data: keyStore.clear() }; } catch (error) { return publicError(error); }
  });
}

module.exports = { errorCategory, registerDeepSeekApiIpc };
