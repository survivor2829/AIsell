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
  /creative\.listPackagingPresets\(/u,
  /creative\.listBrandProfiles\(/u,
  /creative\.saveBrandProfile\(/u,
  /creative\.repackageVideo\(/u,
  /creative\.regenerateCover\(/u,
  /creative\.getPackagingCostEstimate\(/u,
  /creative\.listGenerated\(/u,
  /creative\.regenerate\(/u,
  /creative\.reject\(/u,
  /creative\.queue\(/u,
  /creative\.preflightVisualComparison\(/u,
  /creative\.createVisualComparisonTask\(/u,
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
  /一键网感包装/u,
  /智能分散模板/u,
  /AI 封面（固定）/u,
  /高质动态（内测）/u,
  /自动分散/u,
  /social_pop/u,
  /neo_editorial/u,
  /tech_motion/u,
  /同内容比较三种风格/u,
  /百炼 0 次/u,
  /APIMart 0 次/u,
  /本地渲染 3 次/u,
  /原 FFmpeg 基线/u,
  /本组均不达标/u,
  /已回退 FFmpeg/u,
  /legacy FFmpeg/u,
  /AI 封面预计调用/u,
  /providerConfigured/u,
  /plannedCount/u,
  /APIMart 尚未启用/u,
  /包装复用现有分析，不增加百炼调用/u,
  /百炼编导/u,
  /motionEventCount/u,
  /钩子/u,
  /参与度/u,
  /分享性/u,
  /换包装/u,
  /重做封面（1次）/u,
  /品牌包/u,
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
assert.match(source, /trackTask\(result\.data\.taskId/u);
assert.match(source, /重新生成任务已开始/u);
assert.match(source, /let polling = false/u);
assert.match(source, /taskMutationRef = useRef/u);
assert.match(source, /function beginTaskMutation/u);
assert.match(source, /const snapshot = \{/u);
assert.match(source, /snapshot\.visualRenderer[\s\S]*?visualRenderer: snapshot\.visualRenderer/u);
assert.match(source, /requestedEngine: "remotion"/u);
assert.match(source, /allowFallback: true/u);
assert.match(source, /coverMode: effectiveCoverMode/u);
assert.match(source, /packagingMode === "none" \? "none" : "ai_generate"/u);
assert.doesNotMatch(source, /本地真实画面（零调用）/u);
assert.match(source, /packagingMode: snapshot\.packagingMode/u);
assert.match(source, /const taskGeneration = taskGenerationRef\.current/u);
assert.match(source, /const isCurrent = \(\) => active/u);
assert.match(source, /taskGenerationRef\.current !== terminalGeneration/u);
assert.match(source, /import type \{ StyleId as VisualStyleId \}/u);
assert.match(source, /function sameTaskContent/u);
assert.match(source, /setCurrentTask\(\(current\) => sameTaskContent\(current, task\) \? current : task\)/u);
assert.match(source, /type ComparisonPreflightStatus = "idle" \| "checking" \| "ready" \| "blocked" \| "error"/u);
assert.match(source, /invalidateComparisonPreflight/u);
assert.match(source, /comparisonGroupId/u);
assert.match(source, /comparisonSourceCandidateId/u);
assert.match(source, /requestedEngine/u);
assert.match(source, /actualEngine/u);
assert.match(source, /fallbackCode/u);
assert.match(source, /visualRendererLegacy/u);
assert.match(source, /tasks\.list\(\{ limit: 500 \}\)/u);
assert.match(source, /RECOVERABLE_CREATIVE_TASKS/u);
assert.doesNotMatch(source, /renderRequestHash/u);
assert.doesNotMatch(source, /recipe(Json)?/iu);
assert.match(source, /visualStyleId: visualStylePreference/u);
assert.match(source, /LatestRequestGate/u);
assert.match(source, /SerializedMutationGate/u);
assert.match(source, /videoLoadGateRef/u);
assert.match(source, /taskActionGateRef/u);
assert.match(source, /taskActionBusy/u);
assert.match(source, /disabled=\{taskActionBusy \|\| Boolean\(busy\)\}/u);
assert.match(source, /beginTaskMutation\(mutationKey\)/u);
assert.match(source, /releaseTaskMutation\(mutationKey\)/u);
assert.match(source, /disabled=\{Boolean\(busy\)\}/u);
assert.match(source, /Promise\.all/u);
assert.match(source, /try[\s\S]*finally/u);
assert.match(source, /min=\{30\} max=\{90\}/u);
assert.match(source, /selectedVoiceAssets/u);
assert.match(source, /probeStatus === "pending"/u);
assert.match(source, /current\.text === "内容引擎暂时不可用，请重试。"/u);
assert.match(source, /capacitySummary/u);
assert.match(source, /xiaoxi-content:\/\/generated\/\$\{item\.generatedVideoId\}\/video/u);
assert.doesNotMatch(source, /mode === "course_experiment"/u);
assert.doesNotMatch(source, /百炼 × SupoClip 对照实验/u);
const loadVideosSource = source.slice(
  source.indexOf("const loadVideos"),
  source.indexOf("const loadFoundation")
);
assert.doesNotMatch(loadVideosSource, /creative\.mediaUrl/u);
const pollingSource = source.slice(
  source.indexOf("if (!currentTaskId) return;"),
  source.indexOf("async function importAssets")
);
assert.equal((pollingSource.match(/await loadVideos\(/gu) || []).length, 1, "terminal polling must refresh videos once");
assert.equal((pollingSource.match(/creative\.getProject\(/gu) || []).length, 1, "terminal polling must refresh its project at most once");
assert.ok(
  pollingSource.indexOf('setCurrentTaskId("")') < pollingSource.indexOf("await loadVideos("),
  "terminal polling must clear the active task before refreshes"
);
assert.match(styles, /workspace-mode-grid/u);
assert.match(styles, /grid-template-columns: repeat\(2,/u);
assert.match(styles, /workspace-video-grid/u);
assert.match(styles, /workspace-packaging-box/u);
assert.match(styles, /workspace-brand-panel/u);
assert.match(styles, /@media \(max-width: 850px\)/u);
assert.doesNotMatch(source, /mix\.createProject\(/u);

console.log("Creative workspace self-check passed");
