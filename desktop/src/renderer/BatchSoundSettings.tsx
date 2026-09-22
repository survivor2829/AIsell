import { useEffect, useState } from "react";
import { AutoMixResourcePanel, type AutoMixResourcePanelProps, type AutoMixVoicePersona, type MusicCatalogTrack } from "./AutoMixResourcePanel";
import { type Batch, callBatch } from "./batch-studio-api";

type ResourceApi = Pick<AutoMixResourcePanelProps, "listMusicCatalogTracks" | "importMusicCatalogTrack" | "listAutoMixVoicePersonas" | "designAutoMixVoicePersona" | "previewAutoMixVoicePersona" | "approveAutoMixVoicePersona">;
type ResourceResult = { ok: boolean; data?: unknown; error?: string; code?: string };
function resourceApi(): ResourceApi {
  const creative = (window.xiaoxiContent as unknown as { creative: Record<string, (payload?: unknown) => Promise<ResourceResult>> })?.creative;
  return Object.fromEntries(["listMusicCatalogTracks", "importMusicCatalogTrack", "listAutoMixVoicePersonas", "designAutoMixVoicePersona", "previewAutoMixVoicePersona", "approveAutoMixVoicePersona"].map((method) => [method, async (payload?: unknown) => {
    if (!creative?.[method]) throw new Error("声音与配乐服务尚未连接，请重新启动应用。");
    const result = await creative[method](payload);
    if (!result.ok || result.data == null) throw Object.assign(new Error(result.error || "操作未完成"), { code: result.code });
    return result.data;
  }])) as ResourceApi;
}
function selectable(track: MusicCatalogTrack) {
  const license = track.licenseSummary;
  return track.analysisStatus === "ready" && license?.status === "valid" && license.evidencePresent
    && (!license.expiresAt || Date.parse(license.expiresAt) > Date.now());
}

export function BatchSoundSettings({ settings, locked, resourceLocked = false, onChange }: { settings: Batch["settings"]; locked: boolean; resourceLocked?: boolean; onChange: (settings: Batch["settings"]) => void }) {
  const [api] = useState(resourceApi);
  const [auditionApi] = useState<ResourceApi>(() => ({ ...api, listAutoMixVoicePersonas: async () => {
    const result = await api.listAutoMixVoicePersonas();
    return { items: result.items.filter((voice) => voice.provider === "volcengine") };
  } }));
  const [voices, setVoices] = useState<AutoMixVoicePersona[]>([]);
  const [tracks, setTracks] = useState<MusicCatalogTrack[]>([]);
  const [resourceSection, setResourceSection] = useState<"voice" | "music" | null>(null);
  const [preview, setPreview] = useState<{ id: string; name: string; url: string } | null>(null);
  const [loading, setLoading] = useState("");
  const [notice, setNotice] = useState("");
  async function refresh() {
    const results = await Promise.allSettled([api.listAutoMixVoicePersonas(), api.listMusicCatalogTracks()]);
    if (results[0].status === "fulfilled") setVoices(results[0].value.items);
    if (results[1].status === "fulfilled") setTracks(results[1].value.items);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") setNotice(failed.reason?.message || "资源暂时无法读取");
  }
  useEffect(() => { void refresh(); }, []);
  const pool = settings.music_track_ids || [];
  const musicMode = settings.music_mode || (pool.length ? "selected" : "none");
  const availableTrackCount = tracks.filter(selectable).length;
  const current = voices.find((voice) => voice.voicePersonaId === settings.voice_persona_id);
  async function audition(kind: "voice" | "music", id: string, name: string) {
    setLoading(id); setNotice("");
    try {
      // Invoke immediately so the preload can consume this actual audition click.
      const result = kind === "voice" ? await api.previewAutoMixVoicePersona({ voicePersonaId: id }) : await callBatch<{ audioDataUrl: string }>("music-preview", { track_id: id });
      if (!result.audioDataUrl) throw new Error("试听尚未就绪，请在声音管理中检查状态。");
      setPreview({ id, name, url: result.audioDataUrl });
    } catch (error) { setNotice((error as Error).message); } finally { setLoading(""); }
  }
  return <section className="batch-sound-settings" aria-label="声音与配乐">
    <div className="batch-notice" role="status"><strong>云端智能服务由系统统一提供</strong><br />客户无需配置密钥；开始制作时会实时检查素材理解、语音识别和配音能力。</div>
    <div className="batch-sound-row"><label>配音声音<select aria-label="配音声音" disabled={locked} value={settings.voice_persona_id || ""} onChange={(event) => onChange({ ...settings, voice_persona_id: event.target.value || undefined })}>
      <option value="">试听后选择声音</option>{voices.filter((voice) => voice.approvalStatus === "approved" && voice.provider === "volcengine").map((voice) => <option key={voice.voicePersonaId} value={voice.voicePersonaId}>{voice.displayName}</option>)}
    </select></label><button type="button" data-xiaoxi-auto-mix-voice-preview disabled={locked || !!loading || !current} onClick={() => current && void audition("voice", current.voicePersonaId, current.displayName)}>{loading === current?.voicePersonaId ? "准备试听…" : "试听声音"}</button><button type="button" disabled={resourceLocked} onClick={() => setResourceSection("voice")}>选择试听候选</button></div>
    <details className="batch-music-settings"><summary>配乐 · {musicMode === "none" ? "明确不加配乐" : musicMode === "selected" && pool.length ? `已选 ${pool.length} 首，按内容轮换` : "自动从授权曲库选曲"}</summary>
      <label>配乐策略<select aria-label="配乐策略" disabled={locked} value={musicMode} onChange={(event) => {
        const next = event.target.value as "auto" | "none" | "selected";
        onChange({ ...settings, music_mode: next, music_track_ids: next === "none" ? [] : pool });
      }}>
        <option value="auto">自动配乐（授权曲库）</option>
        {pool.length > 0 && <option value="selected">仅使用我勾选的曲目</option>}
        <option value="none">明确不加配乐</option>
      </select></label>
      <p className="batch-hint">默认会从已核验授权曲库自动选一首合适的轻音乐；只有选择“明确不加配乐”时才会静音。勾选曲目后可限制本批使用范围。</p>
      <div className="batch-music-list">{tracks.map((track) => <div className="batch-music-row" key={track.trackId}>
        <label><input type="checkbox" disabled={locked || !selectable(track)} checked={musicMode === "selected" && pool.includes(track.trackId)} onChange={(event) => {
          const nextPool = event.target.checked ? [...pool, track.trackId] : pool.filter((id) => id !== track.trackId);
          onChange({ ...settings, music_mode: nextPool.length ? "selected" : "auto", music_track_ids: nextPool });
        }} /><span><strong>{track.displayName}</strong><small>{track.source}{!selectable(track) ? " · 暂不能用于导出" : ""}</small></span></label>
        <button type="button" disabled={!!loading || track.analysisStatus !== "ready"} onClick={() => void audition("music", track.trackId, track.displayName)}>{loading === track.trackId ? "准备试听…" : "试听"}</button>
      </div>)}</div>
      {!tracks.length && <p className="batch-hint">还没有可用配乐，可导入已取得使用授权的具体版本。</p>}
      {musicMode === "auto" && tracks.length > 0 && availableTrackCount === 0 && <p role="status" className="batch-notice">自动配乐当前没有可导出的授权曲目；请导入已核验曲目，或明确选择“无配乐”后再开始。</p>}
      {pool.some((id) => !tracks.some((track) => track.trackId === id && selectable(track))) && <p role="status" className="batch-notice">已选配乐中有曲目暂不可用，请换曲后制作。</p>}
      <button type="button" disabled={resourceLocked} onClick={() => setResourceSection("music")}>管理配乐／导入曲目</button>
    </details>
    {preview && <div className="batch-audition"><span>{preview.name}</span><audio key={preview.id} controls autoPlay src={preview.url} aria-label={`试听 ${preview.name}`} /><button type="button" onClick={() => setPreview(null)}>收起试听</button></div>}
    {notice && <p className="batch-notice" role="alert">{notice}</p>}
    <AutoMixResourcePanel {...auditionApi} open={!!resourceSection} initialSection={resourceSection || "voice"} onClose={() => { setResourceSection(null); void refresh(); }} />
  </section>;
}
