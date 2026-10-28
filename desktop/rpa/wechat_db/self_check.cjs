// Offline checks for the WeChat database receipts: builds tiny SQLCipher 4 databases (with a WAL)
// in a temp folder, so decryption, WAL replay, overflow pages and the queries run without WeChat.
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWechatDb, decryptDatabase, loadMasterKey } = require("./wechat-db.cjs");
const { openDatabase } = require("./sqlite-reader.cjs");

const PAGE = 4096, RESERVE = 80, USABLE = PAGE - RESERVE;

function varint(value) {
  let number = BigInt(value);
  const bytes = [Number(number & 0x7fn)];
  number >>= 7n;
  while (number > 0n) { bytes.unshift(Number(number & 0x7fn) | 0x80); number >>= 7n; }
  return Buffer.from(bytes);
}

function record(values) {
  const types = [], bodies = [];
  for (const value of values) {
    if (value === null) { types.push(0); continue; }
    if (typeof value === "number") { const body = Buffer.alloc(4); body.writeInt32BE(value); types.push(4); bodies.push(body); continue; }
    if (Buffer.isBuffer(value)) { types.push(12 + value.length * 2); bodies.push(value); continue; }
    const body = Buffer.from(String(value), "utf8"); types.push(13 + body.length * 2); bodies.push(body);
  }
  const typeBytes = Buffer.concat(types.map(varint));
  let headerSize = typeBytes.length + 1;
  if (varint(headerSize).length > 1) headerSize += 1;
  return Buffer.concat([varint(headerSize), typeBytes, ...bodies]);
}

// Plain database with 80 reserved bytes per page (as SQLCipher stores them): one leaf page per
// table, long payloads spill into overflow pages.
function buildPlainDb(tables) {
  const pages = [null];
  const extra = [];
  const leaf = (rows, pageNumber) => {
    const page = Buffer.alloc(PAGE);
    const base = pageNumber === 1 ? 100 : 0;
    let top = USABLE;
    const pointers = [];
    rows.forEach((values, index) => {
      const payload = record(values);
      const maxLocal = USABLE - 35;
      let local = payload, overflow = null;
      if (payload.length > maxLocal) {
        const minLocal = Math.floor(((USABLE - 12) * 32) / 255) - 23;
        let size = minLocal + ((payload.length - minLocal) % (USABLE - 4));
        if (size > maxLocal) size = minLocal;
        local = payload.subarray(0, size);
        overflow = payload.subarray(size);
      }
      let tail = Buffer.alloc(0);
      if (overflow) {
        let first = 0, previous = null;
        for (let offset = 0; offset < overflow.length; offset += USABLE - 4) {
          const spill = Buffer.alloc(PAGE);
          overflow.copy(spill, 4, offset, Math.min(overflow.length, offset + USABLE - 4));
          extra.push(spill);
          const number = tables.length + 1 + extra.length;
          if (previous) previous.writeUInt32BE(number, 0); else first = number;
          previous = spill;
        }
        tail = Buffer.alloc(4); tail.writeUInt32BE(first);
      }
      const cell = Buffer.concat([varint(payload.length), varint(index + 1), local, tail]);
      top -= cell.length;
      cell.copy(page, top);
      pointers.push(top);
    });
    page[base] = 0x0d;
    page.writeUInt16BE(rows.length, base + 3);
    page.writeUInt16BE(top, base + 5);
    pointers.forEach((pointer, index) => page.writeUInt16BE(pointer, base + 8 + index * 2));
    return page;
  };
  tables.forEach((table, index) => { pages.push(leaf(table.rows, index + 2)); });
  const master = leaf(tables.map((table, index) => ["table", table.name, table.name, index + 2, table.sql]), 1);
  Buffer.from("SQLite format 3\0", "binary").copy(master, 0);
  master.writeUInt16BE(PAGE, 16);
  master[18] = 1; master[19] = 1; master[20] = RESERVE; master[21] = 64; master[22] = 32; master[23] = 12;
  master.writeUInt32BE(1 + tables.length + extra.length, 28);
  master.writeUInt32BE(4, 44);
  master.writeUInt32BE(1, 56);
  pages[0] = master;
  return [...pages, ...extra];
}

