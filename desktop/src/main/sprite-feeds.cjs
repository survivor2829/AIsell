// Feeds 小玺 from every feature (user decision 2026-10-30: whatever runs, 小玺 shows it): video work
// from the content engine's task list, saved product-detail images, and 精准获客 states the main
// window already receives. 微信拓客, 养号 and 一键分发 report to 小玺 directly.
const { videoActivity, videoEvents, acquisitionActivity } = require("./sprite-activity.cjs");

const VIDEO_POLL_MS = 4000;

function createSpriteFeeds({ sprite, contentEngine = () => null, productDetailHistory = () => [], setTimer = setInterval, clearTimer = clearInterval }) {
  const videoStates = new Map();
  let lastDetailAt = null, timer = null, polling = false;

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

  return {
    start() {
      if (timer) return;
      pollDetail();
      timer = setTimer(() => { void pollVideo(); pollDetail(); }, VIDEO_POLL_MS);
      timer?.unref?.();
    },
    // A state the main window just received; the 精准获客 ones become 小玺's activity.
    onRendererUpdate(channel, state) {
      const activity = acquisitionActivity(channel, state);
      if (activity !== undefined) sprite()?.setExternalActivity(channel.split(":")[0], activity);
    },
    stop() { clearTimer(timer); timer = null; },
    pollVideo, pollDetail
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
