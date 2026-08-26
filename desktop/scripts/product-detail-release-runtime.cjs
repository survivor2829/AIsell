const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { sha256, treeSha256 } = require("./release-tree-hash.cjs");
const {
  productDetailSourceTreeSha256,
  resolveBuildPaths
} = require("./build-product-detail-sidecar.cjs");

const PRODUCT_DETAIL_RELEASE_PATH = "resources/product-detail";
const PRODUCT_DETAIL_EXECUTABLE = "product-detail-server.exe";
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
  if (manifest?.schemaVersion !== 1) {
    throw new Error(`Product-detail runtime manifest has an unsupported schema: ${manifestFile}`);
  }
  if (!String(manifest.version || "").trim()) {
    throw new Error(`Product-detail runtime manifest is missing version: ${manifestFile}`);
  }
  if (manifest.runtime?.kind !== "pyinstaller-onedir") {
    throw new Error(`Product-detail runtime manifest has the wrong runtime kind: ${manifestFile}`);
  }
  if (manifest.runtime?.entry !== PRODUCT_DETAIL_EXECUTABLE) {
    throw new Error(`Product-detail runtime manifest has an unexpected entry: ${manifestFile}`);
  }
  if (!SHA256_PATTERN.test(String(manifest.runtime?.exeSha256 || ""))) {
    throw new Error(`Product-detail runtime manifest has an invalid EXE hash: ${manifestFile}`);
  }
  if (!SHA256_PATTERN.test(String(manifest.runtime?.treeSha256 || ""))) {
    throw new Error(`Product-detail runtime manifest has an invalid tree hash: ${manifestFile}`);
  }
  if (!COMMIT_PATTERN.test(String(manifest.source?.commit || ""))) {
    throw new Error(`Product-detail runtime manifest has an invalid source commit: ${manifestFile}`);
  }
  if (!COMMIT_PATTERN.test(String(manifest.desktopSource?.commit || ""))) {
    throw new Error(`Product-detail runtime manifest has an invalid desktop source commit: ${manifestFile}`);
  }
  if (typeof manifest.desktopSource?.dirty !== "boolean") {
    throw new Error(`Product-detail runtime manifest is missing the desktop source dirty state: ${manifestFile}`);
  }
  if (!SHA256_PATTERN.test(String(manifest.desktopSource?.treeSha256 || ""))) {
    throw new Error(`Product-detail runtime manifest has an invalid desktop source tree hash: ${manifestFile}`);
  }
  if (!Number.isFinite(Date.parse(String(manifest.builtAt || "")))) {
    throw new Error(`Product-detail runtime manifest has an invalid build time: ${manifestFile}`);
  }
  return manifest;
}

function resolveProductDetailBuild(desktopDir, { buildRoot = null } = {}) {
  const paths = resolveBuildPaths(desktopDir, { buildRoot });
  const runtimeDir = paths.outputDir;
  const manifestFile = paths.manifestFile;
  assertDirectory(runtimeDir, "Product-detail PyInstaller runtime");
  assertFile(manifestFile, "Product-detail runtime manifest");
  const manifest = validateBuildManifest(
    readJson(manifestFile, "Product-detail runtime manifest"),
    manifestFile
  );
  const currentDesktopSourceTreeSha256 = productDetailSourceTreeSha256(
    resolveBuildPaths(desktopDir)
  );
  if (currentDesktopSourceTreeSha256 !== manifest.desktopSource.treeSha256) {
    throw new Error("Product-detail runtime desktop source tree hash does not match the current source tree");
  }
  const executable = path.join(runtimeDir, PRODUCT_DETAIL_EXECUTABLE);
  assertFile(executable, "Product-detail runtime executable");
  if (sha256(executable) !== manifest.runtime.exeSha256) {
    throw new Error("Product-detail runtime EXE hash does not match its build manifest");
  }
  if (treeSha256(runtimeDir) !== manifest.runtime.treeSha256) {
    throw new Error("Product-detail runtime tree hash does not match its build manifest");
  }
  return {
    runtimeDir,
    manifestFile,
    manifest,
    currentDesktopSourceTreeSha256
  };
}

