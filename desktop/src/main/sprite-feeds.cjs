// Feeds 小玺 from every feature (user decision 2026-10-30: whatever runs, 小玺 shows it): video work
// from the content engine's task list, saved product-detail images, and 精准获客 states the main
// window already receives. 微信拓客, 养号 and 一键分发 report to 小玺 directly.
const { videoActivity, videoEvents, pushedActivity, productDetailActivity, productDetailEvent, serviceActivity } = require("./sprite-activity.cjs");

const VIDEO_POLL_MS = 4000;
// A scan that ends without saying so must not leave the bubble claiming it is still running.
const PUSHED_STALE_MS = 45000;
const DETAIL_MISSES_ALLOWED = 3;
const channelKind = (channel) => channel.startsWith("digital-human:") ? channel.split(":")[1] : channel.split(":")[0];

function createSpriteFeeds({ sprite, contentEngine = () => null, productDetailHistory = () => [], productDetailStatus = async () => null, productVideoTasks = () => [], referenceTasks = () => [],
  setTimer = setInterval, clearTimer = clearInterval, now = Date.now }) {
  const videoStates = new Map();
  let lastDetailAt = null, timer = null, polling = false, detailActive = null, detailPolling = false, detailMisses = 0, viralAt = 0;

  async function pollVideo() {
    const engine = contentEngine();
    if (!engine?.listTasks || polling) return;
    polling = true;
    try {
      const items = (await engine.listTasks({ limit: 20 }))?.items || [];
      for (const line of videoEvents(videoStates, items)) sprite()?.say(line);
      videoStates.clear();
      for (const task of items) videoStates.set(task.task_id, task.status);
      sprite()?.setExternalActivity("video", videoActivity(items));
    } catch { /* The engine may be starting; the next look tries again. */ }
    finally { polling = false; }
  }

  function pollDetail() {
    const history = productDetailHistory() || [];
    const latest = history.length ? history[history.length - 1].at : "";
    if (lastDetailAt !== null && latest && latest !== lastDetailAt) sprite()?.say({ text: "又做好一张详情图啦～", sub: "已经帮你保存好了", mood: "done" });
    lastDetailAt = latest;
  }

  async function pollDetailActivity() {
    if (detailPolling) return;
    detailPolling = true;
    try {
      const report = await productDetailStatus();
      if (!report) {
        // The sidecar crashed or stopped: don't keep claiming the last step is still going.
        if (detailActive && ++detailMisses >= DETAIL_MISSES_ALLOWED) { detailActive = null; detailMisses = 0; sprite()?.setExternalActivity("productDetail", null); }
        return;
      }
      detailMisses = 0;
      const activity = productDetailActivity(report);
      const line = productDetailEvent(detailActive, report);
      if (line) sprite()?.say(line);
      sprite()?.setExternalActivity("productDetail", activity);
      detailActive = activity;
    } catch { /* The next look tries again. */ }
    finally { detailPolling = false; }
  }
  function pollServices() {
    try { sprite()?.setExternalActivity("productVideo", serviceActivity("正在做产品效果视频", productVideoTasks())); } catch { /* Next look. */ }
    try { sprite()?.setExternalActivity("referenceHuman", serviceActivity("正在做本人口播视频", referenceTasks())); } catch { /* Next look. */ }
    if (viralAt && now() - viralAt > PUSHED_STALE_MS) { viralAt = 0; sprite()?.setExternalActivity("viral-progress", null); }
  }

  return {
    start() {
      if (timer) return;
      pollDetail();
      timer = setTimer(() => { void pollVideo(); pollDetail(); void pollDetailActivity(); pollServices(); }, VIDEO_POLL_MS);
      timer?.unref?.();
    },
    // A state the main window just received; the 精准获客 ones become 小玺's activity.
    onRendererUpdate(channel, state) {
      const activity = pushedActivity(channel, state);
      if (activity === undefined) return;
      if (channel === "digital-human:viral-progress") viralAt = activity ? now() : 0;
      sprite()?.setExternalActivity(channelKind(channel), activity);
    },
    stop() { clearTimer(timer); timer = null; },
    pollVideo, pollDetail, pollDetailActivity, pollServices
  };
}

// Lets 小玺 see the states the main window is sent, without each feature knowing about it.
function tapRendererUpdates(webContents, listener) {
  const send = webContents.send.bind(webContents);
  webContents.send = (channel, ...args) => {
    try { listener(channel, args[0]); } catch { /* 小玺 never changes what the page receives. */ }
    return send(channel, ...args);
  };
}

module.exports = { createSpriteFeeds, tapRendererUpdates };
