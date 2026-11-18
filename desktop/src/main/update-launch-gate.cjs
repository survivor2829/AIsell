// 打开即更新：发现新版就先装好再进入，不能跳过；失败自动重试直到装好。
// 只在这些情况下直接进入当前版本：连不上更新服务器、这台电脑不能自动安装、
// 上次更新失败已回滚（避免反复安装同一个装不上的版本）、已安装的程序文件缺失或损坏、磁盘空间不足（重试都无法修复）。
// The gate keeps the update hold on while it runs, so no business work starts before it opens.
const SETTLED = new Set(["current", "ready", "error", "blocked", "idle", "disabled"]);
// What counts as the download failing (the network or the transfer), not a bad package or a full disk:
// only these let the customer in early and keep resuming in the background (review 2026-11-18).
const DOWNLOAD_FAILURE = /^(?:cloud_(?:timeout|slow|stopped|download_\w+|response_\w+|range_invalid)|download_\w+|stalled|E(?:CONN\w+|TIMEDOUT|AI_AGAIN|NOTFOUND|HOSTUNREACH|NETUNREACH|NETDOWN|PIPE))$/u;
const downloadFailure = (state) => state === "stalled" || (state?.stage === "error" && (!state.errorCode || DOWNLOAD_FAILURE.test(state.errorCode)));

// 2026-11-18 (field): a computer whose download kept breaking (slow Wi-Fi or security software cutting the
// connection) retried here without end and the customer could not use the software at all. After
// downloadFailureLimit failures in a row the customer goes in on the current version; the download keeps
// resuming in the background (bytes already fetched are kept) and installs as usual once it is ready.
function createLaunchGate({ controller, request, setHold, onOpen = () => {}, publish = () => {}, now = Date.now,
  checkTimeoutMs = 20_000, retryBaseMs = 2_000, retryMaxMs = 60_000, downloadFailureLimit = 3, stallMs = 3 * 60_000, stallPollMs = 15_000,
  backgroundRetryMs = 2 * 60_000, backgroundRetryMaxMs = 10 * 60_000,
  sleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); }) }) {
  let gate = { phase: "checking", reason: "", attempt: 0, retryAt: 0 };
  let started = false, startedAt = 0;
  function emit(patch) { gate = { ...gate, ...patch }; publish(status()); }
  function status() { return { ...gate }; }
  function open(reason) {
    if (gate.phase === "open") return status();
    emit({ phase: "open", reason, retryAt: 0 });
    setHold(false);
    try { onOpen(reason, { attempts: gate.attempt, elapsedMs: Math.max(0, now() - startedAt) }); } catch { /* Opening must never be blocked by a resume hook. */ }
    return status();
  }
  // Resolves once the controller leaves checking/downloading/verifying, or with null when the
  // first answer from the server takes too long before any newer version is known.
  function settle(predicate, timeoutMs = 0) {
    return new Promise(resolve => {
      let done = false, timer;
      const finish = value => { if (done) return; done = true; clearTimeout(timer); unsubscribe(); resolve(value); };
      const unsubscribe = controller.onUpdate(state => { if (predicate(state)) finish(state); });
      if (timeoutMs) timer = setTimeout(() => { if (!controller.status().nextVersion) finish(null); }, timeoutMs);
      const current = controller.status();
      if (predicate(current)) finish(current);
    });
  }
  async function attempt() {
    // check() marks the stage as checking synchronously, so the previous result is never mistaken for this one.
    void controller.check();
    // A transfer that stops moving without ever failing (a connection held open with no bytes) counts as
    // a failed attempt after stallMs, instead of waiting forever.
    let lastBytes = -1, lastMove = now(), watch;
    const stalled = new Promise(resolve => {
      watch = setInterval(() => {
        const bytes = Number(controller.status().downloadedBytes) || 0;
        if (bytes !== lastBytes) { lastBytes = bytes; lastMove = now(); return; }
        if (now() - lastMove >= stallMs) resolve("stalled");
      }, stallPollMs);
      watch.unref?.();
    });
    try { return await Promise.race([settle(state => !state.updateRequested && SETTLED.has(state.stage), gate.attempt ? 0 : checkTimeoutMs), stalled]); }
    finally { clearInterval(watch); }
  }
  // After the customer is let in: keep resuming the download quietly until it is ready (or current).
  async function keepDownloading() {
    let delay = backgroundRetryMs;
    for (;;) {
      await sleep(delay);
      if (!controller.status().enabled) return;
      const state = await attempt().catch(() => null);
      // Stop on success, and on a failure retrying cannot fix (it is reported where it happens).
      if (!state || !downloadFailure(state)) return;
      delay = Math.min(backgroundRetryMaxMs, delay * 2);
    }
  }
  async function run() {
    let downloadFailures = 0;
    try {
      const initial = controller.status();
      if (!initial.enabled || !initial.canInstall) return open("unsupported");
      if (initial.updateFailure) return open("rolled_back");
      for (;;) {
        const state = await attempt();
        if (!state) return open("offline");
        if (state === "stalled") {
          downloadFailures += 1;
          if (downloadFailures >= downloadFailureLimit) { const opened = open("download_failing"); void keepDownloading(); return opened; }
          const attempts = gate.attempt + 1;
          const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** (attempts - 1));
          emit({ phase: "retrying", attempt: attempts, retryAt: now() + delay });
          await sleep(delay);
          emit({ phase: "updating", retryAt: 0 });
          continue;
        }
        if (state.stage === "current") return open("current");
        if (state.stage === "blocked") return open("blocked");
        if (state.stage === "ready") {
          downloadFailures = 0; // "in a row": a finished download starts the count again
          emit({ phase: "installing", retryAt: 0 });
          const next = await request();
          // The coordinator installs and quits; it only hands back when the install could not start.
          if (next?.updateRequested) await settle(value => !value.updateRequested);
          // Install could not start for lack of space (backups, ENOSPC): the next check would only
          // reach ready again and repeat this, so let the customer in with the numbers instead.
          const after = controller.status();
          if (after.stage === "error" && /disk_space_insufficient/u.test(after.error || "")) return open("disk_full");
        } else if (state.stage === "error") {
          if (/full_upgrade_required/u.test(state.error || "")) return open("not_ready");
          // A file missing from the installed program never comes back by retrying; let the
          // customer keep working on the current version and show how to reinstall.
          if (/component_base_file_(?:missing|damaged)/u.test(state.error || "")) return open("base_damaged");
          // A full disk is cleared by the customer, not by retrying (field 2026-11-12): let them in with the numbers.
          if (/disk_space_insufficient/u.test(state.error || "")) return open("disk_full");
          if (!state.nextVersion) return open("offline");
          downloadFailures = downloadFailure(state) ? downloadFailures + 1 : 0;
          if (downloadFailures >= downloadFailureLimit) {
            const opened = open("download_failing");
            void keepDownloading();
            return opened;
          }
        } else {
          return open("unsupported");
        }
        const attempts = gate.attempt + 1;
        const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** (attempts - 1));
        emit({ phase: "retrying", attempt: attempts, retryAt: now() + delay });
        await sleep(delay);
        emit({ phase: "updating", retryAt: 0 });
      }
    } catch {
      return open("gate_failed");
    }
  }
  return {
    status,
    start() {
      if (started) return;
      started = true; startedAt = now();
      setHold(true);
      emit({ phase: "checking" });
      return run();
    }
  };
}

module.exports = { createLaunchGate };
