import { useEffect, useMemo, useRef, useState } from 'react';
import type { DigitalHumanApi, DigitalHumanResult, DigitalHumanTask } from './digital-human-types';
import type { ReferenceAsset, ReferenceHumanApi, ReferenceTask, ViralJob, ViralLibrary, ViralLibraryItem } from './reference-human-types';
import { FlowFunnel } from './FlowFunnel';
import { tagText } from './flow-funnel';
import { likesText } from './viral-pipeline';
import { barText, dayWord, formatCount, libraryStages, updatedText } from './narration-simple';
import referencePolicy from '../shared/reference-human.json';
import './NarrationSimplePage.css';

// 数字人视频（极简版）：第一页看爆款文案库、选一条文案；第二页上传本人视频，一键出片。
// 字幕模板、配乐、封面、报价、试听都在后台按默认自动完成，不在页面出现。
const api = () => (window as unknown as { xiaoxiDigitalHuman: { reference: ReferenceHumanApi } }).xiaoxiDigitalHuman.reference;
const imageApi = () => (window as unknown as { xiaoxiDigitalHuman: DigitalHumanApi }).xiaoxiDigitalHuman;
export type PendingKind = 'reference' | 'image';
// 结果待核对或需要处理的旧任务：不自动重新购买，要让客户能找到并自己决定。
const STUCK = new Set(['needs_attention', 'outcome_unknown']);
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

export function NarrationSimplePage({ onOpenPending }: { onOpenPending?: (kind: PendingKind) => void } = {}) {
  const [page, setPage] = useState<'pick' | 'upload'>('pick');
  const [library, setLibrary] = useState<ViralLibrary | null>(null), [libraryError, setLibraryError] = useState('');
  const [person, setPerson] = useState<ReferenceAsset | null | undefined>(undefined);
  const [selected, setSelected] = useState(''), [jobs, setJobs] = useState<ViralJob[]>([]);
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [cover, setCover] = useState('');
  const [stuck, setStuck] = useState<{ reference: ReferenceTask[]; image: DigitalHumanTask[] }>({ reference: [], image: [] });
  const lastJob = useRef('');
  const root = useRef<HTMLDivElement>(null);
  // 流图铺满整行，高度跟着宽度放大（宽屏更舒展），限制在 300～480。
  const flowBox = useRef<HTMLDivElement>(null), [flowHeight, setFlowHeight] = useState(340);

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
    void Promise.allSettled([unwrap(api().list()), unwrap(imageApi().list())]).then(([references, images]) => {
      if (active) setStuck({ reference: references.status === 'fulfilled' ? references.value.items.filter((t) => STUCK.has(t.status)) : [], image: images.status === 'fulfilled' ? images.value.items.filter((t) => STUCK.has(t.status)) : [] });
    });
    const off = api().onViralPipeline((state) => setJobs(state.items.filter((j) => j.mode === 'script')));
    void unwrap(api().viralPipelineList()).then((state) => { if (active) setJobs(state.items.filter((j) => j.mode === 'script')); }).catch(() => {});
    return () => { active = false; off(); };
  }, []);
  useEffect(() => { root.current?.scrollIntoView({ block: 'start' }); }, [page]);
  useEffect(() => {
    const box = flowBox.current;
    if (!box) return;
    const fit = () => setFlowHeight(Math.round(Math.max(300, Math.min(480, box.clientWidth * 0.3))));
    const observer = new ResizeObserver(fit); observer.observe(box); fit();
    return () => observer.disconnect();
  }, [page, Boolean(library)]);

  const current = jobs.find((j) => ['running', 'queued'].includes(j.status)) || jobs.find((j) => j.id === lastJob.current) || undefined;
  const status = barText(current);
  useEffect(() => {
    setCover('');
    if (current?.status === 'done' && current.coverReady) void unwrap(api().viralPipelineCover({ id: current.id })).then((r) => setCover(r.dataUrl)).catch(() => {});
  }, [current?.id, current?.status, current?.coverReady]);

  const ready = Boolean(person && person.available !== false && person.voiceSampleReady && person.seconds >= referencePolicy.limits.narrationMinSeconds);
  const consented = Boolean(person?.voiceConsented);
  const pick = library?.items.find((i) => i.id === selected);
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
  const working = status?.tone === 'busy';
  // 一键出片自己的任务在底部栏里处理，这里只数其他旧任务。
  const stuckReference = stuck.reference.filter((t) => !jobs.some((j) => j.taskId === t.id));
  const stuckCount = stuckReference.length + stuck.image.length;

  return (
    <div className="ns-page" ref={root}>
      {page === 'pick' ? <>
        {library && flow ? <>
          <div className="ns-kicker">爆款文案库{updatedText(library.updatedAt) && <span className="ns-live"><i />{updatedText(library.updatedAt)}</span>}{library.preview && <span className="ns-preview">预览数据，仅开发版可见</span>}</div>
          <h1 className="ns-h1">{dayWord(library.updatedAt)}全网扒了 {formatCount(library.stats.collected)} 条清洁行业口播，<br />挑出 <em>{library.stats.ready} 条爆款</em>，已经改写成你的原创稿。</h1>
          <div className="ns-flow" ref={flowBox}><FlowFunnel strands={flow.strands} stages={flow.stages} height={flowHeight} ambient showOutput outputLabel="爆款文案库" outputNote="已改写成原创稿，可以直接出片" emptyText=""
            caption="示意图：每条线是一条扒到的口播；搬运和重复的合成一束；经过「够爆」的闸门，只有真爆款的几束通过，汇进爆款文案库。鼠标移上去可以看每条线是什么。" /></div>
          <div className="ns-sec"><b>选一条文案</b><span>按爆款热度排序 · 内容已换成清洁设备，只学它的结构和节奏</span></div>
          <div className="ns-list">{library.items.map((item) => <ScriptCard key={item.id} item={item} selected={item.id === selected} onSelect={() => setSelected(item.id)} />)}</div>
        </> : <div className="ns-wait">{libraryError || '正在读取爆款文案库…'}</div>}
        {stuckCount > 0 && onOpenPending && <button type="button" className="ns-pending" onClick={() => onOpenPending(stuckReference.length ? 'reference' : 'image')}>
          之前有 {stuckCount} 条视频需要你处理，已有结果都保留着，不会自动重新扣费<b>去处理 →</b></button>}
        <div className="ns-bar"><div className="ns-bar-in">
          <div className="ns-sel">{pick ? `已选：${pick.title}` : '选一条文案'}<small>下一步上传本人视频，用你本人的形象和声音出片</small></div>
          <button type="button" className="ns-go" disabled={!pick} onClick={() => setPage('upload')}>下一步</button>
        </div></div>
      </> : <>
        <button type="button" className="ns-back" disabled={working} onClick={() => setPage('pick')}>← 换一条文案</button>
        <h1 className="ns-h1 is-small">上传本人视频</h1>
        <p className="ns-lead">正面出镜、清晰讲话 15 秒以上。声音自动用你本人的，以后不用再传。</p>
        {pick && <div className="ns-chosen"><span>这条文案</span><b>{pick.title}</b><p>{pick.script}</p></div>}
        <div className="ns-person">
          {person?.previewDataUrl ? <img src={person.previewDataUrl} alt="" /> : <i className="ns-ph" aria-hidden="true" />}
          <div className="ns-person-text">
            {ready ? <><b>{person!.name}</b><span>{Math.round(person!.seconds)} 秒 · 本人声音已就绪</span></>
              : <><b>{person ? '这段视频不够用' : '还没有上传视频'}</b><span>{person ? '需要正面出镜、清晰讲话 15 秒以上，请换一段' : '支持 mp4、mov，建议 30—60 秒'}</span></>}
            {ready && !consented && <label className="ns-consent" data-xiaoxi-digital-human-action="reference-confirm-consent">
              <input type="checkbox" disabled={!!busy} onChange={(event) => { if (event.target.checked) void consent(); }} />视频和声音是我本人的</label>}
            {ready && consented && <span className="ns-ok">✓ 已确认是本人</span>}
          </div>
          <button type="button" className={`ns-upload${ready ? ' is-quiet' : ''}`} disabled={!!busy || working || person === undefined} onClick={() => void upload()}>{busy === 'upload' ? '正在处理视频…' : ready ? '换一段' : '选择视频'}</button>
        </div>
        <div className="ns-bar"><div className="ns-bar-in">
          {status && current ? <>
            {cover && <img className="ns-cover" src={cover} alt="封面" />}
            <div className={`ns-sel is-${status.tone}`}>{current.script?.title || current.title}<small>{status.text}</small>
              {working && <i className="ns-progress"><i style={{ width: `${status.progress}%` }} /></i>}</div>
            {status.tone === 'failed' && current.retryable && <button type="button" className="ns-go is-quiet" data-xiaoxi-digital-human-action="reference-viral-pipeline-retry" disabled={!!busy} onClick={() => void retry()}>重试</button>}
            {!working && <button type="button" className="ns-go" onClick={() => { lastJob.current = ''; setPage('pick'); }}>再出一条</button>}
          </> : <>
            <div className="ns-sel">{pick ? pick.title : '先选一条文案'}<small>{seconds ? `约 ${Math.round(seconds)} 秒 · ` : ''}本人出镜、本人声音 · 字幕、配乐、封面自动完成</small></div>
            <button type="button" className="ns-go" data-xiaoxi-digital-human-action="reference-viral-pipeline-start-script" disabled={!pick || !ready || !consented || !!busy} onClick={() => void go()}>{busy === 'go' ? '正在开始…' : '一键出片'}</button>
          </>}
        </div>{error && <p className="ns-error" role="alert">{error}</p>}</div>
      </>}
    </div>
  );
}
