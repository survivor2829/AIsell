import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent } from "react";
import "./LoginScreen.css";
import { AGENT_ROLE_IDENTITIES, AGENT_ROLE_ORDER, ROLE_CATALOG, characterAsset, type AgentRoleKey } from "./role-appearance";

type LicenseStatus = { authorized: boolean; licenseId?: string; expiresAt?: string; code?: string; error?: string;
  mode?: "account" | "license"; phone?: string; displayName?: string; setupRequired?: boolean; mustChangePassword?: boolean; updateError?: string };
type AccountApi = {
  login: (payload: { phone: string; password: string }) => Promise<LicenseStatus>;
  update: (payload: { action: "setup" | "password"; phone?: string; password?: string; currentPassword?: string; newPassword?: string }) => Promise<LicenseStatus>;
  logout: () => Promise<LicenseStatus>;
};
const accountApi = () => (window as unknown as { xiaoxiAccount?: AccountApi }).xiaoxiAccount;
const maskPhone = (phone = "") => phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone;

function PasswordInput({ id, value, onChange, placeholder, disabled, autoComplete }: { id: string; value: string; onChange: (value: string) => void; placeholder: string; disabled: boolean; autoComplete: string }) {
  const [shown, setShown] = useState(false);
  return <div className="signin-input-wrap">
    <input id={id} type={shown ? "text" : "password"} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} disabled={disabled} autoComplete={autoComplete} spellCheck={false} />
    <button className="signin-reveal" type="button" onClick={() => setShown((current) => !current)} aria-label={shown ? "隐藏密码" : "显示密码"} aria-pressed={shown} disabled={disabled}>{shown ? <EyeOff size={18} /> : <Eye size={18} />}</button>
  </div>;
}

// 账号登录：记住的登录一点即进；手机号 + 密码；老授权首次设置账号，或管理员建的账号首次改密码。
function AccountForm({ status, onLogin, onStatus }: { status: LicenseStatus; onLogin: (status: LicenseStatus) => void; onStatus: (status: LicenseStatus) => void }) {
  const [phone, setPhone] = useState(status.phone || "");
  const [password, setPassword] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [switching, setSwitching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remembered = status.authorized && !switching;
  const setup = remembered && status.setupRequired;
  const change = remembered && !status.setupRequired && status.mustChangePassword;

  async function run(action: () => Promise<LicenseStatus>) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result = await action();
      onStatus(result);
      if (result.updateError || (!result.authorized && result.error)) { setError(result.updateError || result.error || ""); return; }
      if (result.authorized && !result.setupRequired && !result.mustChangePassword) onLogin(result);
      else { setSwitching(false); setPassword(""); }
    } catch { setError("暂时连不上服务器，请检查网络后重试。"); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const api = accountApi();
    if (!api) { setError("当前版本未连接账号服务，请重启软件后重试。"); return; }
    if (setup || change) {
      if (next !== confirm) { setError("两次输入的新密码不一样。"); return; }
      if (setup) return void run(() => api.update({ action: "setup", phone: phone.trim(), password: next }));
      return void run(() => api.update({ action: "password", currentPassword: current, newPassword: next }));
    }
    if (remembered) return onLogin(status);
    if (!/^1[3-9]\d{9}$/u.test(phone.trim())) { setError("请填写正确的 11 位手机号。"); return; }
    if (!password) { setError("请输入密码。"); return; }
    void run(() => api.login({ phone: phone.trim(), password }));
  }

  const shownError = error || (!status.authorized && status.error) || "";
  return <form className="signin-form" onSubmit={submit}>
    {setup && <p className="signin-note">欢迎使用新的账号登录。请设置你的手机号和密码，以后用它们登录；原来的授权码会停止使用，你的数据都会保留。</p>}
    {change && <p className="signin-note">这是管理员给你的初始密码。为了账号安全，请先改成只有你知道的密码。</p>}
    {remembered && !setup && !change ? <div className="signin-remembered">
      <span>已记住登录</span><strong>{maskPhone(status.phone) || status.displayName || "本机账号"}</strong>
      <button type="button" className="signin-switch" disabled={busy} onClick={() => { setSwitching(true); setError(""); }}>切换账号</button>
    </div> : <>
      {!change && <label className="signin-field" htmlFor="signin-phone"><span>手机号</span>
        <div className="signin-input-wrap"><input id="signin-phone" inputMode="numeric" maxLength={11} value={phone} onChange={(event) => { setPhone(event.target.value.replace(/\D/gu, "")); setError(""); }}
          placeholder="请输入手机号" autoComplete="username" disabled={busy} /></div></label>}
      {!setup && !change && <label className="signin-field" htmlFor="signin-password"><span>密码</span>
        <PasswordInput id="signin-password" value={password} onChange={(value) => { setPassword(value); setError(""); }} placeholder="请输入密码" disabled={busy} autoComplete="current-password" /></label>}
      {change && <label className="signin-field" htmlFor="signin-current"><span>当前密码（管理员给你的）</span>
        <PasswordInput id="signin-current" value={current} onChange={setCurrent} placeholder="请输入当前密码" disabled={busy} autoComplete="current-password" /></label>}
      {(setup || change) && <>
        <label className="signin-field" htmlFor="signin-next"><span>新密码</span>
          <PasswordInput id="signin-next" value={next} onChange={(value) => { setNext(value); setError(""); }} placeholder="8 位以上，包含字母和数字" disabled={busy} autoComplete="new-password" /></label>
        <label className="signin-field" htmlFor="signin-confirm"><span>再输入一次</span>
          <PasswordInput id="signin-confirm" value={confirm} onChange={(value) => { setConfirm(value); setError(""); }} placeholder="再输入一次新密码" disabled={busy} autoComplete="new-password" /></label>
      </>}
    </>}
    {shownError && <p className="signin-error" role="alert">{shownError}</p>}
    <button className="signin-submit" type="submit" disabled={busy} aria-busy={busy}>
      {busy ? "请稍候…" : setup ? "保存并进入" : change ? "修改密码并进入" : "登录"}{!busy && <ArrowRight size={20} aria-hidden="true" />}
    </button>
    {switching && status.authorized && <button type="button" className="signin-switch" onClick={() => { setSwitching(false); setError(""); }}>返回已记住的账号</button>}
  </form>;
}

