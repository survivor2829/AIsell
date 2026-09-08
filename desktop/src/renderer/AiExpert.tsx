import { Check, FileUp, Send } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import "./WechatWorkflow.css";

type AiExpertKind = "expert_rules" | "business_knowledge";
type AiExpertSlotStatus = { configured: boolean; fileName: string; importedAt: string; text?: string };
type AiExpertStatus = { expertRules: AiExpertSlotStatus; businessKnowledge: AiExpertSlotStatus; ready: boolean };
type AiExpertResult = { ok: boolean; data?: Partial<AiExpertStatus>; code?: string; error?: string };
type ExpertMessage = { role: string; content: string };
type ExpertConversationResult = { ok: boolean; data?: { messages: ExpertMessage[]; expertRules: string; businessKnowledge: string }; error?: string };

declare global {
  interface Window {
    xiaoxiAiExpert?: {
      status: () => Promise<AiExpertResult>;
      chooseAndImport: (kind: AiExpertKind) => Promise<AiExpertResult>;
      remove: (kind: AiExpertKind) => Promise<AiExpertResult>;
      read: () => Promise<AiExpertResult>;
      conversation: () => Promise<ExpertConversationResult>;
      chat: (payload: { message: string; expertRules?: string; businessKnowledge?: string }) => Promise<ExpertConversationResult>;
      save: (payload: { expertRules: string; businessKnowledge: string }) => Promise<AiExpertResult>;
    };
  }
}

const EMPTY_SLOT: AiExpertSlotStatus = { configured: false, fileName: "", importedAt: "" };
const EMPTY_STATUS: AiExpertStatus = { expertRules: EMPTY_SLOT, businessKnowledge: EMPTY_SLOT, ready: false };

