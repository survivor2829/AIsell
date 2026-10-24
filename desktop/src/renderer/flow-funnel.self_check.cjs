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
const { viralFlow, layoutFlow, bundleStrands, describeHover, tagText } = loadTs("flow-funnel.ts");
const { rankCandidates } = require("../main/viral-ranking.cjs");

const now = Date.parse("2026-10-23T12:00:00Z"), day = 86400000;
const item = (id, patch) => ({ id, platform: "douyin", url: `https://www.douyin.com/video/${id}`, title: "", body: "",
  author: { name: "作者", followers: null }, publishedAt: new Date(now - 3 * day).toISOString(), metrics: { likes: null }, comments: null, ...patch });
const candidates = [
  item("1", { title: "物业经理千万别再招保洁了，一台洗地机顶6个人", metrics: { likes: 83900 }, author: { name: "保洁老周", followers: 120000 }, comments: ["多少钱", "能租吗", "怎么联系"] }),
  item("2", { title: "物业经理千万别再招保洁了，一台洗地机顶6个人！", metrics: { likes: 1200 } }),
  item("3", { title: "洗地机买还是租？算完这笔账", metrics: { likes: 21000 }, author: { name: "小王", followers: 1000 } }),
  item("4", { title: "车间地面油污一拖就花，换了洗地机才解决", metrics: { likes: 900 } }),
  item("5", { title: "今天的晚饭吃火锅", metrics: { likes: 99000 } }),
  item("6", { title: "扫地车实测", publishedAt: new Date(now - 45 * day).toISOString(), metrics: { likes: 50000 } })
];
const result = { ...rankCandidates(candidates, { industryIds: ["cleaning", "property", "factory"], days: 30, now }), days: 30 };
const seen = candidates.map((c) => ({ id: c.id, platform: c.platform, title: c.title, author: c.author.name }));

// 扒取中：只有读到的线，后三段没有数字，不编数
const live = viralFlow(seen.slice(0, 4));
assert.equal(live.strands.length, 4);
assert.ok(live.strands.every((s) => !s.outcome));
assert.deepEqual(live.stages.map((s) => s.value), [4, null, null, null]);
assert.equal(live.stages[0].note, "抖音 4");
const liveLayout = layoutFlow(live.strands, 800, 240);
assert.equal(liveLayout.decided, false);
assert.ok(liveLayout.lines.every((l) => l.end === liveLayout.x2 && l.bundle === -1), "没判定的线停在归并段末尾");

// 扒完：每条线都有去向，四段数字和统计一致
const done = viralFlow(seen, result);
const s = result.stats;
assert.equal(done.strands.length, s.collected);
assert.equal(done.strands.filter((x) => x.outcome === "pass").length, s.final);
assert.deepEqual(done.stages.map((x) => x.value), [s.collected, s.collected - s.duplicates, s.final, Math.min(10, s.final)]);
assert.match(done.stages[2].note, /和清洁无关 1/);
assert.match(done.stages[2].note, /过期 1/);
assert.equal(done.strands.find((x) => x.id === "2").group, "1", "搬运归到原作那一束");
assert.equal(done.strands.find((x) => x.id === "1").reason, "高赞 8.39w · 问价 3 条");

const layout = layoutFlow(done.strands, 800, 240);
assert.equal(layout.decided, true);
assert.equal(layout.lines.length, s.collected);
for (const l of layout.lines) {
  const b = layout.bundles[l.bundle];
  assert.equal(l.end, b.pass ? layout.icon.x : layout.gate + 800 * 0.045);
  assert.ok(l.ys.every(Number.isFinite));
}
const twinBundle = layout.bundles.find((b) => b.key === "1");
assert.equal(twinBundle.members.length, 2);
assert.equal(twinBundle.pass, true, "整束跟原作走");
const lineOf = (id) => layout.lines.findIndex((l) => l.strand.id === id);
assert.equal(describeHover(layout, lineOf("2"), 10).title, "物业经理千万别再招保洁了，一台洗地机顶6个人！");
assert.equal(describeHover(layout, lineOf("2"), 450).title, "同一文案 2 条");
assert.equal(describeHover(layout, lineOf("5"), 700).detail, "没进：和清洁行业无关");
assert.match(describeHover(layout, lineOf("3"), 700).detail, /^进候选：高赞/);

// 内容很多时束不超过 12，没通过的按原因合并，线条一条不少
const many = Array.from({ length: 150 }, (_, i) => ({ id: `m${i}`, title: `t${i}`, source: "抖音", group: `m${i}`, outcome: i % 10 === 0 ? "pass" : "drop", reason: ["不够爆", "和清洁行业无关", "超过 30 天"][i % 3] }));
const bundles = bundleStrands(many);
assert.ok(bundles.length <= 12);
assert.equal(bundles.reduce((n, b) => n + b.members.length, 0), 150);
assert.ok(bundles.filter((b) => !b.pass).every((b) => b.merged));
const passSlots = bundles.map((b, i) => b.pass ? i : -1).filter((i) => i >= 0);
assert.ok(passSlots[0] > 0 || passSlots.length === bundles.length, "通过的束分散在中间，不全挤在顶上");
assert.equal(layoutFlow(many, 1000, 240).lines.length, 150);
assert.equal(layoutFlow([], 800, 240).lines.length, 0);
// 通过的束也被合并时，悬停只数原作，搬运另说，和第 03 段的数字一致
const pairs = Array.from({ length: 14 }, (_, i) => [{ id: `p${i}`, title: "x", source: "抖音", group: `p${i}`, outcome: "pass", reason: "高赞 2w" },
  { id: `c${i}`, title: "x", source: "抖音", group: `p${i}`, outcome: "drop", reason: "搬运或重复" }]).flat();
const merged = layoutFlow(pairs, 800, 240);
assert.equal(merged.bundles.length, 1);
assert.deepEqual(describeHover(merged, 0, 700), { title: "14 条进候选", detail: "命中至少一种爆款指标，另有 14 条搬运并在这一束" });

// 同一 id 的线形状稳定：新内容进来后老线不跳
const a = layoutFlow(live.strands.slice(0, 2), 800, 240).lines[0].ys[10], b = layoutFlow(live.strands.slice(0, 2), 800, 240).lines[0].ys[10];
assert.equal(a, b);

assert.equal(tagText({ id: "underdog", label: "小号爆", value: 37 }), "小号爆 ×37");
assert.equal(tagText({ id: "high_likes", label: "高赞", value: 120000 }), "高赞 12w");
assert.equal(tagText({ id: "high_likes", label: "高赞", value: 8000 }), "高赞 8000");

console.log("flow funnel self-check passed: live strands without invented counts, every strand routed after ranking, duplicate bundles, stage numbers match stats, bundle cap, stable shapes, hover text");
