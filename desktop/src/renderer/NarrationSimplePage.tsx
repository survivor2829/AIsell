import { useEffect, useMemo, useRef, useState } from 'react';
import type { DigitalHumanResult } from './digital-human-types';
import type { ReferenceAsset, ReferenceHumanApi, ViralJob, ViralLibrary, ViralLibraryItem } from './reference-human-types';
import { FlowFunnel } from './FlowFunnel';
import { tagText } from './flow-funnel';
import { likesText } from './viral-pipeline';
import { barText, dayWord, formatCount, libraryStages, updatedText } from './narration-simple';
import referencePolicy from '../shared/reference-human.json';
import './NarrationSimplePage.css';

// 数字人视频（极简版）：客户只做三件事——上传本人视频、选一条文案、一键出片。
// 字幕模板、配乐、封面、报价、试听都在后台按默认自动完成，不在页面出现。
const api = () => (window as unknown as { xiaoxiDigitalHuman: { reference: ReferenceHumanApi } }).xiaoxiDigitalHuman.reference;
async function unwrap<T>(result: Promise<DigitalHumanResult<T>>): Promise<T> {
  const value = await result; if (!value.ok || value.data === undefined) throw new Error(value.error || '操作未完成，请稍后重试。'); return value.data;
}
const MAX_CNY = 6;

function ScriptCard({ item, selected, onSelect }: { item: ViralLibraryItem; selected: boolean; onSelect: () => void }) {
  const tag = item.source.tags.find((t) => t.id !== 'high_likes');
  return (
    <button type="button" className={`ns-card${selected ? ' is-on' : ''}`} aria-pressed={selected} onClick={onSelect}>
      <i className="ns-pick" aria-hidden="true" />
      <span className="ns-src"><span className={`ns-pf is-${item.platform}`}>{item.platform === 'xiaohongshu' ? '红' : '抖'}</span>
        原{item.platform === 'xiaohongshu' ? '笔记' : '视频'} {item.source.likes !== null && <b>{likesText(item.source.likes)} 赞</b>}{tag && <> · {tagText(tag)}</>}</span>
      <span className="ns-title">{item.title}</span>
      <span className="ns-text">{item.script}</span>
    </button>
  );
}

