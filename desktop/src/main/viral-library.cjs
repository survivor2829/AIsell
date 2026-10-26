// 爆款文案库：我们内部扒取、提取原口播后发布到云端，客户点「仿写」时才在云端按 ID 改写。
// 这里负责两件事：把一次扒取结果和提取好的原口播组装成文案库（schema 2），以及读回来时逐项校验。
// 原口播全文只给云端用；云端返回给客户的文案库里没有原文，客户端校验时也会丢掉。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const MAX_ITEMS = 1000, MAX_STRANDS = 240;
const PLATFORMS = new Set(['douyin', 'xiaohongshu']);
const TAGS = new Set(['high_likes', 'underdog', 'asking_price']);
const problem = (code, message) => Object.assign(new Error(message), { code });
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, max);
const count = (value) => Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
const platformName = (id) => id === 'xiaohongshu' ? '小红书' : '抖音';
const wan = (value) => value >= 10000 ? `${(value / 10000).toFixed(value >= 100000 ? 1 : 2).replace(/\.?0+$/u, '')}w` : String(value);
function tagText(tag) {
  if (tag.id === 'high_likes') return `${tag.label} ${wan(tag.value)}`;
  if (tag.id === 'underdog') return `${tag.label} ×${tag.value}`;
  return `${tag.label} ${tag.value} 条`;
}
const cleanTags = (tags) => (Array.isArray(tags) ? tags : []).filter((t) => t && TAGS.has(t.id) && count(t.value) !== null)
  .map((t) => ({ id: t.id, label: text(t.label, 8), value: count(t.value) })).slice(0, 3);

// 流图的线：每条线是一次扒取里的一条真实内容。闸门是「够爆」：通过的按爆款类型合成几束粗红带（评论里问价多 / 小号也能爆 / 点赞高），
// 最后合拢成一股汇进文案库。条数太多时保留全部通过的，没通过的均匀抽样。
const KINDS = [['asking_price', 'kind-asking', '评论里问价多'], ['underdog', 'kind-underdog', '小号也能爆']];
const kindOf = (item) => KINDS.find(([tag]) => (item.tags || []).some((t) => t.id === tag)) || [null, 'kind-likes', '点赞高'];
function strandsFromScan(result, readyIds) {
  const line = (item) => ({ id: String(item.id), title: text(item.title, 60), source: `${platformName(item.platform)} · ${text(item.author?.name, 40)}`, group: String(item.id) });
  const pass = result.items.map((item) => { const [, group, label] = kindOf(item); return { ...line(item), group, label, outcome: 'pass',
    reason: `${readyIds.has(String(item.id)) ? '进了文案库 · ' : ''}${item.tags.map(tagText).join(' · ')}` }; });
  const drop = [...result.removed.map((r) => ({ id: String(r.id), title: text(r.title, 60), source: `${platformName(r.platform)} · ${text(r.author, 40)}`,
    group: String(r.twinId || r.id), outcome: 'drop', reason: text(r.label, 20) }))];
  const room = Math.max(0, MAX_STRANDS - pass.length), step = drop.length > room ? drop.length / room : 1;
  const sampled = room ? Array.from({ length: Math.min(room, drop.length) }, (_, i) => drop[Math.floor(i * step)]) : [];
  const kept = new Set([...pass, ...sampled].map((s) => s.id));
  // 搬运归到的原作如果被抽样丢掉了，就让它自成一束，避免指向不存在的线。
  return [...pass.slice(0, MAX_STRANDS), ...sampled].map((s) => (kept.has(s.group) || s.group.startsWith('kind-') ? s : { ...s, group: s.id }));
}

