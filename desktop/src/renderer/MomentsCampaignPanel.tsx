import { Pause, Play, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import "./MomentsDryRunPanel.css";

type MomentsCampaignState = {
  status: string;
  max_posts: number;
  processed_count: number;
  completed_post_count: number;
  liked_count: number;
  already_liked_count: number;
  commented_count: number;
  comment_skipped_count: number;
  skipped_count: number;
  scroll_count: number;
  current_post: number;
  like_enabled: boolean;
  comment_enabled: boolean;
  comment_guidance: string;
  outcome_unknown: boolean;
  last_reason: string;
  started_at: string;
  updated_at: string;
  daily_automation: MomentsDailyAutomationState;
};

type MomentsDailyAutomationState = {
  enabled: boolean;
  target: number;
  start_time: string;
  like_enabled: boolean;
  comment_enabled: boolean;
  comment_guidance: string;
  date: string;
  completed_count: number;
  checked_count: number;
  skipped_count: number;
  remaining_count: number;
  suppressed_date: string;
  blocked_reason: string;
  last_reason: string;
  last_run_at: string;
  next_run_at: string;
  updated_at: string;
  status: string;
};

type MomentsCampaignResult = {
  ok: boolean;
  reason?: string;
  state: MomentsCampaignState;
};

type StartPayload = {
  maxPosts: number;
  likeEnabled: boolean;
  commentEnabled: boolean;
  commentGuidance: string;
};

type DailyPayload = {
  enabled: boolean;
  target: number;
  startTime: string;
  likeEnabled: boolean;
  commentEnabled: boolean;
  commentGuidance: string;
};

declare global {
  interface Window {
    xiaoxiMomentsCampaign?: {
      status: () => Promise<MomentsCampaignResult>;
      configureDaily: (payload: DailyPayload) => Promise<MomentsCampaignResult>;
      start: (payload: StartPayload) => Promise<MomentsCampaignResult>;
      runDailyNow: () => Promise<MomentsCampaignResult>;
      pause: () => Promise<MomentsCampaignResult>;
      stop: () => Promise<MomentsCampaignResult>;
      onUpdate: (callback: (state: MomentsCampaignState) => void) => () => void;
    };
  }
}

const EMPTY_DAILY_STATE: MomentsDailyAutomationState = {
  enabled: false,
  target: 20,
  start_time: "09:00",
  like_enabled: true,
  comment_enabled: false,
  comment_guidance: "",
  date: "",
  completed_count: 0,
  checked_count: 0,
  skipped_count: 0,
  remaining_count: 20,
  suppressed_date: "",
  blocked_reason: "",
  last_reason: "",
  last_run_at: "",
  next_run_at: "",
  updated_at: "",
  status: "disabled"
};

const EMPTY_STATE: MomentsCampaignState = {
  status: "idle",
  max_posts: 10,
  processed_count: 0,
  completed_post_count: 0,
  liked_count: 0,
  already_liked_count: 0,
  commented_count: 0,
  comment_skipped_count: 0,
  skipped_count: 0,
  scroll_count: 0,
  current_post: 0,
  like_enabled: true,
  comment_enabled: false,
  comment_guidance: "",
  outcome_unknown: false,
  last_reason: "",
  started_at: "",
  updated_at: "",
  daily_automation: EMPTY_DAILY_STATE
};

const REASON_LABELS: Record<string, string> = {
  starting: "正在打开朋友圈",
  moments_discover_entry_ambiguous: "识别到多个“发现”入口，已停止且没有继续点击",
  moments_discover_entry_not_found: "未能唯一识别新版微信侧栏的“发现”图标，已停止",
  moments_discover_entry_not_owned: "“发现”入口不属于已绑定的微信窗口，已停止",
  moments_discover_open_timeout: "已打开“发现”，但未能唯一识别“朋友圈”，尚未执行互动",
  moments_entry_ambiguous: "识别到多个朋友圈入口，已停止且没有继续点击",
  moments_entry_not_found: "未能唯一识别朋友圈入口，已停止",
  observing_post: "正在识别当前帖子",
  reading_post_body: "正在读取正文",
  locating_interaction_menu: "正在定位互动菜单",
  generating_comment: "正在根据帖子正文生成评论",
  executing_comment: "正在执行评论",
  sending_comment: "正在执行评论",
  commented_verified: "评论已发送并复核",
  liked_verified: "点赞成功并已复核",
  already_liked: "当前帖子已经点赞，未重复操作",
  post_already_processed_in_run: "当前帖子本轮已经处理，正在继续下滑",
  post_already_recorded: "当前帖子历史任务已经处理，未重复操作",
  moments_post_changed_before_comment: "生成评论期间帖子位置发生变化，本条评论已跳过",
  moments_comment_content_incomplete: "当前帖子正文采集不完整，已跳过 AI 评论并继续下滑",
  moments_interaction_menu_not_found: "未能重新定位当前帖子的互动菜单，已跳过该帖子",
  moments_post_changed_while_reading: "分段读取时帖子身份发生变化，已跳过原帖子",
  moments_comment_ai_failed: "本条AI评论生成失败，已跳过并继续",
  scrolled: "已下滑，正在寻找下一条",
  target_count_reached: "已完成本轮目标",
  target_not_reached: "本轮已结束，但启用的动作未全部成功",
  pause_requested: "正在完成当前步骤后暂停",
  paused_by_user: "已暂停",
  stop_requested: "正在停止",
  stopped_by_user: "已结束",
  moments_daily_start_time_invalid: "每日开始时间格式不正确",
  moments_action_missing: "请至少选择点赞或AI评论中的一项",
  moments_comment_ai_unavailable: "AI评论服务尚未配置，暂时不能启用每日评论",
  moments_daily_not_enabled: "请先启用并保存每日计划",
  moments_campaign_already_running: "朋友圈任务正在运行，请稍后再试",
  wechat_operation_busy: "微信正在执行其他任务，稍后会自动再试",
  runtime_coordinator_failed: "微信任务协调器暂时不可用",
  moments_daily_evaluate_failed: "每日计划调度失败，已记录诊断日志",
  moments_daily_initialize_failed: "每日计划状态恢复失败，已记录诊断日志",
  daily_startup_resume_pending: "已恢复今日进度；为避免启动时抢占微信，请确认后续跑今日剩余"
};

const STATUS_LABELS: Record<string, string> = {
  idle: "未启动",
  running: "运行中",
  paused: "已暂停",
  stopped: "已结束",
  completed: "已完成",
  partial: "未全部完成"
};

const DAILY_STATUS_LABELS: Record<string, string> = {
  disabled: "未启用",
  waiting: "等待执行",
  pending_resume: "待续跑",
  running: "正在执行",
  completed: "今日已完成",
  paused: "今日已暂停"
};

function formatNextRun(value: string) {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function reasonLabel(reason: string, fallback: string) {
  return REASON_LABELS[reason] || reason || fallback;
}

function campaignStateVersion(value: MomentsCampaignState) {
  const daily = value.daily_automation || EMPTY_DAILY_STATE;
  return [
    value.updated_at,
    value.status,
    value.processed_count,
    value.completed_post_count,
    value.current_post,
    value.last_reason,
    daily.updated_at,
    daily.status,
    daily.enabled,
    daily.target,
    daily.start_time,
    daily.completed_count,
    daily.checked_count,
    daily.suppressed_date,
    daily.blocked_reason,
    daily.next_run_at,
    daily.last_reason
  ].join("|");
}

export default function MomentsCampaignPanel() {
  const api = window.xiaoxiMomentsCampaign;
  const [maxPosts, setMaxPosts] = useState(5);
  const [likeEnabled, setLikeEnabled] = useState(true);
  const [commentEnabled, setCommentEnabled] = useState(false);
  const [commentGuidance, setCommentGuidance] = useState("");
  const [dailyEnabled, setDailyEnabled] = useState(false);
  const [dailyTarget, setDailyTarget] = useState(20);
  const [dailyStartTime, setDailyStartTime] = useState("09:00");
  const [state, setState] = useState<MomentsCampaignState>(EMPTY_STATE);
  const [error, setError] = useState("");
  const dailyFormDirty = useRef(false);
  const dailyFormHydrated = useRef(false);
  const acceptState = useCallback((next: MomentsCampaignState) => {
    setState((current) => (
      campaignStateVersion(current) === campaignStateVersion(next) ? current : next
    ));
  }, []);

  useEffect(() => {
    if (!api) return;
    let disposed = false;
    let liveStateSeen = false;
    const hydrateDailyForm = (next: MomentsCampaignState) => {
      if (dailyFormDirty.current || dailyFormHydrated.current) return;
      const daily = next.daily_automation;
      if (!daily) return;
      setDailyEnabled(daily.enabled);
      setDailyTarget(daily.target);
      setDailyStartTime(daily.start_time);
      setLikeEnabled(daily.like_enabled);
      setCommentEnabled(daily.comment_enabled);
      setCommentGuidance(daily.comment_guidance);
      dailyFormHydrated.current = true;
    };
    const unsubscribe = api.onUpdate((next) => {
      if (disposed) return;
      liveStateSeen = true;
      acceptState(next);
      hydrateDailyForm(next);
    });
    void api.status().then((result) => {
      if (disposed || liveStateSeen || dailyFormDirty.current || !result?.state) return;
      acceptState(result.state);
      hydrateDailyForm(result.state);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [acceptState, api]);

  const running = state.status === "running";

  const start = () => {
    if (!api) return;
    if (!likeEnabled && !commentEnabled) {
      setError("请至少选择点赞或AI评论中的一项。");
      return;
    }
    setError("");
    void api.start({
      maxPosts,
      likeEnabled,
      commentEnabled,
      commentGuidance
    }).then((result) => {
      if (result?.state) acceptState(result.state);
      if (!result?.ok) setError(result?.reason || "朋友圈连续任务未能启动");
    }).catch(() => setError("朋友圈连续任务启动失败"));
  };

  const pause = () => {
    if (!api) return;
    void api.pause().then((result) => {
      if (result?.state) acceptState(result.state);
    });
  };

  const stop = () => {
    if (!api) return;
    void api.stop().then((result) => {
      if (result?.state) acceptState(result.state);
    });
  };

  const saveDaily = () => {
    if (!api) return;
    dailyFormDirty.current = true;
    if (dailyEnabled && !likeEnabled && !commentEnabled) {
      setError("启用每日计划前，请至少选择点赞或AI评论中的一项。");
      return;
    }
    setError("");
    void api.configureDaily({
      enabled: dailyEnabled,
      target: dailyTarget,
      startTime: dailyStartTime,
      likeEnabled,
      commentEnabled,
      commentGuidance
    }).then((result) => {
      if (result?.state) acceptState(result.state);
      if (!result?.ok) setError(reasonLabel(result?.reason || "", "每日计划保存失败"));
    }).catch(() => setError("每日计划保存失败"));
  };

  const runDailyNow = () => {
    if (!api) return;
    setError("");
    void api.runDailyNow().then((result) => {
      if (result?.state) acceptState(result.state);
      if (!result?.ok) setError(reasonLabel(result?.reason || "", "今日剩余任务未能启动"));
    }).catch(() => setError("今日剩余任务启动失败"));
  };

  const daily = state.daily_automation || EMPTY_DAILY_STATE;
  const startLabel = commentEnabled
    ? (likeEnabled ? "启动点赞并评论" : "启动连续评论")
    : "启动连续点赞";

  return (
    <section className="dev-acceptance moments-dry-run-card">
      <div className="dev-acceptance-head">
        <Play size={18} />
        <strong>朋友圈连续互动</strong>
        <span>逐帖点赞 · AI定制评论</span>
      </div>
      <div className="moments-daily-plan">
        <div className="moments-daily-plan-row">
          <label className="moments-action-toggle">
            <input
              type="checkbox"
              checked={dailyEnabled}
              disabled={running}
              onChange={(event) => {
                dailyFormDirty.current = true;
                setDailyEnabled(event.target.checked);
              }}
            />
            每日自动执行
          </label>
          <label>
            每天完成
            <input
              type="number"
              min={1}
              max={50}
              value={dailyTarget}
              disabled={running}
              onChange={(event) => {
                dailyFormDirty.current = true;
                setDailyTarget(Math.max(1, Math.min(50, Number(event.target.value) || 1)));
              }}
            />
            条
          </label>
          <label>
            开始时间
            <input
              type="time"
              value={dailyStartTime}
              disabled={running}
              onChange={(event) => {
                dailyFormDirty.current = true;
                setDailyStartTime(event.target.value);
              }}
            />
          </label>
          <button onClick={saveDaily} disabled={running}>保存每日计划</button>
          <button
            data-xiaoxi-moments-daily-run
            className="primary-button"
            onClick={runDailyNow}
            disabled={running || !daily.enabled || daily.remaining_count <= 0}
          >
            <Play size={15} />立即执行今日剩余
          </button>
        </div>
        <div className="moments-daily-summary">
          <span>计划：{DAILY_STATUS_LABELS[daily.status] || daily.status}</span>
          <span>今日完成：{daily.completed_count}/{daily.target}</span>
          <span>剩余：{daily.remaining_count}</span>
          <span>今日检查：{daily.checked_count}</span>
          <span>下次执行：{formatNextRun(daily.next_run_at)}</span>
          {daily.blocked_reason && (
            <span>说明：{reasonLabel(daily.blocked_reason, daily.blocked_reason)}</span>
          )}
        </div>
        <p>
          保持程序运行时会按计划自动执行；重新打开程序只恢复今日进度，不会立刻打开微信或朋友圈。错过时间或中断后，可点击“立即执行今日剩余”继续。
        </p>
      </div>
      <div className="dev-control-row moments-campaign-controls">
        <label>
          本轮目标完成
          <input
            type="number"
            min={1}
            max={50}
            value={maxPosts}
            disabled={running}
            onChange={(event) => setMaxPosts(Math.max(1, Math.min(50, Number(event.target.value) || 1)))}
          />
          条
        </label>
        <label className="moments-action-toggle">
          <input
            type="checkbox"
            checked={likeEnabled}
            disabled={running}
            onChange={(event) => {
              dailyFormDirty.current = true;
              setLikeEnabled(event.target.checked);
            }}
          />
          点赞
        </label>
        <label className="moments-action-toggle">
          <input
            type="checkbox"
            checked={commentEnabled}
            disabled={running}
            onChange={(event) => {
              dailyFormDirty.current = true;
              setCommentEnabled(event.target.checked);
            }}
          />
          AI评论
        </label>
        <button
          data-xiaoxi-moments-campaign-start
          className="primary-button"
          onClick={start}
          disabled={running}
        >
          <Play size={15} />{startLabel}
        </button>
        <button onClick={pause} disabled={!running}><Pause size={15} />暂停</button>
        <button onClick={stop} disabled={!running}><Square size={15} />结束</button>
      </div>
      {commentEnabled && (
        <div className="moments-comment-field">
          <label>
            评论偏好（选填）
            <textarea
              value={commentGuidance}
              maxLength={200}
              disabled={running}
              placeholder="例如：语气亲切一点；只评论产品和工作内容。留空则完全按帖子正文生成。"
              onChange={(event) => {
                dailyFormDirty.current = true;
                setCommentGuidance(event.target.value);
              }}
            />
          </label>
        </div>
      )}
      <div className="moments-campaign-metrics">
        <span>状态：{STATUS_LABELS[state.status] || state.status}</span>
        <span>已检查：{state.processed_count}</span>
        <span>目标完成：{state.completed_post_count}/{state.max_posts}</span>
        <span>新点赞：{state.liked_count}</span>
        <span>原已点赞：{state.already_liked_count}</span>
        <span>已评论：{state.commented_count}</span>
        <span>评论跳过：{state.comment_skipped_count}</span>
        <span>下滑：{state.scroll_count}</span>
      </div>
      <p className="dev-contact-summary">
        启动后自动打开朋友圈并逐帖执行。AI评论只依据当前帖子正文生成；单条生成或发送前检查失败时跳过该评论并继续，发送结果不确定时会暂停，避免重复评论。
      </p>
      <div
        className={`dev-status ${
          error || state.status === "paused" || state.status === "partial" ? "is-blocked" : ""
        }`}
        aria-live="polite"
      >
        {error || REASON_LABELS[state.last_reason] || state.last_reason || "尚未启动"}
      </div>
    </section>
  );
}
