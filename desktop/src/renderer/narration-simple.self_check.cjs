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
const { dayWord, updatedText, libraryStages, barText, formatCount } = loadTs("narration-simple.ts");

const now = new Date(2026, 9, 24, 15, 0);
assert.equal(dayWord(new Date(2026, 9, 24, 8, 0).toISOString(), now), "今天");
assert.equal(dayWord(new Date(2026, 9, 23, 8, 0).toISOString(), now), "昨天");
assert.equal(dayWord(new Date(2026, 9, 20, 8, 0).toISOString(), now), "10月20日");
assert.equal(dayWord(null, now), "最近", "没有更新时间时不说今天");
assert.equal(updatedText(new Date(2026, 9, 24, 8, 5).toISOString(), now), "今天 08:05 已更新");
assert.equal(updatedText("bad", now), "");
assert.equal(formatCount(1284), "1,284");

// 四段数字都来自文案库统计，不编造
assert.deepEqual(libraryStages({ collected: 1284, duplicates: 237, final: 92, ready: 36 }).map((s) => s.value), [1284, 1047, 92, 36]);
assert.equal(libraryStages({ collected: 1, duplicates: 5, final: 0, ready: 0 })[1].value, 0);

const job = (patch) => ({ status: "running", step: "voice", progress: 0, error: "", ...patch });
assert.equal(barText(undefined), null);
assert.deepEqual(barText(job({ step: "video", progress: 46 })), { tone: "busy", text: "正在生成数字人 · 46%", progress: 46 });
assert.equal(barText(job({ step: "voice", progress: 0 })).progress, 2, "刚开始也显示一点进度");
assert.equal(barText(job({ status: "done" })).tone, "done");
assert.equal(barText(job({ status: "failed", error: "数字人生成失败" })).text, "数字人生成失败");
assert.equal(barText(job({ status: "queued" })).text, "马上开始");

console.log("narration simple self-check passed: honest update wording, real stage numbers, progress bar text");
