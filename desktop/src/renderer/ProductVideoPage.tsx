import { useEffect, useState } from "react";
import { ArrowRight, Download, ImagePlus, LoaderCircle, RefreshCw } from "lucide-react";
import "./ProductVideoPage.css";

type Mode = "product" | "social";
type Choice = { id: string; name: string };
type Plan = {
  version: string; director: string; scene: string; surface: string; dirt: string; goal: string;
  evidenceStatus: string; concept?: string; photography?: string; visualDirection?: string; lighting?: string;
  soundDesign?: string; negativeConstraints?: string; sourceResolution?: string; outputSize?: string;
  shots: { index: number; seconds: number; startSecond?: number; endSecond?: number; title: string; narration: string; prompt: string }[];
  sendText: string; estimatedVideoUsd: number; estimateNote: string;
};
type VideoTask = {
  id: string; mode: Mode; status: string; statusLabel: string; createdAt: string;
  durationSeconds: number; sceneId: string; surfaceId: string; dirtId: string; goalId: string;
  expression: string; facts: string; imageId: string; plan: Plan; currentShot: number;
  completedShots: number; error: string; resumeStatus?: string; canRetry: boolean; canExport: boolean; canPreview: boolean;
};
type Result<T> = { ok: boolean; data?: T; error?: string };
type VideoApi = {
  capabilities(): Promise<Result<{ ready: boolean; message: string; scenes: Choice[]; surfaces: Choice[]; dirt: Choice[]; goals: Choice[]; videoPricePerSecondUsd: number }>>;
  importImage(): Promise<Result<{ id: string; name: string; previewDataUrl: string } | null>>;
  create(input: Record<string, string | number>): Promise<Result<VideoTask>>;
  list(): Promise<Result<{ items: VideoTask[] }>>;
  get(id: string): Promise<Result<VideoTask>>;
  start(id: string): Promise<Result<VideoTask>>;
  retryShot(id: string): Promise<Result<VideoTask>>;
  refresh(id: string): Promise<Result<VideoTask>>;
  media(id: string): Promise<Result<{ dataUrl: string }>>;
  export(id: string): Promise<Result<{ path: string; subtitlePath: string; sendText: string } | null>>;
};
declare global { interface Window { xiaoxiProductVideo?: VideoApi } }
const ACTIVE = new Set(["uploading", "submitting", "generating", "assembling", "enhancing"]);
const fallbackChoices = {
  scenes: [{ id: "community", name: "小区外围" }, { id: "school", name: "学校" }, { id: "hospital", name: "医院" }, { id: "office", name: "办公楼" }, { id: "factory", name: "厂区" }],
  surfaces: [{ id: "marble", name: "大理石" }, { id: "terrazzo", name: "水磨石" }, { id: "tile", name: "瓷砖" }, { id: "concrete", name: "水泥地" }, { id: "epoxy", name: "环氧地坪" }, { id: "asphalt", name: "沥青路面" }],
  dirt: [{ id: "none", name: "不指定污渍" }, { id: "dust", name: "灰尘" }, { id: "leaves", name: "落叶" }, { id: "water", name: "积水" }, { id: "footprints", name: "脚印" }],
  goals: [{ id: "appearance", name: "展示产品外观" }, { id: "operation", name: "展示作业过程" }, { id: "result", name: "展示清洁前后" }]
};
const initial = { sceneId: "community", surfaceId: "marble", dirtId: "none", goalId: "appearance", durationSeconds: 30, facts: "", expression: "", imageId: "" };
async function unwrap<T>(result: Promise<Result<T>>): Promise<T> {
  const value = await result;
  if (!value.ok || value.data === undefined) throw new Error(value.error || "操作未完成，请稍后重试。");
  return value.data;
}