export function AiExpert() {
  const [status, setStatus] = useState<AiExpertStatus>(EMPTY_STATUS);
  const [messages, setMessages] = useState<ExpertMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [rules, setRules] = useState("");
  const [knowledge, setKnowledge] = useState("");
  const [tab, setTab] = useState<AiExpertKind>("expert_rules");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"chat" | "save" | "import" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const api = window.xiaoxiAiExpert;

  const acceptStatus = (result: AiExpertResult) => {
    if (!result.data) return;
    const expertRules = { ...EMPTY_SLOT, ...result.data.expertRules };
    const businessKnowledge = { ...EMPTY_SLOT, ...result.data.businessKnowledge };
    setStatus({ expertRules, businessKnowledge, ready: expertRules.configured && businessKnowledge.configured });
  };

  useEffect(() => {
    if (!api) { setError("AI 专家服务未连接，请重新打开应用。"); setLoading(false); return; }
    let disposed = false;
    void Promise.allSettled([api.read(), api.conversation()]).then(([documents, conversation]) => {
      if (disposed) return;
      let savedRules = "";
      let savedKnowledge = "";
      if (documents.status === "fulfilled" && documents.value.ok) {
        acceptStatus(documents.value);
        savedRules = documents.value.data?.expertRules?.text || "";
        savedKnowledge = documents.value.data?.businessKnowledge?.text || "";
        setRules(savedRules);
        setKnowledge(savedKnowledge);
      } else setError(documents.status === "fulfilled" ? documents.value.error || "专家资料读取失败，请重新打开页面。" : "专家资料读取失败，请重新打开页面。");
      if (conversation.status === "fulfilled" && conversation.value.ok && conversation.value.data) {
        const draft = conversation.value.data;
        setMessages(draft.messages || []);
        if (draft.expertRules || draft.businessKnowledge) {
          setRules(draft.expertRules || savedRules);
          setKnowledge(draft.businessKnowledge || savedKnowledge);
          setDirty(Boolean((draft.expertRules && draft.expertRules !== savedRules) || (draft.businessKnowledge && draft.businessKnowledge !== savedKnowledge)));
        }
      } else if (conversation.status === "rejected") setError("专家对话读取失败，已有资料仍可编辑使用。");
      setLoading(false);
    });
    return () => { disposed = true; };
  }, [api]);

  useEffect(() => { messagesEnd.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [messages]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const message = question.trim();
    if (!api || !message || busy) return;
    setBusy("chat"); setError(""); setNotice("");
    try {
      const result = await api.chat({ message, expertRules: rules, businessKnowledge: knowledge });
      if (!result.ok || !result.data) { setError(result.error || "这次对话未完成，请稍后重试。"); return; }
      setMessages(result.data.messages);
      setRules(result.data.expertRules || rules);
      setKnowledge(result.data.businessKnowledge || knowledge);
      setQuestion("");
      setDirty(true);
    } catch { setError("对话未完成，请检查 AI 服务后重试。"); }
    finally { setBusy(null); }
  };

  const save = async () => {
    if (!api || busy) return;
    setBusy("save"); setError(""); setNotice("");
    try {
      const result = await api.save({ expertRules: rules.trim(), businessKnowledge: knowledge.trim() });
      if (!result.ok) { setError(result.error || "资料未保存，请重试。"); return; }
      acceptStatus(result); setDirty(false); setNotice("专家资料已保存，自动回复将使用这份资料。");
    } catch { setError("保存失败，当前文字已保留，请重试。"); }
    finally { setBusy(null); }
  };

  const importDocument = async () => {
    if (!api || busy) return;
    setBusy("import"); setError(""); setNotice("");
    try {
      const result = await api.chooseAndImport(tab);
      if (!result.ok) { if (result.error) setError(result.error); return; }
      acceptStatus(result);
      const read = await api.read();
      if (!read.ok) { setError(read.error || "导入后读取资料失败，请重新打开页面。"); return; }
      acceptStatus(read);
      if (tab === "expert_rules") setRules(read.data?.expertRules?.text || "");
      else setKnowledge(read.data?.businessKnowledge?.text || "");
      setNotice((tab === "expert_rules" ? "专家规则" : "业务知识") + "已导入。");
    } catch { setError("导入失败，请检查文件后重试。"); }
    finally { setBusy(null); }
  };

  const activeSlot = tab === "expert_rules" ? status.expertRules : status.businessKnowledge;
  return <section className="page workflow-expert-page">
    <div className="page-head workflow-page-head"><div><h1>你的AI专家</h1><p>聊聊你的业务与接待方式，AI 会整理成两份可编辑的专家资料。</p></div><span className={"ai-expert-state " + (status.ready ? "is-configured" : "")}>{dirty ? "有未保存内容" : status.ready ? "专家已就绪" : "待建立"}</span></div>
    {(error || notice) && <div className={error ? "workflow-alert" : "workflow-notice"} role={error ? "alert" : "status"}>{!error && <Check size={16} />}{error || notice}</div>}
    <div className="workflow-expert-layout">
      <section className="workflow-expert-conversation" aria-label="建立专家的对话">
        <h2>一起建立你的专家</h2>
        <div className="workflow-expert-messages" aria-live="polite">
          {loading ? <p className="workflow-small-note">正在读取已有对话…</p> : messages.length ? messages.filter((message) => message.role !== "system").map((message, index) => <div className={"workflow-expert-message " + (message.role === "user" ? "is-user" : "is-assistant")} key={index}><strong>{message.role === "user" ? "你" : "AI 专家"}</strong><p>{message.content}</p></div>) : <div className="workflow-expert-intro"><strong>先从你的业务开始</strong><p>你主要提供什么产品或服务？客户通常会问什么？希望 AI 用怎样的语气接待？</p><p>直接告诉我，也可以先在右侧导入现有资料。</p></div>}
          {busy === "chat" && <p className="workflow-small-note" role="status">正在整理你的业务信息…</p>}
          <div ref={messagesEnd} />
        </div>
        <form className="workflow-expert-composer" onSubmit={(event) => void send(event)}><label htmlFor="expert-question" className="workflow-sr-only">告诉 AI 你的业务信息</label><textarea id="expert-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：我们做清洁设备租赁，客户最关心价格、配送和售后……" rows={3} disabled={Boolean(busy) || loading || !api} /><div><span>可继续补充或纠正，资料会随对话更新。</span><button type="submit" className="primary-button" disabled={Boolean(busy) || loading || !question.trim() || !api}><Send size={15} />{busy === "chat" ? "整理中…" : "发送"}</button></div></form>
      </section>
      <section className="workflow-expert-documents" aria-label="专家资料">
        <div className="workflow-expert-document-head"><h2>专家资料</h2><button className="primary-button" onClick={() => void save()} disabled={Boolean(busy) || loading || !rules.trim() || !knowledge.trim() || !api}>{busy === "save" ? "保存中…" : "保存资料"}</button></div>
        <div className="workflow-expert-tabs" role="tablist" aria-label="资料类型"><button role="tab" id="expert-rules-tab" aria-controls="expert-document-panel" aria-selected={tab === "expert_rules"} onClick={() => setTab("expert_rules")}>专家规则</button><button role="tab" id="expert-knowledge-tab" aria-controls="expert-document-panel" aria-selected={tab === "business_knowledge"} onClick={() => setTab("business_knowledge")}>业务知识</button></div>
        <div id="expert-document-panel" role="tabpanel" aria-labelledby={tab === "expert_rules" ? "expert-rules-tab" : "expert-knowledge-tab"} className="workflow-expert-document-panel"><p>{tab === "expert_rules" ? "AI 的身份、语气、回答原则，以及何时交给人工。" : "产品、价格、适用场景、常见问题和售后政策。"}</p><label className="workflow-sr-only" htmlFor="expert-document-text">{tab === "expert_rules" ? "专家规则正文" : "业务知识正文"}</label><textarea id="expert-document-text" value={tab === "expert_rules" ? rules : knowledge} disabled={Boolean(busy) || loading || !api} placeholder={tab === "expert_rules" ? "对话后将在这里整理专家规则，也可以直接填写或导入。" : "对话后将在这里整理业务知识，也可以直接填写或导入。"} onChange={(event) => { if (tab === "expert_rules") setRules(event.target.value); else setKnowledge(event.target.value); setDirty(true); setNotice(""); }} /></div>
        <div className="workflow-expert-import"><span>{activeSlot.fileName || "已有文件？可直接导入"}</span><button className="secondary-button" onClick={() => void importDocument()} disabled={Boolean(busy) || loading || !api}><FileUp size={15} />{busy === "import" ? "导入中…" : "导入文件"}</button></div>
        <p className="workflow-small-note">支持 TXT、Markdown、Word；每份不超过 5MB。两份资料保存后用于自动回复。</p>
      </section>
    </div>
  </section>;
}
