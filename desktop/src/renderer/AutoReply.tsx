import { Check, Pause, Play, X } from "lucide-react";
import { useEffect, useState } from "react";

type ScanHealth = "unknown" | "checking" | "healthy" | "warning" | "degraded" | "waiting";
type AutoReplyFailureContext = {
  phase?: string;
  code?: string;
  send_phase?: string;
  send_attempted?: boolean;
  send_result?: "not_attempted" | "sent_verified" | "outcome_unknown";
  draft_phase_started?: boolean;
  recovery_action?: string;
  retry_attempt?: number;
  retry_polls_remaining?: number;
  required_idle_ms?: number;
  observed_idle_ms?: number;
  preflight_ms?: number;
};
type AutoReplyActivity = {
  phase?: string;
  phase_started_at?: string;
  contact_label?: string;
  action?: "answer" | "clarify" | "handoff" | "silent";
  reason_code?: string;
  trace_id?: string;
  delivery_status?: "not_attempted" | "prepared" | "clicked" | "sent_verified" | "outcome_unknown";
  detail_code?: string;
};
type AutoReplyState = {
  status: string;
  reply_count: number;
  last_event: string;
  last_error: string;
  updated_at?: string;
  scan_health?: ScanHealth;
  last_scan_at?: string;
  last_scan_success_at?: string;
  last_scan_reason?: string;
  consecutive_scan_failures?: number;
  pending_retry_count?: number;
  last_failure_context?: AutoReplyFailureContext | null;
  system_error?: {
    code: string;
    category: string;
    message: string;
  } | null;
  activity?: AutoReplyActivity | null;
  held_contacts?: Array<{ id: string; label: string }>;
  test_scope?: {
    required?: boolean;
    enforced?: boolean;
    contact_label?: string;
    available_contacts?: TestScopeContact[];
    reset_on_restart?: boolean;
  };
};
type AutoReplyResult = { ok: boolean; state?: Partial<AutoReplyState>; error?: string; code?: string };
type TestScopeContact = {
  id: string;
  label: string;
};

declare global {
  interface Window {
    xiaoxiAutoReply?: {
      status: () => Promise<AutoReplyResult>;
      start: (payload?: { contactId?: string }) => Promise<AutoReplyResult>;
      pause: () => Promise<AutoReplyResult>;
      acknowledgeManualFollowup: () => Promise<AutoReplyResult>;
      resumeContact: (contactId: string) => Promise<AutoReplyResult>;
      showMain: () => Promise<AutoReplyResult>;
      onUpdate?: (callback: (result: AutoReplyResult) => void) => () => void;
    };
  }
}

const EMPTY_STATE: AutoReplyState = {
  status: "stopped",
  reply_count: 0,
  last_event: "",
  last_error: "",
  scan_health: "unknown",
  last_scan_at: "",
  last_scan_success_at: "",
  last_scan_reason: "",
  consecutive_scan_failures: 0,
  pending_retry_count: 0,
  last_failure_context: null,
  system_error: null,
  held_contacts: []
};

const DEVELOPMENT_EDITION = import.meta.env.VITE_XIAOXI_EDITION === "development";

const SCAN_HEALTH_LABELS: Record<ScanHealth, string> = {
  unknown: "暂无数据",
  checking: "检查中",
  healthy: "轮询正常",
  warning: "扫描波动",
  degraded: "扫描异常",
  waiting: "等待微信空闲"
};

