const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { releaseEnv, shellArgs, fullInstallerFiles } = require("./release-sop.cjs");

assert.deepEqual(shellArgs(["run", "publish:internal", "--", "--full", "D:/w/release/AI短视频获客 V1.0版本-测试版-安装程序.exe"]),
  ["run", "publish:internal", "--", "--full", '"D:/w/release/AI短视频获客 V1.0版本-测试版-安装程序.exe"'], "the installer path stays one argument");

{
  // The names come from the installer build itself, so renaming the installer cannot break --full.
  const worktree = path.resolve(__dirname, "..", "..");
  const { resolveInstallerTarget } = require("./build-installer-release.cjs");
  const target = resolveInstallerTarget("test");
  assert.ok(target.installerName.endsWith(".exe") && target.installerManifestName.endsWith(".json"));
  const expected = [target.installerName, target.installerManifestName].map(name => path.join(worktree, "release", name));
  if (expected.every(file => fs.existsSync(file))) assert.deepEqual(fullInstallerFiles(worktree), expected);
  else assert.throws(() => require("node:child_process").execFileSync(process.execPath, ["-e",
    `require(${JSON.stringify(path.join(__dirname, "release-sop.cjs"))}).fullInstallerFiles(${JSON.stringify(worktree)})`], { stdio: "pipe" }),
    "a missing installer stops the publish step");
}


const env = releaseEnv({ Path: "C:/a;C:/Program Files/Eclipse Adoptium/temurin-21/bin;D:/poppler/bin;C:/b", NODE_OPTIONS: "--x" }, "D:/py.exe");
assert.equal(env.Path, "C:/a;C:/b", "Windows spells it Path; a second PATH key would be ignored");
assert.equal(env.PATH, undefined);
assert.equal(env.XIAOXI_CONTENT_ENGINE_BUILD_PYTHON, "D:/py.exe");
assert.equal(env.XIAOXI_PRODUCT_DETAIL_BUILD_PYTHON, "D:/py.exe");
assert.equal(env.NODE_OPTIONS, "--dns-result-order=ipv4first");
console.log("release sop self-check passed");
