const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanRelease } = require("./build-portable-release.cjs");
const { sha256, treeSha256 } = require("./release-tree-hash.cjs");
const {
  PRODUCT_DETAIL_EXECUTABLE,
  PRODUCT_DETAIL_RELEASE_PATH,
  copyProductDetailRuntime,
  createReleaseDescriptor,
  isProductDetailArchivePythonSource,
  isProductDetailPythonSource,
  resolveProductDetailBuild,
  runPackagedProductDetailSelfCheck,
  validateReleaseDescriptor
} = require("./product-detail-release-runtime.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-product-detail-release-"));

try {
  const desktopDir = path.join(root, "desktop");
  const buildRoot = path.join(desktopDir, ".build");
  const runtimeDir = path.join(buildRoot, "product-detail-runtime");
  const manifestFile = path.join(buildRoot, "product-detail-runtime.manifest.json");
  fs.mkdirSync(path.join(runtimeDir, "_internal", "playwright"), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, PRODUCT_DETAIL_EXECUTABLE), "fixture-executable", "utf8");
  fs.writeFileSync(
    path.join(runtimeDir, "_internal", "playwright", "dependency.py"),
    "fixture_dependency = True\n",
    "utf8"
  );
  const manifest = {
    schemaVersion: 1,
    version: "2.0.0-fixture",
    builtAt: "2026-07-30T00:00:00.000Z",
    source: {
      commit: "1".repeat(40),
      dirty: true
    },
    runtime: {
      kind: "pyinstaller-onedir",
      entry: PRODUCT_DETAIL_EXECUTABLE,
      bundledPlaywright: true,
      exeSha256: sha256(path.join(runtimeDir, PRODUCT_DETAIL_EXECUTABLE)),
      treeSha256: treeSha256(runtimeDir)
    }
  };
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const build = resolveProductDetailBuild(desktopDir);
  assert.equal(build.manifest.version, manifest.version);

  const releaseTarget = path.join(root, "portable", "AI获客");
  const resourcesDir = path.join(releaseTarget, "resources");
  fs.mkdirSync(resourcesDir, { recursive: true });
  const packagedDir = copyProductDetailRuntime(build, releaseTarget);
  assert.equal(
    packagedDir,
    path.join(releaseTarget, ...PRODUCT_DETAIL_RELEASE_PATH.split("/"))
  );
  assert.equal(
    fs.existsSync(path.join(packagedDir, PRODUCT_DETAIL_EXECUTABLE)),
    true,
    "copy must place the EXE at resources/product-detail root"
  );
  assert.equal(
    fs.existsSync(path.join(packagedDir, "product-detail-runtime", PRODUCT_DETAIL_EXECUTABLE)),
    false,
    "copy must not add another runtime directory layer"
  );
  assert.throws(
    () => copyProductDetailRuntime(build, releaseTarget),
    /Refusing to overwrite/,
    "packaging must never overwrite a pre-existing sidecar destination"
  );

  const buildCommit = "2".repeat(40);
  const descriptor = createReleaseDescriptor(build, buildCommit);
  validateReleaseDescriptor(descriptor);
  assert.equal(descriptor.buildCommit, buildCommit);
  assert.equal(descriptor.sourceCommit, manifest.source.commit);
  assert.equal(descriptor.sourceDirty, true);
  assert.equal(isProductDetailPythonSource("resources/product-detail/_internal/module.py"), true);
  assert.equal(isProductDetailPythonSource("AI获客/resources/product-detail/_internal/module.py"), false);
  assert.equal(isProductDetailPythonSource("resources/app/module.py"), false);
  assert.equal(isProductDetailPythonSource("resources/app/foo/resources/product-detail/evil.py"), false);
  assert.equal(isProductDetailArchivePythonSource("AI获客/resources/product-detail/_internal/module.py", "AI获客"), true);
  assert.equal(isProductDetailArchivePythonSource("AI获客/resources/app/foo/resources/product-detail/evil.py", "AI获客"), false);
  assert.equal(isProductDetailArchivePythonSource("other/resources/product-detail/evil.py", "AI获客"), false);
  const allowedPortableRelative = path.relative(
    releaseTarget,
    path.join(packagedDir, "_internal", "playwright", "dependency.py")
  ).replaceAll("\\", "/");
  const nestedPortableRelative = path.relative(
    releaseTarget,
    path.join(resourcesDir, "app", "foo", "resources", "product-detail", "evil.py")
  ).replaceAll("\\", "/");
  assert.equal(isProductDetailPythonSource(allowedPortableRelative), true);
  assert.equal(isProductDetailPythonSource(nestedPortableRelative), false);

  scanRelease(releaseTarget);
  const forbiddenPython = path.join(resourcesDir, "app", "foo", "resources", "product-detail", "evil.py");
  fs.mkdirSync(path.dirname(forbiddenPython), { recursive: true });
  fs.writeFileSync(forbiddenPython, "unexpected = True\n", "utf8");
  assert.throws(() => scanRelease(releaseTarget), /blocked files/, "Python sources outside the pinned sidecar must remain blocked");
  fs.rmSync(forbiddenPython, { force: true });

  let observedCall = null;
  const dataDir = path.join(root, "fresh-product-detail-data");
  const payload = runPackagedProductDetailSelfCheck({
    releaseTarget,
    resourcesDir,
    descriptor,
    dataDir,
    spawn: (executable, args, options) => {
      observedCall = { executable, args, options };
      assert.equal(fs.existsSync(dataDir), true, "self-check must create the fresh data directory");
      return {
        status: 0,
        stdout: JSON.stringify({
          ok: true,
          mode: "desktop",
          version: descriptor.version
        }),
        stderr: ""
      };
    }
  });
  assert.equal(payload.ok, true);
  assert.equal(observedCall.executable, path.join(packagedDir, PRODUCT_DETAIL_EXECUTABLE));
  assert.deepEqual(observedCall.args, ["--self-check", "--data-dir", dataDir]);
  assert.equal(observedCall.options.cwd, packagedDir);
  assert.equal(observedCall.options.env.PYTHONUTF8, "1");

  assert.throws(
    () => runPackagedProductDetailSelfCheck({
      releaseTarget,
      resourcesDir,
      descriptor,
      dataDir: path.join(root, "mutating-product-detail-data"),
      spawn: () => {
        fs.writeFileSync(path.join(resourcesDir, "mutated.txt"), "changed", "utf8");
        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            mode: "desktop",
            version: descriptor.version
          }),
          stderr: ""
        };
      }
    }),
    /changed portable resources/,
    "sidecar self-check must prove that packaged resources remain immutable"
  );

  const missingDesktop = path.join(root, "missing-desktop");
  fs.mkdirSync(missingDesktop);
  assert.throws(
    () => resolveProductDetailBuild(missingDesktop),
    /runtime.*missing/i,
    "a missing prebuilt sidecar must fail explicitly"
  );

  assert.throws(
    () => validateReleaseDescriptor({
      ...descriptor,
      path: "resources/elsewhere"
    }),
    /unexpected product-detail runtime path/
  );

  console.log("product-detail portable release runtime self-check passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
