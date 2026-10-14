const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const {
  productDetailChangedSourceFiles
} = require("./product-detail-source-scope.cjs");

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const RUNTIME_SPECS = Object.freeze({
  "product-detail": Object.freeze({
    runtimeParts: [".build", "product-detail-runtime", "product-detail-server.exe"],
    manifestParts: [".build", "product-detail-runtime.manifest.json"],
    sourceParts: ["sidecars", "product-detail", "app"],
    provenanceKey: "desktopSource",
    relevantChanges: productDetailChangedSourceFiles
  }),
  "content-engine": Object.freeze({
    runtimeParts: [".build", "content-engine-runtime", "content-engine-worker.exe"],
    manifestParts: [".build", "content-engine-runtime.manifest.json"],
    sourceParts: ["sidecars", "content-engine"],
    provenanceKey: "source"
  })
});

function gitText(projectDir, args, spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl("git", args, {
    cwd: projectDir,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw result.error || new Error(String(result.stderr || "git command failed"));
  }
  return String(result.stdout || "").trim();
}

function isFile(fsImpl, candidate) {
  return fsImpl.existsSync(candidate) && fsImpl.statSync(candidate).isFile();
}

function hasRelevantChanges(spec, output, relativeScope) {
  const changes = String(output || "").trim();
  if (!changes) return false;
  if (typeof spec.relevantChanges !== "function") return true;
  return spec.relevantChanges(changes, relativeScope).length > 0;
}

function resolveDefaultDevelopmentSidecarRuntime(kind, options = {}) {
  const spec = RUNTIME_SPECS[kind];
  if (!spec) return "";
  const fsImpl = options.fsImpl || fs;
  const desktopDir = path.resolve(options.desktopDir || path.join(__dirname, "../.."));
  const projectDir = path.resolve(options.projectDir || path.join(desktopDir, ".."));
  const readGit = options.readGit || gitText;
  const runtimePath = path.join(desktopDir, ...spec.runtimeParts);
  const manifestPath = path.join(desktopDir, ...spec.manifestParts);
  const sourceDir = path.join(desktopDir, ...spec.sourceParts);

  try {
    if (!isFile(fsImpl, runtimePath) || !isFile(fsImpl, manifestPath)) return "";
    const manifest = JSON.parse(fsImpl.readFileSync(manifestPath, "utf8"));
    if (!manifest || Array.isArray(manifest) || manifest.schemaVersion !== 1) return "";
    const provenance = manifest[spec.provenanceKey];
    const manifestCommit = String(provenance?.commit || "").trim().toLowerCase();
    if (!COMMIT_PATTERN.test(manifestCommit) || provenance?.dirty !== false) return "";

    const relativeScope = path.relative(projectDir, sourceDir).replaceAll("\\", "/");
    if (!relativeScope || relativeScope === ".." || relativeScope.startsWith("../")) {
      return "";
    }

    const head = String(readGit(projectDir, ["rev-parse", "HEAD"]) || "")
      .trim()
      .toLowerCase();
    if (!COMMIT_PATTERN.test(head)) return "";
    if (manifestCommit !== head) {
      readGit(projectDir, ["merge-base", "--is-ancestor", manifestCommit, head]);
      const committedChanges = String(readGit(projectDir, [
        "diff",
        "--name-only",
        `${manifestCommit}..${head}`,
        "--",
        relativeScope
      ]) || "").trim();
      if (hasRelevantChanges(spec, committedChanges, relativeScope)) return "";
    }
    const dirty = String(readGit(projectDir, [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      relativeScope
    ]) || "").trim();
    return hasRelevantChanges(spec, dirty, relativeScope) ? "" : runtimePath;
  } catch {
    return "";
  }
}

// Source launches must use the current worker, including when Electron is
// started directly rather than through scripts/dev-electron.cjs.
function resolveDevelopmentContentEngineLaunch(options = {}) {
  return resolveDevelopmentSourceLaunch('content-engine', options);
}

function resolveDevelopmentProductDetailLaunch(options = {}) {
  return resolveDevelopmentSourceLaunch('product-detail', options);
}

function resolveDevelopmentSourceLaunch(kind, options) {
  const environment = options.environment || process.env;
  const desktopDir = path.resolve(options.desktopDir || path.join(__dirname, "../.."));
  const fsImpl = options.fsImpl || fs;
  const run = options.spawnSyncImpl || spawnSync;
  const prefix = kind === 'content-engine' ? 'XIAOXI_CONTENT_ENGINE' : 'XIAOXI_PRODUCT_DETAIL';
  const configured = String(environment[`${prefix}_SIDECAR`] || "").trim();
  const entry = String(environment[`${prefix}_SIDECAR_ENTRY`] || "").trim();
  if (configured) return { runtimePath: configured, runtimeArgs: entry ? [entry] : [] };
  const worker = path.join(desktopDir, 'sidecars', kind, ...(kind === 'content-engine' ? ['worker.py'] : ['app', 'desktop_entry.py']));
  if (isFile(fsImpl, worker)) {
    const candidates = [
      environment[`${prefix}_DEV_PYTHON`],
      path.join(desktopDir, ".build", "product-detail-venv", "Scripts", "python.exe"),
      path.join(options.userHome || os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe")
    ];
    for (const candidate of candidates.map((value) => String(value || "").trim()).filter(Boolean)) {
      if (!isFile(fsImpl, candidate)) continue;
      const probe = "import sys; assert sys.version_info >= (3, 10)" + (kind === 'product-detail'
        ? "; import flask, werkzeug, dotenv, PIL, playwright, flask_sqlalchemy, flask_login, flask_migrate, flask_wtf, flask_sock, flask_limiter, requests, cryptography"
        : "");
      const check = run(candidate, ["-c", probe], {
        encoding: "utf8", windowsHide: true, timeout: 5000
      });
      if (!check.error && check.status === 0) return { runtimePath: candidate, runtimeArgs: [worker] };
    }
  }
  return { runtimePath: resolveDefaultDevelopmentSidecarRuntime(kind, options), runtimeArgs: [] };
}

module.exports = {
  RUNTIME_SPECS,
  gitText,
  resolveDefaultDevelopmentSidecarRuntime,
  resolveDevelopmentContentEngineLaunch,
  resolveDevelopmentProductDetailLaunch
};
