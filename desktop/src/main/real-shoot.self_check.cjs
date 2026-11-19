// 场景效果视频 · 无人实拍 (pipeline 6) without any paid call: the pick lists, the plan and its prompts,
// prices, the time estimate, and the whole flow 场景图 → 镜头同时拍 → 拼接 → 一行字幕.
"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalog = require('./scene-video-catalog.cjs');
const real = require('./real-shoot-director.cjs');
const { estimateTask, recordTiming, readTimings, slotFinish, DEFAULTS } = require('./product-video-eta.cjs');
const { createProductVideoService } = require('./product-video-service.cjs');
const { parseDirectPrices, storyImagePrice, validPrices, quotePlan } = require('./product-video-pricing.cjs');
const { taskIdOf } = require('./digital-human-provider.cjs');
const { SCENES } = require('./video-directors.cjs');

const width = (text) => [...text].reduce((sum, char) => sum + (char.codePointAt(0) <= 0x7f ? 0.5 : 1), 0);
const base = { mode: 'product', durationSeconds: 30, deviceId: 'robot_scrubber', sceneIds: ['factory'], floorId: 'epoxy', dirtIds: ['oil'], productName: 'CC1 Pro' };

// Every choice the page offers is consistent, and every subtitle fits one line.
{
  for (const point of catalog.POINTS) assert.ok(width(point.caption) <= catalog.CAPTION_WIDTH, `${point.id} caption fits one line`);
  for (const device of catalog.DEVICES) {
    assert.ok(catalog.GROUPS.some((group) => group.id === device.group));
    assert.ok(device.scenes.every((id) => SCENES.some((scene) => scene.id === id) && catalog.SCENE_DETAIL[id]), `${device.id} scenes`);
    assert.ok(device.floors.every((id) => catalog.FLOORS.some((row) => row.id === id)), `${device.id} floors`);
    assert.ok(device.dirt.every((id) => catalog.DIRT.some((row) => row.id === id)), `${device.id} dirt`);
    assert.ok(catalog.forDevice(device).some((point) => !point.core), `${device.id} has selling points`);
  }
  const choices = catalog.choices();
  assert.equal(choices.pointLimit[15], 3); assert.equal(choices.pointLimit[60], 8);
  assert.ok(!choices.points.some((point) => point.id === 'clean'), 'the core cleaning shot is not a pick');
  // Robots never show people; a walk-behind machine shows only the operator's hands and legs.
  const robot = catalog.DEVICES.find((row) => row.id === 'robot_scrubber');
  assert.equal(robot.operator, 'none');
  assert.ok(catalog.forDevice(robot).some((point) => point.id === 'water') && catalog.forDevice(robot).some((point) => point.id === 'lift'));
  assert.ok(!catalog.forDevice(catalog.DEVICES.find((row) => row.id === 'walk_scrubber')).some((point) => point.id === 'lift'), 'a push machine does not ride lifts');
  assert.deepEqual(catalog.sceneDefaults('factory', robot), { floorId: 'epoxy', dirtIds: ['oil'] });
}
// Every device, scene and selling point gives a prompt the model accepts.
{
  for (const device of catalog.DEVICES) for (const sceneId of device.scenes) {
    const defaults = catalog.sceneDefaults(sceneId, device);
    const points = catalog.forDevice(device).filter((point) => !point.core).map((point) => point.id);
    for (let i = 0; i < points.length; i += 8) {
      const plan = real.planRealShoot({ ...base, durationSeconds: 60, deviceId: device.id, sceneIds: [sceneId], ...defaults, pointIds: points.slice(i, i + 8), extraImageIds: ['a', 'b'] });
      for (const shot of plan.shots) {
        assert.ok([...shot.prompt].length <= real.PROMPT_LIMIT, `${device.id}/${sceneId}/${shot.pointId} prompt length`);
        assert.ok(shot.seconds >= 2 && shot.seconds <= 15);
        assert.match(shot.prompt, /一镜到底/u);
        // A customer's video (2026-11-19): a driver on an unmanned robot, extra machines, a person merging into the machine.
        if (device.operator === 'none') { assert.match(shot.prompt, /没有任何人/u); assert.match(shot.prompt, /没有人坐上去、驾驶/u); assert.match(shot.prompt, /照片里没有的座椅、方向盘、把手不要加上去/u); }
        else { assert.match(shot.prompt, /不露脸/u); assert.match(shot.prompt, /不融在一起/u); }
        assert.match(shot.prompt, /不复制、不分身/u);
      }
    }
  }
}
// The plan: one shot per selling point, a cleaning shot when none was picked, fillers for short lists.
{
  const plan = real.planRealShoot({ ...base, pointIds: ['water', 'lift', 'obstacle'], extraImageIds: ['x'] });
  assert.equal(plan.pipelineVersion, 6); assert.equal(plan.imageCount, 1); assert.equal(plan.productImages, 2);
  assert.deepEqual(plan.shots.map((shot) => shot.pointId), ['clean', 'water', 'lift', 'obstacle'], 'no cleaning point picked: the cleaning shot leads');
  assert.equal(plan.shots.reduce((sum, shot) => sum + shot.seconds, 0), 30);
  assert.deepEqual(plan.shots.map((shot) => shot.place), ['venue', 'other', 'other', 'venue']);
  assert.match(plan.shots[0].prompt, /图1、图2是这台机器不同角度的真实产品照片/u);
  assert.match(plan.shots[0].prompt, /图3是这个场地/u, 'the scene picture comes after the product photos');
  assert.doesNotMatch(plan.shots[1].prompt, /图3是这个场地/u, 'a station shot does not use the venue picture');
  assert.match(plan.shots[0].prompt, /只有工作部件实际经过之后/u);
  assert.match(plan.shots[0].prompt, /发暗的油渍/u);
  assert.doesNotMatch(plan.shots[1].prompt, /清洁规则/u);
  assert.match(plan.platePrompt, /空无一人，没有任何机器设备/u);
  const short = real.planRealShoot({ ...base, durationSeconds: 60, pointIds: [] });
  assert.equal(short.shots.length, catalog.MIN_SHOTS[60]); assert.ok(short.shots.every((shot) => shot.seconds === 10));
  assert.equal(new Set(short.shots.map((shot) => shot.caption)).size, short.shots.length, 'filler shots do not repeat a subtitle');
  const full = real.planRealShoot({ ...base, durationSeconds: 15, pointIds: ['water', 'lift', 'charge'] });
  assert.equal(full.shots.length, 3, 'a full list keeps its points without an extra shot');
  assert.equal(full.imageCount, 0, 'no shot in the venue: no scene picture is made or paid for');
  assert.ok(real.plannedCaptions(full).every((cue, i, all) => cue.end > cue.start && (!i || cue.start >= all[i - 1].end)));
  const bad = (change, pattern) => assert.throws(() => real.planRealShoot({ ...base, ...change }), pattern);
  bad({ durationSeconds: 20 }, /15、30、45或60秒/u);
  bad({ deviceId: 'drone' }, /设备类型/u);
  bad({ sceneIds: ['hotel'], deviceId: 'robot_outdoor', floorId: 'asphalt', dirtIds: ['leaves'] }, /适用场景/u);
  bad({ floorId: 'carpet' }, /地面材质/u);
  bad({ dirtIds: [] }, /一到两种/u); bad({ dirtIds: ['oil', 'water', 'dust'] }, /一到两种/u); bad({ dirtIds: ['leaves'] }, /一到两种/u);
  bad({ pointIds: ['easy'] }, /不适用/u);
  bad({ durationSeconds: 15, pointIds: ['water', 'lift', 'charge', 'gate'] }, /最多选3个/u);
  bad({ extraImageIds: ['a', 'b', 'c'] }, /最多3张/u);
}
// The time estimate: defaults, then this computer's own speed; shots share three slots.
{
  assert.equal(slotFinish([100, 100, 100, 100], 3), 200);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoxi-eta-'));
  try {
    const plan = real.planRealShoot({ ...base, pointIds: ['water', 'lift'] });
    const task = { plan, status: 'imaging', images: {}, shots: plan.shots.map(() => ({})), operations: {} };
    const video = (seconds) => DEFAULTS.videoBase + DEFAULTS.videoPerSecond * seconds;
    assert.equal(estimateTask(task, readTimings(root)), DEFAULTS.image + video(10) + DEFAULTS.finish);
    assert.equal(estimateTask({ ...task, status: 'awaiting_sheet' }, readTimings(root)), null, 'no estimate while waiting for the customer');
    assert.equal(estimateTask({ ...task, status: 'needs_attention' }, readTimings(root)), null);
    recordTiming(root, 'video', { out: 10, seconds: 400 }); recordTiming(root, 'image', 30); recordTiming(root, 'image', -5); recordTiming(root, 'finish', 20);
    assert.deepEqual(readTimings(root).image, [30], 'nonsense times are not kept');
    assert.equal(estimateTask(task, readTimings(root)), 30 + 400 + 20);
    // A shot already in progress counts down from when it was ordered.
    const now = Date.parse('2026-11-19T10:00:00Z');
    const running = { ...task, status: 'generating', images: { plate: { file: 'x' } },
      shots: plan.shots.map((_, i) => ({ providerTaskId: `t${i}`, submittedAt: new Date(now - 100000).toISOString() })) };
    assert.equal(estimateTask(running, readTimings(root), { now }), 300 + 20);
    // Past the estimate it never goes below a short wait.
    const late = { ...running, shots: running.shots.map((shot) => ({ ...shot, submittedAt: new Date(now - 4000000).toISOString() })) };
    assert.equal(estimateTask(late, readTimings(root), { now }), 15 + 20);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// Prices: the scene picture, the footage with sound, and one redo of a shot and the picture.
const directDoc = 'wan3.0-video 模型价格 华北2（北京）<table>' + [['480P', '.3'], ['720P', '.6'], ['1080P', '1.2']].map(([r, v]) => `<tr><td>视频生成（${r}）</td><td>${v}</td><td>每秒</td></tr>`).join('') + '</table>';
const ttsDoc = 'qwen3-tts-flash 模型价格 华北2（北京）<table><tr><td>语音合成</td><td>0.8</td><td>每万字符</td></tr></table>';
const imagePrice = storyImagePrice({ success: true, data: { model_name: 'gpt-image-2.5-ext', version_resolution_prices: { a: { '1K': 0.02 } } } });
const videoPrice = parseDirectPrices(directDoc, ttsDoc);
const prices = () => ({ ...videoPrice, storyPipeline: true, resolution: '480p', audio: true, videoCnyPerSecond: videoPrice.rates['480p'].audio, imageModel: 'gpt-image-2.5-ext',
  ...imagePrice, fxCnyPerUsd: 8, storyReserveCny: 0.2, asrReserveCny: 1, checkedAt: new Date().toISOString() });
assert.equal(validPrices(prices()), true);
{
  const quote = quotePlan(real.planRealShoot({ ...base, pointIds: ['water', 'lift'] }), prices(), 0);
  // 30 s × 0.3 + one picture 0.16, plus one picture and the longest shot (10 s) kept for a redo.
  assert.equal(quote.maximumCny, 12.32); assert.equal(quote.videoAudio, true);
}

// The official price page arrives in network chunks; a Chinese character split between two chunks
// must not turn into garbage (it made quotes fail now and then, 2026-11-19).
async function priceChunks() {
  const https = require('node:https'), { EventEmitter } = require('node:events'), original = https.get;
  const page = Buffer.from(directDoc, 'utf8'), cut = page.indexOf(Buffer.from('视频生成')) + 1;
  https.get = (url, options, callback) => {
    const response = new EventEmitter(); response.statusCode = 200; response.destroy = () => {};
    const request = new EventEmitter(); request.destroy = () => {};
    setImmediate(() => { callback(response); response.emit('data', page.subarray(0, cut)); response.emit('data', page.subarray(cut)); response.emit('end'); });
    return request;
  };
  try { assert.equal((await require('./product-video-pricing.cjs').readText('https://example.invalid/')), directDoc); }
  finally { https.get = original; }
  assert.equal(parseDirectPrices(directDoc, ttsDoc).rates['720p'].audio, 0.6);
}
async function run() {
  await priceChunks();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoxi-real-shoot-'));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const clip = Buffer.alloc(2048); clip.write('ftyp', 4, 'ascii');
  const posts = [], videoTasks = new Map();
  let maxRunning = 0, failVideo = '', throttleOnce = false, unknownBusyOnce = false, badCaptionsOnce = false;
  const running = () => [...videoTasks.values()].filter((task) => task.status === 'running').length;
  const provider = {
    imageUploadBody: (file) => ({ body: Buffer.from(path.basename(file)), headers: {} }), nodeOf: (p) => p?.output || p, taskIdOf,
    resultUrl: (p, kind) => `https://fixture.example/${p.task_id}.${kind === 'images' ? 'png' : 'mp4'}`,
    download: async (url, dest) => fs.writeFileSync(dest, url.endsWith('.png') ? Buffer.concat([png, Buffer.from(url)]) : clip),
    request: async (route, request = {}) => {
      if (request.method === 'POST') {
        if (route.includes('video-synthesis') && unknownBusyOnce && running() > 0) {
          unknownBusyOnce = false;
          // Busy, but the answer could not be read: the request may have gone through.
          throw Object.assign(new Error('服务返回的数据无法识别。'), { code: 'digital_human_response_invalid', status: 429, outcomeUnknown: true });
        }
        if (route.includes('video-synthesis') && throttleOnce && running() > 0) {
          throttleOnce = false;
          throw Object.assign(new Error('服务未完成请求：Throttling'), { code: 'digital_human_provider_error', status: 429 });
        }
        posts.push({ route, body: request.body });
        if (route.includes('/images/')) return { task_id: `img_${posts.length}` };
        const task_id = `v_${videoTasks.size}`;
        videoTasks.set(task_id, { status: 'running', polls: 0, prompt: request.body.input.prompt });
        maxRunning = Math.max(maxRunning, running());
        return { output: { task_id } };
      }
      const task_id = route.split('/').pop().split('?')[0];
      if (route.startsWith('/bailian/')) {
        const task = videoTasks.get(task_id); task.polls += 1;
        // Each shot needs two looks, so several are in progress at the same time.
        if (task.polls < 2) return { output: { task_id, task_status: 'RUNNING' } };
        const failed = failVideo && task.prompt.includes(failVideo); if (failed) failVideo = '';
        task.status = failed ? 'failed' : 'done';
        return failed ? { output: { task_id, task_status: 'FAILED', message: '内容未通过' } } : { output: { task_id, task_status: 'SUCCEEDED', video_url: `https://fixture.example/${task_id}.mp4` } };
      }
      return { task_id, status: 'completed' };
    }
  };
  let rendered = null;
  const service = createProductVideoService({ rootDir: root, provider, pollMs: 1, readPrices: async () => prices(),
    gatewayClient: { isEnabled: () => true, initialize: async () => ({ ready: true, capabilities: { apimart: true, bailian: true, bailian_video: true } }) },
    mediaTools: {
      referenceJpeg: async ({ source, destination }) => fs.writeFileSync(destination, fs.readFileSync(source)),
      normalizeAndAssemble: async ({ shots, destination }) => { assert.ok([15, 30].includes(shots.reduce((sum, shot) => sum + shot.seconds, 0))); fs.writeFileSync(destination, clip); },
      renderCaptioned: async ({ destination, captions }) => { rendered = captions; fs.writeFileSync(destination, clip); },
      buildPlannedCaptions: (input) => {
        if (badCaptionsOnce) { badCaptionsOnce = false; throw Object.assign(new Error('字幕过长'), { code: 'product_video_caption_too_long' }); }
        return require('./product-video-media.cjs').buildPlannedCaptions(input);
      },
      extractAudio: async () => { throw new Error('无人实拍不做语音识别'); }
    } });
  const until = async (id, predicate) => {
    for (let i = 0; i < 400; i += 1) { const task = service.get(id); if (predicate(task)) return task; await service.refresh(id); await new Promise((resolve) => setTimeout(resolve, 3)); }
    throw new Error('not reached: ' + JSON.stringify(service.get(id)).slice(0, 600));
  };
  try {
    const caps = await service.capabilities();
    assert.equal(caps.real.ready, true, 'no story writer or speech recognition is needed');
    assert.ok(caps.catalog.devices.length > 5 && caps.timing.shotSlots === 3);
    const photo = (name) => { const file = path.join(root, name); fs.writeFileSync(file, Buffer.concat([png, Buffer.from(name)])); return service.importImage(file); };
    const front = photo('front.png'), side = photo('side.png');
    await assert.rejects(service.create({ ...base, style: 'story', imageId: front.id, deviceId: 'robot_scrubber' }), (e) => e.code === 'product_video_invalid_input');
    await assert.rejects(service.create({ ...base, style: 'real', imageId: front.id, extraImageIds: [front.id] }), /不能重复/u);
    const draft = await service.create({ ...base, style: 'real', imageId: front.id, extraImageIds: [side.id], pointIds: ['water', 'lift', 'obstacle', 'edge'] });
    assert.equal(draft.realPipeline, true); assert.equal(draft.plan.shots.length, 4);
    assert.equal(draft.etaSeconds, null, 'a draft has no countdown');
    failVideo = '自己乘电梯'; throttleOnce = true;
    await service.start(draft.id);
    let task = service.get(draft.id);
    assert.equal(task.status, 'imaging'); assert.ok(task.etaSeconds > 0 && Date.parse(task.estimatedFinishAt) > Date.now());
    // The failed shot is redone by itself, once, automatically; the others are kept.
    task = await until(draft.id, (t) => t.status === 'completed');
    assert.ok(maxRunning >= 2 && maxRunning <= 3, `shots are filmed a few at a time (${maxRunning})`);
    const images = posts.filter((p) => p.route.includes('/images/generations'));
    assert.equal(images.length, 1, 'one scene picture'); assert.equal(images[0].body.image_urls, undefined);
    const videos = posts.filter((p) => p.route.includes('video-synthesis')).map((p) => p.body);
    assert.equal(videos.length, 5, 'four shots and one redo');
    assert.ok(videos.every((b) => b.parameters.audio === true && b.parameters.resolution === '480P'));
    const byPoint = (name) => videos.find((b) => b.input.prompt.includes(`展示「${name}」`));
    assert.equal(byPoint('自动避障').input.media.length, 3, 'two product photos and the scene picture');
    assert.equal(byPoint('自动上下水').input.media.length, 2, 'a station shot uses the product photos only');
    assert.equal(task.shotsReady.every(Boolean), true);
    assert.deepEqual(rendered.cues.map((cue) => cue.text), draft.plan.shots.map((shot) => shot.caption));
    assert.ok(rendered.cues.every((cue) => cue.lines.length === 1));
    assert.equal(task.progress, 100); assert.equal(task.etaSeconds, null); assert.equal(task.canExport, true);
    assert.ok(task.quote.reservedCny <= task.quote.budgetCny + 1e-9, 'spending stays within the quoted allowance');
    assert.ok(readTimings(root).video.length >= 4 && readTimings(root).finish.length === 1, 'real step times are kept for the next estimate');
    // Review fixes: subtitles of this mode are redone by assembling again (no speech recognition), and a busy
    // answer whose outcome is unknown pauses at once, keeping its receipt instead of ordering again.
    badCaptionsOnce = true; unknownBusyOnce = true;
    const second = await service.create({ ...base, durationSeconds: 15, style: 'real', imageId: front.id, pointIds: ['water', 'charge', 'lift'] });
    assert.equal(second.plan.imageCount, 0);
    await service.start(second.id);
    let paused = await until(second.id, (t) => t.status === 'outcome_unknown');
    assert.equal(posts.filter((p) => p.route.includes('/images/generations')).length, 1, 'no scene picture for a video without venue shots');
    // The receipt says the request went through; nothing is sent again.
    const fixedFile = path.join(root, second.id, 'task.json'), saved = JSON.parse(fs.readFileSync(fixedFile, 'utf8'));
    const pending = Object.values(saved.operations).find((op) => !op.response);
    assert.ok(pending, 'the unknown request keeps its receipt');
    provider.request = ((original) => async (route, request = {}) => route === `/operations/${pending.id}` ? { output: { task_id: 'v_recovered' } } : original(route, request))(provider.request);
    videoTasks.set('v_recovered', { status: 'running', polls: 0, prompt: '' });
    paused = await until(second.id, (t) => t.status === 'needs_attention');
    assert.equal(paused.errorCode, 'product_video_caption_too_long'); assert.equal(paused.retryLabel, '重新合成');
    await service.retryShot(second.id);
    const done = await until(second.id, (t) => t.status === 'completed');
    assert.equal(posts.filter((p) => p.route.includes('/asr/')).length, 0, 'no speech recognition is ever bought');
    assert.ok(done.canExport);
  } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
run().then(() => console.log('real-shoot self-check passed: pick lists, plans and prompts, prices, time estimate, scene picture, shots a few at a time, busy service, failed shot redo, one-line subtitles'),
  (error) => { console.error(error); process.exit(1); });
