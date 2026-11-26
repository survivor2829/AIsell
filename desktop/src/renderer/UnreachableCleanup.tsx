import { useEffect, useState } from "react";
import { Ban, ChevronDown, RotateCcw, UserX, X } from "lucide-react";
import "./UnreachableCleanup.css";

// Contacts a touch found blocked (消息被拒收) or deleted (需要朋友验证). The customer confirms who leaves the
// contact list (user 2026-11-25: touch only real friends); a friend-verification notice can be wrong, so each
// person can be unticked, and a removed one can be put back. Ticked 同时在微信里删除, they are also deleted from
// the WeChat friend list, one by one, with each result shown.
type WechatDelete = { status: "deleted" | "failed" | "unknown"; stage: string; reason: string };
export type UnreachableEntry = { accountId: string; key: string; name: string; kind: "blocked" | "deleted"; at: string; removed: boolean; removedAt: string; wechatDelete?: WechatDelete };
export type UnreachableList = { ok: boolean; entries: UnreachableEntry[]; pending: number; removed: number; removedNow?: number; restored?: boolean; error?: string;
  wechatRunning?: boolean; wechatStopping?: boolean; wechatStarted?: boolean; wechatReason?: string; wechatSkipped?: number; wechatProgress?: { done: number; total: number; deleted: number; failed: number; unknown: number; current: string; halted?: string } };

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
  profile_wechat_id_mismatch: "资料卡上的微信号跟名单里的不一样，可能不是同一个人，为免删错没有删",
  profile_wechat_id_unreadable: "有同名好友，资料卡上的微信号又读不出来，为免删错没有删",
  search_results_not_loaded: "微信搜索结果一直没出来，请稍后再删一次",
  search_box_not_focused: "没能点进微信的搜索框，请稍后再删一次",
  search_input_failed: "没能在微信搜索框里输入，已停下",
  confirm_dialog_not_shown: "删除确认框没出来，请稍后再删一次",
  search_result_not_found: "在微信里按微信号和名字都没搜到这个人",
  search_result_ambiguous: "微信里搜到好几个同名的人，为免删错没有删",
  chat_not_opened: "点开搜索结果后没进到这个人的聊天，已停下",
  search_box_not_found: "没找到微信的搜索框，已停下",
  wechat_main_window_not_found: "没找到微信聊天主窗口，整轮已停下",
  wechat_window_not_ready: "微信窗口还没准备好，整轮已停下",
  confirm_text_mismatch: "确认框上的名字对不上，已停下"
};
const wechatText = (result: WechatDelete) => result.status === "deleted" ? "微信里已删"
  : result.status === "unknown" ? "微信里结果不明，请到微信看一眼"
  : `微信里没删成：${STOPPED[result.reason] || (result.stage === "open" ? "在微信里没找到这个人" : "没找到删除按钮，已停下")}`;
// People removed from the list whose WeChat delete stopped before 删除 and may work on another try.
// (A friend of another WeChat account is left for when that account is logged in, not counted here.)
const PERMANENT = new Set(["contact_name_not_unique", "delete_name_missing", "contact_not_saved", "wechat_version_unsupported", "wechat_account_mismatch"]);
const retryable = (entry: UnreachableEntry) => entry.removed && entry.wechatDelete?.status === "failed" && !PERMANENT.has(entry.wechatDelete.reason);
// What the touch page entry counts: people to clear plus people to try deleting in WeChat again.
export const cleanupCount = (list: UnreachableList | null | undefined) => (list?.entries || []).filter((entry) => !entry.removed || retryable(entry)).length;

