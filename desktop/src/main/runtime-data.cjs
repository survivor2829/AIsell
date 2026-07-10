const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function resolveRuntimePaths(userDataDir) {
  const rootDir = path.join(userDataDir, "data");
  return {
    rootDir,
    activeTouchDir: path.join(rootDir, "active_touch"),
    contactSyncDir: path.join(rootDir, "contact_sync")
  };
}

function isInside(parentDir, childDir) {
  const relative = path.relative(path.resolve(parentDir).toLowerCase(), path.resolve(childDir).toLowerCase());
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function migrateFile(source, destination) {
  if (!fs.existsSync(source)) return "missing";
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    fs.rmSync(source, { force: true });
    return "kept-existing";
  }

  const temp = `${destination}.migration-${process.pid}-${Date.now()}`;
  try {
    fs.copyFileSync(source, temp);
    if (fs.statSync(source).size !== fs.statSync(temp).size) throw new Error("runtime data migration verification failed");
    fs.renameSync(temp, destination);
    fs.rmSync(source, { force: true });
    return "migrated";
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function migrateLegacyRuntimeData({ appPath, userDataDir, userHome = os.homedir() }) {
  const paths = resolveRuntimePaths(userDataDir);
  fs.mkdirSync(paths.activeTouchDir, { recursive: true });
  fs.mkdirSync(paths.contactSyncDir, { recursive: true });
  const result = { ...paths, migrated: [], keptExisting: [], skippedForeignInstall: false };
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
    const status = migrateFile(source, destination);
    if (status === "migrated") result.migrated.push(destination);
    if (status === "kept-existing") result.keptExisting.push(destination);
  }
  // ponytail: delete the obsolete local AI secret instead of maintaining a second migration path.
  for (const legacySecret of [path.join(appPath, ".env.ai.local"), path.join(paths.rootDir, ".env.ai.local")]) {
    if (fs.existsSync(legacySecret)) fs.rmSync(legacySecret, { force: true });
  }
  return result;
}

module.exports = { migrateLegacyRuntimeData, resolveRuntimePaths };
