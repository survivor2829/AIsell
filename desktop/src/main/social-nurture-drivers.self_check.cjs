const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { DRIVERS } = require("./social-nurture-drivers.cjs");

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

  const source = fs.readFileSync(path.join(__dirname, "social-nurture-drivers.cjs"), "utf8");
  assert.doesNotMatch(source, /document\.querySelector\('\$\{ACTIVE\}/u, "no reading of the first active video in the document");
  console.log("social nurture drivers self-check passed: the video on screen is the one read, and a like is read back as it was found");
})().catch((error) => { console.error(error); process.exit(1); });
