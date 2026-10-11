const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createOfficialMaterialsController, publicUrl } = require('./official-materials.cjs');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'official-materials-'));
  try {
    const seedDir = path.join(root, 'seed'); await fs.mkdir(seedDir);
    const bytes = Buffer.from('fixture-image');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const thumbBytes = Buffer.from('thumbnail'), thumbnailHash = crypto.createHash('sha256').update(thumbBytes).digest('hex');
    const row = { id: 'factory', title: '工厂机器人', category: 'factory', kind: 'image', description: '工厂生产场景', sourceUrl: 'https://example.com/source', author: 'Fixture', license: 'CC0', sha256, sizeBytes: bytes.length, file: 'factory.png' };
    const seed = { schema: 1, revision: 1, categories: [{ id: 'factory', label: '工厂' }, { id: 'community', label: '小区' }], items: [row, { ...row, id: 'community', title: '住宅环境', category: 'community', description: '小区绿化' }] };
    await fs.writeFile(path.join(seedDir, 'catalog.json'), JSON.stringify(seed)); await fs.writeFile(path.join(seedDir, row.file), bytes);
    let downloads = 0; let requests = 0; const updates = []; const fetched = [];
    const options = { seedDir, cacheDir: path.join(root, 'cache'), baseUrl: 'https://materials.example.com',
      toPreviewUrl: file => 'app-media://official/' + path.basename(file),
      importFiles: async files => { assert.equal((await fs.readFile(files[0])).toString(), bytes.toString()); return { assetIds: ['asset-existing'] }; },
      openExternal: async url => assert.equal(url, row.sourceUrl),
      getGatewayClient: () => ({ url: suffix => suffix, fetch: async (_url, opts) => { requests++; const body = JSON.parse(opts.body); return { ok: true, json: async () => ({ ...body, status: 'completed', enabled: false, items: [], message: '联网搜索未启用' }) }; } }),
      emitSearchUpdate: update => updates.push(update),
      download: async url => { downloads++; fetched.push(url); if (url.endsWith('/catalog')) return Buffer.from(JSON.stringify({ ...seed, revision: 2, items: [{ ...row, file: undefined, downloadUrl: '/v1/materials/files/' + sha256 + '.png', thumbnailUrl: '/v1/materials/files/' + thumbnailHash + '.png' }] })); return url.includes(thumbnailHash) ? thumbBytes : bytes; }
    };
    const controller = createOfficialMaterialsController(options);
    assert.equal((await controller.list()).data.items[0].downloaded, true);
    assert.equal(downloads, 0);
    assert.deepEqual((await controller.importMaterial('factory')).data.assetIds, ['asset-existing']);
    await controller.list({ refresh: true });
    assert.equal(fetched.some(url => url.includes(sha256)), false, 'catalog refresh must not download original files');
    await Promise.all([controller.importMaterial('factory'), controller.importMaterial('factory')]);
    const downloaded = downloads;
    await controller.importMaterial('factory'); assert.equal(downloads, downloaded);
    const found = await controller.search({ taskId: 'search-task-1', query: '工厂' });
    assert.equal(found.data.status, 'completed'); assert.equal(found.data.items[0].usage, 'usable'); assert.equal(requests, 2);
    const beforeLocalSearch = requests;
    const natural = await controller.search({ taskId: 'local-search-1', query: '工厂里的清洁机器人', localOnly: true });
    assert.equal(natural.data.items[0].materialId, 'factory');
    const community = await controller.search({ taskId: 'local-search-2', query: '小区素材', localOnly: true });
    assert.equal(community.data.items[0].materialId, 'community');
    assert.equal(requests, beforeLocalSearch, 'localOnly must never reach gateway');
    assert.ok((await controller.previewMaterial('factory')).data.previewUrl.startsWith('app-media://official/'));
    assert.equal((await controller.openSource('http://127.0.0.1/private')).ok, false);
    assert.equal(publicUrl('file:///C:/secret'), '');
    assert.equal((await controller.openSource(row.sourceUrl)).ok, true);
    assert.equal(updates[0].status, 'searching');
    let finishSearch, startedSearch; const started = new Promise(resolve => { startedSearch = resolve; });
    const cancelUpdates = [];
    const cancellable = createOfficialMaterialsController({ ...options, emitSearchUpdate: update => cancelUpdates.push(update), getGatewayClient: () => ({ url: suffix => suffix, fetch: route => {
      if (route.endsWith('/cancel')) return new Promise(() => {});
      startedSearch(); return new Promise(resolve => { finishSearch = resolve; });
    } }) });
    const searching = cancellable.search({ taskId: 'cancel-search-1', query: '工厂' });
    await started;
    await cancellable.cancelSearch('cancel-search-1');
    assert.equal(cancelUpdates.at(-1).status, 'cancelled');
    finishSearch({ ok: true, json: async () => ({ status: 'completed', items: [{ id: 'late', title: 'late', url: 'https://example.com/late' }] }) });
    assert.equal((await searching).data.status, 'cancelled');
    assert.equal(cancelUpdates.some(update => update.items.some(item => item.id === 'late')), false);
    console.log('official materials self-check passed');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
