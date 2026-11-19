import { useEffect, useState } from "react";
import { AlertTriangle, Check, Clapperboard, Download, FileText, Hourglass, ImagePlus, LoaderCircle, Play, Plus, RefreshCw } from "lucide-react";
import "./ProductVideoPage.css";
import { ExampleBanner } from './VideoExamples';
import { SceneIcon } from "./SceneIcons";
import { formatWan } from "./BillingBadge";
import { StoryVideoProgress, storyProgress, type StoryTask } from "./StoryVideoProgress";

type Choice = { id: string; name: string };
type Quote = { ready?: boolean; estimatedCny?: number | null; maximumCny?: number; actualCny?: number; pendingCny?: number; reservedCny?: number; budgetCny?: number; note?: string; message?: string; checkedAt?: string };
type Plan = {
  version: string; pipelineVersion?: number; scene: string; evidenceStatus: string; sourceResolution?: string;
  shots: { index: number; seconds: number; title: string; narration: string }[];
  sendText: string;
};
type VideoTask = {
  id: string; mode: "product" | "social"; status: string; statusLabel: string; createdAt: string;
  durationSeconds: number; sceneIds?: string[]; productName?: string; facts: string; imageId: string; plan: Plan; currentShot: number;
  completedShots: number; shotsReady?: boolean[]; storyPipeline?: boolean; imagesReady?: Record<string, boolean>; imageTotal?: number; sheetRedos?: number;
  story?: StoryTask["story"]; error: string; resumeStatus?: string; retryLabel?: string; canRetry: boolean; canExport: boolean; canExportSource?: boolean; canPreview: boolean; canRefresh?: boolean; quote?: Quote;
};
type Result<T> = { ok: boolean; data?: T; error?: string; code?: string; task?: VideoTask };
type Capabilities = { ready: boolean; message: string; scenes: Choice[]; story?: { ready: boolean; message: string } };
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
  confirmSheet(id: string): Promise<Result<VideoTask>>; redoSheet(id: string): Promise<Result<VideoTask>>;
  export(id: string): Promise<Result<{ path: string; subtitlePath?: string; sendText: string } | null>>;
  exportSource(id: string): Promise<Result<{ path: string } | null>>;
};
declare global { interface Window { xiaoxiProductVideo?: VideoApi } }
const ACTIVE = new Set(["imaging", "writing_story", "composing", "uploading", "preparing_frames", "frame_generating", "locking_frames", "preparing_audio", "audio_preparing", "submitting", "generating", "assembling", "enhancing", "transcribing", "packaging"]);
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
  const [image, setImage] = useState<{ id: string; name: string; previewDataUrl: string } | null>(null);
  const [factsFile, setFactsFile] = useState("");
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
      const result = await api.createAndStart({ ...draft, mode: "product", style: "story" });
      if (result.ok && result.data) updateTask(result.data);
      else { if (result.task) updateTask(result.task); setError(result.code === "trusted_user_click_required" ? "还没开始：请在右边点一下「开始生成」。" : result.error || "没能开始制作，请稍后再试。"); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "没能开始制作。"); }
    finally { setBusy(""); }
  }
  // The story happens in one place.
  const toggleScene = (id: string) => { setError(""); setDraft(old => ({ ...old, sceneIds: old.sceneIds[0] === id ? [] : [id] })); };
  const running = Boolean(selected && ACTIVE.has(selected.status));
  const canGenerate = Boolean(draft.imageId && !busy && !running && draft.facts.length <= 12000);
  const quote = selected?.quote;
  const shots = selected?.plan.shots || [];
  const ready = selected?.shotsReady || shots.map((_, index) => index < (selected?.completedShots || 0));
  const shotState = (index: number) => ready[index] ? "done" : selected && index === selected.currentShot && running && !finishing(selected) && selected.status !== "transcribing" ? "now" : selected && STUCK.has(selected.status) && index === selected.currentShot ? "stuck" : "wait";
  const history = items.filter(task => task.id !== selected?.id);
  return <div className="product-video-page pv2">
    <header className="pv2-header"><h1>场景效果视频</h1><p>一张产品图，变成在现场干活的视频。</p></header>
    <ExampleBanner topic="product-video" />
    <div className="pv2-grid">
      <section className="pv2-card pv2-form" aria-label="产品资料">
        <div className="pv2-top">
          <div><h2>产品图</h2>
            <button type="button" className={`pv2-upload${image ? " has-image" : ""}`} disabled={!!busy || running} onClick={() => api && void perform("image", () => unwrap(api.importImage()), item => {
              if (item) { setImage(item); setDraft(old => ({ ...old, imageId: item.id })); }
            })}>{image ? <><img src={image.previewDataUrl} alt="已上传的产品" /><span className="pv2-chip">点一下换一张</span></> : <><ImagePlus size={54} strokeWidth={1.4} /><b>放产品图</b><small>产品完整、背景干净</small></>}</button>
          </div>
          <div className="pv2-fields">
            <label><h2>产品叫什么？</h2><input maxLength={80} value={draft.productName} onChange={event => setDraft({ ...draft, productName: event.target.value })} placeholder="例如：CC1 Pro 洗地机器人" /></label>
            <label htmlFor="pv-facts" className="pv2-facts-head"><h2>它最厉害的几点</h2><button type="button" className="pv2-link" disabled={!!busy} onClick={(event) => { event.preventDefault(); api && void perform("facts", () => unwrap(api.importFacts()), file => { if (file) { setFactsFile(file.name); setDraft(old => ({ ...old, facts: old.facts ? `${old.facts}\n\n${file.text}` : file.text })); } }); }}><FileText size={16} />导入资料</button></label>
            <textarea id="pv-facts" maxLength={12000} rows={4} value={draft.facts} onChange={event => setDraft({ ...draft, facts: event.target.value })} placeholder="例如：一小时拖完 1500 平；自己回站加水倒污水。没有也可以先做外观展示。" />
            {factsFile && <small className="pv2-meta">已导入：{factsFile}</small>}
            {draft.facts.length > 12000 && <p className="pv-error">资料超过 12,000 字，请精简一些。</p>}
          </div>
        </div>
        <h2 className="pv2-label">故事发生在哪里？<small>选一个，不选就拍工厂仓储</small></h2>
        <div className="pv2-scenes">{(capability?.scenes || []).map(scene => { const on = draft.sceneIds.includes(scene.id); return <button key={scene.id} type="button" aria-pressed={on} className={on ? "is-on" : ""} onClick={() => toggleScene(scene.id)}><span className="pv2-scene-icon"><SceneIcon id={scene.id} /></span>{scene.name}{on && <Check className="pv2-check" size={16} strokeWidth={3} />}</button>; })}</div>
        <h2 className="pv2-label">要多长？</h2>
        <div className="pv2-choices">{DURATIONS.map(seconds => <button key={seconds} type="button" aria-pressed={draft.durationSeconds === seconds} className={draft.durationSeconds === seconds ? "is-on" : ""} onClick={() => setDraft({ ...draft, durationSeconds: seconds })}>{seconds} 秒</button>)}</div>
        <button type="button" className="pv2-go" data-product-video-action="start" disabled={!canGenerate} onClick={() => void generate()}>{busy === "start" ? <LoaderCircle size={24} className="spin" /> : <Play size={24} />}生成视频</button>
        <p className="pv2-note">{!draft.imageId ? "先放一张产品图。" : running ? "这条还在做，做完再开始下一条。" : "做完后按实际用量扣算力，没做成的不扣。"}</p>
        {capability && !capability.story?.ready && capability.story?.message && <p className="pv2-note">{capability.story.message}</p>}
      </section>

      <section className="pv2-card pv2-side" aria-label="制作进度">
        {selected ? <>
          <div className="pv2-side-head"><h2>{selected.status === "completed" ? "做好了" : STUCK.has(selected.status) ? "停住了" : selected.status === "draft" ? "还没开始" : selected.status === "awaiting_sheet" ? "等你确认" : "正在拍"}</h2><small>{selected.productName || "产品"} · {selected.plan.scene} · {selected.durationSeconds} 秒</small><span className="pv2-status" role="status">{selected.statusLabel}</span></div>
          {selected.status === "completed" ? <div className="pv2-result">
            {video ? <video controls autoPlay preload="metadata" src={video} /> : <button type="button" className="pv2-play" disabled={!!busy || !selected.canPreview} onClick={() => api && void perform("media", () => unwrap(api.media(selected.id)), data => setVideo(data.dataUrl))}>{busy === "media" ? <LoaderCircle size={40} className="spin" /> : <Play size={44} />}<span>点这里播放成片</span></button>}
            <div className="pv2-actions">
              {selected.canExport && <button type="button" className="pv2-btn is-main" disabled={!!busy} onClick={() => api && void perform("export", () => unwrap(api.export(selected.id)), result => { if (result) setExportResult(`已导出：${result.path}`); })}><Download size={19} />导出视频</button>}
              <button type="button" className="pv2-btn" onClick={startNew}><Plus size={19} />再做一条</button>
              {selected.canExportSource && <button type="button" className="pv2-btn" disabled={!!busy} onClick={() => api && void perform("source", () => unwrap(api.exportSource(selected.id)), result => { if (result) setExportResult(`已导出原片：${result.path}`); })}>导出原片</button>}
            </div>
            {selected.plan.sendText && <div className="pv2-send"><b>发给客户时可以配这句话</b><p>{selected.plan.sendText}</p></div>}
          </div> : selected.storyPipeline && !STUCK.has(selected.status) && selected.status !== "draft" ? <>
            <div className="pv2-progress"><Ring value={progressOf(selected)} lines={[selected.status === "awaiting_sheet" ? "等你确认" : selected.statusLabel, `${selected.durationSeconds} 秒 · ${shots.length} 段`]} /></div>
            <StoryVideoProgress task={selected} busy={!!busy} imageMedia={(id, key) => api ? api.imageMedia(id, key) : Promise.resolve({ ok: false })} shotMedia={(id, index) => api ? api.shotMedia(id, index) : Promise.resolve({ ok: false })}
              onConfirm={() => api && void perform("confirm", () => unwrap(api.confirmSheet(selected.id)), updateTask)}
              onRedo={() => api && void perform("redo", () => unwrap(api.redoSheet(selected.id)), updateTask)} />
          </> : <>
            <div className="pv2-progress">
              <Ring value={progressOf(selected)} lines={[`镜头 ${selected.completedShots} / ${shots.length} 拍好`, finishing(selected) ? "正在配音合成" : running ? "做好会自动显示" : ""].filter(Boolean)} />
              <div className="pv2-bars">{shots.map((shot, index) => { const state = shotState(index); return <div key={shot.index} className={`is-${state}`}>
                <span>镜头 {index + 1}</span><em>{state === "done" ? "✓ 好了" : state === "now" ? "拍摄中" : state === "stuck" ? "停住了" : "排队"}</em>
                <i><b style={{ width: state === "done" ? "100%" : state === "now" ? "45%" : "0%" }} /></i></div>; })}</div>
            </div>
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
          {exportResult && <p className="pv2-note" role="status">{exportResult}</p>}
        </> : <div className="pv2-empty">
          <div className="pv2-canvas">{image ? <img src={image.previewDataUrl} alt="已选择的产品图" /> : <ImagePlus size={70} strokeWidth={1.2} />}</div>
          <ol className="pv2-journey"><li><span><ImagePlus size={26} /></span>放产品图</li><li><span><SceneIcon id="market" size={34} /></span>选场景</li><li><span><Play size={26} /></span>点生成</li></ol>
          <p className="pv2-note">AI 先照产品画定妆照，你确认后再写故事、找演员、画分镜，一段一段拍出带对话的现场视频。</p>
        </div>}
        {history.length > 0 && <div className="pv2-history"><h3>做过的</h3><div>{history.slice(0, 9).map(task => <button type="button" key={task.id} onClick={() => selectTask(task)} className={`is-${task.status === "completed" ? "done" : STUCK.has(task.status) ? "stuck" : "other"}`}>
          <span className="pv2-history-icon">{task.status === "completed" ? <Play size={18} /> : STUCK.has(task.status) ? <AlertTriangle size={18} /> : <LoaderCircle size={18} />}</span>
          <span><b>{task.productName || task.plan.scene}</b><small>{task.plan.scene} · {task.durationSeconds} 秒 · {task.statusLabel}</small></span></button>)}</div></div>}
      </section>
    </div>
    {error && <p className="pv-error" role="alert">{error}</p>}
  </div>;
}
