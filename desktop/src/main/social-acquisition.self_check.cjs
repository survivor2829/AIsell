const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DRIVERS, acquireDriverFor, intentOf } = require("./social-acquire-drivers.cjs");
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
assert.deepEqual(intentOf("能租吗", ["租"]), ["含「租」"]);
// 抖音网页搜索会拦截软件控制的浏览器：列出来但不可用，不绕过。
assert.throws(() => acquireDriverFor("douyin"), { code: "ACQUIRE_PLATFORM_UNAVAILABLE" });

function world({ captchaPolls = 0, loggedOut = false, hang = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-acquire-"));
  const log = { launches: 0, closed: 0, navigations: [], fronts: 0, leases: 0, released: 0, wheels: 0 };
  let captchaLeft = captchaPolls, emitJson = null, pending = null, previous = "", hung = null;
  const hour = 3_600_000, nowMs = Date.parse("2026-10-26T12:00:00Z"), started = Date.now();
  const commentsFor = (id) => ({ data: { visionCommentList: { pcursorV2: "no_more", rootCommentsV2: [
    { commentId: `1${id.length}00000001`, authorId: "3xbuyer01", authorName: "买家A", content: "这个多少钱", timestamp: nowMs - hour },
    { commentId: `1${id.length}00000002`, authorId: id.endsWith("1") ? "3xauthor01" : "3xauthor02", authorName: "作者本人", content: "多少钱私信我", timestamp: nowMs - hour },
    { commentId: `1${id.length}00000003`, authorId: "3xold", authorName: "很久以前", content: "怎么买", timestamp: nowMs - 100 * 24 * hour },
    { commentId: `1${id.length}00000004`, authorId: "3xchat", authorName: "路人", content: "拍得真好", timestamp: nowMs - hour }
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
      return loggedOut ? "登录即可享受" : "洗地机 拖动滑块就能拆下水箱";
    },
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
    timing: { response: 200, verify: 5000, poll: 2, gapMin: 1, gapMax: 2 } });
  const until = async (acq) => { for (let i = 0; i < 500; i++) { if (!acq.snapshot().running) return acq.snapshot(); await sleep(5); } throw new Error("timeout"); };
  return { root, log, make, until };
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
  console.log("social acquisition self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });
