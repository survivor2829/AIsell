// ASARs are physical files here; budgets count copied bytes, not source disk allocation.
const fs = process.versions.electron ? require("original-fs") : require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const PHASES = { prepare: "校验更新文件", helper: "准备更新助手", launch: "启动更新助手", ready: "等待更新助手就绪",
  waiting: "等待程序退出", verifying: "校验更新文件", backup: "备份业务数据", installing: "安装更新", starting: "启动新版本", complete: "保存更新完成记录" };
const normalize = file => {
  const value = path.toNamespacedPath(path.resolve(file));
  return process.platform === "win32" ? value.toLowerCase() : value;
};
function backupFilter(userData) {
  const root = normalize(userData);
  return file => {
    const relative = path.relative(root, normalize(file)).replaceAll("\\", "/");
    return !["data/cloud-maintenance", "update-helper-profile"].some(dir => relative === dir || relative.startsWith(dir + "/"));
  };
}
async function copyBytes(file, filter = () => true) {
  if (!filter(file)) return 0;
  const info = await fs.promises.lstat(file);
  // Match cp's non-dereferencing behavior. Never recurse into junctions or deduplicate hardlinks.
  if (info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  let bytes = 0;
  for (const name of await fs.promises.readdir(file)) bytes += await copyBytes(path.join(file, name), filter);
  return bytes;
}
async function existingDirectory(file) {
  let directory = path.resolve(file);
  while (true) {
    try { return await fs.promises.realpath(directory); }
    catch (error) {
      if (error.code !== "ENOENT" || path.dirname(directory) === directory) throw error;
      directory = path.dirname(directory);
    }
  }
}
async function checkCopySpace(parts) {
  const volumes = new Map();
  for (const part of parts) {
    const directory = await existingDirectory(part.path);
    const [info, disk] = await Promise.all([fs.promises.stat(directory), fs.promises.statfs(directory)]);
    const availableBytes = Number(disk.bavail) * Number(disk.bsize);
    const volume = volumes.get(info.dev) || { path: directory, requiredBytes: 0, availableBytes };
    volume.availableBytes = Math.min(volume.availableBytes, availableBytes);
    volume.requiredBytes += part.bytes;
    volumes.set(info.dev, volume);
  }
  for (const volume of volumes.values()) {
    // Leave room for receipts and files created between the inventory and the actual copy.
    volume.requiredBytes += Math.max(64 * 1024 ** 2, Math.ceil(volume.requiredBytes * 0.05));
    if (volume.availableBytes < volume.requiredBytes) throw Object.assign(Error("update_disk_space_insufficient"), {
      code: "update_disk_space_insufficient", ...volume
    });
  }
  return [...volumes.values()];
}
async function createOwnedDirectory(parent, name) {
  if (!/^[a-zA-Z0-9-]+$/.test(name)) throw Error("update_copy_path_invalid");
  await fs.promises.mkdir(parent, { recursive: true });
  const realParent = await fs.promises.realpath(parent), directory = path.join(realParent, name);
  // Exclusive mkdir is ownership: an existing backup or helper is never ours to remove.
  try { await fs.promises.mkdir(directory); }
  catch (error) { if (error.code === "EEXIST") error.code = "ERR_FS_CP_EEXIST"; throw error; }
  const info = await fs.promises.lstat(directory, { bigint: true });
  return { parent: realParent, directory, identity: { dev: String(info.dev), ino: String(info.ino) } };
}
async function removeOwnedDirectory(owned) {
  const directory = path.resolve(owned.directory), parent = path.resolve(owned.parent);
  if (parent === path.parse(parent).root || path.dirname(directory) !== parent
      || normalize(await fs.promises.realpath(parent)) !== normalize(parent)) throw Error("update_copy_path_invalid");
  const matches = info => info.isDirectory() && !info.isSymbolicLink()
    && String(info.dev) === owned.identity?.dev && String(info.ino) === owned.identity?.ino;
  if (!matches(await fs.promises.lstat(directory, { bigint: true }))
      || normalize(await fs.promises.realpath(directory)) !== normalize(directory)) throw Error("update_copy_path_invalid");
  // Move to an unpredictable sibling and recheck identity before recursive removal.
  // If the source was replaced during the rename, preserve it instead of deleting it.
  const discarded = path.join(parent, ".discard-" + randomUUID());
  await fs.promises.rename(directory, discarded);
  if (!matches(await fs.promises.lstat(discarded, { bigint: true }))
      || normalize(await fs.promises.realpath(parent)) !== normalize(parent)
      || normalize(await fs.promises.realpath(discarded)) !== normalize(discarded)) throw Error("update_copy_path_invalid");
  await fs.promises.rm(discarded, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
function updateFailure(error, phase) {
  const rawCode = String(error?.code || error?.message || "update_failed");
  const code = /^[a-zA-Z][a-zA-Z0-9_]{0,95}$/.test(rawCode) ? rawCode : "update_failed";
  const failure = { phase: Object.hasOwn(PHASES, phase) ? phase : "prepare", code,
    message: String(error?.message || code).slice(0, 2000) };
  for (const key of ["path", "syscall"]) if (typeof error?.[key] === "string") failure[key] = error[key].slice(0, 2000);
  for (const key of ["requiredBytes", "availableBytes"]) if (Number.isFinite(error?.[key])) failure[key] = error[key];
  if (/^[a-zA-Z][a-zA-Z0-9_]{0,95}$/.test(error?.cleanupCode || "")) failure.cleanupCode = error.cleanupCode;
  return failure;
}
function formatUpdateFailure(failure) {
  const stage = PHASES[failure.phase] || "准备更新";
  let detail;
  if (failure.code === "update_disk_space_insufficient") {
    const gib = value => (value / 1024 ** 3).toFixed(2);
    detail = `更新助手和数据备份空间不足：预计需要 ${gib(failure.requiredBytes)} GB，可用 ${gib(failure.availableBytes)} GB。尚未开始安装，请勿反复重试。`;
  } else if (failure.code === "ENOSPC") {
    detail = "系统报告写入空间不足（ENOSPC）。请保留出错位置与阶段，暂停重试，不要卸载或删除业务数据。";
  } else if (["EACCES", "EPERM", "EBUSY"].includes(failure.code)) {
    detail = `更新文件无法访问或正被占用（${failure.code}），请检查目录权限及相关程序占用，不要卸载或删除业务数据。`;
  } else if (failure.code === "update_helper_not_ready") {
    detail = "更新助手未能按时就绪，当前程序保持打开，尚未开始安装。";
  } else if (["cloud_signature_invalid", "cloud_download_invalid", "update_version_mismatch"].includes(failure.code)) {
    detail = `更新文件校验失败（${failure.code}），已阻止安装，请重新检查更新。`;
  } else {
    detail = `更新未完成（${failure.code}）。请保留错误详情，不要卸载或删除业务数据。`;
    if (failure.code === "update_failed") detail += `\n${failure.message}`;
  }
  return `${stage}失败。${detail}${failure.path ? `\n位置：${failure.path}` : ""}${failure.cleanupCode ? `\n本次临时副本未能回收（${failure.cleanupCode}）。` : ""}`;
}
module.exports = { backupFilter, copyBytes, checkCopySpace, createOwnedDirectory, removeOwnedDirectory, updateFailure, formatUpdateFailure };
