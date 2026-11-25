"use strict";
// Contacts a touch found unreachable: WeChat showed "被对方拒收" (they blocked the user) or a
// friend-verification notice (they deleted the user) under a message that was sent. Kept per
// WeChat account so later touch tasks skip them and the summary can name them (user decision
// 2026-11-17: count blocked and deleted apart; skip both from then on).
const fs = require("node:fs");
const path = require("node:path");

const FILE = "unreachable-contacts.json";
const KINDS = new Set(["blocked", "deleted"]);

function createUnreachableRegistry(directory) {
  const file = path.join(String(directory || ""), FILE);
  const read = () => {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      return value && value.version === 1 && value.accounts && typeof value.accounts === "object" ? value : { version: 1, accounts: {} };
    } catch { return { version: 1, accounts: {} }; }
  };
  const write = (value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
    fs.renameSync(temporary, file);
  };
  const key = (contact) => String(contact?.wxid || contact?.id || "").trim();
  const account = (contact) => String(contact?.wechatAccountId || "").trim();

  return {
    file,
    // "blocked", "deleted" or "" for this contact of its own WeChat account.
    kindOf(contact) {
      const entry = read().accounts[account(contact)]?.[key(contact)];
      return entry && KINDS.has(entry.kind) ? entry.kind : "";
    },
    record(contact, kind, at = new Date().toISOString()) {
      if (!KINDS.has(kind) || !account(contact) || !key(contact)) return false;
      const value = read();
      value.accounts[account(contact)] = value.accounts[account(contact)] || {};
      value.accounts[account(contact)][key(contact)] = { kind, at, name: String(contact?.remark || contact?.name || "").slice(0, 100) };
      write(value);
      return true;
    },
    // Lets a contact back in (the customer added them again).
    release(contact) {
      const value = read();
      const entries = value.accounts[account(contact)];
      if (!entries || !entries[key(contact)]) return false;
      delete entries[key(contact)];
      write(value);
      return true;
    },
    list(accountId) {
      return Object.entries(read().accounts[String(accountId || "")] || {})
        .filter(([, entry]) => KINDS.has(entry?.kind))
        .map(([contactKey, entry]) => ({ key: contactKey, ...entry }));
    },
    // Every account's entries, for the cleanup list (the page may show contacts of several WeChat accounts).
    listAll() {
      return Object.entries(read().accounts).flatMap(([accountId, entries]) => Object.entries(entries || {})
        .filter(([, entry]) => KINDS.has(entry?.kind))
        .map(([contactKey, entry]) => ({ accountId, key: contactKey, kind: entry.kind, at: entry.at, name: entry.name,
          removed: entry.removed === true, removedAt: entry.removedAt || "",
          ...(entry.wechatDelete ? { wechatDelete: { status: entry.wechatDelete.status, stage: entry.wechatDelete.stage, reason: entry.wechatDelete.reason } } : {}) })));
    },
    // The customer confirmed: take these out of the contact list (user 2026-11-25). The contact row is kept here
    // so it can be put back; a later sync leaves them out too (removedFrom).
    remove(accountId, keys, contactRows = [], at = new Date().toISOString()) {
      const value = read();
      const entries = value.accounts[String(accountId || "")];
      if (!entries) return [];
      const removed = [];
      for (const contactKey of new Set((keys || []).map(String))) {
        const entry = entries[contactKey];
        if (!entry || !KINDS.has(entry.kind) || entry.removed) continue;
        const row = contactRows.find((contact) => account(contact) === String(accountId) && key(contact) === contactKey);
        Object.assign(entry, { removed: true, removedAt: at, ...(row ? { contact: row } : {}) });
        removed.push(contactKey);
      }
      if (removed.length) write(value);
      return removed;
    },
    // Undo a removal: the contact comes back to the list (still skipped by touch until released).
    restore(accountId, contactKey) {
      const value = read();
      const entry = value.accounts[String(accountId || "")]?.[String(contactKey)];
      if (!entry?.removed) return null;
      const row = entry.contact || null;
      delete entry.removed; delete entry.removedAt; delete entry.contact;
      write(value);
      return row;
    },
    // The saved contact row of a removed entry (what the WeChat delete needs to find the person).
    removedContact(accountId, contactKey) {
      const entry = read().accounts[String(accountId || "")]?.[String(contactKey)];
      return entry?.removed && entry.contact ? { ...entry.contact } : null;
    },
    // How deleting the friend in WeChat went: "deleted", "unknown" (pressed 删除 but could not read it back;
    // never retried) or "failed" (stopped before 删除, with the step and reason).
    recordWechatDelete(accountId, contactKey, result, at = new Date().toISOString()) {
      const value = read();
      const entry = value.accounts[String(accountId || "")]?.[String(contactKey)];
      if (!entry) return false;
      entry.wechatDelete = { status: result.status, stage: String(result.stage || ""), reason: String(result.reason || ""), at };
      write(value);
      return true;
    },
    isRemoved(contact) {
      return read().accounts[account(contact)]?.[key(contact)]?.removed === true;
    },
    // A contact list without the removed contacts.
    withoutRemoved(rows) {
      const accounts = read().accounts;
      return (Array.isArray(rows) ? rows : []).filter((contact) => accounts[account(contact)]?.[key(contact)]?.removed !== true);
    }
  };
}

module.exports = { createUnreachableRegistry, UNREACHABLE_FILE: FILE };
