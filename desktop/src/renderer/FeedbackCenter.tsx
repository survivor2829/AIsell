import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, MessageCircle, RefreshCw, Send, ShieldCheck, X } from "lucide-react";
import "./feedback-center.css";

const Diagnostics = lazy(() => import("./Diagnostics").then((module) => ({ default: module.Diagnostics })));
export type FeedbackContext = { module: string; taskId?: string; label?: string };
type Draft = { id: string; text: string; category: string; includeDiagnostics: boolean; visibility: "public" | "private"; context: FeedbackContext | null };
type FeedbackItem = {
  id: string; text: string; category: string; context: FeedbackContext | null; createdAt: string;
  includeDiagnostics: boolean; diagnosticCount: number; delivery: "queued" | "sending" | "sent" | "failed";
  status: "pending" | "in_progress" | "resolved" | null; receivedAt: number | null; updatedAt: number | null;
  error: string; retryable: boolean; visibility: "public" | "private"; hidden: boolean; officialReply: string;
};
type PublicItem = Pick<FeedbackItem, "id" | "text" | "category" | "createdAt" | "receivedAt" | "updatedAt" | "status" | "officialReply">;
type Community = { items: PublicItem[]; total: number; offset: number; lastRefresh: string; error: string };
type AdminItem = PublicItem & { visibility: string; hidden: boolean; diagnostics: unknown[]; diagnosticsExpired: boolean };
type AdminPage = { items: AdminItem[]; total: number; offset: number };
type FeedbackState = { community: Community; enabled: boolean; draft: Draft; items: FeedbackItem[]; lastRefresh: string; refreshError: string };
type Result = { ok: boolean; data?: FeedbackState; error?: string };
declare global {
  interface Window {
    xiaoxiFeedback?: {
      publicList(offset: number): Promise<Result>; withdraw(id: string): Promise<Result>;
      adminAvailable(): Promise<{ ok: boolean; data?: { available: boolean } }>;
      adminList(value: { offset: number; status: string }): Promise<{ ok: boolean; data?: AdminPage; error?: string }>;
      adminUpdate(value: { id: string; status: string; officialReply: string; hidden: boolean }): Promise<{ ok: boolean; error?: string }>;
      status(): Promise<Result>; submit(draft: Draft): Promise<Result>; saveDraft(draft: Draft): Promise<Result>;
      refresh(): Promise<Result>; retry(id: string): Promise<Result>; onUpdate(callback: (data: FeedbackState) => void): () => void;
    };
  }
}
const categoryLabels: Record<string, string> = { problem: "遇到问题", suggestion: "功能建议", experience: "体验吐槽" };
const moduleLabels: Record<string, string> = {
  content_engine: "内容创作", "content-engine": "内容创作", auto_reply: "自动回复", "auto-reply": "自动回复",
  active_touch: "主动触达", moments: "朋友圈", contact_sync: "客户同步"
};
function date(value: string | number) {
  const parsed = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString("zh-CN", { hour12: false }) : "--";
}
function itemStatus(item: FeedbackItem) {
  if (item.delivery === "sending") return "正在发送";
  if (item.delivery !== "sent") return "待发送";
  return { pending: "待处理", in_progress: "处理中", resolved: "已解决" }[item.status || "pending"];
}

