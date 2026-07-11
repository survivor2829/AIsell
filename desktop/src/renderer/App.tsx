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
import { lazy, Suspense, type ComponentType, type FormEvent, useEffect, useMemo, useState } from "react";

type ModuleKey =
  | "agent"
  | "reply"
  | "contact-sync"
  | "touch"
  | "moments"
  | "video-leads"
  | "accounts"
  | "materials"
  | "script"
  | "cut"
  | "ai-video"
  | "publish"
  | "leads"
  | "data";

type GroupKey = "agent" | "video-leads";
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
  status: string;
  reason: string;
  message: string;
  updated_at: string;
};
type TouchTaskState = {
  id: string;
  status: string;
  script: string;
  started_at: string;
  updated_at: string;
  completed_at: string;
  current_index: number;
  total: number;
  pause_reason: string;
  current_contact: ContactRow | null;
  next_contact: ContactRow | null;
  current_result: TouchTaskItem | null;
  results: TouchTaskItem[];
};
type TouchTaskResult = {
  ok: boolean;
  task?: TouchTaskState;
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
    };
    xiaoxiTouchTask?: {
      start: (payload: { script: string }) => Promise<TouchTaskResult>;
      status: () => Promise<TouchTaskResult>;
      pause: () => Promise<TouchTaskResult>;
      resume: () => Promise<TouchTaskResult>;
      stop: () => Promise<TouchTaskResult>;
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
const DEFAULT_ACTIVE_MODULE: ModuleKey = "reply";
const DEFAULT_TOUCH_MESSAGE = "{称呼}，您好，我们这边有清洁设备短租和会员特惠方案，想了解一下您近期是否需要降本增效？";
const DEVELOPMENT_EDITION = import.meta.env.VITE_XIAOXI_EDITION === "development";
const DevelopmentAcceptance = DEVELOPMENT_EDITION ? lazy(() => import("./DevelopmentAcceptance")) : null;

const agentChildren: NavItem[] = [
  { key: "reply", label: "自动回复", icon: MessageCircle },
  { key: "contact-sync", label: "同步联系人", icon: UsersRound },
  { key: "touch", label: "主动触达", icon: Send },
  { key: "moments", label: "朋友圈点赞评论", icon: ThumbsUp }
];

const videoChildren: NavItem[] = [
  { key: "accounts", label: "账号管理", icon: UserRound },
  { key: "materials", label: "素材仓库", icon: Folder },
  { key: "script", label: "AI脚本工厂", icon: BookOpen },
  { key: "cut", label: "自动剪辑工厂", icon: Scissors },
  { key: "ai-video", label: "AI生成视频", icon: MonitorPlay },
  { key: "publish", label: "发布工作台", icon: Clapperboard },
  { key: "leads", label: "线索回流", icon: RefreshCw },
  { key: "data", label: "数据复盘", icon: BarChart3 }
];

const navGroups: NavGroup[] = [
  { key: "agent", label: "个微Agent", icon: UsersRound, children: agentChildren },
  { key: "video-leads", label: "短视频获客", icon: Video, children: videoChildren }
];

const navItems = [...navGroups, ...agentChildren, ...videoChildren];

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
    script: "",
    started_at: "",
    updated_at: "",
    completed_at: "",
    current_index: 0,
    total: 0,
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
    stopped: "已停止",
    completed: "已完成"
  };
  return labels[status] ?? status;
}

function taskResultLabel(status: string) {
  const labels: Record<string, string> = {
    pending: "待处理",
    processing: "处理中",
    draft_ready: "草稿已填",
    blocked: "已阻断",
    skipped: "已跳过"
  };
  return labels[status] ?? status;
}

