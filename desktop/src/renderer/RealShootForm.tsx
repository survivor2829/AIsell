// 场景效果视频 · 无人实拍 + AI 导演 (2026-11-19, "less structure, more intelligence"): the customer gives
// the photos and the product name, picks the kind of place and the selling points (or writes their own);
// the AI director looks at the photos and decides the rest. While it is made: a countdown, what the
// director understood, each shot as it is filmed, and afterwards the AI check of every shot.
import { useEffect, useState } from "react";
import { AlertTriangle, Check, Clapperboard, Clock, Hourglass, ImagePlus, LoaderCircle, MapPin, Plus, RefreshCw, ScanEye, Sparkles, Subtitles, X } from "lucide-react";
import { SceneIcon } from "./SceneIcons";

type Item = { id: string; name: string };
export type RealCatalog = {
  scenes: Item[]; points: (Item & { caption: string; cleaning?: boolean })[];
  durations: number[]; pointLimit: Record<string, number>; minShots: Record<string, number>; customLimit: number; customLength: number;
};
export type Timing = { image: number; story: number; finish: number; video15: number; video6: number; shotSlots: number; imageSlots: number };
export type RealDraft = { sceneId: string; pointIds: string[]; customPoints: string[] };
export const initialReal: RealDraft = { sceneId: "", pointIds: [], customPoints: [] };
export type ProductImage = { id: string; name: string; previewDataUrl: string };

// A video shot takes roughly this long, between the measured 6- and 15-second times.
const videoSeconds = (timing: Timing, seconds: number) => Math.max(60, timing.video6 + (timing.video15 - timing.video6) * (seconds - 6) / 9);
export function realEstimate(timing: Timing | undefined, catalog: RealCatalog | undefined, durationSeconds: number, draft: RealDraft) {
  if (!timing || !catalog) return 0;
  const limit = catalog.pointLimit[durationSeconds] || 5;
  const points = draft.pointIds.map((id) => catalog.points.find((row) => row.id === id)).filter(Boolean) as RealCatalog["points"];
  const picked = points.length + draft.customPoints.length;
  // Same as the plan: a cleaning shot leads when none was picked and there is room; extra cleaning shots make up short lists.
  const shots = Math.max(catalog.minShots[durationSeconds] || 3, picked + (!points.some((point) => point.cleaning) && picked < limit ? 1 : 0));
  // The 定妆照, the AI director, the scene picture, then the shots a few at a time.
  return 10 + 2 * timing.image + timing.story + Math.ceil(shots / timing.shotSlots) * videoSeconds(timing, durationSeconds / shots) + timing.finish;
}
export function storyEstimate(timing: Timing | undefined, durationSeconds: number) {
  if (!timing) return 0;
  const segments = durationSeconds / 15;
  return 10 + timing.image + timing.story + timing.image * (2 + Math.ceil(6 * segments / timing.imageSlots)) + Math.ceil(segments / timing.shotSlots) * timing.video15 + timing.finish + 15;
}
export const minutes = (seconds: number) => seconds < 90 ? "1 分钟左右" : `${Math.round(seconds / 60)} 分钟左右`;

