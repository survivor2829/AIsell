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

type AutoReplyDiagnosticEntry = {
  ts: string;
  event: string;
  status?: string;
  phase?: string;
  code?: string;
  action?: string;
  reason_code?: string;
  error_code?: string;
  send_result?: string;
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
  autoReplyLatest?: AutoReplyDiagnosticEntry[];
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

const AUTO_REPLY_EVENT_LABELS: Record<string, string> = {
  start_requested: "启动请求",
  started: "已开始监听",
  prime_deferred: "启动检查等待重试",
  scan_healthy: "扫描正常",
  scan_waiting: "等待继续扫描",
  scan_failed: "扫描异常",
  scan_recovered: "扫描已恢复",
  reply_candidate_detected: "发现待回复消息",
  reply_generation_started: "正在生成回复",
  reply_decision: "AI 决策完成",
  reply_send_started: "进入微信发送准备",
  reply_send_finished: "微信发送校验完成",
  reply_send_skipped: "本条无需发送",
  system_error: "AI 服务故障",
  paused: "已暂停"
};

const AUTO_REPLY_PHASE_LABELS: Record<string, string> = {
  prime: "启动检查",
  scan: "扫描消息",
  candidate: "读取消息",
  generate: "生成回复",
  send: "发送回复",
  control: "运行控制",
  coordinator: "任务协调",
  scope: "测试范围"
};

const AUTO_REPLY_ACTION_LABELS: Record<string, string> = {
  answer: "直接回答",
  clarify: "澄清一次",
  handoff: "人工接管",
  silent: "静默处理"
};

function diagnosticValue(value?: string) {
  return String(value || "").trim() || "--";
}

function UnifiedDiagnosticTable({ rows, emptyText }: { rows: DiagnosticEntry[]; emptyText: string }) {
  return (
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
          )) : <tr><td colSpan={6} className="diagnostics-empty">{emptyText}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function Diagnostics({ appVersion, edition, buildId }: { appVersion: string; edition: string; buildId: string }) {
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

  const autoReplyRows = status?.autoReplyLatest ?? [];
  const errorRows = status?.latestErrors ?? [];
  const recentRows = (status?.latest ?? []).filter((row) => row.level !== "error" && row.level !== "fatal");

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

      <div className="diagnostics-version" aria-label="软件版本信息">
        <strong>软件版本</strong>
        <span>版本 {appVersion}</span>
        <span>{edition}</span>
        <span title={buildId}>构建编号 {buildId || "--"}</span>
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

      <div className="diagnostics-meta">
        <strong>自动回复链路</strong>
        <span>最近 {autoReplyRows.length} 条脱敏事件</span>
      </div>
      <div className="diagnostics-table-wrap">
        <table className="diagnostics-table diagnostics-auto-reply-table">
          <colgroup>
            <col className="diagnostics-col-time" />
            <col className="diagnostics-col-event" />
            <col className="diagnostics-col-decision" />
            <col className="diagnostics-col-result" />
            <col className="diagnostics-col-trace" />
          </colgroup>
          <thead><tr><th>时间</th><th>阶段 / 事件</th><th>动作 / 原因</th><th>结果 / 耗时</th><th>追踪编号</th></tr></thead>
          <tbody>
            {autoReplyRows.length ? autoReplyRows.map((row, index) => {
              const phaseLabel = AUTO_REPLY_PHASE_LABELS[row.phase || ""] || diagnosticValue(row.phase);
              const eventLabel = AUTO_REPLY_EVENT_LABELS[row.event] || diagnosticValue(row.event);
              const actionLabel = AUTO_REPLY_ACTION_LABELS[row.action || ""] || diagnosticValue(row.action);
              const reasonCode = diagnosticValue(row.reason_code);
              const resultCode = diagnosticValue(row.error_code || row.code || row.send_result);
              const duration = row.duration_ms === undefined ? "--" : `${row.duration_ms} ms`;
              const traceId = diagnosticValue(row.trace_id);
              return (
                <tr key={`${row.ts}-${row.event}-${index}`}>
                  <td className="diagnostics-time-cell" title={formatTime(row.ts)}>{formatTime(row.ts)}</td>
                  <td className="diagnostics-stack-cell">
                    <span className="diagnostics-cell-primary" title={phaseLabel}>{phaseLabel}</span>
                    <span className="diagnostics-cell-secondary" title={`${eventLabel} · ${row.event}`}>{eventLabel}</span>
                  </td>
                  <td className="diagnostics-stack-cell">
                    <span className="diagnostics-cell-primary" title={actionLabel}>{actionLabel}</span>
                    <code className="diagnostics-token" title={reasonCode}>{reasonCode}</code>
                  </td>
                  <td className="diagnostics-stack-cell">
                    <code className="diagnostics-token diagnostics-result-token" title={resultCode}>{resultCode}</code>
                    <span className="diagnostics-cell-secondary" title={duration}>{duration}</span>
                  </td>
                  <td className="diagnostics-stack-cell">
                    <code className="diagnostics-token diagnostics-trace-token" title={traceId}>{row.trace_id ? row.trace_id.slice(0, 8) : "--"}</code>
                  </td>
                </tr>
              );
            }) : <tr><td colSpan={5} className="diagnostics-empty">暂无自动回复链路；启动自动回复后，这里会显示扫描、AI 决策和发送校验过程。</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="diagnostics-meta">
        <strong>近期异常</strong>
        <span>{errorRows.length} 条</span>
      </div>
      <UnifiedDiagnosticTable rows={errorRows} emptyText="近期没有异常。" />

      <div className="diagnostics-meta">
        <strong>近期运行事件</strong>
        <span>{recentRows.length} 条</span>
      </div>
      <UnifiedDiagnosticTable rows={recentRows} emptyText="暂无近期运行事件。" />
    </section>
  );
}
