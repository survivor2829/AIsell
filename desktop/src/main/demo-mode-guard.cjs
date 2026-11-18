// 免费体验 (user decision 2026-11-18): the shared trial account can look at every example but cannot
// use the features. Paid work is refused by the gateway too; this also stops the free local ones
// (WeChat outreach, keyword and map acquisition, phone matrix, imports). The rule is an allowlist:
// in a feature area only requests that read or show something pass, everything else is answered
// with one friendly line. Areas outside the features (account, feedback, updates, tutorials,
// official materials, the window itself) are never touched.
const DEMO_TEXT = "这是体验账号，只能看示例。开通正式账号后就能使用这个功能，请联系顾问开通。";

// Never limited: signing in and out, feedback, updates, help and the window.
const OPEN_AREAS = new Set(["account", "license-auth", "feedback", "cloud", "maintenance", "update", "diagnostics", "tutorials",
  "official-materials", "role-preferences", "window-chrome", "startup", "announcements"]);
// Within a feature area: what only reads or shows something in this app. Not "open" (it also opens
// platform browsers and chats), not "validate" (sends a key to a provider), not "acknowledge".
const READ_WORDS = new Set(["status", "list", "get", "show", "reveal", "read", "summary", "state", "catalog", "presets",
  "preview", "estimate", "calculate", "cost", "usage", "sprite", "floating", "main", "walk", "drag", "dock", "close", "probe",
  "personas", "tracks", "announcements", "examples", "history", "pending", "snapshot", "watch", "conversation", "finished",
  // Stopping is always allowed (nothing can start in a trial, but stopping must never be refused).
  "pause", "stop", "cancel", "restart", "url"]);
// Only a refused request that is clearly someone using a feature brings up the advisor's card; a
// page reading something unusual on load is refused quietly.
const ACTION_WORDS = new Set(["start", "run", "resume", "continue", "retry", "confirm", "generate", "create", "import", "choose",
  "add", "save", "publish", "upload", "sync", "send", "submit", "render", "export", "download", "install", "input", "chat",
  "invoke", "regenerate", "repackage", "package", "queue", "record", "capture", "now", "apply", "connect", "open"]);

// Workbench channels ("geo:invoke", "map-acquisition:invoke") name the action in their first argument.
function actionOf(channel, args) {
  const text = String(channel || "");
  const colon = text.indexOf(":");
  if (!text.endsWith(":invoke")) return text.slice(colon + 1);
  const first = args[0];
  return typeof first === "string" ? first : first && typeof first === "object" ? String(first.action || "") : "";
}

function wordsOf(action) {
  return String(action || "").toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
}

function blocksInTrial(channel, ...args) {
  const text = String(channel || "");
  const colon = text.indexOf(":");
  if (colon < 0) return false;
  if (OPEN_AREAS.has(text.slice(0, colon))) return false;
  const words = wordsOf(actionOf(text, args));
  // An action word always wins ("open-conversation" opens a chat even though it names one).
  if (words.some((word) => ACTION_WORDS.has(word))) return true;
  return !words.some((word) => READ_WORDS.has(word));
}

function promptsAdvisor(channel, ...args) {
  return wordsOf(actionOf(channel, args)).some((word) => ACTION_WORDS.has(word));
}

// Wraps ipcMain.handle and ipcMain.on once, before any feature registers. isDemo is read on every
// call, so signing in or out of the trial takes effect at once.
function installDemoModeGuard(ipcMain, { isDemo = () => false, onBlocked = () => {} } = {}) {
  if (ipcMain.__xiaoxiDemoGuard) return;
  ipcMain.__xiaoxiDemoGuard = true;
  const refused = (channel, args) => {
    let demo = false;
    try { demo = isDemo() === true; } catch { demo = false; }
    if (!demo || !blocksInTrial(channel, ...args)) return false;
    if (promptsAdvisor(channel, ...args)) { try { onBlocked(channel); } catch { /* the refusal stands */ } }
    return true;
  };
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => handle(channel, async (event, ...args) => (refused(channel, args)
    ? { ok: false, demo: true, code: "demo_account", error: DEMO_TEXT }
    : listener(event, ...args)));
  // One-way messages (phone-matrix:input sends touches to phones) are dropped in the trial.
  const on = ipcMain.on.bind(ipcMain);
  ipcMain.on = (channel, listener) => on(channel, (event, ...args) => { if (!refused(channel, args)) listener(event, ...args); });
}

module.exports = { installDemoModeGuard, blocksInTrial, promptsAdvisor, DEMO_TEXT };
