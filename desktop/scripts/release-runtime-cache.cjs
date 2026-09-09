const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { sha256 } = require("./release-tree-hash.cjs");
const { canonicalJson } = require("./release-trust-record.cjs");

const digest = (value) => crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

function hashInputTree(root) {
  const hash = crypto.createHash("sha256");
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (["__pycache__", ".git"].includes(entry.name) || /\.py[co]$/u.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) hash.update(`${path.relative(root, file)}\0${sha256(file)}\0`);
      else throw new Error(`Unsupported cache input entry: ${file}`);
    }
  }
  visit(root);
  return hash.digest("hex");
}

function pythonInputs(python, environment) {
  const result = spawnSync(python, ["-c", "import sys,sysconfig,json,glob,os; print(json.dumps({'version':sys.version,'paths':sorted(set([sys.executable,sysconfig.get_path('stdlib'),sysconfig.get_path('purelib'),sysconfig.get_path('platlib'),sysconfig.get_path('scripts')]+glob.glob(os.path.join(sys.base_prefix,'*.dll'))+[p for p in [os.path.join(sys.base_prefix,'DLLs')] if os.path.isdir(p)]))}))"], {
    encoding: "utf8", windowsHide: true, env: environment
  });
  if (result.status !== 0) throw new Error("Cannot fingerprint Python build environment");
  const state = JSON.parse(result.stdout);
  return { version: state.version, files: state.paths.map((file) => ({ file, sha256: fs.statSync(file).isDirectory() ? hashInputTree(file) : sha256(file) })) };
}

function runtimeFingerprint(desktopDir, kind, artifactType, inputs, environment = process.env) {
  const product = require("./build-product-detail-sidecar.cjs");
  const content = require("./build-content-engine-sidecar.cjs");
  const remotion = require("./build-remotion-runtime.cjs");
  const scripts = ["scripts/release-runtime-cache.cjs", "scripts/release-tree-hash.cjs", "scripts/release-trust-record.cjs"];
  const state = { schemaVersion: 1, kind, platform: process.platform, arch: process.arch, node: process.version, nodeSha256: sha256(process.execPath) };
  if (kind === "remotion") {
    scripts.push("scripts/build-remotion-runtime.cjs", "src/main/atomic-file.cjs", "src/main/remotion-render-worker.mjs");
    const packages = remotion.readPackageState(desktopDir);
    state.packages = remotion.runtimePackageHashes(packages);
    state.installed = ["runtime", "builder"].map((role) => remotion.resolveLockClosure(packages.packageLock, role).map((item) => ({ ...item, tree: remotion.packageTreeSha256(path.join(desktopDir, item.lockPath)) })));
    state.packaging = hashInputTree(path.join(desktopDir, "remotion-packaging"));
    state.browser = inputs.remotion.browser;
    state.license = inputs.remotion.licenseRecord;
    state.artifactType = artifactType;
  } else {
    const builder = kind === "product-detail" ? product : content;
    const paths = builder.resolveBuildPaths(desktopDir);
    const python = builder.findBuildPython(paths, environment);
    state.python = pythonInputs(python, environment);
    state.pythonEnvironment = Object.fromEntries(["PYTHONPATH", "PYTHONHOME", "PYTHONHASHSEED", "SOURCE_DATE_EPOCH"].map((key) => [key, environment[key] || null]));
    scripts.push(`scripts/build-${kind}-sidecar.cjs`);
    if (kind === "product-detail") {
      scripts.push("src/main/product-detail-source-scope.cjs");
      state.sourceTreeSha256 = product.productDetailSourceTreeSha256(paths);
      state.snapshot = sha256(paths.snapshotFile);
      state.browser = inputs.remotion.browser;
    } else {
      scripts.push("src/main/content-engine-media-tools.cjs");
      state.sourceTreeSha256 = content.sourceTreeSha256(paths);
      // Preflight verifies every declared media binary and notice against this record.
      state.mediaTools = inputs.mediaTools.licenseRecord;
      state.artifactType = artifactType;
    }
  }
  state.scripts = scripts.map((file) => ({ file, sha256: sha256(path.join(desktopDir, file)) }));
  return digest(state);
}

