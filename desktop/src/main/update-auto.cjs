// Installs an already downloaded and verified update without a click, but only
// when nothing can be interrupted: the WeChat workflow is off (it never turns
// itself back on after a restart), no WeChat/video/content task is running, and
// the user is not at the keyboard. Right after launch a short pause is enough;
// later the machine must have been idle for a while. A request that still waits
// on a task after `waitMs` is withdrawn, and retried only after `retryMs`, so the
// hold never keeps blocking new work.
function createAutoUpdate({ controller, request, cancel, busy, idleSeconds, now = Date.now,
  launchWindowMs = 3 * 60_000, launchIdleSeconds = 20, laterIdleSeconds = 300, waitMs = 20_000, retryMs = 10 * 60_000, intervalMs = 30_000 }) {
  const startedAt = now();
  let ours = 0, quietUntil = 0, running = false, timer;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const state = controller.status();
      if (ours) {
        if (!state.updateRequested) ours = 0;
        else if (now() - ours >= waitMs) { ours = 0; quietUntil = now() + retryMs; await cancel(); }
        return;
      }
      if (state.stage !== "ready" || state.updateRequested || now() < quietUntil) return;
      const required = now() - startedAt <= launchWindowMs ? launchIdleSeconds : laterIdleSeconds;
      if (idleSeconds() < required || await busy()) return;
      ours = now();
      const next = await request();
      if (!next?.updateRequested) ours = 0;
    } catch { ours = 0; }
    finally { running = false; }
  }
  return {
    tick,
    start() { if (!timer) { timer = setInterval(() => void tick(), intervalMs); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = undefined; },
    // A click on 立即更新 owns the request from then on; never withdraw it.
    userRequested() { ours = 0; }
  };
}
module.exports = { createAutoUpdate };
