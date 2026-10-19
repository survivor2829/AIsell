const { randomUUID } = require('node:crypto');
const { fail } = require('./digital-human-provider.cjs');
const { assertKeys } = require('./digital-human-service.cjs');
const { createNarrationBrowser } = require('./narration-browser.cjs');

// Fixed, read-only browser bridge protocol (OpenCLI 1.8.8). No CLI execution,
// cookie export, arbitrary renderer JS, or automatic browser installation.
const PLATFORMS = {
  douyin: { name: '抖音', home: 'https://www.douyin.com/', search: (q) => `https://www.douyin.com/search/${encodeURIComponent(q)}?type=video`, hosts: ['www.douyin.com', 'v.douyin.com'] },
  xiaohongshu: { name: '小红书', home: 'https://www.xiaohongshu.com/', search: (q) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(q)}&source=web_search_result_notes`, hosts: ['www.xiaohongshu.com', 'xhslink.com'] },
};
function sourceUrl(value, platform) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !PLATFORMS[platform]?.hosts.includes(url.hostname)) throw fail('reference_source_url', '请选择抖音或小红书的官方内容链接，解析不了时可以直接粘贴文案。');
  return url.href;
}
function validateReference(value) {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw fail('reference_source_invalid', '参考资料格式无效。');
  const text = (key, max) => { const v = value[key] ?? ''; if (typeof v !== 'string' || v.length > max) throw fail('reference_source_invalid', '参考资料过长，请精简后重试。'); return v.trim(); };
  const platform = text('platform', 32) || 'manual';
  if (!['douyin', 'xiaohongshu', 'manual', 'web'].includes(platform)) throw fail('reference_source_invalid', '参考来源无效。');
  const url = text('url', 2000);
  if (url) { const u = new URL(url); if (u.protocol !== 'https:' || u.username || u.password) throw fail('reference_source_url', '请输入HTTPS内容链接。'); }
  return { platform, title: text('title', 200), body: text('body', 6000), url, author: text('author', 120),
    publishedAt: text('publishedAt', 64) || null, collectedAt: text('collectedAt', 64) || null,
    metrics: { likes: Number.isFinite(value.metrics?.likes) && value.metrics.likes >= 0 ? value.metrics.likes : null },
    provenance: platform === 'manual' ? '用户提供' : text('provenance', 80) || '待核实' };
}
// This script reads only visible page cards and explicit date elements. Missing
// metrics/dates remain unknown; never infer publish time from a note ID.
function extractPage(detail) {
  const host = location.hostname;
  if (!['www.douyin.com', 'www.xiaohongshu.com'].includes(host)) return { blocked: '请完成平台登录或验证后重试。', items: [] };
  const content = document.body.innerText;
  if (/安全验证|请完成验证|扫码登录后|登录后查看更多/.test(content)) return { blocked: '请在浏览器完成登录或验证后重试。', items: [] };
  const pick = (node, selectors) => selectors.map((s) => node.querySelector(s)).find(Boolean);
  const text = (node) => node?.textContent?.trim() || '';
  const number = (raw) => { const m = /^([\d.]+)\s*([万wW千kK]?)$/.exec(raw.replace(/,/g, '')); return m ? Number(m[1]) * (/[万wW]/.test(m[2]) ? 10000 : /[千kK]/.test(m[2]) ? 1000 : 1) : null; };
  const cards = detail ? [document] : Array.from(document.querySelectorAll(host.includes('xiaohongshu') ? 'section.note-item' : '[data-e2e="search-card-video"], li:has(a[href*="/video/"])'));
  const items = cards.slice(0, 30).map((card) => {
    const link = detail ? location.href : pick(card, ['a[href*="xsec_token="]', 'a[href*="/search_result/"]', 'a[href*="/explore/"]', 'a[href*="/video/"]'])?.href;
    const title = detail ? text(pick(card, ['#detail-title', '[data-e2e="video-desc"]'])) || document.title : text(pick(card, ['.title', '[data-e2e="video-desc"]', '[data-e2e="search-card-desc"]']));
    const date = pick(card, ['time[datetime]', '[data-publish-time]', '.date']);
    const rawDate = date?.getAttribute('datetime') || date?.getAttribute('data-publish-time') || text(date).match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
    const publishedAt = /^\d{4}-\d{2}-\d{2}/.test(rawDate) && Number.isFinite(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : null;
    return { title: title.slice(0, 200), body: detail ? text(pick(card, ['#detail-desc', '[data-e2e="video-desc"]'])).slice(0, 6000) : '', url: link,
      author: text(pick(card, ['.author .name', '.author-wrapper .username', '[data-e2e="video-author-name"]'])).slice(0, 120), publishedAt,
      metrics: { likes: number(text(pick(card, ['.like-wrapper .count', '[data-e2e="video-like-count"]']))) } };
  }).filter((item) => item.url && item.title);
  return { items };
}
function createNarrationSources({ fetchImpl = global.fetch } = {}) {
  const browser = createNarrationBrowser(PLATFORMS);
  const sessions = Object.fromEntries(Object.keys(PLATFORMS).map((key) => [key, `xiaoxi-narration-${key}-${randomUUID()}`]));
  let busy = false;
  async function request(route, body) {
    const response = await fetchImpl(`http://127.0.0.1:19825${route}`, { method: body ? 'POST' : 'GET', headers: { 'X-OpenCLI': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(body ? 25000 : 2000) });
    if (!response.ok) throw Error('浏览器连接未就绪');
    return response.json();
  }
  async function status() {
    let state; try { state = await request('/status'); } catch { state = {}; }
    const connected = state.extensionConnected === true && !state.profileRequired && !state.profileDisconnected;
    return { connected: connected || browser.available(), bridgeConnected: connected,
      message: connected ? '已连接现有浏览器；查询时核实平台登录和内容。' : browser.available() ? '首次使用请打开平台登录，之后在本软件搜索。登录状态仅保存在本机，不需要安装浏览器扩展。' : '平台浏览器未就绪，可先粘贴参考文案。',
      platforms: Object.entries(PLATFORMS).map(([id, p]) => ({ id, name: p.name, status: connected ? '待查询核实' : '打开登录' })) };
  }
  async function command(platform, action, params) {
    const result = await request('/command', { id: randomUUID(), action, session: sessions[platform], surface: 'browser', timeout: 20, ...params });
    if (!result.ok) throw Error('浏览器操作未完成，请检查平台登录和浏览器桥。');
    return result;
  }
  async function visit(platform, url, detail) {
    const state = await status();
    if (!state.connected) throw Error('平台浏览器未就绪，可直接粘贴文案。');
    // Bounded readiness polling, not a fixed delay or an unbounded page wait.
    const code = `(async()=>{for(let i=0;i<12;i++){await new Promise(r=>setTimeout(r,650));const r=(${extractPage.toString()})(${detail === true});if(r.blocked||r.items?.some(x=>${detail ? 'x.body' : 'x.title'}))return r;}return (${extractPage.toString()})(${detail === true});})()`;
    let data;
    if (state.bridgeConnected) {
      const target = await command(platform, 'navigate', { url });
      if (!target.page) throw Error('未取得独立页面，未读取其他浏览器页面。');
      data = (await command(platform, 'exec', { page: target.page, code })).data;
    } else data = await browser.visit(platform, url, code);
    if (data?.blocked) throw Error(data.blocked);
    if (!Array.isArray(data?.items)) throw Error('平台页面结构未识别，可粘贴文案继续。');
    return data.items.map((item) => validateReference({ ...item, url: sourceUrl(item.url, platform), platform, collectedAt: new Date().toISOString(), provenance: detail ? '平台笔记正文或视频说明，非完整语音转写' : '平台页面可见内容' }));
  }
  async function connect(input) {
    assertKeys(input, ['platform']); if (!PLATFORMS[input.platform]) throw Error('请选择平台。');
    if ((await status()).bridgeConnected) await require('electron').shell.openExternal(PLATFORMS[input.platform].home);
    else await browser.visit(input.platform, PLATFORMS[input.platform].home, null, true);
    return status();
  }
  async function search(input) {
    assertKeys(input, ['query', 'days']);
    const query = String(input.query || '').trim(), days = input.days ?? 30;
    if (!query || query.length > 100 || ![30, 90].includes(days)) throw Error('请输入100字以内关键词，选择近30或90天。');
    if (busy) throw Error('正在读取参考内容，请等待当前查询结束。');
    busy = true;
    try {
      const groups = await Promise.all(Object.entries(PLATFORMS).map(async ([platform, p]) => {
        try {
          const rows = await visit(platform, p.search(query), false);
          const seen = new Set(), terms = query.split(/\s+/).filter(Boolean);
          const relevant = rows.filter((row) => !seen.has(row.url) && seen.add(row.url) && terms.some((term) => row.title.includes(term) || row.body.includes(term)));
          const recent = relevant.filter((r) => r.publishedAt && Date.parse(r.publishedAt) <= Date.now() && Date.now() - Date.parse(r.publishedAt) <= days * 86400000);
          recent.sort((a, b) => (b.metrics.likes ?? -1) - (a.metrics.likes ?? -1));
          return { platform, name: p.name, status: rows.length ? '已读取' : '未读到内容，可能需要登录或页面适配', items: recent, unverified: relevant.filter((r) => !r.publishedAt), message: '同平台、同时间范围按已取得的点赞数比较；未知指标不计入排名。' };
        } catch (error) { return { platform, name: p.name, status: '待连接或核实', message: error.message, items: [], unverified: [] }; }
      }));
      return { days, groups, suggest90Days: days === 30 && groups.every((group) => !group.items.length) };
    } finally { busy = false; }
  }
  async function read(input) {
    assertKeys(input, ['platform', 'url']); const url = sourceUrl(input.url, input.platform);
    if (busy) throw Error('正在查询，请稍后读取正文。'); busy = true;
    try { const rows = await visit(input.platform, url, true); if (!rows[0]?.body) throw Error('未读到笔记正文或视频说明，可以直接粘贴参考文案。'); return rows[0]; } finally { busy = false; }
  }
  return { status, connect, search, read, validateReference, close: browser.close };
}
module.exports = { createNarrationSources, validateReference };