const MIN_TRANSCRIPT = 20;
// 卡片标题用爆款原标题，去掉 #话题 标签；只剩标签时用原口播开头。
const cardTitle = (title, transcript) => text(String(title ?? '').replace(/#[^\s#]+/gu, ' ').replace(/\s+/gu, ' '), 60) || text(transcript, 30);
// 卡片上只显示爆款标题和真实数据，不给原视频链接。
const publicSource = (source) => ({ likes: count(source?.likes), publishedAt: typeof source?.publishedAt === 'string' && Number.isFinite(Date.parse(source.publishedAt)) ? source.publishedAt.slice(0, 64) : null, tags: cleanTags(source?.tags) });

function buildLibrary({ scan, transcripts, now = new Date() }) {
  if (!scan?.items || !scan?.removed || !scan?.stats) throw problem('viral_library_scan_missing', '还没有扒取结果，请先扒一次爆款。');
  const bySource = new Map(scan.items.map((item) => [String(item.id), item]));
  // 同一来源只收一条（后提取的那条），文案库里的 id 不重复；顺序跟扒取结果的爆款排序一致。
  const latest = new Map(transcripts.filter((t) => bySource.has(String(t.sourceId)) && text(t.transcript, 6000).length >= MIN_TRANSCRIPT).map((t) => [String(t.sourceId), t]));
  const items = scan.items.filter((source) => latest.has(String(source.id))).slice(0, MAX_ITEMS).map((source) => ({
    id: String(source.id), platform: source.platform, title: cardTitle(source.title, latest.get(String(source.id)).transcript), transcript: text(latest.get(String(source.id)).transcript, 6000),
    source: publicSource({ likes: source.metrics?.likes, publishedAt: source.publishedAt, tags: source.tags }) }));
  if (!items.length) throw problem('viral_library_empty', '还没有提取好的原口播，不能发布空的文案库。');
  const ready = new Set(items.map((i) => i.id));
  const s = scan.stats;
  // 同一次扒取发布几次都只算一次：用这次扒到的全部内容 ID 做编号，云端按编号合并「扒到多少条」，不重复累加。
  const scanId = crypto.createHash('sha256').update([...scan.items, ...scan.removed].map((i) => String(i.id)).sort().join(',')).digest('hex').slice(0, 32);
  return { schema: 2, scanId, updatedAt: now.toISOString(), days: scan.days || 30,
    stats: { collected: s.collected, byPlatform: s.byPlatform || {}, duplicates: s.duplicates, outdated: s.outdated, irrelevant: s.irrelevant, notViral: s.notViral, final: s.final, ready: items.length },
    flow: { strands: strandsFromScan(scan, ready) }, items };
}

// 客户端读回云端文案库时再校验一遍：字段不全、类型不对的整条丢掉，全部不合格就当作还没有文案库。
function validateLibrary(doc) {
  if (!doc || doc.schema !== 2 || !Array.isArray(doc.items)) throw problem('viral_library_invalid', '爆款文案库暂时不可用，请稍后再试。');
  const items = doc.items.filter((i) => i && /^[A-Za-z0-9]{1,64}$/u.test(String(i.id)) && PLATFORMS.has(i.platform) && typeof i.title === 'string' && i.title.trim() && i.title.length <= 60)
    .filter((i, index, all) => all.findIndex((o) => String(o.id) === String(i.id)) === index).slice(0, MAX_ITEMS)
    .map((i) => ({ id: String(i.id), platform: i.platform, title: text(i.title, 60), source: publicSource(i.source) }));
  if (!items.length) throw problem('viral_library_empty', '爆款文案库还在准备中，请稍后再来。');
  const st = doc.stats || {};
  const stats = Object.fromEntries(['collected', 'duplicates', 'outdated', 'irrelevant', 'notViral', 'final', 'ready'].map((k) => [k, count(st[k]) ?? 0]));
  const strands = (Array.isArray(doc.flow?.strands) ? doc.flow.strands : []).slice(0, MAX_STRANDS).filter((s) => s && typeof s.id === 'string' && ['pass', 'drop'].includes(s.outcome))
    .map((s) => ({ id: text(s.id, 64), title: text(s.title, 60), source: text(s.source, 60), group: text(s.group || s.id, 64), outcome: s.outcome, reason: text(s.reason, 80), ...(s.label ? { label: text(s.label, 20) } : {}) }));
  return { updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : null, days: count(doc.days) || 30, stats: { ...stats, byPlatform: st.byPlatform && typeof st.byPlatform === 'object' ? st.byPlatform : {} }, strands, items };
}

// 校验后的文案库还原成可存盘的 schema 2 文件（没有原口播），用于本地缓存和安装包自带的一份。
const publicDoc = (library) => ({ schema: 2, updatedAt: library.updatedAt, days: library.days, stats: library.stats, flow: { strands: library.strands }, items: library.items });

// 客户端读文案库：云端优先；读不到（断网、网关出错、云端还没有）就用上次成功读到的一份，再不行用安装包自带的一份。
// 交付后页面永远有流图和爆款，兜底数据带 offline 标记；三处都读不到才报错。
async function loadLibrary({ fetchRemote, cacheFile, seedFile }) {
  try {
    const library = validateLibrary(await fetchRemote());
    if (cacheFile) {
      try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify(publicDoc(library)));
        fs.renameSync(`${cacheFile}.tmp`, cacheFile);
      } catch { /* 缓存写不进去不影响这次显示 */ }
    }
    return library;
  } catch (error) {
    for (const file of [cacheFile, seedFile]) {
      try { if (file) return { ...validateLibrary(JSON.parse(fs.readFileSync(file, 'utf8'))), offline: true }; } catch { /* 换下一处 */ }
    }
    throw error;
  }
}

module.exports = { buildLibrary, validateLibrary, publicDoc, loadLibrary, strandsFromScan, MAX_ITEMS, MAX_STRANDS };
