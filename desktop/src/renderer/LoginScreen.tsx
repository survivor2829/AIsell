import { ArrowRight, Eye, EyeOff, KeyRound, ShieldCheck, Sparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import productBrand from "../../product-brand.json";
import { LoginStarfield } from "./LoginStarfield";
import "./LoginScreen.css";

type LicenseStatus = { authorized: boolean; licenseId?: string; expiresAt?: string; code?: string; error?: string };

export function LoginScreen({ license, onLogin }: { license: LicenseStatus | null; onLogin: (status: LicenseStatus) => void }) {
  const [code, setCode] = useState("");
  const [replaceSaved, setReplaceSaved] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saved = Boolean(license?.authorized) && !replaceSaved;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!saved && !code.trim()) { setError("请输入您获得的授权码"); return; }
    if (!window.xiaoxiLicenseAuth) { setError("当前版本未连接授权服务，请重启软件后重试"); return; }
    setBusy(true);
    setError("");
    try {
      const result = saved ? await window.xiaoxiLicenseAuth.status() : await window.xiaoxiLicenseAuth.activate(code);
      if (result.authorized) onLogin(result);
      else {
        setError(result.error || "授权已失效，请重新输入有效授权码");
        setReplaceSaved(true);
      }
    } catch {
      setError("暂时无法验证授权，请重试");
    } finally { setBusy(false); }
  }

  return <main className="signin-scene">
    <LoginStarfield />
    <div className="signin-layout">
      <header className="signin-masthead"><Sparkles className="signin-brand-icon" aria-hidden="true" />{productBrand.displayName}</header>
      <div className="signin-center">
        <section className="signin-panel" aria-labelledby="signin-title">
          <div className="signin-emblem" aria-hidden="true"><Sparkles strokeWidth={1.25} /></div>
          <h1 id="signin-title" className="signin-heading">让灵感，即刻启程</h1>
          <p className="signin-description">登录 AI 获客，开启今天的工作</p>
          {!license ? <p className="signin-loading" role="status">正在读取授权信息…</p> : <form className="signin-form" onSubmit={submit}>
            <label className="signin-field" htmlFor="signin-license">
              <span>{saved ? "已保存的授权" : "软件授权码"}</span>
              <div className="signin-input-wrap">
                <KeyRound size={17} aria-hidden="true" />
                <input id="signin-license" type={saved || revealed ? "text" : "password"} value={saved ? (license.licenseId || "已安全保存") : code}
                  onChange={event => { setCode(event.target.value); setError(""); }} readOnly={saved} disabled={busy}
                  placeholder="输入您的授权码" autoComplete="off" spellCheck={false} aria-invalid={Boolean(error || license.error)} aria-describedby={error || license.error ? "signin-error" : "signin-storage"} />
                {!saved && <button className="signin-reveal" type="button" onClick={() => setRevealed(value => !value)} aria-label={revealed ? "隐藏授权码" : "显示授权码"} aria-pressed={revealed} disabled={busy}>{revealed ? <EyeOff size={17} /> : <Eye size={17} />}</button>}
              </div>
            </label>
            <div className="signin-options"><span id="signin-storage">{saved ? "已记住授权，点击即可登录" : "验证后将在本机安全记住授权"}</span>
              {saved && <button type="button" className="signin-switch" disabled={busy} onClick={() => { setReplaceSaved(true); setError(""); }}>更换授权码</button>}
              {replaceSaved && license.authorized && <button type="button" className="signin-switch" disabled={busy} onClick={() => { setReplaceSaved(false); setError(""); }}>使用已存授权</button>}
            </div>
            {(error || license.error) && <p className="signin-error" id="signin-error" role="alert">{error || license.error}</p>}
            <button className="signin-submit" type="submit" disabled={busy} aria-busy={busy}>{busy ? "正在验证…" : "登录"}{!busy && <ArrowRight size={18} aria-hidden="true" />}</button>
          </form>}
          <p className="signin-help">如需获取或续期授权码，请联系管理员</p>
        </section>
      </div>
      <footer className="signin-footer"><span>移动鼠标，轻拨这片星云</span><span><ShieldCheck size={14} aria-hidden="true" />授权信息在本机加密保存</span></footer>
    </div>
  </main>;
}
