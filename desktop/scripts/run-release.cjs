const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { artifactTypeForEdition, validateRemotionBuildInputs } = require("./build-remotion-runtime.cjs");
const { resolveMediaToolSources } = require("./build-content-engine-sidecar.cjs");
const { cachedRuntime, runtimeFingerprint, createFingerprintContext } = require("./release-runtime-cache.cjs");
const { resolveProductDetailBuild } = require("./product-detail-release-runtime.cjs");
const { resolveContentEngineBuild } = require("./content-engine-release-runtime.cjs");
const { verifyRemotionRuntime } = require("./build-remotion-runtime.cjs");
const { resolveBuildStorage, withBuildStorage, retryBuildArtifacts, buildArtifactRoots } = require("./release-build-storage.cjs");

const desktopDir = path.resolve(__dirname, "..");

function createBuildRoot(storage) {
  // The bundled Playwright browser has a deep tree. Keep the transient build
  // root short enough for Windows before any PyInstaller copy begins.
  const rootParent = storage.stagingParent;
  fs.mkdirSync(rootParent, { recursive: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nonce = crypto.randomBytes(4).toString("hex");
    const candidate = path.join(rootParent, nonce);
    if (!fs.existsSync(candidate)) {
      fs.mkdirSync(candidate);
      if (!require("./artifact-retention.cjs").retainArtifacts(rootParent, "active-staging", [candidate], 1, [candidate], { deferCleanup: true })) {
        throw Error("Cannot register release staging ownership");
      }
      return candidate;
    }
  }
  throw new Error("Unable to allocate a fresh release staging root");
}

function runNode(label, script, args, environment) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(process.execPath, [path.join("scripts", script), ...args], {
    cwd: desktopDir,
    env: environment,
    stdio: "inherit",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with status ${result.status}`);
}

function preflightReleaseInputs(edition, environment = process.env) {
  const artifactType = artifactTypeForEdition(edition, environment);
  const failures = [];
  let remotion = null;
  let mediaTools = null;
  try {
    remotion = validateRemotionBuildInputs({
      artifactType,
      browserPath: environment.XIAOXI_REMOTION_BROWSER_SOURCE_PATH || null,
      licenseRecordPath: environment.XIAOXI_REMOTION_LICENSE_RECORD || null
    });
  } catch (error) {
    failures.push(`Remotion/browser: ${error.message}`);
  }
  try {
    mediaTools = resolveMediaToolSources(environment);
    if (!mediaTools.available) {
      failures.push("Media tools: Portable releases require declared FFmpeg and ffprobe source files plus a versioned media-tools license record.");
    } else if (
      artifactType === "delivery"
      && mediaTools.licenseRecord.record.useType !== "commercial-delivery"
    ) {
      failures.push("Media tools: Delivery requires a commercial media-tools redistribution record.");
    }
  } catch (error) {
    failures.push(`Media tools: ${error.message}`);
  }
  if (failures.length) {
    throw new Error([
      `Release input preflight failed for ${edition}; no build output was created.`,
      ...failures.map((failure) => `- ${failure}`)
    ].join("\n"));
  }
  return { artifactType, mediaTools, remotion };
}

function runRelease(edition = "delivery", environment = process.env, options = {}) {
  if (options.componentsOnly && edition !== "test") throw new Error("Component releases require the internal test channel");
  if (edition !== "upgrade" && environment.XIAOXI_INTERNAL_UPGRADE) {
    throw new Error("Internal upgrade flag requires the explicit upgrade entry point");
  }
  if (!["test", "delivery", "upgrade"].includes(edition)) throw new Error(`Unsupported release edition: ${edition}`);
  const storage = options.storage || resolveBuildStorage(desktopDir, environment);
  return withBuildStorage(storage, () => {
    const space = require("./space-usage.cjs").startSpaceRun("release", [path.join(desktopDir, ".build"), storage.releaseRoot, storage.root]);
    const roots = buildArtifactRoots(storage);
    let result, failure;
    try {
      // Holding the shared build guard proves no previous build still uses its
      // staging. Drop stale references, without adopting unregistered paths.
      require("./artifact-retention.cjs").retainArtifacts(storage.stagingParent, "active-staging", [], 1, [], { deferCleanup: true });
      require("./artifact-retention.cjs").retainArtifacts(storage.releaseRoot, "active-portable-staging", [], 1, [], { deferCleanup: true });
      space.observe("cleanup-before-build", { cleanup: retryBuildArtifacts(roots) });
      if (options.spaceRequirements) space.preflight(options.spaceRequirements);
      result = runReleaseWork(edition, environment, { ...options, storage }, space);
    } catch (error) { failure = error; }
    const cleanup = retryBuildArtifacts(roots);
    space.finish(failure ? "failed" : "completed", { cleanup, buildStorage: storage.root });
    if (failure) throw failure;
    return { ...result, cleanup, buildStorage: storage.root };
  });
}

function runReleaseWork(edition = "delivery", environment = process.env, { componentsOnly = false, componentBaseRoot = null, forceChecks = false, requireCi = false, storage } = {}, space) {
  const internalUpgrade = edition === "upgrade";
  if (internalUpgrade) {
    edition = "delivery";
    environment = { ...environment, XIAOXI_INTERNAL_UPGRADE: "1" };
  }
  const baseRoot = path.resolve(componentBaseRoot || path.join(desktopDir, "../release",
    require("../product-brand.json").displayName + (edition === "test" ? "-测试版" : "")));
  const { readComponentBase, pythonLibraryReference } = require("./component-base-input.cjs");
  const baseline = readComponentBase(baseRoot, componentsOnly);
  const pythonBases = Object.fromEntries(["content-engine", "product-detail"].map(kind => [kind, pythonLibraryReference(baseRoot, baseline, kind)]));
  const inputs = preflightReleaseInputs(edition, environment);
  const { artifactType: remotionArtifactType, remotion } = inputs;
  const ciProof = require("./release-ci-proof.cjs").verifiedCiRun({ forceChecks });
  if (requireCi && !ciProof) throw Error("Complete CI provenance is required; no duplicate source checks or build started");
  const sidecarBuildRoot = createBuildRoot(storage);
  space.ownTemporary(sidecarBuildRoot);
  const remotionRuntimeRoot = path.join(sidecarBuildRoot, "r");
  const releaseEnvironment = {
    ...environment,
    XIAOXI_COMPONENT_BASE_ROOT: baseline ? baseRoot : "",
    XIAOXI_PRODUCT_DETAIL_BROWSER_PATH: remotion.resolvedBrowser,
    XIAOXI_SIDECAR_BUILD_ROOT: sidecarBuildRoot,
    XIAOXI_REMOTION_RUNTIME_ROOT: remotionRuntimeRoot
  };
  try {
  if (ciProof) console.log(`Reusing source and local E2E checks from Windows CI ${ciProof.runId} (${ciProof.commit}).`);
  else {
    console.log("No complete CI proof for this clean revision; running source and local E2E checks.");
    runNode("source self-check", "run-self-checks.cjs", [], releaseEnvironment);
    runNode("product-detail local E2E", "product-detail-local-e2e.cjs", ["--cleanup-on-success"], releaseEnvironment);
  }
  space.observe("source-validation-complete", { ciProof });
  runNode("clean runtime gate", "check-clean-runtime.cjs", [], releaseEnvironment);
  runNode(`${edition} renderer build`, "build-renderer.cjs", [edition], releaseEnvironment);
  const commitResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: desktopDir, encoding: "utf8", windowsHide: true });
  const buildCommit = String(commitResult.stdout || "").trim();
  if (commitResult.status !== 0 || !/^[0-9a-f]{40}$/u.test(buildCommit)) throw new Error("Runtime cache requires a release source commit");
  const cacheRoot = storage.cacheRoot;
  const fingerprintContext = createFingerprintContext();
  for (const [kind, resolver, sourceOf] of [
    ["product-detail", resolveProductDetailBuild, (value) => value.manifest.desktopSource],
    ["content-engine", resolveContentEngineBuild, (value) => value.manifest.source]
  ]) {
    const pythonBase = pythonBases[kind];
    const buildEnvironment = { ...releaseEnvironment,
      XIAOXI_PYTHON_BASE_REFERENCE: pythonBase?.file || "", XIAOXI_PYTHON_BASE_SHA256: pythonBase?.sha256 || "" };
    cachedRuntime({
      cacheRoot, fallbackCacheRoots: storage.fallbackCacheRoots, kind, buildCommit, destination: sidecarBuildRoot, sourceOf,
      fingerprint: runtimeFingerprint(desktopDir, kind, remotionArtifactType, inputs, buildEnvironment, fingerprintContext),
      resolve: (buildRoot) => resolver(desktopDir, { buildRoot }),
      artifacts: [`${kind}-runtime`, `${kind}-runtime.manifest.json`],
      build: () => runNode(`${kind} sidecar build`, `build-${kind}-sidecar.cjs`, [], buildEnvironment)
    });
  }
  const remotionRelative = path.join("r", remotionArtifactType);
  cachedRuntime({
    cacheRoot, fallbackCacheRoots: storage.fallbackCacheRoots, kind: "remotion", buildCommit, destination: sidecarBuildRoot,
    fingerprint: runtimeFingerprint(desktopDir, "remotion", remotionArtifactType, inputs, releaseEnvironment, fingerprintContext),
    resolve: (root) => verifyRemotionRuntime(path.join(root, remotionRelative), { desktopDir, expectedArtifactType: remotionArtifactType, requireCompositionSmoke: true }),
    artifacts: [remotionRelative],
    build: () => runNode("Remotion runtime build", "build-remotion-runtime.cjs", [remotionArtifactType, "--output", path.join(remotionRuntimeRoot, remotionArtifactType)], releaseEnvironment)
  });
  space.observe("runtime-build-complete");
  runNode("portable application build", "build-portable-release.cjs", [edition, ...(componentsOnly ? ["--components-only"] : [])], releaseEnvironment);
  space.observe("build-and-packaged-validation-complete");
  if (internalUpgrade) runNode("in-place upgrade installer", "build-installer-release.cjs", ["upgrade"], releaseEnvironment);
  } finally {
    require("./artifact-retention.cjs").retainArtifacts(storage.stagingParent, "active-staging", [], 1, []);
    space.observe("cleanup-complete", { stagingRemoved: !fs.existsSync(sidecarBuildRoot) });
  }
  const candidateRoot = componentsOnly ? JSON.parse(fs.readFileSync(path.join(desktopDir,
    "../release/components/test/unsigned-component-release.json"), "utf8")).validation.candidateRoot : null;
  return { stagingCleaned: !fs.existsSync(sidecarBuildRoot), ciProof, ...(candidateRoot ? { candidateRoot } : {}) };
}

if (require.main === module) {
  try {
    const result = runRelease(process.argv[2] || "delivery", process.env, { forceChecks: process.argv.includes("--force-checks") });
    console.log(`\nRelease staging cleaned: ${result.stagingCleaned}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = {
  createBuildRoot,
  preflightReleaseInputs,
  runRelease
};
