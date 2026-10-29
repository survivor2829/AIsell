const fs = require("node:fs");
const path = require("node:path");

// The end of a local service's own output (Python tracebacks, native library
// errors) when it fails. Failure capsules attach it; it never leaves the
// computer any other way.
function saveStderrTail(dataDir, tail, label = "") {
  if (!dataDir || !tail) return;
  try {
    const directory = path.join(dataDir, "logs");
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "stderr.log");
    if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024) fs.renameSync(file, path.join(directory, "stderr.1.log"));
    fs.appendFileSync(file, `--- ${new Date().toISOString()} ${label}\n${tail}\n`, "utf8");
  } catch { /* Diagnostics cannot change how a failure is handled. */ }
}

module.exports = { saveStderrTail };
