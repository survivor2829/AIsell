const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createViralPipeline, coverWords, textFromUtterances } = require('./viral-pipeline.cjs');

assert.deepEqual(coverWords('买还是租？算完这笔账，八成物业选错', ['八成物业选错', '洗地机租赁', '物业降本', '这个短语太长了不能上封面']),
  { title: '买还是租', subtitle: '算完这笔账', tags: ['八成物业选错', '洗地机租赁', '物业降本'] });
assert.equal(coverWords('一二三四五六七八九十甲乙丙丁').title, '一二三四五六七八九十甲乙', '没有标点时截到 12 字');
assert.equal(textFromUtterances({ result: { utterances: [{ text: '物业经理' }, { text: '别再招保洁了' }] } }), '物业经理别再招保洁了');
assert.equal(textFromUtterances({ result: { text: ' 整段文字 ' } }), '整段文字');

const ORIGINAL = '物业经理千万别再招保洁了，一台洗地机顶六个人，一年省下二十万人工，评论区都在问多少钱，今天我就把账算给你看。';
const item = (id, patch = {}) => ({ id, platform: 'douyin', url: `https://www.douyin.com/video/${id}`, title: '物业经理别再招保洁了', body: '#物业 #洗地机', author: { name: '保洁老周' },
  metrics: { likes: 83900 }, media: { url: 'https://v3-web.douyinvod.com/a.mp4', durationSeconds: 40 }, ...patch });

function world({ quoteCny = 4, original = true, attentionOnce = false, asrRejectOnce = false, consented = true, queryRejected = false } = {}) {
  const calls = { download: 0, ffmpeg: 0, asr: [], asrQuery: 0, write: [], create: 0, quote: 0, prepare: 0, resume: 0, refresh: 0, cover: 0, notify: [] };
  const tasks = new Map();
  let attention = attentionOnce, asrReject = asrRejectOnce;
  const advance = (task) => {
    // 每次查询推进一格：配音 → 数字人 → 剪辑 → 完成；可以模拟一次中途失败
    const order = ['audio_preparing', 'video_submitting', 'video_generating', 'packaging', 'completed'];
    if (attention && task.status === 'video_generating') { attention = false; task.status = 'needs_attention'; task.canResume = true; task.error = '数字人生成失败'; return; }
    const next = order[order.indexOf(task.status) + 1];
    if (next) { task.status = next; task.progress = { video_submitting: 30, video_generating: 50, packaging: 80, completed: 100 }[next]; }
    if (task.status === 'completed') task.generatedVideoId = `generated_video_${task.id}`;
  };
  const reference = {
    assets: () => ({ items: [{ id: 'rha_1', available: true, voiceSampleReady: true, voiceConsented: consented }] }),
    writeScript: async (input) => { calls.write.push(input); return { title: '买还是租？算完这笔账', script: '你还在为夜班保洁排不开人发愁吗？先看地面材质，再算清洁面积。', emphasisPhrases: ['洗地机租赁'],
      originality: original ? { overlapRatio: 0.04, passed: true, attempts: 1 } : { overlapRatio: 0.4, passed: false, attempts: 2 }, structure: [{ part: '钩子', method: '反问' }] }; },
    create: (input) => { calls.create++; const task = { id: `rh_task_${calls.create}`, status: 'draft', input }; tasks.set(task.id, task); return { ...task }; },
    get: async (id) => { const task = tasks.get(id); if (!['draft', 'needs_attention', 'outcome_unknown'].includes(task.status)) advance(task); return { ...task }; },
    quote: async (id) => { calls.quote++; const task = tasks.get(id); task.quote = { maximumCny: quoteCny }; task.quoteRevision = 'rev-1'; return { ...task }; },
    prepare: async (id, revision, consent, generateVideo) => { calls.prepare++; assert.equal(revision, 'rev-1'); assert.equal(consent, false, '不代为确认声音授权'); assert.equal(generateVideo, true);
      const task = tasks.get(id); task.status = 'audio_preparing'; task.progress = 10; return { ...task }; },
    resume: async (id) => { calls.resume++; tasks.get(id).status = 'video_generating'; },
    refresh: async () => { calls.refresh++; }
  };
  const provider = { request: async (route, init = {}) => {
    if (route.startsWith('/operations/')) { calls.asrQuery++; if (queryRejected) { queryRejected = false; throw Object.assign(new Error('rejected receipt'), { originalRequestRejected: true }); } return { result: { text: ORIGINAL } }; }
    calls.asr.push(init.operationId);
    if (asrReject) { asrReject = false; throw Object.assign(new Error('rejected'), { outcomeUnknown: false }); }
    assert.ok(init.body.audio.data.length > 0);
    return { result: { utterances: [{ text: ORIGINAL }] } };
  } };
  const deps = {
    scout: { downloadMedia: async (_item, target) => { calls.download++; fs.writeFileSync(target, 'video'); } },
    provider, reference, pollMs: 1, ffmpegPath: 'ffmpeg-test',
    run: async (_bin, args) => { calls.ffmpeg++; fs.writeFileSync(args.at(-1), 'wav'); },
    resolveVideo: async (id) => { const file = path.join(os.tmpdir(), `${id}.mp4`); fs.writeFileSync(file, 'mp4'); return { generated_video_id: id, absolute_path: file }; },
    probe: async () => ({ width: 1080, height: 1920 }),
    renderCover: async (input) => { calls.cover++; assert.equal(input.title, '买还是租'); assert.equal(input.subtitle, '算完这笔账'); fs.writeFileSync(input.target, 'jpg'); },
    fontFile: 'font.ttf', notify: (title) => calls.notify.push(title)
  };
  return { calls, tasks, deps, reference };
}
const until = async (pipeline, id, status) => {
  for (let i = 0; i < 400; i++) { const job = pipeline.list().items.find((j) => j.id === id); if (status.includes(job.status)) return job; await new Promise((r) => setTimeout(r, 2)); }
  throw new Error(`job did not reach ${status}`);
};
const newRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'viral-pipeline-'));
const start = (pipeline, extra = {}) => pipeline.start({ item: item('7400000000000000001'), assetId: 'rha_1', industry: '清洁设备渠道商', business: '本公司洗地机支持租赁', ...extra });

