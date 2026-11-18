// How the packaged chat-title reader is started: below the product-detail service's short junction
// (runtime-link.cjs), never from the update folder itself. From there onnxruntime's DLL path passed
// 252 characters for any Windows user name four letters longer than the development machine's and
// Windows refused it ("文件名或扩展名太长", field 47d2578f 1.3.37; reproduced: 250 ok, 253–259 the
// same error): the reader never ran on those computers in 1.3.30–1.3.37.
const fs = require("node:fs");
const path = require("node:path");
const { prepareRuntimeLaunch } = require("./runtime-link.cjs");

// The reader's model inside the component (registered in component-layout.json).
function lineOcrModelFiles(runtimePath) {
  const internal = path.join(path.dirname(runtimePath), "_internal");
  const config = path.join(internal, "line_ocr_model.json");
  try {
    const file = String(JSON.parse(fs.readFileSync(config, "utf8")).file || "");
    return [config, path.join(internal, "models", path.basename(file) || "missing-model")];
  } catch {
    return [config];
  }
}

// One answer per runtime path (it only changes with a component update): the junction work is
// not repeated on the main thread for every reader start.
function createLineOcrLaunch({ runtimePath, dataDir, platform = process.platform, prepare = prepareRuntimeLaunch }) {
  let cached = null;
  return () => {
    const realPath = typeof runtimePath === "function" ? runtimePath() : runtimePath;
    if (cached?.realPath === realPath) return cached.launch;
    let launchPath = realPath;
    let shortLink = "not_needed";
    if (platform === "win32") {
      try {
        launchPath = prepare(realPath, dataDir, {}, { folder: "product-detail", platform }).runtimePath;
        shortLink = launchPath === realPath ? "not_needed" : "linked";
      } catch (error) {
        // Started from the long path then; the startup report says the link could not be made.
        shortLink = `failed_${/^[A-Z][A-Z0-9_]{2,40}$|^E[A-Z]{2,20}$/u.test(String(error?.code || "")) ? error.code.toLowerCase() : "unknown"}`;
      }
    }
    // The files are checked where the process will really load them from.
    const launch = { runtimePath: launchPath, runtimeArgs: [], requiredFiles: lineOcrModelFiles(launchPath), shortLink, realRuntimePath: realPath };
    cached = { realPath, launch };
    return launch;
  };
}

module.exports = { createLineOcrLaunch, lineOcrModelFiles };
