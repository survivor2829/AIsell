const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  runProductDetailReleaseSmoke
} = require("./product-detail-release-smoke.cjs");

function fakeBrowserWindow(responses, observed) {
  return class FakeBrowserWindow {
    constructor(options) {
      observed.options = options;
      this.webContents = {
        executeJavaScript: async (source, userGesture) => {
          observed.userGestures.push(userGesture);
          const method = source.match(/api\["([^"]+)"\]/)?.[1] || "";
          observed.methods.push(method);
          return responses.shift();
        }
      };
    }

    async loadURL(url) {
      observed.url = url;
    }
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-product-detail-release-smoke-"));
  const dataDir = path.join(root, "data");
  const preloadPath = path.join(root, "preload.cjs");
  fs.mkdirSync(dataDir);
  fs.writeFileSync(preloadPath, "fixture", "utf8");

  try {
    const observed = { methods: [], userGestures: [], options: null, url: "" };
    let disposeCalls = 0;
    const result = await runProductDetailReleaseSmoke({
      BrowserWindow: fakeBrowserWindow([
        { ok: true, data: { state: "stopped", available: true } },
        { ok: true, data: { state: "ready", available: true } },
        { ok: true, data: { state: "ready", origin: "http://127.0.0.1:43123", version: "2.0.0-fixture" } },
        { ok: true, data: { state: "stopped" } },
        { ok: true, data: { state: "stopped" } }
      ], observed),
      controller: { dispose: async () => { disposeCalls += 1; } },
      dataDir,
      preloadPath,
      webPreferences: {
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      },
      requestHealth: async (origin) => {
        assert.equal(origin, "http://127.0.0.1:43123");
        return {
          statusCode: 200,
          payload: { ok: true, status: "ready", version: "2.0.0-fixture" }
        };
      }
    });
    assert.deepEqual(result, {
      ok: true,
      version: "2.0.0-fixture",
      ipc: true,
      health: true,
      stopped: true
    });
    assert.deepEqual(observed.methods, ["status", "start", "status", "stop", "status"]);
    assert.deepEqual(observed.userGestures, [true, true, true, true, true]);
    assert.equal(observed.options.show, false);
    assert.equal(observed.options.skipTaskbar, true);
    assert.equal(observed.options.focusable, false);
    assert.equal(observed.options.webPreferences.preload, preloadPath);
    assert.equal(observed.options.webPreferences.contextIsolation, true);
    assert.equal(observed.url, "data:text/html,<title>product-detail-release-smoke</title>");
    assert.equal(disposeCalls, 1);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dataDir, "product-detail-release-smoke.json"), "utf8")),
      result
    );

    let failedDisposeCalls = 0;
    await assert.rejects(
      () => runProductDetailReleaseSmoke({
        BrowserWindow: fakeBrowserWindow([
          { ok: true, data: { state: "unavailable", available: false } }
        ], { methods: [], userGestures: [], options: null, url: "" }),
        controller: { dispose: async () => { failedDisposeCalls += 1; } },
        dataDir,
        preloadPath,
        webPreferences: { sandbox: false },
        requestHealth: async () => { throw new Error("not reached"); }
      }),
      /did not discover the bundled runtime/
    );
    assert.equal(failedDisposeCalls, 1, "a failed smoke must still dispose the sidecar controller");

    console.log("product-detail release smoke self-check passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
