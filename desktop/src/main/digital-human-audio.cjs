const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { pinyin } = require('pinyin-pro');
const { fail } = require('./digital-human-provider.cjs');
const { videoEncoderArgs } = require('./product-video-media.cjs');

const VOICE_IDS = Object.freeze({ natural_female: 'Cherry', steady_male: 'Ethan', lively: 'Serena' });
const MAX_TAIL_SECONDS = .9;
const RATE = 16000;
function run(binary, args, { binaryOutput = false, cwd, maxOutputBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20 * 60_000 });
    const buffers = []; let bytes = 0, error = '';
    child.stdout.on('data', (chunk) => { bytes += chunk.length; if (bytes > maxOutputBytes) child.kill(); else buffers.push(chunk); });
    child.stderr.on('data', (chunk) => { error = (error + chunk).slice(-3000); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(binaryOutput ? Buffer.concat(buffers) : Buffer.concat(buffers).toString('utf8'))
      : reject(fail('digital_human_media_failed', `本地音画处理未完成（退出码 ${code ?? 'unknown'}），原素材已保留。`, { diagnostic: error })));
  });
}
function splitScript(script, durationSeconds) {
  if (![15, 30, 45].includes(durationSeconds)) throw fail('digital_human_duration_invalid', '请选择15、30或45秒。');
  const text = String(script || '').trim(), count = durationSeconds / 15;
  if (!text) throw fail('digital_human_script_required', '请先填写完整口播文案。');
  // Character balance only chooses a preparation boundary. Actual audio, never
  // this text estimate, decides whether a paid video may be submitted.
  const chars = Array.from(text), segments = []; let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const remaining = count - index;
    let end = chars.length;
    if (remaining > 1) {
      const target = cursor + Math.round((chars.length - cursor) / remaining);
      const candidates = [];
      for (let i = cursor + 1; i < chars.length - remaining + 1; i += 1) {
        if (/[。！？；，、,.!?;\s]/u.test(chars[i - 1])) candidates.push(i);
      }
      const nearby = candidates.filter((i) => Math.abs(i - target) <= Math.max(4, (target - cursor) * .35));
      end = nearby.length ? nearby.reduce((best, i) => Math.abs(i - target) < Math.abs(best - target) ? i : best) : target;
      // Do not cut Latin identifiers or numbers in half.
      while (end < chars.length - remaining + 1 && /[\p{Script=Latin}\d]/u.test(chars[end - 1] || '') && /[\p{Script=Latin}\d]/u.test(chars[end] || '')) end += 1;
    }
    const segmentText = chars.slice(cursor, end).join('').trim(); cursor = end;
    if (!segmentText || segmentText.length > 600) throw fail('digital_human_script_segment_invalid', '请按自然语句整理文案，每段不超过600字。');
    segments.push({ id: `speech_${index + 1}`, text: segmentText, seconds: 15, status: 'planned' });
  }
  return segments;
}
// Split only for the TTS text limit. A requested duration must never delete,
// rewrite or force a speaking rate onto the customer's original script.
function speechChunks(script) {
  const chars = Array.from(String(script || '').trim()), result = [];
  if (!chars.length) throw fail('digital_human_script_required', '请先填写完整口播文案。');
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + 600, chars.length);
    if (end < chars.length) {
      for (let i = end; i > start + 300; i -= 1) {
        if (/[。！？；，,.!?;\s]/u.test(chars[i - 1])) { end = i; break; }
      }
    }
    result.push({ id: `speech_${result.length + 1}`, text: chars.slice(start, end).join(''), status: 'planned' });
    start = end;
  }
  return result;
}
function splitMeasuredSpeech(utterances, seconds) {
  if (!Number.isFinite(seconds) || seconds < 2) throw fail('digital_human_audio_too_short', '完整口播不足2秒，请补充完整表达；原音轨已保存。');
  const words = utterances.flatMap((item) => Array.isArray(item.words) && item.words.length ? item.words : [item]);
  const boundaries = new Map([[0, 0], [seconds, 0]]), sentenceEnds = new Set(utterances.map((item) => item.end_time));
  for (let i = 0; i < words.length - 1; i += 1) {
    const end = Number(words[i].end_time) / 1000, next = Number(words[i + 1].start_time) / 1000;
    if (Number.isFinite(end) && Number.isFinite(next) && next >= end) {
      const natural = sentenceEnds.has(words[i].end_time) || /[。！？；，,.!?;]$/u.test(String(words[i].text || ''));
      boundaries.set(Math.round((end + next) * 500) / 1000, natural ? 0 : next - end >= .12 ? .2 : 1);
    }
  }
  const candidates = [...boundaries.keys()].sort((a, b) => a - b), route = new Map([[seconds, { ends: [], penalty: 0 }]]);
  // Work backwards so a short last fragment cannot be stranded. Boundaries
  // come from timed words/sentences, never an arbitrary cut through speech.
  for (let i = candidates.length - 2; i >= 0; i -= 1) {
    const start = candidates[i]; let best;
    for (let j = i + 1; j < candidates.length && candidates[j] - start <= 15.001; j += 1) {
      const end = candidates[j], tail = route.get(end);
      if (end - start < 2 || !tail) continue;
      const proposed = { ends: [end, ...tail.ends], penalty: boundaries.get(end) + tail.penalty };
      if (!best || proposed.ends.length < best.ends.length || (proposed.ends.length === best.ends.length && proposed.penalty <= best.penalty)) best = proposed;
    }
    if (best) route.set(start, best);
  }
  if (!route.has(0)) throw fail('digital_human_audio_boundary_missing', '口播缺少可用的自然分段时间，请先核对声音；尚未提交视频。');
  let start = 0;
  return route.get(0).ends.map((end, index) => {
    const segment = { id: `clip_${index + 1}`, startSeconds: start, seconds: Math.round((end - start) * 1000) / 1000,
      generationSeconds: Math.min(15, Math.ceil(end - start - .001)),
      text: words.filter((word) => Number(word.end_time) > start * 1000 && Number(word.start_time) < end * 1000).map((word) => word.text || '').join(''), status: 'planned' };
    start = end; return segment;
  });
}
function analyzePcm(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length < RATE) throw fail('digital_human_audio_invalid', '配音结果过短或无法读取。');
  const samples = Math.floor(pcm.length / 2), block = Math.round(RATE * .02), frames = [];
  for (let i = 0; i < samples; i += block) {
    let sum = 0; const size = Math.min(block, samples - i);
    for (let j = 0; j < size; j += 1) { const v = pcm.readInt16LE((i + j) * 2) / 32768; sum += v * v; }
    frames.push(Math.sqrt(sum / size));
  }
  const peak = frames.reduce((highest, value) => Math.max(highest, value), 0), threshold = Math.max(.001, peak * .025);
  const active = frames.map((value) => value >= threshold);
  const first = active.indexOf(true), last = active.lastIndexOf(true);
  if (peak < .003 || first < 0) throw fail('digital_human_audio_silent', '配音结果没有可用的人声，尚未提交视频。');
  let maxGap = 0, gap = 0;
  for (let i = first; i <= last; i += 1) { gap = active[i] ? 0 : gap + .02; maxGap = Math.max(maxGap, gap); }
  return { seconds: samples / RATE, speechStart: first * .02, speechEnd: Math.min(samples / RATE, (last + 1) * .02),
    speechSeconds: active.filter(Boolean).length * .02, maxGapSeconds: maxGap };
}
async function measureAudio({ source, ffmpegPath = 'ffmpeg' }) {
  // Full original scripts may exceed the old 262-second PCM buffer limit.
  const pcm = await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', path.resolve(source), '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], { binaryOutput: true, maxOutputBytes: 64 * 1024 * 1024 });
  return { ...analyzePcm(pcm), sha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex') };
}
function assertSpeechCoverage(audio, seconds, index = 0) {
  if (!audio || !Number.isFinite(audio.seconds) || audio.seconds < 1.99 || audio.seconds > seconds + .08
    || audio.speechStart > .8 || audio.speechEnd < seconds - MAX_TAIL_SECONDS || audio.maxGapSeconds > 1.5) {
    const actual = Number.isFinite(audio?.speechEnd) ? audio.speechEnd.toFixed(1) : '未知';
    throw fail('digital_human_audio_duration_mismatch', `第${index + 1}段实际讲到${actual}秒，目标${seconds}秒。请调整该段文案后新建；原音轨已保存，尚未提交视频。`);
  }
}
function verifyTranscript(utterances, script, durationSeconds) {
  if (!Array.isArray(utterances) || !utterances.length) throw fail('digital_human_transcript_missing', '完整配音未识别出带时间的讲话，尚未生成视频。');
  // This checks frozen TTS generated from the approved script, not arbitrary
  // uploaded speech. ASR homophones may use the approved spelling while keeping
  // observed timestamps. Missing words, changed tones, numbers and IDs still fail.
  const normal = (text) => Array.from(String(text || '')).filter(char => /[\p{L}\p{N}]/u.test(char)).map(char => char.toLowerCase()).join('');
  const expected = normal(script), recognized = normal(utterances.map((u) => u?.text || '').join(''));
  const expectedChars = Array.from(expected), recognizedChars = Array.from(recognized);
  const phonemes = (text) => pinyin(text, { type: 'array', toneType: 'num', nonZh: 'spaced' });
  const wanted = phonemes(expected), heard = phonemes(recognized);
  if (!expected.length || expectedChars.length !== recognizedChars.length || wanted.length !== expectedChars.length || heard.length !== recognizedChars.length
    || expectedChars.some((char, index) => char !== recognizedChars[index]
      && (!/\p{Script=Han}/u.test(char) || !/\p{Script=Han}/u.test(recognizedChars[index]) || wanted[index] !== heard[index]))) {
    throw fail('digital_human_transcript_mismatch', '实际配音识别与确认文案不一致，可能漏句或读音需要核对。音轨与识别结果已保留，尚未生成视频。');
  }
  // Use the same millisecond fields consumed by asr_sentences/_aligned_units.
  // Reject malformed or overlapping sentences before a video is purchased.
  let last = 0;
  for (const item of utterances) {
    if (!normal(item?.text)) continue;
    if (!Number.isInteger(item.start_time) || !Number.isInteger(item.end_time)
      || item.start_time < last || item.end_time <= item.start_time || item.end_time > durationSeconds * 1000) {
      throw fail('digital_human_transcript_coverage', '口播字幕时间缺失、重叠或超出时长，音轨与识别结果已保留，尚未生成视频。');
    }
    last = item.end_time;
  }
  if (last < (durationSeconds - MAX_TAIL_SECONDS) * 1000) throw fail('digital_human_transcript_coverage', '口播字幕时间没有覆盖预定结尾，尚未生成视频。');
  let cursor = 0;
  const correctedText = (text, start) => {
    let index = start;
    return Array.from(String(text || '')).map(char => /[\p{L}\p{N}]/u.test(char)
      ? (char.toLowerCase() === expectedChars[index] ? (index++, char) : expectedChars[index++]) : char).join('');
  };
  const alignedUtterances = utterances.map(item => {
    const start = cursor; cursor += normal(item.text).length;
    let wordCursor = start;
    const words = Array.isArray(item.words) && normal(item.words.map(word => word.text).join('')) === normal(item.text)
      ? item.words.filter(word => normal(word.text)).map(word => {
        const text = correctedText(word.text, wordCursor); wordCursor += normal(word.text).length;
        return { ...word, text };
      }) : item.words;
    return { ...item, text: correctedText(item.text, start), ...(words ? { words } : {}) };
  });
  return { editDistance: 0, phoneticCorrections: expectedChars.filter((char, index) => char !== recognizedChars[index]).length,
    matchedCharacters: expectedChars.length, verifiedAt: new Date().toISOString(), alignedUtterances };
}
async function probe(source, ffmpegPath) {
  const executable = path.basename(ffmpegPath) === ffmpegPath ? (process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    : path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  return JSON.parse(await run(executable, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.resolve(source)]));
}
async function freezeAudio({ segments, destination, ffmpegPath = 'ffmpeg' }) {
  if (!segments?.length) throw fail('digital_human_audio_missing', '完整配音尚未准备好。');
  const args = ['-hide_banner', '-loglevel', 'error', '-y'], filters = [];
  for (const [index, segment] of segments.entries()) {
    const bytes = fs.readFileSync(segment.audioPath);
    if (segment.audioSha256 && createHash('sha256').update(bytes).digest('hex') !== segment.audioSha256) throw fail('digital_human_audio_changed', '冻结配音文件发生变化。');
    args.push('-i', segment.audioPath);
    filters.push(`[${index}:a]asetpts=PTS-STARTPTS,aresample=${RATE},aformat=sample_fmts=s16:channel_layouts=mono${segment.preserveDuration ? '' : `,apad,atrim=duration=${segment.seconds}`}[a${index}]`);
  }
  filters.push(`${segments.map((_, index) => `[a${index}]`).join('')}concat=n=${segments.length}:v=0:a=1[all]`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  await run(ffmpegPath, [...args, '-filter_complex', filters.join(';'), '-map', '[all]', '-c:a', 'pcm_s16le', destination]);
  return { sha256: createHash('sha256').update(fs.readFileSync(destination)).digest('hex') };
}
async function cutAudio({ source, destination, startSeconds, seconds, ffmpegPath = 'ffmpeg' }) {
  await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source,
    '-af', `atrim=start=${startSeconds}:duration=${seconds},asetpts=PTS-STARTPTS`, '-ar', String(RATE), '-ac', '1', '-c:a', 'pcm_s16le', destination]);
  return measureAudio({ source: destination, ffmpegPath });
}
async function assemble({ segments, destination, audioDestination, ffmpegPath = 'ffmpeg' }) {
  if (!segments?.length || segments.some((segment) => !segment.videoPath || !segment.audioPath)) throw fail('digital_human_segments_missing', '口播音画分段尚未完整。');
  const parent = path.dirname(path.resolve(destination)); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, '.avatar-audio-'));
  try {
    const encoder = await videoEncoderArgs(ffmpegPath);
    for (const [index, segment] of segments.entries()) {
      const audio = await measureAudio({ source: segment.audioPath, ffmpegPath });
      assertSpeechCoverage(audio, segment.seconds, index);
      if (segment.audioSha256 && audio.sha256 !== segment.audioSha256) throw fail('digital_human_audio_changed', '已冻结的配音文件发生变化，不能继续合成。');
      const info = await probe(segment.videoPath, ffmpegPath), video = info.streams?.find((s) => s.codec_type === 'video');
      if (!video || Number(video.duration || info.format?.duration) < segment.seconds - .08) throw fail('digital_human_video_short', `第${index + 1}段画面不足${segment.seconds}秒，不能以静帧补足。`);
      await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', segment.videoPath, '-i', segment.audioPath,
        '-map', '0:v:0', '-map', '1:a:0', '-t', String(segment.seconds),
        '-vf', 'setpts=PTS-STARTPTS,fps=30,scale=720:1280:force_original_aspect_ratio=decrease:flags=lanczos,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1',
        '-af', `asetpts=PTS-STARTPTS,aresample=48000,apad,atrim=duration=${segment.seconds}`,
        ...encoder, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', path.join(directory, `segment-${index}.mp4`)]);
    }
    fs.writeFileSync(path.join(directory, 'clips.txt'), segments.map((_, i) => `file 'segment-${i}.mp4'`).join('\n') + '\n');
    const joined = path.join(directory, 'joined.mp4');
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', 'clips.txt', '-c', 'copy', '-movflags', '+faststart', joined], { cwd: directory });
    const info = await probe(joined, ffmpegPath), expected = segments.reduce((sum, s) => sum + s.seconds, 0);
    if (Math.abs(Number(info.format?.duration) - expected) > .15) throw fail('digital_human_assembly_duration', '合成时长与冻结音轨不一致，源片已保留。');
    if (!fs.existsSync(audioDestination)) throw fail('digital_human_audio_missing', '冻结的完整口播音轨丢失，不能另配音替代。');
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', joined, '-i', audioDestination,
      '-map', '0:v:0', '-map', '1:a:0', '-t', String(expected), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', destination]);
    return { seconds: expected, audioSha256: createHash('sha256').update(fs.readFileSync(audioDestination)).digest('hex') };
  } finally {
    const relative = path.relative(parent, directory);
    if (relative.startsWith('.avatar-audio-') && !relative.includes(path.sep) && !path.isAbsolute(relative)) fs.rmSync(directory, { recursive: true, force: true });
  }
}
function segmentPrompt(task, segment, index) {
  const expressions = ['开口时轻微前倾、眉眼带好奇；解释时回稳，单手自然摊开。', '平稳解释，手势与语气有轻重，适当点头，手势收回。', '收尾时自然微笑、轻点头，仍保持眨眼和呼吸。'];
  return `竖屏写实人物口播，稳定平视大半身构图，保持参考人物身份、服装、场景和产品外形。使用传入音轨作为唯一对白，嘴型、表情、肩膀和手势与该音轨节奏对应；不另读一份文案，不生成额外人声或配乐。${expressions[Math.min(index, expressions.length - 1)]}两手自然完整，不机械循环挥手；大型产品继续落地，不改变产品结构。语音结束后只保留短暂自然呼吸，不定格。不生成字幕或画内文字。本段语义仅供表演理解：${segment.text}`;
}
module.exports = { VOICE_IDS, splitScript, speechChunks, splitMeasuredSpeech, cutAudio, analyzePcm, measureAudio, assertSpeechCoverage, verifyTranscript, freezeAudio, assemble, segmentPrompt };
