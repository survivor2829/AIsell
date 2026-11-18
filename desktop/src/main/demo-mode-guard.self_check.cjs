// 免费体验: the trial account can look at everything and use nothing (user decision 2026-11-18).
const assert = require("node:assert/strict");
const { installDemoModeGuard, blocksInTrial, promptsAdvisor, trialDecision, classify, DEMO_TEXT } = require("./demo-mode-guard.cjs");
const { READS, QUIET, ACTIONS } = require("./demo-mode-channels.cjs");
const { scanTrialChannels } = require("../../scripts/trial-channel-scan.cjs");

// Every request the main process answers is classified exactly once, so a new feature must decide
// whether the trial may use it (guessing from words got both directions wrong, 2026-11-18).
const scanned = new Set(scanTrialChannels());
const unclassified = [...scanned].filter((name) => classify(name) === "unclassified");
assert.deepEqual(unclassified, [], `classify these in demo-mode-channels.cjs (READS / QUIET / ACTIONS): ${unclassified.join(", ")}`);
for (const name of READS) assert.ok(!QUIET.has(name) && !ACTIONS.has(name), `${name} is in two lists`);
for (const name of QUIET) assert.ok(!ACTIONS.has(name), `${name} is in two lists`);
// The scanner sees every registration style: literal, camelCase, maps (also split over lines), `area:${name}` over methods.
for (const name of ["product-video:capabilities", "product-video:import-image", "phone-matrix:batchStart", "social-acquisition:queueActions", "social-nurture:runNow", "content-engine:batch-samples",
  "keyword-acquisition:save-task", "digital-human:reference-viral-library", "wechat-workflow:retry-all-and-start"]) {
  assert.ok(scanned.has(name), `the scanner finds ${name}`);
}

// Field report 2026-11-18: the trial opened 数字人 and saw 「爆款文案库没有读到」 — reads named by a
// noun were refused. Every read a trial page makes passes.
for (const channel of ["digital-human:reference-viral-library", "digital-human:reference-capabilities", "digital-human:reference-assets",
  "digital-human:reference-workspace", "digital-human:reference-script-quota",
  "digital-human:reference-viral-pipeline-list", "content-engine:list-publish-queue", "content-engine:list-export-packages",
  "content-engine:bailian-key-status", "content-engine:probe-asset", "content-engine:open-finished",
  "product-video:capabilities", "product-video:list", "product-video:get", "product-video:media",
  // Review 2026-11-18: the 产品详情图 page starts its service when it opens.
  "product-detail:start",
  "wechat-workflow:status", "content-engine:list-assets", "wechat-workflow:pause", "touch-task:stop", "content-engine:cancel-task",
  "ai-expert:conversation", "account:logout", "account:demo-login", "feedback:submit", "cloud:install",
  "tutorials:list", "official-materials:download", "no-colon"]) {
  assert.equal(blocksInTrial(channel), false, `${channel} passes in the trial`);
}
// Doing something is refused with the advisor's card — including camelCase and noun-named actions
// and anything that acts on a platform (review 2026-11-18).
for (const channel of ["wechat-workflow:start", "touch-task:start", "content-engine:choose-files", "content-engine:import-paths",
  "content-engine:generate-mix-candidates", "contact-sync:sync", "auto-reply:start", "moments-campaign:run-daily-now",
  "keyword-acquisition:start-task", "deepseek-api:save", "keyword-acquisition:open-browser", "keyword-acquisition:open-conversation",
  "keyword-acquisition:open-source", "product-detail-ai-settings:validate", "auto-reply:acknowledge-manual-followup", "phone-matrix:input",
  "phone-matrix:batchStart", "social-acquisition:queueActions", "social-acquisition:saveTask", "social-acquisition:openLead",
  "social-nurture:runNow", "social-nurture:savePlan", "content-engine:batch-samples", "content-engine:batch-scripts",
  "content-engine:batch-recommend", "digital-human:reference-cover-quote", "digital-human:reference-quote",
  "digital-human:reference-source-read", "digital-human:reference-viral-scan", "digital-human:reference-viral-pipeline-start-script",
  "content-engine:archive-asset", "content-engine:preview-auto-mix-voice-persona", "product-video:create",
  "product-video:import-image", "product-video:export"]) {
  assert.equal(trialDecision(channel), "action", `${channel} is refused with the advisor's card`);
}
// Requests a page makes on its own when it opens are refused without the card (no pop-up on navigation).
// Also requests that look like reading but act: refresh resumes outcome_unknown work, watch and checkPhones reach phones.
for (const channel of ["content-engine:backfill-covers", "contact-sync:auto-detect-paths", "digital-human:reference-refresh",
  "product-video:refresh", "phone-matrix:watch", "phone-matrix:checkPhones", "phone-matrix:refresh", "social-publish:covers"]) {
  assert.equal(trialDecision(channel), "quiet", channel);
}
// Turning phone polling or a screen off is stopping and always passes.
assert.equal(trialDecision("phone-matrix:checkPhones", { on: false }), "pass");
assert.equal(trialDecision("phone-matrix:watch", { serial: "x", on: false }), "pass");
assert.equal(trialDecision("phone-matrix:checkPhones", { on: true }), "quiet");
// Only real requests are listed: page events, CSS selectors and labels are not (review 2026-11-18).
for (const name of ["wechat-workflow:navigate", "input:checked", "moments:like", "digital-human:viral-progress"]) {
  assert.ok(!scanned.has(name) && !READS.has(name) && !QUIET.has(name) && !ACTIONS.has(name), `${name} is not a request`);
}
assert.equal(trialDecision("brand-new-area:do-something"), "quiet", "a name nobody classified is refused, quietly");
// Workbenches name the action as the first argument: ipcRenderer.invoke("geo:invoke", action, payload).
assert.equal(blocksInTrial("geo:invoke", "status", {}), false, "a workbench page still loads");
assert.equal(blocksInTrial("map-acquisition:invoke", "pause-task", {}), false, "stopping is never refused");
assert.equal(promptsAdvisor("map-acquisition:invoke", "start-task", {}), true);
assert.equal(blocksInTrial("map-acquisition:invoke", "return-results", {}), false, "going back to the results is looking");
assert.equal(promptsAdvisor("geo:invoke", "open-link", {}), true, "opening an outside link is using the feature");
assert.equal(blocksInTrial("map-acquisition:invoke", { action: "start-task" }), true);
assert.equal(blocksInTrial("map-acquisition:invoke"), true, "an unnamed workbench action is refused");

