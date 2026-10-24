const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { sha256 } = require("./release-tree-hash.cjs");
const { canonicalJson } = require("./release-trust-record.cjs");

const digest = (value) => crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const fingerprintStates = new Map();

// Bump a kind's recipe when artifact-producing behavior changes outside the
// listed recipe inputs. Cache/receipt implementation changes are not inputs.
function runtimeRecipe(kind) {
  const shared = ["scripts/python-library-archive.cjs", "build/pyinstaller-hooks/hook-ssl.py"];
  const recipes = {
    "product-detail": { version: 1, scripts: ["scripts/build-product-detail-sidecar.cjs", ...shared, "src/main/product-detail-source-scope.cjs"] },
    "content-engine": { version: 1, scripts: ["scripts/build-content-engine-sidecar.cjs", ...shared, "src/main/content-engine-media-tools.cjs"] },
    remotion: { version: 1, scripts: ["scripts/build-remotion-runtime.cjs", "src/main/remotion-render-worker.mjs"] }
  };
  if (!recipes[kind]) throw Error("Unknown runtime recipe");
  return recipes[kind];
}

function createFingerprintContext({ execute = spawnSync } = {}) {
  return { python: new Map(), execute, node: null };
}

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

function pythonInputs(python, environment, context = createFingerprintContext()) {
  const pythonEnvironment = Object.fromEntries(["PATH", "PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "PYTHONNOUSERSITE", "VIRTUAL_ENV"].map(key => [key, environment[key] || null]));
  const key = digest({ python: path.resolve(python), environment: pythonEnvironment });
  if (context.python.has(key)) return context.python.get(key);
  const options = { encoding: "utf8", windowsHide: true, env: environment, maxBuffer: 16 * 1024 * 1024 };
  const result = context.execute(python, ["-c", "import sys,json,glob,os; print(json.dumps({'version':sys.version,'paths':sorted(set([sys.executable]+glob.glob(os.path.join(sys.base_prefix,'python3*.dll'))))}))"], options);
  if (result.status !== 0) throw new Error("Cannot fingerprint Python build environment");
  const state = JSON.parse(result.stdout);
  const freeze = context.execute(python, ["-m", "pip", "freeze", "--all", "--disable-pip-version-check"], options);
  if (freeze.status !== 0) throw new Error("Cannot fingerprint Python package versions");
  const packages = [...new Set(freeze.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#")).map(line => {
    const pinned = /^([A-Za-z0-9_.-]+)==([^\s]+)$/.exec(line);
    // Direct URLs/editable installs may contain credentials or local paths.
    // Keep them as opaque inputs; diagnostics never print their contents.
    return pinned ? `${pinned[1].toLowerCase().replace(/[-_.]+/g, "-")}==${pinned[2]}` : `reference:${digest(line)}`;
  }))].sort();
  const value = { version: state.version, files: state.paths.map(file => ({ file, sha256: sha256(file) })), packages };
  context.python.set(key, value);
  return value;
}

