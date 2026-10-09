const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createProductAudioPreparer } = require('./product-video-audio.cjs');
const { run, probe, assemblePreparedVideo, videoEncoderArgs } = require('./product-video-media.cjs');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoxi-audio-check-'));
  const ffmpegPath = process.env.XIAOXI_FFMPEG_PATH || 'ffmpeg';
  try {
    const speech = path.join(directory, 'fixture-voice.wav'), music = path.join(directory, 'fixture-music.wav');
    await run(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=550:duration=1', speech]);
    await run(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', music]);
    const provider = { download: async (_, file) => fs.copyFileSync(speech, file) };
    const ledger = new Map(); let submissions = 0;
    const operation = async (name, route, body, reserve) => {
      assert(route.includes('/bailian/')); assert(body.input.text); assert(reserve > 0);
      if (!ledger.has(name)) { submissions++; ledger.set(name, { output: { audio: { url: 'https://example.com/audio.wav' } } }); }
      return ledger.get(name);
    };
    const task = { durationSeconds: 4, prices: { ttsCnyPer10kChars: 0.8 }, plan: { shots: [{ seconds: 2, narration: '第一段。' }, { seconds: 2, narration: '第二段。' }] } };
    const selectMusic = async () => ({ file: music, sha256: createHash('sha256').update(fs.readFileSync(music)).digest('hex'), source: '离线音轨测试' });
    const params = { task, directory, ffmpegPath, operation };
    const prepared = await createProductAudioPreparer({ provider, selectMusic })(params);
    assert.equal(prepared.music.status, 'ready');
    assert.equal(submissions, 2);
    assert(Math.abs((await probe(prepared.file, ffmpegPath)).seconds - 4) < .05);
    assert.notEqual(prepared.sha256, createHash('sha256').update(fs.readFileSync(prepared.voiceFile)).digest('hex'));
    await createProductAudioPreparer({ provider, selectMusic })(params);
    assert.equal(submissions, 2, 'resume must reuse both frozen voices');
    const brokenMusic = path.join(directory, 'broken-music.wav'); fs.writeFileSync(brokenMusic, 'unreadable optional music');
    const fallback = await createProductAudioPreparer({ provider, selectMusic: async () => ({ file: brokenMusic }) })(params);
    assert.equal(fallback.music.status, 'unavailable'); assert.match(fallback.music.message, /无需重做视频/);
    assert.equal(fallback.sha256, createHash('sha256').update(fs.readFileSync(fallback.voiceFile)).digest('hex'));
    assert.equal(submissions, 2, 'A corrupt optional music file must preserve both frozen voices without another TTS request.');
    const source = path.join(directory, 'fixture.mp4');
    await run(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=144x256:rate=30:duration=2', '-an', ...await videoEncoderArgs(ffmpegPath), source]);
    const result = await assemblePreparedVideo({ shots: [{ path: source, seconds: 2 }, { path: source, seconds: 2 }], audioPath: prepared.file, destination: path.join(directory, 'result.mp4'), ffmpegPath });
    assert.equal(result.width, 720); assert.equal(result.height, 1280);
    assert(Math.abs(result.durationSeconds - 4) < .12);
    await assert.rejects(() => assemblePreparedVideo({ shots: [{ path: source, seconds: 3 }], audioPath: prepared.file, destination: path.join(directory, 'invalid.mp4'), ffmpegPath }), e => e.code === 'product_video_shot_too_short');
    console.log('product-video-audio self-check passed: frozen voices, continuous soundtrack, real 720p assembly and short-source rejection');
  } finally {
    if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('xiaoxi-audio-check-')) fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
