import { MessageCircle, Pause, Play, RefreshCw, UsersRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Contact = { id: string; name: string; remark?: string; nickname?: string; wechatId?: string; allowed: boolean };
type AutoReplyState = {
  status: string;
  contact_ids: string[];
  instruction: string;
  work_start: string;
  work_end: string;
  reply_count: number;
  skipped_count: number;
  last_event: string;
  last_error: string;
  updated_at: string;
};
type AutoReplyResult = { ok: boolean; state?: Partial<AutoReplyState>; error?: string };

declare global {
  interface Window {
    xiaoxiAutoReply?: {
      status: () => Promise<AutoReplyResult>;
      start: (payload: { contactIds: string[]; instruction: string; workStart: string; workEnd: string }) => Promise<AutoReplyResult>;
      pause: () => Promise<AutoReplyResult>;
    };
  }
}

const EMPTY_STATE: AutoReplyState = {
  status: "stopped",
  contact_ids: [],
  instruction: "礼貌、简短地回复；信息不足时先问一个澄清问题",
  work_start: "09:00",
  work_end: "18:00",
  reply_count: 0,
  skipped_count: 0,
  last_event: "",
  last_error: "",
  updated_at: ""
};

const eventLabels: Record<string, string> = {
  started: "正在监听白名单未读消息",
  no_unread_message: "暂未发现白名单未读消息",
  reply_sent_verified: "回复已发送并验证",
  duplicate_skipped: "重复来信已跳过",
  unsupported_or_risky_message: "非文字或风险内容已跳过",
  contact_cooldown: "联系人仍在30分钟冷却期",
  manual_reply_or_message_changed: "检测到人工接管或新消息，已取消发送",
  outside_work_hours: "当前不在设定工作时间",
  daily_limit_reached: "今日已达到20条安全上限",
  wechat_operation_busy: "微信正在执行其他任务，稍后继续",
  send_failed_paused: "发送校验失败，已自动暂停",
  auto_reply_error_paused: "运行异常，已自动暂停",
  paused_by_user: "已由用户暂停",
  app_closed: "应用关闭，自动回复已暂停",
  recovered_after_restart: "检测到应用重启，已安全暂停，请人工重新启动"
};

function contactName(contact: Contact) {
  return contact.name || contact.remark || contact.nickname || contact.wechatId || contact.id;
}

export function AutoReply({ contacts, onOpenSync, onOpenAccounts }: { contacts: Contact[]; onOpenSync: () => void; onOpenAccounts: () => void }) {
  const [state, setState] = useState<AutoReplyState>(EMPTY_STATE);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [instruction, setInstruction] = useState(EMPTY_STATE.instruction);
  const [workStart, setWorkStart] = useState(EMPTY_STATE.work_start);
  const [workEnd, setWorkEnd] = useState(EMPTY_STATE.work_end);
  const [contactQuery, setContactQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hydrated = useRef(false);

  const applyResult = (result: AutoReplyResult) => {
    if (result.state) {
      setState((current) => ({ ...current, ...result.state }));
      if (!hydrated.current) {
        setSelectedIds(result.state.contact_ids || []);
        setInstruction(result.state.instruction || EMPTY_STATE.instruction);
        setWorkStart(result.state.work_start || EMPTY_STATE.work_start);
        setWorkEnd(result.state.work_end || EMPTY_STATE.work_end);
        hydrated.current = true;
      }
    }
    setError(result.ok ? "" : result.error || "自动回复操作失败");
  };

  const refresh = () => {
    if (!window.xiaoxiAutoReply) return setError("当前版本未连接自动回复执行器");
    void window.xiaoxiAutoReply.status().then(applyResult).catch(() => setError("读取自动回复状态失败"));
  };

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => window.clearInterval(timer);
  }, []);

  const toggleContact = (id: string) => {
    if (state.status === "running") return;
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length < 20 ? [...current, id] : current);
  };

  const start = () => {
    if (!selectedIds.length) return setError("请先选择至少一位白名单联系人");
    if (!window.xiaoxiAutoReply) return setError("当前版本未连接自动回复执行器");
    setBusy(true);
    setError("");
    void window.xiaoxiAutoReply.start({ contactIds: selectedIds, instruction, workStart, workEnd })
      .then(applyResult)
      .catch(() => setError("启动自动回复失败"))
      .finally(() => setBusy(false));
  };

  const pause = () => {
    if (!window.xiaoxiAutoReply) return;
    setBusy(true);
    void window.xiaoxiAutoReply.pause().then(applyResult).catch(() => setError("暂停自动回复失败")).finally(() => setBusy(false));
  };

  const running = state.status === "running";
  const lastUpdated = state.updated_at ? new Date(state.updated_at).toLocaleString("zh-CN", { hour12: false }) : "暂无";
  const statusLabel = running ? "监听中" : state.status === "paused" ? "已暂停" : "未启动";
  const visibleContacts = contacts.filter((contact) => {
    if (contact.allowed === false) return false;
    const query = contactQuery.trim().toLowerCase();
    return !query || `${contactName(contact)} ${contact.wechatId || ""}`.toLowerCase().includes(query);
  });

  return (
    <section className="page agent-page auto-reply-page">
      <div className="page-head">
        <div>
          <h1>自动回复</h1>
          <p>只监听白名单联系人的未读文字消息。发送前会再次核对最新来信；人工回复、新消息、风险内容或识别不确定时不会发送。</p>
        </div>
        <div className="actions">
          <button className="secondary-button" onClick={refresh} disabled={busy}><RefreshCw size={17} />刷新状态</button>
          {running ? (
            <button className="danger-button" onClick={pause} disabled={busy}><Pause size={17} />暂停自动回复</button>
          ) : (
            <button data-xiaoxi-auto-reply-start className="primary-button" onClick={start} disabled={busy || !contacts.length}><Play size={17} />启动自动回复</button>
          )}
        </div>
      </div>

      <div className="status-strip">
        <div className="status-card"><span>运行状态</span><strong className={running ? "ok" : "warn"}>{statusLabel}</strong></div>
        <div className="status-card"><span>今日已回复</span><strong>{state.reply_count} / 20</strong></div>
        <div className="status-card"><span>今日安全跳过</span><strong>{state.skipped_count}</strong></div>
        <div className="status-card"><span>最近更新</span><strong>{lastUpdated}</strong></div>
      </div>

      {(error || state.last_error) && <div className="touch-notice">{error || state.last_error}</div>}
      <div className="auto-reply-event"><MessageCircle size={17} /><span>{eventLabels[state.last_event] || "配置白名单后即可启动"}</span></div>

      <div className="auto-reply-grid">
        <div className="table-panel auto-reply-settings">
          <div className="panel-title">回复设置</div>
          <label className="script-field">
            <span>回复要求</span>
            <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} disabled={running} maxLength={200} />
          </label>
          <div className="auto-reply-hours">
            <label><span>开始时间</span><input type="time" value={workStart} onChange={(event) => setWorkStart(event.target.value)} disabled={running} /></label>
            <label><span>结束时间</span><input type="time" value={workEnd} onChange={(event) => setWorkEnd(event.target.value)} disabled={running} /></label>
          </div>
          <p className="auto-reply-help">单个联系人30分钟内最多回复一次；每日最多20条。DeepSeek Key 请在账号管理中配置。</p>
          <button className="text-button inline-text-button" onClick={onOpenAccounts}>打开账号管理</button>
        </div>

        <div className="table-panel auto-reply-whitelist">
          <div className="panel-title"><UsersRound size={17} />白名单联系人（已选 {selectedIds.length} / 20）</div>
          <input className="auto-reply-search" type="search" value={contactQuery} onChange={(event) => setContactQuery(event.target.value)} placeholder="搜索联系人或微信号" aria-label="搜索自动回复联系人" />
          {contacts.length ? (
            visibleContacts.length ? <div className="auto-reply-contact-list">
              {visibleContacts.map((contact) => (
                <label key={contact.id} className="auto-reply-contact">
                  <input type="checkbox" checked={selectedIds.includes(contact.id)} onChange={() => toggleContact(contact.id)} disabled={running || (!selectedIds.includes(contact.id) && selectedIds.length >= 20)} />
                  <span><strong>{contactName(contact)}</strong><small>{contact.wechatId || contact.remark || "微信联系人"}</small></span>
                </label>
              ))}
            </div> : <div className="auto-reply-empty"><span>没有匹配的联系人</span></div>
          ) : (
            <div className="auto-reply-empty"><span>还没有可用联系人</span><button className="primary-button" onClick={onOpenSync}>先同步微信联系人</button></div>
          )}
        </div>
      </div>
    </section>
  );
}
