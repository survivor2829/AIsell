// 扒爆款：用软件自带的平台窗口（与「找行业参考」共用登录）打开抖音、小红书搜索页，
// 只读取官方页面自己请求回来的数据（点赞、评论数、粉丝数、发布时间、评论文字）。
// 不重放平台接口、不读取 Cookie 或请求头、不发送任何内容。
// 一键成片需要爆款原口播时，才按页面数据里给出的官方 CDN 地址下载那一条视频。
const fs = require('node:fs');
const { rankCandidates, searchKeywords } = require('./viral-ranking.cjs');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));
const compact = (value, max = 2000) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const problem = (code, message) => Object.assign(new Error(message), { code });

const PLATFORMS = {
  douyin: { name: '抖音', hosts: ['www.douyin.com', 'douyin.com'], search: (q) => `https://www.douyin.com/search/${encodeURIComponent(q)}?type=video`,
    detail: (item) => `https://www.douyin.com/video/${item.id}` },
  xiaohongshu: { name: '小红书', hosts: ['www.xiaohongshu.com', 'edith.xiaohongshu.com'], search: (q) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(q)}&source=web_search_result_notes`,
    detail: (item) => `https://www.xiaohongshu.com/explore/${item.id}?xsec_token=${encodeURIComponent(item.xsecToken || '')}&xsec_source=pc_search`,
    profile: (item) => `https://www.xiaohongshu.com/user/profile/${item.authorId}` }
};
const LIMITS = { keywordsPerScan: 6, scrollsPerKeyword: 2, detailVisits: 12, profileVisits: 8, commentPasses: 3 };

function allowed(url, platform) {
  try { const u = new URL(url); return u.protocol === 'https:' && (PLATFORMS[platform].hosts.includes(u.hostname) || u.hostname.endsWith(platform === 'douyin' ? '.douyin.com' : '.xiaohongshu.com')); }
  catch { return false; }
}
// 视频文件只从平台自己的播放 / CDN 域名下载。
const MEDIA_HOSTS = { douyin: ['.douyin.com', '.douyinvod.com', '.zjcdn.com', '.amemv.com', '.douyinstatic.com', '.bytecdn.cn'], xiaohongshu: ['.xhscdn.com', '.xiaohongshu.com'] };
function mediaAllowed(url, platform) {
  try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && (MEDIA_HOSTS[platform] || []).some((suffix) => u.hostname.endsWith(suffix)); }
  catch { return false; }
}
const mediaOf = (urls, platform, durationMs) => {
  const url = (Array.isArray(urls) ? urls : [urls]).find((candidate) => typeof candidate === 'string' && mediaAllowed(candidate, platform));
  return url ? { url, durationSeconds: Number(durationMs) > 0 ? Math.round(Number(durationMs) / 1000) : null } : null;
};

// 「1.2万」「10w+」「1,234」→ 数字；读不出就返回 null，不估算。
function count(value) {
  if (Number.isFinite(value)) return value >= 0 ? value : null;
  const m = /^([\d.]+)\s*([万wW千kK]?)\+?$/.exec(String(value ?? '').replace(/,/g, '').trim());
  if (!m) return null;
  const n = Number(m[1]) * (/[万wW]/.test(m[2]) ? 10000 : /[千kK]/.test(m[2]) ? 1000 : 1);
  return Number.isFinite(n) ? Math.round(n) : null;
}
const iso = (seconds) => Number(seconds) > 0 ? new Date(Number(seconds) * (Number(seconds) > 1e12 ? 1 : 1000)).toISOString() : null;
const positive = (value) => { const n = count(value); return n !== null && n > 0 ? n : null; };

