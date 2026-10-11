const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const net = require('node:net');
const MAX_FILE = 24 * 1024 * 1024;
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const validId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const wordSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const searchFiller = new Set(['素材', '图片', '视频', '寻找', '想要', '需要', '帮我', '我要', '相关', '一个', '一些', '里面', '可以', '找到']);
function searchWords(value) {
  return [...wordSegmenter.segment(value.toLowerCase())].filter(part => part.isWordLike && part.segment.length >= 2 && !searchFiller.has(part.segment)).map(part => part.segment);
}

function publicUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port)) || !host.includes('.') || net.isIP(host) || host.startsWith('[') || /(?:^|\.)(?:localhost|local|internal)$/.test(host) || /^\d+(?:\.\d+){3}$/.test(host)) return '';
    return url.href;
  } catch { return ''; }
}

function download(url, maxBytes, caPem) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000, ...(caPem ? { ca: caPem } : {}) }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('素材服务暂时不可用')); }
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > maxBytes) res.destroy(new Error('素材文件过大')); else chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('素材下载超时')));
    req.on('error', reject);
  });
}

function createOfficialMaterialsController(options) {
  const { seedDir, cacheDir, baseUrl, getGatewayClient, importFiles, openExternal, toPreviewUrl, emitSearchUpdate = () => {} } = options;
  const transport = options.download || ((url, maxBytes) => download(url, maxBytes, options.caPem));
  const catalogPath = path.join(cacheDir, 'catalog.json');
  const tasks = new Map(); const pendingImports = new Map();
  let catalog; let seedCatalog; let loaded; let searchEnabled = false;
  const errorResult = () => ({ ok: false, error: '暂时无法完成，请检查网络后重试。' });
  function pinned(value) {
    const base = new URL(baseUrl); const url = new URL(value, base);
    if (base.protocol !== 'https:' || url.origin !== base.origin || url.username || url.password || !url.pathname.startsWith('/v1/materials/')) throw new Error('素材地址无效');
    return url.href;
  }
  function validate(raw, seed = false) {
    if (raw.schema !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || !Array.isArray(raw.categories) || !Array.isArray(raw.items) || raw.items.length > 2000) throw new Error('素材目录无效');
    const categoryIds = new Set(raw.categories.map(row => { if (!validId(row.id) || typeof row.label !== 'string') throw new Error('分类无效'); return row.id; }));
    if (raw.withdrawnIds && (!Array.isArray(raw.withdrawnIds) || !raw.withdrawnIds.every(validId))) throw new Error('素材下架目录无效');
    const ids = new Set();
    for (const row of raw.items) {
      if (!validId(row.id) || ids.has(row.id) || !categoryIds.has(row.category) || !['image', 'video'].includes(row.kind) || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes <= 0 || row.sizeBytes > MAX_FILE || !['title', 'description', 'author', 'license'].every(k => typeof row[k] === 'string') || !publicUrl(row.sourceUrl)) throw new Error('素材条目无效');
      ids.add(row.id);
      if (seed) {
        if (typeof row.file !== 'string' || path.basename(row.file) !== row.file || row.file.includes('..')) throw new Error('预装素材路径无效');
        if (row.thumbnailFile && (path.basename(row.thumbnailFile) !== row.thumbnailFile || row.thumbnailFile.includes('..'))) throw new Error('预装封面路径无效');
      } else {
        delete row.seeded; delete row.file; delete row.thumbnailFile;
        pinned(row.downloadUrl); if (row.thumbnailUrl) pinned(row.thumbnailUrl);
      }
    }
    return raw;
  }
  function combine(remote) {
    const removed = new Set([...(remote.withdrawnIds || []), ...remote.items.map(row => row.id)]);
    const categories = new Map(seedCatalog.categories.map(row => [row.id, row]));
    for (const row of remote.categories) categories.set(row.id, row);
    return { ...remote, categories: [...categories.values()], items: [...seedCatalog.items.filter(row => !removed.has(row.id)).map(row => ({ ...row, seeded: true })), ...remote.items] };
  }
  async function load() {
    if (loaded) return loaded;
    loaded = (async () => {
      await fs.mkdir(cacheDir, { recursive: true });
      const seed = validate(JSON.parse(await fs.readFile(path.join(seedDir, 'catalog.json'), 'utf8')), true);
      seedCatalog = seed;
      catalog = { ...seed, items: seed.items.map(row => ({ ...row, seeded: true })) };
      try { const cached = validate(JSON.parse(await fs.readFile(catalogPath, 'utf8'))); catalog = combine(cached); } catch { /* Seed is the offline source of truth until a validated remote catalog exists. */ }
    })();
    try { await loaded; } catch (error) { loaded = null; throw error; }
  }
  function target(row) {
    if (row.seeded) return path.join(seedDir, row.file);
    const extension = path.extname(new URL(row.downloadUrl, baseUrl).pathname).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.mp4'].includes(extension)) throw new Error('素材格式无效');
    return path.join(cacheDir, row.sha256 + extension);
  }
  async function verified(row) { try { const bytes = await fs.readFile(target(row)); return bytes.length === row.sizeBytes && hash(bytes) === row.sha256; } catch { return false; } }
  async function view(row) {
    const local = await verified(row);
    let thumbnailUrl = ''; let previewUrl = '';
    if (local) { previewUrl = toPreviewUrl(target(row)); if (row.kind === 'image') thumbnailUrl = previewUrl; }
    if (row.seeded && row.thumbnailFile) thumbnailUrl = toPreviewUrl(path.join(seedDir, row.thumbnailFile));
    if (!row.seeded && row.thumbnailUrl) {
      const thumbnail = new URL(pinned(row.thumbnailUrl));
      const filename = path.basename(thumbnail.pathname);
      if (/^[a-f0-9]{64}\.(png|jpg|jpeg)$/.test(filename)) {
        const cached = path.join(cacheDir, 'thumb-' + filename);
        try { const bytes = await fs.readFile(cached); if (hash(bytes) === filename.split('.')[0]) thumbnailUrl = toPreviewUrl(cached); } catch { /* Not cached yet. */ }
      }
    }
    const { id, title, category, kind, description, sourceUrl, author, license, sha256, sizeBytes } = row;
    return { id, title, category, kind, description, sourceUrl, author, license, sha256, sizeBytes, thumbnailUrl, previewUrl, downloaded: local };
  }
  async function list({ refresh = false } = {}) {
    try {
      await load();
      if (refresh && baseUrl) {
        try { searchEnabled = (await gateway('/materials/status', {})).enabled === true; } catch { searchEnabled = false; }
        try {
          const next = validate(JSON.parse((await transport(pinned('/v1/materials/catalog'), 2 * 1024 * 1024)).toString('utf8')));
          if (next.revision >= catalog.revision) {
            await fs.writeFile(catalogPath + '.tmp', JSON.stringify(next)); await fs.rename(catalogPath + '.tmp', catalogPath); catalog = combine(next);
            const queue = next.items.filter(row => row.thumbnailUrl && row.thumbnailUrl !== row.downloadUrl);
            await Promise.all(Array.from({ length: 4 }, async () => {
              while (queue.length) {
                const row = queue.shift();
                try {
                  const url = pinned(row.thumbnailUrl), filename = path.basename(new URL(url).pathname);
                  if (!/^[a-f0-9]{64}\.(png|jpg|jpeg)$/.test(filename)) continue;
                  const cached = path.join(cacheDir, 'thumb-' + filename);
                  try { if (hash(await fs.readFile(cached)) === filename.split('.')[0]) continue; } catch { /* Fetch below. */ }
                  const bytes = await transport(url, 512 * 1024);
                  if (hash(bytes) !== filename.split('.')[0]) continue;
                  await fs.writeFile(cached, bytes);
                } catch { /* Keep cached media usable if individual thumbnails fail. */ }
              }
            }));
          }
        } catch { /* Continue showing verified local catalog during outages. */ }
      }
      return { ok: true, data: { revision: catalog.revision, categories: catalog.categories, items: await Promise.all(catalog.items.map(view)), searchEnabled } };
    } catch { return errorResult(); }
  }
  async function importMaterial(id) {
    if (pendingImports.has(id)) return pendingImports.get(id);
    const operation = (async () => {
      try {
        const row = await ensureMaterial(id);
        return { ok: true, data: await importFiles([target(row)]) };
      } catch { return errorResult(); }
    })();
    pendingImports.set(id, operation);
    try { return await operation; } finally { pendingImports.delete(id); }
  }
  const pendingDownloads = new Map();
  async function ensureMaterial(id) {
    await load(); const row = catalog.items.find(item => item.id === id); if (!row) throw new Error('素材不存在');
    if (await verified(row)) return row;
    if (row.seeded) throw new Error('预装素材损坏');
    if (!pendingDownloads.has(row.sha256)) {
      const operation = (async () => {
        const bytes = await transport(pinned(row.downloadUrl), Math.min(MAX_FILE, row.sizeBytes));
        if (bytes.length !== row.sizeBytes || hash(bytes) !== row.sha256) throw new Error('素材校验失败');
        await fs.writeFile(target(row) + '.tmp', bytes); await fs.rename(target(row) + '.tmp', target(row));
      })();
      pendingDownloads.set(row.sha256, operation);
    }
    try { await pendingDownloads.get(row.sha256); return row; } finally { pendingDownloads.delete(row.sha256); }
  }
  async function previewMaterial(id) {
    try { return { ok: true, data: await view(await ensureMaterial(id)) }; } catch { return errorResult(); }
  }
  async function openSource(url) {
    const safe = publicUrl(url); if (!safe) return errorResult();
    try { await openExternal(safe); return { ok: true }; } catch { return errorResult(); }
  }
  async function gateway(route, body) {
    const client = getGatewayClient();
    const response = await client.fetch(client.url(route), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 45000, maxBytes: 2 * 1024 * 1024 });
    if (!response.ok) throw new Error('搜索服务暂时不可用');
    return response.json();
  }
  async function search({ taskId, query, localOnly = false } = {}) {
    if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(taskId) || typeof query !== 'string' || !query.trim() || query.length > 300 || tasks.has(taskId)) return errorResult();
    const task = { cancelled: false, localOnly }; tasks.set(taskId, task);
    let items = []; let round = 0;
    const update = (status, message) => { const data = { taskId, status, round, items: [...items], ...(message ? { message } : {}) }; task.lastUpdate = data; emitSearchUpdate(data); return { ok: true, data }; };
    try {
      await load();
      const words = searchWords(query);
      items = catalog.items.filter(row => {
        const category = catalog.categories.find(c => c.id === row.category)?.label || '';
        const haystack = `${row.title} ${row.description} ${category}`.toLowerCase();
        return words.some(word => haystack.includes(word)) || [row.title, category].some(term => term && query.toLowerCase().includes(term.toLowerCase()));
      }).map(row => ({ id: row.id, materialId: row.id, title: row.title, url: row.sourceUrl, description: row.description, source: '官方素材', usage: 'usable' }));
      if (task.cancelled) return update('cancelled');
      if (localOnly) return update('completed', items.length ? '已找到相关官方素材。联网搜索尚未启用。' : '官方仓库暂无相关素材，可以换个行业名称继续寻找。联网搜索尚未启用。');
      update('searching', '已先查找官方素材，正在查询相关网页。');
      let message = '';
      for (round = 1; round <= 2; round++) {
        if (task.cancelled) return update('cancelled');
        const result = await gateway('/materials/search', { taskId, query: round === 1 ? query : `${query} 视频 素材 企业官网`, round });
        if (task.cancelled || result.status === 'cancelled') return update('cancelled');
        if (result.enabled === false) searchEnabled = false;
        else if (result.items?.length) searchEnabled = true;
        message = result.message || '';
        const external = (Array.isArray(result.items) ? result.items : []).filter(item => item && publicUrl(item.url)).map(item => ({ id: String(item.id || hash(item.url)).slice(0, 100), title: String(item.title || item.url).slice(0, 200), url: publicUrl(item.url), description: String(item.description || '').slice(0, 1200), source: String(item.source || new URL(item.url).hostname).slice(0, 200), usage: 'reference' }));
        const seen = new Set(items.map(item => item.url)); for (const item of external) if (!seen.has(item.url)) { seen.add(item.url); items.push(item); }
        if (result.status === 'failed') return update('failed', message);
        if (result.enabled === false || external.length >= 5 || message || round === 2) break;
        update('searching', '准确结果较少，正在扩大关键词查找。');
      }
      return update('completed', message || (items.length ? '网页结果供参考，请在原网站查看使用条件。' : '未找到准确素材，可换一个行业名称或机器型号继续寻找。'));
    } catch { return update(task.cancelled ? 'cancelled' : 'failed', task.cancelled ? '' : '联网搜索暂时不可用，已保留找到的官方素材。'); }
    finally { tasks.delete(taskId); }
  }
  async function cancelSearch(taskId) {
    const task = tasks.get(taskId); if (task) task.cancelled = true;
    if (!task || task.localOnly) return { ok: true };
    emitSearchUpdate({ ...(task.lastUpdate || { taskId, round: 0, items: [] }), status: 'cancelled', message: '已停止寻找。' });
    void gateway('/materials/cancel', { taskId }).catch(() => {});
    return { ok: true };
  }
  return { list, previewMaterial, importMaterial, openSource, search, cancelSearch };
}

module.exports = { createOfficialMaterialsController, publicUrl };
