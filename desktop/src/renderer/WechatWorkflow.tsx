import { ArrowLeft, ArrowRight, CalendarClock, Check, ChevronRight, Clock3, ImagePlus, ListTodo, Maximize2, Pause, Pencil, Play, Plus, Repeat2, Send, ThumbsUp, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { momentsProgressLabel } from "./MomentsCampaignPanel";
import "./WechatWorkflow.css";

export type WorkflowTaskType = "touch" | "publish" | "interact";
export type WorkflowPayload = {
  contactIds?: string[];
  script?: string;
  imageIds?: string[];
  link?: string;
  content?: string;
  selectionId?: string;
  sourceTaskId?: string;
  maxPosts?: number;
  likeEnabled?: boolean;
  commentEnabled?: boolean;
  commentGuidance?: string;
};
export type WorkflowMedia = {
  media_kind: string;
  media_count: number;
  files: Array<{ name: string; size: number; kind: "image" | "video" }>;
};
type TouchImage = { id: string; name: string; size?: number; preview: string };
export type WorkflowTaskInput = {
  type: WorkflowTaskType;
  title?: string;
  scheduledAt?: string | null;
  repeat?: "daily" | null;
  startTime?: string | null;
  payload: WorkflowPayload;
};
export type WorkflowTask = Omit<WorkflowTaskInput, "payload"> & {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "cancelled" | "needs_attention" | "missed";
  createdAt: string;
  progress: { done: number; total: number; liked?: number; commented?: number; skipped?: number; alreadyLiked?: number };
  error?: string;
  lastCompletedDate?: string;
  media?: WorkflowMedia;
  images?: TouchImage[];
  imageError?: string;
  payload?: WorkflowPayload;
  accountMismatch?: boolean;
  canRetry?: boolean;
};
export type WorkflowState = {
  enabled: boolean;
  phase: string;
  currentTaskId: string | null;
  nextTaskId: string | null;
  lastTaskId?: string | null;
  replyEnabled?: boolean;
  tasks: WorkflowTask[];
  recipients: Array<{ id: string; label: string }>;
  error: string;
  replyStatus: string;
  replyError?: string;
  contactSync?: { running: boolean; stage: string; contactCount: number; error: string } | null;
  momentsProgress?: { stage: string; scanned: number; scrolled: number; liked: number; commented: number; skipped?: number; alreadyLiked?: number; skipReason?: string } | null;
};
export type WorkflowResult = { ok: boolean; state?: WorkflowState; task?: WorkflowTask; error?: string };
export type WorkflowContact = { id: string; name: string; remark?: string; nickname?: string; wechatId?: string; allowed: boolean };

declare global {
  interface Window {
    xiaoxiWorkflow?: {
      status: () => Promise<WorkflowResult>;
      start: () => Promise<WorkflowResult>;
      pause: () => Promise<WorkflowResult>;
      chooseTouchImages: () => Promise<{ ok: boolean; canceled?: boolean; images?: TouchImage[]; error?: string }>;
      showFloating: () => Promise<WorkflowResult>;
      showMain: (intent?: { view: WorkflowView }) => Promise<WorkflowResult>;
      onNavigate?: (callback: (intent: { view: WorkflowView }) => void) => () => void;
      addTask: (task: WorkflowTaskInput) => Promise<WorkflowResult>;
      updateTask: (task: WorkflowTaskInput & { id: string }) => Promise<WorkflowResult>;
      cancelTask: (id: string) => Promise<WorkflowResult>;
      deleteTasks: (ids: string[], unsuccessfulOnly?: boolean) => Promise<WorkflowResult>;
      retryTask: (id: string) => Promise<WorkflowResult>;
      getTask: (id: string) => Promise<WorkflowResult>;
      removeRecipient: (id: string) => Promise<WorkflowResult>;
      addRecipients: (contactIds: string[]) => Promise<WorkflowResult>;
      setReplyEnabled: (enabled: boolean) => Promise<WorkflowResult>;
      onUpdate: (callback: (result: WorkflowResult) => void) => () => void;
    };
  }
}

const EMPTY_WORKFLOW: WorkflowState = { enabled: false, phase: "idle", currentTaskId: null, nextTaskId: null, tasks: [], recipients: [], error: "", replyStatus: "stopped" };
const TASK_LABELS: Record<WorkflowTaskType, string> = { touch: "精准触达", publish: "发朋友圈", interact: "朋友圈互动" };
const TASK_ICONS = { touch: Send, publish: ImagePlus, interact: ThumbsUp };
const TASK_STATUS: Record<WorkflowTask["status"], string> = { pending: "待执行", running: "进行中", completed: "已完成", cancelled: "已取消", needs_attention: "需处理", missed: "已错过" };
const SYNC_STAGE_LABELS: Record<string, string> = { restarting_wechat: "正在重启微信", waiting_login_window: "请在微信完成登录", waiting_weixin_process: "等待微信启动", waiting_weixin_module: "等待微信加载" };

export function useWechatWorkflow() {
  const [state, setState] = useState<WorkflowState>(EMPTY_WORKFLOW);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const runningCall = useRef(false);
  const apply = useCallback((result: WorkflowResult) => {
    if (result.state) setState(result.state);
    if (!result.ok) setError(result.error || "操作未完成，请重试。");
  }, []);

  useEffect(() => {
    const api = window.xiaoxiWorkflow;
    if (!api) {
      setLoading(false);
      setError("当前程序未连接微信拓客服务，请重新打开应用。");
      return;
    }
    let disposed = false;
    let receivedUpdate = false;
    const unsubscribe = api.onUpdate((result) => {
      if (disposed) return;
      receivedUpdate = true;
      apply(result);
      setLoading(false);
    });
    void api.status().then((result) => {
      if (!disposed && !receivedUpdate) apply(result);
    }).catch(() => {
      if (!disposed) setError("读取今日计划失败，请重新打开应用。");
    }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; unsubscribe?.(); };
  }, [apply]);

  const run = useCallback(async (operation: () => Promise<WorkflowResult>): Promise<WorkflowResult | null> => {
    if (runningCall.current) return null;
    runningCall.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await operation();
      apply(result);
      return result;
    } catch {
      setError("操作未完成，请查看当前状态后再试。");
      return null;
    } finally {
      runningCall.current = false;
      setBusy(false);
    }
  }, [apply]);

  return { state, loading, busy, error, run };
}

