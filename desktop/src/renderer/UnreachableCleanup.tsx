import { useEffect, useState } from "react";
import { Ban, RotateCcw, UserX, X } from "lucide-react";
import "./UnreachableCleanup.css";

// Contacts a touch found blocked (消息被拒收) or deleted (需要朋友验证). The customer confirms who leaves the
// contact list (user 2026-11-25: touch only real friends); a friend-verification notice can be wrong, so each
// person can be unticked, and a removed one can be put back. Ticked 同时在微信里删除, they are also deleted from
// the WeChat friend list, one by one, with each result shown.
type WechatDelete = { status: "deleted" | "failed" | "unknown"; stage: string; reason: string };
export type UnreachableEntry = { accountId: string; key: string; name: string; kind: "blocked" | "deleted"; at: string; removed: boolean; removedAt: string; wechatDelete?: WechatDelete };
export type UnreachableList = { ok: boolean; entries: UnreachableEntry[]; pending: number; removed: number; removedNow?: number; restored?: boolean; error?: string;
  wechatRunning?: boolean; wechatStopping?: boolean; wechatStarted?: boolean; wechatReason?: string; wechatSkipped?: number; wechatProgress?: { done: number; total: number; deleted: number; failed: number; unknown: number; current: string } };

const id = (entry: UnreachableEntry) => `${entry.accountId}\u0000${entry.key}`;
const KIND = { blocked: "拉黑了你", deleted: "删除了你" };
// Why a WeChat delete stopped, in words a customer can act on.
const STOPPED: Record<string, string> = {
  wechat_operation_busy: "微信正忙（触达或自动回复在用），稍后再试",
  wechat_account_mismatch: "不是当前登录的微信号的好友",
  wechat_account_changed: "微信已切换到其他账号",
  wechat_external_input_detected: "删除时有人动了鼠标键盘，已停下",
  wechat_account_unverified: "没能确认当前登录的微信号，没有删",
  contact_name_not_unique: "名单里有同名好友，又没有微信号可核对，为免删错没有删",
  contact_not_saved: "没有保存这个人的资料，没法在微信里找他",
  wechat_version_unsupported: "当前微信版本还不支持自动删除",
  stopped_by_user: "已按你的要求停止",
  confirm_dialog_gone: "删除确认框不见了，没有点删除",
  delete_not_pressed: "没有点删除",
  wechat_delete_running: "上一轮删除还没做完",
  wechat_delete_unavailable: "这个版本不能自动删除微信好友",
  chat_title_mismatch: "打开的聊天对不上这个人，已停下",
  profile_wechat_id_mismatch: "资料卡上的微信号对不上，已停下",
  confirm_text_mismatch: "确认框上的名字对不上，已停下"
};
const wechatText = (result: WechatDelete) => result.status === "deleted" ? "微信里已删"
  : result.status === "unknown" ? "微信里结果不明，请到微信看一眼"
  : `微信里没删成：${STOPPED[result.reason] || (result.stage === "open" ? "在微信里没找到这个人" : "没找到删除按钮，已停下")}`;

