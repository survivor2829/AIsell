// What the automation of 手机矩阵 does on a phone, without any app on it: read the screen, act on it,
// and run one task per phone that can be stopped and leaves its steps and screenshots behind.
// 抖音 publishing and the AI worker are both built on this.
const fs = require("node:fs");
const path = require("node:path");
const { runAdb } = require("./phone-stream.cjs");

const UI_FILE = "/data/local/tmp/xiaoxi_ui.xml";
const MAX_STEPS = 300, KEEP_TASK_FOLDERS = 20;
const fail = (code, message) => Object.assign(new Error(message), { code });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decode(value) {
  return String(value).replace(/&#10;/g, "\n").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// `uiautomator dump` output: one record per on-screen element, with its centre to tap.
function parseUi(xml) {
  return [...String(xml || "").matchAll(/<node\b[^>]*>/g)].map(([tag]) => {
    const attr = (name) => decode((tag.match(new RegExp(`\\s${name}="([^"]*)"`)) || [])[1] || "");
    const box = attr("bounds").match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    const [left, top, right, bottom] = box ? box.slice(1).map(Number) : [0, 0, 0, 0];
    return { text: attr("text"), desc: attr("content-desc"), id: attr("resource-id").split("/").pop(), pkg: attr("package"),
      clickable: attr("clickable") === "true", enabled: attr("enabled") !== "false", checked: attr("checked") === "true", selected: attr("selected") === "true",
      left, top, right, bottom, x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
  });
}

// The first element matching { text, desc, id }: a string means equal, a RegExp means a match.
function findNode(nodes, match) {
  const fits = (want, value) => want === undefined || (want instanceof RegExp ? want.test(value) : want === value);
  return nodes.find((node) => node.right > node.left && node.bottom > node.top && fits(match.text, node.text) && fits(match.desc, node.desc) && fits(match.id, node.id)) || null;
}

// mCurrentFocus names the window in front; it is null for a moment while windows change.
function parseFocus(text) {
  const line = String(text || "").match(/mCurrentFocus=(.*)/)?.[1] || "";
  const named = line.match(/\s([\w.]+)\/([\w.$]+)\}/);
  if (named) return { pkg: named[1], activity: named[2], window: named[1] };
  return { pkg: "", activity: "", window: line.match(/\s(\S+)\}/)?.[1] || "" };
}

function createPhoneDevice({ serial, adb = (args, timeout, as) => runAdb("adb", args, timeout, as), paste = async () => false, checkStop = () => {}, sleep = delay, now = Date.now }) {
  const run = (args, timeout, as) => { checkStop(); return adb(["-s", serial, ...args], timeout, as); };
  const shell = (...words) => run(["shell", ...words]);
  const device = {
    serial,
    async foreground() { return parseFocus(await shell("dumpsys", "window", "displays")); },
    // The status bar holding focus means the phone sits on its lock screen.
    async isLocked() { return (await device.foreground()).window === "StatusBar"; },
    // The old file goes first: a failed dump leaves it behind and would be read as the current screen.
    async read() {
      await shell("rm", "-f", UI_FILE);
      const said = await shell("uiautomator", "dump", UI_FILE).catch((error) => String(error.message));
      if (!/dumped to/.test(said)) return { ok: false, nodes: [] }; // A playing video keeps the screen from going idle.
      const nodes = parseUi(await run(["exec-out", "cat", UI_FILE]));
      return { ok: nodes.length > 0, nodes };
    },
    screenshot() { return run(["exec-out", "screencap", "-p"], 20000, "buffer"); },
    tap(x, y) { return shell("input", "tap", String(Math.round(x)), String(Math.round(y))); },
    swipe(x1, y1, x2, y2, ms = 300) { return shell("input", "swipe", ...[x1, y1, x2, y2, ms].map((value) => String(Math.round(value)))); },
    key(code) { return shell("input", "keyevent", String(code)); },
    wake() { return device.key(224); },
    async openApp(pkg) {
      const said = await shell("monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1").catch((error) => String(error.message));
      if (!/Events injected:\s*1/.test(said)) throw fail("PHONE_APP_MISSING", "这部手机上没装这个 App");
    },
    // Text goes through the clipboard of a screen stream, which takes Chinese whatever the input method.
    async paste(text) {
      checkStop();
      if (!await paste(serial, String(text))) throw fail("PHONE_PASTE_FAILED", "文字没能发到手机");
    },
    // Reads until the element shows up; null when it has not within the time.
    async waitFor(match, { timeout = 15000, every = 1000 } = {}) {
      const end = now() + timeout;
      for (;;) {
        const node = findNode((await device.read()).nodes, match);
        if (node) return node;
        if (now() >= end) return null;
        await sleep(every);
      }
    },
    async tapOn(match, options) {
      const node = await device.waitFor(match, options);
      if (node) await device.tap(node.x, node.y);
      return node;
    }
  };
  return device;
}

// One task at a time per phone. A stop takes effect at the task's next phone action.
function createPhoneTasks({ dir, adb, paste, onChange = () => {}, sleep = delay, now = () => new Date() }) {
  const tasks = new Map(); // serial -> the phone's latest task
  let nextId = 1;
  const view = ({ stopping, ...task }) => ({ ...task, stopping: Boolean(stopping), steps: task.steps.map((step) => ({ ...step })) });
  const snapshot = () => [...tasks.values()].map(view);
  const changed = () => onChange(snapshot());

  function start(serial, label, work) {
    if (tasks.get(serial)?.status === "running") throw fail("PHONE_TASK_BUSY", "这部手机还有任务在跑，等它做完或先停下。");
    const task = { id: `${now().getTime()}-${nextId++}`, serial, label: String(label), status: "running", stopping: false, startedAt: now().toISOString(), finishedAt: "", error: "", steps: [] };
    tasks.set(serial, task);
    const folder = dir ? path.join(dir, task.id) : "";
    const checkStop = () => { if (task.stopping) throw fail("PHONE_TASK_STOPPED", "已停下"); };
    const device = createPhoneDevice({ serial, adb, paste, checkStop, sleep });
    // A step the user can read on the wall, with what the phone looked like when it happened.
    const step = async (text, { shot = false } = {}) => {
      const entry = { at: now().toISOString(), text: String(text), image: "" };
      task.steps.push(entry);
      if (task.steps.length > MAX_STEPS) task.steps.shift();
      if (shot && folder) {
        const png = await device.screenshot();
        fs.mkdirSync(folder, { recursive: true });
        entry.image = path.join(folder, `${String(task.steps.length).padStart(3, "0")}.png`);
        fs.writeFileSync(entry.image, png);
      }
      changed();
      return entry;
    };
    changed();
    const finished = Promise.resolve().then(() => work({ device, step, checkStop, task })).then((value) => {
      task.status = "done"; return value;
    }, (error) => {
      task.status = error?.code === "PHONE_TASK_STOPPED" ? "stopped" : "failed";
      task.error = /^PHONE_/.test(String(error?.code || "")) ? error.message : "没做成";
      return undefined;
    }).then((value) => {
      task.finishedAt = now().toISOString(); task.stopping = false;
      changed();
      if (dir) pruneFolders(dir);
      return { result: value, task: view(task) };
    });
    return { task: view(task), finished };
  }

  return {
    start,
    stop(serial) { const task = tasks.get(serial); if (task?.status === "running") { task.stopping = true; changed(); } return snapshot(); },
    stopAll() { for (const task of tasks.values()) if (task.status === "running") task.stopping = true; changed(); return snapshot(); },
    isBusy: () => [...tasks.values()].some((task) => task.status === "running"),
    snapshot
  };
}

// Old task screenshots go; the newest folders stay for looking back at what happened.
function pruneFolders(dir) {
  try {
    const folders = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, at: fs.statSync(path.join(dir, entry.name)).mtimeMs })).sort((a, b) => b.at - a.at);
    for (const old of folders.slice(KEEP_TASK_FOLDERS)) fs.rmSync(path.join(dir, old.name), { recursive: true, force: true });
  } catch { /* Screenshots of old tasks are not worth failing a task over. */ }
}

module.exports = { createPhoneDevice, createPhoneTasks, parseUi, findNode, parseFocus };
