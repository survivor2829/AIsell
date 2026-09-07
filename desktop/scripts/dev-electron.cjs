const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const electronPath = require("electron");

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

function findDevelopmentPython() {
  const candidates = [
    developmentEnv.XIAOXI_CONTENT_ENGINE_DEV_PYTHON,
    path.join(__dirname, "..", ".build", "product-detail-venv", "Scripts", "python.exe"),
    path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe")
  ];
  for (const candidate of candidates.map((value) => String(value || "").trim()).filter(Boolean)) {
    if (!fs.existsSync(candidate)) continue;
    const check = spawnSync(candidate, ["-c", "import sys; assert sys.version_info >= (3, 10)"], {
      encoding: "utf8",
      windowsHide: true
    });
    if (check.status === 0) return candidate;
  }
  return "";
}

function startDesktop() {
  const devServerPort = resolveDevServerPort();
  const url = `http://127.0.0.1:${devServerPort}`;
  const viteCli = path.join(path.dirname(require.resolve("vite")), "bin", "vite.js");
  if (!developmentEnv.XIAOXI_CONTENT_ENGINE_SIDECAR) {
    const python = findDevelopmentPython();
    const worker = path.join(__dirname, "..", "sidecars", "content-engine", "worker.py");
    if (python && fs.existsSync(worker)) {
      developmentEnv.XIAOXI_CONTENT_ENGINE_SIDECAR = python;
      developmentEnv.XIAOXI_CONTENT_ENGINE_SIDECAR_ENTRY = worker;
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
    process.exitCode = 1;
  }

  function startElectron() {
    if (startupFailed || electronStarted) return;
    electronStarted = true;
    if (startupTimer) clearTimeout(startupTimer);
    const electron = spawn(electronPath, ["."], {
      stdio: "inherit",
      env: { ...developmentEnv, VITE_DEV_SERVER_URL: url }
    });
    electron.once("error", (error) => failStartup(`Electron could not start: ${error.message}`));
    electron.on("exit", () => {
      electronExited = true;
      vite.kill();
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
