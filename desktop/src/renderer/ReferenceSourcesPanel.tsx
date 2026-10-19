import { useEffect, useRef, useState } from 'react';
import type { DigitalHumanResult } from './digital-human-types';
import type { NarrationReference, ReferenceHumanApi, SourceResults, SourceState } from './reference-human-types';

async function data<T>(promise: Promise<DigitalHumanResult<T>>) {
  const result = await promise;
  if (!result.ok || result.data === undefined) throw new Error(result.error || '参考内容暂时不可用，可以直接粘贴文案。');
  return result.data;
}
const dateLabel = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('zh-CN') : '未知';
const safeLink = (value: string) => { try { const parsed = new URL(value); return parsed.protocol === 'https:' ? parsed.href : undefined; } catch { return undefined; } };

export function ReferenceSourcesPanel({ api, value, onChange, disabled, busy: parentBusy, onWrite, canWrite, active }: {
  active: boolean; canWrite: boolean; onWrite: (value: NarrationReference) => void;
  api: ReferenceHumanApi; value?: NarrationReference; onChange: (value?: NarrationReference) => void;
  disabled: boolean; busy: boolean;
}) {
  const [state, setState] = useState<SourceState | null>(null), [results, setResults] = useState<SourceResults | null>(null);
  const [query, setQuery] = useState('工业洗地机'), [url, setUrl] = useState('');
  const [platform, setPlatform] = useState('douyin'), [body, setBody] = useState(''), [statusError, setStatusError] = useState('');
  const [loading, setLoading] = useState(false);
  const sourceBusy = useRef(false);
  const busy = parentBusy || loading;
  async function run(_name: string, action: () => Promise<void>) {
    if (sourceBusy.current || parentBusy) return;
    sourceBusy.current = true; setLoading(true); setStatusError('');
    try { await action(); } catch (error) { setStatusError((error as Error).message); }
    finally { sourceBusy.current = false; setLoading(false); }
  }
  const searched = useRef(false);
  const [filter, setFilter] = useState('all');
  const [mode, setMode] = useState<'search' | 'paste'>('search');
  useEffect(() => { let active = true;
    void data(api.sourceStatus()).then((result) => { if (active) setState(result); }).catch((error) => { if (active) setStatusError(error.message); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!active || busy || !state?.connected || searched.current) return;
    searched.current = true;
    void run('source-search', async () => setResults(await data(api.sourceSearch({ query, days: 30 }))));
  }, [active, busy, state?.connected]);
  const search = (days: number) => void run('source-search', async () => setResults(await data(api.sourceSearch({ query, days }))));
  const renderItem = (item: NarrationReference, index: number) => <article key={`${item.url}-${index}`} className="rh-source-item">
    <strong>{item.title || '未提供标题'}</strong><p>{item.body ? item.body.slice(0, 160) : '可读取笔记正文或视频说明；不会自动转写完整口播。'}</p>
    <small>{item.author || '作者未知'} · 发布 {dateLabel(item.publishedAt)} · 点赞 {item.metrics?.likes == null ? '未知' : item.metrics.likes.toLocaleString('zh-CN')}</small>
    <small>采集 {dateLabel(item.collectedAt)} · {item.provenance || '来源待核实'}</small>
    <div className="rh-source-actions">{safeLink(item.url) && <a href={safeLink(item.url)} target="_blank" rel="noreferrer">查看原来源</a>}
      <button type="button" className="dh-button" data-xiaoxi-digital-human-action="reference-write-script" disabled={disabled || busy || !canWrite} aria-pressed={!!value && value.url === item.url && value.title === item.title} onClick={() => onWrite(item)}>用这条写稿 · 1次额度</button></div>
  </article>;
  return <section className="rh-reference-sources" aria-label="口播参考来源">
    <div className="rh-source-modes" aria-label="选择参考方式"><button type="button" aria-pressed={mode === 'search'} onClick={() => setMode('search')}>找行业参考</button><button type="button" aria-pressed={mode === 'paste'} onClick={() => setMode('paste')}>粘贴参考链接／文案</button></div>
    <div hidden={mode !== 'search'}>
    <details className="rh-search-options"><summary>调整关键词与平台</summary><div className="rh-search-row"><label className="dh-field"><span>内容关键词</span><input maxLength={100} value={query} disabled={disabled || busy} onChange={(event) => setQuery(event.target.value)} placeholder="例如：工厂洗地机选型" /></label><button type="button" className="dh-button" disabled={disabled || busy || !query.trim()} onClick={() => search(30)}>搜索近30天</button></div><label className="dh-field"><span>显示平台</span><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">已取得的所有平台</option>{state?.platforms.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></details>
    <details className="rh-connections"><summary>平台连接与登录 · 查看状态</summary>
    <p className="dh-quality">{state?.message || statusError || '正在读取平台连接状态…'}</p>
    <div className="rh-source-actions">{state?.platforms.map((item) => <button key={item.id} type="button" className="dh-button" disabled={disabled || busy}
      onClick={() => void run('source-connect', async () => setState(await data(api.sourceConnect({ platform: item.id }))))}>{item.name} · {item.status}</button>)}
      <button type="button" className="dh-button" disabled={busy} onClick={() => void run('source-status', async () => { setState(await data(api.sourceStatus())); setStatusError(''); })}>刷新连接</button></div>
    </details>
    {statusError && <p className="dh-quality" role="status">{statusError} 可以直接填写下方文案。</p>}
    {!results && !statusError && <p className="dh-quality">{busy ? '正在读取行业参考…' : '连接平台后推荐近期参考，也可以直接在下方填写自己的文案。'}</p>}
    {results?.suggest90Days && <button type="button" className="dh-button" disabled={disabled || busy} onClick={() => search(90)}>结果较少，扩大到90天</button>}
    {results && <div className="rh-source-results"><p className="dh-quality">当前范围：近{results.days}天。同平台内比较已取得的互动数据，未知指标不会当成热门依据。</p>
      {results.groups.filter((group) => filter === 'all' || group.platform === filter).map((group) => <section key={group.platform}><h4>{group.name} · {group.status}</h4><p className="dh-quality">{group.message}</p>
        {group.items.length ? group.items.slice(0, 3).map(renderItem) : <p className="dh-quality">没有可核实的近期结果。</p>}
        {group.items.length > 3 && <details><summary>更多参考（{group.items.length - 3}）</summary>{group.items.slice(3).map(renderItem)}</details>}
        {!!group.unverified.length && <details><summary>日期未知的参考（{group.unverified.length}）</summary>{group.unverified.map(renderItem)}</details>}
      </section>)}</div>}
    </div>
    <div className="rh-source-paste" hidden={mode !== 'paste'}><label className="dh-field"><span>参考链接（选填）</span><input value={url} maxLength={2000} disabled={disabled || busy} onChange={(event) => setUrl(event.target.value)} placeholder="粘贴抖音或小红书内容链接" /></label>
      <div className="rh-source-actions"><label>链接来自 <select value={platform} disabled={disabled || busy} onChange={(event) => setPlatform(event.target.value)}><option value="douyin">抖音</option><option value="xiaohongshu">小红书</option></select></label>
        <button type="button" className="dh-button" disabled={disabled || busy || !url.trim()} onClick={() => void run('source-read', async () => { const item = await data(api.sourceRead({ platform, url })); setBody(item.body); onChange(item); })}>读取链接正文</button></div>
      <label className="dh-field"><span>直接粘贴参考文案</span><textarea rows={4} value={body} maxLength={6000} disabled={disabled || busy} onChange={(event) => setBody(event.target.value)} placeholder="链接读不到时，直接粘贴正文。不会自动给内容补造点赞和发布时间。" /></label>
      <button type="button" className="dh-button" disabled={disabled || busy || !body.trim()} onClick={() => onChange({ platform: 'manual', title: body.trim().split(/[\n。！？]/u)[0].slice(0, 120), body: body.trim(), url: safeLink(url) || '', collectedAt: new Date().toISOString(), publishedAt: null, metrics: { likes: null }, provenance: '用户提供' })}>采用粘贴的参考文案</button>
    </div>
    {value && <p className="rh-source-selected">本次参考：{value.title || '粘贴文案'} <button type="button" className="dh-text-button" disabled={disabled || busy} onClick={() => onChange(undefined)}>移除</button></p>}
  </section>;
}
