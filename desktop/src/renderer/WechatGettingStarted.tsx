import { Check, ChevronRight, X } from "lucide-react";
import { useEffect, useState } from "react";
import { WorkflowToggle, type WorkflowController, type WorkflowTaskType } from "./WechatWorkflow";

type Choice = "reply" | "touch" | "moments";
type Props = {
  active: string; connected: boolean; aiConfigured: boolean; workflow: WorkflowController;
  onOpen: (target: "contact-sync" | "expert" | "reply" | "api-key") => void;
  onEditor: (type: WorkflowTaskType) => void;
  onClose: () => void;
};
export function WechatGettingStarted({ active, connected, aiConfigured, workflow, onOpen, onEditor, onClose }: Props) {
  const [choice, setChoice] = useState<Choice | null>(null);
  const [momentsType, setMomentsType] = useState<"publish" | "interact">("publish");
  const [expertReady, setExpertReady] = useState(false);
  const [readError, setReadError] = useState("");
  const [checking, setChecking] = useState(false);
  const refresh = async () => {
    setChecking(true);
    try {
      const result = await window.xiaoxiAiExpert?.status();
      setExpertReady(Boolean(result?.ok && result.data?.ready));
      setReadError(result?.ok ? "" : "专家状态未读取成功，可重试。");
    } catch { setReadError("专家状态未读取成功，可重试。"); }
    finally { setChecking(false); }
  };
  useEffect(() => { void refresh(); }, [active]);
  const taskType = choice === "touch" ? "touch" : momentsType;
  const needsExpert = choice === "reply";
  const saved = choice === "reply"
    ? workflow.state.replyEnabled !== false && workflow.state.recipients.length > 0
    : workflow.state.tasks.some(task => task.type === taskType && task.status === "pending" && !task.accountMismatch);
  const needsAiConnection = needsExpert && !aiConfigured;
  const ready = connected && !needsAiConnection && (!needsExpert || expertReady) && saved;
  const step = !connected ? "连接微信" : needsAiConnection ? "连接 AI 服务" : needsExpert && !expertReady ? "建立你的AI专家" : !saved ? choice === "reply" ? "选择回复联系人" : "填写任务并保存" : "确认后启动";
  const go = () => { if (!connected) onOpen("contact-sync"); else if (needsAiConnection) onOpen("api-key"); else if (needsExpert && !expertReady) onOpen("expert"); else if (choice === "reply") onOpen("reply"); else onEditor(taskType); };
  return <section className="wechat-getting-started" aria-label="微信拓客开始引导">
    <div className="wechat-guide-heading"><div><h2>带我开始</h2><p>{choice ? "按提示完成设置，准备好后由你启动。" : "你想先让微信拓客帮你做什么？"}</p></div><button className="icon-button" aria-label="收起开始引导" onClick={onClose}><X size={18} /></button></div>
    <div className="wechat-guide-choices" role="group" aria-label="选择工作">
      {([ ["reply", "自动回复"], ["touch", "精准触达"], ["moments", "朋友圈运营"] ] as const).map(([key, label]) => <button key={key} className={choice === key ? "primary-button" : "secondary-button"} aria-pressed={choice === key} onClick={() => setChoice(key)}>{label}</button>)}
    </div>
    {choice && <>
      {choice === "moments" && <div className="wechat-guide-choices" role="group" aria-label="朋友圈任务"><button className="secondary-button" aria-pressed={momentsType === "publish"} onClick={() => setMomentsType("publish")}>发朋友圈</button><button className="secondary-button" aria-pressed={momentsType === "interact"} onClick={() => setMomentsType("interact")}>朋友圈互动</button></div>}
      <ol className="wechat-guide-steps"><li className={connected ? "is-done" : ""}>{connected && <Check size={14} />}连接微信</li>{needsExpert && <li className={expertReady ? "is-done" : ""}>{expertReady && <Check size={14} />}建立专家</li>}<li className={saved ? "is-done" : ""}>{saved && <Check size={14} />}{choice === "reply" ? "保存回复联系人" : "保存任务"}</li><li>确认并启动</li></ol>
      <div className="wechat-guide-next"><div><strong>{step}</strong><p>{!connected ? "打开连接页面，确认当前微信并同步联系人。" : needsAiConnection ? "自动回复需要 AI 服务。保存连接配置后，继续建立专家。" : needsExpert && !expertReady ? "说明业务和接待方式，保存专家资料后回来继续。" : !saved ? choice === "reply" ? "在自动回复页面选定联系人并保存；只会回复你选中的人。" : "打开任务编辑器，选择对象、填写内容，并点击保存任务。" : "设置已保存。启动会执行当前计划中的任务，请先检查对象与内容。"}</p></div>{ready ? <WorkflowToggle workflow={workflow} /> : <button className="primary-button" onClick={go}>{step}<ChevronRight size={16} /></button>}</div>
      {needsExpert && <div className="wechat-guide-refresh"><button className="text-button" disabled={checking} onClick={() => void refresh()}>{checking ? "正在检查…" : "已保存专家，检查状态"}</button>{readError && <span role="status">{readError}</span>}</div>}
    </>}
  </section>;
}
