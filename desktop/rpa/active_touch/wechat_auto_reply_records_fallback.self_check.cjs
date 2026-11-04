// Development machine, WeChat 4.2.0.12, 2026-11-04: the customer answered "您好";
// a reply was generated, but before sending, OCR missed that short bubble and
// read our older "城总，您好，测试" (as "瞠茜到您好。测试") as the latest message.
// The check said "the customer's message changed" and the reply was never sent.
// With WeChat's records confirming the customer spoke last, a green bubble that
// is one of our earlier recorded texts is unread text, left to the records.
// Replayed on the real screenshot (not stored here: a real conversation).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, visualSendEnvironment } = require("./wechat_auto_reply_visual_send.dev.cjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-reply-records-"));
try {
  const env = visualSendEnvironment({ recordedEarlierOutgoing: ["城总，您好，测试", "x".repeat(900), "b", "c"] }, "draft");
  const decoded = JSON.parse(Buffer.from(env.XIAOXI_VISUAL_SEND_EARLIER_OUTGOING, "base64").toString("utf8"));
  assert.deepEqual(decoded.map((text) => text.length), [500, 1, 1], "at most the last three recorded texts, each bounded");
  assert.equal(JSON.parse(Buffer.from(visualSendEnvironment({}, "draft").XIAOXI_VISUAL_SEND_EARLIER_OUTGOING, "base64").toString("utf8")).length, 0);

  const scriptFile = path.join(dir, "visual.ps1");
  fs.writeFileSync(scriptFile, "﻿" + WECHAT_VISUAL_AUTO_REPLY_POWERSHELL, "utf8");
  const harnessFile = path.join(dir, "harness.ps1");
  fs.writeFileSync(harnessFile, "﻿" + String.raw`
param([string]$ScriptFile)
$ErrorActionPreference = "Stop"
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptFile, [ref]$tokens, [ref]$errors)
foreach ($name in @("Normalize-VisualSendText", "Get-VisualSendEditDistance", "Test-VisualSendRecordedEarlierOutgoing")) {
  $function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  . ([ScriptBlock]::Create($function.Extent.Text))
}
$recordedEarlierOutgoing = @("城总，您好，测试")
$results = [ordered]@{
  field = Test-VisualSendRecordedEarlierOutgoing "瞠茜到您好。测试"
  exact = Test-VisualSendRecordedEarlierOutgoing "城总，您好，测试"
  unrelated = Test-VisualSendRecordedEarlierOutgoing "明天下午三点到店看样机"
  tooShort = Test-VisualSendRecordedEarlierOutgoing "好的"
}
$recordedEarlierOutgoing = @()
$results.noRecords = Test-VisualSendRecordedEarlierOutgoing "城总，您好，测试"
$results | ConvertTo-Json -Compress
`, "utf8");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", harnessFile, "-ScriptFile", scriptFile],
    { encoding: "utf8", windowsHide: true, timeout: 120000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()),
    { field: true, exact: true, unrelated: false, tooShort: false, noRecords: false });

  // The fallback is reached only with records confirming the customer spoke last.
  assert.match(WECHAT_VISUAL_AUTO_REPLY_POWERSHELL,
    /if \(\$latestRole -ceq "assistant"\) \{[\s\S]*?\$incomingConfirmedByRecords -and \(Test-VisualSendRecordedEarlierOutgoing[\s\S]*?return @\{ state = "proven_different" \}/u);
  console.log("auto-reply records fallback self-check passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
