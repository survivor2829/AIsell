const assert = require("node:assert/strict");
const { nurtureActivity, publishActivity } = require("./sprite-activity.cjs");

// 小玺（用户 2026-10-30）：养号、一键分发在 Chrome 里跑时，小玺说正在做什么。
assert.equal(nurtureActivity({ running: "", plans: [{ id: "p" }] }), null, "没在跑就不显示");
assert.deepEqual(nurtureActivity({ running: "p", plans: [{ id: "p", accountLabel: "抖音号", phase: "watching", today: { counts: { watched: 12, likes: 3, follows: 1, comments: 0 } } }] }),
  { title: "正在养号 · 抖音号", detail: "已看 12 个视频，赞 3 · 关注 1 · 评 0" });
assert.equal(nurtureActivity({ running: "p", plans: [{ id: "p", accountLabel: "抖音号", phase: "opening" }] }).detail, "正在打开 Chrome");
assert.equal(publishActivity({ jobs: [{ id: "a", status: "published", createdAt: "1" }] }), null);
// 新的在前（和发布记录一样）：最早一个还没结束的任务之后，已结束的算完成。
const jobs = [
  { id: "c", status: "queued", platform: "kuaishou", createdAt: "3" },
  { id: "b", status: "running", platform: "douyin", step: "上传视频", title: "洗地机实测", createdAt: "2" },
  { id: "d", status: "published", createdAt: "2" },
  { id: "a", status: "published", createdAt: "1" }
];
assert.deepEqual(publishActivity({ running: "b", jobs }), { title: "正在一键分发 · 抖音", detail: "上传视频 · 洗地机实测", attention: false, done: 1, total: 3 });
const verify = publishActivity({ running: "", jobs: [{ id: "x", status: "needs_user", platform: "douyin", reason: "抖音要求本人验证", createdAt: "5" }] });
assert.equal(verify.attention, true); assert.equal(verify.detail, "抖音要求本人验证");
console.log("sprite activity self-check passed");

// 用户 2026-10-30：凡是功能都要让小玺显示进度——视频、详情图、精准获客。
const { videoActivity, videoEvents, acquisitionActivity } = require("./sprite-activity.cjs");
const { createSpriteFeeds } = require("./sprite-feeds.cjs");
assert.equal(videoActivity([{ task_id: "a", task_type: "mix_generation", status: "completed" }]), null);
assert.deepEqual(videoActivity([{ task_id: "a", task_type: "mix_generation", status: "rendering", progress: .42 }, { task_id: "b", task_type: "creative_cover", status: "queued" }]),
  { title: "正在做视频", detail: "还有 1 个在排队", done: 42, total: 100 });
assert.equal(videoActivity([{ task_id: "c", task_type: "creative_analysis", status: "analyzing", progress: 0 }]).title, "正在看你的素材");
const before = new Map([["a", "rendering"], ["b", "rendering"], ["c", "analyzing"]]);
assert.deepEqual(videoEvents(before, [{ task_id: "a", task_type: "mix_generation", status: "completed" }]), [{ text: "视频做好啦～", sub: "去成片中心看看吧", mood: "done" }]);
assert.deepEqual(videoEvents(before, [{ task_id: "c", task_type: "creative_analysis", status: "completed" }]), [], "看素材做完不算一条成片");
assert.equal(videoEvents(before, [{ task_id: "b", task_type: "creative_cover", status: "failed" }])[0].mood, "error");
assert.deepEqual(acquisitionActivity("keyword-acquisition:update", { busy: true }), { title: "正在用关键词找客户" });
assert.equal(acquisitionActivity("social-acquisition:update", { running: "" }), null);
assert.deepEqual(acquisitionActivity("map-acquisition:update", { tasks: [{ status: "running", message: "正在读取地图" }] }), { title: "正在地图上找客户", detail: "正在读取地图" });
assert.equal(acquisitionActivity("cloud:update", {}), undefined, "别的消息不管");

(async () => {
  const activities = [], lines = [];
  const sprite = { setExternalActivity: (kind, activity) => activities.push([kind, activity]), say: (line) => lines.push(line) };
  let tasks = [{ task_id: "a", task_type: "mix_generation", status: "rendering", progress: .5 }];
  let history = [{ at: "1" }];
  const feeds = createSpriteFeeds({ sprite: () => sprite, contentEngine: () => ({ listTasks: async () => ({ items: tasks }) }), productDetailHistory: () => history,
    setTimer: () => null, clearTimer: () => {} });
  feeds.start();
  await feeds.pollVideo();
  assert.deepEqual(activities.at(-1), ["video", { title: "正在做视频", detail: "", done: 50, total: 100 }]);
  tasks = [{ task_id: "a", task_type: "mix_generation", status: "completed", progress: 1 }];
  await feeds.pollVideo();
  assert.deepEqual(activities.at(-1), ["video", null]); assert.equal(lines.at(-1).text, "视频做好啦～");
  feeds.pollDetail(); assert.equal(lines.length, 1, "没有新详情图不说话");
  history = [{ at: "1" }, { at: "2" }]; feeds.pollDetail();
  assert.equal(lines.at(-1).text, "又做好一张详情图啦～");
  feeds.onRendererUpdate("map-acquisition:update", { tasks: [] });
  assert.deepEqual(activities.at(-1), ["map-acquisition", null]);
  feeds.onRendererUpdate("cloud:update", {});
  assert.deepEqual(activities.at(-1), ["map-acquisition", null], "别的消息不改小玺");
  console.log("sprite feeds self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });
