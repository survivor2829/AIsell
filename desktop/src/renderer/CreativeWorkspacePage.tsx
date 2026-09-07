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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StyleId as VisualStyleId } from "../../remotion-packaging/types";
import {
  LatestRequestGate,
  SerializedMutationGate
} from "./creative-workspace-concurrency";
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
  projectId?: string | null;
  status: TaskStatus;
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
  analysisSummary?: {
    analyzedCount: number;
    requestedCount: number;
    provider: string;
    cloudConfigured: boolean;
    skippedAssets: Array<{ assetId: string; errorCode: string | null; message: string | null }>;
  } | null;
  createdAt?: string;
  updatedAt?: string;
  comparisonGroupId?: string | null;
  comparisonSourceCandidateId?: string | null;
  renderCount?: number;
  bailianCalls?: number | null;
  apimartCalls?: number | null;
  remotionPackagingCapable?: boolean;
  visualComparisonCapable?: boolean;
  candidates?: Array<{
    candidateId: string;
    status: string | null;
    requestedEngine: "ffmpeg" | "remotion" | null;
    requestedStyleId: VisualStyleId | null;
    requestedStyleVersion: number | null;
    actualEngine: "ffmpeg" | "remotion" | null;
    actualStyleVersion: number | null;
    fallbackCode: string | null;
  }>;
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
  pilotMode?: boolean;
  pilotNotice?: string | null;
  skeletonIds?: string[];
  skeletonCount?: number;
};
type GeneratedVideo = {
  generatedVideoId: string;
  projectId: string;
  taskId: string;
  kind: "course" | "mix";
  skeletonId: string | null;
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
  sourceAssetId: string | null;
  sourceStartMs: number | null;
  sourceEndMs: number | null;
  previewReady: boolean;
  thumbnailReady: boolean;
  packagingPresetId: string | null;
  packagingPresetName: string | null;
  packagingVersion: number | null;
  brandProfileId: string | null;
  coverStatus: string | null;
  phoneReview: MediaReview | null;
  motionDirectorProvider: string | null;
  motionEventCount: number;
  requestedEngine: "ffmpeg" | "remotion" | null;
  requestedStyleId: VisualStyleId | null;
  requestedStyleVersion: number | null;
  actualEngine: "ffmpeg" | "remotion" | null;
  actualStyleVersion: number | null;
  fallbackCode: string | null;
  comparisonGroupId: string | null;
  comparisonSourceCandidateId: string | null;
  remotionPackagingCapable: boolean;
  visualComparisonCapable: boolean;
  visualRendererLegacy: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
};
type MediaReview = {
  reviewId: string;
  generatedVideoId: string | null;
  device: "phone" | "desktop";
  verdict: "pass" | "fail";
  reason: string;
  reviewer: string;
  mediaDigest: string | null;
  reviewedAt: string;
};
type PackagingMode = "auto" | "preset" | "none";
type CoverMode = "local_frame" | "ai_generate" | "none";
type VisualStylePreference = "auto_disperse" | VisualStyleId;
type VisualRendererRequest = {
  requestedEngine: "remotion";
  visualStyleId?: VisualStyleId;
  requestedStyleVersion: 1;
  allowFallback: boolean;
};
type CostBreakdownItem = {
  operation: string;
  label: string;
  estimatedCalls: number;
  maximumCalls: number;
  cacheable: boolean;
  status: string;
};
type GenerationCostEstimate = {
  candidateCount: number;
  coverMode: CoverMode;
  estimatedImageCalls: number;
  providerConfigured: boolean;
  bailianCalls: number;
  bailianProviderConfigured: boolean;
  bailianBreakdown: CostBreakdownItem[];
  apimartBreakdown: CostBreakdownItem[];
  confirmationRequired: boolean;
};
type ComparisonPreflightStatus = "idle" | "checking" | "ready" | "blocked" | "error";
type VisualComparisonPreflight = {
  eligible: boolean;
  reason: string;
  renderCount: 3;
  bailianCalls: 0;
  apimartCalls: 0;
  remotionAvailable: boolean;
  visualComparisonAvailable: boolean;
  aiCoverVerified?: boolean;
  remotionAccepted?: boolean;
  phoneReviewed?: boolean;
};
type ComparisonPreflightState = {
  candidateId: string;
  candidateFingerprint: string;
  status: ComparisonPreflightStatus;
  details: VisualComparisonPreflight | null;
  reason: string;
};
type PackagingPreset = {
  presetId: string;
  version: number;
  kind: "course" | "mix";
  displayName: string;
  subtitle: Record<string, unknown>;
  effects: Record<string, unknown>;
  audio: Record<string, unknown>;
};
type BrandProfile = {
  brandProfileId: string;
  name: string;
  logoAssetId: string | null;
  referencePortraitAssetId: string | null;
  primaryColor: string;
  accentColor: string;
  fontPreset: "microsoft_yahei" | "source_han_sans" | "neutral_sans";
  outroText: string;
};
type BailianStatus = {
  configured: boolean;
  maskedKey: string;
  apiHost: string;
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
    volcengineArkStatus: () => Promise<ContentResult<BailianStatus>>;
    saveVolcengineArkKey: (payload: { apiKey: string; apiHost?: string }) => Promise<ContentResult<BailianStatus>>;
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
      packagingMode: PackagingMode;
      packagingPresetId?: string;
      brandProfileId?: string;
      coverMode: CoverMode;
      confirmPaidCalls?: boolean;
      visualRenderer?: VisualRendererRequest;
    }) => Promise<ContentResult<{ taskId: string; projectId: string }>>;
    generateMixBatch: (payload: {
      assetIds: string[];
      theme: string;
      targetCount: number;
      voiceAssetId: string;
      pilotMode?: boolean;
      packagingMode: PackagingMode;
      packagingPresetId?: string;
      brandProfileId?: string;
      coverMode: CoverMode;
      confirmPaidCalls?: boolean;
      visualRenderer?: VisualRendererRequest;
    }) => Promise<ContentResult<{ taskId: string; projectId: string }>>;
    listPackagingPresets: (payload?: { kind?: "course" | "mix" }) => Promise<ContentResult<{ items: PackagingPreset[] }>>;
    listBrandProfiles: () => Promise<ContentResult<{ items: BrandProfile[] }>>;
    saveBrandProfile: (payload: {
      brandProfileId?: string;
      name: string;
      logoAssetId?: string;
      referenceAssetId?: string;
      primaryColor: string;
      accentColor: string;
      fontPreset: BrandProfile["fontPreset"];
      outroText: string;
    }) => Promise<ContentResult<BrandProfile>>;
    getPackagingCostEstimate: (payload: { candidateIds: string[]; coverMode: CoverMode; packagingMode?: PackagingMode; plannedCount?: number; assetIds?: string[]; generationKind?: "course" | "mix" | "repackage" }) => Promise<ContentResult<GenerationCostEstimate>>;
    recordMediaReview: (payload: { candidateId: string; device: "phone" | "desktop"; verdict: "pass" | "fail"; reason?: string; reviewer?: string }) => Promise<ContentResult<MediaReview>>;
    listMediaReviews: (payload: { candidateId: string }) => Promise<ContentResult<{ items: MediaReview[] }>>;
    packageGeneratedVideos: (payload: {
      candidateIds: string[];
      packagingMode: PackagingMode;
      packagingPresetId?: string;
      brandProfileId?: string;
      coverMode: CoverMode;
      reuseCover?: boolean;
    }) => Promise<ContentResult<Task>>;
    repackageVideo: (payload: {
      candidateId: string;
      packagingMode: PackagingMode;
      packagingPresetId?: string;
      brandProfileId?: string;
      coverMode: CoverMode;
    }) => Promise<ContentResult<Task>>;
    preflightVisualComparison: (payload: { candidateId: string }) => Promise<ContentResult<VisualComparisonPreflight>>;
    createVisualComparisonTask: (payload: { candidateId: string }) => Promise<ContentResult<Task>>;
    regenerateCover: (payload: { candidateId: string }) => Promise<ContentResult<Task>>;
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
const RECOVERABLE_CREATIVE_TASKS = new Set([
  "creative_analysis", "course_generation", "mix_generation",
  "creative_regeneration", "creative_packaging", "creative_cover",
  "creative_visual_comparison"
]);
const RECOVERABLE_TASK_STATUSES = new Set<TaskStatus>([
  "queued", "analyzing", "ready_for_review", "rendering", "paused"
]);
const GENERATED_VIDEO_ID = /^generated_video_[a-f0-9]{32}$/;
const EMPTY_COMPARISON_PREFLIGHT: ComparisonPreflightState = {
  candidateId: "",
  candidateFingerprint: "",
  status: "idle",
  details: null,
  reason: ""
};
const VISUAL_STYLE_LABELS: Record<VisualStyleId, string> = {
  social_pop: "社交弹跳",
  neo_editorial: "新编辑部",
  tech_motion: "科技动势"
};
const PREFLIGHT_REASON_LABELS: Record<string, string> = {
  ready: "Remotion 能力与来源成片均已就绪。",
  source_candidate_not_found: "没有找到来源成片。",
  source_candidate_not_completed: "来源成片尚未完成。",
  source_video_missing: "来源视频不可用。",
  source_cover_missing: "来源成片没有可复用的 AI 封面。",
  source_ai_cover_not_verified: "来源成片的 AI 封面没有完成供应商回执核验。",
  source_remotion_acceptance_required: "来源成片不是 Remotion-only 验收成片。",
  phone_review_required: "请先在手机竖屏查看并记录通过结果。",
  phone_review_stale: "视频已经变化，需要重新做手机验收。",
  motion_plan_missing: "来源成片缺少可复用的编导计划。",
  motion_plan_timing_invalid: "来源成片的编导时间码不适合对照。",
  motion_plan_version_unsupported: "来源成片的编导计划版本不受支持。",
  motion_plan_evidence_invalid: "来源成片的编导证据不完整。",
  motion_plan_incompatible: "来源成片的编导计划与当前模板不兼容。",
  layout_unavailable: "来源成片缺少安全布局信息。",
  source_material_unavailable: "来源素材信息不可用于对照。",
  remotion_capability_unavailable: "本机 Remotion 能力不可用。",
  comparison_runtime_hash_unavailable: "Remotion 运行时尚未通过完整性预检。",
  comparison_bundle_hash_unavailable: "Remotion 模板尚未通过完整性预检。"
};
const FALLBACK_LABELS: Record<string, string> = {
  browser_unavailable: "浏览器运行时不可用",
  worker_unavailable: "Remotion worker 不可用",
  bundle_unavailable: "Remotion 模板不可用",
  render_timeout: "本地动态包装超时",
  render_failed: "本地动态包装失败",
  remotion_capability_unavailable: "Remotion 能力不可用"
};
const ROLE_LABELS: Record<string, string> = {
  hook: "开场镜头",
  process: "过程镜头",
  result: "结果镜头"
};
const COVER_STATUS_LABELS: Record<string, string> = {
  local: "本地完成",
  completed: "已完成",
  reused: "已复用",
  planned: "待提交",
  submitted: "生成中",
  outcome_unknown: "结果未知",
  failed: "失败",
  none: "无封面"
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

function candidateFingerprint(item: GeneratedVideo) {
  return `${item.generatedVideoId}:${item.updatedAt || item.status}:${item.visualComparisonCapable}:${item.phoneReview?.reviewedAt || ""}`;
}

function sameTaskContent(current: Task | null, next: Task) {
  return current === next || Boolean(current && JSON.stringify(current) === JSON.stringify(next));
}

function comparisonReason(reason: string) {
  return PREFLIGHT_REASON_LABELS[reason] || reason || "预检没有返回可用原因。";
}

function engineLabel(engine: GeneratedVideo["actualEngine"] | GeneratedVideo["requestedEngine"]) {
  return engine === "remotion" ? "Remotion" : engine === "ffmpeg" ? "FFmpeg" : "待生成";
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

export function CreativeWorkspacePage({ onBackToProduct }: { onBackToProduct?: () => void } = {}) {
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [mode, setMode] = useState<"course" | "mix">("course");
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
  const [packagingMode, setPackagingMode] = useState<PackagingMode>("auto");
  const [packagingPresetId, setPackagingPresetId] = useState("");
  const [packagingPresets, setPackagingPresets] = useState<PackagingPreset[]>([]);
  const [brandProfiles, setBrandProfiles] = useState<BrandProfile[]>([]);
  const [brandProfileId, setBrandProfileId] = useState("");
  // 首轮真实验收默认走 Remotion-only；若本机运行时不可用，任务会明确失败，
  // 不把普通 FFmpeg 回退结果当成验收样片。
  const [highQualityPackaging, setHighQualityPackaging] = useState(true);
  const [generationCostEstimate, setGenerationCostEstimate] = useState<GenerationCostEstimate | null>(null);
  const [visualStylePreference, setVisualStylePreference] = useState<VisualStylePreference>("auto_disperse");
  const [comparisonPreflight, setComparisonPreflight] = useState<ComparisonPreflightState>(EMPTY_COMPARISON_PREFLIGHT);
  const [comparisonSubmittedTaskId, setComparisonSubmittedTaskId] = useState("");
  const [unqualifiedComparisonGroups, setUnqualifiedComparisonGroups] = useState<string[]>([]);
  const [brandDraft, setBrandDraft] = useState({
    name: "", logoAssetId: "", referenceAssetId: "",
    primaryColor: "#6D5DFB", accentColor: "#FFE45C",
    fontPreset: "microsoft_yahei" as BrandProfile["fontPreset"], outroText: ""
  });
  const [currentTaskId, setCurrentTaskId] = useState("");
  const [currentTask, setCurrentTask] = useState<Task | null>(null);
  const [projectId, setProjectId] = useState("");
  const [project, setProject] = useState<CreativeProject | null>(null);
  const [videos, setVideos] = useState<GeneratedVideo[]>([]);
  const [selectedVideos, setSelectedVideos] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [taskActionBusy, setTaskActionBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);
  const [keyStatus, setKeyStatus] = useState<BailianStatus | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [apiHostInput, setApiHostInput] = useState("");
  const taskMutationRef = useRef<string>("");
  const taskGenerationRef = useRef(0);
  const activeTaskIdRef = useRef("");
  const activeProjectIdRef = useRef("");
  const videoLoadGateRef = useRef(new LatestRequestGate());
  const taskActionGateRef = useRef(new SerializedMutationGate());
  const comparisonRequestRef = useRef(0);
  const comparisonSubmitRef = useRef(false);
  const comparisonSubmitButtonRef = useRef<HTMLButtonElement | null>(null);
  const taskStatusRef = useRef<HTMLElement | null>(null);

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
  const imageAssets = useMemo(
    () => usableAssets.filter((item) => item.mediaKind === "image"),
    [usableAssets]
  );
  const compatiblePresets = useMemo(
    () => packagingPresets.filter((item) => item.kind === mode),
    [mode, packagingPresets]
  );
  const selectedVoiceAssets = useMemo(
    // Preserve the user's selection order. The first checked video becomes
    // the default voice track instead of whichever asset happens to sort first
    // in the library.
    () => mixAssetIds
      .map((assetId) => audioVideoAssets.find((item) => item.assetId === assetId))
      .filter((item): item is Asset => Boolean(item)),
    [audioVideoAssets, mixAssetIds]
  );
  const selectedAssetIds = mode === "course"
    ? (courseAssetId ? [courseAssetId] : [])
    : mixAssetIds;
  const effectiveCoverMode: CoverMode = packagingMode === "none" ? "none" : "ai_generate";
  const visualComparisonCapable = engine?.capabilities?.visual_comparison_v1 === true;
  const remotionPackagingCapable = engine?.capabilities?.remotion_packaging_v1 === true;

  const comparisonGroups = useMemo(() => {
    const byId = new Map<string, GeneratedVideo[]>();
    for (const item of videos) {
      if (!item.comparisonGroupId) continue;
      const current = byId.get(item.comparisonGroupId) || [];
      current.push(item);
      byId.set(item.comparisonGroupId, current);
    }
    const styleOrder: VisualStyleId[] = ["social_pop", "neo_editorial", "tech_motion"];
    return [...byId.entries()].map(([groupId, variants]) => {
      const sourceCandidateId = variants[0]?.comparisonSourceCandidateId || "";
      return {
        groupId,
        sourceCandidateId,
        source: videos.find((item) => item.generatedVideoId === sourceCandidateId) || null,
        variants: [...variants].sort((left, right) => (
          styleOrder.indexOf(left.requestedStyleId || "social_pop")
          - styleOrder.indexOf(right.requestedStyleId || "social_pop")
        ))
      };
    });
  }, [videos]);

  const standaloneVideos = useMemo(() => {
    const groupedIds = new Set<string>();
    for (const group of comparisonGroups) {
      groupedIds.add(group.sourceCandidateId);
      for (const variant of group.variants) groupedIds.add(variant.generatedVideoId);
    }
    return videos.filter((item) => !groupedIds.has(item.generatedVideoId));
  }, [comparisonGroups, videos]);

  function beginTaskMutation(key: string) {
    if (taskMutationRef.current) return false;
    taskMutationRef.current = key;
    setBusy(key);
    return true;
  }

  function releaseTaskMutation(expectedKey?: string) {
    if (expectedKey !== undefined && taskMutationRef.current !== expectedKey) return;
    taskMutationRef.current = "";
    setBusy("");
  }

  function trackTask(taskId: string, task: Task | null) {
    taskGenerationRef.current += 1;
    activeTaskIdRef.current = taskId;
    videoLoadGateRef.current.invalidate();
    taskActionGateRef.current.invalidate();
    setTaskActionBusy(false);
    releaseTaskMutation();
    setCurrentTaskId(taskId);
    setCurrentTask(task);
  }

  function trackProject(nextProjectId: string) {
    activeProjectIdRef.current = nextProjectId;
    videoLoadGateRef.current.invalidate();
    setProjectId(nextProjectId);
  }

  const invalidateComparisonPreflight = useCallback(() => {
    comparisonRequestRef.current += 1;
    comparisonSubmitRef.current = false;
    setComparisonPreflight(EMPTY_COMPARISON_PREFLIGHT);
    setComparisonSubmittedTaskId("");
  }, []);

  const loadVideos = useCallback(async (targetProjectId?: string) => {
    const api = apiForWindow();
    if (!api?.creative) return;
    const requestedProjectId = targetProjectId ?? activeProjectIdRef.current;
    if (!requestedProjectId) {
      // The workbench is project-scoped. Without an active generation project,
      // showing every historical candidate makes old cards look like new output.
      setVideos([]);
      return;
    }
    const requestScope = `${requestedProjectId}|${taskGenerationRef.current}`;
    const requestToken = videoLoadGateRef.current.begin(requestScope);
    const result = await api.creative.listGenerated({
      ...(requestedProjectId ? { projectId: requestedProjectId } : {}),
      limit: 500
    });
    if (!result.ok || !result.data) return;
    const currentScope = `${activeProjectIdRef.current}|${taskGenerationRef.current}`;
    if (!videoLoadGateRef.current.accepts(requestToken, currentScope)) return;
    setVideos(result.data.items);
  }, []);

  const loadFoundation = useCallback(async () => {
    const api = apiForWindow();
    if (!api) return;
    const [status, library, bailian, presets, brands] = await Promise.all([
      api.status(),
      api.library.list({ limit: 500 }),
      api.settings.volcengineArkStatus(),
      api.creative.listPackagingPresets(),
      api.creative.listBrandProfiles()
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
    if (bailian.ok && bailian.data) {
      setKeyStatus(bailian.data);
      setApiHostInput(bailian.data.apiHost || "");
    }
    setPackagingPresets(presets.data?.items || []);
    if (brands.ok && brands.data) setBrandProfiles(brands.data.items);
  }, []);

  useEffect(() => {
    void loadFoundation();
    void loadVideos();
  }, [loadFoundation, loadVideos]);

  useEffect(() => {
    let active = true;
    const recoverRecentCreativeTask = async () => {
      const api = apiForWindow();
      if (!api) return;
      const result = await api.tasks.list({ limit: 500 });
      if (!active || taskGenerationRef.current !== 0 || !result.ok || !result.data) return;
      const recent = result.data.items.find((item) => (
        RECOVERABLE_CREATIVE_TASKS.has(item.taskType)
        && RECOVERABLE_TASK_STATUSES.has(item.status)
      ));
      if (!recent) return;
      if (recent.projectId) {
        trackProject(recent.projectId);
        const [projectResult] = await Promise.all([
          api.creative.getProject({ projectId: recent.projectId }),
          loadVideos(recent.projectId)
        ]);
        if (projectResult.ok && projectResult.data) setProject(projectResult.data);
      }
      activeTaskIdRef.current = recent.taskId;
      setCurrentTask(recent);
      if (recent.status !== "paused") trackTask(recent.taskId, recent);
    };
    void recoverRecentCreativeTask();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (mode !== "mix") return;
    setVoiceAssetId((current) => selectedVoiceAssets.some(
      (item) => item.assetId === current
    ) ? current : selectedVoiceAssets[0]?.assetId || "");
  }, [mode, selectedVoiceAssets]);

  useEffect(() => {
    if (packagingMode !== "preset") return;
    if (!compatiblePresets.some((item) => item.presetId === packagingPresetId)) {
      setPackagingPresetId(compatiblePresets[0]?.presetId || "");
    }
  }, [compatiblePresets, packagingMode, packagingPresetId]);

  const handlePackagingModeChange = (nextMode: PackagingMode) => {
    setPackagingMode(nextMode);
    if (nextMode === "none") setHighQualityPackaging(false);
  };

  useEffect(() => {
    invalidateComparisonPreflight();
  }, [
    brandProfileId,
    highQualityPackaging,
    invalidateComparisonPreflight,
    mode,
    packagingMode,
    packagingPresetId,
    visualStylePreference
  ]);

  useEffect(() => {
    if (!comparisonPreflight.candidateId) return;
    const candidate = videos.find(
      (item) => item.generatedVideoId === comparisonPreflight.candidateId
    );
    if (!candidate
      || candidateFingerprint(candidate) !== comparisonPreflight.candidateFingerprint) {
      invalidateComparisonPreflight();
    }
  }, [comparisonPreflight.candidateFingerprint, comparisonPreflight.candidateId, invalidateComparisonPreflight, videos]);

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
    const taskGeneration = taskGenerationRef.current;
    const isCurrent = () => active && taskGenerationRef.current === taskGeneration;
    const poll = async () => {
      if (polling) return;
      polling = true;
      const api = apiForWindow();
      try {
        if (!api) return;
        const result = await api.tasks.list({ limit: 500 });
        const task = result.data?.items.find((item) => item.taskId === currentTaskId);
        if (!isCurrent() || !task) return;
        setCurrentTask((current) => sameTaskContent(current, task) ? current : task);
        if (TERMINAL_TASKS.has(task.status)) {
          const isAnalysisTask = task.taskType === "creative_analysis";
          const terminalGeneration = taskGenerationRef.current + 1;
          taskGenerationRef.current = terminalGeneration;
          activeTaskIdRef.current = "";
          videoLoadGateRef.current.invalidate();
          taskActionGateRef.current.invalidate();
          setTaskActionBusy(false);
          setCurrentTaskId("");
          taskMutationRef.current = "";
          setBusy("");
          if (task.status === "completed" && isAnalysisTask) {
            const summary = task.analysisSummary;
            setNotice({
              tone: "success",
              text: summary
                ? `素材分析完成（${summary.analyzedCount}/${summary.requestedCount}），请点击“AI 自动生成”制作新成片。`
                : "素材分析完成，请点击“AI 自动生成”制作新成片。"
            });
          } else if (task.status === "completed") {
            setNotice({ tone: "success", text: "AI 处理完成，成片已经可以播放和内部验收。" });
          } else if (task.status === "failed") {
            setNotice({ tone: "error", text: task.errorMessage || task.errorCode || "AI 处理失败。" });
          } else if (task.status === "paused") {
            setNotice({ tone: "info", text: "任务已暂停；已完成的候选仍可播放，继续时只处理剩余候选。" });
          } else {
            setNotice({ tone: "info", text: "任务已取消；已完成的候选仍保留。" });
          }
          if (isAnalysisTask) {
            // Analysis creates reusable segments, not generated videos. Clear
            // the previous project's cards so old candidates are not mistaken
            // for output from the just-finished analysis.
            activeProjectIdRef.current = "";
            setProjectId("");
            setProject(null);
            setVideos([]);
          } else {
            await loadVideos(projectId || undefined);
          }
          if (taskGenerationRef.current !== terminalGeneration) return;
          let taskProject: CreativeProject | null = null;
          if (projectId) {
            const projectResult = await api.creative.getProject({ projectId });
            if (taskGenerationRef.current !== terminalGeneration) return;
            if (projectResult.ok && projectResult.data) {
              taskProject = projectResult.data;
              setProject(projectResult.data);
            }
          }
          if (task.status === "failed") {
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
    if (!beginTaskMutation("analyze")) return;
    setNotice(null);
    try {
      const result = await api.creative.analyzeAssets({ assetIds: selectedAssetIds });
      if (!result.ok || !result.data) {
        releaseTaskMutation();
        setNotice({ tone: "error", text: failure(result, "无法开始素材分析。") });
        return;
      }
      // Keep the result area scoped to the next generation. An analysis task
      // only updates reusable segments; it must not display older candidates.
      trackProject("");
      setProject(null);
      setVideos([]);
      trackTask(result.data.taskId, result.data);
    } catch {
      releaseTaskMutation();
      setNotice({ tone: "error", text: "无法开始素材分析。" });
    }
  }

  async function generate() {
    const api = apiForWindow();
    if (!api || !selectedAssetIds.length) return;
    if (mode === "course" && (minimumSeconds < 30 || maximumSeconds > 90 || minimumSeconds > maximumSeconds)) {
      setNotice({ tone: "error", text: "课程成片时长必须在 30～90 秒之间，且最短不能大于最长。" });
      return;
    }
    if (mode === "mix" && !selectedVoiceAssets.some((item) => item.assetId === voiceAssetId)) {
      setNotice({ tone: "error", text: "请从已选素材中选择一条带声音的视频作为老师原声。" });
      return;
    }
    const snapshot = {
      mode,
      courseAssetId,
      mixAssetIds: [...mixAssetIds],
      voiceAssetId,
      pilotMode: mode === "mix",
      theme,
      courseCount,
      mixCount,
      minimumSeconds,
      maximumSeconds,
      subtitleFontSize,
      subtitleMarginBottom,
      packagingMode,
      packagingPresetId,
      brandProfileId,
      coverMode: effectiveCoverMode,
      visualRenderer: highQualityPackaging && packagingMode !== "none"
        ? {
            requestedEngine: "remotion" as const,
            ...(visualStylePreference === "auto_disperse"
              ? {}
              : { visualStyleId: visualStylePreference }),
            requestedStyleVersion: 1 as const,
            // Normal generation tries Remotion first, then uses the proven
            // local FFmpeg path if the browser/worker is unavailable. The
            // actual engine and fallback reason are persisted on the card;
            // only the dedicated three-style comparison remains fail-closed.
            allowFallback: true
          }
        : undefined
    };
    if (!beginTaskMutation("generate")) return;
    setNotice(null);
    try {
      const estimate = await api.creative.getPackagingCostEstimate({
        candidateIds: [],
        coverMode: snapshot.coverMode,
        packagingMode: snapshot.packagingMode,
        plannedCount: snapshot.mode === "course" ? snapshot.courseCount : snapshot.mixCount,
        assetIds: snapshot.mode === "course" ? [snapshot.courseAssetId] : snapshot.mixAssetIds,
        generationKind: snapshot.mode
      });
      if (!estimate.ok || !estimate.data) {
        releaseTaskMutation();
        setNotice({ tone: "error", text: failure(estimate, "无法完成云端调用预检，本次未提交。") });
        return;
      }
      setGenerationCostEstimate(estimate.data);
      if (estimate.data.bailianCalls > 0 && !estimate.data.bailianProviderConfigured) {
        releaseTaskMutation();
        setNotice({ tone: "error", text: "火山方舟尚未配置，本次没有提交云端任务。请先保存方舟 API Key。" });
        return;
      }
      if (estimate.data.confirmationRequired) {
        const bailian = estimate.data.bailianBreakdown
          .filter((item) => item.estimatedCalls > 0)
          .map((item) => `${item.label} ${item.estimatedCalls} 次`)
          .join("、") || "无";
        const apimart = estimate.data.estimatedImageCalls;
        const confirmed = window.confirm(
          `本次会先执行云端预检显示的阶段：${bailian}；AI 封面 ${apimart} 次。\n已缓存阶段不会重复调用；价格以服务商最终账单为准。确认继续吗？`
        );
        if (!confirmed) {
          releaseTaskMutation();
          setNotice({ tone: "info", text: "你已取消本次生成，没有提交云端任务。" });
          return;
        }
      }
      if (snapshot.coverMode === "ai_generate") {
        const plannedCount = snapshot.mode === "course" ? snapshot.courseCount : snapshot.mixCount;
      if (!estimate.data.providerConfigured) {
        releaseTaskMutation();
        setNotice({
          tone: "error",
          text: "APIMart 尚未启用。请先在 API 密钥中保存 APIMart Key。"
        });
        return;
      }
      if (estimate.data.estimatedImageCalls !== plannedCount) {
        releaseTaskMutation();
        setNotice({ tone: "error", text: "APIMart 调用次数预检不一致，本次未提交。" });
        return;
      }
    }
    const packagingOptions = {
      packagingMode: snapshot.packagingMode,
      ...(snapshot.packagingMode === "preset" ? { packagingPresetId: snapshot.packagingPresetId } : {}),
      ...(snapshot.brandProfileId ? { brandProfileId: snapshot.brandProfileId } : {}),
      coverMode: snapshot.coverMode,
      confirmPaidCalls: true,
      ...(snapshot.visualRenderer
        ? { visualRenderer: snapshot.visualRenderer }
        : {})
    };
    const result = snapshot.mode === "course"
      ? await api.creative.generateCourseCuts({
        assetId: snapshot.courseAssetId,
        minDurationMs: snapshot.minimumSeconds * 1000,
        maxDurationMs: snapshot.maximumSeconds * 1000,
        count: snapshot.courseCount,
        theme: snapshot.theme,
        subtitleFontSize: snapshot.subtitleFontSize,
        subtitleMarginBottom: snapshot.subtitleMarginBottom,
        ...packagingOptions
      })
      : await api.creative.generateMixBatch({
        assetIds: snapshot.mixAssetIds,
        theme: snapshot.theme,
        targetCount: snapshot.mixCount,
        voiceAssetId: snapshot.voiceAssetId,
        pilotMode: snapshot.pilotMode,
        ...packagingOptions
      });
    if (!result.ok || !result.data) {
      releaseTaskMutation();
      setNotice({ tone: "error", text: failure(result, "无法开始生成。") });
      return;
    }
    trackProject(result.data.projectId);
    setProject(null);
    setVideos([]);
    trackTask(result.data.taskId, null);
    } catch {
      releaseTaskMutation();
      setNotice({ tone: "error", text: "无法开始生成。" });
    }
  }

  async function preflightVisualComparison(item: GeneratedVideo) {
    const api = apiForWindow();
    if (!api) return;
    if (comparisonPreflight.candidateId === item.generatedVideoId
      && comparisonSubmitRef.current) return;
    const fingerprint = candidateFingerprint(item);
    const requestGeneration = comparisonRequestRef.current + 1;
    comparisonRequestRef.current = requestGeneration;
    comparisonSubmitRef.current = false;
    setComparisonSubmittedTaskId("");
    setComparisonPreflight({
      candidateId: item.generatedVideoId,
      candidateFingerprint: fingerprint,
      status: "checking",
      details: null,
      reason: ""
    });
    if (!visualComparisonCapable || !item.visualComparisonCapable) {
      setComparisonPreflight({
        candidateId: item.generatedVideoId,
        candidateFingerprint: fingerprint,
        status: "blocked",
        details: {
          eligible: false,
          reason: "remotion_capability_unavailable",
          renderCount: 3,
          bailianCalls: 0,
          apimartCalls: 0,
          remotionAvailable: false,
          visualComparisonAvailable: false
        },
        reason: "remotion_capability_unavailable"
      });
      return;
    }
    try {
      const result = await api.creative.preflightVisualComparison({
        candidateId: item.generatedVideoId
      });
      if (comparisonRequestRef.current !== requestGeneration) return;
      if (!result.ok || !result.data) {
        setComparisonPreflight({
          candidateId: item.generatedVideoId,
          candidateFingerprint: fingerprint,
          status: "error",
          details: null,
          reason: failure(result, "三风格预检失败。")
        });
        return;
      }
      setComparisonPreflight({
        candidateId: item.generatedVideoId,
        candidateFingerprint: fingerprint,
        status: result.data.eligible ? "ready" : "blocked",
        details: result.data,
        reason: result.data.reason
      });
      if (result.data.eligible) {
        window.setTimeout(() => comparisonSubmitButtonRef.current?.focus(), 0);
      }
    } catch {
      if (comparisonRequestRef.current !== requestGeneration) return;
      setComparisonPreflight({
        candidateId: item.generatedVideoId,
        candidateFingerprint: fingerprint,
        status: "error",
        details: null,
        reason: "三风格预检失败。"
      });
    }
  }

  async function createVisualComparison(item: GeneratedVideo) {
    const api = apiForWindow();
    if (!api
      || comparisonPreflight.status !== "ready"
      || comparisonPreflight.candidateId !== item.generatedVideoId
      || comparisonSubmitRef.current
      || comparisonSubmittedTaskId) return;
    comparisonSubmitRef.current = true;
    if (!beginTaskMutation("comparison-create")) {
      comparisonSubmitRef.current = false;
      return;
    }
    try {
      const result = await api.creative.createVisualComparisonTask({
        candidateId: item.generatedVideoId
      });
      if (!result.ok || !result.data?.taskId) {
        comparisonSubmitRef.current = false;
        releaseTaskMutation();
        setNotice({ tone: "error", text: failure(result, "无法创建三风格对照任务。") });
        return;
      }
      setComparisonSubmittedTaskId(result.data.taskId);
      trackProject(item.projectId);
      trackTask(result.data.taskId, result.data);
      await loadVideos(item.projectId);
      setNotice({
        tone: "info",
        text: "已创建 1 个三风格对照任务：复用原选段、声音、编导计划与 AI 封面，不调用云端模型或 APIMart。"
      });
      window.setTimeout(() => taskStatusRef.current?.focus(), 0);
    } catch {
      comparisonSubmitRef.current = false;
      releaseTaskMutation();
      setNotice({ tone: "error", text: "无法创建三风格对照任务。" });
    }
  }

  async function taskAction(action: "pause" | "resume" | "cancel") {
    const api = apiForWindow();
    const taskId = currentTask?.taskId || currentTaskId;
    if (!api || !taskId) return;
    const taskGeneration = taskGenerationRef.current;
    const requestScope = `${taskId}|${taskGeneration}`;
    const requestToken = taskActionGateRef.current.begin(requestScope);
    if (!requestToken) return;
    const mutationKey = `task-action-${action}-${taskId}`;
    if (!beginTaskMutation(mutationKey)) {
      taskActionGateRef.current.finish(requestToken);
      return;
    }
    setTaskActionBusy(true);
    try {
      const result = await api.tasks[action]({ taskId });
      const currentScope = `${activeTaskIdRef.current || taskId}|${taskGenerationRef.current}`;
      if (!taskActionGateRef.current.accepts(requestToken, currentScope)) return;
      if (result.ok && result.data) {
        setCurrentTask(result.data);
        if (action === "resume") trackTask(taskId, result.data);
        else if (TERMINAL_TASKS.has(result.data.status)) {
          taskGenerationRef.current += 1;
          activeTaskIdRef.current = "";
          videoLoadGateRef.current.invalidate();
          setCurrentTaskId("");
          taskMutationRef.current = "";
          setBusy("");
          setNotice({
            tone: "info",
            text: result.data.status === "paused"
              ? "任务已暂停；已完成的候选仍可播放。"
              : "任务已取消；已完成的候选仍保留。"
          });
          await loadVideos(projectId || undefined);
        }
      } else {
        setNotice({ tone: "error", text: failure(result, "任务状态更新失败。") });
      }
    } catch {
      const currentScope = `${activeTaskIdRef.current || taskId}|${taskGenerationRef.current}`;
      if (taskActionGateRef.current.accepts(requestToken, currentScope)) {
        setNotice({ tone: "error", text: "任务状态更新失败。" });
      }
    } finally {
      if (taskActionGateRef.current.finish(requestToken)) {
        setTaskActionBusy(false);
        releaseTaskMutation(mutationKey);
      }
    }
  }

  async function saveKey() {
    const api = apiForWindow();
    if (!api || !keyInput.trim()) return;
    setBusy("key");
    const result = await api.settings.saveVolcengineArkKey({
      apiKey: keyInput.trim(),
      apiHost: apiHostInput.trim()
    });
    setBusy("");
    if (result.ok && result.data) {
      setKeyStatus(result.data);
      setKeyInput("");
      setNotice({ tone: "success", text: "方舟 Key 已用当前 Windows 账户加密保存，内容引擎已重启。" });
    } else {
      setNotice({ tone: "error", text: failure(result, "方舟 Key 保存失败。") });
    }
  }

  async function saveBrandProfile() {
    const api = apiForWindow();
    if (!api || !brandDraft.name.trim()) return;
    setBusy("brand");
    const result = await api.creative.saveBrandProfile({
      name: brandDraft.name.trim(),
      ...(brandDraft.logoAssetId ? { logoAssetId: brandDraft.logoAssetId } : {}),
      ...(brandDraft.referenceAssetId ? { referenceAssetId: brandDraft.referenceAssetId } : {}),
      primaryColor: brandDraft.primaryColor,
      accentColor: brandDraft.accentColor,
      fontPreset: brandDraft.fontPreset,
      outroText: brandDraft.outroText.trim()
    });
    setBusy("");
    if (!result.ok || !result.data) {
      setNotice({ tone: "error", text: failure(result, "品牌包保存失败。") });
      return;
    }
    const profiles = await api.creative.listBrandProfiles();
    if (profiles.ok && profiles.data) setBrandProfiles(profiles.data.items);
    setBrandProfileId(result.data.brandProfileId);
    setNotice({ tone: "success", text: "品牌包已保存，后续成片会复用统一颜色、字体和片尾签名。" });
  }

  async function repackage(item: GeneratedVideo) {
    const api = apiForWindow();
    if (!api) return;
    const key = `repackage-${item.generatedVideoId}`;
    if (!beginTaskMutation(key)) return;
    try {
      const result = await api.creative.repackageVideo({
        candidateId: item.generatedVideoId,
        packagingMode,
        ...(packagingMode === "preset" ? { packagingPresetId } : {}),
        ...(brandProfileId ? { brandProfileId } : {}),
        coverMode: effectiveCoverMode
      });
      if (!result.ok || !result.data?.taskId) {
        releaseTaskMutation();
        setNotice({ tone: "error", text: failure(result, "换包装失败。") });
        return;
      }
      trackTask(result.data.taskId, result.data);
      setNotice({ tone: "info", text: "正在复用原选段和封面生成新包装，不会重新调用云端模型或 APIMart。" });
    } catch {
      releaseTaskMutation();
      setNotice({ tone: "error", text: "换包装失败。" });
    }
  }

  async function regenerateCover(item: GeneratedVideo) {
    const api = apiForWindow();
    if (!api) return;
    const key = `cover-${item.generatedVideoId}`;
    if (!beginTaskMutation(key)) return;
    try {
      const estimate = await api.creative.getPackagingCostEstimate({
        candidateIds: [item.generatedVideoId],
        coverMode: "ai_generate",
        packagingMode: "auto"
      });
      if (!estimate.ok || estimate.data?.estimatedImageCalls !== 1 || !estimate.data.providerConfigured) {
        releaseTaskMutation();
        setNotice({ tone: "error", text: estimate.ok
          ? "APIMart 尚未启用，本次没有提交付费任务。"
          : failure(estimate, "无法估算封面调用。") });
        return;
      }
      const result = await api.creative.regenerateCover({ candidateId: item.generatedVideoId });
      if (!result.ok || !result.data?.taskId) {
        releaseTaskMutation();
        setNotice({ tone: "error", text: failure(result, "重做封面失败。") });
        return;
      }
      trackTask(result.data.taskId, result.data);
      setNotice({ tone: "info", text: "已提交 1 次 APIMart 封面任务；结果不明时系统不会自动重提。" });
    } catch {
      releaseTaskMutation();
      setNotice({ tone: "error", text: "重做封面失败。" });
    }
  }

  async function regenerate(item: GeneratedVideo) {
    const api = apiForWindow();
    if (!api) return;
    const key = `regenerate-${item.generatedVideoId}`;
    if (!beginTaskMutation(key)) return;
    try {
      const result = await api.creative.regenerate({ candidateId: item.generatedVideoId });
      if (!result.ok || !result.data?.taskId) {
        releaseTaskMutation();
        setNotice({ tone: "error", text: failure(result, "重新生成失败。") });
        return;
      }
      trackTask(result.data.taskId, null);
      setNotice({ tone: "info", text: "重新生成任务已开始，完成后会自动刷新成片。" });
    } catch {
      releaseTaskMutation();
      setNotice({ tone: "error", text: "重新生成失败。" });
    }
  }

  async function recordPhoneReview(item: GeneratedVideo) {
    const api = apiForWindow();
    if (!api || item.status !== "completed") return;
    if (item.requestedEngine !== "remotion" || item.actualEngine !== "remotion") {
      setNotice({ tone: "info", text: "只有实际使用 Remotion 的首条成片可以记录为手机验收样片。" });
      return;
    }
    const key = `review-${item.generatedVideoId}`;
    if (!beginTaskMutation(key)) return;
    try {
      const result = await api.creative.recordMediaReview({
        candidateId: item.generatedVideoId,
        device: "phone",
        verdict: "pass",
        reason: "手机竖屏查看：人物、课件、字幕、音画同步与封面通过内部验收。"
      });
      if (!result.ok) {
        setNotice({ tone: "error", text: failure(result, "无法记录手机验收结果。") });
        return;
      }
      await loadVideos(projectId || undefined);
      setNotice({ tone: "success", text: "已记录手机验收通过；现在可以做三风格本地对照。" });
    } catch {
      setNotice({ tone: "error", text: "无法记录手机验收结果。" });
    } finally {
      releaseTaskMutation();
    }
  }

  async function reject(item: GeneratedVideo) {
    const api = apiForWindow();
    if (!api) return;
    if (!beginTaskMutation(`reject-${item.generatedVideoId}`)) return;
    try {
      const result = await api.creative.reject({ candidateId: item.generatedVideoId });
      if (!result.ok) setNotice({ tone: "error", text: failure(result, "淘汰成片失败。") });
      else await loadVideos(projectId || undefined);
    } catch {
      setNotice({ tone: "error", text: "淘汰成片失败。" });
    } finally {
      releaseTaskMutation();
    }
  }

  async function queueSelected(ids: string[]) {
    const api = apiForWindow();
    if (!api || !ids.length) return;
    if (!beginTaskMutation("queue-selected")) return;
    try {
      const result = await api.creative.queue({ candidateIds: ids, channel: "internal" });
      if (result.ok) {
        setSelectedVideos([]);
        setNotice({ tone: "success", text: `已接受 ${ids.length} 条成片并加入内部队列；不会自动发布。` });
      } else {
        setNotice({ tone: "error", text: failure(result, "加入内部队列失败。") });
      }
    } catch {
      setNotice({ tone: "error", text: "加入内部队列失败。" });
    } finally {
      releaseTaskMutation();
    }
  }

  async function packageSelected(ids: string[]) {
    const api = apiForWindow();
    if (!api || !ids.length) return;
    if (!beginTaskMutation("package-selected")) return;
    try {
      const result = await api.creative.packageGeneratedVideos({
        candidateIds: ids,
        packagingMode,
        ...(packagingMode === "preset" ? { packagingPresetId } : {}),
        ...(brandProfileId ? { brandProfileId } : {}),
        coverMode: effectiveCoverMode,
        reuseCover: true
      });
      if (!result.ok || !result.data?.taskId) {
        releaseTaskMutation();
        setNotice({ tone: "error", text: failure(result, "批量换包装失败。") });
        return;
      }
      trackTask(result.data.taskId, result.data);
      setNotice({ tone: "info", text: `正在为 ${ids.length} 条历史成片生成新包装；复用封面且不增加云端调用。` });
    } catch {
      releaseTaskMutation();
      setNotice({ tone: "error", text: "批量换包装失败。" });
    }
  }

  async function markComparisonGroupUnqualified(groupId: string, candidateIds: string[]) {
    const api = apiForWindow();
    if (!api || !candidateIds.length || unqualifiedComparisonGroups.includes(groupId)) return;
    if (!beginTaskMutation(`reject-group-${groupId}`)) return;
    try {
      const results = await Promise.all(candidateIds.map((candidateId) => (
        api.creative.reject({ candidateId })
      )));
      const failureResult = results.find((result) => !result.ok);
      if (failureResult) {
        setNotice({ tone: "error", text: failure(failureResult, "无法记录本组验收结论。") });
        return;
      }
      setUnqualifiedComparisonGroups((current) => [...current, groupId]);
      setSelectedVideos((current) => current.filter((id) => !candidateIds.includes(id)));
      await loadVideos(projectId || undefined);
      setNotice({
        tone: "info",
        text: "已记录“本组均不达标”：三条变体均标记为淘汰，原 FFmpeg 基线保持只读，也不会进入真实发布。"
      });
    } catch {
      setNotice({ tone: "error", text: "无法记录本组验收结论。" });
    } finally {
      releaseTaskMutation();
    }
  }

  function renderComparisonPreflight(item: GeneratedVideo) {
    if (comparisonPreflight.candidateId !== item.generatedVideoId) return null;
    const details = comparisonPreflight.details;
    const submitted = Boolean(comparisonSubmittedTaskId);
    return <div
      className={`workspace-comparison-preflight is-${comparisonPreflight.status}`}
      role="status"
      aria-live="polite"
      tabIndex={-1}
    >
      <div className="workspace-comparison-costs">
        <span>模型 0 次</span>
        <span>APIMart 0 次</span>
        <span>本地渲染 3 次</span>
      </div>
      <p>
        Remotion：{details?.remotionAvailable ? "可用" : comparisonPreflight.status === "checking" ? "检查中" : "不可用"}
        {comparisonPreflight.status === "checking" && " · 正在检查来源成片、AI 封面和编导计划…"}
        {comparisonPreflight.status === "ready" && ` · ${comparisonReason(comparisonPreflight.reason)}`}
        {comparisonPreflight.status === "blocked" && ` · 已阻止：${comparisonReason(comparisonPreflight.reason)}`}
        {comparisonPreflight.status === "error" && ` · ${comparisonPreflight.reason}`}
      </p>
      {comparisonPreflight.status === "ready" && <button
        ref={comparisonSubmitButtonRef}
        className="workspace-button is-primary"
        onClick={() => void createVisualComparison(item)}
        disabled={Boolean(busy) || submitted}
      >
        {busy === "comparison-create" ? <LoaderCircle className="is-spinning" size={14} /> : <Sparkles size={14} />}
        {submitted ? "已创建 1 个对照任务" : "提交 1 个对照任务"}
      </button>}
    </div>;
  }

  function renderVideoCard(
    item: GeneratedVideo,
    options: { baseline?: boolean; grouped?: boolean } = {}
  ) {
    const aiRecommended = item.recommended
      && ["bailian_editor", "supoclip_bailian_editor"].includes(item.score.selectionEngine || "");
    const localPreselection = item.score.selectionEngine === "local_content_signals";
    const styleVersion = item.actualStyleVersion ?? item.requestedStyleVersion;
    const fallback = item.requestedEngine === "remotion"
      && item.actualEngine === "ffmpeg"
      && Boolean(item.fallbackCode);
    const preferredStyle = visualStylePreference !== "auto_disperse"
      && item.requestedStyleId === visualStylePreference;
    const comparisonUnavailable = !visualComparisonCapable || !item.visualComparisonCapable;
    const comparisonDisabled = !highQualityPackaging
      || comparisonUnavailable
      || item.status !== "completed"
      || !item.previewReady
      || item.phoneReview?.verdict !== "pass"
      || Boolean(busy);
    return <article
      className={`workspace-video-card ${item.recommended ? "is-recommended" : ""} ${options.baseline ? "is-baseline" : ""} ${preferredStyle ? "is-preferred-style" : ""}`}
      key={`${options.baseline ? "baseline" : "candidate"}-${item.generatedVideoId}`}
    >
      <div className="workspace-video-frame">
        {generatedMediaUrl(item)
          ? <video controls preload="metadata" src={generatedMediaUrl(item)} />
          : <div><Clapperboard size={28} /><span>{item.status === "failed" ? "生成失败" : "预览准备中"}</span></div>}
        {options.baseline
          ? <b className="is-baseline">原 FFmpeg 基线</b>
          : aiRecommended
            ? <b>AI 推荐</b>
            : localPreselection
              ? <b className="is-local">本地预筛</b>
              : null}
        {preferredStyle && <b className="is-preferred">查看偏好</b>}
        {!options.baseline && !options.grouped && <label>
          <input
            type="checkbox"
            checked={selectedVideos.includes(item.generatedVideoId)}
            disabled={Boolean(busy)}
            onChange={() => setSelectedVideos((current) => current.includes(item.generatedVideoId)
              ? current.filter((id) => id !== item.generatedVideoId)
              : [...current, item.generatedVideoId])}
          />选择
        </label>}
      </div>
      <div className="workspace-video-body">
        <div><strong>{item.title}</strong><span>{formatDuration(item.durationMs)}{item.score.viralityTotal != null ? ` · 传播参考 ${Math.round(item.score.viralityTotal)}` : item.score?.total != null ? ` · ${localPreselection ? "预筛 " : ""}${Math.round(item.score.total)} 分` : ""}</span></div>
        <small>{item.sourceStartMs != null ? `源时间码 ${formatDuration(item.sourceStartMs)}—${formatDuration(item.sourceEndMs)}` : `AI 语义混剪${item.skeletonId ? ` · 结构 ${item.skeletonId.slice(-8).toUpperCase()}` : ""}`}</small>
        {item.packagingPresetName && <div className="workspace-packaging-meta"><span>{item.packagingPresetName}</span><span>{item.brandProfileId ? "品牌包装" : "中性包装"}</span><span>封面：{COVER_STATUS_LABELS[item.coverStatus || "local"] || item.coverStatus}</span>{item.motionDirectorProvider && <span>AI 编导 · {item.motionEventCount} 个语义事件</span>}</div>}
        <div className="workspace-render-meta">
          {item.visualRendererLegacy
            ? <span className="is-legacy">legacy FFmpeg</span>
            : <>
              <span>请求 {engineLabel(item.requestedEngine)}</span>
              <span>实际 {engineLabel(item.actualEngine)}</span>
              {item.requestedStyleId && <span>视觉 {VISUAL_STYLE_LABELS[item.requestedStyleId]} · v{styleVersion ?? "—"}</span>}
            </>}
          {item.comparisonGroupId && <span>对照组 {item.comparisonGroupId.slice(-6).toUpperCase()}</span>}
        </div>
        {fallback && <div className="workspace-fallback-badge" role="status">
          已回退 FFmpeg · 原因：{FALLBACK_LABELS[item.fallbackCode || ""] || item.fallbackCode}
        </div>}
        {item.score.hook != null && <div className="workspace-score-breakdown is-experiment">
          <span>{item.score.selectionEngine?.includes("bailian") ? "AI 内容参考" : "内容信号参考"}</span>
          <span>钩子 {Math.round(item.score.hook)}/25</span>
          <span>参与度 {Math.round(item.score.engagement || 0)}/25</span>
          <span>内容价值 {Math.round(item.score.value || 0)}/25</span>
          <span>分享性 {Math.round(item.score.shareability || 0)}/25</span>
        </div>}
        {item.score.recommendationReason?.length ? <p className="workspace-recommendation-reason">推荐理由：{item.score.recommendationReason.join(" · ")}</p> : null}
        {!options.baseline && highQualityPackaging && item.status === "completed" && item.phoneReview?.verdict !== "pass" && <p className="workspace-recommendation-reason">先在手机竖屏查看这条 Remotion 成片，再点“手机验收通过”；通过后才会开放三风格对照。</p>}
        {item.errorMessage && <p>{item.errorMessage}</p>}
        {!options.baseline && <div className="workspace-card-actions">
          <button onClick={() => void queueSelected([item.generatedVideoId])} disabled={Boolean(busy) || item.status !== "completed"}><Check size={14} />接受并加入内部队列</button>
          {!options.grouped && item.status === "completed" && item.actualEngine === "remotion" && item.phoneReview?.verdict !== "pass" && <button onClick={() => void recordPhoneReview(item)} disabled={Boolean(busy)}><Check size={14} />手机验收通过</button>}
          {options.grouped ? null : <>
            <button onClick={() => void reject(item)} disabled={Boolean(busy)}><ThumbsDown size={14} />淘汰</button>
            <button onClick={() => void regenerate(item)} disabled={Boolean(busy)}>
              {busy === `regenerate-${item.generatedVideoId}` ? <LoaderCircle className="is-spinning" size={14} /> : <RotateCcw size={14} />}重生成
            </button>
            <button onClick={() => void repackage(item)} disabled={Boolean(busy)}><Sparkles size={14} />换包装</button>
            <button onClick={() => void regenerateCover(item)} disabled={Boolean(busy)}><RefreshCw size={14} />重做封面（1次）</button>
            <button
              onClick={() => void preflightVisualComparison(item)}
              disabled={comparisonDisabled}
              title={!highQualityPackaging
                ? "请先启用高质动态（内测）"
                : comparisonUnavailable
                  ? "本机 Remotion 能力不可用"
                  : "先预检，再创建一个三风格任务"}
            ><Layers3 size={14} />同内容比较三种风格</button>
            <button onClick={() => void apiForWindow()?.creative.reveal({ candidateId: item.generatedVideoId })}><FolderOpen size={14} />定位</button>
          </>}
        </div>}
        {!options.grouped && renderComparisonPreflight(item)}
      </div>
    </article>;
  }

  function toggleMixAsset(assetId: string) {
    setMixAssetIds((current) => current.includes(assetId)
      ? current.filter((item) => item !== assetId)
      : [...current, assetId]);
  }

  const running = Boolean(currentTask && !TERMINAL_TASKS.has(currentTask.status));
  const taskActive = Boolean(currentTaskId) || running;
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
        <div className="workspace-header-actions">
          {onBackToProduct && <button className="workspace-legacy-back" onClick={onBackToProduct}>返回商品一键成片</button>}
          <div className={`workspace-engine-badge ${engineReady ? "is-ready" : "is-failed"}`}>
            <span />{engineReady ? "内容引擎已就绪" : "内容引擎未就绪"}
          </div>
        </div>
      </header>

      {notice && <div
        className={`workspace-banner is-${notice.tone}`}
        role={notice.tone === "error" ? "alert" : "status"}
        aria-live={notice.tone === "error" ? "assertive" : "polite"}
      >
        {notice.tone === "success" ? <Check size={16} /> : <CircleAlert size={16} />}
        {notice.text}
      </div>}

      <div className="workspace-mode-grid">
        <button className={`workspace-mode-card ${mode === "course" ? "is-active" : ""}`} onClick={() => setMode("course")} disabled={Boolean(busy)}>
          <FileVideo2 size={24} /><span><strong>长课程精剪</strong><small>从口播、播客或课程中找出完整观点，生成 30～90 秒竖屏成片。</small></span>
        </button>
        <button className={`workspace-mode-card ${mode === "mix" ? "is-active" : ""}`} onClick={() => setMode("mix")} disabled={Boolean(busy)}>
          <Layers3 size={24} /><span><strong>AI 批量混剪</strong><small>把杂素材交给 AI 自动尝试组合；“开场—过程—结果”只是成片结构，不要求你提前分类上传。</small></span>
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

            {mode === "course" ? (
              <label className="workspace-field">
                <span>课程视频</span>
                <select value={courseAssetId} onChange={(event) => setCourseAssetId(event.target.value)} disabled={Boolean(busy)}>
                  <option value="">请选择一个带声音的视频</option>
                  {audioVideoAssets.map((item) => <option value={item.assetId} key={item.assetId}>
                    {item.displayName} · {formatDuration(item.durationMs)}
                  </option>)}
                </select>
              </label>
            ) : (
              <div className="workspace-assets">
                {usableAssets.map((item) => <label className={mixAssetIds.includes(item.assetId) ? "is-selected" : ""} key={item.assetId}>
                  <input type="checkbox" checked={mixAssetIds.includes(item.assetId)} onChange={() => toggleMixAsset(item.assetId)} disabled={Boolean(busy)} />
                  <span><strong>{item.displayName}</strong><small>{item.mediaKind === "video" ? formatDuration(item.durationMs) : "图片"}</small></span>
                </label>)}
              </div>
            )}
            {!usableAssets.length && <div className="workspace-empty">还没有素材。请选择实验视频或素材文件夹。</div>}
          </section>

          <section className="workspace-panel workspace-generate-panel">
            <div className="workspace-section-head"><div><span>02</span><h2>设置目标并生成</h2></div></div>
            <div className="workspace-form-grid">
              <label className="workspace-field workspace-theme-field"><span>主题</span><input value={theme} maxLength={100} onChange={(event) => setTheme(event.target.value)} disabled={Boolean(busy)} /></label>
              {mode === "course" ? <>
                <label className="workspace-field"><span>最短（秒）</span><input type="number" min={30} max={90} value={minimumSeconds} onChange={(event) => setMinimumSeconds(Number(event.target.value))} disabled={Boolean(busy)} /></label>
                <label className="workspace-field"><span>最长（秒）</span><input type="number" min={30} max={90} value={maximumSeconds} onChange={(event) => setMaximumSeconds(Number(event.target.value))} disabled={Boolean(busy)} /></label>
                <label className="workspace-field"><span>候选数量</span><input type="number" min={1} max={20} value={courseCount} onChange={(event) => setCourseCount(Number(event.target.value))} disabled={Boolean(busy)} /></label>
                <label className="workspace-field"><span>字幕字号</span><select value={subtitleFontSize} onChange={(event) => setSubtitleFontSize(Number(event.target.value))} disabled={Boolean(busy)}><option value={42}>小</option><option value={48}>标准</option><option value={56}>大</option></select></label>
                <label className="workspace-field"><span>字幕位置</span><select value={subtitleMarginBottom} onChange={(event) => setSubtitleMarginBottom(Number(event.target.value))} disabled={Boolean(busy)}><option value={140}>更靠下</option><option value={170}>底部安全区</option><option value={230}>偏上</option></select></label>
              </> : <>
                <label className="workspace-field"><span>成片数量</span><select value={mixCount} onChange={(event) => setMixCount(Number(event.target.value))} disabled={Boolean(busy)}><option value={1}>1 条（单条试跑）</option><option value={5}>5 条（小批验证）</option><option value={30}>30 条（首轮验收）</option><option value={100}>100 条</option><option value={200}>200 条</option><option value={300}>300 条</option></select></label>
                <label className="workspace-field workspace-voice-field"><span>老师原声</span><select value={voiceAssetId} onChange={(event) => setVoiceAssetId(event.target.value)} disabled={Boolean(busy)}><option value="">请选择带声音的视频</option>{selectedVoiceAssets.map((item) => <option value={item.assetId} key={item.assetId}>{item.displayName}</option>)}</select><small>就是这条视频里的原始讲话声，画面切换时用它串起来，不是额外录音。</small></label>
              </>}
            </div>
            <div className="workspace-packaging-box">
              <div className="workspace-section-head"><div><Sparkles size={17} /><h3>一键网感包装</h3></div><small>字幕、动效、构图和音频均在本机完成</small></div>
              <div className="workspace-form-grid">
                <label className="workspace-field"><span>包装方式</span><select value={packagingMode} onChange={(event) => handlePackagingModeChange(event.target.value as PackagingMode)} disabled={Boolean(busy)}><option value="auto">智能分散模板</option><option value="preset">指定模板</option><option value="none">不加包装</option></select></label>
                {packagingMode === "preset" && <label className="workspace-field"><span>模板</span><select value={packagingPresetId} onChange={(event) => setPackagingPresetId(event.target.value)} disabled={Boolean(busy)}>{compatiblePresets.map((item) => <option value={item.presetId} key={item.presetId}>{item.displayName}</option>)}</select></label>}
                <label className="workspace-field"><span>品牌包</span><select value={brandProfileId} onChange={(event) => setBrandProfileId(event.target.value)} disabled={Boolean(busy)}><option value="">中性模板</option>{brandProfiles.map((item) => <option value={item.brandProfileId} key={item.brandProfileId}>{item.name}</option>)}</select></label>
                <label className="workspace-field"><span>封面</span><select value={effectiveCoverMode} disabled><option value="ai_generate">AI 封面（固定）</option><option value="none">不加包装时无封面</option></select></label>
                <label className="workspace-field"><span>高质动态（内测）</span><select value={highQualityPackaging ? "on" : "off"} onChange={(event) => setHighQualityPackaging(event.target.value === "on")} disabled={Boolean(busy)}><option value="off">关闭</option><option value="on" disabled={packagingMode === "none"}>Remotion 优先（失败自动回退）</option></select></label>
                {highQualityPackaging && <label className="workspace-field"><span>视觉风格（HOW）</span><select value={visualStylePreference} onChange={(event) => setVisualStylePreference(event.target.value as VisualStylePreference)} disabled={Boolean(busy)}><option value="auto_disperse">自动分散（默认）</option><option value="social_pop">社交弹跳（social_pop）</option><option value="neo_editorial">新编辑部（neo_editorial）</option><option value="tech_motion">科技动势（tech_motion）</option></select></label>}
              </div>
              <p className={`workspace-cost-note ${effectiveCoverMode === "ai_generate" ? "has-cost" : ""}`}>AI 封面预计调用：<b>{effectiveCoverMode === "ai_generate" ? (mode === "course" ? courseCount : mixCount) : 0}</b> 次 APIMart。每条成片生成 1 张 AI 背景，中文标题与 Logo 仍由本地准确叠加。</p>
              {generationCostEstimate && <p className="workspace-cost-note has-cost">云端预检：云端模型预计 <b>{generationCostEstimate.bailianCalls}</b> 个阶段调用，APIMart <b>{generationCostEstimate.estimatedImageCalls}</b> 次；已缓存的识别阶段不会重复调用。点击生成后会先弹出确认。</p>}
              {mode === "mix" && <p className="workspace-cost-note">当前为试跑模式：你可以直接上传随机素材，AI 会先自动理解、分类并尽量组合；缺少完整“开场—过程—结果”时不会立刻拦截。</p>}
              {highQualityPackaging && <div className="workspace-high-quality-note" role="status" aria-live="polite">
                <strong>{visualComparisonCapable ? "三风格对比能力可用" : "三风格对比能力不可用"}</strong>
                <span>上方包装方式/模板决定内容放什么（WHAT）；视觉风格只决定怎么表现（HOW），两者不会互相覆盖。</span>
                <span>{visualStylePreference === "auto_disperse" ? "普通生成会在三套视觉系统中按候选稳定分散。" : `普通生成将直接使用${VISUAL_STYLE_LABELS[visualStylePreference]}。`} 同时仍可给已有成片做三风格对比。</span>
                <span>{remotionPackagingCapable ? "Remotion 包装运行时已就绪。" : "本机 Remotion 暂不可用时，普通生成会明确回退 FFmpeg 并在成片卡片显示原因；三风格对比仍禁用。"} 高质直出不增加云端模型或 APIMart 调用。</span>
              </div>}
            </div>
            <div className="workspace-generate-actions">
              <button className="workspace-button is-secondary" onClick={() => void analyze()} disabled={!engineReady || !selectedAssetIds.length || taskActive || Boolean(busy)}>
                {busy === "analyze" ? <LoaderCircle className="is-spinning" size={16} /> : <RefreshCw size={16} />}仅分析素材
              </button>
              <button className="workspace-button is-primary" onClick={() => void generate()} disabled={!engineReady || !generationSelectionReady || taskActive || Boolean(busy)}>
                {busy === "generate" ? <LoaderCircle className="is-spinning" size={16} /> : <Sparkles size={16} />}AI 自动生成
              </button>
            </div>
            <p className="workspace-safety-note"><CircleAlert size={15} />包装复用现有分析，不增加云端模型调用；四维传播分只作内容参考，不承诺真实传播效果。首轮仅内部查看，不会自动发布。</p>
          </section>

          {(currentTask || project) && <section
            ref={taskStatusRef}
            className="workspace-panel workspace-progress-panel"
            role="status"
            aria-live="polite"
            tabIndex={-1}
          >
            <div className="workspace-progress-copy">
              <strong>{currentTask?.status === "rendering" ? "正在渲染成片" : currentTask?.status === "analyzing" ? "正在理解素材" : currentTask?.status === "completed" ? "处理完成" : currentTask?.status === "paused" ? "任务已暂停" : currentTask?.status === "failed" ? "任务失败" : currentTask?.status === "cancelled" ? "任务已取消" : "任务处理中"}</strong>
              <span>{Math.round((currentTask?.progress || 0) * 100)}%</span>
            </div>
            <div className="workspace-progress-track"><span style={{ transform: `scaleX(${Math.max(0, Math.min(1, currentTask?.progress || 0))})` }} /></div>
            {currentTask?.status === "failed" && (currentTask.errorMessage || currentTask.errorCode) && (
              <p className="workspace-task-error">
                失败原因：{currentTask.errorMessage || currentTask.errorCode}
              </p>
            )}
            {currentTask?.analysisSummary?.skippedAssets?.length ? (
              <p className="workspace-task-summary">
                已完成 {currentTask.analysisSummary.analyzedCount} / {currentTask.analysisSummary.requestedCount} 个素材；
                {currentTask.analysisSummary.skippedAssets.length} 个素材无法解析，已跳过，其余素材继续处理。
              </p>
            ) : null}
            <div className="workspace-task-actions">
              {running && <button onClick={() => void taskAction("pause")} disabled={taskActionBusy || Boolean(busy)}><Pause size={14} />暂停</button>}
              {currentTask?.status === "paused" && <button onClick={() => void taskAction("resume")} disabled={taskActionBusy || Boolean(busy)}><Play size={14} />继续</button>}
              {running && <button onClick={() => void taskAction("cancel")} disabled={taskActionBusy || Boolean(busy)}><Square size={13} />取消</button>}
            </div>
            {project && <div className="workspace-capacity">
              已生成 <b>{project.generatedCount}</b> / {project.targetCount} 条
              {project.maximumQualifiedCount != null && <span>{project.countIsExact === false ? `已确认至少可生成 ${project.maximumQualifiedCount} 条合格组合（仍有更多组合未计入）` : `当前素材最多可生成 ${project.maximumQualifiedCount} 条合格组合`}</span>}
              {mode === "mix" && project.skeletonCount != null && <span>已识别 {project.skeletonCount} 个内容骨架</span>}
              {project.pilotMode && <span>试跑模式：先用已解析素材生成样片</span>}
              {project.pilotNotice && <span>{project.pilotNotice}</span>}
              {project.missingRoles?.length > 0 && <span>{project.pilotMode ? `试跑提示：暂未找到明确的${project.missingRoles.map((item) => ROLE_LABELS[item] || item).join("、")}，已用可用片段继续` : `缺少：${project.missingRoles.map((item) => ROLE_LABELS[item] || item).join("、")}`}</span>}
            </div>}
          </section>}

          <section className="workspace-panel workspace-results-panel">
            <div className="workspace-section-head">
              <div><span>03</span><h2>成片验收</h2><small>{videos.length ? `${videos.length} 条` : "等待生成"}</small></div>
              {selectedVideos.length > 0 && <div className="workspace-inline-actions"><button onClick={() => void packageSelected(selectedVideos)} disabled={Boolean(busy)}><Sparkles size={14} />换包装（{selectedVideos.length}）</button><button className="workspace-button is-primary" onClick={() => void queueSelected(selectedVideos)} disabled={Boolean(busy)}>接受所选（{selectedVideos.length}）</button></div>}
            </div>
            {videos.length ? <div className="workspace-result-sections">
              {comparisonGroups.map((group) => {
                const unqualified = unqualifiedComparisonGroups.includes(group.groupId)
                  || group.variants.every((item) => item.status === "rejected");
                const canMarkUnqualified = group.variants.length === 3
                  && group.variants.every((item) => ["completed", "failed", "rejected"].includes(item.status));
                return <section className="workspace-comparison-group" key={group.groupId}>
                  <div className="workspace-comparison-group-head">
                    <div>
                      <strong>三风格对照组 {group.groupId.slice(-6).toUpperCase()}</strong>
                      <span>同一内容、声音、编导计划与 AI 封面；仅视觉包装不同。原 FFmpeg 基线不增加渲染或云调用。</span>
                    </div>
                    <button
                      className={unqualified ? "is-selected" : ""}
                      aria-pressed={unqualified}
                      disabled={Boolean(busy) || unqualified || !canMarkUnqualified}
                      onClick={() => void markComparisonGroupUnqualified(
                        group.groupId,
                        group.variants.map((item) => item.generatedVideoId)
                      )}
                    ><ThumbsDown size={14} />{unqualified ? "已记录：本组均不达标" : "本组均不达标"}</button>
                  </div>
                  <div className="workspace-comparison-grid">
                    {group.source
                      ? renderVideoCard(group.source, { baseline: true, grouped: true })
                      : <div className="workspace-empty"><strong>原 FFmpeg 基线暂不可用</strong><span>不会用新渲染冒充基线。</span></div>}
                    {group.variants.map((item) => renderVideoCard(item, { grouped: true }))}
                  </div>
                </section>;
              })}
              {standaloneVideos.length > 0 && <div className="workspace-video-grid">
                {standaloneVideos.map((item) => renderVideoCard(item))}
              </div>}
            </div> : <div className="workspace-empty workspace-empty-results"><Clapperboard size={30} /><strong>成片会出现在这里</strong><span>AI 会保留字幕、选段理由和源时间码供系统追溯。</span></div>}
          </section>
        </main>

        <aside className="workspace-sidebar">
          <section className="workspace-panel workspace-key-panel">
            <div className="workspace-sidebar-title"><KeyRound size={18} /><div><strong>火山方舟 · 素材理解</strong><span>{keyStatus?.configured ? `已配置 ${keyStatus.maskedKey}` : "尚未配置"}</span></div></div>
            <input type="password" value={keyInput} placeholder="火山方舟 API Key" autoComplete="off" onChange={(event) => setKeyInput(event.target.value)} />
            <button className="workspace-button is-primary" onClick={() => void saveKey()} disabled={!keyInput.trim() || Boolean(busy)}>{busy === "key" ? <LoaderCircle className="is-spinning" size={15} /> : <KeyRound size={15} />}加密保存</button>
            <p>方舟负责素材理解与文案；只上传压缩音频和抽取关键帧，原始视频留在本机。Key 不进入日志、数据库或导出包。</p>
          </section>
          <section className="workspace-panel workspace-brand-panel">
            <div className="workspace-sidebar-title"><Sparkles size={18} /><div><strong>品牌包</strong><span>可选；不选则使用中性模板</span></div></div>
            <label className="workspace-field"><span>名称</span><input value={brandDraft.name} maxLength={80} placeholder="例如：培训课程" onChange={(event) => setBrandDraft((current) => ({ ...current, name: event.target.value }))} /></label>
            <div className="workspace-color-row">
              <label><span>主色</span><input type="color" value={brandDraft.primaryColor} onChange={(event) => setBrandDraft((current) => ({ ...current, primaryColor: event.target.value }))} /></label>
              <label><span>强调色</span><input type="color" value={brandDraft.accentColor} onChange={(event) => setBrandDraft((current) => ({ ...current, accentColor: event.target.value }))} /></label>
            </div>
            <label className="workspace-field"><span>字体</span><select value={brandDraft.fontPreset} onChange={(event) => setBrandDraft((current) => ({ ...current, fontPreset: event.target.value as BrandProfile["fontPreset"] }))}><option value="microsoft_yahei">微软雅黑</option><option value="source_han_sans">清晰黑体</option><option value="neutral_sans">中性粗黑</option></select></label>
            <label className="workspace-field"><span>Logo 素材</span><select value={brandDraft.logoAssetId} onChange={(event) => setBrandDraft((current) => ({ ...current, logoAssetId: event.target.value }))}><option value="">不使用</option>{imageAssets.map((item) => <option value={item.assetId} key={item.assetId}>{item.displayName}</option>)}</select></label>
            <label className="workspace-field"><span>老师参考照</span><select value={brandDraft.referenceAssetId} onChange={(event) => setBrandDraft((current) => ({ ...current, referenceAssetId: event.target.value }))}><option value="">不使用</option>{imageAssets.map((item) => <option value={item.assetId} key={item.assetId}>{item.displayName}</option>)}</select></label>
            <label className="workspace-field"><span>片尾签名</span><input value={brandDraft.outroText} maxLength={60} placeholder="约 0.8 秒，例如：关注我们" onChange={(event) => setBrandDraft((current) => ({ ...current, outroText: event.target.value }))} /></label>
            <button className="workspace-button is-secondary" onClick={() => void saveBrandProfile()} disabled={!brandDraft.name.trim() || Boolean(busy)}>{busy === "brand" ? <LoaderCircle className="is-spinning" size={15} /> : <Check size={15} />}保存品牌包</button>
          </section>
          <section className="workspace-panel workspace-workflow-panel">
            <strong>自动处理流程</strong>
            {["生成竖屏代理与 16kHz 音频", "转写、镜头切分与质量评分", "AI 尝试分类并组合可用片段", "动态字幕、构图、音频与封面包装"].map((text, index) => <div key={text}><span>{index + 1}</span>{text}</div>)}
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
