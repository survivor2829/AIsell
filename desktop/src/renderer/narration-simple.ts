// 数字人视频（极简版）页面的纯函数：标题、四段数字、底部进度文字。数字全部来自云端文案库的真实统计。
import type { FlowStage } from './flow-funnel';
import type { ViralJob, ViralLibrary } from './reference-human-types';

export function dayWord(updatedAt: string | null, now = new Date()) {
  const time = Date.parse(updatedAt || '');
  if (!Number.isFinite(time)) return '最近';
  const date = new Date(time);
  if (date.toDateString() === now.toDateString()) return '今天';
  if (date.toDateString() === new Date(now.getTime() - 86400000).toDateString()) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}
export function updatedText(updatedAt: string | null, now = new Date()) {
  const time = Date.parse(updatedAt || '');
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  return `${dayWord(updatedAt, now)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} 已更新`;
}
export const formatCount = (value: number) => value.toLocaleString('en-US');

const PLATFORM_NAMES: Record<string, string> = { douyin: '抖音', xiaohongshu: '小红书' };
const joinCounts = (parts: [string, number | undefined][]) => parts.filter(([, n]) => Number(n) > 0).map(([label, n]) => `${label} ${n}`).join(' · ');

// 四张步骤卡：大号数字是真实统计，说明讲这一步做了什么，小字是这一步的明细。
export function libraryStages(stats: ViralLibrary['stats']): FlowStage[] {
  const byPlatform = Object.entries(stats.byPlatform || {}).map(([p, n]) => [PLATFORM_NAMES[p] || p, n] as [string, number]);
  return [
    { no: '01', label: '搜到', value: stats.collected, unit: '条口播', note: '抖音、小红书上清洁行业最近发布的口播视频和笔记。', hint: joinCounts(byPlatform) },
    { no: '02', label: '去重', value: Math.max(0, stats.collected - stats.duplicates), unit: '条原创', note: '多人发的几乎一样的内容合成一条，只留点赞最高的原作。', hint: stats.duplicates ? `去掉搬运和重复 ${stats.duplicates} 条` : '' },
    { no: '03', label: '筛选', value: stats.final, unit: '条够爆', note: '看点赞、评论里问价的人数、小号也能爆这些真实指标。', hint: joinCounts([['不够爆', stats.notViral], ['和清洁无关', stats.irrelevant], ['过期', stats.outdated]]) },
    { no: '04', label: '改写好', value: stats.ready, unit: '条可以直接出片', note: '内容换成清洁设备，只学原爆款的结构和节奏，过了原创度检测。', accent: true }
  ];
}

// 底部栏：选中后显示要做什么；开始后显示当前进度；完成或失败时说清楚。
export function barText(job: ViralJob | undefined) {
  if (!job) return null;
  if (job.status === 'done') return { tone: 'done' as const, text: '已出片，成片在成片中心', progress: 100 };
  if (job.status === 'failed') return { tone: 'failed' as const, text: job.error || '这条没有做完，已有结果保留', progress: 0 };
  if (job.status === 'queued') return { tone: 'busy' as const, text: '马上开始', progress: 0 };
  const label = ({ voice: '正在用你的声音配音', video: '正在生成数字人', package: '正在配字幕和音乐', cover: '正在做封面' } as Record<string, string>)[job.step] || '正在处理';
  const progress = job.step === 'cover' ? 99 : Math.max(2, job.progress || 0);
  return { tone: 'busy' as const, text: `${label} · ${progress}%`, progress };
}
