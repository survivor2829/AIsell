const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { findBrowser, launchBrowser } = require("./social-browser.cjs");
const { attachPage, sleep } = require("./social-page.cjs");
const drivers = require("./social-publish-drivers.cjs");

const fail = (code, message) => Object.assign(new Error(message), { code });
const stamp = () => new Date().toISOString();
const ACTIVE = new Set(["queued", "running", "needs_user", "clicked"]);
// Records that must survive pruning: active work, results the user still has to check, and published posts (duplicate guard).
const KEEP = new Set([...ACTIVE, "unknown", "published"]);
const VIDEO = /\.(mp4|mov|m4v)$/i;
const MAX_RECORDS = 500, MAX_SUBMIT = 100;
// Only our own messages reach the user; system errors can carry local paths.
const userMessage = (error, fallback) => /^SOCIAL_/.test(String(error?.code || "")) ? error.message : fallback;
const localDay = (value) => { const date = new Date(value); return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`; };

// One video on one account is one job. A job that reached the publish click
// is never published again by this module: if its result cannot be confirmed
// on the platform's work management page it stays `unknown` until the user
// checks the platform and says what happened.
function createSocialPublisher({ dataDir, accounts, launch = launchBrowser, executable = findBrowser(), driverFor = drivers.driverFor, attach = attachPage, steps = drivers,
  onChange = () => {}, now = () => Date.now(), dailyLimit = 10, timing = {} }) {
  const wait = { upload: 15 * 60_000, result: 10 * 60_000, pageOpen: 30_000, settle: 3000, poll: 2000, button: 3000, react: 20_000, busyRetry: 30_000, ...timing };
  wait.job = timing.job ?? wait.upload + wait.result + 5 * 60_000;
  const stateFile = path.join(dataDir, "state.json");
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (state?.version !== 1 || !Array.isArray(state.jobs)) throw new Error("invalid state");
  } catch (error) {
    if (error.code !== "ENOENT") throw fail("SOCIAL_PUBLISH_STATE_INVALID", "发布记录无法读取，原文件已保留，请通过吐槽中心联系处理。");
    state = { version: 1, jobs: [] };
    fs.mkdirSync(dataDir, { recursive: true });
  }
  for (const job of state.jobs) {
    if (!ACTIVE.has(job.status) || job.status === "queued") continue;
    if (job.clickedAt) Object.assign(job, { status: "unknown", reason: "软件在点击发布之后中断，请到平台核对是否已发出；不会自动重发。" });
    else Object.assign(job, { status: "failed", reason: "软件中断，还没有点击发布，可以重新发起。" });
  }
  writeJsonAtomic(stateFile, state);
  let pumping = null, closed = false, active = null, activeBrowser = null, wakeTimer = null;
  const save = () => writeJsonAtomic(stateFile, state);
  const snapshot = () => ({ jobs: state.jobs.map((job) => ({ ...job, videoPath: undefined, notBefore: undefined })), running: active?.id || "" });
  const emit = () => { if (!closed) onChange(snapshot()); };
  const update = (job, patch) => { Object.assign(job, patch, { updatedAt: stamp() }); save(); emit(); };
  const find = (id) => { const job = state.jobs.find((item) => item.id === id); if (!job) throw fail("SOCIAL_JOB_NOT_FOUND", "没有找到这条发布记录。"); return job; };
  const marker = (job) => job.title.slice(0, 15);
  const usedToday = (accountId) => state.jobs.filter((job) => job.accountId === accountId && job.clickedAt && localDay(job.clickedAt) === localDay(now())).length;
  // Drop the oldest finished records only; active, unknown and published records always stay.
  function prune() {
    let extra = state.jobs.length - MAX_RECORDS;
    for (let index = state.jobs.length - 1; index >= 0 && extra > 0; index--) if (!KEEP.has(state.jobs[index].status)) { state.jobs.splice(index, 1); extra--; }
  }

  // `copies` gives each platform its own title and text; platforms without one use `title`/`description`.
  function submit({ videos = [], accountIds = [], title = "", description = "", visibility = "public", copies = {} } = {}) {
    const tidy = (copy) => ({ title: String(copy?.title ?? "").trim().replace(/\s+/g, " "), description: String(copy?.description ?? "").trim().slice(0, 1000) });
    const shared = tidy({ title, description });
    const copyFor = (platform) => copies && copies[platform] ? tidy(copies[platform]) : shared;
    if (!["public", "private"].includes(visibility)) throw fail("SOCIAL_VISIBILITY_INVALID", "请选择公开或仅自己可见。");
    if (!videos.length) throw fail("SOCIAL_VIDEO_REQUIRED", "请至少选择一条视频。");
    if (!accountIds.length) throw fail("SOCIAL_ACCOUNT_REQUIRED", "请至少选择一个账号。");
    if (videos.length * accountIds.length > MAX_SUBMIT) throw fail("SOCIAL_SUBMIT_TOO_LARGE", `一次最多排 ${MAX_SUBMIT} 条（视频数 × 账号数），请分批发布。`);
    const known = new Map(accounts.snapshot().accounts.map((account) => [account.id, account]));
    const targets = accountIds.map((id) => { const account = known.get(id); if (!account) throw fail("SOCIAL_ACCOUNT_NOT_FOUND", "有账号已被删除，请刷新后重选。"); return account; });
    for (const account of targets) {
      const driver = driverFor(account.platform);
      const copy = copyFor(account.platform);
      if (!copy.title) throw fail("SOCIAL_TITLE_REQUIRED", `请填写${driver.name}的标题。`);
      if (driver.titleLimit && copy.title.length > driver.titleLimit) throw fail("SOCIAL_TITLE_TOO_LONG", `${driver.name}标题最多 ${driver.titleLimit} 个字，现在是 ${copy.title.length} 个字。`);
      if (visibility === "private" && !driver.supportsPrivate) throw fail("SOCIAL_PRIVATE_UNSUPPORTED", `${driver.name}发表时不能设为仅自己可见，请取消勾选${driver.name}或改为公开。`);
    }
    for (const video of videos) if (!VIDEO.test(String(video.path || "")) || !fs.existsSync(video.path)) throw fail("SOCIAL_VIDEO_MISSING", `找不到视频文件：${video.name || "所选视频"}`);
    const kept = state.jobs.filter((job) => KEEP.has(job.status)).length;
    if (kept + videos.length * targets.length > MAX_RECORDS) throw fail("SOCIAL_SUBMIT_TOO_LARGE", "进行中和待核对的发布太多了，请先处理完再继续。");
    const created = [], skipped = [];
    for (const video of videos) for (const account of targets) {
      const { title, description } = copyFor(account.platform);
      // The same video with the same title on the same account is never queued twice.
      if (state.jobs.some((job) => job.accountId === account.id && job.videoPath === video.path && job.title === title && KEEP.has(job.status))) { skipped.push(`${video.name} → ${account.label}`); continue; }
      const job = { id: crypto.randomUUID(), accountId: account.id, accountLabel: account.label, platform: account.platform, videoPath: video.path, videoName: String(video.name || path.basename(video.path)).slice(0, 80),
        title, description, visibility, status: "queued", step: "", reason: "", createdAt: stamp(), updatedAt: stamp(), clickedAt: "", finishedAt: "", notBefore: 0 };
      state.jobs.unshift(job); created.push(job.id);
    }
    prune(); save(); emit(); pump();
    return { created: created.length, skipped, state: snapshot() };
  }

  async function run(job) {
    const driver = driverFor(job.platform);
    if (usedToday(job.accountId) >= dailyLimit) return update(job, { status: "failed", reason: `这个账号今天已经发了 ${dailyLimit} 条，为了账号安全请明天再发。`, finishedAt: stamp() });
    let release;
    try { release = accounts.lease(job.accountId); }
    catch (error) {
      // A login window or a status refresh holds the browser for a moment: wait instead of failing.
      if (error.code === "SOCIAL_ACCOUNT_BUSY") return update(job, { notBefore: now() + wait.busyRetry, reason: "账号的浏览器正在使用，稍后自动继续。" });
      return update(job, { status: "failed", reason: userMessage(error, "账号暂时不可用。"), finishedAt: stamp() });
    }
    let browser, watchdog;
    try {
      update(job, { status: "running", step: "打开平台", reason: "" });
      browser = launch({ executable, profileDir: accounts.profileDir(job.accountId) });
      activeBrowser = browser;
      // Whatever hangs, the job ends: closing the browser rejects every pending call.
      watchdog = setTimeout(() => { job.timedOut = true; void browser.close().catch(() => {}); }, wait.job);
      watchdog.unref?.();
      const page = await attach(browser, driver.host, { timeoutMs: wait.pageOpen, open: driver.uploadUrl });
      // Pages hydrate after load; a file set before that is silently dropped.
      await sleep(wait.settle);
      if (driver.loginRequired(await page.url())) throw fail("SOCIAL_LOGIN_REQUIRED", `${driver.name}账号「${job.accountLabel}」需要重新扫码登录。`);
      // A restored draft that already holds a video would be published instead of this one.
      if (await driver.uploaded(page)) throw fail("SOCIAL_STALE_DRAFT", `${driver.name}页面里有一条之前没发完的草稿视频，请先在平台上处理掉草稿再发。`);
      update(job, { step: "上传视频" });
      const uploadDeadline = now() + wait.upload;
      // If the page shows no reaction to the file, set it once more; choosing a file never publishes.
      for (let attempt = 0, accepted = false; ; attempt++) {
        const input = await steps.findVideoInput(page);
        if (!input) throw fail("SOCIAL_FORM_CHANGED", `没有找到${driver.name}的视频上传入口，平台页面可能改版了。`);
        await page.setFile(input, job.videoPath);
        const reactDeadline = now() + wait.react;
        while (!accepted && now() <= reactDeadline) { await sleep(wait.poll); accepted = await driver.uploaded(page) || /上传中|上传成功|\d+%/.test(String(await page.evaluate("document.body ? document.body.innerText : ''") || "")); }
        if (accepted) break;
        if (attempt >= 1) throw fail("SOCIAL_UPLOAD_IGNORED", `${driver.name}页面没有接收视频文件，没有发布，可以重新发起。`);
      }
      for (;;) {
        if (await driver.uploaded(page)) break;
        if (now() > uploadDeadline) throw fail("SOCIAL_UPLOAD_TIMEOUT", "视频上传超时，没有发布，可以重新发起。");
        await sleep(wait.poll);
      }
      update(job, { step: "填写内容" });
      const form = await driver.fill(page, job);
      // Anything typed into the page meanwhile, leftover text or a changed form stops the job before publishing.
      const formOk = async () => driver.formMatches(await form.read(), job) && (job.visibility !== "private" || await driver.privateChecked(page));
      if (!await formOk()) throw fail("SOCIAL_FORM_MISMATCH", job.visibility === "private" && !await driver.privateChecked(page)
        ? "没能设置成仅自己可见，没有发布。" : "填好的内容和预期不一致（可能填写时有键盘输入），没有发布，可以重新发起。");
      let clicked = false;
      for (let i = 0; i < 20 && !clicked; i++) {
        if (i > 0) { await sleep(wait.button); if (!await formOk()) throw fail("SOCIAL_FORM_MISMATCH", "发布前内容被改动了，没有发布，可以重新发起。"); }
        update(job, { step: "点击发布", status: "clicked", clickedAt: stamp() });
        clicked = await driver.publish(page);
        if (!clicked) update(job, { status: "running", clickedAt: "" });
      }
      if (!clicked) throw fail("SOCIAL_PUBLISH_BUTTON_MISSING", `没有找到${driver.name}的发布按钮，没有发布，可以重新发起。`);
      update(job, { step: "等待平台结果" });
      const resultDeadline = now() + wait.result;
      let done = false;
      while (now() <= resultDeadline) {
        await sleep(wait.poll);
        if (driver.published(await page.url().catch(() => ""))) { done = true; break; }
        if (await steps.verificationShown(page).catch(() => false)) {
          if (job.status !== "needs_user") { await page.front(); update(job, { status: "needs_user", step: "等你验证", reason: `${driver.name}要求本人验证：请在弹出的 Chrome 窗口里完成验证，完成后会自动继续。` }); }
        } else if (job.status === "needs_user") update(job, { status: "clicked", step: "等待平台结果", reason: "" });
      }
      update(job, { status: "clicked", step: "核对作品" });
      if (await steps.listed(page, driver, marker(job))) return update(job, { status: "published", step: "", reason: "", finishedAt: stamp() });
      update(job, { status: "unknown", step: "", reason: done ? "平台显示已提交，但作品管理里暂时没找到这条，请稍后到平台核对；不会自动重发。" : "点击发布后没有等到平台的结果，请到平台核对是否已发出；不会自动重发。", finishedAt: stamp() });
    } catch (error) {
      const reason = job.timedOut ? "发布用时过长，已停止。" : userMessage(error, "发布过程中出错。");
      if (job.clickedAt) update(job, { status: "unknown", step: "", reason: `${reason} 已经点过发布，请到平台核对；不会自动重发。`, finishedAt: stamp() });
      else update(job, { status: "failed", step: "", reason, finishedAt: stamp() });
    } finally {
      clearTimeout(watchdog); delete job.timedOut;
      activeBrowser = null;
      await browser?.close().catch(() => {});
      release?.();
    }
  }
  const nextJob = () => state.jobs.findLast((item) => item.status === "queued" && !(item.notBefore > now()));
  function pump() {
    if (pumping || closed) return pumping;
    clearTimeout(wakeTimer);
    pumping = (async () => {
      for (let job = nextJob(); job && !closed; job = nextJob()) {
        active = job; emit();
        try { await run(job); }
        catch {
          // A failed save or an unexpected error never leaves the queue stuck as busy.
          try { if (ACTIVE.has(job.status)) update(job, job.clickedAt ? { status: "unknown", reason: "保存发布结果时出错，请到平台核对；不会自动重发。" } : { status: "failed", reason: "发布过程中出错，可以重新发起。" }); } catch { /* State stays as last saved; restart recovery handles it. */ }
        } finally { active = null; emit(); }
      }
      // Jobs waiting for a busy account are picked up again later.
      const waiting = state.jobs.filter((item) => item.status === "queued" && item.notBefore > now());
      if (waiting.length && !closed) { wakeTimer = setTimeout(() => void pump(), Math.max(1000, Math.min(...waiting.map((item) => item.notBefore)) - now())); wakeTimer.unref?.(); }
    })().catch(() => {}).finally(() => { pumping = null; });
    return pumping;
  }
  function cancel(id) { const job = find(id); if (job.status !== "queued") throw fail("SOCIAL_JOB_BUSY", "只有还在排队的发布可以取消。"); update(job, { status: "cancelled", finishedAt: stamp() }); return snapshot(); }
  function retry(id) {
    const job = find(id);
    if (job.status !== "failed") throw fail("SOCIAL_JOB_NOT_RETRYABLE", job.status === "unknown" ? "这条可能已经发出，请先到平台核对，再标记结果。" : "这条发布不需要重试。");
    update(job, { status: "queued", reason: "", step: "", clickedAt: "", finishedAt: "", notBefore: 0 }); pump(); return snapshot();
  }
  // The user checked the platform for a job whose result was unknown.
  function resolve(id, published) {
    const job = find(id);
    if (job.status !== "unknown") throw fail("SOCIAL_JOB_NOT_UNKNOWN", "这条发布不需要核对。");
    update(job, published ? { status: "published", reason: "已由你在平台核对为已发出。" } : { status: "failed", clickedAt: "", reason: "已由你在平台核对为没有发出，可以重新发起。" });
    return snapshot();
  }
  function remove(id) {
    const job = find(id);
    if (ACTIVE.has(job.status) || job.status === "unknown") throw fail("SOCIAL_JOB_BUSY", job.status === "unknown" ? "请先到平台核对这条是否已发出，再删除记录。" : "进行中的发布不能删除记录。");
    state.jobs = state.jobs.filter((item) => item !== job); save(); emit(); return snapshot();
  }
  async function dispose() { closed = true; clearTimeout(wakeTimer); await activeBrowser?.close().catch(() => {}); await pumping?.catch(() => {}); }
  if (state.jobs.some((job) => job.status === "queued")) setTimeout(pump, 0).unref?.();
  return { snapshot, submit, cancel, retry, resolve, remove, pump, dispose, isBusy: () => Boolean(active) };
}

module.exports = { createSocialPublisher };
