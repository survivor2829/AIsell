const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { sha256, treeSha256 } = require("./release-tree-hash.cjs");

const desktopDir = path.resolve(__dirname, "..");
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

function resolveBuildPaths(root = desktopDir) {
  const resolvedDesktopDir = path.resolve(root);
  const buildRoot = path.join(resolvedDesktopDir, ".build");
  const sourceDir = path.join(resolvedDesktopDir, "sidecars", "content-engine");
  const outputDir = path.join(buildRoot, "content-engine-runtime");
  const sessionPrefix = `ce-${process.pid}-${Date.now()}-${process.hrtime.bigint().toString(36)}`;
  const distDir = path.join(buildRoot, `${sessionPrefix}-d`);
  return {
    desktopDir: resolvedDesktopDir,
    projectDir: path.resolve(resolvedDesktopDir, ".."),
    buildRoot,
    sourceDir,
    packageDir: path.join(sourceDir, "content_engine"),
    entryFile: path.join(sourceDir, "worker.py"),
    outputDir,
    outputExe: path.join(outputDir, "content-engine-worker.exe"),
    manifestFile: path.join(buildRoot, "content-engine-runtime.manifest.json"),
    distDir,
    pyInstallerOutputDir: path.join(distDir, "content-engine-worker"),
    pyInstallerOutputExe: path.join(
      distDir,
      "content-engine-worker",
      "content-engine-worker.exe"
    ),
    workDir: path.join(buildRoot, `${sessionPrefix}-w`),
    specDir: path.join(buildRoot, `${sessionPrefix}-s`),
    selfCheckDataDir: path.join(buildRoot, `${sessionPrefix}-c`)
  };
}

function buildPyInstallerArgs(paths) {
  return [
    "--noconfirm",
    "--onedir",
    "--noupx",
    "--console",
    "--name",
    "content-engine-worker",
    "--paths",
    paths.sourceDir,
    "--distpath",
    paths.distDir,
    "--workpath",
    paths.workDir,
    "--specpath",
    paths.specDir,
    paths.entryFile
  ];
}

function pythonCandidates(paths, env = process.env) {
  const codexPython = path.join(
    os.homedir(),
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "python",
    "python.exe"
  );
  const fromPath = spawnSync("where.exe", ["python.exe"], {
    encoding: "utf8",
    windowsHide: true
  });
  const candidates = [
    env.XIAOXI_CONTENT_ENGINE_BUILD_PYTHON,
    env.XIAOXI_BUILD_PYTHON,
    path.join(paths.buildRoot, "product-detail-venv", "Scripts", "python.exe"),
    codexPython,
    ...(fromPath.status === 0 ? fromPath.stdout.split(/\r?\n/) : [])
  ];
  return [...new Set(candidates.map((value) => String(value || "").trim()).filter(Boolean))];
}

function findBuildPython(paths, env = process.env) {
  for (const candidate of pythonCandidates(paths, env)) {
    if (!fs.existsSync(candidate)) continue;
    const check = spawnSync(
      candidate,
      ["-c", "import sys, PyInstaller; assert sys.version_info >= (3, 10)"],
      { encoding: "utf8", windowsHide: true }
    );
    if (check.status === 0) return candidate;
  }
  throw new Error(
    "Missing Python 3.10+ with PyInstaller. Set XIAOXI_CONTENT_ENGINE_BUILD_PYTHON."
  );
}

function resolveMediaToolSources(env = process.env) {
  const ffmpeg = String(env.XIAOXI_FFMPEG_PATH || "").trim();
  const ffprobe = String(env.XIAOXI_FFPROBE_PATH || "").trim();
  if (!ffmpeg && !ffprobe) {
    return { available: false, source: "not_configured", ffmpeg: "", ffprobe: "" };
  }
  if (!ffmpeg || !ffprobe) {
    throw new Error(
      "XIAOXI_FFMPEG_PATH and XIAOXI_FFPROBE_PATH must be configured together."
    );
  }
  for (const [label, candidate] of [["FFmpeg", ffmpeg], ["ffprobe", ffprobe]]) {
    let isFile = false;
    try {
      isFile = path.isAbsolute(candidate) && fs.statSync(candidate).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      throw new Error(`${label} executable is invalid: ${candidate}`);
    }
  }
  return {
    available: true,
    source: "explicit",
    ffmpeg: path.resolve(ffmpeg),
    ffprobe: path.resolve(ffprobe)
  };
}

