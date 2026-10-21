const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { cachedRuntime, digest, readReuseReceipt, runtimeFingerprint, createFingerprintContext, pythonInputs, runtimeRecipe } = require("./release-runtime-cache.cjs");
const { sha256, treeSha256 } = require("./release-tree-hash.cjs");
const product = require("./product-detail-release-runtime.cjs");
const productBuilder = require("./build-product-detail-sidecar.cjs");
const { runtimePackageHashes } = require("./build-remotion-runtime.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-cache-check-"));
try {
  const python = path.join(root, "python.exe"), dll = path.join(root, "python312.dll");
  fs.writeFileSync(python, "interpreter"); fs.writeFileSync(dll, "runtime");
  let probes = 0;
  const fingerprintContext = createFingerprintContext({ execute: (_exe, args) => {
    probes++;
    return { status: 0, stdout: args[0] === "-c" ? JSON.stringify({ version: "3.12.7", paths: [python, dll] }) : "Some_Package==2.0\npip==24.0\n" };
  } });
  const pythonState = pythonInputs(python, {}, fingerprintContext);
  assert.equal(pythonInputs(python, {}, fingerprintContext), pythonState, "same release shares one Python environment probe");
  assert.equal(probes, 2, "probe interpreter and pip once, without scanning library trees");
  assert.deepEqual(pythonState.packages, ["pip==24.0", "some-package==2.0"]);
  const anotherRelease = createFingerprintContext({ execute: (_exe, args) => ({ status: 0,
    stdout: args[0] === "-c" ? JSON.stringify({ version: "3.12.7", paths: [python, dll] }) : "pip==24.0\nSome_Package==2.1\n" }) });
  assert.notEqual(digest(pythonInputs(python, {}, anotherRelease)), digest(pythonState), "package version changes invalidate the next release");
  for (const kind of ["product-detail", "content-engine", "remotion"]) {
    const recipe = runtimeRecipe(kind);
    assert.ok(Number.isInteger(recipe.version) && recipe.version > 0);
    assert.equal(recipe.scripts.some(file => /release-(?:runtime-cache|tree-hash|trust-record)|atomic-file/.test(file)), false,
      "cache plumbing must not invalidate runtime artifacts");
  }
  const desktopDir = path.join(root, "desktop");
  const paths = productBuilder.resolveBuildPaths(desktopDir);
  fs.mkdirSync(paths.sourceDir, { recursive: true });
  fs.writeFileSync(paths.entryFile, "print('fixture')\n");
  fs.writeFileSync(paths.snapshotFile, "{}");
  const requirements = path.join(paths.sourceRoot, "requirements-desktop.txt");
  fs.writeFileSync(requirements, "Some_Package==2.0\n");
  for (const relative of runtimeRecipe("product-detail").scripts) {
    const file = path.join(desktopDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "recipe fixture\n");
  }
  const originalFindPython = productBuilder.findBuildPython;
  productBuilder.findBuildPython = () => python;
  try {
    const inputs = { remotion: { browser: {} } };
    const fingerprint = () => runtimeFingerprint(desktopDir, "product-detail", "internal-evaluation", inputs, {}, fingerprintContext);
    const before = fingerprint();
    fs.writeFileSync(path.join(desktopDir, "scripts/release-runtime-cache.cjs"), "changed cache implementation\n");
    fs.writeFileSync(path.join(desktopDir, "src/main/atomic-file.cjs"), "changed atomic file implementation\n");
    assert.equal(fingerprint(), before, "unrelated cache/receipt implementation changes must preserve a real runtime fingerprint");
    fs.writeFileSync(requirements, "Some_Package==2.1\n");
    assert.notEqual(fingerprint(), before, "requirements changes invalidate the runtime fingerprint");
  } finally { productBuilder.findBuildPython = originalFindPython; }
  const cacheRoot = path.join(root, "cache");
  const originalCommit = "1".repeat(40);
  const releaseCommit = "2".repeat(40);
  let builds = 0;
  function run(label, commit = originalCommit) {
    const destination = path.join(root, label);
    const sourceHash = productBuilder.productDetailSourceTreeSha256(paths);
    const result = cachedRuntime({
      cacheRoot, kind: "product-detail", fingerprint: digest({ sourceHash }), buildCommit: commit, destination,
      artifacts: ["product-detail-runtime", "product-detail-runtime.manifest.json"],
      resolve: (buildRoot) => product.resolveProductDetailBuild(desktopDir, { buildRoot }),
      sourceOf: (value) => value.manifest.desktopSource,
      log: () => {},
      build: () => {
        builds += 1;
        const output = productBuilder.resolveBuildPaths(desktopDir, { buildRoot: destination });
        fs.mkdirSync(output.outputDir, { recursive: true });
        fs.writeFileSync(output.outputExe, `fixture ${sourceHash}`);
        fs.writeFileSync(output.manifestFile, JSON.stringify({
          schemaVersion: 1, version: "1.0.0", builtAt: new Date().toISOString(),
          source: { commit: originalCommit, dirty: false },
          desktopSource: { commit, dirty: false, treeSha256: sourceHash },
          runtime: { kind: "pyinstaller-onedir", entry: product.PRODUCT_DETAIL_EXECUTABLE, bundledPlaywright: false,
            exeSha256: sha256(output.outputExe), treeSha256: treeSha256(output.outputDir) }
        }));
      }
    });
    return { ...result, resolved: product.resolveProductDetailBuild(desktopDir, { buildRoot: destination }) };
  }
  assert.equal(run("first").hit, false);
  const hit = run("second", releaseCommit);
  assert.equal(hit.hit, true);
  assert.equal(builds, 1);
  assert.equal(hit.resolved.manifest.desktopSource.commit, originalCommit, "original build provenance must remain unchanged");
  const descriptor = product.createReleaseDescriptor(hit.resolved, releaseCommit);
  product.validateReleaseDescriptor(descriptor);
  assert.equal(descriptor.desktopSourceCommit, originalCommit);
  assert.equal(descriptor.buildCommit, releaseCommit);
  const cachedOutput = path.join(cacheRoot, "product-detail", digest({ sourceHash: productBuilder.productDetailSourceTreeSha256(paths) }));
  const cachedGeneration = path.join(cachedOutput, fs.readdirSync(cachedOutput)[0]);
  assert.equal(fs.statSync(path.join(cachedGeneration, "product-detail-runtime", product.PRODUCT_DETAIL_EXECUTABLE)).ino,
    fs.statSync(path.join(hit.resolved.runtimeDir, product.PRODUCT_DETAIL_EXECUTABLE)).ino, "same-volume immutable staging reuses runtime file identities");
  assert.notEqual(fs.statSync(path.join(cachedGeneration, "product-detail-runtime.manifest.json")).ino,
    fs.statSync(hit.resolved.manifestFile).ino, "provenance manifest remains independent");
  const packaged = product.copyProductDetailRuntime(hit.resolved, path.join(root, "candidate"));
  const sourceExe = path.join(hit.resolved.runtimeDir, product.PRODUCT_DETAIL_EXECUTABLE), sourceBytes = fs.readFileSync(sourceExe);
  fs.appendFileSync(path.join(packaged, product.PRODUCT_DETAIL_EXECUTABLE), "candidate-only change");
  assert.deepEqual(fs.readFileSync(sourceExe), sourceBytes, "candidate stabilization cannot mutate immutable runtime/cache hardlinks");
  assert.throws(() => product.createReleaseDescriptor({ ...hit.resolved, reuseReceipt: null }, releaseCommit), /reuse receipt/);
  assert.throws(() => product.validateReleaseDescriptor({ ...descriptor, reuseReceipt: { ...descriptor.reuseReceipt, runtimeTreeSha256: "0".repeat(64) } }), /reuse receipt/);
  fs.appendFileSync(hit.resolved.manifestFile, " ");
  assert.throws(() => readReuseReceipt(hit.resolved.manifestFile, hit.resolved.manifest, hit.resolved.manifest.desktopSource), /reuse receipt/);
  const bucket = path.join(cacheRoot, "product-detail", digest({ sourceHash: productBuilder.productDetailSourceTreeSha256(paths) }));
  const generation = path.join(bucket, fs.readdirSync(bucket)[0]);
  fs.appendFileSync(path.join(generation, "product-detail-runtime", product.PRODUCT_DETAIL_EXECUTABLE), "damaged");
  assert.equal(run("damaged-rebuild").hit, false);
  assert.equal(builds, 2);
  fs.appendFileSync(paths.entryFile, "print('changed')\n");
  assert.equal(run("source-change").hit, false);
  assert.equal(builds, 3);

  const packages = { packageJson: { version: "1.0.0", dependencies: { remotion: "4" } }, packageLock: { version: "1.0.0", packages: { "": { version: "1.0.0" }, "node_modules/remotion": { version: "4", integrity: "abc" } } } };
  const old = runtimePackageHashes(packages);
  packages.packageJson.version = packages.packageLock.version = packages.packageLock.packages[""].version = "1.1.0";
  assert.deepEqual(runtimePackageHashes(packages), old, "application version bump must not invalidate video runtime");
  packages.packageLock.packages["node_modules/remotion"].integrity = "changed";
  assert.notDeepEqual(runtimePackageHashes(packages), old, "dependency integrity remains a cache input");
  console.log("release-runtime-cache self-check passed: verified hit, source miss, damaged cache rejection, original provenance and version normalization");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
