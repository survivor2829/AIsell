// 打开即更新：发现新版就先装好再进入，不能跳过；失败自动重试直到装好。
// 只在三种情况下直接进入当前版本：连不上更新服务器、这台电脑不能自动安装、
// 上次更新失败已回滚（避免反复安装同一个装不上的版本）。
// The gate keeps the update hold on while it runs, so no business work starts before it opens.
const SETTLED = new Set(["current", "ready", "error", "blocked", "idle", "disabled"]);

function createLaunchGate({ controller, request, setHold, onOpen = () => {}, publish = () => {}, now = Date.now,
  checkTimeoutMs = 20_000, retryBaseMs = 2_000, retryMaxMs = 60_000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let gate = { phase: "checking", reason: "", attempt: 0, retryAt: 0 };
  let started = false;
  function emit(patch) { gate = { ...gate, ...patch }; publish(status()); }
  function status() { return { ...gate }; }
  function open(reason) {
    if (gate.phase === "open") return status();
    emit({ phase: "open", reason, retryAt: 0 });
    setHold(false);
    try { onOpen(reason); } catch { /* Opening must never be blocked by a resume hook. */ }
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
    return settle(state => !state.updateRequested && SETTLED.has(state.stage), gate.attempt ? 0 : checkTimeoutMs);
  }
  async function run() {
    try {
      const initial = controller.status();
      if (!initial.enabled || !initial.canInstall) return open("unsupported");
      if (initial.updateFailure) return open("rolled_back");
      for (;;) {
        const state = await attempt();
        if (!state) return open("offline");
        if (state.stage === "current") return open("current");
        if (state.stage === "blocked") return open("blocked");
        if (state.stage === "ready") {
          emit({ phase: "installing", retryAt: 0 });
          const next = await request();
          // The coordinator installs and quits; it only hands back when the install could not start.
          if (next?.updateRequested) await settle(value => !value.updateRequested);
        } else if (state.stage === "error") {
          if (/full_upgrade_required/u.test(state.error || "")) return open("not_ready");
          if (!state.nextVersion) return open("offline");
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
      started = true;
      setHold(true);
      emit({ phase: "checking" });
      return run();
    }
  };
}

module.exports = { createLaunchGate };
