// GEO: publishing an article on a media platform's own editor and asking Doubao a question, in the
// account's own Chrome profile. A channel opens only after a real article went out on a real account
// (`available`). Every step reports what it could not find instead of guessing; a verification is left to
// the person at the window.
const { findBrowser, launchBrowser } = require("./social-browser.cjs");
const { pageFor, attr, textOf, sleep } = require("./social-page.cjs");

const fail = (code, message) => Object.assign(new Error(message), { code });
const VERIFY = /验证码|安全验证|拖动滑块|完成验证|请按住滑块|点击完成验证/;
const VERIFY_PROBE = `(() => { const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 40; };
  return [...document.querySelectorAll("iframe")].some((frame) => /captcha|verify/i.test(frame.src) && shown(frame))
    || [...document.querySelectorAll('[class*="captcha" i],[id*="captcha" i],[class*="verify-" i]')].some(shown); })()`;
// Compared without whitespace and the zero-width spaces editors insert.
const squash = (value) => String(value ?? "").replace(/[\s​﻿]+/g, "");
const paragraphs = (body) => String(body || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
const shownText = async (page) => String(await page.evaluate("document.body ? document.body.innerText : ''").catch(() => "") || "");

async function pressEnter(page) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}
// Types paragraph by paragraph, the way a person would, so the editor builds real paragraphs.
async function typeBody(page, editor, body) {
  await page.click(editor);
  await sleep(300);
  // An autosaved draft can be restored here; the confirmed text replaces it.
  await page.call(editor, `function () { this.focus(); const range = document.createRange(); range.selectNodeContents(this); const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range); }`);
  const lines = paragraphs(body);
  for (const [index, line] of lines.entries()) {
    await page.send("Input.insertText", { text: line });
    if (index < lines.length - 1) { await pressEnter(page); await sleep(40); }
  }
  await sleep(600);
}
// Both must read back as the confirmed text before the publish button is touched.
function sameArticle({ title, body }, job) {
  const wanted = paragraphs(job.body).join("");
  return squash(title) === squash(job.title) && squash(body) === squash(wanted);
}

// While a verification is on screen the window comes to the front and the wait goes on; only the person passes it.
async function waitThroughVerify(page, done, { ms = 30_000, verifyMs = 10 * 60_000, shouldStop = () => false, onDetail = () => {} } = {}) {
  let until = Date.now() + ms, waiting = false;
  for (;;) {
    if (shouldStop()) throw fail("GEO_STOPPED", "已停下。");
    const result = await done();
    if (result) return result;
    const blocked = Boolean(await page.evaluate(VERIFY_PROBE).catch(() => false));
    if (blocked && !waiting) { waiting = true; until = Date.now() + verifyMs; await page.front(); onDetail("平台要求验证：请在弹出的 Chrome 窗口里完成，完成后会自动继续。"); }
    if (!blocked && waiting) { waiting = false; until = Date.now() + ms; onDetail(""); }
    if (Date.now() > until) { if (blocked) throw fail("GEO_VERIFY_TIMEOUT", "平台的验证 10 分钟内没有完成，已停下。"); return null; }
    await sleep(1000);
  }
}

