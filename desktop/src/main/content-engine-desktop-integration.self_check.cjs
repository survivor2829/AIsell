const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  constants: cryptoConstants,
  generateKeyPairSync,
  privateDecrypt
} = require("node:crypto");

const { createContentEngineApi } = require("./preload-api.cjs");

const desktopDir = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(desktopDir, relativePath), "utf8");
}

async function assertPreloadContract() {
  const calls = [];
  const listeners = new Map();
  const fixtureApiKey = ["sk", "fixture-value"].join("-");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const ipcRenderer = {
    invoke: (channel, payload) => {
      calls.push({ channel, payload });
      if (channel === "content-engine:bailian-key-encryption") {
        return Promise.resolve({
          ok: true,
          data: { keyId: "fixture-key", publicKey }
        });
      }
      return Promise.resolve({ ok: true });
    },
    on: (channel, handler) => listeners.set(channel, handler),
    removeListener: (channel, handler) => {
      if (listeners.get(channel) === handler) listeners.delete(channel);
    }
  };
  const api = createContentEngineApi(ipcRenderer);
  assert.deepEqual(Object.keys(api).sort(), [
    "batch",
    "creative",
    "exportPackages",
    "finished",
    "library",
    "mix",
    "onUpdate",
    "productions",
    "publishQueue",
    "restart",
    "settings",
    "status",
    "tasks"
  ]);
  assert.deepEqual(Object.keys(api.library).sort(), [
    "archive",
    "chooseFiles",
    "chooseFolder",
    "list",
    "probe",
    "probePending",
    "reveal",
    "updateRights"
  ]);
  assert.deepEqual(Object.keys(api.tasks).sort(), [
    "cancel",
    "get",
    "list",
    "pause",
    "resume"
  ]);
  assert.deepEqual(Object.keys(api.productions).sort(), ["list", "summary", "usage"]);
  assert.deepEqual(Object.keys(api.finished).sort(), [
    "chooseAndRegister",
    "download",
    "list",
    "open",
    "reveal"
  ]);
  assert.deepEqual(Object.keys(api.settings).sort(), [
    "bailianKeyStatus",
    "chooseCacheDirectory",
    "deleteBailianKey",
    "saveBailianKey",
    "saveVolcengineArkKey",
    "saveVolcengineAsrCredentials",
    "saveVolcengineTtsKey",
    "status",
    "updateCacheLimit",
    "volcengineArkStatus",
    "volcengineAsrStatus",
    "volcengineTtsStatus"
  ]);
  assert.deepEqual(Object.keys(api.creative).sort(), [
    "analyzeAssets", "analyzeProductAssets", "approveAutoMixVoicePersona", "createAutoMixV2", "createGuidedAutoMixSupplementalImageV2", "createOneClickProject", "createVisualComparisonTask", "designAutoMixVoicePersona", "downloadCandidate", "exportCandidate",
    "generateCourseCuts", "generateGuidedAutoMixScriptV2", "generateMixBatch", "generateOneClickCandidates", "generateProductCopy", "generateProductVoice", "getAutoMixPlanV2", "getGuidedAutoMixSessionV2", "getGuidedAutoMixSupplementalImageV2",
    "getPackagingCostEstimate", "getProject", "importMusicCatalogTrack", "listAutoMixVoicePersonas", "listBrandProfiles", "listGenerated", "listMediaReviews", "listMusicCatalogTracks", "listOneClickCandidates", "listPackagingPresets",
    "listSegments", "mediaUrl", "open", "packageGeneratedVideos", "preflightVisualComparison", "prepareGuidedAutoMixV2", "previewAutoMixVoicePersona",
    "queue", "recordMediaReview", "regenerate", "regenerateAutoMixLayer", "regenerateCover", "reject", "repackageVideo", "reveal",
    "saveBrandProfile"
  ]);
  assert.deepEqual(Object.keys(api.mix).sort(), [
    "calculateCombinations", "createProject", "generateCandidates", "getProject",
    "listCandidates", "listProjects", "reviewCandidate", "updateProject"
  ]);
  assert.deepEqual(Object.keys(api.publishQueue).sort(), ["list", "update"]);
  assert.deepEqual(Object.keys(api.exportPackages).sort(), ["list", "open", "render", "reveal"]);

  api.status();
  api.restart();
  api.library.list({ includeArchived: true, limit: 25, path: "C:\\bad" });
  api.library.chooseFiles({ paths: ["C:\\bad"] });
  api.library.chooseFolder({ recursive: false, path: "C:\\bad" });
  api.library.probe({ assetId: "asset_one", path: "C:\\bad" });
  api.library.probePending({ path: "C:\\bad" });
  api.library.updateRights({
    assetId: "asset_one",
    rightsStatus: "licensed",
    path: "C:\\bad"
  });
  api.library.archive({ assetId: "asset_one", deleteOriginal: true });
  api.library.reveal({ assetId: "asset_one", path: "C:\\bad" });
  api.tasks.list({ status: "paused", limit: 10 });
  api.tasks.pause({ taskId: "task_one", status: "completed" });
  api.tasks.resume({ taskId: "task_one", status: "completed" });
  api.tasks.cancel({ taskId: "task_one", status: "completed" });
  api.finished.list({ limit: 5 });
  api.finished.chooseAndRegister({
    title: "成片",
    taskId: "task_one",
    outputPath: "C:\\bad"
  });
  api.finished.open({ finishedVideoId: "finished_one", path: "C:\\bad" });
  api.finished.reveal({ finishedVideoId: "finished_one", path: "C:\\bad" });
  api.finished.download({ finishedVideoId: "finished_one", path: "C:\\bad" });
  api.settings.status();
  api.settings.chooseCacheDirectory({ path: "C:\\bad" });
  api.settings.updateCacheLimit({ limitGb: 100, path: "C:\\bad" });
  api.settings.bailianKeyStatus();
  await api.settings.saveBailianKey({ apiKey: fixtureApiKey, path: "C:\\bad" });
  api.settings.deleteBailianKey();
  api.creative.analyzeAssets({ assetIds: ["asset_one"], path: "C:\\bad" });
  api.creative.listSegments({ assetId: "asset_one", role: "hook", limit: 20, path: "C:\\bad" });
  api.creative.generateCourseCuts({ assetId: "asset_one", minDurationMs: 30_000, maxDurationMs: 90_000, count: 5, theme: "培训现场价值", subtitleFontSize: 42, subtitleMarginBottom: 140, packagingMode: "auto", brandProfileId: "brand_one", coverMode: "ai_generate", visualRenderer: { requestedEngine: "remotion", visualStyleId: "tech_motion", requestedStyleVersion: 1, allowFallback: true, apiKey: "must-not-pass" }, path: "C:\\bad" });
  api.creative.generateMixBatch({ assetIds: ["asset_one", "asset_two"], theme: "培训现场价值", targetCount: 30, voiceAssetId: "asset_one", packagingMode: "auto", brandProfileId: "brand_one", coverMode: "ai_generate", visualRenderer: { requestedEngine: "remotion", requestedStyleVersion: 1, allowFallback: true, path: "C:\\bad" }, path: "C:\\bad" });
  api.creative.createAutoMixV2({
    specVersion: "2",
    assetIds: ["asset_one"],
    title: "产品标题",
    copyFramework: "真实素材，真实表达。",
    durationMs: 60_000,
    apiKey: "must-not-pass",
    path: "C:\\bad"
  });
  api.creative.prepareGuidedAutoMixV2({ assetIds: ["asset_one"], path: "C:\\bad" });
  api.creative.getGuidedAutoMixSessionV2({ sessionId: "guided_session_one", path: "C:\\bad" });
  api.creative.getGuidedAutoMixSupplementalImageV2({
    sessionId: "guided_session_one",
    scriptRevision: 1,
    path: "C:\\bad"
  });
  api.creative.createGuidedAutoMixSupplementalImageV2({
    sessionId: "guided_session_one",
    scriptRevision: 1,
    draftHash: "a".repeat(64),
    confirmPaidCalls: true,
    path: "C:\\bad"
  });
  api.creative.generateGuidedAutoMixScriptV2({
    sessionId: "guided_session_one",
    title: "产品标题",
    answers: {
      companyName: "示例公司",
      productName: "清洁机器人",
      targetScene: "工厂车间",
      keyMessage: "减少人工看守",
      extraNotes: "不夸大效果"
    },
    apiKey: "must-not-pass",
    path: "C:\\bad"
  });
  api.creative.getAutoMixPlanV2({
    projectId: "creative_project_one",
    apiKey: "must-not-pass",
    path: "C:\\bad"
  });
  api.creative.regenerateAutoMixLayer({
    projectId: "creative_project_one",
    expectedRunId: "auto_mix_run_11111111111111111111111111111111",
    layer: "voice",
    inputAssetIds: ["asset_should_not_be_resubmitted"],
    providerVoiceId: "must-not-pass",
    path: "C:\\bad"
  });
  api.creative.importMusicCatalogTrack({
    sourcePath: "C:\\music-canary\\licensed.wav",
    displayName: "稳健节奏",
    source: "用户授权曲库",
    commercialScope: "commercial social media",
    commercialUseAllowed: true,
    licenseStatus: "valid",
    expiresAt: null,
    credentialReference: "license-record-001",
    evidencePath: "C:\\music-canary\\license.txt",
    bpm: 104,
    moods: ["steady", "credible"],
    energy: 0.56,
    loopStartMs: null,
    loopEndMs: null,
    managedRelativePath: "must-not-pass",
    fingerprint: "must-not-pass",
    apiKey: "must-not-pass"
  });
  api.creative.listMusicCatalogTracks({
    managedRelativePath: "must-not-pass",
    apiKey: "must-not-pass"
  });
  api.creative.listAutoMixVoicePersonas({
    providerVoiceId: "provider-voice-must-not-pass",
    absolutePath: "C:\\voice-canary\\catalog.json",
    apiKey: "must-not-pass"
  });
  api.creative.designAutoMixVoicePersona({
    voicePersonaId: "natural-life@1",
    providerVoiceId: "provider-voice-must-not-pass",
    voicePrompt: "must-not-pass",
    requestId: "must-not-pass",
    apiKey: "must-not-pass"
  });
  api.creative.previewAutoMixVoicePersona({
    voicePersonaId: "natural-life@1",
    providerVoiceId: "provider-voice-must-not-pass",
    previewPath: "C:\\voice-canary\\preview.wav",
    apiKey: "must-not-pass"
  });
  api.creative.approveAutoMixVoicePersona({
    voicePersonaId: "natural-life@1",
    providerVoiceId: "provider-voice-must-not-pass",
    approvalPath: "C:\\voice-canary\\approval.json",
    apiKey: "must-not-pass"
  });
  api.creative.listPackagingPresets({ kind: "course", path: "C:\\bad" });
  api.creative.listBrandProfiles({ path: "C:\\bad" });
  api.creative.saveBrandProfile({ name: "轻品牌", primaryColor: "#5B4BFF", accentColor: "#FFD84D", fontPreset: "microsoft_yahei", outroText: "关注我们", path: "C:\\bad" });
  api.creative.getPackagingCostEstimate({ candidateIds: ["generated_video_one"], coverMode: "ai_generate", path: "C:\\bad" });
  api.creative.packageGeneratedVideos({ candidateIds: ["generated_video_one"], packagingMode: "auto", brandProfileId: "brand_one", path: "C:\\bad" });
  api.creative.repackageVideo({ candidateId: "generated_video_one", packagingMode: "preset", packagingPresetId: "knowledge_focus", brandProfileId: "brand_one", path: "C:\\bad" });
  api.creative.regenerateCover({ candidateId: "generated_video_one", path: "C:\\bad" });
  api.creative.getProject({ projectId: "creative_project_one", path: "C:\\bad" });
  api.creative.listGenerated({ projectId: "creative_project_one", limit: 30, path: "C:\\bad" });
  api.creative.regenerate({ candidateId: "generated_video_one", path: "C:\\bad" });
  api.creative.reject({ candidateId: "generated_video_one", path: "C:\\bad" });
  api.creative.queue({ candidateIds: ["generated_video_one"], channel: "internal", path: "C:\\bad" });
  api.creative.mediaUrl({ candidateId: "generated_video_one", variant: "video", path: "C:\\bad" });
  api.creative.open({ candidateId: "generated_video_one", path: "C:\\bad" });
  api.creative.downloadCandidate({ candidateId: "generated_video_one", path: "C:\\bad" });
  api.creative.reveal({ candidateId: "generated_video_one", path: "C:\\bad" });
  api.creative.preflightVisualComparison({
    candidateId: "generated_video_one",
    path: "C:\\comparison-canary",
    apiKey: "comparison-key-canary"
  });
  api.creative.createVisualComparisonTask({
    candidateId: "generated_video_one",
    directory: "C:\\comparison-canary",
    secretKey: "comparison-key-canary"
  });
  api.mix.createProject({ name: "Launch", slots: [{ name: "Intro", required: true, assetIds: ["asset_one"], path: "C:\\bad" }], constraints: { allowRepeatedAssets: false } });
  api.mix.updateProject({ projectId: "mix_project_one", name: "Launch 2", path: "C:\\bad" });
  api.mix.getProject({ projectId: "mix_project_one", path: "C:\\bad" });
  api.mix.listProjects({ limit: 12, path: "C:\\bad" });
  api.mix.calculateCombinations({ projectId: "mix_project_one", path: "C:\\bad" });
  api.mix.generateCandidates({ projectId: "mix_project_one", limit: 3, seed: "seven", path: "C:\\bad" });
  api.mix.listCandidates({ projectId: "mix_project_one", reviewStatus: "pending", limit: 4, path: "C:\\bad" });
  api.mix.reviewCandidate({ candidateId: "mix_candidate_one", reviewStatus: "approved", reviewNote: "ready", path: "C:\\bad" });
  api.publishQueue.list({ status: "queued", limit: 8, directory: "C:\\bad" });
  api.publishQueue.update({ queueItemId: "publish_queue_one", status: "processing", errorMessage: "retry", path: "C:\\bad" });
  api.exportPackages.render({ candidateId: "mix_candidate_one", platforms: ["wechat", "douyin"], path: "C:\\bad" });
  api.exportPackages.list({ candidateId: "mix_candidate_one", limit: 9, path: "C:\\bad" });
  api.exportPackages.open({ packageId: "export_package_one", path: "C:\\bad" });
  api.exportPackages.reveal({ packageId: "export_package_one", path: "C:\\bad" });

  assert.deepEqual(calls, [
    { channel: "content-engine:status", payload: undefined },
    { channel: "content-engine:restart", payload: undefined },
    {
      channel: "content-engine:list-assets",
      payload: { includeArchived: true, limit: 25 }
    },
    { channel: "content-engine:choose-files", payload: undefined },
    {
      channel: "content-engine:choose-folder",
      payload: { recursive: false }
    },
    {
      channel: "content-engine:probe-asset",
      payload: { assetId: "asset_one" }
    },
    {
      channel: "content-engine:probe-pending",
      payload: { limit: 10 }
    },
    {
      channel: "content-engine:update-asset-rights",
      payload: { assetId: "asset_one", rightsStatus: "licensed" }
    },
    {
      channel: "content-engine:archive-asset",
      payload: { assetId: "asset_one" }
    },
    {
      channel: "content-engine:reveal-asset",
      payload: { assetId: "asset_one" }
    },
    {
      channel: "content-engine:list-tasks",
      payload: { status: "paused", limit: 10 }
    },
    {
      channel: "content-engine:pause-task",
      payload: { taskId: "task_one" }
    },
    {
      channel: "content-engine:resume-task",
      payload: { taskId: "task_one" }
    },
    {
      channel: "content-engine:cancel-task",
      payload: { taskId: "task_one" }
    },
    {
      channel: "content-engine:list-finished",
      payload: { limit: 5 }
    },
    {
      channel: "content-engine:choose-and-register-finished",
      payload: { title: "成片", taskId: "task_one" }
    },
    {
      channel: "content-engine:open-finished",
      payload: { finishedVideoId: "finished_one" }
    },
    {
      channel: "content-engine:reveal-finished",
      payload: { finishedVideoId: "finished_one" }
    },
    {
      channel: "content-engine:download-finished",
      payload: { finishedVideoId: "finished_one" }
    },
    { channel: "content-engine:settings-status", payload: undefined },
    {
      channel: "content-engine:choose-cache-directory",
      payload: undefined
    },
    {
      channel: "content-engine:update-cache-limit",
      payload: { limitGb: 100 }
    },
    { channel: "content-engine:bailian-key-status", payload: undefined },
    { channel: "content-engine:bailian-key-encryption", payload: undefined },
    {
      channel: "content-engine:save-bailian-key",
      payload: calls.find(
        (call) => call.channel === "content-engine:save-bailian-key"
      ).payload
    },
    { channel: "content-engine:delete-bailian-key", payload: undefined },
    {
      channel: "content-engine:analyze-assets",
      payload: { assetIds: ["asset_one"] }
    },
    {
      channel: "content-engine:list-media-segments",
      payload: { assetId: "asset_one", role: "hook", limit: 20 }
    },
    {
      channel: "content-engine:generate-course-cuts",
      payload: { assetId: "asset_one", minDurationMs: 30_000, maxDurationMs: 90_000, count: 5, theme: "培训现场价值", subtitleFontSize: 42, subtitleMarginBottom: 140, experimentMode: "standard", subtitlePreset: "dynamic_clean", packagingMode: "auto", brandProfileId: "brand_one", coverMode: "ai_generate", visualRenderer: { requestedEngine: "remotion", visualStyleId: "tech_motion", requestedStyleVersion: 1, allowFallback: true } }
    },
    {
      channel: "content-engine:generate-mix-batch",
      payload: { assetIds: ["asset_one", "asset_two"], theme: "培训现场价值", targetCount: 30, voiceAssetId: "asset_one", packagingMode: "auto", brandProfileId: "brand_one", coverMode: "ai_generate", visualRenderer: { requestedEngine: "remotion", requestedStyleVersion: 1, allowFallback: true } }
    },
    {
      channel: "content-engine:create-auto-mix-v2",
      payload: {
        specVersion: "2",
        assetIds: ["asset_one"],
        title: "产品标题",
        copyFramework: "真实素材，真实表达。",
        clickToken: ""
      }
    },
    {
      channel: "content-engine:prepare-guided-auto-mix-v2",
      payload: { assetIds: ["asset_one"], clickToken: "" }
    },
    {
      channel: "content-engine:get-guided-auto-mix-session-v2",
      payload: { sessionId: "guided_session_one" }
    },
    {
      channel: "content-engine:get-guided-auto-mix-supplemental-image-v2",
      payload: { sessionId: "guided_session_one", scriptRevision: 1 }
    },
    {
      channel: "content-engine:create-guided-auto-mix-supplemental-image-v2",
      payload: {
        sessionId: "guided_session_one",
        scriptRevision: 1,
        draftHash: "a".repeat(64),
        confirmPaidCalls: true,
        clickToken: ""
      }
    },
    {
      channel: "content-engine:generate-guided-auto-mix-script-v2",
      payload: {
        sessionId: "guided_session_one",
        title: "产品标题",
        answers: {
          companyName: "示例公司",
          productName: "清洁机器人",
          targetScene: "工厂车间",
          keyMessage: "减少人工看守",
          extraNotes: "不夸大效果"
        },
        clickToken: ""
      }
    },
    {
      channel: "content-engine:get-auto-mix-plan-v2",
      payload: { projectId: "creative_project_one" }
    },
    {
      channel: "content-engine:regenerate-auto-mix-layer",
      payload: {
        projectId: "creative_project_one",
        expectedRunId: "auto_mix_run_11111111111111111111111111111111",
        layer: "voice",
        clickToken: ""
      }
    },
    {
      channel: "content-engine:import-music-catalog-track",
      payload: {
        displayName: "稳健节奏",
        source: "用户授权曲库",
        commercialScope: "commercial social media",
        commercialUseAllowed: true,
        licenseStatus: "valid",
        expiresAt: null,
        credentialReference: "license-record-001",
        bpm: 104,
        moods: ["steady", "credible"],
        energy: 0.56,
        loopStartMs: null,
        loopEndMs: null,
        clickToken: ""
      }
    },
    {
      channel: "content-engine:list-music-catalog-tracks",
      payload: {}
    },
    {
      channel: "content-engine:list-auto-mix-voice-personas",
      payload: {}
    },
    {
      channel: "content-engine:design-auto-mix-voice-persona",
      payload: { voicePersonaId: "natural-life@1", clickToken: "" }
    },
    {
      channel: "content-engine:preview-auto-mix-voice-persona",
      payload: { voicePersonaId: "natural-life@1", clickToken: "" }
    },
    {
      channel: "content-engine:approve-auto-mix-voice-persona",
      payload: { voicePersonaId: "natural-life@1", clickToken: "" }
    },
    { channel: "content-engine:list-packaging-presets", payload: { kind: "course" } },
    { channel: "content-engine:list-brand-profiles", payload: {} },
    {
      channel: "content-engine:save-brand-profile",
      payload: { name: "轻品牌", primaryColor: "#5B4BFF", accentColor: "#FFD84D", fontPreset: "microsoft_yahei", outroText: "关注我们" }
    },
    {
      channel: "content-engine:get-packaging-cost-estimate",
      payload: { candidateIds: ["generated_video_one"], coverMode: "ai_generate" }
    },
    {
      channel: "content-engine:package-generated-videos",
      payload: { candidateIds: ["generated_video_one"], packagingMode: "auto", brandProfileId: "brand_one", coverMode: "ai_generate", reuseCover: true }
    },
    {
      channel: "content-engine:repackage-video",
      payload: { candidateId: "generated_video_one", packagingMode: "preset", packagingPresetId: "knowledge_focus", brandProfileId: "brand_one", coverMode: "ai_generate", reuseCover: true }
    },
    {
      channel: "content-engine:regenerate-cover",
      payload: { candidateId: "generated_video_one" }
    },
    {
      channel: "content-engine:get-creative-project",
      payload: { projectId: "creative_project_one" }
    },
    {
      channel: "content-engine:list-generated-videos",
      payload: { projectId: "creative_project_one", limit: 30 }
    },
    {
      channel: "content-engine:regenerate-video",
      payload: { candidateId: "generated_video_one" }
    },
    {
      channel: "content-engine:reject-generated-video",
      payload: { candidateId: "generated_video_one" }
    },
    {
      channel: "content-engine:queue-generated-videos",
      payload: { candidateIds: ["generated_video_one"], channel: "internal" }
    },
    {
      channel: "content-engine:generated-media-url",
      payload: { candidateId: "generated_video_one", variant: "video" }
    },
    {
      channel: "content-engine:open-generated-video",
      payload: { candidateId: "generated_video_one" }
    },
    {
      channel: "content-engine:download-candidate",
      payload: { candidateId: "generated_video_one" }
    },
    {
      channel: "content-engine:reveal-generated-video",
      payload: { candidateId: "generated_video_one" }
    },
    {
      channel: "content-engine:preflight-visual-comparison",
      payload: { candidateId: "generated_video_one" }
    },
    {
      channel: "content-engine:create-visual-comparison-task",
      payload: { candidateId: "generated_video_one" }
    },
    {
      channel: "content-engine:create-mix-project",
      payload: { name: "Launch", slots: [{ name: "Intro", required: true, assetIds: ["asset_one"] }], constraints: { allowRepeatedAssets: false } }
    },
    {
      channel: "content-engine:update-mix-project",
      payload: { projectId: "mix_project_one", name: "Launch 2" }
    },
    {
      channel: "content-engine:get-mix-project",
      payload: { projectId: "mix_project_one" }
    },
    {
      channel: "content-engine:list-mix-projects",
      payload: { limit: 12 }
    },
    {
      channel: "content-engine:calculate-mix-combinations",
      payload: { projectId: "mix_project_one" }
    },
    {
      channel: "content-engine:generate-mix-candidates",
      payload: { projectId: "mix_project_one", limit: 3, seed: "seven" }
    },
    {
      channel: "content-engine:list-mix-candidates",
      payload: { projectId: "mix_project_one", reviewStatus: "pending", limit: 4 }
    },
    {
      channel: "content-engine:review-mix-candidate",
      payload: { candidateId: "mix_candidate_one", reviewStatus: "approved", reviewNote: "ready" }
    },
    {
      channel: "content-engine:list-publish-queue",
      payload: { status: "queued", limit: 8 }
    },
    {
      channel: "content-engine:update-publish-queue-item",
      payload: { queueItemId: "publish_queue_one", status: "processing", errorMessage: "retry" }
    },
    {
      channel: "content-engine:render-mix-candidate",
      payload: { candidateId: "mix_candidate_one", platforms: ["wechat", "douyin"] }
    },
    {
      channel: "content-engine:list-export-packages",
      payload: { candidateId: "mix_candidate_one", limit: 9 }
    },
    {
      channel: "content-engine:open-export-package",
      payload: { packageId: "export_package_one" }
    },
    {
      channel: "content-engine:reveal-export-package",
      payload: { packageId: "export_package_one" }
    }
  ]);
  assert.equal(JSON.stringify(calls).includes("C:\\bad"), false);
  assert.equal(JSON.stringify(calls).includes("must-not-pass"), false);
  assert.equal(JSON.stringify(calls).includes("comparison-canary"), false);
  assert.equal(JSON.stringify(calls).includes("comparison-key-canary"), false);
  assert.equal(JSON.stringify(calls).includes("provider-voice-must-not-pass"), false);
  assert.equal(JSON.stringify(calls).includes("asset_should_not_be_resubmitted"), false);
  assert.equal(JSON.stringify(calls).includes("voice-canary"), false);
  const encryptedKeyPayload = calls.find(
    (call) => call.channel === "content-engine:save-bailian-key"
  ).payload;
  assert.equal(JSON.stringify(encryptedKeyPayload).includes(fixtureApiKey), false);
  assert.deepEqual(Object.keys(encryptedKeyPayload).sort(), ["ciphertext", "keyId"]);
  assert.equal(
    privateDecrypt(
      {
        key: privateKey,
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256"
      },
      Buffer.from(encryptedKeyPayload.ciphertext, "base64")
    ).toString("utf8"),
    fixtureApiKey
  );

  const updates = [];
  const unsubscribe = api.onUpdate((payload) => updates.push(payload));
  listeners.get("content-engine:update")({}, { state: "ready" });
  assert.deepEqual(updates, [{ state: "ready" }]);
  unsubscribe();
  assert.equal(listeners.has("content-engine:update"), false);
  calls.length = 0;
  api.productions.summary();
  api.productions.list({ view: "pending", offset: 50, limit: 25 });
  api.productions.usage({ taskId: "task_one", limit: 20, apiKey: "must-not-pass" });
  api.tasks.get({ taskId: "task_one" });
  assert.deepEqual(calls, [
    { channel: "content-engine:production-summary", payload: undefined },
    { channel: "content-engine:list-productions", payload: { view: "pending", offset: 50, limit: 25 } },
    { channel: "content-engine:provider-usage", payload: { taskId: "task_one", batchId: undefined, limit: 20 } },
    { channel: "content-engine:get-task", payload: { taskId: "task_one" } }
  ]);
}

