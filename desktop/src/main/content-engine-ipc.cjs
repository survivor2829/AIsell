const fs = require("node:fs");
const path = require("node:path");
const {
  constants: cryptoConstants,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes
} = require("node:crypto");
const { diagnostics } = require("./diagnostics.cjs");
const { CHANNELS: BATCH_CHANNELS, ERRORS: BATCH_ERRORS, registerNarratedBatchIpc } = require("./narrated-batch-ipc.cjs");

const CONTENT_ENGINE_CHANNELS = Object.freeze({
  ...Object.fromEntries(Object.entries(BATCH_CHANNELS).map(([name, channel]) => [`batch_${name}`, channel])),
  status: "content-engine:status",
  restart: "content-engine:restart",
  listAssets: "content-engine:list-assets",
  chooseFiles: "content-engine:choose-files",
  chooseFolder: "content-engine:choose-folder",
  probeAsset: "content-engine:probe-asset",
  probePending: "content-engine:probe-pending",
  updateAssetRights: "content-engine:update-asset-rights",
  archiveAsset: "content-engine:archive-asset",
  revealAsset: "content-engine:reveal-asset",
  listTasks: "content-engine:list-tasks",
  pauseTask: "content-engine:pause-task",
  resumeTask: "content-engine:resume-task",
  cancelTask: "content-engine:cancel-task",
  listFinished: "content-engine:list-finished",
  chooseAndRegisterFinished: "content-engine:choose-and-register-finished",
  openFinished: "content-engine:open-finished",
  revealFinished: "content-engine:reveal-finished",
  downloadFinished: "content-engine:download-finished",
  settingsStatus: "content-engine:settings-status",
  chooseCacheDirectory: "content-engine:choose-cache-directory",
  updateCacheLimit: "content-engine:update-cache-limit",
  bailianKeyStatus: "content-engine:bailian-key-status",
  bailianKeyEncryption: "content-engine:bailian-key-encryption",
  saveBailianKey: "content-engine:save-bailian-key",
  deleteBailianKey: "content-engine:delete-bailian-key",
  analyzeAssets: "content-engine:analyze-assets",
  listMediaSegments: "content-engine:list-media-segments",
  generateCourseCuts: "content-engine:generate-course-cuts",
  generateMixBatch: "content-engine:generate-mix-batch",
  createOneClickProject: "content-engine:create-one-click-project",
  createAutoMixV2: "content-engine:create-auto-mix-v2",
  prepareGuidedAutoMixV2: "content-engine:prepare-guided-auto-mix-v2",
  getGuidedAutoMixSessionV2: "content-engine:get-guided-auto-mix-session-v2",
  generateGuidedAutoMixScriptV2: "content-engine:generate-guided-auto-mix-script-v2",
  getGuidedAutoMixSupplementalImageV2: "content-engine:get-guided-auto-mix-supplemental-image-v2",
  createGuidedAutoMixSupplementalImageV2: "content-engine:create-guided-auto-mix-supplemental-image-v2",
  getAutoMixPlanV2: "content-engine:get-auto-mix-plan-v2",
  regenerateAutoMixLayer: "content-engine:regenerate-auto-mix-layer",
  importMusicCatalogTrack: "content-engine:import-music-catalog-track",
  listMusicCatalogTracks: "content-engine:list-music-catalog-tracks",
  listAutoMixVoicePersonas: "content-engine:list-auto-mix-voice-personas",
  designAutoMixVoicePersona: "content-engine:design-auto-mix-voice-persona",
  previewAutoMixVoicePersona: "content-engine:preview-auto-mix-voice-persona",
  approveAutoMixVoicePersona: "content-engine:approve-auto-mix-voice-persona",
  analyzeProductAssets: "content-engine:analyze-product-assets",
  generateProductCopy: "content-engine:generate-product-copy",
  generateProductVoice: "content-engine:generate-product-voice",
  generateOneClickCandidates: "content-engine:generate-one-click-candidates",
  listOneClickCandidates: "content-engine:list-one-click-candidates",
  listPackagingPresets: "content-engine:list-packaging-presets",
  listBrandProfiles: "content-engine:list-brand-profiles",
  saveBrandProfile: "content-engine:save-brand-profile",
  getPackagingCostEstimate: "content-engine:get-packaging-cost-estimate",
  recordMediaReview: "content-engine:record-media-review",
  listMediaReviews: "content-engine:list-media-reviews",
  packageGeneratedVideos: "content-engine:package-generated-videos",
  repackageVideo: "content-engine:repackage-video",
  preflightVisualComparison: "content-engine:preflight-visual-comparison",
  createVisualComparisonTask: "content-engine:create-visual-comparison-task",
  regenerateCover: "content-engine:regenerate-cover",
  getCreativeProject: "content-engine:get-creative-project",
  listGeneratedVideos: "content-engine:list-generated-videos",
  regenerateVideo: "content-engine:regenerate-video",
  rejectGeneratedVideo: "content-engine:reject-generated-video",
  queueGeneratedVideos: "content-engine:queue-generated-videos",
  generatedMediaUrl: "content-engine:generated-media-url",
  openGeneratedVideo: "content-engine:open-generated-video",
  revealGeneratedVideo: "content-engine:reveal-generated-video",
  exportCandidate: "content-engine:export-candidate",
  downloadCandidate: "content-engine:download-candidate",
  createMixProject: "content-engine:create-mix-project",
  updateMixProject: "content-engine:update-mix-project",
  getMixProject: "content-engine:get-mix-project",
  listMixProjects: "content-engine:list-mix-projects",
  calculateMixCombinations: "content-engine:calculate-mix-combinations",
  generateMixCandidates: "content-engine:generate-mix-candidates",
  listMixCandidates: "content-engine:list-mix-candidates",
  reviewMixCandidate: "content-engine:review-mix-candidate",
  listPublishQueue: "content-engine:list-publish-queue",
  updatePublishQueueItem: "content-engine:update-publish-queue-item",
  renderMixCandidate: "content-engine:render-mix-candidate",
  listExportPackages: "content-engine:list-export-packages",
  openExportPackage: "content-engine:open-export-package",
  revealExportPackage: "content-engine:reveal-export-package",
  update: "content-engine:update"
});

const PUBLIC_STATES = new Set([
  "starting",
  "ready",
  "failed",
  "stopped",
  "unavailable"
]);
const TASK_STATES = new Set([
  "queued",
  "analyzing",
  "ready_for_review",
  "rendering",
  "completed",
  "failed",
  "cancelled",
  "paused"
]);
const TERMINAL_TASK_STATES = new Set(["failed", "completed", "cancelled"]);
const AUTO_MIX_VOICE_APPROVAL_STATUSES = new Set([
  "approved", "pending", "retired"
]);
const AUTO_MIX_VOICE_PROVISIONING_STATUSES = new Set([
  "not_created", "submitted", "ready", "failed", "outcome_unknown"
]);
const AUTO_MIX_VOICE_PREVIEW_STATUSES = new Set([
  "not_ready", "submitted", "completed", "failed", "outcome_unknown"
]);
const MAX_LIST_LIMIT = 500;
const MAX_DIAGNOSTIC_TASK_STATES = MAX_LIST_LIMIT * 2;
const MAX_MUSIC_AUDIO_BYTES = 512 * 1024 * 1024;
const MAX_MUSIC_EVIDENCE_BYTES = 32 * 1024 * 1024;

const RIGHTS_STATUSES = new Set([
  "unknown",
  "owned",
  "licensed",
  "restricted",
  "expired"
]);
const PROBE_PENDING_LIMIT = 10;
const PROBE_STATUSES = new Set(["pending", "ok", "unavailable", "failed"]);
const PROBE_ERROR_CODES = new Set([
  "asset_file_unavailable",
  "asset_file_changed",
  "ffprobe_unavailable",
  "ffprobe_timeout",
  "ffprobe_error",
  "ffprobe_execution_error",
  "ffprobe_invalid_output",
  "unsupported_media_kind",
  "video_stream_missing",
  "probe_failed"
]);
const REVIEW_STATUSES = new Set(["pending", "approved", "rejected"]);
const REVIEW_DECISIONS = new Set(["approved", "rejected"]);
const PUBLISH_STATUSES = new Set([
  "queued", "processing", "exported", "published", "failed", "cancelled"
]);
const EXPORT_PLATFORMS = new Set(["wechat", "douyin", "kuaishou"]);
const PACKAGING_KINDS = new Set(["course", "mix"]);
const PACKAGING_MODES = new Set(["auto", "preset", "none"]);
const PACKAGING_PRESETS = new Set([
  "knowledge_focus", "slide_teacher", "classroom_value",
  "hook_impact", "process_rhythm", "result_close"
]);
const COVER_MODES = new Set(["auto", "local_frame", "ai_generate", "none", "reuse"]);
const COVER_STATUSES = new Set([
  "planned", "submitted", "completed", "failed", "outcome_unknown", "cancelled", "reused"
]);
const COVER_PHASES = new Set([
  "planned", "submitting", "polling", "recovery_required", "completed", "failed",
  "outcome_unknown", "cancelled", "reused", "not_requested", "unknown"
]);
const FONT_PRESETS = new Set(["microsoft_yahei", "source_han_sans", "neutral_sans"]);
const VISUAL_ENGINES = new Set(["ffmpeg", "remotion"]);
const VISUAL_STYLE_IDS = new Set(["social_pop", "neo_editorial", "tech_motion"]);
const CAPTION_SOURCES = new Set(["tts_voiceover", "source_transcript", "none"]);
const GENERATED_VIDEO_STATES = new Set([
  "queued", "rendering", "completed", "failed", "rejected"
]);
const AUTO_MIX_V2_STATES = new Set([
  "analyzing", "planned", "synthesizing", "verifying_voice",
  "selecting_music", "rendering", "quality_check", "completed",
  "needs_attention", "failed", "outcome_unknown"
]);
const AUTO_MIX_V2_LAYERS = new Set(["text", "voice", "music"]);
const GUIDED_AUTO_MIX_SESSION_STATES = new Set([
  "analyzing", "ready_for_answers", "drafting", "ready_for_render", "failed", "outcome_unknown"
]);
const GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_STATES = new Set([
  "not_requested", "planned", "submitted", "completed", "failed", "outcome_unknown", "cancelled"
]);
const MUSIC_LICENSE_STATUSES = new Set(["valid", "expired", "restricted", "unknown"]);
const MUSIC_ANALYSIS_STATUSES = new Set(["pending", "ready", "failed"]);
const MUSIC_IMPORT_FIELDS = new Set([
  "displayName", "source", "commercialScope", "commercialUseAllowed", "licenseStatus",
  "expiresAt", "credentialReference", "bpm", "moods",
  "energy", "loopStartMs", "loopEndMs", "clickToken"
]);

