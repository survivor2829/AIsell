const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { findBrowser, launchBrowser } = require("./social-browser.cjs");
const { pageFor, sleep } = require("./social-page.cjs");
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

// Finds people whose comments on keyword-matched videos show buying intent. This step only
// reads: it searches, opens videos and reads their comments; it never likes, follows,
// comments or messages anyone. Platform verification is left to the user.
function createSocialAcquisition({ dataDir, accounts, launch = launchBrowser, executable = findBrowser(), driverFor = drivers.acquireDriverFor, capture: makeCapture = captureResponses, makePage = pageFor,
  onChange = () => {}, now = () => Date.now(), timing = {}, random = Math.random }) {
  const wait = { response: 15_000, verify: 10 * 60_000, poll: 1500, gapMin: 5000, gapMax: 10_000, ...timing };
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
  for (const run of state.runs) if (["running", "needs_user"].includes(run.status)) Object.assign(run, { status: "stopped", reason: "软件中断，已找到的线索都保留了，可以再次开始。", finishedAt: stamp() });
  writeJsonAtomic(stateFile, state);
  let active = null, closed = false;
  const save = () => writeJsonAtomic(stateFile, state);
  const snapshot = () => ({ tasks: state.tasks, runs: state.runs.slice(0, 50), leads: state.leads.slice(0, 2000), running: active?.run.id || "" });
  const emit = () => { if (!closed) onChange(snapshot()); };
  const findTask = (id) => { const task = state.tasks.find((item) => item.id === id); if (!task) throw fail("ACQUIRE_TASK_NOT_FOUND", "没有找到这个任务。"); return task; };

  function saveTask(input = {}) {
    const platform = String(input.platform || "kuaishou");
    driverFor(platform);
    const account = accounts.snapshot().accounts.find((item) => item.id === input.accountId && item.platform === platform && item.status === "active");
    if (!account) throw fail("ACQUIRE_ACCOUNT_REQUIRED", "请选择一个已登录的账号。");
    const keywords = words(input.keywords, 20, 30);
    if (!keywords.length) throw fail("ACQUIRE_KEYWORDS_REQUIRED", "请至少填写一个关键词。");
    const days = [1, 3, 7, 30, 90].includes(Number(input.days)) ? Number(input.days) : 30;
    const maxVideos = Math.min(50, Math.max(1, Math.round(Number(input.maxVideos) || 10)));
    const task = input.id ? findTask(String(input.id)) : null;
    if (task && active?.task === task) throw fail("ACQUIRE_TASK_RUNNING", "任务正在运行，停下后再改。");
    const fields = { name: String(input.name || "").trim().slice(0, 40) || keywords.slice(0, 3).join("、"), platform, accountId: account.id, accountLabel: account.label,
      keywords, intentWords: words(input.intentWords, 12, 30), days, maxVideos, allComments: input.allComments === true, skipAuthor: input.skipAuthor !== false, updatedAt: stamp() };
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

  async function execute(control, shouldStop) {
    const { task, run } = control;
    const driver = driverFor(task.platform);
    const release = accounts.lease(task.accountId);
    const update = (patch) => { Object.assign(run, patch); save(); emit(); };
    let browser;
    try {
      browser = control.browser = launch({ executable, profileDir: accounts.profileDir(task.accountId) });
      const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
      await browser.send("DOM.enable", {}, sessionId);
      const page = makePage(browser, sessionId);
      const searches = [], comments = [];
      const capture = makeCapture(browser, sessionId, {
        match: (url, operation) => driver.isSearch(url) || driver.isComments(url, operation),
        onJson: ({ url, operation, variables, json }) => { if (driver.isSearch(url)) searches.push(driver.parseSearch(json)); else comments.push({ photoId: String(variables?.photoId || ""), ...driver.parseComments(json) }); }
      });
      await capture.start();
      const visible = async () => String(await page.evaluate("document.body ? document.body.innerText.slice(0, 4000) : ''").catch(() => "") || "");
      // Waits for the page's own data. Only while it has not arrived is the page checked for a
      // platform verification (left to the user; the run waits) or a logged-out page, so words
      // like 滑块 in captions and comments are never mistaken for a verification.
      const load = async (where, arrived) => {
        let deadline = now() + wait.response, verifyUntil = 0;
        while (!shouldStop() && !arrived()) {
          // Text is only trusted once the data is overdue, when the page is likely showing nothing else.
          const blocked = Boolean(await page.evaluate(CAPTCHA_PROBE).catch(() => false)) || (now() > deadline && CAPTCHA.test(await visible()));
          if (blocked && !verifyUntil) {
            verifyUntil = now() + wait.verify;
            await page.front(); update({ status: "needs_user", detail: `${driver.name}要求验证：请在弹出的 Chrome 窗口里完成验证，完成后会自动继续。` });
          } else if (blocked && now() > verifyUntil) throw fail("ACQUIRE_VERIFY_TIMEOUT", `${where}的验证 10 分钟内没有完成，已停下。找到的线索都保留了。`);
          else if (!blocked && verifyUntil) { verifyUntil = 0; deadline = now() + wait.response; update({ status: "running", detail: "" }); }
          else if (!blocked && now() > deadline) break;
          await sleep(wait.poll);
        }
        if (run.status === "needs_user") update({ status: "running", detail: "" });
        if (arrived() || shouldStop()) return;
        if (driver.loggedOutText.test(await visible())) throw fail("ACQUIRE_LOGIN_REQUIRED", `${driver.name}网页版需要重新扫码登录（账号「${task.accountLabel}」）。`);
      };
      const more = async (list, from) => { const deadline = now() + wait.response; while (list.length <= from && now() < deadline && !shouldStop()) await sleep(300); };
      const since = now() - task.days * 86_400_000;
      for (const keyword of task.keywords) {
        if (shouldStop()) break;
        update({ detail: `搜索「${keyword}」` });
        const before = searches.length;
        await page.navigate(driver.searchUrl(keyword));
        await load(`搜索「${keyword}」`, () => searches.length > before);
        if (shouldStop()) break;
        let videos = searches.slice(before).flatMap((result) => result.videos);
        // More results load as the list scrolls, the same as a person scrolling.
        for (let i = 0; i < 4 && videos.length < task.maxVideos && searches.at(-1)?.more && !shouldStop(); i++) {
          const count = searches.length;
          await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 480, deltaX: 0, deltaY: 1200 });
          await more(searches, count);
          videos = searches.slice(before).flatMap((result) => result.videos);
        }
        videos = [...new Map(videos.map((video) => [video.id, video])).values()].slice(0, task.maxVideos);
        for (const video of videos) {
          if (shouldStop()) break;
          // A pause between videos keeps the pace of a person reading, and the load on the platform low.
          await sleep(wait.gapMin + random() * (wait.gapMax - wait.gapMin));
          update({ detail: `「${keyword}」读评论：${video.title.slice(0, 20) || video.id}` });
          const mark = comments.length;
          // Each comment response names its video; a late one from the previous page is not counted here.
          const mine = () => comments.slice(mark).filter((result) => !result.photoId || result.photoId === video.id);
          await page.navigate(driver.videoUrl(video.id));
          await load("打开视频", () => mine().length > 0);
          if (shouldStop()) break;
          run.videos += 1;
          for (const result of mine()) for (const comment of result.comments) {
            if (task.skipAuthor && comment.userId === video.authorId) continue;
            if (comment.at && Date.parse(comment.at) < since) continue;
            const signals = drivers.intentOf(comment.text, task.intentWords);
            if (!signals.length && !task.allComments) continue;
            run.comments += 1;
            if (addLead(task, keyword, video, comment, signals.length ? signals : ["全部评论"])) run.leads += 1;
          }
          update({});
        }
      }
      update({ status: shouldStop() ? "stopped" : "done", detail: "", reason: shouldStop() ? "已停下，找到的线索都保留了。" : "", finishedAt: stamp() });
    } catch (error) {
      if (shouldStop()) update({ status: "stopped", detail: "", reason: "已停下，找到的线索都保留了。", finishedAt: stamp() });
      else update({ status: "failed", detail: "", reason: userMessage(error, "运行中出错，找到的线索都保留了，可以再次开始。"), finishedAt: stamp() });
    } finally {
      await browser?.close().catch(() => {});
      release();
    }
  }
  function start(id) {
    const task = findTask(id);
    if (active) throw fail("ACQUIRE_BUSY", "已经有一个任务在运行，等它结束或先停下。");
    driverFor(task.platform);
    accounts.lease(task.accountId)();
    const run = { id: crypto.randomUUID(), taskId: task.id, status: "running", detail: "准备打开浏览器", videos: 0, comments: 0, leads: 0, reason: "", startedAt: stamp(), finishedAt: "" };
    state.runs.unshift(run); state.runs = state.runs.slice(0, 200);
    task.lastRunAt = stamp(); save();
    const control = { task, run, stop: false };
    active = control; emit();
    control.done = execute(control, () => control.stop || closed).catch(() => {}).finally(() => { if (active === control) active = null; emit(); });
    return snapshot();
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
    const header = ["平台", "昵称", "评论", "意向", "评论时间", "地区", "关键词", "视频", "视频链接", "状态"];
    const names = { kuaishou: "快手", douyin: "抖音" }, statuses = { new: "新线索", contacted: "已联系", ignored: "已忽略" };
    const rows = state.leads.filter((lead) => !taskId || lead.taskId === taskId).map((lead) => [names[lead.platform] || lead.platform, lead.userName, lead.comment, lead.signals.join(" "), lead.commentAt, lead.region, lead.keyword, lead.videoTitle, lead.videoUrl, statuses[lead.status]]);
    return "﻿" + [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
  }
  async function dispose() { closed = true; if (active) { active.stop = true; await active.browser?.close().catch(() => {}); await active.done; } }
  return { snapshot, saveTask, removeTask, start, stop, setLead, csv, dispose, isBusy: () => Boolean(active) };
}

module.exports = { createSocialAcquisition };
