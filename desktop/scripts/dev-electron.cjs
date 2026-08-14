const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const electronPath = require("electron");

const url = "http://127.0.0.1:5173";
const developmentEnv = { ...process.env, XIAOXI_EDITION: "development", VITE_XIAOXI_EDITION: "development" };

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

if (!developmentEnv.XIAOXI_CONTENT_ENGINE_SIDECAR) {
  const python = findDevelopmentPython();
  const worker = path.join(__dirname, "..", "sidecars", "content-engine", "worker.py");
  if (python && fs.existsSync(worker)) {
    developmentEnv.XIAOXI_CONTENT_ENGINE_SIDECAR = python;
    developmentEnv.XIAOXI_CONTENT_ENGINE_SIDECAR_ENTRY = worker;
  }
}

const vite = spawn(process.platform === "win32" ? "cmd" : "npm", process.platform === "win32" ? ["/c", "npm", "run", "dev"] : ["run", "dev"], {
  stdio: "inherit",
  env: developmentEnv
});

function waitForVite(attempt = 0) {
  if (attempt > 80) {
    console.error("Vite dev server did not start.");
    vite.kill();
    process.exit(1);
  }

  http.get(url, (res) => {
    res.resume();
    const electron = spawn(electronPath, ["."], {
      stdio: "inherit",
      env: { ...developmentEnv, VITE_DEV_SERVER_URL: url }
    });
    electron.on("exit", () => vite.kill());
  }).on("error", () => {
    setTimeout(() => waitForVite(attempt + 1), 250);
  });
}

waitForVite();
