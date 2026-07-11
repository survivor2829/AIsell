const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { capture, decryptSqlcipher4Raw, prepareWechatLogin, resolveHelper, status, sync } = require("./contact_sync_cli.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-contact-sync-"));
const syncDir = path.join(root, "contact_sync");
const activeTouchDir = path.join(root, "active_touch");
const wechatRoot = path.join(root, "WeChat");
const accountDir = path.join(wechatRoot, "account-a");
const xwechatRoot = path.join(root, "xwechat_files");
const xwechatAccountDir = path.join(xwechatRoot, "wxid_latest_abcd");
const helperPath = path.join(root, "fake_helper.cjs");
const keyToolPath = path.join(root, "fake_key_tool.cjs");
const dumpToolPath = path.join(root, "fake_dump_tool.cjs");

function encryptSqlcipher4Like(inputPath, outputPath, keyHex) {
  const pageSize = 4096;
  const reserveSize = 80;
  const salt = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex");
  const key = Buffer.from(keyHex, "hex");
  const macSalt = Buffer.from([...salt].map((byte) => byte ^ 0x3a));
  const macKey = crypto.pbkdf2Sync(key, macSalt, 2, 32, "sha512");
  const input = fs.readFileSync(inputPath);
  const pages = Math.ceil(input.length / pageSize);
  const output = [];

  for (let index = 0; index < pages; index += 1) {
    let page = input.subarray(index * pageSize, Math.min((index + 1) * pageSize, input.length));
    if (page.length < pageSize) page = Buffer.concat([page, Buffer.alloc(pageSize - page.length)]);
    const iv = crypto.randomBytes(16);
    const plain = index === 0 ? page.subarray(16, pageSize - reserveSize) : page.subarray(0, pageSize - reserveSize);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const body = index === 0 ? Buffer.concat([salt, encrypted, iv]) : Buffer.concat([encrypted, iv]);
    const hmacBody = index === 0 ? Buffer.concat([encrypted, iv]) : body;
    const pageNo = Buffer.alloc(4);
    pageNo.writeUInt32LE(index + 1, 0);
    const digest = crypto.createHmac("sha512", macKey).update(hmacBody).update(pageNo).digest();
    output.push(Buffer.concat([body, digest]));
  }

  fs.writeFileSync(outputPath, Buffer.concat(output));
}

try {
  assert.deepEqual(prepareWechatLogin({ loginFlowDriver: () => ({ ok: true, restarted: true }) }), { ok: true, restarted: true });
  assert.deepEqual(prepareWechatLogin({ loginFlowDriver: () => ({ ok: false, reason: "wechat_start_failed" }) }), {
    ok: false,
    reason: "wechat_start_failed"
  });

  assert.equal(sync(syncDir, { wechatRoot: path.join(root, "missing"), activeTouchDir }).blocked_reason, "wechat_root_not_found");

  fs.mkdirSync(accountDir, { recursive: true });
  fs.writeFileSync(path.join(accountDir, "contact.db"), "encrypted", "utf8");
  assert.equal(sync(syncDir, { wechatRoot, activeTouchDir }).blocked_reason, "key_info_not_found");

  fs.writeFileSync(path.join(accountDir, "key_info.db"), "key-window", "utf8");
  assert.equal(
    sync(syncDir, {
      wechatRoot,
      activeTouchDir,
      helperPath: path.join(root, "missing-helper.exe")
    }).blocked_reason,
    "decrypt_helper_missing"
  );

  fs.writeFileSync(helperPath, "process.stderr.write('SECRET_KEY'); process.exit(2);", "utf8");
  const failed = sync(syncDir, { wechatRoot, activeTouchDir, helperPath });
  assert.equal(failed.blocked_reason, "decrypt_failed");
  assert.equal(JSON.stringify(failed).includes("SECRET_KEY"), false);

fs.writeFileSync(
    helperPath,
    `
const fs = require("node:fs");
const out = process.argv[process.argv.indexOf("--out") + 1];
fs.writeFileSync(out, JSON.stringify([
  { username: "wxid_1", remark: "王总", nick_name: "老王", local_type: 1 },
  { username: "room_1", remark: "物业群", local_type: 4 },
  { username: "gh_1", nick_name: "公众号", local_type: 1, verify_flag: 8 },
  { username: "openim_1", nick_name: "企业微信联系人", local_type: 1 },
  { username: "wxid_cache", nick_name: "缓存客户", local_type: 0 },
  { username: "wxid_history", nick_name: "历史缓存", local_type: 3 },
  { username: "wxid_2", alias: "li-manager", nick_name: "李经理", local_type: 1 }
]), "utf8");
`,
    "utf8"
  );
  const ok = sync(syncDir, { wechatRoot, activeTouchDir, helperPath });
  assert.equal(ok.ok, true);
  assert.equal(ok.contacts.length, 2);
  assert.equal(ok.contacts[0].name, "王总");
  assert.equal(ok.contacts[0].nickname, "老王");
  assert.equal(ok.contacts[0].wxid, "wxid_1");
  assert.equal(ok.contacts[0].wechatId, "");
  assert.equal(ok.contacts[0].source, "wechat-silent-sync");
  assert.equal(ok.contacts[1].id, "wxid_2");
  assert.equal(ok.contacts[1].name, "李经理");
  assert.equal(ok.contacts[1].wechatId, "li-manager");
  assert.equal(JSON.parse(fs.readFileSync(path.join(activeTouchDir, "contacts.json"), "utf8")).length, 2);

  const xwechatContactDir = path.join(xwechatAccountDir, "db_storage", "contact");
  fs.mkdirSync(xwechatContactDir, { recursive: true });
  fs.mkdirSync(path.join(xwechatRoot, "all_users", "login", "wxid_latest"), { recursive: true });
  fs.writeFileSync(path.join(xwechatContactDir, "contact.db"), "encrypted", "utf8");
  fs.writeFileSync(path.join(xwechatRoot, "all_users", "login", "wxid_latest", "key_info.db"), "key-window", "utf8");
  fs.writeFileSync(
    helperPath,
    `
const fs = require("node:fs");
const contactDb = process.argv[process.argv.indexOf("--contact-db") + 1];
const keyInfo = process.argv[process.argv.indexOf("--key-info") + 1];
if (!contactDb.includes("db_storage") || !keyInfo.includes("all_users")) process.exit(4);
const out = process.argv[process.argv.indexOf("--out") + 1];
fs.writeFileSync(out, JSON.stringify([{ username: "wxid_x", remark: "新版目录客户", local_type: 1 }]), "utf8");
`,
    "utf8"
  );
  const xwechatOk = sync(syncDir, { wechatRoot: xwechatRoot, activeTouchDir, helperPath });
  assert.equal(xwechatOk.ok, true);
  assert.equal(xwechatOk.contacts.length, 1);
  assert.equal(xwechatOk.contacts[0].name, "新版目录客户");
  assert.equal(xwechatOk.state.account_name, "wxid_latest_abcd");
  assert.equal(xwechatOk.contacts[0].wechatAccountId, "wxid_latest_abcd");

  fs.writeFileSync(path.join(activeTouchDir, "contacts.json"), JSON.stringify(xwechatOk.contacts.map(({ wechatAccountId, ...contact }) => contact)), "utf8");
  const hydrated = status(syncDir, { activeTouchDir });
  assert.equal(hydrated.contacts[0].wechatAccountId, "wxid_latest_abcd");

  const builtIn = resolveHelper(__dirname);
  if (builtIn.helperConfigured) {
    const helperSelfCheck = spawnSync(builtIn.pythonPath, [builtIn.helperPath, "self-check"], { encoding: "utf8", windowsHide: true });
    assert.equal(helperSelfCheck.status, 0, helperSelfCheck.stderr);
    assert.equal(JSON.parse(helperSelfCheck.stdout).ok, true);
    const contactDb = path.join(accountDir, "contact.db");
    fs.rmSync(contactDb, { force: true });
    const createDb = spawnSync(
      builtIn.pythonPath,
      [
        "-c",
        `
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("CREATE TABLE contact (username TEXT, alias TEXT, remark TEXT, nick_name TEXT, type INTEGER, verify_flag INTEGER, chat_room_type INTEGER, delete_flag INTEGER, deleted_at TEXT)")
con.executemany("INSERT INTO contact VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
  ("wxid_3", "alias_3", "赵总", "老赵", 1, 0, 0, 0, None),
  ("wxid_4", "", "", "公众号", 1, 8, 0, 0, None),
  ("wxid_5", "", "已删", "删除", 1, 0, 0, 0, "2026-01-01"),
  ("123@chatroom", "", "群", "群", 1, 0, 1, 0, None),
  ("wxid_cache", "", "", "缓存", 0, 0, 0, 0, None),
  ("wxid_history", "", "", "历史缓存", 3, 0, 0, 0, None)
])
con.commit()
con.close()
`,
        contactDb
      ],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(createDb.status, 0, createDb.stderr);

    const viaBuiltIn = sync(syncDir, {
      wechatRoot,
      activeTouchDir,
      helperPath: builtIn.helperPath,
      pythonPath: builtIn.pythonPath
    });
    assert.equal(viaBuiltIn.ok, true);
    assert.equal(viaBuiltIn.contacts.length, 1);
    assert.equal(viaBuiltIn.contacts[0].id, "wxid_3");
    assert.equal(viaBuiltIn.contacts[0].name, "赵总");
    assert.equal(viaBuiltIn.contacts[0].wechatId, "alias_3");

    const rawKeyHex = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const plainContactDb = path.join(root, "plain-contact.db");
    fs.copyFileSync(contactDb, plainContactDb);
    const encryptedDb = path.join(root, "encrypted-contact.db");
    const decryptedDb = path.join(root, "decrypted-contact.db");
    encryptSqlcipher4Like(contactDb, encryptedDb, rawKeyHex);
    assert.equal(decryptSqlcipher4Raw(encryptedDb, decryptedDb, rawKeyHex), true);
    assert.equal(fs.readFileSync(decryptedDb).subarray(0, 16).toString("binary"), "SQLite format 3\0");
    assert.equal(fs.statSync(decryptedDb).size % 4096, 0);
    fs.copyFileSync(encryptedDb, contactDb);
    const copiedDecryptedDb = path.join(root, "copied-decrypted-contact.db");
    assert.equal(decryptSqlcipher4Raw(contactDb, copiedDecryptedDb, rawKeyHex), true);

    const capturedWithoutExternalDump = capture(syncDir, {
      wechatRoot,
      activeTouchDir,
      keyToolPath: path.join(root, "missing-key-tool.exe"),
      dumpToolPath: path.join(root, "missing-dump-tool.exe"),
      wxKeyProbePath: path.join(root, "missing-wx-key-probe.py"),
      pythonPath: builtIn.pythonPath,
      timeoutMs: 1000,
      pollIntervalMs: 10,
      processProvider: () => [],
      keyInfoReader: () => ({ keyHex: rawKeyHex, observed: true }),
      decryptedContactReader: () => [{ username: "wxid_3", alias: "alias_3", remark: "赵总", nick_name: "老赵", local_type: 1 }]
    });
    assert.equal(capturedWithoutExternalDump.ok, true, JSON.stringify(capturedWithoutExternalDump));
    assert.equal(capturedWithoutExternalDump.contacts.length, 1);
    fs.copyFileSync(plainContactDb, contactDb);

    fs.writeFileSync(
      keyToolPath,
      `console.log('${rawKeyHex}');`,
      "utf8"
    );
    fs.writeFileSync(
      dumpToolPath,
      `
const fs = require("node:fs");
const input = process.argv[process.argv.indexOf("-f") + 1];
const output = process.argv[process.argv.indexOf("-o") + 1];
fs.copyFileSync(input, output);
`,
      "utf8"
    );
    let loginFlowPrepared = false;
    const capturedFromKeyInfo = capture(syncDir, {
      wechatRoot,
      activeTouchDir,
      restartWechat: true,
      loginFlowDriver: () => {
        loginFlowPrepared = true;
        return { ok: true, restarted: true };
      },
      keyToolPath: path.join(root, "missing-key-tool.exe"),
      dumpToolPath,
      wxKeyProbePath: path.join(root, "missing-wx-key-probe.py"),
      pythonPath: builtIn.pythonPath,
      timeoutMs: 1000,
      pollIntervalMs: 10,
      processProvider: () => [],
      keyInfoReader: () => ({
        keyHex: rawKeyHex,
        observed: true
      })
    });
    assert.equal(capturedFromKeyInfo.ok, true);
    assert.equal(loginFlowPrepared, true);
    assert.equal(capturedFromKeyInfo.state.last_stage, "captured_and_synced");
    assert.equal(capturedFromKeyInfo.contacts.length, 1);

    const capturedFromWxKey = capture(syncDir, {
      wechatRoot,
      activeTouchDir,
      keyToolPath: path.join(root, "missing-key-tool.exe"),
      dumpToolPath,
      pythonPath: builtIn.pythonPath,
      timeoutMs: 1000,
      pollIntervalMs: 10,
      processProvider: () => [{ id: 123, path: "Weixin.exe" }],
      wxKeyReader: () => rawKeyHex
    });
    assert.equal(capturedFromWxKey.ok, true);
    assert.equal(capturedFromWxKey.state.last_stage, "captured_and_synced");
    assert.equal(capturedFromWxKey.contacts.length, 1);

    const captured = capture(syncDir, {
      wechatRoot,
      activeTouchDir,
      keyToolPath,
      dumpToolPath,
      wxKeyProbePath: path.join(root, "missing-wx-key-probe.py"),
      pythonPath: builtIn.pythonPath,
      timeoutMs: 1000,
      pollIntervalMs: 10,
      processProvider: () => [{ id: 123, path: "Weixin.exe" }]
    });
    assert.equal(captured.ok, true);
    assert.equal(captured.state.last_stage, "captured_and_synced");
    assert.equal(captured.contacts.length, 1);
  }

  console.log("contact-sync self-check passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
