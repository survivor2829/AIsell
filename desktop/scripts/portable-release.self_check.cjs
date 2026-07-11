const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const projectDir = path.resolve(desktopDir, "..");
const edition = process.argv[2] === "pilot" ? "pilot" : "customer";
const productName = edition === "pilot" ? "小玺AI员工-受控试用版" : "小玺AI员工-客户版";
const target = path.join(projectDir, "release", productName);
const appDir = path.join(target, "resources", "app");

assert.equal(fs.existsSync(path.join(target, `${productName}.exe`)), true, "portable executable must exist");
assert.equal(fs.existsSync(path.join(projectDir, "release", `${productName}.zip`)), true, "portable ZIP must exist");
assert.equal(fs.existsSync(path.join(appDir, "rpa", "contact_sync", "xiaoxi-contact-helper.exe")), true, "contact helper must be packaged");
const manifest = JSON.parse(fs.readFileSync(path.join(target, "版本清单.json"), "utf8"));
assert.equal(manifest.edition, edition);
assert.equal(manifest.architecture, "x64");
assert.ok(manifest.contactHelperSha256);

const files = [];
function walk(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) walk(file);
    else files.push(file);
  }
}
walk(target);
const names = files.map((file) => path.basename(file).toLowerCase());
for (const blocked of ["python.exe", "wx_key.dll", "dump_data.exe", "wechat-dump-rs.exe", "contacts.json", "touch_task.json", "run_logs.jsonl", "state.json", "deepseek-api-key.bin"]) {
  assert.equal(names.includes(blocked), false, `release must not contain ${blocked}`);
}
assert.equal(names.some((name) => name.endsWith(".py") || name.includes("dt-ai-helper")), false, "release must not contain Python sources or dt-ai-helper");

const mainDir = path.join(appDir, "src", "main");
assert.equal(fs.existsSync(path.join(mainDir, "active-touch-dev-ipc.cjs")), false);
assert.equal(fs.existsSync(path.join(mainDir, "preload.dev.cjs")), false);
assert.equal(fs.readFileSync(path.join(mainDir, "preload.cjs"), "utf8").includes("sendReal"), false);
const activeDir = path.join(appDir, "rpa", "active_touch");
if (edition === "customer") {
  assert.equal(fs.existsSync(path.join(activeDir, "state_machine.dev.cjs")), false);
  assert.equal(fs.existsSync(path.join(activeDir, "wechat_window_driver.dev.cjs")), false);
} else {
  assert.equal(fs.existsSync(path.join(activeDir, "state_machine.dev.cjs")), true);
  assert.equal(fs.existsSync(path.join(activeDir, "wechat_window_driver.dev.cjs")), true);
  assert.equal(fs.existsSync(path.join(activeDir, "active_touch_cli.dev.cjs")), false);
}
const renderer = fs.readdirSync(path.join(appDir, "dist", "assets")).filter((name) => name.endsWith(".js")).map((name) => fs.readFileSync(path.join(appDir, "dist", "assets", name), "utf8")).join("\n");
assert.equal(renderer.includes("开发验收"), false);
assert.equal(renderer.includes("受控试用版"), edition === "pilot");
console.log(`${edition} portable release self-check passed`);
