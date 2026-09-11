import { useEffect, useState } from "react";
import { Asset, Collection, assetUrl, callBatch } from "./batch-studio-api";
import "./BatchCreativePage.css";

export function AssetThumb({ asset }: { asset: Asset }) {
  const [broken, setBroken] = useState(false);
  return broken ? <span className="batch-thumb-fallback">{asset.mediaKind === "video" ? "视频" : "图片"}</span>
    : <img loading="lazy" src={assetUrl(asset.assetId)} alt="" onError={() => setBroken(true)} />;
}
export function AssetPreview({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const [error, setError] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return <div className="batch-modal-backdrop" onClick={onClose}><section role="dialog" aria-modal="true" aria-label={asset.displayName} className="batch-modal" onClick={(e) => e.stopPropagation()}>
    <header><h2>{asset.displayName}</h2><button autoFocus onClick={onClose}>关闭预览</button></header>
    {error ? <p role="alert">预览暂不可用，请检查原文件和媒体组件。首次视频预览需要生成兼容版本。</p>
      : asset.mediaKind === "video" ? <video controls autoPlay src={assetUrl(asset.assetId, "preview")} onError={() => setError(true)} />
        : <img src={assetUrl(asset.assetId, "preview")} alt={asset.displayName} onError={() => setError(true)} />}
  </section></div>;
}
export function AssetPicker({ assets, selected, onChange, onClose }: { assets: Asset[]; selected: string[]; onChange: (ids: string[]) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<Asset | null>(null);
  const [visible, setVisible] = useState(60);
  const filtered = assets.filter((a) => a.displayName.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="batch-modal-backdrop"><section role="dialog" aria-modal="true" aria-label="从素材仓库选择" className="batch-modal batch-picker">
    <header><h2>从素材仓库选择</h2><button autoFocus onClick={onClose}>完成选择（{selected.length}）</button></header>
    <input aria-label="搜索素材" placeholder="搜索素材名称" value={query} onChange={(e) => { setQuery(e.target.value); setVisible(60); }} />
    <div className="batch-asset-grid">{filtered.slice(0, visible).map((a) => <article className={`batch-asset ${selected.includes(a.assetId) ? "is-selected" : ""}`} key={a.assetId}>
      <button className="batch-preview-button" onClick={() => setPreview(a)} aria-label={`预览 ${a.displayName}`}><AssetThumb asset={a} /></button>
      <label><input type="checkbox" checked={selected.includes(a.assetId)} onChange={(e) => onChange(e.target.checked ? [...selected, a.assetId] : selected.filter((id) => id !== a.assetId))} />{a.displayName}</label>
    </article>)}</div>
    {!filtered.length && <p className="batch-empty">没有找到素材，请先添加文件。</p>}
    {filtered.length > visible && <button onClick={() => setVisible(visible + 60)}>显示更多</button>}
  </section>{preview && <AssetPreview asset={preview} onClose={() => setPreview(null)} />}</div>;
}

export function MaterialsCollectionsPage({ onCreate }: { onCreate: (ids: string[], collection?: Collection) => void }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionId, setCollectionId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [choosingMembers, setChoosingMembers] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Asset | null>(null);
  const [visible, setVisible] = useState(60);
  async function refresh() {
    const [library, sets] = await Promise.allSettled([
      window.xiaoxiContent?.library.list({ includeArchived: true, limit: 500 }),
      callBatch<{ collections: Collection[] }>("collections")
    ]);
    if (library.status === "rejected" || !library.value?.ok) {
      throw new Error(library.status === "rejected" ? library.reason?.message : library.value?.error || "读取素材失败");
    }
    const items = library.value.data?.items as Asset[] || [];
    setAssets(items);
    setSelected((ids) => ids.filter((id) => items.some((a) => a.assetId === id)));
    if (sets.status === "fulfilled") setCollections(sets.value.collections);
    else setNotice("素材已读取，但素材集暂不可用：" + (sets.reason?.message || "请稍后重试"));
  }
  async function removeAssets(ids: string[]) {
    await run(async () => {
      const removed = new Set<string>();
      const failed: string[] = [];
      for (const assetId of [...new Set(ids)]) {
        try {
          const result = await window.xiaoxiContent?.library.archive({ assetId });
          if (!result?.ok) throw new Error(result?.error || "移除失败");
          removed.add(assetId);
        } catch (e) { failed.push((e as Error).message); }
      }
      setAssets((items) => items.filter((a) => !removed.has(a.assetId)));
      setSelected((items) => items.filter((id) => !removed.has(id)));
      setPreview((a) => a && removed.has(a.assetId) ? null : a);
      setNotice(`已从素材仓库移除 ${removed.size} 个素材，本地原文件保留。${failed.length ? `另有 ${failed.length} 个未移除：${failed[0]}` : ""}`);
    });
  }
  async function restoreAssets(ids: string[]) {
    await run(async () => {
      const restored = new Set<string>();
      const failed: string[] = [];
      for (const assetId of [...new Set(ids)]) {
        try {
          const result = await window.xiaoxiContent?.library.restore({ assetId });
          if (!result?.ok) throw new Error(result?.error || "恢复失败");
          restored.add(assetId);
        } catch (e) { failed.push((e as Error).message); }
      }
      await refresh();
      setNotice("已恢复 " + restored.size + " 个素材" + (failed.length ? "，另有 " + failed.length + " 个失败：" + failed[0] : "。"));
    });
  }
  useEffect(() => { void refresh().catch((e) => setNotice(e.message)); }, []);
  async function run(action: () => Promise<void>) { setBusy(true); setNotice(""); try { await action(); } catch (e) { setNotice((e as Error).message); } finally { setBusy(false); } }
  const filtered = assets.filter((a) => (!collectionId || collections.find((c) => c.collection_id === collectionId)?.asset_ids.includes(a.assetId)) && a.displayName.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const savedCollection = collections.find((c) => c.collection_id === collectionId);
  const collection = savedCollection && { ...savedCollection, asset_ids: savedCollection.asset_ids.filter((id) => assets.some((a) => a.assetId === id)) };
  return <div className="page batch-page"><header className="batch-page-header"><div><h1>素材仓库</h1><p>把同一产品的图片、实拍视频和说明放在一起，反复用于创作。</p></div><button disabled={busy} className="batch-primary" onClick={() => void run(async () => {
    const r = await window.xiaoxiContent?.library.chooseFiles(); if (!r?.ok && r?.code !== "CONTENT_DIALOG_CANCELLED") throw new Error(r?.error); await refresh();
  })}>添加素材</button></header>
    {notice && <p role="status" className="batch-notice">{notice}</p>}
    <div className="batch-toolbar"><select aria-label="素材集" value={collectionId} onChange={(e) => { const c = collections.find((item) => item.collection_id === e.target.value); setCollectionId(e.target.value); setSelected([]); setName(c?.name || ""); setDescription(c?.description || ""); setVisible(60); }}><option value="">全部素材</option>{collections.map((c) => <option key={c.collection_id} value={c.collection_id}>{c.name}（{c.asset_ids.length}）</option>)}</select>
      <input aria-label="搜索素材" placeholder="搜索素材" value={query} onChange={(e) => { setQuery(e.target.value); setVisible(60); }} />
      <button onClick={() => { setEditing(true); if (!collectionId) { setName(""); setDescription(""); } }}> {collectionId ? "编辑素材集" : "保存为素材集"}</button>
      <button disabled={busy} onClick={() => void run(refresh)}>刷新</button>
    </div>
    {collection?.description && <p className="batch-context">{collection.description}</p>}
    {collection && <button disabled={busy} onClick={() => { setSelected(collection.asset_ids); setChoosingMembers(true); }}>添加或调整素材集成员</button>}
    {editing && <section className="batch-panel"><h2>{collectionId ? "编辑素材集" : "新建素材集"}</h2><label>名称<input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label><label>产品资料与创作目标<textarea value={description} maxLength={6000} onChange={(e) => setDescription(e.target.value)} placeholder="产品名称、已确认事实、推广目标。这里的说明会用于生成解说。" /></label><p>原文件保持原位，同一素材可属于多个素材集。{selected.length ? `本次加入 ${selected.length} 个已选素材。` : "保存已有素材引用。"}</p><div className="batch-toolbar"><button disabled={busy || !name.trim()} className="batch-primary" onClick={() => void run(async () => {
      const c = await callBatch<Collection>("save-collection", { ...(collectionId ? { collection_id: collectionId } : {}), name, description, asset_ids: collection ? collection.asset_ids : selected });
      await refresh(); setCollectionId(c.collection_id); setEditing(false); setNotice("素材集已保存。");
    })}>保存素材集</button><button onClick={() => setEditing(false)}>取消</button></div>
      {collection && <div className="batch-collection-members">{collection.asset_ids.map((id) => <button key={id} disabled={busy} onClick={() => void run(async () => { await callBatch("save-collection", { ...collection, asset_ids: collection.asset_ids.filter((v) => v !== id) }); await refresh(); })}>移出 {assets.find((a) => a.assetId === id)?.displayName || "素材"}</button>)}</div>}
    </section>}
    <div className="batch-toolbar"><label><input type="checkbox" checked={filtered.filter((a) => !a.archived).length > 0 && filtered.filter((a) => !a.archived).every((a) => selected.includes(a.assetId))} onChange={(e) => { const selectable = filtered.filter((a) => !a.archived).map((a) => a.assetId); setSelected(e.target.checked ? [...new Set([...selected, ...selectable])] : selected.filter((id) => !selectable.includes(id))); }} />全选当前结果</label><span>已选 {selected.length} 个</span><button disabled={!selected.length && !collection?.asset_ids.length} className="batch-primary" onClick={() => { const ids = (selected.length ? selected : collection?.asset_ids || []).filter((id) => !assets.some((a) => a.assetId === id && a.archived)); onCreate(ids, collection); }}>用于批量创作</button></div>
    <div className="batch-toolbar"><button disabled={busy || !selected.length} onClick={() => void removeAssets(selected)}>移除所选{selected.length ? `（${selected.length}）` : ""}</button><span className="batch-remove-hint">仅从素材仓库移除，不删除本地原文件。</span></div>
    <div className="batch-asset-grid">{filtered.slice(0, visible).map((a) => <article key={a.assetId} className={`batch-asset ${selected.includes(a.assetId) ? "is-selected" : ""}${a.archived ? " is-archived" : ""}`}><button className="batch-preview-button" onClick={() => setPreview(a)} aria-label={`预览 ${a.displayName}`}><AssetThumb asset={a} /></button><label><input type="checkbox" disabled={a.archived || !a.availableLocationCount} checked={selected.includes(a.assetId)} onChange={(e) => setSelected(e.target.checked ? [...selected, a.assetId] : selected.filter((id) => id !== a.assetId))} />{a.displayName}{a.archived ? (a.availableLocationCount ? "（已归档）" : "（原文件不可用）") : ""}</label>{a.archived ? (a.availableLocationCount ? <button className="batch-remove-asset" disabled={busy} onClick={() => void restoreAssets([a.assetId])}>恢复</button> : <span className="batch-remove-hint">请重新添加原文件</span>) : <button className="batch-remove-asset" disabled={busy} aria-label={`从素材仓库移除 ${a.displayName}`} onClick={() => void removeAssets([a.assetId])}>移除</button>}</article>)}</div>
    {!filtered.length && <div className="batch-empty">{query ? "没有找到匹配素材。" : "添加图片或实拍视频，开始积累你的内容素材。"}</div>}
    {filtered.length > visible && <button onClick={() => setVisible(visible + 60)}>显示更多素材</button>}
    {preview && <AssetPreview asset={preview} onClose={() => setPreview(null)} />}
    {choosingMembers && collection && <AssetPicker assets={assets} selected={selected} onChange={setSelected} onClose={() => { setChoosingMembers(false); void run(async () => { await callBatch("save-collection", { ...collection, asset_ids: selected }); await refresh(); setNotice("素材集成员已更新。"); }); }} />}
  </div>;
}
