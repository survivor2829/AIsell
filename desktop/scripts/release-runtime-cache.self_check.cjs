const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { cachedRuntime, digest, readReuseReceipt } = require("./release-runtime-cache.cjs");
const { sha256, treeSha256 } = require("./release-tree-hash.cjs");
const product = require("./product-detail-release-runtime.cjs");
const productBuilder = require("./build-product-detail-sidecar.cjs");
const { runtimePackageHashes } = require("./build-remotion-runtime.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-cache-check-"));
try {
  const desktopDir = path.join(root, "desktop");
  const paths = productBuilder.resolveBuildPaths(desktopDir);
  fs.mkdirSync(paths.sourceDir, { recursive: true });
  fs.writeFileSync(paths.entryFile, "print('fixture')\n");
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
