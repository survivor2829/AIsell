import { useEffect, useState, type FormEvent } from "react";
import { ArrowUpRight, Check, CirclePause, MessageCircle, Plus, RefreshCw, Search, Send, Sparkles, UserRound } from "lucide-react";
import type { KeywordLead, KeywordResult, KeywordState, KeywordTask, KeywordTaskInput } from "./keyword-acquisition-types";
import "./KeywordAcquisitionPage.css";

const newTask = (): KeywordTaskInput => ({ name: "", keywords: "", firstMessage: "", limit: 30, contactLimit: 5, autoContact: false });
const statusLabel: Record<string, string> = { ready: "待开始", running: "查找中", paused: "已暂停", completed: "本轮完成", blocked: "待处理", new: "新线索", qualified: "待跟进", ignored: "已忽略", contacted: "已联系" };
const browserLabel: Record<string, string> = { closed: "未连接", checking: "核对账号中", login_required: "待登录", connected: "已连接", identity_unavailable: "账号待确认", verification_required: "待验证", interrupted: "连接已中断" };

export function KeywordAcquisitionPage() {
  const api = window.xiaoxiKeywordAcquisition;
  const [state, setState] = useState<KeywordState>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<"tasks" | "leads" | "conversations">("tasks");
  const [editing, setEditing] = useState<KeywordTaskInput | null>(null);
  const [addingLead, setAddingLead] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualComment, setManualComment] = useState("");
  const [selectedLeadId, setSelectedLeadId] = useState("");
  const [draft, setDraft] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const selectedLead = state?.leads.find((lead) => lead.id === selectedLeadId);
  const conversation = state?.conversations.find((item) => item.leadId === selectedLeadId);
  const unknownAttempt = state?.attempts.find((attempt) => attempt.leadId === selectedLeadId && attempt.status === "outcome_unknown");
  const busy = Boolean(pending || state?.busy);

  useEffect(() => {
    if (!api) { setError("关键词获客服务尚未连接，请重新打开桌面应用。"); setLoading(false); return; }
    let active = true; let received = false;
    const unsubscribe = api.onUpdate((next) => { if (active) { received = true; setState(next); } });
    void api.status().then((result) => { if (!active) return; if (result.state && !received) setState(result.state); if (!result.ok) setError(result.error || "任务读取失败。"); })
      .catch(() => { if (active) setError("记录读取失败，请重新打开页面。"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; unsubscribe(); };
  }, [api]);
  useEffect(() => { if (!draftDirty) setDraft(conversation?.draft || ""); }, [conversation?.draft, selectedLeadId, draftDirty]);

  const run = async (key: string, operation: () => Promise<KeywordResult>, success = "") => {
    if (pending) return false;
    setPending(key); setError(""); setNotice("");
    try {
      const result = await operation();
      if (result.state) setState(result.state);
      if (!result.ok) { setError(result.error || "操作未完成，请重试。"); return false; }
      if (success) setNotice(success);
      return true;
    } catch { setError("操作未完成，已有记录已保留，请重试。"); return false; }
    finally { setPending(""); }
  };
  const chooseLead = async (lead: KeywordLead) => {
    if (draftDirty && selectedLead && api) {
      const saved = await run("save-draft", () => api.saveConversation({ leadId: selectedLead.id, draft }));
      if (!saved) return;
    }
    if (api && !state?.conversations.some((item) => item.leadId === lead.id)) {
      if (!await run("open-record", () => api.saveConversation({ leadId: lead.id }))) return;
    }
    setDraftDirty(false); setSelectedLeadId(lead.id); setTab("conversations");
  };
  const editTask = (task: KeywordTask) => { setEditing({ ...task, contactLimit: task.contactLimit || 5, keywords: task.keywords.join("\n") }); setTab("tasks"); };
  const saveTask = async (event: FormEvent) => {
    event.preventDefault(); if (!api || !editing) return;
    if (await run("save-task", () => api.saveTask(editing), "任务已保存。")) setEditing(null);
  };
  const saveManualLead = async (event: FormEvent) => {
    event.preventDefault(); if (!api) return;
    if (await run("save-lead", () => api.saveLead({ name: manualName, comment: manualComment }), "线索已保存。")) { setAddingLead(false); setManualName(""); setManualComment(""); }
  };
  const saveDraft = async () => {
    if (!api || !selectedLead) return;
    if (await run("save-draft", () => api.saveConversation({ leadId: selectedLead.id, draft }), "草稿已保存。")) setDraftDirty(false);
  };
  const sendDraft = async () => {
    if (!api || !selectedLead) return;
    await run("send-draft", async () => { const saved = await api.saveConversation({ leadId: selectedLead.id, draft }); if (!saved.ok) return saved; setDraftDirty(false); return api.sendDraft(selectedLead.id); }, "发送结果已核实。");
  };

  return <section className="page keyword-page">
    <div className="page-head keyword-heading"><div><h1>关键词获客</h1><p>从相关内容中发现需求，接着聊。</p></div>
      <button type="button" className="primary-button" disabled={!api || Boolean(pending)} onClick={() => { setEditing(newTask()); setTab("tasks"); }}><Plus size={16} />新建任务</button>
    </div>
    <div className="keyword-connection"><div><span className={`keyword-connection-dot ${state?.browser.state === "connected" ? "is-connected" : ""}`} /><strong>抖音</strong><span>{state?.browser.account?.name || browserLabel[state?.browser.state || "closed"] || "待连接"}</span></div>
      <div><button type="button" className="secondary-button" disabled={!api || busy} onClick={() => api && void run("connect", () => api.openBrowser())}><ArrowUpRight size={15} />{state?.browser.state === "closed" || !state ? "连接抖音" : "打开抖音"}</button>
        {state?.browser.state !== "closed" && state && <button type="button" className="keyword-text-button" disabled={!api || busy} onClick={() => api && void run("account", () => api.refreshAccount())}><RefreshCw size={14} />刷新账号</button>}</div>
    </div>
    {(error || notice) && <div className={`keyword-feedback ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>{!error && <Check size={16} />}{error || notice}</div>}
    <div className="keyword-tabs" role="tablist" aria-label="关键词获客">
      {([['tasks', '任务'], ['leads', '线索'], ['conversations', '会话']] as const).map(([key, label]) => <button type="button" key={key} role="tab" aria-selected={tab === key} aria-controls={`keyword-panel-${key}`} id={`keyword-tab-${key}`} onClick={() => setTab(key)}>{label}{key === "leads" && Boolean(state?.leads.length) && <span>{state!.leads.length}</span>}</button>)}
    </div>
    {loading ? <div className="keyword-empty" role="status">正在读取记录…</div> : <>
      {tab === "tasks" && <div id="keyword-panel-tasks" role="tabpanel" aria-labelledby="keyword-tab-tasks">
        {editing && <form className="keyword-editor" onSubmit={(event) => void saveTask(event)}>
          <h2>{editing.id ? "编辑任务" : "从一个关键词开始"}</h2>
          <div className="keyword-form-grid"><label>任务名称<input value={editing.name} maxLength={80} placeholder="选填，默认使用关键词" onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
            <label>本次查看评论数<select value={editing.limit} onChange={(event) => setEditing({ ...editing, limit: Number(event.target.value) })}><option value={30}>30 条</option><option value={50}>50 条</option><option value={100}>100 条</option></select></label></div>
          <label>关键词<textarea required rows={3} value={String(editing.keywords)} placeholder="每行一个关键词" maxLength={800} onChange={(event) => setEditing({ ...editing, keywords: event.target.value })} /></label>
          <label>首条私信<span className="keyword-optional">选填</span><textarea rows={2} value={editing.firstMessage} placeholder="找到意向客户后，你想怎样开场？" maxLength={1000} onChange={(event) => setEditing({ ...editing, firstMessage: event.target.value })} /></label>
          <div className="keyword-form-grid"><label>最多联系人数<input type="number" min={1} max={100} required value={editing.contactLimit} onChange={(event) => setEditing({ ...editing, contactLimit: Number(event.target.value) })} /></label><div className="keyword-expert-reference"><span>AI 专家</span><strong>你的 AI 专家</strong><small>{state?.expertReady ? "已配置" : "待配置"}</small></div></div>
          <label className="keyword-check"><input type="checkbox" checked={editing.autoContact} onChange={(event) => setEditing({ ...editing, autoContact: event.target.checked })} />找到购买信号后自动发送首条私信</label>
          <div className="keyword-actions"><button className="primary-button" disabled={Boolean(pending)}>{pending === "save-task" ? "保存中…" : "保存任务"}</button><button type="button" className="secondary-button" onClick={() => setEditing(null)}>取消</button></div>
        </form>}
        {!state?.tasks.length && !editing ? <div className="keyword-empty"><Search size={28} /><h2>找一找正在咨询的人</h2><p>新建任务，填入关键词，然后开始查找。</p><button type="button" className="secondary-button" disabled={!api} onClick={() => setEditing(newTask())}>新建任务</button></div> : <div className="keyword-task-list">
          {state?.tasks.map((task) => { const latest = state.runs.find((item) => item.id === task.lastRunId); return <article className="keyword-task-row" key={task.id}>
            <div><div className="keyword-task-title"><h2>{task.name}</h2><span className={`keyword-status is-${task.status}`}>{statusLabel[task.status] || task.status}</span></div><p>{task.keywords.join(" · ")}</p>
              {latest && <div className={`keyword-run-detail ${latest.status === "blocked" ? "is-error" : ""}`}>{latest.reason || latest.detail}</div>}</div>
            <div className="keyword-actions"><button type="button" className="keyword-text-button" disabled={busy} onClick={() => editTask(task)}>编辑</button>{task.status === "running" ? <button type="button" className="secondary-button" disabled={Boolean(pending)} onClick={() => api && void run("stop", () => api.stop())}><CirclePause size={15} />停止</button> : <button type="button" className="secondary-button" disabled={!api || busy} onClick={() => api && void run(`start-${task.id}`, () => api.startTask(task.id))}><Search size={15} />开始查找</button>}</div>
          </article>; })}
        </div>}
      </div>}
      {tab === "leads" && <div id="keyword-panel-leads" role="tabpanel" aria-labelledby="keyword-tab-leads">
        <div className="keyword-section-toolbar"><span>{state?.leads.length || 0} 条线索</span><button type="button" className="keyword-text-button" disabled={!api} onClick={() => setAddingLead(!addingLead)}><Plus size={14} />录入线索</button></div>
        {addingLead && <form className="keyword-editor" onSubmit={(event) => void saveManualLead(event)}><h2>录入线索</h2><label>客户称呼<input value={manualName} onChange={(event) => setManualName(event.target.value)} required maxLength={100} /></label><label>需求原话<textarea rows={3} value={manualComment} onChange={(event) => setManualComment(event.target.value)} required maxLength={2000} /></label><div className="keyword-actions"><button className="primary-button" disabled={Boolean(pending)}>保存线索</button><button type="button" className="secondary-button" onClick={() => setAddingLead(false)}>取消</button></div></form>}
        {!state?.leads.length ? <div className="keyword-empty"><UserRound size={28} /><h2>线索会留在这里</h2><p>查找任务发现购买信号后，会保留评论原话和来源。</p></div> : <div className="keyword-lead-list">{state.leads.map((lead) => <article key={lead.id} className="keyword-lead-row"><div><div className="keyword-task-title"><strong>{lead.name}</strong><span className="keyword-status">{statusLabel[lead.status] || lead.status}</span><span className="keyword-source">{lead.source === "manual" ? "手动录入" : lead.keyword}</span></div><p className="keyword-comment">{lead.comment}</p><div className="keyword-signals">{lead.signals.map((signal) => <span key={signal}>{signal}</span>)}</div></div><div className="keyword-actions">{lead.sourceUrl && <button type="button" className="keyword-text-button" disabled={busy} onClick={() => api && void run("source", () => api.openSource(lead.id))}>查看来源<ArrowUpRight size={13} /></button>}<button type="button" className="secondary-button" disabled={Boolean(pending)} onClick={() => void chooseLead(lead)}><MessageCircle size={15} />跟进</button></div></article>)}</div>}
      </div>}
      {tab === "conversations" && <div id="keyword-panel-conversations" role="tabpanel" aria-labelledby="keyword-tab-conversations">
        {!state?.leads.length ? <div className="keyword-empty"><MessageCircle size={28} /><h2>有线索，再开始聊</h2><p>选择一条线索，写好第一句话。</p><button type="button" className="secondary-button" onClick={() => setTab("leads")}>查看线索</button></div> : <div className="keyword-conversation-layout"><aside aria-label="选择客户">{state.leads.filter((lead) => lead.status !== "ignored").map((lead) => <button key={lead.id} type="button" className={selectedLeadId === lead.id ? "is-selected" : ""} disabled={Boolean(pending)} onClick={() => void chooseLead(lead)}><strong>{lead.name}</strong><span>{lead.comment}</span></button>)}</aside>
          {selectedLead ? <section className="keyword-conversation"><header><div><h2>{selectedLead.name}</h2><span>{conversation?.mode === "auto" ? "AI 接待中" : "人工跟进"}</span></div><div className="keyword-actions">{selectedLead.source === "douyin" && <><button type="button" className="keyword-text-button" disabled={busy} onClick={() => api && void run("open-chat", () => api.openConversation(selectedLead.id))}>打开私信<ArrowUpRight size={13} /></button><button type="button" className="keyword-text-button" disabled={busy} onClick={() => api && void run("sync-chat", () => api.syncConversation(selectedLead.id))}><RefreshCw size={14} />同步</button></>}
            {conversation?.mode === "auto" ? <button type="button" className="secondary-button" disabled={Boolean(pending)} onClick={() => api && void run("takeover", () => api.saveConversation({ leadId: selectedLead.id, mode: "human" }))}>人工接管</button> : state.browser.capabilities.send && state.browser.capabilities.inbox && selectedLead.source === "douyin" && <button type="button" className="secondary-button" disabled={busy || Boolean(unknownAttempt)} onClick={() => api && void run("auto-reply", () => api.saveConversation({ leadId: selectedLead.id, mode: "auto" }))}>开启 AI 接待</button>}</div></header>
            <div className="keyword-origin"><span>需求原话</span><p>{selectedLead.comment}</p></div>
            {(unknownAttempt || conversation?.lastReason) && <div className="keyword-feedback is-error" role="status">{unknownAttempt?.reason || conversation?.lastReason}</div>}
            <div className="keyword-messages" aria-label="已同步消息">{conversation?.messages.length ? conversation.messages.map((message) => <div key={message.id} className={`keyword-message is-${message.direction}`}><span>{message.direction === "incoming" ? selectedLead.name : "我"}</span><p>{message.text}</p></div>) : <p className="keyword-conversation-empty">暂无已同步的私信。</p>}</div>
            <div className="keyword-draft"><label htmlFor="keyword-draft">私信草稿{draftDirty && <span className="keyword-optional">未保存</span>}</label><textarea id="keyword-draft" rows={4} maxLength={1000} value={draft} placeholder="写一句自然的开场白…" onChange={(event) => { setDraft(event.target.value); setDraftDirty(true); }} disabled={conversation?.mode === "auto"} />
              <div className="keyword-draft-actions"><div className="keyword-actions"><button type="button" className="keyword-text-button" disabled={!api || busy || conversation?.mode === "auto"} onClick={() => api && void run("ai-draft", async () => { const saved = await api.saveConversation({ leadId: selectedLead.id, draft }); if (!saved.ok) return saved; setDraftDirty(false); return api.generateDraft(selectedLead.id); })}><Sparkles size={15} />{pending === "ai-draft" ? "正在写…" : "AI 写回复"}</button><button type="button" className="keyword-text-button" disabled={Boolean(pending) || !draftDirty} onClick={() => void saveDraft()}>保存草稿</button></div>
                <button type="button" className="primary-button" disabled={!api || busy || !draft.trim() || !state.browser.capabilities.send || selectedLead.source !== "douyin" || Boolean(unknownAttempt) || conversation?.mode === "auto"} onClick={() => void sendDraft()}><Send size={15} />发送私信</button></div>
              {!state.browser.capabilities.send && <p className="keyword-footnote">私信通道待验证，当前可保存草稿并打开抖音跟进。</p>}
            </div>
          </section> : <div className="keyword-empty"><p>选择一位客户开始跟进。</p></div>}
        </div>}
      </div>}
    </>}
  </section>;
}
