const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createContentEngineSidecar,
  parseReady
} = require("./content-engine-sidecar.cjs");

class FakeChild extends EventEmitter {
  constructor({ closeOnKill = true } = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = new EventEmitter();
    this.stdin.writes = [];
    this.stdin.write = (line, _encoding, callback) => {
      this.stdin.writes.push(JSON.parse(line));
      callback?.();
      this.emit("request", this.stdin.writes.at(-1));
      return true;
    };
    this.closeOnKill = closeOnKill;
    this.killedSignals = [];
  }

  kill(signal) {
    this.killedSignals.push(signal);
    if (this.closeOnKill) {
      setImmediate(() => this.emit("close", null, signal));
    }
    return true;
  }

  ready(overrides = {}) {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify({
      type: "ready",
      service: "content-engine",
      version: "0.1.0",
      protocol_version: 1,
      capabilities: {
        asset_index: true,
        finished_videos: true,
        path_redaction: true
      },
      ...overrides
    })}\n`, "utf8"));
  }

  respond(request, result) {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify({
      id: request.id,
      ok: true,
      result
    })}\n`, "utf8"));
  }

  respondWithSplitUtf8(request, result, text) {
    const line = Buffer.from(`${JSON.stringify({
      id: request.id,
      ok: true,
      result
    })}\n`, "utf8");
    const start = line.indexOf(Buffer.from(text, "utf8"));
    assert.notEqual(start, -1, "split marker must be present in response");
    this.stdout.emit("data", line.subarray(0, start + 1));
    this.stdout.emit("data", line.subarray(start + 1));
  }
}

