const { createKeywordAcquisitionController } = require("./keyword-acquisition.cjs");
const { createDouyinBrowserAdapter } = require("./douyin-browser-adapter.cjs");

function registerKeywordAcquisitionIpc({ ipcMain, BrowserWindow, session, dataDir, getMainWindow, expertStore, deepSeekClient }) {
  let controller; let initializationError;
  try {
    controller = createKeywordAcquisitionController({ dataDir, expertStore, deepSeekClient,
      onChange: (state) => { const window = getMainWindow(); if (window && !window.isDestroyed()) window.webContents.send("keyword-acquisition:update", state); } });
    const adapter = createDouyinBrowserAdapter({ BrowserWindow, session, partitionId: controller.partitionId,
      onStatus: controller.acceptBrowserStatus, onClose: () => controller.pause("抖音窗口已关闭，任务已暂停。") });
    controller.attachAdapter(adapter);
  } catch (error) { initializationError = { ok: false, code: error.code || "KEYWORD_STORAGE_UNAVAILABLE", error: error.code ? error.message : "关键词获客记录暂时无法打开，请检查数据目录后重试。" }; }
  const methods = {
    status: () => {},
    "save-task": (payload) => controller.saveTask(payload),
    "start-task": (payload) => controller.startTask(String(payload?.taskId || "")),
    stop: () => controller.pause(),
    "open-browser": () => controller.openBrowser(),
    "refresh-account": () => controller.refreshAccount(),
    "save-lead": (payload) => controller.saveLead(payload),
    "save-conversation": (payload) => controller.saveConversation(payload),
    "open-source": (payload) => controller.openSource(String(payload?.leadId || "")),
    "open-conversation": (payload) => controller.openConversation(String(payload?.leadId || "")),
    "sync-conversation": (payload) => controller.syncConversation(String(payload?.leadId || "")),
    "generate-draft": (payload) => controller.generateDraft(String(payload?.leadId || "")),
    "send-draft": (payload) => controller.sendDraft(String(payload?.leadId || ""))
  };
  const channels = Object.keys(methods).map((name) => `keyword-acquisition:${name}`);
  for (const [name, method] of Object.entries(methods)) ipcMain.handle(`keyword-acquisition:${name}`, async (event, payload) => {
    const trusted = getMainWindow()?.webContents;
    if (!trusted || event.sender !== trusted || event.senderFrame !== trusted.mainFrame) return { ok: false, code: "KEYWORD_IPC_FORBIDDEN", error: "当前页面无权操作关键词获客。" };
    if (initializationError) return initializationError;
    try { const result = await method(payload); return { ok: true, state: controller.snapshot(), result }; }
    catch (error) { return { ok: false, code: error.code || "KEYWORD_OPERATION_FAILED", error: error.code ? error.message : "操作未完成，已有记录已保留，请稍后重试。", state: controller.snapshot() }; }
  });
  return { ...controller, async dispose() { channels.forEach((channel) => ipcMain.removeHandler(channel)); await controller?.dispose(); } };
}

module.exports = { registerKeywordAcquisitionIpc };
