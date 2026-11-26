import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, ExternalLink, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import type { GeoAccount, GeoBrand, GeoPublication, GeoResult, GeoState } from "./geo-types";
import "./GeoPanel.css";

// GEO in the Apple-like layout the user chose (2026-11-26): one thing per screen on the first visit, then one home
// page — four rings for the four assistants, three numbers, the one thing to do today, and the customers' questions.
type Sheet = { kind: "plan" } | { kind: "article"; id: string } | { kind: "paste" } | { kind: "question"; id: string } | { kind: "inquiry" } | { kind: "accounts" } | { kind: "company" } | { kind: "records" };
type Look = { short: string; color: string };
type Run = (key: string, action: string, payload?: Record<string, unknown>, success?: string) => Promise<GeoResult | undefined>;
type Open = (sheet: Sheet) => void;
type Action = { label: string; onClick: () => void };
type Task = { title: string; desc: string; tone?: "live" | "warn"; progress?: number; primary?: Action; secondary?: Action };

const ENGINE_LOOK: Record<string, Look> = { doubao: { short: "豆", color: "#ff7a45" }, qianwen: { short: "千", color: "#7c5cff" }, deepseek: { short: "D", color: "#3b82f6" }, yuanbao: { short: "元", color: "#10b981" } };
const PLATFORM_LOOK: Record<string, Look> = { toutiao: { short: "头", color: "#f04142" }, baijiahao: { short: "百", color: "#2f6bff" }, sohu: { short: "搜", color: "#e8960c" }, zhihu: { short: "知", color: "#1772f6" } };
const GREY: Look = { short: "·", color: "#a1a1a6" };
const STATUS_TEXT: Record<GeoPublication["status"], string> = { scheduled: "按计划待发", queued: "马上发", running: "正在发", public: "已发出", reviewing: "平台审核中", failed: "没发出", unknown: "结果不明", cancelled: "已取消" };
const GROUPS = ["本地", "场景", "价格", "选购", "售后", "大词"];
const VIA = ["电话", "微信", "抖音私信", "上门", "其他"];
const FROM = ["豆包", "千问", "DeepSeek", "元宝", "抖音", "搜公司名", "其他", "不记得"];
const WEEKDAY = "日一二三四五六";
const pad = (value: number) => String(value).padStart(2, "0");
const dateOf = (iso?: string) => { const date = new Date(iso || ""); return Number.isNaN(date.getTime()) ? null : date; };
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
function dayName(iso?: string) {
  const date = dateOf(iso);
  if (!date) return "";
  const diff = Math.round((startOfDay(date) - startOfDay(new Date())) / 86_400_000);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === -1) return "昨天";
  return `${date.getMonth() + 1}月${date.getDate()}日 周${WEEKDAY[date.getDay()]}`;
}
const timeOf = (iso?: string) => { const date = dateOf(iso); return date ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : ""; };
const when = (iso?: string) => (iso && dateOf(iso) ? `${dayName(iso)} ${timeOf(iso)}` : "");
const percent = (part: number, whole: number) => (whole ? Math.round(part / whole * 100) : 0);
const progressOf = (state: GeoState) => (state.progress?.total ? percent(state.progress.done, state.progress.total) : 0);
const channelName = (state: GeoState, id: string) => state.channels.find((item) => item.id === id)?.name || id;
const engineName = (state: GeoState, id = "doubao") => state.engines.find((item) => item.id === id)?.name || id;
const accountsOf = (state: GeoState, platform: string) => state.accounts.accounts.filter((account) => account.platform === platform);
const publishingAccounts = (state: GeoState) => state.accounts.accounts.filter((account) => account.status === "active" && state.channels.some((item) => item.id === account.platform && item.available));
const aiReady = (state: GeoState) => state.engines.some((engine) => engine.available && accountsOf(state, engine.id).some((account) => account.status === "active"));
const sortedQuestions = (state: GeoState) => [...state.questions].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
const brandNames = (brand: GeoBrand) => [brand.name, ...brand.aliases].filter(Boolean);
const brandForm = (brand: GeoBrand) => ({ name: brand.name, services: brand.services, regions: brand.regions.join("、"), cases: brand.cases, aliases: brand.aliases.join("、"), restrictions: brand.restrictions });

