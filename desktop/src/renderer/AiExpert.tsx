import { FileText, FileUp, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

type AiExpertStatus = {
  configured: boolean;
  fileName: string;
  extension: string;
  importedAt: string;
};
type AiExpertResult = { ok: boolean; data?: Partial<AiExpertStatus>; code?: string; error?: string };

declare global {
  interface Window {
    xiaoxiAiExpert?: {
      status: () => Promise<AiExpertResult>;
      chooseAndImport: () => Promise<AiExpertResult>;
      remove: () => Promise<AiExpertResult>;
    };
  }
}

const EMPTY_STATUS: AiExpertStatus = {
  configured: false,
  fileName: "",
  extension: "",
  importedAt: ""
};

function importedAtLabel(value: string) {
  if (!value) return "暂无";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

export function AiExpert() {
  const [status, setStatus] = useState<AiExpertStatus>(EMPTY_STATUS);
  const [busy, setBusy] = useState(false);
  const [autoReplyRunning, setAutoReplyRunning] = useState(false);
  const [error, setError] = useState("");

  const applyResult = (result: AiExpertResult) => {
    if (result.data) setStatus((current) => ({ ...(result.data?.configured === false ? EMPTY_STATUS : current), ...result.data }));
    if (result.code === "AUTO_REPLY_RUNNING") setAutoReplyRunning(true);
    setError(result.ok ? "" : result.error || "AI专家操作失败");
  };

  const refresh = () => {
    if (!window.xiaoxiAiExpert) return setError("当前版本未连接 AI 专家资料服务");
    void window.xiaoxiAiExpert.status().then(applyResult).catch(() => setError("读取 AI 专家状态失败"));
    void window.xiaoxiAutoReply?.status().then((result) => setAutoReplyRunning(["starting", "running"].includes(String(result.state?.status || "")))).catch(() => undefined);
  };

  useEffect(refresh, []);

  const run = (operation: () => Promise<AiExpertResult>, failure: string) => {
    setBusy(true);
    setError("");
    void operation().then((result) => {
      applyResult(result);
      if (result.ok && !result.data) refresh();
    }).catch(() => setError(failure)).finally(() => setBusy(false));
  };

  return (
    <section className="page ai-expert-page">
      <div className="page-head">
        <div>
          <h1>AI专家</h1>
          <p>导入一份业务资料，自动回复会以这份资料作为回答依据。重新导入会替换当前文件。</p>
        </div>
      </div>

      <div className="table-panel ai-expert-card">
        <div className="ai-expert-card-head">
          <div className="ai-expert-file">
            <span className="ai-expert-file-icon"><FileText size={24} /></span>
            <div>
              <strong>{status.configured ? status.fileName : "尚未导入资料"}</strong>
              <p>{status.configured ? `${status.extension || "文件"} · 当前仅保留这一份资料` : "请选择支持的业务资料文件"}</p>
            </div>
          </div>
          <span className={`ai-expert-state ${status.configured ? "is-configured" : ""}`}>
            {status.configured ? "已导入" : "未导入"}
          </span>
        </div>

        <div className="ai-expert-details">
          <div><span>文件名</span><strong>{status.fileName || "暂无"}</strong></div>
          <div><span>导入时间</span><strong>{importedAtLabel(status.importedAt)}</strong></div>
        </div>

        {error && <div className="touch-notice ai-expert-error" role="alert">{error}</div>}
        {autoReplyRunning && <div className="touch-notice">自动回复运行中，请先暂停再替换或删除话术文件。</div>}

        <div className="actions ai-expert-actions">
          <button className="primary-button" onClick={() => window.xiaoxiAiExpert ? run(() => window.xiaoxiAiExpert!.chooseAndImport(), "导入 AI 专家资料失败") : setError("当前版本未连接 AI 专家资料服务")} disabled={busy || autoReplyRunning}>
            <FileUp size={17} />{status.configured ? "替换文件" : "导入文件"}
          </button>
          {status.configured && (
            <button className="danger-button" onClick={() => window.xiaoxiAiExpert && run(() => window.xiaoxiAiExpert!.remove(), "删除 AI 专家资料失败")} disabled={busy || autoReplyRunning}>
              <Trash2 size={17} />删除
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