export type WorkflowController = ReturnType<typeof useWechatWorkflow>;

export function workflowStatusText(state: WorkflowState) {
  if (state.contactSync?.running) return "正在同步联系人";
  if (state.phase === "pausing") return "正在暂停";
  if (state.phase === "completed") return "本轮任务已完成";
  if (state.phase === "needs_attention") return "本轮任务未完成";
  if (state.phase === "idle") return hasRunnablePlan(state) ? "计划已就绪，等待启动" : "本轮没有待执行任务";
  if (!state.enabled) return "已暂停";
  if (state.phase === "waiting_for_idle") return "等待电脑空闲";
  const task = state.tasks.find((item) => item.id === state.currentTaskId);
  if (state.replyError && !task) return "自动回复需处理";
  if (state.phase === "replying") return state.replyStatus || "正在检查客户消息";
  if (state.phase === "listening") return state.replyStatus || "监听新消息";
  if (task) return `正在${TASK_LABELS[task.type]}`;
  if (state.phase === "scheduled") return "等待已安排的执行时间";
  if (state.phase === "queued") return "准备执行下一项";
  return state.replyEnabled !== false && state.recipients.length ? "监听新消息" : "正在整理本轮结果";
}

function taskErrorText(reason: string) {
  const label = momentsProgressLabel(reason, reason);
  if (label !== reason) return label;
  return /^[a-z][a-z0-9_:-]+$/i.test(reason) ? `任务未完成，请查看日志诊断（${reason}）` : reason;
}

function contactLabel(contact: WorkflowContact) {
  return contact.remark?.trim() || contact.nickname?.trim() || contact.name || contact.wechatId || "未命名联系人";
}

