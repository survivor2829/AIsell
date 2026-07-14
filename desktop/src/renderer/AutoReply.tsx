import { Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";

type AutoReplyState = {
  status: string;
  reply_count: number;
  last_error: string;
};
type AutoReplyResult = { ok: boolean; state?: Partial<AutoReplyState>; error?: string };

declare global {
  interface Window {
    xiaoxiAutoReply?: {
      status: () => Promise<AutoReplyResult>;
      start: () => Promise<AutoReplyResult>;
      pause: () => Promise<AutoReplyResult>;
    };
  }
}

const EMPTY_STATE: AutoReplyState = {
  status: "stopped",
  reply_count: 0,
  last_error: ""
};

export function AutoReply() {
  const [state, setState] = useState<AutoReplyState>(EMPTY_STATE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const applyResult = (result: AutoReplyResult, clearOperationError = true) => {
    if (result.state) setState((current) => ({ ...current, ...result.state }));
    if (!result.ok) setError(result.error || "自动回复操作失败");
    else if (clearOperationError) setError("");
  };

  const refresh = () => {
    if (!window.xiaoxiAutoReply) return setError("当前版本未连接自动回复执行器");
    void window.xiaoxiAutoReply.status().then((result) => applyResult(result, false)).catch(() => setError("读取自动回复状态失败"));
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
  const statusLabel = running ? "监听中" : starting ? "启动中" : state.status === "paused" ? "已暂停" : "未启动";

  return (
    <section className="page agent-page auto-reply-page">
      <div className="page-head">
        <div>
          <h1>自动回复</h1>
          <p>启动后监听新消息，并使用已导入的 AI 专家资料生成回复。</p>
        </div>
        <div className="actions">
          {running ? (
            <button className="danger-button" onClick={() => window.xiaoxiAutoReply && run(() => window.xiaoxiAutoReply!.pause(), "暂停自动回复失败")} disabled={busy}>
              <Pause size={17} />暂停自动回复
            </button>
          ) : (
            <button data-xiaoxi-auto-reply-start className="primary-button" onClick={() => window.xiaoxiAutoReply ? run(() => window.xiaoxiAutoReply!.start(), "启动自动回复失败") : setError("当前版本未连接自动回复执行器")} disabled={busy || starting}>
              <Play size={17} />启动自动回复
            </button>
          )}
        </div>
      </div>

      <div className="status-strip auto-reply-status">
        <div className="status-card"><span>运行状态</span><strong className={running ? "ok" : "warn"}>{statusLabel}</strong></div>
        <div className="status-card"><span>今日已回复</span><strong>{state.reply_count}</strong></div>
      </div>

      {(error || state.last_error) && <div className="touch-notice" role="alert">{error || state.last_error}</div>}
    </section>
  );
}
