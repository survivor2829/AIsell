// 爆款一键成片页面用到的纯函数：卡片显示和「只仿写」带入写稿的参考资料。
import type { NarrationReference, ViralItem, ViralProgress, ViralScanResult } from './reference-human-types';
import { platformName } from './flow-funnel';

export const TOP_COUNT = 10;

// 一键成片的预估：数字人按秒计费为主（0.08 元/秒），加上配音和字幕识别的零头；以实际报价为准。
export function estimateCny(maximumSeconds: number | null | undefined) {
  if (!(Number(maximumSeconds) > 0)) return '3—4 元';
  const cny = Number(maximumSeconds) * 0.08 + 0.15;
  return `${cny.toFixed(1)} 元（按 ${Math.round(Number(maximumSeconds))} 秒）`;
}

export function likesText(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '点赞未知';
  return value >= 10000 ? `${(value / 10000).toFixed(2).replace(/\.?0+$/, '')}w` : String(value);
}
export function dateText(value: string | null | undefined) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return '发布时间未知';
  const date = new Date(time);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export const safeLink = (value: string) => { try { const parsed = new URL(value); return parsed.protocol === 'https:' ? parsed.href : undefined; } catch { return undefined; } };

// 带入写稿的参考：字段和长度都按主进程 validateReference 的要求裁好，读不到的保持未知。
export function viralReference(item: ViralItem, collectedAt: string): NarrationReference {
  return {
    platform: item.platform === 'xiaohongshu' ? 'xiaohongshu' : 'douyin',
    title: item.title.slice(0, 200), body: (item.body || '').slice(0, 6000), url: safeLink(item.url) || '',
    author: item.author.name.slice(0, 120), publishedAt: item.publishedAt || null, collectedAt,
    metrics: { likes: Number.isFinite(item.metrics.likes) ? item.metrics.likes : null },
    provenance: `扒爆款 · ${platformName(item.platform)}`
  };
}

// 进度事件 → 页面状态：累计读到的内容、当前提示、哪些平台需要登录。
export type ScanState = { seen: NonNullable<ViralProgress['added']>; message: string; blocked: Record<string, string> };
export const EMPTY_SCAN: ScanState = { seen: [], message: '', blocked: {} };
export function applyProgress(state: ScanState, event: ViralProgress): ScanState {
  const known = new Set(state.seen.map((item) => item.id));
  const added = (event.added || []).filter((item) => !known.has(item.id));
  return {
    seen: added.length ? [...state.seen, ...added] : state.seen,
    // 被拦的提示放在登录条里，不当成「正在扒取」的进度文字。
    message: event.stage === 'blocked' ? state.message : event.message || state.message,
    blocked: event.stage === 'blocked' && event.platform ? { ...state.blocked, [event.platform]: event.message } : state.blocked
  };
}

// 扒完后的一句话总结；平台被拦或中途暂停时说清楚，不让人误以为结果是全的。
export function resultSummary(result: ViralScanResult) {
  const blocked = result.platforms.filter((p) => p.status === 'blocked').map((p) => p.name);
  const parts = [`${result.stats.collected} 条里挑出 ${result.stats.final} 条爆款`];
  if (result.stopped) parts.push('已暂停，结果只含暂停前读到的内容');
  if (blocked.length) parts.push(`${blocked.join('、')}没有扒到，需要先登录或完成验证`);
  return parts.join('；');
}
