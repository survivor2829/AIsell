const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createProductDetailSidecar
} = require("./product-detail-sidecar.cjs");

class FakeChild extends EventEmitter {
  constructor({ closeOnKill = true } = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killedSignals = [];
    this.closeOnKill = closeOnKill;
  }

  kill(signal) {
    this.killedSignals.push(signal);
    if (this.closeOnKill) {
      setImmediate(() => this.emit("close", null, signal));
    }
    return true;
  }
}

function ready(child, overrides = {}) {
  const payload = {
    event: "ready",
    host: "127.0.0.1",
    port: 43123,
    version: "1.0.0",
    capabilities: { upload: true, export_png: true },
    ...overrides
  };
  child.stdout.emit("data", Buffer.from(`${JSON.stringify(payload)}\n`, "utf8"));
}

async function waitFor(predicate, timeoutMs = 200) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-product-detail-sidecar-"));
  const runtimePath = path.join(root, "product-detail-sidecar.exe");
  const browserPath = path.join(root, "browser", "chrome.exe");
  const dataDir = path.join(root, "data");
  fs.writeFileSync(runtimePath, "");
  fs.mkdirSync(path.dirname(browserPath), { recursive: true });
  fs.writeFileSync(browserPath, "");

  try {
    {
      let spawnCount = 0;
      const controller = createProductDetailSidecar({
        runtimePath: "",
        dataDir,
        existsSync: () => false,
        spawnProcess: () => {
          spawnCount += 1;
          return new FakeChild();
        }
      });
      assert.deepEqual(controller.status(), {
        state: "unavailable",
        available: false,
        origin: "",
        bootstrapUrl: "",
        version: "",
        capabilities: {},
        code: "PRODUCT_DETAIL_RUNTIME_UNAVAILABLE"
      });
      assert.equal((await controller.start()).state, "unavailable");
      assert.equal(spawnCount, 0);
    }

    {
      const children = [];
      const spawnCalls = [];
      let randomCall = 0;
      const updates = [];
      const controller = createProductDetailSidecar({
        runtimePath,
        dataDir,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: "must-not-leak",
          DEEPSEEK_MODEL: "must-not-leak",
          REFINE_API_KEY: "must-not-leak",
          REFINE_API_BASE_URL: "https://paid.invalid/v1",
          GPT_IMAGE_API_KEY: "must-not-leak",
          ARK_API_KEY: "must-not-leak",
          DASHSCOPE_API_KEY: "must-not-leak",
          DEFAULT_REFINE_ENGINE: "must-not-leak",
          V2_ALLOW_REAL_API: "true",
          FLASK_ENV: "development"
        },
        startupTimeoutMs: 100,
        randomBytes: (size) => Buffer.alloc(size, ++randomCall),
        spawnProcess: (command, args, options) => {
          const child = new FakeChild();
          children.push(child);
          spawnCalls.push({ command, args, options });
          return child;
        },
        requestShutdown: async () => {
          throw new Error("not used");
        }
      });
      controller.onUpdate((status) => updates.push(status));
      const first = controller.start();
      const second = controller.start();
      await waitFor(() => spawnCalls.length === 1);
      assert.equal(spawnCalls.length, 1, "parallel start calls must share one child");
      assert.equal(spawnCalls[0].command, runtimePath);
      assert.equal(spawnCalls[0].options.windowsHide, true);
      assert.equal(spawnCalls[0].options.shell, false);
      for (const key of [
        "DEEPSEEK_API_KEY",
        "DEEPSEEK_MODEL",
        "REFINE_API_KEY",
        "REFINE_API_BASE_URL",
        "GPT_IMAGE_API_KEY",
        "ARK_API_KEY",
        "DASHSCOPE_API_KEY",
        "DEFAULT_REFINE_ENGINE",
        "V2_ALLOW_REAL_API",
        "FLASK_ENV"
      ]) {
        assert.equal(spawnCalls[0].options.env[key], "", `${key} must not reach the desktop sidecar`);
      }
      assert.deepEqual(spawnCalls[0].args.slice(0, 6), [
        "--host", "127.0.0.1",
        "--port", "0",
        "--data-dir", dataDir
      ]);
      const bootstrapToken = spawnCalls[0].args[spawnCalls[0].args.indexOf("--bootstrap-token") + 1];
      const controlToken = spawnCalls[0].args[spawnCalls[0].args.indexOf("--control-token") + 1];
      assert.match(bootstrapToken, /^[a-f0-9]{64}$/);
      assert.match(controlToken, /^[a-f0-9]{64}$/);
      assert.notEqual(bootstrapToken, controlToken, "bootstrap and control tokens must be independent");

      ready(children[0]);
      const [firstResult, secondResult] = await Promise.all([first, second]);
      assert.equal(firstResult.state, "ready");
      assert.deepEqual(secondResult, firstResult);
      assert.equal(firstResult.origin, "http://localhost:43123");
      assert.equal(
        firstResult.bootstrapUrl,
        `http://localhost:43123/desktop/bootstrap?token=${bootstrapToken}`
      );
      assert.deepEqual(firstResult.capabilities, { upload: true, export_png: true });
      const serialized = JSON.stringify({ firstResult, updates });
      assert.equal(serialized.includes(controlToken), false);
      assert.equal(serialized.includes(runtimePath), false);

      children[0].emit("close", 9, null);
      await waitFor(() => controller.status().state === "failed");
      assert.equal(controller.status().code, "PRODUCT_DETAIL_EXITED");
      controller.dispose();
    }

    {
      let child;
      let spawnOptions;
      let providerReads = 0;
      const controller = createProductDetailSidecar({
        runtimePath,
        dataDir,
        env: {
          ...process.env,
          ARK_API_KEY: "inherited-secret-must-stay-blocked",
          GPT_IMAGE_API_KEY: "inherited-secret-must-stay-blocked"
        },
        getProviderEnvironment: async () => {
          providerReads += 1;
          return {
            DEEPSEEK_API_KEY: " desktop-deepseek-key ",
            DEEPSEEK_MODEL: " deepseek-v4-flash ",
            REFINE_API_KEY: " desktop-apimart-key ",
            REFINE_API_BASE_URL: " https://api.apimart.ai/v1 ",
            ARK_API_KEY: "must-be-ignored",
            PATH: "must-be-ignored"
          };
        },
        getTrustedRuntimeEnvironment: () => ({
          XIAOXI_PRODUCT_DETAIL_BROWSER_PATH: browserPath,
          PATH: "must-be-ignored"
        }),
        startupTimeoutMs: 100,
        stopTimeoutMs: 5,
        spawnProcess: (_command, _args, options) => {
          child = new FakeChild();
          spawnOptions = options;
          return child;
        },
        requestShutdown: async () => {
          throw new Error("force fallback");
        }
      });
      const started = controller.start();
      await waitFor(() => Boolean(child));
      assert.equal(providerReads, 1);
      assert.equal(spawnOptions.env.DEEPSEEK_API_KEY, "desktop-deepseek-key");
      assert.equal(spawnOptions.env.DEEPSEEK_MODEL, "deepseek-v4-flash");
      assert.equal(spawnOptions.env.REFINE_API_KEY, "desktop-apimart-key");
      assert.equal(spawnOptions.env.REFINE_API_BASE_URL, "https://api.apimart.ai/v1");
      assert.equal(spawnOptions.env.ARK_API_KEY, "");
      assert.equal(spawnOptions.env.GPT_IMAGE_API_KEY, "");
      assert.notEqual(spawnOptions.env.PATH, "must-be-ignored");
      assert.equal(spawnOptions.env.XIAOXI_PRODUCT_DETAIL_BROWSER_PATH, browserPath);
      ready(child, { capabilities: { paid_ai_ready: true } });
      const status = await started;
      assert.equal(status.capabilities.paid_ai_ready, true);
      assert.equal(JSON.stringify(status).includes("desktop-apimart-key"), false);
      await controller.dispose();
    }
    {
      let child;
      const controller = createProductDetailSidecar({
        runtimePath,
        dataDir,
        startupTimeoutMs: 100,
        spawnProcess: () => {
          child = new FakeChild();
          return child;
        }
      });
      const started = controller.start();
      await waitFor(() => Boolean(child));
      ready(child, { host: "attacker.example", port: 443 });
      const result = await started;
      assert.equal(result.state, "failed");
      assert.equal(result.code, "PRODUCT_DETAIL_READY_INVALID");
      assert.deepEqual(child.killedSignals, ["SIGTERM"]);
    }

    {
      let child;
      const controller = createProductDetailSidecar({
        runtimePath,
        dataDir,
        startupTimeoutMs: 100,
        spawnProcess: () => {
          child = new FakeChild();
          return child;
        }
      });
      const started = controller.start();
      await waitFor(() => Boolean(child));
      child.stdout.emit("data", Buffer.from("{not-json}\n", "utf8"));
      const result = await started;
      assert.equal(result.state, "failed");
      assert.equal(result.code, "PRODUCT_DETAIL_READY_INVALID");
      assert.deepEqual(child.killedSignals, ["SIGTERM"]);
    }

    {
      let child;
      const controller = createProductDetailSidecar({
        runtimePath,
        dataDir,
        startupTimeoutMs: 10,
        spawnProcess: () => {
          child = new FakeChild();
          return child;
        }
      });
      const result = await controller.start();
      assert.equal(result.state, "failed");
      assert.equal(result.code, "PRODUCT_DETAIL_START_TIMEOUT");
      assert.deepEqual(child.killedSignals, ["SIGTERM"]);
    }

    {
      let child;
      let shutdownRequest;
      let spawnedControlToken = "";
      const controller = createProductDetailSidecar({
        runtimePath,
        dataDir,
        startupTimeoutMs: 100,
        stopTimeoutMs: 100,
        spawnProcess: (_command, args) => {
          child = new FakeChild({ closeOnKill: false });
          spawnedControlToken = args[args.indexOf("--control-token") + 1];
          return child;
        },
        requestShutdown: async (request) => {
          shutdownRequest = request;
          setImmediate(() => child.emit("close", 0, null));
        }
      });
      const started = controller.start();
      await waitFor(() => Boolean(child));
      ready(child);
      await started;
      const stopped = await controller.stop();
      assert.equal(stopped.state, "stopped");
      assert.equal(shutdownRequest.url, "http://localhost:43123/internal/shutdown");
      assert.equal(shutdownRequest.controlToken, spawnedControlToken);
      assert.equal(child.killedSignals.length, 0, "graceful shutdown must not kill the child");
    }

    {
      let child;
      const controller = createProductDetailSidecar({
        runtimePath,
        dataDir,
        startupTimeoutMs: 100,
        stopTimeoutMs: 20,
        spawnProcess: () => {
          child = new FakeChild();
          return child;
        },
        requestShutdown: async () => {
          throw new Error("private shutdown failure");
        }
      });
      const started = controller.start();
      await waitFor(() => Boolean(child));
      ready(child);
      await started;
      const stopped = await controller.stop();
      assert.equal(stopped.state, "stopped");
      assert.deepEqual(child.killedSignals, ["SIGTERM"]);
      assert.equal(JSON.stringify(stopped).includes("private shutdown failure"), false);
    }

    {
      let child;
      const controller = createProductDetailSidecar({
        runtimePath,
        dataDir,
        startupTimeoutMs: 100,
        stopTimeoutMs: 5,
        spawnProcess: () => {
          child = new FakeChild({ closeOnKill: false });
          return child;
        },
        requestShutdown: async () => {
          throw new Error("force fallback");
        }
      });
      const started = controller.start();
      await waitFor(() => Boolean(child));
      ready(child);
      await started;
      const stopped = await controller.stop();
      assert.equal(stopped.state, "failed");
      assert.equal(stopped.code, "PRODUCT_DETAIL_STOP_TIMEOUT");
      assert.deepEqual(child.killedSignals, ["SIGTERM"]);
      assert.equal(controller.status().state, "failed");
      await controller.dispose();
    }

    {
      let child;
      let spawnCount = 0;
      const controller = createProductDetailSidecar({
        runtimePath,
        dataDir,
        startupTimeoutMs: 100,
        stopTimeoutMs: 20,
        spawnProcess: () => {
          spawnCount += 1;
          child = new FakeChild();
          return child;
        },
        requestShutdown: async () => {
          throw new Error("force fallback");
        }
      });
      const first = controller.start();
      await waitFor(() => Boolean(child));
      ready(child);
      await first;
      const restarted = controller.restart();
      await waitFor(() => spawnCount === 2);
      ready(child, { port: 43124, version: "1.0.1" });
      const result = await restarted;
      assert.equal(result.state, "ready");
      assert.equal(result.origin, "http://localhost:43124");
      assert.equal(spawnCount, 2);
      await controller.dispose();
    }

    {
      const children = [];
      const controller = createProductDetailSidecar({
        runtimePath,
        dataDir,
        startupTimeoutMs: 100,
        stopTimeoutMs: 5,
        spawnProcess: () => {
          const child = new FakeChild({ closeOnKill: false });
          children.push(child);
          return child;
        },
        requestShutdown: async () => {
          throw new Error("force fallback");
        }
      });
      const first = controller.start();
      await waitFor(() => children.length === 1);
      ready(children[0]);
      await first;
      const stopped = await controller.stop();
      assert.equal(stopped.code, "PRODUCT_DETAIL_STOP_TIMEOUT");
      const restarted = await controller.restart();
      assert.equal(restarted.code, "PRODUCT_DETAIL_STOP_TIMEOUT");
      const startedAgain = await controller.start();
      assert.equal(startedAgain.code, "PRODUCT_DETAIL_STOP_TIMEOUT");
      assert.equal(children.length, 1, "a non-closing sidecar must not be replaced");
      children[0].emit("close", null, "SIGTERM");
      await waitFor(() => controller.status().state === "stopped");
      await controller.dispose();
    }

    console.log("product-detail sidecar self-check passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
