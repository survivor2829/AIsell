const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-file.cjs");

class BailianApiKeyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function maskApiKey(value) {
  const key = String(value || "").trim();
  if (!key) return "";
  return key.length < 8 ? "****" : `${key.slice(0, 3)}****${key.slice(-4)}`;
}

function createBailianApiKeyStore({ rootDir, safeStorage } = {}) {
  const keyFile = path.join(String(rootDir || ""), "bailian-api-key.bin");
  const hostFile = path.join(String(rootDir || ""), "bailian-api-host.txt");
  const encryptionAvailable = () => Boolean(safeStorage?.isEncryptionAvailable?.());

  function normalizeApiHost(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new BailianApiKeyError("BAILIAN_API_HOST_INVALID", "百炼 API Host 格式无效。");
    }
    const hostname = String(parsed.hostname || "").toLowerCase();
    if (parsed.protocol !== "https:"
      || !hostname
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || (parsed.pathname !== "" && parsed.pathname !== "/")
      || (parsed.port && parsed.port !== "443")
      || !(hostname === "dashscope.aliyuncs.com" || hostname.endsWith(".maas.aliyuncs.com"))) {
      throw new BailianApiKeyError("BAILIAN_API_HOST_INVALID", "百炼 API Host 必须是官方 HTTPS 地址。");
    }
    return `https://${hostname}`;
  }

  function readApiHost() {
    try {
      return normalizeApiHost(fs.readFileSync(hostFile, "utf8"));
    } catch (error) {
      if (error?.code === "BAILIAN_API_HOST_INVALID") throw error;
      return "";
    }
  }

  function read() {
    if (!encryptionAvailable()) {
      throw new BailianApiKeyError(
        "SECURE_STORAGE_UNAVAILABLE",
        "无法启用 Windows 账户加密存储。"
      );
    }
    if (!fs.existsSync(keyFile)) {
      throw new BailianApiKeyError("BAILIAN_API_KEY_MISSING", "请先保存百炼 API Key。");
    }
    try {
      return safeStorage.decryptString(fs.readFileSync(keyFile)).trim();
    } catch {
      throw new BailianApiKeyError(
        "BAILIAN_API_KEY_UNREADABLE",
        "已保存的百炼 API Key 无法解密，请重新填写。"
      );
    }
  }

  return {
    status() {
      if (!encryptionAvailable()) {
        return {
          configured: false,
          maskedKey: "",
          apiHost: "",
          secureStorageAvailable: false,
          code: "SECURE_STORAGE_UNAVAILABLE"
        };
      }
      if (!fs.existsSync(keyFile)) {
        return {
          configured: false,
          maskedKey: "",
          apiHost: readApiHost(),
          secureStorageAvailable: true
        };
      }
      try {
        return {
          configured: true,
          maskedKey: maskApiKey(read()),
          apiHost: readApiHost(),
          secureStorageAvailable: true
        };
      } catch (error) {
        return {
          configured: false,
          maskedKey: "",
          apiHost: readApiHost(),
          secureStorageAvailable: true,
          code: String(error?.code || "BAILIAN_API_KEY_UNREADABLE")
        };
      }
    },
    read,
    write(value, options = {}) {
      const key = String(value || "").trim();
      // Newer pay-as-you-go workspace keys use the `sk-ws-` prefix and may
      // contain dots in the opaque suffix; legacy `sk-` keys remain valid.
      if (!/^sk-[A-Za-z0-9._-]{8,}$/.test(key)) {
        throw new BailianApiKeyError(
          "BAILIAN_API_KEY_INVALID",
          "百炼 API Key 格式无效。"
        );
      }
      if (!encryptionAvailable()) {
        throw new BailianApiKeyError(
          "SECURE_STORAGE_UNAVAILABLE",
          "无法启用 Windows 账户加密存储。"
        );
      }
      const apiHost = normalizeApiHost(options.apiHost);
      fs.mkdirSync(rootDir, { recursive: true });
      writeFileAtomic(keyFile, safeStorage.encryptString(key), { mode: 0o600 });
      if (apiHost) {
        writeFileAtomic(hostFile, `${apiHost}\n`, { mode: 0o600 });
      }
      return this.status();
    },
    clear() {
      fs.rmSync(keyFile, { force: true });
      fs.rmSync(hostFile, { force: true });
      return { configured: false, maskedKey: "", apiHost: "", secureStorageAvailable: true };
    }
  };
}

module.exports = {
  BailianApiKeyError,
  createBailianApiKeyStore,
  maskApiKey
};
