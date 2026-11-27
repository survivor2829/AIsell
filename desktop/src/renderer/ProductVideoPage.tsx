import { useEffect, useState } from "react";
import { AlertTriangle, Check, Clapperboard, Download, Hourglass, ImagePlus, LoaderCircle, Play, Plus, RefreshCw } from "lucide-react";
import "./ProductVideoPage.css";
import { ExampleBanner } from './VideoExamples';
import { AgentStage } from "./AgentStage";
import { sceneStageModel } from "./scene-stage";
import { SceneIcon } from "./SceneIcons";
import { formatWan } from "./BillingBadge";
// 剧情版 (有人剧情) was removed for new videos (user 2026-11-27: 场景效果视频只做无人实拍); its progress view stays for older ones.
import { SheetConfirm, StoryVideoProgress, storyProgress, type StoryTask } from "./StoryVideoProgress";
import { Countdown, CrewCard, MAX_PHOTOS, ProductPhotos, RealShootFields, RealShootProgress, ShotReviewPanel, StoryboardConfirm, initialReal, minutes, realEstimate, type Crew, type ProductImage, type RealCatalog, type RealDraft, realSceneReady, type ShotReview, type Storyboard, type StoryboardShot, type Timing } from "./RealShootForm";

type Choice = { id: string; name: string };
type Quote = { ready?: boolean; estimatedCny?: number | null; maximumCny?: number; actualCny?: number; pendingCny?: number; reservedCny?: number; budgetCny?: number; note?: string; message?: string; checkedAt?: string };
type Plan = {
  version: string; pipelineVersion?: number; scene: string; evidenceStatus: string; sourceResolution?: string; machine?: string; surface?: string; dirt?: string;
  shots: (StoryboardShot & { narration: string })[];
  sendText: string;
};
type VideoTask = {
  id: string; mode: "product" | "social"; status: string; statusLabel: string; createdAt: string;
  durationSeconds: number; sceneIds?: string[]; productName?: string; facts: string; imageId: string; plan: Plan; currentShot: number;
  completedShots: number; shotsReady?: boolean[]; shotsRunning?: boolean[]; storyPipeline?: boolean; realPipeline?: boolean; progress?: number; etaSeconds?: number | null; estimatedFinishAt?: string | null; imagesReady?: Record<string, boolean>; imageTotal?: number; sheetRedos?: number; sheetStep?: boolean; sheetConfirmed?: boolean; directorStep?: boolean; directed?: boolean; review?: ShotReview | null; canRedoShot?: boolean; redoNote?: string;
  story?: StoryTask["story"]; crew?: Crew | null; storyboard?: Storyboard; error: string; resumeStatus?: string; failedShotIndex?: number | null; retryLabel?: string; canRetry: boolean; canExport: boolean; canExportSource?: boolean; canPreview: boolean; canRefresh?: boolean; quote?: Quote;
};
type Result<T> = { ok: boolean; data?: T; error?: string; code?: string; task?: VideoTask };
type Capabilities = { ready: boolean; message: string; scenes: Choice[]; story?: { ready: boolean; message: string }; real?: { ready: boolean; message: string }; catalog?: RealCatalog; timing?: Timing };
type VideoApi = {
  capabilities(): Promise<Result<Capabilities>>;
  importImage(): Promise<Result<{ id: string; name: string; previewDataUrl: string } | null>>;
  importFacts(): Promise<Result<{ name: string; text: string } | null>>;
  createAndStart(input: Record<string, string | number | string[]>): Promise<Result<VideoTask>>;
  list(): Promise<Result<{ items: VideoTask[] }>>; get(id: string): Promise<Result<VideoTask>>;
  start(id: string): Promise<Result<VideoTask>>; retryShot(id: string): Promise<Result<VideoTask>>;
  refresh(id: string): Promise<Result<VideoTask>>; media(id: string): Promise<Result<{ dataUrl: string }>>;
  shotMedia(id: string, index: number): Promise<Result<{ dataUrl: string }>>;
  imageMedia(id: string, key: string): Promise<Result<{ dataUrl: string }>>;
  confirmSheet(id: string): Promise<Result<VideoTask>>; redoSheet(id: string): Promise<Result<VideoTask>>; redoShot?(id: string, index: number): Promise<Result<VideoTask>>;
  updateShot(id: string, index: number, change: { action?: string; camera?: string; caption?: string }): Promise<Result<VideoTask>>; confirmStoryboard(id: string): Promise<Result<VideoTask>>;
  export(id: string): Promise<Result<{ path: string; subtitlePath?: string; sendText: string } | null>>;
  exportSource(id: string): Promise<Result<{ path: string } | null>>;
};
declare global { interface Window { xiaoxiProductVideo?: VideoApi } }
const ACTIVE = new Set(["imaging", "directing", "drawing_frames", "writing_story", "composing", "uploading", "preparing_frames", "frame_generating", "locking_frames", "preparing_audio", "audio_preparing", "submitting", "generating", "assembling", "enhancing", "transcribing", "packaging"]);
// After the shots: putting them together. Transcribing also runs before any shot (the narration
// is prepared first), so it only counts as finishing once every shot is done.
const FINISHING = new Set(["assembling", "enhancing", "packaging"]);
const finishing = (task: VideoTask) => FINISHING.has(task.status) || (task.status === "transcribing" && task.completedShots >= task.plan.shots.length);
const STUCK = new Set(["needs_attention", "outcome_unknown"]);
// 剧情版: one 15-second part each, up to four parts (user, 2026-11-19).
const DURATIONS = [15, 30, 45, 60];
const initial = { productName: "", sceneIds: [] as string[], durationSeconds: 30, facts: "", imageId: "" };
async function unwrap<T>(result: Promise<Result<T>>): Promise<T> {
  const value = await result;
  if (!value.ok || value.data === undefined) throw new Error(value.error || "操作未完成，请稍后重试。");
  return value.data;
}
const credits = (cny?: number | null) => Number.isFinite(cny) && Number(cny) > 0 ? formatWan(Number(cny) * 40000) : "";
function progressOf(task: VideoTask) {
  if (Number.isFinite(task.progress) && (task.storyPipeline || task.realPipeline)) return Number(task.progress);
  if (task.storyPipeline) return storyProgress(task);
  if (task.status === "completed") return 100;
  const total = Math.max(1, task.plan.shots.length);
  return finishing(task) ? 92 : Math.round(task.completedShots / total * 88);
}
function Ring({ value, lines }: { value: number; lines: string[] }) {
  const r = 92, c = 2 * Math.PI * r;
  return <div className="pv2-ring" role="img" aria-label={`完成 ${value}%`}>
    <svg viewBox="0 0 220 220"><circle cx="110" cy="110" r={r} className="pv2-ring-track" /><circle cx="110" cy="110" r={r} className="pv2-ring-value" strokeDasharray={`${c * value / 100} ${c}`} /></svg>
    <div><b>{value}%</b>{lines.map(line => <span key={line}>{line}</span>)}</div>
  </div>;
}

