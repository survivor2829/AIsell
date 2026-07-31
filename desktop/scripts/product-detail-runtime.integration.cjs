const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const {
  createProductDetailSidecar
} = require("../src/main/product-detail-sidecar.cjs");

const desktopDir = path.resolve(__dirname, "..");
const buildRoot = path.join(desktopDir, ".build");
const runtimePath = path.join(
  buildRoot,
  "product-detail-runtime",
  "product-detail-server.exe"
);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const SESSION_COOKIE_NAME = "xiaoxi_product_detail_session";

function request(url, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          req.destroy(new Error("HTTP response exceeded the integration-test limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    req.setTimeout(15_000, () => {
      req.destroy(new Error("HTTP request timed out"));
    });
    req.on("error", () => reject(new Error("HTTP request failed")));
    req.end();
  });
}

function parseJson(body, label) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function sessionCookie(headers) {
  const values = Array.isArray(headers["set-cookie"])
    ? headers["set-cookie"]
    : [headers["set-cookie"]].filter(Boolean);
  for (const value of values) {
    const cookie = String(value);
    const pair = cookie.split(";", 1)[0];
    if (!pair.startsWith(`${SESSION_COOKIE_NAME}=`)) continue;
    assert.match(cookie, /;\s*HttpOnly(?:;|$)/i);
    assert.match(cookie, /;\s*Secure(?:;|$)/i);
    assert.match(cookie, /;\s*SameSite=None(?:;|$)/i);
    assert.match(cookie, /;\s*Partitioned(?:;|$)/i);
    return pair;
  }
  return "";
}

function waitForChildExit(child, timeoutMs = 15_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.removeListener("close", onClose);
      reject(new Error("Product-detail process did not exit after controller.stop"));
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timeout);
      resolve();
    };
    child.once("close", onClose);
  });
}

async function main() {
  if (!fs.existsSync(runtimePath) || !fs.statSync(runtimePath).isFile()) {
    throw new Error(
      "Product-detail runtime is missing; run npm.cmd run build:product-detail first"
    );
  }

  fs.mkdirSync(buildRoot, { recursive: true });
  const dataDir = fs.mkdtempSync(
    path.join(buildRoot, `product-detail-runtime-integration-${process.pid}-`)
  );
  let child = null;
  const controller = createProductDetailSidecar({
    runtimePath,
    dataDir,
    startupTimeoutMs: 120_000,
    stopTimeoutMs: 15_000,
    spawnProcess: (command, args, options) => {
      child = spawn(command, args, options);
      return child;
    }
  });

  let stoppedByTest = false;
  try {
    const ready = await controller.start();
    assert.equal(ready.state, "ready", `sidecar start failed: ${ready.code || "unknown"}`);
    assert.equal(ready.available, true);
    assert.match(ready.version, /^[a-z0-9._+-]+$/i);
    assert.equal(ready.capabilities.offline_workspace, true);
    assert.equal(ready.capabilities.playwright, true);

    const origin = new URL(ready.origin);
    assert.equal(origin.protocol, "http:");
    assert.equal(LOOPBACK_HOSTS.has(origin.hostname.toLowerCase()), true);
    assert.equal(origin.username, "");
    assert.equal(origin.password, "");

    const healthResponse = await request(`${ready.origin}/internal/health`);
    assert.equal(healthResponse.statusCode, 200);
    const health = parseJson(healthResponse.body, "Health endpoint");
    assert.equal(health.ok, true);
    assert.equal(health.status, "ready");
    assert.equal(health.mode, "desktop");
    assert.equal(health.version, ready.version);
    assert.equal(health.capabilities.offline_workspace, true);
    assert.equal(health.capabilities.playwright, true);

    const privateResponse = await request(
      `${ready.origin}/static/uploads/1/private.png`
    );
    assert.equal(privateResponse.statusCode, 401);

    const bootstrapResponse = await request(ready.bootstrapUrl);
    assert.equal(bootstrapResponse.statusCode, 302);
    assert.equal(bootstrapResponse.headers.location, "/");
    const cookie = sessionCookie(bootstrapResponse.headers);
    assert.notEqual(cookie, "", "bootstrap did not establish a session");

    const paidResponse = await request(
      `${ready.origin}/api/generate-ai-images`,
      {
        method: "POST",
        headers: {
          "content-length": "0",
          cookie
        }
      }
    );
    assert.equal(paidResponse.statusCode, 503);
    assert.equal(
      parseJson(paidResponse.body, "Paid endpoint").code,
      "DESKTOP_PAID_ACTION_DISABLED"
    );

    const stopped = await controller.stop();
    stoppedByTest = true;
    assert.equal(stopped.state, "stopped");
    await waitForChildExit(child);
    assert.notEqual(child.exitCode, null);

    console.log(
      `product-detail runtime integration passed (version ${ready.version}, data kept for inspection)`
    );
  } finally {
    if (!stoppedByTest) {
      try {
        await controller.stop();
      } catch {
        // Preserve the original test failure.
      }
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Best-effort leak prevention only; controller.stop is the tested path.
      }
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  console.error(`product-detail runtime integration failed: ${message}`);
  process.exitCode = 1;
});
