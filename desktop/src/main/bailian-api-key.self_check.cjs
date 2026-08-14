const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBailianApiKeyStore, maskApiKey } = require("./bailian-api-key.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-bailian-key-"));
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
  decryptString: (value) => value.toString("utf8").replace(/^encrypted:/, "")
};

try {
  const store = createBailianApiKeyStore({ rootDir: root, safeStorage });
  assert.deepEqual(store.status(), {
    configured: false,
    maskedKey: "",
    secureStorageAvailable: true
  });
  assert.throws(() => store.write("invalid"), { code: "BAILIAN_API_KEY_INVALID" });
  const secret = "sk-fixture-secret-value";
  const saved = store.write(secret);
  assert.equal(saved.configured, true);
  assert.equal(saved.maskedKey, maskApiKey(secret));
  assert.equal(store.read(), secret);
  const storedBytes = fs.readFileSync(path.join(root, "bailian-api-key.bin"), "utf8");
  assert.notEqual(storedBytes, secret);
  assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.equal(store.clear().configured, false);
  assert.equal(fs.existsSync(path.join(root, "bailian-api-key.bin")), false);

  const unavailable = createBailianApiKeyStore({
    rootDir: root,
    safeStorage: { isEncryptionAvailable: () => false }
  });
  assert.equal(unavailable.status().secureStorageAvailable, false);
  assert.throws(() => unavailable.write(secret), {
    code: "SECURE_STORAGE_UNAVAILABLE"
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("bailian API key self-check passed");
