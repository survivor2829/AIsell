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

export function libraryStages(stats: ViralLibrary['stats']): FlowStage[] {
  return [
    { no: '01', label: '搜到', value: stats.collected, unit: '条口播' },
    { no: '02', label: '去重', value: Math.max(0, stats.collected - stats.duplicates), unit: '条原创' },
    { no: '03', label: '筛选', value: stats.final, unit: '条够爆' },
    { no: '04', label: '改写好', value: stats.ready, unit: '条可以直接出片', accent: true }
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
