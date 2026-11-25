import { useEffect, useState } from "react";
import { Ban, RotateCcw, UserX, X } from "lucide-react";
import "./UnreachableCleanup.css";

// Contacts a touch found blocked (消息被拒收) or deleted (需要朋友验证). The customer confirms who leaves the
// contact list (user 2026-11-25: touch only real friends); a friend-verification notice can be wrong, so each
// person can be unticked, and a removed one can be put back.
export type UnreachableEntry = { accountId: string; key: string; name: string; kind: "blocked" | "deleted"; at: string; removed: boolean; removedAt: string };
export type UnreachableList = { ok: boolean; entries: UnreachableEntry[]; pending: number; removed: number; removedNow?: number; restored?: boolean; error?: string };

const id = (entry: UnreachableEntry) => `${entry.accountId}\u0000${entry.key}`;
const KIND = { blocked: "拉黑了你", deleted: "删除了你" };

export function UnreachableCleanup({ onClose }: { onClose: () => void }) {
  const api = window.xiaoxiWorkflow;
  const [list, setList] = useState<UnreachableList | null>(null);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => { void api?.unreachableList?.().then(setList).catch((error: Error) => setNotice(error.message)); }, [api]);
  const pending = list?.entries.filter((entry) => !entry.removed) || [];
  const removed = list?.entries.filter((entry) => entry.removed) || [];
  const chosen = pending.filter((entry) => !unticked.has(id(entry)));
  const run = async (action: () => Promise<UnreachableList> | undefined, done: (result: UnreachableList) => string) => {
    setBusy(true); setNotice("");
    try {
      const result = await action();
      if (!result?.ok) throw new Error(result?.error || "没有完成，请重试");
      setList(result); setUnticked(new Set()); setNotice(done(result));
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="cleanup-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="cleanup-panel" role="dialog" aria-modal="true" aria-labelledby="cleanup-title">
      <header><h2 id="cleanup-title"><UserX />清理无效好友</h2><button type="button" className="cleanup-close" aria-label="关闭" disabled={busy} onClick={onClose}><X /></button></header>
      {!list ? <p className="cleanup-empty">{notice || "正在读取…"}</p> : <>
        {pending.length ? <>
          <ul className="cleanup-list">{pending.map((entry) => <li key={id(entry)}><label>
            <input type="checkbox" checked={!unticked.has(id(entry))} disabled={busy} onChange={(event) => setUnticked((current) => {
              const next = new Set(current); if (event.target.checked) next.delete(id(entry)); else next.add(id(entry)); return next;
            })} />
            <span className="cleanup-name">{entry.name}</span><span className={`cleanup-kind is-${entry.kind}`}><Ban />{KIND[entry.kind]}</span>
          </label></li>)}</ul>
          <button type="button" className="cleanup-primary" data-xiaoxi-workflow-save disabled={busy || !chosen.length}
            onClick={() => void run(() => api?.removeUnreachable?.(chosen.map(({ accountId, key }) => ({ accountId, key }))), (result) => `已从名单移除 ${result.removedNow || 0} 人，以后同步也不会再加回来。`)}>
            从名单移除 {chosen.length} 人</button>
        </> : <p className="cleanup-empty">没有需要清理的人。触达时发现被拉黑或删除，会出现在这里。</p>}
        {removed.length > 0 && <details className="cleanup-removed"><summary>已移除 {removed.length} 人</summary><ul>{removed.map((entry) => <li key={id(entry)}>
          <span className="cleanup-name">{entry.name}</span><span className={`cleanup-kind is-${entry.kind}`}>{KIND[entry.kind]}</span>
          <button type="button" data-xiaoxi-workflow-save disabled={busy} onClick={() => void run(() => api?.restoreUnreachable?.({ accountId: entry.accountId, key: entry.key }), () => `${entry.name} 已放回名单。`)}><RotateCcw />恢复</button>
        </li>)}</ul></details>}
        {notice && <p className="cleanup-notice" role="status">{notice}</p>}
      </>}
    </section>
  </div>;
}
