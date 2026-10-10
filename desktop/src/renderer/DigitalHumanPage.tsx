import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, CircleAlert, Download, ImagePlus, LoaderCircle, Plus, RefreshCw, UserRound } from 'lucide-react';
import type { DigitalHumanApi, DigitalHumanAsset, DigitalHumanCapabilities, DigitalHumanDraft, DigitalHumanResult, DigitalHumanTask } from './digital-human-types';
import './DigitalHumanPage.css';
import { VideoCoverDetails } from './VideoPresentation';

function api(): DigitalHumanApi {
  const value = (window as unknown as { xiaoxiDigitalHuman?: DigitalHumanApi }).xiaoxiDigitalHuman;
  if (!value) throw new Error('数字人模块尚未连接，请重新启动应用。');
  return value;
}
async function unwrap<T>(result: Promise<DigitalHumanResult<T>>): Promise<T> {
  const value = await result;
  if (!value.ok || value.data === undefined) throw new Error(value.error || '操作未完成，请稍后重试。');
  return value.data;
}
const EMPTY: DigitalHumanDraft = { personAssetId: '', productAssetId: '', sceneId: 'studio', voiceStyle: 'workbench', voiceSource: 'official', characterVoice: 'unknown', voicePersonaId: '', durationSeconds: 15, script: '' };
const ACTIVE = new Set(['audio_preparing', 'audio_transcribing', 'preview_preparing', 'preview_generating', 'registering', 'reviewing', 'video_submitting', 'video_generating', 'official_submitting', 'official_generating', 'audio_assembling', 'assembling', 'enhancing', 'packaging']);
const SCENE_IMAGES: Record<string, string> = Object.fromEntries(['studio', 'store', 'display'].map((id) => [id, `${import.meta.env.BASE_URL}digital-human-scenes/${id}.png`]));

