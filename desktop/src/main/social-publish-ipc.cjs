const path = require("node:path");
const { createSocialPublisher } = require("./social-publisher.cjs");
const { createCoverCache, writeCopy } = require("./social-publish-copy.cjs");

const FINISHED_ID = /^finished_[a-f0-9]{32}$/;
const PLATFORMS = ["douyin", "kuaishou", "xiaohongshu", "channels"];

// The renderer names videos by their 成片中心 id; file paths are resolved here and never sent back.
function registerSocialPublishIpc({ ipcMain, dataDir, accounts, resolveFinishedVideo, getMainWindow, ffmpegPath = "ffmpeg", copyClient, publisherOptions = {} }) {
  const covers = createCoverCache({ dir: path.join(dataDir, "covers"), ffmpegPath });
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
      const copies = {};
      for (const platform of PLATFORMS) {
        const copy = payload?.copies?.[platform];
        if (copy && typeof copy === "object") copies[platform] = { title: text(copy.title, 60), description: text(copy.description, 1000) };
      }
      const result = publisher.submit({ videos, accountIds, title: text(payload?.title, 60), description: text(payload?.description, 1000), copies, visibility: payload?.visibility === "private" ? "private" : "public" });
      return { ...result.state, created: result.created, skipped: result.skipped };
    },
    // Cover frames for the video picker; a video whose file is gone simply has none.
    async covers(payload) {
      const ids = (Array.isArray(payload?.ids) ? payload.ids : []).map(String).filter((id) => FINISHED_ID.test(id)).slice(0, 24);
      const result = {};
      for (const id of ids) { try { result[id] = await covers.cover(id, await resolveFinishedVideo(id)); } catch { result[id] = ""; } }
      return result;
    },
    async suggest(payload) {
      const videos = (Array.isArray(payload?.videos) ? payload.videos : []).slice(0, 5).map((video) => ({ title: text(video?.title, 80), name: text(video?.name, 80), context: text(video?.context, 200) }));
      const platforms = (Array.isArray(payload?.platforms) ? payload.platforms : []).map(String).filter((platform) => PLATFORMS.includes(platform));
      return writeCopy({ client: copyClient, videos, hint: text(payload?.hint, 300), platforms: platforms.length ? platforms : PLATFORMS });
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
    catch (error) { return { ok: false, code: error.code || "SOCIAL_OPERATION_FAILED", error: /^SOCIAL_/.test(String(error.code || "")) ? error.message : "操作未完成，已有发布记录保留，请稍后重试。", state: publisher.snapshot() }; }
  });
  return { publisher, isBusy: () => Boolean(publisher?.isBusy()), async dispose() { channels.forEach((channel) => ipcMain.removeHandler(channel)); await publisher?.dispose(); } };
}
module.exports = { registerSocialPublishIpc };
