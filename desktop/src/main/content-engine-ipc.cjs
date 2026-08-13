const fs = require("node:fs");
const path = require("node:path");

const CONTENT_ENGINE_CHANNELS = Object.freeze({
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
  settingsStatus: "content-engine:settings-status",
  chooseCacheDirectory: "content-engine:choose-cache-directory",
  updateCacheLimit: "content-engine:update-cache-limit",
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

const PUBLIC_ERRORS = Object.freeze({
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
  CONTENT_ENGINE_CAPABILITY_UNAVAILABLE: "当前内容引擎版本不支持这项操作。",
  capability_unavailable: "媒体分析组件当前不可用，请安装或恢复组件后重试。",
  CONTENT_DIALOG_CANCELLED: "已取消选择。",
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
  method_not_found: "当前内容引擎版本不支持这项操作。",
  internal_error: "内容引擎暂时无法完成操作，请重试。"
});

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
  return {
    taskId: safeText(item.task_id, 80),
    taskType: safePublicText(item.task_type, 64),
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
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
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
  const controller = options.controller;
  const getMainWindow = typeof options.getMainWindow === "function"
    ? options.getMainWindow
    : () => null;

  function handle(channel, operation) {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        return { ok: true, data: await operation(validatePayload(payload)) };
      } catch (error) {
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
    return { items: (result?.items || []).map(publicTask) };
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
  publicExportPackage,
  publicQueueItem,
  publicStatus,
  publicTask,
  registerContentEngineIpc,
  stripPrivateValue
};
