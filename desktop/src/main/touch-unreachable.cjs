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
    }
  };
}

module.exports = { createUnreachableRegistry, UNREACHABLE_FILE: FILE };