const SCAN_REASON_LABELS: Record<string, string> = {
  baseline_ready: "启动基线检查通过",
  candidate_detected: "已发现待处理消息",
  chat_boundary_unresolved: "聊天区与输入框边界暂时无法可靠确认，已跳过本轮并等待重试",
  no_unread_message: "本轮未发现新消息",
  current_session_baselined: "当前会话已建立消息基线",
  current_outgoing_settling: "已发送消息正在稳定显示，等待下轮确认",
  current_visual_drift_consumed: "已校准当前会话的单项识别波动",
  current_transition_unresolved: "新消息证据暂不稳定，已保留并继续后台复核",
  current_conversation_ambiguous: "当前聊天标题识别不唯一，正在等待下一轮重新识别",
  current_conversation_changed: "扫描期间当前聊天发生变化，已取消本轮处理",
  wechat_user_active: "检测到鼠标或键盘仍在使用，等待电脑连续空闲后继续",
  current_sidebar_row_unresolved: "当前聊天与左侧会话行暂时无法对应，正在等待下一轮重新识别",
  latest_message_not_incoming: "最近一条不是客户新消息",
  latest_message_role_unresolved: "最新消息的发送方向暂时无法可靠确认，已跳过本轮并等待重试",
  wechat_operation_busy: "微信正被其他任务使用，等待下轮",
  wechat_focus_failed: "微信窗口本轮未能切到前台，已跳过并等待重试",
  baseline_epoch_changed: "扫描基线已更新，本轮已取消",
  no_current_conversation: "当前没有打开已同步的一对一联系人",
  powershell_timeout: "读取微信界面超时",
  powershell_failed: "微信界面读取组件运行失败",
  powershell_output_invalid: "微信界面读取结果无效",
  wechat_window_missing: "未找到已登录的微信主窗口",
  wechat_window_ambiguous: "检测到多个微信主窗口",
  wechat_window_not_ready: "微信窗口尚未准备完成",
  automation_root_missing: "无法读取微信界面，可能是权限不一致",
  history_viewport_missing: "未找到当前聊天消息区域",
  history_viewport_invalid: "当前聊天消息区域无效",
  history_not_at_bottom: "当前聊天记录没有停留在底部",
  history_window_not_foreground: "微信窗口无法切换到前台",
  history_window_obscured: "微信消息区域被其他窗口遮挡",
  history_screenshot_failed: "微信消息区域读取失败",
  history_avatar_ambiguous: "无法判断最新消息的发送方向",
  history_changed_during_scan: "扫描期间聊天内容发生变化",
  history_scroll_failed: "读取较早聊天记录失败",
  history_restore_failed: "聊天记录滚动位置恢复失败",
  history_empty: "当前聊天记录为空",
  history_item_invalid: "聊天记录中存在无法识别的项目",
  history_overlap_missing: "两页聊天记录无法安全衔接",
  history_overlap_ambiguous: "两页聊天记录衔接不唯一",
  history_overlap_mismatch: "两页聊天记录衔接不一致",
  unread_preview_missing: "未读会话缺少消息预览",
  unread_preview_mismatch: "未读预览与最新消息不一致",
  unread_preview_pending: "已打开未读会话，正在复核最新消息",
  unread_preview_unresolved: "未读消息证据暂不稳定，已保留并继续后台复核",
  conversation_open_failed: "无法打开未读会话",
  conversation_title_changed: "扫描期间聊天对象发生变化",
  conversation_title_mismatch: "当前聊天对象校验失败",
  wechat_process_changed: "扫描期间微信进程发生变化",
  wechat_window_changed: "扫描期间微信窗口发生变化",
  latest_text_message_missing: "没有找到可识别的最新文本消息",
  incoming_message_missing: "没有找到待校验的客户消息",
  incoming_message_changed: "发送前发现客户消息证据已变化",
  incoming_identity_missing: "最新消息缺少稳定身份",
  whitelist_empty: "没有可监听的已同步联系人",
  whitelist_invalid: "联系人监听名单无效",
  unknown_scan_reason: "扫描器返回了未知状态，已安全隐藏原始值",
  scan_exception: "扫描微信时发生异常",
  scan_result_invalid: "扫描器返回了无效结果",
  session_probe_unsupported: "当前微信会话列表结构无法可靠识别，已自动切换视觉识别",
  moments_render_pane_ambiguous: "微信渲染窗口不唯一",
  moments_render_pane_not_found: "未找到微信渲染窗口",
  visual_candidate_ambiguous: "同时发现多个待处理会话",
  visual_capture_failed: "读取微信画面失败",
  visual_driver_missing: "当前测试包缺少微信视觉识别组件",
  visual_ocr_failed: "识别微信画面文字失败",
  moments_visual_ocr_failed: "Windows 中文文字识别失败",
  moments_visual_ocr_region_invalid: "微信文字识别区域无效",
  moments_visual_ocr_unavailable: "当前 Windows 缺少中文文字识别能力",
  visual_render_pane_mismatch: "微信渲染窗口结构与预期不一致",
  visual_sidebar_match_ambiguous: "联系人列表中出现多个同名视觉匹配",
  visual_sidebar_match_missing: "当前可见列表中未找到待监听联系人",
  wechat_window_not_foreground: "微信窗口无法切换到前台",
  wechat_window_obscured: "微信窗口被其他窗口遮挡",
  whitelist_name_ambiguous: "同步联系人去除空格后出现重名"
};

