import { useEffect, useState } from "react";
import "./cloud-maintenance.css";

type CloudStage = "disabled" | "idle" | "checking" | "downloading" | "preparing" | "verifying" | "waiting" | "ready" | "current" | "error";
export type CloudAnnouncement = { id?: string; sequence: number; version: string; notes: string; publishedAt: string; read: boolean };
export type CloudStatus = {
  enabled: boolean; stage: CloudStage; version: string; nextVersion: string; progress: number;
  error: string; uploadError: string; consent: boolean; queued: number; lastUpload: string; canInstall: boolean;
  announcements: CloudAnnouncement[]; unreadAnnouncements: number; lastAnnouncementsCheck: string;
  announcementError: string; announcementsChecking: boolean;
  downloadedBytes?: number; totalBytes?: number; updateFailure?: string;
  lastUpdate?: { version: string; notes: string; completedAt: string; unread: boolean } | null;
};
declare global {
  interface Window {
    xiaoxiCloudMaintenance?: {
      status(): Promise<CloudStatus>; check(): Promise<CloudStatus>; upload(): Promise<CloudStatus>;
      consent(enabled: boolean): Promise<CloudStatus>; restart(): Promise<CloudStatus>;
      announcements(): Promise<CloudStatus>; readAnnouncement(id: string | number): Promise<CloudStatus>;
      acknowledgeUpdate(): Promise<CloudStatus>;
      onUpdate(callback: (state: CloudStatus) => void): () => void;
    };
  }
}
export function CloudMaintenance({ compact = false, updateOnly = false }: { compact?: boolean; updateOnly?: boolean }) {
  const [state, setState] = useState<CloudStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const api = window.xiaoxiCloudMaintenance;
    if (!api) return;
    let active = true; let updated = false;
    const receive = (value: CloudStatus) => { if (active) setState(value); };
    const unsubscribe = api.onUpdate(value => { updated = true; receive(value); });
    api.status().then(value => { if (!updated) receive(value); }).catch(() => { if (active) setError("暂时无法读取更新状态，请稍后重试。"); });
    return () => { active = false; unsubscribe(); };
  }, []);
  if (!state) return !compact && error ? <p role="alert">{error}</p> : null;
  if (!state.enabled) return null;
  if (compact && !["checking", "downloading", "preparing", "verifying", "waiting", "ready", "error"].includes(state.stage)) return null;
  const run = async (action: () => Promise<CloudStatus>) => {
    setBusy(true); setError("");
    try { setState(await action()); } catch { setError("操作暂未完成，请稍后重试。"); } finally { setBusy(false); }
  };
  const api = window.xiaoxiCloudMaintenance!;
  const labels: Record<CloudStage, string> = {
    downloading: `正在下载 ${state.nextVersion} · ${state.progress}%`,
    ready: `版本 ${state.nextVersion} 已准备好`, checking: "正在检查更新…",
    preparing: "正在准备更新", verifying: "正在校验并整理更新文件", waiting: "等待软件退出，更新窗口将继续显示进度",
    error: state.error, current: "当前没有可用更新",
    idle: `当前版本 ${state.version}`, disabled: "更新服务未启用"
  };
  const label = labels[state.stage];
  const working = ["checking", "downloading", "preparing", "verifying", "waiting"].includes(state.stage);
  const bytes = (size: number) => `${(size / 1024 / 1024).toFixed(1)} MB`;
  return <section className={`cloud-maintenance ${compact ? "is-compact" : ""}`} aria-label="更新与问题反馈">
    <div className="cloud-maintenance-row">
      <div><strong>{compact ? label : "软件更新"}</strong>{!compact && <p role="status">{label}</p>}
        <p>当前版本 {state.version}{state.nextVersion ? ` → ${state.nextVersion}` : ""}</p>
        {state.stage === "ready" && <p>{state.canInstall ? "更新已校验。完成当前任务后，点击退出并更新；配置和数据会保留。" : "当前为开发或便携环境，请通过安装版验证自动升级。"}</p>}
      </div>
      {state.stage === "ready" && state.canInstall
        ? <button className="primary-button" disabled={busy} onClick={() => void run(api.restart)}>退出并更新</button>
        : <button className="secondary-button" disabled={busy || working} onClick={() => void run(api.check)}>{state.stage === "error" ? "重试更新" : "检查更新"}</button>}
    </div>
    {state.stage === "downloading" && <progress value={state.progress} max={100} aria-label="更新下载进度" />}
    {state.stage === "downloading" && Boolean(state.totalBytes) && <p className="cloud-download-bytes">{bytes(state.downloadedBytes || 0)} / {bytes(state.totalBytes || 0)} · {state.progress}%</p>}
    {["preparing", "verifying", "waiting"].includes(state.stage) && <p className="cloud-update-step" role="status">检查更新 → 下载 → 校验 → 等待退出 → 安装 → 完成</p>}
    {state.error && state.stage !== "error" && <p role="alert">{state.error}</p>}
    {state.updateFailure && <p role="alert">{state.updateFailure}</p>}
    {!compact && state.lastUpdate && <div className="cloud-update-complete"><strong>已更新至 {state.lastUpdate.version}</strong><p>{state.lastUpdate.notes || "新版本已成功启动。"}</p></div>}
    {!compact && !updateOnly && <div className="cloud-reporting">
      <label><input type="checkbox" checked={state.consent} disabled={busy} onChange={(event) => void run(() => api.consent(event.target.checked))} />自动上传脱敏诊断</label>
      <p>帮助定位软件异常。仅上传版本、匿名安装编号、错误码和必要技术信息；不上传聊天正文、联系人、密钥、截图或素材。云端保留 30 天，关闭后清空本机待传诊断，不影响主动提交的反馈。</p>
      {state.consent && <div className="cloud-maintenance-row"><p role="status">待上传 {state.queued} 条 · {state.lastUpload ? `最近上传 ${new Date(state.lastUpload).toLocaleString()}` : "尚未上传"}{state.uploadError && `。${state.uploadError}`}</p><button className="secondary-button" disabled={busy || !state.queued} onClick={() => void run(api.upload)}>上传待传诊断</button></div>}
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
