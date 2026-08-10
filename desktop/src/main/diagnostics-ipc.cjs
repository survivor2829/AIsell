const { app, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const productBrand = require("../../product-brand.json");
const { diagnostics } = require("./diagnostics.cjs");

function buildInfo() {
  const candidates = [
    path.join(app.getAppPath(), "dist", "build-edition.json"),
    path.join(app.getAppPath(), "dist-pilot", "build-edition.json"),
    path.join(app.getAppPath(), "dist-development", "build-edition.json")
  ];
  for (const file of candidates) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
  }
  return {};
}

function runPowerShell(script, environment = {}) {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      env: { ...process.env, ...environment }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (status) => resolve(status === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `powershell_exit_${status}` }));
  });
}

async function exportBundle() {
  const logger = diagnostics();
  const selected = await dialog.showSaveDialog({
    title: `导出 ${productBrand.displayName} 诊断包`,
    defaultPath: path.join(app.getPath("downloads"), `${productBrand.displayName}-诊断日志-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`),
    filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }]
  });
  if (selected.canceled || !selected.filePath) return { ok: true, canceled: true };

  const destination = selected.filePath.toLowerCase().endsWith(".zip") ? selected.filePath : `${selected.filePath}.zip`;
  const staging = path.join(logger.logsDir, `.export-${process.pid}-${Date.now()}`);
  const operation = logger.begin("diagnostics", "bundle_export", { destination });
  try {
    fs.mkdirSync(staging, { recursive: true });
    for (const name of fs.readdirSync(logger.logsDir)) {
      if (!name.startsWith("diagnostics.jsonl")) continue;
      fs.copyFileSync(path.join(logger.logsDir, name), path.join(staging, name));
    }
    logger.writeJsonAtomic(path.join(staging, "summary.json"), {
      exported_at: new Date().toISOString(),
      build: buildInfo(),
      diagnostics: logger.status().data,
      privacy: "不包含 DeepSeek Key、客户消息原文、联系人明文、AI专家资料原文。"
    });
    fs.rmSync(destination, { force: true });
    const result = await runPowerShell(
      "Compress-Archive -Path (Join-Path $env:XIAOXI_DIAGNOSTIC_SOURCE '*') -DestinationPath $env:XIAOXI_DIAGNOSTIC_DESTINATION -Force",
      {
        XIAOXI_DIAGNOSTIC_SOURCE: staging,
        XIAOXI_DIAGNOSTIC_DESTINATION: destination
      }
    );
    if (!result.ok) throw new Error(result.error);
    operation.end({ ok: true, destination });
    return { ok: true, filePath: destination };
  } catch (error) {
    operation.fail(error);
    return { ok: false, error: `导出诊断包失败：${String(error?.message || error)}` };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function registerDiagnosticsIpc() {
  ipcMain.handle("diagnostics:status", () => diagnostics().status());
  ipcMain.handle("diagnostics:open-folder", async () => {
    const result = await shell.openPath(diagnostics().logsDir);
    if (result) return { ok: false, error: result };
    diagnostics().event("diagnostics", "folder_opened");
    return { ok: true };
  });
  ipcMain.handle("diagnostics:export", exportBundle);
}

module.exports = { exportBundle, registerDiagnosticsIpc };
