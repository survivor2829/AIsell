import { useEffect, useState } from "react";
import "./cloud-maintenance.css";

type CloudStage = "disabled" | "idle" | "checking" | "downloading" | "preparing" | "verifying" | "waiting" | "ready" | "current" | "error";
export type CloudAnnouncement = { id?: string; sequence: number; version: string; notes: string; publishedAt: string; read: boolean };
export type CloudStatus = {
  enabled: boolean; stage: CloudStage; version: string; nextVersion: string; progress: number;
  error: string; uploadError: string; consent: boolean; queued: number; lastUpload: string; canInstall: boolean; updateRequested?: boolean; waitingReason?: string;
  announcements: CloudAnnouncement[]; unreadAnnouncements: number; lastAnnouncementsCheck: string;
  announcementError: string; announcementsChecking: boolean;
  downloadedBytes?: number; totalBytes?: number; updateFailure?: string;
  consentNotice?: boolean;
  launchGate?: { phase: "checking" | "updating" | "retrying" | "installing" | "open"; reason: string; attempt: number; retryAt: number };
  lastUpdate?: { version: string; notes: string; completedAt: string; unread: boolean } | null;
};
declare global {
  interface Window {
    xiaoxiCloudMaintenance?: {
      status(): Promise<CloudStatus>; check(): Promise<CloudStatus>; upload(): Promise<CloudStatus>;
      consent(enabled: boolean): Promise<CloudStatus>; restart(): Promise<CloudStatus>;
      announcements(): Promise<CloudStatus>; readAnnouncement(id: string | number): Promise<CloudStatus>;
      readAnnouncements(): Promise<CloudStatus>;
      acknowledgeUpdate(): Promise<CloudStatus>; cancelUpdate(): Promise<CloudStatus>;
      acknowledgeConsentNotice(): Promise<CloudStatus>;
      onUpdate(callback: (state: CloudStatus) => void): () => void;
    };
  }
}
export function CloudMaintenance() {
  const [state, setState] = useState<CloudStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const api = window.xiaoxiCloudMaintenance;
    if (!api) return;
    let active = true; let updated = false;
    const receive = (value: CloudStatus) => { if (active) setState(value); };
    const unsubscribe = api.onUpdate(value => { updated = true; receive(value); });
    api.status().then(value => { if (!updated) receive(value); }).catch(() => { if (active) setError("暂时无法读取诊断设置，请稍后重试。"); });
    return () => { active = false; unsubscribe(); };
  }, []);
  if (!state) return error ? <p role="alert">{error}</p> : null;
  if (!state.enabled) return null;
  const run = async (action: () => Promise<CloudStatus>) => {
    setBusy(true); setError("");
    try { setState(await action()); } catch { setError("操作暂未完成，请稍后重试。"); } finally { setBusy(false); }
  };
  const api = window.xiaoxiCloudMaintenance!;
  return <section className="cloud-maintenance" aria-label="诊断反馈设置">
    <div className="cloud-reporting">
      <label><input type="checkbox" checked={state.consent} disabled={busy} onChange={(event) => void run(() => api.consent(event.target.checked))} />出错时自动上报现场</label>
      <p>软件出错时自动上传出错现场，技术支持据此直接定位问题：错误信息、出错前的操作步骤、视频引擎的测量数据、电脑与版本信息，以及微信操作失败时的屏幕截图（截图可能包含当时的聊天画面）。不上传密钥和素材文件。云端仅技术支持可见，保留 30 天。关闭后不再上传，并清空本机待传记录，不影响你主动提交的反馈。</p>
      {state.consent && <div className="cloud-maintenance-row"><p role="status">待上传 {state.queued} 条 · {state.lastUpload ? `最近上传 ${new Date(state.lastUpload).toLocaleString()}` : "尚未上传"}{state.uploadError && `。${state.uploadError}`}</p><button className="secondary-button" disabled={busy || !state.queued} onClick={() => void run(api.upload)}>上传待传诊断</button></div>}
    </div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
