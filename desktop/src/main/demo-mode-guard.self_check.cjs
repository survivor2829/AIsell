// 免费体验: the trial account can look at everything and use nothing (user decision 2026-11-18).
const assert = require("node:assert/strict");
const { installDemoModeGuard, blocksInTrial, promptsAdvisor, DEMO_TEXT } = require("./demo-mode-guard.cjs");

// Using a feature is refused; looking, stopping and the account itself never are.
for (const channel of ["wechat-workflow:start", "touch-task:start", "content-engine:choose-files", "content-engine:import-paths",
  "content-engine:generate-mix-candidates", "contact-sync:sync", "auto-reply:start", "moments-campaign:run-daily-now",
  "keyword-acquisition:start", "phone-matrix:install-apk", "digital-human:synthesize", "deepseek-api:save",
  // Review 2026-11-18: these act outside the app even though their names sound harmless.
  "keyword-acquisition:open-browser", "keyword-acquisition:open-conversation", "product-detail-ai-settings:validate",
  "auto-reply:acknowledge-manual-followup", "phone-matrix:input"]) {
  assert.equal(blocksInTrial(channel), true, `${channel} is refused in the trial`);
}
for (const channel of ["wechat-workflow:status", "content-engine:list-assets", "content-engine:get-task", "wechat-workflow:show-main",
  "wechat-workflow:pause", "touch-task:stop", "content-engine:cancel-task", "ai-expert:conversation", "phone-matrix:watch",
  "account:logout", "account:demo-login", "feedback:submit", "cloud:install", "tutorials:list", "official-materials:download", "no-colon"]) {
  assert.equal(blocksInTrial(channel), false, `${channel} stays open in the trial`);
}
// Workbenches name the action as the first argument: ipcRenderer.invoke("geo:invoke", action, payload).
assert.equal(blocksInTrial("geo:invoke", "snapshot", {}), false, "a workbench page still loads");
assert.equal(blocksInTrial("map-acquisition:invoke", "list-results", {}), false);
assert.equal(blocksInTrial("map-acquisition:invoke", "start-task", {}), true);
assert.equal(blocksInTrial("map-acquisition:invoke", { action: "start-task" }), true);
assert.equal(blocksInTrial("map-acquisition:invoke"), true, "an unnamed workbench action is refused");
// Only using a feature brings up the advisor's card; a page reading something unusual is refused quietly.
assert.equal(promptsAdvisor("wechat-workflow:start"), true);
assert.equal(promptsAdvisor("geo:invoke", "start-task"), true);
assert.equal(promptsAdvisor("ai-expert:remove"), false);

// The wrapper: refused only while the trial is signed in, with one friendly line; the handler never runs.
const registered = new Map();
const sent = new Map();
const ipcMain = { handle: (channel, listener) => registered.set(channel, listener), on: (channel, listener) => sent.set(channel, listener) };
let demo = true, blocked = [], ran = 0;
installDemoModeGuard(ipcMain, { isDemo: () => demo, onBlocked: (channel) => blocked.push(channel) });
installDemoModeGuard(ipcMain, { isDemo: () => false }); // a second install changes nothing
ipcMain.handle("wechat-workflow:start", async () => { ran += 1; return { ok: true }; });
ipcMain.handle("wechat-workflow:status", async () => ({ ok: true, state: "idle" }));
let touches = 0;
ipcMain.on("phone-matrix:input", () => { touches += 1; });
ipcMain.handle("geo:invoke", async (_event, action) => ({ ok: true, action }));
(async () => {
  const refused = await registered.get("wechat-workflow:start")({}, {});
  assert.deepEqual({ ok: refused.ok, demo: refused.demo, code: refused.code, error: refused.error }, { ok: false, demo: true, code: "demo_account", error: DEMO_TEXT });
  assert.equal(ran, 0);
  assert.deepEqual(blocked, ["wechat-workflow:start"]);
  assert.deepEqual(await registered.get("wechat-workflow:status")({}, {}), { ok: true, state: "idle" });
  assert.deepEqual(await registered.get("geo:invoke")({}, "snapshot", {}), { ok: true, action: "snapshot" }, "the real workbench form reaches the handler");
  sent.get("phone-matrix:input")({}, { x: 1 });
  assert.equal(touches, 0, "no touch reaches a phone in the trial");
  demo = false;
  assert.deepEqual(await registered.get("wechat-workflow:start")({}, {}), { ok: true }, "a real account is never limited");
  assert.equal(ran, 1);
  sent.get("phone-matrix:input")({}, { x: 1 });
  assert.equal(touches, 1);
  console.log("demo mode guard checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
