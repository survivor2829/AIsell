const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { migrateLegacyRuntimeData, resolveRuntimePaths } = require("./runtime-data.cjs");
const { hasUnfinishedPausedTask, loadTaskState } = require("../../rpa/active_touch/touch_task_state.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-runtime-data-"));

try {
  const userHome = path.join(root, "Users", "tester");
  const appPath = path.join(userHome, "Desktop", "xiaoxi", "resources", "app");
  const userDataDir = path.join(userHome, "AppData", "Roaming", "xiaoxi-active-touch-desktop");
  const legacyActiveTouch = path.join(appPath, "rpa", "active_touch");
  const legacyContactSync = path.join(appPath, "rpa", "contact_sync");
  fs.mkdirSync(legacyActiveTouch, { recursive: true });
  fs.mkdirSync(legacyContactSync, { recursive: true });
  fs.writeFileSync(path.join(legacyActiveTouch, "contacts.json"), '[{"id":"test-contact"}]', "utf8");
  fs.writeFileSync(
    path.join(legacyActiveTouch, "touch_task.json"),
    JSON.stringify({
      status: "paused",
      script: "测试话术",
      current_index: 8,
      total: 10,
      results: Array.from({ length: 10 }, (_, index) => ({ status: index < 8 ? "draft_ready" : "pending" }))
    }),
    "utf8"
  );
  fs.writeFileSync(path.join(legacyActiveTouch, "run_logs.jsonl"), '{"stage":"test"}\n', "utf8");
  fs.writeFileSync(path.join(legacyActiveTouch, "state.json"), '{"calibrated":true}', "utf8");
  fs.writeFileSync(path.join(legacyContactSync, "state.json"), '{"status":"synced"}', "utf8");
  fs.writeFileSync(path.join(appPath, ".env.ai.local"), "XIAOXI_AI_API_KEY=test-key\n", "utf8");

  const migrated = migrateLegacyRuntimeData({ appPath, userDataDir, userHome });
  const paths = resolveRuntimePaths(userDataDir);
  assert.equal(migrated.migrated.length, 5);
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.activeTouchDir, "touch_task.json"), "utf8")).current_index, 8);
  assert.equal(hasUnfinishedPausedTask(loadTaskState(paths.activeTouchDir)), true);
  assert.equal(fs.existsSync(path.join(paths.contactSyncDir, "state.json")), true);
  assert.equal(fs.existsSync(path.join(paths.rootDir, ".env.ai.local")), false);
  assert.equal(fs.existsSync(path.join(appPath, ".env.ai.local")), false);
  assert.equal(fs.existsSync(path.join(legacyActiveTouch, "contacts.json")), false);

  fs.writeFileSync(path.join(legacyActiveTouch, "contacts.json"), '[{"id":"bundled-contact"}]', "utf8");
  migrateLegacyRuntimeData({ appPath, userDataDir, userHome });
  assert.equal(fs.readFileSync(path.join(paths.activeTouchDir, "contacts.json"), "utf8"), '[{"id":"test-contact"}]');
  assert.equal(fs.existsSync(path.join(legacyActiveTouch, "contacts.json")), false);

  const foreignAppPath = path.join(root, "Program Files", "xiaoxi", "resources", "app");
  const foreignContacts = path.join(foreignAppPath, "rpa", "active_touch", "contacts.json");
  fs.mkdirSync(path.dirname(foreignContacts), { recursive: true });
  fs.writeFileSync(foreignContacts, '[{"id":"must-not-migrate"}]', "utf8");
  const skipped = migrateLegacyRuntimeData({ appPath: foreignAppPath, userDataDir, userHome });
  assert.equal(skipped.skippedForeignInstall, true);
  assert.equal(fs.existsSync(foreignContacts), true);
  assert.equal(fs.readFileSync(path.join(paths.activeTouchDir, "contacts.json"), "utf8"), '[{"id":"test-contact"}]');

  const appDataDir = path.join(userHome, "AppData", "Roaming");
  const latestProfile = path.join(appDataDir, "xiaoxi-active-touch-desktop");
  const otherAccountProfile = path.join(appDataDir, "xiaoxi-active-touch-development");
  const testProfile = path.join(appDataDir, "xiaoxi-active-touch-test");
  const latestContacts = path.join(latestProfile, "data", "active_touch", "contacts.json");
  const otherAccountContacts = path.join(otherAccountProfile, "data", "active_touch", "contacts.json");
  fs.mkdirSync(path.dirname(latestContacts), { recursive: true });
  fs.mkdirSync(path.dirname(otherAccountContacts), { recursive: true });
  fs.mkdirSync(path.join(latestProfile, "data", "contact_sync"), { recursive: true });
  fs.mkdirSync(path.join(otherAccountProfile, "data", "contact_sync"), { recursive: true });
  fs.mkdirSync(path.join(testProfile, "data", "contact_sync"), { recursive: true });
  fs.writeFileSync(latestContacts, '[{"id":"latest-contact"}]', "utf8");
  fs.writeFileSync(otherAccountContacts, '[{"id":"other-account-contact"}]', "utf8");
  fs.writeFileSync(path.join(latestProfile, "data", "contact_sync", "state.json"), '{"status":"synced","contact_count":1,"account_name":"wxid_current"}', "utf8");
  fs.writeFileSync(path.join(otherAccountProfile, "data", "contact_sync", "state.json"), '{"status":"synced","contact_count":1,"account_name":"wxid_other"}', "utf8");
  fs.writeFileSync(path.join(testProfile, "data", "contact_sync", "state.json"), '{"status":"blocked","account_name":"wxid_current"}', "utf8");
  fs.writeFileSync(path.join(latestProfile, "data", "active_touch", "touch_task.json"), '{"status":"paused"}', "utf8");
  fs.utimesSync(latestContacts, new Date("2026-07-13"), new Date("2026-07-13"));
  fs.utimesSync(otherAccountContacts, new Date("2026-07-14"), new Date("2026-07-14"));

  migrateLegacyRuntimeData({ appPath, userDataDir: testProfile, userHome });
  const testPaths = resolveRuntimePaths(testProfile);
  assert.equal(fs.existsSync(path.join(testPaths.activeTouchDir, "contacts.json")), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(testPaths.contactSyncDir, "state.json"), "utf8")).status, "blocked");
  assert.equal(fs.existsSync(path.join(testPaths.activeTouchDir, "touch_task.json")), false);

  console.log("runtime-data self-check passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
