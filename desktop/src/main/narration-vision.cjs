// Local, isolated inference. Neither the model nor customer frames use a remote URL.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { writeJsonAtomic } = require('./atomic-file.cjs');
async function run(...args) {
  await require('./component-paths.cjs').ensureRuntimeGroup('content');
  try { return await promisify(execFile)(...args); }
  catch (error) { require('./component-paths.cjs').runtimeLaunchFailed(args[0], error); throw error; }
}
const VERSION = 'face-layout-v3';
const SAMPLE_FPS = 6;
const pending = new Map();
async function bounded(promise, ms = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('analysis timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}
const html = `<!doctype html><script type="module">
import {FilesetResolver,FaceDetector} from './vision_bundle.mjs';
window.ready = (async()=>{const files=await FilesetResolver.forVisionTasks('./wasm');
const detector=await FaceDetector.createFromOptions(files,{baseOptions:{modelAssetPath:'./face.tflite',delegate:'CPU'},runningMode:'IMAGE',minDetectionConfidence:0.6});
window.detect=async(data)=>{const bitmap=await createImageBitmap(await(await fetch(data)).blob());
try{return detector.detect(bitmap).detections.map(d=>({x:d.boundingBox.originX/bitmap.width,y:d.boundingBox.originY/bitmap.height,width:d.boundingBox.width/bitmap.width,height:d.boundingBox.height/bitmap.height,score:d.categories[0].score}))}finally{bitmap.close()}};return true})().catch(e=>{window.failure=String(e);return false});
</script>`;

async function analyze(source, cacheDir, ffmpeg = 'ffmpeg') {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(source)) hash.update(chunk);
  const digest = hash.digest('hex');
  const key = `${VERSION}-${digest}`;
  const cached = path.join(cacheDir, `${key}.json`);
  if (fs.existsSync(cached)) { try { const value = JSON.parse(fs.readFileSync(cached, 'utf8')); if (value.version === VERSION && value.sourceSha256 === digest) return value; } catch {} }
  if (pending.has(key)) return pending.get(key);
  const job = inspect(source, ffmpeg).then(result => {
    const value = { ...result, version: VERSION, sourceSha256: digest };
    // Transient failures are not permanent cache entries.
    if (value.status === 'measured') writeJsonAtomic(cached, value);
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, job); return job;
}
async function inspect(source, ffmpeg) {
  let window, server;
  try {
    const { BrowserWindow } = require('electron');
    const root = path.resolve(__dirname, '../../resources/narration-vision');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const resources = new Map();
    for (const [name, hash] of Object.entries(manifest.files)) {
      const buffer = fs.readFileSync(path.join(root, name));
      if (createHash('sha256').update(buffer).digest('hex') !== hash) throw Error('model integrity');
      resources.set(name, buffer);
    }
    const token = randomUUID();
    server = http.createServer((req, res) => {
      const prefix = `/${token}/`;
      if (req.method !== 'GET' || !req.url.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
      const name = req.url.slice(prefix.length);
      const bytes = name === '' ? Buffer.from(html) : resources.get(name);
      if (!bytes) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self' data:; img-src data: blob:");
      res.setHeader('Content-Type', !name ? 'text/html' : name.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(name) ? 'text/javascript' : 'application/octet-stream');
      res.end(bytes);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, partition: `narration-analysis-${token}` } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const origin = `http://127.0.0.1:${server.address().port}/${token}/`;
    window.webContents.session.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith(origin) && !details.url.startsWith('data:') && !details.url.startsWith('blob:') }));
    await bounded(window.loadURL(origin));
    if (!await bounded(window.webContents.executeJavaScript('window.ready'))) throw Error('model initialization');
    const { stdout } = await run(ffmpeg, ['-v', 'error', '-nostdin', '-i', source, '-vf', `fps=${SAMPLE_FPS},scale=360:640:force_original_aspect_ratio=decrease,pad=360:640:(ow-iw)/2:(oh-ih)/2`, '-frames:v', String(120 * SAMPLE_FPS), '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'], { windowsHide: true, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
    const samples = []; let start = 0;
    while (start < stdout.length) {
      const end = stdout.indexOf(Buffer.from([255, 217]), start);
      if (end < 0) break;
      const frame = `data:image/jpeg;base64,${stdout.subarray(start, end + 2).toString('base64')}`;
      const boxes = await bounded(window.webContents.executeJavaScript(`window.detect(${JSON.stringify(frame)})`), 5000);
      samples.push({ timeMs: samples.length * 1000 / SAMPLE_FPS, boxes }); start = end + 2;
    }
    if (!samples.length) throw Error('no frames');
    // Protect the presenter, not an unrelated small face far in the background.
    // A second similarly sized person still makes the composition busy.
    const ranked = samples.map(s => [...s.boxes].sort((a, b) => b.width * b.height - a.width * a.height));
    const faces = ranked.flatMap(boxes => boxes.filter(b => b.width * b.height >= boxes[0].width * boxes[0].height * .35));
    const coverage = samples.filter(s => s.boxes.length).length / samples.length;
    const union = faces.length ? { x: Math.min(...faces.map(b => b.x)), y: Math.min(...faces.map(b => b.y)), right: Math.max(...faces.map(b => b.x + b.width)), bottom: Math.max(...faces.map(b => b.y + b.height)) } : null;
    const movement = faces.length ? Math.max(...['x', 'y'].map(axis => {
      const centers = faces.map(b => b[axis] + b[axis === 'x' ? 'width' : 'height'] / 2);
      return Math.max(...centers) - Math.min(...centers);
    })) : 0;
    const multiple = ranked.filter(boxes => boxes.length > 1 && boxes[1].width * boxes[1].height > boxes[0].width * boxes[0].height * .35).length / samples.length;
    return { status: 'measured', coverage, union, movement, busy: movement > .16 || multiple > .2, sampleCount: samples.length, sampleFps: SAMPLE_FPS,
      note: coverage < .8 ? '部分画面未可靠检测到人脸，请检查文字位置；检测不代表口型质量。' : '已按本机采样人脸范围安排文字；请在成片中复查。' };
  } catch { return { status: 'unavailable', coverage: 0, union: null, busy: false, note: '本机画面检测未完成，使用保守布局，请检查是否遮脸。' }; }
  finally { if (window && !window.isDestroyed()) window.destroy(); if (server) server.close(); }
}
module.exports = { analyze, VERSION };
