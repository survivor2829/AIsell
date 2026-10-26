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
const { libraryHeadline, libraryStages, barText, formatCount, longestScriptSeconds } = loadTs("narration-simple.ts");

// 大标题只说真实条数，不说哪天扒的（文案库一次扒好要用很久）
assert.equal(formatCount(1284), "1,284");
assert.deepEqual(libraryHeadline({ collected: 1284, ready: 36 }), { lead: "全网扒了 1,284 条清洁行业口播，", ready: "36 条爆款" });
assert.doesNotMatch(JSON.stringify(libraryHeadline({ collected: 1, ready: 1 })), /今天|昨天|月/);

// 四段数字都来自文案库统计，不编造
assert.deepEqual(libraryStages({ collected: 1284, duplicates: 237, final: 92, ready: 36 }).map((s) => s.value), [1284, 1047, 92, 36]);
assert.equal(libraryStages({ collected: 1, duplicates: 5, final: 0, ready: 0 })[1].value, 0);

// 仿写时长不超过本人视频，没上传视频时不限制
assert.equal(longestScriptSeconds(46.7), 46, "46.7 秒的视频可以选 45 秒，不能选 60 秒");
assert.equal(longestScriptSeconds(59.9), 59);
assert.equal(longestScriptSeconds(undefined), Infinity);

const job = (patch) => ({ status: "running", step: "voice", progress: 0, error: "", ...patch });
assert.equal(barText(undefined), null);
assert.deepEqual(barText(job({ step: "video", progress: 46 })), { tone: "busy", text: "正在生成数字人 · 46%", progress: 46 });
assert.equal(barText(job({ step: "voice", progress: 0 })).progress, 2, "刚开始也显示一点进度");
assert.equal(barText(job({ status: "done" })).tone, "done");
assert.equal(barText(job({ status: "failed", error: "数字人生成失败" })).text, "数字人生成失败");
assert.equal(barText(job({ status: "queued" })).text, "马上开始");

console.log("narration simple self-check passed: headline without dates, real stage numbers, progress bar text");
