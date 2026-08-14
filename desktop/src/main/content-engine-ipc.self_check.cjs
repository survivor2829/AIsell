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
  const exportDirectory = path.join(root, "export-package");
  fs.writeFileSync(sourceFile, "video");
  fs.writeFileSync(finishedFile, "finished");
  fs.mkdirSync(exportDirectory);

  try {
    const handlers = new Map();
    const sent = [];
    const calls = [];
    const shown = [];
    const opened = [];
    let updateListener = null;
    let unsubscribed = false;
    let storedBailianKey = "";
    const bailianKeyStore = {
      status: () => ({
        configured: Boolean(storedBailianKey),
        maskedKey: storedBailianKey ? "sk-***" : "",
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
        return { items: [task()] };
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
      regenerateVideo: async (candidateId) => {
        calls.push(["regenerateVideo", candidateId]);
        return {
          task_id: regenerationTaskId,
          generated_video_id: generatedVideoId,
          status: "queued",
          absolute_path: "C:\\must-not-leak\\candidate.mp4"
        };
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
    for (const [channel, expectedStatus] of [
      [CONTENT_ENGINE_CHANNELS.pauseTask, "paused"],
      [CONTENT_ENGINE_CHANNELS.resumeTask, "analyzing"],
      [CONTENT_ENGINE_CHANNELS.cancelTask, "cancelled"]
    ]) {
      const response = await handlers.get(channel)({}, { taskId: task().task_id });
      assert.equal(response.ok, true);
      assert.equal(response.data.status, expectedStatus);
    }

    const listedFinished = await handlers.get(CONTENT_ENGINE_CHANNELS.listFinished)(
      {},
      { limit: 20 }
    );
    assert.equal(listedFinished.ok, true);
    assert.equal(listedFinished.data.items[0].finishedVideoId, finished().finished_video_id);
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
    const missingVoice = await handlers.get(
      CONTENT_ENGINE_CHANNELS.generateMixBatch
    )({}, {
      assetIds: [asset().asset_id],
      theme: "test",
      targetCount: 30
    });
    assert.equal(missingVoice.ok, false);
    assert.equal(missingVoice.code, "invalid_voice_asset");

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

    dialogQueue.push({ canceled: true, filePaths: [] });
    const cancelledSelection = await handlers.get(
      CONTENT_ENGINE_CHANNELS.chooseFiles
    )();
    assert.deepEqual(cancelledSelection, {
      ok: false,
      code: "CONTENT_DIALOG_CANCELLED",
      error: "已取消选择。"
    });

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
