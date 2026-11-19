// 场景效果视频 · 无人实拍 (2026-11-19): the customer only ticks — device, scene, floor, dirt, selling
// points — and sees how long it will take; while it is made, a countdown and each shot as it is filmed.
import { useEffect, useState } from "react";
import { AlertTriangle, Check, Clapperboard, Clock, Hourglass, ImagePlus, LoaderCircle, MapPin, Subtitles, X } from "lucide-react";
import { SceneIcon } from "./SceneIcons";

type Item = { id: string; name: string };
export type RealCatalog = {
  groups: Item[];
  devices: (Item & { group: string; operator: string; scenes: string[]; floors: string[]; dirt: string[]; points: string[]; defaults: Record<string, { floorId: string; dirtIds: string[] }> })[];
  scenes: Item[]; floors: Item[]; dirt: Item[]; points: (Item & { caption: string; place?: string; cleaning?: boolean })[];
  durations: number[]; pointLimit: Record<string, number>; minShots: Record<string, number>;
};
export type Timing = { image: number; story: number; finish: number; video15: number; video6: number; shotSlots: number; imageSlots: number };
export type RealDraft = { deviceId: string; sceneId: string; floorId: string; dirtIds: string[]; pointIds: string[] };
export const initialReal: RealDraft = { deviceId: "", sceneId: "", floorId: "", dirtIds: [], pointIds: [] };
export type ProductImage = { id: string; name: string; previewDataUrl: string };

