const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { releaseEnv, shellArgs, fullInstallerFiles } = require("./release-sop.cjs");

assert.deepEqual(shellArgs(["run", "publish:internal", "--", "--full", "D:/w/release/AI短视频获客 V1.0版本-测试版-安装程序.exe"]),
  ["run", "publish:internal", "--", "--full", '"D:/w/release/AI短视频获客 V1.0版本-测试版-安装程序.exe"'], "the installer path stays one argument");

{
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "release-sop-"));
  try {
    fs.mkdirSync(path.join(worktree, "desktop")); fs.mkdirSync(path.join(worktree, "release"));
    fs.writeFileSync(path.join(worktree, "desktop", "product-brand.json"), JSON.stringify({ displayName: "AI短视频获客 V1.0版本" }));
    const expected = ["AI短视频获客 V1.0版本-测试版-安装程序.exe", "AI短视频获客 V1.0版本-测试版-安装程序-版本清单.json"].map(name => path.join(worktree, "release", name));
    for (const file of expected) fs.writeFileSync(file, "x");
    assert.deepEqual(fullInstallerFiles(worktree), expected, "the full installer and manifest are named as the installer build names them");
  } finally { fs.rmSync(worktree, { recursive: true, force: true }); }
}


const env = releaseEnv({ Path: "C:/a;C:/Program Files/Eclipse Adoptium/temurin-21/bin;D:/poppler/bin;C:/b", NODE_OPTIONS: "--x" }, "D:/py.exe");
assert.equal(env.Path, "C:/a;C:/b", "Windows spells it Path; a second PATH key would be ignored");
assert.equal(env.PATH, undefined);
assert.equal(env.XIAOXI_CONTENT_ENGINE_BUILD_PYTHON, "D:/py.exe");
assert.equal(env.XIAOXI_PRODUCT_DETAIL_BUILD_PYTHON, "D:/py.exe");
assert.equal(env.NODE_OPTIONS, "--dns-result-order=ipv4first");
console.log("release sop self-check passed");
