const fs = require("node:fs");
const path = require("node:path");

const APPLICATION_ROOT = path.resolve(__dirname, "..", "..");
const SOURCE_ROOT = path.resolve(APPLICATION_ROOT, "..");

function isWithin(root, target) {
  const relative = path.relative(String(root).toLowerCase(), String(target).toLowerCase());
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveExistingPath(target) {
  const missing = [];
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  try {
    return path.join(fs.realpathSync.native(current), ...missing);
  } catch {
    return path.resolve(target);
  }
}

function isApplicationTreePath(dataDir) {
  const resolvedDataDir = path.resolve(dataDir);
  const physicalDataDir = resolveExistingPath(resolvedDataDir);
  return [APPLICATION_ROOT, SOURCE_ROOT].some((root) =>
    isWithin(root, resolvedDataDir) || isWithin(resolveExistingPath(root), physicalDataDir)
  );
}

function absoluteDataDirError(command, value) {
  const dataDir = String(value ?? "").trim();
  if (!dataDir) {
    return {
      ok: false,
      action: command,
      blocked_reason: "data_dir_required",
      error: "缺少绝对 --data-dir，已阻断以避免写入安装目录",
      logs: []
    };
  }
  if (!path.isAbsolute(dataDir)) {
    return {
      ok: false,
      action: command,
      blocked_reason: "data_dir_not_absolute",
      error: "--data-dir 必须是绝对路径，已阻断以避免写入安装目录",
      logs: []
    };
  }
  if (isApplicationTreePath(dataDir)) {
    return {
      ok: false,
      action: command,
      blocked_reason: "data_dir_inside_application",
      error: "--data-dir 不能位于应用或源码目录，已阻断以避免写入安装目录",
      logs: []
    };
  }
  return null;
}

module.exports = { absoluteDataDirError, isApplicationTreePath };