const CONTROL_EVENT_LABELS: Record<string, string> = {
  outcome_unknown_occurrence_skipped: "上一条消息发送结果无法确认，已禁止对同一条消息自动补发",
  candidate_evidence_missing: "本轮新消息缺少稳定标识，已跳过并等待下一轮",
  duplicate_skipped: "已跳过重复识别到的同一条客户消息",
  paused_by_user: "已通过界面手动暂停",
  app_closed: "应用窗口关闭时已安全暂停",
  recovered_after_restart: "应用重启后按安全策略保持暂停，请重新启动",
  state_upgraded_paused: "运行状态升级后已安全暂停，请重新启动",
  start_failed: "启动检查未通过",
  test_scope_window_changed: "检测到微信窗口变化，已暂停测试自动回复，请重新选择联系人",
  current_transition_unresolved_paused: "新消息证据不一致，已安全暂停",
  waiting_for_user_idle: "检测到电脑仍在操作，已等待空闲后继续",
  manual_intervention_required: "检测到微信中可能有人为操作，当前消息已停止自动重试",
  system_error_paused: "AI 服务故障，客户消息未发送，自动回复已暂停",
  progress_window_load_failed: "进度窗口加载失败，任务已暂停并返回主页面",
  human_owned_contact_skipped: "该客户已由人工接管，本轮未自动回复",
  contact_ai_resumed: "已恢复该客户的 AI 自动回复",
  silent_processed: "本条消息无需回复，已静默处理"
};

const ACTIVITY_PHASE_LABELS: Record<string, string> = {
  idle: "等待启动",
  starting: "启动检查",
  prime: "建立消息基线",
  listening: "监听新消息",
  scanning: "扫描微信消息",
  scan: "扫描微信消息",
  candidate: "发现客户消息",
  generating: "生成 AI 回复",
  generate: "生成 AI 回复",
  decision_ready: "回复决策完成",
  preparing_send: "准备安全发送",
  sending: "写入并发送",
  send: "写入并发送",
  prepared: "草稿已准备",
  clicked: "已点击，正在核验",
  verifying: "核验发送结果",
  retrying: "回复尚未发出，正在重新尝试",
  manual_review: "检测到人工输入，当前消息交由人工",
  sent_verified: "发送结果已核验",
  silent: "本条消息静默处理",
  waiting: "等待电脑空闲",
  paused: "自动回复已暂停",
  error: "自动回复发生故障"
};

const ACTION_LABELS: Record<string, string> = {
  answer: "直接回答",
  clarify: "追问一个关键信息",
  handoff: "已转人工接管",
  silent: "无需发送消息"
};

const DELIVERY_STATUS_LABELS: Record<string, string> = {
  not_attempted: "尚未尝试发送",
  prepared: "草稿已准备",
  clicked: "已点击发送，正在核验",
  sent_verified: "发送成功并已核验",
  outcome_unknown: "发送结果无法确认"
};

const ACTIVITY_DETAIL_LABELS: Record<string, string> = {
  context_ready: "已读取本轮对话",
  visual_preflight: "正在核验当前会话",
  visual_send_started: "正在写入微信输入框",
  send_started: "正在准备发送",
  sent_verified: "发送成功并已核验",
  handoff_reply_sent: "已发送人工衔接消息",
  wechat_user_active: "检测到电脑仍在使用，回复已保留",
  powershell_failed: "微信输入执行器未启动，回复尚未发出",
  powershell_timeout: "微信输入执行超时，回复尚未发出",
  powershell_output_invalid: "微信输入执行结果无效，回复尚未发出",
  powershell_runtime_quarantined: "微信输入执行器暂不可用，回复尚未发出",
  visual_send_draft_input_failed: "微信输入框写入失败，回复尚未发出",
  visual_send_external_input_detected: "检测到微信输入框有人为输入，当前消息交由人工",
  unread_preview_pending: "已读消息正在复核，尚未丢弃",
  unread_preview_unresolved: "已读消息正在继续复核，尚未丢弃",
  send_retry_waiting: "回复尚未发出，正在退避后重试"
};

const RECOVERY_ACTION_LABELS: Record<string, string> = {
  wait_for_idle: "正在等待电脑空闲",
  wait_for_idle_and_retry: "已保留本条回复，等待空闲后重试",
  retry_waiting: "本条回复正在退避后复核",
  retry_pending: "本条回复将重新校验后重试",
  manual_review_required: "已停止自动重试，等待人工确认",
  manual_check_required: "发送结果待人工确认",
  fix_ai_and_restart: "AI 服务故障，修复后重新启动"
};

