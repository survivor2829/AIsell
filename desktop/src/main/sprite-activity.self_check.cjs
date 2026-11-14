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

// SOP：耗时功能必须接桌宠。主进程新发一种进度消息而没有登记时，这里不通过。
{
  const fs = require("node:fs"), path = require("node:path");
  const { productDetailActivity, productDetailEvent, serviceActivity, pushedActivity, SPRITE_FEATURES, SPRITE_NOT_WORK, SPRITE_COMPUTED_SENDERS } = require("./sprite-activity.cjs");
  const { createSpriteFeeds } = require("./sprite-feeds.cjs");
  assert.equal(productDetailActivity({ state: "pending", task: { status: "running_planner", progress_msg: "DeepSeek (v2) 分析产品文案..." } }).title, "正在琢磨这款产品的卖点");
  assert.deepEqual(productDetailActivity({ state: "pending", task: { status: "running_generator", progress_msg: "已就绪 2/15 张", planned_count: 15, success_count: 2 } }),
    { title: "正在画第 3/15 张详情图", detail: "一张一张认真画", done: 2, total: 15 });
  assert.equal(productDetailActivity({ state: "pending", task: { status: "running_generator", progress_msg: "已就绪 15/15 张, 开始拼装长图..." } }).title, "正在把详情图拼成长图");
  assert.equal(productDetailActivity({ state: "pending", task: { status: "running_assembler", progress_msg: "Playwright 截图中..." } }).title, "正在把详情图拼成长图");
  assert.equal(productDetailActivity({ state: "pending", task: { status: "running_generator", progress_msg: "AI 精修 v2 中 5/15" } }).title, "正在画第 6/15 张详情图", "真实的进度文字");
  assert.equal(productDetailActivity({ state: "pending", task: { status: "running_generator", progress_msg: "开始生成 6 张 AI 精修图..." } }).title, "开始动笔画详情图啦", "总数未知时不编数字");
  assert.equal(productDetailActivity({ state: "success", task: { status: "success" } }), null);
  assert.equal(productDetailActivity({ state: "outcome_unknown", task: {} }), null, "结果不明要客户处理，不能一直显示还在干活");
  assert.match(productDetailEvent({ title: "x" }, { state: "outcome_unknown" }).text, /不确定/, "结果不明不说成完成");
  assert.equal(productDetailActivity({ state: "running_generator", task: { status: "running_generator", progress_msg: "只重做第 3 张，其余图片沿用", planned_count: 15, success_count: 15 } }).title, "正在重画这一张详情图", "单张重做不显示整套张数");
  assert.equal(productDetailEvent({ title: "x" }, { state: "failed" }).mood, "error");
  assert.equal(productDetailEvent(null, { state: "failed" }), null, "只有刚才还在做的任务才报失败，重启后不重复报");
  assert.equal(pushedActivity("geo:update", { busy: "writing" }).title, "正在写 GEO 文章");
  assert.equal(pushedActivity("geo:update", { busy: "" }), null);
  assert.equal(pushedActivity("digital-human:viral-pipeline", { items: [{ status: "running", progress: 40, message: "生成本人口播" }] }).done, 40);
  assert.equal(pushedActivity("digital-human:viral-progress", { stage: "done" }), null);
  assert.equal(serviceActivity("x", [{ status: "completed" }, { status: "draft" }, { status: "preview_ready" }, { status: "some_future_wait" }]), null, "等客户确认的不算在干活");
  assert.equal(pushedActivity("moments-publish:update", { status: "publishing" }).title, "正在发朋友圈");
  assert.equal(pushedActivity("moments-publish:update", { status: "outcome_unknown" }), null, "结果不明不显示成还在发");
  assert.equal(pushedActivity("moments-campaign:update", { status: "running", current_post: 3 }).detail, "第 3 条");
  assert.equal(serviceActivity("正在做场景效果视频", [{ status: "generating", statusLabel: "生成镜头", progress: 30 }]).detail, "生成镜头");
  for (const row of SPRITE_FEATURES) if (row.channel) assert.notEqual(pushedActivity(row.channel, {}), undefined, row.feature + " 登记了消息却没有处理");
  const registered = new Set(SPRITE_FEATURES.map((row) => row.channel).filter(Boolean));
  const sent = new Set(), computed = new Set();
  for (const name of fs.readdirSync(__dirname)) {
    if (!name.endsWith(".cjs") || name.includes("self_check")) continue;
    const source = fs.readFileSync(path.join(__dirname, name), "utf8");
    for (const match of source.matchAll(/(?:webContents|sender)\??\.send\(\s*['"`]([^'"`$]+)['"`]/g)) sent.add(match[1]);
    if (/(?:webContents|sender)\??\.send\(\s*(?!['"`][^'"`$]+['"`])/.test(source)) computed.add(name);
  }
  // A channel name built at run time cannot be read here, so those files have to be looked at and listed by hand.
  assert.deepEqual([...computed].filter((name) => !SPRITE_COMPUTED_SENDERS.has(name)), [], "这个文件用变量当进度消息名，请确认已接桌宠后加入 SPRITE_COMPUTED_SENDERS");
  const unknown = [...sent].filter((channel) => !registered.has(channel) && !SPRITE_NOT_WORK.has(channel));
  assert.deepEqual(unknown, [], "新的进度消息要在 sprite-activity.cjs 的 SPRITE_FEATURES 里登记，或说明不算干活（SPRITE_NOT_WORK）");
  console.log("sprite feature registry self-check passed");
  (async () => {
    const calls = []; let report = { state: "running_planner", task: { status: "running_planner" } };
    const feeds = createSpriteFeeds({ sprite: () => ({ setExternalActivity: (kind, activity) => calls.push([kind, activity]), say() {} }), productDetailStatus: async () => report, setTimer: () => 0, clearTimer() {} });
    await feeds.pollDetailActivity();
    assert.ok(calls.at(-1)[1], "在干活时显示进度");
    report = null;
    await feeds.pollDetailActivity();
    assert.ok(calls.at(-1)[1], "偶尔读不到不清掉");
    await feeds.pollDetailActivity(); await feeds.pollDetailActivity();
    assert.equal(calls.at(-1)[1], null, "详情图服务一直读不到时，气泡不能停在旧进度上");
  })();
}
