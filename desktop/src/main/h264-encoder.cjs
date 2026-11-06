// H.264 encoder choice shared by the JS media paths (reference footage, upscale).
// The distributed media runtime is an LGPL FFmpeg build without libx264, so a
// hard-coded `-c:v libx264` fails on every customer computer. Prefer Windows
// Media Foundation (same as the content engine), keep libx264 for developer
// GPL builds, and fall back to OpenH264 (software, works everywhere).
const { execFile } = require('node:child_process');

// Two profiles: 'final' for delivered video, 'reference' for footage uploaded to the
// digital-human provider (measured 2026-11-06 on 44 s DJI 1080p: quality 60 ≈ 5.7 Mbps).
const PROFILES = {
  final: { h264_mf: ['-quality', '80'], libx264: ['-preset', 'medium', '-crf', '18'], libopenh264: ['-b:v', '10M'] },
  reference: { h264_mf: ['-quality', '60'], libx264: ['-preset', 'fast', '-crf', '21'], libopenh264: ['-b:v', '6M'] }
};
function candidates(profile = 'final') {
  const quality = PROFILES[profile] || PROFILES.final;
  return [
    { name: 'h264_mf', args: ['-c:v', 'h264_mf', '-rate_control', 'quality', ...quality.h264_mf, '-scenario', 'archive'] },
    { name: 'libx264', args: ['-c:v', 'libx264', ...quality.libx264] },
    { name: 'libopenh264', args: ['-c:v', 'libopenh264', ...quality.libopenh264] }
  ];
}
const listed = new Map();

function listEncoders(ffmpegPath) {
  if (!listed.has(ffmpegPath)) {
    listed.set(ffmpegPath, new Promise((resolve) => {
      execFile(ffmpegPath, ['-hide_banner', '-encoders'], { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => resolve(error ? '' : String(stdout || '')));
    }).then((text) => { if (!text) listed.delete(ffmpegPath); return text; }));
  }
  return listed.get(ffmpegPath);
}

// Ordered encoder argument lists this FFmpeg actually provides.
async function h264Encoders(ffmpegPath = 'ffmpeg', { list = listEncoders, profile = 'final' } = {}) {
  const text = await list(ffmpegPath);
  return candidates(profile).filter((candidate) => new RegExp(`\\b${candidate.name}\\b`, 'u').test(text));
}

// Runs `attempt(encoderArgs, name)` with each available encoder until one succeeds.
// A listed encoder can still fail at run time (e.g. Media Foundation missing on
// Windows N editions), so the next one is tried; the last error is rethrown.
// A timed-out or killed run is not an encoder problem: trying the next encoder would
// only make the customer wait the whole timeout again, so it is rethrown at once.
const timedOut = (error) => Boolean(error?.killed || error?.signal || error?.code === 'ETIMEDOUT');
async function withH264Encoder(ffmpegPath, attempt, options = {}) {
  const encoders = await h264Encoders(ffmpegPath, options);
  // No `code`: callers show their own Chinese message instead of a raw identifier.
  if (!encoders.length) throw new Error('本地视频编码组件未就绪（没有可用的 H.264 编码器），请重新安装软件后再试。');
  let lastError;
  for (const encoder of encoders) {
    try { return await attempt(encoder.args, encoder.name); }
    catch (error) { if (timedOut(error)) throw error; lastError = error; }
  }
  throw lastError;
}

module.exports = { h264Encoders, withH264Encoder, PROFILES };
