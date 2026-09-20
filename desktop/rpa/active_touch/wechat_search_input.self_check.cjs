const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function powershell(source) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())); Invoke-Expression $source"],
  { input: Buffer.from(source, "utf8").toString("base64"), encoding: "utf8", windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return JSON.parse(result.stdout.trim());
}

const driver = fs.readFileSync(path.join(__dirname, "wechat_window_driver.cjs"), "utf8");
const guardPath = path.join(__dirname, "wechat_search_input.cjs");
const { WECHAT_SEARCH_INPUT_GUARD_CSHARP } = require(guardPath);
let searchScript = "";
require("./wechat_window_driver.cjs").openWechatSearchResult("selfcheck", {
  pid: 1, hWnd: "1", runner(script) { searchScript = script; return { ok: false }; }
});
const csharp = /Add-Type @"\r?\n([\s\S]*?)\r?\n"@/u.exec(searchScript)?.[1];
assert.ok(csharp?.includes(WECHAT_SEARCH_INPUT_GUARD_CSHARP), "the actual search script must embed the receipt guard");
const source = Buffer.from(csharp, "utf8").toString("base64");
const encodedScript = Buffer.from(searchScript, "utf8").toString("base64");
const result = powershell(`
$ErrorActionPreference="Stop"
Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${source}")))
$tokens=$null; $parseErrors=$null
$null=[System.Management.Automation.Language.Parser]::ParseInput(([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encodedScript}"))), [ref]$tokens, [ref]$parseErrors)
function New-Receipt { $r=[WechatSearchInputReceipt]::new(); [void]$r.Begin([uint64]123, [uint32]100, 4); return $r }
function Complete-Owned($r) { for ($i=0; $i -lt 4; $i++) { $r.Keyboard(16, [uint64]123, [uint32]200) } }
$delayed=New-Receipt
$before=$delayed.Evaluate(4, [uint32]100, $false)
$delayed.Keyboard(16, [uint64]123, [uint32]200)
$partial=$delayed.Evaluate(4, [uint32]200, $false)
for ($i=0; $i -lt 3; $i++) { $delayed.Keyboard(16, [uint64]123, [uint32]200) }
$after=$delayed.Evaluate(4, [uint32]200, $false)
$external=New-Receipt; $external.Keyboard(0, [uint64]0, [uint32]150); Complete-Owned $external
$mouse=New-Receipt; $mouse.Mouse(); Complete-Owned $mouse
$foreign=New-Receipt; $foreign.Keyboard(16, [uint64]999, [uint32]200); Complete-Owned $foreign
$timeout=New-Receipt
$readFailed=New-Receipt; Complete-Owned $readFailed
$unknown=New-Receipt; Complete-Owned $unknown
$partialSend=New-Receipt; Complete-Owned $partialSend
$systemTime=New-Receipt; $systemTime.Keyboard(16, [uint64]123, [uint32]215)
$systemPending=$systemTime.Evaluate(4, [uint32]215, $false)
foreach ($tick in @(216, 217, 218)) { $systemTime.Keyboard(16, [uint64]123, [uint32]$tick) }
$earlierOwnedPending=$systemTime.Evaluate(4, [uint32]215, $false)
$systemConfirmed=$systemTime.Evaluate(4, [uint32]218, $false)
$invalidText=[Win32WechatWindowSearch]::AtomicUnicodeText("")
$invalidTextReason=[WechatSearchInputGuard]::FailureReason
$lateExternal=New-Receipt; Complete-Owned $lateExternal; $null=$lateExternal.Evaluate(4, [uint32]200, $false)
$lateExternal.Keyboard(0, [uint64]0, [uint32]200)
$hookStarted=$false
try { $hookStarted=[WechatSearchInputGuard]::Start(1) } finally { [WechatSearchInputGuard]::Stop() }
@{
  parseErrorCount=$parseErrors.Count; hookStarted=$hookStarted; hookStopped=[WechatSearchInputGuard]::IsStopped
  stoppedBeginRefused=([WechatSearchInputGuard]::Begin(4, [uint32]100) -eq [UIntPtr]::Zero)
  before=$before; partial=$partial; delayed=$after
  external=$external.Evaluate(4, [uint32]200, $false)
  mouse=$mouse.Evaluate(4, [uint32]200, $false)
  foreign=$foreign.Evaluate(4, [uint32]200, $false)
  timeout=$timeout.Evaluate(4, [uint32]100, $true)
  readFailed=$readFailed.Evaluate(4, [uint32]::MaxValue, $false)
  unknown=$unknown.Evaluate(4, [uint32]201, $false)
  partialSend=$partialSend.Evaluate(3, [uint32]200, $false)
  systemPending=$systemPending; earlierOwnedPending=$earlierOwnedPending; systemConfirmed=$systemConfirmed
  invalidText=$invalidText; invalidTextReason=$invalidTextReason
  lateExternal=$lateExternal.Evaluate(4, [uint32]200, $false)
} | ConvertTo-Json -Compress
`);
assert.equal(result.before, "pending");
assert.equal(result.partial, "pending", "first owned event is not a complete batch receipt");
assert.equal(result.delayed, "confirmed");
for (const key of ["external", "mouse", "foreign", "unknown", "lateExternal"]) {
  assert.equal(result[key], "wechat_external_input_detected", `${key} must remain blocked even after owned input overwrites the tick`);
}
assert.equal(result.timeout, "wechat_input_lease_unavailable");
assert.equal(result.readFailed, "wechat_input_lease_unavailable");
assert.equal(result.partialSend, "wechat_search_input_failed");
assert.equal(result.systemPending, "pending", "Windows event time may differ from the sender's precomputed clock");
assert.equal(result.earlierOwnedPending, "pending", "an earlier owned event must not confirm the final batch");
assert.equal(result.systemConfirmed, "confirmed", "only the final observed owned event may confirm the full batch");
assert.equal(result.invalidText, false);
assert.equal(result.invalidTextReason, "wechat_search_input_failed", "invalid input must retain its concrete reason");
assert.equal(result.parseErrorCount, 0, "the generated PowerShell must parse");
assert.equal(result.hookStarted, true, "the Windows hook must install without sending input");
assert.equal(result.hookStopped, true, "the search hook thread must be removed and joined");
assert.equal(result.stoppedBeginRefused, true, "an unavailable hook must never allow injection");
assert.match(driver, /WECHAT_SEARCH_INPUT_GUARD_CSHARP/);
assert.match(searchScript, /finally \{ \[WechatSearchInputGuard\]::Stop\(\) \}/u);
assert.doesNotMatch(searchScript, /SendKeys\]::SendWait/u, "all search keys must use owned receipts");
for (const phase of ["search_focus", "search_select_all", "search_query_input", "search_observation", "search_result_enter"]) {
  assert.ok(searchScript.includes(`$script:searchInputPhase = "${phase}"`), `missing input phase ${phase}`);
}
console.log("WeChat search owned-input self-check passed (no desktop input emitted)");
