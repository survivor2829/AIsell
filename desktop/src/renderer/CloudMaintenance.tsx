import { useEffect, useState } from "react";
import "./cloud-maintenance.css";

type CloudStage = "disabled" | "idle" | "checking" | "downloading" | "ready" | "current" | "error";
export type CloudAnnouncement = { sequence: number; version: string; notes: string; publishedAt: string; read: boolean };
export type CloudStatus = {
  enabled: boolean; stage: CloudStage; version: string; nextVersion: string; progress: number;
  error: string; uploadError: string; consent: boolean; queued: number; lastUpload: string; canInstall: boolean;
  announcements: CloudAnnouncement[]; unreadAnnouncements: number; lastAnnouncementsCheck: string;
  announcementError: string; announcementsChecking: boolean;
};
declare global {
  interface Window {
    xiaoxiCloudMaintenance?: {
      status(): Promise<CloudStatus>; check(): Promise<CloudStatus>; upload(): Promise<CloudStatus>;
      consent(enabled: boolean): Promise<CloudStatus>; restart(): Promise<CloudStatus>;
      announcements(): Promise<CloudStatus>; readAnnouncement(sequence: number): Promise<CloudStatus>;
      onUpdate(callback: (state: CloudStatus) => void): () => void;
    };
  }
}
export function CloudMaintenance({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<CloudStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const api = window.xiaoxiCloudMaintenance;
    if (!api) return;
    let active = true;
    const receive = (value: CloudStatus) => { if (active) setState(value); };
    const unsubscribe = api.onUpdate(receive);
    api.status().then(receive).catch(() => { if (active) setError("暂时无法读取更新状态，请稍后重试。"); });
    return () => { active = false; unsubscribe(); };
  }, []);
  if (!state) return !compact && error ? <p role="alert">{error}</p> : null;
  if (!state.enabled) return null;
  if (compact && !["downloading", "ready", "error"].includes(state.stage)) return null;
  const run = async (action: () => Promise<CloudStatus>) => {
    setBusy(true); setError("");
    try { setState(await action()); } catch { setError("操作暂未完成，请稍后重试。"); } finally { setBusy(false); }
  };
  const api = window.xiaoxiCloudMaintenance!;
  const labels: Record<CloudStage, string> = {
    downloading: `正在下载 ${state.nextVersion} · ${state.progress}%`,
    ready: `新版本 ${state.nextVersion} 已下载`, checking: "正在检查更新…",
    error: state.error, current: "当前没有可用更新",
    idle: `当前版本 ${state.version}`, disabled: "更新服务未启用"
  };
  const label = labels[state.stage];
  return <section className={`cloud-maintenance ${compact ? "is-compact" : ""}`} aria-label="更新与问题反馈">
    <div className="cloud-maintenance-row">
      <div><strong>{compact ? label : "软件更新"}</strong>{!compact && <p role="status">{label}</p>}
        {state.stage === "ready" && <p>{state.canInstall ? "关闭软件后自动安装，保留你的配置和数据。" : "当前为开发或便携环境，请通过安装版验证自动升级。"}</p>}
      </div>
      {state.stage === "ready" && state.canInstall
        ? <button className="primary-button" disabled={busy} onClick={() => void run(api.restart)}>退出并更新</button>
        : <button className="secondary-button" disabled={busy || ["checking", "downloading"].includes(state.stage)} onClick={() => void run(api.check)}>检查更新</button>}
    </div>
    {state.stage === "downloading" && <progress value={state.progress} max={100} aria-label="更新下载进度" />}
    {!compact && <div className="cloud-reporting">
      <label><input type="checkbox" checked={state.consent} disabled={busy} onChange={(event) => void run(() => api.consent(event.target.checked))} />自动上传脱敏诊断</label>
      <p>帮助定位软件异常。仅上传版本、匿名安装编号、错误码和必要技术信息；不上传聊天正文、联系人、密钥、截图或素材。云端保留 30 天，关闭后清空本机待传诊断，不影响主动提交的反馈。</p>
      {state.consent && <div className="cloud-maintenance-row"><p role="status">待上传 {state.queued} 条 · {state.lastUpload ? `最近上传 ${new Date(state.lastUpload).toLocaleString()}` : "尚未上传"}{state.uploadError && `。${state.uploadError}`}</p><button className="secondary-button" disabled={busy || !state.queued} onClick={() => void run(api.upload)}>上传待传诊断</button></div>}
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
