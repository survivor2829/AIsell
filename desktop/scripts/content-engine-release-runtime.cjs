const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { sha256, treeSha256 } = require("./release-tree-hash.cjs");
const {
  resolveContentEngineMediaToolsEnvironment
} = require("../src/main/content-engine-media-tools.cjs");
const {
  parseProtocolOutput,
  resolveBuildPaths,
  sourceTreeSha256,
  validateMediaToolsManifest,
  verifyBundledMediaToolFiles,
  verifyBundledMediaTools
} = require("./build-content-engine-sidecar.cjs");

const CONTENT_ENGINE_RELEASE_PATH = "resources/content-engine";
const CONTENT_ENGINE_EXECUTABLE = "content-engine-worker.exe";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function assertFile(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`${label} is missing: ${file}`);
  }
}

function assertDirectory(directory, label) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`${label} is missing: ${directory}`);
  }
}

function validateBuildManifest(manifest, manifestFile) {
  if (manifest?.schemaVersion !== 2) {
    throw new Error(`Content-engine runtime manifest has an unsupported schema: ${manifestFile}`);
  }
  if (!String(manifest.version || "").trim()) {
    throw new Error(`Content-engine runtime manifest is missing version: ${manifestFile}`);
  }
  if (manifest.runtime?.kind !== "pyinstaller-onedir") {
    throw new Error(`Content-engine runtime manifest has the wrong runtime kind: ${manifestFile}`);
  }
  if (manifest.runtime?.entry !== CONTENT_ENGINE_EXECUTABLE) {
    throw new Error(`Content-engine runtime manifest has an unexpected entry: ${manifestFile}`);
  }
  if (!SHA256_PATTERN.test(String(manifest.runtime?.exeSha256 || ""))) {
    throw new Error(`Content-engine runtime manifest has an invalid EXE hash: ${manifestFile}`);
  }
  if (!SHA256_PATTERN.test(String(manifest.runtime?.treeSha256 || ""))) {
    throw new Error(`Content-engine runtime manifest has an invalid tree hash: ${manifestFile}`);
  }
  if (!COMMIT_PATTERN.test(String(manifest.source?.commit || ""))) {
    throw new Error(`Content-engine runtime manifest has an invalid source commit: ${manifestFile}`);
  }
  if (typeof manifest.source?.dirty !== "boolean") {
    throw new Error(`Content-engine runtime manifest is missing the source dirty state: ${manifestFile}`);
  }
  if (!SHA256_PATTERN.test(String(manifest.source?.treeSha256 || ""))) {
    throw new Error(`Content-engine runtime manifest has an invalid source tree hash: ${manifestFile}`);
  }
  if (!Number.isFinite(Date.parse(String(manifest.builtAt || "")))) {
    throw new Error(`Content-engine runtime manifest has an invalid build time: ${manifestFile}`);
  }
  const mediaTools = validateMediaToolsManifest(manifest.mediaTools);
  if (
    manifest.capabilities?.mixRender?.available !== mediaTools.verified
    || manifest.capabilities?.mixRender?.bundled !== mediaTools.bundled
    || manifest.capabilities?.mixRender?.source !== mediaTools.source
  ) {
    throw new Error(`Content-engine runtime manifest media tools capability is inconsistent: ${manifestFile}`);
  }
  if (
    manifest.selfCheck?.protocolVersion !== 1
    || manifest.selfCheck?.ready !== true
    || manifest.selfCheck?.health !== true
    || manifest.selfCheck?.shutdown !== true
  ) {
    throw new Error(`Content-engine runtime manifest is missing the JSONL self-check proof: ${manifestFile}`);
  }
  return manifest;
}

function resolveContentEngineBuild(desktopDir, { buildRoot = null } = {}) {
  const paths = resolveBuildPaths(desktopDir, { buildRoot });
  const runtimeDir = paths.outputDir;
  const manifestFile = paths.manifestFile;
  assertDirectory(runtimeDir, "Content-engine PyInstaller runtime");
  assertFile(manifestFile, "Content-engine runtime manifest");
  const manifest = validateBuildManifest(
    readJson(manifestFile, "Content-engine runtime manifest"),
    manifestFile
  );
  const currentSourceTreeSha256 = sourceTreeSha256(resolveBuildPaths(desktopDir));
  if (currentSourceTreeSha256 !== manifest.source.treeSha256) {
    throw new Error("Content-engine runtime source tree hash does not match the current source tree");
  }
  const executable = path.join(runtimeDir, CONTENT_ENGINE_EXECUTABLE);
  assertFile(executable, "Content-engine runtime executable");
  if (sha256(executable) !== manifest.runtime.exeSha256) {
    throw new Error("Content-engine runtime EXE hash does not match its build manifest");
  }
  if (treeSha256(runtimeDir) !== manifest.runtime.treeSha256) {
    throw new Error("Content-engine runtime tree hash does not match its build manifest");
  }
  verifyBundledMediaToolFiles(runtimeDir, manifest.mediaTools);
  return {
    runtimeDir,
    manifestFile,
    manifest,
    currentSourceTreeSha256
  };
}