export function ProductVideoPage() {
  const api = window.xiaoxiProductVideo;
  const [capability, setCapability] = useState<Capabilities | null>(null);
  const [draft, setDraft] = useState({ ...initial });
  const [realDraft, setRealDraft] = useState<RealDraft>({ ...initialReal });
  const [images, setImages] = useState<ProductImage[]>([]);
  const image = images[0] || null;
  const [selected, setSelected] = useState<VideoTask | null>(null);
  const [items, setItems] = useState<VideoTask[]>([]);
  const [video, setVideo] = useState("");
  const [shotVideos, setShotVideos] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [exportResult, setExportResult] = useState("");
  const updateTask = (task: VideoTask) => { setSelected(task); setItems(current => [task, ...current.filter(item => item.id !== task.id)]); };
  useEffect(() => {
    if (!api) { setError("视频工作台尚未连接，请重新启动应用。"); return; }
    let disposed = false;
    void Promise.all([api.capabilities(), api.list()]).then(([caps, tasks]) => {
      if (disposed) return;
      if (caps.ok && caps.data) setCapability(caps.data);
      else if (caps.error) setError(caps.error);
      if (tasks.ok && tasks.data) setItems(tasks.data.items.filter(task => task.mode === "product"));
    }).catch(cause => { if (!disposed) setError(String(cause)); });
    return () => { disposed = true; };
  }, [api]);
  useEffect(() => {
    if (!api || !selected || !ACTIVE.has(selected.status)) return;
    let disposed = false, pending = false;
    const timer = window.setInterval(() => {
      if (pending) return; pending = true;
      void api.refresh(selected.id).then(result => { if (!disposed && result.ok && result.data) updateTask(result.data); }).catch(() => {}).finally(() => { pending = false; });
    }, 8000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [api, selected?.id, selected?.status]);
  // Finished shots show their own picture while the task is still being made (a finished task shows the
  // whole video instead). Only this task is kept; a redone shot loads again; one that cannot be read says so.
  const readyKey = (selected?.shotsReady || []).map(Number).join("");
  useEffect(() => {
    if (!api || !selected || selected.status === "completed") { setShotVideos({}); return; }
    const ready = selected.shotsReady || [];
    setShotVideos(old => Object.fromEntries(Object.entries(old).filter(([key]) => key.startsWith(`${selected.id}:`) && ready[Number(key.split(":")[1])])));
    let disposed = false;
    ready.forEach((isReady, index) => {
      const key = `${selected.id}:${index}`;
      if (!isReady || shotVideos[key]) return;
      void api.shotMedia(selected.id, index).then(result => result.ok && result.data ? result.data.dataUrl : "error", () => "error")
        .then(url => { if (!disposed) setShotVideos(old => ({ ...old, [key]: url })); });
    });
    return () => { disposed = true; };
  }, [api, selected?.id, selected?.status === "completed", readyKey]);
  async function perform<T>(name: string, action: () => Promise<T>, done: (value: T) => void) {
    if (busy) return;
    setBusy(name); setError("");
    try { done(await action()); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作未完成。"); }
    finally { setBusy(""); }
  }
  const selectTask = (task: VideoTask) => { setSelected(task); setVideo(""); setExportResult(""); };
  const startNew = () => { setSelected(null); setVideo(""); setExportResult(""); setError(""); };
  async function generate() {
    if (!api || busy) return;
    setBusy("start"); setError(""); setVideo(""); setExportResult("");
    try {
      const input = { mode: "product", style: "real", productName: draft.productName, durationSeconds: draft.durationSeconds, imageId: draft.imageId,
        extraImageIds: images.slice(1).map((item) => item.id), ...(realDraft.sceneId ? { sceneIds: [realDraft.sceneId] } : { sceneText: realDraft.sceneText.trim() }),
        ...(realDraft.venue ? { venueImageId: realDraft.venue.id } : {}), pointIds: realDraft.pointIds, customPoints: realDraft.customPoints };
      const result = await api.createAndStart(input);
      if (result.ok && result.data) updateTask(result.data);
      else { if (result.task) updateTask(result.task); setError(result.code === "trusted_user_click_required" ? "还没开始：请在右边点一下「开始生成」。" : result.error || "没能开始制作，请稍后再试。"); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "没能开始制作。"); }
    finally { setBusy(""); }
  }
  const running = Boolean(selected && ACTIVE.has(selected.status));
  const realReady = Boolean(draft.productName.trim() && realSceneReady(realDraft));
  const canGenerate = Boolean(draft.imageId && !busy && !running && realReady);
  const estimate = realEstimate(capability?.timing, capability?.catalog, draft.durationSeconds, realDraft);
  const waiting = selected && ["awaiting_sheet", "awaiting_storyboard"].includes(selected.status);
  const boardStep = Boolean(selected?.storyboard && ["drawing_frames", "awaiting_storyboard"].includes(selected.status));
  const addImage = (extra: boolean) => api && void perform("image", () => unwrap(api.importImage()), item => {
    if (!item) return;
    setImages(old => extra ? [...old.filter(row => row.id !== item.id), item].slice(0, MAX_PHOTOS) : [item, ...old.slice(1)]);
    if (!extra) setDraft(old => ({ ...old, imageId: item.id }));
  });
  // A photo of the customer's own site: it becomes the scene of every venue shot.
  const pickVenue = () => api && void perform("image", () => unwrap(api.importImage()), item => { if (item) setRealDraft(old => ({ ...old, venue: item })); });
  const quote = selected?.quote;
  const shots = selected?.plan.shots || [];
  const ready = selected?.shotsReady || shots.map((_, index) => index < (selected?.completedShots || 0));
  const shotState = (index: number) => ready[index] ? "done" : selected && index === selected.currentShot && running && !finishing(selected) && selected.status !== "transcribing" ? "now" : selected && STUCK.has(selected.status) && index === selected.currentShot ? "stuck" : "wait";
  const history = items.filter(task => task.id !== selected?.id);
  return <div className="product-video-page pv2">
    <ExampleBanner topic="product-video" />
    <div className={`pv2-grid${selected?.status === "completed" || boardStep ? " is-wide" : ""}`}>
      <section className="pv2-card pv2-form" aria-label="产品资料">
        <div className="pv2-top">
          <div><h2>产品图</h2>
            <button type="button" className={`pv2-upload${image ? " has-image" : ""}`} disabled={!!busy || running} onClick={() => addImage(false)}>{image ? <><img src={image.previewDataUrl} alt="已上传的产品" /><span className="pv2-chip">点一下换一张</span></> : <><ImagePlus size={54} strokeWidth={1.4} /><b>放产品图</b><small>产品完整、背景干净</small></>}</button>
            <ProductPhotos images={images} disabled={!!busy || running} onAdd={() => addImage(true)} onRemove={(id) => setImages(old => old.filter(row => row.id !== id))} />
          </div>
          <div className="pv2-fields">
            <label><h2>产品叫什么？</h2><input maxLength={80} value={draft.productName} onChange={event => setDraft({ ...draft, productName: event.target.value })} placeholder="例如：CC1 Pro 洗地机器人" /></label>
            <p className="pv2-note">不用写提示词：AI 导演看你的产品图安排每个镜头，先画分镜给你看，可以改动作和机位，确认了才拍视频。</p>
          </div>
        </div>
        {capability?.catalog ? <RealShootFields catalog={capability.catalog} draft={realDraft} durationSeconds={draft.durationSeconds} disabled={!!busy || running}
          onChange={(next) => { setError(""); setRealDraft(next); }} onPickVenue={pickVenue} /> : <p className="pv2-note">正在读取可选的场所和卖点…</p>}
        <h2 className="pv2-label">要多长？</h2>
        <div className="pv2-choices">{DURATIONS.map(seconds => <button key={seconds} type="button" aria-pressed={draft.durationSeconds === seconds} className={draft.durationSeconds === seconds ? "is-on" : ""} onClick={() => {
          setDraft({ ...draft, durationSeconds: seconds });
          // Fewer selling points fit a shorter video: keep the first ones picked.
          const limit = capability?.catalog?.pointLimit[seconds];
          if (limit) setRealDraft(old => { const pointIds = old.pointIds.slice(0, limit); return { ...old, pointIds, customPoints: old.customPoints.slice(0, Math.max(0, limit - pointIds.length)) }; });
        }}>{seconds} 秒</button>)}</div>
        <button type="button" className="pv2-go" data-product-video-action="start" disabled={!canGenerate} onClick={() => void generate()}>{busy === "start" ? <LoaderCircle size={24} className="spin" /> : <Play size={24} />}生成视频{estimate > 0 && <small className="rs-go-eta">预计 {minutes(estimate)}</small>}</button>
        <p className="pv2-note">{!draft.imageId ? "先放一张产品图。" : !realReady ? (draft.productName.trim() ? "选一个使用场所就能生成。" : "填上产品名称、选一个使用场所就能生成。") : running ? "这条还在做，做完再开始下一条。"
          : "做完后按实际用量扣算力，没做成的不扣。预计时间不含你确认定妆照和分镜的时间。"}</p>
        {capability && !capability.real?.ready && capability.real?.message && <p className="pv2-note">{capability.real.message}</p>}
      </section>

      <section className="pv2-card pv2-side" aria-label="制作进度">
        {selected ? <>
          <div className="pv2-side-head"><h2>{selected.status === "completed" ? "做好了" : STUCK.has(selected.status) ? "停住了" : selected.status === "draft" ? "还没开始" : waiting ? "等你确认" : "正在拍"}</h2><small>{selected.productName || "产品"} · {selected.plan.scene} · {selected.durationSeconds} 秒</small><span className="pv2-status" role="status">{selected.statusLabel}</span></div>
          {selected.status === "completed" ? <div className="pv2-result">
            <div className="pv2-result-media">{video ? <video controls autoPlay preload="metadata" src={video} /> : <button type="button" className="pv2-play" disabled={!!busy || !selected.canPreview} onClick={() => api && void perform("media", () => unwrap(api.media(selected.id)), data => setVideo(data.dataUrl))}>{busy === "media" ? <LoaderCircle size={40} className="spin" /> : <Play size={44} />}<span>点这里播放成片</span></button>}</div>
            <div className="pv2-result-side">
            <div className="pv2-actions">
              {selected.canExport && <button type="button" className="pv2-btn is-main" disabled={!!busy} onClick={() => api && void perform("export", () => unwrap(api.export(selected.id)), result => { if (result) setExportResult(`已导出：${result.path}`); })}><Download size={19} />导出视频</button>}
              <button type="button" className="pv2-btn" onClick={startNew}><Plus size={19} />再做一条</button>
              {selected.canExportSource && <button type="button" className="pv2-btn" disabled={!!busy} onClick={() => api && void perform("source", () => unwrap(api.exportSource(selected.id)), result => { if (result) setExportResult(`已导出原片：${result.path}`); })}>导出原片</button>}
            </div>
            {selected.realPipeline && <ShotReviewPanel review={selected.review} titles={shots.map((shot) => shot.title)} canRedo={Boolean(api?.redoShot && selected.canRedoShot)} busy={!!busy} finished={selected.status === "completed"}
              onRedo={(index) => api?.redoShot && void perform("redo-shot", () => unwrap(api.redoShot!(selected.id, index)), updateTask)} />}
            {selected.redoNote && <p className="pv2-note" role="status">{selected.redoNote}</p>}
            {selected.storyboard?.autoRedone && <p className="pv2-note">第 {selected.storyboard.autoRedone.index + 1} 镜第一次拍出来画面里多了东西（{selected.storyboard.autoRedone.issue.replace(/^第\d+格/u, "")}），已经自动重拍了一次。</p>}
            {selected.plan.sendText && <div className="pv2-send"><b>发给客户时可以配这句话</b><p>{selected.plan.sendText}</p></div>}
            {exportResult && <p className="pv2-note" role="status">{exportResult}</p>}
            </div>
          </div> : boardStep ? <StoryboardConfirm task={selected} busy={!!busy} imageMedia={(id, key) => api ? api.imageMedia(id, key) : Promise.resolve({ ok: false })}
              onSave={(index, change) => api && void perform("update-shot", () => unwrap(api.updateShot(selected.id, index, change)), updateTask)}
              onConfirm={() => api && void perform("confirm-storyboard", () => unwrap(api.confirmStoryboard(selected.id)), updateTask)} />
          : selected.realPipeline && !STUCK.has(selected.status) && selected.status !== "draft" ? <>
            <div className="pv2-progress"><Ring value={progressOf(selected)} lines={[selected.status === "awaiting_sheet" ? "等你确认" : selected.statusLabel, `${selected.durationSeconds} 秒 · ${shots.length} 个镜头`]} />
              {selected.status !== "awaiting_sheet" && <div className="rs-side-info"><Countdown finishAt={selected.estimatedFinishAt} /><p className="pv2-note">几个镜头同时在拍，拍好一个就显示一个。可以先去做别的，做好了桌宠会告诉你。</p></div>}</div>
            {selected.status === "awaiting_sheet" && <CrewCard crew={selected.crew} atSheet />}
            {selected.status === "awaiting_sheet"
              ? <SheetConfirm taskId={selected.id} redos={selected.sheetRedos || 0} busy={!!busy} imageMedia={(id, key) => api ? api.imageMedia(id, key) : Promise.resolve({ ok: false })}
                onConfirm={() => api && void perform("confirm", () => unwrap(api.confirmSheet(selected.id)), updateTask)}
                onRedo={() => api && void perform("redo", () => unwrap(api.redoSheet(selected.id)), updateTask)} />
              : <RealShootProgress task={selected} shotVideos={shotVideos} />}
          </> : selected.storyPipeline && !STUCK.has(selected.status) && selected.status !== "draft" ? <>
            <div className="pv2-progress"><Ring value={progressOf(selected)} lines={[selected.status === "awaiting_sheet" ? "等你确认" : selected.statusLabel, `${selected.durationSeconds} 秒 · ${shots.length} 段`]} />
              {selected.status !== "awaiting_sheet" && <div className="rs-side-info"><Countdown finishAt={selected.estimatedFinishAt} /></div>}</div>
            <StoryVideoProgress task={selected} busy={!!busy} imageMedia={(id, key) => api ? api.imageMedia(id, key) : Promise.resolve({ ok: false })} shotMedia={(id, index) => api ? api.shotMedia(id, index) : Promise.resolve({ ok: false })}
              onConfirm={() => api && void perform("confirm", () => unwrap(api.confirmSheet(selected.id)), updateTask)}
              onRedo={() => api && void perform("redo", () => unwrap(api.redoSheet(selected.id)), updateTask)} />
          </> : <>
            <div className="pv2-progress">
              <Ring value={progressOf(selected)} lines={[`镜头 ${selected.completedShots} / ${shots.length} 拍好`, finishing(selected) ? "正在配音合成" : running ? "做好会自动显示" : ""].filter(Boolean)} />
              {!(selected.realPipeline && STUCK.has(selected.status)) && <div className="pv2-bars">{shots.map((shot, index) => { const state = shotState(index); return <div key={shot.index} className={`is-${state}`}>
                <span>镜头 {index + 1}</span><em>{state === "done" ? "✓ 好了" : state === "now" ? "拍摄中" : state === "stuck" ? "停住了" : "排队"}</em>
                <i><b style={{ width: state === "done" ? "100%" : state === "now" ? "45%" : "0%" }} /></i></div>; })}</div>}
            </div>
            {selected.realPipeline && STUCK.has(selected.status) && <AgentStage model={sceneStageModel(selected)} label="AI 导演组工作台" />}
            <div className="pv2-shots">{shots.map((shot, index) => { const src = shotVideos[`${selected.id}:${index}`]; const state = shotState(index);
              return state === "done" && src && src !== "error" ? <figure key={shot.index}><video src={src} muted controls preload="metadata" /><figcaption>镜头 {index + 1} ✓</figcaption></figure>
                : <div key={shot.index} className={`pv2-shot-wait is-${state}`}>{state === "done" ? (src === "error" ? <Check size={28} /> : <LoaderCircle size={28} className="spin" />) : state === "now" ? <Clapperboard size={30} /> : state === "stuck" ? <AlertTriangle size={30} /> : <Hourglass size={28} />}<span>镜头 {index + 1} {state === "done" ? (src === "error" ? "画面打不开，成片里会有" : "加载画面") : state === "now" ? "拍摄中" : state === "stuck" ? "停住了" : "排队"}</span></div>; })}</div>
            {selected.error && <p className="pv-error" role="alert">{selected.error}</p>}
            {selected.status === "draft" && <>
              {quote && !quote.ready && <p className="pv2-note">生成服务暂时没准备好，可以点「再检查一次」。</p>}
              {quote?.ready && Number(quote.maximumCny) > Number(quote.budgetCny) && <p className="pv2-note">这次制作的额度不够，请联系管理员。</p>}
              <button type="button" className="pv2-btn is-main" data-product-video-action="start" disabled={!!busy || !quote?.ready || Number(quote.maximumCny) > Number(quote.budgetCny)} onClick={() => api && void perform("start", () => unwrap(api.start(selected.id)), updateTask)}><Play size={19} />开始生成{credits(quote?.maximumCny) && `（最多约 ${credits(quote?.maximumCny)} 算力）`}</button>
            </>}
            <div className="pv2-actions">
              {selected.canRetry && <button type="button" className="pv2-btn is-main" data-product-video-action="retry-shot" disabled={!!busy} onClick={() => api && void perform("retry", () => unwrap(api.retryShot(selected.id)), updateTask)}><RefreshCw size={18} />{selected.retryLabel || "接着做"}</button>}
              {(selected.canRefresh || STUCK.has(selected.status) || selected.status === "draft") && <button type="button" className="pv2-btn" disabled={!!busy} onClick={() => api && void perform("refresh", () => unwrap(api.refresh(selected.id)), updateTask)}><RefreshCw size={18} />{selected.status === "outcome_unknown" ? "核对一下" : selected.status === "draft" ? "再检查一次" : "刷新进度"}</button>}
            </div>
            {STUCK.has(selected.status) && <div className="pv2-stuck"><AlertTriangle size={30} /><div><b>这条卡住了？</b><span>可以直接放弃，换一条新的接着做。这条会留在下面「做过的」里。</span></div><button type="button" className="pv2-btn is-main" onClick={startNew}>放弃这条，新建视频</button></div>}
          </>}
          {exportResult && selected.status !== "completed" && <p className="pv2-note" role="status">{exportResult}</p>}
        </> : <div className="pv2-empty">
          <div className="pv2-canvas">{image ? <img src={image.previewDataUrl} alt="已选择的产品图" /> : <ImagePlus size={70} strokeWidth={1.2} />}</div>
          <ol className="pv2-journey"><li><span><ImagePlus size={26} /></span>放产品图</li><li><span><SceneIcon id="market" size={34} /></span>点选场景卖点</li><li><span><Play size={26} /></span>看分镜再拍</li></ol>
          <p className="pv2-note">不用拉设备、不用布置现场：放产品图，填名称，选场所和卖点。AI 先画四个角度给你确认，再给每个卖点画一张分镜，你看过、可以改动作和机位，确认后才拍视频，每个卖点一个镜头，配一行字幕。</p>
        </div>}
        {history.length > 0 && <div className="pv2-history"><h3>做过的</h3><div>{history.slice(0, 9).map(task => <button type="button" key={task.id} onClick={() => selectTask(task)} className={`is-${task.status === "completed" ? "done" : STUCK.has(task.status) ? "stuck" : "other"}`}>
          <span className="pv2-history-icon">{task.status === "completed" ? <Play size={18} /> : STUCK.has(task.status) ? <AlertTriangle size={18} /> : <LoaderCircle size={18} />}</span>
          <span><b>{task.productName || task.plan.scene}</b><small>{task.plan.scene} · {task.durationSeconds} 秒 · {task.statusLabel}</small></span></button>)}</div></div>}
      </section>
    </div>
    {error && <p className="pv-error" role="alert">{error}</p>}
  </div>;
}
