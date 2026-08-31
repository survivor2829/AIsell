import { FileText, FileUp, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

type AiExpertKind = "expert_rules" | "business_knowledge";
type AiExpertSlotStatus = {
  configured: boolean;
  fileName: string;
  importedAt: string;
};
type AiExpertStatus = {
  expertRules: AiExpertSlotStatus;
  businessKnowledge: AiExpertSlotStatus;
  ready: boolean;
};
type AiExpertResult = { ok: boolean; data?: Partial<AiExpertStatus>; code?: string; error?: string };

declare global {
  interface Window {
    xiaoxiAiExpert?: {
      status: () => Promise<AiExpertResult>;
      chooseAndImport: (kind: AiExpertKind) => Promise<AiExpertResult>;
      remove: (kind: AiExpertKind) => Promise<AiExpertResult>;
    };
  }
}

const EMPTY_SLOT: AiExpertSlotStatus = {
  configured: false,
  fileName: "",
  importedAt: ""
};
const EMPTY_STATUS: AiExpertStatus = {
  expertRules: EMPTY_SLOT,
  businessKnowledge: EMPTY_SLOT,
  ready: false
};

function normalizeSlot(value: Partial<AiExpertSlotStatus> | undefined): AiExpertSlotStatus {
  return {
    configured: value?.configured === true,
    fileName: String(value?.fileName || ""),
    importedAt: String(value?.importedAt || "")
  };
}

function normalizeStatus(value: Partial<AiExpertStatus> | undefined): AiExpertStatus {
  const expertRules = normalizeSlot(value?.expertRules);
  const businessKnowledge = normalizeSlot(value?.businessKnowledge);
  return {
    expertRules,
    businessKnowledge,
    ready: expertRules.configured && businessKnowledge.configured
  };
}

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
    if (result.data) setStatus(normalizeStatus(result.data));
    if (result.code === "AUTO_REPLY_RUNNING") setAutoReplyRunning(true);
    setError(result.ok ? "" : result.error || "AI专家操作失败");
  };

  const refresh = () => {
    if (!window.xiaoxiAiExpert) return setError("当前版本未连接 AI 专家资料服务");
    void window.xiaoxiAiExpert.status().then(applyResult).catch(() => setError("读取 AI 专家状态失败"));
    void window.xiaoxiAutoReply?.status().then((result) => {
      setAutoReplyRunning(["starting", "running"].includes(String(result.state?.status || "")));
    }).catch(() => undefined);
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

  const importDocument = (kind: AiExpertKind, label: string) => {
    if (!window.xiaoxiAiExpert) return setError("当前版本未连接 AI 专家资料服务");
    run(() => window.xiaoxiAiExpert!.chooseAndImport(kind), `导入${label}失败`);
  };

  const removeDocument = (kind: AiExpertKind, label: string) => {
    if (!window.xiaoxiAiExpert) return setError("当前版本未连接 AI 专家资料服务");
    run(() => window.xiaoxiAiExpert!.remove(kind), `删除${label}失败`);
  };

  const documents: Array<{
    kind: AiExpertKind;
    title: string;
    description: string;
    status: AiExpertSlotStatus;
  }> = [
    {
      kind: "expert_rules",
      title: "专家规则",
      description: "规定 AI 的身份、语气、回答原则、追问方式和转人工边界。",
      status: status.expertRules
    },
    {
      kind: "business_knowledge",
      title: "业务知识",
      description: "提供产品、适用场景、FAQ、价格边界和售后政策等公司事实。",
      status: status.businessKnowledge
    }
  ];
  const missingTitles = documents.filter((item) => !item.status.configured).map((item) => item.title);

  return (
    <section className="page ai-expert-page">
      <div className="page-head">
        <div>
          <h1>AI专家</h1>
          <p>分别导入专家规则和业务知识，两份资料共同约束自动回复；重新导入只替换对应资料。</p>
        </div>
      </div>

      <div className="table-panel ai-expert-card" aria-busy={busy}>
        <div className="ai-expert-card-head ai-expert-overview">
          <div>
            <strong>专家资料</strong>
            <p>
              {status.ready
                ? "两份资料已就绪，可以作为自动回复依据。"
                : `还需导入：${missingTitles.join("、")}。`}
            </p>
          </div>
          <span className={`ai-expert-state ${status.ready ? "is-configured" : ""}`}>
            {status.ready ? "专家已就绪" : "待补齐"}
          </span>
        </div>

        <div className="ai-expert-document-list">
          {documents.map((document) => (
            <article className="ai-expert-document-row" key={document.kind}>
              <div className="ai-expert-document-head">
                <div className="ai-expert-file">
                  <span className="ai-expert-file-icon"><FileText size={22} /></span>
                  <div>
                    <strong>{document.title}</strong>
                    <p>{document.description}</p>
                  </div>
                </div>
                <span className={`ai-expert-state ${document.status.configured ? "is-configured" : ""}`}>
                  {document.status.configured ? "已导入" : "未导入"}
                </span>
              </div>

              <div className="ai-expert-details">
                <div>
                  <span>文件名</span>
                  <strong className="ai-expert-document-file-name" title={document.status.fileName || undefined}>
                    {document.status.fileName || "暂无"}
                  </strong>
                </div>
                <div>
                  <span>导入时间</span>
                  <strong>{importedAtLabel(document.status.importedAt)}</strong>
                </div>
              </div>

              <div className="actions ai-expert-actions">
                <button
                  className="primary-button"
                  onClick={() => importDocument(document.kind, document.title)}
                  disabled={busy || autoReplyRunning}
                >
                  <FileUp size={17} />
                  {document.status.configured ? `替换${document.title}` : `导入${document.title}`}
                </button>
                {document.status.configured && (
                  <button
                    className="danger-button"
                    onClick={() => removeDocument(document.kind, document.title)}
                    disabled={busy || autoReplyRunning}
                  >
                    <Trash2 size={17} />删除
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>

        {error && <div className="touch-notice ai-expert-error" role="alert">{error}</div>}
        {autoReplyRunning && (
          <div className="touch-notice ai-expert-error">
            自动回复运行中，请先暂停再替换或删除专家资料。
          </div>
        )}
        <p className="ai-expert-footnote">支持 .txt、.md、.docx；单份文件不超过 5MB，两份文字合计不超过 5 万字符。</p>
      </div>
    </section>
  );
}
