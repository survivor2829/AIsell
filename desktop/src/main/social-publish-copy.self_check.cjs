const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCoverCache, createReferenceStore, copyPrompt, parseCopy, writeCopy } = require("./social-publish-copy.cjs");

(async () => {
  // 每个平台一套文案：标题按各平台上限截断（小红书 20、抖音 30），话题去 #、去重、最多 7 个。
  const long = "一二三四五六七八九十".repeat(4);
  const copy = parseCopy(JSON.stringify({ platforms: {
    douyin: { title: long, description: "抖音正文\n第二行", topics: ["#清洁设备", "保洁", "保洁", "洗地机", "物业", "商场", "车库", "超市", "多余"] },
    xiaohongshu: { title: long, description: "小红书正文", topics: ["种草"] },
    weibo: { title: "不支持的平台", description: "", topics: [] }
  } }), ["douyin", "xiaohongshu", "kuaishou"]);
  assert.equal(copy.douyin.title.length, 30);
  assert.equal(copy.xiaohongshu.title.length, 20);
  assert.equal(copy.douyin.description, "抖音正文 第二行");
  assert.deepEqual(copy.douyin.topics, ["清洁设备", "保洁", "洗地机", "物业", "商场", "车库", "超市"]);
  assert.equal(copy.kuaishou, undefined, "AI 没写的平台不编造");
  assert.equal(copy.weibo, undefined, "没要求的平台忽略");
  assert.throws(() => parseCopy("not json"), { code: "SOCIAL_COPY_INVALID" });
  assert.throws(() => parseCopy(JSON.stringify({ platforms: { douyin: { title: "" } } }), ["douyin"]), { code: "SOCIAL_COPY_INVALID" });
  // 提示词只写选中的平台，带各自风格和字数上限；视频信息和用户说明只作资料。
  const prompt = copyPrompt({ videos: [{ title: "洗地机演示", context: "批量口播" }], hint: "面向物业", platforms: ["xiaohongshu", "channels"] });
  assert.match(prompt, /洗地机演示（批量口播）/); assert.match(prompt, /面向物业/);
  assert.match(prompt, /小红书.*种草/); assert.match(prompt, /xiaohongshu.*不超过 20 个字/); assert.match(prompt, /channels/);
  assert.doesNotMatch(prompt, /douyin/);
  assert.match(prompt, /资料只有标题/, "没有口播时不让 AI 编造功能");
  // 有口播/字幕原文和品牌时一起交给 AI，只许用其中的事实。
  const spoken = copyPrompt({ videos: [{ title: "洗地机", spoken: "一趟洗一大片，扫吸一体不扬尘", brand: "新奔" }], hint: "", platforms: ["douyin"],
    references: [{ text: "用户自己存的参考文案：车库地面三天一洗，人手不够怎么办" }] });
  assert.ok(spoken.includes("口播/字幕原文：一趟洗一大片，扫吸一体不扬尘")); assert.match(spoken, /品牌：新奔/);
  assert.ok(spoken.includes("只用口播/字幕原文")); assert.match(spoken, /3 个不同角度的标题/);
  // more intelligence, less structure（用户 2026-11-24）：给目标、事实边界和客户认可的参考文案，不给写作公式。
  assert.match(spoken, /说的就是我/); assert.match(spoken, /不要照抄内容和事实/);
  assert.ok(spoken.indexOf("用户自己存的参考文案") < spoken.indexOf("评论区扣报名"), "用户存的参考排在内置参考前面");
  assert.doesNotMatch(spoken, /正文 60 到 150 字|titles：3 个写法不同/, "不再套固定结构");
  assert.deepEqual(parseCopy(JSON.stringify({ platforms: { douyin: { titles: ["一站式赋能物业保洁", "车库一趟洗完不用返工"] } } }), ["douyin"]).douyin.titles, ["车库一趟洗完不用返工"]);
  // 参考文案库：最新在前、去重、最多 10 条、太短不存、可删除。
  const refDir = fs.mkdtempSync(path.join(os.tmpdir(), "social-ref-"));
  const store = createReferenceStore({ dir: refDir });
  assert.deepEqual(store.list(), []);
  assert.throws(() => store.add("太短"), { code: "SOCIAL_REFERENCE_SHORT" });
  for (let index = 0; index < 12; index += 1) store.add(`第${index}条参考文案，车库保洁人手不够`);
  store.add("第3条参考文案，车库保洁人手不够");
  assert.equal(store.list().length, 10); assert.equal(store.list()[0].text, "第3条参考文案，车库保洁人手不够");
  assert.equal(store.list().filter((item) => item.text === "第3条参考文案，车库保洁人手不够").length, 1);
  store.remove(store.list()[0].id); assert.equal(store.list().length, 9);
  fs.rmSync(refDir, { recursive: true, force: true });
  assert.deepEqual(parseCopy(JSON.stringify({ platforms: { douyin: { titles: ["一站式赋能物业保洁", "车库一趟洗完不用返工"] } } }), ["douyin"]).douyin.titles, ["车库一趟洗完不用返工"]);
  // 三个标题：截断、去重、去掉绝对化用语；都违规时保留，让用户自己改。
  const options = parseCopy(JSON.stringify({ platforms: { douyin: { titles: ["工厂地面一趟洗干净", "全网最好的洗地机", "工厂地面一趟洗干净", "拖把三小时，它半小时"], description: "d", topics: [] } } }), ["douyin"]);
  assert.deepEqual(options.douyin.titles, ["工厂地面一趟洗干净", "拖把三小时，它半小时"]);
  assert.equal(options.douyin.title, "工厂地面一趟洗干净");
  assert.equal(parseCopy(JSON.stringify({ platforms: { douyin: { titles: ["第一名的选择"] } } }), ["douyin"]).douyin.title, "第一名的选择");
  const calls = [];
  const client = { businessContent: async (input) => { calls.push(input); return { content: JSON.stringify({ platforms: { kuaishou: { title: "老铁看这个", description: "说明", topics: ["保洁"] } } }) }; } };
  assert.deepEqual(await writeCopy({ client, videos: [{ title: "a" }], hint: "", platforms: ["kuaishou"] }), { kuaishou: { title: "老铁看这个", titles: ["老铁看这个"], description: "说明", topics: ["保洁"] } });
  assert.equal(calls[0].maxTokens, 2400);
  await assert.rejects(writeCopy({ client, videos: [], hint: "" }), { code: "SOCIAL_VIDEO_REQUIRED" });
  await assert.rejects(writeCopy({ client: null, videos: [{ title: "a" }] }), { code: "SOCIAL_COPY_UNAVAILABLE" });
  // 服务出错时不把内部信息带给界面。
  await assert.rejects(writeCopy({ client: { businessContent: async () => { throw new Error("socket hang up at C:/x"); } }, videos: [{ title: "a" }] }), (error) => error.code === "SOCIAL_COPY_UNAVAILABLE" && !/C:/.test(error.message));

  // 封面：从视频截一帧并缓存；1 秒处截不到（短视频）就截第一帧。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "social-cover-"));
  const runs = [];
  const run = (_bin, args, _options, done) => { runs.push(args[args.indexOf("-ss") + 1]); const out = args.at(-1); if (args[args.indexOf("-ss") + 1] === "0") fs.writeFileSync(out, "jpg"); setImmediate(() => done(null)); };
  const cache = createCoverCache({ dir, run });
  const url = await cache.cover("finished_a", "video.mp4");
  assert.equal(url, `data:image/jpeg;base64,${Buffer.from("jpg").toString("base64")}`);
  assert.deepEqual(runs, ["1", "0"], "1 秒处没截到就截第一帧");
  await cache.cover("finished_a", "video.mp4");
  assert.equal(runs.length, 2, "已有封面直接用缓存");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("social publish copy self-check passed");
})().catch((error) => { console.error(error); process.exit(1); });
