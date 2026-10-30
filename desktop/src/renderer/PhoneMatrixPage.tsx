import { useEffect, useMemo, useState } from "react";
import { BatteryCharging, BatteryMedium, ChevronLeft, Circle, House, LayoutGrid, List, Pencil, RefreshCw, Send, ShieldAlert, Smartphone, Square, Sun, Unplug, Volume1, Volume2, X } from "lucide-react";
import { PhoneScreen } from "./PhoneScreen";
import { PhoneBatchBar, type BatchApi } from "./PhoneBatchBar";
import "./PhoneMatrixPage.css";

// 手机矩阵 (user project of 2026-10-30): every phone on the USB hub with the name / number / note /
// group the user gives it, a wall of live screens, one phone opened large to control (and with 同步 the
// ticked phones follow), and batch actions on the ticked phones.
type PhoneState = "device" | "unauthorized" | "offline" | "disconnected" | string;
type Phone = { serial: string; state: PhoneState; number: number | null; name: string; note: string; group: string; brand: string; model: string; android: string; battery: number | null; charging: boolean | null; screen: { width: number; height: number } | null };
type MatrixState = { adb: boolean; error: string; laixiRunning: boolean; groups: string[]; devices: Phone[] };
type Result = { ok: boolean; state?: MatrixState; error?: string };
type PhoneMatrixApi = BatchApi & {
  status: () => Promise<Result>; refresh: () => Promise<Result>;
  update: (serial: string, fields: Partial<Pick<Phone, "name" | "note" | "group">> & { number?: number }) => Promise<Result>;
  forget: (serial: string) => Promise<Result>;
  watch: (serials: string[], main: string) => Promise<Result>;
  input: (payload: { targets: string[]; kind: "touch" | "key" | "text" | "screen"; action?: number; x?: number; y?: number; keycode?: number; text?: string; on?: boolean; jitterMs?: number }) => void;
  onScreen: (callback: (packet: never) => void) => () => void;
  onUpdate: (callback: (state: MatrixState) => void) => () => void;
};
declare global { interface Window { xiaoxiPhoneMatrix?: PhoneMatrixApi } }

// 随机延迟 lets each following phone lag up to this long, so the phones do not move in lockstep.
const JITTER_MS = 1500;
const STATE_TEXT: Record<string, string> = { device: "在线", unauthorized: "等待授权", offline: "连接不稳", disconnected: "已断开", authorizing: "授权中" };