function localDateTime(iso?: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatTaskTime(task: WorkflowTask) {
  if (task.repeat === "daily") return task.startTime ? `每天 ${task.startTime}` : "每天一次";
  if (!task.scheduledAt) return "按顺序执行";
  return new Date(task.scheduledAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function hasRunnablePlan(state: WorkflowState) {
  return state.tasks.some((task) => task.status === "pending" && !task.accountMismatch)
    || (state.replyEnabled !== false && state.recipients.length > 0);
}

export type WorkflowView = "start" | "history" | "tasks";
export function workflowEntry(state: WorkflowState): "active" | "attention" | "ready" | "history" | "empty" {
  if (state.enabled || state.contactSync?.running || state.phase === "pausing") return "active";
  if (hasRunnablePlan(state)) return "ready";
  if (state.phase === "needs_attention" || state.replyError || state.tasks.some(task => (task.status === "pending" && task.accountMismatch) || ["needs_attention", "missed"].includes(task.status))) return "attention";
  return state.tasks.length ? "history" : "empty";
}
const ENTRY_LABEL = { active: "查看进度", attention: "查看待处理", ready: "启动程序", history: "查看记录", empty: "带我开始" };
function entryView(entry: ReturnType<typeof workflowEntry>): WorkflowView { return entry === "empty" ? "start" : entry === "history" ? "history" : "tasks"; }

export function WorkflowToggle({ workflow, compact = false, onNavigate }: { workflow: WorkflowController; compact?: boolean; onNavigate?: (view: WorkflowView) => void }) {
  const { state, busy, loading, run } = workflow;
  const api = window.xiaoxiWorkflow;
  const entry = workflowEntry(state);
  const navigate = () => onNavigate ? onNavigate(entryView(entry)) : api && void run(() => api.showMain({ view: entryView(entry) }));
  return <button type="button" data-xiaoxi-workflow-start={entry === "ready" ? "true" : undefined}
    className={`${state.enabled ? "secondary-button" : "primary-button"} workflow-toggle`}
    disabled={busy || loading || state.phase === "pausing" || !api}
    onClick={() => { if (!api) return; if (entry !== "active" && entry !== "ready") { navigate(); return; } void run(() => state.contactSync?.running ? api.showFloating() : state.enabled ? api.pause() : api.start()); }}>
    {state.enabled ? <Pause size={16} /> : entry === "ready" ? <Play size={16} /> : <ChevronRight size={16} />}
    {busy || state.phase === "pausing" ? "处理中…" : state.contactSync?.running ? "查看同步进度" : state.enabled ? (compact ? "暂停" : "暂停程序") : ENTRY_LABEL[entry]}
  </button>;
}

export function WorkflowLauncher({ workflow, onNavigate }: { workflow: WorkflowController; onNavigate?: (view: WorkflowView) => void }) {
  const { state, busy, loading, run } = workflow;
  const api = window.xiaoxiWorkflow;
  const entry = workflowEntry(state);
  return <button type="button" data-xiaoxi-workflow-start={entry === "ready" ? "true" : undefined}
    className={`launch-button workflow-launcher${entry === "active" ? " is-active" : ""}`} aria-label={entry === "active" ? `微信拓客：${workflowStatusText(state)}，查看进度` : ENTRY_LABEL[entry]}
    disabled={busy || loading || state.phase === "pausing" || !api}
    onClick={() => { if (!api) return; if (entry === "active" || entry === "ready") { void run(() => entry === "active" ? api.showFloating() : api.start()); } else if (onNavigate) onNavigate(entryView(entry)); else void run(() => api.showMain({ view: entryView(entry) })); }}
  >{busy ? "处理中" : entry === "active" ? <>微信拓客 · {workflowStatusText(state)}<ChevronRight size={14} /></> : ENTRY_LABEL[entry]}</button>;
}

export type EditorRequest = { type: WorkflowTaskType; task?: WorkflowTask; repeat?: boolean };
type WorkflowPageProps = {
  workflow: WorkflowController;
  contacts: WorkflowContact[];
  mode?: "home" | "touch" | "moments";
  editorRequest?: EditorRequest | null;
  view?: WorkflowView;
  onNavigate?: (view: WorkflowView) => void;
  syncBusy?: boolean;
  syncError?: string;
  onSync: () => void;
  onOpenSettings: (key: "reply" | "expert" | "contact-sync") => void;
};

export function WechatWorkflowPage({ workflow, contacts, mode = "home", editorRequest, view, onNavigate, syncBusy, syncError, onSync, onOpenSettings }: WorkflowPageProps) {
  const [editor, setEditor] = useState<EditorRequest | null>(null);
  useEffect(() => { if (editorRequest) setEditor(editorRequest); }, [editorRequest]);
  const [notice, setNotice] = useState("");
  const [deletion, setDeletion] = useState<{ ids: string[]; bulk: boolean } | null>(null);
  const editorAnchor = useRef<HTMLDivElement>(null);
  const { state, loading, busy, error, run } = workflow;
  const api = window.xiaoxiWorkflow;
  const availableTypes: WorkflowTaskType[] = mode === "touch" ? ["touch"] : mode === "moments" ? ["publish", "interact"] : ["touch", "publish", "interact"];
  const tasks = state.tasks.filter((task) => availableTypes.includes(task.type));
  const activeTasks = tasks.filter((task) => !["completed", "cancelled"].includes(task.status));
  const history = tasks.filter((task) => ["completed", "cancelled"].includes(task.status)).reverse();
  const unsuccessful = tasks.filter((task) => ["needs_attention", "cancelled", "missed"].includes(task.status));
  const current = state.tasks.find((task) => task.id === state.currentTaskId);
  const next = state.tasks.find((task) => task.id === state.nextTaskId);
  const waitingForSchedule = state.tasks.some((task) => task.status === "pending" && !task.accountMismatch && (task.repeat === "daily" || Boolean(task.scheduledAt && Date.parse(task.scheduledAt) > Date.now())));
  const title = mode === "home" ? "今日计划" : mode === "touch" ? "精准触达" : "朋友圈运营";
  const planLocked = state.enabled || state.phase === "pausing";
  const runningDetail = state.phase === "completed" ? "本轮已结束，可查看下方结果"
    : state.phase === "needs_attention" ? "仍有任务未完成，原因见任务详情"
      : !state.enabled ? "启动前安排好任务；运行中需先暂停再调整"
        : next ? `下一项：${next.title}`
          : current ? "正在执行本轮已安排任务"
            : waitingForSchedule ? "到达已安排的时间后继续执行"
              : "自动回复已开启，正在监听新消息";

  useEffect(() => {
    if (editor) editorAnchor.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [editor]);

  useEffect(() => { setNotice(""); }, [state.enabled]);
  useEffect(() => { if (state.enabled) setDeletion(null); }, [state.enabled]);

  const confirmDelete = async () => {
    if (!api || !deletion) return;
    const result = await run(() => api.deleteTasks(deletion.ids, deletion.bulk));
    if (result?.ok) {
      if (editor?.task && deletion.ids.includes(editor.task.id)) setEditor(null);
      setNotice(`已删除 ${deletion.ids.length} 项任务记录。`);
      setDeletion(null);
    }
  };
  const deletePrompt = (bulk: boolean) => <div className="workflow-delete-prompt" role="group" aria-label="确认删除任务">
    <div><strong>{bulk ? `删除这 ${deletion?.ids.length} 项未完成任务记录？成功记录会保留。` : "删除这项任务记录？后续安排也会停止。"}</strong><p>仅从计划列表移除，不撤回已发送内容，也不移除接待客户。</p></div>
    <div className="workflow-row-actions"><button type="button" className="text-button" data-xiaoxi-workflow-save disabled={busy || planLocked} onClick={() => void confirmDelete()}><Trash2 size={14} />确认删除</button><button type="button" className="text-button workflow-muted-action" disabled={busy} onClick={() => setDeletion(null)}>保留</button></div>
  </div>;

  const openExisting = async (task: WorkflowTask, repeat: boolean) => {
    if (!api) return;
    const result = await run(() => api.getTask(task.id));
    if (result?.ok && result.task) {
      setNotice("");
      setEditor({ type: task.type, task: result.task, repeat });
    }
  };

  const taskRow = (task: WorkflowTask) => {
    const Icon = TASK_ICONS[task.type];
    const isCurrent = task.id === state.currentTaskId;
    const completedDaily = task.status === "completed" && task.repeat === "daily";
    const canEdit = !planLocked && (completedDaily || ((task.status === "pending" || task.status === "missed") && !task.progress?.done));
    const canCancel = !planLocked && (completedDaily || ["pending", "missed", "needs_attention"].includes(task.status));
    return <li className={`workflow-task-row ${isCurrent ? "is-current" : ""}`} key={task.id}>
      <span className="workflow-task-icon"><Icon size={19} /></span>
      <div className="workflow-task-copy">
        <div className="workflow-task-title"><strong>{task.title || TASK_LABELS[task.type]}</strong><span className={`workflow-task-status is-${task.status}`}>{TASK_STATUS[task.status]}</span></div>
        <div className="workflow-task-meta"><span><Clock3 size={13} />{formatTaskTime(task)}</span>{task.progress?.total > 0 && <span>{task.progress.done}/{task.progress.total} {task.type === "touch" ? "人" : "条"}</span>}{task.repeat === "daily" && task.lastCompletedDate && <span>最近完成：{task.lastCompletedDate}</span>}</div>
        {task.type === "interact" && task.progress.liked !== undefined && <p className="workflow-small-note">累计点赞 {task.progress.liked} · 评论 {task.progress.commented || 0} · 跳过评论 {task.progress.skipped || 0}</p>}
        {task.error && <p className="workflow-task-error">{taskErrorText(task.error)}</p>}
        {task.status === "needs_attention" && <p className="workflow-small-note">{task.canRetry ? task.type === "touch" ? "可从未发送的内容继续，已发出的文字和图片不会重发。" : "尚未执行互动，可重新加入计划，再点击启动。" : "不能直接重试，请先核对微信中的实际结果。"}</p>}
        {task.accountMismatch && <p className="workflow-task-error">微信账号已切换，需切回原账号后执行。</p>}
        {task.status === "missed" && <p className="workflow-task-error">这是往日未执行的任务，请修改时间后加入，或取消。</p>}
      </div>
      <div className="workflow-row-actions">
        {task.canRetry && <button className="text-button" data-xiaoxi-workflow-save disabled={busy || planLocked} onClick={() => api && void run(() => api.retryTask(task.id))}><Repeat2 size={14} />重新加入</button>}
        {canEdit && <button className="text-button" disabled={busy} onClick={() => void openExisting(task, false)}><Pencil size={14} />{completedDaily ? "编辑后续安排" : "编辑"}</button>}
        {task.status === "completed" && !completedDaily && <button className="text-button" disabled={busy || planLocked} onClick={() => void openExisting(task, true)}><Repeat2 size={14} />再做一次</button>}
        {canCancel && <button className="text-button workflow-muted-action" disabled={busy} onClick={() => api && void run(() => api.cancelTask(task.id))}>{completedDaily ? "取消后续安排" : "取消"}</button>}
        {task.status !== "running" && <button type="button" className="text-button workflow-muted-action" disabled={busy || planLocked} aria-label={`删除${task.title}任务记录`} onClick={() => setDeletion({ ids: [task.id], bulk: false })}><Trash2 size={14} />删除</button>}
      </div>
      {deletion && !deletion.bulk && deletion.ids[0] === task.id && deletePrompt(false)}
    </li>;
  };

  return <section className="page workflow-page">
    <div className="page-head workflow-page-head">
      <div><h1>{title}</h1><p>{mode === "home" ? "安排好待办，启动一次。先完成当前可执行任务，空闲时自动接待客户。" : mode === "touch" ? "选好联系人和话术，加入计划后按顺序执行。" : "准备发布内容或安排互动，系统会接着完成下一项。"}</p></div>
      <WorkflowToggle workflow={workflow} onNavigate={onNavigate} />
    </div>

    <div className={`workflow-running-line ${state.enabled ? "is-on" : ""}`} role="status">
      <span className="workflow-state-dot" />
      <strong>{loading ? "读取计划中…" : workflowStatusText(state)}</strong>
      <span>{runningDetail}</span>
      {state.enabled && <button className="text-button" disabled={busy} onClick={() => api && void run(() => api.showFloating())}>查看进度<ChevronRight size={14} /></button>}
    </div>

    {(error || state.error) && <div className="workflow-alert" role="alert">{error || state.error}</div>}
    {state.replyError && <div className="workflow-alert" role="alert">自动回复需处理：{state.replyError}</div>}
    {mode !== "touch" && <WorkflowPublishRecovery workflow={workflow} />}
    {notice && <div className="workflow-notice" role="status"><Check size={16} />{notice}</div>}

    <div className="workflow-add-row">
      <span>添加任务</span>
      {availableTypes.map((type) => <button type="button" className="secondary-button" key={type} onClick={() => { setNotice(""); setEditor({ type }); }} disabled={busy || planLocked}><Plus size={15} />{TASK_LABELS[type]}</button>)}
    </div>
    <label className="workflow-check"><input type="checkbox" checked={state.replyEnabled !== false} disabled={busy || planLocked} onChange={(event) => api && void run(() => api.setReplyEnabled(event.target.checked))} />同时开启自动回复（监听接待范围内的新消息）</label>
    {planLocked && <p className="workflow-small-note">运行中不能增删任务或修改接待范围，请先暂停。</p>}

    <div ref={editorAnchor} className="workflow-editor-anchor">
      {editor && <WorkflowTaskEditor
        key={`${editor.type}:${editor.task?.id || "new"}:${editor.repeat ? "repeat" : "edit"}`}
        request={editor}
        workflow={workflow}
        contacts={contacts}
        syncBusy={syncBusy}
        syncError={syncError}
        onSync={onSync}
        onCancel={() => setEditor(null)}
        onSaved={() => { setEditor(null); setNotice("已加入计划。"); }}
      />}
    </div>

    <div className="workflow-list-head"><h2>{mode === "home" ? "待办任务" : "已加入计划"}</h2><span>{activeTasks.length} 项</span>{unsuccessful.length > 0 && <button type="button" className="text-button workflow-cleanup" disabled={busy || planLocked} onClick={() => setDeletion({ ids: unsuccessful.map((task) => task.id), bulk: true })}><Trash2 size={14} />清理失败和已取消任务（{unsuccessful.length}）</button>}</div>
    {deletion?.bulk && deletePrompt(true)}
    {loading ? <div className="workflow-loading" aria-label="正在读取任务"><span /><span /><span /></div> : activeTasks.length ? <ul className="workflow-task-list">{activeTasks.map(taskRow)}</ul> : <div className="workflow-empty"><ListTodo size={25} /><div><strong>还没有待办任务</strong><p>{state.recipients.length ? "有客户消息时继续自动回复；需要触达、发布或互动时，在上方添加。" : "从上方添加一项任务。任务结束后，系统会持续接待已加入范围的客户。"}</p></div></div>}

    {history.length > 0 && <details open={view === "history" ? true : undefined} className="workflow-details workflow-history"><summary>已完成与已取消 <span>{history.length} 项</span></summary><ul className="workflow-task-list">{history.map(taskRow)}</ul></details>}

    {mode === "home" && <footer className="workflow-settings-links"><span>基础设置</span><button className="text-button" onClick={() => onOpenSettings("expert")}>你的AI专家<ChevronRight size={14} /></button><button className="text-button" onClick={() => onOpenSettings("contact-sync")}>同步联系人<ChevronRight size={14} /></button><button className="text-button" onClick={() => onOpenSettings("reply")}>自动回复 · {state.recipients.length} 位客户<ChevronRight size={14} /></button></footer>}
  </section>;
}

function WorkflowTaskEditor({ request, workflow, contacts, syncBusy, syncError, onSync, onCancel, onSaved }: {
  request: EditorRequest;
  workflow: WorkflowController;
  contacts: WorkflowContact[];
  syncBusy?: boolean;
  syncError?: string;
  onSync: () => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { type, task, repeat: duplicate } = request;
  const payload = task?.payload || {};
  const [title, setTitle] = useState(task?.title || "");
  const [script, setScript] = useState(payload.script || "");
  const [images, setImages] = useState<TouchImage[]>(task?.images || []);
  const [link, setLink] = useState(payload.link || "");
  const [content, setContent] = useState(payload.content || "");
  const [selectedIds, setSelectedIds] = useState<string[]>(payload.contactIds || []);
  const [query, setQuery] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(60);
  const [media, setMedia] = useState<(WorkflowMedia & { selection_id?: string }) | null>(task?.media || null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [daily, setDaily] = useState(task ? task.repeat === "daily" && !duplicate : type === "interact");
  const [scheduled, setScheduled] = useState(Boolean(!duplicate && (task?.scheduledAt || task?.startTime)));
  const [scheduledAt, setScheduledAt] = useState(duplicate ? "" : localDateTime(task?.scheduledAt));
  const [startTime, setStartTime] = useState(task?.startTime || "");
  const [maxPosts, setMaxPosts] = useState(payload.maxPosts || 10);
  const [likeEnabled, setLikeEnabled] = useState(payload.likeEnabled !== false);
  const [commentEnabled, setCommentEnabled] = useState(payload.commentEnabled === true);
  const [commentGuidance, setCommentGuidance] = useState(payload.commentGuidance || "");
  const [error, setError] = useState(task?.imageError || "");
  const { busy, state, run } = workflow;
  const locked = busy || mediaBusy || state.enabled || state.phase === "pausing";
  const eligible = useMemo(() => contacts.filter((contact) => contact.allowed), [contacts]);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return eligible.filter((contact) => !keyword || [contact.name, contact.remark, contact.nickname, contact.wechatId].some((value) => value?.toLocaleLowerCase().includes(keyword)));
  }, [eligible, query]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const missingCount = selectedIds.filter((id) => !eligible.some((contact) => contact.id === id)).length;
  const formTitle = `${task && !duplicate ? "编辑" : "添加"}${TASK_LABELS[type]}`;

  const chooseMedia = async () => {
    const api = (window as Window & { xiaoxiMomentsPublish?: { chooseMedia: () => Promise<{ ok: boolean; reason?: string; selection?: WorkflowMedia & { selection_id: string } }> } }).xiaoxiMomentsPublish;
    if (!api) { setError("素材选择服务未连接，请重新打开程序。"); return; }
    setMediaBusy(true);
    setError("");
    try {
      const result = await api.chooseMedia();
      if (result.ok && result.selection) setMedia(result.selection);
      else if (result.reason && !/cancel/i.test(result.reason)) setError("未能选择素材，请选择 1–9 张图片或 1 个视频后重试。");
    } catch { setError("选择素材失败，请重试。"); }
    finally { setMediaBusy(false); }
  };

  const chooseTouchImages = async () => {
    if (!window.xiaoxiWorkflow?.chooseTouchImages || locked) return;
    setMediaBusy(true);
    setError("");
    try {
      const result = await window.xiaoxiWorkflow.chooseTouchImages();
      if (result.canceled) return;
      if (!result.ok || !result.images) { setError(result.error || "图片未能添加，请重试。"); return; }
      const combined = [...new Map([...images, ...result.images].map((image) => [image.id, image])).values()];
      if (combined.length > 9) { setError("每项触达最多发送 9 张图片，请移除部分图片后再添加。"); return; }
      setImages(combined);
    } catch { setError("图片未能添加，请重试。"); }
    finally { setMediaBusy(false); }
  };
  const moveImage = (index: number, offset: number) => setImages((current) => {
    const next = [...current];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    return next;
  });

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!window.xiaoxiWorkflow || locked) return;
    setError("");
    if (type === "touch" && (!selectedIds.length || !script.trim())) { setError("请选择联系人，并填写触达话术。"); return; }
    if (type === "touch" && missingCount) { setError("部分联系人已不在当前通讯录中，请移除失效联系人后保存。"); return; }
    if (type === "publish" && (!content.trim() || (!media && !task))) { setError("请填写正文，并选择图片或视频。"); return; }
    if (type === "interact" && !likeEnabled && !commentEnabled) { setError("请至少选择点赞或 AI 评论。"); return; }
    if (scheduled && (daily ? !startTime : !scheduledAt)) { setError("请填写执行时间，或取消指定时间。"); return; }
    const input: WorkflowTaskInput = {
      type,
      title: title.trim() || undefined,
      scheduledAt: scheduled && !daily ? new Date(scheduledAt).toISOString() : null,
      repeat: daily && type === "interact" ? "daily" : null,
      startTime: daily && scheduled ? startTime : null,
      payload: type === "touch" ? { contactIds: selectedIds, script: script.trim(), imageIds: images.map((image) => image.id), link: link.trim() }
        : type === "publish" ? { content: content.trim(), ...(media?.selection_id ? { selectionId: media.selection_id } : duplicate && task ? { sourceTaskId: task.id } : {}) }
          : { maxPosts, likeEnabled, commentEnabled, commentGuidance: commentGuidance.trim() }
    };
    const result = await run(() => task && !duplicate ? window.xiaoxiWorkflow!.updateTask({ ...input, id: task.id }) : window.xiaoxiWorkflow!.addTask(input));
    if (result?.ok) onSaved();
    else setError(result?.error || "任务未保存，请检查上方提示。");
  };

  return <form className="workflow-editor" onSubmit={(event) => void save(event)} aria-labelledby="workflow-editor-title">
    <div className="workflow-editor-head"><h2 id="workflow-editor-title">{formTitle}</h2><button type="button" className="workflow-icon-button" aria-label="关闭任务编辑" onClick={onCancel} disabled={locked}><X size={19} /></button></div>

    {type === "touch" && <>
      <div className="workflow-field-head"><label htmlFor="workflow-contact-search">联系人 <span>已选 {selectedIds.length} 人</span></label><button type="button" className="text-button" onClick={onSync} disabled={locked || syncBusy || state.enabled}>{syncBusy ? "同步中…" : "同步联系人"}</button></div>
      {eligible.length ? <div className="workflow-contact-picker">
        <div className="workflow-contact-toolbar"><input id="workflow-contact-search" value={query} onChange={(event) => { setQuery(event.target.value); setVisibleLimit(60); }} placeholder="搜索备注、昵称或微信号" disabled={locked} /><button type="button" className="text-button" disabled={locked} onClick={() => setSelectedIds((ids) => [...new Set([...ids, ...filtered.map((contact) => contact.id)])])}>{query ? "选中搜索结果" : "全选"}</button><button type="button" className="text-button" disabled={locked || !selectedIds.length} onClick={() => setSelectedIds([])}>清空</button></div>
        <div className="workflow-contact-list">
          {filtered.slice(0, visibleLimit).map((contact) => <label className="workflow-contact-option" key={contact.id}><input type="checkbox" checked={selectedSet.has(contact.id)} disabled={locked} onChange={(event) => setSelectedIds((ids) => event.target.checked ? [...ids, contact.id] : ids.filter((id) => id !== contact.id))} /><span><strong>{contactLabel(contact)}</strong>{contact.wechatId && <small>{contact.wechatId}</small>}</span></label>)}
          {!filtered.length && <p className="workflow-small-note">没有找到相关联系人。</p>}
          {filtered.length > visibleLimit && <button type="button" className="text-button" onClick={() => setVisibleLimit((limit) => limit + 60)}>显示更多（共 {filtered.length} 人）</button>}
        </div>
      </div> : <p className="workflow-small-note">先同步微信联系人，就可以选择本次触达对象。{state.enabled ? "请先暂停程序再同步。" : ""}</p>}
      {syncError && <p className="workflow-inline-warning" role="alert">{syncError}</p>}
      {missingCount > 0 && <p className="workflow-inline-warning">{missingCount} 位联系人已失效。<button type="button" className="text-button" onClick={() => setSelectedIds((ids) => ids.filter((id) => eligible.some((contact) => contact.id === id)))}>移除失效联系人</button></p>}
      <label className="workflow-field"><span>触达话术</span><textarea value={script} onChange={(event) => setScript(event.target.value)} disabled={locked} placeholder="写下这次想对客户说的话，可用 {称呼} 自动填入联系人称呼。" rows={4} /></label>
      <div className="workflow-media-field"><div><strong>接着发图片 <small>选填</small></strong><span>按下方顺序逐张发送 · 最多 9 张</span></div><button type="button" data-xiaoxi-touch-images className="secondary-button" disabled={locked || images.length >= 9} onClick={() => void chooseTouchImages()}><ImagePlus size={16} />{mediaBusy ? "正在添加…" : "添加图片"}</button></div>
      {images.length > 0 && <ol className="workflow-touch-images" aria-label="图片发送顺序">{images.map((image, index) => <li key={image.id}>
        <div className="workflow-touch-image-preview">{image.preview ? <img src={image.preview} alt={image.name} /> : <span>图片无法读取</span>}</div>
        <div className="workflow-touch-image-name"><span>{index + 1}. {image.name}</span></div>
        <div className="workflow-touch-image-actions">
          <button type="button" className="workflow-icon-button" aria-label={`将${image.name}前移`} disabled={locked || index === 0} onClick={() => moveImage(index, -1)}><ArrowLeft size={15} /></button>
          <button type="button" className="workflow-icon-button" aria-label={`将${image.name}后移`} disabled={locked || index === images.length - 1} onClick={() => moveImage(index, 1)}><ArrowRight size={15} /></button>
          <button type="button" className="workflow-icon-button" aria-label={`移除${image.name}`} disabled={locked} onClick={() => setImages((current) => current.filter((entry) => entry.id !== image.id))}><X size={15} /></button>
        </div>
      </li>)}</ol>}
      <label className="workflow-field"><span>最后发对应网址 <small>选填</small></span><input type="url" value={link} onChange={(event) => setLink(event.target.value)} disabled={locked} maxLength={2048} placeholder="https://" /><small className="workflow-touch-link-note">网址作为一条独立消息，在文字和图片之后发送。</small></label>
      <p className="workflow-touch-order" aria-live="polite">发送顺序：话术{images.length > 0 ? ` → ${images.length} 张图片` : ""}{link.trim() ? " → 网址" : ""}</p>
      <p className="workflow-small-note">所选客户加入自动接待范围。本次触达完成后不会自动重发。</p>
    </>}

    {type === "publish" && <>
      <label className="workflow-field"><span>朋友圈正文</span><textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={2000} disabled={locked} placeholder="输入这条朋友圈的正文" rows={5} /></label>
      <div className="workflow-media-field"><div><strong>图片或视频</strong><span>1–9 张图片，或 1 个视频</span></div><button type="button" data-xiaoxi-moments-publish-choose className="secondary-button" disabled={locked} onClick={() => void chooseMedia()}><ImagePlus size={16} />{mediaBusy ? "选择中…" : media ? "更换素材" : "选择素材"}</button></div>
      {media && <ul className="workflow-media-list">{media.files?.length ? media.files.map((file, index) => <li key={`${file.name}-${index}`}><ImagePlus size={15} /><span>{file.name}</span><small>{file.kind === "video" ? "视频" : "图片"}</small></li>) : <li>{media.media_kind === "video" ? "1 个视频" : `${media.media_count} 张图片`} · 已保存素材</li>}</ul>}
      {!media && task && <p className="workflow-small-note">将沿用这项任务已保存的素材，也可以重新选择。</p>}
    </>}

    {type === "interact" && <>
      <div className="workflow-interaction-options"><label className="workflow-check"><input type="checkbox" checked={likeEnabled} disabled={locked} onChange={(event) => setLikeEnabled(event.target.checked)} />点赞</label><label className="workflow-check"><input type="checkbox" checked={commentEnabled} disabled={locked} onChange={(event) => setCommentEnabled(event.target.checked)} />AI 评论</label><label className="workflow-count">每次完成 <input type="number" min={1} max={50} value={maxPosts} disabled={locked} onChange={(event) => setMaxPosts(Math.max(1, Math.min(50, Number(event.target.value) || 1)))} /> 条</label></div>
      {commentEnabled && <label className="workflow-field"><span>评论偏好 <small>选填</small></span><textarea value={commentGuidance} maxLength={200} rows={2} disabled={locked} onChange={(event) => setCommentGuidance(event.target.value)} placeholder="例如：语气亲切，只评论产品和工作内容。" /></label>}
      <label className="workflow-check"><input type="checkbox" checked={daily} disabled={locked} onChange={(event) => setDaily(event.target.checked)} />每天执行一次</label>
    </>}

    <div className="workflow-schedule"><label className="workflow-check"><input type="checkbox" checked={scheduled} disabled={locked} onChange={(event) => setScheduled(event.target.checked)} /><CalendarClock size={16} />指定时间 <small>选填</small></label>{scheduled ? <label className="workflow-schedule-input"><span>{daily ? "每天" : "执行时间"}</span><input type={daily ? "time" : "datetime-local"} value={daily ? startTime : scheduledAt} disabled={locked} onChange={(event) => daily ? setStartTime(event.target.value) : setScheduledAt(event.target.value)} /></label> : <span className="workflow-small-note">{daily ? "每天启动后按顺序执行一次" : "不指定时间，按加入顺序执行"}</span>}</div>
    <details className="workflow-details workflow-name-option"><summary>任务名称（选填）</summary><label className="workflow-field"><span className="workflow-sr-only">任务名称</span><input value={title} onChange={(event) => setTitle(event.target.value)} disabled={locked} maxLength={80} placeholder={TASK_LABELS[type]} /></label></details>
    {error && <p className="workflow-inline-warning" role="alert">{error}</p>}
    <div className="workflow-editor-footer"><span>{state.enabled ? "请先暂停，再调整任务" : "保存后，启动程序即可执行"}</span><button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>取消</button><button type="submit" className="primary-button" data-xiaoxi-workflow-save disabled={locked || !window.xiaoxiWorkflow}>{busy ? "保存中…" : task && !duplicate ? "保存任务" : "加入计划"}</button></div>
  </form>;
}

function WorkflowPublishRecovery({ workflow }: { workflow: WorkflowController }) {
  type PublishState = { status: string; outcome_unknown?: boolean; last_reason?: string };
  const api = (window as Window & { xiaoxiMomentsPublish?: {
    status: () => Promise<{ ok: boolean; state?: PublishState }>;
    onUpdate: (callback: (state: PublishState) => void) => () => void;
    resolveUnknown: (payload: { resolution: "published" | "not_published" }) => Promise<{ ok: boolean; state?: PublishState; reason?: string }>;
  } }).xiaoxiMomentsPublish;
  const [unknown, setUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!api) return;
    let disposed = false;
    let liveUpdate = false;
    const accept = (state: PublishState) => setUnknown(Boolean(state.outcome_unknown || ["outcome_unknown", "needs_manual_confirmation"].includes(state.status)));
    const unsubscribe = api.onUpdate((state) => { if (!disposed) { liveUpdate = true; accept(state); } });
    void api.status().then((result) => { if (!disposed && !liveUpdate && result.state) accept(result.state); }).catch(() => undefined);
    return () => { disposed = true; unsubscribe?.(); };
  }, [api]);
  const resolve = async (resolution: "published" | "not_published") => {
    if (!api || busy) return;
    setBusy(true); setError("");
    try {
      const result = await api.resolveUnknown({ resolution });
      if (!result.ok) { setError("核实结果未保存，请稍后重试。"); return; }
      setUnknown(false);
      if (window.xiaoxiWorkflow) await workflow.run(() => window.xiaoxiWorkflow!.status());
    } catch { setError("核实结果未保存，请稍后重试。"); }
    finally { setBusy(false); }
  };
  if (!unknown) return null;
  return <section className="workflow-publish-recovery" aria-labelledby="workflow-publish-recovery-title"><strong id="workflow-publish-recovery-title">有一条朋友圈需要核实</strong><p>请先去微信查看这条内容是否已发布，再记录结果。核实前，后续发布会等待。</p><div><button type="button" className="secondary-button" data-xiaoxi-moments-publish-resolve-published disabled={busy} onClick={() => void resolve("published")}>已核实，已经发布</button><button type="button" className="secondary-button" data-xiaoxi-moments-publish-resolve-not-published disabled={busy} onClick={() => void resolve("not_published")}>已核实，没有发布</button></div>{error && <p role="alert">{error}</p>}</section>;
}

export function WorkflowRecipients({ workflow, contacts = [] }: { workflow: WorkflowController; contacts?: WorkflowContact[] }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [limit, setLimit] = useState(50);
  const { state, busy, run } = workflow;
  const filtered = state.recipients.filter((contact) => contact.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const available = contacts.filter((contact) => contact.allowed !== false && !state.recipients.some((item) => item.id === contact.id));
  const choices = available.filter((contact) => contactLabel(contact).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 100);
  const locked = busy || state.enabled || state.phase === "pausing";
  return <section className="workflow-recipients">
    <label className="workflow-check"><input type="checkbox" checked={state.replyEnabled !== false} disabled={busy || state.enabled || state.phase === "pausing"} onChange={(event) => window.xiaoxiWorkflow && void run(() => window.xiaoxiWorkflow!.setReplyEnabled(event.target.checked))} />开启自动回复（启动程序后监听新消息）</label>
    <div className="workflow-list-head"><h2>接待范围</h2><span>{state.recipients.length} 位客户</span></div>
    <p className="workflow-small-note">可以直接选择接待客户，也可以从触达计划加入。保存名单后不会发送消息，启动程序才开始接待。</p>
    <details className="workflow-details" open={state.recipients.length === 0 ? true : undefined}><summary>添加接待联系人</summary>
      {available.length ? <><input className="workflow-recipient-search" aria-label="搜索可添加联系人" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索联系人" />
        <div className="workflow-contact-options">{choices.map((contact) => <label className="workflow-check" key={contact.id}><input type="checkbox" disabled={locked} checked={selected.includes(contact.id)} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, contact.id] : ids.filter((id) => id !== contact.id))} />{contactLabel(contact)}</label>)}</div>
        {!choices.length && <p className="workflow-small-note">没有匹配的联系人。</p>}
        <button type="button" className="primary-button" data-xiaoxi-workflow-save disabled={locked || !selected.length} onClick={() => window.xiaoxiWorkflow && void run(() => window.xiaoxiWorkflow!.addRecipients(selected)).then((result) => { if (result?.ok) setSelected([]); })}>保存接待名单（{selected.length} 人）</button></> : <p className="workflow-small-note">{contacts.length ? "当前可选联系人均已加入。" : "请先同步微信联系人，再回来选择接待客户。"}</p>}
    </details>
    {state.recipients.length ? <details className="workflow-details"><summary>管理接待客户</summary><input className="workflow-recipient-search" aria-label="搜索接待客户" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(50); }} placeholder="搜索客户" /><ul className="workflow-recipient-list">{filtered.slice(0, limit).map((contact) => <li key={contact.id}><span>{contact.label}</span><button className="text-button" disabled={locked} onClick={() => window.xiaoxiWorkflow && void run(() => window.xiaoxiWorkflow!.removeRecipient(contact.id))}>移出接待</button></li>)}</ul>{!filtered.length && <p className="workflow-small-note">没有找到相关客户。</p>}{filtered.length > limit && <button className="text-button" onClick={() => setLimit((value) => value + 50)}>显示更多</button>}</details> : <p className="workflow-small-note">尚未保存接待客户。</p>}
  </section>;
}