(async () => {
  // 1. 正常一键到底：每个付费环节只提交一次，封面本地合成，完成后通知
  {
    const w = world(), root = newRoot();
    const pipeline = createViralPipeline({ root, ...w.deps });
    const job = start(pipeline);
    const done = await until(pipeline, job.id, ['done', 'failed']);
    assert.equal(done.status, 'done', done.error);
    assert.deepEqual(done.steps.map((s) => s.state), ['done', 'done', 'done', 'done', 'done', 'done']);
    assert.equal(done.transcriptSource, 'asr');
    assert.equal(done.coverReady, true);
    assert.deepEqual([w.calls.download, w.calls.ffmpeg, w.calls.asr.length, w.calls.write.length, w.calls.create, w.calls.quote, w.calls.prepare, w.calls.cover], [1, 1, 1, 1, 1, 1, 1, 1]);
    assert.equal(w.calls.write[0].referenceSource.body, ORIGINAL, '仿写用的是原口播转写，不是视频描述');
    assert.equal(w.calls.write[0].business, '本公司洗地机支持租赁');
    assert.equal(w.tasks.get(done.taskId).input.includeCover, false, '不走付费 AI 封面');
    assert.deepEqual(w.calls.notify, ['一键成片完成']);
    assert.equal(start(pipeline).id === job.id, false, '做完的爆款可以再做一条');
    await pipeline.close();
  }
  // 2. 报价超过每条上限：不配音、不生成数字人
  {
    const w = world({ quoteCny: 8 }), pipeline = createViralPipeline({ root: newRoot(), ...w.deps });
    const failed = await until(pipeline, start(pipeline).id, ['done', 'failed']);
    assert.match(failed.error, /超过每条 6 元的上限/);
    assert.equal(failed.retryable, false);
    assert.equal(w.calls.prepare, 0);
    await pipeline.close();
  }
  // 3. 仿写不达标：停在仿写，不建口播任务
  {
    const w = world({ original: false }), pipeline = createViralPipeline({ root: newRoot(), ...w.deps });
    const failed = await until(pipeline, start(pipeline).id, ['done', 'failed']);
    assert.match(failed.error, /不适合仿写.*40%/);
    assert.equal(w.calls.create, 0);
    await pipeline.close();
  }
  // 4. 关软件再打开：从断点继续，已提交的识别、写稿、配音和数字人都不再提交
  {
    const w = world(), root = newRoot();
    let first = createViralPipeline({ root, ...w.deps, pollMs: 50 });
    const job = start(first);
    for (let i = 0; i < 400 && !(first.list().items[0].step === 'video'); i++) await new Promise((r) => setTimeout(r, 2));
    await first.close();
    assert.equal(first.list().items[0].status, 'queued', '关闭时进行中的任务回到排队，不算失败');
    const second = createViralPipeline({ root, ...w.deps });
    second.resume();
    const done = await until(second, job.id, ['done', 'failed']);
    assert.equal(done.status, 'done', done.error);
    assert.deepEqual([w.calls.asr.length, w.calls.write.length, w.calls.create, w.calls.prepare], [1, 1, 1, 1]);
    await second.close();
  }
  // 5. 数字人中途失败：可以重试，重试按原任务恢复，不重新配音或新建任务
  {
    const w = world({ attentionOnce: true }), pipeline = createViralPipeline({ root: newRoot(), ...w.deps });
    const job = start(pipeline);
    const failed = await until(pipeline, job.id, ['done', 'failed']);
    assert.equal(failed.status, 'failed'); assert.equal(failed.retryable, true); assert.match(failed.error, /数字人生成失败/);
    assert.equal(failed.steps.find((s) => s.state === 'failed').id, 'video');
    await pipeline.retry(job.id);
    const done = await until(pipeline, job.id, ['done', 'failed']);
    assert.equal(done.status, 'done', done.error);
    assert.deepEqual([w.calls.resume, w.calls.prepare, w.calls.create], [1, 1, 1]);
    await pipeline.close();
  }
  // 6. 识别请求被明确拒绝（没扣费）：重试时换新的操作号
  {
    const w = world({ asrRejectOnce: true }), pipeline = createViralPipeline({ root: newRoot(), ...w.deps });
    const job = start(pipeline);
    assert.equal((await until(pipeline, job.id, ['done', 'failed'])).status, 'failed');
    await pipeline.retry(job.id);
    assert.equal((await until(pipeline, job.id, ['done', 'failed'])).status, 'done');
    assert.equal(w.calls.asr.length, 2); assert.notEqual(w.calls.asr[0], w.calls.asr[1]);
    assert.equal(w.calls.download, 1, '已下载的视频不重复下载');
    await pipeline.close();
  }
  // 7. 小红书图文：直接用笔记正文，不下载、不识别
  {
    const w = world(), pipeline = createViralPipeline({ root: newRoot(), ...w.deps });
    const job = start(pipeline, { item: item('6720000000000000000000ab', { platform: 'xiaohongshu', url: 'https://www.xiaohongshu.com/explore/6720000000000000000000ab', media: null, body: ORIGINAL }) });
    const done = await until(pipeline, job.id, ['done', 'failed']);
    assert.equal(done.transcriptSource, 'note');
    assert.deepEqual([w.calls.download, w.calls.asr.length], [0, 0]);
    // 删除只删记录，进行中的不能删
    assert.deepEqual(pipeline.remove(job.id), { removed: true });
    assert.equal(pipeline.list().items.length, 0);
    await pipeline.close();
  }
  // 8. 失败后再点同一条：不新建第二条（不会再扣写稿额度或重新配音）；已开始付费的不能移出队列
  {
    const w = world({ attentionOnce: true }), pipeline = createViralPipeline({ root: newRoot(), ...w.deps });
    const job = start(pipeline);
    assert.equal((await until(pipeline, job.id, ['done', 'failed'])).status, 'failed');
    assert.equal(start(pipeline).id, job.id, '同一条爆款返回原任务');
    assert.equal(pipeline.list().items.length, 1);
    assert.equal(pipeline.list().items[0].holdsItem, true);
    assert.throws(() => pipeline.remove(job.id), { code: 'viral_job_paid' });
    assert.deepEqual([w.calls.write.length, w.calls.create], [1, 1]);
    await pipeline.close();
  }
  // 9. 识别已提交后软件退出：重启只查回执，不重新提交；回执证明原请求被拒绝时换新操作号
  for (const rejected of [false, true]) {
    const w = world({ queryRejected: rejected }), root = newRoot();
    const first = createViralPipeline({ root, ...w.deps });
    const job = start(first);
    await first.close();
    const file = path.join(root, 'viral-jobs', `${job.id}.json`);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 模拟：识别请求已发出、结果没来得及写盘就退出
    Object.assign(saved, { status: 'running', step: 'extract', transcript: undefined, script: undefined, taskId: undefined, generatedVideoId: undefined, asr: { id: 'op-before-crash', submitted: true } });
    fs.writeFileSync(file, JSON.stringify(saved));
    const asrBefore = w.calls.asr.length;
    const second = createViralPipeline({ root, ...w.deps });
    second.resume();
    let state = await until(second, job.id, ['done', 'failed']);
    if (rejected) {
      assert.equal(state.status, 'failed');
      assert.equal(w.calls.asr.length, asrBefore, '查到被拒绝时这一轮不自动重发');
      await second.retry(job.id);
      state = await until(second, job.id, ['done', 'failed']);
      assert.equal(w.calls.asr.length, asrBefore + 1); assert.notEqual(w.calls.asr.at(-1), 'op-before-crash');
    } else assert.equal(w.calls.asr.length, asrBefore, '只查回执，不重新提交识别');
    assert.equal(state.status, 'done', state.error);
    assert.ok(w.calls.asrQuery >= 1);
    await second.close();
  }
  // 10. 关闭后不再开始任何付费步骤
  {
    const w = world(), pipeline = createViralPipeline({ root: newRoot(), ...w.deps });
    const realDownload = w.deps.scout.downloadMedia;
    let closing;
    w.deps.scout.downloadMedia = async (...args) => { closing = pipeline.close(); return realDownload(...args); };
    const job = start(pipeline);
    await closing; await new Promise((r) => setTimeout(r, 20));
    assert.equal(pipeline.list().items.find((j) => j.id === job.id).status, 'queued');
    assert.deepEqual([w.calls.asr.length, w.calls.write.length, w.calls.create, w.calls.prepare], [0, 0, 0, 0]);
  }
  // 11. 人物没确认声音授权：开始前就拦下，不花识别费和写稿额度
  {
    const w = world({ consented: false }), pipeline = createViralPipeline({ root: newRoot(), ...w.deps });
    assert.throws(() => start(pipeline), { code: 'viral_voice_consent' });
    assert.deepEqual([w.calls.download, w.calls.asr.length, w.calls.write.length], [0, 0, 0]);
    await pipeline.close();
  }
  // 输入校验
  {
    const w = world(), pipeline = createViralPipeline({ root: newRoot(), ...w.deps });
    assert.throws(() => pipeline.start({ item: { id: '1', platform: 'weibo', url: 'x' }, assetId: 'a' }), { code: 'viral_item_invalid' });
    assert.throws(() => pipeline.start({ item: item('1'), assetId: '' }), { code: 'viral_person_missing' });
    assert.throws(() => pipeline.start({ item: item('1', { url: 'https://evil.example.com/video/1' }), assetId: 'rha_1' }), { code: 'viral_item_invalid' });
    assert.throws(() => pipeline.start({ item: item('../../x'), assetId: 'rha_1' }), { code: 'viral_item_invalid' });
    await assert.rejects(pipeline.retry('vp_not-a-job'), { code: 'viral_job_not_found' });
    await pipeline.close();
  }
  console.log('viral pipeline self-check passed: no second job for a paid item, ASR receipt-only recovery and rejected-receipt reset, no paid step after close, consent checked before spending, one-click end to end, budget gate before paid work, unoriginal stop, restart resumes without resubmitting, resume failed task, rejected ASR gets a new operation, note text path, cover words');
})().catch((error) => { console.error(error); process.exit(1); });
