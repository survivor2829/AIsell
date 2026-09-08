import {
  ArrowRight,
  BarChart3,
  Bot,
  CheckCircle2,
  Clock3,
  Clapperboard,
  Folder,
  Images,
  Link2,
  ListTodo,
  MessageCircle,
  MonitorPlay,
  Palette,
  RadioTower,
  Send,
  Smartphone,
  Sparkles,
  ThumbsUp,
  UserRound,
  UsersRound,
  Video
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType
} from "react";
import type { WorkflowController, WorkflowTask } from "./WechatWorkflow";
import { AGENT_ROLE_IDENTITIES, appearanceFor, appearanceStyle, type AgentRoleKey, type RolePreference } from "./role-appearance";
import type { ContentProduction } from "./content-production-types";
import "./AgentHome.css";

export { AGENT_ROLE_IDENTITIES } from "./role-appearance";
export type { AgentRoleKey } from "./role-appearance";

export type AgentHomeTarget =
  | "workflow"
  | "reply"
  | "expert"
  | "contact-sync"
  | "touch"
  | "moments"
  | "accounts"
  | "product-detail"
  | "materials"
  | "workspace"
  | "finished"
  | "ai-video"
  | "publish"
  | "ai-check"
  | "leads"
  | "data";

type RoleCapability = {
  key: AgentHomeTarget;
  label: string;
  description: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  available?: boolean;
};

type RoleDefinition = {
  key: AgentRoleKey;
  name: string;
  responsibility: string;
  portraitKey: string;
  intro: string;
  primaryLabel: string;
  primaryTarget: AgentHomeTarget;
  capabilities: RoleCapability[];
};

const ROLE_DEFINITIONS: Record<AgentRoleKey, RoleDefinition> = {
  agent: {
    key: "agent",
    ...AGENT_ROLE_IDENTITIES.agent,
    portraitKey: "xiaoxi-integrated",
    intro: "我负责把微信联系人、每日计划和客户触达串起来，让你一眼看清今天该做什么。",
    primaryLabel: "查看今日计划",
    primaryTarget: "workflow",
    capabilities: [
      { key: "expert", label: "AI专家", description: "协助判断下一步获客动作", icon: Bot },
      { key: "workflow", label: "今日计划", description: "查看和安排今天的任务", icon: ListTodo },
      { key: "reply", label: "自动回复", description: "管理微信回复状态", icon: MessageCircle },
      { key: "contact-sync", label: "同步联系人", description: "同步当前微信通讯录", icon: UsersRound },
      { key: "touch", label: "精准触达", description: "按计划触达目标客户", icon: Send },
      { key: "moments", label: "朋友圈运营", description: "执行朋友圈发布与互动", icon: ThumbsUp }
    ]
  },
  production: {
    key: "production",
    ...AGENT_ROLE_IDENTITIES.production,
    portraitKey: "xiaohui-integrated",
    intro: "我负责整理素材、发起制作任务并沉淀成片，把分散内容变成可以交付的作品。",
    primaryLabel: "开始内容创作",
    primaryTarget: "workspace",
    capabilities: [
      { key: "product-detail", label: "产品详情图", description: "生成商品展示内容", icon: Images },
      { key: "materials", label: "素材仓库", description: "管理图片与视频素材", icon: Folder },
      { key: "workspace", label: "创作工作台", description: "开始一项内容制作", icon: Clapperboard },
      { key: "finished", label: "成片中心", description: "查看已经完成的作品", icon: Video },
      { key: "ai-video", label: "AI 生成视频", description: "生成式视频能力正在建设", icon: MonitorPlay, available: false }
    ]
  },
  operations: {
    key: "operations",
    ...AGENT_ROLE_IDENTITIES.operations,
    portraitKey: "xiaolian-integrated",
    intro: "我负责连接渠道账号、组织发布任务并回收运营结果；未接通的平台会明确标注状态。",
    primaryLabel: "管理渠道账号",
    primaryTarget: "accounts",
    capabilities: [
      { key: "accounts", label: "学员与账号", description: "查看账号与渠道连接入口", icon: UserRound },
      { key: "publish", label: "发布任务", description: "渠道发布能力尚未连接", icon: Send, available: false },
      { key: "ai-check", label: "AI 检查", description: "内容检查能力尚未连接", icon: CheckCircle2, available: false },
      { key: "leads", label: "线索回流", description: "渠道线索能力尚未连接", icon: RadioTower, available: false },
      { key: "data", label: "数据复盘", description: "渠道数据能力尚未连接", icon: BarChart3, available: false }
    ]
  }
};

