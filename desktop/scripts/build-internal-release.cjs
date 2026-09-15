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
const acceptedBaseRecord = "internal-release-accepted-base.json";

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

function parseBuildArgs(args) {
  const positional = [];
  let full = false, components = false, baseRoot = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--full") full = true;
    else if (arg === "--components") components = true;
    else if (arg === "--base") {
      baseRoot = args[++index];
      if (!baseRoot || baseRoot.startsWith("--")) throw new Error("--base requires the previously accepted application directory");
    } else if (arg.startsWith("--")) throw new Error(`Unknown internal release option: ${arg}`);
    else positional.push(arg);
  }
  if (full && components) throw new Error("Choose either --full or --components");
  if (positional.length > 2) throw new Error("Too many internal release arguments");
  const [configFile = ".build/internal-release-config.json", edition = "test"] = positional;
  if (!["test", "upgrade"].includes(edition)) throw new Error("Internal edition must be test or upgrade");
  if (components && edition === "upgrade") throw new Error("In-place upgrade requires the full installer");
  return { configFile, edition, componentsOnly: !full && edition === "test", baseRoot };
}

function resolveAcceptedBaseRoot(explicitRoot, edition = "test", buildRoot = path.join(desktopDir, ".build"), fallbackRoot = null) {
  if (explicitRoot) return path.resolve(explicitRoot);
  const fallback = fallbackRoot || path.join(desktopDir, "../release",
    require("../product-brand.json").displayName + (edition === "test" ? "-测试版" : ""));
  if (edition !== "test") return path.resolve(fallback);
  const recordFile = path.join(buildRoot, acceptedBaseRecord);
  if (!fs.existsSync(recordFile)) return path.resolve(fallback);
  const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  const root = path.resolve(record.root || "");
  const baseline = require("./component-base-input.cjs").readComponentBase(root, true);
  const release = JSON.parse(fs.readFileSync(path.join(root, "版本清单.json"), "utf8"));
  if (record.schema !== 1 || record.releaseVersion !== release.version
      || record.baseVersion !== baseline.base.version || record.fingerprint !== baseline.base.fingerprint) {
    throw new Error("Accepted component base record no longer matches its manifest");
  }
  return root;
}

function recordAcceptedBaseRoot(root, buildRoot = path.join(desktopDir, ".build")) {
  root = path.resolve(root);
  const baseline = require("./component-base-input.cjs").readComponentBase(root, true);
  const release = JSON.parse(fs.readFileSync(path.join(root, "版本清单.json"), "utf8"));
  const record = {
    schema: 1,
    root,
    releaseVersion: release.version,
    baseVersion: baseline.base.version,
    fingerprint: baseline.base.fingerprint,
    recordedAt: new Date().toISOString()
  };
  fs.mkdirSync(buildRoot, { recursive: true });
  const target = path.join(buildRoot, acceptedBaseRecord);
  require("../src/main/atomic-file.cjs").writeJsonAtomic(target, record);
  return target;
}

function main(args = process.argv.slice(2)) {
  const { configFile, edition, componentsOnly, baseRoot } = parseBuildArgs(args);
  process.chdir(desktopDir);
  loadBuildConfig(configFile);
  assertCleanSource();
  console.log(componentsOnly ? "Internal update: build changed components." : "Explicit full installer build.");
  const resolvedBaseRoot = componentsOnly ? resolveAcceptedBaseRoot(baseRoot, edition) : baseRoot;
  const roots = runRelease(edition, process.env, { componentsOnly, componentBaseRoot: resolvedBaseRoot });
  if (componentsOnly && baseRoot) {
    const acceptedRecord = recordAcceptedBaseRoot(resolvedBaseRoot);
    console.log(`Accepted component base record: ${acceptedRecord}`);
  }
  // runRelease(upgrade) already produces the in-place installer.
  const result = edition === "test" && !componentsOnly ? buildInstaller("test") : null;
  const record = { edition, componentsOnly, ...roots, ...(result || {}) };
  const recordFile = path.join(desktopDir, ".build", `internal-release-${edition}${componentsOnly ? "-components" : ""}.json`);
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Internal build record: ${recordFile}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { loadBuildConfig, assertCleanSource, parseBuildArgs, resolveAcceptedBaseRoot, recordAcceptedBaseRoot, main };
