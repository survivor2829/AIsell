// 爆款一键成片：选中一条爆款后依次完成 提取原口播 → 仿写 → 配音 → 数字人 → 剪辑包装 → 大字封面。
// 付费环节全部复用已有的写稿回执和本人口播任务（同一操作只提交一次，失败重试不重复扣费）；
// 本模块只负责排队、把每一步的进度记到磁盘、在重启后从断点继续。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { writeJsonAtomic } = require('./atomic-file.cjs');

const JOB_ID = /^vp_[a-f0-9-]{36}$/u;
const STEPS = [
  { id: 'extract', label: '提取原文' }, { id: 'write', label: '仿写' }, { id: 'voice', label: '配音' },
  { id: 'video', label: '数字人' }, { id: 'package', label: '剪辑' }, { id: 'cover', label: '封面' }
];
const VIDEO_STATES = new Set(['video_submitting', 'video_generating']);
const ASR_SECONDS = 180;
const DEFAULT_MAX_CNY = 6;
// 爆款原链接只接受平台作品页。
function postUrl(value, platform) {
  try { const u = new URL(String(value)); return u.protocol === 'https:' && (platform === 'douyin' ? ['www.douyin.com', 'douyin.com'] : ['www.xiaohongshu.com', 'xiaohongshu.com']).includes(u.hostname); }
  catch { return false; }
}
const problem = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const chars = (text) => [...String(text || '')];
const clean = (text) => String(text || '').replace(/[\u0000-\u001f\u007f]/gu, '').trim();

// 封面文字从发布标题和重点短语里取，不另外调用模型：主标题 ≤12 字、副标题 ≤8 字、标签最多 3 个。
function coverWords(title, phrases = []) {
  const parts = clean(title).split(/[，。！？、；：,.!?;:\s]+/u).filter(Boolean);
  const main = parts.find((p) => chars(p).length >= 4 && chars(p).length <= 12) || chars(parts[0] || title).slice(0, 12).join('');
  const short = (p) => chars(p).length >= 2 && chars(p).length <= 8 && !main.includes(p);
  const subtitle = parts.find((p) => p !== main && short(p)) || phrases.find(short) || '';
  const tags = phrases.filter((p) => p !== subtitle && short(p)).slice(0, 3);
  return { title: main, subtitle, tags };
}

// 优先用视频原声转文字；小红书图文用正文；都拿不到再退回视频描述（会注明只用了描述）。
function textFromUtterances(response) {
  const result = response?.result || response?.data?.result || response?.data || response || {};
  const text = typeof result.text === 'string' && result.text.trim() ? result.text : (Array.isArray(result.utterances) ? result.utterances.map((u) => u?.text || '').join('') : '');
  return clean(text).slice(0, 6000);
}