function validateReuseReceipt(receipt, { buildCommit, sourceCommit, sourceTreeSha256, runtimeTreeSha256, manifestSha256 = null }) {
  if (receipt?.schemaVersion !== 1 || receipt.verified !== true || !HASH.test(receipt.inputFingerprint || "")
    || !HASH.test(receipt.manifestSha256 || "") || !COMMIT.test(receipt.buildCommit || "")
    || receipt.buildCommit !== buildCommit || receipt.sourceCommit !== sourceCommit
    || receipt.sourceTreeSha256 !== sourceTreeSha256 || receipt.runtimeTreeSha256 !== runtimeTreeSha256
    || (manifestSha256 && receipt.manifestSha256 !== manifestSha256)
    || !Number.isFinite(Date.parse(receipt.verifiedAt || ""))) {
    throw new Error("Runtime cache reuse receipt does not match verified source/runtime provenance");
  }
  return receipt;
}

function readReuseReceipt(manifestFile, manifest, source) {
  const file = `${manifestFile}.reuse.json`;
  if (!fs.existsSync(file)) return null;
  const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  return validateReuseReceipt(receipt, {
    buildCommit: receipt.buildCommit, sourceCommit: source.commit, sourceTreeSha256: source.treeSha256,
    runtimeTreeSha256: manifest.runtime.treeSha256, manifestSha256: sha256(manifestFile)
  });
}

// Each cache generation is immutable. Invalid generations are retained for audit,
// and a fresh generation is built instead of overwriting or deleting artifacts.
function cachedRuntime({ cacheRoot, kind, fingerprint, buildCommit, destination, resolve, build, artifacts, sourceOf = null, log = console.log }) {
  const bucket = path.join(cacheRoot, kind, fingerprint);
  let cached = null;
  if (fs.existsSync(bucket)) {
    for (const entry of fs.readdirSync(bucket, { withFileTypes: true }).filter((item) => item.isDirectory())) {
      const root = path.join(bucket, entry.name);
      try {
        const record = JSON.parse(fs.readFileSync(path.join(root, "cache.json"), "utf8"));
        if (record.fingerprint !== fingerprint || record.kind !== kind) throw new Error("Cache identity mismatch");
        const resolved = resolve(root);
        if (sha256(resolved.manifestFile) !== record.manifestSha256) throw new Error("Cache manifest hash mismatch");
        cached = { root, resolved };
        break;
      } catch (error) { log(`${kind} cache rejected: ${error.message}`); }
    }
  }
  if (cached) {
    for (const relative of artifacts) {
      const target = path.join(destination, relative);
      if (fs.existsSync(target)) throw new Error(`Runtime staging must be fresh: ${target}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(path.join(cached.root, relative), target, { recursive: true, errorOnExist: true, force: false });
    }
    const verified = resolve(destination);
    if (sourceOf) {
      const source = sourceOf(verified);
      if (source.dirty) throw new Error("Cannot reuse runtime built from dirty source");
      const receipt = {
        schemaVersion: 1, verified: true, inputFingerprint: fingerprint, buildCommit,
        sourceCommit: source.commit, sourceTreeSha256: source.treeSha256,
        runtimeTreeSha256: verified.manifest.runtime.treeSha256, manifestSha256: sha256(verified.manifestFile), verifiedAt: new Date().toISOString()
      };
      fs.writeFileSync(`${verified.manifestFile}.reuse.json`, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    }
    log(`${kind} runtime cache hit (${fingerprint.slice(0, 12)})`);
    return { hit: true };
  }
  log(`${kind} runtime cache miss (${fingerprint.slice(0, 12)})`);
  build();
  const verified = resolve(destination);
  if (sourceOf && sourceOf(verified).dirty) throw new Error("Cannot cache runtime built from dirty source");
  const root = path.join(bucket, crypto.randomBytes(8).toString("hex"));
  fs.mkdirSync(root, { recursive: true });
  try {
  for (const relative of artifacts) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(destination, relative), target, { recursive: true, errorOnExist: true, force: false });
  }
  const saved = resolve(root);
  fs.writeFileSync(path.join(root, "cache.json"), JSON.stringify({ kind, fingerprint, manifestSha256: sha256(saved.manifestFile) }), { flag: "wx" });
  require("./artifact-retention.cjs").retainArtifacts(cacheRoot, `runtime-${kind}`, [root], 2);
  } catch (error) {
    try { require("./artifact-retention.cjs").removeOwned(cacheRoot, root); }
    catch (cleanupError) { log(`Incomplete cache cleanup deferred: ${cleanupError.message}`); }
    throw error;
  }
  return { hit: false };
}

module.exports = { cachedRuntime, digest, readReuseReceipt, runtimeFingerprint, validateReuseReceipt };