const PUBLIC_ERRORS = Object.freeze({
  ...BATCH_ERRORS,
  CONTENT_ENGINE_RUNTIME_UNAVAILABLE: "内容引擎尚未安装或未配置。",
  CONTENT_ENGINE_DATA_DIR_INVALID: "内容引擎数据目录配置无效。",
  CONTENT_ENGINE_DATA_DIR_FAILED: "内容引擎数据目录无法创建。",
  CONTENT_ENGINE_SPAWN_FAILED: "内容引擎启动失败，请重试。",
  CONTENT_ENGINE_READY_INVALID: "内容引擎返回了无效的启动信息。",
  CONTENT_ENGINE_START_TIMEOUT: "内容引擎启动超时，请重试。",
  CONTENT_ENGINE_NOT_READY: "内容引擎尚未就绪，请稍后重试。",
  CONTENT_ENGINE_REQUEST_TIMEOUT: "本次素材处理超时，请稍后重试。",
  CONTENT_ENGINE_REQUEST_TOO_LARGE: "一次选择的素材过多，请分批导入。",
  CONTENT_ENGINE_PIPE_FAILED: "内容引擎连接中断，请重试。",
  CONTENT_ENGINE_RESPONSE_INVALID: "内容引擎返回了无效结果。",
  CONTENT_ENGINE_EXITED: "内容引擎已意外停止，请重试。",
  CONTENT_ENGINE_STOPPED: "内容引擎已经停止。",
  CONTENT_ENGINE_PATH_INVALID: "本地文件位置无效或已经失效。",
  CONTENT_ENGINE_OPEN_FAILED: "无法打开本地成片，请检查文件是否仍然存在。",
  CONTENT_ENGINE_DOWNLOAD_PATH_INVALID: "所选保存位置无效，请重新选择。",
  CONTENT_ENGINE_DOWNLOAD_SOURCE: "不能覆盖内容引擎中的原始成片，请选择其他位置。",
  CONTENT_ENGINE_DOWNLOAD_FAILED: "成片保存失败，请检查目标磁盘空间和文件夹权限。",
  CONTENT_ENGINE_CAPABILITY_UNAVAILABLE: "当前内容引擎版本不支持这项操作。",
  capability_unavailable: "媒体分析组件当前不可用，请安装或恢复组件后重试。",
  CONTENT_DIALOG_CANCELLED: "已取消选择。",
  trusted_user_click_required: "请在当前主窗口本人点击后再执行这项操作。",
  auto_mix_voice_preview_required: "请先在本次应用会话试听当前声音，再批准。",
  music_import_file_too_large: "音乐文件超过 512 MB，无法导入。",
  music_license_evidence_too_large: "授权证据超过 32 MB，无法导入。",
  music_commercial_entitlement_invalid: "请明确该音乐授权是否允许商用。",
  invalid_data_dir: "内容引擎数据目录无效。",
  already_running: "已有一个内容引擎正在使用这份数据，请关闭重复进程后重试。",
  request_too_large: "一次选择的素材过多，请分批导入。",
  asset_path_unavailable: "素材原文件已经移动或不可用。",
  finished_path_unavailable: "成片文件已经移动或不可用。",
  import_task_not_found: "没有找到这条素材导入任务。",
  import_task_not_resumable: "当前素材导入任务无法继续。",
  invalid_batch_size: "素材导入批次参数无效。",
  invalid_task_type: "任务类型无效。",
  invalid_payload: "任务内容无效。",
  invalid_progress: "任务进度参数无效。",
  invalid_result: "任务结果参数无效。",
  invalid_metadata: "成片附加信息无效。",
  invalid_setting_key: "设置项无效。",
  invalid_setting: "设置内容无效。",
  invalid_json: "请求内容不是有效数据。",
  invalid_error: "任务错误信息无效。",
  invalid_request: "请求参数无效。",
  invalid_params: "请求参数无效。",
  invalid_path: "所选文件或文件夹无效。",
  path_not_found: "所选文件或文件夹已经不存在。",
  unsafe_path: "不支持通过符号链接或目录联接导入素材。",
  unsupported_media: "所选文件类型暂不支持。",
  file_changed: "素材在索引期间发生变化，请重新导入。",
  asset_not_found: "没有找到这条素材记录。",
  task_not_found: "没有找到这条任务记录。",
  finished_video_not_found: "没有找到这条成片记录。",
  invalid_rights_status: "\u7d20\u6750\u7248\u6743\u72b6\u6001\u65e0\u6548\u3002",
  invalid_status: "任务状态无效。",
  invalid_transition: "当前任务状态不允许执行这项操作。",
  invalid_limit: "列表数量参数无效。",
  invalid_id: "记录标识无效。",
  invalid_name: "混剪项目或槽位名称无效。",
  invalid_slots: "混剪槽位配置无效。",
  invalid_constraints: "混剪约束配置无效。",
  invalid_duration: "混剪时长参数无效。",
  invalid_duration_range: "混剪时长范围无效。",
  invalid_subtitle_font_size: "字幕字号必须在 36～64 之间。",
  invalid_subtitle_margin_bottom: "字幕底部距离必须在 120～360 之间。",
  invalid_experiment_mode: "课程剪辑实验模式无效。",
  invalid_experiment_count: "百炼 × SupoClip 对照实验固定生成 5 条候选。",
  invalid_subtitle_preset: "动态字幕模板与当前剪辑模式不匹配。",
  invalid_generation_kind: "生成类型无效。",
  invalid_review_device: "验收设备无效。",
  invalid_review_verdict: "验收结论无效。",
  invalid_review_reason: "验收说明无效。",
  invalid_reviewer: "验收人信息无效。",
  paid_calls_confirmation_required: "请先确认云端调用预估后再继续。",
  invalid_score_weights: "混剪评分权重无效。",
  invalid_seed: "混剪随机种子无效。",
  invalid_review_status: "候选审核状态无效。",
  invalid_review_note: "候选审核备注无效。",
  invalid_publish_status: "发布队列状态无效。",
  invalid_publish_transition: "当前发布队列状态不允许执行这项操作。",
  invalid_error_message: "发布错误说明无效。",
  mix_project_not_found: "没有找到这条混剪项目记录。",
  mix_candidate_not_found: "没有找到这条混剪候选记录。",
  publish_queue_item_not_found: "没有找到这条发布队列记录。",
  export_package_not_found: "没有找到这条成片包记录。",
  candidate_not_approved: "只有已批准候选才能生成成片包。",
  invalid_platforms: "导出平台配置无效。",
  media_tools_unavailable: "FFmpeg/ffprobe 未配置，当前不能生成成片包。",
  render_timeout: "成片渲染超时，请检查素材后重试。",
  render_failed: "成片渲染失败，请检查素材后重试。",
  task_not_completed: "只有已完成的任务才能登记成片。",
  BAILIAN_API_KEY_MISSING: "请先保存百炼 API Key。",
  BAILIAN_API_KEY_INVALID: "百炼 API Key 格式无效。",
  BAILIAN_API_HOST_INVALID: "百炼 API Host 必须是官方 HTTPS 地址。",
  BAILIAN_API_KEY_UNREADABLE: "已保存的百炼 API Key 无法读取，请重新保存。",
  SECURE_STORAGE_UNAVAILABLE: "无法启用 Windows 账户加密存储。",
  BAILIAN_KEY_ENCRYPTION_INVALID: "百炼 Key 的安全传输会话无效，请重试。",
  creative_project_not_found: "没有找到这条创作项目。",
  auto_mix_run_not_found: "没有找到这次一键混剪记录。",
  auto_mix_run_stale: "任务已有新的处理结果，已切换到最新步骤，请按当前提示继续。",
  invalid_auto_mix_v2: "一键混剪 V2 请求无效。",
  invalid_auto_mix_v2_fields: "一键混剪 V2 请求包含不支持的字段。",
  auto_mix_v2_fields_missing: "请先完成素材解析和 AI 脚本生成。",
  unsupported_auto_mix_spec: "当前只支持一键混剪 V2 契约。",
  invalid_auto_mix_assets: "请提供 1 到 120 条素材。",
  invalid_auto_mix_asset_id: "素材标识无效。",
  auto_mix_title_missing: "请填写视频标题。",
  auto_mix_copy_framework_missing: "请填写文案框架。",
  guided_auto_mix_session_not_found: "没有找到这次素材解析，请重新解析后再继续。",
  guided_auto_mix_not_ready: "请先等待素材解析完成。",
  guided_auto_mix_assets_changed: "所选素材已变化，请重新解析后再生成脚本。",
  guided_auto_mix_analysis_missing: "素材解析结果不完整，请重新解析。",
  guided_auto_mix_outcome_unknown: "本次 AI 请求结果暂时无法确认，为避免重复调用，请重新解析素材后再继续。",
  guided_auto_mix_task_stale: "这次引导任务已不是当前版本，请重新解析素材后再继续。",
  guided_auto_mix_analysis_stale: "这次素材解析已被新的操作替代，请重新解析。",
  guided_auto_mix_draft_stale: "这次脚本生成已被新的操作替代，请重新生成脚本。",
  guided_auto_mix_script_not_ready: "请先完成 AI 脚本生成并确认当前版本。",
  guided_auto_mix_script_stale: "脚本已经更新，请使用最新脚本版本生成成片。",
  guided_auto_mix_script_invalid: "AI 脚本没有生成可用口播，请修改填写内容后重试。",
  guided_auto_mix_script_too_short: "AI 脚本过短，未达到本次素材的自动时长规划；请重新生成 AI 脚本。",
  guided_auto_mix_script_too_long: "脚本超过当前素材可承载的口播时长，请补充素材后重新生成。",
  guided_auto_mix_script_duration_invalid: "AI 脚本未落在本次素材的自动时长范围内，请重新生成 AI 脚本。",
  guided_auto_mix_duration_plan_missing: "当前脚本没有有效的自动时长规划，请重新生成 AI 脚本。",
  guided_auto_mix_product_missing: "请填写要介绍的产品或服务。",
  invalid_guided_auto_mix_answers: "请按引导检查填写的信息后再生成脚本。",
  invalid_guided_auto_mix_script_revision: "脚本版本无效，请重新生成后再试。",
  invalid_guided_auto_mix_draft_hash: "脚本已更新，请使用当前版本创建补图。",
  guided_auto_mix_supplemental_image_confirmation_required: "请确认将发起 1 次可能计费的 AI 图片生成。",
  guided_auto_mix_supplemental_image_not_found: "没有找到这张 AI 补图。",
  guided_auto_mix_supplemental_image_not_ready: "AI 补图尚未准备完成。",
  guided_auto_mix_supplemental_image_task_invalid: "AI 补图任务记录无效，请重新生成脚本后再试。",
  guided_auto_mix_supplemental_image_stale: "脚本或素材已更新，本次 AI 补图不会再提交。",
  guided_auto_mix_supplemental_image_outcome_unknown: "本次 AI 补图结果暂时无法确认，系统不会自动重复提交。",
  guided_auto_mix_supplemental_image_failed: "AI 补图没有生成成功，请重新生成脚本后再试。",
  guided_auto_mix_supplemental_image_cancelled: "这次 AI 补图已经取消，请重新生成脚本后再创建新的补图。",
  guided_auto_mix_supplemental_image_submit_failed: "AI 图片服务没有接受本次请求，请检查配置后再试。",
  guided_auto_mix_supplemental_image_provider_failed: "AI 图片服务未能生成补图，请重新生成脚本后再试。",
  guided_auto_mix_supplemental_image_poll_failed: "补图已提交，但暂时无法查询结果；继续任务只会查询原任务。",
  guided_auto_mix_supplemental_image_poll_interrupted: "补图查询已在本机停止；继续任务只会查询原任务。",
  guided_auto_mix_supplemental_image_download_failed: "补图已完成但本地下载或校验失败；继续任务只会查询原任务。",
  guided_auto_mix_supplemental_image_submission_inflight: "AI 补图正在提交中，系统不会重复提交。",
  guided_auto_mix_supplemental_image_invalid_output: "AI 补图文件未通过安全校验，请重新生成脚本后再试。",
  auto_mix_material_unavailable: "没有可用于一键成片的素材画面。",
  auto_mix_material_too_short: "可用素材不足以承载自然口播，请补充素材后再生成。",
  auto_mix_material_facts_insufficient: "素材缺少足够的真实画面信息，请补充可用素材后重新解析。",
  invalid_auto_mix_layer: "局部重做只支持文字、声音或音乐。",
  auto_mix_recovery_layer_mismatch: "请按当前质量提示恢复对应内容层。",
  auto_mix_state_invalid: "一键混剪状态无效。",
  auto_mix_voice_persona_required: "请先试听并批准一套自然人声音色。",
  auto_mix_voice_design_required: "请先生成这套自然人声音色。",
  auto_mix_voice_design_invalid: "声音设计模板无效，请更换后重试。",
  auto_mix_voice_design_unavailable: "当前声音模板无法自动生成，请检查配置。",
  auto_mix_voice_design_outcome_unknown: "声音是否生成成功暂时无法确认，请勿重复提交。",
  auto_mix_alternate_voice_required: "暂时没有查到唯一的配音结果，请稍后再试。",
  auto_mix_voice_reconciliation_unavailable: "暂时无法查询配音结果，请检查网络后稍后再试。",
  auto_mix_music_required: "请先导入带有效商用授权凭证的音乐。",
  auto_mix_remotion_required: "正式成片必须使用 Remotion 文字动画运行时。",
  auto_mix_quality_invalid: "成片音频质量报告无效。",
  invalid_music_track: "授权音乐导入请求无效。",
  invalid_music_track_fields: "授权音乐导入请求包含不支持的字段。",
  music_source_path_missing: "请选择真实音乐文件。",
  music_display_name_missing: "请填写曲目名称。",
  music_source_missing: "请填写曲目来源。",
  music_commercial_scope_missing: "请填写音乐的商用范围。",
  music_license_status_invalid: "音乐授权状态无效。",
  music_license_evidence_missing: "有效商用音乐必须提供凭证引用和证据文件。",
  music_license_expiry_invalid: "音乐授权到期时间无效。",
  music_bpm_invalid: "音乐 BPM 必须在 20 到 300 之间。",
  music_moods_invalid: "音乐情绪标签无效。",
  music_energy_invalid: "音乐能量值必须在 0 到 1 之间。",
  music_loop_invalid: "音乐循环点无效。",
  music_import_file_unavailable: "音乐文件或授权证据不可用。",
  music_import_format_unsupported: "请选择受支持的真实音频文件。",
  music_import_digest_mismatch: "音乐导入校验失败。",
  music_analysis_unavailable: "授权音乐分析运行时不可用。",
  music_analysis_failed: "授权音乐分析失败。",
  generated_video_not_found: "没有找到这条 AI 成片。",
  generated_video_not_ready: "只有已完成的 AI 成片才能执行这项操作。",
  generated_video_path_unavailable: "AI 成片文件尚未生成或已经不可用。",
  analysis_required: "请先完成素材分析。",
  media_metadata_unavailable: "素材正在读取时长和音轨，请等待读取完成后再生成。",
  transcript_required: "当前素材还没有可用转写，请配置百炼并重新分析。",
  course_editor_unavailable: "百炼内容主编暂时不可用，本次未生成 AI 推荐，请稍后重试。",
  course_editor_scores_incomplete: "百炼没有返回完整的四维评分，本次未用本地分数补足，请稍后重试。",
  insufficient_ai_candidates: "百炼本次没有返回 5 条完整有效候选，请稍后重试。",
  insufficient_material: "素材不足，无法生成符合质量门槛的成片。",
  source_ai_cover_not_verified: "来源成片的 AI 封面回执尚未核验。",
  source_remotion_acceptance_required: "请先完成 Remotion-only 首条成片验收。",
  phone_review_required: "请先在手机竖屏查看并记录通过结果。",
  phone_review_stale: "视频已经变化，需要重新做手机验收。",
  invalid_generated_video_ids: "请至少选择一条成片。",
  invalid_channel: "发布渠道无效。",
  invalid_role: "素材片段角色无效。",
  invalid_voice_asset: "老师原声素材必须包含在所选素材中。",
  invalid_packaging_kind: "包装模板类型无效。",
  invalid_packaging_mode: "包装模式无效。",
  invalid_visual_renderer: "高质动态渲染参数无效。",
  invalid_packaging_preset: "所选包装模板与当前成片类型不匹配。",
  packaging_preset_required: "请选择一套包装模板。",
  invalid_cover_mode: "封面模式无效。",
  invalid_brand_profile: "品牌包内容无效。",
  brand_profile_not_found: "没有找到这套品牌包。",
  invalid_brand_asset: "品牌素材无效，请从素材库重新选择。",
  invalid_brand_name: "品牌包名称无效。",
  invalid_brand_color: "品牌颜色必须使用六位十六进制色值。",
  invalid_font_preset: "品牌字体预设无效。",
  invalid_outro_text: "片尾签名过长。",
  invalid_reuse_cover: "封面复用参数无效。",
  cover_generation_unavailable: "APIMart AI 封面能力暂不可用，请稍后恢复任务。",
  cover_outcome_unknown: "封面提交结果未知，为避免重复扣费不会自动重提。",
  apimart_not_configured: "请先在 API 密钥中启用并保存 APIMart Key。",
  cover_submit_failed: "APIMart 拒绝了封面请求，本次不会自动重提。",
  cover_provider_failed: "APIMart 封面任务失败，本次不会自动重提。",
  cover_poll_failed: "APIMart 封面状态查询失败，请稍后恢复任务。",
  cover_download_failed: "封面已生成，但下载失败；恢复任务只会继续下载，不会重复提交。",
  cover_composition_failed: "AI 封面背景已生成，但本地标题合成失败。",
  cover_failed: "封面任务已经失败，系统不会自动重提。",
  cover_cancelled: "封面任务已取消。",
  cover_operation_not_found: "没有找到这条封面任务。",
  invalid_cover_operation_transition: "封面任务状态不允许执行此操作。",
  source_candidate_not_found: "没有找到对照来源成片。",
  source_candidate_not_completed: "请先等待来源成片完成。",
  source_video_missing: "来源成片文件不可用。",
  source_cover_missing: "来源成片缺少可复用的 AI 封面。",
  motion_plan_missing: "来源成片缺少可复用的编导计划。",
  motion_plan_invalid: "来源成片的编导计划无法用于对照。",
  remotion_capability_unavailable: "本机 Remotion 能力不可用，三风格对照已阻止。",
  comparison_runtime_hash_unavailable: "Remotion 运行时尚未通过完整性预检。",
  comparison_bundle_hash_unavailable: "Remotion 模板尚未通过完整性预检。",
  renderer_version_unavailable: "原对照渲染版本不可用，任务已暂停。",
  method_not_found: "当前内容引擎版本不支持这项操作。",
  internal_error: "内容引擎暂时无法完成操作，请重试。"
});
const DIAGNOSTIC_ERROR_CODES = new Set([
  ...Object.keys(PUBLIC_ERRORS),
  "unknown_error"
]);

function safeText(value, maxLength = 500) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maxLength)
    : "";
}

function stripPrivateValue(value, depth = 0) {
  if (depth > 5) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => stripPrivateValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value).slice(0, 200)) {
      const safeKey = safeText(key, 64);
      if (!safeKey || /(path|directory|folder)/i.test(safeKey)) continue;
      result[safeKey] = stripPrivateValue(child, depth + 1);
    }
    return result;
  }
  if (typeof value === "string") {
    return safeText(value, 2_000)
      .replace(/[a-z]:[\\/][^\r\n\t"'<>|]*/gi, "[已隐藏本地路径]")
      .replace(/\\\\[^\\/\s]+[\\/][^\r\n\t"'<>|]*/g, "[已隐藏本地路径]");
  }
  if (
    value === null
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  return null;
}

function safePublicText(value, maxLength) {
  const sanitized = stripPrivateValue(value);
  return typeof sanitized === "string"
    ? safeText(sanitized, maxLength)
    : "";
}

function publicStatus(value = {}) {
  const state = PUBLIC_STATES.has(value.state) ? value.state : "failed";
  const capabilities = {};
  if (value.capabilities && typeof value.capabilities === "object") {
    for (const [key, enabled] of Object.entries(value.capabilities)) {
      if (/^[a-z0-9_-]{1,64}$/i.test(key) && typeof enabled === "boolean") {
        capabilities[key] = enabled;
      }
    }
  }
  const code = Object.hasOwn(PUBLIC_ERRORS, value.code) ? value.code : "";
  return {
    state,
    available: value.available === true,
    version: safeText(value.version, 64),
    capabilities,
    code
  };
}

function publicAsset(item = {}) {
  return {
    assetId: safeText(item.asset_id, 80),
    displayName: safeText(item.display_name, 260),
    mediaKind: safeText(item.media_kind, 32),
    extension: safeText(item.extension, 16),
    sizeBytes: Number.isSafeInteger(item.size_bytes) && item.size_bytes >= 0
      ? item.size_bytes
      : 0,
    rightsStatus: RIGHTS_STATUSES.has(item.rights_status)
      ? item.rights_status
      : "unknown",
    probeStatus: PROBE_STATUSES.has(item.probe_status)
      ? item.probe_status
      : "pending",
    durationMs: Number.isSafeInteger(item.duration_ms) && item.duration_ms >= 0
      ? item.duration_ms
      : null,
    width: Number.isSafeInteger(item.width) && item.width > 0 ? item.width : null,
    height: Number.isSafeInteger(item.height) && item.height > 0 ? item.height : null,
    fps: Number.isFinite(item.fps) && item.fps >= 0 ? item.fps : null,
    hasAudio: typeof item.has_audio === "boolean" ? item.has_audio : null,
    probeErrorCode: PROBE_ERROR_CODES.has(item.probe_error_code)
      ? item.probe_error_code
      : null,
    probedAt: safeText(item.probed_at, 64) || null,
    archived: item.archived === true,
    createdAt: safeText(item.created_at, 64),
    updatedAt: safeText(item.updated_at, 64),
    locationCount: Number.isInteger(item.location_count)
      ? Math.max(0, item.location_count)
      : 0,
    availableLocationCount: Number.isInteger(item.available_location_count)
      ? Math.max(0, item.available_location_count)
      : 0
  };
}

function publicTask(item = {}) {
  const result = {
    taskId: safeText(item.task_id, 80),
    taskType: safePublicText(item.task_type, 64),
    projectId: opaqueId(item.project_id, "creative_project"),
    runId: publicAutoMixRunId(item.run_id),
    status: TASK_STATES.has(item.status) ? item.status : "failed",
    resumeFromStatus: TASK_STATES.has(item.resume_from_status)
      ? item.resume_from_status
      : null,
    progress: Number.isFinite(item.progress)
      ? Math.min(1, Math.max(0, item.progress))
      : 0,
    errorCode: safePublicText(item.error_code, 64) || null,
    errorMessage: safePublicText(item.error_message, 500) || null,
    createdAt: safeText(item.created_at, 64),
    updatedAt: safeText(item.updated_at, 64)
  };
  const analysisSummary = item.analysis_summary;
  if (analysisSummary && typeof analysisSummary === "object") {
    const skippedAssets = Array.isArray(analysisSummary.skipped_assets)
      ? analysisSummary.skipped_assets.slice(0, 100).map((entry) => ({
        assetId: opaqueId(entry?.asset_id, "asset") || "",
        errorCode: safePublicText(entry?.error_code, 64) || null,
        message: safePublicText(entry?.message, 500) || null
      })).filter((entry) => entry.assetId)
      : [];
    result.analysisSummary = {
      analyzedCount: Number.isInteger(analysisSummary.analyzed_count)
        ? Math.max(0, analysisSummary.analyzed_count)
        : 0,
      requestedCount: Number.isInteger(analysisSummary.requested_count)
        ? Math.max(0, analysisSummary.requested_count)
        : 0,
      provider: safePublicText(analysisSummary.provider, 64) || "local",
      cloudConfigured: analysisSummary.cloud_configured === true,
      skippedAssets
    };
  }
  const comparisonGroupId = opaqueId(item.comparison_group_id, "task");
  if (!comparisonGroupId) return result;
  const candidates = Array.isArray(item.candidates)
    ? item.candidates.slice(0, 3).map((candidate) => ({
      candidateId: opaqueId(candidate?.candidate_id, "generated_video") || "",
      status: GENERATED_VIDEO_STATES.has(candidate?.status) ? candidate.status : null,
      requestedEngine: publicVisualEngine(candidate?.requested_engine, "remotion"),
      requestedStyleId: publicVisualStyle(candidate?.requested_style_id),
      requestedStyleVersion: publicVersion(candidate?.requested_style_version),
      actualEngine: publicVisualEngine(candidate?.actual_engine),
      actualStyleVersion: publicVersion(candidate?.actual_style_version),
      fallbackCode: publicCode(candidate?.fallback_code)
    })).filter((candidate) => candidate.candidateId)
    : [];
  return {
    ...result,
    comparisonGroupId,
    comparisonSourceCandidateId: opaqueId(
      item.comparison_source_candidate_id,
      "generated_video"
    ),
    styleOrder: Array.isArray(item.style_order)
      ? item.style_order.slice(0, 3).map(publicVisualStyle).filter(Boolean)
      : [],
    renderCount: Number(item.render_count) === 3 ? 3 : 0,
    bailianCalls: Number(item.bailian_calls) === 0 ? 0 : null,
    apimartCalls: Number(item.apimart_calls) === 0 ? 0 : null,
    remotionPackagingCapable: item.remotion_packaging_capable === true,
    visualComparisonCapable: item.visual_comparison_capable === true,
    candidates
  };
}

function publicMediaReview(item = {}) {
  return {
    reviewId: safeText(item.review_id, 100),
    generatedVideoId: opaqueId(item.generated_video_id, "generated_video"),
    device: item.device === "phone" || item.device === "desktop" ? item.device : "phone",
    verdict: item.verdict === "pass" || item.verdict === "fail" ? item.verdict : "fail",
    reason: safePublicText(item.reason, 500),
    reviewer: safePublicText(item.reviewer, 120),
    mediaDigest: /^[a-f0-9]{64}$/i.test(String(item.media_digest || "")) ? item.media_digest : null,
    reviewedAt: safeText(item.reviewed_at, 64)
  };
}

function publicCode(value) {
  const code = safeText(value, 64);
  return /^[a-z0-9_-]{1,64}$/i.test(code) ? code : null;
}

function diagnosticCode(value, fallback = "unknown_error") {
  const code = safeText(value, 64);
  return DIAGNOSTIC_ERROR_CODES.has(code) ? code : fallback;
}

function opaqueId(value, prefix) {
  const id = safeText(value, 80);
  return new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(id) ? id : null;
}

function publicVersion(value) {
  if (value === undefined || value === null || value === "") return null;
  const version = Number(value);
  return Number.isSafeInteger(version) && version >= 0 && version <= 1_000_000
    ? version
    : null;
}

function publicVisualEngine(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const engine = String(value || "");
  return VISUAL_ENGINES.has(engine) ? engine : null;
}

function publicVisualStyle(value) {
  const styleId = String(value || "");
  return VISUAL_STYLE_IDS.has(styleId) ? styleId : null;
}

function publicCaptionSource(value) {
  const source = String(value || "");
  return CAPTION_SOURCES.has(source) ? source : "none";
}

function publicCoverStatus(value) {
  const status = String(value || "");
  return COVER_STATUSES.has(status) ? status : null;
}

function publicCoverPhase(value) {
  const phase = String(value || "");
  return COVER_PHASES.has(phase) ? phase : null;
}

function publicFinished(item = {}) {
  return {
    finishedVideoId: safeText(item.finished_video_id, 80),
    taskId: safeText(item.task_id, 80) || null,
    displayName: safeText(item.display_name, 260),
    title: safePublicText(item.title, 200),
    sizeBytes: Number.isSafeInteger(item.size_bytes) && item.size_bytes >= 0
      ? item.size_bytes
      : 0,
    metadata: stripPrivateValue(item.metadata || {}),
    available: item.available !== false,
    createdAt: safeText(item.created_at, 64)
  };
}

function publicError(error) {
  const suppliedCode = safeText(error?.code, 64);
  if (Object.hasOwn(PUBLIC_ERRORS, suppliedCode)) {
    return {
      ok: false,
      code: suppliedCode,
      error: PUBLIC_ERRORS[suppliedCode]
    };
  }
  return {
    ok: false,
    code: "CONTENT_ENGINE_FAILED",
    error: "内容引擎暂时不可用，请重试。"
  };
}

function validatePayload(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("invalid payload"), { code: "invalid_params" });
  }
  return value;
}

function validateId(value, prefix) {
  const id = String(value || "");
  if (!new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(id)) {
    throw Object.assign(new Error("invalid id"), { code: "invalid_id" });
  }
  return id;
}

function validateLimit(value, defaultValue = 200) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw Object.assign(new Error("invalid limit"), { code: "invalid_limit" });
  }
  return limit;
}

function validateProbeLimit(value) {
  if (value === undefined || value === null || value === "") {
    return PROBE_PENDING_LIMIT;
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > PROBE_PENDING_LIMIT) {
    throw Object.assign(new Error("invalid probe limit"), {
      code: "invalid_limit"
    });
  }
  return limit;
}

function validateTitle(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 200) {
    throw Object.assign(new Error("invalid title"), { code: "invalid_params" });
  }
  return safeText(value, 200).trim() || undefined;
}

function invalid(code = "invalid_params") {
  throw Object.assign(new Error(code), { code });
}

function assertKeys(value, allowed, code = "invalid_params") {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(code);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid(code);
  return value;
}

function validateText(value, maxLength, code = "invalid_params", optional = false) {
  if (optional && (value === undefined || value === null || value === "")) return undefined;
  if (typeof value !== "string") invalid(code);
  const result = safeText(value, maxLength).trim();
  if (!result || value.length > maxLength) invalid(code);
  return result;
}

function validateGuidedAutoMixAnswers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("invalid_guided_auto_mix_answers");
  }
  const limits = {
    companyName: 80,
    productName: 100,
    targetScene: 180,
    keyMessage: 300,
    extraNotes: 240
  };
  assertKeys(value, new Set(Object.keys(limits)), "invalid_guided_auto_mix_answers");
  const answers = {};
  for (const [key, limit] of Object.entries(limits)) {
    const raw = value[key] == null ? "" : value[key];
    if (typeof raw !== "string" || raw.length > limit) {
      invalid("invalid_guided_auto_mix_answers");
    }
    answers[key] = raw.trim();
  }
  if (!answers.productName) invalid("guided_auto_mix_product_missing");
  return answers;
}

function validateVoicePersonaId(value) {
  const id = String(value || "");
  if (!/^[a-z][a-z0-9-]{1,63}@[1-9][0-9]{0,5}$/iu.test(id)) {
    throw Object.assign(new Error("invalid voice persona id"), {
      code: "invalid_voice_persona_id"
    });
  }
  return id;
}

function validateMusicImportFile(value, {
  required = false,
  audio = false,
  maxBytes = MAX_MUSIC_EVIDENCE_BYTES
} = {}) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate) {
    if (required) invalid("music_source_path_missing");
    return "";
  }
  if (candidate.length > 32_000 || !path.isAbsolute(candidate)) {
    invalid("music_import_file_unavailable");
  }
  let resolved;
  let stat;
  try {
    resolved = fs.realpathSync(candidate);
    stat = fs.statSync(resolved);
  } catch {
    invalid("music_import_file_unavailable");
  }
  if (!stat.isFile() || stat.size <= 0) invalid("music_import_file_unavailable");
  if (stat.size > maxBytes) {
    invalid(audio ? "music_import_file_too_large" : "music_license_evidence_too_large");
  }
  if (audio && !new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"])
    .has(path.extname(resolved).toLowerCase())) {
    invalid("music_import_format_unsupported");
  }
  return resolved;
}

function validateDuration(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) invalid("invalid_duration");
  return value;
}

function validateSlots(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    invalid("invalid_slots");
  }
  return value.map((rawSlot) => {
    const slot = assertKeys(rawSlot, new Set([
      "name", "required", "assetIds", "fixedAssetId",
      "minDurationMs", "maxDurationMs", "targetDurationMs"
    ]), "invalid_slots");
    if (slot.required !== undefined && typeof slot.required !== "boolean") {
      invalid("invalid_slots");
    }
    if (slot.assetIds !== undefined && !Array.isArray(slot.assetIds)) {
      invalid("invalid_slots");
    }
    const assetIds = (slot.assetIds || []).map((assetId) => validateId(assetId, "asset"));
    if (assetIds.length > 500 || new Set(assetIds).size !== assetIds.length) {
      invalid("invalid_slots");
    }
    const fixedAssetId = slot.fixedAssetId === undefined || slot.fixedAssetId === null
      ? undefined
      : validateId(slot.fixedAssetId, "asset");
    const required = slot.required !== false;
    if (required && !fixedAssetId && assetIds.length === 0) invalid("invalid_slots");
    const minDurationMs = validateDuration(slot.minDurationMs);
    const maxDurationMs = validateDuration(slot.maxDurationMs);
    const targetDurationMs = validateDuration(slot.targetDurationMs);
    if (minDurationMs !== undefined && maxDurationMs !== undefined && minDurationMs > maxDurationMs) {
      invalid("invalid_duration_range");
    }
    return {
      name: validateText(slot.name, 200, "invalid_slots"),
      required,
      asset_ids: assetIds,
      fixed_asset_id: fixedAssetId,
      min_duration_ms: minDurationMs,
      max_duration_ms: maxDurationMs,
      ...(targetDurationMs === undefined ? {} : { target_duration_ms: targetDurationMs })
    };
  });
}

function validateConstraints(value) {
  const constraints = assertKeys(value ?? {}, new Set([
    "allowRepeatedAssets", "minDurationMs", "maxDurationMs", "scoreWeights"
  ]), "invalid_constraints");
  if (constraints.allowRepeatedAssets !== undefined && typeof constraints.allowRepeatedAssets !== "boolean") {
    invalid("invalid_constraints");
  }
  const minDurationMs = validateDuration(constraints.minDurationMs);
  const maxDurationMs = validateDuration(constraints.maxDurationMs);
  if (minDurationMs !== undefined && maxDurationMs !== undefined && minDurationMs > maxDurationMs) {
    invalid("invalid_duration_range");
  }
  let scoreWeights;
  if (constraints.scoreWeights !== undefined) {
    const weights = assertKeys(constraints.scoreWeights, new Set([
      "durationFit", "diversity", "freshness"
    ]), "invalid_score_weights");
    if (Object.keys(weights).length !== 3) invalid("invalid_score_weights");
    for (const valueForWeight of Object.values(weights)) {
      if (!Number.isFinite(valueForWeight) || valueForWeight < 0) invalid("invalid_score_weights");
    }
    if (weights.durationFit + weights.diversity + weights.freshness <= 0) {
      invalid("invalid_score_weights");
    }
    scoreWeights = {
      duration_fit: weights.durationFit,
      diversity: weights.diversity,
      freshness: weights.freshness
    };
  }
  return {
    allow_repeated_assets: constraints.allowRepeatedAssets ?? false,
    min_duration_ms: minDurationMs,
    max_duration_ms: maxDurationMs,
    score_weights: scoreWeights
  };
}

function validateSeed(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) invalid("invalid_seed");
    return value;
  }
  if (typeof value !== "string" || value.length > 200) invalid("invalid_seed");
  return safeText(value, 200);
}

function camelizePublic(value, depth = 0) {
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => camelizePublic(item, depth + 1));
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value).slice(0, 500)) {
      if (/(path|directory|folder)/i.test(key)) continue;
      const publicKey = key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
      result[publicKey] = camelizePublic(child, depth + 1);
    }
    return result;
  }
  return stripPrivateValue(value, depth);
}

function publicMixProject(value = {}) {
  return camelizePublic({
    project_id: value.project_id,
    name: value.name,
    constraints: value.constraints,
    slots: value.slots,
    created_at: value.created_at,
    updated_at: value.updated_at
  });
}

function publicMixCandidate(value = {}) {
  return camelizePublic({
    candidate_id: value.candidate_id,
    project_id: value.project_id,
    seed: value.seed,
    selection_signature: value.selection_signature,
    selections: value.selections,
    duration_ms: value.duration_ms,
    score: value.score,
    review_status: value.review_status,
    review_note: value.review_note,
    created_at: value.created_at,
    updated_at: value.updated_at
  });
}

function publicQueueItem(value = {}) {
  return camelizePublic({
    queue_item_id: value.queue_item_id,
    candidate_id: value.candidate_id,
    project_id: value.project_id,
    status: value.status,
    error_message: value.error_message,
    created_at: value.created_at,
    updated_at: value.updated_at
  });
}

function publicExportPackage(value = {}) {
  return camelizePublic({
    package_id: value.package_id,
    candidate_id: value.candidate_id,
    queue_item_id: value.queue_item_id,
    platforms: value.platforms,
    outputs: value.outputs,
    cover_name: value.cover_name,
    manifest_name: value.manifest_name,
    title: value.title,
    description: value.description,
    created_at: value.created_at
  });
}

function validateOptionalId(value, prefix) {
  return value === undefined || value === null || value === ""
    ? undefined
    : validateId(value, prefix);
}

function validateGeneratedVideoIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 300) {
    invalid("invalid_generated_video_ids");
  }
  return [...new Set(value.map((item) => validateId(item, "generated_video")))];
}

function validatePackagingOptions(payload, { reuseCoverDefault = false } = {}) {
  const packagingMode = String(payload.packagingMode ?? "auto");
  if (!PACKAGING_MODES.has(packagingMode)) invalid("invalid_packaging_mode");
  const packagingPresetId = payload.packagingPresetId == null
    ? undefined
    : String(payload.packagingPresetId);
  if (packagingPresetId && !PACKAGING_PRESETS.has(packagingPresetId)) {
    invalid("invalid_packaging_preset");
  }
  if (packagingMode === "preset" && !packagingPresetId) {
    invalid("packaging_preset_required");
  }
  if (packagingMode !== "preset" && packagingPresetId) {
    invalid("invalid_packaging_preset");
  }
  const coverMode = String(payload.coverMode ?? "ai_generate");
  if (!COVER_MODES.has(coverMode)) invalid("invalid_cover_mode");
  if (packagingMode === "none" && coverMode !== "none") {
    invalid("invalid_cover_mode");
  }
  const reuseCover = payload.reuseCover ?? reuseCoverDefault;
  if (typeof reuseCover !== "boolean") invalid("invalid_reuse_cover");
  let visualRenderer;
  if (payload.visualRenderer !== undefined && payload.visualRenderer !== null) {
    const visual = assertKeys(
      payload.visualRenderer,
      new Set([
        "requestedEngine", "visualStyleId", "requestedStyleVersion",
        "allowFallback"
      ]),
      "invalid_visual_renderer"
    );
    if (packagingMode === "none"
      || visual.requestedEngine !== "remotion"
      || visual.requestedStyleVersion !== 1
      || typeof visual.allowFallback !== "boolean"
      || (visual.visualStyleId !== undefined
        && !VISUAL_STYLE_IDS.has(String(visual.visualStyleId)))) {
      invalid("invalid_visual_renderer");
    }
    visualRenderer = {
      requestedEngine: "remotion",
      ...(visual.visualStyleId === undefined
        ? {}
        : { visualStyleId: String(visual.visualStyleId) }),
      requestedStyleVersion: 1,
      allowFallback: visual.allowFallback === true
    };
  }
  return {
    packagingMode,
    packagingPresetId,
    brandProfileId: validateOptionalId(payload.brandProfileId, "brand_profile"),
    coverMode,
    reuseCover,
    ...(visualRenderer ? { visualRenderer } : {})
  };
}

function publicMediaSegment(value = {}) {
  return camelizePublic({
    segment_id: value.segment_id,
    asset_id: value.asset_id,
    start_ms: value.start_ms,
    end_ms: value.end_ms,
    transcript: value.transcript,
    speaker: value.speaker,
    role: value.role,
    shot_type: value.shot_type,
    tags: value.tags,
    quality_score: value.quality_score,
    provider: value.provider,
    thumbnail_ready: value.thumbnail_ready
  });
}

function publicCoverageNumber(value, { ratio = false } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  if (ratio) return Math.min(1, numeric);
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(numeric));
}

function publicVoiceMetadata(value = {}) {
  if (!value || typeof value !== "object") return null;
  return camelizePublic({
    provider: ["bailian", "source", "none"].includes(value.provider) ? value.provider : null,
    status: ["pending", "completed", "failed", "not_requested"].includes(value.status)
      ? value.status
      : null,
    reason: publicCode(value.reason),
    error_code: publicCode(value.error_code),
    recognized_speech_ms: publicCoverageNumber(value.recognized_speech_ms),
    source_media_ms: publicCoverageNumber(value.source_media_ms),
    source_coverage: publicCoverageNumber(value.source_coverage, { ratio: true })
  });
}

function publicAudioStrategy(value = {}) {
  if (!value || typeof value !== "object") return null;
  return camelizePublic({
    recognized_speech_ms: publicCoverageNumber(value.recognized_speech_ms),
    source_media_ms: publicCoverageNumber(value.source_media_ms),
    source_coverage: publicCoverageNumber(value.source_coverage, { ratio: true }),
    source_coverage_threshold: publicCoverageNumber(value.source_coverage_threshold, { ratio: true }),
    recognized_asset_count: publicCoverageNumber(value.recognized_asset_count),
    unknown_audio_count: publicCoverageNumber(value.unknown_audio_count),
    reason: publicCode(value.reason),
    source_audio_policy: ["preserve", "duck", "none"].includes(value.source_audio_policy)
      ? value.source_audio_policy
      : null
  });
}

function publicAnalysisContext(value = {}) {
  if (!value || typeof value !== "object") return null;
  return camelizePublic({
    stage: publicCode(value.stage),
    asset_id: opaqueId(value.asset_id, "asset"),
    asset_name: safePublicText(value.asset_name, 240),
    index: publicCoverageNumber(value.index),
    total: publicCoverageNumber(value.total),
    analyzed_count: publicCoverageNumber(value.analyzed_count),
    skipped_count: publicCoverageNumber(value.skipped_count),
    asset_total: publicCoverageNumber(value.asset_total)
  });
}

function publicSkippedAnalysisAssets(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).map((item) => camelizePublic({
    asset_id: opaqueId(item?.asset_id, "asset"),
    asset_name: safePublicText(item?.asset_name, 240),
    stage: publicCode(item?.stage),
    error_code: publicCode(item?.error_code),
    error_message: safePublicText(item?.error_message ?? item?.message, 500)
  }));
}

function publicCreativeProject(value = {}) {
  return camelizePublic({
    project_id: value.project_id,
    mode: value.mode,
    name: value.name,
    theme: value.theme,
    status: value.status,
    required_roles: value.required_roles,
    target_count: value.target_count,
    packaging_mode: value.packaging_mode,
    packaging_preset_id: value.packaging_preset_id,
    brand_profile_id: value.brand_profile_id,
    cover_mode: value.cover_mode,
    workflow: value.workflow,
    ratio: value.ratio,
    duration_ms: value.duration_ms,
    bgm_asset_id: value.bgm_asset_id,
    product_asset_count: value.product_asset_count,
    product_assets: Array.isArray(value.product_assets) ? value.product_assets : [],
    product_brief: value.product_brief && typeof value.product_brief === "object"
      ? value.product_brief
      : null,
    copy_status: value.copy_status,
    voice_status: value.voice_status,
    copy_mode: value.copy_mode,
    voice_mode: value.voice_mode,
    voice_metadata: publicVoiceMetadata(value.voice_metadata),
    audio_strategy: publicAudioStrategy(value.audio_strategy),
    copy_error_code: value.copy_error_code,
    analysis_context: publicAnalysisContext(value.analysis_context),
    analysis_skipped_assets: publicSkippedAnalysisAssets(value.analysis_skipped_assets),
    product_family: value.product_family,
    generated_count: value.generated_count,
    maximum_qualified_count: value.maximum_qualified_count,
    count_is_exact: value.count_is_exact,
    missing_roles: value.missing_roles,
    skeleton_ids: Array.isArray(value.skeleton_ids)
      ? value.skeleton_ids.filter((item) => /^[a-z0-9_-]{1,64}$/i.test(String(item || ""))).slice(0, 300)
      : [],
    skeleton_count: Number.isSafeInteger(value.skeleton_count) ? value.skeleton_count : 0,
    created_at: value.created_at,
    updated_at: value.updated_at
  });
}

function publicGeneratedVideo(value = {}) {
  return camelizePublic({
    generated_video_id: value.generated_video_id,
    project_id: value.project_id,
    task_id: value.task_id,
    kind: value.kind,
    skeleton_id: /^[a-z0-9_-]{1,64}$/i.test(String(value.skeleton_id || "")) ? value.skeleton_id : null,
    status: value.status,
    generation: value.generation,
    selection_signature: value.selection_signature,
    title: value.title,
    duration_ms: value.duration_ms,
    recommended: value.recommended,
    score: value.score,
    source_asset_id: value.source_asset_id,
    source_start_ms: value.source_start_ms,
    source_end_ms: value.source_end_ms,
    source_asset_count: Number.isSafeInteger(value.source_asset_count)
      && value.source_asset_count >= 0
      ? value.source_asset_count
      : 0,
    shot_count: Number.isSafeInteger(value.shot_count) && value.shot_count >= 0
      ? value.shot_count
      : 0,
    caption_source: publicCaptionSource(value.caption_source),
    preview_ready: value.preview_ready,
    thumbnail_ready: value.thumbnail_ready,
    packaging_preset_id: value.packaging_preset_id,
    packaging_preset_name: value.packaging_preset_name,
    packaging_version: value.packaging_version,
    brand_profile_id: value.brand_profile_id,
    cover_status: publicCoverStatus(value.cover_status),
    cover_phase: publicCoverPhase(value.cover_phase),
    cover_network_submitted: value.cover_network_submitted === true,
    cover_issue_code: publicCode(value.cover_issue_code),
    phone_review: value.phone_review ? publicMediaReview(value.phone_review) : null,
    motion_director_provider: value.motion_director_provider,
    motion_event_count: value.motion_event_count,
    requested_engine: publicVisualEngine(value.requested_engine, "ffmpeg"),
    requested_style_id: publicVisualStyle(value.requested_style_id),
    requested_style_version: publicVersion(value.requested_style_version),
    actual_engine: publicVisualEngine(value.actual_engine),
    actual_style_version: publicVersion(value.actual_style_version),
    fallback_code: publicCode(value.fallback_code),
    comparison_group_id: opaqueId(value.comparison_group_id, "task"),
    comparison_source_candidate_id: opaqueId(
      value.comparison_source_candidate_id,
      "generated_video"
    ),
    remotion_packaging_capable: value.remotion_packaging_capable === true,
    visual_comparison_capable: value.visual_comparison_capable === true,
    visual_renderer_legacy: value.visual_renderer_legacy === true,
    error_code: value.error_code,
    error_message: value.error_message,
    created_at: value.created_at,
    updated_at: value.updated_at
  });
}

function autoMixField(value, camelKey, snakeKey) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, camelKey)) return value[camelKey];
  return value[snakeKey || camelKey.replace(/([A-Z])/g, "_$1").toLowerCase()];
}

function publicAutoMixInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0
    ? Math.min(number, maximum)
    : null;
}

