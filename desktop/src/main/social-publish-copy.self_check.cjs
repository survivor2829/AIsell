const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCoverCache, copyPrompt, parseCopy, writeCopy } = require("./social-publish-copy.cjs");

(async () => {
  // 每个平台一套文案：标题按各平台上限截断（小红书 20、抖音 30），话题去 #、去重、最多 5 个。
  const long = "一二三四五六七八九十".repeat(4);
  const copy = parseCopy(JSON.stringify({ platforms: {
    douyin: { title: long, description: "抖音正文\n第二行", topics: ["#清洁设备", "保洁", "保洁", "洗地机", "物业", "商场", "多余"] },
    xiaohongshu: { title: long, description: "小红书正文", topics: ["种草"] },
    weibo: { title: "不支持的平台", description: "", topics: [] }
  } }), ["douyin", "xiaohongshu", "kuaishou"]);
  assert.equal(copy.douyin.title.length, 30);
  assert.equal(copy.xiaohongshu.title.length, 20);
  assert.equal(copy.douyin.description, "抖音正文 第二行");
  assert.deepEqual(copy.douyin.topics, ["清洁设备", "保洁", "洗地机", "物业", "商场"]);
  assert.equal(copy.kuaishou, undefined, "AI 没写的平台不编造");
  assert.equal(copy.weibo, undefined, "没要求的平台忽略");
  assert.throws(() => parseCopy("not json"), { code: "SOCIAL_COPY_INVALID" });
  assert.throws(() => parseCopy(JSON.stringify({ platforms: { douyin: { title: "" } } }), ["douyin"]), { code: "SOCIAL_COPY_INVALID" });
  // 提示词只写选中的平台，带各自风格和字数上限；视频信息和用户说明只作资料。
  const prompt = copyPrompt({ videos: [{ title: "洗地机演示", context: "批量口播" }], hint: "面向物业", platforms: ["xiaohongshu", "channels"] });
  assert.match(prompt, /洗地机演示（批量口播）/); assert.match(prompt, /面向物业/);
  assert.match(prompt, /小红书.*种草/); assert.match(prompt, /xiaohongshu.*不超过 20 个字/); assert.match(prompt, /channels/);
  assert.doesNotMatch(prompt, /douyin/);
  const calls = [];
  const client = { businessContent: async (input) => { calls.push(input); return { content: JSON.stringify({ platforms: { kuaishou: { title: "老铁看这个", description: "说明", topics: ["保洁"] } } }) }; } };
  assert.deepEqual(await writeCopy({ client, videos: [{ title: "a" }], hint: "", platforms: ["kuaishou"] }), { kuaishou: { title: "老铁看这个", description: "说明", topics: ["保洁"] } });
  assert.equal(calls[0].maxTokens, 1600);
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