// A video shot takes roughly this long, between the measured 6- and 15-second times.
const videoSeconds = (timing: Timing, seconds: number) => Math.max(60, timing.video6 + (timing.video15 - timing.video6) * (seconds - 6) / 9);
export function realEstimate(timing: Timing | undefined, catalog: RealCatalog | undefined, durationSeconds: number, pointIds: string[]) {
  if (!timing || !catalog) return 0;
  const limit = catalog.pointLimit[durationSeconds] || 5;
  const points = pointIds.map((id) => catalog.points.find((row) => row.id === id)).filter(Boolean) as RealCatalog["points"];
  // Same as the plan: a cleaning shot leads when none was picked and there is room; fillers make up short lists.
  const core = !points.some((point) => point.cleaning) && points.length < limit;
  const shots = Math.max(catalog.minShots[durationSeconds] || 3, points.length + (core ? 1 : 0));
  const venue = core || shots > points.length || points.some((point) => point.place === "venue");
  // The 定妆照, the scene picture when a shot is in the venue, then the shots a few at a time.
  return 10 + (venue ? 2 : 1) * timing.image + Math.ceil(shots / timing.shotSlots) * videoSeconds(timing, durationSeconds / shots) + timing.finish;
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
export function RealShootFields({ catalog, draft, durationSeconds, disabled, onChange }: FieldsProps) {
  const device = catalog.devices.find((row) => row.id === draft.deviceId);
  const limit = catalog.pointLimit[durationSeconds] || 5;
  const name = (rows: Item[], id: string) => rows.find((row) => row.id === id)?.name || id;
  const chooseDevice = (id: string) => {
    const next = catalog.devices.find((row) => row.id === id)!;
    const sceneId = next.scenes.includes(draft.sceneId) ? draft.sceneId : "";
    const defaults = sceneId ? next.defaults[sceneId] : null;
    onChange({ deviceId: id, sceneId, floorId: defaults?.floorId || "", dirtIds: defaults?.dirtIds || [], pointIds: draft.pointIds.filter((point) => next.points.includes(point)) });
  };
  const chooseScene = (id: string) => {
    if (!device) return;
    const defaults = device.defaults[id];
    onChange({ ...draft, sceneId: id, floorId: defaults.floorId, dirtIds: defaults.dirtIds });
  };
  const toggleDirt = (id: string) => onChange({ ...draft, dirtIds: draft.dirtIds.includes(id) ? draft.dirtIds.filter((x) => x !== id) : [...draft.dirtIds, id].slice(-2) });
  const togglePoint = (id: string) => onChange({ ...draft, pointIds: draft.pointIds.includes(id) ? draft.pointIds.filter((x) => x !== id) : draft.pointIds.length >= limit ? draft.pointIds : [...draft.pointIds, id] });
  return <>
    <h2 className="pv2-label">是什么设备？</h2>
    <div className="rs-groups">{catalog.groups.map((group) => <div key={group.id}><span>{group.name}</span>
      <div className="rs-chips">{catalog.devices.filter((row) => row.group === group.id).map((row) => <button key={row.id} type="button" disabled={disabled} aria-pressed={row.id === draft.deviceId}
        className={row.id === draft.deviceId ? "is-on" : ""} onClick={() => chooseDevice(row.id)}>{row.name}</button>)}</div></div>)}</div>
    {device && <>
      <h2 className="pv2-label">在哪里干活？<small>{device.operator === "none" ? "画面里不出现人" : "只拍操作员的手和身子，不露脸"}</small></h2>
      <div className="pv2-scenes">{device.scenes.map((id) => { const on = draft.sceneId === id; return <button key={id} type="button" disabled={disabled} aria-pressed={on} className={on ? "is-on" : ""} onClick={() => chooseScene(id)}>
        <span className="pv2-scene-icon"><SceneIcon id={id} /></span>{name(catalog.scenes, id)}{on && <Check className="pv2-check" size={16} strokeWidth={3} />}</button>; })}</div>
    </>}
    {device && draft.sceneId && <>
      <h2 className="pv2-label">地面是什么？</h2>
      <div className="rs-chips">{device.floors.map((id) => <button key={id} type="button" disabled={disabled} aria-pressed={draft.floorId === id} className={draft.floorId === id ? "is-on" : ""}
        onClick={() => onChange({ ...draft, floorId: id })}>{name(catalog.floors, id)}</button>)}</div>
      <h2 className="pv2-label">地上有什么脏东西？<small>选一到两种</small></h2>
      <div className="rs-chips">{device.dirt.map((id) => <button key={id} type="button" disabled={disabled} aria-pressed={draft.dirtIds.includes(id)} className={draft.dirtIds.includes(id) ? "is-on" : ""}
        onClick={() => toggleDirt(id)}>{name(catalog.dirt, id)}</button>)}</div>
      <h2 className="pv2-label">想展示哪些卖点？<small>已选 {draft.pointIds.length} / {limit}，只勾这台设备真有的</small></h2>
      <div className="rs-points">{device.points.map((id) => { const point = catalog.points.find((row) => row.id === id)!; const on = draft.pointIds.includes(id);
        return <button key={id} type="button" aria-pressed={on} className={on ? "is-on" : ""} disabled={disabled || (!on && draft.pointIds.length >= limit)} onClick={() => togglePoint(id)}>
          <b>{point.name}</b><small>字幕：{point.caption}</small>{on && <Check className="pv2-check" size={16} strokeWidth={3} />}</button>; })}</div>
      {draft.pointIds.length === 0 && <p className="pv2-note">不勾也可以：会拍它把地面清洁干净的过程。</p>}
    </>}
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
  sheetConfirmed?: boolean; sheetStep?: boolean;
  plan: { shots: { index: number; title: string; caption?: string; seconds: number; place?: string }[] };
};
// Only the steps this video really has: no 定妆照 on videos started before it, no scene picture without a venue shot.
export function RealShootProgress({ task, shotVideos }: { task: ProgressTask; shotVideos: Record<string, string> }) {
  const finishing = ["assembling", "packaging"].includes(task.status);
  const sheetDone = !task.sheetStep || task.sheetConfirmed;
  const STAGES = [
    ...(task.sheetStep ? [{ label: "定妆照", Icon: ImagePlus, done: Boolean(sheetDone) }] : []),
    ...(task.plan.shots.some((shot) => shot.place === "venue") ? [{ label: "画场地", Icon: MapPin, done: Boolean(sheetDone && task.imagesReady?.plate) }] : []),
    { label: "拍镜头", Icon: Clapperboard, done: finishing || task.status === "completed" },
    { label: "加字幕", Icon: Subtitles, done: task.status === "completed" }
  ];
  const stage = STAGES.findIndex((row) => !row.done) < 0 ? STAGES.length : STAGES.findIndex((row) => !row.done);
  const stuck = ["needs_attention", "outcome_unknown"].includes(task.status);
  return <div className="sv-progress">
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
