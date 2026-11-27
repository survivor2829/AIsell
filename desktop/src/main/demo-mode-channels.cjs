// 免费体验 classification of every request the main process answers (2026-11-18). Each name is in
// exactly one list; scripts/trial-channel-scan.cjs finds the names and demo-mode-guard.self_check
// fails when one is missing, so a new feature has to decide here whether the trial may use it. The
// guard also reports a registration it does not know at run time (trial_channel_unclassified).
//   READS   pass: looking at examples, lists, status, opening a finished file, stopping.
//   QUIET   refused without the advisor's card: requests a page makes on its own (when it opens or
//           while it polls) and that act — resume unknown work, reach phones, backfill covers, detect paths.
//   ACTIONS refused with the advisor's card: anything that starts work, changes or removes what the
//           customer made, brings files in, or acts on WeChat, phones or a platform.
// A name in none of the lists is refused quietly. Workbench requests (geo:invoke, map-acquisition:invoke)
// pass only for the actions in WORKBENCH_READS.
const READS = new Set([
  "ai-expert:conversation", "ai-expert:read", "ai-expert:status", "auto-reply:pause", "auto-reply:show-main",
  "auto-reply:status", "contact-sync:status", "content-engine:bailian-key-encryption", "content-engine:bailian-key-status",
  "content-engine:batch-collections", "content-engine:batch-get", "content-engine:batch-list",
  "content-engine:batch-music-preview", "content-engine:batch-open-output", "content-engine:batch-status",
  "content-engine:calculate-mix-combinations", "content-engine:cancel-task", "content-engine:generated-media-url",
  "content-engine:get-generated-video", "content-engine:get-mix-project", "content-engine:get-packaging-cost-estimate",
  "content-engine:get-task", "content-engine:list-assets", "content-engine:list-auto-mix-voice-personas",
  "content-engine:list-brand-profiles", "content-engine:list-export-packages", "content-engine:list-finished",
  "content-engine:list-generated-videos", "content-engine:list-media-reviews", "content-engine:list-media-segments",
  "content-engine:list-mix-candidates", "content-engine:list-mix-projects", "content-engine:list-music-catalog-tracks",
  "content-engine:list-packaging-presets", "content-engine:list-productions", "content-engine:list-publish-queue",
  "content-engine:list-tasks", "content-engine:open-export-package", "content-engine:open-finished",
  "content-engine:open-generated-video", "content-engine:pause-task", "content-engine:probe-asset",
  "content-engine:production-summary", "content-engine:provider-usage", "content-engine:restart", "content-engine:reveal-asset",
  "content-engine:reveal-export-package", "content-engine:reveal-finished", "content-engine:reveal-generated-video",
  "content-engine:settings-status", "content-engine:status", "content-engine:volcengine-ark-encryption",
  "content-engine:volcengine-ark-status", "content-engine:volcengine-asr-encryption", "content-engine:volcengine-asr-status",
  "content-engine:volcengine-tts-encryption", "content-engine:volcengine-tts-status", "deepseek-api:status",
  "digital-human:reference-assets", "digital-human:reference-capabilities", "digital-human:reference-cover-frame",
  "digital-human:reference-get", "digital-human:reference-list", "digital-human:reference-repackageable",
  "digital-human:reference-script-quota", "digital-human:reference-source-status", "digital-human:reference-viral-library",
  "digital-human:reference-viral-pipeline-cover", "digital-human:reference-viral-pipeline-list",
  "digital-human:reference-viral-stop", "digital-human:reference-voice-status", "digital-human:reference-workspace",
  "keyword-acquisition:status", "keyword-acquisition:stop", "moments-campaign:pause", "moments-campaign:show-main",
  "moments-campaign:status", "moments-campaign:stop", "phone-matrix:batchStatus", "phone-matrix:batchStop",
  "phone-matrix:openFolder", "phone-matrix:status", "product-detail-ai-settings:status", "product-detail:history",
  "product-detail:restart", "product-detail:start", "product-detail:status", "product-detail:stop",
  "product-video:capabilities", "product-video:get", "product-video:list", "product-video:media", "product-video:shot-media", "product-video:image-media", "social-accounts:status",
  "social-acquisition:cancelQueued", "social-acquisition:status", "social-acquisition:stop", "social-nurture:status",
  "social-nurture:stop", "social-publish:cancel", "social-publish:references", "social-publish:status", "touch-task:close-floating", "touch-task:pause",
  "touch-task:show-main", "touch-task:status", "touch-task:stop", "wechat-workflow:cancel-task", "wechat-workflow:get-task",
  "wechat-workflow:pause", "wechat-workflow:show-floating", "wechat-workflow:show-main", "wechat-workflow:sprite-dock-state",
  "wechat-workflow:sprite-drag-end", "wechat-workflow:sprite-drag-start", "wechat-workflow:sprite-interactive",
  "wechat-workflow:sprite-menu", "wechat-workflow:sprite-peek", "wechat-workflow:sprite-walk",
  "wechat-workflow:sprite-walk-stop", "wechat-workflow:status", "wechat-workflow:unreachable-list"
]);
const QUIET = new Set([
  "contact-sync:auto-detect-paths", "content-engine:backfill-covers", "phone-matrix:checkPhones", "phone-matrix:watch",
  "product-video:refresh", "social-publish:covers"
]);
const ACTIONS = new Set([
  "wechat-workflow:settle-skipped",
  "content-engine:batch-abandon",
  "ai-expert:chat", "ai-expert:choose-and-import", "ai-expert:remove", "ai-expert:save",
  "auto-reply:acknowledge-manual-followup", "auto-reply:resume-contact", "auto-reply:start", "contact-sync:capture",
  "contact-sync:choose-wechat-exe", "contact-sync:choose-wechat-root", "contact-sync:sync", "content-engine:analyze-assets",
  "content-engine:approve-auto-mix-voice-persona", "content-engine:archive-asset", "content-engine:batch-archive",
  "content-engine:batch-confirm", "content-engine:batch-continue", "content-engine:batch-edit", "content-engine:batch-export",
  "content-engine:batch-recommend", "content-engine:batch-resolve", "content-engine:batch-samples", "content-engine:batch-save",
  "content-engine:batch-save-collection", "content-engine:batch-scripts", "content-engine:batch-voice-resolve",
  "content-engine:choose-and-register-finished", "content-engine:choose-cache-directory", "content-engine:choose-files",
  "content-engine:choose-folder", "content-engine:create-mix-project", "content-engine:create-visual-comparison-task",
  "content-engine:delete-bailian-key", "content-engine:design-auto-mix-voice-persona", "content-engine:download-candidate",
  "content-engine:download-finished", "content-engine:export-candidate", "content-engine:generate-mix-candidates",
  "content-engine:import-music-catalog-track", "content-engine:import-paths", "content-engine:package-generated-videos",
  "content-engine:preflight-visual-comparison", "content-engine:preview-auto-mix-voice-persona", "content-engine:probe-pending",
  "content-engine:queue-generated-videos", "content-engine:record-media-review", "content-engine:regenerate-cover",
  "content-engine:regenerate-video", "content-engine:reject-generated-video", "content-engine:render-mix-candidate",
  "content-engine:repackage-video", "content-engine:restore-asset", "content-engine:resume-task",
  "content-engine:review-mix-candidate", "content-engine:save-bailian-key", "content-engine:save-brand-profile",
  "content-engine:save-volcengine-ark-key", "content-engine:save-volcengine-asr-credentials",
  "content-engine:save-volcengine-tts-key", "content-engine:update", "content-engine:update-asset-rights",
  "content-engine:update-cache-limit", "content-engine:update-cover-title", "content-engine:update-mix-project",
  "content-engine:update-publish-queue-item", "deepseek-api:delete", "deepseek-api:save", "deepseek-api:test",
  "digital-human:reference-confirm", "digital-human:reference-confirm-consent", "digital-human:reference-cover-generate",
  "digital-human:reference-cover-quote", "digital-human:reference-create", "digital-human:reference-import",
  "digital-human:reference-prepare", "digital-human:reference-quote", "digital-human:reference-refresh",
  "digital-human:reference-repackage", "digital-human:reference-repackage-video", "digital-human:reference-resume",
  "digital-human:reference-save-workspace", "digital-human:reference-source-connect", "digital-human:reference-source-read",
  "digital-human:reference-source-search", "digital-human:reference-speech", "digital-human:reference-train",
  "digital-human:reference-viral-library-build", "digital-human:reference-viral-library-export",
  "digital-human:reference-viral-library-publish", "digital-human:reference-viral-library-publish-token",
  "digital-human:reference-viral-library-remove", "digital-human:reference-viral-pipeline-remove",
  "digital-human:reference-viral-pipeline-retry", "digital-human:reference-viral-pipeline-start",
  "digital-human:reference-viral-pipeline-start-script", "digital-human:reference-viral-scan",
  "digital-human:reference-write-script", "keyword-acquisition:generate-draft", "keyword-acquisition:open-browser",
  "keyword-acquisition:open-conversation", "keyword-acquisition:open-source", "keyword-acquisition:refresh-account",
  "keyword-acquisition:save-conversation", "keyword-acquisition:save-lead", "keyword-acquisition:save-task",
  "keyword-acquisition:send-draft", "keyword-acquisition:start-task", "keyword-acquisition:sync-conversation",
  "moments-campaign:configure-daily", "moments-campaign:run-daily-now", "moments-campaign:start",
  "moments-publish:choose-media", "phone-matrix:batchStart", "phone-matrix:forget", "phone-matrix:input",
  "phone-matrix:pickFiles", "phone-matrix:refresh", "phone-matrix:update", "product-detail-ai-settings:delete",
  "product-detail-ai-settings:save", "product-detail-ai-settings:validate", "product-detail:download-update",
  "product-detail:update", "product-video:create", "product-video:export", "product-video:export-source",
  "product-video:import-facts", "product-video:import-image", "product-video:retry-shot", "product-video:start",
  "product-video:confirm-sheet", "product-video:redo-sheet", "product-video:redo-shot", "product-video:update-shot", "product-video:confirm-storyboard",
  "social-accounts:add", "social-accounts:login", "social-accounts:refresh", "social-accounts:remove", "social-accounts:rename",
  "social-acquisition:exportCsv", "social-acquisition:openLead", "social-acquisition:queueActions",
  "social-acquisition:removeTask", "social-acquisition:resolveAction", "social-acquisition:resume",
  "social-acquisition:saveCaps", "social-acquisition:saveTask", "social-acquisition:setLead", "social-acquisition:start",
  "social-nurture:removePlan", "social-nurture:runNow", "social-nurture:savePlan", "social-nurture:setEnabled",
  "social-publish:remove", "social-publish:removeReference", "social-publish:resolve", "social-publish:retry", "social-publish:saveReference", "social-publish:submit",
  "social-publish:submitFinished", "social-publish:suggest", "touch-task:resolve-unknown", "touch-task:resume",
  "touch-task:retry-skipped", "touch-task:start", "wechat-workflow:add-recipients", "wechat-workflow:add-task",
  "wechat-workflow:choose-touch-images", "wechat-workflow:delete-tasks", "wechat-workflow:remove-recipient", "wechat-workflow:remove-unreachable", "wechat-workflow:restore-unreachable", "wechat-workflow:stop-unreachable-delete",
  "wechat-workflow:resolve-touch-unknown", "wechat-workflow:retry-all-and-start", "wechat-workflow:retry-skipped",
  "wechat-workflow:retry-task", "wechat-workflow:set-reply-enabled", "wechat-workflow:start", "wechat-workflow:update-task"
]);
// The workbench actions that only look or stop: GEO "status"/"stop", map "status"/"pause-task".
// Every other workbench action is refused with the card.
const WORKBENCH_READS = new Set(["status", "stop", "pause-task"]);
module.exports = { READS, QUIET, ACTIONS, WORKBENCH_READS };