export function FloatingWorkflowWindow() {
  const workflow = useWechatWorkflow();
  const { state, error, run, busy } = workflow;
  const current = state.tasks.find((task) => task.id === state.currentTaskId);
  const displayed = current || state.tasks.find((task) => task.id === state.lastTaskId);
  const incomplete = state.tasks.filter((task) => ["needs_attention", "missed"].includes(task.status) || (task.status === "pending" && task.accountMismatch));
  const next = state.tasks.find((task) => task.id === state.nextTaskId);
  const completed = state.tasks.filter((task) => task.status === "completed").length;
  const api = window.xiaoxiWorkflow;
  const showMain = () => api && void run(() => api.showMain());
  const sync = state.contactSync;
  const moments = sync || state.phase === "replying" ? null : state.momentsProgress;
  const syncLabel = !sync ? "" : !sync.running
    ? (sync.error ? "联系人同步未完成" : `已同步 ${sync.contactCount} 位联系人`)
    : (SYNC_STAGE_LABELS[sync.stage] || "正在读取微信联系人");
  const momentsLabel = (reason: string, fallback: string) => {
    const label = momentsProgressLabel(reason, fallback);
    return label === reason ? fallback : label;
  };
  const active = state.enabled || sync?.running;
  return <main className="floating-shell workflow-floating-shell">
    <header className="floating-head"><div className="floating-title"><span className={`floating-pulse ${active ? "running" : "paused"}`} /><strong>微信拓客进度</strong></div><button className="floating-close" aria-label="打开主页面，运行时保留进度窗" title="打开主页面" onClick={showMain} disabled={busy}><Maximize2 size={16} /></button></header>
    <div className="workflow-floating-body">
      <div className="workflow-floating-current" role="status"><strong>{workflow.loading ? "读取进度中…" : sync ? syncLabel : workflowStatusText(state)}</strong>{sync ? <small>同步联系人</small> : current && current.title !== TASK_LABELS[current.type] && <small>{current.title}</small>}</div>
      {!sync && state.phase !== "replying" && displayed && displayed.progress?.total > 0 && <div className="floating-progress"><div className="floating-progress-bar"><span style={{ width: `${Math.min(100, displayed.progress.done / displayed.progress.total * 100)}%` }} /></div><b>{displayed.progress.done}/{displayed.progress.total}</b></div>}
      {moments && <>{current && <p className="workflow-floating-detail">{momentsLabel(moments.stage, "正在处理当前帖子")}</p>}<div className="workflow-floating-counts"><strong>累计点赞 {moments.liked} · 评论 {moments.commented}</strong><span>扫描 {moments.scanned} · 跳过评论 {moments.skipped || 0} · 原已赞 {moments.alreadyLiked || 0}</span></div>{moments.skipReason && <p className="workflow-floating-detail">{momentsLabel(moments.skipReason, "本条评论未发送")}</p>}</>}
      {!sync && <>{next && <div className="workflow-floating-next"><span>下一项</span><strong>{next.title} · {formatTaskTime(next)}</strong></div>}{!moments && <div className="workflow-floating-counts"><span>已完成 {completed} 项</span><span>未完成 {incomplete.length} 项</span></div>}{incomplete.length > 0 && <p className="workflow-floating-detail">{incomplete.length} 项未完成：{taskErrorText(incomplete[0].error || "请切回任务对应的微信账号后查看详情")}</p>}</>}
      {(error || state.error || sync?.error || state.replyError) && <div className="floating-alert" role="alert">{error || state.error || sync?.error || state.replyError}</div>}
    </div>
    <footer className="floating-actions">{sync?.running ? <button disabled>同步中…</button> : <WorkflowToggle workflow={workflow} compact />}<button onClick={showMain} disabled={busy}>主页面</button></footer>
  </main>;
}
