const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildLibrary, validateLibrary, publicDoc, loadLibrary, strandsFromScan, MAX_STRANDS } = require('./viral-library.cjs');
const { rankCandidates } = require('./viral-ranking.cjs');

const now = Date.parse('2026-10-24T08:00:00Z'), day = 86400000;
const post = (id, patch) => ({ id, platform: 'douyin', url: `https://www.douyin.com/video/${id}`, title: '', body: '', author: { name: '作者', followers: null },
  publishedAt: new Date(now - 3 * day).toISOString(), metrics: { likes: null }, comments: null, ...patch });
const scan = { ...rankCandidates([
  post('1', { title: '物业经理千万别再招保洁了，一台洗地机顶6个人', metrics: { likes: 83900 }, comments: ['多少钱', '能租吗', '怎么联系'] }),
  post('2', { title: '物业经理千万别再招保洁了，一台洗地机顶6个人！', metrics: { likes: 1200 } }),
  post('3', { title: '洗地机买还是租？算完这笔账', metrics: { likes: 21000 }, author: { name: '小王', followers: 1000 } }),
  post('5', { title: '今天的晚饭吃火锅', metrics: { likes: 99000 } })
], { industryIds: ['cleaning', 'property'], days: 30, now }), days: 30 };


const T1 = '物业经理千万别再招保洁了，一台洗地机顶六个人，一年省下二十万人工，评论区都在问多少钱，今天把账算给你看。';
const transcripts = [
  { sourceId: '1', transcript: T1 },
  { sourceId: '3', transcript: '太短的' },
  { sourceId: '999', transcript: '来源不在本次扒取里，来源不在本次扒取里，来源不在本次扒取里。' }
];
const library = buildLibrary({ scan, transcripts, now: new Date(now) });
assert.equal(library.schema, 2);
assert.deepEqual(library.items.map((i) => i.id), ['1'], '只收原口播够长、来源在本次扒取里的');
assert.equal(library.items[0].title, '物业经理千万别再招保洁了，一台洗地机顶6个人', '卡片标题是爆款原标题');
assert.equal(library.items[0].transcript, T1, '原口播发给云端');
assert.equal(library.items[0].source.likes, 83900);
assert.equal(library.items[0].source.url, undefined, '不给原视频链接');
assert.deepEqual(library.items[0].source.tags.map((t) => t.id), ['high_likes', 'asking_price']);
assert.equal(library.stats.ready, 1);
assert.equal(library.stats.collected, 4);
assert.equal(library.flow.strands.length, 4, '每条扒到的内容都是一条线');
assert.match(library.flow.strands.find((s) => s.id === '1').reason, /^进了文案库/);
const passing = library.flow.strands.filter((s) => s.outcome === 'pass');
assert.deepEqual(passing.map((s) => [s.id, s.group, s.label]), [['1', 'kind-asking', '评论里问价多'], ['3', 'kind-underdog', '小号也能爆']], '够爆的按爆款类型合成几束，最后合拢汇进文案库');
assert.doesNotMatch(passing[1].reason, /进了文案库/, '没提取到原口播的不算进库');
assert.equal(validateLibrary(JSON.parse(JSON.stringify(library))).strands.find((s) => s.id === '1').label, '评论里问价多');
assert.equal(library.flow.strands.find((s) => s.id === '2').group, '1', '搬运并到原作那一束');
assert.throws(() => buildLibrary({ scan, transcripts: [] }), { code: 'viral_library_empty' });
const twice = buildLibrary({ scan, transcripts: [transcripts[0], { sourceId: '1', transcript: T1 + '后提取的那条。' }], now: new Date(now) });
assert.deepEqual(twice.items.map((i) => [i.id, i.transcript.endsWith('后提取的那条。')]), [['1', true]], '同一来源提取两次只收后一条');
assert.throws(() => buildLibrary({ scan: null, transcripts }), { code: 'viral_library_scan_missing' });
const tagged = { ...scan, items: [{ ...scan.items[0], title: '洗地机怎么选 #洗地机 #清洁神器' }, { ...scan.items[1], title: '#洗地机 #好物' }] };
assert.deepEqual(buildLibrary({ scan: tagged, transcripts: [transcripts[0], { sourceId: scan.items[1].id, transcript: T1 }] }).items.map((i) => i.title), ['洗地机怎么选', T1.slice(0, 30)], '去掉话题标签；只有标签时用原口播开头');
// 线太多时：通过的全保留，没通过的抽样，总数不超过上限，抽样丢掉原作的搬运自成一束
const big = { items: [scan.items[0]], removed: Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, platform: 'douyin', title: 't', author: '', reason: 'not_viral', label: '不够爆', twinId: i % 2 ? `r${i - 1}` : undefined })) };
const strands = strandsFromScan(big, new Set(['1']));
assert.equal(strands.length, MAX_STRANDS);
assert.ok(strands.some((s) => s.outcome === 'pass'));
const ids = new Set(strands.map((s) => s.id));
assert.ok(strands.every((s) => ids.has(s.group) || s.group.startsWith('kind-')), '每一束都指向存在的线，或者是一种爆款类型');


