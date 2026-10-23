import { useEffect, useState } from "react";
import type { AutoMixVoicePersona } from "./AutoMixResourcePanel";
import type { Batch } from "./batch-studio-api";
import { unavailableVoiceLabel } from "./batch-voice-recovery";

export function BatchSoundSettings({ settings, locked, onChange, refreshToken }: {
  settings: Batch["settings"]; locked: boolean;
  onChange: (settings: Batch["settings"]) => void; refreshToken?: unknown;
}) {
  const [voices, setVoices] = useState<AutoMixVoicePersona[] | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let cancelled = false;
    const creative = (window.xiaoxiContent as unknown as { creative?: { listAutoMixVoicePersonas: () => Promise<{ ok: boolean; data?: { items: AutoMixVoicePersona[] }; error?: string }> } })?.creative;
    if (!creative) { setNotice("声音服务尚未连接，请重新启动应用。"); return; }
    void creative.listAutoMixVoicePersonas().then((result) => {
      if (cancelled) return;
      if (!result.ok || !result.data) { setNotice(result.error || "声音暂时无法读取，请重新打开页面。"); return; }
      setVoices(result.data.items); setNotice("");
    }).catch(() => { if (!cancelled) setNotice("声音暂时无法读取，请重新打开页面。"); });
    return () => { cancelled = true; };
  }, [refreshToken]);
  const unavailable = unavailableVoiceLabel(settings.voice_persona_id, voices);
  return <section className="batch-sound-settings" aria-label="声音与配乐">
    <label>声音<select aria-label="声音" disabled={locked} value={settings.voice_persona_id || ""} onChange={(event) => onChange({ ...settings, voice_persona_id: event.target.value || undefined })}>
      <option value="">自动选择</option>
      {unavailable && <option value={settings.voice_persona_id} disabled>{unavailable}</option>}
      {(voices || []).filter((voice) => voice.approvalStatus === "approved" && voice.provider === "volcengine").map((voice) => <option key={voice.voicePersonaId} value={voice.voicePersonaId}>{voice.displayName}</option>)}
    </select></label>
    <label><input type="checkbox" role="switch" disabled={locked} checked={settings.music_mode === "none"} onChange={(event) => onChange({ ...settings, music_mode: event.target.checked ? "none" : "auto", music_track_ids: [] })} />不加配乐</label>
    {notice && <p className="batch-notice" role="alert">{notice}</p>}
  </section>;
}