export function NarrationSimplePage() {
  const [library, setLibrary] = useState<ViralLibrary | null>(null), [libraryError, setLibraryError] = useState('');
  const [person, setPerson] = useState<ReferenceAsset | null | undefined>(undefined);
  const [selected, setSelected] = useState(''), [jobs, setJobs] = useState<ViralJob[]>([]);
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [cover, setCover] = useState('');
  const lastJob = useRef('');

  useEffect(() => {
    let active = true;
    void unwrap(api().viralLibrary()).then((data) => { if (!active) return; setLibrary(data); setSelected((current) => current || data.items[0]?.id || ''); })
      .catch((reason) => { if (active) setLibraryError((reason as Error).message); });
    void Promise.allSettled([unwrap(api().workspace()), unwrap(api().assets())]).then(([saved, people]) => {
      if (!active) return;
      const items = people.status === 'fulfilled' ? people.value.items : [];
      const preferred = saved.status === 'fulfilled' ? saved.value.preferences?.referenceAssetId : undefined;
      setPerson(items.find((a) => a.id === preferred) || items[0] || null);
    });
    const off = api().onViralPipeline((state) => setJobs(state.items.filter((j) => j.mode === 'script')));
    void unwrap(api().viralPipelineList()).then((state) => { if (active) setJobs(state.items.filter((j) => j.mode === 'script')); }).catch(() => {});
    return () => { active = false; off(); };
  }, []);

  const current = jobs.find((j) => ['running', 'queued'].includes(j.status)) || jobs.find((j) => j.id === lastJob.current) || undefined;
  const status = barText(current);
  useEffect(() => {
    setCover('');
    if (current?.status === 'done' && current.coverReady) void unwrap(api().viralPipelineCover({ id: current.id })).then((r) => setCover(r.dataUrl)).catch(() => {});
  }, [current?.id, current?.status, current?.coverReady]);

  const ready = Boolean(person && person.available !== false && person.voiceSampleReady && person.seconds >= referencePolicy.limits.narrationMinSeconds);
  const consented = Boolean(person?.voiceConsented);
  const pick = library?.items.find((i) => i.id === selected);
  const step = !ready || !consented ? 1 : status?.tone === 'busy' ? 3 : 2;
  const flow = useMemo(() => library ? { strands: library.strands, stages: libraryStages(library.stats) } : null, [library]);
  const seconds = person?.narrationPlan?.maximumSeconds;

  async function act(name: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(name); setError('');
    try { await work(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(''); }
  }
  const upload = () => act('upload', async () => {
    const asset = await unwrap(api().importVideo());
    if (!asset) return;
    setPerson(asset);
    // 记住这位出镜人物，下次打开直接用。
    const saved = await unwrap(api().workspace());
    await unwrap(api().saveWorkspace({ ...saved, preferences: { ...saved.preferences, referenceAssetId: asset.id } }));
  });
  const consent = () => act('consent', async () => { if (person) setPerson(await unwrap(api().confirmConsent({ assetId: person.id }))); });
  const go = () => act('go', async () => {
    if (!pick || !person) return;
    const job = await unwrap(api().viralStartScript({ libraryItem: pick, assetId: person.id, maxCny: MAX_CNY }));
    lastJob.current = job.id;
  });
  const retry = () => act('retry', async () => { if (current) await unwrap(api().viralPipelineRetry({ id: current.id })); });

  return (
    <div className="ns-page">
      {library && flow ? <>
        <div className="ns-kicker">爆款文案库{updatedText(library.updatedAt) && <span className="ns-live"><i />{updatedText(library.updatedAt)}</span>}</div>
        <h1 className="ns-h1">{dayWord(library.updatedAt)}全网扒了 {formatCount(library.stats.collected)} 条清洁行业口播，<br />挑出 <em>{library.stats.ready} 条爆款</em>，已经改写成你的原创稿。</h1>
        <div className="ns-flow"><FlowFunnel strands={flow.strands} stages={flow.stages} height={250} outputLabel="爆款文案库" outputNote="已改写成原创稿，可以直接出片" emptyText="" /></div>
      </> : <div className="ns-wait">{libraryError || '正在读取爆款文案库…'}</div>}

      <div className="ns-steps">
        <div className={`ns-step${ready && consented ? ' is-done' : step === 1 ? ' is-on' : ''}`}>
          <span className="ns-num">{ready && consented ? '✓' : 1}</span>
          <div>
            {ready ? <>
              <b>本人视频已上传</b>
              <span>{person!.name} · {Math.round(person!.seconds)} 秒 · 本人声音 · <button type="button" className="ns-link" disabled={!!busy} onClick={() => void upload()}>换一段</button></span>
              {!consented && <label className="ns-consent" data-xiaoxi-digital-human-action="reference-confirm-consent">
                <input type="checkbox" disabled={!!busy} onChange={(event) => { if (event.target.checked) void consent(); }} />视频和声音是我本人的</label>}
            </> : <>
              <b>上传本人视频</b>
              <span>正面口播 15 秒以上，声音自动用你本人的</span>
              <button type="button" className="ns-upload" disabled={!!busy || person === undefined} onClick={() => void upload()}>{busy === 'upload' ? '正在处理视频…' : '选择视频'}</button>
              {person && !ready && <span className="ns-warn">这段视频不够用：需要正面出镜、清晰讲话 15 秒以上</span>}
            </>}
          </div>
        </div>
        <div className={`ns-step${step === 2 ? ' is-on' : step === 3 ? ' is-done' : ''}`}><span className="ns-num">{step === 3 ? '✓' : 2}</span><div><b>选一条文案</b><span>每条都来自一条真实爆款</span></div></div>
        <div className={`ns-step${step === 3 ? ' is-on' : ''}`}><span className="ns-num">3</span><div><b>一键出片</b><span>约 3 分钟，进成片中心</span></div></div>
      </div>

      {library && <>
        <div className="ns-sec"><b>选一条文案</b><span>按爆款热度排序 · 内容已换成清洁设备，只学它的结构和节奏</span></div>
        <div className="ns-list">{library.items.map((item) => <ScriptCard key={item.id} item={item} selected={item.id === selected} onSelect={() => setSelected(item.id)} />)}</div>
      </>}

      <div className="ns-bar">
        <div className="ns-bar-in">
          {status && current ? <>
            {cover && <img className="ns-cover" src={cover} alt="封面" />}
            <div className={`ns-sel is-${status.tone}`}>{current.script?.title || current.title}<small>{status.text}</small>
              {status.tone === 'busy' && <i className="ns-progress"><i style={{ width: `${status.progress}%` }} /></i>}</div>
            {status.tone === 'failed' && current.retryable && <button type="button" className="ns-go is-quiet" data-xiaoxi-digital-human-action="reference-viral-pipeline-retry" disabled={!!busy} onClick={() => void retry()}>重试</button>}
            {status.tone !== 'busy' && <button type="button" className="ns-go" data-xiaoxi-digital-human-action="reference-viral-pipeline-start-script" disabled={!pick || !ready || !consented || !!busy} onClick={() => void go()}>再出一条</button>}
          </> : <>
            <div className="ns-sel">{pick ? `已选：${pick.title}` : '选一条文案'}<small>{seconds ? `约 ${Math.round(seconds)} 秒 · ` : ''}本人出镜、本人声音 · 字幕、配乐、封面自动完成</small></div>
            <button type="button" className="ns-go" data-xiaoxi-digital-human-action="reference-viral-pipeline-start-script" disabled={!pick || !ready || !consented || !!busy} onClick={() => void go()}>{busy === 'go' ? '正在开始…' : '一键出片'}</button>
          </>}
        </div>
        {error && <p className="ns-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
