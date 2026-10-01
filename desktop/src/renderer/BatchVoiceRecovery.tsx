import { useEffect, useState } from "react";
import { ACTION_LABELS, PAID_PREVIEW_ARM_MS, PAID_PREVIEW_CONFIRM, PAID_PREVIEW_WARNING, type RecoveryBatch, type RecoveryVoice, type VoiceRecovery, type VoiceRecoveryAction, type VoiceRecoverySession, paidPreviewArmed, sessionAfterPreview, voiceRecovery } from "./batch-voice-recovery";

type Result = { ok: boolean; data?: { audioDataUrl?: string | null } | null; error?: string; code?: string };
type VoiceApi = {
  previewAutoMixVoicePersona?: (payload: { voicePersonaId: string; cacheOnly?: boolean }) => Promise<Result>;
  approveAutoMixVoicePersona?: (payload: { voicePersonaId: string }) => Promise<Result>;
};
function voiceApi() {
  return (window.xiaoxiContent as unknown as { creative?: VoiceApi } | undefined)?.creative || {};
}
function checked(result: Result | undefined) {
  if (!result?.ok || result.data == null) throw Object.assign(new Error(result?.error || "操作未完成"), { code: result?.code });
  return result.data;
}

// The status-area card for a batch whose voice lost its approval. It never approves by
// itself: the user plays a preview (free when the engine still has the saved one) and
// then clicks 批准使用. Mount it with a key per batch so the session starts over.
export function BatchVoiceRecovery({ batch, voices, disabled, onApproved }: {
  batch: RecoveryBatch; voices: RecoveryVoice[] | null; disabled?: boolean; onApproved: (name: string) => Promise<void> | void;
}) {
  const [session, setSession] = useState<VoiceRecoverySession>({});
  const [audio, setAudio] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  // When the paid confirmation appeared (null: not shown). Its button only works
  // PAID_PREVIEW_ARM_MS later, so no double-click can reach a paid preview.
  const [paidShownAt, setPaidShownAt] = useState<number | null>(null);
  const [, setArmTick] = useState(0);
  useEffect(() => {
    if (paidShownAt === null) return undefined;
    const timer = setTimeout(() => setArmTick((tick) => tick + 1), PAID_PREVIEW_ARM_MS);
    return () => clearTimeout(timer);
  }, [paidShownAt]);
  const recovery = voiceRecovery(batch, voices, session);
  if (!recovery) return null;
  const { voiceId, name } = recovery;
  async function play(cacheOnly: boolean) {
    setBusy(true); setNotice("");
    try {
      // Invoked straight from the click so the preload can bind this audition click.
      const request = voiceApi().previewAutoMixVoicePersona?.({ voicePersonaId: voiceId, ...(cacheOnly ? { cacheOnly: true } : {}) });
      const result = checked(await request);
      if (!result.audioDataUrl) throw new Error("试听尚未就绪，请稍后再试。");
      setAudio(result.audioDataUrl);
      setSession((current) => sessionAfterPreview(current, result));
    } catch (error) {
      setSession((current) => sessionAfterPreview(current, { code: (error as { code?: string }).code }));
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  }
  async function approve() {
    setBusy(true); setNotice("");
    try {
      checked(await voiceApi().approveAutoMixVoicePersona?.({ voicePersonaId: voiceId }));
      await onApproved(name);
    } catch (error) {
      setNotice((error as Error).message);
    } finally { setBusy(false); }
  }
  // 计费 never synthesizes on its own: it only opens the confirmation.
  const run: Record<VoiceRecoveryAction, () => Promise<void> | void> = {
    play_saved: () => play(true), regenerate: () => setPaidShownAt((current) => current ?? Date.now()), approve,
  };
  const armed = paidShownAt !== null && paidPreviewArmed(paidShownAt, Date.now());
  function confirmPaid() {
    if (paidShownAt === null || !paidPreviewArmed(paidShownAt, Date.now())) return;
    setPaidShownAt(null);
    void play(false);
  }
  return <VoiceRecoveryCard recovery={recovery} audio={audio} notice={notice} busy={busy} disabled={disabled}
    onAction={(action) => void run[action]()}
    paidConfirm={paidShownAt === null ? null : { armed }} onConfirmPaid={confirmPaid} onCancelPaid={() => setPaidShownAt(null)} />;
}

// The card as shown. Each button carries the trusted-click gate the preload checks for
// its call: the previews feed the audition gate, 批准使用 the approval gate (with the
// wrong one the approval gets no click token and can never go through).
export function VoiceRecoveryCard({ recovery, audio, notice, busy, disabled, onAction, paidConfirm, onConfirmPaid, onCancelPaid }: {
  recovery: VoiceRecovery; audio?: string; notice?: string; busy?: boolean; disabled?: boolean; onAction: (action: VoiceRecoveryAction) => void;
  paidConfirm?: { armed: boolean } | null; onConfirmPaid?: () => void; onCancelPaid?: () => void;
}) {
  const { name } = recovery;
  // Every row is a span so it takes the card's full width (.batch-planning-recovery > span).
  return <div className="batch-planning-recovery batch-voice-recovery" role="status">
    <span>{recovery.message}</span>
    {recovery.actions.length > 0 && <span className="batch-toolbar">{recovery.actions.map((action) => <button key={action} type="button"
      className={action === "approve" ? "batch-primary" : undefined}
      {...(action === "approve" ? { "data-xiaoxi-auto-mix-voice-approve": "" } : { "data-xiaoxi-auto-mix-voice-preview": "" })}
      disabled={busy || disabled} onClick={() => onAction(action)}>{busy && action !== "approve" ? "读取中…" : ACTION_LABELS[action](name)}</button>)}</span>}
    {paidConfirm && <span className="batch-toolbar batch-voice-paid-confirm">{PAID_PREVIEW_WARNING}
      <button type="button" data-xiaoxi-auto-mix-voice-preview="" disabled={busy || disabled || !paidConfirm.armed}
        onClick={() => onConfirmPaid?.()}>{paidConfirm.armed ? PAID_PREVIEW_CONFIRM : `${PAID_PREVIEW_CONFIRM}（请稍候）`}</button>
      <button type="button" disabled={busy} onClick={() => onCancelPaid?.()}>取消</button></span>}
    {audio && <span className="batch-audition"><audio controls autoPlay src={audio} aria-label={`试听 ${name}`} /></span>}
    {notice && <span className="batch-notice" role="alert">{notice}</span>}
  </div>;
}
