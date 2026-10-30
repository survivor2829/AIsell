import { useEffect, useState } from "react";
import { AppWindow, Camera, FolderOpen, House, ImageUp, MessageSquareText, Moon, PackagePlus, RotateCw, Square, Sun, Volume1, Volume2, X } from "lucide-react";

// 手机矩阵 batch actions on the ticked phones (part 4): one press, every ticked phone does it, and the
// progress card says which phones are done and which did not make it and why.
export type BatchResult = { serial: string; status: "waiting" | "running" | "done" | "failed" | "skipped"; error: string; hint: string };
export type BatchState = { id: number; kind: string; label: string; total: number; done: number; failed: number; running: boolean; stopping: boolean; folder: string; waitingUser: number; results: BatchResult[] };
export type BatchApi = {
  batchStart: (kind: string, serials: string[], options?: Record<string, unknown>) => Promise<{ ok: boolean; state?: BatchState; error?: string }>;
  batchStop: () => Promise<{ ok: boolean; state?: BatchState | null }>;
  batchStatus: () => Promise<{ ok: boolean; state?: BatchState | null }>;
  pickFiles: (kind: string) => Promise<{ ok: boolean; state?: string[] }>;
  openFolder: (folder: string) => Promise<{ ok: boolean; state?: boolean }>;
  onBatch: (callback: (state: BatchState | null) => void) => () => void;
};

// The apps people open most on these phones; any other app goes in by its package name.
const APPS = [
  { name: "抖音", pkg: "com.ss.android.ugc.aweme" }, { name: "抖音极速版", pkg: "com.ss.android.ugc.aweme.lite" },
  { name: "快手", pkg: "com.smile.gifmaker" }, { name: "快手极速版", pkg: "com.kuaishou.nebula" },
  { name: "小红书", pkg: "com.xingin.xhs" }, { name: "微信", pkg: "com.tencent.mm" }
];

type Panel = "" | "text" | "open" | "reboot";

