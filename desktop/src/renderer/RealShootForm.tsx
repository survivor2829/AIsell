// 场景效果视频 · 无人实拍 + AI 导演 (2026-11-19, "less structure, more intelligence"): the customer gives
// the photos and the product name, picks the kind of place and the selling points (or writes their own);
// the AI director looks at the photos and decides the rest. While it is made: a countdown, what the
// director understood, each shot as it is filmed, and afterwards the AI check of every shot.
import { useEffect, useState } from "react";
import { AlertTriangle, Check, Clapperboard, Clock, Hourglass, ImagePlus, LoaderCircle, MapPin, Plus, RefreshCw, ScanEye, X } from "lucide-react";
import { SceneIcon } from "./SceneIcons";
import { AgentStage } from "./AgentStage";
import { sceneStageModel, type SceneStageTask } from "./scene-stage";

type Item = { id: string; name: string };
export type RealCatalog = {
  scenes: Item[]; points: (Item & { caption: string; cleaning?: boolean })[];
  durations: number[]; pointLimit: Record<string, number>; minShots: Record<string, number>; customLimit: number; customLength: number; sceneLength?: number;
};
export type Timing = { image: number; story: number; finish: number; video15: number; video6: number; shotSlots: number; imageSlots: number };
export type ProductImage = { id: string; name: string; previewDataUrl: string };
// The place: one from the list, or the customer's own words; and, if they have one, a photo of the real site.
export type RealDraft = { sceneId: string; sceneText: string; venue: ProductImage | null; pointIds: string[]; customPoints: string[] };
export const initialReal: RealDraft = { sceneId: "", sceneText: "", venue: null, pointIds: [], customPoints: [] };
export const realSceneReady = (draft: RealDraft) => Boolean(draft.sceneId || draft.sceneText.trim());

