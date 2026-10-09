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
  assert.equal(audio.splitScript('先说第一件事。再说第二件事。最后说第三件事。', 45).length, 3);
  assert.throws(() => audio.assertSpeechCoverage({ seconds: 11, speechStart: .1, speechEnd: 10.9, maxGapSeconds: .2 }, 15), /尚未提交视频/);
  assert.throws(() => audio.verifyTranscript([{ text: '漏了后面', end_time: 14500 }], '漏了后面完整的一句话。', 15), /不一致/);
  const exact = '先看地面是否适合使用清洁机器人，再看现场需要清理什么污物，把现场情况发来一起安排合适的清洁方案。';
  assert.throws(() => audio.verifyTranscript([{ text: exact.replace('地面', '地棉'), start_time: 0, end_time: 14500 }], exact, 15), /不一致/, 'Even one substitution must stop before paid video; packaging needs exact anchors.');
  assert.throws(() => audio.verifyTranscript([{ text: 'CC1 Pro', start_time: 0, end_time: 14500 }], 'ＣＣ1 Pro', 15), /不一致/, 'Packaging does not normalize compatibility characters.');
  assert.equal(audio.verifyTranscript([{ text: 'CC1 PRO，地面清洁。', start_time: 0, end_time: 14500 }], 'cc1 pro：地面清洁！✨', 15).editDistance, 0);
  assert.throws(() => audio.verifyTranscript([{ text: '先看地面', start_time: 0, end_time: 8000 }, { text: '再看污物', start_time: 7900, end_time: 14500 }], '先看地面，再看污物。', 15), /重叠/);
  const pcm = Buffer.alloc(15 * 16000 * 2);
  for (let i = 1600; i < 14.5 * 16000; i += 1) pcm.writeInt16LE(Math.round(Math.sin(i / 15) * 10000), i * 2);
  const measured = audio.analyzePcm(pcm); audio.assertSpeechCoverage(measured, 15);
  assert.ok(measured.speechEnd >= 14.5 && measured.speechStart <= .12);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoxi-avatar-audio-'));
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const input = path.join(directory, 'input.png'); fs.writeFileSync(input, image);
  const posts = [], receipts = new Map(), services = [];
  let audioSeconds = 14.7, disconnectTts = false, lastText = [], packaging;
  const bytesFor = (destination) => { const bytes = Buffer.alloc(2048); bytes.write('ftyp', 4); return destination.endsWith('.mp4') ? bytes : destination.endsWith('.image') ? image : Buffer.from('frozen voice fixture'); };
  const download = async (_url, destination) => { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytesFor(destination)); };
  const request = async (route, options = {}) => {
    if (route.startsWith('/operations/')) return receipts.get(route.split('/').pop());
    if (options.method !== 'POST') {
      if (route.startsWith('/bailian/')) return { output: { task_status: 'SUCCEEDED', video_url: 'https://fixture.example.com/video.mp4' } };
      return { data: { status: 'completed', result: { images: [{ url: ['https://fixture.example.com/preview.png'] }] } } };
    }
    posts.push({ route, ...options }); let response;
    if (route.endsWith('/uploads/images')) response = { data: { url: 'https://fixture.example.com/image.png' } };
    else if (route.endsWith('/images/generations')) response = { data: [{ task_id: 'preview_task' }] };
    else if (route === officialSchema.ROUTES.tts) { lastText.push(options.body.input.text); response = { output: { audio: { url: 'https://fixture.example.com/voice.wav' } } }; }
    else if (route === officialSchema.ROUTES.video) response = { output: { task_id: `video_${posts.length}` } };
      else if (route.includes('/asr/')) {
        assert.equal(options.headers['X-Api-Request-Id'], options.operationId, 'ASR must use the persisted request UUID');
        response = { result: { utterances: lastText.map((text, index) => ({ text, start_time: index * 15000, end_time: (index + 1) * 15000 - 300 })) } };
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
    audioTools: {
      measureAudio: async ({ source }) => ({ seconds: audioSeconds, speechStart: .1, speechEnd: audioSeconds - .1, speechSeconds: audioSeconds - 1, maxGapSeconds: .3, sha256: hash(fs.readFileSync(source)) }),
      freezeAudio: async ({ destination }) => { fs.writeFileSync(destination, 'complete frozen voice'); return { sha256: hash(fs.readFileSync(destination)) }; },
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
    const short = service.create({ ...draft, durationSeconds: 15, script: '配音太短。' }); audioSeconds = 10;
    await service.preview(short.id); await service.refresh(short.id);
    assert.equal(service.get(short.id).errorCode, 'digital_human_audio_duration_mismatch');
    assert.equal(posts.filter((p) => p.route === officialSchema.ROUTES.video).length, 0);
    assert.equal(posts.filter((p) => p.route.endsWith('/images/generations')).length, 0, 'A short script stops before a paid scene preview too.');

    audioSeconds = 14.7; lastText = []; disconnectTts = true;
    const task = service.create({ ...draft, budgetCny: undefined }); await service.preview(task.id); await service.refresh(task.id);
    const automaticBudget = service.get(task.id).budgetCny;
    assert.ok(automaticBudget > 0 && automaticBudget <= 20, 'The omitted customer budget must freeze an internal complete quote.');
    const firstTtsCount = posts.filter((p) => p.route === officialSchema.ROUTES.tts).length;
    await service.close(); service = createDigitalHumanService(options); services.push(service);
    for (let i = 0; i < 8 && service.get(task.id).status !== 'preview_ready'; i += 1) await service.refresh(task.id);
    assert.equal(service.get(task.id).status, 'preview_ready');
    assert.equal(posts.filter((p) => p.route === officialSchema.ROUTES.tts).length, firstTtsCount + 2, 'A lost TTS response is recovered, never regenerated.');
    assert.equal(posts.filter((p) => p.route === officialSchema.ROUTES.video).length, 0);
    await service.confirm(task.id, service.get(task.id).previewRevision);
    for (let i = 0; i < 10 && service.get(task.id).status !== 'completed'; i += 1) await service.refresh(task.id);
    assert.equal(service.get(task.id).status, 'completed');
    const videoPosts = posts.filter((p) => p.route === officialSchema.ROUTES.video);
    assert.equal(videoPosts.length, 3); assert.ok(videoPosts.every((p) => p.body.parameters.duration === 15 && p.body.input.audio_url && p.body.parameters.audio));
    assert.equal(packaging.cover_mode, 'local_frame'); assert.equal(packaging.prepared_transcript.utterances.length, 3);
    assert.equal(packaging.prepared_transcript.source_sha256, hash(fs.readFileSync(packaging.input_video_path)));
    assert.ok(service.get(task.id).quote.reservedCny <= 20); assert.equal(service.get(task.id).quote.actualCny, null);
    assert.equal(service.get(task.id).budgetCny, automaticBudget, 'Preparation and generation must not silently grow the frozen budget.');
    assert.equal(JSON.stringify(service.get(task.id)).includes('https://fixture'), false);
    assert.equal(posts.filter((p) => p.route.includes('/asr/')).length, 1);
    assert.ok(posts.findIndex((p) => p.route.includes('/asr/')) < posts.findIndex((p) => p.route === officialSchema.ROUTES.video));
    lastText = [];
    const expired = service.create({ ...draft, durationSeconds: 15, script: '保留原音轨，不重复收费。' });
    await service.preview(expired.id); await service.refresh(expired.id);
    const recordPath = path.join(options.rootDir, expired.id, 'task.json'), record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    record.segments[0].audioExpiresAt = '2000-01-01T00:00:00.000Z'; fs.writeFileSync(recordPath, JSON.stringify(record));
    const paidBeforeExpiry = posts.length;
    await service.confirm(expired.id, service.get(expired.id).previewRevision); await service.refresh(expired.id);
    assert.equal(service.get(expired.id).errorCode, 'digital_human_audio_url_expired');
    assert.equal(posts.length, paidBeforeExpiry, 'An expired reference cannot silently trigger new TTS or video.');
    console.log('digital-human audio self-check passed: measured speech, no silent tail purchase, prepaid budget, frozen audio, pre-video transcript, lost receipt recovery, 45-second segmented generation');
  } finally {
    await Promise.allSettled(services.map((service) => service.close()));
    const resolved = path.resolve(directory);
    assert.ok(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('xiaoxi-avatar-audio-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
