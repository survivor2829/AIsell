const { reconcileNarrationSpelling } = require('./narration-transcript.cjs');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { writeJsonAtomic } = require('./atomic-file.cjs');
const { createDigitalHumanProvider, cleanMessage, fail, remoteUrl } = require('./digital-human-provider.cjs');
const { withBillingJob } = require('./provider-gateway-client.cjs');
const wan = require('./bailian-video-provider.cjs');
const { planVideo, SCENES, SURFACES, DIRT, GOALS, FACT_LIMIT } = require('./video-directors.cjs');
const { createPriceReader, validPrices, quotePlan, round } = require('./product-video-pricing.cjs');
const mediaTools = require('./product-video-media.cjs');
const story = require('./story-video-director.cjs');
const real = require('./real-shoot-director.cjs');
const sceneCatalog = require('./scene-video-catalog.cjs');
const { estimateTask, recordTiming, readTimings } = require('./product-video-eta.cjs');
// Shots of one video made at the same time (each is its own Wan3 task); more wait for a free slot.
const SHOT_SLOTS = 3, IMAGE_SLOTS = 4;
const ASR_RETRY_ERRORS = new Set(['product_video_asr_failed', 'product_video_caption_timing_missing', 'product_video_caption_words_missing',
  'product_video_caption_words_mismatch', 'product_video_caption_words_invalid', 'product_video_caption_out_of_bounds', 'product_video_caption_overlap', 'product_video_caption_too_long']);
const { upscaleTo1080Size } = require('./video-upscale.cjs');
const TASK_ID = /^pv_[a-f0-9-]{36}$/u, IMAGE_ID = /^pva_[a-f0-9-]{36}$/u;
const RUNNING = new Set(['imaging', 'writing_story', 'composing', 'uploading', 'preparing_frames', 'frame_generating', 'locking_frames', 'preparing_audio', 'submitting', 'generating', 'assembling', 'enhancing', 'transcribing', 'packaging']);
const LABELS = { draft: '方案已保存', uploading: '上传产品图', preparing_frames: '准备场景首帧', frame_generating: '生成场景首帧', locking_frames: '锁定全部场景首帧', preparing_audio: '准备整片声音', submitting: '提交镜头', generating: '生成镜头', assembling: '合成画面与整片声音', enhancing: '本地放大画面', transcribing: '识别实际对白', packaging: '渲染大字字幕', completed: '成片已就绪', needs_attention: '需要处理', outcome_unknown: '请求待核对',
  awaiting_sheet: '请确认定妆照', writing_story: 'AI 正在写故事', composing: '拼分镜' };
// 剧情版 image steps, in the order they are made after the 定妆照 is confirmed.
const storyImageKeys = (segments) => ['scene', 'floor', 'person_a', 'person_b',
  ...Array.from({ length: segments }, (_, s) => Array.from({ length: story.SHOTS_PER_SEGMENT }, (_, k) => `frame_${s}_${k}`)).flat()];
const IMAGE_LABEL = { sheet: '定妆照', scene: '场景图', floor: '地面对照图', person_a: '人物', person_b: '人物', plate: '场景图' };
const shotPipeline = (task) => task.plan.pipelineVersion >= 5;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const publicMusic = (music) => music ? { status: music.status === 'ready' ? 'ready' : 'unavailable',
  source: cleanMessage(music.source || ''), message: cleanMessage(music.message || ''),
  trackId: typeof music.trackId === 'string' ? music.trackId : undefined, sha256: /^[a-f0-9]{64}$/u.test(music.sha256 || '') ? music.sha256 : undefined } : null;
