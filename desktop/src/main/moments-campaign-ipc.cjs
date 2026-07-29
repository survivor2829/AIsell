const fs = require("node:fs");
const path = require("node:path");
const { ipcMain } = require("electron");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { diagnostics } = require("./diagnostics.cjs");
const { runActiveTouchDev } = require("./active-touch-ipc.cjs");
const {
  openWechatMoments,
  scrollWechatMomentsFeed
} = require("../../rpa/active_touch/moments_navigation.dev.cjs");

const DEFAULT_MAX_POSTS = 10;
const MAX_POSTS_PER_RUN = 50;

function readJson(file, fallback = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && !Array.isArray(value) && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

function publicState(value = {}) {
  return {
    status: String(value.status || "idle"),
    max_posts: Number(value.max_posts || DEFAULT_MAX_POSTS),
    processed_count: Number(value.processed_count || 0),
    completed_post_count: Number(value.completed_post_count || 0),
    liked_count: Number(value.liked_count || 0),
    already_liked_count: Number(value.already_liked_count || 0),
    commented_count: Number(value.commented_count || 0),
    comment_skipped_count: Number(value.comment_skipped_count || 0),
    skipped_count: Number(value.skipped_count || 0),
    scroll_count: Number(value.scroll_count || 0),
    current_post: Number(value.current_post || 0),
    like_enabled: value.like_enabled !== false,
    comment_enabled: value.comment_enabled === true,
    comment_guidance: String(value.comment_guidance || ""),
    last_reason: String(value.last_reason || ""),
    started_at: String(value.started_at || ""),
    updated_at: String(value.updated_at || "")
  };
}

function createMomentsCampaignController(options = {}) {
  const baseDir = String(options.baseDir || "");
  const stateFile = path.join(baseDir, "state.json");
  const coordinator = options.coordinator;
  const runStep = options.runStep || ((args, runOptions) => runActiveTouchDev(args, runOptions));
  const openMoments = options.openMoments || openWechatMoments;
  const scrollMoments = options.scrollMoments || scrollWechatMomentsFeed;
  const generateComment = options.generateComment
    || (typeof options.deepSeekClient?.momentsComment === "function"
      ? (input) => options.deepSeekClient.momentsComment(input)
      : null);
  const emit = typeof options.emit === "function" ? options.emit : () => undefined;
  const logger = options.logger || diagnostics();
  let pauseRequested = false;
  let stopRequested = false;
  let loopPromise = null;
  let state = publicState(readJson(stateFile).moments_campaign);

  function persist(patch = {}) {
    state = publicState({ ...state, ...patch, updated_at: new Date().toISOString() });
    const root = readJson(stateFile);
    writeJsonAtomic(stateFile, { ...root, moments_campaign: state });
    emit(state);
    return state;
  }

  function record(event, fields = {}, level = "info") {
    logger.event("moments", event, {
      campaign: {
        ...state,
        comment_guidance: undefined,
        comment_guidance_length: state.comment_guidance.length
      },
      ...fields
    }, { level });
  }

  function finish(status, reason = "") {
    persist({ status, last_reason: reason, current_post: 0 });
    record(`campaign.${status}`, { reason }, status === "completed" ? "info" : "warn");
  }

  function shouldStop() {
    if (stopRequested) {
      finish("stopped", "stopped_by_user");
      return true;
    }
    if (pauseRequested) {
      finish("paused", "paused_by_user");
      return true;
    }
    return false;
  }

  function successfulPostCount() {
    return state.completed_post_count;
  }

  async function executeLoop(lockOwner) {
    try {
      record("campaign.open_started");
      const opened = await openMoments();
      record("campaign.open_finished", { result: opened }, opened?.ok ? "info" : "warn");
      if (!opened?.ok) {
        finish("paused", opened?.reason || "moments_open_failed");
        return;
      }

      const processedFingerprints = new Set();
      const alignedPartialFingerprints = new Set();
      let emptyScans = 0;
      let repeatedFingerprintScans = 0;
      let candidateChecks = 0;
      const candidateLimit = state.max_posts * 5;
      while (successfulPostCount() < state.max_posts && candidateChecks < candidateLimit) {
        if (shouldStop()) return;
        persist({ current_post: state.processed_count + 1, last_reason: "observing_post" });
        const observed = await runStep(
          ["moments-dry-run", "--mode", "random", "--like"],
          {
            cliName: "moments_dry_run_cli.dev.cjs",
            dataDir: baseDir,
            owner: lockOwner,
            phase: "moments:observe",
            timeoutMs: 45_000
          }
        );
        candidateChecks += 1;
        record("campaign.observation_finished", {
          ok: observed?.ok === true,
          reason: observed?.blocked_reason || observed?.reason || "",
          visible_post_count: observed?.plan?.visible_post_count || 0
        }, observed?.ok ? "info" : "warn");

        if (!observed?.ok) {
          const reason = String(observed?.blocked_reason || observed?.reason || "moments_observation_failed");
          if (reason === "moments_post_not_found" && emptyScans < 2) {
            emptyScans += 1;
          } else {
            finish("paused", reason);
            return;
          }
        } else {
          emptyScans = 0;
          const observationId = String(observed.post_snapshot?.observation_id || "");
          const fingerprint = String(observed.post_snapshot?.post_fingerprint || "");
          if (!observationId || !fingerprint) {
            finish("paused", "moments_observation_identity_missing");
            return;
          }

          if (
            observed.plan?.target_partial_visible === true
            && !alignedPartialFingerprints.has(fingerprint)
          ) {
            alignedPartialFingerprints.add(fingerprint);
            const aligned = await scrollMoments();
            record("campaign.partial_alignment_finished", {
              fingerprint,
              result: aligned
            }, aligned?.ok ? "info" : "warn");
            if (!aligned?.ok) {
              finish("paused", aligned?.reason || "moments_scroll_failed");
              return;
            }
            persist({
              scroll_count: state.scroll_count + 1,
              last_reason: "partial_post_aligned"
            });
            continue;
          }

          if (!processedFingerprints.has(fingerprint)) {
            repeatedFingerprintScans = 0;
            let prepared = observed;
            let preparedObservationId = observationId;
            let commentText = "";
            let commentSkipped = false;
            let lastReason = "post_processed";

            if (state.comment_enabled) {
              persist({ last_reason: "generating_comment" });
              try {
                const generated = await generateComment({
                  postText: String(
                    observed.post_snapshot?.identity_text
                    || observed.post_snapshot?.label
                    || observed.post_snapshot?.preview
                    || ""
                  ),
                  guidance: state.comment_guidance
                });
                commentText = String(generated?.comment || "").trim();
                if (!commentText) {
                  commentSkipped = true;
                  lastReason = "moments_comment_ai_empty";
                }
              } catch (error) {
                commentSkipped = true;
                lastReason = String(error?.code || "moments_comment_ai_failed");
                record("campaign.comment_generation_failed", {
                  reason: lastReason,
                  post_fingerprint: fingerprint
                }, "warn");
              }

              if (commentText) {
                const prepareArgs = ["moments-dry-run", "--mode", "random"];
                if (state.like_enabled) prepareArgs.push("--like");
                prepareArgs.push(
                  "--comment-enabled",
                  "--comment-text-base64",
                  Buffer.from(commentText, "utf8").toString("base64")
                );
                prepared = await runStep(prepareArgs, {
                  cliName: "moments_dry_run_cli.dev.cjs",
                  dataDir: baseDir,
                  owner: lockOwner,
                  phase: "moments:prepare-comment",
                  timeoutMs: 45_000
                });
                const preparedFingerprint = String(prepared?.post_snapshot?.post_fingerprint || "");
                preparedObservationId = String(prepared?.post_snapshot?.observation_id || "");
                if (!prepared?.ok || !preparedObservationId || preparedFingerprint !== fingerprint) {
                  commentSkipped = true;
                  commentText = "";
                  lastReason = preparedFingerprint && preparedFingerprint !== fingerprint
                    ? "moments_post_changed_before_comment"
                    : String(prepared?.blocked_reason || prepared?.reason || "moments_comment_prepare_failed");
                  record("campaign.comment_prepare_failed", {
                    reason: lastReason,
                    original_post_fingerprint: fingerprint,
                    prepared_post_fingerprint: preparedFingerprint
                  }, "warn");
                  preparedObservationId = "";
                  if (state.like_enabled) {
                    const likePrepared = await runStep(
                      ["moments-dry-run", "--mode", "random", "--like"],
                      {
                        cliName: "moments_dry_run_cli.dev.cjs",
                        dataDir: baseDir,
                        owner: lockOwner,
                        phase: "moments:recover-like-context",
                        timeoutMs: 45_000
                      }
                    );
                    if (
                      likePrepared?.ok
                      && String(likePrepared.post_snapshot?.post_fingerprint || "") === fingerprint
                    ) {
                      prepared = likePrepared;
                      preparedObservationId = String(likePrepared.post_snapshot?.observation_id || "");
                    }
                  }
                }
              }
            }

            let likedCount = 0;
            let alreadyLikedCount = 0;
            let itemSkipped = 0;
            if (state.like_enabled && preparedObservationId) {
              const liked = await runStep(
                ["moments-like", "--observation-id", preparedObservationId],
                {
                  cliName: "moments_action_cli.dev.cjs",
                  dataDir: baseDir,
                  owner: lockOwner,
                  phase: "moments:like",
                  timeoutMs: 125_000
                }
              );
              record("campaign.like_finished", {
                ok: liked?.ok === true,
                status: liked?.status || "",
                reason: liked?.blocked_reason || liked?.reason || "",
                no_op: liked?.no_op === true,
                real_action_attempted: liked?.real_action_attempted
              }, liked?.ok ? "info" : "warn");
              if (
                liked?.ok === false
                && liked?.blocked_reason === "moments_attempt_already_recorded"
                && liked?.previous_status === "verified"
              ) {
                alreadyLikedCount = 1;
                itemSkipped = 1;
                lastReason = "post_already_recorded";
              } else if (
                liked?.ok === false
                && liked?.blocked_reason === "moments_attempt_already_recorded"
                && (liked?.previous_status === "clicked"
                  || liked?.previous_status === "outcome_unknown"
                  || liked?.real_action_attempted !== false)
              ) {
                finish("paused", "moments_like_outcome_unknown");
                return;
              } else if (!liked?.ok || liked.status !== "verified") {
                if (liked?.real_action_attempted === false) {
                  itemSkipped = 1;
                  lastReason = String(liked?.blocked_reason || liked?.reason || "moments_like_skipped");
                } else {
                  finish("paused", liked?.blocked_reason || liked?.reason || "moments_like_failed");
                  return;
                }
              } else {
                likedCount = liked.no_op ? 0 : 1;
                alreadyLikedCount = liked.no_op ? 1 : 0;
                lastReason = liked.no_op ? "already_liked" : "liked_verified";
              }
            } else if (state.like_enabled) {
              itemSkipped = 1;
            }

            let commentedCount = 0;
            if (state.comment_enabled && commentText) {
              persist({ last_reason: "sending_comment" });
              const commented = await runStep(
                [
                  "moments-comment",
                  "--observation-id",
                  preparedObservationId,
                  "--comment-text-base64",
                  Buffer.from(commentText, "utf8").toString("base64")
                ],
                {
                  cliName: "moments_action_cli.dev.cjs",
                  dataDir: baseDir,
                  owner: lockOwner,
                  phase: "moments:comment",
                  timeoutMs: 180_000
                }
              );
              const commentPrimaryReason = String(
                commented?.primary_reason
                || commented?.blocked_reason
                || commented?.reason
                || ""
              );
              const commentDiagnostics = commented?.diagnostics
                && typeof commented.diagnostics === "object"
                && !Array.isArray(commented.diagnostics)
                ? commented.diagnostics
                : undefined;
              record("campaign.comment_finished", {
                ok: commented?.ok === true,
                status: commented?.status || "",
                reason: commentPrimaryReason,
                stage: String(commented?.stage || ""),
                send_clicked_at: String(commented?.send_clicked_at || ""),
                primary_reason: String(commented?.primary_reason || ""),
                cleanup_reason: String(commented?.cleanup_reason || ""),
                verification_mode: String(commented?.verification_mode || ""),
                real_action_attempted: commented?.real_action_attempted,
                diagnostics: commentDiagnostics,
                comment_length: commentText.length
              }, commented?.ok ? "info" : "warn");
              if (commented?.ok && commented.status === "verified") {
                commentedCount = 1;
                lastReason = "commented_verified";
              } else if (
                (commented?.blocked_reason === "moments_comment_text_already_attempted"
                  || commented?.blocked_reason === "moments_comment_post_already_attempted")
                && (commented?.previous_status === "clicked"
                  || commented?.previous_status === "outcome_unknown")
              ) {
                finish("paused", "moments_comment_outcome_unknown");
                return;
              } else if (commented?.real_action_attempted === false) {
                commentSkipped = true;
                lastReason = commentPrimaryReason || "moments_comment_skipped";
              } else {
                finish("paused", commentPrimaryReason || "moments_comment_outcome_unknown");
                return;
              }
            }

            processedFingerprints.add(fingerprint);
            const likeSucceededForPost = !state.like_enabled || likedCount + alreadyLikedCount > 0;
            const commentSucceededForPost = !state.comment_enabled || commentedCount > 0;
            const completedPostCount = likeSucceededForPost && commentSucceededForPost ? 1 : 0;
            persist({
              processed_count: state.processed_count + 1,
              completed_post_count: state.completed_post_count + completedPostCount,
              liked_count: state.liked_count + likedCount,
              already_liked_count: state.already_liked_count + alreadyLikedCount,
              commented_count: state.commented_count + commentedCount,
              comment_skipped_count: state.comment_skipped_count + (commentSkipped ? 1 : 0),
              skipped_count: state.skipped_count + itemSkipped + (!state.like_enabled && !commentedCount ? 1 : 0),
              last_reason: lastReason
            });
          } else {
            repeatedFingerprintScans += 1;
            persist({ last_reason: "post_already_processed_in_run" });
            if (repeatedFingerprintScans >= 3) {
              finish("partial", "target_not_reached");
              return;
            }
          }
        }

        if (successfulPostCount() >= state.max_posts || candidateChecks >= candidateLimit || shouldStop()) break;
        const scrolled = await scrollMoments();
        record("campaign.scroll_finished", { result: scrolled }, scrolled?.ok ? "info" : "warn");
        if (!scrolled?.ok) {
          finish("paused", scrolled?.reason || "moments_scroll_failed");
          return;
        }
        persist({ scroll_count: state.scroll_count + 1, last_reason: "scrolled" });
      }
      if (state.status === "running") {
        if (successfulPostCount() >= state.max_posts) {
          finish("completed", "target_count_reached");
        } else {
          finish("partial", "target_not_reached");
        }
      }
    } catch (error) {
      record("campaign.failed", { error }, "error");
      finish("paused", error?.code || "moments_campaign_failed");
    } finally {
      try {
        if (lockOwner) coordinator?.release?.(lockOwner);
      } catch {}
      loopPromise = null;
    }
  }

  function start(payload = {}) {
    if (loopPromise) {
      record("campaign.start_rejected", { reason: "moments_campaign_already_running" }, "warn");
      return { ok: false, reason: "moments_campaign_already_running", state };
    }
    const maxPosts = Math.max(1, Math.min(MAX_POSTS_PER_RUN, Number(payload.maxPosts) || DEFAULT_MAX_POSTS));
    const likeEnabled = payload.likeEnabled !== false;
    const commentEnabled = payload.commentEnabled === true;
    const commentGuidance = String(payload.commentGuidance || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!likeEnabled && !commentEnabled) {
      return { ok: false, reason: "moments_action_missing", state };
    }
    if (commentEnabled && typeof generateComment !== "function") {
      return { ok: false, reason: "moments_comment_ai_unavailable", state };
    }
    let lock;
    try {
      lock = coordinator?.acquire?.({
        state: "running_moments",
        taskId: `moments-${Date.now()}`,
        account: "unknown",
        phase: "moments:campaign"
      });
    } catch (error) {
      record("campaign.start_rejected", {
        reason: "runtime_coordinator_failed",
        error
      }, "error");
      return { ok: false, reason: "runtime_coordinator_failed", state };
    }
    if (!lock?.ok || !lock.lock?.owner) {
      const reason = lock?.error || "wechat_operation_busy";
      record("campaign.start_rejected", {
        reason,
        coordinator_state: lock?.state || ""
      }, "warn");
      return { ok: false, reason, state };
    }
    pauseRequested = false;
    stopRequested = false;
    persist({
      status: "running",
      max_posts: maxPosts,
      processed_count: 0,
      completed_post_count: 0,
      liked_count: 0,
      already_liked_count: 0,
      commented_count: 0,
      comment_skipped_count: 0,
      skipped_count: 0,
      scroll_count: 0,
      current_post: 1,
      like_enabled: likeEnabled,
      comment_enabled: commentEnabled,
      comment_guidance: commentGuidance,
      last_reason: "starting",
      started_at: new Date().toISOString()
    });
    record("campaign.started", {
      max_posts: maxPosts,
      like_enabled: likeEnabled,
      comment_enabled: commentEnabled,
      comment_guidance_length: commentGuidance.length
    });
    loopPromise = executeLoop(lock.lock.owner);
    return { ok: true, state };
  }

  function pause() {
    if (!loopPromise) return { ok: true, state };
    pauseRequested = true;
    persist({ last_reason: "pause_requested" });
    return { ok: true, state };
  }

  function stop() {
    if (!loopPromise) {
      finish("stopped", "stopped_by_user");
      return { ok: true, state };
    }
    stopRequested = true;
    persist({ last_reason: "stop_requested" });
    return { ok: true, state };
  }

  return {
    pause,
    start,
    status: () => ({ ok: true, state }),
    stop
  };
}

function registerMomentsCampaignIpc(options = {}) {
  const getMainWindow = typeof options.getMainWindow === "function" ? options.getMainWindow : () => null;
  const consumedTokens = new Set();
  const controller = createMomentsCampaignController({
    ...options,
    emit: (state) => {
      const window = getMainWindow();
      if (window && !window.isDestroyed()) window.webContents.send("moments-campaign:update", state);
    }
  });
  ipcMain.handle("moments-campaign:status", () => controller.status());
  ipcMain.handle("moments-campaign:start", (event, payload = {}) => {
    const window = getMainWindow();
    const token = String(payload.clickToken || "");
    if (
      !token
      || consumedTokens.has(token)
      || !window
      || window.isDestroyed()
      || event.sender !== window.webContents
      || !window.isFocused()
    ) return { ok: false, reason: "trusted_user_click_required", state: controller.status().state };
    consumedTokens.add(token);
    if (consumedTokens.size > 100) consumedTokens.delete(consumedTokens.values().next().value);
    return controller.start(payload);
  });
  ipcMain.handle("moments-campaign:pause", () => controller.pause());
  ipcMain.handle("moments-campaign:stop", () => controller.stop());
  return controller;
}

module.exports = {
  DEFAULT_MAX_POSTS,
  MAX_POSTS_PER_RUN,
  createMomentsCampaignController,
  publicState,
  registerMomentsCampaignIpc
};
