const https = require('node:https');
const { createHash } = require('node:crypto');
const { safeLookup } = require('./digital-human-provider.cjs');
const catalog = require('../shared/precise-public-sources.json');
const equipmentCatalog = require('../shared/cleaning-equipment.json');
const { inspectDocumentImages } = require('./precise-document-images.cjs');

const MAX_BYTES = 2 * 1024 * 1024;
const decode = value => value.replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
  const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
  return code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
}).replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[n.toLowerCase()]);
function pageText(html) {
  return decode(html.replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\r]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}
function indexUrlAllowed(u, source) {
  return u.href === source.indexUrl || Boolean(source.pagination?.pathPattern && !u.search && new RegExp(source.pagination.pathPattern).test(u.pathname));
}
function articleUrlAllowed(u, source) {
  return source.articlePattern ? new RegExp(source.articlePattern).test(u.pathname) : u.pathname.startsWith(source.articlePath);
}
function authorizedUrl(value, sources) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port && u.port !== '443') throw Error('PUBLIC_SOURCE_NOT_AUTHORIZED');
  const source = sources.find(s => s.enabled && s.host === u.hostname);
  if (!source || !(indexUrlAllowed(u, source) || articleUrlAllowed(u, source) || u.pathname === '/robots.txt')) throw Error('PUBLIC_SOURCE_NOT_AUTHORIZED');
  u.hash = ''; return { url: u.href, source };
}
function requestPage(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => req.destroy(Error('PUBLIC_SOURCE_TIMEOUT')), 20000);
    const req = https.get(url, { lookup: safeLookup, agent: false, headers: { 'User-Agent': 'XiaoxiEvidence/1.0', Accept: 'text/html,text/plain', 'Accept-Encoding': 'identity' } }, response => {
      let size = 0; const chunks = [];
      response.on('error', reject);
      response.on('data', chunk => { size += chunk.length; if (size > MAX_BYTES) response.destroy(Error('PUBLIC_SOURCE_TOO_LARGE')); else chunks.push(chunk); });
      response.on('end', () => {
        const raw = Buffer.concat(chunks), contentType = String(response.headers['content-type'] || '');
        const charset = contentType.match(/charset\s*=\s*([\w-]+)/i)?.[1] || raw.toString('ascii', 0, 2000).match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
        try { resolve({ status: response.statusCode, raw, html: /zip|officedocument|octet-stream/i.test(contentType) ? '' : new TextDecoder(charset).decode(raw), contentType, location: response.headers.location }); }
        catch { reject(Error('PUBLIC_SOURCE_ENCODING_UNSUPPORTED')); }
      });
    });
    req.on('error', reject); req.on('close', () => clearTimeout(timer));
  });
}
function robotsAllowed(content, pathname) {
  // Apply the most specific agent group; the longest matching path wins.
  const groups = []; let group = null, rulesStarted = false;
  for (const line of content.split(/\r?\n/)) {
    const match = line.replace(/#.*/, '').trim().match(/^(user-agent|allow|disallow):\s*(.*)$/i);
    if (!match) continue;
    const key = match[1].toLowerCase(), value = match[2].trim();
    if (key === 'user-agent') {
      if (!group || rulesStarted) { group = { agents: [], rules: [] }; groups.push(group); rulesStarted = false; }
      group.agents.push(value.toLowerCase());
    } else if (group) { rulesStarted = true; if (value) group.rules.push({ allow: key === 'allow', path: value }); }
  }
  const exact = groups.filter(g => g.agents.some(a => a !== '*' && 'xiaoxievidence'.includes(a)));
  const rules = (exact.length ? exact : groups.filter(g => g.agents.includes('*'))).flatMap(g => g.rules);
  const matches = rules.filter(r => new RegExp('^' + r.path.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*').replace(/\\\$$/, '$')).test(pathname));
  matches.sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return !matches.length || matches[0].allow;
}
function createPublicSources({ sources = catalog, fetchPage = requestPage, clock = Date.now } = {}) {
  const robots = new Map(), pages = new Map(), pending = new Map(), sourceState = new Map(), documents = new Map();
  let active = 0;
  function status() {
    const available = sources.filter(s => s.enabled);
    return { search: available.length > 0, read: available.length > 0, pdf: false, professional: false, mode: 'public-index',
      reason: available.length ? '已接入部分企业官网公开目录；覆盖尚在验证，不代表所选城市全部商机。付费搜索保持关闭。' : '尚无可执行公开来源，可导入原文',
      coverage: ['嘉兴市', '杭州市', '宁波市'].flatMap(city => ['procurement', 'award', 'delivery'].map(signal => ({ city, signal, status: 'pending', reason: signal !== 'procurement' ? '后续独立验收，暂不自动检索' : city === '杭州市' ? '已发现原文正例，自动处理及持续供给待验收' : '来源覆盖与有效正例尚未全部验收' }))),
      sources: sources.map(s => ({ id: s.id, name: s.name, enabled: s.enabled, scope: s.scope, reason: s.reason, capabilities: { directory: Boolean(s.indexUrl), pagination: Boolean(s.pagination), original: Boolean(s.articlePath || s.articlePattern), attachments: Boolean(s.attachments) }, paginationReason: s.pagination ? '' : '目录翻页尚未接通，仅检查已公开目录页', ...sourceState.get(s.id) })) };
  }
  async function load(raw, redirects = 0) {
    if (redirects > 3) throw Error('PUBLIC_SOURCE_REDIRECT_LIMIT');
    const { url } = authorizedUrl(raw, sources), u = new URL(url);
    const policyKey = u.origin;
    let policy = robots.get(policyKey);
    if (!policy || clock() - policy.at > 3600_000) {
      const result = await fetchPage(`${policyKey}/robots.txt`);
      if (result.status !== 404 && (result.status !== 200 || /<html|<!doctype/i.test(result.html))) throw Error('PUBLIC_SOURCE_POLICY_UNAVAILABLE');
      // A genuine 404 means no robots file, not an explicit Allow directive.
      policy = { at: clock(), text: result.status === 404 ? '' : result.html }; robots.set(policyKey, policy);
    }
    if (!robotsAllowed(policy.text, u.pathname + u.search)) throw Error('PUBLIC_SOURCE_DISALLOWED');
    const result = await fetchPage(url);
    if ([301, 302, 303, 307, 308].includes(result.status)) return load(new URL(result.location, url).href, redirects + 1);
    if (result.status !== 200) throw Error(`PUBLIC_SOURCE_HTTP_${result.status}`);
    if (!/text\/(html|plain)|application\/xhtml\+xml/i.test(result.contentType)) throw Error('PUBLIC_SOURCE_FORMAT_UNSUPPORTED');
    return { ...result, resolvedUrl: url, fetchedAt: new Date(clock()).toISOString() };
  }
  async function cached(raw) {
    const { url } = authorizedUrl(raw, sources);
    const previous = pages.get(url);
    if (previous && clock() - previous.at < 15 * 60000) { if (previous.error) throw previous.error; return { ...previous.value, cacheHit: true }; }
    const remember = row => { pages.set(url, { at: clock(), ...row }); if (pages.size > 50) pages.delete(pages.keys().next().value); };
    if (!pending.has(url)) pending.set(url, load(url).then(value => { remember({ value }); return value; }, error => { remember({ error }); throw error; }).finally(() => pending.delete(url)));
    return { ...await pending.get(url), cacheHit: false };
  }
  async function search(body) {
    const items = [], failures = [];
    const query = String(body.query || '');
    const equipment = equipmentCatalog.filter(e => [e.name, ...e.aliases].some(a => query.includes(a))).flatMap(e => e.aliases);
    const excluded = new Set(Array.isArray(body.excludeUrls) ? body.excludeUrls : []);
    const relevant = title => {
      // An issuer called a property company may be buying milk or fire equipment.
      const subject = title.replace(/^[^\n]*?(?:有限公司|有限责任公司|分公司)/, '');
      return equipment.some(k => subject.includes(k))
        || /保洁|物业/.test(query) && /保洁(?:服务|项目)|物业(?:管理)?(?:服务|承包)(?!分公司|有限公司)/.test(subject)
        || /交付|搬迁|装修收尾/.test(query) && /交付|搬迁|装修收尾/.test(subject);
    };
    const enabled = sources.filter(s => s.enabled && (!body.city || !s.cities?.length || s.cities.some(city => city.replace(/市$/, '') === String(body.city).replace(/市$/, ''))));
    const signature = createHash('sha256').update(JSON.stringify([query, body.city || '', enabled.map(s => s.id)])).digest('hex');
    const prior = body.cursor;
    if (prior && (prior.version !== 1 || prior.signature !== signature || !Array.isArray(prior.frontier) || !Array.isArray(prior.remaining) || !Array.isArray(prior.seen))) throw Error('PUBLIC_SOURCE_CURSOR_MISMATCH');
    const frontier = prior ? [...prior.frontier] : enabled.map(s => ({ sourceId: s.id, url: s.indexUrl }));
    const seen = new Set(prior?.seen || []), trace = [], remaining = [...(prior?.remaining || [])];
    const maxPages = Math.max(0, Math.min(12, Math.floor(Number(body.maxPages ?? 12) || 0)));
    const limit = Math.max(1, Math.min(10, Math.floor(Number(body.limit ?? 10) || 10)));
    const deadlineAt = Number(body.deadlineAt) || clock() + 300000;
    let pagesRead = 0;
    function add(item) { if (!excluded.has(item.url) && !items.some(i => i.url === item.url)) items.push(item); }
    while (remaining.length && items.length < limit) add(remaining.shift());
    while (frontier.length && pagesRead < maxPages && items.length < limit && clock() < deadlineAt) {
      const entry = frontier.shift(), source = enabled.find(s => s.id === entry.sourceId);
      if (!source || seen.has(entry.url)) continue;
      const checked = authorizedUrl(entry.url, sources);
      if (checked.source.id !== source.id || !indexUrlAllowed(new URL(checked.url), source)) throw Error('PUBLIC_SOURCE_CURSOR_INVALID');
      seen.add(entry.url); pagesRead++;
      try {
        const page = await cached(entry.url);
        const found = [...page.html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
        let articleCount = 0;
        const pageCandidates = new Set();
        for (const match of found) {
          let candidate; try { candidate = authorizedUrl(new URL(decode(match[1]), page.resolvedUrl).href, sources); } catch { continue; }
          if (candidate.source.id !== source.id) continue;
          const u = new URL(candidate.url);
          if (indexUrlAllowed(u, source)) {
            if (candidate.url !== entry.url && /class=["'][^"']*\bnext\b|rel=["']next["']|下一页/i.test(match[0]) && !seen.has(candidate.url) && !frontier.some(f => f.url === candidate.url)) frontier.push({ sourceId: source.id, url: candidate.url });
            continue;
          }
          if (!articleUrlAllowed(u, source)) continue;
          articleCount++;
          const title = pageText(match[2]);
          if (excluded.has(candidate.url) || !title || !relevant(title)) continue;
          pageCandidates.add(candidate.url);
          const item = { url: candidate.url, title: title.slice(0, 300), discoveryOnly: true, sourceId: source.id };
          if (items.length < limit) add(item);
          else if (!remaining.some(i => i.url === item.url) && !items.some(i => i.url === item.url)) remaining.push(item);
        }
        trace.push({ sourceId: source.id, url: entry.url, cacheHit: page.cacheHit, fetchedAt: page.fetchedAt, candidates: pageCandidates.size });
        if (!articleCount) throw Error('PUBLIC_SOURCE_INDEX_INCOMPLETE');
        sourceState.set(source.id, { status: 'completed', checkedAt: new Date(clock()).toISOString() });
      } catch (error) {
        const code = /^PUBLIC_SOURCE_[A-Z0-9_]+$/.test(error.message) ? error.message : 'PUBLIC_SOURCE_UNAVAILABLE';
        failures.push({ sourceId: source.id, url: entry.url, code }); sourceState.set(source.id, { status: 'unavailable', code, checkedAt: new Date(clock()).toISOString() });
        const row = trace.find(t => t.url === entry.url);
        if (row) row.error = code; else trace.push({ sourceId: source.id, url: entry.url, error: code, candidates: 0 });
      }
    }
    const exhausted = !frontier.length && !remaining.length;
    const cursor = { version: 1, signature, frontier, remaining, seen: [...seen] };
    return { enabled: enabled.length > 0, status: failures.length && !trace.some(t => !t.error) ? 'unavailable' : 'completed', items, failures, mode: 'public-index', cursor, exhausted, trace, pagesRead,
      message: failures.length ? '部分公开目录不可读取；不代表当地没有客户' : '', coverage: '仅已接入的公开目录及已读取分页，不是全网搜索', usage: { billableRequests: 0 } };
  }
  async function read(url, { maxAttachments = 3 } = {}) {
    try {
      const maximum = Math.max(0, Math.min(3, Math.floor(Number(maxAttachments) || 0)));
      const cacheKey = `${url}|${maximum}`, saved = documents.get(cacheKey);
      if (saved && clock() - saved.at < 15 * 60000) return { ...JSON.parse(JSON.stringify(saved.value)), cacheHit: true };
      const page = await cached(url), text = pageText(page.html);
      if (!text || /验证|captcha|access denied|forbidden/i.test(text) && text.length < 1000) throw Error('PUBLIC_SOURCE_CHALLENGE');
      const embeddedDocument = /<(?:iframe|embed)\b/i.test(page.html);
      const { source: definition } = authorizedUrl(page.resolvedUrl, sources);
      const links = [...page.html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].filter(m => /\.(?:docx?|pdf|xlsx?|zip)(?:\s|$)/i.test(pageText(m[2])));
      const attachments = [];
      for (const link of links.slice(0, maximum)) {
        const title = pageText(link[2]); let attachmentUrl = '';
        try {
          attachmentUrl = new URL(decode(link[1]), page.resolvedUrl).href;
          const u = new URL(attachmentUrl), rule = definition.attachments;
          if (!rule || u.protocol !== 'https:' || u.origin !== rule.origin || u.pathname !== rule.path || u.username || u.password || !/\.docx$/i.test(title)
            || [...u.searchParams.keys()].sort().join(',') !== 'GetDoc,Source' || u.searchParams.get('GetDoc') !== '' || !/^[\da-f-]{36}$/i.test(u.searchParams.get('Source') || '')) throw Error('PUBLIC_ATTACHMENT_NOT_AUTHORIZED');
          const policy = await fetchPage(`${u.origin}/robots.txt`);
          if (policy.status !== 404 && (policy.status !== 200 || /<html|<!doctype/i.test(policy.html) || !robotsAllowed(policy.html, u.pathname + u.search))) throw Error('PUBLIC_ATTACHMENT_POLICY_UNAVAILABLE');
          const result = await fetchPage(u.href);
          if (result.status !== 200 || !result.raw?.subarray(0, 2).equals(Buffer.from('PK'))) throw Error('PUBLIC_ATTACHMENT_UNAVAILABLE');
          const zip = await require('jszip').loadAsync(result.raw);
          const entry = zip.file('word/document.xml');
          if (!entry || Object.keys(zip.files).length > 500 || entry._data.uncompressedSize > 4 * 1024 * 1024) throw Error('PUBLIC_ATTACHMENT_TOO_LARGE');
          const xml = await new Promise((resolve, reject) => {
            const stream = entry.nodeStream(), chunks = []; let bytes = 0;
            stream.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) stream.destroy(Error('PUBLIC_ATTACHMENT_TOO_LARGE')); else chunks.push(chunk); });
            stream.on('error', reject); stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          });
          const body = pageText(xml.replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, '\t'));
          if (!body || body.length > 120000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error('PUBLIC_ATTACHMENT_PARSE_INCOMPLETE');
          const imageAnalysis = await inspectDocumentImages(zip, xml, value => pageText(value.replace(/<\/w:p>/g, '\n')));
          attachments.push({ title, url: u.href, text: body, contentHash: createHash('sha256').update(result.raw).digest('hex'), status: 'completed', ...imageAnalysis, origin: 'public-attachment', parentUrl: page.resolvedUrl });
        } catch (error) { attachments.push({ title, url: attachmentUrl, text: '', status: 'unavailable', reason: /^PUBLIC_ATTACHMENT_/.test(error.message) ? error.message : 'PUBLIC_ATTACHMENT_PARSE_FAILED' }); }
      }
      const value = { status: 'completed', text: text.slice(0, 120000), attachments, parseIncomplete: embeddedDocument || links.length > maximum || attachments.some(a => a.status !== 'completed' || a.parseIncomplete) || text.length > 120000 || text.includes('\ufffd'), resolvedUrl: page.resolvedUrl,
        title: pageText(page.html.match(/<[^>]+class=["'][^"']*breadcrumb-item\s+active[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1] || page.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''), fetchedAt: page.fetchedAt, cacheHit: page.cacheHit && !attachments.length, contentHash: createHash('sha256').update(text).digest('hex'), origin: 'public-original', usage: { billableRequests: 0 } };
      documents.set(cacheKey, { at: clock(), value }); if (documents.size > 30) documents.delete(documents.keys().next().value);
      return JSON.parse(JSON.stringify(value));
    } catch (error) { return { status: 'unavailable', text: '', reason: /^PUBLIC_SOURCE_[A-Z0-9_]+$/.test(error.message) ? error.message : 'PUBLIC_SOURCE_UNAVAILABLE' }; }
  }
  function refresh() {
    if (active || pending.size) throw Error('PUBLIC_SOURCE_BUSY');
    robots.clear(); pages.clear(); documents.clear();
    return { status: 'completed' };
  }
  function updateCatalog(value) {
    if (active || pending.size) throw Error('PUBLIC_SOURCE_BUSY');
    if (!Array.isArray(value) || value.length > 100 || !value.every(s => typeof s.id === 'string' && typeof s.host === 'string' && /^[a-z0-9.-]+$/.test(s.host) && (!s.enabled || typeof s.articlePath === 'string' && s.articlePath.startsWith('/') && s.articlePath.length > 1 && new URL(s.indexUrl).hostname === s.host))) throw Error('PUBLIC_SOURCE_CATALOG_INVALID');
    sources = value; robots.clear(); pages.clear(); sourceState.clear(); documents.clear();
  }
  const guarded = fn => async (...args) => { active++; try { return await fn(...args); } finally { active--; } };
  return { status, search: guarded(search), read: guarded(read), refresh, updateCatalog };
}
module.exports = { createPublicSources, pageText, robotsAllowed, authorizedUrl, requestPage };
