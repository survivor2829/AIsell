// One live screen of one phone for 手机矩阵, through the open-source scrcpy server (v5.0.1, Apache
// 2.0, vendor/scrcpy). The server is pushed to the phone and started with app_process; this side
// opens the forward tunnel, reads the H.264 stream from the video socket and writes touch / key /
// clipboard messages to the control socket. The wire format follows scrcpy 5.0.1 exactly
// (doc/develop.md "Protocol", app/src/control_msg.c) and changes with the server version.
const net = require("node:net");
const { spawn } = require("node:child_process");

const SERVER_VERSION = "5.0.1";
// The server deletes its own file when it runs with cleanup, so every start pushes a copy of its own
// (two sessions of one phone, a tile and the main screen, overlap while switching) (2026-10-30).
const devicePathFor = (scid) => `/data/local/tmp/xiaoxi-scrcpy-${scid}.jar`;
const POINTER_ID_FINGER = 0xfffffffffffffffen; // SC_POINTER_ID_GENERIC_FINGER
const MSG = { KEYCODE: 0, TOUCH: 2, BACK_OR_SCREEN_ON: 4, SET_CLIPBOARD: 9, SET_DISPLAY_POWER: 10 };
const QUALITY = { tile: { maxSize: 480, maxFps: 12, bitRate: 800_000 }, main: { maxSize: 1280, maxFps: 30, bitRate: 6_000_000 } };

// Reads session packets (video size) and media packets (H.264 access units) from the video socket.
function createVideoParser({ onMeta, onSession, onPacket }) {
  let buffer = Buffer.alloc(0), stage = "dummy";
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (stage === "dummy") { if (buffer.length < 1) return; buffer = buffer.subarray(1); stage = "meta"; }
      if (stage === "meta") {
        if (buffer.length < 68) return;
        const name = buffer.subarray(0, 64).toString("utf8").replace(/\0.*$/s, "");
        const codec = buffer.readUInt32BE(64);
        onMeta({ name, codec });
        buffer = buffer.subarray(68); stage = "packets";
      }
      if (buffer.length < 12) return;
      const head = buffer.readBigUInt64BE(0);
      if (head & (1n << 63n)) { // session packet: video size of this capture session
        onSession({ width: buffer.readUInt32BE(4), height: buffer.readUInt32BE(8) });
        buffer = buffer.subarray(12);
        continue;
      }
      const size = buffer.readUInt32BE(8);
      if (buffer.length < 12 + size) return;
      onPacket({ config: Boolean(head & (1n << 62n)), key: Boolean(head & (1n << 61n)), pts: Number(head & ((1n << 61n) - 1n)), data: buffer.subarray(12, 12 + size) });
      buffer = buffer.subarray(12 + size);
    }
  };
}

// Control messages (scrcpy 5.0.1 app/src/control_msg.c sc_control_msg_serialize).
function touchMessage(action, x, y, width, height, pressure = action === 1 ? 0 : 1) {
  const buf = Buffer.alloc(32);
  buf[0] = MSG.TOUCH; buf[1] = action;
  buf.writeBigUInt64BE(POINTER_ID_FINGER, 2);
  buf.writeInt32BE(Math.round(x), 10); buf.writeInt32BE(Math.round(y), 14);
  buf.writeUInt16BE(width, 18); buf.writeUInt16BE(height, 20);
  buf.writeUInt16BE(pressure >= 1 ? 0xffff : Math.round(pressure * 0x10000), 22);
  buf.writeInt32BE(0, 24); buf.writeInt32BE(0, 28);
  return buf;
}
function keyMessage(action, keycode, repeat = 0, metastate = 0) {
  const buf = Buffer.alloc(14);
  buf[0] = MSG.KEYCODE; buf[1] = action;
  buf.writeInt32BE(keycode, 2); buf.writeInt32BE(repeat, 6); buf.writeInt32BE(metastate, 10);
  return buf;
}
// Chinese and other text go through the phone's clipboard and a paste, which needs no input method.
function pasteMessage(text, sequence = 0n) {
  const body = Buffer.from(String(text).slice(0, 2000), "utf8");
  const buf = Buffer.alloc(14 + body.length);
  buf[0] = MSG.SET_CLIPBOARD; buf.writeBigUInt64BE(BigInt(sequence), 1); buf[9] = 1;
  buf.writeUInt32BE(body.length, 10); body.copy(buf, 14);
  return buf;
}
const displayPowerMessage = (on) => Buffer.from([MSG.SET_DISPLAY_POWER, on ? 1 : 0]);
const backOrScreenOnMessage = (action) => Buffer.from([MSG.BACK_OR_SCREEN_ON, action]);

