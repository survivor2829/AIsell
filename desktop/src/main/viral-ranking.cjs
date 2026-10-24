// 爆款筛选规则：纯函数，不访问网络。输入是平台上读到的候选内容，
// 输出排好序的爆款清单和每一步筛掉的数量（流图按这些真实数字绘制）。
const presets = require('../shared/viral-industry-presets.json');

const ASKING_PRICE = [
  /多少钱|价格多少|什么价|怎么卖|报价|价位|价格|贵不贵/,
  /怎么买|哪里买|在哪买|哪儿买|哪有卖|哪里有卖|哪里下单|想买|求购|有货吗|怎么买到|能发货|如何购买|链接/,
  /怎么联系|联系方式|地址在哪|门店在哪|可以了解|想了解|私信|电话/,
  /能租吗|可以租|租金|月租|出租|以租代购/
];
const isAskingPrice = (text) => ASKING_PRICE.some((pattern) => pattern.test(String(text || '')));

function industriesFor(ids) {
  const chosen = presets.industries.filter((item) => !ids?.length || ids.includes(item.id));
  if (!chosen.length) throw Error('请至少选择一个行业方向。');
  return chosen;
}
function searchKeywords(ids) {
  return [...new Set(industriesFor(ids).flatMap((item) => item.keywords))];
}

// 去掉话题、表情、标点和空白，只比较正文字符，用于识别搬运和重复。
function normalizeTitle(text) {
  return String(text || '').replace(/#[^\s#]+/g, '').replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '').toLowerCase();
}
function bigrams(text) {
  const set = new Set();
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
  if (!set.size && text) set.add(text);
  return set;
}
function similarity(a, b) {
  const x = bigrams(a), y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const item of x) if (y.has(item)) common += 1;
  return common / (x.size + y.size - common);
}

const known = (value) => Number.isFinite(value) && value >= 0;

function rankCandidates(candidates, { industryIds, days = 30, now = Date.now() } = {}) {
  const thresholds = presets.thresholds;
  const terms = industriesFor(industryIds).flatMap((item) => item.terms);
  const removed = [];
  // 被筛掉的也带上标题和作者，流图悬停时说明「这条是什么、为什么没进」。
  const drop = (item, reason, label, extra = {}) => removed.push({ id: item.id, platform: item.platform, title: item.title || '', author: item.author?.name || '', reason, label, ...extra });
  const stats = { collected: candidates.length, byPlatform: {}, duplicates: 0, outdated: 0, irrelevant: 0, notViral: 0, final: 0 };
  for (const item of candidates) stats.byPlatform[item.platform] = (stats.byPlatform[item.platform] || 0) + 1;

  // 1. 去重：同一条链接，或标题几乎一样（搬运），只保留点赞最高的那条。
  const sorted = [...candidates].sort((a, b) => (b.metrics?.likes ?? -1) - (a.metrics?.likes ?? -1));
  const kept = [];
  for (const item of sorted) {
    const key = normalizeTitle(item.title || item.body);
    const twin = kept.find((other) => other.url === item.url || (key.length >= 6 && similarity(key, normalizeTitle(other.title || other.body)) >= thresholds.duplicateSimilarity));
    if (twin) { stats.duplicates += 1; drop(item, 'duplicate', '搬运或重复', { twinId: twin.id }); continue; }
    kept.push(item);
  }

  // 2. 时间和行业：发布时间未知的不算过期，但会在卡片上注明「发布时间未知」。
  const fresh = kept.filter((item) => {
    const time = Date.parse(item.publishedAt || '');
    if (Number.isFinite(time) && now - time > days * 86400000) { stats.outdated += 1; drop(item, 'outdated', `超过 ${days} 天`); return false; }
    return true;
  });
  const relevant = fresh.filter((item) => {
    const text = `${item.title} ${item.body || ''}`;
    if (terms.some((term) => text.includes(term))) return true;
    stats.irrelevant += 1; drop(item, 'irrelevant', '和清洁行业无关'); return false;
  });

  // 3. 三种爆款标签。读不到的数据不参与判断，绝不估算。
  const likes = relevant.map((item) => item.metrics?.likes).filter(known).sort((a, b) => b - a);
  const cutoff = likes.length ? likes[Math.max(0, Math.ceil(likes.length * thresholds.highLikesTopRatio) - 1)] : Infinity;
  const tagged = relevant.map((item) => {
    const tags = [];
    const like = item.metrics?.likes, followers = item.author?.followers;
    // 本次结果里排前 20%，或点赞过 1 万（清洁这个细分行业里已算爆），且至少 1000 赞。
    if (known(like) && like >= thresholds.highLikesMinimum && (like >= cutoff || like >= thresholds.highLikesAbsolute)) tags.push({ id: 'high_likes', label: '高赞', value: like });
    if (known(like) && known(followers) && followers > 0 && like >= thresholds.underdogMinimumLikes && like / followers >= thresholds.underdogRatio) {
      tags.push({ id: 'underdog', label: '小号爆', value: Math.round(like / followers) });
    }
    const asking = Array.isArray(item.comments) ? item.comments.filter(isAskingPrice).length : null;
    if (asking !== null && asking >= thresholds.askingPriceMinimum) tags.push({ id: 'asking_price', label: '问价', value: asking });
    return { ...item, tags, askingPriceComments: asking, publishedKnown: Boolean(item.publishedAt) };
  });
  const viral = tagged.filter((item) => {
    if (item.tags.length) return true;
    stats.notViral += 1; drop(item, 'not_viral', '不够爆'); return false;
  });
  viral.sort((a, b) => b.tags.length - a.tags.length || (b.metrics?.likes ?? -1) - (a.metrics?.likes ?? -1));
  stats.final = viral.length;
  return { items: viral, stats, removed, thresholds };
}

module.exports = { rankCandidates, searchKeywords, industriesFor, normalizeTitle, similarity, isAskingPrice, presets };
