import { useEffect, useRef, useState } from "react";
import { Check, MessageCircle, Send, X } from "lucide-react";
import type { FeedbackContext } from "./FeedbackCenter";
import "./feedback-quick.css";

// Each page's logs are kept under a module name; the feedback carries the page and the logs of its module.
const PAGE_MODULES: Record<string, string> = {
  touch: "active_touch", reply: "auto_reply", moments: "moments", "contact-sync": "contact_sync", workflow: "wechat_workflow",
  workspace: "content_engine", "ai-video": "content_engine", "product-video": "content_engine", finished: "content_engine",
  publish: "social_publish", "product-detail": "product_detail", "keyword-acquisition": "social_acquisition"
};
const CATEGORIES: [string, string][] = [["problem", "遇到问题"], ["suggestion", "功能建议"], ["experience", "体验吐槽"]];
type Draft = { id: string; text: string; category: string; includeDiagnostics: boolean; visibility: "public" | "private"; context: FeedbackContext | null };

// 吐槽 from any page without leaving it (user decision 2026-10-29): the shared draft gets this page as its
// context, and the submission goes the same way as in 吐槽中心.
export function FeedbackQuickDialog({ page, pageTitle, onClose, onOpenCenter }: { page: string; pageTitle: string; onClose: () => void; onOpenCenter: () => void }) {
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const api = window.xiaoxiFeedback;
    if (!api) { setError("当前版本未连接反馈功能，请重新打开软件后重试。"); return; }
    void api.status().then((result) => {
      if (!result.ok || !result.data) throw new Error(result.error || "读取反馈草稿失败");
      const context = { module: PAGE_MODULES[page] || page, page, label: pageTitle };
      setDraft({ ...(result.data.draft as Draft), context });
      setTimeout(() => textRef.current?.focus(), 0);
    }).catch((reason) => setError(String(reason?.message || reason)));
  }, [page, pageTitle]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const edit = (patch: Partial<Draft>) => setDraft((current) => current && { ...current, ...patch });
  async function submit() {
    if (!draft || !window.xiaoxiFeedback || busy || !draft.text.trim()) return;
    setBusy(true); setError("");
    try {
      const result = await window.xiaoxiFeedback.submit(draft);
      if (!result.ok) throw new Error(result.error || "提交暂未完成，内容已保存在本机。");
      setSent(true);
    } catch (reason) { setError(String((reason as Error)?.message || reason)); }
    finally { setBusy(false); }
  }
  return <div className="fbq-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="fbq" role="dialog" aria-modal="true" aria-labelledby="fbq-title">
      <header><h2 id="fbq-title"><MessageCircle size={22} />吐槽一下</h2><span>来自：{pageTitle}</span>
        <button type="button" className="fbq-close" aria-label="关闭" onClick={onClose}><X size={20} /></button></header>
      {sent ? <div className="fbq-done"><Check size={40} /><h3>收到了，谢谢！</h3><p>处理进度可以在「吐槽中心 → 我的反馈」里看。</p>
        <div className="fbq-actions"><button type="button" className="secondary-button" onClick={onOpenCenter}>去吐槽中心看看</button><button type="button" className="primary-button" onClick={onClose}>继续干活</button></div></div>
        : <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="fbq-chips" role="radiogroup" aria-label="反馈类型">{CATEGORIES.map(([value, label]) => <button type="button" role="radio" key={value} aria-checked={draft?.category === value}
            className={draft?.category === value ? "is-on" : ""} disabled={!draft || busy} onClick={() => edit({ category: value })}>{label}</button>)}</div>
          <textarea ref={textRef} value={draft?.text || ""} disabled={!draft || busy} placeholder="哪里不好用？发生了什么？你希望怎么改？" maxLength={2000}
            onChange={(event) => edit({ text: Array.from(event.target.value).slice(0, 2000).join("") })} />
          <div className="fbq-options">
            <label><input type="checkbox" checked={draft?.includeDiagnostics ?? true} disabled={!draft || busy} onChange={(event) => edit({ includeDiagnostics: event.target.checked })} />附带这个页面的近期诊断（不含聊天、联系人、截图）</label>
            <label><input type="checkbox" checked={draft?.visibility === "private"} disabled={!draft || busy} onChange={(event) => edit({ visibility: event.target.checked ? "private" : "public" })} />仅开发者可见</label>
          </div>
          {error && <p className="fbq-error" role="alert">{error}</p>}
          <div className="fbq-actions"><span>{Array.from(draft?.text || "").length} / 2000</span>
            <button type="submit" className="primary-button" disabled={!draft || busy || !draft.text.trim()}><Send size={16} />{busy ? "正在提交…" : "提交"}</button></div>
        </form>}
    </div>
  </div>;
}