// A video shot takes roughly this long, between the measured 6- and 15-second times.
const videoSeconds = (timing: Timing, seconds: number) => Math.max(60, timing.video6 + (timing.video15 - timing.video6) * (seconds - 6) / 9);
export function realEstimate(timing: Timing | undefined, catalog: RealCatalog | undefined, durationSeconds: number, draft: RealDraft) {
  if (!timing || !catalog) return 0;
  const limit = catalog.pointLimit[durationSeconds] || 5;
  const points = draft.pointIds.map((id) => catalog.points.find((row) => row.id === id)).filter(Boolean) as RealCatalog["points"];
  const picked = points.length + draft.customPoints.length;
  // Same as the plan: a cleaning shot leads when none was picked and there is room; extra cleaning shots make up short lists.
  const shots = Math.max(catalog.minShots[durationSeconds] || 3, picked + (!points.some((point) => point.cleaning) && picked < limit ? 1 : 0));
  // The 定妆照, the AI director, the scene picture (none with a site photo), the keyframes a few at a time, then the shots.
  return 10 + (draft.venue ? 1 : 2) * timing.image + timing.story + Math.ceil(shots / timing.imageSlots) * timing.image + Math.ceil(shots / timing.shotSlots) * videoSeconds(timing, durationSeconds / shots) + timing.finish;
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
  onChange: (draft: RealDraft) => void; onPickVenue: () => void;
};
// Where it works and what it can do — the customer knows; the AI director works out the rest from the photos.
export function RealShootFields({ catalog, draft, durationSeconds, disabled, onChange, onPickVenue }: FieldsProps) {
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
    <h2 className="pv2-label">在哪里用？<small>选一个或自己写，AI 会按这个场所布置地面和脏污</small></h2>
    <div className="pv2-scenes">{catalog.scenes.map((scene) => { const on = draft.sceneId === scene.id; return <button key={scene.id} type="button" disabled={disabled} aria-pressed={on} className={on ? "is-on" : ""} onClick={() => onChange({ ...draft, sceneId: scene.id, sceneText: "" })}>
      <span className="pv2-scene-icon"><SceneIcon id={scene.id} /></span>{scene.name}{on && <Check className="pv2-check" size={16} strokeWidth={3} />}</button>; })}</div>
    <div className="rs-custom">
      <label htmlFor="rs-scene-input">列表里没有？自己写场所</label>
      <div><input id="rs-scene-input" maxLength={catalog.sceneLength || 30} value={draft.sceneText} disabled={disabled} placeholder="例如：新建的物流仓库、汽车 4S 店展厅"
        onChange={(event) => onChange({ ...draft, sceneText: event.target.value, sceneId: event.target.value.trim() ? "" : draft.sceneId })} /></div>
    </div>
    <div className="rs-venue">
      {draft.venue
        ? <figure><img src={draft.venue.previewDataUrl} alt="现场照片" /><button type="button" aria-label="去掉现场照片" disabled={disabled} onClick={() => onChange({ ...draft, venue: null })}><X size={14} /></button></figure>
        : <button type="button" className="rs-photo-add" disabled={disabled} onClick={onPickVenue}><MapPin size={22} />传现场照片</button>}
      <small>{draft.venue ? "镜头都在这个现场拍，不再另画场景图。" : "可选：拍一张您的真实场地（越宽越好），视频就在这里拍。"}</small>
    </div>
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

// Up to five photos of the same machine from different sides (same limit as the main process): a side
// nobody photographed is kept out of every shot, so each extra side means more freedom and fewer surprises.
export const MAX_PHOTOS = 5;
export function ProductPhotos({ images, disabled, onAdd, onRemove }: { images: ProductImage[]; disabled: boolean; onAdd: () => void; onRemove: (id: string) => void }) {
  return <div className="rs-photos">{images.slice(1).map((image) => <figure key={image.id}><img src={image.previewDataUrl} alt="另一个角度的产品图" />
    <button type="button" aria-label="去掉这张" disabled={disabled} onClick={() => onRemove(image.id)}><X size={14} /></button></figure>)}
    {images.length > 0 && images.length < MAX_PHOTOS && <button type="button" className="rs-photo-add" disabled={disabled} onClick={onAdd}><ImagePlus size={22} />加侧面/背面图</button>}
  </div>;
}

// 导演组 (2026-11-23): what the product analyst, the site survey and the risk review found before any video is paid for.
export type Crew = {
  sides: string[]; hiddenSides: string; parts: { name: string; count: string; where: string }[]; size: string; sizeNote: string; sheetIssues: string[];
  survey: { widthM: number | null; zone: string; canTurn: boolean; fits: boolean; dirtVisible?: boolean; note: string } | null;
  risks: { index: number; risk: string; fix: string }[]; rewritten: boolean; fallback?: number[]; venuePhoto?: boolean; safeMove?: "side" | "front" | "back";
};
// The safe move a still-risky shot was filmed with, from the sides really photographed.
const SAFE_MOVE = { side: "侧面平移跟拍", front: "高处固定机位、机器迎面直行", back: "后方跟随直行" } as const;
export function CrewCard({ crew, atSheet = false }: { crew?: Crew | null; atSheet?: boolean }) {
  if (!crew) return null;
  return <div className="rs-director"><ScanEye size={22} /><div><b>导演组看到的</b>
    <span>真实照片拍到：{crew.sides.join("、")}{crew.hiddenSides ? `；${crew.hiddenSides}没有照片，镜头不会拍到` : ""}</span>
    {crew.parts.length > 0 && <span>部件：{crew.parts.map((part) => `${part.name}${part.count ? ` ${part.count}` : ""}`).join("；")}</span>}
    {crew.sizeNote && <span>体量：{crew.sizeNote}</span>}
    {atSheet && crew.sheetIssues.length > 0 && <span className="rs-crew-warn"><AlertTriangle size={15} />定妆照可能不对：{crew.sheetIssues.join("；")}。不对的话点“重出”。</span>}
    {crew.survey && <span>{crew.venuePhoto ? "您的现场" : "场地"}：可作业宽度约 {crew.survey.widthM ?? "?"} 米，{crew.survey.canTurn ? "能转弯" : "只直行，不安排转弯"}{crew.survey.note ? `；${crew.survey.note}` : ""}</span>}
    {crew.rewritten && <span>风险审查让导演改过分镜{crew.risks.length || crew.fallback?.length ? "" : "，现在没有发现穿帮风险"}</span>}
    {(crew.fallback || []).map((index) => <span key={`safe-${index}`}>第 {index + 1} 镜改了两次仍有风险，已换成最稳的拍法（{SAFE_MOVE[crew.safeMove || "side"]}，看得见清洁后的地面），字幕不变</span>)}
    {crew.risks.map((row) => <span key={row.index} className="rs-crew-warn"><AlertTriangle size={15} />第 {row.index + 1} 镜仍有风险：{row.risk}</span>)}
  </div></div>;
}

type ProgressTask = SceneStageTask & {
  id: string; status: string; durationSeconds: number; shotsReady?: boolean[]; shotsRunning?: boolean[]; imagesReady?: Record<string, boolean>;
  sheetConfirmed?: boolean; sheetStep?: boolean; directorStep?: boolean; directed?: boolean; crew?: Crew | null;
  plan: { machine?: string; surface?: string; dirt?: string; shots: { index: number; title: string; caption?: string; seconds: number; place?: string }[] };
};
export type ShotReview = { checkedAt: string; skipped?: boolean; shots: { index: number; ok: boolean; issue: string; redone?: boolean }[] };
// AI 检查 (user 2026-11-19: check only): which shot looks wrong and why; the customer decides whether to redo one.
export function ShotReviewPanel({ review, titles, canRedo, busy, finished = true, onRedo }: { review?: ShotReview | null; titles: string[]; canRedo: boolean; busy: boolean; finished?: boolean; onRedo: (index: number) => void }) {
  if (!review) return null;
  if (review.skipped) return <div className="rs-review"><ScanEye size={20} /><p>这次没能自动检查，建议自己看一遍成片。</p></div>;
  const flagged = review.shots.filter((shot) => !shot.ok);
  // After a redo the heading says so (2026-11-21 实拍：重拍后仍写“可能要重拍”，像没修好). A shot is marked
  // redone as soon as its redo is queued, so "已经重拍好了" waits until the video is finished again.
  const open = flagged.filter((shot) => !shot.redone);
  const redoing = !finished && flagged.some((shot) => shot.redone);
  const before = (issue: string) => issue.replace(/^第\d+镜(?:第\d+格)?[：:，,\s]*/u, "").replace(/^这一镜/u, "");
  return <div className="rs-review"><ScanEye size={20} /><div>
    <b>{redoing ? "正在重拍 AI 检查发现的镜头" : open.length ? `AI 检查：有 ${open.length} 个镜头可能要重拍` : flagged.length ? "AI 检查发现的镜头已经重拍好了" : "AI 检查：每个镜头都没发现明显问题"}</b>
    {flagged.map((shot) => <div key={shot.index} className="rs-review-row"><AlertTriangle size={16} /><span>第 {shot.index + 1} 镜「{titles[shot.index] || ""}」：{shot.redone ? `原来${before(shot.issue)}` : shot.issue}</span>
      {shot.redone ? <em>{redoing ? "重拍中" : "已重拍"}</em> : canRedo && <button type="button" className="pv2-btn" data-product-video-action="redo-shot" disabled={busy} onClick={() => onRedo(shot.index)}><RefreshCw size={16} />重拍这一镜</button>}</div>)}
    {canRedo && open.length > 0 && <small>每条视频可以重拍一个镜头，只扣这一个镜头的算力；不重拍也能直接用。</small>}
  </div></div>;
}
// real-3 分镜确认 (客户：选的卖点一个也没拍出来、想自己改动作和角度): one keyframe per shot, drawn before any video.
// The customer may change a shot's camera, action or caption; a new camera or action redraws that keyframe.
export type StoryboardShot = { index: number; title: string; caption?: string; seconds: number; camera?: string; action?: string; proof?: string; unshowable?: string };
export type Storyboard = { confirmed: boolean; redrawsLeft: number[]; cameras: Item[]; autoRedone: { index: number; issue: string } | null };
type MediaResult = { ok: boolean; data?: { dataUrl: string } };
type ShotChange = { action?: string; camera?: string; caption?: string };
function KeyframeCard({ taskId, shot, ready, drawing, version, cameras, redrawsLeft, busy, imageMedia, onSave }: {
  taskId: string; shot: StoryboardShot; ready: boolean; drawing: boolean; version: number; cameras: Item[]; redrawsLeft: number; busy: boolean;
  imageMedia: (id: string, key: string) => Promise<MediaResult>; onSave: (change: ShotChange) => void;
}) {
  const [picture, setPicture] = useState("");
  const [camera, setCamera] = useState(shot.camera || ""), [action, setAction] = useState(shot.action || ""), [caption, setCaption] = useState(shot.caption || "");
  useEffect(() => { setCamera(shot.camera || ""); setAction(shot.action || ""); setCaption(shot.caption || ""); }, [shot.camera, shot.action, shot.caption]);
  useEffect(() => {
    let disposed = false; setPicture("");
    if (ready) void imageMedia(taskId, `key_${shot.index}`).then((result) => { if (!disposed && result.ok && result.data) setPicture(result.data.dataUrl); }).catch(() => {});
    return () => { disposed = true; };
  }, [taskId, shot.index, ready, version]);
  const redraw = camera !== (shot.camera || "") || action.trim() !== (shot.action || "");
  const changed = redraw || caption.trim() !== (shot.caption || "");
  const change: ShotChange = {};
  if (camera !== shot.camera) change.camera = camera;
  if (action.trim() !== shot.action) change.action = action.trim();
  if (caption.trim() !== shot.caption) change.caption = caption.trim();
  return <article className="rs-board-card">
    <div className="rs-board-pic">{picture ? <img src={picture} alt={`第 ${shot.index + 1} 镜分镜图`} /> : <span>{drawing || !ready ? <LoaderCircle size={30} className="spin" /> : <ImagePlus size={30} />}<small>{drawing || !ready ? "正在画" : ""}</small></span>}
      <em>{shot.index + 1}</em></div>
    <div className="rs-board-body">
      <b>{shot.title}<small>{shot.seconds} 秒</small></b>
      {shot.proof && <p>画面证明：{shot.proof}</p>}
      {shot.unshowable && <p className="rs-crew-warn"><AlertTriangle size={15} />{shot.unshowable}，可以改一下动作再画</p>}
      <div className="rs-board-cams" role="radiogroup" aria-label="机位">{cameras.map((row) => <button key={row.id} type="button" role="radio" aria-checked={camera === row.id}
        className={camera === row.id ? "is-on" : ""} disabled={busy || drawing} onClick={() => setCamera(row.id)}>{row.name}</button>)}</div>
      <label><span>动作</span><input maxLength={40} value={action} disabled={busy || drawing} onChange={(event) => setAction(event.target.value)} /></label>
      <label><span>字幕</span><input maxLength={10} value={caption} disabled={busy || drawing} onChange={(event) => setCaption(event.target.value)} /></label>
      {changed && <button type="button" className="pv2-btn" data-product-video-action="update-shot" disabled={busy || drawing || (redraw && redrawsLeft <= 0) || !action.trim() || !caption.trim()}
        onClick={() => onSave(change)}><RefreshCw size={16} />{redraw ? (redrawsLeft > 0 ? `按这个重画（还能 ${redrawsLeft} 次）` : "这一镜不能再重画了") : "保存字幕"}</button>}
    </div>
  </article>;
}
export function StoryboardConfirm({ task, busy, imageMedia, onSave, onConfirm }: {
  task: { id: string; status: string; imagesReady?: Record<string, boolean>; storyboard?: Storyboard; plan: { shots: StoryboardShot[] } };
  busy: boolean; imageMedia: (id: string, key: string) => Promise<MediaResult>; onSave: (index: number, change: ShotChange) => void; onConfirm: () => void;
}) {
  const board = task.storyboard, drawing = task.status === "drawing_frames";
  if (!board) return null;
  const allReady = task.plan.shots.every((shot) => task.imagesReady?.[`key_${shot.index}`]);
  return <div className="rs-board">
    <div className="rs-board-head"><h3>{drawing ? "正在画分镜" : "看看每个镜头"}</h3>
      {!drawing && <button type="button" className="pv2-btn is-main" data-product-video-action="confirm-storyboard" disabled={busy || !allReady} onClick={onConfirm}><Check size={20} />分镜没问题，开始拍视频</button>}</div>
    <div className="rs-board-grid">{task.plan.shots.map((shot) => <KeyframeCard key={shot.index} taskId={task.id} shot={shot} ready={Boolean(task.imagesReady?.[`key_${shot.index}`])} drawing={drawing && !task.imagesReady?.[`key_${shot.index}`]}
      version={board.redrawsLeft[shot.index] ?? 0} cameras={board.cameras} redrawsLeft={board.redrawsLeft[shot.index] ?? 0} busy={busy} imageMedia={imageMedia} onSave={(change) => onSave(shot.index, change)} />)}</div>
  </div>;
}
// Only the steps this video really has: no 定妆照 on videos started before it, no scene picture without a venue shot.
export function RealShootProgress({ task, shotVideos }: { task: ProgressTask; shotVideos: Record<string, string> }) {
  const stuck = ["needs_attention", "outcome_unknown"].includes(task.status);
  return <div className="sv-progress">
    {/* AI 工作台（用户 2026-11-24）：每个 AI 角色在它真实处理的那一步上干活，取代原来的步骤条和导演卡。 */}
    <AgentStage model={sceneStageModel(task)} label="AI 导演组工作台" />
    <CrewCard crew={task.crew} />
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
