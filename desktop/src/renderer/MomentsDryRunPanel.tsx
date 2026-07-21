import { MessageCircle, RefreshCw, Search, ThumbsUp } from "lucide-react";
import { useState } from "react";
import "./MomentsDryRunPanel.css";

type MomentsAction = "inspect" | "like" | "comment";

const MOMENTS_DRY_RUN_UI_TIMEOUT_MS = 50_000;
const MOMENTS_INSPECT_UI_TIMEOUT_MS = 110_000;

const ACTION_BLOCK_MESSAGES: Record<string, string> = {
  moments_action_state_persist_failed: "动作状态无法安全保存，请勿继续操作。",
  moments_attempt_already_recorded: "同一帖子上的相同动作已有记录，本次不再重复执行。",
  moments_comment_duplicate: "原帖评论区已存在完全相同的评论，未重复发送。",
  moments_comment_text_already_attempted: "完全相同的评论文案已有发送尝试记录，已在操作微信前阻断。",
  moments_comment_editor_targeting_unsupported: "当前微信版本没有提供可安全定向的评论编辑框，未写入草稿、未发送评论。",
  moments_comment_send_targeting_unsupported: "当前微信版本已通过评论框草稿检查，但安全发送与原帖回读尚未开放。",
  moments_comment_draft_check_failed: "评论框只读能力检查异常，未写入草稿、未发送评论。",
  moments_comment_draft_proof_invalid: "评论框草稿往返证明不完整，未发送评论。",
  moments_comment_draft_close_unverified: "无法确认测试草稿已精确清空并关闭，已停止且不会发送评论。",
  moments_comment_editor_focus_invalid: "无法确认焦点属于原帖评论框，未输入或发送。",
  moments_external_input_detected: "检测到其他鼠标或键盘输入，已停止且未发送；请暂时不要操作后重试。",
  moments_comment_region_ambiguous: "无法唯一确认原帖评论区，未输入或发送。",
  moments_comment_send_button_ambiguous: "无法唯一确认评论发送按钮，草稿已清理并停止。",
  moments_dry_run_expired: "观察锁已超过 5 分钟，请重新预演。",
  moments_like_not_in_dry_run: "本次预演未启用点赞，请重新选择后预演。",
  runtime_coordinator_failed: "微信运行锁获取失败，未执行操作。",
  runtime_coordinator_unavailable: "微信运行锁不可用，未执行操作。",
  wechat_operation_busy: "联系人同步、主动触达或自动回复正在使用微信，请稍后再试。"
};

export default function MomentsDryRunPanel() {
  const [mode, setMode] = useState<"targeted" | "random">("targeted");
  const [likeEnabled, setLikeEnabled] = useState(true);
  const [commentEnabled, setCommentEnabled] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [observationId, setObservationId] = useState("");
  const [menuVerified, setMenuVerified] = useState(false);
  const [commentSendSupported, setCommentSendSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requiresRestart, setRequiresRestart] = useState(false);
  const [status, setStatus] = useState("尚未预演。将从当前可见内容中稳定选择一条朋友圈内容。");
  const [statusBlocked, setStatusBlocked] = useState(false);

  const invalidateObservation = () => {
    setMenuVerified(false);
    setCommentSendSupported(false);
    if (!observationId) return;
    setObservationId("");
    setStatusBlocked(true);
    setStatus("配置已更改，原观察锁已失效。请重新检查并生成预演。");
  };

  const runDryRun = () => {
    if (requiresRestart) return;
    const executor = window.xiaoxiActiveTouch?.momentsDryRun;
    if (!executor) {
      setStatusBlocked(true);
      setStatus("朋友圈预演仅在内部测试版开放。");
      return;
    }
    setObservationId("");
    setMenuVerified(false);
    setCommentSendSupported(false);
    setBusy(true);
    setStatusBlocked(false);
    setStatus("正在只读识别当前朋友圈窗口和可见内容…");
    let timedOut = false;
    const watchdog = window.setTimeout(() => {
      timedOut = true;
      setObservationId("");
      setMenuVerified(false);
      setCommentSendSupported(false);
      setRequiresRestart(true);
      setStatusBlocked(true);
      setStatus("只读预演结果等待超时，未生成可执行观察锁。为避免重叠调用，请重启 AI获客 后再继续；本次未点赞、未发送评论。");
      setBusy(false);
    }, MOMENTS_DRY_RUN_UI_TIMEOUT_MS);
    void executor({ mode, likeEnabled, commentEnabled, commentText }).then((result) => {
      if (timedOut) return;
      if (!result.ok) {
        const neutralCandidateReasons = [
          "moments_post_not_found",
          "moments_post_ambiguous",
          "moments_post_changed",
          "moments_post_identity_missing"
        ];
        setStatusBlocked(!neutralCandidateReasons.includes(result.blocked_reason || ""));
        setStatus(result.blocked_reason === "moments_window_not_found" ? "未识别到朋友圈窗口，请先在微信中打开朋友圈。" : result.error || "朋友圈安全预演未通过。");
        return;
      }
      if (!result.post_snapshot?.observation_id) {
        setStatusBlocked(true);
        setStatus("朋友圈内容快照缺失，已停止预演。");
        return;
      }
      setObservationId(result.post_snapshot.observation_id);
      const order = result.plan?.action_order.map((action) => action === "comment" ? "评论" : "点赞").join(" → ") || "无动作";
      const visibleCount = result.plan?.visible_post_count || 1;
      const targetNotice = visibleCount > 1 ? `；已从当前 ${visibleCount} 条可操作内容中自动选择` : "";
      setStatus(`已锁定目标内容：${result.post_snapshot.preview}；计划：${order}${targetNotice}。观察锁 5 分钟内有效，请先点击“检查互动菜单”。`);
    }).catch(() => {
      if (timedOut) return;
      setStatusBlocked(true);
      setStatus("朋友圈安全预演执行失败，请稍后重试。");
    }).finally(() => {
      window.clearTimeout(watchdog);
      if (!timedOut) setBusy(false);
    });
  };

  const runAction = (action: MomentsAction) => {
    const api = window.xiaoxiActiveTouch;
    if (!api || !observationId) {
      setStatusBlocked(true);
      setStatus("请先完成朋友圈预演并取得观察锁。");
      return;
    }
    setBusy(true);
    setStatusBlocked(false);
    setStatus(action === "inspect"
      ? commentEnabled
        ? "正在检查互动菜单和评论框草稿往返，不会点赞或发送评论…"
        : "正在检查互动菜单，不会点赞或评论…"
      : action === "like"
        ? "正在执行单次点赞并复核状态…"
        : "正在执行单次评论并复核结果…");
    const operation = action === "inspect"
      ? api.momentsInspectMenu({ observationId })
      : action === "like"
        ? api.momentsLike({ observationId })
        : api.momentsComment({ observationId, commentText });
    let inspectTimedOut = false;
    const inspectWatchdog = action === "inspect" ? window.setTimeout(() => {
      inspectTimedOut = true;
      setObservationId("");
      setMenuVerified(false);
      setCommentSendSupported(false);
      setRequiresRestart(true);
      setStatusBlocked(true);
      setStatus("互动菜单只读检查等待超时，观察锁已废弃。为避免重叠调用，请重启 AI获客 后再继续；本次未点赞、未发送评论。");
      setBusy(false);
    }, MOMENTS_INSPECT_UI_TIMEOUT_MS) : null;
    void operation.then((result) => {
      if (inspectTimedOut) return;
      if (action !== "inspect") {
        setObservationId("");
        setMenuVerified(false);
        setCommentSendSupported(false);
      }
      if (!result.ok) {
        if (action === "inspect") {
          setObservationId("");
          setMenuVerified(false);
          setCommentSendSupported(false);
        }
        setStatusBlocked(true);
        const outcome = result.retry_locked && result.real_action_attempted === false
          ? "本次已确认未点击或发送，但为避免边界状态下重复执行，同一帖子上的相同动作仍已安全锁定；重新预演也不会再次执行该动作。"
          : result.status === "outcome_unknown"
            ? "操作可能已经发出，但结果无法确认。该动作已锁定为不可重试，避免重复点赞或评论。"
            : result.error || ACTION_BLOCK_MESSAGES[result.blocked_reason || ""] || "朋友圈操作未通过。";
        setStatus(`${outcome} 已停止且不会自动重试。如需进行其他操作，请重新预演。`);
        return;
      }
      if (action === "inspect") {
        setMenuVerified(true);
        setCommentSendSupported(result.comment_send_supported === true);
        const likeState = result.menu_state === "赞" ? "当前未点赞" : "当前已点赞";
        setStatus(result.comment_draft_verified
          ? result.comment_send_supported
            ? `互动菜单和评论框检查通过（${likeState}）；测试草稿已逐字回读、精确清空并关闭，本次未点赞、未发送评论。`
            : `互动菜单和评论框草稿检查通过（${likeState}）；测试草稿已逐字回读、精确清空并关闭。当前微信版本仍只开放草稿检查，未开放评论发送。`
          : `互动菜单检查通过，点赞和评论入口可识别（${likeState}）；本次未点赞、未发送评论。`);
      } else if (action === "like") {
        setStatus(result.no_op
          ? "原帖已是点赞状态，本次未重复点击。观察锁已消费，如需继续请重新预演。"
          : "单次点赞已执行并通过状态复核。观察锁已消费，如需继续请重新预演。");
      } else {
        setStatus(result.verification_level === "clipboard_exact"
          ? "单次评论已发送，并通过原帖可见文字与右键复制完成增强验收。观察锁已消费，如需继续请重新预演。"
          : result.verification_level === "visible_exact"
            ? "单次评论已发送；已在原帖唯一识别到相同评论，并复核帖子锚点与评论候选稳定。观察锁已消费，如需继续请重新预演。"
            : "单次评论已发送并通过原帖结果复核。观察锁已消费，如需继续请重新预演。");
      }
    }).catch(() => {
      if (inspectTimedOut) return;
      setObservationId("");
      setMenuVerified(false);
      setCommentSendSupported(false);
      setStatusBlocked(true);
      setStatus(`朋友圈${action === "inspect" ? "菜单检查" : action === "like" ? "点赞" : "评论"}执行异常，已停止且不会自动重试。`);
    }).finally(() => {
      if (inspectWatchdog !== null) window.clearTimeout(inspectWatchdog);
      if (!inspectTimedOut) setBusy(false);
    });
  };

  return (
    <section className="dev-acceptance moments-dry-run-card">
      <div className="dev-acceptance-head">
        <ThumbsUp size={18} />
        <strong>朋友圈单条安全执行</strong>
        <span>测试版 · 单条执行</span>
      </div>
      <div className="dev-control-row">
        <label>
          场景
          <select value={mode} onChange={(event) => { invalidateObservation(); setMode(event.target.value as "targeted" | "random"); }} disabled={busy}>
            <option value="targeted">当前可见测试帖（不校验作者）</option>
            <option value="random">当前朋友圈信息流</option>
          </select>
        </label>
        <label><input type="checkbox" checked={likeEnabled} onChange={(event) => { invalidateObservation(); setLikeEnabled(event.target.checked); }} disabled={busy} />点赞</label>
        <label><input type="checkbox" checked={commentEnabled} onChange={(event) => { invalidateObservation(); setCommentEnabled(event.target.checked); }} disabled={busy} />评论</label>
        <button className="primary-button" onClick={runDryRun} disabled={busy || requiresRestart || (!likeEnabled && !commentEnabled) || (commentEnabled && !commentText.trim())}>
          <RefreshCw size={15} />{busy ? "处理中" : "检查并生成预演"}
        </button>
      </div>
      <label className="script-field moments-comment-field">
        <span>固定评论文案</span>
        <textarea value={commentText} onChange={(event) => { invalidateObservation(); setCommentText(event.target.value); }} disabled={busy || !commentEnabled} maxLength={500} placeholder="启用评论后填写；发送前仍会锁定同一帖子" />
      </label>
      <div className="dev-control-row">
        <button data-xiaoxi-moments-inspect className="primary-button" onClick={() => runAction("inspect")} disabled={busy || !observationId}>
          <Search size={15} />{commentEnabled ? "检查菜单与评论框" : "检查互动菜单"}
        </button>
        <button data-xiaoxi-moments-like onClick={() => runAction("like")} disabled={busy || !observationId || !menuVerified || !likeEnabled}>
          <ThumbsUp size={15} />执行单次点赞
        </button>
        <button data-xiaoxi-moments-comment onClick={() => runAction("comment")} disabled={busy || !observationId || !menuVerified || !commentSendSupported || !commentEnabled || !commentText.trim()}>
          <MessageCircle size={15} />发送单条评论
        </button>
      </div>
      <p className="dev-contact-summary">系统从当前可见内容中选一条并在操作前回锁；相同动作不重复，结果不明不自动补发。</p>
      <div className={`dev-status ${statusBlocked ? "is-blocked" : ""}`} aria-live="polite">{status}</div>
    </section>
  );
}
