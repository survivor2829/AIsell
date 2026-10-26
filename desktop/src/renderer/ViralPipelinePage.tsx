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

const DEVELOPMENT_EDITION = import.meta.env.VITE_XIAOXI_EDITION === 'development';

// 内部：把最近一次扒取的爆款提取出原口播（客户点「仿写」时才改写），再发布到云端：云端合并进已有的库，并拆好每条的结构。
function LibraryTools({ jobs, onError }: { jobs: ViralJob[]; onError: (message: string) => void }) {
  const [limit, setLimit] = useState(100), [busy, setBusy] = useState(''), [note, setNote] = useState('');
  const [tokenSaved, setTokenSaved] = useState<boolean | null>(null), [token, setToken] = useState('');
  const library = jobs.filter((j) => j.mode === 'library');
  const done = library.filter((j) => j.status === 'done').length, waiting = library.filter((j) => ['queued', 'running'].includes(j.status)).length;
  useEffect(() => { void unwrap(referenceApi().viralLibraryPublishToken({})).then((r) => setTokenSaved(r.saved)).catch(() => setTokenSaved(false)); }, []);
  async function run(name: string, work: () => Promise<void>) { setBusy(name); try { await work(); } catch (error) { onError((error as Error).message); } finally { setBusy(''); } }
  return (
    <section className="vp-panel vp-filters" aria-label="文案库（内部）">
      <div className="vp-filter-row"><b>文案库</b>
        <span className="vp-muted">已提取 {done} 条{waiting ? `，还有 ${waiting} 条在处理` : ''}</span><span className="vp-spacer" />
        <label className="vp-cap">前 <input type="number" min={1} max={300} value={limit} onChange={(event) => setLimit(Math.max(1, Math.min(300, Number(event.target.value) || 1)))} /> 条</label>
        <button type="button" className="dh-button" data-xiaoxi-digital-human-action="reference-viral-library-build" disabled={Boolean(busy)}
          onClick={() => void run('build', async () => { await unwrap(referenceApi().viralLibraryBuild({ limit })); })}>提取进文案库</button>
        <button type="button" className="dh-button" disabled={Boolean(busy) || !done}
          onClick={() => void run('export', async () => { const r = await unwrap(referenceApi().viralLibraryExport()); setNote(`已导出 ${r.items} 条（扒到 ${r.collected} 条）：${r.file}`); })}>导出文件</button>
        <button type="button" className="dh-button is-primary" data-xiaoxi-digital-human-action="reference-viral-library-publish" disabled={Boolean(busy) || !done || !tokenSaved}
          title={tokenSaved ? undefined : '先填写发布密钥'}
          onClick={() => void run('publish', async () => {
            setNote('正在发布，并让 AI 拆每条爆款的结构（内部花费，不扣客户额度），条数多时要几分钟…');
            const r = await unwrap(referenceApi().viralLibraryPublish());
            setNote(`已发布 ${r.sent} 条：新增 ${r.added} 条、更新 ${r.updated} 条，云端文案库共 ${r.total} 条；本次拆好结构 ${r.structured} 条${r.missingStructure ? `，还有 ${r.missingStructure} 条没拆成，下次发布会再拆` : '，全部拆好了'}。`);
          })}>{busy === 'publish' ? '正在发布…' : '发布到文案库'}</button>
      </div>
      {tokenSaved === false && <div className="vp-filter-row">
        <span className="vp-muted">发布密钥（只存在这台电脑、当前 Windows 用户加密）</span>
        <input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="粘贴服务器上配置的发布密钥" />
        <button type="button" className="dh-button" disabled={Boolean(busy) || token.trim().length < 32}
          onClick={() => void run('token', async () => { setTokenSaved((await unwrap(referenceApi().viralLibraryPublishToken({ token }))).saved); setToken(''); })}>保存密钥</button>
      </div>}
      {note && <p className="vp-muted">{note}</p>}
    </section>
  );
}

export function ViralPipelinePage({ onImitate, onManagePerson }: { onImitate: (reference: NarrationReference) => void; onManagePerson: () => void }) {
  const [industries, setIndustries] = useState<string[]>(['cleaning', 'property', 'factory']);
  const [platforms, setPlatforms] = useState<string[]>(['douyin', 'xiaohongshu']);
  const [days, setDays] = useState<30 | 90>(90);
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
  const oneClickBlocked = !personReady ? '先在「本人数字分身」里准备好出镜人物和声音'
    : !person?.voiceConsented ? '先在「本人数字分身」里做一条口播并确认声音授权' : '';
  const queuedIds = new Set(jobs.filter((j) => j.holdsItem).map((j) => j.itemId));
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
          {DEVELOPMENT_EDITION && <LibraryTools jobs={jobs} onError={setError} />}
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
