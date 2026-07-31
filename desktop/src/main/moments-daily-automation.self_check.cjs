const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createMomentsCampaignController } = require("./moments-campaign-ipc.cjs");
const { localDayKey } = require("./moments-daily-automation.cjs");
const tempDirs = new Set();

function createTempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(directory);
  return directory;
}

function cleanupTempDirs() {
  for (const directory of tempDirs) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  tempDirs.clear();
}

async function waitFor(read, predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("moments daily automation self-check timed out");
}

function createFakeClock(initialIso) {
  let now = new Date(initialIso);
  let nextId = 1;
  const timers = new Map();

  function schedule(callback, delayMs) {
    const id = nextId++;
    timers.set(id, {
      callback,
      dueAt: now.getTime() + Math.max(0, Number(delayMs) || 0)
    });
    return id;
  }

  function cancel(id) {
    timers.delete(id);
  }

  async function advanceTo(iso) {
    now = new Date(iso);
    let due;
    do {
      due = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= now.getTime())
        .sort((left, right) => left[1].dueAt - right[1].dueAt);
      if (due.length) {
        const [id, timer] = due[0];
        timers.delete(id);
        timer.callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
    } while (due.length);
  }

  return {
    advanceTo,
    cancel,
    now: () => new Date(now),
    pending: () => [...timers.values()],
    schedule
  };
}

function createSuccessfulDriver(fingerprints, noOpIndexes = []) {
  let observationIndex = 0;
  let actionIndex = 0;
  return {
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        const fingerprint = fingerprints[Math.min(observationIndex, fingerprints.length - 1)];
        observationIndex += 1;
        return {
          ok: true,
          plan: { visible_post_count: 1 },
          post_snapshot: {
            observation_id: fingerprint,
            post_fingerprint: fingerprint
          }
        };
      }
      const currentAction = actionIndex++;
      return {
        ok: true,
        no_op: noOpIndexes.includes(currentAction),
        real_action_attempted: !noOpIndexes.includes(currentAction),
        status: "verified"
      };
    }
  };
}

function writeDailyState(root, dailyState, campaignState = {}) {
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({
    moments_campaign: {
      status: "idle",
      ...campaignState
    },
    moments_daily_automation: dailyState
  }), "utf8");
}

