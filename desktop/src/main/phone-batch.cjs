// 手机矩阵 batch actions: one action on every chosen phone, a few phones at a time, each phone's
// result kept on its own. One batch runs at a time; stopping it lets the running phones finish and
// starts no more. Everything here goes through adb, so it works whether or not a screen is open.
const fs = require("node:fs");
const path = require("node:path");
const { runAdb } = require("./phone-stream.cjs");

const CONCURRENCY = 6;
const MEDIA_DIR = "/sdcard/DCIM/Xiaoxi";
// Android key codes for the batch buttons.
const KEYS = { home: 3, back: 4, volume_up: 24, volume_down: 25, wake: 224, sleep: 223 };
const KEY_LABEL = { home: "回到桌面", back: "返回", volume_up: "音量加", volume_down: "音量减", wake: "亮屏", sleep: "息屏" };
const MEDIA_EXT = /\.(mp4|mov|m4v|3gp|webm|jpg|jpeg|png|gif|webp|heic)$/i;
const PACKAGE = /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/;
// Huawei / Honor and some others ask on the phone before an app from a computer goes in; the batch
// waits for the user instead of tapping the phone's safety prompt itself (2026-10-30).
const INSTALL_PROMPT = /packageinstaller/i;
const INSTALL_WAIT_MS = 10 * 60 * 1000;
const NEEDS_TAP = "手机上弹了安装确认，请按手机上的提示点「继续」「继续安装」（可在大画面打开同步操作一起点）。想以后不再弹：手机「开发人员选项」里关掉「监控 ADB 安装应用」";

