const { app, dialog, ipcMain, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");
const productBrand = require("../../product-brand.json");
const { replaceWithRetry, uniqueTemporaryPath } = require("./atomic-file.cjs");
const { diagnostics } = require("./diagnostics.cjs");

const AUTO_REPLY_DIAGNOSTIC_FILE = /^auto-reply-diagnostics\.jsonl(?:\.[1-9]\d*)?$/u;

function buildInfo(appRuntime = app) {
  const candidates = [
    path.join(appRuntime.getAppPath(), "dist", "build-edition.json"),
    path.join(appRuntime.getAppPath(), "dist-pilot", "build-edition.json"),
    path.join(appRuntime.getAppPath(), "dist-development", "build-edition.json")
  ];
  for (const file of candidates) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
  }
  return {};
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exportableStatus(status = {}) {
  const {
    logDirectory: _logDirectory,
    logFile: _logFile,
    ...safeStatus
  } = status && typeof status === "object" ? status : {};
  return safeStatus;
}

function collectDiagnosticFiles(logsDir) {
  return fs.readdirSync(logsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^diagnostics\.jsonl(?:\.\d+)?$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((name) => {
      const content = fs.readFileSync(path.join(logsDir, name));
      return {
        name,
        content,
        size_bytes: content.length,
        sha256: sha256(content)
      };
    });
}

function collectAutoReplyDiagnosticFiles(autoReplyDir) {
  if (typeof autoReplyDir !== "string" || !autoReplyDir.trim()) return [];
  const lockedDirectory = path.resolve(autoReplyDir);
  let directoryEntries;
  try {
    directoryEntries = fs.readdirSync(lockedDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }

  const files = [];
  for (const entry of directoryEntries) {
    if (!entry.isFile() || !AUTO_REPLY_DIAGNOSTIC_FILE.test(entry.name)) continue;
    const source = path.resolve(lockedDirectory, entry.name);
    if (path.dirname(source) !== lockedDirectory) continue;
    let content;
    try {
      content = fs.readFileSync(source);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    files.push({
      name: path.posix.join("auto_reply", entry.name),
      content,
      size_bytes: content.length,
      sha256: sha256(content)
    });
  }
  return files.sort((left, right) => left.name.localeCompare(right.name, "en"));
}

async function createZipArchive(entries) {
  const archive = new JSZip();
  for (const entry of entries) archive.file(entry.name, entry.content);
  return archive.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "DOS"
  });
}

async function verifyZipArchive(value, expectedNames) {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const archive = await JSZip.loadAsync(content, { checkCRC32: true });
  const actualNames = Object.keys(archive.files)
    .filter((name) => !archive.files[name].dir)
    .sort((left, right) => left.localeCompare(right, "en"));
  const expected = [...expectedNames].sort((left, right) => left.localeCompare(right, "en"));
  if (actualNames.length !== expected.length || actualNames.some((name, index) => name !== expected[index])) {
    throw new Error("diagnostic_archive_manifest_mismatch");
  }
  return content;
}

async function writeVerifiedArchive(destination, value, expectedNames) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = uniqueTemporaryPath(destination);
  let handle;
  try {
    const content = Buffer.isBuffer(value) ? value : Buffer.from(value);
    handle = fs.openSync(temporary, "wx");
    fs.writeFileSync(handle, content);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    await verifyZipArchive(fs.readFileSync(temporary), expectedNames);
    replaceWithRetry(temporary, destination);
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {}
    }
    fs.rmSync(temporary, { force: true });
  }
}

async function exportBundle(options = {}) {
  const appRuntime = options.app || app;
  const dialogRuntime = options.dialog || dialog;
  const logger = options.logger || diagnostics();
  const autoReplyDir = options.autoReplyDir;
  const createArchive = options.createArchive || createZipArchive;
  const selected = await dialogRuntime.showSaveDialog({
    title: `导出 ${productBrand.displayName} 诊断包`,
    defaultPath: path.join(appRuntime.getPath("downloads"), `${productBrand.displayName}-诊断日志-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`),
    filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }]
  });
  if (selected.canceled || !selected.filePath) return { ok: true, canceled: true };

  const destination = selected.filePath.toLowerCase().endsWith(".zip") ? selected.filePath : `${selected.filePath}.zip`;
  const operation = logger.begin("diagnostics", "bundle_export", { destination });
  try {
    const diagnosticFiles = collectDiagnosticFiles(logger.logsDir);
    const autoReplyDiagnosticFiles = collectAutoReplyDiagnosticFiles(autoReplyDir);
    const collectedFiles = [...diagnosticFiles, ...autoReplyDiagnosticFiles];
    const includedFiles = collectedFiles.map(({ name, size_bytes, sha256: digest }) => ({
      name,
      size_bytes,
      sha256: digest
    }));
    const summary = Buffer.from(`${JSON.stringify({
      exported_at: new Date().toISOString(),
      build: buildInfo(appRuntime),
      diagnostics: exportableStatus(logger.status()?.data),
      included_files: includedFiles,
      privacy: "不包含 DeepSeek Key、客户消息原文、联系人明文、AI专家资料原文。"
    }, null, 2)}\n`, "utf8");
    const entries = [
      ...collectedFiles.map(({ name, content }) => ({ name, content })),
      { name: "summary.json", content: summary }
    ];
    const archive = await createArchive(entries);
    await writeVerifiedArchive(destination, archive, entries.map((entry) => entry.name));
    operation.end({ ok: true, destination });
    return { ok: true, filePath: destination };
  } catch (error) {
    operation.fail(error);
    return { ok: false, error: `导出诊断包失败：${String(error?.message || error)}` };
  }
}

function registerDiagnosticsIpc(options = {}) {
  ipcMain.handle("diagnostics:status", () => diagnostics().status());
  ipcMain.handle("diagnostics:open-folder", async () => {
    const result = await shell.openPath(diagnostics().logsDir);
    if (result) return { ok: false, error: result };
    diagnostics().event("diagnostics", "folder_opened");
    return { ok: true };
  });
  ipcMain.handle("diagnostics:export", () => exportBundle({ autoReplyDir: options.autoReplyDir }));
}

module.exports = { exportBundle, registerDiagnosticsIpc };
