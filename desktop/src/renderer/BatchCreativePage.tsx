import { useEffect, useRef, useState } from "react";
import { AssetPicker, AssetPreview, AssetThumb } from "./BatchAssets";
import { Asset, Batch, Candidate, Collection, Group, Groups, batchStatus, callBatch, groupNames, videoUrl } from "./batch-studio-api";
import "./BatchCreativePage.css";

type Props = { initial?: { assetIds?: string[]; collection?: Collection; batchId?: string }; onOpenProduct: () => void; onOpenLegacy: () => void; onOpenHistory: () => void; onOpenMaterials: () => void };
const emptyGroups = (): Groups => ({ opening: [], middle: [], ending: [] });
const activeStatuses = new Set(["queued", "analyzing", "rendering", "ready_for_review"]);
function batchLabel(b: Batch) {
  const date = new Date(b.created_at || b.updated_at);
  const when = Number.isNaN(date.getTime()) ? "日期未知" : date.toLocaleString("zh-CN", { hour12: false });
  return `${when} · #${b.batch_id.slice(-6).toUpperCase()} · ${b.title}`;
}


export function BatchCreativePage({ initial, onOpenProduct, onOpenLegacy, onOpenHistory, onOpenMaterials }: Props) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [groups, setGroups] = useState<Groups>(emptyGroups);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [cta, setCta] = useState("");
  const [count, setCount] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [settings, setSettings] = useState<Batch["settings"]>(() => {
    try { return { minimum_duration_seconds: 30, ...JSON.parse(localStorage.getItem("batch-studio-settings") || "{}") }; } catch { return { minimum_duration_seconds: 30 }; }
  });
  const [voices, setVoices] = useState<{ voicePersonaId: string; displayName: string; approvalStatus?: string }[]>([]);
  const [brands, setBrands] = useState<{ brandProfileId: string; name: string }[]>([]);
  const [picker, setPicker] = useState<Group | null>(null);
  const [preview, setPreview] = useState<Asset | null>(null);
  const [editing, setEditing] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const [recoveryNote, setRecoveryNote] = useState("");
  const [visibleCandidates, setVisibleCandidates] = useState(12);
  const manualCount = useRef(false);
  const selectedId = useRef<string | null>(null);
  const running = Boolean(batch?.task_id && activeStatuses.has(batch.task_status || ""));
  const paused = batch?.task_status === "paused";
  const locked = busy || running || paused;
  const total = new Set(Object.values(groups).flat()).size;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const elapsed = batch?.activity?.started_at ? Math.max(0, Math.floor(((running ? now : new Date(batch.updated_at).getTime()) - new Date(batch.activity.started_at).getTime()) / 1000)) : 0;

  async function refreshAssets() {
    const r = await window.xiaoxiContent?.library.list({ limit: 500 });
    if (!r?.ok) throw new Error(r?.error || "素材仓库尚未连接");
    setAssets(r.data?.items as Asset[] || []);
  }
  async function refreshBatches() { setBatches((await callBatch<{ batches: Batch[] }>("list")).batches); }
  function load(b: Batch) {
    selectedId.current = b.batch_id; setBatch(b); setGroups(b.groups); setTitle(b.title); setDescription(b.description); setCta(b.cta); setCollectionId(b.collection_id || ""); setSettings(b.settings || {});
    setCount(b.target_count ? String(b.target_count) : b.recommended_count ? String(b.recommended_count) : ""); manualCount.current = b.target_count != null; setDirty(false); setNotice("");
    setRecoveryChecked(false); setRecoveryNote("");
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setNotice("");
    try { await action(); } catch (e) { setNotice((e as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => {
    void run(async () => {
      await Promise.all([refreshAssets(), refreshBatches()]);
      setCollections((await callBatch<{ collections: Collection[] }>("collections")).collections);
      // Existing resource pickers retain ownership of audition/approval and licensing.
      const creative = (window.xiaoxiContent as unknown as { creative?: { listAutoMixVoicePersonas: () => Promise<{ data?: { items: typeof voices } }>; listBrandProfiles: () => Promise<{ data?: { items: typeof brands } }> } })?.creative;
      if (creative) {
        const results = await Promise.allSettled([creative.listAutoMixVoicePersonas(), creative.listBrandProfiles()]);
        if (results[0].status === "fulfilled") setVoices((results[0].value.data?.items || []).filter((v) => v.approvalStatus === "approved"));
        if (results[1].status === "fulfilled") setBrands(results[1].value.data?.items || []);
      }
      if (initial?.batchId) load(await callBatch<Batch>("get", { batch_id: initial.batchId }));
      else if (initial?.assetIds) { setGroups({ opening: [], middle: initial.assetIds, ending: [] }); setCollectionId(initial.collection?.collection_id || ""); setTitle(initial.collection?.name || ""); setDescription(initial.collection?.description || ""); setDirty(true); }
    });
  }, []);
  useEffect(() => {
    if (!batch?.batch_id || !running) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const id = batch.batch_id;
    let version = `${batch.updated_at}:${batch.task_status}:${batch.progress}`;
    async function poll() {
      try {
        const status = await callBatch<Pick<Batch, "updated_at" | "task_status" | "progress">>("status", { batch_id: id });
        const nextVersion = `${status.updated_at}:${status.task_status}:${status.progress}`;
        if (nextVersion === version) { if (!cancelled) timer = setTimeout(poll, 1800); return; }
        const b = await callBatch<Batch>("get", { batch_id: id });
        if (cancelled || selectedId.current !== id) return;
        version = `${b.updated_at}:${b.task_status}:${b.progress}`;
        setBatch(b);
        setSettings(b.settings || {});
        if (!manualCount.current && b.recommended_count > 0) setCount(String(b.recommended_count));
        if (!activeStatuses.has(b.task_status || "")) { await refreshBatches(); return; }
      } catch (e) { if (!cancelled) setNotice((e as Error).message); }
      if (!cancelled) timer = setTimeout(poll, 1800);
    }
    timer = setTimeout(poll, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [batch?.batch_id, running]);

  function changeGroups(next: Groups) { setGroups(next); setDirty(true); }
  function draft() {
    const target = count.trim() ? Number(count) : null;
    if (target !== null && (!Number.isInteger(target) || target < 1 || target > 300)) throw new Error("请填写 1 到 300 的整数。");
    return { ...(batch ? { batch_id: batch.batch_id } : {}), collection_id: collectionId || null, groups, title: title.trim() || "批量创作", description, cta, target_count: target, settings };
  }
  async function start(action: "recommend" | "samples" | "continue") {
    // The call consumes the trusted click immediately; saving the draft happens
    // in the main process before starting the task, without a renderer timer race.
    setSubmitting(true);
    try { await run(async () => {
      const payload = action === "continue" ? { batch_id: batch?.batch_id } : { draft: draft() };
      const b = await callBatch<Batch>(action, payload);
      selectedId.current = b.batch_id; setBatch(b); setDirty(false);
      localStorage.setItem("batch-studio-settings", JSON.stringify(settings));
      await refreshBatches();
    }); } finally { setSubmitting(false); }
  }
  async function recoverPlanning() {
    if (!batch) return;
    setSubmitting(true);
    try { await run(async () => {
      const b = await callBatch<Batch>("resolve", {
        batch_id: batch.batch_id,
        provider_log_checked: recoveryChecked,
        resolution: "retry_planning",
        note: recoveryNote.trim()
      });
      selectedId.current = b.batch_id; setBatch(b); setRecoveryChecked(false); setRecoveryNote("");
      await refreshBatches();
    }); } finally { setSubmitting(false); }
  }
  async function importTo(group: Group) {
    await run(async () => {
      const r = await window.xiaoxiContent?.library.chooseFiles();
      if (!r?.ok) { if (r?.code === "CONTENT_DIALOG_CANCELLED") return; throw new Error(r?.error || "导入失败"); }
      const ids = r.data?.items.map((a) => a.assetId) || [];
      changeGroups({ ...groups, [group]: [...new Set([...groups[group], ...ids])] }); await refreshAssets();
    });
  }
  const shownCandidates = (batch?.candidates || []).slice(0, batch?.target_count || batch?.recommended_count || 3);
  const completed = shownCandidates.filter((c) => c.status === "completed").length;
  return <div className="page batch-page">
    <header className="batch-page-header"><div><h1>批量创作</h1><p>选好素材，决定条数。先看样片，再继续整批。</p></div><button disabled={locked} onClick={() => { selectedId.current = null; setBatch(null); setGroups(emptyGroups()); setTitle(""); setDescription(""); setCta(""); setCount(""); setCollectionId(""); setDirty(false); manualCount.current = false; }}>新建批次</button></header>
    <div className="batch-toolbar"><label>当前批次<select aria-label="当前批次" value={batch?.batch_id || ""} disabled={busy} onChange={(e) => { if (e.target.value) void run(async () => load(await callBatch<Batch>("get", { batch_id: e.target.value }))); }}><option value="">新批次</option>{batches.map((b) => <option value={b.batch_id} key={b.batch_id}>{batchLabel(b)} · {batchStatus[b.status] || b.status} · {b.completed_count || 0}/{b.target_count || "—"}</option>)}</select></label>
      {batch && <button disabled={locked || batch.status === "outcome_unknown"} title="仅从批次列表移除，保留本地素材和成片" onClick={() => void run(async () => {
        await callBatch("archive", { batch_id: batch.batch_id });
        selectedId.current = null; setBatch(null); setGroups(emptyGroups()); setTitle(""); setDescription(""); setCta(""); setCount(""); setCollectionId(""); setDirty(false); manualCount.current = false;
        await refreshBatches(); setNotice("批次已从列表删除，本地素材和成片文件保留。");
      })}>删除当前批次</button>}
      <details className="batch-other"><summary>其他创作方式</summary><button onClick={onOpenProduct}>商品单片与声音／音乐资源</button><button onClick={onOpenLegacy}>课程与旧版工具</button><button onClick={onOpenHistory}>历史项目</button></details>
    </div>
    {notice && <p className="batch-notice" role="alert">{notice}</p>}
    {submitting && !batch && <section className="batch-progress" role="status">正在提交素材并启动任务…</section>}
    {batch && <section className="batch-progress" aria-live="polite"><strong>{submitting ? "正在提交任务" : running ? "正在处理" : batchStatus[batch.status] || "处理中"}</strong><span>已完成 {completed} / {batch.target_count || "待定"} 条</span>
      {(submitting || batch.activity) && <div className="batch-live-progress" role="status"><span>{submitting ? "正在保存素材与启动任务…" : batch.activity?.message}</span>
        {!submitting && !!batch.activity?.total && <><progress aria-label={batch.activity.message} value={batch.activity.completed || 0} max={batch.activity.total} /><span>{batch.activity.completed || 0}/{batch.activity.total}</span></>}
        {running && !batch.activity?.total && <progress aria-label="正在等待 AI 返回结果" />}
        {!submitting && batch.activity && <span>{running ? "已用时" : "用时"} {Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒{running ? " · 正在自动更新" : ""}</span>}
      </div>}
      {batch.status === "outcome_unknown" && batch.planning_recovery_available && <div className="batch-planning-recovery">
        <span>上次 AI 请求结果无法确认，系统没有自动重提。请先核对百炼服务记录。</span>
        <label><input type="checkbox" checked={recoveryChecked} onChange={(e) => setRecoveryChecked(e.target.checked)} />我已核对服务记录，确认可以重新发起规划</label>
        <input aria-label="本次核对依据" value={recoveryNote} maxLength={1000} onChange={(e) => setRecoveryNote(e.target.value)} placeholder="填写核对依据，例如：该时段没有成功返回记录" />
        <button type="button" data-batch-action="resolve" className="batch-primary" disabled={busy || submitting || !recoveryChecked || !recoveryNote.trim()} onClick={() => void recoverPlanning()}>已核对，重新规划</button>
      </div>}
      {batch.task_id && (running || paused) && batch.status !== "outcome_unknown" && <><button disabled={busy} onClick={() => void run(async () => {
        const action = paused ? "resume" : "pause";
        const r = await window.xiaoxiContent?.tasks[action]({ taskId: batch.task_id! });
        if (!r?.ok) throw new Error(r?.error); setBatch(await callBatch<Batch>("get", { batch_id: batch.batch_id }));
      })}>{paused ? "恢复任务" : "暂停"}</button><button disabled={busy} onClick={() => void run(async () => { const r = await window.xiaoxiContent?.tasks.cancel({ taskId: batch.task_id! }); if (!r?.ok) throw new Error(r?.error); setBatch(await callBatch<Batch>("get", { batch_id: batch.batch_id })); })}>取消本批任务</button></>}
      {completed > 0 && <button disabled={busy} onClick={() => void run(async () => { const r = await callBatch<{ canceled: boolean; filename: string; count: number; incomplete: boolean }>("export", { batch_id: batch.batch_id }); if (!r.canceled) setNotice(`已导出 ${r.count} 条至 ${r.filename}${r.incomplete ? "，部分文件不可用，请查看批次清单。" : "，包含视频、封面及发布文案。"}`); })}>导出已完成作品</button>}
    </section>}
    <details className="batch-source-details" open={!shownCandidates.length || dirty}>
    <summary>素材与生成设置 · {total} 个素材 · {count || "待推荐"} 条</summary>
    <fieldset disabled={locked} className="batch-form">
      <div className="batch-brief"><label>素材集<select value={collectionId} onChange={(e) => { const c = collections.find((s) => s.collection_id === e.target.value); setCollectionId(e.target.value); if (c) { setTitle(c.name); setDescription(c.description); changeGroups({ opening: [], middle: c.asset_ids, ending: [] }); } setDirty(true); }}><option value="">自由选材</option>{collections.map((c) => <option value={c.collection_id} key={c.collection_id}>{c.name}</option>)}</select></label><label className="batch-title-input">创作主题<input value={title} maxLength={100} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} placeholder="例如：展示产品的真实使用过程" /></label></div>
      <div className="batch-groups">{(Object.keys(groupNames) as Group[]).map((group) => <section className="batch-group" key={group} onDragOver={(e) => { if (!locked) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); if (locked) return; const id = e.dataTransfer.getData("application/x-xiaoxi-asset"); if (!assets.some((a) => a.assetId === id)) return; changeGroups(Object.fromEntries((Object.keys(groupNames) as Group[]).map((g) => [g, g === group ? [...new Set([...groups[g], id])] : groups[g].filter((v) => v !== id)])) as Groups); }}>
        <header><h2>{groupNames[group]}</h2><span>{groups[group].length} 个素材</span></header>
        <p>{group === "opening" ? "先吸引注意" : group === "middle" ? "展示过程与依据" : "收束内容，引导下一步"}</p>
        <div className="batch-group-assets">{groups[group].map((id) => {
          const a = assets.find((item) => item.assetId === id) || { assetId: id, displayName: "素材暂不可用", mediaKind: "video" as const };
          return <article className="batch-group-asset" key={id} draggable={!locked} onDragStart={(e) => e.dataTransfer.setData("application/x-xiaoxi-asset", id)}>
            <button type="button" className="batch-preview-button" onClick={() => setPreview(a)} aria-label={`预览 ${a.displayName}`}><AssetThumb asset={a} /></button><span title={a.displayName}>{a.displayName}</span>
            <div><select aria-label={`移动 ${a.displayName}`} value={group} onChange={(e) => { const target = e.target.value as Group; changeGroups({ ...groups, [group]: groups[group].filter((v) => v !== id), [target]: [...new Set([...groups[target], id])] }); }}>{(Object.keys(groupNames) as Group[]).map((g) => <option value={g} key={g}>{groupNames[g]}</option>)}</select><button type="button" aria-label={`移除 ${a.displayName}`} onClick={() => changeGroups({ ...groups, [group]: groups[group].filter((v) => v !== id) })}>移除</button></div>
          </article>;
        })}</div>
        {!groups[group].length && <div className="batch-group-empty">可留空，AI 会从其他素材中寻找合适镜头</div>}
        <footer><button onClick={() => void importTo(group)}>添加文件</button><button onClick={() => setPicker(group)}>从仓库选择</button></footer>
      </section>)}</div>
      <p className="batch-hint">已选 {total} 个素材。AI 按内容选择片段、安排顺序和时长，形成不同的完整作品。</p>
      <div className="batch-count-bar"><label>本批生成数量<input aria-label="本批生成数量" type="number" min={1} max={300} step={1} value={count} placeholder="AI 分析后推荐" onChange={(e) => { manualCount.current = true; setCount(e.target.value); setDirty(true); }} /></label><label>每条最短时长（秒）<input aria-label="每条最短时长" type="number" min={0} step={1} value={settings.minimum_duration_seconds || ""} placeholder="AI 决定" onChange={(e) => { setSettings({ ...settings, minimum_duration_seconds: Number(e.target.value) }); setDirty(true); }} /></label><button data-batch-action="recommend" disabled={!total} onClick={() => void start("recommend")}>AI 推荐数量</button><button data-batch-action="samples" className="batch-primary" disabled={!total} onClick={() => void start("samples")}>{batch?.status === "needs_attention" && !shownCandidates.length ? "重新分析并生成样片" : batch?.status === "needs_attention" || batch?.status === "completed_with_errors" ? "继续制作未完成作品" : "生成样片"}</button></div>
      <p className="batch-hint">每批最多 300 条，实际数量需通过素材检查。先做最多 3 条样片；只要 1、2 条时直接完成。按内容安排时长；填写最短时长后，会补足口播与相关镜头，不用静音或重复画面凑时长。</p>
      {batch && batch.feasible_count > 0 && <div className="batch-recommendation"><strong>建议生成 {batch.recommended_count} 条</strong><span>{batch.count_is_exact ? "可用方案" : "已找到可用方案"} {batch.feasible_count} 条。推荐值不是最大数量。</span><button disabled={!batch.recommended_count} onClick={() => { setCount(String(batch.recommended_count)); manualCount.current = false; setDirty(true); }}>一键采用推荐</button></div>}
      {batch?.status === "insufficient_materials" && <p className="batch-notice" role="status">素材已读取，但本次剪辑方案未通过检查，尚未开始制作。具体原因可在“项目详情”查看。</p>}
      {batch?.suggested_brief && <details className="batch-advanced"><summary>AI 从素材提取的主题与资料建议</summary><div className="batch-panel"><strong>{batch.suggested_brief.title}</strong><p>{batch.suggested_brief.description}</p><p>建议引导：{batch.suggested_brief.cta}</p><button onClick={() => {
        const suggestion = batch.suggested_brief!; setTitle(suggestion.title || title); setDescription(suggestion.description || description); setCta(suggestion.cta || cta); setDirty(true); setNotice("建议已填入主题资料，可继续修改；确认后再生成样片。");
      }}>采用建议，继续修改</button>{collectionId && <button onClick={() => void run(async () => {
        const collection = collections.find((c) => c.collection_id === collectionId); if (!collection) return;
        const updated = await callBatch<Collection>("save-collection", { ...collection, description: batch.suggested_brief!.description });
        setCollections(collections.map((c) => c.collection_id === updated.collection_id ? updated : c)); setNotice("AI 提取的资料已保存到素材集，可在素材仓库继续修改。");
      })}>将建议资料保存到素材集</button>}</div></details>}
      <details className="batch-advanced"><summary>主题资料、结尾引导与声音设置{dirty ? " · 有未保存修改" : ""}</summary><div className="batch-panel">
        <label>已确认事实与推广目标<textarea value={description} maxLength={6000} placeholder="填写产品资料、真实案例和推广目标；AI 解说只使用有依据的信息。" onChange={(e) => { setDescription(e.target.value); setDirty(true); }} /></label>
        <label>结尾引导<input value={cta} maxLength={300} placeholder="例如：私信了解适用方案" onChange={(e) => { setCta(e.target.value); setDirty(true); }} /></label>
        <div className="batch-brief"><label>AI 解说声音<select value={settings.voice_persona_id || ""} onChange={(e) => { setSettings({ ...settings, voice_persona_id: e.target.value || undefined }); setDirty(true); }}><option value="">自动选择已批准声音</option>{voices.map((v) => <option key={v.voicePersonaId} value={v.voicePersonaId}>{v.displayName || v.voicePersonaId}</option>)}</select></label><label>品牌<select value={settings.brand_profile_id || ""} onChange={(e) => { setSettings({ ...settings, brand_profile_id: e.target.value || undefined }); setDirty(true); }}><option value="">默认品牌</option>{brands.map((b) => <option key={b.brandProfileId} value={b.brandProfileId}>{b.name}</option>)}</select></label></div>
        <p>原视频声音静音，自动选用授权音乐。封面使用真实画面加标题。</p><button onClick={() => void run(async () => { const b = await callBatch<Batch>("save", draft()); load(b); localStorage.setItem("batch-studio-settings", JSON.stringify(settings)); await refreshBatches(); setNotice("批次草稿已保存。"); })}>保存草稿</button>
      </div></details>
    </fieldset>
    </details>
    {!!shownCandidates.length && <section className="batch-results"><header><div><h2>{batch?.approved || (batch?.target_count || 0) <= 3 ? "本批作品" : "样片与待制作方案"}</h2><p>已完成的作品可立即预览、调整和导出。</p></div>{batch?.status === "awaiting_confirmation" && <button className="batch-primary" data-batch-action="continue" disabled={locked || dirty} onClick={() => void start("continue")}>满意，继续整批（共 {batch.target_count} 条）</button>}</header>
      <div className="batch-result-grid">{shownCandidates.slice(0, visibleCandidates).map((c, index) => <article className="batch-result" key={c.candidate_id}>{c.generated_video_id ? <video controls preload="none" poster={videoUrl(c.generated_video_id, "thumbnail")} src={videoUrl(c.generated_video_id)} /> : <div className="batch-result-placeholder"><span>{String(index + 1).padStart(2, "0")}</span><p>{batchStatus[c.status] || "待制作"}</p></div>}<div className="batch-result-body"><h3>{c.title}</h3><p>{c.angle}</p><small>使用 {new Set((c.actual_shots || c.shots).map((s) => s.asset_id)).size} 个原素材 · {(c.actual_shots || c.shots).length} 个镜头 · {c.generated_video_id ? "成片" : "预计"} {((c.duration_ms || c.shots.reduce((n, s) => n + s.source_end_ms - s.source_start_ms, 0)) / 1000).toFixed(1)} 秒</small>{c.error && <p className="batch-notice">{c.error}</p>}<details open={!c.generated_video_id}><summary>完整口播与镜头安排</summary><p>{c.narration}</p><ol>{(c.actual_shots || c.shots).map((s) => <li key={s.segment_id}>{s.description}（{(s.source_start_ms / 1000).toFixed(1)}–{(s.source_end_ms / 1000).toFixed(1)} 秒）</li>)}</ol></details><button disabled={locked} onClick={() => setEditing(c)}>调整这一条</button>{c.generated_video_id && <button onClick={() => void run(async () => {
          const creative = (window.xiaoxiContent as unknown as { creative: { downloadCandidate: (p: { candidateId: string }) => Promise<{ ok: boolean; error?: string }> } }).creative;
          const r = await creative.downloadCandidate({ candidateId: c.generated_video_id! }); if (!r.ok) throw new Error(r.error);
        })}>导出视频</button>}</div></article>)}</div>{shownCandidates.length > visibleCandidates && <button onClick={() => setVisibleCandidates(visibleCandidates + 12)}>显示更多作品</button>}
    </section>}
    {batch && <details className="batch-advanced"><summary>项目详情</summary><p>流程：理解素材 → 规划与筛选 → 数量校验 → 样片 → 批量制作</p><p>任务状态：{batch.task_status || "尚未开始"}；已保存方案 {batch.candidates.length} 条。</p><p>数量来自有界搜索；未遍历全部空间时，不代表素材的绝对容量。</p>{batch.reasons?.map((reason, i) => <p key={i}>{reason}</p>)}</details>}
    {!total && <button className="batch-text-button" onClick={onOpenMaterials}>前往素材仓库整理素材集 →</button>}
    {picker && <AssetPicker assets={assets} selected={groups[picker]} onChange={(ids) => changeGroups({ ...groups, [picker]: ids })} onClose={() => setPicker(null)} />}
    {preview && <AssetPreview asset={preview} onClose={() => setPreview(null)} />}
    {!!batch?.available_shots.length && <button disabled={locked || dirty} onClick={() => setEditing({ candidate_id: "", title: "", narration: "", angle: "", status: "needs_review", shots: [], revision: 1 })}>添加脚本</button>}
    {editing && batch && <CandidateEditor candidate={editing} batch={batch} onClose={() => setEditing(null)} onSaved={(b) => { setBatch(b); setEditing(null); setNotice("脚本草稿已保存。点击生成样片后先检查内容，再配音和制作。"); }} />}
  </div>;
}

function CandidateEditor({ candidate, batch, onClose, onSaved }: { candidate: Candidate; batch: Batch; onClose: () => void; onSaved: (b: Batch) => void }) {
  const [title, setTitle] = useState(candidate.title);
  const [narration, setNarration] = useState(() => {
    const paragraphs = candidate.phrases?.map((phrase) => phrase.text).join("\n") || "";
    return paragraphs.replace(/\s/g, "") === candidate.narration.replace(/\s/g, "") ? paragraphs : candidate.narration;
  });
  const [shots, setShots] = useState(candidate.shots.map((s) => s.segment_id));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <div className="batch-modal-backdrop"><section className="batch-modal" role="dialog" aria-modal="true" aria-label="调整这一条"><header><h2>调整这一条</h2><button disabled={busy} onClick={onClose}>关闭</button></header><label>标题<input autoFocus value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} /></label><label>AI 解说<textarea value={narration} maxLength={2400} onChange={(e) => setNarration(e.target.value)} /></label><p>按内容换行分段，每段最多80字。镜头按顺序承接各段，程序计算时长；制作前检查事实、声画匹配和差异。</p><h3>镜头顺序</h3>{shots.map((id, index) => <div className="batch-toolbar" key={index}><select aria-label={`镜头 ${index + 1}`} value={id} onChange={(e) => setShots(shots.map((s, i) => i === index ? e.target.value : s))}>{batch.available_shots.map((s) => <option key={s.segment_id} value={s.segment_id}>{s.description} · {(s.source_start_ms / 1000).toFixed(1)}–{(s.source_end_ms / 1000).toFixed(1)} 秒</option>)}</select><button disabled={index === 0} onClick={() => { const next = [...shots]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; setShots(next); }}>上移</button><button disabled={shots.length <= 1} onClick={() => setShots(shots.filter((_, i) => i !== index))}>移除</button></div>)}<button disabled={shots.length >= 40 || !batch.available_shots.some((s) => !shots.includes(s.segment_id))} onClick={() => { const next = batch.available_shots.find((s) => !shots.includes(s.segment_id)); if (next) setShots([...shots, next.segment_id]); }}>添加镜头</button>{error && <p role="alert">{error}</p>}<footer><button className="batch-primary" disabled={busy || !title.trim() || !narration.trim()} onClick={async () => { setBusy(true); try { onSaved(await callBatch<Batch>("edit", { batch_id: batch.batch_id, candidate_id: candidate.candidate_id, title, narration, shots })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>保存本条修改</button></footer></section></div>;
}

export function BatchFinishedOverview({ onOpen }: { onOpen: (batchId: string) => void }) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [notice, setNotice] = useState("");
  useEffect(() => { void callBatch<{ batches: Batch[] }>("list").then((r) => setBatches(r.batches)).catch((e) => setNotice(e.message)); }, []);
  return <section className="batch-finished-overview"><h2>按批次管理</h2>{notice && <p>{notice}</p>}<div className="batch-history-list">{batches.filter((b) => (b.completed_count || 0) > 0).map((b) => <article key={b.batch_id}><div><strong>{batchLabel(b)}</strong><p>{b.completed_count} / {b.target_count} 条 · {batchStatus[b.status] || b.status}</p></div><button onClick={() => onOpen(b.batch_id)}>预览与导出批次</button></article>)}</div>{!batches.some((b) => (b.completed_count || 0) > 0) && <p>完成样片后，批次会显示在这里。</p>}</section>;
}
