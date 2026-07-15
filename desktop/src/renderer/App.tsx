import {
  BarChart3,
  BookOpen,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clapperboard,
  Folder,
  Lock,
  MessageCircle,
  MonitorPlay,
  Pause,
  Play,
  RefreshCw,
  Save,
  Scissors,
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
import { lazy, Suspense, type ComponentType, type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { AiExpert } from "./AiExpert";
import { AutoReply } from "./AutoReply";

type ModuleKey =
  | "agent"
  | "reply"
  | "expert"
  | "contact-sync"
  | "touch"
  | "moments"
  | "production"
  | "operations"
  | "accounts"
  | "materials"
  | "script"
  | "cut"
  | "ai-video"
  | "publish"
  | "leads"
  | "data"
  | "api-key";

type GroupKey = "agent" | "production" | "operations";
type NavItem = { key: ModuleKey; label: string; icon: ComponentType<{ size?: number; strokeWidth?: number }> };
type NavGroup = NavItem & { key: GroupKey; children: NavItem[] };
type UserProfile = { name: string; avatar: string };
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
};
type ActiveTouchResult = {
  ok: boolean;
  action: string;
  state?: Partial<ActiveTouchState>;
  contacts?: ContactRow[];
  logs?: RunLog[];
  error?: string;
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
  results: TouchTaskItem[];
};
type TouchTaskResult = {
  ok: boolean;
  task?: TouchTaskState;
  preview?: TouchTaskPreview;
  error?: string;
};
type DeepSeekApiResult = { ok: boolean; data?: { configured?: boolean; maskedKey?: string }; error?: string };

declare global {
  interface Window {
    xiaoxiActiveTouch?: {
      status: () => Promise<ActiveTouchResult>;
      calibrate: () => Promise<ActiveTouchResult>;
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
  }
}

const USER_STORAGE_KEY = "xiaoxi-user-profile";
const DEFAULT_USER_PROFILE: UserProfile = { name: "2829347524", avatar: "2" };
const DEFAULT_TOUCH_MESSAGE = "{称呼}，您好，我们这边有清洁设备短租和会员特惠方案，想了解一下您近期是否需要降本增效？";
const XIAOXI_EDITION = import.meta.env.VITE_XIAOXI_EDITION;
const DEVELOPMENT_EDITION = XIAOXI_EDITION === "development";
const PILOT_EDITION = XIAOXI_EDITION === "pilot";
const REAL_SEND_EDITION = DEVELOPMENT_EDITION || PILOT_EDITION;
const DEFAULT_ACTIVE_MODULE: ModuleKey = PILOT_EDITION ? "touch" : "reply";
const EDITION_LABEL = DEVELOPMENT_EDITION ? "测试版" : "";
const DevelopmentAcceptance = DEVELOPMENT_EDITION ? lazy(() => import("./DevelopmentAcceptance")) : null;

const agentChildren: NavItem[] = [
  { key: "reply", label: "自动回复", icon: MessageCircle },
  { key: "expert", label: "AI专家", icon: Bot },
  { key: "contact-sync", label: "同步联系人", icon: UsersRound },
  { key: "touch", label: "主动触达", icon: Send },
  { key: "moments", label: "朋友圈运营", icon: ThumbsUp }
];

const productionChildren: NavItem[] = [
  { key: "materials", label: "素材仓库", icon: Folder },
  { key: "script", label: "AI脚本工厂", icon: BookOpen },
  { key: "cut", label: "自动剪辑工厂", icon: Scissors },
  { key: "ai-video", label: "AI生成视频", icon: MonitorPlay }
];

const operationsChildren: NavItem[] = [
  { key: "accounts", label: "账号管理", icon: UserRound },
  { key: "publish", label: "发布工作台", icon: Clapperboard },
  { key: "leads", label: "线索回流", icon: RefreshCw },
  { key: "data", label: "数据复盘", icon: BarChart3 }
];

const navGroups: NavGroup[] = [
  { key: "agent", label: "个微Agent", icon: UsersRound, children: agentChildren },
  { key: "production", label: "内容生产", icon: Video, children: productionChildren },
  { key: "operations", label: "渠道运营", icon: BarChart3, children: operationsChildren }
];

const apiKeyNavItem: NavItem = { key: "api-key", label: "API密钥", icon: Lock };
const navItems = [...navGroups.flatMap((group) => [group, ...group.children]), apiKeyNavItem];

function nowTime() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function avatarFromName(name: string) {
  if (name.includes("梁")) return "梁";
  const chinese = name.match(/[\u4e00-\u9fff]/);
  return (chinese?.[0] ?? name.trim().slice(0, 1) ?? "用").toUpperCase();
}

function readStoredUser() {
  try {
    const raw = window.localStorage.getItem(USER_STORAGE_KEY);
    if (!raw) return DEFAULT_USER_PROFILE;
    const value = JSON.parse(raw) as Partial<UserProfile>;
    if (!value.name || !value.avatar) return DEFAULT_USER_PROFILE;
    return { name: value.name, avatar: value.avatar };
  } catch {
    return DEFAULT_USER_PROFILE;
  }
}

function storeUser(user: UserProfile) {
  try {
    window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
  } catch {
    // ponytail: local login still works without persistence if storage is unavailable.
  }
}

function contactName(contact: ContactRow | null) {
  if (!contact) return "";
  return contact.remark?.trim() || contact.nickname?.trim() || contact.name || contact.wechatId || "";
}

function fillTouchTemplate(template: string, contact: ContactRow | null) {
  const name = contactName(contact) || "客户";
  return template.replace(/\{称呼\}/g, name);
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

function taskHasUnfinishedSnapshot(task: TouchTaskState) {
  return Boolean(task.id) && !["idle", "completed", "stopped"].includes(task.status) && task.current_index < task.total;
}

function moduleIsAvailable(key: ModuleKey) {
  return ["reply", "expert", "contact-sync", "touch", "moments", "accounts", "api-key"].includes(key);
}

function touchTaskStatusLabel(task: TouchTaskState) {
  if (["idle", "completed", "stopped"].includes(task.status)) return taskStatusLabel(task.status);
  if (task.status === "paused" && task.phase !== "awaiting_unknown_resolution") return taskStatusLabel(task.status);
  const phaseLabels: Record<string, string> = {
    preparing_batch: "准备触达文案",
    sending_batch: "发送中",
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
  const isFloatingWindow = new URLSearchParams(window.location.search).get("floating") === "1";
  if (isFloatingWindow) return <FloatingTouchWindow />;

  const [user, setUser] = useState<UserProfile | null>(() => readStoredUser());
  const [active, setActive] = useState<ModuleKey>(DEFAULT_ACTIVE_MODULE);
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
  const [touchTask, setTouchTask] = useState<TouchTaskState>(() => emptyTouchTask());
  const [touchTaskPreview, setTouchTaskPreview] = useState<TouchTaskPreview | null>(null);
  const [touchTaskError, setTouchTaskError] = useState("");
  const [touchTaskBusy, setTouchTaskBusy] = useState(false);
  const [messageDraft, setMessageDraft] = useState(DEFAULT_TOUCH_MESSAGE);
  const [excludedContactIds, setExcludedContactIds] = useState<string[]>([]);
  const [deepSeekConfigured, setDeepSeekConfigured] = useState(false);
  const addLog = (_action: string, _result: string) => undefined;

  useEffect(() => {
    setMessageDraft((current) => current || DEFAULT_TOUCH_MESSAGE);
  }, []);

  useEffect(() => {
    document.title = ["小玺AI员工", EDITION_LABEL].filter(Boolean).join(" ");
  }, []);

  const activeTitle = useMemo(() => navItems.find((item) => item.key === active)?.label ?? "自动回复", [active]);

  const login = (account: string) => {
    const name = account.trim();
    const profile = { name, avatar: avatarFromName(name) };
    storeUser(profile);
    setUser(profile);
  };

  const selectGroup = (groupKey: GroupKey) => {
    setOpenGroups((current) => ({ ...current, [groupKey]: !current[groupKey] }));
    setActive(navGroups.find((group) => group.key === groupKey)?.children[0]?.key ?? DEFAULT_ACTIVE_MODULE);
  };

  const selectChild = (groupKey: GroupKey, key: ModuleKey) => {
    setOpenGroups((current) => ({ ...current, [groupKey]: true }));
    setActive(key);
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
      const currentIds = new Set(result.contacts.map((contact) => contact.id));
      setExcludedContactIds((current) => current.filter((id) => currentIds.has(id)));
    }
    setContactSyncError(result.error ?? "");
    if (result.error) addLog("同步微信联系人", result.error);
  };

  const applyTouchTaskResult = (result: TouchTaskResult) => {
    if (result.preview) setTouchTaskPreview(result.preview);
    if (result.task) {
      setTouchTask(result.task);
      const unfinished = (result.task.status === "running" || result.task.status === "paused") && result.task.current_index < result.task.total;
      if (unfinished && result.task.script.trim()) setMessageDraft(result.task.script);
    }
    setTouchTaskError(result.error ?? "");
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
    if (taskHasUnfinishedSnapshot(touchTask)) {
      setContactSyncError("当前任务名单已经冻结，请完成或结束本次任务后再同步。");
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

  const startTouchTask = () => {
    if (touchTaskBusy || touchTask.status === "running") return;

    if (active !== "touch") {
      setActive("touch");
      addLog("启动程序", "请先在主动触达页填写话术");
      return;
    }

    if (!window.xiaoxiTouchTask) {
      setTouchTaskError("当前环境未连接任务执行器");
      addLog("启动程序", "当前环境未连接任务执行器");
      return;
    }

    const resumingTask = touchTask.status === "paused" && taskHasUnfinishedSnapshot(touchTask);

    if (!resumingTask) {
      const excludedIds = new Set(excludedContactIds);
      const eligibleContacts = REAL_SEND_EDITION && touchTaskPreview ? touchTaskPreview.eligible : contactRows.filter((contact) => contact.allowed);
      const eligibleContactCount = eligibleContacts.filter((contact) => !excludedIds.has(contact.id)).length;
      if (!eligibleContactCount) {
        const message = contactRows.length ? "本次没有可触达联系人，请恢复至少一位联系人" : "请先同步当前微信联系人";
        setTouchTaskError(message);
        addLog("启动程序", message);
        return;
      }

      if (!messageDraft.trim()) {
        setTouchTaskError("请先填写触达话术");
        addLog("启动程序", "请先填写触达话术");
        return;
      }

      if (!deepSeekConfigured) {
        setTouchTaskError("请先配置并保存 DeepSeek API Key");
        return;
      }
    }

    setTouchTaskError("");
    setTouchTaskBusy(true);
    const action = resumingTask ? "继续上次任务" : "启动程序";
    const request = resumingTask
      ? window.xiaoxiTouchTask.resume()
      : window.xiaoxiTouchTask.start({ script: messageDraft, excludedContactIds });
    void request
      .then(applyTouchTaskResult)
      .catch((error) => {
        const message = error instanceof Error ? error.message : "启动失败";
        setTouchTaskError(message);
        addLog(action, message);
      })
      .finally(() => setTouchTaskBusy(false));
  };

  const updateMessageDraft = (message: string) => {
    setMessageDraft(message);
  };

  useEffect(() => {
    if (user && (active === "reply" || active === "contact-sync" || active === "touch")) refreshContactSync();
  }, [user, active]);

  useEffect(() => {
    if (user) storeUser(user);
  }, [user]);

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

  useEffect(() => {
    if (touchTask.id && ["completed", "stopped"].includes(touchTask.status)) setExcludedContactIds([]);
  }, [touchTask.id, touchTask.status]);

  const resolveUnknown = (contactId: string, resolution: "sent" | "skip") => {
    if (touchTaskBusy || !window.xiaoxiTouchTask || !touchTask.id) return;
    setTouchTaskBusy(true);
    setTouchTaskError("");
    void window.xiaoxiTouchTask.resolveUnknown({ taskId: touchTask.id, contactId, resolution })
      .then(applyTouchTaskResult)
      .catch((error) => setTouchTaskError(error instanceof Error ? error.message : "处理发送结果失败"))
      .finally(() => setTouchTaskBusy(false));
  };

  const endTouchTask = () => {
    if (touchTaskBusy || !window.xiaoxiTouchTask || !touchTask.id) return;
    if (!window.confirm("确定结束本次任务吗？结束后不能恢复当前进度。")) return;
    setTouchTaskBusy(true);
    setTouchTaskError("");
    void window.xiaoxiTouchTask.stop()
      .then(applyTouchTaskResult)
      .catch((error) => setTouchTaskError(error instanceof Error ? error.message : "结束任务失败"))
      .finally(() => setTouchTaskBusy(false));
  };

  const excludedIdSet = new Set(excludedContactIds);
  const launchContacts = REAL_SEND_EDITION && touchTaskPreview ? touchTaskPreview.eligible : contactRows.filter((contact) => contact.allowed);
  const launchContactCount = launchContacts.filter((contact) => !excludedIdSet.has(contact.id)).length;
  const resumingTask = touchTask.status === "paused" && taskHasUnfinishedSnapshot(touchTask);
  const requiresUnknownResolution = resumingTask && touchTask.phase === "awaiting_unknown_resolution";
  const touchTaskLocked = taskHasUnfinishedSnapshot(touchTask);
  const canLaunchTouch = active === "touch" && !touchTaskBusy && touchTask.status !== "running" && !requiresUnknownResolution && (resumingTask || (launchContactCount > 0 && Boolean(messageDraft.trim()) && deepSeekConfigured));
  const launchTitle =
    active !== "touch"
      ? "请先进入主动触达"
      : requiresUnknownResolution
        ? "请先确认当前联系人的发送结果"
      : resumingTask
        ? "继续上次未完成的任务"
      : launchContactCount === 0
        ? contactRows.length ? "请恢复至少一位本次触达联系人" : "请先同步当前微信联系人"
        : !messageDraft.trim()
          ? "请先填写触达话术"
          : !deepSeekConfigured
            ? "请先配置 DeepSeek API Key"
          : touchTaskBusy
            ? "正在启动主动触达任务"
            : touchTask.status === "running"
              ? "主动触达任务正在执行"
              : "启动主动触达任务";

  if (!user && !PILOT_EDITION) return <LoginScreen onLogin={login} />;
  const currentUser = user ?? DEFAULT_USER_PROFILE;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">玺</div>
          <span>小玺AI员工{EDITION_LABEL ? ` · ${EDITION_LABEL}` : ""}</span>
        </div>
        <nav className="nav-list">
          {navGroups.map((group) => {
            const GroupIcon = group.icon;
            const expanded = openGroups[group.key];
            const groupActive = active === group.key || group.children.some((item) => item.key === active);

            return (
              <div className="nav-group" key={group.key}>
                <button className={`nav-item ${groupActive ? "active" : ""}`} onClick={() => selectGroup(group.key)}>
                  <GroupIcon size={20} strokeWidth={2.7} />
                  <span>{group.label}</span>
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
        <button className={`nav-item sidebar-api-key ${active === apiKeyNavItem.key ? "active" : ""}`} onClick={() => setActive(apiKeyNavItem.key)}>
          <apiKeyNavItem.icon size={20} strokeWidth={2.7} />
          <span>{apiKeyNavItem.label}</span>
        </button>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div />
          <div className="top-actions">
            <button className="guide">
              <CircleHelp size={14} />
              新手引导
            </button>
            <div className="avatar">{currentUser.avatar}</div>
            <button className="account-name">{currentUser.name}</button>
          </div>
        </header>

        <div className="content-card">
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
               locked={touchTaskLocked}
             />
          )}
          {active === "reply" && <AutoReply />}
          {active === "expert" && <AiExpert />}
          {active === "moments" && <MomentsOperations />}
          {active === "accounts" && <AccountManagement />}
          {active === "api-key" && <ApiKeyPage onConfiguredChange={setDeepSeekConfigured} />}
          {active === "touch" && (
            <ActiveTouch
              contacts={contactRows}
              messageDraft={messageDraft}
              touchTask={touchTask}
              touchTaskPreview={touchTaskPreview}
               touchTaskError={touchTaskError}
               contactSyncState={contactSyncState}
               contactSyncError={contactSyncError}
               contactSyncBusy={contactSyncBusy}
               excludedContactIds={excludedContactIds}
               locked={touchTaskLocked}
               onMessageDraftChange={updateMessageDraft}
               onSync={runContactSync}
               onOpenSync={() => setActive("contact-sync")}
               onExclude={(contactId) => setExcludedContactIds((current) => current.includes(contactId) ? current : [...current, contactId])}
               onRestore={(contactId) => setExcludedContactIds((current) => current.filter((id) => id !== contactId))}
               onResolveUnknown={resolveUnknown}
               onEndTask={endTouchTask}
             />
          )}
          {active === "touch" && DevelopmentAcceptance && (
            <Suspense fallback={null}>
              <DevelopmentAcceptance contacts={contactRows} message={messageDraft} />
            </Suspense>
          )}
          {!moduleIsAvailable(active) && <Placeholder title={activeTitle} />}
        </div>

        {active === "touch" && <button data-xiaoxi-batch-authorize={REAL_SEND_EDITION ? (resumingTask ? "continue" : "start") : undefined} className={`launch-button ${canLaunchTouch ? "" : "disabled"}`} onClick={startTouchTask} disabled={!canLaunchTouch} title={launchTitle}>
          {touchTaskBusy ? "处理中" : resumingTask ? <><span>继续</span><br /><span>任务</span></> : <><span>启动</span><br /><span>程序</span></>}
        </button>}
      </section>
    </main>
  );
}

function LoginScreen({ onLogin }: { onLogin: (account: string) => void }) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!account.trim() || !password.trim()) {
      setError("请输入账号和密码");
      return;
    }

    setError("");
    onLogin(account);
  };

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="login-brand">
          <div className="brand-mark login-logo">玺</div>
          <div>
            <h1>小玺AI员工</h1>
            <p>登录一次后会记住账号，下次直接进入工作台</p>
          </div>
        </div>

        <form className="login-form" onSubmit={submit}>
          <label className="field">
            <span>账号</span>
            <input value={account} onChange={(event) => setAccount(event.target.value)} placeholder="请输入账号" />
          </label>
          <label className="field">
            <span>密码</span>
            <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" type="password" />
          </label>
          {error && <div className="login-error">{error}</div>}
          <button className="primary-button login-button" type="submit">
            <Lock size={17} />
            登录
          </button>
        </form>
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

  return (
    <section className="page agent-page">
      <div className="page-head">
        <div>
          <h1>同步微信联系人</h1>
          <p>把当前微信通讯录同步到小玺，后续主动触达可直接筛选联系人。同步只读取联系人，不会发送消息。</p>
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

      <div className="status-strip">
        <StatusCard label="同步状态" value={statusLabel} good={syncState.status === "synced"} />
        <StatusCard label="通讯录人数" value={`${contacts.length || syncState.contact_count}人`} good={(contacts.length || syncState.contact_count) > 0} />
        <StatusCard label="微信账号" value={syncState.account_name || "未识别"} good={Boolean(syncState.account_name)} />
        <StatusCard label="最近同步" value={lastSynced} good={Boolean(syncState.last_synced_at)} />
      </div>
      {locked && <div className="touch-notice">当前任务名单已经冻结。请先完成或结束本次任务，再重新同步联系人。</div>}
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
      {error && <div className="touch-notice">{error}</div>}

      <div className="table-panel contact-table-scroll">
        <div className="panel-title">联系人预览</div>
        <table>
          <thead>
            <tr>
              <th>称呼</th>
              <th>备注</th>
              <th>昵称</th>
              <th>微信号</th>
              <th>来源</th>
            </tr>
          </thead>
          <tbody>
            {contacts.length ? (
              contacts.map((contact) => (
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
          <h1>账号管理</h1>
          <p>统一管理内容渠道账号。账号接入将在下一阶段开放。</p>
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

function MomentsOperations() {
  const features = [
    { title: "朋友圈发布", description: "编辑并发布业务微信的朋友圈内容。", icon: Send },
    { title: "点赞评论", description: "统一处理朋友圈点赞与评论互动。", icon: ThumbsUp }
  ];

  return (
    <section className="page moments-page">
      <div className="page-head">
        <div>
          <h1>朋友圈运营</h1>
          <p>统一管理朋友圈内容发布和客户互动。</p>
        </div>
      </div>
      <div className="channel-account-grid">
        {features.map((feature) => {
          const FeatureIcon = feature.icon;
          return (
            <article className="channel-account-card" key={feature.title}>
              <div className="channel-account-icon"><FeatureIcon size={22} /></div>
              <div>
                <strong>{feature.title}</strong>
                <p>{feature.description}</p>
              </div>
              <span>下一阶段</span>
            </article>
          );
        })}
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
      <DeepSeekApiSettings onConfiguredChange={onConfiguredChange} />
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
      setStatusTone(result.ok ? "neutral" : "error");
      setStatus(configured ? "已保存，可测试连接。" : result.error || "尚未保存 API Key。");
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
      if (!result.ok) {
        setStatusTone("error");
        return setStatus(result.error || "操作失败，请稍后重试。");
      }
      if (clearInput) setApiKey("");
      setStatusTone("success");
      setStatus(success);
      if (typeof result.data?.configured === "boolean") {
        const configured = result.data.configured;
        setMaskedKey(configured ? result.data.maskedKey || "" : "");
        onConfiguredChange?.(configured);
      }
    }).catch(() => {
      setStatusTone("error");
      setStatus("操作失败，请稍后重试。");
    }).finally(() => setBusy(false));
  };

  return (
    <div className="table-panel deepseek-settings">
      <div className="deepseek-settings-head">
        <div>
          <div className="deepseek-title">DeepSeek API</div>
          <p>密钥仅在当前 Windows 用户下加密保存。</p>
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
            <button className="secondary-button" onClick={() => run(() => window.xiaoxiDeepSeekApi!.test(apiKey.trim() ? { apiKey: apiKey.trim() } : undefined), "DeepSeek 连接正常。") } disabled={busy || (!apiKey.trim() && !maskedKey)}>
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

function ActiveTouch({
  contacts,
  messageDraft,
  touchTask,
  touchTaskPreview,
  touchTaskError,
  contactSyncState,
  contactSyncError,
  contactSyncBusy,
  excludedContactIds,
  locked,
  onMessageDraftChange,
  onSync,
  onOpenSync,
  onExclude,
  onRestore,
  onResolveUnknown,
  onEndTask
}: {
  contacts: ContactRow[];
  messageDraft: string;
  touchTask: TouchTaskState;
  touchTaskPreview: TouchTaskPreview | null;
  touchTaskError: string;
  contactSyncState: ContactSyncState;
  contactSyncError: string;
  contactSyncBusy: boolean;
  excludedContactIds: string[];
  locked: boolean;
  onMessageDraftChange: (message: string) => void;
  onSync: () => void;
  onOpenSync: () => void;
  onExclude: (contactId: string) => void;
  onRestore: (contactId: string) => void;
  onResolveUnknown: (contactId: string, resolution: "sent" | "skip") => void;
  onEndTask: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const hasFrozenSnapshot = taskHasUnfinishedSnapshot(touchTask);
  const excludedIdSet = new Set(excludedContactIds);
  const liveEligibleContacts = touchTaskPreview?.eligible ?? contacts.filter((contact) => contact.allowed);
  const systemExcludedContacts = touchTaskPreview?.excluded ?? contacts
    .filter((contact) => !contact.allowed)
    .map((contact) => ({ contact, reason: "联系人已停用或禁止触达" }));
  const userExcludedContacts = hasFrozenSnapshot ? [] : liveEligibleContacts.filter((contact) => excludedIdSet.has(contact.id));
  const eligibleContacts = hasFrozenSnapshot
    ? touchTask.results.map((result) => result.contact)
    : liveEligibleContacts.filter((contact) => !excludedIdSet.has(contact.id));
  const excludedContacts = hasFrozenSnapshot ? touchTask.excluded_contacts ?? [] : systemExcludedContacts;
  const eligibleCount = hasFrozenSnapshot ? touchTask.eligible_total ?? eligibleContacts.length : eligibleContacts.length;
  const excludedCount = hasFrozenSnapshot ? touchTask.excluded_total ?? excludedContacts.length : excludedContacts.length + userExcludedContacts.length;
  const totalCount = hasFrozenSnapshot ? eligibleCount + excludedCount : liveEligibleContacts.length + excludedContacts.length;
  const completedCount = touchTask.results.filter((result) => result.status === "draft_ready" || result.status === "sent_verified").length;
  const skippedCount = touchTask.results.filter((result) => ["skipped", "ai_failed_skipped", "identity_skipped", "outcome_unknown_skipped"].includes(result.status)).length;
  const processedCount = Math.max(touchTask.current_index, touchTask.results.filter((result) => processedTouchResult(result.status)).length);
  const blockedCount = touchTask.results.filter((result) => result.status === "blocked" || result.status === "outcome_unknown").length;
  const query = searchQuery.trim().toLocaleLowerCase();
  const matchesSearch = (contact: ContactRow) => !query || [contactName(contact), contact.remark, contact.nickname, contact.wechatId, contact.wxid]
    .some((value) => value?.toLocaleLowerCase().includes(query));
  const visibleResults = hasFrozenSnapshot ? (query ? touchTask.results.filter((result) => matchesSearch(result.contact)) : touchTask.results) : [];
  const visibleEligible = hasFrozenSnapshot ? [] : (query ? eligibleContacts.filter(matchesSearch) : eligibleContacts);
  const visibleUserExcluded = hasFrozenSnapshot ? [] : (query ? userExcludedContacts.filter(matchesSearch) : userExcludedContacts);
  const visibleExcluded = query ? excludedContacts.filter((item) => matchesSearch(item.contact)) : excludedContacts;
  const syncStatusLabel = contactSyncState.status === "synced"
    ? `已同步 ${contacts.length || contactSyncState.contact_count} 人`
    : contactSyncState.status === "capturing"
      ? "正在同步"
      : contactSyncState.status === "blocked"
        ? "同步失败"
        : "尚未同步";

  return (
    <section className="page touch-page">
      <div className="page-head">
        <div>
          <h1>主动触达</h1>
          <p>同步联系人，设置话术并移出本次不触达的人，然后点击右下角启动程序。</p>
        </div>
      </div>

      <div className="status-strip">
        <StatusCard label="联系人总数" value={`${totalCount}人`} good={totalCount > 0} />
        <StatusCard label="本次触达" value={`${eligibleCount}人`} good={eligibleCount > 0} />
        <StatusCard label="本次排除" value={`${excludedCount}人`} good={excludedCount === 0} />
        <StatusCard label="任务状态" value={touchTaskStatusLabel(touchTask)} good={touchTask.status === "running" || touchTask.status === "completed"} />
        <StatusCard label="已处理" value={`${processedCount}/${touchTask.total || eligibleCount}`} good={processedCount > 0 || touchTask.status === "completed"} />
      </div>

      <div className="touch-setup-grid">
        <div className="table-panel touch-sync-card">
          <div>
            <strong>微信联系人</strong>
            <span>{syncStatusLabel}{contactSyncState.account_name ? ` · ${contactSyncState.account_name}` : ""}</span>
            {(contactSyncError || contactSyncState.last_error) && <small>{contactSyncError || contactSyncState.last_error}</small>}
          </div>
          <div className="touch-sync-actions">
            <button className="primary-button" onClick={onSync} disabled={locked || contactSyncBusy}>
              <UsersRound size={16} />
              {contactSyncBusy ? "同步中" : contacts.length ? "重新同步" : "同步联系人"}
            </button>
            <button className="text-button inline-text-button" onClick={onOpenSync}>高级排查</button>
          </div>
        </div>
      </div>

      {!eligibleContacts.length && <div className="touch-notice">本次暂无可触达联系人，请先同步或恢复至少一位联系人。</div>}
      {touchTaskError && <div className="touch-notice">{touchTaskError}</div>}
      {touchTask.pause_reason && touchTask.status === "paused" && <div className="touch-notice">{touchTask.pause_reason}</div>}
      {locked && (
        <div className="touch-frozen-notice">
          <span>任务名单和话术已冻结；暂停或退出程序后，可继续上次进度。</span>
          <button className="danger-button" onClick={onEndTask}>结束本次任务</button>
        </div>
      )}

      <div className="simple-touch-panel">
        <label className="script-field">
          <span>触达话术（已填默认文案，可直接修改）</span>
          <textarea
            value={messageDraft}
            onChange={(event) => onMessageDraftChange(event.target.value)}
            placeholder={DEFAULT_TOUCH_MESSAGE}
            disabled={locked}
          />
        </label>
      </div>

      {touchTask.results.length > 0 && (
        <div className="task-summary-row">
          <span>当前：{touchTask.current_contact ? contactName(touchTask.current_contact) : "无"}</span>
          <span>下一位：{touchTask.next_contact ? contactName(touchTask.next_contact) : "无"}</span>
          <span>完成：{completedCount}人</span>
          <span>跳过：{skippedCount}人</span>
          <span>阻断：{blockedCount}人</span>
        </div>
      )}

      <details className="debug-panel contact-preview-panel" open>
        <summary>联系人预览 · {hasFrozenSnapshot ? "任务冻结快照" : "同步预检"}</summary>
        <div className="contact-list-toolbar">
          <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索称呼、备注、昵称或微信号" />
          <span>{hasFrozenSnapshot ? "名单已冻结" : `本次将触达 ${eligibleCount} 人`}</span>
        </div>
        <div className="table-panel flat-table-panel contact-table-scroll">
          <table className="touch-contact-table">
            <thead>
              <tr>
                <th>称呼</th>
                <th>备注</th>
                <th>昵称</th>
                <th>微信号</th>
                <th>状态</th>
                <th>文案 / 原因</th>
                <th>本次操作</th>
              </tr>
            </thead>
            <tbody>
              {hasFrozenSnapshot ? (
                <>
                  {visibleResults.map((result) => (
                    <tr key={result.id}>
                      <td>{contactName(result.contact)}</td>
                      <td>{result.contact.remark || "-"}</td>
                      <td>{result.contact.nickname || "-"}</td>
                      <td>{result.contact.wechatId || "-"}</td>
                      <td>{taskResultLabel(result.status)}</td>
                      <td className="touch-message-cell">{result.reason || result.message || fillTouchTemplate(touchTask.script, result.contact)}</td>
                      <td className="touch-row-actions">
                        {touchTask.phase === "awaiting_unknown_resolution" && touchTask.current_result?.id === result.id && result.awaiting_resolution ? (
                          <>
                            <button className="text-button" onClick={() => onResolveUnknown(result.contact.id, "sent")}>视为已发送</button>
                            <button className="text-button danger-text-button" onClick={() => onResolveUnknown(result.contact.id, "skip")}>跳过</button>
                          </>
                        ) : "-"}
                      </td>
                    </tr>
                  ))}
                  {visibleExcluded.map((item, index) => (
                    <tr key={`excluded-${item.contact.id || index}`}>
                      <td>{contactName(item.contact)}</td>
                      <td>{item.contact.remark || "-"}</td>
                      <td>{item.contact.nickname || "-"}</td>
                      <td>{item.contact.wechatId || "-"}</td>
                      <td>{item.reason_code === "user_excluded" ? "已移出本次" : "系统排除"}</td>
                      <td className="touch-reason-cell">{item.reason || item.reason_code || "身份不符合触达条件"}</td>
                      <td>-</td>
                    </tr>
                  ))}
                </>
              ) : eligibleContacts.length || userExcludedContacts.length || excludedContacts.length ? (
                <>
                  {visibleEligible.map((contact) => (
                    <tr key={contact.id}>
                      <td>{contactName(contact)}</td>
                      <td>{contact.remark || "-"}</td>
                      <td>{contact.nickname || "-"}</td>
                      <td>{contact.wechatId || "-"}</td>
                      <td>待AI生成</td>
                      <td className="touch-message-cell">{fillTouchTemplate(messageDraft, contact)}</td>
                      <td className="touch-row-actions"><button className="text-button" onClick={() => onExclude(contact.id)}>移出本次触达</button></td>
                    </tr>
                  ))}
                  {visibleUserExcluded.map((contact) => (
                    <tr key={`user-excluded-${contact.id}`}>
                      <td>{contactName(contact)}</td>
                      <td>{contact.remark || "-"}</td>
                      <td>{contact.nickname || "-"}</td>
                      <td>{contact.wechatId || "-"}</td>
                      <td>已移出本次</td>
                      <td className="touch-reason-cell">用户移出本次触达</td>
                      <td className="touch-row-actions"><button className="text-button" onClick={() => onRestore(contact.id)}>恢复</button></td>
                    </tr>
                  ))}
                  {visibleExcluded.map((item, index) => (
                    <tr key={`excluded-${item.contact.id || index}`}>
                      <td>{contactName(item.contact)}</td>
                      <td>{item.contact.remark || "-"}</td>
                      <td>{item.contact.nickname || "-"}</td>
                      <td>{item.contact.wechatId || "-"}</td>
                      <td>系统排除</td>
                      <td className="touch-reason-cell">{item.reason || item.reason_code || "身份不符合触达条件"}</td>
                      <td>-</td>
                    </tr>
                  ))}
                </>
              ) : (
                <EmptyTableRow colSpan={7} message="暂无同步联系人" />
              )}
              {(touchTask.results.length + eligibleContacts.length + userExcludedContacts.length + excludedContacts.length > 0)
                && (visibleResults.length + visibleEligible.length + visibleUserExcluded.length + visibleExcluded.length === 0) && query && (
                <EmptyTableRow colSpan={7} message="没有找到匹配联系人" />
              )}
            </tbody>
          </table>
        </div>
      </details>

    </section>
  );
}

function FloatingTouchWindow() {
  const [touchTask, setTouchTask] = useState<TouchTaskState>(() => emptyTouchTask());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const applyResult = (result: TouchTaskResult) => {
    if (result.task) setTouchTask(result.task);
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
          <strong>{currentResult ? taskResultLabel(currentResult.status) : statusText}</strong>
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

function StatusCard({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="status-card">
      <span>{label}</span>
      <strong className={good ? "ok" : "warn"}>{value}</strong>
    </div>
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
