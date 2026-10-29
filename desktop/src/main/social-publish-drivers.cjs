// Per-platform steps for publishing one video on the platform's own creator
// site. Each step was confirmed on real accounts (2026-10-26); the selectors
// are the platform's own and may change, so every step reports what it could
// not find instead of guessing.
const { attr, ownText, textOf, classes, sleep } = require("./social-page.cjs");

const fail = (code, message) => Object.assign(new Error(message), { code });
const isVideoInput = (node) => node.localName === "input" && attr(node, "type") === "file" && /video|mp4/.test(attr(node, "accept") || "");
const VERIFY = /验证码|身份验证|安全验证|本人操作|拖动滑块|完成验证|扫码验证/;
// Visible light-DOM text without standing hints such as 「如作品还在上传中，请勿关闭页面」.
const shownText = async (page) => String(await page.evaluate("document.body ? document.body.innerText : ''") || "").replace(/如作品还在上传中[^。]*。?/g, "");
const lightUploaded = async (page) => { const text = await shownText(page); return /重新上传/.test(text) && !/上传中/.test(text); };
// Form text compared without whitespace and the zero-width spaces editors insert.
// Topics may be turned into tags by the editor, so # marks are ignored as well.
const squash = (value) => String(value ?? "").replace(/[\s​﻿#]+/g, "");
const sameTitle = (value, job) => squash(value) === squash(job.title);
const titleThenText = (value, job) => squash(value).startsWith(squash(job.title)) && squash(value).includes(squash(job.description));
// `loginRequired` is only the platform's own login page, which means the account is signed out.
// `onForm` is the publish form itself; any other page (a dashboard, a half-loaded page) is not a login verdict.

// Sources of the images shown now; a cover that took effect adds a new one.
async function visibleImages(page) {
  const view = await page.tree(), sources = [];
  for (const node of view.nodes) if (node.localName === "img" && attr(node, "src") && await page.visible(node)) sources.push(attr(node, "src"));
  return sources;
}
const COVER_DIALOG = (node) => node.localName === "h3" && /^(裁剪封面图|编辑封面)$/.test(ownText(node));

async function fileInput(page) {
  const view = await page.tree();
  return view.nodes.find((node) => node.nodeType === 1 && isVideoInput(node)) || null;
}
async function setPrivateLabel(page, text) {
  const option = await page.find(page.byText(text));
  if (!option) throw fail("SOCIAL_FORM_CHANGED", `没有找到「${text}」选项，平台页面可能改版了。`);
  await page.click(option);
  await sleep(500);
}

const DRIVERS = {
  douyin: {
    name: "抖音", host: "douyin.com",
    uploadUrl: "https://creator.douyin.com/creator-micro/content/upload",
    manageUrl: "https://creator.douyin.com/creator-micro/content/manage",
    titleLimit: 30, privateLabel: "仅自己可见", supportsPrivate: true,
    loginRequired: (url) => /login|passport/.test(url),
    onForm: (url) => /creator\.douyin\.com\/creator-micro/.test(url),
    uploaded: lightUploaded,
    async fill(page, job) {
      const title = await page.find((node) => node.localName === "input" && /作品标题/.test(attr(node, "placeholder") || ""));
      if (!title) throw fail("SOCIAL_FORM_CHANGED", "没有找到抖音的作品标题输入框。");
      await page.type(title, job.title);
      if (job.description) {
        const editor = await page.find((node) => attr(node, "contenteditable") === "true" && classes(node).includes("zone-container"));
        if (!editor) throw fail("SOCIAL_FORM_CHANGED", "没有找到抖音的作品简介输入框。");
        await page.type(editor, job.description);
      }
      if (job.visibility === "private") await setPrivateLabel(page, "仅自己可见");
      return { read: () => page.valueOf(title) };
    },
    formMatches: sameTitle,
    privateChecked: async (page) => Boolean(await page.evaluate("[...document.querySelectorAll('label')].some((label) => label.innerText.trim() === '仅自己可见' && label.querySelector('input')?.checked)")),
    publish: async (page) => page.click(await page.find((node) => node.localName === "button" && ownText(node) === "发布")),
    published: (url) => /content\/manage/.test(url)
  },
  kuaishou: {
    name: "快手", host: "kuaishou.com",
    uploadUrl: "https://cp.kuaishou.com/article/publish/video",
    manageUrl: "https://cp.kuaishou.com/article/manage/video",
    titleLimit: 0, privateLabel: "仅自己可见", supportsPrivate: true,
    loginRequired: (url) => /passport|\/login/.test(url),
    onForm: (url) => /cp\.kuaishou\.com\/article\/publish/.test(url),
    // Logged out, the publish address does not redirect; the page offers 立即登录 instead (checked 2026-10-29).
    loginShown: async (page) => /立即登录/.test(await shownText(page)) && !await page.find((node) => attr(node, "id") === "work-description-edit"),
    uploaded: lightUploaded,
    async fill(page, job) {
      const editor = await page.find((node) => attr(node, "id") === "work-description-edit");
      if (!editor) throw fail("SOCIAL_FORM_CHANGED", "没有找到快手的作品描述输入框。");
      await page.type(editor, [job.title, job.description].filter(Boolean).join(" "));
      if (job.visibility === "private") await setPrivateLabel(page, "仅自己可见");
      return { read: () => page.valueOf(editor) };
    },
    formMatches: titleThenText,
    privateChecked: async (page) => Boolean(await page.evaluate("[...document.querySelectorAll('label.ant-radio-wrapper-checked')].some((label) => label.innerText.trim() === '仅自己可见')")),
    // The label sits in a child element of the primary button.
    publish: async (page) => page.click(await page.find((node) => classes(node).some((name) => /button-primary/.test(name)) && textOf(node).trim() === "发布")),
    published: (url) => /article\/manage/.test(url)
  },
  xiaohongshu: {
    name: "小红书", host: "xiaohongshu.com",
    uploadUrl: "https://creator.xiaohongshu.com/publish/publish?source=official",
    manageUrl: "https://creator.xiaohongshu.com/new/note-manager",
    titleLimit: 20, privateLabel: "仅自己可见", supportsPrivate: true,
    loginRequired: (url) => /login/.test(url),
    onForm: (url) => /creator\.xiaohongshu\.com\/publish/.test(url),
    uploaded: lightUploaded,
    async fill(page, job) {
      const title = await page.find((node) => node.localName === "input" && /标题/.test(attr(node, "placeholder") || ""));
      if (!title) throw fail("SOCIAL_FORM_CHANGED", "没有找到小红书的标题输入框。");
      await page.type(title, job.title);
      if (job.description) {
        const editor = await page.find((node) => classes(node).includes("ProseMirror"));
        if (!editor) throw fail("SOCIAL_FORM_CHANGED", "没有找到小红书的正文输入框。");
        await page.type(editor, job.description);
      }
      if (job.visibility === "private") {
        const select = await page.find((node, view) => classes(node).includes("d-select") && view.ancestors(node).some((up) => classes(up).includes("permission-card-select")));
        if (!select) throw fail("SOCIAL_FORM_CHANGED", "没有找到小红书的可见范围设置。");
        await page.click(select); await sleep(800);
        const option = await page.find((node) => classes(node).includes("custom-option") && textOf(node).trim() === "仅自己可见");
        if (!option) throw fail("SOCIAL_FORM_CHANGED", "没有找到小红书的「仅自己可见」选项。");
        await page.click(option); await sleep(600);
      }
      return { read: () => page.valueOf(title) };
    },
    formMatches: sameTitle,
    privateChecked: async (page) => (await page.evaluate("(document.querySelector('.permission-card-select .d-select-description') || {}).innerText || ''") || "").trim() === "仅自己可见",
    // The button lives in a closed web component and only renders a while after upload.
    // While the cover or video is still processing the component is disabled and swallows clicks,
    // so it is pressed only when the host says it is ready; otherwise "not clicked" and the caller waits.
    async publish(page) {
      const host = await page.find((node) => node.localName === "xhs-publish-btn");
      if (!host || attr(host, "submit-disabled") !== "false" || attr(host, "submit-loading") !== "false") return false;
      return page.click(await page.find((node) => ownText(node) === "发布" && node.localName === "button"));
    },
    published: (url) => /publish\/success/.test(url)
  },
  channels: {
    name: "视频号", host: "channels.weixin.qq.com",
    uploadUrl: "https://channels.weixin.qq.com/platform/post/create",
    manageUrl: "https://channels.weixin.qq.com/platform/post/list",
    titleLimit: 0, privateLabel: "", supportsPrivate: false,
    // Signed out, every page goes to /login.html. Signed in, a headless window may land on
    // /platform instead of the form (checked 2026-10-29), which is not a login verdict.
    loginRequired: (url) => /login/.test(url),
    onForm: (url) => /platform\/post\/create/.test(url),
    uploaded: async (page) => Boolean(await page.find(page.byText("删除"))) && !/上传中/.test(await shownText(page)),
    async fill(page, job) {
      const blocked = await page.find(page.byText("你还不能发表视频"));
      if (blocked) throw fail("SOCIAL_NOT_OPERATOR", "当前登录的微信不是这个视频号的管理员或运营者，请让管理员添加权限后再发。");
      const editor = await page.find((node) => classes(node).includes("input-editor") && attr(node, "contenteditable") !== undefined);
      if (!editor) throw fail("SOCIAL_FORM_CHANGED", "没有找到视频号的视频描述输入框。");
      await page.type(editor, [job.title, job.description].filter(Boolean).join(" "));
      return { read: () => page.valueOf(editor) };
    },
    // The cover editor (编辑封面: 从视频中选择封面 / 上传封面, then 裁剪封面图 and 确定) sits next to
    // the 3:4 preview, which is generated from the video first. Seen on the page 2026-10-29.
    async setCover(page, file) {
      for (let i = 0; i < 40 && /封面预览生成中/.test(await shownText(page)); i++) await sleep(1500);
      const before = await visibleImages(page);
      if (!await page.find(page.byText("上传封面"))) {
        const opener = await page.find((node) => ownText(node) === "编辑封面" && node.localName !== "h3")
          || await page.find(page.byText("个人主页和分享卡片(3:4)"));
        if (opener) { await page.click(opener); await sleep(1200); }
      }
      const uploadTab = await page.find(page.byText("上传封面"));
      if (uploadTab) { await page.click(uploadTab); await sleep(800); }
      const view = await page.tree();
      const input = view.nodes.find((node) => node.nodeType === 1 && node.localName === "input" && attr(node, "type") === "file" && /image\/(jpe?g|png)/.test(attr(node, "accept") || ""));
      if (!input) throw fail("SOCIAL_COVER_FAILED", "没有找到视频号的封面上传入口，没有发布，可以重新发起。");
      await page.setFile(input, file);
      // Crop first; the editor itself may then ask for a confirmation too.
      for (let i = 0; i < 20; i++) {
        await sleep(1000);
        if (!await page.find(COVER_DIALOG)) break;
        await page.click(await page.find(page.byText("确定")));
      }
      await sleep(1500);
      if (await page.find(COVER_DIALOG)) throw fail("SOCIAL_COVER_FAILED", "视频号的封面编辑框没有关闭，没有发布，可以重新发起。");
      if (!(await visibleImages(page)).some((src) => !before.includes(src))) throw fail("SOCIAL_COVER_FAILED", "视频号的封面没有换成成片封面，没有发布，可以重新发起。");
    },
    formMatches: titleThenText,
    privateChecked: async () => false,
    async publish(page) {
      if (!await page.click(await page.find(page.byText("发表")))) return false;
      // An originality prompt may ask whether to declare; publishing without a declaration keeps the user's choice unchanged.
      for (let i = 0; i < 6; i++) { await sleep(800); const direct = await page.find(page.byText("直接发表")); if (direct) { await page.click(direct); break; } }
      return true;
    },
    published: (url) => /post\/list/.test(url)
  }
};

function driverFor(platform) {
  const driver = DRIVERS[platform];
  if (!driver) throw fail("SOCIAL_PLATFORM_INVALID", "暂不支持这个平台。");
  return driver;
}
async function findVideoInput(page, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const node = await fileInput(page); if (node) return node; if (Date.now() > deadline) return null; await sleep(800); }
}
// The platform itself says the account is signed out: its login page, or a login prompt in place of the form.
async function signedOut(page, driver) {
  return driver.loginRequired(String(await page.url())) || Boolean(await driver.loginShown?.(page));
}
async function verificationShown(page) {
  return Boolean(await page.find((node) => VERIFY.test(ownText(node)) && ownText(node).length < 60));
}
// The post is confirmed only when its own text shows up on the work management page;
// the page is scanned only once the browser is really there, never on the upload form.
async function listed(page, driver, marker) {
  await page.navigate(driver.manageUrl);
  const target = new URL(driver.manageUrl);
  for (let i = 0; i < 12; i++) {
    await sleep(1500);
    let here; try { here = new URL(await page.url()); } catch { continue; }
    if (here.hostname !== target.hostname || !here.pathname.startsWith(target.pathname)) continue;
    if ((await page.text()).includes(marker)) return true;
  }
  return false;
}

module.exports = { DRIVERS, driverFor, findVideoInput, signedOut, verificationShown, listed, VERIFY };