// 登录页的「活人感」：一位 AI 员工站在页面里跟你打招呼，下面的头像点一下就换人。
// 人物是抠好的透明图（public/agent-characters/login/），直接融进背景，不放卡片。
const LINES: Record<AgentRoleKey, string[]> = {
  production: ["我是小影，负责短视频获客。", "素材交给我，选题、剪辑、配音、字幕和封面一次做好。", "今天也一起多拿几个客户。"],
  agent: ["我是小诚，负责微信拓客。", "精准触达、自动回复、朋友圈运营，我按计划替你去跑。", "客户回你消息，我第一时间告诉你。"],
  operations: ["我是小绘，负责产品详情图。", "一张产品图进来，整套详情页我帮你排好。", "想换风格，跟我说一声就行。"],
  business: ["我是小睿，负责精准获客。", "谁在问价、谁想要联系方式，我帮你从评论里找出来。", "找到的线索，点赞关注我也能帮你跟上。"],
  materials: ["我是小禾，管着物保素材库。", "现场照片、视频按场景分好类，做视频时随手就能用。", "素材越多，我做出来的片子越好看。"],
  tutorials: ["我是小丽，负责操作教程。", "哪一步不会用，随时叫我，三分钟带你上手。", "先看示例，再动手，不走弯路。"]
};
// Roles with a generated idle loop (login/<role>.mp4); the rest breathe as stills.
const VIDEO_ROLES = new Set<AgentRoleKey>([]);
const ROLE_KEY = "xiaoxi-login-presenter";

function greeting(hour = new Date().getHours()) {
  return hour < 6 ? "夜深了" : hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
}
function readRole(): AgentRoleKey {
  try { const saved = localStorage.getItem(ROLE_KEY) as AgentRoleKey | null; if (saved && AGENT_ROLE_ORDER.includes(saved)) return saved; } catch { /* Convenience only. */ }
  return "production";
}
// Low-end PCs and "reduce motion" get the still figure: no video decoding at startup.
function prefersStill() {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || (navigator.hardwareConcurrency || 8) <= 4 || (memory !== undefined && memory <= 4);
}

function useTyping(lines: string[]) {
  const [text, setText] = useState("");
  useEffect(() => {
    let line = 0, index = 0, pause = 0;
    setText("");
    const timer = window.setInterval(() => {
      if (pause > 0) { pause -= 1; return; }
      const current = lines[line % lines.length];
      if (index < current.length) { index += 1; setText(current.slice(0, index)); return; }
      line += 1; index = 0; pause = 28;
    }, 70);
    return () => window.clearInterval(timer);
  }, [lines]);
  return text;
}

