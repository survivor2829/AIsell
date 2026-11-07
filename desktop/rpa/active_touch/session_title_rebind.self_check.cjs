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
  assert.match(header, /\$textFolded\.Length -ge 4 -and \$expectedFolded\.StartsWith\(\$textFolded, \[StringComparison\]::Ordinal\)/u,
    "a cut title must show at least 4 letters/digits of the name");
  assert.doesNotMatch(header, /editDistance|-like/u, "no fuzzy title match");
  console.log("header title fallback shape passed");
}
