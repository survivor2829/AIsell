import { useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, ExternalLink, MapPin, Pause, Play, Download, Search, Phone, History, SlidersHorizontal, ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { dateText, safeExternalUrl, statusText, useWorkbench } from './business-workbench';
import './BusinessWorkbench.css';
import mapRegions from '../shared/map-regions.json';

type MapTask = { id: string; province?: string; city: string; district?: string; device: string; keywords: string[]; status: string; count: number; newCount: number; message?: string; updatedAt?: string; limit: number; maxMinutes: number; processedCount?: number; skippedCount?: number; failedCount?: number; phoneCount?: number; stopReason?: string };
type Evidence = { id: string; level: string; url?: string; date?: string; description: string; contactIdentity?: string; confirmedAt?: string };
type FollowUp = { id: string; content: string; nextStep?: string; createdAt?: string };
type Lead = { id: string; taskIds?: string[]; name: string; city: string; address: string; industry: string; phone: string; phoneType: string; sourceUrl: string; collectedAt: string; matchReason: string; favorite: boolean; demandLevel: string; suspectedDuplicate?: boolean; evidence: Evidence[]; followUps: FollowUp[]; aiSummary?: { summary: string; questions: string[]; generatedAt: string } };
type MapState = { account?: { namespace: string; displayId: string; migrationAvailable: boolean }; tasks: MapTask[]; leads: Lead[]; settings: { limit: number; maxMinutes: number }; browser: { state: string; authorized?: boolean; account?: { nickname?: string; name?: string }; message?: string }; busy: boolean; capabilities?: { collect: boolean; validated?: boolean; reason?: string; organize?: boolean } };
const demandLabels: Record<string, string> = { none: '需求待确认', signal: '发现需求信号', confirmed: '已人工确认需求' };

export function MapAcquisitionPanel() {
  const { state, loading, pending, error, notice, run } = useWorkbench<MapState>(window.xiaoxiMapAcquisition);
  const [resultTaskId, setResultTaskId] = useState('');
  const runningTask = useRef('');
  const [tab, setTab] = useState('customers');
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState(false);
  const [level, setLevel] = useState('all');
  const [phoneType, setPhoneType] = useState('all');
  const [selectedId, setSelectedId] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const startLock = useRef(false);
  const [page, setPage] = useState(1);
  const listRef = useRef<HTMLElement>(null);
  const previousPage = useRef(page);
  useEffect(() => { if (previousPage.current !== page) listRef.current?.scrollIntoView({ block: 'start' }); previousPage.current = page; }, [page]);
  const [taskDraft, setTaskDraft] = useState({ province: '', city: '', device: '清洁设备', keywords: '物业公司', district: '', limit: 10, maxMinutes: 30 });
  const [customerType, setCustomerType] = useState('物业公司');
  const [evidence, setEvidence] = useState({ level: 'signal', description: '', url: '', date: '', contactIdentity: '', confirmedAt: '', nextStep: '' });
  const [followUp, setFollowUp] = useState({ content: '', nextStep: '' });
  useEffect(() => { setFollowUp({ content: '', nextStep: '' }); setEvidence({ level: 'signal', description: '', url: '', date: '', contactIdentity: '', confirmedAt: '', nextStep: '' }); }, [selectedId]);
  const resultTask = state?.tasks.find(task => task.id === resultTaskId) || state?.tasks.at(-1);
  const showResults = (taskId: string) => {
    setResultTaskId(taskId); setTab('customers'); setCreating(false);
    setSelectedId(''); setPage(1); setQuery(''); setFavorites(false); setLevel('all'); setPhoneType('all');
  };
  useEffect(() => {
    const active = state?.tasks.find(task => task.status === 'running');
    if (active) runningTask.current = active.id;
    else if (runningTask.current) {
      const finished = state?.tasks.find(task => task.id === runningTask.current);
      runningTask.current = '';
      if (finished?.status === 'completed') showResults(finished.id);
    }
  }, [state?.tasks]);
  const leads = useMemo(() => (state?.leads || []).filter(lead => !!resultTask && lead.taskIds?.includes(resultTask.id)).slice().sort((a, b) => (b.collectedAt || '').localeCompare(a.collectedAt || '')), [state?.leads, resultTask?.id]);
  const filtered = useMemo(() => leads.filter(lead => (!favorites || lead.favorite) && (level === 'all' || lead.demandLevel === level) && (phoneType === 'all' || lead.phoneType === phoneType)
    && `${lead.name} ${lead.address} ${lead.city} ${lead.industry}`.toLowerCase().includes(query.trim().toLowerCase())), [leads, query, favorites, level, phoneType]);
  const current = filtered.find(lead => lead.id === selectedId) || filtered[(page - 1) * 10];
  const busy = Boolean(pending || loading || starting);
  const resetFilter = () => { setPage(1); };
  const saveTask = async (event: React.FormEvent) => {
    event.preventDefault();
    const saved = await run('save-task', { ...taskDraft, keywords: taskDraft.keywords.split(/[，,、\n]/).map(value => value.trim()).filter(Boolean) });
    const task = (saved?.state as MapState | undefined)?.tasks.at(-1);
    if (task) { showResults(task.id); await startSearch(task); }
  };
  const exportLeads = () => run('export', { leadIds: filtered.map(lead => lead.id) }, '导出已处理');
  const regionCities = mapRegions.find(p => p.name === taskDraft.province)?.cities || [];
  const regionDistricts = regionCities.find(c => c.name === taskDraft.city)?.districts || [];
  const latestTask = state?.tasks.at(-1);
  const activeTask = state?.tasks.find(task => task.status === 'running');
  const connected = state?.browser.state === 'connected';
  const regionValid = (task: MapTask) => mapRegions.some(p => p.cities.some(c => c.name.replace(/市$/, '') === task.city.replace(/市$/, '') && (!task.district || c.districts.includes(task.district))));
  const invalidRegion = !!resultTask && !regionValid(resultTask);
  const exhausted = resultTask?.status === 'completed' && resultTask.stopReason !== 'limit_reached';
  useEffect(() => { setSelectedId(current?.id || ''); }, [current?.id]);
  const changeRange = (previous = resultTask || latestTask) => {
    if (previous) {
      const keywords = previous.keywords.join('、');
      const region = mapRegions.find(p => p.cities.some(c => c.name === previous.city)) || mapRegions.find(p => p.name === previous.city);
      const city = region?.cities.some(c => c.name === previous.city) ? previous.city : '';
      setTaskDraft({ province: region?.name || '', city, district: city ? previous.district || '' : '', device: previous.device, keywords, limit: previous.limit, maxMinutes: previous.maxMinutes });
      setCustomerType(['物业公司', '保洁公司', '物业公司、保洁公司'].includes(keywords) ? keywords : 'custom');
    }
    setCreating(true);
  };
  const startSearch = async (task?: MapTask) => {
    if (!task) { changeRange(); return; }
    if (!regionValid(task)) { changeRange(task); return; }
    if (startLock.current || state?.busy || exhausted && task.status === 'completed' && task.id === resultTask?.id) return;
    startLock.current = true; setStarting(true);
    try {
      await run('open-account');
      const refreshed = await run('refresh-account');
      if ((refreshed?.state as MapState | undefined)?.browser.state !== 'connected') { setAccountOpen(true); return; }
      let next = task;
      if (task.status === 'completed') {
        const saved = await run('save-task', { ...task, id: undefined, continueTaskId: task.id });
        const created = (saved?.state as MapState | undefined)?.tasks.at(-1);
        if (!created) return;
        next = created;
      }
      showResults(next.id);
      await run('start-task', { taskId: next.id });
    } finally { startLock.current = false; setStarting(false); }
  };
  const favorite = (lead: Lead) => void run('save-lead', { id: lead.id, favorite: !lead.favorite });
  if (loading) return <p className="bw-loading" role="status">正在读取…</p>;
  return <div className="bw-workbench bw-map map-clean">
    <header className="map-toolbar">
      <div className="map-range"><MapPin size={25} /><strong>{resultTask ? [resultTask.city, resultTask.district].filter(Boolean).join(' · ') : '地图获客'}</strong><span>{resultTask?.keywords.join(' / ') || '选择地区与客户类型'}</span></div>
      <div className="map-toolbar-actions">
        <button className="map-link map-account" aria-expanded={accountOpen} onClick={() => setAccountOpen(!accountOpen)}><i className={connected ? 'connected' : ''} />{connected ? '高德已连接' : state?.browser.state === 'verification_required' ? '等待手动验证' : state?.browser.state === 'identity_unavailable' ? '页面待就绪' : '连接高德'}</button>
        <button className="map-link" disabled={busy || state?.busy} onClick={() => changeRange()}>换地区</button>
        {activeTask ? <button className="primary-button" disabled={busy} onClick={() => void run('pause-task', { taskId: activeTask.id })}><Pause size={16} />暂停</button> : <button className="primary-button" disabled={busy || exhausted} onClick={() => void startSearch(resultTask)}>{starting ? '正在连接…' : !resultTask ? '开始找' : invalidRegion ? '重新选地区' : resultTask.status === 'paused' ? '继续任务' : exhausted ? '已找完' : '继续找'}<ArrowRight size={17} /></button>}
      </div>
    </header>
    {error && <div className="workflow-alert" role="alert">{error}</div>}{notice && <div className="workflow-notice" role="status">{notice}</div>}
    {state?.account?.migrationAvailable && <div className="bw-account-strip"><span>此电脑有未归属账号的旧地图资料，原文件将保留。</span><button className="secondary-button" disabled={busy || state.busy} onClick={() => void run('claim-legacy', { namespace: state.account?.namespace }, '旧地图资料已导入当前账号，原文件保留')}>确认属于{state.account.displayId}并导入</button></div>}
    {accountOpen && <div className="bw-account-strip"><span>{state?.browser.state === 'verification_required' ? '请在当前高德窗口完成验证，再点继续任务。' : state?.browser.message || '在高德窗口完成登录后，核对账号即可。'}</span><button className="secondary-button" disabled={busy} onClick={() => void run('open-account')}>打开高德</button><button className="secondary-button" disabled={busy} onClick={() => void run('refresh-account')}>核对账号</button></div>}
    {(activeTask || resultTask?.status === 'paused') && <div className="map-progress" role="status">{activeTask ? '正在查找' : '已暂停'} · 已处理 {(activeTask || resultTask)?.processedCount || 0} 家 / 已保存 {(activeTask || resultTask)?.count || 0} 家 · {invalidRegion ? '原任务地区不匹配，请重新选择省、市、区县。' : !activeTask && connected && resultTask?.stopReason === 'verification_required' ? '账号已核对，可继续任务。' : (activeTask || resultTask)?.message}</div>}
    {resultTask && <div className="map-progress"><button className="map-link" disabled={busy} onClick={async () => { const task = activeTask || resultTask; const result = await run('return-results', { taskId: task.id }); if (result) showResults(task.id); }}>返回结果</button>{resultTask.status !== 'completed' && <button className="map-link" disabled={busy} onClick={async () => { const task = activeTask || resultTask; const result = await run('finish-task', { taskId: task.id }); if (result) showResults(task.id); }}>结束本次</button>}</div>}
    {exhausted && <p className="map-progress">{resultTask?.stopReason === 'user_finished' ? '本次已结束，已保存结果保留。' : '本范围已查完，可换地区继续查找。'}</p>}
    {creating && <form className="bw-editor" onSubmit={event => void saveTask(event)}>
      <h3>这次想找哪些客户？</h3><div className="bw-form-grid">
        <label>省份<select required value={taskDraft.province} onChange={e => setTaskDraft({ ...taskDraft, province: e.target.value, city: '', district: '' })}><option value="">选择省份</option>{mapRegions.map(p => <option key={p.name}>{p.name}</option>)}</select></label><label>城市<select required value={taskDraft.city} disabled={!taskDraft.province} onChange={e => setTaskDraft({ ...taskDraft, city: e.target.value, district: '' })}><option value="">选择城市</option>{regionCities.map(c => <option key={c.name}>{c.name}</option>)}</select></label>
        <label>客户类型<select value={customerType} onChange={event => { const value = event.target.value; setCustomerType(value); setTaskDraft({ ...taskDraft, keywords: value === 'custom' ? '' : value }); }}><option>物业公司</option><option>保洁公司</option><option value="物业公司、保洁公司">物业与保洁公司</option><option value="custom">自定义关键词</option></select></label>
        {customerType === 'custom' && <label>搜索关键词<input required value={taskDraft.keywords} onChange={event => setTaskDraft({ ...taskDraft, keywords: event.target.value })} placeholder="例如：物业公司、工厂、保洁公司，用逗号分隔" /></label>}
        <label>区县<select value={taskDraft.district} disabled={!taskDraft.city} onChange={e => setTaskDraft({ ...taskDraft, district: e.target.value })}><option value="">全市</option>{regionDistricts.map(d => <option key={d}>{d}</option>)}</select></label>
      </div><details><summary>范围与运行设置</summary><div className="bw-form-grid">
        <label>最多保存企业数<input type="number" min="1" max="1000" value={taskDraft.limit} onChange={event => setTaskDraft({ ...taskDraft, limit: Number(event.target.value) })} /></label>
        <label>单次最长运行（分钟）<input type="number" min="1" max="120" value={taskDraft.maxMinutes} onChange={event => setTaskDraft({ ...taskDraft, maxMinutes: Number(event.target.value) })} /></label>
      </div></details><div className="bw-actions"><button className="primary-button" type="submit" disabled={busy}>开始找企业</button><button className="secondary-button" type="button" onClick={() => setCreating(false)}>收起</button></div>
    </form>}

    {tab === 'tasks' && <div className="map-history"><div className="map-pane-title"><h3>历史任务</h3><button className="map-link" onClick={() => setTab('customers')}>返回本次结果</button></div>
    {tab === 'tasks' && <div className="bw-task-list">{!state?.tasks?.length && <div className="bw-empty"><MapPin size={30} /><h3>先选一个城市，建立搜索任务</h3><p>结果将保留来源、采集时间和需求依据，便于下一次继续跟进。</p></div>}{state?.tasks?.slice().reverse().map(task => <article className="bw-task" key={task.id}><div><strong>{task.city}{task.district ? ` · ${task.district}` : ''} · {task.device}</strong><p>{task.keywords.join('、')}</p><small>{statusText[task.status] || task.status} · 已处理 {task.processedCount ?? task.count ?? 0} 家 · 保存 {task.count || 0} 家 · 新增 {task.newCount || 0} 家 · 有电话 {task.phoneCount || 0} 家 · 跳过 {task.skippedCount || 0} 家 · 读取失败 {task.failedCount || 0} 家</small>{task.message && <p className="bw-note">{task.message}</p>}</div>
      <div className="bw-actions"><button className="secondary-button" onClick={() => showResults(task.id)}>查看本次结果</button>{task.status !== 'completed' ? <button className="secondary-button" disabled={busy || (state?.busy && task.status !== 'running')} onClick={() => task.status === 'running' ? void run('pause-task', { taskId: task.id }) : void startSearch(task)}>{task.status === 'running' ? <Pause size={15} /> : <Play size={15} />}{task.status === 'running' ? '暂停' : task.status === 'paused' ? '继续' : '开始搜索'}</button> : task.stopReason === 'limit_reached' && <button className="secondary-button" disabled={busy || state?.busy} onClick={() => void startSearch(task)}>继续找下一批</button>}</div></article>)}</div>}
</div>}
    {tab === 'customers' && <div className="map-workspace">
      <section ref={listRef} className="map-list" aria-label="本次企业名单">
        <div className="map-pane-title"><strong>本次 {leads.length} 家</strong><button className="map-link" onClick={() => setTab('tasks')}><History size={18} />历史</button></div>
        <div className="map-search"><label className="bw-search"><Search size={18} /><input aria-label="搜索本次企业" placeholder="搜索企业" value={query} onChange={e => { setQuery(e.target.value); resetFilter(); }} /></label><button className="secondary-button" aria-label="筛选与导出" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal size={19} /></button></div>
        {filtersOpen && <div className="bw-filters map-filter-panel"><select aria-label="联系方式" value={phoneType} onChange={e => {setPhoneType(e.target.value);resetFilter();}}><option value="all">全部电话</option><option value="mobile">手机号</option><option value="landline">座机</option><option value="missing">暂无电话</option></select><select aria-label="需求依据" value={level} onChange={e => {setLevel(e.target.value);resetFilter();}}><option value="all">全部需求</option>{Object.entries(demandLabels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select><label className="bw-check"><input type="checkbox" checked={favorites} onChange={e => {setFavorites(e.target.checked);resetFilter();}} />只看收藏</label><button className="map-link" disabled={busy || !filtered.length} onClick={() => void exportLeads()}><Download size={15} />导出</button></div>}
        <div className="map-list-scroll">{filtered.slice((page - 1) * 10, page * 10).map(lead => <button key={lead.id} className={'map-company' + (current?.id === lead.id ? ' is-selected' : '')} aria-pressed={current?.id === lead.id} onClick={() => setSelectedId(lead.id)}><span><strong>{lead.name}</strong><small>{lead.address || lead.city}</small></span><span className={'map-phone-state' + (lead.phone ? ' has-phone' : '')}><Phone size={16} />{lead.phone ? '有电话' : '无电话'}</span></button>)}
          {!filtered.length && <div className="bw-empty"><Search size={25} /><h3>{leads.length ? '没有匹配企业' : activeTask ? '正在查找企业' : '本次暂无企业'}</h3><p>{leads.length ? '调整筛选再看看。' : invalidRegion ? '请重新选择省、市、区县。' : resultTask?.message ? '上次任务：' + resultTask.message : '选择地区，开始查找。'}</p></div>}
        </div>
        <div className="map-pagination"><span>共 {filtered.length} 家 · 第 {page} / {Math.max(1, Math.ceil(filtered.length / 10))} 页</span><div><button className="map-link" aria-label="上一页" disabled={page <= 1} onClick={() => {setPage(p => p - 1);setSelectedId('');}}><ChevronLeft size={18} />上一页</button><button className="map-link" aria-label="下一页" disabled={page * 10 >= filtered.length} onClick={() => {setPage(p => p + 1);setSelectedId('');}}>下一页<ChevronRight size={18} /></button></div></div>
      </section>
      <aside className="map-detail" aria-label="企业详情">
        {current ? <div key={current.id}>
          <div className="map-detail-title"><h3>{current.name}</h3><button className="bw-icon-button" aria-label={current.favorite ? '取消收藏' : '收藏企业'} title={current.favorite ? '取消收藏' : '收藏企业'} aria-pressed={current.favorite} disabled={busy} onClick={() => favorite(current)}><Bookmark size={24} fill={current.favorite ? 'currentColor' : 'none'} /></button></div>
          <span className={'bw-badge bw-' + current.demandLevel}>{demandLabels[current.demandLevel] || demandLabels.none}</span>
          <p className="map-address"><MapPin size={20} /><span>{current.address || current.city}</span></p>
          <div className="map-phone"><Phone size={22} /><div><strong>{current.phone || '暂无电话'}</strong>{current.phone && <small>公开电话 · 接通未核实</small>}</div>{current.phone && <button className="secondary-button" disabled={busy} onClick={() => void run('copy-phone', { leadId: current.id }, '电话已复制')}>复制电话</button>}</div>
          <details className="map-disclosure"><summary>来源与详情</summary><p>{current.industry || '行业待核实'}</p><p>{current.matchReason}</p><small>采集于 {dateText(current.collectedAt)}</small>{safeExternalUrl(current.sourceUrl) && <button className="map-link" disabled={busy} onClick={() => void run('open-source', { leadId: current.id })}>高德地图 <ExternalLink size={14} /></button>}{current.suspectedDuplicate && <p>疑似重复，未自动合并</p>}{current.aiSummary && <p>{current.aiSummary.summary}</p>}
        <details><summary>需求依据（选填）</summary>        <h4>需求依据</h4>{!current.evidence.length && <p className="bw-note">只有地图企业资料，尚无需求证据。</p>}{current.evidence.map(item => <div className="bw-record" key={item.id}><strong>{demandLabels[item.level]}</strong><p>{item.description}</p><small>{item.date || item.confirmedAt || ''} {item.contactIdentity || ''}</small>{safeExternalUrl(item.url) && <button className="bw-text-button" disabled={busy} onClick={() => void run('open-related', { leadId: current.id, evidenceId: item.id })}>查看证据来源</button>}</div>)}
        <form onSubmit={event => { event.preventDefault(); void run('save-evidence', { ...evidence, leadId: current.id }, '需求依据已保存').then(result => { if (result) setEvidence({ level: 'signal', description: '', url: '', date: '', contactIdentity: '', confirmedAt: '', nextStep: '' }); }); }}>
          <label>依据类型<select value={evidence.level} onChange={event => setEvidence({ ...evidence, level: event.target.value })}><option value="signal">公开需求信号</option><option value="confirmed">我已人工确认需求</option></select></label>
          <label>需求说明<textarea required value={evidence.description} onChange={event => setEvidence({ ...evidence, description: event.target.value })} /></label>
          {evidence.level === 'signal' ? <><label>来源链接<input type="url" required value={evidence.url} onChange={event => setEvidence({ ...evidence, url: event.target.value })} /></label><label>来源日期<input type="date" required value={evidence.date} onChange={event => setEvidence({ ...evidence, date: event.target.value })} /></label></> : <><label>已核实的联系人身份<input required value={evidence.contactIdentity} onChange={event => setEvidence({ ...evidence, contactIdentity: event.target.value })} /></label><label>确认时间<input type="datetime-local" required value={evidence.confirmedAt} onChange={event => setEvidence({ ...evidence, confirmedAt: event.target.value })} /></label><label>下一步<input required value={evidence.nextStep} onChange={event => setEvidence({ ...evidence, nextStep: event.target.value })} /></label></>}
          <button className="secondary-button" disabled={busy}>保存依据</button>
        </form></details>
          </details>
          <form className="map-follow" onSubmit={event => { event.preventDefault(); void run('save-follow-up', { leadId: current.id, ...followUp }, '跟进已保存').then(result => { if (result) setFollowUp({ content: '', nextStep: '' }); }); }}><h4>跟进</h4><textarea aria-label="跟进情况" placeholder="记一下跟进情况…" required value={followUp.content} onChange={e => setFollowUp({ ...followUp, content: e.target.value })} /><div className="map-follow-actions"><button className="primary-button" disabled={busy || !followUp.content.trim()}>保存</button></div></form>
          <details className="map-disclosure"><summary>历史记录 {current.followUps.length}</summary>{!current.followUps.length && <p className="bw-note">暂无跟进记录</p>}{current.followUps.map(item => <div className="bw-record" key={item.id}><p>{item.content}</p><small>{dateText(item.createdAt)}{item.nextStep ? ' · ' + item.nextStep : ''}</small></div>)}</details>
        </div> : <div className="bw-empty"><MapPin size={30} /><h3>选择企业查看详情</h3></div>}
      </aside>
    </div>}
  </div>;
}
