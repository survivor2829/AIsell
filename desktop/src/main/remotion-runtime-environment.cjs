const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const WORKER_CONTRACT_FILES = Object.freeze([
  "contract.cjs",
  "narration-templates.json",
  "narration-plan.cjs",
  "word-breaks.cjs",
  "word-glossary.json",
  "effect-registry.json",
  "layout-grid.json",
  "style-packs.json"
]);

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function compareNames(left, right) {
  return Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8"));
}

function assertFile(file, label) {
  const state = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!state?.isFile() || state.isSymbolicLink()) throw new Error(`${label} is missing or unsafe`);
  return file;
}

function assertDirectory(directory, label) {
  const state = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!state?.isDirectory() || state.isSymbolicLink()) throw new Error(`${label} is missing or unsafe`);
  return directory;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(assertFile(file, label), "utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(`${label} is invalid: ${error.message}`);
  }
}

function treeSha256(root) {
  const base = path.resolve(assertDirectory(root, "Remotion tree"));
  const digest = crypto.createHash("sha256");
  const visit = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort(compareNames);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("Remotion tree contains a symbolic link");
      const absolute = path.join(current, entry.name);
      const relative = path.relative(base, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        digest.update(`directory\0${relative}\0`);
        visit(absolute);
      } else if (entry.isFile()) {
        digest.update(`file\0${relative}\0${fs.statSync(absolute).size}\0${sha256(absolute)}\0`);
      } else {
        throw new Error("Remotion tree contains an unsupported entry");
      }
    }
  };
  visit(base);
  return digest.digest("hex");
}

function packageTreeSha256(packageDir) {
  const root = path.resolve(assertDirectory(packageDir, "Remotion package"));
  const digest = crypto.createHash("sha256");
  const visit = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .filter((entry) => !(current === root && entry.name === "node_modules"))
      .sort(compareNames);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("Remotion package contains a symbolic link");
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        digest.update(`directory\0${relative}\0`);
        visit(absolute);
      } else if (entry.isFile()) {
        digest.update(`file\0${relative}\0${fs.statSync(absolute).size}\0${sha256(absolute)}\0`);
      } else {
        throw new Error("Remotion package contains an unsupported entry");
      }
    }
  };
  visit(root);
  return digest.digest("hex");
}

function installedPackagePaths(contentEngineRoot) {
  const found = [];
  const visitPackage = (packageDir, relativePackage) => {
    assertFile(path.join(packageDir, "package.json"), `Packaged dependency ${relativePackage}`);
    found.push(relativePackage);
    const nested = path.join(packageDir, "node_modules");
    if (fs.existsSync(nested)) visitModules(nested, `${relativePackage}/node_modules`);
  };
  const visitModules = (modulesDir, relativeModules) => {
    assertDirectory(modulesDir, `Remotion dependency directory ${relativeModules}`);
    for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true }).sort(compareNames)) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Packaged Remotion dependency closure contains an unsupported entry");
      const entryDir = path.join(modulesDir, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scoped of fs.readdirSync(entryDir, { withFileTypes: true }).sort(compareNames)) {
          if (scoped.isSymbolicLink() || !scoped.isDirectory()) throw new Error("Packaged Remotion dependency scope contains an unsupported entry");
          visitPackage(path.join(entryDir, scoped.name), `${relativeModules}/${entry.name}/${scoped.name}`);
        }
      } else {
        visitPackage(entryDir, `${relativeModules}/${entry.name}`);
      }
    }
  };
  visitModules(path.join(contentEngineRoot, "node_modules"), "node_modules");
  return found.sort();
}

function safeRelativePath(value, prefix, label) {
  const normalized = String(value || "").replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (!normalized.startsWith(prefix) || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} path is invalid`);
  }
  return parts;
}

function hashWorkerRuntime(bundleRoot, packagingRoot, workerFile) {
  const digest = crypto.createHash("sha256");
  const registry = readJson(path.join(packagingRoot, "effect-registry.json"), "Remotion effect registry");
  digest.update("xiaoxi-remotion-worker-v1\n");
  digest.update(String(registry.version));
  const visit = (relative = "") => {
    const current = path.join(bundleRoot, relative);
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort(compareNames)) {
      if (entry.isSymbolicLink()) throw new Error("Remotion bundle contains a symbolic link");
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) {
        digest.update(`bundle:${child}\0`);
        digest.update(fs.readFileSync(path.join(bundleRoot, child)));
      } else {
        throw new Error("Remotion bundle contains an unsupported entry");
      }
    }
  };
  visit();
  for (const name of WORKER_CONTRACT_FILES) {
    digest.update(`contract:${name}\0`);
    digest.update(fs.readFileSync(assertFile(path.join(packagingRoot, name), `Remotion contract ${name}`)));
  }
  digest.update("worker:remotion-render-worker.mjs\0");
  digest.update(fs.readFileSync(workerFile));
  return digest.digest("hex");
}

function verifyPackagedRuntime(resourcesPath) {
  const resourcesRoot = path.resolve(resourcesPath);
  const releaseRoot = path.dirname(resourcesRoot);
  const contentEngineRoot = assertDirectory(path.join(resourcesRoot, "content-engine"), "Packaged content engine");
  const portableManifest = readJson(path.join(releaseRoot, "版本清单.json"), "Portable version manifest");
  const descriptor = portableManifest.remotionRuntime;
  if (!descriptor || descriptor.artifactType !== portableManifest.artifactType) {
    throw new Error("Packaged Remotion descriptor is invalid");
  }

  const manifestFile = assertFile(path.join(contentEngineRoot, "remotion-runtime-manifest.json"), "Remotion runtime manifest");
  const manifestDigest = String(fs.readFileSync(
    assertFile(path.join(contentEngineRoot, "remotion-runtime-manifest.sha256"), "Remotion runtime digest"),
    "utf8"
  )).trim().split(/\s+/u)[0];
  if (!HASH_PATTERN.test(manifestDigest) || sha256(manifestFile) !== manifestDigest || descriptor.manifestSha256 !== manifestDigest) {
    throw new Error("Packaged Remotion manifest hash mismatch");
  }
  const manifest = readJson(manifestFile, "Remotion runtime manifest");
  if (
    manifest.schemaVersion !== 1
    || manifest.platform !== "win32"
    || manifest.targetArchitecture !== "x64"
    || manifest.artifactType !== descriptor.artifactType
    || manifest.runtimeHash !== descriptor.runtimeHash
    || manifest.browser?.packaged !== true
    || !HASH_PATTERN.test(String(manifest.browser?.treeSha256 || ""))
    || !HASH_PATTERN.test(String(descriptor.browserTreeSha256 || ""))
    || manifest.browser.treeSha256 !== descriptor.browserTreeSha256
  ) {
    throw new Error("Packaged Remotion manifest is incompatible");
  }

  const workerPath = assertFile(path.join(contentEngineRoot, "remotion-render-worker.mjs"), "Packaged Remotion worker");
  if (manifest.worker?.path !== "remotion-render-worker.mjs" || sha256(workerPath) !== manifest.worker.sha256 || sha256(workerPath) !== descriptor.workerSha256) {
    throw new Error("Packaged Remotion worker hash mismatch");
  }
  const bundlePath = assertDirectory(path.join(contentEngineRoot, "remotion-bundle"), "Packaged Remotion bundle");
  if (manifest.bundle?.path !== "remotion-bundle" || treeSha256(bundlePath) !== manifest.bundle.sha256 || manifest.bundle.sha256 !== descriptor.bundleSha256) {
    throw new Error("Packaged Remotion bundle hash mismatch");
  }
  const browserRoot = assertDirectory(path.join(contentEngineRoot, "browser"), "Packaged Remotion browser runtime");
  const browserPath = assertFile(path.join(browserRoot, "chrome.exe"), "Packaged Remotion browser");
  if (sha256(browserPath) !== manifest.browser.sha256 || sha256(browserPath) !== descriptor.browserSha256) {
    throw new Error("Packaged Remotion browser hash mismatch");
  }
  if (treeSha256(browserRoot) !== manifest.browser.treeSha256) {
    throw new Error("Packaged Remotion browser runtime tree hash mismatch");
  }

  const closure = manifest.runtimeClosure;
  if (!Array.isArray(closure) || !closure.length) throw new Error("Packaged Remotion dependency closure is empty");
  const seen = new Set();
  for (const item of closure) {
    const parts = safeRelativePath(item?.lockPath, "node_modules/", "Remotion dependency");
    if (seen.has(item.lockPath) || !HASH_PATTERN.test(String(item.treeSha256 || ""))) {
      throw new Error("Packaged Remotion dependency descriptor is invalid");
    }
    seen.add(item.lockPath);
    const packageDir = assertDirectory(path.join(contentEngineRoot, ...parts), `Packaged dependency ${item.name || "unknown"}`);
    if (packageTreeSha256(packageDir) !== item.treeSha256) {
      throw new Error(`Packaged Remotion dependency hash mismatch: ${item.name || "unknown"}`);
    }
  }
  if (JSON.stringify([...seen].sort()) !== JSON.stringify(installedPackagePaths(contentEngineRoot))) {
    throw new Error("Packaged Remotion dependency closure has missing or unexpected packages");
  }

  const packagingRoot = assertDirectory(path.join(releaseRoot, "remotion-packaging"), "Packaged Remotion design assets");
  if (hashWorkerRuntime(bundlePath, packagingRoot, workerPath) !== manifest.runtimeHash) {
    throw new Error("Packaged Remotion runtime hash mismatch");
  }
  return { browserPath, bundlePath, workerPath };
}

const VERIFICATION_CACHE_SCHEMA = "xiaoxi-remotion-verification-v1";
const verifications = new Map();

// The verified surface as stat-only entries (path, size, mtime) plus the manifest digest.
async function fingerprintPackagedRuntime(resourcesPath) {
  const resourcesRoot = path.resolve(resourcesPath);
  const releaseRoot = path.dirname(resourcesRoot);
  const contentEngineRoot = path.join(resourcesRoot, "content-engine");
  const digest = crypto.createHash("sha256");
  digest.update(`${VERIFICATION_CACHE_SCHEMA}\0${resourcesRoot}\0`);
  const visit = async (absolute, relative) => {
    const state = await fs.promises.lstat(absolute);
    if (state.isSymbolicLink()) throw new Error("Remotion runtime contains a symbolic link");
    if (state.isFile()) {
      digest.update(`file\0${relative}\0${state.size}\0${state.mtimeMs}\0`);
      return;
    }
    if (!state.isDirectory()) throw new Error("Remotion runtime contains an unsupported entry");
    digest.update(`directory\0${relative}\0`);
    const entries = (await fs.promises.readdir(absolute, { withFileTypes: true })).sort(compareNames);
    for (const entry of entries) await visit(path.join(absolute, entry.name), `${relative}/${entry.name}`);
  };
  for (const name of ["remotion-runtime-manifest.json", "remotion-render-worker.mjs", "remotion-bundle", "browser", "node_modules"]) {
    await visit(path.join(contentEngineRoot, name), name);
  }
  await visit(path.join(releaseRoot, "版本清单.json"), "版本清单.json");
  await visit(path.join(releaseRoot, "remotion-packaging"), "remotion-packaging");
  digest.update(await fs.promises.readFile(path.join(contentEngineRoot, "remotion-runtime-manifest.sha256")));
  return digest.digest("hex");
}

function runtimePaths(resourcesPath) {
  const contentEngineRoot = path.join(path.resolve(resourcesPath), "content-engine");
  return {
    browserPath: path.join(contentEngineRoot, "browser", "chrome.exe"),
    bundlePath: path.join(contentEngineRoot, "remotion-bundle"),
    workerPath: path.join(contentEngineRoot, "remotion-render-worker.mjs")
  };
}

function verifyInWorker(resourcesPath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { remotionVerification: true, resourcesPath } });
    let result;
    worker.once("message", (value) => { result = value; });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (result?.ok) resolve(result.runtime);
      else reject(new Error(result?.error || `Remotion verification worker exited with code ${code}`));
    });
  });
}

async function readVerificationCache(cacheFile) {
  try { return JSON.parse(await fs.promises.readFile(cacheFile, "utf8")); } catch { return null; }
}

// Hashing ~500 MB of runtime on Electron's main thread froze low-end PCs for minutes.
// Hash once per unchanged runtime in a worker; later starts only compare sizes and mtimes.
async function verifyPackagedRuntimeInBackground(resourcesPath, { cacheFile = "", verify = verifyInWorker } = {}) {
  const fingerprint = await fingerprintPackagedRuntime(resourcesPath);
  if (!verifications.has(fingerprint)) {
    const pending = (async () => {
      const cached = cacheFile ? await readVerificationCache(cacheFile) : null;
      if (cached?.schema === VERIFICATION_CACHE_SCHEMA && cached.fingerprint === fingerprint) return runtimePaths(resourcesPath);
      const runtime = await verify(resourcesPath);
      if (cacheFile) {
        try {
          await fs.promises.mkdir(path.dirname(cacheFile), { recursive: true });
          await fs.promises.writeFile(cacheFile, JSON.stringify({ schema: VERIFICATION_CACHE_SCHEMA, fingerprint, verifiedAt: new Date().toISOString() }));
        } catch (error) { console.warn(`Remotion verification cache not written: ${error.message}`); }
      }
      return runtime;
    })();
    verifications.set(fingerprint, pending);
    pending.catch(() => verifications.delete(fingerprint));
  }
  return verifications.get(fingerprint);
}

function firstExistingFile(candidates) {
  return candidates.find((candidate) => {
    try {
      return candidate && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || "";
}

function resolveRemotionRuntimeEnvironment({
  environment = process.env,
  executablePath = process.execPath,
  isPackaged,
  moduleDir,
  resourcesPath,
  verifiedRuntime = null
}) {
  let runtime;
  if (isPackaged) {
    runtime = verifiedRuntime || verifyPackagedRuntime(resourcesPath);
  } else {
    const configuredBundle = String(environment.XIAOXI_REMOTION_BUNDLE_PATH || "").trim();
    const configuredBrowser = String(environment.XIAOXI_REMOTION_BROWSER_PATH || "").trim();
    runtime = {
      workerPath: path.join(moduleDir, "remotion-render-worker.mjs"),
      bundlePath: configuredBundle || path.join(moduleDir, "../../.build", "remotion-runtime", "development", "remotion-bundle"),
      browserPath: firstExistingFile([
        configuredBrowser,
        environment.PROGRAMFILES && path.join(environment.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
        environment["PROGRAMFILES(X86)"] && path.join(environment["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
        environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
        environment.PROGRAMFILES && path.join(environment.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
        environment["PROGRAMFILES(X86)"] && path.join(environment["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe")
      ])
    };
  }
  return {
    XIAOXI_REMOTION_NODE_PATH: executablePath,
    XIAOXI_REMOTION_WORKER_PATH: runtime.workerPath,
    XIAOXI_REMOTION_BUNDLE_PATH: runtime.bundlePath,
    XIAOXI_REMOTION_BROWSER_PATH: runtime.browserPath,
    XIAOXI_REMOTION_ELECTRON_RUN_AS_NODE: "1"
  };
}

if (!isMainThread && workerData?.remotionVerification) {
  try { parentPort.postMessage({ ok: true, runtime: verifyPackagedRuntime(workerData.resourcesPath) }); }
  catch (error) { parentPort.postMessage({ ok: false, error: error.message }); }
}

module.exports = {
  fingerprintPackagedRuntime,
  hashWorkerRuntime,
  packageTreeSha256,
  resolveRemotionRuntimeEnvironment,
  sha256,
  treeSha256,
  verifyPackagedRuntime,
  verifyPackagedRuntimeInBackground
};
