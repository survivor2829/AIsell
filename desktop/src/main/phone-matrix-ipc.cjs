const { createPhoneMatrix } = require("./phone-matrix.cjs");

// 手机矩阵: the page reads the phone list, edits a phone's name / number / note / group, and gets
// updates as phones are plugged in or allow debugging.
function registerPhoneMatrixIpc({ ipcMain, dataDir, getMainWindow, options = {} }) {
  const matrix = createPhoneMatrix({ dataDir, ...options,
    onChange: (state) => { const window = getMainWindow(); if (window && !window.isDestroyed()) window.webContents.send("phone-matrix:update", state); } });
  const methods = {
    status: () => matrix.snapshot(),
    refresh: async () => { await matrix.poll(); return matrix.snapshot(); },
    update: (payload) => matrix.update(String(payload?.serial || ""), {
      ...(payload?.name !== undefined ? { name: payload.name } : {}), ...(payload?.note !== undefined ? { note: payload.note } : {}),
      ...(payload?.number !== undefined ? { number: payload.number } : {}), ...(payload?.group !== undefined ? { group: payload.group } : {})
    }),
    forget: (payload) => matrix.forget(String(payload?.serial || ""))
  };
  const channels = Object.keys(methods).map((name) => `phone-matrix:${name}`);
  for (const [name, method] of Object.entries(methods)) ipcMain.handle(`phone-matrix:${name}`, async (event, payload) => {
    const trusted = getMainWindow()?.webContents;
    if (!trusted || event.sender !== trusted) return { ok: false, code: "PHONE_IPC_FORBIDDEN", error: "当前页面无权操作手机矩阵。" };
    try { return { ok: true, state: await method(payload) }; }
    catch (error) { return { ok: false, code: error.code || "PHONE_OPERATION_FAILED", error: /^PHONE_/.test(String(error.code || "")) ? error.message : "操作未完成，请稍后重试。" }; }
  });
  matrix.start();
  return { matrix, dispose() { matrix.stop(); channels.forEach((channel) => ipcMain.removeHandler(channel)); } };
}

module.exports = { registerPhoneMatrixIpc };
