const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildManifest,
  buildPyInstallerArgs,
  ensureSafeBuildTarget,
  resolveBuildPaths,
  sourceProvenance,
  validateSelfCheckPayload
} = require("./build-product-detail-sidecar.cjs");

const paths = resolveBuildPaths();
assert.equal(
  paths.outputDir,
  path.join(paths.buildRoot, "product-detail-runtime"),
  "runtime output directory must stay fixed"
);
assert.equal(
  paths.outputExe,
  path.join(paths.outputDir, "product-detail-server.exe"),
  "runtime executable must live at the output root"
);
assert.equal(
  paths.manifestFile,
  path.join(paths.buildRoot, "product-detail-runtime.manifest.json")
);

const args = buildPyInstallerArgs(paths);
assert.ok(args.includes("--onedir"), "sidecar must be a self-contained onedir build");
assert.ok(!args.includes("--onefile"), "sidecar must not use onefile extraction");
assert.deepEqual(
  args.slice(args.indexOf("--name"), args.indexOf("--name") + 2),
  ["--name", "product-detail-server"]
);
assert.deepEqual(
  args.slice(args.indexOf("--distpath"), args.indexOf("--distpath") + 2),
  ["--distpath", paths.distDir]
);
assert.ok(
  args.some((value) => value === `${paths.templatesDir}${path.delimiter}templates`),
  "templates must be bundled below the frozen resource root"
);
assert.ok(
  args.some((value) => value === `${paths.staticDir}${path.delimiter}static`),
  "static assets must be bundled beside the frozen entry module"
);
assert.ok(
  args.some((value) => value === `${paths.playwrightBrowsersDir}${path.delimiter}playwright-browsers`),
  "the controlled Playwright browser must be bundled"
);
assert.deepEqual(
  args.slice(args.indexOf("--collect-all"), args.indexOf("--collect-all") + 2),
  ["--collect-all", "playwright"]
);
assert.equal(args.at(-1), paths.entryFile);

assert.equal(ensureSafeBuildTarget(paths.outputDir, paths.buildRoot), paths.outputDir);
assert.throws(
  () => ensureSafeBuildTarget(paths.buildRoot, paths.buildRoot),
  /build root itself/
);
assert.throws(
  () => ensureSafeBuildTarget(path.resolve(paths.buildRoot, "..", "escape"), paths.buildRoot),
  /outside desktop\/\.build/
);

const provenance = sourceProvenance({
  source: {
    head: "abc123",
    trackedModifiedCount: 2,
    untrackedCount: 3
  },
  snapshot: {
    treeSha256BeforeDesktopAdaptation: "snapshot-tree"
  }
});
assert.deepEqual(provenance, {
  commit: "abc123",
  dirty: true,
  trackedModifiedCount: 2,
  untrackedCount: 3,
  snapshotTreeSha256BeforeDesktopAdaptation: "snapshot-tree"
});

assert.deepEqual(
  validateSelfCheckPayload({
    ok: true,
    mode: "desktop",
    version: "2.0.0-desktop",
    resource_dir: "C:\\runtime\\_internal",
    templates_dir: "C:\\runtime\\_internal\\templates",
    static_dir: "C:\\data\\static"
  }),
  {
    ok: true,
    mode: "desktop",
    version: "2.0.0-desktop",
    resource_dir: "C:\\runtime\\_internal",
    templates_dir: "C:\\runtime\\_internal\\templates",
    static_dir: "C:\\data\\static"
  }
);
assert.throws(
  () => validateSelfCheckPayload({ ok: false, version: "2.0.0-desktop" }),
  /not ok/
);
assert.throws(
  () => validateSelfCheckPayload({ ok: true, mode: "desktop", version: "" }),
  /version/
);

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-product-detail-build-"));
try {
  const runtimeDir = path.join(fixtureRoot, "runtime");
  fs.mkdirSync(runtimeDir);
  const exe = path.join(runtimeDir, "product-detail-server.exe");
  fs.writeFileSync(exe, "fixture executable", "utf8");
  fs.writeFileSync(path.join(runtimeDir, "dependency.dll"), "fixture dependency", "utf8");
  const manifest = buildManifest({
    outputDir: runtimeDir,
    outputExe: exe,
    version: "2.0.0-desktop",
    source: provenance,
    bundledPlaywright: true,
    builtAt: "2026-07-30T00:00:00.000Z"
  });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.runtime.kind, "pyinstaller-onedir");
  assert.equal(manifest.runtime.entry, "product-detail-server.exe");
  assert.equal(manifest.runtime.bundledPlaywright, true);
  assert.match(manifest.runtime.exeSha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.runtime.treeSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.version, "2.0.0-desktop");
  assert.deepEqual(manifest.source, provenance);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log("product detail sidecar build self-check passed");
