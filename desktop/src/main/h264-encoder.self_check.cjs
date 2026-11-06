const assert = require('node:assert/strict');
const { h264Encoders, withH264Encoder } = require('./h264-encoder.cjs');

// Encoder list of the FFmpeg we ship (LGPL build, 2026-11): no libx264.
const SHIPPED = ' V....D libopenh264  OpenH264\n V....D h264_amf  AMD\n V....D h264_mf  H264 via MediaFoundation\n V.S..D mpeg4  MPEG-4 part 2\n';
const DEVELOPER_GPL = ' V....D libx264  libx264 H.264\n V....D libopenh264  OpenH264\n';

(async () => {
  const list = (text) => ({ list: async () => text });
  // 1. The shipped runtime never gets libx264 (the 1.2.48+ "视频读取或转换未完成" upload failure).
  assert.deepEqual((await h264Encoders('ffmpeg', list(SHIPPED))).map((e) => e.name), ['h264_mf', 'libopenh264']);
  assert.deepEqual((await h264Encoders('ffmpeg', list(DEVELOPER_GPL))).map((e) => e.name), ['libx264', 'libopenh264']);
  // 2. A listed encoder that fails at run time (Media Foundation missing on Windows N) falls back.
  const tried = [];
  const used = await withH264Encoder('ffmpeg', async (args, name) => {
    tried.push(name);
    assert.equal(args[0], '-c:v'); assert.equal(args[1], name);
    if (name === 'h264_mf') throw Object.assign(new Error('mf failed'), { code: 1 });
    return name;
  }, list(SHIPPED));
  assert.equal(used, 'libopenh264'); assert.deepEqual(tried, ['h264_mf', 'libopenh264']);
  // 3. When every encoder fails, the real last error surfaces; no encoder at all is a clear code.
  await assert.rejects(withH264Encoder('ffmpeg', async () => { throw new Error('boom'); }, list(SHIPPED)), /boom/);
  await assert.rejects(withH264Encoder('ffmpeg', async () => 'x', list(' V..... mpeg4  MPEG-4\n')), { code: 'h264_encoder_unavailable' });
  // 4. No JS media path may hard-code libx264 again.
  const fs = require('node:fs'), path = require('node:path');
  for (const file of ['reference-human-media.cjs', 'video-upscale.cjs']) {
    assert.ok(!/'libx264'/u.test(fs.readFileSync(path.join(__dirname, file), 'utf8')), `${file} must choose its encoder via h264-encoder.cjs`);
  }
  console.log('h264 encoder self-check passed: shipped LGPL runtime uses h264_mf then OpenH264, run-time fallback, no hard-coded libx264');
})().catch((error) => { console.error(error); process.exit(1); });