function copyMediaTools(mediaTools, runtimeDir) {
  if (!mediaTools.available) return { ...mediaTools, bundled: false };
  const destination = path.join(runtimeDir, "media-tools");
  fs.mkdirSync(destination, { recursive: false });
  fs.copyFileSync(mediaTools.ffmpeg, path.join(destination, "ffmpeg.exe"));
  fs.copyFileSync(mediaTools.ffprobe, path.join(destination, "ffprobe.exe"));
  return { available: true, source: mediaTools.source, bundled: true };
}

function runtimeSourceFiles(paths) {
  const files = [paths.entryFile];
  if (!fs.existsSync(paths.packageDir) || !fs.statSync(paths.packageDir).isDirectory()) {
    return files;
  }
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__pycache__") visit(file);
      } else if (entry.isFile() && entry.name.endsWith(".py")) {
        files.push(file);
      }
    }
  };
  visit(paths.packageDir);
  return files.sort((left, right) => Buffer.compare(
    Buffer.from(path.relative(paths.sourceDir, left).replaceAll("\\", "/"), "utf8"),
    Buffer.from(path.relative(paths.sourceDir, right).replaceAll("\\", "/"), "utf8")
  ));
}

function sourceTreeSha256(paths) {
  const hash = crypto.createHash("sha256");
  for (const file of runtimeSourceFiles(paths)) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`Missing content-engine runtime source: ${file}`);
    }
    const relative = path.relative(paths.sourceDir, file).replaceAll("\\", "/");
    hash.update(relative, "utf8");
    hash.update("\0", "utf8");
    hash.update(fs.readFileSync(file));
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function gitText(projectDir, args) {
  const result = spawnSync("git", args, {
    cwd: projectDir,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || `git ${args.join(" ")} failed`);
  }
  return String(result.stdout || "").trim();
}

function collectSourceProvenance(paths, readGit = gitText) {
  const relativeSource = path.relative(paths.projectDir, paths.sourceDir).replaceAll("\\", "/");
  const commit = readGit(paths.projectDir, ["rev-parse", "HEAD"]);
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error("Content-engine build requires a full Git source commit");
  }
  return {
    commit,
    dirty: Boolean(readGit(paths.projectDir, ["status", "--porcelain", "--untracked-files=all", "--", relativeSource])),
    treeSha256: sourceTreeSha256(paths)
  };
}