export function ProductVideoPage({ mode }: { mode: Mode }) {
  const api = window.xiaoxiProductVideo;
  const [choices, setChoices] = useState(fallbackChoices);
  const [ready, setReady] = useState(false);
  const [videoPricePerSecondUsd, setVideoPricePerSecondUsd] = useState<number | null>(null);
  const [capabilityMessage, setCapabilityMessage] = useState("");
  const [draft, setDraft] = useState({ ...initial });
  const [image, setImage] = useState<{ id: string; name: string; previewDataUrl: string } | null>(null);
  const [selected, setSelected] = useState<VideoTask | null>(null);
  const [items, setItems] = useState<VideoTask[]>([]);
  const [video, setVideo] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [exportResult, setExportResult] = useState("");

  useEffect(() => {
    if (!api) { setError("视频工作台尚未连接，请重新启动应用。"); return; }
    let disposed = false;
    void Promise.all([api.capabilities(), api.list()]).then(([capability, tasks]) => {
      if (disposed) return;
      if (capability.ok && capability.data) {
        setReady(capability.data.ready);
        setVideoPricePerSecondUsd(capability.data.videoPricePerSecondUsd);
        setCapabilityMessage(capability.data.message);
        setChoices({ scenes: capability.data.scenes, surfaces: capability.data.surfaces, dirt: capability.data.dirt, goals: capability.data.goals });
      }
      if (tasks.ok && tasks.data) setItems(tasks.data.items.filter((task) => task.mode === mode));
    }).catch((cause) => { if (!disposed) setError(String(cause)); });
    return () => { disposed = true; };
  }, [api, mode]);
  useEffect(() => {
    if (!api || !selected || !ACTIVE.has(selected.status)) return;
    const timer = window.setInterval(() => {
      void api.refresh(selected.id).then((result) => {
        if (result.ok && result.data) setSelected(result.data);
      });
    }, 8_000);
    return () => window.clearInterval(timer);
  }, [api, selected?.id, selected?.status]);

  async function perform<T>(name: string, action: () => Promise<T>, done: (value: T) => void) {
    setBusy(name); setError("");
    try { done(await action()); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作未完成。"); }
    finally { setBusy(""); }
  }
  const selectTask = (task: VideoTask) => {
    setSelected(task); setVideo(""); setExportResult("");
  };
  const savePlan = () => {
    if (!api) return;
    void perform("plan", () => unwrap(api.create({ ...draft, mode })), (task) => {
      selectTask(task); setItems((current) => [task, ...current]);
    });
  };
  const canPlan = Boolean(draft.imageId && !busy);
  return <div className="product-video-page">
    <header className="pv-header"><div><h1>{mode === "product" ? "产品效果视频" : "社媒短片"}</h1>
      <p>{mode === "product" ? "选场景、上传产品图、说出重点。先确认分镜，再生成视频。" : "用真实场景和产品细节，制作一条不出镜的获客短片。"}</p>
      <p className="pv-quality">默认 480p 生成，本地放大为 1080p 尺寸</p></div></header>
    <div className="pv-layout"><section className="pv-panel">
      <h2>1 · 准备视频内容</h2>
      <div className="pv-scene-grid">{choices.scenes.map((scene) => <button key={scene.id} type="button" className={draft.sceneId === scene.id ? "is-selected" : ""} onClick={() => setDraft({ ...draft, sceneId: scene.id })}>{scene.name}</button>)}</div>
      <button type="button" className="pv-upload" onClick={() => api && void perform("image", () => unwrap(api.importImage()), (item) => {
        if (item) { setImage(item); setDraft((old) => ({ ...old, imageId: item.id })); }
      })}>{image ? <img src={image.previewDataUrl} alt="已上传的产品" /> : <ImagePlus size={30} />}
        <span>{image ? image.name : "上传一张产品图片"}<small>JPG、PNG 或 WebP，最多 20MB</small></span></button>
      <details className="pv-details"><summary>细化现场与设备信息</summary>
        <div className="pv-fields"><label>地面材质<select value={draft.surfaceId} onChange={(event) => setDraft({ ...draft, surfaceId: event.target.value })}>{choices.surfaces.map((row) => <option value={row.id} key={row.id}>{row.name}</option>)}</select></label>
          <label>地面状况<select value={draft.dirtId} onChange={(event) => setDraft({ ...draft, dirtId: event.target.value })}>{choices.dirt.map((row) => <option value={row.id} key={row.id}>{row.name}</option>)}</select></label>
          <label>演示目标<select value={draft.goalId} onChange={(event) => setDraft({ ...draft, goalId: event.target.value })}>{choices.goals.map((row) => <option value={row.id} key={row.id}>{row.name}</option>)}</select></label>
          <label>成片时长<select value={draft.durationSeconds} onChange={(event) => setDraft({ ...draft, durationSeconds: Number(event.target.value) })}>{[30, 45, 60].map((seconds) => <option value={seconds} key={seconds}>{seconds} 秒</option>)}</select></label></div>
        <label className="pv-text-label">已确认的产品资料<textarea maxLength={400} rows={3} value={draft.facts} onChange={(event) => setDraft({ ...draft, facts: event.target.value })} placeholder="例如厂家资料中的设备类型、适用地面和作业方式。没有资料时只展示外观。" /></label>
      </details>
      <label className="pv-text-label">还想表达什么<textarea maxLength={400} rows={3} value={draft.expression} onChange={(event) => setDraft({ ...draft, expression: event.target.value })} placeholder="写下希望客户记住的观点或现场问题。" /></label>
      <div className="pv-estimate"><strong>预计视频 API 费用：{videoPricePerSecondUsd === null ? '正在读取价格' : `约 $${(draft.durationSeconds * videoPricePerSecondUsd).toFixed(2)}`}</strong><small>按 480p 单价估算；本地放大不收视频 API 费，但需要电脑处理时间。实际以账单为准。</small></div>
      <button className="pv-primary" type="button" disabled={!canPlan} onClick={savePlan}>{busy === "plan" ? <LoaderCircle size={18} /> : <ArrowRight size={18} />}先看视频方案</button>
      {!ready && capabilityMessage && <p className="pv-note">{capabilityMessage}</p>}
      {error && <p className="pv-error" role="alert">{error}</p>}
    </section>
    <section className="pv-panel pv-output"><h2>2 · 确认分镜与成片</h2>
      {selected ? <><div className="pv-task-head"><strong>视频方案 · {selected.durationSeconds} 秒</strong><span>{selected.statusLabel}</span></div>
        <p className="pv-evidence">{selected.plan.evidenceStatus === "appearance_only" ? "尚无产品能力资料：镜头只展示外观与场景。" : "产品事实来自您填写的资料，请在生成前确认准确性。"}</p>
        {selected.plan.concept && <div className="pv-director-brief"><strong>视频会怎么拍</strong><p>{selected.plan.concept}</p><small>{selected.plan.photography} {selected.plan.lighting}</small><details><summary>查看画面、声音和限制</summary><p>{selected.plan.visualDirection} {selected.plan.soundDesign}</p><p>{selected.plan.negativeConstraints}</p></details></div>}
        <ol className="pv-shots">{selected.plan.shots.map((shot) => <li key={shot.index}><strong>{shot.index + 1}. {shot.title}</strong><span>{shot.startSecond ?? shot.index * 15}–{shot.endSecond ?? (shot.index + 1) * 15} 秒 · 旁白：{shot.narration}</span><details><summary>查看生成提示词</summary><p>{shot.prompt}</p></details></li>)}</ol>
        <p className="pv-evidence">{selected.plan.sourceResolution === '480p' ? '画面将以 480p 生成，再本地放大为 1080p 尺寸；放大不能补回原片没有的细节。' : '这条旧任务沿用创建时的画质设置。'} {selected.plan.estimateNote}</p>
        <p className="pv-progress">镜头进度：{selected.completedShots} / {selected.plan.shots.length}</p>
        {selected.error && <p className="pv-error" role="alert">{selected.error}</p>}
        {selected.status === "draft" && <button type="button" className="pv-primary" data-product-video-action="start" disabled={!ready || !!busy} onClick={() => api && void perform("start", () => unwrap(api.start(selected.id)), setSelected)}>确认分镜，开始生成 · 约 ${selected.plan.estimatedVideoUsd}<ArrowRight size={18} /></button>}
        {selected.canRetry && <button type="button" className="pv-primary" data-product-video-action="retry-shot" disabled={!!busy} onClick={() => api && void perform("retry", () => unwrap(api.retryShot(selected.id)), setSelected)}>{selected.resumeStatus === 'enhancing' ? '继续本地放大画面' : selected.resumeStatus === 'assembling' ? '重新合成视频' : selected.resumeStatus === 'generating' ? '重做当前失败镜头' : '继续制作'}</button>}
        {ACTIVE.has(selected.status) && <button type="button" className="pv-secondary" disabled={!!busy} onClick={() => api && void perform("refresh", () => unwrap(api.refresh(selected.id)), setSelected)}><RefreshCw size={16} />刷新进度</button>}
        {selected.canPreview && <button type="button" className="pv-secondary" disabled={!!busy} onClick={() => api && void perform("media", () => unwrap(api.media(selected.id)), (data) => setVideo(data.dataUrl))}>预览成片</button>}
        {video && <video controls preload="metadata" src={video} />}
        {selected.canExport && <><button type="button" className="pv-primary" disabled={!!busy} onClick={() => api && void perform("export", () => unwrap(api.export(selected.id)), (result) => {
          if (result) setExportResult(`视频：${result.path} · 字幕：${result.subtitlePath}`);
        })}><Download size={17} />一键导出成片</button><div className="pv-send-text"><strong>发给客户时可用</strong><p>{selected.plan.sendText}</p></div>{exportResult && <p className="pv-note">{exportResult}</p>}</>}
      </> : <p className="pv-empty">上传产品图后，先查看镜头方案，再决定是否付费生成。</p>}
    </section></div>
    {items.length > 0 && <section className="pv-history"><h2>制作记录</h2><div>{items.map((task) => <button type="button" key={task.id} onClick={() => selectTask(task)}><span>{task.plan.scene} · {task.durationSeconds} 秒</span><small>{task.statusLabel}</small></button>)}</div></section>}
  </div>;
}