function publicAutoMixNumber(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum
    ? number
    : null;
}

function publicAutoMixToken(value, maxLength = 128) {
  const token = safeText(value, maxLength);
  return /^[a-z0-9_.@-]{1,128}$/iu.test(token) ? token : null;
}

function safeAutoMixText(value, maxLength) {
  return safePublicText(value, maxLength)
    .replace(/\b(?:sk|ak)(?:-[a-z0-9._-]{8,})\b/giu, "[已隐藏密钥]")
    .replace(/\b(?:api[_-]?key|token)\s*[:=]\s*[^\s,;]{6,}/giu, "[已隐藏密钥]");
}

function publicVoicePersonaId(value) {
  const personaId = publicAutoMixToken(value, 128);
  return personaId && /^[a-z][a-z0-9-]{1,63}@[1-9][0-9]{0,5}$/iu.test(personaId)
    ? personaId
    : null;
}

function publicAutoMixRunId(value) {
  return opaqueId(value, "auto_mix_run") || opaqueId(value, "run");
}

function publicAutoMixSegment(value = {}) {
  return {
    segmentId: publicAutoMixToken(autoMixField(value, "segmentId"), 80),
    assetId: opaqueId(autoMixField(value, "assetId"), "asset"),
    mediaKind: ["video", "image"].includes(String(autoMixField(value, "mediaKind") || ""))
      ? String(autoMixField(value, "mediaKind"))
      : null,
    sourceStartMs: publicAutoMixInteger(autoMixField(value, "sourceStartMs")),
    sourceEndMs: publicAutoMixInteger(autoMixField(value, "sourceEndMs")),
    timelineStartMs: publicAutoMixInteger(autoMixField(value, "timelineStartMs"), 120_000),
    timelineEndMs: publicAutoMixInteger(autoMixField(value, "timelineEndMs"), 120_000),
    targetDurationMs: publicAutoMixInteger(autoMixField(value, "targetDurationMs"), 120_000),
    role: publicAutoMixToken(autoMixField(value, "role"), 32),
    sourceTag: safeAutoMixText(autoMixField(value, "sourceTag"), 80) || null,
    qualityScore: publicAutoMixNumber(autoMixField(value, "qualityScore"), 0, 1)
  };
}

function publicAutoMixPhrase(value = {}) {
  const evidenceRefs = autoMixField(value, "evidenceRefs");
  return {
    phraseId: publicAutoMixToken(autoMixField(value, "phraseId"), 80),
    text: safeAutoMixText(autoMixField(value, "text"), 80),
    evidenceRefs: Array.isArray(evidenceRefs)
      ? evidenceRefs.slice(0, 8).map((item) => safeAutoMixText(item, 128)).filter(Boolean)
      : []
  };
}

function publicAutoMixCaption(value = {}) {
  const timing = String(autoMixField(value, "timing") || "");
  return {
    captionId: publicAutoMixToken(autoMixField(value, "captionId"), 80),
    startMs: publicAutoMixInteger(autoMixField(value, "startMs"), 120_000),
    endMs: publicAutoMixInteger(autoMixField(value, "endMs"), 120_000),
    text: safeAutoMixText(autoMixField(value, "text"), 80),
    captionSource: autoMixField(value, "captionSource") === "tts_voiceover"
      ? "tts_voiceover"
      : null,
    timing: ["audio_measured", "asr_aligned", "forced_aligned"].includes(timing)
      ? timing
      : null
  };
}

function publicAutoMixVisualText(value = {}) {
  const type = String(autoMixField(value, "type") || "");
  return {
    textItemId: publicAutoMixToken(autoMixField(value, "textItemId"), 80),
    type: ["hook", "callout", "cta"].includes(type) ? type : null,
    text: safeAutoMixText(autoMixField(value, "text"), 80),
    startMs: publicAutoMixInteger(autoMixField(value, "startMs"), 120_000),
    endMs: publicAutoMixInteger(autoMixField(value, "endMs"), 120_000)
  };
}

function publicAutoMixVoicePersona(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = String(autoMixField(value, "approvalStatus") || autoMixField(value, "status") || "");
  const provisioningStatus = String(autoMixField(value, "provisioningStatus") || "");
  const previewStatus = String(autoMixField(value, "previewStatus") || "");
  return {
    voicePersonaId: publicVoicePersonaId(
      autoMixField(value, "voicePersonaId") || autoMixField(value, "personaId")
    ),
    displayName: safeAutoMixText(autoMixField(value, "displayName"), 160),
    catalogVersion: publicAutoMixToken(autoMixField(value, "catalogVersion"), 64),
    category: publicAutoMixToken(autoMixField(value, "category"), 64),
    approvalStatus: AUTO_MIX_VOICE_APPROVAL_STATUSES.has(status) ? status : null,
    provisioningStatus: AUTO_MIX_VOICE_PROVISIONING_STATUSES.has(provisioningStatus)
      ? provisioningStatus
      : "not_created",
    previewStatus: AUTO_MIX_VOICE_PREVIEW_STATUSES.has(previewStatus)
      ? previewStatus
      : "not_ready"
  };
}

function publicAutoMixVoicePreview(value) {
  const persona = publicAutoMixVoicePersona(autoMixField(value, "voicePersona"));
  const audioDataUrl = publicAutoMixWavDataUrl(autoMixField(value, "audioDataUrl"));
  return {
    voicePersona: persona,
    previewStatus: persona?.previewStatus || "not_ready",
    audioDataUrl,
    cacheHit: autoMixField(value, "cacheHit") === true
  };
}

function publicAutoMixWavDataUrl(value) {
  const dataUrl = String(value || "");
  const prefix = "data:audio/wav;base64,";
  if (
    dataUrl.length > 16 * 1024 * 1024
    || !/^data:audio\/wav;base64,[A-Za-z0-9+/=]+$/u.test(dataUrl)
  ) return null;
  try {
    const audio = Buffer.from(dataUrl.slice(prefix.length), "base64");
    if (
      audio.length < 44
      || audio.toString("ascii", 0, 4) !== "RIFF"
      || audio.toString("ascii", 8, 12) !== "WAVE"
    ) return null;
  } catch {
    return null;
  }
  return dataUrl;
}

function publicAutoMixLicense(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = String(autoMixField(value, "status") || "");
  return {
    status: MUSIC_LICENSE_STATUSES.has(status) ? status : "unknown",
    commercialScope: safeAutoMixText(autoMixField(value, "commercialScope"), 160),
    commercialUseAllowed: autoMixField(value, "commercialUseAllowed") === true,
    expiresAt: safeText(autoMixField(value, "expiresAt"), 64) || null,
    evidencePresent: autoMixField(value, "evidencePresent") === true
  };
}

function publicAutoMixMusic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const moods = autoMixField(value, "moods");
  return {
    trackId: publicAutoMixToken(autoMixField(value, "trackId"), 128),
    displayName: safeAutoMixText(autoMixField(value, "displayName"), 160),
    source: safeAutoMixText(autoMixField(value, "source"), 160),
    licenseSummary: publicAutoMixLicense(autoMixField(value, "licenseSummary")),
    bpm: publicAutoMixInteger(autoMixField(value, "bpm"), 400),
    moods: Array.isArray(moods)
      ? moods.slice(0, 12).map((item) => publicAutoMixToken(item, 40)).filter(Boolean)
      : [],
    energy: publicAutoMixNumber(autoMixField(value, "energy"), 0, 1),
    selectionScore: publicAutoMixNumber(autoMixField(value, "selectionScore"), 0, 1_000)
  };
}

function publicMusicCatalogTrack(value = {}) {
  const moods = autoMixField(value, "moods");
  const loop = autoMixField(value, "loop");
  const analysisStatus = String(autoMixField(value, "analysisStatus") || "");
  return {
    trackId: opaqueId(autoMixField(value, "trackId"), "music_track"),
    displayName: safeAutoMixText(autoMixField(value, "displayName"), 160),
    source: safeAutoMixText(autoMixField(value, "source"), 160),
    licenseSummary: publicAutoMixLicense(autoMixField(value, "licenseSummary")),
    durationMs: publicAutoMixInteger(autoMixField(value, "durationMs")),
    bpm: publicAutoMixInteger(autoMixField(value, "bpm"), 400),
    moods: Array.isArray(moods)
      ? moods.slice(0, 12).map((item) => publicAutoMixToken(item, 40)).filter(Boolean)
      : [],
    energy: publicAutoMixNumber(autoMixField(value, "energy"), 0, 1),
    integratedLufs: publicAutoMixNumber(
      autoMixField(value, "integratedLufs"),
      -100,
      20
    ),
    truePeakDbtp: publicAutoMixNumber(
      autoMixField(value, "truePeakDbtp"),
      -100,
      20
    ),
    loop: loop && typeof loop === "object" && !Array.isArray(loop)
      ? {
        startMs: publicAutoMixInteger(autoMixField(loop, "startMs")),
        endMs: publicAutoMixInteger(autoMixField(loop, "endMs"))
      }
      : null,
    analysisStatus: MUSIC_ANALYSIS_STATUSES.has(analysisStatus)
      ? analysisStatus
      : "failed",
    analysisErrorCode: publicCode(autoMixField(value, "analysisErrorCode"))
  };
}

function publicAutoMixMusicBrief(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const moods = autoMixField(value, "moods");
  const bpmRange = autoMixField(value, "bpmRange");
  const instruments = autoMixField(value, "instrumentPreferences");
  const transitions = autoMixField(value, "transitionPointsMs");
  const curve = autoMixField(value, "energyCurve");
  return {
    moods: Array.isArray(moods)
      ? moods.slice(0, 12).map((item) => publicAutoMixToken(item, 40)).filter(Boolean)
      : [],
    targetEnergy: publicAutoMixNumber(autoMixField(value, "targetEnergy"), 0, 1),
    bpmRange: Array.isArray(bpmRange)
      ? bpmRange.slice(0, 2).map((item) => publicAutoMixInteger(item, 400))
      : [],
    instrumentPreferences: Array.isArray(instruments)
      ? instruments.slice(0, 12).map((item) => publicAutoMixToken(item, 40)).filter(Boolean)
      : [],
    transitionPointsMs: Array.isArray(transitions)
      ? transitions.slice(0, 32).map((item) => publicAutoMixInteger(item, 120_000)).filter((item) => item !== null)
      : [],
    introDelayMs: publicAutoMixInteger(autoMixField(value, "introDelayMs"), 120_000),
    energyCurve: Array.isArray(curve)
      ? curve.slice(0, 12).map((item) => ({
        position: publicAutoMixNumber(autoMixField(item, "position"), 0, 1),
        energy: publicAutoMixNumber(autoMixField(item, "energy"), 0, 1)
      }))
      : []
  };
}

function publicAutoMixQualityReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    passed: autoMixField(value, "passed") === true,
    integratedLufs: publicAutoMixNumber(autoMixField(value, "integratedLufs"), -100, 20),
    truePeakDbtp: publicAutoMixNumber(autoMixField(value, "truePeakDbtp"), -100, 20),
    speechMusicMarginLu: publicAutoMixNumber(
      autoMixField(value, "speechMusicMarginLu"),
      -100,
      100
    )
  };
}

function publicAutoMixWarning(value) {
  if (typeof value === "string") return safeAutoMixText(value, 500);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    code: publicCode(autoMixField(value, "code")),
    message: safeAutoMixText(autoMixField(value, "message"), 500),
    layer: AUTO_MIX_V2_LAYERS.has(String(autoMixField(value, "layer") || ""))
      ? String(autoMixField(value, "layer"))
      : null,
    segmentId: publicAutoMixToken(autoMixField(value, "segmentId"), 80)
  };
}

function publicAutoMixCache(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reusedStages = autoMixField(value, "reusedStages");
  const inputHash = safeText(autoMixField(value, "inputHash"), 64);
  return {
    inputHash: /^[a-f0-9]{64}$/iu.test(inputHash) ? inputHash : null,
    reusedStages: Array.isArray(reusedStages)
      ? reusedStages.slice(0, 20).map((item) => publicAutoMixToken(item, 64)).filter(Boolean)
      : [],
    analysisReused: autoMixField(value, "analysisReused") === true,
    textReused: autoMixField(value, "textReused") === true,
    voiceReused: autoMixField(value, "voiceReused") === true,
    musicReused: autoMixField(value, "musicReused") === true
  };
}

function publicAutoMixAttention(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const layer = String(autoMixField(value, "layer") || "");
  return {
    code: publicCode(autoMixField(value, "code")),
    message: safeAutoMixText(autoMixField(value, "message"), 500),
    layer: AUTO_MIX_V2_LAYERS.has(layer) ? layer : null
  };
}

function publicAutoMixDurationPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = String(autoMixField(value, "policy") || "");
  const materialCapacityMs = publicAutoMixInteger(
    autoMixField(value, "materialCapacityMs"),
    120_000
  );
  const targetDurationMs = publicAutoMixInteger(
    autoMixField(value, "targetDurationMs"),
    120_000
  );
  const minimumDurationMs = publicAutoMixInteger(
    autoMixField(value, "minimumDurationMs"),
    120_000
  );
  const maximumDurationMs = publicAutoMixInteger(
    autoMixField(value, "maximumDurationMs"),
    120_000
  );
  if (
    policy !== "auto"
    || materialCapacityMs === null
    || targetDurationMs === null
    || minimumDurationMs === null
    || maximumDurationMs === null
    || targetDurationMs < 8_000
    || targetDurationMs > materialCapacityMs
    || minimumDurationMs <= 0
    || minimumDurationMs > maximumDurationMs
    || maximumDurationMs > targetDurationMs
  ) return null;
  return {
    policy: "auto",
    materialCapacityMs,
    targetDurationMs,
    minimumDurationMs,
    maximumDurationMs
  };
}

function publicAutoMixPlanV2(value = {}) {
  const state = String(autoMixField(value, "state") || autoMixField(value, "status") || "");
  const inputAssetIds = autoMixField(value, "inputAssetIds");
  const selectedSegments = autoMixField(value, "selectedSegments");
  const spokenPhrases = autoMixField(value, "spokenPhrases");
  const speechCaptions = autoMixField(value, "speechCaptions");
  const visualTextItems = autoMixField(value, "visualTextItems");
  const warnings = autoMixField(value, "qualityWarnings");
  const durationRange = autoMixField(value, "estimatedDurationRangeMs");
  return {
    specVersion: "2",
    runId: publicAutoMixRunId(autoMixField(value, "runId")),
    projectId: opaqueId(autoMixField(value, "projectId"), "creative_project"),
    taskId: opaqueId(autoMixField(value, "taskId"), "task"),
    parentRunId: publicAutoMixRunId(autoMixField(value, "parentRunId")),
    generation: Math.max(1, publicAutoMixInteger(autoMixField(value, "generation"), 1_000_000) || 1),
    state: AUTO_MIX_V2_STATES.has(state) ? state : "failed",
    usableMaterialDurationMs: publicAutoMixInteger(
      autoMixField(value, "usableMaterialDurationMs")
    ),
    estimatedDurationRangeMs: durationRange && typeof durationRange === "object"
      ? {
        min: publicAutoMixInteger(autoMixField(durationRange, "min"), 120_000),
        max: publicAutoMixInteger(autoMixField(durationRange, "max"), 120_000)
      }
      : null,
    selectedDurationMs: publicAutoMixInteger(
      autoMixField(value, "selectedDurationMs"),
      120_000
    ),
    durationPlan: publicAutoMixDurationPlan(autoMixField(value, "durationPlan")),
    inputAssetIds: Array.isArray(inputAssetIds)
      ? [...new Set(
        inputAssetIds
          .slice(0, 120)
          .map((item) => opaqueId(item, "asset"))
          .filter(Boolean)
      )]
      : [],
    selectedSegments: Array.isArray(selectedSegments)
      ? selectedSegments.slice(0, 500).map(publicAutoMixSegment)
      : [],
    spokenPhrases: Array.isArray(spokenPhrases)
      ? spokenPhrases.slice(0, 300).map(publicAutoMixPhrase)
      : [],
    speechCaptions: Array.isArray(speechCaptions)
      ? speechCaptions.slice(0, 300).map(publicAutoMixCaption)
      : [],
    visualTextItems: Array.isArray(visualTextItems)
      ? visualTextItems.slice(0, 100).map(publicAutoMixVisualText)
      : [],
    voicePersona: publicAutoMixVoicePersona(autoMixField(value, "voicePersona")),
    music: publicAutoMixMusic(autoMixField(value, "music")),
    musicBrief: publicAutoMixMusicBrief(autoMixField(value, "musicBrief")),
    qualityWarnings: Array.isArray(warnings)
      ? warnings.slice(0, 100).map(publicAutoMixWarning).filter((item) => item !== null)
      : [],
    qualityReport: publicAutoMixQualityReport(autoMixField(value, "qualityReport")),
    generatedVideoId: opaqueId(autoMixField(value, "generatedVideoId"), "generated_video"),
    outputCount: 1,
    cache: publicAutoMixCache(autoMixField(value, "cache")),
    attention: publicAutoMixAttention(autoMixField(value, "attention"))
  };
}

function publicGuidedAutoMixAnswers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {
    companyName: "",
    productName: "",
    targetScene: "",
    keyMessage: "",
    extraNotes: ""
  };
  return {
    companyName: safeAutoMixText(autoMixField(value, "companyName"), 80),
    productName: safeAutoMixText(autoMixField(value, "productName"), 100),
    targetScene: safeAutoMixText(autoMixField(value, "targetScene"), 180),
    keyMessage: safeAutoMixText(autoMixField(value, "keyMessage"), 300),
    extraNotes: safeAutoMixText(autoMixField(value, "extraNotes"), 240)
  };
}

function publicGuidedAutoMixPrefill(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  return {
    title: safeAutoMixText(autoMixField(source, "title"), 100),
    answers: publicGuidedAutoMixAnswers(autoMixField(source, "answers"))
  };
}

