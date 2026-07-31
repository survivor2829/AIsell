const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic, writeJsonAtomic } = require("./atomic-file.cjs");

const DEFAULT_APIMART_BASE_URL = "https://api.apimart.ai/v1";
const APIMART_MODEL = "gpt-image-2";
const SETTINGS_VERSION = 1;

class ProductDetailAiSettingsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function normalizeBaseUrl(value = DEFAULT_APIMART_BASE_URL) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new ProductDetailAiSettingsError(
      "APIMART_BASE_URL_MISSING",
      "请输入 APIMart API 地址。"
    );
  }
  if (raw.length > 2048) {
    throw new ProductDetailAiSettingsError(
      "APIMART_BASE_URL_INVALID",
      "APIMart API 地址无效，请检查后重试。"
    );
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ProductDetailAiSettingsError(
      "APIMART_BASE_URL_INVALID",
      "APIMart API 地址无效，请填写完整的 HTTPS 地址。"
    );
  }
  if (parsed.protocol !== "https:") {
    throw new ProductDetailAiSettingsError(
      "APIMART_BASE_URL_HTTPS_REQUIRED",
      "APIMart API 地址必须使用 HTTPS。"
    );
  }
  if (parsed.hostname !== "api.apimart.ai" || parsed.username || parsed.password) {
    throw new ProductDetailAiSettingsError(
      "APIMART_BASE_URL_INVALID",
      "APIMart API 地址必须使用官方域名 api.apimart.ai。"
    );
  }
  if (parsed.search || parsed.hash) {
    throw new ProductDetailAiSettingsError(
      "APIMART_BASE_URL_INVALID",
      "APIMart API 地址不能包含查询参数或锚点。"
    );
  }
  const pathname = parsed.pathname.replace(/\/+$/u, "");
  if (pathname !== "/v1") {
    throw new ProductDetailAiSettingsError(
      "APIMART_BASE_URL_INVALID",
      "APIMart API 地址路径必须为 /v1。"
    );
  }
  return DEFAULT_APIMART_BASE_URL;
}

function normalizeApiKey(value) {
  const apiKey = String(value || "").trim();
  if (!apiKey) {
    throw new ProductDetailAiSettingsError(
      "APIMART_API_KEY_MISSING",
      "请输入 APIMart API Key。"
    );
  }
  if (apiKey.length > 4096) {
    throw new ProductDetailAiSettingsError(
      "APIMART_API_KEY_INVALID",
      "APIMart API Key 格式无效，请重新填写。"
    );
  }
  return apiKey;
}