const FAILURE_PHASE_LABELS: Record<string, string> = {
  prime: "启动检查",
  scan: "扫描微信消息",
  send: "回复发送",
  generate: "生成 AI 回复"
};

const SEND_PHASE_LABELS: Record<string, string> = {
  preflight: "发送前空闲校验",
  draft: "写入草稿前",
  before_send: "点击发送前",
  send: "发送校验",
  completed: "发送完成"
};

function normalizeScanHealth(value: AutoReplyState["scan_health"]): ScanHealth {
  return value && Object.prototype.hasOwnProperty.call(SCAN_HEALTH_LABELS, value) ? value : "unknown";
}

function formatScanTime(value?: string) {
  if (!value) return "--";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "--";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;
}

function scanReasonLabel(reason?: string) {
  if (!reason) return "尚无扫描结果";
  return SCAN_REASON_LABELS[reason] || "未识别扫描状态";
}

function activityDetailLabel(detailCode?: string) {
  if (!detailCode) return "";
  return ACTIVITY_DETAIL_LABELS[detailCode] || "正在更新本轮执行状态";
}

function formatDuration(value?: number) {
  const milliseconds = Math.max(0, Number(value) || 0);
  if (!Number.isFinite(milliseconds)) return "";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} 毫秒`;
  return `${(milliseconds / 1000).toFixed(milliseconds >= 10_000 ? 0 : 1)} 秒`;
}

function autoReplyActivityPhase(state: AutoReplyState) {
  const explicit = String(state.activity?.phase || "").trim();
  if (state.system_error) return "error";
  if (explicit) return explicit;
  if (state.status === "starting") return "starting";
  if (state.status === "paused") return "paused";
  if (state.last_event === "generating_reply") return "generating";
  if (state.last_event === "reply_sent_verified") return "sent_verified";
  if (state.last_event === "silent_processed") return "silent";
  if (state.scan_health === "waiting") return "waiting";
  if (state.last_scan_reason === "candidate_detected") return "candidate";
  if (state.status === "running") return "listening";
  return "idle";
}

function autoReplyPhaseLabel(phase: string) {
  return ACTIVITY_PHASE_LABELS[phase] || "自动回复运行中";
}

function autoReplyPhaseProgress(phase: string) {
  if (["candidate", "generating", "generate"].includes(phase)) return 1;
  if (["decision_ready", "preparing_send", "sending", "send", "prepared", "retrying", "manual_review"].includes(phase)) return 2;
  if (["clicked", "verifying"].includes(phase)) return 3;
  if (["sent_verified", "silent"].includes(phase)) return 4;
  if (["paused", "error", "idle"].includes(phase)) return -1;
  return 0;
}

function formatPhaseElapsed(value: string | undefined, currentTime: number) {
  const startedAt = Date.parse(String(value || ""));
  if (!Number.isFinite(startedAt) || startedAt > currentTime) return "--";
  const seconds = Math.max(0, Math.floor((currentTime - startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes} 分 ${remainder} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function autoReplyContactLabel(state: AutoReplyState) {
  const label = String(state.activity?.contact_label || state.test_scope?.contact_label || "").trim();
  if (label) return label;
  return state.test_scope?.required ? "等待选择测试联系人" : "全部已启用联系人";
}

function autoReplyRecentResult(state: AutoReplyState) {
  if (state.system_error) return `未进入微信输入阶段：${state.system_error.message}（${state.system_error.category} · ${state.system_error.code}）`;
  if (state.last_error) return state.last_error;
  const delivery = String(state.activity?.delivery_status || "");
  if (delivery && delivery !== "not_attempted" && DELIVERY_STATUS_LABELS[delivery]) return DELIVERY_STATUS_LABELS[delivery];
  const detail = activityDetailLabel(String(state.activity?.detail_code || "").trim());
  if (detail) return detail;
  const action = String(state.activity?.action || "");
  if (action && ACTION_LABELS[action]) return `本轮决定：${ACTION_LABELS[action]}`;
  if (state.last_event && CONTROL_EVENT_LABELS[state.last_event]) return CONTROL_EVENT_LABELS[state.last_event];
  if (state.last_scan_reason) return scanReasonLabel(state.last_scan_reason);
  return state.status === "running" ? "正在监听客户新消息" : "尚无运行结果";
}

function recoverySummary(context: AutoReplyFailureContext) {
  switch (context.recovery_action) {
    case "wait_for_idle":
      return "检测到电脑仍在使用，已跳过本轮扫描；监听会在电脑空闲后继续。";
    case "wait_for_idle_and_retry":
      return context.draft_phase_started
        ? "本条回复尚未点击发送；系统会先保持输入框安全，再在电脑空闲后重新校验。"
        : "本条回复尚未写入草稿，也没有点击发送；系统已保留它，电脑空闲后会重新校验。";
    case "retry_waiting":
      return "本条回复尚未发出，正在等待下一次安全复核，不会重复调用 AI 或直接补发。";
    case "retry_pending":
      return "本条回复尚未发出，系统会先重新确认微信状态，再决定是否继续。";
    case "manual_review_required":
      return "检测到微信输入框可能有人为操作；为避免覆盖你的内容，这条消息不再自动重试。";
    case "manual_check_required":
      return "发送是否完成无法确认；为避免重复发送，系统已停止对同一条消息自动补发。";
    case "fix_ai_and_restart":
      return "模型没有生成可发送内容，系统因此未点击微信输入框、未发送消息，也没有创建虚假的人工接管。请修复后手动重新启动。";
    default:
      return "本次运行已保留诊断信息，系统不会把未确认的发送当作成功。";
  }
}

export function AutoReply() {
  const [state, setState] = useState<AutoReplyState>(EMPTY_STATE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [selectedTestContactId, setSelectedTestContactId] = useState("");

  const applyResult = (result: AutoReplyResult, clearOperationError = true) => {
    if (result.state) setState((current) => ({ ...current, ...result.state }));
    if (!result.ok) {
      if (DEVELOPMENT_EDITION && result.code?.startsWith("test_contact")) setSelectedTestContactId("");
      setError(result.error || "自动回复操作失败");
    }
    else if (clearOperationError) setError("");
  };

  const refresh = () => {
    if (!window.xiaoxiAutoReply) return setPollError("当前版本未连接自动回复执行器");
    void window.xiaoxiAutoReply.status().then((result) => {
      if (result.state) setState((current) => ({ ...current, ...result.state }));
      setPollError(result.ok ? "" : result.error || "读取自动回复状态失败");
    }).catch(() => setPollError("读取自动回复状态失败"));
  };

  useEffect(() => {
    const unsubscribe = window.xiaoxiAutoReply?.onUpdate?.((result) => {
      if (result.state) setState((current) => ({ ...current, ...result.state }));
      if (!result.ok) setPollError(result.error || "读取自动回复状态失败");
      else setPollError("");
    });
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      unsubscribe?.();
      window.clearInterval(timer);
    };
  }, []);

  const run = (operation: () => Promise<AutoReplyResult>, failure: string, onSuccess?: () => void) => {
    setBusy(true);
    setError("");
    void operation().then((result) => {
      applyResult(result);
      if (result.ok) onSuccess?.();
    }).catch(() => setError(failure)).finally(() => setBusy(false));
  };

  const pause = () => {
    if (!window.xiaoxiAutoReply) {
      setError("当前版本未连接自动回复执行器");
      return;
    }
    run(() => window.xiaoxiAutoReply!.pause(), "暂停自动回复失败", () => setSelectedTestContactId(""));
  };

  const running = state.status === "running";
  const starting = state.status === "starting";
  const confirmationRequired = state.last_event === "handoff_confirmation_required";
  const heldContacts = state.held_contacts || [];
  const statusLabel = running ? "运行中" : starting ? "启动中" : state.status === "paused" ? "已暂停" : "未启动";
  const scanHealth = normalizeScanHealth(state.scan_health);
  const scanning = running || starting;
  const healthLabel = scanning ? SCAN_HEALTH_LABELS[scanHealth] : "未运行";
  const healthClass = !scanning ? "" : scanHealth === "healthy" ? "ok" : scanHealth === "degraded" ? "danger" : scanHealth === "warning" || scanHealth === "waiting" ? "warn" : "";
  const scanFailures = Math.max(0, Number(state.consecutive_scan_failures) || 0);
  const pendingRetries = Math.max(0, Number(state.pending_retry_count) || 0);
  const controlStatus = !scanning ? CONTROL_EVENT_LABELS[state.last_event] || "" : "";
  const recoveryContext = state.last_failure_context || null;
  const recoveryAction = recoveryContext?.recovery_action || "";
  const recoveryTitle = RECOVERY_ACTION_LABELS[recoveryAction] || "已保留本次诊断信息";
  const failurePhase = recoveryContext?.send_phase
    ? SEND_PHASE_LABELS[recoveryContext.send_phase] || recoveryContext.send_phase
    : FAILURE_PHASE_LABELS[recoveryContext?.phase || ""] || recoveryContext?.phase || "运行检查";
  const isManualRecovery = recoveryAction === "manual_review_required" || recoveryAction === "manual_check_required";
  const visibleError = error || pollError || (!recoveryContext ? state.last_error : "");
  const scanReasonTitle = recoveryContext?.phase === "send" && scanHealth === "waiting"
    ? "当前等待原因"
    : scanning ? "最近扫描结果" : "停止前最近扫描结果";
  const testContacts = state.test_scope?.available_contacts || [];
  const selectedTestContact = testContacts.find((contact) => contact.id === selectedTestContactId) || null;
  const testScopeReady = Boolean(state.test_scope?.required);
  const testScopeLabel = state.test_scope?.contact_label || selectedTestContact?.label || "已同步联系人";
  const testScopeNotice = running
    ? `正在仅自动回复：${testScopeLabel}。其他联系人不会回复。`
    : !testScopeReady
      ? "测试版保护未就绪，已禁止启动自动回复"
      : !testContacts.length
        ? "请先同步联系人，并确认测试联系人有唯一可识别的会话名称。"
        : selectedTestContact
          ? `本次仅自动回复：${selectedTestContact.label}；其他联系人不会回复。`
          : "请选择一位已同步联系人后，才能启动自动回复。";

  useEffect(() => {
    if (DEVELOPMENT_EDITION && state.test_scope?.required && !state.test_scope.enforced) setSelectedTestContactId("");
  }, [state.test_scope?.required, state.test_scope?.enforced]);
  const startTestAutoReply = () => {
    if (!window.xiaoxiAutoReply || !selectedTestContactId) {
      setError("请选择一位已同步联系人后再启动自动回复");
      return;
    }
    run(() => window.xiaoxiAutoReply!.start({ contactId: selectedTestContactId }), "启动自动回复失败");
  };

  return (
    <section className="page agent-page auto-reply-page">
      <div className="page-head">
        <div>
          <h1>自动回复</h1>
          <p>启动后监听新消息，并使用已导入的 AI 专家资料生成回复。</p>
        </div>
        <div className="actions">
          {running ? (
            <button className="danger-button" onClick={pause} disabled={busy}>
              <Pause size={17} />暂停自动回复
            </button>
          ) : !DEVELOPMENT_EDITION && (
            <button data-xiaoxi-auto-reply-start className="primary-button" onClick={() => window.xiaoxiAutoReply ? run(() => window.xiaoxiAutoReply!.start(), "启动自动回复失败") : setError("当前版本未连接自动回复执行器")} disabled={busy || starting}>
              <Play size={17} />{confirmationRequired ? "确认已检查并启动" : "启动自动回复"}
            </button>
          )}
        </div>
      </div>

      {state.system_error && (
        <section className="auto-reply-system-error" role="alert" aria-labelledby="auto-reply-system-error-title">
          <div>
            <strong id="auto-reply-system-error-title">AI 服务故障，自动回复已暂停</strong>
            <p>{state.system_error.message}</p>
          </div>
          <span>{state.system_error.category} · {state.system_error.code}</span>
        </section>
      )}

      {heldContacts.length > 0 && (
        <section className="auto-reply-held" aria-labelledby="auto-reply-held-title">
          <div className="auto-reply-held-head">
            <div>
              <h2 id="auto-reply-held-title">待人工客户</h2>
              <p>这些客户已单独暂停 AI，其他客户仍继续自动服务。</p>
            </div>
            <span>{heldContacts.length} 位</span>
          </div>
          <ul>
            {heldContacts.map((contact) => (
              <li key={contact.id}>
                <strong>{contact.label}</strong>
                <button
                  type="button"
                  data-xiaoxi-auto-reply-resume
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => window.xiaoxiAutoReply
                    ? run(() => window.xiaoxiAutoReply!.resumeContact(contact.id), "恢复该客户 AI 回复失败")
                    : setError("当前版本未连接自动回复执行器")}
                >
                  <Check size={16} />已处理，恢复 AI
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {DEVELOPMENT_EDITION && (
        <section className="auto-reply-test-scope" aria-labelledby="auto-reply-test-scope-title">
          <div className="auto-reply-test-scope-head">
            <div>
              <h2 id="auto-reply-test-scope-title">内部测试保护</h2>
              <p>为避免误回复，本次只能选择 1 位已同步联系人。关闭或重启应用后需要重新选择。</p>
            </div>
            <span>仅测试版</span>
          </div>
          <div className="auto-reply-test-scope-controls">
            <label htmlFor="auto-reply-test-contact">测试联系人</label>
            <select
              id="auto-reply-test-contact"
              value={selectedTestContactId}
              onChange={(event) => setSelectedTestContactId(event.target.value)}
              disabled={running || busy || !testScopeReady}
            >
              <option value="">请选择一位已同步联系人</option>
              {testContacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.label}</option>)}
            </select>
            {!running && (
              <button
                data-xiaoxi-auto-reply-start
                className="primary-button"
                onClick={startTestAutoReply}
                disabled={busy || starting || !selectedTestContact || !testScopeReady}
              >
                <Play size={17} />{confirmationRequired ? "确认已检查并仅回复此联系人" : "开始仅回复此联系人"}
              </button>
            )}
          </div>
          <p className="auto-reply-test-scope-status" aria-live="polite">{testScopeNotice}</p>
        </section>
      )}

      <div className="status-strip auto-reply-status">
        <div className="status-card"><span>运行状态</span><strong className={starting ? "warn" : ""}>{statusLabel}</strong></div>
        <div className="status-card"><span>扫描健康</span><strong className={healthClass}>{healthLabel}</strong></div>
        <div className="status-card"><span>今日已回复</span><strong>{state.reply_count}</strong></div>
        <div className="status-card"><span>最近扫描</span><strong>{formatScanTime(state.last_scan_at)}</strong></div>
        <div className="status-card"><span>最近正常扫描</span><strong>{formatScanTime(state.last_scan_success_at)}</strong></div>
        <div className="status-card"><span>连续扫描失败</span><strong className={scanFailures >= 3 ? "danger" : scanFailures > 0 ? "warn" : ""}>{scanFailures}</strong></div>
      </div>

      {controlStatus && <div className="auto-reply-control-note">当前状态：{controlStatus}</div>}
      {state.last_scan_reason && (
        <div className={`auto-reply-reason ${scanHealth === "degraded" ? "is-degraded" : scanHealth === "warning" || scanHealth === "waiting" ? "is-warning" : ""}`}>
          {scanReasonTitle}：{scanReasonLabel(state.last_scan_reason)}（{state.last_scan_reason}）
        </div>
      )}
      {recoveryContext && (
        <div className={`auto-reply-recovery ${isManualRecovery ? "is-manual" : ""}`} role={isManualRecovery ? "alert" : "status"}>
          <strong>{recoveryTitle}</strong>
          <p>{recoverySummary(recoveryContext)}</p>
          <div className="auto-reply-recovery-meta">
            <span>拦截阶段：{failurePhase}</span>
            {recoveryContext.send_attempted === false && <span>{
              recoveryAction === "manual_review_required"
                ? "未点击发送，已交由人工处理"
                : recoveryContext.draft_phase_started
                  ? "未点击发送，已保留待重试"
                  : "未写入草稿，也未点击发送"
            }</span>}
            {recoveryContext.required_idle_ms !== undefined && <span>需连续空闲：{formatDuration(recoveryContext.required_idle_ms)}</span>}
            {recoveryContext.observed_idle_ms !== undefined && <span>本次空闲：{formatDuration(recoveryContext.observed_idle_ms)}</span>}
            {recoveryContext.retry_attempt !== undefined && <span>重试次数：{recoveryContext.retry_attempt}</span>}
            {recoveryContext.code && <span>诊断：{activityDetailLabel(recoveryContext.code)}（{recoveryContext.code}）</span>}
          </div>
        </div>
      )}
      {running && pendingRetries > 0 && (
        <div className="auto-reply-control-note" role="status">
          已保留一条尚未确认的新消息证据并后台复核（{pendingRetries} 次）；证据明确前不会发送，也不会停止其他轮询。
        </div>
      )}
      {visibleError && <div className="touch-notice" role="alert">{visibleError}</div>}
    </section>
  );
}

export function FloatingAutoReplyWindow() {
  const [state, setState] = useState<AutoReplyState>(EMPTY_STATE);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [currentTime, setCurrentTime] = useState(() => Date.now());

  const applyResult = (result: AutoReplyResult) => {
    if (result.state) setState((current) => ({ ...current, ...result.state }));
    setError(result.ok ? "" : result.error || "读取自动回复状态失败");
  };

  useEffect(() => {
    if (!window.xiaoxiAutoReply) {
      setError("当前版本未连接自动回复执行器");
      return undefined;
    }
    let pushedRevision = 0;
    let refreshRevision = 0;
    const applyPushedResult = (result: AutoReplyResult) => {
      pushedRevision += 1;
      applyResult(result);
    };
    const refresh = () => {
      const requestRevision = ++refreshRevision;
      const startingPushRevision = pushedRevision;
      void window.xiaoxiAutoReply!.status()
        .then((result) => {
          if (requestRevision !== refreshRevision || startingPushRevision !== pushedRevision) return;
          applyResult(result);
        })
        .catch(() => {
          if (requestRevision === refreshRevision && startingPushRevision === pushedRevision) {
            setError("读取自动回复状态失败");
          }
        });
    };
    const unsubscribe = window.xiaoxiAutoReply.onUpdate?.(applyPushedResult);
    refresh();
    const refreshTimer = window.setInterval(refresh, 30_000);
    return () => {
      unsubscribe?.();
      window.clearInterval(refreshTimer);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const run = (operation: () => Promise<AutoReplyResult>, failure: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    void operation()
      .then(applyResult)
      .catch(() => setError(failure))
      .finally(() => setBusy(false));
  };

  const pause = () => {
    if (!window.xiaoxiAutoReply) {
      setError("当前版本未连接自动回复执行器");
      return;
    }
    run(() => window.xiaoxiAutoReply!.pause(), "暂停自动回复失败");
  };

  const showMain = () => {
    if (!window.xiaoxiAutoReply?.showMain) {
      setError("当前版本暂不支持返回主页面");
      return;
    }
    run(() => window.xiaoxiAutoReply!.showMain(), "返回主页面失败");
  };

  const phase = autoReplyActivityPhase(state);
  const phaseLabel = autoReplyPhaseLabel(phase);
  const phaseProgress = autoReplyPhaseProgress(phase);
  const elapsed = formatPhaseElapsed(state.activity?.phase_started_at, currentTime);
  const contactLabel = autoReplyContactLabel(state);
  const recentResult = autoReplyRecentResult(state);
  const systemErrorMessage = state.system_error ? `未进入微信输入阶段：${state.system_error.message}` : "";
  const visibleError = error || systemErrorMessage || state.last_error;
  const visibleErrorTitle = error
    ? error
    : state.system_error
      ? `${systemErrorMessage}（${state.system_error.category} · ${state.system_error.code}）`
      : state.last_error;
  const canPause = state.status === "starting" || state.status === "running";
  const pulseStatus = state.system_error ? "error" : state.status;

  return (
    <main className="floating-shell auto-reply-floating-shell">
      <header className="floating-head">
        <div className="floating-title">
          <span className={`floating-pulse ${pulseStatus}`} />
          <strong>自动回复进度</strong>
        </div>
        <button className="floating-close" aria-label="返回主页面" onClick={showMain} disabled={busy}>
          <X size={16} />
        </button>
      </header>

      <div className="floating-progress" aria-label={`本轮处理阶段：${phaseLabel}`}>
        <div className="auto-reply-phase-track" aria-hidden="true">
          {[0, 1, 2, 3].map((step) => (
            <span
              key={step}
              className={phaseProgress >= 4 || step < phaseProgress ? "is-complete" : step === phaseProgress ? "is-active" : ""}
            />
          ))}
        </div>
        <b title="今日已回复">今日 {Math.max(0, Number(state.reply_count) || 0)} 条</b>
      </div>

      <div className="floating-info" aria-live="polite">
        <div className="floating-row">
          <span>监听对象</span>
          <strong title={contactLabel}>{contactLabel}</strong>
        </div>
        <div className="floating-row">
          <span>当前环节</span>
          <strong title={phaseLabel}>{phaseLabel}{elapsed === "--" ? "" : ` · ${elapsed}`}</strong>
        </div>
        <div className="floating-state">
          <span>最近结果</span>
          <strong title={recentResult}>{recentResult}</strong>
        </div>
      </div>

      {visibleError && (
        <div className="floating-alert auto-reply-floating-alert" role="alert" title={visibleErrorTitle}>
          <span>{visibleError}</span>
          {!error && state.system_error && <b>{state.system_error.category} · {state.system_error.code}</b>}
        </div>
      )}

      <div className="floating-actions auto-reply-floating-actions">
        <button onClick={pause} disabled={busy || !canPause}>
          <Pause size={15} />
          {canPause ? "暂停" : "已暂停"}
        </button>
        <button onClick={showMain} disabled={busy}>主页面</button>
      </div>
    </main>
  );
}
