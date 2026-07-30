const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  RUNTIME_SPECS,
  resolveDefaultDevelopmentSidecarRuntime
} = require("./development-sidecar-runtime.cjs");

const HEAD = "a".repeat(40);

function createFixture(name, kind, provenance) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `xiaoxi-runtime-gate-${name}-`));
  const desktopDir = path.join(projectDir, "desktop");
  const spec = RUNTIME_SPECS[kind];
  const runtimePath = path.join(desktopDir, ...spec.runtimeParts);
  const manifestPath = path.join(desktopDir, ...spec.manifestParts);
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, "runtime", "utf8");
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    [spec.provenanceKey]: provenance
  }), "utf8");
  return { desktopDir, kind, manifestPath, projectDir, runtimePath, spec };
}

function cleanGit(expectedScope, head = HEAD) {
  return (projectDir, args) => {
    assert.equal(path.basename(projectDir).startsWith("xiaoxi-runtime-gate-"), true);
    if (args[0] === "rev-parse") {
      assert.deepEqual(args, ["rev-parse", "HEAD"]);
      return head;
    }
    assert.deepEqual(args, [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      expectedScope
    ]);
    return "";
  };
}

function resolveFixture(fixture, readGit) {
  return resolveDefaultDevelopmentSidecarRuntime(fixture.kind, {
    desktopDir: fixture.desktopDir,
    projectDir: fixture.projectDir,
    readGit
  });
}

function removeFixture(fixture) {
  fs.rmSync(fixture.projectDir, { recursive: true, force: true });
}

for (const [kind, expectedScope] of [
  ["product-detail", "desktop/sidecars/product-detail/app"],
  ["content-engine", "desktop/sidecars/content-engine"]
]) {
  const fixture = createFixture(`exact-${kind}`, kind, {
    commit: HEAD,
    dirty: false
  });
  try {
    assert.equal(resolveFixture(fixture, cleanGit(expectedScope)), fixture.runtimePath);
  } finally {
    removeFixture(fixture);
  }
}

{
  const fixture = createFixture("missing-field", "product-detail", { dirty: false });
  try {
    assert.equal(resolveFixture(fixture, () => { throw new Error("git must not run"); }), "");
  } finally {
    removeFixture(fixture);
  }
}

{
  const fixture = createFixture("manifest-dirty", "content-engine", {
    commit: HEAD,
    dirty: true
  });
  try {
    assert.equal(resolveFixture(fixture, () => { throw new Error("git must not run"); }), "");
  } finally {
    removeFixture(fixture);
  }
}

{
  const fixture = createFixture("commit-mismatch", "content-engine", {
    commit: "b".repeat(40),
    dirty: false
  });
  try {
    assert.equal(
      resolveFixture(fixture, cleanGit("desktop/sidecars/content-engine")),
      ""
    );
  } finally {
    removeFixture(fixture);
  }
}

{
  const fixture = createFixture("source-dirty", "product-detail", {
    commit: HEAD,
    dirty: false
  });
  try {
    const readGit = (projectDir, args) => {
      if (args[0] === "rev-parse") return HEAD;
      assert.deepEqual(args.slice(0, 5), [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        "desktop/sidecars/product-detail/app"
      ]);
      return "?? desktop/sidecars/product-detail/app/new.py";
    };
    assert.equal(resolveFixture(fixture, readGit), "");
  } finally {
    removeFixture(fixture);
  }
}

{
  const fixture = createFixture("bad-manifest", "content-engine", {
    commit: HEAD,
    dirty: false
  });
  try {
    fs.writeFileSync(fixture.manifestPath, "{not-json", "utf8");
    assert.equal(resolveFixture(fixture, () => HEAD), "");
    fs.rmSync(fixture.runtimePath);
    assert.equal(resolveFixture(fixture, () => HEAD), "");
  } finally {
    removeFixture(fixture);
  }
}

function assertMainBoundary(functionName, nextFunctionName, environmentName, kind) {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const start = source.indexOf(`function ${functionName}()`);
  const end = source.indexOf(`function ${nextFunctionName}`, start + 1);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const block = source.slice(start, end);
  const packagedIndex = block.indexOf("app.isPackaged");
  const overrideIndex = block.indexOf(environmentName);
  const defaultIndex = block.indexOf(
    `resolveDefaultDevelopmentSidecarRuntime("${kind}")`
  );
  assert.equal(packagedIndex >= 0, true);
  assert.equal(overrideIndex > packagedIndex, true);
  assert.equal(defaultIndex > overrideIndex, true);
  assert.match(block, /if \(configuredPath\) return configuredPath;/);
}

assertMainBoundary(
  "productDetailRuntimePath",
  "contentEngineRuntimePath",
  "XIAOXI_PRODUCT_DETAIL_SIDECAR",
  "product-detail"
);
assertMainBoundary(
  "contentEngineRuntimePath",
  "isAllowedProductDetailFrameNavigation",
  "XIAOXI_CONTENT_ENGINE_SIDECAR",
  "content-engine"
);

const helperSource = fs.readFileSync(
  path.join(__dirname, "development-sidecar-runtime.cjs"),
  "utf8"
);
assert.equal(helperSource.includes("treeSha256"), false);
assert.equal(helperSource.includes("createHash"), false);

console.log("development sidecar runtime self-check passed");