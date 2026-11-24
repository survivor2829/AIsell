const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { recordVersionHistory } = require("./version-history.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-version-history-"));
try {
  const file = path.join(root, "data", "version-history.json");
  const logs = [];
  let clock = Date.parse("2026-11-21T09:00:00.000Z");
  const start = (version, installerVersion, selectionFailure = "") => {
    clock += 60 * 60 * 1000;
    return recordVersionHistory({ file, version, installerVersion, selectionFailure, log: (details) => logs.push(details), now: () => new Date(clock) });
  };

  assert.equal(start("1.3.45", "1.3.0").downgraded, false, "the first start has nothing to compare");
  assert.equal(start("1.3.46", "1.3.0").downgraded, false, "an update is not reported");
  assert.equal(logs.length, 0);

  // cfe8221b: the same 1.3.0 installer, but the updated components were gone.
  assert.equal(start("1.3.0", "1.3.0", "新版引导未能启动，已恢复上一版本。").downgraded, true);
  assert.deepEqual(logs[0], { from_version: "1.3.46", to_version: "1.3.0", from_installer_version: "1.3.0", to_installer_version: "1.3.0",
    downgrade_kind: "components_dropped", selection_failure_present: true, hours_since_last_start: 1 });
  assert.equal(JSON.stringify(logs).includes("恢复"), false, "the rollback text stays on the computer");

  start("1.3.54", "1.3.52");
  start("1.3.40", "1.3.40");
  assert.equal(logs[1].downgrade_kind, "older_installer", "an older full installer over a newer one");
  start("1.3.39", "1.3.38");
  assert.equal(logs[2].downgrade_kind, "older_installer");
  start("1.3.38", "1.3.38");
  assert.equal(logs[3].downgrade_kind, "components_dropped");
  assert.equal(logs[3].selection_failure_present, false);

  fs.writeFileSync(file, "{broken");
  assert.equal(start("1.3.38", "1.3.38").downgraded, false, "an unreadable history never blocks the start");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, "1.3.38", "and is rewritten");
  console.log("version history self-check passed: downgrades are reported with their kind, updates are not");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
