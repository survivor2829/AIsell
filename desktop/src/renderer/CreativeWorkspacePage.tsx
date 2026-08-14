import {
  Check,
  CircleAlert,
  Clapperboard,
  FileVideo2,
  FolderOpen,
  KeyRound,
  Layers3,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Square,
  ThumbsDown
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import "./CreativeWorkspacePage.css";

type ContentResult<T> = { ok: boolean; data?: T; code?: string; error?: string };
type EngineStatus = {
  state: string;
  available: boolean;
  version: string;
  capabilities: Record<string, boolean>;
  code: string;
};
type Asset = {
  assetId: string;
  displayName: string;
  mediaKind: "video" | "image";
  probeStatus: "pending" | "ok" | "unavailable" | "failed";
  durationMs: number | null;
  hasAudio: boolean | null;
  archived: boolean;
  availableLocationCount: number;
};
type TaskStatus = "queued" | "analyzing" | "rendering" | "completed" | "failed" | "paused" | "cancelled" | "ready_for_review";
type Task = {
  taskId: string;
  taskType: string;
  status: TaskStatus;
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
};
type CreativeProject = {
  projectId: string;
  mode: "course" | "mix";
  name: string;
  theme: string;
  status: string;
  requiredRoles: string[];
  targetCount: number;
  generatedCount: number;
  maximumQualifiedCount: number | null;
  countIsExact: boolean | null;
  missingRoles: string[];
};
type GeneratedVideo = {
  generatedVideoId: string;
  projectId: string;
  taskId: string;
  kind: "course" | "mix";
  status: string;
  generation: number;
  title: string;
  durationMs: number;
  recommended: boolean;
  score: {
    total?: number;
    openingHook?: number;
    standaloneValue?: number;
    contentCompleteness?: number;
    transcriptQuality?: number;
    diversity?: number;
    hook?: number;
    engagement?: number;
    value?: number;
    shareability?: number;
    viralityTotal?: number;
    selectionEngine?: string;
    recommendationReason?: string[];
  };
  sourceStartMs: number | null;
  sourceEndMs: number | null;
  previewReady: boolean;
  thumbnailReady: boolean;
  errorCode: string | null;
  errorMessage: string | null;
};
type BailianStatus = {
  configured: boolean;
  maskedKey: string;
  secureStorageAvailable: boolean;
  code: string;
};
type ImportResult = { items: Asset[]; createdAssets: number; skippedCount: number };
type CreativeApi = {
  status: () => Promise<ContentResult<EngineStatus>>;
  library: {
    list: (payload?: { includeArchived?: boolean; limit?: number }) => Promise<ContentResult<{ items: Asset[] }>>;
    chooseFiles: () => Promise<ContentResult<ImportResult>>;
    chooseFolder: (payload?: { recursive?: boolean }) => Promise<ContentResult<ImportResult>>;
    probePending: (payload?: { limit?: number }) => Promise<ContentResult<{ items: Asset[]; processedCount: number; remainingCount: number }>>;
  };
  tasks: {
    list: (payload?: { limit?: number }) => Promise<ContentResult<{ items: Task[] }>>;
    pause: (payload: { taskId: string }) => Promise<ContentResult<Task>>;
    resume: (payload: { taskId: string }) => Promise<ContentResult<Task>>;
    cancel: (payload: { taskId: string }) => Promise<ContentResult<Task>>;
  };
  settings: {
    bailianKeyStatus: () => Promise<ContentResult<BailianStatus>>;
    saveBailianKey: (payload: { apiKey: string }) => Promise<ContentResult<BailianStatus>>;
    deleteBailianKey: () => Promise<ContentResult<BailianStatus>>;
  };
  creative: {
    analyzeAssets: (payload: { assetIds: string[] }) => Promise<ContentResult<Task>>;
    generateCourseCuts: (payload: {
      assetId: string;
      minDurationMs: number;
      maxDurationMs: number;
      count: number;
      theme: string;
      subtitleFontSize: number;
      subtitleMarginBottom: number;
      experimentMode: "standard" | "supoclip_bailian_v1";
      subtitlePreset: "dynamic_clean" | "knowledge_course" | "energetic_talking";
    }) => Promise<ContentResult<{ taskId: string; projectId: string }>>;
    generateMixBatch: (payload: {
      assetIds: string[];
      theme: string;
      targetCount: number;
      voiceAssetId: string;
    }) => Promise<ContentResult<{ taskId: string; projectId: string }>>;
    getProject: (payload: { projectId: string }) => Promise<ContentResult<CreativeProject>>;
    listGenerated: (payload?: { projectId?: string; limit?: number }) => Promise<ContentResult<{ items: GeneratedVideo[] }>>;
    regenerate: (payload: { candidateId: string }) => Promise<ContentResult<{
      taskId: string;
      generatedVideoId: string;
    }>>;
    reject: (payload: { candidateId: string }) => Promise<ContentResult<GeneratedVideo>>;
    queue: (payload: { candidateIds: string[]; channel: string }) => Promise<ContentResult<{ items: unknown[] }>>;
    mediaUrl: (payload: { candidateId: string; variant: "video" | "thumbnail" }) => Promise<ContentResult<{ url: string }>>;
    open: (payload: { candidateId: string }) => Promise<ContentResult<{ candidateId: string }>>;
    reveal: (payload: { candidateId: string }) => Promise<ContentResult<{ candidateId: string }>>;
  };
};

const TERMINAL_TASKS = new Set<TaskStatus>(["completed", "failed", "cancelled", "paused"]);
const GENERATED_VIDEO_ID = /^generated_video_[a-f0-9]{32}$/;
const ROLE_LABELS: Record<string, string> = {
  hook: "开场镜头",
  process: "过程镜头",
  result: "结果镜头"
};

function apiForWindow() {
  return (window as unknown as { xiaoxiContent?: CreativeApi }).xiaoxiContent;
}

function formatDuration(milliseconds?: number | null) {
  if (!milliseconds) return "—";
  const seconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}:${String(seconds % 60).padStart(2, "0")}` : `${seconds} 秒`;
}

function failure(result: ContentResult<unknown>, fallback: string) {
  return result.error || result.code || fallback;
}

function generatedMediaUrl(item: GeneratedVideo) {
  return item.previewReady && GENERATED_VIDEO_ID.test(item.generatedVideoId)
    ? `xiaoxi-content://generated/${item.generatedVideoId}/video`
    : "";
}

