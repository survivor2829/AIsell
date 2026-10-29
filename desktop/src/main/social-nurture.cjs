const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { findBrowser, launchBrowser } = require("./social-browser.cjs");
const { attachPage, sleep } = require("./social-page.cjs");
const drivers = require("./social-nurture-drivers.cjs");
const STAGES = require("./social-nurture-stages.json");

const fail = (code, message) => Object.assign(new Error(message), { code });
const userMessage = (error, fallback) => /^(NURTURE|SOCIAL)_/.test(String(error?.code || "")) ? error.message : fallback;
const dayOf = (ms) => { const date = new Date(ms); return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`; };
const nextMidnight = (ms) => { const date = new Date(ms); date.setHours(24, 0, 0, 0); return date.getTime(); };
const LAST_DAY = 8;
const KINDS = ["likes", "follows", "comments"];
const KIND_NAMES = { likes: "点赞", follows: "关注", comments: "评论" };
// Comments are plain reactions: anything that reads as advertising or a way to get in touch
// is refused (Kuaishou hid every such comment under peer videos on 2026-10-26).
const CONTACT = /\d{6,}|微信|v信|vx|wx|加我|私信|电话|手机|联系|http|www\.|\.com|二维码|扫码|链接/i;
const words = (value, max, limit) => [...new Set((Array.isArray(value) ? value : String(value || "").split(/[\n,，、]+/)).map((item) => String(item).trim().slice(0, max)).filter(Boolean))].slice(0, limit);

// 养号: each plan walks one account through the 8-day stage table, a few segments a day
// from the user's start time, only while the software is open. A day not finished on its
// date is done again the next date; the day after a finished one is the next stage day.
// Interactions are spread over the videos (never two of the same kind in a row), and only
// with videos that match the plan's keywords. A verification stops the segment and brings
// the window forward; a second one in a day rests the plan until tomorrow.
function createSocialNurture({ dataDir, accounts, launch = launchBrowser, executable = findBrowser(), attach = attachPage, driverFor = drivers.nurtureDriverFor,
  stages = STAGES, publish = async () => { throw fail("NURTURE_PUBLISH_UNAVAILABLE", "发布暂时不可用。"); }, onChange = () => {}, onFailure = () => {},
  now = () => Date.now(), random = Math.random, timing = {} }) {
  const wait = { tick: 30_000, pageOpen: 30_000, settle: 6000, busyRetry: 60_000, typeMin: 100, typeMax: 300, ...timing };
  const stamp = () => new Date(now()).toISOString();
  const between = ([low, high]) => low + random() * (high - low);
  const whole = (range) => Math.round(between(range));
  const stateFile = path.join(dataDir, "state.json");
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (state?.version !== 1 || !Array.isArray(state.plans) || !Array.isArray(state.log)) throw new Error("invalid state");
  } catch (error) {
    if (error.code !== "ENOENT") throw fail("NURTURE_STATE_INVALID", "养号记录无法读取，原文件已保留，请通过吐槽中心联系处理。");
    state = { version: 1, plans: [], log: [] };
    fs.mkdirSync(dataDir, { recursive: true });
  }
  writeJsonAtomic(stateFile, state);
  let active = null, closed = false, timer = null;
  const save = () => writeJsonAtomic(stateFile, state);
  const stageOf = (day) => stages.stages.find((stage) => stage.days.includes(day)) || stages.stages.at(-1);
  const snapshot = () => ({ plans: state.plans.map((plan) => ({ ...plan, seen: undefined, stage: stageOf(plan.day).name })), log: state.log.slice(0, 200), running: active?.plan.id || "" });
  const emit = () => { if (!closed) onChange(snapshot()); };
  const note = (plan, text) => { state.log.unshift({ at: stamp(), planId: plan.id, text }); state.log = state.log.slice(0, 500); };
  const find = (id) => { const plan = state.plans.find((item) => item.id === id); if (!plan) throw fail("NURTURE_PLAN_NOT_FOUND", "没有找到这个养号计划。"); return plan; };
  const freshDay = (day) => {
    const stage = stageOf(day);
    return { date: dayOf(now()), segments: whole(stage.segments), segmentsDone: 0, minutes: Array.from({ length: stage.segments[1] }, () => between(stage.minutes)),
      targets: Object.fromEntries(KINDS.map((kind) => [kind, whole(stage[kind])])), counts: { watched: 0, likes: 0, follows: 0, comments: 0 },
      anomalies: 0, commentsOff: false, restUntil: 0, nextAt: 0 };
  };
  // A new date starts the next stage day only when the last one was finished.
  function roll(plan) {
    if (plan.today?.date === dayOf(now())) return;
    if (plan.today && plan.today.segmentsDone >= plan.today.segments) plan.day += 1;
    if (plan.day > LAST_DAY) { Object.assign(plan, { status: "finished", reason: "8 天养号已完成。", finishedAt: plan.finishedAt || stamp() }); return; }
    plan.today = freshDay(plan.day);
  }

  function savePlan(input = {}) {
    const platform = String(input.platform || "douyin");
    driverFor(platform);
    const account = accounts.snapshot().accounts.find((item) => item.id === input.accountId && item.platform === platform && item.status === "active");
    if (!account) throw fail("NURTURE_ACCOUNT_REQUIRED", "请选择一个已登录的抖音账号。");
    const keywords = words(input.keywords, 20, 20);
    if (!keywords.length) throw fail("NURTURE_KEYWORDS_REQUIRED", "请至少填写一个行业关键词，例如：洗地机。");
    const comments = words(input.comments, 40, 30);
    const contact = comments.find((text) => CONTACT.test(text));
    if (contact) throw fail("NURTURE_COMMENT_CONTACT", `评论话术「${contact}」里有联系方式或广告字样，平台会把它当广告隐藏，请改成普通互动的话。`);
    if (!comments.length) throw fail("NURTURE_COMMENTS_REQUIRED", "请至少填写一条评论话术，例如：讲得很清楚。");
    const startTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.startTime || "")) ? String(input.startTime) : "09:30";
    const testVideo = input.testVideo?.finishedVideoId ? { finishedVideoId: String(input.testVideo.finishedVideoId), name: String(input.testVideo.name || "").slice(0, 80), title: String(input.testVideo.title || "").trim().slice(0, 30) } : null;
    if (testVideo && !testVideo.title) throw fail("NURTURE_TEST_TITLE_REQUIRED", "请填写第 8 天测试视频的标题。");
    const plan = input.id ? find(String(input.id)) : null;
    if (plan && active?.plan === plan) throw fail("NURTURE_PLAN_RUNNING", "这个计划正在运行，停下后再改。");
    if (!plan && state.plans.some((item) => item.accountId === account.id && item.status !== "finished")) throw fail("NURTURE_ACCOUNT_TAKEN", "这个账号已经有一个养号计划了。");
    const fields = { platform, accountId: account.id, accountLabel: account.label, keywords, comments, startTime, testVideo, updatedAt: stamp() };
    if (plan) Object.assign(plan, fields);
    else state.plans.unshift({ id: crypto.randomUUID(), ...fields, enabled: true, status: "active", reason: "", mode: "search", day: 1, today: null, published: false, publishResult: "", seen: [], createdAt: stamp(), finishedAt: "" });
    save(); emit(); queueMicrotask(tick);
    return snapshot();
  }
  function removePlan(id) {
    const plan = find(id);
    if (active?.plan === plan) throw fail("NURTURE_PLAN_RUNNING", "这个计划正在运行，停下后再删。");
    state.plans = state.plans.filter((item) => item !== plan); save(); emit(); return snapshot();
  }
  function setEnabled(id, enabled) {
    const plan = find(id);
    plan.enabled = Boolean(enabled);
    if (!plan.enabled && active?.plan === plan) stop();
    if (plan.enabled && plan.status === "paused") Object.assign(plan, { status: "active", reason: "" });
    save(); emit(); if (plan.enabled) queueMicrotask(tick); return snapshot();
  }

  // ---- One segment ----
  const startOfToday = (time) => { const [hours, minutes] = time.split(":").map(Number); const date = new Date(now()); date.setHours(hours, minutes, 0, 0); return date.getTime(); };
  function due(plan) {
    if (!plan.enabled || plan.status !== "active") return false;
    roll(plan);
    const today = plan.today;
    if (plan.status !== "active" || !today) return false;
    if (today.restUntil > now() || today.segmentsDone >= today.segments) return false;
    return now() >= Math.max(startOfToday(plan.startTime), today.nextAt);
  }
  function tick() {
    if (active || closed) return;
    const plan = state.plans.find(due);
    if (plan) { save(); void runSegment(plan); }
  }

  async function runSegment(plan) {
    const driver = driverFor(plan.platform), stage = stageOf(plan.day), today = plan.today;
    let release;
    try { release = accounts.lease(plan.accountId); }
    catch (error) {
      if (error.code === "SOCIAL_ACCOUNT_BUSY") { today.nextAt = now() + wait.busyRetry; save(); return; }
      Object.assign(plan, { status: "paused", reason: userMessage(error, "账号暂时不可用。") }); save(); emit(); return;
    }
    const control = active = { plan, stop: false, step: "open", reported: new Set(), browser: null, page: null };
    const stopped = () => control.stop || closed;
    const report = async (code, step) => {
      if (control.reported.has(`${code}:${step}`)) return;
      control.reported.add(`${code}:${step}`);
      let screenshot = "", pageUrl = "";
      try { if (control.page) { pageUrl = String(await control.page.url()).replace(/[?#].*$/, ""); screenshot = (await control.page.send("Page.captureScreenshot", { format: "png" }))?.data || ""; } }
      catch { /* A closed page leaves the report without a picture. */ }
      try { onFailure({ platform: plan.platform, code, step, day: plan.day, mode: plan.mode, pageUrl, screenshot }); } catch { /* Diagnostics never change the run. */ }
    };
    const pause = async (ms) => { const until = now() + ms; while (now() < until && !stopped()) await sleep(Math.min(1000, Math.max(1, until - now()))); };
    let segmentDone = false;
    note(plan, `第 ${plan.day} 天（${stage.name}）开始第 ${today.segmentsDone + 1} 段`); emit();
    try {
      control.browser = launch({ executable, profileDir: accounts.profileDir(plan.accountId) });
      control.page = await attach(control.browser, driver.host, { timeoutMs: wait.pageOpen, open: driver.home });
      const page = control.page;
      await pause(wait.settle);
      if (!await driver.signedIn(page)) {
        control.step = "login";
        throw fail("SOCIAL_LOGIN_REQUIRED", `${driver.name}账号「${plan.accountLabel}」需要重新扫码登录。`);
      }
      // Searching the plan's words is how the account gets its topic; where the platform turns
      // search away, the plan keeps to the recommended feed and only matching videos are touched.
      let fromSearch = false;
      if (stage.search && plan.mode === "search" && !stopped()) {
        const keyword = plan.keywords[Math.floor(random() * plan.keywords.length)];
        control.step = "search";
        note(plan, `搜索「${keyword}」`);
        if (!await driver.search(page, keyword)) await report("NURTURE_ELEMENT_MISSING", "search");
        else {
          await pause(wait.settle);
          if (await driver.blocked(page)) {
            plan.mode = "feed";
            note(plan, "搜索时平台要求验证，这个计划以后改为刷推荐页，只和含关键词的视频互动。");
            await report("NURTURE_SEARCH_BLOCKED", "search");
            await page.navigate(driver.home); await pause(wait.settle);
          } else if (await driver.openFirstResult(page)) fromSearch = true;
          else { await report("NURTURE_ELEMENT_MISSING", "search_result"); await page.navigate(driver.home); await pause(wait.settle); }
        }
      }
      const end = now() + today.minutes[today.segmentsDone] * 60_000;
      const segmentsLeft = () => today.segments - today.segmentsDone - 1;
      const meanDwell = (stage.dwellSeconds[0] + stage.dwellSeconds[1]) / 2 * 1000, meanSegment = (stage.minutes[0] + stage.minutes[1]) / 2 * 60_000;
      const disabled = new Set();
      let last = "";
      control.step = "watch";
      while (now() < end && !stopped()) {
        if (await driver.blocked(page)) {
          today.anomalies += 1;
          await page.front?.();
          note(plan, `平台要求验证（今天第 ${today.anomalies} 次），这一段先停下。请在弹出的 Chrome 窗口里完成验证。`);
          await report("NURTURE_VERIFICATION", control.step);
          if (today.anomalies >= 2) { today.restUntil = nextMidnight(now()); note(plan, "今天已经出现 2 次验证，为了账号安全，养号停到明天。"); }
          break;
        }
        const video = await driver.current(page);
        if (!video) { control.step = "player"; await report("NURTURE_ELEMENT_MISSING", "player"); break; }
        const fresh = !plan.seen.includes(video.id);
        const relevant = plan.day > 1 && (fromSearch || plan.keywords.some((word) => `${video.desc} ${video.author}`.includes(word)));
        today.counts.watched += 1;
        if (fresh) { plan.seen.push(video.id); plan.seen = plan.seen.slice(-3000); }
        const dwell = plan.day === 1 || relevant ? between(stage.dwellSeconds) * 1000 : between(stages.skipDwellSeconds) * 1000;
        await pause(dwell / 2);
        if (relevant && fresh && !stopped()) {
          // Each kind's chance is what is left of today's number over the videos still to come,
          // so the day's numbers spread out instead of bursting; the same kind is never repeated back to back.
          const videosLeft = Math.max(1, ((end - now()) + segmentsLeft() * meanSegment) / meanDwell * (fromSearch ? 1 : 0.5));
          const choices = KINDS.filter((kind) => kind !== last && !disabled.has(kind) && !(kind === "comments" && today.commentsOff) && today.counts[kind] < today.targets[kind]);
          const kind = choices.find((item) => random() < Math.min(0.6, (today.targets[item] - today.counts[item]) / videosLeft));
          if (kind) {
            control.step = kind;
            const result = kind === "likes" ? await driver.like(page) : kind === "follows" ? await driver.follow(page)
              : await driver.comment(page, plan.comments[Math.floor(random() * plan.comments.length)], () => between([wait.typeMin, wait.typeMax]));
            if (result === "missing") { disabled.add(kind); await report("NURTURE_ELEMENT_MISSING", kind); }
            else if (result === "hidden") {
              today.counts.comments += 1; today.commentsOff = true;
              note(plan, "评论发出后在评论区看不到（可能被平台隐藏），今天不再评论。");
              await report("NURTURE_COMMENT_HIDDEN", "comments");
            } else {
              today.counts[kind] += 1;
              note(plan, `${KIND_NAMES[kind]}：${video.desc.slice(0, 20) || video.author || "当前视频"}${result === "unconfirmed" ? "（页面没有显示已点赞）" : ""}`);
              if (result === "unconfirmed") await report("NURTURE_ACTION_UNCONFIRMED", kind);
            }
            last = kind; save(); emit();
          } else last = "";
          control.step = "watch";
        } else last = "";
        await pause(dwell / 2);
        if (!stopped() && now() < end) await driver.next(page);
      }
      segmentDone = !stopped() && now() >= end;
    } catch (error) {
      if (error?.code === "SOCIAL_LOGIN_REQUIRED") {
        try { accounts.markSignedOut?.(plan.accountId); } catch { /* The plan's reason still says what to do. */ }
        Object.assign(plan, { status: "paused", reason: error.message });
      } else if (!stopped()) note(plan, userMessage(error, "这一段运行中出错，稍后会再试。"));
      if (!stopped()) await report(String(error?.code || "NURTURE_UNEXPECTED"), control.step);
    } finally {
      await control.browser?.close().catch(() => {});
      release();
      if (segmentDone) { today.segmentsDone += 1; note(plan, `第 ${today.segmentsDone} 段完成`); }
      today.nextAt = now() + between(stages.segmentGapMinutes) * 60_000;
      if (active === control) active = null;
      save(); emit();
    }
    // The test video goes out once on the last day, after its first segment, through 一键分发.
    if (segmentDone && stage.publish && plan.testVideo && !plan.published && !closed) {
      plan.published = true; save();
      try { await publish({ accountId: plan.accountId, finishedVideoId: plan.testVideo.finishedVideoId, name: plan.testVideo.name, title: plan.testVideo.title });
        plan.publishResult = "测试视频已交给一键分发，结果在发布记录里。"; }
      catch (error) { plan.publishResult = `测试视频没能交给一键分发：${userMessage(error, "发布暂时不可用。")}`; }
      note(plan, plan.publishResult); save(); emit();
    }
    if (today.segmentsDone >= today.segments && plan.day >= LAST_DAY) { Object.assign(plan, { status: "finished", reason: "8 天养号已完成。", finishedAt: stamp() }); save(); emit(); }
  }

  // Closing the browser ends the page step in flight, so stopping does not wait on it.
  function stop() { if (active) { active.stop = true; void active.browser?.close().catch(() => {}); } emit(); return snapshot(); }
  function start() { if (!timer && !closed) { timer = setInterval(tick, wait.tick); timer.unref?.(); setTimeout(tick, 0).unref?.(); } }
  async function dispose() { closed = true; clearInterval(timer); if (active) { active.stop = true; await active.browser?.close().catch(() => {}); } }
  return { snapshot, savePlan, removePlan, setEnabled, stop, start, tick, dispose, isBusy: () => Boolean(active) };
}

module.exports = { createSocialNurture, CONTACT };
