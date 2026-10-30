import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, CircleX, RefreshCw, Stethoscope } from "lucide-react";
import { CustomerPanel } from "./CustomerPanel";

type CheckupItem = { id: string; label: string; status: "ok" | "warn" | "fail"; detail: string; fix: string };
type CheckupResult = { at: string; items: CheckupItem[]; problems: number };
declare global { interface Window { xiaoxiCheckup?: { run: () => Promise<CheckupResult | null>; last: () => Promise<CheckupResult | null> } } }

const ICONS = { ok: CircleCheck, warn: CircleAlert, fail: CircleX };

// 一键体检 (user decision 2026-10-30): the top-bar button, and the first launch on a computer opens it
// by itself so a customer learns what is missing before a task fails on it.
export function CheckupButton() {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<CheckupResult | null>(null);
  const [running, setRunning] = useState(false);
  const run = async () => {
    const api = window.xiaoxiCheckup;
    if (!api || running) return;
    setRunning(true);
    try { setResult(await api.run()); } catch { /* The panel keeps the last result. */ }
    finally { setRunning(false); }
  };
  useEffect(() => {
    const api = window.xiaoxiCheckup;
    if (!api) return;
    void api.last().then((last) => {
      if (last) { setResult(last); return; }
      setOpen(true); void run();
    }).catch(() => undefined);
  }, []);
  const problems = result?.problems || 0;
  return <>
    <button type="button" className="topbar-tool" title="一键体检" aria-label={`一键体检${problems ? `，${problems} 项需要处理` : ""}`} onClick={() => { setOpen(true); void run(); }}>
      <Stethoscope size={17} /><span>一键体检</span>{problems > 0 && <span className="topbar-unread" aria-hidden="true" />}
    </button>
    {open && <CustomerPanel title="一键体检" description="检查这台电脑上各项功能需要的条件，有问题会告诉你怎么改。" onClose={() => setOpen(false)}
      footer={<button type="button" className="primary-button" disabled={running} onClick={() => void run()}><RefreshCw size={15} />{running ? "正在检查…" : "重新检查"}</button>}>
      {!result ? <p className="customer-empty">{running ? "正在检查，大约需要几秒…" : "还没有检查过。"}</p> : <>
        <p className={`checkup-summary${problems ? " has-problems" : ""}`} role="status">{problems ? `有 ${problems} 项需要处理，处理好后点「重新检查」。` : "全部正常，各项功能都可以使用。"}</p>
        <ul className="checkup-list">{result.items.map((item) => {
          const Icon = ICONS[item.status] || CircleAlert;
          return <li key={item.id} className={`is-${item.status}`}>
            <Icon size={20} aria-hidden="true" />
            <div><strong>{item.label}</strong><p>{item.detail}</p>{item.fix && <p className="checkup-fix">怎么改：{item.fix}</p>}</div>
          </li>;
        })}</ul>
        <p className="customer-field-hint">检查时间：{new Date(result.at).toLocaleString("zh-CN", { hour12: false })}。有问题的结果会自动发给技术支持。</p>
      </>}
    </CustomerPanel>}
  </>;
}