function contained(root, relative) {
  const full = path.resolve(root, relative), rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw fail('product_video_path_invalid', '任务文件路径无效。');
  return full;
}
function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw fail('product_video_image_invalid', '请使用 JPG、PNG 或 WebP 产品图片。');
}
function hold() { if (global.__xiaoxiUpdateHold) throw fail('product_video_update_pending', '正在准备更新，请更新完成后继续制作。'); }
function createProductVideoService(options = {}) {
  const root = path.resolve(options.rootDir || '');
  if (!options.rootDir || root === path.parse(root).root) throw fail('product_video_storage_invalid', '视频存储目录无效。');
  const provider = options.provider || createDigitalHumanProvider(options);
  const readPrices = options.readPrices || createPriceReader();
  const media = { ...mediaTools, ...options.mediaTools };
  const ffmpegPath = options.ffmpegPath || process.env.XIAOXI_FFMPEG_PATH || 'ffmpeg';
  const active = new Map(), timers = new Map(), admissionsByTask = new Set();
  let closed = false, updatePaused = false, admissions = 0;
  const runnable = (task) => RUNNING.has(task.status) || task.status === 'outcome_unknown';
  function ensureRunning() {
    hold();
    if (updatePaused || closed) throw fail('product_video_update_pending', '正在保存任务，请稍后继续制作。');
  }
  const file = (id) => {
    if (!TASK_ID.test(String(id || ''))) throw fail('product_video_not_found', '没有找到这条视频任务。');
    return contained(root, `${id}/task.json`);
  };
  function read(id) {
    let task;
    try { task = JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { throw fail('product_video_not_found', '视频任务无法读取，原文件已保留。'); }
    if (![1, 2, 3].includes(task.version) || task.id !== id) throw fail('product_video_data_invalid', '视频任务格式无法识别。');
    return task;
  }
  function save(task) { task.updatedAt = new Date().toISOString(); writeJsonAtomic(file(task.id), task); }
  function allOperations(task) { return [...Object.values(task.operations || {}), ...(task.archivedOperations || [])]; }
  function quote(task) {
    const initial = quotePlan(task.plan, task.prices, task.budgetCny);
    let actual = 0, pending = 0;
    for (const op of allOperations(task)) {
      if (!op.reserveCny) continue;
      if (Number.isFinite(op.actualCny)) actual += op.actualCny;
      else if (!op.rejected) pending += op.reserveCny;
    }
    return { ...initial, actualCny: round(actual), pendingCny: round(pending), reservedCny: round(actual + pending),
      ledger: allOperations(task).filter((op) => op.reserveCny).map((op) => ({ stage: op.name, reserveCny: op.reserveCny,
        actualCny: op.actualCny ?? null, actualUsd: op.actualUsd ?? null, credits: op.credits ?? null, status: op.rejected ? 'rejected' : Number.isFinite(op.actualCny) ? 'supplier_receipt' : 'pending_bill', submittedAt: op.submittedAt })) };
  }
  // How far along a 剧情版 or 无人实拍 task is, for the page ring and the desk pet.
  function progressOf(task) {
    if (task.status === 'completed') return 100;
    const total = Math.max(1, task.plan.shots.length), done = task.shots.filter((shot) => shot.file).length;
    const finishing = ['assembling', 'transcribing', 'packaging', 'enhancing'].includes(task.status) ? 1 : 0;
    if (task.plan.pipelineVersion === 6) return Math.min(97, Math.round((task.images?.plate?.file ? 10 : 0) + done / total * 80 + finishing * 5));
    if (task.plan.pipelineVersion === 5) {
      const pictures = Object.keys(task.images || {}).filter((key) => !key.startsWith('grid_') && task.images[key].file).length;
      return Math.min(97, Math.round(pictures / Math.max(1, task.plan.imageCount) * 45 + (task.story ? 5 : 0) + done / total * 42 + finishing * 5));
    }
    return Math.round(done / total * 88 + finishing * 4);
  }
  function publicTask(task) {
    const eta = estimateTask(task, readTimings(root), { shotSlots: SHOT_SLOTS, imageSlots: IMAGE_SLOTS });
    const shotsDone = task.shots.filter((shot) => shot.file).length;
    return { id: task.id, mode: task.mode, version: task.version, status: task.status,
      statusLabel: task.plan.pipelineVersion === 6 && task.status === 'imaging' ? '画拍摄场地'
        : task.plan.pipelineVersion === 6 && ['submitting', 'generating'].includes(task.status) ? `拍镜头（${shotsDone}/${task.shots.length} 好了）`
        : task.plan.pipelineVersion === 6 && task.status === 'assembling' ? '拼接镜头' : task.plan.pipelineVersion === 6 && task.status === 'packaging' ? '加字幕'
        : task.plan.pipelineVersion === 5 && task.status === 'imaging' ? (task.story ? '画场景、人物和分镜' : '出定妆照') : task.plan.pipelineVersion === 5 && task.status === 'uploading' ? '准备产品图'
        : task.plan.pipelineVersion === 5 && ['submitting', 'generating'].includes(task.status) ? `拍视频（${shotsDone}/${task.shots.length} 段好了）`
        : task.plan.pipelineVersion === 4 && task.status === 'locking_frames' ? '核对产品原图与制作方案' : LABELS[task.status] || '需要处理', createdAt: task.createdAt, updatedAt: task.updatedAt,
      durationSeconds: task.durationSeconds, sceneId: task.sceneId, sceneIds: task.sceneIds || task.plan.sceneIds || [], surfaceId: task.surfaceId, dirtId: task.dirtId, goalId: task.goalId,
      productName: task.productName || '', facts: task.facts, expression: task.expression, imageId: task.imageId, budgetCny: task.budgetCny, quote: quote(task),
      plan: task.plan, currentShot: task.currentShot, completedShots: shotsDone, shotsReady: task.shots.map((shot) => Boolean(shot.file)),
      shotsRunning: task.shots.map((shot) => Boolean(shot.providerTaskId && !shot.file)),
      progress: progressOf(task), etaSeconds: eta, estimatedFinishAt: eta === null ? null : new Date(Date.now() + eta * 1000).toISOString(),
      ...(task.plan.pipelineVersion === 6 ? { realPipeline: true, imagesReady: { plate: Boolean(task.images?.plate?.file) } } : {}),
      preparation: task.plan.pipelineVersion >= 3 ? { referenceMode: task.plan.pipelineVersion === 4 ? 'original_product_image' : 'scene_first_frames',
        inputsLocked: Boolean(task.frameManifest), framesReady: task.shots.filter((shot) => shot.frameFile).length, framesLocked: task.plan.pipelineVersion !== 4 && Boolean(task.frameManifest),
        ruleCheck: task.frameManifest?.ruleCheck || 'pending', visualReview: 'not_performed', audioReady: Boolean(task.audio), music: publicMusic(task.audio?.music) } : undefined,
      ...(task.plan.pipelineVersion === 5 ? { storyPipeline: true, sheetRedos: task.sheetRedos || 0, imageTotal: task.plan.imageCount,
        imagesReady: Object.fromEntries(Object.entries(task.images || {}).filter(([, image]) => image.file).map(([key]) => [key, true])),
        story: task.story ? { title: task.story.title, logline: task.story.logline, characters: task.story.characters.map((person) => ({ name: person.name, role: person.role })),
          lines: task.story.segments.flatMap((segment) => segment.shots.flatMap((shot) => shot.lines.map((row) => ({ who: row.who, line: row.line })))) } : null } : {}),
      error: cleanMessage(task.error || ''), errorCode: task.errorCode || '', resumeStatus: task.resumeStatus || '', canRetry: task.status === 'needs_attention' && !((task.videoRetryCount || 0) >= 1 && (Number.isInteger(task.failedShotIndex) || ['product_video_video_failed','product_video_shot_failed'].includes(task.errorCode))),
      retryLabel: Number.isInteger(task.failedShotIndex) ? `重新生成第 ${task.failedShotIndex + 1} 段` : ASR_RETRY_ERRORS.has(task.errorCode) ? '重新识别字幕' : '',
      canRefresh: RUNNING.has(task.status) || ['outcome_unknown', 'draft'].includes(task.status), canExport: task.status === 'completed', canExportSource: Boolean(task.sourceFile), canPreview: task.status === 'completed' && Boolean(task.finalFile) };
  }
  function taskIds() { return fs.existsSync(root) ? fs.readdirSync(root).filter((name) => TASK_ID.test(name)) : []; }
  function list() {
    const items = [];
    for (const id of taskIds()) { try { items.push(publicTask(read(id))); } catch { /* Keep other usable history visible when one task is corrupt. */ } }
    return { items: items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  }
  function asset(id) {
    if (!IMAGE_ID.test(String(id || ''))) throw fail('product_video_image_missing', '请先上传产品图。');
    let entry;
    try { entry = JSON.parse(fs.readFileSync(contained(root, `assets/${id}.json`), 'utf8')); } catch { throw fail('product_video_image_missing', '产品图片无法读取，请重新选择。'); }
    const bytes = fs.readFileSync(contained(root, entry.relativePath));
    if (digest(bytes) !== entry.sha256) throw fail('product_video_image_changed', '产品图片已变化，请重新选择。');
    return { ...entry, bytes, path: contained(root, entry.relativePath) };
  }
  function importImage(source) {
    hold();
    const stat = fs.statSync(source);
    if (!stat.isFile() || stat.size < 1 || stat.size > 20 * 1024 * 1024) throw fail('product_video_image_size', '请选择不超过20MB的产品图。');
    const bytes = fs.readFileSync(source), mime = imageMime(bytes), id = `pva_${randomUUID()}`;
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[mime], relativePath = `assets/${id}${ext}`;
    fs.mkdirSync(contained(root, 'assets'), { recursive: true });
    fs.writeFileSync(contained(root, relativePath), bytes, { flag: 'wx' });
    writeJsonAtomic(contained(root, `assets/${id}.json`), { id, name: path.basename(source), mime, relativePath, sha256: digest(bytes) });
    return { id, name: path.basename(source), previewDataUrl: options.imageThumbnail ? options.imageThumbnail(bytes) : `data:${mime};base64,${bytes.toString('base64')}` };
  }
  function importFacts(source) {
    hold();
    const stat = fs.statSync(source);
    if (!stat.isFile() || path.extname(source).toLowerCase() !== '.txt' || stat.size > 100000) throw fail('product_video_facts_invalid', '请选择不超过100KB的TXT产品资料。');
    let value;
    try { value = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(source)).replace(/^\uFEFF/u, '').trim(); } catch { throw fail('product_video_facts_encoding', '请将资料另存为UTF-8文本后导入，原文件不会修改。'); }
    if (!value || value.length > FACT_LIMIT) throw fail('product_video_facts_invalid', `产品资料须为1至${FACT_LIMIT}字，导入不会截断原文。`);
    return { name: path.basename(source), text: value };
  }
  async function admit(action) { ensureRunning(); admissions += 1; try { return await action(); } finally { admissions -= 1; } }
  async function admitTask(id, action) {
    return admit(async () => {
      if (admissionsByTask.has(id) || active.has(id)) throw fail('product_video_busy', '当前任务正在处理，请稍后刷新。');
      admissionsByTask.add(id);
      try { return await action(); } finally { admissionsByTask.delete(id); }
    });
  }
  async function create(input) {
    return admit(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['mode','durationSeconds','sceneId','sceneIds','surfaceId','dirtId','goalId','expression','facts','imageId','productName','budgetCny','style',
        'deviceId','floorId','dirtIds','pointIds','extraImageIds'].includes(key))) throw fail('product_video_invalid_input', '请重新填写视频需求。');
      if (input.style !== undefined && !['story', 'real'].includes(input.style)) throw fail('product_video_invalid_input', '请重新填写视频需求。');
      const storyStyle = input.style === 'story', realStyle = input.style === 'real';
      if (!realStyle && ['deviceId', 'floorId', 'dirtIds', 'pointIds', 'extraImageIds'].some((key) => input[key] !== undefined)) throw fail('product_video_invalid_input', '请重新填写视频需求。');
      asset(input.imageId);
      if (realStyle) {
        const extra = input.extraImageIds ?? [];
        if (!Array.isArray(extra) || extra.length > real.MAX_PRODUCT_IMAGES - 1 || new Set([input.imageId, ...extra]).size !== extra.length + 1) throw fail('product_video_invalid_input', `产品图最多${real.MAX_PRODUCT_IMAGES}张，且不能重复。`);
        extra.forEach((id) => asset(id));
      }
      const plan = { ...(realStyle ? real.planRealShoot(input) : storyStyle ? story.planStoryVideo(input) : planVideo(input)), retryPolicy: 'one_failed_video' }, automaticBudget = input.budgetCny === undefined;
      let budgetCny = automaticBudget ? 0 : Number(input.budgetCny);
      if (!automaticBudget && (!Number.isFinite(budgetCny) || budgetCny <= 0 || budgetCny > 10000)) throw fail('product_video_budget_invalid', '本次制作额度无效，请联系管理员。');
      let prices; try { prices = await readPrices(plan); } catch { /* Drafting remains usable offline. */ }
      if (automaticBudget && validPrices(prices)) budgetCny = quotePlan(plan, prices, 0).maximumCny;
      hold();
      const id = `pv_${randomUUID()}`, createdAt = new Date().toISOString();
      const task = { ...input, productName: String(input.productName || '').trim(), facts: String(input.facts || '').trim(), expression: String(input.expression || '').trim(),
        id, createdAt, updatedAt: createdAt, version: 3, audioVoicePolicy: realStyle ? 'model_ambient' : storyStyle ? 'model_dialogue' : 'workbench', presentationPolicy: realStyle ? 'planned_captions' : storyStyle ? 'dialogue' : 'reference_narration',
        ...(storyStyle ? { images: {}, sheetRedos: 0 } : realStyle ? { images: {}, extraImageIds: input.extraImageIds || [] } : {}), status: 'draft', budgetCny, budgetPolicy: automaticBudget ? 'quoted_production' : 'explicit', prices, plan, sceneIds: plan.sceneIds, currentShot: 0, shots: plan.shots.map(() => ({})), operations: {}, archivedOperations: [], autoRetryFailedVideo: true, videoRetryCount: 0 };
      save(task); return publicTask(task);
    });
  }
  async function storyReadiness(state) {
    let prices; try { prices = await readPrices({ pipelineVersion: 5 }); } catch { prices = null; }
    const ready = Boolean(state?.ready && state.capabilities?.apimart && state.capabilities?.bailian && state.capabilities?.bailian_video
      && state.capabilities?.volcengine_asr && typeof options.writeStory === 'function' && validPrices(prices));
    return { ready, message: ready ? '' : '写故事、出图、视频或报价暂未就绪，未提交任何付费生成；稍后再试。' };
  }
  // 无人实拍: the same Wan3 sound video and picture prices as the 剧情版, but no story writer and no speech recognition.
  async function realReadiness(state) {
    let prices; try { prices = await readPrices({ pipelineVersion: 6 }); } catch { prices = null; }
    const ready = Boolean(state?.ready && state.capabilities?.apimart && state.capabilities?.bailian && state.capabilities?.bailian_video && validPrices(prices));
    return { ready, message: ready ? '' : '出图、视频或报价暂未就绪，未提交任何付费生成；稍后再试。' };
  }
  // Typical step times on this computer, so the page can say how long a new video will take before it starts.
  function timing() {
    const timings = readTimings(root), r = require('./product-video-eta.cjs').rates(timings);
    return { image: Math.round(r.image), story: Math.round(r.story), finish: Math.round(r.finish), video15: Math.round(r.video(15)), video6: Math.round(r.video(6)), shotSlots: SHOT_SLOTS, imageSlots: IMAGE_SLOTS };
  }
  async function capabilities(plan = { pipelineVersion: 4 }) {
    let prices; try { prices = await readPrices(plan); } catch { prices = { ready: false, message: '报价暂不可用，仍可先保存视频方案。' }; }
    const choices = { scenes: SCENES, surfaces: SURFACES, dirt: DIRT, goals: GOALS, prices, videoPricePerSecondUsd: prices.estimatedVideoUsdPerSecond ?? null,
      videoPricePerSecondCny: prices.videoCnyPerSecond ?? null, catalog: sceneCatalog.choices(), timing: timing() };
    if (!options.gatewayClient?.isEnabled?.()) return { ...choices, ready: false, message: '生成服务暂不可用，仍可先保存方案。', story: { ready: false, message: '生成服务暂不可用。' }, real: { ready: false, message: '生成服务暂不可用。' } };
    const state = await options.gatewayClient.initialize({ verify: true });
    if (plan.pipelineVersion === 5) { const ready = await storyReadiness(state); return { ...choices, ...ready, story: ready }; }
    if (plan.pipelineVersion === 6) { const ready = await realReadiness(state); return { ...choices, ...ready, real: ready }; }
    choices.story = await storyReadiness(state);
    choices.real = await realReadiness(state);
    const official = plan.pipelineVersion >= 3;
    const videoReady = official ? state.capabilities?.bailian && state.capabilities?.bailian_video : state.capabilities?.apimart_video;
    const audioReady = !official || typeof options.prepareAudio === 'function';
    let voiceReady = !official;
    if (official && typeof options.listVoices === 'function') {
      try {
        const catalog = await options.listVoices();
        voiceReady = (catalog?.items || []).some((voice) => voice.provider === 'volcengine'
          && voice.approvalStatus === 'approved' && voice.availability === 'available');
      } catch { /* A catalog failure must stop before the first paid request. */ }
    }
    const ready = Boolean(state.ready && (plan.pipelineVersion === 4 || state.capabilities?.apimart) && videoReady && audioReady && voiceReady && state.capabilities?.volcengine_asr && validPrices(prices)
      && (official ? prices.provider === 'bailian' && prices.model === (plan.pipelineVersion === 4 ? wan.DIRECT_MODEL : wan.MODEL) : prices.provider !== 'bailian'));
    return { ...choices, ready, message: ready ? '' : !audioReady ? '整片声音准备组件尚未就绪，未提交任何付费生成；仍可保存方案。'
      : !voiceReady ? '默认配音声音暂不可用，请稍后重试；未提交任何付费生成，仍可保存方案。'
        : '视频生成、声音识别或对应型号的完整报价尚未就绪，仍可先保存方案。' };
  }
  function futureReserve(task, exclude, proposedReserve = 0) {
    if (!validPrices(task.prices)) throw fail('product_video_price_unavailable', '报价已失效，请刷新核价后继续。');
    if (task.plan.pipelineVersion === 6) {
      if (!task.prices.storyPipeline) throw fail('product_video_price_unavailable', '报价与无人实拍不匹配，未提交付费请求。');
      let total = 0;
      if (!task.images?.plate?.file && !task.operations.img_plate && exclude !== 'img_plate') total += round(task.prices.imageUsd * task.prices.fxCnyPerUsd);
      task.plan.shots.forEach((shot, index) => { if (!task.shots[index].file && !task.operations[`shot_${index}`] && exclude !== `shot_${index}`) total += videoReserve(task, shot); });
      return total;
    }
    if (task.plan.pipelineVersion === 5) {
      if (!task.prices.storyPipeline) throw fail('product_video_price_unavailable', '报价与剧情版不匹配，未提交付费请求。');
      const image = round(task.prices.imageUsd * task.prices.fxCnyPerUsd); let total = 0;
      for (const key of ['sheet', ...storyImageKeys(task.plan.segments)]) if (!task.images?.[key]?.file && !task.operations[`img_${key}`] && exclude !== `img_${key}`) total += image;
      task.plan.shots.forEach((shot, index) => { if (!task.shots[index].file && !task.operations[`shot_${index}`] && exclude !== `shot_${index}`) total += videoReserve(task, shot); });
      if (!task.story && !Object.keys(task.operations).some((k) => /^story(?:_\d+)?$/u.test(k) && !task.operations[k].response) && !String(exclude || '').startsWith('story')) total += task.prices.storyReserveCny;
      if (!task.operations.asr && exclude !== 'asr') total += task.prices.asrReserveCny;
      return total;
    }
    if ((task.plan.pipelineVersion >= 3) !== (task.prices.provider === 'bailian')) throw fail('product_video_price_unavailable', '报价与任务原始供应商不匹配，不能套用其他模型的单价。');
    if (task.plan.pipelineVersion >= 3 && (task.prices.model !== task.plan.videoModel || task.prices.resolution !== task.plan.sourceResolution))
      throw fail('product_video_price_unavailable', '报价与任务原始模型或清晰度不匹配，未提交付费请求。');
    const p = task.prices; let total = 0;
    task.plan.shots.forEach((shot, index) => {
      if (task.plan.pipelineVersion >= 2 && task.plan.pipelineVersion !== 4 && !task.shots[index].frameFile && !task.operations[`frame_${index}`] && exclude !== `frame_${index}`) total += round(p.imageUsd * p.fxCnyPerUsd);
      if (!task.shots[index].file && !task.operations[`shot_${index}`] && exclude !== `shot_${index}`) total += videoReserve(task, shot);
    });
    if (task.plan.pipelineVersion >= 2 && !task.operations.asr && exclude !== 'asr') total += p.asrReserveCny;
    if (task.plan.pipelineVersion >= 3 && !task.audio) {
      const usedAudio = allOperations(task).filter((op) => op.name.startsWith('audio_') && !op.rejected).reduce((sum, op) => sum + (op.actualCny ?? op.reserveCny ?? 0), 0);
      total += Math.max(0, p.audioReserveCny - usedAudio - (exclude?.startsWith('audio_') ? proposedReserve : 0));
    }
    return total;
  }
  function videoReserve(task, shot) {
    return round(shot.seconds * (task.plan.pipelineVersion >= 3 ? task.prices.videoCnyPerSecond : task.prices.videoUsdPerSecond * task.prices.fxCnyPerUsd));
  }
  async function operation(task, name, route, body, reserveCny = 0, headers = {}, execute = null) {
    const prior = task.operations[name];
    if (prior?.response) return prior.response;
    if (prior) {
      if (prior.rejected) throw fail('product_video_request_rejected', '上次请求已明确失败，请点击重试后再提交。');
      if (execute) {
        prior.response = await execute(prior.id); save(task); return prior.response;
      }
      let receipt;
      try { receipt = await provider.request(`/operations/${prior.id}`); } catch { throw fail('product_video_submission_unknown', '原请求尚未核实，保留费用预留，不重复提交。', { outcomeUnknown: true }); }
      if (receipt?.status === 'pending') throw fail('product_video_submission_unknown', '原请求仍在处理中，请稍后核对。', { outcomeUnknown: true });
      prior.response = receipt; save(task); return receipt;
    }
    ensureRunning();
    if (reserveCny && round(quote(task).reservedCny + reserveCny + futureReserve(task, name, reserveCny)) > task.budgetCny) throw fail('product_video_budget_exceeded', '剩余额度不足以覆盖本次调用和后续制作，已有成果已保留。');
    const entry = { id: randomUUID(), name, submittedAt: new Date().toISOString(), reserveCny,
      priceSnapshot: { source: task.prices?.source, checkedAt: task.prices?.checkedAt, fxCnyPerUsd: task.prices?.fxCnyPerUsd,
        videoCnyPerSecond: task.prices?.videoCnyPerSecond, ttsCnyPer10kChars: task.prices?.ttsCnyPer10kChars } };
    task.operations[name] = entry; save(task);
    const requestHeaders = name === 'asr' ? { ...headers, 'X-Api-Request-Id': entry.id } : headers;
    try { entry.response = execute ? await execute(entry.id) : await provider.request(route, { method: 'POST', body, headers: requestHeaders, operationId: entry.id }); save(task); return entry.response; }
    catch (error) { if (/(?:outcome|submission)_unknown/u.test(error.code || '')) error.outcomeUnknown = true; if (!error.outcomeUnknown) entry.rejected = true; save(task); throw error; }
  }
  function receiptCost(task, name, node) {
    const op = task.operations[name];
    if (!op) return;
    const raw = node?.cost;
    const terminal = ['completed','succeeded','success','failed','rejected','cancelled','canceled'].includes(String(node?.status || '').toLowerCase());
    if (terminal && (typeof raw === 'number' || typeof raw === 'string' && /^\d+(?:\.\d+)?$/u.test(raw)) && Number.isFinite(Number(raw)) && Number(raw) >= 0) {
      op.actualUsd = Number(raw); op.actualCny = round(op.actualUsd * (op.priceSnapshot?.fxCnyPerUsd || task.prices?.fxCnyPerUsd || 8)); op.credits = node.credits_cost ?? null;
    }
    op.supplierStatus = node?.status || ''; save(task);
  }
  async function upload(task) {
    if (task.imageUrl) return;
    const request = provider.imageUploadBody(asset(task.imageId).path);
    const payload = await operation(task, 'upload_image', '/apimart/uploads/images', request.body, 0, request.headers);
    task.imageUrl = remoteUrl(provider.nodeOf(payload).url || payload.url); save(task);
  }
  async function poll(task, kind) {
    const index = task.currentShot, shot = task.shots[index], name = `${kind === 'frame' ? 'frame' : 'shot'}_${index}`;
    const id = kind === 'frame' ? shot.frameTaskId : shot.providerTaskId;
    const official = kind === 'video' && task.plan.pipelineVersion >= 3;
    const result = await provider.request(official ? wan.pollRequest(id).route : `/apimart/tasks/${id}?language=en`);
    const node = official ? wan.normalizePoll(result) : provider.nodeOf(result), status = String(node.status || '').toLowerCase();
    if (official) {
      // DashScope usage gives output seconds, not a RMB bill. Keep the existing
      // charge allowance pending until an actual account bill is reconciled.
      task.operations[name].supplierStatus = status;
      task.operations[name].usage = result.usage || null; save(task);
    } else receiptCost(task, name, node);
    if (['failed','rejected','cancelled','canceled'].includes(status)) throw fail(`product_video_${kind}_failed`, cleanMessage(node.error?.message || node.error || '生成失败，请检查后单独重试。'));
    if (!['completed','succeeded','success'].includes(status)) return false;
    if (kind === 'frame') {
      const url = provider.resultUrl(result, 'images'), temporary = `${task.id}/frame-${index}.image`;
      await provider.download(url, contained(root, temporary), { maxBytes: 20 * 1024 * 1024 });
      const bytes = fs.readFileSync(contained(root, temporary)), mime = imageMime(bytes);
      const relative = `${task.id}/frame-${index}${{ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[mime]}`;
      fs.renameSync(contained(root, temporary), contained(root, relative));
      shot.frameFile = relative; shot.frameUrl = url; shot.frameSha256 = digest(bytes);
    } else {
      const relative = `${task.id}/shot-${index}.mp4`;
      await provider.download(official ? node.videoUrl : provider.resultUrl(result, 'videos'), contained(root, relative));
      const bytes = fs.readFileSync(contained(root, relative));
      if (bytes.length < 1024 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw fail('product_video_download_invalid', '结果不是有效视频，云端任务已保留。');
      shot.file = relative;
    }
    save(task); return true;
  }
  function checkPlan(task) {
    if (task.plan.pipelineVersion < 3) return;
    if (task.plan.pipelineVersion === 6) {
      if (task.plan.videoModel !== wan.DIRECT_MODEL || task.plan.videoAudio !== true || task.plan.sourceResolution !== '480p' || !sceneCatalog.DURATIONS.includes(task.durationSeconds)
        || !task.plan.platePrompt || task.plan.shots.reduce((sum, shot) => sum + shot.seconds, 0) !== task.durationSeconds
        || task.plan.shots.some((shot) => !shot.prompt || [...shot.prompt].length > real.PROMPT_LIMIT || shot.seconds < 2 || shot.seconds > 15)
        || task.plan.productImages !== 1 + (task.extraImageIds || []).length)
        throw fail('product_video_plan_invalid', '无人实拍方案与模型、时长不一致，请重新生成。');
      return;
    }
    if (task.plan.pipelineVersion === 5) {
      if (task.plan.videoModel !== wan.DIRECT_MODEL || task.plan.videoAudio !== true || task.plan.sourceResolution !== '480p' || !story.STORY_SECONDS.includes(task.durationSeconds)
        || task.plan.shots.length !== task.plan.segments || task.plan.shots.reduce((sum, shot) => sum + shot.seconds, 0) !== task.durationSeconds)
        throw fail('product_video_plan_invalid', '剧情版方案与模型、时长不一致，请重新保存方案。');
      return;
    }
    const direct = task.plan.pipelineVersion === 4;
    if (![3, 4].includes(task.plan.pipelineVersion) || task.plan.videoProvider !== 'bailian' || task.plan.videoModel !== (direct ? wan.DIRECT_MODEL : wan.MODEL)
      || task.plan.sourceResolution !== (direct ? '480p' : '720p') || task.plan.videoAudio !== false)
      throw fail('product_video_plan_invalid', '制作方案与本次已核价的阿里模型、清晰度或无声路线不一致，请重新保存方案。');
    if (task.plan.shots.reduce((sum, shot) => sum + shot.seconds, 0) !== task.durationSeconds) throw fail('product_video_plan_invalid', '分镜时长与成片时长不一致，未提交视频。');
    const image = asset(task.imageId), imageUrl = `data:${image.mime};base64,${image.bytes.toString('base64')}`;
    for (const shot of task.plan.shots) {
      (direct ? wan.directVideoRequest : wan.videoRequest)({ imageUrl, prompt: shot.prompt, durationSeconds: shot.seconds, resolution: task.plan.sourceResolution, audio: false });
      if ((!direct && !shot.firstFramePrompt) || !shot.camera || !shot.startState || !shot.endState || shot.referenceRule !== 'original_product_image'
        || (shot.evidenceStatus === 'user_supplied_unverified' && (shot.movement !== 'forward_along_visible_front' || shot.changeRule !== 'only_after_cleaning_contact')))
        throw fail('product_video_plan_invalid', '首帧依据、前进方向或清洁因果规则不完整，未提交视频。');
    }
  }
  async function lockFrames(task) {
    checkPlan(task);
    const source = asset(task.imageId), frames = [], direct = task.plan.pipelineVersion === 4;
    const originalInfo = direct ? await media.probe(source.path, ffmpegPath) : null;
    for (const [index, shot] of task.shots.entries()) {
      if (!direct && !shot.frameFile) throw fail('product_video_frame_missing', '请先完成所有场景首帧，再提交视频。');
      const framePath = direct ? source.path : contained(root, shot.frameFile), bytes = direct ? source.bytes : fs.readFileSync(framePath);
      imageMime(bytes);
      const info = direct ? originalInfo : await media.probe(framePath, ffmpegPath);
      if (!info.video || Math.min(info.video.width, info.video.height) < 240 || Math.max(info.video.width, info.video.height) > 7680
        || (!direct && Math.abs(info.video.width / info.video.height - 9 / 16) > 0.05))
        throw fail('product_video_frame_invalid', '参考图片无法解码或尺寸不符合模型要求，未提交视频。');
      frames.push({ index, sha256: direct ? source.sha256 : digest(bytes), originalImageSha256: source.sha256,
        firstFramePromptSha256: digest(task.plan.shots[index].firstFramePrompt || ''), videoPromptSha256: digest(task.plan.shots[index].prompt),
        width: info.video.width, height: info.video.height, camera: task.plan.shots[index].camera,
        movement: task.plan.shots[index].movement, changeRule: task.plan.shots[index].changeRule });
    }
    task.frameManifest = { lockedAt: new Date().toISOString(), referenceMode: direct ? 'original_product_image' : 'scene_first_frames', ruleCheck: 'passed', visualReview: 'not_performed',
      note: '已核对计划、参考图引用、文件摘要和可解码尺寸；不代表模型已经通过外形或物理效果的视觉验收。', frames };
    save(task);
  }
  function checkLockedInputs(task) {
    checkPlan(task);
    if (!task.frameManifest || !task.audio) throw fail('product_video_preparation_missing', '参考图片、制作方案与整片声音尚未锁定，未提交视频。');
    const original = asset(task.imageId);
    for (const [index, shot] of task.shots.entries()) {
      const frame = task.frameManifest.frames[index];
      const referenceSha = task.plan.pipelineVersion === 4 ? original.sha256 : digest(fs.readFileSync(contained(root, shot.frameFile)));
      if (!frame || frame.originalImageSha256 !== original.sha256 || frame.sha256 !== referenceSha
        || frame.firstFramePromptSha256 !== digest(task.plan.shots[index].firstFramePrompt || '') || frame.videoPromptSha256 !== digest(task.plan.shots[index].prompt))
        throw fail('product_video_preparation_changed', '锁定的首帧或导演方案已变化，未提交视频；原任务和费用记录已保留。');
    }
    if (task.audio.sha256 !== digest(fs.readFileSync(contained(root, task.audio.file)))
      || task.audio.voiceSha256 !== digest(fs.readFileSync(contained(root, task.audio.voiceFile))))
      throw fail('product_video_preparation_changed', '锁定的音轨已变化，未提交视频；原音轨和已有镜头须保持一致。');
  }
  async function prepareAudio(task) {
    if (task.audio) return;
    if (typeof options.prepareAudio !== 'function') throw fail('product_video_audio_unavailable', '整片声音准备组件尚未就绪，未提交视频。');
    const directory = path.dirname(file(task.id));
    const result = await options.prepareAudio({ task, directory, ffmpegPath,
      operation: (name, route, body, reserveCny, headers, execute) => {
        if (!/^audio_[a-z0-9_]+$/u.test(name) || !Number.isFinite(reserveCny) || reserveCny <= 0)
          throw fail('product_video_audio_price_missing', '声音准备缺少明确计价或回执编号，未提交请求。');
        return operation(task, name, route, body, reserveCny, headers, execute);
      } });
    if (!result?.file || !result.voiceFile || !Number.isFinite(result.durationSeconds) || Math.abs(result.durationSeconds - task.durationSeconds) > 0.15)
      throw fail('product_video_audio_duration_invalid', '整片音轨时长与计划不一致，未提交视频。');
    const localAudio = (input) => {
      const relative = path.relative(root, path.resolve(input));
      const full = contained(root, relative);
      if (!fs.statSync(full).isFile()) throw fail('product_video_audio_missing', '已准备音轨无法读取，未提交视频。');
      return { file: relative, sha256: digest(fs.readFileSync(full)) };
    };
    const audio = localAudio(result.file), voice = localAudio(result.voiceFile);
    task.audio = { ...audio, voiceFile: voice.file, voiceSha256: voice.sha256, durationSeconds: result.durationSeconds,
      preparedAt: new Date().toISOString(), music: publicMusic(result.music) || { status: 'unavailable', source: '' } };
    save(task);
  }
  function storyImageSpec(task, key) {
    if (key === 'plate' && task.plan.pipelineVersion === 6) return { prompt: task.plan.platePrompt, refs: [], size: '9:16' };
    const st = task.story;
    if (key === 'sheet') return { prompt: story.sheetPrompt(task.plan.productName), refs: ['product'], size: '1:1' };
    if (!st) throw fail('product_video_story_missing', '故事还没写好，未提交出图。');
    if (key === 'scene') return { prompt: story.scenePrompt(st), refs: [], size: '9:16' };
    if (key === 'floor') return { prompt: story.floorPrompt(st), refs: ['scene'], size: '16:9' };
    if (key === 'person_a' || key === 'person_b') return { prompt: story.personPrompt(st, st.characters[key === 'person_a' ? 0 : 1]), refs: [], size: '9:16' };
    const [, segment, shot] = key.split('_').map(Number);
    return { prompt: story.framePrompt(st, segment, shot), refs: ['sheet', 'scene', 'person_a', 'person_b'], size: '9:16' };
  }
  // One image step per call: submit it, or check it and save the picture once it is ready.
  async function storyImage(task, key) {
    const image = (task.images[key] ||= {});
    if (!image.taskId) {
      const spec = storyImageSpec(task, key);
      const urls = [];
      for (const ref of spec.refs) urls.push(await storyReferenceUrl(task, ref));
      if (urls.some((url) => !url)) throw fail('product_video_reference_missing', '参考图还没准备好，未提交出图。');
      const response = await operation(task, `img_${key}`, '/apimart/images/generations', { model: story.IMAGE_MODEL, prompt: spec.prompt, n: 1, size: spec.size, resolution: '1K',
        ...(urls.length ? { image_urls: urls } : {}) }, round(task.prices.imageUsd * task.prices.fxCnyPerUsd));
      image.taskId = provider.taskIdOf(response); save(task); return false;
    }
    const result = await provider.request(`/apimart/tasks/${image.taskId}?language=en`);
    const node = provider.nodeOf(result), status = String(node.status || '').toLowerCase();
    receiptCost(task, `img_${key}`, node);
    if (['failed', 'rejected', 'cancelled', 'canceled'].includes(status)) throw fail('product_video_image_failed', `${IMAGE_LABEL[key] || '分镜'}没有画成：${cleanMessage(node.error?.message || node.error || '请重试。')}`, { imageKey: key });
    if (!['completed', 'succeeded', 'success'].includes(status)) return false;
    const url = provider.resultUrl(result, 'images'), temporary = `${task.id}/img-${key}.image`;
    await provider.download(url, contained(root, temporary), { maxBytes: 20 * 1024 * 1024 });
    const bytes = fs.readFileSync(contained(root, temporary)), mime = imageMime(bytes);
    const relative = `${task.id}/img-${key}${{ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[mime]}`;
    fs.renameSync(contained(root, temporary), contained(root, relative));
    Object.assign(image, { file: relative, url, sha256: digest(bytes) }); save(task);
    recordTiming(root, 'image', (Date.now() - Date.parse(task.operations[`img_${key}`]?.submittedAt)) / 1000);
    return true;
  }
  // Pictures a few at a time: check those ordered, then order the next ones whose reference pictures
  // are ready. True once every one is saved.
  async function advanceImages(task, keys) {
    for (const key of keys) if (task.images[key]?.taskId && !task.images[key].file) await storyImage(task, key);
    let running = keys.filter((key) => task.images[key]?.taskId && !task.images[key].file).length;
    for (const key of keys) {
      if (running >= IMAGE_SLOTS) break;
      if (task.images[key]?.file || task.images[key]?.taskId) continue;
      if (storyImageSpec(task, key).refs.some((ref) => ref !== 'product' && !task.images[ref]?.file)) continue;
      try { await storyImage(task, key); running += 1; }
      catch (error) {
        // The service is busy: wait for the pictures already ordered and try this one again later.
        if (error.status !== 429 || !running) throw error;
        releaseRejected(task, `img_${key}`); delete task.images[key]; save(task); break;
      }
    }
    return keys.every((key) => task.images[key]?.file);
  }
  // A request the service turned away for being busy bought nothing: keep its record and allow it again.
  function releaseRejected(task, name) {
    const op = task.operations[name];
    if (op?.rejected) { (task.archivedOperations ||= []).push(op); delete task.operations[name]; }
  }
  // One shot's Wan3 task: check it and save the clip once it is ready.
  async function pollShot(task, index) {
    const shot = task.shots[index], name = `shot_${index}`;
    const result = await provider.request(wan.pollRequest(shot.providerTaskId).route);
    const node = wan.normalizePoll(result);
    task.operations[name].supplierStatus = node.status; task.operations[name].usage = result.usage || null; save(task);
    if (node.status === 'failed') { task.currentShot = index; throw fail('product_video_video_failed', `第 ${index + 1} 个镜头没有拍成：${cleanMessage(node.error || '请重试。')}`, { shotIndex: index }); }
    if (node.status !== 'completed') return false;
    const relative = `${task.id}/shot-${index}.mp4`;
    await provider.download(node.videoUrl, contained(root, relative));
    const bytes = fs.readFileSync(contained(root, relative));
    if (bytes.length < 1024 || bytes.toString('ascii', 4, 8) !== 'ftyp') { task.currentShot = index; throw fail('product_video_download_invalid', '结果不是有效视频，云端任务已保留。', { shotIndex: index }); }
    shot.file = relative; save(task);
    recordTiming(root, 'video', { out: task.plan.shots[index].seconds, seconds: (Date.now() - Date.parse(shot.submittedAt || task.operations[name].submittedAt)) / 1000 });
    return true;
  }
  // 剧情版 and 无人实拍: every shot is its own Wan3 task, so up to SHOT_SLOTS are made at once
  // instead of one after another. Each keeps its own receipt; a failed one is redone by itself.
  async function advanceShots(task, requestFor) {
    for (const [index, shot] of task.shots.entries()) if (shot.providerTaskId && !shot.file) await pollShot(task, index);
    let running = task.shots.filter((shot) => shot.providerTaskId && !shot.file).length;
    for (const [index, shot] of task.shots.entries()) {
      if (running >= SHOT_SLOTS) break;
      if (shot.file || shot.providerTaskId) continue;
      task.currentShot = index;
      const request = await requestFor(index);
      let response;
      try { response = await operation(task, `shot_${index}`, request.route, request.body, videoReserve(task, task.plan.shots[index]), request.headers); }
      catch (error) {
        if (error.status !== 429 || !running) throw error;
        releaseRejected(task, `shot_${index}`); save(task); break;
      }
      shot.providerTaskId = wan.taskIdOf(response); shot.submittedAt = new Date().toISOString(); save(task); running += 1;
    }
    if (task.shots.every((shot) => shot.file)) {
      task.currentShot = task.shots.length - 1; task.finishStartedAt = new Date().toISOString(); task.status = 'assembling'; save(task); return true;
    }
    task.status = 'generating'; save(task); return false;
  }
  // A small JPEG of a picture, named after its content: a redone picture never reuses the old copy,
  // and the page and the background job share one conversion.
  const jpegJobs = new Map();
  async function storyJpeg(task, key) {
    const image = task.images?.[key];
    if (!image?.file) throw fail('product_video_reference_missing', '参考图还没准备好。');
    const relative = `${task.id}/ref-${key}-${String(image.sha256 || 'x').slice(0, 16)}.jpg`, full = contained(root, relative);
    if (fs.existsSync(full)) return full;
    if (!jpegJobs.has(full)) jpegJobs.set(full, Promise.resolve(media.referenceJpeg({ source: contained(root, image.file), destination: full, ffmpegPath })).finally(() => jpegJobs.delete(full)));
    await jpegJobs.get(full); return full;
  }
  async function storyReference(task, key) {
    return `data:image/jpeg;base64,${fs.readFileSync(await storyJpeg(task, key)).toString('base64')}`;
  }
  // References for later pictures are uploaded from the local file once (free), not taken from result links that may expire.
  async function storyReferenceUrl(task, key) {
    if (key === 'product') return task.imageUrl;
    const image = task.images[key];
    if (!image?.file) throw fail('product_video_reference_missing', '参考图还没准备好，未提交出图。');
    if (image.refUrl && image.refSha256 === image.sha256) return image.refUrl;
    const request = provider.imageUploadBody(await storyJpeg(task, key));
    const name = `upload_ref_${key}_${String(image.sha256 || '').slice(0, 8)}`;
    const payload = await operation(task, name, '/apimart/uploads/images', request.body, 0, request.headers);
    image.refUrl = remoteUrl(provider.nodeOf(payload).url || payload.url); image.refSha256 = image.sha256; save(task); return image.refUrl;
  }
  async function advanceStory(task) {
    ensureRunning();
    const segments = task.plan.segments;
    if (task.status === 'uploading') { await upload(task); task.status = 'imaging'; save(task); }
    if (task.status === 'imaging') {
      if (!await advanceImages(task, task.story ? storyImageKeys(segments) : ['sheet'])) return;
      task.status = task.story ? 'composing' : 'awaiting_sheet'; save(task); return;
    }
    if (task.status === 'writing_story') {
      if (typeof options.writeStory !== 'function') throw fail('product_video_story_unavailable', '写故事的服务暂未就绪，未继续花钱。');
      const scene = SCENES.find((row) => row.id === task.plan.sceneIds[0]) || SCENES[0];
      // A story that fails the checks is written again with the reason, up to three times in all
      // (a few fen each), before the customer is asked to retry; no picture is paid for meanwhile.
      const attempt = (task.storyAttempts ||= []).length;
      const name = attempt ? `story_${attempt + 1}` : 'story';
      const response = await operation(task, name, null, null, task.prices.storyReserveCny, {}, async () => {
        const result = await options.writeStory(story.storyMessages({ productName: task.plan.productName, facts: task.facts, scene, segments, feedback: task.storyAttempts.at(-1) || '', unmanned: Boolean(task.plan.unmanned) }));
        return { content: String(result?.content || '') };
      });
      try { task.story = { ...story.parseStory(response.content, segments), unmanned: Boolean(task.plan.unmanned) }; }
      catch (error) {
        if (error.code !== 'product_video_story_invalid' || task.storyAttempts.length >= 2) { task.storyAttempts = []; throw error; }
        task.storyAttempts.push(String(error.message || '').replace(/，没有继续花钱，请重试。$/u, '')); save(task); return;
      }
      task.storyAttempts = [];
      recordTiming(root, 'story', (Date.now() - Date.parse(task.operations[name]?.submittedAt)) / 1000);
      // Every prompt is built once now, so a bad story stops before the first paid picture.
      storyImageKeys(segments).forEach((key) => storyImageSpec(task, key));
      task.plan.shots.forEach((_, index) => story.videoPrompt(task.story, index));
      task.status = 'imaging'; save(task); return;
    }
    if (task.status === 'composing') {
      for (let segment = 0; segment < segments; segment += 1) {
        const key = `grid_${segment}`;
        if (task.images[key]?.file) continue;
        const relative = `${task.id}/img-${key}.jpg`;
        await media.composeStoryboard({ frames: Array.from({ length: story.SHOTS_PER_SEGMENT }, (_, k) => contained(root, task.images[`frame_${segment}_${k}`].file)), destination: contained(root, relative), ffmpegPath });
        task.images[key] = { file: relative, sha256: digest(fs.readFileSync(contained(root, relative))) }; save(task);
      }
      task.currentShot = Math.max(0, task.shots.findIndex((shot) => !shot.file)); task.status = task.shots.every((shot) => shot.file) ? 'assembling' : 'submitting'; save(task);
    }
    if (['submitting', 'generating'].includes(task.status)) {
      const done = await advanceShots(task, async (index) => {
        const images = [];
        for (const key of ['sheet', 'scene', 'floor', `grid_${index}`, 'person_a', 'person_b']) images.push(await storyReference(task, key));
        return wan.storyVideoRequest({ images, prompt: story.videoPrompt(task.story, index), seconds: task.plan.shots[index].seconds });
      });
      if (!done) return;
    }
    if (task.status === 'assembling') {
      const relative = `${task.id}/source-480p.mp4`;
      await media.normalizeAndAssemble({ shots: task.shots.map((shot, i) => ({ path: contained(root, shot.file), seconds: task.plan.shots[i].seconds })), destination: contained(root, relative), ffmpegPath });
      task.sourceFile = relative; task.status = 'transcribing'; save(task);
    }
    if (task.status === 'transcribing') {
      const audio = contained(root, `${task.id}/voices.wav`);
      await media.extractAudio({ source: contained(root, task.sourceFile), destination: audio, ffmpegPath });
      const response = await operation(task, 'asr', '/volcengine/asr/recognize/flash', { user: { uid: 'xiaoxi-product-video' }, audio: { data: fs.readFileSync(audio).toString('base64') }, request: { model_name: 'bigmodel', show_utterances: true, show_words: true, enable_punc: true } }, task.prices.asrReserveCny,
        { 'X-Api-Resource-Id': 'volc.bigasr.auc_turbo', 'X-Api-Sequence': '-1' });
      const result = response.result || response.data?.result || response.data || response;
      // A story without recognisable speech still gets its picture; it is only left without subtitles.
      task.preparedUtterances = Array.isArray(result.utterances) ? result.utterances : [];
      // Subtitles that cannot be laid out (people talking over each other) are left out, not retried: the video still finishes.
      try { task.captions = task.preparedUtterances.length ? media.buildCaptions({ utterances: task.preparedUtterances, timeUnit: 'ms', durationSeconds: task.durationSeconds }) : null; }
      catch { task.captions = null; task.captionNote = '对话有重叠，这条没有加字幕。'; }
      task.status = 'packaging'; save(task);
    }
    if (task.status === 'packaging') {
      const relative = `${task.id}/final.mp4`;
      if (task.captions) {
        await media.renderCaptioned({ source: contained(root, task.sourceFile), destination: contained(root, relative), captions: task.captions, ffmpegPath });
        fs.writeFileSync(contained(root, `${task.id}/final.srt`), task.captions.srt, 'utf8'); task.subtitleFile = `${task.id}/final.srt`;
      } else await (options.enhanceVideo || upscaleTo1080Size)({ source: contained(root, task.sourceFile), destination: contained(root, relative), ffmpegPath });
      task.finalFile = relative; task.status = 'completed'; save(task);
      recordTiming(root, 'finish', (Date.now() - Date.parse(task.finishStartedAt)) / 1000);
    }
  }
  // A product photo as a JPEG of at most 1600 px, made once per photo and sent inline to the video model.
  async function productReference(task, imageId) {
    const source = asset(imageId), relative = `${task.id}/product-${source.sha256.slice(0, 16)}.jpg`, full = contained(root, relative);
    if (!fs.existsSync(full)) await media.referenceJpeg({ source: source.path, destination: full, ffmpegPath });
    return `data:image/jpeg;base64,${fs.readFileSync(full).toString('base64')}`;
  }
  // 无人实拍 (pipeline 6): one empty scene picture, then every shot from the product photos (and that
  // picture for shots in the venue) with the machine's own sound, then one subtitle line per shot.
  async function advanceReal(task) {
    ensureRunning();
    if (task.status === 'imaging') {
      if (!await advanceImages(task, ['plate'])) return;
      task.status = 'submitting'; save(task);
    }
    if (['submitting', 'generating'].includes(task.status)) {
      const done = await advanceShots(task, async (index) => {
        const shot = task.plan.shots[index], images = [];
        for (const id of [task.imageId, ...(task.extraImageIds || [])]) images.push(await productReference(task, id));
        if (shot.place === 'venue') images.push(await storyReference(task, 'plate'));
        return wan.storyVideoRequest({ images, prompt: shot.prompt, seconds: shot.seconds });
      });
      if (!done) return;
    }
    if (task.status === 'assembling') {
      const relative = `${task.id}/source-480p.mp4`;
      await media.normalizeAndAssemble({ shots: task.shots.map((shot, i) => ({ path: contained(root, shot.file), seconds: task.plan.shots[i].seconds })), destination: contained(root, relative), ffmpegPath });
      task.sourceFile = relative; task.captions = media.buildPlannedCaptions({ cues: real.plannedCaptions(task.plan), durationSeconds: task.durationSeconds });
      task.status = 'packaging'; save(task);
    }
    if (task.status === 'packaging') {
      const relative = `${task.id}/final.mp4`;
      await media.renderCaptioned({ source: contained(root, task.sourceFile), destination: contained(root, relative), captions: task.captions, ffmpegPath });
      fs.writeFileSync(contained(root, `${task.id}/final.srt`), task.captions.srt, 'utf8'); task.subtitleFile = `${task.id}/final.srt`;
      task.finalFile = relative; task.status = 'completed'; save(task);
      recordTiming(root, 'finish', (Date.now() - Date.parse(task.finishStartedAt)) / 1000);
    }
  }
  async function advance(task) {
    if (task.plan.pipelineVersion === 6) return advanceReal(task);
    if (task.plan.pipelineVersion === 5) return advanceStory(task);
    ensureRunning();
    const official = task.plan.pipelineVersion >= 3;
    if (task.status === 'uploading') { await upload(task); task.status = task.plan.pipelineVersion >= 2 ? 'preparing_frames' : 'submitting'; save(task); }
    if (task.status === 'preparing_frames') {
      const index = task.currentShot;
      const response = await operation(task, `frame_${index}`, '/apimart/images/generations', { model: 'gpt-image-2', image_urls: [task.imageUrl], prompt: task.plan.shots[index].firstFramePrompt, n: 1, size: '9:16', resolution: '1k' }, round(task.prices.imageUsd * task.prices.fxCnyPerUsd));
      task.shots[index].frameTaskId = provider.taskIdOf(response); task.status = 'frame_generating'; save(task);
    }
    if (task.status === 'frame_generating') {
      if (!await poll(task, 'frame')) return;
      if (official) {
        const next = task.shots.findIndex((shot) => !shot.frameFile);
        task.currentShot = next < 0 ? 0 : next; task.status = next < 0 ? 'locking_frames' : 'preparing_frames';
      } else task.status = 'submitting';
      save(task);
    }
    if (task.status === 'locking_frames') { await lockFrames(task); task.status = 'preparing_audio'; save(task); }
    if (task.status === 'preparing_audio') { await prepareAudio(task); task.currentShot = Math.max(0, task.shots.findIndex((shot) => !shot.file)); task.status = 'transcribing'; save(task); }
    if (task.status === 'submitting') {
      const index = task.currentShot, shot = task.plan.shots[index];
      if (task.plan.pipelineVersion === 2 && !task.shots[index].uploadedFrameUrl) {
        const uploadRequest = provider.imageUploadBody(contained(root, task.shots[index].frameFile));
        const uploadResponse = await operation(task, `frame_upload_${index}`, '/apimart/uploads/images', uploadRequest.body, 0, uploadRequest.headers);
        task.shots[index].uploadedFrameUrl = remoteUrl(provider.nodeOf(uploadResponse).url || uploadResponse.url); save(task);
      }
      let response;
      if (official) {
        checkLockedInputs(task);
        const bytes = task.plan.pipelineVersion === 4 ? asset(task.imageId).bytes : fs.readFileSync(contained(root, task.shots[index].frameFile));
        const request = (task.plan.pipelineVersion === 4 ? wan.directVideoRequest : wan.videoRequest)({ imageUrl: `data:${imageMime(bytes)};base64,${bytes.toString('base64')}`, prompt: shot.prompt, durationSeconds: shot.seconds,
          resolution: task.plan.sourceResolution, audio: false });
        response = await operation(task, `shot_${index}`, request.route, request.body, videoReserve(task, shot), request.headers);
      } else response = await operation(task, `shot_${index}`, '/apimart/videos/generations', { model: 'seedance-2.5', duration: shot.seconds, resolution: task.plan.sourceResolution || '480p', size: '9:16', output_format: 'mp4', generate_audio: true, draft: false,
        ...(task.plan.pipelineVersion === 2 ? { image_with_roles: [{ url: task.shots[index].uploadedFrameUrl, role: 'first_frame' }] } : { image_urls: [task.imageUrl] }), prompt: shot.prompt }, videoReserve(task, shot));
      task.shots[index].providerTaskId = official ? wan.taskIdOf(response) : provider.taskIdOf(response); task.status = 'generating'; save(task);
    }
    if (task.status === 'generating') {
      if (!await poll(task, 'video')) return;
      task.currentShot += 1;
      while (task.currentShot < task.shots.length && task.shots[task.currentShot].file) task.currentShot += 1;
      task.status = task.currentShot < task.shots.length ? task.plan.pipelineVersion === 2 ? 'preparing_frames' : 'submitting' : 'assembling'; save(task);
    }
    if (task.status === 'assembling') {
      const relative = `${task.id}/source-${task.plan.sourceResolution || '480p'}.mp4`, destination = contained(root, relative);
      if (official) {
        checkLockedInputs(task);
        await (options.assemblePreparedVideo || media.assemblePreparedVideo)({ task, destination, audioPath: contained(root, task.audio.file),
          shots: task.shots.map((s, i) => ({ path: contained(root, s.file), seconds: task.plan.shots[i].seconds })), ffmpegPath });
      } else if (options.assembleVideo) await options.assembleVideo({ destination, shots: task.shots.map((s) => contained(root, s.file)) });
      else await media.normalizeAndAssemble({ shots: task.shots.map((s, i) => ({ path: contained(root, s.file), seconds: task.plan.shots[i].seconds })), destination, ffmpegPath });
      task.sourceFile = relative; task.status = official ? 'packaging' : task.plan.pipelineVersion === 2 ? 'transcribing' : 'enhancing'; save(task);
    }
    if (task.status === 'transcribing') {
      const audio = contained(root, `${task.id}/voices.wav`);
      await media.extractAudio({ source: contained(root, official ? task.audio.voiceFile : task.sourceFile), destination: audio, ffmpegPath });
      const response = await operation(task, 'asr', '/volcengine/asr/recognize/flash', { user: { uid: 'xiaoxi-product-video' }, audio: { data: fs.readFileSync(audio).toString('base64') }, request: { model_name: 'bigmodel', show_utterances: true, show_words: true, enable_punc: true } }, task.prices.asrReserveCny,
        { 'X-Api-Resource-Id': 'volc.bigasr.auc_turbo', 'X-Api-Sequence': '-1' });
      const result = response.result || response.data?.result || response.data || response;
      if (!Array.isArray(result.utterances) || !result.utterances.length) throw fail('product_video_asr_failed', '未识别到有时间信息的对白，原声视频已保留。请检查原声后再决定是否重试识别。');
      task.preparedUtterances = result.utterances;
      if (task.presentationPolicy === 'reference_narration') {
        const aligned = reconcileNarrationSpelling(result.utterances, task.plan.shots.map(shot => shot.narration || '').join(''));
        if (aligned) task.preparedUtterances = aligned.alignedUtterances;
      }
      task.captions = media.buildCaptions({ utterances: task.preparedUtterances, timeUnit: 'ms', durationSeconds: task.durationSeconds });
      task.status = official && !task.sourceFile ? 'submitting' : 'packaging'; save(task);
    }
    if (task.status === 'packaging') {
      const relative = `${task.id}/final.mp4`;
      if (task.presentationPolicy === 'reference_narration') {
        if (!options.packageVideo || !options.queryPackaging || !options.resolvePackagingVideo) throw fail('product_video_packaging_unavailable', '镜头已保存，创作工作台包装服务尚未就绪。');
        if (!task.packagingTaskId) {
          const source = contained(root, task.sourceFile);
          const output = await options.packageVideo({ source_id: `product_video_${task.id.slice(3)}`,
            input_video_path: source, title: task.productName || '产品现场演示',
            confirmed_script: task.plan.shots.map(shot => shot.narration || '').join(''),
            // Every product video gets one AI 3:4 cover (billed in the cover ledger).
            template_id: 'topic_fixed', cover_mode: 'ai_design',
            prepared_transcript: { time_unit: 'ms', utterances: task.preparedUtterances, source_sha256: digest(fs.readFileSync(source)) } });
          if (!output?.task_id) throw fail('product_video_packaging_unavailable', '包装服务尚未返回任务编号，原镜头已保留。');
          task.packagingTaskId = output.task_id; task.projectId = output.project_id; save(task);
        }
        const output = await options.queryPackaging(task.packagingTaskId);
        if (['failed', 'paused', 'cancelled', 'needs_attention', 'outcome_unknown'].includes(output?.status)) throw fail(output.error_code || 'product_video_packaging_failed', output.error_message || '创作工作台包装未完成，已有镜头已保留。', { outcomeUnknown: output.status === 'outcome_unknown' });
        if (output?.status !== 'completed') return;
        task.generatedVideoId = output.result?.generated_video_id || output.generated_video_id;
        const packaged = await options.resolvePackagingVideo(task.generatedVideoId);
        fs.copyFileSync(packaged.absolute_path, contained(root, relative));
        fs.writeFileSync(contained(root, `${task.id}/final.srt`), task.captions.srt, 'utf8');
      } else await media.renderCaptioned({ source: contained(root, task.sourceFile), destination: contained(root, relative), captions: task.captions, ffmpegPath });
      task.finalFile = relative; task.subtitleFile = `${task.id}/final.srt`; task.status = 'completed'; save(task);
    }
    if (task.status === 'enhancing') {
      const relative = `${task.id}/final.mp4`;
      await (options.enhanceVideo || upscaleTo1080Size)({ source: contained(root, task.sourceFile), destination: contained(root, relative), ffmpegPath });
      task.finalFile = relative; task.status = 'completed'; save(task);
    }
  }
  function pause(task, error) {
    task.resumeStatus = task.status; task.status = error.outcomeUnknown ? 'outcome_unknown' : 'needs_attention';
    task.error = cleanMessage(error.message || '制作需要处理。'); task.errorCode = error.code || 'product_video_step_failed';
    if (['product_video_native_audio_missing', 'product_video_shot_too_short'].includes(error.code)
      && Number.isInteger(error.shotIndex) && error.shotIndex >= 0 && error.shotIndex < task.shots.length) task.failedShotIndex = error.shotIndex;
    // Pictures are made a few at a time: remember which one failed so only that one is redone.
    if (error.code === 'product_video_image_failed' && typeof error.imageKey === 'string' && task.images?.[error.imageKey]) task.failedImageKey = error.imageKey;
    save(task);
  }
  async function recoverReceipt(task) {
    const pendingImage = task.plan.pipelineVersion >= 5 && task.resumeStatus === 'imaging' ? Object.keys(task.images || {}).find((key) => !task.images[key].file) : '';
    const stageKey = { preparing_frames: `frame_${task.currentShot}`, submitting: `shot_${task.currentShot}`, transcribing: 'asr', uploading: 'upload_image', writing_story: 'story', imaging: pendingImage && `img_${pendingImage}` }[task.resumeStatus];
    const entry = task.operations[stageKey] || Object.values(task.operations).find((op) => !op.response && !op.rejected);
    if (!entry) return;
    try {
      const result = await provider.request(`/operations/${entry.id}`);
      if (result && result.status !== 'pending') {
        entry.response = result; task.status = task.resumeStatus; task.error = ''; task.errorCode = ''; save(task);
      }
    } catch { /* Preserve the receipt and allowance until its result is known. */ }
  }
  async function prepareVideoRetry(task) {
    if ((task.videoRetryCount || 0) >= 1) throw fail('product_video_retry_limit', '这条作品已重做过一次，已有成果已保留，请先检查失败原因。');
    const index = Number.isInteger(task.failedShotIndex) ? task.failedShotIndex : task.currentShot;
    if (!Number.isInteger(index) || index < 0 || index >= task.shots.length) throw fail('product_video_data_invalid', '待重做镜头编号无效，原任务已保留。');
    const candidate = structuredClone(task), name = `shot_${index}`;
    if (candidate.operations[name]) {
      (candidate.archivedOperations ||= []).push(candidate.operations[name]); delete candidate.operations[name];
    }
    delete candidate.shots[index].file; delete candidate.shots[index].providerTaskId;
    candidate.currentShot = index; candidate.resumeStatus = 'submitting';
    candidate.prices = await readPrices(candidate.plan);
    if (!validPrices(candidate.prices)) throw fail('product_video_price_unavailable', '完整报价不可用，未提交重做请求。');
    if (round(quote(candidate).reservedCny + futureReserve(candidate)) > candidate.budgetCny)
      throw fail('product_video_budget_exceeded', '剩余额度不足以重做该镜头并完成后续制作，已有成果已保留。');
    ensureRunning();
    candidate.videoRetryCount = (task.videoRetryCount || 0) + 1;
    candidate.status = 'submitting'; candidate.error = ''; candidate.errorCode = ''; delete candidate.failedShotIndex;
    Object.assign(task, candidate); delete task.failedShotIndex;
    save(task); // Archive the old receipt and consume the allowance before any POST.
  }
  function schedule(id) {
    if (closed || updatePaused || active.has(id) || global.__xiaoxiUpdateHold) return;
    if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
    // 算力: this video's AI calls are held under one job and charged only when it completes.
    const promise = withBillingJob(`pv:${id}`, 'product_video', () => Promise.resolve().then(async () => {
      const task = read(id); if (!runnable(task)) return;
      try {
        if (task.status === 'outcome_unknown') await recoverReceipt(task);
        if (RUNNING.has(task.status)) await advance(task);
        if (task.status === 'completed') void options.gatewayClient?.settleBillingJob?.(`pv:${id}`, 'succeeded');
      } catch (error) {
        if (error.code === 'product_video_update_pending') return;
        if (task.autoRetryFailedVideo && error.code === 'product_video_video_failed' && (task.videoRetryCount || 0) < 1) {
          try { await prepareVideoRetry(task); return; }
          catch (retryError) {
            if (retryError.code === 'product_video_update_pending') return;
            error.message = `${error.message} ${retryError.message}`;
          }
        }
        pause(task, error);
      }
    })).finally(() => {
      active.delete(id);
      if (!closed && !updatePaused && !global.__xiaoxiUpdateHold) {
        const task = read(id);
        if (runnable(task)) timers.set(id, setTimeout(() => { timers.delete(id); schedule(id); }, options.pollMs ?? 8000));
      }
    });
    active.set(id, promise); void promise.catch(() => {});
  }
  async function verifyQuote(task) {
    task.prices = await readPrices(task.plan);
    if (!validPrices(task.prices)) throw fail('product_video_price_unavailable', '完整报价不可用，未提交付费请求。');
    if (task.budgetPolicy === 'quoted_production' && task.status === 'draft' && !allOperations(task).length) {
      task.budgetCny = quotePlan(task.plan, task.prices, 0).maximumCny;
    }
    if (!Number.isFinite(task.budgetCny)) throw fail('product_video_budget_missing', '旧草稿没有费用上限，请用现有资料创建新版方案。');
    if (round(quote(task).reservedCny + futureReserve(task)) > task.budgetCny) throw fail('product_video_budget_exceeded', '本次费用上限不足，方案与已有成果已保留。');
    save(task);
  }
  async function start(id) {
    return admitTask(id, async () => {
      if (active.has(id)) throw fail('product_video_busy', '当前任务正在处理。');
      const task = read(id);
      if (task.status !== 'draft') throw fail('product_video_already_started', '这条视频已经开始制作。');
      checkPlan(task);
      const status = await capabilities(task.plan); if (!status.ready) throw fail('product_video_provider_unavailable', status.message);
      await verifyQuote(task); hold();
      task.status = task.plan.pipelineVersion === 4 ? 'locking_frames' : task.plan.pipelineVersion === 6 ? 'imaging' : 'uploading';
      task.startedAt = new Date().toISOString(); save(task); schedule(id); return publicTask(task);
    });
  }
  async function retryShot(id) {
    return admitTask(id, async () => {
      if (active.has(id)) throw fail('product_video_busy', '当前任务正在处理。');
      const task = read(id);
      if (task.status !== 'needs_attention') throw fail('product_video_retry_unavailable', '当前任务不能重试。');
      if (Number.isInteger(task.failedShotIndex) || ['product_video_video_failed', 'product_video_shot_failed'].includes(task.errorCode)) {
        await prepareVideoRetry(task); schedule(id); return publicTask(task);
      }
      const index = task.currentShot;
      let name;
      if (task.plan.pipelineVersion >= 5 && task.errorCode === 'product_video_image_failed') {
        const key = task.failedImageKey && task.images?.[task.failedImageKey] && !task.images[task.failedImageKey].file ? task.failedImageKey : Object.keys(task.images || {}).find((k) => !task.images[k].file);
        if (key) { name = `img_${key}`; delete task.images[key]; }
        delete task.failedImageKey;
        task.resumeStatus = 'imaging';
      } else if (task.plan.pipelineVersion === 5 && task.errorCode === 'product_video_story_invalid') {
        for (const key of Object.keys(task.operations).filter((k) => /^story(?:_\d+)?$/u.test(k))) { (task.archivedOperations ||= []).push(task.operations[key]); delete task.operations[key]; }
        task.resumeStatus = 'writing_story'; delete task.story; task.storyAttempts = [];
      }
      else if (task.errorCode === 'product_video_frame_failed') { name = `frame_${index}`; task.resumeStatus = 'preparing_frames'; }
      else if (ASR_RETRY_ERRORS.has(task.errorCode)) { name = 'asr'; task.resumeStatus = 'transcribing'; delete task.captions; }
      else name = Object.keys(task.operations).find((key) => task.operations[key].rejected);
      if (name && task.operations[name]) { (task.archivedOperations ||= []).push(task.operations[name]); delete task.operations[name]; }
      if (!['assembling', 'packaging', 'enhancing'].includes(task.resumeStatus) && !(task.resumeStatus === 'transcribing' && task.operations.asr?.response)) await verifyQuote(task);
      hold(); delete task.failedShotIndex; task.status = task.resumeStatus; task.error = ''; task.errorCode = ''; save(task); schedule(id); return publicTask(task);
    });
  }
  async function refresh(id) {
    if (active.has(id) || admissionsByTask.has(id)) return publicTask(read(id));
    return admitTask(id, async () => {
      const task = read(id);
      if (task.status === 'draft') { try {
        task.prices = await readPrices(task.plan);
        if (task.budgetPolicy === 'quoted_production' && !allOperations(task).length && validPrices(task.prices)) task.budgetCny = quotePlan(task.plan, task.prices, 0).maximumCny;
        save(task);
      } catch { /* Keep draft available offline. */ } }
      if (task.status === 'outcome_unknown' && !active.has(id)) {
        await recoverReceipt(task);
      }
      if (runnable(task)) schedule(id);
      return publicTask(task);
    });
  }
  async function confirmSheet(id) {
    return admitTask(id, async () => {
      const task = read(id);
      if (task.plan.pipelineVersion !== 5 || task.status !== 'awaiting_sheet' || !task.images?.sheet?.file) throw fail('product_video_sheet_unavailable', '现在没有待确认的定妆照。');
      await verifyQuote(task); hold();
      task.sheetConfirmedAt = new Date().toISOString(); task.status = 'writing_story'; save(task); schedule(id); return publicTask(task);
    });
  }
  async function redoSheet(id) {
    return admitTask(id, async () => {
      const task = read(id);
      if (task.plan.pipelineVersion !== 5 || task.status !== 'awaiting_sheet') throw fail('product_video_sheet_unavailable', '现在没有待确认的定妆照。');
      if ((task.sheetRedos || 0) >= 2) throw fail('product_video_sheet_retry_limit', '定妆照已经重出过两次，请换一张更清楚的产品图再新建。');
      hold();
      if (task.operations.img_sheet) { (task.archivedOperations ||= []).push(task.operations.img_sheet); delete task.operations.img_sheet; }
      delete task.images.sheet; task.sheetRedos = (task.sheetRedos || 0) + 1;
      await verifyQuote(task); hold();
      task.status = 'imaging'; save(task); schedule(id); return publicTask(task);
    });
  }
  // A picture made for a 剧情版 (定妆照、场景、人物、分镜), small enough for the page.
  async function storyImageMedia(id, key) {
    const task = read(id);
    if (!/^(?:sheet|scene|floor|plate|person_[ab]|grid_\d{1,2})$/u.test(String(key || '')) || !task.images?.[key]?.file) throw fail('product_video_not_ready', '这张图还没准备好。');
    return { dataUrl: `data:image/jpeg;base64,${(await fsp.readFile(await storyJpeg(task, key))).toString('base64')}` };
  }
  function preview(id) {
    const task = read(id);
    if (task.status !== 'completed' || !task.finalFile) throw fail('product_video_not_ready', '成片尚未就绪。');
    const source = contained(root, task.finalFile);
    if (fs.statSync(source).size > 70 * 1024 * 1024) throw fail('product_video_preview_too_large', '成片较大，请直接导出观看。');
    return { dataUrl: `data:video/mp4;base64,${fs.readFileSync(source).toString('base64')}` };
  }
  // One finished shot, so the page can show what has been filmed while the rest is still being made.
  // Read without blocking the main process; a 480p shot of 10–12 seconds is a few MB.
  async function shotPreview(id, index) {
    const task = read(id), shot = Number.isInteger(index) ? task.shots[index] : null;
    if (!shot?.file) throw fail('product_video_not_ready', '这个镜头还没拍好。');
    const source = contained(root, shot.file);
    if ((await fsp.stat(source)).size > 40 * 1024 * 1024) throw fail('product_video_preview_too_large', '镜头较大，请等成片后导出观看。');
    return { dataUrl: `data:video/mp4;base64,${(await fsp.readFile(source)).toString('base64')}` };
  }
  async function exportVideo(id, destination, sourceOnly = false) {
    const task = read(id), relative = sourceOnly ? task.sourceFile : task.finalFile;
    if (!relative || !sourceOnly && task.status !== 'completed') throw fail('product_video_not_ready', '所选视频尚未就绪。');
    const source = contained(root, relative);
    if (path.resolve(source).toLowerCase() === path.resolve(destination).toLowerCase()) throw fail('product_video_export_path', '请选择任务目录以外的导出位置。');
    await fsp.copyFile(source, destination);
    let subtitlePath = '';
    if (!sourceOnly && task.subtitleFile) { subtitlePath = destination.replace(/\.mp4$/iu, '') + '.srt'; await fsp.copyFile(contained(root, task.subtitleFile), subtitlePath); }
    else if (!sourceOnly && task.version === 1) {
      const stamp = (seconds) => `00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds) % 60).padStart(2, '0')},000`;
      let cursor = 0;
      const srt = task.plan.shots.map((shot, i) => { const start = cursor; cursor += shot.seconds || 15; return `${i + 1}\n${stamp(start)} --> ${stamp(cursor)}\n${shot.narration}\n`; }).join('\n');
      subtitlePath = destination.replace(/\.mp4$/iu, '') + '.srt'; await fsp.writeFile(subtitlePath, srt, 'utf8');
    }
    const recordPath = destination.replace(/\.mp4$/iu, '') + '-制作记录.json';
    await fsp.writeFile(recordPath, JSON.stringify({ product: task.productName, facts: task.facts, plan: task.plan, preparation: task.frameManifest,
      sound: task.audio ? { durationSeconds: task.audio.durationSeconds, sha256: task.audio.sha256, voiceSha256: task.audio.voiceSha256, music: publicMusic(task.audio.music) } : undefined,
      costs: quote(task), output: sourceOnly ? `${task.plan.sourceResolution || '480p'}源片与整片声音` : '1080p尺寸普通放大与字幕', quality: '文件生成完成不等于真实产品性能或人工画面验收' }, null, 2), 'utf8');
    return { path: destination, subtitlePath, recordPath, sendText: task.plan.sendText };
  }
  function isBusy() {
    return Boolean(admissions || active.size);
  }
  function prepareForUpdate() {
    updatePaused = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    return { busy: isBusy() };
  }
  function resumeAfterUpdate() {
    if (closed) return;
    updatePaused = false;
    for (const id of taskIds()) { try { if (runnable(read(id))) schedule(id); } catch { /* Retain unreadable tasks for diagnosis. */ } }
  }
  async function close() { closed = true; prepareForUpdate(); await Promise.allSettled([...active.values()]); }
  queueMicrotask(resumeAfterUpdate);
  return { capabilities, importImage, importFacts, create, list, get: (id) => publicTask(read(id)), start, retryShot, refresh, media: preview, shotMedia: shotPreview, confirmSheet, redoSheet, imageMedia: storyImageMedia, exportVideo, exportSource: (id, destination) => exportVideo(id, destination, true), isBusy, prepareForUpdate, resumeAfterUpdate, close };
}
module.exports = { createProductVideoService };
