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
// viral-pipeline.ts 引用 ./flow-funnel，先放进模块缓存
const flow = loadTs("flow-funnel.ts");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) { return request === "./flow-funnel" ? "flow-funnel-stub" : originalResolve.call(this, request, parent, ...rest); };
require.cache["flow-funnel-stub"] = { id: "flow-funnel-stub", filename: "flow-funnel-stub", loaded: true, exports: flow };
const { likesText, dateText, viralReference, applyProgress, EMPTY_SCAN, resultSummary, estimateCny } = loadTs("viral-pipeline.ts");
Module._resolveFilename = originalResolve;
const { validateReference } = require("../main/narration-sources.cjs");

assert.equal(likesText(83900), "8.39w");
assert.equal(likesText(80000), "8w");
assert.equal(likesText(950), "950");
assert.equal(likesText(null), "点赞未知", "读不到的点赞不显示成 0");
assert.equal(dateText(null), "发布时间未知");
assert.match(dateText("2026-10-12T08:00:00+08:00"), /^10-1[12]$/);

// 「只仿写」带入的参考能通过主进程的参考校验，读不到的字段保持未知
const item = { id: "7400000000000000001", platform: "douyin", url: "https://www.douyin.com/video/7400000000000000001", title: "物业经理别再招保洁了".repeat(30),
  body: "正文".repeat(4000), author: { name: "保洁老周", followers: null }, publishedAt: null, publishedKnown: false, metrics: { likes: null }, tags: [], askingPriceComments: null };
const reference = viralReference(item, "2026-10-24T08:00:00Z");
const checked = validateReference(reference);
assert.equal(checked.platform, "douyin");
assert.equal(checked.title.length, 200);
assert.equal(checked.body.length, 6000);
assert.equal(checked.metrics.likes, null);
assert.equal(checked.publishedAt, null);
assert.equal(checked.provenance, "扒爆款 · 抖音");
assert.equal(viralReference({ ...item, url: "javascript:alert(1)" }, "x").url, "", "非 https 链接不带入");

// 进度事件累计：重复的内容不重复计数；被拦的平台单独记下
let state = applyProgress(EMPTY_SCAN, { stage: "collect", platform: "douyin", message: "抖音已读到 2 条", at: "", added: [{ id: "1", platform: "douyin", title: "a", author: "" }, { id: "2", platform: "douyin", title: "b", author: "" }] });
state = applyProgress(state, { stage: "collect", platform: "douyin", message: "抖音已读到 3 条", at: "", added: [{ id: "2", platform: "douyin", title: "b", author: "" }, { id: "3", platform: "douyin", title: "c", author: "" }] });
state = applyProgress(state, { stage: "blocked", platform: "xiaohongshu", message: "小红书需要先登录", at: "" });
assert.deepEqual(state.seen.map((x) => x.id), ["1", "2", "3"]);
assert.equal(state.message, "抖音已读到 3 条", "被拦的提示不冒充进度");
assert.deepEqual(state.blocked, { xiaohongshu: "小红书需要先登录" });

const summary = resultSummary({ stopped: true, stats: { collected: 30, final: 4 }, platforms: [{ name: "抖音", status: "ok" }, { name: "小红书", status: "blocked" }] });
assert.equal(summary, "30 条里挑出 4 条爆款；已暂停，结果只含暂停前读到的内容；小红书没有扒到，需要先登录或完成验证");

assert.equal(estimateCny(45), "3.8 元（按 45 秒）");
assert.equal(estimateCny(undefined), "3—4 元", "没有人物时长时给区间，不编精确数");
console.log("viral pipeline self-check passed: likes/date labels without guessing, imitate reference passes main validation, progress accumulation, blocked platforms, honest summary");