// ---- 纯解析函数：只认官方页面返回的数据结构，字段缺失时保持未知 ----
function parseDouyinSearch(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows.flatMap((row) => {
    const a = row?.aweme_info;
    if (!a?.aweme_id || !/^\d+$/.test(String(a.aweme_id))) return [];
    const s = a.statistics || {};
    return [{ id: String(a.aweme_id), platform: 'douyin', url: `https://www.douyin.com/video/${a.aweme_id}`, title: compact(a.desc, 200), body: compact(a.desc, 2000),
      author: { name: compact(a.author?.nickname, 100), followers: positive(a.author?.follower_count) },
      publishedAt: iso(a.create_time), cover: typeof a.video?.cover?.url_list?.[0] === 'string' ? a.video.cover.url_list[0] : null,
      media: mediaOf(a.video?.play_addr?.url_list, 'douyin', a.video?.duration ?? a.duration),
      metrics: { likes: count(s.digg_count), comments: count(s.comment_count), collects: count(s.collect_count), shares: count(s.share_count) }, comments: null }];
  });
}
function parseDouyinComments(body) {
  return Array.isArray(body?.comments) ? body.comments.map((c) => compact(c?.text, 300)).filter(Boolean) : [];
}
function parseXhsSearch(body) {
  const rows = Array.isArray(body?.data?.items) ? body.data.items : [];
  return rows.flatMap((row) => {
    const n = row?.note_card;
    if (!row?.id || !/^[0-9a-f]{16,32}$/i.test(String(row.id)) || !n) return [];
    const i = n.interact_info || {};
    return [{ id: String(row.id), platform: 'xiaohongshu', xsecToken: String(row.xsec_token || ''), url: `https://www.xiaohongshu.com/explore/${row.id}`,
      title: compact(n.display_title || n.title, 200), body: '', authorId: compact(n.user?.user_id, 64),
      author: { name: compact(n.user?.nickname || n.user?.nick_name, 100), followers: null }, publishedAt: null, cover: n.cover?.url_default || n.cover?.url || null,
      metrics: { likes: count(i.liked_count), comments: count(i.comment_count), collects: count(i.collected_count), shares: count(i.shared_count) }, comments: null }];
  });
}
function parseXhsFeed(body) {
  const n = body?.data?.items?.[0]?.note_card;
  if (!n) return null;
  const i = n.interact_info || {};
  const stream = n.video?.media?.stream || {};
  const media = n.type === 'video' ? mediaOf([...(stream.h264 || []), ...(stream.h265 || [])].flatMap((s) => [s?.master_url, ...(s?.backup_urls || [])]), 'xiaohongshu', n.video?.capa?.duration * 1000) : null;
  return { body: compact(n.desc, 2000), title: compact(n.title, 200), publishedAt: iso(n.time), media,
    metrics: { likes: count(i.liked_count), comments: count(i.comment_count), collects: count(i.collected_count), shares: count(i.share_count) } };
}
function parseXhsComments(body) {
  return Array.isArray(body?.data?.comments) ? body.data.comments.map((c) => compact(c?.content, 300)).filter(Boolean) : [];
}
function parseXhsFans(body) {
  const fans = Array.isArray(body?.data?.interactions) ? body.data.interactions.find((x) => x?.type === 'fans') : null;
  return fans ? positive(fans.count) : null;
}
const ROUTES = [
  { platform: 'douyin', test: /\/aweme\/v1\/web\/(search\/item|general\/search\/single)\/?$/, kind: 'search', parse: parseDouyinSearch },
  { platform: 'douyin', test: /\/aweme\/v1\/web\/comment\/list\/?$/, kind: 'comments', parse: parseDouyinComments },
  { platform: 'xiaohongshu', test: /\/api\/sns\/web\/v1\/search\/notes\/?$/, kind: 'search', parse: parseXhsSearch },
  { platform: 'xiaohongshu', test: /\/api\/sns\/web\/v1\/feed\/?$/, kind: 'feed', parse: parseXhsFeed },
  { platform: 'xiaohongshu', test: /\/api\/sns\/web\/v2\/comment\/page\/?$/, kind: 'comments', parse: parseXhsComments },
  { platform: 'xiaohongshu', test: /\/api\/sns\/web\/v1\/user\/otherinfo\/?$/, kind: 'fans', parse: parseXhsFans }
];
function routeFor(platform, url) {
  try { const { pathname } = new URL(url); return ROUTES.find((r) => r.platform === platform && r.test.test(pathname)) || null; } catch { return null; }
}

