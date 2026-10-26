import { type ReactNode, useEffect, useState } from "react";
import type { CloudStatus } from "./CloudMaintenance";
import "./launch-update-gate.css";

// 打开即更新：有新版时先装好再进入，期间不挂载业务页面，也就不会启动任何任务。
export function LaunchUpdateGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CloudStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const api = window.xiaoxiCloudMaintenance;
    if (!api) { setUnavailable(true); return; }
    let active = true; let updated = false;
    const unsubscribe = api.onUpdate(value => { updated = true; if (active) setState(value); });
    api.status().then(value => { if (active && !updated) setState(value); }).catch(() => { if (active) setUnavailable(true); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const gate = state?.launchGate;
  const open = unavailable || (state && (!gate || gate.phase === "open"));
  useEffect(() => {
    if (gate?.phase !== "retrying") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [gate?.phase]);
  if (open) return <>{children}</>;
  if (!state || !gate) return <main className="launch-update" aria-busy="true" />;

  const percent = Math.max(0, Math.min(100, Math.floor(state.progress || 0)));
  const downloading = state.stage === "downloading" && Number(state.totalBytes) > 0;
  const title = gate.phase === "checking" && !state.nextVersion ? "正在检查更新…"
    : gate.phase === "installing" || ["preparing", "verifying", "waiting"].includes(state.stage) ? `正在安装 ${state.nextVersion}`
    : `正在更新到 ${state.nextVersion}`;
  const seconds = Math.max(0, Math.ceil((gate.retryAt - now) / 1000));
  const detail = gate.phase === "retrying"
    ? `${seconds} 秒后自动重试（第 ${gate.attempt} 次），已下载的部分会保留。`
    : gate.phase === "installing" ? "安装完成后软件会自动重新打开，请不要关闭电脑。"
    : downloading ? `已下载 ${((state.downloadedBytes || 0) / 1048576).toFixed(1)} / ${((state.totalBytes || 0) / 1048576).toFixed(1)} MB`
    : gate.phase === "checking" && !state.nextVersion ? "连不上更新服务器时会直接进入当前版本。" : "正在校验更新文件…";
  return <main className="launch-update" role="status" aria-live="polite">
    <section className="launch-update-card">
      <h1>{title}</h1>
      {downloading && gate.phase !== "retrying" ? <progress max={100} value={percent} aria-label={`已下载 ${percent}%`} /> : <progress aria-label={title} />}
      {gate.phase === "retrying" && state.error && <p className="launch-update-error">{state.error}</p>}
      <p>{detail}</p>
      <p className="launch-update-note">更新完成后自动进入软件，不需要做任何操作。</p>
    </section>
  </main>;
}