function encryptPages(pages, masterHex, salt) {
  const key = crypto.pbkdf2Sync(Buffer.from(masterHex, "hex"), salt, 256000, 32, "sha512");
  const macKey = crypto.pbkdf2Sync(key, Buffer.from([...salt].map((byte) => byte ^ 0x3a)), 2, 32, "sha512");
  const encryptPage = (plain, number) => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    cipher.setAutoPadding(false);
    const body = Buffer.concat([cipher.update(plain.subarray(number === 1 ? 16 : 0, USABLE)), cipher.final()]);
    const pageNumber = Buffer.alloc(4); pageNumber.writeUInt32LE(number);
    const mac = crypto.createHmac("sha512", macKey).update(body).update(iv).update(pageNumber).digest();
    return Buffer.concat([number === 1 ? salt : Buffer.alloc(0), body, iv, mac]);
  };
  return { file: Buffer.concat(pages.map((page, index) => encryptPage(page, index + 1))), encryptPage };
}

function wal(salt1, salt2, frames) {
  const header = Buffer.alloc(32);
  header.writeUInt32BE(0x377f0682, 0); header.writeUInt32BE(3007000, 4); header.writeUInt32BE(PAGE, 8);
  header.writeUInt32BE(1, 12); header.writeUInt32BE(salt1, 16); header.writeUInt32BE(salt2, 20);
  return Buffer.concat([header, ...frames.map(({ pageNumber, commit, salts, page }) => {
    const frame = Buffer.alloc(24);
    frame.writeUInt32BE(pageNumber, 0); frame.writeUInt32BE(commit, 4);
    frame.writeUInt32BE(salts[0], 8); frame.writeUInt32BE(salts[1], 12);
    return Buffer.concat([frame, page]);
  })]);
}

const self = "wxid_self_owner", friend = "wxid_friend_a";
const messageTable = "Msg_" + crypto.createHash("md5").update(friend).digest("hex");
const messageSql = `CREATE TABLE ${messageTable}(local_id INTEGER PRIMARY KEY AUTOINCREMENT, local_type INTEGER, real_sender_id INTEGER, create_time INTEGER, status INTEGER, message_content TEXT)`;
const nameSql = "CREATE TABLE Name2Id(user_name TEXT, is_session INTEGER)";
const longText = "长".repeat(3000);
const messageTables = (rows) => [
  { name: messageTable, sql: messageSql, rows },
  { name: "Name2Id", sql: nameSql, rows: [[friend, 1], [self, 0]] }
];
// "压缩过的回复：好的，明天发货" as WeChat stores it: a zstd frame in a BLOB.
const compressed = Buffer.from("28b52ffd202a510100e58e8be7bca9e8bf87e79a84e59b9ee5a48defbc9ae5a5bde79a84efbc8ce6988ee5a4a9e58f91e8b4a7", "hex");
const baseRows = [
  [null, 1, 1, 1000, 3, "你好，在吗"],
  [null, 1, 2, 2000, 2, longText],
  [null, 1, 2, 2200, 2, compressed]
];

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-wechat-db-"));
try {
  const masterHex = crypto.randomBytes(32).toString("hex");
  const salt = crypto.randomBytes(16);
  const accountDir = path.join(root, "account");
  const storage = path.join(accountDir, "db_storage");
  fs.mkdirSync(path.join(storage, "message"), { recursive: true });
  fs.mkdirSync(path.join(storage, "session"), { recursive: true });

  // The reader itself: overflow payloads, rowid for INTEGER PRIMARY KEY, schema column names.
  const plain = openDatabase(Buffer.concat(buildPlainDb(messageTables(baseRows))));
  const plainRows = [...plain.rows(messageTable)];
  assert.deepEqual(plainRows.map((row) => row.local_id), [1, 2, 3]);
  assert.equal(plainRows[1].message_content, longText, "overflow pages are followed");
  assert.deepEqual(plain.tables(), [messageTable, "Name2Id"]);

  const { file, encryptPage } = encryptPages(buildPlainDb(messageTables(baseRows)), masterHex, salt);
  const messageDb = path.join(storage, "message", "message_0.db");
  fs.writeFileSync(messageDb, file);
  assert.equal(decryptDatabase(messageDb, crypto.randomBytes(32).toString("hex")), null, "a wrong key is rejected, not misread");
  assert.equal([...decryptDatabase(messageDb, masterHex).rows(messageTable)].length, 3);

  // WAL: a committed frame is replayed; a later uncommitted frame and stale frames left over
  // from before the last checkpoint (older salts) are ignored.
  const newRows = [...baseRows, [null, 1, 2, 3000, 2, "今天的新消息"]];
  const pendingRows = [...newRows, [null, 1, 2, 4000, 2, "还没提交"]];
  const leafOf = (rows) => encryptPage(buildPlainDb(messageTables(rows))[1], 2);
  const pageCount = buildPlainDb(messageTables(baseRows)).length;
  fs.writeFileSync(`${messageDb}-wal`, wal(101, 7, [
    { pageNumber: 2, commit: pageCount, salts: [101, 7], page: leafOf(newRows) },
    { pageNumber: 2, commit: 0, salts: [101, 7], page: leafOf(pendingRows) },
    { pageNumber: 2, commit: pageCount, salts: [100, 9], page: leafOf(pendingRows) }
  ]));
  const db = createWechatDb({ accountDir, contactSyncDir: root, loadKey: () => ({ key: masterHex, account: self }) });
  assert.equal(db.available(), true);
  const all = db.messagesWith(friend);
  assert.deepEqual(all.map((row) => row.content), ["你好，在吗", longText, "压缩过的回复：好的，明天发货", "今天的新消息"]);
  assert.deepEqual(all.map((row) => row.sender), [friend, self, self, self], "real_sender_id maps through Name2Id");
  assert.deepEqual(db.sentTo(friend, 2500).map((row) => row.content), ["今天的新消息"]);
  assert.equal(db.confirmSent(friend, 2500, { text: " 今天的 新消息" }), true, "whitespace differences still match");
  assert.equal(db.confirmSent(friend, 2500, { text: "你好，在吗" }), false, "the contact's own words are not our receipt");
  assert.equal(db.confirmSent(friend, 2500, { kind: "image" }), false);
  assert.equal(db.confirmSent(friend, 2100, { text: "压缩过的回复：好的，明天发货" }), true);
  assert.deepEqual(db.messagesWith("wxid_nobody"), []);

  // A damaged copy (WeChat mid-write) answers "unknown" instead of throwing into the workflow.
  fs.writeFileSync(`${messageDb}-wal`, wal(101, 7, [{ pageNumber: 2, commit: pageCount, salts: [101, 7], page: encryptPage(Buffer.alloc(PAGE, 0x0d), 2) }]));
  assert.equal(db.messagesWith(friend), null);

  // Right after a checkpoint the WAL header moves to new salts and every old frame is void.
  fs.writeFileSync(`${messageDb}-wal`, wal(102, 1, [{ pageNumber: 2, commit: pageCount, salts: [101, 7], page: leafOf(pendingRows) }]));
  assert.deepEqual(db.messagesWith(friend).map((row) => row.createTime), [1000, 2000, 2200]);

  const sessionSql = "CREATE TABLE SessionTable(username TEXT, unread_count INTEGER, last_timestamp INTEGER, summary TEXT)";
  const sessionPages = buildPlainDb([{ name: "SessionTable", sql: sessionSql, rows: [[friend, 2, 3000, "今天的新消息"], ["filehelper", 0, 2500, "x"]] }]);
  fs.writeFileSync(path.join(storage, "session", "session.db"), encryptPages(sessionPages, masterHex, crypto.randomBytes(16)).file);
  assert.deepEqual(db.unreadSessions(), [{ username: friend, unread: 2, lastTimestamp: 3000, summary: "今天的新消息" }]);
  assert.deepEqual(db.recentSessions(2600).map((row) => row.username), [friend], "only chats active since then");

  // Moments: only our own posts since the attempt began count, matched on the start of the copy.
  fs.mkdirSync(path.join(storage, "sns"), { recursive: true });
  const post = (user, time, text) => [1, user, `<TimelineObject><username>${user}</username><createTime>${time}</createTime><contentDesc>${text}</contentDesc></TimelineObject>`];
  const snsPages = buildPlainDb([{ name: "SnsTimeLine", sql: "CREATE TABLE SnsTimeLine(tid INTEGER, user_name TEXT, content TEXT)", rows: [
    post(self, 5000, "新到一批普渡 CC1 Pro &amp; 配件，扫洗吸一次完成"), post(friend, 6000, "别人的帖子 新品上市"), post(self, 100, "旧帖子 新品上市")
  ] }]);
  fs.writeFileSync(path.join(storage, "sns", "sns.db"), encryptPages(snsPages, masterHex, crypto.randomBytes(16)).file);
  const snsDb = createWechatDb({ accountDir: path.join(root, `${self}_3dd4`), contactSyncDir: root, loadKey: () => ({ key: masterHex, account: self }) });
  fs.cpSync(storage, path.join(root, `${self}_3dd4`, "db_storage"), { recursive: true });
  assert.equal(require("./wechat-db.cjs").selfUsernameOf(`D:/wx/${self}_3dd4`), self);
  assert.deepEqual(snsDb.myMoments(1000).map((item) => item.text), ["新到一批普渡 CC1 Pro & 配件，扫洗吸一次完成"]);
  assert.equal(snsDb.postedMoment("新到一批普渡CC1 Pro & 配件，扫洗吸一次完成", 4000), true, "spacing and escaping do not matter");
  assert.equal(snsDb.postedMoment("新到一批普渡 CC1 Pro & 配件", 5001), false, "a post from before this attempt is not ours");
  assert.equal(snsDb.postedMoment("别人的帖子 新品上市", 0), false, "someone else's post is not a receipt");
  assert.equal(snsDb.postedMoment("", 0), null);

  // Without a key every query reports "unknown" so callers fall back to the screen checks.
  const keyless = createWechatDb({ accountDir, contactSyncDir: root, loadKey: () => null });
  assert.equal(keyless.available(), false);
  assert.equal(keyless.unreadSessions(), null);
  assert.equal(keyless.messagesWith(friend), null, "no key means unknown, never \"nothing was sent\"");
  assert.equal(keyless.sentTo(friend, 0), null);
  assert.equal(keyless.confirmSent(friend, 0, { text: "今天的新消息" }), null);
  assert.equal(loadMasterKey(path.join(root, "missing")), null);

  // The synced account decides which folder is read; no synced account means no receipts.
  const { receiptsForDataRoot } = require("./wechat-db.cjs");
  assert.equal(receiptsForDataRoot(path.join(root, "nothing-synced")), null);
  fs.mkdirSync(path.join(root, "data", "contact_sync"), { recursive: true });
  for (const account_name of ["../escape", "..\\escape", ".."]) {
    fs.writeFileSync(path.join(root, "data", "contact_sync", "state.json"), JSON.stringify({ wechat_root: root, account_name }));
    assert.equal(receiptsForDataRoot(path.join(root, "data")), null, "the account name never walks out of the WeChat folder");
  }
  fs.writeFileSync(path.join(root, "data", "contact_sync", "state.json"), JSON.stringify({ wechat_root: root, account_name: "account" }));
  assert.equal(typeof receiptsForDataRoot(path.join(root, "data")).confirmSent, "function");

  // DPAPI round trip with the saver used by contact sync (Windows only).
  if (process.platform === "win32") {
    const { saveDbKey } = require("../contact_sync/contact_sync_cli.cjs");
    assert.equal(saveDbKey(root, self, masterHex.toUpperCase()), true);
    assert.equal(fs.readFileSync(path.join(root, "wechat-db-key.bin")).includes(Buffer.from(masterHex)), false, "the key is not stored in plain text");
    assert.deepEqual(loadMasterKey(root), { key: masterHex, account: self });
  }
  console.log("wechat_db self-check passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
