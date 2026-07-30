const fs = require("node:fs");
const path = require("node:path");
const { ipcMain } = require("electron");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { diagnostics } = require("./diagnostics.cjs");
const { runActiveTouchDev } = require("./active-touch-ipc.cjs");
const {
  createMomentsDailyAutomation,
  localDayKey,
  publicDailyState,
  sanitizeCommentGuidance
} = require("./moments-daily-automation.cjs");
const {
  openWechatMoments,
  scrollWechatMomentsFeed
} = require("../../rpa/active_touch/moments_navigation.dev.cjs");

const DEFAULT_MAX_POSTS = 10;
const MAX_POSTS_PER_RUN = 50;
const DAILY_BUSY_RETRY_MS = 60_000;
const DAILY_FAILURE_RETRY_MS = 30 * 60_000;

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
    new_completed_post_count: Number(value.new_completed_post_count || 0),
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
    automated_run: value.automated_run === true,
    daily_tracking: value.daily_tracking === true,
    outcome_unknown: value.outcome_unknown === true,
    last_reason: String(value.last_reason || ""),
    started_at: String(value.started_at || ""),
    updated_at: String(value.updated_at || "")
  };
}

function sanitizeMomentsPositionDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sanitized = {};
  if (["top_edge", "bottom_partial", "actionable", "uia"].includes(value.position_zone)) {
    sanitized.position_zone = value.position_zone;
  }
  if (typeof value.top_edge_unsafe === "boolean") {
    sanitized.top_edge_unsafe = value.top_edge_unsafe;
  }
  for (const key of ["candidate_count", "accepted_count", "rejected_top_count"]) {
    const count = value[key];
    if (Number.isSafeInteger(count) && count >= 0 && count <= 1_000) sanitized[key] = count;
  }
  for (const key of ["target_top_ratio", "target_center_y_ratio", "target_menu_y_ratio"]) {
    const ratio = value[key];
    if (Number.isFinite(ratio) && ratio >= 0 && ratio <= 1) sanitized[key] = ratio;
  }
  return sanitized;
}

function sanitizeMomentsMenuDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sanitized = {};
  if (["like", "comment", "inspect"].includes(value.requested_action)) {
    sanitized.requested_action = value.requested_action;
  }
  for (const key of ["first_reason", "second_reason"]) {
    const reason = String(value[key] || "");
    if (/^moments_[a-z0-9_:-]{1,91}$/u.test(reason)) sanitized[key] = reason;
  }
  for (const key of [
    "menu_read_retry_count",
    "first_segment_count",
    "second_segment_count",
    "first_strict_candidate_count",
    "second_strict_candidate_count",
    "first_fallback_candidate_count",
    "second_fallback_candidate_count"
  ]) {
    const count = value[key];
    if (Number.isSafeInteger(count) && count >= 0 && count <= 1_000) sanitized[key] = count;
  }
  for (const key of [
    "first_like_ocr_matched",
    "first_like_base_ocr_matched",
    "first_targeted_like_ocr_attempted",
    "first_targeted_like_ocr_matched",
    "first_comment_ocr_matched",
    "first_like_signature_ok",
    "first_comment_signature_ok",
    "first_like_signature_edge_clear",
    "first_comment_signature_edge_clear",
    "second_like_ocr_matched",
    "second_like_base_ocr_matched",
    "second_targeted_like_ocr_attempted",
    "second_targeted_like_ocr_matched",
    "second_comment_ocr_matched",
    "second_like_signature_ok",
    "second_comment_signature_ok",
    "second_like_signature_edge_clear",
    "second_comment_signature_edge_clear"
  ]) {
    if (typeof value[key] === "boolean") sanitized[key] = value[key];
  }
  for (const key of ["first_like_resolution_mode", "second_like_resolution_mode"]) {
    if (["ocr", "targeted_ocr", "visual_signature", "ambiguous"].includes(value[key])) {
      sanitized[key] = value[key];
    }
  }
  for (const key of [
    "first_width_ratio",
    "first_height_ratio",
    "second_width_ratio",
    "second_height_ratio"
  ]) {
    const ratio = value[key];
    if (Number.isFinite(ratio) && ratio >= 0 && ratio <= 10) sanitized[key] = ratio;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
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
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const writeStateJson = typeof options.writeStateJson === "function"
    ? options.writeStateJson
    : writeJsonAtomic;
  let pendingPauseReason = "";
  let stopRequested = false;
  let loopPromise = null;
  let dailyAutomation = null;
  const initialRoot = readJson(stateFile);
  let state = publicState(initialRoot.moments_campaign);
  let dailyState = publicDailyState(
    initialRoot.moments_daily_automation,
    now(),
    MAX_POSTS_PER_RUN
  );

  function snapshot() {
    return {
      status: state.status,
      max_posts: state.max_posts,
      processed_count: state.processed_count,
      completed_post_count: state.completed_post_count,
      liked_count: state.liked_count,
      already_liked_count: state.already_liked_count,
      commented_count: state.commented_count,
      comment_skipped_count: state.comment_skipped_count,
      skipped_count: state.skipped_count,
      scroll_count: state.scroll_count,
      current_post: state.current_post,
      like_enabled: state.like_enabled,
      comment_enabled: state.comment_enabled,
      comment_guidance: state.comment_guidance,
      outcome_unknown: state.outcome_unknown,
      last_reason: state.last_reason,
      started_at: state.started_at,
      updated_at: state.updated_at,
      daily_automation: dailyAutomation.snapshot()
    };
  }

  function writeState(campaignPatch = null, dailyPatch = null) {
    const updatedAt = now().toISOString();
    if (campaignPatch) {
      state = publicState({ ...state, ...campaignPatch, updated_at: updatedAt });
    }
    if (dailyPatch) {
      dailyState = publicDailyState({
        ...dailyState,
        ...dailyPatch,
        updated_at: updatedAt
      }, now(), MAX_POSTS_PER_RUN);
    }
    const root = readJson(stateFile);
    writeStateJson(stateFile, {
      ...root,
      moments_campaign: state,
      moments_daily_automation: dailyState
    });
    const next = snapshot();
    emit(next);
    return next;
  }

  function persist(patch = {}) {
    writeState(patch, null);
    return state;
  }

  function persistDaily(patch = {}) {
    writeState(null, patch);
    return dailyState;
  }

  function dailyValueEquals(current, next) {
    if (!Array.isArray(current) || !Array.isArray(next)) return current === next;
    return current.length === next.length && current.every((value, index) => value === next[index]);
  }

  function persistDailyIfChanged(patch = {}) {
    const changed = Object.entries(patch)
      .some(([key, value]) => !dailyValueEquals(dailyState[key], value));
    return changed ? persistDaily(patch) : dailyState;
  }

  function record(event, fields = {}, level = "info") {
    logger.event("moments", event, {
      campaign: {
        ...state,
        comment_guidance: undefined,
        comment_guidance_length: state.comment_guidance.length
      },
      daily_automation: {
        ...dailyState,
        comment_guidance: undefined,
        comment_guidance_length: dailyState.comment_guidance.length,
        completed_posts: undefined,
        completed_post_count: dailyState.completed_posts.length,
        status: dailyAutomation?.status() || "waiting"
      },
      ...fields
    }, { level });
  }

  dailyAutomation = createMomentsDailyAutomation({
    maxTarget: MAX_POSTS_PER_RUN,
    getState: () => dailyState,
    getCampaignState: () => state,
    getPublicState: snapshot,
    persist: persistDaily,
    persistIfChanged: persistDailyIfChanged,
    startCampaign: (payload, runOptions) => start(payload, runOptions),
    isCampaignRunning: () => Boolean(loopPromise),
    canGenerateComment: () => typeof generateComment === "function",
    record,
    now,
    schedule: options.schedule,
    cancelSchedule: options.cancelSchedule,
    busyRetryMs: options.busyRetryMs || DAILY_BUSY_RETRY_MS,
    failureRetryMs: options.failureRetryMs || DAILY_FAILURE_RETRY_MS
  });

  function finish(status, reason = "", finishOptions = {}) {
    const automatedRun = state.automated_run;
    persist({
      status,
      last_reason: reason,
      current_post: 0,
      outcome_unknown: finishOptions.outcomeUnknown === true
    });
    record(`campaign.${status}`, { reason }, status === "completed" ? "info" : "warn");
    if (automatedRun) dailyAutomation.planAfterCampaign(status, reason);
  }

  function shouldStop() {
    if (stopRequested) {
      finish("stopped", "stopped_by_user");
      return true;
    }
    if (pendingPauseReason) {
      finish("paused", pendingPauseReason);
      return true;
    }
    return false;
  }

  function successfulPostCount() {
    return state.automated_run
      ? state.new_completed_post_count
      : state.completed_post_count;
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
        const directPositionDiagnostics = sanitizeMomentsPositionDiagnostics(observed?.diagnostics);
        const positionDiagnostics = Object.keys(directPositionDiagnostics).length > 0
          ? directPositionDiagnostics
          : sanitizeMomentsPositionDiagnostics(observed?.plan?.position_diagnostics);
        record("campaign.observation_finished", {
          ok: observed?.ok === true,
          reason: observed?.blocked_reason || observed?.reason || "",
          visible_post_count: observed?.plan?.visible_post_count || 0,
          ...positionDiagnostics
        }, observed?.ok ? "info" : "warn");

        if (!observed?.ok) {
          const reason = String(observed?.blocked_reason || observed?.reason || "moments_observation_failed");
          if (reason === "moments_post_position_unsafe") {
            emptyScans = 0;
            persist({ last_reason: reason });
          } else if (reason === "moments_post_not_found" && emptyScans < 2) {
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
              const likeDiagnostics = sanitizeMomentsMenuDiagnostics(liked?.diagnostics);
              const likePrimaryReason = String(
                liked?.primary_reason
                || liked?.blocked_reason
                || liked?.reason
                || ""
              );
              record("campaign.like_finished", {
                ok: liked?.ok === true,
                status: liked?.status || "",
                reason: likePrimaryReason,
                primary_reason: String(liked?.primary_reason || ""),
                cleanup_reason: String(liked?.cleanup_reason || ""),
                no_op: liked?.no_op === true,
                real_action_attempted: liked?.real_action_attempted,
                ...(likeDiagnostics ? { diagnostics: likeDiagnostics } : {})
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
                finish("paused", "moments_like_outcome_unknown", { outcomeUnknown: true });
                return;
              } else if (!liked?.ok || liked.status !== "verified") {
                if (liked?.real_action_attempted === false) {
                  itemSkipped = 1;
                  lastReason = String(liked?.blocked_reason || liked?.reason || "moments_like_skipped");
                } else {
                  finish(
                    "paused",
                    liked?.blocked_reason || liked?.reason || "moments_like_failed",
                    { outcomeUnknown: true }
                  );
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
                finish("paused", "moments_comment_outcome_unknown", { outcomeUnknown: true });
                return;
              } else if (commented?.real_action_attempted === false) {
                commentSkipped = true;
                lastReason = commentPrimaryReason || "moments_comment_skipped";
              } else {
                finish(
                  "paused",
                  commentPrimaryReason || "moments_comment_outcome_unknown",
                  { outcomeUnknown: true }
                );
                return;
              }
            }

            processedFingerprints.add(fingerprint);
            const likeSucceededForPost = !state.like_enabled || likedCount + alreadyLikedCount > 0;
            const commentSucceededForPost = !state.comment_enabled || commentedCount > 0;
            const completedPostCount = likeSucceededForPost && commentSucceededForPost ? 1 : 0;
            const newCompletedPostCount = completedPostCount > 0 && likedCount + commentedCount > 0 ? 1 : 0;
            const dailyPatch = dailyAutomation.buildProgressPatch(
              fingerprint,
              newCompletedPostCount,
              state.daily_tracking
            );
            writeState({
              processed_count: state.processed_count + 1,
              completed_post_count: state.completed_post_count + completedPostCount,
              new_completed_post_count: state.new_completed_post_count + newCompletedPostCount,
              liked_count: state.liked_count + likedCount,
              already_liked_count: state.already_liked_count + alreadyLikedCount,
              commented_count: state.commented_count + commentedCount,
              comment_skipped_count: state.comment_skipped_count + (commentSkipped ? 1 : 0),
              skipped_count: state.skipped_count + itemSkipped + (!state.like_enabled && !commentedCount ? 1 : 0),
              last_reason: lastReason
            }, dailyPatch);
            if (dailyPatch) {
              record("daily.progress", {
                post_fingerprint: fingerprint,
                completed: newCompletedPostCount > 0,
                completed_count: dailyState.completed_count,
                checked_count: dailyState.checked_count,
                target: dailyState.target
              });
            }
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

  function start(payload = {}, runOptions = {}) {
    if (loopPromise) {
      record("campaign.start_rejected", { reason: "moments_campaign_already_running" }, "warn");
      return { ok: false, reason: "moments_campaign_already_running", state: snapshot() };
    }
    const maxPosts = Math.max(1, Math.min(MAX_POSTS_PER_RUN, Number(payload.maxPosts) || DEFAULT_MAX_POSTS));
    const likeEnabled = payload.likeEnabled !== false;
    const commentEnabled = payload.commentEnabled === true;
    const commentGuidance = sanitizeCommentGuidance(payload.commentGuidance);
    const automatedRun = runOptions.automated === true;
    const today = localDayKey(now());
    const dailyTracking = automatedRun
      && dailyState.enabled
      && dailyState.date === today
      && dailyState.suppressed_date !== today
      && dailyState.completed_count < dailyState.target;
    if (!likeEnabled && !commentEnabled) {
      return { ok: false, reason: "moments_action_missing", state: snapshot() };
    }
    if (commentEnabled && typeof generateComment !== "function") {
      return { ok: false, reason: "moments_comment_ai_unavailable", state: snapshot() };
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
      return { ok: false, reason: "runtime_coordinator_failed", state: snapshot() };
    }
    if (!lock?.ok || !lock.lock?.owner) {
      const reason = lock?.error || "wechat_operation_busy";
      record("campaign.start_rejected", {
        reason,
        coordinator_state: lock?.state || ""
      }, "warn");
      return { ok: false, reason, state: snapshot() };
    }
    pendingPauseReason = "";
    stopRequested = false;
    writeState({
      status: "running",
      max_posts: maxPosts,
      processed_count: 0,
      completed_post_count: 0,
      new_completed_post_count: 0,
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
      automated_run: automatedRun,
      daily_tracking: dailyTracking,
      outcome_unknown: false,
      last_reason: "starting",
      started_at: now().toISOString()
    }, automatedRun ? dailyAutomation.markRunStarted() : null);
    record("campaign.started", {
      max_posts: maxPosts,
      like_enabled: likeEnabled,
      comment_enabled: commentEnabled,
      automated_run: automatedRun,
      daily_tracking: dailyTracking,
      comment_guidance_length: commentGuidance.length
    });
    loopPromise = executeLoop(lock.lock.owner);
    return { ok: true, state: snapshot() };
  }

  function requestPause(reason, suppressDaily) {
    if (suppressDaily) dailyAutomation.suppressToday(reason);
    if (!loopPromise) return { ok: true, state: snapshot() };
    pendingPauseReason = String(reason || "paused_by_user");
    persist({ last_reason: "pause_requested" });
    return { ok: true, state: snapshot() };
  }

  function pause() {
    return requestPause("paused_by_user", true);
  }

  function pauseForAppClose() {
    return requestPause("app_closed", false);
  }

  function stop() {
    dailyAutomation.suppressToday("stopped_by_user");
    if (!loopPromise) {
      finish("stopped", "stopped_by_user");
      return { ok: true, state: snapshot() };
    }
    stopRequested = true;
    persist({ last_reason: "stop_requested" });
    return { ok: true, state: snapshot() };
  }

  function initialize() {
    if (state.status === "running" && !loopPromise) {
      persist({
        status: "partial",
        current_post: 0,
        last_reason: "app_restarted_pending_resume"
      });
    }
    return dailyAutomation.initialize();
  }

  return {
    configureDaily: dailyAutomation.configure,
    dispose: dailyAutomation.dispose,
    initialize,
    pause,
    pauseForAppClose,
    runDailyNow: dailyAutomation.runNow,
    start,
    status: () => ({ ok: true, state: snapshot() }),
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

  function trustedClick(event, token) {
    const window = getMainWindow();
    const value = String(token || "");
    if (
      !value
      || consumedTokens.has(value)
      || !window
      || window.isDestroyed()
      || event.sender !== window.webContents
      || !window.isFocused()
    ) return false;
    consumedTokens.add(value);
    if (consumedTokens.size > 100) consumedTokens.delete(consumedTokens.values().next().value);
    return true;
  }

  ipcMain.handle("moments-campaign:status", () => controller.status());
  ipcMain.handle("moments-campaign:start", (event, payload = {}) => {
    if (!trustedClick(event, payload.clickToken)) {
      return { ok: false, reason: "trusted_user_click_required", state: controller.status().state };
    }
    return controller.start(payload);
  });
  ipcMain.handle("moments-campaign:configure-daily", (_event, payload = {}) => {
    return controller.configureDaily(payload);
  });
  ipcMain.handle("moments-campaign:run-daily-now", (event, payload = {}) => {
    if (!trustedClick(event, payload.clickToken)) {
      return { ok: false, reason: "trusted_user_click_required", state: controller.status().state };
    }
    return controller.runDailyNow();
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
