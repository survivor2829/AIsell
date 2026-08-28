const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeFileAtomic, writeJsonAtomic } = require("./atomic-file.cjs");

function resolveRuntimePaths(userDataDir) {
  const rootDir = path.join(userDataDir, "data");
  return {
    rootDir,
    activeTouchDir: path.join(rootDir, "active_touch"),
    autoReplyDir: path.join(rootDir, "auto_reply"),
    contactSyncDir: path.join(rootDir, "contact_sync"),
    momentsDir: path.join(rootDir, "moments"),
    wechatAdapterDir: path.join(rootDir, "wechat_adapter"),
    runtimeArchiveDir: path.join(rootDir, "runtime_archive")
  };
}

function isInside(parentDir, childDir) {
  const relative = path.relative(path.resolve(parentDir).toLowerCase(), path.resolve(childDir).toLowerCase());
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function removeVerifiedFile(file, expectedHash) {
  if (sha256File(file) !== expectedHash) throw new Error("runtime data migration source changed before cleanup");
  fs.rmSync(file, { force: true });
}

function conflictArchiveFile(runtimeArchiveDir, source, sourceHash) {
  const extension = path.extname(source);
  const filename = path.basename(source, extension);
  return path.join(runtimeArchiveDir, `legacy-${filename}-${sourceHash}${extension}`);
}

function archiveConflictingFile(source, runtimeArchiveDir, sourceHash) {
  const archiveFile = conflictArchiveFile(runtimeArchiveDir, source, sourceHash);
  fs.mkdirSync(runtimeArchiveDir, { recursive: true });
  if (!fs.existsSync(archiveFile)) {
    try {
      fs.copyFileSync(source, archiveFile, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  if (sha256File(archiveFile) !== sourceHash) throw new Error("runtime data migration archive verification failed");
  return archiveFile;
}

function migrateFile(source, destination, runtimeArchiveDir) {
  if (!fs.existsSync(source)) return { status: "missing" };
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    const sourceHash = sha256File(source);
    if (sourceHash !== sha256File(destination)) {
      const archiveFile = archiveConflictingFile(source, runtimeArchiveDir, sourceHash);
      removeVerifiedFile(source, sourceHash);
      return { status: "kept-existing", archiveFile };
    }
    removeVerifiedFile(source, sourceHash);
    return { status: "kept-existing" };
  }
  const sourceHash = copyVerifiedFile(source, destination);
  removeVerifiedFile(source, sourceHash);
  return { status: "migrated" };
}

function copyVerifiedFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const content = fs.readFileSync(source);
  const sourceHash = crypto.createHash("sha256").update(content).digest("hex");
  writeFileAtomic(destination, content);
  if (sha256File(destination) !== sourceHash) throw new Error("runtime data migration verification failed");
  return sourceHash;
}

function splitLegacyMomentsState(paths, result) {
  const activeStateFile = path.join(paths.activeTouchDir, "state.json");
  if (!fs.existsSync(activeStateFile)) return;
  let activeState;
  try {
    activeState = JSON.parse(fs.readFileSync(activeStateFile, "utf8"));
  } catch {
    return;
  }
  if (!activeState || Array.isArray(activeState) || typeof activeState !== "object") return;
  const momentsEntries = Object.entries(activeState).filter(([key]) => key.startsWith("moments_"));
  if (!momentsEntries.length) return;

  const archiveFile = path.join(paths.runtimeArchiveDir, "active-touch-state-before-moments-split.json");
  if (!fs.existsSync(archiveFile)) {
    copyVerifiedFile(activeStateFile, archiveFile);
    result.archived.push(archiveFile);
  }

  const momentsStateFile = path.join(paths.momentsDir, "state.json");
  let momentsState = {};
  try {
    const existing = JSON.parse(fs.readFileSync(momentsStateFile, "utf8"));
    if (existing && !Array.isArray(existing) && typeof existing === "object") momentsState = existing;
  } catch {}
  for (const [key, value] of momentsEntries) momentsState[key] = value;
  const nextActiveState = { ...activeState };
  for (const [key] of momentsEntries) delete nextActiveState[key];

  writeJsonAtomic(momentsStateFile, momentsState);
  writeJsonAtomic(activeStateFile, nextActiveState);
  result.splitState.push({ from: activeStateFile, to: momentsStateFile, keys: momentsEntries.map(([key]) => key) });
}

function migrateLegacyRuntimeData({ appPath, userDataDir, userHome = os.homedir() }) {
  const paths = resolveRuntimePaths(userDataDir);
  fs.mkdirSync(paths.activeTouchDir, { recursive: true });
  fs.mkdirSync(paths.autoReplyDir, { recursive: true });
  fs.mkdirSync(paths.contactSyncDir, { recursive: true });
  fs.mkdirSync(paths.momentsDir, { recursive: true });
  fs.mkdirSync(paths.wechatAdapterDir, { recursive: true });
  fs.mkdirSync(paths.runtimeArchiveDir, { recursive: true });
  const result = { ...paths, migrated: [], keptExisting: [], archived: [], splitState: [], skippedForeignInstall: false };
  splitLegacyMomentsState(paths, result);
  if (!isInside(userHome, appPath)) {
    result.skippedForeignInstall = true;
    return result;
  }

  const files = [
    [path.join(appPath, "rpa", "active_touch", "contacts.json"), path.join(paths.activeTouchDir, "contacts.json")],
    [path.join(appPath, "rpa", "active_touch", "touch_task.json"), path.join(paths.activeTouchDir, "touch_task.json")],
    [path.join(appPath, "rpa", "active_touch", "run_logs.jsonl"), path.join(paths.activeTouchDir, "run_logs.jsonl")],
    [path.join(appPath, "rpa", "active_touch", "state.json"), path.join(paths.activeTouchDir, "state.json")],
    [path.join(appPath, "rpa", "contact_sync", "state.json"), path.join(paths.contactSyncDir, "state.json")]
  ];

  for (const [source, destination] of files) {
    const migration = migrateFile(source, destination, paths.runtimeArchiveDir);
    if (migration.status === "migrated") result.migrated.push(destination);
    if (migration.status === "kept-existing") result.keptExisting.push(destination);
    if (migration.archiveFile) result.archived.push(migration.archiveFile);
  }
  splitLegacyMomentsState(paths, result);
  // ponytail: delete the obsolete local AI secret instead of maintaining a second migration path.
  for (const legacySecret of [path.join(appPath, ".env.ai.local"), path.join(paths.rootDir, ".env.ai.local")]) {
    if (fs.existsSync(legacySecret)) fs.rmSync(legacySecret, { force: true });
  }
  return result;
}

module.exports = { migrateLegacyRuntimeData, resolveRuntimePaths };
