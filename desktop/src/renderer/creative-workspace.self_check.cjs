const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "CreativeWorkspacePage.tsx"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "CreativeWorkspacePage.css"), "utf8");

for (const contract of [
  /xiaoxiContent/u,
  /creative\.analyzeAssets\(/u,
  /creative\.generateCourseCuts\(/u,
  /creative\.generateMixBatch\(/u,
  /creative\.listGenerated\(/u,
  /creative\.regenerate\(/u,
  /creative\.reject\(/u,
  /creative\.queue\(/u,
  /library\.probePending\(/u,
  /tasks\[action\]\(/u,
  /长课程精剪/u,
  /AI 批量混剪/u,
  /培训现场价值/u,
  /开场—过程—结果/u,
  /AI 推荐/u,
  /本地预筛/u,
  /字幕字号/u,
  /字幕位置/u,
  /recommendationReason/u,
  /standaloneValue/u,
  /接受/u,
  /淘汰/u,
  /重生成/u,
  /首轮仅内部查看/u,
  /不会自动发布/u
]) {
  assert.match(source, contract);
}

assert.match(source, /bailianKeyStatus/u);
assert.match(source, /saveBailianKey/u);
assert.match(source, /setCurrentTaskId\(""\)/u);
assert.match(source, /setCurrentTaskId\(result\.data\.taskId\)/u);
assert.match(source, /重新生成任务已开始/u);
assert.match(source, /let polling = false/u);
assert.match(source, /Promise\.all/u);
assert.match(source, /try[\s\S]*finally/u);
assert.match(source, /min=\{30\} max=\{90\}/u);
assert.match(source, /selectedVoiceAssets/u);
assert.match(source, /probeStatus === "pending"/u);
assert.match(source, /current\.text === "内容引擎暂时不可用，请重试。"/u);
assert.match(source, /capacitySummary/u);
assert.match(source, /xiaoxi-content:\/\/generated\/\$\{item\.generatedVideoId\}\/video/u);
const loadVideosSource = source.slice(
  source.indexOf("const loadVideos"),
  source.indexOf("const loadFoundation")
);
assert.doesNotMatch(loadVideosSource, /creative\.mediaUrl/u);
assert.match(styles, /workspace-mode-grid/u);
assert.match(styles, /workspace-video-grid/u);
assert.match(styles, /@media \(max-width: 850px\)/u);
assert.doesNotMatch(source, /mix\.createProject\(/u);

console.log("Creative workspace self-check passed");
