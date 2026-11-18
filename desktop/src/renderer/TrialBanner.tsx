import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import "./TrialBanner.css";

// 免费体验 (user decision 2026-11-18): a slim line on every page says this is the trial, and when a
// feature is asked for the advisor's WeChat comes up instead of an error.
type TrialApi = { onTrialBlocked?: (callback: () => void) => () => void; logout?: () => Promise<unknown> };
const trialApi = () => (window as unknown as { xiaoxiAccount?: TrialApi }).xiaoxiAccount;

function AdvisorCard({ onClose }: { onClose: () => void }) {
  return <div className="trial-modal-backdrop" role="presentation" onClick={onClose}>
    <section className="trial-modal" role="dialog" aria-modal="true" aria-label="开通正式账号" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="trial-modal-close" aria-label="关闭" onClick={onClose}><X size={18} /></button>
      <h2>这个功能开通后就能用</h2>
      <p>现在是<b>体验账号</b>，可以随便看示例效果。想真正用起来，扫码加顾问微信开通正式账号。</p>
      <img src="./trial/advisor-qr.jpg" alt="顾问微信二维码" width={188} height={188} />
      <span className="trial-modal-note">开通后用手机号登录，所有功能都能用</span>
      <button type="button" className="trial-modal-ok" onClick={onClose}>先继续看看</button>
    </section>
  </div>;
}

export function TrialBanner({ onSignOut }: { onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => trialApi()?.onTrialBlocked?.(() => setOpen(true)), []);
  return <>
    <div className="trial-banner" role="status">
      <Sparkles size={16} aria-hidden="true" />
      <span><b>体验模式</b>：可以看所有示例效果，开通正式账号后能用全部功能。</span>
      <button type="button" onClick={() => setOpen(true)}>开通正式账号</button>
      <button type="button" className="trial-banner-quiet" onClick={onSignOut}>用账号登录</button>
    </div>
    {open && <AdvisorCard onClose={() => setOpen(false)} />}
  </>;
}