export default function App() {
  const isFloatingWindow = new URLSearchParams(window.location.search).get("floating") === "1";
  if (isFloatingWindow) return <FloatingTouchWindow />;

  const [user, setUser] = useState<UserProfile | null>(() => readStoredUser());
  const [active, setActive] = useState<ModuleKey>(DEFAULT_ACTIVE_MODULE);
  const [openGroups, setOpenGroups] = useState<Record<GroupKey, boolean>>({ agent: true, "video-leads": true });
  const [contactRows, setContactRows] = useState<ContactRow[]>([]);
  const [contactSyncBusy, setContactSyncBusy] = useState(false);
  const [contactSyncState, setContactSyncState] = useState<ContactSyncState>({
    status: "idle",
    contact_count: 0,
    last_synced_at: "",
    last_error: "",
    last_stage: "idle",
    account_name: "",
    helper_configured: false
  });
  const [contactSyncError, setContactSyncError] = useState("");
  const [touchTask, setTouchTask] = useState<TouchTaskState>(() => emptyTouchTask());
  const [touchTaskError, setTouchTaskError] = useState("");
  const [messageDraft, setMessageDraft] = useState(DEFAULT_TOUCH_MESSAGE);
  const addLog = (_action: string, _result: string) => undefined;

  useEffect(() => {
    setMessageDraft((current) => current || DEFAULT_TOUCH_MESSAGE);
  }, []);

  useEffect(() => {
    document.title = DEVELOPMENT_EDITION ? "小玺AI员工 开发版" : "小玺AI员工 客户版";
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
    }
    if (result.contacts) setContactRows(result.contacts);
    setContactSyncError(result.error ?? "");
    if (result.error) addLog("同步微信联系人", result.error);
  };

  const applyTouchTaskResult = (result: TouchTaskResult) => {
    if (result.task) {
      setTouchTask(result.task);
      const unfinished = (result.task.status === "running" || result.task.status === "paused") && result.task.current_index < result.task.total;
      if (unfinished && result.task.script.trim()) setMessageDraft(result.task.script);
    }
    setTouchTaskError(result.error ?? "");
    if (result.error) addLog("启动程序", result.error);
  };

  const callContactSync = async (action: string, run: () => Promise<ContactSyncResult>) => {
    if (!window.xiaoxiContactSync) {
      setContactSyncError("当前环境未连接联系人同步执行器");
      addLog(action, "当前环境未连接联系人同步执行器");
      return;
    }

    setContactSyncBusy(true);
    try {
      applyContactSyncResult(await run());
    } catch (error) {
      const message = error instanceof Error ? error.message : "执行失败";
      setContactSyncError(message);
      addLog(action, message);
    } finally {
      setContactSyncBusy(false);
    }
  };

  const refreshContactSync = () => {
    void callContactSync("同步状态读取", () => window.xiaoxiContactSync!.status());
  };

  const runContactSync = () => {
    setContactSyncState((current) => ({
      ...current,
      status: "capturing",
      last_stage: "waiting_login_window",
      last_error: ""
    }));
    setContactSyncError("");
    void callContactSync("同步微信联系人", () => window.xiaoxiContactSync!.capture());
  };

  const startTouchTask = () => {
    if (active !== "touch") {
      setActive("touch");
      addLog("启动程序", "请先在主动触达页填写话术");
      return;
    }

    if (!contactRows.some((contact) => contact.allowed)) {
      setTouchTaskError("请先同步当前微信联系人");
      addLog("启动程序", "请先同步当前微信联系人");
      return;
    }

    if (!messageDraft.trim()) {
      setTouchTaskError("请先填写触达话术");
      addLog("启动程序", "请先填写触达话术");
      return;
    }

    if (!window.xiaoxiTouchTask) {
      setTouchTaskError("当前环境未连接任务执行器");
      addLog("启动程序", "当前环境未连接任务执行器");
      return;
    }

    setTouchTaskError("");
    void window.xiaoxiTouchTask
      .start({ script: messageDraft })
      .then(applyTouchTaskResult)
      .catch((error) => {
        const message = error instanceof Error ? error.message : "启动失败";
        setTouchTaskError(message);
        addLog("启动程序", message);
      });
  };

  const updateMessageDraft = (message: string) => {
    setMessageDraft(message);
  };

  useEffect(() => {
    if (user && (active === "contact-sync" || active === "touch")) refreshContactSync();
  }, [user, active]);

  useEffect(() => {
    if (user) storeUser(user);
  }, [user]);

  useEffect(() => {
    if (!window.xiaoxiTouchTask) return undefined;
    void window.xiaoxiTouchTask.status().then(applyTouchTaskResult).catch(() => undefined);
    return window.xiaoxiTouchTask.onUpdate(applyTouchTaskResult);
  }, []);

  const allowedContactCount = contactRows.filter((contact) => contact.allowed).length;
  const canLaunchTouch = active === "touch" && allowedContactCount > 0 && Boolean(messageDraft.trim());
  const launchTitle =
    active !== "touch"
      ? "请先进入主动触达"
      : allowedContactCount === 0
        ? "请先同步当前微信联系人"
        : !messageDraft.trim()
          ? "请先填写触达话术"
          : "启动主动触达任务";

  if (!user) return <LoginScreen onLogin={login} />;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">玺</div>
          <span>小玺AI员工 · {DEVELOPMENT_EDITION ? "开发版" : "客户版"}</span>
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
                          <span>{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div />
          <div className="top-actions">
            <button className="guide">
              <CircleHelp size={14} />
              新手引导
            </button>
            <div className="avatar">{user.avatar}</div>
            <button className="account-name">{user.name}</button>
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
            />
          )}
          {active === "accounts" && <AccountManagement />}
          {active === "touch" && (
            <ActiveTouch
              contacts={contactRows}
              messageDraft={messageDraft}
              touchTask={touchTask}
              touchTaskError={touchTaskError}
              onMessageDraftChange={updateMessageDraft}
            />
          )}
          {active === "touch" && DevelopmentAcceptance && (
            <Suspense fallback={null}>
              <DevelopmentAcceptance contacts={contactRows} message={messageDraft} />
            </Suspense>
          )}
          {active !== "contact-sync" && active !== "accounts" && active !== "touch" && <Placeholder title={activeTitle} />}
        </div>

        <button className={`launch-button ${canLaunchTouch ? "" : "disabled"}`} onClick={startTouchTask} disabled={!canLaunchTouch} title={launchTitle}>
          启动
          <br />
          程序
        </button>
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
  onSync
}: {
  contacts: ContactRow[];
  syncState: ContactSyncState;
  syncError: string;
  busy: boolean;
  onRefresh: () => void;
  onSync: () => void;
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
          <button className="primary-button" onClick={onSync} disabled={busy}>
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
      {error && <div className="touch-notice">{error}</div>}

      <div className="table-panel">
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
              contacts.slice(0, 8).map((contact) => (
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
  return (
    <section className="page account-page">
      <div className="page-head">
        <div>
          <h1>账号管理</h1>
          <p>配置您自己的 DeepSeek API Key 后，主动触达才会生成 AI 文案。</p>
        </div>
      </div>
      <DeepSeekApiSettings />
    </section>
  );
}

function DeepSeekApiSettings() {
  const [apiKey, setApiKey] = useState("");
  const [maskedKey, setMaskedKey] = useState("");
  const [status, setStatus] = useState("正在读取已保存的设置…");
  const [statusTone, setStatusTone] = useState<"neutral" | "success" | "error">("neutral");
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    if (!window.xiaoxiDeepSeekApi) {
      setStatusTone("error");
      return setStatus("当前环境未连接 DeepSeek 设置。");
    }
    void window.xiaoxiDeepSeekApi.status().then((result) => {
      setMaskedKey(result.ok && result.data?.configured ? result.data.maskedKey || "" : "");
      setStatusTone(result.ok ? "neutral" : "error");
      setStatus(result.ok && result.data?.configured ? "已保存，可测试连接。" : result.error || "尚未保存 API Key。");
    }).catch(() => {
      setStatusTone("error");
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
      if (typeof result.data?.configured === "boolean") setMaskedKey(result.data.configured ? result.data.maskedKey || "" : "");
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
        <span className={`deepseek-config-state ${maskedKey ? "is-configured" : ""}`}>
          <span className="deepseek-state-dot" />
          {maskedKey ? "已配置" : "未配置"}
        </span>
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
  touchTaskError,
  onMessageDraftChange
}: {
  contacts: ContactRow[];
  messageDraft: string;
  touchTask: TouchTaskState;
  touchTaskError: string;
  onMessageDraftChange: (message: string) => void;
}) {
  const allowedContacts = contacts.filter((contact) => contact.allowed);
  const previewTarget = allowedContacts[0] ?? null;
  const completedCount = touchTask.results.filter((result) => result.status === "draft_ready").length;
  const skippedCount = touchTask.results.filter((result) => result.status === "skipped").length;
  const processedCount = completedCount + skippedCount;
  const blockedCount = touchTask.results.filter((result) => result.status === "blocked").length;

  return (
    <section className="page touch-page">
      <div className="page-head">
        <div>
          <h1>主动触达</h1>
          <p>填写第一句话，点击右下角启动程序。小玺会逐个打开会话并写入草稿，只做预检，不会自动发送。</p>
        </div>
      </div>

      <div className="status-strip">
        <StatusCard label="本次触达" value={`${allowedContacts.length}人`} good={allowedContacts.length > 0} />
        <StatusCard label="任务状态" value={taskStatusLabel(touchTask.status)} good={touchTask.status === "running" || touchTask.status === "completed"} />
        <StatusCard label="已处理" value={`${processedCount}/${touchTask.total || allowedContacts.length}`} good={processedCount > 0 || touchTask.status === "completed"} />
        <StatusCard label="安全边界" value="只写草稿" good />
      </div>

      {!allowedContacts.length && <div className="touch-notice">请先在“同步联系人”里同步当前微信通讯录。</div>}
      {touchTaskError && <div className="touch-notice">{touchTaskError}</div>}
      {touchTask.pause_reason && touchTask.status === "paused" && <div className="touch-notice">{touchTask.pause_reason}</div>}

      <div className="simple-touch-panel">
        <label className="script-field">
          <span>触达话术（已填默认文案，可直接修改）</span>
          <textarea
            value={messageDraft}
            onChange={(event) => onMessageDraftChange(event.target.value)}
            placeholder={DEFAULT_TOUCH_MESSAGE}
          />
        </label>
      </div>

      {touchTask.results.length > 0 && (
        <div className="task-summary-row">
          <span>当前：{touchTask.current_contact ? contactName(touchTask.current_contact) : "无"}</span>
          <span>下一位：{touchTask.next_contact ? contactName(touchTask.next_contact) : "无"}</span>
          <span>跳过：{skippedCount}人</span>
          <span>阻断：{blockedCount}人</span>
        </div>
      )}

      <details className="debug-panel contact-preview-panel">
        <summary>联系人预览</summary>
        <div className="table-panel flat-table-panel">
          <table>
            <thead>
              <tr>
                <th>称呼</th>
                <th>微信号</th>
                <th>来源</th>
              </tr>
            </thead>
            <tbody>
              {allowedContacts.length ? (
                allowedContacts.slice(0, 8).map((customer) => (
                  <tr key={customer.id}>
                    <td>{contactName(customer)}</td>
                    <td>{customer.wechatId || "-"}</td>
                    <td>微信通讯录</td>
                  </tr>
                ))
              ) : (
                <EmptyTableRow colSpan={3} message="暂无同步联系人" />
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

  const applyResult = (result: TouchTaskResult) => {
    if (result.task) setTouchTask(result.task);
    setError(result.error ?? "");
  };

  const callTask = (run: () => Promise<TouchTaskResult>) => {
    if (!window.xiaoxiTouchTask) {
      setError("当前环境未连接任务执行器");
      return;
    }

    void run()
      .then(applyResult)
      .catch((err) => setError(err instanceof Error ? err.message : "执行失败"));
  };

  useEffect(() => {
    if (!window.xiaoxiTouchTask) {
      setError("当前环境未连接任务执行器");
      return undefined;
    }
    void window.xiaoxiTouchTask.status().then(applyResult).catch(() => setError("读取任务状态失败"));
    return window.xiaoxiTouchTask.onUpdate(applyResult);
  }, []);

  const completedCount = touchTask.results.filter((result) => result.status === "draft_ready").length;
  const skippedCount = touchTask.results.filter((result) => result.status === "skipped").length;
  const progressTotal = touchTask.total || touchTask.results.length;
  const processedCount = completedCount + skippedCount;
  const progressValue = progressTotal ? Math.min(100, Math.round((processedCount / progressTotal) * 100)) : 0;
  const currentName = touchTask.current_contact ? contactName(touchTask.current_contact) : "暂无";
  const nextName = touchTask.next_contact ? contactName(touchTask.next_contact) : "暂无";
  const currentResult = touchTask.current_result;
  const statusText = currentResult?.reason || touchTask.pause_reason || taskStatusLabel(touchTask.status);

  return (
    <main className="floating-shell">
      <header className="floating-head">
        <div className="floating-title">
          <span className={`floating-pulse ${touchTask.status}`} />
          <strong>触达进度</strong>
        </div>
        <button className="floating-close" aria-label="返回主页面" onClick={() => callTask(() => window.xiaoxiTouchTask!.closeFloating())}>
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
          <span>{taskStatusLabel(touchTask.status)}</span>
          <strong>{currentResult ? taskResultLabel(currentResult.status) : statusText}</strong>
        </div>
      </div>

      {(touchTask.pause_reason || error) && <div className="floating-alert">{error || touchTask.pause_reason}</div>}

      <div className="floating-actions">
        {touchTask.status === "running" ? (
          <button onClick={() => callTask(() => window.xiaoxiTouchTask!.pause())}>
            <Pause size={15} />
            暂停
          </button>
        ) : (
          <button onClick={() => callTask(() => window.xiaoxiTouchTask!.resume())} disabled={touchTask.status !== "paused"}>
            <Play size={15} />
            继续
          </button>
        )}
        <button onClick={() => callTask(() => window.xiaoxiTouchTask!.stop())} disabled={touchTask.status === "stopped" || touchTask.status === "completed"}>
          <Square size={14} />
          停止
        </button>
        <button onClick={() => callTask(() => window.xiaoxiTouchTask!.closeFloating())}>主页面</button>
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
      <p>该模块正在接入中，当前可先使用同步联系人和主动触达。</p>
    </section>
  );
}
