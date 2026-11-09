import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import "./AccountManagementPage.css";

type Device = { id: number; label: string; createdAt: number; lastSeenAt: number };
type ManagedAccount = {
  id: number; phone: string; displayName: string; note: string; status: "active" | "disabled"; setUp: boolean;
  expiresAt: number | null; lastLoginAt: number | null; multiDevice: boolean; isAdmin: boolean; devices: Device[];
};
type Result = { ok: boolean; error?: string; accounts?: ManagedAccount[] };
type AccountAdminApi = {
  adminState: () => Promise<{ unlocked: boolean }>;
  adminUnlock: (password: string) => Promise<Result>;
  adminList: () => Promise<Result>;
  adminCreate: (payload: { phone: string; password: string; displayName: string; note: string; expiresAt: number | null }) => Promise<Result>;
  adminAction: (payload: { id: number; action: string; enabled?: boolean; status?: string; deviceId?: number; password?: string; expiresAt?: number | null }) => Promise<Result>;
};

const api = () => (window as unknown as { xiaoxiAccount?: Partial<AccountAdminApi> }).xiaoxiAccount as AccountAdminApi | undefined;
const dateText = (seconds: number | null) => seconds ? new Date(seconds * 1000).toLocaleDateString("zh-CN") : "长期有效";
const timeText = (seconds: number | null) => seconds ? new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false }) : "从未登录";
const dateValue = (seconds: number | null) => {
  if (!seconds) return "";
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
// A date field means "usable through that day".
const endOfDay = (value: string) => value ? Math.floor(new Date(`${value}T23:59:59`).getTime() / 1000) : null;

function newPassword() {
  const letters = "abcdefghjkmnpqrstuvwxyz", digits = "23456789", values = crypto.getRandomValues(new Uint32Array(10));
  return Array.from(values, (value, index) => index < 6 ? letters[value % letters.length] : digits[value % digits.length]).join("");
}

function ExpiryEditor({ value, busy, onSave, onInvalid }: { value: number | null; busy: boolean; onSave: (next: number | null) => void; onInvalid: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const save = () => {
    const field = input.current;
    if (!field) return;
    if (field.validity.badInput) { onInvalid("到期日没有填完整。"); return; }
    const next = endOfDay(field.value);
    if (dateValue(next) === dateValue(value)) return;
    if (next === null && !confirmClear) { setConfirmClear(true); return; }
    setConfirmClear(false);
    onSave(next);
  };
  return <>
    <label>到期日<input ref={input} type="date" defaultValue={dateValue(value)} key={value ?? 0} onChange={() => setConfirmClear(false)} /></label>
    <button type="button" disabled={busy} onClick={save}>{confirmClear ? "再点确认改为长期有效" : "保存到期日"}</button>
  </>;
}

export function AccountManagementPage({ selfPhone }: { selfPhone: string }) {
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [accounts, setAccounts] = useState<ManagedAccount[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [confirming, setConfirming] = useState("");
  const [form, setForm] = useState({ phone: "", displayName: "", note: "", expires: "", password: newPassword() });

  const lock = useCallback((message = "") => { setUnlocked(false); setAccounts([]); setError(message); }, []);
  const load = useCallback(async () => {
    const result = await api()!.adminList();
    if (result.ok) setAccounts(result.accounts || []);
    else if (result.error === "需要重新验证密码") lock(result.error);
    else setError(result.error || "没有读到账号");
  }, [lock]);

  useEffect(() => {
    let alive = true;
    void api()?.adminState().then((state) => {
      if (!alive) return;
      setUnlocked(state.unlocked);
      if (state.unlocked) void load();
    }).catch(() => { if (alive) setUnlocked(false); });
    return () => { alive = false; };
  }, [load]);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result = await api()!.adminUnlock(password);
      if (!result.ok) { setError(result.error || "验证没有通过"); return; }
      setPassword(""); setUnlocked(true);
      await load();
    } finally { setBusy(false); }
  }

  async function act(payload: Parameters<AccountAdminApi["adminAction"]>[0], done: string) {
    if (busy) return;
    setBusy(true); setError(""); setNotice(""); setConfirming("");
    try {
      const result = await api()!.adminAction(payload);
      if (!result.ok) {
        if (result.error === "需要重新验证密码") lock(result.error); else setError(result.error || "操作没有完成");
        return;
      }
      setNotice(done);
      await load();
    } finally { setBusy(false); }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const initial = form.password;
      const result = await api()!.adminCreate({ phone: form.phone.trim(), password: initial, displayName: form.displayName.trim(), note: form.note.trim(), expiresAt: endOfDay(form.expires) });
      if (!result.ok) {
        if (result.error === "需要重新验证密码") lock(result.error); else setError(result.error || "没有建成");
        return;
      }
      setNotice(`账号 ${form.phone.trim()} 已建好，默认只能一台电脑登录。初始密码 ${initial}，请发给客户（只显示这一次），客户第一次登录要改密码。`);
      setForm({ phone: "", displayName: "", note: "", expires: "", password: newPassword() });
      setCreating(false);
      await load();
    } finally { setBusy(false); }
  }

  const shown = useMemo(() => {
    const word = query.trim().toLowerCase();
    return word ? accounts.filter((item) => `${item.phone} ${item.displayName} ${item.note}`.toLowerCase().includes(word)) : accounts;
  }, [accounts, query]);

  // A destructive button asks once more on the button itself.
  const confirmFirst = (key: string, run: () => void) => { if (confirming === key) run(); else setConfirming(key); };

  if (unlocked === null) return <section className="page account-admin"><p className="account-admin-muted">正在读取…</p></section>;

  if (!unlocked) return <section className="page account-admin">
    <header className="account-admin-head"><div><h1>账号管理</h1><p>这里能改所有账号，进入前请再输一次你的登录密码。验证后 30 分钟内不用重复输入。</p></div></header>
    <form className="account-admin-unlock" onSubmit={(event) => void unlock(event)}>
      <label>登录密码<input type="password" autoComplete="current-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button type="submit" className="account-admin-primary" disabled={busy || !password}>{busy ? "验证中…" : "进入账号管理"}</button>
      {error && <p className="account-admin-error" role="alert">{error}</p>}
    </form>
  </section>;

  return <section className="page account-admin">
    <header className="account-admin-head">
      <div><h1>账号管理</h1><p>「通用」的账号可以在多台电脑同时登录，「一台电脑」的账号在新电脑登录时，旧电脑会自动下线。</p></div>
      <button type="button" className="account-admin-primary" onClick={() => setCreating((value) => !value)}>{creating ? "收起" : "新建账号"}</button>
    </header>
    {notice && <p className="account-admin-notice" role="status">{notice}</p>}
    {error && <p className="account-admin-error" role="alert">{error}</p>}
    {creating && <form className="account-admin-create" onSubmit={(event) => void create(event)}>
      <label>手机号<input required inputMode="numeric" pattern="1[3-9][0-9]{9}" maxLength={11} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
      <label>初始密码<input required minLength={8} maxLength={64} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
      <label>客户名称<input maxLength={40} value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label>
      <label>备注<input maxLength={200} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></label>
      <label>到期日（可空）<input type="date" value={form.expires} onChange={(event) => setForm({ ...form, expires: event.target.value })} /></label>
      <button type="submit" className="account-admin-primary" disabled={busy}>建好账号</button>
      <p className="account-admin-muted">新账号默认只能一台电脑登录，建好后可以在列表里改成通用。</p>
    </form>}
    <div className="account-admin-tools"><input type="search" placeholder="搜手机号、名称或备注" aria-label="搜索账号" value={query} onChange={(event) => setQuery(event.target.value)} /><span>共 {accounts.length} 个账号</span></div>
    <div className="account-admin-list">
      {!shown.length && <p className="account-admin-muted">没有找到账号。</p>}
      {shown.map((item) => {
        const self = Boolean(selfPhone) && item.phone === selfPhone;
        const open = openId === item.id;
        const locked = self || item.isAdmin;
        return <article className="account-admin-row" key={item.id}>
          <div className="account-admin-summary">
            <div className="account-admin-who">
              <strong>{item.phone || "待设置手机号"}{self && <em>我</em>}{item.isAdmin && <em className="is-admin">管理员</em>}</strong>
              <span>{[item.displayName, item.note].filter(Boolean).join(" · ") || "未填名称"}</span>
            </div>
            <div className="account-admin-facts">
              <span className={item.status === "active" ? "is-on" : "is-off"}>{item.status === "active" ? "正常" : "已停用"}</span>
              <span>到期：{dateText(item.expiresAt)}</span>
              <span>已登录 {item.devices.length} 台</span>
            </div>
            <div className="account-admin-mode" role="group" aria-label="登录方式">
              <button type="button" aria-pressed={item.multiDevice} disabled={busy || (locked && !self)} onClick={() => { if (!item.multiDevice) void act({ id: item.id, action: "multi-device", enabled: true }, "已改为通用，可以多台电脑同时登录。"); }}>通用</button>
              <button type="button" aria-pressed={!item.multiDevice} disabled={busy || locked} onClick={() => { if (item.multiDevice) confirmFirst(`single-${item.id}`, () => void act({ id: item.id, action: "multi-device", enabled: false }, "已改为一台电脑，只保留最近使用的那台，其他电脑已下线。")); }}>{confirming === `single-${item.id}` ? "再点确认" : "一台电脑"}</button>
            </div>
            <button type="button" className="account-admin-more" aria-expanded={open} onClick={() => { setOpenId(open ? null : item.id); setConfirming(""); }}>{open ? "收起" : "管理"}</button>
          </div>
          {open && <div className="account-admin-detail">
            <h2>已登录的电脑</h2>
            {item.devices.length ? <ul>{item.devices.map((device) => <li key={device.id}>
              <span>电脑 {device.label}</span><span>首次登录 {timeText(device.createdAt)}</span><span>最近使用 {timeText(device.lastSeenAt)}</span>
              {!locked && <button type="button" disabled={busy} onClick={() => confirmFirst(`device-${device.id}`, () => void act({ id: item.id, action: "device-sign-out", deviceId: device.id }, "这台电脑已下线。"))}>{confirming === `device-${device.id}` ? "再点确认" : "让它下线"}</button>}
            </li>)}</ul> : <p className="account-admin-muted">目前没有电脑登录。最近登录：{timeText(item.lastLoginAt)}</p>}
            {locked ? <p className="account-admin-muted">{self ? "这是你自己的账号，" : "这是管理员账号，"}需要改动请到网页后台操作。</p> : <div className="account-admin-actions">
              <ExpiryEditor value={item.expiresAt} busy={busy} onInvalid={(message) => { setNotice(""); setError(message); }} onSave={(next) => void act({ id: item.id, action: "expires", expiresAt: next }, next ? "到期日已更新。" : "已改为长期有效。")} />
                <button type="button" disabled={busy} onClick={() => confirmFirst(`status-${item.id}`, () => void act({ id: item.id, action: "status", status: item.status === "active" ? "disabled" : "active" }, item.status === "active" ? "已停用，这个账号的电脑全部下线。" : "已启用。"))}>{confirming === `status-${item.id}` ? "再点确认" : item.status === "active" ? "停用账号" : "启用账号"}</button>
                {item.setUp && <button type="button" disabled={busy} onClick={() => confirmFirst(`reset-${item.id}`, () => { const next = newPassword(); void act({ id: item.id, action: "reset-password", password: next }, `密码已重置为 ${next}，请发给客户（只显示这一次）。这个账号的电脑全部下线，下次登录要改密码。`); })}>{confirming === `reset-${item.id}` ? "再点确认" : "重置密码"}</button>}
                {item.devices.length > 0 && <button type="button" disabled={busy} onClick={() => confirmFirst(`signout-${item.id}`, () => void act({ id: item.id, action: "sign-out" }, "这个账号的电脑已全部下线。"))}>{confirming === `signout-${item.id}` ? "再点确认" : "全部下线"}</button>}
            </div>}
          </div>}
        </article>;
      })}
    </div>
  </section>;
}
