const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createMomentsCampaignController,
  momentsReadingSnapshotMatch
} = require("./moments-campaign-ipc.cjs");

const firstReadingFrame = {
  source: "visual:windows_media_ocr",
  structure_verified: true,
  post_fingerprint: "1".repeat(64),
  avatar_hash: "a".repeat(64),
  identity_text: "robot owner new store deployment",
  stable_anchor_text: "robot owner new store",
  bounds: { left: 400, top: 100, width: 500, height: 420 },
  menu_bounds: { left: 840, top: 460, width: 40, height: 28 },
  avatar_bounds: { left: 410, top: 120, width: 48, height: 48 }
};
const sameReadingFrameAfterUp = {
  ...firstReadingFrame,
  post_fingerprint: "2".repeat(64),
  identity_text: "robot owner new store deployment completed today",
  stable_anchor_text: firstReadingFrame.stable_anchor_text,
  bounds: { ...firstReadingFrame.bounds, top: 340 },
  menu_bounds: { ...firstReadingFrame.menu_bounds, top: 700 },
  avatar_bounds: { ...firstReadingFrame.avatar_bounds, top: 360 }
};
assert.equal(momentsReadingSnapshotMatch(firstReadingFrame, sameReadingFrameAfterUp, 240).matched, true);
assert.equal(momentsReadingSnapshotMatch(firstReadingFrame, {
  ...sameReadingFrameAfterUp,
  post_fingerprint: firstReadingFrame.post_fingerprint
}, 240).mode, "visual_text_displacement", "visual fingerprints must not bypass geometry binding");
assert.equal(momentsReadingSnapshotMatch(firstReadingFrame, {
  ...sameReadingFrameAfterUp,
  post_fingerprint: firstReadingFrame.post_fingerprint,
  bounds: { ...sameReadingFrameAfterUp.bounds, top: 110 },
  menu_bounds: { ...sameReadingFrameAfterUp.menu_bounds, top: 470 },
  avatar_bounds: { ...sameReadingFrameAfterUp.avatar_bounds, top: 130 }
}, 240).matched, false, "adjacent visual posts with identical text must not collapse into one reading session");
assert.equal(momentsReadingSnapshotMatch(firstReadingFrame, {
  ...sameReadingFrameAfterUp,
  identity_text: "a different post from the same author",
  stable_anchor_text: "different post unrelated body"
}, 240).matched, false, "avatar equality alone must never bind adjacent posts from the same author");
assert.equal(momentsReadingSnapshotMatch(firstReadingFrame, {
  ...sameReadingFrameAfterUp,
  identity_text: "robot owner new store deployment but this is another customer",
  stable_anchor_text: "robot owner different customer"
}, 240).matched, false, "overlapping boilerplate from the same author must not relock another post");
assert.equal(momentsReadingSnapshotMatch({ runtime_id: "42.8.9", source: "uia:sns_list" }, {
  runtime_id: "42.8.9",
  source: "uia:sns_list"
}, 0).matched, true);

async function waitFor(read, predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("moments campaign self-check timed out");
}

const INTEGRATED_OPEN_RESULT = Object.freeze({
  ok: true,
  surfaceMode: "integrated",
  pid: 42,
  hWnd: "84",
  title: "微信",
  className: "mmui::MainWindow",
  processName: "Weixin",
  x: 0,
  y: 0,
  width: 1400,
  height: 950,
  dpi: 120
});

const INTEGRATED_EXPECTED_SURFACE = Object.freeze({
  surfaceMode: "integrated",
  pid: 42,
  hWnd: "84",
  title: "微信",
  className: "mmui::MainWindow"
});

const INTEGRATED_OBSERVED_WINDOW = Object.freeze({
  ...INTEGRATED_EXPECTED_SURFACE,
  processName: "Weixin",
  rootName: "微信",
  rootControlType: "ControlType.Window",
  rootProcessId: 42,
  identityMode: "visual_mmui_render",
  automationId: "",
  feedAutomationId: "",
  feedRuntimeId: "",
  feedCount: 0,
  renderPaneName: "MMUIRenderSubWindowHW",
  renderPaneAutomationId: "",
  renderPaneControlType: "ControlType.Pane",
  renderPaneProcessId: 42,
  renderPaneRuntimeId: "42.9.render",
  renderPaneBounds: Object.freeze({ left: 374, top: 40, width: 690, height: 646 })
});

const STANDALONE_OPEN_RESULT = Object.freeze({
  ok: true,
  surfaceMode: "standalone",
  pid: 43,
  hWnd: "86",
  title: "朋友圈",
  className: "Qt51514QWindowIcon"
});

const STANDALONE_EXPECTED_SURFACE = Object.freeze({
  surfaceMode: "standalone",
  pid: 43,
  hWnd: "86",
  title: "朋友圈",
  className: "Qt51514QWindowIcon"
});