function publicGuidedAutoMixSession(value = {}) {
  const sessionId = String(autoMixField(value, "sessionId") || autoMixField(value, "session_id") || "");
  const state = String(autoMixField(value, "status") || "");
  const analysis = autoMixField(value, "analysis");
  const draft = autoMixField(value, "draft");
  const publicAnalysis = analysis && typeof analysis === "object" && !Array.isArray(analysis)
    ? analysis
    : {};
  const publicDraft = draft && typeof draft === "object" && !Array.isArray(draft)
    ? draft
    : {};
  return {
    sessionId: /^guided_auto_mix_session_[a-f0-9]{32}$/u.test(sessionId) ? sessionId : null,
    status: GUIDED_AUTO_MIX_SESSION_STATES.has(state) ? state : "failed",
    assetIds: Array.isArray(autoMixField(value, "assetIds"))
      ? [...new Set(
        autoMixField(value, "assetIds")
          .slice(0, 120)
          .map((item) => opaqueId(item, "asset"))
          .filter(Boolean)
      )]
      : [],
    analysisTask: autoMixField(value, "analysisTask")
      ? publicTask(autoMixField(value, "analysisTask"))
      : null,
    draftTask: autoMixField(value, "draftTask")
      ? publicTask(autoMixField(value, "draftTask"))
      : null,
    analysis: {
      usableMaterialDurationMs: publicAutoMixInteger(
        autoMixField(publicAnalysis, "usableMaterialDurationMs"), 120_000
      ),
      selectedDurationMs: publicAutoMixInteger(
        autoMixField(publicAnalysis, "selectedDurationMs"), 120_000
      ),
      selectedSegmentCount: publicAutoMixInteger(
        autoMixField(publicAnalysis, "selectedSegmentCount"), 500
      ),
      durationPlan: publicAutoMixDurationPlan(
        autoMixField(publicAnalysis, "durationPlan")
      ),
      materialFacts: Array.isArray(autoMixField(publicAnalysis, "materialFacts"))
        ? autoMixField(publicAnalysis, "materialFacts").slice(0, 8).map((item) => ({
          text: safeAutoMixText(autoMixField(item, "text"), 72),
          kind: safeAutoMixText(autoMixField(item, "kind"), 32)
        })).filter((item) => item.text)
        : []
    },
    answers: publicGuidedAutoMixAnswers(autoMixField(value, "answers")),
    prefill: publicGuidedAutoMixPrefill(autoMixField(value, "prefill")),
    draft: {
      scriptRevision: publicAutoMixInteger(
        autoMixField(publicDraft, "scriptRevision"), 1_000_000
      ),
      draftHash: /^[a-f0-9]{64}$/iu.test(
        String(autoMixField(publicDraft, "draftHash") || "")
      ) ? String(autoMixField(publicDraft, "draftHash")).toLowerCase() : null,
      title: safeAutoMixText(autoMixField(publicDraft, "title"), 100),
      provider: safeAutoMixText(autoMixField(publicDraft, "provider"), 64) || null,
      hook: safeAutoMixText(autoMixField(publicDraft, "hook"), 80),
      voiceover: safeAutoMixText(autoMixField(publicDraft, "voiceover"), 2_400),
      cta: safeAutoMixText(autoMixField(publicDraft, "cta"), 80),
      durationPlan: publicAutoMixDurationPlan(
        autoMixField(publicDraft, "durationPlan")
      ),
      spokenPhrases: Array.isArray(autoMixField(publicDraft, "spokenPhrases"))
        ? autoMixField(publicDraft, "spokenPhrases").slice(0, 80).map((item) => ({
          text: safeAutoMixText(autoMixField(item, "text"), 80)
        })).filter((item) => item.text)
        : [],
      visualTextItems: Array.isArray(autoMixField(publicDraft, "visualTextItems"))
        ? autoMixField(publicDraft, "visualTextItems").slice(0, 16).map((item) => ({
          type: ["hook", "callout", "cta"].includes(String(autoMixField(item, "type") || ""))
            ? String(autoMixField(item, "type"))
            : null,
          text: safeAutoMixText(autoMixField(item, "text"), 80)
        })).filter((item) => item.text)
        : []
    }
  };
}

function publicGuidedAutoMixSupplementalImage(value = {}) {
  const nested = autoMixField(value, "operation");
  const operation = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested
    : value;
  const operationId = String(
    autoMixField(operation, "operationId") || autoMixField(operation, "operation_id") || ""
  );
  const sessionId = String(
    autoMixField(value, "sessionId") || autoMixField(operation, "sessionId")
      || autoMixField(operation, "session_id") || ""
  );
  const status = String(
    autoMixField(operation, "status") || autoMixField(value, "status") || "not_requested"
  );
  return {
    operationId: /^guided_auto_mix_supplemental_image_[a-f0-9]{32}$/u.test(operationId)
      ? operationId
      : null,
    sessionId: /^guided_auto_mix_session_[a-f0-9]{32}$/u.test(sessionId)
      ? sessionId
      : null,
    scriptRevision: publicAutoMixInteger(
      autoMixField(value, "scriptRevision") || autoMixField(operation, "scriptRevision"),
      1_000_000
    ) || 0,
    status: GUIDED_AUTO_MIX_SUPPLEMENTAL_IMAGE_STATES.has(status)
      ? status
      : "failed",
    estimatedImageCalls: publicAutoMixInteger(
      autoMixField(value, "estimatedImageCalls") || autoMixField(operation, "estimatedImageCalls"), 1
    ) || 0,
    provider: safeAutoMixText(
      autoMixField(value, "provider") || autoMixField(operation, "provider"), 64
    ) || null,
    paidCallPerformed: autoMixField(value, "paidCallPerformed") === true
      || autoMixField(operation, "paidCallPerformed") === true,
    errorCode: publicCode(
      autoMixField(value, "errorCode") || autoMixField(operation, "errorCode")
    )
  };
}

function publicVisualComparisonPreflight(value = {}) {
  const reason = publicCode(value.reason) || "preflight_invalid";
  const renderCount = Number(value.renderCount ?? value.render_count);
  const bailianCalls = Number(value.bailianCalls ?? value.bailian_calls);
  const apimartCalls = Number(value.apimartCalls ?? value.apimart_calls);
  if (renderCount !== 3 || bailianCalls !== 0 || apimartCalls !== 0) {
    invalid("CONTENT_ENGINE_RESPONSE_INVALID");
  }
  const visualComparisonAvailable = (
    value.visualComparisonAvailable ?? value.visual_comparison_available
  ) === true;
  return {
    eligible: value.eligible === true
      && reason === "ready"
      && visualComparisonAvailable,
    reason,
    renderCount: 3,
    bailianCalls: 0,
    apimartCalls: 0,
    remotionAvailable: (
      value.remotionAvailable ?? value.remotion_available
    ) === true,
    visualComparisonAvailable,
    aiCoverVerified: value.aiCoverVerified ?? value.ai_cover_verified ?? false,
    remotionAccepted: value.remotionAccepted ?? value.remotion_accepted ?? false,
    phoneReviewed: value.phoneReviewed ?? value.phone_reviewed ?? false
  };
}

function publicPackagingPreset(value = {}) {
  return camelizePublic({
    preset_id: value.preset_id,
    version: value.version,
    kind: value.kind,
    display_name: value.display_name,
    subtitle: value.subtitle,
    effects: value.effects,
    audio: value.audio,
    cover: value.cover
  });
}

function publicBrandProfile(value = {}) {
  return camelizePublic({
    brand_profile_id: value.brand_profile_id,
    name: value.name,
    logo_asset_id: value.logo_asset_id,
    reference_portrait_asset_id: value.reference_portrait_asset_id,
    primary_color: value.primary_color,
    accent_color: value.accent_color,
    font_preset: value.font_preset,
    outro_text: value.outro_text,
    created_at: value.created_at,
    updated_at: value.updated_at
  });
}

function publicBailianStatus(value = {}) {
  return {
    configured: value.configured === true,
    maskedKey: safeText(value.maskedKey, 32),
    apiHost: safeText(value.apiHost, 256),
    secureStorageAvailable: value.secureStorageAvailable !== false,
    code: safeText(value.code, 64) || ""
  };
}

function publicDirectoryLabel(value) {
  const candidate = String(value || "");
  if (!candidate) return "";
  const basename = path.basename(candidate);
  if (basename) return safePublicText(basename, 120);
  const drive = path.parse(candidate).root.match(/^([a-z]):[\\/]?$/i);
  return drive ? `${drive[1].toUpperCase()} 盘` : "所选磁盘";
}

function resolvedAbsolutePath(result) {
  const candidate = String(result?.absolute_path || "");
  if (!candidate || !path.isAbsolute(candidate)) {
    throw Object.assign(new Error("invalid resolved path"), {
      code: result?.available === false
        ? "path_not_found"
        : "CONTENT_ENGINE_PATH_INVALID"
    });
  }
  let resolved;
  try {
    resolved = fs.realpathSync(candidate);
    if (!fs.statSync(resolved).isFile()) throw new Error("not a file");
  } catch {
    throw Object.assign(new Error("resolved file is unavailable"), {
      code: "path_not_found"
    });
  }
  return resolved;
}

function safeVideoFilename(rawFilename) {
  const basename = path.basename(String(rawFilename || ""))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!basename) return "成片.mp4";
  return basename.toLowerCase().endsWith(".mp4") ? basename : `${basename}.mp4`;
}

function resolvedAbsoluteDirectory(result) {
  const candidate = String(result?.absolute_path || "");
  if (!candidate || !path.isAbsolute(candidate)) {
    throw Object.assign(new Error("invalid resolved directory"), {
      code: "CONTENT_ENGINE_PATH_INVALID"
    });
  }
  try {
    const resolved = fs.realpathSync(candidate);
    if (!fs.statSync(resolved).isDirectory()) throw new Error("not a directory");
    return resolved;
  } catch {
    throw Object.assign(new Error("resolved directory is unavailable"), {
      code: "path_not_found"
    });
  }
}

