const fs = require("node:fs");
const path = require("node:path");
const { PRODUCT_DETAIL_CHANNELS } = require("./product-detail-ipc.cjs");

const PRODUCT_DETAIL_DOWNLOAD_CHANNEL = PRODUCT_DETAIL_CHANNELS.downloadUpdate;
const ALLOWED_EXTENSIONS = new Set([".jpeg", ".jpg", ".png", ".webp", ".zip"]);

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

function registerProductDetailDownloads({
  session,
  getMainWindow,
  getProductDetailOrigin,
  getDesktopPath,
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

    const target = uniqueDownloadPath({
      desktopPath: getDesktopPath(),
      filename,
      existsSync,
      reservedPaths
    });
    item.setSavePath(target.candidate);
    const diagnosticPayload = { extension: path.extname(target.candidateName).toLowerCase() };
    notify({ state: "started", filename: target.candidateName });
    record("started", diagnosticPayload);

    item.once("done", (_doneEvent, state) => {
      reservedPaths.delete(target.reservationKey);
      if (state === "completed") {
        notify({ state: "completed", filename: target.candidateName });
        record("completed", diagnosticPayload);
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
  readProductDetailHistory,
  PRODUCT_DETAIL_DOWNLOAD_CHANNEL,
  isAllowedProductDetailUrl,
  registerProductDetailDownloads,
  sanitizeDownloadFilename
};
