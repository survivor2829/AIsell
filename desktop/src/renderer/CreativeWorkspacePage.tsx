import {
  Check,
  CircleAlert,
  Clapperboard,
  FolderOpen,
  Layers3,
  LoaderCircle,
  RefreshCw,
  Save,
  Sparkles,
  ThumbsDown,
  ThumbsUp
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import "./CreativeWorkspacePage.css";

type ContentResult<T> = { ok: boolean; data?: T; code?: string; error?: string };
type EngineStatus = { state: string; available: boolean; version: string; capabilities: Record<string, boolean>; code: string };
type Asset = {
  assetId: string;
  displayName: string;
  mediaKind: "video" | "image";
  durationMs: number | null;
  archived: boolean;
  availableLocationCount: number;
};
type SlotDraft = {
  clientKey: string;
  name: string;
  required: boolean;
  targetDurationSeconds: number;
  assetIds: string[];
  fixedAssetId: string;
};
type MixConstraints = {
  allowRepeatedAssets: boolean;
  minDurationMs?: number | null;
  maxDurationMs?: number | null;
  scoreWeights: { durationFit: number; diversity: number; freshness: number };
};
type MixSlot = {
  slotId?: string;
  name: string;
  required: boolean;
  assetIds: string[];
  fixedAssetId?: string | null;
  minDurationMs?: number | null;
  maxDurationMs?: number | null;
  targetDurationMs?: number | null;
};
type MixProject = {
  projectId: string;
  name: string;
  slots: MixSlot[];
  constraints: MixConstraints;
  updatedAt: string;
};
type CombinationCounts = { rawCartesianCount: number; combinationCount: number | null; countIsExact: boolean; countStatus: string };
type Candidate = {
  candidateId: string;
  projectId: string;
  seed: string;
  selections: Array<{ slotId: string; slotName: string; assetId: string | null; omitted: boolean }>;
  durationMs: number;
  score: { total?: number; explanations?: string[] };
  reviewStatus: "pending" | "approved" | "rejected";
  reviewNote: string | null;
};
type PublishStatus = "queued" | "processing" | "exported" | "published" | "failed" | "cancelled";
type ExportPlatform = "wechat" | "douyin" | "kuaishou";
type QueueItem = {
  queueItemId: string;
  candidateId: string;
  projectId: string;
  status: PublishStatus;
  errorMessage: string | null;
  updatedAt: string;
};
type ExportPackage = {
  packageId: string;
  candidateId: string;
  queueItemId: string;
  platforms: ExportPlatform[];
  outputs: Record<string, string>;
  coverName: string;
  manifestName: string;
  createdAt: string;
};
type MixApi = {
  status: () => Promise<ContentResult<EngineStatus>>;
  library: { list: (payload?: { includeArchived?: boolean; limit?: number }) => Promise<ContentResult<{ items: Asset[] }>> };
  mix: {
    createProject: (payload: { name: string; slots: MixSlot[]; constraints: MixConstraints }) => Promise<ContentResult<MixProject>>;
    updateProject: (payload: { projectId: string; name: string; slots: MixSlot[]; constraints: MixConstraints }) => Promise<ContentResult<MixProject>>;
    getProject: (payload: { projectId: string }) => Promise<ContentResult<MixProject>>;
    listProjects: (payload?: { limit?: number }) => Promise<ContentResult<{ items: MixProject[] }>>;
    calculateCombinations: (payload: { projectId: string }) => Promise<ContentResult<CombinationCounts>>;
    generateCandidates: (payload: { projectId: string; limit: number; seed: string }) => Promise<ContentResult<{ items: Candidate[] }>>;
    listCandidates: (payload?: { projectId?: string; reviewStatus?: string; limit?: number }) => Promise<ContentResult<{ items: Candidate[] }>>;
    reviewCandidate: (payload: { candidateId: string; reviewStatus: "approved" | "rejected"; reviewNote?: string }) => Promise<ContentResult<Candidate>>;
  };
  publishQueue: {
    list: (payload?: { status?: string; limit?: number }) => Promise<ContentResult<{ items: QueueItem[] }>>;
    update: (payload: { queueItemId: string; status: string; errorMessage?: string }) => Promise<ContentResult<QueueItem>>;
  };
  exportPackages: {
    render: (payload: { candidateId: string; platforms?: string[] }) => Promise<ContentResult<ExportPackage>>;
    list: (payload?: { candidateId?: string; limit?: number }) => Promise<ContentResult<{ items: ExportPackage[] }>>;
    open: (payload: { packageId: string }) => Promise<ContentResult<{ packageId: string }>>;
    reveal: (payload: { packageId: string }) => Promise<ContentResult<{ packageId: string }>>;
  };
};

const DEFAULT_SLOTS: SlotDraft[] = [
  { clientKey: "default-hook", name: "开头钩子", required: true, targetDurationSeconds: 3, assetIds: [], fixedAssetId: "" },
  { clientKey: "default-body", name: "主体信息", required: true, targetDurationSeconds: 8, assetIds: [], fixedAssetId: "" },
  { clientKey: "default-proof", name: "产品证据", required: true, targetDurationSeconds: 6, assetIds: [], fixedAssetId: "" },
  { clientKey: "default-cta", name: "结尾引导", required: true, targetDurationSeconds: 4, assetIds: [], fixedAssetId: "" }
];
const DEFAULT_WEIGHTS = { durationFit: 0.5, diversity: 0.3, freshness: 0.2 };

function apiForWindow() {
  return (window as unknown as { xiaoxiContent?: MixApi }).xiaoxiContent;
}

function durationText(milliseconds: number | null | undefined) {
  if (!milliseconds) return "静态素材";
  return `${(milliseconds / 1000).toFixed(milliseconds >= 10000 ? 0 : 1)} 秒`;
}

function errorMessage(result: ContentResult<unknown>, fallback: string) {
  return result.error || result.code || fallback;
}

function rangeFromTarget(seconds: number, spread: number) {
  const target = Math.max(0, Number(seconds) || 0) * 1000;
  if (!target) return { minDurationMs: null, maxDurationMs: null };
  return {
    minDurationMs: Math.round(target * (1 - spread)),
    maxDurationMs: Math.round(target * (1 + spread))
  };
}

function draftFromProject(project: MixProject) {
  return project.slots.map((slot, index) => ({
    clientKey: slot.slotId || `${project.projectId}-${index}`,
    name: slot.name,
    required: slot.required,
    targetDurationSeconds: (slot.targetDurationMs || 0) / 1000,
    assetIds: slot.assetIds || [],
    fixedAssetId: slot.fixedAssetId || ""
  }));
}

const QUEUE_STATUS_LABELS: Record<PublishStatus, string> = {
  queued: "等待生成",
  processing: "正在生成",
  exported: "成片包已就绪",
  published: "已发布",
  failed: "生成失败",
  cancelled: "已取消"
};

const QUEUE_STATUS_DETAILS: Record<PublishStatus, string> = {
  queued: "待生成成片包",
  processing: "正在生成成片包",
  exported: "仅本地导出，未发布",
  published: "已发布",
  failed: "生成失败，可重试",
  cancelled: "已取消"
};

export function CreativeWorkspacePage() {
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [projects, setProjects] = useState<MixProject[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [exportPackages, setExportPackages] = useState<ExportPackage[]>([]);
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("新品推广混剪");
  const [slots, setSlots] = useState<SlotDraft[]>(DEFAULT_SLOTS);
  const [allowRepeatedAssets, setAllowRepeatedAssets] = useState(false);
  const [totalDurationSeconds, setTotalDurationSeconds] = useState(21);
  const [outputCount, setOutputCount] = useState(10);
  const [seed, setSeed] = useState("launch-01");
  const [scoreWeights, setScoreWeights] = useState(DEFAULT_WEIGHTS);
  const [counts, setCounts] = useState<CombinationCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState("");
  const [reviewingId, setReviewingId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeView, setActiveView] = useState<"candidates" | "queue">("candidates");

  const availableAssets = useMemo(
    () => assets.filter((item) => !item.archived && item.availableLocationCount > 0),
    [assets]
  );
  const assetNames = useMemo(
    () => new Map(assets.map((item) => [item.assetId, item.displayName])),
    [assets]
  );
  const apiAvailable = Boolean(apiForWindow()?.mix && apiForWindow()?.publishQueue && apiForWindow()?.exportPackages);
  const controlsDisabled = loading || Boolean(busyAction) || engine?.state !== "ready";

  const loadWorkspace = useCallback(async (preferredProjectId?: string) => {
    const api = apiForWindow();
    if (!api?.mix || !api.publishQueue || !api.exportPackages) {
      setLoading(false);
      setError("当前桌面组件未提供智能混剪能力，请更新并重启应用。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [statusResult, assetsResult, projectsResult, candidatesResult, queueResult, packagesResult] = await Promise.all([
        api.status(),
        api.library.list({ includeArchived: false, limit: 500 }),
        api.mix.listProjects({ limit: 500 }),
        api.mix.listCandidates({ limit: 500 }),
        api.publishQueue.list({ limit: 500 }),
        api.exportPackages.list({ limit: 500 })
      ]);
      const failure = [statusResult, assetsResult, projectsResult, candidatesResult, queueResult, packagesResult].find((result) => !result.ok);
      if (failure) throw new Error(errorMessage(failure, "工作台数据加载失败"));
      setEngine(statusResult.data || null);
      setAssets(assetsResult.data?.items || []);
      setProjects(projectsResult.data?.items || []);
      setCandidates(candidatesResult.data?.items || []);
      setQueue(queueResult.data?.items || []);
      setExportPackages(packagesResult.data?.items || []);
      const selected = preferredProjectId || projectId;
      if (selected) {
        const current = projectsResult.data?.items.find((item) => item.projectId === selected);
        if (current) setProjectId(current.projectId);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "工作台数据加载失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadWorkspace();
  }, []); // Initial desktop bridge snapshot only.

  function updateSlot(index: number, changes: Partial<SlotDraft>) {
    setSlots((current) => current.map((slot, slotIndex) => slotIndex === index ? { ...slot, ...changes } : slot));
    setCounts(null);
  }

  function toggleAsset(index: number, assetId: string) {
    const slot = slots[index];
    const selected = slot.assetIds.includes(assetId);
    const assetIds = selected ? slot.assetIds.filter((id) => id !== assetId) : [...slot.assetIds, assetId];
    updateSlot(index, { assetIds, fixedAssetId: selected && slot.fixedAssetId === assetId ? "" : slot.fixedAssetId });
  }

  function projectPayload() {
    const totalRange = rangeFromTarget(totalDurationSeconds, 0.2);
    return {
      name: projectName.trim(),
      slots: slots.map((slot) => ({
        name: slot.name.trim(),
        required: slot.required,
        assetIds: slot.assetIds,
        fixedAssetId: slot.fixedAssetId || null,
        targetDurationMs: slot.targetDurationSeconds > 0
          ? Math.round(slot.targetDurationSeconds * 1000)
          : null
      })),
      constraints: {
        allowRepeatedAssets,
        ...totalRange,
        scoreWeights
      }
    };
  }

  async function saveProject() {
    const api = apiForWindow();
    if (!api) return;
    if (!projectName.trim()) {
      setError("请填写项目名称。");
      return;
    }
    const incomplete = slots.find((slot) => !slot.name.trim() || (slot.required && !slot.assetIds.length && !slot.fixedAssetId));
    if (incomplete) {
      setError(`“${incomplete.name || "未命名槽位"}”是必选槽位，请至少勾选一个素材。`);
      return;
    }
    setBusyAction("save");
    setError("");
    setNotice("");
    try {
      const payload = projectPayload();
      const result = projectId
        ? await api.mix.updateProject({ projectId, ...payload })
        : await api.mix.createProject(payload);
      if (!result.ok || !result.data) throw new Error(errorMessage(result, "项目保存失败"));
      setProjectId(result.data.projectId);
      const combinationResult = await api.mix.calculateCombinations({ projectId: result.data.projectId });
      if (!combinationResult.ok || !combinationResult.data) throw new Error(errorMessage(combinationResult, "组合数计算失败"));
      setCounts(combinationResult.data);
      setNotice("项目已保存，组合空间已重新计算。");
      await loadWorkspace(result.data.projectId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "项目保存失败");
    } finally {
      setBusyAction("");
    }
  }

  async function selectProject(nextProjectId: string) {
    setProjectId(nextProjectId);
    setCounts(null);
    setError("");
    if (!nextProjectId) {
      setProjectName("新品推广混剪");
      setSlots(DEFAULT_SLOTS);
      setAllowRepeatedAssets(false);
      setTotalDurationSeconds(21);
      setScoreWeights(DEFAULT_WEIGHTS);
      return;
    }
    const api = apiForWindow();
    if (!api) return;
    setBusyAction("project");
    try {
      const [projectResult, countResult] = await Promise.all([
        api.mix.getProject({ projectId: nextProjectId }),
        api.mix.calculateCombinations({ projectId: nextProjectId })
      ]);
      if (!projectResult.ok || !projectResult.data) throw new Error(errorMessage(projectResult, "项目读取失败"));
      const project = projectResult.data;
      setProjectName(project.name);
      setSlots(draftFromProject(project));
      setAllowRepeatedAssets(project.constraints.allowRepeatedAssets);
      setTotalDurationSeconds(Math.round((((project.constraints.minDurationMs || 0) + (project.constraints.maxDurationMs || 0)) / 2) / 100) / 10);
      setScoreWeights(project.constraints.scoreWeights || DEFAULT_WEIGHTS);
      if (countResult.ok && countResult.data) setCounts(countResult.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "项目读取失败");
    } finally {
      setBusyAction("");
    }
  }

  async function generateCandidates() {
    const api = apiForWindow();
    if (!api || !projectId) {
      setError("请先保存项目，再生成候选。");
      return;
    }
    setBusyAction("generate");
    setError("");
    setNotice("");
    try {
      const result = await api.mix.generateCandidates({ projectId, limit: outputCount, seed });
      if (!result.ok) throw new Error(errorMessage(result, "候选生成失败"));
      const listResult = await api.mix.listCandidates({ projectId, limit: 500 });
      if (!listResult.ok) throw new Error(errorMessage(listResult, "候选列表刷新失败"));
      setCandidates((current) => [
        ...(listResult.data?.items || []),
        ...current.filter((item) => item.projectId !== projectId)
      ]);
      setActiveView("candidates");
      setNotice(`候选已生成，共返回 ${result.data?.items.length || 0} 条。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "候选生成失败");
    } finally {
      setBusyAction("");
    }
  }

  async function reviewCandidate(candidateId: string, reviewStatus: "approved" | "rejected") {
    const api = apiForWindow();
    if (!api) return;
    setReviewingId(candidateId);
    setError("");
    try {
      const result = await api.mix.reviewCandidate({ candidateId, reviewStatus });
      if (!result.ok || !result.data) throw new Error(errorMessage(result, "候选审核失败"));
      setCandidates((current) => current.map((item) => item.candidateId === candidateId ? result.data! : item));
      if (reviewStatus === "approved") {
        const queueResult = await api.publishQueue.list({ limit: 500 });
        if (!queueResult.ok) throw new Error(errorMessage(queueResult, "发布队列刷新失败"));
        setQueue(queueResult.data?.items || []);
        setActiveView("queue");
        setNotice("候选已批准并进入发布队列。");
      } else {
        setNotice("候选已淘汰。");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "候选审核失败");
    } finally {
      setReviewingId("");
    }
  }

  async function cancelQueueItem(queueItemId: string) {
    const api = apiForWindow();
    if (!api) return;
    setBusyAction(`queue-${queueItemId}`);
    setError("");
    try {
      const result = await api.publishQueue.update({ queueItemId, status: "cancelled" });
      if (!result.ok || !result.data) throw new Error(errorMessage(result, "队列更新失败"));
      setQueue((current) => current.map((item) => item.queueItemId === queueItemId ? result.data! : item));
      setNotice("已取消该待处理项目。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "队列更新失败");
    } finally {
      setBusyAction("");
    }
  }

  async function renderQueueItem(item: QueueItem) {
    const api = apiForWindow();
    if (!api?.exportPackages) return;
    setBusyAction(`render-${item.queueItemId}`);
    setError("");
    setNotice("");
    try {
      const result = await api.exportPackages.render({
        candidateId: item.candidateId,
        platforms: ["wechat", "douyin", "kuaishou"]
      });
      if (!result.ok || !result.data) throw new Error(errorMessage(result, "成片包生成失败"));
      const [queueResult, packagesResult] = await Promise.all([
        api.publishQueue.list({ limit: 500 }),
        api.exportPackages.list({ limit: 500 })
      ]);
      if (!queueResult.ok || !packagesResult.ok) throw new Error("成片包已生成，但列表刷新失败");
      setQueue(queueResult.data?.items || []);
      setExportPackages(packagesResult.data?.items || []);
      setNotice("多平台成片包已生成到本机；不会自动发布。请先检查内容。 ");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "成片包生成失败");
      const queueResult = await api.publishQueue.list({ limit: 500 });
      if (queueResult.ok) setQueue(queueResult.data?.items || []);
    } finally {
      setBusyAction("");
    }
  }

  async function accessExportPackage(packageId: string, action: "open" | "reveal") {
    const api = apiForWindow();
    if (!api?.exportPackages) return;
    setBusyAction(`${action}-${packageId}`);
    setError("");
    try {
      const result = await api.exportPackages[action]({ packageId });
      if (!result.ok) throw new Error(errorMessage(result, "无法访问成片包"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法访问成片包");
    } finally {
      setBusyAction("");
    }
  }

  const visibleCandidates = candidates.filter((item) => !projectId || item.projectId === projectId);
  const visibleQueue = queue.filter((item) => !projectId || item.projectId === projectId);
  const packagesByQueue = useMemo(() => {
    const grouped = new Map<string, ExportPackage[]>();
    for (const item of exportPackages) {
      const group = grouped.get(item.queueItemId);
      if (group) group.push(item);
      else grouped.set(item.queueItemId, [item]);
    }
    return grouped;
  }, [exportPackages]);

  return (
    <section className="page creative-workspace-page">
      <div className="page-head workspace-page-head">
        <div>
          <span className="workspace-eyebrow">内容引擎 · 智能混剪</span>
          <h1>创作工作台</h1>
          <p>用真实素材配置镜头槽位、审核候选，并在本机生成微信、抖音、快手成片包。</p>
        </div>
        <div className={`workspace-engine-badge is-${engine?.state || "unknown"}`}>
          {loading ? <LoaderCircle size={15} className="is-spinning" /> : <span />}
          {engine?.state === "ready" ? `引擎就绪 ${engine.version || ""}` : engine?.state === "failed" ? "引擎异常" : "引擎不可用"}
        </div>
      </div>

      {!apiAvailable && !loading && <div className="workspace-banner is-error"><CircleAlert size={18} />桌面组件不可用，请更新应用后重试。</div>}
      {apiAvailable && !loading && engine?.state !== "ready" && <div className="workspace-banner is-error"><CircleAlert size={18} />内容引擎当前未就绪（{engine?.code || engine?.state || "状态未知"}），配置已锁定，请刷新或重启应用后重试。</div>}
      {error && <div className="workspace-banner is-error"><CircleAlert size={18} />{error}</div>}
      {notice && <div className="workspace-banner is-success"><Check size={18} />{notice}</div>}
      {loading ? (
        <div className="workspace-loading"><LoaderCircle className="is-spinning" />正在加载素材、项目和审核队列…</div>
      ) : (
        <>
          <section className="workspace-panel workspace-project-bar">
            <div>
              <label htmlFor="mix-project-select">已有项目</label>
              <select id="mix-project-select" value={projectId} onChange={(event) => void selectProject(event.target.value)} disabled={Boolean(busyAction)}>
                <option value="">新建混剪项目</option>
                {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}
              </select>
            </div>
            <button className="workspace-button is-secondary" onClick={() => void loadWorkspace(projectId)} disabled={Boolean(busyAction)}>
              <RefreshCw size={16} />刷新数据
            </button>
          </section>

          <div className="workspace-editor-layout">
            <main className="workspace-main-column">
              <section className="workspace-panel">
                <div className="workspace-section-head">
                  <div><span>01</span><h2>项目与镜头槽位</h2></div>
                  <small>{availableAssets.length} 个可用素材</small>
                </div>
                <label className="workspace-field workspace-project-name">
                  <span>项目名称</span>
                  <input value={projectName} onChange={(event) => setProjectName(event.target.value)} maxLength={200} disabled={controlsDisabled} />
                </label>

                {!availableAssets.length ? (
                  <div className="workspace-empty"><Layers3 size={28} /><strong>素材库还没有可用素材</strong><p>请先到“素材与成片”登记本机素材，确认文件仍可访问后再配置槽位。</p></div>
                ) : (
                  <div className="workspace-slot-grid">
                    {slots.map((slot, index) => (
                      <article className="workspace-slot-card" key={slot.clientKey}>
                        <div className="workspace-slot-title">
                          <span>{String(index + 1).padStart(2, "0")}</span>
                          <input aria-label={`槽位 ${index + 1} 名称`} value={slot.name} onChange={(event) => updateSlot(index, { name: event.target.value })} disabled={controlsDisabled} />
                        </div>
                        <div className="workspace-slot-options">
                          <label><input type="checkbox" checked={slot.required} onChange={(event) => updateSlot(index, { required: event.target.checked })} disabled={controlsDisabled} /> 必选槽位</label>
                          <label>目标时长 <input type="number" min="0" max="3600" step="0.5" value={slot.targetDurationSeconds} onChange={(event) => updateSlot(index, { targetDurationSeconds: Number(event.target.value) })} disabled={controlsDisabled} /> 秒</label>
                        </div>
                        <div className="workspace-asset-list">
                          {availableAssets.map((asset) => (
                            <label className={slot.assetIds.includes(asset.assetId) ? "is-selected" : ""} key={asset.assetId}>
                              <input type="checkbox" checked={slot.assetIds.includes(asset.assetId)} onChange={() => toggleAsset(index, asset.assetId)} disabled={controlsDisabled} />
                              <span><strong>{asset.displayName}</strong><small>{asset.mediaKind === "video" ? "视频" : "图片"} · {durationText(asset.durationMs)}</small></span>
                            </label>
                          ))}
                        </div>
                        <label className="workspace-field">
                          <span>固定素材（可选）</span>
                          <select value={slot.fixedAssetId} onChange={(event) => updateSlot(index, { fixedAssetId: event.target.value, assetIds: event.target.value && !slot.assetIds.includes(event.target.value) ? [...slot.assetIds, event.target.value] : slot.assetIds })} disabled={controlsDisabled}>
                            <option value="">不固定，参与组合</option>
                            {availableAssets.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.displayName}</option>)}
                          </select>
                        </label>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              <section className="workspace-panel">
                <div className="workspace-section-head"><div><span>02</span><h2>候选与发布队列</h2></div></div>
                <div className="workspace-tabs">
                  <button className={activeView === "candidates" ? "is-active" : ""} onClick={() => setActiveView("candidates")}>候选方案 <span>{visibleCandidates.length}</span></button>
                  <button className={activeView === "queue" ? "is-active" : ""} onClick={() => setActiveView("queue")}>发布队列 <span>{visibleQueue.length}</span></button>
                </div>
                {activeView === "candidates" ? (
                  visibleCandidates.length ? <div className="workspace-candidate-list">
                    {visibleCandidates.map((candidate, index) => (
                      <article className="workspace-candidate-card" key={candidate.candidateId}>
                        <div className="workspace-candidate-head">
                          <div><span>方案 {String(index + 1).padStart(2, "0")}</span><strong>{durationText(candidate.durationMs)}</strong></div>
                          <b>{Number(candidate.score?.total || 0).toFixed(1)} 分</b>
                        </div>
                        <div className="workspace-selection-list">
                          {candidate.selections.map((selection) => <div key={selection.slotId}><span>{selection.slotName}</span><strong>{selection.omitted ? "已跳过" : assetNames.get(selection.assetId || "") || "素材已不可用"}</strong></div>)}
                        </div>
                        <div className="workspace-explanations">
                          {(candidate.score?.explanations || ["暂无评分解释"]).map((item) => <span key={item}>{item}</span>)}
                        </div>
                        <div className="workspace-candidate-actions">
                          <span className={`workspace-review-status is-${candidate.reviewStatus}`}>{candidate.reviewStatus === "approved" ? "已批准" : candidate.reviewStatus === "rejected" ? "已淘汰" : "待审核"}</span>
                          <button onClick={() => void reviewCandidate(candidate.candidateId, "rejected")} disabled={Boolean(reviewingId) || candidate.reviewStatus === "rejected"}><ThumbsDown size={15} />淘汰</button>
                          <button className="is-primary" onClick={() => void reviewCandidate(candidate.candidateId, "approved")} disabled={Boolean(reviewingId) || candidate.reviewStatus === "approved"}>{reviewingId === candidate.candidateId ? <LoaderCircle size={15} className="is-spinning" /> : <ThumbsUp size={15} />}批准</button>
                        </div>
                      </article>
                    ))}
                  </div> : <div className="workspace-empty"><Sparkles size={28} /><strong>还没有候选方案</strong><p>{projectId ? "保存最新配置后点击“生成候选”。" : "先保存一个项目，系统才会计算并生成真实组合。"}</p></div>
                ) : (
                  visibleQueue.length ? <div className="workspace-queue-list">
                    {visibleQueue.map((item) => {
                      const packages = packagesByQueue.get(item.queueItemId) || [];
                      return <article key={item.queueItemId}><Clapperboard size={20} /><div><strong>{projects.find((project) => project.projectId === item.projectId)?.name || "混剪项目"}</strong><span>候选 {item.candidateId.slice(-8)} · {QUEUE_STATUS_LABELS[item.status]}</span>{item.errorMessage && <small>{item.errorMessage}</small>}{packages.map((exportPackage) => <div className="workspace-export-package" key={exportPackage.packageId}><span>{exportPackage.platforms.join(" / ")} · {exportPackage.packageId.slice(-8)}</span><button onClick={() => void accessExportPackage(exportPackage.packageId, "open")} disabled={Boolean(busyAction)}><FolderOpen size={14} />打开</button><button onClick={() => void accessExportPackage(exportPackage.packageId, "reveal")} disabled={Boolean(busyAction)}>定位</button></div>)}</div><div className="workspace-queue-state"><b>{QUEUE_STATUS_DETAILS[item.status]}</b>{(item.status === "queued" || item.status === "failed") && <button className="is-primary" onClick={() => void renderQueueItem(item)} disabled={Boolean(busyAction) || engine?.capabilities.mix_render !== true}>{busyAction === `render-${item.queueItemId}` ? <LoaderCircle size={14} className="is-spinning" /> : null}{item.status === "failed" ? "重试" : "生成成片包"}</button>}{item.status === "queued" && <button onClick={() => void cancelQueueItem(item.queueItemId)} disabled={Boolean(busyAction)}>取消排队</button>}</div></article>;
                    })}
                  </div> : <div className="workspace-empty"><Clapperboard size={28} /><strong>发布队列为空</strong><p>批准候选后会自动进入这里。当前仅排队，不会声称已经渲染成片。</p></div>
                )}
              </section>
            </main>

            <aside className="workspace-panel workspace-settings-panel">
              <div className="workspace-section-head"><div><span>配置</span><h2>生成约束</h2></div></div>
              <label className="workspace-switch"><span><strong>允许素材重复</strong><small>同一候选可跨槽位复用</small></span><input type="checkbox" checked={allowRepeatedAssets} onChange={(event) => { setAllowRepeatedAssets(event.target.checked); setCounts(null); }} disabled={controlsDisabled} /></label>
              <label className="workspace-field"><span>总目标时长（秒）</span><input type="number" min="0" max="7200" value={totalDurationSeconds} onChange={(event) => { setTotalDurationSeconds(Number(event.target.value)); setCounts(null); }} disabled={controlsDisabled} /></label>
              <label className="workspace-field"><span>输出数量</span><input type="number" min="1" max="500" value={outputCount} onChange={(event) => setOutputCount(Math.min(500, Math.max(1, Number(event.target.value))))} disabled={controlsDisabled} /></label>
              <label className="workspace-field"><span>随机种子 seed</span><input value={seed} onChange={(event) => setSeed(event.target.value)} maxLength={200} disabled={controlsDisabled} /></label>
              <fieldset className="workspace-weight-fields">
                <legend>评分权重</legend>
                {([ ["durationFit", "时长匹配"], ["diversity", "素材多样"], ["freshness", "素材新鲜"] ] as const).map(([key, label]) => <label key={key}><span>{label}</span><input type="number" min="0" max="1" step="0.05" value={scoreWeights[key]} onChange={(event) => setScoreWeights((current) => ({ ...current, [key]: Math.max(0, Number(event.target.value)) }))} disabled={controlsDisabled} /></label>)}
              </fieldset>
              <div className="workspace-combination-box">
                <span>组合空间</span>
                {counts ? <div><p><strong>{counts.rawCartesianCount.toLocaleString()}</strong> 理论组合</p><p><strong>{counts.countIsExact ? Number(counts.combinationCount || 0).toLocaleString() : "规模过大"}</strong>{counts.countStatus === "too_large" ? "候选按有界搜索生成" : "有效组合"}</p></div> : <p>保存项目后显示理论组合与有效组合数。</p>}
              </div>
              <button data-xiaoxi-mix-save className="workspace-button is-secondary is-wide" onClick={() => void saveProject()} disabled={controlsDisabled || !availableAssets.length}>{busyAction === "save" ? <LoaderCircle size={16} className="is-spinning" /> : <Save size={16} />}保存项目</button>
              <button data-xiaoxi-mix-generate className="workspace-button is-primary is-wide" onClick={() => void generateCandidates()} disabled={controlsDisabled || !projectId}>{busyAction === "generate" ? <LoaderCircle size={16} className="is-spinning" /> : <Sparkles size={16} />}生成候选</button>
              <p className="workspace-render-note"><CircleAlert size={15} />{engine?.capabilities.mix_render === true ? "成片只导出到本机，不会自动发布。" : "FFmpeg/ffprobe 未配置，当前构建不能生成成片包。"}</p>
            </aside>
          </div>
        </>
      )}
    </section>
  );
}
