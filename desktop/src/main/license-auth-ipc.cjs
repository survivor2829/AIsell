const { createPublicKey, verify } = require("node:crypto");
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
  const read = () => {
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("secure_storage_unavailable");
      const code = safeStorage.decryptString(fs.readFileSync(file));
      return validateLicense(code);
    } catch {
      return { authorized: false, code: "license_required" };
    }
  };
  const readCode = () => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("secure_storage_unavailable");
    let code;
    try {
      code = safeStorage.decryptString(fs.readFileSync(file)).trim();
    } catch (error) {
      const mapped = new Error(error?.code === "ENOENT" ? "license_required" : "secure_storage_unavailable");
      mapped.code = error?.code === "ENOENT" ? "license_required" : "secure_storage_unavailable";
      throw mapped;
    }
    const result = validateLicense(code);
    if (!result.authorized) {
      const error = new Error(result.error || "授权码无效");
      error.code = result.code || "license_invalid";
      throw error;
    }
    return code;
  };
  return {
    status: read,
    readCode,
    activate(code) {
      const result = validateLicense(code);
      if (!result.authorized) return result;
      if (!safeStorage.isEncryptionAvailable()) return { authorized: false, code: "secure_storage_unavailable", error: "当前系统无法安全保存授权状态" };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomic(file, safeStorage.encryptString(String(code).trim()));
      return result;
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
