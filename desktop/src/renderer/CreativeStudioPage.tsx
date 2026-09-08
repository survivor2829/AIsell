import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  Film,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  Video
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ContentProduction, ProductionsApi, ProductionSummary, ProductionView } from "./content-production-types";
import "./CreativeStudioPage.css";
import { ProviderUsageDetails } from "./ProviderUsageDetails";

type ContentResult<T> = {
  ok: boolean;
  data?: T;
  code?: string;
  error?: string;
};

type EngineStatus = {
  state: "unavailable" | "stopped" | "starting" | "ready" | "failed" | string;
  available: boolean;
  version: string;
  capabilities: Record<string, boolean>;
  code: string;
};

type BailianStatus = {
  configured: boolean;
  maskedKey: string;
  apiHost: string;
  secureStorageAvailable: boolean;
  code: string;
};

type TaskStatus = "queued" | "analyzing" | "ready_for_review" | "rendering" | "completed" | "failed" | "cancelled" | "paused";

type ContentTask = {
  taskId: string;
  taskType: string;
  projectId?: string | null;
  runId?: string | null;
  status: TaskStatus;
  resumeFromStatus?: TaskStatus | null;
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt?: string;
  updatedAt?: string;
};

type ContentApi = {
  status: () => Promise<ContentResult<EngineStatus>>;
  productions: ProductionsApi;
  tasks: {
    list: (payload?: { limit?: number }) => Promise<ContentResult<{ items: ContentTask[] }>>;
    pause: (payload: { taskId: string }) => Promise<ContentResult<ContentTask>>;
    resume: (payload: { taskId: string }) => Promise<ContentResult<ContentTask>>;
    cancel: (payload: { taskId: string }) => Promise<ContentResult<ContentTask>>;
  };
  settings: {
    volcengineArkStatus: () => Promise<ContentResult<BailianStatus>>;
  };
  onUpdate?: (callback: (status: EngineStatus) => void) => () => void;
};

type CreativeStudioPageProps = {
  onOpenProduct: () => void;
  onOpenLegacy: (taskId?: string, projectId?: string | null) => void;
  onOpenMaterials: () => void;
  onOpenFinished: () => void;
  onOpenDiagnostics: (context?: { module: string; taskId?: string }) => void;
  onOpenBatch?: (batchId: string) => void;
  onContinueProduct?: (taskId: string, projectId?: string | null, runId?: string | null, sessionId?: string | null) => void;
};

type RefreshMode = "initial" | "manual" | "background";
type TaskAction = "pause" | "resume" | "cancel";

const TASK_TYPE_LABELS: Record<string, string> = {
  asset_import: "素材导入",
  creative_analysis: "素材分析",
  course_generation: "长课程精剪",
  mix_generation: "AI 批量混剪",
  creative_regeneration: "重新生成成片",
  creative_packaging: "动态包装",
  creative_cover: "AI 封面",
  creative_visual_comparison: "三风格对比",
  product_asset_analysis: "商品素材分析",
  product_copy: "商品文案",
  product_voice: "商品配音",
  product_generation: "商品一键成片",
  auto_mix_v2_generation: "一键混剪 V2",
  auto_mix_v2_regeneration: "一键混剪 V2 局部重做",
  guided_auto_mix_analysis: "一键成片素材解析",
  guided_auto_mix_draft: "一键成片 AI 脚本",
  guided_auto_mix_supplemental_image: "一键成片 AI 补图"
};

const TASK_STATUS_LABELS: Record<string, string> = {
  queued: "待开始",
  analyzing: "正在分析",
  ready_for_review: "等待验收",
  rendering: "正在渲染",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  paused: "已暂停",
  draft: "待填写需求", planning: "正在规划", ready: "待确认方案", scripts_ready: "待确认文案",
  ready_for_answers: "待填写需求", ready_for_render: "待确认制作", drafting: "正在生成文案",
  planned: "待制作", synthesizing: "正在配音", verifying_voice: "正在核对配音",
  selecting_music: "正在选择音乐", quality_check: "正在检查成片",
  needs_attention: "需要处理", insufficient_materials: "需要调整素材",
  outcome_unknown: "调用结果待核对", completed_with_errors: "有作品未完成",
  samples_ready: "待确认样片"
};

const RUNNING_STATUSES = new Set(["queued", "analyzing", "rendering"]);
const PRODUCT_TASK_TYPES = new Set([
  "product_asset_analysis",
  "product_copy",
  "product_voice",
  "product_generation",
  "auto_mix_v2_generation",
  "auto_mix_v2_regeneration",
  "guided_auto_mix_analysis",
  "guided_auto_mix_draft",
  "guided_auto_mix_supplemental_image"
]);

