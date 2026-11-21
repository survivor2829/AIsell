// 场景效果视频 · 无人实拍 (pipeline 6) without any paid call: the pick lists, the plan and its prompts,
// prices, the time estimate, and the whole flow 场景图 → 镜头同时拍 → 拼接 → 一行字幕.
"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalog = require('./scene-video-catalog.cjs');
const real = require('./real-shoot-director.cjs');
const ai = require('./real-shoot-ai-director.cjs');
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
        // A pressure washer wets the floor with clean water; every other cleaning shot keeps it dry with no liquid.
        if (shot.cleaning) assert.equal(/不凭空出现任何液体/u.test(shot.prompt), !device.wet, `${device.id}/${shot.pointId} liquid rule`);
        assert.doesNotMatch(shot.prompt, /倒回/u);
      }
    }
  }
}
// The plan: one shot per selling point, a cleaning shot when none was picked, fillers for short lists.
{
  const plan = real.planRealShoot({ ...base, pointIds: ['water', 'lift', 'obstacle'], extraImageIds: ['x'] });
  assert.equal(plan.pipelineVersion, 6); assert.equal(plan.imageCount, 2, 'the 定妆照 and the scene picture'); assert.equal(plan.productImages, 2); assert.equal(plan.sheet, true);
  assert.deepEqual(plan.shots.map((shot) => shot.pointId), ['clean', 'water', 'lift', 'obstacle'], 'no cleaning point picked: the cleaning shot leads');
  assert.equal(plan.shots.reduce((sum, shot) => sum + shot.seconds, 0), 30);
  assert.deepEqual(plan.shots.map((shot) => shot.place), ['venue', 'other', 'other', 'venue']);
  assert.match(plan.shots[0].prompt, /图1、图2是这台机器不同角度的真实产品照片/u);
  assert.match(plan.shots[0].prompt, /图3是同一台机器的四视角定妆图/u, 'the 定妆照 follows the real photos');
  assert.match(plan.shots[0].prompt, /图4是这个场地/u, 'the scene picture comes last');
  assert.doesNotMatch(plan.shots[1].prompt, /是这个场地/u, 'a station shot does not use the venue picture');
  assert.match(plan.shots[0].prompt, /只有工作部件实际经过之后/u);
  assert.match(plan.shots[0].prompt, /发暗的油渍/u);
  assert.doesNotMatch(plan.shots[1].prompt, /清洁规则/u);
  assert.match(plan.platePrompt, /空无一人，没有任何机器设备/u);
  const short = real.planRealShoot({ ...base, durationSeconds: 60, pointIds: [] });
  assert.equal(short.shots.length, catalog.MIN_SHOTS[60]); assert.ok(short.shots.every((shot) => shot.seconds === 10));
  assert.equal(new Set(short.shots.map((shot) => shot.caption)).size, short.shots.length, 'filler shots do not repeat a subtitle');
  const full = real.planRealShoot({ ...base, durationSeconds: 15, pointIds: ['water', 'lift', 'charge'] });
  assert.equal(full.shots.length, 3, 'a full list keeps its points without an extra shot');
  assert.equal(full.imageCount, 1, 'no shot in the venue: only the 定妆照, no scene picture is made or paid for');
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
    const task = { plan, status: 'imaging', images: {}, shots: plan.shots.map(() => ({})), operations: {}, sheetConfirmedAt: '2026-11-19T10:00:00Z' };
    const video = (seconds) => DEFAULTS.videoBase + DEFAULTS.videoPerSecond * seconds;
    // Before the 定妆照 is confirmed only that picture is counted.
    assert.equal(estimateTask({ ...task, status: 'uploading', sheetConfirmedAt: undefined }, readTimings(root)), DEFAULTS.upload + DEFAULTS.image);
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

// AI 导演 (2026-11-19): the customer gives a name, a place and selling points (picked or written); the shot
// list is fixed up front so the price holds, and the director's answer is checked before anything is paid for.
const aiBase = { mode: 'product', durationSeconds: 30, productName: 'DZ95X 洗地机器人', sceneIds: ['factory'] };
const direction = (plan, overrides = {}) => JSON.stringify({ machine: '自主行驶的洗地机器人，底部滚刷和后部刮条', operator: 'none', wet: false, floor: '旧环氧地坪', dirt: '油污和铁屑',
  plate: '工厂仓储通道，两侧货架和周转箱，环氧地坪上有油污和铁屑，顶灯偏冷', shots: plan.shots.map((shot, i) => ({ title: shot.title, caption: shot.caption || `自己会干活${i + 1}`, venue: shot.pointId !== 'lift',
    prompt: `第${i + 1}镜：摄影机在机器斜后方同速跟随，机器沿通道匀速前进，滚刷经过的地方油污消失露出环氧地坪本色，没经过的地方保持原样作对照。两侧是蓝色货架和灰色周转箱，地面有黄色地标线，光线是厂房顶上普通的白色工业灯，画面平实，像现场随手拍的设备演示。` })), ...overrides });
{
  assert.throws(() => ai.planDirected({ ...aiBase, productName: ' ' }), /产品名称/u);
  assert.throws(() => ai.planDirected({ ...aiBase, sceneIds: [] }), /使用场所/u);
  assert.throws(() => ai.planDirected({ ...aiBase, durationSeconds: 15, pointIds: ['wide', 'obstacle'], customPoints: ['洗拖一体', '免维护'] }), /最多3个卖点/u);
  // Any selling point may be picked, whatever the machine, and the customer's own words become a shot of their own.
  const plan = ai.planDirected({ ...aiBase, pointIds: ['lift', 'obstacle'], customPoints: ['洗拖一体', '这是一条超过十个字宽的自己写的卖点'] });
  assert.equal(plan.director, 'ai'); assert.equal(plan.directed, undefined); assert.equal(plan.imageCount, 2);
  assert.deepEqual(plan.shots.map((shot) => shot.pointId), ['clean', 'lift', 'obstacle', 'custom_0', 'custom_1'], 'a cleaning shot leads when none was picked');
  assert.equal(plan.shots.reduce((sum, shot) => sum + shot.seconds, 0), 30);
  assert.equal(plan.shots[3].caption, '洗拖一体'); assert.equal(plan.shots[4].caption, '', 'a long point gets its subtitle from the director');
  assert.ok(plan.shots.every((shot) => shot.prompt === ''), 'no prompt before the director has seen the photos');
  // The brief carries the photos, the place and every shot, and asks for JSON only.
  const messages = ai.directorMessages({ plan, images: ['data:image/jpeg;base64,AA', 'data:image/jpeg;base64,BB'] });
  assert.equal(messages[1].content.filter((part) => part.type === 'image_url').length, 2);
  assert.match(messages[1].content.at(-1).text, /第5镜｜6秒｜卖点「这是一条超过十个字宽的自己写的卖点」/u);
  assert.match(messages[0].content, /只输出一个 JSON/u); assert.match(messages[0].content, /不要在提示词里写“水/u);
  // A good answer becomes five prompts with the pictures named, the proven rules appended and the lift shot outside the venue.
  const directed = ai.applyDirection(plan, ai.parseDirection(['```json', direction(plan), '```'].join('\n'), plan));
  assert.equal(directed.directed, true); assert.equal(directed.operator, 'none');
  assert.equal(directed.shots[1].place, 'other'); assert.equal(directed.imageCount, 2);
  for (const shot of directed.shots) {
    assert.match(shot.prompt, /图1是这台机器的真实产品照片，图2是同一台机器的四视角定妆图/u);
    assert.equal(/图3是拍摄现场/u.test(shot.prompt), shot.place === 'venue');
    assert.match(shot.prompt, /一镜到底/u); assert.match(shot.prompt, /不倒着走/u); assert.match(shot.prompt, /没有人坐上去/u); assert.match(shot.prompt, /不复制、不分身/u);
    assert.ok([...shot.prompt].length <= ai.PROMPT_LIMIT);
  }
  assert.match(directed.platePrompt, /空无一人，没有任何机器设备/u);
  // What a director naturally writes is reworded, not sent back; a real description of liquid is sent back with the reason.
  assert.equal(ai.reword('红色滚刷与黑色吸水扒紧贴地面，干净处干燥平整，无任何水渍、湿痕或反光。画面无文字、商标、水渍或泡沫。'), '红色滚刷与黑色后部刮条紧贴地面，干净处干燥平整，无反光。画面无文字、商标。');
  // Review of #313: floors named with 水 are not liquid; the 自动上下水 station shot may mention water.
  assert.equal(ai.reword('没有杂物的水泥地面，没有划痕的水磨石台阶。'), '没有杂物的水泥地面，没有划痕的水磨石台阶。');
  const station = ai.planDirected({ ...aiBase, durationSeconds: 15, pointIds: ['water'] });
  assert.match(ai.directorMessages({ plan: station, images: [] })[1].content.at(-1).text, /污水被抽走/u, 'the station hint keeps its water');
  const stationAnswer = JSON.parse(direction(station)); stationAnswer.shots[station.shots.findIndex((shot) => shot.pointId === 'water')].prompt += '透明管里清水灌进机器、污水被抽走。';
  assert.doesNotThrow(() => ai.parseDirection(JSON.stringify(stationAnswer), station));
  const oily = ai.planDirected({ ...aiBase, durationSeconds: 15, pointIds: ['dry'] });
  assert.doesNotMatch(ai.directorMessages({ plan: oily, images: [] })[1].content.at(-1).text.split('\n').find((line) => line.includes('洗完即干')).split('常见拍法')[1], /水渍|水痕/u, 'no liquid words in other hints');
  const wet = JSON.parse(direction(plan)); wet.shots[0].prompt += '机器把地上的污水吸进去。';
  assert.throws(() => ai.parseDirection(JSON.stringify(wet), plan), (e) => e.code === 'product_video_direction_invalid' && /第1镜提示词里写了「污水」/u.test(e.message));
  assert.doesNotThrow(() => ai.parseDirection(JSON.stringify({ ...wet, wet: true }), plan), 'a washer may show clean water');
  assert.throws(() => ai.parseDirection(direction(plan, { shots: JSON.parse(direction(plan)).shots.slice(1) }), plan), /必须正好 5 镜/u);
  assert.throws(() => ai.parseDirection(direction(plan, { operator: 'robot' }), plan), /operator/u);
  // 2026-11-21 实拍 45 秒两个清洁镜头字幕相同：补位镜头各有字幕和机位，导演给出重复字幕要重写。
  for (const [seconds, pointIds] of [[45, ['sweep', 'edge', 'charge']], [60, []], [60, ['wide']], [15, []]]) {
    const filled = ai.planDirected({ ...aiBase, durationSeconds: seconds, pointIds });
    assert.equal(new Set(filled.shots.map((shot) => shot.caption)).size, filled.shots.length, `${seconds}秒 ${pointIds.join('+') || '不选卖点'}：每镜默认字幕不同`);
    const cameras = filled.shots.filter((shot) => shot.filler).map((shot) => shot.camera);
    assert.ok(cameras.every(Boolean) && new Set(cameras).size === cameras.length, 'each extra cleaning shot has its own camera');
  }
  // 2026-11-21 实拍：油污写成「半透明黏稠」一滩，被画成液体、被机器拖开；导演要重写成渗进地面的旧油斑。
  const oilPuddle = JSON.parse(direction(plan)); oilPuddle.shots[0].prompt += '一块半透明黏稠状的暗褐色油渍。';
  assert.throws(() => ai.parseDirection(JSON.stringify(oilPuddle), plan), /第1镜提示词里写了「黏稠|第1镜提示词里写了「半透明/u);
  assert.throws(() => ai.parseDirection(direction(plan, { dirt: '暗褐色半透明黏着斑块' }), plan), /dirt 里写了「半透明」/u);
  assert.match(ai.directorMessages({ plan, images: ['data:x'] }).map((m) => JSON.stringify(m.content)).join(''), /渗进地面、颜色发暗的旧油斑/u);
  const twice = JSON.parse(direction(plan)); twice.shots[1].caption = twice.shots[0].caption;
  assert.throws(() => ai.parseDirection(JSON.stringify(twice), plan), /第2镜字幕「[^」]+」和第1镜重复/u);
  const long = JSON.parse(direction(plan)); long.shots[2].caption = '遇到障碍物会自己绕开走'; assert.throws(() => ai.parseDirection(JSON.stringify(long), plan), /超过10个汉字宽/u);
  assert.throws(() => ai.parseDirection('我觉得可以这样拍', plan), (e) => e.code === 'product_video_direction_invalid');
  // The AI check only reports; anything not clearly a problem counts as fine.
  assert.deepEqual(ai.parseReview('{"shots":[{"index":2,"ok":false,"issue":"第3格出现两台机器"},{"index":1,"ok":true}]}', directed).map(({ ok, issue }) => [ok, issue]),
    [[true, ''], [false, '第3格出现两台机器'], [true, ''], [true, ''], [true, '']]);
  assert.equal(ai.reviewRequest({ plan: directed, images: ['a', 'b'], sheets: ['c'] }).messages[1].content.length, 4);
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
  // 30 s × 0.3 + 定妆照 and scene picture 2 × 0.16, plus both 定妆照 redos, one picture redo and the longest shot (10 s).
  assert.equal(quote.maximumCny, 12.80); assert.equal(quote.videoAudio, true);
}

// The official price page arrives in network chunks; a Chinese character split between two chunks
// must not turn into garbage (it made quotes fail now and then, 2026-11-19).
async function priceChunks() {
  const https = require('node:https'), { EventEmitter } = require('node:events'), original = https.get;
  const page = Buffer.from(directDoc, 'utf8'), cut = page.indexOf(Buffer.from('视频生成')) + 1;
  assert.ok(cut > 0, 'the test page must contain a Chinese character to split');
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
  let maxRunning = 0, failVideo = '', throttleOnce = false, unknownBusyOnce = false, badCaptionsOnce = false, failSheetOnce = false;
  const imageTasks = new Map();
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
        if (route === ai.DIRECTOR_ROUTE) {
          const text = request.body.messages[1].content.at(-1).text, system = request.body.messages[0].content;
          if (/视频质检员/u.test(system)) return { choices: [{ message: { content: '{"shots":[{"index":3,"ok":false,"issue":"第4格出现两台机器"}]}' } }] };
          const count = (text.match(/第\d+镜｜/gu) || []).length, plan = { shots: Array.from({ length: count }, (_, i) => ({ index: i, title: `镜${i + 1}`, caption: '', pointId: i === 1 ? 'lift' : 'x' })) };
          const answer = JSON.parse(direction(plan));
          if (!/上一次的结果不合格/u.test(text)) answer.shots[0].prompt += '地上的污水被吸走。';
          return { choices: [{ message: { content: JSON.stringify(answer) } }] };
        }
        if (route.endsWith('/uploads/images')) return { url: 'https://fixture.example/product.png' };
        if (route.includes('/images/')) { const task_id = `img_${posts.length}`; imageTasks.set(task_id, request.body.prompt); return { task_id }; }
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
      // A 定妆照 can fail once (review of #310): only that picture is ordered again.
      if (failSheetOnce && /产品定妆设定图/u.test(imageTasks.get(task_id) || '')) { failSheetOnce = false; return { task_id, status: 'failed', error: '内容未通过' }; }
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
      extractAudio: async () => { throw new Error('无人实拍不做语音识别'); },
      shotContactSheet: async ({ destination }) => fs.writeFileSync(destination, png)
    } });
  const until = async (id, predicate) => {
    for (let i = 0; i < 400; i += 1) { const task = service.get(id); if (predicate(task)) return task; await service.refresh(id); await new Promise((resolve) => setTimeout(resolve, 3)); }
    throw new Error('not reached: ' + JSON.stringify(service.get(id)).slice(0, 600));
  };
  try {
    const caps = await service.capabilities();
    assert.equal(caps.real.ready, true, 'no story writer or speech recognition is needed');
    // The page offers the places and every selling point; the AI director works out the machine from the photos.
    assert.ok(caps.catalog.scenes.length >= 9 && caps.catalog.points.length > 10 && caps.catalog.customLimit === 3 && caps.timing.shotSlots === 3);
    const photo = (name) => { const file = path.join(root, name); fs.writeFileSync(file, Buffer.concat([png, Buffer.from(name)])); return service.importImage(file); };
    const front = photo('front.png'), side = photo('side.png');
    await assert.rejects(service.create({ ...base, style: 'story', imageId: front.id, deviceId: 'robot_scrubber' }), (e) => e.code === 'product_video_invalid_input');
    await assert.rejects(service.create({ ...base, style: 'real', imageId: front.id, extraImageIds: [front.id] }), /不能重复/u);
    const draft = await service.create({ ...base, style: 'real', imageId: front.id, extraImageIds: [side.id], pointIds: ['water', 'lift', 'obstacle', 'edge'] });
    assert.equal(draft.realPipeline, true); assert.equal(draft.plan.shots.length, 4);
    assert.equal(draft.etaSeconds, null, 'a draft has no countdown');
    failVideo = '自己乘电梯'; throttleOnce = true; failSheetOnce = true;
    await service.start(draft.id);
    let failed = await until(draft.id, (t) => t.status === 'needs_attention');
    assert.equal(failed.errorCode, 'product_video_image_failed'); assert.match(failed.error, /定妆照没有画成/u);
    await service.retryShot(draft.id);
    let task = service.get(draft.id);
    assert.ok(['uploading', 'imaging'].includes(task.status)); assert.ok(task.etaSeconds > 0 && Date.parse(task.estimatedFinishAt) > Date.now());
    // The 定妆照 comes first and waits for the customer; nothing else is paid for meanwhile.
    task = await until(draft.id, (t) => t.status === 'awaiting_sheet');
    assert.equal(task.statusLabel, '请确认定妆照'); assert.equal(task.etaSeconds, null); assert.deepEqual(task.imagesReady, { sheet: true, plate: false });
    assert.equal(posts.filter((p) => p.route.includes('video-synthesis')).length, 0);
    // The side photo goes to the 定妆照 too, so its back view is not invented from the front alone.
    const sheetOrders = posts.filter((p) => p.route.includes('/images/generations') && /产品定妆设定图/u.test(p.body.prompt));
    assert.equal(sheetOrders.at(-1).body.image_urls.length, 2); assert.match(sheetOrders.at(-1).body.prompt, /2张参考图/u);
    await service.redoSheet(draft.id); task = await until(draft.id, (t) => t.status === 'awaiting_sheet');
    assert.equal(task.sheetRedos, 1);
    assert.match((await service.imageMedia(draft.id, 'sheet')).dataUrl, /^data:image\/jpeg;base64,/u);
    await service.redoSheet(draft.id); task = await until(draft.id, (t) => t.status === 'awaiting_sheet');
    await assert.rejects(service.redoSheet(draft.id), (e) => e.code === 'product_video_sheet_retry_limit');
    await service.confirmSheet(draft.id);
    // The failed shot is redone by itself, once, automatically; the others are kept.
    task = await until(draft.id, (t) => t.status === 'completed');
    assert.ok(maxRunning >= 2 && maxRunning <= 3, `shots are filmed a few at a time (${maxRunning})`);
    const images = posts.filter((p) => p.route.includes('/images/generations'));
    assert.equal(images.length, 5, 'the 定妆照 four times (failed, retried, two redos) and one scene picture');
    assert.equal(images[0].body.image_urls.length, 2); assert.equal(images[4].body.image_urls, undefined);
    const videos = posts.filter((p) => p.route.includes('video-synthesis')).map((p) => p.body);
    assert.equal(videos.length, 5, 'four shots and one redo');
    assert.ok(videos.every((b) => b.parameters.audio === true && b.parameters.resolution === '480P'));
    const byPoint = (name) => videos.find((b) => b.input.prompt.includes(`展示「${name}」`));
    assert.equal(byPoint('自动避障').input.media.length, 4, 'two product photos, the 定妆照 and the scene picture');
    assert.equal(byPoint('自动上下水').input.media.length, 3, 'a station shot uses the product photos and the 定妆照');
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
    assert.equal(second.plan.imageCount, 1);
    await service.start(second.id);
    await until(second.id, (t) => t.status === 'awaiting_sheet'); await service.confirmSheet(second.id);
    let paused = await until(second.id, (t) => t.status === 'outcome_unknown');
    assert.equal(posts.filter((p) => p.route.includes('/images/generations')).length, 6, 'only its 定妆照 (five before it): no scene picture for a video without venue shots');
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
    // A video planned before the 定妆照 step (no plan.sheet) runs as it did: no 定妆照, no waiting.
    const legacy = await service.create({ ...base, durationSeconds: 15, style: 'real', imageId: front.id, pointIds: ['wide'] });
    const legacyFile = path.join(root, legacy.id, 'task.json'), legacyTask = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
    delete legacyTask.plan.sheet; legacyTask.plan.imageCount = 1; fs.writeFileSync(legacyFile, JSON.stringify(legacyTask));
    const sheetsBefore = posts.filter((p) => /产品定妆设定图/u.test(p.body?.prompt || '')).length;
    await service.start(legacy.id);
    const legacyDone = await until(legacy.id, (t) => t.status === 'completed');
    assert.equal(posts.filter((p) => /产品定妆设定图/u.test(p.body?.prompt || '')).length, sheetsBefore, 'no 定妆照 for an older plan');
    assert.equal(legacyDone.sheetStep, false);
    // AI 导演: name, place and selling points only. After the 定妆照 the director looks at the photos (sent
    // back once with the reason), then the scene picture, the shots, the AI check, and one shot redone on request.
    const postsBefore = posts.length;
    const directedDraft = await service.create({ mode: 'product', style: 'real', durationSeconds: 15, productName: 'DZ95X 洗地机器人', sceneIds: ['factory'],
      imageId: front.id, pointIds: ['lift'], customPoints: ['洗拖一体'] });
    assert.equal(directedDraft.directorStep, true); assert.equal(directedDraft.directed, false);
    assert.ok(directedDraft.quote.maximumCny > 0 && directedDraft.quote.directorCny === 0.2, 'the director and the check are in the quote');
    await service.start(directedDraft.id);
    await until(directedDraft.id, (t) => t.status === 'awaiting_sheet');
    assert.equal(posts.slice(postsBefore).filter((p) => p.route === ai.DIRECTOR_ROUTE).length, 0, 'the director waits for the confirmed 定妆照');
    await service.confirmSheet(directedDraft.id);
    const directedDone = await until(directedDraft.id, (t) => t.status === 'completed');
    const mine = posts.slice(postsBefore);
    const directs = mine.filter((p) => p.route === ai.DIRECTOR_ROUTE && !/视频质检员/u.test(p.body.messages[0].content));
    assert.equal(directs.length, 2, 'an answer with liquid in it is written once more');
    assert.match(directs[1].body.messages[1].content.at(-1).text, /第1镜提示词里写了「污水」/u);
    assert.equal(directs[0].body.messages[1].content.filter((part) => part.type === 'image_url').length, 2, 'the product photo and the 定妆照');
    assert.equal(directedDone.directed, true); assert.match(directedDone.plan.machine, /洗地机器人/u);
    const directedVideos = mine.filter((p) => p.route.includes('video-synthesis'));
    assert.equal(directedVideos.length, 3);
    assert.ok(directedVideos.every((p) => /一镜到底/u.test(p.body.input.prompt) && /不倒着走/u.test(p.body.input.prompt)));
    assert.equal(directedVideos.filter((p) => p.body.input.media.length === 3).length, 2, 'venue shots carry the scene picture');
    assert.deepEqual(directedDone.review.shots.map((shot) => shot.ok), [true, true, false]);
    assert.equal(directedDone.canRedoShot, true);
    assert.ok(directedDone.quote.reservedCny <= directedDone.quote.budgetCny + 1e-9);
    // The customer redoes the flagged shot: only that shot is ordered again, once.
    const ordersBefore = posts.filter((p) => p.route.includes('video-synthesis')).length;
    await assert.rejects(service.redoShot(directedDraft.id, 7), (e) => e.code === 'product_video_redo_unavailable');
    await service.redoShot(directedDraft.id, 2);
    const redone = await until(directedDraft.id, (t) => t.status === 'completed');
    assert.equal(posts.filter((p) => p.route.includes('video-synthesis')).length, ordersBefore + 1);
    assert.equal(redone.review.shots[2].redone, true); assert.equal(redone.canRedoShot, false);
    assert.ok(fs.existsSync(path.join(root, directedDraft.id, 'shot-2-before-redo.mp4')), 'the earlier take is kept');
    await assert.rejects(service.redoShot(directedDraft.id, 0), (e) => e.code === 'product_video_retry_limit');
    // Review of #313: after three bad answers the retry asks again three times instead of reusing old answers.
    let alwaysBad = true;
    provider.request = ((original) => async (route, request = {}) => {
      if (alwaysBad && route === ai.DIRECTOR_ROUTE && request.method === 'POST' && !/视频质检员/u.test(request.body.messages[0].content)) {
        posts.push({ route, body: request.body }); return { choices: [{ message: { content: '不是 JSON' } }] };
      }
      return original(route, request);
    })(provider.request);
    const stubborn = await service.create({ mode: 'product', style: 'real', durationSeconds: 15, productName: 'S9 扫地机器人', sceneIds: ['community'], imageId: front.id, pointIds: ['edge'] });
    await service.start(stubborn.id); await until(stubborn.id, (t) => t.status === 'awaiting_sheet'); await service.confirmSheet(stubborn.id);
    const gaveUp = await until(stubborn.id, (t) => t.status === 'needs_attention');
    assert.equal(gaveUp.errorCode, 'product_video_direction_invalid');
    const directCalls = () => posts.filter((p) => p.route === ai.DIRECTOR_ROUTE && !/视频质检员/u.test(p.body.messages[0].content) && /S9/u.test(p.body.messages[1].content.at(-1).text)).length;
    assert.equal(directCalls(), 3);
    alwaysBad = false;
    await service.retryShot(stubborn.id);
    await until(stubborn.id, (t) => t.directed === true);
    assert.ok(directCalls() >= 4, 'the retry really asks the director again');
    // Review of #313: a redo that fails puts the earlier take back and keeps the finished video exportable.
    const stubbornDone = await until(stubborn.id, (t) => t.status === 'completed');
    assert.equal(stubbornDone.canRedoShot, true);
    failVideo = `第${stubbornDone.plan.shots.findIndex((shot) => shot.pointId === 'edge') + 1}镜：`;
    await service.redoShot(stubborn.id, stubbornDone.plan.shots.findIndex((shot) => shot.pointId === 'edge'));
    const kept = await until(stubborn.id, (t) => t.status === 'completed' && Boolean(t.redoNote));
    assert.match(kept.redoNote, /原来的成片还在/u); assert.equal(kept.canExport, true); assert.equal(kept.canRedoShot, false);
    assert.ok(fs.existsSync(path.join(root, stubborn.id, 'final.mp4')));
  } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
run().then(() => console.log('real-shoot self-check passed: AI director (plan, checks, rewrite, flow, AI check, one shot redo), pick lists, plans and prompts, prices, time estimate, scene picture, shots a few at a time, busy service, failed shot redo, one-line subtitles'),
  (error) => { console.error(error); process.exit(1); });
