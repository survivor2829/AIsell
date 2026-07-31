const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_READY_LINE_BYTES = 64 * 1024;
const DESKTOP_BLOCKED_PROVIDER_ENV_KEYS = Object.freeze([
  "DEEPSEEK_API_KEY",
  "REFINE_API_KEY",
  "REFINE_API_BASE_URL",
  "GPT_IMAGE_API_KEY",
  "ARK_API_KEY",
  "DASHSCOPE_API_KEY"
]);

function tokenFrom(randomBytes) {
  return randomBytes(32).toString("hex");
}

function sanitizeCapabilities(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sanitized = {};
  for (const [key, enabled] of Object.entries(value)) {
    if (/^[a-z0-9_-]{1,64}$/i.test(key) && typeof enabled === "boolean") {
      sanitized[key] = enabled;
    }
  }
  return sanitized;
}

function parseReadyLine(line) {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    return null;
  }
  if (!payload || payload.event !== "ready") return null;
  if (!LOOPBACK_HOSTS.has(String(payload.host || "").toLowerCase())) return null;
  if (!Number.isInteger(payload.port) || payload.port < 1 || payload.port > 65_535) return null;
  const version = String(payload.version || "");
  if (version.length > 64 || (version && !/^[a-z0-9._+-]+$/i.test(version))) return null;
  return {
    port: payload.port,
    version,
    capabilities: sanitizeCapabilities(payload.capabilities)
  };
}

function defaultShutdownRequest({ url, controlToken, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers: {
        "content-length": "0",
        "x-xiaoxi-control-token": controlToken
      }
    }, (response) => {
      response.resume();
      if (response.statusCode >= 200 && response.statusCode < 300) {
        resolve();
        return;
      }
      const error = new Error("sidecar rejected shutdown");
      error.code = "PRODUCT_DETAIL_SHUTDOWN_REJECTED";
      reject(error);
    });
    request.setTimeout(timeoutMs, () => {
      const error = new Error("sidecar shutdown timed out");
      error.code = "PRODUCT_DETAIL_SHUTDOWN_TIMEOUT";
      request.destroy(error);
    });
    request.on("error", reject);
    request.end();
  });
}

