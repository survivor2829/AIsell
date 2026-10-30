const path = require("node:path");
const { createSocialPublisher } = require("./social-publisher.cjs");
const { createCoverCache, writeCopy } = require("./social-publish-copy.cjs");

const FINISHED_ID = /^finished_[a-f0-9]{32}$/;
const PLATFORMS = ["douyin", "kuaishou", "xiaohongshu", "channels"];

// The renderer names videos by their 成片中心 id; file paths are resolved here and never sent back.
const STEP_CODES = { "打开平台": "open", "上传视频": "upload", "设置封面": "cover", "填写内容": "fill", "点击发布": "click", "等你验证": "user_verification", "等待平台结果": "result", "核对作品": "verify" };

// A platform-page failure (publishing or 养号) in the diagnostic log, which failure capsules
// pick up, with the page screenshot saved where capsules look for same-moment evidence.
function reportSocialFailure({ logger, evidenceDir }, module, failure) {
  const crypto = require("node:crypto"), fs = require("node:fs");
  const code = String(failure.code || "SOCIAL_UNEXPECTED").toLowerCase();
  let evidenceId = "";
  if (evidenceDir && failure.screenshot) {
    try {
      evidenceId = crypto.randomUUID().replace(/-/g, "");
      fs.mkdirSync(evidenceDir, { recursive: true });
      fs.writeFileSync(path.join(evidenceDir, `${evidenceId}.png`), Buffer.from(failure.screenshot, "base64"));
      fs.writeFileSync(path.join(evidenceDir, `${evidenceId}.json`), JSON.stringify({ v: 1, ts: new Date().toISOString(), level: "error", module, event: "job_failed", code,
        trace_id: "", details: { evidence_id: evidenceId, capture_status: "saved", redaction_mode: "internal_visible", rule_id: module.replace(/_/g, "-"),
          ...(failure.notices?.length ? { notes: failure.notices.slice(0, 3) } : {}) } }));
    } catch { evidenceId = ""; }
  }
  // Asking for a new login is the platform's normal answer to an ended session: counted, not filed as a bug.
  logger?.event?.(module, "job_failed", { platform_kind: failure.platform, step_code: STEP_CODES[failure.step] || (/^[a-z_]+$/.test(String(failure.step || "")) ? failure.step : "unknown"),
    ...(failure.clicked !== undefined ? { clicked: failure.clicked } : {}), ...(failure.day ? { day: failure.day, nurture_mode: failure.mode } : {}),
    // The page it stopped on as a plain identifier (platform.post.create, login.html), which the log keeps readable.
    page_kind: failure.pageUrl ? new URL(failure.pageUrl).pathname.replace(/[^a-z0-9_.:-]+/gi, ".").replace(/^\.+|\.+$/g, "").slice(0, 100) : "", ...(evidenceId ? { evidence_id: evidenceId } : {}),
    // Hosts whose page resources failed or were slow: a network or proxy problem shows here.
    failed_request_kind: (failure.network?.failed || []).slice(0, 20), slow_request_kind: (failure.network?.slow || []).slice(0, 20),
    // Requests the platform answered with an error status (host:type:status).
    rejected_request_kind: (failure.network?.rejected || []).slice(0, 20) },
  { level: code === "social_login_required" ? "warn" : "error", code });
}
const reportPublishFailure = (deps, failure) => reportSocialFailure(deps, "social_publish", failure);

function registerSocialPublishIpc({ ipcMain, dataDir, accounts, resolveFinishedVideo, resolveFinishedCover = async () => "", getMainWindow, ffmpegPath = "ffmpeg", copyClient, publisherOptions = {}, logger, evidenceDir, onState = () => {} }) {
  const covers = createCoverCache({ dir: path.join(dataDir, "covers"), ffmpegPath });
  let publisher; let initializationError;
  try {
    if (!accounts) throw Object.assign(new Error("accounts unavailable"), { code: "SOCIAL_ACCOUNTS_UNAVAILABLE" });
    publisher = createSocialPublisher({ dataDir, accounts, ...publisherOptions,
      onFailure: (failure) => { try { reportPublishFailure({ logger, evidenceDir }, failure); } catch { /* Diagnostics never change the job result. */ } },
      onChange: (state) => { const window = getMainWindow(); if (window && !window.isDestroyed()) window.webContents.send("social-publish:update", state); try { onState(state); } catch { /* 小玺 never changes the job. */ } } });
  } catch (error) { initializationError = { ok: false, code: error.code || "SOCIAL_PUBLISH_UNAVAILABLE", error: error.code === "SOCIAL_PUBLISH_STATE_INVALID" ? error.message : "一键分发暂时无法打开，请重新打开软件。" }; }
  const text = (value, max) => String(value ?? "").slice(0, max);
  // The renderer's submit and 养号's day-8 test video share this path, so both resolve files and covers the same way.
  async function submitFinished(payload) {
    if (initializationError) throw Object.assign(new Error(initializationError.error), { code: initializationError.code });
    const items = Array.isArray(payload?.videos) ? payload.videos.slice(0, 20) : [];
    const videos = [];
    for (const item of items) {
      const id = String(item?.finishedVideoId || "");
      if (!FINISHED_ID.test(id)) throw Object.assign(new Error("invalid video"), { code: "SOCIAL_VIDEO_MISSING", message: "有视频已不在成片中心，请刷新后重选。" });
      const file = await resolveFinishedVideo(id).catch(() => { throw Object.assign(new Error("找不到这条成片的文件，请在成片中心确认它还在。"), { code: "SOCIAL_VIDEO_MISSING" }); });
      videos.push({ path: file, name: text(item?.name, 80) || path.basename(file), cover: await resolveFinishedCover(id).catch(() => "") });
    }
    const accountIds = Array.isArray(payload?.accountIds) ? payload.accountIds.slice(0, 40).map((id) => String(id || "")) : [];
    const copies = {};
    for (const platform of PLATFORMS) {
      const copy = payload?.copies?.[platform];
      if (copy && typeof copy === "object") copies[platform] = { title: text(copy.title, 60), description: text(copy.description, 1000) };
    }
    const result = publisher.submit({ videos, accountIds, title: text(payload?.title, 60), description: text(payload?.description, 1000), copies, visibility: payload?.visibility === "private" ? "private" : "public" });
    return { ...result.state, created: result.created, skipped: result.skipped };
  }
  const methods = {
    status: () => publisher.snapshot(),
    submit: (payload) => submitFinished(payload),
    // Covers for the video picker: the cover that will be published, else a frame; a video whose file is gone has none.
    async covers(payload) {
      const ids = (Array.isArray(payload?.ids) ? payload.ids : []).map(String).filter((id) => FINISHED_ID.test(id)).slice(0, 24);
      const result = {};
      for (const id of ids) {
        try {
          const own = await resolveFinishedCover(id).catch(() => "");
          result[id] = own ? `data:image/${/\.png$/i.test(own) ? "png" : "jpeg"};base64,${require("node:fs").readFileSync(own).toString("base64")}` : await covers.cover(id, await resolveFinishedVideo(id));
        } catch { result[id] = ""; }
      }
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
  return { publisher, submitFinished, isBusy: () => Boolean(publisher?.isBusy()), async dispose() { channels.forEach((channel) => ipcMain.removeHandler(channel)); await publisher?.dispose(); } };
}
module.exports = { reportSocialFailure, reportPublishFailure, registerSocialPublishIpc };