function copyProductDetailRuntime(build, releaseTarget) {
  const destination = path.join(path.resolve(releaseTarget), ...PRODUCT_DETAIL_RELEASE_PATH.split("/"));
  if (fs.existsSync(destination)) {
    throw new Error(`Refusing to overwrite an existing product-detail release runtime: ${destination}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(build.runtimeDir, destination, {
    recursive: true,
    errorOnExist: true,
    force: false
  });
  const executable = path.join(destination, PRODUCT_DETAIL_EXECUTABLE);
  assertFile(executable, "Packaged product-detail runtime executable");
  if (sha256(executable) !== build.manifest.runtime.exeSha256) {
    throw new Error("Packaged product-detail runtime EXE hash does not match its build manifest");
  }
  if (treeSha256(destination) !== build.manifest.runtime.treeSha256) {
    throw new Error("Packaged product-detail runtime tree hash does not match its build manifest");
  }
  return destination;
}

function createReleaseDescriptor(build, buildCommit) {
  if (!COMMIT_PATTERN.test(String(buildCommit || ""))) {
    throw new Error("Product-detail release descriptor requires the release build commit");
  }
  if (build.manifest.desktopSource.dirty) {
    throw new Error("Refusing to package a product-detail runtime built from dirty desktop source");
  }
  if (build.manifest.desktopSource.commit !== buildCommit) {
    throw new Error("Product-detail runtime desktop source commit does not match the portable release commit");
  }
  return {
    path: PRODUCT_DETAIL_RELEASE_PATH,
    version: build.manifest.version,
    executable: PRODUCT_DETAIL_EXECUTABLE,
    executableSha256: build.manifest.runtime.exeSha256,
    treeSha256: build.manifest.runtime.treeSha256,
    buildCommit,
    sourceCommit: build.manifest.source.commit,
    sourceDirty: Boolean(build.manifest.source.dirty),
    desktopSourceCommit: build.manifest.desktopSource.commit,
    desktopSourceDirty: build.manifest.desktopSource.dirty,
    desktopSourceTreeSha256: build.manifest.desktopSource.treeSha256,
    builtAt: build.manifest.builtAt,
    selfCheck: {
      verified: true,
      args: ["--self-check", "--data-dir", "<fresh-temp>"],
      expectedMode: "desktop"
    }
  };
}

function validateReleaseDescriptor(descriptor) {
  if (descriptor?.path !== PRODUCT_DETAIL_RELEASE_PATH) {
    throw new Error("Portable manifest has an unexpected product-detail runtime path");
  }
  if (descriptor?.executable !== PRODUCT_DETAIL_EXECUTABLE) {
    throw new Error("Portable manifest has an unexpected product-detail executable");
  }
  if (!String(descriptor.version || "").trim()) {
    throw new Error("Portable manifest is missing the product-detail version");
  }
  if (!SHA256_PATTERN.test(String(descriptor.executableSha256 || ""))) {
    throw new Error("Portable manifest has an invalid product-detail EXE hash");
  }
  if (!SHA256_PATTERN.test(String(descriptor.treeSha256 || ""))) {
    throw new Error("Portable manifest has an invalid product-detail tree hash");
  }
  if (!COMMIT_PATTERN.test(String(descriptor.buildCommit || ""))) {
    throw new Error("Portable manifest has an invalid product-detail build commit");
  }
  if (!COMMIT_PATTERN.test(String(descriptor.sourceCommit || ""))) {
    throw new Error("Portable manifest has an invalid product-detail source commit");
  }
  if (!COMMIT_PATTERN.test(String(descriptor.desktopSourceCommit || ""))) {
    throw new Error("Portable manifest has an invalid product-detail desktop source commit");
  }
  if (descriptor.desktopSourceDirty !== false) {
    throw new Error("Portable manifest product-detail desktop source must be clean");
  }
  if (descriptor.desktopSourceCommit !== descriptor.buildCommit) {
    throw new Error("Portable manifest product-detail desktop source commit must match its build commit");
  }
  if (!SHA256_PATTERN.test(String(descriptor.desktopSourceTreeSha256 || ""))) {
    throw new Error("Portable manifest has an invalid product-detail desktop source tree hash");
  }
  if (!Number.isFinite(Date.parse(String(descriptor.builtAt || "")))) {
    throw new Error("Portable manifest has an invalid product-detail build time");
  }
  assert.equal(descriptor.selfCheck?.verified, true, "Portable manifest must require the product-detail self-check");
  assert.deepEqual(
    descriptor.selfCheck?.args,
    ["--self-check", "--data-dir", "<fresh-temp>"],
    "Portable manifest must record the product-detail self-check contract"
  );
  if (descriptor.selfCheck?.expectedMode !== "desktop") {
    throw new Error("Portable manifest has the wrong product-detail self-check mode");
  }
  return descriptor;
}

function resolvePackagedProductDetail(releaseTarget, descriptor) {
  validateReleaseDescriptor(descriptor);
  const runtimeDir = path.join(path.resolve(releaseTarget), ...descriptor.path.split("/"));
  const executable = path.join(runtimeDir, descriptor.executable);
  assertDirectory(runtimeDir, "Packaged product-detail runtime");
  assertFile(executable, "Packaged product-detail executable");
  if (sha256(executable) !== descriptor.executableSha256) {
    throw new Error("Packaged product-detail EXE hash does not match the portable manifest");
  }
  if (treeSha256(runtimeDir) !== descriptor.treeSha256) {
    throw new Error("Packaged product-detail tree hash does not match the portable manifest");
  }
  return { runtimeDir, executable };
}

function parseSelfCheckPayload(result) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || "").trim()
      || String(result.stdout || "").trim()
      || `Product-detail packaged self-check failed with status ${result.status}`
    );
  }
  try {
    return JSON.parse(String(result.stdout || "").trim());
  } catch (error) {
    throw new Error(`Product-detail packaged self-check returned invalid JSON: ${error.message}`);
  }
}

function runPackagedProductDetailSelfCheck({
  releaseTarget,
  resourcesDir,
  descriptor,
  dataDir,
  spawn = spawnSync
}) {
  if (fs.existsSync(dataDir)) {
    throw new Error(`Product-detail self-check data directory must be fresh: ${dataDir}`);
  }
  const packaged = resolvePackagedProductDetail(releaseTarget, descriptor);
  const resourcesHashBefore = treeSha256(resourcesDir);
  fs.mkdirSync(dataDir, { recursive: false });
  const result = spawn(
    packaged.executable,
    ["--self-check", "--data-dir", dataDir],
    {
      cwd: packaged.runtimeDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONUTF8: "1"
      },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120000,
      windowsHide: true
    }
  );
  const payload = parseSelfCheckPayload(result);
  if (payload?.ok !== true || payload?.mode !== descriptor.selfCheck.expectedMode) {
    throw new Error("Product-detail packaged self-check returned an unexpected capability state");
  }
  if (payload.version !== descriptor.version) {
    throw new Error("Product-detail packaged self-check version does not match the portable manifest");
  }
  if (treeSha256(resourcesDir) !== resourcesHashBefore) {
    throw new Error("Product-detail packaged self-check changed portable resources");
  }
  return payload;
}

function normalizeReleaseRelativePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").toLowerCase();
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/.test(normalized)) return "";
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) return "";
  return normalized;
}

function isProductDetailPythonSource(relativePath) {
  const normalized = normalizeReleaseRelativePath(relativePath);
  return normalized.startsWith(`${PRODUCT_DETAIL_RELEASE_PATH}/`)
    && normalized.endsWith(".py");
}

function isProductDetailArchivePythonSource(archivePath, archiveRoot) {
  const normalized = normalizeReleaseRelativePath(archivePath);
  const normalizedRoot = normalizeReleaseRelativePath(archiveRoot);
  if (!normalizedRoot || normalizedRoot.includes("/")) return false;
  return normalized.startsWith(`${normalizedRoot}/${PRODUCT_DETAIL_RELEASE_PATH}/`)
    && normalized.endsWith(".py");
}

module.exports = {
  PRODUCT_DETAIL_EXECUTABLE,
  PRODUCT_DETAIL_RELEASE_PATH,
  copyProductDetailRuntime,
  createReleaseDescriptor,
  isProductDetailArchivePythonSource,
  isProductDetailPythonSource,
  resolvePackagedProductDetail,
  resolveProductDetailBuild,
  runPackagedProductDetailSelfCheck,
  validateBuildManifest,
  validateReleaseDescriptor
};
