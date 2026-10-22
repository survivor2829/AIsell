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
  const { baseUpgradeReview } = require("./component-base-input.cjs");
  const previousBase = { schema: 2, updateProtocol: 5, base: { version: "1.1.105", fingerprint: "a".repeat(64) },
    files: [{ path: "electron.exe", component: "base", size: 1, sha256: "a".repeat(64) }] };
  const upgradedBase = { ...previousBase, files: [{ ...previousBase.files[0], sha256: "b".repeat(64) }] };
  assert.equal(baseUpgradeReview(previousBase, upgradedBase).allowed, false, "a full build must require an explicit large runtime upgrade reason");
  assert.equal(baseUpgradeReview(previousBase, upgradedBase, "electron-runtime").allowed, true);
  const leakedCode = { ...upgradedBase, files: [...upgradedBase.files,
    { path: "resources/app/src/main/ordinary-business.cjs", component: "base", size: 1, sha256: "c".repeat(64) }] };
  assert.equal(baseUpgradeReview(previousBase, leakedCode, "electron-runtime").allowed, false,
    "declaring an Electron upgrade cannot admit ordinary code into the base");
  const leakedPython = { ...previousBase, files: [...previousBase.files,
    { path: "resources/content-engine/_internal/content_engine/ordinary_business.py", component: "base", size: 1, sha256: "c".repeat(64) }] };
  assert.equal(baseUpgradeReview(previousBase, leakedPython, "python-runtime").allowed, false,
    "a Python runtime declaration cannot override the canonical ownership of business source");
  assert.equal(baseUpgradeReview(previousBase, { ...previousBase, base: { ...previousBase.base, version: "1.1.106" } }).allowed, false,
    "a label-only base bump must not force another full installation");
  assert.equal(baseUpgradeReview({ ...previousBase, updateProtocol: 4 }, leakedCode).changes.every(change => change.reason === "protocol-transition"), true);
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
  assert.equal(parseBuildArgs(["--force-checks"]).forceChecks, true);
  assert.equal(parseBuildArgs(["--require-ci"]).requireCi, true);
  assert.throws(() => parseBuildArgs(["--require-ci", "--force-checks"]));
  const { verifiedCiRun } = require("./release-ci-proof.cjs");
  const commit = "a".repeat(40);
  const calls = [];
  const ci = (command, args) => {
    calls.push([command, args]);
    if (command === "git") return { status: 0, stdout: args[0] === "status" ? "" : commit };
    return { status: 0, stdout: JSON.stringify(args[1] === "list"
      ? [{ databaseId: 42, headSha: commit, conclusion: "success", event: "push" }]
      : { headSha: commit, conclusion: "success", jobs: [
        { name: "source-and-renderer", conclusion: "success", steps: [] },
        { name: "service-and-content", conclusion: "success", steps: [{ name: "Product detail local E2E", conclusion: "success" }] }
      ] }) };
  };
  assert.equal(verifiedCiRun({ execute: ci }), null,
    "The former two-job workflow cannot authorize skipping the new required groups");
  const legacyCi = ci;
  const groupedCi = (command, args) => {
    const result = legacyCi(command, args);
    if (command === "gh" && args[1] === "view") {
      const run = JSON.parse(result.stdout);
      run.jobs.push(...["core", "moments-visual", "reply-visual", "rpa", "runtime"].map(group =>
        ({ name: "source-" + group, conclusion: "success", steps: [] })));
      result.stdout = JSON.stringify(run);
    }
    return result;
  };
  assert.equal(verifiedCiRun({ execute: groupedCi }).runId, 42);
  for (const missing of [true, false]) {
    for (const conclusion of ["skipped", "cancelled", "failure"]) {
      assert.equal(verifiedCiRun({ execute: (command, args) => {
        const result = groupedCi(command, args);
        if (command === "gh" && args[1] === "view") {
          const run = JSON.parse(result.stdout);
          if (missing) run.jobs.pop();
          else run.jobs.at(-1).conclusion = conclusion;
          result.stdout = JSON.stringify(run);
        }
        return result;
      } }), null, "Every required group must exist and succeed: " + conclusion);
    }
  }
  const withEvent = event => (command, args) => {
    const result = groupedCi(command, args);
    if (command === "gh" && args[1] === "list") {
      const runs = JSON.parse(result.stdout); runs[0].event = event; result.stdout = JSON.stringify(runs);
    }
    return result;
  };
  assert.equal(verifiedCiRun({ execute: withEvent("workflow_dispatch") })?.runId, 42,
    "An exact-revision manual source workflow with all required jobs is valid evidence");
  assert.equal(verifiedCiRun({ execute: withEvent("pull_request") }), null,
    "A PR's synthetic checkout must not masquerade as an exact release revision");
  assert.equal(verifiedCiRun({ execute: ci, forceChecks: true }), null);
  assert.equal(verifiedCiRun({ execute: () => ({ status: 1 }) }), null);
  assert.equal(verifiedCiRun({ execute: (command, args) => command === "git" && args[0] === "status"
    ? { status: 0, stdout: " M package.json" } : ci(command, args) }), null);
  assert.equal(verifiedCiRun({ execute: (command, args) => {
    const result = groupedCi(command, args);
    if (command === "gh" && args[1] === "view") {
      const run = JSON.parse(result.stdout); run.jobs[1].steps = []; result.stdout = JSON.stringify(run);
    }
    return result;
  } }), null, "Old CI without the local E2E cannot authorize skipping it");

  // The former implementation rejects this valid chain (main jobs skipped),
  // while accepting a summary alone would silently lose all required checks.
  function reusedFixture(change = () => {}) {
    const head = "b".repeat(40), tested = "c".repeat(40), tree = "d".repeat(40), base = "e".repeat(40);
    const repository = "owner/repo";
    const proof = { schema: 1, repository, runId: 84, attempt: 1, pullRequest: 7, head, base, commit: tested, tree };
    const sourceJobs = JSON.parse(groupedCi("gh", ["run", "view"]).stdout).jobs;
    const data = {
      [`git/commits/${commit}`]: { sha: commit, tree: { sha: tree }, parents: [{ sha: base }] },
      [`git/commits/${tested}`]: { sha: tested, tree: { sha: tree }, parents: [{ sha: base }, { sha: head }] },
      [`commits/${commit}/pulls?per_page=100`]: [{ number: 7, merged_at: "2026-10-21T00:00:00Z", merge_commit_sha: commit,
        base: { ref: "main", repo: { full_name: repository } }, head: { sha: head, repo: { full_name: repository } } }],
      "actions/runs/84": { id: 84, repository: { full_name: repository }, head_repository: { full_name: repository },
        head_sha: head, event: "pull_request", path: ".github/workflows/ci.yml", status: "completed", conclusion: "success", run_attempt: 1 },
      "actions/runs/84/jobs?filter=latest&per_page=100": { total_count: sourceJobs.length, jobs: sourceJobs },
      "actions/runs/84/artifacts?per_page=100": { total_count: 1, artifacts: [{ name: "source-ci-proof-1", expired: false }] }
    };
    change({ data, proof, sourceJobs, commit, tested });
    return (command, args) => {
      if (command === "gh" && args[0] === "repo") return { status: 0, stdout: JSON.stringify({ nameWithOwner: repository }) };
      if (command === "gh" && args[0] === "api") {
        const value = data[args[1].replace(`repos/${repository}/`, "")];
        return { status: value ? 0 : 1, stdout: JSON.stringify(value) };
      }
      if (command === "gh" && args[1] === "download") {
        fs.writeFileSync(path.join(args[args.indexOf("--dir") + 1], "ci-source-proof.json"), JSON.stringify(proof));
        return { status: 0, stdout: "" };
      }
      if (command === "gh" && args[1] === "list" && args.includes("--repo")) return { status: 0,
        stdout: JSON.stringify([{ databaseId: 84, headSha: head, event: "pull_request", conclusion: "success" }]) };
      const result = groupedCi(command, args);
      if (command === "gh" && args[1] === "view") {
        const run = JSON.parse(result.stdout);
        for (const job of run.jobs) if (job.name !== "source-and-renderer") job.conclusion = "skipped";
        run.jobs.push({ name: "ci-source-proof", conclusion: "success", steps: [
          { name: "Verify unchanged merge tree and required CI", conclusion: "success" }] });
        result.stdout = JSON.stringify(run);
      }
      return result;
    };
  }
  assert.equal(verifiedCiRun({ execute: reusedFixture() })?.sourceRunId, 84,
    "An independently verified identical synthetic merge tree can replace duplicate main checks");
  for (const mutate of [
    ({ data, commit }) => { data[`git/commits/${commit}`].tree.sha = "f".repeat(40); },
    ({ data, tested }) => { data[`git/commits/${tested}`].parents.pop(); },
    ({ proof }) => { proof.base = "f".repeat(40); },
    ({ proof }) => { proof.attempt = 2; },
    ({ sourceJobs }) => { sourceJobs.at(-1).conclusion = "skipped"; },
    ({ sourceJobs }) => { sourceJobs.find(job => job.name === "service-and-content").steps = []; },
    ({ data }) => { data["actions/runs/84/artifacts?per_page=100"].artifacts[0].expired = true; },
    ({ data }) => { data["actions/runs/84"].head_repository.full_name = "foreign/repo"; }
  ]) assert.equal(verifiedCiRun({ execute: reusedFixture(mutate) }), null,
    "A changed tree/range, unproven checkout, incomplete run or expired/foreign evidence must fail closed");

  const { waitForCi } = require("./internal-release-pipeline.cjs");
  let polls = 0, clock = 0;
  const waiting = { execute: () => ({ status: 0, stdout: JSON.stringify([{ headSha: commit, event: "push", databaseId: 42,
    status: ++polls === 1 ? "in_progress" : "completed", conclusion: "success" }]) }), now: () => clock,
    sleep: async () => { clock += 10000; } };
  assert.equal(await waitForCi(commit, waiting), 42);
  assert.equal(polls, 2, "wait for the existing run instead of starting duplicate local checks");
  await assert.rejects(waitForCi(commit, { execute: () => ({ status: 0, stdout: JSON.stringify([
    { headSha: commit, event: "push", status: "completed", conclusion: "failure" }]) }) }), /did not succeed/);
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
