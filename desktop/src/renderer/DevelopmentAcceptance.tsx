import { Lock, MessageCircle, Send } from "lucide-react";
import { useState } from "react";

type Contact = { id: string; name: string; allowed: boolean };
type Result = { ok: boolean; error?: string; state?: { real_send_armed?: boolean } };

export default function DevelopmentAcceptance({ contacts, message }: { contacts: Contact[]; message: string }) {
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [status, setStatus] = useState("");
  const target = contacts.find((contact) => contact.allowed);

  const run = async (action: () => Promise<Result>) => {
    if (!window.xiaoxiActiveTouch) return setStatus("开发执行器未连接");
    setBusy(true);
    try {
      const result = await action();
      if (result.state?.real_send_armed !== undefined) setArmed(Boolean(result.state.real_send_armed));
      setStatus(result.ok ? "执行完成" : result.error || "执行失败");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "执行失败");
    } finally {
      setBusy(false);
    }
  };

  const sendOne = () => {
    if (!target || !message.trim()) return setStatus("请先同步联系人并填写话术");
    if (!window.confirm(`确认只向 ${target.name} 真实发送一条消息？`)) return;
    void run(() => window.xiaoxiActiveTouch!.sendReal({ message }));
  };

  return (
    <details className="debug-panel">
      <summary>开发验收（开发版）</summary>
      <div className="debug-actions">
        <button className="secondary-button" onClick={() => void run(() => window.xiaoxiActiveTouch!.setRealSendArm({ enabled: !armed }))} disabled={busy}>
          <Lock size={17} />
          {armed ? "关闭真发开关" : "武装真发开关"}
        </button>
        <button className="danger-button" onClick={sendOne} disabled={busy || !armed}>
          <Send size={17} />
          单人真发测试
        </button>
        <button className="secondary-button" onClick={() => void run(() => window.xiaoxiActiveTouch!.verifyMessageBubble())} disabled={busy}>
          <MessageCircle size={17} />
          消息气泡验证
        </button>
        <button className="text-button inline-text-button" onClick={() => void run(() => window.xiaoxiActiveTouch!.failConversation())} disabled={busy}>
          模拟会话不匹配
        </button>
      </div>
      {status && <div className="touch-notice">{status}</div>}
    </details>
  );
}
