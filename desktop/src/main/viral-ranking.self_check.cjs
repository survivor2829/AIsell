const assert = require('node:assert/strict');
const { rankCandidates, searchKeywords, normalizeTitle, similarity, isAskingPrice } = require('./viral-ranking.cjs');

const now = Date.parse('2026-10-23T12:00:00Z');
const day = 86400000;
const item = (id, patch) => ({ id, platform: 'douyin', url: `https://www.douyin.com/video/${id}`, title: '', body: '',
  author: { name: '作者', followers: null }, publishedAt: new Date(now - 3 * day).toISOString(), metrics: { likes: null }, comments: null, ...patch });

// 关键词来自所选行业，去重
const words = searchKeywords(['cleaning', 'property']);
assert.ok(words.includes('洗地机') && words.includes('物业保洁'));
assert.equal(new Set(words).size, words.length);
assert.throws(() => searchKeywords(['unknown']), /至少选择一个行业/);

// 搬运识别：去掉话题和标点后几乎一样
assert.equal(normalizeTitle('物业经理，别再招保洁了！#洗地机 #物业'), '物业经理别再招保洁了');
assert.ok(similarity('物业经理别再招保洁了一台顶六个人', '物业经理别再招保洁了一台顶六人') >= 0.8);
assert.ok(isAskingPrice('这个洗地机多少钱') && isAskingPrice('能租吗') && !isAskingPrice('拍得真好'));

const candidates = [
  // 高赞 + 有人问价
  item('1', { title: '物业经理千万别再招保洁了，一台洗地机顶6个人 #物业', metrics: { likes: 83900 }, author: { name: '保洁老周', followers: 120000 },
    comments: ['多少钱', '能租吗', '怎么联系', '拍得好', '在哪买'] }),
  // 同一内容的搬运（点赞更低）→ 去重
  item('2', { title: '物业经理千万别再招保洁了，一台洗地机顶6个人！', metrics: { likes: 1200 } }),
  // 小号爆：粉丝 1000，点赞 21000
  item('3', { title: '洗地机买还是租？算完这笔账', metrics: { likes: 21000 }, author: { name: '小王', followers: 1000 }, comments: ['好'] }),
  // 粉丝数读不到：不打小号爆，也不估算
  item('4', { title: '车间地面油污一拖就花，换了洗地机才解决', metrics: { likes: 900 }, author: { name: '工厂', followers: null } }),
  // 无关
  item('5', { title: '今天的晚饭吃火锅', metrics: { likes: 99000 } }),
  // 超过 30 天
  item('6', { title: '扫地车实测', publishedAt: new Date(now - 45 * day).toISOString(), metrics: { likes: 50000 } }),
  // 发布时间未知：保留，标注未知
  item('7', { platform: 'xiaohongshu', url: 'https://www.xiaohongshu.com/explore/7', title: '商超夜班保洁怎么排，一台清洁机器人省两个人', publishedAt: null, metrics: { likes: 30000 } })
];
const result = rankCandidates(candidates, { industryIds: ['cleaning', 'property', 'factory', 'retail'], days: 30, now });

// 相关性：只沾行业词的吐槽不算；家用产品没提商用场景的筛成「家用产品」；家用品牌出现在商用场景里照常保留
const relevance = rankCandidates([
  item('r1', { title: '老婆充话费送的破监控 #云鲸洗地机', metrics: { likes: 2800000 } }),
  item('r2', { title: '交房13年的小区到处都是物业服务细节 #物业', metrics: { likes: 2500 } }),
  item('r3', { title: '石头P30扫地机器人对比，用了一个月', metrics: { likes: 3000 } }),
  item('r4', { title: '工厂园区都在用的电动扫地车，看看清扫效果', metrics: { likes: 1800 } }),
  item('r6', { title: '保洁再勤快，也追不上随手扔垃圾的人', metrics: { likes: 4700 } }),
  item('r5', { title: '物业保洁换了台添可商用洗地机，夜班少两个人', metrics: { likes: 1500 }, comments: ['多少钱', '能租吗', '怎么联系'] })
], { industryIds: ['cleaning', 'property', 'factory'], days: 30, now });
assert.deepEqual(relevance.items.map((i) => i.id).sort(), ['r4', 'r5']);
assert.deepEqual(relevance.removed.map((r) => [r.id, r.reason]).sort(), [['r1', 'consumer'], ['r2', 'irrelevant'], ['r3', 'consumer'], ['r6', 'irrelevant']]);
assert.equal(relevance.stats.irrelevant, 4, '家用产品也计入「和清洁无关」这一段，四段数字仍然对得上');

assert.deepEqual(result.stats, { collected: 7, byPlatform: { douyin: 6, xiaohongshu: 1 }, duplicates: 1, outdated: 1, irrelevant: 1, notViral: 1, final: 3 });
assert.deepEqual(result.items.map((x) => x.id), ['1', '3', '7']);
const first = result.items[0];
assert.deepEqual(first.tags.map((t) => t.id), ['high_likes', 'asking_price']);
assert.equal(first.askingPriceComments, 4);
assert.deepEqual(result.items[1].tags.map((t) => t.id), ['high_likes', 'underdog']);
assert.equal(result.items[1].tags.find((t) => t.id === 'underdog').value, 21);
assert.equal(result.items[2].publishedKnown, false);
// 读不到粉丝数的 4 号没有被估算成小号爆，因为也不够高赞，被判为不够爆
assert.ok(result.removed.some((r) => r.id === '4' && r.reason === 'not_viral'));
assert.ok(result.removed.some((r) => r.id === '2' && r.reason === 'duplicate' && r.twinId === '1'));
// 被筛掉的带标题和作者，流图悬停时能说清是哪一条
assert.deepEqual((({ title, author, platform }) => ({ title, author, platform }))(result.removed.find((r) => r.id === '5')), { title: '今天的晚饭吃火锅', author: '作者', platform: 'douyin' });
assert.ok(result.removed.some((r) => r.id === '5' && r.label === '和清洁行业无关'));
// 每个被筛掉的都有原因，数量和统计一致（流图按这些数字画）
const s = result.stats;
assert.equal(s.collected, s.duplicates + s.outdated + s.irrelevant + s.notViral + s.final);
assert.equal(result.removed.length, s.collected - s.final);

console.log('viral ranking self-check passed: keywords, duplicate removal, freshness, relevance, three viral tags, no estimation of unknown metrics, funnel counts');
