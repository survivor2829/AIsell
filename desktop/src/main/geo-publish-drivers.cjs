// GEO: publishing an article on a media platform's own editor and asking Doubao a question, in the
// account's own Chrome profile. A channel opens after a real article went out on a real account, or at the
// user's request (Sohu, 2026-11-02). Every step reports what it could not find instead of guessing; a verification is left to
// the person at the window.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { findBrowser, launchBrowser } = require("./social-browser.cjs");
const { pageFor, attr, textOf, sleep } = require("./social-page.cjs");

const fail = (code, message) => Object.assign(new Error(message), { code });
const VERIFY = /验证码|安全验证|拖动滑块|完成验证|请按住滑块|点击完成验证/;
const VERIFY_PROBE = `(() => { const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 40; };
  return [...document.querySelectorAll("iframe")].some((frame) => /captcha|verify/i.test(frame.src) && shown(frame))
    || [...document.querySelectorAll('[class*="captcha" i],[id*="captcha" i],[class*="verify-" i]')].some(shown); })()`;
// Compared without whitespace and the zero-width spaces editors insert.
const squash = (value) => String(value ?? "").replace(/[\s\u200b\u200c\u200d\u2060\ufeff]+/g, "");
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
  await page.call(editor, `function () { this.focus(); const doc = this.ownerDocument; const range = doc.createRange(); range.selectNodeContents(this); const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(range); }`);
  const lines = paragraphs(body);
  for (const [index, line] of lines.entries()) {
    await page.send("Input.insertText", { text: line });
    if (index < lines.length - 1) { await pressEnter(page); await sleep(40); }
  }
  await sleep(600);
}
// A slow page, or a tip passing over it, holds a field back for a while: one look 8 seconds after opening
// failed Toutiao's body field on 2026-11-09 although the second try went through. Looks again each second.
async function findSoon(page, predicate, { tries = 22, shouldStop = () => false, between = null } = {}) {
  for (let left = tries; ; left--) {
    const node = await page.find(predicate);
    if (node || left <= 0) return node;
    if (shouldStop()) throw fail("GEO_STOPPED", "已停下，这篇没有发。");
    await between?.();
    await sleep(1000);
  }
}
// Short lines in which the platform itself says why (实名认证, 额度, 禁言…). Menu items are shorter than 6 characters.
const NOTICE = /实名|认证|限制|违规|异常|频繁|禁言|额度|封禁|风险|失败|必填|审核|登录|验证|动态/;
const noticesOf = (text) => [...new Set(String(text || "").split(/\n+/).map((line) => line.trim()).filter((line) => line.length >= 6 && line.length <= 40 && NOTICE.test(line)))].slice(0, 3);
// The page as it was when a publish stopped or could not be confirmed: what a diagnosis needs and a message cannot hold.
async function pageEvidence(page, step) {
  const evidence = { step, pageUrl: "", screenshot: "", notices: [] };
  try {
    evidence.pageUrl = String(await page.url()).replace(/[?#].*$/, "");
    evidence.notices = noticesOf(await shownText(page));
    evidence.screenshot = (await page.send("Page.captureScreenshot", { format: "png" }))?.data || "";
  } catch { /* A closed or hung page leaves the failure without a picture. */ }
  return evidence;
}

// Both must read back as the confirmed text before the publish button is touched.
function sameArticle({ title, body }, job) {
  const wanted = paragraphs(job.body).join("");
  return squash(title) === squash(job.title) && squash(body) === squash(wanted);
}

// While a verification is on screen the window comes to the front and the wait goes on; only the person passes it.
async function waitThroughVerify(page, done, { ms = 30_000, verifyMs = 10 * 60_000, shouldStop = () => false, onDetail = () => {}, hold = null } = {}) {
  let until = Date.now() + ms, waiting = false;
  for (;;) {
    if (shouldStop()) throw fail("GEO_STOPPED", "已停下。");
    // While a check is on screen nothing counts as finished, and a page that cannot be read does not end the wait.
    const words = hold ? await page.evaluate("document.body ? document.body.innerText : ''").then(String).catch(() => null) : "";
    const held = hold ? (words === null ? waiting : hold.test(words)) : false;
    if (!held) { const result = await done(); if (result) return result; }
    const blocked = held || Boolean(await page.evaluate(VERIFY_PROBE).catch(() => false));
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
    const title = await findSoon(page, (node) => node.localName === "textarea" && /标题/.test(attr(node, "placeholder") || ""), { shouldStop: job.shouldStop });
    if (!title) throw fail("GEO_FORM_CHANGED", "没有找到知乎的标题输入框，平台页面可能改版了。");
    await page.type(title, job.title);
    const editor = await findSoon(page, page.byClass("public-DraftEditor-content"), { tries: 10, shouldStop: job.shouldStop });
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
    // It can also come up while the page is still loading, so it is closed again before each new look.
    const dismiss = () => page.evaluate(`[...document.querySelectorAll("svg.close-btn")].find((el) => el.getClientRects().length)?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`).catch(() => {});
    await dismiss();
    await sleep(1200);
    const title = await findSoon(page, (node) => node.localName === "textarea" && /文章标题/.test(attr(node, "placeholder") || ""), { shouldStop: job.shouldStop, between: dismiss });
    if (!title) throw fail("GEO_FORM_CHANGED", "没有找到头条的标题输入框，平台页面可能改版了。");
    await page.type(title, job.title);
    const editor = await findSoon(page, page.byClass("ProseMirror"), { tries: 15, shouldStop: job.shouldStop, between: dismiss });
    if (!editor) throw fail("GEO_FORM_CHANGED", "没有找到头条的正文输入框，平台页面可能改版了。");
    await typeBody(page, editor, job.body);
    // 展示封面 is required and defaults to a single image; this version publishes text only.
    const noCover = await page.find((node) => node.localName === "label" && attr(node, "class")?.includes("byte-radio") && /无封面/.test(textOf(node)));
    if (!noCover) throw fail("GEO_FORM_CHANGED", "没有找到头条的「无封面」选项，平台页面可能改版了。");
    await page.click(noCover);
    await sleep(600);
    // User decision 2026-11-02: 发布得更多收益 stays off. It is ticked by default, and an article published with it
    // carried a 首发 mark although it was also on Zhihu. Refusing here beats publishing a claim that is not true.
    const income = () => page.find((node) => node.localName === "label" && /发布得更多收益/.test(textOf(node)));
    const isOn = (node) => String(attr(node, "class") || "").includes("byte-checkbox-checked");
    let option = await income();
    for (let tries = 0; !option && tries < 3; tries++) { await sleep(1000); option = await income(); }
    if (!option) throw fail("GEO_FORM_CHANGED", "没有找到头条的「发布得更多收益」选项，确认不了它是否关闭，这篇没有发布。");
    if (isOn(option)) { await page.click(option); await sleep(400); option = await income(); }
    if (!option || isOn(option)) throw fail("GEO_FORM_CHANGED", "没能取消头条的「发布得更多收益」，这篇没有发布。");
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
  linkOf: (job) => `[...document.querySelectorAll("a[href]")].find((a) => (a.innerText || "").trim() === ${JSON.stringify(job.title)} && /toutiao\\.com\\/(item|article)\\//.test(a.href))?.href.split("?")[0] || ""`,
  // After 预览并发布 the editor does not always move on to the list (2026-11-09: published, never confirmed).
  // The list is then opened in a tab of its own, so the editor tab is left as it is.
  listUrl: "https://mp.toutiao.com/profile_v4/graphic/articles"
};

// Sohu and Baijiahao have not published on a real account yet. Their addresses, fields and steps were learned from
// another product's publisher, used with the user's word that the two companies have an agreement (2026-11-02); this
// is our own code. They refuse to click unless the page reads back the confirmed text, and only ever report
// "submitted, please check": the user settles the result on the platform until a real article has gone through.
const titleField = (page, name, shouldStop) => findSoon(page, (node) => (["input", "textarea"].includes(node.localName) || attr(node, "contenteditable") === "true") && /标题/.test(attr(node, "placeholder") || ""), { tries: 10, shouldStop })
  .then((node) => { if (!node) throw fail("GEO_FORM_CHANGED", `没有找到${name}的标题输入框，平台页面可能和预想的不同。`); return node; });
const pressByWords = async (page, words) => {
  const node = await page.find((item) => ["button", "a", "span", "div", "label"].includes(item.localName) && words.includes(textOf(item).trim()));
  if (node) { await page.click(node); await sleep(800); }
  return Boolean(node);
};
const submitted = (name) => ({ status: "unknown", reason: `页面显示已提交。${name}还没有真实验证过，请到平台上看一下是否发出，再告诉软件结果。` });
const listedOrSaid = (pattern, name) => (url, text, job) => {
  if (!pattern.test(url)) return null;
  const said = /提交成功|发布成功|正在审核中/.test(text);
  return said || String(text).split(/\n/).some((line) => line.trim() === job.title) ? submitted(name) : null;
};
const BUTTON = (label) => `[...document.querySelectorAll("button,[role=button]")].find((el) => (el.innerText || "").trim() === ${JSON.stringify(label)} && el.getClientRects().length)`;

const SOHU = {
  id: "sohu", name: "搜狐号", titleLimit: 72,
  // ppinf is only the Sohu passport: acting on it interrupted the sign-in and the site still said 登录 (2026-11-02).
  // The site's own token comes after it.
  home: "https://mp.sohu.com/", hosts: ["sohu.com"], loginCookies: ["umab_access_token"],
  editorUrl: "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle",
  loginRequired: (url) => /passport\.sohu|\/login/.test(url),
  holdText: /为了账号安全，需要短信验证/,
  // The first of these was seen on a real account (2026-11-02): without real-name verification the editor address goes back.
  blocked(url, text) {
    if (/账号已被平台禁言/.test(text)) return "这个搜狐号已被平台禁言，暂时不能发文章。";
    if (/今日发布额度已用完/.test(text)) return "这个搜狐号今天的发布额度用完了，明天再发。";
    if (/仅支持发布动态/.test(text)) return "这个搜狐号目前只能发动态，不能发文章。";
    // Seen on a real account 2026-11-09: the editor address showed 未通过审核 and the form never came.
    if (/未通过审核|审核未通过/.test(text)) return "这个搜狐号没有通过平台审核，暂时不能发文章。请到搜狐号后台按提示重新提交审核，通过后再发。";
    return /实名认证可解锁|实名认证后可解锁|您的账号未实名/.test(text) && !/addarticle/.test(url) ? "这个搜狐号还没有实名认证，平台不允许发文章。请先到搜狐号后台完成实名认证。" : "";
  },
  async fill(page, job) {
    let title = await findSoon(page, (node) => node.localName === "input" && /标题/.test(attr(node, "placeholder") || ""), { tries: 12, shouldStop: job.shouldStop });
    // The editor can also be reached from the site's own 发布内容 entry.
    if (!title && await pressByWords(page, ["发布内容"])) await sleep(4000);
    const refusal = this.blocked(String(await page.url()), await shownText(page));
    if (refusal) throw fail("GEO_ACCOUNT_NOT_READY", refusal);
    title = title || await titleField(page, this.name, job.shouldStop);
    await page.type(title, job.title);
    const editor = await findSoon(page, (node) => attr(node, "contenteditable") === "true" && String(attr(node, "class") || "").includes("ql-editor"), { tries: 10, shouldStop: job.shouldStop });
    if (!editor) throw fail("GEO_FORM_CHANGED", "没有找到搜狐号的正文输入框，平台页面可能和预想的不同。");
    await typeBody(page, editor, job.body);
    // The required creation statement says what the article is.
    const statement = job.aiWritten ? "含有AI生成内容" : "无需声明";
    if (!await pressByWords(page, [statement])) throw fail("GEO_FORM_CHANGED", `没有找到搜狐号的「${statement}」声明，这篇没有发布。`);
    const chosen = await page.evaluate(`[...document.querySelectorAll("section#info-source-signature label, label[role=radio]")].some((el) => (el.innerText || "").trim() === ${JSON.stringify(statement)} && (el.getAttribute("aria-checked") === "true" || el.querySelector("input:checked") || /checked/i.test(el.className)))`);
    if (!chosen) throw fail("GEO_FORM_CHANGED", `没能选中搜狐号的「${statement}」，这篇没有发布。`);
    return { read: async () => ({ title: await page.valueOf(title), body: await page.valueOf(editor) }) };
  },
  publishButton: `document.querySelector("li.publish-report-btn.active:not(.disable-button)")`,
  confirmButton: BUTTON("确认发布"),
  published: listedOrSaid(/mp\.sohu\.com\/mpfe\/v4\/contentManagement\/(?!news\/addarticle)/, "搜狐号")
};

const BAIJIAHAO = {
  id: "baijiahao", name: "百家号", titleLimit: 64, needsCover: true,
  home: "https://baijiahao.baidu.com/", hosts: ["baidu.com"], loginCookies: ["BDUSS", "BDUSS_BFESS"],
  // The edit address sends a signed-in account back to the home page; the site's own 发布作品 entry opens the editor (2026-11-02).
  editorUrl: "https://baijiahao.baidu.com/",
  async enter(page) {
    if (/\/builder\/rc\/edit/.test(String(await page.url()))) return;
    const entry = await pointOf(page, `document.querySelector("#home-publish-btn")`);
    if (!entry) throw fail("GEO_FORM_CHANGED", "没有找到百家号的「发布作品」入口，平台页面可能和预想的不同。");
    await page.mouse(entry);
    await sleep(8000);
    if (!/\/builder\/rc\/edit/.test(String(await page.url()))) throw fail("GEO_FORM_CHANGED", "点了「发布作品」没有进入写文章页面。");
  },
  loginRequired: (url) => /passport\.baidu|\/login/.test(url),
  holdText: /百度安全验证|请完成下方验证/,
  blocked: (_url, text) => /注册百家号|申请入驻/.test(text) ? "这个账号还没有开通百家号，请先到百家号后台完成注册和认证。" : "",
  async fill(page, job) {
    const findTitle = () => page.find((node) => node.localName === "div" && attr(node, "contenteditable") === "true" && /-editor\b/.test(String(attr(node, "class") || "")));
    let title = await findTitle();
    for (let tries = 0; !title && tries < 15; tries++) { await sleep(1000); title = await findTitle(); }
    if (!title) throw fail("GEO_FORM_CHANGED", "没有找到百家号的标题输入框，平台页面可能和预想的不同。");
    await page.type(title, job.title);
    // The article body is the body of an iframe.
    const editor = await findSoon(page, (node) => node.localName === "body" && attr(node, "contenteditable") === "true", { tries: 10, shouldStop: job.shouldStop });
    if (!editor) throw fail("GEO_FORM_CHANGED", "没有找到百家号的正文输入框，平台页面可能和预想的不同。");
    await typeBody(page, editor, job.body);
    await this.setCover(page, job.coverFile);
    // AI-written articles say so, on the page's own 创作声明.
    if (job.aiWritten) {
      const label = await page.find((node) => node.localName === "label" && /采用AI生成内容/.test(textOf(node)));
      if (!label) throw fail("GEO_FORM_CHANGED", "没有找到百家号的「采用AI生成内容」声明，这篇没有发布。");
      if (!String(attr(label, "class") || "").includes("checkbox-wrapper-checked")) await page.click(label);
      await sleep(500);
      const on = await page.find((node) => node.localName === "label" && /采用AI生成内容/.test(textOf(node)) && String(attr(node, "class") || "").includes("checkbox-wrapper-checked"));
      if (!on) throw fail("GEO_FORM_CHANGED", "没能勾选百家号的「采用AI生成内容」，这篇没有发布。");
    }
    return { read: async () => ({ title: await page.valueOf(title), body: await page.valueOf(editor) }) };
  },
  // A cover is required. A missing step stops here, before the publish button is touched.
  async setCover(page, file) {
    // A scripted click does not open the dialog; a real one on 选择封面 does (2026-11-02). 点击本地上传 is left alone:
    // it would open a Windows file dialog, and the dialog's own input takes the file directly.
    let opened = await pointOf(page, `[...document.querySelectorAll("#bjhNewsCover *")].filter((el) => (el.innerText || "").trim() === "选择封面" && el.getClientRects().length).at(-1)`);
    if (opened) await page.mouse(opened);
    else {
      // A restored draft already has a cover, possibly another article's: its 更换 button shows on hovering over it.
      const held = await pointOf(page, `document.querySelector("#bjhNewsCover img")`);
      if (held) { await page.mouse(held, false); await sleep(800); }
      const change = await pointOf(page, `[...document.querySelectorAll("#bjhNewsCover button")].find((el) => (el.innerText || "").trim() === "更换" && el.getClientRects().length)`);
      if (change) await page.mouse(change);
      opened = change;
    }
    if (!opened) throw fail("GEO_FORM_CHANGED", "没有找到百家号的封面入口，平台页面可能和预想的不同。");
    await sleep(1500);
    const view = await page.tree();
    const input = view.nodes.find((node) => node.localName === "input" && attr(node, "type") === "file" && view.ancestors(node).some((item) => String(attr(item, "class") || "").includes("cheetah-modal")));
    if (!input) throw fail("GEO_FORM_CHANGED", "没有找到百家号的封面上传入口，平台页面可能和预想的不同。");
    await page.setFile(input, file);
    let pressed = false;
    for (let tries = 0; !pressed && tries < 20; tries++) {
      await sleep(1000);
      pressed = await page.evaluate(`(() => { const el = [...document.querySelectorAll(".cheetah-modal button")].find((item) => /^确定/.test((item.innerText || "").trim()) && item.getClientRects().length && !item.disabled); if (!el) return false; el.click(); return true; })()`);
    }
    let shown = false;
    for (let tries = 0; pressed && !shown && tries < 10; tries++) {
      await sleep(800);
      shown = await page.evaluate(`(() => { const box = document.querySelector("#bjhNewsCover"); return Boolean(box) && !document.querySelector(".cheetah-modal .cheetah-upload-select")?.getClientRects().length && (Boolean(box.querySelector("img")) || /更换封面/.test(box.innerText || "")); })()`);
    }
    if (!shown) throw fail("GEO_FORM_CHANGED", "百家号的封面没有传成功，这篇没有发布。");
  },
  publishButton: `document.querySelector('[data-testid="publish-btn"]')`,
  confirmButton: BUTTON("确认发布"),
  published: listedOrSaid(/baijiahao\.baidu\.com\/builder\/rc\/(?!edit)/, "百家号")
};

const DRIVERS = { zhihu: ZHIHU, toutiao: TOUTIAO, sohu: SOHU, baijiahao: BAIJIAHAO };

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
  // Baijiahao: confirmed by a real article on 2026-11-02. Sohu: open without the trial mark at the user's request
  // (2026-11-02) while its account's real-name check was pending; its results are still left for the user to settle.
  { id: "baijiahao", name: "百家号", available: true, titleLimit: BAIJIAHAO.titleLimit },
  { id: "sohu", name: "搜狐号", available: true, titleLimit: SOHU.titleLimit },
  // Confirmed by a real article on 2026-11-02.
  { id: "zhihu", name: "知乎", available: true, titleLimit: ZHIHU.titleLimit }
];
const GEO_ACCOUNT_PLATFORMS = {
  zhihu: { name: "知乎", home: ZHIHU.home, hosts: ZHIHU.hosts, loginCookies: ZHIHU.loginCookies },
  toutiao: { name: "今日头条", home: TOUTIAO.home, hosts: TOUTIAO.hosts, loginCookies: TOUTIAO.loginCookies },
  sohu: { name: SOHU.name, home: SOHU.home, hosts: SOHU.hosts, loginCookies: SOHU.loginCookies },
  baijiahao: { name: BAIJIAHAO.name, home: BAIJIAHAO.home, hosts: BAIJIAHAO.hosts, loginCookies: BAIJIAHAO.loginCookies },
  doubao: { name: DOUBAO.name, home: DOUBAO.url, hosts: DOUBAO.hosts, loginCookies: DOUBAO.loginCookies }
};

const coverHtml = (title) => `<!doctype html><meta charset="utf-8"><body style="margin:0;width:800px;height:600px;display:flex;align-items:center;padding:0 70px;box-sizing:border-box;background:linear-gradient(135deg,#fff5f6,#ffe3e6);font-family:'Microsoft YaHei',sans-serif"><h1 style="margin:0;font-size:50px;line-height:1.4;color:#1f2937">${String(title).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)}</h1></body>`;
async function makeCover(page, title) {
  await page.navigate(`data:text/html;charset=utf-8,${encodeURIComponent(coverHtml(title))}`);
  await sleep(800);
  const { data } = await page.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 800, height: 600, scale: 1 } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "geo-cover-")), file = path.join(dir, "cover.png");
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  return { file, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

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
    return withPage(profileDir, async (page, browser) => {
      const job = { title, body, aiWritten, shouldStop };
      const cover = driver.needsCover ? await makeCover(page, title) : null;
      job.coverFile = cover?.file;
      let step = "open";
      try {
      onDetail(`打开${driver.name}的写文章页面`);
      await page.navigate(driver.editorUrl);
      await sleep(8000);
      // A check only the person can pass (a text message, say) may stand before the editor.
      if (driver.holdText) await waitThroughVerify(page, async () => Boolean(await shownText(page)), { ms: 3000, shouldStop, onDetail, hold: driver.holdText });
      if (driver.loginRequired(String(await page.url()))) throw fail("GEO_LOGIN_REQUIRED", `${driver.name}需要重新扫码登录。`);
      const refusal = driver.blocked?.(String(await page.url()), await shownText(page));
      if (refusal) throw fail("GEO_ACCOUNT_NOT_READY", refusal);
      await driver.enter?.(page);
      step = "fill";
      onDetail("填写标题和正文");
      const form = await driver.fill(page, job);
      if (!sameArticle(await form.read(), job)) throw fail("GEO_FORM_MISMATCH", `${driver.name}页面上的内容和你确认的不一致，没有发布。`);
      await sleep(2000);
      const point = await pointOf(page, driver.publishButton);
      if (!point) throw fail("GEO_FORM_CHANGED", `没有找到${driver.name}可以点的发布按钮，可能还有必填项没有填。`);
      if (shouldStop()) throw fail("GEO_STOPPED", "已停下，这篇没有发。");
      step = "click";
      job.clickedAtMs = Date.now();
      beforeClick();
      await page.mouse(point);
      onDetail("已点发布，等平台确认");
      if (driver.confirmButton) {
        await sleep(3000);
        const confirm = await waitThroughVerify(page, () => pointOf(page, driver.confirmButton), { ms: 12_000, shouldStop, onDetail, hold: driver.holdText });
        if (confirm) await page.mouse(confirm);
      }
      step = "result";
      const result = await waitThroughVerify(page, async () => driver.published(String(await page.url()), await shownText(page), job), { ms: 40_000, shouldStop, onDetail, hold: driver.holdText });
      if (result) return driver.linkOf ? { ...result, url: String(await page.evaluate(driver.linkOf(job)).catch(() => "") || result.url || "") } : result;
      if (driver.listUrl) {
        step = "verify";
        onDetail(`到${driver.name}的作品列表核对`);
        const listed = await checkList(browser, driver, job, { shouldStop, onDetail });
        if (listed) return listed;
      }
      const hint = (await shownText(page)).match(/[^\n]{0,30}(话题|必填|失败|审核|违规|频繁)[^\n]{0,30}/)?.[0] || "";
      return { status: "unknown", reason: hint ? `已点发布，页面提示：${hint.slice(0, 100)}。请到平台上看一下，不会自动重发。` : "已点发布，但没等到平台确认。请到平台上看一下，不会自动重发。", evidence: await pageEvidence(page, step) };
      } catch (error) {
        if (error?.code === "GEO_STOPPED") throw error;
        // A page that went to the sign-in or an account notice only late reads as a missing field: its own reason is said instead.
        if (error?.code === "GEO_FORM_CHANGED" && !job.clickedAtMs) {
          const where = String(await page.url().catch(() => "")), words = await shownText(page);
          if (driver.loginRequired(where, words)) throw Object.assign(fail("GEO_LOGIN_REQUIRED", `${driver.name}需要重新扫码登录。`), { evidence: await pageEvidence(page, step) });
          const refusal = driver.blocked?.(where, words);
          if (refusal) throw Object.assign(fail("GEO_ACCOUNT_NOT_READY", refusal), { evidence: await pageEvidence(page, step) });
        }
        error.evidence = await pageEvidence(page, step);
        // What the platform itself says on the page is the likeliest reason, so the person reads it too.
        if (error.code === "GEO_FORM_CHANGED" && error.evidence.notices.length) error.message = `${error.message} 页面上写着：「${error.evidence.notices[0]}」。`;
        throw error;
      } finally { cover?.remove(); }
    });
  }
  // The platform's own article list, in a new tab of the same window, read for this article and its link.
  async function checkList(browser, driver, job, { shouldStop, onDetail }) {
    try {
      const { targetId } = await browser.send("Target.createTarget", { url: driver.listUrl });
      const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
      await browser.send("DOM.enable", {}, sessionId);
      const list = makePage(browser, sessionId);
      const look = async () => driver.published(String(await list.url()), await shownText(list), job);
      await sleep(5000);
      let result = await waitThroughVerify(list, look, { ms: 15_000, shouldStop, onDetail });
      // A list read straight after publishing can still miss the newest article.
      if (!result) { await list.reload(); await sleep(5000); result = await waitThroughVerify(list, look, { ms: 15_000, shouldStop, onDetail }); }
      if (!result) return null;
      return driver.linkOf ? { ...result, url: String(await list.evaluate(driver.linkOf(job)).catch(() => "") || result.url || "") } : result;
    } catch (error) {
      if (error?.code === "GEO_STOPPED") throw error;
      return null;
    }
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

module.exports = { makeCover, coverHtml, createGeoBrowserAdapter, GEO_CHANNELS, GEO_ACCOUNT_PLATFORMS, DRIVERS, DOUBAO, sameArticle, paragraphs, waitThroughVerify, findSoon, noticesOf, VERIFY };
