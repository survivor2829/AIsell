const assert = require("node:assert/strict");
const { DRIVERS } = require("./social-publish-drivers.cjs");

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
console.log("social publish drivers self-check passed");
