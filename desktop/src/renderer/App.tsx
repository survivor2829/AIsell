import {
  BarChart3,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clapperboard,
  FileText,
  Folder,
  Images,
  ListTodo,
  Lock,
  LogOut,
  MessageCircle,
  MonitorPlay,
  Pause,
  Play,
  RefreshCw,
  Save,
  Send,
  Square,
  ThumbsUp,
  Trash2,
  UserRound,
  UserX,
  UsersRound,
  Video,
  X
} from "lucide-react";
import { lazy, Suspense, type ComponentType, useEffect, useMemo, useRef, useState } from "react";
import productBrand from "../../product-brand.json";
import packageInfo from "../../package.json";
import { LoginScreen } from "./LoginScreen";
import { AiExpert } from "./AiExpert";
import { AutoReply, FloatingAutoReplyWindow } from "./AutoReply";
import { FloatingMomentsCampaignWindow } from "./MomentsCampaignPanel";
import { Diagnostics } from "./Diagnostics";
import { ProductDetailPage } from "./ProductDetailPage";
import { FinishedVideoCenterPage } from "./ContentFoundationPage";
import { CreativeWorkspacePage } from "./CreativeWorkspacePage";
import { CreativeStudioPage } from "./CreativeStudioPage";
import { BatchCreativePage, BatchFinishedOverview } from "./BatchCreativePage";
import { MaterialsCollectionsPage } from "./BatchAssets";
import type { Collection } from "./batch-studio-api";
import { ProductOneClickPage } from "./ProductOneClickPage";
import { FloatingWorkflowWindow, useWechatWorkflow, WechatWorkflowPage, WorkflowLauncher } from "./WechatWorkflow";
import { AGENT_ROLE_IDENTITIES, AgentHome, type AgentHomeTarget, type AgentRoleKey } from "./AgentHome";

type ModuleKey = AgentRoleKey | AgentHomeTarget | "api-key" | "diagnostics";
type GroupKey = AgentRoleKey;
type NavItem = { key: ModuleKey; label: string; icon: ComponentType<{ size?: number; strokeWidth?: number }> };
type NavGroup = NavItem & { key: GroupKey; persona: string; children: NavItem[] };
type WechatIdentity = { account_id: string; nickname: string; avatar_url: string; synced_at: string };
type LicenseStatus = { authorized: boolean; licenseId?: string; expiresAt?: string; code?: string; error?: string };
type ActiveTouchState = {
  calibrated: boolean;
  target_selected: boolean;
  conversation_located: boolean;
  conversation_verified: boolean;
  dry_run: boolean;
  selected_customer: ContactRow | null;
  conversation_title: string;
  located_window_title: string;
  search_input_done: boolean;
  search_result_clicked: boolean;
  search_query: string;
  message_input_done: boolean;
  message_draft: string;
  send_gate_status: string;
  send_gate_reason: string;
  real_send_armed: boolean;
  real_send_enabled: boolean;
  real_send_clicked: boolean;
  real_send_status: string;
  real_send_reason: string;
  post_send_verified: boolean;
  post_send_status: string;
  post_send_reason: string;
  message_bubble_verified: boolean;
  message_bubble_status: string;
  message_bubble_reason: string;
  queue_dry_run_count: number;
  queue_dry_run_passed: boolean;
  queue_dry_run_results: Array<{ id: string; name: string; ok: boolean; result: string }>;
};
type ContactRow = {
  id: string;
  name: string;
  tag: string;
  lastTouch: string;
  allowed: boolean;
  remark?: string;
  nickname?: string;
  wechatId?: string;
  wxid?: string;
  wechatAccountId?: string;
  source?: string;
  syncedAt?: string;
  avatarUrl?: string;
};
type ActiveTouchResult = {
  ok: boolean;
  send_attempted?: boolean | null;
  action: string;
  state?: Partial<ActiveTouchState>;
  contacts?: ContactRow[];
  logs?: RunLog[];
  error?: string;
};
type MomentsDryRunResult = {
  ok: boolean;
  action: string;
  blocked_reason?: string;
  error?: string;
  dry_run?: boolean;
  real_action_attempted?: boolean;
  plan?: {
    mode: "targeted" | "random";
    action_order: Array<"comment" | "like">;
    visible_post_count?: number;
    verification_level: string;
    target_verified: false;
  };
  window?: {
    title: string;
    className: string;
    automationId: string;
    identityMode: "automation_id" | "structural_sns_feed" | "visual_mmui_render";
    rootName: "朋友圈";
    rootControlType: "ControlType.Window";
    rootProcessId: number;
    feedAutomationId: "sns_list" | "";
    feedRuntimeId: string;
    feedCount: 0 | 1;
    renderPaneName?: "MMUIRenderSubWindowHW";
    renderPaneAutomationId?: string;
    renderPaneControlType?: "ControlType.Pane";
    renderPaneProcessId?: number;
    renderPaneRuntimeId?: string;
    renderPaneBounds?: { left: number; top: number; width: number; height: number };
    processName: string;
    pid: number;
    hWnd: string;
    left?: number;
    top?: number;
    width?: number;
    height?: number;
  };
  post_snapshot?: {
    observation_id: string;
    post_fingerprint: string;
    source: "uia:sns_list" | "visual:windows_media_ocr";
    identity_scope: "window_session_only";
    runtime_id?: string;
    structure_verified: true;
    feed_depth?: number;
    ocr_provider?: "windows_media_ocr";
    ocr_language?: "zh-Hans-CN";
    region_hash?: string;
    avatar_hash?: string;
    layout_hash?: string;
    bounds?: { left: number; top: number; width: number; height: number };
    menu_bounds?: { left: number; top: number; width: number; height: number };
    avatar_bounds?: { left: number; top: number; width: number; height: number };
    label: string;
    preview: string;
    like_state: "unknown";
    comment_state: "unknown";
  };
};
type MomentsActionResult = {
  ok: boolean;
  action: string;
  status?: "blocked" | "outcome_unknown" | "verified";
  blocked_reason?: string;
  error?: string;
  real_action_attempted?: boolean | null;
  retry_locked?: boolean;
  observation_id?: string;
  menu_state?: "赞" | "取消" | "取消赞";
  comment_draft_verified?: boolean;
  comment_draft_verification_mode?: string;
  comment_send_supported?: boolean;
  no_op?: boolean;
  comment_text?: string;
  verification_mode?: string;
  verification_level?: "visible_exact" | "clipboard_exact" | "uia_exact";
  readback_enhancement_status?: "not_requested" | "verified" | "failed";
};
type ContactSyncState = {
  status: string;
  contact_count: number;
  last_synced_at: string;
  last_error: string;
  last_stage: string;
  account_name: string;
  helper_configured: boolean;
  wechat_exe_path: string;
  wechat_root: string;
  wechat_identity?: WechatIdentity | null;
  account_changed?: boolean;
};
type ContactSyncResult = {
  ok: boolean;
  action: string;
  state?: Partial<ContactSyncState>;
  contacts?: ContactRow[];
  blocked_reason?: string;
  error?: string;
};
type TouchTaskItem = {
  id: string;
  name: string;
  contact: ContactRow;
  contact_index?: number;
  status: string;
  reason: string;
  message: string;
  ai_status?: "generated" | "fallback" | "failed";
  ai_reason?: string;
  ai_error_code?: string;
  updated_at: string;
  outcome_unknown_retry_count?: number;
  awaiting_resolution?: boolean;
};
type TouchTaskExcludedContact = {
  contact: ContactRow;
  reason_code?: string;
  reason: string;
};
type TouchTaskPreview = {
  eligible: ContactRow[];
  excluded: TouchTaskExcludedContact[];
  total?: number;
  eligible_count?: number;
  excluded_count?: number;
  reason_counts?: Record<string, number>;
};
type TouchTaskState = {
  id: string;
  status: string;
  version?: number;
  execution_mode?: string;
  phase?: string;
  script: string;
  started_at: string;
  updated_at: string;
  completed_at: string;
  current_index: number;
  total: number;
  eligible_total?: number;
  excluded_total?: number;
  excluded_contacts?: TouchTaskExcludedContact[];
  batch_size?: number;
  current_batch?: number;
  batch_start_index?: number;
  batch_end_index?: number;
  next_send_not_before?: string;
  pause_reason: string;
  current_contact: ContactRow | null;
  next_contact: ContactRow | null;
  current_result: TouchTaskItem | null;
  result_updates?: TouchTaskItem[];
  results: TouchTaskItem[];
};
type TouchTaskResult = {
  ok: boolean;
  task?: TouchTaskState;
  preview?: TouchTaskPreview;
  error?: string;
};
type DeepSeekApiResult = { ok: boolean; data?: { configured?: boolean; maskedKey?: string; code?: string; error?: string }; code?: string; category?: string; error?: string };
type ProductDetailAiSettingsResult = {
  ok: boolean;
  data?: {
    provider?: "apimart";
    enabled?: boolean;
    configured?: boolean;
    ready?: boolean;
    baseUrl?: string;
    model?: string;
    secureStorageAvailable?: boolean;
    valid?: boolean;
    paidCallPerformed?: false;
    code?: string;
    error?: string;
  };
  code?: string;
  error?: string;
};