function parseProtocolOutput(stdout, label = "Content-engine runtime self-check") {
  const lines = String(stdout || "").split(/\r?\n/).filter((line) => line.trim());
  const payloads = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} returned invalid JSON on line ${index + 1}: ${error.message}`);
    }
  });
  if (payloads.length !== 3) {
    throw new Error(`${label} must return ready, health, and shutdown JSON lines`);
  }
  const [ready, health, shutdown] = payloads;
  if (
    ready?.type !== "ready"
    || ready?.service !== "content-engine"
    || ready?.protocol_version !== 1
    || !String(ready.version || "").trim()
  ) {
    throw new Error(`${label} returned an invalid ready payload`);
  }
  if (
    health?.id !== "build-health"
    || health?.ok !== true
    || health?.result?.status !== "ok"
    || health?.result?.storage !== "sqlite"
  ) {
    throw new Error(`${label} returned an invalid health response`);
  }
  if (
    shutdown?.id !== "build-shutdown"
    || shutdown?.ok !== true
    || shutdown?.result?.status !== "stopping"
  ) {
    throw new Error(`${label} returned an invalid shutdown response`);
  }
  return { ready, health, shutdown };
}

function runRuntimeSelfCheck({
  executable,
  runtimeDir,
  dataDir,
  spawn = spawnSync,
  label = "Content-engine runtime self-check"
}) {
  if (fs.existsSync(dataDir)) {
    throw new Error(`${label} data directory must be fresh: ${dataDir}`);
  }
  const requestInput = [
    JSON.stringify({ id: "build-health", method: "health", params: {} }),
    JSON.stringify({ id: "build-shutdown", method: "shutdown", params: {} }),
    ""
  ].join("\n");
  const result = spawn(
    executable,
    ["--data-dir", dataDir],
    {
      cwd: runtimeDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONDONTWRITEBYTECODE: "1"
      },
      input: requestInput,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120000,
      windowsHide: true
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || "").trim()
      || String(result.stdout || "").trim()
      || `${label} failed with status ${result.status}`
    );
  }
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    throw new Error(`${label} did not initialize its fresh data directory`);
  }
  return parseProtocolOutput(result.stdout, label);
}

function buildManifest({
  outputDir,
  outputExe,
  version,
  source,
  builtAt,
  mediaTools = { available: false, source: "not_configured", bundled: false }
}) {
  if (!fs.existsSync(outputExe) || !fs.statSync(outputExe).isFile()) {
    throw new Error(`Content-engine runtime executable is missing: ${outputExe}`);
  }
  if (!COMMIT_PATTERN.test(String(source?.commit || ""))) {
    throw new Error("Content-engine runtime manifest requires a full source commit");
  }
  if (!SHA256_PATTERN.test(String(source?.treeSha256 || ""))) {
    throw new Error("Content-engine runtime manifest requires a source tree hash");
  }
  return {
    schemaVersion: 1,
    version,
    builtAt: builtAt || new Date().toISOString(),
    source: {
      commit: source.commit,
      dirty: Boolean(source.dirty),
      treeSha256: source.treeSha256
    },
    runtime: {
      kind: "pyinstaller-onedir",
      entry: path.basename(outputExe),
      exeSha256: sha256(outputExe),
      treeSha256: treeSha256(outputDir)
    },
    capabilities: {
      mixRender: {
        available: mediaTools.available === true,
        bundled: mediaTools.bundled === true,
        source: mediaTools.source === "explicit" ? "explicit" : "not_configured"
      }
    },
    selfCheck: {
      protocolVersion: 1,
      ready: true,
      health: true,
      shutdown: true
    }
  };
}

function assertBuildInputs(paths) {
  for (const required of [paths.entryFile, paths.packageDir]) {
    if (!fs.existsSync(required)) {
      throw new Error(`Missing content-engine build input: ${required}`);
    }
  }
}

function assertFreshOutput(paths) {
  const existing = [paths.outputDir, paths.manifestFile].filter((target) =>
    fs.existsSync(target)
  );
  if (existing.length > 0) {
    throw new Error(
      `Refusing to overwrite existing content-engine build artifacts: ${existing.join(", ")}`
    );
  }
}

function main() {
  const paths = resolveBuildPaths();
  assertBuildInputs(paths);
  fs.mkdirSync(paths.buildRoot, { recursive: true });
  assertFreshOutput(paths);
  fs.mkdirSync(paths.specDir, { recursive: true });

  const sourceBefore = collectSourceProvenance(paths);
  const python = findBuildPython(paths);
  const mediaToolSources = resolveMediaToolSources(process.env);
  console.log(`Building content-engine sidecar with ${python}`);
  const result = spawnSync(
    python,
    ["-m", "PyInstaller", ...buildPyInstallerArgs(paths)],
    {
      cwd: paths.desktopDir,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONDONTWRITEBYTECODE: "1"
      },
      stdio: "inherit",
      windowsHide: true
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Content-engine PyInstaller build failed with status ${result.status}`);
  }
  if (!fs.existsSync(paths.pyInstallerOutputExe)) {
    throw new Error("PyInstaller did not produce content-engine-worker.exe");
  }

  const session = runRuntimeSelfCheck({
    executable: paths.pyInstallerOutputExe,
    runtimeDir: paths.pyInstallerOutputDir,
    dataDir: paths.selfCheckDataDir
  });
  const sourceAfter = collectSourceProvenance(paths);
  if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) {
    throw new Error("Content-engine source changed while the runtime was being built");
  }

  const mediaTools = copyMediaTools(mediaToolSources, paths.pyInstallerOutputDir);
  const manifest = buildManifest({
    outputDir: paths.pyInstallerOutputDir,
    outputExe: paths.pyInstallerOutputExe,
    version: session.ready.version,
    source: sourceBefore,
    mediaTools
  });
  fs.renameSync(paths.pyInstallerOutputDir, paths.outputDir);
  fs.writeFileSync(paths.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  console.log(`Content-engine sidecar built and verified: ${paths.outputExe}`);
  console.log(`Manifest: ${paths.manifestFile}`);
  return manifest;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  assertBuildInputs,
  assertFreshOutput,
  buildManifest,
  buildPyInstallerArgs,
  copyMediaTools,
  collectSourceProvenance,
  findBuildPython,
  main,
  parseProtocolOutput,
  pythonCandidates,
  resolveBuildPaths,
  resolveMediaToolSources,
  runRuntimeSelfCheck,
  runtimeSourceFiles,
  sourceTreeSha256
};
