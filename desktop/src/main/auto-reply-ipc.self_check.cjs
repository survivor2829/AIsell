const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAutoReplyController, isReplyableText, registerAutoReplyIpc } = require("./auto-reply-ipc.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-auto-reply-"));
const activeTouchDir = path.join(root, "active_touch");
fs.mkdirSync(activeTouchDir, { recursive: true });
fs.writeFileSync(path.join(activeTouchDir, "contacts.json"), JSON.stringify([
  { id: "c1", name: "张总", allowed: true, wechatAccountId: "wx-a" },
  { id: "c2", name: "李经理", allowed: true, wechatAccountId: "wx-a" },
  { id: "c3", name: "王总", allowed: true, wechatAccountId: "wx-b" }
]), "utf8");

async function main() {
  assert.equal(isReplyableText("你好，方便介绍一下吗？"), true);
  assert.equal(isReplyableText("[图片]"), false);
  assert.equal(isReplyableText("请把验证码和银行卡发给我"), false);

  const candidates = [
    { ok: true, conversation: "张总", message: "你好，方便介绍一下吗？", runtimeId: "message-1", pid: 81, hWnd: "91" },
    { ok: true, conversation: "张总", message: "你好，方便介绍一下吗？", runtimeId: "message-1", pid: 81, hWnd: "91" },
    { ok: true, conversation: "李经理", message: "现在方便吗？", runtimeId: "message-2", pid: 81, hWnd: "91" }
  ];
  const scannedNames = [];
  let verifyAllowed = true;
  let sendCalls = 0;
  let replyCalls = 0;
  const coordinator = {
    acquire: ({ state }) => state === "replying" ? { ok: true, lock: { owner: "reply-owner" } } : { ok: false },
    update: () => ({ ok: true }),
    release: () => ({ ok: true })
  };
  const controller = createAutoReplyController({
    dataDir: path.join(root, "auto_reply"),
    activeTouchDir,
    coordinator,
    deepSeekClient: {
      assertAvailable: () => true,
      reply: async ({ incoming }) => {
        replyCalls += 1;
        assert.equal(incoming.includes("方便"), true);
        return { reply: "您好，可以的，请问您想先了解哪方面？" };
      }
    },
    scanIncoming: (names) => {
      scannedNames.push([...names]);
      return candidates.shift() || { ok: false, reason: "no_unread_message" };
    },
    verifyIncoming: () => ({ ok: verifyAllowed }),
    send: async (options) => {
      sendCalls += 1;
      assert.equal(options.authorized, true);
      assert.equal(options.frozenContact.name, sendCalls === 1 ? "张总" : "李经理");
      assert.equal(await options.beforeDraft(), verifyAllowed);
      return verifyAllowed
        ? { ok: true, state: { real_send_status: "sent_verified" } }
        : { ok: false, blocked_reason: "batch_cancelled" };
    },
    runStep: async () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });

  const mixedAccounts = controller.start({ contactIds: ["c1", "c3"], instruction: "礼貌简短回复", workStart: "00:00", workEnd: "23:59" });
  assert.equal(mixedAccounts.ok, false);
  assert.match(mixedAccounts.error, /同一个微信账号/);
  const started = controller.start({ contactIds: ["c1", "c2"], instruction: "礼貌简短回复", workStart: "00:00", workEnd: "23:59" });
  assert.equal(started.ok, true);
  fs.writeFileSync(path.join(activeTouchDir, "contacts.json"), JSON.stringify([
    { id: "c1", name: "同步后被改名", allowed: true, wechatAccountId: "wx-a" },
    { id: "c2", name: "李经理", allowed: true, wechatAccountId: "wx-a" }
  ]), "utf8");
  await controller.runOnce();
  assert.equal(controller.status().reply_count, 1);
  assert.equal(sendCalls, 1);
  assert.equal(replyCalls, 1);
  assert.deepEqual(scannedNames[0].sort(), ["张总", "李经理"]);

  await controller.runOnce();
  assert.equal(sendCalls, 1, "the same incoming message must not be sent twice");
  assert.equal(replyCalls, 1, "the same incoming message must not call AI twice");

  verifyAllowed = false;
  await controller.runOnce();
  assert.equal(sendCalls, 2);
  assert.equal(controller.status().skipped_count, 1);
  assert.equal(controller.status().last_event, "manual_reply_or_message_changed");
  assert.equal(controller.pause().state.status, "paused");

  const handlers = new Map();
  const webContents = {};
  registerAutoReplyIpc({
    dataDir: path.join(root, "ipc_auto_reply"),
    activeTouchDir,
    coordinator,
    deepSeekClient: { assertAvailable: () => true },
    send: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    verifyIncoming: () => ({ ok: true }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
    getMainWindow: () => ({ isDestroyed: () => false, isFocused: () => true, webContents }),
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }
  });
  assert.deepEqual([...handlers.keys()].sort(), ["auto-reply:pause", "auto-reply:start", "auto-reply:status"]);
  assert.equal((await handlers.get("auto-reply:start")({ sender: webContents }, { contactIds: ["c1"] })).ok, false);
  assert.match(fs.readFileSync(path.join(__dirname, "preload-api.cjs"), "utf8"), /data-xiaoxi-auto-reply-start/);

  const recoveryDir = path.join(root, "recovery_auto_reply");
  fs.mkdirSync(recoveryDir, { recursive: true });
  fs.writeFileSync(path.join(recoveryDir, "auto-reply-state.json"), JSON.stringify({ status: "running" }), "utf8");
  const recovered = createAutoReplyController({
    dataDir: recoveryDir,
    activeTouchDir,
    coordinator,
    deepSeekClient: { assertAvailable: () => true },
    send: async () => ({ ok: true }),
    runStep: async () => ({ ok: true }),
    scanIncoming: () => ({ ok: false, reason: "no_unread_message" }),
    verifyIncoming: () => ({ ok: true }),
    now: () => new Date("2026-07-14T10:00:00+08:00")
  });
  assert.equal(recovered.status().status, "paused");
  assert.equal(recovered.status().last_event, "recovered_after_restart");
  console.log("auto-reply self-check passed");
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
