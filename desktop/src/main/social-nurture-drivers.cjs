// What 养号 does on a platform's own web site. The Douyin selectors follow what the
// competing product uses on www.douyin.com (read from its installed code on 2026-10-29);
// they were not tried on this computer, so every step answers whether it found its
// element and the caller reports the ones that are missing, with a screenshot.
const { attr, sleep } = require("./social-page.cjs");

const fail = (code, message) => Object.assign(new Error(message), { code });
// A verification shown on the page: a captcha frame or panel, or an SMS check. The words are looked for at
// the start of the page and in any dialog on screen: the SMS check after a comment (test account,
// 2026-11-22) came as a dialog over a page whose text ran far past the start, comments included.
const BLOCKED = `(() => { const shown = (el) => el.getClientRects().length > 0;
  const words = /接收短信验证码|拖动滑块|完成验证|安全验证/;
  return [...document.querySelectorAll("iframe")].some((frame) => /captcha|verify/i.test(frame.src) && shown(frame))
    || [...document.querySelectorAll('[class*="captcha" i],[id*="captcha" i],[class*="verify-" i]')].some(shown)
    || words.test(document.body ? document.body.innerText.slice(0, 4000) : "")
    || [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="modal" i],[class*="dialog" i],[class*="popup" i]')]
      .some((el) => shown(el) && words.test(el.innerText || ""))
    // Whatever its markup, such a check sits in the middle of the screen, over everything.
    || (() => { let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      for (let up = 0; el && up < 8; up++, el = el.parentElement) { const text = el.innerText || ""; if (text.length < 600 && words.test(text)) return true; }
      return false; })(); })()`;
const ACTIVE = '[data-e2e="feed-active-video"]';
const inActive = (view, node) => view.ancestors(node).some((up) => attr(up, "data-e2e") === "feed-active-video");
// The video on screen. A search result plays in a layer over the results page and the page can keep
// another "active" video behind it, hidden; the first one in the document was often that hidden one
// (field 2026-11-18..20: a like already shown red was reported unconfirmed, and steps went on looking
// for buttons after the player had closed). Only one that is on screen counts.
const ON_SCREEN_ACTIVE = `[...document.querySelectorAll('${ACTIVE}')].find((el) => { const r = el.getBoundingClientRect();
  return r.width > 2 && r.height > 2 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; })`;

