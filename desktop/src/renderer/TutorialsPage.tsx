import { useEffect, useRef, useState } from 'react';
import { BookOpen, Clock3, Film, FolderOpen, Image, MessageCircle, Play, RefreshCw, Search, Settings2, X } from 'lucide-react';
import { DEFAULT_ROLE_PREFERENCES, appearanceStyle, portraitAsset, type RoleAppearance, type RolePreference } from './role-appearance';
import type { Tutorial, TutorialCatalog, TutorialCategory, TutorialTopic } from './tutorials-types';
import './TutorialsPage.css';

const CATEGORIES = [
  { id: 'short-video' as const, label: '短视频获客', icon: Film },
  { id: 'wechat' as const, label: '微信拓客', icon: MessageCircle },
  { id: 'product-detail' as const, label: '产品详情图', icon: Image },
  { id: 'materials' as const, label: '物保素材库', icon: FolderOpen }
];
const TOPICS: { id: TutorialTopic; label: string }[] = [{ id: 'digital-human', label: '数字人' }, { id: 'ai-editing', label: '线索视频混剪' }, { id: 'product-video', label: '产品效果视频' }];
const duration = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;

export function TutorialsPage({ category: initialCategory = 'short-video', topic: initialTopic = '', preference, appearance, onPersonalize, onOpenGuide, compact = false }: {
  category?: TutorialCategory; topic?: TutorialTopic | ''; preference?: RolePreference; appearance?: RoleAppearance;
  onPersonalize?: () => void; onOpenGuide?: (category: TutorialCategory) => void; compact?: boolean;
}) {
  const [category, setCategory] = useState<TutorialCategory>(initialCategory);
  const [topic, setTopic] = useState<TutorialTopic | ''>(initialTopic);
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<TutorialCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [selection, setSelection] = useState<Tutorial | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState(0);
  const request = useRef(0);
  const activeId = useRef('');
  const mounted = useRef(true);
  const player = useRef<HTMLDivElement>(null);

  useEffect(() => { setCategory(initialCategory); setTopic(initialTopic); }, [initialCategory, initialTopic]);
  async function load(refresh = true) {
    setLoading(true);
    try {
      const result = await window.xiaoxiTutorials?.list({ refresh });
      if (!mounted.current) return;
      if (!result?.ok || !result.data) { setNotice(result?.error || '教程服务暂时不可用，仍可查看操作说明。'); return; }
      setCatalog(result.data);
      setNotice(result.data.offline ? '暂未连接教程服务；已准备的教程仍可播放。' : '');
    } catch { if (mounted.current) setNotice('教程未刷新，请检查网络后重试。'); }
    finally { if (mounted.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    void load(false).then(() => { if (mounted.current) void load(true); });
    const unsubscribe = window.xiaoxiTutorials?.onProgress(value => { if (value.id === activeId.current) setProgress(value.percent); });
    return () => { mounted.current = false; request.current++; unsubscribe?.(); if (activeId.current) void window.xiaoxiTutorials?.cancel(activeId.current); };
  }, []);

  function closePlayer() {
    request.current++;
    if (activeId.current) void window.xiaoxiTutorials?.cancel(activeId.current);
    activeId.current = '';
    setSelection(null); setVideoUrl(''); setPreparing(false);
  }
  async function play(item: Tutorial) {
    const current = ++request.current;
    if (activeId.current && activeId.current !== item.id) await window.xiaoxiTutorials?.cancel(activeId.current);
    if (!mounted.current || request.current !== current) return;
    activeId.current = item.id;
    setSelection(item); setVideoUrl(''); setProgress(0); setPreparing(true); setNotice('');
    try {
      const result = await window.xiaoxiTutorials?.play(item.id);
      if (!mounted.current || request.current !== current) return;
      if (!result?.ok || !result.data) setNotice(result?.error || '这段教程暂时无法播放，请重试。');
      else { setVideoUrl(result.data.url); setCatalog(previous => previous ? { ...previous, items: previous.items.map(row => row.id === item.id ? { ...row, availableOffline: true } : row) } : previous); }
    } catch { if (mounted.current && request.current === current) setNotice('这段教程暂时无法播放，请重试。'); }
    finally { if (mounted.current && request.current === current) { setPreparing(false); player.current?.focus(); } }
  }
  const visible = (catalog?.items || []).filter(item => item.category === category && (!topic || item.topic === topic) && (!query.trim() || item.title.toLowerCase().includes(query.trim().toLowerCase())));
  const categoryLabel = CATEGORIES.find(row => row.id === category)?.label;
  const hasFilters = Boolean(topic || query);
  return <section className={`tutorials-page${compact ? ' tutorials-compact' : ''}`} style={appearance ? appearanceStyle(appearance, true) : undefined}>
    <div className="tutorials-heading-layout">
    {!compact && <header className="tutorials-hero">
      {appearance && <button type="button" className="tutorials-persona" onClick={onPersonalize} disabled={!onPersonalize} aria-label="设置教程伙伴形象与名字"><img src={portraitAsset(appearance)} alt="" /></button>}
      <div><h1>操作教程</h1><p className="tutorials-intro">想完成哪件事？看一小段，跟着做一步。</p><p>{preference?.name || DEFAULT_ROLE_PREFERENCES.tutorials.name}陪您上手。选一个操作，随时暂停、重看。</p>{onPersonalize && <button type="button" className="tutorials-personalize" onClick={onPersonalize}><Settings2 size={16} />设置我的伙伴</button>}</div>
    </header>}
    <div className="tutorials-discovery">
    <div className="tutorials-tools"><nav className="tutorials-categories" aria-label="教程分类">{CATEGORIES.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-pressed={category === id} onClick={() => { setCategory(id); setTopic(''); setQuery(''); closePlayer(); }}><Icon size={20} /><span>{label}</span></button>)}</nav><button type="button" className="tutorials-refresh" onClick={() => void load()} disabled={loading} aria-label="刷新教程"><RefreshCw size={18} />刷新</button></div>
    <div className="tutorials-filters">{category === 'short-video' && <div className="tutorials-topics" aria-label="短视频教程类型"><button type="button" aria-pressed={!topic} onClick={() => setTopic('')}>全部</button>{TOPICS.map(row => <button type="button" key={row.id} aria-pressed={topic === row.id} onClick={() => setTopic(row.id)}>{row.label}</button>)}</div>}<label className="tutorials-search"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="找一个操作" aria-label="搜索教程标题" /></label></div>
    </div>
    </div>
    {notice && <p role="status" className="tutorials-notice">{notice}</p>}
    {selection && <div className="tutorials-player" ref={player} tabIndex={-1}>
      <header><h2>{selection.title}</h2><button type="button" onClick={closePlayer} aria-label="关闭教程播放器"><X size={20} /></button></header>
      {videoUrl ? <video src={videoUrl} poster={selection.coverUrl || undefined} controls autoPlay playsInline onError={() => setNotice('这段录屏无法播放，请重试或换一段教程。')} /> : <div className="tutorials-buffer">{preparing ? <><Film size={36} /><strong>正在准备播放 · {progress}%</strong><progress max={100} value={progress} aria-label="教程准备进度" /><button type="button" onClick={closePlayer}>取消</button></> : <><Play size={36} /><p>暂时没能播放这段教程</p><button type="button" className="tutorials-primary" onClick={() => void play(selection)}>重新播放</button></>}</div>}
    </div>}
    <div className="tutorials-list-heading"><h2>{categoryLabel}{topic ? ` · ${TOPICS.find(row => row.id === topic)?.label || ''}` : ''}</h2><span>每段只讲一个操作</span></div>
    {loading && !catalog ? <div className="tutorials-loading" role="status">正在读取教程…</div> : visible.length ? <div className="tutorials-grid">{visible.map(item => <button key={item.id} type="button" className="tutorials-card" onClick={() => void play(item)} disabled={preparing && selection?.id === item.id}><span className="tutorials-cover">{item.coverUrl ? <img src={item.coverUrl} alt="" loading="lazy" /> : <Film size={44} />}<span className="tutorials-play"><Play size={23} fill="currentColor" /></span><span className="tutorials-duration"><Clock3 size={13} />{duration(item.durationSeconds)}</span></span><strong>{item.title}</strong><span className="tutorials-card-caption">{item.availableOffline ? '已准备 · 离线可看' : '点击观看'}</span></button>)}</div> : <div className="tutorials-empty"><BookOpen size={40} /><h3>{hasFilters ? '还没有匹配的教程' : '这类短教程正在准备中'}</h3><p>{hasFilters ? '换个关键词，或查看这个分类的全部教程。' : '视频发布后会出现在这里。现在可以先看操作说明。'}</p><div>{hasFilters && <button type="button" onClick={() => { setQuery(''); setTopic(''); }}>查看全部教程</button>}{onOpenGuide && <button type="button" className="tutorials-primary" onClick={() => onOpenGuide(category)}><BookOpen size={17} />查看操作说明</button>}</div></div>}
    {visible.length > 0 && onOpenGuide && <button type="button" className="tutorials-text-guide" onClick={() => onOpenGuide(category)}><BookOpen size={17} />也可以查看操作说明</button>}
  </section>;
}
