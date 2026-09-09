const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { artifactTypeForEdition, validateRemotionBuildInputs } = require("./build-remotion-runtime.cjs");
const { resolveMediaToolSources } = require("./build-content-engine-sidecar.cjs");
const { cachedRuntime, runtimeFingerprint } = require("./release-runtime-cache.cjs");
const { resolveProductDetailBuild } = require("./product-detail-release-runtime.cjs");
const { resolveContentEngineBuild } = require("./content-engine-release-runtime.cjs");
const { verifyRemotionRuntime } = require("./build-remotion-runtime.cjs");

const desktopDir = path.resolve(__dirname, "..");

function createBuildRoot() {
  // The bundled Playwright browser has a deep tree. Keep the transient build
  // root short enough for Windows before any PyInstaller copy begins.
  const rootParent = path.join(os.tmpdir(), "x");
  fs.mkdirSync(rootParent, { recursive: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nonce = crypto.randomBytes(4).toString("hex");
    const candidate = path.join(rootParent, nonce);
    if (!fs.existsSync(candidate)) return candidate;
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

function runRelease(edition = "delivery", environment = process.env, { componentsOnly = false } = {}) {
  if (componentsOnly && edition !== "test") throw new Error("Component releases require the internal test channel");
  const internalUpgrade = edition === "upgrade";
  if (!internalUpgrade && environment.XIAOXI_INTERNAL_UPGRADE) {
    throw new Error("Internal upgrade flag requires the explicit upgrade entry point");
  }
  if (internalUpgrade) {
    edition = "delivery";
    environment = { ...environment, XIAOXI_INTERNAL_UPGRADE: "1" };
  }
  if (!["test", "delivery"].includes(edition)) throw new Error(`Unsupported release edition: ${edition}`);
  const inputs = preflightReleaseInputs(edition, environment);
  const { artifactType: remotionArtifactType, remotion } = inputs;
  const sidecarBuildRoot = createBuildRoot();
  const remotionRuntimeRoot = path.join(sidecarBuildRoot, "r");
  const releaseEnvironment = {
    ...environment,
    XIAOXI_PRODUCT_DETAIL_BROWSER_PATH: remotion.resolvedBrowser,
    XIAOXI_SIDECAR_BUILD_ROOT: sidecarBuildRoot,
    XIAOXI_REMOTION_RUNTIME_ROOT: remotionRuntimeRoot
  };
  try {
  runNode("source self-check", "run-self-checks.cjs", [], releaseEnvironment);
  runNode("product-detail local E2E", "product-detail-local-e2e.cjs", ["--cleanup-on-success"], releaseEnvironment);
  runNode("clean runtime gate", "check-clean-runtime.cjs", [], releaseEnvironment);
  runNode(`${edition} renderer build`, "build-renderer.cjs", [edition], releaseEnvironment);
  const commitResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: desktopDir, encoding: "utf8", windowsHide: true });
  const buildCommit = String(commitResult.stdout || "").trim();
  if (commitResult.status !== 0 || !/^[0-9a-f]{40}$/u.test(buildCommit)) throw new Error("Runtime cache requires a release source commit");
  const cacheRoot = path.join(desktopDir, ".build", "runtime-cache");
  for (const [kind, resolver, sourceOf] of [
    ["product-detail", resolveProductDetailBuild, (value) => value.manifest.desktopSource],
    ["content-engine", resolveContentEngineBuild, (value) => value.manifest.source]
  ]) {
    cachedRuntime({
      cacheRoot, kind, buildCommit, destination: sidecarBuildRoot, sourceOf,
      fingerprint: runtimeFingerprint(desktopDir, kind, remotionArtifactType, inputs, releaseEnvironment),
      resolve: (buildRoot) => resolver(desktopDir, { buildRoot }),
      artifacts: [`${kind}-runtime`, `${kind}-runtime.manifest.json`],
      build: () => runNode(`${kind} sidecar build`, `build-${kind}-sidecar.cjs`, [], releaseEnvironment)
    });
  }
  const remotionRelative = path.join("r", remotionArtifactType);
  cachedRuntime({
    cacheRoot, kind: "remotion", buildCommit, destination: sidecarBuildRoot,
    fingerprint: runtimeFingerprint(desktopDir, "remotion", remotionArtifactType, inputs, releaseEnvironment),
    resolve: (root) => verifyRemotionRuntime(path.join(root, remotionRelative), { desktopDir, expectedArtifactType: remotionArtifactType, requireCompositionSmoke: true }),
    artifacts: [remotionRelative],
    build: () => runNode("Remotion runtime build", "build-remotion-runtime.cjs", [remotionArtifactType, "--output", path.join(remotionRuntimeRoot, remotionArtifactType)], releaseEnvironment)
  });
  runNode("portable application build", "build-portable-release.cjs", [edition, ...(componentsOnly ? ["--components-only"] : [])], releaseEnvironment);
  if (internalUpgrade) runNode("in-place upgrade installer", "build-installer-release.cjs", ["upgrade"], releaseEnvironment);
  } finally {
    try { require("./artifact-retention.cjs").removeOwned(path.dirname(sidecarBuildRoot), sidecarBuildRoot); }
    catch (error) { console.warn(`Release staging cleanup deferred: ${error.message}`); }
  }
  return { stagingCleaned: !fs.existsSync(sidecarBuildRoot) };
}

if (require.main === module) {
  try {
    const result = runRelease(process.argv[2] || "delivery");
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