type ProductionSnapshot = {
  assets: string | null;
  tasks: string | null;
  openTasks: string | null;
  hasOpenTasks: boolean;
  finished: string | null;
  latestTask: ContentProduction | null;
  loading: boolean;
  error: string;
};

type Metric = {
  label: string;
  value: string;
  unit?: string;
  detail: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
};

type ImportantTask = {
  title: string;
  detail: string;
  status: string;
  target: AgentHomeTarget;
  action: string;
};

type PortraitFrame = "idle" | "blink" | "wave";
type DatedWorkflowTask = WorkflowTask & { completedAt?: string };
type FrameAvailability = Partial<Record<PortraitFrame, boolean>>;

const CONTENT_LIST_LIMIT = 500;
const PORTRAIT_FRAMES: PortraitFrame[] = ["idle"];
const EMPTY_FRAME_AVAILABILITY: FrameAvailability = {};
const WORKFLOW_STATUS_LABELS: Record<WorkflowTask["status"], string> = {
  pending: "待执行",
  running: "进行中",
  completed: "已完成",
  cancelled: "已取消",
  needs_attention: "需处理",
  missed: "已错过"
};
const WORKFLOW_STATUS_PRIORITY: Record<WorkflowTask["status"], number> = {
  running: 0,
  needs_attention: 1,
  missed: 2,
  pending: 3,
  completed: 4,
  cancelled: 5
};

function boundedCount(count: number, returnedCount: number) {
  return `${returnedCount >= CONTENT_LIST_LIMIT ? "≥" : ""}${count}`;
}

function localDateKey(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function belongsToToday(task: WorkflowTask, today: string) {
  if (task.repeat === "daily") return true;
  if (task.scheduledAt) return localDateKey(task.scheduledAt) === today;
  return true;
}

function completedToday(task: DatedWorkflowTask, today: string) {
  if (task.status !== "completed") return false;
  if (task.lastCompletedDate) return task.lastCompletedDate === today;
  return Boolean(task.completedAt && localDateKey(task.completedAt) === today);
}

function workflowTaskDetail(task: WorkflowTask) {
  if (task.accountMismatch) return "需要切换到任务对应的微信账号";
  if (task.repeat === "daily") return `每天 ${task.startTime || "按加入顺序"}`;
  if (task.scheduledAt) {
    const date = new Date(task.scheduledAt);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    }
  }
  return "已加入今日计划";
}

function useProductionSnapshot(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<ProductionSnapshot>({
    assets: null,
    tasks: null,
    openTasks: null,
    hasOpenTasks: false,
    finished: null,
    latestTask: null,
    loading: enabled,
    error: ""
  });

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const api = window.xiaoxiContent;
    if (!api) {
      setSnapshot((current) => ({ ...current, loading: false, error: "内容服务尚未连接" }));
      return;
    }

    setSnapshot((current) => ({ ...current, loading: true, error: "" }));
    try {
      const [assetsResult, tasksResult, finishedResult] = await Promise.all([
        api.library.list({ limit: CONTENT_LIST_LIMIT }),
        api.productions.list({ view: "pending", limit: 1 }),
        api.finished.list({ limit: CONTENT_LIST_LIMIT })
      ]);
      const assetItems = assetsResult.ok && assetsResult.data ? assetsResult.data.items : [];
      const taskItems = tasksResult.ok && tasksResult.data ? tasksResult.data.items : [];
      const summary = tasksResult.ok && tasksResult.data ? tasksResult.data.summary : null;
      const latest = taskItems[0];
      const finishedItems = finishedResult.ok && finishedResult.data ? finishedResult.data.items : [];
      const errors = [assetsResult, tasksResult, finishedResult]
        .filter((result) => !result.ok)
        .map((result) => result.error)
        .filter(Boolean);

      setSnapshot({
        assets: assetsResult.ok && assetsResult.data
          ? boundedCount(assetItems.filter((item) => item.availableLocationCount > 0).length, assetItems.length)
          : null,
        tasks: summary ? String(summary.pending) : null,
        openTasks: summary ? String(summary.needsAttention) : null,
        hasOpenTasks: Boolean(summary?.pending),
        finished: finishedResult.ok && finishedResult.data
          ? boundedCount(finishedItems.filter((item) => item.available !== false).length, finishedItems.length)
          : null,
        latestTask: latest || null,
        loading: false,
        error: errors[0] || ""
      });
    } catch {
      setSnapshot((current) => ({ ...current, loading: false, error: "读取内容数据失败，请稍后重试" }));
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    void refresh();
    const refreshOnFocus = () => void refresh();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [enabled, refresh]);

  return { snapshot, refresh };
}

function usePortraitMotion(role: AgentRoleKey, availableFrames: FrameAvailability) {
  const [motionActive, setMotionActive] = useState(false);
  const [frame, setFrame] = useState<PortraitFrame>("idle");
  const hasWaved = useRef(false);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setMotionActive(!preference.matches && document.visibilityState === "visible" && document.hasFocus());
    };
    update();
    preference.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      preference.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);

  useEffect(() => {
    if (!motionActive || availableFrames.idle !== true) {
      setFrame("idle");
      return undefined;
    }

    let blinkTimer = 0;
    let blinkEndTimer = 0;
    const scheduleBlink = () => {
      if (availableFrames.blink !== true) return;
      blinkTimer = window.setTimeout(() => {
        setFrame("blink");
        blinkEndTimer = window.setTimeout(() => {
          setFrame("idle");
          scheduleBlink();
        }, 170);
      }, 4200 + Math.round(Math.random() * 2200));
    };

    let waveTimer = 0;
    if (availableFrames.wave === true && !hasWaved.current) {
      hasWaved.current = true;
      setFrame("wave");
      waveTimer = window.setTimeout(() => {
        setFrame("idle");
        scheduleBlink();
      }, 1100);
    } else {
      setFrame("idle");
      scheduleBlink();
    }

    return () => {
      window.clearTimeout(waveTimer);
      window.clearTimeout(blinkTimer);
      window.clearTimeout(blinkEndTimer);
    };
  }, [availableFrames.blink, availableFrames.idle, availableFrames.wave, motionActive, role]);

  return { frame, motionActive };
}

function assetUrl(fileName: string) {
  return new URL(`./agent-characters/${fileName}`, document.baseURI).toString();
}

function AgentAtmosphere() {
  return <div className="agent-atmosphere" aria-hidden="true"><div className="agent-atmosphere-pattern" /></div>;
}

