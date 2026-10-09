const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

function mediaError(code, message, details = {}) { return Object.assign(new Error(message), { code, ...details }); }
async function run(binary, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20 * 60_000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-2_000_000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-3000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(mediaError('product_video_media_failed', stderr || `媒体处理退出：${code}`)));
  });
}
function probeBinary(ffmpegPath) {
  return path.basename(ffmpegPath) === ffmpegPath ? (process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    : path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
}
async function probe(source, ffmpegPath) {
  const data = JSON.parse(await run(probeBinary(ffmpegPath), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.resolve(source)]));
  const video = data.streams.find((stream) => stream.codec_type === 'video');
  const audio = data.streams.find((stream) => stream.codec_type === 'audio');
  return { video, audio, seconds: Number(video?.duration || data.format?.duration) };
}
async function videoEncoderArgs(ffmpegPath = 'ffmpeg') {
  const encoders = await run(ffmpegPath, ['-hide_banner', '-encoders']);
  // The distributed LGPL runtime uses Media Foundation, matching the content engine.
  if (/\bh264_mf\b/u.test(encoders)) return ['-c:v', 'h264_mf', '-rate_control', 'quality', '-quality', '80', '-scenario', 'archive'];
  if (/\blibx264\b/u.test(encoders)) return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18'];
  throw mediaError('product_video_encoder_unavailable', '本地视频编码组件未就绪，请检查运行组件；已有素材已保留。');
}
async function temporaryWork(destination, work) {
  const parent = path.dirname(path.resolve(destination));
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, '.product-media-'));
  try { return await work(directory); }
  finally {
    // Only remove the exact helper-owned directory, never a source or caller-supplied path.
    const relative = path.relative(parent, directory);
    if (relative.startsWith('.product-media-') && !relative.includes(path.sep) && !path.isAbsolute(relative)) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}
function separateOutput(source, destination) {
  if (path.resolve(source).toLowerCase() === path.resolve(destination).toLowerCase()) {
    throw mediaError('product_video_media_path_invalid', '输出文件必须与原片分开保存。');
  }
}

/** Normalize real clips; never fill missing picture time with a freeze frame or slow motion. */
async function normalizeAndAssemble({ shots, destination, ffmpegPath = 'ffmpeg' }) {
  if (!Array.isArray(shots) || !shots.length || shots.some((shot) => !shot?.path || !Number.isFinite(shot.seconds) || shot.seconds <= 0)) {
    throw mediaError('product_video_shots_invalid', '缺少有效的镜头文件或时长。');
  }
  shots.forEach((shot) => separateOutput(shot.path, destination));
  const seconds = shots.reduce((sum, shot) => sum + shot.seconds, 0);
  const encoder = await videoEncoderArgs(ffmpegPath);
  return temporaryWork(destination, async (directory) => {
    for (const [index, shot] of shots.entries()) {
      const info = await probe(shot.path, ffmpegPath);
      if (!info.video || !info.audio) throw mediaError('product_video_native_audio_missing', `第 ${index + 1} 段缺少画面或模型原生声音，请单独重做该镜头。`, { shotIndex: index });
      if (!Number.isFinite(info.seconds) || info.seconds + 1 / 24 < shot.seconds) {
        throw mediaError('product_video_shot_too_short', `第 ${index + 1} 段原片不足 ${shot.seconds} 秒，不能以静帧补足。`, { shotIndex: index });
      }
      const output = path.join(directory, `shot-${index}.mp4`);
      await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.resolve(shot.path),
        '-map', '0:v:0', '-map', '0:a:0', '-t', String(shot.seconds),
        '-vf', `setpts=PTS-STARTPTS,fps=24,scale=480:852:force_original_aspect_ratio=decrease:flags=lanczos,pad=480:852:(ow-iw)/2:(oh-ih)/2,setsar=1`,
        '-af', `asetpts=PTS-STARTPTS,aresample=48000,apad,atrim=duration=${shot.seconds},afade=t=in:st=0:d=0.025,afade=t=out:st=${Math.max(0, shot.seconds - 0.025)}:d=0.025`,
        ...encoder, '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', output]);
    }
    // Relative generated names avoid ffconcat quoting of user-selected filenames.
    await fs.writeFile(path.join(directory, 'clips.txt'), shots.map((_, i) => `file 'shot-${i}.mp4'`).join('\n') + '\n', 'utf8');
    const result = path.join(directory, 'assembled.mp4');
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', 'clips.txt',
      '-map', '0:v:0', '-map', '0:a:0', '-t', String(seconds), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-ar', '48000', '-ac', '2', '-movflags', '+faststart', result], directory);
    const final = await probe(result, ffmpegPath);
    if (final.video?.width !== 480 || final.video?.height !== 852 || !final.audio || Math.abs(final.seconds - seconds) > 0.12) {
      throw mediaError('product_video_assemble_invalid', '合成后的尺寸、时长或音轨检查未通过。');
    }
    await fs.rename(result, path.resolve(destination));
    return { destination, durationSeconds: final.seconds, width: 480, height: 852 };
  });
}