export function FeedbackCenter({ appVersion, edition, buildId, context }: {
  appVersion: string; edition: string; buildId: string; context?: FeedbackContext | null;
}) {
  const [state, setState] = useState<FeedbackState>();
  const [draft, setDraft] = useState<Draft>();
  const [tab, setTab] = useState<"compose" | "mine" | "community" | "admin">("compose");
  const [adminAvailable, setAdminAvailable] = useState(false);
  const [adminPage, setAdminPage] = useState<AdminPage>();
  const [adminStatus, setAdminStatus] = useState("");
  const [listBusy, setListBusy] = useState(false);
  const publicPending = useRef(false);
  const adminPending = useRef(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState("草稿自动保存在本机");
  const draftRef = useRef<Draft>();
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const contextRef = useRef(context);
  const appliedContextRef = useRef<FeedbackContext | null>();
  contextRef.current = context;
  const id = useId();
  const receive = useCallback((value: FeedbackState) => {
    setState(value);
    if (!draftRef.current || value.draft.id !== draftRef.current.id) {
      const next = { ...value.draft };
      const entryContext = contextRef.current;
      if (entryContext && appliedContextRef.current !== entryContext) {
        next.context = entryContext;
        appliedContextRef.current = entryContext;
        clearTimeout(saveTimer.current);
        void window.xiaoxiFeedback?.saveDraft(next).catch(() => {});
      }
      draftRef.current = next; setDraft(next);
    }
  }, []);
  useEffect(() => {
    const api = window.xiaoxiFeedback;
    if (!api) { setError("当前版本未连接反馈功能，请重新打开软件后重试。"); return; }
    let active = true;
    void api.adminAvailable().then((result) => { if (active) setAdminAvailable(Boolean(result.ok && result.data?.available)); }).catch(() => {});
    const unsubscribe = api.onUpdate((value) => { if (active) receive(value); });
    void api.status().then((result) => {
      if (!active) return;
      if (!result.ok || !result.data) throw new Error(result.error || "读取反馈失败");
      receive(result.data);
    }).catch((reason) => { if (active) setError(String(reason?.message || reason)); });
    return () => {
      active = false; unsubscribe(); clearTimeout(saveTimer.current);
      if (draftRef.current) void api.saveDraft(draftRef.current).catch(() => {});
    };
  }, [receive]);
  useEffect(() => {
    if (!context) { appliedContextRef.current = null; return; }
    if (!draftRef.current || appliedContextRef.current === context) return;
    const next = { ...draftRef.current, context };
    appliedContextRef.current = context;
    clearTimeout(saveTimer.current);
    draftRef.current = next; setDraft(next); setTab("compose");
    void window.xiaoxiFeedback?.saveDraft(next).catch(() => {});
  }, [context]);
  const refresh = useCallback(async () => {
    if (!window.xiaoxiFeedback) return;
    try {
      const result = await window.xiaoxiFeedback.refresh();
      if (!result.ok || !result.data) throw new Error(result.error || "更新处理进度失败");
      receive(result.data);
    } catch (reason) { setError(String((reason as Error)?.message || reason)); }
  }, [receive]);
  useEffect(() => {
    if (tab !== "mine") return;
    const update = () => { if (document.visibilityState === "visible" && document.hasFocus()) void refresh(); };
    update();
    const timer = setInterval(update, 60_000);
    document.addEventListener("visibilitychange", update); window.addEventListener("focus", update);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", update); window.removeEventListener("focus", update); };
  }, [tab, refresh]);
  const loadPublic = useCallback(async (offset = 0) => {
    if (!window.xiaoxiFeedback || publicPending.current) return;
    publicPending.current = true; setListBusy(true);
    try { const result = await window.xiaoxiFeedback.publicList(offset); if (!result.ok || !result.data) throw new Error(result.error); receive(result.data); }
    catch { setError("读取公开反馈失败，请重试。"); }
    finally { publicPending.current = false; setListBusy(false); }
  }, [receive]);
  const loadAdmin = useCallback(async (offset = 0) => {
    if (!window.xiaoxiFeedback || adminPending.current) return;
    adminPending.current = true; setListBusy(true); setError("");
    try { const result = await window.xiaoxiFeedback.adminList({ offset, status: adminStatus }); if (!result.ok || !result.data) throw new Error(result.error); setAdminPage(result.data); }
    catch (reason) { setError((reason as Error).message || "开发者连接失败，请重试。"); }
    finally { adminPending.current = false; setListBusy(false); }
  }, [adminStatus]);
  useEffect(() => {
    if (tab !== "community" && tab !== "admin") return;
    const update = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      if (tab === "community") void loadPublic(); else void loadAdmin();
    };
    update(); const timer = setInterval(update, 60_000);
    window.addEventListener("focus", update); document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, [tab, loadPublic, loadAdmin]);
  async function withdraw(itemId: string) {
    if (!window.xiaoxiFeedback || busy) return;
    setBusy(true); setError("");
    try { const result = await window.xiaoxiFeedback.withdraw(itemId); if (!result.ok || !result.data) throw new Error(result.error); receive(result.data); }
    catch { setError("撤回公开暂未完成，请刷新确认后重试。"); }
    finally { setBusy(false); }
  }
  function edit(patch: Partial<Draft>) {
    if (!draftRef.current) return;
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next; setDraft(next); setSaveState("正在保存草稿…");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void window.xiaoxiFeedback?.saveDraft(next).then((result) => {
        if (draftRef.current !== next) return;
        setSaveState(result.ok ? "草稿已保存在本机" : "草稿暂未保存，请稍后重试");
      }).catch(() => { if (draftRef.current === next) setSaveState("草稿暂未保存，请稍后重试"); });
    }, 250);
  }
  async function submit() {
    if (!draftRef.current || !window.xiaoxiFeedback || busy) return;
    clearTimeout(saveTimer.current); setBusy(true); setError("");
    try {
      const result = await window.xiaoxiFeedback.submit(draftRef.current);
      if (!result.ok || !result.data) throw new Error(result.error || "提交暂未完成，草稿已保留。");
      receive(result.data); setTab("mine"); setSaveState("草稿自动保存在本机");
    } catch (reason) { setError(String((reason as Error)?.message || reason)); }
    finally { setBusy(false); }
  }
  async function retry(itemId: string) {
    if (!window.xiaoxiFeedback || busy) return;
    setBusy(true); setError("");
    try {
      const result = await window.xiaoxiFeedback.retry(itemId);
      if (!result.ok || !result.data) throw new Error(result.error || "发送暂未完成");
      receive(result.data);
    } catch (reason) { setError(String((reason as Error)?.message || reason)); }
    finally { setBusy(false); }
  }
  return <section className="page feedback-center">
    <div className="page-head feedback-heading"><div><h1>吐槽中心</h1><p>哪里不好用，哪里还可以更好，都可以在这里告诉我们。</p></div></div>
    <div className="feedback-tabs" role="tablist" aria-label="反馈功能" onKeyDown={(event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault(); const tabs = ["compose", "mine", "community", ...(adminAvailable ? ["admin"] : [])] as typeof tab[]; const next = tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]; setTab(next);
      document.getElementById(`${id}-${next}-tab`)?.focus();
    }}>
      <button id={`${id}-compose-tab`} role="tab" aria-selected={tab === "compose"} aria-controls={`${id}-compose`} tabIndex={tab === "compose" ? 0 : -1} onClick={() => setTab("compose")}>我要吐槽</button>
      <button id={`${id}-mine-tab`} role="tab" aria-selected={tab === "mine"} aria-controls={`${id}-mine`} tabIndex={tab === "mine" ? 0 : -1} onClick={() => setTab("mine")}>我的反馈{Boolean(state?.items.length) && <span>{state!.items.length}</span>}</button>
      <button id={id + "-community-tab"} role="tab" aria-selected={tab === "community"} aria-controls={id + "-community"} tabIndex={tab === "community" ? 0 : -1} onClick={() => setTab("community")}>大家的声音</button>
      {adminAvailable && <button id={id + "-admin-tab"} role="tab" aria-selected={tab === "admin"} aria-controls={id + "-admin"} tabIndex={tab === "admin" ? 0 : -1} onClick={() => setTab("admin")}>反馈管理</button>}
    </div>
    {error && <p className="feedback-error" role="alert">{error}</p>}
    {state && !state.enabled && <p className="feedback-note">反馈服务暂未连接，提交的内容会保存在本机，连接恢复后可以重新发送。</p>}
    {tab === "compose" ? <div id={`${id}-compose`} role="tabpanel" aria-labelledby={`${id}-compose-tab`} className="feedback-compose">
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <fieldset className="feedback-categories" disabled={busy || !draft}><legend>想聊哪一类？</legend>
          {Object.entries(categoryLabels).map(([value, label]) => <label key={value} className={draft?.category === value ? "is-selected" : ""}>
            <input type="radio" name={`${id}-category`} value={value} checked={draft?.category === value} onChange={() => edit({ category: value })} />{label}
          </label>)}
        </fieldset>
        <label className="feedback-body-label" htmlFor={`${id}-text`}>说说你的想法</label>
        {draft?.context && <div className="feedback-context"><span>已关联：{draft.context.label || moduleLabels[draft.context.module] || "相关功能"}{draft.context.taskId ? "中的制作或操作任务" : ""}</span><button type="button" aria-label="取消关联任务" onClick={() => edit({ context: null })}><X size={15} /></button></div>}
        <textarea id={`${id}-text`} value={draft?.text || ""} disabled={busy || !draft} required rows={7} aria-describedby={`${id}-count`}
          placeholder="哪里不好用？发生了什么？你希望怎么改？" onChange={(event) => edit({ text: Array.from(event.target.value).slice(0, 2000).join("") })} />
        <div className="feedback-draft-meta"><span>{saveState}</span><span id={`${id}-count`}>{Array.from(draft?.text || "").length} / 2000 字</span></div>
        <fieldset className="feedback-categories feedback-visibility" disabled={busy || !draft}><legend>谁可以看到这条反馈？</legend>
          <label className={draft?.visibility === "public" ? "is-selected" : ""}><input type="radio" name={id + "-visibility"} checked={draft?.visibility === "public"} onChange={() => edit({ visibility: "public" })} />公开到大家的声音</label>
          <label className={draft?.visibility === "private" ? "is-selected" : ""}><input type="radio" name={id + "-visibility"} checked={draft?.visibility === "private"} onChange={() => edit({ visibility: "private" })} />仅开发者可见</label>
          <p className="feedback-note">{draft?.visibility === "private" ? "文字和回复仅你与开发者可见。" : "文字、类型、时间、处理进度和官方回复会公开。请勿填写个人隐私；提交后可撤回公开。"} 附带诊断仅开发者可见。</p>
        </fieldset>
        <div className="feedback-diagnostic-option"><label><input type="checkbox" checked={draft?.includeDiagnostics ?? true} disabled={busy || !draft} onChange={(event) => edit({ includeDiagnostics: event.target.checked })} />附带近期脱敏诊断，帮助定位问题</label>
          <p><ShieldCheck size={15} />仅附带必要技术信息，不自动附带聊天内容、联系人、截图或素材。此选项不会开启持续自动上传。</p>
        </div>
        <div className="feedback-submit-row"><p>提交后可在「我的反馈」查看处理进度。</p><button className="primary-button" type="submit" disabled={busy || !draft?.text.trim()}><Send size={16} />{busy ? "正在保存…" : "提交反馈"}</button></div>
      </form>
    </div> : tab === "mine" ? <div id={`${id}-mine`} role="tabpanel" aria-labelledby={`${id}-mine-tab`} className="feedback-mine">
      <div className="feedback-list-toolbar"><p>{state?.lastRefresh ? `最近同步：${date(state.lastRefresh)}` : "收到服务器回执后，反馈才会进入待处理。"}</p><button className="secondary-button" disabled={busy || !state?.enabled} onClick={() => void refresh()}><RefreshCw size={16} />刷新进度</button></div>
      {state?.refreshError && <p className="feedback-note" role="status">{state.refreshError}</p>}
      {!state?.items.length ? <div className="feedback-empty"><MessageCircle size={32} /><h2>还没有反馈记录</h2><p>遇到问题或想到新点子，随时告诉我们。</p><button className="secondary-button" onClick={() => setTab("compose")}>写下第一条反馈</button></div>
        : <ol className="feedback-list">{state.items.map((item) => <li key={item.id}>
          <div className="feedback-item-head"><strong>{categoryLabels[item.category] || "用户反馈"}</strong><span className={`feedback-status is-${item.delivery === "sent" ? item.status : "queued"}`} role="status">{itemStatus(item)}</span></div>
          <p className="feedback-item-text">{item.text}</p>
          {item.officialReply && <div className="feedback-reply"><strong>官方回复</strong><p>{item.officialReply}</p></div>}
          <div className="feedback-item-meta"><span>{item.visibility === "private" ? "仅开发者可见" : item.hidden ? "已由开发者隐藏公开展示" : "公开到大家的声音"}</span>{item.delivery === "sent" && item.visibility === "public" && <button className="secondary-button" disabled={busy} onClick={() => void withdraw(item.id)}>撤回公开</button>}</div>
          <div className="feedback-item-meta"><span>提交时间：{date(item.createdAt)}</span>{item.updatedAt && <span>状态更新：{date(item.updatedAt)}</span>}</div>
          <div className="feedback-item-meta"><span className="feedback-number">{item.delivery === "sent" ? "反馈编号" : "本机记录编号"}：{item.id}</span><span>{item.includeDiagnostics ? `已附带 ${item.diagnosticCount} 条脱敏诊断` : "仅反馈文字"}</span></div>
          {item.error && <div className="feedback-item-error"><p>{item.error}</p>{item.delivery === "failed" && item.retryable && <button className="secondary-button" disabled={busy || !state.enabled} onClick={() => void retry(item.id)}>重新发送</button>}</div>}
        </li>)}</ol>}
    </div> : tab === "community" ? <div id={id + "-community"} role="tabpanel" aria-labelledby={id + "-community-tab"}>
      <div className="feedback-list-toolbar"><p>按最新提交排列 · 共 {state?.community?.total || 0} 条{state?.community?.lastRefresh && " · 最近同步：" + date(state.community.lastRefresh)}</p><button className="secondary-button" disabled={listBusy} onClick={() => void loadPublic(state?.community?.offset || 0)}><RefreshCw size={16} />{listBusy ? "正在刷新…" : "刷新反馈"}</button></div>
      {state?.community?.error && <p className="feedback-note" role="status">{state.community.error}</p>}
      {!state?.community?.items.length ? <div className="feedback-empty"><MessageCircle size={32} /><h2>{listBusy ? "正在读取公开反馈…" : "还没有公开反馈"}</h2><p>公开分享你的想法，让大家一起看到进展。</p></div> :
        <ol className="feedback-list">{state.community.items.map((item) => <li key={item.id}><FeedbackRecord item={item} /></li>)}</ol>}
      <div className="feedback-pagination"><button className="secondary-button" disabled={listBusy || !state?.community?.offset} onClick={() => void loadPublic(Math.max(0, (state?.community?.offset || 0) - 30))}>上一页</button><span>第 {Math.floor((state?.community?.offset || 0) / 30) + 1} 页</span><button className="secondary-button" disabled={listBusy || (state?.community?.offset || 0) + 30 >= (state?.community?.total || 0)} onClick={() => void loadPublic((state?.community?.offset || 0) + 30)}>下一页</button></div>
    </div> : <div id={id + "-admin"} role="tabpanel" aria-labelledby={id + "-admin-tab"}>
      <div className="feedback-list-toolbar"><label>处理状态 <select disabled={listBusy} value={adminStatus} onChange={(event) => { setAdminPage(undefined); setAdminStatus(event.target.value); }}><option value="">全部</option><option value="pending">待处理</option><option value="in_progress">处理中</option><option value="resolved">已解决</option></select></label><button className="secondary-button" disabled={listBusy} onClick={() => void loadAdmin(adminPage?.offset || 0)}><RefreshCw size={16} />{listBusy ? "正在读取…" : "刷新管理列表"}</button></div>
      {!adminPage?.items.length ? <div className="feedback-empty"><h2>{listBusy ? "正在读取反馈…" : "暂无匹配的反馈"}</h2></div> : <ol className="feedback-list">{adminPage.items.map((item) => <li key={item.id}><AdminRecord item={item} onSaved={() => { void loadAdmin(adminPage.offset); void refresh(); }} /></li>)}</ol>}
      <div className="feedback-pagination"><button className="secondary-button" disabled={listBusy || !adminPage?.offset} onClick={() => void loadAdmin(Math.max(0, (adminPage?.offset || 0) - 100))}>上一页</button><span>共 {adminPage?.total || 0} 条</span><button className="secondary-button" disabled={listBusy || (adminPage?.offset || 0) + 100 >= (adminPage?.total || 0)} onClick={() => void loadAdmin((adminPage?.offset || 0) + 100)}>下一页</button></div>
    </div>}
    <details className="feedback-diagnostics" open={diagnosticsOpen} onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}>
      <summary><div><strong>日志诊断</strong><span>需要进一步排查时，查看日志或导出诊断包。</span></div><ChevronDown size={18} /></summary>
      {diagnosticsOpen && <Suspense fallback={<p className="feedback-note">正在读取诊断工具…</p>}><Diagnostics appVersion={appVersion} edition={edition} buildId={buildId} /></Suspense>}
    </details>
  </section>;
}

