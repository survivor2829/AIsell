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
  const autoReplyCurrent = Buffer.from('{"event":"poll_failed","code":"scan_timeout"}\n', "utf8");
  const autoReplyArchived = Buffer.from('{"event":"reply_skipped","code":"handoff_required"}\n', "utf8");
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
  const electron = {
    app: {
      getAppPath: () => root,
      getPath: () => root
    },
    dialog: {
      showSaveDialog: async () => ({ canceled: false, filePath: destination })
    },
    ipcMain: { handle: () => undefined },
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
