import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import "./customer-tools.css";

export function CustomerPanel({ title, description, onClose, children, footer }: {
  title: string; description?: string; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    return () => node?.close();
  }, []);
  return <dialog ref={dialog} className="customer-panel" aria-labelledby={heading}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
    }}>
    <header className="customer-panel-heading"><div><h2 id={heading}>{title}</h2>{description && <p>{description}</p>}</div>
      <button type="button" className="customer-icon-button" aria-label="关闭面板" onClick={onClose}><X size={20} /></button>
    </header>
    <div className="customer-panel-content">{children}</div>
    {footer && <footer className="customer-panel-footer">{footer}</footer>}
  </dialog>;
}
