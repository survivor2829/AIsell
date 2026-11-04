// WeChat 4.2 search popup (field 2026-11-03 on 4.2.0.8, reproduced on the
// development machine with 4.2.0.12). The popup no longer ends with a
// "搜索网络结果" row, so every contact was skipped as search-r008. Lines and
// positions below are the Windows OCR output of the real 4.2.0.12 capture.
const assert = require("node:assert/strict");
const { resolveWechatSearchResultObservation, isVerifiedWechatSearchResultMode } = require("./wechat_search_result_resolver.cjs");

const line = (text, left, top, right, bottom) => ({ text, left, top, right, bottom,
  x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) });
const popup = { left: 56, top: 63, right: 424, bottom: 287 };
const realLines = () => [
  line("常 便 用", 104, 83, 139, 95), // 最常使用, misread as OCR does
  line("微 信 ． 号 ： wakeup2829", 136, 142, 250, 155),
  line("G)", 369, 128, 383, 142), // the info icon on the contact row
  line("群 聊", 92, 179, 116, 191),
  line("鑫", 101, 214, 118, 230), // group avatar fragments
  line("0 到", 93, 231, 127, 248),
  line("玺 联 惠 客 户 经 理 蒜 多 尼 18017834287 、", 136, 213, 356, 227),
  line("包 含 ： 牲 （ 信 号 ： wakeup2829)", 136, 238, 309, 251)
];
const observe = (visualCandidates) => ({ uiaCandidates: [], ocrOk: true, captureSource: "popup",
  popupBounds: popup, popupDpi: 96, popupCandidateCount: 1, cropBounds: popup,
  visualCandidates, webSearchCandidates: [], webSearchTop: null });
const byId = (query) => ({ query, expectedName: "城胜", queryType: "wechat_id" });
const byName = (query) => ({ query, expectedName: query, queryType: "name_fallback" });

// The exact WeChat ID under 最常使用 is clicked; the old code skipped it (r008).
const found = resolveWechatSearchResultObservation(observe(realLines()), byId("wakeup2829"));
assert.equal(found.status, "selected", JSON.stringify(found));
assert.equal(found.mode, "sectioned_wechat_id_visual");
assert.equal(isVerifiedWechatSearchResultMode(found.mode), true);
assert.ok(found.candidate.y > 128 && found.candidate.y < 179, "the click lands on the contact row, above 群聊");

// The ID appearing only inside a group row ("包含：...微信号...") is not a contact.
const groupOnly = realLines().filter((item) => !item.text.startsWith("微 信"));
groupOnly.push(line("包 含 ： 城 胜 （ 微 信 号 ： wakeup2829)", 136, 238, 309, 251));
const notContact = resolveWechatSearchResultObservation(observe(groupOnly.filter((item) => !item.text.startsWith("包 含 ： 牲"))), byId("wakeup2829"));
assert.notEqual(notContact.status, "selected", "a group member line must never be clicked");
assert.equal(notContact.reason, "exact_search_result_not_found", "so the name fallback search runs next");

// Two contacts with WeChat IDs in the section: never guess.
const two = [...realLines(), line("微 信 号 ： wakeup2829x", 136, 165, 252, 176)];
assert.equal(resolveWechatSearchResultObservation(observe(two), byId("wakeup2829")).rule_id, "search-r007");

// A longer ID that merely contains the query is vetoed.
const longer = realLines().map((item) => item.text.startsWith("微 信") ? line("微信号：wakeup28290", 136, 142, 252, 155) : item);
assert.notEqual(resolveWechatSearchResultObservation(observe(longer), byId("wakeup2829")).status, "selected");

// "网络查找微信号" or "查找" inside the contact section stops the click.
const lookup = [...realLines(), line("网 络 查 找 微 信 号", 136, 160, 260, 172)];
assert.notEqual(resolveWechatSearchResultObservation(observe(lookup), byId("wakeup2829")).status, "selected");

// No contact header read at all: no click.
const noHeader = realLines().filter((item) => item.text !== "常 便 用");
assert.notEqual(resolveWechatSearchResultObservation(observe(noHeader), byId("wakeup2829")).status, "selected");

// Name search: the name row under 联系人, with one OCR-misread character allowed
// only for names of three or more characters; the chat title is checked later.
const nameLines = [line("联 系 人", 92, 83, 140, 95), line("向 锦 涛", 136, 118, 190, 131),
  line("群 聊", 92, 179, 116, 191), line("包 含 ： 向 锦 涛", 136, 213, 260, 227)];
const byNameFound = resolveWechatSearchResultObservation(observe(nameLines), byName("向锦涛"));
assert.equal(byNameFound.mode, "sectioned_name_visual", JSON.stringify(byNameFound));
const misread = nameLines.map((item) => item.text === "向 锦 涛" ? line("向 锦 寿", 136, 118, 190, 131) : item);
assert.equal(resolveWechatSearchResultObservation(observe(misread), byName("向锦涛")).status, "selected");
const twoChar = [line("联 系 人", 92, 83, 140, 95), line("城 性", 136, 118, 170, 131)];
assert.notEqual(resolveWechatSearchResultObservation(observe(twoChar), byName("城胜")).status, "selected",
  "two-character names must match exactly");
const twoNames = [...nameLines, line("向 锦 涛", 136, 150, 190, 163)];
assert.equal(resolveWechatSearchResultObservation(observe(twoNames), byName("向锦涛")).rule_id, "search-r021");

// WeChat 4.1 popups with the network row keep their original rules.
const legacy = resolveWechatSearchResultObservation({ ...observe(realLines()),
  webSearchCandidates: [line("搜索网络结果", 118, 262, 220, 276)], webSearchTop: 262 }, byId("wakeup2829"));
assert.notEqual(legacy.mode, "sectioned_wechat_id_visual", "the 4.2 path is used only without a network row");

console.log("WeChat 4.2 search popup self-check passed");