function expectedWindowFromArgs(args) {
  const flagIndex = args.lastIndexOf("--expected-window-base64");
  assert.notEqual(flagIndex, -1, "every Moments dry-run must receive the exact opened surface");
  assert.equal(typeof args[flagIndex + 1], "string");
  return JSON.parse(Buffer.from(args[flagIndex + 1], "base64").toString("utf8"));
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-"));
  const observations = ["a".repeat(64), "b".repeat(64)];
  let observationIndex = 0;
  let scrolls = 0;
  let releases = 0;
  const openOptions = [];
  const scrollOptions = [];
  const expectedSurfaces = [];
  const events = [];
  const controller = createMomentsCampaignController({
    baseDir: root,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "test-owner" } }),
      release: () => { releases += 1; }
    },
    logger: { event: (module, event) => events.push(`${module}:${event}`) },
    openMoments: async (options) => {
      openOptions.push(options);
      return INTEGRATED_OPEN_RESULT;
    },
    scrollMoments: async (options) => {
      scrolls += 1;
      scrollOptions.push(options);
      return { ok: true };
    },
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        expectedSurfaces.push(expectedWindowFromArgs(args));
        const fingerprint = observations[Math.min(observationIndex, observations.length - 1)];
        observationIndex += 1;
        return {
          ok: true,
          window: INTEGRATED_OBSERVED_WINDOW,
          post_snapshot: {
            observation_id: fingerprint,
            post_fingerprint: fingerprint
          },
          plan: { visible_post_count: 1 }
        };
      }
      return {
        ok: true,
        status: "verified",
        no_op: observationIndex === 1,
        real_action_attempted: observationIndex !== 1
      };
    }
  });

  assert.equal(controller.start({ maxPosts: 2 }).ok, true);
  const completed = await waitFor(
    () => controller.status().state,
    (state) => state.status === "completed"
  );
  assert.equal(completed.processed_count, 2);
  assert.equal(completed.liked_count, 1);
  assert.equal(completed.already_liked_count, 1);
  assert.equal(completed.scroll_count, 1);
  assert.equal(scrolls, 1);
  assert.equal(releases, 1);
  assert.equal(events.includes("moments:campaign.completed"), true);
  assert.deepEqual(openOptions, [{ allowIntegrated: true, minIdleMs: 0 }]);
  assert.deepEqual(expectedSurfaces, [INTEGRATED_EXPECTED_SURFACE, INTEGRATED_EXPECTED_SURFACE]);
  assert.equal(scrollOptions.length, 1);
  assert.deepEqual(
    { ...scrollOptions[0], shouldContinue: undefined },
    { expectedWindow: INTEGRATED_OBSERVED_WINDOW, minIdleMs: 0, shouldContinue: undefined }
  );
  assert.equal(typeof scrollOptions[0].shouldContinue, "function");
  assert.equal(await scrollOptions[0].shouldContinue(), true);

  const persisted = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
  assert.equal(persisted.moments_campaign.status, "completed");

  const openFailureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-open-failure-"));
  const openFailureEvents = [];
  const openFailureController = createMomentsCampaignController({
    baseDir: openFailureRoot,
    coordinator: { acquire: () => ({ ok: true, lock: { owner: "open-failure" } }), release() {} },
    logger: { event: (module, event, details) => openFailureEvents.push({ module, event, details }) },
    openMoments: async () => ({ ok: false, reason: "personal_wechat_main_window_not_found" }),
    scrollMoments: async () => { throw new Error("a failed open must not begin a Moments action"); }
  });
  assert.equal(openFailureController.start({ maxPosts: 1 }).ok, true);
  await waitFor(() => openFailureController.status().state, (state) => state.status === "paused");
  const openFailureEvent = openFailureEvents.find(({ event }) => event === "campaign.open_finished");
  assert.equal(openFailureEvent.details.reason, "personal_wechat_main_window_not_found");
  assert.equal(openFailureEvent.details.ok, false);
  assert.equal("result" in openFailureEvent.details, false, "the diagnostic event must expose its finite reason directly rather than serialize a raw response");

  let readingCalls = 0;
  let readingActions = 0;
  const readingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-reading-menu-"));
  const readingController = createMomentsCampaignController({
    baseDir: readingRoot,
    coordinator: { acquire: () => ({ ok: true, lock: { owner: "reading" } }), release() {} },
    logger: { event() {} },
    openMoments: async () => INTEGRATED_OPEN_RESULT,
    scrollMoments: async (options) => {
      assert.equal(options.scrollMode, "seek_post_menu_down");
      assert.equal(readingActions, 0, "a body-only snapshot must never reach an action");
      return { ok: true, delta: -240, observedDelta: -180 };
    },
    generateComment: async ({ postText }) => {
      assert.equal(postText, "机器人培训圆满收官，现场实操收获很多。".normalize("NFKC"), "use body content, not author/footer identity");
      return { comment: "现场实操很充实！" };
    },
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        readingCalls += 1;
        if (readingCalls > 1) {
          const target = JSON.parse(Buffer.from(args[args.indexOf("--target-post-base64") + 1], "base64"));
          assert.equal(target.expected_scroll_delta, -180);
          assert.equal(target.expected_scroll_unit, "observed_pixels");
          assert.equal(target.observation_id, "reading-only");
        }
        return {
          ok: true, window: INTEGRATED_OBSERVED_WINDOW,
          post_snapshot: {
            ...firstReadingFrame,
            observation_id: readingCalls <= 2 ? "reading-only" : "ready",
            body_only: readingCalls === 1,
            ...(readingCalls === 2 ? {
              menu_bounds: { left: 700, top: INTEGRATED_OBSERVED_WINDOW.renderPaneBounds.top + INTEGRATED_OBSERVED_WINDOW.renderPaneBounds.height - 25, width: 40, height: 24 }
            } : {}),
            identity_text: "作者昵称 会员超市 12小时前",
            content_text: "机器人培训圆满收官，现场实操收获很多。"
          }
        };
      }
      readingActions += 1;
      assert.ok(args.includes("ready"));
      return { ok: true, status: "verified", real_action_attempted: true };
    }
  });
  assert.equal(readingController.start({ maxPosts: 1, commentEnabled: true }).ok, true);
  const readingFinished = await waitFor(() => readingController.status().state, (s) => s.status === "completed");
  assert.equal(readingCalls, 3);
  assert.equal(readingActions, 2);
  assert.equal(readingFinished.comment_skipped_count, 0);
  assert.equal(readingFinished.commented_count, 1);

  const surfaceRetryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-surface-retry-"));
  let surfaceRetryObservationCalls = 0;
  const surfaceRetryController = createMomentsCampaignController({
    baseDir: surfaceRetryRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "surface-retry-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    openMoments: async () => INTEGRATED_OPEN_RESULT,
    scrollMoments: async () => ({ ok: true }),
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        surfaceRetryObservationCalls += 1;
        if (surfaceRetryObservationCalls === 1) {
          return { ok: false, reason: "moments_integrated_surface_not_proven" };
        }
        return {
          ok: true,
          window: INTEGRATED_OBSERVED_WINDOW,
          post_snapshot: {
            observation_id: "surface-retry-observation",
            post_fingerprint: "surface-retry-post"
          },
          plan: { visible_post_count: 1 }
        };
      }
      return { ok: true, status: "verified", no_op: false, real_action_attempted: true };
    }
  });
  assert.equal(surfaceRetryController.start({ maxPosts: 1 }).ok, true);
  const surfaceRetryFinished = await waitFor(
    () => surfaceRetryController.status().state,
    (state) => state.status !== "running"
  );
  assert.equal(surfaceRetryFinished.status, "completed", "a transient pre-action surface read must retry once before pausing");
  assert.equal(surfaceRetryObservationCalls, 2, "the integrated surface read must retry exactly once");
  assert.equal(surfaceRetryFinished.liked_count, 1);

  const menuOnlyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-menu-only-"));
  let menuOnlyObservationIndex = 0;
  let menuOnlyScrolls = 0;
  const menuOnlyController = createMomentsCampaignController({
    baseDir: menuOnlyRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "menu-only-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    openMoments: async () => INTEGRATED_OPEN_RESULT,
    scrollMoments: async () => {
      menuOnlyScrolls += 1;
      return { ok: true };
    },
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        const first = menuOnlyObservationIndex === 0;
        menuOnlyObservationIndex += 1;
        const fingerprint = (first ? "1" : "2").repeat(64);
        return {
          ok: true,
          window: INTEGRATED_OBSERVED_WINDOW,
          post_snapshot: {
            observation_id: fingerprint,
            post_fingerprint: fingerprint,
            menu_only: first
          },
          plan: { visible_post_count: 1 }
        };
      }
      return {
        ok: true,
        status: "verified",
        no_op: menuOnlyObservationIndex === 1,
        real_action_attempted: menuOnlyObservationIndex !== 1
      };
    }
  });
  assert.equal(menuOnlyController.start({ maxPosts: 1 }).ok, true);
  const menuOnlyCompleted = await waitFor(
    () => menuOnlyController.status().state,
    (state) => state.status === "completed"
  );
  assert.equal(menuOnlyCompleted.liked_count, 1, "an already-liked menu-only fallback must not satisfy the target");
  assert.equal(menuOnlyCompleted.already_liked_count, 0);
  assert.equal(menuOnlyCompleted.skipped_count, 1);
  assert.equal(menuOnlyScrolls, 1);

  const standaloneRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-standalone-"));
  const standaloneOpenOptions = [];
  const standaloneExpectedSurfaces = [];
  const standaloneController = createMomentsCampaignController({
    baseDir: standaloneRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "standalone-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    openMoments: async (options) => {
      standaloneOpenOptions.push(options);
      return STANDALONE_OPEN_RESULT;
    },
    scrollMoments: async () => {
      throw new Error("a one-post standalone campaign must not scroll");
    },
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        standaloneExpectedSurfaces.push(expectedWindowFromArgs(args));
        return {
          ok: true,
          window: {
            ...STANDALONE_EXPECTED_SURFACE,
            processName: "Weixin",
            rootName: "朋友圈",
            identityMode: "automation_id"
          },
          post_snapshot: {
            observation_id: "f".repeat(64),
            post_fingerprint: "f".repeat(64)
          },
          plan: { visible_post_count: 1 }
        };
      }
      return {
        ok: true,
        status: "verified",
        no_op: false,
        real_action_attempted: true
      };
    }
  });
  assert.equal(standaloneController.start({ maxPosts: 1 }).ok, true);
  const standaloneCompleted = await waitFor(
    () => standaloneController.status().state,
    (state) => state.status === "completed"
  );
  assert.equal(standaloneCompleted.processed_count, 1);
  assert.equal(standaloneCompleted.liked_count, 1);
  assert.deepEqual(standaloneOpenOptions, [{ allowIntegrated: true, minIdleMs: 0 }]);
  assert.deepEqual(standaloneExpectedSurfaces, [STANDALONE_EXPECTED_SURFACE]);

  const invalidSurfaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-invalid-surface-"));
  let invalidSurfaceRunSteps = 0;
  let invalidSurfaceScrolls = 0;
  let invalidSurfaceActions = 0;
  let invalidSurfaceReleases = 0;
  const invalidSurfaceController = createMomentsCampaignController({
    baseDir: invalidSurfaceRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "invalid-surface-owner" } }),
      release: () => { invalidSurfaceReleases += 1; }
    },
    logger: { event: () => undefined },
    openMoments: async () => ({
      ok: true,
      surfaceMode: "integrated",
      pid: 42,
      hWnd: "84",
      title: "微信"
    }),
    scrollMoments: async () => {
      invalidSurfaceScrolls += 1;
      return { ok: true };
    },
    runStep: async (args) => {
      invalidSurfaceRunSteps += 1;
      if (args[0] === "moments-like" || args[0] === "moments-comment") {
        invalidSurfaceActions += 1;
      }
      return { ok: true };
    }
  });
  assert.equal(invalidSurfaceController.start({ maxPosts: 1 }).ok, true);
  const invalidSurfacePaused = await waitFor(
    () => invalidSurfaceController.status().state,
    (state) => state.status === "paused"
  );
  assert.equal(invalidSurfacePaused.last_reason, "moments_window_identity_mismatch");
  assert.equal(invalidSurfacePaused.processed_count, 0);
  assert.equal(invalidSurfacePaused.scroll_count, 0);
  assert.equal(invalidSurfaceRunSteps, 0);
  assert.equal(invalidSurfaceScrolls, 0);
  assert.equal(invalidSurfaceActions, 0);
  assert.equal(invalidSurfaceReleases, 1);

  const likeRecognitionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-like-recognition-"));
  const likeRecognitionEvents = [];
  const likeRecognitionController = createMomentsCampaignController({
    baseDir: likeRecognitionRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "like-recognition-owner" } }),
      release: () => undefined
    },
    logger: { event: (module, event, details) => likeRecognitionEvents.push({ module, event, details }) },
    openMoments: async () => STANDALONE_OPEN_RESULT,
    scrollMoments: async () => ({ ok: true }),
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        return {
          ok: true,
          post_snapshot: {
            observation_id: "9".repeat(64),
            post_fingerprint: "9".repeat(64)
          },
          plan: { visible_post_count: 1 }
        };
      }
      return {
        ok: false,
        status: "blocked",
        blocked_reason: "moments_menu_ambiguous",
        primary_reason: "moments_menu_ambiguous",
        cleanup_reason: "moments_menu_close_blocked",
        real_action_attempted: false,
        diagnostics: {
          requested_action: "like",
          proof_purpose: "verify_outcome",
          menu_read_retry_count: 1,
          outcome_observation_count: 2,
          first_reason: "moments_menu_ambiguous",
          first_segment_count: 2,
          first_like_ocr_matched: false,
          first_like_base_ocr_matched: false,
          first_targeted_like_ocr_attempted: true,
          first_targeted_like_ocr_matched: false,
          first_comment_ocr_matched: false,
          first_like_signature_ok: true,
          first_comment_signature_ok: true,
          first_like_signature_edge_clear: false,
          first_comment_signature_edge_clear: true,
          first_requires_stability: true,
          first_like_resolution_mode: "visual_signature",
          first_width_ratio: 0.7,
          first_height_ratio: 1,
          second_like_ocr_matched: false,
          second_like_base_ocr_matched: false,
          second_targeted_like_ocr_attempted: true,
          second_targeted_like_ocr_matched: "false",
          second_comment_ocr_matched: true,
          second_like_signature_ok: false,
          second_comment_signature_ok: true,
          second_like_signature_edge_clear: false,
          second_comment_signature_edge_clear: true,
          second_requires_stability: true,
          second_like_resolution_mode: "unknown_mode",
          second_width_ratio: -1,
          second_height_ratio: 11,
          second_segment_count: null,
          second_fallback_candidate_count: "",
          raw_ocr_text: "PRIVATE-CAMPAIGN-OCR"
        }
      };
    }
  });
  assert.equal(likeRecognitionController.start({
    maxPosts: 1,
    likeEnabled: true,
    commentEnabled: false
  }).ok, true);
  const likeRecognitionPartial = await waitFor(
    () => likeRecognitionController.status().state,
    (state) => state.status === "partial"
  );
  assert.equal(likeRecognitionPartial.processed_count, 1);
  assert.equal(likeRecognitionPartial.liked_count, 0);
  assert.equal(likeRecognitionPartial.skipped_count, 1);
  assert.equal(likeRecognitionPartial.last_reason, "no_progress");
  const likeRecognitionEvent = likeRecognitionEvents.find((entry) => entry.event === "campaign.like_finished");
  assert.deepEqual(likeRecognitionEvent.details.diagnostics, {
    requested_action: "like",
    proof_purpose: "verify_outcome",
    menu_read_retry_count: 1,
    outcome_observation_count: 2,
    first_reason: "moments_menu_ambiguous",
    first_segment_count: 2,
    first_like_ocr_matched: false,
    first_like_base_ocr_matched: false,
    first_targeted_like_ocr_attempted: true,
    first_targeted_like_ocr_matched: false,
    first_comment_ocr_matched: false,
    first_like_signature_ok: true,
    first_comment_signature_ok: true,
    first_like_signature_edge_clear: false,
    first_comment_signature_edge_clear: true,
    first_requires_stability: true,
    first_like_resolution_mode: "visual_signature",
    first_width_ratio: 0.7,
    first_height_ratio: 1,
    second_like_ocr_matched: false,
    second_like_base_ocr_matched: false,
    second_targeted_like_ocr_attempted: true,
    second_comment_ocr_matched: true,
    second_like_signature_ok: false,
    second_comment_signature_ok: true,
    second_like_signature_edge_clear: false,
    second_comment_signature_edge_clear: true,
    second_requires_stability: true,
  });
  assert.equal(likeRecognitionEvent.details.reason, "moments_menu_ambiguous");
  assert.equal(likeRecognitionEvent.details.primary_reason, "moments_menu_ambiguous");
  assert.equal(likeRecognitionEvent.details.cleanup_reason, "moments_menu_close_blocked");
  assert.equal(JSON.stringify(likeRecognitionEvent).includes("PRIVATE-CAMPAIGN-OCR"), false);

  const topPositionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-top-position-"));
  let topPositionObservations = 0;
  let topPositionScrolls = 0;
  const topPositionEvents = [];
  const topPositionController = createMomentsCampaignController({
    baseDir: topPositionRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "top-position-owner" } }),
      release: () => undefined
    },
    logger: { event: (module, event, details) => topPositionEvents.push({ module, event, details }) },
    openMoments: async () => STANDALONE_OPEN_RESULT,
    scrollMoments: async () => {
      topPositionScrolls += 1;
      return { ok: true };
    },
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        topPositionObservations += 1;
        if (topPositionObservations === 1) {
          return {
            ok: false,
            blocked_reason: "moments_post_position_unsafe",
            real_action_attempted: false,
            diagnostics: {
              position_zone: "top_edge",
              top_edge_unsafe: true,
              target_top_ratio: 0.003,
              rejected_top_count: 1
            }
          };
        }
        return {
          ok: true,
          post_snapshot: {
            observation_id: "e".repeat(64),
            post_fingerprint: "e".repeat(64)
          },
          plan: { visible_post_count: 1, target_partial_visible: false },
          diagnostics: { position_zone: "actionable", top_edge_unsafe: false }
        };
      }
      return {
        ok: true,
        status: "verified",
        no_op: false,
        real_action_attempted: true
      };
    }
  });
  assert.equal(topPositionController.start({ maxPosts: 1 }).ok, true);
  const topPositionCompleted = await waitFor(
    () => topPositionController.status().state,
    (state) => state.status === "completed"
  );
  assert.equal(topPositionObservations, 2);
  assert.equal(topPositionScrolls, 1);
  assert.equal(topPositionCompleted.processed_count, 1);
  assert.equal(topPositionCompleted.liked_count, 1);
  const topObservationEvent = topPositionEvents.find((entry) => entry.event === "campaign.observation_finished");
  assert.equal(topObservationEvent.details.position_zone, "top_edge");
  assert.equal(topObservationEvent.details.top_edge_unsafe, true);
  assert.equal(topObservationEvent.details.rejected_top_count, 1);

  const duplicateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-duplicate-"));
  const duplicateController = createMomentsCampaignController({
    baseDir: duplicateRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "duplicate-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    openMoments: async () => STANDALONE_OPEN_RESULT,
    scrollMoments: async () => ({ ok: true }),
    runStep: async (args) => args[0] === "moments-dry-run"
      ? {
          ok: true,
          post_snapshot: {
            observation_id: "c".repeat(64),
            post_fingerprint: "c".repeat(64)
          }
        }
      : {
          ok: false,
          status: "blocked",
          blocked_reason: "moments_attempt_already_recorded",
          previous_status: "verified",
          real_action_attempted: false
        }
  });
  assert.equal(duplicateController.start({ maxPosts: 1 }).ok, true);
  const duplicateCompleted = await waitFor(
    () => duplicateController.status().state,
    (state) => state.status === "completed"
  );
  assert.equal(duplicateCompleted.processed_count, 1);
  assert.equal(duplicateCompleted.skipped_count, 1);

  const duplicateUnknownRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-duplicate-unknown-"));
  const duplicateUnknownController = createMomentsCampaignController({
    baseDir: duplicateUnknownRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "duplicate-unknown-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    openMoments: async () => STANDALONE_OPEN_RESULT,
    scrollMoments: async () => ({ ok: true }),
    runStep: async (args) => args[0] === "moments-dry-run"
      ? {
          ok: true,
          post_snapshot: {
            observation_id: "9".repeat(64),
            post_fingerprint: "9".repeat(64)
          }
        }
      : {
          ok: false,
          status: "blocked",
          blocked_reason: "moments_attempt_already_recorded",
          previous_status: "outcome_unknown",
          real_action_attempted: null
        }
  });
  assert.equal(duplicateUnknownController.start({ maxPosts: 1 }).ok, true);
  const duplicateUnknownPaused = await waitFor(
    () => duplicateUnknownController.status().state,
    (state) => state.status === "paused"
  );
  assert.equal(duplicateUnknownPaused.liked_count, 0);
  assert.equal(duplicateUnknownPaused.already_liked_count, 0);
  assert.equal(duplicateUnknownPaused.processed_count, 0);
  assert.equal(duplicateUnknownPaused.last_reason, "moments_like_outcome_unknown");

  const partialRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-partial-"));
  let partialObservations = 0;
  let partialLikes = 0;
  let partialScrolls = 0;
  const partialScrollOptions = [];
  const partialController = createMomentsCampaignController({
    baseDir: partialRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "partial-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    openMoments: async () => INTEGRATED_OPEN_RESULT,
    scrollMoments: async (options) => {
      partialScrolls += 1;
      partialScrollOptions.push(options);
      return { ok: true };
    },
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        partialObservations += 1;
        return {
          ok: true,
          window: INTEGRATED_OBSERVED_WINDOW,
          plan: { target_partial_visible: partialObservations === 1 },
          post_snapshot: {
            observation_id: `${partialObservations}`.repeat(64),
            post_fingerprint: `${partialObservations}`.repeat(64)
          }
        };
      }
      partialLikes += 1;
      return {
        ok: true,
        status: "verified",
        no_op: false,
        real_action_attempted: true
      };
    }
  });
  assert.equal(partialController.start({ maxPosts: 1 }).ok, true);
  const partialCompleted = await waitFor(
    () => partialController.status().state,
    (state) => state.status === "completed"
  );
  assert.equal(partialCompleted.processed_count, 1);
  assert.equal(partialCompleted.liked_count, 1);
  assert.equal(partialObservations, 1);
  assert.equal(partialLikes, 1);
  assert.equal(partialScrolls, 0);
  assert.equal(partialScrollOptions.length, 0);

  const queueRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-queue-"));
  let queueObservations = 0;
  let queueScrolls = 0;
  const queueActionIds = [];
  const bottomSnapshot = {
    observation_id: "b".repeat(64),
    post_fingerprint: "b".repeat(64),
    menu_bounds: { top: 520 }
  };
  const topSnapshot = {
    observation_id: "a".repeat(64),
    post_fingerprint: "a".repeat(64),
    menu_bounds: { top: 180 }
  };
  const queueController = createMomentsCampaignController({
    baseDir: queueRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "queue-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    openMoments: async () => INTEGRATED_OPEN_RESULT,
    scrollMoments: async () => {
      queueScrolls += 1;
      return { ok: true };
    },
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        queueObservations += 1;
        return {
          ok: true,
          window: INTEGRATED_OBSERVED_WINDOW,
          plan: { visible_post_count: 2 },
          post_snapshot: bottomSnapshot,
          post_snapshots: [topSnapshot, bottomSnapshot]
        };
      }
      const observationId = args[args.indexOf("--observation-id") + 1];
      queueActionIds.push(observationId);
      return observationId === bottomSnapshot.observation_id
        ? { ok: false, status: "blocked", blocked_reason: "moments_menu_not_found", real_action_attempted: false }
        : { ok: true, status: "verified", no_op: false, real_action_attempted: true };
    }
  });
  assert.equal(queueController.start({ maxPosts: 1, likeEnabled: true, commentEnabled: false }).ok, true);
  const queueCompleted = await waitFor(
    () => queueController.status().state,
    (state) => state.status === "completed"
  );
  assert.equal(queueCompleted.liked_count, 1);
  assert.equal(queueObservations, 1, "same-screen candidates must share one observation");
  assert.deepEqual(queueActionIds, [bottomSnapshot.observation_id, topSnapshot.observation_id]);
  assert.equal(queueScrolls, 0, "one failed candidate must not scroll before the same-screen queue is exhausted");

  const commentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-comment-"));
  const commentFingerprint = "d".repeat(64);
  const commentCommands = [];
  const commentEvents = [];
  const commentSendClickedAt = "2026-07-28T10:00:00.000Z";
  const commentController = createMomentsCampaignController({
    baseDir: commentRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "comment-owner" } }),
      release: () => undefined
    },
    logger: {
      event: (module, event, details, options) => {
        commentEvents.push({ module, event, details, options });
      }
    },
    openMoments: async () => INTEGRATED_OPEN_RESULT,
    scrollMoments: async () => ({ ok: true }),
    generateComment: async ({ postText, guidance }) => {
      assert.equal(postText, "今天完成了新门店的设备安装");
      assert.equal(guidance, "自然一点");
      return { comment: "新门店布置得很有质感，开业顺利！" };
    },
    runStep: async (args, runOptions) => {
      assert.equal(runOptions.dataDir, commentRoot, "every campaign subprocess must share the campaign state directory");
      assert.equal(runOptions.owner, "comment-owner");
      commentCommands.push(args);
      if (args[0] === "moments-dry-run") {
        return {
          ok: true,
          post_snapshot: {
            observation_id: commentFingerprint,
            post_fingerprint: commentFingerprint,
            identity_text: "今天完成了新门店的设备安装"
          },
          plan: { visible_post_count: 1 }
        };
      }
      assert.equal(args[0], "moments-comment");
      assert.equal(
        Buffer.from(args[args.indexOf("--comment-text-base64") + 1], "base64").toString("utf8"),
        "新门店布置得很有质感，开业顺利！"
      );
      return {
        ok: true,
        status: "verified",
        stage: "post_send_verified",
        send_clicked_at: commentSendClickedAt,
        verification_mode: "composer_consumed",
        real_action_attempted: true,
        diagnostics: {
          composer_completed: true,
          send_button_count: 1
        }
      };
    }
  });
  assert.equal(commentController.start({
    maxPosts: 1,
    likeEnabled: false,
    commentEnabled: true,
    commentGuidance: "自然一点"
  }).ok, true);
  const commentCompleted = await waitFor(
    () => commentController.status().state,
    (state) => state.status === "completed"
  );
  assert.equal(commentCompleted.processed_count, 1);
  assert.equal(commentCompleted.liked_count, 0);
  assert.equal(commentCompleted.commented_count, 1);
  assert.equal(commentCompleted.comment_skipped_count, 0);
  assert.equal(commentCommands.filter((args) => args[0] === "moments-dry-run").length, 1);
  assert.deepEqual(
    commentCommands
      .filter((args) => args[0] === "moments-dry-run")
      .map(expectedWindowFromArgs),
    [INTEGRATED_EXPECTED_SURFACE],
    "the initial observation must remain bound to the exact integrated host"
  );
  assert.equal(
    commentCommands.some((args) => args.includes("--comment-enabled")),
    true,
    "the initial observation must declare the later AI comment intent"
  );
  assert.equal(
    commentCommands.some((args) => args.includes("--comment-intent-only")),
    true,
    "the first observation must retain one shared comment context without a second dry-run"
  );
  const commentFinished = commentEvents.filter(({ event }) => event === "campaign.comment_finished");
  assert.equal(commentFinished.length, 1);
  assert.equal(commentFinished[0].details.reason, "");
  assert.equal(commentFinished[0].details.stage, "post_send_verified");
  assert.equal(commentFinished[0].details.send_clicked_at, commentSendClickedAt);
  assert.equal(commentFinished[0].details.verification_mode, "composer_consumed");
  assert.equal(commentFinished[0].details.real_action_attempted, true);
  assert.deepEqual(commentFinished[0].details.diagnostics, {
    composer_completed: true,
    send_button_count: 1
  });
  assert.equal(Object.prototype.hasOwnProperty.call(commentFinished[0].details, "comment_text"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(commentFinished[0].details, "result"), false);

  const incompleteVisualRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-partial-visual-comment-"));
  const incompleteVisualPost = {
    observation_id: "1".repeat(64),
    post_fingerprint: "1".repeat(64),
    source: "visual:windows_media_ocr",
    structure_verified: true,
    identity_text: "新门店设备安装顺利完成",
    stable_anchor_text: "",
    avatar_hash: "a".repeat(64),
    bounds: { left: 400, top: 100, width: 500, height: 420 },
    menu_bounds: { left: 840, top: 460, width: 40, height: 28 },
    avatar_bounds: { left: 410, top: 120, width: 48, height: 48 }
  };
  let incompleteVisualGenerations = 0;
  let incompleteVisualLikes = 0;
  let incompleteVisualComments = 0;
  let incompleteVisualScrolls = 0;
  const incompleteVisualController = createMomentsCampaignController({
    baseDir: incompleteVisualRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "incomplete-visual-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    openMoments: async () => INTEGRATED_OPEN_RESULT,
    scrollMoments: async () => {
      incompleteVisualScrolls += 1;
      return { ok: true, delta: -240 };
    },
    generateComment: async ({ postText }) => {
      incompleteVisualGenerations += 1;
      assert.equal(postText, incompleteVisualPost.identity_text);
      return { comment: "新门店顺利落地，真不错！" };
    },
    runStep: async (args, runOptions) => {
      if (args[0] === "moments-dry-run") {
        return {
          ok: true,
          window: INTEGRATED_OBSERVED_WINDOW,
          post_snapshot: incompleteVisualPost,
          plan: { visible_post_count: 1 }
        };
      }
      if (args[0] === "moments-like") {
        incompleteVisualLikes += 1;
        return { ok: true, status: "verified", real_action_attempted: true };
      }
      assert.equal(args[0], "moments-comment");
      incompleteVisualComments += 1;
      return { ok: true, status: "verified", real_action_attempted: true };
    }
  });
  assert.equal(incompleteVisualController.start({
    maxPosts: 1,
    likeEnabled: true,
    commentEnabled: true
  }).ok, true);
  const incompleteVisualCompleted = await waitFor(
    () => incompleteVisualController.status().state,
    (state) => state.status === "completed"
  );
  assert.equal(incompleteVisualGenerations, 1, "visible fragments should be used directly for a short comment");
  assert.equal(incompleteVisualLikes, 1);
  assert.equal(incompleteVisualComments, 1);
  assert.equal(incompleteVisualScrolls, 0, "a visible, menu-bound post must not scroll to read its full text first");
  assert.equal(incompleteVisualCompleted.processed_count, 1);
  assert.equal(incompleteVisualCompleted.liked_count, 1);
  assert.equal(incompleteVisualCompleted.commented_count, 1);
  assert.equal(incompleteVisualCompleted.comment_skipped_count, 0);
  assert.equal(incompleteVisualCompleted.skipped_count, 0);

  const visualJitterRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-visual-jitter-duplicate-"));
  const visualJitterPosts = [
    {
      observation_id: "3".repeat(64),
      post_fingerprint: "3".repeat(64),
      source: "visual:windows_media_ocr",
      identity_text: "author today completed the first robot deployment batch",
      stable_anchor_text: "author completed first robot deployment",
      avatar_hash: "c".repeat(64)
    },
    {
      observation_id: "4".repeat(64),
      post_fingerprint: "4".repeat(64),
      source: "visual:windows_media_ocr",
      identity_text: "author today completed the first robot deployment batoh",
      stable_anchor_text: "author completed first robot deployrnent",
      avatar_hash: "c".repeat(64)
    },
    {
      observation_id: "5".repeat(64),
      post_fingerprint: "5".repeat(64),
      source: "visual:windows_media_ocr",
      identity_text: "different author shared a new cleaning robot field report",
      stable_anchor_text: "different author new cleaning robot report",
      avatar_hash: "d".repeat(64)
    }
  ];
  let visualJitterObservationIndex = 0;
  let visualJitterCurrentPost = visualJitterPosts[0];
  let visualJitterScrolls = 0;
  let visualJitterComments = 0;
  const visualJitterGeneratedFrom = [];
  const visualJitterController = createMomentsCampaignController({
    baseDir: visualJitterRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "visual-jitter-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    openMoments: async () => INTEGRATED_OPEN_RESULT,
    scrollMoments: async () => {
      visualJitterScrolls += 1;
      return { ok: true };
    },
    generateComment: async ({ postText }) => {
      visualJitterGeneratedFrom.push(postText);
      return { comment: `comment ${visualJitterGeneratedFrom.length}` };
    },
    runStep: async (args, runOptions) => {
      if (args[0] === "moments-expand-full-text") {
        return { ok: true, status: "not_present", expanded: false, real_action_attempted: false };
      }
      if (args[0] === "moments-dry-run") {
        if (runOptions.phase === "moments:observe") {
          visualJitterCurrentPost = visualJitterPosts[Math.min(
            visualJitterObservationIndex,
            visualJitterPosts.length - 1
          )];
          visualJitterObservationIndex += 1;
        }
        return {
          ok: true,
          window: INTEGRATED_OBSERVED_WINDOW,
          post_snapshot: visualJitterCurrentPost,
          plan: { visible_post_count: 1 }
        };
      }
      assert.equal(args[0], "moments-comment");
      visualJitterComments += 1;
      return { ok: true, status: "verified", real_action_attempted: true };
    }
  });
  assert.equal(visualJitterController.start({
    maxPosts: 2,
    likeEnabled: false,
    commentEnabled: true
  }).ok, true);
  const visualJitterCompleted = await waitFor(
    () => visualJitterController.status().state,
    (state) => state.status === "completed"
  );
  assert.deepEqual(visualJitterGeneratedFrom, [
    visualJitterPosts[0].identity_text,
    visualJitterPosts[2].identity_text
  ], "OCR jitter on the same avatar and stable body must not turn one post into two comment targets");
  assert.equal(visualJitterComments, 2);
  assert.equal(visualJitterScrolls, 2);
  assert.equal(visualJitterCompleted.processed_count, 2);
  assert.equal(visualJitterCompleted.commented_count, 2);

  const commentSkipThenSuccessRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-comment-skip-then-success-"));
  const skipThenSuccessFingerprints = ["6".repeat(64), "7".repeat(64)];
  let skipThenSuccessObservation = 0;
  let skipThenSuccessDryRuns = 0;
  let skipThenSuccessComments = 0;
  const skipThenSuccessEvents = [];
  const skipThenSuccessStates = [];
  const commentSkipThenSuccessController = createMomentsCampaignController({
    baseDir: commentSkipThenSuccessRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "comment-skip-owner" } }),
      release: () => undefined
    },
    logger: {
      event: (module, event, details, options) => {
        skipThenSuccessEvents.push({ module, event, details, options });
      }
    },
    emit: (state) => skipThenSuccessStates.push(state),
    openMoments: async () => STANDALONE_OPEN_RESULT,
    scrollMoments: async () => ({ ok: true }),
    generateComment: async () => ({ comment: "一条新的测试评论" }),
    runStep: async (args) => {
      if (args[0] === "moments-expand-full-text") {
        return { ok: true, status: "not_present", expanded: false, real_action_attempted: false };
      }
      if (args[0] === "moments-dry-run") {
        const fingerprint = skipThenSuccessFingerprints[Math.min(skipThenSuccessDryRuns, 1)];
        skipThenSuccessDryRuns += 1;
        skipThenSuccessObservation += 1;
        return {
          ok: true,
          post_snapshot: {
            observation_id: fingerprint,
            post_fingerprint: fingerprint,
            identity_text: `测试帖子 ${skipThenSuccessObservation}`
          },
          plan: { visible_post_count: 1 }
        };
      }
      skipThenSuccessComments += 1;
      if (skipThenSuccessComments === 1) {
        return {
          ok: false,
          status: "blocked",
          blocked_reason: "moments_comment_draft_close_unverified",
          primary_reason: "moments_comment_send_button_ambiguous",
          cleanup_reason: "moments_comment_draft_close_unverified",
          stage: "draft_written",
          verification_mode: "green_component_geometry",
          previous_status: "outcome_unknown",
          real_action_attempted: false,
          diagnostics: {
            composer_completed: true,
            send_button_count: 2
          }
        };
      }
      return {
        ok: true,
        status: "verified",
        real_action_attempted: true
      };
    }
  });
  assert.equal(commentSkipThenSuccessController.start({
    maxPosts: 1,
    likeEnabled: false,
    commentEnabled: true
  }).ok, true);
  const commentSkipThenSuccess = await waitFor(
    () => commentSkipThenSuccessController.status().state,
    (state) => state.status === "completed"
  );
  assert.equal(commentSkipThenSuccess.processed_count, 2);
  assert.equal(commentSkipThenSuccess.commented_count, 1);
  assert.equal(commentSkipThenSuccess.comment_skipped_count, 1);
  assert.equal(skipThenSuccessComments, 2, "an already-commented post must not consume the requested success target");
  const skipCommentEvents = skipThenSuccessEvents.filter(({ event }) => event === "campaign.comment_finished");
  assert.equal(skipCommentEvents.length, 2);
  assert.equal(skipCommentEvents[0].details.reason, "moments_comment_send_button_ambiguous");
  assert.equal(skipCommentEvents[0].details.primary_reason, "moments_comment_send_button_ambiguous");
  assert.equal(skipCommentEvents[0].details.cleanup_reason, "moments_comment_draft_close_unverified");
  assert.equal(skipCommentEvents[0].details.stage, "draft_written");
  assert.equal(skipCommentEvents[0].details.verification_mode, "green_component_geometry");
  assert.equal(skipCommentEvents[0].details.real_action_attempted, false);
  assert.deepEqual(skipCommentEvents[0].details.diagnostics, {
    composer_completed: true,
    send_button_count: 2
  });
  assert.equal(
    skipThenSuccessStates.some((state) => state.last_comment_skip_reason === "moments_comment_send_button_ambiguous"),
    true,
    "a skipped comment should remain visible in floating progress after the task advances",
  );

  const commentUnknownRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-comment-outcome-unknown-"));
  const unknownFingerprint = "8".repeat(64);
  const unknownSendClickedAt = "2026-07-28T11:00:00.000Z";
  const unknownEvents = [];
  let unknownCommentCalls = 0;
  const commentUnknownController = createMomentsCampaignController({
    baseDir: commentUnknownRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "comment-unknown-owner" } }),
      release: () => undefined
    },
    logger: {
      event: (module, event, details, options) => {
        unknownEvents.push({ module, event, details, options });
      }
    },
    openMoments: async () => STANDALONE_OPEN_RESULT,
    scrollMoments: async () => ({ ok: true }),
    generateComment: async () => ({ comment: "一条结果未知测试评论" }),
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        return {
          ok: true,
          post_snapshot: {
            observation_id: unknownFingerprint,
            post_fingerprint: unknownFingerprint,
            identity_text: "结果未知测试帖子"
          },
          plan: { visible_post_count: 1 }
        };
      }
      unknownCommentCalls += 1;
      return {
        ok: false,
        status: "outcome_unknown",
        blocked_reason: "moments-comment_outcome_unknown",
        primary_reason: "moments_comment_post_send_unverified",
        cleanup_reason: "moments_comment_draft_close_unverified",
        stage: "send_clicked",
        send_clicked_at: unknownSendClickedAt,
        verification_mode: "post_send_state_transition",
        real_action_attempted: true,
        diagnostics: {
          send_button_clicked: true,
          composer_completed: false
        }
      };
    }
  });
  assert.equal(commentUnknownController.start({
    maxPosts: 1,
    likeEnabled: false,
    commentEnabled: true
  }).ok, true);
  const commentUnknown = await waitFor(
    () => commentUnknownController.status().state,
    (state) => state.status === "paused"
  );
  assert.equal(commentUnknown.last_reason, "moments_comment_post_send_unverified");
  assert.equal(unknownCommentCalls, 1, "an attempted send with unknown outcome must pause without retry");
  const unknownFinished = unknownEvents.find(({ event }) => event === "campaign.comment_finished");
  assert.equal(unknownFinished.details.reason, "moments_comment_post_send_unverified");
  assert.equal(unknownFinished.details.primary_reason, "moments_comment_post_send_unverified");
  assert.equal(unknownFinished.details.cleanup_reason, "moments_comment_draft_close_unverified");
  assert.equal(unknownFinished.details.stage, "send_clicked");
  assert.equal(unknownFinished.details.send_clicked_at, unknownSendClickedAt);
  assert.equal(unknownFinished.details.verification_mode, "post_send_state_transition");
  assert.equal(unknownFinished.details.real_action_attempted, true);

  const aiFailureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-ai-failure-"));
  const aiFailureController = createMomentsCampaignController({
    baseDir: aiFailureRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "ai-failure-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    openMoments: async () => STANDALONE_OPEN_RESULT,
    scrollMoments: async () => ({ ok: true }),
    generateComment: async () => {
      const error = new Error("temporary failure");
      error.code = "AI_REQUEST_TIMEOUT";
      throw error;
    },
    runStep: async () => ({
      ok: true,
      post_snapshot: {
        observation_id: "e".repeat(64),
        post_fingerprint: "e".repeat(64),
        identity_text: "一条测试帖子"
      },
      plan: { visible_post_count: 1 }
    })
  });
  assert.equal(aiFailureController.start({
    maxPosts: 1,
    likeEnabled: false,
    commentEnabled: true
  }).ok, true);
  const aiFailureCompleted = await waitFor(
    () => aiFailureController.status().state,
    (state) => state.status === "partial"
  );
  assert.equal(aiFailureCompleted.processed_count, 1);
  assert.equal(aiFailureCompleted.commented_count, 0);
  assert.equal(aiFailureCompleted.comment_skipped_count, 1);
  assert.equal(aiFailureCompleted.skipped_count, 1);
  assert.equal(aiFailureCompleted.last_reason, "no_progress");

  const crossedStatusRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-crossed-status-"));
  const crossedStatusFingerprint = "9".repeat(64);
  const crossedStatusController = createMomentsCampaignController({
    baseDir: crossedStatusRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "crossed-status-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    openMoments: async () => STANDALONE_OPEN_RESULT,
    scrollMoments: async () => ({ ok: true }),
    generateComment: async () => ({ comment: "crossed status test" }),
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        return {
          ok: true,
          post_snapshot: {
            observation_id: crossedStatusFingerprint,
            post_fingerprint: crossedStatusFingerprint,
            identity_text: "crossed status post"
          },
          plan: { visible_post_count: 1 }
        };
      }
      return {
        ok: true,
        status: "outcome_unknown",
        real_action_attempted: true,
        primary_reason: "moments_comment_post_send_unverified"
      };
    }
  });
  assert.equal(crossedStatusController.start({
    maxPosts: 1,
    likeEnabled: false,
    commentEnabled: true
  }).ok, true);
  const crossedStatusPaused = await waitFor(
    () => crossedStatusController.status().state,
    (state) => state.status === "paused"
  );
  assert.equal(crossedStatusPaused.commented_count, 0);
  assert.equal(crossedStatusPaused.completed_post_count, 0);
  assert.equal(crossedStatusPaused.last_reason, "moments_comment_post_send_unverified");

  const combinedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-combined-per-post-"));
  const combinedFingerprints = ["a".repeat(64), "b".repeat(64)];
  let combinedDryRuns = 0;
  let combinedLikeCalls = 0;
  let combinedCommentCalls = 0;
  let combinedScrolls = 0;
  const combinedController = createMomentsCampaignController({
    baseDir: combinedRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "combined-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    openMoments: async () => STANDALONE_OPEN_RESULT,
    scrollMoments: async () => {
      combinedScrolls += 1;
      return combinedScrolls === 1 ? { ok: true } : { ok: false, reason: "combined_test_end" };
    },
    generateComment: async () => ({ comment: "combined mode test" }),
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        const fingerprint = combinedFingerprints[Math.min(combinedDryRuns, 1)];
        combinedDryRuns += 1;
        return {
          ok: true,
          post_snapshot: {
            observation_id: fingerprint,
            post_fingerprint: fingerprint,
            identity_text: `combined post ${fingerprint[0]}`
          },
          plan: { visible_post_count: 1 }
        };
      }
      if (args[0] === "moments-like") {
        combinedLikeCalls += 1;
        return combinedLikeCalls === 1
          ? { ok: true, status: "verified", no_op: false, real_action_attempted: true }
          : {
            ok: false,
            status: "blocked",
            blocked_reason: "moments_like_menu_not_found",
            real_action_attempted: false
          };
      }
      combinedCommentCalls += 1;
      return combinedCommentCalls === 1
        ? {
          ok: false,
          status: "blocked",
          blocked_reason: "moments_comment_open_blocked",
          real_action_attempted: false
        }
        : { ok: true, status: "verified", real_action_attempted: true };
    }
  });
  assert.equal(combinedController.start({
    maxPosts: 1,
    likeEnabled: true,
    commentEnabled: true
  }).ok, true);
  const combinedCompleted = await waitFor(
    () => combinedController.status().state,
    (state) => state.status === "completed"
  );
  assert.equal(combinedCompleted.liked_count, 1);
  assert.equal(combinedCompleted.commented_count, 1);
  assert.equal(combinedCompleted.completed_post_count, 1);
  assert.equal(combinedCompleted.last_reason, "target_count_reached");

  const workflowYieldRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-workflow-yield-"));
  const workflowYieldFingerprints = ["f".repeat(64), "g".repeat(64), "i".repeat(64), "h".repeat(64)];
  const continuousPostText = "workshop maintenance training and practical equipment installation";
  let workflowOpenCalls = 0;
  let workflowScrollCalls = 0;
  let workflowYieldDryRuns = 0;
  let workflowYieldLikeCalls = 0;
  let workflowYieldCommentCalls = 0;
  const workflowYieldController = createMomentsCampaignController({
    baseDir: workflowYieldRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "workflow-yield-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    openMoments: async () => { workflowOpenCalls += 1; return STANDALONE_OPEN_RESULT; },
    scrollMoments: async () => { workflowScrollCalls += 1; return { ok: true }; },
    generateComment: async () => ({ comment: "workflow comment test" }),
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        const fingerprint = workflowYieldFingerprints[Math.min(workflowYieldDryRuns, 3)];
        workflowYieldDryRuns += 1;
        return {
          ok: true,
          window: STANDALONE_OPEN_RESULT,
          post_snapshot: {
            observation_id: fingerprint,
            post_fingerprint: fingerprint,
            identity_text: fingerprint[0] === "g" ? continuousPostText
              : fingerprint[0] === "i" ? `additional visible introduction ${continuousPostText}` : `workflow post ${fingerprint[0]}`,
            source: "visual:mmui",
            avatar_hash: (fingerprint[0] === "i" ? "b" : "a").repeat(64)
          },
          plan: { visible_post_count: 1 }
        };
      }
      if (args[0] === "moments-like") {
        workflowYieldLikeCalls += 1;
        return { ok: true, status: "verified", no_op: false, real_action_attempted: true };
      }
      assert.equal(args[0], "moments-comment");
      workflowYieldCommentCalls += 1;
      assert.equal(workflowYieldController.workflowProgress(workflowTask).liked, workflowYieldLikeCalls,
        "verified likes must be visible before the comment finishes");
      if (workflowYieldCommentCalls === 1) {
        return {
          ok: false,
          status: "blocked",
          blocked_reason: "moments_comment_send_button_ambiguous",
          primary_reason: "moments_comment_send_button_ambiguous",
          verification_mode: "green_component_geometry",
          previous_status: "outcome_unknown",
          stage: "draft_written",
          cleanup_reason: "moments_comment_send_button_ambiguous",
          real_action_attempted: false
        };
      }
      return { ok: true, status: "verified", real_action_attempted: true };
    }
  });
  const workflowTask = {
    id: "workflow-yield-task",
    payload: {
      maxPosts: 2,
      likeEnabled: true,
      commentEnabled: true
    },
    occurrenceDate: "2026-09-02"
  };
  const workflowYieldFirst = await workflowYieldController.runWorkflowStep(
    workflowTask,
    { isEnabled: () => true }
  );
  assert.equal(workflowYieldFirst.status, "completed");
  const workflowYieldFirstState = workflowYieldController.status().state;
  assert.equal(workflowYieldFirstState.status, "completed");
  assert.equal(workflowYieldFirstState.last_reason, "target_count_reached");
  assert.equal(workflowYieldFirstState.processed_count, 3);
  assert.equal(workflowYieldFirstState.new_completed_post_count, 2);
  assert.equal(workflowYieldFirstState.completed_post_count, 2);
  assert.equal(workflowYieldFirstState.comment_skipped_count, 1);
  assert.equal(workflowYieldFirstState.commented_count, 2);
  assert.equal(workflowYieldFirstState.liked_count, 3);

  const workflowYieldSecond = await workflowYieldController.runWorkflowStep(
    workflowTask,
    { isEnabled: () => true }
  );
  assert.equal(workflowYieldSecond.status, "completed");
  const workflowYieldSecondState = workflowYieldController.status().state;
  assert.equal(workflowYieldSecondState.status, "completed");
  assert.equal(workflowYieldSecondState.last_reason, "target_count_reached");
  assert.equal(workflowYieldSecond.progress.scanned, 3);
  assert.equal(workflowYieldSecondState.new_completed_post_count, 2);
  assert.equal(workflowYieldSecondState.completed_post_count, 2);
  assert.equal(workflowYieldSecond.progress.skipped, 1);
  assert.equal(workflowYieldSecond.progress.commented, 2);
  assert.equal(workflowYieldSecond.progress.liked, 3);
  assert.equal(workflowYieldController.workflowProgress(workflowTask).liked, 3, "persist cumulative results during one continuous batch");
  assert.equal(workflowYieldDryRuns, 4);
  assert.equal(workflowYieldLikeCalls, 3);
  assert.equal(workflowYieldCommentCalls, 3, "a larger OCR crop of the completed post must not cause another comment");
  assert.equal(workflowOpenCalls, 1, "one batch must open Moments only once");
  assert.equal(workflowScrollCalls, 3, "skip the old post and keep scrolling without yielding to chat");

  const directInteractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-direct-interaction-"));
  const directInteractionFingerprint = "c".repeat(64);
  const directInteractionDryRuns = [];
  let directInteractionLikes = 0;
  let directInteractionComments = 0;
  const directInteractionController = createMomentsCampaignController({
    baseDir: directInteractionRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "direct-interaction-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    openMoments: async () => INTEGRATED_OPEN_RESULT,
    generateComment: async ({ postText }) => {
      assert.equal(postText, "visible partial context is enough to comment");
      return { comment: "direct interaction comment" };
    },
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        directInteractionDryRuns.push(args);
        return {
          ok: true,
          window: INTEGRATED_OBSERVED_WINDOW,
          post_snapshot: {
            observation_id: directInteractionFingerprint,
            post_fingerprint: directInteractionFingerprint,
            identity_text: "visible partial context is enough to comment"
          },
          plan: { visible_post_count: 1 }
        };
      }
      const observationIdIndex = args.indexOf("--observation-id");
      assert.equal(args[observationIdIndex + 1], directInteractionFingerprint);
      if (args[0] === "moments-like") {
        directInteractionLikes += 1;
        return { ok: true, status: "verified", real_action_attempted: true };
      }
      assert.equal(args[0], "moments-comment");
      directInteractionComments += 1;
      return { ok: true, status: "verified", real_action_attempted: true };
    }
  });
  assert.equal(directInteractionController.start({
    maxPosts: 1,
    likeEnabled: true,
    commentEnabled: true
  }).ok, true);
  const directInteractionDone = await waitFor(
    () => directInteractionController.status().state,
    (state) => state.status === "completed"
  );
  assert.equal(directInteractionDone.liked_count, 1);
  assert.equal(directInteractionDone.commented_count, 1);
  assert.equal(directInteractionLikes, 1);
  assert.equal(directInteractionComments, 1);
  assert.equal(directInteractionDryRuns.length, 1, "a visible post and menu must be observed once before direct interaction");
  assert.equal(directInteractionDryRuns[0].includes("--comment-enabled"), true);
  assert.equal(directInteractionDryRuns[0].includes("--comment-intent-only"), true);
  assert.equal(directInteractionDryRuns[0].includes("--allow-body-only"), true);
  assert.equal(directInteractionDryRuns[0].includes("--target-post-fingerprint"), false);

  const partialAlignmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-partial-alignment-limit-"));
  let partialAlignmentScans = 0;
  let partialAlignmentScrolls = 0;
  const partialAlignmentController = createMomentsCampaignController({
    baseDir: partialAlignmentRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "partial-alignment-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    openMoments: async () => STANDALONE_OPEN_RESULT,
    scrollMoments: async () => {
      partialAlignmentScrolls += 1;
      return { ok: true };
    },
    runStep: async (args) => {
      if (args[0] !== "moments-dry-run") {
        return {
          ok: false,
          status: "blocked",
          blocked_reason: "moments_menu_not_found",
          real_action_attempted: false
        };
      }
      partialAlignmentScans += 1;
      const fingerprint = String(partialAlignmentScans).padStart(64, "0");
      return {
        ok: true,
        post_snapshot: {
          observation_id: fingerprint,
          post_fingerprint: fingerprint,
          identity_text: "partial visible post"
        },
        plan: { visible_post_count: 1, target_partial_visible: true }
      };
    }
  });
  assert.equal(partialAlignmentController.start({ maxPosts: 11 }).ok, true);
  const partialAlignmentDone = await waitFor(
    () => partialAlignmentController.status().state,
    (state) => state.status === "partial"
  );
  assert.equal(partialAlignmentDone.processed_count, 2);
  assert.equal(partialAlignmentScans, 2);
  assert.equal(partialAlignmentScrolls, 1);
  assert.equal(partialAlignmentDone.last_reason, "no_progress");

  const visibleTextMissingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-visible-text-missing-"));
  let visibleTextMissingScans = 0;
  let visibleTextMissingScrolls = 0;
  let visibleTextMissingLikes = 0;
  let visibleTextMissingComments = 0;
  const textMissingSnapshot = {
    observation_id: "e".repeat(64),
    post_fingerprint: "e".repeat(64),
    source: "visual:interaction_anchor",
    structure_verified: true,
    interaction_only: true,
    identity_text: "interaction-anchor:first-post",
    stable_anchor_text: "",
    avatar_hash: "e".repeat(64),
    bounds: { left: 400, top: 200, width: 500, height: 420 },
    menu_bounds: { left: 840, top: 560, width: 40, height: 28 },
    avatar_bounds: { left: 410, top: 220, width: 48, height: 48 }
  };
  const secondTextMissingSnapshot = {
    ...textMissingSnapshot,
    observation_id: "d".repeat(64),
    post_fingerprint: "d".repeat(64),
    identity_text: "interaction-anchor:second-post",
    avatar_hash: "d".repeat(64),
    bounds: { left: 400, top: 180, width: 500, height: 420 },
    menu_bounds: { left: 840, top: 540, width: 40, height: 28 },
    avatar_bounds: { left: 410, top: 200, width: 48, height: 48 }
  };
  const nextVisibleSnapshot = {
    observation_id: "f".repeat(64),
    post_fingerprint: "f".repeat(64),
    source: "visual:windows_media_ocr",
    structure_verified: true,
    identity_text: "next author shared a complete cleaning robot field report",
    stable_anchor_text: "next author cleaning robot field report",
    avatar_hash: "f".repeat(64),
    bounds: { left: 400, top: 180, width: 500, height: 420 },
    menu_bounds: { left: 840, top: 540, width: 40, height: 28 },
    avatar_bounds: { left: 410, top: 200, width: 48, height: 48 }
  };
  const visibleTextMissingController = createMomentsCampaignController({
    baseDir: visibleTextMissingRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "visible-text-missing-owner" } }),
      release: () => undefined
    },
    openMoments: async () => INTEGRATED_OPEN_RESULT,
    scrollMoments: async () => {
      visibleTextMissingScrolls += 1;
      return { ok: true, delta: -480 };
    },
    generateComment: async ({ postText }) => {
      assert.equal(postText, nextVisibleSnapshot.identity_text);
      return { comment: "next-post-only comment" };
    },
    runStep: async (args) => {
      if (args[0] === "moments-like") {
        visibleTextMissingLikes += 1;
        return { ok: true, status: "verified", real_action_attempted: true };
      }
      if (args[0] === "moments-comment") {
        visibleTextMissingComments += 1;
        return { ok: true, status: "verified", real_action_attempted: true };
      }
      assert.equal(args[0], "moments-dry-run");
      const snapshots = [textMissingSnapshot, secondTextMissingSnapshot, nextVisibleSnapshot];
      const postSnapshot = snapshots[Math.min(visibleTextMissingScans, snapshots.length - 1)];
      visibleTextMissingScans += 1;
      return {
        ok: true,
        window: { ...INTEGRATED_OBSERVED_WINDOW, renderPaneBounds: { ...INTEGRATED_OBSERVED_WINDOW.renderPaneBounds, height: 900 } },
        post_snapshot: postSnapshot,
        plan: { visible_post_count: 1 }
      };
    }
  });
  assert.equal(visibleTextMissingController.start({
    maxPosts: 1,
    likeEnabled: true,
    commentEnabled: true
  }).ok, true);
  const visibleTextMissingDone = await waitFor(
    () => visibleTextMissingController.status().state,
    (state) => state.status === "completed"
  );
  assert.equal(visibleTextMissingDone.processed_count, 3);
  assert.equal(visibleTextMissingDone.liked_count, 3, "missing comment text must not block the current like");
  assert.equal(visibleTextMissingDone.comment_skipped_count, 2);
  assert.equal(visibleTextMissingDone.commented_count, 1);
  assert.equal(visibleTextMissingLikes, 3);
  assert.equal(visibleTextMissingComments, 1);
  assert.equal(visibleTextMissingScans, 3);
  assert.equal(visibleTextMissingScrolls, 2);

  const foregroundRecoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-foreground-recovery-"));
  const foregroundRecoveryEvents = [];
  const foregroundOpenCalls = [];
  let foregroundObservationCalls = 0;
  let foregroundLikeCalls = 0;
  const foregroundRecoveryController = createMomentsCampaignController({
    baseDir: foregroundRecoveryRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "foreground-recovery-owner" } }),
      release: () => undefined
    },
    logger: {
      event: (module, event, details) => foregroundRecoveryEvents.push({ module, event, details })
    },
    openMoments: async (options) => {
      foregroundOpenCalls.push(options);
      return INTEGRATED_OPEN_RESULT;
    },
    scrollMoments: async () => ({ ok: true, delta: -480 }),
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        foregroundObservationCalls += 1;
        if (foregroundObservationCalls === 1) {
          return { ok: false, reason: "moments_window_not_foreground" };
        }
        return {
          ok: true,
          window: INTEGRATED_OBSERVED_WINDOW,
          post_snapshot: {
            observation_id: "9".repeat(64),
            post_fingerprint: "9".repeat(64),
            identity_text: "foreground recovery test post"
          },
          plan: { visible_post_count: 1 }
        };
      }
      assert.equal(args[0], "moments-like");
      foregroundLikeCalls += 1;
      return { ok: true, status: "verified", no_op: false, real_action_attempted: true };
    }
  });
  assert.equal(foregroundRecoveryController.start({
    maxPosts: 1,
    likeEnabled: true,
    commentEnabled: false
  }).ok, true);
  const foregroundRecoveryDone = await waitFor(
    () => foregroundRecoveryController.status().state,
    (state) => state.status === "completed"
  );
  assert.equal(foregroundRecoveryDone.completed_post_count, 1);
  assert.equal(foregroundObservationCalls, 2);
  assert.equal(foregroundLikeCalls, 1);
  assert.equal(foregroundOpenCalls.length, 2);
  assert.deepEqual(foregroundOpenCalls[1].expectedWindow, INTEGRATED_OPEN_RESULT);
  assert.equal(
    foregroundRecoveryEvents.some(({ event, details }) => event === "campaign.foreground_recovered"
      && details.reason === "moments_window_not_foreground"),
    true
  );

  const rejectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-rejected-"));
  const rejectedEvents = [];
  const rejectedController = createMomentsCampaignController({
    baseDir: rejectedRoot,
    coordinator: {
      acquire: () => ({ ok: false, error: "invalid_runtime_state" })
    },
    logger: {
      event: (module, event, details) => rejectedEvents.push({ module, event, details })
    }
  });
  const rejected = rejectedController.start({ maxPosts: 1 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "invalid_runtime_state");
  assert.equal(rejectedEvents[0].module, "moments");
  assert.equal(rejectedEvents[0].event, "campaign.start_rejected");
  assert.equal(rejectedEvents[0].details.reason, "invalid_runtime_state");

  const retryTask = { id: "11111111-1111-4111-8111-111111111111", occurrenceDate: "2026-09-03" };
  const retryDir = path.join(rejectedRoot, "planned_runs", retryTask.id);
  fs.mkdirSync(retryDir, { recursive: true });
  const retryFile = path.join(retryDir, "2026-09-03.json");
  const untouched = { done: 0, processed_posts: [], in_flight: null,
    metrics: { processed_count: 0, liked_count: 0, commented_count: 0 } };
  for (const [patch, expected] of [[{}, true], [{ in_flight: "post" }, false],
    [{ outcome_unknown: true }, false], [{ processed_posts: ["post"] }, false],
    [{ metrics: {} }, false], [{ metrics: { ...untouched.metrics, liked_count: 1 } }, false]]) {
    fs.writeFileSync(retryFile, JSON.stringify({ ...untouched, ...patch }));
    assert.equal(rejectedController.canRetryWorkflowTask(retryTask), expected);
  }

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(readingRoot, { recursive: true, force: true });
  fs.rmSync(standaloneRoot, { recursive: true, force: true });
  fs.rmSync(invalidSurfaceRoot, { recursive: true, force: true });
  fs.rmSync(likeRecognitionRoot, { recursive: true, force: true });
  fs.rmSync(topPositionRoot, { recursive: true, force: true });
  fs.rmSync(duplicateRoot, { recursive: true, force: true });
  fs.rmSync(duplicateUnknownRoot, { recursive: true, force: true });
  fs.rmSync(partialRoot, { recursive: true, force: true });
  fs.rmSync(commentRoot, { recursive: true, force: true });
  fs.rmSync(workflowYieldRoot, { recursive: true, force: true });
  fs.rmSync(incompleteVisualRoot, { recursive: true, force: true });
  fs.rmSync(visualJitterRoot, { recursive: true, force: true });
  fs.rmSync(commentSkipThenSuccessRoot, { recursive: true, force: true });
  fs.rmSync(commentUnknownRoot, { recursive: true, force: true });
  fs.rmSync(aiFailureRoot, { recursive: true, force: true });
  fs.rmSync(crossedStatusRoot, { recursive: true, force: true });
  fs.rmSync(combinedRoot, { recursive: true, force: true });
  fs.rmSync(partialAlignmentRoot, { recursive: true, force: true });
  fs.rmSync(visibleTextMissingRoot, { recursive: true, force: true });
  fs.rmSync(foregroundRecoveryRoot, { recursive: true, force: true });
  fs.rmSync(rejectedRoot, { recursive: true, force: true });
  console.log("moments campaign IPC self-check passed");
}

void main();
