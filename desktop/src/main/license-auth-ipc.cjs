const { createHash, createPublicKey, verify } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-file.cjs");

const PRODUCT_ID = "ai-huoke-desktop";
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsPhBY7urbSK6OeM6CkL0
3c4v6TE1RKzwn8VlUFeAHQs8/KqmzrEQfaps9SIlUa4BMf8td8Bh3RBSHf+XGDrM
GrM2KU7PDY9bac3Fw0gAQGcvgCV/wg5kAgsnZ85yA8lBmuiw8o/w4YIs/Zq7MDWR
o+esPPP1W2YVNCmLtVIdlfzaPP8y7RmRxG3UZU5GV+YsNPc7QSZEu64S8dHbOGtL
2DXgibn3jikGs15mUkPBmBMsRjGn9ghHJxpn4/9EOWhhRhjnbuNY0lg0b2zxC1+D
axGaWo3mf+e/DgoRvWtvjketmbtIxnMkyn4u0acguvTYOAiYNrqsonBmTjNalWcn
LQIDAQAB
-----END PUBLIC KEY-----`;

function decodePart(value) {
  return Buffer.from(String(value || ""), "base64url");
}

function validateLicense(code, now = Date.now()) {
  const [payloadPart, signaturePart, ...rest] = String(code || "").trim().split(".");
  if (!payloadPart || !signaturePart || rest.length) return { authorized: false, code: "license_format_invalid", error: "授权码格式不正确" };
  let payload;
  try {
    if (!verify("RSA-SHA256", Buffer.from(payloadPart), createPublicKey(PUBLIC_KEY), decodePart(signaturePart))) {
      return { authorized: false, code: "license_signature_invalid", error: "授权码无效" };
    }
    payload = JSON.parse(decodePart(payloadPart).toString("utf8"));
  } catch {
    return { authorized: false, code: "license_invalid", error: "授权码无法识别" };
  }
  const licenseId = String(payload.license_id || "").trim();
  const expiresAt = String(payload.expires_at || "").trim();
  if (payload.product !== PRODUCT_ID || !licenseId) return { authorized: false, code: "license_product_invalid", error: "授权码不适用于当前软件" };
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now) return { authorized: false, code: "license_expired", error: "授权码已过期" };
  return { authorized: true, licenseId, expiresAt };
}

function createLicenseStore({ rootDir, safeStorage }) {
  const file = path.join(rootDir, "license", "session.bin");
  // Capture before the first safeStorage call: Chromium may replace an unreadable Windows key.
  let keySnapshot = null;
  let snapshotFailed = false;
  try {
    const state = JSON.parse(fs.readFileSync(path.join(rootDir, "..", "Local State"), "utf8"));
    if (state.os_crypt) keySnapshot = Buffer.from(JSON.stringify({ os_crypt: state.os_crypt }));
  } catch (error) { snapshotFailed = error.code !== "ENOENT"; }
  const errors = {
    license_required: "请输入原授权码登录。",
    license_read_failed: "无法读取已保存的授权。原文件仍保留，请检查目录访问权限。",
    secure_storage_unavailable: "Windows 安全存储暂不可用。原授权仍保留，请恢复当前 Windows 用户的安全存储后重试。",
    license_decryption_failed: "已保存的授权无法解密，可能与 Windows 密码重置有关。原授权及恢复资料已保留，请重新输入原授权码恢复登录；无需清除数据。",
    license_recovery_backup_failed: "旧授权的恢复资料暂时无法保存。尚未替换授权，请检查磁盘空间和目录访问权限。"
  };
  const licenseError = code => Object.assign(new Error(errors[code]), { code });
  const preserve = ciphertext => {
    try {
      if (snapshotFailed) throw Error("original_key_snapshot_unreadable");
      const digest = createHash("sha256").update(ciphertext).update(keySnapshot || "").digest("hex");
      const directory = path.join(rootDir, "license", "recovery");
      fs.mkdirSync(directory, { recursive: true });
      for (const [suffix, bytes] of [["session.bin", ciphertext], ["Local State.json", keySnapshot]]) {
        if (!bytes) continue;
        const target = path.join(directory, `${digest}.${suffix}`);
        try {
          if (!fs.readFileSync(target).equals(bytes)) throw Error("recovery_copy_mismatch");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          writeFileAtomic(target, bytes, { mode: 0o600 });
        }
        if (!fs.readFileSync(target).equals(bytes)) throw Error("recovery_copy_mismatch");
      }
    } catch { throw licenseError("license_recovery_backup_failed"); }
  };
  const readStored = () => {
    let bytes;
    try { bytes = fs.readFileSync(file); }
    catch (error) { throw licenseError(error.code === "ENOENT" ? "license_required" : "license_read_failed"); }
    if (!safeStorage.isEncryptionAvailable()) throw licenseError("secure_storage_unavailable");
    try { return safeStorage.decryptString(bytes).trim(); }
    catch {
      preserve(bytes);
      throw licenseError("license_decryption_failed");
    }
  };
  const readCode = () => {
    const code = readStored();
    const result = validateLicense(code);
    if (!result.authorized) {
      const error = new Error(result.error || "授权码无效");
      error.code = result.code || "license_invalid";
      throw error;
    }
    return code;
  };
  return {
    status() {
      try { return validateLicense(readStored()); }
      catch (error) { return { authorized: false, code: error.code, ...(error.code === "license_required" ? {} : { error: error.message }) }; }
    },
    readCode,
    activate(code) {
      const result = validateLicense(code);
      if (!result.authorized) return result;
      if (!safeStorage.isEncryptionAvailable()) return { authorized: false, code: "secure_storage_unavailable", error: "当前系统无法安全保存授权状态" };
      try {
        let original = null;
        try { original = fs.readFileSync(file); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (original) preserve(original);
        const encrypted = safeStorage.encryptString(String(code).trim());
        if (safeStorage.decryptString(encrypted).trim() !== String(code).trim()) throw licenseError("secure_storage_unavailable");
        writeFileAtomic(file, encrypted, { mode: 0o600 });
        return result;
      } catch (error) {
        const mapped = errors[error.code] ? error : licenseError("license_read_failed");
        return { authorized: false, code: mapped.code, error: mapped.message };
      }
    },
    logout() {
      fs.rmSync(file, { force: true });
      return { authorized: false, code: "license_required" };
    }
  };
}

function registerLicenseAuthIpc({ ipcMain, store, onChanged }) {
  ipcMain.handle("license-auth:status", () => store.status());
  ipcMain.handle("license-auth:activate", async (_event, payload) => {
    const result = store.activate(String(payload?.code || ""));
    if (result.authorized && typeof onChanged === "function") {
      try { await onChanged({ action: "activated", status: result }); } catch { /* activation remains valid offline */ }
    }
    return result;
  });
  ipcMain.handle("license-auth:logout", async () => {
    const result = store.logout();
    if (typeof onChanged === "function") {
      try { await onChanged({ action: "logged_out", status: result }); } catch { /* local logout already completed */ }
    }
    return result;
  });
}

module.exports = { PRODUCT_ID, createLicenseStore, registerLicenseAuthIpc, validateLicense };
