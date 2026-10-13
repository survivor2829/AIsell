import { useEffect, useRef, useState } from "react";
import { X, ZoomIn } from "lucide-react";

const EXAMPLES = [
  { id: "bg1", name: "普渡 BG1" },
  { id: "s9", name: "毛驴快跑 S9" },
  { id: "cc1-pro", name: "普渡 CC1 Pro" }
];
const asset = (name: string) => new URL(`./product-detail-examples/${name}`, document.baseURI).toString();

export function ProductDetailExamples() {
  const [selected, setSelected] = useState<typeof EXAMPLES[number] | null>(null);
  const [zoom, setZoom] = useState(100);
  const [error, setError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (selected) { setZoom(100); setError(false); dialog.current?.showModal(); }
    else dialog.current?.close();
  }, [selected]);
  return <>
    <section className="detail-examples" aria-label="真实生成范例">
      <div><strong>看看生成效果</strong><span>点击范例放大查看</span></div>
      {EXAMPLES.map(example => <button type="button" key={example.id} onClick={() => setSelected(example)}>
        <img src={asset(`${example.id}-thumb.jpg`)} alt="" loading="lazy" />
        <span>{example.name}<small><ZoomIn size={13} />查看完整详情图</small></span>
      </button>)}
    </section>
    <dialog ref={dialog} className="detail-example-dialog" onClose={() => setSelected(null)} aria-label={selected ? `${selected.name}生成范例` : "生成范例"}>
      <header><strong>{selected?.name} · 真实生成范例</strong><label>缩放 <input aria-label="范例缩放" type="range" min={50} max={200} step={25} value={zoom} onChange={event => setZoom(Number(event.target.value))} />{zoom}%</label><button type="button" aria-label="关闭范例" onClick={() => setSelected(null)}><X size={22} /></button></header>
      <div className="detail-example-scroll">{selected && (error ? <p role="alert">范例暂时无法打开，请关闭后重试。</p> : <img src={asset(`${selected.id}.png`)} alt={`${selected.name}完整产品详情图`} style={{ width: `${zoom}%` }} onError={() => setError(true)} />)}</div>
    </dialog>
  </>;
}