export function UnreachableCleanup({ onClose }: { onClose: () => void }) {
  const api = window.xiaoxiWorkflow;
  const [list, setList] = useState<UnreachableList | null>(null);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [alsoWechat, setAlsoWechat] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => { void api?.unreachableList?.().then(setList).catch((error: Error) => setNotice(error.message)); }, [api]);
  // While WeChat deletes run, follow them; when they end, say how it went.
  useEffect(() => {
    if (!list?.wechatRunning) return;
    const timer = window.setInterval(() => {
      void api?.unreachableList?.().then((next) => {
        setList(next);
        const done = next?.wechatProgress;
        if (next && !next.wechatRunning && done) {
          setNotice([`微信里已删 ${done.deleted} 人`, done.failed ? `没删成 ${done.failed} 人` : "", done.unknown ? `结果不明 ${done.unknown} 人` : ""].filter(Boolean).join("，") + "。");
        }
      }).catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [api, list?.wechatRunning]);
  const pending = list?.entries.filter((entry) => !entry.removed) || [];
  const removed = list?.entries.filter((entry) => entry.removed) || [];
  const chosen = pending.filter((entry) => !unticked.has(id(entry)));
  const running = Boolean(list?.wechatRunning);
  const progress = list?.wechatProgress;
  const run = async (action: () => Promise<UnreachableList> | undefined, done: (result: UnreachableList) => string) => {
    setBusy(true); setNotice("");
    try {
      const result = await action();
      if (!result?.ok) throw new Error(result?.error || "没有完成，请重试");
      setList(result); setUnticked(new Set()); setNotice(done(result));
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  };
  const locked = busy || running;
  return <div className="cleanup-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="cleanup-panel" role="dialog" aria-modal="true" aria-labelledby="cleanup-title">
      <header><h2 id="cleanup-title"><UserX />清理无效好友</h2><button type="button" className="cleanup-close" aria-label="关闭" disabled={busy} onClick={onClose}><X /></button></header>
      {!list ? <p className="cleanup-empty">{notice || "正在读取…"}</p> : <>
        {running && progress && <div className="cleanup-progress" role="status">
          <span>正在微信里删除 {progress.done}/{progress.total}{progress.current ? `：${progress.current}` : ""}</span>
          <i style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
          <button type="button" disabled={list?.wechatStopping} onClick={() => void api?.stopUnreachableDelete?.().then((next) => next && setList(next))}>{list?.wechatStopping ? "删完这一个就停" : "停止"}</button>
        </div>}
        {pending.length ? <>
          <ul className="cleanup-list">{pending.map((entry) => <li key={id(entry)}><label>
            <input type="checkbox" checked={!unticked.has(id(entry))} disabled={locked} onChange={(event) => setUnticked((current) => {
              const next = new Set(current); if (event.target.checked) next.delete(id(entry)); else next.add(id(entry)); return next;
            })} />
            <span className="cleanup-name">{entry.name}</span><span className={`cleanup-kind is-${entry.kind}`}><Ban />{KIND[entry.kind]}</span>
          </label></li>)}</ul>
          <label className="cleanup-wechat"><input type="checkbox" checked={alsoWechat} disabled={locked} onChange={(event) => setAlsoWechat(event.target.checked)} />
            同时在微信里删除这些好友<small>删了就找不回来；删除时请不要动鼠标键盘</small></label>
          <button type="button" className="cleanup-primary" data-xiaoxi-workflow-save disabled={locked || !chosen.length}
            onClick={() => void run(() => api?.removeUnreachable?.(chosen.map(({ accountId, key }) => ({ accountId, key })), alsoWechat),
              (result) => `已从名单移除 ${result.removedNow || 0} 人${result.wechatStarted ? "，正在微信里逐个删除" : ""}${result.wechatSkipped ? `，${result.wechatSkipped} 人不在当前登录的微信号上，没有删` : ""}${alsoWechat && !result.wechatStarted && result.wechatReason && result.wechatReason !== "nothing_to_delete" ? `；微信里没有删：${STOPPED[result.wechatReason] || "暂时不能删"}` : ""}。`)}>
            从名单移除 {chosen.length} 人{alsoWechat ? "，并在微信里删除" : ""}</button>
        </> : <p className="cleanup-empty">没有需要清理的人。触达时发现被拉黑或删除，会出现在这里。</p>}
        {removed.length > 0 && <details className="cleanup-removed" open={running || removed.some((entry) => entry.wechatDelete && entry.wechatDelete.status !== "deleted")}>
          <summary>已移除 {removed.length} 人</summary><ul>{removed.map((entry) => <li key={id(entry)}>
            <span className="cleanup-name">{entry.name}</span>
            {entry.wechatDelete ? <span className={`cleanup-wechat-result is-${entry.wechatDelete.status}`}>{wechatText(entry.wechatDelete)}</span>
              : <span className={`cleanup-kind is-${entry.kind}`}>{KIND[entry.kind]}</span>}
            {entry.wechatDelete?.status !== "deleted" && <button type="button" data-xiaoxi-workflow-save disabled={locked} onClick={() => void run(() => api?.restoreUnreachable?.({ accountId: entry.accountId, key: entry.key }), (result) => result.restored ? `${entry.name} 已放回名单。` : `${entry.name} 没能放回名单，请重新同步联系人。`)}><RotateCcw />恢复</button>}
          </li>)}</ul></details>}
        {notice && <p className="cleanup-notice" role="status">{notice}</p>}
      </>}
    </section>
  </div>;
}
