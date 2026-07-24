const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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

  const logger = createDiagnosticLogger({ rootDir: root, appInfo: { version: "0.2.0" } });
  const operation = logger.begin("auto_reply", "scan", { message: "敏感消息", pid: 12 });
  operation.end({ ok: false, blocked_reason: "visual_ocr_failed", diagnostics: { candidateCount: 2 } });
  const rows = logger.readRecent(10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].trace_id, rows[1].trace_id);
  assert.equal(rows[0].code, "visual_ocr_failed");
  assert.doesNotMatch(fs.readFileSync(logger.logFile, "utf8"), /敏感消息/);
  assert.equal(logger.status().data.recentErrorCount, 1);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("diagnostics self-check passed");
