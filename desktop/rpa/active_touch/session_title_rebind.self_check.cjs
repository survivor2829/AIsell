// Customer computer, WeChat 4.2.0.8 (1.2.54-1.2.55, 2026-11-05): the name search opened the
// right chat, but the header-pixel token bound at the search click never matched the settled
// header, so every pre-send check failed as atomic_conversation_changed. A fresh observation
// that read the contact's title itself re-binds the conversation before anything is typed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadState, saveState } = require("./state_machine.cjs");
const { refreshRealSendSession, verifyRealSendSessionAsync } = require("./state_machine.dev.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-title-rebind-"));
const baseDir = path.join(root, "active_touch");
fs.mkdirSync(baseDir, { recursive: true });
const contact = { id: "c1", name: "测试客户", wechatId: "", wechatAccountId: "account-a" };
const fresh = () => saveState(baseDir, {
  ...loadState(baseDir),
  selected_customer: contact,
  wechat_account_id: "account-a",
  window_pid: 81,
  window_handle: "91",
  conversation_verification_mode: "conversation_title",
  conversation_token: "conversation:v2:81:91:visual:at-click",
  search_query: "测试客户",
  real_send_status: "not_sent"
});
const observed = (extra) => () => ({ ok: true, pid: 81, hWnd: "91", processName: "Weixin", title: contact.name,
  accountId: "account-a", accountVerified: true, verificationMode: "conversation_title",
  conversationTitleMode: "visual_header", conversationToken: "conversation:v2:81:91:visual:settled", ...extra });

fresh();
const rebound = refreshRealSendSession(baseDir, observed({ titleVerified: true }));
assert.equal(rebound.ok, true, JSON.stringify(rebound));
assert.equal(loadState(baseDir).conversation_token, "conversation:v2:81:91:visual:settled", "the send then checks the settled token");

fresh();
assert.equal(refreshRealSendSession(baseDir, observed({ titleVerified: false })).reason, "atomic_conversation_changed",
  "without the title read in this observation, a changed token still stops the send");

fresh();
saveState(baseDir, { ...loadState(baseDir), real_send_status: "clicked" });
assert.equal(refreshRealSendSession(baseDir, observed({ titleVerified: true })).reason, "atomic_conversation_changed",
  "once the send was clicked the bound token is never replaced");