const stamp = (date) => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}-${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`;
const safeName = (name) => String(name || "").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "phone";
const failure = (message, code = "PHONE_BATCH_FAILED") => Object.assign(new Error(message), { code });

function createPhoneBatch({ adbPath, screenshotDir, paste = () => false, onState = () => {}, adb = (args, timeout, as) => runAdb(adbPath, args, timeout, as), now = () => new Date() }) {
  let current = null; // { id, kind, label, total, done, failed, results, running, stopping, startedAt, folder }
  let nextId = 1;

  const snapshot = () => current && { ...current, results: current.results.map((item) => ({ ...item })) };
  const emit = () => onState(snapshot());

  // What one phone does for each kind of batch.
  const steps = {
    async install(serial, { apk }, { note }) {
      let done = false;
      const watching = (async () => {
        while (!done) {
          await new Promise((resolve) => setTimeout(resolve, 2500));
          if (done) return;
          const focus = await adb(["-s", serial, "shell", "dumpsys", "window", "displays"], 10000).then((out) => (out.match(/mCurrentFocus=.*/) || [""])[0]).catch(() => "");
          if (!done) note(INSTALL_PROMPT.test(focus) ? NEEDS_TAP : "");
        }
      })();
      try {
        const out = await adb(["-s", serial, "install", "-r", "-g", apk], INSTALL_WAIT_MS);
        if (!/Success/.test(out)) throw failure(installReason(out));
      } catch (error) {
        if (error?.code === "ADB_TIMEOUT") throw failure("等了 10 分钟没装上：手机上的安装确认没人点");
        if (error?.code === "ADB_FAILED") throw failure(installReason(error.message));
        throw error;
      } finally { done = true; await watching; note(""); }
    },
    async media(serial, { files }) {
      for (const file of files) {
        const remote = `${MEDIA_DIR}/${path.basename(file)}`;
        await adb(["-s", serial, "push", file, remote], 600000);
        // The gallery shows the file at once only after the media scanner has seen it.
        await adb(["-s", serial, "shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", `file://${encodeURI(remote)}`]).catch(() => {});
      }
    },
    async open(serial, { pkg }) {
      const out = await adb(["-s", serial, "shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"], 20000).catch((error) => String(error.message));
      if (!/Events injected:\s*1/.test(out)) throw failure("这部手机上没装这个 App");
    },
    async key(serial, { key }) { await adb(["-s", serial, "shell", "input", "keyevent", String(KEYS[key])]); },
    // Text goes through the phone's open screen (clipboard and paste), which takes Chinese.
    async text(serial, { text }) { if (!paste(serial, text)) throw failure("这部手机的画面没连上，先在手机墙上看到它的画面"); },
    async reboot(serial) { await adb(["-s", serial, "reboot"], 20000); },
    async screenshot(serial, { folder, names }) {
      const png = await adb(["-s", serial, "exec-out", "screencap", "-p"], 20000, "buffer");
      if (!Buffer.isBuffer(png) || png.length < 100) throw failure("截图没拿到");
      fs.writeFileSync(path.join(folder, `${names[serial] || safeName(serial)}.png`), png);
    }
  };

  function plan(kind, options = {}) {
    if (kind === "install") {
      const apk = String(options.apk || "");
      if (!/\.apk$/i.test(apk) || !fs.existsSync(apk)) throw failure("请选一个 .apk 安装包。", "PHONE_BATCH_INPUT");
      return { label: `安装 ${path.basename(apk)}`, options: { apk } };
    }
    if (kind === "media") {
      const files = (Array.isArray(options.files) ? options.files : []).map(String).filter((file) => MEDIA_EXT.test(file) && fs.existsSync(file)).slice(0, 50);
      if (!files.length) throw failure("请选要传的视频或图片。", "PHONE_BATCH_INPUT");
      return { label: files.length === 1 ? `传 ${path.basename(files[0])} 到相册` : `传 ${files.length} 个文件到相册`, options: { files } };
    }
    if (kind === "open") {
      const pkg = String(options.pkg || "").trim();
      if (!PACKAGE.test(pkg)) throw failure("App 的包名不对。", "PHONE_BATCH_INPUT");
      return { label: `打开 ${String(options.appName || pkg).slice(0, 20)}`, options: { pkg } };
    }
    if (kind === "key") {
      if (!KEYS[options.key]) throw failure("不认识这个按键。", "PHONE_BATCH_INPUT");
      return { label: KEY_LABEL[options.key], options: { key: options.key } };
    }
    if (kind === "text") {
      const text = String(options.text || "").slice(0, 2000);
      if (!text.trim()) throw failure("先写要发的文字。", "PHONE_BATCH_INPUT");
      return { label: `发文字「${text.length > 12 ? `${text.slice(0, 12)}…` : text}」`, options: { text } };
    }
    if (kind === "reboot") return { label: "重启手机", options: {} };
    if (kind === "screenshot") {
      if (!screenshotDir) throw failure("没有保存截图的位置。", "PHONE_BATCH_INPUT");
      const folder = path.join(screenshotDir, stamp(now()));
      const names = {};
      for (const [serial, name] of Object.entries(options.names || {})) names[serial] = safeName(name);
      return { label: "截图", options: { folder, names }, folder };
    }
    throw failure("不认识这个批量操作。", "PHONE_BATCH_INPUT");
  }

  async function run(entry, serial, options) {
    const result = entry.results.find((item) => item.serial === serial);
    result.status = "running"; emit();
    // note: what the user has to do on this phone right now ("" clears it).
    const note = (text) => { if (result.hint !== text) { result.hint = text; entry.waitingUser = entry.results.filter((item) => item.hint).length; emit(); } };
    try { await steps[entry.kind](serial, options, { note }); result.status = "done"; }
    catch (error) { result.status = "failed"; result.error = /^PHONE_/.test(String(error.code || "")) ? error.message : adbReason(error); entry.failed += 1; }
    entry.done += 1; emit();
  }

  return {
    // Starts a batch on these phones; refused while another one runs.
    start({ kind, serials = [], options = {} } = {}) {
      if (current?.running) throw failure("上一个批量操作还没做完，等它做完或先停下。", "PHONE_BATCH_BUSY");
      const targets = [...new Set(serials.map(String))].filter(Boolean).slice(0, 80);
      if (!targets.length) throw failure("先勾选要操作的手机。", "PHONE_BATCH_INPUT");
      if (!steps[kind]) throw failure("不认识这个批量操作。", "PHONE_BATCH_INPUT");
      const planned = plan(kind, options);
      if (planned.folder) fs.mkdirSync(planned.folder, { recursive: true });
      const entry = current = { id: nextId++, kind, label: planned.label, total: targets.length, done: 0, failed: 0, running: true, stopping: false,
        folder: planned.folder || "", waitingUser: 0, results: targets.map((serial) => ({ serial, status: "waiting", error: "", hint: "" })) };
      emit();
      const queue = [...targets];
      const worker = async () => { while (queue.length && !entry.stopping) await run(entry, queue.shift(), planned.options); };
      const finished = Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker)).then(() => {
        for (const item of entry.results) if (item.status === "waiting") item.status = "skipped";
        entry.running = false; emit();
        return snapshot();
      });
      return { batch: snapshot(), finished };
    },
    stop() { if (current?.running) { current.stopping = true; emit(); } return snapshot(); },
    status: snapshot
  };
}

// adb's own words, turned into something the user can act on.
function installReason(out) {
  if (/INSUFFICIENT_STORAGE/.test(out)) return "手机空间不够";
  if (/VERSION_DOWNGRADE/.test(out)) return "手机上已有更新的版本";
  if (/UPDATE_INCOMPATIBLE|SIGNATURES/.test(out)) return "手机上已有同名 App，签名不同，先卸载旧的";
  if (/USER_RESTRICTED|ABORTED/.test(out)) return "手机拦下了安装，请在手机上点允许，或在设置里打开「USB 安装」";
  if (/NO_CERTIFICATES|INVALID_APK|PARSE/.test(out)) return "安装包坏了或不完整";
  return "没装上";
}
function adbReason(error) {
  const text = String(error?.message || "");
  if (error?.code === "ADB_TIMEOUT") return "手机太久没回应";
  if (/not found|offline|unauthorized|no devices/i.test(text)) return "手机没连上";
  if (/No space|ENOSPC/i.test(text)) return "手机空间不够";
  return "没做成";
}

module.exports = { createPhoneBatch, KEYS, MEDIA_DIR, installReason };
