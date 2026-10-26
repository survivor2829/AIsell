const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSocialPublisher } = require("./social-publisher.cjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A fake platform whose behaviour each case scripts: what the form ends up holding,
// whether a verification box shows, whether the page reaches the success URL, and
// whether the post is then found on the work management page.
function world(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-publish-"));
  const video = path.join(root, "成片.mp4"); fs.writeFileSync(video, "mp4");
  const log = { launches: 0, closed: 0, clicks: 0, leases: 0, released: 0, typed: [] };
  const behaviour = { login: false, typedTitle: null, privateOk: true, verifyPolls: 0, success: true, listed: true, publishFound: true, ignoreSets: 0, staleDraft: false, launchError: null, editAfterFirstMiss: false, ...overrides };
  let sets = 0;
  let url = "", verifyLeft = behaviour.verifyPolls;
  const page = { url: async () => url, front: async () => {}, evaluate: async (expression) => expression === "document.readyState" ? "complete" : "" };
  const driver = {
    name: "抖音", host: "douyin.com", uploadUrl: "https://creator.douyin.com/upload", manageUrl: "https://creator.douyin.com/manage", titleLimit: 30, supportsPrivate: true,
    loginRequired: () => behaviour.login,
    uploaded: async () => behaviour.staleDraft || sets > behaviour.ignoreSets,
    fill: async (_page, job) => { log.typed.push(job.title); return { read: async () => behaviour.typedTitle ?? job.title }; },
    formMatches: (value, job) => value === job.title,
    privateChecked: async () => behaviour.privateOk,
    publish: async () => { if (!behaviour.publishFound) { if (behaviour.editAfterFirstMiss) behaviour.typedTitle = "被改过的标题"; return false; } log.clicks++; if (!verifyLeft && behaviour.success) url = "https://creator.douyin.com/manage"; return true; },
    published: (current) => /manage/.test(current)
  };
  const channels = { ...driver, name: "视频号", titleLimit: 0, supportsPrivate: false };
  const steps = {
    findVideoInput: async () => ({ backendNodeId: 1 }),
    verificationShown: async () => { if (verifyLeft > 0) { verifyLeft--; if (!verifyLeft && behaviour.success) url = "https://creator.douyin.com/manage"; return true; } return false; },
    listed: async () => behaviour.listed
  };
  page.setFile = async () => { sets++; log.sets = sets; };
  const accountList = [{ id: "a-douyin", platform: "douyin", label: "抖音号", status: "active" }, { id: "a-channels", platform: "channels", label: "视频号", status: "active" }];
  let busy = new Set();
  const accounts = {
    snapshot: () => ({ accounts: accountList }),
    profileDir: (id) => path.join(root, "profiles", id),
    lease: (id) => { if (busy.has(id)) throw Object.assign(new Error("这个账号的浏览器正在使用"), { code: "SOCIAL_ACCOUNT_BUSY" }); busy.add(id); log.leases++; return () => { busy.delete(id); log.released++; }; }
  };
  const launch = () => { if (behaviour.launchError) throw behaviour.launchError; log.launches++; sets = 0; url = "https://creator.douyin.com/upload"; return { close: async () => { log.closed++; } }; };
  const make = (extra = {}) => createSocialPublisher({ dataDir: path.join(root, "data"), accounts, launch, executable: "chrome.exe", attach: async () => page, steps,
    driverFor: (platform) => platform === "channels" ? channels : driver, timing: { settle: 1, poll: 2, button: 1, react: 50, upload: 2000, result: 300, busyRetry: 40 }, ...extra });
  const until = async (publisher, done) => { for (let i = 0; i < 2000; i++) { const state = publisher.snapshot(); if (done(state)) return state; await sleep(5); } throw new Error("timeout " + JSON.stringify(publisher.snapshot().jobs.map((job) => job.status))); };
  return { root, video, log, behaviour, accounts, make, until, setBusy: (id) => busy.add(id), clearBusy: (id) => busy.delete(id) };
}
const finished = (state) => state.jobs.length && state.jobs.every((job) => !["queued", "running", "clicked", "needs_user"].includes(job.status));

(async () => {
  {
    // 正常发布：发出后在作品管理里核对到，才算已发出；浏览器关闭、账号释放。
    const w = world(), p = w.make();
    const result = p.submit({ videos: [{ path: w.video, name: "成片" }], accountIds: ["a-douyin"], title: "清洁设备怎么选", visibility: "private" });
    assert.equal(result.created, 1);
    const state = await w.until(p, finished);
    assert.equal(state.jobs[0].status, "published", state.jobs[0].reason);
    assert.ok(state.jobs[0].clickedAt);
    assert.equal(state.jobs[0].videoPath, undefined, "文件路径不发给界面");
    assert.deepEqual([w.log.launches, w.log.closed, w.log.clicks, w.log.leases, w.log.released], [1, 1, 1, 1, 1]);
    // 同一条视频、同一标题、同一账号不会再排第二次。
    const again = p.submit({ videos: [{ path: w.video, name: "成片" }], accountIds: ["a-douyin"], title: "清洁设备怎么选" });
    assert.equal(again.created, 0); assert.equal(again.skipped.length, 1);
    await p.dispose();
  }
  {
    // 填好的标题和预期不一致（例如有人在窗口里打字）：不点发布。
    const w = world({ typedTitle: "清洁设备怎么选ce's" }), p = w.make();
    p.submit({ videos: [{ path: w.video }], accountIds: ["a-douyin"], title: "清洁设备怎么选啊" });
    const job = (await w.until(p, finished)).jobs[0];
    assert.equal(job.status, "failed"); assert.match(job.reason, /不一致/); assert.equal(w.log.clicks, 0); assert.equal(job.clickedAt, "");
    // 没点过发布的失败可以重试。
    w.behaviour.typedTitle = null;
    p.retry(job.id);
    assert.equal((await w.until(p, finished)).jobs[0].status, "published");
    await p.dispose();
  }
  {
    // 要求仅自己可见但没能设上：不发。
    const w = world({ privateOk: false }), p = w.make();
    p.submit({ videos: [{ path: w.video }], accountIds: ["a-douyin"], title: "测试", visibility: "private" });
    const job = (await w.until(p, finished)).jobs[0];
    assert.equal(job.status, "failed"); assert.equal(w.log.clicks, 0);
    await p.dispose();
  }
  {
    // 平台要求验证：状态变成「等你验证」，验证后继续并核对。
    const w = world({ verifyPolls: 4 }), p = w.make();
    const seen = new Set();
    const stop = setInterval(() => { for (const job of p.snapshot().jobs) seen.add(job.status); }, 1);
    p.submit({ videos: [{ path: w.video }], accountIds: ["a-douyin"], title: "测试" });
    const job = (await w.until(p, finished)).jobs[0]; clearInterval(stop);
    assert.ok(seen.has("needs_user"), "验证期间显示等你验证");
    assert.equal(job.status, "published");
    await p.dispose();
  }
  {
    // 点了发布但核对不到：结果不明，不能直接重试；用户核对没发出后才能重发。
    const w = world({ listed: false }), p = w.make();
    p.submit({ videos: [{ path: w.video }], accountIds: ["a-douyin"], title: "测试" });
    const job = (await w.until(p, finished)).jobs[0];
    assert.equal(job.status, "unknown"); assert.match(job.reason, /不会自动重发/);
    assert.throws(() => p.retry(job.id), { code: "SOCIAL_JOB_NOT_RETRYABLE" });
    p.resolve(job.id, false);
    assert.equal(p.snapshot().jobs[0].status, "failed");
    w.behaviour.listed = true; p.retry(job.id);
    assert.equal((await w.until(p, finished)).jobs[0].status, "published");
    assert.equal(w.log.clicks, 2, "只有用户确认没发出后才点第二次");
    await p.dispose();
  }
  {
    // 点了发布但一直等不到平台结果：结果不明。
    const w = world({ success: false, listed: false }), p = w.make();
    p.submit({ videos: [{ path: w.video }], accountIds: ["a-douyin"], title: "测试" });
    assert.equal((await w.until(p, finished)).jobs[0].status, "unknown");
    await p.dispose();
  }
  {
    // 需要重新登录、找不到发布按钮、账号被占用：都不发，可以重试。
    const w = world({ login: true }), p = w.make();
    p.submit({ videos: [{ path: w.video }], accountIds: ["a-douyin"], title: "测试" });
    let job = (await w.until(p, finished)).jobs[0];
    assert.equal(job.status, "failed"); assert.match(job.reason, /重新扫码登录/);
    w.behaviour.login = false; w.behaviour.publishFound = false;
    p.retry(job.id);
    job = (await w.until(p, finished)).jobs[0];
    assert.equal(job.status, "failed"); assert.equal(job.clickedAt, ""); assert.match(job.reason, /发布按钮/);
    // 账号浏览器暂时被占用（登录窗口、刷新状态）：排队等待，空出来后自动继续。
    w.setBusy("a-douyin"); w.behaviour.publishFound = true;
    p.retry(job.id);
    await sleep(20);
    job = p.snapshot().jobs[0];
    assert.equal(job.status, "queued"); assert.match(job.reason, /稍后自动继续/);
    w.clearBusy("a-douyin");
    assert.equal((await w.until(p, finished)).jobs[0].status, "published");
    await p.dispose();
  }
  {
    // 页面第一次没接收文件：再设一次就好；两次都不接收：不发，也不点发布。
    const w = world({ ignoreSets: 1 }), p = w.make();
    p.submit({ videos: [{ path: w.video }], accountIds: ["a-douyin"], title: "测试" });
    assert.equal((await w.until(p, finished)).jobs[0].status, "published"); assert.equal(w.log.sets, 2);
    await p.dispose();
    const w2 = world({ ignoreSets: 5 }), p2 = w2.make();
    p2.submit({ videos: [{ path: w2.video }], accountIds: ["a-douyin"], title: "测试" });
    const job = (await w2.until(p2, finished)).jobs[0];
    assert.equal(job.status, "failed"); assert.match(job.reason, /没有接收视频文件/); assert.equal(w2.log.clicks, 0); assert.equal(w2.log.sets, 2);
    await p2.dispose();
  }
  {
    // 页面里残留着旧草稿视频：不发，也不上传。
    const w = world({ staleDraft: true }), p = w.make();
    p.submit({ videos: [{ path: w.video }], accountIds: ["a-douyin"], title: "测试" });
    const job = (await w.until(p, finished)).jobs[0];
    assert.equal(job.status, "failed"); assert.match(job.reason, /草稿/); assert.equal(w.log.clicks, 0); assert.equal(w.log.sets, undefined);
    await p.dispose();
    // 结果不明的记录不能删除；系统错误不把本机路径带给界面。
    const w2 = world({ listed: false }), p2 = w2.make();
    p2.submit({ videos: [{ path: w2.video }], accountIds: ["a-douyin"], title: "测试" });
    const unknown = (await w2.until(p2, finished)).jobs[0];
    assert.throws(() => p2.remove(unknown.id), { code: "SOCIAL_JOB_BUSY" });
    w2.behaviour.launchError = Object.assign(new Error("EPERM: operation not permitted, mkdir 'C:/Users/someone/profiles'"), { code: "EPERM" });
    p2.submit({ videos: [{ path: w2.video }], accountIds: ["a-douyin"], title: "另一条" });
    const failed = (await w2.until(p2, (state) => finished(state) && state.jobs.length === 2)).jobs[0];
    assert.equal(failed.status, "failed"); assert.doesNotMatch(failed.reason, /Users|EPERM/);
    await p2.dispose();
  }
  {
    // 第一次没找到发布按钮，等待期间内容被改动：不再点击。
    const w = world({ publishFound: false, editAfterFirstMiss: true }), p = w.make();
    p.submit({ videos: [{ path: w.video }], accountIds: ["a-douyin"], title: "测试" });
    const job = (await w.until(p, finished)).jobs[0];
    assert.equal(job.status, "failed"); assert.match(job.reason, /被改动/); assert.equal(job.clickedAt, ""); assert.equal(w.log.clicks, 0);
    await p.dispose();
  }
  {
    // 一次排太多：拒绝，而不是悄悄截断。
    const w = world(), p = w.make();
    const many = Array.from({ length: 101 }, () => ({ path: w.video }));
    assert.throws(() => p.submit({ videos: many, accountIds: ["a-douyin"], title: "测试" }), { code: "SOCIAL_SUBMIT_TOO_LARGE" });
    await p.dispose();
  }
  {
    // 提交前的检查：视频号不能仅自己可见、标题超长、视频不存在、每天上限。
    const w = world(), p = w.make({ dailyLimit: 1 });
    assert.throws(() => p.submit({ videos: [{ path: w.video }], accountIds: ["a-channels"], title: "测试", visibility: "private" }), { code: "SOCIAL_PRIVATE_UNSUPPORTED" });
    assert.throws(() => p.submit({ videos: [{ path: w.video }], accountIds: ["a-douyin"], title: "一".repeat(31) }), { code: "SOCIAL_TITLE_TOO_LONG" });
    assert.throws(() => p.submit({ videos: [{ path: path.join(w.root, "missing.mp4") }], accountIds: ["a-douyin"], title: "测试" }), { code: "SOCIAL_VIDEO_MISSING" });
    assert.throws(() => p.submit({ videos: [{ path: w.video }], accountIds: ["a-douyin"], title: " " }), { code: "SOCIAL_TITLE_REQUIRED" });
    p.submit({ videos: [{ path: w.video }], accountIds: ["a-douyin"], title: "第一条" });
    await w.until(p, finished);
    p.submit({ videos: [{ path: w.video }], accountIds: ["a-douyin"], title: "第二条" });
    const second = (await w.until(p, (state) => finished(state) && state.jobs.length === 2)).jobs[0];
    assert.equal(second.status, "failed"); assert.match(second.reason, /今天已经发了 1 条/);
    await p.dispose();
  }
  {
    // 重启：点过发布的中断记录变成结果不明，没点过的变成可重试的失败；都不自动重发。
    const w = world(), dataDir = path.join(w.root, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const base = { accountId: "a-douyin", accountLabel: "抖音号", platform: "douyin", videoPath: w.video, videoName: "成片", title: "测试", description: "", visibility: "public", step: "", reason: "", createdAt: "", updatedAt: "", finishedAt: "" };
    fs.writeFileSync(path.join(dataDir, "state.json"), JSON.stringify({ version: 1, jobs: [
      { ...base, id: "j1", status: "needs_user", clickedAt: "2026-10-26T00:00:00Z" },
      { ...base, id: "j2", status: "running", clickedAt: "" }] }));
    const p = w.make();
    const byId = Object.fromEntries(p.snapshot().jobs.map((job) => [job.id, job.status]));
    assert.deepEqual(byId, { j1: "unknown", j2: "failed" });
    await sleep(30); assert.equal(w.log.clicks, 0);
    await p.dispose();
    fs.writeFileSync(path.join(dataDir, "state.json"), "{broken");
    assert.throws(() => w.make(), { code: "SOCIAL_PUBLISH_STATE_INVALID" });
    fs.rmSync(w.root, { recursive: true, force: true });
  }
  console.log("social publisher self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });
