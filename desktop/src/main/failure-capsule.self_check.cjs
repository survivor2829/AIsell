const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDiagnosticLogger } = require("./diagnostics.cjs");
const { createFailureCapsules, withoutProfilePath } = require("./failure-capsule.cjs");

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("fixture")]);
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

function fixture(name, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `capsule-${name}-`));
  const engineLogsDir = path.join(root, "content-engine", "logs");
  fs.mkdirSync(engineLogsDir, { recursive: true });
  const logger = createDiagnosticLogger({ rootDir: root });
  const posts = [];
  let failing = false, enabled = true;
  const network = { async request(route, { body }) {
    if (failing) throw Object.assign(new Error("offline"), { code: "cloud_network_failed" });
    posts.push({ route, body });
    return route === "/v1/capsules" ? { id: body.capsule.id, evidence: [] } : { ok: true };
  } };
  const capsules = createFailureCapsules({ rootDir: root, logger, engineLogsDir, network, settleMs: 5,
    identity: () => ({ schema: 1, installId: "11111111-2222-4333-8444-555555555555", version: "1.2.22" }),
    isEnabled: () => enabled, environment: () => ({ displays: [{ width: 1920, height: 1080, scale: 1.25 }] }), home: root, ...options });
  const files = () => fs.readdirSync(capsules.directory).filter(file => /^[a-f0-9-]{36}\.json$/.test(file))
    .map(file => JSON.parse(fs.readFileSync(path.join(capsules.directory, file), "utf8")));
  return { root, engineLogsDir, logger, capsules, posts, files,
    setFailing: value => { failing = value; }, setEnabled: value => { enabled = value; } };
}