async function runChecks() {
  const root = createTempDir("moments-daily-automation-");
  const clock = createFakeClock("2026-07-29T08:00:00+08:00");
  const fingerprints = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
  const driver = createSuccessfulDriver(fingerprints, [0]);
  let acquireCount = 0;

  const controller = createMomentsCampaignController({
    baseDir: root,
    cancelSchedule: clock.cancel,
    coordinator: {
      acquire: () => {
        acquireCount += 1;
        return { ok: true, lock: { owner: `daily-owner-${acquireCount}` } };
      },
      release: () => undefined
    },
    logger: { event: () => undefined },
    now: clock.now,
    openMoments: async () => ({ ok: true }),
    runStep: driver.runStep,
    schedule: clock.schedule,
    scrollMoments: async () => ({ ok: true })
  });

  const configured = controller.configureDaily({
    commentEnabled: false,
    enabled: true,
    likeEnabled: true,
    startTime: "09:00",
    target: 2
  });
  assert.equal(configured.ok, true);
  assert.equal(configured.state.daily_automation.enabled, true);
  assert.equal(configured.state.daily_automation.target, 2);
  assert.equal(configured.state.daily_automation.completed_count, 0);

  controller.initialize();
  assert.equal(acquireCount, 0, "daily campaign must not start before configured time");
  assert.equal(clock.pending().length, 1, "one timer should wait for the configured time");

  await clock.advanceTo("2026-07-29T09:00:01+08:00");
  const completed = await waitFor(
    () => controller.status().state,
    (state) => state.daily_automation.completed_count === 2
      && state.daily_automation.status === "completed"
  );
  assert.equal(completed.processed_count, 3);
  assert.equal(completed.already_liked_count, 1);
  assert.equal(completed.daily_automation.completed_count, 2);
  assert.equal(
    completed.daily_automation.checked_count,
    3,
    "a historical like may be checked but must not consume today's target"
  );

  const persisted = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
  assert.equal(persisted.moments_daily_automation.completed_count, 2);
  assert.equal(persisted.moments_daily_automation.completed_posts.length, 2);

  const sameDayController = createMomentsCampaignController({
    baseDir: root,
    cancelSchedule: clock.cancel,
    coordinator: {
      acquire: () => {
        acquireCount += 1;
        return { ok: true, lock: { owner: "unexpected-same-day-owner" } };
      },
      release: () => undefined
    },
    logger: { event: () => undefined },
    now: clock.now,
    openMoments: async () => ({ ok: true }),
    runStep: async () => {
      throw new Error("completed daily target must not restart on the same day");
    },
    schedule: clock.schedule,
    scrollMoments: async () => ({ ok: true })
  });
  sameDayController.initialize();
  assert.equal(acquireCount, 1, "same-day restart must retain completed quota");
  controller.dispose();
  sameDayController.dispose();

  const nextDayClock = createFakeClock("2026-07-30T09:00:01+08:00");
  const nextDayDriver = createSuccessfulDriver(["g".repeat(64), "h".repeat(64)]);
  let nextDayAcquireCount = 0;
  const nextDayController = createMomentsCampaignController({
    baseDir: root,
    cancelSchedule: nextDayClock.cancel,
    coordinator: {
      acquire: () => {
        nextDayAcquireCount += 1;
        return { ok: true, lock: { owner: "next-day-owner" } };
      },
      release: () => undefined
    },
    logger: { event: () => undefined },
    now: nextDayClock.now,
    openMoments: async () => ({ ok: true }),
    runStep: nextDayDriver.runStep,
    schedule: nextDayClock.schedule,
    scrollMoments: async () => ({ ok: true })
  });
  const nextDayInitialized = nextDayController.initialize();
  assert.equal(nextDayInitialized.ok, true);
  assert.equal(nextDayInitialized.deferred, true);
  const nextDayPending = nextDayController.status().state;
  assert.equal(nextDayAcquireCount, 0, "a late app start must not open Moments");
  assert.equal(nextDayPending.daily_automation.date, "2026-07-30");
  assert.equal(nextDayPending.daily_automation.status, "pending_resume");
  assert.equal(nextDayPending.daily_automation.completed_count, 0);
  assert.equal(nextDayController.runDailyNow().ok, true);
  const nextDayCompleted = await waitFor(
    () => nextDayController.status().state,
    (state) => state.daily_automation.date === "2026-07-30"
      && state.daily_automation.completed_count === 2
  );
  assert.equal(nextDayAcquireCount, 1);
  assert.equal(nextDayCompleted.daily_automation.checked_count, 2);
  nextDayController.dispose();
  const missedRoot = createTempDir("moments-daily-missed-");
  const missedClock = createFakeClock("2026-07-29T08:00:00+08:00");
  const missedSetup = createMomentsCampaignController({
    baseDir: missedRoot,
    cancelSchedule: missedClock.cancel,
    coordinator: { acquire: () => ({ ok: false, error: "should_not_start_early" }) },
    logger: { event: () => undefined },
    now: missedClock.now,
    schedule: missedClock.schedule
  });
  assert.equal(missedSetup.configureDaily({
    enabled: true,
    target: 1,
    startTime: "09:00",
    likeEnabled: true,
    commentEnabled: false
  }).ok, true);
  missedSetup.dispose();

  await missedClock.advanceTo("2026-07-29T10:00:00+08:00");
  let missedAcquireCount = 0;
  let missedOpenCount = 0;
  const missedDriver = createSuccessfulDriver(["d".repeat(64)]);
  const missedController = createMomentsCampaignController({
    baseDir: missedRoot,
    cancelSchedule: missedClock.cancel,
    coordinator: {
      acquire: () => {
        missedAcquireCount += 1;
        return { ok: true, lock: { owner: "missed-owner" } };
      },
      release: () => undefined
    },
    logger: { event: () => undefined },
    now: missedClock.now,
    openMoments: async () => {
      missedOpenCount += 1;
      return { ok: true };
    },
    runStep: missedDriver.runStep,
    schedule: missedClock.schedule,
    scrollMoments: async () => ({ ok: true })
  });
  const missedInitialized = missedController.initialize();
  assert.equal(missedInitialized.ok, true);
  assert.equal(missedInitialized.deferred, true);
  const missedPending = missedController.status().state;
  assert.equal(missedAcquireCount, 0, "startup hydration must not acquire the WeChat runtime");
  assert.equal(missedOpenCount, 0, "startup hydration must not open Moments");
  assert.equal(missedPending.daily_automation.status, "pending_resume");
  assert.equal(missedPending.daily_automation.suppressed_date, "2026-07-29");
  assert.equal(missedPending.daily_automation.blocked_reason, "daily_startup_resume_pending");
  assert.equal(localDayKey(new Date(missedPending.daily_automation.next_run_at)), "2026-07-30");
  assert.equal(missedController.runDailyNow().ok, true);
  const missedCompleted = await waitFor(
    () => missedController.status().state,
    (state) => state.daily_automation.completed_count === 1
  );
  assert.equal(missedAcquireCount, 1, "manual resume should start exactly one campaign");
  assert.equal(missedOpenCount, 1);
  assert.equal(missedCompleted.daily_automation.status, "completed");
  const busyRoot = createTempDir("moments-daily-busy-");
  const busyClock = createFakeClock("2026-07-29T10:00:00+08:00");
  const busyDriver = createSuccessfulDriver(["e".repeat(64)]);
  let busy = true;
  let busyAcquireCount = 0;
  const busyController = createMomentsCampaignController({
    baseDir: busyRoot,
    busyRetryMs: 60_000,
    cancelSchedule: busyClock.cancel,
    coordinator: {
      acquire: () => {
        busyAcquireCount += 1;
        return busy
          ? { ok: false, error: "wechat_operation_busy", state: "replying" }
          : { ok: true, lock: { owner: "busy-retry-owner" } };
      },
      release: () => undefined
    },
    logger: { event: () => undefined },
    now: busyClock.now,
    openMoments: async () => ({ ok: true }),
    runStep: busyDriver.runStep,
    schedule: busyClock.schedule,
    scrollMoments: async () => ({ ok: true })
  });
  const busyConfigured = busyController.configureDaily({
    enabled: true,
    target: 1,
    startTime: "09:00",
    likeEnabled: true,
    commentEnabled: false
  });
  assert.equal(busyConfigured.ok, false);
  assert.equal(busyConfigured.reason, "wechat_operation_busy");
  assert.equal(busyController.status().state.daily_automation.blocked_reason, "wechat_operation_busy");
  assert.equal(busyController.status().state.status, "idle");
  busy = false;
  await busyClock.advanceTo("2026-07-29T10:01:01+08:00");
  const busyCompleted = await waitFor(
    () => busyController.status().state,
    (state) => state.daily_automation.completed_count === 1
  );
  assert.equal(busyAcquireCount, 2);
  assert.equal(busyCompleted.daily_automation.status, "completed");

  const unknownRoot = createTempDir("moments-daily-unknown-");
  const unknownClock = createFakeClock("2026-07-29T10:00:00+08:00");
  let unknownAcquireCount = 0;
  const unknownController = createMomentsCampaignController({
    baseDir: unknownRoot,
    cancelSchedule: unknownClock.cancel,
    coordinator: {
      acquire: () => {
        unknownAcquireCount += 1;
        return { ok: true, lock: { owner: "unknown-owner" } };
      },
      release: () => undefined
    },
    logger: { event: () => undefined },
    now: unknownClock.now,
    openMoments: async () => ({ ok: true }),
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        return {
          ok: true,
          plan: { visible_post_count: 1 },
          post_snapshot: {
            observation_id: "f".repeat(64),
            post_fingerprint: "f".repeat(64)
          }
        };
      }
      return {
        ok: false,
        blocked_reason: "moments_like_post_send_unverified",
        real_action_attempted: true,
        status: "outcome_unknown"
      };
    },
    schedule: unknownClock.schedule,
    scrollMoments: async () => ({ ok: true })
  });
  unknownController.configureDaily({
    enabled: true,
    target: 1,
    startTime: "09:00",
    likeEnabled: true,
    commentEnabled: false
  });
  const unknownPaused = await waitFor(
    () => unknownController.status().state,
    (state) => state.status === "paused"
  );
  assert.equal(unknownPaused.outcome_unknown, true);
  assert.equal(unknownPaused.daily_automation.suppressed_date, "2026-07-29");
  assert.equal(unknownPaused.daily_automation.status, "paused");
  const unknownSaved = unknownController.configureDaily({
    enabled: true,
    target: 1,
    startTime: "09:00",
    likeEnabled: true,
    commentEnabled: false
  });
  assert.equal(unknownSaved.ok, true);
  assert.equal(
    unknownSaved.state.daily_automation.suppressed_date,
    "2026-07-29",
    "saving an already-enabled plan must not clear an unknown-outcome suppression"
  );
  await unknownClock.advanceTo("2026-07-29T18:00:00+08:00");
  assert.equal(unknownAcquireCount, 1, "unknown outcome must not be retried on the same day");

  const pauseRoot = createTempDir("moments-daily-pause-");
  const pauseClock = createFakeClock("2026-07-29T10:00:00+08:00");
  let releaseObservation;
  const observationGate = new Promise((resolve) => {
    releaseObservation = resolve;
  });
  let pauseAcquireCount = 0;
  const pauseController = createMomentsCampaignController({
    baseDir: pauseRoot,
    cancelSchedule: pauseClock.cancel,
    coordinator: {
      acquire: () => {
        pauseAcquireCount += 1;
        return { ok: true, lock: { owner: "pause-owner" } };
      },
      release: () => undefined
    },
    logger: { event: () => undefined },
    now: pauseClock.now,
    openMoments: async () => ({ ok: true }),
    runStep: async () => {
      await observationGate;
      return {
        ok: false,
        blocked_reason: "paused_test_observation",
        real_action_attempted: false
      };
    },
    schedule: pauseClock.schedule,
    scrollMoments: async () => ({ ok: true })
  });
  pauseController.configureDaily({
    enabled: true,
    target: 1,
    startTime: "09:00",
    likeEnabled: true,
    commentEnabled: false
  });
  pauseController.initialize();
  await waitFor(
    () => pauseController.status().state,
    (state) => state.status === "running"
  );
  pauseController.pause();
  releaseObservation();
  const paused = await waitFor(
    () => pauseController.status().state,
    (state) => state.status === "paused"
  );
  assert.equal(paused.daily_automation.suppressed_date, "2026-07-29");
  assert.equal(paused.daily_automation.status, "paused");
  const pauseSaved = pauseController.configureDaily({
    enabled: true,
    target: 1,
    startTime: "09:00",
    likeEnabled: true,
    commentEnabled: false
  });
  assert.equal(pauseSaved.ok, true);
  assert.equal(
    pauseSaved.state.daily_automation.suppressed_date,
    "2026-07-29",
    "saving after a user pause must preserve today's suppression"
  );
  await pauseClock.advanceTo("2026-07-29T18:00:00+08:00");
  assert.equal(pauseAcquireCount, 1, "saving a paused plan must not restart it that day");

  const manualRoot = createTempDir("moments-daily-manual-");
  const manualClock = createFakeClock("2026-07-29T10:00:00+08:00");
  const manualDriver = createSuccessfulDriver(["m".repeat(64)]);
  const manualController = createMomentsCampaignController({
    baseDir: manualRoot,
    cancelSchedule: manualClock.cancel,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "manual-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    now: manualClock.now,
    openMoments: async () => ({ ok: true }),
    runStep: manualDriver.runStep,
    schedule: manualClock.schedule,
    scrollMoments: async () => ({ ok: true })
  });
  assert.equal(manualController.configureDaily({
    enabled: true,
    target: 2,
    startTime: "23:00",
    likeEnabled: true,
    commentEnabled: false
  }).ok, true);
  assert.equal(manualController.start({
    maxPosts: 1,
    likeEnabled: true,
    commentEnabled: false
  }).ok, true);
  const manualCompleted = await waitFor(
    () => manualController.status().state,
    (state) => state.status === "completed"
  );
  assert.equal(manualCompleted.daily_automation.completed_count, 0);
  assert.equal(
    manualCompleted.daily_automation.checked_count,
    0,
    "a manual campaign must not consume or inspect the enabled daily quota"
  );
  manualController.dispose();

  const midnightRoot = createTempDir("moments-daily-midnight-status-");
  const midnightClock = createFakeClock("2026-07-29T23:58:00+08:00");
  writeDailyState(midnightRoot, {
    enabled: true,
    target: 1,
    start_time: "09:00",
    like_enabled: true,
    comment_enabled: false,
    date: "2026-07-29",
    completed_count: 1,
    checked_count: 1,
    skipped_count: 0,
    completed_posts: ["n".repeat(64)]
  });
  const midnightDriver = createSuccessfulDriver(["o".repeat(64)]);
  let midnightAcquireCount = 0;
  const midnightController = createMomentsCampaignController({
    baseDir: midnightRoot,
    cancelSchedule: midnightClock.cancel,
    coordinator: {
      acquire: () => {
        midnightAcquireCount += 1;
        return { ok: true, lock: { owner: "midnight-owner" } };
      },
      release: () => undefined
    },
    logger: { event: () => undefined },
    now: midnightClock.now,
    openMoments: async () => ({ ok: true }),
    runStep: midnightDriver.runStep,
    schedule: midnightClock.schedule,
    scrollMoments: async () => ({ ok: true })
  });
  await midnightClock.advanceTo("2026-07-30T00:05:00+08:00");
  const freshMidnightStatus = midnightController.status().state.daily_automation;
  assert.equal(freshMidnightStatus.date, "2026-07-30");
  assert.equal(freshMidnightStatus.completed_count, 0);
  assert.equal(freshMidnightStatus.remaining_count, 1);
  assert.equal(midnightController.runDailyNow().ok, true);
  const midnightCompleted = await waitFor(
    () => midnightController.status().state,
    (state) => state.daily_automation.date === "2026-07-30"
      && state.daily_automation.completed_count === 1
  );
  assert.equal(midnightAcquireCount, 1);
  assert.equal(midnightCompleted.daily_automation.status, "completed");
  midnightController.dispose();

  const crossMidnightRoot = createTempDir("moments-daily-cross-midnight-");
  const crossMidnightClock = createFakeClock("2026-07-29T23:58:00+08:00");
  const crossMidnightFingerprint = "p".repeat(64);
  const crossMidnightController = createMomentsCampaignController({
    baseDir: crossMidnightRoot,
    cancelSchedule: crossMidnightClock.cancel,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "cross-midnight-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    now: crossMidnightClock.now,
    openMoments: async () => ({ ok: true }),
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        return {
          ok: true,
          plan: { visible_post_count: 1 },
          post_snapshot: {
            observation_id: crossMidnightFingerprint,
            post_fingerprint: crossMidnightFingerprint
          }
        };
      }
      await crossMidnightClock.advanceTo("2026-07-30T00:00:05+08:00");
      return {
        ok: true,
        no_op: false,
        real_action_attempted: true,
        status: "verified"
      };
    },
    schedule: crossMidnightClock.schedule,
    scrollMoments: async () => ({ ok: true })
  });
  assert.equal(crossMidnightController.configureDaily({
    enabled: true,
    target: 1,
    startTime: "23:59",
    likeEnabled: true,
    commentEnabled: false
  }).ok, true);
  await crossMidnightClock.advanceTo("2026-07-29T23:59:01+08:00");
  const crossMidnightCompleted = await waitFor(
    () => crossMidnightController.status().state,
    (state) => state.daily_automation.completed_count === 1
  );
  assert.equal(
    crossMidnightCompleted.daily_automation.date,
    "2026-07-30",
    "progress verified after midnight must be counted on the new local day"
  );
  assert.equal(
    localDayKey(new Date(crossMidnightCompleted.daily_automation.next_run_at)),
    "2026-07-30",
    "a run crossing midnight must schedule the new day's configured time, not skip that day"
  );
  crossMidnightController.dispose();

  const appCloseRoot = createTempDir("moments-daily-app-close-");
  const appCloseClock = createFakeClock("2026-07-29T10:00:00+08:00");
  let releaseAppCloseObservation;
  const appCloseGate = new Promise((resolve) => {
    releaseAppCloseObservation = resolve;
  });
  let appCloseAcquireCount = 0;
  const appCloseController = createMomentsCampaignController({
    baseDir: appCloseRoot,
    cancelSchedule: appCloseClock.cancel,
    coordinator: {
      acquire: () => {
        appCloseAcquireCount += 1;
        return { ok: true, lock: { owner: "app-close-owner" } };
      },
      release: () => undefined
    },
    logger: { event: () => undefined },
    now: appCloseClock.now,
    openMoments: async () => ({ ok: true }),
    runStep: async () => {
      await appCloseGate;
      return {
        ok: false,
        blocked_reason: "app_closed_during_observation",
        real_action_attempted: false
      };
    },
    schedule: appCloseClock.schedule,
    scrollMoments: async () => ({ ok: true })
  });
  appCloseController.configureDaily({
    enabled: true,
    target: 1,
    startTime: "09:00",
    likeEnabled: true,
    commentEnabled: false
  });
  await waitFor(
    () => appCloseController.status().state,
    (state) => state.status === "running"
  );
  appCloseController.pauseForAppClose();
  releaseAppCloseObservation();
  const appClosed = await waitFor(
    () => appCloseController.status().state,
    (state) => state.status === "paused"
  );
  assert.equal(
    appClosed.daily_automation.suppressed_date,
    "",
    "closing the app must not suppress the remainder of today's plan"
  );
  appCloseController.dispose();
  assert.equal(appCloseClock.pending().length, 0, "dispose must clear the scheduled retry timer");

  await appCloseClock.advanceTo("2026-07-29T10:10:00+08:00");
  const appCloseRestartDriver = createSuccessfulDriver(["q".repeat(64)]);
  let appCloseRestartAcquireCount = 0;
  const appCloseRestartController = createMomentsCampaignController({
    baseDir: appCloseRoot,
    cancelSchedule: appCloseClock.cancel,
    coordinator: {
      acquire: () => {
        appCloseRestartAcquireCount += 1;
        return { ok: true, lock: { owner: "app-close-restart-owner" } };
      },
      release: () => undefined
    },
    logger: { event: () => undefined },
    now: appCloseClock.now,
    openMoments: async () => ({ ok: true }),
    runStep: appCloseRestartDriver.runStep,
    schedule: appCloseClock.schedule,
    scrollMoments: async () => ({ ok: true })
  });
  const appCloseRestartInitialized = appCloseRestartController.initialize();
  assert.equal(appCloseRestartInitialized.ok, true);
  assert.equal(appCloseRestartInitialized.restored, true);
  assert.equal(
    appCloseRestartAcquireCount,
    0,
    "restoring a future retry must not acquire or foreground WeChat during startup"
  );
  assert.equal(
    appCloseRestartController.status().state.daily_automation.next_run_at,
    appClosed.daily_automation.next_run_at,
    "a future retry must keep its persisted execution time"
  );
  await appCloseClock.advanceTo("2026-07-29T10:30:01+08:00");
  const appCloseRestartCompleted = await waitFor(
    () => appCloseRestartController.status().state,
    (state) => state.daily_automation.completed_count === 1
  );
  assert.equal(appCloseAcquireCount, 1);
  assert.equal(
    appCloseRestartAcquireCount,
    1,
    "the restored retry should start exactly once when its timer becomes due"
  );
  assert.equal(appCloseRestartCompleted.daily_automation.status, "completed");
  appCloseRestartController.dispose();
  const dedupRoot = createTempDir("moments-daily-dedup-restart-");
  const dedupClock = createFakeClock("2026-07-29T10:00:00+08:00");
  const fingerprintA = "r".repeat(64);
  const fingerprintB = "s".repeat(64);
  writeDailyState(dedupRoot, {
    enabled: true,
    target: 2,
    start_time: "09:00",
    like_enabled: true,
    comment_enabled: false,
    date: "2026-07-29",
    completed_count: 1,
    checked_count: 1,
    skipped_count: 0,
    completed_posts: [fingerprintA]
  });
  const dedupDriver = createSuccessfulDriver([fingerprintA, fingerprintB], [0]);
  let dedupAcquireCount = 0;
  const dedupController = createMomentsCampaignController({
    baseDir: dedupRoot,
    cancelSchedule: dedupClock.cancel,
    coordinator: {
      acquire: () => {
        dedupAcquireCount += 1;
        return { ok: true, lock: { owner: "dedup-owner" } };
      },
      release: () => undefined
    },
    logger: { event: () => undefined },
    now: dedupClock.now,
    openMoments: async () => ({ ok: true }),
    runStep: dedupDriver.runStep,
    schedule: dedupClock.schedule,
    scrollMoments: async () => ({ ok: true })
  });
  const dedupInitialized = dedupController.initialize();
  assert.equal(dedupInitialized.deferred, true);
  assert.equal(dedupAcquireCount, 0, "restart must preserve dedup state without opening Moments");
  assert.equal(dedupController.runDailyNow().ok, true);
  const dedupCompleted = await waitFor(
    () => dedupController.status().state,
    (state) => state.daily_automation.completed_count === 2
  );
  assert.equal(dedupAcquireCount, 1);
  assert.equal(dedupCompleted.processed_count, 2);
  assert.equal(dedupCompleted.daily_automation.checked_count, 3);
  const dedupPersisted = JSON.parse(fs.readFileSync(path.join(dedupRoot, "state.json"), "utf8"));
  assert.deepEqual(
    dedupPersisted.moments_daily_automation.completed_posts,
    [fingerprintA, fingerprintB],
    "an already-counted fingerprint must not consume the remaining quota after restart"
  );
  dedupController.dispose();
  const crashRoot = createTempDir("moments-daily-crash-recovery-");
  const crashClock = createFakeClock("2026-07-29T10:00:00+08:00");
  writeDailyState(crashRoot, {
    enabled: true,
    target: 2,
    start_time: "09:00",
    like_enabled: true,
    comment_enabled: false,
    date: "2026-07-29",
    completed_count: 1,
    checked_count: 1,
    completed_posts: ["u".repeat(64)]
  }, {
    status: "running",
    current_post: 2,
    automated_run: true,
    daily_tracking: true
  });
  let crashAcquireCount = 0;
  let crashOpenCount = 0;
  const crashController = createMomentsCampaignController({
    baseDir: crashRoot,
    cancelSchedule: crashClock.cancel,
    coordinator: {
      acquire: () => {
        crashAcquireCount += 1;
        return { ok: true, lock: { owner: "crash-owner" } };
      },
      release: () => undefined
    },
    logger: { event: () => undefined },
    now: crashClock.now,
    openMoments: async () => {
      crashOpenCount += 1;
      return { ok: true };
    },
    runStep: createSuccessfulDriver(["v".repeat(64)]).runStep,
    schedule: crashClock.schedule,
    scrollMoments: async () => ({ ok: true })
  });
  const crashInitialized = crashController.initialize();
  assert.equal(crashInitialized.deferred, true);
  const crashRecovered = crashController.status().state;
  assert.equal(crashRecovered.status, "partial");
  assert.equal(crashRecovered.last_reason, "app_restarted_pending_resume");
  assert.equal(crashRecovered.daily_automation.status, "pending_resume");
  assert.equal(crashAcquireCount, 0);
  assert.equal(crashOpenCount, 0);
  crashController.dispose();
  const writeFailureRoot = createTempDir("moments-daily-write-failure-");
  const writeFailureClock = createFakeClock("2026-07-29T08:00:00+08:00");
  writeDailyState(writeFailureRoot, {
    enabled: true,
    target: 1,
    start_time: "09:00",
    like_enabled: true,
    comment_enabled: false,
    date: "2026-07-29",
    completed_count: 0,
    checked_count: 0,
    skipped_count: 0,
    completed_posts: []
  });
  let writeAttemptCount = 0;
  const writeFailureController = createMomentsCampaignController({
    baseDir: writeFailureRoot,
    busyRetryMs: 60_000,
    cancelSchedule: writeFailureClock.cancel,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "write-failure-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    now: writeFailureClock.now,
    openMoments: async () => ({ ok: true }),
    runStep: createSuccessfulDriver(["t".repeat(64)]).runStep,
    schedule: writeFailureClock.schedule,
    scrollMoments: async () => ({ ok: true }),
    writeStateJson: (file, value) => {
      writeAttemptCount += 1;
      if (writeAttemptCount > 1) {
        const error = new Error("synthetic daily persistence failure");
        error.code = "synthetic_daily_persist_failed";
        throw error;
      }
      fs.writeFileSync(file, JSON.stringify(value), "utf8");
    }
  });
  writeFailureController.initialize();
  assert.equal(writeFailureClock.pending().length, 1);
  await assert.doesNotReject(
    () => writeFailureClock.advanceTo("2026-07-29T09:00:01+08:00"),
    "a scheduled persistence failure must not escape the timer callback"
  );
  assert.equal(writeAttemptCount, 2);
  assert.equal(
    writeFailureClock.pending().length,
    1,
    "a scheduled persistence failure must retain one bounded in-memory retry"
  );
  writeFailureController.dispose();
  assert.equal(
    writeFailureClock.pending().length,
    0,
    "dispose must also clear an in-memory recovery timer"
  );

  missedController.dispose();
  busyController.dispose();
  unknownController.dispose();
  pauseController.dispose();

  console.log("moments daily automation self-check passed");
}

async function main() {
  try {
    await runChecks();
  } finally {
    cleanupTempDirs();
  }
}

void main();
