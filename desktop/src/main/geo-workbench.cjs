const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { promptRef } = require("../shared/prompt-ref.cjs");

// GEO: the company writes down what is true about itself, the AI turns that into articles answering
// the questions customers ask, the user confirms, the software publishes on the user's own media
// accounts, and the AI assistants are asked whether they now mention the company.
// Rules that do not bend: nothing is published without the user's confirmation of that exact text; a
// click whose outcome is not confirmed stays "unknown" and is never redone automatically; a paid AI
// request with an unknown outcome is not repeated until the user asks; verification is left to the user.
// A week's articles may be confirmed at once (user decision 2026-11-26): each keeps its own day and goes
// out only while the software is open, on that exact confirmed text, at most three a day per account.
const fail = (code, message) => Object.assign(new Error(message), { code });
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const str = (value, max = 100_000) => String(value ?? "").trim().slice(0, max);
const list = (value, max = 200, limit = 30) => [...new Set((Array.isArray(value) ? value : str(value).split(/[\n,，、]/)).map((item) => str(item, max)).filter(Boolean))].slice(0, limit);
const clone = (value) => JSON.parse(JSON.stringify(value));
const dayOf = (iso) => { const date = new Date(iso); return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`; };
const DAY = 86_400_000;
const AI_DAILY_LIMIT = 12, PUBLISH_DAILY_LIMIT = 3, MAX_QUESTIONS = 50, WEEK_SIZE = 7, MAX_ASKS = 40, KEEP_RUNS = 1500;
// Scheduled articles go out only in daytime, on their day or later, and expire after a week unsent.
const PUBLISH_HOURS = [8, 22], SCHEDULE_SLOTS = [[9, 30], [11, 20], [14, 40]], STALE_AFTER = 7 * DAY, PUBLISH_GAP = 20 * 60_000;
const REPORT_STATUSES = ["public", "reviewing", "failed", "unknown"];
const ENGINES = [{ id: "doubao", name: "豆包" }, { id: "qianwen", name: "千问" }, { id: "deepseek", name: "DeepSeek" }, { id: "yuanbao", name: "元宝" }];
const PLATFORM_ORDER = ["toutiao", "zhihu", "baijiahao", "sohu"];
const INQUIRY_VIA = ["电话", "微信", "抖音私信", "上门", "其他"];
const INQUIRY_FROM = ["豆包", "千问", "DeepSeek", "元宝", "抖音", "搜公司名", "其他", "不记得"];
// Customers' questions, easiest to win first: a place and a product before a bare "which brand is best".
const GROUPS = ["本地", "场景", "价格", "选购", "售后", "大词"];
// Where a cited page lives, by the address the AI linked to.
const SOURCES = [[/toutiao\.com|toutiaocdn|snssdk\.com/, "今日头条"], [/douyin\.com|iesdouyin\.com/, "抖音"], [/zhihu\.com/, "知乎"], [/baijiahao\.baidu\.com|mbd\.baidu\.com/, "百家号"],
  [/sohu\.com/, "搜狐"], [/mp\.weixin\.qq\.com|weixin\.qq\.com/, "公众号"], [/csdn\.net/, "CSDN"], [/163\.com/, "网易"], [/baike\.baidu\.com/, "百度百科"], [/baidu\.com/, "百度"], [/qq\.com/, "腾讯"],
  [/bilibili\.com/, "B站"], [/xiaohongshu\.com/, "小红书"], [/sina\.com\.cn|sina\.cn|weibo\.com/, "新浪"], [/36kr\.com/, "36氪"], [/chinanews\.com/, "中新网"], [/ifeng\.com/, "凤凰网"], [/people\.com\.cn/, "人民网"], [/xinhuanet\.com|news\.cn/, "新华网"]];
// The request never went out or was plainly refused: nothing was bought, so it is free to try again.
const AI_NOT_SENT = /^(API_KEY_|SECURE_STORAGE_|AI_INPUT_INVALID$|AI_BALANCE_INSUFFICIENT$|AI_RATE_LIMITED$|AI_REQUEST_REJECTED$|PROVIDER_GATEWAY_UNAVAILABLE$)/;
// The AI answered, but with something unusable: it counts, and asking again is safe.
const AI_ANSWERED_BADLY = /^(AI_RESPONSE_|AI_CONTENT_FILTERED$|GEO_AI_INVALID$)/;

function parseJson(text) {
  try { return JSON.parse(String(text).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
  catch { throw fail("GEO_AI_INVALID", "AI 返回的内容不完整，这次没有保存。可以再试一次。"); }
}

function groupOf(text, regions = []) {
  const value = String(text);
  if (/售后|维修|修理|坏了|保养|配件/.test(value)) return "售后";
  if (/多少钱|价格|报价|费用|租金|划算|贵不贵|便宜/.test(value)) return "价格";
  if (regions.some((region) => region && value.includes(region)) || /哪里|附近|本地|同城/.test(value)) return "本地";
  if (/哪个牌子|品牌|排行|排名|哪家好|十大|推荐/.test(value)) return "大词";
  if (/怎么选|如何选|注意|区别|对比|哪个好|还是/.test(value)) return "选购";
  return "场景";
}
function sourceOf(url) {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return { domain: "", source: "" }; }
  const found = SOURCES.find(([pattern]) => pattern.test(host));
  return { domain: host, source: found ? found[1] : host.replace(/^www\./, "") };
}
// The first item of a numbered recommendation list counts as first place; anywhere else is a mention.
function firstItemNames(answer, names) {
  const lines = String(answer).split(/\n+/);
  const start = lines.findIndex((line) => /^\s*(?:\*\*)?\s*(?:1\s*[.、．)）]|一[、.．]|①)/.test(line));
  if (start < 0) return false;
  const next = lines.findIndex((line, index) => index > start && /^\s*(?:\*\*)?\s*(?:2\s*[.、．)）]|二[、.．]|②)/.test(line));
  const block = lines.slice(start, next < 0 ? start + 3 : next).join("\n").toLowerCase();
  return names.some((name) => block.includes(name.toLowerCase()));
}

// Whether an answer names the company, whether first, and which cited pages are this company's published articles.
function classifyVisibility({ answer = "", references, brand, articles, publications }) {
  const names = [brand.name, ...(brand.aliases || [])].filter(Boolean);
  const hits = names.flatMap((name) => { const at = answer.toLowerCase().indexOf(name.toLowerCase()); return at < 0 ? [] : [{ name, snippet: answer.slice(Math.max(0, at - 50), at + name.length + 80) }]; });
  const normal = (value) => { try { const url = new URL(value); url.hash = ""; return url.href; } catch { return ""; } };
  const mentioned = hits.length > 0;
  return { hits, mentioned, rank: !mentioned ? "none" : firstItemNames(answer, names) ? "top" : "mention", referenceStatus: Array.isArray(references) ? "extracted" : "unknown", references: (references || []).map((ref) => {
    const published = publications.find((item) => item.status === "public" && normal(item.url) && normal(item.url) === normal(ref.url));
    const similar = articles.find((item) => item.title && str(ref.title).toLowerCase() === item.title.toLowerCase());
    const url = /^https?:\/\//.test(ref.url || "") ? str(ref.url, 3000) : "";
    return { title: str(ref.title, 1000), url, ...sourceOf(url), association: published ? "confirmed" : similar ? "suspected" : "unmatched", articleId: published?.articleId || similar?.id || null };
  }) };
}

// The numbers the home page shows, from what was recorded: the last seven days per assistant, thirteen weekly
// rates, the company's own articles any assistant cited, where the assistants look, and this month's inquiries.
function computeStats(state, now) {
  const at = (run) => Date.parse(run.finishedAt || run.startedAt || "") || 0;
  const done = state.visibilityRuns.filter((run) => run.status === "completed");
  const recent = done.filter((run) => at(run) > now - 7 * DAY);
  const engines = ENGINES.map(({ id }) => { const runs = recent.filter((run) => (run.engine || "doubao") === id); return { id, asked: runs.length, mentioned: runs.filter((run) => run.mentioned).length, top: runs.filter((run) => run.rank === "top").length }; });
  const trend = [];
  for (let week = 12; week >= 0; week--) {
    const runs = done.filter((run) => at(run) > now - (week + 1) * 7 * DAY && at(run) <= now - week * 7 * DAY);
    trend.push(runs.length ? Math.round(runs.filter((run) => run.mentioned).length / runs.length * 100) : null);
  }
  const cited = new Set(done.flatMap((run) => (run.references || []).filter((ref) => ref.association === "confirmed" && ref.articleId).map((ref) => ref.articleId)));
  const counts = new Map();
  for (const run of (recent.length ? recent : done.slice(-200))) for (const ref of run.references || []) if (ref.source) counts.set(ref.source, (counts.get(ref.source) || 0) + 1);
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  const sources = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => ({ name, share: Math.round(count / total * 100) }));
  const latest = {};
  for (const run of done) {
    if (!run.questionId) continue;
    const key = `${run.questionId}|${run.engine || "doubao"}`;
    if (!latest[key] || at(latest[key]) <= at(run)) latest[key] = run;
  }
  const questions = Object.fromEntries(state.questions.map((question) => [question.id, ENGINES.map(({ id }) => { const run = latest[`${question.id}|${id}`]; return run ? run.rank || (run.mentioned ? "mention" : "none") : ""; })]));
  const month = new Date(now), monthStart = new Date(month.getFullYear(), month.getMonth(), 1).getTime();
  const inquiries = state.inquiries.filter((item) => Date.parse(item.at) >= monthStart);
  return { asked: recent.length, mentioned: recent.filter((run) => run.mentioned).length, top: recent.filter((run) => run.rank === "top").length, engines, trend, cited: cited.size, sources, questions,
    inquiriesThisMonth: inquiries.length, inquiriesFromAi: inquiries.filter((item) => ["豆包", "千问", "DeepSeek", "元宝"].includes(item.from)).length };
}

function createGeoWorkbench({ dataDir, adapter, accounts, generateText, channels, engines = ["doubao"], onChange = () => {}, onFailure = () => {}, clock = () => Date.now(), scheduleEveryMs = 60_000, publishHours = PUBLISH_HOURS }) {
  const file = path.join(dataDir, "state.json");
  const stamp = () => new Date(clock()).toISOString();
  const blank = { version: 1, brand: { version: 0, name: "", aliases: [], regions: [], services: "", cases: "", restrictions: "" }, questions: [], articles: [], publications: [], visibilityRuns: [], ledger: [], inquiries: [], plan: null, pausedDay: "" };
  let state;
  try { state = { ...blank, ...JSON.parse(fs.readFileSync(file, "utf8")) }; }
  catch (error) {
    if (error.code !== "ENOENT") throw fail("GEO_STATE_INVALID", "GEO 记录无法读取，原文件已保留，请通过吐槽中心联系处理。");
    state = clone(blank);
    fs.mkdirSync(dataDir, { recursive: true });
  }
  // Cut off mid-way: a click may have happened; before the click nothing went out.
  for (const item of state.publications) if (item.status === "running") {
    if (item.clickedAt) Object.assign(item, { status: "unknown", reason: "软件中断时已经点了发布，请到平台上看一下是否发出。" });
    else Object.assign(item, { status: "failed", reason: "软件中断，没有发出。" });
  }
  // A confirmed weekly article that was about to go out waits for its turn again; a one-off confirmation lapses.
  for (const item of state.publications) if (item.status === "queued") {
    if (item.dueAt) item.status = "scheduled";
    else Object.assign(item, { status: "cancelled", reason: "软件重新打开过，这次发布已取消。要发请重新确认。" });
  }
  for (const entry of state.ledger) if (entry.status === "executing") Object.assign(entry, { status: "outcome_unknown", finishedAt: stamp() });
  for (const run of state.visibilityRuns) if (run.status === "running") Object.assign(run, { status: "failed", reason: "软件中断，可以再查一次。", finishedAt: stamp() });
  if (state.plan?.status === "writing") Object.assign(state.plan, { status: state.plan.items.length ? "ready" : "stopped", message: "软件中断，写好的几篇留着，没写的不会自动接着写。" });
  let busy = "", progress = null, closed = false, stopping = false, current = null, running = Promise.resolve();
  const save = () => writeJsonAtomic(file, state, { mode: 0o600 });
  const channelList = () => channels.map(({ id, name, available, reason, trial, titleLimit }) => ({ id, name, available: available === true, reason: reason || "", trial: trial === true, titleLimit: titleLimit || 0 }));
  const usage = () => {
    const today = dayOf(stamp());
    return { ai: state.ledger.filter((entry) => entry.status !== "not_sent" && dayOf(entry.startedAt) === today).length, aiLimit: AI_DAILY_LIMIT, publishLimit: PUBLISH_DAILY_LIMIT, weekSize: WEEK_SIZE };
  };
  const publishedToday = (accountId) => state.publications.filter((item) => item.accountId === accountId && item.clickedAt && dayOf(item.clickedAt) === dayOf(stamp()) && item.status !== "failed").length;
  const accountList = () => accounts.snapshot().accounts || [];
  const planView = () => {
    if (!state.plan) return null;
    const plan = state.plan;
    return { ...plan, items: plan.items.map((item) => {
      const article = state.articles.find((row) => row.id === item.articleId);
      const publication = state.publications.find((row) => row.planItemId === item.id && row.status !== "cancelled") || state.publications.filter((row) => row.planItemId === item.id).at(-1);
      return { ...item, title: article?.title || "（文章已删除）", question: article?.question || "", accountLabel: accountList().find((row) => row.id === item.accountId)?.label || "",
        publicationId: publication?.id || "", status: publication?.status || "", reason: publication?.reason || "", url: publication?.url || "" };
    }) };
  };
  const snapshot = () => clone({ brand: state.brand, questions: state.questions.map((question) => ({ ...question, group: groupOf(question.text, state.brand.regions) })), articles: state.articles.map(({ history, ...article }) => article),
    publications: state.publications.map(({ approved, ...item }) => item), visibilityRuns: state.visibilityRuns.slice(-120), inquiries: state.inquiries.slice(-200), plan: planView(),
    stats: computeStats(state, clock()), engines: ENGINES.map((engine) => ({ ...engine, available: engines.includes(engine.id) })), pausedToday: state.pausedDay === dayOf(stamp()),
    usage: usage(), channels: channelList(), aiPending: state.ledger.filter((entry) => entry.status === "outcome_unknown").map(({ id, kind, label, startedAt }) => ({ id, kind, label, startedAt })), busy, progress, accounts: accounts.snapshot() });
  const emit = () => { if (!closed) onChange(snapshot()); };
  const commit = () => { save(); emit(); };
  commit();
  const need = (items, id, message) => { const found = items.find((item) => item.id === id); if (!found) throw fail("GEO_NOT_FOUND", message); return found; };
  const activeAccount = (id, platform) => { const account = accountList().find((item) => item.id === id && item.platform === platform); if (!account || account.status !== "active") throw fail("GEO_ACCOUNT_REQUIRED", "这个账号还没登录，请先扫码。"); return account; };
  const contentHash = (article) => hash({ title: article.title, body: article.body });
  // Any edit voids confirmations of the old text that have not gone out yet.
  const voidQueued = (article) => { for (const item of state.publications) if (item.articleId === article.id && ["queued", "scheduled"].includes(item.status) && item.contentHash !== contentHash(article)) Object.assign(item, { status: "cancelled", reason: "文章改过了，这次发布已取消，请重新确认。" }); };
  const sentBefore = (account, article) => state.publications.some((item) => item.accountId === account.id && item.contentHash === contentHash(article) && !["failed", "cancelled"].includes(item.status));

  async function generate(kind, label, prompt, parse) {
    const requestHash = hash({ kind, prompt });
    if (state.ledger.some((entry) => entry.requestHash === requestHash && entry.status === "outcome_unknown")) throw fail("GEO_AI_PENDING", "上次同样的请求没有等到结果。确认要重新生成，请点「再试一次」。");
    const previous = state.ledger.find((entry) => entry.requestHash === requestHash && entry.status === "completed" && entry.content);
    if (previous) return parse(previous.content);
    if (usage().ai >= AI_DAILY_LIMIT) throw fail("GEO_AI_LIMIT", `今天已经用了 ${AI_DAILY_LIMIT} 次 AI 写作，明天再来。`);
    if (!generateText) throw fail("GEO_AI_UNAVAILABLE", "AI 服务还没有连接，请重新打开软件。");
    const entry = { id: randomUUID(), kind, label: str(label, 200), requestHash, status: "executing", startedAt: stamp(), usage: null };
    state.ledger.push(entry); commit();
    try {
      const result = await generateText({ kind, prompt });
      const content = str(result?.content);
      Object.assign(entry, { finishedAt: stamp(), usage: result?.usage || null });
      if (!content) throw fail("GEO_AI_INVALID", "AI 没有返回内容，可以再试一次。");
      const parsed = parse(content);
      Object.assign(entry, { status: "completed", content });
      save();
      return parsed;
    } catch (error) {
      const code = String(error.code || "");
      entry.status = AI_NOT_SENT.test(code) ? "not_sent" : AI_ANSWERED_BADLY.test(code) ? "unusable" : "outcome_unknown";
      entry.finishedAt = entry.finishedAt || stamp();
      save();
      throw error;
    }
  }
  const brandFacts = () => ({ 公司: state.brand.name, 别名: state.brand.aliases, 服务地区: state.brand.regions, 产品和服务: state.brand.services, 真实案例: state.brand.cases, 不能说的内容: state.brand.restrictions });
  const requireBrand = () => { if (!state.brand.name || !state.brand.services) throw fail("GEO_BRAND_REQUIRED", "请先填好公司名称和卖什么。"); };

  function saveBrand(p) {
    if (!str(p.name, 200)) throw fail("GEO_BRAND_REQUIRED", "请填写公司名称。");
    if (!str(p.services)) throw fail("GEO_BRAND_REQUIRED", "请写一下你卖什么。");
    state.brand = { version: state.brand.version + 1, name: str(p.name, 200), aliases: list(p.aliases), regions: list(p.regions), services: str(p.services, 8000), cases: str(p.cases, 8000), restrictions: str(p.restrictions, 4000), updatedAt: stamp() };
  }
  // Only line breaks separate questions: a comma is part of what the customer asks.
  function addQuestions(texts) {
    for (const text of list(Array.isArray(texts) ? texts : str(texts).split(/\n+/), 200, MAX_QUESTIONS)) {
      if (state.questions.length >= MAX_QUESTIONS) throw fail("GEO_QUESTION_LIMIT", `问题最多 ${MAX_QUESTIONS} 个，先删掉一些。`);
      if (!state.questions.some((item) => item.text === text)) state.questions.push({ id: randomUUID(), text, createdAt: stamp() });
    }
  }
  async function suggestQuestions() {
    requireBrand();
    const text = await generate("geo-questions", "推荐客户问题", `${promptRef("geo.questions.p1")}${JSON.stringify(brandFacts())}`, (content) => {
      const result = parseJson(content);
      if (!Array.isArray(result.questions) || !result.questions.some((item) => typeof item === "string" && item.trim())) throw fail("GEO_AI_INVALID", "AI 没有给出可用的问题，可以再试一次。");
      return result;
    });
    addQuestions(text.questions.filter((item) => typeof item === "string"));
  }
  async function writeFor(question) {
    const written = state.articles.filter((item) => item.questionId === question.id).length;
    const now = new Date(clock());
    const result = await generate("geo-article", question.text, `${promptRef("geo.article_request.p1")}${question.text}」。${written ? `这是第 ${written + 1} 版，请换一个角度和结构来写，不要和前面的版本雷同。` : ""}${promptRef("geo.article_request.p2", 2)}${JSON.stringify(brandFacts())}\n当前年月：${now.getFullYear()} 年 ${now.getMonth() + 1} 月`, (content) => {
      const parsed = parseJson(content);
      if (typeof parsed.title !== "string" || typeof parsed.body !== "string" || !parsed.title.trim() || !parsed.body.trim()) throw fail("GEO_AI_INVALID", "AI 没有写完整，这次没有保存。可以再试一次。");
      return parsed;
    });
    const article = { id: randomUUID(), revision: 1, title: str(result.title, 100), body: str(result.body), questionId: question.id, question: question.text, brandVersion: state.brand.version, createdAt: stamp(), updatedAt: stamp(), history: [] };
    state.articles.unshift(article);
    return article;
  }
  async function writeArticle(p) {
    requireBrand();
    await writeFor(need(state.questions, p.questionId, "没有找到这个问题。"));
  }
  function addArticle(p) {
    if (!str(p.title, 100) || !str(p.body)) throw fail("GEO_ARTICLE_INVALID", "标题和正文都不能空。");
    state.articles.unshift({ id: randomUUID(), revision: 1, title: str(p.title, 100), body: str(p.body), questionId: "", question: "", brandVersion: state.brand.version, createdAt: stamp(), updatedAt: stamp(), history: [] });
  }
  function saveArticle(p) {
    const article = need(state.articles, p.id, "没有找到这篇文章。");
    if (!str(p.title, 100) || !str(p.body)) throw fail("GEO_ARTICLE_INVALID", "标题和正文都不能空。");
    if (article.title === str(p.title, 100) && article.body === str(p.body)) return;
    article.history = [...(article.history || []), { revision: article.revision, title: article.title, body: article.body }].slice(-20);
    Object.assign(article, { revision: article.revision + 1, title: str(p.title, 100), body: str(p.body), updatedAt: stamp() });
    voidQueued(article);
  }
  function removeArticle(p) {
    const article = need(state.articles, p.id, "没有找到这篇文章。");
    if (state.publications.some((item) => item.articleId === article.id && ["running", "queued"].includes(item.status))) throw fail("GEO_ARTICLE_BUSY", "这篇文章正在发布，等发完再删。");
    for (const item of state.publications) if (item.articleId === article.id && item.status === "scheduled") Object.assign(item, { status: "cancelled", reason: "文章删了，这次不发了。", finishedAt: stamp() });
    if (state.plan && state.plan.status !== "confirmed") state.plan.items = state.plan.items.filter((item) => item.articleId !== article.id);
    state.articles = state.articles.filter((item) => item !== article);
  }

  // The user's one confirmation: this exact text, to these accounts. Publishing starts right away.
  function confirmPublish(p) {
    const article = need(state.articles, p.articleId, "没有找到这篇文章。");
    const targets = Array.isArray(p.targets) ? p.targets : [];
    if (!targets.length) throw fail("GEO_TARGET_REQUIRED", "请选择要发到哪个账号。");
    const checked = targets.map(({ platform, accountId }) => {
      const channel = channels.find((item) => item.id === platform);
      if (!channel?.available) throw fail("GEO_CHANNEL_UNAVAILABLE", `${channel?.name || "这个平台"}还没开放发布。`);
      if (channel.titleLimit && article.title.length > channel.titleLimit) throw fail("GEO_TITLE_TOO_LONG", `${channel.name}的标题最多 ${channel.titleLimit} 个字，这篇有 ${article.title.length} 个字。请先改短。`);
      return { platform, account: activeAccount(accountId, platform) };
    });
    let added = 0;
    for (const { platform, account } of checked) {
      // The same text never goes to the same account twice, unless the earlier try is known to have failed.
      if (sentBefore(account, article)) continue;
      state.publications.push({ id: randomUUID(), articleId: article.id, revision: article.revision, title: article.title, platform, accountId: account.id, accountLabel: account.label, contentHash: contentHash(article), approved: { title: article.title, body: article.body }, status: "queued", reason: "", url: "", confirmedAt: stamp(), clickedAt: "", finishedAt: "" });
      added += 1;
    }
    setImmediate(() => void pump());
    return { added };
  }

  // A week of articles: the questions the assistants do not answer with this company yet, the easy ones first,
  // one article each, then spread over seven days on the logged-in accounts the assistants cite most.
  function pickQuestions(count) {
    const now = clock(), stats = computeStats(state, now);
    const recentHit = (question) => (stats.questions[question.id] || []).some((rank) => rank === "top" || rank === "mention");
    const versions = (question) => state.articles.filter((item) => item.questionId === question.id).length;
    const ranked = [...state.questions].sort((a, b) => (versions(a) > 0) - (versions(b) > 0) || recentHit(a) - recentHit(b)
      || GROUPS.indexOf(groupOf(a.text, state.brand.regions)) - GROUPS.indexOf(groupOf(b.text, state.brand.regions)) || versions(a) - versions(b));
    return Array.from({ length: Math.min(count, ranked.length * 2) }, (_, index) => ranked[index % ranked.length]);
  }
  function publishingAccounts() {
    const cited = computeStats(state, clock()).sources.map((item) => item.name);
    const nameOf = (platform) => channels.find((item) => item.id === platform)?.name || "";
    const order = (platform) => { const at = cited.findIndex((name) => nameOf(platform).includes(name) || name.includes(nameOf(platform).replace(/号$/, ""))); return at < 0 ? 50 + PLATFORM_ORDER.indexOf(platform) : at; };
    return accountList().filter((account) => account.status === "active" && channels.some((item) => item.id === account.platform && item.available)).sort((a, b) => order(a.platform) - order(b.platform));
  }
  function slotsFrom(now, count) {
    const first = new Date(now), start = first.getHours() >= 20 ? 1 : 0, slots = [];
    for (let index = 0; index < count; index++) {
      const day = start + Math.floor(index * 7 / count), sameDay = slots.filter((slot) => slot.day === day).length;
      const [hour, minute] = SCHEDULE_SLOTS[Math.min(sameDay, SCHEDULE_SLOTS.length - 1)];
      const at = new Date(first.getFullYear(), first.getMonth(), first.getDate() + day, hour, minute);
      slots.push({ day, due: (at.getTime() < now ? new Date(now + 10 * 60_000) : at).toISOString() });
    }
    return slots;
  }
  function assignPlan() {
    const plan = state.plan, pool = publishingAccounts();
    const slots = slotsFrom(Date.parse(plan.createdAt) || clock(), plan.items.length);
    plan.items.forEach((item, index) => {
      const article = state.articles.find((row) => row.id === item.articleId);
      const fits = pool.filter((account) => { const limit = channels.find((channel) => channel.id === account.platform)?.titleLimit; return !limit || !article || article.title.length <= limit; });
      const account = (fits.length ? fits : pool)[index % (fits.length || pool.length || 1)];
      Object.assign(item, { accountId: account?.id || "", platform: account?.platform || "", due: slots[index].due });
    });
  }
  function planWeek() {
    if (busy) throw fail("GEO_BUSY", "上一件事还没做完，请稍等。");
    requireBrand();
    if (!state.questions.length) throw fail("GEO_QUESTION_REQUIRED", "还没有问题，先加几个客户会问的问题。");
    if (!publishingAccounts().length) throw fail("GEO_ACCOUNT_REQUIRED", "还没有登录发文章的平台，先扫码登录一个。");
    if (state.plan && ["writing", "ready"].includes(state.plan.status) && state.plan.items.length) throw fail("GEO_PLAN_OPEN", "上一批内容还没确认，先确认或者放弃它。");
    const picked = pickQuestions(WEEK_SIZE);
    state.plan = { id: randomUUID(), createdAt: stamp(), status: "writing", total: picked.length, items: [], message: "" };
    busy = "planning"; progress = { done: 0, total: picked.length }; stopping = false;
    commit();
    running = (async () => {
      try {
        for (const question of picked) {
          if (closed || stopping) { state.plan.message = "你点了停下，写好的几篇留着。"; break; }
          try {
            const article = await writeFor(question);
            state.plan.items.push({ id: randomUUID(), articleId: article.id, accountId: "", platform: "", due: "" });
          } catch (error) {
            state.plan.message = /^(GEO_|AI_|API_KEY_|PROVIDER_GATEWAY_)/.test(String(error.code || "")) ? error.message : "这次没写完，写好的几篇留着。";
            break;
          }
          progress.done++; commit();
        }
        state.plan.status = state.plan.items.length ? "ready" : "stopped";
        if (state.plan.items.length) assignPlan();
      } finally { busy = ""; progress = null; commit(); setImmediate(() => { void pump(); tick(); }); }
    })();
  }
  function setPlanItem(p) {
    const plan = state.plan;
    if (!plan || plan.status !== "ready") throw fail("GEO_PLAN_NONE", "没有等你确认的内容。");
    const item = need(plan.items, p.id, "没有找到这一篇。");
    if (p.remove) { plan.items = plan.items.filter((row) => row !== item); return; }
    const account = activeAccount(String(p.accountId || ""), String(p.platform || ""));
    Object.assign(item, { accountId: account.id, platform: account.platform });
  }
  // One confirmation for the whole week: each article's exact text, its account and its day.
  function confirmPlan() {
    const plan = state.plan;
    if (!plan || plan.status !== "ready" || !plan.items.length) throw fail("GEO_PLAN_NONE", "没有等你确认的内容。");
    const checked = plan.items.map((item) => {
      const article = need(state.articles, item.articleId, "有一篇文章已经删了，请重新排一次。");
      const channel = channels.find((row) => row.id === item.platform);
      if (!Number.isFinite(Date.parse(item.due))) throw fail("GEO_PLAN_DAY_MISSING", `《${article.title}》还没排上哪天发，请重新排一次。`);
      if (!channel?.available) throw fail("GEO_CHANNEL_UNAVAILABLE", `《${article.title}》要发的平台还没开放，请换一个账号。`);
      if (channel.titleLimit && article.title.length > channel.titleLimit) throw fail("GEO_TITLE_TOO_LONG", `《${article.title}》在${channel.name}标题最多 ${channel.titleLimit} 个字，请先改短。`);
      return { item, article, account: activeAccount(item.accountId, item.platform) };
    });
    for (const { item, article, account } of checked) {
      if (sentBefore(account, article)) continue;
      state.publications.push({ id: randomUUID(), articleId: article.id, revision: article.revision, title: article.title, platform: item.platform, accountId: account.id, accountLabel: account.label, contentHash: contentHash(article), approved: { title: article.title, body: article.body },
        status: "scheduled", dueAt: item.due, planId: plan.id, planItemId: item.id, reason: "", url: "", confirmedAt: stamp(), clickedAt: "", finishedAt: "" });
    }
    Object.assign(plan, { status: "confirmed", confirmedAt: stamp(), message: "" });
    setImmediate(tick);
  }
  function discardPlan() {
    if (!state.plan || state.plan.status === "confirmed") throw fail("GEO_PLAN_NONE", "没有等你确认的内容。");
    if (state.plan.status === "writing") throw fail("GEO_BUSY", "正在写，先点停下。");
    state.plan = null;
  }
  // Every minute while the software is open: at most one due article is handed to the publisher at a time.
  function tick() {
    if (closed || busy) return;
    const now = clock(), hour = new Date(now).getHours();
    let changed = false;
    for (const item of state.publications) if (item.status === "scheduled" && now - Date.parse(item.dueAt) > STALE_AFTER) {
      Object.assign(item, { status: "cancelled", reason: "过了一周还没发出（这段时间软件没开着），这次取消了。要发请重新确认。", finishedAt: stamp() });
      changed = true;
    }
    if (hour >= publishHours[0] && hour < publishHours[1] && state.pausedDay !== dayOf(stamp())) {
      const active = new Set(accountList().filter((account) => account.status === "active").map((account) => account.id));
      // After days with the software closed, overdue articles go out one by one with a gap per account, not in a burst.
      const recent = (accountId) => state.publications.some((row) => row.accountId === accountId && row.finishedAt && now - Date.parse(row.finishedAt) < PUBLISH_GAP);
      const due = state.publications.filter((item) => item.status === "scheduled" && Date.parse(item.dueAt) <= now && active.has(item.accountId) && publishedToday(item.accountId) < PUBLISH_DAILY_LIMIT && !recent(item.accountId))
        .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))[0];
      if (due) { due.status = "queued"; changed = true; }
    }
    if (changed) { commit(); setImmediate(() => void pump()); }
  }
  async function pump() {
    if (busy || closed) return;
    const next = state.publications.find((item) => item.status === "queued");
    if (!next) return;
    busy = "publish"; stopping = false; current = next;
    let finish;
    running = new Promise((resolve) => { finish = resolve; });
    try {
      for (let item = next; item && !closed && !stopping; item = state.publications.find((row) => row.status === "queued")) {
        current = item;
        await publishOne(item);
      }
    } finally { busy = ""; current = null; commit(); finish(); }
  }
  // The page as it stopped goes to the diagnostics only; the publication record keeps no picture.
  const report = (item, code, evidence) => {
    try { onFailure({ platform: item.platform, code, step: evidence?.step || "unknown", clicked: Boolean(item.clickedAt), pageUrl: evidence?.pageUrl || "", screenshot: evidence?.screenshot || "", notices: evidence?.notices || [] }); }
    catch { /* Diagnostics never change the publication. */ }
  };
  async function publishOne(item) {
    const article = state.articles.find((row) => row.id === item.articleId);
    if (!article || contentHash(article) !== item.contentHash) return Object.assign(item, { status: "cancelled", reason: "文章改过了，这次发布已取消，请重新确认。", finishedAt: stamp() });
    if (publishedToday(item.accountId) >= PUBLISH_DAILY_LIMIT) {
      if (item.dueAt) return Object.assign(item, { status: "scheduled", reason: `这个账号今天已发 ${PUBLISH_DAILY_LIMIT} 篇，明天接着发。` });
      return Object.assign(item, { status: "cancelled", reason: `这个账号今天已发 ${PUBLISH_DAILY_LIMIT} 篇，明天再发，避免被平台当成灌水。`, finishedAt: stamp() });
    }
    Object.assign(item, { status: "running", reason: "" }); commit();
    let release;
    try {
      release = accounts.lease(item.accountId);
      const result = await adapter.publish({ platform: item.platform, profileDir: accounts.profileDir(item.accountId), title: item.approved.title, body: item.approved.body, aiWritten: Boolean(article.questionId),
        shouldStop: () => closed || stopping,
        onDetail: (detail) => { item.detail = str(detail, 200); commit(); },
        beforeClick: () => { item.clickedAt = stamp(); commit(); } });
      const reported = REPORT_STATUSES.includes(result?.status) ? result.status : "unknown";
      const status = reported === "failed" && item.clickedAt ? "unknown" : reported;
      // Sohu and Baijiahao always answer "submitted, please check" after a normal submit: that is not a fault.
      // Only a publish the platform never confirmed carries the page with it, and only that one is reported.
      if (status === "unknown" && result?.evidence) report(item, "GEO_RESULT_UNCONFIRMED", result.evidence);
      Object.assign(item, { status, url: /^https?:\/\//.test(result?.url || "") ? str(result.url, 3000) : "", reason: str(result?.reason, 500), finishedAt: stamp() });
    } catch (error) {
      // The account's window is in use (signing in again, refreshing): nothing was clicked, so a scheduled article just waits.
      const waitable = !item.clickedAt && item.dueAt && error.code === "SOCIAL_ACCOUNT_BUSY";
      if (error.code !== "GEO_STOPPED" && !waitable) report(item, /^GEO_/.test(String(error.code || "")) ? error.code : "GEO_UNEXPECTED", error.evidence);
      if (error.code === "GEO_LOGIN_REQUIRED") accounts.markSignedOut?.(item.accountId);
      if (item.clickedAt) Object.assign(item, { status: "unknown", reason: "已经点了发布，但之后出了问题。请到平台上看一下是否发出，不会自动重发。", finishedAt: stamp() });
      // A scheduled article that never reached the button keeps its confirmation: after the user signs in again,
      // or the next day when the user stopped it.
      else if (item.dueAt && error.code === "GEO_LOGIN_REQUIRED") Object.assign(item, { status: "scheduled", reason: "账号要重新扫码登录，登录后接着发。" });
      else if (waitable) Object.assign(item, { status: "scheduled", reason: "这个账号正在用（比如在重新登录），稍后接着发。" });
      else if (item.dueAt && error.code === "GEO_STOPPED") Object.assign(item, { status: "scheduled", reason: "你点了停下，明天接着发。" });
      else Object.assign(item, { status: "failed", reason: /^(GEO|SOCIAL)_/.test(String(error.code || "")) ? error.message : "这次没发出去，可以再试一次。", finishedAt: stamp() });
    } finally { release?.(); delete item.detail; commit(); }
  }
  // Only the user settles an unknown result, after looking on the platform.
  function resolvePublication(p) {
    const item = need(state.publications, p.id, "没有找到这条发布记录。");
    if (item.status !== "unknown" && item.status !== "reviewing") throw fail("GEO_PUBLICATION_SETTLED", "这条记录已经有结果了。");
    if (!["public", "failed"].includes(p.outcome)) throw fail("GEO_PUBLICATION_OUTCOME", "结果不对。");
    Object.assign(item, { status: p.outcome, reason: p.outcome === "public" ? "你确认已发出。" : "你确认没有发出。", url: /^https?:\/\//.test(p.url || "") ? str(p.url, 3000) : item.url, finishedAt: stamp() });
  }
  function cancelScheduled(p) {
    const item = need(state.publications, p.id, "没有找到这条发布记录。");
    if (item.status !== "scheduled") throw fail("GEO_PUBLICATION_SETTLED", "这篇已经不在计划里了。");
    Object.assign(item, { status: "cancelled", reason: "你取消了这一篇。", finishedAt: stamp() });
  }

  // Each logged-in assistant is asked every chosen question in turn; an assistant whose account needs signing
  // in again or shows a check stops being asked this round, the others go on.
  function checkVisibility(p) {
    if (busy) throw fail("GEO_BUSY", "上一件事还没做完，请稍等。");
    if (!state.brand.name) throw fail("GEO_BRAND_REQUIRED", "请先填好公司名称。");
    const askers = p.accountId ? [accountList().find((item) => item.id === p.accountId && engines.includes(item.platform) && item.status === "active")].filter(Boolean)
      : engines.map((engine) => accountList().find((item) => item.platform === engine && item.status === "active")).filter(Boolean);
    if (!askers.length) throw fail("GEO_ACCOUNT_REQUIRED", p.accountId ? "这个账号还没登录，请先扫码。" : "还没有登录可以查的 AI，先扫码登录豆包。");
    const questions = Array.isArray(p.questionIds) ? state.questions.filter((item) => p.questionIds.includes(item.id)) : state.questions;
    if (!questions.length) throw fail("GEO_QUESTION_REQUIRED", Array.isArray(p.questionIds) ? "请选择要查的问题。" : "还没有问题，先加几个客户会问的问题。");
    const perEngine = Math.max(1, Math.floor(MAX_ASKS / askers.length)), chosen = questions.slice(0, perEngine);
    busy = "visibility"; progress = { done: 0, total: chosen.length * askers.length }; stopping = false;
    emit();
    running = (async () => {
      try {
        for (const account of askers) {
          if (closed || stopping) break;
          let release;
          try {
            release = accounts.lease(account.id);
            for (const question of chosen) {
              if (closed || stopping) break;
              const run = { id: randomUUID(), questionId: question.id, question: question.text, engine: account.platform, accountId: account.id, status: "running", brandName: state.brand.name, startedAt: stamp(), finishedAt: "" };
              state.visibilityRuns.push(run); commit();
              try {
                const result = await adapter.ask({ engine: account.platform, profileDir: accounts.profileDir(account.id), question: question.text, shouldStop: () => closed || stopping });
                if (!str(result?.answer)) throw fail("GEO_ANSWER_EMPTY", "没有读到回答，可以再查一次。");
                Object.assign(run, { status: "completed", answer: str(result.answer, 20_000), ...classifyVisibility({ answer: result.answer, references: result.references, brand: state.brand, articles: state.articles, publications: state.publications }) });
              } catch (error) {
                if (error.code === "GEO_LOGIN_REQUIRED") accounts.markSignedOut?.(account.id);
                Object.assign(run, { status: "failed", reason: /^(GEO|SOCIAL)_/.test(String(error.code || "")) ? error.message : "这次没查成，可以再查一次。" });
                if (/LOGIN|VERIFY/.test(String(error.code))) { run.finishedAt = stamp(); progress.done = Math.min(progress.total, progress.done + 1); break; }
              }
              run.finishedAt = stamp(); progress.done = Math.min(progress.total, progress.done + 1); commit();
            }
          } catch (error) {
            state.visibilityRuns.push({ id: randomUUID(), question: chosen[0].text, engine: account.platform, accountId: account.id, status: "failed", reason: /^(GEO|SOCIAL)_/.test(String(error.code || "")) ? error.message : "这次没查成，可以再查一次。", startedAt: stamp(), finishedAt: stamp() });
          } finally { release?.(); }
        }
      } finally {
        if (state.visibilityRuns.length > KEEP_RUNS) state.visibilityRuns = state.visibilityRuns.slice(-KEEP_RUNS);
        busy = ""; progress = null; commit(); setImmediate(() => { void pump(); tick(); });
      }
    })();
  }
  function addInquiry(p) {
    state.inquiries.push({ id: randomUUID(), at: stamp(), via: INQUIRY_VIA.includes(p.via) ? p.via : "其他", from: INQUIRY_FROM.includes(p.from) ? p.from : "不记得", note: str(p.note, 500) });
    if (state.inquiries.length > 2000) state.inquiries = state.inquiries.slice(-2000);
  }

  const quick = {
    "save-brand": saveBrand,
    "add-questions": (p) => addQuestions(p.text),
    "remove-question": (p) => { state.questions = state.questions.filter((item) => item.id !== p.id); },
    "add-article": addArticle,
    "save-article": saveArticle,
    "remove-article": removeArticle,
    "confirm-publish": confirmPublish,
    "resolve-publication": resolvePublication,
    "cancel-scheduled": cancelScheduled,
    "check-visibility": checkVisibility,
    "plan-week": planWeek,
    "set-plan-item": setPlanItem,
    "confirm-plan": confirmPlan,
    "discard-plan": discardPlan,
    "add-inquiry": addInquiry,
    "remove-inquiry": (p) => { state.inquiries = state.inquiries.filter((item) => item.id !== p.id); },
    "resume-schedule": () => { state.pausedDay = ""; setImmediate(tick); },
    "retry-ai": (p) => { const entry = need(state.ledger, p.id, "没有找到这条记录。"); if (entry.status !== "outcome_unknown") throw fail("GEO_AI_SETTLED", "这条记录已经有结果了。"); entry.status = "abandoned"; },
    stop: () => {
      // Stopping a publish holds today's scheduled articles until tomorrow; one-off confirmations not started are dropped.
      if (busy === "publish" && state.publications.some((item) => item.status === "scheduled" || (item.status === "queued" && item.dueAt) || (item === current && item.dueAt))) state.pausedDay = dayOf(stamp());
      stopping = true;
      for (const item of state.publications) if (item.status === "queued") {
        if (item.dueAt) item.status = "scheduled";
        else Object.assign(item, { status: "cancelled", reason: "你点了停下，这篇没有发。", finishedAt: stamp() });
      }
      adapter?.stop?.();
    }
  };
  const slow = { "suggest-questions": suggestQuestions, "write-article": writeArticle };
  async function dispatch(action, payload = {}) {
    if (closed) throw fail("GEO_CLOSED", "GEO 已关闭。");
    if (action === "status") return snapshot();
    if (quick[action]) { const result = quick[action](payload); commit(); return { ...snapshot(), result }; }
    if (!slow[action]) throw fail("GEO_ACTION_INVALID", "不支持这个操作。");
    if (busy) throw fail("GEO_BUSY", "上一件事还没做完，请稍等。");
    busy = "writing"; emit();
    try { await slow[action](payload); }
    finally { busy = ""; commit(); setImmediate(() => { void pump(); tick(); }); }
    return snapshot();
  }
  // A week cut off mid-way never got its accounts and days: hand them out now, the same way a finished week does.
  if (state.plan?.status === "ready" && state.plan.items.some((item) => !item.due)) { assignPlan(); save(); }
  const timer = scheduleEveryMs > 0 ? setInterval(tick, scheduleEveryMs) : null;
  timer?.unref?.();
  const first = scheduleEveryMs > 0 ? setTimeout(tick, Math.min(15_000, scheduleEveryMs)) : null;
  first?.unref?.();
  return { dispatch, snapshot, tick, isBusy: () => Boolean(busy), emit, async dispose() { closed = true; stopping = true; clearInterval(timer); clearTimeout(first); adapter?.stop?.(); await running.catch(() => {}); adapter?.dispose?.(); } };
}

module.exports = { createGeoWorkbench, classifyVisibility, computeStats, groupOf, AI_DAILY_LIMIT, PUBLISH_DAILY_LIMIT, WEEK_SIZE };