function createViralPipeline(options) {
  const { root, reference, scout, provider, notify = () => {}, onChange = () => {}, renderCover, probe, resolveVideo, fontFile } = options;
  const ffmpeg = options.ffmpegPath || 'ffmpeg';
  const run = options.run || promisify(execFile);
  const pollMs = options.pollMs ?? 4000;
  const dir = path.join(root, 'viral-jobs');
  fs.mkdirSync(dir, { recursive: true });
  let pumping = null, closed = false;
  // 软件正在关闭时，任何付费步骤都不再开始；任务回到排队，下次打开继续。
  const stopIfClosing = () => { if (closed) throw problem('viral_closed', '软件关闭，下次打开后继续。', { paused: true }); };
  // 同一条爆款：已经建过口播任务、用过写稿额度，或者还能重试的，都不再新建第二条，避免重复扣费。
  const holdsItem = (job) => job.status !== 'done' && (['queued', 'running'].includes(job.status) || !job.final || Boolean(job.taskId || job.writeIntent));

  const file = (id) => { if (!JOB_ID.test(id)) throw problem('viral_job_not_found', '找不到这条一键成片任务。'); return path.join(dir, `${id}.json`); };
  const workDir = (id) => { const d = path.join(dir, id); fs.mkdirSync(d, { recursive: true }); return d; };
  const read = (id) => { const f = file(id); if (!fs.existsSync(f)) throw problem('viral_job_not_found', '找不到这条一键成片任务。'); return JSON.parse(fs.readFileSync(f, 'utf8')); };
  const all = () => fs.readdirSync(dir).filter((n) => /^vp_.*\.json$/u.test(n)).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  function save(job, patch = {}) { Object.assign(job, patch, { updatedAt: new Date().toISOString() }); writeJsonAtomic(file(job.id), job); onChange(list()); return job; }

  function publicJob(job) {
    const index = STEPS.findIndex((s) => s.id === job.step);
    return { id: job.id, mode: job.mode || 'post', itemId: job.item.id, title: job.item.title, platform: job.item.platform, url: job.item.url, status: job.status, step: job.step,
      steps: STEPS.map((s, i) => ({ ...s, state: job.status === 'done' || i < index ? 'done' : i === index ? (job.status === 'failed' ? 'failed' : job.status === 'running' ? 'active' : 'waiting') : 'waiting' })),
      progress: job.progress || 0, message: job.message || '', error: job.error || '', retryable: job.status === 'failed' && !job.final,
      transcriptSource: job.transcriptSource || null, script: job.script ? { title: job.script.title, originality: job.script.originality || null } : null,
      taskId: job.taskId || null, generatedVideoId: job.generatedVideoId || null, coverReady: Boolean(job.coverFile && fs.existsSync(job.coverFile)), coverError: job.coverError || '',
      quoteMaximumCny: job.quoteMaximumCny ?? null, maxCny: job.maxCny, holdsItem: holdsItem(job), createdAt: job.createdAt, updatedAt: job.updatedAt };
  }
  const list = () => ({ items: all().map(publicJob).reverse() });

  // ---- 1. 提取原口播 ----
  async function extract(job) {
    const item = job.item;
    if (item.platform === 'xiaohongshu' && !item.media && chars(item.body).length >= 40) return save(job, { transcript: clean(item.body).slice(0, 6000), transcriptSource: 'note' });
    if (item.media?.url || job.asr) {
      if (!job.asr?.response) {
        const audio = path.join(workDir(job.id), 'source.wav');
        if (!job.asr) {
          // 下载和抽音频都在本地，失败不花钱；音频准备好之后才登记识别操作。
          const video = path.join(workDir(job.id), 'source.mp4');
          if (!fs.existsSync(video)) { save(job, { message: '正在下载爆款视频' }); await scout.downloadMedia(item, video); }
          save(job, { message: '正在提取原声' });
          await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-t', String(ASR_SECONDS), '-c:a', 'pcm_s16le', audio], { windowsHide: true, timeout: 120000 });
          save(job, { asr: { id: randomUUID(), submittedAt: new Date().toISOString() } });
        }
        save(job, { message: '正在把原口播转成文字' });
        let response;
        if (job.asr.submitted) {
          // 重启后：同一识别操作只查回执，不重新提交。回执证明原请求被拒绝（没扣费）时，下次重试换新操作号。
          try { response = await provider.request(`/operations/${job.asr.id}`); }
          catch (error) { if (error.originalRequestRejected) save(job, { asr: null }); throw error; }
          if (!response || response.status === 'pending') throw problem('viral_asr_pending', '原口播识别结果还在核对，稍后点重试查询；不会重复扣费。', { outcomeUnknown: true });
        } else {
          stopIfClosing();
          save(job, { asr: { ...job.asr, submitted: true } });
          try {
            response = await provider.request('/volcengine/asr/recognize/flash', { method: 'POST', operationId: job.asr.id,
              headers: { 'X-Api-Resource-Id': 'volc.bigasr.auc_turbo', 'X-Api-Sequence': '-1', 'X-Api-Request-Id': job.asr.id },
              body: { user: { uid: 'xiaoxi-viral-pipeline' }, audio: { data: fs.readFileSync(audio).toString('base64') }, request: { model_name: 'bigmodel', enable_punc: true } } });
          } catch (error) {
            // 明确被拒绝的请求没有扣费，下次重试用新的操作号；结果不明的保留原操作号，只查回执。
            if (!error.outcomeUnknown) save(job, { asr: null });
            throw error;
          }
        }
        save(job, { asr: { ...job.asr, response: { text: textFromUtterances(response) } } });
      }
      const text = job.asr.response.text;
      if (chars(text).length >= 20) return save(job, { transcript: text, transcriptSource: 'asr' });
    }
    if (chars(item.body).length >= 20) return save(job, { transcript: clean(item.body).slice(0, 6000), transcriptSource: 'caption' });
    throw problem('viral_transcript_missing', '这条爆款读不到原口播（视频没有可识别的讲话，描述也太短），换一条试试。', { final: true });
  }

  // ---- 2. 仿写（复用写稿回执：同一意图只扣一次额度） ----
  async function write(job) {
    if (!job.writeIntent) save(job, { writeIntent: randomUUID() });
    stopIfClosing();
    save(job, { message: '正在仿写：只仿结构，内容用你的资料' });
    const item = job.item;
    const referenceSource = { platform: item.platform, title: chars(item.title).slice(0, 200).join(''), body: chars(job.transcript).slice(0, 6000).join(''), url: item.url, author: item.author || '',
      publishedAt: item.publishedAt || null, collectedAt: job.createdAt, metrics: { likes: Number.isFinite(item.likes) ? item.likes : null }, provenance: `扒爆款 · ${item.platform === 'xiaohongshu' ? '小红书' : '抖音'}` };
    let result;
    try { result = await reference.writeScript({ referenceAssetId: job.assetId, industry: job.industry, business: job.business, referenceSource, generationIntentId: job.writeIntent }); }
    catch (error) { if (/不适合仿写|reference_script_rejected/u.test(`${error.code} ${error.message}`)) error.final = true; throw error; }
    if (result.originality && !result.originality.passed) throw problem('viral_not_original', `这条不适合仿写：仿写稿和原文重复 ${Math.round(result.originality.overlapRatio * 100)}%，超过 15%，已停止，没有进入配音和数字人。`, { final: true });
    return save(job, { script: { title: result.title, script: result.script, emphasisPhrases: result.emphasisPhrases || [], originality: result.originality || null, structure: result.structure || [] } });
  }

  // ---- 3—5. 配音、数字人、剪辑包装：交给本人口播任务 ----
  async function produce(job) {
    stopIfClosing();
    if (!job.taskId) {
      const task = reference.create({ referenceAssetId: job.assetId, script: job.script.script, title: chars(job.script.title).slice(0, 24).join(''), emphasisPhrases: job.script.emphasisPhrases,
        industry: job.industry, business: job.business, includeCover: false, packagingMode: 'auto', soundEffects: true, referenceSource: { platform: job.item.platform, title: chars(job.item.title).slice(0, 200).join(''), body: '', url: job.item.url, author: job.item.author || '', provenance: '扒爆款' } });
      save(job, { taskId: task.id });
    }
    let task = await reference.get(job.taskId);
    if (task.status === 'draft') {
      save(job, { message: '正在核价' });
      task = await reference.quote(job.taskId);
      const maximum = task.quote?.maximumCny;
      save(job, { quoteMaximumCny: Number.isFinite(maximum) ? maximum : null });
      if (!(maximum > 0)) throw problem('viral_quote_missing', '没有拿到这条的报价，没有开始付费制作。');
      if (maximum > job.maxCny) throw problem('viral_budget', `这条最多要 ${maximum} 元，超过每条 ${job.maxCny} 元的上限，没有开始付费制作。`, { final: true });
      stopIfClosing();
      save(job, { message: '正在配音' });
      // 声音授权只认用户在本人数字分身里确认过的记录（customerConsent 传 false，不代为同意）。
      try { task = await reference.prepare(job.taskId, task.quoteRevision, false, true); }
      catch (error) {
        if (error.code === 'voice_clone_consent_required') throw problem('viral_voice_consent', '这位出镜人物还没确认声音授权，请先在「本人数字分身」里做一条口播并确认授权，再回来重试。');
        throw error;
      }
    }
    for (;;) {
      if (closed) throw problem('viral_closed', '软件关闭，下次打开后继续。', { paused: true });
      if (task.status === 'completed') return save(job, { generatedVideoId: task.generatedVideoId, progress: 100 });
      if (['needs_attention', 'outcome_unknown'].includes(task.status)) throw problem('viral_task_attention', task.error || task.statusLabel || '口播制作需要处理，现有结果和回执已保留。', { taskStatus: task.status });
      const step = task.status === 'packaging' ? 'package' : VIDEO_STATES.has(task.status) ? 'video' : 'voice';
      save(job, { step, progress: Math.max(0, Math.min(99, Number(task.progress) || 0)), message: task.statusLabel || '' });
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      task = await reference.get(job.taskId);
    }
  }

  // ---- 6. 大字封面：本地合成，失败不影响成片 ----
  async function cover(job) {
    try {
      const resolved = await resolveVideo(job.generatedVideoId);
      const video = resolved?.absolute_path;
      if (!video || !fs.existsSync(video)) throw problem('viral_cover_source', '没有找到成片文件，封面稍后可重试。');
      const size = await probe(video);
      const words = coverWords(job.script.title, job.script.emphasisPhrases);
      const target = path.join(workDir(job.id), 'cover.jpg');
      await renderCover({ ffmpegPath: ffmpeg, source: video, seconds: 1, sourceSize: { width: size.width, height: size.height }, ...words, fontFile, target });
      save(job, { coverFile: target, coverError: '' });
    } catch (error) { save(job, { coverError: error.message || '封面没有生成，成片不受影响。' }); }
  }

  async function runJob(job) {
    save(job, { status: 'running', error: '', message: '' });
    try {
      if (!job.transcript && !job.script) { save(job, { step: 'extract' }); await extract(job); }
      if (!job.script) { save(job, { step: 'write' }); await write(job); }
      // 内部做文案库：只提取和改写，不配音、不生成数字人。
      if (job.mode === 'library') return save(job, { status: 'done', step: 'done', progress: 100, message: '已改写，等待发布到文案库' });
      if (!job.generatedVideoId) { if (!['voice', 'video', 'package'].includes(job.step)) save(job, { step: 'voice' }); await produce(job); }
      save(job, { step: 'cover', message: '正在合成大字封面' }); await cover(job);
      save(job, { status: 'done', step: 'done', progress: 100, message: '已完成，成片在成片中心' });
      notify('一键成片完成', job.script.title);
    } catch (error) {
      if (error.paused) return save(job, { status: 'queued', message: error.message });
      save(job, { status: 'failed', error: error.message || '这一步没有完成，已有结果保留。', final: Boolean(error.final), taskStatus: error.taskStatus || null });
      notify('一键成片停下了', `${chars(job.item.title).slice(0, 20).join('')}：${error.message || ''}`);
    }
  }

  function pump() {
    if (pumping || closed) return pumping;
    pumping = (async () => {
      for (let next; !closed && (next = all().find((j) => j.status === 'running') || all().find((j) => j.status === 'queued'));) {
        // 记录写不进磁盘时停下排队，不在同一条任务上反复空转。
        try { await runJob(next); } catch { break; }
      }
    })().finally(() => { pumping = null; });
    return pumping;
  }

  function start({ item, assetId, industry, business, maxCny, mode = 'post' }) {
    if (!item || !/^[A-Za-z0-9]{1,64}$/u.test(String(item.id || '')) || !['douyin', 'xiaohongshu'].includes(item.platform) || !postUrl(item.url, item.platform)) throw problem('viral_item_invalid', '请从爆款卡片上点「一键成片」。');
    // 人物和声音授权在开始前就核对，免得先花了识别费和写稿额度、到配音才被拦下。
    const person = assetId ? reference.assets().items.find((a) => a.id === assetId) : null;
    if (!person || person.available === false || !person.voiceSampleReady) throw problem('viral_person_missing', '请先在「本人数字分身」里保存出镜人物和声音。');
    if (mode !== 'library' && !person.voiceConsented) throw problem('viral_voice_consent', '这位出镜人物还没确认声音授权，请先在「本人数字分身」里做一条口播并确认授权。');
    // 文案库稿子改写完就够了，再点一次不重复花识别费和写稿额度。
    const duplicate = all().find((j) => j.item.id === String(item.id) && (j.mode || 'post') === mode && (holdsItem(j) || (mode === 'library' && j.status === 'done')));
    if (duplicate) return publicJob(duplicate);
    const limit = Number(maxCny) > 0 ? Math.min(Number(maxCny), 50) : DEFAULT_MAX_CNY;
    const job = { id: `vp_${randomUUID()}`, mode, createdAt: new Date().toISOString(), status: 'queued', step: 'extract', progress: 0, maxCny: limit,
      assetId, industry: clean(industry).slice(0, 80) || '清洁设备渠道商', business: clean(business).slice(0, 2000),
      item: { id: String(item.id), platform: item.platform, url: item.url, title: clean(item.title).slice(0, 200), body: clean(item.body).slice(0, 6000), author: clean(item.author?.name ?? item.author).slice(0, 120),
        publishedAt: typeof item.publishedAt === 'string' && Number.isFinite(Date.parse(item.publishedAt)) ? item.publishedAt.slice(0, 64) : null, likes: item.metrics?.likes ?? null, media: typeof item.media?.url === 'string' ? { url: item.media.url.slice(0, 2000), durationSeconds: Number.isFinite(item.media.durationSeconds) ? item.media.durationSeconds : null } : null } };
    save(job); void pump(); return publicJob(job);
  }

  // 客户从爆款文案库选了一条原创稿：跳过提取和改写，直接从配音开始（不扣写稿额度）。
  function startFromScript({ libraryItem: entry, assetId, industry, business, maxCny }) {
    const valid = entry && /^[A-Za-z0-9]{1,64}$/u.test(String(entry.id || '')) && ['douyin', 'xiaohongshu'].includes(entry.platform)
      && typeof entry.title === 'string' && entry.title.trim() && chars(entry.title).length <= 24 && typeof entry.script === 'string' && entry.script.trim() && chars(entry.script).length <= 500;
    if (!valid) throw problem('viral_item_invalid', '请从文案库里选一条文案。');
    const person = assetId ? reference.assets().items.find((a) => a.id === assetId) : null;
    if (!person || person.available === false || !person.voiceSampleReady) throw problem('viral_person_missing', '请先上传本人视频。');
    if (!person.voiceConsented) throw problem('viral_voice_consent', '请先确认视频和声音是你本人的。');
    const itemId = `lib${entry.id}`.slice(0, 64);
    const duplicate = all().find((j) => j.item.id === itemId && holdsItem(j));
    if (duplicate) return publicJob(duplicate);
    const url = postUrl(entry.source?.url, entry.platform) ? String(entry.source.url) : '';
    const phrases = (Array.isArray(entry.emphasisPhrases) ? entry.emphasisPhrases : []).filter((p) => typeof p === 'string' && chars(p).length <= 12 && entry.script.includes(p)).slice(0, 5);
    const job = { id: `vp_${randomUUID()}`, mode: 'script', createdAt: new Date().toISOString(), status: 'queued', step: 'voice', progress: 0,
      maxCny: Number(maxCny) > 0 ? Math.min(Number(maxCny), 50) : DEFAULT_MAX_CNY, assetId, industry: clean(industry).slice(0, 80) || '清洁设备渠道商', business: clean(business).slice(0, 2000),
      transcriptSource: 'library', script: { title: clean(entry.title).slice(0, 24), script: clean(entry.script).slice(0, 500), emphasisPhrases: phrases, originality: null, structure: [] },
      item: { id: itemId, platform: entry.platform, url, title: clean(entry.source?.title || entry.title).slice(0, 200), body: '', author: clean(entry.source?.author).slice(0, 120), publishedAt: null, likes: Number.isFinite(entry.source?.likes) ? entry.source.likes : null, media: null } };
    save(job); void pump(); return publicJob(job);
  }
  // 内部：已改写好的文案库稿子（发布前汇总用）。
  function libraryScripts() {
    return all().filter((j) => j.mode === 'library' && j.status === 'done' && j.script).map((j) => ({ sourceId: j.item.id, ...j.script }));
  }

  // 重试：已提交的付费操作都走原回执；口播任务卡住时先按原任务恢复，不新建任务。
  async function retry(id) {
    const job = read(id);
    if (job.status !== 'failed' || job.final) throw problem('viral_retry_unavailable', '这条不能重试，可以换一条爆款。');
    if (job.taskId && job.taskStatus) {
      const task = await reference.get(job.taskId);
      if (task.status === 'needs_attention' && task.canResume) await reference.resume(job.taskId);
      else if (task.status === 'outcome_unknown' || task.canRefresh) await reference.refresh(job.taskId);
    }
    save(job, { status: 'queued', error: '', taskStatus: null }); void pump(); return publicJob(read(id));
  }
  // 只删记录和本地临时文件；成片和口播任务、回执都保留。进行中的不能删。
  function remove(id) {
    const job = read(id);
    if (job.status === 'running') throw problem('viral_job_running', '正在制作的任务不能删除。');
    // 已建口播任务但还没做完的保留记录：删了会让同一条爆款能再点一次、重复花钱。
    if (job.taskId && job.status !== 'done') throw problem('viral_job_paid', '这条已经开始付费制作，请重试完成或在本人数字分身里处理，不能移出队列。');
    fs.rmSync(path.join(dir, id), { recursive: true, force: true }); fs.rmSync(file(id), { force: true }); onChange(list()); return { removed: true };
  }
  function coverPath(id) { const job = read(id); if (!job.coverFile || !fs.existsSync(job.coverFile)) throw problem('viral_cover_missing', '封面还没有生成。'); return job.coverFile; }

  return { start, startFromScript, libraryScripts, list, retry, remove, coverPath, resume: () => { void pump(); }, isBusy: () => Boolean(pumping), close: () => { closed = true; return pumping; } };
}

module.exports = { createViralPipeline, coverWords, textFromUtterances, STEPS, JOB_ID };
