const assert = require('node:assert/strict');
const { buildLibrary, validateLibrary, strandsFromScan, MAX_STRANDS } = require('./viral-library.cjs');
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

const scripts = [
  { sourceId: '1', title: '物业经理，别再为招不到保洁发愁了', script: '夜班保洁排不开人？先看地面材质，再算清洁面积。', emphasisPhrases: ['地面材质', '不在正文里'], originality: { overlapRatio: 0.04, passed: true } },
  { sourceId: '3', title: '照抄的稿子', script: '洗地机买还是租？算完这笔账', originality: { overlapRatio: 0.9, passed: false } },
  { sourceId: '999', title: '来源不在本次扒取里', script: 'x', originality: { overlapRatio: 0, passed: true } }
];
const library = buildLibrary({ scan, scripts, now: new Date(now) });
assert.equal(library.schema, 1);
assert.deepEqual(library.items.map((i) => i.id), ['1'], '只收原创度达标、来源在本次扒取里的稿子');
assert.deepEqual(library.items[0].emphasisPhrases, ['地面材质']);
assert.equal(library.items[0].source.likes, 83900);
assert.deepEqual(library.items[0].source.tags.map((t) => t.id), ['high_likes', 'asking_price']);
assert.equal(library.stats.ready, 1);
assert.equal(library.stats.collected, 4);
assert.equal(library.flow.strands.length, 4, '每条扒到的内容都是一条线');
assert.match(library.flow.strands.find((s) => s.id === '1').reason, /^已改写成原创稿/);
assert.equal(library.flow.strands.find((s) => s.id === '2').group, '1', '搬运并到原作那一束');
assert.throws(() => buildLibrary({ scan, scripts: [] }), { code: 'viral_library_empty' });
const twice = buildLibrary({ scan, scripts: [scripts[0], { ...scripts[0], title: '后改写的那条' }], now: new Date(now) });
assert.deepEqual(twice.items.map((i) => [i.id, i.title]), [['1', '后改写的那条']], '同一来源改写两次只收后一条');
assert.throws(() => buildLibrary({ scan: null, scripts }), { code: 'viral_library_scan_missing' });

// 线太多时：通过的全保留，没通过的抽样，总数不超过上限，抽样丢掉原作的搬运自成一束
const big = { items: [scan.items[0]], removed: Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, platform: 'douyin', title: 't', author: '', reason: 'not_viral', label: '不够爆', twinId: i % 2 ? `r${i - 1}` : undefined })) };
const strands = strandsFromScan(big, new Set(['1']));
assert.equal(strands.length, MAX_STRANDS);
assert.ok(strands.some((s) => s.outcome === 'pass'));
const ids = new Set(strands.map((s) => s.id));
assert.ok(strands.every((s) => ids.has(s.group)), '每一束都指向存在的线');

// 客户端校验：往返一致；坏条目丢掉；全坏当作还没有文案库
const back = validateLibrary(JSON.parse(JSON.stringify(library)));
assert.equal(back.items[0].script, library.items[0].script);
assert.equal(back.strands.length, 4);
assert.equal(back.stats.ready, 1);
const mixed = validateLibrary({ ...library, items: [...library.items, { id: '../x', platform: 'douyin', title: 't', script: 's' }, { id: '9', platform: 'weibo', title: 't', script: 's' }, { id: '8', platform: 'douyin', title: 'x'.repeat(25), script: 's' }] });
assert.equal(mixed.items.length, 1);
assert.equal(validateLibrary({ ...library, items: [library.items[0], library.items[0]] }).items.length, 1, '重复 id 只留一条');
assert.throws(() => validateLibrary({ schema: 1, items: [{ id: '1', platform: 'douyin', title: '', script: '' }] }), { code: 'viral_library_empty' });
assert.throws(() => validateLibrary({ schema: 2, items: [] }), { code: 'viral_library_invalid' });
assert.equal(validateLibrary({ ...library, items: [{ ...library.items[0], source: { url: 'javascript:alert(1)' } }] }).items[0].source.url, '');

console.log('viral library self-check passed: only original scripts from this scan, real stats and strands, duplicate bundles, strand cap with valid groups, client-side validation');
