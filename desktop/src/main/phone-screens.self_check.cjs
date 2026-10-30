const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createVideoParser, touchMessage, keyMessage, pasteMessage } = require("./phone-stream.cjs");
const { createPhoneScreens } = require("./phone-screens.cjs");
const { createPhoneBatch } = require("./phone-batch.cjs");
const { batchActivity, batchSummary } = require("./phone-matrix-ipc.cjs");

// 手机矩阵 parts 2–4 (user project of 2026-10-30): live screens, sync and batch actions.

// scrcpy 5.0.1 wire format: dummy byte, 64-byte name, codec, then session and media packets.
const seen = [];
const parse = createVideoParser({ onMeta: (meta) => seen.push(["meta", meta.name]), onSession: (size) => seen.push(["size", size.width, size.height]), onPacket: (packet) => seen.push(["packet", packet.config, packet.key, packet.data.length]) });
const name = Buffer.alloc(64); name.write("KOZ-AL40");
const session = Buffer.alloc(12); session.writeBigUInt64BE(1n << 63n); session.writeUInt32BE(576, 4); session.writeUInt32BE(1280, 8);
const media = (flags, body) => { const head = Buffer.alloc(12); head.writeBigUInt64BE(flags); head.writeUInt32BE(body.length, 8); return Buffer.concat([head, body]); };
const stream = Buffer.concat([Buffer.from([0]), name, Buffer.from([0x68, 0x32, 0x36, 0x34]), session, media(1n << 62n, Buffer.alloc(20)), media(1n << 61n, Buffer.alloc(300))]);
for (let i = 0; i < stream.length; i += 7) parse(stream.subarray(i, i + 7)); // arrives in pieces
assert.deepEqual(seen, [["meta", "KOZ-AL40"], ["size", 576, 1280], ["packet", true, false, 20], ["packet", false, true, 300]]);
const touch = touchMessage(0, 100, 200, 576, 1280);
assert.equal(touch.length, 32); assert.equal(touch[0], 2); assert.equal(touch.readInt32BE(10), 100); assert.equal(touch.readUInt16BE(22), 0xffff);
assert.equal(keyMessage(1, 3).length, 14);
const paste = pasteMessage("小玺测试");
assert.equal(paste[0], 9); assert.equal(paste[9], 1, "粘贴：中文走剪贴板再粘贴");
assert.equal(paste.subarray(14).toString("utf8"), "小玺测试");

(async () => {
  // Screens: a tile switched to the main screen gets a new stream on a new port, and each start
  // is its own session (the server deletes its file on exit, so it is pushed every start).
  const made = [];
  const fakeStream = (options) => {
    const entry = { ...options, inputs: [], stopped: "", start: async () => {}, stop(reason) { entry.stopped = reason; options.onClose(reason); },
      size: () => ({ width: 500, height: 1000 }), touch: (action, x, y) => entry.inputs.push(["touch", action, x, y]), key: (code) => entry.inputs.push(["key", code]),
      paste: (text) => entry.inputs.push(["text", text]), screen: (on) => entry.inputs.push(["screen", on]) };
    made.push(entry); return entry;
  };
  const timers = [];
  let random = 0.5;
  const screens = createPhoneScreens({ adbPath: "adb", serverPath: "server", send: () => {}, createStream: fakeStream, setTimer: (fn, ms) => timers.push([ms, fn]), random: () => random });
  await screens.watch({ serials: ["A", "B", "C"] });
  assert.deepEqual(made.map((item) => [item.serial, item.quality]), [["A", "tile"], ["B", "tile"], ["C", "tile"]]);
  await screens.watch({ serials: ["A", "B", "C"], main: "A" });
  assert.equal(made[0].stopped, "stopped");
  assert.equal(made[3].serial, "A"); assert.equal(made[3].quality, "main");
  assert.notEqual(made[3].port, made[0].port, "切换大画面换新端口，旧端口晚到的清理不会拆掉新连接");
  assert.equal(timers.length, 0, "主动停下的画面不自动重连");

  // Sync with 随机延迟: the main phone acts at once; each follower waits its own time, the same for
  // the whole stroke so the drag arrives whole and in order.
  const main = made[3], b = made[1], c = made[2];
  screens.input({ targets: ["A", "B", "C"], kind: "touch", action: 0, x: 0.5, y: 0.5, jitterMs: 1000 });
  random = 0.9;
  screens.input({ targets: ["A", "B", "C"], kind: "touch", action: 2, x: 0.6, y: 0.5, jitterMs: 1000 });
  assert.deepEqual(main.inputs, [["touch", 0, 250, 500], ["touch", 2, 300, 500]], "主控手机不延迟");
  assert.deepEqual(timers.map(([ms]) => ms), [500, 500, 500, 500], "同一笔滑动用同一个延迟");
  timers.splice(0).forEach(([, fn]) => fn());
  assert.deepEqual(b.inputs, [["touch", 0, 250, 500], ["touch", 2, 300, 500]]);
  screens.input({ targets: ["A", "B", "C"], kind: "key", keycode: 3 });
  assert.equal(timers.length, 0, "没开随机延迟时一起动");
  assert.deepEqual(c.inputs.at(-1), ["key", 3]);
  assert.equal(screens.paste("B", "你好"), true); assert.equal(screens.paste("Z", "你好"), false);
  // A stream that drops by itself comes back.
  b.stop("server_exited");
  assert.equal(timers.length, 1);
  screens.stopAll();

  // Batch: every phone's own result, failures in words, the install prompt surfaced to the user.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-batch-"));
  const apk = path.join(dir, "test.apk"); fs.writeFileSync(apk, "x");
  const calls = [];
  let prompt = true;
  const adb = async (args, _timeout, as) => {
    calls.push(args.join(" "));
    const [, serial, command] = args;
    if (command === "install") {
      if (serial === "P2") throw Object.assign(new Error("Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]"), { code: "ADB_FAILED" });
      if (serial === "P3") { while (prompt) await new Promise((resolve) => setTimeout(resolve, 50)); }
      return "Performing Streamed Install\nSuccess\n";
    }
    if (command === "shell" && args[3] === "dumpsys") return serial === "P3" && prompt ? "  mCurrentFocus=Window{1 u0 com.android.packageinstaller/com.android.packageinstaller.PackageInstallerActivity}" : "  mCurrentFocus=Window{2 u0 launcher}";
    if (command === "shell" && args[3] === "monkey") { if (serial === "P1") return "Events injected: 1"; throw Object.assign(new Error("No activities found to run, monkey aborted."), { code: "ADB_FAILED" }); }
    if (command === "exec-out") return as === "buffer" ? Buffer.alloc(200, 1) : "";
    return "";
  };
  const states = [];
  const batch = createPhoneBatch({ adbPath: "adb", screenshotDir: dir, adb, paste: (serial) => serial === "P1", onState: (state) => states.push(state), now: () => new Date(2026, 9, 30, 19, 5, 0) });
  assert.throws(() => batch.start({ kind: "install", serials: [] }), /先勾选/);
  assert.throws(() => batch.start({ kind: "install", serials: ["P1"], options: { apk: path.join(dir, "nope.apk") } }), /apk/);

  const install = batch.start({ kind: "install", serials: ["P1", "P2", "P3"], options: { apk } });
  assert.throws(() => batch.start({ kind: "key", serials: ["P1"], options: { key: "home" } }), /还没做完/);
  while (!states.some((state) => state?.waitingUser === 1)) await new Promise((resolve) => setTimeout(resolve, 100));
  const asking = states.find((state) => state.waitingUser === 1);
  assert.match(asking.results.find((item) => item.serial === "P3").hint, /继续/);
  assert.match(batchActivity(asking).detail, /等你在手机上确认安装/);
  prompt = false;
  const installed = await install.finished;
  assert.deepEqual(installed.results.map((item) => [item.serial, item.status, item.error, item.hint]),
    [["P1", "done", "", ""], ["P2", "failed", "手机空间不够", ""], ["P3", "done", "", ""]]);
  assert.equal(installed.running, false); assert.equal(installed.failed, 1);
  assert.equal(batchActivity(installed), null, "做完小玺不再显示进度");
  assert.match(batchSummary(installed).text, /2 部做好，1 部没成/);

  const opened = await batch.start({ kind: "open", serials: ["P1", "P2"], options: { pkg: "com.ss.android.ugc.aweme", appName: "抖音" } }).finished;
  assert.equal(opened.label, "打开 抖音");
  assert.deepEqual(opened.results.map((item) => item.error), ["", "这部手机上没装这个 App"]);
  assert.throws(() => batch.start({ kind: "open", serials: ["P1"], options: { pkg: "rm -rf /" } }), /包名/);

  const text = await batch.start({ kind: "text", serials: ["P1", "P2"], options: { text: "大家好" } }).finished;
  assert.deepEqual(text.results.map((item) => item.status), ["done", "failed"], "没开画面的手机发不了文字，要说清楚");

  const shots = await batch.start({ kind: "screenshot", serials: ["P1", "P2"], options: { names: { P1: "1 号 抖音:主号", P2: "2 号" } } }).finished;
  assert.equal(shots.folder, path.join(dir, "20261030-190500"));
  assert.deepEqual(fs.readdirSync(shots.folder).sort(), ["1_号_抖音_主号.png", "2_号.png"]);

  const media = path.join(dir, "成片 1.mp4"); fs.writeFileSync(media, "v");
  calls.length = 0;
  await batch.start({ kind: "media", serials: ["P1"], options: { files: [media, path.join(dir, "notes.txt")] } }).finished;
  assert.deepEqual(calls, ["-s P1 push " + media + " /sdcard/DCIM/Xiaoxi/成片 1.mp4",
    "-s P1 shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/DCIM/Xiaoxi/%E6%88%90%E7%89%87%201.mp4"], "传到相册后让图库马上能看到");
  console.log("phone screens self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });
