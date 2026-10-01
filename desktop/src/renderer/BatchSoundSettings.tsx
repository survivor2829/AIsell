import { useEffect, useRef, useState } from "react";
import { AutoMixResourcePanel, type AutoMixResourcePanelProps, type AutoMixVoicePersona, type MusicCatalogTrack } from "./AutoMixResourcePanel";
import { type Batch, callBatch } from "./batch-studio-api";
import { PAID_PREVIEW_ARM_MS, PAID_PREVIEW_CONFIRM, PAID_PREVIEW_WARNING, paidPreviewArmed, previewAfterFailure, previewCharge, unavailableVoiceLabel } from "./batch-voice-recovery";

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

// refreshToken: re-read the lists when it changes (the page passes its voice catalog, so an
// approval made elsewhere on the page shows up here too).
export function BatchSoundSettings({ settings, locked, resourceLocked = false, onChange, onVoiceApproved, refreshToken }: { settings: Batch["settings"]; locked: boolean; resourceLocked?: boolean; onChange: (settings: Batch["settings"]) => void; onVoiceApproved?: () => Promise<void> | void; refreshToken?: unknown }) {
  const [api] = useState(resourceApi);
  const approvedCallback = useRef(onVoiceApproved);
  approvedCallback.current = onVoiceApproved;
  const [auditionApi] = useState<ResourceApi>(() => ({ ...api, listAutoMixVoicePersonas: async () => {
    const result = await api.listAutoMixVoicePersonas();
    return { items: result.items.filter((voice) => voice.provider === "volcengine") };
  }, approveAutoMixVoicePersona: async (payload) => {
    const approved = await api.approveAutoMixVoicePersona(payload);
    // The page re-reads the approved list, or later loads still report this voice as unapproved.
    try { await approvedCallback.current?.(); } catch { /* The approval itself has landed. */ }
    return approved;
  } }));
  // null until the voice list has been read (it stays null if that read fails).
  const [voices, setVoices] = useState<AutoMixVoicePersona[] | null>(null);
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
  useEffect(() => { void refresh(); }, [refreshToken]);
  const pool = settings.music_track_ids || [];
  const musicMode = settings.music_mode || (pool.length ? "selected" : "none");
  const availableTrackCount = tracks.filter(selectable).length;
  const current = voices?.find((voice) => voice.voicePersonaId === settings.voice_persona_id);
  const approvedVoices = (voices || []).filter((voice) => voice.approvalStatus === "approved" && voice.provider === "volcengine");
  // The batch's own voice stays visible when it can no longer be chosen, instead of the
  // select silently showing its first option.
  const unavailable = unavailableVoiceLabel(settings.voice_persona_id, voices);
  async function auditionMusic(id: string, name: string) {
    setLoading(id); setNotice("");
    try {
      const result = await callBatch<{ audioDataUrl: string }>("music-preview", { track_id: id });
      if (!result.audioDataUrl) throw new Error("试听尚未就绪，请在声音管理中检查状态。");
      setPreview({ id, name, url: result.audioDataUrl });
    } catch (error) { setNotice((error as Error).message); } finally { setLoading(""); }
  }
  // Labelled like the resource panel: 不计费 replays the saved preview only (cacheOnly),
  // 计费一次 synthesizes; a replay that finds nothing saved relabels the button.
  const voiceCharge = previewCharge(current?.previewStatus);
  // 计费一次 only opens a confirmation whose own button works PAID_PREVIEW_ARM_MS later, so a
  // double-click on a 不计费 button that came back not_cached never reaches a paid call.
  const [paidShownAt, setPaidShownAt] = useState<number | null>(null);
  const [, setPaidArmTick] = useState(0);
  useEffect(() => {
    if (paidShownAt === null) return undefined;
    const timer = setTimeout(() => setPaidArmTick((tick) => tick + 1), PAID_PREVIEW_ARM_MS);
    return () => clearTimeout(timer);
  }, [paidShownAt]);
  const paidArmed = paidShownAt !== null && paidPreviewArmed(paidShownAt, Date.now());
  function requestAudition(voice: AutoMixVoicePersona) {
    if (previewCharge(voice.previewStatus).cacheOnly) { void auditionVoice(voice); return; }
    setPaidShownAt((shown) => shown ?? Date.now());
  }
  function confirmPaidAudition(voice: AutoMixVoicePersona) {
    if (paidShownAt === null || !paidPreviewArmed(paidShownAt, Date.now())) return;
    setPaidShownAt(null);
    void auditionVoice(voice);
  }
  async function auditionVoice(voice: AutoMixVoicePersona) {
    const { cacheOnly } = previewCharge(voice.previewStatus);
    setLoading(voice.voicePersonaId); setNotice("");
    try {
      // Invoke immediately so the preload can consume this actual audition click.
      const result = await api.previewAutoMixVoicePersona({ voicePersonaId: voice.voicePersonaId, ...(cacheOnly ? { cacheOnly } : {}) });
      if (!result.audioDataUrl) throw new Error("试听尚未就绪，请在声音管理中检查状态。");
      setPreview({ id: voice.voicePersonaId, name: voice.displayName, url: result.audioDataUrl });
      if (result.voicePersona) setVoices((items) => items && items.map((item) => item.voicePersonaId === voice.voicePersonaId ? result.voicePersona : item));
    } catch (error) {
      const next = previewAfterFailure(voice, cacheOnly, (error as { code?: string }).code);
      if (next !== voice) setVoices((items) => items && items.map((item) => item.voicePersonaId === voice.voicePersonaId ? next : item));
      setNotice((error as Error).message);
    } finally { setLoading(""); }
  }
  return <section className="batch-sound-settings" aria-label="声音与配乐">
    <div className="batch-notice" role="status"><strong>云端智能服务由系统统一提供</strong><br />客户无需配置密钥；开始制作时会实时检查素材理解、语音识别和配音能力。</div>
    <div className="batch-sound-row"><label>配音声音<select aria-label="配音声音" disabled={locked} value={settings.voice_persona_id || ""} onChange={(event) => onChange({ ...settings, voice_persona_id: event.target.value || undefined })}>
      <option value="">试听后选择声音</option>{unavailable && <option value={settings.voice_persona_id} disabled>{unavailable}</option>}{approvedVoices.map((voice) => <option key={voice.voicePersonaId} value={voice.voicePersonaId}>{voice.displayName}</option>)}
    </select></label><button type="button" data-xiaoxi-auto-mix-voice-preview disabled={locked || !!loading || !current} onClick={() => current && requestAudition(current)}>{loading === current?.voicePersonaId ? "准备试听…" : current ? `试听声音（${voiceCharge.label}）` : "试听声音"}</button><button type="button" disabled={resourceLocked} onClick={() => setResourceSection("voice")}>选择试听候选</button></div>
    {paidShownAt !== null && current && <div className="batch-toolbar batch-voice-paid-confirm" role="alert">{PAID_PREVIEW_WARNING}<button type="button" data-xiaoxi-auto-mix-voice-preview disabled={locked || !!loading || !paidArmed} onClick={() => confirmPaidAudition(current)}>{paidArmed ? PAID_PREVIEW_CONFIRM : `${PAID_PREVIEW_CONFIRM}（请稍候）`}</button><button type="button" onClick={() => setPaidShownAt(null)}>取消</button></div>}
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
        <button type="button" disabled={!!loading || track.analysisStatus !== "ready"} onClick={() => void auditionMusic(track.trackId, track.displayName)}>{loading === track.trackId ? "准备试听…" : "试听"}</button>
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
