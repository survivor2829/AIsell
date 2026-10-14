import { useEffect, useRef, useState } from "react";
import { ExternalLink, PlayCircle, RefreshCw, Search, Settings2, X } from "lucide-react";
import { appearanceStyle, portraitAsset, type RoleAppearance, type RolePreference } from "./role-appearance";
import type { OfficialCatalog, OfficialMaterial, SearchUpdate } from "./official-materials-types";
import "./OfficialMaterialsPage.css";

export function OfficialMaterialsPage({ onUseMaterial, preference, appearance, onPersonalize }: {
  onUseMaterial: (ids: string[]) => void;
  preference: RolePreference;
  appearance: RoleAppearance;
  onPersonalize: () => void;
}) {
  const [catalog, setCatalog] = useState<OfficialCatalog | null>(null);
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [importing, setImporting] = useState("");
  const promptInput = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState("");
  const [searchedPrompt, setSearchedPrompt] = useState("");
  const [search, setSearch] = useState<SearchUpdate | null>(null);
  const [preview, setPreview] = useState<OfficialMaterial | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [preparingPreview, setPreparingPreview] = useState(false);
  const previewRequest = useRef(0);
  const [visible, setVisible] = useState(24);
  const taskId = useRef("");
  const disposed = useRef(false);
  const busySearch = search?.status === "searching";
  const refresh = async (remote = false) => {
    setLoading(true); setNotice("");
    try {
      const result = await window.xiaoxiOfficialMaterials?.list({ refresh: remote });
      if (disposed.current) return;
      if (!result?.ok || !result.data) throw new Error(result?.error || "素材仓库暂不可用，请重试。");
      setCatalog(result.data);
    } catch (error) { if (!disposed.current) setNotice(error instanceof Error ? error.message : "读取素材失败，请重试。"); }
    finally { if (!disposed.current) setLoading(false); }
  };
  useEffect(() => {
    disposed.current = false;
    void refresh().then(() => { if (!disposed.current) void refresh(true); });
    const unsubscribe = window.xiaoxiOfficialMaterials?.onSearchUpdate((update) => {
      if (update.taskId === taskId.current) setSearch(update);
    });
    return () => { disposed.current = true; unsubscribe?.(); if (taskId.current) void window.xiaoxiOfficialMaterials?.cancelSearch(taskId.current); };
  }, []);
  useEffect(() => {
    if (!preview) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setPreview(null); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [preview]);
  const useMaterial = async (id: string) => {
    if (importing) return;
    setImporting(id); setNotice("");
    try {
      const result = await window.xiaoxiOfficialMaterials?.importMaterial(id);
      if (!result?.ok || !result.data?.assetIds.length) throw new Error(result?.error || "素材尚未准备好，请重试。");
      if (!disposed.current) onUseMaterial(result.data.assetIds);
    } catch (error) { if (!disposed.current) setNotice(error instanceof Error ? error.message : "添加素材失败，请重试。"); }
    finally { if (!disposed.current) setImporting(""); }
  };
  const showPreview = async (item: OfficialMaterial) => {
    const request = ++previewRequest.current;
    setPreview(item); setPreviewError(false); setPreparingPreview(!item.previewUrl);
    if (item.previewUrl) return;
    try {
      const result = await window.xiaoxiOfficialMaterials?.previewMaterial(item.id);
      if (!result?.ok || !result.data?.previewUrl) throw new Error('preview_unavailable');
      if (!disposed.current && request === previewRequest.current) setPreview(current => current?.id === item.id ? result.data! : current);
    } catch { if (!disposed.current && request === previewRequest.current) setPreviewError(true); }
    finally { if (!disposed.current && request === previewRequest.current) setPreparingPreview(false); }
  };
  const openSource = async (url: string) => {
    try {
      const result = await window.xiaoxiOfficialMaterials?.openSource(url);
      if (!result?.ok) setNotice(result?.error || "链接暂时无法打开。");
    } catch { setNotice("链接暂时无法打开，请稍后重试。"); }
  };
  const startSearch = async () => {
    if (!prompt.trim() || busySearch) return;
    const value = prompt.trim();
    setSearchedPrompt(value); setQuery(""); setCategory(""); setVisible(24);
    const id = crypto.randomUUID(); taskId.current = id;
    setSearch({ taskId: id, status: "searching", round: 1, items: [], message: "正在寻找相关素材…" });
    try {
      const result = await window.xiaoxiOfficialMaterials?.search({ taskId: id, query: value, localOnly: !catalog?.searchEnabled });
      if (disposed.current || taskId.current !== id) return;
      if (!result?.ok || !result.data) throw new Error(result?.error || "查找失败，请重试。");
      setSearch((current) => current?.status !== "searching" && result.data?.status === "searching" ? current : result.data!);
    } catch (error) {
      if (!disposed.current && taskId.current === id) setSearch((current) => ({ taskId: id, round: current?.round || 1, items: current?.items || [], status: "failed", message: error instanceof Error ? error.message : "查找失败，请重试。" }));
    }
  };
  const cancelSearch = async () => {
    const id = taskId.current;
    try {
      const result = await window.xiaoxiOfficialMaterials?.cancelSearch(id);
      if (!result?.ok) throw new Error("暂时未能取消，请稍后重试。");
      if (taskId.current === id) { taskId.current = ""; setSearch((current) => current ? { ...current, status: "cancelled", message: "已停止查找，已找到的结果保留。" } : null); }
    } catch { setNotice("暂时未能取消，请稍后重试。"); }
  };
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const items = (catalog?.items || []).filter((item) => (!category || item.category === category) && (!words.length || words.some((word) => `${item.title} ${item.description}`.toLocaleLowerCase().includes(word))));
  const results = search?.items || [];
  return <section className="page official-materials-page" style={appearanceStyle(appearance, true)}>
    <header className="official-materials-head">
      <div><h1>物保素材库</h1><p>我们为你准备的行业图片与视频。自己的素材请在线索视频混剪中管理。</p></div>
      <div className="official-materials-head-actions">
        <button type="button" className="secondary-button" onClick={() => window.dispatchEvent(new CustomEvent("xiaoxi:open-tutorials", { detail: { category: "materials" } }))}><PlayCircle size={18} />看操作演示</button>
        <button type="button" className="secondary-button" disabled={loading} onClick={() => void refresh(true)}><RefreshCw size={16} />{loading ? "正在读取" : "刷新素材"}</button>
      </div>
    </header>
    <div className="materials-assistant">
      <button type="button" className="materials-assistant-trigger" onClick={() => promptInput.current?.focus()} aria-label={`向${preference.name}描述想找的素材`}>
        <img src={portraitAsset(appearance)} alt="" />
      </button>
      <div className="materials-assistant-dialog">
        <div className="materials-assistant-title"><h2>{preference.name}</h2><button type="button" className="materials-assistant-personalize" onClick={onPersonalize}><Settings2 size={16} />形象与名字</button></div>
        <p>想找什么画面？告诉我场景或设备名称。</p>
        <p className="materials-assistant-hint" id="materials-search-scope">{catalog?.searchEnabled ? "先查官方素材，再查公开网页；网页结果仅供参考。" : "当前只查官方素材，联网查找尚未开放。"}</p>
        <form onSubmit={(event) => { event.preventDefault(); void startSearch(); }}><label className="sr-only" htmlFor="materials-prompt">描述想找的素材</label><input ref={promptInput} id="materials-prompt" aria-describedby="materials-search-scope" value={prompt} maxLength={300} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：工厂里的清洁机器人" /><button className="primary-button" disabled={!prompt.trim() || busySearch}><Search size={16} />{busySearch ? "正在查找" : searchedPrompt ? "继续查找" : "找素材"}</button>{busySearch && <button type="button" className="secondary-button" onClick={() => void cancelSearch()}>停止查找</button>}</form>
        {searchedPrompt && <p className="materials-search-query">你的需求：{searchedPrompt}</p>}
        {search && <p role="status">{search.message || (busySearch ? "正在寻找相关素材…" : search.status === "completed" ? "查找完成" : "查找已结束")}</p>}
      </div>
    </div>
    {notice && <p className="touch-notice" role="status">{notice}</p>}
    <div className="official-materials-toolbar"><div className="official-material-categories" aria-label="素材分类"><button aria-pressed={!category} onClick={() => { setCategory(""); setVisible(24); }}>全部</button>{catalog?.categories.map((item) => <button key={item.id} aria-pressed={category === item.id} onClick={() => { setCategory(item.id); setVisible(24); }}>{item.label}</button>)}</div><input aria-label="搜索仓库素材" placeholder="搜索仓库素材" value={query} onChange={(event) => { setQuery(event.target.value); setVisible(24); }} /></div>
    <h2 className="official-section-title">{searchedPrompt ? "仓库中的素材" : "行业素材"}<small>{items.length} 项</small></h2>
    <div className="official-material-grid">{items.slice(0, visible).map((item) => <article className="official-material" key={item.id}>
      <button className="official-material-cover" onClick={() => void showPreview(item)} aria-label={`预览${item.title}`}><img loading="lazy" src={item.thumbnailUrl} alt="" /><span>{item.kind === "video" ? "视频" : "图片"}</span></button>
      <div className="official-material-copy"><h3>{item.title}</h3><p>{item.description}</p><small>{item.license} · {item.author}</small><div><button className="primary-button" disabled={Boolean(importing)} onClick={() => void useMaterial(item.id)}>{importing === item.id ? "正在准备素材…" : "用于线索视频混剪"}</button><button className="official-source-link" onClick={() => void openSource(item.sourceUrl)}>来源<ExternalLink size={13} /></button></div></div>
    </article>)}</div>
    {!loading && !items.length && <p className="official-materials-empty">{query || category ? "没有找到匹配素材，换个关键词或分类试试。" : "素材暂未加载，请点击刷新重试。"}</p>}
    {items.length > visible && <button className="secondary-button" onClick={() => setVisible((value) => value + 24)}>显示更多素材</button>}
    {results.length > 0 && <section className="official-reference-results"><h2>查找到的相关内容</h2><p>参考网页可在原网站查看，使用前请确认素材的使用条件。</p>{results.map((item) => <article key={item.id}>{item.thumbnailUrl && <img loading="lazy" src={item.thumbnailUrl} alt="" />}<div><h3>{item.title}</h3><p>{item.description}</p><small>{item.source} · {item.usage === "usable" && item.materialId ? "可用于制作" : "参考链接"}</small></div>{item.usage === "usable" && item.materialId ? <button className="primary-button" disabled={Boolean(importing)} onClick={() => void useMaterial(item.materialId!)}>用于线索视频混剪</button> : <button className="secondary-button" onClick={() => void openSource(item.url)}>去原网站查看<ExternalLink size={14} /></button>}</article>)}</section>}
    {preview && <div className="official-preview-backdrop" onClick={() => setPreview(null)}><section className="official-preview" role="dialog" aria-modal="true" aria-label={preview.title} onClick={(event) => event.stopPropagation()}><header><h2>{preview.title}</h2><button autoFocus className="secondary-button" onClick={() => setPreview(null)} aria-label="关闭预览"><X size={20} /></button></header>{preparingPreview ? <p role="status">正在准备预览…</p> : previewError ? <p role="alert">暂时无法预览，可刷新素材后重试。</p> : preview.kind === "video" ? <video controls preload="metadata" src={preview.previewUrl || preview.thumbnailUrl} onError={() => setPreviewError(true)} /> : <img src={preview.previewUrl || preview.thumbnailUrl} alt={preview.title} onError={() => setPreviewError(true)} />}<p>{preview.description}</p><small>作者：{preview.author} · 使用条件：{preview.license}</small><footer><button className="secondary-button" onClick={() => void openSource(preview.sourceUrl)}>查看来源与使用条件<ExternalLink size={14} /></button><button className="primary-button" disabled={Boolean(importing)} onClick={() => void useMaterial(preview.id)}>{importing === preview.id ? "正在准备素材…" : "用于线索视频混剪"}</button></footer></section></div>}
  </section>;
}
