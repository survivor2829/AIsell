import {
  Check,
  CircleAlert,
  Download,
  FileVideo2,
  FolderOpen,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AutoMixResourcePanel,
  type AutoMixResourcePanelProps,
  type AutoMixVoicePersona,
  type AutoMixVoicePreview,
  type ImportMusicCatalogTrackPayload,
  type MusicCatalogTrack
} from "./AutoMixResourcePanel";
import "./ProductOneClickPage.css";

type Result<T> = { ok: boolean; data?: T; code?: string; error?: string };
type AutoMixState =
  | "analyzing"
  | "planned"
  | "synthesizing"
  | "verifying_voice"
  | "selecting_music"
  | "rendering"
  | "quality_check"
  | "completed"
  | "needs_attention"
  | "failed"
  | "outcome_unknown";
type AutoMixLayer = "text" | "voice" | "music";
type AssetFilter = "all" | "video" | "image";
type GuidedAutoMixState = "analyzing" | "ready_for_answers" | "drafting" | "ready_for_render" | "failed" | "outcome_unknown";
type GuidedAnswers = {
  companyName: string;
  productName: string;
  targetScene: string;
  keyMessage: string;
  extraNotes: string;
};
type GuidedSupplementalImageStatus = "not_requested" | "planned" | "submitted" | "completed" | "failed" | "outcome_unknown" | "cancelled";
type GuidedSupplementalImage = {
  operationId: string | null;
  sessionId?: string | null;
  scriptRevision: number;
  status: GuidedSupplementalImageStatus;
  estimatedImageCalls: number;
  provider?: string | null;
  paidCallPerformed?: boolean;
  errorCode?: string | null;
};

type AutoMixDurationPlan = {
  policy: "auto";
  materialCapacityMs: number;
  targetDurationMs: number;
  minimumDurationMs: number;
  maximumDurationMs: number;
};

type Asset = {
  assetId: string;
  displayName: string;
  mediaKind: "video" | "image" | "audio";
  durationMs: number | null;
  hasAudio: boolean | null;
  probeStatus: string;
  archived: boolean;
  availableLocationCount: number;
};

type ContentTask = {
  taskId: string;
  taskType: string;
  status: string;
  progress: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  projectId?: string | null;
  runId?: string | null;
  createdAt?: string;
};

type Candidate = {
  generatedVideoId: string;
  projectId: string;
  title: string;
  durationMs: number;
  status: string;
  previewReady: boolean;
  actualEngine?: string | null;
  fallbackCode?: string | null;
};

type AutoMixWarning = string | {
  code?: string | null;
  message?: string | null;
  layer?: AutoMixLayer | null;
};

type AutoMixPlan = {
  specVersion: "2";
  runId: string;
  projectId: string;
  taskId?: string | null;
  parentRunId?: string | null;
  generation: number;
  state: AutoMixState;
  usableMaterialDurationMs?: number | null;
  estimatedDurationRangeMs?: { min?: number | null; max?: number | null } | null;
  selectedDurationMs?: number | null;
  durationPlan?: AutoMixDurationPlan | null;
  inputAssetIds?: string[];
  selectedSegments: Array<{
    segmentId?: string | null;
    assetId?: string | null;
    mediaKind?: "video" | "image" | null;
    targetDurationMs?: number | null;
    role?: string | null;
    sourceTag?: string | null;
    qualityScore?: number | null;
  }>;
  spokenPhrases: Array<{ phraseId?: string | null; text?: string | null; evidenceRefs?: string[] }>;
  speechCaptions: Array<{
    captionId?: string | null;
    startMs?: number | null;
    endMs?: number | null;
    text?: string | null;
    captionSource?: "tts_voiceover" | null;
    timing?: "audio_measured" | "asr_aligned" | "forced_aligned" | null;
  }>;
  visualTextItems: Array<{
    textItemId?: string | null;
    type?: "hook" | "callout" | "cta" | null;
    text?: string | null;
    startMs?: number | null;
    endMs?: number | null;
  }>;
  voicePersona?: {
    voicePersonaId?: string | null;
    displayName?: string | null;
    catalogVersion?: string | null;
    category?: string | null;
    approvalStatus?: "approved" | "pending" | "retired" | null;
  } | null;
  music?: {
    trackId?: string | null;
    displayName?: string | null;
    source?: string | null;
    licenseSummary?: {
      status?: string | null;
      commercialScope?: string | null;
      commercialUseAllowed?: boolean;
      expiresAt?: string | null;
      evidencePresent?: boolean;
    } | null;
    bpm?: number | null;
    moods?: string[];
    energy?: number | null;
  } | null;
  qualityWarnings: AutoMixWarning[];
  qualityReport?: {
    passed?: boolean;
    integratedLufs?: number | null;
    truePeakDbtp?: number | null;
    speechMusicMarginLu?: number | null;
  } | null;
  generatedVideoId?: string | null;
  outputCount: 1;
  attention?: { code?: string | null; message?: string | null; layer?: AutoMixLayer | null } | null;
};

type GuidedAutoMixSession = {
  sessionId: string | null;
  status: GuidedAutoMixState;
  assetIds: string[];
  analysisTask?: ContentTask | null;
  draftTask?: ContentTask | null;
  analysis: {
    usableMaterialDurationMs?: number | null;
    selectedDurationMs?: number | null;
    selectedSegmentCount?: number | null;
    durationPlan?: AutoMixDurationPlan | null;
    materialFacts?: Array<{ text?: string | null; kind?: string | null }>;
  };
  answers: GuidedAnswers;
  prefill?: {
    title?: string | null;
    answers?: Partial<GuidedAnswers> | null;
  } | null;
  draft: {
      scriptRevision: number;
      draftHash?: string | null;
      title?: string | null;
    provider?: string | null;
    hook?: string | null;
    voiceover?: string | null;
    cta?: string | null;
    durationPlan?: AutoMixDurationPlan | null;
    spokenPhrases?: Array<{ text?: string | null }>;
    visualTextItems?: Array<{ type?: "hook" | "callout" | "cta" | null; text?: string | null }>;
  };
};

type LegacyProject = {
  projectId: string;
  name: string;
  status: string;
  targetCount: number;
  generatedCount: number;
  productAssets?: Array<{ assetId: string }>;
};

type Api = {
  status: () => Promise<Result<{ state?: string; available?: boolean; version?: string }>>;
  library: {
    list: (payload?: { limit?: number }) => Promise<Result<{ items: Asset[] }>>;
    chooseFiles: () => Promise<Result<{ items?: Asset[] }>>;
    chooseFolder: (payload?: { recursive?: boolean }) => Promise<Result<{ items?: Asset[] }>>;
    probe: (payload: { assetId: string }) => Promise<Result<Asset>>;
  };
  tasks: { list: (payload?: { limit?: number }) => Promise<Result<{ items: ContentTask[] }>> };
  settings: { volcengineArkStatus: () => Promise<Result<{ configured?: boolean; secureStorageAvailable?: boolean }>> };
  creative: {
    createAutoMixV2: (payload:
      | { specVersion: "2"; assetIds: string[]; title: string; copyFramework: string }
      | { specVersion: "2"; guidedSessionId: string; scriptRevision: number }
    ) => Promise<Result<AutoMixPlan>>;
    prepareGuidedAutoMixV2: (payload: { assetIds: string[] }) => Promise<Result<GuidedAutoMixSession>>;
    getGuidedAutoMixSessionV2: (payload: { sessionId?: string; taskId?: string }) => Promise<Result<GuidedAutoMixSession>>;
    generateGuidedAutoMixScriptV2: (payload: {
      sessionId: string;
      analysisTaskId?: string;
      title: string;
      answers: GuidedAnswers;
    }) => Promise<Result<GuidedAutoMixSession>>;
    getGuidedAutoMixSupplementalImageV2: (payload: {
      sessionId: string;
      scriptRevision: number;
    }) => Promise<Result<GuidedSupplementalImage>>;
    createGuidedAutoMixSupplementalImageV2: (payload: {
      sessionId: string;
      scriptRevision: number;
      draftHash: string;
      confirmPaidCalls: true;
    }) => Promise<Result<GuidedSupplementalImage>>;
    getAutoMixPlanV2: (payload: { projectId?: string; runId?: string }) => Promise<Result<AutoMixPlan>>;
    regenerateAutoMixLayer: (payload: {
      projectId: string;
      expectedRunId: string;
      layer: AutoMixLayer;
    }) => Promise<Result<AutoMixPlan>>;
    listMusicCatalogTracks: () => Promise<Result<{ items: MusicCatalogTrack[] }>>;
    importMusicCatalogTrack: (
      payload: ImportMusicCatalogTrackPayload
    ) => Promise<Result<MusicCatalogTrack>>;
    listAutoMixVoicePersonas: () => Promise<Result<{ items: AutoMixVoicePersona[] }>>;
    designAutoMixVoicePersona: (payload: {
      voicePersonaId: string;
    }) => Promise<Result<AutoMixVoicePersona>>;
    previewAutoMixVoicePersona: (payload: {
      voicePersonaId: string;
    }) => Promise<Result<AutoMixVoicePreview>>;
    approveAutoMixVoicePersona: (payload: {
      voicePersonaId: string;
    }) => Promise<Result<AutoMixVoicePersona>>;
    listOneClickCandidates: (payload: { projectId: string; limit: number }) => Promise<Result<{ items: Candidate[] }>>;
    getProject: (payload: { projectId: string }) => Promise<Result<LegacyProject>>;
    downloadCandidate?: (payload: { candidateId: string }) => Promise<Result<{ canceled?: boolean; filename?: string }>>;
  };
};

type ProductOneClickPageProps = {
  onOpenLegacy?: () => void;
  onBackToStudio?: () => void;
  initialProjectId?: string | null;
  initialTaskId?: string | null;
};