async function extractAudio({ source, destination, ffmpegPath = 'ffmpeg' }) {
  separateOutput(source, destination);
  await temporaryWork(destination, async (directory) => {
    const audio = path.join(directory, 'voices.wav');
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.resolve(source), '-map', '0:a:0',
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio]);
    await fs.rename(audio, path.resolve(destination));
  });
  return destination;
}

const cleanText = (value) => String(value || '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
const width = (text) => Array.from(text).reduce((sum, char) => sum + (char.codePointAt(0) <= 0x7f ? 0.5 : 1), 0);
function wrap(text) {
  const lines = []; let line = '';
  for (const char of text) {
    if (width(line + char) > 10) { lines.push(line.trim()); line = ''; }
    line += char;
  }
  if (line.trim()) lines.push(line.trim());
  if (lines.length > 2) throw mediaError('product_video_caption_too_long', '字幕过长，需要按实际词级时间分句。');
  return lines;
}
function timing(node, scale) {
  const start = node?.start_time ?? node?.startTime ?? node?.start;
  const end = node?.end_time ?? node?.endTime ?? node?.end;
  if (start === undefined || end === undefined || start === null || end === null || start === '' || end === ''
    || !Number.isFinite(Number(start)) || !Number.isFinite(Number(end)) || Number(start) < 0 || Number(end) <= Number(start)) {
    throw mediaError('product_video_caption_timing_missing', '识别结果缺少有效的实际时间，不能用计划台词代替字幕。');
  }
  return { start: Number(start) * scale, end: Number(end) * scale };
}
function spokenCharacters(text) {
  const result = []; let offset = 0;
  for (const char of text) {
    if (!/[\p{P}\p{Z}\s]/u.test(char)) result.push({ char: char.toLowerCase(), start: offset, end: offset + char.length });
    offset += char.length;
  }
  return result;
}
function timedParts(utterance, text, span, scale) {
  if (width(text) <= 20) return [{ ...span, text }];
  if (!Array.isArray(utterance.words) || !utterance.words.length) {
    throw mediaError('product_video_caption_words_missing', '较长的对白缺少词级时间，原声已保留，请重新识别字幕。');
  }
  const characters = spokenCharacters(text), tokens = []; let offset = 0;
  for (const word of utterance.words) {
    const spoken = spokenCharacters(cleanText(word.text)).map((entry) => entry.char).join('');
    if (!spoken) continue;
    const count = Array.from(spoken).length;
    if (characters.slice(offset, offset + count).map((entry) => entry.char).join('') !== spoken) {
      throw mediaError('product_video_caption_words_mismatch', '对白与词级识别结果不一致，不能可靠拆分字幕。');
    }
    const clock = timing(word, scale);
    if (clock.start < span.start - 0.1 || clock.end > span.end + 0.1 || (tokens.length && clock.start < tokens.at(-1).start)) {
      throw mediaError('product_video_caption_words_invalid', '词级时间超出对白范围或顺序异常。');
    }
    tokens.push({ ...clock, offset: characters[offset].start }); offset += count;
  }
  if (offset !== characters.length || !tokens.length) throw mediaError('product_video_caption_words_mismatch', '词级时间未覆盖完整对白。');
  const pieces = []; let current;
  tokens.forEach((token, index) => {
    const value = text.slice(index === 0 ? 0 : token.offset, tokens[index + 1]?.offset ?? text.length);
    if (width(value) > 20) throw mediaError('product_video_caption_words_missing', '单个识别词过长，无法可靠分配字幕时间。');
    if (current && width(current.text + value) > 20) { pieces.push(current); current = undefined; }
    if (!current) current = { start: token.start, end: token.end, text: value };
    else { current.text += value; current.end = token.end; }
    if (/[，。！？；,.!?;]\s*$/u.test(current.text) && width(current.text) >= 7) { pieces.push(current); current = undefined; }
  });
  if (current) pieces.push(current);
  return pieces.map((piece) => ({ ...piece, text: piece.text.trim() }));
}
function assClock(seconds) {
  const ticks = Math.round(seconds * 100);
  return `${Math.floor(ticks / 360000)}:${String(Math.floor(ticks / 6000) % 60).padStart(2, '0')}:${String(Math.floor(ticks / 100) % 60).padStart(2, '0')}.${String(ticks % 100).padStart(2, '0')}`;
}
function srtClock(seconds) {
  const ticks = Math.round(seconds * 1000);
  return `${String(Math.floor(ticks / 3600000)).padStart(2, '0')}:${String(Math.floor(ticks / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ticks / 1000) % 60).padStart(2, '0')},${String(ticks % 1000).padStart(3, '0')}`;
}
// Full-width literal punctuation prevents ASR text from injecting ASS override blocks or line controls.
const escapeAss = (text) => text.replace(/\\/gu, '＼').replace(/\{/gu, '｛').replace(/\}/gu, '｝');
const escapeSrt = (text) => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

/** Accept only recognized, timed speech; no planned script is used as a subtitle fallback. */
function buildCaptions({ utterances, timeUnit = 'ms', durationSeconds } = {}) {
  if (!Array.isArray(utterances) || !utterances.length) throw mediaError('product_video_caption_timing_missing', '识别结果没有带时间的对白。');
  if (!['ms', 's'].includes(timeUnit)) throw mediaError('product_video_caption_unit_invalid', '字幕时间单位无效。');
  if (durationSeconds !== undefined && (!Number.isFinite(durationSeconds) || durationSeconds <= 0)) throw mediaError('product_video_caption_duration_invalid', '视频时长无效。');
  const scale = timeUnit === 'ms' ? 0.001 : 1, cues = [];
  for (const utterance of utterances) {
    const text = cleanText(utterance.text);
    if (!text) continue;
    const span = timing(utterance, scale);
    for (const piece of timedParts(utterance, text, span, scale)) {
      if (durationSeconds !== undefined && piece.end > durationSeconds + 0.15) throw mediaError('product_video_caption_out_of_bounds', '对白时间超出视频时长，请核对识别音轨。');
      const cue = { ...piece, end: durationSeconds === undefined ? piece.end : Math.min(piece.end, durationSeconds), lines: wrap(piece.text) };
      const previous = cues.at(-1);
      if (previous && previous.end > cue.start) {
        if (cue.start <= previous.start || previous.end - cue.start > 0.15) throw mediaError('product_video_caption_overlap', '对白时间重叠或乱序，字幕需要核对。');
        previous.end = cue.start;
      }
      if (cue.end <= cue.start) throw mediaError('product_video_caption_timing_missing', '对白时间不足，无法生成同步字幕。');
      cues.push(cue);
    }
  }
  if (!cues.length) throw mediaError('product_video_caption_timing_missing', '没有可用的带时间对白。');
  const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Spoken,Microsoft YaHei,96,&H00FFFFFF,&H00FFFFFF,&H00202020,&H00000000,-1,0,0,0,100,100,0,0,1,4,1,8,60,60,150,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`
    + cues.map((cue) => `Dialogue: 0,${assClock(cue.start)},${assClock(cue.end)},Spoken,,0,0,0,,${cue.lines.map(escapeAss).join('\\N')}`).join('\n') + '\n';
  const srt = cues.map((cue, index) => `${index + 1}\n${srtClock(cue.start)} --> ${srtClock(cue.end)}\n${cue.lines.map(escapeSrt).join('\n')}\n`).join('\n');
  return { ass, srt, cues };
}

/** Ordinary local resize with captions; the model's native audio is copied unchanged. */
async function renderCaptioned({ source, destination, captions, ffmpegPath = 'ffmpeg' }) {
  separateOutput(source, destination);
  const ass = typeof captions === 'string' ? captions : captions?.ass;
  if (!ass || !ass.includes('[Events]')) throw mediaError('product_video_caption_missing', '缺少已经核对时间的字幕文件。');
  const encoder = await videoEncoderArgs(ffmpegPath);
  return temporaryWork(destination, async (directory) => {
    await fs.writeFile(path.join(directory, 'captions.ass'), ass, 'utf8');
    const output = path.join(directory, 'captioned.mp4');
    // A relative, fixed filter filename avoids drive-colon and quote escaping in FFmpeg filters.
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.resolve(source), '-map', '0:v:0', '-map', '0:a:0',
      '-vf', 'scale=1080:1920:flags=lanczos,setsar=1,ass=captions.ass', ...encoder,
      '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', output], directory);
    const info = await probe(output, ffmpegPath);
    if (info.video?.width !== 1080 || info.video?.height !== 1920 || !info.audio) throw mediaError('product_video_render_invalid', '字幕成片的尺寸或原声音轨检查未通过。');
    await fs.rename(output, path.resolve(destination));
    const stem = path.join(path.dirname(path.resolve(destination)), path.parse(destination).name);
    await fs.writeFile(`${stem}.ass`, ass, 'utf8');
    if (typeof captions === 'object' && captions.srt) await fs.writeFile(`${stem}.srt`, captions.srt, 'utf8');
    return { destination, assPath: `${stem}.ass`, srtPath: typeof captions === 'object' && captions.srt ? `${stem}.srt` : '', durationSeconds: info.seconds, upscaleMethod: 'lanczos' };
  });
}

/** Wan silent sources share one already prepared soundtrack. No picture is repeated or frozen. */
async function assemblePreparedVideo({ shots, audioPath, destination, ffmpegPath = 'ffmpeg' }) {
  if (!Array.isArray(shots) || !shots.length || shots.some(s => !s.path || !Number.isFinite(s.seconds) || s.seconds <= 0)) {
    throw mediaError('product_video_shots_invalid', '缺少有效的镜头文件或时长。');
  }
  const seconds = shots.reduce((sum, shot) => sum + shot.seconds, 0);
  const sound = await probe(audioPath, ffmpegPath);
  if (!sound.audio || !Number.isFinite(sound.seconds) || sound.seconds + 0.05 < seconds) {
    throw mediaError('product_video_audio_incomplete', '完整音轨不足成片时长，请先完成声音准备。');
  }
  [...shots.map(s => s.path), audioPath].forEach(source => separateOutput(source, destination));
  const encoder = await videoEncoderArgs(ffmpegPath);
  return temporaryWork(destination, async directory => {
    for (const [index, shot] of shots.entries()) {
      const info = await probe(shot.path, ffmpegPath);
      if (!info.video || !Number.isFinite(info.seconds) || info.seconds + 1 / 30 < shot.seconds) {
        throw mediaError('product_video_shot_too_short', `第 ${index + 1} 段原片不足 ${shot.seconds} 秒，不能以静帧补足。`, { shotIndex: index });
      }
      await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.resolve(shot.path),
        '-map', '0:v:0', '-an', '-t', String(shot.seconds),
        '-vf', 'setpts=PTS-STARTPTS,fps=30,scale=720:1280:force_original_aspect_ratio=decrease:flags=lanczos,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1',
        ...encoder, '-pix_fmt', 'yuv420p', path.join(directory, `shot-${index}.mp4`)]);
    }
    await fs.writeFile(path.join(directory, 'clips.txt'), shots.map((_, i) => `file 'shot-${i}.mp4'`).join('\n') + '\n', 'utf8');
    const output = path.join(directory, 'assembled.mp4');
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', 'clips.txt',
      '-i', path.resolve(audioPath), '-map', '0:v:0', '-map', '1:a:0', '-t', String(seconds),
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output], directory);
    const final = await probe(output, ffmpegPath);
    if (final.video?.width !== 720 || final.video?.height !== 1280 || !final.audio || Math.abs(final.seconds - seconds) > 0.12) {
      throw mediaError('product_video_assemble_invalid', '合成后的尺寸、时长或音轨检查未通过。');
    }
    await fs.rename(output, path.resolve(destination));
    return { destination, durationSeconds: final.seconds, width: 720, height: 1280 };
  });
}

module.exports = { normalizeAndAssemble, assemblePreparedVideo, extractAudio, buildCaptions, renderCaptioned, run, probe, videoEncoderArgs };
