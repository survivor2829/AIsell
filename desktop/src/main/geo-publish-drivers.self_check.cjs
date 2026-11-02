const assert = require("node:assert/strict");
const { createGeoBrowserAdapter, GEO_CHANNELS, DRIVERS, sameArticle, paragraphs } = require("./geo-publish-drivers.cjs");

// 文字比对：空白和编辑器插入的零宽字符不算差别；少一段、改一个字都算不一致。
const job = { title: "洗地机怎么选", body: "第一段。\n\n第二段。\n" };
assert.deepEqual(paragraphs(job.body), ["第一段。", "第二段。"]);
assert.ok(sameArticle({ title: "洗地机怎么选 ", body: "第一段。\n​第二段。" }, job));
assert.ok(!sameArticle({ title: "洗地机怎么选", body: "第一段。" }, job), "少一段不算一致");
assert.ok(!sameArticle({ title: "别的标题", body: "第一段。第二段。" }, job));

// 只开放真实发布确认过的渠道：开放的必须有驱动。
for (const channel of GEO_CHANNELS) if (channel.available) assert.ok(DRIVERS[channel.id], `${channel.name} 开放了却没有驱动`);
assert.ok(DRIVERS.zhihu.published("https://zhuanlan.zhihu.com/p/123?utm=1").url === "https://zhuanlan.zhihu.com/p/123");
assert.equal(DRIVERS.zhihu.published("https://zhuanlan.zhihu.com/write"), null, "还在写文章页不算发出");
assert.equal(DRIVERS.zhihu.published("https://zhuanlan.zhihu.com/p/2100538030733911727/edit"), null, "自动保存的草稿页不算发出");

// 头条：到了作品列表还不够，要看到这篇文章和它的状态。
{
  const tt = DRIVERS.toutiao, wanted = { title: "洗地机怎么选" }, list = "https://mp.toutiao.com/profile_v4/graphic/articles";
  const clicked = { ...wanted, clickedAtMs: new Date(2026, 10, 1, 21, 52).getTime() };
  assert.equal(tt.published(list, "共 1 条内容\n别的文章\n11-01 21:52\n已发布", clicked), null, "列表里没有这篇不算发出");
  assert.equal(tt.published(list, "洗地机怎么选\n11-01 21:52\n已发布\n首发", clicked).status, "public");
  assert.equal(tt.published(list, "洗地机怎么选\n11-01 21:52\n审核中", clicked).status, "reviewing");
  assert.equal(tt.published("https://mp.toutiao.com/profile_v4/graphic/publish", "洗地机怎么选\n11-01 21:52\n已发布", clicked), null, "还在写文章页不算发出");
  // 下一行才是别的文章的「已发布」：不能算到这篇头上。
  assert.equal(tt.published(list, "洗地机怎么选\n11-01 21:52\n审核中\n别的文章\n10-30 09:00\n已发布", clicked).status, "reviewing");
  assert.equal(tt.published(list, "洗地机怎么选\n11-01 21:52\n未通过\n别的文章\n10-30 09:00\n已发布", clicked), null, "未通过不算发出");
  // 同名的旧文章：时间早于这次点击，不算这次发出。
  assert.equal(tt.published(list, "洗地机怎么选\n10-30 09:00\n已发布", clicked), null, "同名旧文章不算");
  // 标题只是别的文章标题的一部分：不算。
  assert.equal(tt.published(list, "洗地机怎么选购指南\n11-01 21:52\n已发布", clicked), null, "标题要整行相同");
  assert.ok(GEO_CHANNELS.find((channel) => channel.id === "toutiao").titleLimit === 30);
  assert.ok(!GEO_CHANNELS.find((channel) => channel.id === "sohu").available, "搜狐号账号未实名，没发成过，不开放");
  assert.ok(!GEO_CHANNELS.find((channel) => channel.id === "baijiahao").available, "百家号没有测试账号，不开放");
}

// 假页面走一遍发布：内容对不上不点；按钮点不到不点；点了等不到确认是结果不明。
function world({ readBack, point = { x: 1, y: 2 }, urlAfter = "https://zhuanlan.zhihu.com/p/9", url = "https://zhuanlan.zhihu.com/write" } = {}) {
  const log = { clicks: 0, closed: 0, typed: [], before: 0 };
  let current = url;
  const node = { localName: "textarea", attributes: ["placeholder", "请输入标题"] };
  const page = {
    navigate: async () => {}, url: async () => current, find: async () => node, byClass: () => () => true,
    type: async (_node, text) => { log.typed.push(text); }, click: async () => true,
    send: async (method, params) => { if (method === "Input.insertText") log.typed.push(params.text); },
    valueOf: async () => "", front: async () => {},
    evaluate: async (expression) => expression.includes("elementFromPoint") ? point : expression.includes("captcha") ? false : "",
    mouse: async () => { log.clicks++; current = urlAfter; }
  };
  const browser = { send: async (method) => method === "Target.createTarget" ? { targetId: "t" } : method === "Target.attachToTarget" ? { sessionId: "s" } : {}, close: async () => { log.closed++; } };
  DRIVERS.zhihu.fill = async (_page, wanted) => { log.typed.push(wanted.title); return { read: async () => readBack || { title: wanted.title, body: wanted.body } }; };
  return { log, adapter: createGeoBrowserAdapter({ launch: () => browser, executable: "chrome.exe", makePage: () => page }) };
}
const realFill = DRIVERS.zhihu.fill, realTimeout = global.setTimeout;
// 真实等待都很长；这里把等待压短，只测判断。
global.setTimeout = (fn, ms, ...rest) => realTimeout(fn, Math.min(ms, 1), ...rest);

(async () => {
  const input = { platform: "zhihu", profileDir: "p", title: "标题", body: "正文" };
  {
    // 点发布之前要先看有没有停下：停下了就不点。
    const w = world();
    await assert.rejects(w.adapter.publish({ ...input, shouldStop: () => true }), { code: "GEO_STOPPED" });
    assert.equal(w.log.clicks, 0, "停下后不点发布");
  }
  {
    const w = world();
    let before = 0;
    const result = await w.adapter.publish({ ...input, beforeClick: () => { before = w.log.clicks + 1; } });
    assert.equal(result.status, "public"); assert.equal(result.url, "https://zhuanlan.zhihu.com/p/9");
    assert.equal(before, 1, "点之前先记下"); assert.equal(w.log.clicks, 1); assert.equal(w.log.closed, 1, "浏览器关掉");
  }
  {
    const w = world({ readBack: { title: "标题", body: "被平台改过的正文" } });
    let before = 0;
    await assert.rejects(w.adapter.publish({ ...input, beforeClick: () => { before++; } }), { code: "GEO_FORM_MISMATCH" });
    assert.deepEqual([w.log.clicks, before, w.log.closed], [0, 0, 1], "内容不一致一次都不点");
  }
  {
    const w = world({ point: null });
    await assert.rejects(w.adapter.publish(input), { code: "GEO_FORM_CHANGED" });
    assert.equal(w.log.clicks, 0);
  }
  {
    const w = world({ url: "https://www.zhihu.com/signin?next=x" });
    await assert.rejects(w.adapter.publish(input), { code: "GEO_LOGIN_REQUIRED" });
    assert.equal(w.log.clicks, 0);
  }
  await assert.rejects(world().adapter.publish({ ...input, platform: "weibo" }), { code: "GEO_CHANNEL_UNAVAILABLE" });
  DRIVERS.zhihu.fill = realFill;
  console.log("geo publish drivers self-check passed");
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
