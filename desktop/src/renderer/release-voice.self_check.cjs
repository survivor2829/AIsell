// Run through the renderer's own compiler so the check exercises the shipped TypeScript.
const assert = require("node:assert/strict");
const path = require("node:path");
const { transformSync } = require("esbuild");
const fs = require("node:fs");

const source = fs.readFileSync(path.join(__dirname, "release-voice.ts"), "utf8");
const moduleObject = { exports: {} };
new Function("module", "exports", transformSync(source, { loader: "ts", format: "cjs" }).code)(moduleObject, moduleObject.exports);
const { releaseVoice, groupOf } = moduleObject.exports;

assert.equal(groupOf("产品详情图可以选风格了"), "我学会的新本领");
assert.equal(groupOf("修复点进去却是别人的问题"), "帮你修好的");
assert.equal(groupOf("别人输错密码不再影响你登录"), "帮你修好的", "a fix wins over any other word in the sentence");
assert.equal(groupOf("页面排版调整得更舒服"), "让你更顺手的");

const notes = "1.2.77 更新内容\n• 产品详情图可以选风格了\n• 修复公告显示不全\n验证范围与注意事项\n• 其他电脑还没验证";
const voice = releaseVoice("1.2.77", notes);
assert.equal(voice.highlight, "产品详情图可以选风格了", "the first line is the headline");
assert.deepEqual(voice.groups.map((group) => group.title), ["我学会的新本领", "帮你修好的"]);
assert.deepEqual(voice.caveats, ["其他电脑还没验证"]);
assert.equal(voice.opener, releaseVoice("1.2.77", notes).opener, "the same release always says the same thing");
assert.match(releaseVoice("1.2.78", "• 修复一个问题").opener, /修|问题|收拾/, "a fixes-only release does not claim new skills");
assert.deepEqual(releaseVoice("1.0.0", "").groups, [], "an empty note does not break the page");
assert.equal(releaseVoice("1.2.9", "这次把启动速度调快了一些").highlight, "这次把启动速度调快了一些", "a plain paragraph is still shown");
console.log("release voice self-check passed");
