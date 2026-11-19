const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { normalizeAndAssemble, assemblePreparedVideo, extractAudio, buildCaptions, buildPlannedCaptions, renderCaptioned, videoEncoderArgs } = require('./product-video-media.cjs');

async function main() {
  assert.throws(() => buildCaptions({ utterances: [{ text: '计划台词不是字幕' }] }), { code: 'product_video_caption_timing_missing' });
  // Without word timings a long line is split over its own time span instead of failing (review, 2026-11-19).
  const untimed = buildCaptions({ utterances: [{ text: '较长的对白缺少实际词级时间不能随便拆分字幕的显示时间', start_time: 0, end_time: 6000 }] });
  assert.equal(untimed.cues.map((cue) => cue.text).join(''), '较长的对白缺少实际词级时间不能随便拆分字幕的显示时间');
  assert.ok(untimed.cues.length === 3 && untimed.cues[0].start === 0 && untimed.cues.at(-1).end === 6);
  const mismatched = buildCaptions({ utterances: [{ text: '这台CC1Pro一小时能洗1500平，自己回站加水。', start_time: 0, end_time: 5000, words: [{ text: '这台', start_time: 0, end_time: 300 }] }] });
  assert.ok(mismatched.cues.every((cue) => cue.lines.length === 1) && mismatched.cues.some((cue) => cue.text.includes('CC1Pro')) && mismatched.cues.some((cue) => cue.text.includes('1500')), 'model names and numbers are not cut');
  const text = '雨天带进来的泥脚印，机器经过以后，地面清洁轨迹清楚可见。';
  const words = Array.from(text).filter((char) => !/[，。]/u.test(char)).map((char, index) => ({ text: char, start_time: index * 150, end_time: (index + 1) * 150 }));
  const captions = buildCaptions({ utterances: [{ text, start_time: 0, end_time: words.at(-1).end_time, words }] });
  assert.equal(captions.cues.map((cue) => cue.text).join(''), text);
  assert(captions.cues.length >= 2);
  // One line per subtitle (2026-11-19): longer speech becomes more cues, never a second line.
  assert(captions.cues.every((cue) => cue.lines.length === 1 && Array.from(cue.lines[0]).length <= 10));
  assert(!captions.ass.includes('\\N'), 'no forced line break in the subtitle file');
  const planned = buildPlannedCaptions({ cues: [{ text: '自动上下水 不用人管', start: 0.3, end: 5.8 }, { text: '贴边清洁 不留死角', start: 6.3, end: 11.8 }], durationSeconds: 12 });
  assert.deepEqual(planned.cues.map((cue) => cue.lines), [['自动上下水 不用人管'], ['贴边清洁 不留死角']]);
  assert.throws(() => buildPlannedCaptions({ cues: [{ text: '这一行字幕写得太长太长了', start: 0, end: 2 }] }), { code: 'product_video_caption_too_long' });
  assert.throws(() => buildPlannedCaptions({ cues: [{ text: '一', start: 0, end: 3 }, { text: '二', start: 2, end: 4 }] }), { code: 'product_video_caption_overlap' });
  assert.equal(captions.cues[1].start * 1000 % 150, 0, 'split uses real word timing');
  const escaped = buildCaptions({ utterances: [{ text: '{\\pos(1,2)}字', start_time: 0, end_time: 1000 }] });
  assert(!escaped.ass.includes('{\\pos'));
  assert(!escaped.ass.includes('BorderStyle=3'));

  const ffmpegPath = process.env.XIAOXI_FFMPEG_PATH || 'ffmpeg';
  try { execFileSync(ffmpegPath, ['-version'], { windowsHide: true, stdio: 'ignore' }); }
  catch (error) {
    if (error.code !== 'ENOENT' || process.env.XIAOXI_FFMPEG_PATH) throw error;
    // Source-only CI does not install the separately packaged media runtime.
    process.stdout.write('product-video-media self-check passed (caption checks; FFmpeg integration not run: media runtime unavailable)\n');
    return;
  }

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxi-product-media-'));
  try {
    const encoder = await videoEncoderArgs(ffmpegPath);
    const clipA = path.join(temp, "输入'a.mp4"), clipB = path.join(temp, '输入b.mp4');
    for (const [file, shape, tone] of [[clipA, '360x640', 440], [clipB, '480x852', 660]]) {
      execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${shape}:rate=30:duration=0.5`,
        '-f', 'lavfi', '-i', `sine=frequency=${tone}:sample_rate=44100:duration=0.5`, ...encoder, '-pix_fmt', 'yuv420p', '-c:a', 'aac', file], { windowsHide: true });
    }
    const source = path.join(temp, '母版.mp4'), output = path.join(temp, '成片.mp4');
    const info = await normalizeAndAssemble({ shots: [{ path: clipA, seconds: 0.5 }, { path: clipB, seconds: 0.5 }], destination: source, ffmpegPath });
    assert(Math.abs(info.durationSeconds - 1) < 0.1);
    await assert.rejects(normalizeAndAssemble({ shots: [{ path: clipA, seconds: 2 }], destination: path.join(temp, '不能冻结补帧.mp4'), ffmpegPath }), { code: 'product_video_shot_too_short', shotIndex: 0 });
    const silent=path.join(temp,'无声.mp4');
    execFileSync(ffmpegPath,['-v','error','-i',clipB,'-map','0:v:0','-c:v','copy','-an',silent],{windowsHide:true});
    await assert.rejects(normalizeAndAssemble({shots:[{path:clipA,seconds:.5},{path:silent,seconds:.5}],destination:path.join(temp,'拒绝无声.mp4'),ffmpegPath}),{code:'product_video_native_audio_missing',shotIndex:1});
    const wav = path.join(temp, '原声.wav');
    await extractAudio({ source, destination: wav, ffmpegPath });
    const wavBytes = await fs.readFile(wav);
    assert.equal(wavBytes.toString('ascii', 0, 4), 'RIFF');
    await assert.rejects(extractAudio({source:silent,destination:wav,ffmpegPath}));
    assert.deepEqual(await fs.readFile(wav),wavBytes,'failed extraction never replaces a complete cached WAV');
    for (const [pipelineVersion, width, height] of [[4,480,854],[3,720,1280]]) {
      const assembled = await assemblePreparedVideo({task:{plan:{pipelineVersion}},shots:[{path:silent,seconds:.5},{path:silent,seconds:.5}],audioPath:wav,
        destination:path.join(temp,`prepared-${pipelineVersion}.mp4`),ffmpegPath});
      assert.equal(assembled.width,width); assert.equal(assembled.height,height);
      assert.ok(Math.abs(assembled.durationSeconds-1)<.12,'silent direct sources reuse the complete local soundtrack');
    }
    const result = await renderCaptioned({ source, destination: output, ffmpegPath,
      captions: buildCaptions({ utterances: [{ text: '清洁轨迹', start_time: 0, end_time: 800 }], durationSeconds: 1 }) });
    assert.equal(result.upscaleMethod, 'lanczos');
    assert((await fs.readFile(result.srtPath, 'utf8')).includes('清洁轨迹'));
    const audioHash = (file) => execFileSync(ffmpegPath, ['-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', '-'], { encoding: 'utf8', windowsHide: true }).trim();
    assert.equal(audioHash(source), audioHash(output), 'subtitle rendering retains native audio bytes');
    assert(!(await fs.readdir(temp)).some((entry) => entry.startsWith('.product-media-')), 'owned intermediate directories cleaned');
  } finally {
    const relative = path.relative(os.tmpdir(), temp);
    if (relative.startsWith('xiaoxi-product-media-') && !relative.includes(path.sep) && !path.isAbsolute(relative)) await fs.rm(temp, { recursive: true, force: true });
  }
  process.stdout.write('product-video-media self-check passed\n');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
