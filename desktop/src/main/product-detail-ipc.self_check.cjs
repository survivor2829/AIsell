const assert = require("node:assert/strict");
const {
  PRODUCT_DETAIL_CHANNELS,
  registerProductDetailIpc
} = require("./product-detail-ipc.cjs");

async function main() {
  const handlers = new Map();
  const sent = [];
  let updateListener = null;
  let unsubscribed = false;
  const controllerStatus = {
    state: "ready",
    available: true,
    origin: "http://localhost:43123",
    bootstrapUrl: "http://localhost:43123/desktop/bootstrap?token=one-time",
    version: "1.0.0",
    capabilities: { upload: true },
    code: "",
    controlToken: "must-not-leak",
    runtimePath: "C:\\secret\\sidecar.exe",
    stderr: "customer private content"
  };
  const controller = {
    status: () => controllerStatus,
    start: async () => controllerStatus,
    restart: async () => controllerStatus,
    stop: async () => ({ ...controllerStatus, state: "stopped", origin: "", bootstrapUrl: "" }),
    onUpdate: (listener) => {
      updateListener = listener;
      return () => {
        unsubscribed = true;
      };
    }
  };
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler)
  };
  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => sent.push({ channel, payload })
    }
  };

  const registration = registerProductDetailIpc({
    controller,
    ipcMain,
    getMainWindow: () => mainWindow
  });

  assert.deepEqual([...handlers.keys()].sort(), [
    PRODUCT_DETAIL_CHANNELS.restart,
    PRODUCT_DETAIL_CHANNELS.start,
    PRODUCT_DETAIL_CHANNELS.status,
    PRODUCT_DETAIL_CHANNELS.stop
  ].sort());

  for (const channel of [
    PRODUCT_DETAIL_CHANNELS.status,
    PRODUCT_DETAIL_CHANNELS.start,
    PRODUCT_DETAIL_CHANNELS.restart,
    PRODUCT_DETAIL_CHANNELS.stop
  ]) {
    const response = await handlers.get(channel)();
    assert.equal(response.ok, true);
    const serialized = JSON.stringify(response);
    assert.equal(serialized.includes("must-not-leak"), false);
    assert.equal(serialized.includes("secret"), false);
    assert.equal(serialized.includes("customer private content"), false);
  }

  updateListener(controllerStatus);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, PRODUCT_DETAIL_CHANNELS.update);
  assert.equal(sent[0].payload.state, "ready");
  assert.equal(JSON.stringify(sent[0]).includes("must-not-leak"), false);

  controller.start = async () => {
    const error = new Error("C:\\secret\\sidecar.exe --control-token private-value");
    error.code = "PRODUCT_DETAIL_START_TIMEOUT";
    throw error;
  };
  const knownFailure = await handlers.get(PRODUCT_DETAIL_CHANNELS.start)();
  assert.deepEqual(knownFailure, {
    ok: false,
    code: "PRODUCT_DETAIL_START_TIMEOUT",
    error: "产品详情图服务启动超时，请重试。"
  });

  controller.restart = async () => {
    const error = new Error("private database path");
    error.code = "UNEXPECTED_PRIVATE_ERROR";
    throw error;
  };
  const unknownFailure = await handlers.get(PRODUCT_DETAIL_CHANNELS.restart)();
  assert.deepEqual(unknownFailure, {
    ok: false,
    code: "PRODUCT_DETAIL_FAILED",
    error: "产品详情图服务暂时不可用，请重试。"
  });

  registration.dispose();
  assert.equal(unsubscribed, true);
  console.log("product-detail IPC self-check passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
