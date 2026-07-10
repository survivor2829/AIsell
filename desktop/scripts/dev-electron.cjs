const { spawn } = require("node:child_process");
const http = require("node:http");
const electronPath = require("electron");

const url = "http://127.0.0.1:5173";
const developmentEnv = { ...process.env, XIAOXI_EDITION: "development", VITE_XIAOXI_EDITION: "development" };

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
