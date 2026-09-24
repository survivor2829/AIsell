const fs = require("node:fs");
const path = require("node:path");

function resolveSystemTar() {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot) {
    const systemTar = path.join(systemRoot, "System32", "tar.exe");
    if (fs.existsSync(systemTar)) return systemTar;
  }
  return "tar.exe";
}

module.exports = { resolveSystemTar };
