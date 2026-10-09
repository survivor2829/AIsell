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
      readAnnouncements(): Promise<CloudStatus>;
      acknowledgeUpdate(): Promise<CloudStatus>;
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
      <label><input type="checkbox" checked={state.consent} disabled={busy} onChange={(event) => void run(() => api.consent(event.target.checked))} />自动上传脱敏诊断</label>
      <p>帮助定位软件异常。仅上传版本、匿名安装编号、错误码和必要技术信息；不上传聊天正文、联系人、密钥、截图或素材。云端保留 30 天，关闭后清空本机待传诊断，不影响主动提交的反馈。</p>
      {state.consent && <div className="cloud-maintenance-row"><p role="status">待上传 {state.queued} 条 · {state.lastUpload ? `最近上传 ${new Date(state.lastUpload).toLocaleString()}` : "尚未上传"}{state.uploadError && `。${state.uploadError}`}</p><button className="secondary-button" disabled={busy || !state.queued} onClick={() => void run(api.upload)}>上传待传诊断</button></div>}
    </div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
