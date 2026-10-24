import { useEffect, useState } from 'react';
import type { DigitalHumanResult } from './digital-human-types';
import type { ReferenceHumanApi, ViralJob } from './reference-human-types';

async function unwrap<T>(result: Promise<DigitalHumanResult<T>>): Promise<T> {
  const value = await result; if (!value.ok || value.data === undefined) throw new Error(value.error || '操作未完成，请稍后重试。'); return value.data;
}
const SOURCE: Record<string, string> = { asr: '原口播转写', note: '笔记正文', caption: '只有视频描述' };

function Cover({ api, id }: { api: ReferenceHumanApi; id: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => { let active = true; void unwrap(api.viralPipelineCover({ id })).then((r) => { if (active) setSrc(r.dataUrl); }).catch(() => {}); return () => { active = false; }; }, [id]);
  return src ? <img className="vq-cover" src={src} alt="大字封面" /> : null;
}

function statusText(job: ViralJob, ahead: number) {
  if (job.status === 'done') return '已完成，成片在成片中心';
  if (job.status === 'failed') return job.error;
  if (job.status === 'queued') return ahead > 0 ? `排队中，前面还有 ${ahead} 条` : job.message || '马上开始';
  const step = job.steps.find((s) => s.state === 'active');
  const percent = ['voice', 'video', 'package'].includes(job.step) && job.progress > 0 ? ` ${job.progress}%` : '';
  return `${step ? `正在${step.label}` : '正在处理'}${percent}${job.message ? ` · ${job.message}` : ''}`;
}

export function ViralQueue({ api, jobs, onError }: { api: ReferenceHumanApi; jobs: ViralJob[]; onError: (message: string) => void }) {
  const [busy, setBusy] = useState('');
  async function act(id: string, action: () => Promise<unknown>) {
    setBusy(id);
    try { await action(); } catch (error) { onError((error as Error).message); } finally { setBusy(''); }
  }
  const waiting = jobs.filter((j) => ['queued', 'running'].includes(j.status)).reverse();
  if (!jobs.length) return <p className="vp-muted">点卡片上的「一键成片」，选中的爆款会在这里排队，依次完成提取 → 仿写 → 配音 → 数字人 → 剪辑 → 封面。</p>;
  return (
    <div className="vq-list">
      {jobs.map((job) => (
        <div key={job.id} className={`vq-item is-${job.status}`}>
          <div className="vq-title" title={job.title}>{job.script?.title || job.title}</div>
          <div className="vq-steps" aria-label={job.steps.map((s) => `${s.label}${s.state === 'done' ? '已完成' : s.state === 'failed' ? '失败' : ''}`).join('，')}>
            {job.steps.map((step) => <i key={step.id} title={step.label} className={`is-${step.state}`}
              style={step.state === 'active' && ['voice', 'video', 'package'].includes(step.id) ? { background: `linear-gradient(90deg, #e60000 ${job.progress}%, #fbd5d9 ${job.progress}%)` } : undefined} />)}
          </div>
          <div className="vq-status">{statusText(job, Math.max(0, waiting.findIndex((j) => j.id === job.id)))}</div>
          {(job.transcriptSource || job.script?.originality || job.quoteMaximumCny !== null) && <div className="vq-meta">
            {job.transcriptSource && <span>原文：{SOURCE[job.transcriptSource]}</span>}
            {job.script?.originality && <span>和原文重复 {Math.round(job.script.originality.overlapRatio * 100)}%</span>}
            {job.quoteMaximumCny !== null && <span>报价最多 {job.quoteMaximumCny} 元（上限 {job.maxCny} 元）</span>}
          </div>}
          {job.status === 'done' && job.coverReady && <Cover api={api} id={job.id} />}
          {job.status === 'done' && job.coverError && <div className="vq-meta">{job.coverError}</div>}
          <div className="vq-actions">
            {job.retryable && <button type="button" className="dh-button" data-xiaoxi-digital-human-action="reference-viral-pipeline-retry" disabled={busy === job.id}
              onClick={() => void act(job.id, () => unwrap(api.viralPipelineRetry({ id: job.id })))}>重试</button>}
            {job.status !== 'running' && <button type="button" className="dh-text-button" disabled={busy === job.id}
              onClick={() => void act(job.id, () => unwrap(api.viralPipelineRemove({ id: job.id })))}>移出队列</button>}
          </div>
        </div>
      ))}
    </div>
  );
}
