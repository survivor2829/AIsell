const PRODUCT_DETAIL_AI_SETTINGS_CHANNELS = Object.freeze({
  status: "product-detail-ai-settings:status",
  save: "product-detail-ai-settings:save",
  delete: "product-detail-ai-settings:delete",
  validate: "product-detail-ai-settings:validate"
});

const PUBLIC_ERRORS = Object.freeze({
  AI_SETTINGS_ROOT_INVALID: "产品详情图 AI 配置目录无效。",
  AI_SETTINGS_UNREADABLE: "产品详情图 AI 配置无法读取，请重新保存。",
  APIMART_API_KEY_INVALID: "APIMart API Key 格式无效，请重新填写。",
  APIMART_API_KEY_MISSING: "请先填写并保存 APIMart API Key。",
  APIMART_API_KEY_UNREADABLE: "已保存的 APIMart API Key 无法读取，请重新填写。",
  APIMART_BASE_URL_HTTPS_REQUIRED: "APIMart API 地址必须使用 HTTPS。",
  APIMART_BASE_URL_INVALID: "APIMart API 地址无效，请检查后重试。",
  APIMART_BASE_URL_MISSING: "请输入 APIMart API 地址。",
  SECURE_STORAGE_UNAVAILABLE: "无法启用 Windows 账户加密存储，请检查当前 Windows 用户后重试。"
});

function publicStatus(value = {}) {
  return {
    provider: "apimart",
    enabled: value.enabled === true,
    configured: value.configured === true,
    ready: value.ready === true,
    baseUrl: String(value.baseUrl || "").slice(0, 2048),
    model: String(value.model || "").slice(0, 128),
    secureStorageAvailable: value.secureStorageAvailable !== false,
    ...(value.valid === true ? { valid: true } : {}),
    ...(value.paidCallPerformed === false ? { paidCallPerformed: false } : {}),
    ...(Object.hasOwn(PUBLIC_ERRORS, String(value.code || ""))
      ? {
        code: String(value.code),
        error: PUBLIC_ERRORS[String(value.code)]
      }
      : {})
  };
}

function publicError(error) {
  const code = String(error?.code || "AI_SETTINGS_FAILED");
  if (Object.hasOwn(PUBLIC_ERRORS, code)) {
    return { ok: false, code, error: PUBLIC_ERRORS[code] };
  }
  return {
    ok: false,
    code: "AI_SETTINGS_FAILED",
    error: "产品详情图 AI 配置保存失败，请重试。"
  };
}

function publicPayload(payload = {}) {
  const result = {};
  if (Object.hasOwn(payload, "apiKey")) result.apiKey = String(payload.apiKey || "");
  if (Object.hasOwn(payload, "baseUrl")) result.baseUrl = String(payload.baseUrl || "");
  if (Object.hasOwn(payload, "enabled")) result.enabled = payload.enabled === true;
  return result;
}

function registerProductDetailAiSettingsIpc(options = {}) {
  const ipcMain = options.ipcMain || require("electron").ipcMain;
  const store = options.store;
  const onChanged = typeof options.onChanged === "function"
    ? options.onChanged
    : () => undefined;
  if (!store) throw new TypeError("product detail AI settings store is required");

  function notifyChanged(action, result) {
    if (!action) return;
    try {
      const pending = onChanged({ action, status: publicStatus(result) });
      if (pending && typeof pending.catch === "function") pending.catch(() => undefined);
    } catch {
      // The configuration is already saved; sidecar restart errors stay isolated.
    }
  }

  function invoke(method, withPayload = false, changeAction = "") {
    return async (_event, payload = {}) => {
      try {
        const result = withPayload
          ? await store[method](publicPayload(payload))
          : await store[method]();
        notifyChanged(changeAction, result);
        return { ok: true, data: publicStatus(result) };
      } catch (error) {
        return publicError(error);
      }
    };
  }

  ipcMain.handle(PRODUCT_DETAIL_AI_SETTINGS_CHANNELS.status, invoke("status"));
  ipcMain.handle(PRODUCT_DETAIL_AI_SETTINGS_CHANNELS.save, invoke("save", true, "saved"));
  ipcMain.handle(PRODUCT_DETAIL_AI_SETTINGS_CHANNELS.delete, invoke("clear", false, "deleted"));
  ipcMain.handle(PRODUCT_DETAIL_AI_SETTINGS_CHANNELS.validate, invoke("validate", true));
}

module.exports = {
  PRODUCT_DETAIL_AI_SETTINGS_CHANNELS,
  publicError,
  publicStatus,
  registerProductDetailAiSettingsIpc
};
