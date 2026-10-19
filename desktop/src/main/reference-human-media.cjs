const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { fail, safeLookup } = require('./digital-human-provider.cjs');
const { limits } = require('../shared/reference-human.json');
const run = promisify(execFile);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Energy is useful for avoiding silence and overload, not for claiming that a
// recording contains one speaker or no music. Keep that distinction in receipts.
function selectVoiceReference(pcm, sampleRate = 16000) {
  const frameSamples = Math.round(sampleRate * .02), count = Math.floor(pcm.length / 2), frames = [];
  for (let start = 0; start < count; start += frameSamples) {
    let sum = 0, clipped = 0;
    const size = Math.min(frameSamples, count - start);
    for (let index = start; index < start + size; index += 1) {
      const sample = pcm.readInt16LE(index * 2) / 32768;
      sum += sample * sample; if (Math.abs(sample) >= .995) clipped += 1;
    }
    frames.push({ rms: Math.sqrt(sum / size), clipped: clipped / size });
  }
  const peakRms = Math.max(0, ...frames.map((frame) => frame.rms));
  const threshold = Math.max(.003, peakRms * .04);
  if (peakRms < .003) throw fail('reference_voice_silent', '视频中没有足够清晰的讲话音量，请换一段连续自然讲话的视频。');
  let best;
  const maximum = Math.min(1000, frames.length), minimum = Math.min(500, frames.length);
  for (let length = maximum; length >= minimum; length -= 50) {
    for (let start = 0; start + length <= frames.length; start += 10) {
      const window = frames.slice(start, start + length);
      let active = 0, gap = 0, maxGap = 0, clipped = 0;
      for (const frame of window) {
        if (frame.rms >= threshold) { active += 1; gap = 0; } else { gap += .02; maxGap = Math.max(maxGap, gap); }
        clipped += frame.clipped;
      }
      const clippingRatio = clipped / length, activeSeconds = active * .02;
      const score = activeSeconds - (length - active) * .04 - maxGap * 2 - clippingRatio * 100;
      if (!best || score > best.score) best = { score, startSeconds: start * .02, seconds: length * .02, activeSeconds,
        activeRatio: active / length, maxQuietGapSeconds: maxGap, clippingRatio };
    }
  }
  if (!best || best.activeSeconds < limits.voiceMinSeconds) throw fail('reference_voice_insufficient', '视频中有效声音不足5秒，请连续自然讲话20—30秒后重新上传；原视频未改动。');
  if (best.clippingRatio > .05) throw fail('reference_voice_clipped', '录音有明显过载失真，请降低录音音量、稍离麦克风后补录；原视频未改动。');
  const warnings = [];
  if (best.clippingRatio > .001) warnings.push('检测到少量过载，请试听确认是否有破音。');
  if (best.activeRatio < .65 || best.maxQuietGapSeconds > 2) warnings.push('讲话间隔较多，建议试听确认所选片段是否连续清晰。');
  const levels = frames.slice(Math.round(best.startSeconds / .02), Math.round((best.startSeconds + best.seconds) / .02))
    .map((frame) => frame.rms).sort((a, b) => a - b);
  const quietLevel = levels[Math.floor(levels.length * .1)], upperLevel = levels[Math.floor(levels.length * .9)];
  const energyRangeDb = 20 * Math.log10(Math.max(upperLevel, .000001) / Math.max(quietLevel, .000001));
  if (quietLevel > .01 && energyRangeDb < 6) warnings.push('声音持续且变化较小，可能有背景持续声；请试听确认，不会自动降噪。');
  const { score, ...observed } = best;
  return { ...observed, quietLevelDbfs: 20 * Math.log10(Math.max(quietLevel, .000001)), energyRangeDb,
    method: 'pcm_energy_v1', speakerAndBackgroundVerified: false,
    warnings, note: '已检查静音和过载；未自动判定说话人数、背景音乐或音色自然度。' };
}

async function probeMedia(source, ffmpegPath = 'ffmpeg') {
  const ffprobe = path.dirname(ffmpegPath) === '.' ? 'ffprobe' : path.join(path.dirname(ffmpegPath), 'ffprobe.exe');
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', source], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(stdout), video = parsed.streams?.find((s) => s.codec_type === 'video');
  const [n, d] = String(video?.avg_frame_rate || video?.r_frame_rate || '0/1').split('/').map(Number);
  return { seconds: Number(parsed.format?.duration), width: video?.width, height: video?.height, fps: n / d,
    videoCodec: video?.codec_name, hasAudio: parsed.streams?.some((s) => s.codec_type === 'audio') === true };
}

