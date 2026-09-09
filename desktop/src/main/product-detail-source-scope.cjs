const path = require("node:path");

const PRODUCT_DETAIL_SOURCE_DIRECTORIES = new Set([
  "ai_refine_v2",
  "pubsub",
  "static",
  "templates"
]);
const PRODUCT_DETAIL_SOURCE_EXCLUDED_DIRECTORIES = new Set([
  ".pytest_cache",
  "__pycache__",
  "test_batch_input",
  "tests"
]);
const PRODUCT_DETAIL_MODULE_EXTENSIONS = new Set([".j2", ".py", ".yaml", ".yml"]);

function sourcePathParts(relativePath) {
  return String(relativePath || "").replaceAll("\\", "/").split("/").filter(Boolean);
}

function isProductDetailSourceFile(relativePath) {
  const parts = sourcePathParts(relativePath);
  if (parts.length === 0) return false;
  if (parts.some((part) => PRODUCT_DETAIL_SOURCE_EXCLUDED_DIRECTORIES.has(part))) return false;
  const extension = path.extname(parts.at(-1)).toLowerCase();
  if (extension === ".pyc" || extension === ".pyo") return false;
  if (parts.length === 1) {
    if (parts[0] === "cutout_model.json") return true;
    return extension === ".py" && parts[0] !== "conftest.py";
  }
  if (parts[0] === "static" || parts[0] === "templates") return true;
  if (parts[0] === "pubsub") return extension === ".py";
  if (parts[0] === "ai_refine_v2") return PRODUCT_DETAIL_MODULE_EXTENSIONS.has(extension);
  return false;
}

function gitChangedPaths(output) {
  const paths = [];
  for (const record of String(output || "").split(/\0|\r?\n/u)) {
    if (!record) continue;
    const value = /^[ MADRCU?!]{2} /u.test(record) ? record.slice(3) : record.trim();
    for (const candidate of value.split(" -> ")) {
      const normalized = candidate.trim().replace(/^"|"$/gu, "").replaceAll("\\", "/");
      if (normalized) paths.push(normalized);
    }
  }
  return paths;
}

function productDetailChangedSourceFiles(output, relativeScope) {
  const scope = String(relativeScope || "").replaceAll("\\", "/").replace(/\/$/u, "");
  const prefix = scope ? `${scope}/` : "";
  return gitChangedPaths(output).filter((changedPath) => {
    const relativePath = prefix && changedPath.startsWith(prefix)
      ? changedPath.slice(prefix.length)
      : changedPath;
    return isProductDetailSourceFile(relativePath);
  });
}

module.exports = {
  PRODUCT_DETAIL_SOURCE_DIRECTORIES,
  PRODUCT_DETAIL_SOURCE_EXCLUDED_DIRECTORIES,
  isProductDetailSourceFile,
  productDetailChangedSourceFiles,
  sourcePathParts
};
