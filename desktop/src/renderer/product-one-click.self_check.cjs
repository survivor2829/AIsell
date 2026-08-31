const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const page = fs.readFileSync(path.join(__dirname, "ProductOneClickPage.tsx"), "utf8");
const resources = fs.readFileSync(path.join(__dirname, "AutoMixResourcePanel.tsx"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "ProductOneClickPage.css"), "utf8");
const studio = fs.readFileSync(path.join(__dirname, "CreativeStudioPage.tsx"), "utf8");

assert.match(page, /createAutoMixV2\(\{\s*specVersion: "2",\s*guidedSessionId: guidedSession\.sessionId,\s*scriptRevision: guidedSession\.draft\.scriptRevision/su, "新项目必须只提交已确认的引导脚本版本");
assert.match(page, /prepareGuidedAutoMix\(\{ assetIds: selected \}\)/u, "素材必须先进入引导解析任务");
assert.match(page, /const prepareGuidedAutoMix = current\.creative\?\.prepareGuidedAutoMixV2/u, "页面必须先识别旧 preload 缺少的引导解析接口");
assert.match(page, /当前窗口仍在使用旧的本地生成服务/u, "旧 preload 不得被误报为素材解析连接中断");
assert.match(page, /generateGuidedAutoMixScriptV2\(\{/u, "填写内容必须通过独立的 AI 脚本任务生成");
assert.match(page, /analysisTaskId: guidedSession\.analysisTask\?\.taskId \|\| undefined/u, "脚本点击必须携带稳定的素材解析任务，用于在主进程重新定位当前会话");
assert.match(page, /applyGuidedFormSuggestions[\s\S]+restored\.prefill\?\.answers/u, "素材解析建议必须独立于用户确认的填写内容");
assert.match(page, /applyGuidedFormSuggestions\(next\)[\s\S]+已根据本次素材预填建议内容/u, "解析完成后必须把本次素材建议填入可编辑表单");
assert.match(page, /errorCode\?: string \| null/u, "引导任务必须接收后端公开的失败码");
assert.match(page, /const guidedKnownDraftFailure = Boolean\([\s\S]+draftTask\?\.errorCode === "product_copy_invalid"/u, "已确认的脚本结构校验失败必须与外部结果未知分开处理");
assert.match(page, /AI 脚本未通过结构化校验；素材解析和填写内容已保留，可直接再次生成 AI 脚本。/u, "已知脚本校验失败必须保留填写并给出直接重试入口");
assert.match(page, /const guidedDraftFailureText = guidedSession\?\.draftTask\?\.errorMessage\?\.trim\(\)[\s\S]+guidedSession\.draftTask\.errorMessage\.trim\(\)/u, "已知脚本校验失败必须显示后端受控的具体原因");
assert.match(page, /guidedKnownDraftFailure[\s\S]+<span>\{guidedDraftFailureText\}<\/span>/u, "具体原因只能出现在已知脚本校验失败的就近提示中");
assert.doesNotMatch(
  page,
  /setNotice\(\{ tone: "error", text: "AI 脚本未通过结构化校验；素材解析和填写内容已保留，可直接再次生成 AI 脚本。" \}\);/u,
  "已知脚本校验失败只能在脚本按钮附近提示一次，不得再显示顶部重复错误"
);
assert.match(page, /guidedKnownDraftFailure \|\| guidedSession\.draft\.scriptRevision \? "重新生成 AI 脚本" : "AI 生成脚本"/u, "已知脚本校验失败必须把下一次明确点击标为重新生成");
assert.match(page, /guidedFormEditedRef\.current = true/u, "用户手动修改后不得被解析建议覆盖");
assert.doesNotMatch(page, /placeholder="例如：/u, "引导输入不得显示固定示例内容");
assert.match(page, /scriptGenerateDisabledReason/u, "脚本按钮不可用时必须说明原因");
assert.match(
  page,
  /result\.code === "guided_auto_mix_session_not_found"[\s\S]+guidedSession\.analysisTask\?\.taskId[\s\S]+getGuidedAutoMixSessionV2\(\{ taskId \}\)[\s\S]+hydrateGuidedSession\(recovered\.data, \{ preserveInputs: true \}\)[\s\S]+填写内容已保留[\s\S]+再次点击 AI 生成脚本/u,
  "过期会话必须按素材解析任务恢复，并保留用户填写后等待新的明确点击"
);
assert.match(
  page,
  /recovered\.data\.status === "ready_for_render"[\s\S]+setScriptInputDirty\(true\)/u,
  "恢复到已有脚本时必须要求用户重新生成，不能把保留的填写内容误用于旧脚本"
);
assert.match(page, /getGuidedAutoMixSupplementalImageV2\(\{/u, "已确认脚本必须读取对应补图状态");
assert.match(page, /createGuidedAutoMixSupplementalImageV2\(\{/u, "补图必须通过独立的显式请求生成");
assert.match(page, /data-xiaoxi-auto-mix-supplemental-image/u, "补图生成必须绑定可信点击入口");
assert.match(page, /1 次可能计费的 AI 图片生成/u, "补图生成必须明确可能计费");
assert.match(page, /AI 场景辅助图（非原始素材）/u, "补图不得被表述为真实素材");
assert.match(page, /getAutoMixPlanV2\(\{ runId: plan\.runId \}\)/u, "V2 任务必须按当前运行编号轮询，不能跳到同项目的其他任务");
assert.match(page, /target\.runId \? \{ runId: target\.runId \} : \{ projectId: target\.projectId \}/u, "从任务中心恢复 V2 时必须优先打开用户点击的那条运行记录");
const restoreFixture = {
  inputAssetIds: ["asset-1", "asset-2", "asset-3", "asset-4", "asset-5"],
  selectedSegments: ["asset-1", "asset-2", "asset-3"].map((assetId) => ({ assetId }))
};
const expectedRestoredAssetIds = restoreFixture.inputAssetIds.length
  ? restoreFixture.inputAssetIds
  : [...new Set(restoreFixture.selectedSegments.map((item) => item.assetId))];
assert.equal(expectedRestoredAssetIds.length, 5, "恢复页必须区分 5 条原始输入和 3 条成片采用素材");
assert.match(page, /inputAssetIds\?: string\[\]/u, "V2 页面计划类型必须接收公开只读的原始素材 ID");
assert.match(
  page,
  /const restoredAssetIds = restored\.inputAssetIds\?\.length\s*\? restored\.inputAssetIds\s*: restored\.selectedSegments[\s\S]+setSelected\(\[\.\.\.new Set\(restoredAssetIds\)\]\)/u,
  "恢复页必须优先还原全部 inputAssetIds，旧记录才回退到 selectedSegments"
);
assert.ok(
  (page.match(/hydrateAutoMixPlan\(/gu) || []).length >= 2,
  "任务恢复和 projectId 深链恢复必须共用同一套 V2 页面状态还原"
);
assert.match(page, /regenerateAutoMixLayer\(\{\s*projectId: plan\.projectId,\s*expectedRunId: plan\.runId,\s*layer\s*\}\)/su, "局部重做必须绑定当前 run，不能把旧任务操作落到同项目的新运行");
assert.match(page, /result\.code === "auto_mix_run_stale"[\s\S]+getAutoMixPlanV2\(\{ projectId: plan\.projectId \}\)[\s\S]+hydrateAutoMixPlan\(latest\.data\)/u, "旧任务已过期时必须刷新最新计划，而不是重复提交旧层");
for (const layer of ["text", "voice", "music"]) {
  assert.match(page, new RegExp(`AUTO_MIX_LAYERS[^\\n]+\\"${layer}\\"`), `必须提供 ${layer} 层的局部重做入口`);
}
assert.match(page, /regenerationLayers\.map\(\(layer\) =>/u, "局部重做入口必须逐层生成");
assert.doesNotMatch(page, /regenerate\("all"\)|layer: "all"/u, "页面不得提供整条全量重做入口");

for (const removedControl of [
  /createOneClickProject/u,
  /generateOneClickCandidates/u,
  /bgmAssetId/u,
  /source_voice/u,
  /APIMart/u,
  /saveBailianKey/u,
  /apiHost/u
]) {
  assert.doesNotMatch(page, removedControl, "V2 页面不得恢复旧版数量、时长、声音、BGM 或付费封面控制");
}
assert.doesNotMatch(page, /<input[^>]+type="number"/u, "V2 表单不得暴露数量或时长输入");
assert.doesNotMatch(page, /<label>\s*(?:目标时长|候选数量|背景音乐|素材原声|API Host)/u, "V2 表单不得显示旧版高级控制标签");
assert.match(page, /视频标题/u);
assert.match(page, /maxLength=\{100\}/u, "标题输入上限必须与 IPC 的 100 字契约一致");
assert.match(page, /最多 100 字/u, "标题输入必须明确提示 100 字上限");
assert.doesNotMatch(page, /文案框架/u, "页面不得再要求用户填写大段文案框架");
assert.doesNotMatch(page, /<textarea/u, "引导流程不得再显示大文本框");
assert.match(page, /type AutoMixDurationPlan/u, "引导脚本必须接收后端的只读自动时长规划");
assert.match(page, /智能适配：预计约/u, "素材解析和脚本预览必须展示自动适配时长");
assert.match(page, /const draftSpokenPhrases/u, "脚本预览必须逐段展示口播，而不是只显示一整句");
assert.match(page, /!guidedSession\?\.draft\?\.durationPlan\?\.targetDurationMs/u, "旧脚本缺少自动时长规划时不得直接进入成片");
for (const question of ["公司名称（可选）", "介绍的产品或服务", "主要应用场景（可选）", "最想表达的一句话（可选）", "还要保留或避开的信息（可选）"]) {
  assert.match(page, new RegExp(question), `缺少引导问题：${question}`);
}
assert.match(page, /固定生成 1 条/u, "V2 页面必须明确只有一条输出");
assert.match(page, /<h1>一键成片<\/h1>/u, "主界面标题必须直接说明一键成片");
assert.match(page, /let createButtonLabel = "一键生成";[\s\S]+if \(planRunning\) \{[\s\S]+createButtonLabel = "正在生成成片…";[\s\S]+else if \(plan\?\.state === "outcome_unknown"\)[\s\S]+createButtonLabel = "请先查询当前结果";[\s\S]+else if \(canContinueFromIssue\)[\s\S]+createButtonLabel = "请先继续当前成片";[\s\S]+else if \(planCanBeRevised\)[\s\S]+createButtonLabel = "修改后重新生成";/u, "主操作必须使用当前状态对应的用户可理解文案");
assert.match(page, /const planRequiresResolution = Boolean\([\s\S]+"outcome_unknown" \|\| canContinueFromIssue/u, "可原地恢复或结果未知的任务必须阻止顶部重复提交");
assert.match(page, /disabled=\{Boolean\(busy\) \|\| planRunning \|\| planRequiresResolution[\s\S]+guidedSession\?\.status !== "ready_for_render"/u, "成片必须等待已确认的引导脚本");
assert.match(page, /canContinueFromIssue[\s\S]+"请先继续当前成片"/u, "顶部按钮必须把用户引导到唯一的恢复入口");
assert.match(page, /canContinueFromIssue \? "点击“继续生成成片”[\s\S]+"请修改素材、标题或文案后重新生成。"/u, "失败提示必须与实际可用恢复路径一致");
assert.match(page, /const planCanBeRevised = Boolean\([\s\S]+!canContinueFromIssue/u, "素材或文案问题必须允许修改后重新生成");
assert.match(page, /const formLocked = planRunning \|\| planRequiresResolution \|\| guidedRunning/u, "当前任务未解决时不得允许编辑不会生效的输入");
assert.match(page, /planProgressVisible && <progress/u, "失败和待处理状态不得伪装成 100% 完成进度");
assert.match(page, /先解析素材，再用少量问题生成脚本/u, "主界面必须用一句话说明最短流程");
assert.doesNotMatch(page, /<aside className="product-sidebar">/u, "默认主界面不得展示技术规则侧栏");
assert.doesNotMatch(page, /声音试听与批准/u, "声音资源维护不得成为默认主流程入口");
assert.doesNotMatch(page, /授权曲库管理/u, "音乐资源维护不得成为默认主流程入口");
assert.match(page, /<details className="product-quality-details">/u, "技术质量证据必须渐进披露");
assert.match(page, /plan\.state === "needs_attention"[\s\S]+openResources/u, "只有资源异常时才可打开维护面板");

assert.match(page, /plan\?\.state === "completed"/u, "正式结果必须由 completed 状态门控");
assert.match(page, /plan\.qualityReport\?\.passed === true/u, "正式结果必须由质量报告门控");
assert.match(page, /plan\.music\.licenseSummary\.commercialUseAllowed === true/u, "正式结果必须明确验证音乐允许商用");
assert.match(page, /plan\.music\.licenseSummary\.evidencePresent === true/u, "正式结果必须验证音乐授权凭证存在");
assert.match(page, /plan\?\.voicePersona\?\.approvalStatus === "approved"/u, "正式结果必须使用已批准的声音人格");
assert.match(page, /candidate\?\.actualEngine === "remotion"/u, "正式结果必须由候选的 Remotion 实际引擎证据门控");
assert.match(page, /FFmpeg 基础输出/u, "FFmpeg fallback 不得被当作 V2 正式完成");
assert.match(page, /formalPreviewReady && candidate/u, "预览必须等待完整正式证据");
assert.match(page, /disabled=\{!formalEvidenceReady/u, "下载必须等待完整正式证据");

assert.match(page, /const requestEpoch = \+\+candidateEpochRef\.current/u, "每次候选请求必须取得新的 epoch");
assert.match(page, /if \(requestEpoch !== candidateEpochRef\.current\) return/u, "过期候选响应不得覆盖当前任务");
assert.match(page, /data-xiaoxi-auto-mix-create/u, "创建任务按钮必须标记为可信点击入口");
assert.match(page, /data-xiaoxi-auto-mix-prepare/u, "素材解析按钮必须标记为可信点击入口");
assert.match(page, /data-xiaoxi-auto-mix-script/u, "AI 脚本按钮必须标记为可信点击入口");
assert.match(page, /data-xiaoxi-auto-mix-regenerate/u, "局部重做按钮必须标记为可信点击入口");
assert.match(
  page,
  /canContinueFromIssue && continuationLayer[\s\S]+data-xiaoxi-auto-mix-continue[\s\S]+继续生成成片/u,
  "已知故障层必须直接提供继续生成成片入口"
);
assert.match(
  page,
  /!canContinueFromIssue && regenerationLayers\.length > 0/u,
  "已知故障不得再要求用户展开技术性的局部重做详情"
);
assert.match(page, /onClick=\{\(\) => void regenerate\(layer\)\}/u, "可信点击入口必须绑定当前重做层");
assert.match(page, /current\.creative\.designAutoMixVoicePersona\(payload\)/u, "页面必须接入显式声音生成 API");

const regeneratableStates = page.match(
  /const\s+RECOVERABLE_STATES\s*=\s*new Set<AutoMixState>\(\[([^)]*)\]\)/u
);
assert.ok(regeneratableStates, "页面必须显式定义局部重做允许的状态集合");
for (const state of ["completed", "needs_attention", "failed"]) {
  assert.match(regeneratableStates[1], new RegExp(`"${state}"`), `${state} 状态必须允许局部恢复`);
}
assert.doesNotMatch(regeneratableStates[1], /"outcome_unknown"/u, "outcome_unknown 不得允许局部重做");
assert.ok(
  (page.match(/RECOVERABLE_STATES\.has\(plan\.state\)/gu) || []).length >= 1,
  "局部重做函数必须使用恢复状态闸门"
);
assert.match(page, /const regenerationLayers = plan\?\.state === "completed"/u, "completed 必须显示局部重做入口");
assert.match(page, /const isLegacyMaterialAlignmentIssue = Boolean\([\s\S]+auto_mix_material_too_short[\s\S]+引用素材不足以覆盖对应口播的真实时间窗口/u, "只有旧版停顿分配误判可原地恢复");
assert.match(page, /recoveryLayer === "voice"[\s\S]+recoveryLayer === "music"[\s\S]+isLegacyMaterialAlignmentIssue/u, "声音、音乐和已知旧版停顿误判可原地继续生成");
assert.match(page, /const continuationLayer[^\n]*= isLegacyMaterialAlignmentIssue \? "voice" : recoveryLayer/u, "旧版停顿误判必须从声音对齐继续，不得重写文案");
assert.match(page, /isLegacyMaterialAlignmentIssue && layer === "voice"/u, "旧版停顿误判只允许保留原文案后继续声音层");
assert.match(page, /plan\.state === "outcome_unknown"[\s\S]+不能局部重做/u, "未知外部结果必须明确拒绝局部重做");
assert.match(page, /data-xiaoxi-auto-mix-reconcile-unknown-voice/u, "声音结果不明时必须提供查询已有结果的恢复入口");
const reconcileUnknownVoiceButton = page.match(
  /<button(?=[^>]*data-xiaoxi-auto-mix-reconcile-unknown-voice)[^>]*>/u
);
assert.ok(reconcileUnknownVoiceButton, "必须能定位声音结果查询按钮");
assert.match(
  reconcileUnknownVoiceButton[0],
  /data-xiaoxi-auto-mix-regenerate/u,
  "声音结果查询按钮必须生成局部恢复所需的可信点击凭证"
);
assert.match(page, /plan\.attention\?\.layer !== "voice"/u, "结果查询只能恢复声音层结果不明");
assert.match(page, /系统不会重复创建声音/u, "结果查询必须明确保留防重复创建边界");
assert.doesNotMatch(page, /准备其他声音|改用已准备的声音/u, "未知配音结果界面不得暴露额外声音管理步骤");

for (const stateCopy of [
  "正在读取素材与任务记录",
  "成片已生成",
  "需要处理后才能继续",
  "外部结果暂时无法确认",
  "本次生成未完成"
]) {
  assert.match(page, new RegExp(stateCopy), `缺少状态文案：${stateCopy}`);
}
assert.match(page, /不会自动重提/u, "outcome_unknown 必须明确不会自动重提");
assert.match(page, /role=\{notice\.tone === "error" \? "alert" : "status"\}/u, "动态状态必须可被读屏感知");
assert.match(page, /statusRef\.current\?\.focus\(\)/u, "需要处理和未知结果必须获得键盘焦点");
assert.match(styles, /input:focus-visible/u, "引导填写框必须有清晰键盘焦点");
assert.match(styles, /@media \(max-width: 760px\)/u, "页面必须保留窄屏布局");

assert.match(
  resources,
  /function inclusiveExpiryIso[\s\S]+new Date\(year, month - 1, day \+ 1\)[\s\S]+\.toISOString\(\)/u,
  "授权到期日必须按含当日语义转换为次日本地零点的 UTC ISO 时刻"
);
assert.match(resources, /const expiresAt = inclusiveExpiryIso\(form\.expiresAt\)/u);
assert.match(resources, /有效至所选日期当天结束/u, "页面必须说明到期日包含所选当天");
assert.doesNotMatch(resources, /expiresAt: form\.expiresAt \|\| null/u, "不得继续向后端传裸 YYYY-MM-DD");
assert.ok(
  (resources.match(/isMusicTrackSelectable\(track/gu) || []).length >= 2,
  "曲库计数和逐行状态必须共用同一个到期判定"
);
assert.match(
  resources,
  /function isLicenseExpired[\s\S]+Date\.parse\(expiresAt\)[\s\S]+expiresAtMs <= now/u,
  "列表到期判定必须与后端 expires_at <= now 的排除语义一致"
);
assert.match(resources, /provisioningStatus: AutoMixVoiceProvisioningStatus/u, "声音人格必须携带首次生成状态");
assert.match(resources, /previewStatus: AutoMixVoicePreviewStatus/u, "声音人格必须携带试听状态");
assert.match(resources, /data-xiaoxi-auto-mix-voice-design/u, "声音生成必须由独立可信点击发起");
assert.match(resources, /const canPreview = provisioning === "ready"/u, "未生成的声音不得进入试听");
assert.match(resources, /persona\.approvalStatus !== "pending" \|\| !hasPreviewed/u, "批准必须保留当次试听安全门");
assert.match(resources, /不会自动重试，也不能再次提交/u, "声音设计结果不明时必须禁止重提");
assert.doesNotMatch(resources, /providerVoiceId|voicePrompt/u, "页面不得接触供应商音色 ID 或声音设计提示词");

for (const evidence of [
  "素材时长适配",
  "口播字幕轨",
  "画面文字轨",
  "声音人格",
  "音乐授权",
  "质量警告"
]) {
  assert.match(page, new RegExp(evidence), `页面必须展示 ${evidence}`);
}
for (const privateField of ["absolutePath", "providerVoiceId", "credentialPath", "rawReportPath"]) {
  assert.doesNotMatch(page, new RegExp(privateField), `渲染层不得接触私有字段 ${privateField}`);
}

assert.match(page, /V1_TASK_TYPES/u, "旧 V1 项目必须保留只读恢复");
assert.match(page, /这是旧版项目的只读记录/u);
assert.match(studio, /auto_mix_v2_generation: "一键混剪 V2"/u, "创作中心必须识别 V2 新任务");
assert.match(studio, /auto_mix_v2_regeneration: "一键混剪 V2 局部重做"/u, "创作中心必须识别 V2 局部重做任务");
assert.match(studio, /"auto_mix_v2_generation",\s*"auto_mix_v2_regeneration"/su, "V2 任务必须恢复到一键混剪页面");
assert.match(studio, /guided_auto_mix_analysis: "一键成片素材解析"/u, "创作中心必须识别引导解析任务");
assert.match(studio, /guided_auto_mix_draft: "一键成片 AI 脚本"/u, "创作中心必须识别引导脚本任务");
assert.match(studio, /guided_auto_mix_supplemental_image: "一键成片 AI 补图"/u, "创作中心必须识别补图任务");
assert.match(page, /guided_auto_mix_supplemental_image/u, "补图任务必须能恢复到引导成片页面");

console.log("product one-click V2 self-check passed");
