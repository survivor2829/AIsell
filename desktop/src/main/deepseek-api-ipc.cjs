const { ipcMain } = require("electron");

function publicError(error) {
  return { ok: false, code: String(error?.code || "AI_REQUEST_FAILED"), error: String(error?.message || "DeepSeek 请求失败，请稍后重试。") };
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

module.exports = { registerDeepSeekApiIpc };
