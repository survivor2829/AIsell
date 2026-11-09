const assert = require("node:assert/strict");
const { releaseEnv } = require("./release-sop.cjs");

const env = releaseEnv({ Path: "C:/a;C:/Program Files/Eclipse Adoptium/temurin-21/bin;D:/poppler/bin;C:/b", NODE_OPTIONS: "--x" }, "D:/py.exe");
assert.equal(env.Path, "C:/a;C:/b", "Windows spells it Path; a second PATH key would be ignored");
assert.equal(env.PATH, undefined);
assert.equal(env.XIAOXI_CONTENT_ENGINE_BUILD_PYTHON, "D:/py.exe");
assert.equal(env.XIAOXI_PRODUCT_DETAIL_BUILD_PYTHON, "D:/py.exe");
assert.equal(env.NODE_OPTIONS, "--dns-result-order=ipv4first");
console.log("release sop self-check passed");
