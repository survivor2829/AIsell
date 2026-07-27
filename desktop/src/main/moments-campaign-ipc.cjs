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
    liked_count: Number(value.liked_count || 0),
    already_liked_count: Number(value.already_liked_count || 0),
    skipped_count: Number(value.skipped_count || 0),
    scroll_count: Number(value.scroll_count || 0),
    current_post: Number(value.current_post || 0),
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
    logger.event("moments", event, { campaign: state, ...fields }, { level });
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
      let emptyScans = 0;
      while (state.processed_count < state.max_posts) {
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

          if (!processedFingerprints.has(fingerprint)) {
            const liked = await runStep(
              ["moments-like", "--observation-id", observationId],
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
            ) {
              processedFingerprints.add(fingerprint);
              persist({
                processed_count: state.processed_count + 1,
                skipped_count: state.skipped_count + 1,
                last_reason: "post_already_recorded"
              });
            } else {
            if (!liked?.ok || liked.status !== "verified") {
              finish("paused", liked?.blocked_reason || liked?.reason || "moments_like_failed");
              return;
            }
            processedFingerprints.add(fingerprint);
            persist({
              processed_count: state.processed_count + 1,
              liked_count: state.liked_count + (liked.no_op ? 0 : 1),
              already_liked_count: state.already_liked_count + (liked.no_op ? 1 : 0),
              last_reason: liked.no_op ? "already_liked" : "liked_verified"
            });
            }
          } else {
            persist({ skipped_count: state.skipped_count + 1, last_reason: "post_already_processed_in_run" });
          }
        }

        if (state.processed_count >= state.max_posts || shouldStop()) break;
        const scrolled = await scrollMoments();
        record("campaign.scroll_finished", { result: scrolled }, scrolled?.ok ? "info" : "warn");
        if (!scrolled?.ok) {
          finish("paused", scrolled?.reason || "moments_scroll_failed");
          return;
        }
        persist({ scroll_count: state.scroll_count + 1, last_reason: "scrolled" });
      }
      if (state.status === "running") finish("completed", "target_count_reached");
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
    if (loopPromise) return { ok: false, reason: "moments_campaign_already_running", state };
    const maxPosts = Math.max(1, Math.min(MAX_POSTS_PER_RUN, Number(payload.maxPosts) || DEFAULT_MAX_POSTS));
    let lock;
    try {
      lock = coordinator?.acquire?.({
        state: "running_moments",
        taskId: `moments-${Date.now()}`,
        account: "unknown",
        phase: "moments:campaign"
      });
    } catch {
      return { ok: false, reason: "runtime_coordinator_failed", state };
    }
    if (!lock?.ok || !lock.lock?.owner) {
      return { ok: false, reason: lock?.error || "wechat_operation_busy", state };
    }
    pauseRequested = false;
    stopRequested = false;
    persist({
      status: "running",
      max_posts: maxPosts,
      processed_count: 0,
      liked_count: 0,
      already_liked_count: 0,
      skipped_count: 0,
      scroll_count: 0,
      current_post: 1,
      last_reason: "starting",
      started_at: new Date().toISOString()
    });
    record("campaign.started", { max_posts: maxPosts });
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