export function PhoneMatrixPage() {
  const api = window.xiaoxiPhoneMatrix;
  const [state, setState] = useState<MatrixState>();
  const [group, setGroup] = useState("全部");
  const [editing, setEditing] = useState<Phone | null>(null);
  const [message, setMessage] = useState("");
  // 手机墙 (part 2): live screens, one opened large, and 同步 to the ticked phones.
  const [view, setView] = useState<"wall" | "list">("wall");
  const [main, setMain] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [syncOn, setSyncOn] = useState(false);
  const [jitter, setJitter] = useState(false);
  const [text, setText] = useState("");
  useEffect(() => {
    if (!api) return;
    let active = true;
    const off = api.onUpdate((next) => { if (active) setState(next); });
    void api.status().then((result) => { if (active && result.state) setState(result.state); });
    return () => { active = false; off(); };
  }, [api]);

  const devices = state?.devices || [];
  const online = devices.filter((phone) => phone.state === "device").length;
  const waiting = devices.filter((phone) => phone.state === "unauthorized" || phone.state === "authorizing").length;
  const gone = devices.filter((phone) => phone.state === "disconnected" || phone.state === "offline").length;
  const groups = useMemo(() => ["全部", ...(state?.groups || []), ...(devices.some((phone) => !phone.group) && state?.groups.length ? ["未分组"] : [])], [state, devices]);
  const shown = devices.filter((phone) => group === "全部" || (group === "未分组" ? !phone.group : phone.group === group));
  const onlineShown = shown.filter((phone) => phone.state === "device");
  const wallKey = view === "wall" ? onlineShown.map((phone) => phone.serial).join(",") : "";
  // Screens run only while the wall is on screen; leaving the page stops them all.
  useEffect(() => {
    if (!api?.watch) return;
    void api.watch(wallKey ? wallKey.split(",") : [], view === "wall" ? main : "");
  }, [api, wallKey, main, view]);
  useEffect(() => () => { void api?.watch?.([], ""); }, [api]);
  const mainPhone = devices.find((phone) => phone.serial === main && phone.state === "device");
  const targets = syncOn ? [...new Set([main, ...picked])].filter((serial) => onlineShown.some((phone) => phone.serial === serial)) : [main];
  const input = (payload: Omit<Parameters<PhoneMatrixApi["input"]>[0], "targets">) => api?.input({ targets, jitterMs: syncOn && jitter ? JITTER_MS : 0, ...payload });
  const togglePick = (serial: string) => setPicked((current) => { const next = new Set(current); if (next.has(serial)) next.delete(serial); else next.add(serial); return next; });
  const allPicked = onlineShown.length > 0 && onlineShown.every((phone) => picked.has(phone.serial));
  const pickedOnline = onlineShown.filter((phone) => picked.has(phone.serial)).map((phone) => phone.serial);
  const phoneNames = useMemo(() => Object.fromEntries(devices.map((phone) => [phone.serial, phone.number !== null ? `${phone.number} 号 ${phone.name}` : phone.name])), [devices]);

  const save = async (fields: { name: string; number: string; note: string; group: string }) => {
    if (!api || !editing) return;
    const result = await api.update(editing.serial, { name: fields.name, note: fields.note, group: fields.group, number: Number(fields.number) });
    if (!result.ok) { setMessage(result.error || "没保存上，请再试一次。"); return; }
    if (result.state) setState(result.state);
    setEditing(null); setMessage("");
  };

  return <section className="ns-page phone-matrix">
    <div className="pm-hero">
      <div>
        <div className="ns-kicker">账号运营 · 手机矩阵</div>
        <h1 className="ns-h1">{online ? <><em>{online} 部</em>手机在线</> : <>插上集线器，手机<em>自动出现</em></>}</h1>
        <p className="pm-lead">集线器上的安卓手机都在这里：每部手机的实时画面，点开一部就能直接操作；打开「同步操作」，勾选的手机跟着一起动；装 App、传视频、发文字、截图也能一次做完。</p>
      </div>
      <dl className="pm-stats">
        <div><dt>在线</dt><dd>{online}</dd></div>
        <div><dt>等待授权</dt><dd className={waiting ? "is-warn" : ""}>{waiting}</dd></div>
        <div><dt>已断开</dt><dd>{gone}</dd></div>
        <button type="button" className="pm-refresh" onClick={() => api && void api.refresh().then((result) => result.state && setState(result.state))}><RefreshCw size={16} />刷新</button>
      </dl>
    </div>

    {state && !state.adb && <p className="pm-alert" role="alert"><ShieldAlert size={18} />{state.error || "没找到 ADB 工具，暂时连不上手机。"}</p>}
    {state?.adb && state.error && <p className="pm-alert" role="alert"><ShieldAlert size={18} />{state.error}</p>}
    {state?.laixiRunning && <p className="pm-alert" role="alert"><ShieldAlert size={18} />来喜群控正在运行。两个软件同时管手机会互相抢、手机会断线，请先把来喜关掉。</p>}
    {waiting > 0 && <p className="pm-tip" role="status"><Smartphone size={18} />有 {waiting} 部手机还没授权：在手机屏幕上点「允许 USB 调试」，勾上「始终允许这台电脑」。没看到弹窗的话，把数据线拔下再插一次。</p>}

    <div className="pm-toolbar">
      <div className="pm-view" role="group" aria-label="显示方式">
        <button type="button" aria-pressed={view === "wall"} onClick={() => setView("wall")}><LayoutGrid size={16} />手机墙</button>
        <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}><List size={16} />设备列表</button>
      </div>
      {groups.length > 1 && <nav className="pm-groups" aria-label="按分组看">
        {groups.map((name) => <button type="button" key={name} aria-pressed={group === name} onClick={() => setGroup(name)}>{name}</button>)}
      </nav>}
    </div>

    {view === "wall" && state && <div className={`pm-wall-layout${mainPhone ? " has-main" : ""}`}>
      <div className="pm-wall-area">
        {onlineShown.length > 0 && api && <PhoneBatchBar api={api} serials={pickedOnline} names={phoneNames} />}
        {onlineShown.length > 0 && <label className="pm-pick-all"><input type="checkbox" checked={allPicked}
          onChange={() => setPicked(allPicked ? new Set() : new Set(onlineShown.map((phone) => phone.serial)))} />全选（已选 {pickedOnline.length} 部）</label>}
        {!onlineShown.length ? <div className="pm-empty"><Smartphone size={34} /><p>还没有在线的手机。手机授权后会自动出现在这里。</p></div>
          : <ul className="pm-wall">
            {onlineShown.map((phone) => <li key={phone.serial} className={`pm-tile${main === phone.serial ? " is-main" : ""}${picked.has(phone.serial) ? " is-picked" : ""}`}>
              <button type="button" className="pm-tile-open" aria-label={`打开 ${phone.name}`} onClick={() => setMain(main === phone.serial ? "" : phone.serial)}>
                <PhoneScreen serial={phone.serial} />
              </button>
              <label className="pm-tile-label"><input type="checkbox" checked={picked.has(phone.serial)} onChange={() => togglePick(phone.serial)} /><b>{phone.number}</b><span>{phone.name}</span></label>
            </li>)}
          </ul>}
      </div>
      {mainPhone && <aside className="pm-main" aria-label={`主控：${mainPhone.name}`}>
        <header><b>{mainPhone.number}</b><strong>{mainPhone.name}</strong><button type="button" className="pm-close" aria-label="关闭主控" onClick={() => setMain("")}><X size={18} /></button></header>
        <PhoneScreen serial={mainPhone.serial} className="is-main" onTouch={(action, x, y) => input({ kind: "touch", action, x, y })} />
        <div className="pm-keys">
          <button type="button" title="返回" aria-label="返回" onClick={() => input({ kind: "key", keycode: 4 })}><ChevronLeft size={18} /></button>
          <button type="button" title="主页" aria-label="主页" onClick={() => input({ kind: "key", keycode: 3 })}><House size={18} /></button>
          <button type="button" title="多任务" aria-label="多任务" onClick={() => input({ kind: "key", keycode: 187 })}><Square size={16} /></button>
          <button type="button" title="音量-" aria-label="音量减" onClick={() => input({ kind: "key", keycode: 25 })}><Volume1 size={18} /></button>
          <button type="button" title="音量+" aria-label="音量加" onClick={() => input({ kind: "key", keycode: 24 })}><Volume2 size={18} /></button>
          <button type="button" title="亮屏" aria-label="亮屏" onClick={() => input({ kind: "screen", on: true })}><Sun size={18} /></button>
          <button type="button" title="电源键" aria-label="电源键" onClick={() => input({ kind: "key", keycode: 26 })}><Circle size={16} /></button>
        </div>
        <form className="pm-text" onSubmit={(event) => { event.preventDefault(); if (text.trim()) { input({ kind: "text", text }); setText(""); } }}>
          <input value={text} onChange={(event) => setText(event.target.value)} placeholder="先点手机上的输入框，再在这里打字发送" aria-label="发送文字到手机" />
          <button type="submit" aria-label="发送"><Send size={16} /></button>
        </form>
        <label className={`pm-sync${syncOn ? " is-on" : ""}`}><input type="checkbox" checked={syncOn} onChange={(event) => setSyncOn(event.target.checked)} />
          <span><strong>同步操作</strong>{syncOn ? `点、滑、按键、打字会同时发到 ${targets.length} 部手机` : "打开后，勾选的手机跟着这台一起动"}</span></label>
        {syncOn && <label className="pm-jitter"><input type="checkbox" checked={jitter} onChange={(event) => setJitter(event.target.checked)} />随机延迟：其他手机各自晚 0–1.5 秒跟上，不那么整齐</label>}
      </aside>}
    </div>}

    {view === "list" && (!state ? <p className="pm-empty">正在读取手机…</p>
      : !devices.length ? <div className="pm-empty"><Smartphone size={34} /><p>还没有发现手机。把集线器插到这台电脑上，打开手机的「USB 调试」，手机就会出现在这里。</p></div>
        : <ul className="pm-grid">
          {shown.map((phone) => <li key={phone.serial} className={`pm-card is-${phone.state === "device" ? "online" : phone.state === "unauthorized" ? "waiting" : "gone"}`}>
            <div className="pm-card-top">
              <span className="pm-number">{phone.number ?? "—"}</span>
              <span className="pm-state"><i />{STATE_TEXT[phone.state] || phone.state}</span>
            </div>
            <strong className="pm-name" title={phone.name}>{phone.name}</strong>
            <span className="pm-model">{[phone.brand, phone.model].filter(Boolean).join(" ") || phone.serial}{phone.android && ` · 安卓 ${phone.android}`}</span>
            {phone.battery !== null && <span className={`pm-battery${phone.battery < 20 ? " is-low" : ""}`}>
              {phone.charging ? <BatteryCharging size={16} /> : <BatteryMedium size={16} />}<i><b style={{ width: `${phone.battery}%` }} /></i>{phone.battery}%
            </span>}
            {(phone.group || phone.note) && <span className="pm-meta">{[phone.group && `分组：${phone.group}`, phone.note].filter(Boolean).join(" · ")}</span>}
            <div className="pm-actions">
              {phone.number !== null && <button type="button" onClick={() => { setEditing(phone); setMessage(""); }}><Pencil size={14} />编辑</button>}
              {phone.state === "disconnected" && <button type="button" onClick={() => api && void api.forget(phone.serial).then((result) => result.state && setState(result.state))}><Unplug size={14} />移除</button>}
            </div>
          </li>)}
        </ul>)}

    {editing && <PhoneEditor phone={editing} groups={state?.groups || []} message={message} onCancel={() => setEditing(null)} onSave={(fields) => void save(fields)} />}
  </section>;
}

