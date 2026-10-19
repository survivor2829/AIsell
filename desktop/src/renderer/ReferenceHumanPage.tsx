import { ReferenceCostSummary } from './ReferenceCostSummary';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Download, History, LoaderCircle, Plus, RefreshCw, Upload, Video } from 'lucide-react';
import type { DigitalHumanResult } from './digital-human-types';
import type { ReferenceAsset, ReferenceCapabilities, ReferenceDraft, ReferenceHumanApi, ReferenceTask, ScriptQuota, ReferenceWorkspace, ScriptInput, ScriptSuggestion } from './reference-human-types';
import { ReferenceCoverPanel } from './ReferenceCoverPanel';
import { NarrationTemplatePicker } from './NarrationTemplatePicker';
import { ReferenceSourcesPanel } from './ReferenceSourcesPanel';
import narrationTemplates from '../../remotion-packaging/narration-templates.json';
import referencePolicy from '../shared/reference-human.json';
import './ReferenceHumanPage.css';

const referenceApi = () => (window as unknown as { xiaoxiDigitalHuman: { reference: ReferenceHumanApi } }).xiaoxiDigitalHuman.reference;
async function unwrap<T>(result: Promise<DigitalHumanResult<T>>): Promise<T> {
  const value = await result; if (!value.ok || value.data === undefined) throw new Error(value.error || '操作未完成，请稍后重试。'); return value.data;
}
const initialDraft: ReferenceDraft = { referenceAssetId: '', script: '', title: '', captionStyleId: narrationTemplates.defaultTemplateId, voiceStyleId: narrationTemplates.defaultVoiceStyleId, emphasisPhrases: [] as string[], industry: '清洁设备渠道商', business: '', includeCover: true, packagingMode: 'auto', soundEffects: true };

