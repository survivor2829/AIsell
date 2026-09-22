const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { writeJsonAtomic } = require('./atomic-file.cjs');
const { createDigitalHumanProvider, fail, cleanMessage, remoteUrl, SCENES, VOICES, SAFE_ID } = require('./digital-human-provider.cjs');

const ID = /^dh_[a-f0-9-]{36}$/u;
const ASSET_ID = /^dha_[a-f0-9-]{36}$/u;
const POLLING_STATES = new Set(['preview_preparing', 'preview_generating', 'registering', 'reviewing', 'video_submitting', 'video_generating', 'packaging']);
const RESUMABLE_PACKAGING_STATES = new Set(['failed', 'paused', 'cancelled']);
const LABELS = {
  draft: '待生成预览', preview_preparing: '准备形象与产品', preview_generating: '生成场景预览', preview_ready: '待确认预览',
  registering: '登记人物素材', reviewing: '等待形象审核', video_submitting: '提交视频', video_generating: '生成样片',
  packaging: '制作字幕与封面', completed: '成片已就绪', needs_attention: '需要处理', outcome_unknown: '请求待核对',
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
// The gateway adds a per-license prefix. Keep the complete upstream asset name
// within APIMart's 64-character limit while retaining task-level isolation.
const avatarGroup = (task) => `dh_${digest(task.id).slice(0, 24)}`;
const avatarAsset = (task, role) => `${avatarGroup(task)}_${role}`;
function assertKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw fail('digital_human_invalid_input', '请刷新页面后重试。');
}
function contained(root, relative) {
  const full = path.resolve(root, relative);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw fail('digital_human_path_invalid', '本地任务文件无效。');
  return full;
}
function imageMime(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw fail('digital_human_image_invalid', '图片内容无法识别，请换一张 JPG、PNG 或 WebP 图片。');
}
function createDigitalHumanService(options = {}) {
  if (!options.rootDir || path.resolve(options.rootDir) === path.parse(path.resolve(options.rootDir)).root) throw fail('digital_human_storage_invalid', '数字人存储目录无效。');
  const root = path.resolve(options.rootDir), provider = options.provider || createDigitalHumanProvider(options);
  const active = new Map();
  let closed = false;
  function file(id) { if (!ID.test(String(id || ''))) throw fail('digital_human_not_found', '没有找到这条数字人任务。'); return contained(root, `${id}/task.json`); }
  function read(id) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch (error) { throw fail(error.code === 'ENOENT' ? 'digital_human_not_found' : 'digital_human_data_unreadable', '数字人记录无法读取，原数据已保留。'); }
    if (data.version !== 1 || data.id !== id) throw fail('digital_human_data_unreadable', '数字人记录格式无法识别，原数据已保留。');
    return data;
  }
  function save(task) { task.updatedAt = new Date().toISOString(); writeJsonAtomic(file(task.id), task); }
  function asset(id) {
    if (!ASSET_ID.test(String(id || ''))) throw fail('digital_human_asset_required', '请先选择本人形象和产品图片。');
    let item;
    try { item = JSON.parse(fs.readFileSync(contained(root, `assets/${id}.json`), 'utf8')); } catch { throw fail('digital_human_asset_missing', '已选图片无法读取，请重新选择。'); }
    const actual = contained(root, item.relativePath);
    const bytes = fs.readFileSync(actual);
    if (digest(bytes) !== item.sha256) throw fail('digital_human_asset_changed', '已选图片发生变化，请重新选择。');
    return { ...item, path: actual, bytes };
  }
  function publicTask(task) {
    return { id: task.id, title: task.title, script: task.script, sceneId: task.sceneId, voiceStyle: task.voiceStyle,
      durationSeconds: task.durationSeconds, personAssetId: task.personAssetId, productAssetId: task.productAssetId,
      templateId: task.templateId || 'topic_fixed', musicTrackId: task.musicTrackId || '',
      status: task.status, statusLabel: LABELS[task.status] || '需要处理', createdAt: task.createdAt, updatedAt: task.updatedAt,
      previewReady: Boolean(task.previewFile && fs.existsSync(contained(root, task.previewFile))), previewRevision: task.previewRevision || '',
      progress: Math.max(0, Math.min(100, Number(task.progress) || 0)),
      error: cleanMessage(task.error || ''), errorCode: String(task.errorCode || '').slice(0, 100),
      generatedVideoId: task.generatedVideoId || '', packagingTaskId: task.packagingTaskId || '',
      canResume: task.status === 'needs_attention' && Boolean(task.resumeStatus), canRefresh: task.status !== 'completed',
    };
  }
  function list() {
    if (!fs.existsSync(root)) return { items: [] };
    const items = fs.readdirSync(root).filter((name) => ID.test(name)).map((id) => publicTask(read(id)));
    return { items: items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  }
  function update(task, status, fields = {}) { Object.assign(task, fields, { status, error: '', errorCode: '', resumeStatus: null }); save(task); }
  function pause(task, error) {
    const resumeStatus = task.status;
    task.status = error.outcomeUnknown ? 'outcome_unknown' : 'needs_attention';
    task.resumeStatus = resumeStatus;
    task.error = cleanMessage(error.message || '当前步骤未完成。');
    task.errorCode = error.code || 'digital_human_step_failed';
    save(task);
  }
  async function requireCapabilities() {
    const status = await provider.capabilities();
    if (!status.ready) throw fail(status.code, status.message);
  }
  async function operation(task, name, route, body, headers = {}) {
    task.operations ||= {};
    const previous = task.operations[name];
    if (previous?.response) return previous.response;
    // A persisted pending operation is only recovered through its gateway receipt.
    // Reposting after an app crash would risk a second paid generation.
    if (previous) {
      let receipt;
      try { receipt = await provider.request(`/operations/${previous.id}`); }
      catch (error) { throw fail('digital_human_submission_unknown', '上次请求尚未核对成功，请稍后刷新；不会自动重复提交。', { outcomeUnknown: true }); }
      if (receipt?.status === 'pending') throw fail('digital_human_submission_unknown', '服务仍在处理上次请求，请稍后刷新。', { outcomeUnknown: true });
      previous.response = receipt; save(task); return receipt;
    }
    const entry = { id: randomUUID(), submittedAt: new Date().toISOString() };
    task.operations[name] = entry; save(task);
    try {
      const response = await provider.request(route, { method: 'POST', body, headers, operationId: entry.id });
      entry.response = response; save(task); return response;
    } catch (error) {
      if (!error.outcomeUnknown) { entry.rejected = true; entry.error = cleanMessage(error.message); save(task); }
      throw error;
    }
  }
  async function upload(task, role) {
    if (task[`${role}Url`]) return task[`${role}Url`];
    const input = asset(task[`${role}AssetId`]);
    const request = provider.imageUploadBody(input.path);
    const payload = await operation(task, `upload_${role}`, '/apimart/uploads/images', request.body, request.headers);
    const url = remoteUrl(provider.nodeOf(payload).url || payload.url);
    task[`${role}Url`] = url; save(task); return url;
  }
  async function poll(task, providerTaskId) {
    const payload = await provider.request(`/apimart/tasks/${providerTaskId}?language=en`);
    const node = provider.nodeOf(payload);
    if (['failed', 'rejected', 'cancelled', 'canceled'].includes(String(node.status).toLowerCase())) {
      throw fail('digital_human_provider_failed', cleanMessage(node.error?.message || node.error || '服务未完成生成，请检查输入素材。'));
    }
    task.progress = Number(node.progress) || task.progress || 0; save(task);
    return { payload, node, completed: ['completed', 'succeeded', 'success'].includes(String(node.status).toLowerCase()) };
  }
  function approvedAsset(payload, expectedName) {
    const data = payload?.data || payload;
    const items = Array.isArray(data) ? data : data?.assets || data?.items || data?.list || data?.result?.assets || [];
    for (const item of items) {
      if (String(item.name || item.asset_name || '') !== expectedName) continue;
      const status = String(item.status || item.moderation_status || '').toLowerCase();
      if (['failed', 'rejected', 'disabled'].includes(status)) throw fail('digital_human_avatar_rejected', cleanMessage(item.error?.message || item.reason || '人物素材审核未通过，请更换图片。'));
      if (!['approved', 'active', 'ready', 'success', 'succeeded', 'completed'].includes(status)) continue;
      const id = String(item.asset_id || item.id || '').replace(/^asset:\/\//u, '');
      if (SAFE_ID.test(id)) return `asset://${id}`;
    }
    return null;
  }
  async function registeredAssets(task) {
    const payload = await provider.request(`/apimart/seedance2/private-avatar/assets?group=${avatarGroup(task)}`);
    const person = approvedAsset(payload, avatarAsset(task, 'person'));
    const preview = approvedAsset(payload, avatarAsset(task, 'preview'));
    return person && preview ? { person, preview } : null;
  }
  function packagingUnknown(result) {
    return result?.status === 'outcome_unknown' || /(?:outcome|submission)_unknown/u.test(String(result?.error_code || ''));
  }
  function packagingError(result) {
    const fallback = result?.status === 'paused' ? '样片包装已暂停，可以继续处理。'
      : result?.status === 'cancelled' ? '样片包装已取消，可以继续处理。'
      : '样片包装需要处理，请在制作记录查看原因。';
    return fail(result?.error_code || 'digital_human_packaging_failed', cleanMessage(result?.error_message || fallback), { outcomeUnknown: packagingUnknown(result) });
  }
  async function startPackaging(task) {
    const output = await options.packageVideo({ source_id: `digital_human_${task.id.slice(3)}`, input_video_path: contained(root, task.baseVideoFile),
      title: task.title, confirmed_script: task.script, template_id: task.templateId || 'topic_fixed', cover_mode: 'apimart',
      ...(task.musicTrackId ? { music_track_id: task.musicTrackId } : {}) });
    if (!output?.task_id) throw fail('digital_human_packaging_unavailable', '样片已保存，包装服务未返回任务编号。');
    task.packagingTaskId = output.task_id; task.projectId = output.project_id || ''; save(task);
  }
  async function advance(task) {
    if (task.status === 'preview_preparing') {
      await requireCapabilities();
      // Check the free, task-scoped supplier route before uploading user images.
      await provider.request(`/apimart/seedance2/private-avatar/assets?group=${avatarGroup(task)}`);
      await upload(task, 'person'); await upload(task, 'product');
      const response = await operation(task, 'preview', '/apimart/images/generations', provider.previewPayload(task));
      update(task, 'preview_generating', { previewTaskId: provider.taskIdOf(response), progress: 0 });
    }
    if (task.status === 'preview_generating') {
      const result = await poll(task, task.previewTaskId);
      if (!result.completed) return;
      const url = provider.resultUrl(result.payload, 'images'), relative = `${task.id}/preview.image`;
      await provider.download(url, contained(root, relative), { maxBytes: 20 * 1024 * 1024 });
      const bytes = fs.readFileSync(contained(root, relative)); imageMime(bytes);
      update(task, 'preview_ready', { previewUrl: url, previewFile: relative, previewRevision: digest(bytes), progress: 100 });
      return;
    }
    if (task.status === 'registering') {
      await requireCapabilities();
      const response = await operation(task, 'avatar_registration', '/apimart/seedance2/private-avatar/assets', {
        model: 'seedance-2.5', group: { name: avatarGroup(task) }, asset_type: 'Image',
        assets: [{ url: task.personUrl, name: avatarAsset(task, 'person') }, { url: task.previewUrl, name: avatarAsset(task, 'preview') }],
      });
      update(task, 'reviewing', { registrationTaskId: provider.taskIdOf(response), progress: 0 });
    }
    if (task.status === 'reviewing') {
      const result = await poll(task, task.registrationTaskId);
      if (!result.completed) return;
      // Match the per-task unique name as well as moderation status. Never take
      // the first asset returned from a shared provider account.
      const libraryAssets = await registeredAssets(task);
      if (!libraryAssets) throw fail('digital_human_avatar_not_resolved', '形象审核任务已返回，但尚未找到本任务的两项已审核素材，请稍后继续检查。');
      update(task, 'video_submitting', { libraryAssets, progress: 0 });
    }
    if (task.status === 'video_submitting') {
      await requireCapabilities();
      const response = await operation(task, 'video', '/apimart/videos/generations', provider.videoPayload(task));
      update(task, 'video_generating', { videoTaskId: provider.taskIdOf(response), progress: 0 });
    }
    if (task.status === 'video_generating') {
      const result = await poll(task, task.videoTaskId);
      if (!result.completed) return;
      const relative = `${task.id}/base.mp4`;
      if (!task.baseVideoFile || !fs.existsSync(contained(root, task.baseVideoFile))) {
        await provider.download(provider.resultUrl(result.payload, 'videos'), contained(root, relative));
        const head = Buffer.alloc(12), descriptor = fs.openSync(contained(root, relative), 'r');
        try { fs.readSync(descriptor, head, 0, 12, 0); } finally { fs.closeSync(descriptor); }
        if (head.toString('ascii', 4, 8) !== 'ftyp') throw fail('digital_human_video_invalid', '下载结果不是有效MP4，云端任务已保留。');
        task.baseVideoFile = relative; save(task);
      }
      update(task, 'packaging', { progress: 0 });
    }
    if (task.status === 'packaging') {
      if (!options.packageVideo || !options.queryPackaging) throw fail('digital_human_packaging_unavailable', '样片已保存，字幕与封面制作服务尚未接通。');
      if (!task.packagingTaskId) await startPackaging(task);
      const result = await options.queryPackaging(task.packagingTaskId);
      if (RESUMABLE_PACKAGING_STATES.has(result?.status) || result?.status === 'needs_attention' || packagingUnknown(result)) throw packagingError(result);
      task.progress = Math.round(Number(result?.progress || 0) * (Number(result?.progress) <= 1 ? 100 : 1)); save(task);
      if (result?.status === 'completed') {
        const output = result.result || result.output || {};
        const videoId = result.generated_video_id || output.generated_video_id || output.generatedVideoId;
        if (!videoId) throw fail('digital_human_output_not_registered', '包装已完成，但成片编号尚未登记，请在制作记录查看结果。');
        update(task, 'completed', { generatedVideoId: videoId, progress: 100 });
      }
    }
  }
  function schedule(id) {
    if (closed || active.has(id)) return active.get(id);
    const promise = Promise.resolve().then(async () => {
      const task = read(id);
      if (!POLLING_STATES.has(task.status)) return;
      try { await advance(task); } catch (error) { pause(task, error); }
    }).finally(() => active.delete(id));
    active.set(id, promise);
    // Detached timer/submit callers must not create an unhandled rejection if
    // the local disk fails. Explicit refresh still receives this rejection.
    void promise.catch(() => {});
    return promise;
  }
  async function capabilities() { return { ...await provider.capabilities(), scenes: SCENES.map(({ id, name }) => ({ id, name })), voices: VOICES.map(({ id, name }) => ({ id, name })) }; }
  function imagePreview(item, bytes) {
    return { id: item.id, name: item.name, previewDataUrl: options.imageThumbnail
      ? options.imageThumbnail(bytes) : `data:${imageMime(bytes)};base64,${bytes.toString('base64')}` };
  }
  function images(id) {
    const task = read(id), result = {};
    for (const role of ['person', 'product']) {
      if (!task[`${role}AssetId`]) continue;
      const item = asset(task[`${role}AssetId`]);
      result[role] = imagePreview(item, item.bytes);
    }
    return result;
  }
  function importImage(source) {
    const stat = fs.statSync(source);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 20 * 1024 * 1024) throw fail('digital_human_image_size', '请选择不超过20MB的图片。');
    const bytes = fs.readFileSync(source), mime = imageMime(bytes);
    if (options.imageSize) {
      const { width, height } = options.imageSize(bytes);
      if (width < 300 || height < 300 || width > 6000 || height > 6000 || width / height < .4 || width / height > 2.5) throw fail('digital_human_image_dimensions', '图片宽高须为300–6000像素，比例在2:5到5:2之间。');
    }
    const id = `dha_${randomUUID()}`, ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[mime];
    const relativePath = `assets/${id}${ext}`;
    fs.mkdirSync(contained(root, 'assets'), { recursive: true });
    fs.writeFileSync(contained(root, relativePath), bytes, { flag: 'wx' });
    writeJsonAtomic(contained(root, `assets/${id}.json`), { id, relativePath, sha256: digest(bytes), name: path.basename(source), mime });
    return imagePreview({ id, name: path.basename(source) }, bytes);
  }
  function create(input) {
    assertKeys(input, ['id', 'personAssetId', 'productAssetId', 'sceneId', 'voiceStyle', 'durationSeconds', 'script', 'title', 'templateId', 'musicTrackId']);
    if (input.personAssetId) asset(input.personAssetId);
    if (input.productAssetId) asset(input.productAssetId);
    if (!SCENES.some((s) => s.id === input.sceneId) || !VOICES.some((s) => s.id === input.voiceStyle)
      || !Number.isInteger(input.durationSeconds) || input.durationSeconds < 10 || input.durationSeconds > 15) throw fail('digital_human_invalid_options', '请选择有效场景、声音和10–15秒时长。');
    if (input.templateId && !['topic_fixed', 'key_points'].includes(input.templateId)) throw fail('digital_human_invalid_template', '请选择有效的视频样式。');
    if (input.musicTrackId && !/^music_track_[A-Za-z0-9_-]{1,120}$/u.test(input.musicTrackId)) throw fail('digital_human_invalid_music', '请选择有效的配乐。');
    const script = String(input.script || '').trim();
    if (script.length > 160) throw fail('digital_human_script_required', '请填写160字以内的样片文案。');
    const previous = input.id ? read(input.id) : null;
    if (previous && previous.status !== 'draft') throw fail('digital_human_draft_locked', '这条样片已开始制作，请调整后新建。');
    const task = { ...input, script, title: String(input.title || script.slice(0, 20) || '未命名样片').trim().slice(0, 80),
      version: 1, id: previous?.id || `dh_${randomUUID()}`, status: 'draft', createdAt: previous?.createdAt || new Date().toISOString(), operations: {} };
    save(task); return publicTask(task);
  }
  async function preview(id) {
    if (active.has(id)) return publicTask(read(id));
    const task = read(id);
    if (task.status !== 'draft') throw fail('digital_human_preview_already_started', '这条任务已生成预览，请查看现有进度。');
    asset(task.personAssetId); asset(task.productAssetId);
    if (!task.script.trim()) throw fail('digital_human_script_required', '请先填写样片文案。');
    await requireCapabilities(); update(task, 'preview_preparing'); void schedule(id); return publicTask(task);
  }
  async function confirm(id, revision) {
    const task = read(id);
    if (task.status !== 'preview_ready' || !revision || revision !== task.previewRevision) throw fail('digital_human_preview_confirmation_required', '请查看当前场景预览后，再确认生成。');
    if (digest(fs.readFileSync(contained(root, task.previewFile))) !== revision) throw fail('digital_human_preview_changed', '场景预览已变化，请重新查看。');
    await requireCapabilities(); update(task, 'registering', { confirmedAt: new Date().toISOString() }); void schedule(id); return publicTask(task);
  }
  async function refresh(id) {
    let task = read(id);
    if (task.status === 'outcome_unknown' && task.resumeStatus === 'registering') {
      // The registration reply can be lost after APIMart creates both assets.
      // Resolve them through the task-scoped read route before any new POST.
      const libraryAssets = await registeredAssets(task);
      if (!libraryAssets) return publicTask(task);
      update(task, 'video_submitting', { libraryAssets, registrationRecoveredAt: new Date().toISOString(), progress: 0 });
      await schedule(id); return publicTask(read(id));
    }
    if (task.status === 'outcome_unknown' && task.resumeStatus) {
      // Only a receipt GET can recover the existing operation; operation() never
      // repeats the POST while its pending journal entry exists.
      update(task, task.resumeStatus);
    }
    await schedule(id); return publicTask(read(id));
  }
  async function resume(id) {
    const task = read(id);
    if (task.status !== 'needs_attention' || !task.resumeStatus) throw fail('digital_human_resume_invalid', '当前任务没有可继续的步骤。');
    // Definitive provider rejection must be resolved by a new, explicit request.
    // Preserve its original record and do not silently re-submit on Continue.
    if (Object.values(task.operations || {}).some((op) => op.rejected)) throw fail('digital_human_request_rejected', '服务已拒绝这次请求，请修改输入后新建样片；原记录已保留。');
    if (task.resumeStatus === 'packaging' && task.packagingTaskId) {
      if (!options.packageVideo || !options.queryPackaging) throw fail('digital_human_packaging_unavailable', '样片已保存，字幕与封面制作服务尚未接通。');
      const result = await options.queryPackaging(task.packagingTaskId);
      if (packagingUnknown(result)) throw packagingError(result);
      // Only an explicit Continue can requeue known local terminal states.
      // The engine reuses source_id; unknown provider work is never re-admitted.
      if (RESUMABLE_PACKAGING_STATES.has(result?.status)) await startPackaging(task);
      else if (result?.status === 'needs_attention') throw packagingError(result);
    }
    update(task, task.resumeStatus); void schedule(id); return publicTask(task);
  }
  function media(id, kind = 'preview') {
    const task = read(id);
    if (kind !== 'preview' || !task.previewFile) throw fail('digital_human_preview_unavailable', '场景预览尚未完成。');
    const bytes = fs.readFileSync(contained(root, task.previewFile));
    if (bytes.length > 20 * 1024 * 1024) throw fail('digital_human_image_size', '预览图片过大。');
    return { dataUrl: `data:${imageMime(bytes)};base64,${bytes.toString('base64')}` };
  }
  const timer = setInterval(() => {
    if (closed || !fs.existsSync(root)) return;
    for (const id of fs.readdirSync(root).filter((name) => ID.test(name))) {
      try { if (POLLING_STATES.has(read(id).status)) void schedule(id); } catch { /* Corrupt records stay visible via list(), never overwritten. */ }
    }
  }, 15000);
  timer.unref?.();
  return { capabilities, importImage, create, preview, confirm, refresh, resume, media, images, list,
    get: (id) => publicTask(read(id)),
    close: async () => { closed = true; clearInterval(timer); await Promise.allSettled(active.values()); },
  };
}
module.exports = { createDigitalHumanService, assertKeys, imageMime, contained, ID, ASSET_ID };