async function waitFor(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function main() {
  assert.deepEqual(parseReady({
    type: "ready",
    service: "content-engine",
    version: "0.1.0",
    protocol_version: 1,
    capabilities: { asset_index: true, injected: "no" }
  }), {
    version: "0.1.0",
    protocolVersion: 1,
    capabilities: { asset_index: true }
  });
  assert.equal(parseReady({ type: "ready", service: "attacker" }), null);
  assert.equal(parseReady({
    type: "ready",
    service: "content-engine",
    protocol_version: 2
  }), null);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-content-engine-sidecar-"));
  const runtimePath = path.join(root, "content-engine-worker.exe");
  const dataDir = path.join(root, "data");
  fs.writeFileSync(runtimePath, "");

  try {
    {
      let spawnCount = 0;
      const controller = createContentEngineSidecar({
        runtimePath: "",
        dataDir,
        existsSync: () => false,
        spawnProcess: () => {
          spawnCount += 1;
          return new FakeChild();
        }
      });
      assert.deepEqual(controller.status(), {
        state: "unavailable",
        available: false,
        version: "",
        protocolVersion: 0,
        capabilities: {},
        code: "CONTENT_ENGINE_RUNTIME_UNAVAILABLE"
      });
      assert.equal((await controller.start()).state, "unavailable");
      assert.equal(spawnCount, 0);
    }

    {
      const spawnCalls = [];
      const updates = [];
      const child = new FakeChild();
      const controller = createContentEngineSidecar({
        runtimePath,
        runtimeArgs: ["worker.py"],
        dataDir,
        getTrustedRuntimeEnvironment: () => ({
          XIAOXI_REMOTION_NODE_PATH: "C:\\trusted\\node.exe",
          XIAOXI_REMOTION_WORKER_PATH: "C:\\trusted\\worker.mjs",
          XIAOXI_REMOTION_BUNDLE_PATH: "C:\\trusted\\bundle",
          XIAOXI_REMOTION_BROWSER_PATH: "C:\\trusted\\browser.exe",
          XIAOXI_REMOTION_ELECTRON_RUN_AS_NODE: "1",
          DASHSCOPE_API_KEY: "runtime-key-canary",
          PATH: "runtime-path-canary"
        }),
        spawnProcess: (command, args, options) => {
          spawnCalls.push({ command, args, options });
          return child;
        }
      });
      controller.onUpdate((status) => updates.push(status));
      const first = controller.start();
      const second = controller.start();
      await waitFor(() => spawnCalls.length === 1);
      assert.equal(spawnCalls[0].command, runtimePath);
      assert.deepEqual(spawnCalls[0].args, ["worker.py", "--data-dir", dataDir]);
      assert.equal(spawnCalls[0].options.shell, false);
      assert.equal(spawnCalls[0].options.windowsHide, true);
      assert.equal(spawnCalls[0].options.env.PYTHONIOENCODING, "utf-8");
      assert.equal(spawnCalls[0].options.env.PYTHONUTF8, "1");
      assert.equal(
        spawnCalls[0].options.env.XIAOXI_REMOTION_WORKER_PATH,
        "C:\\trusted\\worker.mjs"
      );
      assert.equal(spawnCalls[0].options.env.XIAOXI_REMOTION_ELECTRON_RUN_AS_NODE, "1");
      assert.notEqual(spawnCalls[0].options.env.DASHSCOPE_API_KEY, "runtime-key-canary");
      assert.notEqual(spawnCalls[0].options.env.PATH, "runtime-path-canary");
      child.ready();
      const [firstStatus, secondStatus] = await Promise.all([first, second]);
      assert.deepEqual(secondStatus, firstStatus);
      assert.equal(firstStatus.state, "ready");
      assert.equal(firstStatus.version, "0.1.0");
      assert.equal(JSON.stringify({ firstStatus, updates }).includes(runtimePath), false);
      assert.equal(JSON.stringify({ firstStatus, updates }).includes(dataDir), false);

      const assetsPromise = controller.listAssets({
        includeArchived: false,
        limit: 20
      });
      const tasksPromise = controller.listTasks({ limit: 10 });
      await waitFor(() => child.stdin.writes.length === 2);
      const [assetRequest, taskRequest] = child.stdin.writes;
      assert.notEqual(assetRequest.id, taskRequest.id);
      assert.equal(assetRequest.method, "list_assets");
      assert.deepEqual(assetRequest.params, {
        include_archived: false,
        limit: 20
      });
      child.respond(taskRequest, { items: [{ task_id: "task_one" }] });
      child.respondWithSplitUtf8(
        assetRequest,
        { items: [{ asset_id: "asset_one", display_name: "导师课程.mp4" }] },
        "导"
      );
      assert.deepEqual(await assetsPromise, {
        items: [{ asset_id: "asset_one", display_name: "导师课程.mp4" }]
      });
      assert.deepEqual(await tasksPromise, {
        items: [{ task_id: "task_one" }]
      });

      const reviewTaskId = "task_11111111111111111111111111111111";
      const resumeReview = controller.resumeTask(reviewTaskId);
      await waitFor(() => child.stdin.writes.length === 3);
      child.respond(child.stdin.writes[2], {
        items: [{
          task_id: reviewTaskId,
          task_type: "course_clipping",
          status: "paused",
          resume_from_status: "ready_for_review"
        }]
      });
      await waitFor(() => child.stdin.writes.length === 4);
      assert.equal(child.stdin.writes[3].method, "update_task");
      assert.deepEqual(child.stdin.writes[3].params, {
        task_id: reviewTaskId,
        status: "ready_for_review"
      });
      child.respond(child.stdin.writes[3], {
        task_id: reviewTaskId,
        task_type: "course_clipping",
        status: "ready_for_review",
        resume_from_status: null
      });
      assert.equal((await resumeReview).status, "ready_for_review");

      const importTaskId = "task_22222222222222222222222222222222";
      const resumeImport = controller.resumeTask(importTaskId);
      await waitFor(() => child.stdin.writes.length === 5);
      child.respond(child.stdin.writes[4], {
        items: [{
          task_id: importTaskId,
          task_type: "asset_import",
          status: "paused",
          resume_from_status: "analyzing"
        }]
      });
      await waitFor(() => child.stdin.writes.length === 6);
      assert.equal(child.stdin.writes[5].method, "resume_import_folder");
      assert.deepEqual(child.stdin.writes[5].params, {
        task_id: importTaskId,
        batch_size: 200
      });
      child.respond(child.stdin.writes[5], {
        task_id: importTaskId,
        status: "completed",
        has_more: false,
        items: []
      });
      await waitFor(() => child.stdin.writes.length === 7);
      child.respond(child.stdin.writes[6], {
        items: [{
          task_id: importTaskId,
          task_type: "asset_import",
          status: "completed",
          resume_from_status: null
        }]
      });
      assert.equal((await resumeImport).status, "completed");

      const regenerationTaskId = "task_33333333333333333333333333333333";
      const resumeRegeneration = controller.resumeTask(regenerationTaskId);
      await waitFor(() => child.stdin.writes.length === 8);
      child.respond(child.stdin.writes[7], {
        items: [{
          task_id: regenerationTaskId,
          task_type: "creative_regeneration",
          status: "paused",
          resume_from_status: "rendering"
        }]
      });
      await waitFor(() => child.stdin.writes.length === 9);
      assert.equal(child.stdin.writes[8].method, "resume_creative_task");
      assert.deepEqual(child.stdin.writes[8].params, {
        task_id: regenerationTaskId
      });
      child.respond(child.stdin.writes[8], {
        task_id: regenerationTaskId,
        task_type: "creative_regeneration",
        status: "queued",
        resume_from_status: null
      });
      assert.equal((await resumeRegeneration).status, "queued");

      for (const [taskType, taskId] of [
        ["creative_packaging", "task_44444444444444444444444444444444"],
        ["creative_cover", "task_55555555555555555555555555555555"]
      ]) {
        const requestCount = child.stdin.writes.length;
        const resumed = controller.resumeTask(taskId);
        await waitFor(() => child.stdin.writes.length === requestCount + 1);
        child.respond(child.stdin.writes[requestCount], {
          items: [{
            task_id: taskId,
            task_type: taskType,
            status: "paused",
            resume_from_status: "rendering"
          }]
        });
        await waitFor(() => child.stdin.writes.length === requestCount + 2);
        assert.equal(child.stdin.writes[requestCount + 1].method, "resume_creative_task");
        assert.deepEqual(child.stdin.writes[requestCount + 1].params, { task_id: taskId });
        child.respond(child.stdin.writes[requestCount + 1], {
          task_id: taskId,
          task_type: taskType,
          status: "queued",
          resume_from_status: null
        });
        assert.equal((await resumed).status, "queued");
      }

      child.once("request", (request) => {
        assert.equal(request.method, "shutdown");
        child.respond(request, { status: "stopping" });
        setImmediate(() => child.emit("close", 0, null));
      });
      const stopped = await controller.stop();
      assert.equal(stopped.state, "stopped");
      assert.deepEqual(child.killedSignals, []);
    }

    {
      const children = [new FakeChild(), new FakeChild()];
      let spawnCount = 0;
      const controller = createContentEngineSidecar({
        runtimePath,
        dataDir,
        startupTimeoutMs: 100,
        spawnProcess: () => children[spawnCount++]
      });
      const firstStart = controller.start();
      await waitFor(() => children[0].stdout.listenerCount("data") === 1);
      children[0].ready();
      await firstStart;
      children[0].emit("close", 9, null);
      await waitFor(() => controller.status().state === "failed");

      const restarted = controller.restart();
      await waitFor(() => spawnCount === 2);
      children[1].ready();
      assert.equal((await restarted).state, "ready");
      assert.equal(spawnCount, 2);

      const assetId = "asset_33333333333333333333333333333333";
      const probe = controller.probeAsset(assetId);
      await waitFor(() => children[1].stdin.writes.length === 1);
      assert.deepEqual(children[1].stdin.writes[0], {
        id: children[1].stdin.writes[0].id,
        method: "probe_asset",
        params: { asset_id: assetId }
      });
      children[1].respond(children[1].stdin.writes[0], {
        asset_id: assetId,
        probe_status: "ok"
      });
      assert.equal((await probe).probe_status, "ok");

      const pending = controller.probePending();
      await waitFor(() => children[1].stdin.writes.length === 2);
      assert.equal(children[1].stdin.writes[1].method, "probe_pending");
      assert.deepEqual(children[1].stdin.writes[1].params, { limit: 10 });
      children[1].respond(children[1].stdin.writes[1], {
        items: [],
        processed_count: 0,
        remaining_count: 0
      });
      assert.equal((await pending).remaining_count, 0);

      const rights = controller.updateAssetRights(assetId, "licensed");
      await waitFor(() => children[1].stdin.writes.length === 3);
      assert.equal(children[1].stdin.writes[2].method, "update_asset_rights");
      assert.deepEqual(children[1].stdin.writes[2].params, {
        asset_id: assetId,
        rights_status: "licensed"
      });
      children[1].respond(children[1].stdin.writes[2], {
        asset_id: assetId,
        rights_status: "licensed"
      });
      assert.equal((await rights).rights_status, "licensed");

      const projectId = "mix_project_44444444444444444444444444444444";
      const candidateId = "mix_candidate_55555555555555555555555555555555";
      const queueItemId = "publish_queue_66666666666666666666666666666666";
      const packageId = "export_package_77777777777777777777777777777777";
      const generatedVideoId = "generated_video_88888888888888888888888888888888";
      const brandProfileId = "brand_profile_99999999999999999999999999999999";
      const creativeProjectId = "creative_project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const autoMixRunId = "auto_mix_run_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const mixCalls = [
        [controller.generateCourseCuts(assetId, {
          minDurationMs: 30_000,
          maxDurationMs: 90_000,
          count: 5,
          theme: "培训现场价值",
          subtitleFontSize: 42,
          subtitleMarginBottom: 140,
          experimentMode: "standard",
          subtitlePreset: "dynamic_clean",
          packagingMode: "preset",
          packagingPresetId: "knowledge_focus",
          brandProfileId,
          visualRenderer: {
            requestedEngine: "remotion",
            visualStyleId: "tech_motion",
            requestedStyleVersion: 1,
            allowFallback: true
          },
          coverMode: "local_frame"
        }), "generate_course_cuts", {
          asset_id: assetId,
          min_duration_ms: 30_000,
          max_duration_ms: 90_000,
          count: 5,
          theme: "培训现场价值",
          subtitle_font_size: 42,
          subtitle_margin_bottom: 140,
          experiment_mode: "standard",
          subtitle_preset: "dynamic_clean",
          packaging_mode: "preset",
          packaging_preset_id: "knowledge_focus",
          brand_profile_id: brandProfileId,
          visual_renderer: {
            requestedEngine: "remotion",
            visualStyleId: "tech_motion",
            requestedStyleVersion: 1,
            allowFallback: true
          },
          cover_mode: "local_frame"
        }],
        [controller.generateMixBatch([assetId], {
          theme: "培训现场价值", targetCount: 30, voiceAssetId: assetId,
          packagingMode: "auto", brandProfileId, coverMode: "local_frame",
          visualRenderer: {
            requestedEngine: "remotion", requestedStyleVersion: 1,
            allowFallback: true
          }
        }), "generate_mix_batch", {
          asset_ids: [assetId], theme: "培训现场价值", target_count: 30,
          voice_asset_id: assetId, packaging_mode: "auto",
          brand_profile_id: brandProfileId, cover_mode: "local_frame",
          visual_renderer: {
            requestedEngine: "remotion", requestedStyleVersion: 1,
            allowFallback: true
          }
        }],
        [controller.createAutoMixV2({
          specVersion: "2",
          assetIds: [assetId],
          title: "产品标题",
          copyFramework: "真实素材，真实表达。"
        }), "create_auto_mix_v2", {
          specVersion: "2",
          assetIds: [assetId],
          title: "产品标题",
          copyFramework: "真实素材，真实表达。"
        }],
        [controller.getAutoMixPlanV2({ runId: autoMixRunId }), "get_auto_mix_plan_v2", {
          run_id: autoMixRunId
        }],
        [controller.regenerateAutoMixLayer(creativeProjectId, "music", autoMixRunId), "regenerate_auto_mix_layer", {
          project_id: creativeProjectId,
          layer: "music",
          expected_run_id: autoMixRunId
        }],
        [controller.importMusicCatalogTrack({
          sourcePath: "C:\\fixtures\\licensed.wav",
          displayName: "稳健节奏",
          source: "用户授权曲库",
          commercialScope: "commercial social media",
          commercialUseAllowed: true,
          licenseStatus: "valid",
          expiresAt: null,
          credentialReference: "license-record-001",
          evidencePath: "C:\\fixtures\\license.txt",
          bpm: 104,
          moods: ["steady", "credible"],
          energy: 0.56,
          loopStartMs: null,
          loopEndMs: null
        }), "import_music_catalog_track", {
          sourcePath: "C:\\fixtures\\licensed.wav",
          displayName: "稳健节奏",
          source: "用户授权曲库",
          commercialScope: "commercial social media",
          commercialUseAllowed: true,
          licenseStatus: "valid",
          expiresAt: null,
          credentialReference: "license-record-001",
          evidencePath: "C:\\fixtures\\license.txt",
          bpm: 104,
          moods: ["steady", "credible"],
          energy: 0.56,
          loopStartMs: null,
          loopEndMs: null
        }],
        [controller.listMusicCatalogTracks(), "list_music_catalog_tracks", {}],
        [controller.listAutoMixVoicePersonas(), "list_auto_mix_voice_personas", {}],
        [controller.designAutoMixVoicePersona("natural-life@1"), "design_auto_mix_voice_persona", {
          voice_persona_id: "natural-life@1"
        }],
        [controller.previewAutoMixVoicePersona("natural-life@1"), "preview_auto_mix_voice_persona", {
          voice_persona_id: "natural-life@1"
        }],
        [controller.approveAutoMixVoicePersona("natural-life@1"), "approve_auto_mix_voice_persona", {
          voice_persona_id: "natural-life@1"
        }],
        [controller.listPackagingPresets("course"), "list_packaging_presets", { kind: "course" }],
        [controller.listBrandProfiles(), "list_brand_profiles", {}],
        [controller.saveBrandProfile({ name: "轻品牌" }), "save_brand_profile", { profile: { name: "轻品牌" } }],
        [controller.getPackagingCostEstimate([generatedVideoId], "ai_generate"), "get_packaging_cost_estimate", { candidate_ids: [generatedVideoId], cover_mode: "ai_generate" }],
        [controller.packageGeneratedVideos([generatedVideoId], {
          packagingMode: "auto", brandProfileId, coverMode: "local_frame", reuseCover: true
        }), "package_generated_videos", {
          candidate_ids: [generatedVideoId],
          options: { packaging_mode: "auto", brand_profile_id: brandProfileId, cover_mode: "local_frame", reuse_cover: true }
        }],
        [controller.repackageVideo(generatedVideoId, {
          packagingMode: "preset", packagingPresetId: "slide_teacher",
          coverMode: "local_frame", reuseCover: true
        }), "repackage_video", {
          candidate_id: generatedVideoId,
          options: { packaging_mode: "preset", packaging_preset_id: "slide_teacher", cover_mode: "local_frame", reuse_cover: true }
        }],
        [controller.regenerateCover(generatedVideoId), "regenerate_cover", { candidate_id: generatedVideoId }],
        [controller.preflightVisualComparison(generatedVideoId), "preflight_visual_comparison", { candidate_id: generatedVideoId }],
        [controller.createVisualComparisonTask(generatedVideoId), "create_visual_comparison_task", { candidate_id: generatedVideoId }],
        [controller.createMixProject("Launch", [{ name: "Intro" }], { allow_repeated_assets: false }), "create_mix_project", { name: "Launch", slots: [{ name: "Intro" }], constraints: { allow_repeated_assets: false } }],
        [controller.updateMixProject(projectId, { name: "Launch 2" }), "update_mix_project", { project_id: projectId, name: "Launch 2" }],
        [controller.getMixProject(projectId), "get_mix_project", { project_id: projectId }],
        [controller.listMixProjects(25), "list_mix_projects", { limit: 25 }],
        [controller.calculateMixCombinations(projectId), "calculate_mix_combinations", { project_id: projectId }],
        [controller.generateMixCandidates(projectId, { limit: 3, seed: "campaign-7" }), "generate_mix_candidates", { project_id: projectId, limit: 3, seed: "campaign-7" }],
        [controller.listMixCandidates({ projectId, reviewStatus: "pending", limit: 9 }), "list_mix_candidates", { project_id: projectId, review_status: "pending", limit: 9 }],
        [controller.reviewMixCandidate(candidateId, "approved", "ready"), "review_mix_candidate", { candidate_id: candidateId, review_status: "approved", review_note: "ready" }],
        [controller.listPublishQueue({ status: "queued", limit: 8 }), "list_publish_queue", { status: "queued", limit: 8 }],
        [controller.updatePublishQueueItem(queueItemId, "processing", "retry"), "update_publish_queue_item", { queue_item_id: queueItemId, status: "processing", error_message: "retry" }],
        [controller.renderMixCandidate(candidateId, { platforms: ["wechat", "douyin"], title: "", description: "" }), "render_mix_candidate", { candidate_id: candidateId, platforms: ["wechat", "douyin"], title: "", description: "" }],
        [controller.listExportPackages({ candidateId, limit: 7 }), "list_export_packages", { candidate_id: candidateId, limit: 7 }],
        [controller.resolveExportPackagePath(packageId), "resolve_export_package_path", { package_id: packageId }]
      ];
      for (const [promise, method, params] of mixCalls) {
        await waitFor(() => children[1].stdin.writes.some((item) => item.method === method));
        const request = children[1].stdin.writes.find((item) => item.method === method);
        assert.deepEqual(request.params, params);
        children[1].respond(request, {});
        await promise;
      }

      const presetRequestCount = children[1].stdin.writes.length;
      const allPackagingPresets = controller.listPackagingPresets();
      await waitFor(() => children[1].stdin.writes.length === presetRequestCount + 1);
      const allPresetsRequest = children[1].stdin.writes.at(-1);
      assert.equal(allPresetsRequest.method, "list_packaging_presets");
      assert.deepEqual(allPresetsRequest.params, {});
      children[1].respond(allPresetsRequest, { items: [] });
      await allPackagingPresets;

      children[1].once("request", (request) => {
        assert.equal(request.method, "shutdown");
        children[1].respond(request, { status: "stopping" });
        setImmediate(() => children[1].emit("close", 0, null));
      });
      assert.equal((await controller.stop()).state, "stopped");
    }

    {
      const child = new FakeChild();
      const controller = createContentEngineSidecar({
        runtimePath,
        dataDir,
        requestTimeoutMs: 10,
        spawnProcess: () => child
      });
      const start = controller.start();
      await waitFor(() => child.stdout.listenerCount("data") === 1);
      child.ready();
      await start;
      await assert.rejects(
        controller.listFinished(10),
        (error) => error.code === "CONTENT_ENGINE_REQUEST_TIMEOUT"
      );
      child.respond(child.stdin.writes[0], { items: [] });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        child.killedSignals,
        [],
        "a late response for an expired request must be ignored"
      );
      const pendingRequest = controller.listAssets({ limit: 10 });
      await waitFor(() => child.stdin.writes.length === 2);
      child.emit("close", 9, null);
      await assert.rejects(
        pendingRequest,
        (error) => error.code === "CONTENT_ENGINE_EXITED"
      );
      assert.equal(controller.status().state, "failed");
      assert.equal(controller.status().code, "CONTENT_ENGINE_EXITED");
    }

    {
      const child = new FakeChild();
      const controller = createContentEngineSidecar({
        runtimePath,
        dataDir,
        startupTimeoutMs: 100,
        spawnProcess: () => child
      });
      const start = controller.start();
      await waitFor(() => child.stdout.listenerCount("data") === 1);
      child.stdout.emit("data", Buffer.from("{not-json}\n", "utf8"));
      const result = await start;
      assert.equal(result.state, "failed");
      assert.equal(result.code, "CONTENT_ENGINE_READY_INVALID");
      assert.deepEqual(child.killedSignals, ["SIGTERM"]);
    }

    {
      const child = new FakeChild();
      const controller = createContentEngineSidecar({
        runtimePath,
        dataDir,
        startupTimeoutMs: 100,
        spawnProcess: () => child
      });
      const start = controller.start();
      await waitFor(() => child.stdout.listenerCount("data") === 1);
      child.ready();
      await start;
      const request = controller.listAssets({ limit: 10 });
      await waitFor(() => child.stdin.writes.length === 1);
      child.stdout.emit("data", Buffer.from(`${JSON.stringify({
        id: "unknown-request",
        ok: true,
        result: {}
      })}\n`, "utf8"));
      await assert.rejects(
        request,
        (error) => error.code === "CONTENT_ENGINE_RESPONSE_INVALID"
      );
      assert.deepEqual(child.killedSignals, ["SIGTERM"]);
      await waitFor(() => child.listenerCount("close") === 0 || controller.status().state === "failed");
      assert.equal(controller.status().code, "CONTENT_ENGINE_RESPONSE_INVALID");
    }

    {
      const child = new FakeChild();
      const controller = createContentEngineSidecar({
        runtimePath,
        dataDir,
        requestTimeoutMs: 100,
        voiceDesignTimeoutMs: 10,
        spawnProcess: () => child
      });
      const start = controller.start();
      await waitFor(() => child.stdout.listenerCount("data") === 1);
      child.ready();
      await start;
      await assert.rejects(
        controller.designAutoMixVoicePersona("natural-life@1"),
        (error) => error.code === "auto_mix_voice_design_outcome_unknown"
      );
      assert.equal(
        child.stdin.writes[0].method,
        "design_auto_mix_voice_persona"
      );
      child.respond(child.stdin.writes[0], { provisioningStatus: "ready" });
      child.emit("close", 0, null);
      await new Promise((resolve) => setImmediate(resolve));
    }

    {
      const child = new FakeChild();
      const controller = createContentEngineSidecar({
        runtimePath,
        dataDir,
        startupTimeoutMs: 100,
        spawnProcess: () => child
      });
      const start = controller.start();
      await waitFor(() => child.stdout.listenerCount("data") === 1);
      child.ready();
      await start;
      const request = controller.listAssets({ limit: 10 });
      await waitFor(() => child.stdin.writes.length === 1);
      child.stdout.emit("data", Buffer.from(`${JSON.stringify({
        id: child.stdin.writes[0].id,
        ok: false,
        error: {
          code: "cloud_request_failed",
          message: "百炼请求被拒绝（HTTP 401），sk-secret-value C:\\private\\source.mp4"
        }
      })}\n`, "utf8"));
      await assert.rejects(
        request,
        (error) => error.code === "cloud_request_failed"
          && error.message.includes("HTTP 401")
          && !error.message.includes("sk-secret-value")
          && !error.message.includes("C:\\private\\source.mp4")
      );
      await controller.stop();
    }

    {
      const child = new FakeChild();
      const controller = createContentEngineSidecar({
        runtimePath,
        dataDir,
        startupTimeoutMs: 10,
        spawnProcess: () => child
      });
      const result = await controller.start();
      assert.equal(result.state, "failed");
      assert.equal(result.code, "CONTENT_ENGINE_START_TIMEOUT");
      assert.deepEqual(child.killedSignals, ["SIGTERM"]);
    }

    {
      const workerSource = fs.readFileSync(
        path.join(__dirname, "remotion-render-worker.mjs"),
        "utf8"
      );
      assert.match(workerSource, /listen\(0, "127\.0\.0\.1"/u);
      assert.match(workerSource, /normalizeMotionManifest/u);
      assert.match(workerSource, /audioCodec: null/u);
      assert.match(workerSource, /muted: true/u);
      assert.match(workerSource, /connect-src 'self'/u);
      assert.match(workerSource, /sourceToken/u);
      assert.match(workerSource, /output_reparse_rejected/u);
      assert.match(workerSource, /hashTree\(digest, bundleRoot\)/u);
      for (const contractAsset of [
        "contract.cjs",
        "effect-registry.json",
        "layout-grid.json",
        "style-packs.json"
      ]) {
        assert.equal(workerSource.includes(contractAsset), true);
      }
      assert.doesNotMatch(workerSource, /--no-sandbox/u);
      assert.doesNotMatch(workerSource, /disableWebSecurity: true/u);
      assert.doesNotMatch(workerSource, /\bbundle\s*\(/u);

      const invalidId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const closeId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const workerCheck = spawnSync(
        process.execPath,
        [path.join(__dirname, "remotion-render-worker.mjs")],
        {
          input: `${JSON.stringify({
            version: 1,
            id: invalidId,
            method: "render",
            private: {
              bundlePath: "\\\\network-canary\\bundle",
              browserPath: "C:\\browser-canary.exe",
              sourcePath: "C:\\source-canary.mp4",
              outputPath: "C:\\output-canary.mp4"
            },
            publicProps: {}
          })}\n${JSON.stringify({
            version: 1,
            id: closeId,
            method: "close"
          })}\n`,
          encoding: "utf8",
          timeout: 5_000,
          windowsHide: true,
          env: {
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP
          }
        }
      );
      assert.equal(workerCheck.status, 0, workerCheck.stderr);
      assert.equal(workerCheck.stderr, "");
      const responses = workerCheck.stdout.trim().split(/\r?\n/u).map(JSON.parse);
      assert.deepEqual(responses[0], {
        version: 1,
        id: invalidId,
        ok: false,
        failureClass: "security",
        code: "bundle_unavailable"
      });
      assert.equal(JSON.stringify(responses).includes("network-canary"), false);
      assert.equal(responses.at(-1).id, closeId);
      assert.equal(responses.at(-1).ok, true);
    }

    console.log("content-engine sidecar self-check passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