function assertPreloadExposure() {
  for (const filename of ["src/main/preload.cjs", "src/main/preload.dev.cjs"]) {
    const source = read(filename);
    assert.match(
      source,
      /exposeInMainWorld\("xiaoxiContent", apis\.content\)/,
      `${filename} must expose the same content bridge`
    );
  }
}

function assertRendererWorkflow() {
  const source = read("src/renderer/ContentFoundationPage.tsx");
  const importStart = source.indexOf("const importMedia = async");
  const importEnd = source.indexOf("const archiveAsset = async", importStart);
  assert.notEqual(importStart, -1);
  assert.notEqual(importEnd, -1);
  const importFlow = source.slice(importStart, importEnd);
  assert.equal(
    importFlow.includes("probePending"),
    false,
    "successful import must refresh without waiting for media probing"
  );
  const formatterStart = source.indexOf("function formatMediaDetails");
  const formatterEnd = source.indexOf("const TASK_STATUS_LABELS", formatterStart);
  const formatter = source.slice(formatterStart, formatterEnd);
  assert.equal(formatter.includes("PROBE_ERROR_LABELS[item.probeErrorCode"), true);
  assert.equal(
    formatter.includes('if (item.probeStatus === "unavailable") return "原文件不可用"'),
    false
  );
  assert.equal(source.includes('"consented"'), false);
  assert.match(source, /版权\/使用权状态/);
}

