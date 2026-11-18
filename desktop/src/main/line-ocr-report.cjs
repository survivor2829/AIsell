// One report per app run when the chat-title reader cannot start (user request 2026-11-18: get the
// whole reason in one go, never ask the customer to run anything). 1.3.30–1.3.36 lost the reason:
// first as a hashed field, then because it happened outside the minute of history a capsule keeps.
// The report goes next to the capsule as an attachment (flight-recorder.cjs collectReports): the
// reader's own output at start (it has read nothing yet, so no customer text) and what its folder
// holds. Profile paths are removed when the capsule copies it.
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPORT_DIR = "failure-reports";
const REPORT_NAME = "line-ocr-startup.json";
const MAX_OUTPUT_CHARS = 8 * 1024;

function fileFacts(file, { hash = false } = {}) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { present: false };
    return { present: true, bytes: stat.size,
      ...(hash ? { sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") } : {}) };
  } catch {
    return { present: false };
  }
}

function folderFacts(runtimePath) {
  const root = path.dirname(runtimePath || "");
  const internal = path.join(root, "_internal");
  let config = null;
  try { config = JSON.parse(fs.readFileSync(path.join(internal, "line_ocr_model.json"), "utf8")); } catch { /* reported below */ }
  const modelFile = path.join(internal, "models", path.basename(String(config?.file || "ch_PP-OCRv4_rec_infer.onnx")));
  const model = fileFacts(modelFile, { hash: true });
  let pythonDlls = [];
  try { pythonDlls = fs.readdirSync(internal).filter((name) => /^python\d+\.dll$/iu.test(name)); } catch { /* none */ }
  return {
    // Its fingerprint tells an outdated product-detail component (whose runtime does not know
    // --line-ocr-serve and exits 2 with a usage message) from the current one.
    runtime: fileFacts(runtimePath, { hash: true }),
    model_config: { present: Boolean(config), name: String(config?.name || "") },
    model: { ...model, expected_sha256: String(config?.sha256 || ""), sha256_matches: Boolean(model.sha256 && model.sha256 === config?.sha256) },
    onnxruntime: {
      dll: fileFacts(path.join(internal, "onnxruntime", "capi", "onnxruntime.dll")).present,
      pybind: fileFacts(path.join(internal, "onnxruntime", "capi", "onnxruntime_pybind11_state.pyd")).present,
      providers_shared: fileFacts(path.join(internal, "onnxruntime", "capi", "onnxruntime_providers_shared.dll")).present
    },
    msvc: Object.fromEntries(["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "MSVCP140_1.dll"]
      .map((name) => [name, fileFacts(path.join(internal, name)).present])),
    python_dlls: pythonDlls
  };
}

// Paths with the Windows user name in any spelling (upper case, 8.3 short names such as ZHANGS~1) and
// the bare name: the capsule only removes the exact profile path.
function withoutUserName(text) {
  let user = "";
  try { user = os.userInfo().username || ""; } catch { /* unknown */ }
  let result = String(text || "").replace(/([a-z]:[\\/]+users[\\/]+)[^\\/\r\n"']+/giu, "$1<user>");
  if (user.length >= 2) result = result.split(new RegExp(user.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu")).join("<user>");
  return result;
}

function buildLineOcrStartupReport({ details = {}, launch = null, stderr = "", now = () => new Date(), appVersion = "" } = {}) {
  const output = withoutUserName(stderr);
  return {
    kind: "line_ocr_startup_failed",
    at: now().toISOString(),
    app_version: String(appVersion || ""),
    reason: { ...details },
    output_tail: output.length > MAX_OUTPUT_CHARS ? output.slice(-MAX_OUTPUT_CHARS) : output,
    output_truncated: output.length > MAX_OUTPUT_CHARS,
    files: launch?.runtimePath ? folderFacts(launch.runtimePath) : { runtime: { present: false } },
    system: {
      os_release: os.release(), os_version: typeof os.version === "function" ? os.version() : "", arch: os.arch(),
      cpu: os.cpus()?.[0]?.model || "", cpu_count: os.cpus()?.length || 0,
      memory_mb: Math.round(os.totalmem() / 1048576), free_memory_mb: Math.round(os.freemem() / 1048576)
    }
  };
}

// Written before the error event that makes the capsule, so the capsule finds it.
function writeLineOcrStartupReport(rootDir, report) {
  const folder = path.join(rootDir, REPORT_DIR);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, REPORT_NAME);
  fs.writeFileSync(file, JSON.stringify(report, null, 1));
  return file;
}

module.exports = { withoutUserName, buildLineOcrStartupReport, writeLineOcrStartupReport, folderFacts, REPORT_DIR, REPORT_NAME };
