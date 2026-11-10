const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGeoWorkbench, classifyVisibility, AI_DAILY_LIMIT, PUBLISH_DAILY_LIMIT } = require("./geo-workbench.cjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHANNELS = [{ id: "toutiao", name: "今日头条", available: true, titleLimit: 30 }, { id: "zhihu", name: "知乎", available: false, reason: "待开放" }];
function world({ publish, ask, generate } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "geo-check-"));
  const log = { published: [], asked: [], ai: [], leases: 0, released: 0, signedOut: [], failures: [] };
  const list = [{ id: "tt1", platform: "toutiao", label: "头条号", status: "active" }, { id: "db1", platform: "doubao", label: "豆包号", status: "active" }, { id: "tt2", platform: "toutiao", label: "没登录", status: "login_required" }];
  const accounts = { snapshot: () => ({ accounts: list }), profileDir: (id) => path.join(root, id), lease: () => { log.leases++; return () => { log.released++; }; }, markSignedOut: (id) => log.signedOut.push(id) };
  const adapter = {
    publish: publish || (async (job) => { job.beforeClick(); log.published.push(job.title); return { status: "public", url: "https://www.toutiao.com/article/1/" }; }),
    ask: ask || (async ({ question }) => { log.asked.push(question); return { answer: "推荐 示例清洁 的洗地机", references: [{ title: "洗地机怎么选", url: "https://www.toutiao.com/article/1/" }] }; })
  };
  const generateText = generate || (async ({ kind, prompt }) => {
    log.ai.push(prompt);
    return { usage: {}, content: kind === "geo-questions" ? JSON.stringify({ questions: ["成都洗地机哪家好", "商用洗地机多少钱", 7] }) : JSON.stringify({ title: `洗地机怎么选${log.ai.length}`, body: "第一段。\n第二段。" }) };
  });
  const dataDir = path.join(root, "data");
  const make = () => createGeoWorkbench({ dataDir, adapter, accounts, generateText, channels: CHANNELS, onFailure: (failure) => log.failures.push(failure) });
  const idle = async (geo) => { for (let i = 0; i < 400; i++) { await sleep(5); if (!geo.isBusy() && !geo.snapshot().publications.some((item) => item.status === "queued")) return geo.snapshot(); } throw new Error("still busy"); };
  return { root, log, make, idle, dataDir };
}
const brand = { name: "示例清洁", aliases: "示例", regions: "成都", services: "商用洗地机销售", cases: "", restrictions: "" };
const code = (expected) => (error) => { assert.equal(error.code, expected, error.message); return true; };

