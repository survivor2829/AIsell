import { Download, FolderOpen, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

type DiagnosticEntry = {
  ts: string;
  level: string;
  module: string;
  event: string;
  code?: string;
  phase?: string;
  duration_ms?: number;
  trace_id?: string;
};

type DiagnosticStatus = {
  runId: string;
  logDirectory: string;
  currentBytes: number;
  recentCount: number;
  recentErrorCount: number;
  writesFailed: number;
  latest: DiagnosticEntry[];
  latestErrors: DiagnosticEntry[];
};

type DiagnosticResult = {
  ok: boolean;
  data?: DiagnosticStatus;
  canceled?: boolean;
  filePath?: string;
  error?: string;
};

declare global {
  interface Window {
    xiaoxiDiagnostics?: {
      status: () => Promise<DiagnosticResult>;
      openFolder: () => Promise<DiagnosticResult>;
      export: () => Promise<DiagnosticResult>;
    };
  }
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-CN", { hour12: false });
}

export function Diagnostics() {
  const [status, setStatus] = useState<DiagnosticStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const refresh = () => {
    if (!window.xiaoxiDiagnostics) return setError("当前版本未连接诊断日志服务");
    setBusy(true);
    void window.xiaoxiDiagnostics.status()
      .then((result) => {
        if (!result.ok || !result.data) throw new Error(result.error || "读取诊断日志失败");
        setStatus(result.data);
        setError("");
      })
      .catch((reason) => setError(String(reason?.message || reason)))
      .finally(() => setBusy(false));
  };

  useEffect(refresh, []);

  const run = (operation: () => Promise<DiagnosticResult>, success: (result: DiagnosticResult) => string) => {
    setBusy(true);
    setError("");
    setNotice("");
    void operation()
      .then((result) => {
        if (!result.ok) throw new Error(result.error || "诊断操作失败");
        if (!result.canceled) setNotice(success(result));
        refresh();
      })
      .catch((reason) => setError(String(reason?.message || reason)))
      .finally(() => setBusy(false));
  };

  const rows = status?.latestErrors.length ? status.latestErrors : status?.latest ?? [];

  return (
    <section className="page diagnostics-page">
      <div className="page-head">
        <div>
          <h1>日志诊断</h1>
          <p>记录扫描、识别、AI、窗口适配和发送链路；异机出错后可直接导出诊断包。</p>
        </div>
        <div className="actions">
          <button className="secondary-button" onClick={refresh} disabled={busy}><RefreshCw size={17} />刷新</button>
          <button className="secondary-button" onClick={() => window.xiaoxiDiagnostics && run(() => window.xiaoxiDiagnostics!.openFolder(), () => "已打开日志目录")} disabled={busy}>
            <FolderOpen size={17} />打开日志目录
          </button>
          <button className="primary-button" onClick={() => window.xiaoxiDiagnostics && run(() => window.xiaoxiDiagnostics!.export(), (result) => `诊断包已导出：${result.filePath || ""}`)} disabled={busy}>
            <Download size={17} />导出诊断包
          </button>
        </div>
      </div>

      <div className="status-strip diagnostics-status">
        <div className="status-card"><span>近期事件</span><strong>{status?.recentCount ?? 0}</strong></div>
        <div className="status-card"><span>近期异常</span><strong className={(status?.recentErrorCount ?? 0) > 0 ? "warn" : "ok"}>{status?.recentErrorCount ?? 0}</strong></div>
        <div className="status-card"><span>日志大小</span><strong>{formatBytes(status?.currentBytes ?? 0)}</strong></div>
        <div className="status-card"><span>写入失败</span><strong className={(status?.writesFailed ?? 0) > 0 ? "danger" : "ok"}>{status?.writesFailed ?? 0}</strong></div>
      </div>

      <div className="diagnostics-privacy">
        日志不会写入 DeepSeek Key、客户消息原文、联系人明文或 AI 专家资料原文；敏感内容只保留长度与不可逆摘要。
      </div>
      {notice && <div className="auto-reply-control-note">{notice}</div>}
      {error && <div className="touch-notice" role="alert">{error}</div>}

      <div className="diagnostics-meta">
        <span>运行编号：{status?.runId || "--"}</span>
        <span title={status?.logDirectory || ""}>目录：{status?.logDirectory || "--"}</span>
      </div>

      <div className="diagnostics-table-wrap">
        <table className="diagnostics-table">
          <thead><tr><th>时间</th><th>模块</th><th>事件</th><th>错误码 / 阶段</th><th>耗时</th><th>追踪编号</th></tr></thead>
          <tbody>
            {rows.length ? rows.map((row, index) => (
              <tr key={`${row.ts}-${row.event}-${index}`}>
                <td>{formatTime(row.ts)}</td>
                <td>{row.module}</td>
                <td>{row.event}</td>
                <td>{row.code || row.phase || "--"}</td>
                <td>{row.duration_ms === undefined ? "--" : `${row.duration_ms} ms`}</td>
                <td title={row.trace_id || ""}>{row.trace_id ? row.trace_id.slice(0, 8) : "--"}</td>
              </tr>
            )) : <tr><td colSpan={6} className="diagnostics-empty">暂无异常，日志系统正在持续记录。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