// One click clears everyone found (user 2026-11-25: "直接一键清理", no scrolling through names first); the names
// are folded away for whoever wants to untick someone. Deleting runs in the background; 小玺 and the space bar stop it.
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
          // WeChat itself could not be read: the run stopped at once instead of skipping everyone (2026-11-26).
          setNotice(done.halted ? `微信里没能删：${STOPPED[done.halted] || "微信界面读不到"}。请打开微信聊天主界面后点“再删一次”。`
            : [`微信里已删 ${done.deleted} 人`, done.failed ? `没删成 ${done.failed} 人` : "", done.unknown ? `结果不明 ${done.unknown} 人` : ""].filter(Boolean).join("，") + "。");
        }
      }).catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [api, list?.wechatRunning]);
  const pending = list?.entries.filter((entry) => !entry.removed) || [];
  const removed = list?.entries.filter((entry) => entry.removed) || [];
  const again = removed.filter(retryable);
  // Pressed 删除 but could not read it back: the customer has to look in WeChat (never retried), so it stays in sight.
  const unknown = removed.filter((entry) => entry.wechatDelete?.status === "unknown");
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
  // What happened to the WeChat side of a click, as short sentences.
  const wechatNotice = (result: UnreachableList) => [
    result.wechatStarted ? "正在微信里逐个删除，请别动鼠标键盘" : "",
    result.wechatSkipped ? `${result.wechatSkipped} 人不在当前登录的微信号上，没有删` : "",
    !result.wechatStarted && result.wechatReason && result.wechatReason !== "nothing_to_delete" ? `微信里没有删：${STOPPED[result.wechatReason] || "暂时不能删"}` : ""
  ].filter(Boolean);
  const clear = () => void run(() => api?.removeUnreachable?.(chosen.map(({ accountId, key }) => ({ accountId, key })), alsoWechat),
    (result) => [`已清理 ${result.removedNow || 0} 人`, ...(alsoWechat ? wechatNotice(result) : [])].join("；") + "。");
  const retry = () => void run(() => api?.removeUnreachable?.(again.map(({ accountId, key }) => ({ accountId, key })), true),
    (result) => (wechatNotice(result).join("；") || "没有可以再删的人") + "。");
  const locked = busy || running;
  const blocked = pending.filter((entry) => entry.kind === "blocked").length;
  return <div className="cleanup-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="cleanup-panel" role="dialog" aria-modal="true" aria-labelledby="cleanup-title">
      <header><h2 id="cleanup-title"><UserX />清理无效好友</h2><button type="button" className="cleanup-close" aria-label="关闭" disabled={busy} onClick={onClose}><X /></button></header>
      {!list ? <p className="cleanup-empty">{notice || "正在读取…"}</p> : <>
        {running && progress ? <div className="cleanup-progress" role="status">
          <div><strong>正在微信里删除 {progress.done}/{progress.total}</strong><span>{progress.current ? `当前：${progress.current}` : "准备中"}</span></div>
          <button type="button" disabled={list.wechatStopping} onClick={() => void api?.stopUnreachableDelete?.().then((next) => next && setList(next))}>{list.wechatStopping ? "删完这一个就停" : "停止"}</button>
          <i style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
        </div> : pending.length ? <div className="cleanup-hero">
          <p><b>{pending.length}</b>人<span>{[blocked ? `${blocked} 人拉黑了你` : "", pending.length - blocked ? `${pending.length - blocked} 人删除了你` : ""].filter(Boolean).join(" · ")}</span></p>
          <button type="button" className="cleanup-primary" data-xiaoxi-workflow-save disabled={locked || !chosen.length} onClick={clear}>
            一键清理{chosen.length !== pending.length ? ` ${chosen.length} 人` : ""}</button>
          <label className="cleanup-wechat"><input type="checkbox" checked={alsoWechat} disabled={locked} onChange={(event) => setAlsoWechat(event.target.checked)} />
            同时在微信里删除<small>删了找不回来</small></label>
        </div> : again.length ? <div className="cleanup-hero">
          <p><b>{again.length}</b>人<span>微信里还没删掉</span></p>
          <button type="button" className="cleanup-primary" data-xiaoxi-workflow-save disabled={locked} onClick={retry}>再删一次</button>
        </div> : unknown.length ? <p className="cleanup-unknown">{unknown.length} 人点了删除但没能确认结果，请到微信里看一眼（展开下面的名单）。</p>
        : <p className="cleanup-empty">没有需要清理的人。触达时发现被拉黑或删除，会出现在这里。</p>}
        {notice && <p className="cleanup-notice" role="status">{notice}</p>}
        {pending.length > 0 && !running && <details className="cleanup-fold">
          <summary><ChevronDown />看名单{unticked.size ? `（已取消 ${unticked.size} 人）` : ""}</summary>
          <ul className="cleanup-list">{pending.map((entry) => <li key={id(entry)}><label>
            <input type="checkbox" checked={!unticked.has(id(entry))} disabled={locked} onChange={(event) => setUnticked((current) => {
              const next = new Set(current); if (event.target.checked) next.delete(id(entry)); else next.add(id(entry)); return next;
            })} />
            <span className="cleanup-name">{entry.name}</span><span className={`cleanup-kind is-${entry.kind}`}><Ban />{KIND[entry.kind]}</span>
          </label></li>)}</ul>
        </details>}
        {removed.length > 0 && <details className="cleanup-fold cleanup-removed" open={running || unknown.length > 0}>
          <summary><ChevronDown />已清理 {removed.length} 人{again.length && pending.length ? `（${again.length} 人微信里还没删掉）` : ""}</summary>
          {again.length > 0 && pending.length > 0 && <button type="button" className="cleanup-again" data-xiaoxi-workflow-save disabled={locked} onClick={retry}>再删一次没删掉的 {again.length} 人</button>}
          <ul>{removed.map((entry) => <li key={id(entry)}>
            <span className="cleanup-name">{entry.name}</span>
            {entry.wechatDelete ? <span className={`cleanup-wechat-result is-${entry.wechatDelete.status}`}>{wechatText(entry.wechatDelete)}</span>
              : <span className={`cleanup-kind is-${entry.kind}`}>{KIND[entry.kind]}</span>}
            {entry.wechatDelete?.status !== "deleted" && <button type="button" data-xiaoxi-workflow-save disabled={locked} onClick={() => void run(() => api?.restoreUnreachable?.({ accountId: entry.accountId, key: entry.key }), (result) => result.restored ? `${entry.name} 已放回名单。` : `${entry.name} 没能放回名单，请重新同步联系人。`)}><RotateCcw />恢复</button>}
          </li>)}</ul></details>}
      </>}
    </section>
  </div>;
}
