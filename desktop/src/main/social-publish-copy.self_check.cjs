const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCoverCache, copyPrompt, parseCopy, writeCopy } = require("./social-publish-copy.cjs");

(async () => {
  // AI 文案：标题截到 20 字（小红书上限），话题去掉 # 号、去重、最多 5 个。
  const copy = parseCopy(JSON.stringify({ title: "一二三四五六七八九十一二三四五六七八九十多出来", description: "正文\n第二行", topics: ["#清洁设备", "保洁", "保洁", "洗地机", "物业", "商场", "多余"] }));
  assert.equal(copy.title.length, 20);
  assert.equal(copy.description, "正文 第二行");
  assert.deepEqual(copy.topics, ["清洁设备", "保洁", "洗地机", "物业", "商场"]);
  assert.throws(() => parseCopy("not json"), { code: "SOCIAL_COPY_INVALID" });
  assert.throws(() => parseCopy(JSON.stringify({ title: "" })), { code: "SOCIAL_COPY_INVALID" });
  // 视频信息和用户说明只作资料放进提示词。
  const prompt = copyPrompt({ videos: [{ title: "洗地机演示", context: "批量口播" }], hint: "面向物业" });
  assert.match(prompt, /洗地机演示（批量口播）/); assert.match(prompt, /面向物业/); assert.match(prompt, /不超过 20 个字/);
  const calls = [];
  const client = { businessContent: async (input) => { calls.push(input); return { content: JSON.stringify({ title: "物业保洁省人工", description: "说明", topics: ["保洁"] }) }; } };
  assert.deepEqual(await writeCopy({ client, videos: [{ title: "a" }], hint: "" }), { title: "物业保洁省人工", description: "说明", topics: ["保洁"] });
  assert.equal(calls[0].maxTokens, 800);
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
