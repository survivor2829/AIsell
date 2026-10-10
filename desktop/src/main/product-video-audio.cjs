const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeJsonAtomic } = require('./atomic-file.cjs');
const { fail } = require('./digital-human-provider.cjs');
const { createBailianVideoProvider, ROUTES, ttsPayload, ttsAudioUrl } = require('./bailian-video-provider.cjs');
const { run, probe } = require('./product-video-media.cjs');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Preparation has its own small, journalled TTS requests. Resuming only reuses
// those receipts and files; it never silently buys another narration.
function createProductAudioPreparer(options = {}) {
  const provider = options.provider || createBailianVideoProvider(options);
  return async function prepareAudio({ task, directory, ffmpegPath = 'ffmpeg', operation }) {
    fs.mkdirSync(directory, { recursive: true });
    const prepareNarration = task.audioVoicePolicy === 'workbench' ? options.prepareNarration : null;
    if (task.audioVoicePolicy === 'workbench' && !prepareNarration) throw fail('product_video_audio_unavailable', '创作工作台声音尚未就绪，未提交视频。');
    const manifestPath = path.join(directory, 'soundtrack.json');
    let saved = {};
    if (fs.existsSync(manifestPath)) saved = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const clips = [], filters = [], args = [], duration = task.durationSeconds;
    const unit = Number(task.prices?.ttsCnyPer10kChars);
    if (!Number.isFinite(unit) || unit <= 0) throw fail('product_video_audio_price_missing', '配音报价尚未核实，没有提交视频。');
    let cursor = 0;
    for (const [index, shot] of task.plan.shots.entries()) {
      const text = String(shot.narration || '').trim();
      if (!text) { cursor += shot.seconds; continue; }
      const file = path.join(directory, `narration-${index}.wav`);
      // Completed manifests remain frozen. New narration uses the same approved
      // voice as the workbench, without naming a product or voice in this path.
      const fingerprint = createHash('sha256').update(JSON.stringify({ text, voice: prepareNarration ? 'workbench' : 'Cherry' })).digest('hex');
      const existing = saved[index];
      if (!existing || existing.fingerprint !== fingerprint || !fs.existsSync(file) || hash(file) !== existing.sha256) {
        const amount = Math.ceil([...text].length * (prepareNarration ? Math.max(20, unit) : unit)) / 10000;
        let narration = {};
        if (prepareNarration) {
          narration = await operation(`audio_narration_${index}`, 'internal:workbench-narration', {}, amount, {},
            (sourceId) => prepareNarration({ source_id: sourceId, text,
              ...(saved.voicePersonaId ? { voice_persona_id: saved.voicePersonaId } : {}) }));
          if (hash(narration.file) !== narration.audio_digest) throw fail('product_video_audio_changed', '创作工作台口播完整性检查未通过。');
          fs.copyFileSync(narration.file, file);
          saved.voicePersonaId = narration.voice_persona_id;
        } else {
          const result = await operation(`audio_narration_${index}`, ROUTES.tts, ttsPayload({ text, voice: 'Cherry' }), amount);
          await provider.download(ttsAudioUrl(result), file, { maxBytes: 20 * 1024 * 1024 });
        }
        saved[index] = { fingerprint, sha256: hash(file), voicePersonaId: narration.voice_persona_id, voiceName: narration.voice_name };
        writeJsonAtomic(manifestPath, saved);
      }
      const info = await probe(file, ffmpegPath);
      if (!info.audio || !Number.isFinite(info.seconds) || info.seconds <= 0 || info.seconds > shot.seconds - 0.2) {
        throw fail('product_video_narration_too_long', `第 ${index + 1} 段讲解${Number.isFinite(info.seconds) ? `实测 ${info.seconds.toFixed(1)} 秒` : '不可读'}，超过镜头可用时长；请缩短该段文案后制作。尚未提交视频。`);
      }
      args.push('-i', file);
      const slot = clips.length;
      filters.push(`[${slot}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,adelay=${Math.round((cursor + 0.1) * 1000)}:all=1[v${slot}]`);
      clips.push({ file, startSecond: cursor + 0.1, seconds: info.seconds, text, sha256: hash(file) });
      cursor += shot.seconds;
    }
    if (!clips.length) throw fail('product_video_narration_missing', '制作方案缺少讲解，未提交视频。');
    const voiceFile = path.join(directory, 'voice.wav');
    filters.push(`${clips.map((_, i) => `[v${i}]`).join('')}amix=inputs=${clips.length}:normalize=0,apad,atrim=duration=${duration}[voice]`);
    await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args, '-filter_complex', filters.join(';'),
      '-map', '[voice]', '-c:a', 'pcm_s16le', '-ar', '48000', voiceFile]);
    const voiceInfo = await probe(voiceFile, ffmpegPath);
    if (!voiceInfo.audio || !Number.isFinite(voiceInfo.seconds) || Math.abs(voiceInfo.seconds - duration) > 0.05) throw fail('product_video_audio_incomplete', '完整讲解时长检查未通过，未提交视频。');
    const file = path.join(directory, 'soundtrack.wav');
    fs.copyFileSync(voiceFile, file);
    let music = { status: 'unavailable', source: '', message: '没有可用的整片配乐，本片保留讲解。' };
    if (options.selectMusic) {
      try {
        const track = await options.selectMusic({ durationSeconds: duration });
        if (track?.file) {
          const info = await probe(track.file, ffmpegPath);
          // Keep a full recording, never loop a short preview. An optional music
          // failure must not invalidate frozen narration or buy new speech.
          if (!info.audio || !Number.isFinite(info.seconds) || info.seconds < duration || !/^[a-f0-9]{64}$/u.test(track.sha256 || '') || hash(track.file) !== track.sha256) {
            throw fail('product_video_music_invalid', '配乐文件时长或完整性不符。');
          }
          const musicFile = path.join(directory, 'music-source.wav');
          await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', track.file, '-vn', '-t', String(duration), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', musicFile]);
          // One uninterrupted music bed, ducked by the exact voice track. ASR
          // later uses voiceFile, before this mix.
          await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', voiceFile, '-i', musicFile,
            '-filter_complex', `[0:a]asplit=2[voice][key];[1:a]volume=0.16,afade=t=in:d=0.3,afade=t=out:st=${Math.max(0, duration - 0.8)}:d=0.8[music];[music][key]sidechaincompress=threshold=0.025:ratio=6:attack=20:release=350[bed];[voice][bed]amix=inputs=2:normalize=0,alimiter=limit=0.95[out]`,
            '-map', '[out]', '-t', String(duration), '-c:a', 'pcm_s16le', '-ar', '48000', file]);
          const mixed = await probe(file, ffmpegPath);
          if (!mixed.audio || !Number.isFinite(mixed.seconds) || Math.abs(mixed.seconds - duration) > 0.05) throw fail('product_video_music_mix_incomplete', '配乐混音时长不完整。');
          music = { status: 'ready', source: track.source || '已授权音乐库', trackId: track.trackId, file: musicFile, sha256: hash(musicFile) };
        } else if (track?.message) music.message = String(track.message).slice(0, 160);
      } catch {
        fs.copyFileSync(voiceFile, file);
        music = { status: 'unavailable', source: '', message: '配乐读取或混音未完成，已保留完整讲解；可检查音乐库后补配乐，无需重做视频。' };
      }
    }
    const info = await probe(file, ffmpegPath);
    if (!info.audio || !Number.isFinite(info.seconds) || Math.abs(info.seconds - duration) > 0.05) throw fail('product_video_audio_incomplete', '完整音轨时长检查未通过，未提交视频。');
    return { file, voiceFile, sha256: hash(file), durationSeconds: info.seconds, clips, music };
  };
}
module.exports = { createProductAudioPreparer };
