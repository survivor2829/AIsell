const path = require("node:path");
const { createProductVideoService } = require("./product-video-service.cjs");
const { cleanMessage, fail } = require("./digital-human-provider.cjs");

const CHANNELS = Object.freeze(Object.fromEntries(
  ["capabilities", "import-image", "import-facts", "create", "list", "get", "start", "retry-shot", "refresh", "media", "shot-media", "image-media", "confirm-sheet", "redo-sheet", "confirm-scene", "redo-scene", "redo-shot", "update-shot", "confirm-storyboard", "export", "export-source"]
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
    "import-facts": async () => {
      const window = getMainWindow();
      const settings = { title: "选择产品卖点和参数资料", properties: ["openFile"], filters: [{ name: "UTF-8产品资料", extensions: ["txt"] }] };
      const result = await (window ? dialog.showOpenDialog(window, settings) : dialog.showOpenDialog(settings));
      return result.canceled || !result.filePaths?.[0] ? null : service.importFacts(result.filePaths[0]);
    },
    // 有人剧情 left the page (user 2026-11-27); older 剧情 tasks still finish in the service.
    create: (payload) => { if (payload?.style === 'story') throw fail('product_video_invalid_input', '场景效果视频只做无人实拍。'); return service.create(payload); },
    list: () => service.list(),
    get: (payload) => service.get(idOf(payload)),
    start: (payload) => service.start(idOf(payload)),
    "retry-shot": (payload) => service.retryShot(idOf(payload)),
    refresh: (payload) => service.refresh(idOf(payload)),
    media: (payload) => service.media(idOf(payload)),
    "confirm-sheet": (payload) => service.confirmSheet(idOf(payload)),
    "redo-sheet": (payload) => service.redoSheet(idOf(payload)),
    "confirm-scene": (payload) => service.confirmScene(idOf(payload)),
    "redo-scene": (payload) => service.redoScene(idOf(payload)),
    "redo-shot": (payload) => {
      if (!Number.isInteger(payload.index) || payload.index < 0 || payload.index > 20) throw fail("product_video_invalid_input", "请刷新页面后重试。");
      return service.redoShot(idOf(payload), payload.index);
    },
    // real-3 storyboard: change one shot (action, camera, caption); a new action or camera redraws its keyframe.
    "update-shot": (payload) => {
      if (!Number.isInteger(payload.index) || payload.index < 0 || payload.index > 20) throw fail("product_video_invalid_input", "请刷新页面后重试。");
      const change = payload.change;
      if (!change || typeof change !== "object" || Array.isArray(change) || Object.keys(change).some((key) => !["action", "camera", "caption"].includes(key))
        || Object.values(change).some((value) => typeof value !== "string" || value.length > 200)) throw fail("product_video_invalid_input", "请刷新页面后重试。");
      return service.updateShot(idOf(payload), payload.index, change);
    },
    "confirm-storyboard": (payload) => service.confirmStoryboard(idOf(payload)),
    "image-media": (payload) => {
      if (!/^(?:sheet|scene|floor|plate|person_[ab]|grid_\d{1,2}|key_\d{1,2})$/u.test(String(payload.key || ""))) throw fail("product_video_invalid_input", "请刷新页面后重试。");
      return service.imageMedia(idOf(payload), payload.key);
    },
    "shot-media": (payload) => {
      if (!Number.isInteger(payload.index) || payload.index < 0 || payload.index > 20) throw fail("product_video_invalid_input", "请刷新页面后重试。");
      return service.shotMedia(idOf(payload), payload.index);
    },
    export: async (payload) => {
      const id = idOf(payload), window = getMainWindow();
      const settings = { title: "导出产品视频", defaultPath: path.join(options.defaultExportDir || "", `AI短视频获客-${id}.mp4`),
        filters: [{ name: "MP4 视频", extensions: ["mp4"] }] };
      const result = await (window ? dialog.showSaveDialog(window, settings) : dialog.showSaveDialog(settings));
      return result.canceled || !result.filePath ? null : service.exportVideo(id, result.filePath);
    },
    "export-source": async (payload) => {
      const id = idOf(payload), window = getMainWindow();
      const resolution = service.get(id).plan?.sourceResolution || 'source';
      const settings = { title: "导出生成母版", defaultPath: path.join(options.defaultExportDir || "", `场景效果-${id}-${resolution}.mp4`), filters: [{ name: "MP4视频", extensions: ["mp4"] }] };
      const result = await (window ? dialog.showSaveDialog(window, settings) : dialog.showSaveDialog(settings));
      return result.canceled || !result.filePath ? null : service.exportSource(id, result.filePath);
    }
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(CHANNELS[name], async (event, payload = {}) => {
      try {
        const window = getMainWindow();
        if (!window?.webContents || event.sender !== window.webContents || (event.senderFrame && event.senderFrame !== window.webContents.mainFrame)) {
          throw fail("product_video_untrusted_sender", "请在应用主窗口操作。");
        }
        if (["start", "retry-shot", "confirm-sheet", "redo-sheet", "confirm-scene", "redo-scene", "redo-shot", "update-shot", "confirm-storyboard"].includes(name)) await options.requireTrustedClick(event, payload, name);
        if (!["create", "import-image", "import-facts"].includes(name) && Object.keys(payload).some((key) => !["id", "clickToken", ...(name === "shot-media" || name === "redo-shot" ? ["index"] : name === "update-shot" ? ["index", "change"] : name === "image-media" ? ["key"] : [])].includes(key))) {
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
