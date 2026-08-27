const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { candidateWechatRoots, capture, captureKeyFromWxKeyDll, decryptSqlcipher4Raw, findWechatExecutable, findWechatRoot, prepareWechatLogin, resolveHelper, runningWeixinProcesses, status, sync } = require("./contact_sync_cli.cjs");

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
const CAPTURE_SUCCESS_TIMEOUT_MS = 3_000;

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

function runBuiltInHelper(helper, args) {
  const isPython = path.extname(helper.helperPath).toLowerCase() === ".py";
  return spawnSync(isPython ? helper.pythonPath : helper.helperPath, isPython ? [helper.helperPath, ...args] : args, {
    encoding: "utf8",
    windowsHide: true
  });
}

try {
  assert.equal(candidateWechatRoots().includes(path.join(os.homedir(), "xwechat_files")), true, "new WeChat default data root must be auto-detected");
  assert.equal(candidateWechatRoots().includes(path.join(os.homedir(), "Documents", "xwechat_files")), true, "Documents xwechat_files must be auto-detected");
  if (process.platform === "win32") assert.equal(candidateWechatRoots().includes("C:\\xwechat_files"), true, "drive-root xwechat_files must be auto-detected");

  const configuredBase = path.join(root, "自定义 微信数据");
  const configuredRoot = path.join(configuredBase, "xwechat_files");
  const configuredAccount = path.join(configuredRoot, "wxid_customer_demo");
  const configuredAppData = path.join(root, "AppData", "Roaming");
  fs.mkdirSync(path.join(configuredAccount, "db_storage", "contact"), { recursive: true });
  fs.mkdirSync(path.join(configuredRoot, "all_users", "login", "wxid_customer"), { recursive: true });
  fs.mkdirSync(path.join(configuredAppData, "Tencent", "xwechat", "config"), { recursive: true });
  fs.writeFileSync(path.join(configuredAccount, "db_storage", "contact", "contact.db"), "encrypted", "utf8");
  fs.writeFileSync(path.join(configuredRoot, "all_users", "login", "wxid_customer", "key_info.db"), "key-window", "utf8");
  fs.writeFileSync(path.join(configuredAppData, "Tencent", "xwechat", "config", "customer.ini"), `data_dir=${configuredBase}\n`, "utf8");
  assert.equal(findWechatRoot({ appDataDir: configuredAppData, processProvider: () => [] }), configuredRoot, "WeChat's own config must locate a custom Chinese data directory");
  assert.equal(findWechatRoot({ wechatRoot: path.join(root, "stale-missing-root"), appDataDir: configuredAppData, processProvider: () => [] }), configuredRoot, "a missing saved path must not hide WeChat's current configured data root");
  assert.equal(findWechatRoot({ wechatRoot: configuredBase }), configuredRoot, "manual selection may point at the parent containing xwechat_files");
  const emptyRoot = path.join(root, "empty-xwechat_files");
  fs.mkdirSync(emptyRoot, { recursive: true });
  assert.equal(findWechatRoot({ wechatRoot: emptyRoot }), "", "an existing but empty directory must not be treated as a valid WeChat root");

  assert.deepEqual(
    runningWeixinProcesses({ processProvider: () => [
      { id: 21, commandLine: "--type=wxocr", mainWindowHandle: 1, moduleReady: false },
      { id: 42, path: "D:\\微信\\Weixin\\Weixin.exe", commandLine: "--scene=desktop", moduleReady: true }
    ] }).map((row) => row.id),
    [42],
    "wx_key capture must target the desktop main process even when a child process owns a visible window"
  );
  assert.equal(runningWeixinProcesses({ processProvider: () => [{ id: 42, path: "D:\\微信\\Weixin\\Weixin.exe", commandLine: "--scene=desktop", moduleReady: true }] })[0].path, "D:\\微信\\Weixin\\Weixin.exe", "Chinese executable paths must remain intact");
  const registryWechatExe = path.join(root, "自定义微信", "Weixin.exe");
  fs.mkdirSync(path.dirname(registryWechatExe), { recursive: true });
  fs.writeFileSync(registryWechatExe, "test", "utf8");
  assert.equal(findWechatExecutable({
    processProvider: () => [],
    commonWechatExeCandidates: [],
    installedExecutableProvider: () => [registryWechatExe]
  }), registryWechatExe, "the Windows uninstall registry must provide a custom Weixin install path when WeChat is closed");
  assert.deepEqual(prepareWechatLogin({ loginFlowDriver: () => ({ ok: true, restarted: true }) }), { ok: true, restarted: true });
  assert.deepEqual(prepareWechatLogin({ loginFlowDriver: () => ({ ok: false, reason: "wechat_start_failed" }) }), {
    ok: false,
    reason: "wechat_start_failed"
  });

  const wxKeyHex = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const fakeWxKeyHelper = path.join(root, "fake-wx-key-helper.cjs");
  const fakeWxKeyDll = path.join(root, "fake-wx-key.dll");
  fs.writeFileSync(fakeWxKeyDll, "contract-only", "utf8");
  fs.writeFileSync(fakeWxKeyHelper, `const assert = require("node:assert"); assert.equal(process.argv[2], "wx-key"); if (process.argv.includes("--exe")) { assert.equal(process.argv[process.argv.indexOf("--exe") + 1], "C:\\\\Weixin.exe"); assert.equal(process.argv.includes("--pid"), false); } console.log(JSON.stringify({ ok: true, key: "${wxKeyHex}" }));`, "utf8");
  assert.equal(captureKeyFromWxKeyDll({
    selfContainedHelperPath: fakeWxKeyHelper,
    wxKeyDllPath: fakeWxKeyDll,
    wxKeyProbePath: "",
    pythonPath: ""
  }, {}, [{ id: 123 }], 1000), wxKeyHex, "self-contained helper must not require Python");
  assert.equal(captureKeyFromWxKeyDll({
    selfContainedHelperPath: fakeWxKeyHelper,
    wxKeyDllPath: fakeWxKeyDll,
    wxKeyProbePath: "",
    pythonPath: ""
  }, { launchWechatExe: "C:\\Weixin.exe" }, [{ id: 123 }], 1000), wxKeyHex, "helper-owned launch must use --exe without attaching to an already-running PID");

  const fakeFailingWxKeyHelper = path.join(root, "fake-failing-wx-key-helper.cjs");
  fs.writeFileSync(fakeFailingWxKeyHelper, `console.log(JSON.stringify({ ok: false, stage: "dll_load_failed", error: "missing native dependency" })); process.exitCode = 2;`, "utf8");
  let failedWxKeyResult;
  assert.equal(captureKeyFromWxKeyDll({
    selfContainedHelperPath: fakeFailingWxKeyHelper,
    wxKeyDllPath: fakeWxKeyDll,
    wxKeyProbePath: "",
    pythonPath: ""
  }, { onWxKeyResult: (result) => { failedWxKeyResult = result; } }, [{ id: 123 }], 1000), "");
  assert.deepEqual(failedWxKeyResult, { status: 2, stage: "dll_load_failed", error: "missing native dependency" }, "wx-key helper failure must remain visible in state diagnostics");

  assert.equal(sync(syncDir, { wechatRoot: emptyRoot, activeTouchDir }).blocked_reason, "wechat_root_not_found");

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
    const helperSelfCheck = runBuiltInHelper(builtIn, ["self-check"]);
    assert.equal(helperSelfCheck.status, 0, helperSelfCheck.stderr);
    const helperSelfCheckPayload = JSON.parse(helperSelfCheck.stdout);
    assert.equal(helperSelfCheckPayload.ok, true);
    assert.equal(helperSelfCheckPayload.memory_key_patterns, 2, "helper must recognize standalone and salt-suffixed WeChat 4.x memory keys");
    assert.equal(helperSelfCheckPayload.wx_key_lifecycle, "hook-resume-poll-cleanup", "helper must install the hook before WeChat login can continue");
    const wxKeyHelp = runBuiltInHelper(builtIn, ["wx-key", "--help"]);
    assert.equal(wxKeyHelp.status, 0, wxKeyHelp.stderr);
    assert.equal(wxKeyHelp.stdout.includes("--exe"), true, "wx-key helper must own WeChat launch so login cannot beat hook setup");
    const wxKeyContract = runBuiltInHelper(builtIn, ["wx-key", "--dll", path.join(root, "missing-wx-key.dll"), "--pid", "123", "--timeout", "1"]);
    assert.equal(wxKeyContract.status, 2);
    assert.equal(JSON.parse(wxKeyContract.stdout).stage, "dll_missing", "helper must dispatch the packaged wx-key command");
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
      timeoutMs: CAPTURE_SUCCESS_TIMEOUT_MS,
      pollIntervalMs: 10,
      processProvider: () => [{ id: 123, path: "C:\\Weixin.exe" }],
      keyInfoReader: () => ({ keyHex: rawKeyHex, observed: true }),
      decryptedContactReader: () => [{ username: "wxid_3", alias: "alias_3", remark: "赵总", nick_name: "老赵", local_type: 1 }]
    });
    assert.equal(capturedWithoutExternalDump.ok, true, JSON.stringify(capturedWithoutExternalDump));
    assert.equal(capturedWithoutExternalDump.contacts.length, 1);

    const firstLoginRoot = path.join(root, "first-login", "xwechat_files");
    const currentAccountDir = path.join(firstLoginRoot, "wxid_current_demo");
    const otherAccountDir = path.join(firstLoginRoot, "wxid_other_demo");
    const currentContactDir = path.join(currentAccountDir, "db_storage", "contact");
    const otherContactDir = path.join(otherAccountDir, "db_storage", "contact");
    const currentContactDb = path.join(currentContactDir, "contact.db");
    const otherContactDb = path.join(otherContactDir, "contact.db");
    const otherEncryptedDb = path.join(root, "other-encrypted-contact.db");
    const otherKeyHex = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
    fs.mkdirSync(firstLoginRoot, { recursive: true });
    encryptSqlcipher4Like(plainContactDb, otherEncryptedDb, otherKeyHex);
    let firstLoginHookCalls = 0;
    const capturedOnFirstLogin = capture(syncDir, {
      wechatRoot: firstLoginRoot,
      activeTouchDir,
      keyToolPath: path.join(root, "missing-key-tool.exe"),
      dumpToolPath: path.join(root, "missing-dump-tool.exe"),
      timeoutMs: CAPTURE_SUCCESS_TIMEOUT_MS,
      pollIntervalMs: 10,
      restartWechat: true,
      loginFlowDriver: () => ({ ok: true, restarted: true, wechatExePath: "D:\\微信\\Weixin\\Weixin.exe" }),
      processProvider: () => [{ id: 123, path: "D:\\微信\\Weixin\\Weixin.exe", commandLine: "--scene=desktop", moduleReady: true }],
      wxKeyReader: () => {
        firstLoginHookCalls += 1;
        fs.mkdirSync(currentContactDir, { recursive: true });
        fs.mkdirSync(otherContactDir, { recursive: true });
        spawn(process.execPath, ["-e", `
          const fs = require("node:fs");
          setTimeout(() => {
            fs.copyFileSync(process.env.XIAOXI_SOURCE_CURRENT, process.env.XIAOXI_TARGET_CURRENT);
            fs.copyFileSync(process.env.XIAOXI_SOURCE_OTHER, process.env.XIAOXI_TARGET_OTHER);
            const now = Date.now() / 1000;
            fs.utimesSync(process.env.XIAOXI_TARGET_CURRENT, now - 10, now - 10);
            fs.utimesSync(process.env.XIAOXI_TARGET_OTHER, now, now);
          }, 75);
        `], {
          windowsHide: true,
          stdio: "ignore",
          env: {
            ...process.env,
            XIAOXI_SOURCE_CURRENT: encryptedDb,
            XIAOXI_TARGET_CURRENT: currentContactDb,
            XIAOXI_SOURCE_OTHER: otherEncryptedDb,
            XIAOXI_TARGET_OTHER: otherContactDb
          }
        });
        return rawKeyHex;
      },
      decryptedContactReader: () => [{ username: "wxid_first", remark: "首次登录客户", local_type: 1 }]
    });
    assert.equal(capturedOnFirstLogin.ok, true, JSON.stringify(capturedOnFirstLogin));
    assert.equal(firstLoginHookCalls, 1, "the login hook must start before contact.db exists");
    assert.equal(capturedOnFirstLogin.state.account_name, "wxid_current_demo", "the captured key must remain available until a new-format contact.db appears and be checked across every account");

    const memoryAccountCalls = [];
    const capturedFromNonLatestMemoryAccount = capture(syncDir, {
      wechatRoot: firstLoginRoot,
      activeTouchDir,
      keyToolPath: path.join(root, "missing-key-tool.exe"),
      dumpToolPath: path.join(root, "missing-dump-tool.exe"),
      timeoutMs: CAPTURE_SUCCESS_TIMEOUT_MS,
      pollIntervalMs: 10,
      restartWechat: true,
      loginFlowDriver: () => ({ ok: true, restarted: true }),
      processProvider: () => [{ id: 123, path: "D:\\微信\\Weixin\\Weixin.exe", commandLine: "--scene=desktop", moduleReady: true }],
      keyInfoReader: () => ({ observed: false, keyHex: "" }),
      wxKeyReader: () => ({ keyHex: "", stage: "hook_status_1", error: "missed", status: 1 }),
      memoryKeyReader: (candidateDb) => {
        memoryAccountCalls.push(candidateDb);
        return candidateDb === currentContactDb ? rawKeyHex : "";
      },
      decryptedContactReader: () => [{ username: "wxid_memory", remark: "内存回退客户", local_type: 1 }]
    });
    assert.equal(capturedFromNonLatestMemoryAccount.ok, true, JSON.stringify(capturedFromNonLatestMemoryAccount));
    assert.equal(memoryAccountCalls[0], otherContactDb, "the newer stale account must be tried first in this regression setup");
    assert.equal(memoryAccountCalls.includes(currentContactDb), true, "memory fallback must try every account database");
    assert.equal(capturedFromNonLatestMemoryAccount.state.account_name, "wxid_current_demo");
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
      timeoutMs: CAPTURE_SUCCESS_TIMEOUT_MS,
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

    const captureOrder = [];
    const capturedFromMemory = capture(syncDir, {
      wechatRoot,
      activeTouchDir,
      keyToolPath: path.join(root, "missing-key-tool.exe"),
      dumpToolPath,
      pythonPath: builtIn.pythonPath,
      timeoutMs: CAPTURE_SUCCESS_TIMEOUT_MS,
      pollIntervalMs: 10,
      processProvider: () => [{ id: 123, path: "Weixin.exe" }],
      keyInfoReader: () => {
        captureOrder.push("key-info");
        return { observed: true, keyHex: "" };
      },
      memoryKeyReader: () => {
        captureOrder.push("memory");
        return rawKeyHex;
      },
      wxKeyReader: () => {
        captureOrder.push("wx-key");
        return rawKeyHex;
      }
    });
    assert.equal(capturedFromMemory.ok, true);
    assert.deepEqual(captureOrder, ["key-info", "memory"]);
    assert.equal(capturedFromMemory.state.last_stage, "captured_and_synced");
    assert.equal(capturedFromMemory.contacts.length, 1);

    const fallbackOrder = [];
    const capturedFromWxKeyFallback = capture(syncDir, {
      wechatRoot,
      activeTouchDir,
      keyToolPath: path.join(root, "missing-key-tool.exe"),
      dumpToolPath,
      pythonPath: builtIn.pythonPath,
      timeoutMs: CAPTURE_SUCCESS_TIMEOUT_MS,
      pollIntervalMs: 10,
      processProvider: () => [{ id: 123, path: "Weixin.exe" }],
      keyInfoReader: () => {
        fallbackOrder.push("key-info");
        return { observed: true, keyHex: "" };
      },
      memoryKeyReader: () => {
        fallbackOrder.push("memory");
        return "";
      },
      wxKeyReader: () => {
        fallbackOrder.push("wx-key");
        return rawKeyHex;
      }
    });
    assert.equal(capturedFromWxKeyFallback.ok, true);
    assert.deepEqual(fallbackOrder, ["key-info", "memory", "wx-key"]);

    const restartCaptureOrder = [];
    let restartPreparation;
    let restartHookOptions;
    const capturedDuringRestart = capture(syncDir, {
      wechatRoot,
      activeTouchDir,
      keyToolPath: path.join(root, "missing-key-tool.exe"),
      dumpToolPath,
      pythonPath: builtIn.pythonPath,
      timeoutMs: CAPTURE_SUCCESS_TIMEOUT_MS,
      pollIntervalMs: 10,
      restartWechat: true,
      commonWechatExeCandidates: [],
      installedExecutableProvider: () => [registryWechatExe],
      loginFlowDriver: (options) => {
        restartPreparation = options;
        return { ok: true, restarted: true, wechatExePath: "C:\\Weixin.exe" };
      },
      processProvider: () => [],
      keyInfoReader: () => {
        restartCaptureOrder.push("key-info");
        return { observed: true, keyHex: "" };
      },
      memoryKeyReader: () => {
        restartCaptureOrder.push("memory");
        return "";
      },
      wxKeyReader: (hookOptions) => {
        restartCaptureOrder.push("wx-key");
        restartHookOptions = hookOptions;
        return rawKeyHex;
      }
    });
    assert.equal(capturedDuringRestart.ok, true);
    assert.deepEqual(restartCaptureOrder, ["wx-key"]);
    assert.equal(Boolean(restartPreparation.stopOnly), true, "restart capture must stop WeChat without starting login before hook setup");
    assert.equal(restartPreparation.wechatExePath, registryWechatExe, "restart capture must pass the registry-discovered Weixin executable to the login flow");
    assert.equal(restartHookOptions.launchWechatExe, "C:\\Weixin.exe", "wx-key helper must launch WeChat and install hook before login continues");

    let processChecks = 0;
    let moduleHookCalls = 0;
    const moduleFallbackCalls = [];
    const capturedWithHelperOwnedModuleWait = capture(syncDir, {
      wechatRoot,
      activeTouchDir,
      keyToolPath: path.join(root, "missing-key-tool.exe"),
      dumpToolPath,
      pythonPath: builtIn.pythonPath,
      timeoutMs: 3_000,
      pollIntervalMs: 5,
      restartWechat: true,
      loginFlowDriver: () => ({ ok: true, restarted: true, wechatExePath: "D:\\微信\\Weixin\\Weixin.exe" }),
      processProvider: () => {
        processChecks += 1;
        return [{ id: 123, path: "D:\\微信\\Weixin\\Weixin.exe", commandLine: "--scene=desktop", moduleReady: false }];
      },
      keyInfoReader: () => {
        moduleFallbackCalls.push("key-info");
        return { observed: true, keyHex: "" };
      },
      memoryKeyReader: () => {
        moduleFallbackCalls.push("memory");
        return "";
      },
      wxKeyReader: (hookOptions) => {
        moduleHookCalls += 1;
        assert.equal(hookOptions.launchWechatExe, "D:\\微信\\Weixin\\Weixin.exe");
        return rawKeyHex;
      }
    });
    assert.equal(capturedWithHelperOwnedModuleWait.ok, true);
    assert.equal(processChecks, 1, "restart capture must delegate module waiting to the helper without a pre-hook polling delay");
    assert.equal(moduleHookCalls, 1);
    assert.deepEqual(moduleFallbackCalls, [], "fallback readers must not run before the helper-owned hook attempt");

    let retryHookCalls = 0;
    const retryFallbackCalls = [];
    const retryAttemptOrder = [];
    const capturedAfterInitRetry = capture(syncDir, {
      wechatRoot,
      activeTouchDir,
      keyToolPath: path.join(root, "missing-key-tool.exe"),
      dumpToolPath,
      pythonPath: builtIn.pythonPath,
      timeoutMs: 10000,
      pollIntervalMs: 5,
      restartWechat: true,
      loginFlowDriver: () => ({ ok: true, restarted: true, wechatExePath: "D:\\微信\\Weixin\\Weixin.exe" }),
      processProvider: () => [{ id: 123, path: "D:\\微信\\Weixin\\Weixin.exe", commandLine: "--scene=desktop", moduleReady: true }],
      keyInfoReader: () => {
        retryAttemptOrder.push("key-info");
        retryFallbackCalls.push("key-info");
        return { observed: true, keyHex: "" };
      },
      memoryKeyReader: () => {
        retryAttemptOrder.push("memory");
        retryFallbackCalls.push("memory");
        return "";
      },
      wxKeyReader: () => {
        retryHookCalls += 1;
        retryAttemptOrder.push(`hook-${retryHookCalls}`);
        return retryHookCalls === 1
          ? { keyHex: "", stage: "init_failed", error: "Weixin.dll not ready", status: 1 }
          : { keyHex: rawKeyHex, stage: "captured", error: "", status: 0 };
      }
    });
    assert.equal(capturedAfterInitRetry.ok, true);
    assert.equal(retryHookCalls, 2, "a transient hook initialization failure must be retried");
    assert.deepEqual(retryAttemptOrder.slice(0, 2), ["hook-1", "hook-2"], "fallback readers must not run before the hook initialization retry");
    assert.ok(retryFallbackCalls.every((source) => ["key-info", "memory"].includes(source)));

    const timeoutWithoutKeyInfo = capture(syncDir, {
      wechatRoot,
      activeTouchDir,
      keyToolPath: path.join(root, "missing-key-tool.exe"),
      dumpToolPath,
      pythonPath: builtIn.pythonPath,
      timeoutMs: 30,
      pollIntervalMs: 5,
      processProvider: () => [{ id: 123, path: "D:\\微信\\Weixin\\Weixin.exe", commandLine: "--scene=desktop", moduleReady: true }],
      keyInfoReader: () => ({ observed: false, keyHex: "" }),
      memoryKeyReader: () => "",
      wxKeyReader: () => ({ keyHex: "", stage: "dll_missing", error: "", status: 2 })
    });
    assert.equal(timeoutWithoutKeyInfo.ok, false);
    assert.equal(timeoutWithoutKeyInfo.error, "微信 hook 未捕获到密钥（dll_missing），内存回退也未匹配到可用密钥", "timeout diagnostics must preserve both hook and memory fallback failures");
    assert.equal(timeoutWithoutKeyInfo.state.last_stage, "capture_timeout_wx_hook_then_memory");

    const hookOnlyTimeout = capture(syncDir, {
      wechatRoot,
      activeTouchDir,
      contactHelperPath: path.join(root, "missing-contact-helper.exe"),
      memoryKeyProbePath: path.join(root, "missing-memory-probe.py"),
      pythonPath: "",
      keyInfoReader: () => ({ observed: false, keyHex: "" }),
      wxKeyReader: () => ({ keyHex: "", stage: "hook_status_1", error: "waiting", status: 1 }),
      timeoutMs: 30,
      pollIntervalMs: 5,
      processProvider: () => [{ id: 123, path: "D:\\微信\\Weixin\\Weixin.exe", commandLine: "--scene=desktop", moduleReady: true }]
    });
    assert.equal(hookOnlyTimeout.error, "已安装微信登录期 hook，但登录窗口期内未捕获到可用密钥");

    const captured = capture(syncDir, {
      wechatRoot,
      activeTouchDir,
      keyToolPath,
      dumpToolPath,
      wxKeyProbePath: path.join(root, "missing-wx-key-probe.py"),
      pythonPath: builtIn.pythonPath,
      timeoutMs: CAPTURE_SUCCESS_TIMEOUT_MS,
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
