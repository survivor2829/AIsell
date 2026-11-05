// Customer computer, WeChat 4.2.0.8 (1.2.54-1.2.55, 2026-11-05): the name search opened the
// right chat, but the header-pixel token bound at the search click never matched the settled
// header, so every pre-send check failed as atomic_conversation_changed. A fresh observation
// that read the contact's title itself re-binds the conversation before anything is typed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadState, saveState } = require("./state_machine.cjs");
const { refreshRealSendSession } = require("./state_machine.dev.cjs");

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

fs.rmSync(root, { recursive: true, force: true });
console.log("session title rebind self-check passed");

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