// Counts down every second between refreshes; past the estimate it says so instead of going negative.
export function Countdown({ finishAt }: { finishAt?: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const end = finishAt ? Date.parse(finishAt) : NaN;
  if (!Number.isFinite(end)) return null;
  const left = Math.round((end - now) / 1000);
  if (left <= 0) return <p className="rs-eta is-late" role="status"><Clock size={20} />比预计慢一些，仍在生成，做好会自动显示</p>;
  const text = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return <p className="rs-eta" role="status"><Clock size={20} />预计还要 <b>{text}</b></p>;
}

type FieldsProps = {
  catalog: RealCatalog; draft: RealDraft; durationSeconds: number; disabled: boolean;
  onChange: (draft: RealDraft) => void;
};
// Where it works and what it can do — the customer knows; the AI director works out the rest from the photos.
export function RealShootFields({ catalog, draft, durationSeconds, disabled, onChange }: FieldsProps) {
  const [text, setText] = useState("");
  const limit = catalog.pointLimit[durationSeconds] || 5;
  const used = draft.pointIds.length + draft.customPoints.length;
  const togglePoint = (id: string) => onChange({ ...draft, pointIds: draft.pointIds.includes(id) ? draft.pointIds.filter((x) => x !== id) : used >= limit ? draft.pointIds : [...draft.pointIds, id] });
  const addCustom = () => {
    const value = text.trim().slice(0, catalog.customLength);
    if (!value || used >= limit || draft.customPoints.length >= catalog.customLimit || draft.customPoints.includes(value)) return;
    onChange({ ...draft, customPoints: [...draft.customPoints, value] }); setText("");
  };
  return <>
    <h2 className="pv2-label">在哪里用？<small>选一个，AI 会按这个场所布置地面和脏污</small></h2>
    <div className="pv2-scenes">{catalog.scenes.map((scene) => { const on = draft.sceneId === scene.id; return <button key={scene.id} type="button" disabled={disabled} aria-pressed={on} className={on ? "is-on" : ""} onClick={() => onChange({ ...draft, sceneId: scene.id })}>
      <span className="pv2-scene-icon"><SceneIcon id={scene.id} /></span>{scene.name}{on && <Check className="pv2-check" size={16} strokeWidth={3} />}</button>; })}</div>
    <h2 className="pv2-label">想展示哪些卖点？<small>已选 {used} / {limit}，只选这台设备真有的</small></h2>
    <div className="rs-points">{catalog.points.map((point) => { const on = draft.pointIds.includes(point.id);
      return <button key={point.id} type="button" aria-pressed={on} className={on ? "is-on" : ""} disabled={disabled || (!on && used >= limit)} onClick={() => togglePoint(point.id)}>
        <b>{point.name}</b><small>字幕：{point.caption}</small>{on && <Check className="pv2-check" size={16} strokeWidth={3} />}</button>; })}</div>
    <div className="rs-custom">
      <label htmlFor="rs-custom-input">列表里没有？自己写一条卖点</label>
      <div><input id="rs-custom-input" maxLength={catalog.customLength} value={text} disabled={disabled || used >= limit || draft.customPoints.length >= catalog.customLimit} placeholder="例如：洗拖一体、30 天免维护"
        onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addCustom(); } }} />
        <button type="button" disabled={disabled || !text.trim() || used >= limit || draft.customPoints.length >= catalog.customLimit} onClick={addCustom}><Plus size={18} />加上</button></div>
      {draft.customPoints.length > 0 && <div className="rs-chips">{draft.customPoints.map((point) => <button key={point} type="button" className="is-on" disabled={disabled} aria-label={`去掉卖点 ${point}`}
        onClick={() => onChange({ ...draft, customPoints: draft.customPoints.filter((x) => x !== point) })}>{point}<X size={14} /></button>)}</div>}
    </div>
    {used === 0 && <p className="pv2-note">不选也可以：会拍它在现场把地面清洁干净的过程。</p>}
  </>;
}

// Up to three photos of the same machine from different sides: fewer surprises when it turns.
export function ProductPhotos({ images, disabled, onAdd, onRemove }: { images: ProductImage[]; disabled: boolean; onAdd: () => void; onRemove: (id: string) => void }) {
  return <div className="rs-photos">{images.slice(1).map((image) => <figure key={image.id}><img src={image.previewDataUrl} alt="另一个角度的产品图" />
    <button type="button" aria-label="去掉这张" disabled={disabled} onClick={() => onRemove(image.id)}><X size={14} /></button></figure>)}
    {images.length > 0 && images.length < 3 && <button type="button" className="rs-photo-add" disabled={disabled} onClick={onAdd}><ImagePlus size={22} />加侧面/背面图</button>}
  </div>;
}

