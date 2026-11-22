const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { DRIVERS, FOLLOW_PLUS } = require("./social-nurture-drivers.cjs");

// A Douyin search result plays in a layer over the results page, and the page can keep another
// "active" video behind it, hidden. Field 2026-11-18..20 (1.3.38-1.3.49): a like already shown red was
// reported unconfirmed, and steps kept looking for buttons after the player had closed. Only the video
// on screen counts, and a like is read back the way its button was found.
const douyin = DRIVERS.douyin;

function element(vid, rect, desc) {
  return {
    rect, getBoundingClientRect: () => rect, getAttribute: (name) => (name === "data-e2e-vid" ? vid : null),
    querySelector: (selector) => (/video-desc/.test(selector) ? { innerText: desc } : /account-name/.test(selector) ? { innerText: "@作者" } : null)
  };
}
function pageWith(actives, { likedAfterClick = true } = {}) {
  let clicked = false;
  const document = { querySelectorAll: (selector) => (/feed-active-video/.test(selector) ? actives : []), querySelector: () => null };
  const context = vm.createContext({ document, innerWidth: 1280, innerHeight: 800, location: { href: "https://www.douyin.com/search/x" } });
  // Nodes as the DOM walk sees them: a button inside the active video on screen.
  const activeNode = { nodeType: 1, attributes: ["data-e2e", "feed-active-video"] };
  const button = () => ({ nodeType: 1, attributes: ["data-e2e-state", clicked && likedAfterClick ? "video-player-digged" : "video-player-no-digged"] });
  return {
    evaluate: async (expression) => vm.runInContext(expression, context),
    find: async (predicate) => { const node = button(); const view = { ancestors: () => [activeNode] }; return predicate(node, view) ? node : null; },
    click: async () => { clicked = true; return true; }
  };
}
const hidden = element("111", { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 }, "背后的");
const onScreen = element("222", { width: 600, height: 760, top: 20, left: 340, bottom: 780, right: 940 }, "弹窗里的");
const offScreen = element("333", { width: 600, height: 760, top: -900, left: 340, bottom: -140, right: 940 }, "滑走的");

(async () => {
  const current = await douyin.current(pageWith([hidden, offScreen, onScreen]));
  assert.equal(current.id, "222", "the video on screen, not the first in the document");
  assert.equal(current.desc, "弹窗里的");
  assert.equal(await douyin.current(pageWith([hidden, offScreen])), null, "no video on screen: none (the player closed)");
  assert.equal(await douyin.like(pageWith([hidden, onScreen])), "done", "a like shown on screen is confirmed");
  assert.equal(await douyin.like(pageWith([hidden, onScreen], { likedAfterClick: false })), "unconfirmed", "a like not shown stays unconfirmed");

  // Signed in = the header's top-right avatar links to the own page; the left bar's 我的 does so signed out too.
  const signedInWith = (links) => douyin.signedIn({ evaluate: async (expression) => vm.runInContext(expression, vm.createContext({
    document: { querySelectorAll: () => links.map((rect) => ({ getBoundingClientRect: () => rect })) }, innerWidth: 1164 })) });
  assert.equal(await signedInWith([{ width: 40, height: 50, top: 364, left: 10 }]), false, "only the left bar's 我的: signed out");
  assert.equal(await signedInWith([{ width: 40, height: 50, top: 364, left: 10 }, { width: 32, height: 32, top: 11, left: 1114 }]), true, "the header avatar: signed in");

  // The follow "+" is the small icon over the lower edge of the author's avatar (dev PC, signed in, 2026-11-22).
  const plusPage = (withPlus) => {
    const avatar = { getClientRects: () => [1], getBoundingClientRect: () => ({ left: 1102, top: 209, width: 42, height: 42, right: 1144, bottom: 251 }) };
    const plus = { getBoundingClientRect: () => ({ left: 1111, top: 239, width: 24, height: 24, right: 1135, bottom: 263 }) };
    const big = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1164, height: 670, right: 1164, bottom: 670 }) };
    const active = { getBoundingClientRect: () => ({ width: 1164, height: 670, top: 0, left: 0, bottom: 670, right: 1164 }),
      querySelectorAll: (selector) => (/video-avatar/.test(selector) ? [avatar] : withPlus ? [big, avatar, plus] : [big, avatar]) };
    return vm.createContext({ document: { querySelectorAll: () => [active] }, innerWidth: 1164, innerHeight: 670 });
  };
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(FOLLOW_PLUS, plusPage(true)))), { state: "plus", x: 1123, y: 251 }, "the + under the avatar, by where it sits");
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(FOLLOW_PLUS, plusPage(false)))), { state: "no_plus" }, "no +: already followed");

  // Slow results (dev PC 2026-11-22: more than ten seconds): waited for, up to the limit; never there: given up.
  const slowResults = (tabAfter, linkAfter) => { let finds = 0, evaluations = 0, clicked = 0;
    return { page: { find: async () => (++finds > tabAfter ? { nodeType: 1, attributes: ["data-key", "video"] } : null), click: async () => { clicked += 1; return true; },
      evaluate: async () => ++evaluations > linkAfter }, clicks: () => clicked }; };
  const slow = slowResults(2, 3);
  assert.equal(await douyin.openFirstResult(slow.page, { waitMs: 10_000 }), true, "results that come late are waited for");
  assert.equal(slow.clicks(), 1, "the 视频 tab was clicked once it showed");
  assert.equal(await douyin.openFirstResult(slowResults(0, 99).page, { waitMs: 2_500 }), false, "results that never come: given up at the limit");

  const source = fs.readFileSync(path.join(__dirname, "social-nurture-drivers.cjs"), "utf8");
  assert.doesNotMatch(source, /key\(page, "Escape"/u, "Escape closes the whole player on a search result: never pressed");
  assert.match(source, /留下你的精彩评论/u, "the comment editor is opened from its placeholder");
  assert.match(source, /我知道了/u, "the first-player guide is closed");
  assert.doesNotMatch(source, /document\.querySelector\('\$\{ACTIVE\}/u, "no reading of the first active video in the document");
  console.log("social nurture drivers self-check passed: the video on screen is the one read, and a like is read back as it was found");
})().catch((error) => { console.error(error); process.exit(1); });