declare global {
  interface Window {
    xiaoxiLicenseAuth?: {
      status: () => Promise<LicenseStatus>;
      activate: (code: string) => Promise<LicenseStatus>;
      logout: () => Promise<LicenseStatus>;
    };
    xiaoxiActiveTouch?: {
      status: () => Promise<ActiveTouchResult>;
      calibrate: () => Promise<ActiveTouchResult>;
      momentsDryRun: (payload: { mode: "targeted" | "random"; likeEnabled: boolean; commentEnabled: boolean; commentText: string }) => Promise<MomentsDryRunResult>;
      momentsInspectMenu: (payload: { observationId: string }) => Promise<MomentsActionResult>;
      momentsLike: (payload: { observationId: string }) => Promise<MomentsActionResult>;
      momentsComment: (payload: { observationId: string; commentText: string }) => Promise<MomentsActionResult>;
      clearCustomer: () => Promise<ActiveTouchResult>;
      sendDryRun: (payload: { message: string }) => Promise<ActiveTouchResult>;
      sendSelectedContact: (payload: { contactId: string; message: string }) => Promise<ActiveTouchResult>;
      selectCustomer: (payload: { id: string }) => Promise<ActiveTouchResult>;
      verifyConversation: (payload: { title: string }) => Promise<ActiveTouchResult>;
      locateConversation: () => Promise<ActiveTouchResult>;
      openConversationDryRun: () => Promise<ActiveTouchResult>;
      searchConversationDryRun: () => Promise<ActiveTouchResult>;
      clickSearchResultDryRun: () => Promise<ActiveTouchResult>;
      inputMessageDryRun: (payload: { message: string }) => Promise<ActiveTouchResult>;
      queueDryRun: (payload: { ids: string[]; message: string }) => Promise<ActiveTouchResult>;
      setRealSendArm: (payload: { enabled: boolean }) => Promise<ActiveTouchResult>;
      verifyRealSendSession: () => Promise<ActiveTouchResult>;
      verifyMessageBubble: () => Promise<ActiveTouchResult>;
      verifyWindowTitle: () => Promise<ActiveTouchResult>;
      failConversation: () => Promise<ActiveTouchResult>;
    };
    xiaoxiContactSync?: {
      status: () => Promise<ContactSyncResult>;
      sync: () => Promise<ContactSyncResult>;
      capture: () => Promise<ContactSyncResult>;
      chooseWechatExe: () => Promise<ContactSyncResult>;
      chooseWechatRoot: () => Promise<ContactSyncResult>;
      autoDetectPaths: () => Promise<ContactSyncResult>;
    };
    xiaoxiTouchTask?: {
      start: (payload: { script: string; excludedContactIds: string[] }) => Promise<TouchTaskResult>;
      status: () => Promise<TouchTaskResult>;
      pause: () => Promise<TouchTaskResult>;
      resume: () => Promise<TouchTaskResult>;
      stop: () => Promise<TouchTaskResult>;
      resolveUnknown: (payload: { taskId: string; contactId: string; resolution: "sent" | "skip" }) => Promise<TouchTaskResult>;
      showMain: () => Promise<TouchTaskResult>;
      closeFloating: () => Promise<TouchTaskResult>;
      onUpdate: (callback: (payload: TouchTaskResult) => void) => () => void;
    };
    xiaoxiDeepSeekApi?: {
      status: () => Promise<DeepSeekApiResult>;
      save: (payload: { apiKey: string }) => Promise<DeepSeekApiResult>;
      test: (payload?: { apiKey?: string }) => Promise<DeepSeekApiResult>;
      remove: () => Promise<DeepSeekApiResult>;
    };
    xiaoxiProductDetailAiSettings?: {
      status: () => Promise<ProductDetailAiSettingsResult>;
      save: (payload: { apiKey: string }) => Promise<ProductDetailAiSettingsResult>;
      delete: () => Promise<ProductDetailAiSettingsResult>;
      validate: (payload?: { apiKey?: string }) => Promise<ProductDetailAiSettingsResult>;
    };
  }
}

const CONTACT_PAGE_SIZE = 50;
const XIAOXI_EDITION = import.meta.env.VITE_XIAOXI_EDITION;
const BUILD_ID = import.meta.env.VITE_XIAOXI_BUILD_ID || "";
const DEVELOPMENT_EDITION = XIAOXI_EDITION === "development";
const PILOT_EDITION = XIAOXI_EDITION === "pilot";
const REAL_SEND_EDITION = DEVELOPMENT_EDITION || PILOT_EDITION;
const DEFAULT_ACTIVE_MODULE: ModuleKey = "workflow";
const EDITION_LABEL = DEVELOPMENT_EDITION ? "测试版" : "";
const DEFAULT_TOUCH_MESSAGE = DEVELOPMENT_EDITION
  ? "{称呼}，您好，我们这边有清洁设备短租和会员特惠方案，想了解一下您近期是否需要降本增效？"
  : "";
const DevelopmentAcceptance = DEVELOPMENT_EDITION ? lazy(() => import("./DevelopmentAcceptance")) : null;

const agentChildren: NavItem[] = [
  { key: "expert", label: "AI专家", icon: Bot },
  { key: "workflow", label: "今日计划", icon: ListTodo },
  { key: "reply", label: "自动回复", icon: MessageCircle },
  { key: "contact-sync", label: "同步联系人", icon: UsersRound },
  { key: "touch", label: "精准触达", icon: Send },
  { key: "moments", label: "朋友圈运营", icon: ThumbsUp }
];

const productionChildren: NavItem[] = [
  { key: "product-detail", label: "产品详情图", icon: Images },
  { key: "materials", label: "素材仓库", icon: Folder },
  { key: "workspace", label: "创作工作台", icon: Clapperboard },
  { key: "finished", label: "成片中心", icon: Video },
  { key: "ai-video", label: "AI生成视频", icon: MonitorPlay }
];

const operationsChildren: NavItem[] = [
  { key: "accounts", label: "学员与账号", icon: UserRound },
  { key: "publish", label: "发布任务", icon: Clapperboard },
  { key: "ai-check", label: "AI检查", icon: CircleHelp },
  { key: "leads", label: "线索回流", icon: RefreshCw },
  { key: "data", label: "数据复盘", icon: BarChart3 }
];

const navGroups: NavGroup[] = [
  { key: "agent", persona: AGENT_ROLE_IDENTITIES.agent.name, label: AGENT_ROLE_IDENTITIES.agent.responsibility, icon: UsersRound, children: agentChildren },
  { key: "production", persona: AGENT_ROLE_IDENTITIES.production.name, label: AGENT_ROLE_IDENTITIES.production.responsibility, icon: Video, children: productionChildren },
  { key: "operations", persona: AGENT_ROLE_IDENTITIES.operations.name, label: AGENT_ROLE_IDENTITIES.operations.responsibility, icon: BarChart3, children: operationsChildren }
];

const apiKeyNavItem: NavItem = { key: "api-key", label: "API密钥", icon: Lock };
const diagnosticsNavItem: NavItem = { key: "diagnostics", label: "日志诊断", icon: FileText };
const navItems = [...navGroups.flatMap((group) => [group, ...group.children]), apiKeyNavItem, diagnosticsNavItem];

function nowTime() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function contactName(contact: ContactRow | null) {
  if (!contact) return "";
  return contact.remark?.trim() || contact.nickname?.trim() || contact.name || contact.wechatId || "";
}


function emptyTouchTask(): TouchTaskState {
  return {
    id: "",
    status: "idle",
    version: 4,
    execution_mode: "draft_only",
    phase: "idle",
    script: "",
    started_at: "",
    updated_at: "",
    completed_at: "",
    current_index: 0,
    total: 0,
    eligible_total: 0,
    excluded_total: 0,
    excluded_contacts: [],
    batch_size: 50,
    current_batch: 1,
    batch_start_index: 0,
    batch_end_index: 0,
    next_send_not_before: "",
    pause_reason: "",
    current_contact: null,
    next_contact: null,
    current_result: null,
    results: []
  };
}

function mergeTouchTaskState(current: TouchTaskState, incoming: TouchTaskState): TouchTaskState {
  if (Array.isArray(incoming.results)) return { ...current, ...incoming, results: incoming.results };
  const updates = Array.isArray(incoming.result_updates) ? incoming.result_updates : [];
  if (!updates.length) return { ...current, ...incoming, results: current.results };
  const results = [...current.results];
  for (const update of updates) {
    const contactIndex = Number.isInteger(update.contact_index) ? Number(update.contact_index) : -1;
    const existingIndex = contactIndex >= 0 && contactIndex < results.length
      ? contactIndex
      : results.findIndex((result) => result.id === update.id);
    if (existingIndex >= 0) results[existingIndex] = { ...results[existingIndex], ...update };
    else results.push(update);
  }
  return { ...current, ...incoming, results };
}

function taskStatusLabel(status: string) {
  const labels: Record<string, string> = {
    idle: "未开始",

    running: "执行中",
    paused: "已暂停",
    blocked: "已阻断",
    stopped: "已停止",
    completed: "已完成"
  };
  return labels[status] ?? status;
}


function moduleIsAvailable(key: ModuleKey) {
  return ["agent", "production", "operations", "workflow", "reply", "expert", "contact-sync", "touch", "moments", "accounts", "product-detail", "materials", "workspace", "finished", "api-key", "diagnostics"].includes(key);
}

function touchTaskStatusLabel(task: TouchTaskState) {
  if (["idle", "completed", "stopped"].includes(task.status)) return taskStatusLabel(task.status);
  if (task.status === "paused" && task.phase !== "awaiting_unknown_resolution") return taskStatusLabel(task.status);
  const phaseLabels: Record<string, string> = {
    preparing_batch: "准备触达文案",
    sending_batch: "发送中",
    waiting_for_idle: "等待电脑空闲",
    awaiting_unknown_resolution: "等待确认发送结果"
  };
  return phaseLabels[task.phase ?? ""] ?? taskStatusLabel(task.status);
}

function taskResultLabel(status: string) {
  const labels: Record<string, string> = {
    pending: "待处理",
    processing: "处理中",
    draft_ready: "草稿已填",
    generated: "文案已生成",
    prepared: "发送已准备",
    clicked: "已点击，待核验",
    sent_verified: "发送已核验",
    ai_failed: "AI暂时不可用，已暂停",
    ai_failed_skipped: "AI失败，已跳过",
    identity_skipped: "身份不唯一，已跳过",
    outcome_unknown: "结果未知，已暂停",
    outcome_unknown_skipped: "结果未知，已跳过",
    blocked: "已阻断",
    skipped: "已跳过"
  };
  return labels[status] ?? status;
}

function processedTouchResult(status: string) {
  return ["draft_ready", "sent_verified", "skipped", "ai_failed_skipped", "identity_skipped", "outcome_unknown_skipped"].includes(status);
}