// as "buffer" gives the raw bytes (a screenshot); otherwise the text adb printed.
function runAdb(adbPath, args, timeout = 15000, as = "text") {
  return new Promise((resolve, reject) => {
    const child = spawn(adbPath, args, { windowsHide: true });
    const chunks = [];
    let err = "";
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error("adb timed out"), { code: "ADB_TIMEOUT" })); }, timeout);
    child.stdout.on("data", (d) => { chunks.push(d); });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks), out = raw.toString("utf8");
      if (code === 0) resolve(as === "buffer" ? raw : out); else reject(Object.assign(new Error(err || out || `adb exited ${code}`), { code: "ADB_FAILED" })); });
  });
}

function createPhoneStream({ serial, adbPath, serverPath, port, quality = "tile", onMeta = () => {}, onSession = () => {}, onPacket = () => {}, onClose = () => {}, adb = (args, timeout) => runAdb(adbPath, args, timeout) }) {
  const settings = QUALITY[quality] || QUALITY.tile;
  const scid = (Math.floor(Math.random() * 0x7fffffff) >>> 0).toString(16).padStart(8, "0");
  let server = null, video = null, control = null, closed = false, size = null, output = "";

  async function start() {
    const devicePath = devicePathFor(scid);
    await adb(["-s", serial, "push", serverPath, devicePath], 30000);
    await adb(["-s", serial, "forward", `tcp:${port}`, `localabstract:scrcpy_${scid}`]);
    server = spawn(adbPath, ["-s", serial, "shell", `CLASSPATH=${devicePath}`, "app_process", "/", "com.genymobile.scrcpy.Server", SERVER_VERSION,
      `scid=${scid}`, "log_level=warn", "audio=false", "tunnel_forward=true", `max_size=${settings.maxSize}`, `max_fps=${settings.maxFps}`,
      `video_bit_rate=${settings.bitRate}`, "stay_awake=true", "clipboard_autosync=false", "power_off_on_close=false", "cleanup=true"], { windowsHide: true });
    // The server's own words say why a stream ends (encoder busy, phone locked…); kept for the close reason.
    const keep = (chunk) => { output = (output + chunk).slice(-1500); };
    server.stdout.on("data", keep); server.stderr.on("data", keep);
    server.on("close", () => stop("server_exited"));
    server.on("error", () => stop("server_failed"));
    // The forward tunnel accepts a connection even before the server listens; the dummy byte
    // tells a real one, so connecting is retried until it arrives.
    for (let attempt = 0; attempt < 30 && !closed; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, attempt ? 250 : 400));
      const socket = await connect(port).catch(() => null);
      if (!socket) continue;
      const first = await firstByte(socket, 1500);
      if (first === null) { socket.destroy(); continue; }
      video = socket;
      control = await connect(port);
      const parse = createVideoParser({ onMeta, onSession: (s) => { size = s; onSession(s); }, onPacket });
      parse(first);
      video.on("data", parse);
      video.on("close", () => stop("video_closed"));
      control.on("close", () => stop("control_closed"));
      control.on("data", () => { /* Device messages (clipboard echoes) are not used. */ });
      return;
    }
    stop("connect_failed");
    throw Object.assign(new Error("手机画面没连上"), { code: "PHONE_STREAM_FAILED" });
  }

  function send(buf) { if (control && !control.destroyed) control.write(buf); }
  function stop(cause = "stopped") {
    if (closed) return;
    closed = true;
    try { video?.destroy(); } catch { /* already gone */ }
    try { control?.destroy(); } catch { /* already gone */ }
    try { server?.kill(); } catch { /* already gone */ }
    void adb(["-s", serial, "forward", "--remove", `tcp:${port}`]).catch(() => {});
    onClose(cause, output.trim());
  }

  return {
    serial, quality, start, stop,
    size: () => size,
    // x, y in the video frame's pixels; the server scales them to the phone's screen.
    touch(action, x, y) { if (size) send(touchMessage(action, x, y, size.width, size.height)); },
    key(keycode) { send(keyMessage(0, keycode)); send(keyMessage(1, keycode)); },
    paste(text) { send(pasteMessage(text)); },
    screen(on) { if (on) { send(backOrScreenOnMessage(0)); send(backOrScreenOnMessage(1)); } else send(displayPowerMessage(false)); }
  };
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => { socket.setNoDelay(true); resolve(socket); });
    socket.once("error", reject);
  });
}
function firstByte(socket, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(null); }, timeout);
    const onData = (chunk) => { cleanup(); resolve(chunk); };
    const onEnd = () => { cleanup(); resolve(null); };
    const cleanup = () => { clearTimeout(timer); socket.off("data", onData); socket.off("close", onEnd); socket.off("end", onEnd); };
    socket.on("data", onData); socket.once("close", onEnd); socket.once("end", onEnd);
  });
}

module.exports = { createPhoneStream, createVideoParser, touchMessage, keyMessage, pasteMessage, runAdb, QUALITY, SERVER_VERSION };