async function prepareReference(source, destination, ffmpegPath = 'ffmpeg') {
  const stat = fs.statSync(source);
  if (!stat.isFile() || stat.size < 1 || stat.size > limits.videoMaxBytes || !['.mp4', '.mov', '.avi'].includes(path.extname(source).toLowerCase())) throw fail('reference_video_invalid', '请选择300MB以内的MP4、MOV或AVI真人视频。');
  const input = await probeMedia(source, ffmpegPath);
  if (!(input.seconds > limits.minSeconds && input.seconds < limits.maxSeconds) || input.width < limits.minSide || input.height < limits.minSide || Math.max(input.width, input.height) > limits.maxSide || input.fps < limits.minFps || input.fps > limits.maxFps) throw fail('reference_video_spec', '视频需大于2秒且小于120秒，宽高640—2048像素、15—60帧；建议20—30秒正面自然讲话。');
  if (!input.hasAudio) throw fail('reference_voice_missing', '这段视频没有声音，无法建立本人音色，请选择带清晰讲话的视频。');
  const { stdout: pcm } = await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', source,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'],
  { windowsHide: true, encoding: 'buffer', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const audioQuality = selectVoiceReference(pcm);
  fs.mkdirSync(destination, { recursive: true });
  const video = path.join(destination, 'reference.mp4'), audio = path.join(destination, 'voice.wav'), poster = path.join(destination, 'poster.jpg');
  // Normalize only the managed copy. Keep reference footage silent: original
  // speech must never leak into the new narration or its music mix.
  await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', source, '-map', '0:v:0', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video], { windowsHide: true, timeout: 180000 });
  await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', source, '-ss', String(audioQuality.startSeconds), '-t', String(audioQuality.seconds), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', audio], { windowsHide: true, timeout: 60000 });
  await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-ss', '0.2', '-i', video, '-frames:v', '1', '-vf', 'scale=320:-2', poster], { windowsHide: true, timeout: 30000 });
  return { ...(await probeMedia(video, ffmpegPath)), audioQuality, sourceSha256: sha256(fs.readFileSync(source)), videoSha256: sha256(fs.readFileSync(video)), audioSha256: sha256(fs.readFileSync(audio)) };
}

async function uploadReferenceMedia(provider, source, expectedHash, model = 'videoretalk') {
  const bytes = fs.readFileSync(source);
  if (sha256(bytes) !== expectedHash) throw fail('reference_media_changed', '人物或音轨发生变化，已停止上传。');
  const response = await provider.request(`/bailian/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`);
  const policy = response.data;
  let target;
  try { target = new URL(policy?.upload_host); } catch { throw fail('reference_upload_policy_invalid', '素材上传凭证不完整。'); }
  if (target.protocol !== 'https:' || target.port && target.port !== '443' || target.username || target.password || !target.hostname.endsWith('.aliyuncs.com') || !policy.upload_dir || !policy.oss_access_key_id || !policy.signature || !policy.policy) throw fail('reference_upload_policy_invalid', '素材上传地址或凭证无法核对。');
  const filename = `${randomUUID()}${path.extname(source)}`, key = `${policy.upload_dir.replace(/\/$/u, '')}/${filename}`;
  const fields = { OSSAccessKeyId: policy.oss_access_key_id, Signature: policy.signature, policy: policy.policy,
    'x-oss-object-acl': policy.x_oss_object_acl || 'private', 'x-oss-forbid-overwrite': 'true', key, success_action_status: '200' };
  const boundary = `----xiaoxi-${randomUUID()}`;
  const parts = Object.entries(fields).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  const body = Buffer.concat([...parts, Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${source.endsWith('.wav') ? 'audio/wav' : 'video/mp4'}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  await new Promise((resolve, reject) => {
    const request = https.request(target, { method: 'POST', lookup: safeLookup, timeout: 180000,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } }, (result) => {
      result.resume(); result.once('error', reject);
      result.once('end', () => result.statusCode === 200 ? resolve() : reject(fail('reference_upload_failed', '素材上传未完成，可以继续上传；未提交人物生成。')));
    });
    request.once('error', () => reject(fail('reference_upload_failed', '素材上传连接中断，可以继续上传；未提交人物生成。')));
    request.once('timeout', () => request.destroy()); request.end(body);
  });
  return { url: `oss://${key}`, expiresAt: new Date(Date.now() + 23 * 3600000).toISOString() };
}

async function freezeDrivenVideo(source, audio, destination, seconds, ffmpegPath = 'ffmpeg') {
  const actual = await probeMedia(source, ffmpegPath);
  if (actual.seconds + .08 < seconds) throw fail('reference_video_truncated', '云端视频短于完整口播，原结果已保存，请核对；不会截断文案或自动重新购买。');
  await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', source, '-i', audio,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(seconds), '-movflags', '+faststart', destination], { windowsHide: true, timeout: 90000 });
}

async function framePreview(source, seconds, ffmpegPath = 'ffmpeg') {
  const { stdout } = await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(seconds), '-i', source,
    '-frames:v', '1', '-vf', 'scale=360:-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'], { windowsHide: true, encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, timeout: 30000 });
  return `data:image/jpeg;base64,${stdout.toString('base64')}`;
}
module.exports = { prepareReference, selectVoiceReference, probeMedia, uploadReferenceMedia, freezeDrivenVideo, framePreview, sha256 };