function PhoneEditor({ phone, groups, message, onCancel, onSave }: { phone: Phone; groups: string[]; message: string; onCancel: () => void; onSave: (fields: { name: string; number: string; note: string; group: string }) => void }) {
  const [fields, setFields] = useState({ name: phone.name, number: String(phone.number ?? ""), note: phone.note, group: phone.group });
  const set = (key: keyof typeof fields) => (event: { target: { value: string } }) => setFields({ ...fields, [key]: event.target.value });
  return <div className="pm-dialog-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <form className="pm-dialog" aria-label={`编辑 ${phone.name}`} onSubmit={(event) => { event.preventDefault(); onSave(fields); }}>
      <header><h2>编辑手机</h2><button type="button" className="pm-close" aria-label="关闭" onClick={onCancel}><X size={18} /></button></header>
      <label>名字<input value={fields.name} maxLength={30} onChange={set("name")} /></label>
      <label>编号<input value={fields.number} inputMode="numeric" onChange={set("number")} /></label>
      <label>分组<input value={fields.group} maxLength={20} list="pm-group-list" placeholder="例如：抖音 1 组" onChange={set("group")} /></label>
      <datalist id="pm-group-list">{groups.map((name) => <option key={name} value={name} />)}</datalist>
      <label>备注<input value={fields.note} maxLength={100} onChange={set("note")} /></label>
      <p className="pm-serial">设备序列号：{phone.serial}</p>
      {message && <p className="pm-alert" role="alert">{message}</p>}
      <footer><button type="button" onClick={onCancel}>取消</button><button type="submit" className="is-primary">保存</button></footer>
    </form>
  </div>;
}
