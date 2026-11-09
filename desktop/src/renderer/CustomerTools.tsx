import { Bell, RefreshCw, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CustomerPanel } from "./CustomerPanel";
import type { CloudStatus } from "./CloudMaintenance";

export function CustomerTools({ onOpenFeedback }: { onOpenFeedback: () => void }) {
  const [panel, setPanel] = useState<"announcements" | null>(null);
  const [state, setState] = useState<CloudStatus>();
  const [error, setError] = useState("");
  const [history, setHistory] = useState<{ version: string; date: string; notes: string }[]>([]);
  const [updateError, setUpdateError] = useState("");
  const [updateNotice, setUpdateNotice] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);
  const updateInFlight = useRef(false);
  useEffect(() => {
    const api = window.xiaoxiCloudMaintenance;
    if (!api) return;
    let active = true; let updated = false;
    const receive = (value: CloudStatus) => { if (active) setState(value); };
    const unsubscribe = api.onUpdate((value) => { updated = true; receive(value); });
    void api.status().then((value) => { if (!updated) receive(value); }).catch(() => { if (active) setError("暂时无法读取公告，可稍后刷新。"); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const refresh = async () => {
    const api = window.xiaoxiCloudMaintenance;
    if (!api) return;
    setError("");
    try {
      const refreshed = await api.announcements();
      setState(refreshed.unreadAnnouncements ? await api.readAnnouncements() : refreshed);
    }
    catch { setError("公告暂时刷新失败，本机记录仍可查看。"); }
  };
  const openAnnouncements = async () => {
    const api = window.xiaoxiCloudMaintenance;
    setPanel("announcements");
    if (!api) return;
    setError("");
    void api.releaseHistory?.().then(setHistory).catch(() => undefined);
    try {
      const local = await api.readAnnouncements();
      setState(local);
      const refreshed = await api.announcements();
      const current = refreshed.unreadAnnouncements ? await api.readAnnouncements() : refreshed;
      setState(current);
    } catch { setError("公告暂时刷新失败，本机记录仍可查看。"); }
  };
  const updateWorking = updateBusy || ["checking", "downloading", "preparing", "verifying", "waiting"].includes(state?.stage || "");
  const updateReady = state?.stage === "ready" && state.canInstall;
  const downloadPercent = Math.max(0, Math.min(100, Math.floor(state?.progress || 0)));
  const updateLabel = state?.stage === "downloading" ? `下载 ${downloadPercent}%`
    : state?.stage === "waiting" && state.updateRequested ? "等待任务结束" : state?.stage === "checking" ? "检查中…" : ["preparing", "verifying", "waiting"].includes(state?.stage || "") ? "正在更新…"
    : updateBusy ? "正在处理…" : updateReady ? "立即更新" : state?.stage === "error" ? "重试更新" : "检查更新";
  const updateMessage = updateError || state?.error || state?.updateFailure || state?.waitingReason || updateNotice
    || (state?.stage === "ready" ? state.canInstall ? `有更新 ${state.nextVersion}` : "更新已准备好，请使用安装版更新。"
      : state?.stage === "current" ? "已是最新版本"
      : state?.lastUpdate?.unread ? `已更新至 ${state.lastUpdate.version}` : "");
  const update = async () => {
    const api = window.xiaoxiCloudMaintenance;
    if (!api || updateInFlight.current || updateWorking) return;
    updateInFlight.current = true; setUpdateBusy(true); setUpdateError(""); setUpdateNotice("");
    try { setState(await (updateReady ? api.restart() : api.check())); }
    catch { setUpdateError("更新暂未完成，请重试。"); }
    finally { updateInFlight.current = false; setUpdateBusy(false); }
  };
  // The newest versions come with their full announcement; the history reaches back to the very first version.
  const recent = new Map((state?.announcements || []).map((entry) => [entry.version, entry]));
  const allVersions = [...history.map((entry) => {
    const latest = recent.get(entry.version);
    return { ...entry, notes: latest?.notes || entry.notes, date: latest?.publishedAt?.slice(0, 10) || entry.date };
  }), ...(state?.announcements || []).filter((entry) => !history.some((item) => item.version === entry.version)).map((entry) => ({ version: entry.version, notes: entry.notes || "", date: entry.publishedAt?.slice(0, 10) || "" }))];
  const dated = allVersions.map((entry) => entry.date).filter(Boolean).sort();
  const daysOfUpdates = dated.length > 1 ? Math.round((Date.parse(dated[dated.length - 1]) - Date.parse(dated[0])) / 86400000) + 1 : 0;
  const series = (version: string) => version.split(".").slice(0, 2).join(".");
  const acknowledgeConsent = async (thenOpenSettings = false) => {
    const api = window.xiaoxiCloudMaintenance;
    if (!api) return;
    try { setState(await api.acknowledgeConsentNotice()); } catch { /* Shown again next launch. */ }
    if (thenOpenSettings) onOpenFeedback();
  };
  return <div className="topbar-tools">
    {state?.consentNotice && !updateWorking && <section className="customer-consent-notice" aria-label="出错自动上报说明" role="status">
      <p>软件出错时，会自动把出错现场（错误信息、出错前的操作步骤、微信操作失败时的截图）发给技术支持，用来直接定位和修复问题，不需要你再手动导出诊断。</p>
      <div><button type="button" className="secondary-button" onClick={() => void acknowledgeConsent(true)}>去设置里关闭</button><button type="button" className="primary-button" onClick={() => void acknowledgeConsent()}>知道了</button></div>
    </section>}
    {updateWorking && <section className="customer-update-progress" aria-label="软件更新进度" role="status">
      <div><strong>{updateLabel}</strong>{state?.stage === "downloading" && Number(state.totalBytes) > 0 && <span>{((state.downloadedBytes || 0) / 1048576).toFixed(1)} / {((state.totalBytes || 0) / 1048576).toFixed(1)} MB</span>}</div>
      {state?.stage === "downloading" ? <progress max={100} value={downloadPercent} aria-label={`正在下载 ${downloadPercent}%`} /> : <progress aria-label={updateLabel} />}
      {state?.waitingReason && <p>{state.waitingReason}</p>}
    </section>}
    <button type="button" className="topbar-tool" aria-label={`更新公告${state?.unreadAnnouncements ? `，${state.unreadAnnouncements} 条未读` : ""}`} title="更新公告" aria-expanded={panel === "announcements"}
      onClick={() => void openAnnouncements()}><Bell size={17} /><span>更新公告</span>{Boolean(state?.unreadAnnouncements) && <span className="topbar-unread" aria-hidden="true" />}</button>
    <div className={`topbar-update${updateReady ? " is-ready" : ""}`}>
      {updateMessage && !(updateError || state?.error || state?.updateFailure) && <span className="topbar-update-caption" role="status" title={updateMessage}>{updateMessage}</span>}
      <button type="button" className="topbar-tool topbar-update-action" aria-label={updateLabel}
        title={updateReady ? "立即更新，软件将自动重启" : updateLabel} disabled={!state?.enabled || updateWorking} onClick={() => void update()}>
        <RefreshCw size={17} /><span>{updateLabel}</span>
      </button>
      {state?.updateRequested && state.stage === "waiting" && <button type="button" className="topbar-tool" onClick={() => void window.xiaoxiCloudMaintenance?.cancelUpdate().then(value => { setState(value); if (!value.updateRequested) setUpdateNotice("更新已取消；已暂停的微信任务可在今日计划中手动继续。"); }).catch(() => setUpdateError("取消未完成，请重试。"))}>取消等待</button>}
      {(updateError || state?.error || state?.updateFailure) && <span className="topbar-update-notice is-error" role="status">{updateMessage}</span>}
    </div>
    <details className="topbar-secondary"><summary className="topbar-tool" aria-label="更多工具" title="更多工具"><MoreHorizontal size={18} /></summary><div className="topbar-secondary-menu"><button className="topbar-tool" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); void openAnnouncements(); }}><Bell size={17} /><span>更新公告{state?.unreadAnnouncements ? ' · 有未读' : ''}</span></button></div></details>
    {panel === "announcements" && <CustomerPanel title="更新公告" description="从第一版到现在，每一次更新都在这里。" onClose={() => setPanel(null)}>
      <div className="announcement-toolbar"><span>当前版本 {state?.version || "—"}</span><button type="button" className="customer-text-button" disabled={!state?.enabled || state.announcementsChecking} onClick={() => void refresh()}><RefreshCw size={14} />{state?.announcementsChecking ? "正在刷新…" : "刷新公告"}</button></div>
      {allVersions.length ? <>
        <div className="announcement-summary">
          <div><strong>{allVersions.length}</strong><span>个版本</span></div>
          {daysOfUpdates > 0 && <div><strong>{daysOfUpdates}</strong><span>天持续更新</span></div>}
          <p>从 {allVersions[allVersions.length - 1].version} 到 {allVersions[0].version}，我们一直在根据大家的反馈打磨。</p>
        </div>
        <div className="announcement-list">
          {allVersions.map((entry, index) => <div key={entry.version}>
            {series(entry.version) !== series(allVersions[index - 1]?.version || "") && <h3 className="announcement-series">{series(entry.version)} 系列 <small>{allVersions.filter((item) => series(item.version) === series(entry.version)).length} 个版本</small></h3>}
            <details className="announcement-entry" open={index === 0}>
              <summary><strong>版本 {entry.version}</strong>{entry.date && <time dateTime={entry.date}>{entry.date.replace(/-/g, ".")}</time>}</summary>
              <p>{entry.notes || "此版本尚未提供更新说明。"}</p>
            </details>
          </div>)}
        </div>
      </> : <p className="customer-empty">{state?.enabled ? "暂时没有收到更新公告。联网后刷新即可查看。" : "当前版本尚未启用云端公告。"}</p>}
      {(error || state?.announcementError) && <p className="customer-error" role="alert">{error || state?.announcementError}</p>}
      {state?.lastAnnouncementsCheck && <p className="customer-field-hint">最近检查：{new Date(state.lastAnnouncementsCheck).toLocaleString("zh-CN", { hour12: false })}。</p>}
    </CustomerPanel>}
  </div>;
}
