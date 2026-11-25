"use strict";
// Clearing contacts a touch found blocked or deleted out of the contact list (user 2026-11-25: skipped people
// keep cluttering every touch; the list should hold real friends only). The customer confirms the list first,
// since a friend-verification notice can be wrong. Removed contacts stay out of later syncs and can be restored.
const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("./atomic-file.cjs");
const { createUnreachableRegistry } = require("./touch-unreachable.cjs");

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
        kind: entry.kind, at: entry.at, removed: entry.removed, removedAt: entry.removedAt }));
      return { ok: true, entries,
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