function AgentPortrait({ definition }: { definition: RoleDefinition }) {
  const [availableFrames, setAvailableFrames] = useState<FrameAvailability>({});
  const framesResolved = PORTRAIT_FRAMES.every((candidate) => Object.prototype.hasOwnProperty.call(availableFrames, candidate));
  const { frame, motionActive } = usePortraitMotion(
    definition.key,
    framesResolved ? availableFrames : EMPTY_FRAME_AVAILABILITY
  );

  useEffect(() => {
    let disposed = false;
    setAvailableFrames({});
    const probes = PORTRAIT_FRAMES.map((candidate) => {
      const probe = new window.Image();
      probe.onload = () => {
        if (!disposed) setAvailableFrames((current) => ({ ...current, [candidate]: true }));
      };
      probe.onerror = () => {
        if (!disposed) setAvailableFrames((current) => ({ ...current, [candidate]: false }));
      };
      probe.src = assetUrl(`${definition.portraitKey}-${candidate}.png`);
      return probe;
    });
    return () => {
      disposed = true;
      probes.forEach((probe) => {
        probe.onload = null;
        probe.onerror = null;
      });
    };
  }, [definition.portraitKey]);

  const displayedFrame = availableFrames.idle
    ? availableFrames[frame] ? frame : "idle"
    : null;

  return (
    <div className={`agent-portrait-stage ${motionActive ? "is-motion-active" : "is-motion-paused"}`}>
      <div className="agent-portrait-canvas">
        {displayedFrame && (
          <div className="agent-portrait-visual">
            <img
              key={displayedFrame}
              className="agent-portrait-image"
              src={assetUrl(`${definition.portraitKey}-${displayedFrame}.png`)}
              alt={`${definition.name}数字员工形象`}
              draggable={false}
            />
          </div>
        )}
        {!displayedFrame && (
          <div className="agent-portrait-fallback" role="img" aria-label={`${definition.name}角色形象待替换`}>
            <span className="agent-portrait-orbit" aria-hidden="true" />
            <strong>{definition.name.slice(-1)}</strong>
            <small>正式形象待接入</small>
          </div>
        )}
      </div>
      <div className="agent-portrait-name">
        <strong>{definition.name}</strong>
        <span>{definition.responsibility}数字员工</span>
      </div>
    </div>
  );
}

