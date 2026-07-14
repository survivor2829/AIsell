const path = require("node:path");
const { spawnSync } = require("node:child_process");

const desktopDir = path.resolve(__dirname, "..");
const checks = [
  "rpa/active_touch/self_check.cjs",
  "rpa/contact_sync/self_check.cjs",
  "src/main/contact-sync-ipc.self_check.cjs",
  "src/main/ai-draft.self_check.cjs",
  "src/main/deepseek-api.self_check.cjs",
  "src/main/runtime-data.self_check.cjs",
  "src/main/runtime-coordinator.self_check.cjs",
  "src/main/active-touch-dev-ipc.self_check.cjs",
  "src/main/touch-task-ipc.self_check.cjs",
  "scripts/customer-edition.self_check.cjs"
];

for (const check of checks) {
  console.log(`\n> ${check}`);
  const result = spawnSync(process.execPath, [path.join(desktopDir, check)], {
    cwd: desktopDir,
    env: process.env,
    stdio: "inherit",
    windowsHide: true
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log("\nall source self-checks passed");
