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

const textBaseExtensions = new Set([".cjs", ".mjs", ".js", ".json", ".txt", ".crt", ".css", ".html", ".svg", ".xml", ".md"]);

function normalizedText(buffer, filename) {
  if (!textBaseExtensions.has(path.extname(filename).toLowerCase()) || buffer.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/\r\n?/gu, "\n");
  } catch {
    return null;
  }
}

function stabilizeEquivalentBaseFiles(candidateRoot, acceptedRoot) {
  const baseline = readComponentBase(acceptedRoot, true);
  const stabilized = [];
  for (const entry of baseline.files.filter(file => file.component === "base")) {
    const acceptedFile = path.join(acceptedRoot, entry.path);
    const candidateFile = path.join(candidateRoot, entry.path);
    if (!fs.existsSync(acceptedFile) || !fs.existsSync(candidateFile)) continue;
    const accepted = fs.readFileSync(acceptedFile);
    if (accepted.length !== entry.size || digest(accepted) !== entry.sha256) {
      throw new Error(`Accepted component base file has changed on disk: ${entry.path}`);
    }
    const candidate = fs.readFileSync(candidateFile);
    if (candidate.equals(accepted)) continue;
    const acceptedText = normalizedText(accepted, entry.path);
    const candidateText = normalizedText(candidate, entry.path);
    if (acceptedText === null || candidateText === null || acceptedText !== candidateText) continue;
    fs.copyFileSync(acceptedFile, candidateFile);
    stabilized.push(entry.path);
  }
  return stabilized;
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

module.exports = { readComponentBase, pythonLibraryReference, stabilizeEquivalentBaseFiles, assertComponentBase };
