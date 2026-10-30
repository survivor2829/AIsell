// The live screens of 手机矩阵: a small stream for every phone on the wall, a sharp one for the
// phone opened as the main screen, and input sent to that phone or, with 同步 on, to every selected
// phone at the same relative spot (each phone scales it to its own screen).
const path = require("node:path");
const { createPhoneStream } = require("./phone-stream.cjs");

// Ports go round a range instead of being reused at once: a stopped stream removes its adb forward a
// moment later, which would remove the forward of a new stream on the same port (2026-10-30).
const FIRST_PORT = 27300;
const PORT_RANGE = 1500;
const START_CONCURRENCY = 4;
const RESTART_DELAY_MS = 2500;

function createPhoneScreens({ adbPath, serverPath, send, createStream = createPhoneStream, setTimer = setTimeout, now = Date.now, random = Math.random }) {
  const sessions = new Map(); // serial -> { stream, quality, starting }
  let wanted = new Map();      // serial -> quality
  let nextPort = 0;
  const takePort = () => FIRST_PORT + (nextPort++ % PORT_RANGE);
  let queue = Promise.resolve();
  // 随机延迟: each following phone waits its own while for one gesture (press, drags, release keep
  // the same wait so the stroke stays whole); the main phone (first target) never waits.
  const gestureDelay = new Map();

  function open(serial, quality) {
    const port = takePort();
    const entry = { quality, port, startedAt: now(), stream: null };
    const stream = createStream({ serial, adbPath, serverPath, port, quality,
      onSession: (size) => send("phone-matrix:screen", { serial, type: "size", width: size.width, height: size.height }),
      onPacket: (packet) => send("phone-matrix:screen", { serial, type: packet.config ? "config" : "frame", key: packet.key, data: packet.data }),
      onClose: (reason, detail = "") => {
        if (sessions.get(serial) === entry) sessions.delete(serial);
        send("phone-matrix:screen", { serial, type: "closed", reason, detail: String(detail).slice(-600) });
        // A phone still on the wall reconnects by itself (it was unplugged and back, or the stream dropped).
        if (reason !== "stopped" && wanted.has(serial)) setTimer(() => sync(), RESTART_DELAY_MS);
      } });
    entry.stream = stream;
    sessions.set(serial, entry);
    return stream.start().catch(() => { /* onClose has cleaned up; the wall shows it as not connected. */ });
  }

  // Bring the running streams in line with what the page shows.
  function sync() {
    for (const [serial, entry] of [...sessions]) {
      if (wanted.get(serial) !== entry.quality) { sessions.delete(serial); entry.stream.stop("stopped"); }
    }
    const missing = [...wanted].filter(([serial]) => !sessions.has(serial));
    queue = queue.then(async () => {
      for (let i = 0; i < missing.length; i += START_CONCURRENCY) {
        await Promise.all(missing.slice(i, i + START_CONCURRENCY).filter(([serial]) => wanted.has(serial) && !sessions.has(serial)).map(([serial, quality]) => open(serial, quality)));
      }
    });
    return queue;
  }

  return {
    // serials: the phones on the wall; main: the one opened large (sharper stream) or "".
    watch({ serials = [], main = "" } = {}) {
      wanted = new Map(serials.map((serial) => [String(serial), String(serial) === main ? "main" : "tile"]));
      if (main && !wanted.has(main)) wanted.set(main, "main");
      return sync();
    },
    // One input to the main phone, or with sync to all targets. Positions are 0–1 of the screen.
    // jitterMs: the most a following phone may lag behind, so the phones do not move in lockstep.
    input({ targets = [], kind, action, x, y, keycode, text, on, jitterMs = 0 } = {}) {
      [...new Set(targets)].forEach((serial, index) => {
        const apply = () => {
          const stream = sessions.get(serial)?.stream;
          if (!stream) return;
          if (kind === "touch") {
            const size = stream.size();
            if (size) stream.touch(action, Math.max(0, Math.min(1, x)) * size.width, Math.max(0, Math.min(1, y)) * size.height);
          } else if (kind === "key") stream.key(keycode);
          else if (kind === "text") stream.paste(text);
          else if (kind === "screen") stream.screen(on);
        };
        let wait = 0;
        if (index > 0 && jitterMs > 0) {
          if (kind !== "touch" || action === 0 || !gestureDelay.has(serial)) gestureDelay.set(serial, Math.round(random() * Math.min(jitterMs, 5000)));
          wait = gestureDelay.get(serial);
        }
        if (wait) setTimer(apply, wait); else apply();
      });
    },
    // Text to one phone through its open screen; false when that phone has no screen running.
    paste(serial, text) { const stream = sessions.get(serial)?.stream; if (!stream) return false; stream.paste(text); return true; },
    running: () => [...sessions.entries()].map(([serial, entry]) => ({ serial, quality: entry.quality })),
    stopAll() { wanted = new Map(); for (const [serial, entry] of [...sessions]) { sessions.delete(serial); entry.stream.stop("stopped"); } }
  };
}

const serverPathIn = (vendorDir) => path.join(vendorDir, "scrcpy-server");

module.exports = { createPhoneScreens, serverPathIn };
