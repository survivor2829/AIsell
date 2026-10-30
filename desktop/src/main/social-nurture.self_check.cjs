const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSocialNurture } = require("./social-nurture.cjs");
const realStages = require("./social-nurture-stages.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The real stage table's numbers are checked once; the runs below use the same table with
// tiny durations so a whole day takes a fraction of a second.
assert.deepEqual(realStages.stages.map((stage) => stage.days).flat(), [1, 2, 3, 4, 5, 6, 7, 8], "8 天都有阶段");
assert.deepEqual(realStages.stages[0].likes, [0, 0], "第 1 天只看不互动");
assert.equal(realStages.stages.at(-1).publish, true, "第 8 天发测试视频");
// 用户 2026-10-30：第 1 天起就搜行业词；每天连续跑一次 30–60 分钟。
assert.ok(realStages.stages.every((stage) => stage.search), "每天都搜行业词");
assert.ok(realStages.stages.every((stage) => stage.segments[0] === 1 && stage.segments[1] === 1 && stage.minutes[0] === 30 && stage.minutes[1] === 60), "每天一次 30–60 分钟");
// Two short segments a day here, so resuming between segments is still exercised.
const stages = { ...realStages, segmentGapMinutes: [0, 0], skipDwellSeconds: [0.001, 0.001],
  stages: realStages.stages.map((stage) => ({ ...stage, segments: [2, 2], minutes: [0.004, 0.004], dwellSeconds: [0.002, 0.002] })) };

// A seeded random so the action mix is the same on every run.
function seeded(seed = 7) { let value = seed; return () => { value = (value * 1103515245 + 12345) % 2147483648; return value / 2147483648; }; }

function world(behaviour = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-nurture-"));
  const b = { signedIn: true, searchBox: true, searchBlocked: false, results: true, blockedAt: [], likeButton: true, commentShown: true, busy: false, feed: true, ...behaviour };
  const log = { launches: 0, closed: 0, searches: 0, actions: [], reports: [], signedOut: [], published: [], videos: 0, fronts: 0 };
  let offsetDays = 0, video = 0, checks = 0, justSearched = false;
  const now = () => Date.now() + offsetDays * 86_400_000;
  const page = { url: async () => "https://www.douyin.com/?recommend=1", front: async () => { log.fronts++; }, navigate: async () => {},
    send: async (method) => method === "Page.captureScreenshot" ? { data: Buffer.from("png").toString("base64") } : {} };
  const driver = {
    name: "抖音", host: "douyin.com", home: "https://www.douyin.com/?recommend=1",
    signedIn: async () => b.signedIn,
    dismissPrompts: async () => { log.prompts = (log.prompts || 0) + 1; },
    // The home page lands on a grid; the player is reached through 推荐 (2026-10-29).
    openFeed: async () => b.feed,
    blocked: async () => { checks++; return b.blockedAt.includes(checks); },
    search: async () => { log.searches++; justSearched = true; return b.searchBox; },
    openFirstResult: async () => b.results,
    // Every other video in the feed is about the plan's keyword.
    // A live room in the feed has no playing video.
    current: async () => b.liveAt?.includes(video) ? null : ({ id: `v${video}`, desc: video % 2 ? "洗地机实测" : "家常菜", author: "作者" }),
    like: async () => { if (!b.likeButton) return "missing"; log.actions.push({ kind: "likes", video, segment: log.launches }); return "done"; },
    follow: async () => { log.actions.push({ kind: "follows", video, segment: log.launches }); return "done"; },
    comment: async (_page, text) => { log.actions.push({ kind: "comments", video, text, segment: log.launches }); return b.commentShown ? "done" : "hidden"; },
    next: async () => { video++; log.videos++; }
  };
  // Only the check right after a search shows the verification.
  const searchBlocked = { ...driver, blocked: async () => { checks++; if (justSearched) { justSearched = false; return true; } return b.blockedAt.includes(checks); } };
  const accounts = {
    snapshot: () => ({ accounts: [{ id: "a1", platform: "douyin", label: "抖音号", status: "active" }, { id: "a2", platform: "kuaishou", label: "快手号", status: "active" }] }),
    profileDir: (id) => path.join(root, "profiles", id),
    markSignedOut: (id) => log.signedOut.push(id),
    lease: () => { if (b.busy) throw Object.assign(new Error("busy"), { code: "SOCIAL_ACCOUNT_BUSY" }); return () => {}; }
  };
  const launch = () => { log.launches++; checks = 0; return { close: async () => { log.closed++; } }; };
  const make = (extra = {}) => createSocialNurture({ dataDir: path.join(root, "data"), accounts, launch, executable: "chrome.exe", attach: async () => page,
    driverFor: () => (b.searchBlocked ? searchBlocked : driver), stages, now, random: seeded(), timing: { settle: 1, busyRetry: 50 },
    publish: async (payload) => { log.published.push(payload); }, onFailure: (failure) => log.reports.push(failure), ...extra });
  // Runs segments until nothing more is due today.
  const runDay = async (nurture) => { for (let i = 0; i < 20; i++) { nurture.tick(); await sleep(5); while (nurture.isBusy()) await sleep(5); } };
  return { root, b, log, make, runDay, nextDay: () => { offsetDays++; } };
}
const plan = { accountId: "a1", keywords: "洗地机", comments: "讲得很清楚\n这台效率不错" };

(async () => {
  {
    // 新建计划的检查：只接已登录的抖音账号；评论话术里有联系方式、广告字样的拒收（平台会当广告隐藏）。
    const w = world(), n = w.make();
    assert.throws(() => n.savePlan({ ...plan, accountId: "a2" }), { code: "NURTURE_ACCOUNT_REQUIRED" });
    assert.throws(() => n.savePlan({ ...plan, keywords: " " }), { code: "NURTURE_KEYWORDS_REQUIRED" });
    assert.throws(() => n.savePlan({ ...plan, comments: "需要的加我微信" }), { code: "NURTURE_COMMENT_CONTACT" });
    assert.throws(() => n.savePlan({ ...plan, comments: "电话 13800000000" }), { code: "NURTURE_COMMENT_CONTACT" });
    assert.throws(() => n.savePlan({ ...plan, testVideo: { finishedVideoId: "finished_x", title: " " } }), { code: "NURTURE_TEST_TITLE_REQUIRED" });
    n.savePlan(plan);
    assert.throws(() => n.savePlan(plan), { code: "NURTURE_ACCOUNT_TAKEN" }, "一个账号一个计划");
    await n.dispose();
  }
  {
    // 8 天走完：每天都搜关键词（第 1 天起），第 1 天只看不互动；互动只落在数量区间内、同一种不连着做；
    // 第 8 天第一段之后把测试视频交给一键分发，只交一次；8 天完成后不再运行。
    const w = world(), n = w.make();
    n.savePlan({ ...plan, testVideo: { finishedVideoId: "finished_abc", name: "成片", title: "洗地机实测" } });
    await w.runDay(n);
    let state = n.snapshot().plans[0];
    assert.equal(state.day, 1); assert.equal(state.today.segmentsDone, 2); assert.equal(w.log.searches, 2, "第 1 天也搜行业词"); assert.equal(w.log.actions.length, 0);
    assert.ok(state.today.counts.watched > 0);
    assert.equal(w.log.launches, 2, "每段单独开一次浏览器"); assert.equal(w.log.closed, 2);
    for (let day = 2; day <= 8; day++) {
      w.nextDay(); const before = w.log.actions.length;
      await w.runDay(n);
      state = n.snapshot().plans[0];
      if (day < 8) { assert.equal(state.day, day); assert.equal(state.today.segmentsDone, state.today.segments, `第 ${day} 天跑完`); }
      for (const kind of ["likes", "follows", "comments"]) assert.ok(state.today.counts[kind] <= state.today.targets[kind], `第 ${day} 天${kind}不超过当天目标`);
      const today = w.log.actions.slice(before);
      for (let i = 1; i < today.length; i++) if (today[i].video === today[i - 1].video + 1 && today[i].segment === today[i - 1].segment) assert.notEqual(today[i].kind, today[i - 1].kind, "同一段里同一种互动不连着做");
    }
    assert.ok(w.log.actions.some((action) => action.kind === "likes") && w.log.actions.some((action) => action.kind === "comments"));
    assert.equal(w.log.actions.filter((action) => action.kind === "comments").every((action) => ["讲得很清楚", "这台效率不错"].includes(action.text)), true);
    assert.deepEqual(w.log.published, [{ accountId: "a1", finishedVideoId: "finished_abc", name: "成片", title: "洗地机实测" }]);
    assert.equal(state.status, "finished");
    const launches = w.log.launches; w.nextDay(); await w.runDay(n);
    assert.equal(w.log.launches, launches, "完成后不再运行");
    // 重启后进度还在。
    await n.dispose();
    const again = w.make();
    assert.equal(again.snapshot().plans[0].status, "finished"); assert.equal(again.snapshot().plans[0].seen, undefined, "看过的视频列表不发给界面");
    await again.dispose();
  }
  {
    // 搜索时弹验证码：这个计划以后改刷推荐页，只和带关键词的视频互动，并上报一次。
    const w = world({ searchBlocked: true }), n = w.make();
    n.savePlan(plan); await w.runDay(n); w.nextDay(); await w.runDay(n);
    const state = n.snapshot().plans[0];
    assert.equal(state.mode, "feed");
    assert.equal(w.log.reports.filter((report) => report.code === "NURTURE_SEARCH_BLOCKED").length, 1);
    assert.equal(w.log.searches, 1, "改刷推荐页后不再搜索");
    assert.ok(w.log.actions.length > 0 && w.log.actions.every((action) => action.video % 2 === 1), "只和带关键词的视频互动");
    await n.dispose();
  }
  {
    // 看视频时平台要求验证：这一段停下、窗口弹到前面、上报；当天第 2 次就停到明天。
    const w = world({ blockedAt: [3] }), n = w.make();
    n.savePlan(plan); await w.runDay(n);
    let state = n.snapshot().plans[0];
    assert.equal(state.today.anomalies, 2, "两段各遇到一次"); assert.ok(state.today.restUntil > Date.now(), "停到明天");
    assert.equal(state.today.segmentsDone, 0, "被打断的段不算完成"); assert.equal(w.log.fronts, 2);
    assert.equal(w.log.reports.filter((report) => report.code === "NURTURE_VERIFICATION").length, 2);
    // 第二天重新做第 1 天，不跳天。
    w.b.blockedAt = []; w.nextDay(); await w.runDay(n);
    state = n.snapshot().plans[0];
    assert.equal(state.day, 1); assert.equal(state.today.segmentsDone, 2);
    await n.dispose();
  }
  {
    // 评论发出后在评论区看不到：当天停评论并上报；页面上找不到点赞按钮：这一段不再点赞，并上报一次。
    const w = world({ commentShown: false, likeButton: false }), n = w.make();
    n.savePlan(plan); await w.runDay(n);
    const perDay = [];
    for (let day = 2; day <= 7; day++) {
      w.nextDay(); const before = w.log.actions.filter((action) => action.kind === "comments").length;
      await w.runDay(n);
      const sent = w.log.actions.filter((action) => action.kind === "comments").length - before;
      perDay.push(sent);
      if (sent) assert.equal(n.snapshot().plans[0].today.commentsOff, true);
    }
    assert.ok(perDay.every((sent) => sent <= 1) && perDay.some((sent) => sent === 1), `第一条被隐藏后当天不再评论 ${perDay}`);
    assert.ok(w.log.reports.some((report) => report.code === "NURTURE_COMMENT_HIDDEN"));
    const missing = w.log.reports.filter((report) => report.code === "NURTURE_ELEMENT_MISSING" && report.step === "likes");
    assert.ok(missing.length >= 1 && missing.every((report) => report.screenshot), "缺的页面元素带截图上报");
    await n.dispose();
  }
  {
    // 抖音需要重新登录：计划暂停、账号标成需要登录；账号被一键分发占着：稍后再试，不算失败。
    const w = world({ signedIn: false }), n = w.make();
    n.savePlan(plan); await w.runDay(n);
    let state = n.snapshot().plans[0];
    assert.equal(state.status, "paused"); assert.match(state.reason, /重新扫码登录/); assert.deepEqual(w.log.signedOut, ["a1"]);
    assert.equal(w.log.launches, 1, "暂停后不再反复打开");
    n.setEnabled(state.id, true); w.b.signedIn = true; w.b.busy = true;
    await w.runDay(n);
    state = n.snapshot().plans[0];
    assert.equal(state.status, "active"); assert.equal(state.today.segmentsDone, 0); assert.equal(w.log.launches, 1);
    w.b.busy = false; await sleep(60); await w.runDay(n);
    assert.equal(n.snapshot().plans[0].today.segmentsDone, 2);
    await n.dispose();
  }
  {
    // 用户 2026-10-29：不要固定开始时间。保存就立刻跑第一段；段间照阶段表休息，也可以点「现在就跑下一段」。
    const w = world();
    const n = w.make({ stages: { ...stages, segmentGapMinutes: [30, 30] } });
    n.savePlan(plan);
    await sleep(10); while (n.isBusy()) await sleep(5);
    let state = n.snapshot().plans[0];
    assert.equal(state.today.segmentsDone, 1, "保存后立刻跑了第一段");
    assert.equal(state.phase, "resting"); assert.ok(state.today.nextAt > Date.now() + 25 * 60_000, "下一段约半小时后");
    assert.equal(state.lastSegment.outcome, "completed"); assert.match(state.lastSegment.text, /这一段完成/);
    assert.ok(w.log.prompts >= 1, "打开页面后先关掉抖音自己的弹窗");
    n.runNow(state.id);
    await sleep(10); while (n.isBusy()) await sleep(5);
    state = n.snapshot().plans[0];
    assert.equal(state.today.segmentsDone, 2, "现在就跑下一段");
    assert.equal(state.phase, "done_today");
    // 用户 2026-10-30：想什么时候跑就什么时候跑。今天做完了、关掉了、验证后休息，点「现在就跑」都照跑。
    n.runNow(state.id);
    assert.ok(n.isBusy(), "今天做完了也能马上再跑");
    await sleep(10); while (n.isBusy()) await sleep(5);
    state = n.snapshot().plans[0];
    assert.equal(state.today.segmentsDone, 3); assert.equal(state.lastSegment.outcome, "completed");
    n.setEnabled(state.id, false);
    n.runNow(state.id);
    await sleep(10); while (n.isBusy()) await sleep(5);
    state = n.snapshot().plans[0];
    assert.equal(state.enabled, true, "关掉的计划点「现在就跑」会重新打开"); assert.equal(state.today.segmentsDone, 4);
    await n.dispose();
  }
  {
    // 现场包 629208b3（2026-10-29）：抖音首页跳到「精选」宫格，找不到可以逐条刷的视频，Chrome 弹出来又关掉、显示「等待中」。
    // 现在：上报一次，2 分钟后再试一次；还不行就暂停并写清原因，不再反复弹窗口。
    // 第 1 天起先搜索；搜不到结果才回到推荐页，这里推荐页也找不到。
    const w = world({ feed: false, results: false }), n = w.make({ timing: { settle: 1, busyRetry: 50, earlyRetry: 30 } });
    n.savePlan(plan);
    await sleep(10); while (n.isBusy()) await sleep(5);
    let state = n.snapshot().plans[0];
    assert.equal(state.lastSegment.outcome, "page_changed"); assert.match(state.lastSegment.text, /2 分钟后再试一次/);
    assert.equal(state.status, "active");
    await sleep(40); await w.runDay(n);
    state = n.snapshot().plans[0];
    assert.equal(state.status, "paused"); assert.match(state.reason, /已自动上报/);
    assert.equal(w.log.launches, 2, "只再试一次");
    assert.equal(w.log.reports.filter((report) => report.code === "NURTURE_ELEMENT_MISSING" && report.step === "feed").length, 2);
    // 修好后点「继续」：重新开始尝试。
    w.b.feed = true; n.setEnabled(state.id, true); await w.runDay(n);
    assert.equal(n.snapshot().plans[0].today.segmentsDone, 2);
    await n.dispose();
  }
  {
    // 现场包 68fd8773（2026-10-30）：推荐页刷到直播间，认不出正在播放的视频，这一段几分钟就停了。
    // 现在：划到下一条接着刷，这一段照常跑完，不上报；一连好几条都认不出才算页面变了。
    const w = world({ liveAt: [2, 5, 6] }), n = w.make({ timing: { settle: 1 } });
    n.savePlan(plan);
    await sleep(10); while (n.isBusy()) await sleep(5);
    let state = n.snapshot().plans[0];
    assert.equal(state.lastSegment.outcome, "completed", "遇到直播间跳过，这一段照常跑完");
    assert.equal(w.log.reports.filter((report) => report.step === "player").length, 0);
    await n.dispose();
    const v = world({ liveAt: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }), m = v.make({ timing: { settle: 1 } });
    m.savePlan(plan);
    await sleep(10); while (m.isBusy()) await sleep(5);
    state = m.snapshot().plans[0];
    assert.equal(state.lastSegment.outcome, "page_changed"); assert.equal(v.log.reports.filter((report) => report.step === "player").length, 1);
    await m.dispose();
  }
  console.log("social nurture self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });
