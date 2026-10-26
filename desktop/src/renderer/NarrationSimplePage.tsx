import { useEffect, useMemo, useRef, useState } from 'react';
import type { DigitalHumanApi, DigitalHumanResult, DigitalHumanTask } from './digital-human-types';
import type { ReferenceAsset, ReferenceHumanApi, ReferenceTask, ViralJob, ViralLibrary, ViralLibraryItem, ViralLibraryScript } from './reference-human-types';
import { FlowFunnel } from './FlowFunnel';
import { tagText } from './flow-funnel';
import { likesText } from './viral-pipeline';
import { barText, libraryHeadline, libraryStages, libraryUsage, longestScriptSeconds, orderByUsage, SCRIPT_SECONDS, type ScriptSeconds } from './narration-simple';
import referencePolicy from '../shared/reference-human.json';
import './NarrationSimplePage.css';

// 数字人视频（极简版）：第一页看爆款文案库，选一条爆款、选时长，点「仿写」拿到自己的原创稿；第二页上传本人视频，一键出片。
// 原文案只在云端；每次仿写用一次套餐写稿额度。字幕模板、配乐、封面、报价、试听都在后台按默认自动完成，不在页面出现。
const api = () => (window as unknown as { xiaoxiDigitalHuman: { reference: ReferenceHumanApi } }).xiaoxiDigitalHuman.reference;
const imageApi = () => (window as unknown as { xiaoxiDigitalHuman: DigitalHumanApi }).xiaoxiDigitalHuman;
export type PendingKind = 'reference' | 'image';
// 结果待核对或需要处理的旧任务：不自动重新购买，要让客户能找到并自己决定。
const STUCK = new Set(['needs_attention', 'outcome_unknown']);
async function unwrap<T>(result: Promise<DigitalHumanResult<T>>): Promise<T> {
  const value = await result; if (!value.ok || value.data === undefined) throw new Error(value.error || '操作未完成，请稍后重试。'); return value.data;
}
const MAX_CNY = 6;
const DEVELOPMENT_EDITION = import.meta.env.VITE_XIAOXI_EDITION === 'development';

// 一张爆款卡片：先显示爆款标题和真实数据；仿写好之后，下面接着显示客户自己的原创稿。
type Draft = ViralLibraryScript & { seconds: ScriptSeconds; problems: string[] };
function ScriptCard({ item, draft, made, writing, selected, onSelect }: { item: ViralLibraryItem; draft?: Draft; made: number; writing: boolean; selected: boolean; onSelect: () => void }) {
  const tag = item.source.tags.find((t) => t.id !== 'high_likes');
  return (
    <button type="button" className={`ns-card${selected ? ' is-on' : ''}`} aria-pressed={selected} onClick={onSelect}>
      <i className="ns-pick" aria-hidden="true" />
      <span className="ns-src"><span className={`ns-pf is-${item.platform}`}>{item.platform === 'xiaohongshu' ? '红' : '抖'}</span>
        原{item.platform === 'xiaohongshu' ? '笔记' : '视频'} {item.source.likes !== null && <b>{likesText(item.source.likes)} 赞</b>}{tag && <> · {tagText(tag)}</>}{made > 0 && <span className="ns-made">已出片 {made} 次</span>}</span>
      <span className="ns-title">{item.title}</span>
      {draft ? <span className="ns-draft"><span className="ns-draft-k">你的原创稿 · 约 {draft.seconds} 秒</span><b>{draft.title}</b><span className="ns-text">{draft.script}</span>
        {draft.problems.length > 0 && <span className="ns-warn">{draft.problems.join('；')}</span>}</span>
        : writing ? <span className="ns-draft is-writing">{draft ? '正在按这条爆款的结构换一篇' : '正在仿写'}，大约 20～40 秒…</span> : null}
    </button>
  );
}

export function NarrationSimplePage({ onOpenPending }: { onOpenPending?: (kind: PendingKind) => void } = {}) {
  const [page, setPage] = useState<'pick' | 'upload'>('pick');
  const [library, setLibrary] = useState<ViralLibrary | null>(null), [libraryError, setLibraryError] = useState('');
  const [person, setPerson] = useState<ReferenceAsset | null | undefined>(undefined);
  const [selected, setSelected] = useState(''), [jobs, setJobs] = useState<ViralJob[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({}), [want, setWant] = useState<ScriptSeconds>(45);
  const [titles, setTitles] = useState<Record<string, string[]>>({});
  const [quotaLeft, setQuotaLeft] = useState<number | null>(null), [business, setBusiness] = useState('');
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [cover, setCover] = useState('');
  const [stuck, setStuck] = useState<{ reference: ReferenceTask[]; image: DigitalHumanTask[] }>({ reference: [], image: [] });
  const lastJob = useRef('');
  const root = useRef<HTMLDivElement>(null);
  const [libraryTry, setLibraryTry] = useState(0);
  // 文案库来自云端；云端读不到时主进程会给本地缓存或安装包自带的一份，只有安装损坏才会读不到。
  useEffect(() => {
    let active = true;
    setLibraryError('');
    void unwrap(api().viralLibrary()).then((data) => { if (!active) return; setLibrary(data); setSelected((current) => current || data.items[0]?.id || ''); })
      .catch((reason) => { if (active) setLibraryError((reason as Error).message || '未知原因'); });
    return () => { active = false; };
  }, [libraryTry]);
  // 流图铺满整行，高度跟着宽度放大（宽屏更舒展），限制在 300～480。
  const flowBox = useRef<HTMLDivElement>(null), [flowHeight, setFlowHeight] = useState(340);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([unwrap(api().workspace()), unwrap(api().assets())]).then(([saved, people]) => {
      if (!active) return;
      const items = people.status === 'fulfilled' ? people.value.items : [];
      const preferred = saved.status === 'fulfilled' ? saved.value.preferences?.referenceAssetId : undefined;
      if (saved.status === 'fulfilled') setBusiness(saved.value.draft?.business || '');
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
  const draft = pick ? drafts[pick.id] : undefined;
  const flow = useMemo(() => library ? { strands: library.strands, stages: libraryStages(library.stats) } : null, [library]);
  const headline = library ? libraryHeadline(library.stats) : null;
  const made = useMemo(() => libraryUsage(jobs), [jobs]);
  const items = useMemo(() => library ? orderByUsage(library.items, made) : [], [library, made]);
  // 时长不能超过本人视频（留 3 秒）；视频变短时，选中的时长自动退到能用的最长一档。
  const longest = longestScriptSeconds(ready ? person!.seconds : undefined);
  const tooLong = Boolean(draft && draft.seconds > longest);
  useEffect(() => { if (want > longest) { const fit = [...SCRIPT_SECONDS].reverse().find((s) => s <= longest); if (fit) setWant(fit); } }, [longest, want]);

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
  // 仿写：每点一次是一次新的写稿（用一次套餐额度）；写好的稿子记在这张卡片上，换卡片再回来还在。
  // 已经写过的卡片再点就是「换一篇」：按这条爆款拆好的结构另写一篇，避开这张卡片上写过的标题。
  const write = () => act(`write:${pick?.id}`, async () => {
    if (!pick) return;
    const item = pick, seconds = want, written = titles[item.id] || [];
    const result = await unwrap(api().writeScript({ referenceAssetId: ready ? person!.id : '', industry: '清洁设备渠道商', business,
      libraryId: item.id, targetSeconds: seconds, generationIntentId: crypto.randomUUID(), ...(written.length ? { mode: 'structure' as const, avoidTitles: written.slice(-10) } : {}) }));
    setTitles((all) => ({ ...all, [item.id]: [...(all[item.id] || []), result.title].slice(-10) }));
    setDrafts((all) => ({ ...all, [item.id]: { id: item.id, platform: item.platform, title: result.title, script: result.script, emphasisPhrases: result.emphasisPhrases, seconds, problems: result.problems || [] } }));
    if (typeof result.quota?.remaining === 'number') setQuotaLeft(result.quota.remaining);
  });
  // 开发版：把不适合口播的爆款从云端文案库删掉（以后重新发布也不会再加回来），删完重新读取。
  const removeFromLibrary = () => act('remove', async () => {
    if (!pick || !window.confirm(`从云端文案库删除「${pick.title}」？
所有客户都会看不到这条，以后重新发布也不会再加回来。`)) return;
    await unwrap(api().viralLibraryRemove({ ids: [pick.id] }));
    setSelected(''); setLibraryTry((n) => n + 1);
  });
  const go = () => act('go', async () => {
    if (!draft || !person) return;
    const { seconds: _seconds, problems: _problems, ...libraryItem } = draft;
    const job = await unwrap(api().viralStartScript({ libraryItem, assetId: person.id, maxCny: MAX_CNY }));
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
          <div className="ns-kicker">爆款文案库{library.preview && <span className="ns-preview">预览数据，仅开发版可见</span>}{DEVELOPMENT_EDITION && library.offline && <span className="ns-preview">开发版可见：云端没读到，用的是本地兜底</span>}</div>
          <h1 className="ns-h1">{headline!.lead}<br />挑出 <em>{headline!.ready}</em>，选一条就能仿写成你的原创稿。</h1>
          <div className="ns-flow" ref={flowBox}><FlowFunnel strands={flow.strands} stages={flow.stages} height={flowHeight} ambient showOutput outputLabel="爆款文案库" outputNote="选一条，按你要的时长仿写" emptyText=""
            caption="示意图：每条线是一条扒到的口播；搬运和重复的合成一束；经过「够爆」的闸门，只有真爆款的几束通过，汇进爆款文案库。鼠标移上去可以看每条线是什么。" /></div>
          <div className="ns-sec"><b>选一条爆款</b><span>按爆款热度排序 · 点「仿写」后只学它的结构和节奏，内容换成清洁设备</span></div>
          <div className="ns-list">{items.map((item) => <ScriptCard key={item.id} item={item} draft={drafts[item.id]} made={made[item.id] || 0} writing={busy === `write:${item.id}`} selected={item.id === selected} onSelect={() => setSelected(item.id)} />)}</div>
        </> : libraryError ? <div className="ns-wait is-pending">
          <b>爆款文案库没有读到</b>
          <span>软件里自带的文案库可能损坏了，请重新加载；还不行就重新安装软件。</span>
          <button type="button" className="ns-go is-quiet" onClick={() => setLibraryTry((n) => n + 1)}>重新加载</button>
          {DEVELOPMENT_EDITION && <small>开发版可见：{libraryError}</small>}
        </div> : <div className="ns-skeleton" aria-busy="true" aria-label="正在读取爆款文案库"><i /><i /><i className="is-flow" /></div>}
        {stuckCount > 0 && onOpenPending && <button type="button" className="ns-pending" onClick={() => onOpenPending(stuckReference.length ? 'reference' : 'image')}>
          之前有 {stuckCount} 条视频需要你处理，已有结果都保留着，不会自动重新扣费<b>去处理 →</b></button>}
        <div className="ns-bar"><div className="ns-bar-in">
          <div className="ns-sel">{draft ? `已仿写：${draft.title}` : pick ? pick.title : '选一条爆款'}
            <small>{!pick ? '选好后挑时长，点「仿写」生成你的原创稿' : draft ? '想要另一篇就点「换一篇」：按这条爆款的结构写一篇全新的，再用 1 次写稿额度 · 满意就下一步出片'
              : `点「仿写」生成你的原创稿，用 1 次写稿额度${quotaLeft !== null ? `（本期还剩 ${quotaLeft} 次）` : ''}`}</small></div>
          {pick && <div className="ns-dur" role="group" aria-label="稿子时长">{SCRIPT_SECONDS.map((s) => (
            <button type="button" key={s} className={s === want ? 'is-on' : ''} aria-pressed={s === want} disabled={s > longest || !!busy}
              title={s > longest ? `你的视频只有 ${longest} 秒，想要 ${s} 秒请换一段更长的视频` : ''} onClick={() => setWant(s)}>{s} 秒</button>))}</div>}
          {pick && <button type="button" className={`ns-go${draft ? ' is-quiet' : ''}`} data-xiaoxi-digital-human-action="reference-write-script" disabled={!!busy || want > longest}
            onClick={() => void write()}>{busy.startsWith('write:') ? (draft ? '正在换…' : '正在仿写…') : draft ? '换一篇' : '仿写'}</button>}
          {DEVELOPMENT_EDITION && pick && !library?.preview && !library?.offline && <button type="button" className="ns-go is-quiet" disabled={!!busy} onClick={() => void removeFromLibrary()}>从文案库删除</button>}
          {draft && <button type="button" className="ns-go" disabled={!!busy} onClick={() => setPage('upload')}>下一步</button>}
        </div>{error && <p className="ns-error" role="alert">{error}</p>}</div>
      </> : <>
        <button type="button" className="ns-back" disabled={working} onClick={() => setPage('pick')}>← 换一条爆款</button>
        <h1 className="ns-h1 is-small">上传本人视频</h1>
        <p className="ns-lead">正面出镜、清晰讲话 15 秒以上。声音自动用你本人的，以后不用再传。</p>
        {draft && <div className="ns-chosen"><span>你的原创稿 · 约 {draft.seconds} 秒</span><b>{draft.title}</b><p>{draft.script}</p></div>}
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
            <div className={`ns-sel${tooLong ? ' is-failed' : ''}`}>{draft ? draft.title : '先选一条爆款并仿写'}
              <small>{tooLong ? `这条稿子约 ${draft!.seconds} 秒，你的视频只有 ${longest} 秒。请回去选短一点的时长重写，或换一段更长的视频。`
                : `${draft ? `约 ${draft.seconds} 秒 · ` : ''}本人出镜、本人声音 · 字幕、配乐、封面自动完成`}</small></div>
            <button type="button" className="ns-go" data-xiaoxi-digital-human-action="reference-viral-pipeline-start-script" disabled={!draft || tooLong || !ready || !consented || !!busy} onClick={() => void go()}>{busy === 'go' ? '正在开始…' : '一键出片'}</button>
          </>}
        </div>{error && <p className="ns-error" role="alert">{error}</p>}</div>
      </>}
    </div>
  );
}
