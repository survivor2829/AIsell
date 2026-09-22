const { spawn } = require("node:child_process");
const path = require("node:path");
const electronPath = require("electron");
const { resolveDevelopmentContentEngineLaunch } = require("../src/main/development-sidecar-runtime.cjs");
const { startApimartTestRelay } = require("./apimart-test-relay.cjs");

const developmentEnv = { ...process.env, XIAOXI_EDITION: "development", VITE_XIAOXI_EDITION: "development" };

function resolveDevServerPort(rawValue = developmentEnv.XIAOXI_DEV_SERVER_PORT) {
  const raw = rawValue == null ? "" : String(rawValue).trim();
  if (!raw) return 5173;
  if (!/^\d+$/.test(raw)) {
    throw new Error("XIAOXI_DEV_SERVER_PORT must be an integer between 1024 and 65535.");
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error("XIAOXI_DEV_SERVER_PORT must be an integer between 1024 and 65535.");
  }
  return port;
}

function startDesktop() {
  const devServerPort = resolveDevServerPort();
  const url = `http://127.0.0.1:${devServerPort}`;
  const viteCli = path.join(path.dirname(require.resolve("vite")), "bin", "vite.js");
  const apimartRelay = startApimartTestRelay();
  if (!developmentEnv.XIAOXI_CONTENT_ENGINE_SIDECAR) {
    const launch = resolveDevelopmentContentEngineLaunch({ environment: developmentEnv });
    if (launch.runtimePath) {
      developmentEnv.XIAOXI_CONTENT_ENGINE_SIDECAR = launch.runtimePath;
      developmentEnv.XIAOXI_CONTENT_ENGINE_SIDECAR_ENTRY = launch.runtimeArgs[0] || "";
    }
  }
  const vite = spawn(
    process.execPath,
    [viteCli, "--host", "127.0.0.1", "--port", String(devServerPort), "--strictPort"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: developmentEnv,
      windowsHide: true
    }
  );
  let electronStarted = false;
  let electronExited = false;
  let startupFailed = false;
  let startupTimer = null;
  let viteOutput = "";

  function failStartup(message) {
    if (startupFailed) return;
    startupFailed = true;
    if (startupTimer) clearTimeout(startupTimer);
    console.error(message);
    vite.kill();
    apimartRelay.stop();
    process.exitCode = 1;
  }

  function startElectron() {
    if (startupFailed || electronStarted) return;
    electronStarted = true;
    if (startupTimer) clearTimeout(startupTimer);
    const electronEnv = { ...developmentEnv, VITE_DEV_SERVER_URL: url };
    delete electronEnv.ELECTRON_RUN_AS_NODE;
    const electron = spawn(electronPath, ["."], {
      stdio: "inherit",
      env: electronEnv
    });
    electron.once("error", (error) => failStartup(`Electron could not start: ${error.message}`));
    electron.on("exit", () => {
      electronExited = true;
      vite.kill();
      apimartRelay.stop();
    });
  }

  function observeViteOutput(chunk, stream) {
    stream.write(chunk);
    viteOutput = `${viteOutput}${chunk}`.slice(-4096);
    if (viteOutput.includes(`${url}/`)) startElectron();
  }

  vite.stdout.on("data", (chunk) => observeViteOutput(chunk, process.stdout));
  vite.stderr.on("data", (chunk) => observeViteOutput(chunk, process.stderr));
  vite.once("error", (error) => failStartup(`Vite dev server could not start: ${error.message}`));
  vite.once("exit", (code, signal) => {
    if (!electronStarted && !startupFailed) {
      failStartup(`Vite dev server stopped before Electron started (code ${code ?? "unknown"}, signal ${signal || "none"}).`);
    } else if (electronStarted && !electronExited && !startupFailed) {
      console.error(`页面开发服务已停止（code ${code ?? "unknown"}, signal ${signal || "none"}），应用页面将无法加载。请查看上方错误，关闭应用后重新运行 npm.cmd run desktop。`);
      process.exitCode = 1;
    }
  });
  startupTimer = setTimeout(() => failStartup(`Vite dev server did not start at ${url}.`), 20_000);
}

if (require.main === module) {
  startDesktop();
}

module.exports = { resolveDevServerPort };
