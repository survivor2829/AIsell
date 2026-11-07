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

const SECURITY_PROCESSES = {
  "360tray.exe": "360", "360sd.exe": "360", "zhudongfangyu.exe": "360",
  "hipsdaemon.exe": "huorong", "hipstray.exe": "huorong",
  "qqpctray.exe": "tencent_pc_manager", "qqpcrtp.exe": "tencent_pc_manager",
  "msmpeng.exe": "defender"
};

// When a service dies because a file of the installed program is gone, say how
// many program files are missing (relative paths only) and which security
// software is running, so a capsule can tell our cleanup from a quarantine
// (field 2026-11-07: a content-engine asset vanished after an update switch).
function programIntegrityNote(executablePath, tail, { spawnSync = require("node:child_process").spawnSync } = {}) {
  if (!executablePath || !/FileNotFoundError|No such file or directory/.test(String(tail || ""))) return "";
  try {
    let root = path.dirname(path.resolve(executablePath));
    for (let i = 0; i < 6 && !fs.existsSync(path.join(root, "component-base.json")); i++) root = path.dirname(root);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "component-base.json"), "utf8"));
    const missing = (manifest.files || []).filter(file => !fs.existsSync(path.join(root, ...String(file.path).split("/"))));
    const lines = [`program_missing_files=${missing.length}/${(manifest.files || []).length}`,
      ...missing.slice(0, 10).map(file => `missing: ${file.component || ""} ${file.path}`)];
    const tasks = spawnSync("tasklist.exe", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    const names = new Set(String(tasks.stdout || "").split(/\r?\n/).map(line => line.split(",")[0].replace(/"/g, "").toLowerCase()));
    const found = [...new Set(Object.entries(SECURITY_PROCESSES).filter(([name]) => names.has(name)).map(([, label]) => label))];
    lines.push(`security_software=${found.join(",") || "none_detected"}`);
    return lines.join("\n");
  } catch { return ""; }
}

module.exports = { saveStderrTail, programIntegrityNote };
