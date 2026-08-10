const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { sha256, treeSha256 } = require("./release-tree-hash.cjs");
const {
  PRODUCT_DETAIL_SOURCE_DIRECTORIES,
  PRODUCT_DETAIL_SOURCE_EXCLUDED_DIRECTORIES,
  isProductDetailSourceFile,
  productDetailChangedSourceFiles,
  sourcePathParts
} = require("../src/main/product-detail-source-scope.cjs");

const desktopDir = path.resolve(__dirname, "..");

function resolveBuildPaths(root = desktopDir) {
  const resolvedDesktopDir = path.resolve(root);
  const buildRoot = path.join(resolvedDesktopDir, ".build");
  const sourceRoot = path.join(resolvedDesktopDir, "sidecars", "product-detail");
  const sourceDir = path.join(sourceRoot, "app");
  const outputDir = path.join(buildRoot, "product-detail-runtime");
  const sessionPrefix = `pd-${process.pid}`;
  const distDir = path.join(buildRoot, `${sessionPrefix}-d`);
  return {
    desktopDir: resolvedDesktopDir,
    projectDir: path.resolve(resolvedDesktopDir, ".."),
    buildRoot,
    sourceRoot,
    sourceDir,
    entryFile: path.join(sourceDir, "desktop_entry.py"),
    templatesDir: path.join(sourceDir, "templates"),
    staticDir: path.join(sourceDir, "static"),
    screenTypesFile: path.join(sourceDir, "ai_refine_v2", "screen_types.yaml"),
    snapshotFile: path.join(sourceRoot, "source-snapshot.json"),
    playwrightBrowsersDir: path.join(buildRoot, "product-detail-playwright"),
    outputDir,
    outputExe: path.join(outputDir, "product-detail-server.exe"),
    manifestFile: path.join(buildRoot, "product-detail-runtime.manifest.json"),
    distDir,
    pyInstallerOutputDir: path.join(distDir, "product-detail-server"),
    workDir: path.join(buildRoot, `${sessionPrefix}-w`),
    specDir: path.join(buildRoot, `${sessionPrefix}-s`),
    selfCheckDataDir: path.join(
      buildRoot,
      `${sessionPrefix}-c`
    )
  };
}

function canonicalCandidate(target) {
  const resolved = path.resolve(target);
  const missing = [];
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  const canonicalExisting = fs.existsSync(existing)
    ? fs.realpathSync.native(existing)
    : existing;
  return path.resolve(canonicalExisting, ...missing);
}

