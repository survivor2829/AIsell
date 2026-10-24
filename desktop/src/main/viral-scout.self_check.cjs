const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const scout = require('./viral-scout.cjs');
const { parseDouyinSearch, parseDouyinComments, parseXhsSearch, parseXhsFeed, parseXhsComments, parseXhsFans, routeFor, count, allowed } = scout;

// ---- 数字解析：读不出就是 null，不估算 ----
assert.equal(count('1.2万'), 12000);
assert.equal(count('10w+'), 100000);
assert.equal(count('1,234'), 1234);
assert.equal(count(856), 856);
assert.equal(count('赞'), null);
assert.equal(count(-1), null);

// ---- 只认官方域名和固定接口 ----
assert.ok(allowed('https://www.douyin.com/search/x', 'douyin'));
assert.ok(!allowed('https://evil.com/www.douyin.com', 'douyin'));
assert.ok(!allowed('http://www.douyin.com/', 'douyin'));
assert.equal(routeFor('douyin', 'https://www.douyin.com/aweme/v1/web/search/item/?keyword=a').kind, 'search');
assert.equal(routeFor('douyin', 'https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=1').kind, 'comments');
assert.equal(routeFor('xiaohongshu', 'https://edith.xiaohongshu.com/api/sns/web/v1/search/notes').kind, 'search');
assert.equal(routeFor('douyin', 'https://www.douyin.com/aweme/v1/web/user/profile/self/'), null);

const now = Date.now();
const douyinSearch = { data: [
  { aweme_info: { aweme_id: '7400000000000000001', desc: '物业经理千万别再招保洁了，一台洗地机顶6个人 #物业', create_time: Math.floor(now / 1000) - 3 * 86400,
    statistics: { digg_count: 83900, comment_count: 1200, collect_count: 5000, share_count: 800 }, author: { nickname: '保洁老周', follower_count: 120000 } } },
  { aweme_info: { aweme_id: '7400000000000000002', desc: '洗地机买还是租？算完这笔账', create_time: Math.floor(now / 1000) - 5 * 86400,
    statistics: { digg_count: 21000 }, author: { nickname: '小王', follower_count: 1000 } } },
  { aweme_info: { aweme_id: 'bad', desc: 'x' } },
  { type: 999 }
] };
const dy = parseDouyinSearch(douyinSearch);
assert.equal(dy.length, 2);
assert.deepEqual(dy[0].metrics, { likes: 83900, comments: 1200, collects: 5000, shares: 800 });
assert.equal(dy[0].author.followers, 120000);
assert.equal(dy[1].metrics.comments, null); // 缺失保持未知
assert.ok(dy[0].publishedAt);
assert.deepEqual(parseDouyinComments({ comments: [{ text: '多少钱' }, { text: '' }, { text: '能租吗' }] }), ['多少钱', '能租吗']);

const xhsSearch = { data: { items: [
  { id: '6720000000000000000000ab', xsec_token: 'tok', model_type: 'note', note_card: { display_title: '商超夜班保洁怎么排，一台清洁机器人省两个人', user: { nickname: '超市店长', user_id: 'u1' }, interact_info: { liked_count: '3.0万', comment_count: '210' } } },
  { id: 'not-a-note', note_card: {} }
] } };
const xhs = parseXhsSearch(xhsSearch);
assert.equal(xhs.length, 1);
assert.equal(xhs[0].metrics.likes, 30000);
assert.equal(xhs[0].author.followers, null);
assert.equal(xhs[0].publishedAt, null);
const feed = parseXhsFeed({ data: { items: [{ note_card: { title: 't', desc: '正文', time: now - 2 * 86400000, interact_info: { liked_count: '3.1万' } } }] } });
assert.equal(feed.metrics.likes, 31000);
assert.ok(feed.publishedAt);
assert.deepEqual(parseXhsComments({ data: { comments: [{ content: '在哪买' }] } }), ['在哪买']);
assert.equal(parseXhsFans({ data: { interactions: [{ type: 'follows', count: '10' }, { type: 'fans', count: '850' }] } }), 850);
assert.equal(parseXhsFans({ data: { interactions: [] } }), null);