function registerContentEngineIpc(options = {}) {
  const electron = options.electron || require("electron");
  const ipcMain = options.ipcMain || electron.ipcMain;
  const dialog = options.dialog || electron.dialog;
  const shell = options.shell || electron.shell;
  const app = options.app || electron.app;
  const controller = options.controller;
  const bailianKeyStore = options.bailianKeyStore;
  const bailianKeySessions = new Map();
  const consumedAutoMixClickTokens = new Set();
  const auditionedAutoMixVoicePersonas = new Set();
  const observedTaskStates = new Map();
  const sessionTaskIds = new Set();
  const observedOperationFailures = new Map();
  const diagnosticLogger = options.diagnosticLogger || diagnostics();
  const requestedDiagnosticSessionStartedAt = Number(options.diagnosticSessionStartedAt);
  const diagnosticSessionStartedAt = Number.isFinite(requestedDiagnosticSessionStartedAt)
    ? requestedDiagnosticSessionStartedAt
    : Date.now();
  const getMainWindow = typeof options.getMainWindow === "function"
    ? options.getMainWindow
    : () => null;

  function requireTrustedAutoMixClick(event, clickToken, operation) {
    const token = String(clickToken || "");
    const expectedPrefix = `${operation}:`;
    const uuid = token.startsWith(expectedPrefix)
      ? token.slice(expectedPrefix.length)
      : "";
    const window = getMainWindow();
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(uuid)
      || consumedAutoMixClickTokens.has(token)
      || !window
      || window.isDestroyed()
      || event?.sender !== window.webContents
      || !window.isFocused()
    ) {
      invalid("trusted_user_click_required");
    }
    consumedAutoMixClickTokens.add(token);
    while (consumedAutoMixClickTokens.size > 200) {
      consumedAutoMixClickTokens.delete(consumedAutoMixClickTokens.values().next().value);
    }
  }

  function rememberReturnedTask(data) {
    if (!data || typeof data !== "object" || !data.taskId) return;
    const taskId = opaqueId(data.taskId, "task");
    if (!taskId) return;
    sessionTaskIds.delete(taskId);
    sessionTaskIds.add(taskId);
    if (sessionTaskIds.size > MAX_DIAGNOSTIC_TASK_STATES) {
      sessionTaskIds.delete(sessionTaskIds.values().next().value);
    }
    if (TASK_STATES.has(data.status)) {
      observeTask(data, {
        rawStatus: data.status,
        belongsToCurrentSession: true,
        trustedCurrent: true
      });
    }
  }

  function rememberTaskState(taskId, status, updatedAtValue, { trustedCurrent = false } = {}) {
    const previous = observedTaskStates.get(taskId);
    const previousUpdatedAtMs = previous?.updatedAtMs ?? null;
    const parsedUpdatedAt = Date.parse(updatedAtValue || "");
    const updatedAtMs = Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : null;
    const needsConflictConfirmation = !trustedCurrent
      && previous?.trustedCurrent === true
      && previous.status !== status
      && !TERMINAL_TASK_STATES.has(previous.status)
      && previousUpdatedAtMs === null;
    const pendingConflict = previous?.pendingConflict;
    const confirmsPendingConflict = needsConflictConfirmation
      && pendingConflict?.status === status
      && (
        pendingConflict.updatedAtMs === null
        || updatedAtMs === null
        || updatedAtMs >= pendingConflict.updatedAtMs
      );
    if (needsConflictConfirmation && !confirmsPendingConflict) {
      observedTaskStates.delete(taskId);
      observedTaskStates.set(taskId, {
        ...previous,
        pendingConflict: { status, updatedAtMs }
      });
      if (observedTaskStates.size > MAX_DIAGNOSTIC_TASK_STATES) {
        observedTaskStates.delete(observedTaskStates.keys().next().value);
      }
      return { ignored: true, previousStatus: previous.status };
    }
    const isOlderObservation = !trustedCurrent
      && previous
      && previousUpdatedAtMs !== null
      && updatedAtMs !== null
      && updatedAtMs < previousUpdatedAtMs;
    const isUnorderedTerminalConflict = !trustedCurrent
      && previous
      && TERMINAL_TASK_STATES.has(previous.status)
      && previous.status !== status
      && previousUpdatedAtMs !== null
      && (updatedAtMs === null || updatedAtMs === previousUpdatedAtMs);
    const isStaleAgainstTrustedCurrent = !trustedCurrent
      && previous?.trustedCurrent === true
      && previous.status !== status
      && (
        (previousUpdatedAtMs === null && TERMINAL_TASK_STATES.has(previous.status))
        || (
          previousUpdatedAtMs !== null
          && (updatedAtMs === null || updatedAtMs <= previousUpdatedAtMs)
        )
      );
    if (isOlderObservation || isUnorderedTerminalConflict || isStaleAgainstTrustedCurrent) {
      return { ignored: true, previousStatus: previous.status };
    }
    const effectiveUpdatedAtMs = previousUpdatedAtMs !== null
      && (updatedAtMs === null || (trustedCurrent && updatedAtMs < previousUpdatedAtMs))
      ? previousUpdatedAtMs
      : updatedAtMs;
    const remainsTrustedCurrent = previous?.trustedCurrent === true
      && previous.status === status;
    observedTaskStates.delete(taskId);
    observedTaskStates.set(taskId, {
      status,
      updatedAtMs: effectiveUpdatedAtMs,
      trustedCurrent: trustedCurrent || remainsTrustedCurrent
    });
    if (observedTaskStates.size > MAX_DIAGNOSTIC_TASK_STATES) {
      observedTaskStates.delete(observedTaskStates.keys().next().value);
    }
    if (TERMINAL_TASK_STATES.has(status)) {
      sessionTaskIds.delete(taskId);
    }
    return { ignored: false, previousStatus: previous?.status };
  }

  function observeTask(item, options = {}) {
    const rawStatus = String(options.rawStatus || item?.status || "");
    if (!TASK_STATES.has(rawStatus)) return;
    const taskId = opaqueId(item?.taskId, "task");
    if (!taskId) return;
    const belongsToCurrentSession = options.belongsToCurrentSession === true
      || sessionTaskIds.has(taskId);
    const observation = rememberTaskState(taskId, rawStatus, item?.updatedAt, {
      trustedCurrent: options.trustedCurrent === true
    });
    if (observation.ignored) return;
    const previousStatus = observation.previousStatus;
    if (previousStatus === "failed" && rawStatus !== "failed") {
      diagnosticLogger.recover?.("content_engine");
    }
    if (rawStatus !== "failed" || previousStatus === "failed") return;
    const updatedAt = Date.parse(item?.updatedAt || "");
    const failedDuringCurrentSession = Number.isFinite(updatedAt)
      && updatedAt >= diagnosticSessionStartedAt;
    if (
      previousStatus === undefined
      && !failedDuringCurrentSession
      && !belongsToCurrentSession
    ) return;
    const errorCode = diagnosticCode(item?.errorCode);
    diagnosticLogger.event(
      "content_engine",
      "task_terminal",
      {
        task_id: taskId,
        error_code: errorCode
      },
      {
        level: "error",
        code: errorCode,
        dedupeKey: taskId
      }
    );
  }

  function handle(channel, operation) {
    const operationName = String(channel || "content-engine:operation")
      .replace(/^content-engine:/u, "")
      .replace(/[^a-z0-9_-]/giu, "_");
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        const data = await operation(validatePayload(payload), _event);
        if (observedOperationFailures.delete(operationName)) {
          diagnosticLogger.recover?.("content_engine");
        }
        rememberReturnedTask(data);
        return { ok: true, data };
      } catch (error) {
        const errorCode = diagnosticCode(error?.code);
        if (errorCode === "CONTENT_DIALOG_CANCELLED") {
          if (observedOperationFailures.delete(operationName)) {
            diagnosticLogger.recover?.("content_engine");
          }
        } else if (observedOperationFailures.get(operationName) !== errorCode) {
          observedOperationFailures.set(operationName, errorCode);
          diagnosticLogger.event(
            "content_engine",
            `${operationName}.failed`,
            { error_code: errorCode },
            { level: "error", code: errorCode }
          );
        }
        return publicError(error);
      }
    });
  }

  function openDialog(properties, filters, title) {
    const window = getMainWindow();
    const dialogOptions = { title, properties, filters };
    return window && !window.isDestroyed()
      ? dialog.showOpenDialog(window, dialogOptions)
      : dialog.showOpenDialog(dialogOptions);
  }

  handle(CONTENT_ENGINE_CHANNELS.status, () => publicStatus(controller.status()));
  registerNarratedBatchIpc({ handle, controller, validateId, validateVoicePersonaId, assertKeys, invalid, openDialog, requireTrustedAutoMixClick });
  handle(CONTENT_ENGINE_CHANNELS.restart, async () => publicStatus(
    await controller.restart()
  ));
  handle(CONTENT_ENGINE_CHANNELS.listAssets, async (payload) => {
    const result = await controller.listAssets({
      includeArchived: payload.includeArchived === true,
      limit: validateLimit(payload.limit)
    });
    return { items: (result?.items || []).map(publicAsset) };
  });
  handle(CONTENT_ENGINE_CHANNELS.chooseFiles, async () => {
    const selection = await openDialog(
      ["openFile", "multiSelections"],
      undefined,
      "选择需要登记的素材"
    );
    if (selection.canceled || selection.filePaths.length === 0) {
      throw Object.assign(new Error("dialog cancelled"), {
        code: "CONTENT_DIALOG_CANCELLED"
      });
    }
    const result = await controller.importFiles(selection.filePaths);
    return {
      cancelled: false,
      items: (result?.items || []).map(publicAsset),
      createdAssets: Number(result?.created_assets || 0),
      createdLocations: Number(result?.created_locations || 0),
      skippedCount: Number(result?.skipped_count || 0),
      skipped: Array.isArray(result?.skipped)
        ? result.skipped.slice(0, 500).map((item) => ({
          index: Number.isInteger(item?.index) ? item.index : -1,
          reason: safeText(item?.reason, 64)
        }))
        : []
    };
  });
  handle(CONTENT_ENGINE_CHANNELS.chooseFolder, async (payload) => {
    const selection = await openDialog(
      ["openDirectory"],
      undefined,
      "选择需要登记的素材文件夹"
    );
    if (selection.canceled || selection.filePaths.length === 0) {
      throw Object.assign(new Error("dialog cancelled"), {
        code: "CONTENT_DIALOG_CANCELLED"
      });
    }
    const result = await controller.importFolder(
      selection.filePaths[0],
      payload.recursive !== false
    );
    return {
      cancelled: false,
      items: (result?.items || []).map(publicAsset),
      createdAssets: Number(result?.created_assets || 0),
      createdLocations: Number(result?.created_locations || 0),
      skippedCount: Number(result?.skipped_count || 0),
      skipped: Array.isArray(result?.skipped)
        ? result.skipped.slice(0, 500).map((item) => ({
          index: Number.isInteger(item?.index) ? item.index : -1,
          reason: safeText(item?.reason, 64)
        }))
        : [],
      taskId: safeText(result?.task_id, 80) || null,
      status: TASK_STATES.has(result?.status) ? result.status : null,
      hasMore: result?.has_more === true,
      processedEntries: Number(result?.processed_entries || 0)
    };
  });
  handle(CONTENT_ENGINE_CHANNELS.probeAsset, async (payload) => publicAsset(
    await controller.probeAsset(validateId(payload.assetId, "asset"))
  ));
  handle(CONTENT_ENGINE_CHANNELS.probePending, async (payload) => {
    const result = await controller.probePending(validateProbeLimit(payload.limit));
    return {
      items: (result?.items || []).map(publicAsset),
      processedCount: Number(result?.processed_count || 0),
      remainingCount: Number(result?.remaining_count || 0)
    };
  });
  handle(CONTENT_ENGINE_CHANNELS.updateAssetRights, async (payload) => {
    const assetId = validateId(payload.assetId, "asset");
    const rightsStatus = String(payload.rightsStatus || "");
    if (!RIGHTS_STATUSES.has(rightsStatus)) {
      throw Object.assign(new Error("invalid rights status"), {
        code: "invalid_rights_status"
      });
    }
    return publicAsset(await controller.updateAssetRights(assetId, rightsStatus));
  });
  handle(CONTENT_ENGINE_CHANNELS.archiveAsset, async (payload) => {
    const item = await controller.archiveAsset(
      validateId(payload.assetId, "asset")
    );
    return publicAsset(item);
  });
  handle(CONTENT_ENGINE_CHANNELS.revealAsset, async (payload) => {
    const assetId = validateId(payload.assetId, "asset");
    const result = await controller.resolveAssetPath(assetId);
    if (result?.asset_id !== assetId) {
      throw Object.assign(new Error("asset resolution mismatch"), {
        code: "CONTENT_ENGINE_RESPONSE_INVALID"
      });
    }
    const trustedPath = resolvedAbsolutePath(result);
    shell.showItemInFolder(trustedPath);
    return { available: true, revealed: true };
  });
  handle(CONTENT_ENGINE_CHANNELS.listTasks, async (payload) => {
    const status = payload.status === undefined || payload.status === null
      ? undefined
      : String(payload.status);
    if (status && !TASK_STATES.has(status)) {
      throw Object.assign(new Error("invalid status"), { code: "invalid_status" });
    }
    const result = await controller.listTasks({
      status,
      limit: validateLimit(payload.limit)
    });
    const rawItems = Array.isArray(result?.items) ? result.items : [];
    const items = rawItems.map(publicTask);
    for (const [index, item] of items.entries()) {
      const rawStatus = String(rawItems[index]?.status || "");
      observeTask(item, { rawStatus });
    }
    return { items };
  });
  for (const [channel, method] of [
    [CONTENT_ENGINE_CHANNELS.pauseTask, "pauseTask"],
    [CONTENT_ENGINE_CHANNELS.resumeTask, "resumeTask"],
    [CONTENT_ENGINE_CHANNELS.cancelTask, "cancelTask"]
  ]) {
    handle(channel, async (payload) => publicTask(
      await controller[method](validateId(payload.taskId, "task"))
    ));
  }
  handle(CONTENT_ENGINE_CHANNELS.listFinished, async (payload) => {
    const result = await controller.listFinished(validateLimit(payload.limit));
    return { items: (result?.items || []).map(publicFinished) };
  });
  handle(CONTENT_ENGINE_CHANNELS.chooseAndRegisterFinished, async (payload) => {
    const selection = await openDialog(
      ["openFile"],
      undefined,
      "选择需要登记的成片"
    );
    if (selection.canceled || selection.filePaths.length === 0) {
      throw Object.assign(new Error("dialog cancelled"), {
        code: "CONTENT_DIALOG_CANCELLED"
      });
    }
    const taskId = payload.taskId
      ? validateId(payload.taskId, "task")
      : undefined;
    const result = await controller.registerFinished(selection.filePaths[0], {
      title: validateTitle(payload.title),
      taskId,
      metadata: {}
    });
    return publicFinished(result);
  });
  handle(CONTENT_ENGINE_CHANNELS.openFinished, async (payload) => {
    const finishedVideoId = validateId(payload.finishedVideoId, "finished");
    const result = await controller.resolveFinishedPath(finishedVideoId);
    if (result?.finished_video_id !== finishedVideoId) {
      throw Object.assign(new Error("finished resolution mismatch"), {
        code: "CONTENT_ENGINE_RESPONSE_INVALID"
      });
    }
    const trustedPath = resolvedAbsolutePath(result);
    const shellError = await shell.openPath(trustedPath);
    if (shellError) {
      throw Object.assign(new Error("open failed"), {
        code: "CONTENT_ENGINE_OPEN_FAILED"
      });
    }
    return { opened: true };
  });
  handle(CONTENT_ENGINE_CHANNELS.revealFinished, async (payload) => {
    const finishedVideoId = validateId(payload.finishedVideoId, "finished");
    const result = await controller.resolveFinishedPath(finishedVideoId);
    if (result?.finished_video_id !== finishedVideoId) {
      throw Object.assign(new Error("finished resolution mismatch"), {
        code: "CONTENT_ENGINE_RESPONSE_INVALID"
      });
    }
    const trustedPath = resolvedAbsolutePath(result);
    shell.showItemInFolder(trustedPath);
    return { available: true, revealed: true };
  });
  handle(CONTENT_ENGINE_CHANNELS.downloadFinished, async (payload) => {
    assertKeys(payload, new Set(["finishedVideoId"]));
    const finishedVideoId = validateId(payload.finishedVideoId, "finished");
    const result = await controller.resolveFinishedPath(finishedVideoId);
    if (result?.finished_video_id !== finishedVideoId) {
      invalid("CONTENT_ENGINE_RESPONSE_INVALID");
    }
    const trustedPath = resolvedAbsolutePath(result);
    return {
      finishedVideoId,
      ...(await saveVideoToChosenLocation(trustedPath))
    };
  });
  handle(CONTENT_ENGINE_CHANNELS.settingsStatus, async () => {
    const [cacheDirectory, cacheLabel, cacheConfigured, cacheLimit] = await Promise.all([
      controller.getSetting("cache_directory", ""),
      controller.getSetting("cache_directory_label", ""),
      controller.getSetting("cache_configured", false),
      controller.getSetting("cache_limit_gb", 100)
    ]);
    const hasStoredDirectory = typeof cacheDirectory?.value === "string"
      && cacheDirectory.value.length > 0;
    return {
      cacheConfigured: cacheConfigured?.value === true || hasStoredDirectory,
      cacheDirectoryLabel: safePublicText(cacheLabel?.value, 120),
      cacheLimitGb: Number.isInteger(cacheLimit?.value)
        ? cacheLimit.value
        : 100
    };
  });
  handle(CONTENT_ENGINE_CHANNELS.chooseCacheDirectory, async () => {
    const selection = await openDialog(
      ["openDirectory", "createDirectory"],
      undefined,
      "选择代理文件和缓存的保存位置"
    );
    if (selection.canceled || selection.filePaths.length === 0) {
      throw Object.assign(new Error("dialog cancelled"), {
        code: "CONTENT_DIALOG_CANCELLED"
      });
    }
    const selectedPath = fs.realpathSync(selection.filePaths[0]);
    if (!path.isAbsolute(selectedPath) || !fs.statSync(selectedPath).isDirectory()) {
      throw Object.assign(new Error("invalid cache directory"), {
        code: "invalid_path"
      });
    }
    const cacheDirectoryLabel = publicDirectoryLabel(selectedPath);
    await controller.setSetting("cache_directory", selectedPath);
    await controller.setSetting("cache_directory_label", cacheDirectoryLabel);
    await controller.setSetting("cache_configured", true);
    const cacheLimit = await controller.getSetting("cache_limit_gb", 100);
    return {
      cancelled: false,
      cacheConfigured: true,
      cacheDirectoryLabel,
      cacheLimitGb: Number.isInteger(cacheLimit?.value) ? cacheLimit.value : 100
    };
  });
  handle(CONTENT_ENGINE_CHANNELS.updateCacheLimit, async (payload) => {
    const limitGb = Number(payload.limitGb);
    if (!Number.isInteger(limitGb) || limitGb < 1 || limitGb > 2_048) {
      throw Object.assign(new Error("invalid cache limit"), {
        code: "invalid_params"
      });
    }
    await controller.setSetting("cache_limit_gb", limitGb);
    return { cacheLimitGb: limitGb };
  });
  handle(CONTENT_ENGINE_CHANNELS.bailianKeyStatus, async () => {
    if (!bailianKeyStore) invalid("CONTENT_ENGINE_CAPABILITY_UNAVAILABLE");
    return publicBailianStatus(bailianKeyStore.status());
  });
  handle(CONTENT_ENGINE_CHANNELS.bailianKeyEncryption, async () => {
    if (!bailianKeyStore) invalid("CONTENT_ENGINE_CAPABILITY_UNAVAILABLE");
    const now = Date.now();
    for (const [keyId, session] of bailianKeySessions) {
      if (session.expiresAt <= now) bailianKeySessions.delete(keyId);
    }
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    const keyId = randomBytes(16).toString("hex");
    bailianKeySessions.set(keyId, { privateKey, expiresAt: now + 60_000 });
    return { keyId, publicKey };
  });
  handle(CONTENT_ENGINE_CHANNELS.saveBailianKey, async (payload) => {
    assertKeys(payload, new Set(["keyId", "ciphertext", "apiHost"]));
    if (!bailianKeyStore) invalid("CONTENT_ENGINE_CAPABILITY_UNAVAILABLE");
    const keyId = safeText(payload.keyId, 64);
    const ciphertext = safeText(payload.ciphertext, 1_024);
    const apiHost = payload.apiHost == null ? "" : safeText(payload.apiHost, 256);
    const session = bailianKeySessions.get(keyId);
    bailianKeySessions.delete(keyId);
    if (!/^[a-f0-9]{32}$/.test(keyId)
      || !/^[a-z0-9+/]+={0,2}$/i.test(ciphertext)
      || !session
      || session.expiresAt <= Date.now()) {
      invalid("BAILIAN_KEY_ENCRYPTION_INVALID");
    }
    let plaintext;
    try {
      plaintext = privateDecrypt(
        {
          key: session.privateKey,
          padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256"
        },
        Buffer.from(ciphertext, "base64")
      );
      const status = publicBailianStatus(
        bailianKeyStore.write(plaintext.toString("utf8"), { apiHost })
      );
      await controller.restart();
      return status;
    } catch (error) {
      if (error?.code?.startsWith?.("BAILIAN_") || error?.code === "SECURE_STORAGE_UNAVAILABLE") {
        throw error;
      }
      invalid("BAILIAN_KEY_ENCRYPTION_INVALID");
    } finally {
      plaintext?.fill(0);
    }
  });
  handle(CONTENT_ENGINE_CHANNELS.deleteBailianKey, async () => {
    if (!bailianKeyStore) invalid("CONTENT_ENGINE_CAPABILITY_UNAVAILABLE");
    const status = publicBailianStatus(bailianKeyStore.clear());
    await controller.restart();
    return status;
  });
  handle(CONTENT_ENGINE_CHANNELS.analyzeAssets, async (payload) => {
    assertKeys(payload, new Set(["assetIds"]));
    if (!Array.isArray(payload.assetIds) || payload.assetIds.length < 1 || payload.assetIds.length > 500) {
      invalid("invalid_params");
    }
    const assetIds = [...new Set(payload.assetIds.map((item) => validateId(item, "asset")))];
    return publicTask(await controller.analyzeAssets(assetIds, { provider: "bailian" }));
  });
  handle(CONTENT_ENGINE_CHANNELS.listMediaSegments, async (payload) => {
    assertKeys(payload, new Set(["assetId", "role", "limit"]));
    const role = payload.role == null ? undefined : String(payload.role);
    if (role && !new Set(["hook", "process", "result", "general"]).has(role)) {
      invalid("invalid_role");
    }
    const limit = payload.limit == null ? 2_000 : Number(payload.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 2_000) invalid("invalid_limit");
    const result = await controller.listMediaSegments({
      assetId: payload.assetId == null ? undefined : validateId(payload.assetId, "asset"),
      role,
      limit
    });
    return { items: (result?.items || []).map(publicMediaSegment) };
  });
  handle(CONTENT_ENGINE_CHANNELS.generateCourseCuts, async (payload) => {
    assertKeys(payload, new Set([
      "assetId", "minDurationMs", "maxDurationMs", "count", "theme",
      "subtitleFontSize", "subtitleMarginBottom", "experimentMode", "subtitlePreset",
      "packagingMode", "packagingPresetId", "brandProfileId", "coverMode",
      "visualRenderer", "confirmPaidCalls"
    ]));
    const minimum = Number(payload.minDurationMs ?? 30_000);
    const maximum = Number(payload.maxDurationMs ?? 90_000);
    const count = Number(payload.count ?? 5);
    if (!Number.isInteger(minimum) || !Number.isInteger(maximum)
      || minimum < 30_000 || maximum > 90_000 || minimum > maximum) {
      invalid("invalid_duration_range");
    }
    if (!Number.isInteger(count) || count < 1 || count > 20) invalid("invalid_limit");
    const subtitleFontSize = Number(payload.subtitleFontSize ?? 48);
    const subtitleMarginBottom = Number(payload.subtitleMarginBottom ?? 170);
    if (!Number.isInteger(subtitleFontSize) || subtitleFontSize < 36 || subtitleFontSize > 64) {
      invalid("invalid_subtitle_font_size");
    }
    if (!Number.isInteger(subtitleMarginBottom)
      || subtitleMarginBottom < 120 || subtitleMarginBottom > 360) {
      invalid("invalid_subtitle_margin_bottom");
    }
    const experimentMode = String(payload.experimentMode ?? "standard");
    const subtitlePreset = String(payload.subtitlePreset ?? "dynamic_clean");
    if (!new Set(["standard", "supoclip_bailian_v1"]).has(experimentMode)) {
      invalid("invalid_experiment_mode");
    }
    if (experimentMode === "supoclip_bailian_v1" && count !== 5) {
      invalid("invalid_experiment_count");
    }
    const expectedPresets = experimentMode === "standard"
      ? new Set(["dynamic_clean"])
      : new Set(["knowledge_course", "energetic_talking"]);
    if (!expectedPresets.has(subtitlePreset)) invalid("invalid_subtitle_preset");
    const packaging = validatePackagingOptions(payload);
    if (packaging.coverMode === "reuse") invalid("invalid_cover_mode");
    if (packaging.packagingPresetId
      && !new Set(["knowledge_focus", "slide_teacher", "classroom_value"])
        .has(packaging.packagingPresetId)) {
      invalid("invalid_packaging_preset");
    }
    const result = await controller.generateCourseCuts(
      validateId(payload.assetId, "asset"),
      {
        minDurationMs: minimum,
        maxDurationMs: maximum,
        count,
        theme: validateText(payload.theme ?? "培训现场价值", 100, "invalid_params"),
        subtitleFontSize,
        subtitleMarginBottom,
        experimentMode,
        subtitlePreset,
        confirmPaidCalls: payload.confirmPaidCalls === true,
        ...packaging
      }
    );
    return camelizePublic({ task_id: result?.task_id, project_id: result?.project_id });
  });
  handle(CONTENT_ENGINE_CHANNELS.generateMixBatch, async (payload) => {
    assertKeys(payload, new Set([
      "assetIds", "theme", "targetCount", "voiceAssetId",
      "pilotMode",
      "packagingMode", "packagingPresetId", "brandProfileId", "coverMode",
      "visualRenderer", "confirmPaidCalls"
    ]));
    if (!Array.isArray(payload.assetIds) || payload.assetIds.length < 1 || payload.assetIds.length > 500) {
      invalid("invalid_params");
    }
    const targetCount = Number(payload.targetCount ?? 30);
    if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 300) {
      invalid("invalid_limit");
    }
    const assetIds = [...new Set(payload.assetIds.map((item) => validateId(item, "asset")))];
    const voiceAssetId = payload.voiceAssetId == null
      ? null
      : validateId(payload.voiceAssetId, "asset");
    if (!voiceAssetId || !assetIds.includes(voiceAssetId)) invalid("invalid_voice_asset");
    if (payload.pilotMode !== undefined && typeof payload.pilotMode !== "boolean") {
      invalid("invalid_params");
    }
    const packaging = validatePackagingOptions(payload);
    if (packaging.coverMode === "reuse") invalid("invalid_cover_mode");
    if (packaging.packagingPresetId
      && !new Set(["hook_impact", "process_rhythm", "result_close"])
        .has(packaging.packagingPresetId)) {
      invalid("invalid_packaging_preset");
    }
    const result = await controller.generateMixBatch(assetIds, {
      theme: validateText(payload.theme ?? "培训现场价值", 100, "invalid_params"),
      targetCount,
      voiceAssetId,
      pilotMode: payload.pilotMode === true,
      confirmPaidCalls: payload.confirmPaidCalls === true,
      ...packaging
    });
    return camelizePublic({ task_id: result?.task_id, project_id: result?.project_id });
  });
  handle(CONTENT_ENGINE_CHANNELS.createOneClickProject, async (payload) => {
    assertKeys(payload, new Set(["name", "assetIds", "options"]));
    if (!Array.isArray(payload.assetIds) || payload.assetIds.length < 1 || payload.assetIds.length > 200) {
      invalid("invalid_params");
    }
    const assetIds = [...new Set(payload.assetIds.map((item) => validateId(item, "asset")))];
    const options = payload.options == null ? {} : payload.options;
    if (!options || typeof options !== "object" || Array.isArray(options)) invalid("invalid_params");
    const ratio = String(options.ratio ?? "9:16");
    const durationMs = Number(options.durationMs ?? 75_000);
    const targetCount = Number(options.targetCount ?? 3);
    if (ratio !== "9:16") invalid("invalid_product_ratio");
    if (!Number.isInteger(durationMs) || durationMs < 60_000 || durationMs > 90_000) invalid("invalid_product_duration");
    if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 3) invalid("invalid_limit");
    const result = await controller.createOneClickProject(
      String(payload.name ?? "商品展示一键成片").slice(0, 100),
      assetIds,
      {
        brief: options.brief && typeof options.brief === "object" ? options.brief : {},
        ratio,
        durationMs,
        targetCount,
        coverMode: String(options.coverMode ?? "ai_generate"),
        bgmAssetId: options.bgmAssetId == null ? null : validateId(options.bgmAssetId, "asset")
      }
    );
    return camelizePublic(result);
  });
  handle(CONTENT_ENGINE_CHANNELS.createAutoMixV2, async (payload, event) => {
    assertKeys(payload, new Set([
      "specVersion", "assetIds", "title", "copyFramework",
      "guidedSessionId", "scriptRevision", "clickToken"
    ]));
    requireTrustedAutoMixClick(
      event,
      payload.clickToken,
      CONTENT_ENGINE_CHANNELS.createAutoMixV2
    );
    if (payload.specVersion !== "2") invalid("unsupported_auto_mix_spec");
    const fields = new Set(Object.keys(payload).filter((key) => key !== "clickToken"));
    const guidedFields = new Set(["specVersion", "guidedSessionId", "scriptRevision"]);
    const legacyFields = new Set(["specVersion", "assetIds", "title", "copyFramework"]);
    const sameFields = (left, right) => left.size === right.size && [...left].every((item) => right.has(item));
    let result;
    if (sameFields(fields, guidedFields)) {
      const scriptRevision = Number(payload.scriptRevision);
      if (!Number.isInteger(scriptRevision) || scriptRevision < 1 || scriptRevision > 1_000_000) {
        invalid("invalid_guided_auto_mix_script_revision");
      }
      result = await controller.createAutoMixV2({
        specVersion: "2",
        guidedSessionId: validateId(payload.guidedSessionId, "guided_auto_mix_session"),
        scriptRevision
      });
    } else if (sameFields(fields, legacyFields)) {
      if (!Array.isArray(payload.assetIds) || payload.assetIds.length < 1 || payload.assetIds.length > 120) {
        invalid("invalid_auto_mix_assets");
      }
      const assetIds = [...new Set(
        payload.assetIds.map((item) => validateId(item, "asset"))
      )];
      result = await controller.createAutoMixV2({
        specVersion: "2",
        assetIds,
        title: validateText(payload.title, 100, "auto_mix_title_missing"),
        copyFramework: validateText(
          payload.copyFramework,
          2_400,
          "auto_mix_copy_framework_missing"
        )
      });
    } else {
      invalid("auto_mix_v2_fields_missing");
    }
    return publicAutoMixPlanV2(result);
  });
  handle(CONTENT_ENGINE_CHANNELS.prepareGuidedAutoMixV2, async (payload, event) => {
    assertKeys(payload, new Set(["assetIds", "clickToken"]));
    requireTrustedAutoMixClick(
      event,
      payload.clickToken,
      CONTENT_ENGINE_CHANNELS.prepareGuidedAutoMixV2
    );
    if (!Array.isArray(payload.assetIds) || payload.assetIds.length < 1 || payload.assetIds.length > 120) {
      invalid("invalid_auto_mix_assets");
    }
    const assetIds = [...new Set(
      payload.assetIds.map((item) => validateId(item, "asset"))
    )];
    return publicGuidedAutoMixSession(
      await controller.prepareGuidedAutoMixV2(assetIds)
    );
  });
  handle(CONTENT_ENGINE_CHANNELS.getGuidedAutoMixSessionV2, async (payload) => {
    assertKeys(payload, new Set(["sessionId", "taskId"]));
    const hasSessionId = payload.sessionId !== undefined && payload.sessionId !== null;
    const hasTaskId = payload.taskId !== undefined && payload.taskId !== null;
    if (hasSessionId === hasTaskId) invalid("guided_auto_mix_lookup_invalid");
    return publicGuidedAutoMixSession(
      await controller.getGuidedAutoMixSessionV2(hasSessionId
        ? { sessionId: validateId(payload.sessionId, "guided_auto_mix_session") }
        : { taskId: validateId(payload.taskId, "task") })
    );
  });
  handle(CONTENT_ENGINE_CHANNELS.generateGuidedAutoMixScriptV2, async (payload, event) => {
    assertKeys(payload, new Set(["sessionId", "analysisTaskId", "title", "answers", "clickToken"]));
    requireTrustedAutoMixClick(
      event,
      payload.clickToken,
      CONTENT_ENGINE_CHANNELS.generateGuidedAutoMixScriptV2
    );
    const suppliedSessionId = validateId(payload.sessionId, "guided_auto_mix_session");
    const analysisTaskId = payload.analysisTaskId == null
      ? null
      : validateId(payload.analysisTaskId, "task");
    let sessionId = suppliedSessionId;
    if (analysisTaskId) {
      const resolved = await controller.getGuidedAutoMixSessionV2({ taskId: analysisTaskId });
      const resolvedSessionId = String(
        resolved?.session_id || resolved?.sessionId || ""
      );
      if (!resolvedSessionId) invalid("guided_auto_mix_session_not_found");
      sessionId = validateId(resolvedSessionId, "guided_auto_mix_session");
    }
    return publicGuidedAutoMixSession(
      await controller.generateGuidedAutoMixScriptV2(
        {
          sessionId,
          title: validateText(payload.title, 100, "guided_auto_mix_title_missing"),
          answers: validateGuidedAutoMixAnswers(payload.answers)
        }
      )
    );
  });
  handle(CONTENT_ENGINE_CHANNELS.getGuidedAutoMixSupplementalImageV2, async (payload) => {
    assertKeys(payload, new Set(["sessionId", "scriptRevision"]));
    const scriptRevision = Number(payload.scriptRevision);
    if (!Number.isInteger(scriptRevision) || scriptRevision < 1 || scriptRevision > 1_000_000) {
      invalid("invalid_guided_auto_mix_script_revision");
    }
    return publicGuidedAutoMixSupplementalImage(
      await controller.getGuidedAutoMixSupplementalImageV2({
        sessionId: validateId(payload.sessionId, "guided_auto_mix_session"),
        scriptRevision
      })
    );
  });
  handle(CONTENT_ENGINE_CHANNELS.createGuidedAutoMixSupplementalImageV2, async (payload, event) => {
    assertKeys(payload, new Set(["sessionId", "scriptRevision", "draftHash", "confirmPaidCalls", "clickToken"]));
    requireTrustedAutoMixClick(
      event,
      payload.clickToken,
      CONTENT_ENGINE_CHANNELS.createGuidedAutoMixSupplementalImageV2
    );
    const scriptRevision = Number(payload.scriptRevision);
    if (!Number.isInteger(scriptRevision) || scriptRevision < 1 || scriptRevision > 1_000_000) {
      invalid("invalid_guided_auto_mix_script_revision");
    }
    const draftHash = String(payload.draftHash || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(draftHash)) invalid("invalid_guided_auto_mix_draft_hash");
    if (payload.confirmPaidCalls !== true) invalid("guided_auto_mix_supplemental_image_confirmation_required");
    return publicGuidedAutoMixSupplementalImage(
      await controller.createGuidedAutoMixSupplementalImageV2({
        sessionId: validateId(payload.sessionId, "guided_auto_mix_session"),
        scriptRevision,
        draftHash,
        confirmPaidCalls: true
      })
    );
  });
  handle(CONTENT_ENGINE_CHANNELS.getAutoMixPlanV2, async (payload) => {
    assertKeys(payload, new Set(["projectId", "runId"]));
    const hasProjectId = payload.projectId !== undefined && payload.projectId !== null;
    const hasRunId = payload.runId !== undefined && payload.runId !== null;
    if (hasProjectId === hasRunId) invalid("invalid_params");
    let runId;
    if (hasRunId) {
      const candidate = String(payload.runId || "");
      if (!/^(?:auto_mix_run|run)_[a-f0-9]{32}$/u.test(candidate)) invalid("invalid_id");
      runId = candidate;
    }
    const result = await controller.getAutoMixPlanV2(hasProjectId
      ? { projectId: validateId(payload.projectId, "creative_project") }
      : { runId });
    return publicAutoMixPlanV2(result);
  });
  handle(CONTENT_ENGINE_CHANNELS.regenerateAutoMixLayer, async (payload, event) => {
    assertKeys(payload, new Set(["projectId", "expectedRunId", "layer", "clickToken"]));
    requireTrustedAutoMixClick(
      event,
      payload.clickToken,
      CONTENT_ENGINE_CHANNELS.regenerateAutoMixLayer
    );
    const layer = String(payload.layer || "");
    if (!AUTO_MIX_V2_LAYERS.has(layer)) invalid("invalid_auto_mix_layer");
    const expectedRunId = payload.expectedRunId == null || payload.expectedRunId === ""
      ? undefined
      : String(payload.expectedRunId || "");
    if (expectedRunId && !/^(?:auto_mix_run|run)_[a-f0-9]{32}$/u.test(expectedRunId)) {
      invalid("invalid_id");
    }
    return publicAutoMixPlanV2(await controller.regenerateAutoMixLayer(
      validateId(payload.projectId, "creative_project"),
      layer,
      expectedRunId
    ));
  });
  handle(CONTENT_ENGINE_CHANNELS.importMusicCatalogTrack, async (payload, event) => {
    assertKeys(payload, MUSIC_IMPORT_FIELDS, "invalid_music_track_fields");
    requireTrustedAutoMixClick(
      event,
      payload.clickToken,
      CONTENT_ENGINE_CHANNELS.importMusicCatalogTrack
    );
    const audioSelection = await openDialog(
      ["openFile"],
      [{ name: "授权音乐", extensions: ["wav", "mp3", "m4a", "aac", "flac", "ogg"] }],
      "选择要导入的授权音乐"
    );
    if (audioSelection.canceled || audioSelection.filePaths.length !== 1) {
      throw Object.assign(new Error("dialog cancelled"), {
        code: "CONTENT_DIALOG_CANCELLED"
      });
    }
    const sourcePath = validateMusicImportFile(audioSelection.filePaths[0], {
      required: true,
      audio: true,
      maxBytes: MAX_MUSIC_AUDIO_BYTES
    });
    const displayName = validateText(
      payload.displayName,
      160,
      "music_display_name_missing"
    );
    const source = validateText(payload.source, 160, "music_source_missing");
    const commercialScope = validateText(
      payload.commercialScope,
      240,
      "music_commercial_scope_missing"
    );
    if (typeof payload.commercialUseAllowed !== "boolean") {
      invalid("music_commercial_entitlement_invalid");
    }
    const commercialUseAllowed = payload.commercialUseAllowed;
    const licenseStatus = String(payload.licenseStatus || "unknown");
    if (!MUSIC_LICENSE_STATUSES.has(licenseStatus)) {
      invalid("music_license_status_invalid");
    }
    let expiresAt = null;
    if (payload.expiresAt !== undefined && payload.expiresAt !== null && payload.expiresAt !== "") {
      if (typeof payload.expiresAt !== "string" || payload.expiresAt.length > 64) {
        invalid("music_license_expiry_invalid");
      }
      expiresAt = safeText(payload.expiresAt, 64).trim();
      const expiresAtMs = Date.parse(expiresAt);
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(expiresAt)
        || !Number.isFinite(expiresAtMs)
        || new Date(expiresAtMs).toISOString() !== expiresAt
        || (licenseStatus === "valid" && expiresAtMs <= Date.now())
      ) {
        invalid("music_license_expiry_invalid");
      }
    }
    let credentialReference = "";
    if (payload.credentialReference !== undefined && payload.credentialReference !== null) {
      if (typeof payload.credentialReference !== "string" || payload.credentialReference.length > 240) {
        invalid("music_license_evidence_missing");
      }
      credentialReference = safeText(payload.credentialReference, 240).trim();
    }
    let evidencePath = "";
    if (licenseStatus === "valid") {
      const evidenceSelection = await openDialog(
        ["openFile"],
        undefined,
        "选择音乐授权证据"
      );
      if (evidenceSelection.canceled || evidenceSelection.filePaths.length !== 1) {
        throw Object.assign(new Error("dialog cancelled"), {
          code: "CONTENT_DIALOG_CANCELLED"
        });
      }
      evidencePath = validateMusicImportFile(evidenceSelection.filePaths[0], {
        required: true,
        maxBytes: MAX_MUSIC_EVIDENCE_BYTES
      });
    }
    if (licenseStatus === "valid" && (!credentialReference || !evidencePath)) {
      invalid("music_license_evidence_missing");
    }
    let bpm = null;
    if (payload.bpm !== undefined && payload.bpm !== null) {
      if (!Number.isInteger(payload.bpm) || payload.bpm < 20 || payload.bpm > 300) {
        invalid("music_bpm_invalid");
      }
      bpm = payload.bpm;
    }
    if (!Array.isArray(payload.moods) || payload.moods.length > 12) {
      invalid("music_moods_invalid");
    }
    const moods = [...new Set(payload.moods.map((item) =>
      validateText(item, 40, "music_moods_invalid")
    ))];
    const energy = Number(payload.energy);
    if (typeof payload.energy !== "number" || !Number.isFinite(energy) || energy < 0 || energy > 1) {
      invalid("music_energy_invalid");
    }
    const loopStartMs = payload.loopStartMs === undefined || payload.loopStartMs === null
      ? null
      : payload.loopStartMs;
    const loopEndMs = payload.loopEndMs === undefined || payload.loopEndMs === null
      ? null
      : payload.loopEndMs;
    if (
      (loopStartMs === null) !== (loopEndMs === null)
      || (loopStartMs !== null && (
        !Number.isSafeInteger(loopStartMs)
        || !Number.isSafeInteger(loopEndMs)
        || loopStartMs < 0
        || loopEndMs <= loopStartMs
      ))
    ) {
      invalid("music_loop_invalid");
    }
    return publicMusicCatalogTrack(await controller.importMusicCatalogTrack({
      sourcePath,
      displayName,
      source,
      commercialScope,
      commercialUseAllowed,
      licenseStatus,
      expiresAt,
      credentialReference,
      evidencePath,
      bpm,
      moods,
      energy,
      loopStartMs,
      loopEndMs
    }));
  });
  handle(CONTENT_ENGINE_CHANNELS.listMusicCatalogTracks, async (payload) => {
    assertKeys(payload, new Set());
    const result = await controller.listMusicCatalogTracks();
    return {
      items: Array.isArray(result?.items)
        ? result.items.slice(0, 500).map(publicMusicCatalogTrack)
        : []
    };
  });
  handle(CONTENT_ENGINE_CHANNELS.listAutoMixVoicePersonas, async (payload) => {
    assertKeys(payload, new Set());
    const result = await controller.listAutoMixVoicePersonas();
    return {
      items: Array.isArray(result?.items)
        ? result.items.slice(0, 100).map(publicAutoMixVoicePersona).filter(Boolean)
        : []
    };
  });
  handle(CONTENT_ENGINE_CHANNELS.designAutoMixVoicePersona, async (payload, event) => {
    assertKeys(payload, new Set(["voicePersonaId", "clickToken"]));
    requireTrustedAutoMixClick(
      event,
      payload.clickToken,
      CONTENT_ENGINE_CHANNELS.designAutoMixVoicePersona
    );
    const voicePersonaId = validateVoicePersonaId(payload.voicePersonaId);
    auditionedAutoMixVoicePersonas.delete(voicePersonaId);
    return publicAutoMixVoicePersona(
      await controller.designAutoMixVoicePersona(voicePersonaId)
    );
  });
  handle(CONTENT_ENGINE_CHANNELS.previewAutoMixVoicePersona, async (payload, event) => {
    assertKeys(payload, new Set(["voicePersonaId", "clickToken"]));
    requireTrustedAutoMixClick(
      event,
      payload.clickToken,
      CONTENT_ENGINE_CHANNELS.previewAutoMixVoicePersona
    );
    const voicePersonaId = validateVoicePersonaId(payload.voicePersonaId);
    const preview = publicAutoMixVoicePreview(
      await controller.previewAutoMixVoicePersona(voicePersonaId)
    );
    if (
      preview.previewStatus === "completed"
      && preview.audioDataUrl
      && preview.voicePersona?.voicePersonaId === voicePersonaId
    ) {
      auditionedAutoMixVoicePersonas.add(voicePersonaId);
    }
    return preview;
  });
  handle(CONTENT_ENGINE_CHANNELS.approveAutoMixVoicePersona, async (payload, event) => {
    assertKeys(payload, new Set(["voicePersonaId", "clickToken"]));
    requireTrustedAutoMixClick(
      event,
      payload.clickToken,
      CONTENT_ENGINE_CHANNELS.approveAutoMixVoicePersona
    );
    const voicePersonaId = validateVoicePersonaId(payload.voicePersonaId);
    if (!auditionedAutoMixVoicePersonas.has(voicePersonaId)) {
      invalid("auto_mix_voice_preview_required");
    }
    auditionedAutoMixVoicePersonas.delete(voicePersonaId);
    return publicAutoMixVoicePersona(
      await controller.approveAutoMixVoicePersona(voicePersonaId)
    );
  });
  handle(CONTENT_ENGINE_CHANNELS.analyzeProductAssets, async (payload) => {
    assertKeys(payload, new Set(["projectId"]));
    const result = await controller.analyzeProductAssets(validateId(payload.projectId, "creative_project"));
    return publicTask(result);
  });
  handle(CONTENT_ENGINE_CHANNELS.generateProductCopy, async (payload) => {
    assertKeys(payload, new Set(["projectId", "brief"]));
    const result = await controller.generateProductCopy(
      validateId(payload.projectId, "creative_project"),
      payload.brief && typeof payload.brief === "object" ? payload.brief : {}
    );
    return publicTask(result);
  });
  handle(CONTENT_ENGINE_CHANNELS.generateProductVoice, async (payload) => {
    assertKeys(payload, new Set(["projectId", "scriptId"]));
    const result = await controller.generateProductVoice(
      validateId(payload.projectId, "creative_project"),
      payload.scriptId == null ? null : String(payload.scriptId)
    );
    return publicTask(result);
  });
  handle(CONTENT_ENGINE_CHANNELS.generateOneClickCandidates, async (payload) => {
    assertKeys(payload, new Set(["projectId", "options"]));
    const options = payload.options == null ? {} : payload.options;
    if (!options || typeof options !== "object" || Array.isArray(options)) invalid("invalid_params");
    const targetCount = Number(options.targetCount ?? 3);
    const durationMs = Number(options.durationMs ?? 75_000);
    if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 3) invalid("invalid_limit");
    if (!Number.isInteger(durationMs) || durationMs < 60_000 || durationMs > 90_000) invalid("invalid_product_duration");
    const result = await controller.generateOneClickCandidates(
      validateId(payload.projectId, "creative_project"),
      { targetCount, durationMs, coverMode: String(options.coverMode ?? "ai_generate") }
    );
    return publicTask(result);
  });
  handle(CONTENT_ENGINE_CHANNELS.listOneClickCandidates, async (payload) => {
    assertKeys(payload, new Set(["projectId", "limit"]));
    const limit = Number(payload.limit ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid("invalid_limit");
    const result = await controller.listOneClickCandidates(validateId(payload.projectId, "creative_project"), limit);
    return {
      workflow: "product_one_click",
      items: (result?.items || []).map(publicGeneratedVideo)
    };
  });
  handle(CONTENT_ENGINE_CHANNELS.listPackagingPresets, async (payload) => {
    assertKeys(payload, new Set(["kind"]));
    const kind = payload.kind == null ? undefined : String(payload.kind);
    if (kind !== undefined && !PACKAGING_KINDS.has(kind)) invalid("invalid_packaging_kind");
    const result = await controller.listPackagingPresets(kind);
    return { items: (result?.items || []).map(publicPackagingPreset) };
  });
  handle(CONTENT_ENGINE_CHANNELS.listBrandProfiles, async (payload) => {
    assertKeys(payload, new Set());
    const result = await controller.listBrandProfiles();
    return { items: (result?.items || []).map(publicBrandProfile) };
  });
  handle(CONTENT_ENGINE_CHANNELS.saveBrandProfile, async (payload) => {
    assertKeys(payload, new Set([
      "brandProfileId", "name", "logoAssetId", "primaryColor", "accentColor",
      "fontPreset", "referenceAssetId", "outroText"
    ]));
    const primaryColor = String(payload.primaryColor || "");
    const accentColor = String(payload.accentColor || "");
    if (!/^#[0-9a-f]{6}$/i.test(primaryColor) || !/^#[0-9a-f]{6}$/i.test(accentColor)) {
      invalid("invalid_brand_color");
    }
    const fontPreset = String(payload.fontPreset || "microsoft_yahei");
    if (!FONT_PRESETS.has(fontPreset)) invalid("invalid_font_preset");
    const profile = await controller.saveBrandProfile({
      brand_profile_id: validateOptionalId(payload.brandProfileId, "brand_profile"),
      name: validateText(payload.name, 80, "invalid_brand_name"),
      logo_asset_id: validateOptionalId(payload.logoAssetId, "asset"),
      primary_color: primaryColor.toUpperCase(),
      accent_color: accentColor.toUpperCase(),
      font_preset: fontPreset,
      reference_portrait_asset_id: validateOptionalId(payload.referenceAssetId, "asset"),
      outro_text: payload.outroText == null || payload.outroText === ""
        ? ""
        : validateText(payload.outroText, 60, "invalid_outro_text")
    });
    return publicBrandProfile(profile);
  });
  handle(CONTENT_ENGINE_CHANNELS.getPackagingCostEstimate, async (payload) => {
    assertKeys(payload, new Set(["candidateIds", "coverMode", "plannedCount", "packagingMode", "assetIds", "generationKind"]));
    const coverMode = String(payload.coverMode || "ai_generate");
    if (!COVER_MODES.has(coverMode) || coverMode === "reuse") invalid("invalid_cover_mode");
    const packagingMode = payload.packagingMode == null
      ? undefined
      : String(payload.packagingMode);
    if (packagingMode !== undefined && !PACKAGING_MODES.has(packagingMode)) {
      invalid("invalid_packaging_mode");
    }
    if (packagingMode === "none" && coverMode !== "none") invalid("invalid_cover_mode");
    const candidateIds = Array.isArray(payload.candidateIds)
      ? [...new Set(payload.candidateIds.map((item) => validateId(item, "generated_video")))]
      : [];
    if (candidateIds.length > 300) invalid("invalid_generated_video_ids");
    const plannedCount = payload.plannedCount == null ? undefined : Number(payload.plannedCount);
    if (plannedCount !== undefined
      && (!Number.isInteger(plannedCount) || plannedCount < 1 || plannedCount > 300)) {
      invalid("invalid_limit");
    }
    if (!candidateIds.length && plannedCount === undefined) invalid("invalid_generated_video_ids");
    const assetIds = payload.assetIds == null
      ? undefined
      : [...new Set(payload.assetIds.map((item) => validateId(item, "asset")))];
    if (assetIds && assetIds.length > 500) invalid("invalid_asset_ids");
    const generationKind = payload.generationKind == null ? undefined : String(payload.generationKind);
    if (generationKind !== undefined && !new Set(["course", "mix", "repackage"]).has(generationKind)) {
      invalid("invalid_generation_kind");
    }
    return camelizePublic(await controller.getPackagingCostEstimate(
      candidateIds,
      coverMode,
      plannedCount,
      { assetIds, generationKind }
    ));
  });
  handle(CONTENT_ENGINE_CHANNELS.recordMediaReview, async (payload) => {
    assertKeys(payload, new Set(["candidateId", "device", "verdict", "reason", "reviewer"]));
    const device = String(payload.device || "phone");
    const verdict = String(payload.verdict || "pass");
    if (!new Set(["phone", "desktop"]).has(device)) invalid("invalid_review_device");
    if (!new Set(["pass", "fail"]).has(verdict)) invalid("invalid_review_verdict");
    const result = await controller.recordMediaReview(
      validateId(payload.candidateId, "generated_video"),
      {
        device,
        verdict,
        reason: payload.reason == null ? "" : validateText(payload.reason, 500, "invalid_review_reason"),
        reviewer: payload.reviewer == null ? "" : validateText(payload.reviewer, 120, "invalid_reviewer")
      }
    );
    return publicMediaReview(result);
  });
  handle(CONTENT_ENGINE_CHANNELS.listMediaReviews, async (payload) => {
    assertKeys(payload, new Set(["candidateId"]));
    const result = await controller.listMediaReviews(
      validateId(payload.candidateId, "generated_video")
    );
    return { items: (result?.items || []).map(publicMediaReview) };
  });
  handle(CONTENT_ENGINE_CHANNELS.packageGeneratedVideos, async (payload) => {
    assertKeys(payload, new Set([
      "candidateIds", "packagingMode", "packagingPresetId", "brandProfileId",
      "coverMode", "reuseCover"
    ]));
    const optionsForPackaging = validatePackagingOptions(payload, { reuseCoverDefault: true });
    return publicTask(await controller.packageGeneratedVideos(
      validateGeneratedVideoIds(payload.candidateIds),
      optionsForPackaging
    ));
  });
  handle(CONTENT_ENGINE_CHANNELS.repackageVideo, async (payload) => {
    assertKeys(payload, new Set([
      "candidateId", "packagingMode", "packagingPresetId", "brandProfileId",
      "coverMode", "reuseCover"
    ]));
    const optionsForPackaging = validatePackagingOptions(payload, { reuseCoverDefault: true });
    return publicTask(await controller.repackageVideo(
      validateId(payload.candidateId, "generated_video"),
      optionsForPackaging
    ));
  });
  handle(CONTENT_ENGINE_CHANNELS.preflightVisualComparison, async (payload) => {
    assertKeys(payload, new Set(["candidateId"]));
    return publicVisualComparisonPreflight(
      await controller.preflightVisualComparison(
        validateId(payload.candidateId, "generated_video")
      )
    );
  });
  handle(CONTENT_ENGINE_CHANNELS.createVisualComparisonTask, async (payload) => {
    assertKeys(payload, new Set(["candidateId"]));
    return publicTask(
      await controller.createVisualComparisonTask(
        validateId(payload.candidateId, "generated_video")
      )
    );
  });
  handle(CONTENT_ENGINE_CHANNELS.regenerateCover, async (payload) => {
    assertKeys(payload, new Set(["candidateId"]));
    return publicTask(await controller.regenerateCover(
      validateId(payload.candidateId, "generated_video")
    ));
  });
  handle(CONTENT_ENGINE_CHANNELS.getCreativeProject, async (payload) => {
    assertKeys(payload, new Set(["projectId"]));
    return publicCreativeProject(await controller.getCreativeProject(
      validateId(payload.projectId, "creative_project")
    ));
  });
  handle(CONTENT_ENGINE_CHANNELS.listGeneratedVideos, async (payload) => {
    assertKeys(payload, new Set(["projectId", "status", "limit"]));
    const result = await controller.listGeneratedVideos({
      projectId: payload.projectId == null
        ? undefined
        : validateId(payload.projectId, "creative_project"),
      status: payload.status == null ? undefined : String(payload.status),
      limit: validateLimit(payload.limit, 500)
    });
    return { items: (result?.items || []).map(publicGeneratedVideo) };
  });
  handle(CONTENT_ENGINE_CHANNELS.regenerateVideo, async (payload) => {
    assertKeys(payload, new Set(["candidateId"]));
    const result = await controller.regenerateVideo(
      validateId(payload.candidateId, "generated_video")
    );
    return camelizePublic({
      task_id: result?.task_id,
      generated_video_id: result?.generated_video_id
    });
  });
  handle(CONTENT_ENGINE_CHANNELS.rejectGeneratedVideo, async (payload) => {
    assertKeys(payload, new Set(["candidateId"]));
    return publicGeneratedVideo(await controller.rejectGeneratedVideo(
      validateId(payload.candidateId, "generated_video")
    ));
  });
  handle(CONTENT_ENGINE_CHANNELS.queueGeneratedVideos, async (payload) => {
    assertKeys(payload, new Set(["candidateIds", "channel"]));
    const candidateIds = validateGeneratedVideoIds(payload.candidateIds);
    const channel = String(payload.channel || "internal");
    if (!new Set(["internal", "wechat", "douyin", "kuaishou"]).has(channel)) {
      invalid("invalid_channel");
    }
    const result = await controller.queueGeneratedVideos(candidateIds, channel);
    return camelizePublic(result);
  });
  handle(CONTENT_ENGINE_CHANNELS.generatedMediaUrl, async (payload) => {
    assertKeys(payload, new Set(["candidateId", "variant"]));
    const candidateId = validateId(payload.candidateId, "generated_video");
    const variant = payload.variant === "thumbnail" ? "thumbnail" : "video";
    await controller.resolveGeneratedVideoPath(candidateId, variant);
    return { url: `xiaoxi-content://generated/${candidateId}/${variant}` };
  });
    for (const [channel, operation] of [
      [CONTENT_ENGINE_CHANNELS.openGeneratedVideo, "open"],
      [CONTENT_ENGINE_CHANNELS.exportCandidate, "open"],
      [CONTENT_ENGINE_CHANNELS.revealGeneratedVideo, "reveal"]
  ]) {
    handle(channel, async (payload) => {
      assertKeys(payload, new Set(["candidateId"]));
      const candidateId = validateId(payload.candidateId, "generated_video");
      const result = await controller.resolveGeneratedVideoPath(candidateId, "video");
      if (result?.generated_video_id !== candidateId) invalid("CONTENT_ENGINE_RESPONSE_INVALID");
      const trustedPath = resolvedAbsolutePath(result);
      if (operation === "open") {
        const shellError = await shell.openPath(trustedPath);
        if (shellError) invalid("CONTENT_ENGINE_OPEN_FAILED");
      } else {
        shell.showItemInFolder(trustedPath);
      }
        return { candidateId };
      });
    }
    handle(CONTENT_ENGINE_CHANNELS.downloadCandidate, async (payload) => {
      assertKeys(payload, new Set(["candidateId"]));
      const candidateId = validateId(payload.candidateId, "generated_video");
      const result = await controller.resolveGeneratedVideoPath(candidateId, "video");
      if (result?.generated_video_id !== candidateId) invalid("CONTENT_ENGINE_RESPONSE_INVALID");
      const trustedPath = resolvedAbsolutePath(result);
      return {
        candidateId,
        ...(await saveVideoToChosenLocation(trustedPath))
      };
    });

  async function saveVideoToChosenLocation(trustedPath) {
    const downloadsDirectory = typeof app?.getPath === "function"
      ? app.getPath("downloads")
      : undefined;
    const defaultPath = downloadsDirectory
      ? path.join(downloadsDirectory, safeVideoFilename(path.basename(trustedPath)))
      : safeVideoFilename(path.basename(trustedPath));
    const selected = await saveDialog(
      defaultPath,
      [{ name: "MP4 视频", extensions: ["mp4"] }],
      "保存成片"
    );
    if (selected?.canceled || !selected?.filePath) {
      return { canceled: true };
    }
    let destination = String(selected.filePath);
    if (!path.isAbsolute(destination)) invalid("CONTENT_ENGINE_DOWNLOAD_PATH_INVALID");
    if (!destination.toLowerCase().endsWith(".mp4")) destination += ".mp4";
    if (path.resolve(destination).toLowerCase() === trustedPath.toLowerCase()) {
      invalid("CONTENT_ENGINE_DOWNLOAD_SOURCE");
    }
    try {
      await fs.promises.copyFile(trustedPath, destination);
    } catch {
      invalid("CONTENT_ENGINE_DOWNLOAD_FAILED");
    }
    return { canceled: false, filename: path.basename(destination) };
  }

  function saveDialog(defaultPath, filters, title) {
    const window = getMainWindow();
    const dialogOptions = {
      title,
      defaultPath,
      properties: ["showOverwriteConfirmation"],
      filters
    };
    return window && !window.isDestroyed()
      ? dialog.showSaveDialog(window, dialogOptions)
      : dialog.showSaveDialog(dialogOptions);
  }
  handle(CONTENT_ENGINE_CHANNELS.createMixProject, async (payload) => {
    assertKeys(payload, new Set(["name", "slots", "constraints"]));
    return publicMixProject(await controller.createMixProject(
      validateText(payload.name, 200, "invalid_name"),
      validateSlots(payload.slots),
      validateConstraints(payload.constraints)
    ));
  });
  handle(CONTENT_ENGINE_CHANNELS.updateMixProject, async (payload) => {
    assertKeys(payload, new Set(["projectId", "name", "slots", "constraints"]));
    const changes = {};
    if (payload.name !== undefined) {
      changes.name = validateText(payload.name, 200, "invalid_name");
    }
    if (payload.slots !== undefined) changes.slots = validateSlots(payload.slots);
    if (payload.constraints !== undefined) {
      changes.constraints = validateConstraints(payload.constraints);
    }
    if (Object.keys(changes).length === 0) invalid("invalid_params");
    return publicMixProject(await controller.updateMixProject(
      validateId(payload.projectId, "mix_project"),
      changes
    ));
  });
  handle(CONTENT_ENGINE_CHANNELS.getMixProject, async (payload) => {
    assertKeys(payload, new Set(["projectId"]));
    return publicMixProject(await controller.getMixProject(
      validateId(payload.projectId, "mix_project")
    ));
  });
  handle(CONTENT_ENGINE_CHANNELS.listMixProjects, async (payload) => {
    assertKeys(payload, new Set(["limit"]));
    const result = await controller.listMixProjects(validateLimit(payload.limit, 500));
    return { items: (result?.items || []).map(publicMixProject) };
  });
  handle(CONTENT_ENGINE_CHANNELS.calculateMixCombinations, async (payload) => {
    assertKeys(payload, new Set(["projectId"]));
    const result = await controller.calculateMixCombinations(
      validateId(payload.projectId, "mix_project")
    );
    return camelizePublic({
      project_id: result?.project_id,
      raw_cartesian_count: result?.raw_cartesian_count,
      combination_count: result?.combination_count,
      count_is_exact: result?.count_is_exact,
      count_status: result?.count_status,
      constraints_applied: result?.constraints_applied
    });
  });
  handle(CONTENT_ENGINE_CHANNELS.generateMixCandidates, async (payload) => {
    assertKeys(payload, new Set(["projectId", "limit", "seed"]));
    const result = await controller.generateMixCandidates(
      validateId(payload.projectId, "mix_project"),
      { limit: validateLimit(payload.limit, 20), seed: validateSeed(payload.seed) }
    );
    return {
      projectId: safeText(result?.project_id, 80),
      seed: safePublicText(result?.seed, 200),
      items: (result?.items || []).map(publicMixCandidate),
      assetUsageCounts: camelizePublic(result?.asset_usage_counts || {}),
      generationStats: camelizePublic(result?.generation_stats || {})
    };
  });
  handle(CONTENT_ENGINE_CHANNELS.listMixCandidates, async (payload) => {
    assertKeys(payload, new Set(["projectId", "reviewStatus", "limit"]));
    const reviewStatus = payload.reviewStatus === undefined
      ? undefined
      : String(payload.reviewStatus);
    if (reviewStatus && !REVIEW_STATUSES.has(reviewStatus)) invalid("invalid_review_status");
    const result = await controller.listMixCandidates({
      projectId: payload.projectId === undefined
        ? undefined
        : validateId(payload.projectId, "mix_project"),
      reviewStatus,
      limit: validateLimit(payload.limit, 500)
    });
    return { items: (result?.items || []).map(publicMixCandidate) };
  });
  handle(CONTENT_ENGINE_CHANNELS.reviewMixCandidate, async (payload) => {
    assertKeys(payload, new Set(["candidateId", "reviewStatus", "reviewNote"]));
    const reviewStatus = String(payload.reviewStatus || "");
    if (!REVIEW_DECISIONS.has(reviewStatus)) invalid("invalid_review_status");
    const reviewNote = validateText(
      payload.reviewNote,
      500,
      "invalid_review_note",
      true
    );
    return publicMixCandidate(await controller.reviewMixCandidate(
      validateId(payload.candidateId, "mix_candidate"),
      reviewStatus,
      reviewNote
    ));
  });
  handle(CONTENT_ENGINE_CHANNELS.listPublishQueue, async (payload) => {
    assertKeys(payload, new Set(["status", "limit"]));
    const status = payload.status === undefined ? undefined : String(payload.status);
    if (status && !PUBLISH_STATUSES.has(status)) invalid("invalid_publish_status");
    const result = await controller.listPublishQueue({
      status,
      limit: validateLimit(payload.limit, 500)
    });
    return { items: (result?.items || []).map(publicQueueItem) };
  });
  handle(CONTENT_ENGINE_CHANNELS.updatePublishQueueItem, async (payload) => {
    assertKeys(payload, new Set(["queueItemId", "status", "errorMessage"]));
    const status = String(payload.status || "");
    if (!PUBLISH_STATUSES.has(status)) invalid("invalid_publish_status");
    const errorMessage = validateText(
      payload.errorMessage,
      500,
      "invalid_error_message",
      true
    );
    return publicQueueItem(await controller.updatePublishQueueItem(
      validateId(payload.queueItemId, "publish_queue"),
      status,
      errorMessage
    ));
  });
  handle(CONTENT_ENGINE_CHANNELS.renderMixCandidate, async (payload) => {
    assertKeys(payload, new Set(["candidateId", "platforms", "title", "description"]));
    const platforms = payload.platforms === undefined
      ? undefined
      : Array.isArray(payload.platforms)
        ? [...new Set(payload.platforms.map((item) => String(item || "")))]
        : invalid("invalid_platforms");
    if (platforms && (!platforms.length || platforms.some((item) => !EXPORT_PLATFORMS.has(item)))) {
      invalid("invalid_platforms");
    }
    return publicExportPackage(await controller.renderMixCandidate(
      validateId(payload.candidateId, "mix_candidate"),
      {
        platforms,
        title: payload.title == null ? undefined : validateText(payload.title, 200, "invalid_title", true),
        description: payload.description == null ? undefined : validateText(payload.description, 2_000, "invalid_description", true)
      }
    ));
  });
  handle(CONTENT_ENGINE_CHANNELS.listExportPackages, async (payload) => {
    assertKeys(payload, new Set(["candidateId", "limit"]));
    const result = await controller.listExportPackages({
      candidateId: payload.candidateId == null
        ? undefined
        : validateId(payload.candidateId, "mix_candidate"),
      limit: validateLimit(payload.limit, 500)
    });
    return { items: (result?.items || []).map(publicExportPackage) };
  });
  for (const [channel, operation] of [
    [CONTENT_ENGINE_CHANNELS.openExportPackage, "open"],
    [CONTENT_ENGINE_CHANNELS.revealExportPackage, "reveal"]
  ]) {
    handle(channel, async (payload) => {
      assertKeys(payload, new Set(["packageId"]));
      const packageId = validateId(payload.packageId, "export_package");
      const resolved = await controller.resolveExportPackagePath(packageId);
      if (resolved?.package_id !== packageId) invalid("CONTENT_ENGINE_RESPONSE_INVALID");
      const trustedDirectory = resolvedAbsoluteDirectory(resolved);
      if (operation === "open") {
        const shellError = await shell.openPath(trustedDirectory);
        if (shellError) invalid("CONTENT_ENGINE_OPEN_FAILED");
      } else {
        shell.showItemInFolder(trustedDirectory);
      }
      return { packageId };
    });
  }

  const unsubscribe = controller.onUpdate((status) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return;
    try {
      window.webContents.send(
        CONTENT_ENGINE_CHANNELS.update,
        publicStatus(status)
      );
    } catch {
      // Window teardown races must not affect the worker.
    }
  });

  return {
    dispose() {
      if (typeof unsubscribe === "function") unsubscribe();
    }
  };
}

module.exports = {
  CONTENT_ENGINE_CHANNELS,
  publicAsset,
  publicError,
  publicFinished,
  publicMixCandidate,
  publicMixProject,
  publicAutoMixPlanV2,
  publicMusicCatalogTrack,
  publicExportPackage,
  publicQueueItem,
  publicStatus,
  publicTask,
  registerContentEngineIpc,
  stripPrivateValue
};
