const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const JSZip = require("jszip");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createLogger(logsDir) {
  return {
    logsDir,
    begin: () => ({
      end: () => undefined,
      fail: () => undefined
    }),
    status: () => ({
      ok: true,
      data: {
        runId: "diagnostics-export-self-check",
        logDirectory: logsDir,
        logFile: path.join(logsDir, "diagnostics.jsonl"),
        currentBytes: fs.statSync(path.join(logsDir, "diagnostics.jsonl")).size,
        recentCount: 2,
        recentErrorCount: 2,
        writesFailed: 0,
        latest: [],
        latestErrors: []
      }
    })
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-diagnostics-export-"));
  const logsDir = path.join(root, "logs");
  const autoReplyDir = path.join(root, "auto_reply_runtime");
  const destination = path.join(root, "diagnostics.zip");
  const logger = createLogger(logsDir);
  const current = Buffer.from('{"event":"current"}\n', "utf8");
  const archived = Buffer.from('{"event":"archived"}\n', "utf8");
  const autoReplyCurrent = Buffer.from([
    JSON.stringify({
      v: 1,
      ts: "2026-09-01T02:23:10.000Z",
      run_id: "0123456789abcdef",
      seq: 7,
      event: "reply_decision",
      status: "running",
      phase: "generate",
      code: "reply_ready",
      trace_id: "0123456789abcdef01234567",
      action: "answer",
      reason_code: "general_guidance",
      duration_ms: 1234,
      customer_name: "private-contact-canary",
      message: "private-message-canary",
      expert_rules: "private-expert-rules-canary",
      business_knowledge: "private-business-knowledge-canary",
      api_key: "sk-private-key-canary"
    }),
    JSON.stringify({
      v: 1,
      ts: "2026-09-01T02:23:11.000Z",
      run_id: "fedcba9876543210",
      seq: 8,
      event: "reply_send_finished",
      status: "running",
      phase: "send",
      code: "sent_verified",
      trace_id: "0123456789abcdef01234567",
      action: "answer",
      reason_code: "general_guidance",
      duration_ms: 4321,
      delivery_attempt: 1,
      send_attempted: true,
      send_result: "sent_verified"
    }),
    JSON.stringify({
      ts: "2026-09-01T02:23:12.000Z",
      event: "客户原文不应进入事件字段",
      code: "sk-private-key-canary",
      phase: "C:/Users/Scott/private",
      trace_id: "private-contact-canary"
    }),
    "{invalid-tail"
  ].join("\n") + "\n", "utf8");
  const autoReplyArchived = Buffer.from(`${JSON.stringify({
    v: 1,
    ts: "2026-08-31T02:23:09.000Z",
    run_id: "1123456789abcdef",
    seq: 6,
    event: "reply_candidate_detected",
    status: "running",
    phase: "candidate",
    code: "candidate_accepted",
    trace_id: "1123456789abcdef01234567"
  })}\n`, "utf8");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(autoReplyDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, "diagnostics.jsonl"), current);
  fs.writeFileSync(path.join(logsDir, "diagnostics.jsonl.1"), archived);
  fs.writeFileSync(path.join(logsDir, "unrelated.txt"), "must not be exported");
  fs.writeFileSync(path.join(autoReplyDir, "auto-reply-diagnostics.jsonl"), autoReplyCurrent);
  fs.writeFileSync(path.join(autoReplyDir, "auto-reply-diagnostics.jsonl.1"), autoReplyArchived);
  fs.writeFileSync(path.join(autoReplyDir, "auto-reply-diagnostics.jsonl.old"), "must not be exported");
  fs.writeFileSync(path.join(autoReplyDir, "conversation-state.json"), "customer-message-must-not-be-exported");
  fs.writeFileSync(path.join(root, "auto-reply-diagnostics.jsonl"), "outside-runtime-must-not-be-exported");

  let spawnCalls = 0;
  const ipcHandlers = new Map();
  const electron = {
    app: {
      getAppPath: () => root,
      getPath: () => root
    },
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: destination })
    },
    ipcMain: { handle: (channel, handler) => ipcHandlers.set(channel, handler) },
    shell: { openPath: async () => "" }
  };
  const childProcess = {
    spawn: () => {
      spawnCalls += 1;
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        child.stderr.emit("data", Buffer.from("Compress-Archive unavailable", "utf8"));
        child.emit("close", 1);
      });
      return child;
    }
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") return electron;
    if (request === "node:child_process") return childProcess;
    if (request === "./diagnostics.cjs") return { diagnostics: () => logger };
    return originalLoad.call(this, request, parent, isMain);
  };

  const modulePath = require.resolve("./diagnostics-ipc.cjs");
  delete require.cache[modulePath];
  let exportBundle;
  let registerDiagnosticsIpc;
  try {
    ({ exportBundle, registerDiagnosticsIpc } = require(modulePath));
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }

  try {
    assert.doesNotThrow(
      () => registerDiagnosticsIpc(),
      "registerDiagnosticsIpc must remain compatible with callers that pass no options"
    );
    registerDiagnosticsIpc({ autoReplyDir });
    const statusResult = ipcHandlers.get("diagnostics:status")();
    assert.equal(statusResult.ok, true);
    assert.deepEqual(statusResult.data.autoReplyLatest, [
      {
        ts: "2026-09-01T02:23:11.000Z",
        event: "reply_send_finished",
        status: "running",
        phase: "send",
        code: "sent_verified",
        trace_id: "0123456789abcdef01234567",
        action: "answer",
        reason_code: "general_guidance",
        duration_ms: 4321,
        delivery_attempt: 1,
        send_attempted: true,
        send_result: "sent_verified"
      },
      {
        ts: "2026-09-01T02:23:10.000Z",
        event: "reply_decision",
        status: "running",
        phase: "generate",
        code: "reply_ready",
        trace_id: "0123456789abcdef01234567",
        action: "answer",
        reason_code: "general_guidance",
        duration_ms: 1234
      },
      {
        ts: "2026-08-31T02:23:09.000Z",
        event: "reply_candidate_detected",
        status: "running",
        phase: "candidate",
        code: "candidate_accepted",
        trace_id: "1123456789abcdef01234567"
      }
    ], "diagnostics status must expose a recent allowlisted auto-reply chain independently from unified errors");
    const visibleStatus = JSON.stringify(statusResult.data.autoReplyLatest);
    assert.doesNotMatch(visibleStatus, /private|客户原文|Scott|sk-/iu, "visible auto-reply diagnostics must not expose customer, expert, path, or Key material");
    const diagnosticsRenderer = fs.readFileSync(path.join(__dirname, "../renderer/Diagnostics.tsx"), "utf8");
    assert.match(diagnosticsRenderer, /自动回复链路/u, "diagnostics UI must expose the dedicated auto-reply chain");
    assert.match(diagnosticsRenderer, /近期异常/u, "diagnostics UI must keep a dedicated error list");
    assert.match(diagnosticsRenderer, /近期运行事件/u, "diagnostics UI must keep normal unified events visible");
    assert.match(diagnosticsRenderer, /diagnostics-auto-reply-table/u, "auto-reply diagnostics must use its bounded semantic table layout");
    assert.match(diagnosticsRenderer, /colSpan=\{5\}/u, "the compact auto-reply table must keep its five-column empty state aligned");
    assert.doesNotMatch(diagnosticsRenderer, /latestErrors\.length\s*\?\s*status\.latestErrors\s*:\s*status\?\.latest/u, "normal events must not disappear whenever an error exists");
    const invalidAutoReplyDir = path.join(root, "auto-reply-log-is-a-file");
    fs.writeFileSync(invalidAutoReplyDir, "fixture", "utf8");
    registerDiagnosticsIpc({ autoReplyDir: invalidAutoReplyDir });
    const degradedStatus = ipcHandlers.get("diagnostics:status")();
    assert.equal(degradedStatus.ok, true, "a transient auto-reply log read failure must not hide the whole diagnostics page");
    assert.deepEqual(degradedStatus.data.autoReplyLatest, []);
    const exported = await exportBundle({
      app: electron.app,
      dialog: electron.dialog,
      logger,
      autoReplyDir
    });
    assert.equal(exported.ok, true, "diagnostic export must not depend on PowerShell or Compress-Archive");
    assert.equal(spawnCalls, 0, "diagnostic export must stay inside the packaged Node runtime");

    const archive = await JSZip.loadAsync(fs.readFileSync(destination), { checkCRC32: true });
    assert.deepEqual(
      Object.keys(archive.files).sort(),
      [
        "auto_reply/",
        "auto_reply/auto-reply-diagnostics.jsonl",
        "auto_reply/auto-reply-diagnostics.jsonl.1",
        "diagnostics.jsonl",
        "diagnostics.jsonl.1",
        "summary.json"
      ],
      "diagnostic ZIP must contain only retained unified logs, safe auto-reply diagnostics, and its summary"
    );
    assert.deepEqual(await archive.file("diagnostics.jsonl").async("nodebuffer"), current);
    assert.deepEqual(await archive.file("diagnostics.jsonl.1").async("nodebuffer"), archived);
    assert.deepEqual(await archive.file("auto_reply/auto-reply-diagnostics.jsonl").async("nodebuffer"), autoReplyCurrent);
    assert.deepEqual(await archive.file("auto_reply/auto-reply-diagnostics.jsonl.1").async("nodebuffer"), autoReplyArchived);
    assert.equal(archive.file("auto_reply/auto-reply-diagnostics.jsonl.old"), null);
    assert.equal(archive.file("auto_reply/conversation-state.json"), null);

    const summaryText = await archive.file("summary.json").async("string");
    const summary = JSON.parse(summaryText);
    assert.equal(summaryText.includes(root), false, "exported summary must not disclose an absolute user path");
    assert.deepEqual(summary.included_files, [
      { name: "diagnostics.jsonl", size_bytes: current.length, sha256: sha256(current) },
      { name: "diagnostics.jsonl.1", size_bytes: archived.length, sha256: sha256(archived) },
      { name: "auto_reply/auto-reply-diagnostics.jsonl", size_bytes: autoReplyCurrent.length, sha256: sha256(autoReplyCurrent) },
      { name: "auto_reply/auto-reply-diagnostics.jsonl.1", size_bytes: autoReplyArchived.length, sha256: sha256(autoReplyArchived) }
    ]);
    assert.equal("logDirectory" in summary.diagnostics, false);
    assert.equal("logFile" in summary.diagnostics, false);

    const replacement = Buffer.from('{"event":"replacement"}\n', "utf8");
    fs.writeFileSync(path.join(logsDir, "diagnostics.jsonl"), replacement);
    const replaced = await exportBundle({
      app: electron.app,
      dialog: electron.dialog,
      logger,
      autoReplyDir
    });
    assert.equal(replaced.ok, true, "a verified archive must atomically replace an older destination");
    const replacedArchive = await JSZip.loadAsync(fs.readFileSync(destination), { checkCRC32: true });
    assert.deepEqual(await replacedArchive.file("diagnostics.jsonl").async("nodebuffer"), replacement);

    const missingAutoReply = await exportBundle({
      app: electron.app,
      dialog: electron.dialog,
      logger,
      autoReplyDir: path.join(root, "missing-auto-reply-runtime")
    });
    assert.equal(missingAutoReply.ok, true, "a missing auto-reply diagnostics file must not block export");
    const missingAutoReplyArchive = await JSZip.loadAsync(fs.readFileSync(destination), { checkCRC32: true });
    assert.deepEqual(
      Object.keys(missingAutoReplyArchive.files).sort(),
      ["diagnostics.jsonl", "diagnostics.jsonl.1", "summary.json"]
    );

    const knownGood = Buffer.from("known-good-diagnostic-archive", "utf8");
    fs.writeFileSync(destination, knownGood);
    const failed = await exportBundle({
      app: electron.app,
      dialog: electron.dialog,
      logger,
      autoReplyDir,
      createArchive: async () => {
        throw new Error("simulated_zip_generation_failure");
      }
    });
    assert.equal(failed.ok, false);
    assert.deepEqual(
      fs.readFileSync(destination),
      knownGood,
      "a failed replacement must preserve the previous diagnostic archive"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(
  () => console.log("diagnostics IPC self-check passed"),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  }
);
