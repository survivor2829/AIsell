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

// Customer computer, WeChat 4.2.0.8 (2026-11-04, 1.2.49): OCR read no caption at
// all and every contact stopped as search-r022. Contacts come first in 4.2, so
// the exact, unique WeChat ID above the first other section is still clicked.
const noHeader = realLines().filter((item) => item.text !== "常 便 用");
const noHeaderFound = resolveWechatSearchResultObservation(observe(noHeader), byId("wakeup2829"));
assert.equal(noHeaderFound.mode, "sectioned_wechat_id_visual", JSON.stringify(noHeaderFound));
assert.ok(noHeaderFound.candidate.y < 179, "the click stays above 群聊");
// A logo avatar read as text ("玺联惠") sits beside the contact row; it is not a caption.
const logoAvatar = [...noHeader, line("玺 联 惠", 92, 140, 128, 156)];
assert.equal(resolveWechatSearchResultObservation(observe(logoAvatar), byId("wakeup2829")).mode, "sectioned_wechat_id_visual");
// Unrecognized text alone in the caption column could be another section: no click.
assert.notEqual(resolveWechatSearchResultObservation(observe([...noHeader, line("群 聊 龘", 92, 100, 128, 112)]), byId("wakeup2829")).status, "selected");
// Neither caption read: a group-member line ends the contact section, and the ID
// that appears only there is never a contact.
const captionless = noHeader.filter((item) => item.text !== "群 聊");
assert.equal(resolveWechatSearchResultObservation(observe(captionless), byId("wakeup2829")).mode, "sectioned_wechat_id_visual");
const memberOnly = captionless.filter((item) => !item.text.startsWith("微 信"))
  .map((item) => item.text.startsWith("包 含") ? line("包 含 ： 城 胜 （ 微 信 号 ： wakeup2829)", 136, 238, 309, 251) : item);
assert.notEqual(resolveWechatSearchResultObservation(observe(memberOnly), byId("wakeup2829")).status, "selected",
  "an ID inside a group-member line is never clicked");
// A name search without a caption: the strict rules still refuse (search-r022), but the one
// row that is exactly the name is clicked rather than pressing Enter on whatever comes first
// (1.2.73, 2026-11-07). The opened chat title is still checked.
const captionlessName = resolveWechatSearchResultObservation(observe([line("甲 乙", 136, 118, 170, 131)]), byName("甲乙"));
assert.equal(captionlessName.mode, "name_prefix_visual");
assert.equal(captionlessName.diagnostics.prior_rule_id, "search-r022");

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

// Customer 4.2.0.8 (2026-11-04, 1.2.51): the popup ended with "搜索网络结果" but
// no caption was read; every WeChat-ID hit became search-r015.
// The driver reports word positions; the label word starts in the label column (62 at 96 DPI).
const networkRow = { ...line("搜索网络结果", 118, 262, 220, 276), words: [{ text: "搜索网络结果", left: 118, right: 220 }] };
const withNetworkRow = (lines) => ({ ...observe(lines), webSearchCandidates: [networkRow], webSearchTop: 262 });
const networkNoCaption = resolveWechatSearchResultObservation(withNetworkRow(noHeader), byId("wakeup2829"));
assert.equal(networkNoCaption.mode, "sectioned_wechat_id_visual", JSON.stringify(networkNoCaption));
assert.notEqual(resolveWechatSearchResultObservation(withNetworkRow(memberOnly), byId("wakeup2829")).status, "selected",
  "with the network row too, an ID only in a group-member line is never clicked");

// Customer 4.2.0.8 capture (2026-11-04, contact "测试客户", ID Abc12345678): OCR read
// neither the name nor the caption; avatar specks joined the ID line, which so
// starts in the caption column; "搜索网络结果" came back as 5 characters. Box
// positions are the field passport's. The 1.2.52 caption rule refused it (r022).
const word = (text, left, right) => ({ text, left, right });
const fieldLines = [
  { ...line("· 微 信 号 ： Abc12345678", 93, 139, 254, 154),
    words: [word("·", 93, 99), word("微", 136, 147), word("信", 148, 159), word("号", 160, 171), word("：", 172, 177), word("Abc12345678", 178, 254)] },
  { ...line("搜 索 网 络 结", 117, 176, 188, 188), words: [word("搜索网络结", 117, 188)] },
  line("2", 92, 204, 104, 217),
  { ...line("Abc12345678", 112, 208, 187, 220), words: [word("Abc12345678", 112, 187)] },
  line("i", 398, 209, 420, 222)
];
const fieldFound = resolveWechatSearchResultObservation(observe(fieldLines), { query: "Abc12345678", expectedName: "测试客户", queryType: "wechat_id" });
assert.equal(fieldFound.mode, "sectioned_wechat_id_visual", JSON.stringify(fieldFound));
assert.ok(fieldFound.candidate.y > 139 && fieldFound.candidate.y < 160, "the click lands on the contact's ID line");

