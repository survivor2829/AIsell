import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent } from "react";
import "./LoginScreen.css";
import { AGENT_ROLE_IDENTITIES, AGENT_ROLE_ORDER, ROLE_CATALOG, characterAsset, type AgentRoleKey } from "./role-appearance";

type LicenseStatus = { authorized: boolean; licenseId?: string; expiresAt?: string; code?: string; error?: string };

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

export function LoginScreen({ license, onLogin }: { license: LicenseStatus | null; onLogin: (status: LicenseStatus) => void }) {
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
      {!license ? <p className="signin-loading" role="status">正在读取授权信息…</p> : <form className="signin-form" onSubmit={submit}>
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
      <p className="signin-help">如需开通或续期，请联系管理员 · 玺联惠会员超市出品</p>
    </section>
    </div>
  </main>;
}
