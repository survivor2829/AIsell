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
  const destination = path.join(root, "diagnostics.zip");
  const logger = createLogger(logsDir);
  const current = Buffer.from('{"event":"current"}\n', "utf8");
  const archived = Buffer.from('{"event":"archived"}\n', "utf8");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, "diagnostics.jsonl"), current);
  fs.writeFileSync(path.join(logsDir, "diagnostics.jsonl.1"), archived);
  fs.writeFileSync(path.join(logsDir, "unrelated.txt"), "must not be exported");

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
  try {
    ({ exportBundle } = require(modulePath));
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }

  try {
    const exported = await exportBundle({ app: electron.app, dialog: electron.dialog, logger });
    assert.equal(exported.ok, true, "diagnostic export must not depend on PowerShell or Compress-Archive");
    assert.equal(spawnCalls, 0, "diagnostic export must stay inside the packaged Node runtime");

    const archive = await JSZip.loadAsync(fs.readFileSync(destination), { checkCRC32: true });
    assert.deepEqual(
      Object.keys(archive.files).sort(),
      ["diagnostics.jsonl", "diagnostics.jsonl.1", "summary.json"],
      "diagnostic ZIP must contain every retained unified log and its summary"
    );
    assert.deepEqual(await archive.file("diagnostics.jsonl").async("nodebuffer"), current);
    assert.deepEqual(await archive.file("diagnostics.jsonl.1").async("nodebuffer"), archived);

    const summaryText = await archive.file("summary.json").async("string");
    const summary = JSON.parse(summaryText);
    assert.equal(summaryText.includes(root), false, "exported summary must not disclose an absolute user path");
    assert.deepEqual(summary.included_files, [
      { name: "diagnostics.jsonl", size_bytes: current.length, sha256: sha256(current) },
      { name: "diagnostics.jsonl.1", size_bytes: archived.length, sha256: sha256(archived) }
    ]);
    assert.equal("logDirectory" in summary.diagnostics, false);
    assert.equal("logFile" in summary.diagnostics, false);

    const replacement = Buffer.from('{"event":"replacement"}\n', "utf8");
    fs.writeFileSync(path.join(logsDir, "diagnostics.jsonl"), replacement);
    const replaced = await exportBundle({ app: electron.app, dialog: electron.dialog, logger });
    assert.equal(replaced.ok, true, "a verified archive must atomically replace an older destination");
    const replacedArchive = await JSZip.loadAsync(fs.readFileSync(destination), { checkCRC32: true });
    assert.deepEqual(await replacedArchive.file("diagnostics.jsonl").async("nodebuffer"), replacement);

    const knownGood = Buffer.from("known-good-diagnostic-archive", "utf8");
    fs.writeFileSync(destination, knownGood);
    const failed = await exportBundle({
      app: electron.app,
      dialog: electron.dialog,
      logger,
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
