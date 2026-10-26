const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DRIVERS, acquireDriverFor, intentOf, TOO_FREQUENT } = require("./social-acquire-drivers.cjs");
const { createSocialAcquisition } = require("./social-acquisition.cjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 快手数据解析：搜索结果和评论（字段形状来自快手网页版，内容是编的）。
const ks = DRIVERS.kuaishou;
const search = ks.parseSearch({ pcursor: "1", feeds: [
  { photo: { id: "3xabc123def", caption: "洗地机怎么选  #洗地机", likeCount: 288, commentCount: "1.2万", timestamp: 1786966694251 }, author: { id: "3xauthor01", name: "清洁小王" } },
  { photo: { id: "../evil" }, author: {} }
] });
assert.equal(search.videos.length, 1, "不合法的视频 id 丢弃");
assert.deepEqual({ ...search.videos[0], publishedAt: undefined }, { id: "3xabc123def", title: "洗地机怎么选 #洗地机", authorId: "3xauthor01", authorName: "清洁小王", likes: 288, comments: 1.2, publishedAt: undefined });
assert.equal(search.more, true);
const comments = ks.parseComments({ data: { visionCommentList: { pcursorV2: "no_more", rootCommentsV2: [
  { commentId: "1186072377318", authorId: "3xbuyer01", authorName: "买家A", content: "这个多少钱", timestamp: 1791930655532 },
  { commentId: "x", authorId: "3xbad", content: "id 不对" },
  { commentId: "1186072377319", authorId: "3xbuyer02", authorName: "路人", content: "  " }
] } } });
assert.equal(comments.comments.length, 1, "评论 id 不对或内容为空的丢弃");
assert.equal(comments.comments[0].text, "这个多少钱"); assert.equal(comments.more, false);
assert.ok(ks.isComments("https://www.kuaishou.com/graphql", "commentListQuery"));
assert.ok(!ks.isComments("https://www.kuaishou.com/graphql", "visionShortVideoReco"));
assert.ok(ks.isSearch("https://www.kuaishou.com/rest/v/search/feed"));

// 意向识别：内置几类说法 + 用户自己加的词。
assert.deepEqual(intentOf("你这这个洗地机多少钱"), ["询价"]);
assert.deepEqual(intentOf("我也想买，有没有推荐的"), ["想买"]);
assert.deepEqual(intentOf("真的好用吗"), ["问效果"]);
assert.deepEqual(intentOf("非常不错哦"), []);
// 实测里混进来的夸赞式评论：提到价格、电话、用过，但没在问。
assert.deepEqual(intentOf("之前用过的那些一扯就断，这个看着就扎实，价格也能接受，冲了冲了。"), []);
assert.deepEqual(intentOf("开会时接的电话也没耽误，关键是这个价格让我有点意外"), []);
assert.deepEqual(intentOf("这价格真合适"), []);
assert.deepEqual(intentOf("价格多少？留个电话"), ["询价", "要联系"]);
assert.deepEqual(intentOf("有买过的吗？效果怎么样"), ["问效果"]);
assert.deepEqual(intentOf("能租吗", ["租"]), ["含「租」"]);
// 在页面上找线索的那条评论：页面上的昵称会在表情后多出空格（实测「🍀 吃货芸姐🪷 」）。
{
  const item = (name, said) => ({ querySelector: (selector) => ({ textContent: selector === ".author-name" ? name : said }) });
  const items = [item("别人", " 我也想买，有没有推荐的 "), item("🍀 吃货芸姐🪷 ", " 我也想买，有没有推荐的 ")], document = { querySelectorAll: () => items };
  const found = new Function("document", `return ${ks.actions.commentItem("🍀吃货芸姐🪷", "我也想买，有没有推荐的")};`)(document);
  assert.equal(found, items[1]);
  assert.equal(new Function("document", `return ${ks.actions.commentItem("🍀吃货芸姐🪷", "别的话")};`)(document), undefined);
}
// 抖音网页搜索会拦截软件控制的浏览器：列出来但不可用，不绕过。
assert.throws(() => acquireDriverFor("douyin"), { code: "ACQUIRE_PLATFORM_UNAVAILABLE" });

function world({ captchaPolls = 0, loggedOut = false, hang = false, act = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-acquire-"));
  const log = { launches: 0, closed: 0, navigations: [], fronts: 0, leases: 0, released: 0, wheels: 0, clicks: [], typed: [] };
  // How the platform behaves for likes, follows and comments in this world.
  const ui = { liked: false, like: "ok", follow: "ok", comment: "ok", followLabel: "关注", covered: false, boxValue: "", target: "", shown: true, closedNote: "", posted: [], ...act };
  let captchaLeft = captchaPolls, emitJson = null, pending = null, previous = "", hung = null;
  const hour = 3_600_000, nowMs = Date.parse("2026-10-26T12:00:00Z"), started = Date.now();
  const commentsFor = (id) => ({ data: { visionCommentList: { pcursorV2: "no_more", rootCommentsV2: [
    { commentId: `1${id.length}00000001`, authorId: "3xbuyer01", authorName: "买家A", content: "这个多少钱", timestamp: nowMs - hour },
    { commentId: `1${id.length}00000002`, authorId: id.endsWith("1") ? "3xauthor01" : "3xauthor02", authorName: "作者本人", content: "多少钱私信我", timestamp: nowMs - hour },
    { commentId: `1${id.length}00000003`, authorId: "3xold", authorName: "很久以前", content: "怎么买", timestamp: nowMs - 100 * 24 * hour },
    { commentId: `1${id.length}00000004`, authorId: "3xchat", authorName: "路人", content: "拍得真好", timestamp: nowMs - hour },
    // Our own comments, when the platform shows them.
    ...ui.posted.filter((item) => item.videoId === id && ui.shown).map((item, i) => ({ commentId: `19000000${i}`, authorId: "3xme", authorName: "我", content: item.text, timestamp: nowMs }))
  ] } } });
  // The page's data only arrives once a verification is done, and never on a logged-out page.
  const deliver = (url) => {
    if (loggedOut) return;
    if (url.includes("/search/")) emitJson({ url: "https://www.kuaishou.com/rest/v/search/feed", operation: "", json: { pcursor: "no_more", feeds: [
      { photo: { id: "3xvideo0001", caption: "洗地机测评", timestamp: nowMs }, author: { id: "3xauthor01", name: "作者本人" } },
      { photo: { id: "3xvideo0002", caption: "洗地机推荐", timestamp: nowMs }, author: { id: "3xauthor02", name: "作者二" } }] } });
    else {
      const id = url.split("/").pop();
      // A late second page from the previous video arrives first and must not be credited to this one.
      if (previous) emitJson({ url: "https://www.kuaishou.com/graphql", operation: "commentListQuery", variables: { photoId: "3xelsewhere" }, json: { data: { visionCommentList: { pcursorV2: "no_more", rootCommentsV2: [
        { commentId: "1999", authorId: "3xlate", authorName: "别的视频", content: "多少钱", timestamp: nowMs - hour }] } } } });
      emitJson({ url: "https://www.kuaishou.com/graphql", operation: "commentListQuery", variables: { photoId: id }, json: commentsFor(id) });
      previous = id;
    }
  };
  const page = {
    navigate: async (url) => {
      log.navigations.push(url);
      // Like the real browser, closing it ends a call that is still waiting.
      if (hang) return new Promise((_resolve, reject) => { hung = reject; });
      if (captchaLeft > 0) pending = url; else setImmediate(() => deliver(url));
    },
    // Captions and comments can mention 滑块; that alone is not a verification.
    evaluate: async (expression) => {
      if (expression.includes("captcha")) { if (captchaLeft > 0 && --captchaLeft === 0 && pending) setImmediate(() => deliver(pending)); return captchaLeft > 0; }
      // The element under the pointer: only the target itself counts, unless something covers it.
      if (expression.includes("elementFromPoint")) { ui.target = expression.includes("likeicon") ? "like" : expression.includes("follow-btn") ? "follow" : expression.includes("submit-button") ? "comment" : ""; return ui.covered ? null : { x: 10, y: 20 }; }
      if (expression.includes("scrollIntoView({ block:")) return true;
      if (expression.includes("classList.contains")) return ui.liked;
      if (expression.includes(".follow-btn") && expression.includes("textContent")) return ui.followLabel;
      if (expression.includes(".follow-btn")) return true;
      if (expression.includes(".comment-item-content") && expression.includes("some(")) return false;
      if (expression.startsWith("Boolean(") && expression.includes("comment-list-item")) return true;
      if (expression.includes("scrollIntoView({ block: \"end\" })")) return undefined;
      return loggedOut ? "登录即可享受" : "洗地机 拖动滑块就能拆下水箱";
    },
    // A click answers the way the platform does; "silent" never answers, "frequent" refuses.
    mouse: async () => {
      const kind = ui.target; log.clicks.push(kind);
      const answer = (url, operation, json, variables = {}) => setImmediate(() => emitJson({ url, operation, variables, json }));
      if (kind === "like" && ui.like === "ok") { ui.liked = true; answer("https://www.kuaishou.com/graphql", "visionLikeComment", { data: { visionLikeComment: { result: 1 } } }, { commentId: ui.commentId || "" }); }
      if (kind === "like" && ui.like === "frequent") answer("https://www.kuaishou.com/graphql", "visionLikeComment", { data: { visionLikeComment: { result: 2, error_msg: "操作太频繁，请稍后再试" } } });
      if (kind === "follow" && ui.follow === "ok") { ui.followLabel = "已关注"; answer("https://www.kuaishou.com/rest/v/relation/follow", "", { result: 1, followStatus: 1 }); }
      if (kind === "comment" && ui.comment === "ok") ui.posted.push({ videoId: previous, text: ui.boxValue });
      if (kind === "comment" && ui.comment === "ok") answer("https://www.kuaishou.com/graphql", "visionAddComment", { data: { visionAddComment: { result: 1 } } });
    },
    find: async () => ({ localName: "textarea" }),
    call: async () => ui.closedNote,
    type: async (_node, value) => { log.typed.push(value); ui.boxValue = value; },
    valueOf: async () => ui.boxValue,
    front: async () => { log.fronts++; },
    send: async (method) => { if (method === "Input.dispatchMouseEvent") log.wheels++; }
  };
  const browser = { send: async (method) => method === "Target.createTarget" ? { targetId: "t" } : method === "Target.attachToTarget" ? { sessionId: "s" } : {}, close: async () => { log.closed++; hung?.(Object.assign(new Error("closed"), { code: "SOCIAL_BROWSER_CLOSED" })); } };
  const accounts = {
    snapshot: () => ({ accounts: [{ id: "ks1", platform: "kuaishou", label: "快手号", status: "active" }] }),
    profileDir: () => path.join(root, "profile"),
    lease: () => { log.leases++; return () => { log.released++; }; }
  };
  const make = () => createSocialAcquisition({ dataDir: path.join(root, "data"), accounts, executable: "chrome.exe", now: () => nowMs + (Date.now() - started),
    launch: () => { log.launches++; return browser; }, makePage: () => page,
    capture: (_browser, _session, { match, onJson }) => { emitJson = (event) => { if (match(event.url, event.operation)) onJson(event); }; return { start: async () => {} }; },
    timing: { response: 200, verify: 5000, poll: 2, gapMin: 1, gapMax: 2, actionGapMin: 1, actionGapMax: 2, commentGapMin: 1, commentGapMax: 2, scroll: 1, recheck: 1 } });
  const until = async (acq) => { for (let i = 0; i < 500; i++) { if (!acq.snapshot().running) return acq.snapshot(); await sleep(5); } throw new Error("timeout"); };
  // Leads as a finished run leaves them, found by the account ks1.
  const seed = (names) => {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    const leads = names.map((name, i) => ({ id: `lead${i}`, taskId: "t", platform: "kuaishou", accountId: "ks1", keyword: "洗地机", videoId: `3xvideo000${i + 1}`, videoTitle: "洗地机测评", videoUrl: `https://www.kuaishou.com/short-video/3xvideo000${i + 1}`, videoAuthor: "作者",
      commentId: `11800000000${i}`, userId: `3xbuyer0${i}`, userName: name, comment: "这个多少钱", commentAt: "", region: "", signals: ["询价"], status: "new", createdAt: "" }));
    fs.writeFileSync(path.join(root, "data", "state.json"), JSON.stringify({ version: 1, tasks: [], runs: [], leads }));
  };
  return { root, log, ui, make, until, seed };
}

(async () => {
  {
    // 正常跑一轮：只收有意向的评论；作者自己的回复、超出时间范围的、没意向的都不收；同一个人只算一条线索。
    const w = world(), acq = w.make();
    acq.saveTask({ platform: "kuaishou", accountId: "ks1", keywords: "洗地机\n洗地机", days: 30, maxVideos: 5 });
    const task = acq.snapshot().tasks[0];
    assert.deepEqual(task.keywords, ["洗地机"], "重复关键词合并");
    acq.start(task.id);
    const state = await w.until(acq);
    const run = state.runs[0];
    assert.equal(run.status, "done", run.reason);
    assert.equal(run.videos, 2);
    assert.equal(state.leads.length, 1, "同一个人在两个视频下都问价，只算一条线索；上一个视频迟到的评论不算");
    assert.equal(run.status, "done"); assert.equal(w.log.fronts, 0, "标题里有「滑块」不当成验证");
    assert.equal(state.leads[0].userName, "买家A"); assert.deepEqual(state.leads[0].signals, ["询价"]);
    assert.equal(state.leads[0].videoUrl, "https://www.kuaishou.com/short-video/3xvideo0001");
    assert.ok(w.log.navigations.every((url) => url.startsWith("https://www.kuaishou.com/")), "只打开快手自己的页面");
    assert.deepEqual([w.log.launches, w.log.closed, w.log.released], [1, 1, 2], "浏览器关闭、账号释放");
    // 导出的表格：带 BOM、加引号、公式开头的内容被中和。
    acq.setLead(state.leads[0].id, "contacted");
    const csv = acq.csv();
    assert.ok(csv.startsWith("﻿")); assert.match(csv, /"买家A","这个多少钱","询价"/); assert.match(csv, /已联系/);
    assert.throws(() => acq.setLead(state.leads[0].id, "bogus"), { code: "ACQUIRE_LEAD_STATUS" });
    await acq.dispose();
  }
  {
    // 平台弹验证：暂停、把窗口切到前面，等用户点完后继续。
    const w = world({ captchaPolls: 3 }), acq = w.make();
    acq.saveTask({ platform: "kuaishou", accountId: "ks1", keywords: "洗地机", days: 30, maxVideos: 5 });
    const seen = new Set(); const timer = setInterval(() => { const run = acq.snapshot().runs[0]; if (run) seen.add(run.status); }, 1);
    acq.start(acq.snapshot().tasks[0].id);
    const state = await w.until(acq); clearInterval(timer);
    assert.ok(seen.has("needs_user"), "验证期间显示等你验证"); assert.equal(w.log.fronts, 1);
    assert.equal(state.runs[0].status, "done");
    await acq.dispose();
  }
  {
    // 停下时直接关浏览器，不等卡住的页面；记录是「已停下」而不是出错。
    const w = world({ hang: true }), acq = w.make();
    acq.saveTask({ platform: "kuaishou", accountId: "ks1", keywords: "洗地机", days: 30, maxVideos: 5 });
    acq.start(acq.snapshot().tasks[0].id);
    for (let i = 0; i < 100 && !w.log.navigations.length; i++) await sleep(2);
    acq.stop();
    const state = await w.until(acq);
    assert.equal(state.runs[0].status, "stopped"); assert.ok(w.log.closed >= 1); assert.equal(w.log.released, 2);
    await acq.dispose();
  }
  {
    // 网页版没登录：停下并说清楚，不硬跑。
    const w = world({ loggedOut: true }), acq = w.make();
    acq.saveTask({ platform: "kuaishou", accountId: "ks1", keywords: "洗地机", days: 30, maxVideos: 5 });
    acq.start(acq.snapshot().tasks[0].id);
    const state = await w.until(acq);
    assert.equal(state.runs[0].status, "failed"); assert.match(state.runs[0].reason, /重新扫码登录/);
    await acq.dispose();
  }
  {
    // 提交前的检查；重启后运行中的记录变成已停下，线索保留。
    const w = world(), acq = w.make();
    assert.throws(() => acq.saveTask({ platform: "douyin", accountId: "ks1", keywords: "a" }), { code: "ACQUIRE_PLATFORM_UNAVAILABLE" });
    assert.throws(() => acq.saveTask({ platform: "kuaishou", accountId: "nobody", keywords: "a" }), { code: "ACQUIRE_ACCOUNT_REQUIRED" });
    assert.throws(() => acq.saveTask({ platform: "kuaishou", accountId: "ks1", keywords: " " }), { code: "ACQUIRE_KEYWORDS_REQUIRED" });
    await acq.dispose();
    const dataDir = path.join(w.root, "data"), file = path.join(dataDir, "state.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.runs.unshift({ id: "r1", taskId: "t", status: "running", detail: "", videos: 1, comments: 1, leads: 1, reason: "", startedAt: "", finishedAt: "" });
    fs.writeFileSync(file, JSON.stringify(saved));
    assert.equal(w.make().snapshot().runs[0].status, "stopped");
    fs.writeFileSync(file, "{broken");
    assert.throws(() => w.make(), { code: "ACQUIRE_STATE_INVALID" });
    assert.equal(fs.readFileSync(file, "utf8"), "{broken", "损坏的记录保留原样");
    fs.rmSync(w.root, { recursive: true, force: true });
  }
  {
    // 点赞 + 关注：排进队后自动开始；平台确认后才算完成，并计入今天的用量。
    const w = world(); w.seed(["买家A"]); const acq = w.make();
    assert.equal(acq.queueActions({ leadIds: ["lead0"], kinds: ["like", "follow"] }).added, 2);
    const state = await w.until(acq);
    assert.deepEqual(state.actions.map((action) => [action.kind, action.status]).sort(), [["follow", "done"], ["like", "done"]]);
    assert.ok(state.actions.every((action) => action.clickedAt), "点之前先记下");
    assert.deepEqual(w.log.clicks.sort(), ["follow", "like"]);
    assert.deepEqual([state.today.ks1.like, state.today.ks1.follow], [1, 1]);
    assert.equal(state.runs[0].kind, "actions"); assert.equal(state.runs[0].sent, 2);
    assert.ok(w.log.navigations.includes("https://www.kuaishou.com/profile/3xbuyer00"));
    assert.equal(acq.queueActions({ leadIds: ["lead0"], kinds: ["like", "follow"] }).added, 0, "做过的不再做");
    assert.match(acq.csv(), /"已完成","已完成"/);
    await acq.dispose();
  }
  {
    // 已经点过赞的评论不再点（再点一次会取消点赞），也不占今天的用量。
    const w = world({ act: { liked: true, followLabel: "已关注" } }); w.seed(["买家A"]); const acq = w.make();
    acq.queueActions({ leadIds: ["lead0"], kinds: ["like", "follow"] });
    const state = await w.until(acq);
    assert.deepEqual(w.log.clicks, [], "一次都没点");
    assert.ok(state.actions.every((action) => action.status === "done" && action.already));
    assert.deepEqual([state.today.ks1.like, state.today.ks1.follow], [0, 0]);
    await acq.dispose();
  }
  {
    // 点了但平台没回应：标「结果不明」，不自动重做；用户看过之后再标结果。
    const w = world({ act: { like: "silent" } }); w.seed(["买家A"]); const acq = w.make();
    acq.queueActions({ leadIds: ["lead0"], kinds: ["like"] });
    let state = await w.until(acq);
    const action = state.actions[0];
    assert.equal(action.status, "unknown"); assert.equal(w.log.clicks.length, 1);
    assert.equal(acq.queueActions({ leadIds: ["lead0"], kinds: ["like"] }).added, 0, "结果不明的不会再排进去");
    assert.throws(() => acq.resolveAction(action.id, "maybe"), { code: "ACQUIRE_ACTION_OUTCOME" });
    state = acq.resolveAction(action.id, "failed");
    assert.equal(state.actions[0].status, "failed");
    assert.throws(() => acq.resolveAction(action.id, "done"), { code: "ACQUIRE_ACTION_SETTLED" });
    await acq.dispose();
  }
  {
    // 平台提示频繁：这个账号停到明天，被拒的动作留在队里，明天再做；今天点「继续」也不会开始。
    const w = world({ act: { like: "frequent" } }); w.seed(["买家A", "买家B"]); const acq = w.make();
    acq.queueActions({ leadIds: ["lead0", "lead1"], kinds: ["like"] });
    const state = await w.until(acq);
    assert.equal(w.log.clicks.length, 1, "第一次被拒后就停");
    assert.ok(state.actions.every((action) => action.status === "queued" && !action.clickedAt));
    assert.ok(state.today.ks1.pausedUntil); assert.match(state.runs[0].reason, /频繁/);
    assert.equal(acq.resume().running, "", "今天不会再开始");
    await acq.dispose();
  }
  {
    // 每天上限：到了就停，剩下的留着；按钮被挡住时不点。
    const w = world(); w.seed(["买家A", "买家B"]); const acq = w.make();
    acq.saveCaps({ like: 1, follow: 999 });
    assert.equal(acq.snapshot().caps.follow, 100, "上限不能超过允许的最大值");
    acq.queueActions({ leadIds: ["lead0", "lead1"], kinds: ["like"] });
    const state = await w.until(acq);
    assert.deepEqual(state.actions.map((action) => action.status).sort(), ["done", "queued"]);
    assert.match(state.runs[0].reason, /上限/);
    await acq.dispose();
    const covered = world({ act: { covered: true } }); covered.seed(["买家A"]); const blocked = covered.make();
    blocked.queueActions({ leadIds: ["lead0"], kinds: ["like"] });
    const after = await covered.until(blocked);
    assert.equal(after.actions[0].status, "failed"); assert.deepEqual(covered.log.clicks, []); assert.match(after.actions[0].reason, /挡住/);
    await blocked.dispose();
  }
  {
    // 同行视频留言已下线：以前存下的留言任务和记录留在文件里，但不再显示、不能运行。
    const w = world(); w.seed(["买家A"]);
    const seeded = path.join(w.root, "data", "state.json"), old = JSON.parse(fs.readFileSync(seeded, "utf8"));
    old.tasks = [{ id: "c1", mode: "comment", name: "旧留言任务", platform: "kuaishou", accountId: "ks1", keywords: ["洗地机"], texts: ["厂家直供"] }];
    old.actions = [{ id: "m1", kind: "comment", platform: "kuaishou", accountId: "ks1", target: { videoId: "v", text: "厂家直供" }, status: "hidden", clickedAt: "2026-10-26T10:00:00Z", reason: "" }];
    fs.writeFileSync(seeded, JSON.stringify(old));
    const acq = w.make(), shown = acq.snapshot();
    assert.deepEqual([shown.tasks.length, shown.actions.length, shown.caps.comment], [0, 0, undefined]);
    assert.throws(() => acq.start("c1"), { code: "ACQUIRE_TASK_RETIRED" });
    assert.throws(() => acq.saveTask({ id: "c1", platform: "kuaishou", accountId: "ks1", keywords: "洗地机" }), { code: "ACQUIRE_TASK_RETIRED" });
    assert.equal(JSON.parse(fs.readFileSync(seeded, "utf8")).actions[0].id, "m1", "旧记录还在文件里");
    assert.ok(!("comment" in DRIVERS.kuaishou.actions) && !DRIVERS.kuaishou.actions.isCommentAdd);
    await acq.dispose();
    // 重启：点下去还没确认的变成结果不明；没点的排队动作还在队里。
    const file = path.join(w.root, "data", "state.json"), saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.actions.unshift({ id: "a1", kind: "like", platform: "kuaishou", accountId: "ks1", leadId: "x", target: { videoId: "v" }, status: "running", clickedAt: "2026-10-26T12:00:00Z", reason: "" },
      { id: "a2", kind: "follow", platform: "kuaishou", accountId: "ks1", leadId: "x", target: { videoId: "v" }, status: "running", clickedAt: "", reason: "" });
    fs.writeFileSync(file, JSON.stringify(saved));
    const reopened = w.make().snapshot();
    assert.equal(reopened.actions.find((action) => action.id === "a1").status, "unknown");
    assert.equal(reopened.actions.find((action) => action.id === "a2").status, "queued");
  }
  {
    // 排队的动作只在用户排队或点「继续」时开始：跑完一个「找客户」任务不会顺带去点赞关注。
    const w = world(); w.seed(["买家A"]);
    const file = path.join(w.root, "data", "state.json"), saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.actions = [{ id: "q1", kind: "like", platform: "kuaishou", accountId: "ks1", leadId: "lead0", target: { videoId: "3xvideo0001", commentId: "118000000000", userName: "买家A", comment: "这个多少钱" }, status: "queued", clickedAt: "", reason: "" }];
    fs.writeFileSync(file, JSON.stringify(saved));
    const acq = w.make();
    acq.saveTask({ platform: "kuaishou", accountId: "ks1", keywords: "洗地机", days: 30, maxVideos: 1 });
    acq.start(acq.snapshot().tasks[0].id);
    let state = await w.until(acq);
    assert.deepEqual(state.runs.map((run) => run.kind), ["collect"]); assert.deepEqual(w.log.clicks, []);
    assert.equal(state.actions.find((action) => action.id === "q1").status, "queued");
    acq.resume(); state = await w.until(acq);
    assert.equal(state.actions.find((action) => action.id === "q1").status, "done", "用户点继续后才做");
    await acq.dispose();
  }
  {
    // 账号被删除：排队的动作标成没做并说明原因，「继续」不报错，也不会卡住别的账号。
    const w = world(); w.seed(["买家A"]);
    const file = path.join(w.root, "data", "state.json"), saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.actions = [{ id: "g1", kind: "follow", platform: "kuaishou", accountId: "gone", leadId: "lead0", target: { videoId: "v", userId: "3xbuyer00" }, status: "queued", clickedAt: "", reason: "" }];
    fs.writeFileSync(file, JSON.stringify(saved));
    const acq = w.make();
    const state = acq.resume();
    assert.equal(state.running, ""); assert.equal(state.actions[0].status, "failed"); assert.match(state.actions[0].reason, /已删除/);
    await acq.dispose();
  }
  // 平台回应里没有结果：算「结果不明」，不当成被拒；只有说「频繁」才让账号休息。
  assert.deepEqual(ks.actions.outcome({ data: { visionAddComment: { commentId: "1" } } }), { ok: null, message: "" });
  assert.equal(ks.actions.outcome({ result: 1, followStatus: 1 }).ok, true);
  assert.equal(ks.actions.outcome({ result: 109, error_msg: "评论功能已限制" }).ok, false);
  assert.ok(!TOO_FREQUENT.test("评论功能已限制") && !TOO_FREQUENT.test("已达关注上限") && TOO_FREQUENT.test("操作太频繁，请稍后再试"));
  console.log("social acquisition self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });
