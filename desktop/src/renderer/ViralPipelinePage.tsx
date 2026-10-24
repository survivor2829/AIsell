import { useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Pause, Search } from 'lucide-react';
import type { DigitalHumanResult } from './digital-human-types';
import type { NarrationReference, ReferenceAsset, ReferenceHumanApi, ViralItem, ViralJob, ViralScanResult } from './reference-human-types';
import { ViralQueue } from './ViralQueue';
import { FlowFunnel } from './FlowFunnel';
import { platformName, tagText, viralFlow } from './flow-funnel';
import { applyProgress, dateText, EMPTY_SCAN, estimateCny, likesText, resultSummary, safeLink, TOP_COUNT, viralReference, type ScanState } from './viral-pipeline';
import presets from '../shared/viral-industry-presets.json';
import referencePolicy from '../shared/reference-human.json';
import './ViralPipelinePage.css';

const referenceApi = () => (window as unknown as { xiaoxiDigitalHuman: { reference: ReferenceHumanApi } }).xiaoxiDigitalHuman.reference;
async function unwrap<T>(result: Promise<DigitalHumanResult<T>>): Promise<T> {
  const value = await result; if (!value.ok || value.data === undefined) throw new Error(value.error || '操作未完成，请稍后重试。'); return value.data;
}
const PLATFORMS = [{ id: 'douyin', name: '抖音' }, { id: 'xiaohongshu', name: '小红书' }];
const TAG_CLASS: Record<string, string> = { high_likes: 'is-likes', underdog: 'is-underdog', asking_price: 'is-asking' };

function ViralCard({ item, onImitate, onOneClick, oneClickBlocked, estimate, queued }: { item: ViralItem; onImitate: () => void; onOneClick: () => void; oneClickBlocked: string; estimate: string; queued: boolean }) {
  const link = safeLink(item.url);
  return (
    <article className="vp-card">
      <div className="vp-card-meta"><span className={`vp-platform is-${item.platform}`}>{item.platform === 'xiaohongshu' ? '红' : '抖'}</span>{item.author.name || '作者未知'} · {dateText(item.publishedAt)}</div>
      <h3>{item.title || '（没有标题）'}</h3>
      <div className="vp-likes">{likesText(item.metrics.likes)}{item.metrics.likes !== null && <small>赞</small>}</div>
      <div className="vp-tags">{item.tags.map((tag) => <span key={tag.id} className={`vp-tag ${TAG_CLASS[tag.id] || ''}`}>{tagText(tag)}</span>)}</div>
      <div className="vp-card-actions">
        {link && <a className="dh-button" href={link} target="_blank" rel="noreferrer">原文</a>}
        <button type="button" className="dh-button" onClick={onImitate}>只仿写</button>
        <button type="button" className="dh-button is-primary" data-xiaoxi-digital-human-action="reference-viral-pipeline-start" disabled={Boolean(oneClickBlocked) || queued}
          title={oneClickBlocked || undefined} onClick={onOneClick}>{queued ? '已在队列' : '一键成片'}</button>
      </div>
      <span className="vp-card-note">{oneClickBlocked || `一键成片预计约 ${estimate}；只仿写使用 1 次写稿额度`}</span>
    </article>
  );
}

export function ViralPipelinePage({ onImitate, onManagePerson }: { onImitate: (reference: NarrationReference) => void; onManagePerson: () => void }) {
  const [industries, setIndustries] = useState<string[]>(['cleaning', 'property', 'factory']);
  const [platforms, setPlatforms] = useState<string[]>(['douyin', 'xiaohongshu']);
  const [days, setDays] = useState<30 | 90>(30);
  const [scanning, setScanning] = useState(false), [stopping, setStopping] = useState(false);
  const [scan, setScan] = useState<ScanState>(EMPTY_SCAN);
  const [result, setResult] = useState<ViralScanResult | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [person, setPerson] = useState<ReferenceAsset | null | undefined>(undefined);
  const [jobs, setJobs] = useState<ViralJob[]>([]);
  const [maxCny, setMaxCny] = useState(6);
  const scanningRef = useRef(false);

  useEffect(() => referenceApi().onViralProgress((event) => { if (scanningRef.current) setScan((current) => applyProgress(current, event)); }), []);
  useEffect(() => {
    const off = referenceApi().onViralPipeline((state) => setJobs(state.items));
    void unwrap(referenceApi().viralPipelineList()).then((state) => setJobs(state.items)).catch(() => {});
    return off;
  }, []);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([unwrap(referenceApi().workspace()), unwrap(referenceApi().assets())]).then(([saved, people]) => {
      if (!active) return;
      const items = people.status === 'fulfilled' ? people.value.items : [];
      const preferred = saved.status === 'fulfilled' ? saved.value.preferences?.referenceAssetId : undefined;
      setPerson(items.find((item) => item.id === preferred) || items[0] || null);
    });
    return () => { active = false; };
  }, []);

  const flow = useMemo(() => viralFlow(scan.seen, result, TOP_COUNT), [scan.seen, result]);
  const top = result?.items.slice(0, TOP_COUNT) || [];
  const personReady = Boolean(person && person.available !== false && person.voiceSampleReady && person.seconds >= referencePolicy.limits.narrationMinSeconds);
  const blockedPlatforms = PLATFORMS.filter((p) => scan.blocked[p.id] || result?.platforms.some((r) => r.platform === p.id && r.status === 'blocked'));
  const estimate = estimateCny(person?.narrationPlan?.maximumSeconds);
  const oneClickBlocked = !personReady ? '先在「本人数字分身」里准备好出镜人物和声音' : '';
  const queuedIds = new Set(jobs.filter((j) => ['queued', 'running'].includes(j.status)).map((j) => j.itemId));
  async function oneClick(item: ViralItem) {
    setError('');
    try { await unwrap(referenceApi().viralPipelineStart({ item, maxCny })); setNotice(`已加入一键成片队列：${item.title.slice(0, 20)}`); }
    catch (reason) { setError((reason as Error).message); }
  }
  const toggle = (list: string[], id: string) => list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  async function start() {
    if (scanningRef.current) return;
    if (!industries.length || !platforms.length) { setError('请至少选择一个行业和一个平台。'); return; }
    scanningRef.current = true; setScanning(true); setStopping(false); setError(''); setNotice(''); setResult(null); setScan(EMPTY_SCAN);
    try { setResult(await unwrap(referenceApi().viralScan({ industryIds: industries, platforms, days }))); }
    catch (reason) { setError((reason as Error).message); }
    finally { scanningRef.current = false; setScanning(false); setStopping(false); }
  }
  async function stop() {
    setStopping(true);
    try { await unwrap(referenceApi().viralStop()); } catch (reason) { setError((reason as Error).message); setStopping(false); }
  }
  async function connect(platform: string) {
    try { await unwrap(referenceApi().sourceConnect({ platform })); setNotice(`已打开${platformName(platform)}登录窗口，登录或完成验证后重新开始扒取。`); }
    catch (reason) { setError((reason as Error).message); }
  }

  return (
    <div className="vp-page">
      <header className="vp-head">
        <div><h2>爆款一键成片</h2><p>在抖音、小红书找清洁圈正在被点赞的口播，仿结构、换成你自己的产品资料重写。</p></div>
      </header>
      {error && <p className="dh-message is-error" role="alert">{error}</p>}
      {notice && <p className="dh-message" role="status">{notice}</p>}
      <div className="vp-layout">
        <div className="vp-main">
          <section className="vp-panel vp-filters" aria-label="扒取方向">
            <div className="vp-filter-row"><b>行业</b>
              {presets.industries.map((item) => <button type="button" key={item.id} className="vp-chip" aria-pressed={industries.includes(item.id)} disabled={scanning} onClick={() => setIndustries(toggle(industries, item.id))}>{industries.includes(item.id) ? '✓ ' : ''}{item.name}</button>)}
            </div>
            <div className="vp-filter-row"><b>平台</b>
              {PLATFORMS.map((item) => <button type="button" key={item.id} className="vp-chip" aria-pressed={platforms.includes(item.id)} disabled={scanning} onClick={() => setPlatforms(toggle(platforms, item.id))}>{platforms.includes(item.id) ? '✓ ' : ''}{item.name}</button>)}
              <b className="vp-filter-gap">时间</b>
              {([30, 90] as const).map((value) => <button type="button" key={value} className="vp-chip" aria-pressed={days === value} disabled={scanning} onClick={() => setDays(value)}>近 {value} 天</button>)}
              <span className="vp-spacer" />
              {scanning ? <button type="button" className="dh-button" disabled={stopping} onClick={() => void stop()}><Pause size={16} />{stopping ? '正在暂停…' : '暂停'}</button>
                : <button type="button" className="dh-button is-primary" onClick={() => void start()}><Search size={16} />{result ? '重新扒一次' : '开始扒爆款'}</button>}
            </div>
            {blockedPlatforms.length > 0 && <div className="vp-filter-row vp-login">
              <span>{blockedPlatforms.map((p) => scan.blocked[p.id] || result?.platforms.find((r) => r.platform === p.id)?.message).filter(Boolean).join(' ')}</span>
              {blockedPlatforms.map((p) => <button type="button" key={p.id} className="dh-button" disabled={scanning} onClick={() => void connect(p.id)}>打开{p.name}登录</button>)}
            </div>}
          </section>

          <section className="vp-panel vp-flow" aria-label="扒取过程">
            <FlowFunnel strands={flow.strands} stages={flow.stages} live={scanning ? scan.message || '正在打开平台' : undefined}
              outputLabel="爆款清单" outputNote={`前 ${TOP_COUNT} 条进卡片，命中指标越多越靠前`}
              emptyText="选好行业和平台后点「开始扒爆款」，这里会实时画出每一条内容的去向。" />
          </section>

          {result && <div className="vp-list-head"><b>近 {result.days} 天，清洁圈谁在被点赞</b><span>{resultSummary(result)}。标签可以在原视频上核实；读不到的数据不显示。</span></div>}
          {result && !top.length && <p className="vp-empty">这一轮没有挑出爆款。可以多选几个行业，或改成近 90 天再扒一次。</p>}
          {top.length > 0 && <div className="vp-cards">{top.map((item) => <ViralCard key={item.id} item={item} onImitate={() => onImitate(viralReference(item, result!.finishedAt))}
            onOneClick={() => void oneClick(item)} oneClickBlocked={oneClickBlocked} estimate={estimate} queued={queuedIds.has(item.id)} />)}</div>}
        </div>

        <aside className="vp-side">
          <section className="vp-panel vp-side-block" aria-label="一键成片队列">
            <b>一键成片队列</b>
            <label className="vp-cap">每条最多花 <input type="number" min={1} max={50} step={1} value={maxCny} onChange={(event) => setMaxCny(Math.max(1, Math.min(50, Number(event.target.value) || 1)))} /> 元，报价超过就不开始</label>
            <ViralQueue api={referenceApi()} jobs={jobs} onError={setError} />
          </section>
          <section className="vp-panel vp-side-block" aria-label="出镜人物与声音">
            <b>出镜人物与声音</b>
            {person === undefined ? <p className="vp-muted"><LoaderCircle size={14} className="vp-spin" /> 正在读取…</p>
              : person ? <div className="vp-person">{person.previewDataUrl && <img src={person.previewDataUrl} alt="" />}<div><strong>{person.name}</strong>
                <span>{personReady ? '人物和声音都已就绪' : person.voiceSampleReady ? `人物视频需要至少 ${referencePolicy.limits.narrationMinSeconds} 秒` : '声音还没准备好'}</span></div></div>
              : <p className="vp-muted">还没有保存出镜人物。仿写之前，先在「本人数字分身」里上传一段正面口播视频。</p>}
            <button type="button" className="dh-button" onClick={onManagePerson}>{person ? '更换' : '去上传'}</button>
          </section>
        </aside>
      </div>
    </div>
  );
}
