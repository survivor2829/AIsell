import { CheckCircle2, ImagePlus, RotateCcw, Send, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import "./MomentsPublishPanel.css";

type MomentsPublishState = {
  status: string;
  draft_id: string;
  fingerprint: string;
  media_count: number;
  media_kind: string;
  action_attempted: boolean;
  outcome_unknown: boolean;
  last_reason: string;
  prepared_at: string;
  clicked_at: string;
  verified_at: string;
  updated_at: string;
};

type MomentsPublishMedia = {
  name: string;
  size: number;
  kind: "image" | "video";
};

type MomentsPublishSelection = {
  selection_id: string;
  media_count: number;
  media_kind: string;
  files: MomentsPublishMedia[];
};

type MomentsPublishResult = {
  ok: boolean;
  reason?: string;
  state: MomentsPublishState;
  selection?: MomentsPublishSelection;
};

type MomentsPublishApi = {
  status: () => Promise<MomentsPublishResult>;
  chooseMedia: () => Promise<MomentsPublishResult>;
  prepare: (payload: { content: string; selectionId: string }) => Promise<MomentsPublishResult>;
  confirm: (payload: { draftId: string }) => Promise<MomentsPublishResult>;
  reset: () => Promise<MomentsPublishResult>;
  resolveUnknown: (payload: {
    resolution: "published" | "not_published";
  }) => Promise<MomentsPublishResult>;
  onUpdate: (callback: (state: MomentsPublishState) => void) => () => void;
};

const EMPTY_STATE: MomentsPublishState = {
  status: "idle",
  draft_id: "",
  fingerprint: "",
  media_count: 0,
  media_kind: "",
  action_attempted: false,
  outcome_unknown: false,
  last_reason: "",
  prepared_at: "",
  clicked_at: "",
  verified_at: "",
  updated_at: ""
};

const REASON_LABELS: Record<string, string> = {
  moments_publish_content_required: "请填写朋友圈正文。",
  moments_publish_content_too_short: "正文太短，请补充后再生成确认。",
  moments_publish_content_too_long: "正文超过 2000 字，请删减后再生成确认。",
  moments_publish_media_required: "请选择 1-9 张图片，或 1 个视频。",
  moments_publish_media_invalid: "素材格式或数量不符合要求，请重新选择。",
  moments_publish_media_type_unsupported: "当前只支持 JPEG/PNG 图片或 MP4/MOV 视频。",
  moments_publish_media_mixed: "图片和视频不能混合发表，请重新选择。",
  moments_publish_image_count_invalid: "一次只能选择 1-9 张图片。",
  moments_publish_video_count_invalid: "一次只能选择 1 个视频。",
  moments_publish_media_unavailable: "素材文件已不可用，请重新选择。",
  moments_publish_media_changed: "素材内容已变化，请重新选择并生成确认。",
  moments_publish_staging_failed: "无法创建本次发布的安全素材快照，请检查磁盘后重试。",
  moments_publish_media_manifest_invalid: "素材快照校验失败，已在发表前停止。",
  moments_publish_media_accessibility_missing: "微信未能可靠证明素材已进入编辑器，已停止发表。",
  moments_publish_media_accessibility_count_mismatch: "微信编辑器中的素材数量与确认摘要不一致，已停止发表。",
  moments_publish_media_accessibility_aggregate: "微信只返回了聚合素材信息，无法逐一核对，已停止发表。",
  moments_publish_media_accessibility_not_one_to_one: "微信编辑器中的素材无法逐项唯一对应，已停止发表。",
  moments_publish_media_accessibility_changed: "微信编辑器中的素材在最终确认前发生变化，已停止发表。",
  moments_publish_selection_expired: "素材选择已失效，请重新选择。",
  moments_publish_draft_changed: "待发表内容已经变化，请重新生成发布确认。",
  moments_publish_confirmation_required: "请先生成发布确认。",
  moments_publish_already_running: "朋友圈发布正在执行，请等待本次结果。",
  wechat_operation_busy: "微信正在执行其他任务，请稍后再试。",
  moments_window_not_found: "未找到可安全操作的朋友圈窗口。",
  moments_window_open_timeout: "微信已响应，但未能在时限内确认朋友圈页面；尚未点击发表。",
  moments_discover_entry_ambiguous: "识别到多个“发现”入口，已停止且尚未打开发布页。",
  moments_discover_entry_not_found: "未能唯一识别新版微信侧栏的“发现”图标，已停止。",
  moments_discover_entry_not_owned: "“发现”入口不属于已绑定的微信窗口，已停止。",
  moments_discover_open_timeout: "已打开“发现”，但未能唯一识别“朋友圈”；尚未点击发表。",
  moments_entry_ambiguous: "识别到多个朋友圈入口，已停止且尚未点击发表。",
  moments_entry_not_found: "未能唯一识别朋友圈入口，已停止且尚未点击发表。",
  moments_publish_integrated_surface_not_proven: "未能在微信主窗口中可靠确认朋友圈页面，已停止发表。",
  moments_publish_camera_not_found: "未能安全定位朋友圈发布入口。",
  moments_publish_file_dialog_missing: "未能确认属于朋友圈窗口的文件选择框。",
  moments_publish_file_name_field_missing: "已打开微信文件框，但未识别到标准“文件名”输入控件；尚未选择文件或发表。",
  moments_publish_file_name_field_ambiguous: "微信文件框返回了多个“文件名”输入控件；为避免选错素材，已停止。",
  moments_publish_file_name_focus_failed: "已打开微信文件框，但未能切换到“文件名”输入位置；尚未选择文件或发表。",
  moments_publish_file_name_set_failed: "未能把已选素材地址写入微信文件框；尚未选择文件或发表。",
  moments_publish_file_name_readback_mismatch: "微信文件框中的素材地址与已选素材不一致；为避免发错图片，已停止。",
  moments_publish_file_dialog_did_not_close: "已向微信文件框提交素材，但窗口没有关闭；尚未发表，请根据当前窗口状态人工确认。",
  moments_publish_open_button_ambiguous: "微信文件框返回了重复的“打开”控件；尚未选择文件或发表。",
  moments_publish_open_button_missing: "未找到微信文件框的标准“打开”控件；尚未选择文件或发表。",
  moments_publish_open_button_identity_mismatch: "微信文件框的“打开”控件身份不符合预期；已停止。",
  moments_publish_open_button_uia_missing: "无法读取微信文件框的“打开”控件位置；已停止。",
  moments_publish_open_button_failed: "微信文件框未能确认素材；尚未发表。",
  moments_publish_composer_owner_missing: "微信主窗口身份已经变化，未继续操作朋友圈编辑器。",
  moments_publish_composer_not_found: "图片已提交，但未找到微信新建的朋友圈编辑窗口；尚未发表。",
  moments_publish_composer_ambiguous: "检测到多个朋友圈编辑窗口；为避免发错窗口，已停止。",
  moments_publish_composer_not_foreground: "朋友圈编辑窗口不在前台，已在填写正文或发表前停止。",
  moments_publish_media_visual_missing: "未能在朋友圈编辑窗口中确认已选素材，尚未发表；如编辑窗仍在，请先点取消再重试。",
  moments_publish_media_visual_changed: "朋友圈编辑窗口中的素材状态发生变化，已停止发表。",
  moments_publish_editor_focus_missing: "未能确认朋友圈正文编辑器。",
  moments_publish_editor_not_writable: "朋友圈正文编辑器当前不可安全写入。",
  moments_publish_editor_ambiguous: "检测到多个可能的正文编辑器，已停止发表。",
  moments_publish_editor_not_empty: "朋友圈编辑器中已有草稿内容，请先人工清空后重试。",
  moments_publish_editor_outside_render_pane: "正文编辑器不属于已绑定的朋友圈窗口。",
  moments_publish_clipboard_readback_failed: "未能完整回读朋友圈正文，已在发表前停止；如编辑窗仍在，请先点取消再重试。",
  moments_publish_clipboard_restore_failed: "正文核对后未能恢复剪贴板，已在发表前停止；请检查剪贴板，并取消当前微信编辑窗。",
  moments_publish_content_readback_mismatch: "正文写入后的完整回读不一致，已停止发表；请取消当前微信编辑窗后重试。",
  moments_publish_button_not_found: "未能唯一定位“发表”按钮，已停止操作；如编辑窗仍在，请先点取消再重试。",
  moments_publish_external_input_detected: "检测到鼠标或键盘操作，本次发表已在点击前停止。",
  moments_publish_marker_written_target_changed: "已记录本次尝试，但发表目标在最终点击前发生变化；请人工确认是否已发表。",
  moments_publish_marker_retire_failed: "无法安全清理本次未知结果记录，请关闭占用程序后再确认。",
  moments_publish_fingerprint_already_published: "相同正文和素材已记录为发表成功，不允许重复发表。",
  moments_publish_state_persist_failed: "无法安全保存发布状态，尚未操作微信。",
  moments_publish_outcome_unknown: "可能已经点击发表，但结果无法可靠确认。",
  moments_publish_restarted_during_publish: "应用上次在发表过程中中断；为避免重复发表，请先人工确认结果。",
  moments_publish_orphan_marker_recovered: "检测到未完成的发表记录；为避免重复发表，请先人工确认结果。",
  moments_publish_verified: "已发表，并通过朋友圈内容回读确认。",
  moments_publish_resolved_published: "已按你的人工确认记录为已发表。",
  moments_publish_resolved_not_published: "已按你的人工确认记录为未发表；如需发布，请重新创建一条。"
};

const STATUS_LABELS: Record<string, string> = {
  idle: "待创建",
  prepared: "等待最终确认",
  awaiting_confirmation: "等待最终确认",
  running: "正在发表",
  publishing: "正在发表",
  verified: "已验证发表",
  completed: "已完成",
  failed: "发表前已停止",
  outcome_unknown: "结果待人工确认"
};

function getApi() {
  return (window as Window & { xiaoxiMomentsPublish?: MomentsPublishApi }).xiaoxiMomentsPublish;
}

function stateVersion(value: MomentsPublishState) {
  return [
    value.updated_at,
    value.status,
    value.draft_id,
    value.fingerprint,
    value.action_attempted,
    value.outcome_unknown,
    value.last_reason
  ].join("|");
}

function isPreparedState(value: MomentsPublishState) {
  return Boolean(value.draft_id) && (
    value.status === "prepared" || value.status === "awaiting_confirmation"
  );
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function mediaKindLabel(kind: string, count: number) {
  if (kind === "video") return "1 个视频";
  return `${count} 张图片`;
}

function reasonLabel(reason: string, fallback: string) {
  return REASON_LABELS[reason] || reason || fallback;
}

export default function MomentsPublishPanel() {
  const api = getApi();
  const [content, setContent] = useState("");
  const [selection, setSelection] = useState<MomentsPublishSelection | null>(null);
  const [localConfirmationId, setLocalConfirmationId] = useState("");
  const [state, setState] = useState<MomentsPublishState>(EMPTY_STATE);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("填写正文并选择素材后，先生成发布确认。此步骤不会操作微信。");
  const [blocked, setBlocked] = useState(false);

  const acceptState = useCallback((next: MomentsPublishState) => {
    setState((current) => stateVersion(current) === stateVersion(next) ? current : next);
  }, []);

  useEffect(() => {
    if (!api) return;
    let disposed = false;
    let liveStateSeen = false;
    const unsubscribe = api.onUpdate((next) => {
      if (disposed) return;
      liveStateSeen = true;
      acceptState(next);
    });
    void api.status().then((result) => {
      if (disposed || liveStateSeen || !result?.state) return;
      acceptState(result.state);
      if (isPreparedState(result.state)) {
        setBusy(true);
        setBlocked(true);
        setMessage("上一次页面中的发布确认已失效，正在安全清除；请重新核对正文和素材后再生成确认。");
        void api.reset().then((resetResult) => {
          if (disposed) return;
          if (resetResult?.state) acceptState(resetResult.state);
          if (!resetResult?.ok) {
            setMessage("旧的发布确认无法自动清除，已禁止发表。请点击“重新创建”后再试。");
            return;
          }
          setBlocked(false);
          setMessage("旧的发布确认已失效并清除。请重新填写正文、选择素材并生成确认。");
        }).catch(() => {
          if (disposed) return;
          setMessage("旧的发布确认无法自动清除，已禁止发表。请点击“重新创建”后再试。");
        }).finally(() => {
          if (!disposed) setBusy(false);
        });
      }
    }).catch(() => {
      if (disposed || liveStateSeen) return;
      setBlocked(true);
      setMessage("无法读取朋友圈发布状态，请重启应用后再试。");
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [acceptState, api]);

  const unknown = state.outcome_unknown || state.status === "outcome_unknown";
  const publishing = state.status === "running" || state.status === "publishing";
  const prepared = Boolean(localConfirmationId)
    && state.draft_id === localConfirmationId
    && isPreparedState(state);
  const stalePrepared = isPreparedState(state) && !prepared;
  const finished = state.status === "verified" || state.status === "completed";
  const editorLocked = busy || publishing || prepared || stalePrepared || finished;

  const chooseMedia = () => {
    if (!api || editorLocked) return;
    setBusy(true);
    setBlocked(false);
    void api.chooseMedia().then((result) => {
      if (result?.state) acceptState(result.state);
      if (!result?.ok || !result.selection) {
        if (result?.reason) {
          setBlocked(true);
          setMessage(reasonLabel(result.reason, "未能选择素材。"));
        }
        return;
      }
      setLocalConfirmationId("");
      setSelection(result.selection);
      setMessage(`已选择${mediaKindLabel(result.selection.media_kind, result.selection.media_count)}，尚未操作微信。`);
    }).catch(() => {
      setBlocked(true);
      setMessage("选择素材失败，请稍后再试。");
    }).finally(() => setBusy(false));
  };

  const prepare = () => {
    if (!api || busy || unknown) return;
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      setBlocked(true);
      setMessage("请先填写朋友圈正文。");
      return;
    }
    if (!selection?.selection_id) {
      setBlocked(true);
      setMessage("请先选择 1-9 张图片，或 1 个视频。");
      return;
    }
    setBusy(true);
    setBlocked(false);
    void api.prepare({ content: normalizedContent, selectionId: selection.selection_id }).then((result) => {
      if (result?.state) acceptState(result.state);
      const draftId = String(result?.state?.draft_id || "");
      if (!result?.ok || !draftId) {
        setBlocked(true);
        setMessage(reasonLabel(result?.reason || "", "发布确认生成失败。"));
        return;
      }
      setLocalConfirmationId(draftId);
      setMessage("发布确认已生成。请再次核对摘要；只有点击“确认发表”才会操作微信。");
    }).catch(() => {
      setBlocked(true);
      setMessage("发布确认生成失败，尚未操作微信。");
    }).finally(() => setBusy(false));
  };

  const confirm = () => {
    if (!api || busy || !prepared || unknown) return;
    setBusy(true);
    setBlocked(false);
    setMessage("正在操作微信并核验发布结果，请暂时不要使用鼠标和键盘……");
    void api.confirm({ draftId: localConfirmationId }).then((result) => {
      if (result?.state) acceptState(result.state);
      if (!result?.ok) {
        const resultUnknown = result?.state?.outcome_unknown || result?.state?.status === "outcome_unknown";
        setBlocked(true);
        setMessage(resultUnknown
          ? "发表动作可能已经发生，但结果无法确认。为防止重复发布，已锁定本条内容，必须由你人工确认。"
          : reasonLabel(result?.reason || "", "发表前检查未通过，已停止且不会自动重试。"));
        if (!resultUnknown) {
          setLocalConfirmationId("");
          if (!result?.state?.selection) setSelection(null);
        }
        return;
      }
      setMessage("朋友圈已发表，并通过内容回读完成验证。");
    }).catch(() => {
      setBlocked(true);
      setMessage("发布调用异常。请先到微信朋友圈人工检查；系统不会自动重试。");
    }).finally(() => setBusy(false));
  };

  const reset = () => {
    if (!api || busy || publishing || unknown) return;
    setBusy(true);
    setBlocked(false);
    void api.reset().then((result) => {
      if (result?.state) acceptState(result.state);
      if (!result?.ok) {
        setBlocked(true);
        setMessage(reasonLabel(result?.reason || "", "无法重置当前草稿。"));
        return;
      }
      setLocalConfirmationId("");
      setSelection(null);
      setContent("");
      setMessage("已清空当前内容。填写正文并选择素材后，可生成新的发布确认。");
    }).catch(() => {
      setBlocked(true);
      setMessage("无法重置当前草稿。");
    }).finally(() => setBusy(false));
  };

  const resolveUnknown = (resolution: "published" | "not_published") => {
    if (!api || busy || !unknown) return;
    setBusy(true);
    setBlocked(false);
    void api.resolveUnknown({ resolution }).then((result) => {
      if (result?.state) acceptState(result.state);
      if (!result?.ok) {
        setBlocked(true);
        setMessage(reasonLabel(result?.reason || "", "人工确认未能保存。"));
        return;
      }
      setLocalConfirmationId("");
      setSelection(null);
      setContent("");
      setMessage(resolution === "published"
        ? "已按你的确认记录为已发表。"
        : "已按你的确认记录为未发表。系统不会直接补发；如需发布，请重新创建。"
      );
    }).catch(() => {
      setBlocked(true);
      setMessage("人工确认未能保存，请勿重复发表，稍后再试。");
    }).finally(() => setBusy(false));
  };

  if (!api) {
    return (
      <section className="dev-acceptance moments-publish-card">
        <div className="dev-acceptance-head">
          <Send size={18} />
          <strong>朋友圈单条发布</strong>
          <span>当前版本未开放</span>
        </div>
        <div className="dev-status is-blocked">朋友圈发布入口当前不可用。</div>
      </section>
    );
  }

  return (
    <section className="dev-acceptance moments-publish-card">
      <div className="dev-acceptance-head">
        <Send size={18} />
        <strong>朋友圈单条发布</strong>
        <span>两步确认 · 结果复核</span>
      </div>

      {unknown ? (
        <div className="moments-publish-unknown">
          <div className="moments-publish-warning-title">
            <ShieldAlert size={20} />
            <strong>发布结果无法自动确认</strong>
          </div>
          <p>
            本条内容可能已经发表。系统已锁定这次尝试，不会自动补发，也不提供直接重发。
            请先打开微信朋友圈人工核对，再选择真实结果。
          </p>
          <div className="moments-publish-unknown-actions">
            <button
              data-xiaoxi-moments-publish-resolve-published
              className="primary-button"
              disabled={busy}
              onClick={() => resolveUnknown("published")}
            >
              <CheckCircle2 size={15} />我确认已经发表
            </button>
            <button
              data-xiaoxi-moments-publish-resolve-not-published
              className="secondary-button"
              disabled={busy}
              onClick={() => resolveUnknown("not_published")}
            >
              我确认没有发表
            </button>
          </div>
        </div>
      ) : (
        <>
          <label className="script-field moments-publish-content">
            <span>朋友圈正文</span>
            <textarea
              value={content}
              maxLength={2000}
              disabled={editorLocked}
              placeholder="输入这条朋友圈的正文"
              onChange={(event) => setContent(event.target.value)}
            />
            <small>{content.length}/2000 字</small>
          </label>

          <div className="moments-publish-media">
            <div className="moments-publish-media-head">
              <div>
                <strong>图片或视频</strong>
                <span>选择 1-9 张图片，或 1 个视频</span>
              </div>
              <button
                data-xiaoxi-moments-publish-choose
                className="secondary-button"
                disabled={editorLocked}
                onClick={chooseMedia}
              >
                <ImagePlus size={15} />选择素材
              </button>
            </div>
            {selection ? (
              <ul className="moments-publish-file-list">
                {selection.files.map((file, index) => (
                  <li key={`${file.name}-${index}`}>
                    <span title={file.name}>{file.name}</span>
                    <small>{file.kind === "video" ? "视频" : "图片"} · {formatBytes(file.size)}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="moments-publish-empty">尚未选择素材</p>
            )}
          </div>

          {!prepared && !stalePrepared && !finished && (
            <div className="moments-publish-step">
              <div>
                <strong>第一步：生成发布确认</strong>
                <p>仅校验正文和素材并生成内容指纹，不会打开或操作微信。</p>
              </div>
              <button
                data-xiaoxi-moments-publish-prepare
                className="secondary-button"
                disabled={busy || publishing || !content.trim() || !selection}
                onClick={prepare}
              >
                生成发布确认
              </button>
            </div>
          )}

          {(prepared || finished) && (
            <div className={`moments-publish-confirmation ${finished ? "is-finished" : ""}`}>
              <div className="moments-publish-confirmation-head">
                <strong>{finished ? "发布结果" : "第二步：最终发布确认"}</strong>
                <span>{STATUS_LABELS[state.status] || state.status}</span>
              </div>
              <dl>
                <div><dt>正文</dt><dd>{content.length} 字</dd></div>
                <div><dt>素材</dt><dd>{mediaKindLabel(state.media_kind, state.media_count)}</dd></div>
                <div><dt>内容指纹</dt><dd><code>{state.fingerprint.slice(0, 12)}</code></dd></div>
              </dl>
              {prepared && (
                <div className="moments-publish-final-action">
                  <p>
                    点击后将立即操作微信，把上述内容<strong>公开发布到朋友圈</strong>。
                    请确认正文与素材完全无误。
                  </p>
                  <button
                    data-xiaoxi-moments-publish-confirm
                    className="danger-button"
                    disabled={busy}
                    onClick={confirm}
                  >
                    <Send size={15} />确认发表
                  </button>
                </div>
              )}
              {finished && (
                <div className="moments-publish-finished">
                  <CheckCircle2 size={18} />
                  <span>本条内容已通过发布后回读验证。</span>
                </div>
              )}
            </div>
          )}

          {(prepared || stalePrepared || finished) && (
            <div className="moments-publish-reset-row">
              <button className="secondary-button" disabled={busy || publishing} onClick={reset}>
                <RotateCcw size={15} />{finished ? "发布下一条" : stalePrepared ? "重新创建" : "返回修改"}
              </button>
            </div>
          )}
        </>
      )}

      <div className="moments-publish-status-line">
        <span>状态：{STATUS_LABELS[state.status] || state.status}</span>
        {state.action_attempted && <span>已尝试发表动作</span>}
        {state.verified_at && <span>已完成发布后验证</span>}
      </div>
      <div className={`dev-status ${blocked || unknown ? "is-blocked" : ""}`} aria-live="polite">
        {message || reasonLabel(state.last_reason, "等待操作")}
      </div>
    </section>
  );
}
