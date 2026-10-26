const { createSocialAccounts } = require("./social-accounts.cjs");

function registerSocialAccountsIpc({ ipcMain, dataDir, getMainWindow }) {
  let accounts; let initializationError;
  try {
    accounts = createSocialAccounts({ dataDir,
      onChange: (state) => { const window = getMainWindow(); if (window && !window.isDestroyed()) window.webContents.send("social-accounts:update", state); } });
  } catch (error) { initializationError = { ok: false, code: error.code || "SOCIAL_STORAGE_UNAVAILABLE", error: error.code ? error.message : "平台账号记录暂时无法打开，请检查数据目录后重试。" }; }
  const methods = {
    status: () => accounts.snapshot(),
    add: (payload) => accounts.add({ platform: String(payload?.platform || ""), label: payload?.label }),
    rename: (payload) => accounts.rename(String(payload?.id || ""), payload?.label),
    login: (payload) => accounts.login(String(payload?.id || "")),
    refresh: () => accounts.refresh(),
    remove: (payload) => accounts.remove(String(payload?.id || ""))
  };
  const channels = Object.keys(methods).map((name) => `social-accounts:${name}`);
  for (const [name, method] of Object.entries(methods)) ipcMain.handle(`social-accounts:${name}`, async (event, payload) => {
    const trusted = getMainWindow()?.webContents;
    if (!trusted || event.sender !== trusted || event.senderFrame !== trusted.mainFrame) return { ok: false, code: "SOCIAL_IPC_FORBIDDEN", error: "当前页面无权管理平台账号。" };
    if (initializationError) return initializationError;
    try { return { ok: true, state: await method(payload) }; }
    catch (error) { return { ok: false, code: error.code || "SOCIAL_OPERATION_FAILED", error: /^SOCIAL_/.test(String(error.code || "")) ? error.message : "操作未完成，已有账号保留，请稍后重试。", state: accounts.snapshot() }; }
  });
  return { accounts, async dispose() { channels.forEach((channel) => ipcMain.removeHandler(channel)); await accounts?.dispose(); } };
}
module.exports = { registerSocialAccountsIpc };
