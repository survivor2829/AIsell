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
  resolveBuildPaths,
  sourceTreeSha256
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
  const manifest = {
    schemaVersion: 1,
    version: "0.1.0-fixture",
    builtAt: "2026-07-30T00:00:00.000Z",
    source: {
      commit: "1".repeat(40),
      dirty: false,
      treeSha256: fixtureSourceTreeSha256
    },
    runtime: {
      kind: "pyinstaller-onedir",
      entry: CONTENT_ENGINE_EXECUTABLE,
      exeSha256: sha256(path.join(runtimeDir, CONTENT_ENGINE_EXECUTABLE)),
      treeSha256: treeSha256(runtimeDir)
    },
    selfCheck: {
      protocolVersion: 1,
      ready: true,
      health: true,
      shutdown: true
    }
  };
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
  const descriptor = createReleaseDescriptor(build, buildCommit);
  validateReleaseDescriptor(descriptor);
  assert.equal(descriptor.buildCommit, buildCommit);
  assert.equal(descriptor.sourceCommit, manifest.source.commit);
  assert.equal(descriptor.sourceDirty, false);
  assert.equal(descriptor.sourceTreeSha256, manifest.source.treeSha256);
  assert.throws(
    () => createReleaseDescriptor({
      ...build,
      manifest: {
        ...build.manifest,
        source: { ...build.manifest.source, dirty: true }
      }
    }, buildCommit),
    /dirty source/
  );
  assert.throws(
    () => createReleaseDescriptor(build, "3".repeat(40)),
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
    }
  });
  assert.equal(session.health.result.status, "ok");
  assert.equal(observedCall.executable, path.join(packagedDir, CONTENT_ENGINE_EXECUTABLE));
  assert.deepEqual(observedCall.args, ["--data-dir", dataDir]);
  assert.equal(observedCall.options.cwd, packagedDir);
  assert.match(observedCall.options.input, /"method":"health"/);
  assert.match(observedCall.options.input, /"method":"shutdown"/);

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
      }
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
      spawn: () => ({ status: 0, stdout, stderr: "" })
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
