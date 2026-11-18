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

  // The app gets the start-up output once, for its report; it never goes into the event itself.
  const locals = [];
  const reporting = createLineOcrService({
    resolveLaunch: () => ({ runtimePath: runtime }),
    spawnProcess: () => { const child = fakeChild(); spawned.push({ child }); return child; },
    env: {}, onEvent: (event, detail, local) => locals.push({ event, detail, local })
  });
  const reported = reporting.ensure();
  spawned.at(-1).child.stderr.emit("data", "ModuleNotFoundError: No module named 'numpy'\n");
  spawned.at(-1).child.exitCode = 1;
  spawned.at(-1).child.emit("exit", 1);
  await reported;
  assert.match(locals.at(-1).local.stderr, /No module named 'numpy'/u);
  assert.equal(locals.at(-1).local.launch.runtimePath, runtime);
  assert.ok(!JSON.stringify(locals.at(-1).detail).includes("numpy"));

  // probe() after launch: a reader nobody asked for meanwhile is stopped again; one a touch step
  // asked for during the check keeps running.
  const probeEnv = {};
  const probed = createLineOcrService({ resolveLaunch: () => ({ runtimePath: runtime }), env: probeEnv,
    spawnProcess: () => { const child = fakeChild(); spawned.push({ child }); return child; } });
  const check = probed.probe();
  spawned.at(-1).child.stdout.emit("data", "{\"port\": 50200}\n");
  assert.equal(await check, true);
  assert.equal(probed.running(), false, "a probe alone does not keep the reader");
  assert.equal(probeEnv[ENV_URL], undefined);
  const check2 = probed.probe();
  const wanted = probed.ensure();
  spawned.at(-1).child.stdout.emit("data", "{\"port\": 50201}\n");
  assert.deepEqual(await Promise.all([check2, wanted]), [true, true]);
  assert.equal(probed.running(), true, "a touch step that asked meanwhile keeps it");
  probed.stop();

  // The packaged reader starts below the short junction, never from the update folder itself
  // (1.3.38: from there onnxruntime's DLL path was too long on most customer computers).
  const { createLineOcrLaunch } = require("./line-ocr-launch.cjs");
  const updateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "line-ocr-launch-"));
  const deepResources = path.join(updateRoot, "generations", "a".repeat(64), "resources");
  const deepRuntime = path.join(deepResources, "product-detail", "product-detail-server.exe");
  fs.mkdirSync(path.join(path.dirname(deepRuntime), "_internal", "models"), { recursive: true });
  fs.writeFileSync(deepRuntime, "exe");
  fs.writeFileSync(path.join(path.dirname(deepRuntime), "_internal", "line_ocr_model.json"), JSON.stringify({ file: "m.onnx" }));
  fs.writeFileSync(path.join(path.dirname(deepRuntime), "_internal", "models", "m.onnx"), "model");
  const pdData = path.join(updateRoot, "pd-data");
  let prepared = 0;
  const realPrepare = require("./runtime-link.cjs").prepareRuntimeLaunch;
  const launchFor = createLineOcrLaunch({ runtimePath: () => deepRuntime, dataDir: pdData, platform: "win32",
    prepare: (...args) => { prepared += 1; return realPrepare(...args); } });
  const linked = launchFor();
  assert.equal(linked.shortLink, "linked");
  assert.ok(linked.runtimePath.startsWith(path.join(pdData, ".runtime-links")), linked.runtimePath);
  assert.ok(linked.runtimePath.length < deepRuntime.length);
  assert.ok(linked.requiredFiles.every((file) => file.startsWith(pdData) && fs.existsSync(file)), "files are checked where they are loaded from");
  assert.equal(launchFor(), linked);
  assert.equal(prepared, 1, "the junction work is done once per runtime");
  const failing = createLineOcrLaunch({ runtimePath: deepRuntime, dataDir: pdData, platform: "win32",
    prepare: () => { throw Object.assign(new Error("x"), { code: "RUNTIME_LINK_FAILED" }); } })();
  assert.equal(failing.runtimePath, deepRuntime);
  assert.equal(failing.shortLink, "failed_runtime_link_failed", "the report says the link could not be made");
  fs.unlinkSync(path.dirname(path.dirname(linked.runtimePath)));
  assert.ok(fs.existsSync(deepRuntime), "removing the link leaves the component alone");

  // A failed check at launch (busy computer) does not hold back the first touch step for five minutes.
  const slowEnv = {};
  const slow = createLineOcrService({ resolveLaunch: () => ({ runtimePath: runtime }), env: slowEnv,
    spawnProcess: () => { const child = fakeChild(); spawned.push({ child }); return child; } });
  const slowCheck = slow.probe();
  spawned.at(-1).child.exitCode = 1;
  spawned.at(-1).child.emit("exit", 1);
  assert.equal(await slowCheck, false);
  const firstStep = slow.ensure();
  spawned.at(-1).child.stdout.emit("data", "{\"port\": 50300}\n");
  assert.equal(await firstStep, true, "the touch step starts the reader itself");
  slow.stop();

  // The Windows user name never leaves in the output, in any spelling.
  const { withoutUserName } = require("./line-ocr-report.cjs");
  const user = os.userInfo().username;
  const scrubbed = withoutUserName(`File "C:\\Users\\${user}\\x.py"\nC:\\USERS\\ZHANGS~1\\AppData\\Local\\Temp\\_MEI\nD:/users/Someone/y\nname=${user.toUpperCase()}`);
  assert.ok(!scrubbed.toLowerCase().includes(user.toLowerCase()), scrubbed);
  assert.ok(!scrubbed.includes("ZHANGS~1") && !scrubbed.includes("Someone"), scrubbed);
  assert.match(scrubbed, /C:\\Users\\<user>\\x\.py/u);

  // The report: start-up output and what the reader's folder holds (model present and intact,
  // onnxruntime and runtime DLLs), the system, never more than 8 KB of output.
  const { buildLineOcrStartupReport, writeLineOcrStartupReport } = require("./line-ocr-report.cjs");
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "line-ocr-report-"));
  const internal = path.join(appRoot, "_internal");
  fs.mkdirSync(path.join(internal, "models"), { recursive: true });
  fs.mkdirSync(path.join(internal, "onnxruntime", "capi"), { recursive: true });
  fs.writeFileSync(path.join(appRoot, "product-detail-server.exe"), "exe");
  fs.writeFileSync(path.join(internal, "models", "m.onnx"), "model");
  const sha = require("node:crypto").createHash("sha256").update("model").digest("hex");
  fs.writeFileSync(path.join(internal, "line_ocr_model.json"), JSON.stringify({ name: "PP", file: "m.onnx", sha256: sha }));
  fs.writeFileSync(path.join(internal, "onnxruntime", "capi", "onnxruntime.dll"), "dll");
  fs.writeFileSync(path.join(internal, "vcruntime140.dll"), "dll");
  fs.writeFileSync(path.join(internal, "python311.dll"), "dll");
  const report = buildLineOcrStartupReport({ details: { kind: "exited_1" }, launch: { runtimePath: path.join(appRoot, "product-detail-server.exe") },
    stderr: "x".repeat(9000) + "\nOSError: [WinError 126]", appVersion: "1.3.37" });
  assert.equal(report.reason.kind, "exited_1");
  assert.equal(report.output_tail.length, 8192);
  assert.match(report.output_tail, /WinError 126/u);
  assert.equal(report.files.model.sha256_matches, true);
  assert.equal(report.files.runtime.present, true);
  assert.deepEqual(report.files.onnxruntime, { dll: true, pybind: false, providers_shared: false });
  assert.deepEqual(report.files.msvc, { "vcruntime140.dll": true, "vcruntime140_1.dll": false, "msvcp140.dll": false, "MSVCP140_1.dll": false });
  assert.deepEqual(report.files.python_dlls, ["python311.dll"]);
  fs.writeFileSync(path.join(internal, "models", "m.onnx"), "damaged");
  assert.equal(buildLineOcrStartupReport({ launch: { runtimePath: path.join(appRoot, "product-detail-server.exe") } }).files.model.sha256_matches, false);
  const written = writeLineOcrStartupReport(appRoot, report);
  assert.equal(path.basename(path.dirname(written)), "failure-reports", "where the capsule collects it (flight-recorder.cjs collectReports)");

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
  diag.event("line_ocr", "line_ocr.unavailable", { kind: "exited_1", error_type: "ImportError", win_error: 1114, onnxruntime: true }, { level: "warn" });
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
