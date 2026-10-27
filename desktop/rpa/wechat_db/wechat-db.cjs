// Read-only access to the logged-in WeChat 4 databases, used as receipts: who wrote, what was
// sent, whether a Moments post exists. WeChat keeps writing, so every read decrypts a fresh copy
// in memory - main file plus its WAL - and never touches the original files.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { decompress } = require("fzstd");
const { openDatabase } = require("./sqlite-reader.cjs");

const PAGE_SIZE = 4096;
const SALT_SIZE = 16;
const RESERVE = 80;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "binary");
const DB_KEY_FILE = "wechat-db-key.bin";
const derivedKeys = new Map();
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// WeChat 4 stores longer message bodies zstd-compressed (WCDB_CT_* = 4); short ones as text.
function messageText(value) {
  if (typeof value === "string") return value;
  if (!Buffer.isBuffer(value)) return "";
  const raw = value.subarray(0, 4).equals(ZSTD_MAGIC) ? Buffer.from(decompress(value)) : value;
  return raw.toString("utf8");
}

// The master key saved by contact sync, encrypted for the current Windows user (DPAPI).
function loadMasterKey(contactSyncDir) {
  const file = path.join(String(contactSyncDir || ""), DB_KEY_FILE);
  if (!fs.existsSync(file)) return null;
  const script = "Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim(); "
    + "[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)))";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { input: fs.readFileSync(file).toString("base64"), encoding: "utf8", windowsHide: true, timeout: 15000 });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    const parsed = JSON.parse(Buffer.from(result.stdout.trim(), "base64").toString("utf8"));
    return /^[a-f0-9]{64}$/u.test(parsed.key) ? { key: parsed.key, account: String(parsed.account || "") } : null;
  } catch { return null; }
}

// SQLCipher 4: each database derives its page key from the master key and its own salt.
function pageKey(masterKeyHex, salt) {
  const id = `${masterKeyHex.slice(0, 8)}:${salt.toString("hex")}`;
  if (!derivedKeys.has(id)) derivedKeys.set(id, crypto.pbkdf2Sync(Buffer.from(masterKeyHex, "hex"), salt, 256000, 32, "sha512"));
  return derivedKeys.get(id);
}

function pageMatchesKey(page, key, salt, pageNumber) {
  const macKey = crypto.pbkdf2Sync(key, Buffer.from([...salt].map((byte) => byte ^ 0x3a)), 2, 32, "sha512");
  const start = pageNumber === 1 ? SALT_SIZE : 0;
  const number = Buffer.alloc(4); number.writeUInt32LE(pageNumber, 0);
  const actual = crypto.createHmac("sha512", macKey).update(page.subarray(start, PAGE_SIZE - RESERVE + 16)).update(number).digest();
  return crypto.timingSafeEqual(actual, page.subarray(PAGE_SIZE - 64, PAGE_SIZE));
}

function decryptPage(page, key, pageNumber) {
  const iv = page.subarray(PAGE_SIZE - RESERVE, PAGE_SIZE - RESERVE + 16);
  const encrypted = pageNumber === 1 ? page.subarray(SALT_SIZE, PAGE_SIZE - RESERVE) : page.subarray(0, PAGE_SIZE - RESERVE);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return pageNumber === 1 ? Buffer.concat([SQLITE_HEADER, plain, Buffer.alloc(RESERVE)]) : Buffer.concat([plain, Buffer.alloc(RESERVE)]);
}

// Decrypt the main file, then replay committed WAL frames (the newest data lives there).
function decryptDatabase(dbPath, masterKeyHex) {
  const input = fs.readFileSync(dbPath);
  if (input.length < PAGE_SIZE) return null;
  const salt = input.subarray(0, SALT_SIZE);
  const key = pageKey(masterKeyHex, salt);
  if (!pageMatchesKey(input.subarray(0, PAGE_SIZE), key, salt, 1)) return null;
  const pages = [];
  for (let index = 0; index * PAGE_SIZE < input.length; index += 1) {
    let page = input.subarray(index * PAGE_SIZE, (index + 1) * PAGE_SIZE);
    if (page.length < PAGE_SIZE) page = Buffer.concat([page, Buffer.alloc(PAGE_SIZE - page.length)]);
    pages[index] = decryptPage(page, key, index + 1);
  }
  const walPath = `${dbPath}-wal`;
  if (fs.existsSync(walPath)) {
    const wal = fs.readFileSync(walPath);
    if (wal.length >= 32 && wal.readUInt32BE(8) === PAGE_SIZE) {
      const salt1 = wal.readUInt32BE(16), salt2 = wal.readUInt32BE(20);
      const pending = new Map();
      let committedSize = 0;
      for (let offset = 32; offset + 24 + PAGE_SIZE <= wal.length; offset += 24 + PAGE_SIZE) {
        if (wal.readUInt32BE(offset + 8) !== salt1 || wal.readUInt32BE(offset + 12) !== salt2) break;
        const pageNumber = wal.readUInt32BE(offset);
        pending.set(pageNumber, wal.subarray(offset + 24, offset + 24 + PAGE_SIZE));
        const commit = wal.readUInt32BE(offset + 4);
        if (commit) {
          for (const [number, page] of pending) pages[number - 1] = decryptPage(page, key, number);
          pending.clear();
          committedSize = commit;
        }
      }
      if (committedSize) pages.length = committedSize;
    }
  }
  for (let index = 0; index < pages.length; index += 1) if (!pages[index]) pages[index] = Buffer.alloc(PAGE_SIZE);
  return openDatabase(Buffer.concat(pages));
}

