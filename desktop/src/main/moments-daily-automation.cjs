const DEFAULT_DAILY_TARGET = 20;
const DEFAULT_DAILY_START_TIME = "09:00";
const DAILY_BUSY_RETRY_MS = 60_000;
const DAILY_FAILURE_RETRY_MS = 30 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const STARTUP_RESUME_PENDING_REASON = "daily_startup_resume_pending";

function localDayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeDailyStartTime(value) {
  const text = String(value || "").trim();
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(text);
  return match ? `${match[1]}:${match[2]}` : DEFAULT_DAILY_START_TIME;
}

function sanitizeCommentGuidance(value) {
  return String(value || "").replace(/\s+/gu, " ").trim().slice(0, 200);
}

function clampTarget(value, fallback = DEFAULT_DAILY_TARGET, maxTarget = 50) {
  const parsed = Number(value);
  return Math.max(
    1,
    Math.min(maxTarget, Number.isFinite(parsed) ? Math.floor(parsed) : fallback)
  );
}

function startTimeOnDate(value, startTime, dayOffset = 0) {
  const date = new Date(value);
  const [hour, minute] = normalizeDailyStartTime(startTime).split(":").map(Number);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date;
}

function nextStartAfter(value, startTime) {
  const current = value instanceof Date ? value : new Date(value);
  const today = startTimeOnDate(current, startTime);
  return today.getTime() > current.getTime()
    ? today
    : startTimeOnDate(current, startTime, 1);
}

function publicDailyState(value = {}, now = new Date(), maxTarget = 50) {
  const today = localDayKey(now);
  const completedPosts = Array.isArray(value.completed_posts)
    ? [...new Set(value.completed_posts.map(String).filter(Boolean))].slice(-maxTarget)
    : [];
  return {
    enabled: value.enabled === true,
    target: clampTarget(value.target, DEFAULT_DAILY_TARGET, maxTarget),
    start_time: normalizeDailyStartTime(value.start_time),
    like_enabled: value.like_enabled !== false,
    comment_enabled: value.comment_enabled === true,
    comment_guidance: sanitizeCommentGuidance(value.comment_guidance),
    date: /^\d{4}-\d{2}-\d{2}$/u.test(String(value.date || ""))
      ? String(value.date)
      : today,
    completed_count: Math.max(0, Number(value.completed_count || 0)),
    checked_count: Math.max(0, Number(value.checked_count || 0)),
    skipped_count: Math.max(0, Number(value.skipped_count || 0)),
    completed_posts: completedPosts,
    suppressed_date: String(value.suppressed_date || ""),
    blocked_reason: String(value.blocked_reason || ""),
    last_reason: String(value.last_reason || ""),
    last_run_at: String(value.last_run_at || ""),
    next_run_at: String(value.next_run_at || ""),
    updated_at: String(value.updated_at || "")
  };
}

function freshDayState(value, now, maxTarget) {
  return publicDailyState({
    ...value,
    date: localDayKey(now),
    completed_count: 0,
    checked_count: 0,
    skipped_count: 0,
    completed_posts: [],
    suppressed_date: "",
    blocked_reason: "",
    last_reason: "daily_date_reset",
    next_run_at: ""
  }, now, maxTarget);
}

