const path = require("node:path");
const { spawn } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");

const desktopDir = path.resolve(__dirname, "..");
const checks = [
  "scripts/run-self-checks.self_check.cjs",
  "scripts/artifact-retention.self_check.cjs",
  "scripts/build-renderer.self_check.cjs",
  "scripts/dev-electron.self_check.cjs",
  "src/main/window-layout.self_check.cjs",
  "src/main/license-auth-ipc.self_check.cjs",
  "src/main/map-acquisition.self_check.cjs",
  "src/main/acquisition-workbench.self_check.cjs",
  "src/main/acquisition-account.self_check.cjs",
  "src/main/acquisition-sync.self_check.cjs",
  "src/main/business-workbench.self_check.cjs",
  "src/main/geo-workbench.self_check.cjs",
  "src/main/precise-acquisition.self_check.cjs",
  "src/main/precise-attachments.self_check.cjs",
  "src/main/precise-document-images.self_check.cjs",
  "src/main/precise-public-sources.self_check.cjs",

  "scripts/wechat-failure-policy-review.self_check.cjs",
  "scripts/wechat-failure-policy-review.cjs",
  "rpa/active_touch/wechat_window_layout.self_check.cjs",
  "rpa/active_touch/wechat_window_visual.self_check.cjs",
  "rpa/active_touch/file_helper_send.self_check.cjs",
  "rpa/active_touch/wechat_clipboard.self_check.cjs",
  "rpa/active_touch/wechat_search_observation.self_check.cjs",
  "rpa/active_touch/wechat_search_input.self_check.cjs",
  "rpa/active_touch/wechat_render_surface.self_check.cjs",
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
  "src/main/product-video.self_check.cjs",
  "src/main/bailian-video-provider.self_check.cjs",
  "src/main/product-video-media.self_check.cjs",
  "src/main/digital-human.self_check.cjs",
  "src/main/reference-human.self_check.cjs",
  "src/main/digital-human-audio.self_check.cjs",
  "src/main/voice-clone.self_check.cjs",
  "src/main/keyword-acquisition.self_check.cjs",
  "src/main/auto-reply-ipc.self_check.cjs",
  "src/main/ai-draft.self_check.cjs",
  "src/main/deepseek-api.self_check.cjs",
  "src/main/atomic-file.self_check.cjs",
  "src/main/bootstrap.self_check.cjs",
  "src/main/diagnostics.self_check.cjs",
  "src/main/task-passport.self_check.cjs",
  "src/main/failure-evidence.self_check.cjs",
  "src/main/cloud-maintenance.self_check.cjs",
  "src/main/update-coordinator.self_check.cjs",
  "src/main/official-materials.self_check.cjs",
  "src/main/tutorials.self_check.cjs",
  "scripts/release-upgrade-path.self_check.cjs",
  "scripts/update-helper.electron.self_check.cjs",
  "scripts/update-backups.self_check.cjs",
  "scripts/relocate-update-backup.self_check.cjs",
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
  "src/main/touch-message-sequence.self_check.cjs",
  "src/main/touch-capture-sweep.self_check.cjs",
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
  "src/main/content-engine-voice-preview-errors.self_check.cjs",
  "src/main/narrated-batch-ipc.self_check.cjs",
  "src/main/content-engine-download.self_check.cjs",
  "src/main/bailian-api-key.self_check.cjs",
  "src/main/content-media-protocol.self_check.cjs",
  "src/main/content-engine-desktop-integration.self_check.cjs",
  "src/renderer/creative-workspace-concurrency.self_check.cjs",
  "src/renderer/batch-draft-queue.self_check.cjs",
  "src/renderer/batch-voice-recovery.self_check.cjs",
  "src/renderer/ad-law-terms.self_check.cjs",
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
  "scripts/release-readback.self_check.cjs",
  "scripts/portable-runtime-dependencies.self_check.cjs",
  "scripts/installer-release.self_check.cjs",
  "scripts/release-capabilities.self_check.cjs",
  "scripts/customer-edition.self_check.cjs",
  "scripts/analyze-diagnostics.self_check.cjs"
];

