const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { writeJsonAtomic } = require('./atomic-file.cjs');
const { createDigitalHumanProvider, fail, cleanMessage, remoteUrl, SCENES, VOICES, SAFE_ID } = require('./digital-human-provider.cjs');
const { VERSION: DIRECTOR_SKILL_VERSION } = require('./skills/cleaning-video-director/rules.cjs');
const { upscaleTo1080Size } = require('./video-upscale.cjs');
const { createBailianVideoProvider, ROUTES } = require('./bailian-video-provider.cjs');
const audioTools = require('./digital-human-audio.cjs');
const { buildCaptions } = require('./product-video-media.cjs');
const { createPriceReader, createBailianPriceReader, validBailianPrices, validPrices, round } = require('./product-video-pricing.cjs');

const ID = /^dh_[a-f0-9-]{36}$/u;
const ASSET_ID = /^dha_[a-f0-9-]{36}$/u;
const POLLING_STATES = new Set(['preview_preparing', 'preview_generating', 'registering', 'reviewing', 'audio_preparing', 'official_submitting', 'official_generating', 'audio_assembling', 'video_submitting', 'video_generating', 'enhancing', 'packaging']);
const RESUMABLE_PACKAGING_STATES = new Set(['failed', 'paused', 'cancelled']);
const LABELS = {
  draft: '待生成预览', preview_preparing: '准备形象与产品', preview_generating: '生成场景预览', preview_ready: '待确认预览',
  registering: '登记人物素材', reviewing: '等待形象审核', video_submitting: '提交视频', video_generating: '生成样片',
  enhancing: '本地放大画面', packaging: '制作字幕与封面', completed: '成片已就绪', needs_attention: '需要处理', outcome_unknown: '请求待核对',
  audio_preparing: '准备并测量完整口播', official_submitting: '提交音频驱动视频', official_generating: '生成自然口播', audio_assembling: '合成冻结音轨',
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
  const official = options.officialProvider || createBailianVideoProvider(options);
  const readPrices = options.readPrices || createBailianPriceReader(options);
  const readPreviewPrices = options.readPreviewPrices || createPriceReader(options);
  const audioMedia = { ...audioTools, ...options.audioTools };
  const active = new Map();
  let closed = false;
  let updateHold = false;
  let admissions = 0;
  function assertCanWork() {
    if (closed || updateHold || global.__xiaoxiUpdateHold) throw fail('UPDATE_IN_PROGRESS', '软件正在更新，请稍后继续制作。');
  }
  const admit = (action) => async (...args) => {
    assertCanWork(); admissions += 1;
    try { return await action(...args); } finally { admissions -= 1; }
  };
  function isBusy() {
    return admissions > 0 || active.size > 0;
  }
  function file(id) { if (!ID.test(String(id || ''))) throw fail('digital_human_not_found', '没有找到这条数字人任务。'); return contained(root, `${id}/task.json`); }
  function read(id) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch (error) { throw fail(error.code === 'ENOENT' ? 'digital_human_not_found' : 'digital_human_data_unreadable', '数字人记录无法读取，原数据已保留。'); }
    if (![1, 2].includes(data.version) || data.id !== id) throw fail('digital_human_data_unreadable', '数字人记录格式无法识别，原数据已保留。');
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
      actualDurationSeconds: task.actualDurationSeconds, narrationPolicy: task.narrationPolicy,
      templateId: task.templateId || 'topic_fixed', musicTrackId: task.musicTrackId || '',
      status: task.status, statusLabel: LABELS[task.status] || '需要处理', createdAt: task.createdAt, updatedAt: task.updatedAt,
      previewReady: Boolean(task.previewFile && fs.existsSync(contained(root, task.previewFile))), previewRevision: task.previewRevision || '',
      progress: Math.max(0, Math.min(100, Number(task.progress) || 0)),
      error: cleanMessage(task.error || ''), errorCode: String(task.errorCode || '').slice(0, 100),
      generatedVideoId: task.generatedVideoId || '', packagingTaskId: task.packagingTaskId || '',
      videoResolution: task.videoResolution || '1080p', directorSkillVersion: task.directorSkillVersion || '1',
      outputQuality: task.version === 2 ? '原生720p·包装输出1080尺寸' : task.videoResolution === '480p' ? '1080p尺寸·本地放大' : '原生1080p',
      pipelineVersion: task.version, budgetCny: task.budgetCny,
      ...(task.version === 2 ? { quote: quote(task), audio: { prepared: Boolean(task.audioPreparedAt),
        seconds: task.segments?.reduce((sum, s) => sum + (s.audio?.seconds || 0), 0) || 0,
        speechSeconds: task.segments?.reduce((sum, s) => sum + (s.audio?.speechSeconds || 0), 0) || 0,
        coverage: (task.segments?.reduce((sum, s) => sum + (s.audio?.speechEnd || 0), 0) || 0) / task.durationSeconds,
        segmentCount: task.segments?.length || 0 },
        segments: (task.segments || []).map((s) => ({ id: s.id, seconds: s.seconds, status: s.status, text: s.text,
          measuredSeconds: s.audio?.seconds, speechEnd: s.audio?.speechEnd })) } : {}),
      canResume: task.status === 'needs_attention' && Boolean(task.resumeStatus)
        && !['digital_human_retry_exhausted', 'digital_human_retry_budget_exceeded'].includes(task.errorCode), canRefresh: task.status !== 'completed',
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
  async function requireCapabilities(task) {
    const status = await (task?.version === 2 ? official : provider).capabilities();
    if (!status.ready) throw fail(status.code, status.message);
    if (task?.narrationPolicy === 'original_script'
      && (typeof options.requireAudioUploadCapability !== 'function' || await options.requireAudioUploadCapability() !== true)) {
      throw fail('digital_human_audio_upload_unavailable', '当前制作组件尚未支持完整口播音轨，请更新组件后继续；尚未提交新付费制作。');
    }
    if (task?.version === 2 && options.gatewayClient) {
      const state = await options.gatewayClient.initialize({ verify: true });
      if (!state.capabilities?.apimart || !state.capabilities?.volcengine_asr) throw fail('digital_human_preparation_unavailable', '场景预览或字幕服务尚未就绪，尚未提交付费制作。');
    }
  }
  function costFor(task, name) {
    if (name === 'preview') return round(task.previewPrices.imageUsd * task.previewPrices.fxCnyPerUsd);
    if (name === 'asr') return task.previewPrices.asrReserveCny;
    const segment = (name.startsWith('tts_') ? task.speechChunks || task.segments : task.segments)?.find((item) => name === `${name.startsWith('tts_') ? 'tts' : 'wan'}_${item.id}` || name.startsWith(`wan_${item.id}_retry_`));
    if (name.startsWith('tts_')) return round(segment.text.length * task.prices.ttsCnyPer10kChars / 10000);
    if (name === 'wan_estimate') return round(task.durationSeconds * task.prices.rates['720p'].audio);
    if (name.startsWith('wan_')) return round((segment.generationSeconds || segment.seconds) * task.prices.rates['720p'].audio);
    return 0;
  }
  const videoOperation = (segment) => segment.videoOperation || `wan_${segment.id}`;
  function remainingStages(task) {
    if (task.narrationPolicy === 'original_script' && task.budgetPolicy === 'quoted_production' && !task.productionBudgetFrozenAt && task.budgetPhase !== 'production') {
      return [...(task.speechChunks || []).map((s) => `tts_${s.id}`), 'asr'];
    }
    return ['preview', ...(task.speechChunks || task.segments || []).map((s) => `tts_${s.id}`),
      ...(task.narrationPolicy === 'original_script' && !task.segments?.length ? ['wan_estimate'] : (task.segments || []).map(videoOperation)), 'asr'];
  }
  function quote(task) {
    const entries = Object.values(task.operations || {}), reservedCny = round(entries.reduce((sum, op) => sum + (op.rejected ? 0 : op.reserveCny || 0), 0));
    const ready = validBailianPrices(task.prices) && validPrices(task.previewPrices);
    const future = ready ? remainingStages(task).filter((name) => !task.operations?.[name]).reduce((sum, name) => sum + costFor(task, name), 0) : 0;
    const preparationOnly = task.narrationPolicy === 'original_script' && task.budgetPolicy === 'quoted_production' && !task.productionBudgetFrozenAt && task.budgetPhase !== 'production';
    const retryReserve = ready && !preparationOnly && !task.videoRetryCount ? round(Math.max(...(task.segments?.length ? task.segments.map((s) => s.generationSeconds || s.seconds) : [Math.min(15, task.durationSeconds)])) * task.prices.rates['720p'].audio) : 0;
    return { ready, budgetCny: task.budgetCny, estimatedCny: ready ? round(reservedCny + future) : null,
      maximumCny: ready ? round(reservedCny + future + retryReserve) : null, pendingCny: reservedCny,
      reservedCny, remainingCny: round(Math.max(0, task.budgetCny - reservedCny)), actualCny: null,
      note: '公开标价预留，非实际扣款；预览采用预算汇率折算，账单待核对。' };
  }
  async function ensurePrices(task) {
    const prices = await readPrices(), previewPrices = await readPreviewPrices();
    if (!validBailianPrices(prices) || !validPrices(previewPrices)) throw fail('digital_human_price_unavailable', '未取得有效完整报价，尚未提交新付费请求。');
    task.prices = prices; task.previewPrices = previewPrices;
    if (task.narrationPolicy === 'original_script') task.speechChunks ||= audioMedia.speechChunks(task.script);
    else task.segments ||= audioMedia.splitScript(task.script, task.durationSeconds);
    save(task);
    if (task.budgetPolicy === 'quoted_production' && task.status === 'draft' && !Object.keys(task.operations || {}).length) {
      task.budgetCny = quote(task).maximumCny; save(task);
    }
    if (task.budgetPolicy === 'quoted_production' && task.narrationPolicy === 'original_script' && task.budgetPhase === 'production' && !task.productionBudgetFrozenAt) {
      task.preparationBudgetCny = task.budgetCny;
      task.budgetCny = quote(task).maximumCny;
      task.productionBudgetFrozenAt = new Date().toISOString(); save(task);
    }
    if (quote(task).estimatedCny > task.budgetCny) throw fail('digital_human_budget_exceeded', '本次制作额度不足，请联系管理员；已有声音和画面已保留。');
  }
  async function operation(task, name, route, body, headers = {}) {
    assertCanWork();
    task.operations ||= {};
    const transport = route.startsWith('/bailian/') ? official : provider;
    const previous = task.operations[name];
    if (previous?.response) return previous.response;
    // A persisted pending operation is only recovered through its gateway receipt.
    // Reposting after an app crash would risk a second paid generation.
    if (previous) {
      let receipt;
      try { receipt = await transport.request(`/operations/${previous.id}`); }
      catch (error) { throw fail('digital_human_submission_unknown', '上次请求尚未核对成功，请稍后刷新；不会自动重复提交。', { outcomeUnknown: true }); }
      if (!receipt || receipt?.status === 'pending') throw fail('digital_human_submission_unknown', '服务仍在处理上次请求，请稍后刷新。', { outcomeUnknown: true });
      previous.response = receipt; save(task); return receipt;
    }
    if (task.version === 2) await ensurePrices(task);
    const entry = { id: randomUUID(), submittedAt: new Date().toISOString(), ...(task.version === 2 ? { reserveCny: costFor(task, name) } : {}) };
    task.operations[name] = entry; save(task);
    try {
      const response = await transport.request(route, { method: 'POST', body,
        headers: route.startsWith('/volcengine/asr/') ? { ...headers, 'X-Api-Request-Id': entry.id } : headers,
        operationId: entry.id });
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
      title: task.title, confirmed_script: task.script, template_id: task.templateId || 'topic_fixed', cover_mode: task.version === 2 ? 'local_frame' : 'apimart',
      ...(task.version === 2 ? { prepared_transcript: { utterances: task.preparedUtterances, time_unit: 'ms', source_sha256: digest(fs.readFileSync(contained(root, task.baseVideoFile))) } } : {}),
      ...(task.musicTrackId ? { music_track_id: task.musicTrackId } : {}) });
    if (!output?.task_id) throw fail('digital_human_packaging_unavailable', '样片已保存，包装服务未返回任务编号。');
    task.packagingTaskId = output.task_id; task.projectId = output.project_id || ''; save(task);
  }
  async function recognizeFrozen(task, seconds) {
    const frozen = fs.readFileSync(contained(root, task.frozenAudioFile));
    if (digest(frozen) !== task.frozenAudioSha256) throw fail('digital_human_audio_changed', '冻结的完整口播音轨发生变化，尚未提交视频。');
    const response = await operation(task, 'asr', '/volcengine/asr/recognize/flash', { user: { uid: 'xiaoxi-digital-human' },
      audio: { data: frozen.toString('base64') }, request: { model_name: 'bigmodel', show_utterances: true, show_words: true, enable_punc: true } },
      { 'X-Api-Resource-Id': 'volc.bigasr.auc_turbo', 'X-Api-Sequence': '-1' });
    const result = response.result || response.data?.result || response.data || response;
    task.preparedUtterances = result.utterances; save(task);
    task.audioVerification = audioMedia.verifyTranscript(task.preparedUtterances, task.script, seconds);
    buildCaptions({ utterances: task.preparedUtterances, timeUnit: 'ms', durationSeconds: seconds }); save(task);
  }
  async function prepareOriginalSpeech(task) {
    await requireCapabilities(task); await ensurePrices(task);
    for (const chunk of task.speechChunks) {
      if (!chunk.audioUrl) {
        const payload = await operation(task, `tts_${chunk.id}`, ROUTES.tts, official.ttsPayload({ text: chunk.text, voice: audioTools.VOICE_IDS[task.voiceStyle] }));
        chunk.audioUrl = official.ttsAudioUrl(payload);
        chunk.audioExpiresAt = new Date(Date.parse(task.operations[`tts_${chunk.id}`].submittedAt) + 23 * 60 * 60_000).toISOString(); save(task);
      }
      const relative = `${task.id}/${chunk.id}.audio`;
      if (!chunk.audioFile || !fs.existsSync(contained(root, chunk.audioFile))) {
        if (Date.parse(chunk.audioExpiresAt) <= Date.now()) throw fail('digital_human_audio_url_expired', '已付费配音尚未下载且地址已过期，已保留回执，不会重新购买配音。');
        await official.download(chunk.audioUrl, contained(root, relative), { maxBytes: 15 * 1024 * 1024 });
        chunk.audioFile = relative; save(task);
      }
      const measured = await audioMedia.measureAudio({ source: contained(root, chunk.audioFile), ffmpegPath: options.ffmpegPath || 'ffmpeg' });
      if (chunk.audio?.sha256 && chunk.audio.sha256 !== measured.sha256) throw fail('digital_human_audio_changed', '原口播音轨发生变化。');
      chunk.audio = measured; save(task);
    }
    if (!task.frozenAudioFile) {
      const relative = `${task.id}/frozen-full-speech.wav`;
      const result = await audioMedia.freezeAudio({ segments: task.speechChunks.map((chunk) => ({ audioPath: contained(root, chunk.audioFile),
        audioSha256: chunk.audio.sha256, preserveDuration: true })), destination: contained(root, relative), ffmpegPath: options.ffmpegPath || 'ffmpeg' });
      task.frozenAudioFile = relative; task.frozenAudioSha256 = result.sha256; save(task);
    }
    const measured = await audioMedia.measureAudio({ source: contained(root, task.frozenAudioFile), ffmpegPath: options.ffmpegPath || 'ffmpeg' });
    if (measured.sha256 !== task.frozenAudioSha256) throw fail('digital_human_audio_changed', '冻结的完整口播音轨发生变化。');
    audioMedia.assertSpeechCoverage(measured, measured.seconds);
    task.actualDurationSeconds = measured.seconds; save(task);
    await recognizeFrozen(task, measured.seconds);
    if (!task.segments?.length) { task.segments = audioMedia.splitMeasuredSpeech(task.preparedUtterances, measured.seconds); save(task); }
    for (const segment of task.segments) {
      if (segment.audioFile) {
        if (digest(fs.readFileSync(contained(root, segment.audioFile))) !== segment.audio.sha256) throw fail('digital_human_audio_changed', '冻结配音片段发生变化。');
        continue;
      }
      const relative = `${task.id}/${segment.id}.wav`;
      segment.audio = await audioMedia.cutAudio({ source: contained(root, task.frozenAudioFile), destination: contained(root, relative),
        startSeconds: segment.startSeconds, seconds: segment.seconds, ffmpegPath: options.ffmpegPath || 'ffmpeg' });
      audioMedia.assertSpeechCoverage(segment.audio, segment.seconds, task.segments.indexOf(segment));
      segment.audioFile = relative; segment.status = 'audio_ready'; save(task);
    }
    task.budgetPhase = 'production'; save(task);
    await ensurePrices(task);
    update(task, 'preview_preparing', { audioPreparedAt: new Date().toISOString(), progress: 0 });
  }
  async function ensureAudioUrl(task, segment) {
    if (segment.audioUrl && Date.parse(segment.audioExpiresAt) > Date.now() + 5 * 60_000) return;
    if (typeof options.uploadPreparedAudio !== 'function') throw fail('digital_human_audio_upload_unavailable', '原口播已保存，音频上传组件尚未就绪；不会重新购买配音。');
    const uploaded = await options.uploadPreparedAudio({ source: contained(root, segment.audioFile), sha256: segment.audio.sha256 });
    if (uploaded?.sha256 !== segment.audio.sha256 || !uploaded.url || !Number.isFinite(Date.parse(uploaded.expiresAt))) throw fail('digital_human_audio_upload_invalid', '原音轨上传结果无法核对，尚未提交视频。');
    segment.audioUrl = uploaded.url; segment.audioExpiresAt = uploaded.expiresAt; save(task);
  }
  async function retryFailedSegment(task, segment, error) {
    segment.status = 'failed'; segment.failure = cleanMessage(error); save(task);
    if ((task.videoRetryCount || 0) >= 1) throw fail('digital_human_retry_exhausted', '本作品已用过一次自动重做，失败镜头与合格成果已保留。');
    await ensurePrices(task);
    const retryName = `wan_${segment.id}_retry_1`, retryCost = costFor(task, retryName);
    if (round(quote(task).estimatedCny + retryCost) > task.budgetCny) throw fail('digital_human_retry_budget_exceeded', '本次剩余额度不足以重做失败镜头，原音轨和合格画面已保留。');
    segment.failedAttempts ||= [];
    segment.failedAttempts.push({ operation: videoOperation(segment), taskId: segment.videoTaskId, error: segment.failure });
    task.videoRetryCount = 1; segment.videoOperation = retryName; segment.videoTaskId = ''; segment.status = 'retry_pending';
    update(task, 'official_submitting', { currentSegmentId: segment.id });
  }
  async function advance(task) {
    if (task.status === 'audio_preparing' && task.narrationPolicy === 'original_script') await prepareOriginalSpeech(task);
    if (task.status === 'audio_preparing') {
      await requireCapabilities(task); await ensurePrices(task);
      for (const [index, segment] of task.segments.entries()) {
        if (!segment.audioUrl) {
          const payload = await operation(task, `tts_${segment.id}`, ROUTES.tts, official.ttsPayload({ text: segment.text, voice: audioTools.VOICE_IDS[task.voiceStyle] }));
          segment.audioUrl = official.ttsAudioUrl(payload);
          segment.audioExpiresAt = new Date(Date.parse(task.operations[`tts_${segment.id}`].submittedAt) + 23 * 60 * 60_000).toISOString();
          save(task);
        }
        const relative = `${task.id}/${segment.id}.audio`;
        if (!segment.audioFile || !fs.existsSync(contained(root, segment.audioFile))) {
          if (Date.parse(segment.audioExpiresAt) <= Date.now()) throw fail('digital_human_audio_url_expired', '已付费配音的临时地址已过期。原回执已保留，不会自动重新配音扣费。');
          await official.download(segment.audioUrl, contained(root, relative), { maxBytes: 15 * 1024 * 1024 });
          segment.audioFile = relative; save(task);
        }
        const measured = await audioMedia.measureAudio({ source: contained(root, segment.audioFile), ffmpegPath: options.ffmpegPath || 'ffmpeg' });
        if (segment.audio?.sha256 && segment.audio.sha256 !== measured.sha256) throw fail('digital_human_audio_changed', '已冻结配音文件发生变化，请保留任务并核对素材。');
        segment.audio = measured; segment.status = 'audio_measured'; save(task);
        audioMedia.assertSpeechCoverage(measured, segment.seconds, index);
        segment.status = 'audio_ready'; save(task);
      }
      const frozenAudioFile = `${task.id}/frozen-full-speech.wav`;
      if (!task.frozenAudioFile) {
        const result = await audioMedia.freezeAudio({ segments: task.segments.map((segment) => ({ audioPath: contained(root, segment.audioFile),
          audioSha256: segment.audio.sha256, seconds: segment.seconds })), destination: contained(root, frozenAudioFile), ffmpegPath: options.ffmpegPath || 'ffmpeg' });
        task.frozenAudioFile = frozenAudioFile; task.frozenAudioSha256 = result.sha256; save(task);
      }
      await recognizeFrozen(task, task.durationSeconds);
      update(task, 'preview_preparing', { audioPreparedAt: new Date().toISOString(), progress: 0 });
    }
    if (task.status === 'preview_preparing') {
      await requireCapabilities(task);
      // Check the free, task-scoped supplier route before uploading user images.
      if (task.version === 1) await provider.request(`/apimart/seedance2/private-avatar/assets?group=${avatarGroup(task)}`);
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
    if (task.status === 'official_submitting') {
      await requireCapabilities(task);
      const segment = task.segments.find((item) => !item.videoFile);
      if (!segment) { update(task, 'audio_assembling'); }
      else {
        // A lost POST is recovered from its receipt even when the original URL
        // expires later. Only a genuinely new video needs a live audio URL.
        const audioBytes = fs.readFileSync(contained(root, segment.audioFile));
        if (digest(audioBytes) !== segment.audio.sha256) throw fail('digital_human_audio_changed', '冻结配音文件发生变化，尚未提交视频。');
        if (!task.operations?.[videoOperation(segment)]) await ensureAudioUrl(task, segment);
        const bytes = fs.readFileSync(contained(root, task.previewFile));
        if (digest(bytes) !== task.previewRevision) throw fail('digital_human_preview_changed', '确认的场景预览发生变化，尚未提交视频。');
        const request = official.videoRequest({ imageUrl: `data:${imageMime(bytes)};base64,${bytes.toString('base64')}`,
          audioUrl: segment.audioUrl, prompt: audioMedia.segmentPrompt(task, segment, task.segments.indexOf(segment)),
          seconds: segment.generationSeconds || segment.seconds, resolution: '720P', audio: true });
        const response = await operation(task, videoOperation(segment), request.route, request.body, request.headers);
        segment.videoTaskId = official.taskIdOf(response); segment.status = 'generating';
        update(task, 'official_generating', { currentSegmentId: segment.id, progress: 0 });
      }
    }
    if (task.status === 'official_generating') {
      const segment = task.segments.find((item) => item.id === task.currentSegmentId);
      const payload = await official.request(ROUTES.task(segment.videoTaskId)), result = official.normalizePoll(payload);
      if (result.status === 'failed') { await retryFailedSegment(task, segment, result.error); return; }
      if (result.status !== 'completed') return;
      const relative = `${task.id}/${segment.id}.mp4`;
      await official.download(result.videoUrl, contained(root, relative));
      const bytes = fs.readFileSync(contained(root, relative));
      if (bytes.toString('ascii', 4, 8) !== 'ftyp') throw fail('digital_human_video_invalid', '视频下载格式无效，云端任务已保留。');
      segment.videoFile = relative; segment.status = 'completed';
      update(task, task.segments.every((item) => item.videoFile) ? 'audio_assembling' : 'official_submitting', { progress: 0 });
    }
    if (task.status === 'audio_assembling') {
      const baseVideoFile = `${task.id}/base.mp4`, frozenAudioFile = task.frozenAudioFile;
      if (digest(fs.readFileSync(contained(root, frozenAudioFile))) !== task.frozenAudioSha256) throw fail('digital_human_audio_changed', '冻结的完整口播音轨发生变化，不能替换为模型声音。');
      const result = await audioMedia.assemble({ segments: task.segments.map((segment) => ({ seconds: segment.seconds,
        videoPath: contained(root, segment.videoFile), audioPath: contained(root, segment.audioFile), audioSha256: segment.audio.sha256 })),
        destination: contained(root, baseVideoFile), audioDestination: contained(root, frozenAudioFile), ffmpegPath: options.ffmpegPath || 'ffmpeg' });
      update(task, 'packaging', { baseVideoFile, frozenAudioFile, frozenAudioSha256: result.audioSha256, progress: 0 });
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
      update(task, task.videoResolution === '480p' ? 'enhancing' : 'packaging', { progress: 0 });
    }
    if (task.status === 'enhancing') {
      const source = contained(root, task.baseVideoFile);
      const destination = contained(root, `${task.id}/enhanced-1080-size.mp4`);
      await (options.enhanceVideo || upscaleTo1080Size)({ source, destination,
        ffmpegPath: options.ffmpegPath || process.env.XIAOXI_FFMPEG_PATH || 'ffmpeg' });
      if (!fs.existsSync(destination) || fs.statSync(destination).size < 1024) throw fail('digital_human_enhance_failed', '本地放大未完成，480p 原片已保留，可以继续处理。');
      update(task, 'packaging', { baseVideoFile: `${task.id}/enhanced-1080-size.mp4`, enhancement: 'lanczos_resize' });
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
    if (closed || updateHold || global.__xiaoxiUpdateHold || active.has(id)) return active.get(id);
    const promise = Promise.resolve().then(async () => {
      const task = read(id);
      if (!POLLING_STATES.has(task.status) && task.status !== 'outcome_unknown') return;
      try {
        if (task.status === 'outcome_unknown') {
          if (!task.resumeStatus) return;
          if (task.resumeStatus === 'registering') {
            const libraryAssets = await registeredAssets(task);
            if (libraryAssets) update(task, 'video_submitting', { libraryAssets, progress: 0 });
            else update(task, task.resumeStatus);
          } else update(task, task.resumeStatus);
        }
        await advance(task);
      } catch (error) {
        if (error.code === 'UPDATE_IN_PROGRESS') save(task);
        else if (['preview_generating', 'reviewing', 'video_generating', 'official_generating'].includes(task.status)
          && ['digital_human_request_unconfirmed', 'digital_human_response_invalid'].includes(error.code) && !error.outcomeUnknown) {
          // A lost read is still the same remote task. Keep querying after a
          // network interruption or app restart, never buy another video.
          task.error = cleanMessage(error.message); task.errorCode = error.code; save(task);
        } else pause(task, error);
      }
    }).finally(() => active.delete(id));
    active.set(id, promise);
    // Detached timer/submit callers must not create an unhandled rejection if
    // the local disk fails. Explicit refresh still receives this rejection.
    void promise.catch(() => {});
    return promise;
  }
  async function capabilities() {
    const status = await official.capabilities();
    return { ...status, pipelineVersion: 2, durations: [15, 30, 45], resolution: '720p', audioFirst: true,
      scenes: SCENES.map(({ id, name }) => ({ id, name })), voices: VOICES.map(({ id, name }) => ({ id, name })) };
  }
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
    assertCanWork();
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
    assertCanWork();
    assertKeys(input, ['id', 'personAssetId', 'productAssetId', 'sceneId', 'voiceStyle', 'durationSeconds', 'script', 'title', 'templateId', 'musicTrackId', 'budgetCny']);
    const previous = input.id ? read(input.id) : null;
    const version = previous?.version || 2;
    if (input.personAssetId) asset(input.personAssetId);
    if (input.productAssetId) asset(input.productAssetId);
    if (!SCENES.some((s) => s.id === input.sceneId) || !VOICES.some((s) => s.id === input.voiceStyle)
      || !Number.isInteger(input.durationSeconds) || (version === 1 ? input.durationSeconds < 10 || input.durationSeconds > 15 : ![15, 30, 45].includes(input.durationSeconds))) throw fail('digital_human_invalid_options', version === 1 ? '请选择有效场景、声音和10–15秒时长。' : '请选择有效场景、声音和15、30或45秒时长。');
    if (input.templateId && !['topic_fixed', 'key_points'].includes(input.templateId)) throw fail('digital_human_invalid_template', '请选择有效的视频样式。');
    if (input.musicTrackId && !/^music_track_[A-Za-z0-9_-]{1,120}$/u.test(input.musicTrackId)) throw fail('digital_human_invalid_music', '请选择有效的配乐。');
    const script = String(input.script || '').trim();
    if (script.length > (version === 1 ? 160 : 1800)) throw fail('digital_human_script_required', '口播文案过长，请精简后再制作。');
    if (version === 2 && input.budgetCny !== undefined && (!Number.isFinite(input.budgetCny) || input.budgetCny < 0 || input.budgetCny > 10000)) throw fail('digital_human_budget_required', '请设置有效的费用上限（最高10000元）；0元仅保存草稿。');
    if (previous && previous.status !== 'draft') throw fail('digital_human_draft_locked', '这条样片已开始制作，请调整后新建。');
    const task = { ...input, script, title: String(input.title || script.slice(0, 20) || '未命名样片').trim().slice(0, 80),
      videoResolution: previous?.videoResolution || '720p', directorSkillVersion: DIRECTOR_SKILL_VERSION,
      ...(version === 2 ? { narrationPolicy: previous?.narrationPolicy || (!previous ? 'original_script' : undefined) } : {}),
      ...(version === 2 && script ? (previous && previous.narrationPolicy !== 'original_script'
        ? { segments: audioMedia.splitScript(script, input.durationSeconds) }
        : { speechChunks: audioMedia.speechChunks(script), segments: [] }) : {}),
      ...(version === 2 ? { budgetCny: input.budgetCny ?? previous?.budgetCny ?? 0,
        budgetPolicy: input.budgetCny === undefined ? previous?.budgetPolicy || (previous && Number.isFinite(previous.budgetCny) ? 'explicit' : 'quoted_production') : 'explicit' } : {}),
      version, id: previous?.id || `dh_${randomUUID()}`, status: 'draft', createdAt: previous?.createdAt || new Date().toISOString(), operations: {} };
    save(task); return publicTask(task);
  }
  async function preview(id) {
    if (active.has(id)) return publicTask(read(id));
    const task = read(id);
    if (task.status !== 'draft') throw fail('digital_human_preview_already_started', '这条任务已生成预览，请查看现有进度。');
    asset(task.personAssetId); asset(task.productAssetId);
    if (!task.script.trim()) throw fail('digital_human_script_required', '请先填写样片文案。');
    if (task.version === 2 && task.budgetPolicy !== 'quoted_production' && task.budgetCny < 1) throw fail('digital_human_budget_required', '本次制作额度尚未设置，请联系管理员。');
    await requireCapabilities(task);
    if (task.version === 2) await ensurePrices(task);
    update(task, task.version === 2 ? 'audio_preparing' : 'preview_preparing'); void schedule(id); return publicTask(task);
  }
  async function confirm(id, revision) {
    const task = read(id);
    if (task.status !== 'preview_ready' || !revision || revision !== task.previewRevision) throw fail('digital_human_preview_confirmation_required', '请查看当前场景预览后，再确认生成。');
    if (digest(fs.readFileSync(contained(root, task.previewFile))) !== revision) throw fail('digital_human_preview_changed', '场景预览已变化，请重新查看。');
    await requireCapabilities(task); update(task, task.version === 2 ? 'official_submitting' : 'registering', { confirmedAt: new Date().toISOString() }); void schedule(id); return publicTask(task);
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
    if (['digital_human_retry_exhausted', 'digital_human_retry_budget_exceeded'].includes(task.errorCode)) throw fail(task.errorCode, task.error);
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
  function resumePending() {
    if (closed || updateHold || global.__xiaoxiUpdateHold || !fs.existsSync(root)) return;
    for (const id of fs.readdirSync(root).filter((name) => ID.test(name))) {
      try {
        const task = read(id);
        if (POLLING_STATES.has(task.status) || task.status === 'outcome_unknown') void schedule(id);
      } catch { /* Corrupt records stay visible via list(), never overwritten. */ }
    }
  }
  const timer = setInterval(resumePending, 15000);
  timer.unref?.();
  // Resume persisted cloud receipts without requiring the user to open this page.
  const startup = setTimeout(resumePending, 0); startup.unref?.();
  function prepareForUpdate() {
    updateHold = true;
    return { busy: isBusy() };
  }
  function resumeAfterUpdate() { updateHold = false; resumePending(); }
  return { capabilities, importImage, create, preview: admit(preview), confirm: admit(confirm), refresh: admit(refresh), resume: admit(resume), media, images, list, isBusy,
    prepareForUpdate, resumeAfterUpdate,
    get: (id) => publicTask(read(id)),
    close: async () => {
      closed = true; updateHold = true; clearTimeout(startup); clearInterval(timer);
      while (active.size || admissions) {
        await Promise.allSettled([...active.values()]);
        if (admissions) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}
module.exports = { createDigitalHumanService, assertKeys, imageMime, contained, ID, ASSET_ID };