function MetricStrip({ metrics }: { metrics: Metric[] }) {
  return (
    <section className="agent-metric-strip" aria-label="业务概览">
      {metrics.map((metric) => {
        const Icon = metric.icon;
        return (
          <div className="agent-metric" key={metric.label}>
            <Icon size={20} strokeWidth={2.2} />
            <div>
              <span>{metric.label}</span>
              <p><strong>{metric.value}</strong>{metric.unit && <small>{metric.unit}</small>}</p>
              <em>{metric.detail}</em>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function roleStatus(
  role: AgentRoleKey,
  workflowState: WorkflowController["state"],
  workflowLoading: boolean,
  production: ProductionSnapshot
) {
  if (role === "agent") {
    if (workflowLoading) return "正在读取任务";
    if (workflowState.contactSync?.running) return "正在同步联系人";
    if (workflowState.enabled) return "正在执行计划";
    if (workflowState.tasks.some((task) => task.status === "needs_attention")) return "有任务需要处理";
    return "在线待命";
  }
  if (role === "production") {
    if (production.loading) return "正在读取内容数据";
    if (production.error && production.assets === null) return "内容服务未连接";
    if (production.hasOpenTasks) return "有内容任务待处理";
    return "在线待命";
  }
  return "等待渠道连接";
}

function buildWechatView(
  workflowState: WorkflowController["state"],
  workflowLoading: boolean,
  contactCount: number
) {
  const today = localDateKey(new Date());
  const tasks = workflowState.tasks;
  const pendingStatuses = new Set<WorkflowTask["status"]>(["pending", "running", "needs_attention"]);
  const pending = tasks.filter((task) => pendingStatuses.has(task.status) && belongsToToday(task, today)).length;
  const completed = tasks.filter((task) => completedToday(task as DatedWorkflowTask, today)).length;
  const priority = [...tasks].sort((left, right) => (
    WORKFLOW_STATUS_PRIORITY[left.status] - WORKFLOW_STATUS_PRIORITY[right.status]
  )).find((task) => !["completed", "cancelled"].includes(task.status) && (
    ["running", "needs_attention", "missed"].includes(task.status) || belongsToToday(task, today)
  ));

  const metrics: Metric[] = [
    { label: "微信客户", value: String(contactCount), unit: "位", detail: "来自最近一次联系人同步", icon: UsersRound },
    { label: "今日待办", value: workflowLoading ? "—" : String(pending), unit: "项", detail: "待执行、进行中与需处理任务", icon: Clock3 },
    { label: "今日完成", value: workflowLoading ? "—" : String(completed), unit: "项", detail: "按真实任务完成时间统计", icon: CheckCircle2 }
  ];

  const importantTask: ImportantTask = priority
    ? {
      title: priority.title,
      detail: workflowTaskDetail(priority),
      status: WORKFLOW_STATUS_LABELS[priority.status],
      target: "workflow",
      action: "查看任务"
    }
    : {
      title: "今天还没有安排任务",
      detail: "可以先在今日计划中添加联系人触达、朋友圈发布或互动任务。",
      status: "待安排",
      target: "workflow",
      action: "安排今日任务"
    };

  return { metrics, importantTask };
}

function buildProductionView(snapshot: ProductionSnapshot) {
  const value = (count: string | null) => snapshot.loading ? "—" : count === null ? "—" : count;
  const metrics: Metric[] = [
    { label: "素材仓库", value: value(snapshot.assets), unit: snapshot.assets === null ? undefined : "份", detail: "当前可用图片与视频素材", icon: Folder },
    { label: "待处理制作", value: value(snapshot.tasks), unit: snapshot.tasks === null ? undefined : "项", detail: snapshot.openTasks === null ? "尚未读取制作状态" : `${snapshot.openTasks} 项需要确认或处理 · 按制作批次统计`, icon: Clapperboard },
    { label: "可用成片", value: value(snapshot.finished), unit: snapshot.finished === null ? undefined : "条", detail: "本地文件仍可访问的成片", icon: Video }
  ];
  const latest = snapshot.latestTask;
  const importantTask: ImportantTask = latest
    ? {
      title: latest.title || "继续当前内容制作",
      detail: latest.errorMessage || (latest.category === "active" ? "制作正在进行，可以查看进度和已完成的步骤。" : "这项制作需要你的确认，可以打开查看详情。"),
      status: latest.category === "active" ? "进行中" : "需要处理",
      target: "workspace",
      action: "查看这项制作"
    }
    : {
      title: "开始一项新的内容制作",
      detail: snapshot.error || "从素材仓库选择内容，进入创作工作台开始制作。",
      status: snapshot.error ? "暂未连接" : "待开始",
      target: "workspace",
      action: "打开创作工作台"
    };
  return { metrics, importantTask };
}

function buildOperationsView(name: string) {
  const metrics: Metric[] = [
    { label: "账号管理", value: "可使用", detail: "可进入账号管理页面", icon: UserRound },
    { label: "渠道发布", value: "待连接", detail: "当前没有已接通发布渠道", icon: Send },
    { label: "数据回流", value: "待连接", detail: "当前没有可读取渠道数据", icon: BarChart3 }
  ];
  const importantTask: ImportantTask = {
    title: "连接第一个渠道账号",
    detail: `完成账号连接后，${name}才能承接发布、检查与数据复盘任务。`,
    status: "待连接",
    target: "accounts",
    action: "前往账号管理"
  };
  return { metrics, importantTask };
}

export function AgentHome({
  role,
  workflow,
  contactCount,
  onOpen,
  preference,
  onPersonalize,
  onOpenProduction
}: {
  role: AgentRoleKey;
  workflow: WorkflowController;
  contactCount: number;
  onOpen: (target: AgentHomeTarget) => void;
  preference: RolePreference;
  onPersonalize: () => void;
  onOpenProduction: (item: ContentProduction) => void;
}) {
  const appearance = appearanceFor(role, preference.appearanceId);
  const definition = { ...ROLE_DEFINITIONS[role], name: preference.name, portraitKey: appearance.portraitKey };
  const { snapshot, refresh } = useProductionSnapshot(role === "production");
  const workflowState = workflow.state;
  const workflowLoading = workflow.loading;
  const view = useMemo(() => {
    if (role === "agent") return buildWechatView(workflowState, workflowLoading, contactCount);
    if (role === "production") return buildProductionView(snapshot);
    return buildOperationsView(preference.name);
  }, [contactCount, role, snapshot, workflowLoading, workflowState, preference.name]);
  const status = roleStatus(role, workflowState, workflowLoading, snapshot);
  const RoleIcon = role === "agent" ? UsersRound : role === "production" ? Sparkles : RadioTower;

  return (
    <div className={`agent-home is-${role}`} style={appearanceStyle(appearance)} data-appearance={appearance.id}>
      <AgentAtmosphere />
      <div className="agent-personalize"><button type="button" onClick={onPersonalize}><Palette size={15} />形象与名字</button></div>
      <section className="agent-hero">
        <AgentPortrait key={definition.portraitKey} definition={definition} />

        <div className="agent-introduction">
          <div className="agent-live-status" role="status">
            <span aria-hidden="true" />
            {status}
          </div>
          <h1>你好，我是{definition.name}</h1>
          <h2>{definition.responsibility}，交给我来协助</h2>
          <p>{definition.intro}</p>
          <button type="button" className="agent-primary-action" onClick={() => onOpen(definition.primaryTarget)}>
            <RoleIcon size={18} strokeWidth={2.4} />
            {definition.primaryLabel}
            <ArrowRight size={17} strokeWidth={2.4} />
          </button>
        </div>

        <aside className="agent-phone-connect" aria-label="手机连接状态">
          <div className="agent-phone-heading">
            <Smartphone size={22} strokeWidth={2.2} />
            <div><strong>手机连接</strong><span>开发中</span></div>
          </div>
          <div className="agent-phone-visual" aria-hidden="true">
            <Smartphone size={34} strokeWidth={1.8} />
            <span><Link2 size={16} strokeWidth={2.2} /></span>
          </div>
          <p>正式开放后，可在这里绑定手机微信并向数字员工下达任务。</p>
        </aside>
      </section>

      <MetricStrip metrics={view.metrics} />

      <div className="agent-work-grid">
        <section className="agent-important-task">
          <div className="agent-section-heading">
            <div><ListTodo size={20} strokeWidth={2.3} /><h2>当前最重要任务</h2></div>
            <span>{view.importantTask.status}</span>
          </div>
          <h3>{view.importantTask.title}</h3>
          <p>{view.importantTask.detail}</p>
          {role === "agent" && (
            <div className="agent-development-note">
              <span>客户价值分析</span>
              <strong>开发中</strong>
              <small>后续将综合互动频率、最近互动、客户回应与任务结果。</small>
            </div>
          )}
          {role === "production" && snapshot.error && (
            <button type="button" className="agent-text-action" onClick={() => void refresh()}>重新读取内容数据</button>
          )}
          <button type="button" className="agent-task-action" onClick={() => role === "production" && snapshot.latestTask ? onOpenProduction(snapshot.latestTask) : onOpen(view.importantTask.target)}>
            {view.importantTask.action}<ArrowRight size={16} strokeWidth={2.4} />
          </button>
        </section>

        <section className="agent-capabilities">
          <div className="agent-section-heading">
            <div><Sparkles size={20} strokeWidth={2.3} /><h2>{definition.name}的工作台</h2></div>
            <span>{definition.capabilities.filter((item) => item.available !== false).length} 项可用</span>
          </div>
          <div className="agent-capability-list">
            {definition.capabilities.map((capability) => {
              const Icon = capability.icon;
              const available = capability.available !== false;
              return (
                <button
                  type="button"
                  key={capability.key}
                  disabled={!available}
                  onClick={() => onOpen(capability.key)}
                >
                  <span className="agent-capability-icon"><Icon size={18} strokeWidth={2.2} /></span>
                  <span className="agent-capability-copy"><strong>{capability.label}</strong><small>{capability.description}</small></span>
                  {available ? <ArrowRight size={16} strokeWidth={2.3} /> : <em>待连接</em>}
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
