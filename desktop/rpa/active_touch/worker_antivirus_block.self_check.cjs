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
  assert.equal(normalizeAtomicSendResult(ordinary).sendResult, "outcome_unknown",
    "an ordinary crash mid-script may have clicked: it stays outcome_unknown and is never resent");

  const policy = classifyWechatFailure({ blocked_reason: "powershell_blocked_by_antivirus" });
  assert.deepEqual({ known: policy.known, classification: policy.classification, scope: policy.attentionScope },
    { known: true, classification: "blocker", scope: "global" });
  console.log("worker antivirus block self-check passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
