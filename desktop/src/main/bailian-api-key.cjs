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
  const encryptionAvailable = () => Boolean(safeStorage?.isEncryptionAvailable?.());

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
          secureStorageAvailable: false,
          code: "SECURE_STORAGE_UNAVAILABLE"
        };
      }
      if (!fs.existsSync(keyFile)) {
        return { configured: false, maskedKey: "", secureStorageAvailable: true };
      }
      try {
        return {
          configured: true,
          maskedKey: maskApiKey(read()),
          secureStorageAvailable: true
        };
      } catch (error) {
        return {
          configured: false,
          maskedKey: "",
          secureStorageAvailable: true,
          code: String(error?.code || "BAILIAN_API_KEY_UNREADABLE")
        };
      }
    },
    read,
    write(value) {
      const key = String(value || "").trim();
      if (!/^sk-[A-Za-z0-9_-]{8,}$/.test(key)) {
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
      fs.mkdirSync(rootDir, { recursive: true });
      writeFileAtomic(keyFile, safeStorage.encryptString(key), { mode: 0o600 });
      return this.status();
    },
    clear() {
      fs.rmSync(keyFile, { force: true });
      return { configured: false, maskedKey: "", secureStorageAvailable: true };
    }
  };
}

module.exports = {
  BailianApiKeyError,
  createBailianApiKeyStore,
  maskApiKey
};
