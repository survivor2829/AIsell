const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { constants: cryptoConstants, publicEncrypt } = require("node:crypto");

const {
  CONTENT_ENGINE_CHANNELS,
  publicError,
  registerContentEngineIpc,
  stripPrivateValue
} = require("./content-engine-ipc.cjs");

function autoMixClickToken(channel, uuid) {
  return `${channel}:${uuid}`;
}

function asset(overrides = {}) {
  return {
    asset_id: "asset_11111111111111111111111111111111",
    display_name: "课程录像.mp4",
    media_kind: "video",
    extension: ".mp4",
    size_bytes: 1234,
    rights_status: "unknown",
    probe_status: "ok",
    duration_ms: 12_345,
    width: 1080,
    height: 1920,
    fps: 25,
    has_audio: true,
    probe_error_code: null,
    probed_at: "2026-07-30T00:01:00.000Z",
    archived: false,
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    location_count: 1,
    available_location_count: 1,
    absolute_path: "C:\\must-not-leak\\课程录像.mp4",
    ...overrides
  };
}

function task(overrides = {}) {
  return {
    task_id: "task_22222222222222222222222222222222",
    task_type: "asset_index",
    status: "paused",
    resume_from_status: "analyzing",
    progress: 0.5,
    error_code: "C:\\must-not-leak\\error-code",
    error_message: "任务已暂停：C:\\must-not-leak\\素材.mp4",
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
    ...overrides
  };
}

function finished(overrides = {}) {
  return {
    finished_video_id: "finished_33333333333333333333333333333333",
    task_id: null,
    display_name: "成片.mp4",
    title: "课程重点",
    size_bytes: 4321,
    metadata: {
      duration: 58,
      source_path: "C:\\must-not-leak\\成片.mp4",
      note: "saved at C:\\must-not-leak\\成片.mp4"
    },
    available: true,
    created_at: "2026-07-30T00:00:00.000Z",
    ...overrides
  };
}

const mixProjectId = "mix_project_44444444444444444444444444444444";
const mixCandidateId = "mix_candidate_55555555555555555555555555555555";
const publishQueueId = "publish_queue_66666666666666666666666666666666";
const exportPackageId = "export_package_88888888888888888888888888888888";
const generatedVideoId = "generated_video_99999999999999999999999999999999";
const regenerationTaskId = "task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const packagingTaskId = "task_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const comparisonTaskId = "task_dddddddddddddddddddddddddddddddd";
const brandProfileId = "brand_profile_cccccccccccccccccccccccccccccccc";
const creativeProjectId = "creative_project_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const autoMixRunId = "auto_mix_run_ffffffffffffffffffffffffffffffff";
const parentAutoMixRunId = "auto_mix_run_0123456789abcdef0123456789abcdef";
const guidedAnalysisTaskId = "task_01010101010101010101010101010101";
const staleGuidedSessionId = "guided_auto_mix_session_02020202020202020202020202020202";
const liveGuidedSessionId = "guided_auto_mix_session_03030303030303030303030303030303";
const autoMixInputAssetIds = Object.freeze([
  "asset_11111111111111111111111111111111",
  "asset_22222222222222222222222222222222",
  "asset_33333333333333333333333333333333",
  "asset_44444444444444444444444444444444",
  "asset_55555555555555555555555555555555"
]);
const autoMixSelectedAssetIds = autoMixInputAssetIds.slice(0, 3);

function autoMixPlan(overrides = {}) {
  return {
    specVersion: "2",
    runId: autoMixRunId,
    projectId: creativeProjectId,
    taskId: task().task_id,
    parentRunId: null,
    generation: 1,
    state: "selecting_music",
    usableMaterialDurationMs: 32_000,
    estimatedDurationRangeMs: { min: 18_000, max: 32_000 },
    selectedDurationMs: 24_000,
    inputAssetIds: [
      ...autoMixInputAssetIds,
      "C:\\must-not-leak\\input.mp4",
      null,
      autoMixInputAssetIds[0]
    ],
    selectedSegments: autoMixSelectedAssetIds.map((assetId, index) => ({
      segmentId: `segment-${index + 1}`,
      assetId,
      mediaKind: "video",
      sourceStartMs: 1_000 + index * 6_000,
      sourceEndMs: 7_000 + index * 6_000,
      timelineStartMs: index * 6_000,
      timelineEndMs: (index + 1) * 6_000,
      targetDurationMs: 6_000,
      role: "hook",
      sourceTag: "产品近景",
      qualityScore: 0.92,
      absolutePath: "C:\\must-not-leak\\clip.mp4"
    })),
    spokenPhrases: [{
      phraseId: "phrase-1",
      text: "真实素材，真实表达。",
      evidenceRefs: ["copyFramework"],
      apiKey: "must-not-leak-key"
    }],
    speechCaptions: [{
      captionId: "phrase-1",
      startMs: 0,
      endMs: 2_400,
      text: "真实素材，真实表达。",
      captionSource: "tts_voiceover",
      timing: "audio_measured",
      sourcePath: "C:\\must-not-leak\\voice.wav"
    }],
    visualTextItems: [{
      textItemId: "visual-hook",
      type: "hook",
      text: "产品标题",
      startMs: 0,
      endMs: 6_000,
      absolutePath: "C:\\must-not-leak\\font.ttf"
    }],
    voicePersona: {
      voicePersonaId: "natural-life@1",
      displayName: "自然生活",
      catalogVersion: "2026.08",
      category: "natural",
      approvalStatus: "approved",
      provider: "bailian",
      providerVoiceId: "must-not-leak-voice-id"
    },
    music: {
      trackId: "music-track-1",
      displayName: "轻快生活",
      source: "用户授权曲库",
      licenseSummary: {
        status: "valid",
        commercialScope: "commercial",
        commercialUseAllowed: true,
        expiresAt: "2027-08-24T00:00:00Z",
        evidencePresent: true,
        credentialPath: "C:\\must-not-leak\\license.pdf"
      },
      bpm: 104,
      moods: ["steady", "credible"],
      energy: 0.56,
      selectionScore: 93.5,
      absolutePath: "C:\\must-not-leak\\music.wav"
    },
    musicBrief: {
      moods: ["steady"],
      targetEnergy: 0.56,
      bpmRange: [92, 116],
      instrumentPreferences: ["light_drums"],
      transitionPointsMs: [6_000],
      introDelayMs: 900,
      energyCurve: [{ position: 0, energy: 0.44 }]
    },
    qualityWarnings: [{
      code: "license_review",
      message: "检查授权 api_key=secret-value-123",
      layer: "music"
    }],
    qualityReport: {
      passed: true,
      integratedLufs: -15,
      truePeakDbtp: -1.2,
      speechMusicMarginLu: 10,
      rawReportPath: "C:\\must-not-leak\\report.json"
    },
    generatedVideoId,
    outputCount: 300,
    cache: {
      inputHash: "a".repeat(64),
      reusedStages: ["analysis"],
      analysisReused: true,
      artifactPath: "C:\\must-not-leak\\cache"
    },
    attention: {
      code: "music_required",
      message: "需要授权音乐 sk-secret-value-123",
      layer: "music"
    },
    apiKey: "must-not-leak-key",
    ...overrides
  };
}

function musicCatalogTrack(overrides = {}) {
  return {
    trackId: "music_track_1234567890abcdef1234567890abcdef",
    displayName: "稳健节奏",
    source: "用户授权曲库",
      licenseSummary: {
        status: "valid",
        commercialScope: "commercial social media",
        commercialUseAllowed: true,
      expiresAt: null,
      evidencePresent: true,
      credentialReference: "must-not-leak-license-reference",
      evidenceDigest: "must-not-leak-evidence-digest"
    },
    durationMs: 30_000,
    bpm: 104,
    moods: ["steady", "credible"],
    energy: 0.56,
    integratedLufs: -18,
    truePeakDbtp: -2.1,
    loop: { startMs: 2_000, endMs: 28_000 },
    analysisStatus: "ready",
    analysisErrorCode: null,
    managedRelativePath: "music-catalog/must-not-leak.wav",
    fingerprint: "must-not-leak-fingerprint",
    credentialReference: "must-not-leak-license-reference",
    evidenceDigest: "must-not-leak-evidence-digest",
    absolutePath: "C:\\must-not-leak\\licensed.wav",
    apiKey: "must-not-leak-key",
    ...overrides
  };
}

function autoMixVoicePersona(overrides = {}) {
  return {
    voicePersonaId: "natural-life@1",
    displayName: "自然生活",
    catalogVersion: "2026.08",
    category: "natural",
    approvalStatus: "pending",
    provisioningStatus: "ready",
    previewStatus: "completed",
    provider: "bailian",
    providerVoiceId: "must-not-leak-voice-id",
    previewPath: "C:\\must-not-leak\\voice-preview.wav",
    apiKey: "must-not-leak-key",
    ...overrides
  };
}

function testWavDataUrl() {
  const wav = Buffer.alloc(44);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  return `data:audio/wav;base64,${wav.toString("base64")}`;
}

function autoMixVoicePreview(overrides = {}) {
  return {
    voicePersona: autoMixVoicePersona(),
    previewStatus: "completed",
    audioDataUrl: testWavDataUrl(),
    cacheHit: true,
    providerVoiceId: "must-not-leak-voice-id",
    previewPath: "C:\\must-not-leak\\voice-preview.wav",
    ...overrides
  };
}

function generatedVideo(overrides = {}) {
  return {
    generated_video_id: generatedVideoId,
    project_id: "creative_project_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    task_id: comparisonTaskId,
    kind: "course",
    status: "completed",
    generation: 2,
    selection_signature: "opaque-selection",
    title: "课程重点",
    duration_ms: 60_000,
    recommended: false,
    score: { total: 90 },
    preview_ready: true,
    thumbnail_ready: true,
    packaging_preset_id: "knowledge_focus",
    packaging_preset_name: "知识观点",
    packaging_version: 1,
    brand_profile_id: null,
    cover_status: "outcome_unknown",
    cover_phase: "outcome_unknown",
    cover_network_submitted: true,
    cover_issue_code: "poll_outcome_unknown",
    motion_director_provider: "bailian",
    motion_event_count: 3,
    requested_engine: "remotion",
    requested_style_id: "social_pop",
    requested_style_version: 1,
    actual_engine: "ffmpeg",
    actual_style_version: null,
    fallback_code: "browser_unavailable",
    comparison_group_id: comparisonTaskId,
    comparison_source_candidate_id: generatedVideoId,
    remotion_packaging_capable: false,
    visual_comparison_capable: false,
    visual_renderer_legacy: false,
    source_asset_count: 2,
    shot_count: 6,
    caption_source: "tts_voiceover",
    output_path: "C:\\must-not-leak\\candidate.mp4",
    recipe_json: { api_key: "must-not-leak-key" },
    created_at: "2026-08-15T00:00:00Z",
    updated_at: "2026-08-15T00:01:00Z",
    ...overrides
  };
}

function mixProject() {
  return {
    project_id: mixProjectId,
    name: "Launch",
    constraints: {
      allow_repeated_assets: false,
      min_duration_ms: 1000,
      max_duration_ms: 5000,
      score_weights: { duration_fit: 0.6, diversity: 0.25, freshness: 0.15 },
      output_directory: "C:\\must-not-leak"
    },
    slots: [{
      slot_id: "scene_slot_77777777777777777777777777777777",
      name: "Intro",
      position: 0,
      required: true,
      asset_ids: [asset().asset_id],
      fixed_asset_id: null,
      min_duration_ms: null,
      max_duration_ms: 3000,
      absolute_path: "C:\\must-not-leak\\intro.mp4"
    }],
    created_at: "2026-08-10T00:00:00Z",
    updated_at: "2026-08-10T00:01:00Z",
    absolute_path: "C:\\must-not-leak\\project.json"
  };
}