const ZHIHU = {
  id: "zhihu", name: "知乎", titleLimit: 100,
  home: "https://www.zhihu.com/signin", hosts: ["zhihu.com"], loginCookies: ["z_c0"],
  editorUrl: "https://zhuanlan.zhihu.com/write",
  loginRequired: (url) => /\/signin|\/signup/.test(url),
  async fill(page, job) {
    const title = await page.find((node) => node.localName === "textarea" && /标题/.test(attr(node, "placeholder") || ""));
    if (!title) throw fail("GEO_FORM_CHANGED", "没有找到知乎的标题输入框，平台页面可能改版了。");
    await page.type(title, job.title);
    const editor = await page.find(page.byClass("public-DraftEditor-content"));
    if (!editor) throw fail("GEO_FORM_CHANGED", "没有找到知乎的正文输入框，平台页面可能改版了。");
    await typeBody(page, editor, job.body);
    return { read: async () => ({ title: await page.valueOf(title), body: await page.valueOf(editor) }) };
  },
  publishButton: `[...document.querySelectorAll("button")].find((el) => el.innerText.trim() === "发布" && el.className.includes("Button--primary"))`,
  // A published article lands on its own page. The draft autosaved while typing lives at /p/<id>/edit, so
  // that address says nothing (2026-11-02: it read as published while the button still said 发布中).
  published: (url) => (/^https:\/\/zhuanlan\.zhihu\.com\/p\/\d+\/?(\?|#|$)/.test(url) ? { status: "public", url: url.split(/[?#]/)[0] } : null)
};

// The centre of an element, only where it is itself on top: a tip or dialog over it would take the click.
const pointOf = (page, expression) => page.evaluate(`(() => { const el = ${expression}; if (!el || el.disabled) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); if (!r.width || !r.height) return null; const x = r.x + r.width / 2, y = r.y + r.height / 2, top = document.elementFromPoint(x, y); return top && (top === el || el.contains(top)) ? { x, y } : null; })()`);

const TOUTIAO = {
  id: "toutiao", name: "今日头条", titleLimit: 30,
  home: "https://mp.toutiao.com/", hosts: ["toutiao.com"], loginCookies: ["sessionid", "sso_uid_tt"],
  editorUrl: "https://mp.toutiao.com/profile_v4/graphic/publish",
  loginRequired: (url) => /\/auth\/page\/login|sso\.toutiao\.com|\/login/.test(url),
  async fill(page, job) {
    // A first-visit promotion can cover the page. Only its X closes it: its big button accepts an agreement,
    // which is the user's own decision and not the software's.
    await page.evaluate(`[...document.querySelectorAll("svg.close-btn")].find((el) => el.getClientRects().length)?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`).catch(() => {});
    await sleep(1200);
    const title = await page.find((node) => node.localName === "textarea" && /文章标题/.test(attr(node, "placeholder") || ""));
    if (!title) throw fail("GEO_FORM_CHANGED", "没有找到头条的标题输入框，平台页面可能改版了。");
    await page.type(title, job.title);
    const editor = await page.find(page.byClass("ProseMirror"));
    if (!editor) throw fail("GEO_FORM_CHANGED", "没有找到头条的正文输入框，平台页面可能改版了。");
    await typeBody(page, editor, job.body);
    // 展示封面 is required and defaults to a single image; this version publishes text only.
    const noCover = await page.find((node) => node.localName === "label" && attr(node, "class")?.includes("byte-radio") && /无封面/.test(textOf(node)));
    if (!noCover) throw fail("GEO_FORM_CHANGED", "没有找到头条的「无封面」选项，平台页面可能改版了。");
    await page.click(noCover);
    await sleep(600);
    // 头条首发 claims the article appears nowhere else, which the software cannot know: it stays off.
    const claim = await page.find((node) => node.localName === "label" && attr(node, "class")?.includes("byte-checkbox-checked") && /头条首发/.test(textOf(node)));
    if (claim) { await page.click(claim); await sleep(300); }
    // Toutiao asks authors to label AI-written text.
    if (job.aiWritten) {
      const label = await page.find((node) => node.localName === "label" && /引用AI/.test(textOf(node)));
      if (!label) throw fail("GEO_FORM_CHANGED", "没有找到头条的「引用AI」声明，平台页面可能改版了。");
      await page.click(label);
      await sleep(400);
    }
    return { read: async () => ({ title: await page.valueOf(title), body: await page.valueOf(editor) }) };
  },
  publishButton: `[...document.querySelectorAll("button")].find((el) => el.innerText.trim() === "预览并发布" && el.getClientRects().length)`,
  // 预览并发布 can stop at a preview with its own confirm button.
  confirmButton: `[...document.querySelectorAll("button")].find((el) => /^(确认发布|确定发布)$/.test(el.innerText.trim()) && el.getClientRects().length)`,
  // Landing on the article list says nothing by itself: the article must be listed, and its status decides.
  // Confirmed 2026-11-02: the list shows the title, then its time and 已发布.
  published(url, text, job) {
    if (!/\/profile_v4\/graphic\/articles/.test(url)) return null;
    const lines = String(text).split(/\n/).map((line) => line.trim()).filter(Boolean);
    for (let at = 0; at < lines.length; at++) {
      if (lines[at] !== job.title) continue;
      // The row's own time and status follow its title. An older article of the same title does not count.
      const stamp = lines[at + 1]?.match(/^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
      if (!stamp) continue;
      const when = new Date(new Date(job.clickedAtMs).getFullYear(), Number(stamp[1]) - 1, Number(stamp[2]), Number(stamp[3]), Number(stamp[4])).getTime();
      if (when < job.clickedAtMs - 60_000) continue;
      const status = lines[at + 2] || "";
      if (/已发布/.test(status)) return { status: "public" };
      return /审核/.test(status) ? { status: "reviewing", reason: "已提交，头条审核通过后公开。" } : null;
    }
    return null;
  },
  linkOf: (job) => `[...document.querySelectorAll("a[href]")].find((a) => (a.innerText || "").trim() === ${JSON.stringify(job.title)} && /toutiao\\.com\\/(item|article)\\//.test(a.href))?.href.split("?")[0] || ""`
};

const DRIVERS = { zhihu: ZHIHU, toutiao: TOUTIAO };

const DOUBAO = {
  name: "豆包", url: "https://www.doubao.com/chat/", hosts: ["doubao.com"], loginCookies: ["sessionid", "sessionid_ss"],
  loginRequired: (url, text) => /\/login/.test(url) || /手机号登录|扫码登录|登录后/.test(text) && !/用户\d+/.test(text),
  input: `document.querySelector('[data-testid="chat_input_input"][contenteditable="true"], [data-testid="chat_input_input"] [contenteditable="true"], [contenteditable="true"]')`,
  answer: `[...document.querySelectorAll('[data-testid="receive_message"]')].at(-1)?.querySelector('[data-testid="message_text_content"]')`,
  finished: `[...document.querySelectorAll('[data-testid="receive_message"]')].at(-1)?.querySelector('[data-testid="message_action_bar"]')`,
  referencesControl: `(() => { const all = [...document.querySelectorAll('[data-testid="receive_message"]')].at(-1)?.querySelectorAll("*") || []; const el = [...all].filter((node) => /参考|參考/.test(node.innerText || "") && (node.innerText || "").length < 30 && node.getClientRects().length).at(-1); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  // Each cited page is a numbered link inside the answer's message; the leading number is not part of its title.
  references: `[...[...document.querySelectorAll('[data-testid="receive_message"]')].at(-1).querySelectorAll('[data-testid="message_content"] a[href^="http"]')].filter((a) => /^\\s*\\d+[.、]/.test(a.innerText || "")).map((a) => ({ title: a.innerText.replace(/^\\s*\\d+[.、]\\s*/, "").replace(/\\s+/g, " ").trim().slice(0, 200), url: a.href })).slice(0, 50)`
};

// Channels shown to the user. Each opens only after a real publish was confirmed on a real account.
const GEO_CHANNELS = [
  // Confirmed by a real article on 2026-11-02.
  { id: "toutiao", name: "今日头条", available: true, titleLimit: TOUTIAO.titleLimit },
  { id: "baijiahao", name: "百家号", available: false, reason: "待开放" },
  { id: "sohu", name: "搜狐号", available: false, reason: "待开放" },
  // Confirmed by a real article on 2026-11-02.
  { id: "zhihu", name: "知乎", available: true, titleLimit: ZHIHU.titleLimit }
];
const GEO_ACCOUNT_PLATFORMS = {
  zhihu: { name: "知乎", home: ZHIHU.home, hosts: ZHIHU.hosts, loginCookies: ZHIHU.loginCookies },
  toutiao: { name: "今日头条", home: TOUTIAO.home, hosts: TOUTIAO.hosts, loginCookies: TOUTIAO.loginCookies },
  doubao: { name: DOUBAO.name, home: DOUBAO.url, hosts: DOUBAO.hosts, loginCookies: DOUBAO.loginCookies }
};

function createGeoBrowserAdapter({ launch = launchBrowser, executable = findBrowser(), makePage = pageFor } = {}) {
  const open = new Set();
  async function withPage(profileDir, work) {
    const browser = launch({ executable, profileDir });
    open.add(browser);
    try {
      const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
      await browser.send("DOM.enable", {}, sessionId);
      return await work(makePage(browser, sessionId), browser);
    } finally { open.delete(browser); await browser.close().catch(() => {}); }
  }
  async function publish({ platform, profileDir, title, body, aiWritten = false, shouldStop = () => false, onDetail = () => {}, beforeClick = () => {} }) {
    const driver = DRIVERS[platform];
    if (!driver) throw fail("GEO_CHANNEL_UNAVAILABLE", "这个平台还没开放发布。");
    return withPage(profileDir, async (page) => {
      const job = { title, body, aiWritten };
      onDetail(`打开${driver.name}的写文章页面`);
      await page.navigate(driver.editorUrl);
      await sleep(8000);
      if (driver.loginRequired(String(await page.url()))) throw fail("GEO_LOGIN_REQUIRED", `${driver.name}需要重新扫码登录。`);
      onDetail("填写标题和正文");
      const form = await driver.fill(page, job);
      if (!sameArticle(await form.read(), job)) throw fail("GEO_FORM_MISMATCH", `${driver.name}页面上的内容和你确认的不一致，没有发布。`);
      await sleep(2000);
      const point = await pointOf(page, driver.publishButton);
      if (!point) throw fail("GEO_FORM_CHANGED", `没有找到${driver.name}可以点的发布按钮，可能还有必填项没有填。`);
      if (shouldStop()) throw fail("GEO_STOPPED", "已停下，这篇没有发。");
      job.clickedAtMs = Date.now();
      beforeClick();
      await page.mouse(point);
      onDetail("已点发布，等平台确认");
      if (driver.confirmButton) {
        await sleep(3000);
        const confirm = await waitThroughVerify(page, () => pointOf(page, driver.confirmButton), { ms: 12_000, shouldStop, onDetail });
        if (confirm) await page.mouse(confirm);
      }
      const result = await waitThroughVerify(page, async () => driver.published(String(await page.url()), await shownText(page), job), { ms: 40_000, shouldStop, onDetail });
      if (result) return driver.linkOf ? { ...result, url: String(await page.evaluate(driver.linkOf(job)).catch(() => "") || result.url || "") } : result;
      const hint = (await shownText(page)).match(/[^\n]{0,30}(话题|必填|失败|审核|违规|频繁)[^\n]{0,30}/)?.[0] || "";
      return { status: "unknown", reason: hint ? `已点发布，页面提示：${hint.slice(0, 100)}。请到平台上看一下，不会自动重发。` : "已点发布，但没等到平台确认。请到平台上看一下，不会自动重发。" };
    });
  }
  // The page first shows a placeholder textarea and swaps in a rich-text box a few seconds later. Enter sends
  // (the send button does not answer mouse events from here); the box emptying is what proves it went out.
  async function ask({ profileDir, question, shouldStop = () => false, onDetail = () => {} }) {
    return withPage(profileDir, async (page) => {
      await page.navigate(DOUBAO.url);
      const box = await waitThroughVerify(page, () => page.evaluate(`Boolean(${DOUBAO.input})`), { ms: 25_000, shouldStop, onDetail });
      if (DOUBAO.loginRequired(String(await page.url()), await shownText(page))) throw fail("GEO_LOGIN_REQUIRED", "豆包需要重新扫码登录。");
      if (!box) throw fail("GEO_FORM_CHANGED", "没有找到豆包的输入框，平台页面可能改版了。");
      await sleep(1500);
      const spot = await page.evaluate(`(() => { const r = (${DOUBAO.input}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await page.mouse(spot);
      await sleep(400);
      await page.send("Input.insertText", { text: question });
      await sleep(1200);
      const typed = String(await page.evaluate(`(${DOUBAO.input}).innerText`) || "");
      if (squash(typed) !== squash(question)) throw fail("GEO_FORM_MISMATCH", "豆包输入框里的问题和要问的不一致，没有发送。");
      // No text on the key event: a carriage return would be typed into the box as a line break.
      await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await sleep(2500);
      if (squash(await page.evaluate(`(${DOUBAO.input})?.innerText || ""`))) throw fail("GEO_NOT_SENT", "问题没有发出去，可以再查一次。");
      // Finished when the answer stops growing and its action bar appears.
      let last = "", still = 0;
      const answered = await waitThroughVerify(page, async () => {
        const now = String(await page.evaluate(`(${DOUBAO.answer})?.innerText || ""`) || "");
        still = now && now === last ? still + 1 : 0; last = now;
        return still >= 3 && await page.evaluate(`Boolean(${DOUBAO.finished})`);
      }, { ms: 180_000, shouldStop, onDetail });
      if (!answered) throw fail("GEO_ANSWER_EMPTY", "豆包长时间没有答完，可以再查一次。");
      // Cited pages are behind 参考 N 篇资料; expanding them asks nothing new. No such line means no search was used.
      const control = await page.evaluate(DOUBAO.referencesControl);
      if (!control) return { answer: last, references: [] };
      await page.mouse(control);
      await sleep(3000);
      const references = await page.evaluate(DOUBAO.references);
      return { answer: last, references: Array.isArray(references) ? references : null };
    });
  }
  // Closing the browser ends whatever step is in flight.
  const stop = () => { for (const browser of open) void browser.close().catch(() => {}); };
  return { publish, ask, stop, dispose: stop };
}

module.exports = { createGeoBrowserAdapter, GEO_CHANNELS, GEO_ACCOUNT_PLATFORMS, DRIVERS, DOUBAO, sameArticle, paragraphs, waitThroughVerify, VERIFY };
