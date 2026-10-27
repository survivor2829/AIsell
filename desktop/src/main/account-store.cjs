const fs = require("node:fs");
const path = require("node:path");

// The signed-in account on this computer. Only the server-issued device token and the
// account profile are kept (encrypted with the Windows account); never the password.
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const REJECTIONS = new Set(["account_signed_in_elsewhere", "device_invalid", "account_disabled", "account_expired", "account_use_password", "account_invalid"]);

function createAccountStore({ rootDir, safeStorage, now = Date.now, onChange = () => {} }) {
  const directory = path.join(rootDir, "account");
  const file = path.join(directory, "device.bin");

  function read() {
    try {
      if (!fs.existsSync(file) || !safeStorage.isEncryptionAvailable()) return null;
      const value = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
      return value && typeof value === "object" ? value : null;
    } catch { return null; }
  }
  function write(value) {
    if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error("无法启用 Windows 账户加密存储。"), { code: "secure_storage_unavailable" });
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(value)));
    fs.renameSync(temporary, file);
    onChange(status());
  }
  function profileOf(account) {
    if (!account || typeof account !== "object") return null;
    return { id: String(account.id || ""), phone: String(account.phone || ""), displayName: String(account.displayName || ""),
      setupRequired: account.setupRequired === true, mustChangePassword: account.mustChangePassword === true,
      expiresAt: Number.isFinite(account.expiresAt) ? account.expiresAt : null };
  }

  function credentials() {
    const record = read();
    return record?.deviceToken ? { deviceToken: record.deviceToken } : null;
  }
  // A successful session: keep the newest device token and profile, mark the account verified now.
  function remember({ deviceToken, account } = {}) {
    const record = read() || {};
    const profile = profileOf(account) || record.profile || null;
    write({ deviceToken: typeof deviceToken === "string" && deviceToken ? deviceToken : record.deviceToken || "", profile, verifiedAt: now(), rejected: "" });
  }
  // The server refused this computer: forget the token, keep the phone for the login form.
  function reject(code) {
    if (!REJECTIONS.has(code)) return;
    const record = read();
    if (!record) return;
    write({ deviceToken: "", profile: record.profile ? { ...record.profile } : null, verifiedAt: 0, rejected: code });
  }
  function clear() {
    const record = read();
    write({ deviceToken: "", profile: record?.profile ? { phone: record.profile.phone } : null, verifiedAt: 0, rejected: "" });
  }
  function status() {
    const record = read();
    const profile = record?.profile || null;
    const fresh = Boolean(record?.deviceToken) && now() - Number(record.verifiedAt || 0) <= OFFLINE_GRACE_MS;
    if (fresh && profile?.id) {
      return { authorized: true, licenseId: profile.id, phone: profile.phone, displayName: profile.displayName,
        setupRequired: profile.setupRequired, mustChangePassword: profile.mustChangePassword,
        expiresAt: profile.expiresAt ? new Date(profile.expiresAt * 1000).toISOString() : undefined, verifiedAt: record.verifiedAt };
    }
    return { authorized: false, phone: profile?.phone || "",
      code: record?.rejected || (record?.deviceToken ? "account_offline_too_long" : "account_login_required") };
  }
  return { credentials, remember, reject, clear, status, OFFLINE_GRACE_MS };
}

module.exports = { createAccountStore, OFFLINE_GRACE_MS };
