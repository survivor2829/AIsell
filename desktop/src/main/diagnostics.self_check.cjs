const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const diagnosticsPath = require.resolve("./diagnostics.cjs");
const previousDiagnosticsModule = require.cache[diagnosticsPath];
const originalLoad = Module._load;
delete require.cache[diagnosticsPath];
try {
  Module._load = function isolatedDiagnosticLoad(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (/[\\/]rpa[\\/]|[\\/][^\\/]*_cli\.cjs$/iu.test(resolved)) throw new Error("diagnostics_imported_rpa_or_cli");
    return originalLoad.call(this, request, parent, isMain);
  };
  assert.doesNotThrow(() => require("./diagnostics.cjs"), "preload diagnostics must load in isolation without any transitive RPA or CLI dependency");
} finally {
  Module._load = originalLoad;
  if (previousDiagnosticsModule) require.cache[diagnosticsPath] = previousDiagnosticsModule;
}
const { createDiagnosticLogger, sanitizeValue } = require("./diagnostics.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-diagnostics-"));
try {
  const sanitized = sanitizeValue({
    apiKey: "sk" + "-private-secret-value",
    message: "客户原话不应进入日志",
    contactName: "张三",
    code: "wechat_window_missing",
    count: 3
  }, { salt: "test" });
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /private-secret|客户原话|张三/);
  assert.match(serialized, /wechat_window_missing/);
  assert.equal(sanitized.count, 3);
  const adversarialSanitized = sanitizeValue({
    reason: "prefix_sk_privateSecret123",
    task_id: "customer_private_job_123",
    contacts: { wxid_scott_private: true },
    status: "ready"
  }, { salt: "test" });
  const adversarialSerialized = JSON.stringify(adversarialSanitized);
  assert.doesNotMatch(adversarialSerialized, /privateSecret|customer_private_job|wxid_scott_private/iu);
  assert.equal(adversarialSanitized.status, "ready");

  const safeReceipt = {
    receipt_stage: "bubble_read",
    receipt_code: "receipt_unconfirmed",
    receipt_draft_read_stage: "empty",
    receipt_conversation_verified: true,
    receipt_draft_read_ok: true,
    receipt_draft_consumed: true,
    receipt_input_lease_valid: false,
    receipt_bubble_verified: false,
    receipt_verification_attempts: 4
  };
  assert.deepEqual(sanitizeValue({
    ...safeReceipt,
    conversation: "receipt-private-contact-canary",
    draft: "receipt-private-draft-canary",
    message: "receipt-private-message-canary"
  }), safeReceipt, "strict receipt metadata must survive unified logging without broad draft or conversation exemptions");
  assert.deepEqual(sanitizeValue({
    receipt_stage: "private-stage-canary",
    receipt_code: "private-code-canary",
    receipt_draft_read_stage: "private-draft-stage-canary",
    receipt_conversation_verified: "private-contact-canary",
    receipt_draft_read_ok: "true",
    receipt_draft_consumed: 1,
    receipt_input_lease_valid: {},
    receipt_bubble_verified: "false",
    receipt_verification_attempts: 5
  }), {}, "receipt fields must reject arbitrary strings and incorrectly typed or out-of-range values");

  const logger = createDiagnosticLogger({ rootDir: root, appInfo: { version: "0.2.0" } });
  logger.event("app", "window_closing");
  logger.environment({ launchMode: "test" });
  const successfulOperation = logger.begin("auto_reply", "healthy_scan", { pid: 11 });
  successfulOperation.end({ ok: true });
  const operation = logger.begin("auto_reply", "scan", { message: "敏感消息", pid: 12 });
  operation.end({ ok: false, blocked_reason: "visual_ocr_failed", diagnostics: { candidateCount: 2 }, ...safeReceipt });
  logger.event("renderer", "unresponsive", {}, {
    level: "warn",
    code: "renderer_unresponsive"
  });
  const unsafeError = new Error(
    "Cannot load C:\\Users\\Scott\\private\\clip.mp4 from "
      + "https://user:pass@example.invalid/page?token=sk_urlSecret123#private "
      + "with LTAI5TESTSECRET and sk_testSecret123"
  );
  unsafeError.code = "LTAI5CODESECRET";
  unsafeError.stack = [
    unsafeError.message,
    "    at render (C:\\Users\\Scott\\private\\worker.cjs:10:2)",
    "    at render (D:\\视频素材\\private\\worker.cjs:20:3)"
  ].join("\n");
  const unsafeDetails = {
    error: unsafeError,
    url: "https://user:pass@example.invalid/page?api_key=LTAI5URLSECRET&token=sk_urlSecret123#private",
    file_path: "D:\\客户资料\\secret.html",
    reason: "file:///C:/Users/Scott/Desktop/private.html",
    ["sk" + "_unsafeObjectKey123"]: true,
    客户资料: true
  };
  logger.event("renderer", "load_failed", unsafeDetails, {
    level: "error",
    code: "sk_topLevelSecret123"
  });
  logger.event("renderer", "load_failed", { ...unsafeDetails, count: 2 }, {
    level: "error",
    code: "sk_topLevelSecret123"
  });
  logger.event("renderer", "load_failed.started", {}, { level: "info" });
  logger.event("renderer", "load_failed", unsafeDetails, {
    level: "error",
    code: "sk_topLevelSecret123"
  });
  logger.event("renderer", "load_failed", unsafeDetails, {
    level: "error",
    code: "renderer_load_other"
  });
  logger.event("renderer", "responsive");
  logger.event("renderer", "load_failed", unsafeDetails, {
    level: "error",
    code: "renderer_load_other"
  });
  logger.event("system", "resource_pressure", {}, {
    level: "warning",
    code: "resource_pressure"
  });
  logger.event("dedupe_probe", "fault", { count: 1 }, {
    level: "error",
    code: "dedupe_fault"
  });
  logger.event("dedupe_probe", "heartbeat");
  logger.event("dedupe_probe", "fault", { count: 2 }, {
    level: "error",
    code: "dedupe_fault"
  });
  logger.event("dedupe_probe", "repair.finished");
  logger.event("dedupe_probe", "fault", { count: 3 }, {
    level: "error",
    code: "dedupe_fault"
  });
  logger.recover("dedupe_probe");
  logger.event("dedupe_probe", "fault", { count: 4 }, {
    level: "error",
    code: "dedupe_fault"
  });
  logger.event("cancel_probe", "fault", { count: 1 }, {
    level: "error",
    code: "cancel_fault"
  });
  const cancelledOperation = logger.begin("cancel_probe", "operation");
  cancelledOperation.end({ ok: false, cancelled: true, code: "user_cancelled" });
  logger.event("cancel_probe", "fault", { count: 2 }, {
    level: "error",
    code: "cancel_fault"
  });
  cancelledOperation.cancel({ reason: "user_cancelled" });
  const oversizedDetails = {
    status: "x".repeat(100_000),
    nested: Array.from({ length: 40 }, (_, index) => ({
      index,
      values: Array.from({ length: 40 }, (__, childIndex) => ({ index: childIndex }))
    }))
  };
  logger.event("budget_probe", "oversized", oversizedDetails, {
    level: "error",
    code: "oversized_details"
  });
  logger.event("job_probe", "job_terminal", {}, {
    level: "error",
    code: "render_failed",
    dedupeKey: "task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  });
  logger.event("job_probe", "job_terminal", {}, {
    level: "error",
    code: "render_failed",
    dedupeKey: "task_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  });
  logger.event("job_probe", "job_terminal", {}, {
    level: "error",
    code: "render_failed",
    dedupeKey: "task_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  });
  const hostileDetails = {};
  Object.defineProperty(hostileDetails, "status", {
    enumerable: true,
    get() {
      throw new Error("getter boom");
    }
  });
  assert.doesNotThrow(() => logger.event("failsafe_probe", "getter", hostileDetails, {
    level: "error",
    code: "getter_failed"
  }));
  const rows = logger.readRecent(30);
  assert.equal(rows.length, 17);
  const failedRow = rows.find((row) => row.code === "visual_ocr_failed");
  assert.deepEqual(Object.fromEntries(Object.keys(safeReceipt).map((key) => [key, failedRow?.details?.[key]])), safeReceipt, "unified persisted errors must retain the complete typed receipt for ZIP export");
  assert.equal(Boolean(failedRow?.trace_id), true);
  assert.equal(rows.some((row) => row.event === "window_closing"), false);
  assert.equal(rows.some((row) => row.event === "environment.snapshot"), false);
  assert.equal(logger.status().data.environment.platform, process.platform);
  assert.equal(logger.status().data.environment.launchMode.present, true);
  assert.equal(rows.some((row) => row.event === "healthy_scan.finished"), false);
  assert.equal(rows.some((row) => row.code === "renderer_unresponsive"), true);
  assert.equal(rows.some((row) => row.code === "unknown_error"), true);
  assert.equal(rows.some((row) => row.level === "warn" && row.code === "resource_pressure"), true);
  assert.deepEqual(
    rows.map((row) => row.seq).sort((left, right) => left - right),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
    "suppressed diagnostics must not create sequence gaps"
  );
  assert.equal(rows.filter((row) => row.code === "cancel_fault").length, 2);
  assert.equal(rows.filter((row) => row.code === "render_failed").length, 2);
  assert.equal(rows.some((row) => row.code === "user_cancelled"), false);
  assert.equal(rows.filter((row) => row.code === "recovered").length, 2);
  const boundedRow = rows.find((row) => row.code === "oversized_details");
  assert.equal(Buffer.byteLength(JSON.stringify(boundedRow?.details), "utf8") <= 4 * 1024, true);
  assert.equal(boundedRow?.details?.status?.truncated, true);
  assert.equal(rows.find((row) => row.code === "getter_failed")?.details?.status, "[UNREADABLE]");
  const rawLog = fs.readFileSync(logger.logFile, "utf8");
  assert.doesNotMatch(rawLog, /敏感消息|Scott|private|视频素材|客户资料|clip\.mp4|worker\.cjs|unsafeObjectKey/iu);
  assert.doesNotMatch(rawLog, /https?:\/\/|file:\/\/|LTAI|sk_|sk-|ak-/iu);
  assert.doesNotMatch(rawLog, /Cannot load/iu);
  const protectedError = rows.find((row) => row.code === "unknown_error")?.details?.error;
  assert.equal(protectedError?.name, "error");
  assert.equal(typeof protectedError?.message_ref, "string");
  assert.equal("message" in protectedError, false);
  assert.equal("stack" in protectedError, false);
  assert.equal(logger.status().data.recentErrorCount, 13);

  const invalidClockRoot = path.join(root, "invalid-clock");
  const invalidClockLogger = createDiagnosticLogger({
    rootDir: invalidClockRoot,
    clock: () => new Date(Number.NaN)
  });
  assert.doesNotThrow(() => invalidClockLogger.event("failsafe_probe", "invalid_clock", {}, {
    level: "error",
    code: "invalid_clock"
  }));
  assert.equal(invalidClockLogger.readRecent(10).length, 0);
  const traceLogger = createDiagnosticLogger({ rootDir: path.join(root, "send-trace") });
  const tracedOperation = traceLogger.begin("active_touch", "contact_send", { action: "send" }, { trace: true });
  traceLogger.event("active_touch", "send_stage", { stage: "after_send_confirmation", is_new: false,
    input_empty: true, input_read_reason: "empty", message: "trace-private-text" }, { trace: true, traceId: tracedOperation.traceId });
  tracedOperation.end({ ok: false, reason: "message_bubble_not_new_latest_exact", send_attempted: null });
  const traceRows = traceLogger.readRecent(10).reverse();
  assert.equal(traceRows.length, 3, "Explicit operation traces must retain start, observations and result in the exported log");
  assert.equal(traceRows.every((entry) => entry.trace_id === tracedOperation.traceId), true);
  assert.equal(traceRows[1].details.is_new, false);
  assert.equal(traceRows[1].details.input_empty, true);
  assert.equal(traceRows[2].details.send_attempted, null);
  const report = require("../shared/cloud-report.cjs").reportEntry(traceRows[1], { installId: "12345678-1234-1234-1234-123456789012" });
  assert.equal(report.details.is_new, false, "Technical confirmation evidence must survive the cloud allowlist");
  assert.equal(report.details.input_empty, true);
  assert.equal(report.details.stage, "after_send_confirmation");
  assert.doesNotMatch(JSON.stringify(traceRows), /trace-private-text/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("diagnostics self-check passed");