// Customer 4.2 (2026-11-07, 1.2.69; ID and name below are stand-ins): one contact listed, but the
// "🔍 ABC1234" suggestion row had no info icon beside it, so it was taken for an
// unknown caption (search-r022) and the contact was skipped. Box positions are the
// field capsule's; the ID line carried one extra OCR character.
const echoPopup = { left: 56, top: 64, right: 424, bottom: 258 };
const echoLines = [
  line("测 试 甲", 138, 112, 176, 126),
  line("微 信 号 ： ABC1234 .", 137, 137, 228, 152),
  { ...line("搜 索 网 络 结", 116, 172, 188, 186), words: [word("搜索网络结", 116, 188)] },
  line("ABC1234", 111, 204, 158, 216)
];
const echoObserve = { ...observe(echoLines), popupBounds: echoPopup, cropBounds: echoPopup };
const echoFound = resolveWechatSearchResultObservation(echoObserve, { query: "ABC1234", expectedName: "测试甲", queryType: "wechat_id" });
assert.equal(echoFound.mode, "sectioned_wechat_id_visual", JSON.stringify(echoFound));
assert.ok(echoFound.candidate.y > 137 && echoFound.candidate.y < 152, "the click lands on the contact's ID line");
// The suggestion row alone (no contact) is still not a contact: name fallback runs next.
const echoOnly = resolveWechatSearchResultObservation({ ...echoObserve, visualCandidates: echoLines.filter((item) => !item.text.startsWith("微")) },
  { query: "ABC1234", expectedName: "测试甲", queryType: "wechat_id" });
assert.notEqual(echoOnly.status, "selected");
// A different ID, even one differing only by a digit, is never clicked.
const otherId = resolveWechatSearchResultObservation({ ...echoObserve, visualCandidates: echoLines.map((item) => item.text.startsWith("微") ? line("微 信 号 ： ABC1235", 137, 137, 228, 152) : item) },
  { query: "ABC1234", expectedName: "测试甲", queryType: "wechat_id" });
assert.notEqual(otherId.status, "selected");

// WeChat 4.1 popups with the network row keep their original rules.
const legacy = resolveWechatSearchResultObservation({ ...observe(realLines()),
  webSearchCandidates: [line("搜索网络结果", 118, 262, 220, 276)], webSearchTop: 262 }, byId("wakeup2829"));
assert.notEqual(legacy.mode, "sectioned_wechat_id_visual", "the 4.2 path is used only without a network row");

// Name search, long name with a dash (dev machine 4.2.0.13, 2026-11-07; text below is a
// stand-in, positions are the real OCR boxes): the row reads the dash as "一" and is cut
// off ("“." for the ellipsis), and no caption is read. Enter used to open the first result,
// which on the customer computer was another chat. The one row that begins the name is clicked.
{
  const prefixPopup = { left: 56, top: 63, right: 424, bottom: 257 };
  const networkRow = { ...line("搜 索 网 络 结 果", 118, 178, 190, 190), words: [word("搜索网络结果", 118, 190)] };
  const contactRow = line("示 例 公 司 扫 地 机 一 张 三 13800001 “ .", 136, 130, 343, 143);
  const echoRow = line("Q 示 例 公 司 扫 地 机 · 张 三 13800001238", 94, 208, 304, 222);
  const prefixObserve = (lines) => ({ ...observe(lines), popupBounds: prefixPopup, cropBounds: prefixPopup,
    webSearchCandidates: [networkRow], webSearchTop: 178 });
  const byLongName = { query: "示例公司扫地机-张三13800001234", expectedName: "示例公司扫地机-张三13800001234", queryType: "name_fallback" };
  const prefixFound = resolveWechatSearchResultObservation(prefixObserve([contactRow, echoRow, line("G)", 368, 128, 383, 142)]), byLongName);
  assert.equal(prefixFound.mode, "name_prefix_visual", JSON.stringify(prefixFound));
  assert.ok(prefixFound.candidate.y > 128 && prefixFound.candidate.y < 145, "the contact row, not the search suggestion");
  // The search suggestion alone is never clicked.
  assert.notEqual(resolveWechatSearchResultObservation(prefixObserve([echoRow]), byLongName).status, "selected");
  // Two rows that both begin the name: never guess.
  const second = line("示 例 公 司 扫 地 机 - 张 三 13800001 …", 136, 150, 343, 163);
  assert.notEqual(resolveWechatSearchResultObservation(prefixObserve([contactRow, second, echoRow]), byLongName).status, "selected");
  // A different name, or a short name that is only similar, is not clicked.
  assert.notEqual(resolveWechatSearchResultObservation(prefixObserve([line("示 例 工 厂 扫 地 机 一 李 四 13800001", 136, 130, 343, 143), echoRow]), byLongName).status, "selected");
  assert.notEqual(resolveWechatSearchResultObservation(prefixObserve([line("张 三 丰", 136, 130, 200, 143)]),
    { query: "张三", expectedName: "张三", queryType: "name_fallback" }).status, "selected");
  // WeChat-ID searches keep their own rules.
  assert.notEqual(resolveWechatSearchResultObservation(prefixObserve([contactRow, echoRow]), { ...byLongName, queryType: "wechat_id" }).mode, "name_prefix_visual");
}

console.log("WeChat 4.2 search popup self-check passed");
