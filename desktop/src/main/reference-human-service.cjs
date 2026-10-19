const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { writeJsonAtomic } = require('./atomic-file.cjs');
const { fail, cleanMessage } = require('./digital-human-provider.cjs');
const { createBailianVideoProvider, ASYNC_HEADERS, ROUTES } = require('./bailian-video-provider.cjs');
const { contained, assertKeys } = require('./digital-human-service.cjs');
const audioTools = require('./digital-human-audio.cjs');
const mediaTools = require('./reference-human-media.cjs');
const policy = require('../shared/reference-human.json');
const templates = require('../../remotion-packaging/narration-templates.json');
const { round } = require('./product-video-pricing.cjs');
const { createAutomaticVoiceClient } = require('./automatic-voice-client.cjs');
const { createNarrationSources } = require('./narration-sources.cjs');
const costs = require('./reference-human-costs.cjs');
const packaging = require('../../remotion-packaging/narration-plan.cjs');
const vision = require('./narration-vision.cjs');

const TASK_ID = /^rh_[a-f0-9-]{36}$/u, ASSET_ID = /^rha_[a-f0-9-]{36}$/u;
const RUNNING = new Set(['audio_preparing', 'video_submitting', 'video_generating', 'packaging']);
const LABELS = { draft: '待确认制作费用', audio_preparing: '制作本人配音与字幕', preview_ready: '声音已就绪，待确认人物制作',
  video_submitting: '上传人物与口播', video_generating: '生成本人口播', packaging: '合成字幕与配乐', completed: '成片已就绪',
  needs_attention: '需要处理', outcome_unknown: '原请求待核对' };
const ownedSlot = (slot) => ['prepaid', 'free'].includes(slot?.slotType);
const currentVoice = (voice) => voice?.usable === true && (voice.speakerId || voice.model === policy.automaticVoice.model);
const needsNewNarration = (task) => ['digital_human_transcript_mismatch', 'reference_audio_too_long'].includes(task.errorCode);

// Leave room for natural pauses; measured audio remains the authoritative duration.
function narrationPlan(seconds) {
  const maximumSeconds = Math.floor(seconds);
  return { maximumSeconds, minimumSeconds: Math.floor(maximumSeconds * .85),
    maxCharacters: Math.floor((maximumSeconds - 1) * 3.5) };
}

function createReferenceHumanService(options = {}) {
  const root = path.join(options.rootDir, 'reference');
  const provider = options.referenceProvider || createBailianVideoProvider(options);
  const sources = options.narrationSources || createNarrationSources();
  const automaticVoice = options.automaticVoiceClient || createAutomaticVoiceClient({ provider, rootDir: path.join(root, 'voices'), uploadSample: options.uploadReferenceMedia ? (source, hash) => options.uploadReferenceMedia(provider, source, hash, policy.automaticVoice.enrollmentModel) : undefined });
  const media = { ...mediaTools, ...options.referenceMedia }, audio = { ...audioTools, ...options.audioTools };
  const active = new Map(); let closed = false, held = false, admissions = 0;
  const scriptRequests = new Map();
  const DRAFT_KEYS = ['id', 'referenceAssetId', 'script', 'title', 'captionStyleId', 'musicTrackId', 'industry', 'business', 'voiceStyleId', 'emphasisPhrases', 'referenceSource', 'includeCover', 'coverStyle', 'remakeOfTaskId', 'packagingMode', 'soundEffects'];
  const assertOpen = () => { if (closed || held || global.__xiaoxiUpdateHold) throw fail('UPDATE_IN_PROGRESS', '软件正在更新，请稍后继续。'); };
  const admit = (fn) => async (...args) => { assertOpen(); admissions++; try { return await fn(...args); } finally { admissions--; } };
  function read(id, kind = 'tasks') {
    if (!(kind === 'tasks' ? TASK_ID : ASSET_ID).test(String(id || ''))) throw fail('reference_not_found', '请重新选择人物或任务。');
    const item = JSON.parse(fs.readFileSync(contained(root, `${kind}/${id}.json`), 'utf8'));
    if (item.id !== id) throw fail('reference_record_invalid', '记录无法核对，原资料已保留。');
    return item;
  }
  function save(item, kind = 'tasks') { item.updatedAt = new Date().toISOString(); writeJsonAtomic(contained(root, `${kind}/${item.id}.json`), item); }
  const file = (relative) => contained(root, relative);
  function verified(relative, digest) {
    const bytes = fs.readFileSync(file(relative));
    if (media.sha256(bytes) !== digest) throw fail('reference_media_changed', '已保存的人物或音轨发生变化，原任务已保留。');
    return file(relative);
  }
  function publicAsset(item) {
    return { id: item.id, name: item.name, seconds: item.seconds, width: item.width, height: item.height,
      available: fs.existsSync(file(item.videoFile)) && fs.existsSync(file(item.audioFile)),
      previewDataUrl: fs.existsSync(file(item.posterFile)) ? `data:image/jpeg;base64,${fs.readFileSync(file(item.posterFile)).toString('base64')}` : '',
      audioQuality: item.audioQuality, narrationPlan: narrationPlan(item.seconds),
      voiceSampleReady: (item.audioQuality?.activeSeconds ?? Math.min(item.seconds, policy.limits.voiceMaxSeconds)) >= policy.limits.voiceMinSeconds,
      voice: item.voice ? { usable: Boolean(currentVoice(item.voice)), provider: item.voice.provider || 'volcengine' } : null };
  }
  function records(kind) {
    const directory = file(kind);
    return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.json') && (kind === 'tasks' ? TASK_ID : ASSET_ID).test(name.replace(/\.json$/u, ''))).map((name) => read(name.replace(/\.json$/u, ''), kind)) : [];
  }
  const publicTask = (task) => ({ ...Object.fromEntries(['id', 'title', 'script', 'referenceAssetId', 'captionStyleId', 'musicTrackId', 'status', 'error', 'errorCode',
    'createdAt', 'updatedAt', 'progress', 'generatedVideoId', 'actualDurationSeconds', 'quote', 'quoteRevision', 'previewRevision', 'voiceName', 'industry', 'business', 'voiceStyleId', 'emphasisPhrases', 'sourceTaskId', 'remakeOfTaskId', 'referenceSource', 'includeCover', 'coverStyle', 'autoCoverState', 'coverError', 'audioSampleRate', 'videoFailure', 'packagingMode', 'soundEffects', 'packagingPlan'].map((key) => [key, task[key]])),
    costUsage: costs.usage(task), coverQuote: task.coverQuote, coverRequest: task.coverRequest ? { submitted: true, design: task.coverRequest.design } : undefined,
    pipelineVersion: task.version || 3, statusLabel: LABELS[task.status], canRefresh: task.status !== 'completed' || ['planned', 'submitted'].includes(task.autoCoverState),
    canResume: task.status === 'needs_attention' && !needsNewNarration(task) && !Object.values(task.operations || {}).some((op) => op.rejected),
    audioPrepared: Boolean(task.audioPreparedAt), audioAvailable: Boolean(task.audioFile), referenceName: read(task.referenceAssetId, 'assets').name });
  function workspace() {
    const location = file('workspace.json');
    if (!fs.existsSync(location)) return { preferences: {} };
    try { return JSON.parse(fs.readFileSync(location, 'utf8')); }
    catch { throw fail('reference_workspace_invalid', '上次编辑记录无法读取，原文件已保留，请从制作记录打开任务。'); }
  }
  function saveWorkspace(input) {
    assertOpen(); assertKeys(input, ['preferences', 'draft', 'taskId', 'pendingScript', 'suggestion']);
    if (JSON.stringify(input).length > 40000) throw fail('reference_workspace_invalid', '编辑内容过长，请缩短参考文案。');
    assertKeys(input.preferences || {}, ['referenceAssetId', 'captionStyleId', 'musicTrackId', 'includeCover', 'coverStyle', 'packagingMode', 'soundEffects']);
    if (input.draft) assertKeys(input.draft, DRAFT_KEYS);
    if (input.taskId) read(input.taskId);
    if (input.pendingScript) assertKeys(input.pendingScript, ['generationIntentId', 'referenceAssetId', 'industry', 'business', 'referenceSource']);
    if (input.suggestion) assertKeys(input.suggestion, ['title', 'script', 'emphasisPhrases', 'referenceSource']);
    writeJsonAtomic(file('workspace.json'), input);
    return input;
  }
  async function capabilities() {
    try {
      const video = await provider.capabilities();
      if (video.ready && options.gatewayClient) {
        const state = await options.gatewayClient.initialize({ verify: true });
        if (!state.capabilities?.bailian_video) return { ready: false, message: '声音与人物服务暂未连接，仍可导入人物和保存文案。', voiceMode: 'automatic', captionStyles: policy.captionStyles };
      }
      return { ...video, voiceMode: 'automatic', captionStyles: policy.captionStyles };
    }
    catch { return { ready: false, message: '人物服务暂未连接，仍可导入视频和保存草稿。', voiceMode: 'automatic', captionStyles: policy.captionStyles }; }
  }
  async function importVideo(source) {
    const stat = fs.statSync(source);
    if (!stat.isFile() || stat.size < 1 || stat.size > policy.limits.videoMaxBytes) throw fail('reference_video_invalid', '请选择300MB以内的真人视频。');
    const digest = media.sha256(fs.readFileSync(source));
    const existing = records('assets').find((item) => item.sourceSha256 === digest);
    if (existing) { verified(existing.videoFile, existing.videoSha256); verified(existing.audioFile, existing.audioSha256); return publicAsset(existing); }
    const id = `rha_${randomUUID()}`, directory = file(`assets/${id}`);
    let measured;
    try { measured = await media.prepareReference(source, directory, options.ffmpegPath || 'ffmpeg'); }
    catch (error) { if (typeof error.code === 'string') throw error; throw fail('reference_video_decode_failed', '视频读取或转换未完成，请选择能正常播放的本人视频后重试；原片没有改动。'); }
    if (measured.sourceSha256 !== digest) throw fail('reference_source_changed', '原视频在导入时发生变化，请重新选择。');
    const item = { id, name: path.basename(source), ...measured, videoFile: `assets/${id}/reference.mp4`, audioFile: `assets/${id}/voice.wav`, posterFile: `assets/${id}/poster.jpg`,
      voiceSampleReady: Math.min(measured.seconds, policy.limits.voiceMaxSeconds) >= policy.limits.voiceMinSeconds, createdAt: new Date().toISOString() };
    save(item, 'assets'); return publicAsset(item);
  }
  async function trainVoice(input) {
    assertKeys(input, ['assetId', 'speakerId', 'customerConsent']);
    if (input.customerConsent !== true) throw fail('voice_clone_consent_required', '请确认视频和声音来自本人或已获授权。');
    const item = read(input.assetId, 'assets');
    if (Math.min(item.seconds, 30) < 14) throw fail('reference_voice_short', '这条历史声音路线需要至少14秒讲话，请选择更长视频；原视频已保留。');
    if (!options.voiceCloneClient) throw fail('voice_clone_unavailable', '声音复刻服务尚未连接。');
    const inventory = await options.voiceCloneClient.list(), slot = inventory.items.find((s) => s.speakerId === input.speakerId);
    if (!ownedSlot(slot)) throw fail('reference_voice_billing_unknown', '仅使用已核实的预付费或免费音色槽位，不自动使用可能首次合成收费的槽位。');
    if (item.voice?.speakerId && item.voice.speakerId !== input.speakerId) throw fail('reference_voice_locked', '这个人物已经绑定音色，请继续查询原音色，不要重复建立。');
    if (!item.voice) {
      if (!slot.trainable) throw fail('reference_voice_slot_unavailable', '所选音色槽位无法建立新声音，请核对可用槽位。');
      item.voice = { speakerId: input.speakerId, operationId: randomUUID(), status: 'submitting', consentAt: new Date().toISOString() }; save(item, 'assets');
    }
    // A crash or second click reuses the same operation and sample. The voice
    // client recovers its journal instead of training an occupied slot again.
    const result = await options.voiceCloneClient.train({ speakerId: input.speakerId, audioFile: verified(item.audioFile, item.audioSha256), customerConsent: true, operationId: item.voice.operationId });
    item.voice = { ...item.voice, ...result }; save(item, 'assets'); return publicAsset(item);
  }
  async function voiceStatus(assetId) {
    const item = read(assetId, 'assets');
    if (item.voice?.speakerId) { item.voice = { ...item.voice, ...await options.voiceCloneClient.status({ speakerId: item.voice.speakerId }) }; save(item, 'assets'); }
    return publicAsset(item);
  }
  async function writeScript(input) {
    assertKeys(input, ['referenceAssetId', 'industry', 'business', 'referenceSource', 'generationIntentId', 'recoverOnly']);
    if (input.generationIntentId && !/^[a-f0-9-]{36}$/u.test(input.generationIntentId)) throw fail('reference_script_intent_invalid', '写稿操作标识无效，请重新进入文案页面。');
    const identity = media.sha256(Buffer.from(JSON.stringify([input.referenceAssetId, input.industry, input.business, input.referenceSource && [input.referenceSource.platform, input.referenceSource.title, input.referenceSource.body, input.referenceSource.url]])));
    const intentKey = input.generationIntentId ? media.sha256(Buffer.from(JSON.stringify(['included_script_v3', input.generationIntentId]))) : null;
    const receipt = intentKey && fs.existsSync(file(`scripts/${intentKey}.json`)) ? JSON.parse(fs.readFileSync(file(`scripts/${intentKey}.json`), 'utf8')) : null;
    if (receipt?.identity && !input.recoverOnly && receipt.identity !== identity) throw fail('reference_script_intent_changed', '这次写稿资料已变更，请查询原稿或明确选择重新写稿。');
    if (intentKey && input.recoverOnly && !receipt) throw fail('reference_script_not_submitted', '这次写稿没有已提交回执，未产生新的调用。可结束等待后重新确认写稿。');
    let reference = receipt?.reference, body = receipt?.body;
    if (!body) {
      reference = sources.validateReference(input.referenceSource);
      if (reference && !reference.body && reference.url) reference = sources.validateReference(await sources.read({ platform: reference.platform, url: reference.url }));
      const asset = read(input.referenceAssetId, 'assets');
      if (asset.seconds < policy.limits.narrationMinSeconds) throw fail('reference_video_short', `完整口播需要至少${policy.limits.narrationMinSeconds}秒人物视频，未提交写稿。`);
      body = { targetSeconds: narrationPlan(asset.seconds).maximumSeconds, topic: String(input.industry || '').trim(), productFacts: String(input.business || '').trim(), ...(reference ? { reference: { platform: reference.platform, title: reference.title, body: reference.body, url: reference.url } } : {}) };
    }
    const key = intentKey || media.sha256(Buffer.from(JSON.stringify(['included_script_v2', body])));
    if (scriptRequests.has(key)) {
      const current = scriptRequests.get(key);
      if (intentKey && !input.recoverOnly && current.identity !== identity) throw fail('reference_script_intent_changed', '写稿资料已变更，请先核对正在进行的原请求。');
      return current.promise;
    }
    const pending = writeScriptOnce(input, body, key, reference, identity).catch((error) => {
      if (String(error.message).includes('script_response_invalid')) error.message = '云端文案未通过完整性检查，原请求已保留，未自动重试。可以先手填文案；调整资料后重新写稿会使用新的套餐额度。';
      throw error;
    }).finally(() => scriptRequests.delete(key));
    scriptRequests.set(key, { promise: pending, identity }); return pending;
  }
  async function scriptQuota() {
    try { return await provider.request('/narration/script-quota'); }
    catch { return { quota: { status: 'unavailable', remaining: 0, limit: 0, used: 0 } }; }
  }
  async function writeScriptOnce(input, body, fingerprint, reference, identity) {
    assertKeys(input, ['referenceAssetId', 'industry', 'business', 'referenceSource', 'generationIntentId', 'recoverOnly']);
    const industry = body.topic, business = body.productFacts;
    if (!industry || industry.length > 80 || business.length > 2000) throw fail('reference_business_invalid', '请填写行业；产品资料最多2000字。');
    const journal = file(`scripts/${fingerprint}.json`);
    let record = fs.existsSync(journal) ? JSON.parse(fs.readFileSync(journal, 'utf8')) : null;
    if (!record && input.recoverOnly) throw fail('reference_script_not_submitted', '这次写稿没有已提交回执，未产生新的调用。可结束等待后重新确认写稿。');
    const requestHash = media.sha256(Buffer.from(JSON.stringify(body)));
    if (record?.requestHash && record.requestHash !== requestHash) throw fail('reference_script_intent_changed', '这次写稿资料已变更，请查询原稿或明确选择重新写稿。');
    if (record?.rejected) throw fail('reference_script_rejected', '原写稿请求未完成，请调整资料后重新生成，或直接填写文案。不会重发原请求。');
    let response = record?.response;
    if (!response && record) {
      response = await provider.request(`/operations/${record.id}`);
    } else if (!response) {
      const { quota } = await provider.request('/narration/script-quota');
      if (quota?.status !== 'available') throw fail('reference_script_quota_unavailable', quota?.status === 'exhausted' ? '本期写稿额度已用完，可直接填写文案，不会转为付费写稿。' : '套餐写稿额度尚未就绪，可先直接填写文案。');
      record = { id: randomUUID(), createdAt: new Date().toISOString(), included: true, requestHash, body, reference, identity };
      writeJsonAtomic(journal, record);
      try { response = await provider.request('/narration/script', { method: 'POST', operationId: record.id, body }); }
      catch (error) { if (!error.outcomeUnknown) { record.rejected = true; writeJsonAtomic(journal, record); } throw error; }
    }
    if (!response || response.status === 'pending') throw fail('reference_submission_unknown', '原文案请求仍待核对，请稍后查询；不会重复扣写稿额度。', { outcomeUnknown: true });
    if (response.ok !== true || typeof response.title !== 'string' || !response.title.trim() || response.title.length > 24 || typeof response.script !== 'string' || !response.script.trim() || response.script.length > 500) throw fail('reference_script_incomplete', '原写稿结果尚未完整核实，保留原请求，可直接填写文案。');
    const emphasisPhrases = validateEmphasis(response.emphasisPhrases || [], response.script);
    record.response = response; writeJsonAtomic(journal, record);
    // A replayed receipt freezes the wording, not the account's remaining quota.
    const currentQuota = await scriptQuota();
    return { title: response.title, script: response.script, emphasisPhrases, quota: currentQuota.quota, industry, business, referenceSource: reference };
  }
  function create(input) {
    assertOpen(); assertKeys(input, DRAFT_KEYS);
    if (input.remakeOfTaskId) read(input.remakeOfTaskId);
    const asset = read(input.referenceAssetId, 'assets');
    const previous = input.id ? read(input.id) : null;
    if (previous && previous.status !== 'draft') throw fail('reference_task_locked', '任务已开始，请新建口播；原任务与费用记录保留。');
    const script = String(input.script || '').trim();
    if (!script || [...script].length > 500) throw fail('reference_script_invalid', '请填写1—500字的完整口播；实际配音不能长于参考视频。');
    if (String(input.industry || '').length > 80 || String(input.business || '').length > 2000) throw fail('reference_business_invalid', '行业最多80字，产品资料最多2000字。');
    let captionStyleId = input.captionStyleId || templates.defaultTemplateId;
    const packagingMode = input.packagingMode || (input.captionStyleId && !input.captionStyleId.endsWith('_v4') ? 'manual' : 'auto');
    if (!['auto', 'manual'].includes(packagingMode) || input.soundEffects !== undefined && typeof input.soundEffects !== 'boolean') throw fail('reference_packaging_invalid', '请选择智能匹配或手动风格。');
    if (packagingMode === 'auto') captionStyleId = packaging.choose(input).templateId;
    if (![...policy.captionStyles, ...templates.templates].some((s) => s.id === captionStyleId)) throw fail('reference_caption_invalid', '请选择有效的字幕样式。');
    const voiceDelivery = templates.voiceStyles.find((item) => item.id === (input.voiceStyleId || templates.defaultVoiceStyleId));
    if (!voiceDelivery) throw fail('reference_voice_style_invalid', '请选择有效的声音表达方式。');
    const emphasisPhrases = validateEmphasis(input.emphasisPhrases, script);
    if (input.includeCover !== undefined && typeof input.includeCover !== 'boolean') throw fail('reference_cover_invalid', '请选择是否生成AI封面。');
    const coverStyle = input.coverStyle || templates.templates.find((item) => item.id === captionStyleId)?.coverStyle || 'paper';
    if (!templates.coverStyles.some((item) => item.id === coverStyle)) throw fail('reference_cover_invalid', '请选择有效封面风格。');
    if (input.musicTrackId && !/^music_track_[A-Za-z0-9_-]{1,120}$/u.test(input.musicTrackId)) throw fail('reference_music_invalid', '请选择已有曲库中的配乐。');
    const task = { ...input, id: previous?.id || `rh_${randomUUID()}`, version: previous?.version || 5, script,
      packagingMode, soundEffects: input.soundEffects !== false,
      title: String(input.title || script.split(/[，。！？\n]/u)[0]).trim().slice(0, 24), captionStyleId, emphasisPhrases,
      voiceStyleId: voiceDelivery.id, voiceDelivery: { ...voiceDelivery, sampleRate: previous?.version < 4 ? 24000 : 48000 },
      includeCover: input.includeCover ?? !previous, coverStyle, coverStyleExplicit: Boolean(input.coverStyle), referenceSource: sources.validateReference(input.referenceSource),
      referenceSeconds: asset.seconds, status: 'draft', operations: {}, progress: 0, createdAt: previous?.createdAt || new Date().toISOString() };
    save(task); return publicTask(task);
  }
  async function quote(id) {
    const task = read(id);
    if (task.status !== 'draft') return publicTask(task);
    if (task.captionStyleId.endsWith('_v4')) {
      const asset = read(task.referenceAssetId, 'assets');
      const measured = await (options.analyzeNarration || vision.analyze)(verified(asset.videoFile, asset.videoSha256), file('layout-cache'), options.ffmpegPath || 'ffmpeg');
      task.packagingPlan = packaging.buildPlan(task, measured);
      task.captionStyleId = task.packagingPlan.templateId;
      if (task.packagingPlan.blocked) { save(task); throw fail('reference_layout_crowded', '人物占据字幕区域，请换留白更多的素材；未开始付费制作。'); }
      if (!task.coverStyleExplicit) task.coverStyle = templates.templates.find(t => t.id === task.captionStyleId).coverStyle;
    }
    const prices = options.readReferencePrices ? await options.readReferencePrices() : policy.price;
    if (!(prices.videoCnyPerSecond > 0) || !Number.isFinite(Date.parse(prices.checkedAt || prices.checkedOn)) || Date.now() - Date.parse(prices.checkedAt || prices.checkedOn) > 30 * 86400000) throw fail('reference_price_unavailable', '人物驱动报价已过期或无法核实，未提交付费制作。');
    const maximumSeconds = task.version >= 5 ? task.referenceSeconds : task.version >= 4 ? 45 : task.referenceSeconds;
    const videoCny = round(maximumSeconds * prices.videoCnyPerSecond), voiceReserveCny = round(Math.max(1, [...task.script].length * prices.voiceReserveCnyPer10kChars / 10000));
    let coverReserveCny = 0, coverPrices;
    if (task.includeCover) {
      coverPrices = await options.readCoverPrices?.();
      if (!(coverPrices?.imageUsd > 0 && coverPrices.fxCnyPerUsd > 0)) throw fail('reference_cover_price_unavailable', '未取得封面报价，可取消AI封面后制作视频。');
      coverReserveCny = round(coverPrices.imageUsd * coverPrices.fxCnyPerUsd);
    }
    const asset = read(task.referenceAssetId, 'assets');
    task.voiceProvider = asset.voice?.speakerId ? 'volcengine' : 'bailian';
    const enrollmentReserveCny = task.voiceProvider === 'bailian' && !currentVoice(asset.voice) ? policy.automaticVoice.enrollmentReserveCny : 0;
    task.quote = { schemaVersion: task.version >= 4 ? 3 : 2, maximumSeconds, coverReserveCny, coverStyle: task.coverStyle, voiceProvider: task.voiceProvider, voiceModel: task.voiceProvider === 'bailian' ? policy.automaticVoice.model : '', enrollmentReserveCny,
      maximumCny: round(videoCny + voiceReserveCny + prices.asrReserveCny + enrollmentReserveCny + coverReserveCny), videoCny, voiceReserveCny,
      asrReserveCny: prices.asrReserveCny, videoCnyPerSecond: prices.videoCnyPerSecond,
      estimate: costs.estimate(task.script, maximumSeconds, prices, coverPrices, task.voiceProvider === 'bailian', task.version >= 5 ? narrationPlan(maximumSeconds).minimumSeconds : undefined),
      note: prices.note, source: prices.source, checkedAt: prices.checkedAt || prices.checkedOn };
    task.quoteRevision = media.sha256(Buffer.from(JSON.stringify([task.script, task.referenceAssetId, task.captionStyleId, task.title, task.musicTrackId || '', task.voiceDelivery || null, task.emphasisPhrases || [], task.packagingMode || null, task.packagingPlan || null, task.soundEffects ?? null, task.quote])));
    save(task); return publicTask(task);
  }
  function recordVideoFailure(task, response) {
    const output = response?.output || response?.data?.output || response;
    const text = (value) => cleanMessage(String(value || '').slice(0, 1000));
    task.videoFailure = { taskId: task.videoTaskId, requestId: text(response?.request_id),
      code: text(output?.code), message: text(output?.message), observedAt: new Date().toISOString() };
    const reason = task.videoFailure.code === 'DataInspectionFailed'
      ? '供应商输入内容审核未通过（DataInspectionFailed），未说明具体触发项。请先提供云端任务号核查，不要直接重复生成。'
      : `人物生成失败：${task.videoFailure.message || task.videoFailure.code || '服务未说明原因'}。`;
    task.error = `${reason} 原配音和回执已保留，不会自动重试扣费。`;
    save(task); return task.error;
  }
  function transition(task, status, values = {}) { Object.assign(task, { status, error: '', errorCode: '' }, values); save(task); }
  async function operation(task, name, execute, reserveCny) {
    assertOpen(); const prior = task.operations[name];
    if (prior?.response) return prior.response;
    if (prior?.rejected) throw fail('reference_request_rejected', '原请求已明确失败，请修改后新建；不会自动重复购买。');
    if (prior && !execute.recover) {
      const result = await provider.request(`/operations/${prior.id}`);
      if (!result || result.status === 'pending') throw fail('reference_submission_unknown', '原请求尚未核对完成，请继续查询；不会重新提交。', { outcomeUnknown: true });
      prior.response = result; save(task); return result;
    }
    const entry = prior || { id: randomUUID(), reserveCny, submittedAt: new Date().toISOString() };
    if (!prior) {
      if (!task.approvedQuoteRevision || round(Object.values(task.operations).reduce((sum, op) => sum + (op.reserveCny || 0), 0) + reserveCny) > task.approvedMaximumCny) throw fail('reference_budget_exceeded', '费用超出已确认上限，已停止，现有结果保留。');
      task.operations[name] = entry; save(task);
    }
    try { entry.response = await execute(entry.id); save(task); return entry.response; }
    catch (error) { if (!error.outcomeUnknown && !error.retrySafe) entry.rejected = true; save(task); throw error; }
  }
  async function prepare(id, revision, customerConsent = false, generateVideo = false) {
    const task = read(id);
    if (task.status !== 'draft' || !revision || revision !== task.quoteRevision) throw fail('reference_quote_confirmation_required', '请先查看当前文案的费用并点击确认。');
    if (Date.now() - Date.parse(task.quote?.checkedAt) > 86400000 || !Number.isFinite(Date.parse(task.quote?.checkedAt))) throw fail('reference_price_unavailable', '这份报价已过期，请重新核价后确认。');
    const asset = read(task.referenceAssetId, 'assets');
    if (![2, 3].includes(task.quote?.schemaVersion) || task.quote.voiceProvider !== task.voiceProvider) throw fail('reference_quote_confirmation_required', '声音制作方式已更新，请重新查看费用后确认。');
    const minimumReferenceSeconds = task.version >= 5 ? policy.limits.narrationMinSeconds : 45;
    if (task.version >= 4 && generateVideo && asset.seconds < minimumReferenceSeconds) throw fail('reference_video_short', `本任务需要至少${minimumReferenceSeconds}秒人物视频，未提交配音或人物生成。旧草稿可新建口播，按素材时长重新规划。`);
    if (task.packagingPlan?.blocked) throw fail('reference_layout_crowded', '当前素材没有足够字幕空间，未开始付费制作。');
    if (task.voiceProvider === 'bailian' && task.quote.voiceModel !== policy.automaticVoice.model) throw fail('reference_quote_confirmation_required', '本人配音服务已更新，请重新查看费用后确认。');
    if (!customerConsent && !asset.voice?.consentAt) throw fail('voice_clone_consent_required', '请确认视频和声音来自本人或已获授权。');
    if (Math.min(asset.seconds, policy.limits.voiceMaxSeconds) < policy.limits.voiceMinSeconds) throw fail('reference_voice_short', '声音样本需要至少5秒清晰讲话，建议上传10—30秒本人视频。');
    if (task.voiceProvider === 'volcengine') {
      const slots = await options.voiceCloneClient.list();
      if (!asset.voice?.usable || !ownedSlot(slots.items.find((s) => s.speakerId === asset.voice.speakerId))) throw fail('reference_voice_billing_unknown', '已有本人声音状态无法核实，未开始付费制作。');
    }
    const state = await provider.capabilities(); if (!state.ready) throw fail('reference_provider_unavailable', state.message);
    if (options.gatewayClient) {
      const gateway = await options.gatewayClient.initialize({ verify: true });
      if (!gateway.capabilities?.volcengine_asr || task.voiceProvider === 'volcengine' && !gateway.capabilities?.volcengine_voice_clone) throw fail('reference_preparation_unavailable', '本人声音或字幕识别服务尚未连接，未开始付费制作。');
      if (task.voiceProvider === 'bailian') {
        if (!gateway.capabilities?.bailian_video) throw fail('reference_preparation_unavailable', '声音与人物服务暂未连接，未提交付费制作。');
        const models = await provider.request(`/bailian/api/v1/models?model=${encodeURIComponent(policy.automaticVoice.model)}`);
        if (!models.output?.models?.some((model) => model.model === policy.automaticVoice.model)) throw fail('reference_voice_model_unavailable', '当前服务没有可用的本人配音模型，未建立声音或提交付费制作。');
      }
    }
    // This page uses automatic music. Re-select from the current validated
    // catalog even when a historical draft carried an old track ID.
    const music = await options.selectMusic?.({ durationSeconds: task.referenceSeconds });
    if (!music?.trackId) throw fail('reference_music_not_ready', '没有可用配乐，请先在曲库中准备可用音乐；未提交配音或人物生成。');
    task.musicTrackId = music.trackId;
    task.musicSelected = true;
    task.approvedQuoteRevision = revision; task.approvedMaximumCny = task.quote.maximumCny;
    task.voicePersonaId = asset.voice?.speakerId;
    task.customerConsentAt = new Date().toISOString();
    task.autoGenerateVideo = generateVideo === true;
    transition(task, 'audio_preparing'); void schedule(id); return publicTask(task);
  }
  async function advance(task) {
    if (task.status === 'audio_preparing') {
      const asset = read(task.referenceAssetId, 'assets');
      let sound;
      if (task.voiceProvider === 'bailian') {
        if (!currentVoice(asset.voice)) {
          const enroll = (operationId) => automaticVoice.enroll({ assetId: asset.id, audioFile: verified(asset.audioFile, asset.audioSha256), audioSha256: asset.audioSha256, operationId });
          enroll.recover = true;
          const voice = { ...await operation(task, 'voice_enrollment', enroll, task.quote.enrollmentReserveCny), consentAt: task.customerConsentAt };
          if (asset.voice) asset.voiceHistory = [...(asset.voiceHistory || []), asset.voice];
          asset.voice = voice;
          save(asset, 'assets');
        }
        const response = await operation(task, 'voice', (operationId) => automaticVoice.synthesize({ voice: asset.voice, text: task.script, operationId, delivery: task.voiceDelivery }), task.quote.voiceReserveCny);
        const rawFile = file(`tasks/${task.id}/narration.wav`);
        fs.mkdirSync(path.dirname(rawFile), { recursive: true });
        sound = task.audioFile ? null : await automaticVoice.materialize(response, rawFile);
      } else {
        const synthesize = (operationId) => options.voiceCloneClient.synthesize({ speakerId: task.voicePersonaId, text: task.script, operationId });
        synthesize.recover = true;
        sound = await operation(task, 'voice', synthesize, task.quote.voiceReserveCny);
      }
      const relative = `tasks/${task.id}/speech.wav`;
      if (!task.audioFile) {
        if (media.sha256(fs.readFileSync(sound.file)) !== sound.audio_digest) throw fail('reference_audio_changed', '配音摘要不一致，原回执已保留。');
        fs.mkdirSync(path.dirname(file(relative)), { recursive: true });
        const frozen = await audio.freezeAudio({ segments: [{ audioPath: sound.file, audioSha256: sound.audio_digest, preserveDuration: true }], destination: file(relative), preserveNativeRate: task.version >= 4, ffmpegPath: options.ffmpegPath || 'ffmpeg' });
        task.audioFile = relative; task.audioSha256 = frozen.sha256; task.audioSampleRate = frozen.sampleRate; save(task);
      }
      if (task.version >= 4 && !task.asrAudioFile) {
        const relativeAsr = `tasks/${task.id}/recognition.wav`;
        const copy = await audio.createAsrCopy({ source: verified(task.audioFile, task.audioSha256), destination: file(relativeAsr), ffmpegPath: options.ffmpegPath || 'ffmpeg' });
        task.asrAudioFile = relativeAsr; task.asrAudioSha256 = copy.sha256; save(task);
      }
      const measured = await audio.measureAudio({ source: verified(task.audioFile, task.audioSha256), ffmpegPath: options.ffmpegPath || 'ffmpeg' });
      if (measured.seconds <= policy.limits.minSeconds || measured.seconds >= policy.limits.maxSeconds || measured.seconds > Math.min(task.referenceSeconds, task.quote.maximumSeconds || task.referenceSeconds)) throw fail('reference_audio_too_long', `实际配音${measured.seconds.toFixed(1)}秒，可用人物时长${Math.min(task.referenceSeconds, task.quote.maximumSeconds || task.referenceSeconds).toFixed(1)}秒。请缩短文案或补充更长参考视频；已有配音保留，未购买人物视频，不会加速或倒放人物。`);
      task.actualDurationSeconds = measured.seconds; save(task);
      const asr = await operation(task, 'asr', (operationId) => provider.request('/volcengine/asr/recognize/flash', { method: 'POST', operationId,
        headers: { 'X-Api-Resource-Id': 'volc.bigasr.auc_turbo', 'X-Api-Sequence': '-1', 'X-Api-Request-Id': operationId },
        body: { user: { uid: 'xiaoxi-reference-human' }, audio: { data: fs.readFileSync(verified(task.asrAudioFile || task.audioFile, task.asrAudioSha256 || task.audioSha256)).toString('base64') }, request: { model_name: 'bigmodel', show_utterances: true, show_words: true, enable_punc: true } } }), task.quote.asrReserveCny);
      const utterances = (asr.result || asr.data?.result || asr.data || asr).utterances;
      const verification = audio.verifyTranscript(utterances, task.script, measured.seconds);
      task.utterances = verification.alignedUtterances || utterances;
      task.previewRevision = media.sha256(Buffer.from(JSON.stringify([task.audioSha256, task.utterances, task.referenceAssetId, task.approvedQuoteRevision])));
      transition(task, task.autoGenerateVideo ? 'video_submitting' : 'preview_ready', { audioPreparedAt: new Date().toISOString(), voiceName: '我的专属声音', progress: 25 });
    }
    if (task.status === 'video_submitting') {
      const asset = read(task.referenceAssetId, 'assets');
      verified(task.audioFile, task.audioSha256); verified(asset.videoFile, asset.videoSha256);
      for (const [key, source, hash] of [['videoUpload', asset.videoFile, asset.videoSha256], ['audioUpload', task.audioFile, task.audioSha256]]) {
        if (!task[key] || Date.parse(task[key].expiresAt) <= Date.now() + 300000) { task[key] = await (options.uploadReferenceMedia || media.uploadReferenceMedia)(provider, file(source), hash); save(task); }
      }
      const response = await operation(task, 'video', (operationId) => provider.request('/bailian/api/v1/services/aigc/image2video/video-synthesis', {
        method: 'POST', operationId, headers: { ...ASYNC_HEADERS, 'X-DashScope-OssResourceResolve': 'enable' },
        body: { model: policy.model, input: { video_url: task.videoUpload.url, audio_url: task.audioUpload.url }, parameters: { video_extension: false } } }), round(task.actualDurationSeconds * task.quote.videoCnyPerSecond));
      const taskId = provider.taskIdOf(response);
      if (!taskId) throw fail('reference_submission_unknown', '生成请求已发出但未取得任务编号，请查询原回执；不会重提。', { outcomeUnknown: true });
      transition(task, 'video_generating', { videoTaskId: taskId, progress: 40 });
    }
    if (task.status === 'video_generating') {
      const response = await provider.request(ROUTES.task(task.videoTaskId)), result = provider.normalizePoll(response);
      if (result.status === 'failed') {
        task.operations.video.rejected = true; save(task);
        throw fail('reference_video_failed', recordVideoFailure(task, response));
      }
      if (result.status !== 'completed') return;
      if (!result.videoUrl) throw fail('reference_result_missing', '原生成任务未返回视频地址，请继续查询原任务。');
      const source = `tasks/${task.id}/cloud.mp4`, base = `tasks/${task.id}/base.mp4`;
      if (!task.baseVideoFile) {
        await provider.download(result.videoUrl, file(source));
        await media.freezeDrivenVideo(file(source), verified(task.audioFile, task.audioSha256), file(base), task.actualDurationSeconds, options.ffmpegPath || 'ffmpeg');
        task.baseVideoFile = base; save(task);
      }
      transition(task, 'packaging', { progress: 70 });
    }
    if (task.status === 'packaging') {
      if (!task.packagingTaskId) {
        if (task.captionStyleId.endsWith('_v4') && !task.packagingPlan?.finalized) {
          const measured = await (options.analyzeNarration || vision.analyze)(file(task.baseVideoFile), file('layout-cache'), options.ffmpegPath || 'ffmpeg');
          task.packagingPlan = { ...packaging.buildPlan(task, measured, task.utterances, true), finalized: true }; save(task);
        }
        if (task.packagingPlan?.blocked) throw fail('reference_layout_crowded', '画面没有足够的字幕空间，或长句缺少可靠分词时间。原片已保留，请调整素材或字幕后重新本地包装；不会重新购买人物。');
        if (!task.musicSelected) {
          if (!task.musicTrackId) { const selected = await options.selectMusic?.({ durationSeconds: task.actualDurationSeconds }); task.musicTrackId = selected?.trackId || ''; task.musicNote = selected?.message || ''; }
          task.musicSelected = true; save(task);
        }
        const result = await options.packageVideo({ source_id: `digital_human_${task.id.slice(3)}`, input_video_path: file(task.baseVideoFile),
          title: task.title, confirmed_script: task.script, template_id: 'topic_fixed', caption_style_id: task.captionStyleId, cover_mode: 'local_frame',
          emphasis_phrases: task.emphasisPhrases || [],
          ...(task.packagingPlan ? { narration_plan: task.packagingPlan } : {}),
          ...(task.version >= 4 ? { audio_profile: 'narration_v2' } : {}),
          prepared_transcript: { utterances: task.utterances, time_unit: 'ms', source_sha256: media.sha256(fs.readFileSync(file(task.baseVideoFile))) },
          ...(task.musicTrackId ? { music_track_id: task.musicTrackId } : {}) });
        if (!result?.task_id) throw fail('reference_packaging_unavailable', '人物视频已保留，包装服务暂未返回任务。');
        task.packagingTaskId = result.task_id; save(task);
      }
      const result = await options.queryPackaging(task.packagingTaskId);
      if (['failed', 'paused', 'cancelled', 'needs_attention', 'outcome_unknown'].includes(result?.status)) throw fail(result.error_code || 'reference_packaging_failed', result.error_message || '包装未完成，请继续处理；人物视频不会重新生成。', { outcomeUnknown: result.status === 'outcome_unknown' });
      if (result?.status === 'completed') {
        const generatedVideoId = result.generated_video_id || result.result?.generated_video_id || result.output?.generated_video_id;
        if (!generatedVideoId) throw fail('reference_result_missing', '成片编号尚未登记，请继续查询包装任务。');
        if (task.includeCover && !task.sourceTaskId) {
          task.coverRequest = { revision: task.approvedQuoteRevision, requestId: randomUUID(), design: coverDesign(task, { title: task.title, style: task.quote.coverStyle, frameSeconds: 0 }) };
          task.autoCoverState = 'planned';
        }
        transition(task, 'completed', { generatedVideoId, progress: 100 });
        if (task.includeCover && !task.sourceTaskId) await automaticCover(task, false);
      }
    }
  }
  function schedule(id) {
    if (closed || held || global.__xiaoxiUpdateHold || active.has(id)) return active.get(id);
    const promise = Promise.resolve().then(async () => {
      const task = read(id);
      if (task.status === 'completed' && ['planned', 'submitted'].includes(task.autoCoverState)) return automaticCover(task, true);
      if (!RUNNING.has(task.status)) return;
      try { await advance(task); }
      catch (error) { const resumeStatus = task.status; transition(task, error.outcomeUnknown ? 'outcome_unknown' : 'needs_attention', { resumeStatus, error: cleanMessage(error.message), errorCode: error.code || 'reference_step_failed' }); }
    }).finally(() => active.delete(id));
    active.set(id, promise); void promise.catch(() => {}); return promise;
  }
  function validateEmphasis(value = [], script) {
    if (!Array.isArray(value) || value.length > 12 || value.some((text) => typeof text !== 'string' || !text.trim() || text.length > 24 || !script.includes(text))) throw fail('reference_emphasis_invalid', '强调短语须来自口播原文，每项最多24字，最多12项。');
    return [...new Set(value)];
  }
  async function repackage(id, input) {
    assertKeys(input, ['captionStyleId', 'emphasisPhrases', 'title', 'nextStyle', 'soundEffects']);
    const source = read(id);
    if (source.status !== 'completed' || !source.baseVideoFile || !source.utterances) throw fail('reference_repackage_unavailable', '请先完成当前口播，再更换模板。');
    if (input.nextStyle) {
      const candidates = source.packagingPlan?.candidates || packaging.choose(source).candidates;
      input = { ...input, captionStyleId: candidates[(candidates.indexOf(source.captionStyleId) + 1) % candidates.length] };
    }
    if (input.soundEffects !== undefined && typeof input.soundEffects !== 'boolean') throw fail('reference_packaging_invalid', '音效设置无效。');
    if (!templates.templates.some((item) => item.id === input.captionStyleId)) throw fail('reference_caption_invalid', '请选择有效的网感模板。');
    verified(source.audioFile, source.audioSha256);
    const task = { ...source, id: `rh_${randomUUID()}`, version: (templates.templates.find((item) => item.id === input.captionStyleId)?.version || 1) >= 2 ? Math.max(4, source.version || 3) : source.version, sourceTaskId: id, packagingMode: 'manual', packagingPlan: undefined, soundEffects: input.soundEffects ?? source.soundEffects ?? true, captionStyleId: input.captionStyleId, includeCover: false, autoCoverState: undefined, coverError: undefined,
      emphasisPhrases: validateEmphasis(input.emphasisPhrases ?? source.emphasisPhrases, source.script), title: String(input.title || source.title).trim().slice(0, 24),
      packagingTaskId: '', generatedVideoId: '', coverQuote: undefined, coverRequest: undefined, createdAt: new Date().toISOString() };
    transition(task, 'packaging', { progress: 70 }); void schedule(task.id); return publicTask(task);
  }
  function coverDesign(task, value) {
    assertKeys(value, ['title', 'style', 'frameSeconds']);
    const title = String(value.title || '').trim();
    if (!title || title.length > 24 || !templates.coverStyles.some((item) => item.id === value.style)
        || !Number.isFinite(value.frameSeconds) || value.frameSeconds < 0 || value.frameSeconds >= task.actualDurationSeconds) throw fail('reference_cover_invalid', '请填写24字以内标题，选择封面风格及视频范围内的人物帧。');
    return { mode: 'full_design', aspect: '3:4', title, style: value.style, frame_seconds: value.frameSeconds };
  }
  async function coverFrame(id, seconds) {
    const task = read(id);
    if (!task.baseVideoFile || !Number.isFinite(seconds) || seconds < 0 || seconds >= task.actualDurationSeconds) throw fail('reference_cover_invalid', '请在已生成视频的时间范围内选择画面。');
    return { previewDataUrl: await media.framePreview(file(task.baseVideoFile), seconds, options.ffmpegPath || 'ffmpeg') };
  }
  async function coverQuote(id, input) {
    const task = read(id);
    if (task.status !== 'completed') throw fail('reference_cover_not_ready', '请先完成口播，再制作AI封面。');
    const current = await options.getGeneratedVideo(task.generatedVideoId);
    const status = current.cover_status || current.coverStatus;
    const design = coverDesign(task, input);
    if (['submitted', 'outcome_unknown'].includes(status) || status === 'planned' && JSON.stringify(task.coverRequest?.design) !== JSON.stringify(design)) throw fail('reference_cover_pending', '原封面仍需处理，请先查询原任务或继续原方案。');
    const prices = await options.readCoverPrices();
    if (!(prices.imageUsd > 0 && prices.fxCnyPerUsd > 0)) throw fail('reference_cover_price_unavailable', '未取得有效封面报价，未提交生成。');
    task.coverQuote = { revision: randomUUID(), design, maximumCny: round(prices.imageUsd * prices.fxCnyPerUsd),
      estimatedCny: (prices.estimatedImageUsd || prices.imageUsd) * prices.fxCnyPerUsd,
      checkedAt: new Date().toISOString(), note: '1张AI整图，按美元公开价与预算汇率折算；实际扣费以账单为准。',
      ...(status === 'planned' ? { resumeRequestId: task.coverRequest.requestId } : {}) };
    save(task); return publicTask(task);
  }
  async function generateCover(id, revision, recover = false) {
    const task = read(id);
    if (task.status !== 'completed') throw fail('reference_cover_not_ready', '请先完成口播。');
    if (!recover) {
      const quote = task.coverQuote;
      if (!quote || revision !== quote.revision || Date.now() - Date.parse(quote.checkedAt) > 3600000) throw fail('reference_cover_confirmation_required', '请重新查看当前封面费用后确认。');
      if (task.coverRequest?.revision !== revision) {
        task.coverRequest = { revision, requestId: quote.resumeRequestId || randomUUID(), design: quote.design }; save(task);
      }
    }
    if (!task.coverRequest) throw fail('reference_cover_not_found', '尚无可恢复的封面请求。');
    const { requestId, design } = task.coverRequest;
    await options.generateCover(task.generatedVideoId, { ...design, request_id: requestId }, { recoverOnly: recover });
    return publicTask(task);
  }
  async function automaticCover(task, recover) {
    // Video completion is durable before the cover; never repeat paid video on a cover failure.
    try {
      if (!recover) {
        const reserve = task.quote?.coverReserveCny;
        const spent = Object.values(task.operations).reduce((sum, op) => sum + (op.reserveCny || 0), 0);
        if (!(reserve > 0) || round(spent + reserve) > task.approvedMaximumCny) throw fail('reference_budget_exceeded', '封面超出已确认费用，已停止；视频可直接下载。');
      }
      if (!task.coverRequest) return;
      if (recover) {
        const current = await options.getGeneratedVideo(task.generatedVideoId);
        const state = current.cover_status || current.coverStatus;
        const issue = current.cover_issue_message || current.coverIssueMessage;
        if (state === 'planned' && !issue) return;
        if (issue && state === 'planned') throw Error(issue);
      }
      await options.generateCover(task.generatedVideoId, { ...task.coverRequest.design, request_id: task.coverRequest.requestId }, { recoverOnly: recover });
      const result = await options.getGeneratedVideo(task.generatedVideoId);
      const state = result.cover_status || result.coverStatus;
      task.autoCoverState = state === 'completed' || state === 'ready' ? 'completed' : ['failed', 'cancelled', 'needs_attention'].includes(state) ? 'needs_attention' : state === 'planned' ? 'planned' : 'submitted';
      task.coverError = result.cover_issue_message || result.coverIssueMessage || '';
      save(task);
    } catch (error) {
      task.autoCoverState = 'needs_attention'; task.coverError = cleanMessage(error.message || '封面未完成，可查询原请求，视频可直接下载。'); save(task);
    }
  }
  async function confirm(id, revision) {
    const task = read(id);
    if (task.status !== 'preview_ready' || !revision || revision !== task.previewRevision) throw fail('reference_confirmation_required', '请试听本次完整声音后，确认当前人物制作。');
    verified(task.audioFile, task.audioSha256); transition(task, 'video_submitting'); void schedule(id); return publicTask(task);
  }
  async function refresh(id) {
    const task = read(id);
    if (task.status === 'needs_attention' && task.operations?.video?.rejected && task.videoTaskId && !task.videoFailure) {
      const response = await provider.request(ROUTES.task(task.videoTaskId));
      if (provider.normalizePoll(response).status === 'failed') recordVideoFailure(task, response);
    }
    // Read-only recovery of a submitted operation. No new operation is admitted
    // by refreshing an unapproved draft or terminal cloud failure.
    if (task.status === 'outcome_unknown' && task.resumeStatus) transition(task, task.resumeStatus);
    await schedule(id); return publicTask(read(id));
  }
  async function resume(id) {
    const task = read(id);
    if (task.status !== 'needs_attention' || !task.resumeStatus || needsNewNarration(task) || Object.values(task.operations).some((op) => op.rejected)) throw fail('reference_resume_invalid', '请先处理配音或输入问题，再新建口播并确认费用；原任务与已有结果保留，不会重新购买。');
    if (task.resumeStatus === 'packaging' && task.packagingTaskId) {
      const result = await options.queryPackaging(task.packagingTaskId);
      if (['failed', 'paused', 'cancelled'].includes(result?.status)) task.packagingTaskId = '';
    }
    transition(task, task.resumeStatus); await schedule(id); return publicTask(read(id));
  }
  function pending() { if (!closed && !held && !global.__xiaoxiUpdateHold) for (const task of records('tasks')) if (RUNNING.has(task.status) || task.status === 'completed' && ['planned', 'submitted'].includes(task.autoCoverState)) void schedule(task.id); }
  const timer = setInterval(pending, 5000); timer.unref?.();
  const startup = setTimeout(pending, 0); startup.unref?.();
  return { capabilities, workspace, saveWorkspace, scriptQuota, sourceStatus: sources.status, sourceConnect: sources.connect, sourceSearch: sources.search, sourceRead: sources.read, importVideo: admit(importVideo), assets: () => ({ items: records('assets').map(publicAsset) }),
    trainVoice: admit(trainVoice), voiceStatus: admit(voiceStatus), writeScript: admit(writeScript), create, quote: admit(quote), prepare: admit(prepare), confirm: admit(confirm), refresh: admit(refresh), resume: admit(resume), repackage: admit(repackage), coverFrame: admit(coverFrame), coverQuote: admit(coverQuote), generateCover: admit(generateCover),
    list: () => ({ items: records('tasks').map(publicTask).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }), get: (id) => publicTask(read(id)),
    speechMedia: (id) => { const task = read(id); return { audioDataUrl: `data:audio/wav;base64,${fs.readFileSync(verified(task.audioFile, task.audioSha256)).toString('base64')}` }; },
    isBusy: () => active.size > 0 || admissions > 0,
    prepareForUpdate: () => { held = true; return { busy: active.size > 0 || admissions > 0 }; }, resumeAfterUpdate: () => { held = false; pending(); },
    close: async () => { closed = true; held = true; sources.close?.(); clearInterval(timer); clearTimeout(startup); while (active.size || admissions) { await Promise.allSettled([...active.values()]); if (admissions) await new Promise((resolve) => setTimeout(resolve, 10)); } } };
}
module.exports = { createReferenceHumanService, TASK_ID, ASSET_ID };
