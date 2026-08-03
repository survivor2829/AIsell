const PRODUCT_DETAIL_CHANNELS = Object.freeze({
  status: "product-detail:status",
  start: "product-detail:start",
  restart: "product-detail:restart",
  stop: "product-detail:stop",
  update: "product-detail:update",
  downloadUpdate: "product-detail:download-update"
});

const PUBLIC_STATES = new Set([
  "starting",
  "ready",
  "failed",
  "stopped",
  "unavailable"
]);

const PUBLIC_ERRORS = Object.freeze({
  PRODUCT_DETAIL_RUNTIME_UNAVAILABLE: "产品详情图服务尚未安装或未配置。",
  PRODUCT_DETAIL_DATA_DIR_INVALID: "产品详情图数据目录配置无效。",
  PRODUCT_DETAIL_DATA_DIR_FAILED: "产品详情图数据目录无法创建。",
  PRODUCT_DETAIL_PROVIDER_CONFIG_FAILED: "产品详情图 AI 配置无法读取，请在 API密钥 页面重新保存。",
  PRODUCT_DETAIL_SPAWN_FAILED: "产品详情图服务启动失败，请重试。",
  PRODUCT_DETAIL_READY_INVALID: "产品详情图服务返回了无效的启动信息。",
  PRODUCT_DETAIL_START_TIMEOUT: "产品详情图服务启动超时，请重试。",
  PRODUCT_DETAIL_EXITED: "产品详情图服务已意外停止，请重试。"
});

function publicStatus(value = {}) {
  const state = PUBLIC_STATES.has(value.state) ? value.state : "failed";
  const capabilities = {};
  if (value.capabilities && typeof value.capabilities === "object") {
    for (const [key, enabled] of Object.entries(value.capabilities)) {
      if (/^[a-z0-9_-]{1,64}$/i.test(key) && typeof enabled === "boolean") {
        capabilities[key] = enabled;
      }
    }
  }
  const code = Object.hasOwn(PUBLIC_ERRORS, value.code) ? value.code : "";
  return {
    state,
    available: value.available === true,
    origin: state === "ready" ? String(value.origin || "") : "",
    bootstrapUrl: state === "ready" ? String(value.bootstrapUrl || "") : "",
    version: String(value.version || "").slice(0, 64),
    capabilities,
    code
  };
}

function publicError(error) {
  const suppliedCode = String(error?.code || "");
  if (Object.hasOwn(PUBLIC_ERRORS, suppliedCode)) {
    return {
      ok: false,
      code: suppliedCode,
      error: PUBLIC_ERRORS[suppliedCode]
    };
  }
  return {
    ok: false,
    code: "PRODUCT_DETAIL_FAILED",
    error: "产品详情图服务暂时不可用，请重试。"
  };
}

function registerProductDetailIpc(options = {}) {
  const ipcMain = options.ipcMain || require("electron").ipcMain;
  const controller = options.controller;
  const getMainWindow = typeof options.getMainWindow === "function"
    ? options.getMainWindow
    : () => null;

  function invoke(method) {
    return async () => {
      try {
        return { ok: true, data: publicStatus(await controller[method]()) };
      } catch (error) {
        return publicError(error);
      }
    };
  }

  ipcMain.handle(PRODUCT_DETAIL_CHANNELS.status, invoke("status"));
  ipcMain.handle(PRODUCT_DETAIL_CHANNELS.start, invoke("start"));
  ipcMain.handle(PRODUCT_DETAIL_CHANNELS.restart, invoke("restart"));
  ipcMain.handle(PRODUCT_DETAIL_CHANNELS.stop, invoke("stop"));

  const unsubscribe = controller.onUpdate((status) => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.webContents.send(
        PRODUCT_DETAIL_CHANNELS.update,
        publicStatus(status)
      );
    } catch {
      // Window teardown races must not affect the local service.
    }
  });

  return {
    dispose() {
      if (typeof unsubscribe === "function") unsubscribe();
    }
  };
}

module.exports = {
  PRODUCT_DETAIL_CHANNELS,
  publicError,
  publicStatus,
  registerProductDetailIpc
};
