import { Pause, Play, Square } from "lucide-react";
import { useEffect, useState } from "react";
import "./MomentsDryRunPanel.css";

type MomentsCampaignState = {
  status: string;
  max_posts: number;
  processed_count: number;
  liked_count: number;
  already_liked_count: number;
  skipped_count: number;
  scroll_count: number;
  current_post: number;
  last_reason: string;
};

type MomentsCampaignResult = {
  ok: boolean;
  reason?: string;
  state: MomentsCampaignState;
};

declare global {
  interface Window {
    xiaoxiMomentsCampaign?: {
      status: () => Promise<MomentsCampaignResult>;
      start: (payload: { maxPosts: number }) => Promise<MomentsCampaignResult>;
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
  liked_count: 0,
  already_liked_count: 0,
  skipped_count: 0,
  scroll_count: 0,
  current_post: 0,
  last_reason: ""
};

const REASON_LABELS: Record<string, string> = {
  starting: "正在打开朋友圈",
  observing_post: "正在识别当前帖子",
  liked_verified: "点赞成功并已复核",
  already_liked: "当前帖子已经点赞，未重复操作",
  post_already_processed_in_run: "当前帖子本轮已经处理，正在继续下滑",
  post_already_recorded: "当前帖子历史任务已经处理，未重复操作",
  scrolled: "已下滑，正在寻找下一条",
  target_count_reached: "已完成本轮目标",
  pause_requested: "正在完成当前步骤后暂停",
  paused_by_user: "已暂停",
  stop_requested: "正在停止",
  stopped_by_user: "已结束"
};

export default function MomentsCampaignPanel() {
  const api = window.xiaoxiMomentsCampaign;
  const [maxPosts, setMaxPosts] = useState(5);
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
    setError("");
    void api.start({ maxPosts }).then((result) => {
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

  return (
    <section className="dev-acceptance moments-dry-run-card">
      <div className="dev-acceptance-head">
        <Play size={18} />
        <strong>朋友圈连续点赞</strong>
        <span>第一阶段 · 暂不评论</span>
      </div>
      <div className="dev-control-row">
        <label>
          本轮最多处理
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
        <button
          data-xiaoxi-moments-campaign-start
          className="primary-button"
          onClick={start}
          disabled={running}
        >
          <Play size={15} />启动连续点赞
        </button>
        <button onClick={pause} disabled={!running}><Pause size={15} />暂停</button>
        <button onClick={stop} disabled={!running}><Square size={15} />结束</button>
      </div>
      <div className="moments-campaign-metrics">
        <span>状态：{state.status}</span>
        <span>已处理：{state.processed_count}/{state.max_posts}</span>
        <span>新点赞：{state.liked_count}</span>
        <span>原已点赞：{state.already_liked_count}</span>
        <span>下滑：{state.scroll_count}</span>
      </div>
      <p className="dev-contact-summary">
        启动后自动打开朋友圈、逐帖点赞并下滑；同一帖子不会重复点赞。暂停会在当前识别或点击步骤结束后生效。
      </p>
      <div className={`dev-status ${error || state.status === "paused" ? "is-blocked" : ""}`} aria-live="polite">
        {error || REASON_LABELS[state.last_reason] || state.last_reason || "尚未启动"}
      </div>
    </section>
  );
}
