const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { createLicenseStore } = require("./license-auth-ipc.cjs");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-license-recovery-"));
try {
  const rootDir = path.join(profile, "data");
  const directory = path.join(rootDir, "license");
  const file = path.join(directory, "session.bin");
  const safeStorage = { isEncryptionAvailable: () => true, decryptString() { throw Error("Windows master key unavailable"); } };
  fs.mkdirSync(directory, { recursive: true });
  assert.equal(createLicenseStore({ rootDir, safeStorage }).status().code, "license_required");
  const original = Buffer.from("existing encrypted authorization fixture");
  const osCrypt = { encrypted_key: "opaque-old-DPAPI-key-fixture" };
  fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(profile, "Local State"), JSON.stringify({ os_crypt: osCrypt }));
  const store = createLicenseStore({ rootDir, safeStorage });
  const failed = store.status();
  assert.equal(failed.code, "license_decryption_failed", "An unreadable saved authorization must not become a missing license");
  assert.match(failed.error, /Windows|解密/);
  assert.throws(() => store.readCode(), { code: "license_decryption_failed" });
  assert.deepEqual(fs.readFileSync(file), original);
  const recovery = path.join(directory, "recovery");
  const backups = fs.readdirSync(recovery);
  assert.equal(backups.length, 2, "Repeated status reads deduplicate the original ciphertext and key backup");
  assert.deepEqual(fs.readFileSync(path.join(recovery, backups.find(x => x.endsWith(".bin")))), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(recovery, backups.find(x => x.endsWith(".json"))))).os_crypt, osCrypt);
  assert.equal(store.activate("invalid replacement").authorized, false);
  assert.deepEqual(fs.readFileSync(file), original, "Invalid replacements preserve the old authorization");
  safeStorage.isEncryptionAvailable = () => false;
  assert.equal(store.status().code, "secure_storage_unavailable");
  assert.deepEqual(fs.readFileSync(file), original);
  safeStorage.isEncryptionAvailable = () => true;
  fs.writeFileSync(path.join(profile, "Local State"), "malformed original key state");
  assert.equal(createLicenseStore({ rootDir, safeStorage }).status().code, "license_recovery_backup_failed");
  assert.deepEqual(fs.readFileSync(file), original, "Unreadable key snapshots must never allow replacing the existing authorization");

  // Isolated trust key, with real RSA verification; never read customer codes.
  const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const isolated = { exports: {} };
  const source = fs.readFileSync(require.resolve("./license-auth-ipc.cjs"), "utf8");
  vm.runInNewContext(source, { module: isolated, Buffer, require: name => name === "node:crypto"
    ? { ...crypto, createPublicKey: () => keys.publicKey } : require(name) });
  const payload = Buffer.from(JSON.stringify({ product: "ai-huoke-desktop", license_id: "isolated-recovery", expires_at: "2099-01-01T00:00:00Z" })).toString("base64url");
  const code = `${payload}.${crypto.sign("RSA-SHA256", Buffer.from(payload), keys.privateKey).toString("base64url")}`;
  const expiredPayload = Buffer.from(JSON.stringify({ product: 'ai-huoke-desktop', license_id: 'isolated-expired', expires_at: '2000-01-01T00:00:00Z' })).toString('base64url');
  const expiredCode = `${expiredPayload}.${crypto.sign('RSA-SHA256', Buffer.from(expiredPayload), keys.privateKey).toString('base64url')}`;
  assert.equal(isolated.exports.validateLicense(expiredCode).code, 'license_expired');
  const replacement = Buffer.from("new encrypted authorization fixture");
  safeStorage.encryptString = () => replacement;
  safeStorage.decryptString = bytes => {
    if (bytes.equals(replacement)) return code;
    throw Error("old key unavailable");
  };
  const isolatedStore = () => isolated.exports.createLicenseStore({ rootDir, safeStorage });
  assert.equal(isolatedStore().activate(code).code, "license_recovery_backup_failed");
  assert.deepEqual(fs.readFileSync(file), original);
  fs.writeFileSync(path.join(profile, "Local State"), JSON.stringify({ os_crypt: osCrypt }));
  const recovering = isolatedStore();
  const decrypt = safeStorage.decryptString;
  safeStorage.decryptString = () => "readback mismatch";
  assert.equal(recovering.activate(code).code, "secure_storage_unavailable");
  assert.deepEqual(fs.readFileSync(file), original, "Failed encryption readback cannot replace the original");
  safeStorage.decryptString = decrypt;
  assert.equal(recovering.activate(code).authorized, true);
  assert.deepEqual(fs.readFileSync(file), replacement);
  assert.equal(isolatedStore().status().authorized, true, "Recovered authorization survives a new store instance");
  assert.equal(isolatedStore().readCode(), code);
  assert.deepEqual(fs.readFileSync(path.join(recovery, backups.find(x => x.endsWith(".bin")))), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(recovery, backups.find(x => x.endsWith(".json"))))).os_crypt, osCrypt);
  console.log("license authorization recovery self-check passed");
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
