import { useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, Pencil, Plus, RefreshCw, Send, Sparkles, Trash2 } from "lucide-react";
import type { GeoAccount, GeoArticle, GeoPublication, GeoResult, GeoState } from "./geo-types";
import "./GeoPanel.css";

const STEPS = [["brand", "介绍公司"], ["write", "写文章"], ["publish", "发出去"], ["result", "看效果"]] as const;
type Step = typeof STEPS[number][0];
const PUBLISH_STATUS: Record<GeoPublication["status"], string> = { queued: "排队中", running: "正在发", public: "已发出", reviewing: "平台审核中", failed: "没发出", unknown: "结果不明", cancelled: "已取消" };
const clock = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? "" : `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; };

// GEO：让客户在 AI 里问问题时，更容易看到你。四步走完：介绍公司 → 写文章 → 发出去 → 看效果。
export function GeoPanel() {
  const api = window.xiaoxiGeo;
  const [state, setState] = useState<GeoState>();
  const [step, setStep] = useState<Step>("brand");
  const [brand, setBrand] = useState({ name: "", services: "", regions: "", cases: "", aliases: "", restrictions: "" });
  const [newQuestion, setNewQuestion] = useState("");
  const [pasted, setPasted] = useState({ title: "", body: "" });
  const [links, setLinks] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ id: string; title: string; body: string }>();
  const [articleId, setArticleId] = useState("");
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [checkIds, setCheckIds] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!api) { setError("GEO 服务还没有连接，请重新打开软件。"); return; }
    let active = true, opened = false;
    const open = (next: GeoState) => {
      if (opened) return; opened = true;
      setBrand({ name: next.brand.name, services: next.brand.services, regions: next.brand.regions.join("、"), cases: next.brand.cases, aliases: next.brand.aliases.join("、"), restrictions: next.brand.restrictions });
      // Picks up where the user left off.
      if (next.publications.length) setStep("result"); else if (next.articles.length) setStep("publish"); else if (next.brand.name) setStep("write");
    };
    const off = api.onUpdate((next) => { if (active) setState(next); });
    void api.invoke("status").then((result) => { if (!active) return; if (result.state) { setState(result.state); open(result.state); } if (!result.ok) setError(result.error || "GEO 记录读取失败。"); });
    return () => { active = false; off(); };
  }, [api]);

  const run = async (key: string, action: string, payload: Record<string, unknown> = {}, success = ""): Promise<GeoResult | undefined> => {
    if (!api) return undefined;
    setPending(key); setError(""); setNotice("");
    try {
      const result = await api.invoke(action, payload);
      if (result.state) setState(result.state);
      if (!result.ok) setError(result.error || "操作没有完成，请稍后再试。");
      else if (success) setNotice(success);
      return result;
    } catch { setError("操作没有完成，请稍后再试。"); return undefined; }
    finally { setPending(""); }
  };
  const busy = Boolean(pending) || Boolean(state?.busy);
  const accountsOf = (platform: string): GeoAccount[] => (state?.accounts.accounts || []).filter((account) => account.platform === platform);
  const article: GeoArticle | undefined = useMemo(() => state?.articles.find((item) => item.id === articleId) || state?.articles[0], [state, articleId]);
  const openChannels = (state?.channels || []).filter((channel) => channel.available);
  const closedChannels = (state?.channels || []).filter((channel) => !channel.available);
  const doubao = accountsOf("doubao").find((account) => account.status === "active");
  // Only what is still selectable counts: an account can sign out and a question can be deleted after being ticked.
  const liveTargets = [...targets].filter((value) => { const [platform, id] = value.split("|"); return accountsOf(platform).some((account) => account.id === id && account.status === "active"); });
  const liveChecks = [...checkIds].filter((id) => state?.questions.some((question) => question.id === id));
  const unknown = (state?.publications || []).filter((item) => item.status === "unknown" || item.status === "reviewing");
  const runs = [...(state?.visibilityRuns || [])].reverse().slice(0, 20);
  const toggle = (set: Set<string>, value: string) => { const next = new Set(set); if (next.has(value)) next.delete(value); else next.add(value); return next; };

  const accountChip = (platform: string, name: string) => {
    const list = accountsOf(platform);
    return <div className="geo-accounts">
      {list.map((account) => <span key={account.id} className={`geo-account ${account.status === "active" ? "is-ok" : ""}`}>{account.label} · {account.loggingIn ? "正在登录" : account.status === "active" ? "已登录" : "没登录"}
        {account.status !== "active" && !account.loggingIn && <button type="button" className="social-text-button" disabled={busy} onClick={() => void run(`login-${account.id}`, "account-login", { id: account.id })}>扫码</button>}
        <button type="button" className="geo-icon" aria-label={`删除${account.label}`} disabled={busy} onClick={() => window.confirm(`删除账号「${account.label}」？这台电脑上的登录也会退出。`) && void run(`rm-${account.id}`, "account-remove", { id: account.id })}><Trash2 size={13} /></button></span>)}
      <button type="button" className="geo-mini" disabled={busy || state?.accounts.browserReady === false} onClick={() => void run(`add-${platform}`, "account-add", { platform })}><Plus size={14} />{list.length ? "再加一个" : `登录${name}`}</button>
    </div>;
  };

  if (!state) return <div className="geo">{error ? <div className="social-feedback is-error" role="alert">{error}</div> : <p className="geo-muted">正在打开…</p>}</div>;
  return <div className="geo">
    <ol className="geo-steps" aria-label="步骤">
      {STEPS.map(([key, label], index) => <li key={key}><button type="button" className={step === key ? "is-on" : ""} aria-current={step === key ? "step" : undefined} onClick={() => setStep(key)}><i>{index + 1}</i>{label}</button></li>)}
    </ol>
    {(error || notice) && <div className={`social-feedback ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>{!error && <Check size={16} />}{error || notice}</div>}
    {state.busy === "writing" && <div className="geo-live" role="status">AI 正在写，大约要一分钟，请稍等…</div>}
    {(state.busy === "publish" || state.busy === "visibility") && <div className="geo-live geo-live-row" role="status"><span>{state.busy === "publish" ? "正在发布，请不要在弹出的 Chrome 窗口里操作…" : "正在问豆包，请不要在弹出的 Chrome 窗口里操作…"}</span>
      <button type="button" className="geo-mini" disabled={Boolean(pending)} onClick={() => void run("stop", "stop")}>停下</button></div>}
    {state.aiPending.length > 0 && <div className="geo-warn" role="alert"><b>上次 AI 没有等到结果：</b>{state.aiPending[0].label}。为避免重复花钱，软件没有自动重试。
      <button type="button" className="geo-mini" disabled={busy} onClick={() => void run("retry", "retry-ai", { id: state.aiPending[0].id }, "可以重新生成了。")}>再试一次</button></div>}

    {step === "brand" && <section className="geo-card" aria-label="介绍公司">
      <h2>先介绍一下你的公司</h2><p className="geo-muted">AI 只会用这里写的内容，不会编造。写得越真实具体，文章越有用。</p>
      <label>公司或品牌名称<input value={brand.name} placeholder="例如：成都某某清洁设备" onChange={(event) => setBrand({ ...brand, name: event.target.value })} /></label>
      <label>你卖什么、有什么特点<textarea rows={4} value={brand.services} placeholder="例如：商用洗地机销售和租赁，提供上门演示和售后维修" onChange={(event) => setBrand({ ...brand, services: event.target.value })} /></label>
      <label>在哪些地方做生意<input value={brand.regions} placeholder="例如：成都、重庆" onChange={(event) => setBrand({ ...brand, regions: event.target.value })} /></label>
      <label>真实案例（选填）<textarea rows={3} value={brand.cases} placeholder="例如：给某某物业提供过 10 台洗地机。没有就空着，AI 不会编。" onChange={(event) => setBrand({ ...brand, cases: event.target.value })} /></label>
      <details className="geo-more"><summary>更多设置（一般不用改）</summary>
        <label>公司的其他叫法<input value={brand.aliases} placeholder="用顿号分开，用来判断豆包有没有提到你" onChange={(event) => setBrand({ ...brand, aliases: event.target.value })} /></label>
        <label>文章里不能说的内容<textarea rows={2} value={brand.restrictions} onChange={(event) => setBrand({ ...brand, restrictions: event.target.value })} /></label>
      </details>
      <div className="geo-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void run("brand", "save-brand", brand).then((result) => { if (result?.ok) setStep("write"); })}>保存，下一步</button></div>
    </section>}

    {step === "write" && <section className="geo-card" aria-label="写文章">
      <h2>客户会在 AI 里问什么？</h2><p className="geo-muted">选一个问题，AI 帮你写一篇回答它的文章。今天已用 {state.usage.ai}/{state.usage.aiLimit} 次 AI 写作。</p>
      <div className="geo-row">
        <input aria-label="自己加一个问题" value={newQuestion} placeholder="自己加一个问题，例如：成都哪里能租洗地机" onChange={(event) => setNewQuestion(event.target.value)} />
        <button type="button" className="secondary-button" disabled={busy || !newQuestion.trim()} onClick={() => void run("q-add", "add-questions", { text: newQuestion }).then((result) => { if (result?.ok) setNewQuestion(""); })}>添加</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void run("suggest", "suggest-questions")}><Sparkles size={15} />让 AI 帮我想</button>
      </div>
      {state.questions.length === 0 ? <p className="geo-muted">还没有问题。点「让 AI 帮我想」，或者自己加一个。</p> : <ul className="geo-list">{state.questions.map((question) => {
        const written = state.articles.filter((item) => item.questionId === question.id).length;
        return <li key={question.id}><span>{question.text}</span>{written > 0 && <small className="geo-ok">已写 {written} 篇</small>}
          <button type="button" className="geo-mini is-go" disabled={busy} onClick={() => void run(`w-${question.id}`, "write-article", { questionId: question.id }, "写好了，看看下面这篇。")}><Pencil size={14} />写文章</button>
          <button type="button" className="geo-icon" aria-label="删除问题" disabled={busy} onClick={() => void run(`qd-${question.id}`, "remove-question", { id: question.id })}><Trash2 size={14} /></button></li>; })}</ul>}
      <details className="geo-more"><summary>我已经有文章了，直接粘贴</summary>
        <label>标题<input value={pasted.title} onChange={(event) => setPasted({ ...pasted, title: event.target.value })} /></label>
        <label>正文<textarea rows={8} value={pasted.body} placeholder="这一版只发文字，图片不会带上。" onChange={(event) => setPasted({ ...pasted, body: event.target.value })} /></label>
        <div className="geo-actions"><button type="button" className="secondary-button" disabled={busy || !pasted.title.trim() || !pasted.body.trim()} onClick={() => void run("paste", "add-article", pasted, "文章已保存。").then((result) => { if (result?.ok) setPasted({ title: "", body: "" }); })}>保存这篇</button></div>
      </details>
      {state.articles.length > 0 && <><h3>写好的文章</h3><ul className="geo-articles">{state.articles.map((item) => <li key={item.id}>
        {editing?.id === item.id ? <div className="geo-edit">
          <input aria-label="标题" value={editing.title} onChange={(event) => setEditing({ ...editing, title: event.target.value })} />
          <textarea aria-label="正文" rows={12} value={editing.body} onChange={(event) => setEditing({ ...editing, body: event.target.value })} />
          <div className="geo-actions"><button type="button" className="secondary-button" onClick={() => setEditing(undefined)}>取消</button>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void run("save", "save-article", editing).then((result) => { if (result?.ok) setEditing(undefined); })}>保存</button></div>
        </div> : <><b>{item.title}</b><p>{item.body.slice(0, 120)}{item.body.length > 120 ? "…" : ""}</p><small>{item.question ? `回答：${item.question} · ` : ""}{item.body.length} 字</small>
          <div className="geo-actions"><button type="button" className="geo-mini" onClick={() => setEditing({ id: item.id, title: item.title, body: item.body })}><Pencil size={14} />看全文、修改</button>
            <button type="button" className="geo-mini" disabled={busy} onClick={() => window.confirm(`删除文章「${item.title}」？`) && void run(`ad-${item.id}`, "remove-article", { id: item.id })}><Trash2 size={14} />删除</button>
            <button type="button" className="geo-mini is-go" onClick={() => { setArticleId(item.id); setStep("publish"); }}><Send size={14} />去发布</button></div></>}
      </li>)}</ul></>}
    </section>}

    {step === "publish" && <section className="geo-card" aria-label="发出去">
      <h2>把文章发到你的账号上</h2>
      {!article ? <p className="geo-muted">还没有文章，先去上一步写一篇。</p> : <>
        <label>发哪一篇<select value={article.id} onChange={(event) => { setArticleId(event.target.value); setTargets(new Set()); }}>{state.articles.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        {openChannels.map((channel) => <div className="geo-channel" key={channel.id}><b>{channel.name}{channel.trial && <small className="geo-trial">试用</small>}</b>
          {channel.trial && <p className="geo-muted">这个平台刚接入，暂时只能发你自己写的文章。发完请到平台上看一下，再回来告诉软件结果。</p>}
          {accountChip(channel.id, channel.name)}
          {accountsOf(channel.id).filter((account) => account.status === "active").map((account) => <label className="geo-check" key={account.id}><input type="checkbox" checked={targets.has(`${channel.id}|${account.id}`)} onChange={() => setTargets(toggle(targets, `${channel.id}|${account.id}`))} />发到「{account.label}」</label>)}
        </div>)}
        {closedChannels.length > 0 && <p className="geo-muted">暂未开放：{closedChannels.map((channel) => channel.name).join("、")}。</p>}
        <div className="geo-actions"><button type="button" className="primary-button" disabled={busy || !liveTargets.length} onClick={() => {
          if (!window.confirm(`确认发布？\n\n《${article.title}》会公开发到 ${liveTargets.length} 个账号。发出后如果要删除，要到平台上自己删。`)) return;
          void run("publish", "confirm-publish", { articleId: article.id, targets: liveTargets.map((value) => { const [platform, accountId] = value.split("|"); return { platform, accountId }; }) }, "开始发布了，会打开 Chrome 窗口，请不要在窗口里操作。").then((result) => { if (result?.ok) setTargets(new Set()); });
        }}><Send size={15} />确认发布</button></div>
        <p className="geo-muted">每个账号每天最多发 {state.usage.publishLimit} 篇。平台要你验证时，窗口会跳到前面，你点完会自动继续。</p>
      </>}
      {state.publications.length > 0 && <><h3>发布记录</h3><ul className="geo-list">{[...state.publications].reverse().slice(0, 30).map((item) => <li key={item.id}>
        <span>《{item.title}》<small>{state.channels.find((channel) => channel.id === item.platform)?.name} · {item.accountLabel}{item.clickedAt ? ` · ${clock(item.clickedAt)}` : ""}</small>{(item.detail || item.reason) && <small>{item.detail || item.reason}</small>}</span>
        <small className={`geo-status is-${item.status}`}>{PUBLISH_STATUS[item.status]}</small>
        {item.url && <button type="button" className="geo-mini" onClick={() => void run(`o-${item.id}`, "open-link", { id: item.id })}><ExternalLink size={14} />看文章</button>}
      </li>)}</ul></>}
      {unknown.length > 0 && <div className="geo-warn" role="alert"><b>{unknown.length} 篇需要你看一下</b>：请到平台上确认是否发出，软件不会自己重发。
        <ul>{unknown.map((item) => <li key={item.id}>《{item.title}》
          <input className="geo-link" aria-label="文章链接" value={links[item.id] || ""} placeholder="文章链接（选填，填了才能看出豆包有没有引用它）" onChange={(event) => setLinks({ ...links, [item.id]: event.target.value })} />
          <button type="button" className="geo-mini is-go" disabled={busy} onClick={() => void run(`ok-${item.id}`, "resolve-publication", { id: item.id, outcome: "public", url: (links[item.id] || "").trim() })}>发出了</button>
          <button type="button" className="geo-mini" disabled={busy} onClick={() => void run(`no-${item.id}`, "resolve-publication", { id: item.id, outcome: "failed" })}>没发出</button></li>)}</ul></div>}
    </section>}

    {step === "result" && <section className="geo-card" aria-label="看效果">
      <h2>豆包提到你了吗？</h2><p className="geo-muted">文章发出后，AI 要过一段时间才会收录，刚发的通常查不到，过几天再来查。</p>
      <div className="geo-channel"><b>豆包账号</b>{accountChip("doubao", "豆包")}</div>
      {state.questions.length === 0 ? <p className="geo-muted">还没有问题，先去第 2 步加几个。</p> : <>
        <ul className="geo-list">{state.questions.map((question) => <li key={question.id}><label className="geo-check"><input type="checkbox" checked={checkIds.has(question.id)} onChange={() => setCheckIds(toggle(checkIds, question.id))} />{question.text}</label></li>)}</ul>
        <div className="geo-actions"><button type="button" className="primary-button" disabled={busy || !doubao || !liveChecks.length || liveChecks.length > 5} onClick={() => doubao && void run("check", "check-visibility", { accountId: doubao.id, questionIds: liveChecks }, "开始查了，会打开 Chrome 窗口问豆包。")}><RefreshCw size={15} />去豆包查一下（一次最多 5 个）</button></div>
      </>}
      {runs.length > 0 && <><h3>查询结果</h3><ul className="geo-results">{runs.map((item) => <li key={item.id}>
        <b>{item.question}</b><small>{clock(item.startedAt)}</small>
        {item.status === "running" && <p>正在问豆包…</p>}
        {item.status === "failed" && <p className="geo-bad">没查成：{item.reason}</p>}
        {item.status === "completed" && <><p className={item.mentioned ? "geo-ok" : "geo-bad"}>{item.mentioned ? "✓ 豆包提到了你" : "✗ 这次没有提到你"}</p>
          {item.hits?.[0] && <blockquote>…{item.hits[0].snippet}…</blockquote>}
          <p className="geo-muted">{item.referenceStatus === "extracted" ? `引用了 ${item.references?.length || 0} 篇资料，其中你发的文章 ${item.references?.filter((ref) => ref.association === "confirmed").length || 0} 篇` : "这次没读到引用资料"}</p></>}
      </li>)}</ul></>}
    </section>}
  </div>;
}
