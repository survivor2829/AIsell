import { Pause, Play, Square } from "lucide-react";
import { useEffect, useState } from "react";
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
  last_reason: string;
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

declare global {
  interface Window {
    xiaoxiMomentsCampaign?: {
      status: () => Promise<MomentsCampaignResult>;
      start: (payload: StartPayload) => Promise<MomentsCampaignResult>;
      pause: () => Promise<MomentsCampaignResult>;
      stop: () => Promise<MomentsCampaignResult>;
      onUpdate: (callback: (state: MomentsCampaignState) => void) => () => void;
    };
  }
}

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
  last_reason: ""
};

const REASON_LABELS: Record<string, string> = {
  starting: "正在打开朋友圈",
  observing_post: "正在识别当前帖子",
  generating_comment: "正在根据帖子正文生成评论",
  sending_comment: "正在发送并复核评论",
  commented_verified: "评论已发送并复核",
  liked_verified: "点赞成功并已复核",
  already_liked: "当前帖子已经点赞，未重复操作",
  post_already_processed_in_run: "当前帖子本轮已经处理，正在继续下滑",
  post_already_recorded: "当前帖子历史任务已经处理，未重复操作",
  moments_post_changed_before_comment: "生成评论期间帖子位置发生变化，本条评论已跳过",
  moments_comment_ai_failed: "本条AI评论生成失败，已跳过并继续",
  scrolled: "已下滑，正在寻找下一条",
  target_count_reached: "已完成本轮目标",
  target_not_reached: "本轮已结束，但启用的动作未全部成功",
  pause_requested: "正在完成当前步骤后暂停",
  paused_by_user: "已暂停",
  stop_requested: "正在停止",
  stopped_by_user: "已结束"
};

const STATUS_LABELS: Record<string, string> = {
  idle: "未启动",
  running: "运行中",
  paused: "已暂停",
  stopped: "已结束",
  completed: "已完成",
  partial: "未全部完成"
};

export default function MomentsCampaignPanel() {
  const api = window.xiaoxiMomentsCampaign;
  const [maxPosts, setMaxPosts] = useState(5);
  const [likeEnabled, setLikeEnabled] = useState(true);
  const [commentEnabled, setCommentEnabled] = useState(false);
  const [commentGuidance, setCommentGuidance] = useState("");
  const [state, setState] = useState<MomentsCampaignState>(EMPTY_STATE);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!api) return;
    void api.status().then((result) => {
      if (result?.state) setState(result.state);
    });
    return api.onUpdate((next) => setState(next));
  }, [api]);

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
      if (result?.state) setState(result.state);
      if (!result?.ok) setError(result?.reason || "朋友圈连续任务未能启动");
    }).catch(() => setError("朋友圈连续任务启动失败"));
  };

  const pause = () => {
    if (!api) return;
    void api.pause().then((result) => {
      if (result?.state) setState(result.state);
    });
  };

  const stop = () => {
    if (!api) return;
    void api.stop().then((result) => {
      if (result?.state) setState(result.state);
    });
  };

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
            onChange={(event) => setLikeEnabled(event.target.checked)}
          />
          点赞
        </label>
        <label className="moments-action-toggle">
          <input
            type="checkbox"
            checked={commentEnabled}
            disabled={running}
            onChange={(event) => setCommentEnabled(event.target.checked)}
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
              onChange={(event) => setCommentGuidance(event.target.value)}
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
