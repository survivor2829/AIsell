const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createMomentsCampaignController } = require("./moments-campaign-ipc.cjs");

async function waitFor(read, predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("moments campaign self-check timed out");
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-"));
  const observations = ["a".repeat(64), "b".repeat(64)];
  let observationIndex = 0;
  let scrolls = 0;
  let releases = 0;
  const events = [];
  const controller = createMomentsCampaignController({
    baseDir: root,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "test-owner" } }),
      release: () => { releases += 1; }
    },
    logger: { event: (module, event) => events.push(`${module}:${event}`) },
    openMoments: async () => ({ ok: true }),
    scrollMoments: async () => {
      scrolls += 1;
      return { ok: true };
    },
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        const fingerprint = observations[Math.min(observationIndex, observations.length - 1)];
        observationIndex += 1;
        return {
          ok: true,
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

  const persisted = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
  assert.equal(persisted.moments_campaign.status, "completed");

  const likeRecognitionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-like-recognition-"));
  const likeRecognitionEvents = [];
  const likeRecognitionController = createMomentsCampaignController({
    baseDir: likeRecognitionRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "like-recognition-owner" } }),
      release: () => undefined
    },
    logger: { event: (module, event, details) => likeRecognitionEvents.push({ module, event, details }) },
    openMoments: async () => ({ ok: true }),
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
          menu_read_retry_count: 1,
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
  assert.equal(likeRecognitionPartial.last_reason, "target_not_reached");
  const likeRecognitionEvent = likeRecognitionEvents.find((entry) => entry.event === "campaign.like_finished");
  assert.deepEqual(likeRecognitionEvent.details.diagnostics, {
    requested_action: "like",
    menu_read_retry_count: 1,
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
    openMoments: async () => ({ ok: true }),
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
    openMoments: async () => ({ ok: true }),
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
    openMoments: async () => ({ ok: true }),
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
  const partialController = createMomentsCampaignController({
    baseDir: partialRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "partial-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    openMoments: async () => ({ ok: true }),
    scrollMoments: async () => {
      partialScrolls += 1;
      return { ok: true };
    },
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        partialObservations += 1;
        return {
          ok: true,
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
  assert.equal(partialObservations, 2);
  assert.equal(partialLikes, 1);
  assert.equal(partialScrolls, 1);

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
    openMoments: async () => ({ ok: true }),
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
  assert.equal(commentCommands.filter((args) => args[0] === "moments-dry-run").length, 2);
  assert.equal(
    commentCommands.some((args) => args.includes("--comment-enabled")),
    true,
    "the generated text must be bound into a fresh dry-run before sending"
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

  const commentSkipThenSuccessRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-comment-skip-then-success-"));
  const skipThenSuccessFingerprints = ["6".repeat(64), "7".repeat(64)];
  let skipThenSuccessObservation = 0;
  let skipThenSuccessDryRuns = 0;
  let skipThenSuccessComments = 0;
  const skipThenSuccessEvents = [];
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
    openMoments: async () => ({ ok: true }),
    scrollMoments: async () => ({ ok: true }),
    generateComment: async () => ({ comment: "一条新的测试评论" }),
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        const fingerprint = skipThenSuccessFingerprints[Math.min(Math.floor(skipThenSuccessDryRuns / 2), 1)];
        skipThenSuccessDryRuns += 1;
        if (skipThenSuccessDryRuns % 2 === 1) skipThenSuccessObservation += 1;
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
    openMoments: async () => ({ ok: true }),
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
    openMoments: async () => ({ ok: true }),
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
  assert.equal(aiFailureCompleted.last_reason, "target_not_reached");

  const crossedStatusRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-crossed-status-"));
  const crossedStatusFingerprint = "9".repeat(64);
  const crossedStatusController = createMomentsCampaignController({
    baseDir: crossedStatusRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "crossed-status-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    openMoments: async () => ({ ok: true }),
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
    openMoments: async () => ({ ok: true }),
    scrollMoments: async () => {
      combinedScrolls += 1;
      return combinedScrolls === 1 ? { ok: true } : { ok: false, reason: "combined_test_end" };
    },
    generateComment: async () => ({ comment: "combined mode test" }),
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        const fingerprint = combinedFingerprints[Math.min(Math.floor(combinedDryRuns / 2), 1)];
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
  const combinedPaused = await waitFor(
    () => combinedController.status().state,
    (state) => state.status === "paused"
  );
  assert.equal(combinedPaused.liked_count, 1);
  assert.equal(combinedPaused.commented_count, 1);
  assert.equal(combinedPaused.completed_post_count, 0);
  assert.equal(combinedPaused.last_reason, "combined_test_end");

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
    openMoments: async () => ({ ok: true }),
    scrollMoments: async () => {
      partialAlignmentScrolls += 1;
      return { ok: true };
    },
    runStep: async () => {
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
  assert.equal(partialAlignmentDone.processed_count, 0);
  assert.equal(partialAlignmentScans, 55);
  assert.equal(partialAlignmentScrolls, 55);

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

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(likeRecognitionRoot, { recursive: true, force: true });
  fs.rmSync(topPositionRoot, { recursive: true, force: true });
  fs.rmSync(duplicateRoot, { recursive: true, force: true });
  fs.rmSync(duplicateUnknownRoot, { recursive: true, force: true });
  fs.rmSync(partialRoot, { recursive: true, force: true });
  fs.rmSync(commentRoot, { recursive: true, force: true });
  fs.rmSync(commentSkipThenSuccessRoot, { recursive: true, force: true });
  fs.rmSync(commentUnknownRoot, { recursive: true, force: true });
  fs.rmSync(aiFailureRoot, { recursive: true, force: true });
  fs.rmSync(crossedStatusRoot, { recursive: true, force: true });
  fs.rmSync(combinedRoot, { recursive: true, force: true });
  fs.rmSync(partialAlignmentRoot, { recursive: true, force: true });
  fs.rmSync(rejectedRoot, { recursive: true, force: true });
  console.log("moments campaign IPC self-check passed");
}

void main();
