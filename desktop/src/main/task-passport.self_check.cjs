const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTaskPassportStore, collectTaskPassportFiles } = require("./task-passport.cjs");
const { TASK_PASSPORT_REASON_CATALOGS } = require("./task-passport-reason-catalog.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-task-passport-"));
let screenshotCalls = 0;
const screenshotRequests = [];
const clock = { value: new Date("2026-09-19T01:00:00.000Z") };

try {
  for (const [moduleName, reasons] of Object.entries(TASK_PASSPORT_REASON_CATALOGS)) {
    assert.equal(reasons.length > 0, true, `${moduleName} must have a reason catalog`);
    assert.equal(new Set(reasons.map((item) => item.code)).size, reasons.length, `${moduleName} reason codes must be unique`);
    for (const item of reasons) {
      assert.match(item.code, /^[a-z0-9_.:-]+$/u);
      assert.equal(Boolean(item.meaning && item.stage), true);
      assert.notEqual(item.code, "unknown");
    }
  }
  const store = createTaskPassportStore({
    rootDir: root,
    now: () => new Date(clock.value),
    captureScreenshot: (request) => {
      screenshotCalls += 1;
      screenshotRequests.push(request);
      return Buffer.from("89504e470d0a1a0a", "hex");
    },
    dailyAttachmentLimit: 3
  });

  assert.equal(store.recordEvent("active_touch", "touch-1", {
    stage: "search", direction: "out", durationMs: 12, status: "ok"
  }).ok, true);
  const passportDir = path.join(root, "task-passports", "active_touch", "touch-1");
  const eventsFile = path.join(passportDir, "events.jsonl");
  assert.equal(fs.readFileSync(eventsFile, "utf8").trim().split(/\r?\n/u).length, 1);
  assert.equal(fs.readdirSync(passportDir).length, 1, "successful tasks must stay event-only");

  const workflowTrace = "6ee435c1-0bb7-4142-8cff-9188366eb071";
  store.observeDiagnostic({
    module: "active_touch", event: "workflow_contact_send.started", phase: "start", trace_id: workflowTrace,
    details: { task_id: { present: true, length: 36, sha256_16: "ca2e7b91767be7b0" } }
  });
  store.bindTrace("active_touch", workflowTrace, "workflow-task-1-0");
  store.observeDiagnostic({
    module: "active_touch", event: "send_stage", phase: "finish", trace_id: workflowTrace,
    details: { stage: "prepare_window" }
  });
  const boundEvents = path.join(root, "task-passports", "active_touch", "workflow-task-1-0", "events.jsonl");
  assert.equal(fs.existsSync(boundEvents), true, "a trace binding must keep sanitized diagnostics in the real task passport");
  assert.equal(fs.readdirSync(path.join(root, "task-passports", "active_touch")).some((name) => name.startsWith("task-")), false,
    "a sanitized task_id object must never create a hashed fake task passport");

  const failed = store.recordFailure("active_touch", "touch-1", {
    stage: "search", reasonCode: "search_result_identity_unverified", ruleId: "search-r014",
    rawReading: { ocr_text: "原始读数", expected_hWnd: 68628 }, expected: { query: "expected-id" }
  });
  assert.equal(failed.ok, true);
  assert.deepEqual(failed.attachments.map((name) => path.extname(name)).sort(), [".json", ".json", ".png"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(passportDir, failed.attachments.find((name) => name.includes("raw-reading"))), "utf8")).ocr_text, "原始读数");
  assert.equal(screenshotRequests[0].failure.rawReading.expected_hWnd, 68628,
    "failure screenshots must receive the WeChat window captured at the failure point");

  const capped = store.recordFailure("active_touch", "touch-2", {
    stage: "send", reasonCode: "outcome_unknown", rawReading: { state: "clicked" }, expected: { state: "sent_verified" }
  });
  assert.equal(capped.attachments.length, 0, "daily cap must reserve complete failure triplets");
  assert.equal(capped.attachmentStatus, "daily_limit_reached");
  assert.equal(screenshotCalls, 1);

  const bill = store.writeRunBill("active_touch", "batch-1", [
    { taskId: "a", status: "sent_verified" },
    { taskId: "b", status: "identity_skipped", reasonCode: "search_result_identity_unverified", ruleId: "search-r014", attachments: failed.attachments },
    { taskId: "c", status: "outcome_unknown", reasonCode: "outcome_unknown" }
  ]);
  assert.deepEqual(bill.summary, { total: 3, success: 1, skipped: 1, failed: 1 });
  assert.deepEqual(bill.reason_counts, { search_result_identity_unverified: 1, outcome_unknown: 1 });
  assert.deepEqual(bill.rule_counts, { "search-r014": 1 });
  assert.deepEqual(bill.result_code_counts, { "search-r014": 1, outcome_unknown: 1 });
  assert.equal(fs.existsSync(bill.jsonFile), true);
  assert.equal(fs.existsSync(bill.textFile), true);
  const files = collectTaskPassportFiles(root);
  assert.equal(files.some((entry) => entry.name.endsWith("run-bill.json")), true);
  assert.equal(files.some((entry) => entry.name.endsWith("run-bill.txt")), true);

  clock.value = new Date("2026-10-25T01:00:00.000Z");
  store.cleanup();
  assert.equal(fs.existsSync(passportDir), false, "passports older than 30 days must be removed");

  const brokenRoot = path.join(root, "not-a-directory");
  fs.writeFileSync(brokenRoot, "blocked");
  const broken = createTaskPassportStore({ rootDir: brokenRoot, onWriteFailure: () => undefined });
  assert.doesNotThrow(() => broken.recordEvent("moments", "task", { stage: "open" }));
  assert.equal(broken.status().writesFailed > 0, true, "passport failures must be counted without escaping");

  console.log("task passport self-check passed: event-only success, failure triplet, cap, bill, retention and fail-open writes");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
