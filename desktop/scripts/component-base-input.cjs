const fs = require("node:fs");
const path = require("node:path");
const { assertCompatible, treeHash, validateFiles, digest } = require("../src/shared/component-contract.cjs");

function readComponentBase(root, required = false) {
  const file = path.join(root, "component-base.json");
  if (!fs.existsSync(file)) {
    if (required) throw new Error("Incremental release needs an accepted base. Use --base <application-directory>, or --full for the first installation.");
    return null;
  }
  const baseline = JSON.parse(fs.readFileSync(file, "utf8"));
  validateFiles(baseline.files);
  if (baseline.schema !== 2 || treeHash(baseline.files.filter(entry => entry.component === "base")) !== baseline.base?.fingerprint) {
    throw new Error("Accepted component base manifest is invalid");
  }
  return baseline;
}

function pythonLibraryReference(root, baseline, kind = "content-engine") {
  if (!baseline) return null;
  if (!["content-engine", "product-detail"].includes(kind)) throw new Error("Unknown Python runtime");
  const entry = baseline.files.find(item => item.path === `resources/${kind}/_internal/base_library.zip` && item.component === "base");
  if (!entry) return null;
  const file = path.join(root, entry.path);
  const content = fs.readFileSync(file);
  if (content.length !== entry.size || digest(content) !== entry.sha256) throw new Error("Accepted Python base library has changed on disk");
  return { file, sha256: entry.sha256 };
}

function assertComponentBase(metadata, root) {
  const baseline = readComponentBase(root, true);
  try { assertCompatible(metadata.manifest, baseline); }
  catch (error) {
    if (error.message !== "full_upgrade_required") throw error;
    const previous = new Map(baseline.files.filter(file => file.component === "base").map(file => [file.path, file]));
    const current = new Map(metadata.baseline.files.filter(file => file.component === "base").map(file => [file.path, file]));
    const changed = [...new Set([...previous.keys(), ...current.keys()])].filter(file => {
      const before = previous.get(file), after = current.get(file);
      return !before || !after || before.sha256 !== after.sha256 || before.size !== after.size;
    });
    throw new Error(`Incremental base is incompatible; retain this result and review an explicit --full build. Changed base files: ${changed.join(", ") || "base version or data schema"}`);
  }
}

module.exports = { readComponentBase, pythonLibraryReference, assertComponentBase };
