const fs = require("node:fs");
const path = require("node:path");
const { constants, generateKeyPairSync, privateDecrypt, randomBytes } = require("node:crypto");
const { writeFileAtomic } = require("./atomic-file.cjs");
const CHANNELS = Object.freeze({ status: "content-engine:volcengine-tts-status", encryption: "content-engine:volcengine-tts-encryption", save: "content-engine:save-volcengine-tts-key" });
function failure(code, message) { return Object.assign(new Error(message), { code }); }

function createVolcengineTtsKeyStore({ rootDir, safeStorage, filename: basename = "volcengine-tts-api-key.bin" }) {
  const filename = path.join(rootDir, basename);
  const secure = () => !!safeStorage?.isEncryptionAvailable?.();
  function read() {
    if (!secure()) throw failure("SECURE_STORAGE_UNAVAILABLE", "Windows 账户加密存储不可用。");
    try { return safeStorage.decryptString(fs.readFileSync(filename)).trim(); }
    catch { throw failure("VOLCENGINE_TTS_KEY_UNAVAILABLE", "请在火山引擎设置中保存对应服务的 API Key。"); }
  }
  function status() {
    const result = { configured: false, secureStorageAvailable: secure(), maskedKey: "" };
    if (secure() && fs.existsSync(filename)) {
      try { const key = read(); result.configured = !!key; result.maskedKey = key ? `****${key.slice(-4)}` : ""; } catch {}
    }
    return result;
  }
  return { read, status, write(value) {
    const key = String(value || "").trim();
    if (!/^[A-Za-z0-9._-]{16,180}$/.test(key)) throw failure("VOLCENGINE_TTS_KEY_INVALID", "火山引擎 API Key 格式无效，请复制控制台中的 API Key。");
    if (!secure()) throw failure("SECURE_STORAGE_UNAVAILABLE", "Windows 账户加密存储不可用。");
    fs.mkdirSync(rootDir, { recursive: true });
    writeFileAtomic(filename, safeStorage.encryptString(key), { mode: 0o600 });
    return status();
  } };
}

function createVolcengineAsrStore({ rootDir, safeStorage }) {
  const filename = path.join(rootDir, "volcengine-asr-credentials.bin");
  const secure = () => !!safeStorage?.isEncryptionAvailable?.();
  function parse(value) {
    let data;
    try { data = JSON.parse(value); } catch { throw failure("VOLCENGINE_ASR_INVALID", "请填写正确的 APP ID 和 Access Token。"); }
    if (!data || !/^[0-9]{1,24}$/.test(data.appId || "") || !/^[A-Za-z0-9._+=/-]{16,256}$/.test(data.accessToken || "") || Object.keys(data).some(k => !["appId", "accessToken"].includes(k))) throw failure("VOLCENGINE_ASR_INVALID", "请填写正确的 APP ID 和 Access Token。");
    return { appId: data.appId, accessToken: data.accessToken };
  }
  function read() {
    if (!secure()) throw failure("SECURE_STORAGE_UNAVAILABLE", "Windows 账户加密存储不可用。");
    return parse(safeStorage.decryptString(fs.readFileSync(filename)));
  }
  function status() {
    try { const data = read(); return { configured: true, secureStorageAvailable: true, appId: data.appId }; }
    catch { return { configured: false, secureStorageAvailable: secure(), appId: "" }; }
  }
  return { read, status, write(value) {
    const data = parse(value);
    if (!secure()) throw failure("SECURE_STORAGE_UNAVAILABLE", "Windows 账户加密存储不可用。");
    fs.mkdirSync(rootDir, { recursive: true });
    writeFileAtomic(filename, safeStorage.encryptString(JSON.stringify(data)), { mode: 0o600 });
    return status();
  } };
}

function registerVolcengineTtsSettings({ handle, store, controller, assertKeys, invalid, channels = CHANNELS, modulusLength = 2048 }) {
  const sessions = new Map();
  handle(channels.status, async () => store?.status() || { configured: false, secureStorageAvailable: false, maskedKey: "" });
  handle(channels.encryption, async () => {
    if (!store) invalid("CONTENT_ENGINE_CAPABILITY_UNAVAILABLE");
    for (const [id, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(id);
    if (sessions.size >= 8) sessions.delete(sessions.keys().next().value);
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength, publicKeyEncoding: { type: "spki", format: "pem" } });
    const keyId = randomBytes(16).toString("hex");
    sessions.set(keyId, { privateKey, expiresAt: Date.now() + 60000 });
    return { keyId, publicKey };
  });
  handle(channels.save, async (payload) => {
    assertKeys(payload, new Set(["keyId", "ciphertext"]));
    if (!store) invalid("CONTENT_ENGINE_CAPABILITY_UNAVAILABLE");
    const session = sessions.get(payload.keyId); sessions.delete(payload.keyId);
    if (!session || session.expiresAt <= Date.now() || typeof payload.ciphertext !== "string" || payload.ciphertext.length > 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload.ciphertext)) invalid("VOLCENGINE_TTS_KEY_ENCRYPTION_INVALID");
    let plaintext;
    try {
      plaintext = privateDecrypt({ key: session.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(payload.ciphertext, "base64"));
    } catch { invalid("VOLCENGINE_TTS_KEY_ENCRYPTION_INVALID"); }
    try {
      const result = store.write(plaintext.toString("utf8"));
      const restarted = await controller.restart();
      if (restarted?.state !== "ready") throw failure("VOLCENGINE_TTS_RESTART_REQUIRED", "密钥已保存，但内容引擎尚未就绪，请重新启动应用后继续。");
      return result;
    }
    finally { plaintext?.fill(0); }
  });
}
module.exports = { CHANNELS, createVolcengineTtsKeyStore, createVolcengineAsrStore, registerVolcengineTtsSettings };