const PRODUCT_ASSET_PAGE_SIZE = 16;
const V2_TASK_TYPES = new Set(["auto_mix_v2_generation", "auto_mix_v2_regeneration"]);
const V1_TASK_TYPES = new Set(["product_asset_analysis", "product_copy", "product_voice", "product_generation"]);
const GUIDED_TASK_TYPES = new Set([
  "guided_auto_mix_analysis",
  "guided_auto_mix_draft",
  "guided_auto_mix_supplemental_image"
]);
const RESTORABLE_TASK_TYPES = new Set([...V2_TASK_TYPES, ...V1_TASK_TYPES, ...GUIDED_TASK_TYPES]);
const EMPTY_GUIDED_ANSWERS: GuidedAnswers = {
  companyName: "",
  productName: "",
  targetScene: "",
  keyMessage: "",
  extraNotes: ""
};
const RUNNING_STATES = new Set<AutoMixState>([
  "analyzing",
  "planned",
  "synthesizing",
  "verifying_voice",
  "selecting_music",
  "rendering",
  "quality_check"
]);
const RECOVERABLE_STATES = new Set<AutoMixState>(["completed", "needs_attention", "failed"]);
const AUTO_MIX_LAYERS: AutoMixLayer[] = ["text", "voice", "music"];
const LAYER_LABELS: Record<AutoMixLayer, string> = { text: "文字", voice: "声音", music: "音乐" };

const STATE_COPY: Record<AutoMixState, { title: string; detail: string; progress: number }> = {
  analyzing: { title: "正在检查素材", detail: "正在挑选清晰、有内容的可用片段。", progress: 12 },
  planned: { title: "正在安排剪辑", detail: "正在对齐画面、文案和整体节奏。", progress: 26 },
  synthesizing: { title: "正在生成配音", detail: "正在生成自然人声并安排停顿。", progress: 42 },
  verifying_voice: { title: "正在检查配音", detail: "正在核对发音和字幕是否一致。", progress: 56 },
  selecting_music: { title: "正在选择音乐", detail: "正在根据素材节奏匹配背景音乐。", progress: 68 },
  rendering: { title: "正在合成视频", detail: "正在合成画面、字幕、配音和音乐。", progress: 82 },
  quality_check: { title: "正在检查成片", detail: "正在检查字幕、声音和整体播放效果。", progress: 94 },
  completed: { title: "成片已生成", detail: "可以预览并保存到电脑。", progress: 100 },
  needs_attention: { title: "需要处理后才能继续", detail: "系统已暂停，请按照下方提示处理。", progress: 100 },
  failed: { title: "本次生成未完成", detail: "素材和文案已经保留，可以按提示继续处理。", progress: 100 },
  outcome_unknown: { title: "结果暂时无法确认", detail: "为避免重复调用，系统不会自动重试。", progress: 100 }
};

function api(): Api | undefined {
  const bridge = window as unknown as {
    xiaoxi?: { contentEngine?: Api };
    xiaoxiContent?: Api;
  };
  return bridge.xiaoxi?.contentEngine || bridge.xiaoxiContent;
}

