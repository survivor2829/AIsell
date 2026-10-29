const assert = require("node:assert/strict");
const { DRIVERS, signedOut } = require("./social-publish-drivers.cjs");

// 表单核对：忽略空白、零宽字符和话题的 # 号；但多一个字、少一个字都算不一致。
const job = { title: "物业保洁省人工", description: "洗地机一台顶三人 #清洁设备 #保洁" };
for (const key of ["douyin", "xiaohongshu"]) {
  assert.equal(DRIVERS[key].formMatches(" 物业保洁省人工​", job), true, `${key} 标题一致`);
  assert.equal(DRIVERS[key].formMatches("物业保洁省人工s", job), false, `${key} 多打了字不算一致`);
  assert.equal(DRIVERS[key].formMatches("物业保洁省", job), false, `${key} 少字不算一致`);
}
for (const key of ["kuaishou", "channels"]) {
  assert.equal(DRIVERS[key].formMatches("物业保洁省人工 洗地机一台顶三人 清洁设备 保洁", job), true, `${key} 话题变成标签后仍一致`);
  assert.equal(DRIVERS[key].formMatches("旧草稿 物业保洁省人工 洗地机一台顶三人 #清洁设备 #保洁", job), false, `${key} 残留旧内容不算一致`);
  assert.equal(DRIVERS[key].formMatches("物业保洁省人工", job), false, `${key} 缺正文不算一致`);
}
// 视频号发表时不能设仅自己可见。
assert.equal(DRIVERS.channels.supportsPrivate, false);
assert.equal(DRIVERS.douyin.titleLimit, 30); assert.equal(DRIVERS.xiaohongshu.titleLimit, 20);
// 快手未登录时发布页地址不跳转，只显示「立即登录」（2026-10-29 用空白浏览器实测）。
(async () => {
  const kuaishouPage = (text, form) => ({ evaluate: async () => text, find: async (match) => form && match({ nodeType: 1, attributes: ["id", "work-description-edit"], children: [] }) ? {} : null });
  assert.equal(DRIVERS.kuaishou.loginRequired("https://cp.kuaishou.com/article/publish/video"), false, "单看地址认不出");
  assert.equal(await DRIVERS.kuaishou.loginShown(kuaishouPage("快手创作者服务平台 立即登录", false)), true);
  assert.equal(await DRIVERS.kuaishou.loginShown(kuaishouPage("发布视频 立即登录了解更多", true)), false, "已经出现发布表单就不是登录页");

  // 2026-10-29：视频号已登录时无界面窗口会停在 /platform 首页，这不算退出登录；只有登录页才算。
  assert.equal(DRIVERS.channels.loginRequired("https://channels.weixin.qq.com/platform"), false);
  assert.equal(DRIVERS.channels.onForm("https://channels.weixin.qq.com/platform"), false);
  assert.equal(DRIVERS.channels.loginRequired("https://channels.weixin.qq.com/login.html"), true);
  assert.equal(DRIVERS.channels.onForm("https://channels.weixin.qq.com/platform/post/create"), true);
  for (const key of Object.keys(DRIVERS)) assert.equal(typeof DRIVERS[key].onForm, "function", `${key} 能认出发布页`);
  assert.equal(await signedOut({ url: async () => "https://channels.weixin.qq.com/login.html" }, DRIVERS.channels), true);
  assert.equal(await signedOut({ url: async () => "https://channels.weixin.qq.com/platform" }, DRIVERS.channels), false);

  // 视频号封面：打开编辑封面 → 上传封面 → 选图 → 裁剪框点确定 → 预览换成新图。
  const coverPage = ({ acceptsFile = true } = {}) => {
    const ui = { editor: false, crop: false, image: "frame.jpg", clicks: [], files: [] };
    const el = (localName, text, attributes, visible) => ({ nodeType: 1, localName, attributes, children: text ? [{ nodeType: 3, nodeValue: text }] : [], visible });
    const nodes = () => [
      el("div", "个人主页和分享卡片(3:4)", [], true), el("h3", "编辑封面", [], ui.editor), el("h3", "裁剪封面图", [], ui.crop),
      el("div", "上传封面", [], ui.editor), el("input", "", ["type", "file", "accept", "image/jpeg,image/jpg,image/png"], false),
      el("span", "确定", [], ui.editor || ui.crop), el("img", "", ["src", ui.image], true)];
    const page = {
      ui, evaluate: async () => "", tree: async () => ({ nodes: nodes() }), visible: async (node) => node.visible,
      byText: (text) => (node) => (node.children || []).filter((child) => child.nodeType === 3).map((child) => child.nodeValue).join("") === text,
      find: async (match) => nodes().find((node) => node.visible && match(node)) || null,
      click: async (node) => {
        if (!node) return false;
        const text = node.children[0]?.nodeValue; ui.clicks.push(text);
        if (text === "个人主页和分享卡片(3:4)") ui.editor = true;
        if (text === "确定" && ui.crop) { ui.crop = false; ui.image = "blob:cover"; } else if (text === "确定") ui.editor = false;
        return true;
      },
      setFile: async (_node, file) => { ui.files.push(file); if (acceptsFile) ui.crop = true; }
    };
    return page;
  };
  const good = coverPage();
  await DRIVERS.channels.setCover(good, "C:/covers/a.jpg");
  assert.deepEqual(good.ui.files, ["C:/covers/a.jpg"]);
  assert.deepEqual(good.ui.clicks, ["个人主页和分享卡片(3:4)", "上传封面", "确定", "确定"], "先确认裁剪，再关掉编辑框");
  assert.equal(good.ui.image, "blob:cover");
  // 平台没接这张图：预览没变，报错不发。
  await assert.rejects(DRIVERS.channels.setCover(coverPage({ acceptsFile: false }), "C:/covers/a.jpg"), { code: "SOCIAL_COVER_FAILED" });
  console.log("social publish drivers self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });
