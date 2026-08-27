const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  PORTABLE_SELF_CHECK_TIMEOUT_MS,
  scanRelease
} = require("./build-portable-release.cjs");
const { sha256, treeSha256 } = require("./release-tree-hash.cjs");
const {
  buildManifest,
  copyMediaTools,
  mediaToolRuntimeTreeSha256,
  resolveBuildPaths,
  resolveMediaToolSources,
  sourceTreeSha256,
  verifyBundledMediaToolFiles
} = require("./build-content-engine-sidecar.cjs");
const {
  CONTENT_ENGINE_EXECUTABLE,
  CONTENT_ENGINE_RELEASE_PATH,
  copyContentEngineRuntime,
  createReleaseDescriptor,
  isContentEngineArchivePythonSource,
  isContentEnginePythonSource,
  resolveContentEngineBuild,
  runPackagedContentEngineSelfCheck,
  validateReleaseDescriptor
} = require("./content-engine-release-runtime.cjs");

assert.equal(
  PORTABLE_SELF_CHECK_TIMEOUT_MS >= 600_000,
  true,
  "outer portable self-check must allow at least ten minutes for both sidecars"
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-content-engine-release-"));

try {
  const desktopDir = path.join(root, "desktop");
  const buildRoot = path.join(desktopDir, ".build");
  const runtimeDir = path.join(buildRoot, "content-engine-runtime");
  const manifestFile = path.join(buildRoot, "content-engine-runtime.manifest.json");
  const sourcePaths = resolveBuildPaths(desktopDir);
  fs.mkdirSync(sourcePaths.packageDir, { recursive: true });
  fs.writeFileSync(sourcePaths.entryFile, "from content_engine import __version__\n", "utf8");
  fs.writeFileSync(
    path.join(sourcePaths.packageDir, "__init__.py"),
    "__version__ = '0.1.0-fixture'\n",
    "utf8"
  );
  fs.writeFileSync(path.join(sourcePaths.packageDir, "service.py"), "VALUE = 1\n", "utf8");
  const fixtureSourceTreeSha256 = sourceTreeSha256(sourcePaths);
  fs.mkdirSync(path.join(runtimeDir, "_internal", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, CONTENT_ENGINE_EXECUTABLE), "fixture-executable", "utf8");
  fs.writeFileSync(
    path.join(runtimeDir, "_internal", "fixture", "dependency.py"),
    "fixture_dependency = True\n",
    "utf8"
  );
  const fixtureFont = path.join(runtimeDir, "_internal", "content_engine", "assets", "fonts", "NotoSansSC-Variable.ttf");
  fs.mkdirSync(path.dirname(fixtureFont), { recursive: true });
  fs.writeFileSync(fixtureFont, "font fixture", "utf8");
  const mediaSourceRoot = path.join(root, "media-source");
  const mediaBin = path.join(mediaSourceRoot, "bin");
  fs.mkdirSync(mediaBin, { recursive: true });
  const ffmpegSource = path.join(mediaBin, "ffmpeg-source.exe");
  const ffprobeSource = path.join(mediaBin, "ffprobe-source.exe");
  const dllSource = path.join(mediaBin, "avcodec-fixture.dll");
  const licenseSource = path.join(mediaSourceRoot, "LICENSE");
  fs.writeFileSync(ffmpegSource, "ffmpeg", "utf8");
  fs.writeFileSync(ffprobeSource, "ffprobe", "utf8");
  fs.writeFileSync(dllSource, "dll", "utf8");
  fs.writeFileSync(licenseSource, "license fixture", "utf8");
  const sourceArtifact = path.join(mediaSourceRoot, "fixture-media-tools.zip");
  fs.writeFileSync(sourceArtifact, "media tools source artifact", "utf8");
  const mediaRuntimeFiles = [
    { file: ffmpegSource, targetPath: "ffmpeg.exe" },
    { file: ffprobeSource, targetPath: "ffprobe.exe" },
    { file: dllSource, targetPath: "avcodec-fixture.dll" }
  ];
  const mediaRecord = {
    schemaVersion: 1,
    useType: "internal-evaluation",
    tool: {
      product: "fixture media tools",
      version: "fixture-0.1.0",
      sourceUrl: "https://example.test/media-tools.zip",
      sourceArtifactPath: "fixture-media-tools.zip",
      sourceArtifactSha256: sha256(sourceArtifact),
      terms: "fixture terms",
      termsUrl: "https://example.test/terms",
      internalRedistributionBasis: "fixture internal approval",
      commercialRedistributionBasis: "",
      confirmedBy: "fixture maintainer",
      confirmedDate: "2026-08-27"
    },
    runtime: {
      files: [
        { sourcePath: "bin/ffmpeg-source.exe", targetPath: "ffmpeg.exe", sha256: sha256(ffmpegSource) },
        { sourcePath: "bin/ffprobe-source.exe", targetPath: "ffprobe.exe", sha256: sha256(ffprobeSource) },
        { sourcePath: "bin/avcodec-fixture.dll", targetPath: "avcodec-fixture.dll", sha256: sha256(dllSource) }
      ],
      treeSha256: mediaToolRuntimeTreeSha256(mediaRuntimeFiles)
    },
    notices: [{ sourcePath: "LICENSE", sha256: sha256(licenseSource) }]
  };
  const mediaRecordFile = path.join(root, "media-tools-license-record.json");
  fs.writeFileSync(mediaRecordFile, `${JSON.stringify(mediaRecord, null, 2)}\n`, "utf8");
  const mediaSpawn = (_executable, args) => {
    if (args.includes("-show_program_version")) {
      return { status: 0, stdout: JSON.stringify({ program_version: { version: "fixture-0.1.0" } }), stderr: "" };
    }
    if (args.includes("-show_entries")) {
      if (String(args.at(-1)).endsWith(".jpg")) {
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
    if (args.includes("-encoders")) return { status: 0, stdout: "libx264\naac\nmjpeg\npcm_s16le\nrawvideo\n", stderr: "" };
    if (args.includes("-muxers")) return { status: 0, stdout: "hash\nimage2\nmp4\nnull\nrawvideo\nwav\n", stderr: "" };
    if (args.includes("-demuxers")) return { status: 0, stdout: "concat\n", stderr: "" };
    if (args.includes("-decoders")) return { status: 0, stdout: "aac\nh264\nmjpeg\npcm_s16le\n", stderr: "" };
    if (args.includes("-filters")) return { status: 0, stdout: "acompressor\nadelay\naevalsrc\nafftdn\nafade\nalimiter\nametadata\namix\nanull\nanullsrc\napad\naresample\nasetpts\nasplit\natrim\nboxblur\ncolor\ncolorchannelmixer\nconcat\ncrop\ndrawbox\ndrawtext\nebur128\nformat\nfps\nhighpass\nlowpass\nloudnorm\noverlay\npad\nscale\nsetpts\nsetsar\nsidechaincompress\nsine\nsplit\nsubtitles\ntestsrc2\nvolume\nzoompan\n", stderr: "" };
    if (args.includes("-bsfs")) return { status: 0, stdout: "h264_metadata\n", stderr: "" };
    if (args.includes("-version")) return { status: 0, stdout: "ffmpeg version fixture-0.1.0\n", stderr: "" };
    const output = args.at(-1);
    if (/\.(?:jpg|mp4|raw|wav)$/iu.test(String(output))) {
      fs.writeFileSync(output, "fixture-mp4", "utf8");
      return { status: 0, stdout: "", stderr: "" };
    }
    if (String(output) === "-" && args.includes("hash")) return { status: 0, stdout: "SHA256=fixture\n", stderr: "" };
    if (String(output) === "-") return { status: 0, stdout: "", stderr: "" };
    throw new Error(`Unexpected media tools command: ${args.join(" ")}`);
  };
  const bundledMediaTools = copyMediaTools(resolveMediaToolSources({
    XIAOXI_FFMPEG_PATH: ffmpegSource,
    XIAOXI_FFPROBE_PATH: ffprobeSource,
    XIAOXI_MEDIA_TOOLS_ROOT: mediaSourceRoot,
    XIAOXI_MEDIA_TOOLS_LICENSE_RECORD: mediaRecordFile
  }), runtimeDir, { spawn: mediaSpawn, tempRoot: root });
  const manifest = buildManifest({
    outputDir: runtimeDir,
    outputExe: path.join(runtimeDir, CONTENT_ENGINE_EXECUTABLE),
    version: "0.1.0-fixture",
    builtAt: "2026-07-30T00:00:00.000Z",
    source: {
      commit: "1".repeat(40),
      dirty: false,
      treeSha256: fixtureSourceTreeSha256
    },
    mediaTools: bundledMediaTools
  });
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const build = resolveContentEngineBuild(desktopDir);
  assert.equal(build.manifest.version, manifest.version);
  assert.equal(build.currentSourceTreeSha256, fixtureSourceTreeSha256);
  const sourceServiceFile = path.join(sourcePaths.packageDir, "service.py");
  fs.writeFileSync(sourceServiceFile, "VALUE = 2\n", "utf8");
  assert.throws(
    () => resolveContentEngineBuild(desktopDir),
    /source tree hash does not match the current source tree/,
    "release preflight must independently reject source changes after the runtime build"
  );
  fs.writeFileSync(sourceServiceFile, "VALUE = 1\n", "utf8");
  assert.equal(
    resolveContentEngineBuild(desktopDir).currentSourceTreeSha256,
    fixtureSourceTreeSha256
  );

  const releaseTarget = path.join(root, "portable", "AI获客");
  const resourcesDir = path.join(releaseTarget, "resources");
  fs.mkdirSync(resourcesDir, { recursive: true });
  const packagedDir = copyContentEngineRuntime(build, releaseTarget);
  assert.equal(
    packagedDir,
    path.join(releaseTarget, ...CONTENT_ENGINE_RELEASE_PATH.split("/"))
  );
  assert.equal(
    fs.existsSync(path.join(packagedDir, CONTENT_ENGINE_EXECUTABLE)),
    true,
    "copy must place the EXE at resources/content-engine root"
  );
  assert.equal(
    fs.existsSync(path.join(packagedDir, "content-engine-runtime", CONTENT_ENGINE_EXECUTABLE)),
    false,
    "copy must not add another runtime directory layer"
  );
  assert.throws(
    () => copyContentEngineRuntime(build, releaseTarget),
    /Refusing to overwrite/,
    "packaging must never overwrite a pre-existing sidecar destination"
  );

  const buildCommit = manifest.source.commit;
  const descriptor = createReleaseDescriptor(build, buildCommit, "internal-evaluation");
  validateReleaseDescriptor(descriptor);
  assert.equal(descriptor.buildCommit, buildCommit);
  assert.equal(descriptor.sourceCommit, manifest.source.commit);
  assert.equal(descriptor.sourceDirty, false);
  assert.equal(descriptor.sourceTreeSha256, manifest.source.treeSha256);
  assert.throws(
    () => createReleaseDescriptor(build, buildCommit, "delivery"),
    /commercial media tools redistribution record/
  );
  assert.throws(
    () => createReleaseDescriptor({
      ...build,
      manifest: {
        ...build.manifest,
        source: { ...build.manifest.source, dirty: true }
      }
    }, buildCommit, "internal-evaluation"),
    /dirty source/
  );
  assert.throws(
    () => createReleaseDescriptor(build, "3".repeat(40), "internal-evaluation"),
    /does not match the portable release commit/
  );
  assert.equal(isContentEnginePythonSource("resources/content-engine/_internal/module.py"), true);
  assert.equal(isContentEnginePythonSource("AI获客/resources/content-engine/_internal/module.py"), false);
  assert.equal(isContentEnginePythonSource("resources/app/module.py"), false);
  assert.equal(
    isContentEngineArchivePythonSource(
      "AI获客/resources/content-engine/_internal/module.py",
      "AI获客"
    ),
    true
  );
  assert.equal(
    isContentEngineArchivePythonSource(
      "AI获客/resources/app/foo/resources/content-engine/evil.py",
      "AI获客"
    ),
    false
  );

  scanRelease(releaseTarget);
  const forbiddenPython = path.join(
    resourcesDir,
    "app",
    "foo",
    "resources",
    "content-engine",
    "evil.py"
  );
  fs.mkdirSync(path.dirname(forbiddenPython), { recursive: true });
  fs.writeFileSync(forbiddenPython, "unexpected = True\n", "utf8");
  assert.throws(
    () => scanRelease(releaseTarget),
    /blocked files/,
    "Python sources outside pinned sidecars must remain blocked"
  );
  fs.rmSync(forbiddenPython, { force: true });

  const stdout = [
    JSON.stringify({
      type: "ready",
      service: "content-engine",
      version: descriptor.version,
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
  let observedCall = null;
  const dataDir = path.join(root, "fresh-content-engine-data");
  const session = runPackagedContentEngineSelfCheck({
    releaseTarget,
    resourcesDir,
    descriptor,
    dataDir,
    spawn: (executable, args, options) => {
      observedCall = { executable, args, options };
      assert.equal(fs.existsSync(dataDir), false, "worker must own fresh data-dir creation");
      fs.mkdirSync(dataDir, { recursive: false });
      return { status: 0, stdout, stderr: "" };
    },
    mediaToolsSpawn: mediaSpawn
  });
  assert.equal(session.health.result.status, "ok");
  assert.equal(observedCall.executable, path.join(packagedDir, CONTENT_ENGINE_EXECUTABLE));
  assert.deepEqual(observedCall.args, ["--data-dir", dataDir]);
  assert.equal(observedCall.options.cwd, packagedDir);
  assert.equal(
    observedCall.options.env.XIAOXI_FFMPEG_PATH,
    path.join(packagedDir, "media-tools", "ffmpeg.exe")
  );
  assert.equal(
    observedCall.options.env.XIAOXI_FFPROBE_PATH,
    path.join(packagedDir, "media-tools", "ffprobe.exe")
  );
  assert.match(observedCall.options.input, /"method":"health"/);
  assert.match(observedCall.options.input, /"method":"shutdown"/);

  const packagedRecordFile = path.join(packagedDir, "media-tools", "licenses", "license-record.json");
  const originalPackagedRecord = fs.readFileSync(packagedRecordFile, "utf8");
  const mismatchedRuntimeRecord = JSON.parse(originalPackagedRecord);
  mismatchedRuntimeRecord.runtime.treeSha256 = "f".repeat(64);
  fs.writeFileSync(packagedRecordFile, `${JSON.stringify(mismatchedRuntimeRecord, null, 2)}\n`, "utf8");
  const mismatchedRuntimeMediaTools = JSON.parse(JSON.stringify(descriptor.mediaTools));
  mismatchedRuntimeMediaTools.licenseRecord.sha256 = sha256(packagedRecordFile);
  assert.throws(
    () => verifyBundledMediaToolFiles(packagedDir, mismatchedRuntimeMediaTools),
    /runtime closure does not match its license record/,
    "packaged media runtime closure must be bound to its license record"
  );

  const mismatchedNoticeRecord = JSON.parse(originalPackagedRecord);
  mismatchedNoticeRecord.notices[0].sha256 = "e".repeat(64);
  fs.writeFileSync(packagedRecordFile, `${JSON.stringify(mismatchedNoticeRecord, null, 2)}\n`, "utf8");
  const mismatchedNoticeMediaTools = JSON.parse(JSON.stringify(descriptor.mediaTools));
  mismatchedNoticeMediaTools.licenseRecord.sha256 = sha256(packagedRecordFile);
  assert.throws(
    () => verifyBundledMediaToolFiles(packagedDir, mismatchedNoticeMediaTools),
    /notice closure does not match its license record/,
    "packaged media notices must be bound to their license record"
  );
  fs.writeFileSync(packagedRecordFile, originalPackagedRecord, "utf8");

  assert.throws(
    () => runPackagedContentEngineSelfCheck({
      releaseTarget,
      resourcesDir,
      descriptor,
      dataDir: path.join(root, "mutating-content-engine-data"),
      spawn: (_executable, args) => {
        fs.mkdirSync(args[1], { recursive: false });
        fs.writeFileSync(path.join(resourcesDir, "mutated.txt"), "changed", "utf8");
        return { status: 0, stdout, stderr: "" };
      },
      mediaToolsSpawn: mediaSpawn
    }),
    /changed portable resources/,
    "packaged self-check must prove immutable resources"
  );
  fs.rmSync(path.join(resourcesDir, "mutated.txt"), { force: true });

  assert.throws(
    () => runPackagedContentEngineSelfCheck({
      releaseTarget,
      resourcesDir,
      descriptor,
      dataDir,
      spawn: () => ({ status: 0, stdout, stderr: "" }),
      mediaToolsSpawn: mediaSpawn
    }),
    /must be fresh/
  );


  const missingDesktop = path.join(root, "missing-desktop");
  fs.mkdirSync(missingDesktop, { recursive: true });
  assert.throws(
    () => resolveContentEngineBuild(missingDesktop),
    /Content-engine PyInstaller runtime/
  );

  assert.throws(
    () => validateReleaseDescriptor({
      ...descriptor,
      path: "resources/other"
    }),
    /unexpected content-engine runtime path/
  );

  console.log("content-engine portable release runtime self-check passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
