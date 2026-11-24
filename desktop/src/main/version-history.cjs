// A computer that went back to an older version must say so in the field reports (cfe8221b,
// 2026-11-21: it ran 1.3.45 until 09:57 and 1.3.0 from 10:03, and nothing recorded the drop or why;
// the afternoon's 734 skips were then read against the wrong version). After each healthy start the
// running version and the installer's own version are kept; a lower running version than last time
// is reported once as an error, which tells the two causes apart:
//   older_installer      an older full installer was installed over the newer one
//   components_dropped   same installer, but the updated components were dropped back to its base
//   other                anything else
// plus whether the component selection held a rollback reason (the reason text itself stays local).
const fs = require("node:fs");
const path = require("node:path");
const { compareVersions } = require("../shared/cloud-contract.cjs");
const { writeJsonAtomic } = require("./atomic-file.cjs");

function recordVersionHistory({ file, version, installerVersion, selectionFailure = "", log, now = () => new Date() }) {
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* First start, or unreadable: nothing to compare. */ }
  const current = { version: String(version || ""), installerVersion: String(installerVersion || ""), at: now().toISOString() };
  let downgraded = false;
  try {
    if (previous?.version && current.version && compareVersions(current.version, previous.version) < 0) {
      downgraded = true;
      const olderInstaller = previous.installerVersion && current.installerVersion
        && compareVersions(current.installerVersion, previous.installerVersion) < 0;
      const cause = olderInstaller ? "older_installer"
        : current.version === current.installerVersion ? "components_dropped" : "other";
      log({ from_version: previous.version, to_version: current.version,
        from_installer_version: previous.installerVersion || "", to_installer_version: current.installerVersion,
        downgrade_kind: cause, selection_failure_present: Boolean(String(selectionFailure || "").trim()),
        hours_since_last_start: Math.round((Date.parse(current.at) - Date.parse(previous.at)) / 360000) / 10 });
    }
  } catch { /* A malformed version never blocks the start. */ }
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); writeJsonAtomic(file, current); } catch { /* Kept next time. */ }
  return { previous, current, downgraded };
}

module.exports = { recordVersionHistory };
