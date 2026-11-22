// What 养号 does on a platform's own web site. The Douyin selectors follow what the
// competing product uses on www.douyin.com (read from its installed code on 2026-10-29);
// they were not tried on this computer, so every step answers whether it found its
// element and the caller reports the ones that are missing, with a screenshot.
const { attr, sleep } = require("./social-page.cjs");

const fail = (code, message) => Object.assign(new Error(message), { code });
// A verification shown on the page: a captcha frame or panel, or an SMS check.
const BLOCKED = `(() => { const shown = (el) => el.getClientRects().length > 0;
  return [...document.querySelectorAll("iframe")].some((frame) => /captcha|verify/i.test(frame.src) && shown(frame))
    || [...document.querySelectorAll('[class*="captcha" i],[id*="captcha" i],[class*="verify-" i]')].some(shown)
    || /接收短信验证码|拖动滑块|完成验证|安全验证/.test(document.body ? document.body.innerText.slice(0, 4000) : ""); })()`;
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
  const plus = [...active.querySelectorAll("*")].find((el) => { const r = el.getBoundingClientRect();
    return r.width >= 12 && r.width <= 36 && r.height >= 12 && r.height <= 36 && r.width < a.width
      && r.left + r.width / 2 >= a.left + a.width * 0.25 && r.left + r.width / 2 <= a.right - a.width * 0.25
      && r.top >= a.top + a.height * 0.5 && r.top <= a.bottom + 10; });
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
async function closeComments(page) {
  const open = await page.evaluate(`[...document.querySelectorAll('[data-e2e="comment-list"]')].some((el) => { const r = el.getBoundingClientRect(); return r.width > 50 && r.left < innerWidth && r.right > 0; })`).catch(() => false);
  if (!open) return;
  const icon = await commentIcon(page);
  if (icon) { await page.click(icon); await sleep(1000); }
}

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
    async search(page, keyword) {
      const box = await page.find((node) => (node.localName === "input" && attr(node, "data-e2e") === "searchbar-input") || (node.localName === "textarea" && attr(node, "data-e2e") !== "comment-input"));
      if (!box) return false;
      await page.type(box, keyword);
      await key(page, "Enter", "Enter", 13, "\r");
      return true;
    },
    // Search results: the 视频 tab, then the first video, which opens the player.
    // On a slow connection the results take more than ten seconds (dev PC 2026-11-22), so this waits for
    // them, up to 45 seconds (24 s seen), instead of a fixed few: the tab first, then a result to open.
    async openFirstResult(page, { waitMs = 45_000 } = {}) {
      const deadline = Date.now() + waitMs;
      // The tab gets a part of the wait: a page without it (already on videos, or laid out anew) still has
      // results to open, and they are tried at least once (review 2026-11-22).
      const tabDeadline = Date.now() + Math.min(15_000, waitMs / 3);
      let tab = null;
      while (!tab && Date.now() < tabDeadline) { tab = await page.find((node) => attr(node, "data-key") === "video"); if (!tab) await sleep(1000); }
      if (tab) await page.click(tab);
      const openFirst = `(() => { const link = [...document.querySelectorAll('ul[data-e2e="scroll-list"] li a, .search-result-card a')].find((el) => el.getClientRects().length);
        if (!link) return false; link.click(); return true; })()`;
      let opened = false;
      do { await sleep(1000); opened = Boolean(await page.evaluate(openFirst).catch(() => false)); } while (!opened && Date.now() < deadline);
      if (opened) await sleep(4000);
      return opened;
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
      await clickAt(page, found.x, found.y); await sleep(1500);
      const after = await page.evaluate(FOLLOW_PLUS).catch(() => null);
      return after?.state === "no_plus" ? "done" : "unconfirmed";
    },
    // Opens the comment panel, types like a person (one character at a time), sends with Enter,
    // and looks for the comment in the list: a comment the platform hides is not shown back.
    async comment(page, text, delay) {
      const icon = await commentIcon(page);
      if (!icon) return "missing";
      await page.click(icon); await sleep(1500);
      const editor = () => page.find((node, view) => view.ancestors(node).some((up) => String(attr(up, "class") || "").includes("comment-input-inner-container")) && attr(node, "contenteditable") === "true");
      let box = await editor();
      // The editor appears only once its placeholder is clicked (dev PC 2026-11-22).
      if (!box) {
        const placeholder = await page.find((node) => (node.children || []).some((child) => child.nodeType === 3 && /^留下你的精彩评论/.test(child.nodeValue.trim())));
        if (placeholder) { await page.click(placeholder); await sleep(1000); box = await editor(); }
      }
      if (!box) { await closeComments(page); return "missing"; }
      await page.click(box);
      for (const char of text) { await page.send("Input.insertText", { text: char }); await sleep(delay()); }
      await key(page, "Enter", "Enter", 13, "\r");
      await sleep(3000);
      const shown = await page.evaluate(`[...document.querySelectorAll('[data-e2e="comment-item"]')].some((item) => item.innerText.includes(${JSON.stringify(text)}))`);
      await closeComments(page);
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
