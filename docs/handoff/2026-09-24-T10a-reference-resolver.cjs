"use strict";
// T10a REFERENCE (Claude's review prototype, 2026-09-24). Not production code:
// fold this logic into wechat_search_result_resolver.cjs itself; do not ship a
// wrapper file. Validated against:
//   - fixtures/2026-09-24-T10a-dryrun-fixture.json with popup geometry:
//     28/28 friends click expected.rowIndex, 4/4 non-friends no click (r015);
//   - the 20 wrong-click attack scenarios from the second review: 0 clicks;
//   - wrong-row fuzz vs base: 0 wrong selections (a5d2de9: 134).
// Principle: change ONLY how the network boundary is recognised; keep every
// base 9d77c2d structure check (section bounds, 1.75x gap, r007, r014, r015,
// lookup-row masking) by running the unchanged base resolver afterwards; then
// apply popup-only vetoes that can only turn a selection into a rejection.
const base = require("./base_resolver_9d77c2d.cjs"); // = the unchanged 9d77c2d logic

const LABEL = "搜索网络结果";
const norm = (v) => String(v ?? "").normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
const isLocalHeader = (t) => /^(?:最)?常.{0,2}用$/u.test(norm(t)) || ["联系人", "最近联系人", "好友"].includes(norm(t));
const isOtherSection = (t) => ["群聊", "聊天记录", "公众号", "小程序", "文件", "文件传输"].includes(norm(t));
const isUnsafe = (t) => norm(t).includes("查找") || (norm(t).includes("微信号") && !norm(t).startsWith("微信号"));
const fold = (v) => norm(v).replace(/[|il1]/gu, "1").replace(/[o0]/gu, "0");

function reject(observation, rule_id, reason = "search_result_identity_unverified") {
  return { status: reason === "exact_search_result_not_found" ? "not_found" : "unverified", reason, rule_id,
    diagnostics: { rule_id, candidate_count: 0, visual_candidate_count: (observation.visualCandidates || []).length, ocr_ok: observation.ocrOk === true } };
}

// Applies to every wechat_id selection, popup or not: a fully read "微信号" row
// whose (folded) value contains the query and is longer means another person.
function superstringVeto(observation, identity, result) {
  if (result?.status !== "selected" || identity.queryType !== "wechat_id") return result;
  const q = fold(identity.query);
  const other = (observation.visualCandidates || []).some((line) => {
    const m = norm(line.text).match(/^微信号[:：]?(.+)$/u);
    return m && fold(m[1]).includes(q) && fold(m[1]).length > q.length;
  });
  return other ? reject(observation, "search-r014") : result;
}

function resolveWechatSearchResultObservation(observation = {}, identity = {}) {
  const popup = observation.popupBounds;
  const dpi = Number(observation.popupDpi);
  // No popup window found: exactly the base behaviour (+ superstring veto).
  if (!popup || !(dpi > 0)) return superstringVeto(observation, identity, base.resolveWechatSearchResultObservation(observation, identity));

  const scale = dpi / 96;
  const column = (x) => (Number(x) - Number(popup.left)) / scale;
  // 1) Re-classify boundaries by geometry. PS pre-classification is ignored.
  const all = [...(observation.visualCandidates || []), ...(observation.webSearchCandidates || [])];
  const visual = [];
  const web = [];
  for (const line of all) {
    const text = norm(line.text);
    const words = Array.isArray(line.words) ? line.words : [];
    const at = words.findIndex((_, j) => words.slice(j, j + 6).map((w) => norm(w.text)).join("") === LABEL);
    if (text.endsWith(LABEL) && text.length - LABEL.length <= 4 && at >= 0 && Math.abs(column(words[at].left) - 62) <= 8) {
      web.push({ ...line, text: LABEL, left: words[at].left });
    } else visual.push(line);
  }
  const obs2 = { ...observation, visualCandidates: visual, webSearchCandidates: web,
    webSearchTop: web.length ? Math.min(...web.map((w) => Number(w.top))) : null };

  // 2) Unchanged base decision.
  const result = base.resolveWechatSearchResultObservation(obs2, identity);

  // 3) Popup-only vetoes.
  const headers = visual.filter((l) => isLocalHeader(l.text) && column(l.left) >= 30 && column(l.left) <= 56);
  if (!headers.length) {
    // No local-contact section at all: the person is not a friend (lookup row,
    // groups or chat records only). Report not-found so the name fallback runs
    // and T5's circuit does not count it.
    if (result.status === "selected" || (web.length && result.rule_id === "search-r014")) {
      return reject(obs2, "search-r015", "exact_search_result_not_found");
    }
    return result;
  }
  if (result.status !== "selected") return result;
  const cand = result.candidate;
  const header = headers.filter((h) => Number(h.bottom) <= Number(cand.top) + 2).sort((a, b) => Number(b.top) - Number(a.top))[0];
  if (!header) return reject(obs2, "search-r014");
  if (visual.some((l) => isOtherSection(l.text) && Number(l.top) >= Number(header.bottom) - 2 && Number(l.bottom) <= Number(cand.top) + 2)) return reject(obs2, "search-r014");
  const webTop = obs2.webSearchTop ?? Infinity;
  const sectionEnd = Math.min(webTop, ...visual.filter((l) => isOtherSection(l.text) && Number(l.top) >= Number(header.bottom) - 2).map((l) => Number(l.top)));
  if (visual.some((l) => isUnsafe(l.text) && Number(l.top) >= Number(header.bottom) - 2 && Number(l.bottom) <= sectionEnd)) return reject(obs2, "search-r014");
  return superstringVeto(obs2, identity, result);
}

module.exports = { resolveWechatSearchResultObservation };
