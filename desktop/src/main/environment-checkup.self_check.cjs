const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createEnvironmentCheckup, wechatItem, displayItem, aiItem, diskItem } = require("./environment-checkup.cjs");

const GB = 1024 ** 3;
// 用户 2026-10-30：一键体检，每项给出“通过 / 怎么改”。
assert.equal(wechatItem({ installed: false }).status, "fail");
assert.equal(wechatItem({ installed: true, running: false, version: "4.1.15.56" }).status, "warn");
assert.equal(wechatItem({ installed: true, running: true, window: false, version: "4.1.15.56" }).status, "warn");
assert.equal(wechatItem({ installed: true, running: true, window: true, version: "4.1.13.22" }).status, "ok");
assert.match(wechatItem({ installed: true, running: true, window: true, version: "3.9.12.51" }).detail, /还没有在本软件上验证过/);
assert.equal(wechatItem({ error: "probe_failed" }).status, "warn");
assert.equal(displayItem({ scaleFactor: 1.25, workAreaSize: { width: 2048, height: 1112 } }).status, "ok");
assert.equal(displayItem({ scaleFactor: 1.75, workAreaSize: { width: 2048, height: 1112 } }).status, "warn");
assert.equal(displayItem({ scaleFactor: 1, workAreaSize: { width: 1024, height: 700 } }).status, "warn");
assert.equal(aiItem({ enabled: true, ready: false }).status, "fail");
assert.equal(aiItem({ enabled: true, ready: true, capabilities: { deepseek: true } }).status, "ok");
assert.equal(diskItem(1 * GB).status, "fail");
assert.equal(diskItem(5 * GB).status, "warn");
assert.equal(diskItem(50 * GB).status, "ok");

(async () => {
  const healthy = { wechat: async () => ({ installed: true, running: true, window: true, version: "4.1.15.56" }),
    getDisplay: () => ({ scaleFactor: 1, workAreaSize: { width: 1920, height: 1040 } }), gatewayStatus: () => ({ enabled: true, ready: true, capabilities: { deepseek: true } }),
    findBrowser: () => "chrome.exe", freeBytes: () => 80 * GB, totalMemory: () => 16 * GB, release: () => "10.0.19045" };
  const events = [];
  const logger = { event: (...args) => events.push(args) };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkup-"));
  const checkup = createEnvironmentCheckup({ rootDir: root, logger, ...healthy });
  assert.equal(checkup.last(), null, "第一次打开时还没有体检记录（界面据此自动体检一次）");
  const ok = await checkup.run();
  assert.equal(ok.problems, 0); assert.equal(events.length, 0, "全部正常不上报");
  assert.deepEqual(checkup.last(), ok, "结果存下来，下次打开不再自动弹出");
  // 有问题：一份现场包，code 指向最严重的一项，详情里列全部项目。
  const sick = createEnvironmentCheckup({ rootDir: root, logger, ...healthy,
    wechat: async () => ({ installed: true, running: false, version: "4.1.15.56" }), freeBytes: () => 1 * GB, findBrowser: () => { throw new Error("x"); } });
  const result = await sick.run();
  assert.equal(result.problems, 3);
  assert.equal(events.length, 1);
  const [module, event, details, options] = events[0];
  assert.equal(module, "checkup"); assert.equal(event, "checkup_problems");
  assert.deepEqual(options, { level: "error", code: "checkup_disk_fail" });
  assert.equal(details.items.length, 7);
  // 同时点两次只跑一次。
  const [a, b] = [checkup.run(), checkup.run()];
  assert.equal(a, b);
  await a;
  console.log("environment checkup self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });
