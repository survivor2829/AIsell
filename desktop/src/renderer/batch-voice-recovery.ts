// What the batch page offers when the voice a batch uses is no longer approved. An
// older build that does not know the voice clears its approval on start; the engine
// keeps the preview the user heard, so approving it again can be free.
export type RecoveryVoice = {
  voicePersonaId: string;
  displayName?: string;
  approvalStatus?: string;
  previewStatus?: string;
};
export type RecoveryBatch = { archived?: boolean; script_confirmation?: unknown; settings?: { voice_persona_id?: string; workflow_version?: number } };
// play_saved replays the saved preview (cacheOnly, no charge); regenerate synthesizes
// a new one (one paid cloud call); approve appears only after a preview played.
export type VoiceRecoveryAction = "play_saved" | "regenerate" | "approve";
export type VoiceRecovery = {
  kind: "free" | "paid" | "unknown" | "retired";
  voiceId: string;
  name: string;
  message: string;
  actions: VoiceRecoveryAction[];
};
// What this card learned in this page: the engine had no saved preview after all, and
// whether a preview (free or paid) has played so the approval can follow.
export type VoiceRecoverySession = { notCached?: boolean; auditioned?: boolean };

export const NOT_CACHED_CODE = "auto_mix_voice_preview_not_cached";
export const VOICE_RECOVERY_BLOCKS = "本批使用的声音需要先恢复批准，暂不能继续制作或重试规划；请先在上方处理声音。";
export const ACTION_LABELS: Record<VoiceRecoveryAction, (name: string) => string> = {
  play_saved: () => "播放已保存试听（不计费）",
  regenerate: () => "重新生成试听（调用一次云端配音，计费）",
  approve: (name) => `批准使用「${name}」`,
};

// A preview that played lets the approval follow (the main process also requires it in
// this session); a replay that found nothing saved switches the card to the paid preview.
export function sessionAfterPreview(session: VoiceRecoverySession, outcome: { audioDataUrl?: string | null; code?: string }) {
  if (outcome.audioDataUrl) return { ...session, auditioned: true };
  return outcome.code === NOT_CACHED_CODE ? { ...session, notCached: true } : session;
}

// What a voice's preview button costs. Only a completed preview replays from the
// engine's cache, and cacheOnly makes sure that is never a paid call; any other state
// synthesizes once (one paid cloud call).
export function previewCharge(previewStatus?: string) {
  const cacheOnly = previewStatus === "completed";
  return { cacheOnly, label: cacheOnly ? "不计费" : "计费一次" };
}
// A cacheOnly replay that found nothing saved (a deleted file, a stale key): the voice
// has no free preview after all, so its button says the next try is charged instead of
// sending cacheOnly forever.
export function previewAfterFailure<T extends { previewStatus?: string }>(voice: T, cacheOnly: boolean, code?: string): T {
  return cacheOnly && code === NOT_CACHED_CODE ? { ...voice, previewStatus: "not_ready" } as T : voice;
}

// Resuming a paused task (恢复任务) continues paid production that ends in the voice
// step when the batch has confirmed copy, or is a legacy batch (its samples and
// continue); the engine refuses those resumes too (resume_creative_task). Writing copy
// does not use the voice.
export function resumeNeedsVoice(batch: RecoveryBatch | null | undefined) {
  return Boolean(batch) && (batch?.settings?.workflow_version !== 2 || Boolean(batch?.script_confirmation));
}

export function approvedVoiceIds(items: RecoveryVoice[]) {
  return new Set(items.filter((voice) => voice.approvalStatus === "approved").map((voice) => voice.voicePersonaId));
}

// null: nothing to recover (no batch or voice, archived, the catalog not read yet, or
// the voice is approved).
export function voiceRecovery(batch: RecoveryBatch | null | undefined, voices: RecoveryVoice[] | null,
  session: VoiceRecoverySession = {}): VoiceRecovery | null {
  const voiceId = batch?.settings?.voice_persona_id;
  if (!batch || batch.archived || !voiceId || !voices) return null;
  const voice = voices.find((item) => item.voicePersonaId === voiceId);
  if (voice?.approvalStatus === "approved") return null;
  const name = voice?.displayName || voiceId;
  if (!voice) {
    return { kind: "retired", voiceId, name, actions: [],
      message: `本批使用的「${name}」已不在当前声音目录中，无法再批准。请点击「新建视频」，选择其他已批准的声音重新制作；已完成的作品仍可查看和导出。` };
  }
  const lead = `本批使用的「${name}」批准已失效（常见原因：这台电脑运行过不含该声音的旧版本）。`;
  if (voice.previewStatus === "submitted" || voice.previewStatus === "outcome_unknown") {
    return { kind: "unknown", voiceId, name, actions: [],
      message: `${lead}上次试听的结果还无法确认；为避免重复计费，暂不能再次试听。请先核对配音服务记录，稍后再来。` };
  }
  const free = voice.previewStatus === "completed" && !session.notCached;
  return {
    kind: free ? "free" : "paid", voiceId, name,
    actions: [free ? "play_saved" : "regenerate", ...(session.auditioned ? ["approve" as const] : [])],
    message: `${lead}${free ? "本机保存着你当初听过的试听，可以先免费播放，听完再批准。"
      : "本机没有可直接播放的已保存试听；重新生成会调用一次云端配音并计费。"}`,
  };
}