function copyContentEngineRuntime(build, releaseTarget) {
  const destination = path.join(path.resolve(releaseTarget), ...CONTENT_ENGINE_RELEASE_PATH.split("/"));
  if (fs.existsSync(destination)) {
    throw new Error(`Refusing to overwrite an existing content-engine release runtime: ${destination}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(build.runtimeDir, destination, {
    recursive: true,
    errorOnExist: true,
    force: false
  });
  const executable = path.join(destination, CONTENT_ENGINE_EXECUTABLE);
  assertFile(executable, "Packaged content-engine runtime executable");
  if (sha256(executable) !== build.manifest.runtime.exeSha256) {
    throw new Error("Packaged content-engine runtime EXE hash does not match its build manifest");
  }
  if (treeSha256(destination) !== build.manifest.runtime.treeSha256) {
    throw new Error("Packaged content-engine runtime tree hash does not match its build manifest");
  }
  return destination;
}

function createReleaseDescriptor(build, buildCommit, artifactType) {
  if (!COMMIT_PATTERN.test(String(buildCommit || ""))) {
    throw new Error("Content-engine release descriptor requires the release build commit");
  }
  if (!new Set(["internal-evaluation", "delivery"]).has(artifactType)) {
    throw new Error("Content-engine release descriptor requires an artifact type");
  }
  if (build.manifest.source.dirty) {
    throw new Error("Refusing to package a content-engine runtime built from dirty source");
  }
  if (build.manifest.source.commit !== buildCommit) {
    throw new Error("Content-engine runtime source commit does not match the portable release commit");
  }
  const mediaTools = validateMediaToolsManifest(build.manifest.mediaTools, { artifactType });
  if (!mediaTools.bundled || !mediaTools.verified) {
    throw new Error("Portable releases require a verified bundled media tools runtime");
  }
  return {
    path: CONTENT_ENGINE_RELEASE_PATH,
    version: build.manifest.version,
    executable: CONTENT_ENGINE_EXECUTABLE,
    executableSha256: build.manifest.runtime.exeSha256,
    treeSha256: build.manifest.runtime.treeSha256,
    buildCommit,
    sourceCommit: build.manifest.source.commit,
    sourceDirty: build.manifest.source.dirty,
    sourceTreeSha256: build.manifest.source.treeSha256,
    builtAt: build.manifest.builtAt,
    artifactType,
    mediaTools,
    selfCheck: {
      verified: true,
      protocolVersion: 1,
      requests: ["health", "shutdown"],
      expectedService: "content-engine",
      expectedHealthStatus: "ok"
    }
  };
}

function validateReleaseDescriptor(descriptor) {
  if (descriptor?.path !== CONTENT_ENGINE_RELEASE_PATH) {
    throw new Error("Portable manifest has an unexpected content-engine runtime path");
  }
  if (descriptor?.executable !== CONTENT_ENGINE_EXECUTABLE) {
    throw new Error("Portable manifest has an unexpected content-engine executable");
  }
  if (!String(descriptor.version || "").trim()) {
    throw new Error("Portable manifest is missing the content-engine version");
  }
  if (!SHA256_PATTERN.test(String(descriptor.executableSha256 || ""))) {
    throw new Error("Portable manifest has an invalid content-engine EXE hash");
  }
  if (!SHA256_PATTERN.test(String(descriptor.treeSha256 || ""))) {
    throw new Error("Portable manifest has an invalid content-engine tree hash");
  }
  if (!COMMIT_PATTERN.test(String(descriptor.buildCommit || ""))) {
    throw new Error("Portable manifest has an invalid content-engine build commit");
  }
  if (!COMMIT_PATTERN.test(String(descriptor.sourceCommit || ""))) {
    throw new Error("Portable manifest has an invalid content-engine source commit");
  }
  if (descriptor.sourceDirty !== false) {
    throw new Error("Portable manifest content-engine source must be clean");
  }
  if (descriptor.sourceCommit !== descriptor.buildCommit) {
    throw new Error("Portable manifest content-engine source commit must match its build commit");
  }
  if (!SHA256_PATTERN.test(String(descriptor.sourceTreeSha256 || ""))) {
    throw new Error("Portable manifest has an invalid content-engine source tree hash");
  }
  if (!Number.isFinite(Date.parse(String(descriptor.builtAt || "")))) {
    throw new Error("Portable manifest has an invalid content-engine build time");
  }
  if (!new Set(["internal-evaluation", "delivery"]).has(descriptor.artifactType)) {
    throw new Error("Portable manifest has an invalid content-engine artifact type");
  }
  const mediaTools = validateMediaToolsManifest(descriptor.mediaTools, {
    artifactType: descriptor.artifactType
  });
  if (!mediaTools.bundled || !mediaTools.verified) {
    throw new Error("Portable manifest requires verified bundled media tools");
  }
  assert.equal(
    descriptor.selfCheck?.verified,
    true,
    "Portable manifest must require the content-engine self-check"
  );
  assert.equal(
    descriptor.selfCheck?.protocolVersion,
    1,
    "Portable manifest must record the content-engine protocol"
  );
  assert.deepEqual(
    descriptor.selfCheck?.requests,
    ["health", "shutdown"],
    "Portable manifest must record the content-engine self-check requests"
  );
  if (
    descriptor.selfCheck?.expectedService !== "content-engine"
    || descriptor.selfCheck?.expectedHealthStatus !== "ok"
  ) {
    throw new Error("Portable manifest has the wrong content-engine self-check contract");
  }
  return { ...descriptor, mediaTools };
}

function resolvePackagedContentEngine(releaseTarget, descriptor) {
  const validated = validateReleaseDescriptor(descriptor);
  const runtimeDir = path.join(path.resolve(releaseTarget), ...descriptor.path.split("/"));
  const executable = path.join(runtimeDir, descriptor.executable);
  assertDirectory(runtimeDir, "Packaged content-engine runtime");
  assertFile(executable, "Packaged content-engine executable");
  if (sha256(executable) !== descriptor.executableSha256) {
    throw new Error("Packaged content-engine EXE hash does not match the portable manifest");
  }
  if (treeSha256(runtimeDir) !== descriptor.treeSha256) {
    throw new Error("Packaged content-engine tree hash does not match the portable manifest");
  }
  verifyBundledMediaToolFiles(runtimeDir, validated.mediaTools);
  return { runtimeDir, executable, mediaTools: validated.mediaTools };
}

function runPackagedContentEngineSelfCheck({
  releaseTarget,
  resourcesDir,
  descriptor,
  dataDir,
  spawn = spawnSync,
  mediaToolsSpawn = spawn
}) {
  if (fs.existsSync(dataDir)) {
    throw new Error(`Content-engine self-check data directory must be fresh: ${dataDir}`);
  }
  const packaged = resolvePackagedContentEngine(releaseTarget, descriptor);
  const mediaToolsSession = verifyBundledMediaTools(
    packaged.runtimeDir,
    {
      available: packaged.mediaTools.bundled,
      runtime: packaged.mediaTools.runtime,
      toolVersion: packaged.mediaTools.licenseRecord.version
    },
    { spawn: mediaToolsSpawn }
  );
  if (mediaToolsSession.status !== "passed") {
    throw new Error("Content-engine packaged media tools self-check was skipped");
  }
  const resourcesHashBefore = treeSha256(resourcesDir);
  const mediaToolsEnvironment = resolveContentEngineMediaToolsEnvironment({
    runtimePath: packaged.executable,
    isPackaged: true,
    dataDir
  });
  const input = [
    JSON.stringify({ id: "build-health", method: "health", params: {} }),
    JSON.stringify({ id: "build-shutdown", method: "shutdown", params: {} }),
    ""
  ].join("\n");
  const result = spawn(
    packaged.executable,
    ["--data-dir", dataDir],
    {
      cwd: packaged.runtimeDir,
      encoding: "utf8",
      env: {
        ...process.env,
        ...mediaToolsEnvironment,
        PYTHONUTF8: "1",
        PYTHONDONTWRITEBYTECODE: "1"
      },
      input,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120000,
      windowsHide: true
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || "").trim()
      || String(result.stdout || "").trim()
      || `Content-engine packaged self-check failed with status ${result.status}`
    );
  }
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    throw new Error("Content-engine packaged self-check did not initialize its fresh data directory");
  }
  const session = parseProtocolOutput(result.stdout, "Content-engine packaged self-check");
  if (
    session.ready.version !== descriptor.version
    || session.ready.service !== descriptor.selfCheck.expectedService
    || session.health.result.status !== descriptor.selfCheck.expectedHealthStatus
  ) {
    throw new Error("Content-engine packaged self-check returned an unexpected capability state");
  }
  if (treeSha256(resourcesDir) !== resourcesHashBefore) {
    throw new Error("Content-engine packaged self-check changed portable resources");
  }
  return session;
}

function normalizeReleaseRelativePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").toLowerCase();
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/.test(normalized)) return "";
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) return "";
  return normalized;
}

function isContentEnginePythonSource(relativePath) {
  const normalized = normalizeReleaseRelativePath(relativePath);
  return normalized.startsWith(`${CONTENT_ENGINE_RELEASE_PATH}/`)
    && normalized.endsWith(".py");
}

function isContentEngineArchivePythonSource(archivePath, archiveRoot) {
  const normalized = normalizeReleaseRelativePath(archivePath);
  const normalizedRoot = normalizeReleaseRelativePath(archiveRoot);
  if (!normalizedRoot || normalizedRoot.includes("/")) return false;
  return normalized.startsWith(`${normalizedRoot}/${CONTENT_ENGINE_RELEASE_PATH}/`)
    && normalized.endsWith(".py");
}

module.exports = {
  CONTENT_ENGINE_EXECUTABLE,
  CONTENT_ENGINE_RELEASE_PATH,
  copyContentEngineRuntime,
  createReleaseDescriptor,
  isContentEngineArchivePythonSource,
  isContentEnginePythonSource,
  resolveContentEngineBuild,
  resolvePackagedContentEngine,
  runPackagedContentEngineSelfCheck,
  validateBuildManifest,
  validateReleaseDescriptor
};
