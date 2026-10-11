// A request belongs to this process only. Cancellation never schedules a later boot.
function createUpdateCoordinator({ controller, setHold, prepare, release, quit, intervalMs = 1500 }) {
  let requested = false, running = false, installing = false, preparing = false, timer, epoch = 0;
  async function tick(ticket) {
    if (!requested || running || ticket !== epoch) return;
    running = true;
    try {
      const waiting = await prepare();
      if (!requested || ticket !== epoch) return;
      if (waiting) { controller.setUpdateRequest(true, waiting); return; }
      installing = true;
      if (await controller.beginInstall()) { requested = false; clearInterval(timer); quit(); }
      else { installing = false; await cancel(); }
    } catch {
      if (!requested || ticket !== epoch) return;
      installing = false;
      await cancel();
      controller.setInstallBlocked("暂时无法确认任务是否保存，请重试更新。故障编号：update_prepare_failed");
    } finally { if (!requested && !installing) await release(); running = false; }
  }
  async function cancel() {
    if (installing) return controller.status();
    requested = false; epoch++; clearInterval(timer); setHold(false);
    await release(); controller.setUpdateRequest(false);
    return controller.status();
  }
  async function request() {
    if (requested || installing || preparing) return controller.status();
    preparing = true;
    try { if (!await controller.prepareInstall()) return controller.status(); }
    finally { preparing = false; }
    requested = true; const ticket = ++epoch; setHold(true);
    controller.setUpdateRequest(true, "正在等待当前任务保存，随后自动更新。");
    timer = setInterval(() => void tick(ticket), intervalMs); timer.unref?.();
    void tick(ticket);
    return controller.status();
  }
  return { request, cancel };
}
module.exports = { createUpdateCoordinator };
