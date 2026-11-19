// 线索视频混剪 · 方案A pieces: a big four-step bar, the making ring with four stages and one row per video,
// the 「做几条」 picker, and the one-at-a-time player for finished videos.
import { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, CircleCheck, Clock3, Clapperboard, ImageIcon, Lightbulb, Play } from "lucide-react";
import { type Candidate, videoUrl } from "./batch-studio-api";
import { VideoDownloadButton } from "./VideoPresentation";

const STEP_ICONS = [ImageIcon, Lightbulb, Clock3, Play];
export function MixSteps({ labels, current, enabled, onChange }: { labels: string[]; current: number; enabled: boolean[]; onChange: (index: number) => void }) {
  return <nav className="mix-steps" aria-label="制作步骤">{labels.map((label, index) => {
    const Icon = index < current ? Check : STEP_ICONS[index];
    const state = index < current ? "done" : index === current ? "on" : "todo";
    return <button key={label} type="button" className={`is-${state}`} aria-current={index === current ? "step" : undefined} disabled={!enabled[index]} onClick={() => onChange(index)}>
      <span className="mix-step-icon"><Icon size={22} strokeWidth={2.4} /></span>{label}</button>;
  })}</nav>;
}

const STAGES = [{ key: "analysis", label: "看懂素材", Icon: ImageIcon }, { key: "script", label: "写好文案", Icon: Lightbulb }, { key: "production", label: "剪辑配音", Icon: Clapperboard }, { key: "complete", label: "成片", Icon: CircleCheck }];
const STAGE_INDEX: Record<string, number> = { analysis: 0, script: 1, production: 2, finalizing: 2, complete: 3 };
export type MixRow = { key: string; label: string; state: "done" | "now" | "wait" | "failed" };
export function MixProgress({ percent, phase, finished, stopped = false, title, lines, rows }: { percent: number | null; phase?: string; finished: boolean; stopped?: boolean; title: string; lines: string[]; rows: MixRow[] }) {
  const r = 92, c = 2 * Math.PI * r, value = percent ?? 0;
  const at = finished ? 4 : STAGE_INDEX[phase || ""] ?? -1;
  return <div className="mix-progress">
    <div className="mix-ring" role="img" aria-label={percent === null ? "等待服务返回" : `完成 ${value}%`}>
      <svg viewBox="0 0 220 220"><circle cx="110" cy="110" r={r} className="mix-ring-track" /><circle cx="110" cy="110" r={r} className={`mix-ring-value${percent === null ? " is-waiting" : ""}`} strokeDasharray={`${percent === null ? c * 0.25 : c * value / 100} ${c}`} /></svg>
      <div><b>{percent === null ? "…" : `${value}%`}</b>{lines.filter(Boolean).map(line => <span key={line}>{line}</span>)}</div>
    </div>
    <div className="mix-progress-side">
      <strong className="mix-progress-title">{title}</strong>
      <div className="mix-stages">{STAGES.map(({ key, label, Icon }, index) => {
        const state = index < at ? "done" : index === at ? "now" : "wait";
        return <div key={key} className={`is-${state}`}><span><Icon size={20} strokeWidth={2.2} /></span>{label}<em>{state === "done" ? "✓" : state === "now" ? (stopped ? "停住了" : "进行中") : "等待"}</em></div>;
      })}</div>
      {rows.length > 0 && <div className="mix-rows">{rows.map(row => <div key={row.key} className={`is-${row.state}`}>
        <span>{row.label}</span><i><b /></i><em>{row.state === "done" ? "已做好" : row.state === "now" ? "制作中" : row.state === "failed" ? "没做成" : "排队"}</em></div>)}</div>}
    </div>
  </div>;
}

const COUNTS = [3, 6, 10];
export function MixCount({ value, disabled, onChange }: { value: string; disabled?: boolean; onChange: (value: string) => void }) {
  // What is typed in 自己填 stays there, even while it passes through 3, 6 or 10 (typing 30).
  const [custom, setCustom] = useState(() => COUNTS.includes(Number(value)) ? "" : value);
  const preset = !custom && COUNTS.includes(Number(value));
  return <div className="mix-count" role="group" aria-label="做几条">
    {COUNTS.map(count => <button key={count} type="button" disabled={disabled} aria-pressed={Number(value) === count} className={Number(value) === count ? "is-on" : ""} onClick={() => { setCustom(""); onChange(String(count)); }}>{count} 条</button>)}
    <label className={custom ? "is-on" : ""}><span>自己填</span><input aria-label="自己填做几条" type="number" min={1} max={300} step={1} disabled={disabled} value={custom} placeholder="几" onChange={event => { setCustom(event.target.value); onChange(event.target.value); }} /><span>条</span></label>
  </div>;
}

export function MixPlayer({ videos, waiting = [], onOpenFolder }: { videos: Candidate[]; waiting?: MixRow[]; onOpenFolder?: () => void }) {
  const [index, setIndex] = useState(0);
  useEffect(() => { if (index >= videos.length) setIndex(Math.max(0, videos.length - 1)); }, [videos.length, index]);
  const current = videos[index];
  if (!current?.generated_video_id) return null;
  const go = (step: number) => setIndex((index + step + videos.length) % videos.length);
  return <section className="mix-player" aria-label="一条一条看成片">
    <video key={current.generated_video_id} controls controlsList="nodownload" preload="metadata" src={videoUrl(current.generated_video_id)} />
    <div className="mix-player-side">
      <div className="mix-player-nav"><button type="button" aria-label="上一条" disabled={videos.length < 2} onClick={() => go(-1)}><ChevronLeft size={28} /></button><b>第 {index + 1} 条 / 共 {videos.length} 条</b><button type="button" aria-label="下一条" disabled={videos.length < 2} onClick={() => go(1)}><ChevronRight size={28} /></button></div>
      <div className="mix-player-dots">{videos.map((video, i) => <button key={video.candidate_id} type="button" aria-label={`第 ${i + 1} 条`} className={i === index ? "is-on" : ""} onClick={() => setIndex(i)} />)}</div>
      <h3>{current.title}</h3>
      <p className="mix-player-copy">{current.narration}</p>
      <div className="mix-player-actions"><VideoDownloadButton generatedId={current.generated_video_id} />{onOpenFolder && <button type="button" onClick={onOpenFolder}>打开成片文件夹</button>}</div>
      {videos.length > 1 && <div className="mix-player-strip">{videos.map((video, i) => <button key={video.candidate_id} type="button" className={i === index ? "is-on" : ""} onClick={() => setIndex(i)} aria-label={`看第 ${i + 1} 条`}>
        <img src={videoUrl(video.generated_video_id!, "thumbnail")} alt="" /><span>{i + 1}</span></button>)}</div>}
      {waiting.length > 0 && <div className="mix-player-more" aria-label="还在做的">{waiting.map(row => <div key={row.key}><span>{row.state === "now" ? <Clapperboard size={20} /> : <Clock3 size={20} />}</span>{row.label} · {row.state === "now" ? "制作中" : row.state === "failed" ? "没做成" : "排队"}</div>)}</div>}
    </div>
  </section>;
}
