const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { createTutorialsController } = require('./tutorials.cjs');

(async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaoxi-tutorial-check-'));
  try {
    const video = Buffer.from('recording-bytes-for-transport-integrity');
    const cover = Buffer.from('cover-bytes');
    function file(bytes, extension) { const sha256 = crypto.createHash('sha256').update(bytes).digest('hex'); return { sha256, sizeBytes: bytes.length, url: `/v1/tutorials/files/${sha256}.${extension}` }; }
    const item = { id: 'one', title: '上传本人形象', category: 'short-video', topic: 'digital-human', video: { ...file(video, 'mp4'), durationSeconds: 30 }, cover: file(cover, 'png') };
    const catalog = { schema: 1, revision: 1, items: [item] };
    const requests = [];
    const options = { cacheDir, baseUrl: 'https://tutorials.example.com', toPreviewUrl: filename => 'xiaoxi-content://official/' + crypto.createHash('sha256').update(filename).digest('hex') + '/preview' };
    const transport = async url => {
      requests.push(url);
      return Readable.from([url.endsWith('/catalog') ? Buffer.from(JSON.stringify(catalog)) : url.endsWith('.png') ? cover : video]);
    };
    const controller = createTutorialsController({ ...options, transport });
    assert.equal((await controller.list()).data.items.length, 0);
    const refreshed = await controller.list({ refresh: true });
    assert.equal(refreshed.data.items[0].title, item.title);
    assert.ok(refreshed.data.items[0].coverUrl.startsWith('xiaoxi-content://'));
    assert.equal(refreshed.data.items[0].availableOffline, false);
    assert.equal((await controller.play('one')).ok, true);
    assert.equal((await controller.play('one')).ok, true);
    assert.equal(requests.filter(url => url.endsWith('.mp4')).length, 1, 'cached videos must not redownload');
    const offline = createTutorialsController({ ...options, transport: async () => { throw Error('offline'); } });
    const cached = await offline.list({ refresh: true });
    assert.equal(cached.data.offline, true);
    assert.equal(cached.data.items[0].availableOffline, true);
    assert.equal((await offline.play('one')).ok, true);
    const disconnected = createTutorialsController({ ...options, baseUrl: '', transport: async () => { throw Error('must stay offline'); } });
    assert.equal((await disconnected.list({ refresh: true })).data.items.length, 1, 'disabled service must preserve the cached catalog');
    assert.equal((await disconnected.play('one')).ok, true, 'disabled service must still play verified cached recordings');
    assert.equal(JSON.stringify(cached).includes(cacheDir), false, 'renderer must never see disk paths');
    await fs.writeFile(path.join(cacheDir, item.video.sha256 + '.mp4'), Buffer.alloc(video.length));
    assert.equal((await offline.play('one')).ok, false, 'same-size corrupt cache must not be playable');
    catalog.revision = 2;
    catalog.items[0] = { ...item, video: { ...item.video, url: 'https://untrusted.example.com/recording.mp4' } };
    const rejected = await controller.list({ refresh: true });
    assert.equal(rejected.data.revision, 1);
    assert.equal(rejected.data.offline, true);
    await fs.rm(path.join(cacheDir, item.video.sha256 + '.mp4'));
    for (const [name, bytes] of [
      ['truncated', video.subarray(0, -1)],
      ['oversized', Buffer.concat([video, Buffer.from('extra')])],
      ['wrong digest', Buffer.alloc(video.length)]
    ]) {
      let previewCalls = 0;
      const invalid = createTutorialsController({ ...options,
        toPreviewUrl: () => { previewCalls += 1; return 'xiaoxi-content://invalid'; },
        transport: async () => Readable.from([bytes])
      });
      const result = await invalid.play('one');
      assert.equal(result.ok, false, `${name} response must not be playable`);
      assert.equal(result.data, undefined, `${name} response must not expose media`);
      assert.equal(previewCalls, 0, `${name} response must not create a preview URL`);
      const files = await fs.readdir(cacheDir);
      assert.equal(files.includes(item.video.sha256 + '.mp4'), false);
      assert.equal(files.some(filename => filename.endsWith('.part')), false, `${name} temporary file must be removed`);
    }
    let started;
    const downloading = new Promise(resolve => { started = resolve; });
    let videoRequests = 0;
    const cancelController = createTutorialsController({ ...options, transport: async () => {
      videoRequests += 1;
      if (videoRequests > 1) return Readable.from([video]);
      return new Readable({ read() { started(); } });
    } });
    const pending = cancelController.play('one');
    await downloading;
    cancelController.cancel('one');
    const retried = Promise.all([cancelController.play('one'), cancelController.play('one')]);
    assert.equal((await pending).ok, false);
    assert.deepEqual((await retried).map(result => result.ok), [true, true], 'immediate concurrent retries must succeed');
    assert.equal(videoRequests, 2, 'concurrent retries must share one new download');
    assert.equal((await fs.readdir(cacheDir)).filter(name => name.endsWith('.part')).length, 0);
    process.stdout.write('tutorials self-check passed\n');
  } finally { await fs.rm(cacheDir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
