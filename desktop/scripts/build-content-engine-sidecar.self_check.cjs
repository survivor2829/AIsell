const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { sha256 } = require("./release-tree-hash.cjs");
const {
  assertBuildInputs,
  assertFreshOutput,
  buildManifest,
  buildPyInstallerArgs,
  copyMediaTools,
  collectSourceProvenance,
  mediaToolRuntimeTreeSha256,
  parseProtocolOutput,
  pythonCandidates,
  resolveBuildPaths,
  resolveMediaToolSources,
  runRuntimeSelfCheck,
  sourceTreeSha256,
  validateMediaToolsManifest,
  verifyBundledMediaTools
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
  const mediaSourceRoot = path.join(root, "media-source");
  const mediaSourceDirectory = path.join(mediaSourceRoot, "bin");
  fs.mkdirSync(mediaSourceDirectory, { recursive: true });
  const ffmpegFixture = path.join(mediaSourceDirectory, "ffmpeg-source.exe");
  const ffprobeFixture = path.join(mediaSourceDirectory, "ffprobe-source.exe");
  fs.writeFileSync(ffmpegFixture, "ffmpeg", "utf8");
  fs.writeFileSync(ffprobeFixture, "ffprobe", "utf8");
  const dllFixture = path.join(mediaSourceDirectory, "avcodec-fixture.dll");
  fs.writeFileSync(dllFixture, "dll", "utf8");
  fs.writeFileSync(path.join(mediaSourceDirectory, "unrelated.txt"), "not a runtime dependency", "utf8");
  const licenseFixture = path.join(mediaSourceRoot, "LICENSE");
  fs.writeFileSync(licenseFixture, "license fixture", "utf8");
  const sourceArtifactFixture = path.join(mediaSourceRoot, "fixture-media-tools.zip");
  fs.writeFileSync(sourceArtifactFixture, "media tools source artifact", "utf8");
  const runtimeFiles = [
    { file: ffmpegFixture, targetPath: "ffmpeg.exe" },
    { file: ffprobeFixture, targetPath: "ffprobe.exe" },
    { file: dllFixture, targetPath: "avcodec-fixture.dll" }
  ];
  const record = {
    schemaVersion: 1,
    useType: "internal-evaluation",
    tool: {
      product: "fixture media tools",
      version: "fixture-0.1.0",
      sourceUrl: "https://example.test/media-tools.zip",
      sourceArtifactPath: "fixture-media-tools.zip",
      sourceArtifactSha256: sha256(sourceArtifactFixture),
      terms: "fixture terms",
      termsUrl: "https://example.test/terms",
      internalRedistributionBasis: "fixture internal approval",
      commercialRedistributionBasis: "",
      confirmedBy: "fixture maintainer",
      confirmedDate: "2026-08-27"
    },
    runtime: {
      files: [
        { sourcePath: "bin/ffmpeg-source.exe", targetPath: "ffmpeg.exe", sha256: sha256(ffmpegFixture) },
        { sourcePath: "bin/ffprobe-source.exe", targetPath: "ffprobe.exe", sha256: sha256(ffprobeFixture) },
        { sourcePath: "bin/avcodec-fixture.dll", targetPath: "avcodec-fixture.dll", sha256: sha256(dllFixture) }
      ],
      treeSha256: mediaToolRuntimeTreeSha256(runtimeFiles)
    },
    notices: [{ sourcePath: "LICENSE", sha256: sha256(licenseFixture) }]
  };
  const recordFile = path.join(root, "media-tools-license-record.json");
  fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  assert.throws(
    () => resolveMediaToolSources({
      XIAOXI_FFMPEG_PATH: ffmpegFixture,
      XIAOXI_FFPROBE_PATH: ffprobeFixture,
      XIAOXI_MEDIA_TOOLS_ROOT: mediaSourceRoot
    }),
    /XIAOXI_MEDIA_TOOLS_LICENSE_RECORD/
  );
  const configuredMedia = resolveMediaToolSources({
    XIAOXI_FFMPEG_PATH: ffmpegFixture,
    XIAOXI_FFPROBE_PATH: ffprobeFixture,
    XIAOXI_MEDIA_TOOLS_ROOT: mediaSourceRoot,
    XIAOXI_MEDIA_TOOLS_LICENSE_RECORD: recordFile
  });
  const mediaRuntime = path.join(root, "media-runtime");
  fs.mkdirSync(mediaRuntime);
  const fixtureFont = path.join(mediaRuntime, "_internal", "content_engine", "assets", "fonts", "NotoSansSC-Variable.ttf");
  fs.mkdirSync(path.dirname(fixtureFont), { recursive: true });
  fs.writeFileSync(fixtureFont, "font fixture", "utf8");
  const mediaToolCalls = [];
  const mediaSpawn = (executable, spawnArgs, options) => {
    mediaToolCalls.push({ executable, spawnArgs, options });
    if (spawnArgs.includes("-show_program_version")) {
      return { status: 0, stdout: JSON.stringify({ program_version: { version: "fixture-0.1.0" } }), stderr: "" };
    }
    if (spawnArgs.includes("-show_entries")) {
      if (String(spawnArgs.at(-1)).endsWith(".jpg")) {
        return {
          status: 0,
          stdout: JSON.stringify({
            format: { format_name: "image2" },
            streams: [{ codec_type: "video", codec_name: "mjpeg" }]
          }),
          stderr: ""
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "0.2" },
          streams: [
            { codec_type: "video", codec_name: "h264" },
            { codec_type: "audio", codec_name: "aac" }
          ]
        }),
        stderr: ""
      };
    }
    if (spawnArgs.includes("-encoders")) return { status: 0, stdout: "libx264\naac\nmjpeg\npcm_s16le\nrawvideo\n", stderr: "" };
    if (spawnArgs.includes("-muxers")) return { status: 0, stdout: "hash\nimage2\nmp4\nnull\nrawvideo\nwav\n", stderr: "" };
    if (spawnArgs.includes("-demuxers")) return { status: 0, stdout: "concat\n", stderr: "" };
    if (spawnArgs.includes("-decoders")) return { status: 0, stdout: "aac\nh264\nmjpeg\npcm_s16le\n", stderr: "" };
    if (spawnArgs.includes("-filters")) return { status: 0, stdout: "acompressor\nadelay\naevalsrc\nafftdn\nafade\nalimiter\nametadata\namix\nanull\nanullsrc\napad\naresample\nasetpts\nasplit\natrim\nboxblur\ncolor\ncolorchannelmixer\nconcat\ncrop\ndrawbox\ndrawtext\nebur128\nformat\nfps\nhighpass\nlowpass\nloudnorm\noverlay\npad\nscale\nsetpts\nsetsar\nsidechaincompress\nsine\nsplit\nsubtitles\ntestsrc2\nvolume\nzoompan\n", stderr: "" };
    if (spawnArgs.includes("-bsfs")) return { status: 0, stdout: "h264_metadata\n", stderr: "" };
    if (spawnArgs.includes("-version")) return { status: 0, stdout: "ffmpeg version fixture-0.1.0\n", stderr: "" };
    const output = spawnArgs.at(-1);
    if (/\.(?:jpg|mp4|raw|wav)$/iu.test(String(output))) {
      fs.writeFileSync(output, "fixture-mp4", "utf8");
      return { status: 0, stdout: "", stderr: "" };
    }
    if (String(output) === "-" && spawnArgs.includes("hash")) return { status: 0, stdout: "SHA256=fixture\n", stderr: "" };
    if (String(output) === "-") return { status: 0, stdout: "", stderr: "" };
    throw new Error(`Unexpected media tool command: ${spawnArgs.join(" ")}`);
  };
  const bundledMedia = copyMediaTools(configuredMedia, mediaRuntime, {
    spawn: mediaSpawn,
    tempRoot: root,
    env: {
      SystemRoot: "C:\\Windows",
      SystemDrive: "C:",
      TEMP: root,
      TMP: root,
      PATH: `${mediaSourceDirectory}${path.delimiter}C:\\source-dlls`
    }
  });
  assert.equal(bundledMedia.bundled, true);
  assert.equal(bundledMedia.verified, true);
  assert.equal(fs.readFileSync(path.join(mediaRuntime, "media-tools", "ffmpeg.exe"), "utf8"), "ffmpeg");
  assert.equal(fs.readFileSync(path.join(mediaRuntime, "media-tools", "ffprobe.exe"), "utf8"), "ffprobe");
  assert.equal(fs.readFileSync(path.join(mediaRuntime, "media-tools", "avcodec-fixture.dll"), "utf8"), "dll");
  assert.equal(fs.existsSync(path.join(mediaRuntime, "media-tools", "unrelated.txt")), false);
  assert.equal(fs.readFileSync(path.join(mediaRuntime, "media-tools", "licenses", "third-party", "LICENSE"), "utf8"), "license fixture");
  assert.equal(fs.existsSync(path.join(mediaRuntime, "media-tools", "licenses", "license-record.json")), true);
  assert.deepEqual(bundledMedia.copiedFiles, ["avcodec-fixture.dll", "ffmpeg.exe", "ffprobe.exe"]);
  assert.deepEqual(bundledMedia.noticeFiles, [{ path: "LICENSE", sha256: sha256(licenseFixture) }]);
  assert.equal(mediaToolCalls.every((call) => call.executable.startsWith(path.join(mediaRuntime, "media-tools"))), true);
  assert.equal(mediaToolCalls.every((call) => call.options.cwd === path.join(mediaRuntime, "media-tools")), true);
  assert.equal(mediaToolCalls.every((call) => call.options.env.PATH === [path.join(mediaRuntime, "media-tools"), "C:\\Windows\\System32", "C:\\Windows"].join(path.delimiter)), true);
  assert.equal(mediaToolCalls.every((call) => !call.options.env.PATH.includes(mediaSourceRoot) && call.options.env.Path === undefined), true);
  const graphs = mediaToolCalls.filter((call) => call.spawnArgs.includes("-filter_complex")).map((call) => call.spawnArgs[call.spawnArgs.indexOf("-filter_complex") + 1]);
  assert.equal(graphs.some((graph) => graph.includes("split=2") && graph.includes("subtitles=") && graph.includes("boxblur=")), true);
  assert.equal(graphs.some((graph) => graph.includes("afftdn=") && graph.includes("sidechaincompress=") && graph.includes("amix=")), true);
  assert.equal(mediaToolCalls.some((call) => call.spawnArgs.includes("h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1")), true);
  assert.equal(mediaToolCalls.some((call) => call.spawnArgs.includes("concat")), true);
  assert.throws(
    () => verifyBundledMediaTools(mediaRuntime, {
      available: true,
      runtime: bundledMedia.runtime,
      toolVersion: "1"
    }, { spawn: mediaSpawn, tempRoot: root }),
    /does not match the media tools license record version/,
    "media tool versions must not accept a partial token"
  );
  const missingFilterRuntime = path.join(root, "media-runtime-missing-filter");
  fs.mkdirSync(missingFilterRuntime);
  assert.throws(
    () => copyMediaTools(configuredMedia, missingFilterRuntime, {
      spawn: (executable, spawnArgs, options) => spawnArgs.includes("-filters")
        ? { status: 0, stdout: "acompressor\nadelay\naevalsrc\nafftdn\nafade\nalimiter\nametadata\namix\nanullsrc\napad\naresample\nasetpts\nasplit\natrim\nboxblur\ncolor\ncolorchannelmixer\nconcat\ncrop\ndrawbox\ndrawtext\nebur128\nformat\nfps\nhighpass\nlowpass\nloudnorm\noverlay\npad\nscale\nsetpts\nsetsar\nsidechaincompress\nsine\nsplit\nsubtitles\ntestsrc2\nvolume\nzoompan\n", stderr: "" }
        : mediaSpawn(executable, spawnArgs, options),
      tempRoot: root
    }),
    /anull/
  );
  const versionMismatchRuntime = path.join(root, "media-runtime-version-mismatch");
  fs.mkdirSync(versionMismatchRuntime);
  assert.throws(
    () => copyMediaTools(configuredMedia, versionMismatchRuntime, {
      spawn: (executable, spawnArgs, options) => spawnArgs.includes("-version")
        ? { status: 0, stdout: "ffmpeg version fixture-0.2.0\n", stderr: "" }
        : mediaSpawn(executable, spawnArgs, options),
      tempRoot: root
    }),
    /does not match the media tools license record version/
  );
  let noMediaSpawned = false;
  const unconfiguredMedia = copyMediaTools(resolveMediaToolSources({}), path.join(root, "unconfigured-media-runtime"), {
    spawn: () => {
      noMediaSpawned = true;
      throw new Error("unconfigured media tools must not run");
    }
  });
  assert.equal(unconfiguredMedia.verified, false);
  assert.equal(noMediaSpawned, false);
  const otherMediaDirectory = path.join(root, "other-media-source");
  fs.mkdirSync(otherMediaDirectory);
  const otherFfprobeFixture = path.join(otherMediaDirectory, "ffprobe.exe");
  fs.writeFileSync(otherFfprobeFixture, "ffprobe-other", "utf8");
  assert.throws(
    () => resolveMediaToolSources({
      XIAOXI_FFMPEG_PATH: ffmpegFixture,
      XIAOXI_FFPROBE_PATH: otherFfprobeFixture,
      XIAOXI_MEDIA_TOOLS_ROOT: mediaSourceRoot,
      XIAOXI_MEDIA_TOOLS_LICENSE_RECORD: recordFile
    }),
    /must match the versioned media tools license record/
  );
  fs.writeFileSync(sourceArtifactFixture, "tampered source artifact", "utf8");
  assert.throws(
    () => resolveMediaToolSources({
      XIAOXI_FFMPEG_PATH: ffmpegFixture,
      XIAOXI_FFPROBE_PATH: ffprobeFixture,
      XIAOXI_MEDIA_TOOLS_ROOT: mediaSourceRoot,
      XIAOXI_MEDIA_TOOLS_LICENSE_RECORD: recordFile
    }),
    /source artifact hash/
  );
  fs.writeFileSync(sourceArtifactFixture, "media tools source artifact", "utf8");
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
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.runtime.entry, "content-engine-worker.exe");
  assert.equal(manifest.source.dirty, true);
  assert.equal(manifest.selfCheck.shutdown, true);
  assert.deepEqual(manifest.capabilities.mixRender, {
    available: false,
    bundled: false,
    source: "not_configured"
  });
  assert.deepEqual(manifest.mediaTools, {
    schemaVersion: 1,
    bundled: false,
    verified: false,
    source: "not_configured",
    runtime: null,
    licenseRecord: { present: false },
    notices: [],
    selfCheck: { status: "skipped" }
  });
  validateMediaToolsManifest(manifest.mediaTools);
  assert.throws(() => assertFreshOutput(paths), /Refusing to overwrite/);

  fs.rmSync(paths.outputDir, { recursive: true, force: true });
  fs.writeFileSync(paths.manifestFile, "{}\n", "utf8");
  assert.throws(() => assertFreshOutput(paths), /Refusing to overwrite/);

  console.log("content-engine build contract self-check passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