function createMomentsDailyAutomation(options = {}) {
  const maxTarget = Math.max(1, Number(options.maxTarget || 50));
  const getState = options.getState;
  const getCampaignState = options.getCampaignState;
  const getPublicState = typeof options.getPublicState === "function"
    ? options.getPublicState
    : null;
  const persist = options.persist;
  const persistIfChanged = options.persistIfChanged;
  const startCampaign = options.startCampaign;
  const isCampaignRunning = options.isCampaignRunning;
  const canGenerateComment = options.canGenerateComment;
  const record = typeof options.record === "function" ? options.record : () => undefined;
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const schedule = typeof options.schedule === "function" ? options.schedule : setTimeout;
  const cancelSchedule = typeof options.cancelSchedule === "function"
    ? options.cancelSchedule
    : clearTimeout;
  const busyRetryMs = Math.max(1_000, Number(options.busyRetryMs || DAILY_BUSY_RETRY_MS));
  const failureRetryMs = Math.max(60_000, Number(options.failureRetryMs || DAILY_FAILURE_RETRY_MS));
  let timer = null;

  function currentState() {
    return publicDailyState(getState(), now(), maxTarget);
  }

  function effectiveState() {
    const state = currentState();
    return state.date === localDayKey(now())
      ? state
      : freshDayState(state, now(), maxTarget);
  }

  function status() {
    const state = effectiveState();
    const campaign = getCampaignState();
    const today = localDayKey(now());
    if (!state.enabled) return "disabled";
    if (state.completed_count >= state.target) return "completed";
    if (state.blocked_reason === STARTUP_RESUME_PENDING_REASON) return "pending_resume";
    if (state.suppressed_date === today) return "paused";
    if (campaign.status === "running" && campaign.daily_tracking) return "running";
    return "waiting";
  }

  function snapshot() {
    const state = effectiveState();
    return {
      enabled: state.enabled,
      target: state.target,
      start_time: state.start_time,
      like_enabled: state.like_enabled,
      comment_enabled: state.comment_enabled,
      comment_guidance: state.comment_guidance,
      date: state.date,
      completed_count: state.completed_count,
      checked_count: state.checked_count,
      skipped_count: state.skipped_count,
      suppressed_date: state.suppressed_date,
      blocked_reason: state.blocked_reason,
      last_reason: state.last_reason,
      last_run_at: state.last_run_at,
      next_run_at: state.next_run_at,
      updated_at: state.updated_at,
      remaining_count: Math.max(0, state.target - state.completed_count),
      status: status()
    };
  }

  function responseState() {
    return getPublicState ? getPublicState() : snapshot();
  }

  function safeRecord(event, fields = {}, level = "info") {
    try {
      record(event, fields, level);
    } catch {}
  }

  function clearTimer() {
    if (timer === null) return;
    try {
      cancelSchedule(timer);
    } catch {}
    timer = null;
  }

  function scheduleEvaluation(targetDate, reason, patch = {}) {
    clearTimer();
    const state = currentState();
    if (!state.enabled) {
      persistIfChanged({
        ...patch,
        next_run_at: "",
        last_reason: reason || "daily_disabled"
      });
      return;
    }
    const target = targetDate instanceof Date ? targetDate : new Date(targetDate);
    persistIfChanged({
      ...patch,
      next_run_at: target.toISOString(),
      last_reason: String(reason || "daily_waiting")
    });
    const delay = Math.max(0, target.getTime() - now().getTime());
    safeRecord("daily.scheduled", {
      reason: String(reason || "daily_waiting"),
      next_run_at: target.toISOString(),
      delay_ms: delay
    });
    timer = schedule(() => {
      timer = null;
      evaluate({ allowRecovery: true });
    }, Math.min(delay, MAX_TIMER_DELAY_MS));
  }

  function armMemoryRecovery(error) {
    clearTimer();
    safeRecord("daily.evaluate_failed", {
      reason: String(error?.code || error?.message || "moments_daily_evaluate_failed"),
      retry_in_ms: busyRetryMs
    }, "error");
    try {
      timer = schedule(() => {
        timer = null;
        evaluate({ allowRecovery: false });
      }, busyRetryMs);
    } catch (scheduleError) {
      timer = null;
      safeRecord("daily.recovery_schedule_failed", {
        reason: String(
          scheduleError?.code
          || scheduleError?.message
          || "moments_daily_recovery_schedule_failed"
        )
      }, "error");
    }
  }

  function persistDateResetIfNeeded() {
    const state = currentState();
    const current = now();
    if (state.date === localDayKey(current)) return false;
    const fresh = freshDayState(state, current, maxTarget);
    persist(fresh);
    safeRecord("daily.date_reset", { date: fresh.date });
    return true;
  }

  function campaignPayload(maxPosts) {
    const state = currentState();
    return {
      maxPosts,
      likeEnabled: state.like_enabled,
      commentEnabled: state.comment_enabled,
      commentGuidance: state.comment_guidance
    };
  }

  function buildProgressPatch(fingerprint, newCompletedPostCount, dailyTracking) {
    if (!dailyTracking) return null;
    const current = now();
    const stored = currentState();
    const state = stored.date === localDayKey(current)
      ? stored
      : freshDayState(stored, current, maxTarget);
    const alreadyCountedToday = state.completed_posts.includes(fingerprint);
    const completed = newCompletedPostCount > 0 && !alreadyCountedToday ? 1 : 0;
    return {
      date: state.date,
      checked_count: state.checked_count + 1,
      completed_count: state.completed_count + completed,
      completed_posts: completed
        ? [...state.completed_posts, fingerprint].slice(-maxTarget)
        : state.completed_posts,
      skipped_count: state.skipped_count + (completed ? 0 : 1),
      suppressed_date: state.suppressed_date,
      blocked_reason: "",
      last_reason: completed ? "daily_post_completed" : "daily_post_skipped"
    };
  }

  function planAfterCampaign(statusValue, reason) {
    try {
      const campaign = getCampaignState();
      const state = currentState();
      if (!campaign.automated_run || !state.enabled) return;
      const current = now();
      const today = localDayKey(current);
      const unknownOutcome = campaign.outcome_unknown
        || reason === "moments_like_outcome_unknown"
        || reason === "moments_comment_outcome_unknown";
      const userPaused = reason === "paused_by_user" || reason === "stopped_by_user";

      if (state.completed_count >= state.target) {
        scheduleEvaluation(
          nextStartAfter(current, state.start_time),
          "daily_waiting_next_day",
          { blocked_reason: "" }
        );
        return;
      }
      if (unknownOutcome || userPaused || state.suppressed_date === today) {
        scheduleEvaluation(
          startTimeOnDate(current, state.start_time, 1),
          "daily_paused_until_tomorrow",
          {
            blocked_reason: String(reason || state.blocked_reason || "daily_paused"),
            suppressed_date: today
          }
        );
        return;
      }
      scheduleEvaluation(
        new Date(current.getTime() + failureRetryMs),
        "daily_retry_pending",
        { blocked_reason: String(reason || statusValue || "daily_retry_pending") }
      );
    } catch (error) {
      safeRecord("daily.plan_after_campaign_failed", {
        reason: String(error?.code || error?.message || "moments_daily_plan_failed")
      }, "error");
      armMemoryRecovery(error);
    }
  }

  function suppressToday(reason) {
    try {
      const state = currentState();
      if (!state.enabled) return;
      persistDateResetIfNeeded();
      const current = now();
      scheduleEvaluation(
        startTimeOnDate(current, currentState().start_time, 1),
        "daily_paused_until_tomorrow",
        {
          blocked_reason: String(reason || "paused_by_user"),
          suppressed_date: localDayKey(current)
        }
      );
      safeRecord("daily.suppressed", {
        reason: String(reason || "paused_by_user"),
        date: currentState().suppressed_date
      }, "warn");
    } catch (error) {
      safeRecord("daily.suppress_failed", {
        reason: String(error?.code || error?.message || "moments_daily_suppress_failed")
      }, "error");
      armMemoryRecovery(error);
    }
  }

  function evaluateUnsafe() {
    persistDateResetIfNeeded();
    clearTimer();
    const state = currentState();
    if (!state.enabled) {
      persistIfChanged({ next_run_at: "", last_reason: "daily_disabled" });
      return { ok: true, state: responseState() };
    }
    const current = now();
    const today = localDayKey(current);
    if (state.completed_count >= state.target || state.suppressed_date === today) {
      scheduleEvaluation(
        state.completed_count >= state.target
          ? nextStartAfter(current, state.start_time)
          : startTimeOnDate(current, state.start_time, 1),
        state.completed_count >= state.target
          ? "daily_waiting_next_day"
          : "daily_paused_until_tomorrow"
      );
      return { ok: true, state: responseState() };
    }
    const dueAt = startTimeOnDate(current, state.start_time);
    if (current.getTime() < dueAt.getTime()) {
      scheduleEvaluation(dueAt, "daily_waiting_for_start_time");
      return { ok: true, state: responseState() };
    }
    if (isCampaignRunning()) {
      scheduleEvaluation(
        new Date(current.getTime() + busyRetryMs),
        "daily_waiting_for_current_task"
      );
      return { ok: false, reason: "moments_campaign_already_running", state: responseState() };
    }

    const remaining = Math.max(1, state.target - state.completed_count);
    safeRecord("daily.run_due", {
      date: state.date,
      completed_count: state.completed_count,
      remaining_count: remaining,
      target: state.target
    });
    const result = startCampaign(campaignPayload(remaining), { automated: true });
    if (!result.ok) {
      const retryAt = new Date(current.getTime() + busyRetryMs);
      scheduleEvaluation(retryAt, "daily_start_retry", {
        blocked_reason: String(result.reason || "daily_start_failed")
      });
      safeRecord("daily.start_failed", {
        reason: String(result.reason || "daily_start_failed"),
        retry_at: retryAt.toISOString()
      }, "warn");
    }
    return result;
  }

  function evaluate(evaluateOptions = {}) {
    try {
      return evaluateUnsafe();
    } catch (error) {
      if (evaluateOptions.allowRecovery !== false) armMemoryRecovery(error);
      else safeRecord("daily.evaluate_failed", {
        reason: String(error?.code || error?.message || "moments_daily_evaluate_failed"),
        retry_in_ms: 0
      }, "error");
      return {
        ok: false,
        reason: "moments_daily_evaluate_failed",
        state: responseState()
      };
    }
  }

  function configure(payload = {}) {
    const rawTime = String(payload.startTime || "").trim();
    if (rawTime && !/^([01]\d|2[0-3]):([0-5]\d)$/u.test(rawTime)) {
      return { ok: false, reason: "moments_daily_start_time_invalid", state: responseState() };
    }
    const previous = currentState();
    const enabled = payload.enabled === true;
    const likeEnabled = payload.likeEnabled !== false;
    const commentEnabled = payload.commentEnabled === true;
    if (enabled && !likeEnabled && !commentEnabled) {
      return { ok: false, reason: "moments_action_missing", state: responseState() };
    }
    if (enabled && commentEnabled && !canGenerateComment()) {
      return { ok: false, reason: "moments_comment_ai_unavailable", state: responseState() };
    }
    persistDateResetIfNeeded();
    const state = currentState();
    const actionModeChanged = state.like_enabled !== likeEnabled
      || state.comment_enabled !== commentEnabled;
    const explicitlyEnabled = enabled && !previous.enabled;
    persist({
      enabled,
      target: clampTarget(payload.target, DEFAULT_DAILY_TARGET, maxTarget),
      start_time: normalizeDailyStartTime(rawTime || state.start_time),
      like_enabled: likeEnabled,
      comment_enabled: commentEnabled,
      comment_guidance: sanitizeCommentGuidance(payload.commentGuidance),
      completed_count: actionModeChanged ? 0 : state.completed_count,
      checked_count: actionModeChanged ? 0 : state.checked_count,
      skipped_count: actionModeChanged ? 0 : state.skipped_count,
      completed_posts: actionModeChanged ? [] : state.completed_posts,
      suppressed_date: explicitlyEnabled ? "" : state.suppressed_date,
      blocked_reason: explicitlyEnabled ? "" : state.blocked_reason,
      last_reason: enabled ? "daily_schedule_saved" : "daily_disabled",
      next_run_at: ""
    });
    safeRecord("daily.configure", {
      enabled,
      target: currentState().target,
      start_time: currentState().start_time,
      like_enabled: currentState().like_enabled,
      comment_enabled: currentState().comment_enabled
    });
    if (!enabled) {
      clearTimer();
      return { ok: true, state: responseState() };
    }
    return evaluate({ allowRecovery: true });
  }

  function runNow() {
    const initial = currentState();
    if (!initial.enabled) {
      return { ok: false, reason: "moments_daily_not_enabled", state: responseState() };
    }
    persistDateResetIfNeeded();
    const state = currentState();
    if (state.completed_count >= state.target) {
      return { ok: true, already_complete: true, state: responseState() };
    }
    persist({
      blocked_reason: "",
      last_reason: "daily_manual_run_requested",
      suppressed_date: ""
    });
    const ready = currentState();
    return startCampaign(
      campaignPayload(ready.target - ready.completed_count),
      { automated: true }
    );
  }

  function markRunStarted() {
    clearTimer();
    return {
      blocked_reason: "",
      last_reason: "daily_run_started",
      last_run_at: now().toISOString(),
      next_run_at: ""
    };
  }

  function initialize() {
    safeRecord("daily.initialize");
    try {
      persistDateResetIfNeeded();
      clearTimer();
      const state = currentState();
      if (!state.enabled) {
        persistIfChanged({ next_run_at: "", last_reason: "daily_disabled" });
        return { ok: true, state: responseState() };
      }

      const current = now();
      const today = localDayKey(current);
      if (state.completed_count >= state.target) {
        scheduleEvaluation(
          nextStartAfter(current, state.start_time),
          "daily_waiting_next_day",
          { blocked_reason: "" }
        );
        return { ok: true, state: responseState() };
      }
      if (state.suppressed_date === today) {
        const startupResumePending = state.blocked_reason === STARTUP_RESUME_PENDING_REASON;
        scheduleEvaluation(
          startTimeOnDate(current, state.start_time, 1),
          startupResumePending ? "daily_startup_deferred" : "daily_paused_until_tomorrow",
          startupResumePending
            ? {
                blocked_reason: STARTUP_RESUME_PENDING_REASON,
                suppressed_date: today
              }
            : {}
        );
        return {
          ok: true,
          deferred: startupResumePending,
          reason: startupResumePending ? STARTUP_RESUME_PENDING_REASON : undefined,
          state: responseState()
        };
      }

      const persistedNextRun = new Date(state.next_run_at);
      if (
        state.next_run_at
        && !Number.isNaN(persistedNextRun.getTime())
        && persistedNextRun.getTime() > current.getTime()
      ) {
        scheduleEvaluation(persistedNextRun, "daily_startup_timer_restored");
        safeRecord("daily.timer_restored", {
          next_run_at: persistedNextRun.toISOString()
        });
        return { ok: true, restored: true, state: responseState() };
      }

      const dueAt = startTimeOnDate(current, state.start_time);
      if (current.getTime() < dueAt.getTime()) {
        scheduleEvaluation(dueAt, "daily_waiting_for_start_time");
        return { ok: true, state: responseState() };
      }

      const nextRunAt = startTimeOnDate(current, state.start_time, 1);
      scheduleEvaluation(nextRunAt, "daily_startup_deferred", {
        blocked_reason: STARTUP_RESUME_PENDING_REASON,
        suppressed_date: today
      });
      safeRecord("daily.startup_deferred", {
        date: state.date,
        completed_count: state.completed_count,
        remaining_count: Math.max(0, state.target - state.completed_count),
        next_run_at: nextRunAt.toISOString()
      });
      return {
        ok: true,
        deferred: true,
        reason: STARTUP_RESUME_PENDING_REASON,
        state: responseState()
      };
    } catch (error) {
      clearTimer();
      safeRecord("daily.initialize_failed", {
        reason: String(error?.code || error?.message || "moments_daily_initialize_failed")
      }, "error");
      return {
        ok: false,
        reason: "moments_daily_initialize_failed",
        state: responseState()
      };
    }
  }
  return {
    buildProgressPatch,
    configure,
    dispose: clearTimer,
    initialize,
    markRunStarted,
    planAfterCampaign,
    runNow,
    snapshot,
    status,
    suppressToday
  };
}

module.exports = {
  DEFAULT_DAILY_START_TIME,
  DEFAULT_DAILY_TARGET,
  createMomentsDailyAutomation,
  localDayKey,
  normalizeDailyStartTime,
  publicDailyState,
  sanitizeCommentGuidance
};
