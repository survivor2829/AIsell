const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  assertBuildInputs,
  assertFreshOutput,
  buildManifest,
  buildPyInstallerArgs,
  copyMediaTools,
  collectSourceProvenance,
  parseProtocolOutput,
  pythonCandidates,
  resolveBuildPaths,
  resolveMediaToolSources,
  runRuntimeSelfCheck,
  sourceTreeSha256
} = require("./build-content-engine-sidecar.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-content-engine-build-"));

try {
  const desktopDir = path.join(root, "desktop");
  const paths = resolveBuildPaths(desktopDir);
  fs.mkdirSync(paths.packageDir, { recursive: true });
  fs.writeFileSync(paths.entryFile, "print('fixture')\n", "utf8");
  fs.writeFileSync(path.join(paths.packageDir, "__init__.py"), "__version__ = '0.1.0'\n", "utf8");
  fs.writeFileSync(path.join(paths.packageDir, "service.py"), "VALUE = 1\n", "utf8");
  fs.mkdirSync(path.join(paths.assetDir, "fonts"), { recursive: true });
  fs.writeFileSync(paths.assetManifest, '{"bundle_version":1,"assets":[]}\n', "utf8");
  fs.writeFileSync(paths.bundledFont, "font-fixture", "utf8");
  fs.mkdirSync(path.join(paths.packageDir, "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(paths.packageDir, "__pycache__", "service.pyc"), "ignored", "utf8");

  assertBuildInputs(paths);
  assert.equal(
    paths.outputExe,
    path.join(desktopDir, ".build", "content-engine-runtime", "content-engine-worker.exe")
  );

  assert.deepEqual(resolveMediaToolSources({}), {
    available: false,
    source: "not_configured",
    ffmpeg: "",
    ffprobe: ""
  });
  assert.throws(
    () => resolveMediaToolSources({ XIAOXI_FFMPEG_PATH: "C:\\only-one.exe" }),
    /configured together/
  );
  const ffmpegFixture = path.join(root, "ffmpeg-source.exe");
  const ffprobeFixture = path.join(root, "ffprobe-source.exe");
  fs.writeFileSync(ffmpegFixture, "ffmpeg", "utf8");
  fs.writeFileSync(ffprobeFixture, "ffprobe", "utf8");
  const configuredMedia = resolveMediaToolSources({
    XIAOXI_FFMPEG_PATH: ffmpegFixture,
    XIAOXI_FFPROBE_PATH: ffprobeFixture
  });
  const mediaRuntime = path.join(root, "media-runtime");
  fs.mkdirSync(mediaRuntime);
  const bundledMedia = copyMediaTools(configuredMedia, mediaRuntime);
  assert.equal(bundledMedia.bundled, true);
  assert.equal(fs.readFileSync(path.join(mediaRuntime, "media-tools", "ffmpeg.exe"), "utf8"), "ffmpeg");
  assert.equal(fs.readFileSync(path.join(mediaRuntime, "media-tools", "ffprobe.exe"), "utf8"), "ffprobe");
  assert.equal(
    paths.manifestFile,
    path.join(desktopDir, ".build", "content-engine-runtime.manifest.json")
  );
  const args = buildPyInstallerArgs(paths);
  assert.equal(args.includes("--onedir"), true);
  assert.equal(args.includes("--noupx"), true);
  assert.equal(args.at(-1), paths.entryFile);
  assert.equal(args[args.indexOf("--name") + 1], "content-engine-worker");
  assert.equal(
    args[args.indexOf("--add-data") + 1],
    `${paths.assetDir}${path.delimiter}content_engine/assets`
  );

  const sourceHash = sourceTreeSha256(paths);
  assert.match(sourceHash, /^[0-9a-f]{64}$/);
  fs.writeFileSync(path.join(paths.packageDir, "__pycache__", "other.pyc"), "still ignored", "utf8");
  assert.equal(sourceTreeSha256(paths), sourceHash, "cache files must not change source identity");
  fs.writeFileSync(path.join(paths.packageDir, "service.py"), "VALUE = 2\n", "utf8");
  assert.notEqual(sourceTreeSha256(paths), sourceHash, "runtime source edits must change source identity");
  const sourceHashAfterCode = sourceTreeSha256(paths);
  fs.writeFileSync(paths.bundledFont, "changed-font-fixture", "utf8");
  assert.notEqual(
    sourceTreeSha256(paths),
    sourceHashAfterCode,
    "bundled asset edits must change source identity"
  );

  const gitCalls = [];
  const provenance = collectSourceProvenance(paths, (projectDir, args) => {
    gitCalls.push({ projectDir, args });
    return args[0] === "rev-parse" ? "a".repeat(40) : "?? desktop/sidecars/content-engine/new.py";
  });
  assert.equal(provenance.commit, "a".repeat(40));
  assert.equal(provenance.dirty, true);
  assert.equal(provenance.treeSha256, sourceTreeSha256(paths));
  assert.deepEqual(gitCalls[1].args, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    "desktop/sidecars/content-engine"
  ]);

  const candidates = pythonCandidates(paths, {
    XIAOXI_CONTENT_ENGINE_BUILD_PYTHON: "C:\\explicit\\content-python.exe",
    XIAOXI_BUILD_PYTHON: "C:\\explicit\\shared-python.exe"
  });
  assert.equal(candidates[0], "C:\\explicit\\content-python.exe");
  assert.equal(candidates[1], "C:\\explicit\\shared-python.exe");
  assert.equal(
    candidates.includes(path.join(paths.buildRoot, "product-detail-venv", "Scripts", "python.exe")),
    true,
    "content-engine builds must reuse the managed product-detail build environment"
  );

  const stdout = [
    JSON.stringify({
      type: "ready",
      service: "content-engine",
      version: "0.1.0",
      protocol_version: 1
    }),
    JSON.stringify({
      id: "build-health",
      ok: true,
      result: { status: "ok", storage: "sqlite" }
    }),
    JSON.stringify({
      id: "build-shutdown",
      ok: true,
      result: { status: "stopping" }
    })
  ].join("\n");
  const parsed = parseProtocolOutput(stdout);
  assert.equal(parsed.ready.version, "0.1.0");
  assert.throws(
    () => parseProtocolOutput(stdout.split("\n").slice(0, 2).join("\n")),
    /ready, health, and shutdown/
  );

  let observed = null;
  const dataDir = path.join(root, "fresh-data");
  const session = runRuntimeSelfCheck({
    executable: "fixture-worker.exe",
    runtimeDir: root,
    dataDir,
    spawn: (executable, spawnArgs, options) => {
      observed = { executable, spawnArgs, options };
      fs.mkdirSync(dataDir, { recursive: false });
      return { status: 0, stdout, stderr: "" };
    }
  });
  assert.equal(session.shutdown.result.status, "stopping");
  assert.equal(observed.executable, "fixture-worker.exe");
  assert.deepEqual(observed.spawnArgs, ["--data-dir", dataDir]);
  assert.match(observed.options.input, /"method":"health"/);
  assert.match(observed.options.input, /"method":"shutdown"/);
  assert.equal(fs.existsSync(dataDir), true, "the worker must initialize the fresh data directory");

  fs.mkdirSync(paths.outputDir, { recursive: true });
  fs.writeFileSync(paths.outputExe, "fixture-executable", "utf8");
  const manifest = buildManifest({
    outputDir: paths.outputDir,
    outputExe: paths.outputExe,
    version: "0.1.0",
    builtAt: "2026-07-30T00:00:00.000Z",
    source: {
      commit: "1".repeat(40),
      dirty: true,
      treeSha256: "2".repeat(64)
    }
  });
  assert.equal(manifest.runtime.entry, "content-engine-worker.exe");
  assert.equal(manifest.source.dirty, true);
  assert.equal(manifest.selfCheck.shutdown, true);
  assert.deepEqual(manifest.capabilities.mixRender, {
    available: false,
    bundled: false,
    source: "not_configured"
  });
  assert.throws(() => assertFreshOutput(paths), /Refusing to overwrite/);

  fs.rmSync(paths.outputDir, { recursive: true, force: true });
  fs.writeFileSync(paths.manifestFile, "{}\n", "utf8");
  assert.throws(() => assertFreshOutput(paths), /Refusing to overwrite/);

  console.log("content-engine build contract self-check passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
