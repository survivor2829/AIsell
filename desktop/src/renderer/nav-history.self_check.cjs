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

const { remember, back } = loadTs("nav-history.ts");
const at = (active, view = "") => ({ active, view });

// 用户 2026-10-29：「返回上一级」回到刚才来的那一页，而不是一律回主页。
let stack = [];
stack = remember(stack, at("overview"), at("ai-video"));
stack = remember(stack, at("ai-video"), at("diagnostics"));
let result = back(stack, at("diagnostics"));
assert.deepEqual(result.place, at("ai-video"), "从数字人视频进吐槽中心，返回回到数字人视频");
result = back(result.stack, at("ai-video"));
assert.deepEqual(result.place, at("overview"));
assert.equal(back(result.stack, at("overview")).place, null, "没有来路时交给上层栏目或主页");

// 同一页里换子视图也算一级（线索视频混剪的产品、历史、素材）。
stack = remember([], at("workspace", "studio"), at("workspace", "history"));
assert.deepEqual(back(stack, at("workspace", "history")).place, at("workspace", "studio"));
// 原地不动不记；连续两次离开同一页只记一次；跳过和当前一样的记录。
assert.deepEqual(remember(stack, at("workspace", "history"), at("workspace", "history")), stack);
stack = remember(remember([], at("touch"), at("reply")), at("touch"), at("moments"));
assert.equal(stack.length, 1);
assert.deepEqual(back([at("reply"), at("touch")], at("touch")).place, at("reply"));
// 历史有上限，不会无限变长。
stack = [];
for (let i = 0; i < 50; i++) stack = remember(stack, at(`p${i}`), at(`p${i + 1}`));
assert.equal(stack.length, 30);
console.log("nav history self-check passed");
