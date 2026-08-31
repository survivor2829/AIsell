const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

function requestProductDetailSmokeHealth(origin) {
  return new Promise((resolve, reject) => {
    const target = new URL("/internal/health", origin);
    const request = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "GET"
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          request.destroy(new Error("Product-detail health endpoint response exceeded the smoke-test limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve({ statusCode: response.statusCode, payload });
        } catch {
          reject(new Error("Product-detail health endpoint returned invalid JSON"));
        }
      });
    });
    request.setTimeout(15_000, () => request.destroy(new Error("Product-detail health endpoint timed out")));
    request.on("error", () => reject(new Error("Product-detail health endpoint request failed")));
    request.end();
  });
}

function writeProductDetailReleaseSmokeResult(dataDir, payload) {
  fs.writeFileSync(
    path.join(dataDir, "product-detail-release-smoke.json"),
    `${JSON.stringify(payload)}\n`,
    "utf8"
  );
}

function invokeProductDetail(window, method) {
  return window.webContents.executeJavaScript(`
    (() => {
      const api = window.xiaoxiProductDetail;
      if (!api || typeof api[${JSON.stringify(method)}] !== "function") {
        throw new Error("Product-detail IPC bridge is unavailable");
      }
      return api[${JSON.stringify(method)}]();
    })()
  `, true);
}

async function runProductDetailReleaseSmoke({
  BrowserWindow,
  controller,
  dataDir,
  preloadPath,
  webPreferences,
  requestHealth = requestProductDetailSmokeHealth
} = {}) {
  if (typeof BrowserWindow !== "function") throw new Error("Product-detail smoke requires BrowserWindow");
  if (!controller || typeof controller.dispose !== "function") {
    throw new Error("Product-detail smoke requires its controller");
  }
  if (!path.isAbsolute(String(dataDir || "")) || !fs.existsSync(dataDir)) {
    throw new Error("Product-detail smoke requires an initialized isolated data directory");
  }
  if (!path.isAbsolute(String(preloadPath || ""))) {
    throw new Error("Product-detail smoke requires the packaged preload");
  }
  if (!webPreferences || typeof webPreferences !== "object" || Array.isArray(webPreferences)) {
    throw new Error("Product-detail smoke requires packaged web preferences");
  }

  let primaryError = null;
  try {
    const smokeWindow = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        ...webPreferences,
        preload: preloadPath
      }
    });
    await smokeWindow.loadURL("data:text/html,<title>product-detail-release-smoke</title>");
    const initial = await invokeProductDetail(smokeWindow, "status");
    if (!initial?.ok || initial.data?.state !== "stopped" || initial.data?.available !== true) {
      throw new Error("Product-detail packaged smoke did not discover the bundled runtime through IPC");
    }
    const started = await invokeProductDetail(smokeWindow, "start");
    if (!started?.ok || started.data?.state !== "ready" || started.data?.available !== true) {
      throw new Error("Product-detail packaged smoke could not start the sidecar through IPC");
    }
    const status = await invokeProductDetail(smokeWindow, "status");
    if (!status?.ok || status.data?.state !== "ready" || !String(status.data?.origin || "").startsWith("http://")) {
      throw new Error("Product-detail packaged smoke did not receive a ready IPC status");
    }
    const health = await requestHealth(status.data.origin);
    if (
      health.statusCode !== 200
      || health.payload?.ok !== true
      || health.payload?.status !== "ready"
      || health.payload?.version !== status.data.version
    ) {
      throw new Error("Product-detail packaged smoke health check failed");
    }
    const stopped = await invokeProductDetail(smokeWindow, "stop");
    if (!stopped?.ok || stopped.data?.state !== "stopped") {
      throw new Error("Product-detail packaged smoke could not stop the sidecar through IPC");
    }
    const finalStatus = await invokeProductDetail(smokeWindow, "status");
    if (!finalStatus?.ok || finalStatus.data?.state !== "stopped") {
      throw new Error("Product-detail packaged smoke did not receive a stopped IPC status");
    }
    const result = {
      ok: true,
      version: status.data.version,
      ipc: true,
      health: true,
      stopped: true
    };
    writeProductDetailReleaseSmokeResult(dataDir, result);
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await controller.dispose();
    } catch (error) {
      if (!primaryError) throw error;
    }
  }
}

module.exports = {
  invokeProductDetail,
  requestProductDetailSmokeHealth,
  runProductDetailReleaseSmoke,
  writeProductDetailReleaseSmokeResult
};