// ---- 用假窗口跑完整流程：只在官方页面返回数据时记录，遇到登录提示时该平台停下、另一个平台照常 ----
const responses = {
  'douyin:search': ['https://www.douyin.com/aweme/v1/web/search/item/', douyinSearch],
  'douyin:video': ['https://www.douyin.com/aweme/v1/web/comment/list/', { comments: [{ text: '多少钱' }, { text: '能租吗' }, { text: '在哪买' }, { text: '拍得好' }] }]
};
const visited = [];
class FakeWindow extends EventEmitter {
  constructor(options) {
    super(); this.destroyed = false; this.shown = false; this.title = options.title;
    const dbg = new EventEmitter(); dbg.attach = () => {}; this.bodies = new Map();
    dbg.sendCommand = async (method, params) => method === 'Network.getResponseBody' ? { body: JSON.stringify(this.bodies.get(params.requestId)), base64Encoded: false } : {};
    this.webContents = Object.assign(new EventEmitter(), { debugger: dbg, setWindowOpenHandler() {}, stop() {},
      executeJavaScript: async (code) => code.includes('inspectBlock') || code.includes('verification') ? { verification: false, login: this.title.startsWith('小红书') } : undefined });
  }
  isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; } show() { this.shown = true; } focus() {}
  async loadURL(url) {
    visited.push(url);
    const key = url.includes('douyin.com/search') ? 'douyin:search' : url.includes('douyin.com/video') ? 'douyin:video' : null;
    if (!key) return;
    const [apiUrl, body] = responses[key]; const id = String(Math.random());
    this.bodies.set(id, body);
    const dbg = this.webContents.debugger;
    dbg.emit('message', {}, 'Network.responseReceived', { requestId: id, response: { url: apiUrl, status: 200 } });
    dbg.emit('message', {}, 'Network.loadingFinished', { requestId: id, encodedDataLength: 1000 });
  }
}
const fakeSession = { fromPartition: (name) => { assert.match(name, /^persist:narration-source-(douyin|xiaohongshu)$/); return Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }); } };
const events = [];