export default function App() {
  const floatingMode = new URLSearchParams(window.location.search).get("floating");
  if (floatingMode === "workflow") return <FloatingWorkflowWindow />;
  if (floatingMode === "auto-reply") return <FloatingAutoReplyWindow />;
  if (floatingMode === "moments") return <FloatingMomentsCampaignWindow />;
  if (floatingMode === "1" || floatingMode === "touch") return <FloatingTouchWindow />;

  const [license, setLicense] = useState<LicenseStatus | null>(null);
  const [sessionEntered, setSessionEntered] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const workflow = useWechatWorkflow();
  const [active, setActive] = useState<ModuleKey>(DEFAULT_ACTIVE_MODULE);
  const [legacyWorkspace, setLegacyWorkspace] = useState(false);
  const [creativeView, setCreativeView] = useState<"studio" | "product" | "history">("studio");
  const [batchInitial, setBatchInitial] = useState<{ assetIds?: string[]; collection?: Collection; batchId?: string }>();
  const [creativeResumeTarget, setCreativeResumeTarget] = useState<{
    taskId: string;
    projectId?: string | null;
  } | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<GroupKey, boolean>>({ agent: true, production: true, operations: true });
  const [contactRows, setContactRows] = useState<ContactRow[]>([]);
  const [contactSyncBusy, setContactSyncBusy] = useState(false);
  const contactSyncInFlight = useRef(false);
  const [contactSyncState, setContactSyncState] = useState<ContactSyncState>({
    status: "idle",
    contact_count: 0,
    last_synced_at: "",
    last_error: "",
    last_stage: "idle",
    account_name: "",
    helper_configured: false,
    wechat_exe_path: "",
    wechat_root: ""
  });
  const [contactSyncError, setContactSyncError] = useState("");
  const [messageDraft, setMessageDraft] = useState(DEFAULT_TOUCH_MESSAGE);
  const [deepSeekConfigured, setDeepSeekConfigured] = useState(false);
  const addLog = (_action: string, _result: string) => undefined;

  useEffect(() => {
    setMessageDraft((current) => current || DEFAULT_TOUCH_MESSAGE);
  }, []);

  useEffect(() => {
    if (!window.xiaoxiLicenseAuth) {
      setLicense({ authorized: false, code: "license_service_unavailable", error: "当前版本未连接授权服务" });
      return;
    }
    void window.xiaoxiLicenseAuth.status().then(setLicense).catch(() => setLicense({ authorized: false, code: "license_status_failed" }));
  }, []);

  useEffect(() => {
    document.title = [productBrand.displayName, EDITION_LABEL, BUILD_ID].filter(Boolean).join(" ");
  }, []);

  const activeTitle = useMemo(() => navItems.find((item) => item.key === active)?.label ?? "自动回复", [active]);

  const selectGroup = (groupKey: GroupKey) => {
    setOpenGroups((current) => {
      if (active === groupKey) return { ...current, [groupKey]: !current[groupKey] };
      return current[groupKey] ? current : { ...current, [groupKey]: true };
    });
    setActive(groupKey);
  };

  const selectChild = (groupKey: GroupKey, key: ModuleKey) => {
    setOpenGroups((current) => ({ ...current, [groupKey]: true }));
    if (key === "workspace") {
      setLegacyWorkspace(false);
      setCreativeView("studio");
      setCreativeResumeTarget(null);
    }
    setActive(key);
  };

  const openAgentTarget = (key: AgentHomeTarget) => {
    const group = navGroups.find((candidate) => candidate.children.some((item) => item.key === key));
    if (group) selectChild(group.key, key);
    else setActive(key);
  };

  const applyContactSyncResult = (result: ContactSyncResult) => {
    if (result.state) {
      setContactSyncState((current) => ({ ...current, ...result.state }));
    } else if (result.error) {
      setContactSyncState((current) => ({
        ...current,
        status: "blocked",
        last_error: result.error,
        last_stage: result.blocked_reason || "blocked"
      }));
    }
    if (result.contacts) {
      setContactRows(result.contacts);
    }
    setContactSyncError(result.error ?? "");
    if (result.error) addLog("同步微信联系人", result.error);
  };

  const applyTouchTaskResult = (result: TouchTaskResult) => {
    if (result.task) {
      const unfinished = (result.task.status === "running" || result.task.status === "paused") && result.task.current_index < result.task.total;
      if (unfinished && result.task.script.trim()) setMessageDraft(result.task.script);
    }
    if (result.error) addLog("启动程序", result.error);
  };

  const callContactSync = async (action: string, run: () => Promise<ContactSyncResult>) => {
    if (contactSyncInFlight.current) return;

    if (!window.xiaoxiContactSync) {
      applyContactSyncResult({ ok: false, action, error: "当前环境未连接联系人同步执行器" });
      return;
    }

    contactSyncInFlight.current = true;
    setContactSyncBusy(true);
    try {
      applyContactSyncResult(await run());
    } catch (error) {
      const message = error instanceof Error ? error.message : "执行失败";
      applyContactSyncResult({ ok: false, action, error: message });
    } finally {
      contactSyncInFlight.current = false;
      setContactSyncBusy(false);
    }
  };

  const refreshContactSync = () => {
    void callContactSync("同步状态读取", () => window.xiaoxiContactSync!.status());
  };

  const runContactSync = () => {
    if (contactSyncInFlight.current) return;
    if (workflow.state.enabled || workflow.state.phase === "pausing") {
      setContactSyncError("请先暂停微信拓客程序，再同步联系人。");
      return;
    }

    setContactSyncState((current) => ({
      ...current,
      status: "capturing",
      last_stage: "waiting_login_window",
      last_error: ""
    }));
    setContactSyncError("");
    void callContactSync("同步微信联系人", () => window.xiaoxiContactSync!.capture());
  };

  const chooseWechatExe = () => {
    void callContactSync("选择微信程序", () => window.xiaoxiContactSync!.chooseWechatExe());
  };

  const chooseWechatRoot = () => {
    void callContactSync("选择微信数据目录", () => window.xiaoxiContactSync!.chooseWechatRoot());
  };

  const autoDetectWechatPaths = () => {
    void callContactSync("自动识别微信路径", () => window.xiaoxiContactSync!.autoDetectPaths());
  };



  useEffect(() => {
    if (sessionEntered && license?.authorized && ["agent", "workflow", "reply", "expert", "contact-sync", "touch", "moments"].includes(active)) refreshContactSync();
  }, [sessionEntered, license?.authorized, active]);

  useEffect(() => {
    if (!window.xiaoxiDeepSeekApi) return;
    void window.xiaoxiDeepSeekApi.status()
      .then((result) => setDeepSeekConfigured(Boolean(result.ok && result.data?.configured)))
      .catch(() => setDeepSeekConfigured(false));
  }, []);

  useEffect(() => {
    if (!window.xiaoxiTouchTask) return undefined;
    void window.xiaoxiTouchTask.status().then(applyTouchTaskResult).catch(() => undefined);
    return window.xiaoxiTouchTask.onUpdate(applyTouchTaskResult);
  }, []);

  useEffect(() => {
    if (!window.xiaoxiTouchTask || !contactRows.length) return;
    void window.xiaoxiTouchTask.status().then(applyTouchTaskResult).catch(() => undefined);
  }, [contactRows]);





  if (!license?.authorized || !sessionEntered) return <LoginScreen license={license} onLogin={(status) => { setLicense(status); setSessionEntered(true); }} />;
  const identity = contactSyncState.wechat_identity;
  const identityName = identity?.nickname || "未同步微信";
  const identityInitial = identityName === "未同步微信" ? "微" : (identityName.match(/[\u4e00-\u9fff]/)?.[0] || identityName.slice(0, 1)).toUpperCase();
  const activeGroup = navGroups.find(
    (group) => group.key === active || group.children.some((item) => item.key === active)
  );
  const activeRole = activeGroup?.key === active ? activeGroup.key : undefined;
  const roleThemeClass = activeGroup ? ` role-theme-${activeGroup.key}` : "";

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">玺</div>
          <div className="brand-copy">
            <span>{productBrand.displayName}</span>
          </div>
        </div>
        <nav className="nav-list">
          {navGroups.map((group) => {
            const GroupIcon = group.icon;
            const expanded = openGroups[group.key];
            const groupActive = activeGroup?.key === group.key;

            return (
              <div className="nav-group" key={group.key}>
                <button className={`nav-item ${groupActive ? "active" : ""}`} onClick={() => selectGroup(group.key)}>
                  <span className={`nav-role-avatar is-${group.key}`} aria-hidden="true"><GroupIcon size={17} strokeWidth={2.5} /></span>
                  <span className="nav-role-copy"><strong>{group.label}</strong><small>{group.persona}</small></span>
                  <span className="nav-chevron">{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
                </button>
                {expanded && (
                  <div className="sub-nav-list">
                    {group.children.map((item) => {
                      const ChildIcon = item.icon;
                      return (
                        <button
                          key={item.key}
                          className={`sub-nav-item ${active === item.key ? "active" : ""}`}
                          onClick={() => selectChild(group.key, item.key)}
                        >
                           <ChildIcon size={17} strokeWidth={2.5} />
                           <span className="sub-nav-label">{item.label}</span>
                           {!moduleIsAvailable(item.key) && <span className="nav-stage-badge">下一阶段</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-system-nav">
          <button className={`nav-item ${active === diagnosticsNavItem.key ? "active" : ""}`} onClick={() => setActive(diagnosticsNavItem.key)}>
            <diagnosticsNavItem.icon size={20} strokeWidth={2.7} />
            <span>{diagnosticsNavItem.label}</span>
          </button>
          <button className={`nav-item sidebar-api-key ${active === apiKeyNavItem.key ? "active" : ""}`} onClick={() => setActive(apiKeyNavItem.key)}>
            <apiKeyNavItem.icon size={20} strokeWidth={2.7} />
            <span>{apiKeyNavItem.label}</span>
          </button>
        </div>
      </aside>

      <section className={`workspace${roleThemeClass}`}>
        <header className="topbar">
          <div />
          <div className="top-actions account-menu-wrap">
            <button className="account-trigger" aria-haspopup="menu" aria-expanded={accountMenuOpen} onClick={() => setAccountMenuOpen((open) => !open)}>
              <span className="avatar">{identityInitial}{identity?.avatar_url && <img src={identity.avatar_url} alt="" onError={(event) => { event.currentTarget.hidden = true; }} />}</span>
              <span className="account-name">{identityName}</span>
              <ChevronDown size={15} />
            </button>
            {accountMenuOpen && <div className="account-menu" role="menu">
              <div className="account-menu-status"><span>软件授权</span><strong>{license.licenseId || "已授权"}</strong></div>
              <button role="menuitem" onClick={() => { setActive("contact-sync"); setAccountMenuOpen(false); }}><RefreshCw size={16} />重新同步微信</button>
              <button role="menuitem" onClick={() => { setSessionEntered(false); setAccountMenuOpen(false); }}><LogOut size={16} />退出登录</button>
            </div>}
          </div>
        </header>

        <div className="content-card">
          {activeRole && (
            <AgentHome
              role={activeRole}
              workflow={workflow}
              contactCount={Math.max(contactRows.length, contactSyncState.contact_count || 0)}
              onOpen={openAgentTarget}
            />
          )}
          {["workflow", "touch", "moments"].includes(active) && (
            <WechatWorkflowPage
              key={active}
              mode={active === "touch" ? "touch" : active === "moments" ? "moments" : "home"}
              workflow={workflow}
              contacts={contactRows}
              syncBusy={contactSyncBusy}
              syncError={contactSyncError || contactSyncState.last_error}
              onSync={runContactSync}
              onOpenSettings={setActive}
            />
          )}
          {active === "contact-sync" && (
            <ContactSyncPage
              contacts={contactRows}
              syncState={contactSyncState}
              syncError={contactSyncError}
              busy={contactSyncBusy}
              onRefresh={refreshContactSync}
              onSync={runContactSync}
              onChooseWechatExe={chooseWechatExe}
               onChooseWechatRoot={chooseWechatRoot}
               onAutoDetectPaths={autoDetectWechatPaths}
               locked={workflow.state.enabled || workflow.state.phase === "pausing"}
             />
          )}
          {active === "reply" && <AutoReply workflow={workflow} />}
          {active === "expert" && <AiExpert />}
          {active === "accounts" && <AccountManagement />}
          {active === "product-detail" && <ProductDetailPage />}
          {active === "materials" && <MaterialsCollectionsPage onCreate={(assetIds, collection) => {
            setBatchInitial({ assetIds, collection }); setLegacyWorkspace(false); setCreativeView("studio"); setActive("workspace");
          }} />}
          {active === "workspace" && (legacyWorkspace
            ? <CreativeWorkspacePage onBackToProduct={() => { setLegacyWorkspace(false); setCreativeView("studio"); }} />
            : creativeView === "product"
              ? <ProductOneClickPage
                initialTaskId={creativeResumeTarget?.taskId}
                initialProjectId={creativeResumeTarget?.projectId}
                onOpenLegacy={() => setLegacyWorkspace(true)}
                onBackToStudio={() => {
                  setCreativeResumeTarget(null);
                  setCreativeView("studio");
                }}
              />
              : creativeView === "history" ? <><button className="button-secondary" onClick={() => setCreativeView("studio")}>返回批量创作</button><CreativeStudioPage
                onOpenProduct={() => {
                  setCreativeResumeTarget(null);
                  setCreativeView("product");
                }}
                onContinueProduct={(taskId, projectId) => {
                  setCreativeResumeTarget({ taskId, projectId });
                  setCreativeView("product");
                }}
                onOpenLegacy={() => setLegacyWorkspace(true)}
                onOpenMaterials={() => setActive("materials")}
                onOpenFinished={() => setActive("finished")}
                onOpenDiagnostics={() => setActive("diagnostics")}
              /></> : <BatchCreativePage initial={batchInitial}
                onOpenProduct={() => { setCreativeResumeTarget(null); setCreativeView("product"); }}
                onOpenLegacy={() => setLegacyWorkspace(true)} onOpenHistory={() => setCreativeView("history")}
                onOpenMaterials={() => setActive("materials")} />)}
          {active === "finished" && <><BatchFinishedOverview onOpen={(batchId) => {
            setBatchInitial({ batchId }); setLegacyWorkspace(false); setCreativeView("studio"); setActive("workspace");
          }} /><FinishedVideoCenterPage /></>}
          {active === "api-key" && <ApiKeyPage onConfiguredChange={setDeepSeekConfigured} />}
          {active === "diagnostics" && <Diagnostics appVersion={packageInfo.version} edition={EDITION_LABEL || "正式版"} buildId={BUILD_ID} />}
          {active === "touch" && DevelopmentAcceptance && (
            <details className="workflow-details page"><summary>内部测试工具</summary><Suspense fallback={null}>
              <DevelopmentAcceptance contacts={contactRows} message={messageDraft} />
            </Suspense></details>
          )}
          {!moduleIsAvailable(active) && <Placeholder title={activeTitle} />}
        </div>

        {agentChildren.some((item) => item.key === active) && <WorkflowLauncher workflow={workflow} />}
      </section>
    </main>
  );
}

function ContactSyncPage({
  contacts,
  syncState,
  syncError,
  busy,
  onRefresh,
  onSync,
  onChooseWechatExe,
  onChooseWechatRoot,
  onAutoDetectPaths,
  locked
}: {
  contacts: ContactRow[];
  syncState: ContactSyncState;
  syncError: string;
  busy: boolean;
  onRefresh: () => void;
  onSync: () => void;
  onChooseWechatExe: () => void;
  onChooseWechatRoot: () => void;
  onAutoDetectPaths: () => void;
  locked: boolean;
}) {
  const statusLabel =
    syncState.status === "synced" ? "已同步" : syncState.status === "blocked" ? "同步失败" : syncState.status === "capturing" ? "同步中" : "待同步";
  const lastSynced = syncState.last_synced_at ? new Date(syncState.last_synced_at).toLocaleString("zh-CN", { hour12: false }) : "暂无";
  const error = syncError || syncState.last_error;

  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(contacts.length / CONTACT_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * CONTACT_PAGE_SIZE;
  const visibleContacts = contacts.slice(pageStart, pageStart + CONTACT_PAGE_SIZE);
  useEffect(() => setPage((current) => Math.min(current, pageCount)), [pageCount]);

  return (
    <section className="page agent-page">
      <div className="page-head">
        <div>
          <h1>同步微信联系人</h1>
          <p>同步后即可选择触达客户。首次同步会重启微信，请按提示重新登录。</p>
        </div>
        <div className="actions">
          <button className="secondary-button" onClick={onRefresh} disabled={busy}>
            <RefreshCw size={17} />
            刷新状态
          </button>
          <button className="primary-button" onClick={onSync} disabled={busy || locked}>
            <UsersRound size={17} />
            {busy ? "同步中" : "同步当前微信联系人"}
          </button>
        </div>
      </div>

      <div className="workflow-sync-summary">
        <span>账号<strong>{syncState.account_name || "未识别"}</strong></span>
        <span>通讯录<strong>{contacts.length || syncState.contact_count} 人</strong></span>
        <span>最近同步<strong>{lastSynced}</strong></span>
        <span>状态<strong>{statusLabel}</strong></span>
      </div>
      <p className="wechat-account-note">同步账号标识来自本机微信数据目录，不是公开微信号；切换登录微信后请重新同步。</p>
      {syncState.account_changed && <div className="touch-notice">检测到微信账号已切换。当前头像、昵称和微信任务已按新账号隔离，请确认后再启动任务。</div>}
      {locked && <div className="touch-notice">请先暂停微信拓客程序，再同步联系人。</div>}
      <details className="workflow-sync-details"><summary>连接设置与路径排查</summary>
      <div className="wechat-path-panel">
        <div className="wechat-path-row">
          <div>
            <strong>微信程序位置</strong>
            <span title={syncState.wechat_exe_path}>{syncState.wechat_exe_path || "未识别，请手动选择 Weixin.exe"}</span>
          </div>
          <button className="secondary-button" onClick={onChooseWechatExe} disabled={busy || locked}>
            <Folder size={16} />
            选择程序
          </button>
        </div>
        <div className="wechat-path-row">
          <div>
            <strong>微信数据目录</strong>
            <span title={syncState.wechat_root}>{syncState.wechat_root || "未识别，请手动选择 xwechat_files"}</span>
          </div>
          <button className="secondary-button" onClick={onChooseWechatRoot} disabled={busy || locked}>
            <Folder size={16} />
            选择目录
          </button>
        </div>
        <button className="wechat-auto-detect" onClick={onAutoDetectPaths} disabled={busy || locked}>恢复自动识别</button>
      </div>
      </details>
      {error && <div className="touch-notice">{error}</div>}

      <div className="table-panel contact-table-scroll">
        <div className="panel-title">联系人预览</div>
        <table>
          <thead>
            <tr>
              <th>称呼</th>
              <th>备注</th>
              <th>昵称</th>
              <th>联系人公开微信号</th>
              <th>来源</th>
            </tr>
          </thead>
          <tbody>
            {contacts.length ? (
              visibleContacts.map((contact) => (
                <tr key={contact.id}>
                  <td>{contactName(contact)}</td>
                  <td>{contact.remark}</td>
                  <td>{contact.nickname}</td>
                  <td>{contact.wechatId}</td>
                  <td>微信通讯录</td>
                </tr>
              ))
            ) : (
              <EmptyTableRow colSpan={5} message="暂无同步联系人" />
            )}
          </tbody>
        </table>
        {contacts.length > CONTACT_PAGE_SIZE && (
          <div className="contact-pagination">
            <span>{`\u7b2c ${safePage}/${pageCount} \u9875 \u00b7 \u5171 ${contacts.length} \u4eba`}</span>
            <div>
              <button className="secondary-button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={safePage <= 1}>{"\u4e0a\u4e00\u9875"}</button>
              <button className="secondary-button" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={safePage >= pageCount}>{"\u4e0b\u4e00\u9875"}</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function AccountManagement() {
  const platforms = ["抖音", "小红书", "快手", "视频号"];

  return (
    <section className="page account-page">
      <div className="page-head">
        <div>
          <h1>学员与账号</h1>
          <p>只记录平台、账号标识、城市和授权状态；不保存密码、验证码、Cookie 或设备登录态。</p>
        </div>
      </div>
      <div className="channel-account-grid">
        {platforms.map((platform) => (
          <article className="channel-account-card" key={platform}>
            <div className="channel-account-icon"><UserRound size={22} /></div>
            <div>
              <strong>{platform}</strong>
              <p>账号授权与发布能力</p>
            </div>
            <span>下一阶段</span>
          </article>
        ))}
      </div>
    </section>
  );
}


function ApiKeyPage({ onConfiguredChange }: { onConfiguredChange: (configured: boolean) => void }) {
  return (
    <section className="page api-key-page">
      <div className="page-head">
        <div>
          <h1>API密钥</h1>
          <p>配置 AI 服务所需的 API Key，密钥仅在当前 Windows 用户下加密保存。</p>
        </div>
      </div>
      <div className="api-settings-grid">
        <DeepSeekApiSettings onConfiguredChange={onConfiguredChange} />
        <ApiMartSettings />
      </div>
    </section>
  );
}

function DeepSeekApiSettings({
  onConfiguredChange
}: {
  onConfiguredChange?: (configured: boolean) => void;
} = {}) {
  const [apiKey, setApiKey] = useState("");
  const [maskedKey, setMaskedKey] = useState("");
  const [status, setStatus] = useState("正在读取已保存的设置…");
  const [statusTone, setStatusTone] = useState<"neutral" | "success" | "error">("neutral");
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    if (!window.xiaoxiDeepSeekApi) {
      setStatusTone("error");
      onConfiguredChange?.(false);
      return setStatus("当前环境未连接 DeepSeek 设置。");
    }
    void window.xiaoxiDeepSeekApi.status().then((result) => {
      const configured = Boolean(result.ok && result.data?.configured);
      setMaskedKey(configured ? result.data?.maskedKey || "" : "");
      onConfiguredChange?.(configured);
      const statusError = result.data?.error || result.error;
      setStatusTone(statusError ? "error" : "neutral");
      setStatus(configured ? "已保存，可测试连接。" : statusError || "尚未保存 API Key。");
    }).catch(() => {
      setStatusTone("error");
      onConfiguredChange?.(false);
      setStatus("读取 DeepSeek 设置失败。");
    });
  };
  useEffect(refresh, []);

  const run = (operation: () => Promise<DeepSeekApiResult>, success: string, clearInput = false) => {
    setBusy(true);
    void operation().then((result) => {
      if (typeof result.data?.configured === "boolean") {
        const configured = result.data.configured;
        setMaskedKey(configured ? result.data.maskedKey || "" : "");
        onConfiguredChange?.(configured);
      }
      if (!result.ok) {
        setStatusTone("error");
        return setStatus(result.error || "操作失败，请稍后重试。");
      }
      if (clearInput) setApiKey("");
      setStatusTone("success");
      setStatus(success);
    }).catch(() => {
      setStatusTone("error");
      setStatus("操作失败，请稍后重试。");
    }).finally(() => setBusy(false));
  };

  const saveAndTest = async (): Promise<DeepSeekApiResult> => {
    const value = apiKey.trim();
    if (!value) return window.xiaoxiDeepSeekApi!.test();
    const tested = await window.xiaoxiDeepSeekApi!.test({ apiKey: value });
    if (!tested.ok) return tested;
    return window.xiaoxiDeepSeekApi!.save({ apiKey: value });
  };

  return (
    <div className="table-panel deepseek-settings">
      <div className="deepseek-settings-head">
        <div>
          <div className="deepseek-title">DeepSeek API</div>
          <p>用于产品资料分析、脚本和模块文案，也供现有自动回复等功能使用。</p>
        </div>
        <div className="deepseek-head-actions">
          <span className={`deepseek-config-state ${maskedKey ? "is-configured" : ""}`}>
            <span className="deepseek-state-dot" />
            {maskedKey ? "已配置" : "未配置"}
          </span>
        </div>
      </div>
      <div className="deepseek-settings-body">
        <label className="field deepseek-key-field">
          <span>{maskedKey ? `当前 Key：${maskedKey}` : "DeepSeek API Key"}</span>
          <div className="deepseek-key-row">
            <input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={maskedKey ? "填写新 Key 以替换" : "请输入您的 DeepSeek API Key"} />
            <button className="primary-button" onClick={() => run(() => window.xiaoxiDeepSeekApi!.save({ apiKey }), "已安全保存，请测试连接确认可用。", true)} disabled={busy || !apiKey.trim()}>
              <Save size={16} />
              保存{maskedKey ? "并替换" : ""}
            </button>
          </div>
        </label>
        <div className="deepseek-settings-footer">
          <div className={`deepseek-status is-${statusTone}`} aria-live="polite">{status}</div>
          <div className="actions deepseek-actions">
            <button className="secondary-button" onClick={() => run(saveAndTest, apiKey.trim() ? "DeepSeek 生产文案预检正常，当前 Key 已保存。" : "DeepSeek 生产文案预检正常。", Boolean(apiKey.trim()))} disabled={busy || (!apiKey.trim() && !maskedKey)}>
              <RefreshCw size={16} />
              测试连接
            </button>
            <button className="danger-button" onClick={() => run(() => window.xiaoxiDeepSeekApi!.remove(), "已删除 DeepSeek API Key，AI 文案调用已停止。", true)} disabled={busy || !maskedKey}>
              <Trash2 size={16} />
              删除
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const APIMART_BASE_URL = "https://api.apimart.ai/v1";
const APIMART_MODEL = "gpt-image-2";

function ApiMartSettings() {
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [baseUrl, setBaseUrl] = useState(APIMART_BASE_URL);
  const [model, setModel] = useState(APIMART_MODEL);
  const [status, setStatus] = useState("正在读取已保存的设置…");
  const [statusTone, setStatusTone] = useState<"neutral" | "success" | "error">("neutral");
  const [busy, setBusy] = useState(false);

  const applyConfiguration = (result: ProductDetailAiSettingsResult) => {
    if (result.data?.baseUrl) setBaseUrl(result.data.baseUrl);
    if (result.data?.model) setModel(result.data.model);
    if (typeof result.data?.configured === "boolean") {
      setConfigured(result.data.configured);
    }
  };

  const refresh = () => {
    const api = window.xiaoxiProductDetailAiSettings;
    if (!api) {
      setStatusTone("error");
      return setStatus("当前环境未连接产品详情图 AI 设置。");
    }
    void api.status().then((result) => {
      applyConfiguration(result);
      const statusError = result.data?.error || result.error;
      if (statusError) {
        setStatusTone("error");
        return setStatus(statusError);
      }
      if (result.data?.secureStorageAvailable === false) {
        setStatusTone("error");
        return setStatus("当前 Windows 用户无法使用加密存储，请检查系统后重试。");
      }
      if (result.data?.ready) {
        setStatusTone("success");
        return setStatus("已保存并启用，产品详情图 AI 精修可以读取此配置。");
      }
      setStatusTone("neutral");
      return setStatus("尚未保存 APIMart API Key。");
    }).catch(() => {
      setStatusTone("error");
      setStatus("读取 APIMart 设置失败。");
    });
  };
  useEffect(refresh, []);

  const run = (
    operation: () => Promise<ProductDetailAiSettingsResult>,
    success: string,
    options: { clearInput?: boolean; updateConfiguration?: boolean } = {}
  ) => {
    setBusy(true);
    void operation().then((result) => {
      if (options.updateConfiguration !== false) applyConfiguration(result);
      if (!result.ok) {
        setStatusTone("error");
        return setStatus(result.error || "操作失败，请稍后重试。");
      }
      if (options.clearInput) setApiKey("");
      setStatusTone("success");
      setStatus(success);
    }).catch(() => {
      setStatusTone("error");
      setStatus("操作失败，请稍后重试。");
    }).finally(() => setBusy(false));
  };

  const validateAndSave = async (): Promise<ProductDetailAiSettingsResult> => {
    const api = window.xiaoxiProductDetailAiSettings!;
    const value = apiKey.trim();
    const checked = await api.validate({ apiKey: value });
    if (!checked.ok) return checked;
    if (checked.data?.paidCallPerformed !== false) {
      return { ok: false, error: "配置检查结果异常，已取消保存。" };
    }
    return api.save({ apiKey: value });
  };

  const validateOnly = () => {
    const api = window.xiaoxiProductDetailAiSettings!;
    const value = apiKey.trim();
    return value ? api.validate({ apiKey: value }) : api.validate();
  };

  return (
    <div className="table-panel deepseek-settings provider-settings-card">
      <div className="deepseek-settings-head">
        <div>
          <div className="deepseek-title">APIMart 生图 API</div>
          <p>用于产品详情图的 AI 精修；API 地址和模型已内置，您只需要填写 Key。</p>
        </div>
        <div className="deepseek-head-actions">
          <span className={`deepseek-config-state ${configured ? "is-configured" : ""}`}>
            <span className="deepseek-state-dot" />
            {configured ? "已配置" : "未配置"}
          </span>
        </div>
      </div>
      <div className="deepseek-settings-body">
        <div className="provider-readonly-grid" aria-label="APIMart 固定配置">
          <div><span>API 地址</span><strong>{baseUrl}</strong></div>
          <div><span>生图模型</span><strong>{model}</strong></div>
        </div>
        <label className="field deepseek-key-field">
          <span>{configured ? "APIMart API Key（已安全保存）" : "APIMart API Key"}</span>
          <div className="deepseek-key-row">
            <input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={configured ? "填写新 Key 以替换" : "请输入您的 APIMart API Key"} />
            <button className="primary-button" onClick={() => run(validateAndSave, "已安全保存并启用。配置检查未联网、未产生费用。", { clearInput: true })} disabled={busy || !apiKey.trim()}>
              <Save size={16} />
              保存并启用
            </button>
          </div>
        </label>
        <div className="provider-cost-note">“检查配置”只检查本地格式和加密存储，不连接 APIMart，也不会生成图片或产生费用。</div>
        <div className="deepseek-settings-footer">
          <div className={`deepseek-status is-${statusTone}`} aria-live="polite">{status}</div>
          <div className="actions deepseek-actions">
            <button className="secondary-button" onClick={() => run(validateOnly, "配置检查通过：未联网、未产生费用。", { updateConfiguration: false })} disabled={busy || (!apiKey.trim() && !configured)}>
              <RefreshCw size={16} />
              检查配置
            </button>
            <button className="danger-button" onClick={() => run(() => window.xiaoxiProductDetailAiSettings!.delete(), "已删除 APIMart API Key，AI 精修已关闭。", { clearInput: true })} disabled={busy || !configured}>
              <Trash2 size={16} />
              删除
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


function FloatingTouchWindow() {
  const [touchTask, setTouchTask] = useState<TouchTaskState>(() => emptyTouchTask());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const applyResult = (result: TouchTaskResult) => {
    if (result.task) setTouchTask((current) => mergeTouchTaskState(current, result.task!));
    setError(result.error ?? "");
  };

  const callTask = (run: () => Promise<TouchTaskResult>) => {
    if (busy) return;
    if (!window.xiaoxiTouchTask) {
      setError("当前环境未连接任务执行器");
      return;
    }

    setBusy(true);
    void run()
      .then(applyResult)
      .catch((err) => setError(err instanceof Error ? err.message : "执行失败"))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    if (!window.xiaoxiTouchTask) {
      setError("当前环境未连接任务执行器");
      return undefined;
    }
    void window.xiaoxiTouchTask.status().then(applyResult).catch(() => setError("读取任务状态失败"));
    return window.xiaoxiTouchTask.onUpdate(applyResult);
  }, []);

  const progressTotal = touchTask.total || touchTask.results.length;
  const processedCount = Math.max(touchTask.current_index, touchTask.results.filter((result) => processedTouchResult(result.status)).length);
  const progressValue = progressTotal ? Math.min(100, Math.round((processedCount / progressTotal) * 100)) : 0;
  const currentName = touchTask.current_contact ? contactName(touchTask.current_contact) : "暂无";
  const nextName = touchTask.next_contact ? contactName(touchTask.next_contact) : "暂无";
  const currentResult = touchTask.current_result;
  const statusText = currentResult?.reason || touchTask.pause_reason || touchTaskStatusLabel(touchTask);
  const unknownResult = touchTask.phase === "awaiting_unknown_resolution" && currentResult?.status === "outcome_unknown" && currentResult.awaiting_resolution
    ? currentResult
    : null;
  const endTask = () => {
    if (!window.confirm("确定结束本次任务吗？结束后不能恢复当前进度。")) return;
    callTask(() => window.xiaoxiTouchTask!.stop());
  };

  return (
    <main className="floating-shell">
      <header className="floating-head">
        <div className="floating-title">
          <span className={`floating-pulse ${touchTask.status}`} />
          <strong>触达进度</strong>
        </div>
        <button className="floating-close" aria-label="返回主页面" onClick={() => callTask(() => window.xiaoxiTouchTask!.closeFloating())} disabled={busy}>
          <X size={16} />
        </button>
      </header>

      <div className="floating-progress">
        <div className="floating-progress-bar">
          <span style={{ width: `${progressValue}%` }} />
        </div>
        <b>
          {processedCount}/{progressTotal || 0}
        </b>
      </div>

      <div className="floating-info">
        <div className="floating-row">
          <span>当前联系人</span>
          <strong>{currentName}</strong>
        </div>
        <div className="floating-row">
          <span>下一位</span>
          <strong>{nextName}</strong>
        </div>
        <div className="floating-state">
          <span>{touchTaskStatusLabel(touchTask)}</span>
          <strong>{currentResult ? `${taskResultLabel(currentResult.status)}${currentResult.ai_status === "fallback" ? " · 固定话术" : ""}` : statusText}</strong>
        </div>
      </div>

      {(touchTask.pause_reason || error) && <div className="floating-alert">{error || touchTask.pause_reason}</div>}
      {unknownResult && (
        <div className="floating-resolution">
          <button onClick={() => callTask(() => window.xiaoxiTouchTask!.resolveUnknown({ taskId: touchTask.id, contactId: unknownResult.contact.id, resolution: "sent" }))} disabled={busy}>视为已发送</button>
          <button onClick={() => callTask(() => window.xiaoxiTouchTask!.resolveUnknown({ taskId: touchTask.id, contactId: unknownResult.contact.id, resolution: "skip" }))} disabled={busy}>跳过此人</button>
        </div>
      )}

      <div className="floating-actions">
        {touchTask.status === "running" ? (
          <button onClick={() => callTask(() => window.xiaoxiTouchTask!.pause())} disabled={busy}>
            <Pause size={15} />
            暂停
          </button>
        ) : (
          <button data-xiaoxi-batch-authorize={REAL_SEND_EDITION ? "continue" : undefined} onClick={() => callTask(() => window.xiaoxiTouchTask!.resume())} disabled={busy || touchTask.status !== "paused" || Boolean(unknownResult)}>
            <Play size={15} />
            继续任务
          </button>
        )}
        <button onClick={endTask} disabled={busy || touchTask.status === "stopped" || touchTask.status === "completed"}>
          <Square size={14} />
          结束
        </button>
        <button onClick={() => callTask(() => window.xiaoxiTouchTask!.closeFloating())} disabled={busy}>主页面</button>
      </div>
    </main>
  );
}


function EmptyTableRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <tr>
      <td className="empty-cell" colSpan={colSpan}>
        {message}
      </td>
    </tr>
  );
}

function Placeholder({ title }: { title: string }) {
  return (
    <section className="placeholder">
      <Bot size={36} />
      <h1>{title}</h1>
      <span className="placeholder-stage">下一阶段开放</span>
      <p>当前阶段可先使用同步联系人和主动触达。</p>
    </section>
  );
}
