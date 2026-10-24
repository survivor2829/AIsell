const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReferenceHumanService } = require('./reference-human-service.cjs');
const { sha256 } = require('./reference-human-media.cjs');
const { price } = require('../shared/reference-human.json');
const { normalizePoll, taskIdOf } = require('./bailian-video-provider.cjs');
const { createProviderGatewayClient } = require('./provider-gateway-client.cjs');
const { createAutomaticVoiceClient } = require('./automatic-voice-client.cjs');
const { createDigitalHumanProvider } = require('./digital-human-provider.cjs');
const { parseSpeechStream } = require('./speech-stream.cjs');
const costs = require('./reference-human-costs.cjs');
const packaging = require('../../remotion-packaging/narration-plan.cjs');

async function main() {
  const text = '先了解地面，再查看通道。', visual = { status: 'measured', union: { y: .2, bottom: .6 }, busy: false };
  assert.equal(packaging.choose({ script: '首先了解地面，然后检查通道，最后现场测试。' }).templateId, 'layered_v4');
  assert.equal(packaging.choose({ script: '先别比价格，不是越贵越好，而是看实际效果。' }).templateId, 'impact_v4');
  assert.equal(packaging.choose({ script: text }, { busy: true }).templateId, 'minimal_v4');
  const crowded = packaging.buildPlan({ script: text }, { ...visual, union: { y: .1, bottom: .84 } });
  assert.equal(crowded.blocked, true);
  const upper = packaging.buildPlan({ script: text }, { ...visual, union: { y: .32, bottom: .72 } }, [{ text, startMs: 0, endMs: 4000 }]);
  assert.equal(upper.layout.showTitle, false); assert.ok(upper.layout.bottom < .32 * 1920);
  const shortText = '工厂买洗地机先别比价格';
  const lower = packaging.buildPlan({ script: shortText, emphasisPhrases: ['先别比价格'] }, { ...visual, union: { y: .32, bottom: .7375 } },
    [{ text: shortText, startMs: 0, endMs: 3300, words: [...shortText].map((text, i) => ({ text, startMs: i * 300, endMs: (i + 1) * 300 })) }]);
  assert.equal(lower.blocked, false); assert.equal(lower.layout.bottom, 1660, 'short pages keep the lower safe region instead of jumping above the head');
  assert.equal(lower.layout.left + lower.layout.width / 2, 540); assert.equal(lower.layout.align, 'center');
  assert.equal(lower.pages[1].text, '先别比价格'); assert.equal(lower.pages[1].emphasisMode, 'inline', 'tight space keeps readable emphasis without growing onto the face');
  assert.ok(lower.layout.top >= Math.ceil(.7375 * 1920) + 80); packaging.validatePlan(lower, lower.templateId);
  const heading = packaging.buildPlan({ script: text, title: '工厂采购洗地机这些关键问题要注意，先试再谈价格', packagingMode: 'manual', captionStyleId: 'layered_v4' }, { ...visual, union: { y: 365 / 1920, bottom: .6 } });
  assert.equal(heading.layout.showTitle, false, 'long title height must also avoid the face');
  const long = packaging.buildPlan({ script: text.repeat(10) }, visual, [{ text: text.repeat(10), startMs: 0, endMs: 30000 }]);
  assert.equal(long.pages.length, 1, 'no invented word timing'); assert.equal(long.blocked, true);
  const muted = packaging.buildPlan({ script: text, soundEffects: false }, visual, [{ text, startMs: 0, endMs: 4000 }]);
  assert.deepEqual(muted.soundEvents, []);
  const measured = costs.estimate('工厂买洗地机。', 45, price, { imageUsd: .2109, estimatedImageUsd: .0085, fxCnyPerUsd: 8 });
  assert.equal(measured.coverCny, .068);
  assert.equal(measured.maximumCny - measured.minimumCny, 15 * (.08 + 4.5 / 3600));
  const unknownReceipt = { actualDurationSeconds: 29.6, operations: { voice: { reused: true, response: { usage: { characters: 264 } } }, video: { reserveCny: 2.37 } } };
  assert.deepEqual(costs.usage(unknownReceipt), { settledCny: null, audioSeconds: 29.6, voiceCharacters: 264, voiceReused: true,
    operations: [{ stage: 'voice', state: 'reused' }, { stage: 'video', state: 'unknown' }] });
  assert.equal(costs.estimate('旧任务', 45, { videoCnyPerSecond: .08 }), undefined, 'old prices must not acquire invented historical usage');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoxi-reference-check-'));
  const counts = { train: 0, voice: 0, video: 0, asr: 0, recover: 0, package: 0, enroll: 0, script: 0 };
  const enrollmentReceipts = new Map(); let loseEnrollmentReply = true;
  let voiceStatusQueries = 0, measuredSeconds = 3;
  let scriptReply = null;
  let interrupted = true, terminalFailure = false, musicAvailable = true, transcriptMismatch = false, service;
  const videoOperations = new Set();
  const source = path.join(root, 'input.mp4'), sound = path.join(root, 'prepared.wav');
  fs.writeFileSync(source, 'reference-fixture'); fs.writeFileSync(sound, 'voice-fixture');
  const utterances = [{ text: '测试口播。', start_time: 0, end_time: 3000 }];
  const options = {
    rootDir: root,
    readReferencePrices: async () => ({ ...price, checkedAt: new Date().toISOString() }),
    readCoverPrices: async () => ({ imageUsd: .2, fxCnyPerUsd: 8 }),
    getGeneratedVideo: async () => ({ cover_status: 'completed' }),
    generateCover: async () => {},
    referenceProvider: {
      capabilities: async () => ({ ready: true }), taskIdOf, normalizePoll,
      download: async (_, file) => fs.writeFileSync(file, 'video-result'),
      request: async (route, input) => {
        if (route.startsWith('/operations/')) { counts.recover++; return enrollmentReceipts.get(route.split('/').at(-1)) || { output: { task_id: 'original-task' } }; }
        if (route.endsWith('/customization')) {
          if (input.body.input.action === 'query_voice') return { output: { status: ++voiceStatusQueries === 1 ? 'DEPLOYING' : 'OK', target_model: 'cosyvoice-v3.5-flash' } };
          counts.enroll++;
          assert.equal(input.body.model, 'voice-enrollment');
          assert.equal(input.body.input.action, 'create_voice');
          assert.equal(input.body.input.target_model, 'cosyvoice-v3.5-flash');
          assert.equal(input.body.input.max_prompt_audio_length, undefined, 'use supplier default reference length; the old long-reference voice returned incomplete real narration');
          assert.ok(input.body.input.url.startsWith('oss://dashscope-instant/'));
          assert.equal(input.headers['X-DashScope-OssResourceResolve'], 'enable');
          const response = { output: { voice_id: 'cosyvoice-v3.5-flash-myvoice-fixture' } };
          enrollmentReceipts.set(input.operationId, response);
          if (loseEnrollmentReply) { loseEnrollmentReply = false; throw Object.assign(Error('enrollment connection lost'), { outcomeUnknown: true }); }
          return response;
        }
        if (route.endsWith('/SpeechSynthesizer')) {
          assert.ok(voiceStatusQueries >= 2, 'TTS must wait for voice approval');
          counts.voice++; assert.equal(input.body.model, 'cosyvoice-v3.5-flash');
          assert.equal(input.body.input.voice, 'cosyvoice-v3.5-flash-myvoice-fixture');
          assert.equal(Object.hasOwn(input.body.input, 'instruction'), false, 'default original delivery must omit the instruction field, matching the accepted voice');
          assert.equal(input.body.input.rate, 1);
          assert.equal(input.body.input.text, '测试口播。', 'delivery instructions never change the approved spoken script');
          return { output: { finish_reason: 'stop', audio: { url: 'https://example.com/voice.wav' } } };
        }
        if (route === '/narration/script-quota') return { quota: { status: 'available', remaining: 2 - counts.script } };
        if (route === '/narration/script') { counts.script++; assert.equal(input.timeoutMs, 420000, 'script wait covers one in-operation rewrite'); if (scriptReply) return scriptReply(); return { ok: true, title: '如何选', script: '测试口播。', emphasisPhrases: ['口播'], quota: { remaining: 1 } }; }
        if (route.includes('recognize')) { counts.asr++; return { result: { utterances } }; }
        if (route.includes('image2video')) {
          assert.ok(!videoOperations.has(input.operationId), 'a video operation may only be submitted once');
          videoOperations.add(input.operationId); counts.video++; assert.equal(input.body.parameters.video_extension, false);
          if (interrupted) { interrupted = false; throw Object.assign(new Error('connection lost'), { outcomeUnknown: true }); }
          return { output: { task_id: 'failed-cloud-task' } };
        }
        if (terminalFailure) return { output: { task_status: 'FAILED', code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' } };
        return { output: { task_status: 'SUCCEEDED', video_url: 'https://example.com/result.mp4' } };
      },
    },
    referenceMedia: {
      prepareReference: async (file, directory) => {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'reference.mp4'), 'managed-video');
        fs.writeFileSync(path.join(directory, 'voice.wav'), 'managed-audio');
        fs.writeFileSync(path.join(directory, 'poster.jpg'), 'poster');
        return { seconds: 60, width: 720, height: 1280, sourceSha256: sha256(fs.readFileSync(file)), videoSha256: sha256(Buffer.from('managed-video')), audioSha256: sha256(Buffer.from('managed-audio')) };
      },
      freezeDrivenVideo: async (_, __, file) => fs.writeFileSync(file, 'frozen-video'),
    },
    uploadReferenceMedia: async () => ({ url: 'oss://dashscope-instant/fixture', expiresAt: new Date(Date.now() + 3600000).toISOString() }),
    voiceCloneClient: {
      list: async () => ({ items: [{ speakerId: 'S_owned', slotType: 'prepaid', trainable: true }] }),
      train: async ({ operationId }) => { counts.train++; return { speakerId: 'S_owned', usable: true, operationId }; },
      synthesize: async () => { counts.voice++; return { file: sound, audio_digest: sha256(fs.readFileSync(sound)) }; },
    },
    audioTools: {
      createAsrCopy: async ({ destination }) => { fs.writeFileSync(destination, 'recognition-copy'); return { sha256: sha256(Buffer.from('recognition-copy')) }; },
      freezeAudio: async ({ destination }) => { fs.writeFileSync(destination, 'frozen-voice'); return { sha256: sha256(Buffer.from('frozen-voice')) }; },
      measureAudio: async () => ({ seconds: measuredSeconds, sha256: sha256(Buffer.from('frozen-voice')) }),
      verifyTranscript: () => { if (transcriptMismatch) throw Object.assign(Error('incomplete narration'), { code: 'digital_human_transcript_mismatch' }); return { alignedUtterances: utterances }; },
    },
    analyzeNarration: async () => ({ status: 'measured', coverage: 1, union: { y: .2, bottom: .6 }, busy: false }),
    selectMusic: async () => musicAvailable ? { trackId: 'music_track_owned' } : { status: 'unavailable' },
    packageVideo: async (payload) => { counts.package++; assert.ok(['moving_pill', 'layered_v1', 'layered_v2', 'layered_v3', 'layered_v4', 'impact_v4', 'minimal_v4'].includes(payload.caption_style_id)); assert.equal(payload.audio_profile, 'narration_v2'); assert.equal(payload.cover_mode, 'local_frame'); assert.equal(payload.music_track_id, 'music_track_owned'); return { task_id: 'packaging-1' }; },
    queryPackaging: async () => ({ status: 'completed', result: { generated_video_id: 'generated_video_test' } }),
  };
  try {
    service = createReferenceHumanService(options);
    const asset = await service.importVideo(source);
    assert.equal((await service.importVideo(source)).id, asset.id, 'same reference is reused');
    assert.equal(service.assets().items.length, 1, 'directory and metadata must not duplicate assets');
    const draft = service.create({ referenceAssetId: asset.id, script: '测试口播。', captionStyleId: 'moving_pill' });
    await assert.rejects(service.prepare(draft.id, 'not-confirmed'), { code: 'reference_quote_confirmation_required' });
    assert.equal(counts.voice + counts.video + counts.asr, 0, 'draft and price inspection cannot call paid services');
    const analyzer = options.analyzeNarration;
    options.analyzeNarration = async () => ({ ...visual, union: { y: .1, bottom: .84 } });
    const blocked = service.create({ referenceAssetId: asset.id, script: '测试口播。' });
    await assert.rejects(service.quote(blocked.id), { code: 'reference_layout_crowded' });
    assert.equal(counts.voice + counts.video + counts.asr, 0, 'crowded framing stops before paid requests');
    options.analyzeNarration = analyzer;
    await service.trainVoice({ assetId: asset.id, speakerId: 'S_owned', customerConsent: true });
    const quoted = await service.quote(draft.id);
    musicAvailable = false;
    await assert.rejects(service.prepare(draft.id, quoted.quoteRevision), { code: 'reference_music_not_ready' });
    const staleMusicDraft = service.create({ referenceAssetId: asset.id, script: '测试口播。', musicTrackId: 'music_track_removed' });
    const staleMusicQuote = await service.quote(staleMusicDraft.id);
    await assert.rejects(service.prepare(staleMusicDraft.id, staleMusicQuote.quoteRevision), { code: 'reference_music_not_ready' });
    assert.equal(counts.voice + counts.video + counts.asr, 0, 'missing music stops before paid preparation');
    musicAvailable = true;
    await service.prepare(draft.id, quoted.quoteRevision);
    while (service.isBusy()) await new Promise((resolve) => setTimeout(resolve, 5));
    const preview = service.get(draft.id); assert.equal(preview.status, 'preview_ready');
    await assert.rejects(service.confirm(draft.id, 'old-preview'), { code: 'reference_confirmation_required' });
    await service.confirm(draft.id, preview.previewRevision);
    while (service.isBusy()) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(service.get(draft.id).status, 'outcome_unknown');
    assert.match(service.get(draft.id).error, /connection lost/u, 'terminal error must not be cleared by transition');
    await service.close();
    service = createReferenceHumanService(options);
    await service.refresh(draft.id);
    assert.equal(service.get(draft.id).status, 'completed');
    assert.equal(counts.video, 1, 'restart recovers original receipt, never reposts');
    assert.equal(counts.voice, 1, 'restart reuses paid audio');
    assert.equal(counts.asr, 1); assert.equal(counts.recover, 1); assert.equal(counts.package, 1);
    terminalFailure = true;
    const failing = service.create({ referenceAssetId: asset.id, script: '测试口播。', captionStyleId: 'bold_yellow' });
    const failureQuote = await service.quote(failing.id);
    await service.prepare(failing.id, failureQuote.quoteRevision);
    while (service.isBusy()) await new Promise((resolve) => setTimeout(resolve, 5));
    await service.confirm(failing.id, service.get(failing.id).previewRevision);
    while (service.isBusy()) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(service.get(failing.id).status, 'needs_attention');
    assert.match(service.get(failing.id).error, /DataInspectionFailed/u);
    assert.equal(service.get(failing.id).videoFailure.code, 'DataInspectionFailed');
    const failedPath = path.join(root, 'reference', 'tasks', `${failing.id}.json`);
    const failedRecord = JSON.parse(fs.readFileSync(failedPath)); delete failedRecord.videoFailure;
    fs.writeFileSync(failedPath, JSON.stringify(failedRecord));
    const callsBeforeRefresh = counts.video;
    await service.refresh(failing.id);
    assert.equal(service.get(failing.id).videoFailure.code, 'DataInspectionFailed');
    assert.equal(counts.video, callsBeforeRefresh, 'terminal failure details use GET only');
    assert.equal(service.get(failing.id).canResume, false);
    assert.equal(counts.video, 2, 'one POST per explicitly approved task, no automatic retry');
    const newSource = path.join(root, 'new-person.mp4'); fs.writeFileSync(newSource, 'new reference');
    const automaticAsset = await service.importVideo(newSource);
    const automaticDraft = service.create({ referenceAssetId: automaticAsset.id, script: '测试口播。' });
    const automaticQuote = await service.quote(automaticDraft.id);
    assert.equal(automaticQuote.quote.enrollmentReserveCny, 0);
    await assert.rejects(service.prepare(automaticDraft.id, automaticQuote.quoteRevision), { code: 'voice_clone_consent_required' });
    assert.equal(counts.enroll, 0);
    await service.prepare(automaticDraft.id, automaticQuote.quoteRevision, true);
    while (service.isBusy()) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(service.get(automaticDraft.id).status, 'outcome_unknown');
    await service.close(); service = createReferenceHumanService(options);
    await service.refresh(automaticDraft.id);
    assert.equal(service.get(automaticDraft.id).status, 'preview_ready');
    assert.equal(counts.enroll, 1, 'restart must recover the original voice without another enrollment');
    const savedPerson = service.assets().items.find((a) => a.id === automaticAsset.id);
    assert.equal(savedPerson.voice.usable, true); assert.equal(savedPerson.voice.voiceId, undefined, 'provider ID stays behind the main process');
    const nextDraft = service.create({ referenceAssetId: automaticAsset.id, script: '测试口播。', captionStyleId: 'moving_pill' });
    const nextQuote = await service.quote(nextDraft.id); assert.equal(nextQuote.quote.enrollmentReserveCny, 0);
    terminalFailure = false;
    await service.prepare(nextDraft.id, nextQuote.quoteRevision, true, true);
    while (service.isBusy()) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(service.get(nextDraft.id).status, 'completed', 'one confirmed generation continues through video and packaging'); assert.equal(counts.enroll, 1, 'next narration reuses the person voice');
    const paidBeforeRepackage = { voice: counts.voice, asr: counts.asr, video: counts.video };
    const restyled = await service.repackage(nextDraft.id, { captionStyleId: 'layered_v1', emphasisPhrases: ['口播'] });
    while (service.isBusy()) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(service.get(restyled.id).status, 'completed');
    assert.notEqual(restyled.id, nextDraft.id);
    assert.equal(service.get(nextDraft.id).captionStyleId, 'moving_pill', 'restyling preserves the original history');
    assert.deepEqual({ voice: counts.voice, asr: counts.asr, video: counts.video }, paidBeforeRepackage, 'local restyling must never repeat cloud work');
    let cycled = nextDraft;
    for (const style of ['layered_v4', 'impact_v4', 'minimal_v4', 'layered_v4']) {
      cycled = await service.repackage(cycled.id, { nextStyle: true });
      while (service.isBusy()) await new Promise(resolve => setTimeout(resolve, 5));
      cycled = service.get(cycled.id);
      assert.equal(cycled.status, 'completed'); assert.equal(cycled.captionStyleId, style);
      assert.equal(cycled.includeCover, false, 'changing style cannot purchase a cover');
      assert.deepEqual(cycled.packagingPlan, service.get(cycled.id).packagingPlan, 'saved plan is deterministic');
    }
    assert.deepEqual({ voice: counts.voice, asr: counts.asr, video: counts.video }, paidBeforeRepackage);
    await assert.rejects(service.repackage(nextDraft.id, { captionStyleId: 'impact_v1', emphasisPhrases: ['虚构卖点'] }), { code: 'reference_emphasis_invalid' });
    let coverState = '', coverCalls = [];
    options.getGeneratedVideo = async () => ({ cover_status: coverState });
    options.readCoverPrices = async () => ({ imageUsd: .2, fxCnyPerUsd: 8 });
    options.generateCover = async (id, design, control) => { coverCalls.push({ id, design, control }); };
    const coverDesign = { title: '测试口播', style: 'paper', frameSeconds: 1 };
    const coverQuote = await service.coverQuote(nextDraft.id, coverDesign);
    await assert.rejects(service.generateCover(nextDraft.id, 'stale-quote'), { code: 'reference_cover_confirmation_required' });
    await service.generateCover(nextDraft.id, coverQuote.coverQuote.revision);
    await service.generateCover(nextDraft.id, undefined, true);
    assert.equal(coverCalls[1].control.recoverOnly, true, 'query must pass the non-purchasing boundary to the sidecar');
    coverState = 'planned';
    const refreshedCoverQuote = await service.coverQuote(nextDraft.id, coverDesign);
    await service.generateCover(nextDraft.id, refreshedCoverQuote.coverQuote.revision);
    assert.equal(coverCalls[0].design.request_id, coverCalls[2].design.request_id, 'explicit continuation after local preparation failure reuses the original request');
    coverState = 'submitted';
    await assert.rejects(service.coverQuote(nextDraft.id, coverDesign), { code: 'reference_cover_pending' });
    const scriptInput = { referenceAssetId: automaticAsset.id, industry: '清洁设备', business: '实际产品资料' };
    const referenceSource = { platform: 'manual', title: '选型参考', body: '选型要看地面', url: '' };
    const [scriptA, scriptB] = await Promise.all([
      service.writeScript({ ...scriptInput, referenceSource: { ...referenceSource, collectedAt: '2026-10-15T00:00:00Z' } }),
      service.writeScript({ ...scriptInput, referenceSource: { ...referenceSource, collectedAt: '2026-10-15T00:01:00Z', metrics: { likes: 2 } } }),
    ]);
    assert.deepEqual(scriptA, scriptB); assert.equal(counts.script, 1, 'same brief reuses its script receipt');
    assert.equal(scriptA.originality.passed, true, 'a reference-based script carries its originality check');
    counts.script++;
    const replayedScript = await service.writeScript({ ...scriptInput, referenceSource });
    assert.equal(replayedScript.quota.remaining, 0, 'a replay refreshes quota instead of restoring its old receipt balance');
    assert.equal(counts.script, 2, 'quota refresh never sends another writing request');
    const intent = 'e57a06f7-700d-44ca-8a13-6707c58683ac';
    await Promise.all([service.writeScript({ ...scriptInput, generationIntentId: intent }), service.writeScript({ ...scriptInput, generationIntentId: intent })]);
    assert.equal(counts.script, 3, 'explicit new direction creates exactly one new operation');
    await service.writeScript({ ...scriptInput, generationIntentId: intent, recoverOnly: true });
    assert.equal(counts.script, 3, 'recover only must replay, even when quota is exhausted');
    await assert.rejects(service.writeScript({ ...scriptInput, business: '变更', generationIntentId: intent }), { code: 'reference_script_intent_changed' });
    await assert.rejects(service.writeScript({ ...scriptInput, generationIntentId: 'e57a06f7-700d-44ca-8a13-6707c58683ad', recoverOnly: true }), { code: 'reference_script_not_submitted' });
    assert.equal(counts.script, 3, 'missing receipt never becomes a paid retry');
    const linkIntent = 'e57a06f7-700d-44ca-8a13-6707c58683ae';
    const linkInput = { ...scriptInput, generationIntentId: linkIntent, referenceSource: { platform: 'xiaohongshu', title: '选型参考', url: 'https://www.xiaohongshu.com/explore/test', body: '' } };
    let reads = 0;
    const linkOptions = { ...options, narrationSources: { validateReference: require('./narration-sources.cjs').validateReference, read: async () => { reads++; return { ...linkInput.referenceSource, body: '实际取得的参考正文' }; }, close: async () => {} } };
    const linkService = createReferenceHumanService(linkOptions);
    await linkService.writeScript(linkInput);
    await linkService.close();
    const offlineService = createReferenceHumanService({ ...linkOptions, narrationSources: { ...linkOptions.narrationSources, read: async () => { throw Error('browser offline'); } } });
    await offlineService.writeScript({ ...linkInput, recoverOnly: true });
    assert.equal(reads, 1, 'recovery must not reopen the platform or refetch mutable source text');
    assert.equal(counts.script, 4, 'offline recovery does not buy another script');
    await offlineService.close();
    const originalBytes = fs.readFileSync(path.join(root, 'reference/tasks', nextDraft.id + '.json'));
    const remake = service.create({ referenceAssetId: automaticAsset.id, script: '改稿重做', remakeOfTaskId: nextDraft.id });
    assert.equal(remake.remakeOfTaskId, nextDraft.id); assert.equal(remake.sourceTaskId, undefined);
    assert.equal(remake.quoteRevision, undefined); assert.equal(remake.audioPrepared, false);
    assert.deepEqual(fs.readFileSync(path.join(root, 'reference/tasks', nextDraft.id + '.json')), originalBytes, 'remake preserves original receipt and media pointers');
    const workspace = { preferences: { referenceAssetId: automaticAsset.id, captionStyleId: 'impact_v3' }, draft: { referenceAssetId: automaticAsset.id, script: '未完成草稿' }, pendingScript: { ...scriptInput, generationIntentId: intent } };
    service.saveWorkspace(workspace);
    const reopened = createReferenceHumanService(options);
    assert.deepEqual(reopened.workspace(), workspace, 'preferences and input survive service restart');
    await reopened.writeScript({ ...scriptInput, generationIntentId: intent, recoverOnly: true });
    assert.equal(counts.script, 4, 'restart recovery reuses original receipt');
    await reopened.close();
    // 仿写稿原创度：旧版云端照抄也能标出来；云端两次都不达标时停下，不重发、不再扣额度
    const viral = { platform: 'douyin', title: '物业经理别再招保洁了', body: '物业经理千万别再招保洁了，一台洗地机顶六个人，一年省下二十万人工', url: '' };
    scriptReply = () => ({ ok: true, title: '照抄', script: '物业经理千万别再招保洁了，一台洗地机顶六个人。', emphasisPhrases: [], structure: [{ part: '钩子', method: '反常识开头' }] });
    const copiedScript = await service.writeScript({ ...scriptInput, referenceSource: viral, generationIntentId: 'e57a06f7-700d-44ca-8a13-6707c58683b1' });
    assert.equal(copiedScript.originality.passed, false);
    assert.deepEqual(copiedScript.structure, [{ part: '钩子', method: '反常识开头' }]);
    scriptReply = () => { throw Object.assign(new Error('服务未完成请求：script_not_original'), { code: 'digital_human_provider_error', status: 422, outcomeUnknown: false }); };
    const rejectedIntent = 'e57a06f7-700d-44ca-8a13-6707c58683b2', before = counts.script;
    await assert.rejects(service.writeScript({ ...scriptInput, referenceSource: viral, generationIntentId: rejectedIntent }), /这条不适合仿写/);
    await assert.rejects(service.writeScript({ ...scriptInput, referenceSource: viral, generationIntentId: rejectedIntent }), { code: 'reference_script_rejected' });
    assert.equal(counts.script, before + 1, 'an unoriginal result is never re-posted');
    scriptReply = null;
    const personPath = path.join(root, 'reference', 'assets', `${automaticAsset.id}.json`);
    const person = JSON.parse(fs.readFileSync(personPath));
    fs.writeFileSync(personPath, JSON.stringify({ ...person, seconds: 21.6 }));
    const shortDraft = service.create({ referenceAssetId: automaticAsset.id, script: '测试口播。' });
    const shortQuote = await service.quote(shortDraft.id);
    assert.equal(shortQuote.quote.maximumSeconds, 21.6, 'quote follows the source instead of a fixed 45 seconds');
    await service.prepare(shortDraft.id, shortQuote.quoteRevision, true, true);
    while (service.isBusy()) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(service.get(shortDraft.id).status, 'completed');
    measuredSeconds = 22;
    const tooLong = service.create({ referenceAssetId: automaticAsset.id, script: '测试口播。' });
    const tooLongQuote = await service.quote(tooLong.id), videoBeforeLong = counts.video, asrBeforeLong = counts.asr;
    await service.prepare(tooLong.id, tooLongQuote.quoteRevision, true, true);
    while (service.isBusy()) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(service.get(tooLong.id).errorCode, 'reference_audio_too_long');
    assert.equal(service.get(tooLong.id).audioAvailable, true);
    assert.equal(counts.video, videoBeforeLong); assert.equal(counts.asr, asrBeforeLong);
    measuredSeconds = 3;
    const legacyDraft = service.create({ referenceAssetId: automaticAsset.id, script: '测试口播。' });
    const legacyPath = path.join(root, 'reference', 'tasks', `${legacyDraft.id}.json`);
    fs.writeFileSync(legacyPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(legacyPath)), version: 4 }));
    assert.equal((await service.quote(legacyDraft.id)).quote.maximumSeconds, 45, 'legacy quote rules remain unchanged');
    for (const seconds of [14.9, 15, 20, 40, 60]) {
      fs.writeFileSync(personPath, JSON.stringify({ ...person, seconds }));
      const item = service.create({ referenceAssetId: automaticAsset.id, script: '测试口播。' });
      const q = await service.quote(item.id);
      assert.equal(q.quote.maximumSeconds, seconds);
      if (seconds < 15) {
        const before = JSON.stringify(counts);
        await assert.rejects(service.prepare(item.id, q.quoteRevision, true, true), { code: 'reference_video_short' });
        assert.equal(JSON.stringify(counts), before, 'under 15 seconds stops before cloud calls');
      }
    }
    fs.writeFileSync(personPath, JSON.stringify(person));
    coverState = 'planned'; coverCalls = [];
    const joint = service.create({ referenceAssetId: automaticAsset.id, script: '测试口播。' });
    const jointQuote = await service.quote(joint.id);
    assert.equal(jointQuote.quote.schemaVersion, 3); assert.equal(jointQuote.quote.maximumSeconds, person.seconds);
    await service.prepare(joint.id, jointQuote.quoteRevision, true, true);
    while (service.isBusy()) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(service.get(joint.id).status, 'completed'); assert.equal(service.get(joint.id).autoCoverState, 'planned');
    assert.equal(coverCalls.length, 1);
    await service.close(); service = createReferenceHumanService(options);
    await service.refresh(joint.id);
    assert.equal(coverCalls.length, 1, 'queued cover survives restart without resubmission or false failure');
    coverState = 'completed'; await service.refresh(joint.id);
    assert.equal(coverCalls.length, 2); assert.equal(coverCalls[1].control.recoverOnly, true);
    assert.equal(coverCalls[0].design.request_id, coverCalls[1].design.request_id);
    assert.equal(service.get(joint.id).autoCoverState, 'completed');
    transcriptMismatch = true;
    const incomplete = service.create({ referenceAssetId: automaticAsset.id, script: '测试口播。' });
    const incompleteQuote = await service.quote(incomplete.id), videosBeforeMismatch = counts.video;
    await service.prepare(incomplete.id, incompleteQuote.quoteRevision, true, true);
    while (service.isBusy()) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(service.get(incomplete.id).canResume, false, 'cached incomplete narration cannot be fixed by continuing');
    assert.equal(service.get(incomplete.id).audioAvailable, true, 'failed narration remains available for listening');
    await assert.rejects(service.resume(incomplete.id), { code: 'reference_resume_invalid' });
    assert.equal(counts.video, videosBeforeMismatch, 'incomplete narration never purchases a video');
    transcriptMismatch = false;
    const gateway = createProviderGatewayClient({ config: { enabled: true, origin: 'https://example.com', blockPaidCalls: true }, requestImpl: () => { throw Error('network must not run'); } });
    await assert.rejects(gateway.fetch(gateway.url('/bailian/api/v1/services/aigc/image2video/video-synthesis'), { method: 'POST', body: '{}' }), { code: 'PAID_CALLS_DISABLED' });
    await gateway.close();
    let replayMode = 'lost', enrollmentPosts = 0;
    const recoveryProvider = createDigitalHumanProvider({ gatewayClient: {
      url: (route) => route,
      fetch: async (_route, input) => {
        if (input.method === 'POST' && JSON.parse(input.body).input?.action === 'query_voice') return { ok: true, json: async () => ({ output: { status: 'OK', target_model: 'cosyvoice-v3.5-flash' } }) };
        if (input.method === 'POST') {
          enrollmentPosts++;
          if (enrollmentPosts === 1) throw Error('reply lost');
          return { ok: true, json: async () => ({ output: { voice_id: 'cosyvoice-v3.5-flash-recovered' } }) };
        }
        return replayMode === 'lost'
          ? { ok: false, status: 404, json: async () => ({ error: 'receipt_not_found' }) }
          : { ok: false, status: 403, json: async () => ({ code: 'AccessDenied', request_id: 'original-rejected-request', message: 'model permission missing' }) };
      },
    } });
    const recoveryClient = createAutomaticVoiceClient({ provider: recoveryProvider, rootDir: path.join(root, 'recovery-voices'), uploadSample: options.uploadReferenceMedia });
    const enrollment = { assetId: automaticAsset.id, audioFile: sound, audioSha256: sha256(fs.readFileSync(sound)), operationId: 'first-confirmed-request' };
    await assert.rejects(recoveryClient.enroll(enrollment), { outcomeUnknown: true });
    await assert.rejects(recoveryClient.enroll(enrollment), { outcomeUnknown: true });
    assert.equal(enrollmentPosts, 1, 'missing receipt cannot permit a second purchase');
    replayMode = 'rejected';
    await assert.rejects(recoveryClient.enroll(enrollment), { originalRequestRejected: true, outcomeUnknown: false });
    await assert.rejects(recoveryClient.enroll(enrollment), { code: 'reference_voice_rejected' });
    const recoveredVoice = await recoveryClient.enroll({ ...enrollment, operationId: 'new-explicit-confirmation' });
    assert.equal(recoveredVoice.usable, true); assert.equal(enrollmentPosts, 2, 'only new explicit confirmation can replace a rejected enrollment');
    const speechEvents = ['first sentence', 'second sentence', 'last sentence'].map((part) => `data: ${JSON.stringify({ output: { audio: { data: Buffer.from(part).toString('base64') } } })}\n\n`).join('')
      + 'data: {"output":{"finish_reason":"stop"},"usage":{"characters":12}}\n\n';
    const streamProvider = createDigitalHumanProvider({ gatewayClient: { url: (route) => route, fetch: async () => ({ ok: true, headers: { 'content-type': 'text/event-stream' }, text: async () => speechEvents }) } });
    const fullSpeech = await streamProvider.request('/operations/original-stream');
    assert.equal(Buffer.from(fullSpeech.output.audio.data, 'base64').toString(), 'first sentencesecond sentencelast sentence', 'receipt recovery must retain every sentence');
    const fullFile = path.join(root, 'streamed.wav'); await recoveryClient.materialize(fullSpeech, fullFile);
    assert.equal(fs.readFileSync(fullFile, 'utf8'), 'first sentencesecond sentencelast sentence');
    assert.throws(() => parseSpeechStream(speechEvents.split('data: {"output":{"finish_reason"')[0]), { outcomeUnknown: true }, 'partial speech cannot be accepted as complete');
    assert.equal(fs.readFileSync(source, 'utf8'), 'reference-fixture');
    console.log('reference-human self-check passed: automatic voice consent/budget, enrollment interruption/restart/reuse, script receipt, legacy tasks, captions/music/cover');
  } finally {
    await service?.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