function ensureSafeBuildTarget(target, buildRoot) {
  const resolvedRoot = canonicalCandidate(buildRoot);
  const resolvedTarget = canonicalCandidate(target);
  if (resolvedTarget === resolvedRoot) {
    throw new Error("Refusing recursive cleanup of the build root itself");
  }
  if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Refusing recursive cleanup outside desktop/.build: ${resolvedTarget}`);
  }
  return path.resolve(target);
}

function removeBuildTarget(target, buildRoot) {
  const safeTarget = ensureSafeBuildTarget(target, buildRoot);
  fs.rmSync(safeTarget, { recursive: true, force: true });
}

function buildPyInstallerArgs(paths) {
  const dataArgs = [
    "--add-data",
    `${paths.templatesDir}${path.delimiter}templates`,
    "--add-data",
    `${paths.staticDir}${path.delimiter}static`,
    "--add-data",
    `${paths.screenTypesFile}${path.delimiter}ai_refine_v2`
  ];
  if (fs.existsSync(paths.playwrightBrowsersDir)) {
    dataArgs.push(
      "--add-data",
      `${paths.playwrightBrowsersDir}${path.delimiter}playwright-browsers`
    );
  }
  return [
    "--noconfirm",
    "--onedir",
    "--noupx",
    "--console",
    "--name",
    "product-detail-server",
    "--paths",
    paths.sourceDir,
    "--hidden-import",
    "app",
    "--collect-all",
    "playwright",
    ...dataArgs,
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
    env.XIAOXI_PRODUCT_DETAIL_BUILD_PYTHON,
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
    "Missing Python 3.10+ with PyInstaller. Set XIAOXI_PRODUCT_DETAIL_BUILD_PYTHON."
  );
}

function productDetailSourceFiles(paths) {
  if (!fs.existsSync(paths.sourceDir) || !fs.statSync(paths.sourceDir).isDirectory()) {
    throw new Error(`Product-detail source directory is missing: ${paths.sourceDir}`);
  }
  const files = [];
  const visit = (directory, relativeDirectory = "") => {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const parts = sourcePathParts(relative);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (parts.some((part) => PRODUCT_DETAIL_SOURCE_EXCLUDED_DIRECTORIES.has(part))) continue;
        if (parts.length === 1 && !PRODUCT_DETAIL_SOURCE_DIRECTORIES.has(parts[0])) continue;
        visit(absolute, relative);
      } else if (entry.isFile()) {
        if (isProductDetailSourceFile(relative)) files.push(absolute);
      } else if (
        parts.length > 0
        && PRODUCT_DETAIL_SOURCE_DIRECTORIES.has(parts[0])
      ) {
        throw new Error(`Unsupported product-detail source entry: ${absolute}`);
      }
    }
  };
  visit(paths.sourceDir);
  return files.sort((left, right) => Buffer.compare(
    Buffer.from(path.relative(paths.sourceDir, left).replaceAll("\\", "/"), "utf8"),
    Buffer.from(path.relative(paths.sourceDir, right).replaceAll("\\", "/"), "utf8")
  ));
}

function productDetailSourceTreeSha256(paths) {
  const hash = crypto.createHash("sha256");
  const files = productDetailSourceFiles(paths);
  if (files.length === 0) {
    throw new Error("Product-detail packaged source set is empty");
  }
  for (const file of files) {
    const relative = path.relative(paths.sourceDir, file).replaceAll("\\", "/");
    const content = fs.readFileSync(file);
    hash.update(`file\0${relative}\0${content.length}\0`, "utf8");
    hash.update(content);
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

function desktopSourceProvenance(paths, readGit = gitText) {
  const relativeSource = path.relative(paths.projectDir, paths.sourceDir).replaceAll("\\", "/");
  const commit = readGit(paths.projectDir, ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("Product-detail desktop build requires a full Git source commit");
  }
  const workingChanges = readGit(paths.projectDir, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    relativeSource
  ]);
  return {
    commit,
    dirty: productDetailChangedSourceFiles(workingChanges, relativeSource).length > 0,
    treeSha256: productDetailSourceTreeSha256(paths)
  };
}

function sourceProvenance(snapshot) {
  const trackedModifiedCount = Number(snapshot?.source?.trackedModifiedCount || 0);
  const untrackedCount = Number(snapshot?.source?.untrackedCount || 0);
  const commit = String(snapshot?.source?.head || "").trim();
  if (!commit) throw new Error("Product-detail source snapshot is missing source.head");
  return {
    commit,
    dirty: trackedModifiedCount + untrackedCount > 0,
    trackedModifiedCount,
    untrackedCount,
    snapshotTreeSha256BeforeDesktopAdaptation: String(
      snapshot?.snapshot?.treeSha256BeforeDesktopAdaptation || ""
    )
  };
}

function validateSelfCheckPayload(payload) {
  if (!payload || payload.ok !== true) {
    throw new Error("Product-detail runtime self-check returned not ok");
  }
  if (payload.mode !== "desktop") {
    throw new Error("Product-detail runtime self-check returned the wrong mode");
  }
  if (!String(payload.version || "").trim()) {
    throw new Error("Product-detail runtime self-check did not report a version");
  }
  return payload;
}

function buildManifest({
  outputDir,
  outputExe,
  version,
  source,
  desktopSource,
  builtAt,
  bundledPlaywright = false
}) {
  if (!fs.existsSync(outputExe)) {
    throw new Error(`Product-detail runtime executable is missing: ${outputExe}`);
  }
  if (!/^[0-9a-f]{40}$/.test(String(desktopSource?.commit || ""))) {
    throw new Error("Product-detail runtime manifest requires a full desktop source commit");
  }
  if (typeof desktopSource?.dirty !== "boolean") {
    throw new Error("Product-detail runtime manifest requires the desktop source dirty state");
  }
  if (!/^[0-9a-f]{64}$/.test(String(desktopSource?.treeSha256 || ""))) {
    throw new Error("Product-detail runtime manifest requires a desktop source tree hash");
  }
  return {
    schemaVersion: 1,
    version,
    builtAt: builtAt || new Date().toISOString(),
    source,
    desktopSource: {
      commit: desktopSource.commit,
      dirty: desktopSource.dirty,
      treeSha256: desktopSource.treeSha256
    },
    runtime: {
      kind: "pyinstaller-onedir",
      entry: path.basename(outputExe),
      bundledPlaywright: Boolean(bundledPlaywright),
      exeSha256: sha256(outputExe),
      treeSha256: treeSha256(outputDir)
    }
  };
}

function assertBuildInputs(paths) {
  for (const required of [
    paths.entryFile,
    paths.templatesDir,
    paths.staticDir,
    paths.screenTypesFile,
    paths.snapshotFile
  ]) {
    if (!fs.existsSync(required)) {
      throw new Error(`Missing product-detail build input: ${required}`);
    }
  }
}

function assertFreshOutput(paths) {
  const existing = [paths.outputDir, paths.manifestFile].filter((target) =>
    fs.existsSync(target)
  );
  if (existing.length > 0) {
    throw new Error(
      `Refusing to overwrite existing product-detail build artifacts: ${existing.join(", ")}`
    );
  }
}

function parseJsonOutput(result, label) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() || result.stdout?.trim() || `${label} failed with status ${result.status}`
    );
  }
  try {
    return JSON.parse(String(result.stdout || "").trim());
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function main() {
  const paths = resolveBuildPaths();
  assertBuildInputs(paths);
  fs.mkdirSync(paths.buildRoot, { recursive: true });
  assertFreshOutput(paths);
  fs.mkdirSync(paths.specDir, { recursive: true });

  const desktopSourceBefore = desktopSourceProvenance(paths);
  const python = findBuildPython(paths);
  console.log(`Building product-detail sidecar with ${python}`);
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
    throw new Error(`Product-detail PyInstaller build failed with status ${result.status}`);
  }
  if (!fs.existsSync(path.join(paths.pyInstallerOutputDir, "product-detail-server.exe"))) {
    throw new Error("PyInstaller did not produce product-detail-server.exe");
  }

  fs.renameSync(paths.pyInstallerOutputDir, paths.outputDir);
  fs.mkdirSync(paths.selfCheckDataDir, { recursive: true });
  const selfCheckResult = spawnSync(
    paths.outputExe,
    ["--self-check", "--data-dir", paths.selfCheckDataDir],
    {
      cwd: paths.outputDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONUTF8: "1"
      },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120000,
      windowsHide: true
    }
  );
  const selfCheck = validateSelfCheckPayload(
    parseJsonOutput(selfCheckResult, "Product-detail runtime self-check")
  );

  const desktopSourceAfter = desktopSourceProvenance(paths);
  if (JSON.stringify(desktopSourceAfter) !== JSON.stringify(desktopSourceBefore)) {
    throw new Error("Product-detail desktop source changed while the runtime was being built");
  }
  const snapshot = JSON.parse(fs.readFileSync(paths.snapshotFile, "utf8"));
  const manifest = buildManifest({
    outputDir: paths.outputDir,
    outputExe: paths.outputExe,
    version: selfCheck.version,
    source: sourceProvenance(snapshot),
    desktopSource: desktopSourceBefore,
    bundledPlaywright: fs.existsSync(paths.playwrightBrowsersDir)
  });
  fs.writeFileSync(paths.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Product-detail sidecar built and verified: ${paths.outputExe}`);
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
  desktopSourceProvenance,
  ensureSafeBuildTarget,
  isProductDetailSourceFile,
  productDetailSourceFiles,
  productDetailSourceTreeSha256,
  findBuildPython,
  main,
  pythonCandidates,
  removeBuildTarget,
  resolveBuildPaths,
  sourceProvenance,
  validateSelfCheckPayload
};
