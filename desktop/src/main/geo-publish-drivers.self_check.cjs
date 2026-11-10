const assert = require("node:assert/strict");
const { coverHtml, createGeoBrowserAdapter, GEO_CHANNELS, GEO_ACCOUNT_PLATFORMS, DRIVERS, sameArticle, paragraphs } = require("./geo-publish-drivers.cjs");

// 文字比对：空白和编辑器插入的零宽字符不算差别；少一段、改一个字都算不一致。
const job = { title: "洗地机怎么选", body: "第一段。\n\n第二段。\n" };
assert.deepEqual(paragraphs(job.body), ["第一段。", "第二段。"]);
assert.ok(sameArticle({ title: "洗地机怎么选 ", body: "第一段。\n​第二段。" }, job));
assert.ok(sameArticle({ title: "洗地机怎么选", body: "第一段。\n\n第二段。\n\n\u200d" }, job), "百家号在正文末尾插入的零宽字符不算差别");
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
  // 搜狐号、百家号应用户要求先开放（2026-11-02）：没有真实发过，必须标成试用，而且永远不能自己报“已发出”。
  for (const id of ["sohu", "baijiahao"]) {
    const channel = GEO_CHANNELS.find((item) => item.id === id), driver = DRIVERS[id];
    assert.ok(channel.available && !channel.trial, `${id} 开放，不再标试用（用户 2026-11-02）`);
    assert.ok(GEO_ACCOUNT_PLATFORMS[id]?.loginCookies.length, `${id} 可以登录`);
    const lists = id === "sohu" ? "https://mp.sohu.com/mpfe/v4/contentManagement/news/list" : "https://baijiahao.baidu.com/builder/rc/content";
    assert.equal(driver.published(lists, "别的文章\n已发布", { title: "这篇" }), null, "列表里没有这篇不算");
    assert.equal(driver.published(lists, "这篇的后续\n已发布", { title: "这篇" }), null, "标题要整行相同");
    assert.equal(driver.published(lists, "这篇\n已发布", { title: "这篇" }).status, "unknown", "没验证过的渠道结果一律由用户核对");
    assert.equal(driver.published(lists, "旧文章\n正在审核中", { title: "这篇" }).status, "unknown", "别的文章的审核状态不能算到这篇头上");
    assert.equal(driver.published(driver.editorUrl, "这篇", { title: "这篇" }), null, "还在写文章页不算");
  }
  // 搜狐号没实名时，发文地址会跳回首页（2026-11-02 真实账号上看到的）：说清楚原因，不当成页面改版。
  assert.match(DRIVERS.sohu.blocked("https://mp.sohu.com/mpfe/v4/contentManagement/first/page", "实名认证可解锁发布文章"), /实名认证/);
  assert.equal(DRIVERS.sohu.blocked(DRIVERS.sohu.editorUrl, "请先实名认证的提示 标题"), "", "已经在写文章页就不算被挡");
  assert.match(DRIVERS.sohu.blocked(DRIVERS.sohu.editorUrl, "账号已被平台禁言，暂无法发布文章"), /禁言/);
  assert.match(DRIVERS.sohu.blocked(DRIVERS.sohu.editorUrl, "账号今日发布额度已用完"), /额度/);
  assert.match(DRIVERS.sohu.blocked(DRIVERS.sohu.editorUrl, "仅支持发布动态"), /动态/);
  // 2026-11-09 真实账号：打开发文页直接显示账号未通过审核。说清楚原因，不说成找不到输入框。
  assert.match(DRIVERS.sohu.blocked(DRIVERS.sohu.editorUrl, "您的搜狐号未通过审核"), /没有通过平台审核/);
  assert.match(DRIVERS.sohu.blocked("https://mp.sohu.com/mpfe/v4/contentManagement/first/page", "账号审核未通过"), /没有通过平台审核/);
  assert.equal(DRIVERS.sohu.blocked("https://mp.sohu.com/mpfe/v4/contentManagement/news/list", "洗地机怎么选\n审核未通过\n别的文章\n已发布"), "", "列表里某篇文章没过审，不算账号没过审");
  assert.equal(DRIVERS.sohu.blocked("https://mp.sohu.com/mpfe/v4/contentManagement/first/page", "实名认证\n已认证\n发布内容"), "", "菜单里有这几个字不算没实名");
  assert.ok(!DRIVERS.sohu.holdText.test("为了账号安全，请不要泄露密码"), "常驻提示不算验证");
  assert.ok(DRIVERS.sohu.holdText.test("为了账号安全，需要短信验证") && DRIVERS.baijiahao.holdText.test("百度安全验证"));
  assert.ok(DRIVERS.sohu.confirmButton.includes("确认发布") && DRIVERS.baijiahao.confirmButton.includes("确认发布"), "点发布后还有一步确认");
  assert.equal(DRIVERS.baijiahao.published("https://baijiahao.baidu.com/builder/rc/success", "提交成功，正在审核中", { title: "这篇" }).status, "unknown");
  // 搜狐通行证的 Cookie 不算登录了搜狐号：要等网站自己的登录凭据（2026-11-02 实测）。
  assert.deepEqual(DRIVERS.sohu.loginCookies, ["umab_access_token"]);
  // 百家号的编辑地址会跳回首页，要从首页入口进。
  assert.equal(typeof DRIVERS.baijiahao.enter, "function");
  assert.equal(DRIVERS.baijiahao.published("https://baijiahao.baidu.com/builder/rc/edit", "这篇", { title: "这篇" }), null, "还在编辑页不算");
  assert.ok(DRIVERS.baijiahao.publishButton.includes("publish-btn"));
  // 搜狐号的发布按钮是列表项，内容没填好时带 disable-button。
  assert.ok(DRIVERS.sohu.publishButton.includes(":not(.disable-button)"));
  // 百家号必须有封面：封面用标题生成，标题里的符号不能变成网页代码。
  assert.ok(DRIVERS.baijiahao.needsCover);
  assert.ok(coverHtml("<img src=x>洗地机").includes("&#60;img src=x&#62;洗地机"));
}

