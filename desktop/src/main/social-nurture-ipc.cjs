const { createSocialNurture } = require("./social-nurture.cjs");
const { reportSocialFailure } = require("./social-publish-ipc.cjs");

// `publish` hands the day-8 test video to 一键分发 (its submitFinished).
function registerSocialNurtureIpc({ ipcMain, dataDir, accounts, getMainWindow, publish, logger, evidenceDir, options = {} }) {
  let nurture; let initializationError;
  try {
    if (!accounts) throw Object.assign(new Error("accounts unavailable"), { code: "NURTURE_ACCOUNTS_UNAVAILABLE" });
    nurture = createSocialNurture({ dataDir, accounts, ...options,
      publish: ({ accountId, finishedVideoId, name, title }) => publish({ videos: [{ finishedVideoId, name }], accountIds: [accountId], title, description: "", visibility: "public" }),
      onFailure: (failure) => { try { reportSocialFailure({ logger, evidenceDir }, "social_nurture", failure); } catch { /* Diagnostics never change the run. */ } },
      onChange: (state) => { const window = getMainWindow(); if (window && !window.isDestroyed()) window.webContents.send("social-nurture:update", state); } });
    nurture.start();
  } catch (error) { initializationError = { ok: false, code: error.code || "NURTURE_UNAVAILABLE", error: error.code === "NURTURE_STATE_INVALID" ? error.message : "养号暂时无法打开，请重新打开软件。" }; }
  const id = (payload) => String(payload?.id || "");
  const methods = {
    status: () => nurture.snapshot(),
    savePlan: (payload) => nurture.savePlan({
      id: id(payload), platform: "douyin", accountId: String(payload?.accountId || ""), keywords: String(payload?.keywords || "").slice(0, 600),
      comments: String(payload?.comments || "").slice(0, 2000), startTime: String(payload?.startTime || ""),
      testVideo: payload?.testVideo?.finishedVideoId ? { finishedVideoId: String(payload.testVideo.finishedVideoId), name: String(payload.testVideo.name || ""), title: String(payload.testVideo.title || "") } : null
    }),
    removePlan: (payload) => nurture.removePlan(id(payload)),
    setEnabled: (payload) => nurture.setEnabled(id(payload), payload?.enabled === true),
    stop: () => nurture.stop()
  };
  const channels = Object.keys(methods).map((name) => `social-nurture:${name}`);
  for (const [name, method] of Object.entries(methods)) ipcMain.handle(`social-nurture:${name}`, async (event, payload) => {
    const trusted = getMainWindow()?.webContents;
    if (!trusted || event.sender !== trusted || event.senderFrame !== trusted.mainFrame) return { ok: false, code: "NURTURE_IPC_FORBIDDEN", error: "当前页面无权操作养号。" };
    if (initializationError) return initializationError;
    try { return { ok: true, state: await method(payload) }; }
    catch (error) { return { ok: false, code: error.code || "NURTURE_OPERATION_FAILED", error: /^(NURTURE|SOCIAL)_/.test(String(error.code || "")) ? error.message : "操作未完成，请稍后重试。", state: nurture.snapshot() }; }
  });
  return { nurture, isBusy: () => Boolean(nurture?.isBusy()), async dispose() { channels.forEach((channel) => ipcMain.removeHandler(channel)); await nurture?.dispose(); } };
}
module.exports = { registerSocialNurtureIpc };