function FeedbackRecord({ item }: { item: PublicItem }) {
  return <><div className="feedback-item-head"><strong>{categoryLabels[item.category] || "用户反馈"}</strong><span className={"feedback-status is-" + item.status}>{({ pending: "待处理", in_progress: "处理中", resolved: "已解决" })[item.status || "pending"]}</span></div>
    <p className="feedback-item-text">{item.text}</p><div className="feedback-item-meta"><span>提交时间：{date(item.createdAt)}</span>{item.updatedAt && <span>更新：{date(item.updatedAt)}</span>}</div>
    {item.officialReply && <div className="feedback-reply"><strong>官方回复</strong><p>{item.officialReply}</p></div>}</>;
}
function AdminRecord({ item, onSaved }: { item: AdminItem; onSaved(): void }) {
  const [status, setStatus] = useState(item.status || "pending");
  const [reply, setReply] = useState(item.officialReply);
  const [hidden, setHidden] = useState(item.hidden);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [dirty, setDirty] = useState(false);
  const formId = useId();
  useEffect(() => { if (!dirty) { setStatus(item.status || "pending"); setReply(item.officialReply); setHidden(item.hidden); } }, [item, dirty]);
  async function save() {
    if (!window.xiaoxiFeedback || busy) return;
    setBusy(true); setMessage("");
    try { const result = await window.xiaoxiFeedback.adminUpdate({ id: item.id, status, officialReply: reply, hidden }); if (!result.ok) throw new Error(result.error); setDirty(false); setMessage("已保存"); onSaved(); }
    catch (error) { setMessage((error as Error).message || "保存失败，请刷新确认后重试。"); }
    finally { setBusy(false); }
  }
  return <><FeedbackRecord item={item} /><p className="feedback-note">{item.visibility === "public" ? "公开反馈" : "私密反馈"}{item.hidden ? " · 已隐藏公开展示" : ""}</p>
    <form className="feedback-admin-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label htmlFor={formId + "-reply"}>官方回复</label><textarea id={formId + "-reply"} value={reply} disabled={busy} rows={3} placeholder="写下处理进展或解决办法" onChange={(event) => { setReply(Array.from(event.target.value).slice(0, 2000).join("")); setDirty(true); }} />
      <div className="feedback-admin-actions"><label>处理状态 <select value={status} disabled={busy} onChange={(event) => { setStatus(event.target.value as typeof status); setDirty(true); }}><option value="pending">待处理</option><option value="in_progress">处理中</option><option value="resolved">已解决</option></select></label>
      <label><input type="checkbox" checked={hidden} disabled={busy} onChange={(event) => { setHidden(event.target.checked); setDirty(true); }} />隐藏公开展示</label><button className="primary-button" disabled={busy || !dirty} type="submit">{busy ? "正在保存…" : "保存处理结果"}</button></div>
      <p className="feedback-note">回复随反馈的可见范围展示；隐藏后，提交者仍可在「我的反馈」查看。</p>{message && <p role="status" className="feedback-note">{message}</p>}
    </form>
    <details className="feedback-admin-diagnostics"><summary>查看附带脱敏诊断（{item.diagnostics.length} 条）</summary>{item.diagnosticsExpired ? <p className="feedback-note">诊断已过保留期。</p> : <pre>{JSON.stringify(item.diagnostics, null, 2)}</pre>}</details></>;
}
