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
    const candidateHash = require("./release-tree-hash.cjs").sha256(candidateFile);
    if (fs.statSync(candidateFile).size === entry.size && candidateHash === entry.sha256) continue;
    // Only text normalization can stabilize different bytes. Large unchanged
    // binaries compare with the accepted manifest instead of rereading it.
    if (!textBaseExtensions.has(path.extname(entry.path).toLowerCase())) continue;
    const accepted = fs.readFileSync(acceptedFile);
    if (accepted.length !== entry.size || digest(accepted) !== entry.sha256) {
      throw new Error(`Accepted component base file has changed on disk: ${entry.path}`);
    }
    const candidate = fs.readFileSync(candidateFile);
    const acceptedText = normalizedText(accepted, entry.path);
    const candidateText = normalizedText(candidate, entry.path);
    if (acceptedText === null || candidateText === null || acceptedText !== candidateText) continue;
    require("./release-tree-hash.cjs").replaceImmutableFile(acceptedFile, candidateFile);
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

function baseUpgradeReview(previous, current, kinds = "") {
  const before = new Map((previous?.files || []).filter(file => file.component === "base").map(file => [file.path, file]));
  const after = new Map(current.files.filter(file => file.component === "base").map(file => [file.path, file]));
  const transition = (previous?.updateProtocol ?? 4) === 4 && current.updateProtocol === 5;
  const declared = new Set(kinds.split(",").map(kind => kind.trim()).filter(Boolean));
  const allowed = ["electron-runtime", "python-runtime", "dependency-runtime", "browser-runtime", "media-runtime"];
  if ([...declared].some(kind => !allowed.includes(kind))) throw Error("Unknown base upgrade kind");
  const electronFiles = new Set(fs.readdirSync(path.dirname(require("electron"))));
  const brand = require("../product-brand.json");
  const { classify } = require("./build-component-release.cjs"), layout = require("../component-layout.json");
  for (const suffix of ["", "-测试版"]) electronFiles.add(brand.executableName + suffix + ".exe");
  const changes = [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(file => {
    const old = before.get(file), next = after.get(file);
    if (old && next && old.size === next.size && old.sha256 === next.sha256) return [];
    let reason = !previous ? "initial-installation" : transition ? "protocol-transition" : "";
    if (!reason && classify(file, layout) === "base") {
      if ((!file.includes("/") && electronFiles.has(file)) || /^locales\/[^/]+\.pak$/.test(file) || file === "resources/default_app.asar") reason = "electron-runtime";
      else if (/^resources\/(?:app|content-engine)\/(?:node_modules|remotion-licenses)\//.test(file)
          || file === "resources/content-engine/THIRD_PARTY_LICENSES.md") reason = "dependency-runtime";
      else if (/^resources\/(?:content-engine|product-detail)\/_internal\//.test(file)) reason = "python-runtime";
      else if (/^resources\/(?:content-engine|product-detail)\/browser\//.test(file)) reason = "browser-runtime";
      else if (/^resources\/(?:content-engine|product-detail)\/media-tools\//.test(file)) reason = "media-runtime";
    }
    return [{ path: file, before: old?.sha256 || null, after: next?.sha256 || null, reason: reason || "move-to-component",
      approved: !previous || transition || Boolean(reason && declared.has(reason)) }];
  });
  const labelOnly = previous && !transition && previous.base.version !== current.base.version
    && previous.base.fingerprint === current.base.fingerprint && previous.dataSchema === current.dataSchema;
  return { previous: previous?.base || null, current: current.base, changes,
    ...(labelOnly ? { rejectedReason: "base-label-without-runtime-change" } : {}),
    allowed: !labelOnly && changes.every(change => change.approved) };
}

function reviewBaseUpgrade(candidateRoot, acceptedRoot, reportFile) {
  const previous = acceptedRoot ? readComponentBase(acceptedRoot) : null;
  const current = readComponentBase(candidateRoot, true);
  const report = baseUpgradeReview(previous, current, process.env.XIAOXI_BASE_UPGRADE_KIND || "");
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  for (const change of report.changes) console.log(`Base change (${change.reason}): ${change.path}`);
  if (!report.allowed) throw Error("Base changes require a declared large runtime upgrade (XIAOXI_BASE_UPGRADE_KIND); move ordinary code into its component. See " + reportFile);
  return report;
}

module.exports = { readComponentBase, pythonLibraryReference, stabilizeEquivalentBaseFiles, assertComponentBase, baseUpgradeReview, reviewBaseUpgrade };
