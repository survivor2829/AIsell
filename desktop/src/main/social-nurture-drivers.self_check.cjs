const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { DRIVERS, FOLLOW_PLUS, BLOCKED } = require("./social-nurture-drivers.cjs");

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
  const plusPage = (withPlus, plusOpacity = "1") => {
    const active = { getBoundingClientRect: () => ({ width: 1164, height: 670, top: 0, left: 0, bottom: 670, right: 1164 }) };
    const avatar = { parentElement: active, getClientRects: () => [1], getBoundingClientRect: () => ({ left: 1102, top: 209, width: 42, height: 42, right: 1144, bottom: 251 }) };
    const plus = { parentElement: active, opacity: plusOpacity, getBoundingClientRect: () => ({ left: 1111, top: 239, width: 24, height: 24, right: 1135, bottom: 263 }) };
    const big = { parentElement: active, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1164, height: 670, right: 1164, bottom: 670 }) };
    active.querySelectorAll = (selector) => (/video-avatar/.test(selector) ? [avatar] : withPlus ? [big, avatar, plus] : [big, avatar]);
    return vm.createContext({ document: { querySelectorAll: () => [active] }, innerWidth: 1164, innerHeight: 670,
      getComputedStyle: (el) => ({ display: "block", visibility: "visible", opacity: el.opacity || "1" }) });
  };
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(FOLLOW_PLUS, plusPage(true)))), { state: "plus", x: 1123, y: 251 }, "the + under the avatar, by where it sits");
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(FOLLOW_PLUS, plusPage(false)))), { state: "no_plus" }, "no +: already followed");
  // Once followed the "+" fades out but stays in the page (test account, 2026-11-22): in its place but not
  // drawn, "faded"; follow() waits a moment for one fading in, and takes one fading out as followed.
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(FOLLOW_PLUS, plusPage(true, "0")))), { state: "faded" }, "a faded +: not one to click");

  // Douyin's SMS check after a comment came as a dialog in the middle of the screen, over a page whose
  // text ran long (test account, 2026-11-22): seen there whatever its markup. A comment that mentions the
  // words, far down the list or inside the player layer with its comments, does not stop the run.
  const blockedPage = ({ centre = "", longStart = false, dialogs = [] } = {}) => {
    const middle = { innerText: centre, parentElement: null };
    return vm.createContext({ innerWidth: 1164, innerHeight: 670,
      document: { body: { innerText: (longStart ? "评论".repeat(3000) + "完成验证" : "") },
        querySelectorAll: (selector) => (/dialog/.test(selector) ? dialogs.map((text) => ({ innerText: text, getClientRects: () => [1] })) : []),
        elementFromPoint: () => (centre ? middle : null) } });
  };
  assert.equal(vm.runInContext(BLOCKED, blockedPage({ centre: "接收短信验证码 为确保是本人操作抖音账号" })), true, "the SMS check in the middle");
  assert.equal(vm.runInContext(BLOCKED, blockedPage({ dialogs: ["接收短信验证码 请输入验证码 取消 验证"] })), true, "the SMS check as a dialog");
  assert.equal(vm.runInContext(BLOCKED, blockedPage({ longStart: true })), false, "the words deep in a comment list: not a check");
  assert.equal(vm.runInContext(BLOCKED, blockedPage({ dialogs: ["视频描述 " + "好评 ".repeat(200) + "终于完成验证了哈哈"] })), false, "a player layer whose comments say it: not a check");

  // Time runs on a clock of its own here: the waits are seconds long on a slow connection.
  const clock = () => { let t = 0; return { now: () => t, pause: async (ms) => { t += ms; } }; };

  // Search (test account, 2026-11-22): counts once the page has gone to the results; a box redrawn under
  // the typing is found again; a check put up instead ends it for the caller's verification handling.
  const searchPage = ({ throwFirst = false, goesTo = "results" } = {}) => {
    let types = 0, url = "https://www.douyin.com/?recommend=1";
    return { types: () => types, page: {
      find: async () => ({ nodeType: 1, localName: "input", attributes: ["data-e2e", "searchbar-input"] }),
      type: async () => { types += 1; if (throwFirst && types === 1) throw new Error("stale node"); },
      send: async () => { if (goesTo === "results") url = "https://www.douyin.com/jingxuan/search/x"; },
      url: async () => url, evaluate: async () => goesTo === "check" } };
  };
  const redrawn = searchPage({ throwFirst: true });
  assert.equal(await douyin.search(redrawn.page, "洗地机", clock()), true, "a box redrawn under the typing: typed again");
  assert.equal(redrawn.types(), 2);
  const checked = searchPage({ goesTo: "check" });
  assert.equal(await douyin.search(checked.page, "洗地机", clock()), true, "a check put up instead: handed to the caller at once");
  assert.equal(checked.types(), 1, "not typed again under the check");
  assert.equal(await douyin.search(searchPage({ goesTo: "nowhere" }).page, "洗地机", clock()), false, "never went to the results: false");

  // Search results (dev PC and test account, 2026-11-22): slow to come (24 s seen), waited for up to the
  // limit; opened only when the player is on screen, a script click on a card having once opened nothing.
  const results = ({ tabAfter = 0, cardAfter = 0, opensOn = "mouse", inList = true, playerLate = 0 } = {}) => {
    let tabFinds = 0, cardFinds = 0, player = false, lateChecks = -1;
    const clicks = { tab: 0, card: 0, script: 0 };
    const tabNode = { nodeType: 1, localName: "div", attributes: ["data-key", "video"] };
    const cardNode = { nodeType: 1, localName: "a", attributes: inList ? [] : ["href", "//www.douyin.com/video/7672672142349094182"] };
    const view = { ancestors: () => (inList ? [{ localName: "ul", attributes: ["data-e2e", "scroll-list"] }] : []) };
    const open = () => { if (playerLate) lateChecks = 0; else player = true; };
    const page = {
      find: async (predicate) => {
        if (predicate(tabNode, view)) return ++tabFinds > tabAfter ? tabNode : null;
        if (predicate(cardNode, view)) return ++cardFinds > cardAfter ? cardNode : null;
        return null;
      },
      click: async (node) => { if (node === tabNode) clicks.tab += 1; else { clicks.card += 1; if (opensOn === "mouse") open(); } return true; },
      evaluate: async (expression) => {
        if (expression.includes("link.click()")) { const shown = cardFinds > cardAfter; if (shown) { clicks.script += 1; if (opensOn === "script") open(); } return shown; }
        if (lateChecks >= 0 && ++lateChecks > playerLate) player = true;
        return player;
      }
    };
    return { page, clicks };
  };
  const slow = results({ tabAfter: 2, cardAfter: 2 });
  assert.equal(await douyin.openFirstResult(slow.page, { waitMs: 20_000, ...clock() }), true, "results that come late are waited for");
  assert.deepEqual(slow.clicks, { tab: 1, card: 1, script: 0 }, "the tab once it showed, then the first card like a person");
  assert.equal(await douyin.openFirstResult(results({ cardAfter: 999 }).page, { waitMs: 2_500, ...clock() }), false, "results that never come: given up at the limit");
  const noTab = results({ tabAfter: 999 });
  assert.equal(await douyin.openFirstResult(noTab.page, { waitMs: 9_000, ...clock() }), true, "no 视频 tab: the results on screen are still opened");
  assert.equal(noTab.clicks.tab, 0);
  const scriptOnly = results({ opensOn: "script" });
  assert.equal(await douyin.openFirstResult(scriptOnly.page, { waitMs: 45_000, ...clock() }), true, "a card a click does not open: a script click next");
  assert.deepEqual(scriptOnly.clicks, { tab: 1, card: 2, script: 1 });
  assert.equal(await douyin.openFirstResult(results({ opensOn: "never" }).page, { waitMs: 3_000, ...clock() }), false, "clicked but no player: not opened");
  // The player came after the wait for it: no more clicks, they would land on it (review 2026-11-22).
  const late = results({ playerLate: 8 });
  assert.equal(await douyin.openFirstResult(late.page, { waitMs: 60_000, ...clock() }), true, "a player that came late is taken");
  assert.equal(late.clicks.card, 1, "and not clicked under");
  // On the 视频 tab only the results list counts; any link to a video only on a page without the tab.
  assert.equal(await douyin.openFirstResult(results({ inList: false }).page, { waitMs: 6_000, ...clock() }), false, "a video link outside the list: not a result");
  assert.equal(await douyin.openFirstResult(results({ inList: false, tabAfter: 999 }).page, { waitMs: 6_000, ...clock() }), true, "no tab: a video link is a result");

  const source = fs.readFileSync(path.join(__dirname, "social-nurture-drivers.cjs"), "utf8");
  assert.doesNotMatch(source, /key\(page, "Escape"/u, "Escape closes the whole player on a search result: never pressed");
  assert.match(source, /留下你的精彩评论/u, "the comment editor is opened from its placeholder");
  assert.match(source, /我知道了/u, "the first-player guide is closed");
  assert.doesNotMatch(source, /document\.querySelector\('\$\{ACTIVE\}/u, "no reading of the first active video in the document");
  console.log("social nurture drivers self-check passed: the video on screen is the one read, and a like is read back as it was found");
})().catch((error) => { console.error(error); process.exit(1); });
