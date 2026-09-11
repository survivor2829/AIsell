import { Check, Eye, Film, FolderPlus, Images, Plus, X } from "lucide-react";
import { AssetThumb } from "./BatchAssets";
import type { Asset } from "./batch-studio-api";

export function BatchMaterialBoard({ assets, selected, onChange, onImport, onBrowse, onPreview }: {
  assets: Asset[]; selected: string[]; onChange: (ids: string[]) => void;
  onImport: (folder?: boolean) => void; onBrowse: () => void; onPreview: (asset: Asset) => void;
}) {
  const chosen = selected.map((id) => assets.find((asset) => asset.assetId === id)
    || { assetId: id, displayName: "素材暂不可用", mediaKind: "video" as const });
  const visibleLimit = selected.length > 5 ? 8 : 5;
  const visible = [...chosen, ...assets.filter((asset) => !selected.includes(asset.assetId))].slice(0, visibleLimit);
  return <section className="batch-material-board" aria-label="选择创作素材">
    <header><h2>用哪些素材？</h2><span>{selected.length ? `已选 ${selected.length} 个 · 卡片右上角可移除` : "点击图片勾选"}</span></header>
    {!visible.length ? <button type="button" className="batch-upload-empty" onClick={() => onImport()}>
      <Images size={56} strokeWidth={1.25} aria-hidden="true" /><strong>添加视频或图片</strong><span>从电脑选择素材</span>
    </button> : <div className="batch-visual-material-grid">
      {visible.map((asset) => {
        const checked = selected.includes(asset.assetId);
        return <article className={`batch-visual-material${checked ? " is-selected" : ""}`} key={asset.assetId}>
          <label>
            <input type="checkbox" checked={checked} aria-label={`选择素材 ${asset.displayName}`}
              onChange={() => onChange(checked ? selected.filter((id) => id !== asset.assetId) : [...selected, asset.assetId])} />
            <span className="batch-visual-material-image"><AssetThumb asset={asset} />
              <span className="batch-material-check" aria-hidden="true">{checked && <Check size={15} />}</span>
              <span className="batch-material-kind" aria-hidden="true">{asset.mediaKind === "video" ? <Film size={13} /> : <Images size={13} />}
                {asset.durationMs ? `${Math.round(asset.durationMs / 1000)}秒` : asset.mediaKind === "video" ? "视频" : "图片"}</span>
            </span>
            <span className="batch-material-name" title={asset.displayName}>{asset.displayName}</span>
          </label>
          {checked && <button className="batch-material-remove" type="button" aria-label={`从本次创作移除 ${asset.displayName}`} title="仅从本次创作移除，不删除素材仓库原文件" onClick={() => onChange(selected.filter((id) => id !== asset.assetId))}><X size={14} aria-hidden="true" /><span>移除</span></button>}
          <button className="batch-material-preview" type="button" aria-label={`预览 ${asset.displayName}`} onClick={() => onPreview(asset)}><Eye size={15} /></button>
        </article>;
      })}
      <button type="button" className="batch-upload-tile" onClick={() => onImport()}><Plus size={28} /><span>添加素材</span></button>
    </div>}
    <footer><button type="button" onClick={onBrowse}><Images size={15} />素材仓库{assets.length > 0 ? ` · ${assets.length}` : ""}</button>
      <button type="button" onClick={() => onImport(true)}><FolderPlus size={15} />导入文件夹</button>
      {selected.length > 8 && <span>还有 {selected.length - 8} 个已选素材，可在仓库中查看</span>}
    </footer>
  </section>;
}
