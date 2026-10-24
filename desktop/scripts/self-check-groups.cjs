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
  "src/main/business-workbench.self_check.cjs",

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
  "src/main/viral-ranking.self_check.cjs",
  "src/main/viral-scout.self_check.cjs",
  "src/main/narration-originality.self_check.cjs",
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
  // Start the longest independent state/receipt fixtures first in this pool.
  // Keep the native-capture barrier above; no assertions or checks are skipped.
  "src/main/touch-message-sequence.self_check.cjs",
  "src/main/wechat-workflow.self_check.cjs",
  "src/main/touch-task-ipc.self_check.cjs",
  "src/main/cloud-maintenance.self_check.cjs",
  "src/main/update-coordinator.self_check.cjs",
  "src/main/official-materials.self_check.cjs",
  "src/main/tutorials.self_check.cjs",
  "scripts/release-upgrade-path.self_check.cjs",
  "scripts/protocol5-install-acceptance.self_check.cjs",
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
  "src/main/touch-capture-sweep.self_check.cjs",
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
  "src/renderer/batch-draft-queue.self_check.cjs",
  "src/renderer/batch-voice-recovery.self_check.cjs",
  "src/renderer/ad-law-terms.self_check.cjs",
  "src/renderer/status-subscription.self_check.cjs",
  "src/renderer/creative-studio.self_check.cjs",
  "src/renderer/flow-funnel.self_check.cjs",
  "src/renderer/viral-pipeline.self_check.cjs",
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
  /^src\/main\/failure-evidence\.self_check\.cjs$/,
  /^scripts\/(?:update-helper\.|component-update-selftest\.|product-detail-download\.electron\.)/,
  /^scripts\/(?:artifact-retention|build-renderer|dev-electron|build-product-detail-sidecar|build-content-engine-sidecar|product-detail-release-runtime|content-engine-release-runtime|remotion-packaging|installer-release|customer-edition|internal-release|development-launcher)\.self_check\.cjs$/
];
const isExclusive = check => exclusivePatterns.some(pattern => pattern.test(check));

const groupNames = Object.freeze(["core", "moments-visual", "reply-visual", "rpa", "runtime"]);
function groupFor(check) {
  if (check === "rpa/active_touch/moments_visual.self_check.cjs") return "moments-visual";
  if (/^rpa\/active_touch\/wechat_auto_reply_visual_(?:driver|send)\.self_check\.cjs$/.test(check)) return "reply-visual";
  if (check.startsWith("rpa/")) return "rpa";
  if (check.startsWith("scripts/") && !/\/(?:run-self-checks|artifact-retention|wechat-failure-policy-review|analyze-diagnostics)/.test(check)) return "runtime";
  return "core";
}
const groups = Object.fromEntries(groupNames.map(name => [name, Object.freeze(checks.filter(check => groupFor(check) === name))]));
function checksForGroup(name) {
  if (name === undefined) return checks;
  if (!Object.hasOwn(groups, name)) throw Error("Unknown self-check group: " + name);
  return groups[name];
}
const requiredCiJobs = Object.freeze([...groupNames.map(name => "source-" + name), "source-and-renderer", "service-and-content"]);
module.exports = { checks, groups, checksForGroup, isExclusive, requiredCiJobs };