(async () => {
  // 让固定等待在自检里跑快一点
  const realTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => realTimeout(fn, Math.min(ms, 5), ...args);
  const instance = scout.createViralScout({ BrowserWindow: FakeWindow, session: fakeSession, onProgress: (e) => events.push(e) });
  const result = await instance.scan({ industryIds: ['cleaning', 'property'], platforms: ['douyin', 'xiaohongshu'], days: 30 });
  global.setTimeout = realTimeout;

  assert.ok(visited.every((url) => /^https:\/\/www\.(douyin|xiaohongshu)\.com\//.test(url)), '只打开官方页面');
  const dyStatus = result.platforms.find((p) => p.platform === 'douyin');
  const xhsStatus = result.platforms.find((p) => p.platform === 'xiaohongshu');
  assert.equal(dyStatus.status, 'ok');
  assert.equal(dyStatus.collected, 2);
  assert.equal(xhsStatus.status, 'blocked');
  assert.match(xhsStatus.message, /小红书需要先登录/);
  assert.equal(result.stats.collected, 2);
  // 两条视频都读到同样的评论（假页面）；第 2 条额外命中「小号爆」，三个标签全中，排第一
  assert.deepEqual(result.items.map((x) => x.id), ['7400000000000000002', '7400000000000000001']);
  assert.deepEqual(result.items[0].tags.map((t) => t.id), ['high_likes', 'underdog', 'asking_price']);
  assert.ok(result.items[1].tags.some((t) => t.id === 'asking_price' && t.value === 3), '读到评论里的问价');
  assert.ok(result.items.some((x) => x.tags.some((t) => t.id === 'underdog')), '粉丝少点赞高的算小号爆');
  // 采集事件逐条带出新读到的内容，总数与最终统计一致
  const added = events.filter((e) => e.stage === 'collect').flatMap((e) => e.added || []);
  assert.equal(added.length, result.stats.collected);
  assert.ok(added.every((a) => a.id && a.platform === 'douyin' && typeof a.title === 'string'));
  assert.equal(new Set(added.map((a) => a.id)).size, added.length);
  assert.ok(events.some((e) => e.stage === 'collect') && events.some((e) => e.stage === 'comments') && events.at(-1).stage === 'done');
  await assert.rejects(instance.scan({ industryIds: ['cleaning'], days: 7 }), /近 30 天或近 90 天/);
  instance.close();
  console.log('viral scout self-check passed: official hosts and fixed routes only, metric parsing without estimation, comment sampling, per-platform login block, progress events');
})().catch((error) => { console.error(error); process.exit(1); });

// 一键成片用的视频地址：只认平台官方 CDN；下载用同一平台会话、写临时文件、超限即停
(async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const [dy] = scout.parseDouyinSearch({ data: [{ aweme_info: { aweme_id: '7400000000000000009', desc: '洗地机', video: { duration: 31500,
    play_addr: { url_list: ['http://v3-web.douyinvod.com/a.mp4', 'https://evil.example.com/a.mp4', 'https://v3-web.douyinvod.com/b.mp4'] } } } }] });
  assert.deepEqual(dy.media, { url: 'https://v3-web.douyinvod.com/b.mp4', durationSeconds: 32 });
  const [noVideo] = scout.parseDouyinSearch({ data: [{ aweme_info: { aweme_id: '7400000000000000010', desc: 'x', video: { play_addr: { url_list: ['https://evil.example.com/a.mp4'] } } } }] });
  assert.equal(noVideo.media, null, '非官方域名不当成可下载视频');
  const xhs = scout.parseXhsFeed({ data: { items: [{ note_card: { type: 'video', desc: '正文', video: { capa: { duration: 40 }, media: { stream: { h264: [{ master_url: 'https://sns-video-bd.xhscdn.com/x.mp4' }] } } } } }] } });
  assert.deepEqual(xhs.media, { url: 'https://sns-video-bd.xhscdn.com/x.mp4', durationSeconds: 40 });
  assert.equal(scout.parseXhsFeed({ data: { items: [{ note_card: { type: 'normal', desc: '图文' } }] } }).media, null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viral-media-'));
  const requests = [];
  const chunks = (list) => ({ async *[Symbol.asyncIterator]() { for (const c of list) yield Buffer.from(c); } });
  let reply = { ok: true, status: 200, body: chunks(['abc', 'def']) };
  const redirects = new Map();
  const fetchSession = { fromPartition: (name) => ({ fetch: async (url, init) => { assert.equal(init.redirect, 'manual'); requests.push({ name, url, referer: init.headers.Referer });
    if (redirects.has(url)) return { ok: false, status: 302, headers: { get: () => redirects.get(url) }, body: null }; return reply; } }) };
  const downloader = scout.createViralScout({ BrowserWindow: FakeWindow, session: fetchSession });
  const target = path.join(dir, 'source.mp4');
  assert.deepEqual(await downloader.downloadMedia(dy, target), { file: target, bytes: 6 });
  assert.equal(fs.readFileSync(target, 'utf8'), 'abcdef');
  assert.deepEqual(requests[0], { name: 'persist:narration-source-douyin', url: 'https://v3-web.douyinvod.com/b.mp4', referer: 'https://www.douyin.com/' });
  reply = { ok: true, status: 200, body: chunks(['12345', '67890']) };
  await assert.rejects(downloader.downloadMedia(dy, path.join(dir, 'big.mp4'), { maxBytes: 8 }), { code: 'VIRAL_MEDIA_TOO_LARGE' });
  assert.ok(!fs.existsSync(path.join(dir, 'big.mp4')) && !fs.existsSync(path.join(dir, 'big.mp4.partial')), '超限不留半截文件');
  reply = { ok: false, status: 403, body: null };
  await assert.rejects(downloader.downloadMedia(dy, path.join(dir, 'gone.mp4')), /链接可能已过期/);
  await assert.rejects(downloader.downloadMedia({ ...dy, media: { url: 'https://evil.example.com/a.mp4' } }, path.join(dir, 'x.mp4')), { code: 'VIRAL_MEDIA_UNAVAILABLE' });
  assert.equal(requests.length, 3, '非官方地址不会发出请求');
  // 跳转：官方 CDN 之间可以跳；跳到平台以外（含本机内网）立即停止，不会去请求
  reply = { ok: true, status: 200, body: chunks(['ok']) };
  redirects.set('https://v3-web.douyinvod.com/b.mp4', 'https://v5-cold.douyinvod.com/c.mp4');
  assert.equal((await downloader.downloadMedia(dy, path.join(dir, 'hop.mp4'))).bytes, 2);
  redirects.set('https://v5-cold.douyinvod.com/c.mp4', 'http://127.0.0.1:8080/secret');
  const before = requests.length;
  await assert.rejects(downloader.downloadMedia(dy, path.join(dir, 'evil.mp4')), /平台以外/);
  assert.ok(!requests.slice(before).some((r) => r.url.includes('127.0.0.1')));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('viral scout media self-check passed: official CDN only, same platform session with referer, size cap, no partial files');
})().catch((error) => { console.error(error); process.exit(1); });