function assertMainLifecycle() {
  const source = read("src/main/main.cjs");
  assert.match(source, /createContentEngineSidecar/);
  assert.match(source, /registerContentEngineIpc/);
  const ipcSource = read("src/main/content-engine-ipc.cjs");
  assert.equal(ipcSource.includes("const MEDIA_FILTERS"), false);
  assert.equal(ipcSource.includes("const VIDEO_FILTERS"), false);
  assert.match(source, /XIAOXI_CONTENT_ENGINE_SIDECAR/);
  const runtimeResolver = source.match(/function contentEngineRuntimePath\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.equal(
    runtimeResolver.indexOf("app.isPackaged") < runtimeResolver.indexOf("XIAOXI_CONTENT_ENGINE_SIDECAR"),
    true,
    "packaged builds must ignore the development runtime environment override"
  );
  assert.match(
    source,
    /process\.resourcesPath[\s\S]*?"content-engine"[\s\S]*?"content-engine-worker\.exe"/
  );
  assert.match(
    source,
    /resolveDefaultDevelopmentSidecarRuntime\("content-engine"\)/
  );
  assert.match(source, /function contentEngineRuntimeArgs\(\)/);
  assert.match(source, /XIAOXI_CONTENT_ENGINE_SIDECAR_ENTRY/);
  assert.match(source, /runtimeArgs: contentEngineRuntimeArgs\(\)/);
  const remotionRuntimeResolver = source.match(/function remotionRuntimeEnvironment\(\) \{([\s\S]*?)\n\}/u)?.[1] || "";
  assert.match(remotionRuntimeResolver, /resolveRemotionRuntimeEnvironment/u);
  assert.match(remotionRuntimeResolver, /isPackaged: app\.isPackaged/u);
  const remotionRuntimeSource = read("src/main/remotion-runtime-environment.cjs");
  const packagedBranchStart = remotionRuntimeSource.indexOf("if (isPackaged)");
  const packagedBranch = remotionRuntimeSource.slice(
    packagedBranchStart,
    remotionRuntimeSource.indexOf("} else {", packagedBranchStart)
  );
  assert.match(packagedBranch, /verifyPackagedRuntime\(resourcesPath\)/u);
  assert.doesNotMatch(packagedBranch, /XIAOXI_REMOTION_(?:BUNDLE|BROWSER)_PATH/u, "packaged builds must ignore development overrides");
  assert.equal(
    remotionRuntimeSource.indexOf('"Google", "Chrome", "Application", "chrome.exe"')
      < remotionRuntimeSource.indexOf('"Microsoft", "Edge", "Application", "msedge.exe"'),
    true,
    "development must prefer the locally smoke-verified Chrome before Edge"
  );
  assert.doesNotMatch(remotionRuntimeSource, /(download|https?:\/\/)/iu, "browser selection must not probe the network or download a runtime");
  assert.match(
    remotionRuntimeSource,
    /\.build", "remotion-runtime", "development", "remotion-bundle"/u,
    "development must load the bundle produced by build:remotion-runtime"
  );
  const runtimeGateSource = read("src/main/development-sidecar-runtime.cjs");
  assert.match(
    runtimeGateSource,
    /"content-engine-runtime", "content-engine-worker\.exe"/
  );
  assert.match(
    source,
    /app\.getPath\("userData"\)[\s\S]*?"content-engine"/
  );
  assert.match(
    source,
    /contentEngineController\.start\(\)\.catch\(\(\) => undefined\)/,
    "metadata worker must start in a controlled, non-blocking way"
  );
  const createCall = source.match(
    /contentEngineController = createContentEngineSidecar\(\{([\s\S]*?)\n    \}\);/
  )?.[1] || "";
  assert.equal(
    createCall.includes("coordinator"),
    false,
    "content processing must not share the WeChat runtime coordinator"
  );
  assert.match(source, /contentEngineController\?\.dispose\(\)/);
  assert.match(source, /Promise\.allSettled\(\[/);
  assert.match(source, /cleanupTimeout/);
  assert.match(source, /contentEngineIpcRegistration\?\.dispose\(\)/);
  assert.match(ipcSource, /preflightVisualComparison: "content-engine:preflight-visual-comparison"/);
  assert.match(ipcSource, /createVisualComparisonTask: "content-engine:create-visual-comparison-task"/);
  assert.match(ipcSource, /createAutoMixV2: "content-engine:create-auto-mix-v2"/);
  assert.match(ipcSource, /prepareGuidedAutoMixV2: "content-engine:prepare-guided-auto-mix-v2"/);
  assert.match(ipcSource, /getGuidedAutoMixSessionV2: "content-engine:get-guided-auto-mix-session-v2"/);
  assert.match(ipcSource, /generateGuidedAutoMixScriptV2: "content-engine:generate-guided-auto-mix-script-v2"/);
  assert.match(ipcSource, /getGuidedAutoMixSupplementalImageV2: "content-engine:get-guided-auto-mix-supplemental-image-v2"/);
  assert.match(ipcSource, /createGuidedAutoMixSupplementalImageV2: "content-engine:create-guided-auto-mix-supplemental-image-v2"/);
  assert.match(ipcSource, /getAutoMixPlanV2: "content-engine:get-auto-mix-plan-v2"/);
  assert.match(ipcSource, /regenerateAutoMixLayer: "content-engine:regenerate-auto-mix-layer"/);
  assert.match(ipcSource, /importMusicCatalogTrack: "content-engine:import-music-catalog-track"/);
  assert.match(ipcSource, /listMusicCatalogTracks: "content-engine:list-music-catalog-tracks"/);
  assert.match(ipcSource, /listAutoMixVoicePersonas: "content-engine:list-auto-mix-voice-personas"/);
  assert.match(ipcSource, /designAutoMixVoicePersona: "content-engine:design-auto-mix-voice-persona"/);
  assert.match(ipcSource, /previewAutoMixVoicePersona: "content-engine:preview-auto-mix-voice-persona"/);
  assert.match(ipcSource, /approveAutoMixVoicePersona: "content-engine:approve-auto-mix-voice-persona"/);
  assert.match(ipcSource, /function publicAutoMixPlanV2/u);
  assert.match(ipcSource, /function publicGuidedAutoMixSession/u);
  assert.match(ipcSource, /function publicGuidedAutoMixSupplementalImage/u);
  assert.match(ipcSource, /function publicMusicCatalogTrack/u);
  assert.match(ipcSource, /function publicAutoMixVoicePersona/u);
  assert.match(ipcSource, /function publicAutoMixVoicePreview/u);
  assert.match(ipcSource, /function publicVisualComparisonPreflight/u);
  assert.match(ipcSource, /requested_engine: publicVisualEngine\(value\.requested_engine/u);
  assert.match(ipcSource, /actual_engine: publicVisualEngine\(value\.actual_engine/u);
  assert.match(ipcSource, /fallback_code: publicCode\(value\.fallback_code/u);
  assert.match(ipcSource, /comparison_group_id: opaqueId\(value\.comparison_group_id/u);
  assert.match(ipcSource, /comparison_source_candidate_id: opaqueId\(/u);
  assert.doesNotMatch(
    ipcSource.slice(
      ipcSource.indexOf("function publicGeneratedVideo"),
      ipcSource.indexOf("function publicPackagingPreset")
    ),
    /(recipe|absolute_path|output_path|thumbnail_path|api_key)/iu
  );
  assert.doesNotMatch(
    ipcSource.slice(
      ipcSource.indexOf("function publicAutoMixPlanV2"),
      ipcSource.indexOf("function publicVisualComparisonPreflight")
    ),
    /(absolute_path|output_path|api_key|provider_voice_id|credential_path)/iu
  );
  assert.doesNotMatch(
    ipcSource.slice(
      ipcSource.indexOf("function publicMusicCatalogTrack"),
      ipcSource.indexOf("function publicAutoMixMusicBrief")
    ),
    /(managed|fingerprint|credential|evidence_digest|absolute_path|api_key)/iu
  );
  assert.doesNotMatch(
    ipcSource.slice(
      ipcSource.indexOf("function publicAutoMixVoicePersona"),
      ipcSource.indexOf("function publicAutoMixLicense")
    ),
    /(provider_voice|providerVoice|voice_prompt|voicePrompt|request_id|requestId|absolute_path|absolutePath|preview_path|previewPath|api_key|apiKey)/u
  );
}

async function assertAutoMixTrustedClickBinding() {
  const originalWindow = global.window;
  const clickHandlers = [];
  const calls = [];
  try {
    global.window = {
      addEventListener: (type, handler) => {
        if (type === "click") clickHandlers.push(handler);
      }
    };
    const api = createContentEngineApi({
      invoke: (channel, payload) => {
        calls.push({ channel, payload });
        return Promise.resolve({ ok: true });
      }
    });
    const dispatchTrustedClick = (attribute) => {
      const event = {
        isTrusted: true,
        target: {
          closest: (selector) => selector.includes(`[${attribute}]`) ? {} : null
        }
      };
      clickHandlers.forEach((handler) => handler(event));
    };

    dispatchTrustedClick("data-xiaoxi-auto-mix-voice-preview");
    await api.creative.createAutoMixV2({
      specVersion: "2",
      assetIds: ["asset_one"],
      title: "产品标题",
      copyFramework: "真实素材，真实表达。"
    });
    await api.creative.previewAutoMixVoicePersona({ voicePersonaId: "natural-life@1" });
    await api.creative.previewAutoMixVoicePersona({ voicePersonaId: "natural-life@1" });

    const [crossOperationCreate, intendedPreview, replayedPreview] = calls;
    assert.equal(
      crossOperationCreate.payload.clickToken,
      "",
      "声音试听点击不得授权创建成片"
    );
    assert.match(
      intendedPreview.payload.clickToken,
      /^content-engine:preview-auto-mix-voice-persona:[a-f0-9-]{36}$/u,
      "声音试听 token 必须绑定试听 channel"
    );
    assert.equal(replayedPreview.payload.clickToken, "", "同一次试听点击只能消费一次");

    for (const [attribute, invoke, channel] of [
      [
        "data-xiaoxi-auto-mix-voice-design",
        () => api.creative.designAutoMixVoicePersona({ voicePersonaId: "natural-life@1" }),
        "content-engine:design-auto-mix-voice-persona"
      ],
      [
        "data-xiaoxi-auto-mix-create",
        () => api.creative.createAutoMixV2({
          specVersion: "2",
          assetIds: ["asset_one"],
          title: "产品标题",
          copyFramework: "真实素材，真实表达。"
        }),
        "content-engine:create-auto-mix-v2"
      ],
      [
        "data-xiaoxi-auto-mix-prepare",
        () => api.creative.prepareGuidedAutoMixV2({ assetIds: ["asset_one"] }),
        "content-engine:prepare-guided-auto-mix-v2"
      ],
      [
        "data-xiaoxi-auto-mix-script",
        () => api.creative.generateGuidedAutoMixScriptV2({
          sessionId: "guided_session_one",
          title: "产品标题",
          answers: {
            companyName: "",
            productName: "清洁机器人",
            targetScene: "",
            keyMessage: "",
            extraNotes: ""
          }
        }),
        "content-engine:generate-guided-auto-mix-script-v2"
      ],
      [
        "data-xiaoxi-auto-mix-supplemental-image",
        () => api.creative.createGuidedAutoMixSupplementalImageV2({
          sessionId: "guided_session_one",
          scriptRevision: 1,
          draftHash: "a".repeat(64),
          confirmPaidCalls: true
        }),
        "content-engine:create-guided-auto-mix-supplemental-image-v2"
      ],
      [
        "data-xiaoxi-auto-mix-regenerate",
        () => api.creative.regenerateAutoMixLayer({
          projectId: "creative_project_one",
          layer: "voice"
        }),
        "content-engine:regenerate-auto-mix-layer"
      ],
      [
        "data-xiaoxi-auto-mix-music-import",
        () => api.creative.importMusicCatalogTrack({
          displayName: "稳健节奏",
          source: "用户授权曲库",
          commercialScope: "commercial social media",
          commercialUseAllowed: true,
          licenseStatus: "valid",
          expiresAt: null,
          credentialReference: "license-record-001",
          bpm: 104,
          moods: ["steady"],
          energy: 0.56,
          loopStartMs: null,
          loopEndMs: null
        }),
        "content-engine:import-music-catalog-track"
      ],
      [
        "data-xiaoxi-auto-mix-voice-approve",
        () => api.creative.approveAutoMixVoicePersona({ voicePersonaId: "natural-life@1" }),
        "content-engine:approve-auto-mix-voice-persona"
      ]
    ]) {
      dispatchTrustedClick(attribute);
      await invoke();
      const call = calls.at(-1);
      assert.equal(call.channel, channel);
      assert.match(
        call.payload.clickToken,
        new RegExp(`^${channel}:[a-f0-9-]{36}$`, "u"),
        `${channel} token 必须绑定自身 channel`
      );
    }
  } finally {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
  }
}

async function main() {
  await assertPreloadContract();
  await assertAutoMixTrustedClickBinding();
  assertPreloadExposure();
  assertRendererWorkflow();
  assertMainLifecycle();
  console.log("content-engine desktop integration self-check passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
