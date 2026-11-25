"use strict";
// Clearing contacts a touch found blocked or deleted out of the contact list (user 2026-11-25: skipped people
// keep cluttering every touch; the list should hold real friends only). The customer confirms the list first,
// since a friend-verification notice can be wrong. Removed contacts stay out of later syncs and can be restored.
const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { createUnreachableRegistry } = require("./touch-unreachable.cjs");

// One WeChat delete run per app; the panel polls the list while it runs.
const wechatRun = { running: false, progress: { done: 0, total: 0, deleted: 0, failed: 0, unknown: 0, current: "" } };
// What a delete step saw, without names or 微信号: window classes, the 微信号 check's shape, search result count.
const evidenceOf = (result) => ({
  ...(Array.isArray(result?.window_kind) ? { window_kind: result.window_kind } : {}),
  ...(Array.isArray(result?.menuItems) ? { menu_item_kind: result.menuItems } : {}),
  ...(result?.idCheck && typeof result.idCheck === "object" ? { id_check: result.idCheck } : {}),
  ...(Number.isFinite(result?.resultCount) ? { result_count: result.resultCount } : {})
});
// Tries per person when it stopped before 删除: one more only, for a step WeChat was not ready for (no search rows yet,
// confirm not shown yet, a panel still sliding in); a wrong path is fixed, not retried (user 2026-11-25: "错误的方法再重试
// 也不会成功"). Trying again cannot help with the reasons below.
const ATTEMPTS = 2;
const NO_RETRY = new Set(["contact_name_not_unique", "delete_name_missing", "contact_not_saved", "wechat_version_unsupported",
  "wechat_account_changed", "wechat_account_unverified", "wechat_account_mismatch", "stopped_by_user", "wechat_operation_busy",
  // Someone is using the computer: never take the mouse back from them; the person stays for 再删一次.
  "wechat_external_input_detected",
  // Same answer every time: WeChat shows no such person, or the person in front is not this one.
  "search_result_not_found", "search_input_failed", "search_box_not_found", "profile_wechat_id_mismatch", "profile_wechat_id_unreadable",
  "chat_member_mismatch", "chat_title_mismatch", "confirm_text_mismatch"]);

