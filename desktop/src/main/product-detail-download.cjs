const fs = require("node:fs");
const path = require("node:path");
const { PRODUCT_DETAIL_CHANNELS } = require("./product-detail-ipc.cjs");

const PRODUCT_DETAIL_DOWNLOAD_CHANNEL = PRODUCT_DETAIL_CHANNELS.downloadUpdate;
const ALLOWED_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".webp", ".zip"]);
const IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".webp"]);
// Every product's images go to Pictures/小玺产品详情图/<product> (user 2026-11-16: five products
// exported to the desktop made it unusable). The detail page names each file "<product>_<part>".
const EXPORT_ROOT_NAME = "小玺产品详情图";
const MAX_ZIP_ENTRIES = 200;
const MAX_ZIP_ENTRY_BYTES = 80 * 1024 * 1024;

// The product folder of a download: the part of the file name before the first "_" (the detail
// page writes "<product>_<part>"), else the whole name; never empty, never a path.
function productFolderName(filename) {
  const stem = path.basename(String(filename || ""), path.extname(String(filename || "")));
  const head = stem.includes("_") ? stem.slice(0, stem.indexOf("_")) : stem;
  const cleaned = head.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim().slice(0, 60).trim();
  return cleaned && !/^\.+$/.test(cleaned) ? cleaned : "未命名产品";
}

function sanitizeDownloadFilename(rawFilename) {
  const original = String(rawFilename || "").trim();
  if (!original) return "";

  const extension = path.extname(original).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) return "";

  const basename = path.basename(original)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return basename && basename !== extension ? basename : "";
}

function isAllowedProductDetailUrl(rawUrl, expectedOrigin) {
  try {
    const downloadOrigin = new URL(String(rawUrl || "")).origin;
    const productOrigin = new URL(String(expectedOrigin || "")).origin;
    return downloadOrigin === productOrigin;
  } catch {
    return false;
  }
}

function uniqueDownloadPath({ desktopPath, filename, existsSync, reservedPaths }) {
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  let attempt = 0;
  while (true) {
    const candidateName = attempt === 0 ? filename : `${stem} (${attempt})${extension}`;
    const candidate = path.join(desktopPath, candidateName);
    const reservationKey = candidate.toLowerCase();
    if (!existsSync(candidate) && !reservedPaths.has(reservationKey)) {
      reservedPaths.add(reservationKey);
      return { candidate, candidateName, reservationKey };
    }
    attempt += 1;
  }
}

// When each detail image was saved, for the home page's count of finished detail pages (2026-10-29).
// Only times are kept, never names or content.
const HISTORY_LIMIT = 2000;
function readProductDetailHistory(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(state?.completed) ? state.completed.filter((entry) => typeof entry?.at === "string") : [];
  } catch { return []; }
}
function rememberProductDetailDownload(file, at) {
  try {
    const completed = [...readProductDetailHistory(file), { at }].slice(-HISTORY_LIMIT);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, completed }));
    fs.renameSync(temporary, file);
  } catch {
    // The count is a convenience; a download never fails because of it.
  }
}

// Unpacks the main-image zip the detail page downloads into the product folder (images only,
// flat, never outside the folder), then removes the zip. Returns the saved names.
async function extractImageZip(zipFile, folder, { existsSync = fs.existsSync, reservedPaths = new Set() } = {}) {
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(await fs.promises.readFile(zipFile));
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  const entries = files.filter((entry) => IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));
  const saved = [];
  // The zip is kept unless every file in it came out as an image here (nothing lost).
  let complete = entries.length > 0 && entries.length === files.length && entries.length <= MAX_ZIP_ENTRIES;
  for (const entry of entries.slice(0, MAX_ZIP_ENTRIES)) {
    const name = sanitizeDownloadFilename(path.basename(entry.name.replace(/\\/g, "/")));
    // Size checked before inflating (the declared size), and again after.
    const declared = Number(entry._data?.uncompressedSize);
    if (!name || (Number.isFinite(declared) && declared > MAX_ZIP_ENTRY_BYTES)) { complete = false; continue; }
    let target = null;
    try {
      const bytes = await entry.async("nodebuffer");
      if (bytes.length > MAX_ZIP_ENTRY_BYTES) { complete = false; continue; }
      target = uniqueDownloadPath({ desktopPath: folder, filename: name, existsSync, reservedPaths });
      await fs.promises.writeFile(target.candidate, bytes, { flag: "wx" });
      saved.push(target.candidateName);
    } catch {
      complete = false;
    } finally {
      if (target) reservedPaths.delete(target.reservationKey);
    }
  }
  if (complete && saved.length === entries.length) await fs.promises.rm(zipFile, { force: true });
  return saved;
}

