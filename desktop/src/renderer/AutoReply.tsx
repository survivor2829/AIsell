import { Check, Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";

type ScanHealth = "unknown" | "checking" | "healthy" | "warning" | "degraded" | "waiting";
type AutoReplyState = {
  status: string;
  reply_count: number;
  last_event: string;
  last_error: string;
  last_ai_warning_code?: string;
  last_ai_warning?: string;
  updated_at?: string;
  scan_health?: ScanHealth;
  last_scan_at?: string;
  last_scan_success_at?: string;
  last_scan_reason?: string;
  consecutive_scan_failures?: number;
};
type AutoReplyResult = { ok: boolean; state?: Partial<AutoReplyState>; error?: string };

declare global {
  interface Window {
    xiaoxiAutoReply?: {
      status: () => Promise<AutoReplyResult>;
      start: () => Promise<AutoReplyResult>;
      pause: () => Promise<AutoReplyResult>;
      acknowledgeManualFollowup: () => Promise<AutoReplyResult>;
    };
  }
}

const EMPTY_STATE: AutoReplyState = {
  status: "stopped",
  reply_count: 0,
  last_event: "",
  last_error: "",
  last_ai_warning_code: "",
  last_ai_warning: "",
  scan_health: "unknown",
  last_scan_at: "",
  last_scan_success_at: "",
  last_scan_reason: "",
  consecutive_scan_failures: 0
};

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
  no_unread_message: "本轮未发现新消息",
  current_session_baselined: "当前会话已建立消息基线",
  latest_message_not_incoming: "最近一条不是客户新消息",
  wechat_operation_busy: "微信正被其他任务使用，等待下轮",
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
  conversation_open_failed: "无法打开未读会话",
  conversation_title_changed: "扫描期间聊天对象发生变化",
  conversation_title_mismatch: "当前聊天对象校验失败",
  wechat_process_changed: "扫描期间微信进程发生变化",
  wechat_window_changed: "扫描期间微信窗口发生变化",
  latest_text_message_missing: "没有找到可识别的最新文本消息",
  incoming_message_missing: "没有找到待校验的客户消息",
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
  paused_by_user: "已通过界面手动暂停",
  app_closed: "应用窗口关闭时已安全暂停",
  recovered_after_restart: "应用重启后按安全策略保持暂停，请重新启动",
  state_upgraded_paused: "运行状态升级后已安全暂停，请重新启动",
  start_failed: "启动检查未通过"
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

export function AutoReply() {
  const [state, setState] = useState<AutoReplyState>(EMPTY_STATE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");

  const applyResult = (result: AutoReplyResult, clearOperationError = true) => {
    if (result.state) setState((current) => ({ ...current, ...result.state }));
    if (!result.ok) setError(result.error || "自动回复操作失败");
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
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => window.clearInterval(timer);
  }, []);

  const run = (operation: () => Promise<AutoReplyResult>, failure: string) => {
    setBusy(true);
    setError("");
    void operation().then(applyResult).catch(() => setError(failure)).finally(() => setBusy(false));
  };

  const running = state.status === "running";
  const starting = state.status === "starting";
  const confirmationRequired = state.last_event === "handoff_confirmation_required";
  const manualFollowupRequired = state.last_event === "handoff_manual_followup_required";
  const statusLabel = running ? "运行中" : starting ? "启动中" : state.status === "paused" ? "已暂停" : "未启动";
  const scanHealth = normalizeScanHealth(state.scan_health);
  const scanning = running || starting;
  const healthLabel = scanning ? SCAN_HEALTH_LABELS[scanHealth] : "未运行";
  const healthClass = !scanning ? "" : scanHealth === "healthy" ? "ok" : scanHealth === "degraded" ? "danger" : scanHealth === "warning" || scanHealth === "waiting" ? "warn" : "";
  const scanFailures = Math.max(0, Number(state.consecutive_scan_failures) || 0);
  const controlStatus = !scanning ? CONTROL_EVENT_LABELS[state.last_event] || "" : "";
  const visibleError = error || pollError || state.last_error;

  return (
    <section className="page agent-page auto-reply-page">
      <div className="page-head">
        <div>
          <h1>自动回复</h1>
          <p>启动后监听新消息，并使用已导入的 AI 专家资料生成回复。</p>
        </div>
        <div className="actions">
          {manualFollowupRequired && (
            <button data-xiaoxi-auto-reply-acknowledge className="primary-button" onClick={() => window.xiaoxiAutoReply ? run(() => window.xiaoxiAutoReply!.acknowledgeManualFollowup(), "确认人工提醒失败") : setError("当前版本未连接自动回复执行器")} disabled={busy}>
              <Check size={17} />确认当前已处理
            </button>
          )}
          {running ? (
            <button className="danger-button" onClick={() => window.xiaoxiAutoReply && run(() => window.xiaoxiAutoReply!.pause(), "暂停自动回复失败")} disabled={busy}>
              <Pause size={17} />暂停自动回复
            </button>
          ) : (
            <button data-xiaoxi-auto-reply-start className="primary-button" onClick={() => window.xiaoxiAutoReply ? run(() => window.xiaoxiAutoReply!.start(), "启动自动回复失败") : setError("当前版本未连接自动回复执行器")} disabled={busy || starting}>
              <Play size={17} />{confirmationRequired ? "确认已检查并启动" : "启动自动回复"}
            </button>
          )}
        </div>
      </div>

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
          {scanning ? "最近扫描结果" : "停止前最近扫描结果"}：{scanReasonLabel(state.last_scan_reason)}（{state.last_scan_reason}）
        </div>
      )}
      {visibleError && <div className="touch-notice" role="alert">{visibleError}</div>}
      {state.last_ai_warning && <div className="touch-notice" role="status">{state.last_ai_warning}{state.last_ai_warning_code ? `（${state.last_ai_warning_code}）` : ""}</div>}
    </section>
  );
}