type ProgressTask = {
  id: string; status: string; durationSeconds: number; shotsReady?: boolean[]; shotsRunning?: boolean[]; imagesReady?: Record<string, boolean>;
  sheetConfirmed?: boolean; sheetStep?: boolean; directorStep?: boolean; directed?: boolean;
  plan: { machine?: string; surface?: string; dirt?: string; shots: { index: number; title: string; caption?: string; seconds: number; place?: string }[] };
};
// What the AI director understood from the photos, shown as soon as it has decided (让智能看得见).
function DirectorCard({ task }: { task: ProgressTask }) {
  if (!task.directorStep) return null;
  if (!task.directed) return task.status === "directing" ? <div className="rs-director is-working"><Sparkles size={22} /><div><b>AI 导演正在看产品图</b><span>判断这是什么设备、怎么动、在这个场所该拍什么，一般不到半分钟。</span></div></div> : null;
  return <div className="rs-director"><Sparkles size={22} /><div><b>AI 导演看懂的</b>
    {task.plan.machine && <span>设备：{task.plan.machine}</span>}
    {task.plan.surface && <span>地面：{task.plan.surface}</span>}
    {task.plan.dirt && <span>要清的脏污：{task.plan.dirt}</span>}
    <span>分镜：{task.plan.shots.map((shot) => `${shot.index + 1}. ${shot.title}（${shot.seconds} 秒）`).join("　")}</span></div></div>;
}
export type ShotReview = { checkedAt: string; skipped?: boolean; shots: { index: number; ok: boolean; issue: string; redone?: boolean }[] };
// AI 检查 (user 2026-11-19: check only): which shot looks wrong and why; the customer decides whether to redo one.
export function ShotReviewPanel({ review, titles, canRedo, busy, onRedo }: { review?: ShotReview | null; titles: string[]; canRedo: boolean; busy: boolean; onRedo: (index: number) => void }) {
  if (!review) return null;
  if (review.skipped) return <div className="rs-review"><ScanEye size={20} /><p>这次没能自动检查，建议自己看一遍成片。</p></div>;
  const flagged = review.shots.filter((shot) => !shot.ok);
  return <div className="rs-review"><ScanEye size={20} /><div>
    <b>{flagged.length ? `AI 检查：有 ${flagged.length} 个镜头可能要重拍` : "AI 检查：每个镜头都没发现明显问题"}</b>
    {flagged.map((shot) => <div key={shot.index} className="rs-review-row"><AlertTriangle size={16} /><span>第 {shot.index + 1} 镜「{titles[shot.index] || ""}」：{shot.issue}</span>
      {shot.redone ? <em>已重拍</em> : canRedo && <button type="button" className="pv2-btn" data-product-video-action="redo-shot" disabled={busy} onClick={() => onRedo(shot.index)}><RefreshCw size={16} />重拍这一镜</button>}</div>)}
    {flagged.length > 0 && <small>每条视频可以重拍一个镜头，只扣这一个镜头的算力；不重拍也能直接用。</small>}
  </div></div>;
}
// Only the steps this video really has: no 定妆照 on videos started before it, no scene picture without a venue shot.
export function RealShootProgress({ task, shotVideos }: { task: ProgressTask; shotVideos: Record<string, string> }) {
  const finishing = ["assembling", "packaging"].includes(task.status);
  const sheetDone = !task.sheetStep || task.sheetConfirmed;
  const STAGES = [
    ...(task.sheetStep ? [{ label: "定妆照", Icon: ImagePlus, done: Boolean(sheetDone) }] : []),
    ...(task.directorStep ? [{ label: "AI 导演", Icon: Sparkles, done: Boolean(task.directed) }] : []),
    ...(task.plan.shots.some((shot) => shot.place === "venue") ? [{ label: "画场地", Icon: MapPin, done: Boolean(sheetDone && task.imagesReady?.plate) }] : []),
    { label: "拍镜头", Icon: Clapperboard, done: finishing || task.status === "completed" },
    { label: "加字幕", Icon: Subtitles, done: task.status === "completed" }
  ];
  const stage = STAGES.findIndex((row) => !row.done) < 0 ? STAGES.length : STAGES.findIndex((row) => !row.done);
  const stuck = ["needs_attention", "outcome_unknown"].includes(task.status);
  return <div className="sv-progress">
    <DirectorCard task={task} />
    <ol className="sv-stages">{STAGES.map(({ label, Icon }, index) => <li key={label} className={index < stage ? "is-done" : index === stage ? "is-now" : ""}>
      <span>{index < stage ? <Check size={18} strokeWidth={3} /> : <Icon size={18} />}</span>{label}</li>)}</ol>
    <div className="pv2-shots">{task.plan.shots.map((shot, index) => {
      const src = shotVideos[`${task.id}:${index}`], done = task.shotsReady?.[index], now = task.shotsRunning?.[index];
      const label = `${index + 1}. ${shot.title}`;
      return done && src && src !== "error" ? <figure key={shot.index}><video src={src} muted controls preload="metadata" /><figcaption>{label} ✓</figcaption></figure>
        : <div key={shot.index} className={`pv2-shot-wait is-${done ? "done" : now ? "now" : stuck ? "stuck" : "wait"}`}>
          {done ? (src === "error" ? <Check size={28} /> : <LoaderCircle size={28} className="spin" />) : now ? <Clapperboard size={30} /> : stuck ? <AlertTriangle size={30} /> : <Hourglass size={28} />}
          <span>{label}</span><small>{done ? (src === "error" ? "画面打不开，成片里会有" : "加载画面") : now ? "拍摄中" : stuck ? "停住了" : "排队"}</small></div>;
    })}</div>
  </div>;
}