export function PhoneBatchBar({ api, serials, names }: { api: BatchApi; serials: string[]; names: Record<string, string> }) {
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [panel, setPanel] = useState<Panel>("");
  const [text, setText] = useState("");
  const [pkg, setPkg] = useState("");
  const [message, setMessage] = useState("");
  const [closed, setClosed] = useState(0);
  useEffect(() => {
    let active = true;
    const off = api.onBatch((state) => { if (active) setBatch(state); });
    void api.batchStatus().then((result) => { if (active && result.state) setBatch(result.state); });
    return () => { active = false; off(); };
  }, [api]);

  const busy = Boolean(batch?.running);
  const disabled = busy || !serials.length;
  const start = async (kind: string, options: Record<string, unknown> = {}) => {
    setMessage("");
    const result = await api.batchStart(kind, serials, options);
    if (!result.ok) { setMessage(result.error || "没开始，请再试一次。"); return; }
    if (result.state) setBatch(result.state);
    setPanel("");
  };
  const withFiles = async (kind: "install" | "media") => {
    const picked = (await api.pickFiles(kind)).state || [];
    if (!picked.length) return;
    await start(kind, kind === "install" ? { apk: picked[0] } : { files: picked });
  };
  const toggle = (next: Panel) => { setPanel(panel === next ? "" : next); setMessage(""); };

  const failed = batch?.results.filter((item) => item.status === "failed") || [];
  const asking = batch?.running ? batch.results.filter((item) => item.hint) : [];
  const showCard = batch && batch.id !== closed;
  return <div className="pm-batch">
    <div className="pm-batch-bar" role="toolbar" aria-label="批量操作勾选的手机">
      <span className="pm-batch-title">批量操作 <small>{serials.length ? `对勾选的 ${serials.length} 部` : "先勾选手机"}</small></span>
      <button type="button" disabled={disabled} onClick={() => void withFiles("install")}><PackagePlus size={16} />装 App</button>
      <button type="button" disabled={disabled} onClick={() => void withFiles("media")}><ImageUp size={16} />传到相册</button>
      <button type="button" disabled={disabled} aria-expanded={panel === "text"} onClick={() => toggle("text")}><MessageSquareText size={16} />发文字</button>
      <button type="button" disabled={disabled} aria-expanded={panel === "open"} onClick={() => toggle("open")}><AppWindow size={16} />打开 App</button>
      <button type="button" disabled={disabled} onClick={() => void start("key", { key: "home" })}><House size={16} />回桌面</button>
      <button type="button" disabled={disabled} onClick={() => void start("key", { key: "wake" })}><Sun size={16} />亮屏</button>
      <button type="button" disabled={disabled} onClick={() => void start("key", { key: "sleep" })}><Moon size={16} />息屏</button>
      <button type="button" disabled={disabled} onClick={() => void start("key", { key: "volume_up" })}><Volume2 size={16} />音量+</button>
      <button type="button" disabled={disabled} onClick={() => void start("key", { key: "volume_down" })}><Volume1 size={16} />音量-</button>
      <button type="button" disabled={disabled} onClick={() => void start("screenshot", { names: Object.fromEntries(serials.map((serial) => [serial, names[serial] || serial])) })}><Camera size={16} />截图</button>
      <button type="button" disabled={disabled} aria-expanded={panel === "reboot"} onClick={() => toggle("reboot")}><RotateCw size={16} />重启</button>
    </div>

    {panel === "text" && <form className="pm-batch-panel" onSubmit={(event) => { event.preventDefault(); void start("text", { text }); }}>
      <p>先在每部手机上点好输入框（可以用上面的同步操作一起点），再把文字一次发过去。中文也可以。</p>
      <div className="pm-batch-row"><input value={text} maxLength={2000} onChange={(event) => setText(event.target.value)} placeholder="要发到手机上的文字" aria-label="要发到手机上的文字" />
        <button type="submit" className="is-primary" disabled={!text.trim()}>发到 {serials.length} 部手机</button></div>
    </form>}
    {panel === "open" && <div className="pm-batch-panel">
      <p>勾选的手机一起打开这个 App：</p>
      <div className="pm-batch-apps">{APPS.map((app) => <button type="button" key={app.pkg} onClick={() => void start("open", { pkg: app.pkg, appName: app.name })}>{app.name}</button>)}</div>
      <form className="pm-batch-row" onSubmit={(event) => { event.preventDefault(); void start("open", { pkg }); }}>
        <input value={pkg} onChange={(event) => setPkg(event.target.value)} placeholder="其他 App 的包名，例如 com.xingin.xhs" aria-label="App 包名" />
        <button type="submit" disabled={!pkg.trim()}>打开</button>
      </form>
    </div>}
    {panel === "reboot" && <div className="pm-batch-panel is-warn">
      <p>重启 {serials.length} 部手机？重启要一两分钟，期间画面会断开，开机后会自动连回来。</p>
      <div className="pm-batch-row"><button type="button" onClick={() => setPanel("")}>先不重启</button><button type="button" className="is-primary" onClick={() => void start("reboot")}>确认重启</button></div>
    </div>}
    {message && <p className="pm-alert" role="alert">{message}</p>}

    {showCard && <section className={`pm-batch-card${batch.running ? "" : batch.failed ? " is-failed" : " is-done"}`} aria-live="polite">
      <header>
        <strong>{batch.label}</strong>
        <span>{batch.running ? `${batch.stopping ? "正在停下" : "进行中"} · ${batch.done}/${batch.total}` : batch.failed ? `${batch.total - batch.failed} 部做好，${batch.failed} 部没成` : `${batch.total} 部都做好了`}</span>
        {batch.running ? <button type="button" disabled={batch.stopping} onClick={() => void api.batchStop()}><Square size={14} />停下</button>
          : <button type="button" className="pm-close" aria-label="收起结果" onClick={() => setClosed(batch.id)}><X size={16} /></button>}
      </header>
      <i className="pm-batch-progress"><b style={{ width: `${batch.total ? (batch.done / batch.total) * 100 : 0}%` }} /></i>
      {asking.length > 0 && <div className="pm-batch-ask" role="alert"><p>{asking[0].hint}</p><span>等你点的手机：{asking.map((item) => names[item.serial] || item.serial).join("、")}</span></div>}
      {failed.length > 0 && <ul className="pm-batch-failed">{failed.map((item) => <li key={item.serial}><b>{names[item.serial] || item.serial}</b>{item.error}</li>)}</ul>}
      {!batch.running && batch.folder && <button type="button" className="pm-batch-folder" onClick={() => void api.openFolder(batch.folder)}><FolderOpen size={16} />打开截图文件夹</button>}
    </section>}
  </div>;
}
