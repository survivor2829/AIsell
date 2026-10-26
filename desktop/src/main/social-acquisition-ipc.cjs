const fs = require("node:fs");
const { createSocialAcquisition } = require("./social-acquisition.cjs");

function registerSocialAcquisitionIpc({ ipcMain, dialog, shell, dataDir, accounts, getMainWindow, options = {} }) {
  let acquisition; let initializationError;
  try {
    if (!accounts) throw Object.assign(new Error("accounts unavailable"), { code: "ACQUIRE_ACCOUNTS_UNAVAILABLE" });
    acquisition = createSocialAcquisition({ dataDir, accounts, ...options,
      onChange: (state) => { const window = getMainWindow(); if (window && !window.isDestroyed()) window.webContents.send("social-acquisition:update", state); } });
  } catch (error) { initializationError = { ok: false, code: error.code || "ACQUIRE_UNAVAILABLE", error: error.code === "ACQUIRE_STATE_INVALID" ? error.message : "关键词获客暂时无法打开，请重新打开软件。" }; }
  const id = (payload) => String(payload?.id || "");
  const methods = {
    status: () => acquisition.snapshot(),
    saveTask: (payload) => acquisition.saveTask({
      id: payload?.id ? String(payload.id) : "", name: String(payload?.name || "").slice(0, 40), platform: String(payload?.platform || ""), accountId: String(payload?.accountId || ""),
      keywords: String(payload?.keywords || "").slice(0, 1000), intentWords: String(payload?.intentWords || "").slice(0, 600),
      days: Number(payload?.days), maxVideos: Number(payload?.maxVideos), allComments: payload?.allComments === true, skipAuthor: payload?.skipAuthor !== false
    }),
    removeTask: (payload) => acquisition.removeTask(id(payload)),
    start: (payload) => acquisition.start(id(payload)),
    stop: () => acquisition.stop(),
    setLead: (payload) => acquisition.setLead(id(payload), String(payload?.status || "")),
    // The file goes where the user picks; nothing is written without the save dialog.
    async exportCsv(payload) {
      const window = getMainWindow();
      const chosen = await dialog.showSaveDialog(window, { title: "导出线索", defaultPath: `关键词获客线索-${new Date().toISOString().slice(0, 10)}.csv`, filters: [{ name: "表格（CSV）", extensions: ["csv"] }] });
      if (chosen.canceled || !chosen.filePath) return { ...acquisition.snapshot(), exported: false };
      fs.writeFileSync(chosen.filePath, acquisition.csv(String(payload?.taskId || "")), "utf8");
      return { ...acquisition.snapshot(), exported: true };
    },
    // Only the lead's own video link on the platform is opened, in the user's default browser.
    async openLead(payload) {
      const lead = acquisition.snapshot().leads.find((item) => item.id === id(payload));
      if (!lead || !/^https:\/\/www\.kuaishou\.com\/short-video\/[A-Za-z0-9_-]+$/.test(lead.videoUrl)) throw Object.assign(new Error("这条线索的视频链接不可用。"), { code: "ACQUIRE_LINK_INVALID" });
      await shell.openExternal(lead.videoUrl);
      return acquisition.snapshot();
    }
  };
  const channels = Object.keys(methods).map((name) => `social-acquisition:${name}`);
  for (const [name, method] of Object.entries(methods)) ipcMain.handle(`social-acquisition:${name}`, async (event, payload) => {
    const trusted = getMainWindow()?.webContents;
    if (!trusted || event.sender !== trusted || event.senderFrame !== trusted.mainFrame) return { ok: false, code: "ACQUIRE_IPC_FORBIDDEN", error: "当前页面无权使用关键词获客。" };
    if (initializationError) return initializationError;
    try { return { ok: true, state: await method(payload) }; }
    catch (error) { return { ok: false, code: error.code || "ACQUIRE_OPERATION_FAILED", error: /^(ACQUIRE|SOCIAL)_/.test(String(error.code || "")) ? error.message : "操作未完成，已有记录保留，请稍后重试。", state: acquisition.snapshot() }; }
  });
  return { acquisition, isBusy: () => Boolean(acquisition?.isBusy()), async dispose() { channels.forEach((channel) => ipcMain.removeHandler(channel)); await acquisition?.dispose(); } };
}
module.exports = { registerSocialAcquisitionIpc };
