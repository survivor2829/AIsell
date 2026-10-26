const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const fail = (code, message) => Object.assign(new Error(message), { code });

// The user's own Chrome (or Edge) runs each platform account in its own profile
// directory. Douyin's login refuses embedded browsers, and a real browser needs
// no fingerprint disguise. Control goes over --remote-debugging-pipe, so no
// port is opened and nothing attaches to a page unless a feature asks for it.
function findBrowser(env = process.env, exists = fs.existsSync) {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean);
  const candidates = [
    ...roots.map((root) => path.join(root, "Google", "Chrome", "Application", "chrome.exe")),
    ...roots.map((root) => path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"))
  ];
  return candidates.find((file) => exists(file)) || "";
}

function launchBrowser({ executable, profileDir, url = "about:blank", headless = false, spawnProcess = spawn }) {
  if (!executable) throw fail("SOCIAL_BROWSER_MISSING", "没有找到 Chrome 或 Edge 浏览器，请先安装 Chrome 后再登录平台账号。");
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [`--user-data-dir=${profileDir}`, "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check",
    "--disable-features=Translate", ...(headless ? ["--headless=new"] : ["--window-size=1180,820"]), url];
  const child = spawnProcess(executable, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: headless });
  const writer = child.stdio[3], reader = child.stdio[4];
  const waiting = new Map(), listeners = new Set();
  let nextId = 0, buffer = "", exited = false;
  const closed = new Promise((resolve) => child.once("exit", () => {
    exited = true;
    for (const reject of waiting.values()) reject(fail("SOCIAL_BROWSER_CLOSED", "浏览器已关闭。"));
    waiting.clear(); resolve();
  }));
  child.once("error", () => { exited = true; for (const reject of waiting.values()) reject(fail("SOCIAL_BROWSER_MISSING", "浏览器无法启动，请确认 Chrome 已正确安装。")); waiting.clear(); });
  reader.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      let message; try { message = JSON.parse(buffer.slice(0, end)); } catch { message = null; }
      buffer = buffer.slice(end + 1);
      if (!message) continue;
      if (message.id && waiting.has(message.id)) {
        const settle = waiting.get(message.id); waiting.delete(message.id);
        settle(message.error ? fail("SOCIAL_BROWSER_PROTOCOL", message.error.message || "浏览器没有响应。") : null, message.result);
      } else for (const listener of listeners) { try { listener(message); } catch {} }
    }
  });
  reader.on("error", () => {}); writer.on("error", () => {});
  // Every call has a deadline: a page blocked by a dialog or a hung renderer must not hang the caller.
  function send(method, params = {}, sessionId, timeoutMs = 30_000) {
    if (exited) return Promise.reject(fail("SOCIAL_BROWSER_CLOSED", "浏览器已关闭。"));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { if (waiting.delete(id)) reject(fail("SOCIAL_BROWSER_TIMEOUT", "浏览器长时间没有响应。")); }, timeoutMs);
      timer.unref?.();
      waiting.set(id, (error, result) => { clearTimeout(timer); return error ? reject(error) : resolve(result); });
      writer.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }
  async function close() {
    if (exited) return;
    await Promise.race([send("Browser.close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))]);
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (!exited) child.kill();
  }
  return { send, close, closed, isClosed: () => exited, onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}

module.exports = { findBrowser, launchBrowser };
