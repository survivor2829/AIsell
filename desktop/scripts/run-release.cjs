const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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

function runRelease(edition = "delivery", environment = process.env) {
  if (!["test", "delivery"].includes(edition)) throw new Error(`Unsupported release edition: ${edition}`);
  const sidecarBuildRoot = createBuildRoot();
  const remotionRuntimeRoot = path.join(sidecarBuildRoot, "r");
  const releaseEnvironment = {
    ...environment,
    XIAOXI_SIDECAR_BUILD_ROOT: sidecarBuildRoot,
    XIAOXI_REMOTION_RUNTIME_ROOT: remotionRuntimeRoot
  };
  const remotionArtifactType = edition === "test" ? "internal-evaluation" : "delivery";
  runNode("source self-check", "run-self-checks.cjs", [], releaseEnvironment);
  runNode("product-detail local E2E", "product-detail-local-e2e.cjs", ["--cleanup-on-success"], releaseEnvironment);
  runNode("clean runtime gate", "check-clean-runtime.cjs", [], releaseEnvironment);
  runNode(`${edition} renderer build`, "build-renderer.cjs", [edition], releaseEnvironment);
  runNode("product-detail sidecar build", "build-product-detail-sidecar.cjs", [], releaseEnvironment);
  runNode("content-engine sidecar build", "build-content-engine-sidecar.cjs", [], releaseEnvironment);
  runNode("Remotion runtime build", "build-remotion-runtime.cjs", [
    remotionArtifactType,
    "--output",
    path.join(remotionRuntimeRoot, remotionArtifactType)
  ], releaseEnvironment);
  runNode("portable application build", "build-portable-release.cjs", [edition], releaseEnvironment);
  return { remotionRuntimeRoot, sidecarBuildRoot };
}

if (require.main === module) {
  try {
    const result = runRelease(process.argv[2] || "delivery");
    console.log(`\nRelease staging root retained for audit: ${result.sidecarBuildRoot}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = {
  createBuildRoot,
  runRelease
};
