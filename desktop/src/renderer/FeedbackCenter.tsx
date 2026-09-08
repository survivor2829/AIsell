import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, MessageCircle, RefreshCw, Send, ShieldCheck, X } from "lucide-react";
import "./feedback-center.css";

const Diagnostics = lazy(() => import("./Diagnostics").then((module) => ({ default: module.Diagnostics })));
export type FeedbackContext = { module: string; taskId?: string; label?: string };
type Draft = { id: string; text: string; category: string; includeDiagnostics: boolean; context: FeedbackContext | null };
type FeedbackItem = {
  id: string; text: string; category: string; context: FeedbackContext | null; createdAt: string;
  includeDiagnostics: boolean; diagnosticCount: number; delivery: "queued" | "sending" | "sent" | "failed";
  status: "pending" | "in_progress" | "resolved" | null; receivedAt: number | null; updatedAt: number | null;
  error: string; retryable: boolean;
};
type FeedbackState = { enabled: boolean; draft: Draft; items: FeedbackItem[]; lastRefresh: string; refreshError: string };
type Result = { ok: boolean; data?: FeedbackState; error?: string };
declare global {
  interface Window {
    xiaoxiFeedback?: {
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
  const [tab, setTab] = useState<"compose" | "mine">("compose");
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
    const update = () => { if (document.visibilityState === "visible") void refresh(); };
    update();
    const timer = setInterval(update, 60_000);
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [tab, refresh]);
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
      event.preventDefault(); const next = tab === "compose" ? "mine" : "compose"; setTab(next);
      document.getElementById(`${id}-${next}-tab`)?.focus();
    }}>
      <button id={`${id}-compose-tab`} role="tab" aria-selected={tab === "compose"} aria-controls={`${id}-compose`} tabIndex={tab === "compose" ? 0 : -1} onClick={() => setTab("compose")}>我要吐槽</button>
      <button id={`${id}-mine-tab`} role="tab" aria-selected={tab === "mine"} aria-controls={`${id}-mine`} tabIndex={tab === "mine" ? 0 : -1} onClick={() => setTab("mine")}>我的反馈{Boolean(state?.items.length) && <span>{state!.items.length}</span>}</button>
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
        <div className="feedback-diagnostic-option"><label><input type="checkbox" checked={draft?.includeDiagnostics ?? true} disabled={busy || !draft} onChange={(event) => edit({ includeDiagnostics: event.target.checked })} />附带近期脱敏诊断，帮助定位问题</label>
          <p><ShieldCheck size={15} />仅附带必要技术信息，不自动附带聊天内容、联系人、截图或素材。此选项不会开启持续自动上传。</p>
        </div>
        <div className="feedback-submit-row"><p>提交后可在「我的反馈」查看处理进度。</p><button className="primary-button" type="submit" disabled={busy || !draft?.text.trim()}><Send size={16} />{busy ? "正在保存…" : "提交反馈"}</button></div>
      </form>
    </div> : <div id={`${id}-mine`} role="tabpanel" aria-labelledby={`${id}-mine-tab`} className="feedback-mine">
      <div className="feedback-list-toolbar"><p>{state?.lastRefresh ? `最近同步：${date(state.lastRefresh)}` : "收到服务器回执后，反馈才会进入待处理。"}</p><button className="secondary-button" disabled={busy || !state?.enabled} onClick={() => void refresh()}><RefreshCw size={16} />刷新进度</button></div>
      {state?.refreshError && <p className="feedback-note" role="status">{state.refreshError}</p>}
      {!state?.items.length ? <div className="feedback-empty"><MessageCircle size={32} /><h2>还没有反馈记录</h2><p>遇到问题或想到新点子，随时告诉我们。</p><button className="secondary-button" onClick={() => setTab("compose")}>写下第一条反馈</button></div>
        : <ol className="feedback-list">{state.items.map((item) => <li key={item.id}>
          <div className="feedback-item-head"><strong>{categoryLabels[item.category] || "用户反馈"}</strong><span className={`feedback-status is-${item.delivery === "sent" ? item.status : "queued"}`} role="status">{itemStatus(item)}</span></div>
          <p className="feedback-item-text">{item.text}</p>
          <div className="feedback-item-meta"><span>提交时间：{date(item.createdAt)}</span>{item.updatedAt && <span>状态更新：{date(item.updatedAt)}</span>}</div>
          <div className="feedback-item-meta"><span className="feedback-number">{item.delivery === "sent" ? "反馈编号" : "本机记录编号"}：{item.id}</span><span>{item.includeDiagnostics ? `已附带 ${item.diagnosticCount} 条脱敏诊断` : "仅反馈文字"}</span></div>
          {item.error && <div className="feedback-item-error"><p>{item.error}</p>{item.delivery === "failed" && item.retryable && <button className="secondary-button" disabled={busy || !state.enabled} onClick={() => void retry(item.id)}>重新发送</button>}</div>}
        </li>)}</ol>}
    </div>}
    <details className="feedback-diagnostics" open={diagnosticsOpen} onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}>
      <summary><div><strong>日志诊断</strong><span>需要进一步排查时，查看日志或导出诊断包。</span></div><ChevronDown size={18} /></summary>
      {diagnosticsOpen && <Suspense fallback={<p className="feedback-note">正在读取诊断工具…</p>}><Diagnostics appVersion={appVersion} edition={edition} buildId={buildId} /></Suspense>}
    </details>
  </section>;
}
