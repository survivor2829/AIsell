const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CONTACT_PROFILE_NAMES = [
  "xiaoxi-active-touch-desktop",
  "xiaoxi-active-touch-development",
  "xiaoxi-active-touch-controlled-pilot",
  "xiaoxi-active-touch-test",
  "xiaoxi-active-touch-delivery"
];

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
  copyVerifiedFile(source, destination);
  fs.rmSync(source, { force: true });
  return "migrated";
}

function copyVerifiedFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = `${destination}.migration-${process.pid}-${Date.now()}`;
  try {
    fs.copyFileSync(source, temp);
    if (fs.statSync(source).size !== fs.statSync(temp).size) throw new Error("runtime data migration verification failed");
    fs.rmSync(destination, { force: true });
    fs.renameSync(temp, destination);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function migrateLatestProfileContacts(paths, userDataDir, result) {
  const destination = path.join(paths.activeTouchDir, "contacts.json");
  try {
    if (JSON.parse(fs.readFileSync(destination, "utf8")).length) return;
  } catch {
    // An empty new profile may reuse the last successful contact snapshot.
  }

  let targetAccount = "";
  try {
    targetAccount = String(JSON.parse(fs.readFileSync(path.join(paths.contactSyncDir, "state.json"), "utf8")).account_name || "");
  } catch {
    // A brand-new profile has no account hint, so the newest valid snapshot wins.
  }
  const currentProfile = path.resolve(userDataDir).toLowerCase();
  const candidates = CONTACT_PROFILE_NAMES
    .map((name) => path.join(path.dirname(userDataDir), name))
    .filter((profile) => path.resolve(profile).toLowerCase() !== currentProfile)
    .map((profile) => {
      const sourcePaths = resolveRuntimePaths(profile);
      const contactsFile = path.join(sourcePaths.activeTouchDir, "contacts.json");
      try {
        return { profile, sourcePaths, contactsFile, mtimeMs: fs.statSync(contactsFile).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  let source = null;
  for (const candidate of candidates) {
    let state = {};
    try {
      state = JSON.parse(fs.readFileSync(path.join(candidate.sourcePaths.contactSyncDir, "state.json"), "utf8"));
    } catch {
      // A snapshot without state is eligible only when the current account is unknown.
    }
    if (targetAccount && String(state.account_name || "") !== targetAccount) continue;
    try {
      const contacts = JSON.parse(fs.readFileSync(candidate.contactsFile, "utf8"));
      if (Array.isArray(contacts) && contacts.length) {
        source = { ...candidate, contacts, state };
        break;
      }
    } catch {
      // Try the next valid snapshot.
    }
  }
  if (!source) return;

  const destinationState = path.join(paths.contactSyncDir, "state.json");
  copyVerifiedFile(source.contactsFile, destination);
  fs.writeFileSync(destinationState, `${JSON.stringify({
    ...source.state,
    status: "synced",
    contact_count: source.contacts.length,
    last_error: "",
    last_stage: source.state.last_stage || "synced"
  }, null, 2)}\n`, "utf8");
  result.migrated.push(destination, destinationState);
}

function migrateLegacyRuntimeData({ appPath, userDataDir, userHome = os.homedir() }) {
  const paths = resolveRuntimePaths(userDataDir);
  fs.mkdirSync(paths.activeTouchDir, { recursive: true });
  fs.mkdirSync(paths.contactSyncDir, { recursive: true });
  const result = { ...paths, migrated: [], keptExisting: [], skippedForeignInstall: false };
  migrateLatestProfileContacts(paths, userDataDir, result);
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