function createProductDetailAiSettingsStore({ rootDir, safeStorage } = {}) {
  const resolvedRoot = path.resolve(String(rootDir || ""));
  if (!rootDir || resolvedRoot === path.parse(resolvedRoot).root) {
    throw new ProductDetailAiSettingsError(
      "AI_SETTINGS_ROOT_INVALID",
      "产品详情图 AI 配置目录无效。"
    );
  }

  const settingsFile = path.join(resolvedRoot, "product-detail-ai-settings.json");
  const apiKeyFile = path.join(resolvedRoot, "product-detail-apimart-key.bin");
  const encryptionAvailable = () => Boolean(safeStorage?.isEncryptionAvailable?.());

  function defaultSettings() {
    return {
      version: SETTINGS_VERSION,
      provider: "apimart",
      enabled: false,
      baseUrl: DEFAULT_APIMART_BASE_URL,
      model: APIMART_MODEL
    };
  }

  function readSettings() {
    if (!fs.existsSync(settingsFile)) return defaultSettings();
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    } catch {
      throw new ProductDetailAiSettingsError(
        "AI_SETTINGS_UNREADABLE",
        "产品详情图 AI 配置无法读取，请重新保存。"
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ProductDetailAiSettingsError(
        "AI_SETTINGS_UNREADABLE",
        "产品详情图 AI 配置无法读取，请重新保存。"
      );
    }
    return {
      ...defaultSettings(),
      enabled: parsed.enabled === true,
      baseUrl: normalizeBaseUrl(parsed.baseUrl || DEFAULT_APIMART_BASE_URL)
    };
  }

  function readApiKey() {
    if (!encryptionAvailable()) {
      throw new ProductDetailAiSettingsError(
        "SECURE_STORAGE_UNAVAILABLE",
        "无法启用 Windows 账户加密存储，请检查当前 Windows 用户后重试。"
      );
    }
    if (!fs.existsSync(apiKeyFile)) {
      throw new ProductDetailAiSettingsError(
        "APIMART_API_KEY_MISSING",
        "请先保存 APIMart API Key。"
      );
    }
    try {
      return normalizeApiKey(safeStorage.decryptString(fs.readFileSync(apiKeyFile)));
    } catch (error) {
      if (error instanceof ProductDetailAiSettingsError
        && error.code === "APIMART_API_KEY_MISSING") {
        throw error;
      }
      throw new ProductDetailAiSettingsError(
        "APIMART_API_KEY_UNREADABLE",
        "已保存的 APIMart API Key 无法在当前 Windows 用户下解密，请重新填写。"
      );
    }
  }

  function keyStatus() {
    if (!fs.existsSync(apiKeyFile)) return { configured: false };
    try {
      readApiKey();
      return { configured: true };
    } catch (error) {
      return {
        configured: false,
        code: String(error?.code || "APIMART_API_KEY_UNREADABLE"),
        error: String(error?.message || "已保存的 APIMart API Key 无法读取，请重新填写。")
      };
    }
  }

  function status() {
    let settings;
    try {
      settings = readSettings();
    } catch (error) {
      return {
        provider: "apimart",
        enabled: false,
        configured: false,
        ready: false,
        baseUrl: DEFAULT_APIMART_BASE_URL,
        model: APIMART_MODEL,
        secureStorageAvailable: encryptionAvailable(),
        code: String(error?.code || "AI_SETTINGS_UNREADABLE"),
        error: String(error?.message || "产品详情图 AI 配置无法读取，请重新保存。")
      };
    }
    const key = keyStatus();
    return {
      provider: "apimart",
      enabled: settings.enabled,
      configured: key.configured,
      ready: settings.enabled && key.configured,
      baseUrl: settings.baseUrl,
      model: APIMART_MODEL,
      secureStorageAvailable: encryptionAvailable(),
      ...(key.code ? { code: key.code, error: key.error } : {})
    };
  }

  function validate(payload = {}) {
    const current = readSettings();
    const baseUrl = normalizeBaseUrl(
      Object.hasOwn(payload, "baseUrl") ? payload.baseUrl : current.baseUrl
    );
    const enabled = Object.hasOwn(payload, "enabled")
      ? payload.enabled === true
      : Object.hasOwn(payload, "apiKey") ? true : current.enabled;
    let configured = false;
    if (Object.hasOwn(payload, "apiKey")) {
      normalizeApiKey(payload.apiKey);
      if (!encryptionAvailable()) {
        throw new ProductDetailAiSettingsError(
          "SECURE_STORAGE_UNAVAILABLE",
          "无法启用 Windows 账户加密存储，请检查当前 Windows 用户后重试。"
        );
      }
      configured = true;
    } else {
      configured = keyStatus().configured;
    }
    if (enabled && !configured) {
      throw new ProductDetailAiSettingsError(
        "APIMART_API_KEY_MISSING",
        "启用 AI 精修前，请先保存 APIMart API Key。"
      );
    }
    return {
      valid: true,
      provider: "apimart",
      enabled,
      configured,
      ready: enabled && configured,
      baseUrl,
      model: APIMART_MODEL,
      paidCallPerformed: false
    };
  }

  function save(payload = {}) {
    const effectivePayload = Object.hasOwn(payload, "enabled")
      ? payload
      : { ...payload, enabled: true };
    const validated = validate(effectivePayload);
    if (Object.hasOwn(effectivePayload, "apiKey")) {
      const apiKey = normalizeApiKey(effectivePayload.apiKey);
      fs.mkdirSync(resolvedRoot, { recursive: true });
      writeFileAtomic(apiKeyFile, safeStorage.encryptString(apiKey), { mode: 0o600 });
    }
    writeJsonAtomic(settingsFile, {
      version: SETTINGS_VERSION,
      provider: "apimart",
      enabled: validated.enabled,
      baseUrl: validated.baseUrl,
      model: APIMART_MODEL
    }, { mode: 0o600 });
    return status();
  }

  function clear() {
    fs.rmSync(apiKeyFile, { force: true });
    let baseUrl = DEFAULT_APIMART_BASE_URL;
    try {
      baseUrl = readSettings().baseUrl;
    } catch {}
    writeJsonAtomic(settingsFile, {
      version: SETTINGS_VERSION,
      provider: "apimart",
      enabled: false,
      baseUrl,
      model: APIMART_MODEL
    }, { mode: 0o600 });
    return status();
  }

  function runtimeConfig() {
    const settings = readSettings();
    const key = keyStatus();
    if (!settings.enabled) {
      return Object.freeze({
        enabled: false,
        configured: key.configured,
        provider: "apimart",
        baseUrl: settings.baseUrl,
        model: APIMART_MODEL,
        apiKey: ""
      });
    }
    const apiKey = readApiKey();
    return Object.freeze({
      enabled: true,
      configured: true,
      provider: "apimart",
      baseUrl: settings.baseUrl,
      model: APIMART_MODEL,
      apiKey
    });
  }

  return {
    clear,
    runtimeConfig,
    save,
    status,
    validate
  };
}

module.exports = {
  APIMART_MODEL,
  DEFAULT_APIMART_BASE_URL,
  ProductDetailAiSettingsError,
  createProductDetailAiSettingsStore,
  normalizeBaseUrl
};
