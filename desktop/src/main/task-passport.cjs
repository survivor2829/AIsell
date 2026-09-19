const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic, writeJsonAtomic } = require("./atomic-file.cjs");

const RETENTION_DAYS = 30;
const DAILY_ATTACHMENT_LIMIT = 200;
const MAX_EXPORT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_EXPORT_BYTES = 50 * 1024 * 1024;
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9_.:-]{0,127}$/iu;
const TERMINAL_SUCCESS = new Set(["sent_verified", "completed", "success", "answered"]);
const TERMINAL_SKIPPED = new Set(["identity_skipped", "ai_failed_skipped", "pre_send_skipped", "outcome_unknown_skipped", "skipped", "silent", "handoff"]);

function safeSegment(value, fallback = "task") {
  const text = String(value ?? "").trim();
  if (SAFE_SEGMENT.test(text) && text !== "." && text !== "..") return text;
  return `${fallback}-${crypto.createHash("sha256").update(text || fallback).digest("hex").slice(0, 16)}`;
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function normalizedReason(value, fallback = "task_failure_reason_missing") {
  const text = String(value ?? "").trim().toLowerCase();
  return SAFE_SEGMENT.test(text) ? text : fallback;
}

function walkFiles(rootDir, visit) {
  if (!fs.existsSync(rootDir)) return;
  for (const name of fs.readdirSync(rootDir)) {
    const file = path.join(rootDir, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walkFiles(file, visit);
    else if (stat.isFile()) visit(file, stat);
  }
}

function createTaskPassportStore(options = {}) {
  const rootDir = path.resolve(String(options.rootDir || ""));
  const passportRoot = path.join(rootDir, "task-passports");
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const captureScreenshot = typeof options.captureScreenshot === "function"
    ? options.captureScreenshot
    : ({ failure } = {}) => require("./task-passport-screenshot.cjs").captureWechatScreenshot({
      windowHandle: failure?.rawReading?.expected_hWnd || failure?.rawReading?.foreground_hWnd
    });
  const onWriteFailure = typeof options.onWriteFailure === "function" ? options.onWriteFailure : () => undefined;
  const dailyAttachmentLimit = Math.max(3, Math.floor(Number(options.dailyAttachmentLimit) || DAILY_ATTACHMENT_LIMIT));
  const traceTasks = new Map();
  const dailyAttachmentReservations = new Map();
  let writesFailed = 0;

  function reportWriteFailure(error, context = {}) {
    writesFailed += 1;
    try { onWriteFailure({ code: "task_passport_write_failed", error, ...context }); } catch {}
    try { process.stderr.write("task_passport_write_failed\n"); } catch {}
  }

  function taskDirectory(moduleName, taskId) {
    return path.join(passportRoot, safeSegment(moduleName, "module"), safeSegment(taskId));
  }

  function appendEvent(moduleName, taskId, payload) {
    const directory = taskDirectory(moduleName, taskId);
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, "events.jsonl"), jsonLine(payload), "utf8");
    return directory;
  }

  function recordEvent(moduleName, taskId, event = {}) {
    try {
      const at = now();
      const entry = {
        v: 1,
        ts: at.toISOString(),
        stage: normalizedReason(event.stage, "runtime"),
        direction: ["in", "out", "point"].includes(event.direction) ? event.direction : "point",
        duration_ms: Number.isFinite(Number(event.durationMs)) ? Math.max(0, Math.round(Number(event.durationMs))) : undefined,
        status: normalizedReason(event.status, "observed"),
        reason_code: event.reasonCode ? normalizedReason(event.reasonCode) : undefined,
        rule_id: event.ruleId ? normalizedReason(event.ruleId, "rule_id_invalid") : undefined,
        result_code: event.ruleId
          ? normalizedReason(event.ruleId, "rule_id_invalid")
          : event.reasonCode ? normalizedReason(event.reasonCode) : undefined,
        trace_id: event.traceId ? safeSegment(event.traceId, "trace") : undefined,
        attachments: Array.isArray(event.attachments) ? event.attachments.map((name) => path.basename(String(name))) : undefined,
        attachment_status: event.attachmentStatus ? normalizedReason(event.attachmentStatus, "attachment_status_invalid") : undefined
      };
      for (const key of Object.keys(entry)) if (entry[key] === undefined) delete entry[key];
      appendEvent(moduleName, taskId, entry);
      return { ok: true, entry };
    } catch (error) {
      reportWriteFailure(error, { moduleName, taskId, stage: event.stage });
      return { ok: false, error: "task_passport_write_failed" };
    }
  }

  function attachmentCountFor(datePrefix) {
    let count = 0;
    try {
      walkFiles(passportRoot, (file) => {
        if (path.basename(file).startsWith(`${datePrefix}-`) && /\.(?:json|png)$/iu.test(file)) count += 1;
      });
    } catch {}
    return count;
  }

  function recordFailure(moduleName, taskId, failure = {}) {
    const at = now();
    const datePrefix = at.toISOString().slice(0, 10);
    const stamp = at.toISOString().replace(/[:.]/gu, "-");
    const nonce = crypto.randomBytes(4).toString("hex");
    const base = `${datePrefix}-${stamp.slice(11)}-${nonce}`;
    const attachments = [];
    let attachmentStatus = "saved";
    try {
      const directory = taskDirectory(moduleName, taskId);
      fs.mkdirSync(directory, { recursive: true });
      const reserved = dailyAttachmentReservations.has(datePrefix)
        ? dailyAttachmentReservations.get(datePrefix)
        : attachmentCountFor(datePrefix);
      if (reserved + 3 > dailyAttachmentLimit) {
        attachmentStatus = "daily_limit_reached";
      } else {
        dailyAttachmentReservations.set(datePrefix, reserved + 3);
        const rawName = `${base}-raw-reading.json`;
        const expectedName = `${base}-expected.json`;
        const screenshotName = `${base}-screen.png`;
        writeJsonAtomic(path.join(directory, rawName), failure.rawReading ?? null);
        writeJsonAtomic(path.join(directory, expectedName), failure.expected ?? null);
        attachments.push(rawName, expectedName);
        const screenshot = captureScreenshot({ moduleName, taskId, failure });
        if (screenshot && typeof screenshot.then === "function") {
          attachmentStatus = "screenshot_pending";
          attachments.push(screenshotName);
          Promise.resolve(screenshot).then((content) => {
            if (!Buffer.isBuffer(content) || !content.length) throw new Error("task_passport_screenshot_unavailable");
            writeFileAtomic(path.join(directory, screenshotName), content);
            recordEvent(moduleName, taskId, {
              stage: "failure_attachment_capture", direction: "out", status: "saved",
              reasonCode: failure.reasonCode || "task_failure_reason_missing", ruleId: failure.ruleId,
              traceId: failure.traceId, attachments: [screenshotName], attachmentStatus: "saved"
            });
          }).catch((error) => {
            reportWriteFailure(error, { moduleName, taskId, stage: "failure_attachment_capture" });
            recordEvent(moduleName, taskId, {
              stage: "failure_attachment_capture", direction: "out", status: "failed",
              reasonCode: "task_passport_screenshot_failed", ruleId: failure.ruleId,
              traceId: failure.traceId, attachmentStatus: "screenshot_failed"
            });
          });
        } else {
          if (!Buffer.isBuffer(screenshot) || !screenshot.length) throw new Error("task_passport_screenshot_unavailable");
          writeFileAtomic(path.join(directory, screenshotName), screenshot);
          attachments.push(screenshotName);
        }
      }
    } catch (error) {
      attachmentStatus = "write_failed";
      reportWriteFailure(error, { moduleName, taskId, stage: failure.stage });
      const directory = taskDirectory(moduleName, taskId);
      const retained = attachments.filter((name) => {
        try { return fs.statSync(path.join(directory, name)).isFile(); } catch { return false; }
      });
      attachments.splice(0, attachments.length, ...retained);
    }
    const eventResult = recordEvent(moduleName, taskId, {
      stage: failure.stage || "failure",
      direction: "out",
      status: "failed",
      reasonCode: failure.reasonCode || "task_failure_reason_missing",
      ruleId: failure.ruleId,
      traceId: failure.traceId,
      attachments,
      attachmentStatus
    });
    return { ok: eventResult.ok, attachments, attachmentStatus };
  }

  function writeRunBill(moduleName, runId, results = []) {
    const normalized = (Array.isArray(results) ? results : []).map((result, index) => {
      const status = normalizedReason(result?.status, "failed");
      const reasonCode = TERMINAL_SUCCESS.has(status) ? "" : normalizedReason(result?.reasonCode || result?.reason_code || result?.blocked_reason);
      return {
        task_id: String(result?.taskId || result?.task_id || result?.id || index + 1),
        status,
        ...(reasonCode ? { reason_code: reasonCode } : {}),
        ...(result?.ruleId || result?.rule_id ? { rule_id: normalizedReason(result.ruleId || result.rule_id, "rule_id_invalid") } : {}),
        attachments: (Array.isArray(result?.attachments) ? result.attachments : []).map((name) => path.basename(String(name)))
      };
    });
    const summary = { total: normalized.length, success: 0, skipped: 0, failed: 0 };
    const reasonCounts = {};
    const ruleCounts = {};
    const resultCodeCounts = {};
    for (const result of normalized) {
      if (TERMINAL_SUCCESS.has(result.status)) summary.success += 1;
      else if (TERMINAL_SKIPPED.has(result.status)) summary.skipped += 1;
      else summary.failed += 1;
      if (result.reason_code) reasonCounts[result.reason_code] = (reasonCounts[result.reason_code] || 0) + 1;
      if (result.rule_id) ruleCounts[result.rule_id] = (ruleCounts[result.rule_id] || 0) + 1;
      const resultCode = result.rule_id || result.reason_code;
      if (resultCode) resultCodeCounts[resultCode] = (resultCodeCounts[resultCode] || 0) + 1;
    }
    const bill = {
      v: 1,
      generated_at: now().toISOString(),
      module: safeSegment(moduleName, "module"),
      run_id: safeSegment(runId, "run"),
      summary,
      reason_counts: reasonCounts,
      rule_counts: ruleCounts,
      result_code_counts: resultCodeCounts,
      failures: normalized.filter((result) => !TERMINAL_SUCCESS.has(result.status))
    };
    const directory = path.join(passportRoot, safeSegment(moduleName, "module"), "bills", safeSegment(runId, "run"));
    const jsonFile = path.join(directory, "run-bill.json");
    const textFile = path.join(directory, "run-bill.txt");
    try {
      fs.mkdirSync(directory, { recursive: true });
      writeJsonAtomic(jsonFile, bill);
      const lines = [
        `任务总账单 ${bill.run_id}`,
        `总量 ${summary.total}｜成功 ${summary.success}｜跳过 ${summary.skipped}｜失败 ${summary.failed}`,
        "",
        "原因分布：",
        ...Object.entries(resultCodeCounts).map(([reason, count]) => `- ${reason}: ${count}`),
        "",
        "未成功明细：",
        ...bill.failures.map((row) => `- ${row.task_id}｜${row.status}｜${row.reason_code || "task_failure_reason_missing"}｜${row.rule_id || "无规则号"}｜${row.attachments.join(", ") || "无附件"}`)
      ];
      writeFileAtomic(textFile, Buffer.from(`${lines.join("\n")}\n`, "utf8"));
    } catch (error) {
      reportWriteFailure(error, { moduleName, taskId: runId, stage: "run_bill" });
    }
    return { ...bill, jsonFile, textFile };
  }

  function bindTrace(moduleName, traceId, taskId) {
    const trace = String(traceId || "").trim();
    const task = String(taskId || "").trim();
    if (!trace || !task) return false;
    traceTasks.set(trace, { moduleName: String(moduleName || ""), taskId: task });
    return true;
  }

  function observeDiagnostic(entry = {}) {
    try {
      const traceId = String(entry.trace_id || "");
      const moduleName = String(entry.module || "");
      if (!["active_touch", "moments", "auto_reply"].includes(moduleName)) return;
      const rawTaskId = entry.details?.task_id;
      const directTaskId = typeof rawTaskId === "string" ? rawTaskId.trim() : "";
      const bound = traceTasks.get(traceId);
      if (traceId && directTaskId) traceTasks.set(traceId, { moduleName, taskId: directTaskId });
      const taskId = directTaskId || (bound?.moduleName === moduleName ? bound.taskId : "");
      if (!taskId) return;
      const event = recordEvent(entry.module, taskId, {
        stage: entry.event,
        direction: entry.phase === "start" ? "in" : "out",
        durationMs: entry.duration_ms,
        status: entry.level === "error" || entry.level === "fatal" ? "failed" : "observed",
        reasonCode: entry.code,
        ruleId: entry.details?.rule_id,
        traceId
      });
      if ((entry.level === "error" || entry.level === "fatal") && event.ok) {
        recordFailure(entry.module, taskId, {
          stage: entry.event,
          reasonCode: entry.code,
          ruleId: entry.details?.rule_id,
          traceId,
          rawReading: entry.details,
          expected: entry.details?.expected || { status: "success" }
        });
      }
    } catch (error) {
      reportWriteFailure(error, { stage: "diagnostic_observer" });
    }
  }

  function cleanup() {
    try {
      if (!fs.existsSync(passportRoot)) return { ok: true, removed: 0 };
      const cutoff = now().getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
      let removed = 0;
      const removeOldLeaves = (directory) => {
        if (fs.lstatSync(directory).isSymbolicLink()) return;
        for (const name of fs.readdirSync(directory)) {
          const child = path.join(directory, name);
          const stat = fs.lstatSync(child);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) removeOldLeaves(child);
        }
        if (directory === passportRoot) return;
        const remaining = fs.readdirSync(directory);
        const newest = remaining.reduce((value, name) => Math.max(value, fs.lstatSync(path.join(directory, name)).mtimeMs), fs.lstatSync(directory).mtimeMs);
        if (newest < cutoff) { fs.rmSync(directory, { recursive: true, force: true }); removed += 1; }
      };
      removeOldLeaves(passportRoot);
      return { ok: true, removed };
    } catch (error) {
      reportWriteFailure(error, { stage: "cleanup" });
      return { ok: false, removed: 0 };
    }
  }

  return { bindTrace, cleanup, observeDiagnostic, recordEvent, recordFailure, status: () => ({ writesFailed }), writeRunBill };
}

function collectTaskPassportFiles(rootDir) {
  const passportRoot = path.join(path.resolve(String(rootDir || "")), "task-passports");
  const files = [];
  let total = 0;
  try {
    walkFiles(passportRoot, (file, stat) => {
      if (stat.size > MAX_EXPORT_FILE_BYTES || total + stat.size > MAX_EXPORT_BYTES) return;
      const relative = path.relative(passportRoot, file);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return;
      const content = fs.readFileSync(file);
      total += content.length;
      files.push({
        name: `task-passports/${relative.split(path.sep).join("/")}`,
        content,
        size_bytes: content.length,
        sha256: crypto.createHash("sha256").update(content).digest("hex")
      });
    });
  } catch {}
  return files.sort((left, right) => left.name.localeCompare(right.name, "en"));
}

module.exports = { collectTaskPassportFiles, createTaskPassportStore };
