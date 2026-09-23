const path = require("node:path");
const { createProductVideoService } = require("./product-video-service.cjs");
const { cleanMessage, fail } = require("./digital-human-provider.cjs");

const CHANNELS = Object.freeze(Object.fromEntries(
  ["capabilities", "import-image", "create", "list", "get", "start", "retry-shot", "refresh", "media", "export"]
    .map((name) => [name, `product-video:${name}`])
));
const ID = /^pv_[a-f0-9-]{36}$/u;
function registerProductVideoIpc(options = {}) {
  const { ipcMain, dialog, getMainWindow = () => null } = options;
  const service = options.service || createProductVideoService(options);
  const idOf = (payload) => {
    if (!ID.test(String(payload?.id || ""))) throw fail("product_video_invalid_id", "请重新选择视频任务。");
    return payload.id;
  };
  const handlers = {
    capabilities: () => service.capabilities(),
    "import-image": async () => {
      const window = getMainWindow();
      const settings = { title: "选择产品图片", properties: ["openFile"], filters: [{ name: "产品图片", extensions: ["jpg", "jpeg", "png", "webp"] }] };
      const result = await (window ? dialog.showOpenDialog(window, settings) : dialog.showOpenDialog(settings));
      return result.canceled || !result.filePaths?.[0] ? null : service.importImage(result.filePaths[0]);
    },
    create: (payload) => service.create(payload),
    list: () => service.list(),
    get: (payload) => service.get(idOf(payload)),
    start: (payload) => service.start(idOf(payload)),
    "retry-shot": (payload) => service.retryShot(idOf(payload)),
    refresh: (payload) => service.refresh(idOf(payload)),
    media: (payload) => service.media(idOf(payload)),
    export: async (payload) => {
      const id = idOf(payload), window = getMainWindow();
      const settings = { title: "导出产品视频", defaultPath: path.join(options.defaultExportDir || "", `AI获客-${id}.mp4`),
        filters: [{ name: "MP4 视频", extensions: ["mp4"] }] };
      const result = await (window ? dialog.showSaveDialog(window, settings) : dialog.showSaveDialog(settings));
      return result.canceled || !result.filePath ? null : service.exportVideo(id, result.filePath);
    }
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(CHANNELS[name], async (event, payload = {}) => {
      try {
        const window = getMainWindow();
        if (!window?.webContents || event.sender !== window.webContents || (event.senderFrame && event.senderFrame !== window.webContents.mainFrame)) {
          throw fail("product_video_untrusted_sender", "请在应用主窗口操作。");
        }
        if (["start", "retry-shot"].includes(name)) await options.requireTrustedClick(event, payload, name);
        if (!["create", "import-image"].includes(name) && Object.keys(payload).some((key) => !["id", "clickToken"].includes(key))) {
          throw fail("product_video_invalid_input", "请刷新页面后重试。");
        }
        return { ok: true, data: await handler(payload) };
      } catch (error) {
        return { ok: false, code: error.code || "product_video_operation_failed", error: cleanMessage(error.message || "操作未完成。") };
      }
    });
  }
  return { service, close: async () => {
    for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler(channel);
    service.close();
  } };
}
module.exports = { registerProductVideoIpc, CHANNELS };