// These checks launch Electron, replay Windows UI/clock behavior, or write
// shared build fixtures. They run with no other checks alive, not merely one
// instance of the same check. Keep the resource policy in one place.
const exclusivePatterns = [
  /^rpa\//,
  /^scripts\/(?:update-helper\.|component-update-selftest\.|product-detail-download\.electron\.)/,
  /^scripts\/(?:build-renderer|dev-electron|build-product-detail-sidecar|build-content-engine-sidecar|product-detail-release-runtime|content-engine-release-runtime|remotion-packaging|installer-release|customer-edition|internal-release|development-launcher)\.self_check\.cjs$/
];
const isExclusive = check => exclusivePatterns.some(pattern => pattern.test(check));
function checkEnvironment(check, environment = process.env) {
  // Preserve the original three business fixture groups' calendar. Windows
  // PowerShell replays use the OS clock; changing only Node's TZ breaks them.
  const chinaCalendar = /src\/main\/(?:active-touch(?:-dev)?-ipc|touch-task-ipc|wechat-workflow|moments-[^/]+|auto-reply-ipc)\.self_check\.cjs$/.test(check)
    || /^src\/renderer\/moments-[^/]+\.self_check\.cjs$/.test(check);
  let result = chinaCalendar ? { ...environment, TZ: "Asia/Shanghai" } : environment;
  if (check === "src/main/acquisition-sync.self_check.cjs" && !environment.PRECISE_TEST_PYTHON) {
    const python = environment.XIAOXI_BUILD_PYTHON || path.join(desktopDir, ".build/product-detail-venv/Scripts/python.exe");
    if (fs.existsSync(python)) result = { ...result, PRECISE_TEST_PYTHON: python };
  }
  return result;
}
function concurrencyFor(environment = process.env, cpus = os.availableParallelism()) {
  const value = environment.XIAOXI_SELF_CHECK_CONCURRENCY;
  if (value === undefined || value === "") return Math.max(1, Math.min(cpus, 6));
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 64) throw Error("Self-check concurrency must be an integer from 1 to 64");
  return Number(value);
}

function checkResult(check, result) {
  console.log(`\n> ${check}${Number.isFinite(result.durationMs) ? ` (${result.durationMs} ms)` : ""}`);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw result.error || new Error(`self-check failed: ${check} (status ${result.status})`);
  if (!result.stdout?.split(/\r?\n/u).some(line => /\bpassed\b/iu.test(line))) {
    throw new Error(`self-check exited 0 without a passed line: ${check}`);
  }
}

function executeCheck(check) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [path.join(desktopDir, check)], {
      cwd: desktopDir, env: checkEnvironment(check),
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true
    });
    const output = { stdout: [], stderr: [] };
    let bytes = 0, overflow;
    for (const name of ["stdout", "stderr"]) child[name].on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) {
        overflow ||= Error(`Self-check output exceeded 64 MiB: ${check}`);
        child.kill();
      } else output[name].push(chunk);
    });
    child.once("error", reject);
    child.once("close", status => overflow ? reject(overflow) : resolve({ status,
      durationMs: Math.round(performance.now() - started),
      stdout: Buffer.concat(output.stdout).toString(), stderr: Buffer.concat(output.stderr).toString() }));
  });
}

async function runPool(list, { concurrency = concurrencyFor(), execute = executeCheck, report = checkResult } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw Error("Invalid self-check concurrency");
  let cursor = 0, failure;
  async function worker() {
    while (!failure && cursor < list.length) {
      const check = list[cursor++];
      try { report(check, await execute(check)); }
      catch (error) { failure ||= error; }
    }
  }
  // Drain every child before rejecting; never leave test processes behind when
  // a sibling fails or start an exclusive check while a child is still alive.
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  if (failure) throw failure;
}

async function runScheduled(list, options = {}) {
  let pending = [];
  for (const check of list) {
    if (!isExclusive(check)) { pending.push(check); continue; }
    await runPool(pending, options); pending = [];
    await runPool([check], { ...options, concurrency: 1 });
  }
  await runPool(pending, options);
}

async function main() {
  console.log(`\nRunning source checks with up to ${concurrencyFor()} children; exclusive resource checks run alone.`);
  await runScheduled(checks);
  console.log("\nall source self-checks passed");
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { checks, concurrencyFor, isExclusive, runPool, runScheduled, checkResult, checkEnvironment };
