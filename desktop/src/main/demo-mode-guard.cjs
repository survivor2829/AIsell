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
// Within a feature area: what only reads, shows or navigates.
const READ_WORDS = new Set(["status", "list", "get", "show", "reveal", "open", "read", "summary", "state", "catalog", "presets",
  "preview", "estimate", "calculate", "cost", "usage", "sprite", "floating", "main", "walk", "drag", "dock", "close", "probe",
  "refresh", "check", "validate", "personas", "tracks", "announcements", "examples", "history", "pending", "acknowledge",
  // Stopping is always allowed (nothing can start in a trial, but stopping must never be refused).
  "pause", "stop", "cancel", "restart", "url"]);

function blocksInTrial(channel, payload) {
  const text = String(channel || "");
  const colon = text.indexOf(":");
  if (colon < 0) return false;
  const area = text.slice(0, colon);
  if (OPEN_AREAS.has(area)) return false;
  // Business workbenches route every action through one channel and name it in the payload.
  const action = text.endsWith(":invoke") && payload && typeof payload === "object" ? String(payload.action || "") : text.slice(colon + 1);
  const words = action.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  return !words.some((word) => READ_WORDS.has(word));
}

// Wraps ipcMain.handle once, before any feature registers. isDemo is read on every call, so signing
// in or out of the trial takes effect at once.
function installDemoModeGuard(ipcMain, { isDemo = () => false, onBlocked = () => {} } = {}) {
  if (ipcMain.__xiaoxiDemoGuard) return;
  ipcMain.__xiaoxiDemoGuard = true;
  const original = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => original(channel, async (event, payload, ...rest) => {
    let demo = false;
    try { demo = isDemo() === true; } catch { demo = false; }
    if (demo && blocksInTrial(channel, payload)) {
      try { onBlocked(channel); } catch { /* the reply below still goes out */ }
      return { ok: false, demo: true, code: "demo_account", error: DEMO_TEXT, authorized: undefined };
    }
    return listener(event, payload, ...rest);
  });
}

module.exports = { installDemoModeGuard, blocksInTrial, DEMO_TEXT };
