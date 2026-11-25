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
      return { ok: true, entries, wechatRunning: wechatRun.running, wechatProgress: { ...wechatRun.progress },
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
    // Delete the removed contacts in WeChat too, one at a time (user 2026-11-25). Only contacts of the account
    // WeChat is logged in with now; the run holds the WeChat lock so touch and replies wait; a result that cannot be
    // read back is "unknown" and is never retried.
    async deleteInWechat(entries, { deleteContact, coordinator, currentAccount = "", verifyLiveAccount, onProgress = () => {} } = {}) {
      if (wechatRun.running) return { started: false, reason: "wechat_delete_running" };
      const wanted = (Array.isArray(entries) ? entries : []).map((entry) => ({ accountId: String(entry?.accountId || ""), key: String(entry?.key || "") }))
        .filter((entry) => entry.accountId && entry.key && registry.removedContact(entry.accountId, entry.key));
      if (!wanted.length) return { started: false, reason: "nothing_to_delete" };
      if (typeof deleteContact !== "function") return { started: false, reason: "wechat_delete_unavailable" };
      wechatRun.running = true;
      wechatRun.progress = { done: 0, total: wanted.length, deleted: 0, failed: 0, unknown: 0, current: "" };
      const finish = (entry, status, stage, reason) => {
        registry.recordWechatDelete(entry.accountId, entry.key, { status, stage, reason });
        wechatRun.progress.done += 1;
        wechatRun.progress[status === "deleted" ? "deleted" : status === "unknown" ? "unknown" : "failed"] += 1;
        onProgress({ ...wechatRun.progress });
      };
      let lock = null;
      try {
        if (verifyLiveAccount && currentAccount) {
          const live = await Promise.resolve(verifyLiveAccount(currentAccount)).catch(() => null);
          if (live?.reason === "wechat_account_changed") {
            for (const entry of wanted) finish(entry, "failed", "account", "wechat_account_changed");
            return { started: true, ...wechatRun.progress };
          }
        }
        lock = coordinator?.acquire?.({ state: "touching", taskId: `contact-cleanup-${Date.now()}`, account: currentAccount, phase: "touch:delete-contact" });
        if (coordinator && !lock?.ok) {
          for (const entry of wanted) finish(entry, "failed", "lock", String(lock?.error || "wechat_operation_busy"));
          return { started: true, ...wechatRun.progress };
        }
        for (const entry of wanted) {
          const contact = registry.removedContact(entry.accountId, entry.key);
          wechatRun.progress.current = String(contact?.name || contact?.remark || "");
          onProgress({ ...wechatRun.progress });
          if (!contact) { finish(entry, "failed", "input", "contact_not_saved"); continue; }
          if (currentAccount && entry.accountId !== currentAccount) { finish(entry, "failed", "account", "wechat_account_mismatch"); continue; }
          let result;
          try { result = await deleteContact(contact, { confirm: true }); }
          catch (error) { result = { ok: false, stage: "script", reason: String(error?.message || "delete_failed").slice(0, 120) }; }
          finish(entry, result?.deleted ? "deleted" : result?.outcomeUnknown ? "unknown" : "failed", result?.stage, result?.reason);
        }
        return { started: true, ...wechatRun.progress };
      } finally {
        if (lock?.ok) coordinator.release(lock.lock.owner);
        wechatRun.running = false;
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