function capacitySummary(project: CreativeProject | null) {
  if (!project) return "";
  const parts: string[] = [];
  if (project.maximumQualifiedCount != null) {
    parts.push(project.countIsExact === false
      ? `已确认至少可生成 ${project.maximumQualifiedCount} 条合格组合（素材规模较大，仍有更多组合未计入）`
      : `当前素材最多可生成 ${project.maximumQualifiedCount} 条合格组合`);
  }
  if (project.missingRoles?.length) {
    parts.push(`缺少：${project.missingRoles.map((item) => ROLE_LABELS[item] || item).join("、")}`);
  }
  return parts.join("；");
}

export function CreativeWorkspacePage() {
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [mode, setMode] = useState<"course" | "course_experiment" | "mix">("course");
  const [courseAssetId, setCourseAssetId] = useState("");
  const [mixAssetIds, setMixAssetIds] = useState<string[]>([]);
  const [voiceAssetId, setVoiceAssetId] = useState("");
  const [theme, setTheme] = useState("培训现场价值");
  const [courseCount, setCourseCount] = useState(5);
  const [mixCount, setMixCount] = useState(30);
  const [minimumSeconds, setMinimumSeconds] = useState(30);
  const [maximumSeconds, setMaximumSeconds] = useState(90);
  const [subtitleFontSize, setSubtitleFontSize] = useState(48);
  const [subtitleMarginBottom, setSubtitleMarginBottom] = useState(170);
  const [subtitlePreset, setSubtitlePreset] = useState<"knowledge_course" | "energetic_talking">("knowledge_course");
  const [currentTaskId, setCurrentTaskId] = useState("");
  const [currentTask, setCurrentTask] = useState<Task | null>(null);
  const [projectId, setProjectId] = useState("");
  const [project, setProject] = useState<CreativeProject | null>(null);
  const [videos, setVideos] = useState<GeneratedVideo[]>([]);
  const [selectedVideos, setSelectedVideos] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [keyStatus, setKeyStatus] = useState<BailianStatus | null>(null);
  const [keyInput, setKeyInput] = useState("");

  const usableAssets = useMemo(
    () => assets.filter((item) => !item.archived && item.availableLocationCount > 0),
    [assets]
  );
  const videoAssets = useMemo(
    () => usableAssets.filter((item) => item.mediaKind === "video"),
    [usableAssets]
  );
  const audioVideoAssets = useMemo(
    () => videoAssets.filter((item) => item.hasAudio === true),
    [videoAssets]
  );
  const selectedVoiceAssets = useMemo(
    () => audioVideoAssets.filter((item) => mixAssetIds.includes(item.assetId)),
    [audioVideoAssets, mixAssetIds]
  );
  const selectedAssetIds = mode !== "mix"
    ? (courseAssetId ? [courseAssetId] : [])
    : mixAssetIds;

  const loadVideos = useCallback(async (targetProjectId?: string) => {
    const api = apiForWindow();
    if (!api?.creative) return;
    const result = await api.creative.listGenerated({
      ...(targetProjectId ? { projectId: targetProjectId } : {}),
      limit: 500
    });
    if (!result.ok || !result.data) return;
    setVideos(result.data.items);
  }, []);

  const loadFoundation = useCallback(async () => {
    const api = apiForWindow();
    if (!api) return;
    const [status, library, bailian] = await Promise.all([
      api.status(),
      api.library.list({ limit: 500 }),
      api.settings.bailianKeyStatus()
    ]);
    if (status.ok && status.data) setEngine(status.data);
    if (library.ok && library.data) {
      let libraryItems = library.data.items;
      if (libraryItems.some((item) => item.probeStatus === "pending")) {
        const probed = await api.library.probePending({ limit: 10 });
        if (probed.ok) {
          const refreshed = await api.library.list({ limit: 500 });
          if (refreshed.ok && refreshed.data) libraryItems = refreshed.data.items;
        }
      }
      setAssets(libraryItems);
      const firstVideo = libraryItems.find(
        (item) => item.mediaKind === "video" && item.hasAudio === true
      );
      if (firstVideo) {
        setCourseAssetId((current) => current || firstVideo.assetId);
        setVoiceAssetId((current) => current || firstVideo.assetId);
      }
    }
    if (bailian.ok && bailian.data) setKeyStatus(bailian.data);
  }, []);

  useEffect(() => {
    void loadFoundation();
    void loadVideos();
  }, [loadFoundation, loadVideos]);

  useEffect(() => {
    if (mode !== "mix") return;
    setVoiceAssetId((current) => selectedVoiceAssets.some(
      (item) => item.assetId === current
    ) ? current : selectedVoiceAssets[0]?.assetId || "");
  }, [mode, selectedVoiceAssets]);

  useEffect(() => {
    if (engine?.state !== "ready" || audioVideoAssets.length === 0) return;
    setNotice((current) => current?.tone === "error"
      && current.text === "内容引擎暂时不可用，请重试。"
      ? null
      : current);
  }, [audioVideoAssets.length, engine?.state]);

  useEffect(() => {
    if (!currentTaskId) return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      const api = apiForWindow();
      try {
        if (!api) return;
        const result = await api.tasks.list({ limit: 500 });
        const task = result.data?.items.find((item) => item.taskId === currentTaskId);
        if (!active || !task) return;
        setCurrentTask(task);
        if (TERMINAL_TASKS.has(task.status)) {
          setCurrentTaskId("");
          setBusy("");
          let taskProject: CreativeProject | null = null;
          if (projectId) {
            const projectResult = await api.creative.getProject({ projectId });
            if (projectResult.ok && projectResult.data) {
              taskProject = projectResult.data;
              setProject(projectResult.data);
            }
          }
          if (task.status === "completed") {
            setNotice({ tone: "success", text: "AI 处理完成，成片已经可以播放和内部验收。" });
            await loadVideos(projectId || undefined);
            if (projectId) {
              const summary = await api.creative.getProject({ projectId });
              if (summary.ok && summary.data) setProject(summary.data);
            }
          } else if (task.status === "failed") {
            setNotice({ tone: "error", text: task.errorMessage || task.errorCode || "AI 处理失败。" });
            const shortage = capacitySummary(taskProject);
            if (shortage) {
              setNotice({
                tone: "error",
                text: `${task.errorMessage || task.errorCode || "AI 处理失败。"}；${shortage}`
              });
            }
          }
        }
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1_500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [currentTaskId, loadVideos, projectId]);

  async function importAssets(kind: "files" | "folder") {
    const api = apiForWindow();
    if (!api) return;
    setBusy(`import-${kind}`);
    setNotice(null);
    const result = kind === "files"
      ? await api.library.chooseFiles()
      : await api.library.chooseFolder({ recursive: true });
    setBusy("");
    if (!result.ok || !result.data) {
      if (result.code !== "CONTENT_DIALOG_CANCELLED") {
        setNotice({ tone: "error", text: failure(result, "素材导入失败。") });
      }
      return;
    }
    const pendingProbe = await api.library.probePending({ limit: 10 });
    if (!pendingProbe.ok) {
      setNotice({ tone: "error", text: failure(pendingProbe, "素材已登记，但媒体信息读取失败。") });
      await loadFoundation();
      return;
    }
    await loadFoundation();
    const refreshedItems = result.data.items.map((item) =>
      pendingProbe.data?.items.find((probed) => probed.assetId === item.assetId) || item
    );
    const importedIds = refreshedItems.map((item) => item.assetId);
    if (mode !== "mix") {
      const firstVideo = refreshedItems.find(
        (item) => item.mediaKind === "video" && item.hasAudio === true
      );
      if (firstVideo) setCourseAssetId(firstVideo.assetId);
    } else {
      setMixAssetIds(importedIds);
      const firstVoice = refreshedItems.find((item) => item.mediaKind === "video" && item.hasAudio === true);
      if (firstVoice) setVoiceAssetId(firstVoice.assetId);
    }
    setNotice({
      tone: "success",
      text: `已登记 ${result.data.items.length} 条素材；原文件仍保留在原位置。`
    });
  }

  async function analyze() {
    const api = apiForWindow();
    if (!api || !selectedAssetIds.length) return;
    setBusy("analyze");
    setNotice(null);
    const result = await api.creative.analyzeAssets({ assetIds: selectedAssetIds });
    if (!result.ok || !result.data) {
      setBusy("");
      setNotice({ tone: "error", text: failure(result, "无法开始素材分析。") });
      return;
    }
    setCurrentTaskId(result.data.taskId);
    setCurrentTask(result.data);
  }

  async function generate() {
    const api = apiForWindow();
    if (!api || !selectedAssetIds.length) return;
    setBusy("generate");
    setNotice(null);
    if (mode !== "mix" && (minimumSeconds < 30 || maximumSeconds > 90 || minimumSeconds > maximumSeconds)) {
      setBusy("");
      setNotice({ tone: "error", text: "课程成片时长必须在 30～90 秒之间，且最短不能大于最长。" });
      return;
    }
    if (mode === "mix" && !selectedVoiceAssets.some((item) => item.assetId === voiceAssetId)) {
      setBusy("");
      setNotice({ tone: "error", text: "请从已选素材中选择一条带声音的视频作为老师原声。" });
      return;
    }
    const result = mode !== "mix"
      ? await api.creative.generateCourseCuts({
        assetId: courseAssetId,
        minDurationMs: minimumSeconds * 1000,
        maxDurationMs: maximumSeconds * 1000,
        count: courseCount,
        theme,
        subtitleFontSize,
        subtitleMarginBottom,
        experimentMode: mode === "course_experiment" ? "supoclip_bailian_v1" : "standard",
        subtitlePreset: mode === "course_experiment" ? subtitlePreset : "dynamic_clean"
      })
      : await api.creative.generateMixBatch({
        assetIds: mixAssetIds,
        theme,
        targetCount: mixCount,
        voiceAssetId
      });
    if (!result.ok || !result.data) {
      setBusy("");
      setNotice({ tone: "error", text: failure(result, "无法开始生成。") });
      return;
    }
    setProjectId(result.data.projectId);
    setProject(null);
    setVideos([]);
    setCurrentTaskId(result.data.taskId);
    setCurrentTask(null);
  }

  async function taskAction(action: "pause" | "resume" | "cancel") {
    const api = apiForWindow();
    const taskId = currentTask?.taskId || currentTaskId;
    if (!api || !taskId) return;
    const result = await api.tasks[action]({ taskId });
    if (result.ok && result.data) {
      setCurrentTask(result.data);
      if (action === "resume") setCurrentTaskId(taskId);
    } else {
      setNotice({ tone: "error", text: failure(result, "任务状态更新失败。") });
    }
  }

  async function saveKey() {
    const api = apiForWindow();
    if (!api || !keyInput.trim()) return;
    setBusy("key");
    const result = await api.settings.saveBailianKey({ apiKey: keyInput.trim() });
    setBusy("");
    if (result.ok && result.data) {
      setKeyStatus(result.data);
      setKeyInput("");
      setNotice({ tone: "success", text: "百炼 Key 已用当前 Windows 账户加密保存，内容引擎已重启。" });
    } else {
      setNotice({ tone: "error", text: failure(result, "百炼 Key 保存失败。") });
    }
  }

  async function regenerate(item: GeneratedVideo) {
    const api = apiForWindow();
    if (!api) return;
    setBusy(`regenerate-${item.generatedVideoId}`);
    const result = await api.creative.regenerate({ candidateId: item.generatedVideoId });
    if (!result.ok || !result.data?.taskId) {
      setBusy("");
      setNotice({ tone: "error", text: failure(result, "重新生成失败。") });
      return;
    }
    setCurrentTaskId(result.data.taskId);
    setNotice({ tone: "info", text: "重新生成任务已开始，完成后会自动刷新成片。" });
  }

  async function reject(item: GeneratedVideo) {
    const api = apiForWindow();
    if (!api) return;
    const result = await api.creative.reject({ candidateId: item.generatedVideoId });
    if (!result.ok) setNotice({ tone: "error", text: failure(result, "淘汰成片失败。") });
    else await loadVideos(projectId || undefined);
  }

  async function queueSelected(ids: string[]) {
    const api = apiForWindow();
    if (!api || !ids.length) return;
    const result = await api.creative.queue({ candidateIds: ids, channel: "internal" });
    if (result.ok) {
      setSelectedVideos([]);
      setNotice({ tone: "success", text: `已接受 ${ids.length} 条成片并加入内部队列；不会自动发布。` });
    } else {
      setNotice({ tone: "error", text: failure(result, "加入内部队列失败。") });
    }
  }

  function toggleMixAsset(assetId: string) {
    setMixAssetIds((current) => current.includes(assetId)
      ? current.filter((item) => item !== assetId)
      : [...current, assetId]);
  }

  const running = Boolean(currentTask && !TERMINAL_TASKS.has(currentTask.status));
  const engineReady = engine?.state === "ready";
  const generationSelectionReady = mode !== "mix"
    ? audioVideoAssets.some((item) => item.assetId === courseAssetId)
    : mixAssetIds.length > 0 && selectedVoiceAssets.some((item) => item.assetId === voiceAssetId);

  return (
    <section className="page creative-workspace-page">
      <header className="page-header workspace-page-head">
        <div>
          <span className="workspace-eyebrow">AI CREATIVE STUDIO</span>
          <h1>创作工作台</h1>
          <p>选择素材与目标，AI 自动理解、选段、混剪和渲染，不需要手工时间线。</p>
        </div>
        <div className={`workspace-engine-badge ${engineReady ? "is-ready" : "is-failed"}`}>
          <span />{engineReady ? "内容引擎已就绪" : "内容引擎未就绪"}
        </div>
      </header>

      {notice && <div className={`workspace-banner is-${notice.tone}`}>
        {notice.tone === "success" ? <Check size={16} /> : <CircleAlert size={16} />}
        {notice.text}
      </div>}

      <div className="workspace-mode-grid">
        <button className={`workspace-mode-card ${mode === "course" ? "is-active" : ""}`} onClick={() => setMode("course")}>
          <FileVideo2 size={24} /><span><strong>长课程精剪</strong><small>从口播、播客或课程中找出完整观点，生成 30～90 秒竖屏成片。</small></span>
        </button>
        <button
          className={`workspace-mode-card ${mode === "course_experiment" ? "is-active" : ""}`}
          onClick={() => {
            setMode("course_experiment");
            setCourseCount(5);
            setSubtitleFontSize(42);
            setSubtitleMarginBottom(140);
            setSubtitlePreset("knowledge_course");
          }}
        >
          <Sparkles size={24} /><span><strong>百炼 × SupoClip 对照实验</strong><small>百炼完成中文选段与四维评分，使用词级时间戳制作动态字幕；与现有精剪隔离。</small></span>
        </button>
        <button className={`workspace-mode-card ${mode === "mix" ? "is-active" : ""}`} onClick={() => setMode("mix")}>
          <Layers3 size={24} /><span><strong>AI 批量混剪</strong><small>自动组织“开场—过程—结果”，用老师原声串起现场素材。</small></span>
        </button>
      </div>

      <div className="workspace-layout">
        <main className="workspace-main-column">
          <section className="workspace-panel workspace-material-panel">
            <div className="workspace-section-head">
              <div><span>01</span><h2>添加与选择素材</h2></div>
              <div className="workspace-inline-actions">
                <button onClick={() => void importAssets("files")} disabled={Boolean(busy)}>
                  {busy === "import-files" ? <LoaderCircle className="is-spinning" size={15} /> : <FileVideo2 size={15} />}选择文件
                </button>
                <button onClick={() => void importAssets("folder")} disabled={Boolean(busy)}>
                  {busy === "import-folder" ? <LoaderCircle className="is-spinning" size={15} /> : <FolderOpen size={15} />}选择文件夹
                </button>
              </div>
            </div>

            {mode !== "mix" ? (
              <label className="workspace-field">
                <span>课程视频</span>
                <select value={courseAssetId} onChange={(event) => setCourseAssetId(event.target.value)}>
                  <option value="">请选择一个带声音的视频</option>
                  {audioVideoAssets.map((item) => <option value={item.assetId} key={item.assetId}>
                    {item.displayName} · {formatDuration(item.durationMs)}
                  </option>)}
                </select>
              </label>
            ) : (
              <div className="workspace-assets">
                {usableAssets.map((item) => <label className={mixAssetIds.includes(item.assetId) ? "is-selected" : ""} key={item.assetId}>
                  <input type="checkbox" checked={mixAssetIds.includes(item.assetId)} onChange={() => toggleMixAsset(item.assetId)} />
                  <span><strong>{item.displayName}</strong><small>{item.mediaKind === "video" ? formatDuration(item.durationMs) : "图片"}</small></span>
                </label>)}
              </div>
            )}
            {!usableAssets.length && <div className="workspace-empty">还没有素材。请选择实验视频或素材文件夹。</div>}
          </section>

          <section className="workspace-panel workspace-generate-panel">
            <div className="workspace-section-head"><div><span>02</span><h2>设置目标并生成</h2></div></div>
            <div className="workspace-form-grid">
              <label className="workspace-field workspace-theme-field"><span>主题</span><input value={theme} maxLength={100} onChange={(event) => setTheme(event.target.value)} /></label>
              {mode !== "mix" ? <>
                <label className="workspace-field"><span>最短（秒）</span><input type="number" min={30} max={90} value={minimumSeconds} onChange={(event) => setMinimumSeconds(Number(event.target.value))} /></label>
                <label className="workspace-field"><span>最长（秒）</span><input type="number" min={30} max={90} value={maximumSeconds} onChange={(event) => setMaximumSeconds(Number(event.target.value))} /></label>
                <label className="workspace-field"><span>候选数量</span><input type="number" min={1} max={20} value={courseCount} onChange={(event) => setCourseCount(Number(event.target.value))} /></label>
                <label className="workspace-field"><span>字幕字号</span><select value={subtitleFontSize} onChange={(event) => setSubtitleFontSize(Number(event.target.value))}><option value={42}>小</option><option value={48}>标准</option><option value={56}>大</option></select></label>
                <label className="workspace-field"><span>字幕位置</span><select value={subtitleMarginBottom} onChange={(event) => setSubtitleMarginBottom(Number(event.target.value))}><option value={140}>更靠下</option><option value={170}>底部安全区</option><option value={230}>偏上</option></select></label>
                {mode === "course_experiment" && <label className="workspace-field workspace-template-field"><span>动态字幕模板</span><select value={subtitlePreset} onChange={(event) => setSubtitlePreset(event.target.value as "knowledge_course" | "energetic_talking")}><option value="knowledge_course">知识课程</option><option value="energetic_talking">活力口播</option></select><small>{subtitlePreset === "knowledge_course" ? "稳重低位，关键词逐词高亮，适合课程与知识内容。" : "明亮强调与轻量弹入，适合节奏更快的口播。"}</small></label>}
              </> : <>
                <label className="workspace-field"><span>成片数量</span><select value={mixCount} onChange={(event) => setMixCount(Number(event.target.value))}><option value={30}>30 条（首轮验收）</option><option value={100}>100 条</option><option value={200}>200 条</option><option value={300}>300 条</option></select></label>
                <label className="workspace-field workspace-voice-field"><span>老师原声</span><select value={voiceAssetId} onChange={(event) => setVoiceAssetId(event.target.value)}><option value="">请选择带声音的视频</option>{selectedVoiceAssets.map((item) => <option value={item.assetId} key={item.assetId}>{item.displayName}</option>)}</select></label>
              </>}
            </div>
            <div className="workspace-generate-actions">
              <button className="workspace-button is-secondary" onClick={() => void analyze()} disabled={!engineReady || !selectedAssetIds.length || Boolean(busy)}>
                {busy === "analyze" ? <LoaderCircle className="is-spinning" size={16} /> : <RefreshCw size={16} />}仅分析素材
              </button>
              <button className="workspace-button is-primary" onClick={() => void generate()} disabled={!engineReady || !generationSelectionReady || Boolean(busy)}>
                {busy === "generate" ? <LoaderCircle className="is-spinning" size={16} /> : <Sparkles size={16} />}AI 自动生成
              </button>
            </div>
            <p className="workspace-safety-note"><CircleAlert size={15} />{mode === "course_experiment" ? "复用已完成的分析缓存；本次只增加一次百炼文本主编调用。首轮仅内部验收，不承诺传播效果，也不会自动发布。" : "首轮仅内部查看。生成按钮会自动补齐尚未完成的素材分析，不会发布到微信、抖音或快手。"}</p>
          </section>

          {(currentTask || project) && <section className="workspace-panel workspace-progress-panel">
            <div className="workspace-progress-copy">
              <strong>{currentTask?.status === "rendering" ? "正在渲染成片" : currentTask?.status === "analyzing" ? "正在理解素材" : currentTask?.status === "completed" ? "处理完成" : "任务处理中"}</strong>
              <span>{Math.round((currentTask?.progress || 0) * 100)}%</span>
            </div>
            <div className="workspace-progress-track"><span style={{ width: `${Math.round((currentTask?.progress || 0) * 100)}%` }} /></div>
            <div className="workspace-task-actions">
              {running && <button onClick={() => void taskAction("pause")}><Pause size={14} />暂停</button>}
              {currentTask?.status === "paused" && <button onClick={() => void taskAction("resume")}><Play size={14} />继续</button>}
              {running && <button onClick={() => void taskAction("cancel")}><Square size={13} />取消</button>}
            </div>
            {project && <div className="workspace-capacity">
              已生成 <b>{project.generatedCount}</b> / {project.targetCount} 条
              {project.maximumQualifiedCount != null && <span>{project.countIsExact === false ? `已确认至少可生成 ${project.maximumQualifiedCount} 条合格组合（仍有更多组合未计入）` : `当前素材最多可生成 ${project.maximumQualifiedCount} 条合格组合`}</span>}
              {project.missingRoles?.length > 0 && <span>缺少：{project.missingRoles.map((item) => ROLE_LABELS[item] || item).join("、")}</span>}
            </div>}
          </section>}

          <section className="workspace-panel workspace-results-panel">
            <div className="workspace-section-head">
              <div><span>03</span><h2>成片验收</h2><small>{videos.length ? `${videos.length} 条` : "等待生成"}</small></div>
              {selectedVideos.length > 0 && <button className="workspace-button is-primary" onClick={() => void queueSelected(selectedVideos)}>接受所选（{selectedVideos.length}）</button>}
            </div>
            {videos.length ? <div className="workspace-video-grid">
              {videos.map((item) => {
                const aiRecommended = item.recommended && item.score.selectionEngine === "bailian_editor";
                const localPreselection = item.score.selectionEngine === "local_content_signals";
                const experimentCandidate = item.score.selectionEngine === "supoclip_bailian_editor";
                const recommended = aiRecommended || (item.recommended && experimentCandidate);
                return <article className={`workspace-video-card ${recommended ? "is-recommended" : ""}`} key={item.generatedVideoId}>
                <div className="workspace-video-frame">
                  {generatedMediaUrl(item)
                    ? <video controls preload="metadata" src={generatedMediaUrl(item)} />
                    : <div><Clapperboard size={28} /><span>{item.status === "failed" ? "生成失败" : "预览准备中"}</span></div>}
                  {aiRecommended && <b>AI 推荐</b>}
                  {experimentCandidate && <b className="is-experiment">{item.recommended ? "实验推荐" : "对照实验"}</b>}
                  {localPreselection && <b className="is-local">本地预筛</b>}
                  <label><input type="checkbox" checked={selectedVideos.includes(item.generatedVideoId)} onChange={() => setSelectedVideos((current) => current.includes(item.generatedVideoId) ? current.filter((id) => id !== item.generatedVideoId) : [...current, item.generatedVideoId])} />选择</label>
                </div>
                <div className="workspace-video-body">
                  <div><strong>{item.title}</strong><span>{formatDuration(item.durationMs)}{experimentCandidate && item.score.viralityTotal != null ? ` · 传播总分 ${Math.round(item.score.viralityTotal)}` : item.score?.total != null ? ` · ${localPreselection ? "预筛 " : ""}${Math.round(item.score.total)} 分` : ""}</span></div>
                  <small>{item.sourceStartMs != null ? `源时间码 ${formatDuration(item.sourceStartMs)}—${formatDuration(item.sourceEndMs)}` : "三段式语义混剪"}</small>
                  {item.kind === "course" && (experimentCandidate ? <div className="workspace-score-breakdown is-experiment">
                    <span>百炼 × SupoClip</span>
                    {item.score.hook != null && <span>开场吸引 {Math.round(item.score.hook)}/25</span>}
                    {item.score.engagement != null && <span>持续观看 {Math.round(item.score.engagement)}/25</span>}
                    {item.score.value != null && <span>知识价值 {Math.round(item.score.value)}/25</span>}
                    {item.score.shareability != null && <span>收藏转发 {Math.round(item.score.shareability)}/25</span>}
                  </div> : <div className="workspace-score-breakdown">
                    {item.score.selectionEngine === "bailian_editor" && <span>百炼主编</span>}
                    {item.score.openingHook != null && <span>开头 {Math.round(item.score.openingHook * 100)}</span>}
                    {item.score.standaloneValue != null && <span>价值 {Math.round(item.score.standaloneValue * 100)}</span>}
                    {item.score.contentCompleteness != null && <span>完整 {Math.round(item.score.contentCompleteness * 100)}</span>}
                    {item.score.diversity != null && <span>差异 {Math.round(item.score.diversity * 100)}</span>}
                  </div>)}
                  {item.score.recommendationReason?.length ? <p className="workspace-recommendation-reason">推荐理由：{item.score.recommendationReason.join(" · ")}</p> : null}
                  {item.errorMessage && <p>{item.errorMessage}</p>}
                  <div className="workspace-card-actions">
                    <button onClick={() => void queueSelected([item.generatedVideoId])}><Check size={14} />接受</button>
                    <button onClick={() => void reject(item)}><ThumbsDown size={14} />淘汰</button>
                    <button onClick={() => void regenerate(item)} disabled={busy === `regenerate-${item.generatedVideoId}`}>
                      {busy === `regenerate-${item.generatedVideoId}` ? <LoaderCircle className="is-spinning" size={14} /> : <RotateCcw size={14} />}重生成
                    </button>
                    <button onClick={() => void apiForWindow()?.creative.reveal({ candidateId: item.generatedVideoId })}><FolderOpen size={14} />定位</button>
                  </div>
                </div>
              </article>;
              })}
            </div> : <div className="workspace-empty workspace-empty-results"><Clapperboard size={30} /><strong>成片会出现在这里</strong><span>AI 会保留字幕、选段理由和源时间码供系统追溯。</span></div>}
          </section>
        </main>

        <aside className="workspace-sidebar">
          <section className="workspace-panel workspace-key-panel">
            <div className="workspace-sidebar-title"><KeyRound size={18} /><div><strong>百炼素材理解</strong><span>{keyStatus?.configured ? `已配置 ${keyStatus.maskedKey}` : "尚未配置"}</span></div></div>
            <input type="password" value={keyInput} placeholder="sk-..." autoComplete="off" onChange={(event) => setKeyInput(event.target.value)} />
            <button className="workspace-button is-primary" onClick={() => void saveKey()} disabled={!keyInput.trim() || busy === "key"}>{busy === "key" ? <LoaderCircle className="is-spinning" size={15} /> : <KeyRound size={15} />}加密保存</button>
            <p>只上传压缩音频和抽取关键帧；原始视频留在本机。Key 不进入日志、数据库或导出包。</p>
          </section>
          <section className="workspace-panel workspace-workflow-panel">
            <strong>自动处理流程</strong>
            {["生成竖屏代理与 16kHz 音频", "转写、镜头切分与质量评分", "观点选段或三段式组合", "1080×1920 字幕成片"].map((text, index) => <div key={text}><span>{index + 1}</span>{text}</div>)}
          </section>
          <section className="workspace-panel workspace-output-panel">
            <strong>固定输出规格</strong>
            <span>9:16 · 1080×1920</span>
            <span>H.264 / AAC · 30fps</span>
            <span>优先 Intel QSV，自动回退软件编码</span>
          </section>
        </aside>
      </div>
    </section>
  );
}