(async () => {
  {
    // 判断提及和引用：只认公司名和别名；引用的是自己发过的文章才算确认。
    const result = classifyVisibility({ answer: "推荐示例清洁", references: [{ title: "别的", url: "https://a.example/1#x" }, { title: "怎么选", url: "https://b.example/2" }], brand: { name: "示例清洁", aliases: [] }, articles: [{ id: "a2", title: "怎么选" }], publications: [{ status: "public", url: "https://a.example/1", articleId: "a1" }] });
    assert.equal(result.mentioned, true);
    assert.deepEqual(result.references.map((ref) => ref.association), ["confirmed", "suspected"]);
    assert.equal(classifyVisibility({ answer: "别家", references: null, brand: { name: "示例清洁" }, articles: [], publications: [] }).referenceStatus, "unknown");
  }
  {
    // 主流程：填公司 → AI 列问题 → 写文章 → 确认一次 → 发布 → 查豆包。
    const w = world(), geo = w.make();
    await assert.rejects(geo.dispatch("suggest-questions"), code("GEO_BRAND_REQUIRED"));
    await assert.rejects(geo.dispatch("save-brand", { name: "示例清洁" }), code("GEO_BRAND_REQUIRED"));
    await geo.dispatch("save-brand", brand);
    await geo.dispatch("suggest-questions");
    let state = geo.snapshot();
    assert.deepEqual(state.questions.map((item) => item.text), ["成都洗地机哪家好", "商用洗地机多少钱"], "不是文字的丢弃");
    await geo.dispatch("write-article", { questionId: state.questions[0].id });
    state = geo.snapshot();
    const article = state.articles[0];
    assert.match(w.log.ai.at(-1), /只用下面公司资料里的事实/); assert.match(w.log.ai.at(-1), /商用洗地机销售/);
    assert.match(w.log.ai.at(-1), /不替案例里的人补充原因/); assert.match(w.log.ai.at(-1), /不要写“小标题一”/); assert.match(w.log.ai.at(-1), /不要出现“资料”/);
    assert.equal(w.log.published.length, 0, "没确认前不发");
    await geo.dispatch("confirm-publish", { articleId: article.id, targets: [{ platform: "toutiao", accountId: "tt1" }] });
    state = await w.idle(geo);
    assert.deepEqual(w.log.published, [article.title]);
    assert.equal(state.publications[0].status, "public"); assert.ok(state.publications[0].clickedAt, "点之前先记下");
    assert.equal(state.publications[0].approved, undefined, "界面不需要整篇存档");
    assert.deepEqual([w.log.leases, w.log.released], [1, 1], "账号用完释放");
    const again = await geo.dispatch("confirm-publish", { articleId: article.id, targets: [{ platform: "toutiao", accountId: "tt1" }] });
    assert.equal(again.result.added, 0, "同一篇同一账号不发第二次");
    await geo.dispatch("check-visibility", { accountId: "db1", questionIds: [state.questions[0].id] });
    state = await w.idle(geo);
    const run = state.visibilityRuns.at(-1);
    assert.equal(run.status, "completed"); assert.equal(run.mentioned, true);
    assert.equal(run.references[0].association, "confirmed", "引用了自己发过的文章");
    geo.dispose();
    // 重新打开：资料都在。
    const reopened = w.make();
    assert.equal(reopened.snapshot().brand.name, "示例清洁"); assert.equal(reopened.snapshot().articles.length, 1);
    reopened.dispose();
  }
  {
    // 不能发的情况：平台没开放、账号没登录、没选账号。
    const w = world(), geo = w.make();
    await geo.dispatch("save-brand", brand); await geo.dispatch("add-questions", { text: "问题一" });
    await geo.dispatch("write-article", { questionId: geo.snapshot().questions[0].id });
    const id = geo.snapshot().articles[0].id;
    await assert.rejects(geo.dispatch("confirm-publish", { articleId: id, targets: [] }), code("GEO_TARGET_REQUIRED"));
    await assert.rejects(geo.dispatch("confirm-publish", { articleId: id, targets: [{ platform: "zhihu", accountId: "tt1" }] }), code("GEO_CHANNEL_UNAVAILABLE"));
    await assert.rejects(geo.dispatch("confirm-publish", { articleId: id, targets: [{ platform: "toutiao", accountId: "tt2" }] }), code("GEO_ACCOUNT_REQUIRED"));
    assert.equal(w.log.published.length, 0);
    geo.dispose();
  }
  {
    // 粘贴自己的文章：不花 AI 次数，也能发布；标题超过平台上限先说清楚，不打开浏览器。
    const w = world(), geo = w.make();
    await assert.rejects(geo.dispatch("add-article", { title: "", body: "x" }), code("GEO_ARTICLE_INVALID"));
    await geo.dispatch("add-article", { title: "长".repeat(31), body: "我自己的文章" });
    const long = geo.snapshot().articles[0];
    assert.equal(geo.snapshot().usage.ai, 0);
    await assert.rejects(geo.dispatch("confirm-publish", { articleId: long.id, targets: [{ platform: "toutiao", accountId: "tt1" }] }), code("GEO_TITLE_TOO_LONG"));
    await geo.dispatch("save-article", { id: long.id, title: "短标题", body: long.body });
    await geo.dispatch("confirm-publish", { articleId: long.id, targets: [{ platform: "toutiao", accountId: "tt1" }] });
    await w.idle(geo);
    assert.deepEqual(w.log.published, ["短标题"]);
    geo.dispose();
  }
  {
    // 点了发布但之后出错：结果不明，不自动重发，也不能再确认一次；只有用户看过之后能定结果。
    const w = world({ publish: async (job) => { job.beforeClick(); throw new Error("page gone"); } }), geo = w.make();
    await geo.dispatch("save-brand", brand); await geo.dispatch("add-questions", { text: "问题一" });
    await geo.dispatch("write-article", { questionId: geo.snapshot().questions[0].id });
    const id = geo.snapshot().articles[0].id;
    await geo.dispatch("confirm-publish", { articleId: id, targets: [{ platform: "toutiao", accountId: "tt1" }] });
    let state = await w.idle(geo);
    const item = state.publications[0];
    assert.equal(item.status, "unknown");
    assert.equal((await geo.dispatch("confirm-publish", { articleId: id, targets: [{ platform: "toutiao", accountId: "tt1" }] })).result.added, 0, "结果不明不能再发");
    await assert.rejects(geo.dispatch("resolve-publication", { id: item.id, outcome: "maybe" }), code("GEO_PUBLICATION_OUTCOME"));
    await geo.dispatch("resolve-publication", { id: item.id, outcome: "failed" });
    assert.equal(geo.snapshot().publications[0].status, "failed");
    await assert.rejects(geo.dispatch("resolve-publication", { id: item.id, outcome: "public" }), code("GEO_PUBLICATION_SETTLED"));
    geo.dispose();
  }
  {
    // 没点到发布就失败：明确是没发出，可以再试；驱动说失败但已经点过的，算结果不明。
    let clicks = 0;
    const evidence = { step: "fill", pageUrl: "https://mp.toutiao.com/profile_v4/graphic/publish", screenshot: "cG5n", notices: ["请先完成实名认证"] };
    const w = world({ publish: async (job) => { if (clicks++ === 0) throw Object.assign(new Error("没有找到标题"), { code: "GEO_FORM_CHANGED", evidence }); job.beforeClick(); return { status: "failed", reason: "没等到提示", evidence: { ...evidence, step: "result" } }; } }), geo = w.make();
    await geo.dispatch("save-brand", brand); await geo.dispatch("add-questions", { text: "问题一" });
    await geo.dispatch("write-article", { questionId: geo.snapshot().questions[0].id });
    const id = geo.snapshot().articles[0].id, target = { articleId: id, targets: [{ platform: "toutiao", accountId: "tt1" }] };
    await geo.dispatch("confirm-publish", target);
    let state = await w.idle(geo);
    assert.equal(state.publications[0].status, "failed"); assert.match(state.publications[0].reason, /没有找到标题/);
    // 失败时的页面截图交给诊断，发布记录里不存图。
    assert.deepEqual(w.log.failures[0], { platform: "toutiao", code: "GEO_FORM_CHANGED", step: "fill", clicked: false, pageUrl: evidence.pageUrl, screenshot: "cG5n", notices: evidence.notices });
    assert.ok(!fs.readFileSync(path.join(w.dataDir, "state.json"), "utf8").includes("cG5n"), "截图不进发布记录");
    assert.equal((await geo.dispatch("confirm-publish", target)).result.added, 1, "确定没发出的可以再发");
    state = await w.idle(geo);
    assert.equal(state.publications[1].status, "unknown", "点过之后不能算没发出");
    assert.deepEqual([w.log.failures[1].code, w.log.failures[1].step, w.log.failures[1].clicked], ["GEO_RESULT_UNCONFIRMED", "result", true], "结果不明也留下当时的页面");
    geo.dispose();
  }
  {
    // 搜狐号、百家号正常提交后都说“已提交，请核对”：这不是故障，不上报。
    const w = world({ publish: async (job) => { job.beforeClick(); return { status: "unknown", reason: "页面显示已提交。" }; } }), geo = w.make();
    await geo.dispatch("add-article", { title: "短标题", body: "正文" });
    await geo.dispatch("confirm-publish", { articleId: geo.snapshot().articles[0].id, targets: [{ platform: "toutiao", accountId: "tt1" }] });
    const state = await w.idle(geo);
    assert.equal(state.publications[0].status, "unknown"); assert.equal(w.log.failures.length, 0);
    geo.dispose();
  }
  {
    // 用户自己点停下：不算故障，不上报。
    const w = world({ publish: async () => { throw Object.assign(new Error("已停下"), { code: "GEO_STOPPED" }); } }), geo = w.make();
    await geo.dispatch("add-article", { title: "短标题", body: "正文" });
    await geo.dispatch("confirm-publish", { articleId: geo.snapshot().articles[0].id, targets: [{ platform: "toutiao", accountId: "tt1" }] });
    await w.idle(geo);
    assert.equal(w.log.failures.length, 0);
    geo.dispose();
  }
  {
    // 确认之后、开始之前改了文章：这次发布取消，不会发旧稿，也不会发没确认过的新稿。
    const w = world(), geo = w.make();
    await geo.dispatch("save-brand", brand); await geo.dispatch("add-questions", { text: "问题一" });
    await geo.dispatch("write-article", { questionId: geo.snapshot().questions[0].id });
    const id = geo.snapshot().articles[0].id;
    await geo.dispatch("confirm-publish", { articleId: id, targets: [{ platform: "toutiao", accountId: "tt1" }] });
    await geo.dispatch("save-article", { id, title: "改过的标题", body: "改过的正文" });
    const state = await w.idle(geo);
    assert.equal(state.publications[0].status, "cancelled"); assert.equal(w.log.published.length, 0);
    assert.equal(state.articles[0].revision, 2);
    geo.dispose();
  }
  {
    // AI 正在写的时候点了确认发布：写完后自动开始，不会一直排着。
    let letGo;
    const w = world(), geo = createGeoWorkbench({ dataDir: w.dataDir, channels: CHANNELS,
      accounts: { snapshot: () => ({ accounts: [{ id: "tt1", platform: "toutiao", label: "头条号", status: "active" }] }), profileDir: () => w.root, lease: () => () => {} },
      adapter: { publish: async (job) => { job.beforeClick(); w.log.published.push(job.title); return { status: "public" }; } },
      generateText: async ({ prompt }) => { if (/问题二/.test(prompt)) await new Promise((resolve) => { letGo = resolve; }); return { content: JSON.stringify({ title: "标题" + (w.log.ai.push(1)), body: "正文" }) }; } });
    await geo.dispatch("save-brand", brand); await geo.dispatch("add-questions", { text: ["问题一", "问题二"] });
    const [one, two] = geo.snapshot().questions;
    await geo.dispatch("write-article", { questionId: one.id });
    const writing = geo.dispatch("write-article", { questionId: two.id });
    await sleep(5);
    await geo.dispatch("confirm-publish", { articleId: geo.snapshot().articles[0].id, targets: [{ platform: "toutiao", accountId: "tt1" }] });
    await sleep(10);
    assert.equal(w.log.published.length, 0, "写作时不抢着开始");
    letGo(); await writing;
    const state = await w.idle(geo);
    assert.equal(state.publications[0].status, "public", "写完自动开始");
    geo.dispose();
  }
  {
    // 每个账号每天发布上限：到了就不发，说明原因。
    const w = world(), geo = w.make();
    await geo.dispatch("save-brand", brand);
    await geo.dispatch("add-questions", { text: ["问题一", "问题二", "问题三", "问题四"] });
    const questions = geo.snapshot().questions;
    for (const question of questions) {
      await geo.dispatch("write-article", { questionId: question.id });
      await geo.dispatch("confirm-publish", { articleId: geo.snapshot().articles[0].id, targets: [{ platform: "toutiao", accountId: "tt1" }] });
      await w.idle(geo);
    }
    assert.equal(w.log.published.length, PUBLISH_DAILY_LIMIT);
    assert.match(geo.snapshot().publications.at(-1).reason, /明天/);
    geo.dispose();
  }
  {
    // AI：同样的请求不重复花钱；每天有上限；结果不明的不自动重试，用户点「再试一次」才行。
    let fails = 1;
    const w = world({ generate: async ({ prompt }) => { w.log.ai.push(prompt); if (fails-- > 0) throw new Error("network"); return { content: JSON.stringify({ title: `标题${w.log.ai.length}`, body: "正文" }) }; } }), geo = w.make();
    await geo.dispatch("save-brand", brand);
    await geo.dispatch("add-questions", { text: ["问题一", "问题二", "问题三", "问题四", "问题五", "问题六", "问题七"] });
    const [first, ...rest] = geo.snapshot().questions;
    await assert.rejects(geo.dispatch("write-article", { questionId: first.id }));
    await assert.rejects(geo.dispatch("write-article", { questionId: first.id }), code("GEO_AI_PENDING"));
    assert.equal(w.log.ai.length, 1, "结果不明不重复调用");
    await geo.dispatch("retry-ai", { id: geo.snapshot().aiPending[0].id });
    await geo.dispatch("write-article", { questionId: first.id });
    assert.equal(w.log.ai.length, 2);
    await geo.dispatch("remove-article", { id: geo.snapshot().articles[0].id });
    await geo.dispatch("write-article", { questionId: first.id });
    assert.equal(w.log.ai.length, 2, "文章删了再写同一版，用已有结果，不再花钱");
    for (const question of rest.slice(0, AI_DAILY_LIMIT - 2)) await geo.dispatch("write-article", { questionId: question.id });
    await assert.rejects(geo.dispatch("write-article", { questionId: rest.at(-1).id }), code("GEO_AI_LIMIT"));
    assert.equal(geo.snapshot().usage.ai, AI_DAILY_LIMIT);
    geo.dispose();
  }
  {
    // AI 写坏了不保存，也不留成缓存：再试一次会真的重新写，能成功。
    let calls = 0;
    const w = world({ generate: async () => ({ content: calls++ === 0 ? "不是 JSON" : JSON.stringify({ title: "好标题", body: "好正文" }) }) }), geo = w.make();
    await geo.dispatch("save-brand", brand); await geo.dispatch("add-questions", { text: "问题一" });
    const id = geo.snapshot().questions[0].id;
    await assert.rejects(geo.dispatch("write-article", { questionId: id }), code("GEO_AI_INVALID"));
    assert.equal(geo.snapshot().articles.length, 0);
    await geo.dispatch("write-article", { questionId: id });
    assert.equal(calls, 2, "坏结果不能被复用"); assert.equal(geo.snapshot().articles[0].title, "好标题");
    assert.equal(geo.snapshot().aiPending.length, 0);
    geo.dispose();
  }
  {
    // 同一个问题再点一次是要新的一版：真的调用 AI；相同文字不能靠副本再发到同一账号。
    const same = JSON.stringify({ title: "同样的标题", body: "同样的正文" });
    const w = world({ generate: async ({ prompt }) => { w.log.ai.push(prompt); return { content: same }; } }), geo = w.make();
    await geo.dispatch("save-brand", brand); await geo.dispatch("add-questions", { text: "问题一" });
    const id = geo.snapshot().questions[0].id;
    await geo.dispatch("write-article", { questionId: id }); await geo.dispatch("write-article", { questionId: id });
    assert.equal(w.log.ai.length, 2, "第二版真的重新写"); assert.match(w.log.ai[1], /换一个角度/);
    const [newer, older] = geo.snapshot().articles;
    await geo.dispatch("confirm-publish", { articleId: older.id, targets: [{ platform: "toutiao", accountId: "tt1" }] });
    await w.idle(geo);
    assert.equal((await geo.dispatch("confirm-publish", { articleId: newer.id, targets: [{ platform: "toutiao", accountId: "tt1" }] })).result.added, 0, "文字相同就算另一篇也不重发");
    await w.idle(geo);
    assert.equal(w.log.published.length, 1);
    geo.dispose();
  }
  {
    // 明确没花钱或明确失败的错误：不算结果不明，不占当天次数，可以直接再试；超时才算结果不明。
    let error = Object.assign(new Error("余额不足"), { code: "AI_BALANCE_INSUFFICIENT" });
    const w = world({ generate: async () => { if (error) throw error; return { content: JSON.stringify({ title: "标题", body: "正文" }) }; } }), geo = w.make();
    await geo.dispatch("save-brand", brand); await geo.dispatch("add-questions", { text: "问题一" });
    const id = geo.snapshot().questions[0].id;
    await assert.rejects(geo.dispatch("write-article", { questionId: id }), code("AI_BALANCE_INSUFFICIENT"));
    assert.equal(geo.snapshot().aiPending.length, 0, "明确失败不是结果不明"); assert.equal(geo.snapshot().usage.ai, 0, "没发出去不占次数");
    error = Object.assign(new Error("超时"), { code: "AI_REQUEST_TIMEOUT" });
    await assert.rejects(geo.dispatch("write-article", { questionId: id }), code("AI_REQUEST_TIMEOUT"));
    assert.equal(geo.snapshot().aiPending.length, 1, "超时可能已经扣费");
    geo.dispose();
  }
  {
    // 同时选两个账号，后一个校验不过：一个都不入队，之后的操作也不会把前一个发出去。
    const w = world(), geo = w.make();
    await geo.dispatch("save-brand", brand); await geo.dispatch("add-questions", { text: ["问题一", "问题二"] });
    await geo.dispatch("write-article", { questionId: geo.snapshot().questions[0].id });
    const id = geo.snapshot().articles[0].id;
    await assert.rejects(geo.dispatch("confirm-publish", { articleId: id, targets: [{ platform: "toutiao", accountId: "tt1" }, { platform: "zhihu", accountId: "tt1" }] }), code("GEO_CHANNEL_UNAVAILABLE"));
    assert.equal(geo.snapshot().publications.length, 0, "失败时不留半截队列");
    await geo.dispatch("write-article", { questionId: geo.snapshot().questions[1].id });
    await sleep(20);
    assert.equal(w.log.published.length, 0, "不会被无关操作发出去");
    geo.dispose();
  }
  {
    // 添加问题：中文逗号是问题的一部分，只按换行分开。
    const w = world(), geo = w.make();
    await geo.dispatch("add-questions", { text: "商用洗地机多少钱，哪家售后好\n第二个问题" });
    assert.deepEqual(geo.snapshot().questions.map((item) => item.text), ["商用洗地机多少钱，哪家售后好", "第二个问题"]);
    geo.dispose();
  }
  {
    // 点「停下」：还没点发布的不会发出；排着队的也取消，不会过后悄悄发。
    let release;
    const w = world({ publish: (job) => new Promise((resolve, reject) => { release = () => reject(Object.assign(new Error("已停下"), { code: "GEO_STOPPED" })); job.onDetail("填写中"); }) }), geo = w.make();
    await geo.dispatch("add-article", { title: "一篇", body: "正文" });
    const id = geo.snapshot().articles[0].id;
    await geo.dispatch("confirm-publish", { articleId: id, targets: [{ platform: "toutiao", accountId: "tt1" }] });
    await sleep(10);
    assert.equal(geo.snapshot().publications[0].status, "running");
    await geo.dispatch("add-article", { title: "二篇", body: "正文二" });
    await geo.dispatch("confirm-publish", { articleId: geo.snapshot().articles[0].id, targets: [{ platform: "toutiao", accountId: "tt1" }] });
    await geo.dispatch("stop");
    release();
    const state = await w.idle(geo);
    assert.deepEqual(state.publications.map((item) => item.status), ["failed", "cancelled"]);
    geo.dispose();
  }
  {
    // 查豆包：账号没登录时停下并标记；没选问题不查。
    const w = world({ ask: async () => { throw Object.assign(new Error("豆包需要重新登录"), { code: "GEO_LOGIN_REQUIRED" }); } }), geo = w.make();
    await geo.dispatch("save-brand", brand); await geo.dispatch("add-questions", { text: ["问题一", "问题二"] });
    await assert.rejects(geo.dispatch("check-visibility", { accountId: "db1", questionIds: [] }), code("GEO_QUESTION_REQUIRED"));
    await geo.dispatch("check-visibility", { accountId: "db1", questionIds: geo.snapshot().questions.map((item) => item.id) });
    const state = await w.idle(geo);
    assert.equal(state.visibilityRuns.length, 1, "登录失效后不继续问"); assert.equal(state.visibilityRuns[0].status, "failed");
    assert.deepEqual(w.log.signedOut, ["db1"]); assert.equal(w.log.leases, w.log.released);
    geo.dispose();
  }
  {
    // 软件中断：点过的变结果不明，没点的算没发出；损坏的记录保留原样。
    const w = world(), geo = w.make(); geo.dispose();
    const file = path.join(w.dataDir, "state.json"), saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.publications = [{ id: "p1", status: "running", clickedAt: "2026-11-01T00:00:00Z", accountId: "tt1" }, { id: "p2", status: "running", clickedAt: "", accountId: "tt1" }, { id: "p3", status: "queued", clickedAt: "", accountId: "tt1" }];
    saved.ledger = [{ id: "l1", status: "executing", startedAt: "2026-11-01T00:00:00Z", requestHash: "x" }];
    saved.visibilityRuns = [{ id: "r1", status: "running" }];
    fs.writeFileSync(file, JSON.stringify(saved));
    const state = w.make().snapshot();
    assert.deepEqual(state.publications.map((item) => item.status), ["unknown", "failed", "cancelled"], "重启后排队的取消，不会过几天悄悄发出");
    assert.equal(state.aiPending.length, 1); assert.equal(state.visibilityRuns[0].status, "failed");
    fs.writeFileSync(file, "{broken");
    assert.throws(() => w.make(), code("GEO_STATE_INVALID"));
    assert.equal(fs.readFileSync(file, "utf8"), "{broken");
  }
  console.log("geo workbench self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });
