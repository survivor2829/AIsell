const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  hashWorkerRuntime,
  packageTreeSha256,
  resolveRemotionRuntimeEnvironment,
  sha256,
  treeSha256
} = require("./remotion-runtime-environment.cjs");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aihuoke-remotion-env-"));
try {
  const resourcesPath = path.join(root, "portable", "resources");
  const contentEngine = path.join(resourcesPath, "content-engine");
  const bundlePath = path.join(contentEngine, "remotion-bundle");
  const workerPath = path.join(contentEngine, "remotion-render-worker.mjs");
  const browserPath = path.join(contentEngine, "browser", "chrome.exe");
  const browserDependency = path.join(contentEngine, "browser", "chrome.dll");
  const packagingPath = path.join(root, "portable", "remotion-packaging");
  const packagePath = path.join(contentEngine, "node_modules", "remotion");

  write(path.join(bundlePath, "index.html"), "verified bundle");
  write(workerPath, "verified worker");
  write(browserPath, "verified browser");
  write(browserDependency, "verified browser dependency");
  write(path.join(packagePath, "package.json"), JSON.stringify({ name: "remotion", version: "4.0.512" }));
  write(path.join(packagingPath, "contract.cjs"), "contract");
  write(path.join(packagingPath, "effect-registry.json"), JSON.stringify({ version: 1 }));
  write(path.join(packagingPath, "layout-grid.json"), "{}");
  write(path.join(packagingPath, "style-packs.json"), "{}");

  const manifest = {
    artifactType: "internal-evaluation",
    browser: {
      packaged: true,
      sha256: sha256(browserPath),
      treeSha256: treeSha256(path.dirname(browserPath))
    },
    bundle: { path: "remotion-bundle", sha256: treeSha256(bundlePath) },
    platform: "win32",
    runtimeClosure: [{
      lockPath: "node_modules/remotion",
      name: "remotion",
      treeSha256: packageTreeSha256(packagePath)
    }],
    runtimeHash: hashWorkerRuntime(bundlePath, packagingPath, workerPath),
    schemaVersion: 1,
    targetArchitecture: "x64",
    worker: { path: "remotion-render-worker.mjs", sha256: sha256(workerPath) }
  };
  const manifestFile = path.join(contentEngine, "remotion-runtime-manifest.json");
  write(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const manifestSha256 = sha256(manifestFile);
  write(path.join(contentEngine, "remotion-runtime-manifest.sha256"), `${manifestSha256}  remotion-runtime-manifest.json\n`);
  write(path.join(root, "portable", "版本清单.json"), JSON.stringify({
    artifactType: "internal-evaluation",
    remotionRuntime: {
      artifactType: "internal-evaluation",
      browserSha256: manifest.browser.sha256,
      browserTreeSha256: manifest.browser.treeSha256,
      bundleSha256: manifest.bundle.sha256,
      manifestSha256,
      runtimeHash: manifest.runtimeHash,
      workerSha256: manifest.worker.sha256
    }
  }));

  const overrideBundle = path.join(root, "override-bundle");
  const overrideBrowser = path.join(root, "override-browser.exe");
  write(path.join(overrideBundle, "index.html"), "untrusted override");
  write(overrideBrowser, "untrusted override");
  const environment = {
    XIAOXI_REMOTION_BUNDLE_PATH: overrideBundle,
    XIAOXI_REMOTION_BROWSER_PATH: overrideBrowser
  };
  const packaged = resolveRemotionRuntimeEnvironment({
    environment,
    executablePath: "C:\\portable\\app.exe",
    isPackaged: true,
    moduleDir: path.join(root, "module"),
    resourcesPath
  });
  assert.equal(packaged.XIAOXI_REMOTION_BUNDLE_PATH, bundlePath);
  assert.equal(packaged.XIAOXI_REMOTION_BROWSER_PATH, browserPath);
  assert.equal(packaged.XIAOXI_REMOTION_WORKER_PATH, workerPath);
  assert.equal(Object.values(packaged).includes(overrideBundle), false);
  assert.equal(Object.values(packaged).includes(overrideBrowser), false);

  const originalWorker = fs.readFileSync(workerPath);
  fs.appendFileSync(workerPath, "tampered");
  assert.throws(() => resolveRemotionRuntimeEnvironment({
    environment,
    executablePath: "C:\\portable\\app.exe",
    isPackaged: true,
    moduleDir: path.join(root, "module"),
    resourcesPath
  }), /worker hash mismatch/u, "integrity failure must occur before any worker/browser path is exposed");
  fs.writeFileSync(workerPath, originalWorker);

  const originalBrowserDependency = fs.readFileSync(browserDependency);
  fs.appendFileSync(browserDependency, "tampered");
  assert.throws(() => resolveRemotionRuntimeEnvironment({
    environment,
    executablePath: "C:\\portable\\app.exe",
    isPackaged: true,
    moduleDir: path.join(root, "module"),
    resourcesPath
  }), /browser runtime tree hash mismatch/u, "browser dependencies must be verified before their path is exposed");
  fs.writeFileSync(browserDependency, originalBrowserDependency);

  const unexpectedPackage = path.join(contentEngine, "node_modules", "unexpected", "package.json");
  write(unexpectedPackage, JSON.stringify({ name: "unexpected", version: "1.0.0" }));
  assert.throws(() => resolveRemotionRuntimeEnvironment({
    environment,
    executablePath: "C:\\portable\\app.exe",
    isPackaged: true,
    moduleDir: path.join(root, "module"),
    resourcesPath
  }), /missing or unexpected packages/u);
  fs.rmSync(path.dirname(unexpectedPackage), { recursive: true, force: true });

  const development = resolveRemotionRuntimeEnvironment({
    environment,
    executablePath: "C:\\development\\electron.exe",
    isPackaged: false,
    moduleDir: path.join(root, "module"),
    resourcesPath: path.join(root, "unused")
  });
  assert.equal(development.XIAOXI_REMOTION_BUNDLE_PATH, overrideBundle);
  assert.equal(development.XIAOXI_REMOTION_BROWSER_PATH, overrideBrowser);
  assert.equal(development.XIAOXI_REMOTION_WORKER_PATH, path.join(root, "module", "remotion-render-worker.mjs"));

  console.log("remotion runtime environment self-check passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