// 客户端校验：原口播全文不留在客户端；坏条目丢掉；全坏当作还没有文案库
const back = validateLibrary(JSON.parse(JSON.stringify(library)));
assert.deepEqual(back.items[0], { id: '1', platform: 'douyin', title: library.items[0].title, source: library.items[0].source });
assert.ok(!JSON.stringify(back).includes(T1), '客户端拿不到原口播');
assert.equal(back.strands.length, 4);
assert.equal(back.stats.ready, 1);
const mixed = validateLibrary({ ...library, items: [...library.items, { id: '../x', platform: 'douyin', title: 't' }, { id: '9', platform: 'weibo', title: 't' }, { id: '8', platform: 'douyin', title: 'x'.repeat(61) }] });
assert.equal(mixed.items.length, 1);
assert.equal(validateLibrary({ ...library, items: [library.items[0], library.items[0]] }).items.length, 1, '重复 id 只留一条');
assert.throws(() => validateLibrary({ schema: 2, items: [{ id: '1', platform: 'douyin', title: '' }] }), { code: 'viral_library_empty' });
assert.throws(() => validateLibrary({ schema: 1, items: [{ id: '1', platform: 'douyin', title: 't', script: 's' }] }), { code: 'viral_library_invalid' }, '旧格式不再认');
assert.equal(validateLibrary({ ...library, items: [{ ...library.items[0], source: { likes: -5, publishedAt: 'not a date' } }] }).items[0].source.likes, null);

// 兜底：云端读到就存一份到本地（没有原口播）；读不到先用本地这份，再不行用安装包自带的，页面永远有流图和爆款
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoxi-viral-library-'));
  try {
    const cacheFile = path.join(dir, 'cache', 'cache.json'), seedFile = path.join(dir, 'seed.json');
    const down = async () => { throw Object.assign(new Error('网关不可用'), { code: 'gateway_down' }); };
    await assert.rejects(loadLibrary({ fetchRemote: down, cacheFile, seedFile }), { code: 'gateway_down' }, '三处都没有才报错');
    fs.writeFileSync(seedFile, JSON.stringify({ ...publicDoc(back), items: [{ ...back.items[0], title: '安装包自带' }] }));
    const seeded = await loadLibrary({ fetchRemote: down, cacheFile, seedFile });
    assert.equal(seeded.offline, true);
    assert.equal(seeded.items[0].title, '安装包自带', '没有缓存时用安装包自带的');
    assert.equal(seeded.strands.length, back.strands.length, '自带的那份也有流图');
    const online = await loadLibrary({ fetchRemote: async () => library, cacheFile, seedFile });
    assert.equal(online.offline, undefined);
    assert.ok(!fs.readFileSync(cacheFile, 'utf8').includes(T1), '本地缓存里没有原口播');
    const cached = await loadLibrary({ fetchRemote: down, cacheFile, seedFile });
    assert.equal(cached.offline, true);
    assert.deepEqual({ ...cached, offline: undefined }, { ...online, offline: undefined }, '断网时用上次读到的那份');
    const empty = await loadLibrary({ fetchRemote: async () => ({ schema: 2, items: [] }), cacheFile, seedFile });
    assert.equal(empty.offline, true, '云端是空库也用缓存，不显示空页面');
    fs.writeFileSync(cacheFile, '{broken');
    assert.equal((await loadLibrary({ fetchRemote: down, cacheFile, seedFile })).items[0].title, '安装包自带', '缓存坏了用自带的');
    // 仓库里随安装包发的那份必须能通过校验，且不含原口播
    const shipped = fs.readFileSync(path.join(__dirname, '..', '..', 'resources', 'viral-library', 'seed.json'), 'utf8');
    assert.ok(validateLibrary(JSON.parse(shipped)).items.length > 0);
    assert.ok(!shipped.includes('"transcript"'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  console.log('viral library self-check passed: transcripts from this scan only, viral titles and real stats, transcripts never reach the client, duplicate bundles, strand cap with valid groups, cache and seed fallback');
})().catch((error) => { console.error(error); process.exit(1); });
