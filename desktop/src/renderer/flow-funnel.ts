// 流图的数据和布局：纯函数，不碰 DOM，自检直接调用。
// 每条线是一条真实内容；同一束是被合并的搬运内容（或同一原因被筛掉的一组）；过闸门的汇入产出。
import type { ViralBrief, ViralScanResult, ViralTag } from './reference-human-types';

export type FlowStrand = { id: string; title: string; source: string; group?: string; outcome?: 'pass' | 'drop'; reason?: string };
export type FlowStage = { no: string; label: string; value: number | null; unit: string; note?: string; accent?: boolean };
export type FlowBundle = { key: string; members: number[]; pass: boolean; reason: string; merged: boolean; y: number; half: number };
export type FlowLine = { strand: FlowStrand; ys: Float32Array; end: number; bundle: number };
export type FlowLayout = {
  w: number; h: number; decided: boolean; lines: FlowLine[]; bundles: FlowBundle[];
  x1: number; x2: number; gate: number; xo: number; outY: number; icon: { x: number; y: number; w: number; h: number };
};

export const FLOW_STEP = 3;
export const FLOW_STAGE_X = [0, 0.25, 0.5, 0.75, 1];
const MAX_BUNDLES = 12;

const smooth = (t: number) => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
// 每条线的起伏由它的 id 决定，新内容进来重新布局时，老线条的形状不跳。
function rng(seed: number) {
  return () => {
    seed = (seed + 1831565813) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const isDecided = (strands: FlowStrand[]) => strands.length > 0 && strands.every((s) => s.outcome);

// 分束：同一 group（搬运合并）一束，束的去留看领头那条（id 等于 group 的那条）。
// 束太多画不清时，没通过的按原因合成一束；还多就把通过的也合成一束。
export function bundleStrands(strands: FlowStrand[], maxBundles = MAX_BUNDLES) {
  if (!isDecided(strands)) return [];
  const groups = new Map<string, number[]>();
  strands.forEach((s, i) => { const key = s.group || s.id; groups.set(key, [...(groups.get(key) || []), i]); });
  const lead = (key: string, members: number[]) => strands[members.find((i) => strands[i].id === key) ?? members[0]];
  type Draft = { key: string; members: number[]; pass: boolean; reason: string; merged: boolean };
  let drafts: Draft[] = [...groups].map(([key, members]) => { const head = lead(key, members); return { key, members, pass: head.outcome === 'pass', reason: head.reason || '', merged: false }; });
  const mergeBy = (list: Draft[], keyOf: (d: Draft) => string) => {
    const merged = new Map<string, Draft>();
    for (const d of list) {
      const key = keyOf(d), old = merged.get(key);
      if (old) { old.members.push(...d.members); old.merged = true; } else merged.set(key, { ...d, key, members: [...d.members] });
    }
    return [...merged.values()];
  };
  if (drafts.length > maxBundles) drafts = [...drafts.filter((d) => d.pass), ...mergeBy(drafts.filter((d) => !d.pass), (d) => `drop:${d.reason}`)];
  if (drafts.length > maxBundles) drafts = [...mergeBy(drafts.filter((d) => d.pass), () => 'pass').map((d) => ({ ...d, reason: '进候选' })), ...drafts.filter((d) => !d.pass)];
  // 通过的束均匀插在没通过的束之间，闸门上的口子不会挤在一起。
  const passing = drafts.filter((d) => d.pass), failing = drafts.filter((d) => !d.pass);
  const total = drafts.length, slots = new Set(passing.map((_, i) => Math.round(((i + 0.5) * total) / passing.length - 0.5)));
  const ordered: Draft[] = [];
  for (let i = 0, p = 0, f = 0; i < total; i += 1) ordered.push(slots.has(i) && p < passing.length ? passing[p++] : f < failing.length ? failing[f++] : passing[p++]);
  return ordered;
}

export function layoutFlow(strands: FlowStrand[], w: number, h: number): FlowLayout {
  const decided = isDecided(strands);
  const drafts = bundleStrands(strands);
  const x1 = w * FLOW_STAGE_X[1], x2 = w * FLOW_STAGE_X[2], gate = w * 0.625, xo = w * 0.8, outY = h * 0.42;
  const pw = Math.max(26, Math.min(60, w * 0.04)), ph = pw * 1.32;
  const icon = { x: w * 0.875 - pw / 2, y: outY - ph / 2, w: pw, h: ph };
  const pad = Math.max(14, h * 0.07), total = strands.length, nb = Math.max(1, drafts.length);
  const order = decided ? drafts.flatMap((d) => d.members) : strands.map((_, i) => i);
  const biggest = Math.max(1, ...drafts.map((d) => d.members.length));
  const gap = Math.max(0.8, Math.min(1.6, (h * 0.075) / biggest));
  const bundles: FlowBundle[] = drafts.map((d, i) => ({ ...d, y: h * 0.14 + ((i + 0.5) / nb) * h * 0.72, half: (d.members.length * gap) / 2 }));
  const bundleOf = new Map<number, number>();
  bundles.forEach((b, bi) => b.members.forEach((m) => bundleOf.set(m, bi)));
  const cols = Math.ceil(w / FLOW_STEP) + 1, band = (h - 2 * pad) / Math.max(1, total);
  const lines: FlowLine[] = [];
  let k = 0;
  for (const bi of decided ? bundles.map((_, i) => i) : [-1]) {
    const members = bi < 0 ? order : bundles[bi].members;
    const mid = pad + ((k + members.length / 2) / Math.max(1, total)) * (h - 2 * pad);
    members.forEach((index, j) => {
      const strand = strands[index], r = rng(hash(strand.id));
      const y0 = pad + (k + 0.5) * band + (r() - 0.5) * band * 0.8;
      const amp = 2 + r() * 5, freq = (Math.PI * 2) / (70 + r() * 140), phase = r() * Math.PI * 2;
      const ys = new Float32Array(cols);
      const b = bi < 0 ? null : bundles[bi], off = (j - (members.length - 1) / 2) * gap;
      const yAtX1 = y0 + (mid - y0) * 0.25 + amp * 0.4 * Math.sin(freq * x1 + phase);
      for (let c = 0; c < cols; c += 1) {
        const x = c * FLOW_STEP;
        if (x <= x1 || !b) { const t = Math.min(1, x / x1); ys[c] = y0 + (mid - y0) * 0.25 * smooth(t) + amp * (1 - 0.6 * t) * Math.sin(freq * x + phase); }
        else if (x <= x2) ys[c] = yAtX1 + (b.y + off - yAtX1) * smooth((x - x1) / (x2 - x1));
        else if (!b.pass || x <= gate) ys[c] = b.y + off;
        else if (x <= xo) ys[c] = b.y + off + (outY + off * 0.5 - b.y - off) * smooth((x - gate) / (xo - gate));
        else ys[c] = outY + off * 0.5;
      }
      // 还没判定的线停在归并段末尾；判定后没通过的停在闸门后，通过的一直到产出。
      const end = !b ? x2 : b.pass ? icon.x : gate + w * 0.045;
      lines.push({ strand, ys, end, bundle: bi });
      k += 1;
    });
  }
  return { w, h, decided, lines, bundles, x1, x2, gate, xo, outY, icon };
}

// 鼠标悬停说明：前半段说这条是什么，归并段说合并了几条，闸门后说为什么进 / 没进。
export function describeHover(layout: FlowLayout, line: number, x: number) {
  const l = layout.lines[line], s = l.strand, b = layout.bundles[l.bundle];
  const title = s.title || '（没有标题）';
  if (!b || x < layout.x2) return { title, detail: s.source };
  const n = b.members.length;
  // 合并束里只数原作；并进来的搬运另外说明，数字和四段统计对得上。
  const heads = layout.lines.filter((other) => other.bundle === l.bundle && (other.strand.group || other.strand.id) === other.strand.id).length;
  const copies = n - heads ? `，另有 ${n - heads} 条搬运并在这一束` : '';
  if (b.merged) return b.pass ? { title: `${heads} 条进候选`, detail: `命中至少一种爆款指标${copies}` } : { title: `${heads} 条没进：${b.reason}`, detail: `同一原因的合在一起画${copies}` };
  if (x < layout.gate) return n > 1 ? { title: `同一文案 ${n} 条`, detail: '多人发了几乎一样的内容，只留点赞最高的一条' } : { title, detail: s.source };
  return b.pass ? { title, detail: `进候选：${b.reason}` } : { title, detail: `没进：${b.reason}` };
}

const PLATFORM_NAMES: Record<string, string> = { douyin: '抖音', xiaohongshu: '小红书' };
export const platformName = (id: string) => PLATFORM_NAMES[id] || id;
const wan = (value: number) => value >= 10000 ? `${(value / 10000).toFixed(value >= 100000 ? 1 : 2).replace(/\.?0+$/, '')}w` : String(value);
export function tagText(tag: ViralTag) {
  if (tag.id === 'high_likes') return `${tag.label} ${wan(tag.value)}`;
  if (tag.id === 'underdog') return `${tag.label} ×${tag.value}`;
  return `${tag.label} ${tag.value} 条`;
}

// 扒爆款：扒取中只有「读到了哪些」，扒完后用结果给每条线定去向；四段数字全部来自真实统计。
export function viralFlow(seen: ViralBrief[], result?: ViralScanResult | null, topN = 10): { strands: FlowStrand[]; stages: FlowStage[] } {
  const source = (b: { platform: string; author?: string }) => [platformName(b.platform), b.author].filter(Boolean).join(' · ');
  const byPlatform = (counts: Record<string, number>) => Object.entries(counts).map(([p, n]) => `${platformName(p)} ${n}`).join(' · ');
  if (!result) {
    const unique = [...new Map(seen.map((b) => [b.id, b])).values()];
    const counts: Record<string, number> = {};
    for (const b of unique) counts[b.platform] = (counts[b.platform] || 0) + 1;
    return {
      strands: unique.map((b) => ({ id: b.id, title: b.title, source: source(b) })),
      stages: [
        { no: '01', label: '搜到', value: unique.length, unit: '条视频和笔记', note: byPlatform(counts) || '正在搜索' },
        { no: '02', label: '去重', value: null, unit: '条原创', note: '扒完后统计' },
        { no: '03', label: '筛选', value: null, unit: '条进候选', note: '扒完后统计' },
        { no: '04', label: '爆款清单', value: null, unit: '条可以仿写', note: '命中指标越多越靠前', accent: true }
      ]
    };
  }
  const known = new Map(seen.map((b) => [b.id, b]));
  const strands: FlowStrand[] = [
    ...result.items.map((item) => ({ id: item.id, title: item.title || known.get(item.id)?.title || '', source: source({ platform: item.platform, author: item.author.name }),
      group: item.id, outcome: 'pass' as const, reason: item.tags.map(tagText).join(' · ') })),
    ...result.removed.map((r) => ({ id: r.id, title: r.title || known.get(r.id)?.title || '', source: source(r), group: r.twinId || r.id, outcome: 'drop' as const, reason: r.label }))
  ];
  const s = result.stats;
  const dropped = [[s.irrelevant, '和清洁无关'], [s.notViral, '不够爆'], [s.outdated, "过期"]].filter(([n]) => Number(n) > 0).map(([n, label]) => `${label} ${n}`);
  return {
    strands,
    stages: [
      { no: '01', label: '搜到', value: s.collected, unit: '条视频和笔记', note: byPlatform(s.byPlatform) || '没有搜到内容' },
      { no: '02', label: '去重', value: s.collected - s.duplicates, unit: '条原创', note: `去掉搬运和重复 ${s.duplicates} 条` },
      { no: '03', label: '筛选', value: s.final, unit: '条进候选', note: dropped.join(' · ') || '没有筛掉' },
      { no: '04', label: '爆款清单', value: Math.min(topN, s.final), unit: '条可以仿写', note: '命中指标越多越靠前', accent: true }
    ]
  };
}