function runtimeFingerprint(desktopDir, kind, artifactType, inputs, environment = process.env, context = createFingerprintContext()) {
  const product = require("./build-product-detail-sidecar.cjs");
  const content = require("./build-content-engine-sidecar.cjs");
  const remotion = require("./build-remotion-runtime.cjs");
  const recipe = runtimeRecipe(kind);
  const scripts = recipe.scripts;
  context.node ||= sha256(process.execPath);
  const state = { schemaVersion: 2, recipeVersion: recipe.version, kind, platform: process.platform, arch: process.arch, node: process.version, nodeSha256: context.node };
  if (kind === "remotion") {
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
    state.python = pythonInputs(python, environment, context);
    const requirementRoots = kind === "product-detail" ? [paths.sourceRoot, paths.sourceDir] : [paths.sourceDir];
    state.requirements = requirementRoots.flatMap(root => fs.readdirSync(root).filter(name => /^requirements[^/\\]*\.(?:txt|lock)$/.test(name))
      .map(name => ({ file: path.relative(desktopDir, path.join(root, name)).replaceAll("\\", "/"), sha256: sha256(path.join(root, name)) })));
    state.pythonEnvironment = Object.fromEntries(["PYTHONPATH", "PYTHONHOME", "PYTHONHASHSEED", "SOURCE_DATE_EPOCH"].map((key) => [key, environment[key] || null]));
    state.pythonBaseArchive = environment.XIAOXI_PYTHON_BASE_SHA256 || null;
    if (kind === "product-detail") {
      state.sourceTreeSha256 = product.productDetailSourceTreeSha256(paths);
      state.snapshot = sha256(paths.snapshotFile);
      state.browser = inputs.remotion.browser;
    } else {
      state.sourceTreeSha256 = content.sourceTreeSha256(paths);
      // Preflight verifies every declared media binary and notice against this record.
      state.mediaTools = inputs.mediaTools.licenseRecord;
      state.artifactType = artifactType;
    }
  }
  state.scripts = scripts.map((file) => ({ file, sha256: sha256(path.join(desktopDir, file)) }));
  const fingerprint = digest(state);
  fingerprintStates.set(fingerprint, state);
  return fingerprint;
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

function validateBaseStabilization(receipt, { runtimePath, sourceRuntimeTreeSha256, packagedRuntimeTreeSha256 }) {
  const prefix = `${String(runtimePath || "").replace(/\\/gu, "/").replace(/\/$/u, "")}/`;
  const files = receipt?.files;
  if (receipt?.schemaVersion !== 1 || !HASH.test(receipt.sourceTreeSha256 || "")
    || !HASH.test(receipt.packagedTreeSha256 || "") || receipt.sourceTreeSha256 !== sourceRuntimeTreeSha256
    || receipt.packagedTreeSha256 !== packagedRuntimeTreeSha256 || !Array.isArray(files) || !files.length
    || new Set(files).size !== files.length || files.some((file) => typeof file !== "string" || !file.startsWith(prefix))
    || !Number.isFinite(Date.parse(receipt.verifiedAt || ""))) {
    throw new Error("Runtime base stabilization receipt does not match the packaged runtime");
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

function copyImmutableRuntime(source, target) {
  const info = fs.lstatSync(source);
  if (info.isSymbolicLink()) throw Error("Runtime cache must not contain symbolic links");
  if (info.isDirectory()) {
    fs.mkdirSync(target);
    for (const name of fs.readdirSync(source)) copyImmutableRuntime(path.join(source, name), path.join(target, name));
  } else if (info.isFile()) {
    try { fs.linkSync(source, target); }
    catch (error) {
      if (!["EXDEV", "EPERM", "EACCES", "EMLINK", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) throw error;
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    }
  } else throw Error("Unsupported runtime cache entry");
}

function inputFieldHashes(fingerprint) {
  const state = fingerprintStates.get(fingerprint);
  return state ? Object.fromEntries(Object.entries(state).map(([field, value]) => [field, digest(value)])) : null;
}

function logCacheDifference(cacheRoot, kind, fingerprint, log) {
  const next = inputFieldHashes(fingerprint), parent = path.join(cacheRoot, kind);
  if (!next || !fs.existsSync(parent)) return;
  const records = [];
  for (const key of fs.readdirSync(parent, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const directory = path.join(parent, key.name);
    for (const generation of fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      try {
        const file = path.join(directory, generation.name, "cache.json");
        records.push({ modified: fs.statSync(file).mtimeMs, record: JSON.parse(fs.readFileSync(file, "utf8")) });
      } catch { /* Incomplete historical entries remain available for audit. */ }
    }
  }
  const previous = records.sort((a, b) => b.modified - a.modified)[0]?.record.inputFields;
  if (!previous) { log(`${kind} cache inputs changed: prior input-field record unavailable`); return; }
  const differences = [...new Set([...Object.keys(previous), ...Object.keys(next)])].filter(field => previous[field] !== next[field]);
  if (differences.length) log(`${kind} cache inputs changed: ${differences.map(field => `${field} ${(previous[field] || "missing").slice(0, 12)}→${(next[field] || "missing").slice(0, 12)}`).join(", ")}`);
}

// Each cache generation is immutable. Invalid generations are retained for audit,
// and a fresh generation is built instead of overwriting or deleting artifacts.
function cachedRuntime({ cacheRoot, fallbackCacheRoots = [], kind, fingerprint, buildCommit, destination, resolve, build, artifacts, sourceOf = null, log = console.log }) {
  const bucket = path.join(cacheRoot, kind, fingerprint);
  let cached = null;
  lookup: for (const lookupRoot of new Set([cacheRoot, ...fallbackCacheRoots])) {
    const lookupBucket = path.join(lookupRoot, kind, fingerprint);
    if (!fs.existsSync(lookupBucket)) continue;
    for (const entry of fs.readdirSync(lookupBucket, { withFileTypes: true }).filter((item) => item.isDirectory())) {
      const root = path.join(lookupBucket, entry.name);
      try {
        const record = JSON.parse(fs.readFileSync(path.join(root, "cache.json"), "utf8"));
        if (record.fingerprint !== fingerprint || record.kind !== kind) throw new Error("Cache identity mismatch");
        const resolved = resolve(root);
        if (sha256(resolved.manifestFile) !== record.manifestSha256) throw new Error("Cache manifest hash mismatch");
        cached = { root, resolved, imported: path.resolve(lookupRoot) !== path.resolve(cacheRoot) };
        break lookup;
      } catch (error) { log(`${kind} cache rejected: ${error.message}`); }
    }
  }
  function saveRuntime(sourceRoot) {
    const root = path.join(bucket, crypto.randomBytes(8).toString("hex"));
    fs.mkdirSync(root, { recursive: true });
    try {
      for (const relative of artifacts) {
        const source = path.join(sourceRoot, relative), target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (fs.lstatSync(source).isDirectory()) copyImmutableRuntime(source, target);
        else fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      }
      const saved = resolve(root);
      if (sourceOf && sourceOf(saved).dirty) throw new Error("Cannot cache runtime built from dirty source");
      fs.writeFileSync(path.join(root, "cache.json"), JSON.stringify({ kind, fingerprint, inputFields: inputFieldHashes(fingerprint), manifestSha256: sha256(saved.manifestFile) }), { flag: "wx" });
      require("./artifact-retention.cjs").retainArtifacts(cacheRoot, `runtime-${kind}`, [root], 2);
      return { root, resolved: saved };
    } catch (error) {
      try { require("./artifact-retention.cjs").removeOwned(cacheRoot, root); }
      catch (cleanupError) {
        require("./artifact-retention.cjs").retainArtifacts(cacheRoot, "incomplete-runtime", [], 1, [root], { deferCleanup: true });
        log(`Incomplete cache cleanup deferred: ${cleanupError.message}`);
      }
      throw error;
    }
  }
  // Legacy caches are read-only inputs. Only the new cache directory gains
  // deletion ownership; a hit never adopts the old path or its history.
  if (cached?.imported) cached = saveRuntime(cached.root);
  if (cached) {
    for (const relative of artifacts) {
      const target = path.join(destination, relative);
      if (fs.existsSync(target)) throw new Error(`Runtime staging must be fresh: ${target}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const source = path.join(cached.root, relative);
      // Consumers copy runtime trees into the candidate before stabilizing any
      // bytes. Staging is immutable; standalone manifests remain independent.
      if (fs.lstatSync(source).isDirectory()) copyImmutableRuntime(source, target);
      else fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
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
    require("./artifact-retention.cjs").retainArtifacts(cacheRoot, `runtime-${kind}`, [cached.root], 2, []);
    log(`${kind} runtime cache hit (${fingerprint.slice(0, 12)})`);
    return { hit: true };
  }
  log(`${kind} runtime cache miss (${fingerprint.slice(0, 12)})`);
  logCacheDifference(cacheRoot, kind, fingerprint, log);
  build();
  const verified = resolve(destination);
  if (sourceOf && sourceOf(verified).dirty) throw new Error("Cannot cache runtime built from dirty source");
  saveRuntime(destination);
  return { hit: false };
}

module.exports = { cachedRuntime, digest, readReuseReceipt, runtimeFingerprint, createFingerprintContext, pythonInputs, runtimeRecipe, validateBaseStabilization, validateReuseReceipt };
