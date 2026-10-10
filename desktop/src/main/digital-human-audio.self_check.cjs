const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createDigitalHumanService } = require('./digital-human-service.cjs');
const legacy = require('./digital-human-provider.cjs');
const officialSchema = require('./bailian-video-provider.cjs');
const audio = require('./digital-human-audio.cjs');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  assert.equal(audio.speechChunks('先说第一件事。再说第二件事。最后说第三件事。').length, 1);
  const timed = [{ text: '第一句', start_time: 100, end_time: 13000 }, { text: '第二句', start_time: 13200, end_time: 17100 }];
  const naturalSegments = audio.splitMeasuredSpeech(timed, 17.3);
  assert.equal(naturalSegments.length, 2);
  assert.equal(naturalSegments.reduce((sum, item) => sum + item.seconds, 0), 17.3, 'All real audio survives even when the target was 15 seconds.');
  assert.ok(naturalSegments.every((item) => item.seconds >= 2 && item.seconds <= 15));
  assert.throws(() => audio.splitMeasuredSpeech([{ text: '无分词时间的长句', start_time: 0, end_time: 21000 }], 21.2), /自然分段/);
  assert.equal(audio.splitScript('先说第一件事。再说第二件事。最后说第三件事。', 45).length, 3);
  assert.throws(() => audio.assertSpeechCoverage({ seconds: 11, speechStart: .1, speechEnd: 10.9, maxGapSeconds: .2 }, 15), /尚未提交视频/);
  assert.throws(() => audio.verifyTranscript([{ text: '漏了后面', end_time: 14500 }], '漏了后面完整的一句话。', 15), /不一致/);
  const numericSpeech = [{ text: '浦度CC1 Pro，15升，500毫米，3~4小时。', start_time: 100, end_time: 14500,
    words: [{ text: '浦度CC1 Pro', start_time: 100, end_time: 3000 }, { text: '15升', start_time: 3000, end_time: 6000 },
      { text: '500毫米', start_time: 6000, end_time: 9000 }, { text: '3~4小时', start_time: 9000, end_time: 14500 }] }];
  const preserved = JSON.stringify(numericSpeech);
  const alignedNumbers = audio.verifyTranscript(numericSpeech, '普渡CC1 Pro，十五升，五百毫米，三到四小时。', 15).alignedUtterances;
  assert.equal(alignedNumbers[0].text, '普渡CC1 Pro，十五升，五百毫米，三到四小时。');
  assert.deepEqual(alignedNumbers[0].words.map(word => [word.start_time, word.end_time]), numericSpeech[0].words.map(word => [word.start_time, word.end_time]));
  assert.equal(JSON.stringify(numericSpeech), preserved, 'Retain the original recognition receipt.');
  assert.throws(() => audio.verifyTranscript(numericSpeech, '普渡CC2 Pro，十五升，五百毫米，三到四小时。', 15), /不一致/);
  assert.throws(() => audio.verifyTranscript(numericSpeech, '普渡CC1 Pro，五十升，五百毫米，三到四小时。', 15), /不一致/);
  const exact = '先看地面是否适合使用清洁机器人，再看现场需要清理什么污物，把现场情况发来一起安排合适的清洁方案。';
  assert.throws(() => audio.verifyTranscript([{ text: exact.replace('地面', '地棉'), start_time: 0, end_time: 14500 }], exact, 15), /不一致/, 'Even one substitution must stop before paid video; packaging needs exact anchors.');
  assert.throws(() => audio.verifyTranscript([{ text: 'CC1 Pro', start_time: 0, end_time: 14500 }], 'ＣＣ1 Pro', 15), /不一致/, 'Packaging does not normalize compatibility characters.');
  assert.equal(audio.verifyTranscript([{ text: 'CC1 PRO，地面清洁。', start_time: 0, end_time: 14500 }], 'cc1 pro：地面清洁！✨', 15).editDistance, 0);
  const sameSpeech = [{ text: '普度 CC1PRO洗扫推尘一体。', start_time: 200, end_time: 3240,
    words: [{ text: '普度', start_time: 200, end_time: 480 }, { text: ' ', start_time: -1, end_time: -1 },
      { text: 'CC1PRO洗扫推尘一体。', start_time: 720, end_time: 3240 }] }];
  const aligned = audio.verifyTranscript(sameSpeech, '普渡CC1 Pro，洗扫推尘一体。', 3.36);
  assert.equal(aligned.phoneticCorrections, 1);
  assert.equal(aligned.alignedUtterances[0].words[0].text, '普渡');
  assert.equal(aligned.alignedUtterances[0].words[0].end_time, 480);
  assert.equal(aligned.alignedUtterances[0].words.length, 2);
  assert.equal(sameSpeech[0].text, '普度 CC1PRO洗扫推尘一体。', 'Original supplier receipt stays untouched');
  assert.throws(() => audio.verifyTranscript([{ text: '普度CC2 Pro', start_time: 0, end_time: 3000 }], '普渡CC1 Pro', 3.3), /不一致/);
  assert.throws(() => audio.verifyTranscript([{ text: '先看地面', start_time: 0, end_time: 8000 }, { text: '再看污物', start_time: 7900, end_time: 14500 }], '先看地面，再看污物。', 15), /重叠/);
  const pcm = Buffer.alloc(15 * 16000 * 2);
  for (let i = 1600; i < 14.5 * 16000; i += 1) pcm.writeInt16LE(Math.round(Math.sin(i / 15) * 10000), i * 2);
  const measured = audio.analyzePcm(pcm); audio.assertSpeechCoverage(measured, 15);
  assert.ok(measured.speechEnd >= 14.5 && measured.speechStart <= .12);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoxi-avatar-audio-'));
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const input = path.join(directory, 'input.png'); fs.writeFileSync(input, image);
  const posts = [], receipts = new Map(), services = [];
  let audioSeconds = 14.7, disconnectTts = false, disconnectPoll = false, uploadReady = true, lastText = [], packaging, failVideos = 0, uploads = 0;
  const bytesFor = (destination) => { const bytes = Buffer.alloc(2048); bytes.write('ftyp', 4); return destination.endsWith('.mp4') ? bytes : destination.endsWith('.image') ? image : Buffer.from('frozen voice fixture'); };
  const download = async (_url, destination) => { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytesFor(destination)); };
  const request = async (route, options = {}) => {
    if (route.startsWith('/operations/')) return receipts.get(route.split('/').pop());
    if (options.method !== 'POST') {
      if (route.startsWith('/bailian/')) {
        if (disconnectPoll) { disconnectPoll = false; throw Object.assign(new Error('read connection lost'), { code: 'digital_human_request_unconfirmed' }); }
        if (failVideos > 0) { failVideos -= 1; return { output: { task_status: 'FAILED', message: 'fixture supplier failure' } }; }
        return { output: { task_status: 'SUCCEEDED', video_url: 'https://fixture.example.com/video.mp4' } };
      }
      return { data: { status: 'completed', result: { images: [{ url: ['https://fixture.example.com/preview.png'] }] } } };
    }
    posts.push({ route, ...options }); let response;
    if (route.endsWith('/uploads/images')) response = { data: { url: 'https://fixture.example.com/image.png' } };
    else if (route.endsWith('/images/generations')) response = { data: [{ task_id: 'preview_task' }] };
    else if (route === officialSchema.ROUTES.tts) { lastText.push(options.body.input.text); response = { output: { audio: { url: 'https://fixture.example.com/voice.wav' } } }; }
    else if (route === officialSchema.ROUTES.video) response = { output: { task_id: `video_${posts.length}` } };
      else if (route.includes('/asr/')) {
        assert.equal(options.headers['X-Api-Request-Id'], options.operationId, 'ASR must use the persisted request UUID');
        const text = lastText.join(''), chars = Array.from(text).filter((char) => /[\p{L}\p{N}]/u.test(char)), step = (audioSeconds * 1000 - 200) / chars.length;
        response = { result: { utterances: [{ text, start_time: 100, end_time: Math.round(audioSeconds * 1000 - 100),
          words: chars.map((char, index) => ({ text: char, start_time: Math.round(100 + index * step), end_time: Math.round(100 + (index + 1) * step - 1) })) }] } };
      }
    else throw new Error(`Unexpected route ${route}`);
    receipts.set(options.operationId, response);
    if (disconnectTts && route === officialSchema.ROUTES.tts) { disconnectTts = false; throw Object.assign(new Error('lost response'), { outcomeUnknown: true }); }
    return response;
  };
  const prices = { ready: true, provider: 'bailian', model: 'wan2.6-i2v-flash', region: 'cn-beijing',
    rates: { '720p': { silent: .15, audio: .3 }, '1080p': { silent: .25, audio: .5 } }, ttsCnyPer10kChars: .8, checkedAt: new Date().toISOString() };
  const previewPrices = { ready: true, videoUsdPerSecond: .1, imageUsd: .1, fxCnyPerUsd: 8, asrReserveCny: 1, checkedAt: prices.checkedAt };
  const options = { rootDir: path.join(directory, 'data'),
    provider: { ...legacy, request, download, capabilities: async () => ({ ready: true }), previewPayload: () => ({ model: 'gpt-image-2' }), imageUploadBody: () => ({ body: Buffer.from('fixture'), headers: {} }) },
    officialProvider: { ...officialSchema, request, download, capabilities: async () => ({ ready: true }) },
    readPrices: async () => prices, readPreviewPrices: async () => previewPrices,
    requireAudioUploadCapability: async () => uploadReady,
    uploadPreparedAudio: async ({ source, sha256 }) => { uploads += 1; assert.equal(hash(fs.readFileSync(source)), sha256);
      return { url: 'oss://dashscope-instant/fixture/voice.wav', sha256, expiresAt: new Date(Date.now() + 23 * 3600000).toISOString() }; },
    audioTools: {
      measureAudio: async ({ source }) => ({ seconds: audioSeconds, speechStart: .1, speechEnd: audioSeconds - .1, speechSeconds: audioSeconds - 1, maxGapSeconds: .3, sha256: hash(fs.readFileSync(source)) }),
      freezeAudio: async ({ destination }) => { fs.writeFileSync(destination, 'complete frozen voice'); return { sha256: hash(fs.readFileSync(destination)) }; },
      cutAudio: async ({ destination, seconds }) => { fs.writeFileSync(destination, `cut frozen voice ${seconds}`); return { seconds, speechStart: .02, speechEnd: seconds - .05, speechSeconds: seconds - .1, maxGapSeconds: .3, sha256: hash(fs.readFileSync(destination)) }; },
      assemble: async ({ destination, audioDestination }) => { fs.writeFileSync(destination, bytesFor(destination)); return { audioSha256: hash(fs.readFileSync(audioDestination)) }; },
    },
    packageVideo: async (payload) => { packaging = payload; return { task_id: 'packaging_fixture' }; },
    queryPackaging: async () => ({ status: 'completed', generated_video_id: 'ready_fixture' }),
  };
  try {
    let service = createDigitalHumanService(options); services.push(service);
    const person = service.importImage(input), product = service.importImage(input);
    const draft = { personAssetId: person.id, productAssetId: product.id, sceneId: 'studio', voiceStyle: 'natural_female', durationSeconds: 45,
      script: '先看地面适不适合。再看需要清理什么污物。把现场发来一起安排。', budgetCny: 20 };
    const zero = service.create({ ...draft, budgetCny: 0 });
    await assert.rejects(service.preview(zero.id), error => error.code === 'digital_human_budget_required'); assert.equal(posts.length, 0);
    const tooSmall = service.create({ ...draft, budgetCny: 1 });
    await assert.rejects(service.preview(tooSmall.id), error => error.code === 'digital_human_budget_exceeded'); assert.equal(posts.length, 0);
    uploadReady = false;
    const outdatedWorker = service.create(draft);
    await assert.rejects(service.preview(outdatedWorker.id), { code: 'digital_human_audio_upload_unavailable' });
    assert.equal(posts.length, 0, 'An old installed component must fail before paid TTS, not after preparing a voice.');
    uploadReady = true;
    const short = service.create({ ...draft, durationSeconds: 15, script: '配音太短。', budgetCny: 5, title: '完整短标题' }); audioSeconds = 10;
    assert.equal(service.create({ ...draft, id: short.id, durationSeconds: 15, script: '配音太短。', budgetCny: 5 }).title, '完整短标题');
    await service.preview(short.id); await service.refresh(short.id);
    assert.equal(service.get(short.id).status, 'preview_ready', 'A short original script must proceed at its real duration, without padding to 15 seconds.');
    assert.equal(service.get(short.id).actualDurationSeconds, 10);
    assert.equal(posts.filter((p) => p.route === officialSchema.ROUTES.video).length, 0);

    audioSeconds = 17.3; lastText = []; disconnectTts = true;
    const task = service.create({ ...draft, durationSeconds: 15, budgetCny: undefined }); await service.preview(task.id); await service.refresh(task.id);
    const preparationBudget = service.get(task.id).budgetCny;
    assert.ok(preparationBudget > 0 && preparationBudget < 2, 'Only measured speech preparation is reserved before a full audio timeline exists.');
    const firstTtsCount = posts.filter((p) => p.route === officialSchema.ROUTES.tts).length;
    await service.close(); service = createDigitalHumanService(options); services.push(service);
    for (let i = 0; i < 8 && service.get(task.id).status !== 'preview_ready'; i += 1) await service.refresh(task.id);
    assert.equal(service.get(task.id).status, 'preview_ready');
    assert.equal(posts.filter((p) => p.route === officialSchema.ROUTES.tts).length, firstTtsCount, 'A lost TTS response is recovered, never regenerated.');
    const automaticBudget = service.get(task.id).budgetCny;
    assert.ok(automaticBudget > preparationBudget && automaticBudget < 20);
    assert.equal(posts.filter((p) => p.route === officialSchema.ROUTES.video).length, 0);
    await service.confirm(task.id, service.get(task.id).previewRevision);
    for (let i = 0; i < 10 && service.get(task.id).status !== 'completed'; i += 1) await service.refresh(task.id);
    assert.equal(service.get(task.id).status, 'completed');
    const videoPosts = posts.filter((p) => p.route === officialSchema.ROUTES.video);
    assert.equal(videoPosts.length, 2); assert.ok(videoPosts.every((p) => p.body.parameters.duration <= 15 && p.body.input.audio_url && p.body.parameters.audio));
    assert.equal(packaging.cover_mode, 'local_frame'); assert.equal(packaging.prepared_transcript.utterances.length, 1);
    assert.equal(packaging.prepared_transcript.source_sha256, hash(fs.readFileSync(packaging.input_video_path)));
    assert.ok(service.get(task.id).quote.reservedCny <= 20); assert.equal(service.get(task.id).quote.actualCny, null);
    assert.equal(service.get(task.id).budgetCny, automaticBudget, 'Preparation and generation must not silently grow the frozen budget.');
    assert.equal(JSON.stringify(service.get(task.id)).includes('https://fixture'), false);
    assert.equal(posts.filter((p) => p.route.includes('/asr/')).length, 2);
    assert.ok(posts.findIndex((p) => p.route.includes('/asr/')) < posts.findIndex((p) => p.route === officialSchema.ROUTES.video));
    lastText = []; audioSeconds = 14.7;
    const expired = service.create({ ...draft, durationSeconds: 15, script: '保留原音轨，不重复收费。' });
    await service.preview(expired.id); await service.refresh(expired.id);
    const recordPath = path.join(options.rootDir, expired.id, 'task.json'), record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    record.segments[0].audioUrl = 'https://fixture.example.com/expired.wav'; record.segments[0].audioExpiresAt = '2000-01-01T00:00:00.000Z'; fs.writeFileSync(recordPath, JSON.stringify(record));
    const ttsBeforeExpiry = posts.filter((p) => p.route === officialSchema.ROUTES.tts).length, uploadsBefore = uploads;
    await service.confirm(expired.id, service.get(expired.id).previewRevision); await service.refresh(expired.id);
    assert.equal(service.get(expired.id).status, 'completed');
    assert.equal(uploads, uploadsBefore + 1); assert.equal(posts.filter((p) => p.route === officialSchema.ROUTES.tts).length, ttsBeforeExpiry);

    lastText = []; failVideos = 1;
    const capped = service.create({ ...draft, durationSeconds: 15, script: '保持明确的费用上限。', budgetCny: 6.5 });
    await service.preview(capped.id); await service.refresh(capped.id);
    const cappedVideoCount = posts.filter((p) => p.route === officialSchema.ROUTES.video).length;
    await service.confirm(capped.id, service.get(capped.id).previewRevision); await service.refresh(capped.id);
    assert.equal(service.get(capped.id).errorCode, 'digital_human_retry_budget_exceeded');
    assert.equal(service.get(capped.id).budgetCny, 6.5);
    assert.equal(posts.filter((p) => p.route === officialSchema.ROUTES.video).length, cappedVideoCount + 1, 'Insufficient allowance must stop before a second paid submission.');

    lastText = []; disconnectPoll = true;
    const interrupted = service.create({ ...draft, durationSeconds: 15, script: '断网后继续核对原任务。' });
    await service.preview(interrupted.id); await service.refresh(interrupted.id);
    await service.confirm(interrupted.id, service.get(interrupted.id).previewRevision); await service.refresh(interrupted.id);
    assert.equal(service.get(interrupted.id).status, 'official_generating');
    const postsAtRestart = posts.length;
    await service.close(); service = createDigitalHumanService(options); services.push(service);
    for (let i = 0; i < 20 && service.get(interrupted.id).status !== 'completed'; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(service.get(interrupted.id).status, 'completed', 'Startup resumes the persisted task even without opening its UI page.');
    assert.equal(posts.length, postsAtRestart);

    lastText = []; failVideos = 2;
    const retry = service.create({ ...draft, durationSeconds: 15, script: '只重做一次失败镜头。' });
    await service.preview(retry.id); await service.refresh(retry.id);
    const videoBeforeRetry = posts.filter((p) => p.route === officialSchema.ROUTES.video).length;
    await service.confirm(retry.id, service.get(retry.id).previewRevision); await service.refresh(retry.id);
    await service.close(); service = createDigitalHumanService(options); services.push(service);
    for (let i = 0; i < 4 && service.get(retry.id).status !== 'needs_attention'; i += 1) await service.refresh(retry.id);
    assert.equal(service.get(retry.id).errorCode, 'digital_human_retry_exhausted');
    assert.equal(posts.filter((p) => p.route === officialSchema.ROUTES.video).length, videoBeforeRetry + 2);
    await assert.rejects(service.resume(retry.id), { code: 'digital_human_retry_exhausted' });
    assert.equal(service.isBusy(), false, 'Stopped cloud tasks cannot block updates forever.');
    await service.prepareForUpdate(); await assert.rejects(service.refresh(retry.id), { code: 'UPDATE_IN_PROGRESS' }); service.resumeAfterUpdate();
    console.log('digital-human audio self-check passed: original script duration, natural boundaries, frozen voice, expired URL reupload, receipt recovery, one persisted paid retry, update lifecycle');
  } finally {
    await Promise.allSettled(services.map((service) => service.close()));
    const resolved = path.resolve(directory);
    assert.ok(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('xiaoxi-avatar-audio-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