// The key file only changes when contact sync captures a new key, so it is unwrapped once per change.
function cachedKeyLoader(contactSyncDir) {
  let stamp = null, cached = null;
  return () => {
    let mtime = 0;
    try { mtime = fs.statSync(path.join(String(contactSyncDir || ""), DB_KEY_FILE)).mtimeMs; } catch { return null; }
    if (mtime !== stamp) { cached = loadMasterKey(contactSyncDir); stamp = cached ? mtime : null; }
    return cached;
  };
}

function createWechatDb({ accountDir, contactSyncDir, loadKey = cachedKeyLoader(contactSyncDir) }) {
  const master = loadKey;
  const storage = () => path.join(String(accountDir || ""), "db_storage");
  const open = (relative) => {
    const key = master();
    const file = path.join(storage(), relative);
    if (!key || !fs.existsSync(file)) return null;
    try { return decryptDatabase(file, key.key); } catch { return null; }
  };
  const tableFor = (username) => "Msg_" + crypto.createHash("md5").update(String(username)).digest("hex");
  const messageShards = () => {
    try { return fs.readdirSync(path.join(storage(), "message")).filter((name) => /^message_\d+\.db$/u.test(name)); } catch { return []; }
  };
  // Any read problem (no key, WeChat mid-write, unknown layout) answers null: "unknown", so the
  // caller keeps its screen-based check instead of failing.
  const guarded = (query) => (...args) => { try { return query(...args); } catch { return null; } };
  function messagesWith(username, sinceSeconds = 0) {
    if (!master()) return null;
    const rows = [];
    for (const shard of messageShards()) {
      const db = open(path.join("message", shard));
      if (!db) continue;
      const table = tableFor(username);
      if (!db.tables().includes(table)) continue;
      const senders = [...db.rows("Name2Id")].map((row) => row.user_name);
      for (const row of db.rows(table)) {
        if (Number(row.create_time) < sinceSeconds) continue;
        rows.push({ createTime: Number(row.create_time), localType: row.local_type, status: row.status,
          sender: senders[Number(row.real_sender_id) - 1] || "", content: messageText(row.message_content) });
      }
    }
    return rows.sort((left, right) => left.createTime - right.createTime);
  }
  return {
    available: () => Boolean(master()),
    // Sessions with unread messages: { username, unread, lastTimestamp, summary }.
    unreadSessions: guarded(() => {
      const db = open(path.join("session", "session.db"));
      if (!db) return null;
      return [...db.rows("SessionTable")].filter((row) => Number(row.unread_count) > 0)
        .map((row) => ({ username: row.username, unread: Number(row.unread_count), lastTimestamp: Number(row.last_timestamp), summary: String(row.summary || "") }));
    }),
    messagesWith: guarded(messagesWith),
    // Text the logged-in account sent to this contact since a moment (seconds).
    sentTo: guarded((username, sinceSeconds, selfUsername) => messagesWith(username, sinceSeconds).filter((row) => row.sender === selfUsername)),
    // Moments posts by the logged-in account whose content contains the given text.
    myMoments: guarded((selfUsername, containing = "") => {
      const db = open(path.join("sns", "sns.db"));
      if (!db) return null;
      const needle = String(containing).replace(/\s+/gu, "");
      return [...db.rows("SnsTimeLine")].filter((row) => row.user_name === selfUsername
        && (!needle || String(row.content || "").replace(/\s+/gu, "").includes(needle)))
        .map((row) => ({ tid: String(row.tid), content: String(row.content || "") }));
    })
  };
}

module.exports = { createWechatDb, decryptDatabase, loadMasterKey, DB_KEY_FILE };
