import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X, ZoomIn } from "lucide-react";
import catalog from "../shared/product-detail-examples.json";

type Example = typeof catalog.examples[number];
const categories = catalog.categories.filter(category => catalog.examples.some(example => example.category === category.id));
const inCategory = (id: string) => catalog.examples.filter(example => example.category === id);
const asset = (name: string) => new URL(`./product-detail-examples/${name}`, document.baseURI).toString();
// Two per category on the panel (8 at a glance); the viewer steps through the whole category.
const SHOWN_PER_CATEGORY = 2;

// Every category is shown side by side (user 2026-11-24): a customer sees at a glance that tools,
// consumables and accessories get detail pages too, not only equipment.
export function ProductDetailExamples({ requested, onOpened }: { requested?: boolean; onOpened?: () => void }) {
  const [selected, setSelected] = useState<Example | null>(null);
  const [zoom, setZoom] = useState(100);
  const [error, setError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const siblings = selected ? inCategory(selected.category) : [];
  const position = selected ? siblings.findIndex(example => example.id === selected.id) : -1;
  const step = (delta: number) => { if (siblings.length > 1) setSelected(siblings[(position + delta + siblings.length) % siblings.length]); };
  useEffect(() => { if (requested) { setSelected(catalog.examples[0] || null); onOpened?.(); } }, [requested, onOpened]);
  useEffect(() => {
    if (selected) { setZoom(100); setError(false); if (!dialog.current?.open) dialog.current?.showModal(); }
    else dialog.current?.close();
  }, [selected]);
  return <>
    <section className="detail-examples" aria-label="真实生成范例">
      <header className="detail-examples-head"><strong>看看生成效果</strong></header>
      <div className="detail-example-groups">{categories.map(category => <div className="detail-example-group" data-category={category.id} key={category.id} role="group" aria-label={category.name}>
        <h3>{category.name}</h3>
        {inCategory(category.id).slice(0, SHOWN_PER_CATEGORY).map(example => <button type="button" key={example.id} onClick={() => setSelected(example)} aria-label={`查看${example.name}完整详情图`}>
          <span className="detail-example-thumb"><img src={asset(example.thumbnail)} alt="" loading="lazy" /><ZoomIn size={18} aria-hidden="true" /></span>
          <span className="detail-example-name">{example.name}</span>
        </button>)}
      </div>)}</div>
    </section>
    <dialog ref={dialog} className="detail-example-dialog" onClose={() => setSelected(null)} onKeyDown={event => {
      // The zoom slider and the scrolled picture keep their own arrow keys.
      if (event.defaultPrevented || (event.target as HTMLElement).closest("input, textarea, select, .detail-example-scroll")) return;
      if (event.key === "ArrowLeft") step(-1); if (event.key === "ArrowRight") step(1);
    }} aria-label={selected ? `${selected.name}生成范例` : "生成范例"}>
      <header>
        {siblings.length > 1 && <span className="detail-example-stepper"><button type="button" aria-label="上一个范例" onClick={() => step(-1)}><ChevronLeft size={20} /></button><span>{position + 1} / {siblings.length}</span><button type="button" aria-label="下一个范例" onClick={() => step(1)}><ChevronRight size={20} /></button></span>}
        <strong>{selected?.name} · 真实生成范例</strong><label>缩放 <input aria-label="范例缩放" type="range" min={50} max={200} step={25} value={zoom} onChange={event => setZoom(Number(event.target.value))} />{zoom}%</label><button type="button" aria-label="关闭范例" onClick={() => setSelected(null)}><X size={22} /></button>
      </header>
      <div className="detail-example-scroll" key={selected?.id}>{selected && (error ? <p role="alert">范例暂时无法打开，请关闭后重试。</p> : <img src={asset(selected.image)} alt={`${selected.name}完整产品详情图`} style={{ width: `${zoom}%` }} onError={() => setError(true)} />)}</div>
    </dialog>
  </>;
}