function taskDraft(item: ReferenceTask): ReferenceDraft {
  return { packagingMode: item.packagingMode || 'manual', soundEffects: item.soundEffects !== false, referenceAssetId: item.referenceAssetId, script: item.script, title: item.title, captionStyleId: item.captionStyleId, musicTrackId: item.musicTrackId, industry: item.industry || initialDraft.industry, business: item.business || '', voiceStyleId: item.voiceStyleId || 'original', emphasisPhrases: item.emphasisPhrases || [], referenceSource: item.referenceSource, includeCover: item.includeCover ?? false, coverStyle: item.coverStyle || 'paper', remakeOfTaskId: item.remakeOfTaskId };
}
export function ReferenceHumanPage() {
  const [capabilities, setCapabilities] = useState<ReferenceCapabilities | null>(null);
  const [assets, setAssets] = useState<ReferenceAsset[]>([]);
  const [tasks, setTasks] = useState<ReferenceTask[]>([]);
  const [draft, setDraft] = useState<ReferenceDraft>(initialDraft);
  const [task, setTask] = useState<ReferenceTask | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [speech, setSpeech] = useState('');
  const [step, setStep] = useState(1), [previewFirst, setPreviewFirst] = useState(false);
  const [quota, setQuota] = useState<ScriptQuota | null>(null), [quotaError, setQuotaError] = useState('');
  const [ready, setReady] = useState(false);
  const [preferences, setPreferences] = useState<ReferenceWorkspace['preferences']>({});
  const [pendingScript, setPendingScript] = useState<ScriptInput>();
  const [suggestion, setSuggestion] = useState<ScriptSuggestion>();
  const busyRef = useRef(false), persisted = useRef(''), workspaceWritable = useRef(false);
  const session = useRef<ReferenceWorkspace>({ preferences: {} });
  const root = useRef<HTMLDivElement>(null);
  const history = useRef<HTMLDetailsElement>(null);
  const asset = assets.find((item) => item.id === draft.referenceAssetId);
  const locked = Boolean(task && task.status !== 'draft');
  const personReady = Boolean(asset?.available !== false && asset?.voiceSampleReady && asset.seconds >= referencePolicy.limits.narrationMinSeconds);
  const selectedTemplate = narrationTemplates.templates.find((item) => item.id === draft.captionStyleId);
  const selectedVoice = narrationTemplates.voiceStyles.find((item) => item.id === draft.voiceStyleId);
  const working = Boolean(task && !['draft', 'completed', 'preview_ready', 'needs_attention', 'outcome_unknown'].includes(task.status));
  const video = task?.status === 'completed' && /^generated_video_[A-Za-z0-9_-]+$/u.test(task.generatedVideoId || '')
    ? `xiaoxi-content://generated/${task.generatedVideoId}/video` : '';
  const updateAsset = (item: ReferenceAsset) => setAssets((current) => [item, ...current.filter((old) => old.id !== item.id)]);
  const apply = (item: ReferenceTask) => { setTask(item); setTasks((current) => [item, ...current.filter((old) => old.id !== item.id)]); };
  function applyPackaging(item: ReferenceTask) { apply(item); setDraft(taskDraft(item)); setStep(3); }
  async function run(name: string, action: () => Promise<void>) {
    if (busyRef.current) return; busyRef.current = true; setBusy(name); setNotice('');
    try { await action(); } catch (error) { setNotice((error as Error).message); } finally { busyRef.current = false; setBusy(''); }
  }
  useEffect(() => {
    root.current?.querySelectorAll<HTMLMediaElement>('video, audio').forEach((media) => media.pause());
    root.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [step, task?.id]);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([referenceApi().capabilities(), referenceApi().assets(), referenceApi().list(), referenceApi().workspace()]).then(([cap, people, history, saved]) => {
      if (!active) return;
      if (cap.status === 'fulfilled' && cap.value.ok && cap.value.data) setCapabilities(cap.value.data);
      const available = people.status === 'fulfilled' && people.value.ok ? people.value.data?.items || [] : [];
      const records = history.status === 'fulfilled' && history.value.ok ? history.value.data?.items || [] : [];
      setAssets(available); setTasks(records);
      if (saved.status === 'fulfilled' && saved.value.ok && saved.value.data) {
        workspaceWritable.current = true; const state = saved.value.data; setPreferences(state.preferences || {});
        const restored = { ...initialDraft, ...state.preferences, ...state.draft };
        const person = available.find((item) => item.id === restored.referenceAssetId);
        const selected = records.find((item) => item.id === state.taskId);
        setPendingScript(state.pendingScript); setSuggestion(state.suggestion);
        if (selected && selected.status !== 'draft') { apply(selected); setDraft(taskDraft(selected)); setStep(3); }
        else {
          setDraft(restored); if (selected) apply({ ...selected, quote: undefined, quoteRevision: undefined });
          if (person?.voiceSampleReady && person.seconds >= referencePolicy.limits.narrationMinSeconds && person.available !== false) setStep(2);
          else if (restored.referenceAssetId) setNotice('上次人物素材不可用，请重新选择；原制作记录保留。');
        }
      } else if (saved.status === 'fulfilled' && !saved.value.ok) setNotice(saved.value.error || '编辑记录读取失败。');
      if (people.status === 'fulfilled' && !people.value.ok) setNotice(people.value.error || '人物素材读取失败，请重新进入。');
      setReady(true);
    });
    void unwrap(referenceApi().scriptQuota()).then((result) => { if (active) setQuota(result.quota); }).catch((error) => { if (active) setQuotaError(error.message); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!task || ['draft', 'preview_ready', 'needs_attention', 'outcome_unknown'].includes(task.status) || task.status === 'completed' && !['planned', 'submitted'].includes(task.autoCoverState || '')) return;
    let active = true;
    const timer = window.setInterval(() => { void unwrap(referenceApi().get({ id: task.id })).then((item) => { if (active) apply(item); }).catch((error) => { if (active) setNotice(error.message); }); }, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [task?.id, task?.status, task?.autoCoverState]);
  useEffect(() => {
    setSpeech(''); if (!task?.audioAvailable && !task?.audioPrepared) return;
    let active = true;
    void unwrap(referenceApi().speechMedia({ id: task.id })).then((result) => { if (active) setSpeech(result.audioDataUrl); }).catch((error) => { if (active) setNotice(error.message); });
    void unwrap(referenceApi().assets()).then((result) => { if (active) setAssets(result.items); }).catch(() => {});
    return () => { active = false; };
  }, [task?.id, task?.audioAvailable, task?.audioPrepared]);
  session.current = { preferences, draft, taskId: task?.id, pendingScript, suggestion };
  useEffect(() => {
    if (!ready || !workspaceWritable.current) return;
    const save = () => {
      const value = session.current, serialized = JSON.stringify(value);
      if (serialized === persisted.current) return;
      persisted.current = serialized;
      void unwrap(referenceApi().saveWorkspace(value)).catch((error) => { persisted.current = ''; setNotice('编辑记录保存失败：' + error.message); });
    };
    const timer = window.setTimeout(save, 250);
    return () => { clearTimeout(timer); save(); };
  }, [ready, draft, preferences, task?.id, pendingScript, suggestion]);
  function newDraft(from?: ReferenceTask) {
    setTask(null); setDraft(from ? { ...taskDraft(from), remakeOfTaskId: from.id } : { ...initialDraft, ...preferences });
    setSpeech(''); setConsent(false); setSuggestion(undefined); setPreviewFirst(false);
    setNotice(from ? '原成片已保留。改好正文后重新确认费用，再制作新口播。' : '');
    const selected = assets.find((item) => item.id === (from?.referenceAssetId || preferences.referenceAssetId));
    setStep(selected?.available !== false && selected?.voiceSampleReady && selected.seconds >= referencePolicy.limits.narrationMinSeconds ? 2 : 1);
  }
  function writeScript(referenceSource = draft.referenceSource, recover = false) {
    const input = recover && pendingScript ? pendingScript : { generationIntentId: crypto.randomUUID(), referenceAssetId: draft.referenceAssetId, industry: draft.industry || initialDraft.industry!, business: draft.business || '', referenceSource };
    void run('script', async () => {
      setPendingScript(input); setSuggestion(undefined);
      try {
        const result = await unwrap(referenceApi().writeScript({ ...input, recoverOnly: recover }, { ...session.current, pendingScript: input, suggestion: undefined }));
        const next = { title: result.title, script: result.script, emphasisPhrases: result.emphasisPhrases, referenceSource: result.referenceSource || input.referenceSource };
        if (draft.script.trim()) setSuggestion(next); else edit(next);
        setQuota(result.quota); setPendingScript(undefined);
      } finally {
        try { const result = await unwrap(referenceApi().scriptQuota()); setQuota(result.quota); setQuotaError(''); }
        catch { setQuota(null); setQuotaError('额度暂时无法核实，请刷新；不会自动重新写稿。'); }
      }
    });
  }
  function edit(patch: Partial<ReferenceDraft>) {
    setConsent(false);
    if (!locked || task?.status === 'completed') setPreferences((current) => ({ ...current, ...Object.fromEntries(Object.entries(patch).filter(([key]) => ['referenceAssetId', 'captionStyleId', 'musicTrackId', 'includeCover', 'coverStyle', 'packagingMode', 'soundEffects'].includes(key))) }));
    setDraft((current) => ({ ...current, ...patch, ...(patch.script !== undefined && patch.emphasisPhrases === undefined ? { emphasisPhrases: (current.emphasisPhrases || []).filter((phrase) => patch.script!.includes(phrase)) } : {}) }));
    setTask((current) => current?.status === 'draft' ? { ...current, quote: undefined, quoteRevision: undefined } : current);
  }
  function selectTask(item: ReferenceTask) { apply(item); setDraft(taskDraft(item)); setConsent(false); setNotice(''); setSuggestion(undefined); setStep(3); }
  async function quote() {
    await run('quote', async () => {
      const saved = await unwrap(referenceApi().create({ ...draft, emphasisPhrases: (draft.emphasisPhrases || []).map((text) => text.trim()).filter(Boolean), ...(task?.status === 'draft' ? { id: task.id } : {}) }));
      apply(saved); const quoted = await unwrap(referenceApi().quote({ id: saved.id })); apply(quoted); setDraft(current => ({ ...current, captionStyleId: quoted.captionStyleId })); setConsent(false); setStep(3);
    });
  }
  return <div ref={root} className="digital-human-page reference-human-page">
    <header className="dh-header"><div className="dh-heading"><h1>数字人口播</h1><p>用你的形象和声音，把行业好内容讲给客户听。</p></div>
      <div className="dh-header-actions"><button className="dh-button" onClick={() => { if (history.current) { history.current.open = true; history.current.scrollIntoView({ block: 'start', behavior: 'instant' }); } }}><History size={17} />制作记录{tasks.length ? `（${tasks.length}）` : ''}</button>
      <button className="dh-button" disabled={!!busy} onClick={() => newDraft()}><Plus size={17} />新建口播</button></div></header>
    {notice && <p className="dh-message is-error" role="alert">{notice}</p>}
    <nav className="rh-steps" aria-label="口播制作步骤">{['我的形象', '今天讲什么', '制作与成片'].map((label, index) => <button type="button" key={label}
      aria-current={step === index + 1 ? 'step' : undefined} aria-controls={`rh-step-${index + 1}`} disabled={!!busy || index === 1 && !personReady && !locked || index === 2 && !task}
      onClick={() => setStep(index + 1)}><span>{index + 1}</span>{label}</button>)}</nav>
    {step !== 1 && asset && <div className="rh-current-person"><img src={asset.previewDataUrl} alt="" /><span><strong>{asset.name}</strong><small>本人声音 · {asset.seconds.toFixed(1)}秒素材</small></span><button className="dh-text-button" disabled={!!busy} onClick={() => setStep(1)}>{locked ? '查看人物' : '更换人物'}</button></div>}
    {!ready && <p role="status">正在读取人物与制作记录…</p>}
    <div className={`dh-workspace${step === 3 && working || busy === 'script' ? ' is-producing' : ''}`}>
      <section className="dh-form" aria-label="人物与口播设置">
        <div id="rh-step-1" hidden={step !== 1}>
        <h2 className="rh-section-title">这次，由谁出镜？</h2>
        <p className="dh-quality">选一个已保存的人物，或上传新视频。文案会按视频时长规划。</p>
        <div className="rh-people"><button className="rh-upload-person" disabled={!ready || !!busy || locked} onClick={() => void run('import', async () => {
          const item = await unwrap(referenceApi().importVideo()); if (!item) return; updateAsset(item); edit({ referenceAssetId: item.id }); setConsent(false);
        })}>{busy === 'import' ? <LoaderCircle className="dh-spinning" size={26} /> : <Upload size={26} />}<strong>{busy === 'import' ? '正在检查人物与声音…' : '上传本人视频'}</strong><small>正面讲话 · 至少15秒<br />只有本人声音，不加音乐</small></button>
          {assets.map((item) => <button type="button" key={item.id} className="rh-person" aria-pressed={draft.referenceAssetId === item.id} disabled={!!busy || locked || item.available === false} onClick={() => edit({ referenceAssetId: item.id })}>
            <span className="rh-person-image"><img src={item.previewDataUrl} alt="" loading="lazy" /><span>{item.seconds.toFixed(1)}秒</span>{draft.referenceAssetId === item.id && <Check className="rh-person-check" size={20} />}</span>
            <strong title={item.name}>{item.name}</strong><small>{item.available === false ? '素材文件缺失，请重新导入' : item.seconds < referencePolicy.limits.narrationMinSeconds ? `不足${referencePolicy.limits.narrationMinSeconds}秒，请补录` : item.voice?.usable ? '本人声音已保存' : item.voiceSampleReady ? '声音可用 · 制作时建立音色' : '需要补录有效声音'}</small></button>)}
        </div>
        {asset && <div className="rh-voice-setup"><h3>我的声音</h3>
          {!asset.voiceSampleReady ? <p className="dh-quality">有效讲话不足5秒，请补录连续自然讲话的视频。</p>
            : <p className={asset.voice?.usable ? 'rh-ready' : 'dh-quality'}>{asset.voice?.usable ? '本人声音已保存，后续口播自动复用。' : '确认制作费用后，自动从这段视频建立本人声音；无需去其他后台操作。'}</p>}
          {asset.audioQuality && <details className="dh-quality-details"><summary>查看声音检查结果</summary><p>有效讲话约{asset.audioQuality.activeSeconds.toFixed(1)}秒。{asset.audioQuality.note}</p></details>}
          {asset.audioQuality?.warnings.map((warning) => <p className="dh-quality" key={warning}>{warning}</p>)}
        </div>}
        <div className="rh-step-actions"><button type="button" className="dh-button is-primary" disabled={!personReady || !!busy} onClick={() => setStep(2)}>用这个人物，准备文案<ArrowRight size={16} /></button></div>
        </div>
        <div id="rh-step-2" hidden={step !== 2}>
        <h2 className="rh-section-title">今天，给客户讲什么？</h2>
        <p className="dh-quality">清洁设备行业 · 面向物业、工厂、商超采购客户</p>
        <details className="rh-business"><summary>补充产品与卖点（选填）</summary><label className="dh-field rh-title-field"><span>真实产品资料</span><textarea rows={3} maxLength={2000} value={draft.business || ''} disabled={locked || !!busy} onChange={(event) => edit({ business: event.target.value })} placeholder="例如：适合窄通道的手推洗地机。没有资料时，只写行业通用建议。" /></label></details>
        <ReferenceSourcesPanel active={step === 2 && !locked} canWrite={personReady && quota?.status === 'available' && !pendingScript} onWrite={writeScript} api={referenceApi()} value={draft.referenceSource} onChange={(referenceSource) => edit({ referenceSource })} disabled={locked} busy={!!busy} />
        <div className="rh-script-quota"><p className="dh-quality">{quota?.status === 'available' ? `本期写稿额度剩余${quota.remaining}次（套餐共${quota.limit}次）` : quota?.status === 'exhausted' ? '本期写稿额度已用完，可以直接填写文案。' : quotaError || '套餐写稿额度暂未就绪，可以直接填写文案。'}</p>
          <button type="button" className="dh-text-button" disabled={!!busy} onClick={() => void run('script-quota', async () => { const result = await unwrap(referenceApi().scriptQuota()); setQuota(result.quota); setQuotaError(''); })}>刷新额度</button></div>
        {!locked && <div className="rh-writing-actions"><button className="dh-button rh-write-script" data-xiaoxi-digital-human-action="reference-write-script" disabled={!!busy || !personReady || quota?.status !== 'available' || !!pendingScript} onClick={() => writeScript()}>{draft.script.trim() ? '换个方向 · 使用1次写稿额度' : '生成原创稿 · 使用1次写稿额度'}</button>
        {pendingScript && <><p className="dh-quality">上次写稿结果待核对，先查询原请求；不会自动重新扣额度。</p><button className="dh-button" data-xiaoxi-digital-human-action="reference-write-script" disabled={!!busy} onClick={() => writeScript(undefined, true)}>查询上次写稿结果</button><button className="dh-text-button" disabled={!!busy} onClick={() => { setPendingScript(undefined); setNotice('已保留原写稿回执。再次点击写稿将使用新的套餐额度，也可以直接手填。'); }}>结束等待，改为手填或另写</button></>}
        </div>}
        {busy === 'script' && <NarrationWaiting title="正在写一份适合你讲的稿" detail="结合所选参考与实际产品资料，按人物视频时长组织表达。" />}
        {suggestion && <section className="rh-script-suggestion" aria-label="新文案对照"><h3>新方向，先看看</h3><strong>{suggestion.title}</strong><p>{suggestion.script}</p><div className="rh-source-actions"><button className="dh-button is-primary" disabled={!!busy} onClick={() => { edit(suggestion); setSuggestion(undefined); }}>采用新稿</button><button className="dh-button" disabled={!!busy} onClick={() => setSuggestion(undefined)}>保留当前稿</button></div></section>}
        {asset?.narrationPlan && (!task || (task.pipelineVersion || 4) >= 5) && asset.seconds >= referencePolicy.limits.narrationMinSeconds && <p className="dh-quality">当前人物视频{asset.seconds.toFixed(1)}秒，文案按约{asset.narrationPlan.minimumSeconds}—{asset.narrationPlan.maximumSeconds}秒规划，建议不超过{asset.narrationPlan.maxCharacters}个中文字。实际时长以配音为准，超长会暂停。</p>}
        <label className="dh-field rh-script-field"><span>口播正文 <small>{draft.script.length} / 500字</small></span><textarea rows={6} maxLength={500} value={draft.script} disabled={locked || !!busy} onChange={(event) => edit({ script: event.target.value })} placeholder="可以直接粘贴自己的稿，也可以选上方参考生成原创稿。确认后，数字人就照这份正文讲。" /></label>
        <label className="dh-field rh-title-field"><span>标题与封面文字</span><input value={draft.title || ''} maxLength={24} disabled={locked || !!busy} onChange={(event) => edit({ title: event.target.value })} placeholder="可留空，默认提取文案第一句" /></label>
        <details className="rh-advanced"><summary>制作设置 <small>{selectedVoice?.name} · {draft.packagingMode === 'auto' ? '智能匹配包装' : selectedTemplate?.name}{draft.includeCover !== false ? ' · AI封面' : ''}</small></summary>
        <label className="dh-field"><span>声音表达</span><select value={draft.voiceStyleId || 'original'} disabled={locked || !!busy} onChange={(event) => edit({ voiceStyleId: event.target.value })}>{narrationTemplates.voiceStyles.filter((item) => item.id === 'original' || item.id === draft.voiceStyleId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="dh-field"><span>包装方式</span><select value={draft.packagingMode || 'manual'} disabled={!!busy || locked && task?.status !== 'completed'} onChange={(event) => edit({ packagingMode: event.target.value as 'auto' | 'manual', ...(event.target.value === 'auto' ? { coverStyle: undefined } : {}) })}><option value="auto">智能匹配（推荐）</option><option value="manual">自己选择风格</option></select></label>
        {draft.packagingMode === 'auto' && <p className="dh-quality">按稿件结构和画面留白选好包装，配音后按实际节奏细调；不会增加云端调用。</p>}
        {draft.packagingMode !== 'auto' && <NarrationTemplatePicker plan={draft.script === task?.script ? task.packagingPlan : undefined} title={draft.title} value={draft.captionStyleId} onChange={(captionStyleId) => { const previous = narrationTemplates.templates.find((item) => item.id === draft.captionStyleId); const next = narrationTemplates.templates.find((item) => item.id === captionStyleId); edit({ packagingMode: 'manual', captionStyleId, ...(draft.coverStyle === previous?.coverStyle ? { coverStyle: next?.coverStyle } : {}) }); }} poster={asset?.previewDataUrl} disabled={!!busy || locked && task?.status !== 'completed'} />}
        <label className="dh-field"><span>重点短语（选填，用顿号分隔）</span><input className="rh-emphasis" value={(draft.emphasisPhrases || []).join('、')} disabled={!!busy || locked && task?.status !== 'completed'} onChange={(event) => edit({ emphasisPhrases: event.target.value.split('、') })} placeholder="从口播原文选择，例如：别只看价格、选对机器" /></label>
        <label className="rh-consent"><input type="checkbox" checked={draft.soundEffects !== false} disabled={!!busy || locked && task?.status !== 'completed'} onChange={(event) => edit({ soundEffects: event.target.checked })} />少量点缀音效（人声优先，可关闭）</label>
        <p className="dh-quality">自动选择已有曲库配乐，人声优先，首尾淡入淡出。换模板只重新本地包装。</p>
        <label className="rh-consent"><input type="checkbox" checked={draft.includeCover !== false} disabled={!!busy || locked} onChange={(event) => edit({ includeCover: event.target.checked })} />同时生成一张3:4 AI封面，计入总报价</label>
        {draft.includeCover !== false && <label className="dh-field"><span>封面风格</span><select value={draft.coverStyle || 'paper'} disabled={!!busy || locked} onChange={(event) => edit({ coverStyle: event.target.value })}>{narrationTemplates.coverStyles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        <label className="rh-consent"><input type="checkbox" checked={previewFirst} disabled={!!busy || locked} onChange={(event) => setPreviewFirst(event.target.checked)} />先试听配音，再确认人物制作</label>
        </details>
        {task?.status === 'completed' && <button className="dh-button" disabled={!!busy || !narrationTemplates.templates.some((item) => item.id === draft.captionStyleId)} onClick={() => void run('repackage', async () => {
          applyPackaging(await unwrap(referenceApi().repackage({ id: task.id, captionStyleId: draft.captionStyleId!, soundEffects: draft.soundEffects, title: draft.title, emphasisPhrases: (draft.emphasisPhrases || []).filter(Boolean) }))); setStep(3);
        })}>应用模板，另存成片（本地免费）</button>}
        <div className="rh-step-actions"><button className="dh-button" disabled={!!busy} onClick={() => setStep(1)}><ArrowLeft size={16} />上一步</button>{!locked && <button className="dh-button is-primary" disabled={!!busy || !asset || !draft.script.trim()} onClick={() => void quote()}>{busy === 'quote' ? '正在核实费用…' : '确认文案与费用'}<ArrowRight size={16} /></button>}</div>
        </div>
        <div id="rh-step-3" hidden={step !== 3}>
          <h2 className="rh-section-title">{working ? task!.statusLabel : task?.status === 'completed' ? '口播已完成' : task?.status === 'draft' ? '确认后自动制作' : '生成与成片'}</h2>
          {working && <NarrationWaiting title="正在为你完成这一条口播" detail="当前步骤完成后会自动继续，可以切换模块，回来查看结果。" poster={asset?.previewDataUrl} />}
          {video && <div className="dh-output-actions">
          {video && <button className="dh-button" disabled={!!busy} onClick={() => void run('repackage', async () => { applyPackaging(await unwrap(referenceApi().repackage({ id: task!.id, nextStyle: true, soundEffects: draft.soundEffects }))); setStep(3); })}>换个风格 · 本地免费</button>}
          {video && <button className="dh-button" disabled={!!busy} onClick={() => newDraft(task!)}>改文案，再做一条</button>}
          {video && <button className="dh-button is-primary" disabled={!!busy} onClick={() => void run('download', async () => {
            const creative = (window as unknown as { xiaoxiContent: { creative: { downloadCandidate(payload: { candidateId: string }): Promise<DigitalHumanResult<unknown>> } } }).xiaoxiContent.creative;
            const result = await creative.downloadCandidate({ candidateId: task!.generatedVideoId! }); if (!result.ok) throw new Error(result.error || '下载未完成。');
          })}><Download size={16} />保存成片</button>}
          </div>}
          {task ? <><h3>{task.title}</h3><details className="rh-confirm-copy" open={task.status === 'draft'}><summary>本次口播文案</summary><p className="rh-confirm-script">{task.script}</p></details><p className="rh-stage-status" role="status">{working && <LoaderCircle size={18} className="dh-spinning" />}{task.status === 'completed' && <Check size={18} />}{task.statusLabel}</p>
            {task.status !== 'draft' && task.status !== 'completed' && <p className="dh-quality">结果未知时先查询原任务，不会自动重新购买。</p>}
            <button type="button" className="dh-button" disabled={!!busy} onClick={() => setStep(2)}>{task.status === 'completed' ? '手动调整包装' : locked ? '查看文案和设置' : '返回修改文案'}</button></>
            : <><p className="dh-quality">先选择人物、填写文案，再核对完整制作费用。</p><button type="button" className="dh-button" onClick={() => setStep(asset ? 2 : 1)}>继续准备口播</button></>}
        {task?.packagingPlan && <details className="rh-receipt"><summary>包装方案 · {narrationTemplates.templates.find(t => t.id === task.packagingPlan!.templateId)?.name}</summary><p className="dh-quality">{task.packagingPlan.reasons.join('；')}</p>{task.packagingPlan.warnings.map(note => <p className="dh-quality" key={note}>{note}</p>)}</details>}
        {task?.sourceTaskId && <p className="dh-quality">本次只更新本地包装；原片及原AI封面保留在制作记录，不会重新购买封面。</p>}
        {task?.remakeOfTaskId && !task.sourceTaskId && <p className="dh-quality">这是一条改稿重做的口播，原成片和费用记录保留；本次按新报价制作。</p>}
        {task?.error && <p className="dh-message is-error" role="alert">{task.error}</p>}
        {task?.videoFailure && <details className="dh-quality-details"><summary>查看失败任务编号</summary><p>云端任务号：{task.videoFailure.taskId}</p></details>}
        {task?.status === 'needs_attention' && !task.canResume && !task.videoFailure && <p className="dh-quality">已有结果和回执已保留。请先处理失败原因，再新建口播并确认费用；当前任务不会自动重新购买。</p>}
        {task && (task.status === 'draft' ? <ReferenceCostSummary task={task} previewFirst={previewFirst} /> : <details className="rh-receipt"><summary>费用与用量记录</summary><ReferenceCostSummary task={task} previewFirst={previewFirst} /></details>)}
        {speech && <details className="rh-speech" open={task?.status === 'preview_ready' || task?.status === 'needs_attention'} onToggle={(event) => { if (!event.currentTarget.open) event.currentTarget.querySelector('audio')?.pause(); }}><summary>{task?.audioPrepared ? '试听本次配音' : '已保存配音（待核对）'}</summary><audio controls src={speech} aria-label="本次本人声音配音" /></details>}
        {task?.actualDurationSeconds && <p className="dh-quality">实际口播{task.actualDurationSeconds.toFixed(1)}秒。人物驱动与字幕使用同一音轨。</p>}
        {task?.coverError && <p className="dh-message" role="status">封面暂未完成：{task.coverError}。视频可以正常播放和保存，请先查询原封面任务。</p>}
        {task?.status === 'draft' && task.quoteRevision && <label className="rh-consent"><input type="checkbox" checked={consent} disabled={!!busy} onChange={(event) => setConsent(event.target.checked)} />人物和声音来自本人或已获授权，已核对本次文案和费用。</label>}
        {capabilities && !capabilities.ready && <p className="dh-quality" role="status">{capabilities.message} <button className="dh-text-button" disabled={!!busy} onClick={() => void run('capabilities', async () => setCapabilities(await unwrap(referenceApi().capabilities())))}>重新检查连接</button></p>}
        <div className="dh-output-actions">
          {task?.status === 'draft' && task.quoteRevision && [2, 3].includes(task.quote?.schemaVersion || 0) && task.quote?.voiceModel === referencePolicy.automaticVoice.model && <button className="dh-button is-primary" data-xiaoxi-digital-human-action="reference-prepare" disabled={!!busy || !asset?.voiceSampleReady || !consent || !capabilities?.ready || !previewFirst && task.quote.schemaVersion === 3 && (asset?.seconds || 0) < ((task.pipelineVersion || 4) >= 5 ? referencePolicy.limits.narrationMinSeconds : 45)} onClick={() => void run('prepare', async () => { setStep(3); apply(await unwrap(referenceApi().prepare({ id: task.id, quoteRevision: task.quoteRevision!, customerConsent: consent, generateVideo: !previewFirst && task.quote?.schemaVersion === 3 }))); })}>{previewFirst || task.quote.schemaVersion !== 3 ? '确认配音费用，先试听' : '确认文案和总费用，一键生成'}</button>}
          {task?.status === 'preview_ready' && <button className="dh-button is-primary" data-xiaoxi-digital-human-action="reference-confirm" disabled={!!busy || !speech} onClick={() => void run('confirm', async () => apply(await unwrap(referenceApi().confirm({ id: task.id, previewRevision: task.previewRevision! }))))}>声音已确认，按已核对费用制作口播<ArrowRight size={16} /></button>}
          {task?.canResume && <button className="dh-button" data-xiaoxi-digital-human-action="reference-resume" disabled={!!busy} onClick={() => void run('resume', async () => apply(await unwrap(referenceApi().resume({ id: task.id }))))}>继续当前步骤</button>}
          {task?.canRefresh && task.status !== 'draft' && <button className="dh-button" disabled={!!busy} onClick={() => void run('refresh', async () => apply(await unwrap(referenceApi().refresh({ id: task.id }))))}><RefreshCw size={16} />查询原任务</button>}

        </div>
        </div>
      </section>
      <section className="dh-output" aria-label="本人分身预览与制作">
        <div className="dh-output-head"><h2>{video ? '本人口播成片' : '人物预览'}</h2>{task && <span className="dh-status">{task.statusLabel}</span>}</div>
        <div className="dh-preview">{video ? <video controls preload="metadata" src={video} aria-label="本人数字分身成片" /> : asset ? <img src={asset.previewDataUrl} alt="已导入真人视频中的人物" /> : <div className="rh-empty"><Video size={36} /><span>导入视频后查看本人画面</span></div>}</div>
        {asset && <p className="dh-scene-caption">{asset.width}×{asset.height} · 参考视频{asset.seconds.toFixed(1)}秒</p>}
        {!locked && asset && asset.seconds < referencePolicy.limits.narrationMinSeconds && <p className="dh-message">当前人物视频{asset.seconds.toFixed(1)}秒，完整口播需要至少{referencePolicy.limits.narrationMinSeconds}秒。可以先保存素材；未开始付费制作。</p>}
        {!locked && asset && task && (task.pipelineVersion || 4) === 4 && asset.seconds < 45 && <p className="dh-message">这份旧草稿仍按原来的30—45秒规则制作。请点击“新建口播”，使用当前素材按实际时长重新规划；原草稿和报价保留。</p>}
        {step === 3 && video && <details className="rh-cover-settings"><summary>封面预览与下载 <small>独立3:4图片</small></summary><ReferenceCoverPanel key={task!.id} task={task!} api={referenceApi()} onTask={apply} /></details>}
        {step !== 3 && <div className="rh-preview-summary"><h3>{asset ? '本次制作' : '先选一个出镜人物'}</h3>{asset ? <dl><div><dt>人物素材</dt><dd>{asset.seconds.toFixed(1)}秒</dd></div><div><dt>声音</dt><dd>{selectedVoice?.name || '原始表达'}</dd></div><div><dt>字幕模板</dt><dd>{draft.packagingMode === 'auto' ? '智能匹配' : selectedTemplate?.name || '保留原模板'}</dd></div><div><dt>配乐</dt><dd>自动配乐 · 人声优先</dd></div><div><dt>封面</dt><dd>{draft.includeCover !== false ? 'AI设计 · 确认费用后制作' : '不生成AI封面'}</dd></div></dl> : <p>上传视频后，这里会显示人物画面。只检查素材，不会开始付费制作。</p>}</div>}
      </section>
    </div>
    <details ref={history} className="dh-history rh-history"><summary>制作记录 <small>{tasks.length}条</small></summary>{!tasks.length && <p className="dh-quality">还没有口播记录。完成第一次制作后，会自动保存在这里。</p>}<div>{tasks.map((item) => <button key={item.id} data-task-id={item.id} disabled={!!busy} onClick={() => { selectTask(item); if (history.current) history.current.open = false; root.current?.scrollIntoView({ block: 'start' }); }} className={task?.id === item.id ? 'is-selected' : ''}><span><strong>{item.title}</strong><small>{item.referenceName} · {new Date(item.updatedAt).toLocaleString('zh-CN')}</small></span><span>{item.statusLabel}</span></button>)}</div></details>
  </div>;
}

function NarrationWaiting({ title, detail, poster }: { title: string; detail: string; poster?: string }) {
  return <div className="rh-waiting" role="status" aria-live="polite"><div className="rh-waiting-visual" aria-hidden="true">{poster ? <img src={poster} alt="" /> : <Video size={56} />}<div className="rh-waiting-wave">{Array.from({ length: 7 }, (_, i) => <i key={i} style={{ animationDelay: `${i * .12}s` }} />)}</div></div><h3>{title}</h3><p>{detail}</p></div>;
}