// The workflow's verify_session stage (executeVerifiedContactSend) uses this function; the
// field failure came from here, and 1.2.56 had changed only refreshRealSendSession.
(async () => {
  fresh();
  const verified = await verifyRealSendSessionAsync(baseDir, async () => observed({ titleVerified: true })());
  assert.equal(verified.ok, true, JSON.stringify(verified).slice(0, 400));
  assert.equal(loadState(baseDir).conversation_token, "conversation:v2:81:91:visual:settled");
  fresh();
  const unread = await verifyRealSendSessionAsync(baseDir, async () => observed({ titleVerified: false })());
  assert.equal(unread.ok, false);
  assert.equal(unread.blocked_reason || unread.reason, "atomic_conversation_changed");
  fs.rmSync(root, { recursive: true, force: true });
  console.log("session title rebind self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });

// The ID-line comparison travels with the search evidence, without the ID text.
const { searchObservationEvidence } = require("./wechat_search_result_resolver.cjs");
{
  const line = (text) => ({ text, left: 136, top: 142, right: 284, bottom: 155 });
  const evidence = searchObservationEvidence({ visualCandidates: [line("微信号：abc_l2345")] }, { query: "abc_12345", queryType: "wechat_id" });
  const box = evidence.ocr_boxes[0];
  assert.deepEqual([box.id_length, box.query_length, box.id_query_distance], [9, 9, 1]);
  assert.deepEqual(box.id_first_mismatch, { index: 4, query_class: "number", ocr_class: "letter" });
  assert.ok(!JSON.stringify(evidence).includes("abc"), "the ID itself is never in the evidence");
  console.log("search ID comparison evidence passed");
}

// Header title OCR (dev machine, WeChat 4.2.0.13, 2026-11-05): a two-character title in the
// narrow strip gave no OCR line at all and a three-character one was misread now and then.
// The fallback reads a taller area at a few scales, keeps only lines inside the title band,
// and still requires one exact match. Checked live on the development machine; here its shape.
{
  const { WECHAT_HEADER_TITLE_POWERSHELL: header } = require("./wechat_header_title.cjs");
  assert.match(header, /if \(-not \(& \$matches \$lines\)\)/u, "the taller read runs only when the strip did not match");
  assert.match(header, /Where-Object \{ \$_\.x -ge \$bandLeft-2 -and \$_\.y -ge -2 -and \$_\.bottom -le \$bandHeight\+2 \}/u,
    "only lines inside the title band count, never the session list or chat body");
  // 1.2.72 (user 2026-11-07): exactly one line; exact match, or equal once symbols,
  // punctuation and spaces are dropped, or a "…"-cut title of 4+ letters/digits that
  // begins the name. Letters and digits are never relaxed (checked live: one character
  // more, less or different still fails).
  assert.match(header, /if \(\$found\.Count -ne 1\) \{[\s\S]*?return \$false\s*\}/u, "exactly one title line");
  // Mismatch evidence carries lengths, the first differing position and character kinds only.
  assert.match(header, /first_diff_index=\$diff/u);
  assert.doesNotMatch(header, /headerTitleEvidence=@\{[^}]*text=/u, "the evidence never carries the title text");
  assert.match(header, /if \(\$text -ceq \$expected\) \{ return \$true \}/u, "the exact match still passes");
  assert.match(header, /\[\\p\{P\}\\p\{S\}\\p\{Cs\}\\p\{Cf\}\\p\{Mn\}\\s\]/u, "only symbols, punctuation and spaces are ignored");
  assert.match(header, /\(\$allowCutTitle -and \$cut -and \$textCase\.Length -ge 4\)\) -and \(& \$readsAsName \$textCase\)/u,
    "a cut title must show at least 4 letters/digits of the name");
  assert.doesNotMatch(header, /editDistance|-like/u, "no fuzzy title match");
  console.log("header title fallback shape passed");
}

// 2026-11-16 (customer computer, 1.3.16, 185 skips): the opened chat's title was read with one
// digit of the phone number as its look-alike letter (5 as "S"). The comparison block itself runs
// here, once, on fixed OCR lines (names and numbers are stand-ins): only a digit of the name may
// be read as its look-alike letter; a letter of the name is never relaxed; strict callers get none.
if (process.platform === "win32") {
  const { WECHAT_HEADER_TITLE_POWERSHELL: header } = require("./wechat_header_title.cjs");
  const { runPowerShell } = require("./wechat_window_driver.cjs");
  const start = header.indexOf("$expectedHasDash=");
  const end = header.indexOf("if (-not (& $matches $lines))");
  assert.ok(start > 0 && end > start, "the title comparison block is found");
  const name = "示例维护张三13805138000";
  const cases = [
    ["field", name, "示例维护张三138O5138000", true, true],
    ["1 as l, 0 as O", name, "示例维护张三l38O5138OOO", true, true],
    ["5 as S", name, "示例维护张三1380S138000", true, true],
    ["6 as b (lower case)", "示例6号", "示例b号", true, true],
    ["8 as b is not a look-alike", "示例8号", "示例b号", true, false],
    ["different digit", name, "示例维护张三13805138001", true, false],
    ["one digit more", name, "示例维护张三138051380005", true, false],
    ["one digit less", name, "示例维护张三1380513800", true, false],
    ["different Chinese character", name, "示例维修张三13805138000", true, false],
    ["a letter of the name is never relaxed", "王总s", "王总5", true, false],
    ["strict: no look-alikes", name, "示例维护张三138O5138000", false, false],
    ["strict: exact still passes", name, name, false, true],
    ["cut title with a look-alike", name, "示例维护张三138O…", true, true],
    ["cut title, strict", name, "示例维护张三138O…", false, false],
    ["plain exact", "CC1 PRO", "CC1 PRO", true, true],
    ["one more character", "城胜", "城胜胜", true, false]
  ];
  const result = runPowerShell(`
$cases = [Environment]::GetEnvironmentVariable("T_CASES") | ConvertFrom-Json
$out = foreach ($case in $cases) {
  $expectedTitle = [string]$case[1]
  $allowCutTitle = [bool]$case[3]
  $expected=[Text.RegularExpressions.Regex]::Replace($expectedTitle.Normalize([Text.NormalizationForm]::FormKC),'\s+','')
  ${header.slice(start, end)}
  $lines = @([pscustomobject]@{ text = [string]$case[2]; x = 0; y = 0; bottom = 10 })
  @{ name = [string]$case[0]; match = [bool](& $matches $lines); lookalike = [bool]$script:headerTitleEvidence.lookalike; diff = $script:headerTitleEvidence.first_diff_index }
}
@{ ok = $true; results = @($out) } | ConvertTo-Json -Compress -Depth 4`, { T_CASES: JSON.stringify(cases) }, { ensure: false, timeout: 60_000 });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  for (const [label, , , , expected] of cases) {
    const row = result.results.find((item) => item.name === label);
    assert.equal(row?.match, expected, label);
  }
  const field = result.results.find((item) => item.name === "field");
  assert.equal(field.lookalike, true, "a look-alike pass is marked in the evidence");
  assert.equal(field.diff, 9, "the evidence still records where the plain reading differs");
  assert.equal(result.results.find((item) => item.name === "plain exact").lookalike, false);
  console.log("header title look-alike comparison passed");

  // 2026-11-17 (user decision): one Chinese character misread (1.3.16 field: 济南展迪 read as
  // 济南屣迪, 407 skips on one computer) confirms the chat when the name has 4+ letters, the reading
  // is full length, and no other contact of the address book is within one character of it.
  // Without the touch-supplied list (auto-reply) the rule is off.
  const nearCases = [
    ["field", "济南展迪", "济南屣迪", true, [], true],
    ["not given: off", "济南展迪", "济南屣迪", true, null, false],
    ["another contact one character away", "济南展迪", "济南屣迪", true, ["济南履迪"], false],
    ["another contact two characters away", "济南展迪", "济南屣迪", true, ["济南展通"], true],
    ["same name elsewhere", "济南展迪", "济南屣迪", true, ["济南展迪"], false],
    ["three letters", "王总经", "王总红", true, [], false],
    ["two characters wrong", "济南展迪", "济北屣迪", true, [], false],
    ["a digit wrong", "示例维护13805", "示例维护13806", true, [], false],
    ["Chinese read as a letter", "济南展迪", "济南a迪", true, [], false],
    ["cut title", "济南展迪物业公司", "济南屣迪…", true, [], false],
    ["strict caller", "济南展迪", "济南屣迪", false, [], false]
  ];
  const nearResult = runPowerShell(`
$cases = [Environment]::GetEnvironmentVariable("T_CASES") | ConvertFrom-Json
$out = foreach ($case in $cases) {
  [Environment]::SetEnvironmentVariable("XIAOXI_TITLE_NEAR_NAMES", $(if ($null -eq $case[4]) { $null } else { ConvertTo-Json -Compress -InputObject @($case[4]) }))
  $expectedTitle = [string]$case[1]
  $allowCutTitle = [bool]$case[3]
  $expected=[Text.RegularExpressions.Regex]::Replace($expectedTitle.Normalize([Text.NormalizationForm]::FormKC),'\\s+','')
  ${header.slice(start, end)}
  $lines = @([pscustomobject]@{ text = [string]$case[2]; x = 0; y = 0; bottom = 10 })
  @{ name = [string]$case[0]; match = [bool](& $matches $lines); near = [bool]$script:headerTitleEvidence.near_cjk }
}
@{ ok = $true; results = @($out) } | ConvertTo-Json -Compress -Depth 4`, { T_CASES: JSON.stringify(nearCases) }, { ensure: false, timeout: 60_000 });
  assert.equal(nearResult.ok, true, JSON.stringify(nearResult).slice(0, 300));
  for (const [label, , , , , expected] of nearCases) {
    const row = nearResult.results.find((item) => item.name === label);
    assert.equal(row?.match, expected, label);
  }
  assert.equal(nearResult.results.find((item) => item.name === "field").near, true, "a near-character pass is marked in the evidence");

  const { titleNearNames } = require("./wechat_header_title.cjs");
  const book = [
    { id: "me", name: "济南展迪", remark: "济南展迪", nickname: "展迪" },
    { id: "a", name: "济南展通", remark: "济南展通", nickname: "" },
    { id: "b", name: "济南履迪", remark: "", nickname: "济南履迪" },
    { id: "c", name: "青岛海尔服务", remark: "", nickname: "" },
    { id: "d", name: "济南迪", remark: "", nickname: "" }
  ];
  assert.deepEqual(titleNearNames(book, book[0]).sort(), ["济南展通", "济南履迪"].sort(), "same length, at most two characters apart, not the customer");
  assert.deepEqual(titleNearNames(book, { id: "x", name: "王总" }), [], "a short name gets no near rule");
  console.log("header title near-character comparison passed");
}