function journal(engineLogsDir, entry) {
  fs.appendFileSync(path.join(engineLogsDir, "failures.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

async function logFailureBecomesOneCapsuleWithItsSteps() {
  const t = fixture("log");
  t.capsules.start();
  const trace = t.logger.begin("active_touch", "moments.interact", {}, { trace: true });
  t.logger.event("active_touch", "moments.post_scan", { scan_mode: "visual" }, { level: "info", traceId: trace.traceId, trace: true });
  t.logger.event("active_touch", "moments.failed", { reason: "moments_post_not_found" }, { level: "error", code: "moments_post_not_found", traceId: trace.traceId });
  t.logger.event("active_touch", "moments.failed", { reason: "moments_post_not_found" }, { level: "error", code: "moments_post_not_found", traceId: trace.traceId, dedupeKey: "second" });
  t.logger.event("active_touch", "moments.progress", {}, { level: "info" });
  await new Promise(resolve => setTimeout(resolve, 60));
  const [capsule, ...extra] = t.files();
  assert.equal(extra.length, 0, "a repeat within ten minutes only counts; it is not a second upload");
  assert.equal(capsule.code, "moments_post_not_found");
  assert.equal(capsule.occurrences, 2);
  assert.equal(capsule.traceId, trace.traceId);
  assert.ok(capsule.breadcrumbs.some(row => row.event === "moments.post_scan"), "the steps of the same operation travel with the failure");
  assert.equal(capsule.environment.displays[0].scale, 1.25);
  await t.capsules.flush();
  assert.ok(t.posts.every(post => post.route === "/v1/capsules" && post.body.capsule.id === capsule.id));
  assert.equal(t.posts.at(-1).body.capsule.occurrences, 2, "the server learns how often the failure repeated");
  assert.equal(t.posts[0].body.client.installId, "11111111-2222-4333-8444-555555555555");
  t.capsules.stop();
}

async function engineJournalAndTaskLogMergeIntoOneCapsule() {
  const t = fixture("engine");
  t.capsules.start();
  journal(t.engineLogsDir, { where: "narrated_production", code: "auto_mix_music_not_audible", type: "ContentEngineError",
    message: `背景音乐在大部分口播中听不到（2/3 句） ${path.join(t.root, "content-engine", "music.mp3")}`,
    details: { quiet: [{ captionId: "c2", startMs: 700, endMs: 1100, musicLufs: null }] }, task_id: "task_7", context: { batch_id: "batch_7" },
    traceback: `Traceback (most recent call last):\n  File "${path.join(t.root, "x.py")}", line 1\nContentEngineError` });
  t.logger.event("content_engine", "task_terminal", { task_id: "task_7", error_code: "auto_mix_music_not_audible" }, { level: "error", code: "auto_mix_music_not_audible" });
  await new Promise(resolve => setTimeout(resolve, 60));
  const [capsule, ...extra] = t.files();
  assert.equal(extra.length, 0, "the engine record and the task log line are the same failure");
  assert.equal(capsule.source, "engine", "the journal record, with the traceback, opens the capsule");
  assert.equal(capsule.details.quiet[0].captionId, "c2");
  assert.match(capsule.traceback, /ContentEngineError/);
  assert.equal(capsule.context.batch_id, "batch_7");
  const serialized = JSON.stringify(capsule);
  assert.ok(!serialized.includes(JSON.stringify(t.root).slice(1, -1)), "the Windows profile path, which names the user, never leaves the computer");
  assert.ok(serialized.includes("~"));
  assert.deepEqual(t.capsules.related({ module: "content_engine", taskId: "batch_7" }), [capsule.id], "feedback on the batch finds its capsule");
  assert.deepEqual(t.capsules.related({ module: "active_touch" }), []);
  t.capsules.stop();
}

async function journalHistoryIsNotReplayedAndOffsetsPersist() {
  const t = fixture("history");
  journal(t.engineLogsDir, { where: "request:x", code: "old_failure", ts: new Date(Date.now() - 3 * 86400000).toISOString() });
  t.capsules.pollJournal();
  assert.equal(t.files().length, 0, "failures older than a day are history, not news");
  journal(t.engineLogsDir, { where: "request:y", code: "new_failure" });
  t.capsules.pollJournal();
  t.capsules.pollJournal();
  assert.equal(t.files().length, 1, "each journal line is read once");
  t.capsules.stop();
  const again = createFailureCapsules({ rootDir: t.root, logger: t.logger, engineLogsDir: t.engineLogsDir, home: t.root });
  again.pollJournal();
  assert.equal(t.files().length, 1, "the read position survives a restart");
}

async function screenshotsOfTheSameOperationUploadAsOriginals() {
  const t = fixture("evidence");
  const evidence = path.join(t.root, "failure-evidence");
  fs.mkdirSync(evidence);
  const trace = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", id = "0123456789abcdef0123456789abcdef";
  fs.writeFileSync(path.join(evidence, `${id}.json`), JSON.stringify({ ts: new Date().toISOString(), code: "wechat_main_window_not_found", trace_id: trace, details: { evidence_id: id, capture_status: "saved" } }));
  fs.writeFileSync(path.join(evidence, `${id}.png`), PNG);
  t.capsules.record({ source: "log", module: "wechat_adapter", code: "wechat_main_window_not_found", traceId: trace });
  await t.capsules.flush();
  assert.deepEqual(t.posts.map(post => post.route), ["/v1/capsules", "/v1/capsules/evidence"]);
  assert.equal(Buffer.from(t.posts[1].body.png, "base64").equals(PNG), true, "the screenshot is the original image");
  assert.equal(t.posts[1].body.evidenceId, id);
  t.capsules.stop();
}

async function uploadRetriesAndRespectsTheCustomerSwitch() {
  const t = fixture("switch");
  t.setEnabled(false);
  t.capsules.record({ source: "log", module: "app", code: "first" });
  await t.capsules.flush();
  assert.equal(t.posts.length, 0, "nothing uploads while the customer has upload turned off");
  assert.equal(t.capsules.status().queued, 1, "the capsule stays local");
  t.setEnabled(true); t.setFailing(true);
  await t.capsules.flush();
  assert.equal(t.capsules.status().queued, 1, "a failed upload is kept for the next attempt");
  t.capsules.stop();
  const fresh = fixture("retry");
  fresh.capsules.record({ source: "log", module: "app", code: "a" });
  await fresh.capsules.flush();
  assert.equal(fresh.capsules.status().queued, 0);
  for (const code of ["cancelled", "CONTENT_DIALOG_CANCELLED"]) assert.equal(fresh.capsules.record({ source: "log", module: "app", code }), null, `${code} is not a failure`);
  assert.equal(fresh.capsules.record({ source: "log", module: "maintenance", code: "cloud_network_failed" }), null, "upload trouble is not reported through upload");
  fresh.capsules.stop();
}

async function dailyLimitStopsAFailureLoop() {
  const t = fixture("limit");
  t.setEnabled(false);
  let made = 0;
  for (let index = 0; index < 60; index += 1) if (t.capsules.record({ source: "log", module: "app", code: `code_${index}` })) made += 1;
  assert.equal(made, 40, "a failure loop cannot flood the server or the disk");
  t.capsules.stop();
}

function profilePathVariants() {
  const home = "C:\\Users\\张三";
  const json = JSON.stringify({ a: "C:\\Users\\张三\\AppData\\x.json", b: "C:/Users/张三/x", c: "c:\\users\\张三\\y" });
  assert.ok(!withoutProfilePath(json, home).includes("张三"));
}

(async () => {
  await logFailureBecomesOneCapsuleWithItsSteps();
  await engineJournalAndTaskLogMergeIntoOneCapsule();
  await journalHistoryIsNotReplayedAndOffsetsPersist();
  await screenshotsOfTheSameOperationUploadAsOriginals();
  await uploadRetriesAndRespectsTheCustomerSwitch();
  await dailyLimitStopsAFailureLoop();
  profilePathVariants();
  await settle();
  console.log("failure capsule: one capsule per failure with its steps, engine journal merge, screenshots, profile path removal, retry, customer switch and daily limit passed");
})().catch(error => { console.error(error); process.exit(1); });