function createProductDetailSidecar(options = {}) {
  const environment = options.env || process.env;
  const runtimePath = String(
    options.runtimePath
      ?? environment.XIAOXI_PRODUCT_DETAIL_SIDECAR
      ?? ""
  ).trim();
  const dataDir = String(options.dataDir ?? "").trim();
  const existsSync = options.existsSync || fs.existsSync;
  const mkdirSync = options.mkdirSync || fs.mkdirSync;
  const spawnProcess = options.spawnProcess || spawn;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const requestShutdown = options.requestShutdown || defaultShutdownRequest;
  const startupTimeoutMs = Math.max(1, Number(options.startupTimeoutMs) || 30_000);
  const stopTimeoutMs = Math.max(1, Number(options.stopTimeoutMs) || 3_000);
  const listeners = new Set();

  let currentRun = null;
  let startPromise = null;
  let stopPromise = null;
  let disposed = false;
  let snapshot = {
    state: runtimePath && existsSync(runtimePath) ? "stopped" : "unavailable",
    available: Boolean(runtimePath && existsSync(runtimePath)),
    origin: "",
    bootstrapUrl: "",
    version: "",
    capabilities: {},
    code: runtimePath && existsSync(runtimePath) ? "" : "PRODUCT_DETAIL_RUNTIME_UNAVAILABLE"
  };

  function status() {
    return {
      state: snapshot.state,
      available: snapshot.available,
      origin: snapshot.origin,
      bootstrapUrl: snapshot.bootstrapUrl,
      version: snapshot.version,
      capabilities: { ...snapshot.capabilities },
      code: snapshot.code
    };
  }

  function notify() {
    const update = status();
    for (const listener of listeners) {
      try {
        listener(update);
      } catch {
        // One UI observer must never break sidecar lifecycle management.
      }
    }
  }

  function update(next) {
    snapshot = {
      ...snapshot,
      ...next,
      capabilities: next.capabilities ? { ...next.capabilities } : snapshot.capabilities
    };
    notify();
    return status();
  }

  function setTerminalState(state, code = "") {
    return update({
      state,
      available: state !== "unavailable",
      origin: "",
      bootstrapUrl: "",
      version: "",
      capabilities: {},
      code
    });
  }

  function runtimeIsAvailable() {
    return Boolean(runtimePath && existsSync(runtimePath));
  }

  function waitForClose(run, timeoutMs) {
    if (run.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        run.closeWaiters.delete(onClose);
        resolve(false);
      }, timeoutMs);
      const onClose = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      run.closeWaiters.add(onClose);
    });
  }

  function settleCloseWaiters(run) {
    const waiters = [...run.closeWaiters];
    run.closeWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  function killRun(run) {
    if (!run || run.closed || run.killRequested) return;
    run.killRequested = true;
    try {
      run.child.kill("SIGTERM");
    } catch {
      // A failed kill is handled by the bounded stop path.
    }
  }

  function beginStart() {
    if (disposed) return Promise.resolve(setTerminalState("stopped"));
    if (!runtimeIsAvailable()) {
      return Promise.resolve(setTerminalState(
        "unavailable",
        "PRODUCT_DETAIL_RUNTIME_UNAVAILABLE"
      ));
    }
    if (snapshot.state === "ready" && currentRun && !currentRun.closed) {
      return Promise.resolve(status());
    }
    if (!dataDir || !path.isAbsolute(dataDir)) {
      return Promise.resolve(setTerminalState(
        "failed",
        "PRODUCT_DETAIL_DATA_DIR_INVALID"
      ));
    }

    try {
      mkdirSync(dataDir, { recursive: true });
    } catch {
      return Promise.resolve(setTerminalState(
        "failed",
        "PRODUCT_DETAIL_DATA_DIR_FAILED"
      ));
    }

    const bootstrapToken = tokenFrom(randomBytes);
    const controlToken = tokenFrom(randomBytes);
    const args = [
      "--host", "127.0.0.1",
      "--port", "0",
      "--data-dir", dataDir,
      "--bootstrap-token", bootstrapToken,
      "--control-token", controlToken
    ];

    update({
      state: "starting",
      available: true,
      origin: "",
      bootstrapUrl: "",
      version: "",
      capabilities: {},
      code: ""
    });

    return new Promise((resolve) => {
      let child;
      try {
        const childEnvironment = { ...environment };
        for (const key of DESKTOP_BLOCKED_PROVIDER_ENV_KEYS) {
          childEnvironment[key] = "";
        }
        child = spawnProcess(runtimePath, args, {
          windowsHide: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: childEnvironment
        });
      } catch {
        resolve(setTerminalState("failed", "PRODUCT_DETAIL_SPAWN_FAILED"));
        return;
      }

      const run = {
        bootstrapToken,
        child,
        closed: false,
        closeWaiters: new Set(),
        controlToken,
        failureCode: "",
        killRequested: false,
        ready: false,
        settled: false,
        startupTimer: null,
        stderrBytes: 0,
        stdoutBuffer: "",
        stopping: false
      };
      currentRun = run;

      function settleStart(result) {
        if (run.settled) return;
        run.settled = true;
        clearTimeout(run.startupTimer);
        resolve(result);
      }
      run.settleStart = settleStart;

      function failStart(code) {
        if (run.ready || run.closed) return;
        run.failureCode = code;
        const result = setTerminalState("failed", code);
        killRun(run);
        settleStart(result);
      }

      child.stdout?.on("data", (chunk) => {
        if (run.ready || run.closed) return;
        run.stdoutBuffer += chunk.toString("utf8");
        if (Buffer.byteLength(run.stdoutBuffer, "utf8") > MAX_READY_LINE_BYTES) {
          failStart("PRODUCT_DETAIL_READY_INVALID");
          return;
        }
        const newlineIndex = run.stdoutBuffer.indexOf("\n");
        if (newlineIndex < 0) return;
        const line = run.stdoutBuffer.slice(0, newlineIndex).trim();
        const trailing = run.stdoutBuffer.slice(newlineIndex + 1).trim();
        if (!line || trailing) {
          failStart("PRODUCT_DETAIL_READY_INVALID");
          return;
        }
        const readyPayload = parseReadyLine(line);
        if (!readyPayload) {
          failStart("PRODUCT_DETAIL_READY_INVALID");
          return;
        }
        run.ready = true;
        clearTimeout(run.startupTimer);
        const origin = `http://localhost:${readyPayload.port}`;
        settleStart(update({
          state: "ready",
          available: true,
          origin,
          bootstrapUrl: `${origin}/desktop/bootstrap?token=${encodeURIComponent(bootstrapToken)}`,
          version: readyPayload.version,
          capabilities: readyPayload.capabilities,
          code: ""
        }));
      });

      child.stderr?.on("data", (chunk) => {
        run.stderrBytes += Buffer.byteLength(chunk);
      });

      child.once("error", () => {
        if (!run.ready) {
          failStart("PRODUCT_DETAIL_SPAWN_FAILED");
          return;
        }
        run.failureCode = "PRODUCT_DETAIL_EXITED";
      });

      child.once("close", () => {
        run.closed = true;
        clearTimeout(run.startupTimer);
        settleCloseWaiters(run);
        if (currentRun !== run) {
          settleStart(status());
          return;
        }
        currentRun = null;
        if (run.stopping || disposed) {
          const result = setTerminalState("stopped");
          settleStart(result);
          return;
        }
        const result = setTerminalState(
          "failed",
          run.failureCode || "PRODUCT_DETAIL_EXITED"
        );
        settleStart(result);
      });

      run.startupTimer = setTimeout(() => {
        failStart("PRODUCT_DETAIL_START_TIMEOUT");
      }, startupTimeoutMs);
    });
  }

  function start() {
    if (startPromise) return startPromise;
    const hasOldRun = Boolean(
      currentRun
      && !currentRun.closed
      && snapshot.state !== "ready"
    );
    const waitForStop = stopPromise || (hasOldRun ? stop() : Promise.resolve());
    startPromise = waitForStop
      .then(() => beginStart())
      .finally(() => {
        startPromise = null;
      });
    return startPromise;
  }

  async function performStop() {
    const run = currentRun;
    if (!run || run.closed) {
      return runtimeIsAvailable()
        ? setTerminalState("stopped")
        : setTerminalState("unavailable", "PRODUCT_DETAIL_RUNTIME_UNAVAILABLE");
    }

    run.stopping = true;
    clearTimeout(run.startupTimer);

    let closed = false;
    if (run.ready && snapshot.origin) {
      try {
        await Promise.race([
          requestShutdown({
            url: `${snapshot.origin}/internal/shutdown`,
            controlToken: run.controlToken,
            timeoutMs: stopTimeoutMs
          }),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("shutdown request timed out")), stopTimeoutMs);
          })
        ]);
        closed = await waitForClose(run, stopTimeoutMs);
      } catch {
        closed = run.closed;
      }
    }

    if (!closed) {
      killRun(run);
      closed = await waitForClose(run, stopTimeoutMs);
    }

    if (!closed) {
      run.closed = true;
      settleCloseWaiters(run);
      if (currentRun === run) currentRun = null;
    }
    const result = setTerminalState("stopped");
    if (typeof run.settleStart === "function") run.settleStart(result);
    return result;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = performStop().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }

  async function restart() {
    await stop();
    if (disposed) return status();
    return start();
  }

  async function dispose() {
    disposed = true;
    const result = await stop();
    listeners.clear();
    return result;
  }

  function onUpdate(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    dispose,
    onUpdate,
    restart,
    start,
    status,
    stop
  };
}

module.exports = {
  createProductDetailSidecar,
  defaultShutdownRequest,
  parseReadyLine
};
