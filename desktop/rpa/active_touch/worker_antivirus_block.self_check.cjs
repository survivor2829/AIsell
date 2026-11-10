// Field 2026-11-04 (development machine, WeChat 4.2): Defender refused the send
// script while PowerShell loaded it. Nothing ran, but the generic failure was
// treated as "maybe sent": the contact counted as touched and no message left.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { runPowerShellAsync, powershellBlockedByAntivirus } = require("./wechat_window_driver.cjs");
const { normalizeAtomicSendResult } = require("./wechat_window_driver.dev.cjs");
const { classifyWechatFailure } = require("../../src/shared/wechat-failure-policy.cjs");

const DEFENDER_STDERR = "#< CLIXML\r\n<Objs><S S=\"Error\">This script contains malicious content and has been blocked by your antivirus software._x000D__x000A_</S>"
  + "<S S=\"Error\">    + FullyQualifiedErrorId : ScriptContainedMaliciousContent_x000D__x000A_</S></Objs>";

function fakeSpawn({ stderr, status }) {
  return () => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stdin = { write() {}, end() {}, on() {} };
    child.kill = () => true;
    child.pid = 4242;
    setImmediate(() => {
      child.stderr.emit("data", stderr);
      child.emit("close", status);
    });
    return child;
  };
}

(async () => {
  assert.equal(powershellBlockedByAntivirus(DEFENDER_STDERR), true);
  assert.equal(powershellBlockedByAntivirus("At line:3 char:1\r\n+ ParserError"), false, "an ordinary script error is not an antivirus block");

  const blocked = await runPowerShellAsync("exit 0", {}, { ensure: false, spawnProcess: fakeSpawn({ stderr: DEFENDER_STDERR, status: 1 }) });
  assert.equal(blocked.reason, "powershell_blocked_by_antivirus", JSON.stringify(blocked));
  assert.equal(blocked.sendAttempted, false);
  assert.equal(normalizeAtomicSendResult(blocked).sendResult, "not_attempted",
    "a script that never ran must not become outcome_unknown (counted as sent)");

  const ordinary = await runPowerShellAsync("exit 0", {}, { ensure: false, spawnProcess: fakeSpawn({ stderr: "boom", status: 1 }) });
  assert.equal(ordinary.reason, "powershell_failed");

  // The worker's error kind travels on every computer (1.2.69: the customer's PowerShell error
  // was never kept). Only exception names, error ids and HRESULTs: no quoted text, no Chinese.
  const { workerErrorKinds } = require("./wechat_window_driver.cjs");
  const CLIPBOARD_STDERR = "Exception calling \"GetText\" with \"0\" argument(s): \"向锦涛 13800138000\"\r\n"
    + "At line:12 char:5\r\n    + CategoryInfo : NotSpecified: (:) [], MethodInvocationException\r\n"
    + "    + FullyQualifiedErrorId : ExternalException\r\nSystem.Runtime.InteropServices.COMException (0x800401D0): 剪贴板打不开";
  const kinds = workerErrorKinds(CLIPBOARD_STDERR);
  assert.deepEqual(kinds, ["MethodInvocationException", "ExternalException", "System.Runtime.InteropServices.COMException", "0x800401D0"]);
  assert.ok(!/向锦涛|138|GetText|剪贴板/.test(kinds.join(" ")), "no quoted text, number or Chinese leaves the computer");
  // Chinese Windows quotes with “…”; what is inside, even ASCII, stays on the computer.
  const chinese = "使用“0”个参数调用“GetText”时发生异常:“客户 PaymentError 0x1A2B3C4D”\r\n    + CategoryInfo : NotSpecified: (:) [], MethodInvocationException";
  assert.deepEqual(workerErrorKinds(chinese), ["MethodInvocationException"]);
  // An apostrophe is not a quote: the error names after it are kept.
  const apostrophe = "The process can't access the file\r\n    + CategoryInfo : NotSpecified: (:) [], IOException\r\n    + FullyQualifiedErrorId : doesn't_matter,IOException";
  assert.ok(workerErrorKinds(apostrophe).includes("IOException"), JSON.stringify(workerErrorKinds(apostrophe)));
  const failed = await runPowerShellAsync("exit 0", {}, { ensure: false, spawnProcess: fakeSpawn({ stderr: CLIPBOARD_STDERR, status: 1 }) });
  assert.deepEqual(failed.diagnostics?.worker_error_kind, kinds, "kept without internal diagnostics");
  const { sanitizeFailureDiagnostics } = require("../../src/shared/failure-diagnostics.cjs");
  assert.deepEqual(sanitizeFailureDiagnostics({ worker_error_kind: [...kinds, "带中文", "x\"y"] }).worker_error_kind, kinds);
  assert.equal(normalizeAtomicSendResult(ordinary).sendResult, "outcome_unknown",
    "an ordinary crash mid-script may have clicked: it stays outcome_unknown and is never resent");

  const policy = classifyWechatFailure({ blocked_reason: "powershell_blocked_by_antivirus" });
  assert.deepEqual({ known: policy.known, classification: policy.classification, scope: policy.attentionScope },
    { known: true, classification: "blocker", scope: "global" });
  console.log("worker antivirus block self-check passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
