const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProductVideoService } = require('./product-video-service.cjs');
const { planVideo } = require('./video-directors.cjs');
const { parsePrices, createPriceReader } = require('./product-video-pricing.cjs');
const { taskIdOf } = require('./digital-human-provider.cjs');

const prices = () => parsePrices({ success: true, data: { resolution_prices: { '480P': .1201 }, resolution_paid_prices: { '480P': .09608 } } }, { success: true, data: { resolution_prices: { '1K': .2109 }, resolution_paid_prices: { '1K': .0085 } } });
const clip = Buffer.alloc(2048); clip.write('ftyp', 4, 'ascii');
const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
async function until(service, id, predicate) {
  for (let i = 0; i < 200; i += 1) { const task = service.get(id); if (predicate(task)) return task; await service.refresh(id); await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error('Task did not reach expected state: ' + JSON.stringify(service.get(id)));
}
async function run() {
  await assert.rejects(createPriceReader({ fetch: async () => new Response('{}', { status: 503 }) })(), /price_unavailable/);
  await assert.rejects(createPriceReader({ fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(600000)); controller.enqueue(new Uint8Array(600000)); controller.close(); }
  })) })(), /price_response_too_large/, 'streamed pricing responses must be bounded even without Content-Length');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoxi-product-video-'));
  const posts = [], tasks = new Map(), receipts = new Map();
  let unknownOnce = false, failedOnce = false, malformedOnce = false, offlinePrices = false, localFailure = false, badCaptionsOnce = false, badMediaOnce = false;
  const provider = {
    imageUploadBody: (file) => ({ body: Buffer.from(path.basename(file)), headers: {} }), nodeOf: (p) => p, taskIdOf,
    resultUrl: (p, kind) => `https://fixture.example/${p.task_id}.${kind === 'images' ? 'png' : 'mp4'}`,
    download: async (url, dest) => fs.writeFileSync(dest, url.endsWith('.png') ? image : clip),
    request: async (route, request = {}) => {
      if (route.startsWith('/operations/')) return receipts.get(route.split('/').pop());
      if (request.method === 'POST') {
        posts.push({ route, body: request.body, id: request.operationId, headers: request.headers });
        if (route.endsWith('/uploads/images')) return { url: 'https://fixture.example/' + request.body.toString('utf8') };
        if (route.includes('/asr/')) {
          const text = badCaptionsOnce ? '这是一段长度超过单屏字幕限制但没有词级时间的识别文本需要重新识别' : '现场清洁'; badCaptionsOnce = false;
          return { result: { utterances: [{ text, start_time: 1000, end_time: 2000 }] } };
        }
        const kind = route.includes('/images/') ? 'frame' : 'video', task_id = `${kind}_${tasks.size}`;
        tasks.set(task_id, { kind, fail: kind === 'video' && failedOnce });
        if (kind === 'video') failedOnce = false;
        const result = { task_id }; receipts.set(request.operationId, result);
        if (kind === 'video' && unknownOnce) { unknownOnce = false; throw Object.assign(new Error('disconnected'), { outcomeUnknown: true }); }
        if (kind === 'video' && malformedOnce) { malformedOnce = false; return {}; }
        return result;
      }
      const task_id = route.split('/').pop().split('?')[0], task = tasks.get(task_id);
      return { task_id, status: task.fail ? 'failed' : 'completed', cost: task.kind === 'frame' ? .01 : .9, credits_cost: task.kind === 'frame' ? .1 : 9 };
    }
  };
  const service = createProductVideoService({ rootDir: root, provider, readPrices: async () => { if (offlinePrices) throw new Error('offline'); return prices(); }, pollMs: 1,
    gatewayClient: { isEnabled: () => true, initialize: async () => ({ ready: true, capabilities: { apimart: true, apimart_video: true, volcengine_asr: true } }) },
    mediaTools: {
      normalizeAndAssemble: async ({ shots, destination }) => {
        if (badMediaOnce) { badMediaOnce = false; throw Object.assign(new Error('第二段没有声音'), { code: 'product_video_native_audio_missing', shotIndex: 1 }); }
        assert.deepEqual(shots.map((s) => s.seconds), [9,9,12]); fs.writeFileSync(destination, clip);
      },
      extractAudio: async ({ destination }) => fs.writeFileSync(destination, 'wav'),
      renderCaptioned: async ({ destination, captions }) => { if (localFailure) { localFailure=false; throw new Error('local render failed'); } assert.match(captions.ass, /96/u); fs.writeFileSync(destination, clip); fs.writeFileSync(destination.replace('.mp4', '.srt'), captions.srt); }
    }
  });
  try {
    const imagePath = path.join(root, 'input.png'); fs.writeFileSync(imagePath, image);
    const asset = service.importImage(imagePath);
    const facts = '清洁机器人适用于办公楼、商超和仓储。适用瓷砖、环氧地坪。清洁灰尘、泥水脚印和纸屑。';
    const input = { mode: 'product', imageId: asset.id, productName: '测试清洁设备', facts, durationSeconds: 30, budgetCny: 50 };
    const plan = planVideo(input);
    assert.equal(plan.shots.length, 3); assert.equal(plan.shots.reduce((n,s)=>n+s.seconds,0),30);
    assert.equal(new Set(plan.shots.map((s)=>s.sceneId)).size,3);
    assert.equal(planVideo({ ...input, productName:'咖啡杯',facts:'陶瓷咖啡杯，容量300ml。' }).evidenceStatus,'appearance_only');
    assert.equal(planVideo({ ...input, facts: '清洁机器人。不适用办公楼瓷砖，不支持处理灰尘。' }).evidenceStatus,'appearance_only');
    const textPath = path.join(root, '资料.txt'); fs.writeFileSync(textPath, '参数说明'.repeat(250));
    assert.equal(service.importFacts(textPath).text.length, 1000);
    const insufficient = await service.create({ ...input, budgetCny: 1 });
    await assert.rejects(service.start(insufficient.id), (e)=>e.code==='product_video_budget_exceeded'); assert.equal(posts.length,0);
    const task = await service.create(input); await service.start(task.id);
    const finished = await until(service, task.id, (t)=>t.status==='completed');
    assert.equal(finished.completedShots,3); assert.equal(finished.quote.pendingCny,1);
    const videos = posts.filter((p)=>p.route.endsWith('/videos/generations'));
    assert.deepEqual(videos.map((p)=>p.body.duration),[9,9,12]); assert.ok(videos.every((p)=>p.body.resolution==='480p' && p.body.generate_audio && p.body.draft===false));
    assert.equal(new Set(videos.map((p)=>p.body.image_with_roles[0].url)).size,3);
    const before=posts.length; await service.refresh(task.id); assert.equal(posts.length,before);
    const out=await service.exportVideo(task.id,path.join(root,'output.mp4')); assert.match(fs.readFileSync(out.subtitlePath,'utf8'),/现场清洁/u);
    assert.ok((await service.exportSource(task.id,path.join(root,'source.mp4'))).path);
    unknownOnce = true;
    const uncertain=await service.create(input); await service.start(uncertain.id);
    await until(service,uncertain.id,(t)=>t.status==='outcome_unknown');
    const paidBefore=posts.filter((p)=>p.route.endsWith('/videos/generations')).length;
    await service.refresh(uncertain.id);
    await until(service,uncertain.id,(t)=>t.status==='completed');
    assert.equal(posts.filter((p)=>p.route.endsWith('/videos/generations')).length,paidBefore+2,'unknown submission must query original receipt');
    failedOnce=true;
    const broken=await service.create(input); await service.start(broken.id);
    await until(service,broken.id,(t)=>t.status==='needs_attention');
    const videoCount=posts.filter((p)=>p.route.endsWith('/videos/generations')).length;
    await service.refresh(broken.id); assert.equal(posts.filter((p)=>p.route.endsWith('/videos/generations')).length,videoCount);
    await service.retryShot(broken.id); await until(service,broken.id,(t)=>t.status==='completed');
    assert.equal(posts.filter((p)=>p.route.endsWith('/videos/generations')).length,videoCount+3);
    malformedOnce=true;
    const malformed=await service.create(input); await service.start(malformed.id);
    await until(service,malformed.id,(t)=>t.status==='outcome_unknown');
    const malformedBefore=posts.filter((p)=>p.route.endsWith('/videos/generations')).length;
    await until(service,malformed.id,(t)=>t.status==='completed');
    assert.equal(posts.filter((p)=>p.route.endsWith('/videos/generations')).length,malformedBefore+2);
    localFailure=true;
    const concurrent=await service.create(input);
    const attempts=await Promise.allSettled([service.start(concurrent.id),service.start(concurrent.id)]);
    assert.equal(attempts.filter((a)=>a.status==='fulfilled').length,1,'concurrent start admission is serialized');
    await until(service,concurrent.id,(t)=>t.status==='needs_attention');
    const beforeLocal=posts.length; offlinePrices=true;
    await service.retryShot(concurrent.id); await until(service,concurrent.id,(t)=>t.status==='completed');
    assert.equal(posts.length,beforeLocal,'local packaging recovery must not depend on fresh pricing or repeat paid stages');
    offlinePrices=false;
    badCaptionsOnce=true;
    const captionsBroken=await service.create(input); await service.start(captionsBroken.id);
    const captionPause=await until(service,captionsBroken.id,(t)=>t.status==='needs_attention');
    assert.equal(captionPause.errorCode,'product_video_caption_words_missing'); assert.equal(captionPause.retryLabel,'重新识别字幕');
    const captionPosts=posts.length;
    await service.retryShot(captionsBroken.id); await until(service,captionsBroken.id,(t)=>t.status==='completed');
    assert.deepEqual(posts.slice(captionPosts).map((p)=>p.route),['/volcengine/asr/recognize/flash'],'only ASR is resubmitted');
    const asrRequests=posts.filter((p)=>p.route.includes('/asr/'));
    assert.equal(asrRequests.at(-1).headers['X-Api-Request-Id'],asrRequests.at(-1).id);
    assert.notEqual(asrRequests.at(-1).headers['X-Api-Request-Id'],asrRequests.at(-2).headers['X-Api-Request-Id']);
    assert.equal(service.get(captionsBroken.id).quote.pendingCny,2,'failed ASR charge allowance remains reserved');
    badMediaOnce=true;
    const mediaBroken=await service.create(input); await service.start(mediaBroken.id);
    const mediaPause=await until(service,mediaBroken.id,(t)=>t.status==='needs_attention');
    assert.equal(mediaPause.retryLabel,'重新生成第 2 段');
    const storedPath=path.join(root,mediaBroken.id,'task.json'), beforeRepair=JSON.parse(fs.readFileSync(storedPath,'utf8')), mediaPosts=posts.length;
    fs.writeFileSync(storedPath,JSON.stringify({...beforeRepair,budgetCny:1}));
    await assert.rejects(service.retryShot(mediaBroken.id),(e)=>e.code==='product_video_budget_exceeded');
    assert.equal(posts.length,mediaPosts); assert.equal(service.get(mediaBroken.id).status,'needs_attention');
    fs.writeFileSync(storedPath,JSON.stringify(beforeRepair));
    await service.retryShot(mediaBroken.id); await until(service,mediaBroken.id,(t)=>t.status==='completed');
    assert.deepEqual(posts.slice(mediaPosts).map((p)=>p.route),['/apimart/videos/generations','/volcengine/asr/recognize/flash'],'valid scenes and first frames must be reused');
    const afterRepair=JSON.parse(fs.readFileSync(storedPath,'utf8'));
    for(const index of [0,2]) assert.deepEqual(afterRepair.shots[index],beforeRepair.shots[index]);
    assert.notEqual(afterRepair.shots[1].providerTaskId,beforeRepair.shots[1].providerTaskId);
    const legacyId='pv_'+require('node:crypto').randomUUID(), legacyDir=path.join(root,legacyId);
    fs.mkdirSync(legacyDir); fs.writeFileSync(path.join(legacyDir,'final.mp4'),clip);
    fs.writeFileSync(path.join(legacyDir,'task.json'),JSON.stringify({id:legacyId,version:1,mode:'product',status:'completed',durationSeconds:30,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),finalFile:legacyId+'/final.mp4',currentShot:2,shots:[{},{}],plan:{shots:[{seconds:15,narration:'旧任务第一镜'},{seconds:15,narration:'旧任务第二镜'}],sendText:'旧任务'},operations:{}}));
    const legacyExport=await service.exportVideo(legacyId,path.join(root,'legacy.mp4'));
    assert.match(fs.readFileSync(legacyExport.subtitlePath,'utf8'),/00:00:15,000/u);
    global.__xiaoxiUpdateHold=true;
    await assert.rejects(service.create(input),(e)=>e.code==='product_video_update_pending');
    global.__xiaoxiUpdateHold=false;
    assert.equal(service.isBusy(),false);
    console.log('product-video self-check passed');
  } finally { global.__xiaoxiUpdateHold=false; service.close(); fs.rmSync(root,{recursive:true,force:true}); }
}
run().catch((error)=>{console.error(error);process.exitCode=1;});