function formatDuration(value: number | null | undefined) {
  if (!Number.isFinite(value) || Number(value) <= 0) return "待计算";
  const seconds = Math.round(Number(value) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
}

function assetMediaLabel(item: Asset) {
  if (item.probeStatus === "pending") return "正在读取时长和音轨";
  if (item.probeStatus !== "ok") return "素材读取失败，请检查文件后重新导入";
  if (item.mediaKind === "image") return "图片 · 自动适配展示时长";
  return `视频 · ${formatDuration(item.durationMs)}${item.hasAudio ? " · 已识别音轨" : ""}`;
}

function errorOf(result: Result<unknown>, fallback: string) {
  return result.error || result.code || fallback;
}

function dataOf<T>(result: Result<T>, fallback: string): T {
  if (result.ok && result.data !== undefined) return result.data;
  throw Object.assign(new Error(errorOf(result, fallback)), {
    code: result.code || "content_engine_request_failed"
  });
}

function summarizeTrack(items: Array<{ text?: string | null }>, emptyCopy: string) {
  const texts = items.map((item) => item.text?.trim()).filter((item): item is string => Boolean(item));
  if (!texts.length) return emptyCopy;
  const preview = texts.slice(0, 3).join(" / ");
  return `${items.length} 段 · ${preview}${texts.length > 3 ? "…" : ""}`;
}

function durationFitSummary(plan: AutoMixPlan) {
  const range = plan.estimatedDurationRangeMs;
  const rangeText = range?.min && range?.max
    ? `${formatDuration(range.min)}–${formatDuration(range.max)}`
    : "正在估算";
  return `可用素材 ${formatDuration(plan.usableMaterialDurationMs)}；建议范围 ${rangeText}；当前成片 ${formatDuration(plan.selectedDurationMs)}。`;
}

function personaSummary(plan: AutoMixPlan) {
  if (!plan.voicePersona) return "声音人格尚未选定。";
  const approval = plan.voicePersona.approvalStatus === "approved"
    ? "已批准"
    : plan.voicePersona.approvalStatus === "retired"
      ? "已停用"
      : "等待批准";
  return `${plan.voicePersona.displayName || "自然口播"} · ${approval}${plan.voicePersona.category ? ` · ${plan.voicePersona.category}` : ""}`;
}

function licenseSummary(plan: AutoMixPlan) {
  const license = plan.music?.licenseSummary;
  if (!plan.music || !license) return "授权音乐尚未选定。";
  const status = license.status === "valid"
    && license.commercialUseAllowed === true
    && license.evidencePresent
    ? "授权证据有效"
    : "授权证据未通过";
  const scope = license.commercialScope ? ` · ${license.commercialScope}` : "";
  const expires = license.expiresAt
    ? ` · 有效期至 ${new Date(license.expiresAt).toLocaleDateString("zh-CN")}`
    : "";
  return `${plan.music.displayName || "授权音乐"} · ${status}${scope}${expires}`;
}

function warningText(warning: AutoMixWarning) {
  if (typeof warning === "string") return warning;
  return warning.message?.trim() || "检测到一项质量风险，请根据当前层级重新生成。";
}

function attentionText(plan: AutoMixPlan) {
  if (plan.attention?.message?.trim()) return plan.attention.message.trim();
  if (plan.attention?.layer === "voice") return "声音人格或口播证据尚未通过，请先完成声音准备。";
  if (plan.attention?.layer === "music") return "没有找到授权证据有效的音乐，请先补齐授权曲目。";
  if (plan.attention?.layer === "text") return "脚本文案证据不足，请返回脚本步骤检查。";
  return STATE_COPY.needs_attention.detail;
}

export function ProductOneClickPage({
  onBackToStudio,
  initialProjectId,
  initialTaskId
}: ProductOneClickPageProps) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [guidedAnswers, setGuidedAnswers] = useState<GuidedAnswers>(EMPTY_GUIDED_ANSWERS);
  const [guidedSession, setGuidedSession] = useState<GuidedAutoMixSession | null>(null);
  const [supplementalImage, setSupplementalImage] = useState<GuidedSupplementalImage | null>(null);
  const [supplementalImageConsent, setSupplementalImageConsent] = useState(false);
  const [guidedAssetKey, setGuidedAssetKey] = useState("");
  const [scriptInputDirty, setScriptInputDirty] = useState(false);
  const [engine, setEngine] = useState<{ state?: string; available?: boolean; version?: string } | null>(null);
  const [plan, setPlan] = useState<AutoMixPlan | null>(null);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [legacyProject, setLegacyProject] = useState<LegacyProject | null>(null);
  const [legacyCandidates, setLegacyCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState("");
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [assetSearch, setAssetSearch] = useState("");
  const [assetFilter, setAssetFilter] = useState<AssetFilter>("all");
  const [visibleAssetCount, setVisibleAssetCount] = useState(PRODUCT_ASSET_PAGE_SIZE);
  const [resourcePanelOpen, setResourcePanelOpen] = useState(false);
  const [resourceSection, setResourceSection] = useState<"voice" | "music">("voice");
  const autoProbeAttemptedRef = useRef(new Set<string>());
  const candidateEpochRef = useRef(0);
  const guidedPrefillSessionRef = useRef("");
  const guidedFormEditedRef = useRef(false);
  const statusRef = useRef<HTMLDivElement>(null);

  const activeAssets = useMemo(
    () => assets.filter((item) => (
      !item.archived
      && item.availableLocationCount > 0
      && (item.mediaKind === "image" || item.mediaKind === "video")
    )),
    [assets]
  );
  const selectedAssetItems = useMemo(() => {
    const byId = new Map(activeAssets.map((item) => [item.assetId, item]));
    return selected.map((assetId) => byId.get(assetId)).filter((item): item is Asset => Boolean(item));
  }, [activeAssets, selected]);
  const selectedPendingAssets = useMemo(
    () => selectedAssetItems.filter((item) => item.probeStatus === "pending"),
    [selectedAssetItems]
  );
  const selectedFailedAssets = useMemo(
    () => selectedAssetItems.filter((item) => item.probeStatus !== "pending" && item.probeStatus !== "ok"),
    [selectedAssetItems]
  );
  const selectedAssetGateMessage = useMemo(() => {
    if (selected.length !== selectedAssetItems.length) return "有已选素材已不可用，请重新选择后再生成。";
    if (selectedFailedAssets.length) return `有 ${selectedFailedAssets.length} 条素材未能读取时长，请移除或重新导入。`;
    if (selectedPendingAssets.length) return "素材正在读取时长和音轨，请等待读取完成后再生成。";
    if (selected.length > 120) return "一次最多选择 120 条素材，请减少后再生成。";
    return "";
  }, [selected.length, selectedAssetItems.length, selectedFailedAssets.length, selectedPendingAssets.length]);
  const selectedAssetsReady = selected.length > 0 && !selectedAssetGateMessage;
  const pickerAssets = useMemo(() => {
    const query = assetSearch.trim().toLocaleLowerCase();
    return activeAssets.filter((item) => {
      if (assetFilter !== "all" && item.mediaKind !== assetFilter) return false;
      return !query || item.displayName.toLocaleLowerCase().includes(query);
    });
  }, [activeAssets, assetFilter, assetSearch]);
  const visiblePickerAssets = pickerAssets.slice(0, visibleAssetCount);
  const engineReady = engine?.state === "ready" || engine?.available === true;
  const selectedKey = selected.join("|");
  const guidedRunning = guidedSession?.status === "analyzing" || guidedSession?.status === "drafting";
  const guidedKnownDraftFailure = Boolean(
    guidedSession?.status === "ready_for_answers"
    && guidedSession.analysisTask?.status === "completed"
    && guidedSession.draftTask?.status === "failed"
    && guidedSession.draftTask?.errorCode === "product_copy_invalid"
  );
  const guidedDraftFailureText = guidedSession?.draftTask?.errorMessage?.trim()
    ? `${guidedSession.draftTask.errorMessage.trim()} 素材解析和填写内容已保留，可直接再次生成 AI 脚本。`
    : "AI 脚本未通过结构化校验；素材解析和填写内容已保留，可直接再次生成 AI 脚本。";
  const planRunning = Boolean(plan && RUNNING_STATES.has(plan.state));
  const recoveryLayer = plan?.state === "needs_attention" || plan?.state === "failed"
    ? plan.attention?.layer || null
    : null;
  const isLegacyMaterialAlignmentIssue = Boolean(
    (plan?.state === "needs_attention" || plan?.state === "failed")
    && recoveryLayer === "text"
    && plan.attention?.code === "auto_mix_material_too_short"
    && plan.attention?.message === "引用素材不足以覆盖对应口播的真实时间窗口。"
  );
  const continuationLayer: AutoMixLayer | null = isLegacyMaterialAlignmentIssue ? "voice" : recoveryLayer;
  const canContinueFromIssue = Boolean(
    (plan?.state === "needs_attention" || plan?.state === "failed")
    && (
      recoveryLayer === "voice"
      || recoveryLayer === "music"
      || isLegacyMaterialAlignmentIssue
    )
  );
  const planRequiresResolution = Boolean(
    plan && (plan.state === "outcome_unknown" || canContinueFromIssue)
  );
  const planCanBeRevised = Boolean(
    plan
    && (plan.state === "needs_attention" || plan.state === "failed")
    && !canContinueFromIssue
  );
  const formLocked = planRunning || planRequiresResolution || guidedRunning;
  let scriptGenerateDisabledReason = "";
  if (busy === "script") {
    scriptGenerateDisabledReason = "正在提交脚本，请勿重复点击。";
  } else if (busy) {
    scriptGenerateDisabledReason = "当前正在处理其他操作，请稍候。";
  } else if (guidedRunning) {
    scriptGenerateDisabledReason = "正在解析素材，完成后会自动预填。";
  } else if (planRunning) {
    scriptGenerateDisabledReason = "当前成片任务仍在运行，请等待它结束后再生成脚本。";
  } else if (planRequiresResolution) {
    scriptGenerateDisabledReason = "当前成片任务需要处理，请先在任务状态中完成处理。";
  } else if (!guidedSession?.sessionId) {
    scriptGenerateDisabledReason = "当前素材解析会话尚未连接，请等待状态刷新或重新打开任务。";
  } else if (!title.trim()) {
    scriptGenerateDisabledReason = "请先确认视频标题。";
  } else if (!guidedAnswers.productName.trim()) {
    scriptGenerateDisabledReason = "请先确认产品或服务。";
  }
  const draftDurationPlan = guidedSession?.draft?.durationPlan || null;
  const analysisDurationPlan = guidedSession?.analysis?.durationPlan || null;
  const draftSpokenPhrases = (guidedSession?.draft?.spokenPhrases || [])
    .map((item) => item.text?.trim() || "")
    .filter(Boolean);
  const planProgressVisible = Boolean(
    plan && (RUNNING_STATES.has(plan.state) || plan.state === "completed")
  );
  const candidateMatchesPlan = Boolean(
    plan?.generatedVideoId
    && candidate?.generatedVideoId === plan.generatedVideoId
    && candidate.status === "completed"
  );
  const licensedMusicReady = Boolean(
    plan?.music?.licenseSummary?.status === "valid"
    && plan.music.licenseSummary.commercialUseAllowed === true
    && plan.music.licenseSummary.evidencePresent === true
  );
  const approvedVoiceReady = plan?.voicePersona?.approvalStatus === "approved";
  const formalEvidenceReady = Boolean(
    plan?.state === "completed"
    && plan.qualityReport?.passed === true
    && licensedMusicReady
    && approvedVoiceReady
    && candidateMatchesPlan
    && candidate?.actualEngine === "remotion"
  );
  const formalPreviewReady = Boolean(formalEvidenceReady && candidate?.previewReady);
  const regenerationLayers = plan?.state === "completed" ? AUTO_MIX_LAYERS : [];
  let createButtonLabel = "一键生成";
  if (planRunning) {
    createButtonLabel = "正在生成成片…";
  } else if (plan?.state === "outcome_unknown") {
    createButtonLabel = "请先查询当前结果";
  } else if (canContinueFromIssue) {
    createButtonLabel = "请先继续当前成片";
  } else if (planCanBeRevised) {
    createButtonLabel = "修改后重新生成";
  }

  const hydrateAutoMixPlan = useCallback((restored: AutoMixPlan) => {
    candidateEpochRef.current += 1;
    setCandidate(null);
    setPlan(restored);
    setLegacyProject(null);
    setLegacyCandidates([]);
    const restoredAssetIds = restored.inputAssetIds?.length
      ? restored.inputAssetIds
      : restored.selectedSegments
        .map((item) => item.assetId)
        .filter((item): item is string => Boolean(item));
    setSelected([...new Set(restoredAssetIds)]);
    setTitle(restored.visualTextItems.find((item) => item.type === "hook")?.text || "已恢复的一键混剪 V2");
    setGuidedSession(null);
    setSupplementalImage(null);
    setSupplementalImageConsent(false);
    setGuidedAssetKey("");
    setScriptInputDirty(false);
  }, []);

  const applyGuidedFormSuggestions = useCallback((restored: GuidedAutoMixSession) => {
    const sessionId = restored.sessionId || "";
    if (!sessionId || guidedFormEditedRef.current || guidedPrefillSessionRef.current === sessionId) return;
    const storedAnswers = { ...EMPTY_GUIDED_ANSWERS, ...(restored.answers || {}) };
    const suggestedAnswers = { ...EMPTY_GUIDED_ANSWERS, ...(restored.prefill?.answers || {}) };
    const hasStoredAnswers = Object.values(storedAnswers).some((value) => Boolean(value.trim()));
    const hasSuggestedValues = Boolean(
      restored.prefill?.title?.trim()
      || Object.values(suggestedAnswers).some((value) => Boolean(value.trim()))
    );
    const restoredTitle = restored.draft?.title?.trim() || "";
    if (!hasStoredAnswers && !hasSuggestedValues && !restoredTitle) return;
    setGuidedAnswers(hasStoredAnswers ? storedAnswers : suggestedAnswers);
    setTitle(restoredTitle || restored.prefill?.title?.trim() || "");
    guidedPrefillSessionRef.current = sessionId;
  }, []);

  const hydrateGuidedSession = useCallback((restored: GuidedAutoMixSession, options: { preserveInputs?: boolean } = {}) => {
    candidateEpochRef.current += 1;
    setCandidate(null);
    setPlan(null);
    setLegacyProject(null);
    setLegacyCandidates([]);
    setGuidedSession(restored);
    setSupplementalImage(null);
    setSupplementalImageConsent(false);
    if (!options.preserveInputs) {
      guidedPrefillSessionRef.current = "";
      guidedFormEditedRef.current = false;
      setGuidedAnswers(EMPTY_GUIDED_ANSWERS);
      setTitle("");
      applyGuidedFormSuggestions(restored);
    }
    if (restored.assetIds?.length) {
      const next = [...new Set(restored.assetIds)];
      setSelected(next);
      setGuidedAssetKey(next.join("|"));
    }
    setScriptInputDirty(false);
  }, [applyGuidedFormSuggestions]);

  const refreshCandidate = useCallback(async (projectId: string, generatedVideoId?: string | null) => {
    const current = api();
    if (!current) return;
    const requestEpoch = ++candidateEpochRef.current;
    const result = await current.creative.listOneClickCandidates({ projectId, limit: 20 });
    if (requestEpoch !== candidateEpochRef.current) return;
    if (!result.ok || !result.data) return;
    const items = result.data.items || [];
    const match = generatedVideoId
      ? items.find((item) => item.generatedVideoId === generatedVideoId)
      : items[0];
    setCandidate(match || null);
  }, []);

  const restoreTask = useCallback(async (target: ContentTask) => {
    const current = api();
    if (!current) return false;
    if (GUIDED_TASK_TYPES.has(target.taskType)) {
      const result = await current.creative.getGuidedAutoMixSessionV2({ taskId: target.taskId });
      if (!result.ok || !result.data) return false;
      hydrateGuidedSession(result.data);
      return true;
    }
    if (!target.projectId) return false;
    if (V2_TASK_TYPES.has(target.taskType)) {
      const result = await current.creative.getAutoMixPlanV2(
        target.runId ? { runId: target.runId } : { projectId: target.projectId }
      );
      if (!result.ok || !result.data) return false;
      const restored = result.data;
      hydrateAutoMixPlan(restored);
      await refreshCandidate(restored.projectId, restored.generatedVideoId);
      return true;
    }
    if (V1_TASK_TYPES.has(target.taskType)) {
      const [projectResult, candidateResult] = await Promise.all([
        current.creative.getProject({ projectId: target.projectId }),
        current.creative.listOneClickCandidates({ projectId: target.projectId, limit: 20 })
      ]);
      if (!projectResult.ok || !projectResult.data) return false;
      setLegacyProject(projectResult.data);
      setLegacyCandidates(candidateResult.ok && candidateResult.data ? candidateResult.data.items : []);
      setPlan(null);
      candidateEpochRef.current += 1;
      setCandidate(null);
      setSelected((projectResult.data.productAssets || []).map((item) => item.assetId));
      setTitle(projectResult.data.name || "旧版商品一键成片");
      setGuidedSession(null);
      setSupplementalImage(null);
      setSupplementalImageConsent(false);
      setGuidedAssetKey("");
      setScriptInputDirty(false);
      return true;
    }
    return false;
  }, [hydrateAutoMixPlan, hydrateGuidedSession, refreshCandidate]);

  const load = useCallback(async () => {
    const current = api();
    if (!current) {
      setLoadError("内容引擎接口尚未加载，请重启应用后再试。");
      setInitialLoading(false);
      return;
    }
    setInitialLoading(true);
    setLoadError("");
    try {
      const [statusResult, libraryResult, taskResult] = await Promise.all([
        current.status(),
        current.library.list({ limit: 500 }),
        current.tasks.list({ limit: 500 })
      ]);
      if (statusResult.ok && statusResult.data) setEngine(statusResult.data);
      if (libraryResult.ok && libraryResult.data) setAssets(libraryResult.data.items);
      const tasks = taskResult.ok && taskResult.data ? taskResult.data.items : [];
      const requested = tasks.find((item) => (
        item.taskId === initialTaskId
        && RESTORABLE_TASK_TYPES.has(item.taskType)
      ));
      if (requested && await restoreTask(requested)) {
        return;
      }
      if (initialProjectId) {
        const direct = await current.creative.getAutoMixPlanV2({ projectId: initialProjectId });
        if (direct.ok && direct.data) {
          hydrateAutoMixPlan(direct.data);
          await refreshCandidate(direct.data.projectId, direct.data.generatedVideoId);
          return;
        }
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "页面数据读取失败，请稍后重试。");
    } finally {
      setInitialLoading(false);
    }
  }, [hydrateAutoMixPlan, initialProjectId, initialTaskId, refreshCandidate, restoreTask]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    setVisibleAssetCount(PRODUCT_ASSET_PAGE_SIZE);
  }, [assetSearch, assetFilter]);

  useEffect(() => {
    const current = api();
    const pending = selectedPendingAssets.filter((item) => !autoProbeAttemptedRef.current.has(item.assetId));
    if (!current || !pending.length) return;
    pending.forEach((item) => autoProbeAttemptedRef.current.add(item.assetId));
    let active = true;
    void (async () => {
      setBusy((value) => value || "probe-selected");
      let failedCount = 0;
      for (const item of pending) {
        try {
          const result = await current.library.probe({ assetId: item.assetId });
          if (!result.ok || result.data?.probeStatus !== "ok") failedCount += 1;
        } catch {
          failedCount += 1;
        }
      }
      const refreshed = await current.library.list({ limit: 500 });
      if (!active) return;
      if (refreshed.ok && refreshed.data) setAssets(refreshed.data.items);
      setNotice(failedCount
        ? { tone: "error", text: `${failedCount} 条已选素材未能读取时长，请检查文件后重新导入。` }
        : { tone: "success", text: `已完成 ${pending.length} 条素材的时长读取。` });
      setBusy((value) => value === "probe-selected" ? "" : value);
    })();
    return () => { active = false; };
  }, [selectedPendingAssets]);

  useEffect(() => {
    if (!plan?.projectId || !RUNNING_STATES.has(plan.state)) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      const current = api();
      if (!current || !active) return;
      try {
        const result = await current.creative.getAutoMixPlanV2({ runId: plan.runId });
        if (!active) return;
        if (!result.ok || !result.data) {
          setNotice({ tone: "error", text: errorOf(result, "暂时无法读取生成进度，系统会继续尝试。") });
          timer = window.setTimeout(() => void poll(), 2_500);
          return;
        }
        const nextPlan = result.data;
        setPlan(nextPlan);
        if (nextPlan.generatedVideoId) {
          await refreshCandidate(nextPlan.projectId, nextPlan.generatedVideoId);
        }
        if (RUNNING_STATES.has(nextPlan.state)) {
          timer = window.setTimeout(() => void poll(), 1_500);
        } else if (nextPlan.state === "completed") {
          setNotice({ tone: "success", text: "生成流程已结束，正在核对正式成片证据。" });
        } else if (nextPlan.state === "needs_attention") {
          setNotice({ tone: "error", text: attentionText(nextPlan) });
        } else if (nextPlan.state === "outcome_unknown") {
          setNotice({ tone: "error", text: "外部结果暂时无法确认；为避免重复调用或扣费，不会自动重提。" });
        } else {
          setNotice({ tone: "error", text: "本次一键混剪没有完成，请按下方提示继续处理。" });
        }
      } catch {
        if (active) {
          setNotice({ tone: "error", text: "进度连接暂时中断，系统会继续尝试，不会重复创建任务。" });
          timer = window.setTimeout(() => void poll(), 2_500);
        }
      }
    };
    timer = window.setTimeout(() => void poll(), 900);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [plan?.projectId, plan?.runId, plan?.state, refreshCandidate]);

  useEffect(() => {
    if (!guidedAssetKey || guidedAssetKey === selectedKey) return;
    setGuidedSession(null);
    setSupplementalImage(null);
    setSupplementalImageConsent(false);
    setGuidedAssetKey("");
    setScriptInputDirty(false);
    guidedPrefillSessionRef.current = "";
    guidedFormEditedRef.current = false;
    setNotice({ tone: "info", text: "素材已修改，请重新解析后再生成脚本。" });
  }, [guidedAssetKey, selectedKey]);

  useEffect(() => {
    const sessionId = guidedSession?.sessionId;
    if (!sessionId || (guidedSession.status !== "analyzing" && guidedSession.status !== "drafting")) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      const current = api();
      if (!current || !active) return;
      try {
        const result = await current.creative.getGuidedAutoMixSessionV2({ sessionId });
        if (!active) return;
        if (!result.ok || !result.data) {
          setNotice({ tone: "error", text: errorOf(result, "暂时无法读取解析进度，系统会继续尝试。") });
          timer = window.setTimeout(() => void poll(), 2_500);
          return;
        }
        const next = result.data;
        setGuidedSession(next);
        if (next.status === "analyzing" || next.status === "drafting") {
          timer = window.setTimeout(() => void poll(), 1_500);
        } else if (next.status === "ready_for_answers") {
          applyGuidedFormSuggestions(next);
          if (
            next.analysisTask?.status === "completed"
            && next.draftTask?.status === "failed"
            && next.draftTask?.errorCode === "product_copy_invalid"
          ) {
            setNotice(null);
          } else {
            setNotice({ tone: "success", text: "素材解析完成，已根据本次素材预填建议内容；可直接修改后生成脚本。" });
          }
        } else if (next.status === "ready_for_render") {
          setNotice({ tone: "success", text: "AI 脚本已生成，请确认后进入一键成片。" });
        } else if (next.status === "outcome_unknown") {
          setNotice({ tone: "error", text: "AI 脚本请求结果暂时无法确认，为避免重复调用，请先查看当前任务。" });
        } else {
          setNotice({ tone: "error", text: "素材解析或脚本生成未完成，请重新开始当前步骤。" });
        }
      } catch {
        if (active) {
          setNotice({ tone: "error", text: "进度连接暂时中断，系统会继续尝试，不会重复创建任务。" });
          timer = window.setTimeout(() => void poll(), 2_500);
        }
      }
    };
    timer = window.setTimeout(() => void poll(), 900);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [applyGuidedFormSuggestions, guidedSession?.sessionId, guidedSession?.status]);

  useEffect(() => {
    const sessionId = guidedSession?.sessionId;
    const scriptRevision = guidedSession?.draft?.scriptRevision || 0;
    if (!sessionId || guidedSession?.status !== "ready_for_render" || !scriptRevision || scriptInputDirty) {
      setSupplementalImage(null);
      setSupplementalImageConsent(false);
      return;
    }
    const current = api();
    if (!current) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const result = await current.creative.getGuidedAutoMixSupplementalImageV2({
          sessionId,
          scriptRevision
        });
        if (!active) return;
        if (!result.ok || !result.data) {
          setNotice({ tone: "error", text: errorOf(result, "暂时无法读取 AI 补图状态。") });
          return;
        }
        const next = result.data;
        setSupplementalImage(next);
        if (next.status === "planned" || next.status === "submitted") {
          timer = window.setTimeout(() => void poll(), 1_500);
        }
      } catch {
        if (active) setNotice({ tone: "error", text: "补图状态连接中断，请不要重复提交。" });
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [guidedSession?.sessionId, guidedSession?.status, guidedSession?.draft?.scriptRevision, scriptInputDirty]);

  useEffect(() => {
    if (notice?.tone === "error" || plan?.state === "needs_attention" || plan?.state === "outcome_unknown") {
      statusRef.current?.focus();
    }
  }, [notice, plan?.state]);

  async function importAssets(kind: "files" | "folder") {
    const current = api();
    if (!current) return;
    setBusy(`import-${kind}`);
    try {
      const result = kind === "files"
        ? await current.library.chooseFiles()
        : await current.library.chooseFolder({ recursive: true });
      if (!result.ok) {
        if (result.code !== "CONTENT_DIALOG_CANCELLED") {
          setNotice({ tone: "error", text: errorOf(result, "素材添加失败，请重试。") });
        }
        return;
      }
      const imported = Array.isArray(result.data?.items) ? result.data.items : [];
      const ids = imported
        .filter((item) => item.mediaKind === "image" || item.mediaKind === "video")
        .map((item) => item.assetId)
        .filter(Boolean);
      if (!ids.length) {
        setNotice({ tone: "info", text: "没有新增可用的图片或视频；可能已取消选择或文件重复。" });
        return;
      }
      setSelected((value) => [...new Set([...value, ...ids])]);
      setNotice({ tone: "info", text: `已添加 ${ids.length} 条素材，正在读取时长。` });
      const refreshed = await current.library.list({ limit: 500 });
      if (refreshed.ok && refreshed.data) setAssets(refreshed.data.items);
    } catch {
      setNotice({ tone: "error", text: "素材添加过程中断，请确认文件仍可访问后重试。" });
    } finally {
      setBusy("");
    }
  }

  async function prepareGuidedAnalysis() {
    const current = api();
    if (!current) {
      setNotice({ tone: "error", text: "内容引擎接口尚未加载，请重启应用后再试。" });
      return;
    }
    if (!selectedAssetsReady) {
      setNotice({ tone: "error", text: selectedAssetGateMessage || "请先添加至少 1 条可用素材。" });
      return;
    }
    if (!engineReady) {
      setNotice({ tone: "error", text: "本地内容引擎尚未就绪，请稍后重试。" });
      return;
    }
    const prepareGuidedAutoMix = current.creative?.prepareGuidedAutoMixV2;
    if (typeof prepareGuidedAutoMix !== "function") {
      setNotice({ tone: "error", text: "当前窗口仍在使用旧的本地生成服务。请完整重启测试版后再解析素材。" });
      return;
    }
    setBusy("prepare");
    setPlan(null);
    setCandidate(null);
    setLegacyProject(null);
    setLegacyCandidates([]);
    setNotice({ tone: "info", text: "正在解析素材，完成后会给出少量引导问题。" });
    try {
      const result = await prepareGuidedAutoMix({ assetIds: selected });
      if (!result.ok || !result.data) {
        setNotice({ tone: "error", text: errorOf(result, "素材解析任务创建失败。") });
        return;
      }
      hydrateGuidedSession(result.data);
      setGuidedAssetKey(selectedKey);
      setScriptInputDirty(false);
    } catch {
      setNotice({ tone: "error", text: "素材解析请求未能完成，请稍后重试；若刚更新过本地版本，请完整重启测试版。" });
    } finally {
      setBusy("");
    }
  }

  async function generateGuidedScript() {
    const current = api();
    const sessionId = guidedSession?.sessionId;
    if (!current) {
      setNotice({ tone: "error", text: "内容引擎接口尚未连接，请完整重启测试版后再试。" });
      return;
    }
    if (!sessionId) {
      setNotice({ tone: "error", text: "当前素材解析会话尚未连接，请等待状态刷新或重新打开任务后再试。" });
      return;
    }
    if (guidedSession.status !== "ready_for_answers" && guidedSession.status !== "ready_for_render") {
      setNotice({ tone: "error", text: "请先等待素材解析完成。" });
      return;
    }
    if (!title.trim()) {
      setNotice({ tone: "error", text: "请填写视频标题。" });
      return;
    }
    if (!guidedAnswers.productName.trim()) {
      setNotice({ tone: "error", text: "请填写要介绍的产品或服务。" });
      return;
    }
    setBusy("script");
    setNotice({ tone: "info", text: "正在根据素材和填写内容生成脚本。" });
    try {
      const result = await current.creative.generateGuidedAutoMixScriptV2({
        sessionId,
        analysisTaskId: guidedSession.analysisTask?.taskId || undefined,
        title: title.trim(),
        answers: guidedAnswers
      });
      if (!result.ok || !result.data) {
        if (result.code === "guided_auto_mix_session_not_found") {
          const taskId = guidedSession.analysisTask?.taskId;
          if (taskId) {
            try {
              const recovered = await current.creative.getGuidedAutoMixSessionV2({ taskId });
              if (recovered.ok && recovered.data) {
                hydrateGuidedSession(recovered.data, { preserveInputs: true });
                if (recovered.data.status === "ready_for_answers") {
                  setNotice({ tone: "info", text: "已恢复本次素材解析，填写内容已保留；请再次点击 AI 生成脚本。" });
                  return;
                }
                if (recovered.data.status === "ready_for_render") {
                  setScriptInputDirty(true);
                  setNotice({ tone: "info", text: "已恢复当前脚本，填写内容已保留；请再次点击重新生成 AI 脚本。" });
                  return;
                }
                setNotice({
                  tone: recovered.data.status === "failed" || recovered.data.status === "outcome_unknown" ? "error" : "info",
                  text: recovered.data.status === "failed" || recovered.data.status === "outcome_unknown"
                    ? "已恢复当前任务，但它尚未完成。请先在创作工作台查看任务状态。"
                    : "已重新连接到当前任务，请等待它完成后再生成脚本。"
                });
                return;
              }
            } catch {
              // 此错误在脚本任务创建和模型调用之前返回；保留当前填写内容。
            }
          }
          setNotice({ tone: "error", text: "当前窗口中的素材解析会话已不可用，标题和填写内容已保留；请从创作工作台打开这条素材解析任务后再继续。" });
          return;
        }
        setNotice({ tone: "error", text: errorOf(result, "AI 脚本生成未能启动。") });
        return;
      }
      hydrateGuidedSession(result.data, { preserveInputs: true });
      setScriptInputDirty(false);
    } catch {
      setNotice({ tone: "error", text: "脚本生成连接中断，请先查看任务中心确认结果，避免重复提交。" });
    } finally {
      setBusy("");
    }
  }

  async function generateSupplementalImage() {
    const current = api();
    const sessionId = guidedSession?.sessionId;
    const scriptRevision = guidedSession?.draft?.scriptRevision || 0;
    const draftHash = guidedSession?.draft?.draftHash || "";
    if (!current || !sessionId || !scriptRevision || !/^[a-f0-9]{64}$/i.test(draftHash)) {
      setNotice({ tone: "error", text: "当前脚本校验信息无效，请重新生成脚本后再创建补图。" });
      return;
    }
    if (guidedSession?.status !== "ready_for_render" || scriptInputDirty) {
      setNotice({ tone: "error", text: "请先确认当前 AI 脚本，再生成补图。" });
      return;
    }
    if (!supplementalImageConsent) {
      setNotice({ tone: "error", text: "请先确认这会发起 1 次可能计费的 AI 图片生成。" });
      return;
    }
    if (supplementalImage?.status === "submitted" || supplementalImage?.status === "planned") return;
    if (supplementalImage?.status === "outcome_unknown") {
      setNotice({ tone: "error", text: "上一张补图结果未知，系统不会自动或重复提交。请重新生成脚本后再创建新的补图。" });
      return;
    }
    setBusy("supplemental-image");
    setNotice({ tone: "info", text: "正在生成 1 张 9:16 AI 补图；完成后会作为本次成片的可选补充画面。" });
    try {
      const result = await current.creative.createGuidedAutoMixSupplementalImageV2({
        sessionId,
        scriptRevision,
        draftHash,
        confirmPaidCalls: true
      });
      if (!result.ok || !result.data) {
        setNotice({ tone: "error", text: errorOf(result, "AI 补图未能提交。") });
        return;
      }
      setSupplementalImage(result.data);
    } catch {
      setNotice({ tone: "error", text: "补图提交连接中断。请先查看当前状态，避免重复扣费。" });
    } finally {
      setBusy("");
    }
  }

  async function generate() {
    const current = api();
    if (!current) {
      setNotice({ tone: "error", text: "内容引擎接口尚未加载，请重启应用后再试。" });
      return;
    }
    if (!selectedAssetsReady) {
      setNotice({ tone: "error", text: selectedAssetGateMessage || "请先添加至少 1 条可用素材。" });
      return;
    }
    if (!title.trim()) {
      setNotice({ tone: "error", text: "请填写视频标题。" });
      return;
    }
    if (!guidedSession?.sessionId || guidedSession?.status !== "ready_for_render" || !guidedSession?.draft?.scriptRevision) {
      setNotice({ tone: "error", text: "请先完成素材解析和 AI 脚本生成。" });
      return;
    }
    if (scriptInputDirty) {
      setNotice({ tone: "error", text: "标题或引导信息已修改，请先重新生成脚本。" });
      return;
    }
    if (!guidedSession.draft.durationPlan?.targetDurationMs) {
      setNotice({ tone: "error", text: "当前脚本来自旧版本，未包含自动时长规划；请重新生成 AI 脚本后再一键成片。" });
      return;
    }
    if (!engineReady) {
      setNotice({ tone: "error", text: "本地内容引擎尚未就绪，请稍后重试。" });
      return;
    }
    if (plan?.state === "outcome_unknown") {
      setNotice({ tone: "error", text: "上次外部结果仍待确认，为避免重复调用或扣费，当前不能再次提交。" });
      return;
    }
    setBusy("generate");
    candidateEpochRef.current += 1;
    setLegacyProject(null);
    setLegacyCandidates([]);
    setCandidate(null);
    setNotice({ tone: "info", text: "已经开始生成：会按已确认脚本完成字幕、自然配音、授权音乐和音量平衡。" });
    try {
      const result = await current.creative.createAutoMixV2({
        specVersion: "2",
        guidedSessionId: guidedSession.sessionId,
        scriptRevision: guidedSession.draft.scriptRevision
      });
      if (!result.ok || !result.data) {
        setNotice({ tone: "error", text: errorOf(result, "一键混剪 V2 任务创建失败。") });
        return;
      }
      setPlan(result.data);
      if (result.data.generatedVideoId) {
        await refreshCandidate(result.data.projectId, result.data.generatedVideoId);
      }
    } catch {
      setNotice({ tone: "error", text: "任务创建连接中断。请先查看任务中心确认结果，避免重复提交。" });
    } finally {
      setBusy("");
    }
  }

  async function submitLayerRegeneration(
    layer: AutoMixLayer,
    busyKey: string,
    startText: string,
    startFailureText: string,
    connectionFailureText: (error: unknown) => string
  ) {
    const current = api();
    if (!current || !plan?.projectId) return;
    candidateEpochRef.current += 1;
    setCandidate(null);
    setBusy(busyKey);
    setNotice({ tone: "info", text: startText });
    try {
      const result = await current.creative.regenerateAutoMixLayer({
        projectId: plan.projectId,
        expectedRunId: plan.runId,
        layer
      });
      if (!result.ok || !result.data) {
        if (result.code === "auto_mix_run_stale") {
          let refreshed = false;
          try {
            const latest = await current.creative.getAutoMixPlanV2({ projectId: plan.projectId });
            if (latest.ok && latest.data) {
              hydrateAutoMixPlan(latest.data);
              await refreshCandidate(latest.data.projectId, latest.data.generatedVideoId);
              refreshed = true;
            }
          } catch {
            // The stale response is already safe; keep its explicit recovery instruction.
          }
          setNotice({
            tone: "error",
            text: refreshed
              ? "任务已有新的处理结果，已切换到最新步骤，请按当前提示继续。"
              : "任务已有新的处理结果，请重新打开最新任务后再继续。"
          });
          return;
        }
        setNotice({ tone: "error", text: errorOf(result, startFailureText) });
        return;
      }
      setPlan(result.data);
      setCandidate(null);
    } catch (error) {
      setNotice({ tone: "error", text: connectionFailureText(error) });
    } finally {
      setBusy("");
    }
  }

  async function regenerate(layer: AutoMixLayer) {
    if (!plan?.projectId) return;
    if (plan.state === "outcome_unknown") {
      setNotice({ tone: "error", text: "外部结果仍待确认，为避免重复调用或扣费，不能局部重做。" });
      return;
    }
    if (!RECOVERABLE_STATES.has(plan.state)) return;
    if (
      recoveryLayer
      && recoveryLayer !== layer
      && !(isLegacyMaterialAlignmentIssue && layer === "voice")
    ) return;
    const continuing = plan.state !== "completed";
    await submitLayerRegeneration(
      layer,
      `regenerate-${layer}`,
      continuing
        ? "正在继续生成成片；已经完成且仍有效的步骤会自动复用。"
        : `正在重做${LAYER_LABELS[layer]}层；素材分析会按 V2 缓存规则复用。`,
      continuing ? "继续生成未能启动。" : `${LAYER_LABELS[layer]}层重做未能启动。`,
      () => continuing
        ? "继续生成连接中断，请先查看任务中心确认结果。"
        : `${LAYER_LABELS[layer]}层重做连接中断，请先查看任务中心确认结果。`
    );
  }

  async function reconcileUnknownVoice() {
    if (!plan?.projectId || plan.state !== "outcome_unknown" || plan.attention?.layer !== "voice") return;
    await submitLayerRegeneration(
      "voice",
      "reconcile-unknown-voice",
      "正在查询已有的配音结果；系统不会重复创建声音。",
      "暂时没有查到唯一的配音结果，请稍后再试。",
      (error) => error instanceof Error ? error.message : "配音结果查询连接中断，请稍后再试。"
    );
  }

  function openResources(section: "voice" | "music") {
    setResourceSection(section);
    setResourcePanelOpen(true);
  }

  const resourceApi: Pick<
    AutoMixResourcePanelProps,
    | "listMusicCatalogTracks"
    | "importMusicCatalogTrack"
    | "listAutoMixVoicePersonas"
    | "designAutoMixVoicePersona"
    | "previewAutoMixVoicePersona"
    | "approveAutoMixVoicePersona"
  > = {
    listMusicCatalogTracks: async () => {
      const current = api();
      if (!current) throw new Error("内容引擎尚未就绪");
      return dataOf(await current.creative.listMusicCatalogTracks(), "授权曲库读取失败");
    },
    importMusicCatalogTrack: async (payload) => {
      const current = api();
      if (!current) throw new Error("内容引擎尚未就绪");
      return dataOf(await current.creative.importMusicCatalogTrack(payload), "授权音乐导入失败");
    },
    listAutoMixVoicePersonas: async () => {
      const current = api();
      if (!current) throw new Error("内容引擎尚未就绪");
      return dataOf(await current.creative.listAutoMixVoicePersonas(), "声音目录读取失败");
    },
    designAutoMixVoicePersona: async (payload) => {
      const current = api();
      if (!current) throw new Error("内容引擎尚未就绪");
      return dataOf(await current.creative.designAutoMixVoicePersona(payload), "声音生成失败");
    },
    previewAutoMixVoicePersona: async (payload) => {
      const current = api();
      if (!current) throw new Error("内容引擎尚未就绪");
      return dataOf(await current.creative.previewAutoMixVoicePersona(payload), "声音试听失败");
    },
    approveAutoMixVoicePersona: async (payload) => {
      const current = api();
      if (!current) throw new Error("内容引擎尚未就绪");
      return dataOf(await current.creative.approveAutoMixVoicePersona(payload), "声音批准失败");
    }
  };

  async function download() {
    const current = api();
    if (!current?.creative.downloadCandidate || !candidate || !formalEvidenceReady) {
      setNotice({ tone: "error", text: "正式下载尚未开放：需要完成状态、质量通过和 Remotion 候选三项证据。" });
      return;
    }
    setBusy("download");
    try {
      const result = await current.creative.downloadCandidate({ candidateId: candidate.generatedVideoId });
      if (result.ok && result.data?.canceled !== true) {
        setNotice({ tone: "success", text: `已保存正式成片：${result.data?.filename || "视频文件"}` });
      } else if (!result.ok) {
        setNotice({ tone: "error", text: errorOf(result, "正式成片下载失败。") });
      }
    } finally {
      setBusy("");
    }
  }

  const planCopy = plan ? STATE_COPY[plan.state] : null;
  const qualityReport = plan?.qualityReport;
  const qualitySummary = qualityReport
    ? `${qualityReport.passed ? "质量报告通过" : "质量报告未通过"} · 综合响度 ${qualityReport.integratedLufs ?? "待测"} LUFS · 峰值 ${qualityReport.truePeakDbtp ?? "待测"} dBTP · 人声余量 ${qualityReport.speechMusicMarginLu ?? "待测"} LU`
    : "质量报告尚未生成。";
  const evidenceIssue = plan?.state === "completed" && !formalEvidenceReady
    ? plan.qualityReport?.passed !== true
      ? "质量报告未通过，当前结果不能作为正式 V2 成片。"
      : candidate?.actualEngine === "ffmpeg"
        ? "仅检测到 FFmpeg 基础输出；它不能替代 Remotion 正式成片，也不会开放预览或下载。"
        : "尚未取得由 Remotion 完成的唯一候选证据，预览和下载保持关闭。"
    : "";

  return (
    <section className="page product-one-click-page">
      <header className="product-head">
        <div>
          <h1>一键成片</h1>
          <p>先解析素材，再用少量问题生成脚本；确认后才进入带字幕、配音和音乐的成片。</p>
        </div>
        <div className="product-head-actions">
          {onBackToStudio && <button className="product-legacy-link" onClick={onBackToStudio}>返回创作中心</button>}
        </div>
      </header>

      {initialLoading && (
        <div className="product-notice is-info" role="status" aria-live="polite">
          <LoaderCircle className="is-spinning" size={17} />正在读取素材与任务记录…
        </div>
      )}
      {loadError && (
        <div ref={statusRef} tabIndex={-1} className="product-notice is-error" role="alert">
          <CircleAlert size={17} />{loadError}
        </div>
      )}
      {!initialLoading && !loadError && !engineReady && (
        <div ref={statusRef} tabIndex={-1} className="product-notice is-error" role="alert">
          <CircleAlert size={17} />本地生成服务尚未就绪，请重启应用后再试。
        </div>
      )}
      {notice && (
        <div
          ref={statusRef}
          tabIndex={notice.tone === "error" ? -1 : undefined}
          className={`product-notice is-${notice.tone}`}
          role={notice.tone === "error" ? "alert" : "status"}
          aria-live={notice.tone === "error" ? "assertive" : "polite"}
        >
          {notice.tone === "error" ? <CircleAlert size={17} /> : <Check size={17} />}{notice.text}
        </div>
      )}
      <div className="product-grid">
        <main>
          <section className="product-step">
            <div className="product-step-title">
              <div><h2>选择素材</h2><p>只接受图片和视频；时长会根据实际可用片段自动适配。</p></div>
              <div className="product-actions">
                <button className="product-primary-soft" onClick={() => void importAssets("files")} disabled={Boolean(busy) || formLocked}><FileVideo2 size={15} />选择素材</button>
                {!formLocked && <details className="product-add-more">
                  <summary>更多添加方式</summary>
                  <div>
                    <button onClick={() => void importAssets("folder")} disabled={Boolean(busy)}><FolderOpen size={15} />添加文件夹</button>
                    <button
                      onClick={() => setAssetPickerOpen((value) => !value)}
                      aria-expanded={assetPickerOpen}
                      aria-controls="product-v2-asset-picker"
                    >
                      从素材库选择
                    </button>
                  </div>
                </details>}
              </div>
            </div>
            <div className="product-selected-header">
              <div><strong>已选素材</strong><span>{selected.length} 条</span></div>
              {selected.length > 0 && !formLocked && <button className="product-clear-selection" onClick={() => setSelected([])}>清空选择</button>}
            </div>
            {!selectedAssetItems.length ? (
              <div className="product-empty product-empty-compact"><FileVideo2 size={18} />还没有素材，请添加文件或从素材库选择。</div>
            ) : (
              <div className="product-selected-list">
                {selectedAssetItems.slice(0, 8).map((item) => (
                  <div className="product-selected-item" key={item.assetId}>
                    <span className="product-asset-icon">{item.mediaKind === "image" ? "图" : "视"}</span>
                    <span><strong title={item.displayName}>{item.displayName}</strong><small>{assetMediaLabel(item)}</small></span>
                    <button aria-label={`移除素材 ${item.displayName}`} onClick={() => setSelected((value) => value.filter((id) => id !== item.assetId))} disabled={formLocked}><X size={14} /></button>
                  </div>
                ))}
                {selectedAssetItems.length > 8 && <div className="product-selected-more">另有 {selectedAssetItems.length - 8} 条素材已选中</div>}
              </div>
            )}
            {selectedAssetGateMessage && <p className="product-preflight">{selectedAssetGateMessage}</p>}

            {assetPickerOpen && (
              <div className="product-asset-picker" id="product-v2-asset-picker">
                <div className="product-asset-picker-head"><strong>素材库</strong><span>{pickerAssets.length} 条匹配素材</span></div>
                <div className="product-asset-picker-tools">
                  <label className="product-asset-search">
                    <Search size={14} aria-hidden="true" />
                    <span className="product-sr-only">搜索素材</span>
                    <input value={assetSearch} onChange={(event) => setAssetSearch(event.target.value)} placeholder="按文件名搜索" />
                  </label>
                  <div className="product-asset-filters" aria-label="素材类型筛选">
                    {(["all", "video", "image"] as AssetFilter[]).map((filter) => (
                      <button
                        key={filter}
                        className={assetFilter === filter ? "is-active" : ""}
                        aria-pressed={assetFilter === filter}
                        onClick={() => setAssetFilter(filter)}
                      >
                        {filter === "all" ? "全部" : filter === "video" ? "视频" : "图片"}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="product-asset-picker-list">
                  {!visiblePickerAssets.length ? <div className="product-empty product-picker-empty">没有找到匹配素材。</div> : visiblePickerAssets.map((item) => {
                    const checked = selected.includes(item.assetId);
                    return (
                      <label className={checked ? "is-selected" : ""} key={item.assetId}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={formLocked}
                          onChange={() => setSelected((value) => checked ? value.filter((id) => id !== item.assetId) : [...value, item.assetId])}
                        />
                        <span className="product-asset-icon">{item.mediaKind === "image" ? "图" : "视"}</span>
                        <span><strong title={item.displayName}>{item.displayName}</strong><small>{assetMediaLabel(item)}</small></span>
                      </label>
                    );
                  })}
                </div>
                <div className="product-picker-footer">
                  <span>已显示 {Math.min(visibleAssetCount, pickerAssets.length)} / {pickerAssets.length} 条</span>
                  {visibleAssetCount < pickerAssets.length && <button onClick={() => setVisibleAssetCount((value) => value + PRODUCT_ASSET_PAGE_SIZE)}>加载更多素材</button>}
                </div>
              </div>
            )}
          </section>

          <section className="product-step">
            <div className="product-step-title">
              <b>脚本</b>
              <div><h2>先解析，再引导填写</h2><p>你只需填写标题和最多 5 项信息；产品参数、效果与画面事实仍以素材为准。</p></div>
            </div>
            {!guidedSession && (
              <div className="product-guided-start">
                <div><strong>第 1 步：解析所选素材</strong><span>分析可用画面和真实信息后，再生成适合这批素材的填写项。</span></div>
                <button
                  type="button"
                  data-xiaoxi-auto-mix-prepare
                  className="product-primary-soft"
                  onClick={() => void prepareGuidedAnalysis()}
                  disabled={Boolean(busy) || formLocked || !selectedAssetsReady}
                >
                  {busy === "prepare" ? <LoaderCircle className="is-spinning" size={16} /> : <Sparkles size={16} />}开始解析素材
                </button>
              </div>
            )}
            {guidedSession?.status === "analyzing" && (
              <div className="product-task product-guided-task" role="status" aria-live="polite">
                <div><strong>正在解析素材</strong><span>{Math.round((guidedSession.analysisTask?.progress || 0) * 100)}%</span></div>
                <progress max={100} value={Math.round((guidedSession.analysisTask?.progress || 0) * 100)} />
                <small>分析完成后会显示 5 个以内的填写项。</small>
              </div>
            )}
            {guidedSession?.status === "drafting" && (
              <div className="product-task product-guided-task" role="status" aria-live="polite">
                <div><strong>正在生成 AI 脚本</strong><span>{Math.round((guidedSession.draftTask?.progress || 0) * 100)}%</span></div>
                <progress max={100} value={Math.round((guidedSession.draftTask?.progress || 0) * 100)} />
                <small>脚本会结合当前素材与已填写信息，不会自动补造素材里没有的参数或效果。</small>
              </div>
            )}
            {(guidedSession?.status === "ready_for_answers" || guidedSession?.status === "ready_for_render") && (
              <>
                <div className="product-analysis-summary">
                  <div>
                    <strong>素材解析完成</strong>
                    <span>可用画面 {formatDuration(guidedSession.analysis.usableMaterialDurationMs)} · 已选 {guidedSession.analysis.selectedSegmentCount || 0} 个片段</span>
                    {analysisDurationPlan && <span className="product-duration-plan">智能适配：预计约 {formatDuration(analysisDurationPlan.targetDurationMs)}（{formatDuration(analysisDurationPlan.minimumDurationMs)}–{formatDuration(analysisDurationPlan.maximumDurationMs)}）</span>}
                  </div>
                  {guidedSession.analysis.materialFacts?.length ? (
                    <ul>{guidedSession.analysis.materialFacts.slice(0, 4).map((item, index) => <li key={`${item.text}-${index}`}>{item.text}</li>)}</ul>
                  ) : <span>未展示具体事实，请按实际业务信息补充。</span>}
                </div>
                <p className="product-guided-prefill-note">已根据本次素材解析预填建议内容，可直接修改；素材里无法确认的信息会保持空白。</p>
                {guidedKnownDraftFailure && (
                  <div className="product-state-callout is-error" role="alert">
                    <CircleAlert size={16} />
                    <span>{guidedDraftFailureText}</span>
                  </div>
                )}
                <div className="product-form-grid product-guided-form-grid">
                  <label className="span-2">
                    视频标题
                    <input
                      value={title}
                      onChange={(event) => {
                        guidedFormEditedRef.current = true;
                        setTitle(event.target.value);
                        if (guidedSession.draft.scriptRevision) setScriptInputDirty(true);
                      }}
                      placeholder="素材解析完成后会自动预填，可按需修改"
                      maxLength={100}
                      disabled={formLocked}
                    />
                    <small>用于开场画面文字，最多 100 字。</small>
                  </label>
                  <label>
                    公司名称（可选）
                    <input value={guidedAnswers.companyName} maxLength={80} disabled={formLocked} onChange={(event) => {
                      guidedFormEditedRef.current = true;
                      setGuidedAnswers((value) => ({ ...value, companyName: event.target.value }));
                      if (guidedSession.draft.scriptRevision) setScriptInputDirty(true);
                    }} placeholder="未从素材确认时可留空" />
                  </label>
                  <label>
                    介绍的产品或服务 <em>必填</em>
                    <input value={guidedAnswers.productName} maxLength={100} disabled={formLocked} onChange={(event) => {
                      guidedFormEditedRef.current = true;
                      setGuidedAnswers((value) => ({ ...value, productName: event.target.value }));
                      if (guidedSession.draft.scriptRevision) setScriptInputDirty(true);
                    }} placeholder="素材解析后自动预填；未识别时请补充" />
                  </label>
                  <label>
                    主要应用场景（可选）
                    <input value={guidedAnswers.targetScene} maxLength={180} disabled={formLocked} onChange={(event) => {
                      guidedFormEditedRef.current = true;
                      setGuidedAnswers((value) => ({ ...value, targetScene: event.target.value }));
                      if (guidedSession.draft.scriptRevision) setScriptInputDirty(true);
                    }} placeholder="根据素材解析自动预填，可按需修改" />
                  </label>
                  <label>
                    最想表达的一句话（可选）
                    <input value={guidedAnswers.keyMessage} maxLength={300} disabled={formLocked} onChange={(event) => {
                      guidedFormEditedRef.current = true;
                      setGuidedAnswers((value) => ({ ...value, keyMessage: event.target.value }));
                      if (guidedSession.draft.scriptRevision) setScriptInputDirty(true);
                    }} placeholder="根据素材解析自动预填，可按需修改" />
                  </label>
                  <label className="span-2">
                    还要保留或避开的信息（可选）
                    <input value={guidedAnswers.extraNotes} maxLength={240} disabled={formLocked} onChange={(event) => {
                      guidedFormEditedRef.current = true;
                      setGuidedAnswers((value) => ({ ...value, extraNotes: event.target.value }));
                      if (guidedSession.draft.scriptRevision) setScriptInputDirty(true);
                    }} placeholder="仅保留素材可核验信息，可按需修改" />
                  </label>
                </div>
                <div className="product-submit">
                  <p className="product-generate-note">第 2 步：AI 会把你的填写内容和素材事实合成脚本。填写的企业与产品信息按你的确认写入；画面效果不凭空补造。</p>
                  <button
                    type="button"
                    data-xiaoxi-auto-mix-script
                    className="product-primary-soft product-script-button"
                    onClick={() => void generateGuidedScript()}
                    aria-describedby={scriptGenerateDisabledReason ? "product-script-generate-state" : undefined}
                    disabled={Boolean(scriptGenerateDisabledReason)}
                  >
                    {busy === "script" ? <LoaderCircle className="is-spinning" size={17} /> : <Sparkles size={17} />}
                    {guidedKnownDraftFailure || guidedSession.draft.scriptRevision ? "重新生成 AI 脚本" : "AI 生成脚本"}
                  </button>
                  {scriptGenerateDisabledReason && <p id="product-script-generate-state" className="product-submit-state" role="status">{scriptGenerateDisabledReason}</p>}
                </div>
                {guidedSession.draft.scriptRevision > 0 && (
                  <article className={`product-script-preview ${scriptInputDirty ? "is-stale" : ""}`}>
                    <div><strong>第 3 步：确认脚本 v{guidedSession.draft.scriptRevision}</strong><span>{scriptInputDirty ? "填写内容已修改，请重新生成脚本" : "该脚本将用于口播字幕与画面文字"}</span></div>
                    {draftDurationPlan ? (
                      <p className="product-script-duration-plan">智能适配：预计约 {formatDuration(draftDurationPlan.targetDurationMs)}（{formatDuration(draftDurationPlan.minimumDurationMs)}–{formatDuration(draftDurationPlan.maximumDurationMs)}） · 本次脚本 {draftSpokenPhrases.length} 段口播</p>
                    ) : (
                      <p className="product-script-duration-warning">这个脚本由旧版本生成，尚未按素材容量规划时长；请重新生成 AI 脚本后再一键成片。</p>
                    )}
                    {guidedSession.draft.hook && <p><b>开场：</b>{guidedSession.draft.hook}</p>}
                    {draftSpokenPhrases.length > 0 ? (
                      <ol className="product-script-phrases">
                        {draftSpokenPhrases.map((phrase, index) => <li key={`${phrase}-${index}`}>{phrase}</li>)}
                      </ol>
                    ) : <p className="product-script-voiceover">{guidedSession.draft.voiceover || "脚本内容正在准备。"}</p>}
                    {guidedSession.draft.cta && <p><b>结尾：</b>{guidedSession.draft.cta}</p>}
                  </article>
                )}
                {guidedSession.draft.scriptRevision > 0 && !scriptInputDirty && draftDurationPlan && (
                  <article className="product-supplemental-image">
                    <div className="product-supplemental-image-heading">
                      <div>
                        <strong>可选第 4 步：生成 1 张 AI 补图</strong>
                        <span>9:16 场景辅助画面，不会作为产品真实素材或事实依据。</span>
                      </div>
                      {supplementalImage?.status === "completed" && <span className="product-supplemental-image-badge">已生成</span>}
                    </div>
                    {supplementalImage?.status === "completed" && supplementalImage.operationId ? (
                      <figure className="product-supplemental-image-preview">
                        <img src={`xiaoxi-content://supplemental/${supplementalImage.operationId}/image`} alt="AI 生成的 9:16 场景辅助画面" />
                        <figcaption>AI 场景辅助图（非原始素材）；一键成片会在不覆盖真实素材证据的前提下使用它。</figcaption>
                      </figure>
                    ) : (
                      <>
                        <p>会依据已确认脚本和已解析的场景信息生成一张无文字、无 Logo、无未经证实卖点的补图。它可用于过渡或结尾，原始素材仍是成片事实依据。</p>
                        {supplementalImage?.status === "submitted" || supplementalImage?.status === "planned" ? (
                          <div className="product-state-callout is-unknown"><LoaderCircle className="is-spinning" size={16} /><span>补图已提交，正在等待结果；请不要重复点击。</span></div>
                        ) : supplementalImage?.status === "outcome_unknown" ? (
                          <div className="product-state-callout is-unknown"><CircleAlert size={16} /><span>本次补图结果暂时无法确认。为避免重复扣费，系统不会自动重提；请重新生成脚本后再创建新的补图。</span></div>
                        ) : supplementalImage?.status === "failed" ? (
                          <div className="product-state-callout is-error"><CircleAlert size={16} /><span>补图没有生成成功。请检查 AI 图片服务配置后，重新生成脚本再试。</span></div>
                        ) : (
                          <label className="product-paid-consent">
                            <input type="checkbox" checked={supplementalImageConsent} onChange={(event) => setSupplementalImageConsent(event.target.checked)} disabled={Boolean(busy) || formLocked} />
                            <span>我确认将发起 1 次可能计费的 AI 图片生成；以供应商账单为准。</span>
                          </label>
                        )}
                        <button
                          type="button"
                          data-xiaoxi-auto-mix-supplemental-image
                          className="product-primary-soft product-supplemental-image-button"
                          onClick={() => void generateSupplementalImage()}
                          disabled={Boolean(busy) || formLocked || !supplementalImageConsent || supplementalImage?.status === "submitted" || supplementalImage?.status === "planned" || supplementalImage?.status === "outcome_unknown" || supplementalImage?.status === "failed"}
                        >
                          {busy === "supplemental-image" || supplementalImage?.status === "submitted" || supplementalImage?.status === "planned" ? <LoaderCircle className="is-spinning" size={16} /> : <Sparkles size={16} />}
                          {supplementalImage?.status === "submitted" || supplementalImage?.status === "planned" ? "正在生成 AI 补图" : "生成 1 张 AI 补图"}
                        </button>
                      </>
                    )}
                  </article>
                )}
              </>
            )}
            {(guidedSession?.status === "failed" || guidedSession?.status === "outcome_unknown") && (
              <div className="product-state-callout is-error product-guided-restart">
                <CircleAlert size={16} />
                <span>当前解析或脚本任务未完成。为避免重复调用，未知结果不会自动重提；请重新解析素材后再继续。</span>
                <button
                  type="button"
                  data-xiaoxi-auto-mix-prepare
                  onClick={() => void prepareGuidedAnalysis()}
                  disabled={Boolean(busy) || formLocked || !selectedAssetsReady}
                >
                  重新解析素材
                </button>
              </div>
            )}
            <div className="product-submit">
              <p className="product-generate-note">第 5 步：固定生成 1 条。{draftDurationPlan ? <>AI 会按本次脚本的实际配音时长生成，计划约 {formatDuration(draftDurationPlan.targetDurationMs)}；不会为凑时长循环、拉伸或补静音。</> : <>请先重新生成 AI 脚本，以获得按素材容量自动适配的时长规划。</>} 竖版素材保持全屏；横版素材保留完整前景并置于 9:16 画布，不裁掉主体。成片会继续走字幕、自然配音、授权音乐和音量平衡检查。</p>
              <button
                data-xiaoxi-auto-mix-create
                className="product-generate"
                onClick={() => void generate()}
                disabled={Boolean(busy) || planRunning || planRequiresResolution || !selectedAssetsReady || !title.trim() || !guidedSession?.sessionId || guidedSession?.status !== "ready_for_render" || !guidedSession?.draft?.scriptRevision || !guidedSession?.draft?.durationPlan?.targetDurationMs || scriptInputDirty}
              >
                {busy === "generate" || planRunning ? <LoaderCircle className="is-spinning" size={18} /> : <Sparkles size={18} />}
                {createButtonLabel === "一键生成" ? "使用此脚本一键成片" : createButtonLabel}
              </button>
              {planCopy && (
                <div className={`product-task product-v2-state is-${plan?.state}`} role="status" aria-live="polite">
                  <div><strong>{planCopy.title}</strong>{planProgressVisible && <span>{planCopy.progress}%</span>}</div>
                  {planProgressVisible && <progress max={100} value={planCopy.progress} />}
                  <small>{plan?.state === "needs_attention" && plan ? attentionText(plan) : planCopy.detail}</small>
                </div>
              )}
            </div>
          </section>

          {(plan || legacyProject) && (
            <section className="product-results">
              <div className="product-results-title"><h2>{legacyProject ? "历史成片" : "成片结果"}</h2></div>
              {legacyProject ? (
                <div className="product-legacy-readonly">
                  <strong>{legacyProject.name}</strong>
                  <p>这是旧版项目的只读记录。</p>
                  <dl>
                    <div><dt>项目状态</dt><dd>{legacyProject.status || "未知"}</dd></div>
                    <div><dt>历史候选</dt><dd>{legacyCandidates.length || legacyProject.generatedCount || 0} 条</dd></div>
                  </dl>
                  {legacyCandidates.length > 0 && <ul>{legacyCandidates.map((item) => <li key={item.generatedVideoId}>{item.title || "旧版候选"} · {formatDuration(item.durationMs)}</li>)}</ul>}
                </div>
              ) : plan && (
                <article className="product-candidate product-v2-result">
                  <div className="product-video-frame">
                    {formalPreviewReady && candidate ? (
                      <video controls preload="metadata" src={`xiaoxi-content://generated/${candidate.generatedVideoId}/video`} aria-label="一键成片预览" />
                    ) : (
                      <div className="product-video-placeholder">
                        {planRunning ? <LoaderCircle className="is-spinning" size={30} /> : <Play size={30} />}
                        <span>{planRunning ? "正在生成" : formalEvidenceReady ? "预览准备中" : "本次生成尚未完成"}</span>
                      </div>
                    )}
                  </div>
                  <div className="product-candidate-body">
                    <div className="product-v2-result-heading">
                      <div><strong>{candidate?.title || title || "一键成片"}</strong><span>{formatDuration(plan.selectedDurationMs)}</span></div>
                      <span className={`product-v2-ready-badge ${formalEvidenceReady ? "is-ready" : ""}`}>
                        {formalEvidenceReady ? "成片已生成" : planRunning ? "生成中" : "生成未完成"}
                      </span>
                    </div>
                    {plan.state === "needs_attention" && <p className="product-state-callout is-attention"><CircleAlert size={16} />{attentionText(plan)}</p>}
                    {plan.state === "outcome_unknown" && <p className="product-state-callout is-unknown"><CircleAlert size={16} />配音结果暂时无法确认。点击下方按钮查询已有结果，系统不会重复创建声音。</p>}
                    {plan.state === "failed" && <p className="product-state-callout is-error"><CircleAlert size={16} />本次运行未生成成片。{canContinueFromIssue ? "点击“继续生成成片”，从失败环节接着完成。" : "请修改素材、标题或文案后重新生成。"}</p>}

                    <div className="product-card-actions product-v2-actions">
                      <button onClick={() => void download()} disabled={!formalEvidenceReady || busy === "download" || !api()?.creative.downloadCandidate}>
                        {busy === "download" ? <LoaderCircle className="is-spinning" size={14} /> : <Download size={14} />}保存成片
                      </button>
                      {canContinueFromIssue && continuationLayer && (
                        <button
                          type="button"
                          data-xiaoxi-auto-mix-continue
                          data-xiaoxi-auto-mix-regenerate
                          onClick={() => void regenerate(continuationLayer)}
                          disabled={Boolean(busy)}
                        >
                          {busy === `regenerate-${continuationLayer}` ? <LoaderCircle className="is-spinning" size={14} /> : <RefreshCw size={14} />}
                          {busy === `regenerate-${continuationLayer}` ? "正在继续" : "继续生成成片"}
                        </button>
                      )}
                      {plan.state === "needs_attention" && (plan.attention?.layer === "voice" || plan.attention?.layer === "music") && (
                        <button type="button" className="product-secondary-button" onClick={() => openResources(plan.attention?.layer as "voice" | "music")}>
                          <Settings2 size={14} />处理{plan.attention.layer === "voice" ? "配音" : "音乐"}问题
                        </button>
                      )}
                      {plan.state === "outcome_unknown" && plan.attention?.layer === "voice" && (
                        <button
                          type="button"
                          data-xiaoxi-auto-mix-reconcile-unknown-voice
                          data-xiaoxi-auto-mix-regenerate
                          className="product-secondary-button"
                          onClick={() => void reconcileUnknownVoice()}
                          disabled={Boolean(busy)}
                        >
                          {busy === "reconcile-unknown-voice" ? <LoaderCircle className="is-spinning" size={14} /> : <RefreshCw size={14} />}
                          {busy === "reconcile-unknown-voice" ? "正在查询" : "查询结果并继续"}
                        </button>
                      )}
                    </div>

                    <details className="product-quality-details">
                      <summary>查看质量信息</summary>
                      {evidenceIssue && <p className="product-fallback"><strong>正式门槛未通过</strong>{evidenceIssue}</p>}
                      <div className="product-v2-evidence-grid">
                        <div><strong>素材时长适配</strong><span>{durationFitSummary(plan)}</span></div>
                        <div><strong>口播字幕轨</strong><span>{summarizeTrack(plan.speechCaptions, "口播字幕尚未生成。")}</span></div>
                        <div><strong>画面文字轨</strong><span>{summarizeTrack(plan.visualTextItems, "画面文字尚未生成。")}</span></div>
                        <div><strong>声音人格</strong><span>{personaSummary(plan)}</span></div>
                        <div><strong>音乐授权</strong><span>{licenseSummary(plan)}</span></div>
                        <div><strong>质量报告</strong><span>{qualitySummary}</span></div>
                      </div>
                      <div className="product-quality-warnings">
                        <strong>质量警告</strong>
                        {plan.qualityWarnings.length ? (
                          <ul>{plan.qualityWarnings.map((warning, index) => <li key={`${index}-${warningText(warning)}`}>{warningText(warning)}</li>)}</ul>
                        ) : <p>当前没有质量警告。</p>}
                      </div>
                      <p className="product-technical-note">FFmpeg 基础输出只用于诊断；正式成片必须通过 Remotion 渲染和音量质量检查。</p>
                    </details>

                    {!canContinueFromIssue && regenerationLayers.length > 0 && (
                      <details className="product-adjust-details">
                        <summary>效果不满意？调整</summary>
                        <div className="product-layer-actions" aria-label="局部重新生成">
                          {regenerationLayers.map((layer) => (
                            <button key={layer} data-xiaoxi-auto-mix-regenerate onClick={() => void regenerate(layer)} disabled={Boolean(busy)}>
                              <RefreshCw size={14} />{plan.state === "completed" ? "重做" : "恢复"}{LAYER_LABELS[layer]}层
                            </button>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                </article>
              )}
            </section>
          )}
        </main>
      </div>
      <AutoMixResourcePanel
        open={resourcePanelOpen}
        onClose={() => setResourcePanelOpen(false)}
        initialSection={resourceSection}
        {...resourceApi}
      />
    </section>
  );
}