function apiForWindow() {
  return (window as unknown as { xiaoxiContent?: ContentApi }).xiaoxiContent;
}

function resultMessage(result: ContentResult<unknown>, fallback: string) {
  return result.error || result.code || fallback;
}

function formatDate(value?: string) {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function taskProgress(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 100)));
}

function taskTitle(task: ContentProduction) {
  return task.title || TASK_TYPE_LABELS[task.taskType] || "内容制作";
}

function engineDescription(status: EngineStatus | null) {
  if (!status) return "尚未读取本地引擎状态";
  if (status.available && status.state === "ready") return status.version ? `运行正常 · ${status.version}` : "运行正常";
  if (status.state === "starting") return "正在启动，请稍候";
  if (status.state === "failed") return "启动失败，可在吐槽中心反馈问题";
  return "暂时不可用，任务列表可能不是最新状态";
}

function taskContext(task: ContentProduction) {
  if (task.batchId) return `批次 ${task.batchId.slice(-6).toUpperCase()}`;
  if (task.kind === "guided_session") return "引导式一键成片";
  return TASK_TYPE_LABELS[task.taskType] || "内容制作";
}

function TaskRow({
  task,
  busy,
  onAction,
  onOpen,
  onFeedback
}: {
  task: ContentProduction;
  busy: boolean;
  onAction: (task: ContentProduction, action: TaskAction) => void;
  onOpen: (task: ContentProduction) => void;
  onFeedback: (task: ContentProduction) => void;
}) {
  const progress = taskProgress(task.progress);
  const canPause = !task.archived && task.state !== "outcome_unknown" && RUNNING_STATUSES.has(task.taskStatus || "");
  const canResume = !task.archived && task.state !== "outcome_unknown" && task.taskStatus === "paused";
  const canCancel = canPause || canResume;
  const failed = task.category === "needs_attention" && Boolean(task.errorCode || task.errorMessage);

  return (
    <article className={`studio-task-row status-${task.state}`}>
      <div className="studio-task-copy">
        <div className="studio-task-title-line">
          <strong>{taskTitle(task)}</strong>
          <span className="studio-task-status">{task.archived ? "已归档" : TASK_STATUS_LABELS[task.state] || "需要处理"}</span>
        </div>
        <div className="studio-task-meta">
          <span>{taskContext(task)}</span>
          <span>{formatDate(task.updatedAt || task.createdAt)}</span>
        </div>
        {failed && (
          <p className="studio-task-error">
            <CircleAlert size={14} aria-hidden="true" />
            <span>{task.errorMessage || task.errorCode || "处理没有完成，可在吐槽中心反馈。"}</span>
          </p>
        )}
        {task.stepCount > 0 && <details className="studio-production-steps">
          <summary>处理记录 · {task.stepCount} 个步骤</summary>
          <ol>{task.steps.map((step) => <li key={step.taskId}>
            <span>{TASK_TYPE_LABELS[step.taskType] || "制作处理"} · {TASK_STATUS_LABELS[step.status] || step.status}</span>
            <time>{formatDate(step.updatedAt)}</time>
            {step.errorMessage && <p>{step.errorMessage}</p>}
          </li>)}</ol>
        </details>}
        {(task.taskId || task.batchId) && <ProviderUsageDetails key={task.batchId || task.taskId} taskId={task.taskId} batchId={task.batchId} />}
      </div>

      <div className="studio-task-progress">
        <div><span>进度</span><strong>{progress}%</strong></div>
        <progress max="100" value={progress} aria-label={`${taskTitle(task)}进度 ${progress}%`} />
      </div>

      <div className="studio-task-actions">
        <button className="studio-button is-quiet" type="button" onClick={() => onOpen(task)}>
          {task.archived ? "查看归档" : task.category === "history" ? "查看结果" : "打开制作"}
        </button>
        {failed && <button className="studio-button is-quiet" type="button" onClick={() => onFeedback(task)}>反馈问题</button>}
        {canPause && (
          <button className="studio-icon-button" type="button" disabled={busy} onClick={() => onAction(task, "pause")} aria-label={`暂停${taskTitle(task)}`} title="暂停任务">
            <Pause size={15} aria-hidden="true" />
          </button>
        )}
        {canResume && (
          <button className="studio-icon-button" type="button" disabled={busy} onClick={() => onAction(task, "resume")} aria-label={`继续${taskTitle(task)}`} title="继续任务">
            <Play size={15} aria-hidden="true" />
          </button>
        )}
        {canCancel && (
          <button className="studio-icon-button is-danger" type="button" disabled={busy} onClick={() => onAction(task, "cancel")} aria-label={`取消${taskTitle(task)}`} title="取消任务">
            <Square size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    </article>
  );
}

export function CreativeStudioPage({
  onOpenProduct,
  onOpenLegacy,
  onOpenMaterials,
  onOpenFinished,
  onOpenDiagnostics,
  onOpenBatch,
  onContinueProduct
}: CreativeStudioPageProps) {
  const [tasks, setTasks] = useState<ContentProduction[]>([]);
  const [summary, setSummary] = useState<ProductionSummary | null>(null);
  const [view, setView] = useState<ProductionView>("pending");
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const pageSize = 20;
  const requestVersion = useRef(0);
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [bailianStatus, setBailianStatus] = useState<BailianStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tasksError, setTasksError] = useState("");
  const [engineError, setEngineError] = useState("");
  const [bailianError, setBailianError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyTaskId, setBusyTaskId] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const loadDashboard = useCallback(async (mode: RefreshMode = "initial") => {
    const version = ++requestVersion.current;
    const content = apiForWindow();
    if (!content?.productions) {
      setTasksError("读取创作任务失败：当前页面没有连接到内容引擎，请重启应用后重试。");
      setEngineError("内容引擎接口不可用");
      setBailianError("火山方舟配置状态读取失败");
      setLoading(false);
      setRefreshing(false);
      return;
    }

    if (mode === "manual") setRefreshing(true);
    const [statusRequest, tasksRequest, bailianRequest] = await Promise.allSettled([
      content.status(),
      content.productions.list({ view, offset, limit: pageSize }),
      content.settings.volcengineArkStatus()
    ]);
    if (version !== requestVersion.current) return;

    if (statusRequest.status === "fulfilled" && statusRequest.value.ok && statusRequest.value.data) {
      setEngineStatus(statusRequest.value.data);
      setEngineError("");
    } else {
      const message = statusRequest.status === "rejected"
        ? statusRequest.reason instanceof Error ? statusRequest.reason.message : "状态请求失败"
        : resultMessage(statusRequest.value, "状态请求失败");
      setEngineError(`内容引擎状态读取失败：${message}`);
    }

    if (tasksRequest.status === "fulfilled" && tasksRequest.value.ok && tasksRequest.value.data) {
      setTasks(tasksRequest.value.data.items || []);
      setSummary(tasksRequest.value.data.summary);
      setTotal(tasksRequest.value.data.total);
      setHasMore(tasksRequest.value.data.hasMore);
      if (offset > 0 && offset >= tasksRequest.value.data.total) setOffset(Math.max(0, Math.ceil(tasksRequest.value.data.total / pageSize - 1) * pageSize));
      setTasksError("");
    } else {
      const message = tasksRequest.status === "rejected"
        ? tasksRequest.reason instanceof Error ? tasksRequest.reason.message : "未知错误"
        : resultMessage(tasksRequest.value, "未知错误");
      setTasksError(`读取创作任务失败：${message}`);
    }

    if (bailianRequest.status === "fulfilled" && bailianRequest.value.ok && bailianRequest.value.data) {
      setBailianStatus(bailianRequest.value.data);
      setBailianError("");
    } else {
      const message = bailianRequest.status === "rejected"
        ? bailianRequest.reason instanceof Error ? bailianRequest.reason.message : "未知错误"
        : resultMessage(bailianRequest.value, "未知错误");
      setBailianError(`火山方舟配置状态读取失败：${message}`);
    }

    setLastUpdatedAt(new Date());
    setLoading(false);
    if (mode === "manual") setRefreshing(false);
  }, [view, offset]);

  useEffect(() => {
    let active = true;
    const content = apiForWindow();
    void loadDashboard("initial");
    const unsubscribe = content?.onUpdate?.((status) => {
      if (active) {
        setEngineStatus(status);
        setEngineError("");
      }
    });
    return () => {
      active = false;
      requestVersion.current += 1;
      unsubscribe?.();
    };
  }, [loadDashboard]);

  useEffect(() => {
    if (!summary?.active) return undefined;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      await loadDashboard("background");
      if (active) timer = window.setTimeout(() => void poll(), 4_000);
    };
    timer = window.setTimeout(() => void poll(), 4_000);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [summary?.active, loadDashboard]);

  const runTaskAction = useCallback(async (task: ContentProduction, action: TaskAction) => {
    const content = apiForWindow();
    if (!content || !task.taskId) {
      setActionError("内容引擎接口不可用，无法操作任务。");
      return;
    }
    setBusyTaskId(task.taskId);
    setActionError("");
    try {
      let result: ContentResult<ContentTask>;
      if (action === "pause") result = await content.tasks.pause({ taskId: task.taskId });
      else if (action === "resume") result = await content.tasks.resume({ taskId: task.taskId });
      else result = await content.tasks.cancel({ taskId: task.taskId });
      if (!result.ok || !result.data) {
        setActionError(resultMessage(result, "任务操作失败，请稍后重试。"));
        return;
      }
      void loadDashboard("background");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "任务操作失败，请稍后重试。");
    } finally {
      setBusyTaskId("");
    }
  }, [loadDashboard]);

  const openTask = useCallback((task: ContentProduction) => {
    if (task.batchId && onOpenBatch) {
      onOpenBatch(task.batchId);
      return;
    }
    if (task.taskType === "asset_import") {
      onOpenMaterials();
      return;
    }
    if (PRODUCT_TASK_TYPES.has(task.taskType)) {
      if (onContinueProduct && task.taskId) {
        onContinueProduct(task.taskId, task.projectId, task.runId, task.sessionId);
      } else if (task.state === "completed") {
        onOpenFinished();
      } else {
        onOpenProduct();
      }
      return;
    }
    onOpenLegacy(task.taskId || undefined, task.projectId);
  }, [onContinueProduct, onOpenBatch, onOpenFinished, onOpenLegacy, onOpenMaterials, onOpenProduct]);

  const hasAnyTasks = tasks.length > 0;
  const engineReady = Boolean(engineStatus?.available && engineStatus.state === "ready");
  const bailianReady = Boolean(bailianStatus?.configured && bailianStatus.secureStorageAvailable);

  return (
    <section className="creative-studio-page">
      <header className="studio-header">
        <div>
          <h1>视频创作中心</h1>
          <p>开始新任务、查看真实进度，失败时直接找到原因。</p>
        </div>
        <div className="studio-header-actions">
          <button className="studio-button is-quiet" type="button" onClick={onOpenFinished}>
            <Film size={16} aria-hidden="true" />全部成片
          </button>
          <button className="studio-button is-quiet" type="button" onClick={() => onOpenDiagnostics({ module: "content_engine" })}>
            <CircleAlert size={16} aria-hidden="true" />吐槽中心
          </button>
        </div>
      </header>

      <section className="studio-launch-panel" aria-labelledby="studio-launch-title">
        <div className="studio-section-heading">
          <div>
            <h2 id="studio-launch-title">开始创作</h2>
            <p>选择最接近你当前目标的入口。</p>
          </div>
        </div>
        <div className="studio-launch-list">
          <div className="studio-launch-row">
            <span className="studio-launch-icon"><Sparkles size={20} aria-hidden="true" /></span>
            <div><strong>商品一键成片</strong><p>用图片和视频生成商品展示短片。</p></div>
            <button className="studio-button is-primary" type="button" onClick={onOpenProduct}>新建任务<ArrowRight size={15} aria-hidden="true" /></button>
          </div>
          <div className="studio-launch-row">
            <span className="studio-launch-icon"><Video size={20} aria-hidden="true" /></span>
            <div><strong>课程精剪 / 批量混剪</strong><p>从长素材中选段，或组合多条现场素材。</p></div>
            <button className="studio-button is-secondary" type="button" onClick={() => onOpenLegacy()}>打开工作台<ArrowRight size={15} aria-hidden="true" /></button>
          </div>
          <div className="studio-launch-row">
            <span className="studio-launch-icon"><FolderOpen size={20} aria-hidden="true" /></span>
            <div><strong>素材仓库</strong><p>添加、分析和整理本地图片与视频。</p></div>
            <button className="studio-button is-secondary" type="button" onClick={onOpenMaterials}>管理素材<ArrowRight size={15} aria-hidden="true" /></button>
          </div>
        </div>
      </section>

      <div className="studio-dashboard-grid">
        <main className="studio-task-panel" aria-busy={loading || refreshing}>
          <div className="studio-section-heading">
            <div>
              <h2>制作任务</h2>
              <p>{lastUpdatedAt ? `更新于 ${formatDate(lastUpdatedAt.toISOString())}` : "正在读取任务状态"}</p>
            </div>
            <button className="studio-icon-button" type="button" disabled={refreshing} onClick={() => void loadDashboard("manual")} aria-label="刷新创作任务" title="刷新">
              <RefreshCw size={16} className={refreshing ? "is-spinning" : ""} aria-hidden="true" />
            </button>
          </div>

          <nav className="studio-production-tabs" aria-label="制作任务筛选">
            {([
              ["pending", "待处理", summary?.pending], ["active", "进行中", summary?.active],
              ["needs_attention", "需要处理", summary?.needsAttention],
              ["history", "历史", summary?.history], ["archived", "已归档", summary?.archived]
            ] as const).map(([key, label, count]) => <button key={key} type="button" aria-current={view === key ? "page" : undefined}
              onClick={() => { if (view === key && offset === 0) return; setView(key); setOffset(0); setLoading(true); }}>
              {label}<span>{count ?? "—"}</span>
            </button>)}
          </nav>

          <div aria-live="polite">
            {tasksError && (
              <div className="studio-message is-error">
                <CircleAlert size={17} aria-hidden="true" />
                <div><strong>任务列表暂时不可用</strong><p>{tasksError}</p></div>
                <button className="studio-button is-quiet" type="button" onClick={() => void loadDashboard("manual")}>重新加载</button>
              </div>
            )}
            {actionError && (
              <div className="studio-message is-error">
                <CircleAlert size={17} aria-hidden="true" />
                <div><strong>任务操作没有完成</strong><p>{actionError}</p></div>
              </div>
            )}
          </div>

          {loading ? (
            <div className="studio-task-loading" aria-label="正在加载创作任务">
              {[0, 1, 2].map((item) => <div className="studio-task-placeholder" key={item}><span /><span /><span /></div>)}
            </div>
          ) : !tasksError && !hasAnyTasks ? (
            <div className="studio-empty-state">
              <Video size={24} aria-hidden="true" />
              <strong>{view === "pending" ? "当前没有待处理的制作" : "这个分类下暂时没有制作记录"}</strong>
              <p>同一次制作的分析、脚本和审核记录收在详情中；素材和成片可在对应入口查看。</p>
              <button className="studio-button is-primary" type="button" onClick={onOpenProduct}>新建商品成片</button>
            </div>
          ) : (
            <>
              <section className="studio-task-group" aria-label="制作记录">
                <div className="studio-task-group-heading"><span>共 {total} 项制作</span><span>内部处理步骤已合并</span></div>
                {tasks.map((task) => <TaskRow key={task.productionId} task={task} busy={busyTaskId === task.taskId}
                  onAction={runTaskAction} onOpen={openTask}
                  onFeedback={(item) => onOpenDiagnostics({ module: "content_engine", taskId: item.taskId || undefined })} />)}
              </section>
            </>
          )}
          {(offset > 0 || hasMore) && <div className="studio-production-pagination">
            <button type="button" className="studio-button is-quiet" disabled={offset === 0 || loading} onClick={() => { setOffset(Math.max(0, offset - pageSize)); setLoading(true); }}>上一页</button>
            <span>第 {Math.floor(offset / pageSize) + 1} 页 · 共 {total} 项</span>
            <button type="button" className="studio-button is-quiet" disabled={!hasMore || loading} onClick={() => { setOffset(offset + pageSize); setLoading(true); }}>下一页</button>
          </div>}
        </main>

        <aside className="studio-system-panel" aria-labelledby="studio-system-title">
          <div className="studio-section-heading">
            <div><h2 id="studio-system-title">系统状态</h2><p>生成前需要确认的两项能力。</p></div>
          </div>

          <div className="studio-system-list" aria-live="polite">
            <div className={`studio-system-row ${engineReady ? "is-ready" : "is-warning"}`}>
              <span className="studio-system-icon">{engineReady ? <CircleCheck size={18} /> : engineStatus?.state === "starting" ? <LoaderCircle size={18} /> : <CircleAlert size={18} />}</span>
              <div><strong>本地内容引擎</strong><p>{engineError || engineDescription(engineStatus)}</p></div>
              {!engineReady && <button type="button" onClick={() => onOpenDiagnostics({ module: "content_engine" })}>反馈问题</button>}
            </div>
            <div className={`studio-system-row ${bailianReady ? "is-ready" : "is-warning"}`}>
              <span className="studio-system-icon">{bailianReady ? <CircleCheck size={18} /> : <KeyRound size={18} />}</span>
              <div>
                <strong>火山方舟 · 画面与文案</strong>
                <p>{bailianError || (bailianReady
                  ? `已配置 ${bailianStatus?.maskedKey || "API Key"}`
                  : bailianStatus?.configured
                    ? "API Key 已配置，但 Windows 安全存储当前不可用。"
                    : "未配置：文案和语义分析暂不可用，本地素材仍可管理。")}</p>
              </div>
            </div>
          </div>

          <div className="studio-system-note">
            <strong>状态说明</strong>
            <p>这里展示的是应用当前返回的真实状态。某项能力失败时，不会继续显示为“已完成”。</p>
          </div>
        </aside>
      </div>
    </section>
  );
}
