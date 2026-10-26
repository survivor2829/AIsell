// 数字人视频（极简版）页面的纯函数：标题、四段数字、底部进度文字。数字全部来自云端文案库的真实统计。
import type { FlowStage } from './flow-funnel';
import type { ViralJob, ViralLibrary } from './reference-human-types';

export const formatCount = (value: number) => value.toLocaleString('en-US');

// 页面大标题：只说真实条数，不说哪天扒的——文案库一次扒好能用很久，写「今天」会和事实不符。
export function libraryHeadline(stats: ViralLibrary['stats']) {
  return { lead: `全网扒了 ${formatCount(stats.collected)} 条清洁行业口播，`, ready: `${formatCount(stats.ready)} 条爆款` };
}

const PLATFORM_NAMES: Record<string, string> = { douyin: '抖音', xiaohongshu: '小红书' };
const joinCounts = (parts: [string, number | undefined][]) => parts.filter(([, n]) => Number(n) > 0).map(([label, n]) => `${label} ${n}`).join(' · ');

// 四张步骤卡：大号数字是真实统计，说明讲这一步做了什么，小字是这一步的明细。
export function libraryStages(stats: ViralLibrary['stats']): FlowStage[] {
  const byPlatform = Object.entries(stats.byPlatform || {}).map(([p, n]) => [PLATFORM_NAMES[p] || p, n] as [string, number]);
  return [
    { no: '01', label: '搜到', value: stats.collected, unit: '条口播', note: '抖音、小红书上清洁行业最近发布的口播视频和笔记。', hint: joinCounts(byPlatform) },
    { no: '02', label: '去重', value: Math.max(0, stats.collected - stats.duplicates), unit: '条原创', note: '多人发的几乎一样的内容合成一条，只留点赞最高的原作。', hint: stats.duplicates ? `去掉搬运和重复 ${stats.duplicates} 条` : '' },
    { no: '03', label: '筛选', value: stats.final, unit: '条够爆', note: '看点赞、评论里问价的人数、小号也能爆这些真实指标。', hint: joinCounts([['不够爆', stats.notViral], ['和清洁无关', stats.irrelevant], ['过期', stats.outdated]]) },
    { no: '04', label: '进文案库', value: stats.ready, unit: '条爆款', note: '提取出原口播。你选一条、选时长，再仿写成自己的原创稿。', accent: true }
  ];
}

// 仿写时长：不能超过本人视频（主进程写稿时还会再留 3 秒余量给配音）；还没上传视频时都能选。
export const SCRIPT_SECONDS = [30, 45, 60] as const;
export type ScriptSeconds = typeof SCRIPT_SECONDS[number];
export const longestScriptSeconds = (videoSeconds?: number) => videoSeconds ? Math.floor(videoSeconds) : Infinity;

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
