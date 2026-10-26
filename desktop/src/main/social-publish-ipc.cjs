const path = require("node:path");
const { createSocialPublisher } = require("./social-publisher.cjs");

const FINISHED_ID = /^finished_[a-f0-9]{32}$/;

// The renderer names videos by their 成片中心 id; file paths are resolved here and never sent back.
function registerSocialPublishIpc({ ipcMain, dataDir, accounts, resolveFinishedVideo, getMainWindow, publisherOptions = {} }) {
  let publisher; let initializationError;
  try {
    if (!accounts) throw Object.assign(new Error("accounts unavailable"), { code: "SOCIAL_ACCOUNTS_UNAVAILABLE" });
    publisher = createSocialPublisher({ dataDir, accounts, ...publisherOptions,
      onChange: (state) => { const window = getMainWindow(); if (window && !window.isDestroyed()) window.webContents.send("social-publish:update", state); } });
  } catch (error) { initializationError = { ok: false, code: error.code || "SOCIAL_PUBLISH_UNAVAILABLE", error: error.code === "SOCIAL_PUBLISH_STATE_INVALID" ? error.message : "一键分发暂时无法打开，请重新打开软件。" }; }
  const text = (value, max) => String(value ?? "").slice(0, max);
  const methods = {
    status: () => publisher.snapshot(),
    async submit(payload) {
      const items = Array.isArray(payload?.videos) ? payload.videos.slice(0, 20) : [];
      const videos = [];
      for (const item of items) {
        const id = String(item?.finishedVideoId || "");
        if (!FINISHED_ID.test(id)) throw Object.assign(new Error("invalid video"), { code: "SOCIAL_VIDEO_MISSING", message: "有视频已不在成片中心，请刷新后重选。" });
        const file = await resolveFinishedVideo(id).catch(() => { throw Object.assign(new Error("找不到这条成片的文件，请在成片中心确认它还在。"), { code: "SOCIAL_VIDEO_MISSING" }); });
        videos.push({ path: file, name: text(item?.name, 80) || path.basename(file) });
      }
      const accountIds = Array.isArray(payload?.accountIds) ? payload.accountIds.slice(0, 40).map((id) => String(id || "")) : [];
      const result = publisher.submit({ videos, accountIds, title: text(payload?.title, 60), description: text(payload?.description, 1000), visibility: payload?.visibility === "private" ? "private" : "public" });
      return { ...result.state, created: result.created, skipped: result.skipped };
    },
    cancel: (payload) => publisher.cancel(String(payload?.id || "")),
    retry: (payload) => publisher.retry(String(payload?.id || "")),
    resolve: (payload) => publisher.resolve(String(payload?.id || ""), payload?.published === true),
    remove: (payload) => publisher.remove(String(payload?.id || ""))
  };
  const channels = Object.keys(methods).map((name) => `social-publish:${name}`);
  for (const [name, method] of Object.entries(methods)) ipcMain.handle(`social-publish:${name}`, async (event, payload) => {
    const trusted = getMainWindow()?.webContents;
    if (!trusted || event.sender !== trusted || event.senderFrame !== trusted.mainFrame) return { ok: false, code: "SOCIAL_IPC_FORBIDDEN", error: "当前页面无权发布视频。" };
    if (initializationError) return initializationError;
    try { return { ok: true, state: await method(payload) }; }
    catch (error) { return { ok: false, code: error.code || "SOCIAL_OPERATION_FAILED", error: error.code ? error.message : "操作未完成，已有发布记录保留，请稍后重试。", state: publisher.snapshot() }; }
  });
  return { publisher, isBusy: () => Boolean(publisher?.isBusy()), async dispose() { channels.forEach((channel) => ipcMain.removeHandler(channel)); await publisher?.dispose(); } };
}
module.exports = { registerSocialPublishIpc };
