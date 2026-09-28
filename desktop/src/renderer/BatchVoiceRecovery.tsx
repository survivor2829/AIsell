import { useState } from "react";
import { ACTION_LABELS, type RecoveryBatch, type RecoveryVoice, type VoiceRecoveryAction, type VoiceRecoverySession, sessionAfterPreview, voiceRecovery } from "./batch-voice-recovery";

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
  const run: Record<VoiceRecoveryAction, () => Promise<void>> = { play_saved: () => play(true), regenerate: () => play(false), approve };
  // Every row is a span so it takes the card's full width (.batch-planning-recovery > span).
  return <div className="batch-planning-recovery batch-voice-recovery" role="status">
    <span>{recovery.message}</span>
    {recovery.actions.length > 0 && <span className="batch-toolbar">{recovery.actions.map((action) => <button key={action} type="button"
      className={action === "approve" ? "batch-primary" : undefined}
      {...(action === "approve" ? { "data-xiaoxi-auto-mix-voice-approve": "" } : { "data-xiaoxi-auto-mix-voice-preview": "" })}
      disabled={busy || disabled} onClick={() => void run[action]()}>{busy && action !== "approve" ? "读取中…" : ACTION_LABELS[action](name)}</button>)}</span>}
    {audio && <span className="batch-audition"><audio controls autoPlay src={audio} aria-label={`试听 ${name}`} /></span>}
    {notice && <span className="batch-notice" role="alert">{notice}</span>}
  </div>;
}
