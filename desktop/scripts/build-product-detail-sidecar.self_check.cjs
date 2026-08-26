const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildManifest,
  buildPyInstallerArgs,
  desktopSourceProvenance,
  ensureSafeBuildTarget,
  assertWindowsPathBudget,
  isProductDetailSourceFile,
  productDetailSourceFiles,
  productDetailSourceTreeSha256,
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

const tooDeepPaths = resolveBuildPaths(undefined, {
  buildRoot: path.join(os.tmpdir(), "xiaoxi-product-detail-path-budget", "x".repeat(220))
});
assert.throws(
  () => assertWindowsPathBudget(tooDeepPaths),
  /staging root is too deep/,
  "the build must reject a staging path that would exceed the Windows Playwright path budget"
);

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
  const fixturePaths = resolveBuildPaths(path.join(fixtureRoot, "desktop"));
  fs.mkdirSync(fixturePaths.sourceDir, { recursive: true });
  fs.writeFileSync(fixturePaths.entryFile, "from app import app\n", "utf8");
  fs.writeFileSync(path.join(fixturePaths.sourceDir, "app.py"), "app = object()\n", "utf8");
  fs.writeFileSync(path.join(fixturePaths.sourceDir, "conftest.py"), "IGNORED = True\n", "utf8");
  fs.mkdirSync(fixturePaths.templatesDir, { recursive: true });
  fs.writeFileSync(path.join(fixturePaths.templatesDir, "workspace.html"), "<main>fixture</main>\n", "utf8");
  fs.mkdirSync(fixturePaths.staticDir, { recursive: true });
  fs.writeFileSync(path.join(fixturePaths.staticDir, "app.js"), "window.fixture = true;\n", "utf8");
  const refineDir = path.join(fixturePaths.sourceDir, "ai_refine_v2");
  fs.mkdirSync(path.join(refineDir, "prompts", "templates"), { recursive: true });
  fs.writeFileSync(path.join(refineDir, "pipeline.py"), "VALUE = 1\n", "utf8");
  fs.writeFileSync(path.join(refineDir, "screen_types.yaml"), "screens: []\n", "utf8");
  fs.writeFileSync(path.join(refineDir, "prompts", "templates", "hero.j2"), "hero\n", "utf8");
  fs.mkdirSync(path.join(refineDir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(refineDir, "tests", "test_pipeline.py"), "IGNORED = True\n", "utf8");
  fs.mkdirSync(path.join(refineDir, "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(refineDir, "__pycache__", "pipeline.pyc"), "ignored", "utf8");
  const pubsubDir = path.join(fixturePaths.sourceDir, "pubsub");
  fs.mkdirSync(pubsubDir, { recursive: true });
  fs.writeFileSync(path.join(pubsubDir, "memory.py"), "VALUE = 1\n", "utf8");
  fs.mkdirSync(path.join(fixturePaths.sourceDir, "instance"), { recursive: true });
  fs.writeFileSync(path.join(fixturePaths.sourceDir, "instance", "runtime.db"), "ignored", "utf8");

  assert.equal(isProductDetailSourceFile("desktop_entry.py"), true);
  assert.equal(isProductDetailSourceFile("conftest.py"), false);
  assert.equal(isProductDetailSourceFile("ai_refine_v2/tests/test_pipeline.py"), false);
  assert.equal(isProductDetailSourceFile("ai_refine_v2/__pycache__/pipeline.pyc"), false);
  assert.equal(isProductDetailSourceFile("static/app.js"), true);
  assert.equal(isProductDetailSourceFile("instance/runtime.db"), false);
  const included = productDetailSourceFiles(fixturePaths)
    .map((file) => path.relative(fixturePaths.sourceDir, file).replaceAll("\\", "/"));
  assert.deepEqual(included, [...included].sort((left, right) => Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8")
  )));
  const fixtureSourceHash = productDetailSourceTreeSha256(fixturePaths);
  assert.match(fixtureSourceHash, /^[0-9a-f]{64}$/);
  fs.writeFileSync(path.join(refineDir, "__pycache__", "other.pyc"), "still ignored", "utf8");
  fs.writeFileSync(path.join(refineDir, "tests", "other.py"), "still ignored\n", "utf8");
  assert.equal(
    productDetailSourceTreeSha256(fixturePaths),
    fixtureSourceHash,
    "cache and tests must not affect the packaged source identity"
  );
  fs.writeFileSync(path.join(fixturePaths.templatesDir, "workspace.html"), "<main>changed</main>\n", "utf8");
  assert.notEqual(
    productDetailSourceTreeSha256(fixturePaths),
    fixtureSourceHash,
    "a bundled template edit must change the packaged source identity"
  );
  fs.writeFileSync(path.join(fixturePaths.templatesDir, "workspace.html"), "<main>fixture</main>\n", "utf8");
  assert.equal(productDetailSourceTreeSha256(fixturePaths), fixtureSourceHash);

  const gitCalls = [];
  const dirtyDesktopSource = desktopSourceProvenance(fixturePaths, (projectDir, args) => {
    gitCalls.push({ projectDir, args });
    return args[0] === "rev-parse" ? "d".repeat(40) : "?? desktop/sidecars/product-detail/app/new.py";
  });
  assert.equal(dirtyDesktopSource.dirty, true);
  assert.equal(dirtyDesktopSource.treeSha256, fixtureSourceHash);
  assert.deepEqual(gitCalls[1].args, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    "desktop/sidecars/product-detail/app"
  ]);
  const docsOnlyDesktopSource = desktopSourceProvenance(fixturePaths, (projectDir, args) => (
    args[0] === "rev-parse"
      ? "d".repeat(40)
      : " D desktop/sidecars/product-detail/app/docs/assets/readme-hero-ai.png"
  ));
  assert.equal(
    docsOnlyDesktopSource.dirty,
    false,
    "documentation-only changes must not mark the packaged product-detail source dirty"
  );
  const cleanDesktopSource = { ...dirtyDesktopSource, dirty: false };

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
    desktopSource: cleanDesktopSource,
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
  assert.deepEqual(manifest.desktopSource, cleanDesktopSource);
  assert.throws(
    () => buildManifest({
      outputDir: runtimeDir,
      outputExe: exe,
      version: "2.0.0-desktop",
      source: provenance
    }),
    /desktop source commit/,
    "legacy manifests without desktop source provenance must be impossible to build"
  );
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log("product detail sidecar build self-check passed");
