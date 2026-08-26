const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveDevServerPort } = require("./dev-electron.cjs");

const launcher = fs.readFileSync(path.join(__dirname, "dev-electron.cjs"), "utf8");

assert.equal(resolveDevServerPort(""), 5173, "未指定端口时必须使用默认开发端口");
assert.equal(resolveDevServerPort("5177"), 5177, "显式端口必须原样用于 Vite 和 Electron");
for (const invalidPort of ["5173.5", "text", "1023", "65536"]) {
  assert.throws(() => resolveDevServerPort(invalidPort), /XIAOXI_DEV_SERVER_PORT/, `必须拒绝无效端口：${invalidPort}`);
}
assert.match(launcher, /require\.resolve\("vite"\)/u, "开发启动必须直接管理 Vite 进程");
assert.match(launcher, /"--strictPort"/u, "端口被占用时不得连接旧的 Vite 服务");
assert.match(launcher, /VITE_DEV_SERVER_URL: url/u, "Electron 必须使用同一个受控 Vite 地址");
assert.match(launcher, /vite\.stdout\.on\("data"/u, "只能等待本次启动的 Vite 自己报告就绪");
assert.doesNotMatch(launcher, /http\.get\(/u, "不得用端口上的旧服务作为 Electron 启动依据");

console.log("dev-electron self-check passed");