// The wrapper: refused only while the trial is signed in, with one friendly line; the handler never runs.
const registered = new Map();
const sent = new Map();
const ipcMain = { handle: (channel, listener) => registered.set(channel, listener), on: (channel, listener) => sent.set(channel, listener),
  removeListener: (channel, listener) => { if (sent.get(channel) === listener) sent.delete(channel); } };
let demo = true, blocked = [], ran = 0;
const reportedUnclassified = [];
installDemoModeGuard(ipcMain, { isDemo: () => demo, onBlocked: (channel) => blocked.push(channel), onUnclassified: (channel) => reportedUnclassified.push(channel) });
installDemoModeGuard(ipcMain, { isDemo: () => false }); // a second install changes nothing
ipcMain.handle("wechat-workflow:start", async () => { ran += 1; return { ok: true }; });
ipcMain.handle("wechat-workflow:status", async () => ({ ok: true, state: "idle" }));
ipcMain.handle("content-engine:backfill-covers", async () => ({ ok: true }));
// A registration the source scan missed is reported once at run time; open areas and workbenches are not.
ipcMain.handle("brand-new-area:do-something", async () => ({ ok: true }));
ipcMain.handle("brand-new-area:do-something", async () => ({ ok: true }));
ipcMain.handle("account:status", async () => ({ ok: true }));
assert.deepEqual(reportedUnclassified, ["brand-new-area:do-something"]);
let touches = 0;
ipcMain.on("phone-matrix:input", () => { touches += 1; });
ipcMain.handle("geo:invoke", async (_event, action) => ({ ok: true, action }));
(async () => {
  const refused = await registered.get("wechat-workflow:start")({}, {});
  assert.deepEqual({ ok: refused.ok, demo: refused.demo, code: refused.code, error: refused.error }, { ok: false, demo: true, code: "demo_account", error: DEMO_TEXT });
  assert.equal(ran, 0);
  assert.deepEqual(blocked, ["wechat-workflow:start"]);
  assert.equal((await registered.get("content-engine:backfill-covers")({}, {})).ok, false);
  assert.deepEqual(blocked, ["wechat-workflow:start"], "a request the page makes on its own brings no card");
  assert.deepEqual(await registered.get("wechat-workflow:status")({}, {}), { ok: true, state: "idle" });
  assert.deepEqual(await registered.get("geo:invoke")({}, "status", {}), { ok: true, action: "status" }, "the real workbench form reaches the handler");
  sent.get("phone-matrix:input")({}, { x: 1 });
  assert.equal(touches, 0, "no touch reaches a phone in the trial");
  demo = false;
  assert.deepEqual(await registered.get("wechat-workflow:start")({}, {}), { ok: true }, "a real account is never limited");
  assert.equal(ran, 1);
  sent.get("phone-matrix:input")({}, { x: 1 });
  assert.equal(touches, 1);
  // removeListener with the original function finds the guard's wrapper (phone-matrix dispose).
  const gone = () => {};
  ipcMain.on("phone-matrix:input", gone);
  ipcMain.removeListener("phone-matrix:input", gone);
  assert.equal(sent.has("phone-matrix:input"), false, "the listener is really removed");
  console.log("demo mode guard checks passed: every request classified, reads pass, actions refused");
})().catch((error) => { console.error(error); process.exitCode = 1; });
