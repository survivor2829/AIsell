const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const desktopDir = path.resolve(__dirname, "..");
const checks = [
  "scripts/run-self-checks.self_check.cjs",
  "scripts/artifact-retention.self_check.cjs",
  "scripts/build-renderer.self_check.cjs",
  "rpa/active_touch/wechat_window_layout.self_check.cjs",
  "rpa/active_touch/wechat_window_visual.self_check.cjs",
  "rpa/active_touch/self_check.cjs",
  "rpa/active_touch/moments_visual.self_check.cjs",
  "rpa/active_touch/moments_visual_geometry.self_check.cjs",
  "rpa/active_touch/moments_navigation.self_check.cjs",
  "rpa/active_touch/moments_publish_driver.self_check.cjs",
  "rpa/active_touch/moments_comment_readback_proof.self_check.cjs",
  "rpa/active_touch/moments_dry_run_cli.self_check.cjs",
  "rpa/active_touch/moments_action.self_check.cjs",
  "rpa/active_touch/moments_action_driver.self_check.cjs",
  "rpa/active_touch/moments_action_cli.self_check.cjs",
  "rpa/active_touch/wechat_auto_reply_driver.self_check.cjs",
  "rpa/active_touch/wechat_auto_reply_visual_driver.self_check.cjs",
  "rpa/active_touch/wechat_auto_reply_visual_send.self_check.cjs",
  "rpa/contact_sync/self_check.cjs",
  "src/main/contact-sync-ipc.self_check.cjs",
  "src/main/ai-expert.self_check.cjs",
  "src/main/auto-reply-ipc.self_check.cjs",
  "src/main/ai-draft.self_check.cjs",
  "src/main/deepseek-api.self_check.cjs",
  "src/main/atomic-file.self_check.cjs",
  "src/main/bootstrap.self_check.cjs",
  "src/main/diagnostics.self_check.cjs",
  "src/main/cloud-maintenance.self_check.cjs",
  "scripts/update-helper.electron.self_check.cjs",
  "scripts/update-helper.e2e.cjs",
  "scripts/component-update-selftest.cjs",
  "src/main/feedback.self_check.cjs",
  "src/main/role-preferences.self_check.cjs",
  "src/main/diagnostics-ipc.self_check.cjs",
  "src/main/runtime-data.self_check.cjs",
  "src/main/runtime-coordinator.self_check.cjs",
  "src/main/active-touch-ipc.self_check.cjs",
  "src/main/active-touch-dev-ipc.self_check.cjs",
  "src/main/moments-campaign-ipc.self_check.cjs",
  "src/main/moments-publish-ipc.self_check.cjs",
  "src/main/moments-daily-automation.self_check.cjs",
  "src/main/touch-task-ipc.self_check.cjs",
  "src/main/wechat-workflow.self_check.cjs",
  "src/main/development-sidecar-runtime.self_check.cjs",
  "src/main/product-detail-sidecar.self_check.cjs",
  "src/main/product-detail-ipc.self_check.cjs",
  "src/main/product-detail-release-smoke.self_check.cjs",
  "src/main/product-detail-ai-settings.self_check.cjs",
  "src/main/product-detail-download.self_check.cjs",
  "src/main/product-detail-desktop-integration.self_check.cjs",
  "src/main/content-engine-sidecar.self_check.cjs",
  "src/main/remotion-runtime-environment.self_check.cjs",
  "src/main/content-engine-ipc.self_check.cjs",
  "src/main/content-engine-download.self_check.cjs",
  "src/main/bailian-api-key.self_check.cjs",
  "src/main/content-media-protocol.self_check.cjs",
  "src/main/content-engine-desktop-integration.self_check.cjs",
  "src/renderer/creative-workspace-concurrency.self_check.cjs",
  "src/renderer/status-subscription.self_check.cjs",
  "src/renderer/creative-workspace.self_check.cjs",
  "src/renderer/creative-studio.self_check.cjs",
  "src/renderer/product-one-click.self_check.cjs",
  "scripts/remotion-packaging.self_check.cjs",
  "src/renderer/moments-campaign-panel.self_check.cjs",
  "src/renderer/moments-publish-panel.self_check.cjs",
  "src/renderer/moments-dry-run-panel.self_check.cjs",
  "scripts/build-product-detail-sidecar.self_check.cjs",
  "scripts/development-launcher.self_check.cjs",
  "scripts/product-detail-download.electron.self_check.cjs",
  "scripts/product-detail-release-runtime.self_check.cjs",
  "scripts/build-content-engine-sidecar.self_check.cjs",
  "scripts/content-engine-release-runtime.self_check.cjs",
  "scripts/release-runtime-cache.self_check.cjs",
  "scripts/internal-release.self_check.cjs",
  "scripts/portable-runtime-dependencies.self_check.cjs",
  "scripts/installer-release.self_check.cjs",
  "scripts/release-capabilities.self_check.cjs",
  "scripts/customer-edition.self_check.cjs"
];

const groupDefinitions = [
  {
    name: "active-touch",
    matches: check => /src\/main\/(?:active-touch(?:-dev)?-ipc|touch-task-ipc|wechat-workflow)\.self_check\.cjs$/u.test(check)
  },
  {
    name: "moments",
    matches: check => /src\/(?:main|renderer)\/moments-[^/]+\.self_check\.cjs$/u.test(check)
  },
  {
    name: "auto-reply",
    matches: check => check === "src/main/auto-reply-ipc.self_check.cjs"
  }
];
const parallelCheckGroups = groupDefinitions.map(group => ({
  name: group.name,
  checks: checks.filter(group.matches)
}));
const groupedChecks = new Set(parallelCheckGroups.flatMap(group => group.checks));
const serialChecks = checks.filter(check => !groupedChecks.has(check));

function runChecks(list) {
  for (const check of list) {
    console.log(`\n> ${check}`);
    const result = spawnSync(process.execPath, [path.join(desktopDir, check)], {
      cwd: desktopDir,
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}

function runParallelGroup(group) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, `--group=${group.name}`], {
      cwd: desktopDir,
      env: process.env,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${group.name} self-checks failed with status ${code}`)));
  });
}

async function main(args = process.argv.slice(2)) {
  const requestedGroup = args.find(arg => arg.startsWith("--group="))?.slice("--group=".length);
  if (requestedGroup) {
    const group = parallelCheckGroups.find(item => item.name === requestedGroup);
    if (!group) throw new Error(`Unknown self-check group: ${requestedGroup}`);
    runChecks(group.checks);
    return;
  }
  console.log("\nRunning isolated active-touch, moments and auto-reply self-check groups in parallel.");
  await Promise.all(parallelCheckGroups.map(runParallelGroup));
  runChecks(serialChecks);
  console.log("\nall source self-checks passed");
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parallelCheckGroups, serialChecks };
