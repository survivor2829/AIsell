const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProductVideoService } = require('./product-video-service.cjs');
const { planVideo } = require('./video-directors.cjs');
const { parsePrices, createPriceReader, parseBailianPrices, validBailianPrices } = require('./product-video-pricing.cjs');
const { taskIdOf } = require('./digital-human-provider.cjs');

const legacyPrices = () => parsePrices({ success: true, data: { resolution_prices: { '480P': .1201 }, resolution_paid_prices: { '480P': .09608 } } }, { success: true, data: { resolution_prices: { '1K': .2109 }, resolution_paid_prices: { '1K': .0085 } } });
const videoPriceDoc = 'wan2.6-i2v-flash 模型价格 华北2（北京）<table>' + [['视频生成（720P）','.3'],['视频生成（1080P）','.5'],['视频生成（720P 无声）','.15'],['视频生成（1080P 无声）','.25']].map(([label,value])=>`<tr><td>${label}</td><td>${value}</td><td>每秒</td></tr>`).join('') + '</table>';
const ttsPriceDoc = 'qwen3-tts-flash 模型价格 华北2（北京）<table><tr><td>语音合成</td><td>0.8</td><td>每万字符</td></tr></table>';
const prices = (plan) => plan?.pipelineVersion < 3 ? legacyPrices() : { ...legacyPrices(), ...parseBailianPrices(videoPriceDoc,ttsPriceDoc), resolution:'720p',audio:false,videoCnyPerSecond:.15,audioReserveCny:2 };
const VIDEO_ROUTE='/bailian/api/v1/services/aigc/video-generation/video-synthesis';
const clip = Buffer.alloc(2048); clip.write('ftyp', 4, 'ascii');
const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
async function until(service, id, predicate) {
  for (let i = 0; i < 200; i += 1) { const task = service.get(id); if (predicate(task)) return task; await service.refresh(id); await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error('Task did not reach expected state: ' + JSON.stringify(service.get(id)));
}
async function run() {
  await assert.rejects(createPriceReader({ fetch: async () => new Response('{}', { status: 503 }) })({pipelineVersion:2}), /price_unavailable/);
  await assert.rejects(createPriceReader({ fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(600000)); controller.enqueue(new Uint8Array(600000)); controller.close(); }
  })) })({pipelineVersion:2}), /price_response_too_large/, 'streamed pricing responses must be bounded even without Content-Length');
  assert.equal(validBailianPrices(parseBailianPrices(videoPriceDoc,ttsPriceDoc)),true);
  assert.throws(()=>parseBailianPrices(videoPriceDoc.replace('720P 无声','未知规格'),ttsPriceDoc),/计费项不完整/u);
  assert.equal(validBailianPrices({...parseBailianPrices(videoPriceDoc,ttsPriceDoc),checkedAt:'2020-01-01'}),false);
  let gatewayPriceReads = 0;
  const gatewayPrices = { isEnabled: () => true, url: (route) => `https://fixture.invalid${route}`,
    fetch: async (url, options) => {
      gatewayPriceReads += 1;
      assert.equal(url, 'https://fixture.invalid/capabilities?price_model=gpt-image-2');
      assert.equal(options.method, 'GET');
      return { ok: true, json: async () => ({ ok: true, apimart_pricing: {
        source: 'https://apimart.ai/api/pricing/model?model=gpt-image-2', checked_at: Date.now()/1000,
        payload: { success: true, data: { model_name:'gpt-image-2', resolution_prices:{'1K':.2109} } }
      } }) };
    } };
  const routedPrices = { gatewayClient: gatewayPrices,
    fetchText: async (url) => url.includes('wan2-6') ? videoPriceDoc : ttsPriceDoc,
    fetchJson: async () => { throw new Error('customer_must_not_fetch_foreign_image_price'); } };
  assert.equal((await createPriceReader(routedPrices)()).imageUsd, .2109);
  assert.equal(gatewayPriceReads, 1, 'official product-video prices reuse the authenticated server route');
  await assert.rejects(createPriceReader({ ...routedPrices, gatewayClient: { ...gatewayPrices,
    fetch: async () => ({ok:false,status:503}) } })(), /场景首帧报价/u,
  'failed server pricing must stop instead of switching to direct foreign requests');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoxi-product-video-'));
  const posts = [], tasks = new Map(), receipts = new Map();
  let unknownOnce = false, receiptsPending = false, failedOnce = false, failedVideoCount = 0, malformedOnce = false, offlinePrices = false, localFailure = false, badCaptionsOnce = false, badMediaOnce = false, tamperAudioOnce = false;
  const provider = {
    imageUploadBody: (file) => ({ body: Buffer.from(path.basename(file)), headers: {} }), nodeOf: (p) => p, taskIdOf,
    resultUrl: (p, kind) => `https://fixture.example/${p.task_id}.${kind === 'images' ? 'png' : 'mp4'}`,
    download: async (url, dest) => fs.writeFileSync(dest, url.endsWith('.png') ? image : clip),
    request: async (route, request = {}) => {
      if (route.startsWith('/operations/')) return receiptsPending ? {status:'pending'} : receipts.get(route.split('/').pop());
      if (request.method === 'POST') {
        posts.push({ route, body: request.body, id: request.operationId, headers: request.headers });
        if (route.endsWith('/uploads/images')) return { url: 'https://fixture.example/' + request.body.toString('utf8') };
        if (route === '/bailian/tts-fixture') { const result={output:{audio:{url:'https://fixture.example/audio.wav'}}};receipts.set(request.operationId,result);return result; }
        if (route.includes('/asr/')) {
          const text = badCaptionsOnce ? '这是一段长度超过单屏字幕限制但没有词级时间的识别文本需要重新识别' : '现场清洁'; badCaptionsOnce = false;
          return { result: { utterances: [{ text, start_time: 1000, end_time: 2000 }] } };
        }
        const kind = route.includes('/images/') ? 'frame' : 'video', task_id = `${kind}_${tasks.size}`;
        tasks.set(task_id, { kind, fail: kind === 'video' && (failedOnce || failedVideoCount > 0) });
        if (kind === 'video' && failedVideoCount > 0) failedVideoCount -= 1;
        if (kind === 'video') failedOnce = false;
        const result = route === VIDEO_ROUTE ? { output:{ task_id } } : { task_id }; receipts.set(request.operationId, result);
        if (kind === 'video' && unknownOnce) { unknownOnce = false; throw Object.assign(new Error('disconnected'), { outcomeUnknown: true }); }
        if (kind === 'video' && malformedOnce) { malformedOnce = false; return {}; }
        return result;
      }
      const task_id = route.split('/').pop().split('?')[0], task = tasks.get(task_id);
      if (route.startsWith('/bailian/')) return { output:{task_id,task_status:task.fail?'FAILED':'SUCCEEDED',video_url:`https://fixture.example/${task_id}.mp4`},usage:{video_duration:10},cost:9 };
      return { task_id, status: task.fail ? 'failed' : 'completed', cost: task.kind === 'frame' ? .01 : .9, credits_cost: task.kind === 'frame' ? .1 : 9 };
    }
  };
  const serviceOptions = { rootDir: root, provider, readPrices: async (plan) => { if (offlinePrices) throw new Error('offline'); return prices(plan); }, pollMs: 1,
    gatewayClient: { isEnabled: () => true, initialize: async () => ({ ready: true, capabilities: { apimart: true, apimart_video: true, bailian:true,bailian_video:true,volcengine_asr: true } }) },
    prepareAudio: async ({task,directory,operation}) => {
      assert.equal(task.shots.filter(s=>s.frameFile).length,3,'all scene frames must be ready before audio and video');
      for(let i=0;i<task.shots.length;i+=1) await operation(`audio_narration_${i}`,'/bailian/tts-fixture',{text:task.plan.shots[i].narration},.05);
      const audio=path.join(directory,'full-audio.wav');fs.writeFileSync(audio,'fixture-wave');
      if(tamperAudioOnce){tamperAudioOnce=false;task.plan.shots[0].prompt+='临时修改';}
      return {file:audio,voiceFile:audio,durationSeconds:task.durationSeconds,music:{status:'unavailable',source:''}};
    },
    packageVideo: async (payload) => {
      assert.match(payload.source_id, /^product_video_/u);
      assert.equal(payload.cover_mode, 'local_frame');
      assert.equal(payload.prepared_transcript.source_sha256,
        require('node:crypto').createHash('sha256').update(fs.readFileSync(payload.input_video_path)).digest('hex'));
      return { task_id: 'fixture_packaging', project_id: 'fixture_project' };
    },
    queryPackaging: async () => {
      if (localFailure) { localFailure = false; throw new Error('local render failed'); }
      return { status: 'completed', result: { generated_video_id: 'fixture_video' } };
    },
    resolvePackagingVideo: async () => {
      const output = path.join(root, 'packaged.mp4'); fs.writeFileSync(output, clip);
      return { absolute_path: output };
    },
    mediaTools: {
      probe:async()=>({video:{width:576,height:1024}}),
      normalizeAndAssemble:async({destination})=>fs.writeFileSync(destination,clip),
      assemblePreparedVideo: async ({ shots, destination, audioPath }) => {
        assert.equal(fs.readFileSync(audioPath,'utf8'),'fixture-wave');
        if (badMediaOnce) { badMediaOnce = false; throw Object.assign(new Error('第二段没有声音'), { code: 'product_video_native_audio_missing', shotIndex: 1 }); }
        assert.deepEqual(shots.map((s) => s.seconds), [10,10,10]); fs.writeFileSync(destination, clip);
      },
      extractAudio: async ({ destination }) => fs.writeFileSync(destination, 'wav'),
      renderCaptioned: async ({ destination, captions }) => { if (localFailure) { localFailure=false; throw new Error('local render failed'); } assert.match(captions.ass, /96/u); fs.writeFileSync(destination, clip); fs.writeFileSync(destination.replace('.mp4', '.srt'), captions.srt); }
    }
  };
  let service = createProductVideoService(serviceOptions);
  try {
    const imagePath = path.join(root, 'input.png'); fs.writeFileSync(imagePath, image);
    const asset = service.importImage(imagePath);
    const facts = '清洁机器人适用于办公楼、商超和仓储。适用瓷砖、环氧地坪。清洁灰尘、泥水脚印和纸屑。';
    const input = { mode: 'product', imageId: asset.id, productName: '测试清洁设备', facts, durationSeconds: 30, budgetCny: 50 };
    const plan = planVideo(input);
    assert.equal(plan.shots.length, 3); assert.equal(plan.shots.reduce((n,s)=>n+s.seconds,0),30);
    assert.equal(new Set(plan.shots.map((s)=>s.sceneId)).size,3);
    assert.ok(planVideo({ ...input, surfaceId: 'tile' }).shots.every(shot => shot.surface === '瓷砖'), 'selected material must reach every shot');
    assert.equal(planVideo({ ...input, productName:'咖啡杯',facts:'陶瓷咖啡杯，容量300ml。' }).evidenceStatus,'appearance_only');
    assert.equal(planVideo({ ...input, facts: '清洁机器人。不适用办公楼瓷砖，不支持处理灰尘。' }).evidenceStatus,'appearance_only');
    const textPath = path.join(root, '资料.txt'); fs.writeFileSync(textPath, '参数说明'.repeat(250));
    assert.equal(service.importFacts(textPath).text.length, 1000);
    const insufficient = await service.create({ ...input, budgetCny: 1 });
    await assert.rejects(service.start(insufficient.id), (e)=>e.code==='product_video_budget_exceeded'); assert.equal(posts.length,0);
    const task = await service.create({ ...input, budgetCny: undefined });
    assert.equal(task.quote.budgetCny, task.quote.maximumCny, 'the customer need not supply a budget');
    await service.start(task.id);
    const finished = await until(service, task.id, (t)=>t.status==='completed');
    assert.equal(finished.completedShots,3); assert.equal(finished.quote.pendingCny,5.65,'official usage is not a bill; keep Wan, audio and ASR reserves');
    const videos = posts.filter((p)=>p.route===VIDEO_ROUTE);
    assert.deepEqual(videos.map((p)=>p.body.parameters.duration),[10,10,10]); assert.ok(videos.every((p)=>p.body.parameters.resolution==='720P' && p.body.parameters.audio===false && p.body.parameters.prompt_extend===false));
    assert.ok(videos.every((p)=>p.headers['X-DashScope-Async']==='enable'));
    const firstVideo=posts.findIndex(p=>p.route===VIDEO_ROUTE);
    assert.equal(posts.slice(0,firstVideo).filter(p=>p.route==='/apimart/images/generations').length,3);
    assert.equal(posts.slice(0,firstVideo).filter(p=>p.route.includes('/asr/')).length,1,'captions must be prepared before paying for any video');
    const before=posts.length; await service.refresh(task.id); assert.equal(posts.length,before);
    const out=await service.exportVideo(task.id,path.join(root,'output.mp4')); assert.match(fs.readFileSync(out.subtitlePath,'utf8'),/现场清洁/u);
    assert.ok((await service.exportSource(task.id,path.join(root,'source.mp4'))).path);
    unknownOnce = true; receiptsPending = true;
    const uncertain=await service.create(input); await service.start(uncertain.id);
    await until(service,uncertain.id,(t)=>t.status==='outcome_unknown');
    const paidBefore=posts.filter((p)=>p.route===VIDEO_ROUTE).length;
    global.__xiaoxiUpdateHold=true;
    assert.equal(service.prepareForUpdate().busy,false,'unknown cloud receipt must not permanently block updates');
    global.__xiaoxiUpdateHold=false;
    receiptsPending=false; service.resumeAfterUpdate();
    await service.refresh(uncertain.id);
    await until(service,uncertain.id,(t)=>t.status==='completed');
    assert.equal(posts.filter((p)=>p.route===VIDEO_ROUTE).length,paidBefore+2,'unknown submission must query original receipt');
    failedOnce=true;
    const broken=await service.create(input), beforeAuto=posts.filter((p)=>p.route===VIDEO_ROUTE).length; await service.start(broken.id);
    await until(service,broken.id,(t)=>t.status==='completed');
    assert.equal(posts.filter((p)=>p.route===VIDEO_ROUTE).length,beforeAuto+4,'one explicit failure replaces only its failed shot');
    failedVideoCount=2;
    const twice=await service.create(input); await service.start(twice.id);
    await until(service,twice.id,t=>t.status==='needs_attention');
    const afterTwice=posts.length;
    await assert.rejects(service.retryShot(twice.id),e=>e.code==='product_video_retry_limit');
    assert.equal(posts.length,afterTwice,'refresh or retry cannot reset the one-redo allowance');
    malformedOnce=true; receiptsPending=true;
    const malformed=await service.create(input); await service.start(malformed.id);
    await until(service,malformed.id,(t)=>t.status==='outcome_unknown');
    const malformedBefore=posts.filter((p)=>p.route===VIDEO_ROUTE).length;
    receiptsPending=false;
    await until(service,malformed.id,(t)=>t.status==='completed');
    assert.equal(posts.filter((p)=>p.route===VIDEO_ROUTE).length,malformedBefore+2);
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
    assert.deepEqual(posts.slice(captionPosts).map((p)=>p.route),['/volcengine/asr/recognize/flash',VIDEO_ROUTE,VIDEO_ROUTE,VIDEO_ROUTE],'retry recognition before first video; reuse frames and audio');
    const asrRequests=posts.filter((p)=>p.route.includes('/asr/'));
    assert.equal(asrRequests.at(-1).headers['X-Api-Request-Id'],asrRequests.at(-1).id);
    assert.notEqual(asrRequests.at(-1).headers['X-Api-Request-Id'],asrRequests.at(-2).headers['X-Api-Request-Id']);
    assert.equal(service.get(captionsBroken.id).quote.pendingCny,6.65,'failed ASR charge allowance remains reserved');
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
    assert.deepEqual(posts.slice(mediaPosts).map((p)=>p.route),[VIDEO_ROUTE],'valid scenes, audio, subtitles and first frames must be reused');
    const afterRepair=JSON.parse(fs.readFileSync(storedPath,'utf8'));
    for(const index of [0,2]) assert.deepEqual(afterRepair.shots[index],beforeRepair.shots[index]);
    assert.notEqual(afterRepair.shots[1].providerTaskId,beforeRepair.shots[1].providerTaskId);
    tamperAudioOnce=true;
    const tampered=await service.create(input), priorTamperVideos=posts.filter(p=>p.route===VIDEO_ROUTE).length;
    await service.start(tampered.id);
    const tamperPause=await until(service,tampered.id,t=>t.status==='needs_attention');
    assert.equal(tamperPause.errorCode,'product_video_preparation_changed');
    assert.equal(posts.filter(p=>p.route===VIDEO_ROUTE).length,priorTamperVideos,'changed locked inputs must be caught before any paid video');
    const oldTask=await service.create(input), oldPath=path.join(root,oldTask.id,'task.json'), oldStored=JSON.parse(fs.readFileSync(oldPath,'utf8'));
    oldStored.version=2;oldStored.plan.pipelineVersion=2;oldStored.plan.sourceResolution='480p';oldStored.prices=legacyPrices();
    delete oldStored.audioVoicePolicy; delete oldStored.presentationPolicy;
    fs.writeFileSync(oldPath,JSON.stringify(oldStored));
    const oldPosts=posts.length;await service.start(oldTask.id);await until(service,oldTask.id,t=>t.status==='completed');
    assert.equal(posts.slice(oldPosts).filter(p=>p.route==='/apimart/videos/generations').length,3,'existing v2 drafts must retain Seedance and its original billing route');
    assert.equal(posts.slice(oldPosts).filter(p=>p.route===VIDEO_ROUTE).length,0);
    const legacyId='pv_'+require('node:crypto').randomUUID(), legacyDir=path.join(root,legacyId);
    fs.mkdirSync(legacyDir); fs.writeFileSync(path.join(legacyDir,'final.mp4'),clip);
    fs.writeFileSync(path.join(legacyDir,'task.json'),JSON.stringify({id:legacyId,version:1,mode:'product',status:'completed',durationSeconds:30,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),finalFile:legacyId+'/final.mp4',currentShot:2,shots:[{},{}],plan:{shots:[{seconds:15,narration:'旧任务第一镜'},{seconds:15,narration:'旧任务第二镜'}],sendText:'旧任务'},operations:{}}));
    const legacyExport=await service.exportVideo(legacyId,path.join(root,'legacy.mp4'));
    assert.match(fs.readFileSync(legacyExport.subtitlePath,'utf8'),/00:00:15,000/u);
    global.__xiaoxiUpdateHold=true;
    await assert.rejects(service.create(input),(e)=>e.code==='product_video_update_pending');
    global.__xiaoxiUpdateHold=false;
    assert.equal(service.isBusy(),false);
    const recoveryPath=path.join(root,finished.id,'task.json');
    const recovery=JSON.parse(fs.readFileSync(recoveryPath,'utf8'));
    recovery.status='packaging'; fs.writeFileSync(recoveryPath,JSON.stringify(recovery));
    await service.close();
    global.__xiaoxiUpdateHold=true;
    service=createProductVideoService(serviceOptions);
    assert.equal(service.prepareForUpdate().busy,false,'saved cloud states alone do not prevent updating');
    const beforeRestartPosts=posts.length;
    global.__xiaoxiUpdateHold=false;
    service.resumeAfterUpdate();
    for(let i=0;i<200 && service.get(finished.id).status!=='completed';i++) await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(service.get(finished.id).status,'completed','reopening and aborted update resume without opening the task page');
    assert.equal(posts.length,beforeRestartPosts,'recovery reuses successful paid work');
    await assert.rejects(service.retryShot(twice.id),e=>e.code==='product_video_retry_limit');
    console.log('product-video self-check passed');
  } finally { global.__xiaoxiUpdateHold=false; service.close(); fs.rmSync(root,{recursive:true,force:true}); }
}
run().catch((error)=>{console.error(error);process.exitCode=1;});
