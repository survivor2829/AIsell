const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DEFAULT_APIMART_BASE_URL,
  createProductDetailAiSettingsStore,
  normalizeBaseUrl
} = require("./product-detail-ai-settings.cjs");
const {
  PRODUCT_DETAIL_AI_SETTINGS_CHANNELS,
  registerProductDetailAiSettingsIpc
} = require("./product-detail-ai-settings-ipc.cjs");
const { createPreloadApis } = require("./preload-api.cjs");

function errorCode(error) {
  return String(error?.code || "");
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-product-ai-settings-"));
  const secret = "apimart-secret-must-not-leak";
  let paidCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    paidCalls += 1;
    throw new Error("validate must never use the network");
  };
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(String(value), "utf8").toString("base64url"),
    decryptString: (value) => {
      const encoded = value.toString("utf8");
      if (!encoded) throw new Error("invalid ciphertext");
      return Buffer.from(encoded, "base64url").toString("utf8");
    }
  };

  try {
    const store = createProductDetailAiSettingsStore({ rootDir: root, safeStorage });
    assert.deepEqual(store.status(), {
      provider: "apimart",
      enabled: false,
      configured: false,
      ready: false,
      baseUrl: DEFAULT_APIMART_BASE_URL,
      model: "gpt-image-2",
      secureStorageAvailable: true
    });

    assert.equal(normalizeBaseUrl(`${DEFAULT_APIMART_BASE_URL}/`), DEFAULT_APIMART_BASE_URL);
    for (const invalid of [
      "http://api.apimart.ai/v1",
      "https://user:pass@api.apimart.ai/v1",
      "https://api.apimart.ai/v1?token=secret",
      "https://api.apimart.ai/v1#fragment",
      "https://api.apimart.ai/v2",
      "https://example.com/v1"
    ]) {
      assert.throws(() => normalizeBaseUrl(invalid), (error) => [
        "APIMART_BASE_URL_HTTPS_REQUIRED",
        "APIMART_BASE_URL_INVALID"
      ].includes(errorCode(error)), invalid);
    }

    const validation = store.validate({ apiKey: secret });
    assert.equal(validation.valid, true);
    assert.equal(validation.enabled, true);
    assert.equal(validation.ready, true);
    assert.equal(validation.paidCallPerformed, false);
    assert.equal(paidCalls, 0);
    assert.equal(fs.existsSync(path.join(root, "product-detail-apimart-key.bin")), false);

    const saved = store.save({ apiKey: secret });
    assert.equal(saved.enabled, true, "saving a key must enable AI refinement by default");
    assert.equal(saved.ready, true);
    assert.equal(JSON.stringify(saved).includes(secret), false);
    const cipher = fs.readFileSync(path.join(root, "product-detail-apimart-key.bin"));
    const publicSettings = fs.readFileSync(
      path.join(root, "product-detail-ai-settings.json"),
      "utf8"
    );
    assert.equal(cipher.toString("utf8").includes(secret), false);
    assert.notEqual(cipher.toString("utf8"), secret);
    assert.equal(publicSettings.includes(secret), false);

    const runtime = store.runtimeConfig();
    assert.deepEqual(runtime, {
      enabled: true,
      configured: true,
      provider: "apimart",
      baseUrl: DEFAULT_APIMART_BASE_URL,
      model: "gpt-image-2",
      apiKey: secret
    });
    store.save({ baseUrl: DEFAULT_APIMART_BASE_URL });
    assert.equal(store.runtimeConfig().apiKey, secret, "omitting apiKey must preserve it");
    store.save({ enabled: false });
    assert.equal(store.runtimeConfig().apiKey, "", "disabled runtime must not expose a key");
    store.save({ enabled: true });

    const handlers = new Map();
    const changes = [];
    registerProductDetailAiSettingsIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      store,
      onChanged: (change) => changes.push(change)
    });
    assert.deepEqual([...handlers.keys()].sort(), Object.values(
      PRODUCT_DETAIL_AI_SETTINGS_CHANNELS
    ).sort());

    const ipcStatus = await handlers.get(PRODUCT_DETAIL_AI_SETTINGS_CHANNELS.status)();
    assert.equal(ipcStatus.ok, true);
    assert.equal(ipcStatus.data.configured, true);
    assert.equal(JSON.stringify(ipcStatus).includes(secret), false);
    const ipcValidate = await handlers.get(
      PRODUCT_DETAIL_AI_SETTINGS_CHANNELS.validate
    )(null, { apiKey: secret, ignoredSecret: "must-not-pass" });
    assert.equal(ipcValidate.ok, true);
    assert.equal(ipcValidate.data.paidCallPerformed, false);
    assert.equal(JSON.stringify(ipcValidate).includes(secret), false);
    assert.equal(paidCalls, 0);

    const replacement = "replacement-secret-must-not-leak";
    const ipcSave = await handlers.get(PRODUCT_DETAIL_AI_SETTINGS_CHANNELS.save)(
      null,
      { apiKey: replacement, baseUrl: DEFAULT_APIMART_BASE_URL, ignored: secret }
    );
    assert.equal(ipcSave.ok, true);
    assert.equal(JSON.stringify(ipcSave).includes(replacement), false);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, "saved");
    assert.equal(JSON.stringify(changes[0]).includes(replacement), false);

    const calls = [];
    const api = createPreloadApis({
      invoke: (channel, payload) => {
        calls.push({ channel, payload });
        return Promise.resolve({ ok: true });
      },
      on: () => undefined,
      removeListener: () => undefined
    }).productDetailAiSettings;
    await api.status();
    await api.save({ apiKey: secret, ignored: "renderer-only" });
    await api.validate({ baseUrl: DEFAULT_APIMART_BASE_URL, ignored: secret });
    await api.delete();
    assert.deepEqual(calls, [
      { channel: PRODUCT_DETAIL_AI_SETTINGS_CHANNELS.status, payload: undefined },
      { channel: PRODUCT_DETAIL_AI_SETTINGS_CHANNELS.save, payload: { apiKey: secret } },
      {
        channel: PRODUCT_DETAIL_AI_SETTINGS_CHANNELS.validate,
        payload: { baseUrl: DEFAULT_APIMART_BASE_URL }
      },
      { channel: PRODUCT_DETAIL_AI_SETTINGS_CHANNELS.delete, payload: undefined }
    ]);

    const removed = await handlers.get(PRODUCT_DETAIL_AI_SETTINGS_CHANNELS.delete)();
    assert.equal(removed.ok, true);
    assert.equal(removed.data.configured, false);
    assert.equal(removed.data.enabled, false);
    assert.equal(changes.length, 2);
    assert.equal(changes[1].action, "deleted");

    const unavailableRoot = path.join(root, "unavailable");
    const unavailable = createProductDetailAiSettingsStore({
      rootDir: unavailableRoot,
      safeStorage: { isEncryptionAvailable: () => false }
    });
    assert.throws(
      () => unavailable.save({ apiKey: secret }),
      (error) => errorCode(error) === "SECURE_STORAGE_UNAVAILABLE"
    );

    const sources = [
      "product-detail-ai-settings.cjs",
      "product-detail-ai-settings-ipc.cjs"
    ].map((name) => fs.readFileSync(path.join(__dirname, name), "utf8"));
    for (const source of sources) assert.equal(/\?\?\?/u.test(source), false);
    assert.equal(/\p{Script=Han}/u.test(sources.join("")), true);

    const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
    assert.match(mainSource, /createProductDetailAiSettingsStore/u);
    assert.match(
      mainSource,
      /getProviderEnvironment: productDetailReleaseSmokeMode\s*\? \(\) => \(\{\}\)\s*: getProductDetailProviderEnvironment/u
    );
    assert.match(mainSource, /DEEPSEEK_API_KEY = deepSeekKeyStore\.read\(\)/u);
    assert.match(mainSource, /REFINE_API_KEY = refine\.apiKey/u);
    assert.match(mainSource, /REFINE_API_BASE_URL = refine\.baseUrl/u);
    assert.match(mainSource, /APIMART_API_KEY = imageProvider\.apiKey/u);
    assert.match(mainSource, /APIMART_API_BASE_URL = imageProvider\.baseUrl/u);
    assert.match(mainSource, /APIMART_IMAGE_MODEL = imageProvider\.model/u);
    assert.match(mainSource, /function restartImageProviderConsumers\(\)/u);
    assert.match(mainSource, /onChanged: restartImageProviderConsumers/u);
    assert.match(
      mainSource,
      /PROVIDER_CONSUMER_RESTART_STATES = new Set\(\["ready", "starting", "failed"\]\)/u
    );
    assert.doesNotMatch(
      mainSource,
      /PROVIDER_CONSUMER_RESTART_STATES = new Set\([^\n]*stopped/u
    );
    assert.match(mainSource, /registerProductDetailAiSettingsIpc/u);
    assert.match(mainSource, /onChanged: restartProductDetailForProviderChange/u);

    const rendererSource = fs.readFileSync(
      path.join(__dirname, "../renderer/App.tsx"),
      "utf8"
    );
    assert.match(rendererSource, /function ApiMartSettings\(\)/u);
    assert.match(rendererSource, /https:\/\/api\.apimart\.ai\/v1/u);
    assert.match(rendererSource, /gpt-image-2/u);
    assert.match(rendererSource, /paidCallPerformed !== false/u);
    const productPage = fs.readFileSync(
      path.join(__dirname, "../renderer/ProductDetailPage.tsx"),
      "utf8"
    );
    assert.match(productPage, /capabilities\.paid_ai_ready === true/u);
    assert.equal(paidCalls, 0);
    console.log("product detail AI settings self-check passed");
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
