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

// The comparison block runs here on fixed OCR lines (names and numbers are stand-ins). Since
// 2026-11-17 (user decision) the title must equal the name exactly; only symbols, punctuation,
// spaces and case are ignored and a "…"-cut title shows 4+ letters. The look-alike-digit (1.3.21)
// and one-wrong-character (1.3.27) allowances are gone: the chat-title reader replaced them.
if (process.platform === "win32") (async () => {
  const http = require("node:http");
  const { WECHAT_HEADER_TITLE_POWERSHELL: header } = require("./wechat_header_title.cjs");
  const { runPowerShell, runPowerShellAsync } = require("./wechat_window_driver.cjs");
  const foldStart = header.indexOf("$expectedHasDash=");
  const foldEnd = header.indexOf("$script:headerTitleEvidence=@{ lines=0");
  const readerStart = header.indexOf("$lineOcrUrl=");
  const readerEnd = header.indexOf("if ($null -eq $engine) { return $false }", readerStart);
  const compareStart = header.indexOf("$foldKeepCase=");
  const compareEnd = header.indexOf("if (-not (& $matches $lines))");
  assert.ok(foldStart > 0 && foldEnd > foldStart && readerStart > foldEnd && readerEnd > readerStart
    && compareStart > readerEnd && compareEnd > compareStart, "the title check blocks are found");
  const name = "示例维护张三13805138000";
  const cases = [
    ["plain exact", "CC1 PRO", "CC1 PRO", true, true],
    ["symbols and emoji ignored", "崔情情🍀🌻", "崔情情", true, true],
    ["a digit read as a letter is a different title", name, "示例维护张三138O5138000", true, false],
    ["one Chinese character wrong is a different title", "济南展迪", "济南屣迪", true, false],
    ["different digit", name, "示例维护张三13805138001", true, false],
    ["one digit more", name, "示例维护张三138051380005", true, false],
    ["one more character", "城胜", "城胜胜", true, false],
    ["cut title, 4+ letters", name, "示例维护张三138…", true, true],
    ["cut title, strict caller", name, "示例维护张三138…", false, false],
    ["strict: exact still passes", name, name, false, true]
  ];
  const result = runPowerShell(`
$cases = [Environment]::GetEnvironmentVariable("T_CASES") | ConvertFrom-Json
$out = foreach ($case in $cases) {
  $expectedTitle = [string]$case[1]
  $allowCutTitle = [bool]$case[3]
  $expected=[Text.RegularExpressions.Regex]::Replace($expectedTitle.Normalize([Text.NormalizationForm]::FormKC),'\s+','')
  ${header.slice(foldStart, foldEnd)}
  $script:headerTitleEvidence=@{ lines=0 }
  ${header.slice(compareStart, compareEnd)}
  $lines = @([pscustomobject]@{ text = [string]$case[2]; x = 0; y = 0; bottom = 10 })
  @{ name = [string]$case[0]; match = [bool](& $matches $lines) }
}
@{ ok = $true; results = @($out) } | ConvertTo-Json -Compress -Depth 4`, { T_CASES: JSON.stringify(cases) }, { ensure: false, timeout: 60_000 });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  for (const [label, , , , expected] of cases) assert.equal(result.results.find((item) => item.name === label)?.match, expected, label);
  console.log("header title strict comparison passed");

  // The chat-title reader: its reading confirms the chat only when it equals the name; a wrong
  // reading, a reader that is down or answers late, a bad token or a non-loopback address leave
  // the decision to Windows' reading (the block falls through instead of returning).
  let replyText = "", replyDelayMs = 0, seenToken = "", posts = 0;
  const token = "t".repeat(48);
  const server = http.createServer((request, response) => {
    let size = 0;
    request.on("data", (chunk) => { size += chunk.length; });
    request.on("end", () => {
      posts += 1; seenToken = request.headers["x-xiaoxi-token"];
      setTimeout(() => {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ text: replyText, score: 0.99, bytes: size }));
      }, replyDelayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/read`;
  const runReader = (expectedTitle, env) => runPowerShellAsync(`
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing @"
public static class XiaoxiScreenPixels {
  public static bool Copy(System.Drawing.Bitmap bitmap, int left, int top) { return true; }
}
"@
$expectedTitle = [Environment]::GetEnvironmentVariable("T_EXPECTED")
$allowCutTitle = $true
$left = 0; $top = 0; $right = 300; $bottom = 40
$verdict = & {
  ${header.slice(foldStart, foldEnd)}
  $script:headerTitleEvidence=@{ lines=0 }
  ${header.slice(readerStart, readerEnd)}
  return "fallthrough"
}
@{ ok = $true; verdict = [string]$verdict; evidence = $script:headerTitleEvidence.line_ocr } | ConvertTo-Json -Compress -Depth 4`, { T_EXPECTED: expectedTitle, ...env }, { ensure: false, timeout: 60_000 });
  try {
    replyText = "济南展迪";
    let read = await runReader("济南展迪", { XIAOXI_LINE_OCR_URL: url, XIAOXI_LINE_OCR_TOKEN: token });
    assert.equal(read.verdict, "True", "an exact reading confirms the chat");
    assert.equal(seenToken, token);
    assert.deepEqual([read.evidence.read, read.evidence.match], [true, true]);
    replyText = "济南屣迪";
    read = await runReader("济南展迪", { XIAOXI_LINE_OCR_URL: url, XIAOXI_LINE_OCR_TOKEN: token });
    assert.equal(read.verdict, "fallthrough", "a wrong reading leaves it to Windows' reading");
    assert.equal(read.evidence.match, false);
    // One Chinese character off (user decision 2026-11-17; back in 1.3.35 after the new reader
    // still misread 燚): confirmed only with the address-book list and nobody that close in it.
    read = await runReader("济南展迪", { XIAOXI_LINE_OCR_URL: url, XIAOXI_LINE_OCR_TOKEN: token, XIAOXI_TITLE_NEAR_NAMES: "[]" });
    assert.equal(read.verdict, "True", "one Chinese character off confirms the chat");
    assert.equal(read.evidence.near_cjk, true, "and the field report says so");
    read = await runReader("济南展迪", { XIAOXI_LINE_OCR_URL: url, XIAOXI_LINE_OCR_TOKEN: token, XIAOXI_TITLE_NEAR_NAMES: JSON.stringify(["济南屣迪"]) });
    assert.equal(read.verdict, "fallthrough", "never when another contact could be what was read");
    read = await runReader("济南展迪", { XIAOXI_LINE_OCR_URL: url, XIAOXI_LINE_OCR_TOKEN: token, XIAOXI_TITLE_NEAR_NAMES: JSON.stringify(["济南屣迫"]) });
    assert.equal(read.verdict, "fallthrough", "nor when one is a character away from the reading");
    replyText = "济南屣迫";
    read = await runReader("济南展迪", { XIAOXI_LINE_OCR_URL: url, XIAOXI_LINE_OCR_TOKEN: token, XIAOXI_TITLE_NEAR_NAMES: "[]" });
    assert.equal(read.verdict, "fallthrough", "two characters off is another name");
    replyText = "王总6";
    read = await runReader("王总5", { XIAOXI_LINE_OCR_URL: url, XIAOXI_LINE_OCR_TOKEN: token, XIAOXI_TITLE_NEAR_NAMES: "[]" });
    assert.equal(read.verdict, "fallthrough", "a digit is never relaxed, nor a name under 4 characters");
    replyText = "张三丰A";
    read = await runReader("张三丰B", { XIAOXI_LINE_OCR_URL: url, XIAOXI_LINE_OCR_TOKEN: token, XIAOXI_TITLE_NEAR_NAMES: "[]" });
    assert.equal(read.verdict, "fallthrough", "only a Chinese character, never a letter");
    replyText = "济南屣迪";
    read = await runReader("济南展迪", { XIAOXI_LINE_OCR_URL: url, XIAOXI_LINE_OCR_TOKEN: token });
    assert.equal(read.verdict, "fallthrough", "without the list (auto-reply and other callers) the rule is off");
    replyText = "崔情情";
    read = await runReader("崔情情🍀🌻", { XIAOXI_LINE_OCR_URL: url, XIAOXI_LINE_OCR_TOKEN: token });
    assert.equal(read.verdict, "True", "emoji in the name are ignored like everywhere else");
    // A name of one letter once symbols are dropped could be another contact: Windows decides.
    replyText = "A"; const beforeShort = posts;
    read = await runReader("A🍀", { XIAOXI_LINE_OCR_URL: url, XIAOXI_LINE_OCR_TOKEN: token });
    assert.equal(read.verdict, "fallthrough");
    assert.equal(posts, beforeShort, "a one-letter name never asks the reader");
    replyText = "济南展迪"; replyDelayMs = 6000;
    read = await runReader("济南展迪", { XIAOXI_LINE_OCR_URL: url, XIAOXI_LINE_OCR_TOKEN: token });
    assert.equal(read.verdict, "fallthrough", "a late reader never holds the check up");
    assert.equal(read.evidence.read, false);
    replyDelayMs = 0;
    const before = posts;
    read = await runReader("济南展迪", { XIAOXI_LINE_OCR_URL: "http://10.0.0.1:1/read", XIAOXI_LINE_OCR_TOKEN: token });
    assert.equal(read.verdict, "fallthrough", "only a loopback reader is used");
    read = await runReader("济南展迪", { XIAOXI_LINE_OCR_URL: url, XIAOXI_LINE_OCR_TOKEN: "short" });
    assert.equal(read.verdict, "fallthrough", "no token, no call");
    read = await runReader("济南展迪", { XIAOXI_LINE_OCR_URL: "", XIAOXI_LINE_OCR_TOKEN: "" });
    assert.equal(read.verdict, "fallthrough", "without the reader the old path decides");
    assert.equal(posts, before, "none of those reached the reader");
  } finally {
    server.close();
  }
  console.log("header title reader passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