export function DigitalHumanPage() {
  const [capabilities, setCapabilities] = useState<DigitalHumanCapabilities | null>(null);
  const [draft, setDraft] = useState<DigitalHumanDraft>({ ...EMPTY });
  const [images, setImages] = useState<{ person?: DigitalHumanAsset; product?: DigitalHumanAsset }>({});
  const [items, setItems] = useState<DigitalHumanTask[]>([]);
  const [selected, setSelected] = useState<DigitalHumanTask | null>(null);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState('');
  const [audio, setAudio] = useState<DigitalHumanAsset | null>(null);
  const [voicePreview, setVoicePreview] = useState('');
  const [preparedSpeech, setPreparedSpeech] = useState('');
  const [transcriptText, setTranscriptText] = useState('');
  const [voiceRecommendation, setVoiceRecommendation] = useState('');
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const selection = useRef('');
  const loadedPreview = useRef('');
  const mounted = useRef(true);
  const locked = Boolean(selected && selected.status !== 'draft');
  const legacyTask = selected?.pipelineVersion === 1;

  const refreshList = useCallback(async () => {
    const result = await unwrap(api().list());
    if (!mounted.current) return;
    setItems(result.items);
    const current = result.items.find((item) => item.id === selection.current);
    if (current) setSelected(current);
  }, []);
  const loadCapabilities = useCallback(async () => {
    const state = await unwrap(api().capabilities());
    if (mounted.current) setCapabilities(state);
  }, []);
  useEffect(() => {
    mounted.current = true;
    void Promise.all([loadCapabilities(), refreshList()]).catch((error) => { if (mounted.current) setNotice({ kind: 'error', message: error.message }); });
    const timer = window.setInterval(() => { void refreshList().catch(() => {}); }, 5000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [loadCapabilities, refreshList]);
  useEffect(() => {
    if (!selected?.previewReady) return;
    const key = `${selected.id}:${selected.previewRevision}`;
    if (loadedPreview.current === key) return;
    let cancelled = false;
    void unwrap(api().media({ id: selected.id })).then((result) => {
      if (!cancelled) { loadedPreview.current = key; setPreview(result.dataUrl); }
    }).catch((error) => { if (!cancelled) setNotice({ kind: 'error', message: error.message }); });
    return () => { cancelled = true; };
  }, [selected?.id, selected?.previewReady, selected?.previewRevision]);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    void unwrap(api().images({ id: selected.id })).then((result) => {
      if (!cancelled) setImages((current) => ({
        person: !current.person || current.person.id === selected.personAssetId ? result.person : current.person,
        product: !current.product || current.product.id === selected.productAssetId ? result.product : current.product,
      }));
    }).catch((error) => { if (!cancelled) setNotice({ kind: 'error', message: error.message }); });
    return () => { cancelled = true; };
  }, [selected?.id, selected?.personAssetId, selected?.productAssetId]);

  useEffect(() => {
    if (selected?.voiceSource === 'uploaded_audio' && selected.status === 'preview_ready') setTranscriptText(selected.script);
    else setTranscriptText('');
  }, [selected?.id, selected?.status]);
  useEffect(() => {
    setPreparedSpeech('');
    if (!selected?.audio?.prepared) return;
    let cancelled = false;
    void unwrap(api().speechMedia({ id: selected.id })).then((result) => { if (!cancelled) setPreparedSpeech(result.audioDataUrl); }).catch(() => {});
    return () => { cancelled = true; };
  }, [selected?.id, selected?.audio?.prepared]);
  function chooseCharacterVoice(characterVoice: 'male' | 'female' | 'unknown') {
    const catalog = capabilities?.voices || [], preference = capabilities?.voicePreferences?.[characterVoice];
    const voice = catalog.find((v) => v.gender === characterVoice && v.available && v.id === preference)
      || catalog.find((v) => v.gender === characterVoice && v.digitalHumanDefault);
    setDraft((current) => ({ ...current, characterVoice, voicePersonaId: voice?.id || '' }));
    setVoicePreview('');
  }
  async function importAudio() {
    await perform('audio', async () => {
      const item = await unwrap(api().importAudio()); if (!item) return;
      setAudio(item); setVoicePreview(''); setDraft((current) => ({ ...current, audioAssetId: item.id }));
    });
  }
  async function auditionVoice() {
    if (!draft.voicePersonaId) return;
    await perform('voice-preview', async () => {
      try {
        const result = await unwrap(api().previewVoice({ voicePersonaId: draft.voicePersonaId! }));
        setVoicePreview(result.audioDataUrl);
      } finally {
        await loadCapabilities().catch(() => {});
      }
    });
  }
  async function useVoice() {
    if (!draft.voicePersonaId || !draft.characterVoice || draft.characterVoice === 'unknown') return;
    await perform('voice-select', async () => {
      await unwrap(api().selectVoice({ voicePersonaId: draft.voicePersonaId!, characterVoice: draft.characterVoice as 'male' | 'female' }));
      await loadCapabilities(); setNotice({ kind: 'success', message: '数字人的声音已保存，创作工作台默认声音保持独立。' });
    });
  }
  function apply(task: DigitalHumanTask) {
    selection.current = task.id; setSelected(task);
    setItems((current) => [task, ...current.filter((item) => item.id !== task.id)]);
  }
  async function perform(name: string, operation: () => Promise<void>) {
    if (busy) return;
    setBusy(name); setNotice(null);
    try { await operation(); } catch (error) { if (mounted.current) setNotice({ kind: 'error', message: (error as Error).message }); }
    finally { if (mounted.current) setBusy(''); }
  }
  function newSample() {
    selection.current = ''; setSelected(null); setPreview(''); setPreparedSpeech(''); setVoicePreview(''); loadedPreview.current = ''; setNotice(null);
    setDraft(current => ({ ...current, sourceTaskId: selected?.id, ...(current.voiceSource === 'cloned_voice' ? { voicePersonaId: capabilities?.voices.find((v) => v.gender === current.characterVoice && v.digitalHumanDefault)?.id || '' } : {}), voiceSource: current.voiceSource === 'uploaded_audio' ? 'uploaded_audio' : 'official', voiceStyle: 'workbench', durationSeconds: [15, 30, 45].includes(current.durationSeconds) ? current.durationSeconds : 15 }));
  }
  async function importImage(role: 'person' | 'product') {
    await perform(role, async () => {
      const image = await unwrap(api().importImage());
      if (!image) return;
      setImages((current) => ({ ...current, [role]: image }));
      setDraft((current) => ({ ...current, [`${role}AssetId`]: image.id }));
      if (role === 'person') {
        const recommendation = await unwrap(api().recommendVoice({ personAssetId: image.id }));
        setVoiceRecommendation(recommendation.reason); setVoicePreview('');
        setDraft((current) => ({ ...current, characterVoice: recommendation.characterVoice, ...(current.voiceSource === 'official' ? { voicePersonaId: recommendation.voicePersonaId } : {}) }));
      }
    });
  }
  async function makePreview() {
    await perform('preview', async () => {
      const result = await api().saveAndPreview({ ...draft, ...(selected?.status === 'draft' ? { id: selected.id } : {}) });
      if (result.data) apply(result.data);
      if (!result.ok) throw new Error(result.error || '预览未开始，草稿已保留。');
    });
  }
  async function saveDraft() {
    await perform('save', async () => {
      apply(await unwrap(api().create({ ...draft, ...(selected?.status === 'draft' ? { id: selected.id } : {}) })));
      setNotice({ kind: 'success', message: '草稿已保存。' });
    });
  }
  function selectTask(task: DigitalHumanTask) {
    if (selection.current === task.id) return;
    apply(task); setDraft({ personAssetId: task.personAssetId, productAssetId: task.productAssetId, sceneId: task.sceneId,
      voiceStyle: task.voiceStyle, voiceSource: task.voiceSource, voicePersonaId: task.voicePersonaId, audioAssetId: task.audioAssetId, characterVoice: task.characterVoice, durationSeconds: task.durationSeconds, script: task.script });
    setImages({}); setAudio(task.audioAssetId ? { id: task.audioAssetId, name: task.audioName || '已保存录音' } : null); setVoicePreview(''); setVoiceRecommendation(''); setPreview(''); loadedPreview.current = ''; setNotice(null);
  }
  async function download() {
    if (!selected?.generatedVideoId) return;
    await perform('download', async () => {
      const creative = (window as unknown as { xiaoxiContent?: { creative?: { downloadCandidate(p: { candidateId: string }): Promise<DigitalHumanResult<unknown>> } } }).xiaoxiContent?.creative;
      if (!creative) throw new Error('成片下载服务尚未连接。');
      const result = await creative.downloadCandidate({ candidateId: selected.generatedVideoId });
      if (!result.ok) throw new Error(result.error || '成片下载未完成。');
    });
  }
  const working = Boolean(selected && ACTIVE.has(selected.status));
  const videoUrl = selected?.status === 'completed' && /^generated_video_[A-Za-z0-9_-]+$/u.test(selected.generatedVideoId)
    ? `xiaoxi-content://generated/${selected.generatedVideoId}/video` : '';
  const serviceUnavailable = !legacyTask && capabilities && !capabilities.ready;
  const canPreview = Boolean((legacyTask || capabilities?.ready) && draft.personAssetId && draft.productAssetId && (draft.voiceSource === 'uploaded_audio' ? draft.audioAssetId : draft.script.trim()) && (draft.voiceSource !== 'official' || (draft.characterVoice !== 'unknown' && capabilities?.voices.some((voice) => voice.id === draft.voicePersonaId && voice.available))) && (draft.voiceSource !== 'cloned_voice' || !!draft.voicePersonaId) && !locked && !busy);
  const scene = capabilities?.scenes.find((item) => item.id === draft.sceneId);
  const previewHelp = legacyTask ? '旧任务沿用原制作方式，开始时检查对应生成服务。' : !capabilities ? '正在检查生成服务…' : !capabilities.ready ? capabilities.message
    : preview ? '确认人物、产品和比例后，再生成视频。'
    : !draft.personAssetId || !draft.productAssetId ? '选择形象和产品图片后，生成人物预览。'
    : draft.voiceSource === 'uploaded_audio' ? draft.audioAssetId ? '已选择录音，准备声音与人物预览。' : '选择自己的口播录音，再生成人物预览。'
    : !draft.script.trim() ? '写下想讲的话，再生成人物预览。' : '生成人物预览后，确认形象与产品再制作视频。';

  return <div className="digital-human-page">
    <header className="dh-header"><div className="dh-heading"><h1>数字人视频</h1><p>上传形象和产品，写好完整口播。</p><p className="dh-quality">先准备声音与字幕，再生成 720p 视频；成片普通放大至 1080p 尺寸。</p>
      <button className="dh-button" onClick={newSample} disabled={!!busy}><Plus size={16} />新建样片</button></div></header>
    {notice && <div className={`dh-message is-${notice.kind}`} role={notice.kind === 'success' ? 'status' : 'alert'}>
      {notice.kind === 'success' ? <Check size={17} /> : <CircleAlert size={17} />}<span>{notice.message}</span></div>}
    <div className="dh-workspace">
      <section className="dh-form" aria-label="制作设置">
        <div className="dh-upload-pair">{(['person', 'product'] as const).map((role) => {
          const image = images[role], assetId = role === 'person' ? draft.personAssetId : draft.productAssetId;
          return <button type="button" className={`dh-upload ${assetId ? 'has-image' : ''}`} key={role} disabled={locked || !!busy} onClick={() => void importImage(role)}>
            {image?.previewDataUrl ? <img src={image.previewDataUrl} alt={role === 'person' ? '本人形象' : '产品图片'} /> : role === 'person' ? <UserRound size={26} /> : <ImagePlus size={26} />}
            <span><strong>{role === 'person' ? '本人形象' : '产品图片'}</strong><small>{busy === role ? '正在读取…' : assetId ? image?.name || '已选择图片' : '选择图片'}</small></span>
          </button>;
        })}</div>
        <fieldset className="dh-scenes" disabled={locked || !!busy}><legend>出镜场景</legend><div>{capabilities?.scenes.map((scene) => <button type="button" key={scene.id}
          aria-pressed={draft.sceneId === scene.id} className={draft.sceneId === scene.id ? 'is-selected' : ''} onClick={() => setDraft({ ...draft, sceneId: scene.id })}>
          <img src={SCENE_IMAGES[scene.id]} alt="" /><span>{scene.name}{draft.sceneId === scene.id && <Check size={14} />}</span></button>)}</div></fieldset>
        <label className="dh-field"><span>{draft.voiceSource === 'uploaded_audio' ? '场景与产品说明（可选）' : '完整口播文案'}</span><textarea disabled={locked || !!busy} maxLength={legacyTask ? 160 : 1800} rows={5} value={draft.script}
          placeholder={draft.voiceSource === 'uploaded_audio' ? '录音决定实际讲解内容；这里可补充产品与画面说明。' : '写出整条视频实际要讲的话，包含介绍、解释和收尾。'} aria-describedby="dh-script-help" onChange={(event) => { setDraft({ ...draft, script: event.target.value }); setVoicePreview(''); }} /></label>
        <p className="dh-quality" id="dh-script-help">{draft.voiceSource === 'uploaded_audio' ? '使用录音中的实际讲话和原声音，字幕根据录音识别，不改读这里的文字。' : legacyTask ? '旧任务沿用原方案，口播文案最多160字。' : selected && selected.pipelineVersion === 2 && selected.narrationPolicy !== 'original_script' ? '这条旧任务沿用原有固定分段方案；按原稿自然时长制作请新建任务。' : `目标${draft.durationSeconds}秒，可按约${draft.durationSeconds * 4}字准备。保留完整原稿和自然语速，成片时长以实际讲话为准。`}</p>
        <div className="dh-voice" aria-label="数字人声音">
          <label className="dh-field"><span>声音来源</span><select disabled={locked || !!busy} value={draft.voiceSource || 'legacy'} onChange={(event) => {
            const source = event.target.value as DigitalHumanDraft['voiceSource'];
            const voice = capabilities?.voices.find((v) => v.gender === draft.characterVoice && v.id === capabilities.voicePreferences?.[draft.characterVoice || 'unknown']) || capabilities?.voices.find((v) => v.gender === draft.characterVoice && v.digitalHumanDefault);
            setDraft({ ...draft, voiceSource: source, voicePersonaId: source === 'official' ? voice?.id || '' : '' }); setVoicePreview('');
          }}>
            {!draft.voiceSource && <option value="legacy">沿用原任务声音</option>}
            <option value="official">火山音色，朗读文案</option><option value="uploaded_audio">自己的录音，按原音讲解</option>{draft.voiceSource === 'cloned_voice' && <option value="cloned_voice">专属音色（历史任务）</option>}
          </select></label>
          {draft.voiceSource === 'official' && <>
            <div className="dh-options"><label className="dh-field"><span>人物声音</span><select disabled={locked || !!busy} value={draft.characterVoice || 'unknown'} onChange={(event) => chooseCharacterVoice(event.target.value as 'male' | 'female' | 'unknown')}>
              <option value="unknown">请选择男声或女声</option><option value="male">男声</option><option value="female">女声</option></select></label>
              <label className="dh-field"><span>配音音色</span><select disabled={locked || !!busy} value={draft.voicePersonaId || ''} onChange={(event) => { setDraft({ ...draft, voicePersonaId: event.target.value }); setVoicePreview(''); }}>
                <option value="">请选择音色</option>{capabilities?.voices.filter((voice) => voice.gender === draft.characterVoice).map((voice) => <option key={voice.id} value={voice.id}>{voice.name}{voice.available ? '' : ' · 待试听'}</option>)}
              </select></label></div>
            {voiceRecommendation && <p className="dh-quality">{voiceRecommendation} 可手动调整。</p>}
            <div className="dh-voice-actions"><button type="button" className="dh-button" data-xiaoxi-digital-human-action="voice-preview" disabled={locked || !!busy || !draft.voicePersonaId} onClick={() => void auditionVoice()}>{busy === 'voice-preview' ? '正在准备试听…' : '试听所选音色'}</button>
              {voicePreview && !capabilities?.voices.find((v) => v.id === draft.voicePersonaId)?.available && <button type="button" className="dh-button" disabled={locked || !!busy} onClick={() => void useVoice()}>采用试听声音</button>}
            </div>{voicePreview && <audio className="dh-audio" controls src={voicePreview} aria-label="所选音色试听" />}
          </>}
          {draft.voiceSource === 'uploaded_audio' && <><button type="button" className="dh-button" disabled={locked || !!busy} onClick={() => void importAudio()}>{audio?.name || '选择自己的录音（WAV / MP3 / M4A）'}</button>
            <p className="dh-quality">保留录音中的完整讲话和本人原声，不用录音朗读另一份文案；成片按实际讲话时长制作。</p></>}

        </div>
        <div className="dh-options">
          <label className="dh-field"><span>{legacyTask ? '样片时长' : '目标时长'}</span><select disabled={locked || !!busy} value={draft.durationSeconds} onChange={(event) => setDraft({ ...draft, durationSeconds: Number(event.target.value) })}>
            {(legacyTask ? [10, 11, 12, 13, 14, 15] : [15, 30, 45]).map((seconds) => <option key={seconds} value={seconds}>{seconds}秒</option>)}</select></label></div>
        {!locked && <div className="dh-draft-actions"><button type="button" className="dh-button" disabled={!!busy} onClick={() => void saveDraft()}>保存草稿</button>
          <button type="button" className="dh-button is-primary" data-xiaoxi-digital-human-action="preview" disabled={!canPreview} onClick={() => void makePreview()}>
          {busy === 'preview' ? <LoaderCircle className="dh-spinning" size={17} /> : <ArrowRight size={17} />}{legacyTask ? '生成人物预览' : '准备声音与人物预览'}</button></div>}
        {locked && !working && <button type="button" className="dh-button dh-create" disabled={!!busy} onClick={newSample}>调整后新建样片</button>}
      </section>
      <section className="dh-output" aria-label="场景预览与成片">
        <div className="dh-output-head"><h2>{videoUrl ? '样片' : preview ? '人物与产品预览' : '场景示意'}</h2>{selected && <span className="dh-status">{working && <LoaderCircle className="dh-spinning" size={14} />}{selected.statusLabel}</span>}</div>
        <div className={`dh-preview${!preview && !videoUrl ? ' is-scene' : ''}`}>{videoUrl ? <video controls src={videoUrl} preload="metadata" aria-label="数字人样片" /> : preview ? <img src={preview} alt="人物与产品在所选场景中的生成预览" />
          : <><img src={SCENE_IMAGES[draft.sceneId]} alt={`${scene?.name || '所选场景'}环境示意`} />{working && <div className="dh-preview-progress" role="status"><LoaderCircle className="dh-spinning" size={22} /><span>{selected?.statusLabel}</span></div>}</>}</div>
        {!preview && !videoUrl && <p className="dh-scene-caption">环境示意，实际画面以生成结果为准。</p>}
        {!working && !videoUrl && <div className={`dh-preview-help${serviceUnavailable ? ' is-unavailable' : ''}`} role="status"><span>{previewHelp}</span>
          {serviceUnavailable && <button className="dh-text-button" disabled={!!busy} onClick={() => void perform('capability', loadCapabilities)}>重新检查</button>}</div>}
        {selected?.error && <div className="dh-message is-error" role="alert"><CircleAlert size={16} /><span>{selected.error}</span></div>}
        {preparedSpeech && <audio className="dh-audio" controls src={preparedSpeech} aria-label="本片完整口播试听" />}
        {selected?.reusedAudioFrom && <p className="dh-quality">已复用原任务的完整口播与字幕，不重新购买配音。</p>}
        {selected?.voiceSource === 'uploaded_audio' && selected.status === 'preview_ready' && <label className="dh-field"><span>录音字幕校对</span>
          <textarea rows={4} maxLength={5000} disabled={!!busy} value={transcriptText} onChange={(event) => setTranscriptText(event.target.value)} aria-describedby="dh-transcript-help" />
          <small className="dh-quality" id="dh-transcript-help">仅修正识别字词或等值数字写法，不改变原音轨；请对照上方录音核对，不要增删句子或改动数字、型号。</small>
        </label>}
        {selected?.voiceName && <p className="dh-quality">本片声音：{selected.voiceName}</p>}
        {selected?.audio && <p className="dh-quality" role="status">{selected.audio.prepared ? `声音已准备：${Number(selected.audio.seconds || 0).toFixed(1)}秒，${selected.audio.segmentCount || 1}段；口型和字幕使用同一音轨。` : '先核对完整声音与台词，再提交视频。'}</p>}
        <div className="dh-output-actions">
          {selected?.status === 'preview_ready' && <button className="dh-button is-primary" data-xiaoxi-digital-human-action="confirm" disabled={!!busy || !preview || (selected.pipelineVersion === 2 && !capabilities?.ready)}
            onClick={() => void perform('confirm', async () => apply(await unwrap(api().confirm({ id: selected.id, previewRevision: selected.previewRevision, ...(selected.voiceSource === 'uploaded_audio' ? { transcriptText } : {}) }))))}>确认预览，生成样片<ArrowRight size={16} /></button>}
          {selected?.canResume && <button className="dh-button" data-xiaoxi-digital-human-action="resume" disabled={!!busy} onClick={() => void perform('resume', async () => apply(await unwrap(api().resume({ id: selected.id }))))}>继续处理</button>}
          {selected?.canRefresh && <button className="dh-button" disabled={!!busy} onClick={() => void perform('refresh', async () => apply(await unwrap(api().refresh({ id: selected.id }))))}><RefreshCw size={15} />刷新进度</button>}
          {videoUrl && <button className="dh-button is-primary" disabled={!!busy} onClick={() => void download()}><Download size={16} />保存成片</button>}
        </div>
        {selected && <p className="dh-quality">{selected.outputQuality || '沿用原任务画质'}；请核对肤色、口型和产品细节。</p>}
        {videoUrl && <div className="dh-cover"><VideoCoverDetails generatedId={selected!.generatedVideoId} /></div>}
      </section>
    </div>
    {!!items.length && <section className="dh-history"><h2>最近样片</h2><div>{items.map((task) => <button type="button" key={task.id} disabled={!!busy} className={selected?.id === task.id ? 'is-selected' : ''} onClick={() => selectTask(task)}>
      <span><strong>{task.title}</strong><small>{new Date(task.createdAt).toLocaleDateString('zh-CN')} · {task.actualDurationSeconds ? `${task.actualDurationSeconds.toFixed(1)}秒` : `${task.narrationPolicy === 'original_script' ? '目标' : ''}${task.durationSeconds}秒`}</small></span><span>{task.statusLabel}</span></button>)}</div></section>}
  </div>;
}
