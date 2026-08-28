import { Send, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";

type Contact = { id: string; name: string; remark?: string; nickname?: string; wechatId?: string; allowed: boolean };
type Result = {
  ok: boolean;
  error?: string;
  blocked_reason?: string;
  send_attempted?: boolean | null;
  state?: {
    selected_customer?: { id?: string } | null;
    message_draft?: string;
    real_send_status?: string;
    real_send_reason?: string;
  };
};
type PendingSend = { contactId: string; message: string };
const SEND_STATUS_RECONCILE_DELAY_MS = 15_000;

export default function DevelopmentAcceptance({ contacts, message }: { contacts: Contact[]; message: string }) {
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("选择一位内部测试联系人，点击一次即可打开会话并直接发送。");
  const pendingSendRef = useRef<PendingSend | null>(null);
  const selected = contacts.find((contact) => contact.id === selectedId) ?? null;
  const eligibleContacts = contacts.filter((contact) => contact.allowed && contact.wechatId && contacts.filter((other) => other.name === contact.name).length === 1 && contacts.filter((other) => other.wechatId === contact.wechatId).length === 1);
  const identityReady = Boolean(selected?.wechatId && selected.name && contacts.filter((contact) => contact.name === selected.name).length === 1 && contacts.filter((contact) => contact.wechatId === selected.wechatId).length === 1);
  const resolvedMessage = selected ? message.replaceAll("{称呼}", selected.remark?.trim() || selected.nickname?.trim() || selected.name) : message;

  const run = async (action: () => Promise<Result>, success: string) => {
    if (!window.xiaoxiActiveTouch) {
      setStatus("开发执行器未连接");
      return { ok: false, error: "开发执行器未连接" };
    }
    setBusy(true);
    try {
      const result = await action();
      const exactReason = result.state?.real_send_reason;
      setStatus(result.ok ? success : result.error || (exactReason ? `发送结果无法确认：${exactReason}` : "") || result.blocked_reason || "执行被阻断");
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "执行失败";
      setStatus(detail);
      return { ok: false, error: detail };
    } finally {
      setBusy(false);
    }
  };

  const select = (id: string) => {
    pendingSendRef.current = null;
    setSelectedId(id);
    if (!id) return;
    void run(() => window.xiaoxiActiveTouch!.selectCustomer({ id }), "已选择联系人；点击按钮将直接发送。");
  };

  const reconcileSentStatus = async (pending: PendingSend) => {
    if (pendingSendRef.current !== pending || !window.xiaoxiActiveTouch?.status) return;
    try {
      const result = await window.xiaoxiActiveTouch.status();
      const state = result.state;
      const sameContact = state?.selected_customer?.id === pending.contactId;
      const sameMessage = String(state?.message_draft || "").trim() === pending.message;
      if (!sameContact || !sameMessage || state?.real_send_status !== "sent_verified") return;
      if (pendingSendRef.current !== pending) return;
      pendingSendRef.current = null;
      setStatus("发送成功，已验证最新消息气泡和完整文案。");
      setBusy(false);
    } catch {
      // The original request remains authoritative; this is only a read-only recovery path.
    }
  };

  const sendSelectedContact = () => {
    if (!selected) return;
    const pending = { contactId: selected.id, message: resolvedMessage.trim() };
    pendingSendRef.current = pending;
    setStatus("正在打开微信、验证会话并发送，请稍候……");
    const request = run(
      () => window.xiaoxiActiveTouch!.sendSelectedContact({ contactId: selected.id, message: resolvedMessage }),
      "发送成功，已验证最新消息气泡和完整文案。"
    );
    void request.finally(() => {
      if (pendingSendRef.current === pending) pendingSendRef.current = null;
    });
    window.setTimeout(() => {
      void reconcileSentStatus(pending);
    }, SEND_STATUS_RECONCILE_DELAY_MS);
  };

  return (
    <section className="dev-acceptance">
      <div className="dev-acceptance-head"><strong>内部测试 · 单联系人真实发送</strong><span>仅测试版</span></div>
      <div className="dev-control-row">
        <label>测试联系人<select value={selectedId} onChange={(event) => select(event.target.value)} disabled={busy}><option value="">请选择</option>{eligibleContacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.remark || contact.nickname || contact.name}</option>)}</select></label>
        <button className="danger-button" data-xiaoxi-real-send onClick={sendSelectedContact} disabled={busy || !identityReady || !resolvedMessage.trim()}><Send size={17} />直接发送</button>
      </div>
      {selected && <div className="dev-contact-summary">备注：{selected.remark || "-"}　昵称：{selected.nickname || selected.name}　微信号：{selected.wechatId || "缺失，禁止发送"}<br />发送文案：{resolvedMessage || "（空，禁止发送）"}</div>}
      {!eligibleContacts.length && <div className="dev-status is-blocked">没有可唯一确认微信号的联系人；请重新同步或改用有微信号的测试联系人。</div>}
      {!identityReady && selected && <div className="dev-status is-blocked">同名、空微信号或身份不唯一，不能发送。</div>}
      <div className="dev-status"><ShieldCheck size={16} />{status}</div>
    </section>
  );
}
