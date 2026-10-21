import { useEffect, useRef, useState } from "react";
import { X, ZoomIn } from "lucide-react";
import catalog from "../shared/product-detail-examples.json";

const categories = catalog.categories.filter(category => catalog.examples.some(example => example.category === category.id));
const asset = (name: string) => new URL(`./product-detail-examples/${name}`, document.baseURI).toString();

export function ProductDetailExamples({ requested, onOpened }: { requested?: boolean; onOpened?: () => void }) {
  const [category, setCategory] = useState(categories[0]?.id || "");
  const examples = catalog.examples.filter(example => example.category === category);
  const [selected, setSelected] = useState<typeof catalog.examples[number] | null>(null);
  const [zoom, setZoom] = useState(100);
  const [error, setError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (requested) { setSelected(examples[0] || null); onOpened?.(); } }, [requested, onOpened, category]);
  useEffect(() => {
    if (selected) { setZoom(100); setError(false); dialog.current?.showModal(); }
    else dialog.current?.close();
  }, [selected]);
  return <>
    <section className="detail-examples" aria-label="真实生成范例">
      <header className="detail-examples-head"><div><strong>看看生成效果</strong><span>点击范例，放大查看完整详情图</span></div><label>示例分类<select value={category} onChange={event => setCategory(event.target.value)}>{categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></header>
      <div className="detail-example-grid">{examples.map(example => <button type="button" key={example.id} onClick={() => setSelected(example)}>
        <img src={asset(example.thumbnail)} alt="" loading="lazy" />
        <span>{example.name}<small><ZoomIn size={13} />查看完整详情图</small></span>
      </button>)}</div>
      {!examples.length && <p>这个分类暂时没有示例，请选择其他分类。</p>}
    </section>
    <dialog ref={dialog} className="detail-example-dialog" onClose={() => setSelected(null)} aria-label={selected ? `${selected.name}生成范例` : "生成范例"}>
      <header><strong>{selected?.name} · 真实生成范例</strong><label>缩放 <input aria-label="范例缩放" type="range" min={50} max={200} step={25} value={zoom} onChange={event => setZoom(Number(event.target.value))} />{zoom}%</label><button type="button" aria-label="关闭范例" onClick={() => setSelected(null)}><X size={22} /></button></header>
      <div className="detail-example-scroll">{selected && (error ? <p role="alert">范例暂时无法打开，请关闭后重试。</p> : <img src={asset(selected.image)} alt={`${selected.name}完整产品详情图`} style={{ width: `${zoom}%` }} onError={() => setError(true)} />)}</div>
    </dialog>
  </>;
}