export function LoginScreen({ license, onLogin, onStatus }: { license: LicenseStatus | null; onLogin: (status: LicenseStatus) => void; onStatus?: (status: LicenseStatus) => void }) {
  const [code, setCode] = useState("");
  const [replaceSaved, setReplaceSaved] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [role, setRole] = useState<AgentRoleKey>(readRole);
  const [still] = useState(prefersStill);
  const saved = Boolean(license?.authorized) && !replaceSaved;
  const identity = AGENT_ROLE_IDENTITIES[role];
  const line = useTyping(LINES[role]);
  const accent = ROLE_CATALOG[role].appearances[0].accent;
  const scene = useRef<HTMLElement>(null);
  const frame = useRef(0);
  useEffect(() => { window.xiaoxiStartup?.mark('login_visible'); }, []);
  useEffect(() => { if (license) window.xiaoxiStartup?.mark('login_interactive'); }, [license]);

  // Gentle parallax: the presenter follows the pointer by a few pixels.
  function follow(event: MouseEvent<HTMLElement>) {
    if (still || !scene.current) return;
    const { clientX, clientY, currentTarget } = event;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const box = currentTarget.getBoundingClientRect();
      scene.current?.style.setProperty("--signin-px", `${((clientX - box.left) / box.width - 0.5) * -12}px`);
      scene.current?.style.setProperty("--signin-py", `${((clientY - box.top) / box.height - 0.5) * -8}px`);
    });
  }

  function choose(next: AgentRoleKey) {
    setRole(next);
    try { localStorage.setItem(ROLE_KEY, next); } catch { /* Convenience only. */ }
  }

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

  const step = (index: number) => ({ "--step": index } as CSSProperties);
  return <main ref={scene} className={`signin-scene${still ? " is-still" : ""}`} style={{ "--signin-accent": accent } as CSSProperties} onMouseMove={follow}>
    <div className="signin-aurora" aria-hidden="true" /><div className="signin-grain" aria-hidden="true" />
    <section className="signin-stage" aria-label={`${identity.name}：${identity.responsibility}`}>
      <img className="signin-logo signin-rise" style={step(0)} src="./xilianhui-logo.jpg" alt="玺联惠" />
      <div className="signin-copy">
        <h1 className="signin-rise" style={step(1)}>{greeting()}，<br /><em>欢迎回来</em></h1>
        <p className="signin-line signin-rise" style={step(2)} aria-live="polite"><span>{line}</span><i aria-hidden="true" /></p>
        <p className="signin-role signin-rise" style={step(3)}><b>{identity.name}</b>{identity.responsibility} · 在线</p>
        <nav className="signin-crew signin-rise" style={step(4)} aria-label="选择出镜的 AI 员工">
          {AGENT_ROLE_ORDER.map((key) => <button key={key} type="button" className={key === role ? "is-active" : ""} aria-pressed={key === role}
            aria-label={`${AGENT_ROLE_IDENTITIES[key].name}，${AGENT_ROLE_IDENTITIES[key].responsibility}`} onClick={() => choose(key)}>
            <img src={characterAsset(`login/${key}.webp`)} alt="" />
            <span className="signin-card" aria-hidden="true"><b>{AGENT_ROLE_IDENTITIES[key].name}</b><small>{AGENT_ROLE_IDENTITIES[key].responsibility}</small></span>
          </button>)}
        </nav>
      </div>
      <figure className="signin-figure" key={role}>
        {VIDEO_ROLES.has(role) && !still
          ? <video src={characterAsset(`login/${role}.mp4`)} poster={characterAsset(`login/${role}.webp`)} autoPlay muted loop playsInline aria-hidden="true" />
          : <img className={still ? "" : "is-breathing"} src={characterAsset(`login/${role}.webp`)} alt="" aria-hidden="true" />}
      </figure>
    </section>
    <div className="signin-side">
    <section className="signin-panel signin-rise" style={step(5)} aria-labelledby="signin-title">
      <h2 id="signin-title">登录</h2>
      <p className="signin-sub">AI短视频获客 · 生素材 · 引客户 · 促成交</p>
      {!license ? <p className="signin-loading" role="status">正在读取登录信息…</p> : license.mode === "account"
        ? <AccountForm status={license} onLogin={onLogin} onStatus={onStatus || (() => {})} />
        : <form className="signin-form" onSubmit={submit}>
        <label className="signin-field" htmlFor="signin-license">
          <span>{saved ? "已保存的授权" : "软件授权码"}</span>
          <div className="signin-input-wrap">
            <input id="signin-license" type={!saved && revealed ? "text" : "password"} value={saved ? 'saved-license' : code}
              onChange={event => { setCode(event.target.value); setError(""); }} readOnly={saved} disabled={busy}
              placeholder="输入您的授权码" autoComplete="off" spellCheck={false} aria-invalid={Boolean(error || license.error)} aria-describedby={error || license.error ? "signin-error" : "signin-storage"} />
            {!saved && <button className="signin-reveal" type="button" onClick={() => setRevealed(value => !value)} aria-label={revealed ? "隐藏授权码" : "显示授权码"} aria-pressed={revealed} disabled={busy}>{revealed ? <EyeOff size={18} /> : <Eye size={18} />}</button>}
          </div>
        </label>
        <div className="signin-options"><span id="signin-storage">{saved ? "已记住授权，点击即可登录" : "验证后将在本机安全记住授权"}</span>
          {saved && <button type="button" className="signin-switch" disabled={busy} onClick={() => { setReplaceSaved(true); setError(""); }}>更换授权码</button>}
          {replaceSaved && license.authorized && <button type="button" className="signin-switch" disabled={busy} onClick={() => { setReplaceSaved(false); setError(""); }}>使用已存授权</button>}
        </div>
        {(error || license.error) && <p className="signin-error" id="signin-error" role="alert">{error || license.error}</p>}
        <button className="signin-submit" type="submit" disabled={busy} aria-busy={busy}>{busy ? "正在验证…" : "登录"}{!busy && <ArrowRight size={20} aria-hidden="true" />}</button>
      </form>}
      <p className="signin-help">{license?.mode === "account" ? "忘记密码或需要开通账号，请联系管理员" : "如需开通或续期，请联系管理员"} · 玺联惠会员超市出品</p>
    </section>
    </div>
  </main>;
}
