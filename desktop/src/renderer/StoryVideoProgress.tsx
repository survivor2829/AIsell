// 场景效果视频 · 剧情版 progress: the 定妆照 to confirm, the story and its two people, the storyboards
// as they are drawn, and each 15-second part as it is filmed.
import { useEffect, useState } from "react";
import { Check, Clapperboard, Image as ImageIcon, LoaderCircle, PenLine, RefreshCw, Subtitles, Users } from "lucide-react";

export type StoryTask = {
  id: string; status: string; statusLabel: string; durationSeconds: number; currentShot: number; completedShots: number;
  shotsReady?: boolean[]; shotsRunning?: boolean[]; plan: { shots: { index: number }[] };
  imagesReady?: Record<string, boolean>; imageTotal?: number; sheetRedos?: number;
  story?: { title: string; logline: string; characters: { name: string; role: string }[]; lines: { who: string; line: string }[] } | null;
};
type MediaResult = { ok: boolean; data?: { dataUrl: string } };
type Props = {
  task: StoryTask; busy: boolean;
  imageMedia: (id: string, key: string) => Promise<MediaResult>;
  shotMedia: (id: string, index: number) => Promise<MediaResult>;
  onConfirm: () => void; onRedo: () => void;
};

const STAGES = [
  { key: "sheet", label: "定妆照", Icon: ImageIcon },
  { key: "story", label: "写故事", Icon: PenLine },
  { key: "cast", label: "场景和演员", Icon: Users },
  { key: "board", label: "画分镜", Icon: ImageIcon },
  { key: "film", label: "拍视频", Icon: Clapperboard },
  { key: "subtitle", label: "加字幕", Icon: Subtitles }
];
export function storyStage(task: StoryTask) {
  const ready = task.imagesReady || {};
  if (task.status === "completed") return 6;
  if (["assembling", "transcribing", "packaging", "enhancing"].includes(task.status)) return 5;
  if (["submitting", "generating"].includes(task.status) || ready.grid_0) return 4;
  if (ready.person_b) return 3;
  if (task.story) return 2;
  if (ready.sheet && task.status !== "awaiting_sheet") return 1;
  return 0;
}
export function storyProgress(task: StoryTask) {
  if (task.status === "completed") return 100;
  const done = Object.keys(task.imagesReady || {}).filter((key) => !key.startsWith("grid_")).length, total = Math.max(1, task.imageTotal || 1);
  const parts = task.plan.shots.length || 1;
  return Math.min(97, Math.round(done / total * 45 + (task.story ? 5 : 0) + task.completedShots / parts * 42 + (storyStage(task) >= 5 ? 5 : 0)));
}

export function StoryVideoProgress({ task, busy, imageMedia, shotMedia, onConfirm, onRedo }: Props) {
  const [pictures, setPictures] = useState<Record<string, string>>({});
  const [videos, setVideos] = useState<Record<number, string>>({});
  const ready = task.imagesReady || {};
  const keys = ["sheet", "scene", "person_a", "person_b", ...task.plan.shots.map((_, i) => `grid_${i}`)].filter((key) => ready[key]);
  const readyKey = keys.join(",") + `|${task.sheetRedos || 0}`;
  useEffect(() => { setPictures({}); setVideos({}); }, [task.id]);
  useEffect(() => {
    let disposed = false;
    // A redone 定妆照 is loaded again.
    if (task.status === "awaiting_sheet") setPictures((old) => { const next = { ...old }; delete next.sheet; return next; });
    for (const key of keys) if (!pictures[key] || key === "sheet") void imageMedia(task.id, key).then((result) => {
      if (!disposed && result.ok && result.data) setPictures((old) => ({ ...old, [key]: result.data!.dataUrl }));
    }).catch(() => {});
    return () => { disposed = true; };
  }, [task.id, readyKey]);
  useEffect(() => {
    let disposed = false;
    (task.shotsReady || []).forEach((isReady, index) => { if (isReady && !videos[index]) void shotMedia(task.id, index).then((result) => {
      if (!disposed && result.ok && result.data) setVideos((old) => ({ ...old, [index]: result.data!.dataUrl }));
    }).catch(() => {}); });
    return () => { disposed = true; };
  }, [task.id, task.completedShots]);

  if (task.status === "awaiting_sheet") return <div className="sv-sheet">
    <h3>这是你的产品吗？</h3>
    <p>AI 先照着产品图画了四个角度。像的话就继续，后面整条视频都按这台机器来拍。</p>
    <div className="sv-sheet-image">{pictures.sheet ? <img src={pictures.sheet} alt="定妆照" /> : <LoaderCircle size={40} className="spin" />}</div>
    <div className="sv-sheet-actions">
      <button type="button" className="pv2-btn is-main" data-product-video-action="confirm-sheet" disabled={busy || !pictures.sheet} onClick={onConfirm}><Check size={20} />就是这台，继续</button>
      <button type="button" className="pv2-btn" data-product-video-action="redo-sheet" disabled={busy || (task.sheetRedos || 0) >= 2} onClick={onRedo}><RefreshCw size={18} />不像，重出一张{(task.sheetRedos || 0) < 2 ? `（还能 ${2 - (task.sheetRedos || 0)} 次）` : ""}</button>
    </div>
  </div>;

  const stage = storyStage(task);
  return <div className="sv-progress">
    <ol className="sv-stages">{STAGES.map(({ key, label, Icon }, index) => <li key={key} className={index < stage ? "is-done" : index === stage ? "is-now" : ""}>
      <span>{index < stage ? <Check size={18} strokeWidth={3} /> : <Icon size={18} />}</span>{label}</li>)}</ol>
    {task.story && <section className="sv-story">
      <b>「{task.story.title}」</b><p>{task.story.logline}</p>
      <div className="sv-cast">{task.story.characters.map((person, index) => <figure key={person.name}>
        {pictures[index ? "person_b" : "person_a"] ? <img src={pictures[index ? "person_b" : "person_a"]} alt="" /> : <span><Users size={26} /></span>}
        <figcaption><b>{person.name}</b>{person.role}</figcaption></figure>)}
        {pictures.scene && <figure><img src={pictures.scene} alt="" /><figcaption><b>场景</b>拍摄地点</figcaption></figure>}</div>
      {task.story.lines.length > 0 && <ul className="sv-lines">{task.story.lines.slice(0, 8).map((row, i) => <li key={i}><b>{row.who}</b>“{row.line}”</li>)}</ul>}
    </section>}
    {task.plan.shots.length > 0 && stage >= 3 && <div className="sv-parts">{task.plan.shots.map((_, index) => {
      // Parts are filmed at the same time now (2026-11-19), so more than one can be in progress.
      const video = videos[index], board = pictures[`grid_${index}`], filming = task.shotsRunning ? Boolean(task.shotsRunning[index]) : index === task.currentShot && stage === 4;
      return <figure key={index} className={video ? "is-done" : filming ? "is-now" : ""}>
        {video ? <video src={video} controls muted preload="metadata" /> : board ? <img src={board} alt={`第 ${index + 1} 段分镜`} /> : <span><LoaderCircle size={28} className="spin" /></span>}
        <figcaption>第 {index + 1} 段 · {video ? "拍好了" : filming ? "正在拍" : board ? "分镜好了" : "画分镜中"}</figcaption></figure>;
    })}</div>}
  </div>;
}
