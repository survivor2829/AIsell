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
const EMPTY: DigitalHumanDraft = { personAssetId: '', productAssetId: '', sceneId: 'studio', voiceStyle: 'natural_female', durationSeconds: 12, script: '' };
const ACTIVE = new Set(['preview_preparing', 'preview_generating', 'registering', 'reviewing', 'video_submitting', 'video_generating', 'packaging']);
const SCENE_IMAGES: Record<string, string> = Object.fromEntries(['studio', 'store', 'display'].map((id) => [id, `${import.meta.env.BASE_URL}digital-human-scenes/${id}.png`]));

export function DigitalHumanPage() {
  const [capabilities, setCapabilities] = useState<DigitalHumanCapabilities | null>(null);
  const [draft, setDraft] = useState<DigitalHumanDraft>({ ...EMPTY });
  const [images, setImages] = useState<{ person?: DigitalHumanAsset; product?: DigitalHumanAsset }>({});
  const [items, setItems] = useState<DigitalHumanTask[]>([]);
  const [selected, setSelected] = useState<DigitalHumanTask | null>(null);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const selection = useRef('');
  const loadedPreview = useRef('');
  const mounted = useRef(true);
  const locked = Boolean(selected && selected.status !== 'draft');

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
    selection.current = ''; setSelected(null); setPreview(''); loadedPreview.current = ''; setNotice(null);
  }
  async function importImage(role: 'person' | 'product') {
    await perform(role, async () => {
      const image = await unwrap(api().importImage());
      if (!image) return;
      setImages((current) => ({ ...current, [role]: image }));
      setDraft((current) => ({ ...current, [`${role}AssetId`]: image.id }));
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
      voiceStyle: task.voiceStyle, durationSeconds: task.durationSeconds, script: task.script });
    setImages({}); setPreview(''); loadedPreview.current = ''; setNotice(null);
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
  const canPreview = Boolean(capabilities?.ready && draft.personAssetId && draft.productAssetId && draft.script.trim() && !locked && !busy);
  const scene = capabilities?.scenes.find((item) => item.id === draft.sceneId);
  const previewHelp = !capabilities ? '正在检查生成服务…' : !capabilities.ready ? capabilities.message
    : preview ? '确认人物、产品和比例后，再生成视频。'
    : !draft.personAssetId || !draft.productAssetId ? '选择形象和产品图片后，生成人物预览。'
    : !draft.script.trim() ? '写下想讲的话，再生成人物预览。' : '生成人物预览后，确认形象与产品再制作视频。';

  return <div className="digital-human-page">
    <header className="dh-header"><div><h1>数字人视频</h1><p>上传形象和产品，选择出镜场景。</p></div>
      <button className="dh-button" onClick={newSample} disabled={!!busy}><Plus size={16} />新建样片</button></header>
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
        <label className="dh-field"><span>想讲什么</span><textarea disabled={locked || !!busy} maxLength={160} rows={3} value={draft.script}
          placeholder="用一句话介绍产品的特点或用途。" onChange={(event) => setDraft({ ...draft, script: event.target.value })} /></label>
        <div className="dh-options"><label className="dh-field"><span>声音风格</span><select disabled={locked || !!busy} value={draft.voiceStyle} onChange={(event) => setDraft({ ...draft, voiceStyle: event.target.value })}>
          {capabilities?.voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</select></label>
          <label className="dh-field"><span>样片时长</span><select disabled={locked || !!busy} value={draft.durationSeconds} onChange={(event) => setDraft({ ...draft, durationSeconds: Number(event.target.value) })}>
            {[10, 12, 15].map((seconds) => <option key={seconds} value={seconds}>{seconds}秒</option>)}</select></label></div>
        {!locked && <div className="dh-draft-actions"><button type="button" className="dh-button" disabled={!!busy} onClick={() => void saveDraft()}>保存草稿</button>
          <button type="button" className="dh-button is-primary" data-xiaoxi-digital-human-action="preview" disabled={!canPreview} onClick={() => void makePreview()}>
          {busy === 'preview' ? <LoaderCircle className="dh-spinning" size={17} /> : <ArrowRight size={17} />}生成人物预览</button></div>}
        {locked && !working && <button type="button" className="dh-button dh-create" disabled={!!busy} onClick={newSample}>调整后新建样片</button>}
      </section>
      <section className="dh-output" aria-label="场景预览与成片">
        <div className="dh-output-head"><h2>{videoUrl ? '样片' : preview ? '人物与产品预览' : '场景示意'}</h2>{selected && <span className="dh-status">{working && <LoaderCircle className="dh-spinning" size={14} />}{selected.statusLabel}</span>}</div>
        <div className={`dh-preview${!preview && !videoUrl ? ' is-scene' : ''}`}>{videoUrl ? <video controls src={videoUrl} preload="metadata" aria-label="数字人样片" /> : preview ? <img src={preview} alt="人物与产品在所选场景中的生成预览" />
          : <><img src={SCENE_IMAGES[draft.sceneId]} alt={`${scene?.name || '所选场景'}环境示意`} />{working && <div className="dh-preview-progress" role="status"><LoaderCircle className="dh-spinning" size={22} /><span>{selected?.statusLabel}</span></div>}</>}</div>
        {!preview && !videoUrl && <p className="dh-scene-caption">环境示意，实际画面以生成结果为准。</p>}
        {!working && !videoUrl && <div className={`dh-preview-help${capabilities && !capabilities.ready ? ' is-unavailable' : ''}`} role="status"><span>{previewHelp}</span>
          {capabilities && !capabilities.ready && <button className="dh-text-button" disabled={!!busy} onClick={() => void perform('capability', loadCapabilities)}>重新检查</button>}</div>}
        {selected?.error && <div className="dh-message is-error" role="alert"><CircleAlert size={16} /><span>{selected.error}</span></div>}
        <div className="dh-output-actions">
          {selected?.status === 'preview_ready' && <button className="dh-button is-primary" data-xiaoxi-digital-human-action="confirm" disabled={!!busy || !preview || !capabilities?.ready}
            onClick={() => void perform('confirm', async () => apply(await unwrap(api().confirm({ id: selected.id, previewRevision: selected.previewRevision }))))}>确认预览，生成样片<ArrowRight size={16} /></button>}
          {selected?.canResume && <button className="dh-button" data-xiaoxi-digital-human-action="resume" disabled={!!busy} onClick={() => void perform('resume', async () => apply(await unwrap(api().resume({ id: selected.id }))))}>继续处理</button>}
          {selected?.canRefresh && <button className="dh-button" disabled={!!busy} onClick={() => void perform('refresh', async () => apply(await unwrap(api().refresh({ id: selected.id }))))}><RefreshCw size={15} />刷新进度</button>}
          {videoUrl && <button className="dh-button is-primary" disabled={!!busy} onClick={() => void download()}><Download size={16} />保存成片</button>}
        </div>
        {videoUrl && <div className="dh-cover"><VideoCoverDetails generatedId={selected!.generatedVideoId} /></div>}
      </section>
    </div>
    {!!items.length && <section className="dh-history"><h2>最近样片</h2><div>{items.map((task) => <button type="button" key={task.id} disabled={!!busy} className={selected?.id === task.id ? 'is-selected' : ''} onClick={() => selectTask(task)}>
      <span><strong>{task.title}</strong><small>{new Date(task.createdAt).toLocaleDateString('zh-CN')} · {task.durationSeconds}秒</small></span><span>{task.statusLabel}</span></button>)}</div></section>}
  </div>;
}
