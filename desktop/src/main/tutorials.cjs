const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { hashFile } = require('../shared/component-contract.cjs');

const CATEGORIES = ['short-video', 'wechat', 'product-detail', 'materials'];
const TOPICS = ['digital-human', 'ai-editing', 'product-video'];
const EMPTY = { schema: 1, revision: 0, items: [] };
const MAX_VIDEO = 256 * 1024 * 1024;

function request(url, caPem, signal) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000, signal, ...(caPem ? { ca: caPem } : {}) }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('tutorials_service_unavailable')); }
      else resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('tutorials_timeout')));
    req.on('error', reject);
  });
}

function createTutorialsController({ cacheDir, baseUrl, caPem, toPreviewUrl, emitProgress = () => {}, transport = request }) {
  let catalog = EMPTY;
  let initialized;
  let refreshing;
  const pending = new Map();
  const catalogPath = path.join(cacheDir, 'catalog.json');
  function pinned(value) {
    const base = new URL(baseUrl);
    const url = new URL(value, base);
    if (base.protocol !== 'https:' || url.origin !== base.origin || url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/v1/tutorials/')) throw new Error('tutorials_url_invalid');
    return url.href;
  }
  function validate(raw) {
    if (raw?.schema !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || !Array.isArray(raw.items) || raw.items.length > 2000) throw new Error('tutorials_catalog_invalid');
    const ids = new Set();
    const items = raw.items.map(row => {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(row.id) || ids.has(row.id) || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 120 || !CATEGORIES.includes(row.category) || (row.topic && (row.category !== 'short-video' || !TOPICS.includes(row.topic)))) throw new Error('tutorials_item_invalid');
      ids.add(row.id);
      const item = { id: row.id, title: row.title, category: row.category, topic: row.topic || '' };
      for (const key of ['cover', 'video']) {
        const file = row[key];
        const suffix = key === 'video' ? 'mp4' : '(?:jpg|png)';
        if (!file || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0 || file.sizeBytes > (key === 'video' ? MAX_VIDEO : 2 * 1024 * 1024) || !new RegExp(`^/v1/tutorials/files/${file.sha256}\\.${suffix}$`).test(file.url)) throw new Error('tutorials_file_invalid');
        // Cached metadata is usable even when the maintenance connection is off.
        // The exact relative path above is validated here; pin the origin only
        // when making a network request.
        item[key] = { url: file.url, sha256: file.sha256, sizeBytes: file.sizeBytes };
      }
      if (!Number.isFinite(row.video.durationSeconds) || row.video.durationSeconds <= 0 || row.video.durationSeconds > 305) throw new Error('tutorials_duration_invalid');
      item.video.durationSeconds = row.video.durationSeconds;
      return item;
    });
    return { schema: 1, revision: raw.revision, items };
  }
  async function load() {
    if (!initialized) initialized = (async () => {
      await fsp.mkdir(cacheDir, { recursive: true });
      try { catalog = validate(JSON.parse(await fsp.readFile(catalogPath, 'utf8'))); } catch { /* Honest empty state before the first usable catalog. */ }
    })().catch(error => { initialized = null; throw error; });
    return initialized;
  }
  const target = file => path.join(cacheDir, path.posix.basename(file.url));
  async function verified(file) {
    try {
      if ((await fsp.stat(target(file))).size !== file.sizeBytes) return false;
      return await hashFile(target(file)) === file.sha256;
    } catch { return false; }
  }
  async function download(file, signal, progress = () => {}) {
    if (await verified(file)) return target(file);
    const temporary = target(file) + '.' + crypto.randomUUID() + '.part';
    const hash = crypto.createHash('sha256');
    let size = 0;
    try {
      const response = await transport(pinned(file.url), caPem, signal);
      const inspect = new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > file.sizeBytes) return callback(new Error('tutorials_size_invalid'));
        hash.update(chunk); progress(size / file.sizeBytes);
        callback(null, chunk);
      } });
      await pipeline(response, inspect, fs.createWriteStream(temporary), ...(signal ? [{ signal }] : []));
      if (size !== file.sizeBytes || hash.digest('hex') !== file.sha256) throw new Error('tutorials_integrity_invalid');
      await fsp.rename(temporary, target(file));
      return target(file);
    } finally { await fsp.rm(temporary, { force: true }).catch(() => {}); }
  }
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const response = await transport(pinned('/v1/tutorials/catalog'), caPem);
      let length = 0; const chunks = [];
      for await (const chunk of response) {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) { response.destroy(); throw new Error('tutorials_catalog_too_large'); }
        chunks.push(chunk);
      }
      const next = validate(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (next.revision < catalog.revision) throw new Error('tutorials_catalog_stale');
      await fsp.writeFile(catalogPath + '.tmp', JSON.stringify(next));
      await fsp.rename(catalogPath + '.tmp', catalogPath);
      catalog = next;
      // Cover failures must not hide otherwise usable recordings or the cached catalog.
      const covers = [...new Map(next.items.map(item => [item.cover.sha256, item.cover])).values()];
      let nextCover = 0;
      await Promise.all(Array.from({ length: Math.min(4, covers.length) }, async () => {
        while (nextCover < covers.length) await download(covers[nextCover++]).catch(() => {});
      }));
    })();
    try { await refreshing; } finally { refreshing = null; }
  }
  async function list({ refresh: shouldRefresh = false } = {}) {
    try {
      await load();
      let offline = !baseUrl;
      if (shouldRefresh && baseUrl) { try { await refresh(); } catch { offline = true; } }
      const items = await Promise.all(catalog.items.map(async item => ({
        id: item.id, title: item.title, category: item.category, topic: item.topic,
        durationSeconds: item.video.durationSeconds,
        coverUrl: await verified(item.cover) ? toPreviewUrl(target(item.cover)) : '',
        // This label checks presence only; play always hashes before exposing media.
        availableOffline: await fsp.stat(target(item.video)).then(stat => stat.isFile() && stat.size === item.video.sizeBytes).catch(() => false)
      })));
      return { ok: true, data: { revision: catalog.revision, items, offline } };
    } catch { return { ok: false, error: '教程暂时无法读取，请稍后重试。' }; }
  }
  async function play(id) {
    if (typeof id !== 'string') return { ok: false, error: '请重新选择教程。' };
    const existing = pending.get(id);
    if (existing) {
      if (!existing.abort.signal.aborted) return existing.promise;
      // Let cancellation finish removing its temporary file before retrying.
      // Re-enter through the map so simultaneous retries share one download.
      await existing.promise;
      return play(id);
    }
    const abort = new AbortController();
    let lastPercent = -1;
    const promise = (async () => {
      try {
        await load();
        const item = catalog.items.find(row => row.id === id);
        if (!item) return { ok: false, error: '这段教程已下架，请刷新后选择其他教程。' };
        const filename = await download(item.video, abort.signal, value => {
          const percent = Math.floor(value * 100);
          if (percent !== lastPercent) { lastPercent = percent; emitProgress({ id, percent }); }
        });
        return { ok: true, data: { id, url: toPreviewUrl(filename) } };
      } catch { return { ok: false, error: abort.signal.aborted ? '已取消准备播放。' : '教程未准备好，请检查网络或可用空间后重试。' }; }
      finally { pending.delete(id); }
    })();
    pending.set(id, { abort, promise });
    return promise;
  }
  function cancel(id) { pending.get(id)?.abort.abort(); return { ok: true }; }
  return { list, play, cancel };
}
module.exports = { createTutorialsController };
