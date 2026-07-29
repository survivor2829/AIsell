const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "MomentsCampaignPanel.tsx"), "utf8");
const preload = fs.readFileSync(path.join(__dirname, "../main/preload.dev.cjs"), "utf8");

assert.match(source, /每日自动执行/u);
assert.match(source, /每天完成/u);
assert.match(source, /type="time"/u);
assert.match(source, /保存每日计划/u);
assert.match(source, /立即执行今日剩余/u);
assert.match(source, /今日完成：\{daily\.completed_count\}\/\{daily\.target\}/u);
assert.match(source, /错过时间时，下次打开程序会补跑今日剩余额度/u);
assert.match(source, /下方点赞、AI评论和评论偏好同时用于每日计划/u);
assert.match(source, /api\.configureDaily\(/u);
assert.match(source, /api\.runDailyNow\(\)/u);
assert.match(source, /data-xiaoxi-moments-daily-run/u);
assert.match(source, /moments_daily_evaluate_failed: "每日计划调度失败，已记录诊断日志"/u);
assert.match(source, /daily\.blocked_reason &&/u);
assert.match(source, /const dailyFormDirty = useRef\(false\)/u);
assert.match(source, /const dailyFormHydrated = useRef\(false\)/u);
assert.match(source, /if \(disposed \|\| liveStateSeen \|\| dailyFormDirty\.current \|\| !result\?\.state\) return/u);
assert.match(source, /dailyFormDirty\.current = true;\s+setDailyEnabled/u);
assert.match(source, /dailyFormDirty\.current = true;\s+setDailyTarget/u);
assert.match(source, /dailyFormDirty\.current = true;\s+setDailyStartTime/u);
assert.match(source, /dailyFormDirty\.current = true;\s+setLikeEnabled/u);
assert.match(source, /dailyFormDirty\.current = true;\s+setCommentEnabled/u);
assert.match(source, /dailyFormDirty\.current = true;\s+setCommentGuidance/u);
assert.match(source, /disposed = true;\s+unsubscribe\(\)/u);
assert.match(preload, /moments-campaign:configure-daily/u);
assert.match(preload, /moments-campaign:run-daily-now/u);
assert.match(
  preload,
  /\[data-xiaoxi-moments-campaign-start\], \[data-xiaoxi-moments-daily-run\]/u
);

console.log("Moments campaign panel self-check passed");
