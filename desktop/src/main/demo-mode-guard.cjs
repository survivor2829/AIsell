// 免费体验 (user decision 2026-11-18): the shared trial account can look at every example but cannot
// use the features. Paid work is refused by the gateway too; this also stops the free local ones
// (WeChat outreach, keyword and map acquisition, phone matrix, imports, platform browsers).
//
// Every request is classified by name in demo-mode-channels.cjs. The first two versions guessed
// from words in the name: they refused reads named by a noun (数字人 showed 「爆款文案库没有读到」)
// and let camelCase or noun-named actions through. A name nobody classified is refused quietly.
// Areas outside the features (account, feedback, updates, tutorials, official materials, the
// window itself) are never touched.
const { READS, QUIET, ACTIONS, WORKBENCH_READS } = require("./demo-mode-channels.cjs");

const DEMO_TEXT = "这是体验账号，只能看示例。开通正式账号后就能使用这个功能，请联系顾问开通。";

// Never limited: signing in and out, feedback, updates, help and the window.
const OPEN_AREAS = new Set(["account", "license-auth", "feedback", "cloud", "maintenance", "update", "diagnostics", "tutorials",
  "official-materials", "role-preferences", "window-chrome", "startup", "announcements"]);

// Workbench channels ("geo:invoke", "map-acquisition:invoke") name the action in their first argument.
function workbenchAction(args) {
  const first = args[0];
  return typeof first === "string" ? first : first && typeof first === "object" ? String(first.action || "") : "";
}

// Where a request name stands: "open" (never limited), "workbench", "read", "quiet", "action", or
// "unclassified" (a feature request nobody classified). The self-check uses this same function.
function classify(channel) {
  const text = String(channel || "");
  const colon = text.indexOf(":");
  if (colon < 0 || OPEN_AREAS.has(text.slice(0, colon))) return "open";
  if (text.endsWith(":invoke")) return "workbench";
  if (READS.has(text)) return "read";
  if (QUIET.has(text)) return "quiet";
  if (ACTIONS.has(text)) return "action";
  return "unclassified";
}

// Turning phone polling or a screen off is stopping, and stopping is never refused.
const STOPS_WITH_ON_FALSE = new Set(["phone-matrix:checkPhones", "phone-matrix:watch"]);

// "pass" | "quiet" (refused without the advisor's card) | "action" (refused with it).
function trialDecision(channel, ...args) {
  const kind = classify(channel);
  if (kind === "open" || kind === "read") return "pass";
  if (kind === "workbench") return WORKBENCH_READS.has(workbenchAction(args)) ? "pass" : "action";
  if (STOPS_WITH_ON_FALSE.has(String(channel)) && args[0] && typeof args[0] === "object" && args[0].on === false) return "pass";
  return kind === "action" ? "action" : "quiet";
}

function blocksInTrial(channel, ...args) { return trialDecision(channel, ...args) !== "pass"; }
function promptsAdvisor(channel, ...args) { return trialDecision(channel, ...args) === "action"; }

// Wraps ipcMain once, before any feature registers. isDemo is read on every call, so signing in or
// out of the trial takes effect at once. A feature request nobody classified (the source scan
// missed it) is reported once when it registers and refused quietly.
function installDemoModeGuard(ipcMain, { isDemo = () => false, onBlocked = () => {}, onUnclassified = () => {} } = {}) {
  if (ipcMain.__xiaoxiDemoGuard) return;
  ipcMain.__xiaoxiDemoGuard = true;
  const reported = new Set();
  const registering = (channel) => {
    if (classify(channel) !== "unclassified" || reported.has(channel)) return;
    reported.add(channel);
    try { onUnclassified(String(channel)); } catch { /* reporting never stops a feature from registering */ }
  };
  const refused = (channel, args) => {
    let demo = false;
    try { demo = isDemo() === true; } catch { demo = false; }
    if (!demo) return false;
    const decision = trialDecision(channel, ...args);
    if (decision === "pass") return false;
    if (decision === "action") { try { onBlocked(channel); } catch { /* the refusal stands */ } }
    return true;
  };
  const answer = (channel, listener) => async (event, ...args) => (refused(channel, args)
    ? { ok: false, demo: true, code: "demo_account", error: DEMO_TEXT }
    : listener(event, ...args));
  for (const name of ["handle", "handleOnce"]) {
    if (typeof ipcMain[name] !== "function") continue;
    const original = ipcMain[name].bind(ipcMain);
    ipcMain[name] = (channel, listener) => { registering(channel); return original(channel, answer(channel, listener)); };
  }
  // One-way messages (phone-matrix:input sends touches to phones) are dropped in the trial. The same
  // wrapper is reused per listener so removeListener/off with the original function still works.
  const wrappers = new Map();
  const wrapped = (channel, listener) => {
    if (typeof listener !== "function") return listener;
    let byListener = wrappers.get(channel);
    if (!byListener) wrappers.set(channel, byListener = new WeakMap());
    let wrapper = byListener.get(listener);
    if (!wrapper) byListener.set(listener, wrapper = (event, ...args) => { if (!refused(channel, args)) listener(event, ...args); });
    return wrapper;
  };
  for (const name of ["on", "addListener", "once", "prependListener", "prependOnceListener"]) {
    if (typeof ipcMain[name] !== "function") continue;
    const original = ipcMain[name].bind(ipcMain);
    ipcMain[name] = (channel, listener) => { registering(channel); return original(channel, wrapped(channel, listener)); };
  }
  for (const name of ["removeListener", "off"]) {
    if (typeof ipcMain[name] !== "function") continue;
    const original = ipcMain[name].bind(ipcMain);
    ipcMain[name] = (channel, listener) => original(channel, wrappers.get(channel)?.get(listener) || listener);
  }
}

module.exports = { installDemoModeGuard, blocksInTrial, promptsAdvisor, trialDecision, classify, OPEN_AREAS, DEMO_TEXT };
