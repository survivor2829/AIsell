const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { writeJsonAtomic } = require('./atomic-file.cjs');
const { createDigitalHumanProvider, cleanMessage, fail, remoteUrl } = require('./digital-human-provider.cjs');
const wan = require('./bailian-video-provider.cjs');
const { planVideo, SCENES, SURFACES, DIRT, GOALS, FACT_LIMIT } = require('./video-directors.cjs');
const { createPriceReader, validPrices, quotePlan, round } = require('./product-video-pricing.cjs');
const mediaTools = require('./product-video-media.cjs');
const ASR_RETRY_ERRORS = new Set(['product_video_asr_failed', 'product_video_caption_timing_missing', 'product_video_caption_words_missing',
  'product_video_caption_words_mismatch', 'product_video_caption_words_invalid', 'product_video_caption_out_of_bounds', 'product_video_caption_overlap', 'product_video_caption_too_long']);
const { upscaleTo1080Size } = require('./video-upscale.cjs');
const TASK_ID = /^pv_[a-f0-9-]{36}$/u, IMAGE_ID = /^pva_[a-f0-9-]{36}$/u;
const RUNNING = new Set(['uploading', 'preparing_frames', 'frame_generating', 'locking_frames', 'preparing_audio', 'submitting', 'generating', 'assembling', 'enhancing', 'transcribing', 'packaging']);
const LABELS = { draft: '方案已保存', uploading: '上传产品图', preparing_frames: '准备场景首帧', frame_generating: '生成场景首帧', locking_frames: '锁定全部场景首帧', preparing_audio: '准备整片声音', submitting: '提交镜头', generating: '生成镜头', assembling: '合成画面与整片声音', enhancing: '本地放大画面', transcribing: '识别实际对白', packaging: '渲染大字字幕', completed: '成片已就绪', needs_attention: '需要处理', outcome_unknown: '请求待核对' };
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
  let closed = false, admissions = 0;
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
  function publicTask(task) {
    return { id: task.id, mode: task.mode, version: task.version, status: task.status, statusLabel: LABELS[task.status] || '需要处理', createdAt: task.createdAt, updatedAt: task.updatedAt,
      durationSeconds: task.durationSeconds, sceneId: task.sceneId, sceneIds: task.sceneIds || task.plan.sceneIds || [], surfaceId: task.surfaceId, dirtId: task.dirtId, goalId: task.goalId,
      productName: task.productName || '', facts: task.facts, expression: task.expression, imageId: task.imageId, budgetCny: task.budgetCny, quote: quote(task),
      plan: task.plan, currentShot: task.currentShot, completedShots: task.shots.filter((shot) => shot.file).length,
      preparation: task.plan.pipelineVersion >= 3 ? { framesReady: task.shots.filter((shot) => shot.frameFile).length, framesLocked: Boolean(task.frameManifest),
        ruleCheck: task.frameManifest?.ruleCheck || 'pending', visualReview: 'not_performed', audioReady: Boolean(task.audio), music: publicMusic(task.audio?.music) } : undefined,
      error: cleanMessage(task.error || ''), errorCode: task.errorCode || '', resumeStatus: task.resumeStatus || '', canRetry: task.status === 'needs_attention',
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
  async function admit(action) { hold(); admissions += 1; try { return await action(); } finally { admissions -= 1; } }
  async function admitTask(id, action) {
    return admit(async () => {
      if (admissionsByTask.has(id) || active.has(id)) throw fail('product_video_busy', '当前任务正在处理，请稍后刷新。');
      admissionsByTask.add(id);
      try { return await action(); } finally { admissionsByTask.delete(id); }
    });
  }
  async function create(input) {
    return admit(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['mode','durationSeconds','sceneId','sceneIds','surfaceId','dirtId','goalId','expression','facts','imageId','productName','budgetCny'].includes(key))) throw fail('product_video_invalid_input', '请重新填写视频需求。');
      asset(input.imageId);
      const plan = planVideo(input), automaticBudget = input.budgetCny === undefined;
      let budgetCny = automaticBudget ? 0 : Number(input.budgetCny);
      if (!automaticBudget && (!Number.isFinite(budgetCny) || budgetCny <= 0 || budgetCny > 10000)) throw fail('product_video_budget_invalid', '本次制作额度无效，请联系管理员。');
      let prices; try { prices = await readPrices(plan); } catch { /* Drafting remains usable offline. */ }
      if (automaticBudget && validPrices(prices)) budgetCny = quotePlan(plan, prices, 0).maximumCny;
      hold();
      const id = `pv_${randomUUID()}`, createdAt = new Date().toISOString();
      const task = { ...input, productName: String(input.productName || '').trim(), facts: String(input.facts || '').trim(), expression: String(input.expression || '').trim(),
        id, createdAt, updatedAt: createdAt, version: 3, status: 'draft', budgetCny, budgetPolicy: automaticBudget ? 'quoted_production' : 'explicit', prices, plan, sceneIds: plan.sceneIds, currentShot: 0, shots: plan.shots.map(() => ({})), operations: {}, archivedOperations: [] };
      save(task); return publicTask(task);
    });
  }
  async function capabilities(plan = { pipelineVersion: 3 }) {
    let prices; try { prices = await readPrices(plan); } catch { prices = { ready: false, message: '报价暂不可用，仍可先保存视频方案。' }; }
    const choices = { scenes: SCENES, surfaces: SURFACES, dirt: DIRT, goals: GOALS, prices, videoPricePerSecondUsd: prices.estimatedVideoUsdPerSecond ?? null,
      videoPricePerSecondCny: prices.videoCnyPerSecond ?? null };
    if (!options.gatewayClient?.isEnabled?.()) return { ...choices, ready: false, message: '生成服务暂不可用，仍可先保存方案。' };
    const state = await options.gatewayClient.initialize({ verify: true });
    const official = plan.pipelineVersion >= 3;
    const videoReady = official ? state.capabilities?.bailian && state.capabilities?.bailian_video : state.capabilities?.apimart_video;
    const audioReady = !official || typeof options.prepareAudio === 'function';
    const ready = Boolean(state.ready && state.capabilities?.apimart && videoReady && audioReady && state.capabilities?.volcengine_asr && validPrices(prices)
      && (official ? prices.provider === 'bailian' : prices.provider !== 'bailian'));
    return { ...choices, ready, message: ready ? '' : !audioReady ? '整片声音准备组件尚未就绪，未提交任何付费生成；仍可保存方案。' : '场景图片、阿里视频异步服务、声音识别或完整报价尚未就绪，仍可先保存方案。' };
  }
  function futureReserve(task, exclude, proposedReserve = 0) {
    if (!validPrices(task.prices)) throw fail('product_video_price_unavailable', '报价已失效，请刷新核价后继续。');
    if ((task.plan.pipelineVersion >= 3) !== (task.prices.provider === 'bailian')) throw fail('product_video_price_unavailable', '报价与任务原始供应商不匹配，不能套用其他模型的单价。');
    const p = task.prices; let total = 0;
    task.plan.shots.forEach((shot, index) => {
      if (task.plan.pipelineVersion >= 2 && !task.shots[index].frameFile && !task.operations[`frame_${index}`] && exclude !== `frame_${index}`) total += round(p.imageUsd * p.fxCnyPerUsd);
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
  async function operation(task, name, route, body, reserveCny = 0, headers = {}) {
    const prior = task.operations[name];
    if (prior?.response) return prior.response;
    if (prior) {
      if (prior.rejected) throw fail('product_video_request_rejected', '上次请求已明确失败，请点击重试后再提交。');
      let receipt;
      try { receipt = await provider.request(`/operations/${prior.id}`); } catch { throw fail('product_video_submission_unknown', '原请求尚未核实，保留费用预留，不重复提交。', { outcomeUnknown: true }); }
      if (receipt?.status === 'pending') throw fail('product_video_submission_unknown', '原请求仍在处理中，请稍后核对。', { outcomeUnknown: true });
      prior.response = receipt; save(task); return receipt;
    }
    hold();
    if (reserveCny && round(quote(task).reservedCny + reserveCny + futureReserve(task, name, reserveCny)) > task.budgetCny) throw fail('product_video_budget_exceeded', '剩余额度不足以覆盖本次调用和后续制作，已有成果已保留。');
    const entry = { id: randomUUID(), name, submittedAt: new Date().toISOString(), reserveCny,
      priceSnapshot: { source: task.prices?.source, checkedAt: task.prices?.checkedAt, fxCnyPerUsd: task.prices?.fxCnyPerUsd,
        videoCnyPerSecond: task.prices?.videoCnyPerSecond, ttsCnyPer10kChars: task.prices?.ttsCnyPer10kChars } };
    task.operations[name] = entry; save(task);
    const requestHeaders = name === 'asr' ? { ...headers, 'X-Api-Request-Id': entry.id } : headers;
    try { entry.response = await provider.request(route, { method: 'POST', body, headers: requestHeaders, operationId: entry.id }); save(task); return entry.response; }
    catch (error) { if (!error.outcomeUnknown) entry.rejected = true; save(task); throw error; }
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
    if (task.plan.videoProvider !== 'bailian' || task.plan.videoModel !== wan.MODEL || task.plan.sourceResolution !== '720p' || task.plan.videoAudio !== false)
      throw fail('product_video_plan_invalid', '制作方案与本次已核价的阿里720p无声路线不一致，请重新保存方案。');
    if (task.plan.shots.reduce((sum, shot) => sum + shot.seconds, 0) !== task.durationSeconds) throw fail('product_video_plan_invalid', '分镜时长与成片时长不一致，未提交视频。');
    const image = asset(task.imageId), imageUrl = `data:${image.mime};base64,${image.bytes.toString('base64')}`;
    for (const shot of task.plan.shots) {
      wan.videoRequest({ imageUrl, prompt: shot.prompt, durationSeconds: shot.seconds, resolution: task.plan.sourceResolution, audio: false });
      if (!shot.firstFramePrompt || !shot.camera || !shot.startState || !shot.endState || shot.referenceRule !== 'original_product_image'
        || (shot.evidenceStatus === 'user_supplied_unverified' && (shot.movement !== 'forward_along_visible_front' || shot.changeRule !== 'only_after_cleaning_contact')))
        throw fail('product_video_plan_invalid', '首帧依据、前进方向或清洁因果规则不完整，未提交视频。');
    }
  }
  async function lockFrames(task) {
    checkPlan(task);
    const source = asset(task.imageId), frames = [];
    for (const [index, shot] of task.shots.entries()) {
      if (!shot.frameFile) throw fail('product_video_frame_missing', '请先完成所有场景首帧，再提交视频。');
      const framePath = contained(root, shot.frameFile), bytes = fs.readFileSync(framePath);
      imageMime(bytes);
      const info = await media.probe(framePath, ffmpegPath);
      if (!info.video || Math.min(info.video.width, info.video.height) < 240 || Math.max(info.video.width, info.video.height) > 7680
        || Math.abs(info.video.width / info.video.height - 9 / 16) > 0.05)
        throw fail('product_video_frame_invalid', `第 ${index + 1} 张首帧无法解码或尺寸不符合模型要求，未提交视频。`);
      frames.push({ index, sha256: digest(bytes), originalImageSha256: source.sha256,
        firstFramePromptSha256: digest(task.plan.shots[index].firstFramePrompt), videoPromptSha256: digest(task.plan.shots[index].prompt),
        width: info.video.width, height: info.video.height, camera: task.plan.shots[index].camera,
        movement: task.plan.shots[index].movement, changeRule: task.plan.shots[index].changeRule });
    }
    task.frameManifest = { lockedAt: new Date().toISOString(), ruleCheck: 'passed', visualReview: 'not_performed',
      note: '已核对计划、参考图引用、文件摘要和可解码尺寸；不代表模型已经通过外形或物理效果的视觉验收。', frames };
    save(task);
  }
  function checkLockedInputs(task) {
    checkPlan(task);
    if (!task.frameManifest || !task.audio) throw fail('product_video_preparation_missing', '全部首帧与整片声音尚未锁定，未提交视频。');
    const original = asset(task.imageId);
    for (const [index, shot] of task.shots.entries()) {
      const frame = task.frameManifest.frames[index];
      if (!frame || frame.originalImageSha256 !== original.sha256 || frame.sha256 !== digest(fs.readFileSync(contained(root, shot.frameFile)))
        || frame.firstFramePromptSha256 !== digest(task.plan.shots[index].firstFramePrompt) || frame.videoPromptSha256 !== digest(task.plan.shots[index].prompt))
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
      operation: (name, route, body, reserveCny, headers) => {
        if (!/^audio_[a-z0-9_]+$/u.test(name) || !Number.isFinite(reserveCny) || reserveCny <= 0)
          throw fail('product_video_audio_price_missing', '声音准备缺少明确计价或回执编号，未提交请求。');
        return operation(task, name, route, body, reserveCny, headers);
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
  async function advance(task) {
    hold();
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
        const bytes = fs.readFileSync(contained(root, task.shots[index].frameFile));
        const request = wan.videoRequest({ imageUrl: `data:${imageMime(bytes)};base64,${bytes.toString('base64')}`, prompt: shot.prompt, durationSeconds: shot.seconds,
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
      const response = await operation(task, 'asr', '/volcengine/asr/recognize/flash', { user: { uid: 'xiaoxi-product-video' }, audio: { data: fs.readFileSync(audio).toString('base64') }, request: { model_name: 'bigmodel', show_utterances: true, enable_punc: true } }, task.prices.asrReserveCny,
        { 'X-Api-Resource-Id': 'volc.bigasr.auc_turbo', 'X-Api-Sequence': '-1' });
      const result = response.result || response.data?.result || response.data || response;
      if (!Array.isArray(result.utterances) || !result.utterances.length) throw fail('product_video_asr_failed', '未识别到有时间信息的对白，原声视频已保留。请检查原声后再决定是否重试识别。');
      task.captions = media.buildCaptions({ utterances: result.utterances, timeUnit: 'ms', durationSeconds: task.durationSeconds });
      task.status = official && !task.sourceFile ? 'submitting' : 'packaging'; save(task);
    }
    if (task.status === 'packaging') {
      const relative = `${task.id}/final.mp4`;
      await media.renderCaptioned({ source: contained(root, task.sourceFile), destination: contained(root, relative), captions: task.captions, ffmpegPath });
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
    save(task);
  }
  function schedule(id) {
    if (closed || active.has(id) || global.__xiaoxiUpdateHold) return;
    const promise = Promise.resolve().then(async () => { const task = read(id); if (!RUNNING.has(task.status)) return; try { await advance(task); } catch (error) { pause(task, error); } })
      .finally(() => { active.delete(id); if (!closed) { const task = read(id); if (RUNNING.has(task.status) && !global.__xiaoxiUpdateHold) timers.set(id, setTimeout(() => { timers.delete(id); schedule(id); }, options.pollMs ?? 8000)); } });
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
      task.status = 'uploading'; save(task); schedule(id); return publicTask(task);
    });
  }
  async function retryShot(id) {
    return admitTask(id, async () => {
      if (active.has(id)) throw fail('product_video_busy', '当前任务正在处理。');
      const task = read(id);
      if (task.status !== 'needs_attention') throw fail('product_video_retry_unavailable', '当前任务不能重试。');
      const index = Number.isInteger(task.failedShotIndex) ? task.failedShotIndex : task.currentShot;
      let name;
      if (Number.isInteger(task.failedShotIndex)) {
        if (index < 0 || index >= task.shots.length) throw fail('product_video_data_invalid', '待重做镜头编号无效，原任务已保留。');
        name = `shot_${index}`; task.currentShot = index; task.resumeStatus = 'submitting';
        delete task.shots[index].file; delete task.shots[index].providerTaskId;
      }
      else if (task.errorCode === 'product_video_frame_failed') { name = `frame_${index}`; task.resumeStatus = 'preparing_frames'; }
      else if (task.errorCode === 'product_video_video_failed' || task.errorCode === 'product_video_shot_failed') { name = `shot_${index}`; task.resumeStatus = 'submitting'; }
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
        const stageKey = { preparing_frames: `frame_${task.currentShot}`, submitting: `shot_${task.currentShot}`, transcribing: 'asr', uploading: 'upload_image' }[task.resumeStatus];
        const entry = task.operations[stageKey] || Object.values(task.operations).find((op) => !op.response && !op.rejected);
        if (entry) {
          try {
            const result = await provider.request(`/operations/${entry.id}`);
            if (result?.status !== 'pending') { entry.response = result; task.status = task.resumeStatus; task.error = ''; task.errorCode = ''; save(task); }
          } catch { /* Unknown means query again later, never create a replacement paid request. */ }
        }
      }
      if (RUNNING.has(task.status)) schedule(id);
      return publicTask(task);
    });
  }
  function preview(id) {
    const task = read(id);
    if (task.status !== 'completed' || !task.finalFile) throw fail('product_video_not_ready', '成片尚未就绪。');
    const source = contained(root, task.finalFile);
    if (fs.statSync(source).size > 70 * 1024 * 1024) throw fail('product_video_preview_too_large', '成片较大，请直接导出观看。');
    return { dataUrl: `data:video/mp4;base64,${fs.readFileSync(source).toString('base64')}` };
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
    if (admissions || active.size) return true;
    return taskIds().some((id) => { try { const t = read(id); return RUNNING.has(t.status) || t.status === 'outcome_unknown'; } catch { return false; } });
  }
  function close() { closed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); }
  return { capabilities, importImage, importFacts, create, list, get: (id) => publicTask(read(id)), start, retryShot, refresh, media: preview, exportVideo, exportSource: (id, destination) => exportVideo(id, destination, true), isBusy, close };
}
module.exports = { createProductVideoService };
