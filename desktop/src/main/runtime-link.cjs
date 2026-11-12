const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// A component generation adds a 64-character directory to every dependency.
// Python's package resources still hit MAX_PATH when Windows long paths are off
// (field 2026-11-07 and 2026-11-12: on a user named "Administrator" the content
// engine's music-catalog-policy.v1.json sat at exactly 260 characters, so the
// frozen engine could not open it while Node's existence check still found it).
// Launch the frozen application, and every trusted path inside the same
// resources folder, through one short, version-specific junction under the
// sidecar's own data folder; never relocate or overwrite the verified runtime.
// `keepReal(key)` names paths whose reader refuses reparse points (the content engine's Remotion
// paths: remotion_render._trusted_runtime_path); they are handed over as they are.
function prepareRuntimeLaunch(runtimePath, dataDir, trustedEnvironment, { folder = "product-detail", platform = process.platform, keepReal = () => false } = {}) {
  if (platform !== "win32" || path.basename(path.dirname(runtimePath)) !== folder) {
    return { runtimePath, environment: trustedEnvironment };
  }
  const resources = path.dirname(path.dirname(runtimePath));
  const realResources = fs.realpathSync(resources);
  const id = crypto.createHash("sha256").update(realResources.toLowerCase()).digest("hex").slice(0, 16);
  const linkRoot = path.join(dataDir, ".runtime-links");
  const link = path.join(linkRoot, id);
  fs.mkdirSync(linkRoot, { recursive: true });
  if (fs.lstatSync(linkRoot).isSymbolicLink()) throw new Error("runtime link directory must be local");
  let stat;
  try { stat = fs.lstatSync(link); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!stat) {
    try { fs.symlinkSync(realResources, link, "junction"); } catch (error) { if (error.code !== "EEXIST") throw error; }
    stat = fs.lstatSync(link);
  }
  if (!stat.isSymbolicLink() || fs.realpathSync(link).toLowerCase() !== realResources.toLowerCase()) {
    throw Object.assign(new Error("runtime link target mismatch"), { code: "RUNTIME_LINK_FAILED" });
  }
  const environment = { ...trustedEnvironment };
  for (const [key, value] of Object.entries(environment)) {
    // Flags such as XIAOXI_DISABLE_PAID_CALLS=0 are not paths and stay as they are.
    if (keepReal(key) || !path.isAbsolute(String(value)) || !fs.existsSync(value)) continue;
    const relative = path.relative(realResources, fs.realpathSync(value));
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) environment[key] = path.join(link, relative);
  }
  return { runtimePath: path.join(link, path.relative(resources, runtimePath)), environment };
}

module.exports = { prepareRuntimeLaunch };
