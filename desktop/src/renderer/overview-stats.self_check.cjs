const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

function loadTs(name) {
  const filename = path.join(__dirname, name);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, strict: true },
    fileName: filename
  }).outputText;
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(__dirname);
  compiled._compile(output, filename);
  return compiled.exports;
}

const { overviewStats, weekCount, gain, taskRuns, runDone } = loadTs("overview-stats.ts");
// Local noon, so "today" is the same day whatever the computer's time zone.
const now = new Date(2026, 9, 29, 12).getTime();
const ago = (days) => new Date(now - days * 86_400_000).toISOString();

// 主页数字：近 7 天对比再往前 7 天；读不出日期、未来日期、14 天以前的都不算。
assert.deepEqual(weekCount([{ createdAt: ago(1) }, { createdAt: ago(6.9) }, { createdAt: ago(8) }, { createdAt: ago(20) }, { createdAt: "坏日期" }, { createdAt: ago(-1) }], ["createdAt"], now), { now: 2, before: 1 });

const stats = overviewStats({
  // 成片：已不在本机的不算。
  finished: [{ createdAt: ago(1), available: true }, { createdAt: ago(2), available: false }, { createdAt: ago(9) }],
  // 线索：关键词获客按 createdAt，地图获客按 collectedAt，两边相加。
  acquisitionLeads: [{ createdAt: ago(1) }, { createdAt: ago(3) }],
  mapLeads: [{ collectedAt: ago(2) }, { collectedAt: ago(10) }],
  // 微信触达：只算触达任务，优先用已核实发送数，没有就用进度完成数。
  workflowTasks: [{ type: "touch", completedAt: ago(1), sent_verified_count: 30 }, { type: "touch", lastCompletedDate: ago(2), progress: { done: 12, total: 20 } },
    { type: "publish", completedAt: ago(1), progress: { done: 5 } }, { type: "touch", completedAt: ago(8), sent_verified_count: 9 }],
  // 今天发出：只算今天发布成功的，平台去重。
  publishJobs: [{ status: "published", finishedAt: ago(0.1), platform: "douyin" }, { status: "published", finishedAt: ago(0.2), platform: "douyin" },
    { status: "published", updatedAt: ago(0.05), platform: "channels" }, { status: "failed", finishedAt: ago(0.1), platform: "kuaishou" }, { status: "published", finishedAt: ago(1.5), platform: "kuaishou" }],
  materials: 240, tutorials: null,
  detailSaves: [{ at: ago(1) }, { at: ago(2) }, { at: ago(12) }]
}, now);
assert.deepEqual(stats.details, { now: 2, before: 1 }, "产品详情图按保存的张数算");
assert.deepEqual(stats.finished, { now: 1, before: 1 });
assert.deepEqual(stats.leads, { now: 3, before: 1 });
assert.deepEqual(stats.reached, { now: 42, before: 9 });
// 用户 2026-10-29：每天重复的触达任务每跑一次都要算上，不只算最近一次。
const daily = overviewStats({ workflowTasks: [{ type: "touch", completedAt: ago(0.5), progress: { done: 20 },
  runs: [{ completedAt: ago(0.5), done: 20 }, { completedAt: ago(1.5), done: 18 }, { completedAt: ago(2.5), done: 25 }, { completedAt: ago(9), done: 30 }] }] }, now);
assert.deepEqual(daily.reached, { now: 63, before: 30 });
// 用户 2026-11-19：触达了多少就实时算多少，任务没结束（进行中、暂停、需要处理、已取消）也算已经发出去的人。
const live = overviewStats({ workflowTasks: [
  { type: "touch", status: "running", startedAt: ago(0.1), occurrenceDate: "2026-10-29", progress: { done: 7, total: 50 } },
  { type: "touch", status: "needs_attention", startedAt: ago(0.2), progress: { done: 4, total: 9 } },
  { type: "touch", status: "cancelled", startedAt: ago(3), progress: { done: 2, total: 9 } },
  { type: "touch", status: "pending", startedAt: ago(0.3), progress: { done: 0, total: 9 } },
  // 每天重复：昨天的已记在 runs，今天这一轮还没跑完。
  { type: "touch", status: "paused", repeat: "daily", startedAt: ago(0.4), occurrenceDate: "2026-10-29", progress: { done: 3, total: 10 },
    runs: [{ occurrence: "2026-10-28", completedAt: ago(1), done: 10 }] },
  // 完成后重排跳过的人：这一轮已在 runs 里，不重复算。
  { type: "touch", status: "pending", startedAt: ago(0.5), occurrenceDate: "2026-10-29", progress: { done: 6, total: 8 },
    runs: [{ occurrence: "2026-10-29", completedAt: ago(0.45), done: 6 }] },
  { type: "touch", status: "completed", completedAt: ago(0.6), progress: { done: 5, total: 5 } },
  { type: "publish", status: "running", startedAt: ago(0.1), progress: { done: 1, total: 1 } }
] }, now);
assert.deepEqual(live.reached, { now: 7 + 4 + 2 + 3 + 10 + 6 + 5, before: 0 });
assert.deepEqual(taskRuns([{ type: "touch", status: "running", startedAt: ago(0.1), progress: { done: 7 } }], "touch").map(runDone), [7]);
assert.equal(stats.publishedToday, 3); assert.equal(stats.platformsToday, 2);
assert.equal(stats.materials, 240); assert.equal(stats.tutorials, null, "教程目录还没取到时不显示数字");
assert.equal(gain(stats.reached), 33); assert.equal(gain({ now: 1, before: 4 }), 0, "比上周少时不显示");
// 什么都没有时全是 0，不报错。
assert.deepEqual(overviewStats({}, now).finished, { now: 0, before: 0 });
console.log("overview stats self-check passed");