// 页面上的验证码 / 登录提示（只读文字，不点击）
function inspectBlock() {
  const t = String(document.body?.innerText || '');
  return { verification: /安全验证|完成验证|拖动滑块|请完成验证/.test(t), login: /扫码登录|登录后查看|登录后即可|手机号登录/.test(t) };
}

function createViralScout({ BrowserWindow, session, onProgress = () => {} } = {}) {
  const windows = new Map();
  let busy = false, stopped = false;

  async function windowFor(platform) {
    const existing = windows.get(platform);
    if (existing && !existing.win.isDestroyed()) return existing;
    if (!BrowserWindow || !session) throw problem('VIRAL_BROWSER_UNAVAILABLE', '当前环境没有可用的平台窗口，请重新打开软件。');
    const ses = session.fromPartition(`persist:narration-source-${platform}`); // 与「找行业参考」共用登录
    ses.setPermissionRequestHandler((_c, _p, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    const win = new BrowserWindow({ width: 1180, height: 820, show: false, title: `${PLATFORMS[platform].name} · 扒爆款`, autoHideMenuBar: true,
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const name of ['will-navigate', 'will-redirect']) wc.on(name, (event, url) => { if (!allowed(url, platform)) event.preventDefault(); });
    ses.on('will-download', (event) => event.preventDefault());
    const entry = { win, pending: new Map(), captured: [] };
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Network.enable', { maxResourceBufferSize: 4 * 1024 * 1024, maxTotalBufferSize: 16 * 1024 * 1024 });
    wc.debugger.on('message', async (_e, method, params) => {
      if (method === 'Network.responseReceived') {
        const url = params.response?.url || '';
        const route = allowed(url, platform) && params.response?.status === 200 ? routeFor(platform, url) : null;
        if (route) entry.pending.set(params.requestId, route);
      } else if (method === 'Network.loadingFailed') entry.pending.delete(params.requestId);
      else if (method === 'Network.loadingFinished' && entry.pending.has(params.requestId)) {
        const route = entry.pending.get(params.requestId); entry.pending.delete(params.requestId);
        if (params.encodedDataLength > 4 * 1024 * 1024) return;
        try {
          const result = await wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
          const raw = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
          entry.captured.push({ kind: route.kind, data: route.parse(JSON.parse(raw)) });
          if (entry.captured.length > 400) entry.captured.shift();
        } catch { /* 单个响应读不到时忽略，结果里只会少这一条 */ }
      }
    });
    win.on('closed', () => windows.delete(platform));
    windows.set(platform, entry);
    return entry;
  }

  async function load(entry, platform, url) {
    if (!allowed(url, platform)) throw problem('VIRAL_URL_INVALID', '只打开平台官方页面。');
    entry.captured.length = 0;
    let timer;
    try {
      await Promise.race([entry.win.loadURL(url), new Promise((_r, reject) => { timer = setTimeout(() => { entry.win.webContents.stop(); reject(problem('VIRAL_PAGE_TIMEOUT', `${PLATFORMS[platform].name}页面加载超时。`)); }, 25000); })]);
    } finally { clearTimeout(timer); }
  }
  async function waitFor(entry, kind, ms) {
    const until = Date.now() + ms;
    while (Date.now() < until && !stopped) { if (entry.captured.some((c) => c.kind === kind)) return true; await pause(250); }
    return entry.captured.some((c) => c.kind === kind);
  }
  async function blocked(entry, platform) {
    const state = await entry.win.webContents.executeJavaScript(`(${inspectBlock.toString()})()`).catch(() => ({}));
    if (state.verification) return `${PLATFORMS[platform].name}需要安全验证，请在弹出的窗口里完成后重新开始。`;
    if (state.login) return `${PLATFORMS[platform].name}需要先登录，请点「打开平台登录」登录后再扒。`;
    return '';
  }
  const scroll = (entry) => entry.win.webContents.executeJavaScript('window.scrollBy(0, Math.max(800, innerHeight * 0.9))').catch(() => {});

  async function scanPlatform(platform, keywords, emit) {
    const entry = await windowFor(platform);
    const found = new Map();
    for (const keyword of keywords) {
      if (stopped) break;
      emit({ stage: 'collect', platform, message: `正在搜索${PLATFORMS[platform].name}：${keyword}` });
      await load(entry, platform, PLATFORMS[platform].search(keyword));
      if (!(await waitFor(entry, 'search', 8000))) {
        const reason = await blocked(entry, platform);
        if (reason) { entry.win.show(); entry.win.focus(); throw problem('VIRAL_PLATFORM_BLOCKED', reason); }
      }
      for (let i = 0; i < LIMITS.scrollsPerKeyword && !stopped; i += 1) { await scroll(entry); await pause(jitter(1200, 2200)); }
      const added = [];
      for (const c of entry.captured.filter((x) => x.kind === 'search')) for (const item of c.data) if (!found.has(item.id)) { found.set(item.id, { ...item, keyword }); added.push(item); }
      // 每条新读到的内容都发给界面，流图上每条线对应一条真实内容。
      emit({ stage: 'collect', platform, collected: found.size, message: `${PLATFORMS[platform].name}已读到 ${found.size} 条`,
        added: added.map((item) => ({ id: item.id, platform, title: item.title.slice(0, 60), author: item.author?.name || '' })) });
      await pause(jitter(1500, 3500));
    }
    // 只对点赞靠前的少量内容打开详情读评论（小红书顺便补发布时间和正文），控制访问量。
    const top = [...found.values()].sort((a, b) => (b.metrics.likes ?? -1) - (a.metrics.likes ?? -1)).slice(0, LIMITS.detailVisits);
    let index = 0;
    for (const item of top) {
      if (stopped) break;
      index += 1;
      emit({ stage: 'comments', platform, message: `正在读评论 ${index}/${top.length}：${item.title.slice(0, 16)}` });
      await load(entry, platform, PLATFORMS[platform].detail(item));
      await waitFor(entry, 'comments', 6000);
      for (let pass = 1; pass < LIMITS.commentPasses && !stopped; pass += 1) { await scroll(entry); await pause(jitter(900, 1600)); }
      const comments = entry.captured.filter((c) => c.kind === 'comments').flatMap((c) => c.data).slice(0, 50);
      const feed = entry.captured.find((c) => c.kind === 'feed')?.data;
      const merged = { ...item, comments: comments.length ? comments : null };
      if (feed) Object.assign(merged, { body: feed.body || merged.body, title: merged.title || feed.title, publishedAt: feed.publishedAt || merged.publishedAt, media: feed.media || merged.media || null,
        metrics: { ...merged.metrics, ...Object.fromEntries(Object.entries(feed.metrics).filter(([, v]) => v !== null)) } });
      found.set(item.id, merged);
      await pause(jitter(1500, 3000));
    }
    if (platform === 'xiaohongshu') {
      const needFans = top.filter((item) => item.authorId).slice(0, LIMITS.profileVisits);
      for (const item of needFans) {
        if (stopped) break;
        emit({ stage: 'comments', platform, message: `正在核对作者粉丝数：${item.author.name}` });
        await load(entry, platform, PLATFORMS.xiaohongshu.profile(item));
        if (await waitFor(entry, 'fans', 5000)) {
          const fans = entry.captured.find((c) => c.kind === 'fans')?.data ?? null;
          const current = found.get(item.id); found.set(item.id, { ...current, author: { ...current.author, followers: fans } });
        }
        await pause(jitter(1500, 3000));
      }
    }
    return [...found.values()];
  }

  async function scan({ industryIds, platforms = ['douyin', 'xiaohongshu'], days = 30 } = {}) {
    if (busy) throw problem('VIRAL_BUSY', '正在扒爆款，请等这一轮结束。');
    if (![30, 90].includes(days)) throw problem('VIRAL_INPUT', '时间范围只能选近 30 天或近 90 天。');
    const chosen = platforms.filter((p) => PLATFORMS[p]);
    if (!chosen.length) throw problem('VIRAL_INPUT', '请至少选择一个平台。');
    const keywords = searchKeywords(industryIds).slice(0, LIMITS.keywordsPerScan);
    busy = true; stopped = false;
    const startedAt = new Date().toISOString();
    const emit = (event) => onProgress({ ...event, at: new Date().toISOString() });
    try {
      const platformResults = [];
      for (const platform of chosen) { // 依次扒，避免两个平台同时开窗口
        try { platformResults.push({ platform, name: PLATFORMS[platform].name, status: 'ok', items: await scanPlatform(platform, keywords, emit) }); }
        catch (error) { platformResults.push({ platform, name: PLATFORMS[platform].name, status: 'blocked', message: error.message, items: [] }); emit({ stage: 'blocked', platform, message: error.message }); }
      }
      const ranked = rankCandidates(platformResults.flatMap((r) => r.items), { industryIds, days });
      emit({ stage: 'done', message: `扒完了：${ranked.stats.collected} 条里挑出 ${ranked.stats.final} 条爆款`, stats: ranked.stats });
      return { startedAt, finishedAt: new Date().toISOString(), keywords, days, stopped,
        platforms: platformResults.map(({ items, ...rest }) => ({ ...rest, collected: items.length })), ...ranked };
    } finally { busy = false; }
  }

  // 下载一条爆款的视频，用于提取原口播。用扒取时同一个平台会话，只认官方 CDN 地址，限制大小和时长。
  async function downloadMedia(item, destination, { maxBytes = 150 * 1024 * 1024, timeoutMs = 120000 } = {}) {
    const platform = item?.platform;
    if (!PLATFORMS[platform] || !mediaAllowed(item?.media?.url, platform)) throw problem('VIRAL_MEDIA_UNAVAILABLE', '这条爆款没有可下载的视频。');
    if (!session) throw problem('VIRAL_BROWSER_UNAVAILABLE', '当前环境没有可用的平台会话，请重新打开软件。');
    const ses = session.fromPartition(`persist:narration-source-${platform}`);
    // 跳转逐跳核对：每一跳都必须仍是平台官方地址，不会被带去其他网站或本机内网。
    const signal = AbortSignal.timeout(timeoutMs), headers = { Referer: platform === 'douyin' ? 'https://www.douyin.com/' : 'https://www.xiaohongshu.com/' };
    let url = item.media.url, response;
    for (let hop = 0; ; hop += 1) {
      response = await ses.fetch(url, { headers, signal, redirect: 'manual' })
        .catch(() => { throw problem('VIRAL_MEDIA_DOWNLOAD', `${PLATFORMS[platform].name}视频下载失败，请稍后重试。`); });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const next = (() => { try { return new URL(response.headers.get('location') || '', url).href; } catch { return ''; } })();
      if (hop >= 5 || !mediaAllowed(next, platform)) throw problem('VIRAL_MEDIA_UNAVAILABLE', '视频地址跳到了平台以外的网站，已停止下载。');
      url = next;
    }
    if (!response.ok || !response.body) throw problem('VIRAL_MEDIA_DOWNLOAD', `${PLATFORMS[platform].name}视频下载失败（${response.status}），链接可能已过期，请重新扒一次。`);
    // 同步写入：出错时先关文件再删，不会留下半截文件或晚到的写入错误。
    const partial = `${destination}.partial`;
    const fd = fs.openSync(partial, 'w');
    let bytes = 0, closed = false;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw problem('VIRAL_MEDIA_TOO_LARGE', '爆款视频太大，跳过下载。');
        fs.writeSync(fd, chunk);
      }
      fs.closeSync(fd); closed = true;
      if (!bytes) throw problem('VIRAL_MEDIA_DOWNLOAD', '下载到的视频是空的，请重新扒一次。');
      fs.renameSync(partial, destination);
      return { file: destination, bytes };
    } catch (error) {
      if (!closed) fs.closeSync(fd);
      fs.rmSync(partial, { force: true });
      throw error;
    }
  }

  return { scan, downloadMedia, stop: () => { stopped = true; }, isBusy: () => busy,
    close: () => { for (const { win } of windows.values()) if (!win.isDestroyed()) win.destroy(); windows.clear(); } };
}

module.exports = { createViralScout, mediaAllowed, parseDouyinSearch, parseDouyinComments, parseXhsSearch, parseXhsFeed, parseXhsComments, parseXhsFans, routeFor, count, allowed, LIMITS };
