import { type ReactNode, useEffect, useRef, useState } from "react";
import type { CloudStatus } from "./CloudMaintenance";
import { MascotHello } from "./MascotHello";
import { releaseVoice } from "./release-voice";
import "./launch-update-gate.css";

// 主进程对卡住的连接、以及低于 32 KB/s 的连接（每个文件最多两次）自动换连接续传（component-store.cjs）；
// 只有它真的会重连时才这么说，换过两次还慢就如实显示速度。
const SLOW_BYTES_PER_SECOND = 32 * 1024, SLOW_RECONNECTS = 2;
const megabytes = (bytes: number) => (bytes / 1048576).toFixed(1);
export function downloadDetail(downloaded: number, total: number, speed: number | null, slowReconnects = 0) {
  const done = `已下载 ${megabytes(downloaded)} / ${megabytes(total)} MB`;
  if (speed === null || !Number.isFinite(speed) || downloaded >= total) return done;
  if (speed < 1024 || speed < SLOW_BYTES_PER_SECOND && slowReconnects < SLOW_RECONNECTS) return `${done}。网络有点慢，正在自动重新连接，已下载的不会丢，不用关掉软件。`;
  const rate = speed >= 1048576 ? `${megabytes(speed)} MB` : `${Math.round(speed / 1024)} KB`;
  const seconds = Math.ceil(Math.max(0, total - downloaded) / speed);
  return `${done}，每秒 ${rate}，大约还要 ${seconds < 60 ? `${Math.max(1, seconds)} 秒` : `${Math.ceil(seconds / 60)} 分钟`}`;
}

// 打开即更新：有新版时先装好再进入，期间不挂载业务页面，也就不会启动任何任务。
export function LaunchUpdateGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CloudStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [now, setNow] = useState(Date.now());
  // The reason shown when the gate let the customer in; later background checks must not blink or replace it.
  const [notice, setNotice] = useState<{ text: string; closed: boolean } | null>(null);
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
  // Speed over the last five seconds, measured here so it falls to zero when the bytes stop arriving.
  // Bytes an earlier attempt left on disk are not counted: they arrive in one jump when a download resumes.
  const downloading = !open && state?.stage === "downloading" && Number(state.totalBytes) > 0 && gate?.phase !== "retrying";
  const fetched = useRef(0);
  fetched.current = (state?.downloadedBytes || 0) - (state?.downloadResumedBytes || 0);
  const [speed, setSpeed] = useState<number | null>(null);
  useEffect(() => {
    if (!downloading) { setSpeed(null); return; }
    let samples: { at: number; bytes: number }[] = [{ at: performance.now(), bytes: fetched.current }];
    const timer = window.setInterval(() => {
      const sample = { at: performance.now(), bytes: fetched.current };
      // The counter restarts when a new attempt begins; measure that attempt on its own.
      samples = sample.bytes < samples[0].bytes ? [sample] : [...samples, sample].slice(-6);
      setSpeed(samples.length > 2 ? (sample.bytes - samples[0].bytes) / ((sample.at - samples[0].at) / 1000) : null);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [downloading]);
  // 程序文件缺失时放行进入当前版本，并说明原因和修复办法（重试补不回被删的文件）。
  useEffect(() => {
    if (!notice && gate?.phase === "open" && gate.reason === "base_damaged" && state?.error) setNotice({ text: state.error, closed: false });
  }, [notice, gate?.phase, gate?.reason, state?.error]);
  if (open && notice && !notice.closed) return <>
    {children}
    <aside className="launch-update-notice" role="alert">
      <strong>暂时无法自动更新</strong>
      <p>{notice.text}</p>
      <button type="button" onClick={() => setNotice({ ...notice, closed: true })}>知道了</button>
    </aside>
  </>;
  if (open) return <>{children}</>;
  if (!state || !gate) return <main className="launch-update" aria-busy="true" />;

  const percent = Math.max(0, Math.min(100, Math.floor(state.progress || 0)));
  const title = gate.phase === "checking" && !state.nextVersion ? "正在检查更新…"
    : gate.phase === "installing" || ["preparing", "verifying", "waiting"].includes(state.stage) ? `正在安装 ${state.nextVersion}`
    : `正在更新到 ${state.nextVersion}`;
  const seconds = Math.max(0, Math.ceil((gate.retryAt - now) / 1000));
  const detail = gate.phase === "retrying"
    ? `${seconds} 秒后自动重试（第 ${gate.attempt} 次），已下载的部分会保留。`
    : gate.phase === "installing" ? "安装完成后软件会自动重新打开，请不要关闭电脑。"
    : downloading ? downloadDetail(state.downloadedBytes || 0, state.totalBytes || 0, speed, state.downloadSlowReconnects || 0)
    : gate.phase === "checking" && !state.nextVersion ? "连不上更新服务器时会直接进入当前版本。" : "正在校验更新文件…";
  const coming = state.announcements?.find((entry) => entry.version === state.nextVersion);
  const highlight = coming ? releaseVoice(coming.version, coming.notes).highlight : "";
  return <main className="launch-update" role="status" aria-live="polite">
    <section className="launch-update-card">
      <div className="launch-update-hero">
        <MascotHello moment="work" width={132} />
        <div>
          <strong>{gate.phase === "retrying" ? "网络有点慢，我再试一次～" : "我去换身新本领，马上回来～"}</strong>
          {highlight && <p>这次会带回来：{highlight}</p>}
        </div>
      </div>
      <h1>{title}</h1>
      {downloading ? <progress max={100} value={percent} aria-label={`已下载 ${percent}%`} /> : <progress aria-label={title} />}
      {gate.phase === "retrying" && state.error && <p className="launch-update-error">{state.error}</p>}
      <p>{detail}</p>
      <p className="launch-update-note">更新完成后自动进入软件，不需要做任何操作。</p>
    </section>
  </main>;
}
