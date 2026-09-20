const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JSZip = require("jszip");
const { parseBuildArgs, resolveAcceptedBaseRoot, recordAcceptedBaseRoot } = require("./build-internal-release.cjs");
const { publication } = require("./publish-internal-release.cjs");
const { stabilizePythonLibrary } = require("./python-library-archive.cjs");
const { readComponentBase, pythonLibraryReference, assertComponentBase, stabilizeEquivalentBaseFiles } = require("./component-base-input.cjs");
const { describeBaseStabilizedRuntime, treeSha256 } = require("./build-portable-release.cjs");
const { digest, treeHash } = require("../src/shared/component-contract.cjs");

async function main() {
  const packageJson = require("../package.json");
  assert.equal(packageJson.scripts["release:internal"], "node scripts/build-internal-release.cjs --default-components");
  assert.equal(packageJson.scripts["publish:internal"], "node scripts/publish-internal-release.cjs --default-components");
  assert.equal(parseBuildArgs([]).componentsOnly, true);
  assert.equal(parseBuildArgs(["--components"]).componentsOnly, true);
  assert.equal(parseBuildArgs(["--full"]).componentsOnly, false);
  assert.equal(parseBuildArgs(["--default-components", "--full"]).componentsOnly, false,
    "An explicit user --full overrides the npm entrypoint's internal default marker");
  assert.equal(parseBuildArgs(["config.json", "upgrade"]).componentsOnly, false);
  assert.equal(parseBuildArgs(["--base", "../accepted"]).baseRoot, "../accepted");
  assert.throws(() => parseBuildArgs(["--components", "--full"]));
  assert.throws(() => parseBuildArgs(["--base"]));
  assert.throws(() => parseBuildArgs(["--unknown"]));
  assert.equal(publication([]).kind, "components");
  assert.equal(publication(["--components"]).kind, "components");
  assert.equal(publication(["--full", "installer.exe", "version.json"]).kind, "full");
  assert.equal(publication(["--default-components", "--full", "installer.exe", "version.json"]).kind, "full");
  assert.throws(() => publication(["--components", "--full", "installer.exe", "version.json"]));
  assert.throws(() => publication(["installer.exe", "version.json"]));
  assert.throws(() => publication(["--full"]));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "internal-release-check-"));
  try {
    async function zip(file, list) {
      const archive = new JSZip();
      for (const [name, text] of list) archive.file(name, text, { date: new Date("2000-01-01T00:00:00Z"), createFolders: false });
      fs.writeFileSync(file, await archive.generateAsync({ type: "nodebuffer" }));
    }
    const relative = "resources/content-engine/_internal/base_library.zip";
    const acceptedFile = path.join(root, relative), candidate = path.join(root, "candidate.zip");
    fs.mkdirSync(path.dirname(acceptedFile), { recursive: true });
    const forward = [["first.pyc", "one"], ["last.pyc", "two"]];
    await zip(acceptedFile, forward);
    await zip(candidate, [...forward].reverse());
    const bytes = fs.readFileSync(acceptedFile);
    const file = { path: relative, size: bytes.length, sha256: digest(bytes), component: "base" };
    const baseline = { schema: 2, dataSchema: 2, base: { version: "1.1.6", fingerprint: treeHash([file]) }, files: [file] };
    fs.writeFileSync(path.join(root, "component-base.json"), JSON.stringify(baseline));
    const reference = pythonLibraryReference(root, readComponentBase(root, true));
    function metadata() {
      const data = fs.readFileSync(candidate), current = { ...file, sha256: digest(data), size: data.length };
      const base = { ...baseline.base, fingerprint: treeHash([current]) };
      return { baseline: { files: [current] }, manifest: { base, minBaseVersion: "1.1.6", dataSchema: 2 } };
    }
    assert.throws(() => assertComponentBase(metadata(), root), /Changed base files:.*base_library.zip/);
    assert.equal((await stabilizePythonLibrary(candidate, reference)).reused, true);
    assert.deepEqual(fs.readFileSync(candidate), bytes);
    assertComponentBase(metadata(), root);

    await zip(candidate, [["first.pyc", "changed"], ["last.pyc", "two"]]);
    assert.equal((await stabilizePythonLibrary(candidate, reference)).contentChanged, true);
    assert.throws(() => assertComponentBase(metadata(), root), /incompatible/);
    const changed = await JSZip.loadAsync(fs.readFileSync(candidate));
    assert.equal(await changed.file("first.pyc").async("string"), "changed");
    assert.deepEqual(fs.readFileSync(acceptedFile), bytes, "Accepted artifacts remain untouched");
    await assert.rejects(stabilizePythonLibrary(candidate, { ...reference, sha256: "0".repeat(64) }), /accepted base manifest/);

    const other = path.join(root, "other.zip");
    await zip(candidate, forward); await zip(other, [...forward].reverse());
    await stabilizePythonLibrary(candidate); await stabilizePythonLibrary(other);
    assert.deepEqual(fs.readFileSync(candidate), fs.readFileSync(other), "First-build ordering is deterministic");
    assert.throws(() => readComponentBase(path.join(root, "missing"), true), /--full/);

    const textRoot = path.join(root, "text-base");
    const candidateRoot = path.join(root, "text-candidate");
    const textRelative = "resources/app/src/main/bootstrap.cjs";
    const acceptedText = Buffer.from("const first = 1;\r\nconst second = 2;\r\n", "utf8");
    fs.mkdirSync(path.dirname(path.join(textRoot, textRelative)), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(candidateRoot, textRelative)), { recursive: true });
    fs.writeFileSync(path.join(textRoot, textRelative), acceptedText);
    fs.writeFileSync(path.join(candidateRoot, textRelative), "const first = 1;\nconst second = 2;\n", "utf8");
    const textFile = { path: textRelative, size: acceptedText.length, sha256: digest(acceptedText), component: "base" };
    fs.writeFileSync(path.join(textRoot, "component-base.json"), JSON.stringify({
      schema: 2, dataSchema: 2,
      base: { version: "1.1.30", fingerprint: treeHash([textFile]) },
      files: [textFile]
    }));
    fs.writeFileSync(path.join(textRoot, "版本清单.json"), JSON.stringify({ version: "1.1.30" }));
    assert.deepEqual(stabilizeEquivalentBaseFiles(candidateRoot, textRoot), [textRelative]);
    assert.deepEqual(fs.readFileSync(path.join(candidateRoot, textRelative)), acceptedText,
      "Line-ending-only base differences retain the accepted installed bytes");
    const runtimeRoot = path.join(candidateRoot, "resources", "product-detail");
    fs.mkdirSync(path.join(runtimeRoot, "_internal"), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, "_internal", "model.json"), "{}\r\n", "utf8");
    const sourceTreeSha256 = "1".repeat(64);
    const descriptor = describeBaseStabilizedRuntime({
      path: "resources/product-detail",
      treeSha256: sourceTreeSha256,
      reuseReceipt: { runtimeTreeSha256: sourceTreeSha256 }
    }, candidateRoot, [textRelative, "resources/product-detail/_internal/model.json"]);
    assert.equal(descriptor.treeSha256, treeSha256(runtimeRoot));
    assert.equal(descriptor.reuseReceipt.runtimeTreeSha256, sourceTreeSha256);
    assert.equal(descriptor.originalRuntimeTreeSha256, sourceTreeSha256);
    assert.deepEqual(descriptor.baseStabilization.files, ["resources/product-detail/_internal/model.json"]);
    assert.equal(descriptor.baseStabilization.sourceTreeSha256, sourceTreeSha256);

    const buildRoot = path.join(root, "build-records");
    assert.equal(resolveAcceptedBaseRoot(null, "test", buildRoot, textRoot), textRoot);
    recordAcceptedBaseRoot(textRoot, buildRoot);
    assert.equal(resolveAcceptedBaseRoot(null, "test", buildRoot, path.join(root, "stale-default")), textRoot,
      "A previously accepted full base remains the default for later incremental builds");
  } finally {
    require("./artifact-retention.cjs").removeOwned(path.dirname(root), root);
  }
  console.log("Internal release defaults, real archive ordering, changed dependencies and base compatibility checks passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
