const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runRelease } = require("./run-release.cjs");
const { buildInstaller } = require("./build-installer-release.cjs");

const desktopDir = path.resolve(__dirname, "..");
const configKeys = new Set([
  "XIAOXI_BUILD_PYTHON", "XIAOXI_FFMPEG_PATH", "XIAOXI_FFPROBE_PATH",
  "XIAOXI_MEDIA_TOOLS_ROOT", "XIAOXI_MEDIA_TOOLS_LICENSE_RECORD",
  "XIAOXI_REMOTION_BROWSER_SOURCE_PATH", "XIAOXI_REMOTION_LICENSE_RECORD"
]);

function loadBuildConfig(filename) {
  const absolute = path.resolve(filename);
  const config = JSON.parse(fs.readFileSync(absolute, "utf8").replace(/^\uFEFF/u, ""));
  for (const [name, value] of Object.entries(config)) {
    if (!configKeys.has(name) || typeof value !== "string" || !value.trim()) {
      throw new Error(`Invalid internal build configuration key: ${name}`);
    }
    const resolved = path.resolve(path.dirname(absolute), value);
    if (!fs.existsSync(resolved)) throw new Error(`Build input is missing: ${name}`);
    process.env[name] = resolved;
  }
}

function assertCleanSource() {
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: desktopDir, encoding: "utf8", windowsHide: true
  });
  if (status.status !== 0) throw new Error("Cannot verify source revision");
  if (status.stdout.trim()) throw new Error("Commit the reviewed changes before building an internal release");
}

function main() {
  const [configFile = ".build/internal-release-config.json", edition = "test"] = process.argv.slice(2);
  if (!["test", "upgrade"].includes(edition)) throw new Error("Internal edition must be test or upgrade");
  process.chdir(desktopDir);
  loadBuildConfig(configFile);
  assertCleanSource();
  const roots = runRelease(edition);
  Object.assign(process.env, {
    XIAOXI_SIDECAR_BUILD_ROOT: roots.sidecarBuildRoot,
    XIAOXI_REMOTION_RUNTIME_ROOT: roots.remotionRuntimeRoot
  });
  // runRelease(upgrade) already produces the in-place installer.
  const result = edition === "test" ? buildInstaller("test") : null;
  const record = { edition, ...roots, ...(result || {}) };
  const recordFile = path.join(desktopDir, ".build", `internal-release-${edition}.json`);
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Internal build record: ${recordFile}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { loadBuildConfig, assertCleanSource };
