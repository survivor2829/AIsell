const fs = require("node:fs/promises");
const path = require("node:path");
const { constants } = require("node:fs");

const CHANNELS = Object.freeze(Object.fromEntries([
  "collections", "save-collection", "list", "get", "status", "save", "recommend", "scripts", "confirm", "music-preview", "resolve", "samples", "continue", "edit", "export", "open-output", "archive"
].map((name) => [name, `content-engine:batch-${name}`])));
const ERRORS = {
  narrated_audience_required: "请填写这条视频想给谁看。",
  narrated_brief_invalid: "文案未符合创作需求，请查看具体原因并修改。",
  invalid_narrated_selection: "请选择一到三个有效且不重复的文案方向。",
  narrated_settings_changed: "制作设置已改变，请先重新准备文案或新建批次。",
  invalid_collection_name: "请填写素材集名称（100 字以内）。",
  collection_not_found: "素材集不存在，请重新选择。",
  narrated_batch_not_found: "没有找到这个批次。",
  narrated_batch_busy: "当前任务正在执行，请等待完成或暂停。",
  narrated_batch_paused: "请先恢复或取消暂停任务，再修改。",
  invalid_narrated_count: "生成数量必须是 1 到 300 的整数。",
  narrated_samples_not_ready: "请等待样片完成后再继续整批。",
  narrated_candidate_not_found: "没有找到这条方案。",
  narrated_script_not_found: "没有找到这份文案，请重新选择。",
  narrated_script_revision_changed: "这份文案已更新，请阅读最新正文后确认。",
  narrated_script_confirmation_required: "请先选择并确认本批文案。",
  narrated_confirmed_script_changed: "确认稿需要调整，已停止制作。请检查原因并重新确认正文。",
  narrated_music_pool_empty: "请先试听并选入至少一首可用配乐。",
  narrated_caption_timing_insufficient: "语音识别未返回足够细的时间，整句过长，无法清楚排成两行；请改短该段并重新确认。",
  narrated_edit_invalid: "修改后的方案无法通过质量检查，请查看批次详情。",
  cloud_not_configured: "请在火山引擎设置中配置方舟 Key，再使用 AI 分析和文案。",
  narrated_assets_missing: "请先添加素材。",
  narrated_plan_empty: "AI 未返回可用方案，请补充素材或稍后重试。",
  narrated_candidate_invalid: "方案包含无效或重复镜头，请调整。",
  narrated_duplicate: "这条方案与已有作品过于相似，请更换镜头或顺序。",
  narrated_copy_too_long: "口播与可用画面时长不匹配，需要调整内容和镜头。",
  narrated_duration_too_short: "口播或相关镜头不足设定的最短时长，需要补充内容后再制作。",
  invalid_narrated_shots: "请选择当前分析中的有效镜头。",
  invalid_narration: "请填写 2400 字以内的解说。",
  narrated_edit_mismatch: "解说无法对应当前镜头，请缩短解说或更换镜头。",
  narrated_edit_rejected: "修改后的解说和画面未通过复核，请调整。",
  narrated_assets_changed: "素材文件已变更，请重新分析。",
  narrated_analysis_changed: "分析配置已变更，请重新分析。",
  narrated_task_stale: "任务已被新操作替代，请刷新批次。",
  narrated_planning_outcome_unknown: "上次 AI 请求结果未知，已停止自动重复请求，请检查服务记录。",
  narrated_planning_confirmation_required: "请先核对对应平台的服务记录，并勾选确认。",
  narrated_planning_note_required: "请填写本次核对依据（1000 字以内）。",
  invalid_narrated_planning_resolution: "本次核对操作无效，请刷新后重试。",
  narrated_planning_recovery_not_available: "当前批次没有可人工确认并重试的未知请求。"
};
const PUBLIC_FIELDS = new Set(("activity message started_at completed total collections collection_id name description asset_ids batches batch_id project_id title status task_id task_status target_count recommended_count feasible_count count_is_exact reasons completed_count updated_at created_at groups opening middle ending cta settings voice_persona_id brand_profile_id minimum_duration_seconds candidates candidate_id narration angle generated_video_id duration_ms revision error actual_shots shots segment_id asset_id source_start_ms source_end_ms evidence_ref evidence_facts facts subject action quality suggested_brief preferred_groups available_shots progress approved version score rationale phrases text segment_ids role planning_recovery_available").split(" "));
for (const field of "workflow_version script_options selected_script_id script_confirmation script_id confirmed_at audience pain_point estimated_duration_ms direction music_track_ids music_selections music_track_id track_id display_name".split(" ")) PUBLIC_FIELDS.add(field);
for (const field of "material_context script_selections count production_jobs ordinal production_index source_script_id export_ready exported_count export_error production_retry_available".split(" ")) PUBLIC_FIELDS.add(field);
for (const field of "brief_version target_audience expression advantages customer_pain_points brief_suggestions framework summary opening_example".split(" ")) PUBLIC_FIELDS.add(field);
PUBLIC_FIELDS.add("archived");
function publicBatch(value, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.slice(0, 5000).map((item) => publicBatch(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => PUBLIC_FIELDS.has(key)).map(([key, item]) => [key, publicBatch(item, depth + 1)]));
  if (typeof value === "string") return value.slice(0, 12000)
    .replace(/[A-Za-z]:[\\/][^\s"<>]+/g, "[本地文件]")
    .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_-]{12,}/g, "[已隐藏]");
  return value;
}
function registerNarratedBatchIpc({ handle, controller, validateId, validateVoicePersonaId, assertKeys, invalid, openDialog, requireTrustedAutoMixClick, shell }) {
  const keys = (p, allowed) => assertKeys(p, new Set(allowed));
  const id = (value, prefix) => validateId(value, prefix);
  const text = (value, max) => {
    if (value != null && (typeof value !== "string" || value.length > max)) invalid();
    return value || "";
  };
  const ids = (values) => {
    if (!Array.isArray(values) || values.length > 1000) invalid();
    return [...new Set(values.map((v) => id(v, "asset")))];
  };
  function draft(p) {
    keys(p, ["batch_id", "collection_id", "groups", "title", "description", "material_context", "cta", "target_count", "settings", "brief_version", "target_audience", "expression", "advantages", "customer_pain_points"]);
    const result = { ...p };
    if (p.batch_id) result.batch_id = id(p.batch_id, "narrated_batch");
    if (p.collection_id) result.collection_id = id(p.collection_id, "asset_collection");
    keys(p.groups, ["opening", "middle", "ending"]);
    result.groups = Object.fromEntries(["opening", "middle", "ending"].map((key) => [key, ids(p.groups[key] || [])]));
    result.title = text(p.title, 100);
    result.description = text(p.description, 6000);
    if (p.brief_version !== undefined && p.brief_version !== 1) invalid();
    for (const [field, limit] of [["target_audience", 150], ["expression", 4000], ["advantages", 1500], ["customer_pain_points", 1500]]) {
      if (p[field] !== undefined) result[field] = text(p[field], limit).trim();
    }
    if (p.material_context !== undefined) result.material_context = text(p.material_context, 100);
    result.cta = text(p.cta, 300);
    if (p.target_count != null && (!Number.isInteger(p.target_count) || p.target_count < 1 || p.target_count > 300)) invalid("invalid_narrated_count");
    result.settings = soundSettings(p.settings || {});
    return result;
  }
  function soundSettings(value) {
    keys(value, ["voice_persona_id", "brand_profile_id", "minimum_duration_seconds", "workflow_version", "music_track_ids"]);
    const result = { settings: { ...value } };
    if (result.settings.minimum_duration_seconds != null && (!Number.isSafeInteger(result.settings.minimum_duration_seconds) || result.settings.minimum_duration_seconds < 0)) invalid("invalid_narrated_settings");
    if (result.settings.voice_persona_id) validateVoicePersonaId(result.settings.voice_persona_id);
    if (result.settings.brand_profile_id) id(result.settings.brand_profile_id, "brand_profile");
    if (result.settings.workflow_version != null && result.settings.workflow_version !== 2) invalid("invalid_narrated_settings");
    if (result.settings.music_track_ids != null) {
      if (!Array.isArray(result.settings.music_track_ids) || result.settings.music_track_ids.length > 20) invalid("invalid_narrated_settings");
      result.settings = { ...result.settings, music_track_ids: [...new Set(result.settings.music_track_ids.map((value) => id(value, "music_track")))] };
    }
    return result.settings;
  }
  handle(CHANNELS.collections, async () => publicBatch(await controller.listAssetCollections()));
  handle(CHANNELS["save-collection"], async (p) => {
    keys(p, ["collection_id", "name", "description", "asset_ids"]);
    return publicBatch(await controller.saveAssetCollection({
      ...(p.collection_id ? { collection_id: id(p.collection_id, "asset_collection") } : {}),
      name: text(p.name, 100), description: text(p.description, 6000), asset_ids: ids(p.asset_ids)
    }));
  });
  handle(CHANNELS.list, async () => publicBatch(await controller.listNarratedBatches()));
  handle(CHANNELS.archive, async (p) => { keys(p, ["batch_id"]); return publicBatch(await controller.archiveNarratedBatch(id(p.batch_id, "narrated_batch"))); });
  handle(CHANNELS.get, async (p) => { keys(p, ["batch_id"]); return publicBatch(await controller.getNarratedBatch(id(p.batch_id, "narrated_batch"))); });
  handle(CHANNELS.status, async (p) => { keys(p, ["batch_id"]); return publicBatch(await controller.getNarratedBatchStatus(id(p.batch_id, "narrated_batch"))); });
  handle(CHANNELS.save, async (p) => publicBatch(await controller.saveNarratedBatch(draft(p))));
  handle(CHANNELS.resolve, async (p, event) => {
    keys(p, ["batch_id", "provider_log_checked", "resolution", "note", "clickToken"]);
    requireTrustedAutoMixClick(event, p.clickToken, CHANNELS.resolve);
    if (p.provider_log_checked !== true) invalid("narrated_planning_confirmation_required");
    if (p.resolution !== "retry_planning") invalid("invalid_narrated_planning_resolution");
    const note = text(p.note, 1000).trim();
    if (!note) invalid("narrated_planning_note_required");
    return publicBatch(await controller.resolveNarratedPlanningOutcome({
      batch_id: id(p.batch_id, "narrated_batch"),
      provider_log_checked: true,
      resolution: "retry_planning",
      note
    }));
  });
  for (const [action, method] of [["recommend", "recommendNarratedBatch"], ["scripts", "prepareNarratedScripts"], ["samples", "generateNarratedSamples"], ["continue", "continueNarratedBatch"]]) {
    handle(CHANNELS[action], async (p, event) => {
      keys(p, ["batch_id", "draft", "clickToken"]);
      requireTrustedAutoMixClick(event, p.clickToken, CHANNELS[action]);
      const batchId = p.draft ? (await controller.saveNarratedBatch(draft(p.draft))).batch_id : id(p.batch_id, "narrated_batch");
      return publicBatch(await controller[method](batchId));
    });
  }
  handle(CHANNELS.confirm, async (p, event) => {
    keys(p, ["batch_id", "script_id", "revision", "narration", "selections", "settings", "clickToken"]);
    requireTrustedAutoMixClick(event, p.clickToken, CHANNELS.confirm);
    if (p.selections !== undefined) {
      if (p.script_id !== undefined || p.revision !== undefined || p.narration !== undefined
          || !Array.isArray(p.selections) || p.selections.length < 1 || p.selections.length > 3) invalid("invalid_narrated_selection");
      const seen = new Set();
      const selections = p.selections.map((item) => {
        keys(item, ["script_id", "revision", "count"]);
        const scriptId = id(item.script_id, "narrated_candidate");
        if (seen.has(scriptId)) invalid("invalid_narrated_selection");
        seen.add(scriptId);
        if (!Number.isSafeInteger(item.revision) || item.revision < 1) invalid();
        if (!Number.isSafeInteger(item.count) || item.count < 1 || item.count > 300) invalid("invalid_narrated_count");
        return { script_id: scriptId, revision: item.revision, count: item.count };
      });
      if (selections.reduce((total, item) => total + item.count, 0) > 300) invalid("invalid_narrated_count");
      return publicBatch(await controller.confirmNarratedScript({ batch_id: id(p.batch_id, "narrated_batch"), selections,
        ...(p.settings !== undefined ? { settings: soundSettings(p.settings) } : {}) }));
    }
    if (p.settings !== undefined) invalid();
    if (!Number.isSafeInteger(p.revision) || p.revision < 1) invalid();
    return publicBatch(await controller.confirmNarratedScript({
      batch_id: id(p.batch_id, "narrated_batch"), script_id: id(p.script_id, "narrated_candidate"), revision: p.revision,
      ...(p.narration === undefined ? {} : { narration: text(p.narration, 2400) })
    }));
  });
  handle(CHANNELS["open-output"], async (p) => {
    keys(p, ["batch_id"]);
    const result = await controller.getNarratedOutputDirectory(id(p.batch_id, "narrated_batch"));
    if (typeof result.directory !== "string" || !path.isAbsolute(result.directory)) invalid("generated_video_not_found");
    const stat = await fs.stat(result.directory);
    if (!stat.isDirectory()) invalid("generated_video_not_found");
    const error = await shell.openPath(result.directory);
    if (error) invalid("CONTENT_ENGINE_OPEN_FAILED");
    return { opened: true };
  });
  handle(CHANNELS["music-preview"], async (p) => {
    keys(p, ["track_id"]);
    const result = await controller.previewMusicCatalogTrack(id(p.track_id, "music_track"));
    if (typeof result.audio_data_url !== "string" || !/^data:audio\/wav;base64,[A-Za-z0-9+/=]+$/.test(result.audio_data_url) || result.audio_data_url.length > 12 * 1024 * 1024) invalid("music_preview_unavailable");
    return { audioDataUrl: result.audio_data_url };
  });
  handle(CHANNELS.edit, async (p) => {
    keys(p, ["batch_id", "candidate_id", "title", "narration", "shots"]);
    const result = { batch_id: id(p.batch_id, "narrated_batch"), ...(p.candidate_id ? { candidate_id: id(p.candidate_id, "narrated_candidate") } : {}) };
    if (p.title !== undefined) result.title = text(p.title, 100);
    if (p.narration !== undefined) result.narration = text(p.narration, 6000);
    if (p.shots !== undefined) {
      if (!Array.isArray(p.shots) || p.shots.length < 1 || p.shots.length > 40 || p.shots.some((s) => !/^shot_[a-f0-9]{24}$/.test(s))) invalid();
      result.shots = p.shots;
    }
    return publicBatch(await controller.updateNarratedCandidate(result));
  });
  handle(CHANNELS.export, async (p) => {
    keys(p, ["batch_id"]);
    const batch = await controller.getNarratedBatch(id(p.batch_id, "narrated_batch"));
    const completed = batch.candidates.slice(0, batch.target_count || batch.candidates.length)
      .filter((c) => c.status === "completed" && c.generated_video_id);
    if (!completed.length) invalid("generated_video_not_found");
    const choice = await openDialog(["openDirectory", "createDirectory"], [], "选择批次导出位置");
    if (choice.canceled || !choice.filePaths?.[0]) return { canceled: true };
    const folder = await fs.mkdtemp(path.join(choice.filePaths[0], "批量创作-"));
    const manifest = [];
    for (let index = 0; index < completed.length; index += 1) {
      const c = completed[index];
      const name = `${String(index + 1).padStart(3, "0")}-${String(c.title || "作品").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 60)}`;
      const item = { title: c.title, narration: c.narration, candidate_id: c.candidate_id, files: [] };
      for (const [variant, extension] of [["video", "mp4"], ["thumbnail", "jpg"]]) {
        try {
          const source = await controller.resolveGeneratedVideoPath(c.generated_video_id, variant);
          if (source.generated_video_id !== c.generated_video_id || source.variant !== variant || !path.isAbsolute(source.absolute_path)) throw new Error("invalid source");
          const filename = `${name}.${extension}`;
          await fs.copyFile(source.absolute_path, path.join(folder, filename), constants.COPYFILE_EXCL);
          item.files.push(filename);
        } catch { item[`${variant}_error`] = "文件不可用，未导出"; }
      }
      await fs.writeFile(path.join(folder, `${name}.txt`), `标题：${c.title}\n\n发布文案：\n${c.narration}\n\n${batch.cta || ""}\n`, { encoding: "utf8", flag: "wx" });
      manifest.push(item);
    }
    await fs.writeFile(path.join(folder, "批次清单.json"), JSON.stringify(manifest, null, 2), { encoding: "utf8", flag: "wx" });
    return { canceled: false, filename: path.basename(folder), count: manifest.filter((i) => !i.video_error).length, incomplete: manifest.some((i) => i.video_error || i.thumbnail_error) };
  });
}
module.exports = { CHANNELS, ERRORS, publicBatch, registerNarratedBatchIpc };
