const fs = require('node:fs');
const { spawn } = require('node:child_process');

/** Resize a finished 480p video locally. This produces 1080p dimensions, not native 1080p detail. */
async function upscaleTo1080Size({ source, destination, ffmpegPath = 'ffmpeg' }) {
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
      '-map', '0:v:0', '-map', '0:a?',
      '-vf', 'scale=1080:1920:flags=lanczos,setsar=1',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy', '-movflags', '+faststart', destination
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], timeout: 20 * 60_000 });
    let detail = '';
    child.stderr.on('data', (chunk) => { detail = (detail + chunk.toString()).slice(-1000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(detail || `FFmpeg ${code}`)));
  });
  if (!fs.existsSync(destination) || fs.statSync(destination).size < 1024) throw new Error('本地放大后的视频文件无效。');
  return destination;
}

module.exports = { upscaleTo1080Size };