function registerProductDetailDownloads({
  session,
  getMainWindow,
  getProductDetailOrigin,
  getDesktopPath,
  getExportRoot,
  mkdirSync = fs.mkdirSync,
  extractZip = extractImageZip,
  existsSync = fs.existsSync,
  diagnostics,
  historyFile = "",
  now = () => new Date()
}) {
  const reservedPaths = new Set();

  const notify = (payload) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed?.()) return;
    try {
      window.webContents?.send(PRODUCT_DETAIL_DOWNLOAD_CHANNEL, payload);
    } catch {
      // Window teardown races must not affect an active download.
    }
  };

  const record = (event, payload, options) => {
    try {
      diagnostics?.event("product_detail_download", event, payload, options);
    } catch {
      // Downloading must not fail because diagnostics are unavailable.
    }
  };

  const block = (event, code) => {
    event.preventDefault?.();
    record("blocked", { code });
  };

  const onWillDownload = (event, item, webContents) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed?.() || webContents !== window.webContents) return;
    if (!isAllowedProductDetailUrl(item.getURL(), getProductDetailOrigin())) {
      block(event, "PRODUCT_DETAIL_DOWNLOAD_ORIGIN_BLOCKED");
      return;
    }

    const filename = sanitizeDownloadFilename(item.getFilename());
    if (!filename) {
      block(event, "PRODUCT_DETAIL_DOWNLOAD_TYPE_BLOCKED");
      return;
    }

    // Pictures/小玺产品详情图/<product>; the desktop only if that folder cannot be made.
    let directory = getDesktopPath();
    let location = "";
    const folder = productFolderName(filename);
    try {
      const exportRoot = typeof getExportRoot === "function" ? String(getExportRoot() || "") : "";
      if (exportRoot) {
        mkdirSync(path.join(exportRoot, folder), { recursive: true });
        directory = path.join(exportRoot, folder);
        location = `图片\\${EXPORT_ROOT_NAME}\\${folder}`;
      }
    } catch {
      directory = getDesktopPath();
      location = "";
      record("folder_failed", { code: "PRODUCT_DETAIL_EXPORT_FOLDER_FAILED" }, { level: "warn", code: "PRODUCT_DETAIL_EXPORT_FOLDER_FAILED" });
    }
    const target = uniqueDownloadPath({
      desktopPath: directory,
      filename,
      existsSync,
      reservedPaths
    });
    item.setSavePath(target.candidate);
    const diagnosticPayload = { extension: path.extname(target.candidateName).toLowerCase() };
    const where = location ? { location } : {};
    notify({ state: "started", filename: target.candidateName, ...where });
    record("started", diagnosticPayload);

    item.once("done", async (_doneEvent, state) => {
      reservedPaths.delete(target.reservationKey);
      if (state === "completed") {
        let extracted = [];
        // Only the detail page's own main-image zip ("<product>_主图.zip") is unpacked; a batch zip
        // keeps its per-product folders inside it.
        if (location && /_主图(?: \(\d+\))?\.zip$/u.test(target.candidateName)) {
          try { extracted = await extractZip(target.candidate, directory, { existsSync, reservedPaths }); }
          catch { record("unzip_failed", { code: "PRODUCT_DETAIL_UNZIP_FAILED" }, { level: "warn", code: "PRODUCT_DETAIL_UNZIP_FAILED" }); }
        }
        notify({ state: "completed", filename: target.candidateName, ...where, ...(extracted.length ? { extracted: extracted.length } : {}) });
        record("completed", { ...diagnosticPayload, ...(extracted.length ? { extracted: extracted.length } : {}) });
        if (historyFile) rememberProductDetailDownload(historyFile, now().toISOString());
        return;
      }

      const normalizedState = String(state || "unknown").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
      const code = `PRODUCT_DETAIL_DOWNLOAD_${normalizedState || "UNKNOWN"}`;
      notify({ state: "failed", filename: target.candidateName, code });
      record("failed", { ...diagnosticPayload, code }, { level: "error", code });
    });
  };

  session.on("will-download", onWillDownload);
  return {
    dispose() {
      session.removeListener("will-download", onWillDownload);
      reservedPaths.clear();
    }
  };
}

module.exports = {
  EXPORT_ROOT_NAME,
  extractImageZip,
  productFolderName,
  readProductDetailHistory,
  PRODUCT_DETAIL_DOWNLOAD_CHANNEL,
  isAllowedProductDetailUrl,
  registerProductDetailDownloads,
  sanitizeDownloadFilename
};