function mixCandidate() {
  return {
    candidate_id: mixCandidateId,
    project_id: mixProjectId,
    seed: "campaign-7",
    selection_signature: "safe-signature",
    selections: [{ slot_id: "scene_slot_77777777777777777777777777777777", slot_name: "Intro", asset_id: asset().asset_id, omitted: false, source_path: "C:\\must-not-leak" }],
    duration_ms: 1234,
    score: { total: 91, duration_fit: 1, weighted_components: { duration_fit: 60 }, explanations: ["safe", "C:\\must-not-leak\\clip.mp4"] },
    review_status: "pending",
    review_note: null,
    created_at: "2026-08-10T00:00:00Z",
    updated_at: "2026-08-10T00:01:00Z",
    render_directory: "C:\\must-not-leak"
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-content-engine-ipc-"));
  const sourceFile = path.join(root, "课程录像.mp4");
  const finishedFile = path.join(root, "成片.mp4");
  const musicFile = path.join(root, "licensed.wav");
  const musicEvidenceFile = path.join(root, "license-proof.txt");
  const oversizedMusicFile = path.join(root, "oversized.wav");
  const oversizedMusicEvidenceFile = path.join(root, "oversized-license-proof.txt");
  const exportDirectory = path.join(root, "export-package");
  fs.writeFileSync(sourceFile, "video");
  fs.writeFileSync(finishedFile, "finished");
  fs.writeFileSync(musicFile, "audio");
  fs.writeFileSync(musicEvidenceFile, "commercial license");
  fs.writeFileSync(oversizedMusicFile, "");
  fs.truncateSync(oversizedMusicFile, (512 * 1024 * 1024) + 1);
  fs.writeFileSync(oversizedMusicEvidenceFile, "");
  fs.truncateSync(oversizedMusicEvidenceFile, (32 * 1024 * 1024) + 1);
  fs.mkdirSync(exportDirectory);

  try {
    const handlers = new Map();
    const sent = [];
    const calls = [];
    const shown = [];
    const opened = [];
    const diagnosticOperations = [];
    const diagnosticEvents = [];
    const diagnosticRecoveries = [];
    const diagnosticLogger = {
      begin: (area, operation) => {
        const entry = { area, operation, endings: [] };
        diagnosticOperations.push(entry);
        return {
          end: (...args) => entry.endings.push(args)
        };
      },
      event: (...args) => diagnosticEvents.push(args),
      recover: (...args) => diagnosticRecoveries.push(args)
    };
    let listedTaskItems = [task()];
    let updateListener = null;
    let unsubscribed = false;
    let storedBailianKey = "";
    const bailianKeyStore = {
      status: () => ({
        configured: Boolean(storedBailianKey),
        maskedKey: storedBailianKey ? "sk-***" : "",
        apiHost: "",
        secureStorageAvailable: true,
        code: ""
      }),
      write: (value) => {
        storedBailianKey = value;
        return bailianKeyStore.status();
      },
      clear: () => {
        storedBailianKey = "";
        return bailianKeyStore.status();
      }
    };
    const dialogQueue = [
      { canceled: false, filePaths: [sourceFile] },
      { canceled: false, filePaths: [root] },
      { canceled: false, filePaths: [finishedFile] },
      { canceled: false, filePaths: [root] }
    ];
    const ipcMain = {
      handle: (channel, handler) => handlers.set(channel, handler)
    };
    const controller = {
      status: () => ({
        state: "ready",
        available: true,
        version: "0.1.0",
        protocolVersion: 1,
        capabilities: { asset_index: true },
        code: "",
        runtimePath: "C:\\must-not-leak\\worker.exe"
      }),
      restart: async () => {
        calls.push(["restart"]);
        return {
          state: "ready",
          available: true,
          version: "0.1.0",
          protocolVersion: 1,
          capabilities: { asset_index: true },
          code: "",
          runtimePath: "C:\\must-not-leak\\worker.exe"
        };
      },
      listAssets: async (payload) => {
        calls.push(["listAssets", payload]);
        return { items: [asset()] };
      },
      importFiles: async (paths) => {
        calls.push(["importFiles", paths]);
        return {
          items: [asset()],
          created_assets: 1,
          created_locations: 1,
          skipped_count: 0,
          skipped: []
        };
      },
      importFolder: async (folderPath, recursive) => {
        calls.push(["importFolder", folderPath, recursive]);
        return {
          items: [asset()],
          created_assets: 0,
          created_locations: 0,
          skipped_count: 0,
          skipped: []
        };
      },
      probeAsset: async (assetId) => {
        calls.push(["probeAsset", assetId]);
        return asset({ asset_id: assetId });
      },
      probePending: async (limit) => {
        calls.push(["probePending", limit]);
        return {
          items: [asset()],
          processed_count: 1,
          remaining_count: 2
        };
      },
      updateAssetRights: async (assetId, rightsStatus) => {
        calls.push(["updateAssetRights", assetId, rightsStatus]);
        return asset({ asset_id: assetId, rights_status: rightsStatus });
      },
      archiveAsset: async (assetId) => {
        calls.push(["archiveAsset", assetId]);
        return asset({ archived: true });
      },
      resolveAssetPath: async (assetId) => {
        calls.push(["resolveAssetPath", assetId]);
        return { asset_id: assetId, absolute_path: sourceFile, available: true };
      },
      listTasks: async (payload) => {
        calls.push(["listTasks", payload]);
        return { items: listedTaskItems };
      },
      pauseTask: async (taskId) => task({ task_id: taskId }),
      resumeTask: async (taskId) => task({
        task_id: taskId,
        status: "analyzing",
        resume_from_status: null
      }),
      cancelTask: async (taskId) => task({
        task_id: taskId,
        status: "cancelled",
        resume_from_status: null
      }),
      listFinished: async (limit) => {
        calls.push(["listFinished", limit]);
        return { items: [finished()] };
      },
      registerFinished: async (outputPath, options) => {
        calls.push(["registerFinished", outputPath, options]);
        return finished();
      },
      resolveFinishedPath: async (finishedVideoId) => {
        calls.push(["resolveFinishedPath", finishedVideoId]);
        return {
          finished_video_id: finishedVideoId,
          absolute_path: finishedFile,
          available: true
        };
      },
      getSetting: async (key, defaultValue) => ({
        key,
        value: key === "cache_directory"
          ? "[redacted path]"
          : key === "cache_directory_label"
            ? path.basename(root)
            : key === "cache_configured"
              ? true
              : defaultValue
      }),
      setSetting: async (key, value) => {
        calls.push(["setSetting", key, value]);
        return { key, value };
      },
      generateCourseCuts: async (assetId, options) => {
        calls.push(["generateCourseCuts", assetId, options]);
        return {
          task_id: task().task_id,
          project_id: "creative_project_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        };
      },
      generateMixBatch: async (assetIds, options) => {
        calls.push(["generateMixBatch", assetIds, options]);
        return {
          task_id: task().task_id,
          project_id: creativeProjectId
        };
      },
      createOneClickProject: async (name, assetIds, options) => {
        calls.push(["createOneClickProject", name, assetIds, options]);
        return {
          project_id: creativeProjectId,
          workflow: "product_one_click",
          name,
          status: "draft",
          target_count: options.target_count,
          generated_count: 0,
          product_asset_count: assetIds.length
        };
      },
      createAutoMixV2: async (input) => {
        calls.push(["createAutoMixV2", input]);
        return autoMixPlan({ state: "analyzing" });
      },
      getGuidedAutoMixSessionV2: async (input) => {
        calls.push(["getGuidedAutoMixSessionV2", input]);
        return {
          session_id: liveGuidedSessionId,
          status: "ready_for_answers",
          asset_ids: [asset().asset_id],
          analysis_task: task({ task_id: guidedAnalysisTaskId, task_type: "guided_auto_mix_analysis" }),
          draft_task: null,
          analysis: {
            usable_material_duration_ms: 18_000,
            selected_duration_ms: 18_000,
            selected_segment_count: 1,
            material_facts: [{ text: "机器人、清洁、室内", kind: "visual" }]
          },
          answers: {},
          prefill: {
            title: "室内清洁机器人展示",
            answers: { productName: "清洁机器人" }
          },
          draft: { revision: 0 }
        };
      },
      generateGuidedAutoMixScriptV2: async (input) => {
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw Object.assign(new Error("guided script input must be an object"), {
            code: "invalid_guided_auto_mix_input"
          });
        }
        const { sessionId, title, answers } = input;
        calls.push(["generateGuidedAutoMixScriptV2", input]);
        return {
          session_id: sessionId,
          status: "drafting",
          asset_ids: [asset().asset_id],
          analysis_task: task({ task_id: guidedAnalysisTaskId, task_type: "guided_auto_mix_analysis" }),
          draft_task: task({ task_type: "guided_auto_mix_draft", status: "queued" }),
          analysis: {},
          answers,
          prefill: { title: "室内清洁机器人展示", answers: { productName: "清洁机器人" } },
          draft: { revision: 0 }
        };
      },
      getAutoMixPlanV2: async (options) => {
        calls.push(["getAutoMixPlanV2", options]);
        return autoMixPlan();
      },
      regenerateAutoMixLayer: async (projectId, layer, expectedRunId) => {
        calls.push(["regenerateAutoMixLayer", projectId, layer, expectedRunId]);
        return autoMixPlan({
          parentRunId: parentAutoMixRunId,
          generation: 2,
          state: "synthesizing"
        });
      },
      importMusicCatalogTrack: async (input) => {
        calls.push(["importMusicCatalogTrack", input]);
        return musicCatalogTrack();
      },
      listMusicCatalogTracks: async () => {
        calls.push(["listMusicCatalogTracks"]);
        return { items: [musicCatalogTrack()] };
      },
      listAutoMixVoicePersonas: async () => {
        calls.push(["listAutoMixVoicePersonas"]);
        return { items: [autoMixVoicePersona()] };
      },
      designAutoMixVoicePersona: async (voicePersonaId) => {
        calls.push(["designAutoMixVoicePersona", voicePersonaId]);
        return autoMixVoicePersona({
          voicePersonaId,
          provisioningStatus: "ready"
        });
      },
      previewAutoMixVoicePersona: async (voicePersonaId) => {
        calls.push(["previewAutoMixVoicePersona", voicePersonaId]);
        return autoMixVoicePreview({
          voicePersona: autoMixVoicePersona({ voicePersonaId })
        });
      },
      approveAutoMixVoicePersona: async (voicePersonaId) => {
        calls.push(["approveAutoMixVoicePersona", voicePersonaId]);
        return autoMixVoicePersona({
          voicePersonaId,
          approvalStatus: "approved"
        });
      },
      getCreativeProject: async (projectId) => ({
        project_id: projectId,
        workflow: "product_one_click",
        name: "商品测试",
        status: "draft",
        target_count: 1,
        generated_count: 0,
        product_asset_count: 1,
        voice_status: "pending",
        voice_mode: "tts",
        voice_metadata: {
          provider: "bailian",
          status: "pending",
          reason: "source_speech_below_threshold",
          source_coverage: 0.12,
          absolute_path: "C:\\must-not-leak\\voice.wav"
        },
        audio_strategy: {
          recognized_speech_ms: 7_200,
          source_media_ms: 60_000,
          source_coverage: 0.12,
          source_coverage_threshold: 0.7,
          recognized_asset_count: 1,
          unknown_audio_count: 4,
          reason: "source_speech_below_threshold",
          source_audio_policy: "duck"
        },
        analysis_context: {
          stage: "asset_analysis",
          asset_id: asset().asset_id,
          asset_name: "清洁机器人.mp4",
          index: 1,
          total: 5,
          local_path: "C:\\must-not-leak\\robot.mp4"
        },
        analysis_skipped_assets: [{
          asset_id: asset().asset_id,
          asset_name: "片段.mp4",
          stage: "asset_analysis",
          error_code: "cloud_transcription_failed",
          error_message: "识别失败",
          source_path: "C:\\must-not-leak\\clip.mp4"
        }]
      }),
      analyzeProductAssets: async (projectId) => {
        calls.push(["analyzeProductAssets", projectId]);
        return task({ task_type: "product_asset_analysis", project_id: projectId });
      },
      generateProductCopy: async (projectId, brief) => {
        calls.push(["generateProductCopy", projectId, brief]);
        return task({ task_type: "product_copy", project_id: projectId });
      },
      generateProductVoice: async (projectId, scriptId) => {
        calls.push(["generateProductVoice", projectId, scriptId]);
        return task({ task_type: "product_voice", project_id: projectId });
      },
      generateOneClickCandidates: async (projectId, options) => {
        calls.push(["generateOneClickCandidates", projectId, options]);
        return task({ task_type: "product_generation", project_id: projectId });
      },
      listOneClickCandidates: async (projectId, limit) => {
        calls.push(["listOneClickCandidates", projectId, limit]);
        return { items: [generatedVideo({ project_id: projectId })] };
      },
      regenerateVideo: async (candidateId) => {
        calls.push(["regenerateVideo", candidateId]);
        return {
          task_id: regenerationTaskId,
          generated_video_id: generatedVideoId,
          status: "queued",
          absolute_path: "C:\\must-not-leak\\candidate.mp4"
        };
      },
      listPackagingPresets: async (kind) => {
        calls.push(["listPackagingPresets", kind]);
        return { items: [{
        preset_id: kind === "course" ? "knowledge_focus" : "hook_impact",
        version: 1,
        kind,
        display_name: "知识观点",
        subtitle: { preset: "knowledge_course" },
        effects: { title_card: true },
        audio: { profile: "course_clean" },
        cover: { layout: "portrait_title" },
        absolute_path: "C:\\must-not-leak\\preset.json"
        }] };
      },
      listBrandProfiles: async () => ({ items: [{
        brand_profile_id: brandProfileId,
        name: "轻品牌",
        logo_asset_id: asset().asset_id,
        reference_portrait_asset_id: null,
        primary_color: "#5B4BFF",
        accent_color: "#FFD84D",
        font_preset: "microsoft_yahei",
        outro_text: "关注我们",
        created_at: "2026-08-14T00:00:00Z",
        updated_at: "2026-08-14T00:00:00Z",
        source_path: "C:\\must-not-leak\\brand.json"
      }] }),
      saveBrandProfile: async (profile) => {
        calls.push(["saveBrandProfile", profile]);
        return {
          ...profile,
          brand_profile_id: brandProfileId,
          created_at: "2026-08-14T00:00:00Z",
          updated_at: "2026-08-14T00:00:00Z"
        };
      },
      getPackagingCostEstimate: async (candidateIds, coverMode, plannedCount) => {
        calls.push(["getPackagingCostEstimate", candidateIds, coverMode, plannedCount]);
        return {
          estimated_image_calls: coverMode === "ai_generate"
            ? (plannedCount ?? candidateIds.length)
            : 0,
          provider_configured: true
        };
      },
      packageGeneratedVideos: async (candidateIds, options) => {
        calls.push(["packageGeneratedVideos", candidateIds, options]);
        return task({ task_id: packagingTaskId, task_type: "creative_packaging", status: "queued" });
      },
      repackageVideo: async (candidateId, options) => {
        calls.push(["repackageVideo", candidateId, options]);
        return task({ task_id: packagingTaskId, task_type: "creative_packaging", status: "queued" });
      },
      preflightVisualComparison: async (candidateId) => {
        calls.push(["preflightVisualComparison", candidateId]);
        return {
          eligible: true,
          reason: "ready",
          renderCount: 3,
          bailianCalls: 0,
          apimartCalls: 0,
          remotionAvailable: true,
          visualComparisonAvailable: true,
          outputPath: "C:\\must-not-leak\\comparison",
          apiKey: "must-not-leak-key"
        };
      },
      createVisualComparisonTask: async (candidateId) => {
        calls.push(["createVisualComparisonTask", candidateId]);
        return task({
          task_id: comparisonTaskId,
          task_type: "creative_visual_comparison",
          status: "queued",
          comparison_group_id: comparisonTaskId,
          comparison_source_candidate_id: candidateId,
          style_order: ["social_pop", "neo_editorial", "tech_motion"],
          render_count: 3,
          bailian_calls: 0,
          apimart_calls: 0,
          remotion_packaging_capable: true,
          visual_comparison_capable: true,
          candidates: [{
            candidate_id: generatedVideoId,
            status: "queued",
            requested_engine: "remotion",
            requested_style_id: "social_pop",
            requested_style_version: 1,
            actual_engine: null,
            actual_style_version: null,
            fallback_code: null,
            output_path: "C:\\must-not-leak\\candidate.mp4",
            api_key: "must-not-leak-key"
          }],
          output_path: "C:\\must-not-leak\\comparison",
          api_key: "must-not-leak-key"
        });
      },
      listGeneratedVideos: async (options) => {
        calls.push(["listGeneratedVideos", options]);
        return { items: [generatedVideo()] };
      },
      regenerateCover: async (candidateId) => {
        calls.push(["regenerateCover", candidateId]);
        return task({ task_id: packagingTaskId, task_type: "creative_cover", status: "queued" });
      },
      createMixProject: async (name, slots, constraints) => {
        calls.push(["createMixProject", name, slots, constraints]);
        return mixProject();
      },
      updateMixProject: async (projectId, changes) => {
        calls.push(["updateMixProject", projectId, changes]);
        return mixProject();
      },
      getMixProject: async (projectId) => {
        calls.push(["getMixProject", projectId]);
        return mixProject();
      },
      listMixProjects: async (limit) => ({ items: [mixProject()], limit }),
      calculateMixCombinations: async () => ({ project_id: mixProjectId, raw_cartesian_count: 2, combination_count: 1, constraints_applied: { required_slots: 1, fixed_slots: 0, allow_repeated_assets: false, duration_constrained: true }, path: "C:\\must-not-leak" }),
      generateMixCandidates: async (_projectId, options) => ({ project_id: mixProjectId, seed: String(options.seed), items: [mixCandidate()], asset_usage_counts: { [asset().asset_id]: 1 }, generation_stats: { inspected_count: 2, retained_count: 1, beam_capacity: 4, source: "generated", output_path: "C:\\must-not-leak" } }),
      listMixCandidates: async (options) => {
        calls.push(["listMixCandidates", options]);
        return { items: [mixCandidate()] };
      },
      reviewMixCandidate: async (candidateId, reviewStatus, reviewNote) => {
        calls.push(["reviewMixCandidate", candidateId, reviewStatus, reviewNote]);
        return mixCandidate();
      },
      listPublishQueue: async (options) => ({ items: [{ queue_item_id: publishQueueId, candidate_id: mixCandidateId, project_id: mixProjectId, status: "queued", error_message: null, created_at: "2026-08-10T00:00:00Z", updated_at: "2026-08-10T00:01:00Z", absolute_path: "C:\\must-not-leak" }], options }),
      updatePublishQueueItem: async (queueItemId, status, errorMessage) => {
        calls.push(["updatePublishQueueItem", queueItemId, status, errorMessage]);
        return { queue_item_id: publishQueueId, candidate_id: mixCandidateId, project_id: mixProjectId, status, error_message: errorMessage, created_at: "2026-08-10T00:00:00Z", updated_at: "2026-08-10T00:01:00Z" };
      },
      renderMixCandidate: async (candidateId, options) => {
        calls.push(["renderMixCandidate", candidateId, options]);
        return { package_id: exportPackageId, candidate_id: candidateId, queue_item_id: publishQueueId, platforms: options.platforms, outputs: { wechat: "wechat.mp4" }, cover_name: "cover.jpg", manifest_name: "manifest.json", title: "", description: "", created_at: "2026-08-10T00:02:00Z", output_directory: "C:\\must-not-leak" };
      },
      listExportPackages: async () => ({ items: [{ package_id: exportPackageId, candidate_id: mixCandidateId, queue_item_id: publishQueueId, platforms: ["wechat"], outputs: { wechat: "wechat.mp4" }, cover_name: "cover.jpg", manifest_name: "manifest.json", title: "", description: "", created_at: "2026-08-10T00:02:00Z", output_directory: "C:\\must-not-leak" }] }),
      resolveExportPackagePath: async () => ({ package_id: exportPackageId, absolute_path: exportDirectory }),
      onUpdate: (listener) => {
        updateListener = listener;
        return () => {
          unsubscribed = true;
        };
      }
    };
    const mainWindow = {
      isDestroyed: () => false,
      isFocused: () => true,
      webContents: {
        send: (channel, payload) => sent.push({ channel, payload })
      }
    };
    const electron = {
      dialog: {
        showOpenDialog: async (...args) => {
          const options = args.at(-1);
          calls.push(["showOpenDialog", options]);
          return dialogQueue.shift();
        }
      },
      shell: {
        showItemInFolder: (filePath) => shown.push(filePath),
        openPath: async (filePath) => {
          opened.push(filePath);
          return "";
        }
      }
    };

    const registration = registerContentEngineIpc({
      controller,
      bailianKeyStore,
      diagnosticLogger,
      diagnosticSessionStartedAt: Date.parse("2026-08-21T00:00:00.000Z"),
      electron,
      getMainWindow: () => mainWindow,
      ipcMain
    });
    assert.deepEqual(
      [...handlers.keys()].sort(),
      Object.values(CONTENT_ENGINE_CHANNELS)
        .filter((channel) => channel !== CONTENT_ENGINE_CHANNELS.update)
        .sort()
    );

    const statusResult = await handlers.get(CONTENT_ENGINE_CHANNELS.status)();
    assert.deepEqual(statusResult, {
      ok: true,
      data: {
        state: "ready",
        available: true,
        version: "0.1.0",
        capabilities: { asset_index: true },
        code: ""
      }
    });

    const restartResult = await handlers.get(CONTENT_ENGINE_CHANNELS.restart)();
    assert.deepEqual(restartResult, statusResult);
    assert.deepEqual(calls.find((call) => call[0] === "restart"), ["restart"]);

    const keyHandshake = await handlers.get(
      CONTENT_ENGINE_CHANNELS.bailianKeyEncryption
    )();
    assert.equal(keyHandshake.ok, true);
    const secret = ["sk", "fixture-must-not-cross-ipc"].join("-");
    const ciphertext = publicEncrypt(
      {
        key: keyHandshake.data.publicKey,
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256"
      },
      Buffer.from(secret, "utf8")
    ).toString("base64");
    const savedKey = await handlers.get(CONTENT_ENGINE_CHANNELS.saveBailianKey)(
      {},
      { keyId: keyHandshake.data.keyId, ciphertext }
    );
    assert.equal(savedKey.ok, true);
    assert.equal(storedBailianKey, secret);
    assert.equal(JSON.stringify({ keyId: keyHandshake.data.keyId, ciphertext }).includes(secret), false);
    const replayedKey = await handlers.get(CONTENT_ENGINE_CHANNELS.saveBailianKey)(
      {},
      { keyId: keyHandshake.data.keyId, ciphertext }
    );
    assert.equal(replayedKey.ok, false);
    assert.equal(replayedKey.code, "BAILIAN_KEY_ENCRYPTION_INVALID");

    const listed = await handlers.get(CONTENT_ENGINE_CHANNELS.listAssets)(
      {},
      { includeArchived: true, limit: 20, injectedPath: "C:\\bad" }
    );
    assert.equal(listed.ok, true);
    assert.equal(listed.data.items[0].assetId, asset().asset_id);
    assert.equal(JSON.stringify(listed).includes("must-not-leak"), false);
    assert.deepEqual(calls.find((call) => call[0] === "listAssets"), [
      "listAssets",
      { includeArchived: true, limit: 20 }
    ]);

    assert.equal(listed.data.items[0].probeStatus, "ok");
    assert.equal(listed.data.items[0].durationMs, 12_345);
    assert.equal(listed.data.items[0].width, 1080);
    assert.equal(listed.data.items[0].height, 1920);
    assert.equal(listed.data.items[0].fps, 25);
    assert.equal(listed.data.items[0].hasAudio, true);

    const probed = await handlers.get(CONTENT_ENGINE_CHANNELS.probeAsset)(
      {},
      { assetId: asset().asset_id, path: "C:\\bad" }
    );
    assert.equal(probed.ok, true);
    assert.equal(probed.data.probeStatus, "ok");
    assert.deepEqual(calls.find((call) => call[0] === "probeAsset"), [
      "probeAsset",
      asset().asset_id
    ]);

    const probedPending = await handlers.get(CONTENT_ENGINE_CHANNELS.probePending)(
      {},
      { limit: 3, path: "C:\\bad" }
    );
    assert.deepEqual(probedPending.data.processedCount, 1);
    assert.deepEqual(probedPending.data.remainingCount, 2);
    assert.deepEqual(calls.find((call) => call[0] === "probePending"), [
      "probePending",
      3
    ]);

    const defaultProbePending = await handlers.get(
      CONTENT_ENGINE_CHANNELS.probePending
    )({}, {});
    assert.equal(defaultProbePending.ok, true);
    assert.deepEqual(
      calls.filter((call) => call[0] === "probePending").at(-1),
      ["probePending", 10]
    );
    const probeCallCount = calls.filter(
      (call) => call[0] === "probePending"
    ).length;
    const excessiveProbePending = await handlers.get(
      CONTENT_ENGINE_CHANNELS.probePending
    )({}, { limit: 11 });
    assert.equal(excessiveProbePending.ok, false);
    assert.equal(excessiveProbePending.code, "invalid_limit");
    assert.equal(
      calls.filter((call) => call[0] === "probePending").length,
      probeCallCount,
      "an excessive probe batch must never reach the worker"
    );

    const updatedRights = await handlers.get(
      CONTENT_ENGINE_CHANNELS.updateAssetRights
    )({}, { assetId: asset().asset_id, rightsStatus: "licensed", injected: true });
    assert.equal(updatedRights.ok, true);
    assert.equal(updatedRights.data.rightsStatus, "licensed");
    assert.deepEqual(calls.find((call) => call[0] === "updateAssetRights"), [
      "updateAssetRights",
      asset().asset_id,
      "licensed"
    ]);

    const importedFiles = await handlers.get(CONTENT_ENGINE_CHANNELS.chooseFiles)();
    assert.equal(importedFiles.ok, true);
    assert.equal(importedFiles.data.createdAssets, 1);
    assert.deepEqual(calls.find((call) => call[0] === "importFiles"), [
      "importFiles",
      [sourceFile]
    ]);
    assert.equal(JSON.stringify(importedFiles).includes(root), false);

    const importedFolder = await handlers.get(CONTENT_ENGINE_CHANNELS.chooseFolder)(
      {},
      { recursive: false, path: "C:\\renderer-cannot-choose" }
    );
    assert.equal(importedFolder.ok, true);
    assert.deepEqual(calls.find((call) => call[0] === "importFolder"), [
      "importFolder",
      root,
      false
    ]);

    const archived = await handlers.get(CONTENT_ENGINE_CHANNELS.archiveAsset)(
      {},
      { assetId: asset().asset_id, deleteOriginal: true }
    );
    assert.equal(archived.ok, true);
    assert.equal(archived.data.archived, true);
    assert.deepEqual(calls.find((call) => call[0] === "archiveAsset"), [
      "archiveAsset",
      asset().asset_id
    ]);

    const revealedAsset = await handlers.get(CONTENT_ENGINE_CHANNELS.revealAsset)(
      {},
      { assetId: asset().asset_id, path: "C:\\attacker" }
    );
    assert.deepEqual(revealedAsset, {
      ok: true,
      data: { available: true, revealed: true }
    });
    assert.deepEqual(shown, [fs.realpathSync(sourceFile)]);
    assert.equal(JSON.stringify(revealedAsset).includes(root), false);

    const listedTasks = await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)(
      {},
      { status: "paused", limit: 10 }
    );
    assert.equal(listedTasks.ok, true);
    assert.equal(listedTasks.data.items[0].taskId, task().task_id);
    assert.equal(JSON.stringify(listedTasks).includes("must-not-leak"), false);
    assert.equal(
      diagnosticEvents.some((entry) => entry[1] === "task_terminal"),
      false,
      "loading an existing paused task must not create a diagnostic"
    );
    for (const [channel, expectedStatus] of [
      [CONTENT_ENGINE_CHANNELS.pauseTask, "paused"],
      [CONTENT_ENGINE_CHANNELS.resumeTask, "analyzing"],
      [CONTENT_ENGINE_CHANNELS.cancelTask, "cancelled"]
    ]) {
      const response = await handlers.get(channel)({}, { taskId: task().task_id });
      assert.equal(response.ok, true);
      assert.equal(response.data.status, expectedStatus);
    }

    listedTaskItems = [task({
      task_id: "task_33333333333333333333333333333333",
      status: "failed",
      error_code: "historical_failure",
      error_message: "历史失败",
      updated_at: "2026-08-20T23:00:00.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    assert.equal(
      diagnosticEvents.some((entry) => entry[1] === "task_terminal"),
      false,
      "the first list after restart must not replay historical failures"
    );

    const transitioningTaskId = "task_44444444444444444444444444444444";
    listedTaskItems = [task({
      task_id: transitioningTaskId,
      status: "analyzing",
      error_code: null,
      error_message: null,
      updated_at: "2026-08-21T00:01:00.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    listedTaskItems = [task({
      task_id: transitioningTaskId,
      status: "failed",
      error_code: "new_failure",
      error_message: "新失败",
      updated_at: "2026-08-21T00:02:00.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    const transitionEvents = diagnosticEvents.filter(
      (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === transitioningTaskId
    );
    assert.equal(transitionEvents.length, 1, "a newly failed task must be logged exactly once");
    assert.equal(transitionEvents[0][3]?.level, "error");
    assert.equal(
      transitionEvents[0][3]?.dedupeKey,
      transitioningTaskId,
      "task failures must deduplicate per task without persisting the task id in the logger signature"
    );
    assert.deepEqual(
      Object.keys(transitionEvents[0][2] || {}).sort(),
      ["error_code", "task_id"],
      "task diagnostics must contain only the fields needed to locate and repair the failure"
    );
    assert.equal(JSON.stringify(transitionEvents).includes("must-not-leak"), false);
    assert.equal(
      Object.hasOwn(transitionEvents[0][2] || {}, "error_message"),
      false,
      "repair diagnostics must not persist raw task error messages"
    );
    listedTaskItems = [task({
      task_id: transitioningTaskId,
      status: "failed",
      error_code: "new_failure",
      error_message: "同一失败的补充描述",
      updated_at: "2026-08-21T00:02:10.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    assert.equal(
      diagnosticEvents.filter(
        (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === transitioningTaskId
      ).length,
      1,
      "changing the message of the same failure must not duplicate diagnostics"
    );
    listedTaskItems = [task({
      task_id: transitioningTaskId,
      status: "queued",
      updated_at: "2026-08-21T00:02:20.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    listedTaskItems = [task({
      task_id: transitioningTaskId,
      status: "failed",
      error_code: "retry_failure",
      error_message: "重试后再次失败",
      updated_at: "2026-08-21T00:02:25.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    assert.equal(
      diagnosticEvents.filter(
        (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === transitioningTaskId
      ).length,
      2,
      "a genuine retry that fails again must retain a new repair diagnostic"
    );

    const directRetryTaskId = "task_46464646464646464646464646464646";
    listedTaskItems = [task({
      task_id: directRetryTaskId,
      status: "analyzing",
      updated_at: "2026-08-21T00:02:26.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    listedTaskItems = [task({
      task_id: directRetryTaskId,
      status: "failed",
      error_code: "render_failed",
      updated_at: "2026-08-21T00:02:27.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    const originalResumeTask = controller.resumeTask;
    controller.resumeTask = async (taskId) => task({
      task_id: taskId,
      status: "analyzing",
      resume_from_status: null,
      updated_at: "2026-08-21T00:02:27.000Z"
    });
    const directRetry = await handlers.get(
      CONTENT_ENGINE_CHANNELS.resumeTask
    )({}, { taskId: directRetryTaskId });
    controller.resumeTask = originalResumeTask;
    assert.equal(directRetry.ok, true);
    listedTaskItems = [task({
      task_id: directRetryTaskId,
      status: "analyzing",
      updated_at: "not-a-timestamp"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    listedTaskItems = [task({
      task_id: directRetryTaskId,
      status: "failed",
      error_code: "render_failed",
      updated_at: "2026-08-21T00:02:27.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    assert.equal(
      diagnosticEvents.filter(
        (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === directRetryTaskId
      ).length,
      1,
      "a delayed equal-time snapshot from before the direct retry must be ignored"
    );
    listedTaskItems = [task({
      task_id: directRetryTaskId,
      status: "failed",
      error_code: "render_failed",
      updated_at: "not-a-timestamp"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    assert.equal(
      diagnosticEvents.filter(
        (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === directRetryTaskId
      ).length,
      1,
      "a malformed delayed snapshot from before the direct retry must be ignored"
    );
    listedTaskItems = [task({
      task_id: directRetryTaskId,
      status: "failed",
      error_code: "render_timeout",
      updated_at: "2026-08-21T00:02:28.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    assert.equal(
      diagnosticEvents.filter(
        (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === directRetryTaskId
      ).length,
      2,
      "a successful direct retry must reset failed state before the next poll"
    );

    const invalidTrustedTimestampTaskId = "task_48484848484848484848484848484848";
    controller.resumeTask = async (taskId) => task({
      task_id: taskId,
      status: "analyzing",
      resume_from_status: null,
      updated_at: "not-a-timestamp"
    });
    const invalidTimestampRetry = await handlers.get(
      CONTENT_ENGINE_CHANNELS.resumeTask
    )({}, { taskId: invalidTrustedTimestampTaskId });
    controller.resumeTask = originalResumeTask;
    assert.equal(invalidTimestampRetry.ok, true);
    listedTaskItems = [task({
      task_id: invalidTrustedTimestampTaskId,
      status: "failed",
      error_code: "render_failed",
      updated_at: "2026-08-20T23:59:00.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    assert.equal(
      diagnosticEvents.some(
        (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === invalidTrustedTimestampTaskId
      ),
      false,
      "a conflicting snapshot cannot replace a trusted direct state before an ordering barrier exists"
    );
    listedTaskItems = [task({
      task_id: invalidTrustedTimestampTaskId,
      status: "analyzing",
      updated_at: "2026-08-21T00:02:29.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    listedTaskItems = [task({
      task_id: invalidTrustedTimestampTaskId,
      status: "failed",
      error_code: "render_timeout",
      updated_at: "2026-08-21T00:02:30.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    assert.equal(
      diagnosticEvents.filter(
        (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === invalidTrustedTimestampTaskId
      ).length,
      1,
      "a newer failure must be accepted after a same-state poll establishes the ordering barrier"
    );

    const confirmedConflictTaskId = "task_49494949494949494949494949494949";
    controller.resumeTask = async (taskId) => task({
      task_id: taskId,
      status: "analyzing",
      resume_from_status: null,
      updated_at: "not-a-timestamp"
    });
    const confirmedConflictRetry = await handlers.get(
      CONTENT_ENGINE_CHANNELS.resumeTask
    )({}, { taskId: confirmedConflictTaskId });
    controller.resumeTask = originalResumeTask;
    assert.equal(confirmedConflictRetry.ok, true);
    listedTaskItems = [task({
      task_id: confirmedConflictTaskId,
      status: "failed",
      error_code: "render_failed",
      updated_at: "2026-08-21T00:02:31.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    assert.equal(
      diagnosticEvents.some(
        (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === confirmedConflictTaskId
      ),
      false,
      "one conflicting poll must not override a trusted direct state without an ordering barrier"
    );
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    assert.equal(
      diagnosticEvents.filter(
        (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === confirmedConflictTaskId
      ).length,
      1,
      "a repeated matching conflict must confirm and record a real fast failure exactly once"
    );

    const trustedTerminalTaskId = "task_50505050505050505050505050505050";
    controller.resumeTask = async (taskId) => task({
      task_id: taskId,
      status: "completed",
      resume_from_status: null,
      updated_at: "not-a-timestamp"
    });
    const trustedTerminalTask = await handlers.get(
      CONTENT_ENGINE_CHANNELS.resumeTask
    )({}, { taskId: trustedTerminalTaskId });
    controller.resumeTask = originalResumeTask;
    assert.equal(trustedTerminalTask.ok, true);
    listedTaskItems = [task({
      task_id: trustedTerminalTaskId,
      status: "failed",
      error_code: "stale_terminal_conflict",
      updated_at: "2026-08-21T00:02:32.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    assert.equal(
      diagnosticEvents.some(
        (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === trustedTerminalTaskId
      ),
      false,
      "a trusted terminal response must not be replaced by repeated unordered stale failures"
    );

    const completedTaskId = "task_45454545454545454545454545454545";
    listedTaskItems = [task({
      task_id: completedTaskId,
      status: "analyzing",
      updated_at: "2026-08-21T00:02:30.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    listedTaskItems = [task({
      task_id: completedTaskId,
      status: "completed",
      progress: 100,
      updated_at: "2026-08-21T00:02:40.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    assert.equal(
      diagnosticEvents.some(
        (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === completedTaskId
      ),
      false,
      "a successful task transition must not create a repair diagnostic"
    );
    listedTaskItems = [task({
      task_id: completedTaskId,
      status: "failed",
      error_code: "stale_failure",
      updated_at: "2026-08-21T00:02:35.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    assert.equal(
      diagnosticEvents.some(
        (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === completedTaskId
      ),
      false,
      "an older failed response must not override a newer completed observation"
    );
    listedTaskItems = [task({
      task_id: completedTaskId,
      status: "failed",
      error_code: "equal_time_failure",
      updated_at: "2026-08-21T00:02:40.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    assert.equal(
      diagnosticEvents.some(
        (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === completedTaskId
      ),
      false,
      "an equal-time failure must not replace an already completed state"
    );

    const malformedOrderingTaskId = "task_47474747474747474747474747474747";
    listedTaskItems = [task({
      task_id: malformedOrderingTaskId,
      status: "analyzing",
      updated_at: "2026-08-21T00:02:50.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    listedTaskItems = [task({
      task_id: malformedOrderingTaskId,
      status: "queued",
      updated_at: "not-a-timestamp"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    listedTaskItems = [task({
      task_id: malformedOrderingTaskId,
      status: "failed",
      error_code: "stale_after_malformed",
      updated_at: "2026-08-21T00:02:45.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    assert.equal(
      diagnosticEvents.some(
        (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === malformedOrderingTaskId
      ),
      false,
      "a malformed timestamp must not erase the last valid ordering barrier"
    );

    const directFailureTaskId = "task_55555555555555555555555555555555";
    listedTaskItems = [task({
      task_id: directFailureTaskId,
      status: "failed",
      error_code: "fast_failure",
      error_message: "快速失败",
      updated_at: "2026-08-21T00:03:00.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    assert.equal(
      diagnosticEvents.filter(
        (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === directFailureTaskId
      ).length,
      1,
      "a task that fails before the first poll must still be logged when it failed in this session"
    );

    const sessionOwnedTaskId = "task_56565656565656565656565656565656";
    const analyzeAssetsForSessionTask = controller.analyzeAssets;
    controller.analyzeAssets = async () => task({
      task_id: sessionOwnedTaskId,
      status: "queued",
      updated_at: "2026-08-20T22:00:00.000Z"
    });
    const sessionOwnedTask = await handlers.get(
      CONTENT_ENGINE_CHANNELS.analyzeAssets
    )({}, { assetIds: [asset().asset_id] });
    controller.analyzeAssets = analyzeAssetsForSessionTask;
    assert.equal(sessionOwnedTask.ok, true);
    listedTaskItems = [task({
      task_id: sessionOwnedTaskId,
      status: "queued",
      updated_at: "2026-08-20T22:00:00.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    listedTaskItems = [task({
      task_id: sessionOwnedTaskId,
      status: "failed",
      error_code: "session_owned_failure",
      error_message: "本次启动创建后快速失败",
      updated_at: "2026-08-20T22:00:01.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    assert.equal(
      diagnosticEvents.filter(
        (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === sessionOwnedTaskId
      ).length,
      1,
      "a task returned by this process must be logged even if its timestamp is stale"
    );

    const unsafeTimestampTaskId = "task_57575757575757575757575757575757";
    listedTaskItems = [task({
      task_id: unsafeTimestampTaskId,
      status: "analyzing",
      updated_at: "2026-08-21T00:04:00.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    listedTaskItems = [task({
      task_id: unsafeTimestampTaskId,
      status: "failed",
      error_code: "unsafe_timestamp_failure",
      updated_at: "C:\\private\\sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    const unsafeTimestampEvents = diagnosticEvents.filter(
      (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === unsafeTimestampTaskId
    );
    assert.equal(unsafeTimestampEvents.length, 1);
    assert.equal(JSON.stringify(unsafeTimestampEvents).includes("C:\\private"), false);
    assert.equal(JSON.stringify(unsafeTimestampEvents).includes("sk-ABC"), false);

    const invalidStatusTaskId = "task_58585858585858585858585858585858";
    listedTaskItems = [task({
      task_id: invalidStatusTaskId,
      status: "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
      error_code: "must_not_be_task_failure",
      updated_at: "2026-08-21T00:05:00.000Z"
    })];
    await handlers.get(CONTENT_ENGINE_CHANNELS.listTasks)({}, { limit: 10 });
    assert.equal(
      diagnosticEvents.some(
        (entry) => entry[1] === "task_terminal" && entry[2]?.task_id === invalidStatusTaskId
      ),
      false,
      "an invalid backend task status must not be reported as a real task failure"
    );
    listedTaskItems = [task()];

    const listedFinished = await handlers.get(CONTENT_ENGINE_CHANNELS.listFinished)(
      {},
      { limit: 20 }
    );
    assert.equal(listedFinished.ok, true);
    assert.equal(listedFinished.data.items[0].finishedVideoId, finished().finished_video_id);
    assert.equal(listedFinished.data.items[0].available, true);
    assert.equal(JSON.stringify(listedFinished).includes("must-not-leak"), false);
    assert.equal(JSON.stringify(listedFinished).includes(root), false);
    assert.deepEqual(listedFinished.data.items[0].metadata, {
      duration: 58,
      note: "saved at [已隐藏本地路径]"
    });

    const registered = await handlers.get(
      CONTENT_ENGINE_CHANNELS.chooseAndRegisterFinished
    )({}, { title: " 课程重点 ", metadata: { path: "C:\\bad" } });
    assert.equal(registered.ok, true);
    assert.equal(registered.data.title, "课程重点");
    const registerCall = calls.find((call) => call[0] === "registerFinished");
    assert.equal(registerCall[1], finishedFile);
    assert.deepEqual(registerCall[2], {
      title: "课程重点",
      taskId: undefined,
      metadata: {}
    });
    assert.equal(JSON.stringify(registered).includes(root), false);

    const openedFinished = await handlers.get(CONTENT_ENGINE_CHANNELS.openFinished)(
      {},
      { finishedVideoId: finished().finished_video_id, path: "C:\\attacker" }
    );
    assert.deepEqual(openedFinished, { ok: true, data: { opened: true } });
    assert.deepEqual(opened, [fs.realpathSync(finishedFile)]);
    const revealedFinished = await handlers.get(
      CONTENT_ENGINE_CHANNELS.revealFinished
    )({}, { finishedVideoId: finished().finished_video_id });
    assert.deepEqual(revealedFinished, {
      ok: true,
      data: { available: true, revealed: true }
    });
    assert.deepEqual(shown, [
      fs.realpathSync(sourceFile),
      fs.realpathSync(finishedFile)
    ]);

    const settingsStatus = await handlers.get(
      CONTENT_ENGINE_CHANNELS.settingsStatus
    )();
    assert.equal(settingsStatus.ok, true);
    assert.equal(settingsStatus.data.cacheConfigured, true);
    assert.equal(settingsStatus.data.cacheDirectoryLabel, path.basename(root));
    assert.equal(JSON.stringify(settingsStatus).includes(root), false);

    const cacheSelection = await handlers.get(
      CONTENT_ENGINE_CHANNELS.chooseCacheDirectory
    )();
    assert.deepEqual(cacheSelection, {
      ok: true,
      data: {
        cancelled: false,
        cacheConfigured: true,
        cacheDirectoryLabel: path.basename(root),
        cacheLimitGb: 100
      }
    });
    assert.deepEqual(
      calls.filter((call) => call[0] === "setSetting").slice(0, 3),
      [
        ["setSetting", "cache_directory", fs.realpathSync(root)],
        ["setSetting", "cache_directory_label", path.basename(root)],
        ["setSetting", "cache_configured", true]
      ]
    );
    const cacheLimit = await handlers.get(
      CONTENT_ENGINE_CHANNELS.updateCacheLimit
    )({}, { limitGb: 100, arbitrary: "ignored" });
    assert.deepEqual(cacheLimit, {
      ok: true,
      data: { cacheLimitGb: 100 }
    });

    const createdMix = await handlers.get(CONTENT_ENGINE_CHANNELS.createMixProject)({}, {
      name: " Launch ",
      slots: [{ name: " Intro ", required: true, assetIds: [asset().asset_id], minDurationMs: 0, maxDurationMs: 3000 }],
      constraints: { allowRepeatedAssets: false, minDurationMs: 1000, maxDurationMs: 5000, scoreWeights: { durationFit: 0.6, diversity: 0.25, freshness: 0.15 } }
    });
    assert.equal(createdMix.ok, true);
    assert.equal(createdMix.data.projectId, mixProjectId);
    assert.deepEqual(createdMix.data.constraints.scoreWeights, { durationFit: 0.6, diversity: 0.25, freshness: 0.15 });
    assert.equal(JSON.stringify(createdMix).includes("must-not-leak"), false);
    assert.deepEqual(calls.find((call) => call[0] === "createMixProject"), ["createMixProject", "Launch", [{ name: "Intro", required: true, asset_ids: [asset().asset_id], fixed_asset_id: undefined, min_duration_ms: 0, max_duration_ms: 3000 }], { allow_repeated_assets: false, min_duration_ms: 1000, max_duration_ms: 5000, score_weights: { duration_fit: 0.6, diversity: 0.25, freshness: 0.15 } }]);

    assert.equal((await handlers.get(CONTENT_ENGINE_CHANNELS.updateMixProject)({}, { projectId: mixProjectId, name: " Launch 2 " })).ok, true);
    assert.equal((await handlers.get(CONTENT_ENGINE_CHANNELS.getMixProject)({}, { projectId: mixProjectId })).data.projectId, mixProjectId);
    assert.equal((await handlers.get(CONTENT_ENGINE_CHANNELS.listMixProjects)({}, { limit: 12 })).data.items.length, 1);
    const combinations = await handlers.get(CONTENT_ENGINE_CHANNELS.calculateMixCombinations)({}, { projectId: mixProjectId });
    assert.deepEqual(combinations.data.constraintsApplied, { requiredSlots: 1, fixedSlots: 0, allowRepeatedAssets: false, durationConstrained: true });

    const generatedMix = await handlers.get(CONTENT_ENGINE_CHANNELS.generateMixCandidates)({}, { projectId: mixProjectId, limit: 3, seed: "campaign-7" });
    assert.equal(generatedMix.ok, true);
    assert.equal(generatedMix.data.items[0].candidateId, mixCandidateId);
    assert.equal(generatedMix.data.generationStats.inspectedCount, 2);
    assert.equal(JSON.stringify(generatedMix).includes("must-not-leak"), false);
    assert.equal((await handlers.get(CONTENT_ENGINE_CHANNELS.listMixCandidates)({}, { projectId: mixProjectId, reviewStatus: "pending", limit: 4 })).data.items[0].candidateId, mixCandidateId);

    const reviewedMix = await handlers.get(CONTENT_ENGINE_CHANNELS.reviewMixCandidate)({}, { candidateId: mixCandidateId, reviewStatus: "approved", reviewNote: " ready " });
    assert.equal(reviewedMix.ok, true);
    assert.deepEqual(calls.find((call) => call[0] === "reviewMixCandidate"), ["reviewMixCandidate", mixCandidateId, "approved", "ready"]);

    const queue = await handlers.get(CONTENT_ENGINE_CHANNELS.listPublishQueue)({}, { status: "queued", limit: 8 });
    assert.equal(queue.data.items[0].queueItemId, publishQueueId);
    assert.equal(JSON.stringify(queue).includes("must-not-leak"), false);
    const updatedQueue = await handlers.get(CONTENT_ENGINE_CHANNELS.updatePublishQueueItem)({}, { queueItemId: publishQueueId, status: "processing", errorMessage: " retry " });
    assert.equal(updatedQueue.data.status, "processing");
    assert.deepEqual(calls.find((call) => call[0] === "updatePublishQueueItem"), ["updatePublishQueueItem", publishQueueId, "processing", "retry"]);

    const renderedPackage = await handlers.get(CONTENT_ENGINE_CHANNELS.renderMixCandidate)({}, { candidateId: mixCandidateId, platforms: ["wechat"] });
    assert.equal(renderedPackage.data.packageId, exportPackageId);
    assert.equal(JSON.stringify(renderedPackage).includes("must-not-leak"), false);
    assert.equal((await handlers.get(CONTENT_ENGINE_CHANNELS.listExportPackages)({}, { limit: 8 })).data.items[0].packageId, exportPackageId);
    assert.equal((await handlers.get(CONTENT_ENGINE_CHANNELS.openExportPackage)({}, { packageId: exportPackageId })).ok, true);
    assert.equal((await handlers.get(CONTENT_ENGINE_CHANNELS.revealExportPackage)({}, { packageId: exportPackageId })).ok, true);
    assert.equal(opened.includes(fs.realpathSync(exportDirectory)), true);
    assert.equal(shown.includes(fs.realpathSync(exportDirectory)), true);

    for (const payload of [
      { assetId: asset().asset_id, minDurationMs: 29_999, maxDurationMs: 90_000, count: 5, theme: "test" },
      { assetId: asset().asset_id, minDurationMs: 30_000, maxDurationMs: 90_001, count: 5, theme: "test" }
    ]) {
      const invalidCourseDuration = await handlers.get(
        CONTENT_ENGINE_CHANNELS.generateCourseCuts
      )({}, payload);
      assert.equal(invalidCourseDuration.ok, false);
      assert.equal(invalidCourseDuration.code, "invalid_duration_range");
    }
    for (const payload of [
      { assetId: asset().asset_id, minDurationMs: 30_000, maxDurationMs: 90_000, count: 5, theme: "test", subtitleFontSize: 35 },
      { assetId: asset().asset_id, minDurationMs: 30_000, maxDurationMs: 90_000, count: 5, theme: "test", subtitleMarginBottom: 361 }
    ]) {
      const invalidSubtitle = await handlers.get(
        CONTENT_ENGINE_CHANNELS.generateCourseCuts
      )({}, payload);
      assert.equal(invalidSubtitle.ok, false);
      assert.match(invalidSubtitle.code, /^invalid_subtitle_/u);
    }
    for (const payload of [
      {
        assetId: asset().asset_id,
        experimentMode: "unknown",
        subtitlePreset: "dynamic_clean"
      },
      {
        assetId: asset().asset_id,
        experimentMode: "standard",
        subtitlePreset: "knowledge_course"
      },
      {
        assetId: asset().asset_id,
        experimentMode: "supoclip_bailian_v1",
        subtitlePreset: "dynamic_clean"
      }
    ]) {
      const invalidExperiment = await handlers.get(
        CONTENT_ENGINE_CHANNELS.generateCourseCuts
      )({}, payload);
      assert.equal(invalidExperiment.ok, false);
      assert.match(invalidExperiment.code, /^invalid_(experiment_mode|subtitle_preset)$/u);
    }
    const invalidExperimentCount = await handlers.get(
      CONTENT_ENGINE_CHANNELS.generateCourseCuts
    )({}, {
      assetId: asset().asset_id,
      minDurationMs: 30_000,
      maxDurationMs: 90_000,
      count: 4,
      theme: "test",
      experimentMode: "supoclip_bailian_v1",
      subtitlePreset: "knowledge_course"
    });
    assert.equal(invalidExperimentCount.ok, false);
    assert.equal(invalidExperimentCount.code, "invalid_experiment_count");
    const missingVoice = await handlers.get(
      CONTENT_ENGINE_CHANNELS.generateMixBatch
    )({}, {
      assetIds: [asset().asset_id],
      theme: "test",
      targetCount: 30
    });
    assert.equal(missingVoice.ok, false);
    assert.equal(missingVoice.code, "invalid_voice_asset");

    const visualRenderer = {
      requestedEngine: "remotion",
      visualStyleId: "tech_motion",
      requestedStyleVersion: 1,
      allowFallback: true
    };
    const visualCourse = await handlers.get(
      CONTENT_ENGINE_CHANNELS.generateCourseCuts
    )({}, {
      assetId: asset().asset_id,
      coverMode: "ai_generate",
      visualRenderer
    });
    assert.equal(visualCourse.ok, true);
    assert.deepEqual(
      calls.find((call) => call[0] === "generateCourseCuts").at(-1).visualRenderer,
      visualRenderer
    );
    const visualMix = await handlers.get(
      CONTENT_ENGINE_CHANNELS.generateMixBatch
    )({}, {
      assetIds: [asset().asset_id],
      voiceAssetId: asset().asset_id,
      visualRenderer: {
        requestedEngine: "remotion",
        requestedStyleVersion: 1,
        allowFallback: true
      }
    });
    assert.equal(visualMix.ok, true);
    assert.equal(
      calls.find((call) => call[0] === "generateMixBatch").at(-1).visualRenderer.visualStyleId,
      undefined
    );

    const createdAutoMixV2 = await handlers.get(
      CONTENT_ENGINE_CHANNELS.createAutoMixV2
    )({ sender: mainWindow.webContents }, {
      specVersion: "2",
      assetIds: [asset().asset_id],
      title: "产品标题",
      copyFramework: "真实素材，真实表达。",
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.createAutoMixV2,
        "11111111-1111-4111-8111-111111111111"
      )
    });
    assert.equal(createdAutoMixV2.ok, true);
    assert.equal(createdAutoMixV2.data.state, "analyzing");
    assert.equal(createdAutoMixV2.data.outputCount, 1);
    assert.equal(createdAutoMixV2.data.voicePersona.voicePersonaId, "natural-life@1");
    assert.equal(createdAutoMixV2.data.music.licenseSummary.evidencePresent, true);
    assert.equal(createdAutoMixV2.data.music.licenseSummary.commercialUseAllowed, true);
    assert.deepEqual(
      calls.find((call) => call[0] === "createAutoMixV2"),
      ["createAutoMixV2", {
        specVersion: "2",
        assetIds: [asset().asset_id],
        title: "产品标题",
        copyFramework: "真实素材，真实表达。"
      }]
    );

    const generatedGuidedScript = await handlers.get(
      CONTENT_ENGINE_CHANNELS.generateGuidedAutoMixScriptV2
    )({ sender: mainWindow.webContents }, {
      sessionId: staleGuidedSessionId,
      analysisTaskId: guidedAnalysisTaskId,
      title: "室内清洁机器人展示",
      answers: {
        companyName: "",
        productName: "清洁机器人",
        targetScene: "室内环境",
        keyMessage: "展示清洁过程",
        extraNotes: "不补写未展示信息"
      },
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.generateGuidedAutoMixScriptV2,
        "33333333-3333-4333-8333-333333333333"
      )
    });
    assert.equal(generatedGuidedScript.ok, true);
    assert.equal(generatedGuidedScript.data.sessionId, liveGuidedSessionId);
    assert.equal(generatedGuidedScript.data.prefill.answers.productName, "清洁机器人");
    assert.deepEqual(
      calls.find((call) => call[0] === "getGuidedAutoMixSessionV2"),
      ["getGuidedAutoMixSessionV2", { taskId: guidedAnalysisTaskId }]
    );
    assert.deepEqual(
      calls.find((call) => call[0] === "generateGuidedAutoMixScriptV2"),
      ["generateGuidedAutoMixScriptV2", {
        sessionId: liveGuidedSessionId,
        title: "室内清洁机器人展示",
        answers: {
          companyName: "",
          productName: "清洁机器人",
          targetScene: "室内环境",
          keyMessage: "展示清洁过程",
          extraNotes: "不补写未展示信息"
        }
      }]
    );
    const replayedAutoMixV2 = await handlers.get(
      CONTENT_ENGINE_CHANNELS.createAutoMixV2
    )({ sender: mainWindow.webContents }, {
      specVersion: "2",
      assetIds: [asset().asset_id],
      title: "产品标题",
      copyFramework: "真实素材，真实表达。",
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.createAutoMixV2,
        "11111111-1111-4111-8111-111111111111"
      )
    });
    assert.equal(replayedAutoMixV2.ok, false);
    assert.equal(replayedAutoMixV2.code, "trusted_user_click_required");
    const createCallCount = calls.filter((call) => call[0] === "createAutoMixV2").length;
    const previewClickToken = autoMixClickToken(
      CONTENT_ENGINE_CHANNELS.previewAutoMixVoicePersona,
      "88888888-8888-4888-8888-888888888888"
    );
    const crossOperationAutoMixV2 = await handlers.get(
      CONTENT_ENGINE_CHANNELS.createAutoMixV2
    )({ sender: mainWindow.webContents }, {
      specVersion: "2",
      assetIds: [asset().asset_id],
      title: "产品标题",
      copyFramework: "真实素材，真实表达。",
      clickToken: previewClickToken
    });
    assert.equal(crossOperationAutoMixV2.ok, false);
    assert.equal(crossOperationAutoMixV2.code, "trusted_user_click_required");
    assert.equal(
      calls.filter((call) => call[0] === "createAutoMixV2").length,
      createCallCount,
      "声音试听 token 不得跨 channel 创建成片"
    );
    const overlongAutoMixTitle = await handlers.get(
      CONTENT_ENGINE_CHANNELS.createAutoMixV2
    )({ sender: mainWindow.webContents }, {
      specVersion: "2",
      assetIds: [asset().asset_id],
      title: "标".repeat(101),
      copyFramework: "真实素材，真实表达。",
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.createAutoMixV2,
        "12121212-1212-4212-8212-121212121212"
      )
    });
    assert.equal(overlongAutoMixTitle.ok, false);
    assert.equal(overlongAutoMixTitle.code, "auto_mix_title_missing");
    const serializedAutoMixV2 = JSON.stringify(createdAutoMixV2);
    for (const forbidden of [
      "must-not-leak", "secret-value-123", "apiKey", "providerVoiceId",
      "credentialPath", "absolutePath"
    ]) {
      assert.equal(serializedAutoMixV2.includes(forbidden), false);
    }

    const loadedAutoMixByProject = await handlers.get(
      CONTENT_ENGINE_CHANNELS.getAutoMixPlanV2
    )({}, { projectId: creativeProjectId });
    assert.equal(loadedAutoMixByProject.ok, true);
    assert.equal(loadedAutoMixByProject.data.runId, autoMixRunId);
    assert.deepEqual(
      loadedAutoMixByProject.data.inputAssetIds,
      autoMixInputAssetIds,
      "恢复计划必须安全透传全部 5 条原始输入素材，不能退化为 3 条成片采用素材"
    );
    assert.equal(
      new Set(loadedAutoMixByProject.data.selectedSegments.map((item) => item.assetId)).size,
      3,
      "测试夹具必须保留原始输入 5 条、成片采用 3 条的差异"
    );
    assert.deepEqual(
      calls.find((call) => call[0] === "getAutoMixPlanV2"),
      ["getAutoMixPlanV2", { projectId: creativeProjectId }]
    );
    const loadedAutoMixByRun = await handlers.get(
      CONTENT_ENGINE_CHANNELS.getAutoMixPlanV2
    )({}, { runId: autoMixRunId });
    assert.equal(loadedAutoMixByRun.ok, true);
    assert.equal(loadedAutoMixByRun.data.projectId, creativeProjectId);

    const regeneratedAutoMix = await handlers.get(
      CONTENT_ENGINE_CHANNELS.regenerateAutoMixLayer
    )({ sender: mainWindow.webContents }, {
      projectId: creativeProjectId,
      expectedRunId: autoMixRunId,
      layer: "voice",
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.regenerateAutoMixLayer,
        "22222222-2222-4222-8222-222222222222"
      )
    });
    assert.equal(regeneratedAutoMix.ok, true);
    assert.equal(regeneratedAutoMix.data.state, "synthesizing");
    assert.equal(regeneratedAutoMix.data.generation, 2);
    assert.equal(regeneratedAutoMix.data.parentRunId, parentAutoMixRunId);
    assert.deepEqual(
      calls.find((call) => call[0] === "regenerateAutoMixLayer"),
      ["regenerateAutoMixLayer", creativeProjectId, "voice", autoMixRunId]
    );

    dialogQueue.push(
      { canceled: false, filePaths: [musicFile] },
      { canceled: false, filePaths: [musicEvidenceFile] }
    );
    const importedMusic = await handlers.get(
      CONTENT_ENGINE_CHANNELS.importMusicCatalogTrack
    )({ sender: mainWindow.webContents }, {
      displayName: "稳健节奏",
      source: "用户授权曲库",
      commercialScope: "commercial social media",
      commercialUseAllowed: true,
      licenseStatus: "valid",
      expiresAt: "2099-01-02T16:00:00.000Z",
      credentialReference: "license-record-001",
      bpm: 104,
      moods: ["steady", "credible"],
      energy: 0.56,
      loopStartMs: 2_000,
      loopEndMs: 28_000,
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.importMusicCatalogTrack,
        "33333333-3333-4333-8333-333333333333"
      )
    });
    assert.equal(importedMusic.ok, true);
    assert.equal(importedMusic.data.trackId, musicCatalogTrack().trackId);
    assert.equal(importedMusic.data.licenseSummary.evidencePresent, true);
    assert.equal(importedMusic.data.analysisStatus, "ready");
    assert.deepEqual(
      calls.find((call) => call[0] === "importMusicCatalogTrack"),
      ["importMusicCatalogTrack", {
        sourcePath: fs.realpathSync(musicFile),
        displayName: "稳健节奏",
        source: "用户授权曲库",
        commercialScope: "commercial social media",
        commercialUseAllowed: true,
        licenseStatus: "valid",
        expiresAt: "2099-01-02T16:00:00.000Z",
        credentialReference: "license-record-001",
        evidencePath: fs.realpathSync(musicEvidenceFile),
        bpm: 104,
        moods: ["steady", "credible"],
        energy: 0.56,
        loopStartMs: 2_000,
        loopEndMs: 28_000
      }]
    );
    const serializedMusic = JSON.stringify(importedMusic);
    for (const forbidden of [
      "must-not-leak", "managedRelativePath", "fingerprint",
      "credentialReference", "evidenceDigest", "absolutePath", "apiKey"
    ]) {
      assert.equal(serializedMusic.includes(forbidden), false);
    }
    const importedMusicCall = calls.find((call) => call[0] === "importMusicCatalogTrack");
    const {
      sourcePath: _sourcePath,
      evidencePath: _evidencePath,
      ...rendererMusicMetadata
    } = importedMusicCall[1];
    const musicImportCallCount = calls.filter(
      (call) => call[0] === "importMusicCatalogTrack"
    ).length;

    dialogQueue.push({ canceled: false, filePaths: [musicFile] });
    const dateOnlyExpiryMusic = await handlers.get(
      CONTENT_ENGINE_CHANNELS.importMusicCatalogTrack
    )({ sender: mainWindow.webContents }, {
      ...rendererMusicMetadata,
      expiresAt: "2099-01-02",
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.importMusicCatalogTrack,
        "34343434-3434-4434-8434-343434343434"
      )
    });
    assert.equal(dateOnlyExpiryMusic.ok, false);
    assert.equal(dateOnlyExpiryMusic.code, "music_license_expiry_invalid");
    assert.equal(
      calls.filter((call) => call[0] === "importMusicCatalogTrack").length,
      musicImportCallCount,
      "裸日期到期值不得进入内容引擎"
    );

    dialogQueue.push({ canceled: false, filePaths: [oversizedMusicFile] });
    const oversizedMusic = await handlers.get(
      CONTENT_ENGINE_CHANNELS.importMusicCatalogTrack
    )({ sender: mainWindow.webContents }, {
      ...rendererMusicMetadata,
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.importMusicCatalogTrack,
        "44444444-4444-4444-8444-444444444444"
      )
    });
    assert.equal(oversizedMusic.ok, false);
    assert.equal(oversizedMusic.code, "music_import_file_too_large");
    assert.equal(
      calls.filter((call) => call[0] === "importMusicCatalogTrack").length,
      musicImportCallCount,
      "超大音乐文件不得到达内容引擎"
    );

    dialogQueue.push(
      { canceled: false, filePaths: [musicFile] },
      { canceled: false, filePaths: [oversizedMusicEvidenceFile] }
    );
    const oversizedEvidence = await handlers.get(
      CONTENT_ENGINE_CHANNELS.importMusicCatalogTrack
    )({ sender: mainWindow.webContents }, {
      ...rendererMusicMetadata,
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.importMusicCatalogTrack,
        "55555555-5555-4555-8555-555555555555"
      )
    });
    assert.equal(oversizedEvidence.ok, false);
    assert.equal(oversizedEvidence.code, "music_license_evidence_too_large");
    assert.equal(
      calls.filter((call) => call[0] === "importMusicCatalogTrack").length,
      musicImportCallCount,
      "超大授权凭证不得到达内容引擎"
    );

    const listedMusic = await handlers.get(
      CONTENT_ENGINE_CHANNELS.listMusicCatalogTracks
    )({}, {});
    assert.equal(listedMusic.ok, true);
    assert.equal(listedMusic.data.items.length, 1);
    assert.equal(listedMusic.data.items[0].durationMs, 30_000);
    assert.deepEqual(
      calls.find((call) => call[0] === "listMusicCatalogTracks"),
      ["listMusicCatalogTracks"]
    );

    const listedVoicePersonas = await handlers.get(
      CONTENT_ENGINE_CHANNELS.listAutoMixVoicePersonas
    )({}, {});
    assert.equal(listedVoicePersonas.ok, true);
    assert.deepEqual(listedVoicePersonas.data.items, [{
      voicePersonaId: "natural-life@1",
      displayName: "自然生活",
      catalogVersion: "2026.08",
      category: "natural",
      approvalStatus: "pending",
      provisioningStatus: "ready",
      previewStatus: "completed",
      provider: "bailian",
      previewText: "",
      evidenceNote: "",
      researchDate: ""
    }]);
    assert.equal(JSON.stringify(listedVoicePersonas).includes("must-not-leak"), false);
    assert.deepEqual(
      calls.find((call) => call[0] === "listAutoMixVoicePersonas"),
      ["listAutoMixVoicePersonas"]
    );

    const voiceDesignCallCount = calls.filter(
      (call) => call[0] === "designAutoMixVoicePersona"
    ).length;
    const designClickToken = autoMixClickToken(
      CONTENT_ENGINE_CHANNELS.designAutoMixVoicePersona,
      "77777777-7777-4777-8777-777777777777"
    );
    const designedVoicePersona = await handlers.get(
      CONTENT_ENGINE_CHANNELS.designAutoMixVoicePersona
    )({ sender: mainWindow.webContents }, {
      voicePersonaId: "natural-life@1",
      clickToken: designClickToken
    });
    assert.equal(designedVoicePersona.ok, true);
    assert.equal(designedVoicePersona.data.provisioningStatus, "ready");
    assert.deepEqual(Object.keys(designedVoicePersona.data).sort(), [
      "approvalStatus", "catalogVersion", "category", "displayName", "evidenceNote",
      "previewStatus", "previewText", "provider", "provisioningStatus", "researchDate", "voicePersonaId"
    ]);
    assert.equal(JSON.stringify(designedVoicePersona).includes("must-not-leak"), false);
    assert.deepEqual(
      calls.find((call) => call[0] === "designAutoMixVoicePersona"),
      ["designAutoMixVoicePersona", "natural-life@1"]
    );
    const replayedVoiceDesign = await handlers.get(
      CONTENT_ENGINE_CHANNELS.designAutoMixVoicePersona
    )({ sender: mainWindow.webContents }, {
      voicePersonaId: "natural-life@1",
      clickToken: designClickToken
    });
    assert.equal(replayedVoiceDesign.ok, false);
    assert.equal(replayedVoiceDesign.code, "trusted_user_click_required");
    assert.equal(
      calls.filter((call) => call[0] === "designAutoMixVoicePersona").length,
      voiceDesignCallCount + 1,
      "声音生成点击 token 重放不得到达内容引擎"
    );
    const rejectedPrivateVoiceDesignField = await handlers.get(
      CONTENT_ENGINE_CHANNELS.designAutoMixVoicePersona
    )({ sender: mainWindow.webContents }, {
      voicePersonaId: "natural-life@1",
      providerVoiceId: "renderer-must-not-supply-this",
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.designAutoMixVoicePersona,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      )
    });
    assert.equal(rejectedPrivateVoiceDesignField.ok, false);
    assert.equal(
      calls.filter((call) => call[0] === "designAutoMixVoicePersona").length,
      voiceDesignCallCount + 1,
      "私有供应商音色字段不得到达内容引擎"
    );

    const approveBeforePreviewCallCount = calls.filter(
      (call) => call[0] === "approveAutoMixVoicePersona"
    ).length;
    const rejectedApprovalBeforePreview = await handlers.get(
      CONTENT_ENGINE_CHANNELS.approveAutoMixVoicePersona
    )({ sender: mainWindow.webContents }, {
      voicePersonaId: "natural-life@1",
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.approveAutoMixVoicePersona,
        "12121212-1212-4121-8121-121212121212"
      )
    });
    assert.equal(rejectedApprovalBeforePreview.ok, false);
    assert.equal(
      rejectedApprovalBeforePreview.code,
      "auto_mix_voice_preview_required"
    );
    assert.equal(
      calls.filter((call) => call[0] === "approveAutoMixVoicePersona").length,
      approveBeforePreviewCallCount,
      "本次会话未试听时不得批准声音"
    );

    const voicePreviewCallCount = calls.filter(
      (call) => call[0] === "previewAutoMixVoicePersona"
    ).length;
    const previewedVoicePersona = await handlers.get(
      CONTENT_ENGINE_CHANNELS.previewAutoMixVoicePersona
    )({ sender: mainWindow.webContents }, {
      voicePersonaId: "natural-life@1",
      clickToken: previewClickToken
    });
    assert.equal(previewedVoicePersona.ok, true);
    assert.deepEqual(Object.keys(previewedVoicePersona.data).sort(), [
      "audioDataUrl", "cacheHit", "previewStatus", "voicePersona"
    ]);
    assert.match(previewedVoicePersona.data.audioDataUrl, /^data:audio\/wav;base64,/u);
    assert.equal(previewedVoicePersona.data.cacheHit, true);
    assert.equal(JSON.stringify(previewedVoicePersona).includes("must-not-leak"), false);
    assert.deepEqual(
      calls.find((call) => call[0] === "previewAutoMixVoicePersona"),
      ["previewAutoMixVoicePersona", "natural-life@1"]
    );
    const replayedVoicePreview = await handlers.get(
      CONTENT_ENGINE_CHANNELS.previewAutoMixVoicePersona
    )({ sender: mainWindow.webContents }, {
      voicePersonaId: "natural-life@1",
      clickToken: previewClickToken
    });
    assert.equal(replayedVoicePreview.ok, false);
    assert.equal(replayedVoicePreview.code, "trusted_user_click_required");
    assert.equal(
      calls.filter((call) => call[0] === "previewAutoMixVoicePersona").length,
      voicePreviewCallCount + 1,
      "试听点击 token 重放不得到达内容引擎"
    );

    const redesignedVoicePersona = await handlers.get(
      CONTENT_ENGINE_CHANNELS.designAutoMixVoicePersona
    )({ sender: mainWindow.webContents }, {
      voicePersonaId: "natural-life@1",
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.designAutoMixVoicePersona,
        "13131313-1313-4131-8131-131313131313"
      )
    });
    assert.equal(redesignedVoicePersona.ok, true);
    const approveAfterRedesignCallCount = calls.filter(
      (call) => call[0] === "approveAutoMixVoicePersona"
    ).length;
    const rejectedApprovalAfterRedesign = await handlers.get(
      CONTENT_ENGINE_CHANNELS.approveAutoMixVoicePersona
    )({ sender: mainWindow.webContents }, {
      voicePersonaId: "natural-life@1",
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.approveAutoMixVoicePersona,
        "14141414-1414-4141-8141-141414141414"
      )
    });
    assert.equal(rejectedApprovalAfterRedesign.ok, false);
    assert.equal(
      rejectedApprovalAfterRedesign.code,
      "auto_mix_voice_preview_required"
    );
    assert.equal(
      calls.filter((call) => call[0] === "approveAutoMixVoicePersona").length,
      approveAfterRedesignCallCount,
      "重新生成声音后必须重新试听"
    );

    const originalPreviewAutoMixVoicePersona = controller.previewAutoMixVoicePersona;
    controller.previewAutoMixVoicePersona = async (voicePersonaId) => {
      calls.push(["previewAutoMixVoicePersona", voicePersonaId, "invalid-mime"]);
      return autoMixVoicePreview({
        voicePersona: autoMixVoicePersona({ voicePersonaId }),
        audioDataUrl: "data:audio/mpeg;base64,bXVzdC1ub3QtcGFzcw=="
      });
    };
    const rejectedNonWavPreview = await handlers.get(
      CONTENT_ENGINE_CHANNELS.previewAutoMixVoicePersona
    )({ sender: mainWindow.webContents }, {
      voicePersonaId: "natural-life@1",
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.previewAutoMixVoicePersona,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      )
    });
    controller.previewAutoMixVoicePersona = originalPreviewAutoMixVoicePersona;
    assert.equal(rejectedNonWavPreview.ok, true);
    assert.equal(rejectedNonWavPreview.data.audioDataUrl, null);
    assert.equal(JSON.stringify(rejectedNonWavPreview).includes("must-not-leak"), false);

    controller.previewAutoMixVoicePersona = async (voicePersonaId) => {
      calls.push(["previewAutoMixVoicePersona", voicePersonaId, "invalid-wav"]);
      return autoMixVoicePreview({
        voicePersona: autoMixVoicePersona({ voicePersonaId }),
        audioDataUrl: `data:audio/wav;base64,${Buffer.from("not-a-wav").toString("base64")}`
      });
    };
    const rejectedInvalidWavPreview = await handlers.get(
      CONTENT_ENGINE_CHANNELS.previewAutoMixVoicePersona
    )({ sender: mainWindow.webContents }, {
      voicePersonaId: "natural-life@1",
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.previewAutoMixVoicePersona,
        "17171717-1717-4171-8171-171717171717"
      )
    });
    controller.previewAutoMixVoicePersona = originalPreviewAutoMixVoicePersona;
    assert.equal(rejectedInvalidWavPreview.ok, true);
    assert.equal(rejectedInvalidWavPreview.data.audioDataUrl, null);
    const rejectedApprovalAfterInvalidWav = await handlers.get(
      CONTENT_ENGINE_CHANNELS.approveAutoMixVoicePersona
    )({ sender: mainWindow.webContents }, {
      voicePersonaId: "natural-life@1",
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.approveAutoMixVoicePersona,
        "18181818-1818-4181-8181-181818181818"
      )
    });
    assert.equal(rejectedApprovalAfterInvalidWav.ok, false);
    assert.equal(
      rejectedApprovalAfterInvalidWav.code,
      "auto_mix_voice_preview_required"
    );

    const previewAfterRedesign = await handlers.get(
      CONTENT_ENGINE_CHANNELS.previewAutoMixVoicePersona
    )({ sender: mainWindow.webContents }, {
      voicePersonaId: "natural-life@1",
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.previewAutoMixVoicePersona,
        "15151515-1515-4151-8151-151515151515"
      )
    });
    assert.equal(previewAfterRedesign.ok, true);
    assert.match(previewAfterRedesign.data.audioDataUrl, /^data:audio\/wav;base64,/u);

    const freshSessionHandlers = new Map();
    const freshSessionRegistration = registerContentEngineIpc({
      controller: {
        ...controller,
        onUpdate: () => () => {}
      },
      bailianKeyStore,
      diagnosticLogger,
      electron,
      getMainWindow: () => mainWindow,
      ipcMain: {
        handle: (channel, handler) => freshSessionHandlers.set(channel, handler)
      }
    });
    const rejectedApprovalAfterRestart = await freshSessionHandlers.get(
      CONTENT_ENGINE_CHANNELS.approveAutoMixVoicePersona
    )({ sender: mainWindow.webContents }, {
      voicePersonaId: "natural-life@1",
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.approveAutoMixVoicePersona,
        "16161616-1616-4161-8161-161616161616"
      )
    });
    freshSessionRegistration.dispose();
    assert.equal(rejectedApprovalAfterRestart.ok, false);
    assert.equal(
      rejectedApprovalAfterRestart.code,
      "auto_mix_voice_preview_required"
    );

    const approvedVoicePersona = await handlers.get(
      CONTENT_ENGINE_CHANNELS.approveAutoMixVoicePersona
    )({ sender: mainWindow.webContents }, {
      voicePersonaId: "natural-life@1",
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.approveAutoMixVoicePersona,
        "99999999-9999-4999-8999-999999999999"
      )
    });
    assert.equal(approvedVoicePersona.ok, true);
    assert.equal(approvedVoicePersona.data.approvalStatus, "approved");
    assert.deepEqual(Object.keys(approvedVoicePersona.data).sort(), [
      "approvalStatus", "catalogVersion", "category", "displayName", "evidenceNote",
      "previewStatus", "previewText", "provider", "provisioningStatus", "researchDate", "voicePersonaId"
    ]);
    assert.equal(JSON.stringify(approvedVoicePersona).includes("must-not-leak"), false);
    const approveVoiceCallCount = calls.filter(
      (call) => call[0] === "approveAutoMixVoicePersona"
    ).length;
    const rejectedConsumedVoiceApproval = await handlers.get(
      CONTENT_ENGINE_CHANNELS.approveAutoMixVoicePersona
    )({ sender: mainWindow.webContents }, {
      voicePersonaId: "natural-life@1",
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.approveAutoMixVoicePersona,
        "19191919-1919-4191-8191-191919191919"
      )
    });
    assert.equal(rejectedConsumedVoiceApproval.ok, false);
    assert.equal(
      rejectedConsumedVoiceApproval.code,
      "auto_mix_voice_preview_required"
    );
    assert.equal(
      calls.filter((call) => call[0] === "approveAutoMixVoicePersona").length,
      approveVoiceCallCount,
      "批准后必须消费本次会话的试听资格"
    );
    const replayedVoiceApproval = await handlers.get(
      CONTENT_ENGINE_CHANNELS.approveAutoMixVoicePersona
    )({ sender: mainWindow.webContents }, {
      voicePersonaId: "natural-life@1",
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.approveAutoMixVoicePersona,
        "99999999-9999-4999-8999-999999999999"
      )
    });
    assert.equal(replayedVoiceApproval.ok, false);
    assert.equal(replayedVoiceApproval.code, "trusted_user_click_required");
    assert.equal(
      calls.filter((call) => call[0] === "approveAutoMixVoicePersona").length,
      approveVoiceCallCount,
      "审批点击 token 重放不得到达内容引擎"
    );

    const rejectedPrivateMusicField = await handlers.get(
      CONTENT_ENGINE_CHANNELS.importMusicCatalogTrack
    )({ sender: mainWindow.webContents }, {
      ...calls.find((call) => call[0] === "importMusicCatalogTrack")[1],
      fingerprint: "renderer-must-not-supply-this",
      clickToken: autoMixClickToken(
        CONTENT_ENGINE_CHANNELS.importMusicCatalogTrack,
        "66666666-6666-4666-8666-666666666666"
      )
    });
    assert.equal(rejectedPrivateMusicField.ok, false);

    for (const [channel, payload] of [
      [CONTENT_ENGINE_CHANNELS.createAutoMixV2, {
        specVersion: "2",
        assetIds: [asset().asset_id],
        title: "标题",
        copyFramework: "框架",
        durationMs: 60_000
      }],
      [CONTENT_ENGINE_CHANNELS.getAutoMixPlanV2, {
        projectId: creativeProjectId,
        runId: autoMixRunId
      }],
      [CONTENT_ENGINE_CHANNELS.regenerateAutoMixLayer, {
        projectId: creativeProjectId,
        layer: "all"
      }],
      [CONTENT_ENGINE_CHANNELS.importMusicCatalogTrack, {
        displayName: "稳健节奏",
        source: "用户授权曲库",
        commercialScope: "commercial social media",
        commercialUseAllowed: true,
        licenseStatus: "valid",
        expiresAt: null,
        credentialReference: "",
        bpm: 104,
        moods: ["steady"],
        energy: 0.56,
        loopStartMs: null,
        loopEndMs: null,
        clickToken: autoMixClickToken(
          CONTENT_ENGINE_CHANNELS.importMusicCatalogTrack,
          "77777777-7777-4777-8777-777777777777"
        )
      }]
    ]) {
      const event = channel === CONTENT_ENGINE_CHANNELS.importMusicCatalogTrack
        ? { sender: mainWindow.webContents }
        : {};
      const rejected = await handlers.get(channel)(event, payload);
      assert.equal(rejected.ok, false);
    }

    // Product projects use the same creative_project_* identity returned by
    // creation. The follow-up generation/list handlers must accept that exact
    // opaque id instead of applying the legacy project_* prefix.
    const createdProduct = await handlers.get(
      CONTENT_ENGINE_CHANNELS.createOneClickProject
    )({}, {
      name: "商品测试",
      assetIds: [asset().asset_id],
      options: { durationMs: 75_000, targetCount: 1 }
    });
    assert.equal(createdProduct.ok, true);
    assert.equal(createdProduct.data.projectId, creativeProjectId);
    const loadedProduct = await handlers.get(
      CONTENT_ENGINE_CHANNELS.getCreativeProject
    )({}, { projectId: creativeProjectId });
    assert.equal(loadedProduct.ok, true);
    assert.equal(loadedProduct.data.audioStrategy.sourceCoverage, 0.12);
    assert.equal(loadedProduct.data.audioStrategy.sourceCoverageThreshold, 0.7);
    assert.equal(loadedProduct.data.voiceMetadata.reason, "source_speech_below_threshold");
    assert.equal(loadedProduct.data.analysisContext.assetName, "清洁机器人.mp4");
    assert.equal(loadedProduct.data.analysisSkippedAssets[0].errorCode, "cloud_transcription_failed");
    assert.equal(JSON.stringify(loadedProduct).includes("must-not-leak"), false);
    const productGeneration = await handlers.get(
      CONTENT_ENGINE_CHANNELS.generateOneClickCandidates
    )({}, {
      projectId: createdProduct.data.projectId,
      options: { durationMs: 75_000, targetCount: 1 }
    });
    assert.equal(productGeneration.ok, true);
    assert.deepEqual(
      calls.find((call) => call[0] === "generateOneClickCandidates"),
      ["generateOneClickCandidates", creativeProjectId, { targetCount: 1, durationMs: 75_000, coverMode: "ai_generate" }]
    );
    const productCandidates = await handlers.get(
      CONTENT_ENGINE_CHANNELS.listOneClickCandidates
    )({}, { projectId: creativeProjectId, limit: 5 });
    assert.equal(productCandidates.ok, true);
    assert.equal(productCandidates.data.items[0].projectId, creativeProjectId);
    assert.equal(
      diagnosticOperations.length,
      0,
      "successful IPC operations must not create repair diagnostics"
    );

    const getCreativeProject = controller.getCreativeProject;
    controller.getCreativeProject = async () => {
      throw Object.assign(new Error("read failed"), { code: "creative_project_not_found" });
    };
    const failedProjectRead = await handlers.get(
      CONTENT_ENGINE_CHANNELS.getCreativeProject
    )({}, { projectId: creativeProjectId });
    assert.equal(failedProjectRead.ok, false);
    const repeatedFailedProjectRead = await handlers.get(
      CONTENT_ENGINE_CHANNELS.getCreativeProject
    )({}, { projectId: creativeProjectId });
    assert.equal(repeatedFailedProjectRead.ok, false);
    const readFailureEvents = diagnosticEvents.filter(
      (entry) => entry[1] === "get-creative-project.failed"
    );
    assert.equal(
      readFailureEvents.length,
      1,
      "a continuous polling failure must retain one actionable error log"
    );
    assert.equal(readFailureEvents[0][2]?.error_code, "creative_project_not_found");
    assert.equal(readFailureEvents[0][3]?.level, "error");
    controller.getCreativeProject = getCreativeProject;
    const recoveredProjectRead = await handlers.get(
      CONTENT_ENGINE_CHANNELS.getCreativeProject
    )({}, { projectId: creativeProjectId });
    assert.equal(recoveredProjectRead.ok, true);
    controller.getCreativeProject = async () => {
      throw Object.assign(new Error("read failed again"), { code: "creative_project_not_found" });
    };
    const failedAfterRecovery = await handlers.get(
      CONTENT_ENGINE_CHANNELS.getCreativeProject
    )({}, { projectId: creativeProjectId });
    controller.getCreativeProject = getCreativeProject;
    assert.equal(failedAfterRecovery.ok, false);
    assert.equal(
      diagnosticEvents.filter(
        (entry) => entry[1] === "get-creative-project.failed"
      ).length,
      2,
      "the same failure after a successful recovery must create a new diagnostic"
    );

    const listOneClickCandidates = controller.listOneClickCandidates;
    controller.listOneClickCandidates = async () => {
      throw Object.assign(new Error("candidate read failed"), { code: "generated_video_not_found" });
    };
    const failedCandidateRead = await handlers.get(
      CONTENT_ENGINE_CHANNELS.listOneClickCandidates
    )({}, { projectId: creativeProjectId, limit: 5 });
    controller.listOneClickCandidates = listOneClickCandidates;
    assert.equal(failedCandidateRead.ok, false);
    const candidateReadFailureEvents = diagnosticEvents.filter(
      (entry) => entry[1] === "list-one-click-candidates.failed"
    );
    assert.equal(
      candidateReadFailureEvents.length,
      1,
      "a failed candidate read must retain one actionable error log"
    );
    assert.equal(candidateReadFailureEvents[0][2]?.error_code, "generated_video_not_found");
    assert.equal(candidateReadFailureEvents[0][3]?.level, "error");

    controller.getCreativeProject = async () => {
      throw Object.assign(new Error("sk-secret must not leak"), {
        code: "C:\\private\\sk-secret"
      });
    };
    const unsafeReadFailure = await handlers.get(
      CONTENT_ENGINE_CHANNELS.getCreativeProject
    )({}, { projectId: creativeProjectId });
    controller.getCreativeProject = getCreativeProject;
    assert.equal(unsafeReadFailure.ok, false);
    const sanitizedReadFailure = diagnosticEvents.filter(
      (entry) => entry[1] === "get-creative-project.failed"
    ).at(-1);
    assert.equal(sanitizedReadFailure[2]?.error_code, "unknown_error");
    assert.equal(JSON.stringify(sanitizedReadFailure).includes("sk-secret"), false);
    assert.equal(JSON.stringify(sanitizedReadFailure).includes("C:\\private"), false);

    const recoveredAfterUnsafeCode = await handlers.get(
      CONTENT_ENGINE_CHANNELS.getCreativeProject
    )({}, { projectId: creativeProjectId });
    assert.equal(recoveredAfterUnsafeCode.ok, true);
    controller.getCreativeProject = async () => {
      throw Object.assign(new Error("key-shaped code must not leak"), {
        code: "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"
      });
    };
    const keyShapedFailure = await handlers.get(
      CONTENT_ENGINE_CHANNELS.getCreativeProject
    )({}, { projectId: creativeProjectId });
    controller.getCreativeProject = getCreativeProject;
    assert.equal(keyShapedFailure.ok, false);
    const sanitizedKeyShapedFailure = diagnosticEvents.filter(
      (entry) => entry[1] === "get-creative-project.failed"
    ).at(-1);
    assert.equal(sanitizedKeyShapedFailure[2]?.error_code, "unknown_error");
    assert.equal(JSON.stringify(sanitizedKeyShapedFailure).includes("sk-ABC"), false);

    for (const secretShapedCode of [
      "LTAI5tABCDEFGHIJKLMNOPQRSTUVWXYZ1234",
      "sk_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"
    ]) {
      const recoveredBeforeSecretShape = await handlers.get(
        CONTENT_ENGINE_CHANNELS.getCreativeProject
      )({}, { projectId: creativeProjectId });
      assert.equal(recoveredBeforeSecretShape.ok, true);
      controller.getCreativeProject = async () => {
        throw Object.assign(new Error("secret-shaped code must not leak"), {
          code: secretShapedCode
        });
      };
      const secretShapedFailure = await handlers.get(
        CONTENT_ENGINE_CHANNELS.getCreativeProject
      )({}, { projectId: creativeProjectId });
      controller.getCreativeProject = getCreativeProject;
      assert.equal(secretShapedFailure.ok, false);
      const sanitizedSecretShapedFailure = diagnosticEvents.filter(
        (entry) => entry[1] === "get-creative-project.failed"
      ).at(-1);
      assert.equal(sanitizedSecretShapedFailure[2]?.error_code, "unknown_error");
      assert.equal(
        JSON.stringify(sanitizedSecretShapedFailure).includes(secretShapedCode),
        false
      );
    }

    const presets = await handlers.get(
      CONTENT_ENGINE_CHANNELS.listPackagingPresets
    )({}, { kind: "course" });
    assert.equal(presets.data.items[0].presetId, "knowledge_focus");
    assert.equal(JSON.stringify(presets).includes("must-not-leak"), false);
    const allPresets = await handlers.get(
      CONTENT_ENGINE_CHANNELS.listPackagingPresets
    )({}, {});
    assert.equal(allPresets.data.items[0].presetId, "hook_impact");
    assert.deepEqual(
      calls.filter((call) => call[0] === "listPackagingPresets"),
      [["listPackagingPresets", "course"], ["listPackagingPresets", undefined]]
    );
    const brands = await handlers.get(
      CONTENT_ENGINE_CHANNELS.listBrandProfiles
    )({}, {});
    assert.equal(brands.data.items[0].brandProfileId, brandProfileId);
    assert.equal(JSON.stringify(brands).includes("must-not-leak"), false);
    const savedBrand = await handlers.get(
      CONTENT_ENGINE_CHANNELS.saveBrandProfile
    )({}, {
      name: "轻品牌",
      logoAssetId: asset().asset_id,
      primaryColor: "#5b4bff",
      accentColor: "#ffd84d",
      fontPreset: "microsoft_yahei",
      outroText: "关注我们"
    });
    assert.equal(savedBrand.data.brandProfileId, brandProfileId);
    assert.deepEqual(
      calls.find((call) => call[0] === "saveBrandProfile")[1],
      {
        brand_profile_id: undefined,
        name: "轻品牌",
        logo_asset_id: asset().asset_id,
        primary_color: "#5B4BFF",
        accent_color: "#FFD84D",
        font_preset: "microsoft_yahei",
        reference_portrait_asset_id: undefined,
        outro_text: "关注我们"
      }
    );
    const cost = await handlers.get(
      CONTENT_ENGINE_CHANNELS.getPackagingCostEstimate
    )({}, { candidateIds: [generatedVideoId], coverMode: "ai_generate" });
    assert.equal(cost.data.estimatedImageCalls, 1);
    assert.equal(cost.data.providerConfigured, true);
    const defaultCost = await handlers.get(
      CONTENT_ENGINE_CHANNELS.getPackagingCostEstimate
    )({}, { candidateIds: [generatedVideoId] });
    assert.equal(defaultCost.data.estimatedImageCalls, 1);
    assert.deepEqual(
      calls.filter((call) => call[0] === "getPackagingCostEstimate").at(-1),
      ["getPackagingCostEstimate", [generatedVideoId], "ai_generate", undefined]
    );
    const plannedCost = await handlers.get(
      CONTENT_ENGINE_CHANNELS.getPackagingCostEstimate
    )({}, { candidateIds: [], coverMode: "ai_generate", plannedCount: 5 });
    assert.equal(plannedCost.data.estimatedImageCalls, 5);
    assert.deepEqual(
      calls.find((call) => call[0] === "getPackagingCostEstimate" && call[3] === 5),
      ["getPackagingCostEstimate", [], "ai_generate", 5]
    );
    const packaged = await handlers.get(
      CONTENT_ENGINE_CHANNELS.packageGeneratedVideos
    )({}, {
      candidateIds: [generatedVideoId],
      packagingMode: "auto",
      brandProfileId,
      coverMode: "local_frame",
      reuseCover: true
    });
    assert.equal(packaged.data.taskId, packagingTaskId);
    assert.deepEqual(
      calls.find((call) => call[0] === "packageGeneratedVideos").slice(1),
      [[generatedVideoId], {
        packagingMode: "auto",
        packagingPresetId: undefined,
        brandProfileId,
        coverMode: "local_frame",
        reuseCover: true
      }]
    );
    const repackaged = await handlers.get(
      CONTENT_ENGINE_CHANNELS.repackageVideo
    )({}, {
      candidateId: generatedVideoId,
      packagingMode: "preset",
      packagingPresetId: "knowledge_focus",
      coverMode: "local_frame",
      reuseCover: true
    });
    assert.equal(repackaged.data.taskId, packagingTaskId);
    const preflight = await handlers.get(
      CONTENT_ENGINE_CHANNELS.preflightVisualComparison
    )({}, { candidateId: generatedVideoId });
    assert.deepEqual(preflight, {
      ok: true,
      data: {
        eligible: true,
        reason: "ready",
        renderCount: 3,
        bailianCalls: 0,
        apimartCalls: 0,
        remotionAvailable: true,
        visualComparisonAvailable: true,
        aiCoverVerified: false,
        remotionAccepted: false,
        phoneReviewed: false
      }
    });
    const comparison = await handlers.get(
      CONTENT_ENGINE_CHANNELS.createVisualComparisonTask
    )({}, { candidateId: generatedVideoId });
    assert.equal(comparison.ok, true);
    assert.equal(comparison.data.taskId, comparisonTaskId);
    assert.equal(comparison.data.comparisonGroupId, comparisonTaskId);
    assert.equal(comparison.data.comparisonSourceCandidateId, generatedVideoId);
    assert.deepEqual(comparison.data.styleOrder, [
      "social_pop", "neo_editorial", "tech_motion"
    ]);
    assert.deepEqual(
      [comparison.data.bailianCalls, comparison.data.apimartCalls, comparison.data.renderCount],
      [0, 0, 3]
    );
    assert.equal(JSON.stringify(preflight).includes("must-not-leak"), false);
    assert.equal(JSON.stringify(comparison).includes("must-not-leak"), false);
    const comparisonCallCount = calls.filter((call) => [
      "preflightVisualComparison", "createVisualComparisonTask"
    ].includes(call[0])).length;
    for (const [channel, payload, expectedCode] of [
      [CONTENT_ENGINE_CHANNELS.preflightVisualComparison, {
        candidateId: generatedVideoId,
        path: "C:\\must-not-leak",
        apiKey: "must-not-leak-key"
      }, "invalid_params"],
      [CONTENT_ENGINE_CHANNELS.createVisualComparisonTask, {
        candidateId: "C:\\must-not-leak\\candidate.mp4"
      }, "invalid_id"]
    ]) {
      const rejected = await handlers.get(channel)({}, payload);
      assert.equal(rejected.ok, false);
      assert.equal(rejected.code, expectedCode);
    }
    assert.equal(calls.filter((call) => [
      "preflightVisualComparison", "createVisualComparisonTask"
    ].includes(call[0])).length, comparisonCallCount);
    const generated = await handlers.get(
      CONTENT_ENGINE_CHANNELS.listGeneratedVideos
    )({}, { limit: 10 });
    assert.equal(generated.data.items[0].requestedEngine, "remotion");
    assert.equal(generated.data.items[0].actualEngine, "ffmpeg");
    assert.equal(generated.data.items[0].fallbackCode, "browser_unavailable");
    assert.equal(generated.data.items[0].coverStatus, "outcome_unknown");
    assert.equal(generated.data.items[0].coverPhase, "outcome_unknown");
    assert.equal(generated.data.items[0].coverNetworkSubmitted, true);
    assert.equal(generated.data.items[0].coverIssueCode, "poll_outcome_unknown");
    assert.equal(generated.data.items[0].comparisonGroupId, comparisonTaskId);
    assert.equal(generated.data.items[0].sourceAssetCount, 2);
    assert.equal(generated.data.items[0].shotCount, 6);
    assert.equal(generated.data.items[0].captionSource, "tts_voiceover");
    assert.equal(JSON.stringify(generated).includes("must-not-leak"), false);
    const coverTask = await handlers.get(
      CONTENT_ENGINE_CHANNELS.regenerateCover
    )({}, { candidateId: generatedVideoId });
    assert.equal(coverTask.data.taskId, packagingTaskId);

    for (const [channel, payload, expectedCode] of [
      [CONTENT_ENGINE_CHANNELS.listPackagingPresets, { kind: "movie" }, "invalid_packaging_kind"],
      [CONTENT_ENGINE_CHANNELS.generateCourseCuts, { assetId: asset().asset_id, packagingMode: "preset", packagingPresetId: "hook_impact" }, "invalid_packaging_preset"],
      [CONTENT_ENGINE_CHANNELS.generateCourseCuts, { assetId: asset().asset_id, packagingMode: "none", coverMode: "ai_generate" }, "invalid_cover_mode"],
      [CONTENT_ENGINE_CHANNELS.generateCourseCuts, { assetId: asset().asset_id, packagingMode: "none", coverMode: "none", visualRenderer: { requestedEngine: "remotion", requestedStyleVersion: 1, allowFallback: true } }, "invalid_visual_renderer"],
      [CONTENT_ENGINE_CHANNELS.generateCourseCuts, { assetId: asset().asset_id, visualRenderer: { requestedEngine: "remotion", visualStyleId: "unknown", requestedStyleVersion: 1, allowFallback: true } }, "invalid_visual_renderer"],
      [CONTENT_ENGINE_CHANNELS.generateCourseCuts, { assetId: asset().asset_id, visualRenderer: { requestedEngine: "remotion", requestedStyleVersion: 1, allowFallback: "yes" } }, "invalid_visual_renderer"],
      [CONTENT_ENGINE_CHANNELS.getPackagingCostEstimate, { candidateIds: [generatedVideoId], packagingMode: "none", coverMode: "ai_generate" }, "invalid_cover_mode"],
      [CONTENT_ENGINE_CHANNELS.repackageVideo, { candidateId: generatedVideoId, packagingMode: "preset", coverMode: "local_frame", reuseCover: true }, "packaging_preset_required"],
      [CONTENT_ENGINE_CHANNELS.saveBrandProfile, { name: "x", primaryColor: "red", accentColor: "#ffffff", fontPreset: "microsoft_yahei", outroText: "" }, "invalid_brand_color"]
    ]) {
      const rejected = await handlers.get(channel)({}, payload);
      assert.equal(rejected.ok, false);
      assert.equal(rejected.code, expectedCode);
    }

    const regeneration = await handlers.get(
      CONTENT_ENGINE_CHANNELS.regenerateVideo
    )({}, { candidateId: generatedVideoId });
    assert.deepEqual(regeneration, {
      ok: true,
      data: {
        taskId: regenerationTaskId,
        generatedVideoId
      }
    });
    assert.deepEqual(
      calls.find((call) => call[0] === "regenerateVideo"),
      ["regenerateVideo", generatedVideoId]
    );
    assert.equal(JSON.stringify(regeneration).includes("must-not-leak"), false);

    for (const [channel, payload] of [
      [CONTENT_ENGINE_CHANNELS.getMixProject, { projectId: "C:\\bad" }],
      [CONTENT_ENGINE_CHANNELS.generateMixCandidates, { projectId: mixProjectId, limit: 0, seed: "x" }],
      [CONTENT_ENGINE_CHANNELS.createMixProject, { name: "bad", slots: [{ name: "x", required: true, assetIds: [asset().asset_id], path: "C:\\bad" }], constraints: {} }],
      [CONTENT_ENGINE_CHANNELS.listMixCandidates, { reviewStatus: "maybe" }],
      [CONTENT_ENGINE_CHANNELS.updatePublishQueueItem, { queueItemId: publishQueueId, status: "maybe" }]
    ]) {
      const rejected = await handlers.get(channel)({}, payload);
      assert.equal(rejected.ok, false);
    }

    const diagnosticOperationCountBeforeCancel = diagnosticOperations.length;
    const diagnosticEventCountBeforeCancel = diagnosticEvents.length;
    const originalShowOpenDialog = electron.dialog.showOpenDialog;
    electron.dialog.showOpenDialog = async () => {
      throw Object.assign(new Error("dialog failed"), { code: "CONTENT_ENGINE_OPEN_FAILED" });
    };
    const failedSelection = await handlers.get(
      CONTENT_ENGINE_CHANNELS.chooseFiles
    )();
    electron.dialog.showOpenDialog = originalShowOpenDialog;
    assert.equal(failedSelection.ok, false);
    const recoveryCountBeforeCancel = diagnosticRecoveries.length;
    dialogQueue.push({ canceled: true, filePaths: [] });
    const cancelledSelection = await handlers.get(
      CONTENT_ENGINE_CHANNELS.chooseFiles
    )();
    assert.deepEqual(cancelledSelection, {
      ok: false,
      code: "CONTENT_DIALOG_CANCELLED",
      error: "已取消选择。"
    });
    assert.equal(diagnosticOperations.length, diagnosticOperationCountBeforeCancel);
    assert.equal(
      diagnosticEvents.length,
      diagnosticEventCountBeforeCancel + 1,
      "cancelling a file dialog is a normal user action, not a repair diagnostic"
    );
    assert.equal(
      diagnosticRecoveries.length,
      recoveryCountBeforeCancel + 1,
      "cancelling after a failed attempt must reset the real logger dedupe state"
    );

    const shellCountBeforeMismatch = shown.length + opened.length;
    controller.resolveAssetPath = async () => ({
      asset_id: "asset_99999999999999999999999999999999",
      absolute_path: sourceFile
    });
    const mismatchedAssetResolution = await handlers.get(
      CONTENT_ENGINE_CHANNELS.revealAsset
    )({}, { assetId: asset().asset_id });
    assert.deepEqual(mismatchedAssetResolution, {
      ok: false,
      code: "CONTENT_ENGINE_RESPONSE_INVALID",
      error: "内容引擎返回了无效结果。"
    });
    assert.equal(shown.length + opened.length, shellCountBeforeMismatch);

    const invalidId = await handlers.get(CONTENT_ENGINE_CHANNELS.archiveAsset)(
      {},
      { assetId: sourceFile }
    );
    assert.deepEqual(invalidId, {
      ok: false,
      code: "invalid_id",
      error: "记录标识无效。"
    });
    assert.equal(
      calls.filter((call) => call[0] === "archiveAsset").length,
      1,
      "an invalid renderer id must never reach the worker"
    );

    const invalidRights = await handlers.get(
      CONTENT_ENGINE_CHANNELS.updateAssetRights
    )({}, { assetId: asset().asset_id, rightsStatus: "consented" });
    assert.equal(invalidRights.ok, false);
    assert.equal(invalidRights.code, "invalid_rights_status");
    assert.equal(
      calls.filter((call) => call[0] === "updateAssetRights").length,
      1,
      "an invalid rights status must never reach the worker"
    );

    const unavailableCapability = publicError(Object.assign(
      new Error("C:\\must-not-leak\\ffprobe.exe"),
      { code: "capability_unavailable" }
    ));
    assert.deepEqual(unavailableCapability, {
      ok: false,
      code: "capability_unavailable",
      error: "媒体分析组件当前不可用，请安装或恢复组件后重试。"
    });
    assert.equal(JSON.stringify(unavailableCapability).includes("must-not-leak"), false);

    const metadataPending = publicError(Object.assign(
      new Error("Analyze media metadata first."),
      { code: "media_metadata_unavailable" }
    ));
    assert.deepEqual(metadataPending, {
      ok: false,
      code: "media_metadata_unavailable",
      error: "素材正在读取时长和音轨，请等待读取完成后再生成。"
    });

    assert.deepEqual(publicError(Object.assign(new Error("private provider detail"), {
      code: "auto_mix_alternate_voice_required"
    })), {
      ok: false,
      code: "auto_mix_alternate_voice_required",
      error: "暂时没有查到唯一的配音结果，请稍后再试。"
    });
    assert.deepEqual(publicError(Object.assign(new Error("private provider detail"), {
      code: "auto_mix_voice_reconciliation_unavailable"
    })), {
      ok: false,
      code: "auto_mix_voice_reconciliation_unavailable",
      error: "暂时无法查询配音结果，请检查网络后稍后再试。"
    });
    assert.deepEqual(publicError(Object.assign(new Error("private state detail"), {
      code: "auto_mix_run_stale"
    })), {
      ok: false,
      code: "auto_mix_run_stale",
      error: "任务已有新的处理结果，已切换到最新步骤，请按当前提示继续。"
    });
    assert.deepEqual(publicError(Object.assign(new Error("private state detail"), {
      code: "auto_mix_recovery_layer_mismatch"
    })), {
      ok: false,
      code: "auto_mix_recovery_layer_mismatch",
      error: "请按当前质量提示恢复对应内容层。"
    });

    updateListener({
      state: "failed",
      available: true,
      version: "",
      capabilities: {},
      code: "CONTENT_ENGINE_EXITED",
      runtimePath: "C:\\must-not-leak\\worker.exe"
    });
    assert.deepEqual(sent, [{
      channel: CONTENT_ENGINE_CHANNELS.update,
      payload: {
        state: "failed",
        available: true,
        version: "",
        capabilities: {},
        code: "CONTENT_ENGINE_EXITED"
      }
    }]);
    assert.equal(JSON.stringify(sent).includes("must-not-leak"), false);

    registration.dispose();
    assert.equal(unsubscribed, true);

    assert.deepEqual(stripPrivateValue({
      outputPath: sourceFile,
      nested: { folder: root, safe: "ok" }
    }), { nested: { safe: "ok" } });

    console.log("content-engine IPC self-check passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
