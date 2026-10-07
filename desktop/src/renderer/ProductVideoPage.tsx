import { useEffect, useState } from "react";
import { ArrowRight, Download, FileText, ImagePlus, LoaderCircle, RefreshCw } from "lucide-react";
import "./ProductVideoPage.css";

type Choice = { id: string; name: string };
type Quote = { ready?: boolean; estimatedCny?: number | null; maximumCny?: number; actualCny?: number; pendingCny?: number; reservedCny?: number; budgetCny?: number; note?: string; message?: string; checkedAt?: string };
type Plan = {
  version: string; pipelineVersion?: number; director: string; scene: string; surface?: string; dirt?: string; goal?: string;
  evidenceStatus: string; concept?: string; photography?: string; visualDirection?: string; lighting?: string;
  soundDesign?: string; negativeConstraints?: string; sourceResolution?: string; outputSize?: string;
  shots: { index: number; seconds: number; startSecond?: number; endSecond?: number; title: string; narration: string; prompt: string; firstFramePrompt?: string; camera?: string; startState?: string; endState?: string }[];
  sendText: string; estimatedVideoUsd?: number; estimateNote?: string;
};
type VideoTask = {
  id: string; mode: "product" | "social"; status: string; statusLabel: string; createdAt: string;
  durationSeconds: number; sceneIds?: string[]; productName?: string; facts: string; imageId: string; plan: Plan; currentShot: number;
  completedShots: number; error: string; resumeStatus?: string; retryLabel?: string; canRetry: boolean; canExport: boolean; canExportSource?: boolean; canPreview: boolean; canRefresh?: boolean; quote?: Quote;
};
type Result<T> = { ok: boolean; data?: T; error?: string };
type Capabilities = { ready: boolean; message: string; scenes: Choice[]; prices?: { ready: boolean; estimatedVideoUsdPerSecond?: number; estimatedImageUsd?: number; fxCnyPerUsd?: number; asrReserveCny?: number } };
type VideoApi = {
  capabilities(): Promise<Result<Capabilities>>;
  importImage(): Promise<Result<{ id: string; name: string; previewDataUrl: string } | null>>;
  importFacts(): Promise<Result<{ name: string; text: string } | null>>;
  create(input: Record<string, string | number | string[]>): Promise<Result<VideoTask>>;
  list(): Promise<Result<{ items: VideoTask[] }>>; get(id: string): Promise<Result<VideoTask>>;
  start(id: string): Promise<Result<VideoTask>>; retryShot(id: string): Promise<Result<VideoTask>>;
  refresh(id: string): Promise<Result<VideoTask>>; media(id: string): Promise<Result<{ dataUrl: string }>>;
  export(id: string): Promise<Result<{ path: string; subtitlePath?: string; sendText: string } | null>>;
  exportSource(id: string): Promise<Result<{ path: string } | null>>;
};
declare global { interface Window { xiaoxiProductVideo?: VideoApi } }
const ACTIVE = new Set(["uploading", "preparing_frames", "frame_generating", "submitting", "generating", "assembling", "enhancing", "transcribing", "packaging"]);
const initial = { productName: "", sceneIds: [] as string[], durationSeconds: 30, facts: "", expression: "", imageId: "", budgetCny: "" };
const money = (value?: number | null) => typeof value === "number" && Number.isFinite(value) ? `¥${value.toFixed(2)}` : "待核价";
async function unwrap<T>(result: Promise<Result<T>>): Promise<T> {
  const value = await result;
  if (!value.ok || value.data === undefined) throw new Error(value.error || "操作未完成，请稍后重试。");
  return value.data;
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
  async function perform<T>(name: string, action: () => Promise<T>, done: (value: T) => void) {
    if (busy) return;
    setBusy(name); setError("");
    try { done(await action()); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作未完成。"); }
    finally { setBusy(""); }
  }
  const selectTask = (task: VideoTask) => { setSelected(task); setVideo(""); setExportResult(""); };
  const savePlan = () => api && void perform("plan", () => unwrap(api.create({ ...draft, budgetCny: Number(draft.budgetCny), mode: "product" })), task => { setVideo(""); setExportResult(""); updateTask(task); });
  const toggleScene = (id: string) => {
    setError("");
    if (!draft.sceneIds.includes(id) && draft.sceneIds.length === 3) { setError("最多选择三个场景，或取消选择让系统按资料安排。"); return; }
    setDraft(old => ({ ...old, sceneIds: old.sceneIds.includes(id) ? old.sceneIds.filter(value => value !== id) : [...old.sceneIds, id] }));
  };
  const canPlan = Boolean(draft.imageId && Number(draft.budgetCny) > 0 && !busy);
  const quote = selected?.quote;
  const withinBudget = quote?.ready && Number(quote.maximumCny) <= Number(quote.budgetCny);
  return <div className="product-video-page">
    <header className="pv-header"><div><h1>产品效果视频</h1><p>上传产品图和卖点参数，把适用场景做成看得见的效果。</p><p className="pv-quality">原生讲解与配乐 · 大字字幕 · 默认30秒</p></div></header>
    <div className="pv-layout"><section className="pv-panel">
      <h2>1 · 准备产品资料</h2>
      <button type="button" className="pv-upload" disabled={!!busy} onClick={() => api && void perform("image", () => unwrap(api.importImage()), item => {
        if (item) { setImage(item); setDraft(old => ({ ...old, imageId: item.id })); }
      })}>{image ? <img src={image.previewDataUrl} alt="已上传的产品" /> : <ImagePlus size={30} />}<span>{image ? image.name : "上传一张产品图片"}<small>JPG、PNG 或 WebP，最多20MB</small></span></button>
      <label className="pv-text-label">产品名称<input maxLength={80} value={draft.productName} onChange={event => setDraft({ ...draft, productName: event.target.value })} placeholder="例如：普渡 CC1 Pro" /></label>
      <div className="pv-facts-heading"><label htmlFor="pv-facts">卖点与参数</label><button className="pv-text-action" type="button" disabled={!!busy} onClick={() => api && void perform("facts", () => unwrap(api.importFacts()), file => { if (file) { setFactsFile(file.name); setDraft(old => ({ ...old, facts: old.facts ? `${old.facts}\n\n${file.text}` : file.text })); } })}><FileText size={16} />导入TXT资料</button></div>
      <textarea id="pv-facts" className="pv-facts" maxLength={12000} rows={7} value={draft.facts} onChange={event => setDraft({ ...draft, facts: event.target.value })} placeholder="粘贴产品卖点、参数、适用场地、能处理的问题。系统依据资料安排镜头；没有能力资料时只展示外观。" />
      <div className="pv-field-meta"><span>{factsFile || "支持直接粘贴，或导入UTF-8文本"}</span><span>{draft.facts.length.toLocaleString()} / 12,000字</span></div>
      {draft.facts.length > 12000 && <p className="pv-error">合并资料超过12,000字，请精简后再生成方案；已保留完整导入内容。</p>}
      <details className="pv-details"><summary>场景、时长与补充要求</summary>
        <p className="pv-note">默认按资料安排适用场景。也可选择最多三个场景，方案会核对资料是否支持。</p>
        <div className="pv-scene-grid">{(capability?.scenes || []).map(scene => <button key={scene.id} type="button" aria-pressed={draft.sceneIds.includes(scene.id)} className={draft.sceneIds.includes(scene.id) ? "is-selected" : ""} onClick={() => toggleScene(scene.id)}>{scene.name}</button>)}</div>
        {draft.sceneIds.length > 0 && <button type="button" className="pv-text-action" onClick={() => setDraft({ ...draft, sceneIds: [] })}>恢复按资料自动安排</button>}
        <label className="pv-text-label">成片时长<select value={draft.durationSeconds} onChange={event => setDraft({ ...draft, durationSeconds: Number(event.target.value) })}>{[30, 45, 60].map(seconds => <option value={seconds} key={seconds}>{seconds}秒</option>)}</select></label>
        <label className="pv-text-label">还想表达什么<textarea maxLength={1000} rows={3} value={draft.expression} onChange={event => setDraft({ ...draft, expression: event.target.value })} placeholder="例如希望客户看到的现场问题、镜头偏好或结尾联系方式。" /></label>
      </details>
      <label className="pv-text-label">本条视频费用上限（人民币）<input type="number" min={1} max={10000} step={1} value={draft.budgetCny} onChange={event => setDraft({ ...draft, budgetCny: event.target.value })} placeholder="填写你允许的最高费用" /></label>
      <p className="pv-note">先看方案与完整报价，确认后才付费生成。费用包括场景首帧、视频和字幕识别，达到上限停止新增调用。</p>
      <button className="pv-primary" type="button" disabled={!canPlan || draft.facts.length > 12000} onClick={savePlan}>{busy === "plan" ? <LoaderCircle size={18} className="spin" /> : <ArrowRight size={18} />}先看视频方案</button>
      {!capability?.ready && capability?.message && <p className="pv-note">{capability.message}</p>}
      {error && <p className="pv-error" role="alert">{error}</p>}
    </section><section className="pv-panel pv-output"><h2>2 · 确认方案，生成成片</h2>
      {selected ? <><div className="pv-task-head"><strong>{selected.productName || "视频方案"} · {selected.durationSeconds}秒</strong><span role="status">{selected.statusLabel}</span></div>
        <p className="pv-evidence">{selected.plan.evidenceStatus === "appearance_only" ? "资料尚不足以支撑作业效果：本方案只展示产品外观与场景。" : "镜头依据你提供的资料安排，请确认场景、动作和口播准确。"}</p>
        {selected.plan.concept && <div className="pv-director-brief"><strong>视频会怎么拍</strong><p>{selected.plan.concept}</p><small>{selected.plan.photography}</small></div>}
        <ol className="pv-shots">{selected.plan.shots.map((shot, index) => { const start = shot.startSecond ?? selected.plan.shots.slice(0, index).reduce((sum, row) => sum + row.seconds, 0); return <li key={shot.index}><strong>{index + 1}. {shot.title}</strong><span>{start}–{shot.endSecond ?? start + shot.seconds}秒 · {shot.camera || "按方案拍摄"}</span><p className="pv-narration">讲解：{shot.narration}</p><details><summary>查看完整分镜与提示词</summary>{shot.startState && <p>开始：{shot.startState}<br />结束：{shot.endState}</p>}{shot.firstFramePrompt && <p>场景首帧：{shot.firstFramePrompt}</p>}<p>视频：{shot.prompt}</p></details></li>; })}</ol>
        {quote && <div className="pv-estimate"><strong>预计 {money(quote.estimatedCny)} · 保守预留 {money(quote.maximumCny)}</strong><small>本次上限 {money(quote.budgetCny)}；已核对费用 {money(quote.actualCny)}，在途或待核账 {money(quote.pendingCny)}。</small><small>{quote.note || quote.message}</small>{quote.ready && !withinBudget && selected.status === "draft" && <p className="pv-error">费用上限低于保守预留，请调整左侧费用上限或时长后重新查看方案。</p>}</div>}
        <p className="pv-evidence">{selected.plan.sourceResolution === "480p" ? "480p生成后本地放大至1080×1920，再渲染字幕。普通放大不能恢复源片没有的细节。" : "旧任务沿用创建时的画质与方案。"}</p>
        <p className="pv-progress">镜头完成 {selected.completedShots} / {selected.plan.shots.length}</p>
        {selected.error && <p className="pv-error" role="alert">{selected.error}</p>}
        {selected.status === "draft" && <button type="button" className="pv-primary" data-product-video-action="start" disabled={!!busy || (selected.plan.pipelineVersion === 2 && !withinBudget)} onClick={() => api && void perform("start", () => unwrap(api.start(selected.id)), updateTask)}>确认方案，开始生成<ArrowRight size={18} /></button>}
        {selected.canRetry && <button type="button" className="pv-primary" data-product-video-action="retry-shot" disabled={!!busy} onClick={() => api && void perform("retry", () => unwrap(api.retryShot(selected.id)), updateTask)}>{selected.retryLabel || (["assembling", "enhancing", "packaging"].includes(selected.resumeStatus || "") ? "继续后期处理" : "继续当前未完成步骤")}</button>}
        {(selected.canRefresh || selected.status === "draft" || selected.status === "outcome_unknown" || ACTIVE.has(selected.status)) && <button type="button" className="pv-secondary" disabled={!!busy} onClick={() => api && void perform("refresh", () => unwrap(api.refresh(selected.id)), updateTask)}><RefreshCw size={16} />{selected.status === "outcome_unknown" ? "核对原请求" : selected.status === "draft" ? "刷新报价" : "刷新进度"}</button>}
        {selected.canPreview && <button type="button" className="pv-secondary" disabled={!!busy} onClick={() => api && void perform("media", () => unwrap(api.media(selected.id)), data => setVideo(data.dataUrl))}>预览成片</button>}
        {video && <video controls preload="metadata" src={video} />}
        {selected.canExport && <button type="button" className="pv-primary" disabled={!!busy} onClick={() => api && void perform("export", () => unwrap(api.export(selected.id)), result => { if (result) setExportResult(`已导出：${result.path}${result.subtitlePath ? ` · 字幕：${result.subtitlePath}` : ""}`); })}><Download size={17} />导出成片</button>}
        {selected.canExportSource && <button type="button" className="pv-secondary" disabled={!!busy} onClick={() => api && void perform("source", () => unwrap(api.exportSource(selected.id)), result => { if (result) setExportResult(`已导出原片：${result.path}`); })}>导出480p母版</button>}
        {selected.canExport && <div className="pv-send-text"><strong>发给客户时可用</strong><p>{selected.plan.sendText}</p></div>}
        {exportResult && <p className="pv-note" role="status">{exportResult}</p>}
      </> : <div className="pv-empty"><p>从你的产品资料出发</p><ol><li>生成适用场景与不同机位的分镜</li><li>为每段准备独立首帧，生成原生音画</li><li>自动合成、对齐大字字幕并导出</li></ol><p>上传产品图，填写资料和费用上限后，先看方案。</p></div>}
    </section></div>
    {items.length > 0 && <section className="pv-history"><h2>制作记录</h2><div>{items.map(task => <button type="button" key={task.id} onClick={() => selectTask(task)}><span>{task.productName || task.plan.scene} · {task.durationSeconds}秒</span><small>{task.statusLabel}</small></button>)}</div></section>}
  </div>;
}
