const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { findBrowser, launchBrowser } = require("./social-browser.cjs");
const { pageFor, sleep, classes } = require("./social-page.cjs");
const { captureResponses } = require("./social-capture.cjs");
const drivers = require("./social-acquire-drivers.cjs");

const fail = (code, message) => Object.assign(new Error(message), { code });
const stamp = () => new Date().toISOString();
const userMessage = (error, fallback) => /^(ACQUIRE|SOCIAL)_/.test(String(error?.code || "")) ? error.message : fallback;
const CAPTCHA = /验证码|滑块|拖动|安全验证|安全检测|形状相同|完成验证/;
// A shown verification iframe or popup; page text alone can mention 滑块 in a caption.
const CAPTCHA_PROBE = `(() => { const shown = (el) => el.getClientRects().length > 0;
  return [...document.querySelectorAll("iframe")].some((frame) => /captcha|verify/i.test(frame.src) && shown(frame))
    || [...document.querySelectorAll('[class*="captcha" i],[id*="captcha" i],[class*="verify-" i]')].some(shown); })()`;
const words = (value, max, limit) => [...new Set((Array.isArray(value) ? value : String(value || "").split(/[\n,，、\s]+/)).map((item) => String(item).trim().slice(0, max)).filter(Boolean))].slice(0, limit);
const lines = (value, max, limit) => [...new Set(String(value || "").split(/\r?\n/).map((item) => item.replace(/\s+/g, " ").trim().slice(0, max)).filter(Boolean))].slice(0, limit);
const KINDS = ["like", "follow", "comment"];
// Per account per day. The defaults stay well under what a person would do by hand.
const DEFAULT_CAPS = { like: 60, follow: 30, comment: 15 }, MAX_CAPS = { like: 200, follow: 100, comment: 50 };
const ACTION_NAMES = { like: "点赞", follow: "关注", comment: "留言" };
const KEEP = { collect: "找到的线索都保留了", comment: "已发的留言都有记录", actions: "做过的都有记录" };
const dayOf = (ms) => { const date = new Date(ms); return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`; };
const nextMidnight = (ms) => { const date = new Date(ms); date.setHours(24, 0, 0, 0); return date.toISOString(); };

// Finds people whose comments on keyword-matched videos show buying intent, and, when the
// user asks, likes their comment, follows them or leaves a comment under peer videos. Every
// outward action is recorded before it is clicked; one the platform does not confirm stays
// "unknown" and is never redone automatically. Platform verification is left to the user,
// and an account the platform says is too busy rests until the next day.
function createSocialAcquisition({ dataDir, accounts, launch = launchBrowser, executable = findBrowser(), driverFor = drivers.acquireDriverFor, capture: makeCapture = captureResponses, makePage = pageFor,
  onChange = () => {}, now = () => Date.now(), timing = {}, random = Math.random }) {
  const wait = { response: 15_000, verify: 10 * 60_000, poll: 1500, gapMin: 5000, gapMax: 10_000, actionGapMin: 25_000, actionGapMax: 60_000, commentGapMin: 60_000, commentGapMax: 120_000, scroll: 600, recheck: 8000, ...timing };
  const stateFile = path.join(dataDir, "state.json");
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (state?.version !== 1 || !["tasks", "runs", "leads"].every((key) => Array.isArray(state[key]))) throw new Error("invalid state");
  } catch (error) {
    if (error.code !== "ENOENT") throw fail("ACQUIRE_STATE_INVALID", "关键词获客记录无法读取，原文件已保留，请通过吐槽中心联系处理。");
    state = { version: 1, tasks: [], runs: [], leads: [] };
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!Array.isArray(state.actions)) state.actions = [];
  if (!state.settings || typeof state.settings !== "object") state.settings = {};
  state.settings.caps = { ...DEFAULT_CAPS, ...state.settings.caps };
  if (!state.pauses || typeof state.pauses !== "object") state.pauses = {};
  for (const run of state.runs) if (["running", "needs_user"].includes(run.status)) Object.assign(run, { status: "stopped", reason: `软件中断，${KEEP[run.kind || "collect"]}。`, finishedAt: stamp() });
  // An action cut off after its click may have happened; one cut off before it did not.
  for (const action of state.actions) if (action.status === "running") {
    if (action.clickedAt) Object.assign(action, { status: "unknown", reason: "软件中断时已经点下，请到平台上看一下是否成功。" });
    else Object.assign(action, action.kind === "comment" ? { status: "cancelled", reason: "软件中断，没有发出。" } : { status: "queued", reason: "" });
  }
  writeJsonAtomic(stateFile, state);
  let active = null, closed = false;
  const save = () => writeJsonAtomic(stateFile, state);
  const paused = (accountId) => Date.parse(state.pauses[accountId] || "") > now();
  const used = (accountId, kind) => state.actions.filter((action) => action.accountId === accountId && action.kind === kind && action.clickedAt && ["running", "done", "unknown", "hidden"].includes(action.status) && dayOf(Date.parse(action.clickedAt)) === dayOf(now())).length;
  const room = (accountId, kind) => used(accountId, kind) < state.settings.caps[kind];
  function snapshot() {
    const today = {};
    for (const accountId of new Set(state.actions.map((action) => action.accountId))) today[accountId] = { like: used(accountId, "like"), follow: used(accountId, "follow"), comment: used(accountId, "comment"), pausedUntil: paused(accountId) ? state.pauses[accountId] : "" };
    return { tasks: state.tasks, runs: state.runs.slice(0, 50), leads: state.leads.slice(0, 2000), actions: state.actions.filter((action, index) => index < 3000 || ["queued", "running", "unknown"].includes(action.status)), caps: state.settings.caps, today, running: active?.run.id || "" };
  }
  const emit = () => { if (!closed) onChange(snapshot()); };
  const findTask = (id) => { const task = state.tasks.find((item) => item.id === id); if (!task) throw fail("ACQUIRE_TASK_NOT_FOUND", "没有找到这个任务。"); return task; };
  const activeAccount = (platform, accountId) => accounts.snapshot().accounts.find((item) => item.id === accountId && item.platform === platform && item.status === "active");

  function saveTask(input = {}) {
    const platform = String(input.platform || "kuaishou");
    driverFor(platform);
    const account = activeAccount(platform, input.accountId);
    if (!account) throw fail("ACQUIRE_ACCOUNT_REQUIRED", "请选择一个已登录的账号。");
    const keywords = words(input.keywords, 20, 30);
    if (!keywords.length) throw fail("ACQUIRE_KEYWORDS_REQUIRED", "请至少填写一个关键词。");
    const mode = input.mode === "comment" ? "comment" : "collect";
    const texts = lines(input.texts, 200, 10);
    if (mode === "comment" && !texts.length) throw fail("ACQUIRE_TEXTS_REQUIRED", "请至少写一条留言内容。");
    const days = [1, 3, 7, 30, 90].includes(Number(input.days)) ? Number(input.days) : 30;
    const maxVideos = Math.min(50, Math.max(1, Math.round(Number(input.maxVideos) || 10)));
    const maxComments = Math.min(20, Math.max(1, Math.round(Number(input.maxComments) || 5)));
    const task = input.id ? findTask(String(input.id)) : null;
    if (task && active?.task === task) throw fail("ACQUIRE_TASK_RUNNING", "任务正在运行，停下后再改。");
    const fields = { name: String(input.name || "").trim().slice(0, 40) || keywords.slice(0, 3).join("、"), mode, platform, accountId: account.id, accountLabel: account.label,
      keywords, intentWords: words(input.intentWords, 12, 30), days, maxVideos, allComments: input.allComments === true, skipAuthor: input.skipAuthor !== false,
      texts: mode === "comment" ? texts : [], maxComments, updatedAt: stamp() };
    if (task) Object.assign(task, fields);
    else state.tasks.unshift({ id: crypto.randomUUID(), createdAt: stamp(), lastRunAt: "", ...fields });
    save(); emit();
    return snapshot();
  }
  function removeTask(id) {
    const task = findTask(id);
    if (active?.task === task) throw fail("ACQUIRE_TASK_RUNNING", "任务正在运行，停下后再删。");
    state.tasks = state.tasks.filter((item) => item !== task); save(); emit(); return snapshot();
  }
  function saveCaps(input = {}) {
    for (const kind of KINDS) if (input[kind] !== undefined) state.settings.caps[kind] = Math.min(MAX_CAPS[kind], Math.max(0, Math.round(Number(input[kind]) || 0)));
    save(); emit(); return snapshot();
  }

  // One lead per person per platform: the first comment that showed intent is kept.
  function addLead(task, keyword, video, comment, signals) {
    const exists = state.leads.find((lead) => lead.platform === task.platform && lead.userId === comment.userId);
    if (exists) return false;
    state.leads.unshift({ id: crypto.randomUUID(), taskId: task.id, platform: task.platform, accountId: task.accountId, keyword,
      videoId: video.id, videoTitle: video.title, videoUrl: driverFor(task.platform).videoUrl(video.id), videoAuthor: video.authorName,
      commentId: comment.id, userId: comment.userId, userName: comment.userName, comment: comment.text, commentAt: comment.at, region: comment.region || "",
      signals, status: "new", createdAt: stamp() });
    state.leads = state.leads.slice(0, 20_000);
    return true;
  }

  // The account's own Chrome with the page's own responses recorded, and the waits every run shares.
  async function openSession(control) {
    const { run, driver } = control;
    const update = (patch) => { Object.assign(run, patch); save(); emit(); };
    const browser = control.browser = launch({ executable, profileDir: accounts.profileDir(control.accountId) });
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
    await browser.send("DOM.enable", {}, sessionId);
    const page = makePage(browser, sessionId);
    const searches = [], comments = [], results = [];
    const acts = driver.actions || {};
    const isAction = (url, operation) => Boolean(acts.isLike?.(url, operation) || acts.isFollow?.(url) || acts.isCommentAdd?.(url, operation));
    const capture = makeCapture(browser, sessionId, {
      match: (url, operation) => driver.isSearch(url) || driver.isComments(url, operation) || isAction(url, operation),
      onJson: ({ url, operation, variables, json }) => {
        if (driver.isSearch(url)) searches.push(driver.parseSearch(json));
        else if (driver.isComments(url, operation)) comments.push({ photoId: String(variables?.photoId || ""), ...driver.parseComments(json) });
        else results.push({ url, operation, variables: variables || {}, json });
      }
    });
    await capture.start();
    const shouldStop = control.shouldStop;
    const visible = async () => String(await page.evaluate("document.body ? document.body.innerText.slice(0, 4000) : ''").catch(() => "") || "");
    // Waits for the page's own data. Only while it has not arrived is the page checked for a
    // platform verification (left to the user; the run waits) or a logged-out page, so words
    // like 滑块 in captions and comments are never mistaken for a verification.
    const load = async (where, arrived) => {
      let deadline = now() + wait.response, verifyUntil = 0;
      while (!shouldStop() && !await arrived()) {
        // Text is only trusted once the data is overdue, when the page is likely showing nothing else.
        const blocked = Boolean(await page.evaluate(CAPTCHA_PROBE).catch(() => false)) || (now() > deadline && CAPTCHA.test(await visible()));
        if (blocked && !verifyUntil) {
          verifyUntil = now() + wait.verify;
          await page.front(); update({ status: "needs_user", detail: `${driver.name}要求验证：请在弹出的 Chrome 窗口里完成验证，完成后会自动继续。` });
        } else if (blocked && now() > verifyUntil) throw fail("ACQUIRE_VERIFY_TIMEOUT", `${where}的验证 10 分钟内没有完成，已停下。${KEEP[run.kind]}。`);
        else if (!blocked && verifyUntil) { verifyUntil = 0; deadline = now() + wait.response; update({ status: "running", detail: "" }); }
        else if (!blocked && now() > deadline) break;
        await sleep(wait.poll);
      }
      if (run.status === "needs_user") update({ status: "running", detail: "" });
      if (await arrived() || shouldStop()) return true;
      if (driver.loggedOutText.test(await visible())) throw fail("ACQUIRE_LOGIN_REQUIRED", `${driver.name}网页版需要重新扫码登录（账号「${control.accountLabel}」）。`);
      return false;
    };
    const more = async (list, from) => { const deadline = now() + wait.response; while (list.length <= from && now() < deadline && !shouldStop()) await sleep(300); };
    async function search(keyword, max) {
      const before = searches.length;
      await page.navigate(driver.searchUrl(keyword));
      await load(`搜索「${keyword}」`, () => searches.length > before);
      let videos = searches.slice(before).flatMap((result) => result.videos);
      // More results load as the list scrolls, the same as a person scrolling.
      for (let i = 0; i < 4 && videos.length < max && searches.at(-1)?.more && !shouldStop(); i++) {
        const count = searches.length;
        await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 480, deltaX: 0, deltaY: 1200 });
        await more(searches, count);
        videos = searches.slice(before).flatMap((result) => result.videos);
      }
      return [...new Map(videos.map((video) => [video.id, video])).values()].slice(0, max);
    }
    // Each comment response names its video; a late one from the previous page is not counted.
    async function openVideo(videoId) {
      const mark = comments.length;
      const mine = () => comments.slice(mark).filter((result) => !result.photoId || result.photoId === videoId);
      await page.navigate(driver.videoUrl(videoId));
      await load("打开视频", () => mine().length > 0);
      return mine();
    }
    // The element's centre, but only where the element itself is on top: the video page can lay
    // a panel toggle over the comment list, and a click there would land on the toggle instead.
    async function pointOf(expression) {
      for (const block of ["center", "start", "end", "nearest"]) {
        if (!await page.evaluate(`(() => { const el = ${expression}; if (!el) return false; el.scrollIntoView({ block: "${block}" }); return true; })()`)) return null;
        await sleep(wait.scroll);
        const spot = await page.evaluate(`(() => { const el = ${expression}; if (!el) return null; const r = el.getBoundingClientRect(); if (!r.width || !r.height) return null;
          const x = r.x + r.width / 2, y = r.y + r.height / 2, top = document.elementFromPoint(x, y); return top && (top === el || el.contains(top)) ? { x, y } : null; })()`);
        if (spot) return spot;
      }
      return null;
    }
    // The platform's answer to the action clicked after `mark`, waiting through a verification.
    async function answer(mark, predicate, where) {
      const found = () => results.slice(mark).find(predicate);
      await load(where, () => Boolean(found()));
      return found();
    }
    return { page, update, load, search, openVideo, pointOf, answer, results, comments, more };
  }

  const ensureNotBusy = () => { if (active) throw fail("ACQUIRE_BUSY", "已经有一个任务在运行，等它结束或先停下。"); };
  function begin({ kind, task = null, platform, accountId, accountLabel, body }) {
    ensureNotBusy();
    const driver = driverFor(platform);
    accounts.lease(accountId)();
    const run = { id: crypto.randomUUID(), kind, taskId: task?.id || "", accountId, accountLabel, status: "running", detail: "准备打开浏览器", videos: 0, comments: 0, leads: 0, sent: 0, failed: 0, reason: "", startedAt: stamp(), finishedAt: "" };
    state.runs.unshift(run); state.runs = state.runs.slice(0, 200);
    if (task) task.lastRunAt = stamp();
    save();
    const control = { task, run, driver, accountId, accountLabel, stop: false, rest: "" };
    control.shouldStop = () => control.stop || closed || Boolean(control.rest);
    active = control; emit();
    control.done = execute(control, body).catch(() => {}).finally(() => { if (active === control) active = null; emit(); if (!closed && kind === "actions" && run.status === "done") pump({ quiet: true }); });
    return snapshot();
  }
  async function execute(control, body) {
    const { run } = control;
    const release = accounts.lease(control.accountId);
    let session;
    try {
      session = await openSession(control);
      await body(session, control);
      const stopped = control.stop || closed;
      session.update({ status: stopped ? "stopped" : "done", detail: "", reason: control.rest || (stopped ? `已停下，${KEEP[run.kind]}。` : ""), finishedAt: stamp() });
    } catch (error) {
      const patch = control.stop || closed ? { status: "stopped", reason: `已停下，${KEEP[run.kind]}。` } : { status: "failed", reason: userMessage(error, `运行中出错，${KEEP[run.kind]}，可以再次开始。`) };
      Object.assign(run, patch, { detail: "", finishedAt: stamp() }); save(); emit();
    } finally {
      await control.browser?.close().catch(() => {});
      release();
    }
  }
  const gap = async (control, min, max) => { const until = now() + min + random() * (max - min); while (now() < until && !control.shouldStop()) await sleep(Math.min(1000, Math.max(1, until - now()))); };

  async function collect(session, control) {
    const { task, run } = control;
    const since = now() - task.days * 86_400_000;
    for (const keyword of task.keywords) {
      if (control.shouldStop()) break;
      session.update({ detail: `搜索「${keyword}」` });
      const videos = await session.search(keyword, task.maxVideos);
      for (const video of videos) {
        if (control.shouldStop()) break;
        // A pause between videos keeps the pace of a person reading, and the load on the platform low.
        await gap(control, wait.gapMin, wait.gapMax);
        if (control.shouldStop()) break;
        session.update({ detail: `「${keyword}」读评论：${video.title.slice(0, 20) || video.id}` });
        const found = await session.openVideo(video.id);
        if (control.shouldStop()) break;
        run.videos += 1;
        for (const result of found) for (const comment of result.comments) {
          if (task.skipAuthor && comment.userId === video.authorId) continue;
          if (comment.at && Date.parse(comment.at) < since) continue;
          const signals = drivers.intentOf(comment.text, task.intentWords);
          if (!signals.length && !task.allComments) continue;
          run.comments += 1;
          if (addLead(task, keyword, video, comment, signals.length ? signals : ["全部评论"])) run.leads += 1;
        }
        session.update({});
      }
    }
  }

  // ---- Outward actions ----
  const newAction = (fields) => ({ id: crypto.randomUUID(), status: "queued", reason: "", createdAt: stamp(), clickedAt: "", finishedAt: "", already: false, ...fields });
  const settleAction = (session, action, patch) => { Object.assign(action, patch, { finishedAt: stamp() }); session.update({}); };
  // The platform refused: nothing happened. Too-frequent rests the account until tomorrow,
  // and a lead action goes back in the queue for then.
  function refused(session, control, action, message) {
    if (drivers.TOO_FREQUENT.test(message)) {
      state.pauses[action.accountId] = nextMidnight(now());
      control.rest = `${control.driver.name}提示操作太频繁，这个账号今天先停下，明天再继续。`;
      settleAction(session, action, action.kind === "comment" ? { status: "failed", reason: `平台提示：${message}` } : { status: "queued", clickedAt: "", reason: "平台提示操作频繁，明天再做。" });
    } else settleAction(session, action, { status: "failed", reason: message ? `平台提示：${message}` : "平台没有通过这次操作。" });
  }
  async function confirm(session, control, action, response, stillThere) {
    if (response) {
      const outcome = control.driver.actions.outcome(response.json);
      if (outcome.ok) return settleAction(session, action, { status: "done" });
      if (outcome.ok === null) return settleAction(session, action, { status: "unknown", reason: "平台的回应看不出成功与否。请到平台上看一下，再标记结果。" });
      return refused(session, control, action, outcome.message);
    }
    if (await stillThere()) return settleAction(session, action, { status: "done" });
    settleAction(session, action, { status: "unknown", reason: "已经点下，但没等到平台确认。请到平台上看一下，再标记结果。" });
  }
  const clicked = (session, action) => { action.clickedAt = stamp(); session.update({}); };

  async function likeComment(session, control, action) {
    const { page } = session, acts = control.driver.actions, t = action.target;
    await session.openVideo(t.videoId);
    if (control.shouldStop()) return;
    const item = acts.commentItem(t.userName, t.comment);
    // Older comments sit further down the list; scroll it the way a reader would.
    for (let i = 0; i < 8 && !await page.evaluate(`Boolean(${item})`) && !control.shouldStop(); i++) {
      const count = session.comments.length;
      await page.evaluate(`[...document.querySelectorAll(".comment-list-item")].at(-1)?.scrollIntoView({ block: "end" })`);
      await session.more(session.comments, count);
      if (session.comments.length === count) break;
    }
    if (!await page.evaluate(`Boolean(${item})`)) return settleAction(session, action, { status: "failed", reason: "视频下没找到这条评论，可能已被删除。" });
    const icon = `(${item})?.querySelector(${JSON.stringify(acts.likeIcon)})`;
    const isLiked = () => page.evaluate(`Boolean(${icon}?.classList.contains(${JSON.stringify(acts.likedClass)}))`);
    // A second click would take the like back, so an already liked comment is left alone.
    if (await isLiked()) return settleAction(session, action, { status: "done", already: true, reason: "之前已经点过赞。" });
    const point = await session.pointOf(icon);
    if (!point) return settleAction(session, action, { status: "failed", reason: "点赞按钮被页面挡住了，没有点。" });
    const mark = session.results.length;
    clicked(session, action);
    await page.mouse(point);
    const response = await session.answer(mark, (result) => acts.isLike(result.url, result.operation) && String(result.variables.commentId || t.commentId) === t.commentId, "点赞");
    await confirm(session, control, action, response, isLiked);
  }
  async function follow(session, control, action) {
    const { page } = session, acts = control.driver.actions, t = action.target;
    await page.navigate(acts.profileUrl(t.userId));
    const button = `document.querySelector(${JSON.stringify(acts.followButton)})`;
    await session.load("打开主页", () => page.evaluate(`Boolean(${button})`));
    if (control.shouldStop()) return;
    const label = () => page.evaluate(`(${button}?.textContent || "").trim()`);
    if (acts.followed.test(await label())) return settleAction(session, action, { status: "done", already: true, reason: "之前已经关注了。" });
    if (!/关注/.test(await label())) return settleAction(session, action, { status: "failed", reason: "主页上没有关注按钮。" });
    const point = await session.pointOf(button);
    if (!point) return settleAction(session, action, { status: "failed", reason: "关注按钮被页面挡住了，没有点。" });
    const mark = session.results.length;
    clicked(session, action);
    await page.mouse(point);
    const response = await session.answer(mark, (result) => acts.isFollow(result.url), "关注");
    await confirm(session, control, action, response, async () => acts.followed.test(await label()));
  }
  async function leaveComment(session, control, action) {
    const { page } = session, acts = control.driver.actions, t = action.target;
    await session.openVideo(t.videoId);
    if (control.shouldStop()) return;
    const box = await page.find((node) => node.localName === "textarea" && classes(node).includes("pl-textarea"));
    if (!box) return settleAction(session, action, { status: "failed", reason: "视频下没有留言框，可能关闭了评论。" });
    // A video can allow comments from the author's friends only; its box is then disabled.
    const closedNote = await page.call(box, "function () { return this.disabled ? String(this.placeholder || '这个视频不允许评论') : ''; }");
    if (closedNote) return settleAction(session, action, { status: "failed", reason: `${closedNote}，没有发。` });
    await page.type(box, t.text);
    if (await page.valueOf(box) !== t.text) return settleAction(session, action, { status: "failed", reason: "留言没有完整填进去，没有发。" });
    const send = `document.querySelector(${JSON.stringify(`${acts.sendButton}:not([disabled])`)})`;
    const point = await session.pointOf(send);
    if (!point) return settleAction(session, action, { status: "failed", reason: "发送按钮不可用，没有发。" });
    const mark = session.results.length;
    clicked(session, action);
    await page.mouse(point);
    const response = await session.answer(mark, (result) => acts.isCommentAdd(result.url, result.operation), "留言");
    // Without an answer, only our words near the top of the list, with the box emptied, count as sent.
    await confirm(session, control, action, response, () => page.evaluate(`!document.querySelector(${JSON.stringify(acts.commentBox)})?.value && [...document.querySelectorAll(".comment-list-item")].slice(0, 3).some((el) => (el.querySelector(".comment-item-content")?.textContent || "").replace(/\\s+/g, "") === ${JSON.stringify(t.text.replace(/\s+/g, ""))})`));
    if (action.status !== "done" || control.shouldStop()) return;
    // Accepted is not shown: on 2026-10-26 five accepted comments were gone when the videos were
    // opened again. So the video is opened afresh and the comment looked for in its list.
    await sleep(wait.recheck);
    const same = (value) => String(value || "").replace(/\s+/g, "") === t.text.replace(/\s+/g, "");
    const fresh = await session.openVideo(t.videoId);
    if (control.shouldStop()) return;
    const shown = fresh.some((result) => result.comments.some((comment) => same(comment.text)))
      || await page.evaluate(`[...document.querySelectorAll(".comment-list-item")].some((el) => (el.querySelector(".comment-item-content")?.textContent || "").replace(/\\s+/g, "") === ${JSON.stringify(t.text.replace(/\s+/g, ""))})`);
    if (!shown) Object.assign(action, { status: "hidden", reason: "平台收下了，但重新打开视频看不到这条留言，可能被当成广告屏蔽了。" });
    session.update({});
  }
  async function perform(session, control, action) {
    Object.assign(action, { status: "running", reason: "" });
    session.update({ detail: `${ACTION_NAMES[action.kind]}：${action.target.userName || action.target.videoTitle?.slice(0, 20) || ""}` });
    try {
      if (action.kind === "like") await likeComment(session, control, action);
      else if (action.kind === "follow") await follow(session, control, action);
      else await leaveComment(session, control, action);
      if (action.status === "running") settleAction(session, action, action.kind === "comment" ? { status: "cancelled", reason: "已停下，没有发出。" } : { status: "queued", reason: "" });
    } catch (error) {
      if (action.clickedAt) settleAction(session, action, { status: "unknown", reason: "已经点下，但之后出了问题。请到平台上看一下，再标记结果。" });
      else if (control.stop || closed) settleAction(session, action, action.kind === "comment" ? { status: "cancelled", reason: "已停下，没有发出。" } : { status: "queued", reason: "" });
      else if (/^SOCIAL_BROWSER_/.test(String(error?.code))) { settleAction(session, action, action.kind === "comment" ? { status: "cancelled", reason: "浏览器断开，没有发出。" } : { status: "queued", reason: "" }); throw error; }
      else { settleAction(session, action, { status: "failed", reason: userMessage(error, "这一步没做成。") }); if (/LOGIN|VERIFY/.test(String(error?.code))) throw error; }
    }
    if (action.status === "done") control.run.sent += 1;
    if (action.status === "hidden") control.run.hidden = (control.run.hidden || 0) + 1;
    if (["failed", "unknown"].includes(action.status)) control.run.failed += 1;
    session.update({});
  }
  const nextQueued = (accountId) => state.actions.slice().reverse().find((action) => action.status === "queued" && action.accountId === accountId && action.kind !== "comment" && room(accountId, action.kind));
  async function runQueue(session, control) {
    for (let first = true, action = nextQueued(control.accountId); action && !control.shouldStop(); first = false, action = nextQueued(control.accountId)) {
      if (!first) await gap(control, wait.actionGapMin, wait.actionGapMax);
      if (control.shouldStop()) break;
      await perform(session, control, action);
    }
    if (!control.rest && state.actions.some((action) => action.status === "queued" && action.accountId === control.accountId)) control.rest = "今天的上限到了，剩下的明天点「继续执行」。";
  }
  // Comments under peer videos found by keyword: one per video per account, in the user's own words.
  async function commentTask(session, control) {
    const { task, run } = control;
    const commented = new Set(state.actions.filter((action) => action.kind === "comment" && action.accountId === task.accountId && (action.clickedAt || ["running", "done", "unknown"].includes(action.status))).map((action) => action.target.videoId));
    let first = true;
    for (const keyword of task.keywords) {
      if (control.shouldStop() || run.sent >= task.maxComments) break;
      session.update({ detail: `搜索「${keyword}」` });
      for (const video of await session.search(keyword, task.maxVideos)) {
        if (control.shouldStop() || run.sent >= task.maxComments) break;
        if (commented.has(video.id)) continue;
        if (!room(task.accountId, "comment")) { control.rest = "今天的留言上限到了，明天再继续。"; break; }
        if (!first) await gap(control, wait.commentGapMin, wait.commentGapMax);
        if (control.shouldStop()) break;
        first = false;
        const action = newAction({ kind: "comment", platform: task.platform, accountId: task.accountId, taskId: task.id, target: { videoId: video.id, videoTitle: video.title, videoUrl: control.driver.videoUrl(video.id), videoAuthor: video.authorName, text: task.texts[(run.sent + run.failed) % task.texts.length] } });
        state.actions.unshift(action); commented.add(video.id);
        run.videos += 1;
        await perform(session, control, action);
        // Comments the platform keeps out of sight mean the words or the pace look like advertising.
        if ((run.hidden || 0) >= 2) { control.rest = "已有 2 条留言发出后看不到，可能被平台当成广告屏蔽了。先停下，建议换个说法、少发几条。"; break; }
      }
    }
  }

  function start(id) {
    const task = findTask(id);
    ensureNotBusy();
    if (task.mode === "comment") {
      if (paused(task.accountId)) throw fail("ACQUIRE_ACCOUNT_RESTING", "这个账号今天被平台提示操作频繁，明天再留言。");
      if (!room(task.accountId, "comment")) throw fail("ACQUIRE_CAP_REACHED", "这个账号今天的留言上限到了，明天再继续。");
    }
    return begin({ kind: task.mode === "comment" ? "comment" : "collect", task, platform: task.platform, accountId: task.accountId, accountLabel: task.accountLabel, body: task.mode === "comment" ? commentTask : collect });
  }
  // Queues likes and follows for chosen leads, run by the account that found each lead.
  function queueActions({ leadIds = [], kinds = [] } = {}) {
    const wanted = kinds.filter((kind) => kind === "like" || kind === "follow");
    if (!wanted.length) throw fail("ACQUIRE_ACTION_INVALID", "请选择要做的动作。");
    const chosen = state.leads.filter((lead) => leadIds.includes(lead.id));
    if (!chosen.length) throw fail("ACQUIRE_LEADS_REQUIRED", "请先选择线索。");
    let added = 0;
    for (const lead of chosen) for (const kind of wanted) {
      if (!driverFor(lead.platform).actions?.[kind]) continue;
      if (state.actions.some((action) => action.leadId === lead.id && action.kind === kind && ["queued", "running", "done", "unknown"].includes(action.status))) continue;
      state.actions.unshift(newAction({ kind, platform: lead.platform, accountId: lead.accountId, leadId: lead.id,
        target: { videoId: lead.videoId, videoTitle: lead.videoTitle, commentId: lead.commentId, userId: lead.userId, userName: lead.userName, comment: lead.comment } }));
      added += 1;
    }
    if (state.actions.length > 20_000) { const open = state.actions.filter((action) => ["queued", "running", "unknown"].includes(action.status)); state.actions = [...open, ...state.actions.filter((action) => !open.includes(action)).slice(0, Math.max(0, 20_000 - open.length))]; }
    save(); emit();
    if (added) pump({ quiet: true });
    return { ...snapshot(), added };
  }
  // Starts the queue for the first account that still has room today; nothing starts while a run is active.
  // An account that is gone or logged out has its queued actions failed with the reason; a busy one is skipped.
  function pump({ quiet = false } = {}) {
    if (active || closed) return snapshot();
    const known = accounts.snapshot().accounts, tried = new Set();
    let changed = false, lastError = null;
    for (const action of state.actions.slice().reverse()) {
      if (action.status !== "queued" || action.kind === "comment" || tried.has(action.accountId)) continue;
      const account = known.find((item) => item.id === action.accountId);
      if (!account || account.status !== "active") { Object.assign(action, { status: "failed", reason: account ? "这个账号需要重新扫码登录，没有做。" : "这个账号已删除，没有做。", finishedAt: stamp() }); changed = true; continue; }
      if (paused(action.accountId) || !room(action.accountId, action.kind)) continue;
      tried.add(action.accountId);
      try { return begin({ kind: "actions", platform: action.platform, accountId: action.accountId, accountLabel: account.label, body: runQueue }); }
      catch (error) { lastError = error; }
    }
    if (changed) { save(); emit(); }
    if (lastError && !quiet) throw lastError;
    return snapshot();
  }
  function cancelQueued() {
    for (const action of state.actions) if (action.status === "queued") Object.assign(action, { status: "cancelled", reason: "已取消。", finishedAt: stamp() });
    save(); emit(); return snapshot();
  }
  // Only the user settles an unknown result, after looking on the platform.
  function resolveAction(id, outcome) {
    const action = state.actions.find((item) => item.id === id);
    if (!action) throw fail("ACQUIRE_ACTION_NOT_FOUND", "没有找到这条记录。");
    if (action.status !== "unknown") throw fail("ACQUIRE_ACTION_SETTLED", "这条记录已经有结果了。");
    if (!["done", "failed"].includes(outcome)) throw fail("ACQUIRE_ACTION_OUTCOME", "结果不对。");
    Object.assign(action, { status: outcome, reason: outcome === "done" ? "你确认已成功。" : "你确认没有成功。", finishedAt: stamp() });
    save(); emit(); return snapshot();
  }

  // Closing the browser ends whatever page step is in flight, so stopping does not wait on it.
  function stop() { if (active) { active.stop = true; active.run.detail = "正在停下…"; void active.browser?.close().catch(() => {}); emit(); } return snapshot(); }
  function setLead(id, status) {
    const lead = state.leads.find((item) => item.id === id);
    if (!lead) throw fail("ACQUIRE_LEAD_NOT_FOUND", "没有找到这条线索。");
    if (!["new", "contacted", "ignored"].includes(status)) throw fail("ACQUIRE_LEAD_STATUS", "线索状态不对。");
    lead.status = status; save(); emit(); return snapshot();
  }
  // Spreadsheet-safe CSV (UTF-8 with BOM, quoted, formulas neutralised).
  function csv(taskId = "") {
    const cell = (value) => { let text = String(value ?? ""); if (/^[=+\-@]/.test(text)) text = `'${text}`; return `"${text.replace(/"/g, '""')}"`; };
    const header = ["平台", "昵称", "评论", "意向", "评论时间", "地区", "关键词", "视频", "视频链接", "状态", "点赞", "关注"];
    const names = { kuaishou: "快手", douyin: "抖音" }, statuses = { new: "新线索", contacted: "已联系", ignored: "已忽略" };
    const done = (lead, kind) => { const action = state.actions.find((item) => item.leadId === lead.id && item.kind === kind && item.status !== "cancelled"); return action ? { queued: "排队中", running: "进行中", done: "已完成", failed: "没成功", unknown: "结果不明" }[action.status] : ""; };
    const rows = state.leads.filter((lead) => !taskId || lead.taskId === taskId).map((lead) => [names[lead.platform] || lead.platform, lead.userName, lead.comment, lead.signals.join(" "), lead.commentAt, lead.region, lead.keyword, lead.videoTitle, lead.videoUrl, statuses[lead.status], done(lead, "like"), done(lead, "follow")]);
    return "﻿" + [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
  }
  async function dispose() { closed = true; if (active) { active.stop = true; await active.browser?.close().catch(() => {}); await active.done; } }
  return { snapshot, saveTask, removeTask, saveCaps, start, queueActions, resume: pump, cancelQueued, resolveAction, stop, setLead, csv, dispose, isBusy: () => Boolean(active) };
}

module.exports = { createSocialAcquisition };
