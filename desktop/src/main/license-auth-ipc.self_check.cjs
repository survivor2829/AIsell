const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
  console.log("license authorization recovery self-check passed");
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
