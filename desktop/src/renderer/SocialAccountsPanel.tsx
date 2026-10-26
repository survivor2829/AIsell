import { useEffect, useState } from "react";
import { Check, LogIn, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { SocialAccount, SocialAccountsResult, SocialAccountsState, SocialPlatformKey } from "./social-accounts-types";
import { PlatformIcon } from "./PlatformIcon";
import "./SocialAccountsPanel.css";

const statusLabel: Record<SocialAccount["status"], string> = { active: "已登录", expired: "登录已失效", login_required: "待扫码登录" };

export function SocialAccountsPanel() {
  const api = window.xiaoxiSocialAccounts;
  const [state, setState] = useState<SocialAccountsState>();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [labels, setLabels] = useState<Partial<Record<SocialPlatformKey, string>>>({});

  useEffect(() => {
    if (!api) { setError("平台账号服务尚未连接，请重新打开桌面应用。"); return; }
    let active = true;
    const unsubscribe = api.onUpdate((next) => { if (active) setState(next); });
    void api.status().then((result) => { if (!active) return; if (result.state) setState(result.state); if (!result.ok) setError(result.error || "账号读取失败。"); })
      .catch(() => { if (active) setError("账号读取失败，请重新打开页面。"); });
    return () => { active = false; unsubscribe(); };
  }, [api]);

  const run = async (key: string, operation: () => Promise<SocialAccountsResult>, success = "") => {
    setPending(key); setError(""); setNotice("");
    try {
      const result = await operation();
      if (result.state) setState(result.state);
      if (!result.ok) { setError(result.error || "操作未完成，请稍后重试。"); return false; }
      if (success) setNotice(success);
      return true;
    } catch { setError("操作未完成，请稍后重试。"); return false; }
    finally { setPending(""); }
  };
  const remove = (account: SocialAccount) => {
    if (!api || !window.confirm(`删除「${account.label}」？会同时退出这台电脑上该账号的登录。`)) return;
    void run(`remove-${account.id}`, () => api.remove(account.id), "账号已删除。");
  };

  return <div className="social-accounts">
    <div className="social-accounts-head">
      <p>每个账号用 Chrome 单独登录、互不影响。软件不保存密码、验证码或登录凭据，登录状态只留在这台电脑上。</p>
      <button type="button" className="secondary-button" disabled={!api || Boolean(pending)} onClick={() => api && void run("refresh", () => api.refresh(), "已刷新登录状态。")}><RefreshCw size={15} />刷新状态</button>
    </div>
    {state && !state.browserReady && <div className="social-feedback is-error" role="alert">没有找到 Chrome 或 Edge 浏览器。请先安装 Chrome，再回来登录平台账号。</div>}
    {(error || notice) && <div className={`social-feedback ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>{!error && <Check size={16} />}{error || notice}</div>}
    <div className="social-platforms">
      {(state?.platforms || []).map((platform) => {
        const accounts = state?.accounts.filter((account) => account.platform === platform.key) || [];
        return <section className="social-platform" key={platform.key} aria-labelledby={`social-${platform.key}`}>
          <h2 id={`social-${platform.key}`}><span className="social-platform-name"><PlatformIcon platform={platform.key} size={30} />{platform.name}</span><span>{accounts.length} 个账号</span></h2>
          {accounts.length === 0 && <p className="social-empty">还没有添加{platform.name}账号。</p>}
          <ul>
            {accounts.map((account) => <li key={account.id}>
              <span className={`social-dot is-${account.status}`} aria-hidden="true" />
              <div className="social-account-copy"><strong>{account.label}</strong><small>{account.loggingIn ? "Chrome 登录窗口已打开，请扫码" : statusLabel[account.status]}</small></div>
              <button type="button" className="social-text-button" disabled={!api || Boolean(pending)} onClick={() => api && void run(`login-${account.id}`, () => api.login(account.id))}><LogIn size={14} />{account.status === "active" ? "打开" : "登录"}</button>
              <button type="button" className="social-text-button is-danger" aria-label={`删除 ${account.label}`} disabled={!api || Boolean(pending)} onClick={() => remove(account)}><Trash2 size={14} /></button>
            </li>)}
          </ul>
          <form className="social-add" onSubmit={(event) => { event.preventDefault(); if (api) void run(`add-${platform.key}`, () => api.add(platform.key, labels[platform.key] || ""), "已在 Chrome 中打开登录页，扫码后会自动关闭。").then((ok) => { if (ok) setLabels({ ...labels, [platform.key]: "" }); }); }}>
            <input aria-label={`${platform.name}账号备注名`} value={labels[platform.key] || ""} maxLength={30} placeholder="备注名（选填）" onChange={(event) => setLabels({ ...labels, [platform.key]: event.target.value })} />
            <button type="submit" className="secondary-button" disabled={!api || Boolean(pending)}><Plus size={15} />添加账号</button>
          </form>
        </section>;
      })}
    </div>
  </div>;
}
