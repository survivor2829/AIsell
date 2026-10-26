// 爆款文案库：我们内部扒取、转写、改写后发布到云端，客户软件只读。
// 这里负责两件事：把一次扒取结果和改写好的稿子组装成文案库（schema 1），以及读回来时逐项校验。
const MAX_ITEMS = 60, MAX_STRANDS = 240;
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
const httpsUrl = (value) => { try { const u = new URL(String(value)); return u.protocol === 'https:' ? u.href.slice(0, 2000) : ''; } catch { return ''; } };

// 流图的线：每条线是一次扒取里的一条真实内容。只有改写好、进了文案库的标为通过（每条单独一束，最后合拢成一股汇进文案库）；
// 够爆但这次没改写的归到没进的里。条数太多时保留全部通过的，没通过的均匀抽样。
function strandsFromScan(result, readyIds) {
  const line = (item) => ({ id: String(item.id), title: text(item.title, 60), source: `${platformName(item.platform)} · ${text(item.author?.name, 40)}`, group: String(item.id) });
  const pass = result.items.filter((item) => readyIds.has(String(item.id))).map((item) => ({ ...line(item), outcome: 'pass', reason: `已改写成原创稿 · ${item.tags.map(tagText).join(' · ')}` }));
  const unused = result.items.filter((item) => !readyIds.has(String(item.id))).map((item) => ({ ...line(item), outcome: 'drop', reason: '够爆，这次没改写' }));
  const drop = [...unused, ...result.removed.map((r) => ({ id: String(r.id), title: text(r.title, 60), source: `${platformName(r.platform)} · ${text(r.author, 40)}`,
    group: String(r.twinId || r.id), outcome: 'drop', reason: text(r.label, 20) }))];
  const room = Math.max(0, MAX_STRANDS - pass.length), step = drop.length > room ? drop.length / room : 1;
  const sampled = room ? Array.from({ length: Math.min(room, drop.length) }, (_, i) => drop[Math.floor(i * step)]) : [];
  const kept = new Set([...pass, ...sampled].map((s) => s.id));
  // 搬运归到的原作如果被抽样丢掉了，就让它自成一束，避免指向不存在的线。
  return [...pass.slice(0, MAX_STRANDS), ...sampled].map((s) => (kept.has(s.group) ? s : { ...s, group: s.id }));
}

function buildLibrary({ scan, scripts, now = new Date() }) {
  if (!scan?.items || !scan?.removed || !scan?.stats) throw problem('viral_library_scan_missing', '还没有扒取结果，请先扒一次爆款。');
  const bySource = new Map(scan.items.map((item) => [String(item.id), item]));
  // 同一来源只收一条（后改写的那条），文案库里的 id 不重复。
  const latest = new Map(scripts.filter((s) => bySource.has(String(s.sourceId)) && s.script && s.title && s.originality?.passed !== false).map((s) => [String(s.sourceId), s]));
  const items = [...latest.values()].slice(0, MAX_ITEMS).map((s) => {
    const source = bySource.get(String(s.sourceId));
    return { id: String(source.id), platform: source.platform, title: text(s.title, 24), script: text(s.script, 500),
      emphasisPhrases: (s.emphasisPhrases || []).filter((p) => typeof p === 'string' && p.length <= 12 && s.script.includes(p)).slice(0, 5),
      originality: s.originality ? { overlapRatio: Number(s.originality.overlapRatio) || 0, passed: true } : null,
      source: { title: text(source.title, 200), author: text(source.author?.name, 120), url: httpsUrl(source.url), likes: count(source.metrics?.likes),
        publishedAt: source.publishedAt || null, tags: cleanTags(source.tags) } };
  });
  if (!items.length) throw problem('viral_library_empty', '还没有改写好的稿子，不能发布空的文案库。');
  const ready = new Set(items.map((i) => i.id));
  const s = scan.stats;
  return { schema: 1, updatedAt: now.toISOString(), days: scan.days || 30,
    stats: { collected: s.collected, byPlatform: s.byPlatform || {}, duplicates: s.duplicates, outdated: s.outdated, irrelevant: s.irrelevant, notViral: s.notViral, final: s.final, ready: items.length },
    flow: { strands: strandsFromScan(scan, ready) }, items };
}

// 客户端读回云端文案库时再校验一遍：字段不全、类型不对的整条丢掉，全部不合格就当作还没有文案库。
function validateLibrary(doc) {
  if (!doc || doc.schema !== 1 || !Array.isArray(doc.items)) throw problem('viral_library_invalid', '爆款文案库暂时不可用，请稍后再试。');
  const items = doc.items.filter((i) => i && /^[A-Za-z0-9]{1,64}$/u.test(String(i.id)) && PLATFORMS.has(i.platform) && typeof i.title === 'string' && i.title.trim() && i.title.length <= 24
    && typeof i.script === 'string' && i.script.trim() && i.script.length <= 500).filter((i, index, all) => all.findIndex((o) => String(o.id) === String(i.id)) === index).slice(0, MAX_ITEMS).map((i) => ({
    id: String(i.id), platform: i.platform, title: text(i.title, 24), script: text(i.script, 500),
    emphasisPhrases: (Array.isArray(i.emphasisPhrases) ? i.emphasisPhrases : []).filter((p) => typeof p === 'string' && p.length <= 12 && i.script.includes(p)).slice(0, 5),
    source: { title: text(i.source?.title, 200), author: text(i.source?.author, 120), url: httpsUrl(i.source?.url), likes: count(i.source?.likes), tags: cleanTags(i.source?.tags) } }));
  if (!items.length) throw problem('viral_library_empty', '爆款文案库还在准备中，请稍后再来。');
  const st = doc.stats || {};
  const stats = Object.fromEntries(['collected', 'duplicates', 'outdated', 'irrelevant', 'notViral', 'final', 'ready'].map((k) => [k, count(st[k]) ?? 0]));
  const strands = (Array.isArray(doc.flow?.strands) ? doc.flow.strands : []).slice(0, MAX_STRANDS).filter((s) => s && typeof s.id === 'string' && ['pass', 'drop'].includes(s.outcome))
    .map((s) => ({ id: text(s.id, 64), title: text(s.title, 60), source: text(s.source, 60), group: text(s.group || s.id, 64), outcome: s.outcome, reason: text(s.reason, 80) }));
  return { updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : null, days: count(doc.days) || 30, stats: { ...stats, byPlatform: st.byPlatform && typeof st.byPlatform === 'object' ? st.byPlatform : {} }, strands, items };
}

module.exports = { buildLibrary, validateLibrary, strandsFromScan, MAX_ITEMS, MAX_STRANDS };