// Douyin's follow "+": on the player it is a 24 px icon over the lower edge of the author's
// avatar, with no name of its own (dev PC, signed in, 2026-11-22). It is found by where it sits.
const FOLLOW_PLUS = `(() => { const active = ${ON_SCREEN_ACTIVE}; if (!active) return { state: "no_video" };
  const avatar = [...active.querySelectorAll('[data-e2e="video-avatar"]')].find((el) => el.getClientRects().length);
  if (!avatar) return { state: "no_avatar" };
  const a = avatar.getBoundingClientRect();
  // Drawn, not only laid out: once followed the "+" fades to nothing but stays in the page (test account,
  // 2026-11-22: gone on screen, still found, the follow reported unconfirmed).
  const drawn = (el) => { for (let e = el; e && e !== active; e = e.parentElement) { const s = getComputedStyle(e);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.1) return false; } return true; };
  const plus = [...active.querySelectorAll("*")].find((el) => { const r = el.getBoundingClientRect();
    return r.width >= 12 && r.width <= 36 && r.height >= 12 && r.height <= 36 && r.width < a.width
      && r.left + r.width / 2 >= a.left + a.width * 0.25 && r.left + r.width / 2 <= a.right - a.width * 0.25
      && r.top >= a.top + a.height * 0.5 && r.top <= a.bottom + 10 && drawn(el); });
  if (!plus) return { state: "no_plus" };
  const r = plus.getBoundingClientRect();
  return { state: "plus", x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
async function clickAt(page, x, y) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
  }
}
// Where the comment panel was opened from: clicking the icon again closes it. Escape is never used here:
// on a search result it closes the whole player (dev PC 2026-11-22), and every step after it found nothing
// (field 2026-11-18..20: comments/follows "missing" over the results grid).
const commentIcon = (page) => page.find((node, view) => attr(node, "data-e2e") === "feed-comment-icon" && inActive(view, node));

async function key(page, name, code, keyCode, text) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode: keyCode });
}

const DRIVERS = {
  douyin: {
    name: "抖音", host: "douyin.com", home: "https://www.douyin.com/?recommend=1",
    // Signed in, the header's top-right avatar links to the account's own page. The left bar's 我的 links
    // there too, signed in or not (dev PC 2026-11-22: a signed-out page was taken as signed in).
    signedIn: async (page) => Boolean(await page.evaluate(`[...document.querySelectorAll('a[href*="/user/self"]')].some((a) => {
      const r = a.getBoundingClientRect(); return r.width > 2 && r.height > 2 && r.top < 120 && r.left > innerWidth * 0.5; })`)),
    blocked: async (page) => Boolean(await page.evaluate(BLOCKED).catch(() => false)),
    // The site's own prompts over the page, such as 「是否保存登录信息？」 (seen on a customer computer
    // 2026-10-29), are declined so nothing about the account changes.
    async dismissPrompts(page) {
      // The first player of an account or browser shows a guide over the video (「滚动鼠标…查看更多推荐视频」,
      // 我知道了) that takes every click until it is closed (dev PC 2026-11-22).
      const guide = await page.find((node) => (node.children || []).some((child) => child.nodeType === 3 && child.nodeValue.trim() === "我知道了"));
      if (guide) { await page.click(guide); await sleep(1000); }
      for (let i = 0; i < 3; i++) {
        const prompt = await page.find((node) => /是否保存登录信息/.test(node.children?.filter?.((child) => child.nodeType === 3).map((child) => child.nodeValue).join("") || ""));
        if (!prompt) return;
        const cancel = await page.find(page.byText("取消"));
        if (!cancel) return;
        await page.click(cancel); await sleep(1000);
      }
    },
    // The home address now lands on 精选, a grid of covers (2026-10-29). The one-by-one player is
    // 推荐 in the left bar; failing that, the first cover opens the player as well.
    async openFeed(page) {
      const playing = () => page.evaluate(`Boolean(${ON_SCREEN_ACTIVE})`);
      if (await playing()) return true;
      const recommend = await page.find((node) => node.localName !== "script" && (node.children || []).some((child) => child.nodeType === 3 && child.nodeValue.trim() === "推荐")
        && !(node.localName === "span" && attr(node, "data-key")));
      if (recommend) { await page.click(recommend); await sleep(4000); if (await playing()) return true; }
      const opened = await page.evaluate(`(() => { const card = [...document.querySelectorAll('a[href*="/video/"], [data-e2e="scroll-list"] li a')].find((el) => el.getClientRects().length);
        if (!card) return false; card.click(); return true; })()`);
      if (opened) { await sleep(4000); return Boolean(await playing()); }
      return false;
    },
    // A search counts once the page has gone to the results. Typed while the page was still settling,
    // the words were wiped and Enter searched nothing (test account, 2026-11-22): tried again, three times.
    async search(page, keyword) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const box = await page.find((node) => (node.localName === "input" && attr(node, "data-e2e") === "searchbar-input") || (node.localName === "textarea" && attr(node, "data-e2e") !== "comment-input"));
        if (!box) { await sleep(2000); continue; }
        await page.type(box, keyword);
        await key(page, "Enter", "Enter", 13, "\r");
        for (let wait = 0; wait < 8; wait++) {
          await sleep(1000);
          if (/\/search\//u.test(String(await page.url().catch(() => "")))) return true;
        }
      }
      return false;
    },
    // Search results: the 视频 tab, then the first video, which opens the player.
    // On a slow connection the results came after 24 s, and the tab row itself after more than 15 s; the
    // 综合 page then showed no results at all in 75 s while 视频 did (test account, 2026-11-22). So within
    // one wait the tab is clicked whenever it shows, and a result is opened once one shows; a page without
    // the tab still has its results tried.
    async openFirstResult(page, { waitMs = 60_000 } = {}) {
      const deadline = Date.now() + waitMs;
      // Opened means the player is on screen, not that a click was sent: a script click on the first card
      // while the results were still settling opened nothing (test account, 2026-11-22). The card is clicked
      // like a person would, the player waited for, and once more as a script click if it did not come.
      const playing = () => page.evaluate(`Boolean(${ON_SCREEN_ACTIVE})`).catch(() => false);
      // A result card is a link to a video (/video/<id>); the older list markup is kept as a second way.
      const firstCard = () => page.find((node, view) => node.localName === "a" && (/\/video\/\d/u.test(String(attr(node, "href") || ""))
        || view.ancestors(node).some((up) => (up.localName === "ul" && attr(up, "data-e2e") === "scroll-list")
          || String(attr(up, "class") || "").split(/\s+/u).includes("search-result-card"))));
      const scriptClick = `(() => { const link = [...document.querySelectorAll('a[href*="/video/"], ul[data-e2e="scroll-list"] li a, .search-result-card a')].find((el) => el.getClientRects().length);
        if (!link) return false; link.click(); return true; })()`;
      let mouseClicks = 0, tabClicked = false;
      for (let attempt = 0; Date.now() < deadline || attempt === 0; attempt++) {
        await sleep(1000);
        if (!tabClicked) {
          const tab = await page.find((node) => attr(node, "data-key") === "video");
          if (tab) { tabClicked = await page.click(tab); await sleep(2000); }
        }
        let clicked = false;
        // Two real clicks on the card once it is there, then script clicks.
        if (mouseClicks < 2) { const card = await firstCard(); clicked = card ? await page.click(card) : false; if (clicked) mouseClicks += 1; }
        else clicked = Boolean(await page.evaluate(scriptClick).catch(() => false));
        if (!clicked) continue;
        for (let wait = 0; wait < 8; wait++) { await sleep(1000); if (await playing()) return true; }
      }
      return false;
    },
    // The video now playing: an id for not interacting twice, its text and its author.
    async current(page) {
      return await page.evaluate(`(() => { const active = ${ON_SCREEN_ACTIVE}; if (!active) return null;
        const desc = (active.querySelector('[data-e2e="video-desc"]') || {}).innerText || "";
        const author = ((active.querySelector(".account-name-text") || {}).innerText || "").replace(/^@/, "");
        const id = active.getAttribute("data-e2e-vid") || (location.href.match(/(?:modal_id=|video\\/)(\\d+)/) || [])[1] || "";
        return { id: id || (author + "|" + desc).slice(0, 120), desc: desc.slice(0, 300), author: author.slice(0, 60) }; })()`) || null;
    },
    async like(page) {
      const button = await page.find((node, view) => attr(node, "data-e2e-state") === "video-player-no-digged" && inActive(view, node));
      if (!button) return "missing";
      await page.click(button); await sleep(1500);
      // Read back the way the button was found: a liked button on screen, in the video on screen.
      const liked = await page.find((node, view) => attr(node, "data-e2e-state") === "video-player-digged" && inActive(view, node));
      return liked ? "done" : "unconfirmed";
    },
    // The "+" over the author's avatar. No "+" beside an avatar: already followed, nothing to do.
    async follow(page) {
      const found = await page.evaluate(FOLLOW_PLUS).catch(() => null);
      if (found?.state === "no_plus") return "already";
      if (found?.state !== "plus") return "missing";
      await clickAt(page, found.x, found.y);
      // The "+" fades out after the follow is made: 1.5 s was too early on a slow connection, it went later
      // (test account, 2026-11-22). Looked at for up to 6 s.
      for (let wait = 0; wait < 12; wait++) {
        await sleep(500);
        if ((await page.evaluate(FOLLOW_PLUS).catch(() => null))?.state === "no_plus") return "done";
      }
      return "unconfirmed";
    },
    // Opens the comment panel, types like a person (one character at a time), sends with Enter,
    // and looks for the comment in the list: a comment the platform hides is not shown back.
    async comment(page, text, delay) {
      const icon = await commentIcon(page);
      if (!icon) return "missing";
      await page.click(icon);
      // The panel opened ours: closed again the same way however far it loaded (a blank, still-loading
      // panel was left open on a slow connection, test account 2026-11-22).
      const close = async () => { const again = await commentIcon(page); if (again) { await page.click(again); await sleep(1000); } };
      const editor = () => page.find((node, view) => view.ancestors(node).some((up) => String(attr(up, "class") || "").includes("comment-input-inner-container")) && attr(node, "contenteditable") === "true");
      const placeholder = () => page.find((node) => (node.children || []).some((child) => child.nodeType === 3 && /^留下你的精彩评论/.test(child.nodeValue.trim())));
      // The panel loads slowly on a slow connection: its editor, or the placeholder that opens it
      // (dev PC 2026-11-22), is waited for up to 12 s.
      let box = null;
      for (let wait = 0; wait < 12 && !box; wait++) {
        await sleep(1000);
        box = await editor();
        if (!box) { const shown = await placeholder(); if (shown) { await page.click(shown); await sleep(1000); box = await editor(); } }
      }
      if (!box) { await close(); return "missing"; }
      await page.click(box);
      for (const char of text) { await page.send("Input.insertText", { text: char }); await sleep(delay()); }
      await key(page, "Enter", "Enter", 13, "\r");
      // Read back for up to 12 s: a comment that is still sending is not one the platform hid.
      // A comment Douyin stops for a check of the account (an SMS code, test account 2026-11-22) was not
      // posted and not hidden: the check is left for the person, and the run stops on it.
      let shown = false;
      for (let wait = 0; wait < 12 && !shown; wait++) {
        await sleep(1000);
        if (await page.evaluate(BLOCKED).catch(() => false)) return "verification";
        shown = Boolean(await page.evaluate(`[...document.querySelectorAll('[data-e2e="comment-item"]')].some((item) => item.innerText.includes(${JSON.stringify(text)}))`).catch(() => false));
      }
      await close();
      return shown ? "done" : "hidden";
    },
    next: (page) => key(page, "ArrowDown", "ArrowDown", 40)
  }
};

function nurtureDriverFor(platform) {
  const driver = DRIVERS[platform];
  if (!driver) throw fail("NURTURE_PLATFORM_INVALID", "养号暂时只支持抖音。");
  return driver;
}

module.exports = { DRIVERS, nurtureDriverFor, BLOCKED, FOLLOW_PLUS };
