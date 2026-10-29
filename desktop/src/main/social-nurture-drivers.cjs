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

async function key(page, name, code, keyCode, text) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode: keyCode });
}

const DRIVERS = {
  douyin: {
    name: "抖音", host: "douyin.com", home: "https://www.douyin.com/?recommend=1",
    // Signed in, the header links to the account's own page.
    signedIn: async (page) => Boolean(await page.evaluate(`Boolean(document.querySelector('a[href*="/user/self"]'))`)),
    blocked: async (page) => Boolean(await page.evaluate(BLOCKED).catch(() => false)),
    // The site's own prompts over the page, such as 「是否保存登录信息？」 (seen on a customer computer
    // 2026-10-29), are declined so nothing about the account changes.
    async dismissPrompts(page) {
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
      const playing = () => page.evaluate(`Boolean(document.querySelector('${ACTIVE}'))`);
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
    async openFirstResult(page) {
      const tab = await page.find((node) => attr(node, "data-key") === "video");
      if (tab) { await page.click(tab); await sleep(4000); }
      const opened = await page.evaluate(`(() => { const link = [...document.querySelectorAll('ul[data-e2e="scroll-list"] li a, .search-result-card a')].find((el) => el.getClientRects().length);
        if (!link) return false; link.click(); return true; })()`);
      if (opened) await sleep(4000);
      return Boolean(opened);
    },
    // The video now playing: an id for not interacting twice, its text and its author.
    async current(page) {
      return await page.evaluate(`(() => { const active = document.querySelector('${ACTIVE}'); if (!active) return null;
        const desc = (active.querySelector('[data-e2e="video-desc"]') || {}).innerText || "";
        const author = ((active.querySelector(".account-name-text") || {}).innerText || "").replace(/^@/, "");
        const id = active.getAttribute("data-e2e-vid") || (location.href.match(/(?:modal_id=|video\\/)(\\d+)/) || [])[1] || "";
        return { id: id || (author + "|" + desc).slice(0, 120), desc: desc.slice(0, 300), author: author.slice(0, 60) }; })()`) || null;
    },
    async like(page) {
      const button = await page.find((node, view) => attr(node, "data-e2e-state") === "video-player-no-digged" && inActive(view, node));
      if (!button) return "missing";
      await page.click(button); await sleep(1500);
      return await page.evaluate(`Boolean(document.querySelector('${ACTIVE} [data-e2e-state="video-player-digged"]'))`) ? "done" : "unconfirmed";
    },
    async follow(page) {
      const button = await page.find((node, view) => inActive(view, node) && /follow/i.test(attr(node, "data-e2e") || "") && !/已关注|互相关注/.test(node.children?.map?.((child) => child.nodeValue || "").join("") || ""));
      if (!button) return "missing";
      await page.click(button); await sleep(1500);
      return "done";
    },
    // Opens the comment panel, types like a person (one character at a time), sends with Enter,
    // and looks for the comment in the list: a comment the platform hides is not shown back.
    async comment(page, text, delay) {
      const icon = await page.find((node, view) => attr(node, "data-e2e") === "feed-comment-icon" && inActive(view, node));
      if (!icon) return "missing";
      await page.click(icon); await sleep(1500);
      const box = await page.find((node, view) => view.ancestors(node).some((up) => String(attr(up, "class") || "").includes("comment-input-inner-container")) && attr(node, "contenteditable") === "true");
      if (!box) { await key(page, "Escape", "Escape", 27); return "missing"; }
      await page.click(box);
      for (const char of text) { await page.send("Input.insertText", { text: char }); await sleep(delay()); }
      await key(page, "Enter", "Enter", 13, "\r");
      await sleep(3000);
      const shown = await page.evaluate(`[...document.querySelectorAll('[data-e2e="comment-item"]')].some((item) => item.innerText.includes(${JSON.stringify(text)}))`);
      await key(page, "Escape", "Escape", 27);
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

module.exports = { DRIVERS, nurtureDriverFor, BLOCKED };