function createTouchCleanup(activeTouchDir) {
  const registry = createUnreachableRegistry(activeTouchDir);
  const contactsFile = path.join(activeTouchDir, "contacts.json");
  const readRows = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(contactsFile, "utf8"));
      return { raw, rows: Array.isArray(raw) ? raw : Array.isArray(raw?.contacts) ? raw.contacts : [] };
    } catch { return { raw: [], rows: [] }; }
  };
  const writeRows = (raw, rows) => writeJsonAtomic(contactsFile, Array.isArray(raw) ? rows : { ...raw, contacts: rows });

  return {
    list() {
      const entries = registry.listAll().map((entry) => ({ accountId: entry.accountId, key: entry.key, name: entry.name || "未命名联系人",
        kind: entry.kind, at: entry.at, removed: entry.removed, removedAt: entry.removedAt, ...(entry.wechatDelete ? { wechatDelete: entry.wechatDelete } : {}) }));
      return { ok: true, entries, wechatRunning: wechatRun.running, wechatStopping: wechatRun.running && wechatRun.stopRequested === true, wechatProgress: { ...wechatRun.progress },
        pending: entries.filter((entry) => !entry.removed).length, removed: entries.filter((entry) => entry.removed).length };
    },
    remove(entries) {
      const wanted = (Array.isArray(entries) ? entries : []).filter((entry) => entry && entry.accountId && entry.key);
      if (!wanted.length) throw new Error("请先勾选要移除的联系人");
      const { raw, rows } = readRows();
      const byAccount = new Map();
      for (const entry of wanted) byAccount.set(String(entry.accountId), [...(byAccount.get(String(entry.accountId)) || []), String(entry.key)]);
      let removed = 0;
      for (const [accountId, keys] of byAccount) removed += registry.remove(accountId, keys, rows).length;
      writeRows(raw, registry.withoutRemoved(rows));
      return { ...this.list(), removedNow: removed };
    },
    // Who of these can be deleted in WeChat now, decided before anything starts so the page tells the truth:
    // only removed contacts whose row was saved, of the account WeChat is logged in with.
    planWechatDelete(entries, { currentAccount = "" } = {}) {
      const wanted = [], skipped = [];
      for (const entry of Array.isArray(entries) ? entries : []) {
        const item = { accountId: String(entry?.accountId || ""), key: String(entry?.key || "") };
        if (!item.accountId || !item.key) continue;
        const contact = registry.removedContact(item.accountId, item.key);
        const reason = !contact ? "contact_not_saved" : currentAccount && item.accountId !== currentAccount ? "wechat_account_mismatch" : "";
        if (reason) { registry.recordWechatDelete(item.accountId, item.key, { status: "failed", stage: "plan", reason }); skipped.push({ ...item, reason }); }
        else wanted.push(item);
      }
      return { wanted, skipped };
    },
    stopWechatDelete() {
      if (wechatRun.running) wechatRun.stopRequested = true;
      return { ...this.list(), stopping: wechatRun.running };
    },
    // Delete the removed contacts in WeChat too, one at a time (user 2026-11-25). The run needs a live check of
    // the logged-in account, holds the WeChat lock so touch and replies wait, and can be stopped between people.
    // A friend with no usable 微信号 is deleted only when no other synced friend shows the same name. A result that
    // cannot be read back is "unknown" and is never retried.
    async deleteInWechat(wanted, { deleteContact, coordinator, currentAccount = "", verifyLiveAccount, onProgress = () => {}, onFailure = () => {},
      wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
      if (wechatRun.running) return { started: false, reason: "wechat_delete_running" };
      if (!Array.isArray(wanted) || !wanted.length) return { started: false, reason: "nothing_to_delete" };
      if (typeof deleteContact !== "function" || typeof verifyLiveAccount !== "function" || !currentAccount) return { started: false, reason: "wechat_delete_unavailable" };
      wechatRun.running = true;
      wechatRun.stopRequested = false;
      wechatRun.progress = { done: 0, total: wanted.length, deleted: 0, failed: 0, unknown: 0, current: "" };
      const finish = (entry, status, stage, reason) => {
        registry.recordWechatDelete(entry.accountId, entry.key, { status, stage, reason });
        wechatRun.progress.done += 1;
        wechatRun.progress[status === "deleted" ? "deleted" : status === "unknown" ? "unknown" : "failed"] += 1;
        onProgress({ ...wechatRun.progress });
      };
      let lock = null;
      try {
        const live = await Promise.resolve(verifyLiveAccount(currentAccount)).catch(() => null);
        if (!live || live.reason === "wechat_account_changed") {
          for (const entry of wanted) finish(entry, "failed", "account", live ? "wechat_account_changed" : "wechat_account_unverified");
          return { started: true, ...wechatRun.progress };
        }
        lock = coordinator?.acquire?.({ state: "touching", taskId: `contact-cleanup-${Date.now()}`, account: currentAccount, phase: "touch:delete-contact" });
        if (!lock?.ok) {
          for (const entry of wanted) finish(entry, "failed", "lock", String(lock?.error || "wechat_operation_busy"));
          return { started: true, ...wechatRun.progress };
        }
        const { rows } = readRows();
        const shown = (row) => String(row?.remark || row?.name || row?.nickname || "").trim();
        for (const entry of wanted) {
          if (wechatRun.stopRequested) { finish(entry, "failed", "stopped", "stopped_by_user"); continue; }
          const contact = registry.removedContact(entry.accountId, entry.key);
          wechatRun.progress.current = shown(contact);
          onProgress({ ...wechatRun.progress });
          if (!contact) { finish(entry, "failed", "input", "contact_not_saved"); continue; }
          const uniqueName = !rows.some((row) => shown(row) === shown(contact));
          // Stopped before 删除 because WeChat was not ready (a menu or panel still opening): one more try. A pressed 删除
          // without a clear answer is never retried, and neither is anything in NO_RETRY.
          let result;
          for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
            try { result = await deleteContact(contact, { confirm: true, uniqueName, stopped: () => wechatRun.stopRequested === true }); }
            catch (error) { result = { ok: false, outcomeUnknown: true, stage: "script", reason: String(error?.message || "delete_failed").slice(0, 120) }; }
            if (result?.deleted || result?.outcomeUnknown || NO_RETRY.has(String(result?.reason || "")) || wechatRun.stopRequested || attempt === ATTEMPTS) break;
            onFailure({ stage: String(result?.stage || ""), reason: String(result?.reason || ""), attempt, retrying: true, ...evidenceOf(result) });
            await wait(2500);
            // 停止 pressed while waiting: no further attempt.
            if (wechatRun.stopRequested) break;
          }
          const status = result?.deleted ? "deleted" : result?.outcomeUnknown ? "unknown" : "failed";
          // Deleted although the 微信号 on the card could not be confirmed (name unique): reported once per person so the
          // failure report shows how the card was read.
          if (status === "deleted" && result?.idCheck?.id_check_state === "degraded_unread") onFailure({ stage: "profile", reason: "contact_cleanup_id_check_degraded", status, degraded: true, ...evidenceOf(result) });
          if (status !== "deleted") onFailure({ stage: String(result?.stage || ""), reason: String(result?.reason || ""), status, retrying: false, ...evidenceOf(result) });
          finish(entry, status, result?.stage, result?.reason);
        }
        return { started: true, ...wechatRun.progress };
      } finally {
        if (lock?.ok) coordinator.release(lock.lock.owner);
        wechatRun.running = false;
        wechatRun.stopRequested = false;
        wechatRun.progress.current = "";
        onProgress({ ...wechatRun.progress, finished: true });
      }
    },
    restore(entry) {
      const accountId = String(entry?.accountId || ""), contactKey = String(entry?.key || "");
      const row = registry.restore(accountId, contactKey);
      if (row) {
        const { raw, rows } = readRows();
        const sameContact = (contact) => String(contact?.wechatAccountId || "") === accountId && String(contact?.wxid || contact?.id || "") === contactKey;
        if (!rows.some(sameContact)) writeRows(raw, [...rows, row]);
      }
      return { ...this.list(), restored: Boolean(row) };
    }
  };
}

module.exports = { createTouchCleanup };