// 假页面走一遍发布：内容对不上不点；按钮点不到不点；点了等不到确认是结果不明。
function world({ readBack, point = { x: 1, y: 2 }, urlAfter = "https://zhuanlan.zhihu.com/p/9", url = "https://zhuanlan.zhihu.com/write", shown = "", urlOnFail = null, fill = null, listPage = null } = {}) {
  const log = { clicks: 0, closed: 0, typed: [], before: 0, tabs: [] };
  let current = url;
  const node = { localName: "textarea", attributes: ["placeholder", "请输入标题"] };
  const page = {
    navigate: async () => {}, url: async () => current, find: async () => node, byClass: () => () => true,
    type: async (_node, text) => { log.typed.push(text); }, click: async () => true,
    send: async (method, params) => { if (method === "Input.insertText") log.typed.push(params.text); return method === "Page.captureScreenshot" ? { data: Buffer.from("png").toString("base64") } : {}; },
    valueOf: async () => "", front: async () => {},
    evaluate: async (expression) => expression.includes("elementFromPoint") ? point : expression.includes("captcha") ? false : expression.includes("document.body") ? shown : "",
    mouse: async () => { log.clicks++; current = urlAfter; }
  };
  const browser = { send: async (method, params) => { if (method === "Target.createTarget") { log.tabs.push(params.url); return { targetId: "t" }; } return method === "Target.attachToTarget" ? { sessionId: "s" } : {}; }, close: async () => { log.closed++; } };
  const fake = fill || (async (_page, wanted) => { log.typed.push(wanted.title); return { read: async () => readBack || { title: wanted.title, body: wanted.body } }; });
  DRIVERS.zhihu.fill = async (...args) => { try { return await fake(...args); } catch (error) { if (urlOnFail) current = urlOnFail; throw error; } };
  let pages = 0;
  return { log, adapter: createGeoBrowserAdapter({ launch: () => browser, executable: "chrome.exe", makePage: () => (pages++ > 0 && listPage) ? listPage : page }) };
}
const realFill = DRIVERS.toutiao.fill, realFillToutiao = (page) => realFill.call(DRIVERS.toutiao, page, { title: "标题", body: "正文" }), realZhihuFill = DRIVERS.zhihu.fill, realTimeout = global.setTimeout;
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
  {
    // 点发布后才出现的文字验证：窗口切到前面并继续等，验证结束后才判断结果；页面读不出来不算验证结束。
    const { waitThroughVerify } = require("./geo-publish-drivers.cjs");
    let reads = 0, fronts = 0;
    const page = { front: async () => { fronts++; }, evaluate: async (expression) => { if (expression.includes("captcha")) return false; reads++; if (reads === 2) throw new Error("page is navigating"); return reads < 4 ? "为了账号安全，需要短信验证" : "列表页"; } };
    const result = await waitThroughVerify(page, async () => ({ doneAt: reads }), { ms: 1, hold: /需要短信验证/ });
    assert.equal(fronts, 1, "窗口切到前面一次"); assert.ok(result.doneAt >= 4, "验证还在时不算完成");
  }
  {
    // 百家号封面上传不成功：不碰发布按钮；生成的临时封面用完删掉。
    const fsCheck = require("node:fs");
    let coverPath = "";
    const realFillB = DRIVERS.baijiahao.fill;
    DRIVERS.baijiahao.fill = async (_page, job) => { coverPath = job.coverFile; assert.ok(fsCheck.existsSync(coverPath), "发布时封面文件在"); throw Object.assign(new Error("封面没传成功"), { code: "GEO_FORM_CHANGED" }); };
    const w = world({ url: "https://baijiahao.baidu.com/builder/rc/edit?type=news" });
    await assert.rejects(w.adapter.publish({ ...input, platform: "baijiahao" }), { code: "GEO_FORM_CHANGED" });
    assert.equal(w.log.clicks, 0, "封面失败不点发布"); assert.ok(coverPath && !fsCheck.existsSync(coverPath), "临时封面删掉");
    DRIVERS.baijiahao.fill = realFillB;
  }
  {
    // 头条：默认勾着的「发布得更多收益」要取消；取消不掉就不发。
    const fake = (stuck, missing = false) => { const log = { clicks: [], typed: 0 }; let ticked = true; const label = (text, cls) => ({ nodeType: 1, localName: "label", attributes: ["class", cls], children: [{ nodeType: 3, nodeValue: text }] });
      return { log, page: { evaluate: async () => undefined, type: async () => {}, click: async (node) => { log.clicks.push(node.children?.[0]?.nodeValue || "editor"); if (!stuck && node.children?.[0]?.nodeValue === "发布得更多收益") ticked = false; return true; }, send: async () => {}, call: async () => {}, valueOf: async () => "", byClass: () => (node) => node.localName === "editor",
        find: async (predicate) => [{ localName: "textarea", attributes: ["placeholder", "请输入文章标题"] }, { localName: "editor" }, label("无封面", "byte-radio"), ...(missing ? [] : [label("发布得更多收益", ticked ? "byte-checkbox byte-checkbox-checked" : "byte-checkbox")])].find((node) => predicate(node)) || null } }; };
    const ok = fake(false);
    await realFillToutiao(ok.page);
    assert.ok(ok.log.clicks.includes("发布得更多收益"), "默认勾选的要取消");
    const stuck = fake(true);
    await assert.rejects(realFillToutiao(stuck.page), { code: "GEO_FORM_CHANGED" }, "取消不掉就不发");
    await assert.rejects(realFillToutiao(fake(false, true).page), { code: "GEO_FORM_CHANGED" }, "找不到这个选项不能当成已取消");
  }
  {
    // 页面慢：输入框第三次看才出现，也能找到；一直不出现，找够次数后才放弃；停下了就不再等。
    const { findSoon } = require("./geo-publish-drivers.cjs");
    let looks = 0, between = 0;
    const slow = { find: async () => (++looks >= 3 ? { localName: "textarea" } : null) };
    assert.ok(await findSoon(slow, () => true, { between: () => { between++; } }));
    assert.deepEqual([looks, between], [3, 2], "每次重找前先关弹窗");
    looks = 0;
    const never = { find: async () => { looks++; return null; } };
    assert.equal(await findSoon(never, () => true, { tries: 4 }), null);
    assert.equal(looks, 5);
    await assert.rejects(findSoon(never, () => true, { shouldStop: () => true }), { code: "GEO_STOPPED" });
  }
  {
    // 平台自己的提示才留下；菜单里的短词不算。
    const { noticesOf } = require("./geo-publish-drivers.cjs");
    assert.deepEqual(noticesOf("首页\n实名认证\n发布内容\n请先完成实名认证后再发布文章\n" + "很长".repeat(30) + "审核"), ["请先完成实名认证后再发布文章"]);
    // 已经打进编辑器的正文是用户自己的话，不能当成平台提示。
    assert.deepEqual(noticesOf("通过ISO认证的洗地机更省心\n请先完成实名认证后再发布文章", { title: "洗地机", body: "第一段。\n通过ISO认证的洗地机更省心" }), ["请先完成实名认证后再发布文章"]);
  }
  {
    // 找不到输入框：带上当时页面的截图和地址，平台提示写进原因，一次都不点。
    const w = world({ shown: "首页\n请先完成实名认证后再发布文章", fill: async () => { throw Object.assign(new Error("没有找到知乎的标题输入框。"), { code: "GEO_FORM_CHANGED" }); } });
    const error = await w.adapter.publish(input).then(() => null, (caught) => caught);
    assert.equal(error.code, "GEO_FORM_CHANGED"); assert.match(error.message, /页面上写着：「请先完成实名认证后再发布文章」/);
    assert.deepEqual([error.evidence.step, error.evidence.pageUrl, Boolean(error.evidence.screenshot)], ["fill", "https://zhuanlan.zhihu.com/write", true]);
    assert.equal(w.log.clicks, 0);
  }
  {
    // 等输入框的时候页面才跳去登录：说要重新登录，不说页面改版。
    const w = world({ urlOnFail: "https://www.zhihu.com/signin?next=x", fill: async () => { throw Object.assign(new Error("没有找到"), { code: "GEO_FORM_CHANGED" }); } });
    const error = await w.adapter.publish(input).then(() => null, (caught) => caught);
    assert.equal(error.code, "GEO_LOGIN_REQUIRED"); assert.ok(error.evidence.screenshot);
  }
  // 平台确认要等几十秒：这里让时钟走快，只测判断。
  const realNow = Date.now; let clock = realNow();
  Date.now = () => (clock += 1000);
  {
    // 点了发布没等到确认：结果不明，并留下当时的页面。
    const w = world({ urlAfter: "https://zhuanlan.zhihu.com/write" });
    const result = await w.adapter.publish(input);
    assert.equal(result.status, "unknown"); assert.equal(result.evidence.step, "result"); assert.ok(result.evidence.screenshot);
  }
  {
    // 头条点了发布，编辑页没跳到作品列表：另开一个标签页查作品列表，查到就拿回链接；编辑页不动。
    const realToutiaoFill = DRIVERS.toutiao.fill;
    DRIVERS.toutiao.fill = async (_page, wanted) => ({ read: async () => ({ title: wanted.title, body: wanted.body }) });
    const pad = (n) => String(n).padStart(2, "0");
    // 列表上的时间是读列表那一刻的：晚于点发布的时间。
    const row = () => { const now = new Date(Date.now()); return `标题\n${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}\n已发布`; };
    const listPage = (text) => ({ url: async () => DRIVERS.toutiao.listUrl, reload: async () => {}, front: async () => {},
      evaluate: async (expression) => expression.includes("captcha") ? false : expression.includes("document.body") ? (typeof text === "function" ? text() : text) : expression.includes("a[href]") ? "https://www.toutiao.com/item/123/" : "" });
    const editor = "https://mp.toutiao.com/profile_v4/graphic/publish";
    const found = world({ url: editor, urlAfter: editor, listPage: listPage(row) });
    const result = await found.adapter.publish({ ...input, platform: "toutiao" });
    assert.deepEqual([result.status, result.url], ["public", "https://www.toutiao.com/item/123/"]);
    assert.deepEqual(found.log.tabs, ["about:blank", DRIVERS.toutiao.listUrl], "作品列表在新标签页打开");
    assert.equal(found.log.clicks, 2, "只点了发布和确认发布");
    // 列表里没有这篇：还是结果不明，不自动重发。
    const missing = world({ url: editor, urlAfter: editor, listPage: listPage("别的文章\n11-01 09:00\n已发布") });
    assert.equal((await missing.adapter.publish({ ...input, platform: "toutiao" })).status, "unknown");
    DRIVERS.toutiao.fill = realToutiaoFill;
  }
  Date.now = realNow;
  DRIVERS.zhihu.fill = realZhihuFill;
  console.log("geo publish drivers self-check passed");
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
