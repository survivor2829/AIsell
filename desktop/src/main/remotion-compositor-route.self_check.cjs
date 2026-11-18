// Remotion's executables start through the app's short runtime link (2026-11-18): from the update
// folder Windows refused to start remotion.exe for longer Windows user names. The worker accepts
// the short route only when it leads to the same verified compositor folder.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
  process.env.XIAOXI_REMOTION_WORKER_IMPORT_ONLY = "1";
  const { compositorBinariesDirectory } = await import(pathToFileURL(path.join(__dirname, "remotion-render-worker.mjs")).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compositor-route-"));
  const real = path.join(root, "deep", "node_modules", "@remotion", "compositor-win32-x64-msvc");
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, "remotion.exe"), "exe");
  const other = path.join(root, "other");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "remotion.exe"), "exe");
  const link = path.join(root, "l");
  fs.symlinkSync(path.join(root, "deep"), link, "junction");
  const shortRoute = path.join(link, "node_modules", "@remotion", "compositor-win32-x64-msvc");
  const resolvePackage = () => real;

  assert.equal(compositorBinariesDirectory(shortRoute, resolvePackage), shortRoute, "the short route to the same folder is used as given");
  assert.equal(compositorBinariesDirectory(other, resolvePackage), null, "a route to any other folder is refused");
  assert.equal(compositorBinariesDirectory("", resolvePackage), null);
  assert.equal(compositorBinariesDirectory("relative/dir", resolvePackage), null);
  assert.equal(compositorBinariesDirectory(String.raw`\\server\share\x`, resolvePackage), null);
  assert.equal(compositorBinariesDirectory(path.join(root, "missing"), resolvePackage), null);
  fs.unlinkSync(path.join(real, "remotion.exe"));
  assert.equal(compositorBinariesDirectory(shortRoute, resolvePackage), null, "no executable, no route");

  // The packaged environment hands the folder over under a key the runtime link maps (not an
  // XIAOXI_REMOTION_ key, which stays real), and the engine is allowed to receive it.
  const environmentSource = fs.readFileSync(path.join(__dirname, "remotion-runtime-environment.cjs"), "utf8");
  assert.match(environmentSource, /XIAOXI_COMPOSITOR_DIR: runtime\.compositorDir/u);
  assert.match(fs.readFileSync(path.join(__dirname, "content-engine-sidecar.cjs"), "utf8"), /"XIAOXI_COMPOSITOR_DIR"/u);
  const worker = fs.readFileSync(path.join(__dirname, "remotion-render-worker.mjs"), "utf8");
  assert.equal((worker.match(/^\s+binariesDirectory,$/gmu) || []).length, 2, "both selectComposition and renderMedia get the route");
  fs.unlinkSync(link);
  console.log("remotion compositor route checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