function Mark({ look, dim }: { look: Look; dim?: boolean }) {
  return <span className={`ga-mark${dim ? " is-dim" : ""}`} style={{ "--c": look.color } as CSSProperties} aria-hidden="true">{look.short}</span>;
}
function Tag({ group }: { group: string }) {
  return <span className={`ga-tag${group === "大词" ? " is-big" : ""}`}>{group}</span>;
}
function highlight(text: string, names: string[]): ReactNode[] {
  const wanted = names.filter(Boolean).sort((a, b) => b.length - a.length);
  if (!wanted.length) return [text];
  const pattern = new RegExp(`(${wanted.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(pattern).map((part, index) => (wanted.some((name) => name.toLowerCase() === part.toLowerCase()) ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>));
}

export function GeoPanel() {
  const api = window.xiaoxiGeo;
  const [state, setState] = useState<GeoState>();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [step, setStep] = useState<1 | 2 | 3 | null>(null);
  const [skipped, setSkipped] = useState(false);

  useEffect(() => {
    if (!api) { setError("GEO 服务还没有连接，请重新打开软件。"); return; }
    let active = true;
    const off = api.onUpdate((next) => { if (active) setState(next); });
    void api.invoke("status").then((result) => { if (!active) return; if (result.state) setState(result.state); if (!result.ok) setError(result.error || "GEO 记录读取失败。"); });
    return () => { active = false; off(); };
  }, [api]);
  useEffect(() => { if (!toast) return undefined; const timer = window.setTimeout(() => setToast(""), 2800); return () => window.clearTimeout(timer); }, [toast]);
  const needed = !state ? null : !state.brand.name || !state.brand.services ? 1 : !state.questions.length ? 2 : !skipped && !state.visibilityRuns.length && !state.publications.length && !state.plan ? 3 : null;
  // The questions step stays until the user has looked at the list: AI suggestions arriving must not skip past it.
  useEffect(() => { if (needed === 2 && step === null) setStep(2); }, [needed, step]);
  useEffect(() => {
    if (!sheet) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setSheet(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet]);

  const run: Run = async (key, action, payload = {}, success = "") => {
    if (!api) return undefined;
    setPending(key); setError("");
    try {
      const result = await api.invoke(action, payload);
      if (result.state) setState(result.state);
      if (!result.ok) setError(result.error || "操作没有完成，请稍后再试。");
      else if (success) setToast(success);
      return result;
    } catch { setError("操作没有完成，请稍后再试。"); return undefined; }
    finally { setPending(""); }
  };
  // One tap on a platform: make its entry if there is none, then open its own sign-in window.
  const connect = async (platform: string) => {
    if (!state) return;
    let account = accountsOf(state, platform).find((item) => item.status !== "active");
    if (!account) {
      const added = await run(`add-${platform}`, "account-add", { platform });
      account = added?.ok ? added.state?.accounts.accounts.filter((item) => item.platform === platform && item.status !== "active").at(-1) : undefined;
    }
    if (account) await run(`login-${account.id}`, "account-login", { id: account.id }, "登录窗口打开了，扫码后会自动认出来。");
  };

  if (!state) return <div className="ga">{error ? <p className="ga-error" role="alert">{error}</p> : <p className="ga-muted">正在打开…</p>}</div>;
  const onboarding = step ?? needed;
  const busy = Boolean(pending) || Boolean(state.busy);
  return <div className="ga">
    {error && <div className="ga-error" role="alert"><span>{error}</span><button type="button" aria-label="关闭提示" onClick={() => setError("")}><X size={16} /></button></div>}
    {onboarding
      ? <Onboarding state={state} step={onboarding} reach={needed ?? 3} go={setStep} run={run} busy={busy} connect={connect} onSkip={() => { setSkipped(true); setStep(null); }} />
      : <Home state={state} run={run} busy={busy} open={setSheet} />}
    {sheet && createPortal(<div className="ga-portal"><SheetView key={JSON.stringify(sheet)} sheet={sheet} state={state} run={run} busy={busy} open={setSheet} close={() => setSheet(null)} connect={connect} /></div>, document.body)}
    {toast && <div className="ga-toast" role="status">{toast}</div>}
  </div>;
}

/* ---------- first visit: three steps ---------- */
function Steps({ step, reach, go }: { step: number; reach: number; go: (step: 1 | 2 | 3) => void }) {
  return <ol className="ga-steps" aria-label="开通步骤">{["公司", "问题", "扫码"].map((name, index) => {
    const number = (index + 1) as 1 | 2 | 3;
    return <li key={name}><button type="button" className={step === number ? "is-on" : step > number ? "is-done" : ""} aria-current={step === number ? "step" : undefined} disabled={number > reach} onClick={() => go(number)}><i>{step > number ? <Check size={13} /> : number}</i>{name}</button></li>;
  })}</ol>;
}
function Onboarding({ state, step, reach, go, run, busy, connect, onSkip }: { state: GeoState; step: 1 | 2 | 3; reach: number; go: (step: 1 | 2 | 3 | null) => void; run: Run; busy: boolean; connect: (platform: string) => Promise<void>; onSkip: () => void }) {
  const [form, setForm] = useState(() => brandForm(state.brand));
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  if (step === 1) return <section className="ga-ob">
    <Steps step={1} reach={reach} go={go} />
    <h1>你是做什么的？</h1>
    <p className="ga-lead">AI 只用你填的真实信息写内容，不会编。</p>
    <div className="ga-card ga-form">
      <label className="ga-field"><span>公司名</span><input value={form.name} placeholder="例如：成都洁美清洁设备" onChange={set("name")} /></label>
      <label className="ga-field"><span>卖什么，有什么特点</span><textarea rows={3} value={form.services} placeholder="例如：商用洗地机销售和租赁，成都市内可以上门演示，提供维修保养" onChange={set("services")} /></label>
      <label className="ga-field"><span>在哪做生意</span><input value={form.regions} placeholder="例如：成都、重庆" onChange={set("regions")} /></label>
      <details className="ga-more"><summary>更多（选填，写得越具体文章越有用）</summary>
        <label className="ga-field"><span>真实案例</span><textarea rows={3} value={form.cases} placeholder="例如：给某某物业提供过 10 台洗地机。没有就空着，AI 不会编。" onChange={set("cases")} /></label>
        <label className="ga-field"><span>公司的其他叫法</span><input value={form.aliases} placeholder="用顿号分开，用来认出 AI 有没有提到你" onChange={set("aliases")} /></label>
        <label className="ga-field"><span>文章里不能说的</span><textarea rows={2} value={form.restrictions} onChange={set("restrictions")} /></label>
      </details>
    </div>
    <button type="button" className="ga-btn" disabled={busy || !form.name.trim() || !form.services.trim()} onClick={() => void run("brand", "save-brand", form).then((result) => { if (result?.ok) go(2); })}>继续</button>
  </section>;
  if (step === 2) return <section className="ga-ob">
    <Steps step={2} reach={reach} go={go} />
    <h1>客户会这样问 AI。</h1>
    <p className="ga-lead">先从“地区 + 产品”这类容易赢的问题开始，“哪个牌子好”这种大词放到后面。</p>
    <div className="ga-card">
      {state.busy === "writing" ? <p className="ga-working"><i className="ga-live-dot" />AI 正在想，大约半分钟…</p>
        : !state.questions.length && <div className="ga-first"><button type="button" className="ga-btn" disabled={busy} onClick={() => void run("suggest", "suggest-questions", {}, "想好了，看看合不合适。")}><Sparkles size={17} />让 AI 帮我想</button><span>按你的生意列出客户最常问的问题</span></div>}
      {state.questions.length > 0 && <ul className="ga-qlist">{sortedQuestions(state).map((question) => <li key={question.id}><Tag group={question.group} /><span>{question.text}</span>
        <button type="button" className="ga-icon" aria-label={`删除问题：${question.text}`} disabled={busy} onClick={() => void run(`rq-${question.id}`, "remove-question", { id: question.id })}><Trash2 size={15} /></button></li>)}</ul>}
      <AddQuestion run={run} busy={busy} />
    </div>
    <div className="ga-center">
      <button type="button" className="ga-btn" disabled={busy || !state.questions.length} onClick={() => go(null)}>就用这些</button>
      {state.questions.length > 0 && <button type="button" className="ga-btn is-ghost" disabled={busy} onClick={() => void run("suggest", "suggest-questions", {}, "又想了几个。")}><Sparkles size={16} />再想几个</button>}
    </div>
  </section>;
  return <section className="ga-ob">
    <Steps step={3} reach={reach} go={go} />
    <h1>扫一下码，就能开始。</h1>
    <p className="ga-lead">哪个没登录，就先不发、不查那个平台，以后随时补。</p>
    <div className="ga-card">
      <p className="ga-label">要去问的 AI</p>
      <div className="ga-tiles">{state.engines.map((engine) => <AccountTile key={engine.id} look={ENGINE_LOOK[engine.id] || GREY} name={engine.name} accounts={accountsOf(state, engine.id)} available={engine.available} busy={busy} onConnect={() => void connect(engine.id)} />)}</div>
      <p className="ga-label">发文章的平台</p>
      <div className="ga-tiles">{state.channels.filter((channel) => channel.available).map((channel) => <AccountTile key={channel.id} look={PLATFORM_LOOK[channel.id] || GREY} name={channel.name} accounts={accountsOf(state, channel.id)} available busy={busy} onConnect={() => void connect(channel.id)} />)}</div>
    </div>
    <div className="ga-center">
      <button type="button" className="ga-btn" disabled={busy || !aiReady(state)} onClick={() => void run("check", "check-visibility", {}, "开始体检了，会弹出浏览器窗口去问 AI。").then((result) => { if (result?.ok) go(null); })}>开始体检</button>
      <button type="button" className="ga-btn is-ghost" onClick={onSkip}>先跳过</button>
    </div>
  </section>;
}
function AccountTile({ look, name, accounts, available, busy, onConnect }: { look: Look; name: string; accounts: GeoAccount[]; available: boolean; busy: boolean; onConnect: () => void }) {
  const active = accounts.find((account) => account.status === "active");
  const logging = accounts.some((account) => account.loggingIn);
  const label = !available ? "即将开放" : active ? `已登录 · ${active.label}` : logging ? "正在登录，扫码后自动认出" : "点这里扫码";
  return <button type="button" className={`ga-tile${active ? " is-on" : ""}${available ? "" : " is-off"}`} disabled={!available || busy || Boolean(active) || logging} onClick={onConnect}>
    <Mark look={look} dim={!available} /><b>{name}</b><span>{label}</span>
  </button>;
}
function AddQuestion({ run, busy }: { run: Run; busy: boolean }) {
  const [text, setText] = useState("");
  const add = () => void run("add-q", "add-questions", { text }).then((result) => { if (result?.ok) setText(""); });
  return <div className="ga-add"><input aria-label="自己加一个问题" value={text} placeholder="自己加一个，例如：成都哪里能租洗地机" onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && text.trim() && !busy) add(); }} />
    <button type="button" className="ga-btn is-quiet" disabled={busy || !text.trim()} onClick={add}><Plus size={16} />添加</button></div>;
}

/* ---------- home ---------- */
function headline(state: GeoState) {
  if (state.busy === "visibility") return "正在问 AI…";
  if (state.busy === "planning") return "正在写这一周的内容…";
  if (state.stats.inquiriesThisMonth > 0) return `这个月来了 ${state.stats.inquiriesThisMonth} 个询盘。`;
  if (!state.stats.asked) return "先看看 AI 现在推荐谁。";
  if (!state.stats.mentioned) return "AI 还没提到你，别着急。";
  return `最近 7 天，AI 提到你 ${state.stats.mentioned} 次。`;
}
function todayTask(state: GeoState, run: Run, open: Open): Task {
  const stop = { label: "停下", onClick: () => void run("stop", "stop") };
  const check = { label: "立即体检", onClick: () => void run("check", "check-visibility", {}, "开始体检了，会弹出浏览器窗口去问 AI。") };
  const done = state.progress?.done ?? 0, total = state.progress?.total ?? 0;
  if (state.busy === "planning") return { tone: "live", title: `正在写这一周的文章 ${done}/${total}`, desc: "每篇大约一分钟，可以先去做别的，写完我会提醒你。", progress: progressOf(state), secondary: stop };
  if (state.busy === "visibility") return { tone: "live", title: `正在问 AI ${done}/${total}`, desc: "会弹出浏览器窗口，请不要在窗口里操作。", progress: progressOf(state), secondary: stop };
  if (state.busy === "writing") return { tone: "live", title: "AI 正在写…", desc: "大约一分钟。" };
  if (state.busy === "publish") {
    const item = state.publications.find((row) => row.status === "running");
    return { tone: "live", title: item ? `正在发《${item.title}》` : "正在发文章", desc: item?.detail || "会弹出浏览器窗口，请不要在窗口里操作。", secondary: stop };
  }
  if (state.aiPending.length) return { tone: "warn", title: "上次 AI 没有等到结果", desc: `${state.aiPending[0].label}。为了不重复花钱，软件没有自动重试。`, primary: { label: "再试一次", onClick: () => void run("retry", "retry-ai", { id: state.aiPending[0].id }, "可以重新写了。") } };
  const unsure = state.publications.filter((row) => row.status === "unknown" || row.status === "reviewing");
  if (unsure.length) return { tone: "warn", title: `${unsure.length} 篇要你去平台看一眼`, desc: "点了发布但没等到平台确认。看一下发没发出，软件不会自己重发。", primary: { label: "去看看", onClick: () => open({ kind: "records" }) } };
  const scheduled = state.publications.filter((row) => row.status === "scheduled").sort((a, b) => Date.parse(a.dueAt || "") - Date.parse(b.dueAt || ""));
  if (state.pausedToday && scheduled.length) return { title: "今天的发布暂停了", desc: `还有 ${scheduled.length} 篇按计划待发，明天自动接着发。`, primary: { label: "现在继续", onClick: () => void run("resume", "resume-schedule", {}, "好的，接着发。") } };
  if (state.plan?.status === "ready") return { title: `这一周的 ${state.plan.items.length} 篇写好了`, desc: state.plan.message || "发到哪个平台、哪天发都排好了。过目一遍，没问题就全部确认。", primary: { label: "过目并确认", onClick: () => open({ kind: "plan" }) } };
  if (!aiReady(state)) return { title: "登录豆包，开始体检", desc: "扫一下码，软件就能去问 AI 有没有提到你。", primary: { label: "去扫码", onClick: () => open({ kind: "accounts" }) } };
  if (!state.visibilityRuns.some((row) => row.status === "completed")) return { title: "先做第一次体检", desc: `把 ${state.questions.length} 个问题在 AI 里问一遍，看看现在推荐谁、常看哪些网站。`, primary: check };
  if (!publishingAccounts(state).length) return { title: "登录一个发文章的平台", desc: "头条、知乎、百家号、搜狐号，登录一个就能开始发。", primary: { label: "去扫码", onClick: () => open({ kind: "accounts" }) } };
  if (!scheduled.length) return { title: "写这一周的内容", desc: state.plan?.status === "stopped" && state.plan.message ? `上次没写成：${state.plan.message}` : `AI 挑还没提到你的问题写 ${state.usage.weekSize} 篇左右，排到接下来 7 天。你确认之后才会发。`, primary: { label: "开始写", onClick: () => void run("plan", "plan-week", {}, "开始写了，写完会提醒你。") }, secondary: check };
  const next = scheduled[0];
  return { title: "今天不用做什么", desc: `还有 ${scheduled.length} 篇按计划待发，下一篇${when(next.dueAt)}发到${channelName(state, next.platform)}。软件开着就会自己发。`, primary: { label: "看计划", onClick: () => open({ kind: "plan" }) }, secondary: check };
}
function recentEvents(state: GeoState) {
  const out: { at: string; text: string }[] = [];
  for (const item of state.publications) {
    if (item.status === "public" && item.finishedAt) out.push({ at: item.finishedAt, text: `《${item.title}》发到了${channelName(state, item.platform)}` });
    else if ((item.status === "unknown" || item.status === "reviewing") && item.finishedAt) out.push({ at: item.finishedAt, text: `《${item.title}》在${channelName(state, item.platform)}结果不明` });
  }
  const seen = new Set<string>();
  for (const row of [...state.visibilityRuns].reverse()) {
    const engine = row.engine || "doubao";
    if (row.status !== "completed" || !row.mentioned || seen.has(engine)) continue;
    seen.add(engine);
    out.push({ at: row.finishedAt, text: `${engineName(state, engine)}${row.rank === "top" ? "把你排在第 1 位" : "提到了你"}：${row.question}` });
  }
  for (const item of state.inquiries) out.push({ at: item.at, text: `记了一个询盘：${item.via}，${item.from === "不记得" ? "客户不记得在哪看到的" : `客户说在${item.from}看到`}` });
  if (state.plan?.confirmedAt) out.push({ at: state.plan.confirmedAt, text: `确认了这一周的 ${state.plan.items.length} 篇` });
  return out.filter((item) => dateOf(item.at)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 5);
}
function Rings({ state, size }: { state: GeoState; size: number }) {
  const radius = [88, 74, 60, 46];
  const rate = state.stats.asked ? percent(state.stats.mentioned, state.stats.asked) : null;
  return <div className="ga-rings" style={{ width: size, height: size }} role="img" aria-label={rate === null ? "还没有体检结果" : `最近 7 天 AI 提到你 ${rate}%`}>
    <svg viewBox="0 0 200 200" width={size} height={size} aria-hidden="true">
      {state.engines.map((engine, index) => {
        const look = ENGINE_LOOK[engine.id] || GREY, row = state.stats.engines.find((item) => item.id === engine.id);
        const full = 2 * Math.PI * radius[index], share = row?.asked ? Math.min(1, row.mentioned / row.asked / 0.5) : 0;
        return <g key={engine.id}>
          <circle cx="100" cy="100" r={radius[index]} fill="none" stroke={look.color} strokeOpacity={engine.available ? 0.16 : 0.06} strokeWidth="11" />
          {share > 0 && <circle cx="100" cy="100" r={radius[index]} fill="none" stroke={look.color} strokeWidth="11" strokeLinecap="round" strokeDasharray={`${(full * share).toFixed(1)} ${full.toFixed(1)}`} transform="rotate(-90 100 100)" />}
        </g>;
      })}
    </svg>
    <div className="ga-rings-center"><b>{rate === null ? "—" : `${rate}%`}</b><span>AI 提到你</span></div>
  </div>;
}
function Trend({ trend }: { trend: (number | null)[] }) {
  const values = trend.filter((value): value is number => value !== null);
  if (!values.length) return <p className="ga-empty">体检几次以后，这里会画出每周的变化。</p>;
  const width = 360, height = 136, top = Math.max(40, Math.ceil(Math.max(...values) / 10) * 10);
  const x = (index: number) => 32 + index * (width - 52) / (trend.length - 1), y = (value: number) => height - 24 - value / top * (height - 46);
  const points = trend.flatMap((value, index) => (value === null ? [] : [[x(index), y(value)] as [number, number]]));
  const line = points.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" ");
  const last = points[points.length - 1], value = values[values.length - 1], right = last[0] > width - 70;
  return <svg className="ga-trend" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`每周 AI 提到你的比例，最近一周 ${value}%`}>
    {[top / 2, top].map((mark) => <g key={mark}><line x1="32" x2={width - 20} y1={y(mark)} y2={y(mark)} stroke="#efeff2" /><text x="0" y={y(mark) + 4}>{mark}%</text></g>)}
    <line x1="32" x2={width - 20} y1={height - 24} y2={height - 24} stroke="#e4e4e9" />
    {points.length > 1 && <><polygon points={`${points[0][0]},${height - 24} ${line} ${last[0]},${height - 24}`} fill="#e60000" fillOpacity="0.08" /><polyline points={line} fill="none" stroke="#e60000" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" /></>}
    <circle cx={last[0]} cy={last[1]} r="4.5" fill="#e60000" />
    <text className="tv" x={right ? last[0] - 8 : last[0] + 8} y={last[1] - 9} textAnchor={right ? "end" : "start"}>{value}%</text>
    <text x="32" y={height - 5}>12 周前</text><text x={width - 20} y={height - 5} textAnchor="end">这周</text>
  </svg>;
}
function Dots({ state, ranks }: { state: GeoState; ranks?: string[] }) {
  return <span className="ga-dots" aria-label={state.engines.map((engine, index) => `${engine.name}${ranks?.[index] === "top" ? "排第 1" : ranks?.[index] === "mention" ? "提到你" : ranks?.[index] === "none" ? "没提到" : "还没问"}`).join("，")}>
    {state.engines.map((engine, index) => <i key={engine.id} className={`${ranks?.[index] === "top" ? "is-top" : ranks?.[index] === "mention" ? "is-mention" : ""}${engine.available ? "" : " is-off"}`} style={{ "--c": (ENGINE_LOOK[engine.id] || GREY).color } as CSSProperties} />)}
  </span>;
}
function Home({ state, run, busy, open }: { state: GeoState; run: Run; busy: boolean; open: Open }) {
  const task = todayTask(state, run, open);
  const now = new Date();
  const events = recentEvents(state);
  const sources = state.stats.sources.slice(0, 3).map((item) => item.name).join("、");
  return <>
    <header className="ga-head">
      <div><p className="ga-eyebrow">{now.getMonth() + 1}月{now.getDate()}日 星期{WEEKDAY[now.getDay()]}</p><h1>{headline(state)}</h1></div>
      <nav className="ga-links" aria-label="GEO 设置"><button type="button" onClick={() => open({ kind: "company" })}>公司资料</button><button type="button" onClick={() => open({ kind: "accounts" })}>账号</button><button type="button" onClick={() => open({ kind: "records" })}>文章和发布</button></nav>
    </header>
    <div className="ga-hero">
      <section className="ga-card ga-ringcard" aria-label="四家 AI 提到你的比例">
        <Rings state={state} size={228} />
        <ul className="ga-legend">{state.engines.map((engine) => {
          const row = state.stats.engines.find((item) => item.id === engine.id);
          return <li key={engine.id} className={engine.available ? "" : "is-off"}><Mark look={ENGINE_LOOK[engine.id] || GREY} dim={!engine.available} /><span>{engine.name}</span>
            <b>{!engine.available ? "即将开放" : !row?.asked ? "还没查" : `${percent(row.mentioned, row.asked)}%`}</b></li>;
        })}</ul>
      </section>
      <div className="ga-stats">
        <section className="ga-card ga-stat"><span>AI 提到你</span><strong>{state.stats.mentioned}<small>次</small></strong><em>{state.stats.asked ? `最近 7 天问了 ${state.stats.asked} 次${state.stats.top ? `，${state.stats.top} 次排第 1` : ""}` : "还没体检"}</em></section>
        <section className="ga-card ga-stat"><span>AI 引用了你的文章</span><strong>{state.stats.cited}<small>篇</small></strong><em>{sources ? `AI 常看：${sources}` : "发出后几天开始"}</em></section>
        <section className="ga-card ga-stat"><span>本月询盘</span><strong>{state.stats.inquiriesThisMonth}<small>个</small></strong><button type="button" className="ga-link" onClick={() => open({ kind: "inquiry" })}>记一个询盘<ChevronRight size={15} /></button></section>
      </div>
    </div>
    <section className={`ga-card ga-today${task.tone === "warn" ? " is-warn" : ""}`} aria-live="polite">
      <div><b>{task.tone === "live" && <i className="ga-live-dot" />}{task.title}</b><p>{task.desc}</p>{task.progress !== undefined && <span className="ga-progress"><i style={{ width: `${task.progress}%` }} /></span>}</div>
      {(task.primary || task.secondary) && <div className="ga-today-actions">
        {task.secondary && <button type="button" className="ga-btn is-quiet" disabled={task.secondary.label === "停下" ? false : busy} onClick={task.secondary.onClick}>{task.secondary.label}</button>}
        {task.primary && <button type="button" className="ga-btn" disabled={busy} onClick={task.primary.onClick}>{task.primary.label}</button>}
      </div>}
    </section>
    <div className="ga-two">
      <section className="ga-card"><h3>AI 提到你的比例</h3><Trend trend={state.stats.trend} /></section>
      <section className="ga-card"><h3>最近</h3>{events.length ? <ul className="ga-recent">{events.map((item, index) => <li key={index}><span>{dayName(item.at)}</span><p>{item.text}</p></li>)}</ul> : <p className="ga-empty">发了文章、体检、记了询盘，都会出现在这里。</p>}</section>
    </div>
    <section className="ga-card">
      <div className="ga-card-head"><h3>客户问的问题</h3><span className="ga-dotlegend"><Dots state={{ ...state, engines: state.engines.slice(0, 1) }} ranks={["top"]} />排第 1 <Dots state={{ ...state, engines: state.engines.slice(0, 1) }} ranks={["mention"]} />提到你 · 每个点是一家 AI</span></div>
      <div className="ga-qrows">{sortedQuestions(state).map((question) => {
        const count = state.articles.filter((article) => article.questionId === question.id).length;
        return <button key={question.id} type="button" className="ga-qrow" onClick={() => open({ kind: "question", id: question.id })}>
          <Tag group={question.group} /><span className="ga-qtext">{question.text}</span><Dots state={state} ranks={state.stats.questions[question.id]} /><span className="ga-qcount">{count ? `${count} 篇` : ""}</span><ChevronRight size={16} aria-hidden="true" />
        </button>;
      })}</div>
      <AddQuestion run={run} busy={busy} />
    </section>
  </>;
}

/* ---------- sheets ---------- */
function SheetFrame({ title, close, children, footer, wide }: { title: string; close: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return <div className="ga-layer">
    <div className="ga-backdrop" onClick={close} />
    <div className={`ga-sheet${wide ? " is-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button type="button" className="ga-icon" aria-label="关闭" onClick={close}><X size={18} /></button></header>
      <div className="ga-sheet-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </div>
  </div>;
}
function SheetView(props: { sheet: Sheet; state: GeoState; run: Run; busy: boolean; open: Open; close: () => void; connect: (platform: string) => Promise<void> }) {
  const { sheet } = props;
  if (sheet.kind === "plan") return <PlanSheet {...props} />;
  if (sheet.kind === "article") return <ArticleSheet {...props} id={sheet.id} />;
  if (sheet.kind === "paste") return <PasteSheet {...props} />;
  if (sheet.kind === "question") return <QuestionSheet {...props} id={sheet.id} />;
  if (sheet.kind === "inquiry") return <InquirySheet {...props} />;
  if (sheet.kind === "accounts") return <AccountsSheet {...props} />;
  if (sheet.kind === "company") return <CompanySheet {...props} />;
  return <RecordsSheet {...props} />;
}
function PlanSheet({ state, run, busy, open, close }: { state: GeoState; run: Run; busy: boolean; open: Open; close: () => void }) {
  const plan = state.plan;
  if (!plan) return <SheetFrame title="这一周的内容" close={close}><p className="ga-muted">还没有计划。回到首页点“写这一周的内容”。</p></SheetFrame>;
  const accounts = publishingAccounts(state);
  const ready = plan.status === "ready", confirmed = plan.status === "confirmed";
  const confirmAll = () => {
    if (!window.confirm(`确认后，这 ${plan.items.length} 篇会在接下来几天按计划公开发到你的账号上，软件开着的时候才会发。\n\n发出后要删除，得到平台上自己删。`)) return;
    void run("confirm-plan", "confirm-plan", {}, "好的，按计划发。你什么都不用管。").then((result) => { if (result?.ok) close(); });
  };
  return <SheetFrame wide title={confirmed ? "这一周的发布计划" : `这一周的 ${plan.items.length} 篇`} close={close} footer={ready ? <>
    <button type="button" className="ga-btn is-quiet" disabled={busy} onClick={() => { if (window.confirm("放弃这一批？写好的文章还留在“文章和发布”里。")) void run("discard", "discard-plan", {}, "这一批放弃了。").then((result) => { if (result?.ok) close(); }); }}>放弃这一批</button>
    <button type="button" className="ga-btn" disabled={busy || !plan.items.length} onClick={confirmAll}>全部确认，按计划发</button>
  </> : undefined}>
    {plan.message && <p className="ga-note">{plan.message}</p>}
    {plan.status === "writing" && <p className="ga-working"><i className="ga-live-dot" />正在写 {state.progress?.done ?? plan.items.length}/{plan.total}，写完就能确认。</p>}
    {ready && <p className="ga-muted">点标题能看全文、改文字。改过的文章要在这里重新确认才会发。</p>}
    <ol className="ga-plan">{plan.items.map((item) => {
      const value = `${item.platform}|${item.accountId}`, listed = accounts.some((account) => `${account.platform}|${account.id}` === value);
      return <li key={item.id}>
        <span className="ga-plan-day">{dayName(item.due)}<small>{timeOf(item.due)}</small></span>
        <button type="button" className="ga-plan-title" onClick={() => open({ kind: "article", id: item.articleId })}><b>{item.title}</b><small>{item.question ? `回答：${item.question}` : "自己的文章"}</small></button>
        {ready ? <select aria-label="发到哪个账号" value={value} disabled={busy} onChange={(event) => { const [platform, accountId] = event.target.value.split("|"); void run(`acc-${item.id}`, "set-plan-item", { id: item.id, platform, accountId }); }}>
          {!listed && <option value={value}>{channelName(state, item.platform) || "还没选"} · {item.accountLabel || "账号没登录"}</option>}
          {accounts.map((account) => <option key={account.id} value={`${account.platform}|${account.id}`}>{channelName(state, account.platform)} · {account.label}</option>)}
        </select> : <span className="ga-plan-where"><Mark look={PLATFORM_LOOK[item.platform] || GREY} />{channelName(state, item.platform)} · {item.accountLabel}</span>}
        {ready && <button type="button" className="ga-icon" aria-label={`不要这一篇：${item.title}`} disabled={busy} onClick={() => void run(`rm-${item.id}`, "set-plan-item", { id: item.id, remove: true })}><Trash2 size={15} /></button>}
        {confirmed && <span className="ga-plan-end"><span className={`ga-pill is-${item.status || "none"}`}>{item.status ? STATUS_TEXT[item.status] : "没排上"}</span>
          {item.status === "scheduled" && <button type="button" className="ga-link" disabled={busy} onClick={() => void run(`cx-${item.id}`, "cancel-scheduled", { id: item.publicationId }, "这一篇不发了。")}>取消</button>}</span>}
      </li>;
    })}</ol>
  </SheetFrame>;
}
function ArticleSheet({ id, state, run, busy, close }: { id: string; state: GeoState; run: Run; busy: boolean; close: () => void }) {
  const article = state.articles.find((item) => item.id === id);
  const [title, setTitle] = useState(article?.title || "");
  const [body, setBody] = useState(article?.body || "");
  const [targets, setTargets] = useState<Set<string>>(new Set());
  if (!article) return <SheetFrame title="文章" close={close}><p className="ga-muted">这篇文章已经删了。</p></SheetFrame>;
  const changed = title !== article.title || body !== article.body;
  const publications = state.publications.filter((item) => item.articleId === id);
  const accounts = publishingAccounts(state);
  const toggle = (value: string) => { const next = new Set(targets); if (next.has(value)) next.delete(value); else next.add(value); setTargets(next); };
  const publish = () => {
    const chosen = [...targets];
    if (!chosen.length || !window.confirm(`确认发布？\n\n《${article.title}》会公开发到 ${chosen.length} 个账号。发出后如果要删除，要到平台上自己删。`)) return;
    void run("publish", "confirm-publish", { articleId: id, targets: chosen.map((value) => { const [platform, accountId] = value.split("|"); return { platform, accountId }; }) }, "开始发了，会弹出浏览器窗口，请不要在窗口里操作。").then((result) => { if (result?.ok) setTargets(new Set()); });
  };
  return <SheetFrame wide title="看全文、修改" close={close} footer={<>
    <button type="button" className="ga-btn is-quiet" disabled={busy} onClick={() => { if (window.confirm(`删除《${article.title}》？`)) void run("remove-article", "remove-article", { id }, "删掉了。").then((result) => { if (result?.ok) close(); }); }}><Trash2 size={15} />删除</button>
    <button type="button" className="ga-btn" disabled={busy || !changed || !title.trim() || !body.trim()} onClick={() => void run("save-article", "save-article", { id, title, body }, "改好了。改过的文章要重新确认才会发。")}>保存修改</button>
  </>}>
    {article.question && <p className="ga-muted">回答：{article.question}</p>}
    <label className="ga-field"><span>标题<small>{title.length} 字</small></span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label className="ga-field"><span>正文<small>{body.length} 字</small></span><textarea rows={14} value={body} onChange={(event) => setBody(event.target.value)} /></label>
    {publications.length > 0 && <ul className="ga-publist">{publications.map((item) => <li key={item.id}><Mark look={PLATFORM_LOOK[item.platform] || GREY} /><span>{channelName(state, item.platform)} · {item.accountLabel}</span><span className={`ga-pill is-${item.status}`}>{STATUS_TEXT[item.status]}</span><small>{item.status === "scheduled" ? `计划${when(item.dueAt)}` : when(item.finishedAt || item.confirmedAt)}</small></li>)}</ul>}
    {accounts.length > 0 && <details className="ga-more"><summary>单独发一次</summary>
      <div className="ga-checks">{accounts.map((account) => { const value = `${account.platform}|${account.id}`; return <label key={account.id} className="ga-check"><input type="checkbox" checked={targets.has(value)} onChange={() => toggle(value)} />{channelName(state, account.platform)} · {account.label}</label>; })}</div>
      <div><button type="button" className="ga-btn sm" disabled={busy || changed || !targets.size} onClick={publish}>{changed ? "先保存修改" : "确认发布"}</button></div>
    </details>}
  </SheetFrame>;
}
function PasteSheet({ run, busy, close }: { run: Run; busy: boolean; close: () => void }) {
  const [title, setTitle] = useState(""), [body, setBody] = useState("");
  return <SheetFrame wide title="加一篇自己的文章" close={close} footer={<button type="button" className="ga-btn" disabled={busy || !title.trim() || !body.trim()} onClick={() => void run("paste", "add-article", { title, body }, "保存好了。").then((result) => { if (result?.ok) close(); })}>保存</button>}>
    <label className="ga-field"><span>标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label className="ga-field"><span>正文<small>只发文字，图片不会带上</small></span><textarea rows={12} value={body} onChange={(event) => setBody(event.target.value)} /></label>
  </SheetFrame>;
}
function QuestionSheet({ id, state, run, busy, open, close }: { id: string; state: GeoState; run: Run; busy: boolean; open: Open; close: () => void }) {
  const question = state.questions.find((item) => item.id === id);
  if (!question) return <SheetFrame title="问题" close={close}><p className="ga-muted">这个问题已经删了。</p></SheetFrame>;
  const latest = (engine: string) => [...state.visibilityRuns].reverse().find((row) => row.questionId === id && (row.engine || "doubao") === engine && row.status === "completed");
  const articles = state.articles.filter((item) => item.questionId === id);
  return <SheetFrame wide title={question.text} close={close} footer={<>
    <button type="button" className="ga-btn is-quiet" disabled={busy} onClick={() => { if (window.confirm("删除这个问题？写过的文章会留着。")) void run("remove-question", "remove-question", { id }, "删掉了。").then((result) => { if (result?.ok) close(); }); }}><Trash2 size={15} />删除问题</button>
    <button type="button" className="ga-btn" disabled={busy} onClick={() => void run("write", "write-article", { questionId: id }, "写好了，在下面。")}><Pencil size={15} />{articles.length ? "再写一篇，换个角度" : "写一篇"}</button>
  </>}>
    <Tag group={question.group} />
    <div className="ga-answers">{state.engines.filter((engine) => engine.available).map((engine) => {
      const row = latest(engine.id);
      return <article key={engine.id} className="ga-answer">
        <header><Mark look={ENGINE_LOOK[engine.id] || GREY} /><b>{engine.name}</b>
          {row && <span className={`ga-rank is-${row.rank || "none"}`}>{row.rank === "top" ? "排第 1" : row.rank === "mention" ? "提到你" : "没提到"}</span>}{row && <small>{when(row.finishedAt)}</small>}</header>
        {row?.hits?.[0] ? <blockquote>…{highlight(row.hits[0].snippet, brandNames(state.brand))}…</blockquote> : <p className="ga-muted">{row ? "这次回答里没有你。" : "还没问过。"}</p>}
        {row?.references?.length ? <ul className="ga-refs">{row.references.slice(0, 6).map((ref, index) => <li key={index}><span>{ref.source || "网页"}</span><em>{ref.title || ref.url}</em>{ref.association === "confirmed" && <b className="ga-mine">你的</b>}</li>)}</ul> : null}
      </article>;
    })}</div>
    {state.engines.some((engine) => !engine.available) && <p className="ga-muted">{state.engines.filter((engine) => !engine.available).map((engine) => engine.name).join("、")}即将开放。</p>}
    <h4>你为这个问题写的文章</h4>
    {articles.length ? <ul className="ga-artlist">{articles.map((article) => <li key={article.id}><button type="button" onClick={() => open({ kind: "article", id: article.id })}><b>{article.title}</b><small>{article.body.length} 字 · {state.publications.filter((item) => item.articleId === article.id && item.status === "public").length ? "已发出" : "还没发"}</small></button></li>)}</ul> : <p className="ga-muted">还没写。</p>}
  </SheetFrame>;
}
function InquirySheet({ state, run, busy, close }: { state: GeoState; run: Run; busy: boolean; close: () => void }) {
  const [via, setVia] = useState("电话"), [from, setFrom] = useState("豆包"), [note, setNote] = useState("");
  const first = new Date(); const monthStart = new Date(first.getFullYear(), first.getMonth(), 1).getTime();
  const month = state.inquiries.filter((item) => Date.parse(item.at) >= monthStart).reverse();
  const choose = (label: string, options: string[], value: string, set: (value: string) => void) => <div className="ga-field"><span>{label}</span><div className="ga-options" role="group" aria-label={label}>{options.map((option) => <button key={option} type="button" className="ga-option" aria-pressed={value === option} onClick={() => set(option)}>{option}</button>)}</div></div>;
  return <SheetFrame title="记一个询盘" close={close} footer={<button type="button" className="ga-btn" disabled={busy} onClick={() => void run("inquiry", "add-inquiry", { via, from, note }, "记好了。").then((result) => { if (result?.ok) close(); })}>保存</button>}>
    {choose("客户怎么联系的", VIA, via, setVia)}
    {choose("客户说在哪看到我们的", FROM, from, setFrom)}
    <label className="ga-field"><span>客户问了什么（选填）</span><input value={note} placeholder="比如：想租两台，地库用" onChange={(event) => setNote(event.target.value)} /></label>
    {month.length > 0 && <><h4>这个月记了 {month.length} 个</h4><ul className="ga-inqlist">{month.slice(0, 8).map((item) => <li key={item.id}><span>{dayName(item.at)}</span><b>{item.via} · {item.from}</b><em>{item.note}</em>
      <button type="button" className="ga-icon" aria-label="删除这条询盘" disabled={busy} onClick={() => void run(`ri-${item.id}`, "remove-inquiry", { id: item.id })}><Trash2 size={14} /></button></li>)}</ul></>}
  </SheetFrame>;
}
function AccountsSheet({ state, run, busy, close, connect }: { state: GeoState; run: Run; busy: boolean; close: () => void; connect: (platform: string) => Promise<void> }) {
  const row = (platform: string, name: string, look: Look, available: boolean) => {
    const list = accountsOf(state, platform);
    return <li key={platform} className={available ? "" : "is-off"}><Mark look={look} dim={!available} /><b>{name}</b>
      <span className="ga-chips">{!available ? <em>即将开放</em> : list.map((account) => <span key={account.id} className={`ga-chip${account.status === "active" ? " is-on" : ""}`}>{account.label} · {account.loggingIn ? "正在登录" : account.status === "active" ? "已登录" : "没登录"}
        {account.status !== "active" && !account.loggingIn && <button type="button" className="ga-link" disabled={busy} onClick={() => void run(`login-${account.id}`, "account-login", { id: account.id }, "登录窗口打开了，扫码后会自动认出来。")}>扫码</button>}
        <button type="button" className="ga-icon" aria-label={`删除账号 ${account.label}`} disabled={busy} onClick={() => { if (window.confirm(`删除账号「${account.label}」？这台电脑上的登录也会退出。`)) void run(`rm-${account.id}`, "account-remove", { id: account.id }); }}><Trash2 size={13} /></button></span>)}</span>
      {available && <button type="button" className="ga-btn sm is-quiet" disabled={busy || state.accounts.browserReady === false} onClick={() => { if (list.length) void run(`add-${platform}`, "account-add", { platform }); else void connect(platform); }}><Plus size={14} />{list.length ? "再加一个" : "扫码登录"}</button>}
    </li>;
  };
  return <SheetFrame wide title="账号" close={close}>
    {state.accounts.browserReady === false && <p className="ga-note">这台电脑没找到 Chrome 或 Edge 浏览器，装好以后才能登录。</p>}
    <p className="ga-label">要去问的 AI</p>
    <ul className="ga-acc">{state.engines.map((engine) => row(engine.id, engine.name, ENGINE_LOOK[engine.id] || GREY, engine.available))}</ul>
    <p className="ga-label">发文章的平台</p>
    <ul className="ga-acc">{state.channels.map((channel) => row(channel.id, channel.name, PLATFORM_LOOK[channel.id] || GREY, channel.available))}</ul>
  </SheetFrame>;
}
function CompanySheet({ state, run, busy, close }: { state: GeoState; run: Run; busy: boolean; close: () => void }) {
  const [form, setForm] = useState(() => brandForm(state.brand));
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  return <SheetFrame wide title="公司资料" close={close} footer={<button type="button" className="ga-btn" disabled={busy || !form.name.trim() || !form.services.trim()} onClick={() => void run("brand", "save-brand", form, "保存好了。以后写的文章都按新资料来。").then((result) => { if (result?.ok) close(); })}>保存</button>}>
    <p className="ga-muted">AI 只用这里写的真实信息，不会编。写得越具体，文章越有用。</p>
    <label className="ga-field"><span>公司名</span><input value={form.name} onChange={set("name")} /></label>
    <label className="ga-field"><span>卖什么，有什么特点</span><textarea rows={4} value={form.services} onChange={set("services")} /></label>
    <label className="ga-field"><span>在哪做生意</span><input value={form.regions} onChange={set("regions")} /></label>
    <label className="ga-field"><span>真实案例</span><textarea rows={3} value={form.cases} placeholder="没有就空着，AI 不会编。" onChange={set("cases")} /></label>
    <label className="ga-field"><span>公司的其他叫法</span><input value={form.aliases} placeholder="用顿号分开" onChange={set("aliases")} /></label>
    <label className="ga-field"><span>文章里不能说的</span><textarea rows={2} value={form.restrictions} onChange={set("restrictions")} /></label>
  </SheetFrame>;
}
function RecordsSheet({ state, run, busy, open, close }: { state: GeoState; run: Run; busy: boolean; open: Open; close: () => void }) {
  const [links, setLinks] = useState<Record<string, string>>({});
  const publications = [...state.publications].reverse().slice(0, 40);
  return <SheetFrame wide title="文章和发布" close={close} footer={<button type="button" className="ga-btn is-quiet" onClick={() => open({ kind: "paste" })}><Plus size={15} />加一篇自己的文章</button>}>
    <h4>发布记录</h4>
    {publications.length ? <ul className="ga-records">{publications.map((item) => <li key={item.id}>
      <Mark look={PLATFORM_LOOK[item.platform] || GREY} />
      <div className="ga-record-main"><b>《{item.title}》</b><small>{channelName(state, item.platform)} · {item.accountLabel} · {item.status === "scheduled" ? `计划${when(item.dueAt)}` : when(item.finishedAt || item.clickedAt || item.confirmedAt)}</small>
        {(item.detail || item.reason) && <small>{item.detail || item.reason}</small>}
        {(item.status === "unknown" || item.status === "reviewing") && <div className="ga-resolve">
          <input aria-label="文章链接" value={links[item.id] || ""} placeholder="文章链接（选填，填了才能认出 AI 有没有引用它）" onChange={(event) => setLinks({ ...links, [item.id]: event.target.value })} />
          <button type="button" className="ga-btn sm" disabled={busy} onClick={() => void run(`ok-${item.id}`, "resolve-publication", { id: item.id, outcome: "public", url: (links[item.id] || "").trim() }, "记下了。")}>发出了</button>
          <button type="button" className="ga-btn sm is-quiet" disabled={busy} onClick={() => void run(`no-${item.id}`, "resolve-publication", { id: item.id, outcome: "failed" }, "记下了。")}>没发出</button>
        </div>}
      </div>
      <span className={`ga-pill is-${item.status}`}>{STATUS_TEXT[item.status]}</span>
      {item.url ? <button type="button" className="ga-icon" aria-label="打开文章" onClick={() => void run(`o-${item.id}`, "open-link", { id: item.id })}><ExternalLink size={15} /></button>
        : item.status === "scheduled" ? <button type="button" className="ga-link" disabled={busy} onClick={() => void run(`c-${item.id}`, "cancel-scheduled", { id: item.id }, "这一篇不发了。")}>取消</button> : <span />}
    </li>)}</ul> : <p className="ga-muted">还没有发过。</p>}
    <h4>全部文章 · {state.articles.length} 篇</h4>
    {state.articles.length ? <ul className="ga-artlist">{state.articles.slice(0, 40).map((article) => <li key={article.id}><button type="button" onClick={() => open({ kind: "article", id: article.id })}><b>{article.title}</b><small>{article.question ? `回答：${article.question}` : "自己的文章"} · {article.body.length} 字</small></button></li>)}</ul> : <p className="ga-muted">还没有文章。</p>}
  </SheetFrame>;
}
