// The one way to build and publish an internal update, so each release runs the same steps in the same environment.
// Machine paths live in the untracked .build/release-sop.json (see build/release-sop.example.json).
// npm.cmd run release:sop                      switch the release worktree to origin/main, build, publish
// npm.cmd run release:sop -- --build-only      stop after building
// npm.cmd run release:sop -- --publish-only    publish what is already built in the worktree
// npm.cmd run release:sop -- --full            full installer instead of components: each x.y.0 (docs/internal-release.md),
//                                              combinable with --build-only / --publish-only
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CONFIG = path.resolve(__dirname, "..", ".build", "release-sop.json");

// Tools that have broken release builds on this machine when they leak in through PATH.
function releaseEnv(base, python) {
  const env = { ...base };
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") || "PATH";
  env[key] = String(env[key] || "").split(";").filter((entry) => !/temurin|poppler/i.test(entry)).join(";");
  env.XIAOXI_CONTENT_ENGINE_BUILD_PYTHON = python;
  env.XIAOXI_PRODUCT_DETAIL_BUILD_PYTHON = python;
  env.NODE_OPTIONS = "--dns-result-order=ipv4first";
  return env;
}

// Through the shell, a path with spaces (the installer name) must stay one argument.
function shellArgs(args) { return args.map(arg => /[\s"]/u.test(arg) ? `"${arg.replace(/"/gu, '\\"')}"` : arg); }

function fail(message) {
  console.error("[release:sop] " + message);
  process.exit(1);
}

function run(command, args, options) {
  console.log("[release:sop] " + command + " " + args.join(" "));
  const shell = command.endsWith(".cmd");
  const result = spawnSync(command, shell ? shellArgs(args) : args, { stdio: "inherit", shell, ...options });
  if (result.status !== 0) fail(command + " " + args[0] + " " + (args[1] || "") + " 失败，停在这一步。不要换别的流程绕过去，先看上面的报错。");
}

function capture(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) fail("git " + args[0] + " 失败：" + result.stderr);
  return result.stdout.trim();
}

// The test-edition installer and its version manifest, named as build-installer-release.cjs names them.
function fullInstallerFiles(worktree) {
  const brand = JSON.parse(fs.readFileSync(path.join(worktree, "desktop", "product-brand.json"), "utf8"));
  const stem = path.join(worktree, "release", brand.displayName + "-测试版-安装程序");
  const files = [stem + ".exe", stem + "-版本清单.json"];
  for (const file of files) if (!fs.existsSync(file)) fail("找不到完整安装包产物：" + file + "，先用 --full 构建。");
  return files;
}

function main(argv) {
  if (!fs.existsSync(CONFIG)) fail("缺少 " + CONFIG + "，参考 build/release-sop.example.json 创建。");
  const { worktree, python } = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  for (const target of [worktree, python]) if (!target || !fs.existsSync(target)) fail("配置里的路径不存在：" + target);
  const buildOnly = argv.includes("--build-only"), publishOnly = argv.includes("--publish-only"), full = argv.includes("--full");
  if (buildOnly && publishOnly) fail("--build-only 和 --publish-only 只能选一个。");
  const unknown = argv.filter(arg => !["--build-only", "--publish-only", "--full"].includes(arg));
  if (unknown.length) fail("不认识的参数：" + unknown.join(" "));
  if (capture(["status", "--porcelain"], worktree)) fail("发布工作区有未提交内容，不从脏工作区发布：" + worktree);
  const desktop = path.join(worktree, "desktop"), env = releaseEnv(process.env, python);
  if (!publishOnly) {
    run("git", ["fetch", "origin", "main"], { cwd: worktree });
    run("git", ["checkout", "--detach", "origin/main"], { cwd: worktree });
    run("npm.cmd", ["ls", "--depth=0", "--silent"], { cwd: desktop, stdio: ["ignore", "ignore", "inherit"] });
    run("npm.cmd", ["run", "release:internal", ...(full ? ["--", "--full"] : [])], { cwd: desktop, env });
  }
  if (!buildOnly) run("npm.cmd", ["run", "publish:internal", ...(full ? ["--", "--full", ...fullInstallerFiles(worktree)] : [])], { cwd: desktop, env });
  console.log("[release:sop] 完成，提交 " + capture(["rev-parse", "--short", "HEAD"], worktree));
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { releaseEnv, shellArgs, fullInstallerFiles };
