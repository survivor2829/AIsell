// The chat-title reader service: started once on demand, its address published to child
// processes, cleared when it exits, never retried in a tight loop, and never required.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLineOcrService, ENV_URL, ENV_TOKEN } = require("./line-ocr-service.cjs");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() { child.exitCode = 0; child.emit("exit", 0); } };
  child.exitCode = null;
  child.kill = () => { child.exitCode = 1; child.emit("exit", 1); };
  return child;
}

(async () => {
  const runtime = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "line-ocr-")), "product-detail-server.exe");
  fs.writeFileSync(runtime, "");
  let clock = 1_000_000;
  const env = {};
  const spawned = [];
  const events = [];
  const service = createLineOcrService({
    resolveLaunch: () => ({ runtimePath: runtime, runtimeArgs: ["desktop_entry.py"] }),
    spawnProcess: (file, args, options) => {
      const child = fakeChild();
      spawned.push({ file, args, options, child });
      return child;
    },
    now: () => clock,
    env,
    onEvent: (event) => events.push(event)
  });

  // Two touch steps at once start one reader; the address and token reach the environment.
  const first = service.ensure();
  const second = service.ensure();
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ["desktop_entry.py", "--line-ocr-serve"]);
  assert.ok(spawned[0].options.env[ENV_TOKEN].length >= 32, "a fresh token per run");
  spawned[0].child.stdout.emit("data", "{\"port\": 50123}\n");
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(env[ENV_URL], "http://127.0.0.1:50123/read");
  assert.equal(env[ENV_TOKEN], spawned[0].options.env[ENV_TOKEN]);
  assert.equal(await service.ensure(), true);
  assert.equal(spawned.length, 1, "a running reader is reused");

  // It exits on its own: the address is withdrawn at once (scripts fall back to Windows' reading)
  // and it is not restarted for every contact, only after five minutes (review 2026-11-17).
  spawned[0].child.emit("exit", 3);
  assert.equal(env[ENV_URL], undefined);
  assert.equal(await service.ensure(), false);
  assert.equal(spawned.length, 1, "no restart storm after a crash");
  clock += 5 * 60_000 + 1;
  const again = service.ensure();
  spawned[1].child.stdout.emit("data", "{\"port\": 50124}\n");
  assert.equal(await again, true);

  // A broken start (bad protocol) is not retried on every contact, only after five minutes.
  service.stop();
  assert.equal(env[ENV_URL], undefined);
  const broken = service.ensure();
  spawned[2].child.stdout.emit("data", "not json\n");
  assert.equal(await broken, false);
  assert.equal(await service.ensure(), false);
  assert.equal(spawned.length, 3, "no retry within five minutes");
  clock += 5 * 60_000 + 1;
  const retried = service.ensure();
  assert.equal(spawned.length, 4);
  spawned[3].child.stdout.emit("data", "{\"port\": 50125}\n");
  assert.equal(await retried, true);
  service.stop();

  // No runtime (older component, damaged install): false, nothing spawned, no throw.
  const missing = createLineOcrService({ resolveLaunch: () => ({ runtimePath: path.join(os.tmpdir(), "missing-runtime.exe") }), env: {} });
  assert.equal(await missing.ensure(), false);
  assert.ok(events.includes("ready") && events.includes("unavailable"));

  // A reader that exits before it is up says why, as plain codes the diagnostics log keeps
  // readable ("kind", "error_type"), never the stderr text itself. Six customer computers sent
  // only a hashed "cause" for 1.3.30–1.3.35 (2026-11-18).
  const details = [];
  const crashing = createLineOcrService({
    resolveLaunch: () => ({ runtimePath: runtime }),
    spawnProcess: () => { const child = fakeChild(); spawned.push({ child }); return child; },
    env: {}, onEvent: (event, detail) => details.push({ event, ...detail })
  });
  const crashed = crashing.ensure();
  const crashChild = spawned[spawned.length - 1].child;
  crashChild.stderr.emit("data", "Traceback (most recent call last):\n  File \"line_ocr.py\", line 9\n");
  crashChild.stderr.emit("data", "onnxruntime.capi.onnxruntime_pybind11_state.Fail: [ONNXRuntimeError] 客户名字\nImportError: DLL load failed while importing onnxruntime_pybind11_state: [WinError 1114] 动态链接库(DLL)初始化例程失败。\n");
  crashChild.exitCode = 1;
  crashChild.emit("exit", 1);
  assert.equal(await crashed, false);
  assert.deepEqual(details.at(-1), { event: "unavailable", kind: "exited_1", error_type: "ImportError", win_error: 1114, onnxruntime: true });
  assert.ok(!JSON.stringify(details).includes("客户名字"), "no stderr text reaches the event");
  const { exitEvidence } = require("./line-ocr-service.cjs");
  assert.deepEqual(exitEvidence("[PYI-1234:ERROR] Failed to load Python DLL 'python311.dll'.\n"), { launcher_failed: true });
  assert.deepEqual(exitEvidence(""), {});

  // A component that has the runtime but not the model is named as such, nothing spawned.
  const before = spawned.length;
  const noModel = createLineOcrService({ resolveLaunch: () => ({ runtimePath: runtime, requiredFiles: [path.join(os.tmpdir(), "no-such-model.onnx")] }),
    spawnProcess: () => { throw new Error("must not spawn"); }, env: {}, onEvent: (event, detail) => details.push({ event, ...detail }) });
  assert.equal(await noModel.ensure(), false);
  assert.equal(spawned.length, before);
  assert.deepEqual(details.at(-1), { event: "unavailable", kind: "model_missing" });

  // The reasons survive the real diagnostics redaction (a key named "cause" was hashed).
  const { createDiagnosticLogger } = require("./diagnostics.cjs");
  const diag = createDiagnosticLogger({ rootDir: fs.mkdtempSync(path.join(os.tmpdir(), "line-ocr-diag-")) });
  diag.event("active_touch", "line_ocr.unavailable", { kind: "exited_1", error_type: "ImportError", win_error: 1114, onnxruntime: true }, { level: "warn" });
  const logged = JSON.stringify(diag.readRecent(10));
  assert.match(logged, /"kind":"exited_1"/u);
  assert.match(logged, /"error_type":"ImportError"/u);
  assert.match(logged, /"win_error":1114/u);

  // End to end with the real reader when the development runtime and model are present.
  const python = path.join(__dirname, "..", "..", ".build", "product-detail-venv", "Scripts", "python.exe");
  const model = path.join(__dirname, "..", "..", ".build", "line-ocr-models", "ch_PP-OCRv4_rec_infer.onnx");
  const entry = path.join(__dirname, "..", "..", "sidecars", "product-detail", "app", "desktop_entry.py");
  if (fs.existsSync(python) && fs.existsSync(model)) {
    const realEnv = { ...process.env };
    const real = createLineOcrService({ resolveLaunch: () => ({ runtimePath: python, runtimeArgs: [entry] }), env: realEnv });
    try {
      assert.equal(await real.ensure(), true, "the real reader starts");
      const health = await fetch(realEnv[ENV_URL].replace("/read", "/health"), { headers: { "X-Xiaoxi-Token": realEnv[ENV_TOKEN] } });
      assert.equal(health.status, 200);
      const refused = await fetch(realEnv[ENV_URL], { method: "POST", headers: { "X-Xiaoxi-Token": "wrong" }, body: "x" });
      assert.equal(refused.status, 403, "a wrong token is refused");
    } finally {
      real.stop();
    }
    console.log("line OCR service checks passed (with the real reader)");
  } else {
    console.log("line OCR service checks passed (real reader skipped: runtime or model not prepared)");
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
