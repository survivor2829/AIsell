const assert = require("node:assert/strict");
const { nurtureActivity, publishActivity } = require("./sprite-activity.cjs");

// 小玺（用户 2026-10-30）：养号、一键分发在 Chrome 里跑时，小玺说正在做什么。
assert.equal(nurtureActivity({ running: "", plans: [{ id: "p" }] }), null, "没在跑就不显示");
assert.deepEqual(nurtureActivity({ running: "p", plans: [{ id: "p", accountLabel: "抖音号", phase: "watching", today: { counts: { watched: 12, likes: 3, follows: 1, comments: 0 } } }] }),
  { title: "正在养号 · 抖音号", detail: "已看 12 个视频，赞 3 · 关注 1 · 评 0" });
assert.equal(nurtureActivity({ running: "p", plans: [{ id: "p", accountLabel: "抖音号", phase: "opening" }] }).detail, "正在打开 Chrome");
assert.equal(publishActivity({ jobs: [{ id: "a", status: "published", createdAt: "1" }] }), null);
// 新的在前（和发布记录一样）：最早一个还没结束的任务之后，已结束的算完成。
const jobs = [
  { id: "c", status: "queued", platform: "kuaishou", createdAt: "3" },
  { id: "b", status: "running", platform: "douyin", step: "上传视频", title: "洗地机实测", createdAt: "2" },
  { id: "d", status: "published", createdAt: "2" },
  { id: "a", status: "published", createdAt: "1" }
];
assert.deepEqual(publishActivity({ running: "b", jobs }), { title: "正在一键分发 · 抖音", detail: "上传视频 · 洗地机实测", attention: false, done: 1, total: 3 });
const verify = publishActivity({ running: "", jobs: [{ id: "x", status: "needs_user", platform: "douyin", reason: "抖音要求本人验证", createdAt: "5" }] });
assert.equal(verify.attention, true); assert.equal(verify.detail, "抖音要求本人验证");
console.log("sprite activity self-check passed");
