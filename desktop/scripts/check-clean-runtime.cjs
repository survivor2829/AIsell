const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const releaseDir = path.resolve(desktopDir, "..", "release");
const productBrand = require("../product-brand.json");
const isPackagedApp = path.basename(desktopDir).toLowerCase() === "app" && path.basename(path.dirname(desktopDir)).toLowerCase() === "resources";
const releaseProductNames = [
  productBrand.displayName,
  `${productBrand.displayName}-测试版`,
  productBrand.stableInstallDirectoryName,
  `${productBrand.stableInstallDirectoryName}-测试版`
];
const releaseAppDirs = isPackagedApp ? [desktopDir] : [...new Set(releaseProductNames)].map((productName) =>
  path.resolve(desktopDir, "..", "release", productName, "resources", "app")
);
const relativeRuntimeFiles = [
  path.join("ai-expert.json"),
  path.join("auto-reply-state.json"),
  path.join("auto-reply-diagnostics.jsonl"),
  path.join("rpa", "active_touch", "contacts.json"),
  path.join("rpa", "active_touch", "touch_task.json"),
  path.join("rpa", "active_touch", "run_logs.jsonl"),
  path.join("rpa", "active_touch", "state.json"),
  path.join("rpa", "contact_sync", "state.json")
];
const forbidden = [
  ...relativeRuntimeFiles.map((file) => path.join(desktopDir, file)),
  ...releaseAppDirs.flatMap((root) => relativeRuntimeFiles.map((file) => path.join(root, file))),
  ...[desktopDir, ...releaseAppDirs].flatMap((root) => [
    path.join(root, ".env.ai.local"),
    path.join(root, "data", "ai-expert.json"),
    path.join(root, "data", "auto_reply", "auto-reply-state.json"),
    path.join(root, "data", "auto_reply", "auto-reply-diagnostics.jsonl"),
    path.join(root, "data", "deepseek-api-key.bin")
  ]),
  ...(isPackagedApp ? [path.join(desktopDir, ".env.ai.local")] : [])
].filter((file) => fs.existsSync(file));

const sharedScanSkips = new Set(["node_modules", "dist", "dist-development", "dist-pilot", ".vite"]);
const sourceOnlyScanSkips = new Set([".build", ".pytest_cache", "__pycache__"]);
const allowedSourceEnvExamples = new Set([
  path.join(desktopDir, "sidecars", "product-detail", "app", ".env.example")
].map((file) => path.resolve(file)));const allowedSourceKeyFixtures = new Set([
  ".env.example",
  "conftest.py",
  "docs/superpowers/plans/2026-05-06-P3-key-platform-implementation.md",
  "scripts/archive/one_shot/smoke_task8_concurrency.py",
  "scripts/archive/one_shot/verify_refine_worker_context.py",
  "scripts/archive/one_shot/verify_task11_step_c.py",
  "tests/test_dual_key_mode.py",
  "tests/test_p4_secret_key_hardening.py"
].map((relative) => path.resolve(
  desktopDir,
  "sidecars",
  "product-detail",
  "app",
  ...relative.split("/")
)));

function skipScanDirectory(name, sourceScan) {
  return sharedScanSkips.has(name) || (sourceScan && sourceOnlyScanSkips.has(name));
}

function findEnvFiles(root, sourceScan = false) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return skipScanDirectory(entry.name, sourceScan) ? [] : findEnvFiles(file, sourceScan);
    if (sourceScan && allowedSourceEnvExamples.has(path.resolve(file))) return [];
    return entry.isFile() && /^\.env(?:\.|$)/i.test(entry.name) ? [file] : [];
  });
}

forbidden.push(...findEnvFiles(desktopDir, true), ...findEnvFiles(releaseDir, false));

if (forbidden.length) {
  console.error("Build blocked: runtime or secret files remain in source/release:");
  forbidden.forEach((file) => console.error(`- ${path.relative(path.resolve(desktopDir, ".."), file)}`));
  process.exit(1);
}

function scanForApiKeys(root, sourceScan = false) {
  if (!fs.existsSync(root)) return [];
  const hits = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!skipScanDirectory(entry.name, sourceScan)) hits.push(...scanForApiKeys(file, sourceScan));
    }
    else if (entry.isFile() && fs.statSync(file).size <= 5 * 1024 * 1024) {
      const content = fs.readFileSync(file, "utf8");
      const hasKeyLikeContent = /\bsk-[A-Za-z0-9_-]{12,}\b/.test(content);
      const allowedFixture = sourceScan && allowedSourceKeyFixtures.has(path.resolve(file));
      if (hasKeyLikeContent && !allowedFixture) hits.push(file);
    }
  }
  return hits;
}

const keyHits = [...scanForApiKeys(desktopDir, true), ...scanForApiKeys(releaseDir, false)];
if (keyHits.length) {
  console.error("Build blocked: API Key-like content found in source or release:");
  keyHits.forEach((file) => console.error(`- ${path.relative(path.resolve(desktopDir, ".."), file)}`));
  process.exit(1);
}

console.log("clean-runtime check passed");
